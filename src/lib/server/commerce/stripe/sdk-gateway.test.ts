import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CheckoutUnavailableError,
  PermanentCommerceError,
  RetryableProviderError
} from '$lib/server/commerce/errors';
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
    charges: { retrieve: vi.fn() },
    refunds: { retrieve: vi.fn() },
    disputes: { retrieve: vi.fn() },
    payouts: { retrieve: vi.fn(), list: vi.fn() },
    rawRequest: vi.fn(),
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

import { createStripeSdkGateway, createStripeSdkWorkerGateway } from './sdk-gateway';

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

function rawBalanceTransactionJson(
  overrides: { id?: string; sourceId?: string; exchangeRate?: string | null } = {}
): string {
  const id = overrides.id ?? 'txn_test_charge_101';
  const sourceId = overrides.sourceId ?? 'ch_test_fixture_101';
  const exchangeRate = overrides.exchangeRate === undefined
    ? '1.230000000000000000'
    : overrides.exchangeRate === null ? 'null' : overrides.exchangeRate;
  return JSON.stringify({
    id,
    object: 'balance_transaction',
    amount: 1403,
    available_on: 1_786_536_060,
    balance_type: 'payments',
    created: 1_786_362_060,
    currency: 'usd',
    exchange_rate: '__EXACT_RATE__',
    fee: 71,
    fee_details: [{ amount: 71, currency: 'usd', type: 'stripe_fee' }],
    net: 1332,
    reporting_category: 'charge',
    source: { id: sourceId, object: 'charge', currency: 'eur', private_field: 'discard' },
    status: 'available',
    type: 'charge',
    description: 'must not escape the adapter'
  }).replace('"__EXACT_RATE__"', exchangeRate);
}

function rawStream(value: string): Readable {
  return Readable.from([Buffer.from(value, 'utf8')]);
}

describe('Stripe SDK gateway', () => {
  beforeEach(() => {
    for (const method of [
      sdk.client.checkout.sessions.create,
      sdk.client.checkout.sessions.retrieve,
      sdk.client.checkout.sessions.listLineItems,
      sdk.client.paymentIntents.retrieve,
      sdk.client.charges.retrieve,
      sdk.client.refunds.retrieve,
      sdk.client.disputes.retrieve,
      sdk.client.payouts.retrieve,
      sdk.client.payouts.list,
      sdk.client.rawRequest,
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

  it('normalizes payment, charge, refund, and dispute retrieval without sensitive details', async () => {
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
      status: 'requires_action',
      amount: 400,
      currency: 'usd',
      reason: 'expired_uncaptured_charge',
      created: 1_786_365_000,
      balance_transaction: { id: 'txn_test_refund_101' },
      failure_balance_transaction: 'txn_test_refund_failure_101',
      destination_details: { card: { reference: 'private' } }
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
      created: 1_786_368_000,
      balance_transactions: [
        { id: 'txn_test_dispute_withdrawal_101' },
        { id: 'txn_test_dispute_reversal_101' }
      ],
      evidence: { customer_email_address: 'private@example.com' }
    });
    sdk.client.charges.retrieve.mockResolvedValue({
      id: 'ch_test_fixture_101',
      payment_intent: { id: 'pi_test_fixture_101' },
      livemode: false,
      amount: 1403,
      amount_refunded: 400,
      currency: 'usd',
      status: 'succeeded',
      balance_transaction: 'txn_test_charge_101',
      created: 1_786_362_060,
      billing_details: { email: 'private@example.com' }
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
    await expect(gateway.retrieveCharge('ch_test_fixture_101')).resolves.toEqual({
      id: 'ch_test_fixture_101',
      paymentIntentId: 'pi_test_fixture_101',
      livemode: false,
      amountMinor: 1403,
      amountRefundedMinor: 400,
      currency: 'USD',
      status: 'succeeded',
      balanceTransactionId: 'txn_test_charge_101',
      createdAt: new Date(1_786_362_060_000)
    });
    await expect(gateway.retrieveRefund('re_test_fixture_101')).resolves.toMatchObject({
      state: 'pending',
      reason: 'other',
      paymentIntentId: 'pi_test_fixture_101',
      liveMode: false,
      balanceTransactionId: 'txn_test_refund_101',
      failureBalanceTransactionId: 'txn_test_refund_failure_101'
    });
    await expect(gateway.retrieveDispute('dp_test_fixture_101')).resolves.toMatchObject({
      state: 'open',
      reason: 'fraudulent',
      chargeId: 'ch_test_fixture_101',
      balanceTransactionIds: [
        'txn_test_dispute_withdrawal_101',
        'txn_test_dispute_reversal_101'
      ]
    });
    expect(JSON.stringify(await gateway.retrieveRefund('re_test_fixture_101')))
      .not.toContain('private');
    expect(JSON.stringify(await gateway.retrieveDispute('dp_test_fixture_101')))
      .not.toContain('private@example.com');
  });

  it('constructs a retrieval-only worker gateway without webhook or checkout authority', async () => {
    sdk.client.charges.retrieve.mockResolvedValue({
      id: 'ch_test_worker_gateway',
      payment_intent: { id: 'pi_test_worker_gateway' },
      livemode: false,
      amount: 1403,
      amount_refunded: 0,
      currency: 'usd',
      status: 'succeeded',
      balance_transaction: 'txn_test_worker_gateway',
      created: 1_786_362_060
    });
    const gateway = createStripeSdkWorkerGateway({
      secretKey: 'sk_test_worker_gateway_only',
      expectedLiveMode: false
    });

    expect(sdk.Stripe).toHaveBeenCalledWith('sk_test_worker_gateway_only', expect.objectContaining({
      telemetry: false
    }));
    await expect(gateway.retrieveCharge('ch_test_worker_gateway')).resolves.toMatchObject({
      id: 'ch_test_worker_gateway',
      paymentIntentId: 'pi_test_worker_gateway',
      balanceTransactionId: 'txn_test_worker_gateway'
    });
    await expect(gateway.createCheckoutSession(checkoutInputFixture()))
      .rejects.toBeInstanceOf(CheckoutUnavailableError);
    expect(() => gateway.verifyWebhook(new Uint8Array(), 'signature'))
      .toThrow(CheckoutUnavailableError);
    expect(sdk.client.checkout.sessions.create).not.toHaveBeenCalled();
    expect(sdk.client.webhooks.constructEvent).not.toHaveBeenCalled();
  });

  it('preserves the exact balance-transaction exchange-rate token through one bounded raw request', async () => {
    sdk.client.rawRequest.mockResolvedValue(rawStream(rawBalanceTransactionJson()));

    const result = await createStripeSdkGateway(options)
      .retrieveBalanceTransaction('txn_test_charge_101');

    expect(result).toEqual({
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
      createdAt: new Date(1_786_362_060_000),
      availableAt: new Date(1_786_536_060_000),
      exchangeRate: '1.230000000000000000',
      exchangeSourceCurrency: 'EUR',
      exchangeTargetCurrency: 'USD',
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 71, currency: 'USD' }]
    });
    expect(sdk.client.rawRequest).toHaveBeenCalledTimes(1);
    const [method, path, params, requestOptions] = sdk.client.rawRequest.mock.calls[0]!;
    expect(method).toBe('GET');
    const url = new URL(path, 'https://api.stripe.test');
    expect(url.pathname).toBe('/v1/balance_transactions/txn_test_charge_101');
    expect(url.searchParams.getAll('expand[]')).toEqual(['source']);
    expect(params).toBeUndefined();
    expect(requestOptions).toEqual({ streaming: true });
    expect(JSON.stringify(result)).not.toMatch(/description|private_field/u);
  });

  it('rejects duplicate decoded keys on a financial object', async () => {
    const response = rawBalanceTransactionJson().replace(
      '"id":"txn_test_charge_101"',
      '"id":"txn_test_charge_101","i\\u0064":"txn_shadow_101"'
    );
    sdk.client.rawRequest.mockResolvedValue(rawStream(response));

    await expect(createStripeSdkGateway(options)
      .retrieveBalanceTransaction('txn_test_charge_101'))
      .rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('rejects duplicate decoded keys on a financial page', async () => {
    const transaction = rawBalanceTransactionJson({ exchangeRate: null });
    sdk.client.rawRequest.mockResolvedValue(rawStream(
      `{"object":"list","data":[${transaction}],"d\\u0061ta":[${transaction}],"has_more":false}`
    ));

    await expect(createStripeSdkGateway(options)
      .listBalanceTransactionsForSource('ch_source_1', { limit: 2 }))
      .rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('rejects duplicate decoded keys on nested financial objects', async () => {
    const response = rawBalanceTransactionJson().replace(
      '"source":{"id":"ch_test_fixture_101","object":"charge"',
      '"source":{"id":"ch_test_fixture_101","i\\u0064":"ch_shadow_101","object":"charge"'
    );
    sdk.client.rawRequest.mockResolvedValue(rawStream(response));

    await expect(createStripeSdkGateway(options)
      .retrieveBalanceTransaction('txn_test_charge_101'))
      .rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('retrieves a minimized payout and rejects provider livemode disagreement', async () => {
    sdk.client.payouts.retrieve.mockResolvedValue({
      id: 'po_test_fixture_101',
      livemode: false,
      amount: 1332,
      currency: 'usd',
      automatic: true,
      method: 'standard',
      status: 'paid',
      reconciliation_status: 'completed',
      created: 1_786_546_800,
      arrival_date: 1_786_665_600,
      balance_transaction: { id: 'txn_test_payout_101' },
      failure_balance_transaction: null,
      original_payout: null,
      reversed_by: null,
      failure_code: null,
      failure_message: 'must not escape the adapter',
      description: 'private'
    });
    const gateway = createStripeSdkGateway(options);
    const payout = await gateway.retrievePayout('po_test_fixture_101');
    expect(payout).toEqual({
      id: 'po_test_fixture_101',
      livemode: false,
      amountMinor: 1332,
      currency: 'USD',
      automatic: true,
      method: 'standard',
      status: 'paid',
      reconciliationStatus: 'completed',
      createdAt: new Date(1_786_546_800_000),
      arrivalAt: new Date(1_786_665_600_000),
      balanceTransactionId: 'txn_test_payout_101',
      failureBalanceTransactionId: null,
      originalPayoutId: null,
      reversedByPayoutId: null,
      safeFailureCode: null
    });
    expect(JSON.stringify(payout)).not.toMatch(/failure_message|must not escape|private/u);

    sdk.client.payouts.retrieve.mockResolvedValue({
      id: 'po_test_fixture_102',
      livemode: true,
      amount: 1,
      currency: 'usd',
      automatic: false,
      method: 'instant',
      status: 'pending',
      reconciliation_status: 'not_applicable',
      created: 1,
      arrival_date: 2,
      balance_transaction: null,
      failure_balance_transaction: null,
      original_payout: null,
      reversed_by: null,
      failure_code: null
    });
    await expect(gateway.retrievePayout('po_test_fixture_102'))
      .rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('returns exactly one canonical page for source, payout, and payout-list filters', async () => {
    sdk.client.rawRequest
      .mockResolvedValueOnce(rawStream(JSON.stringify({
        object: 'list',
        data: [JSON.parse(rawBalanceTransactionJson({ id: 'txn_source_page_1', exchangeRate: null }))],
        has_more: true,
        url: '/v1/balance_transactions'
      })))
      .mockResolvedValueOnce(rawStream(JSON.stringify({
        object: 'list',
        data: [JSON.parse(rawBalanceTransactionJson({ id: 'txn_payout_page_1', exchangeRate: null }))],
        has_more: false,
        url: '/v1/balance_transactions'
      })));
    sdk.client.payouts.list.mockResolvedValue({
      object: 'list',
      data: [{
        id: 'po_page_1',
        livemode: false,
        amount: 1332,
        currency: 'usd',
        automatic: true,
        method: 'standard',
        status: 'paid',
        reconciliation_status: 'completed',
        created: 1_786_546_800,
        arrival_date: 1_786_665_600,
        balance_transaction: null,
        failure_balance_transaction: null,
        original_payout: null,
        reversed_by: null,
        failure_code: null
      }],
      has_more: false,
      url: '/v1/payouts'
    });
    const gateway = createStripeSdkGateway(options);
    const request = {
      limit: 37,
      startingAfter: 'txn_cursor_1',
      createdGte: 1_786_300_000,
      createdLt: 1_786_600_000
    };

    await expect(gateway.listBalanceTransactionsForSource('ch_source_1', request))
      .resolves.toMatchObject({ hasMore: true, nextStartingAfter: 'txn_source_page_1' });
    await expect(gateway.listBalanceTransactionsForPayout('po_source_1', {
      limit: request.limit,
      createdGte: request.createdGte,
      createdLt: request.createdLt
    })).resolves.toMatchObject({ hasMore: false, nextStartingAfter: null });
    await expect(gateway.listPayouts({ ...request, startingAfter: 'po_cursor_1' }))
      .resolves.toMatchObject({ hasMore: false, nextStartingAfter: null });

    expect(sdk.client.rawRequest).toHaveBeenCalledTimes(2);
    const sourceUrl = new URL(sdk.client.rawRequest.mock.calls[0]![1], 'https://api.stripe.test');
    expect(Object.fromEntries(sourceUrl.searchParams)).toMatchObject({
      limit: '37',
      starting_after: 'txn_cursor_1',
      'created[gte]': '1786300000',
      'created[lt]': '1786600000',
      source: 'ch_source_1'
    });
    expect(sourceUrl.searchParams.getAll('expand[]')).toEqual(['data.source']);
    const payoutUrl = new URL(sdk.client.rawRequest.mock.calls[1]![1], 'https://api.stripe.test');
    expect(payoutUrl.searchParams.get('payout')).toBe('po_source_1');
    expect(sdk.client.payouts.list).toHaveBeenCalledOnce();
    expect(sdk.client.payouts.list).toHaveBeenCalledWith({
      limit: 37,
      starting_after: 'po_cursor_1',
      created: { gte: 1_786_300_000, lt: 1_786_600_000 }
    });
  });

  it('rejects financial pages that exceed the requested limit', async () => {
    sdk.client.rawRequest.mockResolvedValue(rawStream(JSON.stringify({
      object: 'list',
      data: [
        JSON.parse(rawBalanceTransactionJson({ id: 'txn_limit_1', exchangeRate: null })),
        JSON.parse(rawBalanceTransactionJson({ id: 'txn_limit_2', exchangeRate: null }))
      ],
      has_more: false,
      url: '/v1/balance_transactions'
    })));

    await expect(createStripeSdkGateway(options)
      .listBalanceTransactionsForSource('ch_source_1', { limit: 1 }))
      .rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('rejects continuation pages containing the starting cursor before the final row', async () => {
    sdk.client.rawRequest.mockResolvedValue(rawStream(JSON.stringify({
      object: 'list',
      data: [
        JSON.parse(rawBalanceTransactionJson({ id: 'txn_cursor_overlap', exchangeRate: null })),
        JSON.parse(rawBalanceTransactionJson({ id: 'txn_cursor_next', exchangeRate: null }))
      ],
      has_more: true,
      url: '/v1/balance_transactions'
    })));

    await expect(createStripeSdkGateway(options).listBalanceTransactionsForSource(
      'ch_source_1',
      { limit: 2, startingAfter: 'txn_cursor_overlap' }
    )).rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('fails permanently for invalid continuations and exact-FX evidence', async () => {
    const gateway = createStripeSdkGateway(options);
    sdk.client.rawRequest.mockResolvedValueOnce(rawStream(JSON.stringify({
      object: 'list', data: [], has_more: true, url: '/v1/balance_transactions'
    })));
    await expect(gateway.listBalanceTransactionsForSource('ch_source_1', { limit: 1 }))
      .rejects.toBeInstanceOf(PermanentCommerceError);

    sdk.client.rawRequest.mockResolvedValueOnce(rawStream(JSON.stringify({
      object: 'list',
      data: [JSON.parse(rawBalanceTransactionJson({ id: 'txn_cursor_same', exchangeRate: null }))],
      has_more: true,
      url: '/v1/balance_transactions'
    })));
    await expect(gateway.listBalanceTransactionsForSource('ch_source_1', {
      limit: 1,
      startingAfter: 'txn_cursor_same'
    })).rejects.toBeInstanceOf(PermanentCommerceError);

    sdk.client.rawRequest.mockResolvedValueOnce(rawStream(rawBalanceTransactionJson({
      exchangeRate: '1.23e0'
    })));
    await expect(gateway.retrieveBalanceTransaction('txn_test_charge_101'))
      .rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('rejects oversized financial streams and destroys them', async () => {
    const stream = rawStream('x'.repeat((8 * 1024 * 1024) + 1));
    const destroy = vi.spyOn(stream, 'destroy');
    sdk.client.rawRequest.mockResolvedValue(stream);

    await expect(createStripeSdkGateway(options)
      .retrieveBalanceTransaction('txn_test_charge_101'))
      .rejects.toBeInstanceOf(PermanentCommerceError);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('maps a financial stream abort retryably', async () => {
    async function* abortedStream() {
      yield Buffer.from('{');
      throw new Error('private socket abort');
    }
    sdk.client.rawRequest.mockResolvedValue(abortedStream());

    const error = await createStripeSdkGateway(options)
      .retrieveBalanceTransaction('txn_test_charge_101')
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect((error as Error).message).not.toContain('private socket abort');
    expect(error).not.toHaveProperty('cause');
  });

  it('maps raw financial transport failures retryably and malformed streams permanently', async () => {
    const gateway = createStripeSdkGateway(options);
    for (const providerError of [
      { type: 'StripeConnectionError', message: 'private connection' },
      { type: 'StripeRateLimitError', message: 'private rate limit' },
      { type: 'StripeAPIError', statusCode: 503, message: 'private outage' },
      { type: 'StripeAPIError', statusCode: 429, message: 'private throttle' }
    ]) {
      sdk.client.rawRequest.mockRejectedValueOnce(providerError);
      const error = await gateway.retrieveBalanceTransaction('txn_test_charge_101')
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(RetryableProviderError);
      expect((error as Error).message).not.toContain('private');
      expect(error).not.toHaveProperty('cause');
    }
    sdk.client.rawRequest.mockResolvedValueOnce(rawStream('{"exchange_rate":'));
    await expect(gateway.retrieveBalanceTransaction('txn_test_charge_101'))
      .rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it.each([
    ['an invalid escaped key', '{"private\\xkey":1}'],
    ['non-JSON whitespace', `\u00a0${rawBalanceTransactionJson()}`]
  ])('maps %s cause-free as permanent financial evidence failure', async (_label, response) => {
    sdk.client.rawRequest.mockResolvedValue(rawStream(response));

    const error = await createStripeSdkGateway(options)
      .retrieveBalanceTransaction('txn_test_charge_101')
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PermanentCommerceError);
    expect(error).not.toHaveProperty('cause');
  });

  it('maps invalid UTF-8 cause-free as permanent financial evidence failure', async () => {
    sdk.client.rawRequest.mockResolvedValue(Readable.from([
      Uint8Array.from([0xc3, 0x28])
    ]));

    const error = await createStripeSdkGateway(options)
      .retrieveBalanceTransaction('txn_test_charge_101')
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PermanentCommerceError);
    expect(error).not.toHaveProperty('cause');
  });

  it('rejects whitespace-wrapped provider IDs before any SDK call', async () => {
    await expect(createStripeSdkGateway(options).retrieveCharge(' ch_test_fixture_101 '))
      .rejects.toBeInstanceOf(PermanentCommerceError);
    await expect(createStripeSdkGateway(options).retrieveRefund(' re_test_fixture_101 '))
      .rejects.toBeInstanceOf(PermanentCommerceError);
    expect(sdk.client.charges.retrieve).not.toHaveBeenCalled();
    expect(sdk.client.refunds.retrieve).not.toHaveBeenCalled();
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
    expect(error).not.toHaveProperty('cause');
  });
});
