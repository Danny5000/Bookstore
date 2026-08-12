import type { BalanceTransactionSnapshot } from '$lib/server/commerce/stripe/types';

export function balanceTransactionSnapshotFixture(
  overrides: Partial<BalanceTransactionSnapshot> = {}
): BalanceTransactionSnapshot {
  return {
    id: 'txn_test_charge_101',
    livemode: false,
    sourceId: 'ch_test_fixture_101',
    sourceFamily: 'charge',
    rawType: 'charge',
    reportingCategory: 'charge',
    amountMinor: 1403,
    feeMinor: 71,
    netMinor: 1332,
    currency: 'USD',
    status: 'available',
    balanceType: 'payments',
    createdAt: new Date('2026-08-10T12:01:00.000Z'),
    availableAt: new Date('2026-08-12T12:01:00.000Z'),
    exchangeRate: null,
    exchangeSourceCurrency: null,
    exchangeTargetCurrency: null,
    feeDetails: [
      { ordinal: 0, rawType: 'stripe_fee', amountMinor: 71, currency: 'USD' }
    ],
    ...overrides
  };
}
