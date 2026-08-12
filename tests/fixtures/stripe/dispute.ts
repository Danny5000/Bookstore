import type { DisputeSnapshot } from '$lib/server/commerce/stripe/types';

export function disputeSnapshotFixture(
  overrides: Partial<DisputeSnapshot> = {}
): DisputeSnapshot {
  return {
    providerDisputeId: 'dp_test_fixture_101',
    paymentIntentId: 'pi_test_fixture_101',
    chargeId: 'ch_test_fixture_101',
    liveMode: false,
    state: 'open',
    amountMinor: 1403,
    currency: 'usd',
    reason: 'fraudulent',
    providerCreatedAt: new Date('2026-08-10T14:00:00.000Z'),
    balanceTransactionIds: ['txn_test_dispute_withdrawal_101'],
    ...overrides
  };
}
