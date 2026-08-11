import { describe, expect, it, vi } from 'vitest';
import type { CommerceQuoteDto } from '$lib/types/commerce';
import {
  CHECKOUT_PENDING_STORAGE_KEY,
  CheckoutClientError,
  QuoteRequestCoordinator,
  buildCheckoutRequest,
  createCheckout,
  isAllowedCheckoutUrl,
  loadPendingCheckout,
  pollOrderStatus,
  requestOrderStatus,
  requestQuote,
  storePendingCheckout
} from './checkout-client';

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const quote: CommerceQuoteDto = {
  fingerprint: 'a'.repeat(64),
  currency: 'USD',
  subtotalMinor: 1299,
  items: [{
    titleId: uuid(1),
    slug: 'glass-moon',
    title: 'The Glass Moon',
    creatorName: 'A. Writer',
    format: 'prose',
    coverUrl: null,
    unitSubtotalMinor: 1299,
    currency: 'USD'
  }],
  alreadyOwnedTitleIds: [],
  claimableTitleIds: [],
  reservedTitleIds: [],
  unavailableTitleIds: [],
  taxNotice: 'calculated_at_checkout',
  canCheckout: true
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });

describe('commerce browser client', () => {
  it('quotes with title IDs plus the current attempt and validates the private response', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(quote));
    await expect(requestQuote(fetcher, [uuid(1)], uuid(100))).resolves.toEqual(quote);
    expect(fetcher).toHaveBeenCalledWith('/api/commerce/quote', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ titleIds: [uuid(1)], checkoutAttemptId: uuid(100) })
    }));
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      titleIds: [uuid(1)],
      checkoutAttemptId: uuid(100)
    });
  });

  it.each([
    [422, { code: 'INVALID_CART' }, 'invalid_cart'],
    [429, { code: 'RATE_LIMITED' }, 'rate_limited'],
    [503, { code: 'TEMPORARILY_UNAVAILABLE' }, 'temporarily_unavailable'],
    [200, { ...quote, subtotalMinor: '12.99' }, 'invalid_response']
  ])('maps quote response %# to a stable client error', async (status, body, kind) => {
    const fetcher = vi.fn(async () => jsonResponse(body, status));
    await expect(requestQuote(fetcher, [uuid(1)], uuid(100))).rejects.toMatchObject({ kind });
  });

  it('aborts the prior request and ignores a stale out-of-order result', async () => {
    const resolvers: Array<(value: CommerceQuoteDto) => void> = [];
    const signals: AbortSignal[] = [];
    const coordinator = new QuoteRequestCoordinator((_fetcher, ids, _attemptId, signal) => {
      signals.push(signal);
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const first = coordinator.refresh(vi.fn(), [uuid(1)], uuid(100));
    const second = coordinator.refresh(vi.fn(), [uuid(2)], uuid(101));
    expect(signals[0]!.aborted).toBe(true);

    resolvers[1]!({ ...quote, fingerprint: 'b'.repeat(64) });
    await expect(second).resolves.toMatchObject({ status: 'current' });
    resolvers[0]!(quote);
    await expect(first).resolves.toEqual({ status: 'stale' });
  });

  it('posts the reviewed fingerprint and attempt exactly once per call', async () => {
    const checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_123';
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ status: 'redirect', checkoutUrl })
    );
    await expect(createCheckout(fetcher, {
      titleIds: [uuid(1)],
      quoteFingerprint: quote.fingerprint,
      checkoutAttemptId: uuid(100)
    })).resolves.toEqual({ status: 'redirect', checkoutUrl });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      titleIds: [uuid(1)],
      quoteFingerprint: quote.fingerprint,
      checkoutAttemptId: uuid(100)
    });
  });

  it('builds checkout from the whole reviewed cart, not only accepted items', () => {
    const reviewed = {
      ...quote,
      alreadyOwnedTitleIds: [uuid(2)],
      claimableTitleIds: [uuid(3)],
      reservedTitleIds: [uuid(4)],
      unavailableTitleIds: [uuid(5)]
    };
    expect(buildCheckoutRequest(
      [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)],
      reviewed,
      uuid(100)
    )).toEqual({
      titleIds: [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)],
      quoteFingerprint: quote.fingerprint,
      checkoutAttemptId: uuid(100)
    });
    expect(() => buildCheckoutRequest([uuid(1)], reviewed, uuid(100))).toThrow(
      CheckoutClientError
    );
  });

  it('returns a changed quote for explicit reconfirmation and maps provider failure safely', async () => {
    const changed = vi.fn(async () => jsonResponse({ status: 'cart_changed', quote }, 409));
    await expect(createCheckout(changed, {
      titleIds: [uuid(1)], quoteFingerprint: 'b'.repeat(64), checkoutAttemptId: uuid(100)
    })).resolves.toEqual({ status: 'cart_changed', quote });

    const unavailable = vi.fn(async () => jsonResponse({ code: 'CHECKOUT_UNAVAILABLE' }, 503));
    await expect(createCheckout(unavailable, {
      titleIds: [uuid(1)], quoteFingerprint: quote.fingerprint, checkoutAttemptId: uuid(100)
    })).rejects.toEqual(expect.objectContaining({ kind: 'checkout_unavailable' }));

    const usedAttempt = vi.fn(async () => jsonResponse({
      code: 'CHECKOUT_ATTEMPT_CONFLICT'
    }, 409));
    await expect(createCheckout(usedAttempt, {
      titleIds: [uuid(1)], quoteFingerprint: quote.fingerprint, checkoutAttemptId: uuid(100)
    })).rejects.toEqual(expect.objectContaining({ kind: 'attempt_conflict' }));
  });

  it.each([
    ['https://checkout.stripe.com/c/pay/cs_test_123', true],
    [`https://checkout.stripe.test/session/${uuid(100)}`, true],
    ['http://checkout.stripe.com/c/pay/cs_test_123', false],
    ['https://checkout.stripe.com.evil.example/c/pay/cs_test_123', false],
    ['javascript:alert(1)', false],
    ['https://checkout.stripe.test/other', false]
  ])('validates hosted redirect %s', (url, expected) => {
    expect(isAllowedCheckoutUrl(url)).toBe(expected);
  });

  it('stores and loads only bounded accepted IDs and the attempt UUID', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    };
    const pending = { acceptedTitleIds: [uuid(1), uuid(2)], checkoutAttemptId: uuid(100) };
    storePendingCheckout(storage, pending);
    expect(loadPendingCheckout(storage)).toEqual(pending);
    expect(JSON.parse(values.get(CHECKOUT_PENDING_STORAGE_KEY)!)).toEqual(pending);
    expect(values.get(CHECKOUT_PENDING_STORAGE_KEY)).not.toMatch(/price|email|order|provider|url/iu);

    values.set(CHECKOUT_PENDING_STORAGE_KEY, JSON.stringify({ ...pending, priceMinor: 1299 }));
    expect(loadPendingCheckout(storage)).toBeNull();
    expect(values.has(CHECKOUT_PENDING_STORAGE_KEY)).toBe(false);
  });

  it('rejects malformed JSON even when a response claims success', async () => {
    const fetcher = vi.fn(async () => new Response('{bad', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    await expect(requestQuote(fetcher, [uuid(1)], uuid(100))).rejects.toBeInstanceOf(CheckoutClientError);
  });

  it('polls private order status immediately and every two seconds until terminal', async () => {
    const responses = [
      { status: 'pending' as const },
      { status: 'failed' as const, message: 'Payment confirmation is still resolving.' },
      { status: 'paid' as const, libraryUrl: '/library' as const }
    ];
    const fetcher = vi.fn(async () => jsonResponse(responses.shift()));
    const observed: string[] = [];
    let now = 0;
    const result = await pollOrderStatus(fetcher, uuid(200), {
      signal: new AbortController().signal,
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
      onStatus: (status) => observed.push(status.status)
    });

    expect(result).toEqual({
      outcome: 'terminal',
      status: { status: 'paid', libraryUrl: '/library' }
    });
    expect(observed).toEqual(['pending', 'failed', 'paid']);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/commerce/orders/${uuid(200)}/status`,
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
    );
    expect(now).toBe(4_000);
  });

  it('times out after sixty seconds and stops before another request', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ status: 'pending' }));
    let now = 0;
    const waits: number[] = [];
    const result = await pollOrderStatus(fetcher, uuid(200), {
      signal: new AbortController().signal,
      now: () => now,
      wait: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; }
    });
    expect(result).toEqual({ outcome: 'timeout' });
    expect(now).toBe(60_000);
    expect(waits).toHaveLength(30);
    expect(fetcher).toHaveBeenCalledTimes(30);
  });

  it('stops polling on abort and rejects invalid status DTOs', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => jsonResponse({ status: 'pending' }));
    await expect(pollOrderStatus(fetcher, uuid(200), { signal: controller.signal }))
      .resolves.toEqual({ outcome: 'aborted' });
    expect(fetcher).not.toHaveBeenCalled();

    const invalid = vi.fn(async () => jsonResponse({ status: 'paid', email: 'private@example.com' }));
    await expect(requestOrderStatus(invalid, uuid(200)))
      .rejects.toEqual(expect.objectContaining({ kind: 'invalid_response' }));
  });
});
