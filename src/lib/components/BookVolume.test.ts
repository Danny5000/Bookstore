import { readFile } from 'node:fs/promises';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import BookVolume from './BookVolume.svelte';

describe('BookVolume publication inputs', () => {
  it('renders from narrow publication primitives without ownership behavior', () => {
    const { body } = render(BookVolume, {
      props: {
        title: 'Server Book',
        format: 'prose',
        creatorName: 'A. Writer',
        description: 'A server-backed publication.',
        priceLabel: '$12.99',
        coverSeed: 'server-book',
        coverUrl: '/media/covers/id/checksum',
        pageCount: 120
      }
    });
    expect(body).toContain('Server Book');
    expect(body).toContain('A. Writer');
    expect(body).toContain('$12.99');
    expect(body).toContain('/media/covers/id/checksum');
    expect(body).not.toContain('grant');
  });

  it('does not depend on the prototype title or catalog modules', async () => {
    const source = await readFile(new URL('./BookVolume.svelte', import.meta.url), 'utf8');
    expect(source).not.toMatch(/types\/catalog|data\/catalog|\bTitle\b/u);
  });
});
