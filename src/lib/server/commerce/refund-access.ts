import { eq } from 'drizzle-orm';
import {
  entitlementGrants,
  type EntitlementGrantRow,
  type OrderItemRow,
  type RefundAllocationRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  assertGrantTransitionAllowed,
  projectEffectiveEntitlement
} from './grants';
import {
  permanentReconciliationFailure,
  reconciliationTransitionTime
} from './reconciliation';

export type RefundEntitlementProjector = (
  transaction: DatabaseTransaction,
  userId: string,
  titleId: string,
  now: Date
) => Promise<{ beforeActive: boolean; afterActive: boolean }>;

export interface RefundPurchaseGrantTransition {
  grantId: string;
  orderItemId: string;
  userId: string | null;
  titleId: string;
  beforeState: EntitlementGrantRow['state'];
  afterState: EntitlementGrantRow['state'];
}

export interface RefundProjectedAccessScope {
  userId: string;
  titleId: string;
  beforeActive: boolean;
  afterActive: boolean;
}

export interface RefundPurchaseAccessResult {
  grantTransitions: readonly RefundPurchaseGrantTransition[];
  projectedScopes: readonly RefundProjectedAccessScope[];
}

export async function recomputeRefundPurchaseAccess(
  transaction: DatabaseTransaction,
  input: {
    items: readonly OrderItemRow[];
    allocations: readonly Pick<RefundAllocationRow, 'orderItemId' | 'amountMinor'>[];
    grants: readonly EntitlementGrantRow[];
    now: Date;
  },
  projectEntitlement: RefundEntitlementProjector = projectEffectiveEntitlement
): Promise<RefundPurchaseAccessResult> {
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const grantItemIds = new Set<string>();
  for (const grant of input.grants) {
    const item = grant.orderItemId ? itemById.get(grant.orderItemId) : undefined;
    if (
      grant.source !== 'purchase' ||
      !grant.orderItemId ||
      grantItemIds.has(grant.orderItemId) ||
      !item ||
      grant.titleId !== item.titleId
    ) permanentReconciliationFailure();
    grantItemIds.add(grant.orderItemId);
  }
  if (grantItemIds.size !== input.items.length) permanentReconciliationFailure();

  const fullyAllocatedItems = new Set(input.items.filter((item) => {
    const total = input.allocations
      .filter((row) => row.orderItemId === item.id)
      .reduce((sum, row) => sum + row.amountMinor, 0);
    return total === item.totalMinor;
  }).map((item) => item.id));
  const changedScopes: Array<{ userId: string; titleId: string }> = [];
  const grantTransitions: RefundPurchaseGrantTransition[] = [];
  const sortedGrants = [...input.grants].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  for (const grant of sortedGrants) {
    if (!grant.orderItemId || !fullyAllocatedItems.has(grant.orderItemId)) continue;
    assertGrantTransitionAllowed(grant, 'revoked', 'refund');
    grantTransitions.push({
      grantId: grant.id,
      orderItemId: grant.orderItemId,
      userId: grant.userId,
      titleId: grant.titleId,
      beforeState: grant.state,
      afterState: 'revoked'
    });
    if (grant.state === 'revoked') continue;
    await transaction
      .update(entitlementGrants)
      .set({
        state: 'revoked',
        stateReason: 'refund_fully_allocated',
        suspendedAt: null,
        revokedAt: reconciliationTransitionTime(input.now, grant.grantedAt),
        updatedAt: input.now
      })
      .where(eq(entitlementGrants.id, grant.id));
    if (grant.userId) changedScopes.push({ userId: grant.userId, titleId: grant.titleId });
  }
  const uniqueScopes = [...new Map(changedScopes.map((scope) => [
    `${scope.userId}\0${scope.titleId}`,
    scope
  ])).values()].sort((left, right) =>
    left.userId.localeCompare(right.userId) || left.titleId.localeCompare(right.titleId)
  );
  const projectedScopes: RefundProjectedAccessScope[] = [];
  for (const scope of uniqueScopes) {
    const projected = await projectEntitlement(
      transaction,
      scope.userId,
      scope.titleId,
      input.now
    );
    projectedScopes.push({ ...scope, ...projected });
  }
  return { grantTransitions, projectedScopes };
}
