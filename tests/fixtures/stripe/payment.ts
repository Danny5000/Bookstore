import type { PaymentSnapshot } from '$lib/server/commerce/stripe/types';

export function paymentSnapshotFixture(
  overrides: Partial<PaymentSnapshot> = {}
): PaymentSnapshot {
  return {
    paymentIntentId: 'pi_test_fixture_101',
    metadataVersion: '1',
    metadataOrderId: '00000000-0000-4000-8000-000000000101',
    latestChargeId: 'ch_test_fixture_101',
    liveMode: false,
    state: 'succeeded',
    amountMinor: 1403,
    currency: 'usd',
    paidAt: new Date('2026-08-10T12:01:00.000Z'),
    paymentMethodCategory: 'card',
    ...overrides
  };
}
