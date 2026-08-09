import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import { revisionCoverSuggestions, titleRevisions, titles } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { normalizeImage } from '$lib/server/ingestion/image';
import type { IngestionLimits } from '$lib/server/ingestion/limits';
import { parseStorageKey, titleCoverKey } from '$lib/server/storage/keys';
import type { ObjectStorage } from '$lib/server/storage/types';
import { CatalogDomainError } from './errors';
import {
  parseConfirmCoverSuggestionInput,
  type ConfirmCoverSuggestionInput
} from './input';

interface CoverCommand<T> {
  actor: Actor;
  correlationId: string;
  input: T;
}

interface CoverResult {
  titleId: string;
  checksumSha256: string;
}

async function titleExists(database: Database, titleId: string): Promise<void> {
  const [title] = await database.select({ id: titles.id }).from(titles).where(eq(titles.id, titleId)).limit(1);
  if (!title) throw new CatalogDomainError('title_not_found');
}

export async function confirmCoverSuggestion(
  database: Database,
  storage: ObjectStorage,
  command: CoverCommand<ConfirmCoverSuggestionInput>
): Promise<CoverResult> {
  requireCapability(command.actor, 'catalog.manage');
  const actor = command.actor;
  const input = parseConfirmCoverSuggestionInput(command.input);
  await titleExists(database, input.titleId);
  const [source] = await database
    .select({ suggestion: revisionCoverSuggestions })
    .from(revisionCoverSuggestions)
    .innerJoin(
      titleRevisions,
      and(
        eq(titleRevisions.id, revisionCoverSuggestions.revisionId),
        eq(titleRevisions.titleId, input.titleId)
      )
    )
    .where(
      and(
        eq(revisionCoverSuggestions.id, input.suggestionId),
        eq(revisionCoverSuggestions.revisionId, input.revisionId)
      )
    )
    .limit(1);
  if (!source) throw new CatalogDomainError('cover_suggestion_not_found');

  const destination = titleCoverKey(input.titleId, randomUUID());
  const copied = await storage.copy(parseStorageKey(source.suggestion.storageKey), destination);
  if (copied.byteSize !== source.suggestion.byteSize) {
    throw new Error('Cover suggestion copy failed integrity validation');
  }

  return withTransaction(database, async (transaction) => {
    const [title] = await transaction
      .select()
      .from(titles)
      .where(eq(titles.id, input.titleId))
      .for('update')
      .limit(1);
    if (!title) throw new CatalogDomainError('title_not_found');
    const [suggestion] = await transaction
      .select({ suggestion: revisionCoverSuggestions })
      .from(revisionCoverSuggestions)
      .innerJoin(
        titleRevisions,
        and(
          eq(titleRevisions.id, revisionCoverSuggestions.revisionId),
          eq(titleRevisions.titleId, input.titleId)
        )
      )
      .where(
        and(
          eq(revisionCoverSuggestions.id, input.suggestionId),
          eq(revisionCoverSuggestions.revisionId, input.revisionId)
        )
      )
      .limit(1);
    if (!suggestion) throw new CatalogDomainError('cover_suggestion_not_found');
    const changedAt = new Date();
    await transaction
      .update(titles)
      .set({
        coverStorageKey: destination,
        coverMediaType: suggestion.suggestion.mediaType,
        coverChecksumSha256: suggestion.suggestion.checksumSha256,
        coverByteSize: suggestion.suggestion.byteSize,
        coverWidth: suggestion.suggestion.width,
        coverHeight: suggestion.suggestion.height,
        coverUpdatedAt: changedAt,
        updatedAt: changedAt
      })
      .where(eq(titles.id, input.titleId));
    await appendAuditEvent(transaction, {
      actor,
      action: 'catalog.cover.confirm_suggestion',
      outcome: 'succeeded',
      resourceType: 'title',
      resourceId: input.titleId,
      correlationId: command.correlationId,
      before: { checksumSha256: title.coverChecksumSha256 },
      after: { checksumSha256: suggestion.suggestion.checksumSha256 }
    });
    return { titleId: input.titleId, checksumSha256: suggestion.suggestion.checksumSha256 };
  });
}

const replaceCoverInputSchema = z.strictObject({
  titleId: z.uuid(),
  sourceKey: z.string().transform(parseStorageKey)
});

interface ReplaceCoverCommand extends CoverCommand<z.input<typeof replaceCoverInputSchema>> {
  signal: AbortSignal;
}

export async function replaceTitleCover(
  database: Database,
  storage: ObjectStorage,
  limits: IngestionLimits,
  command: ReplaceCoverCommand
): Promise<CoverResult> {
  requireCapability(command.actor, 'catalog.manage');
  const actor = command.actor;
  const input = replaceCoverInputSchema.parse(command.input);
  await titleExists(database, input.titleId);
  const destination = titleCoverKey(input.titleId, randomUUID());
  const normalized = await normalizeImage({
    storage,
    source: await storage.read(input.sourceKey),
    destination,
    profile: 'cover',
    limits,
    signal: command.signal
  });

  return withTransaction(database, async (transaction) => {
    const [title] = await transaction
      .select()
      .from(titles)
      .where(eq(titles.id, input.titleId))
      .for('update')
      .limit(1);
    if (!title) throw new CatalogDomainError('title_not_found');
    const changedAt = new Date();
    await transaction
      .update(titles)
      .set({
        coverStorageKey: normalized.storageKey,
        coverMediaType: normalized.mediaType,
        coverChecksumSha256: normalized.checksumSha256,
        coverByteSize: normalized.byteSize,
        coverWidth: normalized.width,
        coverHeight: normalized.height,
        coverUpdatedAt: changedAt,
        updatedAt: changedAt
      })
      .where(eq(titles.id, input.titleId));
    await appendAuditEvent(transaction, {
      actor,
      action: 'catalog.cover.replace',
      outcome: 'succeeded',
      resourceType: 'title',
      resourceId: input.titleId,
      correlationId: command.correlationId,
      before: { checksumSha256: title.coverChecksumSha256 },
      after: { checksumSha256: normalized.checksumSha256 }
    });
    return { titleId: input.titleId, checksumSha256: normalized.checksumSha256 };
  });
}
