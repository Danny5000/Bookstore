import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  constants,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync
} from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseStorageKey, type StorageKey } from './keys';
import type {
  ObjectStorage,
  PreparedVerifiedRead,
  StorageListPage,
  StoredObjectStat
} from './types';

const maximumListPageSize = 1_000;
const defaultScratchRoot = mkdtempSync(
  join(resolve(tmpdir()), `pale-orbit-local-storage-scratch-${process.pid}-`)
);
process.once('exit', () => {
  rmSync(defaultScratchRoot, { recursive: true, force: true });
});

export class StorageLimitError extends Error {
  constructor() {
    super('Storage write exceeded the configured byte limit');
    this.name = 'StorageLimitError';
  }
}

export class StorageIntegrityError extends Error {
  constructor() {
    super('Storage write did not match the expected byte count');
    this.name = 'StorageIntegrityError';
  }
}

export class StorageRangeError extends Error {
  constructor() {
    super('Invalid storage range or cursor');
    this.name = 'StorageRangeError';
  }
}

export class StorageSymlinkError extends Error {
  constructor() {
    super('Symbolic links are not allowed in local object storage');
    this.name = 'StorageSymlinkError';
  }
}

function isMissingFileError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

function storedObjectStat(value: { size: number; mtime: Date }): StoredObjectStat {
  return { byteSize: value.size, modifiedAt: value.mtime };
}

class LocalObjectStorage implements ObjectStorage {
  readonly #root: string;
  readonly #rootPrefix: string;
  readonly #scratchRoot: string;

  constructor(configuredRoot: string, configuredScratchRoot: string) {
    this.#root = resolve(configuredRoot);
    this.#scratchRoot = resolve(configuredScratchRoot);
    if (
      this.#scratchRoot === this.#root ||
      this.#scratchRoot.startsWith(`${this.#root}${sep}`) ||
      this.#root.startsWith(`${this.#scratchRoot}${sep}`)
    ) {
      throw new StorageSymlinkError();
    }
    mkdirSync(this.#root, { recursive: true });
    mkdirSync(this.#scratchRoot, { recursive: true });
    if (lstatSync(this.#root).isSymbolicLink()) throw new StorageSymlinkError();
    if (lstatSync(this.#scratchRoot).isSymbolicLink()) throw new StorageSymlinkError();
    this.#rootPrefix = `${this.#root}${sep}`;
  }

  #targetFor(key: StorageKey): string {
    const validated = parseStorageKey(key);
    const target = resolve(this.#root, ...validated.split('/'));
    if (target === this.#root || !target.startsWith(this.#rootPrefix)) {
      throw new StorageSymlinkError();
    }
    return target;
  }

  async #assertNoSymlinks(target: string): Promise<void> {
    const pathFromRoot = relative(this.#root, target);
    const segments = pathFromRoot ? pathFromRoot.split(sep) : [];
    let current = this.#root;

    for (const segment of segments) {
      current = join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new StorageSymlinkError();
      } catch (cause: unknown) {
        if (isMissingFileError(cause)) return;
        throw cause;
      }
    }
  }

  async #prepareDestination(target: string): Promise<void> {
    const parent = dirname(target);
    await this.#assertNoSymlinks(parent);
    await mkdir(parent, { recursive: true });
    await this.#assertNoSymlinks(target);
  }

  async #regularFileStat(target: string): Promise<StoredObjectStat | null> {
    await this.#assertNoSymlinks(target);
    try {
      const value = await lstat(target);
      if (value.isSymbolicLink()) throw new StorageSymlinkError();
      if (!value.isFile()) return null;
      return storedObjectStat(value);
    } catch (cause: unknown) {
      if (isMissingFileError(cause)) return null;
      throw cause;
    }
  }

  async write(
    key: StorageKey,
    body: Readable,
    options: { maxBytes: number; expectedBytes?: number }
  ): Promise<StoredObjectStat> {
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 0 ||
      (options.expectedBytes !== undefined && (
        !Number.isSafeInteger(options.expectedBytes) ||
        options.expectedBytes < 0 ||
        options.expectedBytes > options.maxBytes
      ))
    ) {
      throw new StorageLimitError();
    }

    const target = this.#targetFor(key);
    await this.#prepareDestination(target);
    const partial = join(dirname(target), `.${basename(target)}.partial-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(partial, 'wx');
      let byteSize = 0;
      const limiter = new Transform({
        transform(chunk: unknown, _encoding, callback) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          byteSize += bytes.byteLength;
          if (byteSize > options.maxBytes) callback(new StorageLimitError());
          else callback(null, bytes);
        }
      });
      const output = handle.createWriteStream({ autoClose: false });
      await pipeline(body, limiter, output);
      if (options.expectedBytes !== undefined && byteSize !== options.expectedBytes) {
        throw new StorageIntegrityError();
      }
      await handle.sync();
      const outputClosed = once(output, 'close');
      output.destroy();
      await outputClosed;
      await handle.close();
      handle = undefined;
      await this.#assertNoSymlinks(target);
      await rename(partial, target);
      const result = await this.#regularFileStat(target);
      if (!result) throw new Error('Storage write did not create a regular file');
      return result;
    } catch (cause: unknown) {
      await handle?.close().catch(() => undefined);
      await unlink(partial).catch((cleanupCause: unknown) => {
        if (!isMissingFileError(cleanupCause)) throw cleanupCause;
      });
      throw cause;
    }
  }

  async read(key: StorageKey): Promise<Readable> {
    const target = this.#targetFor(key);
    if (!(await this.#regularFileStat(target))) {
      const error = new Error('Storage object not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return createReadStream(target);
  }

  async readRange(key: StorageKey, start: number, endInclusive: number): Promise<Readable> {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(endInclusive) ||
      start < 0 ||
      endInclusive < start
    ) {
      throw new StorageRangeError();
    }

    const target = this.#targetFor(key);
    const object = await this.#regularFileStat(target);
    if (!object) {
      const error = new Error('Storage object not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    if (start >= object.byteSize || endInclusive >= object.byteSize) {
      throw new StorageRangeError();
    }
    return createReadStream(target, { start, end: endInclusive });
  }

  async prepareVerifiedRead(
    key: StorageKey,
    expected: { byteSize: number; checksumSha256: string }
  ): Promise<PreparedVerifiedRead | null> {
    const target = this.#targetFor(key);
    const object = await this.#regularFileStat(target);
    if (!object || object.byteSize !== expected.byteSize) return null;

    if (lstatSync(this.#scratchRoot).isSymbolicLink()) throw new StorageSymlinkError();
    const snapshot = join(this.#scratchRoot, randomUUID());
    const digest = createHash('sha256');
    let byteSize = 0;
    const verifier = new Transform({
      transform(chunk: unknown, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        byteSize += bytes.byteLength;
        digest.update(bytes);
        callback(null, bytes);
      }
    });

    try {
      await pipeline(
        createReadStream(target),
        verifier,
        createWriteStream(snapshot, { flags: 'wx', mode: 0o600 })
      );
      if (byteSize !== expected.byteSize || digest.digest('hex') !== expected.checksumSha256) {
        await unlink(snapshot);
        return null;
      }
      let closed = false;
      return {
        stat: object,
        read: async (range) => {
          if (!range) return createReadStream(snapshot);
          if (
            !Number.isSafeInteger(range.start) ||
            !Number.isSafeInteger(range.endInclusive) ||
            range.start < 0 ||
            range.endInclusive < range.start ||
            range.endInclusive >= object.byteSize
          ) throw new StorageRangeError();
          return createReadStream(snapshot, { start: range.start, end: range.endInclusive });
        },
        close: async () => {
          if (closed) return;
          closed = true;
          await unlink(snapshot).catch((cause: unknown) => {
            if (!isMissingFileError(cause)) throw cause;
          });
        }
      };
    } catch (cause: unknown) {
      await unlink(snapshot).catch((cleanupCause: unknown) => {
        if (!isMissingFileError(cleanupCause)) throw cleanupCause;
      });
      throw cause;
    }
  }

  async stat(key: StorageKey): Promise<StoredObjectStat | null> {
    return this.#regularFileStat(this.#targetFor(key));
  }

  async copy(source: StorageKey, destination: StorageKey): Promise<StoredObjectStat> {
    const sourceTarget = this.#targetFor(source);
    const destinationTarget = this.#targetFor(destination);
    if (!(await this.#regularFileStat(sourceTarget))) {
      const error = new Error('Storage object not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    await this.#prepareDestination(destinationTarget);
    const partial = join(
      dirname(destinationTarget),
      `.${basename(destinationTarget)}.partial-${randomUUID()}`
    );

    try {
      await copyFile(sourceTarget, partial, constants.COPYFILE_EXCL);
      const handle = await open(partial, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#assertNoSymlinks(destinationTarget);
      await rename(partial, destinationTarget);
      const result = await this.#regularFileStat(destinationTarget);
      if (!result) throw new Error('Storage copy did not create a regular file');
      return result;
    } catch (cause: unknown) {
      await unlink(partial).catch((cleanupCause: unknown) => {
        if (!isMissingFileError(cleanupCause)) throw cleanupCause;
      });
      throw cause;
    }
  }

  async delete(key: StorageKey): Promise<void> {
    const target = this.#targetFor(key);
    await this.#assertNoSymlinks(target);
    try {
      const value = await lstat(target);
      if (value.isSymbolicLink()) throw new StorageSymlinkError();
      if (!value.isFile()) return;
      await unlink(target);
    } catch (cause: unknown) {
      if (!isMissingFileError(cause)) throw cause;
    }
  }

  async listPrefix(
    prefix: StorageKey,
    options: { limit: number; cursor?: string }
  ): Promise<StorageListPage> {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > maximumListPageSize
    ) {
      throw new RangeError(`Storage list limit must be between 1 and ${maximumListPageSize}`);
    }

    const validatedPrefix = parseStorageKey(prefix);
    const cursorKey = options.cursor
      ? this.#decodeCursor(options.cursor, validatedPrefix)
      : undefined;
    const target = this.#targetFor(validatedPrefix);
    await this.#assertNoSymlinks(target);
    const objects: { key: StorageKey; byteSize: number; modifiedAt: Date }[] = [];

    const collectFile = async (file: string): Promise<void> => {
      const storagePath = relative(this.#root, file).split(sep).join('/');
      const key = parseStorageKey(storagePath);
      if (cursorKey && key <= cursorKey) return;
      const value = await lstat(file);
      if (value.isSymbolicLink()) throw new StorageSymlinkError();
      if (value.isFile()) objects.push({ key, ...storedObjectStat(value) });
    };

    const walk = async (directory: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      );
      for (const entry of entries) {
        if (objects.length > options.limit) return;
        const child = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new StorageSymlinkError();
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) await collectFile(child);
      }
    };

    try {
      const value = await lstat(target);
      if (value.isSymbolicLink()) throw new StorageSymlinkError();
      if (value.isFile()) await collectFile(target);
      else if (value.isDirectory()) await walk(target);
    } catch (cause: unknown) {
      if (!isMissingFileError(cause)) throw cause;
    }

    const hasMore = objects.length > options.limit;
    const pageObjects = objects.slice(0, options.limit);
    const lastObject = pageObjects.at(-1);
    return {
      objects: pageObjects,
      cursor: hasMore && lastObject ? Buffer.from(lastObject.key).toString('base64url') : null
    };
  }

  #decodeCursor(cursor: string, prefix: StorageKey): StorageKey {
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) throw new StorageRangeError();
      const key = parseStorageKey(bytes.toString('utf8'));
      if (key !== prefix && !key.startsWith(`${prefix}/`)) throw new StorageRangeError();
      return key;
    } catch (cause: unknown) {
      if (cause instanceof StorageRangeError) throw cause;
      throw new StorageRangeError();
    }
  }
}

export function createLocalObjectStorage(root: string): ObjectStorage {
  return new LocalObjectStorage(root, defaultScratchRoot);
}

export function createLocalObjectStorageWithScratch(
  root: string,
  scratchRoot: string
): ObjectStorage {
  return new LocalObjectStorage(root, scratchRoot);
}
