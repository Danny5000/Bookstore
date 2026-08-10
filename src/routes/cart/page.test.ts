import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { load } from './+page.server';
import CartPage from './+page.svelte';

describe('/cart', () => {
  it.each([
    ['https://books.example/cart', false],
    ['https://books.example/cart?canceled=1', true],
    ['https://books.example/cart?canceled=0', false]
  ])('derives the canceled banner only from the exact flag', async (url, canceled) => {
    await expect(load({ url: new URL(url) } as never)).resolves.toEqual({ canceled });
  });

  it('server-renders a stable loading status before browser storage is read', () => {
    const { body } = render(CartPage, {
      props: { data: { user: null, canceled: false } }
    });
    expect(body).toContain('Loading your cart');
  });
});
