import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import type { ObjectStorage } from '$lib/server/storage/types';

const { appendAuditEvent, lockReaderTitle, resolvePublicationAccess } = vi.hoisted(() => ({
  appendAuditEvent: vi.fn(),
  lockReaderTitle: vi.fn(),
  resolvePublicationAccess: vi.fn()
}));
vi.mock('$lib/server/audit/service', () => ({ appendAuditEvent }));
vi.mock('$lib/server/library/access', () => ({ resolvePublicationAccess }));
vi.mock('$lib/server/reader-state/lock', () => ({ lockReaderTitle }));

import {
  MediaNotFoundError,
  resolveCoverAccess,
  resolveCoverSuggestionAccess,
  resolveOriginalDownload,
  resolveReaderImageAccess,
  streamCustomerOriginalDownload
} from './media';

function databaseReturning(...results: unknown[][]): Database {
  const database: Record<string, unknown> = {};
  database.select = vi.fn(() => {
    const value = results.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'for']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.then = (resolve: (value: unknown[]) => unknown, reject: (cause: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return chain;
  });
  database.transaction = vi.fn(async (work: (transaction: Database) => Promise<unknown>) =>
    work(database as unknown as Database)
  );
  return database as unknown as Database;
}

function storageWithSize(byteSize = 100): ObjectStorage {
  return {
    stat: vi.fn(async () => ({ byteSize, modifiedAt: new Date(0) })),
    prepareVerifiedRead: vi.fn(async () => ({
      stat: { byteSize, modifiedAt: new Date(0) },
      read: vi.fn(async () => Readable.from([Buffer.alloc(byteSize)])),
      close: vi.fn(async () => undefined)
    }))
  } as unknown as ObjectStorage;
}

const anonymous: Actor = { type: 'anonymous' };
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };
const admin: Actor = { type: 'user', id: randomUUID(), roles: ['admin'] };
const titleId = randomUUID();
const revisionId = randomUUID();
const imageId = randomUUID();
const checksum = 'a'.repeat(64);

const publicTitle = {
  id: titleId,
  visibility: 'public' as const,
  activeRevisionId: revisionId,
  coverStorageKey: 'titles/cover-object',
  coverMediaType: 'image/webp',
  coverChecksumSha256: checksum,
  coverByteSize: 100,
  coverWidth: 10,
  coverHeight: 20
};

const activeRevision = { id: revisionId, titleId, state: 'active' as const };

function accessDecision(
  level: 'admin' | 'entitled' | 'preview',
  overrides: { titleId?: string; revisionId?: string } = {}
) {
  return {
    level,
    titleId: overrides.titleId ?? titleId,
    revisionId: overrides.revisionId ?? revisionId,
    presentationId: randomUUID()
  };
}

describe('publication media authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePublicationAccess.mockResolvedValue(accessDecision('preview'));
    lockReaderTitle.mockResolvedValue({
      userId: customer.id,
      title: { ...publicTitle, title: 'A Curious Book', format: 'prose' as const },
      revisionId,
      presentation: { id: randomUUID(), revisionId, state: 'published' }
    });
  });

  it('resolves a qualified public cover and keeps private covers admin-only', async () => {
    await expect(
      resolveCoverAccess(
        databaseReturning([publicTitle]),
        storageWithSize(),
        anonymous,
        { titleId, checksum }
      )
    ).resolves.toMatchObject({
      mediaType: 'image/webp',
      checksumSha256: checksum,
      cacheControl: 'public, max-age=31536000, immutable'
    });

    const privateTitle = { ...publicTitle, visibility: 'private', activeRevisionId: null };
    resolvePublicationAccess.mockResolvedValueOnce({ level: 'denied' });
    await expect(
      resolveCoverAccess(databaseReturning([privateTitle]), storageWithSize(), customer, {
        titleId,
        checksum
      })
    ).rejects.toBeInstanceOf(MediaNotFoundError);
    resolvePublicationAccess.mockResolvedValueOnce({ level: 'unavailable', titleId });
    await expect(
      resolveCoverAccess(databaseReturning([privateTitle]), storageWithSize(), admin, {
        titleId,
        checksum
      })
    ).resolves.toMatchObject({ cacheControl: 'private, no-store' });
  });

  it('serves entitled covers and full current-revision images privately', async () => {
    const archivedTitle = { ...publicTitle, visibility: 'archived' as const };
    resolvePublicationAccess.mockResolvedValueOnce(accessDecision('entitled'));
    await expect(
      resolveCoverAccess(databaseReturning([archivedTitle]), storageWithSize(), customer, {
        titleId,
        checksum
      })
    ).resolves.toMatchObject({ cacheControl: 'private, no-store' });

    const asset = {
      title: archivedTitle,
      revision: activeRevision,
      media: {
        id: imageId,
        storageKey: 'private/full-reader-image',
        mediaType: 'image/webp',
        checksumSha256: checksum,
        byteSize: 100
      }
    };
    resolvePublicationAccess.mockResolvedValueOnce(accessDecision('entitled'));
    await expect(
      resolveReaderImageAccess(databaseReturning([asset]), storageWithSize(), customer, {
        revisionId,
        imageId,
        checksum
      })
    ).resolves.toMatchObject({ cacheControl: 'private, no-store' });
  });

  it('does not let an entitlement select a candidate or another revision', async () => {
    const candidateRevisionId = randomUUID();
    const asset = {
      title: publicTitle,
      revision: { ...activeRevision, id: candidateRevisionId, state: 'ready_for_review' as const },
      media: {
        id: imageId,
        storageKey: 'private/candidate-image',
        mediaType: 'image/webp',
        checksumSha256: checksum,
        byteSize: 100
      }
    };
    resolvePublicationAccess.mockResolvedValueOnce(accessDecision('entitled'));
    await expect(
      resolveReaderImageAccess(databaseReturning([asset]), storageWithSize(), customer, {
        revisionId: candidateRevisionId,
        imageId,
        checksum
      })
    ).rejects.toBeInstanceOf(MediaNotFoundError);
  });

  it('allows a public prose image only when referenced at or before the published boundary', async () => {
    const sectionId = randomUUID();
    const imageBlockId = randomUUID();
    const boundaryBlockId = randomUUID();
    const presentation = {
      id: randomUUID(),
      previewProseSectionId: sectionId,
      previewProseBlockId: boundaryBlockId,
      previewComicPageId: null
    };
    const asset = {
      title: publicTitle,
      revision: activeRevision,
      media: {
        id: imageId,
        storageKey: 'private/prose-image',
        mediaType: 'image/webp',
        checksumSha256: checksum,
        byteSize: 100
      }
    };
    const sections = [{ id: sectionId, ordinal: 0 }];
    const blocks = [
      { id: imageBlockId, sectionId, ordinal: 0, imageId },
      { id: boundaryBlockId, sectionId, ordinal: 1, imageId: null }
    ];
    await expect(
      resolveReaderImageAccess(
        databaseReturning([asset], [presentation], sections, blocks),
        storageWithSize(),
        anonymous,
        { revisionId, imageId, checksum }
      )
    ).resolves.toMatchObject({ cacheControl: 'public, max-age=31536000, immutable' });

    const afterBoundaryBlocks = [
      { id: boundaryBlockId, sectionId, ordinal: 0, imageId: null },
      { id: imageBlockId, sectionId, ordinal: 1, imageId }
    ];
    await expect(
      resolveReaderImageAccess(
        databaseReturning([asset], [presentation], sections, afterBoundaryBlocks),
        storageWithSize(),
        customer,
        { revisionId, imageId, checksum }
      )
    ).rejects.toBeInstanceOf(MediaNotFoundError);
  });

  it('allows a public comic page only through the published page boundary', async () => {
    const firstPage = randomUUID();
    const boundaryPage = randomUUID();
    const laterPage = imageId;
    const asset = {
      title: publicTitle,
      revision: activeRevision,
      media: {
        id: laterPage,
        storageKey: 'private/comic-page',
        mediaType: 'image/webp',
        checksumSha256: checksum,
        byteSize: 100
      }
    };
    const presentation = {
      id: randomUUID(),
      previewProseSectionId: null,
      previewProseBlockId: null,
      previewComicPageId: boundaryPage
    };
    const pages = [
      { id: firstPage, ordinal: 1 },
      { id: boundaryPage, ordinal: 2 },
      { id: laterPage, ordinal: 3 }
    ];
    await expect(
      resolveReaderImageAccess(
        databaseReturning([], [asset], [presentation], pages),
        storageWithSize(),
        anonymous,
        { revisionId, imageId: laterPage, checksum }
      )
    ).rejects.toBeInstanceOf(MediaNotFoundError);
    await expect(
      resolveReaderImageAccess(
        databaseReturning([], [{ ...asset, media: { ...asset.media, id: boundaryPage } }], [presentation], pages),
        storageWithSize(),
        anonymous,
        { revisionId, imageId: boundaryPage, checksum }
      )
    ).resolves.toMatchObject({ checksumSha256: checksum });
  });

  it('denies candidate and checksum-mismatched public assets but permits accepted admin review', async () => {
    const candidateAsset = {
      title: { ...publicTitle, activeRevisionId: randomUUID() },
      revision: { ...activeRevision, state: 'ready_for_review' as const },
      media: {
        id: imageId,
        storageKey: 'private/candidate-image',
        mediaType: 'image/webp',
        checksumSha256: checksum,
        byteSize: 100
      }
    };
    await expect(
      resolveReaderImageAccess(databaseReturning([candidateAsset]), storageWithSize(), anonymous, {
        revisionId,
        imageId,
        checksum
      })
    ).rejects.toBeInstanceOf(MediaNotFoundError);
    await expect(
      resolveReaderImageAccess(databaseReturning([candidateAsset]), storageWithSize(), admin, {
        revisionId,
        imageId,
        checksum
      })
    ).resolves.toMatchObject({ cacheControl: 'private, no-store' });
    await expect(
      resolveReaderImageAccess(databaseReturning([]), storageWithSize(), admin, {
        revisionId,
        imageId,
        checksum: 'b'.repeat(64)
      })
    ).rejects.toBeInstanceOf(MediaNotFoundError);
  });

  it('keeps cover suggestions admin-only and same-revision', async () => {
    await expect(
      resolveCoverSuggestionAccess(databaseReturning([]), storageWithSize(), customer, {
        revisionId,
        suggestionId: imageId,
        checksum
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    const suggestion = {
      revision: { ...activeRevision, state: 'retired' as const },
      media: {
        id: imageId,
        storageKey: 'private/suggestion',
        mediaType: 'image/webp',
        checksumSha256: checksum,
        byteSize: 100
      }
    };
    await expect(
      resolveCoverSuggestionAccess(databaseReturning([suggestion]), storageWithSize(), admin, {
        revisionId,
        suggestionId: imageId,
        checksum
      })
    ).resolves.toMatchObject({ cacheControl: 'private, no-store' });
  });

  it('audits original download initiation without filename or storage key', async () => {
    appendAuditEvent.mockResolvedValueOnce({ id: randomUUID() });
    const original = {
      revision: {
        ...activeRevision,
        state: 'ready_for_review' as const,
        originalStorageKey: 'titles/private-original',
        originalMimeType: 'application/epub+zip',
        originalFilename: 'My Book.epub',
        originalChecksumSha256: checksum,
        originalByteSize: 100
      }
    };
    const access = await resolveOriginalDownload(
      databaseReturning([original]),
      storageWithSize(),
      admin,
      {
        titleId,
        revisionId,
        correlationId: 'download-original',
        requestMetadata: { method: 'GET', routeId: '/admin/original' }
      }
    );
    expect(access).toMatchObject({
      filename: 'My Book.epub',
      disposition: 'attachment',
      cacheControl: 'private, no-store'
    });
    const auditJson = JSON.stringify(appendAuditEvent.mock.calls[0]);
    expect(auditJson).not.toContain('My Book.epub');
    expect(auditJson).not.toContain('private-original');
  });

  it('records a minimal customer audit only after a valid stream response starts', async () => {
    appendAuditEvent.mockResolvedValueOnce({ id: randomUUID() });
    const record = { revision: {
      ...activeRevision,
      originalStorageKey: 'titles/private-original-with-secret-name',
      originalMimeType: 'application/epub+zip',
      originalFilename: 'publisher-secret-name.epub',
      originalChecksumSha256: checksum,
      originalByteSize: 100
    } };
    const response = await streamCustomerOriginalDownload(
      databaseReturning([record]),
      storageWithSize(),
      customer,
      {
        titleId,
        correlationId: 'customer-stream',
        method: 'HEAD',
        rangeHeader: 'bytes=1-3'
      }
    );
    expect(response.status).toBe(206);
    expect(appendAuditEvent.mock.calls[0]?.[1]).toEqual({
      actor: customer,
      action: 'library.original.download',
      outcome: 'succeeded',
      resourceType: 'title_revision',
      resourceId: revisionId,
      correlationId: 'customer-stream',
      after: { titleId, activeRevisionId: revisionId, range: true }
    });
  });

  it('does not audit an invalid range or a synchronous storage-open failure', async () => {
    const record = { revision: {
      ...activeRevision,
      originalStorageKey: 'titles/private-original',
      originalMimeType: 'application/epub+zip',
      originalFilename: 'source.epub',
      originalChecksumSha256: checksum,
      originalByteSize: 100
    } };
    await expect(
      streamCustomerOriginalDownload(
        databaseReturning([record]),
        storageWithSize(),
        customer,
        {
          titleId,
          correlationId: 'invalid-range',
          method: 'GET',
          rangeHeader: 'bytes=200-'
        }
      )
    ).resolves.toMatchObject({ status: 416 });
    expect(appendAuditEvent).not.toHaveBeenCalled();

    const unavailableStorage = storageWithSize();
    vi.mocked(unavailableStorage.prepareVerifiedRead).mockRejectedValueOnce(
      new Error('provider unavailable')
    );
    await expect(
      streamCustomerOriginalDownload(
        databaseReturning([record]),
        unavailableStorage,
        customer,
        {
          titleId,
          correlationId: 'storage-failure',
          method: 'GET',
          rangeHeader: null
        }
      )
    ).rejects.toThrow('provider unavailable');
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it('closes the verified snapshot when the success audit database write fails', async () => {
    const close = vi.fn(async () => undefined);
    const objectStorage = storageWithSize();
    vi.mocked(objectStorage.prepareVerifiedRead).mockResolvedValueOnce({
      stat: { byteSize: 100, modifiedAt: new Date(0) },
      read: vi.fn(async () => Readable.from([Buffer.alloc(100)])),
      close
    });
    appendAuditEvent.mockRejectedValueOnce(new Error('temporary database failure'));
    const record = { revision: {
      ...activeRevision,
      originalStorageKey: 'titles/private-original',
      originalMimeType: 'application/epub+zip',
      originalFilename: 'source.epub',
      originalChecksumSha256: checksum,
      originalByteSize: 100
    } };

    await expect(
      streamCustomerOriginalDownload(
        databaseReturning([record], [record]),
        objectStorage,
        customer,
        {
          titleId,
          correlationId: 'audit-database-failure',
          method: 'GET',
          rangeHeader: null
        }
      )
    ).rejects.toThrow('temporary database failure');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
