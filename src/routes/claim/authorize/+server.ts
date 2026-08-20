import { randomBytes, timingSafeEqual } from 'node:crypto';
import { error, redirect } from '@sveltejs/kit';
import {
  COMMERCE_CLAIM_PROOF_COOKIE,
  COMMERCE_CLAIM_PROOF_TTL_SECONDS,
  parseCommerceClaimBridgePayload
} from '$lib/server/auth/commerce-claim-capability';
import { getApplicationConfig } from '$lib/server/config';
import type { RequestHandler } from './$types';
import { COMMERCE_CLAIM_BRIDGE_NONCE_COOKIE } from './support';

const BRIDGE_NONCE_TTL_SECONDS = 2 * 60;
const bridgeNoncePattern = /^[A-Za-z0-9_-]{43}$/u;

function bridgeHeaders(nonce?: string): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    ...(nonce
      ? {
          'content-security-policy': [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'"
          ].join('; ')
        }
      : {})
  };
}

function sameNonce(left: string | undefined, right: string | undefined): boolean {
  if (
    !left || !right ||
    !bridgeNoncePattern.test(left) || !bridgeNoncePattern.test(right)
  ) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bridgePage(nonce: string): string {
  const encodedNonce = JSON.stringify(nonce);
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body>
    <p>Opening your secure purchase link…</p>
    <script nonce="${nonce}">
      (() => {
        const payload = window.location.hash.startsWith('#')
          ? window.location.hash.slice(1)
          : '';
        history.replaceState(null, '', '/claim/authorize');
        if (!payload || payload.length > 8192) {
          document.body.textContent = 'This purchase link is invalid or expired.';
          return;
        }
        const form = document.createElement('form');
        form.method = 'post';
        form.action = '/claim/authorize';
        form.hidden = true;
        for (const [name, value] of [
          ['nonce', ${encodedNonce}],
          ['payload', payload]
        ]) {
          const field = document.createElement('input');
          field.type = 'hidden';
          field.name = name;
          field.value = value;
          form.append(field);
        }
        document.body.append(form);
        form.submit();
      })();
    </script>
    <noscript>This purchase link requires JavaScript.</noscript>
  </body>
</html>`;
}

export const GET: RequestHandler = ({ url, cookies, setHeaders }) => {
  const config = getApplicationConfig();
  if (url.origin !== new URL(config.origin).origin || url.pathname !== '/claim/authorize' ||
    url.search || url.hash) {
    error(400, 'Invalid commerce claim link');
  }

  const nonce = randomBytes(32).toString('base64url');
  setHeaders(bridgeHeaders(nonce));
  cookies.set(COMMERCE_CLAIM_BRIDGE_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: config.environment === 'production',
    sameSite: 'strict',
    path: '/claim/authorize',
    maxAge: BRIDGE_NONCE_TTL_SECONDS
  });
  return new Response(bridgePage(nonce), {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
};

export const POST: RequestHandler = async ({ request, url, cookies, setHeaders }) => {
  const config = getApplicationConfig();
  const trustedOrigin = new URL(config.origin).origin;
  setHeaders(bridgeHeaders());
  if (
    url.origin !== trustedOrigin || url.pathname !== '/claim/authorize' ||
    url.search || url.hash || request.headers.get('origin') !== trustedOrigin ||
    !request.headers.get('content-type')?.toLowerCase()
      .startsWith('application/x-www-form-urlencoded')
  ) error(400, 'Invalid commerce claim link');

  const form = await request.formData();
  const keys = [...form.keys()].sort();
  if (
    keys.length !== 2 || keys[0] !== 'nonce' || keys[1] !== 'payload' ||
    form.getAll('nonce').length !== 1 || form.getAll('payload').length !== 1
  ) error(400, 'Invalid commerce claim link');
  const nonce = form.get('nonce');
  const payload = form.get('payload');
  const cookieNonce = cookies.get(COMMERCE_CLAIM_BRIDGE_NONCE_COOKIE);
  if (
    typeof nonce !== 'string' || typeof payload !== 'string' ||
    !sameNonce(cookieNonce, nonce)
  ) error(400, 'Invalid commerce claim link');

  cookies.delete(COMMERCE_CLAIM_BRIDGE_NONCE_COOKIE, { path: '/claim/authorize' });
  let bridge;
  try {
    bridge = parseCommerceClaimBridgePayload(payload, trustedOrigin);
  } catch {
    error(400, 'Invalid commerce claim link');
  }

  cookies.set(COMMERCE_CLAIM_PROOF_COOKIE, bridge.claimProofToken, {
    httpOnly: true,
    secure: config.environment === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COMMERCE_CLAIM_PROOF_TTL_SECONDS
  });
  throw redirect(303, bridge.actionUrl);
};
