import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageLimitError } from '../storage/local';
import type { StorageKey } from '../storage/keys';
import type { ObjectStorage } from '../storage/types';
import { UploadError } from './multipart';

export interface StoredObjectDigest {
  byteSize: number;
  checksumSha256: string;
}

function mappedUploadError(cause: unknown, signal: AbortSignal): UploadError {
  if (cause instanceof UploadError) return cause;
  if (signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
    return new UploadError('upload_aborted', 'Upload was aborted');
  }
  if (cause instanceof StorageLimitError) {
    return new UploadError('file_size_limit', 'Uploaded file exceeds the size limit');
  }
  return new UploadError('storage_failure', 'Uploaded file could not be stored');
}

function byteBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

export async function streamObjectWithSha256(
  storage: ObjectStorage,
  key: StorageKey,
  source: Readable,
  maxBytes: number,
  signal: AbortSignal
): Promise<StoredObjectDigest> {
  const digest = createHash('sha256');
  let byteSize = 0;
  const counter = new Transform({
    transform(chunk: unknown, _encoding, callback) {
      const bytes = byteBuffer(chunk);
      byteSize += bytes.byteLength;
      if (byteSize > maxBytes) {
        callback(new StorageLimitError());
        return;
      }
      digest.update(bytes);
      callback(null, bytes);
    }
  });
  const abort = (): void => {
    const cause = new UploadError('upload_aborted', 'Upload was aborted');
    source.destroy(cause);
    counter.destroy(cause);
  };
  signal.addEventListener('abort', abort, { once: true });

  const sourcePipeline = pipeline(source, counter);
  const storageWrite = storage.write(key, counter, { maxBytes });
  if (signal.aborted) abort();

  try {
    await Promise.all([sourcePipeline, storageWrite]);
    return { byteSize, checksumSha256: digest.digest('hex') };
  } catch (cause: unknown) {
    source.destroy();
    counter.destroy();
    await Promise.allSettled([sourcePipeline, storageWrite]);
    await storage.delete(key).catch(() => undefined);
    throw mappedUploadError(cause, signal);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function hashStoredObject(
  storage: ObjectStorage,
  key: StorageKey,
  maxBytes: number,
  signal: AbortSignal
): Promise<StoredObjectDigest> {
  const source = await storage.read(key);
  const digest = createHash('sha256');
  let byteSize = 0;
  const abort = (): void => {
    source.destroy(new UploadError('upload_aborted', 'Upload was aborted'));
  };
  signal.addEventListener('abort', abort, { once: true });

  try {
    if (signal.aborted) throw new UploadError('upload_aborted', 'Upload was aborted');
    for await (const chunk of source) {
      const bytes = byteBuffer(chunk);
      byteSize += bytes.byteLength;
      if (byteSize > maxBytes) {
        throw new UploadError('file_size_limit', 'Stored object exceeds the size limit');
      }
      digest.update(bytes);
    }
    return { byteSize, checksumSha256: digest.digest('hex') };
  } catch (cause: unknown) {
    source.destroy();
    throw mappedUploadError(cause, signal);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
