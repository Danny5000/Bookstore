import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createCommerceClaimProofToken,
  wrapCommerceClaimActionUrl
} from '$lib/server/auth/commerce-claim-capability';

vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({
    environment: 'production',
    origin: 'https://books.example.com'
  })
}));

import {
  GET,
  POST
} from './+server';
import { COMMERCE_CLAIM_BRIDGE_NONCE_COOKIE } from './support';

const trustedOrigin = 'https://books.example.com';
const anchorOrderId = '11111111-1111-4111-8111-111111111111';

function wrappedClaim(): URL {
  const callback = new URL('/reset-password', trustedOrigin);
  callback.searchParams.set('purpose', 'commerce-claim');
  callback.searchParams.set('orderId', anchorOrderId);
  const action = new URL('/api/auth/reset-password/native-token', trustedOrigin);
  action.searchParams.set('callbackURL', callback.toString());
  return new URL(wrapCommerceClaimActionUrl({
    actionUrl: action.toString(),
    claimProofToken: createCommerceClaimProofToken(),
    anchorOrderId,
    kind: 'password-reset',
    trustedOrigin
  }));
}

describe('/claim/authorize bridge transport', () => {
  it('keeps support symbols out of the SvelteKit endpoint export contract', () => {
    const source = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');
    const invalidExports = [...source.matchAll(/^export const ([A-Za-z_$][\w$]*)/gmu)]
      .flatMap((match) => match[1] ? [match[1]] : [])
      .filter((name) => name !== 'GET' && name !== 'POST' && !name.startsWith('_'));
    expect(invalidExports).toEqual([]);
  });

  it('serves a no-store nonce-bound fragment-to-POST handoff without a bearer URI', async () => {
    const set = vi.fn();
    const setHeaders = vi.fn();
    const response = await GET({
      url: new URL(`${trustedOrigin}/claim/authorize`),
      cookies: { set },
      setHeaders
    } as never) as Response;
    const body = await response.text();

    expect(response.headers.get('content-type')).toContain('text/html');
    expect(setHeaders).toHaveBeenCalledWith(expect.objectContaining({
      'cache-control': 'no-store',
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff'
    }));
    expect(setHeaders.mock.calls[0]?.[0]['content-security-policy'])
      .toMatch(/default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/u);
    expect(set).toHaveBeenCalledWith(
      COMMERCE_CLAIM_BRIDGE_NONCE_COOKIE,
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/claim/authorize'
      })
    );
    expect(body).toContain('window.location.hash');
    expect(body).toContain('history.replaceState');
    expect(body).toContain("form.method = 'post'");
    expect(body).not.toContain('native-token');
    expect(body).not.toContain('proof=');
  });

  it('accepts the exact nonce-bound same-origin POST and redirects after setting the proof cookie', async () => {
    const wrapped = wrappedClaim();
    expect(`${wrapped.pathname}${wrapped.search}`).toBe('/claim/authorize');
    const nonce = 'N'.repeat(43);
    const set = vi.fn();
    const deleteCookie = vi.fn();
    const request = new Request(`${trustedOrigin}/claim/authorize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: trustedOrigin
      },
      body: new URLSearchParams({ nonce, payload: wrapped.hash.slice(1) })
    });

    await expect(POST({
      request,
      url: new URL(request.url),
      cookies: {
        get: (name: string) => name === COMMERCE_CLAIM_BRIDGE_NONCE_COOKIE
          ? nonce
          : undefined,
        set,
        delete: deleteCookie
      },
      setHeaders: vi.fn()
    } as never)).rejects.toMatchObject({ status: 303 });

    expect(deleteCookie).toHaveBeenCalledWith(
      COMMERCE_CLAIM_BRIDGE_NONCE_COOKIE,
      { path: '/claim/authorize' }
    );
    expect(set).toHaveBeenCalledWith(
      'pale-orbit-commerce-claim',
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    );
  });

  it('rejects proxy-visible query bearers and cross-origin or nonce-free posts', async () => {
    expect(() => GET({
      url: new URL(`${trustedOrigin}/claim/authorize?proof=leaked`),
      cookies: { set: vi.fn() },
      setHeaders: vi.fn()
    } as never)).toThrow(expect.objectContaining({ status: 400 }));

    const wrapped = wrappedClaim();
    const request = new Request(`${trustedOrigin}/claim/authorize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://attacker.example'
      },
      body: new URLSearchParams({ nonce: 'N'.repeat(43), payload: wrapped.hash.slice(1) })
    });
    await expect(POST({
      request,
      url: new URL(request.url),
      cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
      setHeaders: vi.fn()
    } as never)).rejects.toMatchObject({ status: 400 });
  });
});
