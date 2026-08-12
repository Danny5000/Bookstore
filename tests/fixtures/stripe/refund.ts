import type { RefundSnapshot } from '$lib/server/commerce/stripe/types';

export function refundSnapshotFixture(
  overrides: Partial<RefundSnapshot> = {}
): RefundSnapshot {
  return {
    providerRefundId: 're_test_fixture_101',
    paymentIntentId: 'pi_test_fixture_101',
    liveMode: false,
    state: 'succeeded',
    amountMinor: 1403,
    currency: 'usd',
    reason: 'requested_by_customer',
    providerCreatedAt: new Date('2026-08-10T13:00:00.000Z'),
    balanceTransactionId: 'txn_test_refund_101',
    failureBalanceTransactionId: null,
    ...overrides
  };
}
