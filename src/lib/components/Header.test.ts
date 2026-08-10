import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cart } from '$lib/commerce/cart.svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/stores', () => ({
  page: {
    subscribe(run: (value: { url: URL }) => void) {
      run({ url: new URL('https://store.example/catalog') });
      return () => undefined;
    }
  }
}));
vi.mock('$lib/auth/client', () => ({
  authClient: {
    useSession: () => ({
      subscribe(run: (value: { data: null }) => void) {
        run({ data: null });
        return () => undefined;
      }
    }),
    signOut: vi.fn()
  }
}));

import Header from './Header.svelte';

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

describe('Header cart status', () => {
  beforeEach(() => cart.reset());

  it('links to the cart with its count in the accessible name', () => {
    cart.add(uuid(1));
    cart.add(uuid(2));
    const { body } = render(Header, { props: { user: null, onsignin: vi.fn() } });

    expect(body).toMatch(/<a[^>]*href="\/cart"[^>]*aria-label="Cart, 2 items"/u);
    expect(body).toContain('Cart');
  });

  it('announces count changes politely without creating a focus target', () => {
    const { body } = render(Header, { props: { user: null, onsignin: vi.fn() } });

    expect(body).toMatch(/aria-live="polite"[^>]*aria-atomic="true"/u);
    expect(body).toContain('Cart contains 0 items');
    expect(body).not.toContain('autofocus');
    expect(body).not.toMatch(/aria-live="polite"[^>]*tabindex/u);
  });
});
