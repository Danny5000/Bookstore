import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import {
  parseStorageKey,
  publicationReadinessSentinelKey,
  type StorageKey
} from './keys';
import {
  createLocalObjectStorageWithScratch,
  StorageRangeError,
  StorageSymlinkError
} from './local';
import type {
  ObjectStorage,
  PreparedVerifiedRead,
  StorageListPage,
  StoredObjectStat
} from './types';

type BackendName = 'staging' | 'publication' | 'covers';

const backendNames = new Set<BackendName>(['staging', 'publication', 'covers']);
const publicationSentinel = publicationReadinessSentinelKey();
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const generation = '(?:0|[1-9][0-9]{0,9})';
const derivedClass = '(?:prose-images|comic-pages|cover-suggestions)';
const stagingObject = new RegExp(`^(?:staging/uploads|health/probes)/${uuid}$`, 'u');
const publicationObject = new RegExp(
  `^titles/${uuid}/revisions/${uuid}/(?:original|derived/v1/(?:${derivedClass}/${uuid}\\.webp|generations/${generation}/${derivedClass}/${uuid}\\.webp))$`,
  'u'
);
const coverObject = new RegExp(`^titles/${uuid}/covers/${uuid}\\.webp$`, 'u');
const stagingPrefix = new RegExp(`^(?:staging(?:/uploads)?|health(?:/probes)?)(?:/${uuid})?$`, 'u');
const titleRootPrefix = new RegExp(`^titles(?:/${uuid})?$`, 'u');
const coverPrefix = new RegExp(`^titles/${uuid}/covers(?:/${uuid}\\.webp)?$`, 'u');
const publicationPrefix = new RegExp(
  `^titles/${uuid}/revisions(?:/${uuid}(?:/(?:original|derived(?:/v1(?:/(?:${derivedClass}(?:/${uuid}\\.webp)?|generations(?:/${generation}(?:/${derivedClass}(?:/${uuid}\\.webp)?)?)?))?)?)?)?)?$`,
  'u'
);
const maximumListPageSize = 1_000;
const maximumGeneration = 2_147_483_647;

function hasBoundedGeneration(value: string): boolean {
  const match = /\/generations\/([^/]+)/u.exec(value);
  return !match || Number(match[1]) <= maximumGeneration;
}

export class StorageKeyRoutingError extends Error {
  constructor() {
    super('Storage key does not map to exactly one configured backend');
    this.name = 'StorageKeyRoutingError';
  }
}

export class StorageRootIsolationError extends Error {
  constructor() {
    super('Storage roots and verified-read scratch must be mutually disjoint');
    this.name = 'StorageRootIsolationError';
  }
}

export interface RoutedLocalStorageOptions {
  stagingRoot: string;
  publicationRoot: string;
  coversRoot: string;
  scratchBase?: string;
  cursorSecret?: Buffer;
  backendFactory?: (
    name: BackendName,
    root: string,
    scratchRoot: string
  ) => ObjectStorage;
}

export interface RoutedLocalObjectStorage extends ObjectStorage {
  dispose(): Promise<void>;
}

interface CursorPayload {
  v: 1;
  prefix: string;
  after: string;
  backends: BackendName[];
}

function rootsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const isInside = (value: string) => value === '' || (!value.startsWith(`..${sep}`) && value !== '..');
  return isInside(leftToRight) || isInside(rightToLeft);
}

function operationBackend(key: StorageKey): BackendName {
  if (stagingObject.test(key)) return 'staging';
  if (key === publicationSentinel) return 'publication';
  if (publicationObject.test(key) && hasBoundedGeneration(key)) return 'publication';
  if (coverObject.test(key)) return 'covers';
  throw new StorageKeyRoutingError();
}

function prefixBackends(prefix: StorageKey): BackendName[] {
  if (stagingPrefix.test(prefix)) return ['staging'];
  if (prefix === publicationSentinel) return ['publication'];
  if (titleRootPrefix.test(prefix)) return ['covers', 'publication'];
  if (coverPrefix.test(prefix)) return ['covers'];
  if (publicationPrefix.test(prefix) && hasBoundedGeneration(prefix)) return ['publication'];
  throw new StorageKeyRoutingError();
}

class RoutedStorage implements RoutedLocalObjectStorage {
  readonly #backends: Record<BackendName, ObjectStorage>;
  readonly #scratchRoot: string;
  readonly #cursorSecret: Buffer;
  readonly #exitCleanup: () => void;
  #disposed = false;

  constructor(options: RoutedLocalStorageOptions) {
    const requestedPersistentRoots = [
      resolve(options.stagingRoot),
      resolve(options.publicationRoot),
      resolve(options.coversRoot)
    ];
    const requestedScratchBase = resolve(options.scratchBase ?? tmpdir());
    const requestedRoots = [...requestedPersistentRoots, requestedScratchBase];
    for (let left = 0; left < requestedRoots.length; left += 1) {
      for (let right = left + 1; right < requestedRoots.length; right += 1) {
        if (rootsOverlap(requestedRoots[left]!, requestedRoots[right]!)) {
          throw new StorageRootIsolationError();
        }
      }
    }
    if (!Buffer.isBuffer(options.cursorSecret) && options.cursorSecret !== undefined) {
      throw new StorageRangeError();
    }
    if (options.cursorSecret && options.cursorSecret.byteLength < 32) throw new StorageRangeError();

    for (const root of requestedRoots) {
      mkdirSync(root, { recursive: true });
      if (lstatSync(root).isSymbolicLink()) throw new StorageSymlinkError();
    }
    const persistentRoots = requestedPersistentRoots.map((root) => realpathSync.native(root));
    const scratchBase = realpathSync.native(requestedScratchBase);
    const canonicalRoots = [...persistentRoots, scratchBase];
    for (let left = 0; left < canonicalRoots.length; left += 1) {
      for (let right = left + 1; right < canonicalRoots.length; right += 1) {
        if (rootsOverlap(canonicalRoots[left]!, canonicalRoots[right]!)) {
          throw new StorageRootIsolationError();
        }
      }
    }
    this.#cursorSecret = Buffer.from(options.cursorSecret ?? randomBytes(32));
    this.#scratchRoot = mkdtempSync(
      join(scratchBase, `pale-orbit-verified-${process.pid}-`)
    );
    this.#exitCleanup = () => {
      rmSync(this.#scratchRoot, { recursive: true, force: true });
    };
    process.once('exit', this.#exitCleanup);

    try {
      const backendFactory = options.backendFactory ?? (
        (_name: BackendName, root: string, scratchRoot: string) =>
          createLocalObjectStorageWithScratch(root, scratchRoot)
      );
      this.#backends = {
        staging: backendFactory('staging', persistentRoots[0]!, this.#scratchRoot),
        publication: backendFactory('publication', persistentRoots[1]!, this.#scratchRoot),
        covers: backendFactory('covers', persistentRoots[2]!, this.#scratchRoot)
      };
    } catch (cause: unknown) {
      process.removeListener('exit', this.#exitCleanup);
      this.#exitCleanup();
      throw cause;
    }
  }

  async write(
    key: StorageKey,
    body: Readable,
    options: { maxBytes: number; expectedBytes?: number }
  ): Promise<StoredObjectStat> {
    return this.#backendFor(key).write(key, body, options);
  }

  async read(key: StorageKey): Promise<Readable> {
    return this.#backendFor(key).read(key);
  }

  async readRange(key: StorageKey, start: number, endInclusive: number): Promise<Readable> {
    return this.#backendFor(key).readRange(key, start, endInclusive);
  }

  async prepareVerifiedRead(
    key: StorageKey,
    expected: { byteSize: number; checksumSha256: string }
  ): Promise<PreparedVerifiedRead | null> {
    return this.#backendFor(key).prepareVerifiedRead(key, expected);
  }

  async stat(key: StorageKey): Promise<StoredObjectStat | null> {
    return this.#backendFor(key).stat(key);
  }

  async copy(source: StorageKey, destination: StorageKey): Promise<StoredObjectStat> {
    const sourceName = operationBackend(source);
    const destinationName = operationBackend(destination);
    if (sourceName === destinationName) {
      return this.#backends[sourceName].copy(source, destination);
    }

    const sourceStat = await this.#backends[sourceName].stat(source);
    if (!sourceStat) {
      const error = new Error('Storage object not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    const sourceStream = await this.#backends[sourceName].read(source);
    return this.#backends[destinationName].write(destination, sourceStream, {
      maxBytes: sourceStat.byteSize,
      expectedBytes: sourceStat.byteSize
    });
  }

  async delete(key: StorageKey): Promise<void> {
    return this.#backendFor(key).delete(key);
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
    const names = prefixBackends(validatedPrefix);
    const cursor = options.cursor
      ? this.#decodeCursor(options.cursor, validatedPrefix, names)
      : undefined;
    const backendCursor = cursor
      ? Buffer.from(cursor.after).toString('base64url')
      : undefined;
    const pages = await Promise.all(names.map(async (name) => ({
      name,
      page: await this.#backends[name].listPrefix(validatedPrefix, {
        limit: options.limit,
        ...(backendCursor ? { cursor: backendCursor } : {})
      })
    })));
    const merged = pages.flatMap(({ page }) => page.objects)
      .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const objects = merged.slice(0, options.limit);
    const last = objects.at(-1);
    const hasMore = merged.length > options.limit || pages.some(({ page }) => page.cursor !== null);
    return {
      objects,
      cursor: hasMore && last
        ? this.#encodeCursor({
            v: 1,
            prefix: validatedPrefix,
            after: last.key,
            backends: names
          })
        : null
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    process.removeListener('exit', this.#exitCleanup);
    await rm(this.#scratchRoot, { recursive: true, force: true });
  }

  #backendFor(key: StorageKey): ObjectStorage {
    return this.#backends[operationBackend(parseStorageKey(key))];
  }

  #encodeCursor(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.#cursorSecret)
      .update(encoded)
      .digest('base64url');
    return `${encoded}.${signature}`;
  }

  #decodeCursor(
    cursor: string,
    prefix: StorageKey,
    expectedBackends: readonly BackendName[]
  ): CursorPayload {
    try {
      const parts = cursor.split('.');
      if (parts.length !== 2) throw new StorageRangeError();
      const [encoded, suppliedSignature] = parts as [string, string];
      const decoded = Buffer.from(encoded, 'base64url');
      const supplied = Buffer.from(suppliedSignature, 'base64url');
      if (
        decoded.toString('base64url') !== encoded ||
        supplied.toString('base64url') !== suppliedSignature
      ) throw new StorageRangeError();
      const expected = createHmac('sha256', this.#cursorSecret).update(encoded).digest();
      if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
        throw new StorageRangeError();
      }
      const payload = JSON.parse(decoded.toString('utf8')) as Partial<CursorPayload>;
      if (
        payload.v !== 1 ||
        payload.prefix !== prefix ||
        typeof payload.after !== 'string' ||
        !Array.isArray(payload.backends) ||
        Object.keys(payload).sort().join(',') !== 'after,backends,prefix,v' ||
        payload.backends.some((name) => !backendNames.has(name)) ||
        payload.backends.length !== expectedBackends.length ||
        payload.backends.some((name, index) => name !== expectedBackends[index])
      ) throw new StorageRangeError();
      const after = parseStorageKey(payload.after);
      if (after !== prefix && !after.startsWith(`${prefix}/`)) throw new StorageRangeError();
      return { v: 1, prefix, after, backends: [...expectedBackends] };
    } catch (cause: unknown) {
      if (cause instanceof StorageRangeError) throw cause;
      throw new StorageRangeError();
    }
  }
}

export function createRoutedLocalObjectStorage(
  options: RoutedLocalStorageOptions
): RoutedLocalObjectStorage {
  return new RoutedStorage(options);
}
