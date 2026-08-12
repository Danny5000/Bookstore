import type { PayoutSnapshot } from '$lib/server/commerce/stripe/types';

export function payoutSnapshotFixture(
  overrides: Partial<PayoutSnapshot> = {}
): PayoutSnapshot {
  return {
    id: 'po_test_fixture_101',
    livemode: false,
    amountMinor: 1332,
    currency: 'USD',
    automatic: true,
    method: 'standard',
    status: 'paid',
    reconciliationStatus: 'completed',
    createdAt: new Date('2026-08-12T15:00:00.000Z'),
    arrivalAt: new Date('2026-08-14T00:00:00.000Z'),
    balanceTransactionId: 'txn_test_payout_101',
    failureBalanceTransactionId: null,
    originalPayoutId: null,
    reversedByPayoutId: null,
    safeFailureCode: null,
    ...overrides
  };
}
