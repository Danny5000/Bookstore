import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { cart } from '$lib/commerce/cart.svelte';
import CartToggle from './CartToggle.svelte';

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

describe('CartToggle', () => {
  beforeEach(() => cart.reset());

  it('uses a native keyboard-operable button with an accessible add/remove name', () => {
    const added = render(CartToggle, {
      props: { titleId: uuid(1), titleLabel: 'The Glass Moon' }
    });
    expect(added.body).toMatch(/<button[^>]*type="button"[^>]*aria-label="Add The Glass Moon to cart"/u);
    expect(added.body).toContain('Add to cart');

    cart.add(uuid(1));
    const removable = render(CartToggle, {
      props: { titleId: uuid(1), titleLabel: 'The Glass Moon' }
    });
    expect(removable.body).toMatch(/aria-label="Remove The Glass Moon from cart"/u);
    expect(removable.body).toContain('Remove');
  });

  it.each([
    { owned: true, unavailable: false, label: 'Owned', accessible: 'The Glass Moon is already owned' },
    { owned: false, unavailable: true, label: 'Unavailable', accessible: 'The Glass Moon is unavailable' }
  ])('renders the $label state as disabled', ({ owned, unavailable, label, accessible }) => {
    const { body } = render(CartToggle, {
      props: { titleId: uuid(1), titleLabel: 'The Glass Moon', owned, unavailable }
    });
    expect(body).toMatch(new RegExp(`<button[^>]*disabled[^>]*aria-label="${accessible}"`, 'u'));
    expect(body).toContain(label);
  });

  it('disables new additions at 25 titles while preserving removal', () => {
    for (let index = 1; index <= 25; index += 1) cart.add(uuid(index));

    const capped = render(CartToggle, {
      props: { titleId: uuid(26), titleLabel: 'Beyond the Limit' }
    });
    expect(capped.body).toMatch(/disabled[^>]*aria-label="Cart limit reached; remove an item before adding Beyond the Limit"/u);

    const removable = render(CartToggle, {
      props: { titleId: uuid(1), titleLabel: 'First Title' }
    });
    expect(removable.body).not.toMatch(/<button[^>]*disabled/u);
    expect(removable.body).toContain('Remove');
  });
});
