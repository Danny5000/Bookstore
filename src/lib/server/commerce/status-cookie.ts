import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import type { ApplicationConfig } from '$lib/server/config/schema';

export const ORDER_STATUS_PROCESSING_GRACE_SECONDS = 15 * 60;
export const ORDER_STATUS_COOKIE_MAX_AGE_SECONDS = 60 * 60;

const orderIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^[a-f0-9]{64}$/u;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

export interface OrderStatusCredential {
  token: string;
  digestSha256: string;
}

export interface OrderStatusCookieInput {
  environment: ApplicationConfig['environment'];
  orderId: string;
  checkoutExpiresAt: Date;
  now?: Date;
}

export interface SetOrderStatusCookieInput extends OrderStatusCookieInput {
  token: string;
}

function requireOrderId(orderId: string): void {
  if (!orderIdPattern.test(orderId)) throw new TypeError('Invalid order ID');
}

function tokenBytes(token: string): Buffer | null {
  if (!tokenPattern.test(token)) return null;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== token) return null;
  return bytes;
}

function digestBytes(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

export function createOrderStatusCredential(
  randomSource: (size: number) => Uint8Array = nodeRandomBytes
): OrderStatusCredential {
  const random = randomSource(32);
  if (random.byteLength !== 32) throw new TypeError('Status token source must return 32 bytes');
  const bytes = Buffer.from(random);
  return {
    token: bytes.toString('base64url'),
    digestSha256: digestBytes(bytes).toString('hex')
  };
}

export function deriveOrderStatusCredential(
  applicationSecret: string,
  checkoutAttemptId: string
): OrderStatusCredential {
  requireOrderId(checkoutAttemptId);
  if (Buffer.byteLength(applicationSecret, 'utf8') < 32) {
    throw new TypeError('Application secret must contain at least 32 bytes');
  }
  // Stable per attempt: concurrent retry responses can arrive in either order
  // without one response overwriting the browser with an obsolete credential.
  const bytes = createHmac('sha256', applicationSecret)
    .update(`pale-orbit:commerce:order-status:v1:${checkoutAttemptId}`, 'utf8')
    .digest();
  return {
    token: bytes.toString('base64url'),
    digestSha256: digestBytes(bytes).toString('hex')
  };
}

export function matchesOrderStatusToken(token: string, expectedDigestSha256: string): boolean {
  const bytes = tokenBytes(token);
  if (!bytes || !digestPattern.test(expectedDigestSha256)) return false;
  const expected = Buffer.from(expectedDigestSha256, 'hex');
  const actual = digestBytes(bytes);
  return expected.byteLength === actual.byteLength && timingSafeEqual(actual, expected);
}

export function orderStatusCookieName(orderId: string): string {
  requireOrderId(orderId);
  return `pale_orbit_order_status_${orderId}`;
}

export function orderStatusCookieOptions(input: OrderStatusCookieInput) {
  requireOrderId(input.orderId);
  const now = input.now ?? new Date();
  const remainingSeconds = Math.ceil(
    (input.checkoutExpiresAt.getTime() - now.getTime()) / 1000
  );
  if (!Number.isFinite(remainingSeconds)) throw new TypeError('Invalid checkout expiry');
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: input.environment === 'production',
    path: `/api/commerce/orders/${input.orderId}`,
    maxAge: Math.max(
      1,
      Math.min(
        ORDER_STATUS_COOKIE_MAX_AGE_SECONDS,
        remainingSeconds + ORDER_STATUS_PROCESSING_GRACE_SECONDS
      )
    )
  };
}

export function setOrderStatusCookie(
  cookies: Pick<Cookies, 'set'>,
  input: SetOrderStatusCookieInput
): void {
  if (!tokenBytes(input.token)) throw new TypeError('Invalid order status token');
  cookies.set(
    orderStatusCookieName(input.orderId),
    input.token,
    orderStatusCookieOptions(input)
  );
}

export function isOrderStatusCredentialExpired(
  checkoutExpiresAt: Date | null,
  now = new Date()
): boolean {
  if (!checkoutExpiresAt || !Number.isFinite(checkoutExpiresAt.getTime())) return true;
  return now.getTime() >
    checkoutExpiresAt.getTime() + ORDER_STATUS_PROCESSING_GRACE_SECONDS * 1000;
}
