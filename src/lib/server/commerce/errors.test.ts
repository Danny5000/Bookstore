import { describe, expect, it } from 'vitest';
import {
  CartChangedError,
  CheckoutUnavailableError,
  CommerceConflictError,
  InvalidCartError,
  OrderNotFoundError,
  PermanentCommerceError,
  RetryableProviderError
} from './errors';

describe('commerce errors', () => {
  it('uses stable customer-safe messages and codes', () => {
    expect(new InvalidCartError()).toMatchObject({
      code: 'INVALID_CART',
      message: 'The cart is invalid.'
    });
    expect(new CartChangedError()).toMatchObject({
      code: 'CART_CHANGED',
      message: 'The cart changed. Review it before checking out.'
    });
    expect(new CheckoutUnavailableError()).toMatchObject({
      code: 'CHECKOUT_UNAVAILABLE',
      message: 'Checkout is temporarily unavailable.'
    });
    expect(new OrderNotFoundError()).toMatchObject({
      code: 'ORDER_NOT_FOUND',
      message: 'The order could not be found.'
    });
  });

  it('does not copy provider messages or customer email into public error text', () => {
    const cause = new Error('Stripe pi_secret for reader@example.com');
    const errors = [
      new PermanentCommerceError({ cause }),
      new RetryableProviderError({ cause }),
      new CommerceConflictError('GRANT_PERMANENTLY_REVOKED', { cause })
    ];

    for (const error of errors) {
      expect(error.message).not.toContain('Stripe');
      expect(error.message).not.toContain('pi_secret');
      expect(error.message).not.toContain('reader@example.com');
      expect(error.cause).toBe(cause);
    }
  });
});
