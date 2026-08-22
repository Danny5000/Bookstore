import { describe, expect, it, vi } from 'vitest';
import type {
  EntitlementGrantRow,
  OrderItemRow,
  RefundAllocationRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { PermanentCommerceError } from './errors';
import {
  recomputeRefundPurchaseAccess,
  type RefundEntitlementProjector
} from './refund-access';

const now = new Date('2026-08-22T13:00:00.000Z');

function item(id: string, totalMinor: number, titleId = `title-${id}`): OrderItemRow {
  return {
    id,
    orderId: 'order-a',
    titleId,
    titleSnapshot: `Title ${id}`,
    creatorNameSnapshot: 'Creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: totalMinor,
    taxMinor: 0,
    totalMinor,
    stripeLineItemId: `li_${id}`,
    createdAt: now
  };
}

function allocation(orderItemId: string, amountMinor: number): RefundAllocationRow {
  return {
    id: `allocation-${orderItemId}`,
    refundId: 'refund-a',
    orderItemId,
    amountMinor,
    source: 'automatic',
    createdAt: now
  };
}

function grant(
  id: string,
  orderItemId: string | null,
  state: EntitlementGrantRow['state'],
  overrides: Partial<EntitlementGrantRow> = {}
): EntitlementGrantRow {
  const userId = state === 'unclaimed' ? null : `user-${id}`;
  return {
    id,
    titleId: `title-${orderItemId ?? id}`,
    userId,
    source: 'purchase',
    orderItemId,
    recoveryRefundAllocationId: null,
    state,
    stateReason: state === 'active' ? 'payment_succeeded' : `purchase_${state}`,
    grantedAt: new Date('2026-08-22T12:00:00.000Z'),
    suspendedAt: state === 'suspended' ? new Date('2026-08-22T12:30:00.000Z') : null,
    revokedAt: state === 'revoked' ? new Date('2026-08-22T12:30:00.000Z') : null,
    createdAt: new Date('2026-08-22T12:00:00.000Z'),
    updatedAt: new Date('2026-08-22T12:30:00.000Z'),
    ...overrides
  };
}

function fakeTransaction() {
  const writes: Array<Record<string, unknown>> = [];
  const where = vi.fn(async () => undefined);
  const set = vi.fn((values: Record<string, unknown>) => {
    writes.push(values);
    return { where };
  });
  const update = vi.fn(() => ({ set }));
  return {
    transaction: { update } as unknown as DatabaseTransaction,
    update,
    writes
  };
}

function input(
  items: readonly OrderItemRow[],
  allocations: readonly RefundAllocationRow[],
  grants: readonly EntitlementGrantRow[]
) {
  return { items, allocations, grants, now };
}

describe('refund purchase access recomputation', () => {
  it('does not write or project a partially allocated item', async () => {
    const row = item('item-a', 100);
    const purchaseGrant = grant('grant-a', row.id, 'active', { titleId: row.titleId });
    const database = fakeTransaction();
    const project = vi.fn<RefundEntitlementProjector>();

    await expect(recomputeRefundPurchaseAccess(
      database.transaction,
      input([row], [allocation(row.id, 99)], [purchaseGrant]),
      project
    )).resolves.toEqual({ grantTransitions: [], projectedScopes: [] });
    expect(database.update).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
  });

  it.each(['active', 'suspended'] as const)(
    'revokes one fully allocated claimed %s purchase grant with exact timestamps',
    async (state) => {
      const row = item('item-a', 100);
      const grantedAt = state === 'suspended'
        ? new Date('2026-08-22T14:00:00.000Z')
        : new Date('2026-08-22T12:00:00.000Z');
      const purchaseGrant = grant('grant-a', row.id, state, {
        titleId: row.titleId,
        userId: 'user-a',
        grantedAt
      });
      const database = fakeTransaction();
      const project = vi.fn<RefundEntitlementProjector>(async () => ({
        beforeActive: true,
        afterActive: false
      }));

      const result = await recomputeRefundPurchaseAccess(
        database.transaction,
        input([row], [allocation(row.id, 100)], [purchaseGrant]),
        project
      );

      expect(database.writes).toEqual([{
        state: 'revoked',
        stateReason: 'refund_fully_allocated',
        suspendedAt: null,
        revokedAt: state === 'suspended' ? grantedAt : now,
        updatedAt: now
      }]);
      expect(result).toEqual({
        grantTransitions: [{
          grantId: purchaseGrant.id,
          orderItemId: row.id,
          userId: 'user-a',
          titleId: row.titleId,
          beforeState: state,
          afterState: 'revoked'
        }],
        projectedScopes: [{
          userId: 'user-a',
          titleId: row.titleId,
          beforeActive: true,
          afterActive: false
        }]
      });
    }
  );

  it('revokes a fully allocated guest grant without projecting an entitlement', async () => {
    const row = item('item-a', 100);
    const purchaseGrant = grant('grant-a', row.id, 'unclaimed', {
      titleId: row.titleId,
      userId: null
    });
    const database = fakeTransaction();
    const project = vi.fn<RefundEntitlementProjector>();

    await expect(recomputeRefundPurchaseAccess(
      database.transaction,
      input([row], [allocation(row.id, 100)], [purchaseGrant]),
      project
    )).resolves.toEqual({
      grantTransitions: [{
        grantId: purchaseGrant.id,
        orderItemId: row.id,
        userId: null,
        titleId: row.titleId,
        beforeState: 'unclaimed',
        afterState: 'revoked'
      }],
      projectedScopes: []
    });
    expect(database.writes).toHaveLength(1);
    expect(project).not.toHaveBeenCalled();
  });

  it('leaves an already revoked purchase grant untouched while returning unchanged provenance', async () => {
    const row = item('item-a', 100);
    const purchaseGrant = grant('grant-a', row.id, 'revoked', {
      titleId: row.titleId,
      userId: 'user-a'
    });
    const database = fakeTransaction();
    const project = vi.fn<RefundEntitlementProjector>();

    await expect(recomputeRefundPurchaseAccess(
      database.transaction,
      input([row], [allocation(row.id, 100)], [purchaseGrant]),
      project
    )).resolves.toEqual({
      grantTransitions: [{
        grantId: purchaseGrant.id,
        orderItemId: row.id,
        userId: 'user-a',
        titleId: row.titleId,
        beforeState: 'revoked',
        afterState: 'revoked'
      }],
      projectedScopes: []
    });
    expect(database.update).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
  });

  it('reports effective access preservation by another active purchase or preserved grant', async () => {
    const row = item('item-a', 100);
    const purchaseGrant = grant('grant-a', row.id, 'active', {
      titleId: row.titleId,
      userId: 'user-a'
    });
    const database = fakeTransaction();
    const project = vi.fn<RefundEntitlementProjector>(async () => ({
      beforeActive: true,
      afterActive: true
    }));

    const result = await recomputeRefundPurchaseAccess(
      database.transaction,
      input([row], [allocation(row.id, 100)], [purchaseGrant]),
      project
    );

    expect(result.projectedScopes).toEqual([{
      userId: 'user-a',
      titleId: row.titleId,
      beforeActive: true,
      afterActive: true
    }]);
  });

  it('deduplicates and projects changed scopes in stable user/title order', async () => {
    const itemZ = item('item-z', 100, 'title-z');
    const itemA = item('item-a', 100, 'title-a');
    const itemADuplicate = item('item-a-duplicate', 100, 'title-a');
    const grantZ = grant('grant-z', itemZ.id, 'active', {
      titleId: itemZ.titleId,
      userId: 'user-z'
    });
    const grantA = grant('grant-a', itemA.id, 'active', {
      titleId: itemA.titleId,
      userId: 'user-a'
    });
    const grantADuplicate = grant('grant-a-duplicate', itemADuplicate.id, 'active', {
      titleId: itemADuplicate.titleId,
      userId: 'user-a'
    });
    const database = fakeTransaction();
    const project = vi.fn<RefundEntitlementProjector>(async () => ({
      beforeActive: true,
      afterActive: false
    }));

    const result = await recomputeRefundPurchaseAccess(
      database.transaction,
      input(
        [itemZ, itemA, itemADuplicate],
        [allocation(itemZ.id, 100), allocation(itemA.id, 100), allocation(itemADuplicate.id, 100)],
        [grantZ, grantADuplicate, grantA]
      ),
      project
    );

    expect(project.mock.calls.map(([, userId, titleId]) => [userId, titleId])).toEqual([
      ['user-a', 'title-a'],
      ['user-z', 'title-z']
    ]);
    expect(result.projectedScopes.map(({ userId, titleId }) => [userId, titleId])).toEqual([
      ['user-a', 'title-a'],
      ['user-z', 'title-z']
    ]);
    expect(result.grantTransitions.map(({ grantId }) => grantId)).toEqual([
      'grant-a',
      'grant-a-duplicate',
      'grant-z'
    ]);
  });

  it('rejects a preserved grant passed through the purchase reducer', async () => {
    const row = item('item-a', 100);
    const preservedGrant = grant('grant-a', null, 'active', {
      source: 'preserved',
      titleId: row.titleId,
      userId: 'user-a'
    });
    const database = fakeTransaction();

    await expect(recomputeRefundPurchaseAccess(
      database.transaction,
      input([row], [allocation(row.id, 100)], [preservedGrant])
    )).rejects.toBeInstanceOf(PermanentCommerceError);
    expect(database.update).not.toHaveBeenCalled();
  });
});
