import { describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import { RetryableProviderError } from '$lib/server/commerce/errors';
import {
  assertPaymentChargeProjectionConservation,
  lockCanonicalPaymentPurchaseFacts,
  reconcilePaymentFinancialSource
} from './payment';

describe('reconcilePaymentFinancialSource', () => {
  function routingDatabase(row: unknown): Database {
    const limit = vi.fn().mockResolvedValue([{ amountMinor: 100, currency: 'USD',
      paidAt: new Date('2026-08-10T00:00:00Z'), paymentMethodCategory: 'card', orderTotalMinor: 100,
      orderCurrency: 'USD', orderPaidAt: new Date('2026-08-10T00:00:00Z'), ...(row as object) }]);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ where, innerJoin }));
    return { select: vi.fn(() => ({ from })), transaction: vi.fn() } as unknown as Database;
  }

  it('rejects a non-canonical payload before any database or provider call', async () => {
    const database = { execute: vi.fn(), transaction: vi.fn() } as unknown as Database;
    const gateway = { retrievePayment: vi.fn() } as unknown as StripeCommerceGateway;

    const result = reconcilePaymentFinancialSource(
      database,
      gateway,
      { paymentId: 'NOT-A-UUID', correlationId: 'payment-source-red' },
      new AbortController().signal
    );

    await expect(result).rejects.toMatchObject({
      name: 'PermanentFinancialError',
      safeCode: 'invalid_job_payload'
    });
    expect(database.execute).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
    expect(gateway.retrievePayment).not.toHaveBeenCalled();
  });

  it('does not query Stripe when unlocked local payment/order routing is not complete', async () => {
    const database = routingDatabase({
      id: '00000000-0000-4000-8000-000000000101',
      orderId: '00000000-0000-4000-8000-000000000102',
      stripePaymentIntentId: 'pi_payment_source_local_pending',
      stripeLatestChargeId: null,
      paymentStatus: 'pending',
      orderStatus: 'checkout_pending', amountMinor: 100, currency: 'USD', paidAt: null,
      paymentMethodCategory: null, orderTotalMinor: null, orderCurrency: 'USD', orderPaidAt: null
    });
    const gateway = {
      retrievePayment: vi.fn(), retrieveCharge: vi.fn(), retrieveBalanceTransaction: vi.fn()
    } as unknown as StripeCommerceGateway;

    await expect(reconcilePaymentFinancialSource(database, gateway, {
      paymentId: '00000000-0000-4000-8000-000000000101', correlationId: 'local-pending'
    }, new AbortController().signal)).rejects.toMatchObject({
      name: 'RetryableFinancialError', safeCode: 'local_state_pending'
    });
    expect(gateway.retrievePayment).not.toHaveBeenCalled();
    expect(gateway.retrieveCharge).not.toHaveBeenCalled();
    expect(gateway.retrieveBalanceTransaction).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('propagates AbortError between provider calls', async () => {
    const controller = new AbortController();
    const database = routingDatabase({
      id: '00000000-0000-4000-8000-000000000101',
      orderId: '00000000-0000-4000-8000-000000000102',
      stripePaymentIntentId: 'pi_payment_source_abort',
      stripeLatestChargeId: 'ch_abort',
      paymentStatus: 'succeeded',
      orderStatus: 'paid', amountMinor: 100, currency: 'USD', paidAt: new Date('2026-08-10T00:00:00Z'),
      paymentMethodCategory: 'card', orderTotalMinor: 100, orderCurrency: 'USD', orderPaidAt: new Date('2026-08-10T00:00:00Z')
    });
    const gateway = {
      retrievePayment: vi.fn(async () => {
        controller.abort();
        return { latestChargeId: 'ch_never_reached' };
      }),
      retrieveCharge: vi.fn(), retrieveBalanceTransaction: vi.fn()
    } as unknown as StripeCommerceGateway;

    await expect(reconcilePaymentFinancialSource(database, gateway, {
      paymentId: '00000000-0000-4000-8000-000000000101', correlationId: 'abort-boundary'
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(gateway.retrieveCharge).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('records missing_source and returns provider_not_ready without fetching a Charge for a pending PaymentIntent', async () => {
    const database = routingDatabase({ id: '00000000-0000-4000-8000-000000000101',
      orderId: '00000000-0000-4000-8000-000000000102', stripePaymentIntentId: 'pi_pending',
      stripeLatestChargeId: 'ch_pending',
      paymentStatus: 'succeeded', orderStatus: 'paid' });
    const expected = { status: 'pending' as const, sourceKind: 'payment' as const,
      sourceId: '00000000-0000-4000-8000-000000000101', financialEvidenceStatus: 'pending' as const,
      safeCode: 'provider_not_ready' as const, issueId: '00000000-0000-4000-8000-000000000109' };
    vi.mocked(database.transaction).mockResolvedValueOnce(expected);
    const gateway = { retrievePayment: vi.fn(async () => ({ paymentIntentId: 'pi_pending',
      metadataVersion: '1', metadataOrderId: '00000000-0000-4000-8000-000000000102',
      latestChargeId: 'ch_pending', liveMode: false, state: 'pending', amountMinor: 100,
      currency: 'usd', paidAt: null, paymentMethodCategory: null })), retrieveCharge: vi.fn() } as unknown as StripeCommerceGateway;

    await expect(reconcilePaymentFinancialSource(database, gateway, {
      paymentId: '00000000-0000-4000-8000-000000000101', correlationId: 'provider-pending'
    }, new AbortController().signal)).resolves.toEqual(expected);
    expect(gateway.retrieveCharge).not.toHaveBeenCalled();
    expect(database.transaction).toHaveBeenCalledOnce();
  });

  it('records malformed permanent provider evidence as a durable bounded exception', async () => {
    const database = routingDatabase({ id: '00000000-0000-4000-8000-000000000101',
      orderId: '00000000-0000-4000-8000-000000000102', stripePaymentIntentId: 'pi_malformed',
      stripeLatestChargeId: 'ch_malformed',
      paymentStatus: 'succeeded', orderStatus: 'paid' });
    const gateway = { retrievePayment: vi.fn(async () => { throw new PermanentCommerceError(); }) } as unknown as StripeCommerceGateway;
    const expected = { status: 'exception' as const, sourceKind: 'payment' as const,
      sourceId: '00000000-0000-4000-8000-000000000101', financialEvidenceStatus: 'exception' as const,
      safeCode: 'immutable_mismatch' as const, issueId: '00000000-0000-4000-8000-000000000109' };
    vi.mocked(database.transaction).mockResolvedValueOnce(expected);

    await expect(reconcilePaymentFinancialSource(database, gateway, {
      paymentId: '00000000-0000-4000-8000-000000000101', correlationId: 'provider-malformed'
    }, new AbortController().signal)).resolves.toEqual(expected);
    expect(database.transaction).toHaveBeenCalledOnce();
    expect(expected).not.toHaveProperty('cause');
    expect(JSON.stringify(expected)).not.toContain('commerce provider operation');
  });

  it('preserves retryable provider outages without writing an issue on every attempt', async () => {
    const database = routingDatabase({ id: '00000000-0000-4000-8000-000000000101',
      orderId: '00000000-0000-4000-8000-000000000102', stripePaymentIntentId: 'pi_outage',
      stripeLatestChargeId: 'ch_outage', paymentStatus: 'succeeded', orderStatus: 'paid' });
    const gateway = { retrievePayment: vi.fn(async () => { throw new RetryableProviderError(); }) } as unknown as StripeCommerceGateway;

    await expect(reconcilePaymentFinancialSource(database, gateway, {
      paymentId: '00000000-0000-4000-8000-000000000101', correlationId: 'provider-outage'
    }, new AbortController().signal)).rejects.toMatchObject({
      name: 'RetryableFinancialError', safeCode: 'provider_unavailable'
    });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it.each(['Error', 'AbortError'] as const)(
    'maps an unexpected provider exception named %s to a fresh cause-free retryable outage', async (name) => {
    const database = routingDatabase({ id: '00000000-0000-4000-8000-000000000101',
      orderId: '00000000-0000-4000-8000-000000000102', stripePaymentIntentId: 'pi_private_error',
      stripeLatestChargeId: 'ch_private_error', paymentStatus: 'succeeded', orderStatus: 'paid' });
    const privateText = 'private generic gateway failure';
    const gateway = { retrievePayment: vi.fn(async () => {
      const error = new Error(privateText, { cause: new Error('private nested cause') });
      error.name = name;
      throw error;
    }) } as unknown as StripeCommerceGateway;

    let caught: unknown;
    try {
      await reconcilePaymentFinancialSource(database, gateway, {
        paymentId: '00000000-0000-4000-8000-000000000101', correlationId: 'generic-provider-outage'
      }, new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'RetryableFinancialError', safeCode: 'provider_unavailable' });
    expect(caught).not.toHaveProperty('cause');
    expect(String(caught)).not.toContain(privateText);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('retrieves PaymentIntent, Charge, then Balance Transaction before opening any transaction', async () => {
    const trace: string[] = [];
    const database = routingDatabase({ id: '00000000-0000-4000-8000-000000000101',
      orderId: '00000000-0000-4000-8000-000000000102', stripePaymentIntentId: 'pi_trace',
      stripeLatestChargeId: 'ch_trace', paymentStatus: 'succeeded', orderStatus: 'paid' });
    const marker = new Error('stop at first transaction');
    vi.mocked(database.transaction).mockImplementation(async () => {
      trace.push('tx.begin');
      throw marker;
    });
    const createdAt = new Date('2026-08-10T00:00:00.000Z');
    const gateway = {
      retrievePayment: vi.fn(async () => { trace.push('provider.payment_intent'); return {
        paymentIntentId: 'pi_trace', metadataVersion: '1',
        metadataOrderId: '00000000-0000-4000-8000-000000000102', latestChargeId: 'ch_trace',
        liveMode: false, state: 'succeeded', amountMinor: 100, currency: 'usd', paidAt: createdAt,
        paymentMethodCategory: 'card'
      }; }),
      retrieveCharge: vi.fn(async () => { trace.push('provider.charge'); return {
        id: 'ch_trace', paymentIntentId: 'pi_trace', livemode: false, amountMinor: 100,
        amountRefundedMinor: 0, currency: 'USD', status: 'succeeded', balanceTransactionId: 'txn_trace',
        createdAt
      }; }),
      retrieveBalanceTransaction: vi.fn(async () => { trace.push('provider.balance_transaction'); return {
        id: 'txn_trace', livemode: false, sourceId: 'ch_trace', sourceFamily: 'charge', rawType: 'charge',
        reportingCategory: 'charge', amountMinor: 100, feeMinor: 0, netMinor: 100, currency: 'USD',
        status: 'available', balanceType: 'payments', createdAt, availableAt: createdAt,
        exchangeRate: null, exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
      }; })
    } as unknown as StripeCommerceGateway;

    await expect(reconcilePaymentFinancialSource(database, gateway, {
      paymentId: '00000000-0000-4000-8000-000000000101', correlationId: 'trace'
    }, new AbortController().signal)).rejects.toBe(marker);
    expect(trace).toEqual([
      'provider.payment_intent', 'provider.charge', 'provider.balance_transaction', 'tx.begin'
    ]);
  });
});

describe('lockCanonicalPaymentPurchaseFacts', () => {
  const paymentId = '00000000-0000-4000-8000-000000000101';
  const orderId = '00000000-0000-4000-8000-000000000102';
  const paidAt = new Date('2026-08-10T00:00:00.000Z');
  const payment = {
    paymentIntentId: 'pi_lock_boundary', metadataVersion: '1' as const, metadataOrderId: orderId,
    latestChargeId: 'ch_lock_boundary', liveMode: false, state: 'succeeded' as const,
    amountMinor: 100, currency: 'usd', paidAt, paymentMethodCategory: 'card' as const
  };
  const charge = {
    id: 'ch_lock_boundary', paymentIntentId: 'pi_lock_boundary', livemode: false,
    amountMinor: 100, amountRefundedMinor: 0, currency: 'USD', status: 'succeeded' as const,
    balanceTransactionId: 'txn_lock_boundary', createdAt: paidAt
  };
  const inheritedPayment = Object.assign(Object.create(payment) as object, {});
  const inheritedCharge = Object.assign(Object.create(charge) as object, {});

  it.each([
    ['inherited payment fields', inheritedPayment, charge],
    ['extra payment field', { ...payment, privateExtra: 'nope' }, charge],
    ['invalid payment date', { ...payment, paidAt: new Date(Number.NaN) }, charge],
    ['malformed payment scalar', { ...payment, amountMinor: '100' }, charge],
    ['inherited charge fields', payment, inheritedCharge],
    ['extra charge field', payment, { ...charge, privateExtra: 'nope' }],
    ['invalid charge date', payment, { ...charge, createdAt: new Date(Number.NaN) }],
    ['malformed charge scalar', payment, { ...charge, amountMinor: '100' }]
  ] as const)('rejects %s before taking an order lock', async (_label, nestedPayment, nestedCharge) => {
    const tx = { execute: vi.fn(), select: vi.fn() } as unknown as DatabaseTransaction;
    let caught: unknown;
    try {
      await lockCanonicalPaymentPurchaseFacts(tx, {
        paymentId, orderId, payment: nestedPayment, charge: nestedCharge
      } as Parameters<typeof lockCanonicalPaymentPurchaseFacts>[1]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'PermanentFinancialError', safeCode: 'invalid_job_payload' });
    expect(caught).not.toHaveProperty('cause');
    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.select).not.toHaveBeenCalled();
  });
});

describe('assertPaymentChargeProjectionConservation', () => {
  it.each([
    ['gross', { grossExpectedEffectMinor: 99, feeExpectedEffectMinor: -10, amountMinor: 100, feeMinor: 10, netMinor: 90 }],
    ['fee', { grossExpectedEffectMinor: 100, feeExpectedEffectMinor: -9, amountMinor: 100, feeMinor: 10, netMinor: 90 }],
    ['net', { grossExpectedEffectMinor: 100, feeExpectedEffectMinor: -10, amountMinor: 100, feeMinor: 10, netMinor: 89 }]
  ] as const)('rejects an individually nonconserving %s projection', (_label, input) => {
    expect(() => assertPaymentChargeProjectionConservation(input)).toThrow(expect.objectContaining({
      name: 'PermanentFinancialError', safeCode: 'allocation_mismatch'
    }));
  });
});
