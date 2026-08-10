import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { OrderStatusDto } from '$lib/types/commerce';
import CheckoutStatus from './CheckoutStatus.svelte';

describe('CheckoutStatus', () => {
  it('renders delayed payment guidance as non-actionable pending status', () => {
    const { body } = render(CheckoutStatus, { props: { status: { status: 'pending' } } });
    expect(body).toMatch(/role="status"/u);
    expect(body).toContain('Confirming your purchase');
    expect(body).toContain('Some payment methods take longer');
    expect(body).not.toMatch(/role="alert"/u);
  });

  it.each([
    [{ status: 'paid', libraryUrl: '/library' }, 'Open your library'],
    [{ status: 'paid_guest', claimMessage: 'ignored private-safe server copy' }, 'Check your email for a secure claim link']
  ] as const)('renders terminal success without automatic navigation', (status, action) => {
    const { body } = render(CheckoutStatus, { props: { status: status as OrderStatusDto } });
    expect(body).toMatch(/role="status"/u);
    expect(body).toContain('Purchase complete');
    expect(body).toContain(action);
    expect(body).not.toContain('ignored private-safe server copy');
    expect(body).not.toMatch(/http-equiv|window\.location/iu);
  });

  it.each(['failed', 'expired', 'exception'] as const)(
    'renders %s as an actionable safe failure',
    (status) => {
      const { body } = render(CheckoutStatus, {
        props: { status: { status, message: 'private provider detail' } }
      });
      expect(body).toMatch(/role="alert"/u);
      expect(body).toContain('Return to your cart');
      expect(body).not.toContain('private provider detail');
    }
  );

  it('renders timeout and polling failure with an explicit refresh action', () => {
    for (const props of [{ timedOut: true }, { pollFailed: true }]) {
      const { body } = render(CheckoutStatus, { props });
      expect(body).toMatch(/role="alert"/u);
      expect(body).toContain('Refresh status');
    }
  });
});
