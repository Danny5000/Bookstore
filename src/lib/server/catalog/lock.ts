import { eq, sql } from 'drizzle-orm';
import { requireCapability, type Actor, type AdministratorActor } from '$lib/server/auth/admin-policy';
import { listRolesForUser } from '$lib/server/auth/identity';
import { titles, type TitleRow } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { canonicalizeUuid } from '$lib/validation/uuid';
import { CatalogDomainError } from './errors';

export interface LockedAdminTitle {
  actor: AdministratorActor;
  title: TitleRow;
}

export async function withLockedAdminTitle<T>(
  transaction: DatabaseTransaction,
  actorSnapshot: Actor,
  titleId: string,
  work: (context: LockedAdminTitle) => Promise<T>
): Promise<T> {
  requireCapability(actorSnapshot, 'catalog.manage');
  const canonicalTitleId = canonicalizeUuid(titleId);
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${canonicalTitleId}, 0))`
  );
  const actor: Actor = {
    type: 'user',
    id: actorSnapshot.id,
    roles: await listRolesForUser(transaction, actorSnapshot.id)
  };
  requireCapability(actor, 'catalog.manage');
  const [title] = await transaction
    .select()
    .from(titles)
    .where(eq(titles.id, canonicalTitleId))
    .for('update')
    .limit(1);
  if (!title) throw new CatalogDomainError('title_not_found');
  return work({ actor, title });
}
