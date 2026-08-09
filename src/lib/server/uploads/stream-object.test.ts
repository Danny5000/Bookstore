import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseStorageKey } from '../storage/keys';
import { createLocalObjectStorage } from '../storage/local';
import type { ObjectStorage } from '../storage/types';
import { hashStoredObject, streamObjectWithSha256 } from './stream-object';

describe('staged object streaming', () => {
  let root: string;
  let storage: ObjectStorage;
  const key = parseStorageKey('staging/uploads/018f0000-0000-7000-8000-000000000001');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pale-orbit-stream-object-test-'));
    storage = createLocalObjectStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes multiple chunks and returns exact size and SHA-256', async () => {
    const expectedHash = createHash('sha256').update('abcdef').digest('hex');

    await expect(
      streamObjectWithSha256(
        storage,
        key,
        Readable.from(['abc', 'def']),
        6,
        new AbortController().signal
      )
    ).resolves.toEqual({ byteSize: 6, checksumSha256: expectedHash });
    await expect(
      hashStoredObject(storage, key, 6, new AbortController().signal)
    ).resolves.toEqual({ byteSize: 6, checksumSha256: expectedHash });
  });

  it.each([
    ['byte excess', () => Readable.from(['12345']), 4, undefined],
    [
      'source error',
      () =>
        Readable.from(
          (async function* () {
            yield 'partial';
            throw new Error('source failed');
          })()
        ),
      100,
      undefined
    ]
  ])('deletes the exact destination after %s', async (_name, source, maxBytes, _unused) => {
    await expect(
      streamObjectWithSha256(
        storage,
        key,
        source(),
        maxBytes,
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(Error);
    expect(await storage.stat(key)).toBeNull();
  });

  it('deletes the destination after abort', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      streamObjectWithSha256(storage, key, Readable.from(['abc']), 10, controller.signal)
    ).rejects.toMatchObject({ code: 'upload_aborted' });
    expect(await storage.stat(key)).toBeNull();
  });

  it('attempts exact cleanup after a storage failure', async () => {
    const deleteObject = vi.fn(async () => undefined);
    const failingStorage = {
      ...storage,
      write: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
      delete: deleteObject
    } as unknown as ObjectStorage;

    await expect(
      streamObjectWithSha256(
        failingStorage,
        key,
        Readable.from(['abc']),
        10,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'storage_failure' });
    expect(deleteObject).toHaveBeenCalledWith(key);
  });
});
