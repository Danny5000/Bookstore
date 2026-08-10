import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError, type Actor } from '$lib/server/auth/admin-policy';
import { MediaNotFoundError } from '$lib/server/catalog/media';
import { parseStorageKey } from '$lib/server/storage/keys';

const {
  database,
  storage,
  resolveCoverAccess,
  resolveReaderImageAccess,
  resolveCoverSuggestionAccess,
  resolveOriginalDownload
} = vi.hoisted(() => ({
  database: {},
  storage: {
    read: vi.fn(async () => Readable.from([Buffer.from('abcdef')])),
    readRange: vi.fn(async (_key, start: number, endInclusive: number) =>
      Readable.from([Buffer.from('abcdef').subarray(start, endInclusive + 1)])
    )
  },
  resolveCoverAccess: vi.fn(),
  resolveReaderImageAccess: vi.fn(),
  resolveCoverSuggestionAccess: vi.fn(),
  resolveOriginalDownload: vi.fn()
}));

vi.mock('$lib/server/db/runtime', () => ({ getDatabaseClient: () => ({ db: database }) }));
vi.mock('$lib/server/storage/runtime', () => ({ getObjectStorage: () => storage }));
vi.mock('$lib/server/catalog/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/catalog/media')>()),
  resolveCoverAccess,
  resolveReaderImageAccess,
  resolveCoverSuggestionAccess,
  resolveOriginalDownload
}));

import { GET as getCover, HEAD as headCover } from './covers/[titleId]/[checksum]/+server';
import { GET as getImage } from './revisions/[revisionId]/images/[imageId]/[checksum]/+server';
import { GET as getSuggestion } from './revisions/[revisionId]/cover-suggestion/[suggestionId]/[checksum]/+server';
import { GET as getOriginal } from '../admin/catalog/[titleId]/revisions/[revisionId]/original/+server';

const titleId = randomUUID();
const revisionId = randomUUID();
const imageId = randomUUID();
const checksum = 'a'.repeat(64);
const key = parseStorageKey('titles/018f0000-0000-7000-8000-000000000001/covers/018f0000-0000-7000-8000-000000000002.webp');
const anonymous: Actor = { type: 'anonymous' };
const admin: Actor = { type: 'user', id: randomUUID(), roles: ['admin'] };

function access(overrides: Record<string, unknown> = {}) {
  return {
    key,
    stat: { byteSize: 6, modifiedAt: new Date(0) },
    mediaType: 'image/webp',
    checksumSha256: checksum,
    filename: null,
    disposition: 'inline' as const,
    cacheControl: 'public, max-age=31536000, immutable' as const,
    ...overrides
  };
}

function event(
  actor: Actor,
  params: Record<string, string>,
  path: string,
  headers: Record<string, string> = {},
  routeId = path,
  method: 'GET' | 'HEAD' = 'GET'
) {
  return {
    locals: { actor, user: null, session: null },
    params,
    route: { id: routeId },
    request: new Request(`http://localhost${path}`, { headers, method })
  };
}

describe('publication media routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveCoverAccess.mockResolvedValue(access());
    resolveReaderImageAccess.mockResolvedValue(access());
    resolveCoverSuggestionAccess.mockResolvedValue(access({ cacheControl: 'private, no-store' }));
    resolveOriginalDownload.mockResolvedValue(
      access({
        mediaType: 'application/epub+zip',
        filename: 'My Bøok.epub',
        disposition: 'attachment',
        cacheControl: 'private, no-store'
      })
    );
  });

  it('streams a full immutable cover with safe headers', async () => {
    const response = await getCover(
      event(anonymous, { titleId, checksum }, `/media/covers/${titleId}/${checksum}`) as never
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('abcdef');
    expect(response.headers.get('content-length')).toBe('6');
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('etag')).toBe(`"${checksum}"`);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('returns the same authorized cover metadata for HEAD without opening storage', async () => {
    const response = await headCover(
      event(
        anonymous,
        { titleId, checksum },
        `/media/covers/${titleId}/${checksum}`,
        {},
        '/media/covers/[titleId]/[checksum]',
        'HEAD'
      ) as never
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('content-length')).toBe('6');
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('etag')).toBe(`"${checksum}"`);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(storage.read).not.toHaveBeenCalled();
    expect(storage.readRange).not.toHaveBeenCalled();
  });

  it('streams one byte range with correct response metadata', async () => {
    const response = await getImage(
      event(
        anonymous,
        { revisionId, imageId, checksum },
        `/media/revisions/${revisionId}/images/${imageId}/${checksum}`,
        { range: 'bytes=1-3' }
      ) as never
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('bcd');
    expect(response.headers.get('content-range')).toBe('bytes 1-3/6');
    expect(response.headers.get('content-length')).toBe('3');
    expect(storage.readRange).toHaveBeenCalledWith(key, 1, 3);
  });

  it('returns 416 for malformed or unsatisfiable ranges', async () => {
    const response = await getCover(
      event(
        anonymous,
        { titleId, checksum },
        `/media/covers/${titleId}/${checksum}`,
        { range: 'bytes=20-' }
      ) as never
    );
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */6');
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('maps invalid, missing, and unauthorized public media to 404', async () => {
    let response = await getCover(
      event(anonymous, { titleId: 'bad', checksum }, '/media/covers/bad/value') as never
    );
    expect(response.status).toBe(404);
    expect(resolveCoverAccess).not.toHaveBeenCalled();
    resolveCoverAccess.mockRejectedValueOnce(new MediaNotFoundError());
    response = await getCover(
      event(anonymous, { titleId, checksum }, `/media/covers/${titleId}/${checksum}`) as never
    );
    expect(response.status).toBe(404);
  });

  it('preserves admin 401/403 responses for private suggestions', async () => {
    resolveCoverSuggestionAccess.mockRejectedValueOnce(new AuthorizationError('forbidden', 403));
    const response = await getSuggestion(
      event(
        { type: 'user', id: randomUUID(), roles: ['customer'] },
        { revisionId, suggestionId: imageId, checksum },
        `/media/revisions/${revisionId}/cover-suggestion/${imageId}/${checksum}`
      ) as never
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('streams an audited original as an RFC 5987 attachment', async () => {
    const response = await getOriginal(
      event(
        admin,
        { titleId, revisionId },
        `/admin/catalog/${titleId}/revisions/${revisionId}/original`,
        { 'x-request-id': 'original-request' },
        '/admin/catalog/[titleId]/revisions/[revisionId]/original'
      ) as never
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''My%20B%C3%B8ok.epub");
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(resolveOriginalDownload).toHaveBeenCalledWith(database, storage, admin, {
      titleId,
      revisionId,
      correlationId: 'original-request',
      requestMetadata: {
        method: 'GET',
        routeId: '/admin/catalog/[titleId]/revisions/[revisionId]/original'
      }
    });
  });
});
