import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { parseStorageKey } from '$lib/server/storage/keys';
import type { ObjectStorage } from '$lib/server/storage/types';
import { streamMediaResponse } from './media-response';

const checksum = 'a'.repeat(64);
const access = {
  key: parseStorageKey('titles/018f0000-0000-7000-8000-000000000001/file.epub'),
  stat: { byteSize: 6, modifiedAt: new Date(0) },
  mediaType: 'application/epub+zip',
  checksumSha256: checksum,
  filename: 'A Book.epub',
  disposition: 'attachment' as const,
  cacheControl: 'private, no-store' as const
};

function storage(): ObjectStorage {
  return {
    read: vi.fn(async () => Readable.from([Buffer.from('abcdef')])),
    readRange: vi.fn(async (_key, start: number, end: number) =>
      Readable.from([Buffer.from('abcdef').subarray(start, end + 1)]))
  } as unknown as ObjectStorage;
}

describe('method-aware media streaming', () => {
  it('returns identical full GET/HEAD metadata without reading a HEAD body', async () => {
    const objectStorage = storage();
    const get = await streamMediaResponse(objectStorage, access, 'GET', null);
    const head = await streamMediaResponse(objectStorage, access, 'HEAD', null);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('abcdef');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    for (const header of [
      'content-length', 'content-type', 'content-disposition', 'etag',
      'accept-ranges', 'cache-control', 'x-content-type-options'
    ]) expect(head.headers.get(header)).toBe(get.headers.get(header));
    expect(objectStorage.read).toHaveBeenCalledTimes(1);
  });

  it('validates inclusive ranges for HEAD without reading storage', async () => {
    const objectStorage = storage();
    const head = await streamMediaResponse(objectStorage, access, 'HEAD', 'bytes=1-3');
    expect(head.status).toBe(206);
    expect(head.headers.get('content-range')).toBe('bytes 1-3/6');
    expect(head.headers.get('content-length')).toBe('3');
    expect(objectStorage.read).not.toHaveBeenCalled();
    expect(objectStorage.readRange).not.toHaveBeenCalled();

    for (const range of ['bytes=20-', 'bytes=0-1,3-4', 'items=0-1']) {
      const response = await streamMediaResponse(objectStorage, access, 'HEAD', range);
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */6');
    }
  });

  it('fails closed when an original has same-size checksum corruption', async () => {
    const objectStorage = storage();
    objectStorage.prepareVerifiedRead = vi.fn(async () => null);

    await expect(
      streamMediaResponse(
        objectStorage,
        { ...access, verifyIntegrity: true },
        'GET',
        null
      )
    ).rejects.toThrow('Stored media failed integrity verification');
    expect(objectStorage.read).not.toHaveBeenCalled();
  });

  it('does not open or checksum a verified original for HEAD metadata', async () => {
    const objectStorage = storage();
    objectStorage.prepareVerifiedRead = vi.fn(async () => null);

    const response = await streamMediaResponse(
      objectStorage,
      { ...access, verifyIntegrity: true },
      'HEAD',
      null
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(objectStorage.prepareVerifiedRead).not.toHaveBeenCalled();
    expect(objectStorage.read).not.toHaveBeenCalled();
    expect(objectStorage.readRange).not.toHaveBeenCalled();
  });

  it('streams a verified original snapshot without reopening the storage object', async () => {
    const objectStorage = storage();
    const close = vi.fn(async () => undefined);
    objectStorage.prepareVerifiedRead = vi.fn(async () => ({
      stat: access.stat,
      read: vi.fn(async () => Readable.from([Buffer.from('abcdef')])),
      close
    }));

    const response = await streamMediaResponse(
      objectStorage,
      { ...access, verifyIntegrity: true },
      'GET',
      null
    );
    expect(await response.text()).toBe('abcdef');
    expect(objectStorage.prepareVerifiedRead).toHaveBeenCalledWith(access.key, {
      byteSize: 6,
      checksumSha256: checksum
    });
    expect(objectStorage.read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the verified snapshot when the response body is cancelled', async () => {
    const objectStorage = storage();
    const source = new PassThrough();
    const close = vi.fn(async () => undefined);
    objectStorage.prepareVerifiedRead = vi.fn(async () => ({
      stat: access.stat,
      read: vi.fn(async () => source),
      close
    }));

    const response = await streamMediaResponse(
      objectStorage,
      { ...access, verifyIntegrity: true },
      'GET',
      null
    );
    await response.body?.cancel();

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(source.destroyed).toBe(true);
  });
});
