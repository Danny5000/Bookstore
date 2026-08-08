import { describe, expect, it } from 'vitest';
import type { Title } from '$lib/types/catalog';
import { byId, coverBackground, money } from './catalog';
import { chapters } from './prose';

describe('catalog helpers', () => {
  it('formats prototype prices without changing display behavior', () => {
    expect(money(9.99)).toBe('$9.99');
  });

  it('returns seed titles by stable id', () => {
    const title: Title | undefined = byId('salt');
    expect(title?.title).toBe('The Salt Harvest');
    expect(byId('missing')).toBeUndefined();
  });

  it('prefers an uploaded cover URL over the palette', () => {
    expect(coverBackground(0, '/cover.webp')).toBe('center / cover url(/cover.webp)');
    expect(coverBackground(0, null)).toContain('linear-gradient');
  });

  it('builds the same chapter paragraph counts as the prototype', () => {
    expect(chapters(0, ['One'])[0]).toMatchObject({
      title: 'One',
      paras: expect.any(Array)
    });
    expect(chapters(0, ['One'])[0]?.paras).toHaveLength(9);
  });
});
