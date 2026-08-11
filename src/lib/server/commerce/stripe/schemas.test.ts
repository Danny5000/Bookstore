import { describe, expect, it } from 'vitest';
import { checkoutSnapshotFixture, createdCheckoutFixture } from '../../../../../tests/fixtures/stripe/checkout';
import { disputeSnapshotFixture } from '../../../../../tests/fixtures/stripe/dispute';
import { paymentSnapshotFixture } from '../../../../../tests/fixtures/stripe/payment';
import { refundSnapshotFixture } from '../../../../../tests/fixtures/stripe/refund';
import { verifiedEventFixture } from '../../../../../tests/fixtures/stripe/events';
import {
  normalizeDisputeReason,
  normalizeDisputeState,
  normalizePaymentMethodCategory,
  normalizePaymentState,
  normalizeRefundReason,
  normalizeRefundState,
  createCheckoutSessionInputSchema,
  parseCheckoutSnapshot,
  parseCreatedCheckoutSession,
  parseDisputeSnapshot,
  parsePaymentSnapshot,
  parseRefundSnapshot,
  parseVerifiedStripeEvent
} from './schemas';

describe('canonical Stripe boundary schemas', () => {
  it('accepts only complete strict canonical snapshots', () => {
    expect(parseCreatedCheckoutSession(createdCheckoutFixture())).toEqual(createdCheckoutFixture());
    expect(parseCheckoutSnapshot(checkoutSnapshotFixture())).toEqual(checkoutSnapshotFixture());
    expect(parsePaymentSnapshot(paymentSnapshotFixture())).toEqual(paymentSnapshotFixture());
    expect(parseRefundSnapshot(refundSnapshotFixture())).toEqual(refundSnapshotFixture());
    expect(parseDisputeSnapshot(disputeSnapshotFixture())).toEqual(disputeSnapshotFixture());
    expect(parseVerifiedStripeEvent(verifiedEventFixture())).toEqual(verifiedEventFixture());

    expect(() => parsePaymentSnapshot({ ...paymentSnapshotFixture(), last4: '4242' })).toThrow();
    expect(() => parseRefundSnapshot({ ...refundSnapshotFixture(), billingEmail: 'private@example.com' })).toThrow();
  });

  it('uses the Stripe event time, not an invented Dispute update timestamp', () => {
    const snapshot = {
      providerDisputeId: 'dp_test_fixture_101',
      paymentIntentId: 'pi_test_fixture_101',
      chargeId: 'ch_test_fixture_101',
      liveMode: false,
      state: 'open' as const,
      amountMinor: 1403,
      currency: 'usd',
      reason: 'fraudulent',
      providerCreatedAt: new Date('2026-08-10T14:00:00.000Z')
    };
    expect(parseDisputeSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parseDisputeSnapshot({
      ...snapshot,
      providerUpdatedAt: new Date('2026-08-10T14:01:00.000Z')
    })).toThrow();
  });

  it.each([
    ['float money', checkoutSnapshotFixture({ subtotalMinor: 12.5 })],
    ['unsafe money', checkoutSnapshotFixture({ subtotalMinor: Number.MAX_SAFE_INTEGER + 1 })],
    ['unknown currency', checkoutSnapshotFixture({ currency: 'zzz' })],
    ['unsupported Stripe charge-unit exception', checkoutSnapshotFixture({
      currency: 'isk',
      lineItems: checkoutSnapshotFixture().lineItems.map((line) => ({ ...line, currency: 'isk' }))
    })],
    ['unknown status', { ...checkoutSnapshotFixture(), status: 'refunded' }],
    ['missing ID', { ...checkoutSnapshotFixture(), providerSessionId: '' }],
    ['too many lines', checkoutSnapshotFixture({ lineItems: Array.from({ length: 26 }, (_, index) => ({
      ...checkoutSnapshotFixture().lineItems[0]!,
      providerLineItemId: `li_${index}`,
      orderItemId: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`
    })) })],
    ['duplicate order item', checkoutSnapshotFixture({ lineItems: [
      checkoutSnapshotFixture().lineItems[0]!,
      { ...checkoutSnapshotFixture().lineItems[0]!, providerLineItemId: 'li_other' }
    ] })]
  ])('rejects %s', (_label, value) => {
    expect(() => parseCheckoutSnapshot(value)).toThrow();
  });

  it('normalizes provider lifecycle states exhaustively', () => {
    for (const state of ['processing', 'requires_action', 'requires_confirmation', 'requires_capture']) {
      expect(normalizePaymentState(state)).toBe('pending');
    }
    expect(normalizePaymentState('succeeded')).toBe('succeeded');
    expect(normalizePaymentState('canceled')).toBe('failed');
    expect(normalizePaymentState('requires_payment_method')).toBe('failed');
    expect(() => normalizePaymentState('mystery')).toThrow();

    expect(normalizeRefundState('requires_action')).toBe('pending');
    expect(normalizeRefundState('pending')).toBe('pending');
    expect(normalizeRefundState('succeeded')).toBe('succeeded');
    expect(normalizeRefundState('failed')).toBe('failed');
    expect(normalizeRefundState('canceled')).toBe('canceled');
    expect(() => normalizeRefundState('mystery')).toThrow();

    for (const state of ['warning_needs_response', 'warning_under_review', 'needs_response', 'under_review']) {
      expect(normalizeDisputeState(state)).toBe('open');
    }
    expect(normalizeDisputeState('won')).toBe('won');
    expect(normalizeDisputeState('warning_closed')).toBe('won');
    expect(normalizeDisputeState('prevented')).toBe('won');
    expect(normalizeDisputeState('lost')).toBe('lost');
    expect(() => normalizeDisputeState('mystery')).toThrow();
  });

  it('reduces payment and reason detail to bounded safe categories', () => {
    expect(normalizePaymentMethodCategory('card')).toBe('card');
    expect(normalizePaymentMethodCategory('link')).toBe('link');
    expect(normalizePaymentMethodCategory('cashapp')).toBe('cashapp');
    expect(normalizePaymentMethodCategory('amazon_pay')).toBe('amazon_pay');
    expect(normalizePaymentMethodCategory('customer_balance')).toBe('other');
    expect(normalizePaymentMethodCategory(null)).toBeNull();
    expect(normalizeRefundReason('duplicate')).toBe('duplicate');
    expect(normalizeRefundReason('expired_uncaptured_charge')).toBe('other');
    expect(normalizeDisputeReason('fraudulent')).toBe('fraudulent');
    expect(normalizeDisputeReason('provider_private_detail')).toBe('other');
  });

  it('rejects empty provider sessions and duplicate or untaxed checkout inputs', () => {
    expect(() => parseCheckoutSnapshot(checkoutSnapshotFixture({
      subtotalMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
      lineItems: []
    }))).toThrow();
    const input = {
      orderId: '00000000-0000-4000-8000-000000000101',
      accountEmail: null,
      currency: 'usd',
      automaticTaxEnabled: true,
      expiresAt: new Date('2026-08-10T12:30:00.000Z'),
      successUrl: 'https://books.example.com/checkout/success',
      cancelUrl: 'https://books.example.com/checkout/cancel',
      items: [
        { orderItemId: '00000000-0000-4000-8000-000000000102', title: 'One', format: 'prose', unitSubtotalMinor: 100, taxCode: null },
        { orderItemId: '00000000-0000-4000-8000-000000000102', title: 'Two', format: 'comic', unitSubtotalMinor: 200, taxCode: null }
      ]
    };
    expect(createCheckoutSessionInputSchema.safeParse(input).success).toBe(false);
  });

  it('caps every canonical provider amount at the hard Stripe snapshot ceiling', () => {
    const overProviderCeiling = 100_000_000;
    expect(() => parseCheckoutSnapshot(checkoutSnapshotFixture({
      subtotalMinor: overProviderCeiling,
      taxMinor: 0,
      totalMinor: overProviderCeiling,
      lineItems: checkoutSnapshotFixture().lineItems.map((line) => ({
        ...line,
        subtotalMinor: overProviderCeiling,
        taxMinor: 0,
        totalMinor: overProviderCeiling
      }))
    }))).toThrow();
    expect(() => parsePaymentSnapshot(paymentSnapshotFixture({ amountMinor: overProviderCeiling }))).toThrow();
    expect(() => parseRefundSnapshot(refundSnapshotFixture({ amountMinor: overProviderCeiling }))).toThrow();
    expect(() => parseDisputeSnapshot(disputeSnapshotFixture({ amountMinor: overProviderCeiling }))).toThrow();
  });

  it('accepts 25 items at the checkout subtotal ceiling and rejects aggregate overflow', () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      orderItemId: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
      title: `Title ${index + 1}`,
      format: 'prose' as const,
      unitSubtotalMinor: index === 0 ? 1_999_999 : 2_000_000,
      taxCode: 'txcd_10000000'
    }));
    const input = {
      orderId: '00000000-0000-4000-8000-000000000101',
      accountEmail: null,
      currency: 'usd',
      automaticTaxEnabled: true,
      expiresAt: new Date('2026-08-10T12:30:00.000Z'),
      successUrl: 'https://books.example.com/checkout/success',
      cancelUrl: 'https://books.example.com/checkout/cancel',
      items
    };

    expect(createCheckoutSessionInputSchema.safeParse(input).success).toBe(true);
    expect(createCheckoutSessionInputSchema.safeParse({
      ...input,
      items: items.map((item, index) =>
        index === 0 ? { ...item, unitSubtotalMinor: 2_000_000 } : item
      )
    }).success).toBe(false);
  });
});
