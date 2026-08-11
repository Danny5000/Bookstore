import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { InvalidCartError } from '$lib/server/commerce/errors';
import type { CommerceQuoteDto } from '$lib/types/commerce';

const dependencies = vi.hoisted(() => ({
  database: {},
  quoteCart: vi.fn(),
  consumeRateLimit: vi.fn(),
  rateLimitScopeDigest: vi.fn(() => 'a'.repeat(64))
}));

vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: dependencies.database })
}));
vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({
    origin: 'https://books.example.com',
    auth: { secret: 'test-application-secret-that-is-long-enough' },
    commerce: { checkoutRateLimitWindowSeconds: 60, checkoutRateLimitMax: 5 }
  })
}));
vi.mock('$lib/server/commerce/quote', () => ({ quoteCart: dependencies.quoteCart }));
vi.mock('$lib/server/commerce/rate-limit', () => ({
  consumeRateLimit: dependencies.consumeRateLimit,
  rateLimitScopeDigest: dependencies.rateLimitScopeDigest
}));

import { POST } from './+server';

const titleId = randomUUID();
const checkoutAttemptId = randomUUID();
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };
const quote: CommerceQuoteDto = {
  fingerprint: 'b'.repeat(64),
  currency: 'usd',
  subtotalMinor: 1299,
  items: [{
    titleId,
    slug: 'safe-title',
    title: 'Safe Title',
    creatorName: 'Creator',
    format: 'prose',
    coverUrl: null,
    unitSubtotalMinor: 1299,
    currency: 'usd'
  }],
  alreadyOwnedTitleIds: [],
  claimableTitleIds: [],
  reservedTitleIds: [],
  unavailableTitleIds: [],
  taxNotice: 'calculated_at_checkout',
  canCheckout: true
};

function event(
  body: string,
  options: {
    actor?: Actor;
    contentType?: string;
    origin?: string | null;
  } = {}
) {
  const origin = options.origin === undefined ? 'https://books.example.com' : options.origin;
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json'
  };
  if (origin !== null) headers.origin = origin;
  return {
    locals: { actor: options.actor ?? customer },
    request: new Request('https://internal/api/commerce/quote', {
      method: 'POST',
      headers,
      body
    }),
    getClientAddress: () => '203.0.113.7'
  };
}

describe('POST /api/commerce/quote', () => {
  beforeEach(() => {
    dependencies.consumeRateLimit.mockResolvedValue({
      allowed: true,
      limit: 5,
      remaining: 4,
      retryAfterSeconds: 0
    });
    dependencies.quoteCart.mockResolvedValue(quote);
  });

  it('throttles the actor and returns only the authoritative private quote', async () => {
    const response = await POST(event(JSON.stringify({
      titleIds: [titleId], checkoutAttemptId
    })) as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(quote);
    expect(dependencies.rateLimitScopeDigest).toHaveBeenCalledWith({
      actor: customer,
      requestIp: '203.0.113.7',
      applicationSecret: 'test-application-secret-that-is-long-enough'
    });
    expect(dependencies.consumeRateLimit).toHaveBeenCalledWith(dependencies.database, {
      namespace: 'commerce.quote',
      scopeSha256: 'a'.repeat(64),
      windowSeconds: 60,
      maxAttempts: 5
    });
    expect(dependencies.quoteCart).toHaveBeenCalledWith(
      dependencies.database,
      customer,
      [titleId],
      checkoutAttemptId
    );
  });

  it.each([
    ['wrong origin', event(JSON.stringify({ titleIds: [titleId], checkoutAttemptId }), { origin: 'https://evil.example' }), 403, 'forbidden'],
    ['missing origin', event(JSON.stringify({ titleIds: [titleId], checkoutAttemptId }), { origin: null }), 403, 'forbidden'],
    ['invalid JSON', event('{bad'), 400, 'INVALID_JSON'],
    ['unsupported media', event('{}', { contentType: 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['invalid input', event(JSON.stringify({ titleIds: [], checkoutAttemptId })), 422, 'INVALID_INPUT'],
    ['oversized input', event(JSON.stringify({ titleIds: [titleId], checkoutAttemptId, padding: 'x'.repeat(9_000) })), 413, 'PAYLOAD_TOO_LARGE']
  ])('maps %s to a private response', async (_label, requestEvent, status, code) => {
    const response = await POST(requestEvent as never);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ code });
  });

  it('returns a bounded retry delay without invoking quote dependencies when throttled', async () => {
    dependencies.consumeRateLimit.mockResolvedValueOnce({
      allowed: false,
      limit: 5,
      remaining: 0,
      retryAfterSeconds: 17
    });

    const response = await POST(event(JSON.stringify({ titleIds: [titleId], checkoutAttemptId })) as never);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    expect(await response.json()).toEqual({ code: 'RATE_LIMITED' });
    expect(dependencies.quoteCart).not.toHaveBeenCalled();
  });

  it('maps invalid carts and unexpected failures without leaking details', async () => {
    dependencies.quoteCart.mockRejectedValueOnce(new InvalidCartError());
    const invalid = await POST(event(JSON.stringify({ titleIds: [titleId, titleId], checkoutAttemptId })) as never);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ code: 'INVALID_CART' });

    dependencies.quoteCart.mockRejectedValueOnce(new Error('private database detail'));
    const unavailable = await POST(event(JSON.stringify({ titleIds: [titleId], checkoutAttemptId })) as never);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ code: 'TEMPORARILY_UNAVAILABLE' });
  });
});
