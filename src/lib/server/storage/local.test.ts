import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseStorageKey } from './keys';
import {
  createLocalObjectStorage,
  StorageLimitError,
  StorageRangeError,
  StorageSymlinkError
} from './local';

async function readText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('local object storage', () => {
  let root: string;
  const cleanupRoots: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pale-orbit-storage-test-'));
    cleanupRoots.push(root);
  });

  afterEach(async () => {
    await Promise.all(
      cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
  });

  it('atomically writes, reads, and stats an object', async () => {
    const storage = createLocalObjectStorage(root);
    const key = parseStorageKey('staging/uploads/018f0000-0000-7000-8000-000000000001');

    const written = await storage.write(key, Readable.from(['abc', 'def']), { maxBytes: 6 });

    expect(written.byteSize).toBe(6);
    expect(written.modifiedAt).toBeInstanceOf(Date);
    await expect(readText(await storage.read(key))).resolves.toBe('abcdef');
    expect(await storage.stat(key)).toMatchObject({ byteSize: 6 });
  });

  it('removes partial state when the byte limit is exceeded', async () => {
    const storage = createLocalObjectStorage(root);
    const key = parseStorageKey('staging/uploads/018f0000-0000-7000-8000-000000000002');

    await expect(storage.write(key, Readable.from(['12345']), { maxBytes: 4 })).rejects.toThrow(
      StorageLimitError
    );

    expect(await storage.stat(key)).toBeNull();
    expect((await readdir(root, { recursive: true })).some((entry) => entry.includes('.partial-'))).toBe(
      false
    );
  });

  it('supports inclusive ranges and rejects invalid or out-of-range requests', async () => {
    const storage = createLocalObjectStorage(root);
    const key = parseStorageKey('titles/018f0000-0000-7000-8000-000000000010/covers');
    await storage.write(key, Readable.from(['abcdef']), { maxBytes: 6 });

    await expect(readText(await storage.readRange(key, 1, 3))).resolves.toBe('bcd');
    await expect(storage.readRange(key, -1, 2)).rejects.toThrow(StorageRangeError);
    await expect(storage.readRange(key, 3, 2)).rejects.toThrow(StorageRangeError);
    await expect(storage.readRange(key, 0, 6)).rejects.toThrow(StorageRangeError);
  });

  it('copies atomically and leaves source and destination independent', async () => {
    const storage = createLocalObjectStorage(root);
    const source = parseStorageKey('staging/uploads/018f0000-0000-7000-8000-000000000003');
    const destination = parseStorageKey(
      'titles/018f0000-0000-7000-8000-000000000010/revisions/018f0000-0000-7000-8000-000000000011/original'
    );
    await storage.write(source, Readable.from(['original']), { maxBytes: 8 });

    expect(await storage.copy(source, destination)).toMatchObject({ byteSize: 8 });
    await storage.write(source, Readable.from(['changed']), { maxBytes: 7 });

    await expect(readText(await storage.read(destination))).resolves.toBe('original');
    await expect(readText(await storage.read(source))).resolves.toBe('changed');
  });

  it('deletes only the exact object and is idempotent', async () => {
    const storage = createLocalObjectStorage(root);
    const first = parseStorageKey('health/probes/018f0000-0000-7000-8000-000000000001');
    const second = parseStorageKey('health/probes/018f0000-0000-7000-8000-000000000002');
    await storage.write(first, Readable.from(['one']), { maxBytes: 3 });
    await storage.write(second, Readable.from(['two']), { maxBytes: 3 });

    await storage.delete(first);
    await storage.delete(first);

    expect(await storage.stat(first)).toBeNull();
    await expect(readText(await storage.read(second))).resolves.toBe('two');
  });

  it('lists a prefix in deterministic bounded pages', async () => {
    const storage = createLocalObjectStorage(root);
    const prefix = parseStorageKey('health/probes');
    const keys = [
      parseStorageKey('health/probes/018f0000-0000-7000-8000-000000000003'),
      parseStorageKey('health/probes/018f0000-0000-7000-8000-000000000001'),
      parseStorageKey('health/probes/018f0000-0000-7000-8000-000000000002')
    ];
    for (const key of keys) await storage.write(key, Readable.from([key]), { maxBytes: 100 });

    const first = await storage.listPrefix(prefix, { limit: 2 });
    expect(first.objects.map(({ key }) => key)).toEqual([...keys].sort().slice(0, 2));
    expect(first.cursor).not.toBeNull();

    const second = await storage.listPrefix(prefix, { limit: 2, cursor: first.cursor! });
    expect(second.objects.map(({ key }) => key)).toEqual([...keys].sort().slice(2));
    expect(second.cursor).toBeNull();

    await expect(storage.listPrefix(prefix, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(
      storage.listPrefix(prefix, {
        limit: 2,
        cursor: Buffer.from('titles/not-the-prefix').toString('base64url')
      })
    ).rejects.toThrow(StorageRangeError);
  });

  it('refuses a symbolic-link escape placed inside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pale-orbit-storage-outside-'));
    cleanupRoots.push(outside);
    await symlink(outside, join(root, 'titles'), 'junction');
    const storage = createLocalObjectStorage(root);
    const key = parseStorageKey('titles/escaped-object');

    await expect(storage.write(key, Readable.from(['secret']), { maxBytes: 6 })).rejects.toThrow(
      StorageSymlinkError
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it('removes partial state when the input stream fails', async () => {
    const storage = createLocalObjectStorage(root);
    const key = parseStorageKey('staging/uploads/018f0000-0000-7000-8000-000000000004');
    const body = Readable.from(
      (async function* () {
        yield 'partial';
        throw new Error('simulated stream failure');
      })()
    );

    await expect(storage.write(key, body, { maxBytes: 100 })).rejects.toThrow(
      'simulated stream failure'
    );
    expect(await storage.stat(key)).toBeNull();
    expect((await readdir(root, { recursive: true })).some((entry) => entry.includes('.partial-'))).toBe(
      false
    );
  });
});
