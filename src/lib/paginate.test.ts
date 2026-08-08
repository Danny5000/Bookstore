import { describe, expect, it } from 'vitest';
import { byId } from '$lib/data/catalog';
import { freeSheets, pageBox, pageForAnchor, paginate } from './paginate';

describe('pageBox', () => {
  it('fits a two-page spread within the viewport', () => {
    const box = pageBox({ vw: 1440, vh: 900, narrow: false, fontSize: 18 });
    expect(box).toEqual({ pw: 453, ph: 620, pad: 48, fs: 18 });
  });
});

describe('paginate', () => {
  it('memoizes the same title and geometry', () => {
    const title = byId('salt');
    expect(title).toBeDefined();
    const box = pageBox({ vw: 1440, vh: 900, narrow: false, fontSize: 18 });
    expect(paginate(title, box)).toBe(paginate(title, box));
  });

  it('creates deterministic comic pages', () => {
    const title = byId('vector');
    const box = pageBox({ vw: 800, vh: 900, narrow: true, fontSize: 18 });
    const pages = paginate(title, box);
    expect(pages).toHaveLength(8);
    expect(pages[0]).toMatchObject({ type: 'comic', chapter: 0, at: 0, folio: '1' });
  });

  it('restores the last page starting before a text anchor', () => {
    const title = byId('salt');
    const box = pageBox({ vw: 760, vh: 820, narrow: true, fontSize: 20 });
    const pages = paginate(title, box);
    const index = pageForAnchor(pages, { chapter: 1, at: 0 });
    expect(pages[index]?.chapter).toBe(1);
  });

  it('keeps the prose sample within the first chapter', () => {
    const title = byId('salt');
    const box = pageBox({ vw: 760, vh: 820, narrow: true, fontSize: 18 });
    const pages = paginate(title, box);
    const lastSampleSheet = freeSheets(title, pages, 1);
    expect(lastSampleSheet).toBeGreaterThan(0);
    expect(lastSampleSheet).toBeLessThan(pages.length);
  });
});
