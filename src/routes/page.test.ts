import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { cart } from '$lib/commerce/cart.svelte';
import HomePage from './+page.svelte';

const titleId = '00000000-0000-4000-8000-000000000001';

describe('home purchase surfaces', () => {
  beforeEach(() => cart.reset());

  it('renders three-decimal prices and tax disclosure in the hero and title card', () => {
    const { body } = render(HomePage, {
      props: {
        data: {
          titles: [{
            id: titleId,
            slug: 'desert-archive',
            title: 'Desert Archive',
            subtitle: null,
            creatorName: 'A. Writer',
            format: 'prose',
            priceMinor: 1234,
            currency: 'BHD',
            cover: null
          }]
        } as never
      }
    });

    expect(body).toContain('BHD\u00a01.234');
    expect(body).not.toContain('BHD\u00a012.34');
    expect(body.match(/Tax calculated at checkout/gu)).toHaveLength(2);
  });
});
