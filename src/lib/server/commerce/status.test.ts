import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import type { OrderRow } from '$lib/server/db/schema';
import { OrderNotFoundError } from './errors';
import { createOrderStatusCredential } from './status-cookie';
import { authorizeOrderStatus } from './status';

const userId = randomUUID();
const otherUserId = randomUUID();
const orderId = randomUUID();
const createdAt = new Date('2026-08-10T12:00:00.000Z');
const credential = createOrderStatusCredential(() => Buffer.alloc(32, 4));

function row(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: orderId,
    status: 'checkout_open',
    initiatingUserId: userId,
    guestIdentityId: null,
    purchaseEmail: 'private@example.com',
    currency: 'USD',
    subtotalMinor: 1999,
    taxMinor: null,
    totalMinor: null,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: 'cs_test_private',
    statusTokenSha256: credential.digestSha256,
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides
  };
}

const account: Actor = { type: 'user', id: userId, roles: ['customer'] };
const otherAdmin: Actor = { type: 'user', id: otherUserId, roles: ['customer', 'admin'] };

describe('minimal authorized order status', () => {
  it('authorizes the exact initiating account without exposing private order fields', () => {
    const status = authorizeOrderStatus(row(), {
      actor: account,
      statusToken: null,
      now: new Date('2026-08-10T13:00:00.000Z')
    });
    expect(status).toEqual({ status: 'pending' });
    expect(JSON.stringify(status)).not.toMatch(/private@example|1999|USD|cs_test|orderId|token/iu);
  });

  it('does not grant access from an admin role or another account identity', () => {
    for (const actor of [otherAdmin, { type: 'anonymous' } as const]) {
      expect(() => authorizeOrderStatus(row(), {
        actor,
        statusToken: null,
        now: new Date('2026-08-10T12:10:00.000Z')
      })).toThrow(OrderNotFoundError);
    }
  });

  it('authorizes an exact unexpired cookie and rejects bad, expired, or rotated values uniformly', () => {
    expect(authorizeOrderStatus(row({ initiatingUserId: null }), {
      actor: { type: 'anonymous' },
      statusToken: credential.token,
      now: new Date('2026-08-10T12:44:59.000Z')
    })).toEqual({ status: 'pending' });

    const rotated = createOrderStatusCredential(() => Buffer.alloc(32, 5));
    for (const [order, token, now] of [
      [row({ initiatingUserId: null }), 'invalid', new Date('2026-08-10T12:10:00.000Z')],
      [row({ initiatingUserId: null }), credential.token, new Date('2026-08-10T12:45:00.001Z')],
      [row({ initiatingUserId: null, statusTokenSha256: rotated.digestSha256 }), credential.token, new Date('2026-08-10T12:10:00.000Z')]
    ] as const) {
      expect(() => authorizeOrderStatus(order, {
        actor: { type: 'anonymous' }, statusToken: token, now
      })).toThrow(OrderNotFoundError);
    }
  });

  it('maps every persisted lifecycle state to the minimal browser contract', () => {
    const now = new Date('2026-08-10T12:10:00.000Z');
    for (const status of ['checkout_pending', 'checkout_open', 'payment_pending'] as const) {
      expect(authorizeOrderStatus(row({ status }), { actor: account, statusToken: null, now }))
        .toEqual({ status: 'pending' });
    }
    expect(authorizeOrderStatus(row({
      status: 'paid', paidAt: now, taxMinor: 100, totalMinor: 2099
    }), { actor: account, statusToken: null, now })).toEqual({
      status: 'paid', libraryUrl: '/library'
    });
    expect(authorizeOrderStatus(row({
      status: 'paid', initiatingUserId: null, guestIdentityId: randomUUID(), paidAt: now,
      taxMinor: 100, totalMinor: 2099
    }), { actor: { type: 'anonymous' }, statusToken: credential.token, now })).toEqual({
      status: 'paid_guest',
      claimMessage: 'Check your email for a secure link to claim this purchase.'
    });
    for (const status of ['failed', 'expired', 'exception'] as const) {
      const result = authorizeOrderStatus(row({ status }), { actor: account, statusToken: null, now });
      expect(result.status).toBe(status);
      expect(result).toHaveProperty('message');
    }
  });
});
