import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { cart } from '$lib/commerce/cart.svelte';
import BookPage from './+page.svelte';

const titleId = '00000000-0000-4000-8000-000000000001';

describe('public title purchase controls', () => {
  beforeEach(() => cart.reset());

  it('offers a working cart control and no disconnected-checkout prototype copy', () => {
    const { body } = render(BookPage, {
      props: {
        data: {
          title: {
            id: titleId,
            slug: 'glass-moon',
            title: 'The Glass Moon',
            subtitle: null,
            creatorName: 'A. Writer',
            description: 'A story.',
            format: 'prose',
            extentCount: 120,
            extentUnit: 'pages',
            priceMinor: 1234,
            currency: 'JPY',
            cover: null
          }
        } as never
      }
    });

    expect(body).toMatch(/aria-label="Add The Glass Moon to cart"/u);
    expect(body).toContain('Add to cart');
    expect(body).toContain('¥1,234');
    expect(body).not.toContain('¥12.34');
    expect(body).toContain('Tax calculated at checkout');
    expect(body).not.toMatch(/checkout is not|not connected|purchasing opens/iu);
  });
});
