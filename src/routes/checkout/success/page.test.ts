import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { load } from './+page.server';
import SuccessPage from './+page.svelte';

const orderId = '00000000-0000-4000-8000-000000000200';

describe('/checkout/success', () => {
  it('accepts only one UUID query value and exposes no order status', async () => {
    const setHeaders = vi.fn();
    await expect(load({
      url: new URL(`https://books.example/checkout/success?order=${orderId}`),
      setHeaders
    } as never)).resolves.toEqual({ orderId });
    expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });

    for (const url of [
      'https://books.example/checkout/success',
      'https://books.example/checkout/success?order=bad',
      `https://books.example/checkout/success?order=${orderId}&order=${orderId}`
    ]) {
      await expect(load({ url: new URL(url), setHeaders: vi.fn() } as never))
        .rejects.toMatchObject({ status: 404 });
    }
  });

  it('server-renders only a pending status and the order UUID in no visible copy', () => {
    const { body } = render(SuccessPage, { props: { data: { user: null, orderId } } });
    expect(body).toContain('Confirming your purchase');
    expect(body).not.toContain(orderId);
  });
});
