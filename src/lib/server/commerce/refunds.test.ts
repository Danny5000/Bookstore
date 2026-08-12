import { describe, expect, it } from 'vitest';
import {
  allocateDeterministicRefunds,
  type RefundAllocationFacts
} from './refunds';

const item = (id: string, totalMinor: number) => ({
  orderItemId: id,
  totalMinor,
  currency: 'USD'
});

const refund = (
  id: string,
  amountMinor: number,
  overrides: Record<string, unknown> = {}
) => ({
  refundId: id,
  providerRefundId: `re_${id}`,
  status: 'succeeded' as const,
  amountMinor,
  currency: 'USD',
  providerCreatedAt: new Date(`2026-08-10T13:0${id.slice(-1)}:00.000Z`),
  ...overrides
});

function facts(overrides: Partial<RefundAllocationFacts> = {}): RefundAllocationFacts {
  return {
    items: [item('item-a', 1403)],
    refunds: [],
    existingAllocations: [],
    ...overrides
  };
}

describe('deterministic refund allocation', () => {
  it('allocates partial and cumulative single-title refunds up to the paid item total', () => {
    const first = refund('refund-1', 500);
    expect(allocateDeterministicRefunds(facts({ refunds: [first] }))).toEqual({
      state: 'allocated',
      allocations: [{ refundId: first.refundId, orderItemId: 'item-a', amountMinor: 500 }]
    });

    const existing = [{ refundId: first.refundId, orderItemId: 'item-a', amountMinor: 500 }];
    expect(allocateDeterministicRefunds(facts({
      refunds: [first],
      existingAllocations: existing
    }))).toEqual({ state: 'noop', allocations: [] });

    const second = refund('refund-2', 903);
    expect(allocateDeterministicRefunds(facts({
      refunds: [second, first],
      existingAllocations: existing
    }))).toEqual({
      state: 'allocated',
      allocations: [{ refundId: second.refundId, orderItemId: 'item-a', amountMinor: 903 }]
    });
  });

  it('allocates one complete single-title refund', () => {
    const complete = refund('refund-1', 1403);
    expect(allocateDeterministicRefunds(facts({ refunds: [complete] }))).toEqual({
      state: 'allocated',
      allocations: [{ refundId: complete.refundId, orderItemId: 'item-a', amountMinor: 1403 }]
    });
  });

  it('allocates one full multi-title refund by stable item order', () => {
    const complete = refund('refund-1', 2500);
    expect(allocateDeterministicRefunds(facts({
      items: [item('item-b', 1500), item('item-a', 1000)],
      refunds: [complete]
    }))).toEqual({
      state: 'allocated',
      allocations: [
        { refundId: complete.refundId, orderItemId: 'item-a', amountMinor: 1000 },
        { refundId: complete.refundId, orderItemId: 'item-b', amountMinor: 1500 }
      ]
    });
  });

  it('allocates several succeeded refunds only once their sum proves a full multi-title refund', () => {
    const later = refund('refund-2', 1700);
    const earlier = refund('refund-1', 800);
    expect(allocateDeterministicRefunds(facts({
      items: [item('item-b', 1500), item('item-a', 1000)],
      refunds: [later, earlier]
    }))).toEqual({
      state: 'allocated',
      allocations: [
        { refundId: earlier.refundId, orderItemId: 'item-a', amountMinor: 800 },
        { refundId: later.refundId, orderItemId: 'item-a', amountMinor: 200 },
        { refundId: later.refundId, orderItemId: 'item-b', amountMinor: 1500 }
      ]
    });
  });

  it('marks partial multi-title refunds for review without guessing rows', () => {
    expect(allocateDeterministicRefunds(facts({
      items: [item('item-a', 1000), item('item-b', 1500)],
      refunds: [refund('refund-1', 800)]
    }))).toEqual({ state: 'needs_review', allocations: [] });

    expect(allocateDeterministicRefunds(facts({
      items: [item('item-a', 1000), item('item-b', 1500)],
      refunds: [refund('refund-1', 300), refund('refund-2', 500)]
    }))).toEqual({ state: 'needs_review', allocations: [] });
  });

  it('allocates one remaining refund when it exactly fills all remaining item capacity', () => {
    const first = refund('refund-1', 500);
    const final = refund('refund-2', 2000);
    expect(allocateDeterministicRefunds(facts({
      items: [item('item-a', 1000), item('item-b', 1500)],
      refunds: [first, final],
      existingAllocations: [
        { refundId: first.refundId, orderItemId: 'item-a', amountMinor: 500 }
      ]
    }))).toEqual({
      state: 'allocated',
      allocations: [
        { refundId: final.refundId, orderItemId: 'item-a', amountMinor: 500 },
        { refundId: final.refundId, orderItemId: 'item-b', amountMinor: 1500 }
      ]
    });
  });

  it('rejects over-refunds and impossible existing sums', () => {
    expect(allocateDeterministicRefunds(facts({
      refunds: [refund('refund-1', 1404)]
    }))).toEqual({ state: 'exception', allocations: [] });
    expect(allocateDeterministicRefunds(facts({
      refunds: [refund('refund-1', 500)],
      existingAllocations: [
        { refundId: 'refund-1', orderItemId: 'item-a', amountMinor: 501 }
      ]
    }))).toEqual({ state: 'exception', allocations: [] });
  });

  it('does not allocate pending, failed, or canceled refunds', () => {
    expect(allocateDeterministicRefunds(facts({
      refunds: [
        refund('refund-1', 200, { status: 'pending' }),
        refund('refund-2', 300, { status: 'failed' }),
        refund('refund-3', 400, { status: 'canceled' })
      ]
    }))).toEqual({ state: 'noop', allocations: [] });
  });

  it('rejects refunds and items in different currencies', () => {
    expect(allocateDeterministicRefunds(facts({
      refunds: [refund('refund-1', 1403, { currency: 'EUR' })]
    }))).toEqual({ state: 'exception', allocations: [] });
    expect(allocateDeterministicRefunds(facts({
      items: [item('item-a', 1000), { ...item('item-b', 500), currency: 'EUR' }],
      refunds: [refund('refund-1', 1500)]
    }))).toEqual({ state: 'exception', allocations: [] });
  });
});
