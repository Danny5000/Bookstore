import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { StorageKey } from './keys';
import { probeStorage } from './health';
import type { ObjectStorage } from './types';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function probeStorageDouble(options: { mismatch?: boolean } = {}) {
  let written: Buffer = Buffer.alloc(0);
  const write = vi.fn(async (_key: StorageKey, body: Readable, _options: { maxBytes: number }) => {
    written = await collect(body);
    return { byteSize: written.byteLength, modifiedAt: new Date(0) };
  });
  const read = vi.fn(async () =>
    Readable.from([options.mismatch ? Buffer.from('wrong') : written])
  );
  const deleteObject = vi.fn(async () => undefined);
  const storage = {
    write,
    read,
    readRange: vi.fn(),
    stat: vi.fn(),
    copy: vi.fn(),
    delete: deleteObject,
    listPrefix: vi.fn()
  } as unknown as ObjectStorage;
  return { storage, write, read, deleteObject };
}

describe('probeStorage', () => {
  it('round-trips random non-content bytes and deletes the exact probe', async () => {
    const { storage, write, read, deleteObject } = probeStorageDouble();

    await expect(probeStorage(storage)).resolves.toBeUndefined();

    const key = write.mock.calls[0]?.[0];
    expect(key).toMatch(/^health\/probes\/[0-9a-f-]{36}$/u);
    expect(write.mock.calls[0]?.[2]).toEqual({ maxBytes: 32 });
    expect(read).toHaveBeenCalledWith(key);
    expect(deleteObject).toHaveBeenCalledWith(key);
  });

  it('fails closed on a mismatched read and still deletes the probe', async () => {
    const { storage, write, deleteObject } = probeStorageDouble({ mismatch: true });

    await expect(probeStorage(storage)).rejects.toThrow('Storage readiness probe failed');

    expect(deleteObject).toHaveBeenCalledWith(write.mock.calls[0]?.[0]);
  });
});
