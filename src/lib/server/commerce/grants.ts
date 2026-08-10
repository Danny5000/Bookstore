import { and, asc, eq } from 'drizzle-orm';
import {
  entitlementGrants,
  entitlements,
  type EntitlementGrantRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { CommerceConflictError, PermanentCommerceError } from './errors';
import { lockEntitlementScopes } from './lock';

export type EffectiveEntitlementState = 'active' | 'revoked';

export function effectiveEntitlementState(
  grants: readonly Pick<EntitlementGrantRow, 'state'>[]
): EffectiveEntitlementState {
  return grants.some((grant) => grant.state === 'active') ? 'active' : 'revoked';
}

export type GrantTransitionOrigin =
  | 'claim'
  | 'payment'
  | 'refund'
  | 'dispute'
  | 'preserved';

export function assertGrantTransitionAllowed(
  grant: Pick<EntitlementGrantRow, 'source' | 'state'>,
  nextState: EntitlementGrantRow['state'],
  origin: GrantTransitionOrigin
): void {
  if (nextState === grant.state) return;
  if (grant.source === 'preserved' && (origin === 'refund' || origin === 'dispute')) {
    throw new CommerceConflictError('PRESERVED_GRANT_IMMUTABLE');
  }
  if (grant.source === 'purchase' && grant.state === 'revoked') {
    throw new CommerceConflictError('GRANT_PERMANENTLY_REVOKED');
  }
}

export async function projectEffectiveEntitlement(
  transaction: DatabaseTransaction,
  userId: string,
  titleId: string,
  now = new Date()
): Promise<{ beforeActive: boolean; afterActive: boolean }> {
  await lockEntitlementScopes(transaction, [{ userId, titleId }]);

  const grants = await transaction
    .select({ state: entitlementGrants.state })
    .from(entitlementGrants)
    .where(
      and(
        eq(entitlementGrants.userId, userId),
        eq(entitlementGrants.titleId, titleId)
      )
    )
    .orderBy(asc(entitlementGrants.id))
    .for('update');
  const [existing] = await transaction
    .select()
    .from(entitlements)
    .where(and(eq(entitlements.userId, userId), eq(entitlements.titleId, titleId)))
    .for('update')
    .limit(1);

  const beforeActive = existing !== undefined && existing.revokedAt === null;
  const afterActive = effectiveEntitlementState(grants) === 'active';

  if (afterActive && !existing) {
    await transaction.insert(entitlements).values({
      userId,
      titleId,
      grantedAt: now,
      revokedAt: null,
      createdAt: now,
      updatedAt: now
    });
  } else if (afterActive && existing && existing.revokedAt !== null) {
    await transaction
      .update(entitlements)
      .set({ revokedAt: null, updatedAt: now })
      .where(eq(entitlements.id, existing.id));
  } else if (!afterActive && existing && existing.revokedAt === null) {
    await transaction
      .update(entitlements)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(entitlements.id, existing.id));
  }

  return { beforeActive, afterActive };
}

export interface SetPreservedGrantStateInput {
  userId: string;
  titleId: string;
  active: boolean;
  stateReason: string;
  now?: Date;
}

export async function setPreservedGrantState(
  transaction: DatabaseTransaction,
  input: SetPreservedGrantStateInput
): Promise<{ beforeActive: boolean; afterActive: boolean }> {
  if (!/^[a-z0-9_]{1,100}$/u.test(input.stateReason)) {
    throw new PermanentCommerceError();
  }
  const now = input.now ?? new Date();
  await lockEntitlementScopes(transaction, [input]);
  const [existing] = await transaction
    .select()
    .from(entitlementGrants)
    .where(
      and(
        eq(entitlementGrants.userId, input.userId),
        eq(entitlementGrants.titleId, input.titleId),
        eq(entitlementGrants.source, 'preserved')
      )
    )
    .for('update')
    .limit(1);
  const nextState = input.active ? 'active' : 'revoked';

  if (existing) {
    assertGrantTransitionAllowed(existing, nextState, 'preserved');
    await transaction
      .update(entitlementGrants)
      .set({
        state: nextState,
        stateReason: input.stateReason,
        suspendedAt: null,
        revokedAt: input.active ? null : now,
        updatedAt: now
      })
      .where(eq(entitlementGrants.id, existing.id));
  } else if (input.active) {
    await transaction.insert(entitlementGrants).values({
      userId: input.userId,
      titleId: input.titleId,
      source: 'preserved',
      state: 'active',
      stateReason: input.stateReason,
      grantedAt: now,
      createdAt: now,
      updatedAt: now
    });
  }

  return projectEffectiveEntitlement(
    transaction,
    input.userId,
    input.titleId,
    now
  );
}
