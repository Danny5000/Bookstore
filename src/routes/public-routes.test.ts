import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

const database = {};
vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: database })
}));
vi.mock('$lib/server/catalog/reader', () => ({
  listPublicCatalog: vi.fn(),
  getPublicTitleDetail: vi.fn(),
  getPublicPreview: vi.fn()
}));

import { load as loadHome } from './+page.server';
import { load as loadCatalog } from './catalog/+page.server';
import { load as loadBook } from './book/[id]/+page.server';
import { load as loadReader } from './read/[id]/+page.server';
import { load as loadStudio } from './studio/+page.server';
import {
  getPublicPreview,
  getPublicTitleDetail,
  listPublicCatalog
} from '$lib/server/catalog/reader';

describe('public publication loaders', () => {
  it('loads the home surface from the public catalog query without a prototype fallback', async () => {
    const titles = [{ id: 'title-id', slug: 'the-book', title: 'The Book' }];
    vi.mocked(listPublicCatalog).mockResolvedValueOnce(titles as never);
    await expect(loadHome({} as never)).resolves.toEqual({ titles });
    expect(listPublicCatalog).toHaveBeenCalledWith(database);
    const source = await readFile(new URL('./+page.svelte', import.meta.url), 'utf8');
    expect(source).not.toMatch(/stores\/titles|data\/catalog|prototype/iu);
    expect(source).toContain('checkout is not yet available');
  });

  it('loads the public catalog from the database query', async () => {
    vi.mocked(listPublicCatalog).mockResolvedValueOnce([]);

    await expect(loadCatalog({} as never)).resolves.toEqual({ titles: [] });
    expect(listPublicCatalog).toHaveBeenCalledWith(database);
  });

  it('loads a public title by slug and returns a public 404 when unavailable', async () => {
    const title = { id: 'title-id', slug: 'the-book', title: 'The Book' };
    vi.mocked(getPublicTitleDetail).mockResolvedValueOnce(title as never);

    await expect(loadBook({ params: { id: 'the-book' } } as never)).resolves.toEqual({ title });
    expect(getPublicTitleDetail).toHaveBeenCalledWith(database, 'the-book');

    vi.mocked(getPublicTitleDetail).mockResolvedValueOnce(null);
    await expect(loadBook({ params: { id: 'private-book' } } as never)).rejects.toMatchObject({
      status: 404
    });
  });

  it('always loads the reviewed public preview and ignores draft selectors', async () => {
    const document = { titleId: 'title-id', access: 'preview' };
    vi.mocked(getPublicPreview).mockResolvedValueOnce(document as never);

    await expect(
      loadReader({
        params: { id: 'the-book' },
        url: new URL('http://localhost/read/the-book?revision=forged&presentation=draft')
      } as never)
    ).resolves.toMatchObject({
      document,
      slug: 'the-book',
      persistenceKind: 'preview-local',
      initialState: {
        progress: null,
        bookmarks: [],
        preferences: { fontSize: 18, typeface: 'serif', paper: 'white', version: 0 }
      }
    });
    expect(getPublicPreview).toHaveBeenCalledWith(database, 'the-book');
  });

  it('returns a public 404 when no reviewed preview is available', async () => {
    vi.mocked(getPublicPreview).mockResolvedValueOnce(null);
    await expect(loadReader({ params: { id: 'missing' } } as never)).rejects.toMatchObject({
      status: 404
    });
  });

  it('redirects the retired studio to the protected catalog workspace', () => {
    expect(() => loadStudio({} as never)).toThrowError(
      expect.objectContaining({ status: 303, location: '/admin/catalog' })
    );
  });

  it('keeps server loaders independent of prototype catalog and ownership state', async () => {
    const loaders = await Promise.all([
      readFile(new URL('./catalog/+page.server.ts', import.meta.url), 'utf8'),
      readFile(new URL('./book/[id]/+page.server.ts', import.meta.url), 'utf8'),
      readFile(new URL('./read/[id]/+page.server.ts', import.meta.url), 'utf8')
    ]);

    for (const source of loaders) {
      expect(source).not.toMatch(/\$lib\/data\/catalog|\$lib\/stores\/titles|\$lib\/stores\/library/);
    }
  });
});
