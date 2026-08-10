import { describe, expect, it } from 'vitest';
import { PermanentCommerceError } from './errors';
import {
  claimRequestScopeDigest,
  deriveClaimedPurchaseGrantState
} from './claims';

function facts(overrides: Record<string, unknown> = {}) {
  return {
    permanentlyRevoked: false,
    paymentStatus: 'succeeded' as const,
    itemTotalMinor: 1403,
    succeededRefundAllocatedMinor: 0,
    disputeStates: [] as Array<'open' | 'won' | 'lost'>,
    ...overrides
  };
}

describe('claimed purchase grant derivation', () => {
  it('activates a succeeded paid item with no adverse state', () => {
    expect(deriveClaimedPurchaseGrantState(facts())).toBe('active');
    expect(deriveClaimedPurchaseGrantState(facts({ disputeStates: ['won'] }))).toBe('active');
  });

  it('preserves permanent revocation above every other fact', () => {
    expect(deriveClaimedPurchaseGrantState(facts({
      permanentlyRevoked: true,
      disputeStates: ['won', 'open']
    }))).toBe('revoked');
  });

  it('revokes a fully refunded item even when every dispute was won', () => {
    expect(deriveClaimedPurchaseGrantState(facts({
      succeededRefundAllocatedMinor: 1403,
      disputeStates: ['won', 'won']
    }))).toBe('revoked');
  });

  it('reduces multiple disputes by lost then open precedence, not order', () => {
    expect(deriveClaimedPurchaseGrantState(facts({
      disputeStates: ['open', 'won', 'lost']
    }))).toBe('revoked');
    expect(deriveClaimedPurchaseGrantState(facts({
      disputeStates: ['lost', 'won', 'open']
    }))).toBe('revoked');
    expect(deriveClaimedPurchaseGrantState(facts({
      disputeStates: ['won', 'open', 'won']
    }))).toBe('suspended');
  });

  it('keeps a non-succeeded payment unclaimed without adverse facts', () => {
    expect(deriveClaimedPurchaseGrantState(facts({ paymentStatus: 'pending' })))
      .toBe('unclaimed');
    expect(deriveClaimedPurchaseGrantState(facts({ paymentStatus: 'failed' })))
      .toBe('unclaimed');
  });

  it.each([
    { itemTotalMinor: 0 },
    { itemTotalMinor: 10.5 },
    { succeededRefundAllocatedMinor: -1 },
    { succeededRefundAllocatedMinor: 1404 },
    { disputeStates: ['unknown'] }
  ])('rejects incomplete or impossible local facts', (overrides) => {
    expect(() => deriveClaimedPurchaseGrantState(facts(overrides)))
      .toThrow(PermanentCommerceError);
  });
});

describe('claim request scope', () => {
  it('HMACs normalized email and request IP without exposing either value', () => {
    const first = claimRequestScopeDigest({
      email: ' Reader@Example.COM ',
      requestIp: ' 203.0.113.41 ',
      applicationSecret: 'application-secret-that-is-long-enough'
    });
    const same = claimRequestScopeDigest({
      email: 'reader@example.com',
      requestIp: '203.0.113.41',
      applicationSecret: 'application-secret-that-is-long-enough'
    });
    expect(first).toBe(same);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toMatch(/reader|example|203\.0\.113/iu);
    expect(claimRequestScopeDigest({
      email: 'other@example.com',
      requestIp: '203.0.113.41',
      applicationSecret: 'application-secret-that-is-long-enough'
    })).not.toBe(first);
    expect(claimRequestScopeDigest({
      email: 'reader@example.com',
      requestIp: '203.0.113.42',
      applicationSecret: 'application-secret-that-is-long-enough'
    })).not.toBe(first);
  });

  it.each([
    { email: 'not-an-email', requestIp: '203.0.113.41', applicationSecret: 'secret' },
    { email: 'reader@example.com', requestIp: '', applicationSecret: 'secret' },
    { email: 'reader@example.com', requestIp: '203.0.113.41', applicationSecret: '' }
  ])('rejects invalid scope input', (input) => {
    expect(() => claimRequestScopeDigest(input)).toThrow(PermanentCommerceError);
  });
});
