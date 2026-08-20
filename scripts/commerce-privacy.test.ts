import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { assertCommercePrivacy } from '../tests/e2e/commerce-privacy';

describe('commerce privacy evidence helper', () => {
  it('accepts safe commerce evidence', () => {
    expect(() => assertCommercePrivacy('account database', {
      paymentMethodCategory: 'card',
      rawBodySha256: '0'.repeat(64),
      amountMinor: 1299
    })).not.toThrow();
  });

  it.each([
    'secret',
    'signature',
    'stripeSignature',
    'rawBody',
    'rawEvent',
    'billingAddress',
    'shippingAddress',
    'cardNumber',
    'cardLast4',
    'cardBrand',
    'last4',
    'brand',
    'billing_details',
    'email',
    'customer',
    'card',
    'payment_method',
    'address',
    'receipt_url',
    'description',
    'destination',
    'metadata',
    'payment_method_details',
    'client_secret',
    'raw_object',
    'provider_message'
  ])('rejects the sensitive key %s', (key) => {
    expect(() => assertCommercePrivacy('guest browser', { [key]: 'private-value' }))
      .toThrow('Sensitive commerce data detected on guest browser');
  });

  it('rejects provider secrets, test card values, and journey-specific private values', () => {
    for (const value of [
      'sk_test_private',
      'sk_live_private',
      'rk_test_private',
      'rk_live_private',
      'whsec_private',
      '-----BEGIN PRIVATE KEY-----',
      '4242',
      'customer-private@example.com'
    ]) {
      expect(() => assertCommercePrivacy(
        'lifecycle console',
        { message: value },
        ['customer-private@example.com']
      )).toThrow('Sensitive commerce data detected on lifecycle console');
    }
  });

  it('never includes sensitive keys or values in its failure message', () => {
    const privateValue = 'whsec_do-not-print';
    let failure = '';
    try {
      assertCommercePrivacy('account response', {
        client_secret: privateValue
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toBe('Sensitive commerce data detected on account response');
    expect(failure).not.toContain('client_secret');
    expect(failure).not.toContain(privateValue);
  });

  it('keeps customer identity and token fields out of financial purchase-lock queries', async () => {
    const [rebase, payment, refund] = await Promise.all([
      readFile(new URL('../src/lib/server/commerce/financial/rebase.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/lib/server/commerce/financial/sources/payment.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/lib/server/commerce/financial/sources/refund.ts', import.meta.url), 'utf8')
    ]);
    const forbidden = /guest_identity_id|purchase_email|status_token_sha256/u;

    expect(rebase.match(/select id, status,[\s\S]*?from orders where id =/u)?.[0]).not.toMatch(forbidden);
    expect(payment).not.toMatch(/\.select\(\)\.from\(orders\)/u);
    expect(refund).not.toMatch(/\.select\(\)\.from\(orders\)/u);
  });
});
