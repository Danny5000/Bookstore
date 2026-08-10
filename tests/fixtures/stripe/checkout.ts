import type {
  CheckoutSnapshot,
  CreateCheckoutSessionInput,
  CreatedCheckoutSession
} from '$lib/server/commerce/stripe/types';

export const FIXTURE_ORDER_ID = '00000000-0000-4000-8000-000000000101';
export const FIXTURE_ORDER_ITEM_ID = '00000000-0000-4000-8000-000000000102';

export function checkoutInputFixture(
  overrides: Partial<CreateCheckoutSessionInput> = {}
): CreateCheckoutSessionInput {
  return {
    orderId: FIXTURE_ORDER_ID,
    accountEmail: 'reader@example.com',
    currency: 'usd',
    automaticTaxEnabled: true,
    expiresAt: new Date('2026-08-10T12:30:00.000Z'),
    successUrl: `https://books.example.com/checkout/success?order=${FIXTURE_ORDER_ID}`,
    cancelUrl: 'https://books.example.com/checkout/cancel',
    items: [{
      orderItemId: FIXTURE_ORDER_ITEM_ID,
      title: 'The Safe Book',
      format: 'prose',
      unitSubtotalMinor: 1299,
      taxCode: 'txcd_10000000'
    }],
    ...overrides
  };
}

export function createdCheckoutFixture(
  overrides: Partial<CreatedCheckoutSession> = {}
): CreatedCheckoutSession {
  return {
    providerSessionId: 'cs_test_fixture_101',
    checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_fixture_101',
    expiresAt: new Date('2026-08-10T12:30:00.000Z'),
    ...overrides
  };
}

export function checkoutSnapshotFixture(
  overrides: Partial<CheckoutSnapshot> = {}
): CheckoutSnapshot {
  return {
    providerSessionId: 'cs_test_fixture_101',
    clientReferenceId: FIXTURE_ORDER_ID,
    metadataVersion: '1',
    metadataOrderId: FIXTURE_ORDER_ID,
    liveMode: false,
    mode: 'payment',
    status: 'complete',
    paymentStatus: 'paid',
    paymentIntentId: 'pi_test_fixture_101',
    latestChargeId: 'ch_test_fixture_101',
    customerEmail: 'reader@example.com',
    currency: 'usd',
    subtotalMinor: 1299,
    taxMinor: 104,
    totalMinor: 1403,
    expiresAt: new Date('2026-08-10T12:30:00.000Z'),
    lineItems: [{
      providerLineItemId: 'li_test_fixture_101',
      orderItemId: FIXTURE_ORDER_ITEM_ID,
      quantity: 1,
      currency: 'usd',
      subtotalMinor: 1299,
      taxMinor: 104,
      totalMinor: 1403
    }],
    ...overrides
  };
}
