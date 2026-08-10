import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { CommerceQuoteDto } from '$lib/types/commerce';
import CartReview from './CartReview.svelte';

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const quote: CommerceQuoteDto = {
  fingerprint: 'a'.repeat(64),
  currency: 'USD',
  subtotalMinor: 1299,
  items: [{
    titleId: uuid(1), slug: 'glass-moon', title: 'The Glass Moon', creatorName: 'A. Writer',
    format: 'prose', coverUrl: null, unitSubtotalMinor: 1299, currency: 'USD'
  }],
  alreadyOwnedTitleIds: [uuid(2)],
  unavailableTitleIds: [uuid(3)],
  taxNotice: 'calculated_at_checkout',
  canCheckout: true
};

const props = {
  onremove: vi.fn(),
  oncheckout: vi.fn(),
  onretry: vi.fn()
};

describe('CartReview states', () => {
  it('renders empty and loading states', () => {
    const empty = render(CartReview, { props: { ...props, phase: 'empty' } });
    expect(empty.body).toContain('Your cart is empty');
    expect(empty.body).toContain('/catalog');
    const loading = render(CartReview, { props: { ...props, phase: 'loading' } });
    expect(loading.body).toMatch(/role="status"[^>]*>[^<]*Loading your cart/u);
  });

  it('renders authoritative items, integer-derived currency, and the tax notice', () => {
    const { body } = render(CartReview, { props: { ...props, phase: 'ready', quote } });
    expect(body).toContain('The Glass Moon');
    expect(body).toContain('$12.99');
    expect(body).toContain('Tax calculated at checkout');
    expect(body).toMatch(/<button[^>]*>Continue to checkout<\/button>/u);
  });

  it('renders owned and unavailable rejections generically with remove controls', () => {
    const { body } = render(CartReview, { props: { ...props, phase: 'ready', quote } });
    expect(body).toContain('already in your library');
    expect(body).toContain('currently unavailable');
    expect(body).toContain('Remove owned item 1');
    expect(body).toContain('Remove unavailable item 1');
    expect(body).not.toContain(uuid(2));
    expect(body).not.toContain(uuid(3));
  });

  it('requires explicit reconfirmation after a changed quote', () => {
    const { body } = render(CartReview, {
      props: { ...props, phase: 'ready', quote, requiresConfirmation: true }
    });
    expect(body).toMatch(/role="alert"/u);
    expect(body).toContain('Your cart changed');
    expect(body).toContain('Confirm updated cart');
  });

  it.each([
    ['mixed_currency', 'different currencies'],
    ['quote_unavailable', 'could not refresh your cart'],
    ['checkout_unavailable', 'Checkout is temporarily unavailable']
  ] as const)('renders the retryable %s state', (issue, text) => {
    const { body } = render(CartReview, { props: { ...props, phase: 'error', issue } });
    expect(body).toMatch(/role="alert"/u);
    expect(body).toContain(text);
    expect(body).toContain('Try again');
  });

  it('preserves a canceled cart and prevents a second pending submit', () => {
    const { body } = render(CartReview, {
      props: { ...props, phase: 'ready', quote, canceled: true, submitting: true }
    });
    expect(body).toContain('Checkout was canceled. Your cart is unchanged.');
    expect(body).toMatch(/<button[^>]*disabled[^>]*>Opening checkout/u);
  });
});
