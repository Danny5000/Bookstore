import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import type { StripeCommerceGateway, VerifiedStripeEvent } from '$lib/server/commerce/stripe/types';

const dependencies = vi.hoisted(() => ({
  database: {},
  acceptStripeEvent: vi.fn(),
  verifyWebhook: vi.fn(),
  getStripeCommerceRuntime: vi.fn()
}));

vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: dependencies.database })
}));
vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({ stripe: { liveMode: false } })
}));
vi.mock('$lib/server/commerce/stripe/runtime', () => ({
  getStripeCommerceRuntime: dependencies.getStripeCommerceRuntime
}));
vi.mock('$lib/server/commerce/webhooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/commerce/webhooks')>()),
  acceptStripeEvent: dependencies.acceptStripeEvent
}));

import { POST } from './+server';
import { getStripeCommerceRuntime } from '$lib/server/commerce/stripe/runtime';

const rawText = '  {"snowman":"☃"}\r\n';
const rawBytes = new TextEncoder().encode(rawText);

function gateway(): StripeCommerceGateway {
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected non-webhook gateway call');
  };
  return {
    createCheckoutSession: unused,
    retrieveCheckoutSession: unused,
    retrievePayment: unused,
    retrieveRefund: unused,
    retrieveDispute: unused,
    retrieveCharge: unused,
    retrieveBalanceTransaction: unused,
    retrievePayout: unused,
    listBalanceTransactionsForSource: unused,
    listBalanceTransactionsForPayout: unused,
    listPayouts: unused,
    verifyWebhook: dependencies.verifyWebhook
  };
}

function verified(overrides: Partial<VerifiedStripeEvent> = {}): VerifiedStripeEvent {
  return {
    providerEventId: 'evt_test_route_101',
    type: 'checkout.session.completed',
    objectId: 'cs_test_route_101',
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: new Date('2026-08-10T12:00:00.000Z'),
    rawBodySha256: createHash('sha256').update(rawBytes).digest('hex'),
    ...overrides
  };
}

function event(options: {
  body?: BodyInit;
  signature?: string | null;
  contentLength?: string;
} = {}) {
  const headers: Record<string, string> = {};
  const signature = options.signature === undefined ? 'fixture-signature' : options.signature;
  if (signature !== null) headers['stripe-signature'] = signature;
  if (options.contentLength) headers['content-length'] = options.contentLength;
  return {
    request: new Request('https://books.example.com/api/webhooks/stripe', {
      method: 'POST',
      headers,
      body: options.body ?? rawBytes
    })
  };
}

describe('POST /api/webhooks/stripe', () => {
  beforeEach(() => {
    dependencies.getStripeCommerceRuntime.mockReturnValue({
      mode: 'fixture',
      webhooksConfigured: true,
      gateway: gateway()
    });
    dependencies.verifyWebhook.mockReturnValue(verified());
    dependencies.acceptStripeEvent.mockResolvedValue({
      status: 'accepted', stripeEventId: '00000000-0000-4000-8000-000000000301'
    });
  });

  it('returns 404 without reading the request when the provider is disabled', async () => {
    vi.mocked(getStripeCommerceRuntime).mockReturnValueOnce({
      mode: 'disabled',
      webhooksConfigured: false,
      gateway: gateway()
    });
    const requestEvent = event();
    let bodyRead = false;
    Object.defineProperty(requestEvent.request, 'body', {
      get() { bodyRead = true; return null; }
    });
    const response = await POST(requestEvent as never);
    expect(response.status).toBe(404);
    expect(bodyRead).toBe(false);
    expect(dependencies.verifyWebhook).not.toHaveBeenCalled();
  });

  it('rejects missing/invalid signatures and oversize bodies before persistence', async () => {
    expect((await POST(event({ signature: null }) as never)).status).toBe(400);
    dependencies.verifyWebhook.mockImplementationOnce(() => {
      throw new PermanentCommerceError();
    });
    expect((await POST(event() as never)).status).toBe(400);
    expect((await POST(event({ contentLength: '65537' }) as never)).status).toBe(413);
    expect(dependencies.acceptStripeEvent).not.toHaveBeenCalled();
  });

  it('verifies exact untouched bytes and persists a supported minimized event before 200', async () => {
    const response = await POST(event() as never);
    expect(dependencies.verifyWebhook).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'fixture-signature'
    );
    const verifiedBytes = dependencies.verifyWebhook.mock.calls[0]?.[0];
    expect(verifiedBytes).toEqual(rawBytes);
    expect(new TextDecoder().decode(verifiedBytes)).toBe(rawText);
    expect(dependencies.acceptStripeEvent).toHaveBeenCalledWith(
      dependencies.database,
      verified()
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ received: true });
  });

  it('acknowledges unsupported valid events without persistence', async () => {
    dependencies.verifyWebhook.mockReturnValueOnce(verified({
      type: 'customer.created', objectId: 'cus_test_route_101'
    }));
    const response = await POST(event() as never);
    expect(response.status).toBe(200);
    expect(dependencies.acceptStripeEvent).not.toHaveBeenCalled();
  });

  it('rejects live-mode mismatch and retries persistence failures', async () => {
    dependencies.verifyWebhook.mockReturnValueOnce(verified({ liveMode: true }));
    expect((await POST(event() as never)).status).toBe(400);
    expect(dependencies.acceptStripeEvent).not.toHaveBeenCalled();

    dependencies.acceptStripeEvent.mockRejectedValueOnce(new Error('temporary database failure'));
    const retry = await POST(event() as never);
    expect(retry.status).toBe(500);
    expect(await retry.json()).toEqual({ received: false });
  });
});
