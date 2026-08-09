import { and, eq } from 'drizzle-orm';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import {
  comicPages,
  proseBlocks,
  proseImages,
  proseSections,
  revisionCoverSuggestions,
  revisionIngestionWarnings,
  revisionPresentations,
  titleRevisions,
  titles
} from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { PermanentJobError } from '$lib/server/jobs/runner';
import type { JobHandler, JobRecord } from '$lib/server/jobs/types';
import { revisionOriginalKey, parseStorageKey, type StorageKey } from '$lib/server/storage/keys';
import type { ObjectStorage } from '$lib/server/storage/types';
import { UploadError } from '$lib/server/uploads/multipart';
import { hashStoredObject } from '$lib/server/uploads/stream-object';
import { ingestComic, type ComicIngestionResult } from './comic';
import { ingestEpub, type EpubIngestionResult } from './epub';
import { IngestionError } from './errors';
import { parseRevisionIngestionPayload } from './job';
import type { IngestionLimits } from './limits';

const systemActor = { type: 'system', id: 'publication-ingestion-worker' } as const;
type CandidateFormat = 'prose' | 'comic';
type FailurePhase = 'storage' | 'ingestion' | 'database';

interface ProcessingCandidate {
  id: string;
  titleId: string;
  format: CandidateFormat;
  generation: number;
  stagingStorageKey: StorageKey;
  stagingChecksumSha256: string;
  stagingByteSize: number;
  uploadFilename: string;
  uploadMimeType: string;
}

type IngestionResult =
  | { format: 'prose'; value: EpubIngestionResult }
  | { format: 'comic'; value: ComicIngestionResult };

function failureFrom(cause: unknown, phase: FailurePhase, signal: AbortSignal, timeout: AbortSignal): IngestionError {
  if (cause instanceof IngestionError) return cause;
  if (timeout.aborted) {
    return new IngestionError('ingestion_timeout', 'Ingestion exceeded the time limit', true);
  }
  if (signal.aborted) {
    return new IngestionError('ingestion_aborted', 'Ingestion was aborted', true);
  }
  if (cause instanceof UploadError && cause.code === 'file_size_limit') {
    return new IngestionError('upload_limit', 'Uploaded file exceeds the size limit', false);
  }
  if (phase === 'storage' || cause instanceof UploadError) {
    return new IngestionError('storage_transient', 'Publication storage is temporarily unavailable', true);
  }
  if (phase === 'database') {
    return new IngestionError('database_transient', 'Publication database update failed', true);
  }
  return new IngestionError('storage_transient', 'Publication ingestion failed temporarily', true);
}

async function beginProcessing(
  database: Database,
  revisionId: string,
  generation: number
): Promise<ProcessingCandidate | null> {
  return withTransaction(database, async (transaction) => {
    const [record] = await transaction
      .select({ revision: titleRevisions, format: titles.format })
      .from(titleRevisions)
      .innerJoin(titles, eq(titles.id, titleRevisions.titleId))
      .where(eq(titleRevisions.id, revisionId))
      .for('update')
      .limit(1);
    if (!record) throw new PermanentJobError('Revision ingestion target does not exist');
    const revision = record.revision;
    if (
      revision.ingestionGeneration !== generation ||
      ['ready_for_review', 'active', 'retired'].includes(revision.state)
    ) {
      return null;
    }
    if (!['uploaded', 'processing', 'failed'].includes(revision.state)) return null;
    if (
      !revision.stagingStorageKey ||
      !revision.stagingChecksumSha256 ||
      !revision.stagingByteSize ||
      !revision.uploadFilename ||
      !revision.uploadMimeType
    ) {
      throw new PermanentJobError('Revision staging metadata is incomplete');
    }

    await transaction
      .update(titleRevisions)
      .set({
        state: 'processing',
        processingStartedAt: revision.processingStartedAt ?? new Date(),
        processedAt: null,
        failureCode: null,
        failureDetails: null
      })
      .where(eq(titleRevisions.id, revision.id));

    return {
      id: revision.id,
      titleId: revision.titleId,
      format: record.format,
      generation,
      stagingStorageKey: parseStorageKey(revision.stagingStorageKey),
      stagingChecksumSha256: revision.stagingChecksumSha256,
      stagingByteSize: revision.stagingByteSize,
      uploadFilename: revision.uploadFilename,
      uploadMimeType: revision.uploadMimeType
    };
  });
}

async function deleteCandidateRows(database: Parameters<Parameters<Database['transaction']>[0]>[0], revisionId: string): Promise<void> {
  await database.delete(comicPages).where(eq(comicPages.revisionId, revisionId));
  await database.delete(proseBlocks).where(eq(proseBlocks.revisionId, revisionId));
  await database.delete(proseImages).where(eq(proseImages.revisionId, revisionId));
  await database.delete(proseSections).where(eq(proseSections.revisionId, revisionId));
  await database.delete(revisionCoverSuggestions).where(eq(revisionCoverSuggestions.revisionId, revisionId));
  await database.delete(revisionIngestionWarnings).where(eq(revisionIngestionWarnings.revisionId, revisionId));
  await database.delete(revisionPresentations).where(eq(revisionPresentations.revisionId, revisionId));
}

async function commitIngestion(
  database: Database,
  candidate: ProcessingCandidate,
  originalKey: StorageKey,
  result: IngestionResult,
  job: JobRecord
): Promise<boolean> {
  return withTransaction(database, async (transaction) => {
    const [current] = await transaction
      .select({ state: titleRevisions.state, generation: titleRevisions.ingestionGeneration })
      .from(titleRevisions)
      .where(eq(titleRevisions.id, candidate.id))
      .for('update')
      .limit(1);
    if (
      !current ||
      current.generation !== candidate.generation ||
      current.state !== 'processing'
    ) {
      return false;
    }

    await deleteCandidateRows(transaction, candidate.id);
    let previewProseSectionId: string | null = null;
    let previewProseBlockId: string | null = null;
    let previewComicPageId: string | null = null;
    let cover: EpubIngestionResult['coverSuggestion'] | ComicIngestionResult['coverSuggestion'];
    let warnings: EpubIngestionResult['warnings'] | ComicIngestionResult['warnings'];

    if (result.format === 'prose') {
      const value = result.value;
      if (value.sections.length > 0) {
        await transaction.insert(proseSections).values(
          value.sections.map((section) => ({
            id: section.id,
            revisionId: candidate.id,
            ordinal: section.ordinal,
            label: section.label,
            sourceReference: section.sourceReference
          }))
        );
      }
      if (value.images.length > 0) {
        await transaction.insert(proseImages).values(
          value.images.map((image) => ({
            id: image.id,
            revisionId: candidate.id,
            storageKey: image.storageKey,
            mediaType: image.mediaType,
            checksumSha256: image.checksumSha256,
            byteSize: image.byteSize,
            width: image.width,
            height: image.height,
            altText: image.altText
          }))
        );
      }
      const blocks = value.sections.flatMap((section) =>
        section.blocks.map((block) => ({
          id: block.id,
          revisionId: candidate.id,
          sectionId: section.id,
          ordinal: block.ordinal,
          kind: block.kind,
          content: block.content,
          imageId: block.imageId
        }))
      );
      if (blocks.length > 0) await transaction.insert(proseBlocks).values(blocks);
      if (value.sections.length > 1) {
        const first = value.sections[0];
        const lastBlock = first?.blocks.at(-1);
        if (first && lastBlock) {
          previewProseSectionId = first.id;
          previewProseBlockId = lastBlock.id;
        }
      }
      cover = value.coverSuggestion;
      warnings = value.warnings;
    } else {
      const value = result.value;
      if (value.pages.length > 0) {
        await transaction.insert(comicPages).values(
          value.pages.map((page) => ({
            id: page.id,
            revisionId: candidate.id,
            ordinal: page.ordinal,
            sourcePath: page.sourcePath,
            storageKey: page.storageKey,
            mediaType: page.mediaType,
            checksumSha256: page.checksumSha256,
            byteSize: page.byteSize,
            width: page.width,
            height: page.height
          }))
        );
      }
      if (value.pages.length >= 2) {
        const previewOrdinal = Math.min(3, value.pages.length - 1);
        previewComicPageId = value.pages.find((page) => page.ordinal === previewOrdinal)?.id ?? null;
      }
      cover = value.coverSuggestion;
      warnings = value.warnings;
    }

    if (cover) {
      await transaction.insert(revisionCoverSuggestions).values({
        id: cover.id,
        revisionId: candidate.id,
        storageKey: cover.storageKey,
        sourceDescription: cover.sourceDescription,
        mediaType: cover.mediaType,
        checksumSha256: cover.checksumSha256,
        byteSize: cover.byteSize,
        width: cover.width,
        height: cover.height
      });
    }
    if (warnings.length > 0) {
      await transaction.insert(revisionIngestionWarnings).values(
        warnings.map((warning, ordinal) => ({
          revisionId: candidate.id,
          ordinal,
          code: warning.code,
          safeMessage: warning.safeMessage
        }))
      );
    }
    await transaction.insert(revisionPresentations).values({
      revisionId: candidate.id,
      state: 'draft',
      previewProseSectionId,
      previewProseBlockId,
      previewComicPageId
    });

    const processedAt = new Date();
    await transaction
      .update(titleRevisions)
      .set({
        state: 'ready_for_review',
        originalStorageKey: originalKey,
        originalChecksumSha256: candidate.stagingChecksumSha256,
        originalMimeType:
          candidate.format === 'prose'
            ? 'application/epub+zip'
            : 'application/vnd.comicbook+zip',
        originalByteSize: candidate.stagingByteSize,
        originalFilename: candidate.uploadFilename,
        stagingStorageKey: null,
        stagingChecksumSha256: null,
        stagingByteSize: null,
        failureCode: null,
        failureDetails: null,
        processedAt
      })
      .where(
        and(
          eq(titleRevisions.id, candidate.id),
          eq(titleRevisions.ingestionGeneration, candidate.generation),
          eq(titleRevisions.state, 'processing')
        )
      );
    await appendAuditEvent(transaction, {
      actor: systemActor,
      action: 'catalog.revision.ingest.succeeded',
      outcome: 'succeeded',
      resourceType: 'title_revision',
      resourceId: candidate.id,
      correlationId: `job:${job.id}`,
      after: {
        state: 'ready_for_review',
        generation: candidate.generation,
        format: candidate.format,
        warningCount: warnings.length
      }
    });
    return true;
  });
}

async function markFailed(
  database: Database,
  candidate: ProcessingCandidate,
  failure: IngestionError,
  job: JobRecord
): Promise<void> {
  await withTransaction(database, async (transaction) => {
    const [current] = await transaction
      .select({ state: titleRevisions.state, generation: titleRevisions.ingestionGeneration })
      .from(titleRevisions)
      .where(eq(titleRevisions.id, candidate.id))
      .for('update')
      .limit(1);
    if (
      !current ||
      current.generation !== candidate.generation ||
      !['uploaded', 'processing', 'failed'].includes(current.state)
    ) return;

    await transaction
      .update(titleRevisions)
      .set({
        state: 'failed',
        failureCode: failure.code,
        failureDetails: failure.safeMessage.slice(0, 1_000),
        processedAt: new Date()
      })
      .where(eq(titleRevisions.id, candidate.id));
    await appendAuditEvent(transaction, {
      actor: systemActor,
      action: 'catalog.revision.ingest.failed',
      outcome: 'failed',
      resourceType: 'title_revision',
      resourceId: candidate.id,
      correlationId: `job:${job.id}`,
      after: { state: 'failed', generation: candidate.generation, code: failure.code }
    });
  });
}

export function createRevisionIngestionHandler(
  database: Database,
  storage: ObjectStorage,
  limits: IngestionLimits
): JobHandler {
  return async (job, workerSignal) => {
    let payload;
    try {
      payload = parseRevisionIngestionPayload(job.payload);
    } catch {
      throw new PermanentJobError('Invalid revision ingestion payload');
    }
    const candidate = await beginProcessing(database, payload.revisionId, payload.generation);
    if (!candidate) return;

    const timeoutSignal = AbortSignal.timeout(limits.timeoutMs);
    const signal = AbortSignal.any([workerSignal, timeoutSignal]);
    const originalKey = revisionOriginalKey(candidate.titleId, candidate.id);
    let phase: FailurePhase = 'storage';

    try {
      await storage.copy(candidate.stagingStorageKey, originalKey);
      const verified = await hashStoredObject(storage, originalKey, limits.maxUploadBytes, signal);
      if (
        verified.byteSize !== candidate.stagingByteSize ||
        verified.checksumSha256 !== candidate.stagingChecksumSha256
      ) {
        throw new IngestionError(
          'storage_transient',
          'Stored original did not pass integrity verification',
          true
        );
      }

      phase = 'ingestion';
      const result: IngestionResult = candidate.format === 'prose'
        ? {
            format: 'prose',
            value: await ingestEpub({
              storage,
              sourceKey: originalKey,
              titleId: candidate.titleId,
              revisionId: candidate.id,
              limits,
              signal
            })
          }
        : {
            format: 'comic',
            value: await ingestComic({
              storage,
              sourceKey: originalKey,
              titleId: candidate.titleId,
              revisionId: candidate.id,
              limits,
              signal
            })
          };

      phase = 'database';
      const committed = await commitIngestion(database, candidate, originalKey, result, job);
      if (!committed) return;
      await storage.delete(candidate.stagingStorageKey).catch(() => {
        console.warn('[ingestion] committed revision left staged object for maintenance cleanup');
      });
    } catch (cause: unknown) {
      const failure = failureFrom(cause, phase, workerSignal, timeoutSignal);
      const terminal = !failure.retryable || job.attempts >= job.maxAttempts;
      if (terminal) await markFailed(database, candidate, failure, job);
      if (!failure.retryable) throw new PermanentJobError(failure.safeMessage);
      throw failure;
    }
  };
}
