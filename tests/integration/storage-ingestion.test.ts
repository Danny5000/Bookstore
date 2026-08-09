import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, asc, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { CatalogDomainError } from '$lib/server/catalog/errors';
import { acceptRevisionUpload } from '$lib/server/catalog/revisions';
import { createPrivateTitle, createRevisionSkeleton } from '$lib/server/catalog/service';
import {
  auditEvents,
  comicPages,
  jobs,
  proseBlocks,
  proseImages,
  proseSections,
  revisionCoverSuggestions,
  revisionIngestionWarnings,
  revisionPresentations,
  titleRevisions,
  titles
} from '$lib/server/db/schema';
import { createRevisionIngestionHandler } from '$lib/server/ingestion/handler';
import { INGEST_REVISION_JOB } from '$lib/server/ingestion/job';
import type { IngestionLimits } from '$lib/server/ingestion/limits';
import { PermanentJobError } from '$lib/server/jobs/runner';
import type { JobRecord } from '$lib/server/jobs/types';
import { parseStorageKey, stagingUploadKey } from '$lib/server/storage/keys';
import { createLocalObjectStorage } from '$lib/server/storage/local';
import type { ObjectStorage } from '$lib/server/storage/types';
import { validComicFixture, validEpubFixture } from '../fixtures/publications';
import { databaseClient } from './database';

const admin: Actor = { type: 'user', id: 'admin-1', roles: ['admin'] };
const customer: Actor = { type: 'user', id: 'customer-1', roles: ['customer'] };
const checksum = 'a'.repeat(64);
const storage = createLocalObjectStorage(process.env.STORAGE_LOCAL_ROOT!);
const ingestionLimits: IngestionLimits = {
  maxUploadBytes: 10 * 1024 * 1024,
  maxExpandedBytes: 50 * 1024 * 1024,
  maxEntries: 1_000,
  maxXmlBytes: 1024 * 1024,
  maxImagePixels: 10_000_000,
  maxCompressionRatio: 1_000,
  timeoutMs: 30_000
};

async function createTitle(format: 'prose' | 'comic', slug = `${format}-upload`) {
  return createPrivateTitle(databaseClient.db, {
    actor: admin,
    correlationId: `create-${slug}`,
    input: {
      slug,
      title: `A ${format} title`,
      subtitle: null,
      description: 'A private title awaiting content.',
      creatorName: 'Pale Orbit',
      format,
      priceMinor: 1299,
      currency: 'USD'
    }
  });
}

function uploadInput(titleId: string, filename = 'book.epub') {
  return {
    titleId,
    parentRevisionId: null,
    changeSummary: 'Initial manuscript',
    stagingStorageKey: parseStorageKey('staging/uploads/018f0000-0000-7000-8000-000000000001'),
    stagingChecksumSha256: checksum,
    stagingByteSize: 123,
    uploadFilename: filename,
    uploadMimeType: 'application/octet-stream'
  };
}

async function collectStream(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function stageAcceptedRevision(
  format: 'prose' | 'comic',
  bytes: Buffer,
  filename: string,
  slug = `handler-${format}-${randomUUID()}`
) {
  const title = await createTitle(format, slug);
  const stagingKey = stagingUploadKey(randomUUID());
  await storage.write(stagingKey, Readable.from(bytes), { maxBytes: ingestionLimits.maxUploadBytes });
  const revision = await acceptRevisionUpload(databaseClient.db, {
    actor: admin,
    correlationId: `accept-${slug}`,
    input: {
      ...uploadInput(title.id, filename),
      stagingStorageKey: stagingKey,
      stagingChecksumSha256: createHash('sha256').update(bytes).digest('hex'),
      stagingByteSize: bytes.byteLength
    }
  });
  const [queued] = await databaseClient.db
    .select()
    .from(jobs)
    .where(eq(jobs.deduplicationKey, `catalog.ingest:${revision.id}:0`));
  if (!queued) throw new Error('Expected ingestion job');
  const job: JobRecord = {
    id: queued.id,
    type: queued.type,
    payload: queued.payload,
    attempts: 1,
    maxAttempts: queued.maxAttempts,
    lockedBy: 'integration-worker:0'
  };
  return { title, revision, job, stagingKey };
}

function storageFailingCopy(): ObjectStorage {
  return new Proxy(storage, {
    get(target, property) {
      if (property === 'copy') return async () => { throw new Error('storage unavailable'); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

describe('revision upload acceptance', () => {
  it('atomically creates an uploaded revision, ingestion job, and safe audit event', async () => {
    const title = await createTitle('prose');

    const revision = await acceptRevisionUpload(databaseClient.db, {
      actor: admin,
      correlationId: 'accept-upload',
      requestMetadata: { method: 'POST', routeId: '/admin/catalog/[titleId]/revisions/upload' },
      input: uploadInput(title.id)
    });

    expect(revision).toMatchObject({
      titleId: title.id,
      state: 'uploaded',
      ingestionGeneration: 0,
      stagingChecksumSha256: checksum,
      stagingByteSize: 123
    });
    const [job] = await databaseClient.db
      .select()
      .from(jobs)
      .where(eq(jobs.type, INGEST_REVISION_JOB));
    expect(job).toMatchObject({
      status: 'pending',
      payload: { revisionId: revision.id, generation: 0 },
      deduplicationKey: `catalog.ingest:${revision.id}:0`,
      maxAttempts: 5
    });
    const [event] = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'catalog.revision.upload'));
    expect(event).toMatchObject({
      actorId: admin.id,
      resourceId: revision.id,
      outcome: 'succeeded',
      requestMetadata: { method: 'POST', routeId: '/admin/catalog/[titleId]/revisions/upload' }
    });
    expect(JSON.stringify(event)).not.toContain('staging/uploads');
  });

  it('authorizes before writing and enforces the title upload extension', async () => {
    const prose = await createTitle('prose');
    const comic = await createTitle('comic');

    await expect(
      acceptRevisionUpload(databaseClient.db, {
        actor: customer,
        correlationId: 'customer-upload',
        input: uploadInput(prose.id)
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      acceptRevisionUpload(databaseClient.db, {
        actor: admin,
        correlationId: 'bad-prose-extension',
        input: uploadInput(prose.id, 'book.zip')
      })
    ).rejects.toEqual(new CatalogDomainError('invalid_upload_format'));
    await expect(
      acceptRevisionUpload(databaseClient.db, {
        actor: admin,
        correlationId: 'bad-comic-extension',
        input: uploadInput(comic.id, 'book.epub')
      })
    ).rejects.toEqual(new CatalogDomainError('invalid_upload_format'));

    const [result] = await databaseClient.db.select({ value: count() }).from(titleRevisions);
    expect(result?.value).toBe(0);
  });

  it('requires the parent revision to belong to the same title', async () => {
    const first = await createTitle('prose', 'first-parent-title');
    const second = await createTitle('prose', 'second-parent-title');
    const parent = await createRevisionSkeleton(databaseClient.db, {
      actor: admin,
      correlationId: 'create-parent',
      input: { titleId: first.id, parentRevisionId: null, changeSummary: 'Parent' }
    });

    await expect(
      acceptRevisionUpload(databaseClient.db, {
        actor: admin,
        correlationId: 'wrong-parent',
        input: { ...uploadInput(second.id), parentRevisionId: parent.id }
      })
    ).rejects.toEqual(new CatalogDomainError('parent_revision_not_in_title'));

    const revisions = await databaseClient.db.select().from(titleRevisions);
    expect(revisions).toHaveLength(1);
  });

  it.each(['jobs', 'audit_events'] as const)(
    'rolls back the revision when the %s write fails',
    async (table) => {
      const title = await createTitle('prose', `rollback-${table.replace('_', '-')}`);
      const functionName = `reject_plan4_${table}`;
      const triggerName = `reject_plan4_${table}_trigger`;
      await databaseClient.pool.query(`
        create function ${functionName}() returns trigger language plpgsql as $$
        begin raise exception 'forced ${table} failure'; end $$;
        create trigger ${triggerName} before insert on ${table}
        for each row execute function ${functionName}();
      `);

      try {
        await expect(
          acceptRevisionUpload(databaseClient.db, {
            actor: admin,
            correlationId: `rollback-${table}`,
            input: uploadInput(title.id)
          })
        ).rejects.toThrow();
      } finally {
        await databaseClient.pool.query(`drop trigger ${triggerName} on ${table}`);
        await databaseClient.pool.query(`drop function ${functionName}()`);
      }

      const [revisionCount] = await databaseClient.db
        .select({ value: count() })
        .from(titleRevisions);
      const [jobCount] = await databaseClient.db.select({ value: count() }).from(jobs);
      const [uploadAuditCount] = await databaseClient.db
        .select({ value: count() })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'catalog.revision.upload'),
            eq(auditEvents.correlationId, `rollback-${table}`)
          )
        );
      expect(revisionCount?.value).toBe(0);
      expect(jobCount?.value).toBe(0);
      expect(uploadAuditCount?.value).toBe(0);
    }
  );
});

describe('revision ingestion handler', () => {
  it.each([
    ['prose', validEpubFixture(), 'book.epub'],
    ['comic', validComicFixture(), 'book.cbz']
  ] as const)('ingests a valid %s candidate for review without publishing it', async (format, bytes, filename) => {
    const candidate = await stageAcceptedRevision(format, bytes, filename);
    const handler = createRevisionIngestionHandler(databaseClient.db, storage, ingestionLimits);

    await handler(candidate.job, new AbortController().signal);

    const [revision] = await databaseClient.db
      .select()
      .from(titleRevisions)
      .where(eq(titleRevisions.id, candidate.revision.id));
    expect(revision).toMatchObject({
      state: 'ready_for_review',
      stagingStorageKey: null,
      stagingChecksumSha256: null,
      stagingByteSize: null,
      originalChecksumSha256: createHash('sha256').update(bytes).digest('hex'),
      originalByteSize: bytes.byteLength
    });
    expect(revision?.originalStorageKey).toBeTruthy();
    expect(await collectStream(await storage.read(parseStorageKey(revision!.originalStorageKey!)))).toEqual(bytes);
    expect(await storage.stat(candidate.stagingKey)).toBeNull();

    const [persistedTitle] = await databaseClient.db.select().from(titles).where(eq(titles.id, candidate.title.id));
    expect(persistedTitle).toMatchObject({ visibility: 'private', activeRevisionId: null });
    const [presentation] = await databaseClient.db
      .select()
      .from(revisionPresentations)
      .where(eq(revisionPresentations.revisionId, candidate.revision.id));
    expect(presentation?.state).toBe('draft');

    if (format === 'prose') {
      const sections = await databaseClient.db
        .select()
        .from(proseSections)
        .where(eq(proseSections.revisionId, candidate.revision.id))
        .orderBy(asc(proseSections.ordinal));
      const blocks = await databaseClient.db
        .select()
        .from(proseBlocks)
        .where(eq(proseBlocks.revisionId, candidate.revision.id));
      const images = await databaseClient.db
        .select()
        .from(proseImages)
        .where(eq(proseImages.revisionId, candidate.revision.id));
      expect(sections).toHaveLength(2);
      expect(blocks.length).toBeGreaterThan(0);
      expect(images).toHaveLength(1);
      expect(presentation?.previewProseSectionId).toBe(sections[0]?.id);
      const firstSectionBlocks = blocks.filter((block) => block.sectionId === sections[0]?.id);
      expect(presentation?.previewProseBlockId).toBe(
        firstSectionBlocks.sort((left, right) => right.ordinal - left.ordinal)[0]?.id
      );
    } else {
      const pages = await databaseClient.db
        .select()
        .from(comicPages)
        .where(eq(comicPages.revisionId, candidate.revision.id))
        .orderBy(asc(comicPages.ordinal));
      expect(pages).toHaveLength(3);
      expect(presentation?.previewComicPageId).toBe(pages[1]?.id);
    }
    const covers = await databaseClient.db
      .select()
      .from(revisionCoverSuggestions)
      .where(eq(revisionCoverSuggestions.revisionId, candidate.revision.id));
    expect(covers).toHaveLength(1);
    await databaseClient.db
      .select()
      .from(revisionIngestionWarnings)
      .where(eq(revisionIngestionWarnings.revisionId, candidate.revision.id));
  });

  it('retries deterministically after a pre-commit database failure without duplicate rows', async () => {
    const candidate = await stageAcceptedRevision('comic', validComicFixture(), 'retry.cbz');
    const handler = createRevisionIngestionHandler(databaseClient.db, storage, ingestionLimits);
    await databaseClient.pool.query(`
      create function reject_plan4_ready_revision() returns trigger language plpgsql as $$
      begin
        if new.state = 'ready_for_review' then raise exception 'forced pre-commit failure'; end if;
        return new;
      end $$;
      create trigger reject_plan4_ready_revision_trigger before update on title_revisions
      for each row execute function reject_plan4_ready_revision();
    `);
    try {
      await expect(handler(candidate.job, new AbortController().signal)).rejects.toThrow();
    } finally {
      await databaseClient.pool.query('drop trigger reject_plan4_ready_revision_trigger on title_revisions');
      await databaseClient.pool.query('drop function reject_plan4_ready_revision()');
    }

    await handler({ ...candidate.job, attempts: 2 }, new AbortController().signal);
    const pages = await databaseClient.db
      .select()
      .from(comicPages)
      .where(eq(comicPages.revisionId, candidate.revision.id));
    const covers = await databaseClient.db
      .select()
      .from(revisionCoverSuggestions)
      .where(eq(revisionCoverSuggestions.revisionId, candidate.revision.id));
    const presentations = await databaseClient.db
      .select()
      .from(revisionPresentations)
      .where(eq(revisionPresentations.revisionId, candidate.revision.id));
    expect(pages).toHaveLength(3);
    expect(covers).toHaveLength(1);
    expect(presentations).toHaveLength(1);
  });

  it('treats a stale generation as a successful no-op', async () => {
    const candidate = await stageAcceptedRevision('prose', validEpubFixture(), 'stale.epub');
    const handler = createRevisionIngestionHandler(databaseClient.db, storage, ingestionLimits);

    await handler(
      { ...candidate.job, payload: { revisionId: candidate.revision.id, generation: 1 } },
      new AbortController().signal
    );

    const [revision] = await databaseClient.db
      .select()
      .from(titleRevisions)
      .where(eq(titleRevisions.id, candidate.revision.id));
    expect(revision?.state).toBe('uploaded');
    expect(await databaseClient.db.select().from(proseSections)).toHaveLength(0);
  });

  it('marks a permanent validation error failed with only safe details', async () => {
    const bytes = Buffer.from('not an archive');
    const candidate = await stageAcceptedRevision('prose', bytes, 'broken.epub');
    const handler = createRevisionIngestionHandler(databaseClient.db, storage, ingestionLimits);

    await expect(handler(candidate.job, new AbortController().signal)).rejects.toBeInstanceOf(PermanentJobError);
    const [revision] = await databaseClient.db
      .select()
      .from(titleRevisions)
      .where(eq(titleRevisions.id, candidate.revision.id));
    expect(revision).toMatchObject({ state: 'failed', failureCode: 'archive_structure' });
    expect(revision?.failureDetails).not.toContain('staging/uploads');
    const [event] = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'catalog.revision.ingest.failed'));
    expect(JSON.stringify(event)).not.toContain('staging/uploads');
  });

  it('leaves a transient candidate processing before the final attempt and fails it on the final attempt', async () => {
    const first = await stageAcceptedRevision('comic', validComicFixture(), 'transient.cbz', 'transient-first');
    const final = await stageAcceptedRevision('comic', validComicFixture(), 'final.cbz', 'transient-final');
    const handler = createRevisionIngestionHandler(databaseClient.db, storageFailingCopy(), ingestionLimits);

    await expect(handler(first.job, new AbortController().signal)).rejects.toThrow();
    await expect(
      handler({ ...final.job, attempts: final.job.maxAttempts }, new AbortController().signal)
    ).rejects.toThrow();

    const revisions = await databaseClient.db
      .select()
      .from(titleRevisions)
      .where(
        and(
          eq(titleRevisions.ingestionGeneration, 0),
          eq(titleRevisions.titleId, first.title.id)
        )
      );
    const [finalRevision] = await databaseClient.db
      .select()
      .from(titleRevisions)
      .where(eq(titleRevisions.id, final.revision.id));
    expect(revisions[0]?.state).toBe('processing');
    expect(finalRevision).toMatchObject({ state: 'failed', failureCode: 'storage_transient' });
  });
});
