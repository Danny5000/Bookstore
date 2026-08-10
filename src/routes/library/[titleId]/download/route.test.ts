import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { MediaNotFoundError } from '$lib/server/catalog/media';
import { parseStorageKey } from '$lib/server/storage/keys';

const { database, storage, resolveCustomerOriginalDownload } = vi.hoisted(() => ({
  database: {},
  storage: {
    read: vi.fn(async () => Readable.from([Buffer.from('abcdef')])),
    readRange: vi.fn(async () => Readable.from([Buffer.from('bcd')]))
  },
  resolveCustomerOriginalDownload: vi.fn()
}));
vi.mock('$lib/server/db/runtime', () => ({ getDatabaseClient: () => ({ db: database }) }));
vi.mock('$lib/server/storage/runtime', () => ({ getObjectStorage: () => storage }));
vi.mock('$lib/server/catalog/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/catalog/media')>()),
  resolveCustomerOriginalDownload
}));

import { GET, HEAD } from './+server';

const titleId = randomUUID();
const revisionId = randomUUID();
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };
const access = {
  key: parseStorageKey('titles/018f0000-0000-7000-8000-000000000001/file.epub'),
  stat: { byteSize: 6, modifiedAt: new Date(0) },
  mediaType: 'application/epub+zip',
  checksumSha256: 'a'.repeat(64),
  filename: 'Safe Title.epub',
  disposition: 'attachment' as const,
  cacheControl: 'private, no-store' as const
};

function event(actor: Actor, method: 'GET' | 'HEAD', range?: string) {
  return {
    locals: { actor },
    params: { titleId },
    route: { id: '/library/[titleId]/download' },
    request: new Request(`https://books.example.com/library/${titleId}/download`, {
      method,
      headers: {
        'x-request-id': 'download-request',
        ...(range ? { range } : {})
      }
    })
  };
}

describe('customer original download route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveCustomerOriginalDownload.mockResolvedValue({ access, titleId, revisionId });
  });

  it('streams GET and body-free HEAD through a title-only authorization request', async () => {
    const get = await GET(event(customer, 'GET') as never);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('abcdef');
    const head = await HEAD(event(customer, 'HEAD', 'bytes=1-3') as never);
    expect(head.status).toBe(206);
    expect(await head.text()).toBe('');
    expect(storage.read).toHaveBeenCalledTimes(1);
    expect(storage.readRange).not.toHaveBeenCalled();
    expect(resolveCustomerOriginalDownload).toHaveBeenLastCalledWith(
      database,
      storage,
      customer,
      {
        titleId,
        correlationId: 'download-request',
        rangeRequested: true,
        requestMetadata: { method: 'HEAD', routeId: '/library/[titleId]/download' }
      }
    );
    expect(JSON.stringify(resolveCustomerOriginalDownload.mock.calls)).not.toContain('revisionId');
  });

  it('fails invalid, signed-out, and inaccessible requests closed', async () => {
    expect((await GET({ ...event(customer, 'GET'), params: { titleId: 'bad' } } as never)).status)
      .toBe(404);
    expect((await GET(event({ type: 'anonymous' }, 'GET') as never)).status).toBe(401);
    resolveCustomerOriginalDownload.mockRejectedValueOnce(new MediaNotFoundError());
    expect((await GET(event(customer, 'GET') as never)).status).toBe(404);
  });
});
