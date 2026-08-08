import { and, eq } from 'drizzle-orm';
import { requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import { appendAuditEvent } from '$lib/server/audit/service';
import {
  titleRevisions,
  titles,
  type TitleRevisionRow,
  type TitleRow
} from '$lib/server/db/schema';
import type { Database } from '$lib/server/db/client';
import { withTransaction } from '$lib/server/db/transaction';
import {
  parseCreateRevisionInput,
  parseCreateTitleInput,
  type CreateRevisionInput,
  type CreateTitleInput
} from './input';

export class CatalogDomainError extends Error {
  constructor(readonly code: 'title_not_found' | 'parent_revision_not_in_title') {
    super(code);
    this.name = 'CatalogDomainError';
  }
}

interface CatalogCommand<T> {
  actor: Actor;
  correlationId: string;
  input: T;
}

export async function createPrivateTitle(
  database: Database,
  command: CatalogCommand<CreateTitleInput>
): Promise<TitleRow> {
  const actor = command.actor;
  requireCapability(actor, 'catalog.manage');
  const input = parseCreateTitleInput(command.input);

  return withTransaction(database, async (transaction) => {
    const [title] = await transaction
      .insert(titles)
      .values({ ...input, visibility: 'private' })
      .returning();
    if (!title) throw new Error('Title insert returned no row');

    await appendAuditEvent(transaction, {
      actor,
      action: 'catalog.title.create',
      outcome: 'succeeded',
      resourceType: 'title',
      resourceId: title.id,
      correlationId: command.correlationId,
      after: {
        slug: title.slug,
        title: title.title,
        format: title.format,
        visibility: title.visibility,
        priceMinor: title.priceMinor,
        currency: title.currency
      }
    });

    return title;
  });
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
