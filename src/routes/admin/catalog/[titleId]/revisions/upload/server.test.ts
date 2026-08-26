import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { CatalogDomainError } from '$lib/server/catalog/errors';
import { runWithDiagnosticContext } from '$lib/server/observability/context';
import { UploadError } from '$lib/server/uploads/multipart';

const { database, storage, parsePublicationUpload, streamObjectWithSha256, acceptRevisionUpload } =
  vi.hoisted(() => ({
    database: {},
    storage: { delete: vi.fn(async () => undefined) },
    parsePublicationUpload: vi.fn(),
    streamObjectWithSha256: vi.fn(),
    acceptRevisionUpload: vi.fn()
  }));

vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({ ingestion: { maxUploadBytes: 1000 } })
}));
vi.mock('$lib/server/db/runtime', () => ({ getDatabaseClient: () => ({ db: database }) }));
vi.mock('$lib/server/storage/runtime', () => ({ getObjectStorage: () => storage }));
vi.mock('$lib/server/uploads/multipart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/uploads/multipart')>()),
  parsePublicationUpload
}));
vi.mock('$lib/server/uploads/stream-object', () => ({ streamObjectWithSha256 }));
vi.mock('$lib/server/catalog/revisions', () => ({ acceptRevisionUpload }));

import { POST } from './+server';

const admin: Actor = { type: 'user', id: randomUUID(), roles: ['admin'] };
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };
const titleId = randomUUID();

function event(actor: Actor, requestId = 'request-upload', id: string = titleId) {
  return {
    locals: { actor, user: null, session: null },
    params: { titleId: id },
    route: { id: '/admin/catalog/[titleId]/revisions/upload' },
    request: new Request(`http://localhost/admin/catalog/${id}/revisions/upload`, {
      method: 'POST',
      headers: { 'x-request-id': requestId },
      body: 'body'
    })
  };
}

function parsedUpload() {
  return {
    filename: 'book.epub',
    mediaType: 'application/epub+zip',
    changeSummary: 'Corrected chapter',
    parentRevisionId: null,
    file: Readable.from(['bytes']),
    completion: Promise.resolve()
  };
}

describe('publication revision upload endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parsePublicationUpload.mockResolvedValue(parsedUpload());
    streamObjectWithSha256.mockResolvedValue({ byteSize: 5, checksumSha256: 'a'.repeat(64) });
    acceptRevisionUpload.mockResolvedValue({ id: randomUUID(), state: 'uploaded' });
  });

  it.each([
    [{ type: 'anonymous' } as Actor, 401],
    [customer, 403]
  ])('authorizes before consuming an unauthorized body', async (actor, status) => {
    const response = await POST(event(actor) as never);
    expect(response.status).toBe(status);
    expect(parsePublicationUpload).not.toHaveBeenCalled();
    expect(streamObjectWithSha256).not.toHaveBeenCalled();
  });

  it.each([
    [new UploadError('malformed_multipart', 'Multipart upload is malformed'), 400],
    [new UploadError('file_size_limit', 'Uploaded file exceeds the size limit'), 413]
  ])('maps safe multipart failures', async (failure, status) => {
    parsePublicationUpload.mockRejectedValueOnce(failure);
    const response = await POST(event(admin) as never);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code: failure.code, message: failure.message });
  });

  it('rejects an invalid title ID before parsing multipart', async () => {
    const response = await POST(event(admin, 'request-id', 'not-a-uuid') as never);
    expect(response.status).toBe(400);
    expect(parsePublicationUpload).not.toHaveBeenCalled();
  });

  it.each([
    ['title_not_found', 404],
    ['revision_conflict', 409]
  ] as const)('maps %s and deletes the exact staged object', async (code, status) => {
    acceptRevisionUpload.mockRejectedValueOnce(new CatalogDomainError(code));
    const response = await POST(event(admin) as never);
    const stagedKey = streamObjectWithSha256.mock.calls[0]?.[1];
    expect(response.status).toBe(status);
    expect(storage.delete).toHaveBeenCalledWith(stagedKey);
  });

  it('returns 202 and passes only server authority with a validated correlation ID', async () => {
    const revisionId = randomUUID();
    acceptRevisionUpload.mockResolvedValueOnce({ id: revisionId, state: 'uploaded' });

    const response = await POST(event(admin, 'request-123') as never);

    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ revisionId, state: 'uploaded' });
    expect(acceptRevisionUpload).toHaveBeenCalledWith(database, {
      actor: admin,
      correlationId: 'request-123',
      requestMetadata: {
        method: 'POST',
        routeId: '/admin/catalog/[titleId]/revisions/upload'
      },
      input: {
        titleId,
        parentRevisionId: null,
        changeSummary: 'Corrected chapter',
        stagingStorageKey: expect.stringMatching(/^staging\/uploads\/[0-9a-f-]{36}$/u),
        stagingChecksumSha256: 'a'.repeat(64),
        stagingByteSize: 5,
        uploadFilename: 'book.epub',
        uploadMimeType: 'application/epub+zip'
      }
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('accepts exactly 100 characters and replaces 101', async () => {
    const maximum = `a${'x'.repeat(99)}`;
    await POST(event(admin, maximum) as never);
    expect(acceptRevisionUpload.mock.calls.at(-1)?.[1].correlationId).toBe(maximum);

    await POST(event(admin, 'x'.repeat(101)) as never);
    expect(acceptRevisionUpload.mock.calls.at(-1)?.[1].correlationId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('prefers ambient diagnostic correlation over a conflicting header', async () => {
    await runWithDiagnosticContext(
      { kind: 'web', correlationId: 'ambient-upload' } as never,
      () => POST(event(admin, 'conflicting-header') as never)
    );

    expect(acceptRevisionUpload.mock.calls.at(-1)?.[1].correlationId).toBe('ambient-upload');
  });
});
