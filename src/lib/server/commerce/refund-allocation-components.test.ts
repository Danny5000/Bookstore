import { describe, expect, it } from 'vitest';
import type {
  OrderItemRow,
  RefundAllocationComponentRow,
  RefundAllocationRow,
  RefundRow
} from '$lib/server/db/schema';
import { PermanentCommerceError } from './errors';
import {
  planRefundAllocationComponents,
  type RefundComponentAllocation
} from './refund-allocation-components';

const createdAt = new Date('2026-08-22T13:00:00.000Z');

function item(
  id: string,
  subtotalMinor: number,
  taxMinor: number,
  currency = 'USD'
): OrderItemRow {
  return {
    id,
    orderId: 'order-a',
    titleId: `title-${id}`,
    titleSnapshot: `Title ${id}`,
    creatorNameSnapshot: 'Creator',
    format: 'prose',
    currency,
    unitSubtotalMinor: subtotalMinor,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
    stripeLineItemId: `li_${id}`,
    createdAt
  };
}

function refund(
  id: string,
  providerCreatedAt: Date,
  stripeRefundId = `re_${id}`,
  currency = 'USD'
): RefundRow {
  return {
    id,
    paymentId: 'payment-a',
    stripeRefundId,
    status: 'succeeded',
    amountMinor: 100,
    currency,
    reason: null,
    providerCreatedAt,
    allocationStatus: 'finalized',
    financialEvidenceStatus: 'pending',
    createdAt,
    updatedAt: createdAt
  };
}

function allocation(
  id: string,
  refundId: string,
  orderItemId: string,
  amountMinor: number
): RefundAllocationRow {
  return { id, refundId, orderItemId, amountMinor, source: 'automatic', createdAt };
}

function component(
  id: string,
  refundAllocationId: string,
  refundId: string,
  orderItemId: string,
  subtotalMinor: number,
  taxMinor: number,
  currency = 'USD'
): RefundAllocationComponentRow {
  return {
    id,
    refundAllocationId,
    refundId,
    orderItemId,
    subtotalMinor,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
    currency,
    createdAt
  };
}

function planned(
  items: readonly OrderItemRow[],
  refunds: readonly RefundRow[],
  newAllocations: readonly RefundComponentAllocation[],
  existingAllocations: readonly RefundAllocationRow[] = [],
  existingComponents: readonly RefundAllocationComponentRow[] = []
) {
  return planRefundAllocationComponents({
    items,
    refunds,
    existingAllocations,
    existingComponents,
    newAllocations,
    createdAt
  });
}

describe('refund allocation component planning', () => {
  it('awards an equal largest-remainder tie to subtotal by the stable component key', () => {
    const row = item('item-a', 1, 1);
    const source = refund('refund-a', new Date('2026-08-22T12:00:00.000Z'));

    expect(planned([row], [source], [
      { refundId: source.id, orderItemId: row.id, amountMinor: 1 }
    ])).toEqual([{
      allocation: { refundId: source.id, orderItemId: row.id, amountMinor: 1 },
      component: {
        refundId: source.id,
        orderItemId: row.id,
        subtotalMinor: 1,
        taxMinor: 0,
        totalMinor: 1,
        currency: 'USD',
        createdAt
      }
    }]);
  });

  it('uses provider timestamp before provider ID when allocation order changes capacity', () => {
    const row = item('item-a', 1, 1);
    const earlier = refund(
      'refund-z',
      new Date('2026-08-22T12:00:00.000Z'),
      're_z'
    );
    const later = refund(
      'refund-a',
      new Date('2026-08-22T12:00:01.000Z'),
      're_a'
    );

    const result = planned([row], [later, earlier], [
      { refundId: later.id, orderItemId: row.id, amountMinor: 1 },
      { refundId: earlier.id, orderItemId: row.id, amountMinor: 1 }
    ]);

    expect(result.map(({ allocation, component: value }) => ({
      refundId: allocation.refundId,
      subtotalMinor: value.subtotalMinor,
      taxMinor: value.taxMinor
    }))).toEqual([
      { refundId: earlier.id, subtotalMinor: 1, taxMinor: 0 },
      { refundId: later.id, subtotalMinor: 0, taxMinor: 1 }
    ]);
  });

  it('breaks same-instant refund ties by provider ID before the local ID', () => {
    const row = item('item-a', 1, 1);
    const instant = new Date('2026-08-22T12:00:00.000Z');
    const providerFirst = refund('refund-z', instant, 're_a');
    const providerSecond = refund('refund-a', instant, 're_z');

    const result = planned([row], [providerSecond, providerFirst], [
      { refundId: providerSecond.id, orderItemId: row.id, amountMinor: 1 },
      { refundId: providerFirst.id, orderItemId: row.id, amountMinor: 1 }
    ]);

    expect(result.map(({ allocation: value }) => value.refundId)).toEqual([
      providerFirst.id,
      providerSecond.id
    ]);
    expect(result.map(({ component: value }) => [value.subtotalMinor, value.taxMinor]))
      .toEqual([[1, 0], [0, 1]]);
  });

  it('uses only tax capacity after subtotal is exhausted and vice versa', () => {
    const row = item('item-a', 10, 3);
    const first = refund('refund-a', new Date('2026-08-22T12:00:00.000Z'));
    const second = refund('refund-b', new Date('2026-08-22T12:00:01.000Z'));

    expect(planned(
      [row],
      [first, second],
      [{ refundId: second.id, orderItemId: row.id, amountMinor: 3 }],
      [allocation('allocation-a', first.id, row.id, 10)],
      [component('component-a', 'allocation-a', first.id, row.id, 10, 0)]
    )[0]?.component).toMatchObject({ subtotalMinor: 0, taxMinor: 3, totalMinor: 3 });

    expect(planned(
      [row],
      [first, second],
      [{ refundId: second.id, orderItemId: row.id, amountMinor: 10 }],
      [allocation('allocation-a', first.id, row.id, 3)],
      [component('component-a', 'allocation-a', first.id, row.id, 0, 3)]
    )[0]?.component).toMatchObject({ subtotalMinor: 10, taxMinor: 0, totalMinor: 10 });
  });

  it('conserves every positive allocation as nonnegative signed component totals', () => {
    const row = item('item-a', 8, 2);
    const first = refund('refund-a', new Date('2026-08-22T12:00:00.000Z'));
    const second = refund('refund-b', new Date('2026-08-22T12:00:01.000Z'));
    const result = planned([row], [first, second], [
      { refundId: second.id, orderItemId: row.id, amountMinor: 5 },
      { refundId: first.id, orderItemId: row.id, amountMinor: 5 }
    ]);

    expect(result).toHaveLength(2);
    for (const { allocation: value, component: split } of result) {
      expect(split.subtotalMinor).toBeGreaterThanOrEqual(0);
      expect(split.taxMinor).toBeGreaterThanOrEqual(0);
      expect(split.subtotalMinor + split.taxMinor).toBe(value.amountMinor);
      expect(split.totalMinor).toBe(value.amountMinor);
    }
  });

  it.each([
    ['subtotal', 11, 0],
    ['tax', 0, 4]
  ])('rejects existing %s consumption above its independent capacity', (_label, subtotal, tax) => {
    const row = item('item-a', 10, 3);
    const source = refund('refund-a', new Date('2026-08-22T12:00:00.000Z'));
    expect(() => planned(
      [row],
      [source],
      [],
      [allocation('allocation-a', source.id, row.id, subtotal + tax)],
      [component('component-a', 'allocation-a', source.id, row.id, subtotal, tax)]
    )).toThrow(PermanentCommerceError);
  });

  it('rejects new allocation or component currency mismatches', () => {
    const row = item('item-a', 10, 3);
    const source = refund('refund-a', new Date('2026-08-22T12:00:00.000Z'));
    const euro = refund('refund-eur', new Date('2026-08-22T12:00:01.000Z'), 're_eur', 'EUR');

    expect(() => planned([row], [euro], [
      { refundId: euro.id, orderItemId: row.id, amountMinor: 1 }
    ])).toThrow(PermanentCommerceError);
    expect(() => planned(
      [row],
      [source],
      [],
      [allocation('allocation-a', source.id, row.id, 1)],
      [component('component-a', 'allocation-a', source.id, row.id, 1, 0, 'EUR')]
    )).toThrow(PermanentCommerceError);
  });

  it('rejects missing, duplicate, and graph-mislinked existing components', () => {
    const row = item('item-a', 10, 3);
    const source = refund('refund-a', new Date('2026-08-22T12:00:00.000Z'));
    const existing = allocation('allocation-a', source.id, row.id, 1);
    const valid = component('component-a', existing.id, source.id, row.id, 1, 0);

    expect(() => planned([row], [source], [], [existing], []))
      .toThrow(PermanentCommerceError);
    expect(() => planned([row], [source], [], [existing], [valid, { ...valid, id: 'duplicate' }]))
      .toThrow(PermanentCommerceError);
    expect(() => planned([row], [source], [], [existing], [
      { ...valid, refundId: 'refund-other' }
    ])).toThrow(PermanentCommerceError);
    expect(() => planned([row], [source], [], [existing], [
      { ...valid, orderItemId: 'item-other' }
    ])).toThrow(PermanentCommerceError);
    expect(() => planned([row], [source], [], [existing], [
      { ...valid, totalMinor: 2 }
    ])).toThrow(PermanentCommerceError);
  });
});
