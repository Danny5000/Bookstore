import { describe, expect, it } from 'vitest';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import { balanceTransactionSnapshotFixture } from '../../../../../tests/fixtures/stripe/balance-transaction';
import { chargeSnapshotFixture } from '../../../../../tests/fixtures/stripe/charge';
import { payoutSnapshotFixture } from '../../../../../tests/fixtures/stripe/payout';
import {
  parseBalanceTransactionSnapshot,
  parseChargeSnapshot,
  parsePayoutSnapshot,
  parseStripeListPage,
  parseStripePageRequest
} from './financial-schemas';

describe('canonical Stripe financial schemas', () => {
  const parseCharge = (value: unknown) => parseChargeSnapshot(value, false);
  const parseBalanceTransaction = (value: unknown) =>
    parseBalanceTransactionSnapshot(value, false);
  const parsePayout = (value: unknown) => parsePayoutSnapshot(value, false);

  it('accepts only the exact minimized canonical DTO keys', () => {
    const charge = parseCharge(chargeSnapshotFixture());
    const transaction = parseBalanceTransaction(balanceTransactionSnapshotFixture());
    const payout = parsePayout(payoutSnapshotFixture());
    expect(Object.keys(charge).sort()).toEqual([
      'amountMinor', 'amountRefundedMinor', 'balanceTransactionId', 'createdAt', 'currency',
      'id', 'livemode', 'paymentIntentId', 'status'
    ]);
    expect(Object.keys(transaction).sort()).toEqual([
      'amountMinor', 'availableAt', 'balanceType', 'createdAt', 'currency', 'exchangeRate',
      'exchangeSourceCurrency', 'exchangeTargetCurrency', 'feeDetails', 'feeMinor', 'id',
      'livemode', 'netMinor', 'rawType', 'reportingCategory', 'sourceFamily', 'sourceId', 'status'
    ]);
    expect(Object.keys(transaction.feeDetails[0]!).sort()).toEqual([
      'amountMinor', 'currency', 'ordinal', 'rawType'
    ]);
    expect(Object.keys(payout).sort()).toEqual([
      'amountMinor', 'arrivalAt', 'automatic', 'balanceTransactionId', 'createdAt', 'currency',
      'failureBalanceTransactionId', 'id', 'livemode', 'method', 'originalPayoutId',
      'reconciliationStatus', 'reversedByPayoutId', 'safeFailureCode', 'status'
    ]);

    for (const value of [
      { ...chargeSnapshotFixture(), customer: 'cus_private' },
      { ...balanceTransactionSnapshotFixture(), description: 'private' },
      { ...payoutSnapshotFixture(), failureMessage: 'private' }
    ]) {
      expect(() => parseCharge(value)).toThrow(PermanentCommerceError);
      expect(() => parseBalanceTransaction(value)).toThrow(PermanentCommerceError);
      expect(() => parsePayout(value)).toThrow(PermanentCommerceError);
    }
  });

  it.each([
    ['malformed charge ID', chargeSnapshotFixture({ id: 'bad id' })],
    ['noncanonical whitespace in a charge ID', chargeSnapshotFixture({ id: ' ch_test_fixture_101 ' })],
    ['unknown charge currency', chargeSnapshotFixture({ currency: 'ZZZ' })],
    ['negative charge amount', chargeSnapshotFixture({ amountMinor: -1 })],
    ['refunded amount over charge', chargeSnapshotFixture({ amountRefundedMinor: 1404 })],
    ['unsafe charge amount', chargeSnapshotFixture({ amountMinor: 100_000_000 })],
    ['invalid charge timestamp', chargeSnapshotFixture({ createdAt: new Date(Number.NaN) })]
  ])('rejects %s', (_label, value) => {
    expect(() => parseCharge(value)).toThrow(PermanentCommerceError);
  });

  it('rejects snapshot livemode that differs from the adapter runtime', () => {
    expect(() => parseChargeSnapshot(chargeSnapshotFixture({ livemode: true }), false))
      .toThrow(PermanentCommerceError);
    expect(() => parseBalanceTransactionSnapshot(
      balanceTransactionSnapshotFixture({ livemode: true }),
      false
    )).toThrow(PermanentCommerceError);
    expect(() => parsePayoutSnapshot(payoutSnapshotFixture({ livemode: true }), false))
      .toThrow(PermanentCommerceError);
  });

  it('accepts signed transaction and payout money while enforcing reconciliation', () => {
    expect(parseBalanceTransaction(balanceTransactionSnapshotFixture({
      amountMinor: -1403,
      feeMinor: 0,
      netMinor: -1403,
      sourceFamily: 'refund',
      sourceId: null
    }))).toMatchObject({ amountMinor: -1403, netMinor: -1403 });
    expect(parsePayout(payoutSnapshotFixture({ amountMinor: -1332 })))
      .toMatchObject({ amountMinor: -1332 });

    expect(() => parseBalanceTransaction(balanceTransactionSnapshotFixture({
      netMinor: 1333
    }))).toThrow(PermanentCommerceError);
    expect(() => parseBalanceTransaction(balanceTransactionSnapshotFixture({
      feeMinor: -1,
      netMinor: 1404
    }))).toThrow(PermanentCommerceError);
    expect(() => parseBalanceTransaction(balanceTransactionSnapshotFixture({
      feeDetails: [
        { ordinal: 0, rawType: 'stripe_fee', amountMinor: 35, currency: 'USD' },
        { ordinal: 0, rawType: 'tax', amountMinor: 36, currency: 'USD' }
      ]
    }))).toThrow(PermanentCommerceError);
  });

  it('accepts only complete canonical exact-decimal FX evidence', () => {
    expect(parseBalanceTransaction(balanceTransactionSnapshotFixture({
      exchangeRate: '1.250000000000000000',
      exchangeSourceCurrency: 'EUR',
      exchangeTargetCurrency: 'USD'
    }))).toMatchObject({ exchangeRate: '1.250000000000000000' });

    for (const overrides of [
      { exchangeRate: '0', exchangeSourceCurrency: 'EUR', exchangeTargetCurrency: 'USD' },
      { exchangeRate: '01.25', exchangeSourceCurrency: 'EUR', exchangeTargetCurrency: 'USD' },
      { exchangeRate: '1.2500', exchangeSourceCurrency: null, exchangeTargetCurrency: 'USD' },
      { exchangeRate: '1.25', exchangeSourceCurrency: 'USD', exchangeTargetCurrency: 'USD' },
      { exchangeRate: '1.25', exchangeSourceCurrency: 'EUR', exchangeTargetCurrency: 'GBP' },
      { exchangeRate: '1.1234567890123456789', exchangeSourceCurrency: 'EUR', exchangeTargetCurrency: 'USD' },
      { exchangeRate: '123456789012345678901', exchangeSourceCurrency: 'EUR', exchangeTargetCurrency: 'USD' }
    ]) {
      expect(() => parseBalanceTransaction(
        balanceTransactionSnapshotFixture(overrides)
      )).toThrow(PermanentCommerceError);
    }
  });

  it('validates payout lifecycle/linkage without retaining unsafe failure detail', () => {
    expect(() => parsePayout(payoutSnapshotFixture({
      balanceTransactionId: 'txn_same',
      failureBalanceTransactionId: 'txn_same'
    }))).toThrow(PermanentCommerceError);
    expect(() => parsePayout(payoutSnapshotFixture({ safeFailureCode: 'card declined' })))
      .toThrow(PermanentCommerceError);
    expect(() => parsePayout(payoutSnapshotFixture({
      originalPayoutId: 'po_test_fixture_101'
    }))).toThrow(PermanentCommerceError);
    expect(() => parsePayout(payoutSnapshotFixture({ arrivalAt: new Date(Number.NaN) })))
      .toThrow(PermanentCommerceError);
  });

  it('validates bounded opaque page requests and terminal continuations', () => {
    expect(parseStripePageRequest({ limit: 100, startingAfter: 'txn_cursor', createdGte: 1, createdLt: 2 }))
      .toEqual({ limit: 100, startingAfter: 'txn_cursor', createdGte: 1, createdLt: 2 });
    for (const request of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: 1, startingAfter: 'x'.repeat(256) },
      { limit: 1, startingAfter: ' txn_cursor ' },
      { limit: 1, createdGte: 2, createdLt: 2 }
    ]) expect(() => parseStripePageRequest(request)).toThrow(PermanentCommerceError);

    const page = {
      data: [balanceTransactionSnapshotFixture()],
      hasMore: false,
      nextStartingAfter: null
    };
    expect(parseStripeListPage(page, parseBalanceTransaction)).toEqual(page);
    expect(() => parseStripeListPage({ ...page, hasMore: true }, parseBalanceTransaction))
      .toThrow(PermanentCommerceError);
    expect(() => parseStripeListPage({ ...page, nextStartingAfter: 'txn_extra' }, parseBalanceTransaction))
      .toThrow(PermanentCommerceError);
  });
});
