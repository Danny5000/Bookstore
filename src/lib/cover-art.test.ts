import { describe, expect, it } from 'vitest';
import { coverBackground, coverPalette } from './cover-art';

describe('cover art fallbacks', () => {
  it('is deterministic for string seeds and prefers authorized media URLs', () => {
    expect(coverPalette('same-title')).toEqual(coverPalette('same-title'));
    expect(coverBackground('same-title', null)).toContain('linear-gradient');
    expect(coverBackground('same-title', '/media/cover.webp')).toBe(
      'center / cover url(/media/cover.webp)'
    );
  });
});
