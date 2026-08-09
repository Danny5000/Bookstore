import { PassThrough, Transform, type Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import {
  Entry,
  RandomAccessReader,
  fromRandomAccessReaderPromise,
  type ZipFile
} from 'yauzl';
import type { StorageKey } from '../storage/keys';
import type { ObjectStorage } from '../storage/types';
import { IngestionError } from './errors';
import type { IngestionLimits } from './limits';

export interface ArchiveEntry {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly compressionMethod: 0 | 8;
  readonly generalPurposeBitFlag: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
}

export interface ArchiveSession {
  readonly entries: readonly ArchiveEntry[];
  read(entry: ArchiveEntry): Promise<Readable>;
  close(): Promise<void>;
}

function archiveError(
  code: ConstructorParameters<typeof IngestionError>[0],
  safeMessage: string,
  cause?: unknown
): IngestionError {
  return new IngestionError(code, safeMessage, false, cause === undefined ? undefined : { cause });
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function normalizeArchivePath(rawPath: string): { path: string; isDirectory: boolean } {
  const isDirectory = rawPath.endsWith('/');
  const withoutDirectorySlash = isDirectory ? rawPath.slice(0, -1) : rawPath;
  if (
    withoutDirectorySlash.length === 0 ||
    withoutDirectorySlash.startsWith('/') ||
    withoutDirectorySlash.includes('\\') ||
    containsControlCharacter(withoutDirectorySlash) ||
    /^[a-zA-Z]:/u.test(withoutDirectorySlash)
  ) {
    throw archiveError('archive_unsafe_path', 'Archive contains an unsafe path');
  }

  const normalized = withoutDirectorySlash.normalize('NFC');
  const segments = normalized.split('/');
  if (
    [...normalized].length > 1_024 ||
    segments.length > 32 ||
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || [...segment].length > 255
    )
  ) {
    throw archiveError('archive_unsafe_path', 'Archive contains an unsafe path');
  }
  return { path: normalized, isDirectory };
}

function mapArchiveStructureError(cause: unknown): IngestionError {
  if (cause instanceof IngestionError) return cause;
  const message = cause instanceof Error ? cause.message : '';
  if (/invalid characters in fileName|invalid relative path|absolute path|backslash/u.test(message)) {
    return archiveError('archive_unsafe_path', 'Archive contains an unsafe path', cause);
  }
  if (
    /compressed size != uncompressed size|compressed\/uncompressed size mismatch|unexpected size|byte count/u.test(
      message
    )
  ) {
    return archiveError('archive_size_mismatch', 'Archive entry size is inconsistent', cause);
  }
  return archiveError('archive_structure', 'Archive structure is invalid', cause);
}

class StorageRandomAccessReader extends RandomAccessReader {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly key: StorageKey,
    private readonly signal: AbortSignal
  ) {
    super();
  }

  override _readStreamForRange(start: number, endExclusive: number): Readable {
    const output = new PassThrough();
    if (this.signal.aborted) {
      output.destroy(
        new IngestionError('ingestion_aborted', 'Ingestion was aborted', false)
      );
      return output;
    }
    void this.storage
      .readRange(this.key, start, endExclusive - 1)
      .then((source) => {
        if (this.signal.aborted) {
          source.destroy();
          output.destroy(
            new IngestionError('ingestion_aborted', 'Ingestion was aborted', false)
          );
          return;
        }
        source.once('error', (cause: unknown) => output.destroy(cause as Error));
        source.pipe(output);
      })
      .catch((cause: unknown) => output.destroy(cause as Error));
    return output;
  }
}

class YauzlArchiveSession implements ArchiveSession {
  readonly entries: readonly ArchiveEntry[];
  readonly #rawEntries: ReadonlyMap<string, Entry>;
  readonly #activeStreams = new Set<Readable>();
  #closed = false;
  #aborted = false;

  constructor(
    private readonly zipFile: ZipFile,
    entries: ArchiveEntry[],
    rawEntries: Map<string, Entry>,
    private readonly limits: IngestionLimits,
    private readonly signal: AbortSignal
  ) {
    this.entries = Object.freeze(entries.map((entry) => Object.freeze(entry)));
    this.#rawEntries = rawEntries;
    this.signal.addEventListener('abort', this.#handleAbort, { once: true });
  }

  #handleAbort = (): void => {
    this.#aborted = true;
    void this.close();
  };

  async read(entry: ArchiveEntry): Promise<Readable> {
    if (this.#aborted || this.signal.aborted) {
      throw new IngestionError('ingestion_aborted', 'Ingestion was aborted', false);
    }
    if (this.#closed) throw archiveError('archive_closed', 'Archive session is closed');
    if (entry.isDirectory) throw archiveError('archive_structure', 'Archive entry is a directory');
    const rawEntry = this.#rawEntries.get(entry.path);
    if (!rawEntry) throw archiveError('archive_structure', 'Archive entry is unknown');

    let source: Readable;
    try {
      source = await this.zipFile.openReadStreamPromise(rawEntry);
    } catch (cause: unknown) {
      throw mapArchiveStructureError(cause);
    }

    let observedSize = 0;
    let observedCrc = 0;
    const observer = new Transform({
      transform: (chunk: unknown, _encoding, callback) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        observedSize += bytes.byteLength;
        if (
          observedSize > entry.uncompressedSize ||
          observedSize > this.limits.maxExpandedBytes
        ) {
          callback(archiveError('archive_size_mismatch', 'Archive entry size is inconsistent'));
          return;
        }
        observedCrc = crc32(bytes, observedCrc);
        callback(null, bytes);
      },
      flush: (callback) => {
        if (observedSize !== entry.uncompressedSize) {
          callback(archiveError('archive_size_mismatch', 'Archive entry size is inconsistent'));
        } else if ((observedCrc >>> 0) !== (entry.crc32 >>> 0)) {
          callback(archiveError('archive_crc_mismatch', 'Archive entry checksum is invalid'));
        } else callback();
      }
    });
    source.once('error', (cause: unknown) => observer.destroy(mapArchiveStructureError(cause)));
    source.pipe(observer);
    this.#activeStreams.add(observer);
    const release = () => this.#activeStreams.delete(observer);
    observer.once('close', release);
    observer.once('end', release);
    return observer;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.signal.removeEventListener('abort', this.#handleAbort);
    const cause = this.#aborted
      ? new IngestionError('ingestion_aborted', 'Ingestion was aborted', false)
      : archiveError('archive_closed', 'Archive session is closed');
    for (const stream of this.#activeStreams) stream.destroy(cause);
    this.#activeStreams.clear();
    if (this.zipFile.isOpen) this.zipFile.close();
  }
}

function validateEntry(
  rawEntry: Entry,
  limits: IngestionLimits,
  seenPaths: Set<string>,
  runningExpandedBytes: number
): { entry: ArchiveEntry; expandedBytes: number } {
  const normalized = normalizeArchivePath(rawEntry.fileName);
  const collisionKey = normalized.path.toLocaleLowerCase('en-US');
  if (seenPaths.has(collisionKey)) {
    throw archiveError('archive_path_collision', 'Archive paths are ambiguous');
  }
  seenPaths.add(collisionKey);

  const platform = rawEntry.versionMadeBy >>> 8;
  const unixMode = (rawEntry.externalFileAttributes >>> 16) & 0xffff;
  if (platform === 3 && (unixMode & 0o170000) === 0o120000) {
    throw archiveError('archive_symlink', 'Archive contains a symbolic link');
  }
  if ((rawEntry.generalPurposeBitFlag & 1) !== 0 || rawEntry.isEncrypted()) {
    throw archiveError('archive_encrypted', 'Encrypted archive entries are unsupported');
  }
  if (rawEntry.compressionMethod !== 0 && rawEntry.compressionMethod !== 8) {
    throw archiveError(
      'archive_unsupported_compression',
      'Archive compression method is unsupported'
    );
  }
  if (rawEntry.compressionMethod === 0 && rawEntry.compressedSize !== rawEntry.uncompressedSize) {
    throw archiveError('archive_size_mismatch', 'Archive entry size is inconsistent');
  }
  if (rawEntry.uncompressedSize > limits.maxExpandedBytes) {
    throw archiveError('archive_entry_size', 'Archive entry exceeds the expanded-size limit');
  }
  const expandedBytes = runningExpandedBytes + rawEntry.uncompressedSize;
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maxExpandedBytes) {
    throw archiveError('archive_expanded_size', 'Archive exceeds the expanded-size limit');
  }
  if (
    rawEntry.uncompressedSize > 0 &&
    (rawEntry.compressedSize === 0 ||
      rawEntry.uncompressedSize / rawEntry.compressedSize > limits.maxCompressionRatio)
  ) {
    throw archiveError('archive_compression_ratio', 'Archive compression ratio is excessive');
  }

  return {
    entry: {
      path: normalized.path,
      isDirectory: normalized.isDirectory,
      compressedSize: rawEntry.compressedSize,
      uncompressedSize: rawEntry.uncompressedSize,
      compressionMethod: rawEntry.compressionMethod,
      generalPurposeBitFlag: rawEntry.generalPurposeBitFlag,
      crc32: rawEntry.crc32,
      localHeaderOffset: rawEntry.relativeOffsetOfLocalHeader
    },
    expandedBytes
  };
}

export async function openArchive(
  storage: ObjectStorage,
  key: StorageKey,
  limits: IngestionLimits,
  signal: AbortSignal
): Promise<ArchiveSession> {
  if (signal.aborted) {
    throw new IngestionError('ingestion_aborted', 'Ingestion was aborted', false);
  }
  const object = await storage.stat(key);
  if (!object) {
    throw new IngestionError('missing_staged_source', 'Uploaded source is unavailable', false);
  }
  if (object.byteSize > limits.maxUploadBytes) {
    throw new IngestionError('upload_limit', 'Uploaded source exceeds the size limit', false);
  }

  const reader = new StorageRandomAccessReader(storage, key, signal);
  let zipFile: ZipFile | undefined;
  try {
    zipFile = await fromRandomAccessReaderPromise(reader, object.byteSize, {
      autoClose: false,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true
    });
    const entries: ArchiveEntry[] = [];
    const rawEntries = new Map<string, Entry>();
    const seenPaths = new Set<string>();
    let expandedBytes = 0;
    for await (const rawEntry of zipFile.eachEntry()) {
      if (signal.aborted) {
        throw new IngestionError('ingestion_aborted', 'Ingestion was aborted', false);
      }
      if (entries.length >= limits.maxEntries) {
        throw archiveError('archive_entry_count', 'Archive contains too many entries');
      }
      const validated = validateEntry(rawEntry, limits, seenPaths, expandedBytes);
      expandedBytes = validated.expandedBytes;
      entries.push(validated.entry);
      rawEntries.set(validated.entry.path, rawEntry);
    }
    return new YauzlArchiveSession(zipFile, entries, rawEntries, limits, signal);
  } catch (cause: unknown) {
    if (zipFile?.isOpen) zipFile.close();
    throw mapArchiveStructureError(cause);
  }
}
