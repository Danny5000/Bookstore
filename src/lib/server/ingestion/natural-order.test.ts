import { describe, expect, it } from 'vitest';
import { naturalComicOrder } from './natural-order';

describe('naturalComicOrder', () => {
  it('sorts numeric runs naturally', () => {
    expect(naturalComicOrder(['10.png', '2.png', '1.png'])).toEqual([
      '1.png',
      '2.png',
      '10.png'
    ]);
  });

  it('sorts normalized nested path segments deterministically', () => {
    expect(
      naturalComicOrder(['chapter-2/10.png', 'chapter-10/1.png', 'chapter-2/2.png'])
    ).toEqual(['chapter-2/2.png', 'chapter-2/10.png', 'chapter-10/1.png']);
  });

  it.each([
    ['Page-01.png', 'page-1.PNG'],
    ['1.png', '01.png'],
    ['caf\u00e9-1.png', 'cafe\u0301-1.PNG'],
    ['same.png', 'same.png']
  ])('rejects an ambiguous natural-order tie between %s and %s', (first, second) => {
    expect(() => naturalComicOrder([first, second])).toThrowError(
      expect.objectContaining({ code: 'comic_ambiguous_page_order' })
    );
  });
});
