import type { ChargeSnapshot } from '$lib/server/commerce/stripe/types';

export function chargeSnapshotFixture(
  overrides: Partial<ChargeSnapshot> = {}
): ChargeSnapshot {
  return {
    id: 'ch_test_fixture_101',
    paymentIntentId: 'pi_test_fixture_101',
    livemode: false,
    amountMinor: 1403,
    amountRefundedMinor: 0,
    currency: 'USD',
    status: 'succeeded',
    balanceTransactionId: 'txn_test_charge_101',
    createdAt: new Date('2026-08-10T12:01:00.000Z'),
    ...overrides
  };
}
