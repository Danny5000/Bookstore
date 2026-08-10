import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CartChangedError, CommerceConflictError, RetryableProviderError } from './errors';
import {
  orchestrateCheckout,
  type AcceptedOrder,
  type CheckoutOrchestrationDependencies
} from './orders';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const orderId = randomUUID();
const titleId = randomUUID();
const orderItemId = randomUUID();
const attemptId = randomUUID();
const createdAt = new Date('2026-08-10T12:00:00.000Z');

function accepted(overrides: Partial<AcceptedOrder> = {}): AcceptedOrder {
  return {
    order: {
      id: orderId,
      status: 'checkout_pending',
      initiatingUserId: randomUUID(),
      guestIdentityId: null,
      purchaseEmail: 'reader@example.com',
      currency: 'USD',
      subtotalMinor: 1299,
      taxMinor: null,
      totalMinor: null,
      clientCheckoutAttemptId: attemptId,
      quoteFingerprintSha256: 'a'.repeat(64),
      stripeCheckoutSessionId: null,
      statusTokenSha256: 'b'.repeat(64),
      checkoutExpiresAt: null,
      paidAt: null,
      createdAt,
      updatedAt: createdAt
    },
    items: [{
      id: orderItemId,
      orderId,
      titleId,
      titleSnapshot: 'Immutable Book',
      creatorNameSnapshot: 'Private Creator Snapshot',
      format: 'prose',
      currency: 'USD',
      unitSubtotalMinor: 1299,
      taxMinor: null,
      totalMinor: null,
      stripeLineItemId: null,
      createdAt
    }],
    statusToken: 'guest-status-token-must-stay-local',
    reused: false,
    ...overrides
  };
}

const input = {
  actor: { type: 'anonymous' as const },
  titleIds: [titleId],
  quoteFingerprint: 'a'.repeat(64),
  checkoutAttemptId: attemptId,
  correlationId: 'checkout-unit',
  requestIp: '198.51.100.20',
  applicationSecret: 'unit-application-secret-that-is-long-enough',
  rateLimit: { windowSeconds: 60, maxAttempts: 10 },
  now: createdAt
};

const options = {
  origin: 'https://books.example.com',
  automaticTaxEnabled: true,
  proseTaxCode: 'txcd_10000000',
  comicTaxCode: 'txcd_10000001',
  checkoutDurationSeconds: 1800
};

function dependencies(): CheckoutOrchestrationDependencies {
  return {
    createAcceptedOrder: vi.fn().mockResolvedValue(accepted()),
    createCheckoutSession: vi.fn().mockResolvedValue({
      providerSessionId: 'cs_test_order_101',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_order_101',
      expiresAt: new Date('2026-08-10T12:31:00.000Z')
    }),
    attachCheckoutSession: vi.fn().mockResolvedValue(undefined),
    currentTime: vi.fn().mockReturnValue(new Date('2026-08-10T12:00:10.000Z'))
  };
}

describe('Checkout orchestration', () => {
  it('waits for commit before provider work and uses a later attachment transaction', async () => {
    const orderCommit = deferred<AcceptedOrder>();
    const providerResponse = deferred<{
      providerSessionId: string;
      checkoutUrl: string;
      expiresAt: Date;
    }>();
    const calls: string[] = [];
    const deps = dependencies();
    vi.mocked(deps.createAcceptedOrder).mockImplementation(async () => {
      calls.push('order-start');
      const value = await orderCommit.promise;
      calls.push('order-committed');
      return value;
    });
    vi.mocked(deps.createCheckoutSession).mockImplementation(async () => {
      calls.push('provider-start');
      return providerResponse.promise;
    });
    vi.mocked(deps.attachCheckoutSession).mockImplementation(async () => {
      calls.push('attach-transaction');
    });

    const work = orchestrateCheckout({} as never, input, options, deps);
    await Promise.resolve();
    expect(calls).toEqual(['order-start']);
    expect(deps.createCheckoutSession).not.toHaveBeenCalled();
    orderCommit.resolve(accepted());
    await vi.waitFor(() => expect(calls).toEqual([
      'order-start', 'order-committed', 'provider-start'
    ]));
    expect(deps.attachCheckoutSession).not.toHaveBeenCalled();
    providerResponse.resolve({
      providerSessionId: 'cs_test_order_101',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_order_101',
      expiresAt: new Date('2026-08-10T12:31:00.000Z')
    });

    await expect(work).resolves.toEqual({
      orderId,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_order_101',
      checkoutExpiresAt: new Date('2026-08-10T12:31:00.000Z'),
      statusToken: 'guest-status-token-must-stay-local'
    });
    expect(calls).toEqual([
      'order-start', 'order-committed', 'provider-start', 'attach-transaction'
    ]);
  });

  it('maps only stored immutable order data to the provider request', async () => {
    const deps = dependencies();
    await orchestrateCheckout({} as never, input, options, deps);

    expect(deps.createCheckoutSession).toHaveBeenCalledWith({
      orderId,
      accountEmail: 'reader@example.com',
      currency: 'usd',
      automaticTaxEnabled: true,
      expiresAt: new Date('2026-08-10T12:31:00.000Z'),
      successUrl: `https://books.example.com/checkout/success?order=${orderId}`,
      cancelUrl: 'https://books.example.com/checkout/cancel',
      items: [{
        orderItemId,
        title: 'Immutable Book',
        format: 'prose',
        unitSubtotalMinor: 1299,
        taxCode: 'txcd_10000000'
      }]
    });
    const providerInput = vi.mocked(deps.createCheckoutSession).mock.calls[0]?.[0];
    expect(JSON.stringify(providerInput)).not.toMatch(/Private Creator|guest-status-token/iu);
    expect(deps.attachCheckoutSession).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        orderId,
        providerSessionId: 'cs_test_order_101',
        correlationId: 'checkout-unit'
      })
    );
  });

  it('never calls the provider after cart change and leaves pending orders recoverable on provider error', async () => {
    const changed = dependencies();
    vi.mocked(changed.createAcceptedOrder).mockRejectedValueOnce(new CartChangedError());
    await expect(orchestrateCheckout({} as never, input, options, changed)).rejects.toBeInstanceOf(
      CartChangedError
    );
    expect(changed.createCheckoutSession).not.toHaveBeenCalled();

    const retryable = dependencies();
    vi.mocked(retryable.createCheckoutSession).mockRejectedValueOnce(new RetryableProviderError());
    await expect(orchestrateCheckout({} as never, input, options, retryable)).rejects.toBeInstanceOf(
      RetryableProviderError
    );
    expect(retryable.attachCheckoutSession).not.toHaveBeenCalled();
  });

  it('recovers a lost provider response or local attachment failure through the same idempotent request', async () => {
    const first = dependencies();
    vi.mocked(first.createCheckoutSession).mockRejectedValueOnce(new RetryableProviderError());
    await expect(orchestrateCheckout({} as never, input, options, first)).rejects.toBeInstanceOf(
      RetryableProviderError
    );

    const retry = dependencies();
    vi.mocked(retry.createAcceptedOrder).mockResolvedValueOnce(accepted({ reused: true }));
    vi.mocked(retry.attachCheckoutSession).mockRejectedValueOnce(new Error('temporary database failure'));
    await expect(orchestrateCheckout({} as never, input, options, retry)).rejects.toThrow(
      'temporary database failure'
    );

    const recovered = dependencies();
    vi.mocked(recovered.createAcceptedOrder).mockResolvedValueOnce(accepted({ reused: true }));
    await expect(orchestrateCheckout({} as never, input, options, recovered)).resolves.toMatchObject({
      orderId,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_order_101'
    });
    for (const deps of [retry, recovered]) {
      expect(deps.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ orderId, expiresAt: new Date('2026-08-10T12:31:00.000Z') })
      );
    }
  });

  it('uses a stable whole-second deadline with a provider-creation allowance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:10.000Z'));
    try {
      const deps = dependencies();
      const acceptedAt = new Date('2026-08-10T12:00:00.987Z');
      vi.mocked(deps.createAcceptedOrder).mockResolvedValueOnce(accepted({
        order: { ...accepted().order, createdAt: acceptedAt, updatedAt: acceptedAt }
      }));
      vi.mocked(deps.createCheckoutSession).mockImplementationOnce(async (request) => ({
        providerSessionId: 'cs_test_order_101',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_order_101',
        expiresAt: request.expiresAt
      }));

      await orchestrateCheckout({} as never, input, options, deps);

      expect(deps.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
        expiresAt: new Date('2026-08-10T12:31:00.000Z')
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a stale unattached attempt before sending an invalid provider expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:31.001Z'));
    try {
      const deps = dependencies();
      vi.mocked(deps.currentTime).mockReturnValueOnce(new Date());
      await expect(
        orchestrateCheckout({} as never, input, options, deps)
      ).rejects.toBeInstanceOf(CommerceConflictError);
      expect(deps.createCheckoutSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
