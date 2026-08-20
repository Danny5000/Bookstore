import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { AuditRequestMetadata } from '$lib/server/audit/request-metadata';
import type { Database } from '$lib/server/db/client';
import {
  revisionCoverSuggestions,
  revisionIngestionWarnings,
  revisionPresentations,
  titleRevisions,
  titles,
  type RevisionPresentationRow,
  type TitleRevisionRow
} from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { enqueueRevisionIngestion } from '$lib/server/ingestion/job';
import { parseStorageKey, stagingUploadKey } from '$lib/server/storage/keys';
import type { ObjectStorage } from '$lib/server/storage/types';
import { CatalogDomainError } from './errors';
import {
  parseRevisionPublicationActionInput,
  type RevisionPublicationActionInput
} from './input';
import { withLockedAdminTitle } from './lock';
import { toAdminTitleDto, type AdminTitleDto } from './titles';
import { insertTitleRevision } from './title-revision-insert';

const acceptRevisionUploadInputSchema = z.strictObject({
  titleId: z.uuid(),
  parentRevisionId: z.uuid().nullable(),
  changeSummary: z.string().trim().min(1).max(2_000),
  stagingStorageKey: z.string().transform(parseStorageKey),
  stagingChecksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  stagingByteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  uploadFilename: z.string().trim().min(1).max(255),
  uploadMimeType: z.string().trim().min(1).max(255)
});

export type AcceptRevisionUploadInput = z.input<typeof acceptRevisionUploadInputSchema>;

export interface AcceptRevisionUploadCommand {
  actor: Actor;
  correlationId: string;
  requestMetadata?: AuditRequestMetadata;
  input: AcceptRevisionUploadInput;
}

function formatAllowsFilename(format: 'prose' | 'comic', filename: string): boolean {
  const extension = extname(filename.replaceAll('\\', '/')).toLowerCase();
  return format === 'prose' ? extension === '.epub' : extension === '.cbz' || extension === '.zip';
}

export async function acceptRevisionUpload(
  database: Database,
  command: AcceptRevisionUploadCommand
): Promise<TitleRevisionRow> {
  requireCapability(command.actor, 'catalog.manage');
  const actor = command.actor;
  const input = acceptRevisionUploadInputSchema.parse(command.input);

  return withTransaction(database, async (transaction) => {
    const [title] = await transaction
      .select({ id: titles.id, format: titles.format })
      .from(titles)
      .where(eq(titles.id, input.titleId))
      .limit(1);
    if (!title) throw new CatalogDomainError('title_not_found');
    if (!formatAllowsFilename(title.format, input.uploadFilename)) {
      throw new CatalogDomainError('invalid_upload_format');
    }

    if (input.parentRevisionId) {
      const [parent] = await transaction
        .select({ id: titleRevisions.id })
        .from(titleRevisions)
        .where(
          and(
            eq(titleRevisions.id, input.parentRevisionId),
            eq(titleRevisions.titleId, input.titleId)
          )
        )
        .limit(1);
      if (!parent) throw new CatalogDomainError('parent_revision_not_in_title');
    }

    const revision = await insertTitleRevision(transaction, {
      titleId: input.titleId,
      parentRevisionId: input.parentRevisionId,
      createdByActorId: actor.id,
      changeSummary: input.changeSummary,
      stagingStorageKey: input.stagingStorageKey,
      stagingChecksumSha256: input.stagingChecksumSha256,
      stagingByteSize: input.stagingByteSize,
      uploadFilename: input.uploadFilename,
      uploadMimeType: input.uploadMimeType
    });
    if (!revision) throw new Error('Revision insert returned no row');

    await enqueueRevisionIngestion(transaction, revision.id, revision.ingestionGeneration);
    await appendAuditEvent(transaction, {
      actor,
      action: 'catalog.revision.upload',
      outcome: 'succeeded',
      resourceType: 'title_revision',
      resourceId: revision.id,
      correlationId: command.correlationId,
      ...(command.requestMetadata ? { requestMetadata: command.requestMetadata } : {}),
      after: {
        titleId: revision.titleId,
        parentRevisionId: revision.parentRevisionId,
        state: revision.state,
        generation: revision.ingestionGeneration,
        filename: revision.uploadFilename,
        mediaType: revision.uploadMimeType,
        byteSize: revision.stagingByteSize
      }
    });

    return revision;
  });
}

export interface AdminRevisionSummary {
  id: string;
  titleId: string;
  parentRevisionId: string | null;
  state: TitleRevisionRow['state'];
  changeSummary: string;
  ingestionGeneration: number;
  original: {
    filename: string;
    mediaType: string;
    byteSize: number;
    checksumSha256: string;
    downloadUrl: string;
  } | null;
  failure: { code: string; message: string } | null;
  retryAvailable: boolean;
  createdAt: Date;
  processingStartedAt: Date | null;
  processedAt: Date | null;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

export interface AdminRevisionStatus {
  state: TitleRevisionRow['state'];
  processingStartedAt: Date | null;
  processedAt: Date | null;
  failure: { code: string; message: string } | null;
  warnings: readonly { code: string; message: string }[];
}

export interface AdminRevisionReview {
  title: AdminTitleDto;
  revision: AdminRevisionSummary;
  draft: RevisionPresentationRow | null;
  published: RevisionPresentationRow | null;
  warnings: readonly { code: string; message: string }[];
  suggestion: {
    id: string;
    sourceDescription: string;
    url: string;
    checksumSha256: string;
    mediaType: string;
    byteSize: number;
    width: number;
    height: number;
  } | null;
}

function safeRevision(revision: TitleRevisionRow): AdminRevisionSummary {
  const original = revision.originalFilename && revision.originalMimeType &&
    revision.originalByteSize && revision.originalChecksumSha256
    ? {
        filename: revision.originalFilename,
        mediaType: revision.originalMimeType,
        byteSize: revision.originalByteSize,
        checksumSha256: revision.originalChecksumSha256,
        downloadUrl: `/admin/catalog/${revision.titleId}/revisions/${revision.id}/original`
      }
    : null;
  return {
    id: revision.id,
    titleId: revision.titleId,
    parentRevisionId: revision.parentRevisionId,
    state: revision.state,
    changeSummary: revision.changeSummary,
    ingestionGeneration: revision.ingestionGeneration,
    original,
    failure: revision.failureCode
      ? { code: revision.failureCode, message: revision.failureDetails ?? 'Processing failed' }
      : null,
    retryAvailable: revision.state === 'failed' && Boolean(
      revision.stagingStorageKey && revision.stagingChecksumSha256 && revision.stagingByteSize
    ),
    createdAt: revision.createdAt,
    processingStartedAt: revision.processingStartedAt,
    processedAt: revision.processedAt,
    activatedAt: revision.activatedAt,
    retiredAt: revision.retiredAt
  };
}

export async function listAdminRevisions(
  database: Database,
  titleId: string
): Promise<readonly AdminRevisionSummary[]> {
  const rows = await database
    .select()
    .from(titleRevisions)
    .where(eq(titleRevisions.titleId, titleId))
    .orderBy(desc(titleRevisions.createdAt), desc(titleRevisions.id));
  return rows.map(safeRevision);
}

async function warningDtos(database: Database, revisionId: string) {
  const warnings = await database
    .select({ code: revisionIngestionWarnings.code, message: revisionIngestionWarnings.safeMessage })
    .from(revisionIngestionWarnings)
    .where(eq(revisionIngestionWarnings.revisionId, revisionId))
    .orderBy(asc(revisionIngestionWarnings.ordinal));
  return warnings;
}

export async function getAdminRevisionStatus(
  database: Database,
  titleId: string,
  revisionId: string
): Promise<AdminRevisionStatus | null> {
  const [revision] = await database
    .select()
    .from(titleRevisions)
    .where(and(eq(titleRevisions.id, revisionId), eq(titleRevisions.titleId, titleId)))
    .limit(1);
  if (!revision) return null;
  const safe = safeRevision(revision);
  return {
    state: safe.state,
    processingStartedAt: safe.processingStartedAt,
    processedAt: safe.processedAt,
    failure: safe.failure,
    warnings: await warningDtos(database, revisionId)
  };
}

export async function getAdminRevisionReview(
  database: Database,
  titleId: string,
  revisionId: string
): Promise<AdminRevisionReview | null> {
  const [title] = await database.select().from(titles).where(eq(titles.id, titleId)).limit(1);
  if (!title) return null;
  const [revision] = await database
    .select()
    .from(titleRevisions)
    .where(and(eq(titleRevisions.id, revisionId), eq(titleRevisions.titleId, titleId)))
    .limit(1);
  if (!revision) return null;
  const presentations = await database
    .select()
    .from(revisionPresentations)
    .where(eq(revisionPresentations.revisionId, revisionId))
    .orderBy(desc(revisionPresentations.updatedAt));
  const [suggestion] = await database
    .select()
    .from(revisionCoverSuggestions)
    .where(eq(revisionCoverSuggestions.revisionId, revisionId))
    .limit(1);
  return {
    title: toAdminTitleDto(title),
    revision: safeRevision(revision),
    draft: presentations.find((presentation) => presentation.state === 'draft') ?? null,
    published: presentations.find((presentation) => presentation.state === 'published') ?? null,
    warnings: await warningDtos(database, revisionId),
    suggestion: suggestion
      ? {
          id: suggestion.id,
          sourceDescription: suggestion.sourceDescription,
          url: `/media/revisions/${revisionId}/cover-suggestion/${suggestion.id}/${suggestion.checksumSha256}`,
          checksumSha256: suggestion.checksumSha256,
          mediaType: suggestion.mediaType,
          byteSize: suggestion.byteSize,
          width: suggestion.width,
          height: suggestion.height
        }
      : null
  };
}

export async function retryFailedRevision(
  database: Database,
  storage: ObjectStorage,
  command: {
    actor: Actor;
    correlationId: string;
    requestMetadata?: AuditRequestMetadata;
    input: RevisionPublicationActionInput;
  }
): Promise<TitleRevisionRow> {
  requireCapability(command.actor, 'catalog.manage');
  const input = parseRevisionPublicationActionInput(command.input);
  const [sourceRevision] = await database
    .select()
    .from(titleRevisions)
    .where(and(eq(titleRevisions.id, input.revisionId), eq(titleRevisions.titleId, input.titleId)))
    .limit(1);
  if (
    !sourceRevision ||
    sourceRevision.state !== 'failed' ||
    !sourceRevision.stagingStorageKey ||
    !sourceRevision.stagingChecksumSha256 ||
    !sourceRevision.stagingByteSize
  ) {
    throw new CatalogDomainError('retry_source_unavailable');
  }
  const oldKey = parseStorageKey(sourceRevision.stagingStorageKey);
  const sourceStat = await storage.stat(oldKey);
  if (!sourceStat || sourceStat.byteSize !== sourceRevision.stagingByteSize) {
    throw new CatalogDomainError('retry_source_unavailable');
  }
  const freshKey = stagingUploadKey(randomUUID());
  const copied = await storage.copy(oldKey, freshKey);
  if (copied.byteSize !== sourceRevision.stagingByteSize) {
    throw new CatalogDomainError('retry_source_unavailable');
  }

  return withTransaction(database, (transaction) =>
    withLockedAdminTitle(transaction, command.actor, input.titleId, async ({ actor }) => {
      const [failed] = await transaction
        .select()
        .from(titleRevisions)
        .where(and(eq(titleRevisions.id, input.revisionId), eq(titleRevisions.titleId, input.titleId)))
        .for('update')
        .limit(1);
      if (
        !failed ||
        failed.state !== 'failed' ||
        failed.stagingStorageKey !== sourceRevision.stagingStorageKey ||
        failed.stagingChecksumSha256 !== sourceRevision.stagingChecksumSha256 ||
        failed.stagingByteSize !== sourceRevision.stagingByteSize
      ) {
        throw new CatalogDomainError('revision_conflict');
      }
      const nextGeneration = failed.ingestionGeneration + 1;
      const [retried] = await transaction
        .update(titleRevisions)
        .set({
          state: 'uploaded',
          stagingStorageKey: freshKey,
          ingestionGeneration: nextGeneration,
          processingStartedAt: null,
          processedAt: null,
          failureCode: null,
          failureDetails: null
        })
        .where(eq(titleRevisions.id, failed.id))
        .returning();
      if (!retried) throw new Error('Revision retry update returned no row');
      await enqueueRevisionIngestion(transaction, retried.id, nextGeneration);
      await appendAuditEvent(transaction, {
        actor,
        action: 'catalog.revision.retry',
        outcome: 'succeeded',
        resourceType: 'title_revision',
        resourceId: retried.id,
        correlationId: command.correlationId,
        ...(command.requestMetadata ? { requestMetadata: command.requestMetadata } : {}),
        after: {
          titleId: input.titleId,
          state: retried.state,
          generation: nextGeneration
        }
      });
      return retried;
    })
  );
}
