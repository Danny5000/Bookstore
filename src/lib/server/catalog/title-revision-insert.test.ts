import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { TitleRevisionRow } from '$lib/server/db/schema';
import { insertTitleRevision, titleRevisionInsertQuery } from './title-revision-insert';

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
}

describe('title revision insert authority', () => {
  it('targets only the nine runtime-granted revision columns', () => {
    const query = rendered(titleRevisionInsertQuery({
      titleId: '00000000-0000-4000-8000-000000000001',
      parentRevisionId: null,
      createdByActorId: 'admin:00000000-0000-4000-8000-000000000002',
      changeSummary: 'Upload revision',
      stagingStorageKey: 'staging/00000000-0000-4000-8000-000000000003/book.epub',
      stagingChecksumSha256: 'a'.repeat(64),
      stagingByteSize: 42,
      uploadFilename: 'book.epub',
      uploadMimeType: 'application/epub+zip'
    }));
    const normalized = query.sql.replace(/\s+/gu, ' ').trim();
    expect(normalized).toMatch(
      /^insert into "public"\."title_revisions" \(\s*"title_id", "parent_revision_id", "created_by_actor_id", "change_summary", "staging_storage_key", "staging_checksum_sha256", "staging_byte_size", "upload_filename", "upload_mime_type"\s*\) values /u
    );
    expect(normalized.slice(0, normalized.indexOf(' values '))).not.toMatch(
      /"(?:id|state|ingestion_generation|derivation_version|original_storage_key|original_checksum_sha256|original_mime_type|original_byte_size|original_filename|failure_code|failure_details|created_at|processing_started_at|processed_at|activated_at|retired_at)"/u
    );
    expect(normalized).toMatch(/returning "id"$/u);
    expect(query.params).toHaveLength(9);
  });

  it('hydrates the revision through a schema-aware SELECT before returning dates and bigints', async () => {
    const createdAt = new Date('2026-08-15T12:00:00.000Z');
    const revision: TitleRevisionRow = {
      id: '00000000-0000-4000-8000-000000000001',
      titleId: '00000000-0000-4000-8000-000000000002',
      parentRevisionId: null,
      state: 'uploaded',
      createdByActorId: 'admin:00000000-0000-4000-8000-000000000003',
      changeSummary: 'Upload revision',
      stagingStorageKey: 'staging/book.epub',
      stagingChecksumSha256: 'a'.repeat(64),
      stagingByteSize: 42,
      uploadFilename: 'book.epub',
      uploadMimeType: 'application/epub+zip',
      ingestionGeneration: 0,
      derivationVersion: 1,
      originalStorageKey: null,
      originalChecksumSha256: null,
      originalMimeType: null,
      originalByteSize: null,
      originalFilename: null,
      failureCode: null,
      failureDetails: null,
      createdAt,
      processingStartedAt: null,
      processedAt: null,
      activatedAt: null,
      retiredAt: null
    };
    const execute = vi.fn(async () => ({ rows: [{ id: revision.id }] }));
    const select = vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: async () => [revision] })
      })
    }));

    const inserted = await insertTitleRevision({ execute, select } as never, {
      titleId: revision.titleId,
      parentRevisionId: null,
      createdByActorId: revision.createdByActorId,
      changeSummary: revision.changeSummary,
      stagingStorageKey: revision.stagingStorageKey,
      stagingChecksumSha256: revision.stagingChecksumSha256,
      stagingByteSize: revision.stagingByteSize,
      uploadFilename: revision.uploadFilename,
      uploadMimeType: revision.uploadMimeType
    });

    expect(inserted).toEqual(revision);
    expect(inserted?.createdAt).toBeInstanceOf(Date);
    expect(inserted?.processingStartedAt).toBeNull();
    expect(inserted?.stagingByteSize).toBe(42);
    expect(select).toHaveBeenCalledOnce();
  });
});
