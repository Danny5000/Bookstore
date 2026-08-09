import { extname } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { AuditRequestMetadata } from '$lib/server/audit/request-metadata';
import type { Database } from '$lib/server/db/client';
import { titleRevisions, titles, type TitleRevisionRow } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { enqueueRevisionIngestion } from '$lib/server/ingestion/job';
import { parseStorageKey } from '$lib/server/storage/keys';
import { CatalogDomainError } from './errors';

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

    const [revision] = await transaction
      .insert(titleRevisions)
      .values({
        titleId: input.titleId,
        parentRevisionId: input.parentRevisionId,
        state: 'uploaded',
        createdByActorId: actor.id,
        changeSummary: input.changeSummary,
        stagingStorageKey: input.stagingStorageKey,
        stagingChecksumSha256: input.stagingChecksumSha256,
        stagingByteSize: input.stagingByteSize,
        uploadFilename: input.uploadFilename,
        uploadMimeType: input.uploadMimeType,
        ingestionGeneration: 0
      })
      .returning();
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
