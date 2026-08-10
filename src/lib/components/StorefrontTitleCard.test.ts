import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { cart } from '$lib/commerce/cart.svelte';
import StorefrontTitleCard from './StorefrontTitleCard.svelte';

const titleId = '00000000-0000-4000-8000-000000000001';

describe('StorefrontTitleCard', () => {
  beforeEach(() => cart.reset());

  it('keeps title navigation separate from the native cart button', () => {
    const { body } = render(StorefrontTitleCard, {
      props: {
        titleId,
        slug: 'glass-moon',
        title: 'The Glass Moon',
        creatorName: 'A. Writer',
        subtitle: 'A lunar story',
        format: 'prose',
        coverUrl: null,
        priceMinor: 1299,
        currency: 'USD'
      }
    });

    expect(body).toMatch(/<article[^>]*class="card(?:\s|")/u);
    expect(body).toMatch(/<a[^>]*href="\/book\/glass-moon"[\s\S]*?<\/a>[\s\S]*?<button/u);
    expect(body).toMatch(/aria-label="Add The Glass Moon to cart"/u);
    expect(body).not.toMatch(/<a[^>]*>[\s\S]*<button[^>]*>[\s\S]*<\/a>/u);
  });

  it('renders zero-decimal catalog prices from minor units', () => {
    const { body } = render(StorefrontTitleCard, {
      props: {
        titleId,
        slug: 'tokyo-stories',
        title: 'Tokyo Stories',
        creatorName: 'A. Writer',
        format: 'prose',
        coverUrl: null,
        priceMinor: 1234,
        currency: 'JPY'
      }
    });

    expect(body).toContain('¥1,234');
    expect(body).not.toContain('¥12.34');
  });
});
