import { Readable } from 'node:stream';
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
});
