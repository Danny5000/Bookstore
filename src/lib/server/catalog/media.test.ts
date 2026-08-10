import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import type { ObjectStorage } from '$lib/server/storage/types';

const { appendAuditEvent, resolvePublicationAccess } = vi.hoisted(() => ({
  appendAuditEvent: vi.fn(),
  resolvePublicationAccess: vi.fn()
}));
vi.mock('$lib/server/audit/service', () => ({ appendAuditEvent }));
vi.mock('$lib/server/library/access', () => ({ resolvePublicationAccess }));

import {
  MediaNotFoundError,
  resolveCoverAccess,
  resolveCoverSuggestionAccess,
  resolveCustomerOriginalDownload,
  resolveOriginalDownload,
  resolveReaderImageAccess
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
    stat: vi.fn(async () => ({ byteSize, modifiedAt: new Date(0) }))
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

  it('resolves the entitled active original with a title-based filename and redacted audit', async () => {
    resolvePublicationAccess.mockResolvedValueOnce(accessDecision('entitled'));
    appendAuditEvent.mockResolvedValueOnce({ id: randomUUID() });
    const record = {
      title: { ...publicTitle, title: 'A / Curious  Book', format: 'prose' as const },
      revision: {
        ...activeRevision,
        originalStorageKey: 'titles/private-original-with-secret-name',
        originalMimeType: 'application/epub+zip',
        originalFilename: 'publisher-secret-name.epub',
        originalChecksumSha256: checksum,
        originalByteSize: 100
      }
    };
    const result = await resolveCustomerOriginalDownload(
      databaseReturning([record]),
      storageWithSize(),
      customer,
      {
        titleId,
        correlationId: 'customer-download',
        rangeRequested: true,
        requestMetadata: { method: 'GET', routeId: '/library/[titleId]/download' }
      }
    );
    expect(result).toMatchObject({
      titleId,
      revisionId,
      access: {
        mediaType: 'application/epub+zip',
        filename: 'Curious  Book.epub',
        disposition: 'attachment',
        cacheControl: 'private, no-store'
      }
    });
    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    const auditJson = JSON.stringify(appendAuditEvent.mock.calls[0]);
    expect(auditJson).toContain('library.original.download');
    expect(auditJson).toContain(customer.id);
    expect(auditJson).toContain(titleId);
    expect(auditJson).toContain(revisionId);
    expect(auditJson).toContain('"range":true');
    expect(auditJson).not.toContain('publisher-secret-name.epub');
    expect(auditJson).not.toContain('private-original-with-secret-name');
  });

  it.each([
    ['cbz', 'application/vnd.comicbook+zip'],
    ['zip', 'application/zip']
  ] as const)('preserves an entitled comic original as %s', async (extension, mediaType) => {
    resolvePublicationAccess.mockResolvedValueOnce(accessDecision('entitled'));
    appendAuditEvent.mockResolvedValueOnce({ id: randomUUID() });
    const record = {
      title: { ...publicTitle, title: 'Comic Title', format: 'comic' as const },
      revision: {
        ...activeRevision,
        originalStorageKey: `titles/private-comic-${extension}`,
        originalMimeType: 'application/octet-stream',
        originalFilename: `source.${extension}`,
        originalChecksumSha256: checksum,
        originalByteSize: 100
      }
    };
    await expect(
      resolveCustomerOriginalDownload(
        databaseReturning([record]),
        storageWithSize(),
        customer,
        {
          titleId,
          correlationId: `comic-${extension}`,
          rangeRequested: false
        }
      )
    ).resolves.toMatchObject({
      access: {
        filename: `Comic Title.${extension}`,
        mediaType,
        disposition: 'attachment',
        cacheControl: 'private, no-store'
      }
    });
  });
});
