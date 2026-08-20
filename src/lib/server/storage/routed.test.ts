import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  healthProbeKey,
  parseStorageKey,
  revisionGenerationDerivedPrefix,
  revisionProseImageKey,
  revisionOriginalKey,
  stagingUploadKey,
  titleCoverKey
} from './keys';
import {
  createRoutedLocalObjectStorage,
  StorageKeyRoutingError,
  StorageRootIsolationError
} from './routed';
import { createLocalObjectStorageWithScratch, StorageRangeError } from './local';
import type { ObjectStorage } from './types';

const titleOne = '018f0000-0000-7000-8000-000000000010';
const titleTwo = '018f0000-0000-7000-8000-000000000020';
const revisionOne = '018f0000-0000-7000-8000-000000000011';
const objectOne = '018f0000-0000-7000-8000-000000000001';
const objectTwo = '018f0000-0000-7000-8000-000000000002';

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function signedCursor(payload: unknown, secret: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

describe('routed local object storage', () => {
  let parent: string;
  let stagingRoot: string;
  let publicationRoot: string;
  let coversRoot: string;
  let scratchBase: string;
  const cursorSecret = Buffer.alloc(32, 7);

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'pale-orbit-routed-storage-'));
    stagingRoot = join(parent, 'staging');
    publicationRoot = join(parent, 'publication');
    coversRoot = join(parent, 'covers');
    scratchBase = join(parent, 'scratch');
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  function storage() {
    return createRoutedLocalObjectStorage({
      stagingRoot,
      publicationRoot,
      coversRoot,
      scratchBase,
      cursorSecret
    });
  }

  it('classifies exact logical keys into disjoint roots while retaining each full key', async () => {
    const objectStorage = storage();
    const cases = [
      [stagingUploadKey(objectOne), stagingRoot, 'staging'],
      [healthProbeKey(objectTwo), stagingRoot, 'health'],
      [parseStorageKey('health/publication/readiness-v1'), publicationRoot, 'sentinel'],
      [revisionOriginalKey(titleOne, revisionOne), publicationRoot, 'original'],
      [revisionProseImageKey(titleOne, revisionOne, 3, objectOne), publicationRoot, 'derived'],
      [parseStorageKey(
        `titles/${titleOne}/revisions/${revisionOne}/derived/v1/prose-images/${objectTwo}.webp`
      ), publicationRoot, 'legacy-derived'],
      [titleCoverKey(titleOne, objectTwo), coversRoot, 'cover']
    ] as const;

    for (const [key, root, contents] of cases) {
      await objectStorage.write(key, Readable.from([contents]), { maxBytes: 20 });
      await expect(readFile(join(root, ...key.split('/')), 'utf8')).resolves.toBe(contents);
    }
    await objectStorage.dispose();
  });

  it('fails closed for unknown and operation-ambiguous logical keys', async () => {
    const objectStorage = storage();
    for (const key of [
      parseStorageKey(`titles/${titleOne}/unknown/${objectOne}`),
      parseStorageKey('titles'),
      parseStorageKey(`titles/${titleOne}/covers`),
      parseStorageKey(`staging/uploads/${objectOne}/extra`),
      parseStorageKey(
        `titles/${titleOne}/revisions/${revisionOne}/derived/v1/generations/2147483648/prose-images/${objectOne}.webp`
      )
    ]) {
      await expect(
        objectStorage.write(key, Readable.from(['x']), { maxBytes: 1 })
      ).rejects.toThrow(StorageKeyRoutingError);
    }
    await objectStorage.dispose();
  });

  it('copies across roots with a destination-atomic bounded stream and preserves the source', async () => {
    const objectStorage = storage();
    const source = stagingUploadKey(objectOne);
    const destination = revisionOriginalKey(titleOne, revisionOne);
    await objectStorage.write(source, Readable.from(['immutable']), { maxBytes: 9 });

    await expect(objectStorage.copy(source, destination)).resolves.toMatchObject({ byteSize: 9 });
    await expect(text(await objectStorage.read(source))).resolves.toBe('immutable');
    await expect(text(await objectStorage.read(destination))).resolves.toBe('immutable');
    expect((await readdir(publicationRoot, { recursive: true })).some((entry) =>
      entry.includes('.partial-')
    )).toBe(false);
    await objectStorage.dispose();
  });

  it('leaves an existing destination and source intact and closes the stream when cross-root copy fails', async () => {
    let failingStream: Readable | undefined;
    let streamClosed = false;
    const objectStorage = createRoutedLocalObjectStorage({
      stagingRoot,
      publicationRoot,
      coversRoot,
      scratchBase,
      cursorSecret,
      backendFactory: (name, root, scratchRoot): ObjectStorage => {
        const backend = createLocalObjectStorageWithScratch(root, scratchRoot);
        if (name !== 'staging') return backend;
        return new Proxy(backend, {
          get(target, property) {
            if (property === 'read') {
              return async () => {
                failingStream = Readable.from((async function* () {
                  yield 'partial';
                  throw new Error('injected source read failure');
                })());
                failingStream.once('close', () => {
                  streamClosed = true;
                });
                return failingStream;
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
    });
    const source = stagingUploadKey(objectOne);
    const destination = revisionOriginalKey(titleOne, revisionOne);
    await objectStorage.write(source, Readable.from(['immutable']), { maxBytes: 9 });
    await objectStorage.write(destination, Readable.from(['previous']), { maxBytes: 8 });

    await expect(objectStorage.copy(source, destination)).rejects.toThrow(
      'injected source read failure'
    );
    await expect(readFile(join(stagingRoot, ...source.split('/')), 'utf8')).resolves.toBe(
      'immutable'
    );
    await expect(readFile(join(publicationRoot, ...destination.split('/')), 'utf8')).resolves.toBe(
      'previous'
    );
    expect((await readdir(publicationRoot, { recursive: true })).some((entry) =>
      entry.includes('.partial-')
    )).toBe(false);
    expect(failingStream?.destroyed).toBe(true);
    expect(streamClosed).toBe(true);
    await objectStorage.dispose();
  });

  it('preserves zero-byte objects when copying across roots', async () => {
    const objectStorage = storage();
    const source = stagingUploadKey(objectOne);
    const destination = revisionOriginalKey(titleOne, revisionOne);
    await objectStorage.write(source, Readable.from([]), { maxBytes: 0 });

    await expect(objectStorage.copy(source, destination)).resolves.toMatchObject({ byteSize: 0 });
    await expect(readFile(join(stagingRoot, ...source.split('/')))).resolves.toHaveLength(0);
    await expect(readFile(join(publicationRoot, ...destination.split('/')))).resolves.toHaveLength(0);
    await objectStorage.dispose();
  });

  it('places verified-read snapshots only in an owned ephemeral scratch root', async () => {
    const objectStorage = storage();
    const key = revisionOriginalKey(titleOne, revisionOne);
    await objectStorage.write(key, Readable.from(['abcdef']), { maxBytes: 6 });

    const verified = await objectStorage.prepareVerifiedRead(key, {
      byteSize: 6,
      checksumSha256: 'bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721'
    });
    expect(verified).not.toBeNull();
    expect((await readdir(scratchBase, { recursive: true })).length).toBeGreaterThan(0);
    expect((await readdir(publicationRoot, { recursive: true })).some((entry) =>
      entry.includes('verified')
    )).toBe(false);

    await verified!.close();
    await objectStorage.dispose();
    await expect(readdir(scratchBase)).resolves.toEqual([]);
  });

  it('globally paginates multiple backends with a signed versioned cursor', async () => {
    const objectStorage = storage();
    const keys = [
      titleCoverKey(titleTwo, objectTwo),
      revisionOriginalKey(titleOne, revisionOne),
      titleCoverKey(titleOne, objectOne),
      revisionOriginalKey(titleTwo, revisionOne)
    ];
    for (const key of keys) {
      await objectStorage.write(key, Readable.from([key]), { maxBytes: 500 });
    }

    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(
      function (this: string, other: string) {
        return String(this) < other ? -1 : String(this) > other ? 1 : 0;
      }
    );
    const first = await objectStorage.listPrefix(parseStorageKey('titles'), { limit: 2 });
    expect(first.objects.map(({ key }) => key)).toEqual([...keys].sort().slice(0, 2));
    expect(first.cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    const second = await objectStorage.listPrefix(parseStorageKey('titles'), {
      limit: 2,
      cursor: first.cursor!
    });
    expect(second.objects.map(({ key }) => key)).toEqual([...keys].sort().slice(2));
    expect(second.cursor).toBeNull();

    const tampered = `${first.cursor!.slice(0, -1)}${first.cursor!.endsWith('A') ? 'B' : 'A'}`;
    await expect(objectStorage.listPrefix(parseStorageKey('titles'), {
      limit: 2,
      cursor: tampered
    })).rejects.toThrow(StorageRangeError);
    await expect(objectStorage.listPrefix(parseStorageKey('titles'), {
      limit: 2,
      cursor: signedCursor({
        v: 1,
        prefix: 'titles',
        after: keys[0],
        backends: ['publication', 'foreign']
      }, cursorSecret)
    })).rejects.toThrow(StorageRangeError);
    const localeCompareCalls = localeCompare.mock.calls.length;
    localeCompare.mockRestore();
    expect(localeCompareCalls).toBe(0);
    await objectStorage.dispose();
  });

  it('lists one exact generation namespace without mixing legacy or later generations', async () => {
    const objectStorage = storage();
    const current = revisionProseImageKey(titleOne, revisionOne, 3, objectOne);
    const later = revisionProseImageKey(titleOne, revisionOne, 4, objectTwo);
    const legacy = parseStorageKey(
      `titles/${titleOne}/revisions/${revisionOne}/derived/v1/prose-images/${objectTwo}.webp`
    );
    for (const key of [current, later, legacy]) {
      await objectStorage.write(key, Readable.from([key]), { maxBytes: 500 });
    }

    const page = await objectStorage.listPrefix(
      revisionGenerationDerivedPrefix(titleOne, revisionOne, 3),
      { limit: 10 }
    );
    expect(page.objects.map(({ key }) => key)).toEqual([current]);
    expect(page.cursor).toBeNull();
    await objectStorage.dispose();
  });

  it('rejects persistent roots or scratch bases that alias or contain each other', async () => {
    expect(() => createRoutedLocalObjectStorage({
      stagingRoot,
      publicationRoot: stagingRoot,
      coversRoot,
      scratchBase,
      cursorSecret
    })).toThrow(StorageRootIsolationError);
    expect(() => createRoutedLocalObjectStorage({
      stagingRoot,
      publicationRoot,
      coversRoot,
      scratchBase: join(publicationRoot, 'scratch'),
      cursorSecret
    })).toThrow(StorageRootIsolationError);
    await expect(stat(parent)).resolves.toBeDefined();
  });

  it('compares canonical real paths after root creation to reject symlinked-parent aliases', async () => {
    const canonicalParent = join(parent, 'canonical');
    const aliasedParent = join(parent, 'aliased');
    await mkdir(canonicalParent, { recursive: true });
    await symlink(canonicalParent, aliasedParent, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => createRoutedLocalObjectStorage({
      stagingRoot: join(canonicalParent, 'shared'),
      publicationRoot: join(aliasedParent, 'shared'),
      coversRoot,
      scratchBase,
      cursorSecret
    })).toThrow(StorageRootIsolationError);
  });

  it('removes owned scratch after partial backend construction fails', async () => {
    expect(() => createRoutedLocalObjectStorage({
      stagingRoot,
      publicationRoot,
      coversRoot,
      scratchBase,
      cursorSecret,
      backendFactory: (name, root, scratchRoot) => {
        if (name === 'publication') throw new Error('injected backend construction failure');
        return createLocalObjectStorageWithScratch(root, scratchRoot);
      }
    })).toThrow('injected backend construction failure');
    await expect(readdir(scratchBase)).resolves.toEqual([]);
  });

  it('generates the cursor secret before creating owned scratch', async () => {
    const source = await readFile(new URL('./routed.ts', import.meta.url), 'utf8');
    const constructor = source.slice(
      source.indexOf('constructor(options: RoutedLocalStorageOptions)'),
      source.indexOf('\n  async write(', source.indexOf('constructor(options: RoutedLocalStorageOptions)'))
    );

    expect(constructor.indexOf('randomBytes(32)')).toBeGreaterThan(-1);
    expect(constructor.indexOf('randomBytes(32)')).toBeLessThan(
      constructor.indexOf('mkdtempSync(')
    );
  });

  it('removes owned scratch from the process exit handler when callers cannot dispose', async () => {
    const moduleUrl = new URL('./routed.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import { createRoutedLocalObjectStorage } from ${JSON.stringify(moduleUrl)};` +
      `createRoutedLocalObjectStorage(${JSON.stringify({
        stagingRoot,
        publicationRoot,
        coversRoot,
        scratchBase
      })});`
    ], { encoding: 'utf8' });

    expect(child.status, `${child.stdout}${child.stderr}`).toBe(0);
    await expect(readdir(scratchBase)).resolves.toEqual([]);
  });
});
