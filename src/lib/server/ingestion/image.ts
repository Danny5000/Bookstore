import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import sharp, { type OutputInfo } from 'sharp';
import type { StorageKey } from '../storage/keys';
import type { ObjectStorage } from '../storage/types';
import { IngestionError, type IngestionWarning } from './errors';
import type { IngestionLimits } from './limits';

const signaturePrefixBytes = 4_100;
const epubFormats = new Set(['jpeg', 'png', 'webp', 'gif']);
const comicFormats = new Set([...epubFormats, 'tiff']);

export interface NormalizeImageInput {
  storage: ObjectStorage;
  source: Readable;
  destination: StorageKey;
  profile: 'epub' | 'comic';
  limits: IngestionLimits;
  signal: AbortSignal;
}

export interface NormalizedImage {
  storageKey: StorageKey;
  mediaType: 'image/webp';
  checksumSha256: string;
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
  const allowedFormats = input.profile === 'epub' ? epubFormats : comicFormats;
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
  const outputInfo = new Promise<OutputInfo>((resolve, reject) => {
    output.once('info', resolve);
    output.on('error', reject);
  });
  const hash = createHash('sha256');
  let outputByteSize = 0;
  const hasher = new Transform({
    transform(chunk: unknown, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      outputByteSize += bytes.byteLength;
      hash.update(bytes);
      callback(null, bytes);
    }
  });
  let sourceFailure: unknown;
  replay.once('error', (cause: unknown) => {
    sourceFailure = cause;
    decoder.destroy(cause as Error);
  });
  decoder.on('error', () => undefined);
  output.on('error', (cause: unknown) => hasher.destroy(cause as Error));
  replay.pipe(decoder);
  output.pipe(hasher);
  const abort = () => {
    const cause = new IngestionError('ingestion_aborted', 'Ingestion was aborted', false);
    replay.destroy(cause);
    decoder.destroy(cause);
    output.destroy(cause);
    hasher.destroy(cause);
  };
  input.signal.addEventListener('abort', abort, { once: true });

  try {
    const [metadata, stored, info] = await Promise.all([
      metadataPromise,
      input.storage.write(input.destination, hasher, {
        maxBytes: input.limits.maxExpandedBytes
      }),
      outputInfo
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
      byteSize: stored.byteSize || outputByteSize,
      width: info.width,
      height: info.height,
      warnings: Object.freeze(warnings)
    };
  } catch (cause: unknown) {
    replay.destroy();
    decoder.destroy();
    output.destroy();
    hasher.destroy();
    if (sourceFailure instanceof IngestionError) throw sourceFailure;
    throw mapImageError(cause);
  } finally {
    input.signal.removeEventListener('abort', abort);
  }
}
