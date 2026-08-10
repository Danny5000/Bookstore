import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('storefront commerce copy', () => {
  it('does not retain prototype checkout-unavailable claims', async () => {
    const sources = await Promise.all([
      readFile(new URL('./+page.svelte', import.meta.url), 'utf8'),
      readFile(new URL('./catalog/+page.svelte', import.meta.url), 'utf8'),
      readFile(new URL('./book/[id]/+page.svelte', import.meta.url), 'utf8')
    ]);

    expect(sources.join('\n')).not.toMatch(
      /checkout is not|checkout is not yet|not connected|purchasing opens after checkout/iu
    );
  });
});
