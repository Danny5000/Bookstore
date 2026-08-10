import { describe, expect, it, vi } from 'vitest';
import {
  ORDER_STATUS_PROCESSING_GRACE_SECONDS,
  createOrderStatusCredential,
  isOrderStatusCredentialExpired,
  matchesOrderStatusToken,
  orderStatusCookieName,
  orderStatusCookieOptions,
  setOrderStatusCookie
} from './status-cookie';

const orderId = '00000000-0000-4000-8000-000000000201';
const now = new Date('2026-08-10T12:00:00.000Z');
const expiresAt = new Date('2026-08-10T12:30:00.000Z');

describe('order status credentials', () => {
  it('generates 32 random bytes as base64url and persists only SHA-256', () => {
    const credential = createOrderStatusCredential(() => Buffer.alloc(32, 7));

    expect(credential.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(credential.digestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(credential.digestSha256).not.toContain(credential.token);
    expect(matchesOrderStatusToken(credential.token, credential.digestSha256)).toBe(true);
    expect(matchesOrderStatusToken(`${credential.token.slice(0, -1)}A`, credential.digestSha256)).toBe(false);
    expect(matchesOrderStatusToken('not-canonical', credential.digestSha256)).toBe(false);
    expect(matchesOrderStatusToken(credential.token, 'bad-digest')).toBe(false);
  });

  it('uses an order-specific name and narrowly scoped private cookie', () => {
    expect(orderStatusCookieName(orderId)).toBe(`pale_orbit_order_status_${orderId}`);
    expect(orderStatusCookieOptions({
      environment: 'production', orderId, checkoutExpiresAt: expiresAt, now
    })).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: `/api/commerce/orders/${orderId}`,
      maxAge: 1800 + ORDER_STATUS_PROCESSING_GRACE_SECONDS
    });
    expect(orderStatusCookieOptions({
      environment: 'development', orderId, checkoutExpiresAt: expiresAt, now
    }).secure).toBe(false);
  });

  it('bounds cookie duration and verifies server-side expiry including processing grace', () => {
    const farFuture = new Date('2026-08-11T12:00:00.000Z');
    const options = orderStatusCookieOptions({
      environment: 'test', orderId, checkoutExpiresAt: farFuture, now
    });
    expect(options.maxAge).toBeLessThanOrEqual(3600);
    expect(isOrderStatusCredentialExpired(expiresAt, new Date('2026-08-10T12:44:59.000Z'))).toBe(false);
    expect(isOrderStatusCredentialExpired(expiresAt, new Date('2026-08-10T12:45:00.001Z'))).toBe(true);
    expect(isOrderStatusCredentialExpired(null, now)).toBe(true);
  });

  it('sets only the plaintext cookie while keeping it out of the name, path, and options', () => {
    const set = vi.fn();
    const token = createOrderStatusCredential(() => Buffer.alloc(32, 8)).token;
    setOrderStatusCookie({ set } as never, {
      environment: 'production', orderId, token, checkoutExpiresAt: expiresAt, now
    });

    expect(set).toHaveBeenCalledWith(
      `pale_orbit_order_status_${orderId}`,
      token,
      expect.objectContaining({ httpOnly: true, secure: true })
    );
    const [name, , options] = set.mock.calls[0]!;
    expect(`${name}${JSON.stringify(options)}`).not.toContain(token);
  });
});
