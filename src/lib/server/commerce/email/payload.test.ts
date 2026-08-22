import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  COMMERCE_EMAIL_TOPIC,
  parseCommerceEmailPayload
} from './payload';
import { wrapCommerceClaimActionUrl } from '$lib/server/auth/commerce-claim-capability';

const origin = 'https://books.example.com';

function commerceClaimBridgeUrl(trustedOrigin = origin): string {
  const orderId = randomUUID();
  const action = new URL('/api/auth/magic-link/verify', trustedOrigin);
  action.searchParams.set('token', 'native-token');
  action.searchParams.set('callbackURL', '/claim/complete');
  action.searchParams.set('errorCallbackURL', '/claim/complete?error=magic-link');
  action.searchParams.set('newUserCallbackURL', '/claim/complete');
  return wrapCommerceClaimActionUrl({
    actionUrl: action.toString(),
    claimProofToken: 'a'.repeat(43),
    anchorOrderId: orderId,
    kind: 'commerce-magic',
    trustedOrigin
  });
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    template: 'commerce.account-receipt',
    to: ' Reader@Example.COM ',
    messageId: randomUUID(),
    orderNumber: randomUUID(),
    orderDate: '2026-08-10T12:05:00.000Z',
    currency: 'USD',
    subtotalMinor: 2299,
    taxMinor: 184,
    totalMinor: 2483,
    items: [
      { title: 'First Book', creatorName: 'Writer', format: 'prose' },
      { title: 'Second Comic', creatorName: 'Artist', format: 'comic' }
    ],
    ...overrides
  };
}

function access(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    template: 'commerce.refund-access-changed',
    to: 'reader@example.com',
    messageId: randomUUID(),
    reasonCategory: 'refund_completed',
    affectedTitleCount: 2,
    libraryUrl: `${origin}/library`,
    helpUrl: `${origin}/help`,
    ...overrides
  };
}

function administrativeRecoveryAccess(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    template: 'commerce.administrative-recovery-access-changed',
    to: ' Reader@Example.COM ',
    messageId: randomUUID(),
    soldAsTitle: '  The Recovered Book  ',
    accessState: 'active',
    ...overrides
  };
}

describe('strict commerce email payloads', () => {
  it('normalizes a bounded account receipt and exposes the versioned topic', () => {
    expect(COMMERCE_EMAIL_TOPIC).toBe('email.commerce.v1');
    expect(parseCommerceEmailPayload(receipt(), origin)).toMatchObject({
      version: 1,
      template: 'commerce.account-receipt',
      to: 'reader@example.com',
      currency: 'USD',
      subtotalMinor: 2299,
      taxMinor: 184,
      totalMinor: 2483
    });
  });

  it('accepts only an exact same-origin secure or loopback claim bridge', () => {
    const claimUrl = commerceClaimBridgeUrl();
    expect(parseCommerceEmailPayload(receipt({
      template: 'commerce.guest-receipt-claim',
      claimUrl
    }), origin)).toMatchObject({
      template: 'commerce.guest-receipt-claim',
      claimUrl
    });
    expect(() => parseCommerceEmailPayload(receipt({
      template: 'commerce.guest-receipt-claim',
      claimUrl: 'https://evil.example/claim'
    }), origin)).toThrow();
    const loopback = 'http://127.0.0.1:5173';
    expect(() => parseCommerceEmailPayload(receipt({
      template: 'commerce.guest-receipt-claim',
      claimUrl: commerceClaimBridgeUrl(loopback)
    }), loopback)).not.toThrow();

    const unexpectedQuery = new URL(claimUrl);
    unexpectedQuery.searchParams.set('leak', 'bearer');
    const malformedFragment = new URL(claimUrl);
    malformedFragment.hash = 'proof=' + 'a'.repeat(43);
    const nativeAction = new URL('/api/auth/magic-link/verify', origin);
    nativeAction.searchParams.set('token', 'native-token');
    for (const invalid of [
      unexpectedQuery.toString(),
      malformedFragment.toString(),
      nativeAction.toString()
    ]) {
      expect(() => parseCommerceEmailPayload(receipt({
        template: 'commerce.guest-receipt-claim',
        claimUrl: invalid
      }), origin)).toThrow();
    }
  });

  it('accepts minimized refund and dispute access-change payloads', () => {
    expect(parseCommerceEmailPayload(access(), origin)).toMatchObject({
      template: 'commerce.refund-access-changed',
      reasonCategory: 'refund_completed',
      affectedTitleCount: 2
    });
    expect(parseCommerceEmailPayload(access({
      template: 'commerce.dispute-access-changed',
      reasonCategory: 'dispute_opened'
    }), origin)).toMatchObject({
      template: 'commerce.dispute-access-changed',
      reasonCategory: 'dispute_opened'
    });
  });

  it('accepts only the minimized administrative-recovery dispatch payload', () => {
    const messageId = randomUUID();
    expect(parseCommerceEmailPayload(administrativeRecoveryAccess({ messageId }), origin))
      .toEqual({
        version: 1,
        template: 'commerce.administrative-recovery-access-changed',
        to: 'reader@example.com',
        messageId,
        soldAsTitle: 'The Recovered Book',
        accessState: 'active'
      });
    expect(parseCommerceEmailPayload(administrativeRecoveryAccess({
      accessState: 'revoked'
    }), origin)).toMatchObject({ accessState: 'revoked' });
  });

  it.each([
    ['administrator identity', { administratorId: randomUUID() }],
    ['recovery grant identifier', { recoveryGrantId: randomUUID() }],
    ['transition timestamp', { stateChangedAt: '2026-08-22T12:34:56.789Z' }],
    ['provider identifier', { providerId: 'pi_secret' }],
    ['amount', { amountMinor: 1299 }],
    ['action URL', { actionUrl: `${origin}/admin/recovery` }],
    ['library URL', { libraryUrl: `${origin}/library` }],
    ['help URL', { helpUrl: `${origin}/help` }]
  ])('rejects administrative-recovery payload data not needed for dispatch: %s',
    (_label, extra) => {
      expect(() => parseCommerceEmailPayload(
        administrativeRecoveryAccess(extra),
        origin
      )).toThrow();
    });

  it.each([
    ['non-canonical event UUID', { messageId: randomUUID().toUpperCase() }],
    ['unknown access state', { accessState: 'suspended' }],
    ['blank sold-as title', { soldAsTitle: '   ' }]
  ])('rejects malformed administrative-recovery payload content: %s',
    (_label, overrides) => {
      expect(() => parseCommerceEmailPayload(
        administrativeRecoveryAccess(overrides),
        origin
      )).toThrow();
    });

  it.each([
    ['unknown field', receipt({ unknown: true })],
    ['raw provider object', receipt({ provider: { id: 'pi_secret' } })],
    ['signature', receipt({ signature: 'whsec_secret' })],
    ['billing', receipt({ billing: { address: 'private' } })],
    ['card', receipt({ card: { last4: '4242' } })],
    ['Checkout URL', receipt({ checkoutUrl: 'https://checkout.stripe.com/private' })],
    ['receipt URL', receipt({ receiptUrl: 'https://pay.stripe.com/private' })],
    ['storage URL', receipt({ storageUrl: `${origin}/media/private/book.epub` })],
    ['private catalog metadata', receipt({ revisionId: randomUUID() })],
    ['unbounded items', receipt({
      items: Array.from({ length: 26 }, (_, index) => ({
        title: `Book ${index}`,
        creatorName: 'Writer',
        format: 'prose'
      }))
    })],
    ['mismatched total', receipt({ totalMinor: 2484 })],
    ['external library URL', access({ libraryUrl: 'https://evil.example/library' })],
    ['media help URL', access({ helpUrl: `${origin}/media/private` })],
    ['refund provider reason', access({ reasonCategory: 'fraudulent' })]
  ])('rejects sensitive, unsafe, or unbounded content: %s', (_label, value) => {
    expect(() => parseCommerceEmailPayload(value, origin)).toThrow();
  });
});
