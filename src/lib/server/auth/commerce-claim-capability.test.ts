import { describe, expect, it } from 'vitest';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import {
  createCommerceClaimProofToken,
  parseCommerceClaimBridgePayload,
  safeCommerceClaimCorrelationId,
  wrapCommerceClaimActionUrl
} from './commerce-claim-capability';

const trustedOrigin = 'https://books.example.com';
const anchorOrderId = '11111111-1111-4111-8111-111111111111';

function resetAction(callbackUrl: string): string {
  const action = new URL('/api/auth/reset-password/native-token', trustedOrigin);
  action.searchParams.set('callbackURL', callbackUrl);
  return action.toString();
}

describe('commerce claim action bridge', () => {
  it('accepts an exact same-origin commerce reset callback', () => {
    const callback = new URL('/reset-password', trustedOrigin);
    callback.searchParams.set('purpose', 'commerce-claim');
    callback.searchParams.set('orderId', anchorOrderId);

    const claimProofToken = createCommerceClaimProofToken();
    const wrapped = new URL(wrapCommerceClaimActionUrl({
      actionUrl: resetAction(callback.toString()),
      claimProofToken,
      anchorOrderId,
      kind: 'password-reset',
      trustedOrigin
    }));

    expect(wrapped.origin).toBe(trustedOrigin);
    expect(wrapped.pathname).toBe('/claim/authorize');
    expect(wrapped.search).toBe('');
    expect(`${wrapped.pathname}${wrapped.search}`).not.toContain('native-token');

    const parsed = parseCommerceClaimBridgePayload(wrapped.hash.slice(1), trustedOrigin);
    expect(parsed).toEqual({
      claimProofToken,
      anchorOrderId,
      kind: 'password-reset',
      actionUrl: resetAction(callback.toString())
    });
  });

  it('keeps both live bearers out of the proxy-visible request target', () => {
    const callback = new URL('/reset-password', trustedOrigin);
    callback.searchParams.set('purpose', 'commerce-claim');
    callback.searchParams.set('orderId', anchorOrderId);
    const claimProofToken = 'P'.repeat(43);

    const wrapped = new URL(wrapCommerceClaimActionUrl({
      actionUrl: resetAction(callback.toString()),
      claimProofToken,
      anchorOrderId,
      kind: 'password-reset',
      trustedOrigin
    }));

    expect(`${wrapped.pathname}${wrapped.search}`).toBe('/claim/authorize');
    expect(`${wrapped.pathname}${wrapped.search}`).not.toContain(claimProofToken);
    expect(`${wrapped.pathname}${wrapped.search}`).not.toContain('native-token');
    expect(decodeURIComponent(wrapped.hash)).toContain(claimProofToken);
    expect(decodeURIComponent(wrapped.hash)).toContain('native-token');
  });

  it('rejects same-origin reset callbacks containing URL userinfo', () => {
    const callback = new URL('/reset-password', trustedOrigin);
    callback.username = 'attacker';
    callback.password = 'secret';
    callback.searchParams.set('purpose', 'commerce-claim');
    callback.searchParams.set('orderId', anchorOrderId);

    expect(() => wrapCommerceClaimActionUrl({
      actionUrl: resetAction(callback.toString()),
      claimProofToken: createCommerceClaimProofToken(),
      anchorOrderId,
      kind: 'password-reset',
      trustedOrigin
    })).toThrow(PermanentCommerceError);
  });
});

describe('commerce claim audit correlation', () => {
  it('preserves a bounded safe request id and replaces unsafe or PII-shaped values', () => {
    expect(safeCommerceClaimCorrelationId('claim-request_1:v2')).toBe('claim-request_1:v2');
    expect(safeCommerceClaimCorrelationId('reader@example.com'))
      .toMatch(/^[0-9a-f-]{36}$/u);
  });
});
