import { and, eq } from 'drizzle-orm';
import { requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { AuditRequestMetadata } from '$lib/server/audit/request-metadata';
import type { Database } from '$lib/server/db/client';
import {
  revisionPresentations,
  titleRevisions,
  titles,
  type TitleRevisionRow,
  type TitleRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { withTransaction } from '$lib/server/db/transaction';
import { CatalogDomainError } from './errors';
import {
  parseRevisionPublicationActionInput,
  parseTitlePublicationActionInput,
  type RevisionPublicationActionInput,
  type TitlePublicationActionInput
} from './input';
import { withLockedAdminTitle, type LockedAdminTitle } from './lock';

interface PublicationCommand<T> {
  actor: Actor;
  correlationId: string;
  requestMetadata?: AuditRequestMetadata;
  input: T;
}

async function lockRevision(
  transaction: DatabaseTransaction,
  titleId: string,
  revisionId: string
): Promise<TitleRevisionRow> {
  const [revision] = await transaction
    .select()
    .from(titleRevisions)
    .where(and(eq(titleRevisions.id, revisionId), eq(titleRevisions.titleId, titleId)))
    .for('update')
    .limit(1);
  if (!revision) throw new CatalogDomainError('publication_precondition');
  return revision;
}

async function requirePublishedSettings(
  transaction: DatabaseTransaction,
  revisionId: string
): Promise<void> {
  const [published] = await transaction
    .select({ id: revisionPresentations.id })
    .from(revisionPresentations)
    .where(
      and(
        eq(revisionPresentations.revisionId, revisionId),
        eq(revisionPresentations.state, 'published')
      )
    )
    .limit(1);
  if (!published) throw new CatalogDomainError('publication_precondition');
}

async function setActiveRevision(
  transaction: DatabaseTransaction,
  title: TitleRow,
  revision: TitleRevisionRow,
  now: Date
): Promise<TitleRow> {
  if (title.activeRevisionId) {
    const current = await lockRevision(transaction, title.id, title.activeRevisionId);
    if (current.state !== 'active' || current.id === revision.id) {
      throw new CatalogDomainError('publication_precondition');
    }
    await transaction
      .update(titleRevisions)
      .set({ state: 'retired', retiredAt: now })
      .where(eq(titleRevisions.id, current.id));
  }
  await transaction
    .update(titleRevisions)
    .set({ state: 'active', activatedAt: now, retiredAt: null })
    .where(eq(titleRevisions.id, revision.id));
  const [updated] = await transaction
    .update(titles)
    .set({ activeRevisionId: revision.id, updatedAt: now })
    .where(eq(titles.id, title.id))
    .returning();
  if (!updated) throw new Error('Title activation returned no row');
  return updated;
}

async function auditLifecycle(
  transaction: DatabaseTransaction,
  context: LockedAdminTitle,
  command: { correlationId: string; requestMetadata?: AuditRequestMetadata },
  action: string,
  revisionId?: string
): Promise<void> {
  await appendAuditEvent(transaction, {
    actor: context.actor,
    action,
    outcome: 'succeeded',
    resourceType: revisionId ? 'title_revision' : 'title',
    resourceId: revisionId ?? context.title.id,
    correlationId: command.correlationId,
    ...(command.requestMetadata ? { requestMetadata: command.requestMetadata } : {}),
    after: {
      titleId: context.title.id,
      ...(revisionId ? { revisionId } : {})
    }
  });
}

export async function activatePrivateRevision(
  database: Database,
  command: PublicationCommand<RevisionPublicationActionInput>
): Promise<TitleRow> {
  requireCapability(command.actor, 'catalog.manage');
  const input = parseRevisionPublicationActionInput(command.input);
  return withTransaction(database, (transaction) =>
    withLockedAdminTitle(transaction, command.actor, input.titleId, async (context) => {
      if (context.title.visibility !== 'private') {
        throw new CatalogDomainError('publication_precondition');
      }
      const candidate = await lockRevision(transaction, input.titleId, input.revisionId);
      if (candidate.state !== 'ready_for_review') {
        throw new CatalogDomainError('publication_precondition');
      }
      await requirePublishedSettings(transaction, candidate.id);
      const updated = await setActiveRevision(transaction, context.title, candidate, new Date());
      await auditLifecycle(
        transaction,
        context,
        command,
        'catalog.revision.activate_private',
        candidate.id
      );
      return updated;
    })
  );
}

export async function publishTitleToStorefront(
  database: Database,
  command: PublicationCommand<TitlePublicationActionInput>
): Promise<TitleRow> {
  requireCapability(command.actor, 'catalog.manage');
  const input = parseTitlePublicationActionInput(command.input);
  return withTransaction(database, (transaction) =>
    withLockedAdminTitle(transaction, command.actor, input.titleId, async (context) => {
      if (context.title.visibility !== 'private' || !context.title.activeRevisionId) {
        throw new CatalogDomainError('publication_precondition');
      }
      const active = await lockRevision(transaction, input.titleId, context.title.activeRevisionId);
      if (active.state !== 'active') throw new CatalogDomainError('publication_precondition');
      await requirePublishedSettings(transaction, active.id);
      const [updated] = await transaction
        .update(titles)
        .set({ visibility: 'public', updatedAt: new Date() })
        .where(eq(titles.id, input.titleId))
        .returning();
      if (!updated) throw new Error('Title publication returned no row');
      await auditLifecycle(transaction, context, command, 'catalog.title.publish');
      return updated;
    })
  );
}

export async function publishReplacementRevision(
  database: Database,
  command: PublicationCommand<RevisionPublicationActionInput>
): Promise<TitleRow> {
  requireCapability(command.actor, 'catalog.manage');
  const input = parseRevisionPublicationActionInput(command.input);
  return withTransaction(database, (transaction) =>
    withLockedAdminTitle(transaction, command.actor, input.titleId, async (context) => {
      if (
        context.title.visibility !== 'public' ||
        !context.title.activeRevisionId ||
        context.title.activeRevisionId === input.revisionId
      ) {
        throw new CatalogDomainError('publication_precondition');
      }
      const candidate = await lockRevision(transaction, input.titleId, input.revisionId);
      if (candidate.state !== 'ready_for_review') {
        throw new CatalogDomainError('publication_precondition');
      }
      await requirePublishedSettings(transaction, candidate.id);
      const updated = await setActiveRevision(transaction, context.title, candidate, new Date());
      await auditLifecycle(
        transaction,
        context,
        command,
        'catalog.revision.publish_replacement',
        candidate.id
      );
      return updated;
    })
  );
}

export async function rollbackRevision(
  database: Database,
  command: PublicationCommand<RevisionPublicationActionInput>
): Promise<TitleRow> {
  requireCapability(command.actor, 'catalog.manage');
  const input = parseRevisionPublicationActionInput(command.input);
  return withTransaction(database, (transaction) =>
    withLockedAdminTitle(transaction, command.actor, input.titleId, async (context) => {
      if (!context.title.activeRevisionId || context.title.activeRevisionId === input.revisionId) {
        throw new CatalogDomainError('publication_precondition');
      }
      const candidate = await lockRevision(transaction, input.titleId, input.revisionId);
      if (candidate.state !== 'retired') throw new CatalogDomainError('publication_precondition');
      await requirePublishedSettings(transaction, candidate.id);
      const updated = await setActiveRevision(transaction, context.title, candidate, new Date());
      await auditLifecycle(
        transaction,
        context,
        command,
        'catalog.revision.rollback',
        candidate.id
      );
      return updated;
    })
  );
}

export async function withdrawTitle(
  database: Database,
  command: PublicationCommand<TitlePublicationActionInput>
): Promise<TitleRow> {
  requireCapability(command.actor, 'catalog.manage');
  const input = parseTitlePublicationActionInput(command.input);
  return withTransaction(database, (transaction) =>
    withLockedAdminTitle(transaction, command.actor, input.titleId, async (context) => {
      if (context.title.visibility !== 'public' || !context.title.activeRevisionId) {
        throw new CatalogDomainError('publication_precondition');
      }
      const [updated] = await transaction
        .update(titles)
        .set({ visibility: 'private', updatedAt: new Date() })
        .where(eq(titles.id, input.titleId))
        .returning();
      if (!updated) throw new Error('Title withdrawal returned no row');
      await auditLifecycle(transaction, context, command, 'catalog.title.withdraw');
      return updated;
    })
  );
}
