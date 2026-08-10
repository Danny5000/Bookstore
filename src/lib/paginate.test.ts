import { describe, expect, it } from 'vitest';
import { pageBox } from './paginate';

describe('pageBox', () => {
  it('fits a two-page spread within the viewport', () => {
    const box = pageBox({ vw: 1440, vh: 900, narrow: false, fontSize: 18 });
    expect(box).toEqual({ pw: 453, ph: 620, pad: 48, fs: 18 });
  });
});
