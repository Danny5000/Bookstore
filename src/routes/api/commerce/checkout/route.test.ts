import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CartChangedError,
  CheckoutUnavailableError,
  CommerceConflictError,
  CommerceRateLimitError,
  InvalidCartError,
  PermanentCommerceError,
  RetryableProviderError
} from '$lib/server/commerce/errors';
import type { CommerceQuoteDto } from '$lib/types/commerce';

const dependencies = vi.hoisted(() => ({
  database: {},
  orchestrateCheckout: vi.fn()
}));

vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: dependencies.database })
}));
vi.mock('$lib/server/commerce/orders', () => ({
  orchestrateCheckout: dependencies.orchestrateCheckout
}));
vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({
    environment: 'test',
    origin: 'https://books.example.com',
    auth: { secret: 'test-application-secret-that-is-long-enough' },
    commerce: { checkoutRateLimitWindowSeconds: 60, checkoutRateLimitMax: 5 },
    stripe: {
      automaticTaxEnabled: true,
      proseTaxCode: 'txcd_10000000',
      comicTaxCode: 'txcd_10000001',
      checkoutDurationSeconds: 1800
    }
  })
}));

import { POST } from './+server';

const titleId = randomUUID();
const attemptId = randomUUID();
const orderId = randomUUID();
const fingerprint = 'a'.repeat(64);
const body = { titleIds: [titleId], quoteFingerprint: fingerprint, checkoutAttemptId: attemptId };
const anonymous = { type: 'anonymous' as const };

function event(
  requestBody: string,
  options: { origin?: string | null; contentType?: string } = {}
) {
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json',
    'x-request-id': 'checkout-request'
  };
  const origin = options.origin === undefined ? 'https://books.example.com' : options.origin;
  if (origin !== null) headers.origin = origin;
  return {
    locals: { actor: anonymous },
    request: new Request('https://internal/api/commerce/checkout', {
      method: 'POST', headers, body: requestBody
    }),
    getClientAddress: () => '203.0.113.8',
    cookies: { set: vi.fn(), get: vi.fn() }
  };
}

const quote: CommerceQuoteDto = {
  fingerprint: 'b'.repeat(64),
  currency: 'USD',
  subtotalMinor: 1500,
  items: [],
  alreadyOwnedTitleIds: [],
  claimableTitleIds: [],
  reservedTitleIds: [],
  unavailableTitleIds: [titleId],
  taxNotice: 'calculated_at_checkout',
  canCheckout: false
};

describe('POST /api/commerce/checkout', () => {
  beforeEach(() => {
    dependencies.orchestrateCheckout.mockResolvedValue({
      orderId,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_order_101',
      checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
      statusToken: Buffer.alloc(32, 9).toString('base64url')
    });
  });

  it('returns private JSON, passes only server authority, and sets the guest status cookie', async () => {
    const requestEvent = event(JSON.stringify(body));
    const response = await POST(requestEvent as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      status: 'redirect',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_order_101'
    });
    expect(dependencies.orchestrateCheckout).toHaveBeenCalledWith(
      dependencies.database,
      {
        actor: anonymous,
        titleIds: [titleId],
        quoteFingerprint: fingerprint,
        checkoutAttemptId: attemptId,
        correlationId: 'checkout-request',
        requestIp: '203.0.113.8',
        applicationSecret: 'test-application-secret-that-is-long-enough',
        rateLimit: { windowSeconds: 60, maxAttempts: 5 }
      },
      {
        origin: 'https://books.example.com',
        automaticTaxEnabled: true,
        proseTaxCode: 'txcd_10000000',
        comicTaxCode: 'txcd_10000001',
        checkoutDurationSeconds: 1800
      }
    );
    expect(requestEvent.cookies.set).toHaveBeenCalledWith(
      `pale_orbit_order_status_${orderId}`,
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', secure: false })
    );
    expect(JSON.stringify(responseBody)).not.toContain('status-token');
  });

  it('does not set a credential cookie for account-authorized checkout', async () => {
    dependencies.orchestrateCheckout.mockResolvedValueOnce({
      orderId,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_order_101',
      checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
      statusToken: null
    });
    const requestEvent = event(JSON.stringify(body));
    requestEvent.locals.actor = { type: 'user', id: randomUUID(), roles: ['customer'] } as never;
    const response = await POST(requestEvent as never);
    expect(response.status).toBe(200);
    expect(requestEvent.cookies.set).not.toHaveBeenCalled();
  });

  it.each([
    [new CartChangedError(quote), 409, { status: 'cart_changed', quote }],
    [new InvalidCartError(), 422, { code: 'INVALID_CART' }],
    [new CommerceConflictError('CHECKOUT_ATTEMPT_CONFLICT'), 409, {
      code: 'CHECKOUT_ATTEMPT_CONFLICT'
    }],
    [new CheckoutUnavailableError(), 503, { code: 'CHECKOUT_UNAVAILABLE' }],
    [new RetryableProviderError(), 503, { code: 'CHECKOUT_UNAVAILABLE' }],
    [new PermanentCommerceError(), 500, { code: 'CHECKOUT_UNAVAILABLE' }]
  ])('maps safe domain failure %# without leaking details', async (cause, status, expectedBody) => {
    dependencies.orchestrateCheckout.mockRejectedValueOnce(cause);
    const response = await POST(event(JSON.stringify(body)) as never);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(expectedBody);
  });

  it('returns bounded retry-after for checkout throttling', async () => {
    dependencies.orchestrateCheckout.mockRejectedValueOnce(new CommerceRateLimitError(17));
    const response = await POST(event(JSON.stringify(body)) as never);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    expect(await response.json()).toEqual({ code: 'RATE_LIMITED' });
  });

  it.each([
    [event('{bad'), 400, 'INVALID_JSON'],
    [event('{}', { contentType: 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [event(JSON.stringify({ ...body, extra: true })), 422, 'INVALID_INPUT'],
    [event(JSON.stringify({ ...body, padding: 'x'.repeat(9_000) })), 413, 'PAYLOAD_TOO_LARGE'],
    [event(JSON.stringify(body), { origin: null }), 403, 'forbidden'],
    [event(JSON.stringify(body), { origin: 'https://evil.example' }), 403, 'forbidden']
  ])('maps strict request failure %#', async (requestEvent, status, code) => {
    const response = await POST(requestEvent as never);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ code });
  });
});
