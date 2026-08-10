import { describe, expect, it } from 'vitest';
import { PermanentCommerceError } from './errors';
import {
  SUPPORTED_STRIPE_EVENT_TYPES,
  describeSupportedStripeEvent
} from './webhooks';
import type { VerifiedStripeEvent } from './stripe/types';

function event(type: string, objectId: string): VerifiedStripeEvent {
  return {
    providerEventId: 'evt_test_webhook_101',
    type,
    objectId,
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: new Date('2026-08-10T12:00:00.000Z'),
    rawBodySha256: 'a'.repeat(64)
  };
}

describe('supported Stripe event minimization', () => {
  it('freezes every supported lifecycle type and retrieval mapping', () => {
    expect(SUPPORTED_STRIPE_EVENT_TYPES).toEqual([
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed',
      'checkout.session.expired',
      'refund.created',
      'refund.updated',
      'refund.failed',
      'charge.dispute.created',
      'charge.dispute.updated',
      'charge.dispute.closed',
      'charge.dispute.funds_withdrawn',
      'charge.dispute.funds_reinstated'
    ]);
    expect(Object.isFrozen(SUPPORTED_STRIPE_EVENT_TYPES)).toBe(true);
    for (const type of SUPPORTED_STRIPE_EVENT_TYPES) {
      const isCheckout = type.startsWith('checkout.');
      const isRefund = type.startsWith('refund.');
      const descriptor = describeSupportedStripeEvent(event(
        type,
        isCheckout ? 'cs_test_101' : isRefund ? 're_test_101' : 'dp_test_101'
      ));
      expect(descriptor).toMatchObject({
        objectFamily: isCheckout ? 'checkout_session' : isRefund ? 'refund' : 'dispute',
        retrievalMethod: isCheckout
          ? 'retrieveCheckoutSession'
          : isRefund
            ? 'retrieveRefund'
            : 'retrieveDispute'
      });
    }
  });

  it('returns a seven-field minimized event with no provider payload detail', () => {
    const source = {
      ...event('checkout.session.completed', 'cs_test_101'),
      customerEmail: 'private@example.com',
      amount: 1234,
      card: { last4: '4242' }
    };
    const descriptor = describeSupportedStripeEvent(source);
    expect(descriptor?.event).toEqual(event('checkout.session.completed', 'cs_test_101'));
    expect(Object.keys(descriptor!.event).sort()).toEqual([
      'apiVersion',
      'liveMode',
      'objectId',
      'providerCreatedAt',
      'providerEventId',
      'rawBodySha256',
      'type'
    ]);
    expect(JSON.stringify(descriptor)).not.toMatch(/private@example|1234|4242|card/iu);
  });

  it('acknowledges valid unsupported types without creating a descriptor', () => {
    expect(describeSupportedStripeEvent(event('customer.created', 'cus_test_101'))).toBeNull();
  });

  it('rejects supported type/object-family mismatches and malformed canonical fields', () => {
    expect(() => describeSupportedStripeEvent(
      event('checkout.session.completed', 're_wrong_family')
    )).toThrow(PermanentCommerceError);
    expect(() => describeSupportedStripeEvent({
      ...event('refund.created', 're_test_101'),
      rawBodySha256: 'bad'
    })).toThrow(PermanentCommerceError);
  });
});
