import { describe, expect, it } from 'vitest';
import type { TitleKind } from '$lib/types/catalog';
import { bookDepth } from './geometry';

describe('bookDepth', () => {
  it.each<[TitleKind, number, number]>([
    ['comic', 0, 5],
    ['comic', 12, 6],
    ['comic', 100, 11],
    ['novel', 0, 16],
    ['novel', 20, 28],
    ['novel', 100, 58]
  ])('returns the expected %s depth for %i pages', (kind, pageCount, expected) => {
    expect(bookDepth(kind, pageCount)).toBe(expected);
  });

  it('treats a negative page count as an empty book', () => {
    expect(bookDepth('novel', -4)).toBe(16);
    expect(bookDepth('comic', -4)).toBe(5);
  });
});
