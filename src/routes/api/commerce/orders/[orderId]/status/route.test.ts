import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderNotFoundError } from '$lib/server/commerce/errors';

const dependencies = vi.hoisted(() => ({
  database: {},
  getAuthorizedOrderStatus: vi.fn()
}));

vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: dependencies.database })
}));
vi.mock('$lib/server/commerce/status', () => ({
  getAuthorizedOrderStatus: dependencies.getAuthorizedOrderStatus
}));

import { GET } from './+server';

const orderId = randomUUID();
const actor = { type: 'user' as const, id: randomUUID(), roles: ['customer' as const] };

function event(options: {
  selectedActor?: typeof actor | { type: 'anonymous' };
  selectedOrderId?: string;
  token?: string | null;
} = {}) {
  const token = options.token === undefined ? null : options.token;
  return {
    locals: { actor: options.selectedActor ?? actor },
    params: { orderId: options.selectedOrderId ?? orderId },
    cookies: { get: vi.fn(() => token) }
  };
}

describe('GET /api/commerce/orders/[orderId]/status', () => {
  beforeEach(() => {
    dependencies.getAuthorizedOrderStatus.mockResolvedValue({ status: 'pending' });
  });

  it('passes exact account/cookie authority and returns only private minimal status', async () => {
    const token = Buffer.alloc(32, 2).toString('base64url');
    const requestEvent = event({ selectedActor: { type: 'anonymous' }, token });
    const response = await GET(requestEvent as never);

    expect(dependencies.getAuthorizedOrderStatus).toHaveBeenCalledWith(dependencies.database, {
      orderId,
      actor: { type: 'anonymous' },
      statusToken: token
    });
    expect(requestEvent.cookies.get).toHaveBeenCalledWith(
      `pale_orbit_order_status_${orderId}`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  it.each([
    [{ status: 'paid', libraryUrl: '/library' }],
    [{ status: 'paid_guest', claimMessage: 'Check your email for a secure link to claim this purchase.' }],
    [{ status: 'failed', message: 'Payment confirmation is still resolving.' }],
    [{ status: 'expired', message: 'Checkout expired.' }],
    [{ status: 'exception', message: 'This purchase needs review.' }]
  ])('passes through a safe DTO without adding order detail', async (status) => {
    dependencies.getAuthorizedOrderStatus.mockResolvedValueOnce(status);
    const response = await GET(event() as never);
    const body = await response.json();
    expect(body).toEqual(status);
    expect(JSON.stringify(body)).not.toMatch(/@|amount|title|guestIdentity|stripe|token/iu);
  });

  it('maps missing, invalid, mismatched, expired, rotated, and other-user credentials uniformly', async () => {
    for (const requestEvent of [
      event({ token: null }),
      event({ token: 'bad' }),
      event({ selectedActor: { ...actor, id: randomUUID() } })
    ]) {
      dependencies.getAuthorizedOrderStatus.mockRejectedValueOnce(new OrderNotFoundError());
      const response = await GET(requestEvent as never);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: 'NOT_FOUND' });
    }
    const invalidId = await GET(event({ selectedOrderId: 'not-a-uuid' }) as never);
    expect(invalidId.status).toBe(404);
    expect(await invalidId.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('maps unexpected dependency failures to a private 503', async () => {
    dependencies.getAuthorizedOrderStatus.mockRejectedValueOnce(
      new Error('private database detail')
    );
    const response = await GET(event() as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'TEMPORARILY_UNAVAILABLE' });
  });
});
