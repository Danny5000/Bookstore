import { createHash } from 'node:crypto';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileTypeFromBuffer } from 'file-type';
import sharp, { type OutputInfo } from 'sharp';
import type { StorageKey } from '../storage/keys';
import type { ObjectStorage } from '../storage/types';
import { IngestionError, type IngestionWarning } from './errors';
import type { IngestionLimits } from './limits';
import {
  SEMANTIC_FINGERPRINT_VERSION,
  fingerprintDecodedImage
} from '../reader-state/fingerprint';

const signaturePrefixBytes = 4_100;
const epubFormats = new Set(['jpeg', 'png', 'webp', 'gif']);
const comicFormats = new Set([...epubFormats, 'tiff']);
const coverFormats = new Set(['jpeg', 'png']);

export interface NormalizeImageInput {
  storage: ObjectStorage;
  source: Readable;
  destination: StorageKey;
  profile: 'epub' | 'comic' | 'cover';
  limits: IngestionLimits;
  signal: AbortSignal;
}

export interface NormalizedImage {
  storageKey: StorageKey;
  mediaType: 'image/webp';
  checksumSha256: string;
  semanticFingerprintSha256: string;
  semanticFingerprintVersion: typeof SEMANTIC_FINGERPRINT_VERSION;
  byteSize: number;
  width: number;
  height: number;
  warnings: readonly IngestionWarning[];
}

async function prefixReplay(
  source: Readable,
  signal: AbortSignal
): Promise<{ prefix: Buffer; replay: Readable }> {
  const iterator = source[Symbol.asyncIterator]();
  const prefixChunks: Buffer[] = [];
  let prefixSize = 0;
  let remainder: Buffer | undefined;
  let sourceEnded = false;

  while (prefixSize < signaturePrefixBytes) {
    if (signal.aborted) {
      source.destroy();
      throw new IngestionError('ingestion_aborted', 'Ingestion was aborted', false);
    }
    const next = await iterator.next();
    if (next.done) {
      sourceEnded = true;
      break;
    }
    const bytes = Buffer.from(next.value);
    const needed = signaturePrefixBytes - prefixSize;
    if (bytes.byteLength <= needed) {
      prefixChunks.push(bytes);
      prefixSize += bytes.byteLength;
    } else {
      prefixChunks.push(bytes.subarray(0, needed));
      remainder = bytes.subarray(needed);
      prefixSize += needed;
    }
  }

  const prefix = Buffer.concat(prefixChunks);
  const replay = Readable.from(
    (async function* () {
      if (prefix.byteLength > 0) yield prefix;
      if (remainder && remainder.byteLength > 0) yield remainder;
      if (sourceEnded) return;
      while (true) {
        if (signal.aborted) {
          throw new IngestionError('ingestion_aborted', 'Ingestion was aborted', false);
        }
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    })()
  );
  return { prefix, replay };
}

function unsupportedMedia(): IngestionError {
  return new IngestionError('unsupported_media', 'Image media type is unsupported', false);
}

function normalizedHintExtension(extension: string): string {
  if (extension === 'jpg') return 'jpeg';
  if (extension === 'tif') return 'tiff';
  return extension;
}

function mapImageError(cause: unknown): IngestionError {
  if (cause instanceof IngestionError) return cause;
  const message = cause instanceof Error ? cause.message : '';
  if (/pixel limit|exceeds.*pixel|image exceeds/u.test(message.toLowerCase())) {
    return new IngestionError('image_pixels', 'Image exceeds the decoded pixel limit', false, {
      cause
    });
  }
  return new IngestionError('image_decode', 'Image could not be decoded safely', false, { cause });
}

export async function normalizeImage(input: NormalizeImageInput): Promise<NormalizedImage> {
  if (input.signal.aborted) {
    input.source.destroy();
    throw new IngestionError('ingestion_aborted', 'Ingestion was aborted', false);
  }
  const { prefix, replay } = await prefixReplay(input.source, input.signal);
  const hint = await fileTypeFromBuffer(prefix);
  const allowedFormats =
    input.profile === 'epub' ? epubFormats : input.profile === 'comic' ? comicFormats : coverFormats;
  if (
    /^\s*(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+svg[^>]*>\s*)?<svg\b/iu.test(
      prefix.toString('utf8')
    ) ||
    (hint && !allowedFormats.has(normalizedHintExtension(hint.ext)))
  ) {
    replay.destroy();
    throw unsupportedMedia();
  }

  const decoder = sharp({
    failOn: 'error',
    limitInputPixels: input.limits.maxImagePixels,
    animated: false
  });
  const metadataPromise = decoder.metadata();
  const output = decoder.clone().rotate().webp({ quality: 90, effort: 4 });
  const rawOutput = decoder.clone().rotate().toColourspace('srgb').ensureAlpha().raw();
  const outputInfo = new Promise<OutputInfo>((resolve, reject) => {
    output.once('info', resolve);
    output.on('error', reject);
    output.once('close', () => reject(new Error('Image output closed before completion')));
  });
  const hash = createHash('sha256');
  const rawHash = createHash('sha256');
  let outputByteSize = 0;
  const hasher = new Transform({
    transform(chunk: unknown, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      outputByteSize += bytes.byteLength;
      hash.update(bytes);
      callback(null, bytes);
    }
  });
  const rawHasher = new Writable({
    write(chunk: unknown, _encoding, callback) {
      rawHash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      callback();
    }
  });
  const rawOutputInfo = new Promise<OutputInfo>((resolve, reject) => {
    rawOutput.once('info', resolve);
    rawOutput.on('error', reject);
    rawOutput.once('close', () => reject(new Error('Raw image output closed before completion')));
  });
  // `pipeline()` observes the primary error through storage.write, but removes
  // its listeners after settling. Keep a terminal listener for a secondary,
  // late Sharp error forwarded while the stream graph is being destroyed.
  hasher.on('error', () => undefined);
  let sourceFailure: unknown;
  replay.once('error', (cause: unknown) => {
    sourceFailure = cause;
    decoder.destroy(cause as Error);
  });
  decoder.on('error', () => undefined);
  output.on('error', (cause: unknown) => hasher.destroy(cause as Error));
  rawOutput.on('error', (cause: unknown) => rawHasher.destroy(cause as Error));
  replay.pipe(decoder);
  output.pipe(hasher);
  const rawWritePromise = pipeline(rawOutput, rawHasher);
  const abort = () => {
    const cause = new IngestionError('ingestion_aborted', 'Ingestion was aborted', false);
    replay.destroy(cause);
    decoder.destroy(cause);
    output.destroy(cause);
    rawOutput.destroy(cause);
    hasher.destroy(cause);
    rawHasher.destroy(cause);
  };
  input.signal.addEventListener('abort', abort, { once: true });
  const writePromise = input.storage.write(input.destination, hasher, {
    maxBytes: input.limits.maxExpandedBytes
  });

  try {
    const [metadata, stored, info, rawInfo] = await Promise.all([
      metadataPromise,
      writePromise,
      outputInfo,
      rawOutputInfo,
      rawWritePromise
    ]);
    const decodedFormat = metadata.format;
    if (!decodedFormat || !allowedFormats.has(decodedFormat)) {
      await input.storage.delete(input.destination);
      throw unsupportedMedia();
    }
    if (!info.width || !info.height || info.width * info.height > input.limits.maxImagePixels) {
      await input.storage.delete(input.destination);
      throw new IngestionError('image_pixels', 'Image exceeds the decoded pixel limit', false);
    }
    if (
      !rawInfo.width ||
      !rawInfo.height ||
      rawInfo.width !== info.width ||
      rawInfo.height !== info.height
    ) {
      await input.storage.delete(input.destination);
      throw new IngestionError('image_decode', 'Image dimensions were inconsistent', false);
    }
    const warnings: IngestionWarning[] = [];
    if ((metadata.pages ?? 1) > 1) {
      warnings.push({
        code: 'image_animation_first_frame',
        safeMessage: 'Only the first image frame was used'
      });
    }
    return {
      storageKey: input.destination,
      mediaType: 'image/webp',
      checksumSha256: hash.digest('hex'),
      semanticFingerprintSha256: fingerprintDecodedImage({
        width: rawInfo.width,
        height: rawInfo.height,
        pixelDigestSha256: rawHash.digest('hex')
      }),
      semanticFingerprintVersion: SEMANTIC_FINGERPRINT_VERSION,
      byteSize: stored.byteSize || outputByteSize,
      width: info.width,
      height: info.height,
      warnings: Object.freeze(warnings)
    };
  } catch (cause: unknown) {
    replay.destroy();
    decoder.destroy();
    output.destroy();
    rawOutput.destroy();
    hasher.destroy();
    rawHasher.destroy();
    await Promise.allSettled([
      metadataPromise,
      writePromise,
      outputInfo,
      rawOutputInfo,
      rawWritePromise
    ]);
    if (sourceFailure instanceof IngestionError) throw sourceFailure;
    throw mapImageError(cause);
  } finally {
    input.signal.removeEventListener('abort', abort);
  }
}
