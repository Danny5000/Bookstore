import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import { getAdminRevisionReview, getAdminRevisionStatus, listAdminRevisions } from './revisions';

function databaseReturning(...results: unknown[][]): Database {
  return {
    select: vi.fn(() => {
      const value = results.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'where', 'orderBy', 'limit']) chain[method] = vi.fn(() => chain);
      chain.then = (resolve: (rows: unknown[]) => unknown, reject: (cause: unknown) => unknown) =>
        Promise.resolve(value).then(resolve, reject);
      return chain;
    })
  } as unknown as Database;
}

const titleId = randomUUID();
const revisionId = randomUUID();
const now = new Date('2026-08-09T12:00:00Z');
const revision = {
  id: revisionId,
  titleId,
  parentRevisionId: null,
  state: 'failed' as const,
  createdByActorId: randomUUID(),
  changeSummary: 'Corrected pages',
  stagingStorageKey: `staging/${randomUUID()}`,
  stagingChecksumSha256: 'a'.repeat(64),
  stagingByteSize: 42,
  uploadFilename: 'book.epub',
  uploadMimeType: 'application/epub+zip',
  ingestionGeneration: 1,
  derivationVersion: 1,
  originalStorageKey: null,
  originalChecksumSha256: null,
  originalMimeType: null,
  originalByteSize: null,
  originalFilename: null,
  failureCode: 'epub_content',
  failureDetails: 'The EPUB content is invalid',
  createdAt: now,
  processingStartedAt: now,
  processedAt: now,
  activatedAt: null,
  retiredAt: null
};

describe('administrator revision queries', () => {
  it('lists revisions without serializing storage pointers', async () => {
    const result = await listAdminRevisions(databaseReturning([revision]), titleId);
    expect(result).toEqual([expect.objectContaining({ id: revisionId, retryAvailable: true })]);
    expect(JSON.stringify(result)).not.toMatch(/stagingStorageKey|originalStorageKey|staging\//u);
  });

  it('returns safe status and warnings for a same-title revision', async () => {
    const result = await getAdminRevisionStatus(
      databaseReturning([revision], [{ code: 'image_animation', message: 'First frame used' }]),
      titleId,
      revisionId
    );
    expect(result).toEqual(expect.objectContaining({
      state: 'failed',
      failure: { code: 'epub_content', message: 'The EPUB content is invalid' },
      warnings: [{ code: 'image_animation', message: 'First frame used' }]
    }));
    expect(result).not.toHaveProperty('retryAvailable');
  });

  it('loads review context with a protected suggestion URL and no storage keys', async () => {
    const title = { id: titleId, format: 'prose', coverStorageKey: 'titles/private-cover' };
    const draft = { id: randomUUID(), state: 'draft', updatedAt: now };
    const suggestion = {
      id: randomUUID(), revisionId, storageKey: 'revisions/private-suggestion',
      sourceDescription: 'EPUB cover', mediaType: 'image/webp', checksumSha256: 'b'.repeat(64),
      byteSize: 100, width: 600, height: 900, createdAt: now
    };
    const result = await getAdminRevisionReview(
      databaseReturning([title], [revision], [draft], [suggestion], []),
      titleId,
      revisionId
    );
    expect(result).toMatchObject({ draft, suggestion: { id: suggestion.id } });
    expect(result?.suggestion?.url).toContain(suggestion.checksumSha256);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/storageKey|private-suggestion|staging\//u);
  });
});
