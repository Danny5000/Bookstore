import { and, eq, isNull, sql } from 'drizzle-orm';
import { AuthorizationError, type Actor } from '$lib/server/auth/admin-policy';
import { lockEntitlementScopes } from '$lib/server/commerce/lock';
import {
  entitlements,
  revisionPresentations,
  titleRevisions,
  titles,
  user,
  type RevisionPresentationRow,
  type TitleRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { ReaderStateNotFoundError } from './errors';

export type UserActor = Extract<Actor, { type: 'user' }>;

export interface LockedReaderTitle {
  userId: string;
  title: TitleRow;
  revisionId: string;
  presentation: RevisionPresentationRow;
}

export function requireUserActor(actor: Actor): UserActor {
  if (actor.type === 'anonymous') throw new AuthorizationError('unauthenticated', 401);
  if (actor.type !== 'user') throw new AuthorizationError('forbidden', 403);
  return actor;
}

async function requirePersistedUser(
  transaction: DatabaseTransaction,
  userId: string
): Promise<void> {
  const [persisted] = await transaction
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId))
    .for('key share')
    .limit(1);
  if (!persisted) throw new ReaderStateNotFoundError();
}

export async function lockReaderTitle(
  transaction: DatabaseTransaction,
  actorSnapshot: Actor,
  titleId: string
): Promise<LockedReaderTitle> {
  const actor = requireUserActor(actorSnapshot);
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${titleId}, 0))`
  );
  const stateLockKey = `pale-orbit:reader-state:${actor.id}:${titleId}`;
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${stateLockKey}, 0))`
  );
  await lockEntitlementScopes(transaction, [{ userId: actor.id, titleId }]);

  await requirePersistedUser(transaction, actor.id);
  const [title] = await transaction
    .select()
    .from(titles)
    .where(eq(titles.id, titleId))
    .for('update')
    .limit(1);
  if (!title?.activeRevisionId) throw new ReaderStateNotFoundError();
  const [entitlement] = await transaction
    .select({ id: entitlements.id })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.userId, actor.id),
        eq(entitlements.titleId, title.id),
        isNull(entitlements.revokedAt)
      )
    )
    .limit(1);
  if (!entitlement) throw new ReaderStateNotFoundError();
  const [publication] = await transaction
    .select({
      revisionId: titleRevisions.id,
      presentation: revisionPresentations
    })
    .from(titleRevisions)
    .innerJoin(
      revisionPresentations,
      and(
        eq(revisionPresentations.revisionId, titleRevisions.id),
        eq(revisionPresentations.state, 'published')
      )
    )
    .where(
      and(
        eq(titleRevisions.id, title.activeRevisionId),
        eq(titleRevisions.titleId, title.id),
        eq(titleRevisions.state, 'active')
      )
    )
    .limit(1);
  if (!publication) throw new ReaderStateNotFoundError();
  return {
    userId: actor.id,
    title,
    revisionId: publication.revisionId,
    presentation: publication.presentation
  };
}

export async function lockReaderAccount(
  transaction: DatabaseTransaction,
  actorSnapshot: Actor
): Promise<{ userId: string }> {
  const actor = requireUserActor(actorSnapshot);
  const lockKey = `pale-orbit:reader-preferences:${actor.id}`;
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
  );
  await requirePersistedUser(transaction, actor.id);
  return { userId: actor.id };
}
