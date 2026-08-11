import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermanentCommerceError, RetryableProviderError } from '$lib/server/commerce/errors';
import { checkoutInputFixture, FIXTURE_ORDER_ITEM_ID } from '../../../../../tests/fixtures/stripe/checkout';
import { STRIPE_API_VERSION } from './types';

const sdk = vi.hoisted(() => {
  const client = {
    checkout: { sessions: {
      create: vi.fn(),
      retrieve: vi.fn(),
      listLineItems: vi.fn()
    } },
    paymentIntents: { retrieve: vi.fn() },
    refunds: { retrieve: vi.fn() },
    disputes: { retrieve: vi.fn() },
    webhooks: { constructEvent: vi.fn() }
  };
  return {
    client,
    Stripe: vi.fn(function StripeMock() {
      return client;
    })
  };
});

vi.mock('stripe', () => ({ default: sdk.Stripe }));

import { createStripeSdkGateway } from './sdk-gateway';

const options = {
  secretKey: 'sk_test_unit_test_only',
  webhookSecret: 'whsec_unit_test_only',
  origin: 'https://books.example.com',
  expectedLiveMode: false,
  webhookToleranceSeconds: 300
};

function rawSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_fixture_101',
    client_reference_id: '00000000-0000-4000-8000-000000000101',
    metadata: {
      pale_orbit_metadata_version: '1',
      pale_orbit_order_id: '00000000-0000-4000-8000-000000000101'
    },
    livemode: false,
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    payment_intent: {
      id: 'pi_test_fixture_101',
      latest_charge: { id: 'ch_test_fixture_101' }
    },
    customer_details: { email: ' Reader@Example.com ' },
    customer_email: 'reader@example.com',
    currency: 'usd',
    amount_subtotal: 1299,
    amount_total: 1403,
    total_details: { amount_tax: 104 },
    expires_at: 1_786_365_000,
    ...overrides
  };
}

function rawLine(
  providerLineItemId: string,
  orderItemId: string,
  amounts = { subtotal: 1299, tax: 104, total: 1403 }
) {
  return {
    id: providerLineItemId,
    quantity: 1,
    currency: 'usd',
    amount_subtotal: amounts.subtotal,
    amount_tax: amounts.tax,
    amount_total: amounts.total,
    price: {
      product: {
        id: `prod_${providerLineItemId}`,
        metadata: { pale_orbit_order_item_id: orderItemId }
      }
    }
  };
}

describe('Stripe SDK gateway', () => {
  beforeEach(() => {
    for (const method of [
      sdk.client.checkout.sessions.create,
      sdk.client.checkout.sessions.retrieve,
      sdk.client.checkout.sessions.listLineItems,
      sdk.client.paymentIntents.retrieve,
      sdk.client.refunds.retrieve,
      sdk.client.disputes.retrieve,
      sdk.client.webhooks.constructEvent
    ]) method.mockReset();
    sdk.Stripe.mockClear();
  });

  it('constructs the SDK defensively and creates an exclusive inline-price Checkout Session', async () => {
    sdk.client.checkout.sessions.create.mockResolvedValue({
      id: 'cs_test_fixture_101',
      url: 'https://checkout.stripe.com/c/pay/cs_test_fixture_101',
      expires_at: 1_786_365_000
    });
    const gateway = createStripeSdkGateway(options);
    const input = checkoutInputFixture();

    await expect(gateway.createCheckoutSession(input)).resolves.toEqual({
      providerSessionId: 'cs_test_fixture_101',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_fixture_101',
      expiresAt: new Date(1_786_365_000_000)
    });
    expect(sdk.Stripe).toHaveBeenCalledWith('sk_test_unit_test_only', {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 2,
      telemetry: false
    });
    expect(sdk.client.checkout.sessions.create).toHaveBeenCalledWith({
      mode: 'payment',
      client_reference_id: input.orderId,
      metadata: {
        pale_orbit_metadata_version: '1',
        pale_orbit_order_id: input.orderId
      },
      payment_intent_data: {
        metadata: {
          pale_orbit_metadata_version: '1',
          pale_orbit_order_id: input.orderId
        }
      },
      customer_email: 'reader@example.com',
      expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      automatic_tax: { enabled: true },
      adaptive_pricing: { enabled: false },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: 1299,
          tax_behavior: 'exclusive',
          product_data: {
            name: 'The Safe Book',
            tax_code: 'txcd_10000000',
            metadata: { pale_orbit_order_item_id: FIXTURE_ORDER_ITEM_ID }
          }
        }
      }]
    }, { idempotencyKey: input.orderId });
    const [request] = sdk.client.checkout.sessions.create.mock.calls[0]!;
    expect(request).not.toHaveProperty('payment_method_types');
    expect(JSON.stringify(request)).not.toMatch(/creator|token|storage|last4|brand/iu);
  });

  it('omits account email and automatic tax for guest checkout and rejects foreign return URLs', async () => {
    sdk.client.checkout.sessions.create.mockResolvedValue({
      id: 'cs_test_fixture_101',
      url: 'https://checkout.stripe.com/c/pay/cs_test_fixture_101',
      expires_at: 1_786_365_000
    });
    const gateway = createStripeSdkGateway(options);
    await gateway.createCheckoutSession(checkoutInputFixture({
      accountEmail: null,
      automaticTaxEnabled: false,
      items: [{ ...checkoutInputFixture().items[0]!, taxCode: null }]
    }));
    const [request] = sdk.client.checkout.sessions.create.mock.calls[0]!;
    expect(request).not.toHaveProperty('customer_email');
    expect(request).toMatchObject({
      automatic_tax: { enabled: false },
      adaptive_pricing: { enabled: false }
    });

    await expect(gateway.createCheckoutSession(checkoutInputFixture({
      successUrl: 'https://evil.example/steal'
    }))).rejects.toBeInstanceOf(PermanentCommerceError);
    expect(sdk.client.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a provider-created session whose expiry differs from the accepted order input', async () => {
    sdk.client.checkout.sessions.create.mockResolvedValue({
      id: 'cs_test_fixture_101',
      url: 'https://checkout.stripe.com/c/pay/cs_test_fixture_101',
      expires_at: 1_786_365_001
    });
    await expect(
      createStripeSdkGateway(options).createCheckoutSession(checkoutInputFixture())
    ).rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('rejects a fractional-second expiry before the SDK can truncate it', async () => {
    await expect(createStripeSdkGateway(options).createCheckoutSession(checkoutInputFixture({
      expiresAt: new Date('2026-08-10T12:30:00.987Z')
    }))).rejects.toBeInstanceOf(PermanentCommerceError);
    expect(sdk.client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects a 25-item subtotal overflow before calling Stripe', async () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      orderItemId: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
      title: `Title ${index + 1}`,
      format: 'prose' as const,
      unitSubtotalMinor: 2_000_000,
      taxCode: 'txcd_10000000'
    }));

    await expect(createStripeSdkGateway(options).createCheckoutSession(
      checkoutInputFixture({ items })
    )).rejects.toBeInstanceOf(PermanentCommerceError);
    expect(sdk.client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('retrieves and validates every paginated line item', async () => {
    const secondOrderItemId = randomUUID();
    sdk.client.checkout.sessions.retrieve.mockResolvedValue(rawSession({
      amount_subtotal: 2000,
      amount_total: 2160,
      total_details: { amount_tax: 160 }
    }));
    sdk.client.checkout.sessions.listLineItems
      .mockResolvedValueOnce({
        data: [rawLine('li_first', FIXTURE_ORDER_ITEM_ID, { subtotal: 1299, tax: 104, total: 1403 })],
        has_more: true
      })
      .mockResolvedValueOnce({
        data: [rawLine('li_second', secondOrderItemId, { subtotal: 701, tax: 56, total: 757 })],
        has_more: false
      });

    const snapshot = await createStripeSdkGateway(options).retrieveCheckoutSession('cs_test_fixture_101');
    expect(snapshot.customerEmail).toBe('reader@example.com');
    expect(snapshot.lineItems.map((line) => line.orderItemId)).toEqual([
      FIXTURE_ORDER_ITEM_ID,
      secondOrderItemId
    ]);
    expect(sdk.client.checkout.sessions.retrieve).toHaveBeenCalledWith(
      'cs_test_fixture_101',
      { expand: ['payment_intent.latest_charge'] }
    );
    expect(sdk.client.checkout.sessions.listLineItems).toHaveBeenNthCalledWith(
      1,
      'cs_test_fixture_101',
      { limit: 25, expand: ['data.price.product'] }
    );
    expect(sdk.client.checkout.sessions.listLineItems).toHaveBeenNthCalledWith(
      2,
      'cs_test_fixture_101',
      { limit: 25, expand: ['data.price.product'], starting_after: 'li_first' }
    );
  });

  it.each([
    ['more than 25 lines', Array.from({ length: 26 }, (_, index) => rawLine(`li_${index}`, randomUUID()))],
    ['duplicate order metadata', [rawLine('li_one', FIXTURE_ORDER_ITEM_ID), rawLine('li_two', FIXTURE_ORDER_ITEM_ID)]],
    ['missing order metadata', [{ ...rawLine('li_one', FIXTURE_ORDER_ITEM_ID), price: { product: { id: 'prod_one', metadata: {} } } }]],
    ['quantity not one', [{ ...rawLine('li_one', FIXTURE_ORDER_ITEM_ID), quantity: 2 }]],
    ['float money', [{ ...rawLine('li_one', FIXTURE_ORDER_ITEM_ID), amount_total: 1403.5 }]]
  ])('rejects invalid line pagination: %s', async (_label, lines) => {
    sdk.client.checkout.sessions.retrieve.mockResolvedValue(rawSession());
    sdk.client.checkout.sessions.listLineItems.mockResolvedValue({ data: lines, has_more: false });
    await expect(
      createStripeSdkGateway(options).retrieveCheckoutSession('cs_test_fixture_101')
    ).rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('rejects a non-progressing pagination cursor and canonical email disagreement', async () => {
    sdk.client.checkout.sessions.retrieve.mockResolvedValue(rawSession());
    sdk.client.checkout.sessions.listLineItems.mockResolvedValue({
      data: [rawLine('li_repeat', FIXTURE_ORDER_ITEM_ID)],
      has_more: true
    });
    await expect(
      createStripeSdkGateway(options).retrieveCheckoutSession('cs_test_fixture_101')
    ).rejects.toBeInstanceOf(PermanentCommerceError);

    sdk.client.checkout.sessions.retrieve.mockResolvedValue(rawSession({
      customer_details: { email: 'first@example.com' },
      customer_email: 'other@example.com'
    }));
    sdk.client.checkout.sessions.listLineItems.mockResolvedValue({
      data: [rawLine('li_one', FIXTURE_ORDER_ITEM_ID)], has_more: false
    });
    await expect(
      createStripeSdkGateway(options).retrieveCheckoutSession('cs_test_fixture_101')
    ).rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('normalizes payment, refund, and dispute retrieval without sensitive details', async () => {
    sdk.client.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_test_fixture_101',
      metadata: {
        pale_orbit_metadata_version: '1',
        pale_orbit_order_id: '00000000-0000-4000-8000-000000000101'
      },
      latest_charge: { id: 'ch_test_fixture_101', created: 1_786_362_060 },
      livemode: false,
      status: 'succeeded',
      amount: 1403,
      currency: 'usd',
      payment_method: { id: 'pm_private', type: 'card', card: { last4: '4242', brand: 'visa' } }
    });
    sdk.client.refunds.retrieve.mockResolvedValue({
      id: 're_test_fixture_101',
      payment_intent: 'pi_test_fixture_101',
      livemode: false,
      status: 'requires_action',
      amount: 400,
      currency: 'usd',
      reason: 'expired_uncaptured_charge',
      created: 1_786_365_000
    });
    sdk.client.disputes.retrieve.mockResolvedValue({
      id: 'dp_test_fixture_101',
      payment_intent: { id: 'pi_test_fixture_101' },
      charge: { id: 'ch_test_fixture_101' },
      livemode: false,
      status: 'under_review',
      amount: 1403,
      currency: 'usd',
      reason: 'fraudulent',
      created: 1_786_368_000
    });
    const gateway = createStripeSdkGateway(options);

    const payment = await gateway.retrievePayment('pi_test_fixture_101');
    expect(payment).toEqual({
      paymentIntentId: 'pi_test_fixture_101',
      metadataVersion: '1',
      metadataOrderId: '00000000-0000-4000-8000-000000000101',
      latestChargeId: 'ch_test_fixture_101',
      liveMode: false,
      state: 'succeeded',
      amountMinor: 1403,
      currency: 'usd',
      paidAt: new Date(1_786_362_060_000),
      paymentMethodCategory: 'card'
    });
    expect(JSON.stringify(payment)).not.toMatch(/4242|visa|pm_private/u);
    await expect(gateway.retrieveRefund('re_test_fixture_101')).resolves.toMatchObject({
      state: 'pending', reason: 'other', paymentIntentId: 'pi_test_fixture_101'
    });
    await expect(gateway.retrieveDispute('dp_test_fixture_101')).resolves.toMatchObject({
      state: 'open', reason: 'fraudulent', chargeId: 'ch_test_fixture_101'
    });
  });

  it.each([
    ['missing', {}],
    ['wrong version', {
      pale_orbit_metadata_version: '2',
      pale_orbit_order_id: '00000000-0000-4000-8000-000000000101'
    }],
    ['expanded', {
      pale_orbit_metadata_version: '1',
      pale_orbit_order_id: '00000000-0000-4000-8000-000000000101',
      unrelated: 'value'
    }]
  ])('rejects %s PaymentIntent order metadata', async (_label, metadata) => {
    sdk.client.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_test_fixture_101',
      metadata,
      latest_charge: { id: 'ch_test_fixture_101', created: 1_786_362_060 },
      livemode: false,
      status: 'succeeded',
      amount: 1403,
      currency: 'usd',
      payment_method: { id: 'pm_private', type: 'card' }
    });

    await expect(createStripeSdkGateway(options).retrievePayment('pi_test_fixture_101'))
      .rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('verifies exact bytes, hashes them, and rejects an unsupported API version', () => {
    const rawBody = new TextEncoder().encode(' {"snowman":"☃"}\n');
    sdk.client.webhooks.constructEvent.mockReturnValue({
      id: 'evt_test_fixture_101',
      type: 'checkout.session.completed',
      livemode: false,
      api_version: STRIPE_API_VERSION,
      created: 1_786_362_120,
      data: { object: { id: 'cs_test_fixture_101' } }
    });
    const gateway = createStripeSdkGateway(options);
    const event = gateway.verifyWebhook(rawBody, 'signature-v1');
    expect(event.rawBodySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(sdk.client.webhooks.constructEvent).toHaveBeenCalledWith(
      expect.objectContaining({ byteLength: rawBody.byteLength }),
      'signature-v1',
      'whsec_unit_test_only',
      300
    );

    sdk.client.webhooks.constructEvent.mockReturnValue({
      id: 'evt_test_fixture_102',
      type: 'checkout.session.completed',
      livemode: false,
      api_version: '2025-01-01.old',
      created: 1_786_362_120,
      data: { object: { id: 'cs_test_fixture_101' } }
    });
    expect(() => gateway.verifyWebhook(rawBody, 'signature-v1')).toThrow(PermanentCommerceError);
  });

  it.each([
    [{ type: 'StripeConnectionError', message: 'raw provider secret' }, RetryableProviderError],
    [{ type: 'StripeRateLimitError', message: 'raw provider secret' }, RetryableProviderError],
    [{ type: 'StripeAPIError', statusCode: 503, message: 'raw provider secret' }, RetryableProviderError],
    [{ type: 'StripeInvalidRequestError', statusCode: 400, message: 'raw provider secret' }, PermanentCommerceError]
  ])('maps provider failures without exposing details', async (providerError, ErrorType) => {
    sdk.client.paymentIntents.retrieve.mockRejectedValue(providerError);
    const error = await createStripeSdkGateway(options)
      .retrievePayment('pi_test_fixture_101')
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ErrorType);
    expect((error as Error).message).not.toContain('raw provider secret');
  });
});
