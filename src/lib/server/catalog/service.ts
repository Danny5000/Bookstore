import { and, eq } from 'drizzle-orm';
import { requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import { appendAuditEvent } from '$lib/server/audit/service';
import {
  titleRevisions,
  titles,
  type TitleRevisionRow
} from '$lib/server/db/schema';
import type { Database } from '$lib/server/db/client';
import { withTransaction } from '$lib/server/db/transaction';
import { parseCreateRevisionInput, type CreateRevisionInput } from './input';
import { CatalogDomainError } from './errors';

export { CatalogDomainError } from './errors';
export {
  acceptRevisionUpload,
  getAdminRevisionReview,
  getAdminRevisionStatus,
  listAdminRevisions,
  retryFailedRevision
} from './revisions';
export { confirmCoverSuggestion, replaceTitleCover } from './covers';
export { publishReaderSettings, saveDraftPresentation } from './presentations';
export {
  activatePrivateRevision,
  publishReplacementRevision,
  publishTitleToStorefront,
  rollbackRevision,
  withdrawTitle
} from './publication';
export {
  createPrivateTitle,
  getAdminTitleDetail,
  listAdminTitles,
  updateTitleMetadata
} from './titles';

interface CatalogCommand<T> {
  actor: Actor;
  correlationId: string;
  input: T;
}

export async function createRevisionSkeleton(
  database: Database,
  command: CatalogCommand<CreateRevisionInput>
): Promise<TitleRevisionRow> {
  const actor = command.actor;
  requireCapability(actor, 'catalog.manage');
  const input = parseCreateRevisionInput(command.input);

  return withTransaction(database, async (transaction) => {
    const [title] = await transaction
      .select({ id: titles.id })
      .from(titles)
      .where(eq(titles.id, input.titleId))
      .limit(1);
    if (!title) throw new CatalogDomainError('title_not_found');

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
        changeSummary: input.changeSummary
      })
      .returning();
    if (!revision) throw new Error('Revision insert returned no row');

    await appendAuditEvent(transaction, {
      actor,
      action: 'catalog.revision.create',
      outcome: 'succeeded',
      resourceType: 'title_revision',
      resourceId: revision.id,
      correlationId: command.correlationId,
      after: {
        titleId: revision.titleId,
        parentRevisionId: revision.parentRevisionId,
        state: revision.state,
        changeSummary: revision.changeSummary
      }
    });

    return revision;
  });
}
