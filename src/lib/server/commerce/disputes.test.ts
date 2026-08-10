import { describe, expect, it } from 'vitest';
import { PermanentCommerceError } from './errors';
import {
  deriveDisputedPurchaseGrantState,
  normalizeDisputeReasonCategory
} from './disputes';

function facts(overrides: Record<string, unknown> = {}) {
  return {
    hasUser: true,
    permanentlyRevoked: false,
    itemTotalMinor: 1403,
    succeededRefundAllocatedMinor: 0,
    disputeStates: [] as Array<'open' | 'won' | 'lost'>,
    ...overrides
  };
}

describe('disputed purchase grant reduction', () => {
  it('revokes on any lost dispute regardless of event order or duplicates', () => {
    expect(deriveDisputedPurchaseGrantState(facts({
      disputeStates: ['open', 'won', 'lost', 'lost']
    }))).toBe('revoked');
    expect(deriveDisputedPurchaseGrantState(facts({
      disputeStates: ['lost', 'open', 'won']
    }))).toBe('revoked');
  });

  it('suspends while any canonical dispute remains open', () => {
    expect(deriveDisputedPurchaseGrantState(facts({
      disputeStates: ['won', 'open', 'won']
    }))).toBe('suspended');
  });

  it('restores a claimed grant after all disputes are canonically won', () => {
    expect(deriveDisputedPurchaseGrantState(facts({ disputeStates: ['won', 'won'] })))
      .toBe('active');
  });

  it('restores a guest grant to unclaimed rather than granting access', () => {
    expect(deriveDisputedPurchaseGrantState(facts({
      hasUser: false,
      disputeStates: ['won']
    }))).toBe('unclaimed');
  });

  it('never restores a fully refunded or permanently revoked grant', () => {
    expect(deriveDisputedPurchaseGrantState(facts({
      succeededRefundAllocatedMinor: 1403,
      disputeStates: ['won']
    }))).toBe('revoked');
    expect(deriveDisputedPurchaseGrantState(facts({
      permanentlyRevoked: true,
      disputeStates: ['won']
    }))).toBe('revoked');
  });

  it('uses current canonical won state rather than an out-of-order triggering event name', () => {
    expect(deriveDisputedPurchaseGrantState(facts({ disputeStates: ['won'] })))
      .toBe('active');
    expect(deriveDisputedPurchaseGrantState(facts({ disputeStates: ['open'] })))
      .toBe('suspended');
  });

  it.each([
    { itemTotalMinor: 0 },
    { itemTotalMinor: 1.5 },
    { succeededRefundAllocatedMinor: -1 },
    { succeededRefundAllocatedMinor: 1404 },
    { disputeStates: ['unknown'] },
    { hasUser: 'yes' }
  ])('rejects incomplete or impossible local facts', (overrides) => {
    expect(() => deriveDisputedPurchaseGrantState(facts(overrides)))
      .toThrow(PermanentCommerceError);
  });
});

describe('safe dispute reason normalization', () => {
  it.each([
    ['fraudulent', 'fraudulent'],
    ['product_not_received', 'product_not_received'],
    ['unrecognized', 'unrecognized'],
    [null, null],
    ['provider_private_narrative', 'other'],
    ['', 'other']
  ])('maps %j to %j', (input, expected) => {
    expect(normalizeDisputeReasonCategory(input)).toBe(expected);
  });
});
