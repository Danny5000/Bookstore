import type { VerifiedStripeEvent } from '$lib/server/commerce/stripe/types';

export const FIXTURE_WEBHOOK_SIGNATURE = 'fixture-signature-v1';
export const FIXTURE_WEBHOOK_BODY = new TextEncoder().encode(
  '{"id":"evt_test_fixture_101","type":"checkout.session.completed"}'
);

export function verifiedEventFixture(
  overrides: Partial<VerifiedStripeEvent> = {}
): VerifiedStripeEvent {
  return {
    providerEventId: 'evt_test_fixture_101',
    type: 'checkout.session.completed',
    objectId: 'cs_test_fixture_101',
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: new Date('2026-08-10T12:02:00.000Z'),
    rawBodySha256: 'a'.repeat(64),
    ...overrides
  };
}
