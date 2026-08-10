import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  COMMERCE_EMAIL_TOPIC,
  parseCommerceEmailPayload
} from './payload';

const origin = 'https://books.example.com';

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

  it('accepts only a same-origin secure or loopback claim action', () => {
    const claimUrl = `${origin}/api/auth/magic-link/verify?token=safe&callbackURL=%2Fclaim%2Fcomplete`;
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
      claimUrl: `${loopback}/api/auth/magic-link/verify?token=safe`
    }), loopback)).not.toThrow();
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
