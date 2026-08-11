import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OrderItemRow, OrderRow } from '$lib/server/db/schema';
import {
  checkoutSnapshotFixture,
  FIXTURE_ORDER_ID,
  FIXTURE_ORDER_ITEM_ID
} from '../../../../tests/fixtures/stripe/checkout';
import { paymentSnapshotFixture } from '../../../../tests/fixtures/stripe/payment';
import { PermanentCommerceError } from './errors';
import { validateFulfillmentCommand } from './fulfillment';

const createdAt = new Date('2026-08-10T12:00:00.000Z');
const accountUserId = randomUUID();

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: FIXTURE_ORDER_ID,
    status: 'checkout_open',
    initiatingUserId: accountUserId,
    guestIdentityId: null,
    purchaseEmail: 'reader@example.com',
    currency: 'USD',
    subtotalMinor: 1299,
    taxMinor: null,
    totalMinor: null,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: 'cs_test_fixture_101',
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides
  };
}

function item(overrides: Partial<OrderItemRow> = {}): OrderItemRow {
  return {
    id: FIXTURE_ORDER_ITEM_ID,
    orderId: FIXTURE_ORDER_ID,
    titleId: randomUUID(),
    titleSnapshot: 'Immutable Book',
    creatorNameSnapshot: 'Author',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 1299,
    taxMinor: null,
    totalMinor: null,
    stripeLineItemId: null,
    createdAt,
    ...overrides
  };
}

function validate(overrides: Record<string, unknown> = {}) {
  return validateFulfillmentCommand({
    order: order(),
    items: [item()],
    session: checkoutSnapshotFixture(),
    payment: paymentSnapshotFixture(),
    expectedLiveMode: false,
    ...overrides
  });
}

describe('canonical fulfillment validation', () => {
  it('returns a paid account command using only the stored verified email snapshot', () => {
    expect(validate()).toEqual({
      state: 'paid',
      orderId: FIXTURE_ORDER_ID,
      session: checkoutSnapshotFixture(),
      payment: paymentSnapshotFixture(),
      purchaseEmail: 'reader@example.com'
    });
  });

  it('normalizes canonical Checkout email only for a guest purchase', () => {
    const session = checkoutSnapshotFixture({ customerEmail: ' Guest@Example.COM ' });
    expect(validate({
      order: order({ initiatingUserId: null, purchaseEmail: null }),
      session
    })).toMatchObject({
      state: 'paid',
      purchaseEmail: 'guest@example.com'
    });
  });

  it('returns pending, failed, and expired commands from canonical state', () => {
    const pendingSession = checkoutSnapshotFixture({
      paymentStatus: 'unpaid', latestChargeId: null
    });
    const pendingPayment = paymentSnapshotFixture({
      state: 'pending', latestChargeId: null, paidAt: null
    });
    expect(validate({ session: pendingSession, payment: pendingPayment })).toMatchObject({
      state: 'pending', orderId: FIXTURE_ORDER_ID
    });
    const failedPayment = paymentSnapshotFixture({
      state: 'failed', latestChargeId: null, paidAt: null
    });
    expect(validate({
      session: pendingSession,
      payment: failedPayment
    })).toEqual({
      state: 'failed', orderId: FIXTURE_ORDER_ID, session: pendingSession, payment: failedPayment
    });
    const expired = checkoutSnapshotFixture({
      status: 'expired',
      paymentStatus: 'unpaid',
      paymentIntentId: null,
      latestChargeId: null
    });
    expect(validate({ session: expired, payment: null })).toEqual({
      state: 'expired', orderId: FIXTURE_ORDER_ID, session: expired
    });
  });

  it('allows canonical metadata to recover a missing local Session attachment', () => {
    expect(validate({
      order: order({
        status: 'checkout_pending',
        stripeCheckoutSessionId: null,
        checkoutExpiresAt: null
      })
    })).toMatchObject({ state: 'paid', orderId: FIXTURE_ORDER_ID });
  });

  it.each([
    ['live flag', { expectedLiveMode: true }],
    ['client reference', { session: checkoutSnapshotFixture({ clientReferenceId: randomUUID() }) }],
    ['metadata version', { session: { ...checkoutSnapshotFixture(), metadataVersion: '2' } }],
    ['metadata order', { session: checkoutSnapshotFixture({ metadataOrderId: randomUUID() }) }],
    ['attached session', { order: order({ stripeCheckoutSessionId: 'cs_test_other' }) }],
    ['attached expiry', {
      order: order({ checkoutExpiresAt: new Date('2026-08-10T12:31:00.000Z') })
    }],
    ['mode', { session: { ...checkoutSnapshotFixture(), mode: 'subscription' } }],
    ['no-payment-required', { session: checkoutSnapshotFixture({ paymentStatus: 'no_payment_required' }) }],
    ['payment intent', { payment: paymentSnapshotFixture({ paymentIntentId: 'pi_test_other' }) }],
    ['latest charge', { payment: paymentSnapshotFixture({ latestChargeId: 'ch_test_other' }) }],
    ['payment live flag', { payment: paymentSnapshotFixture({ liveMode: true }) }],
    ['session currency', { session: checkoutSnapshotFixture({ currency: 'cad' }) }],
    ['payment currency', { payment: paymentSnapshotFixture({ currency: 'cad' }) }],
    ['item currency', { items: [item({ currency: 'CAD' })] }],
    ['provider line', { items: [item({ stripeLineItemId: 'li_test_other' })] }],
    ['finalized item totals', { items: [item({ taxMinor: 105, totalMinor: 1404 })] }],
    ['finalized order totals', { order: order({ taxMinor: 105, totalMinor: 1404 }) }],
    ['subtotal', { session: checkoutSnapshotFixture({ subtotalMinor: 1300 }) }],
    ['payment total', { payment: paymentSnapshotFixture({ amountMinor: 1404 }) }],
    ['account email', { session: checkoutSnapshotFixture({ customerEmail: 'changed@example.com' }) }],
    ['missing account email', { session: checkoutSnapshotFixture({ customerEmail: null }) }],
    ['stored guest email', {
      order: order({ initiatingUserId: null, purchaseEmail: 'prior@example.com' }),
      session: checkoutSnapshotFixture({ customerEmail: 'changed@example.com' })
    }]
  ])('rejects mismatched %s', (_label, overrides) => {
    expect(() => validate(overrides)).toThrow(PermanentCommerceError);
  });

  it.each([
    ['missing line', []],
    ['duplicate line', [checkoutSnapshotFixture().lineItems[0]!, checkoutSnapshotFixture().lineItems[0]!]],
    ['extra line', [checkoutSnapshotFixture().lineItems[0]!, {
      ...checkoutSnapshotFixture().lineItems[0]!,
      providerLineItemId: 'li_test_extra',
      orderItemId: randomUUID()
    }]],
    ['wrong item metadata', [{
      ...checkoutSnapshotFixture().lineItems[0]!, orderItemId: randomUUID()
    }]],
    ['quantity', [{ ...checkoutSnapshotFixture().lineItems[0]!, quantity: 2 }]],
    ['float', [{ ...checkoutSnapshotFixture().lineItems[0]!, totalMinor: 1403.5 }]],
    ['overflow', [{ ...checkoutSnapshotFixture().lineItems[0]!, totalMinor: Number.MAX_SAFE_INTEGER + 1 }]]
  ])('rejects invalid line evidence: %s', (_label, lineItems) => {
    expect(() => validate({ session: { ...checkoutSnapshotFixture(), lineItems } })).toThrow(
      PermanentCommerceError
    );
  });
});
