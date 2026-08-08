import { describe, expect, it } from 'vitest';
import type { ReaderPage } from '$lib/types/reader';
import { buildSheetWindow, visibleSheetIndices } from './sheet-window';

function pages(count: number): ReaderPage[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'scan' as const,
    chapter: 0,
    at: index,
    folio: String(index + 1),
    label: `Page ${index + 1}`
  }));
}

describe('visibleSheetIndices', () => {
  it('selects a partial window at the beginning', () => {
    expect(visibleSheetIndices(0, 100, 99)).toEqual([0, 1, 2]);
  });

  it('selects five absolute indices in the middle', () => {
    expect(visibleSheetIndices(50, 100, 99)).toEqual([48, 49, 50, 51, 52]);
  });

  it('selects the valid trailing window at the end sentinel', () => {
    expect(visibleSheetIndices(100, 100, 99)).toEqual([98, 99]);
  });

  it('returns every sheet in a short book', () => {
    expect(visibleSheetIndices(1, 3, 2)).toEqual([0, 1, 2]);
  });

  it('returns an empty window for an empty book', () => {
    expect(visibleSheetIndices(0, 0, -1)).toEqual([]);
  });

  it('does not select content beyond a preview boundary', () => {
    expect(visibleSheetIndices(4, 100, 3)).toEqual([2, 3]);
  });
});

describe('buildSheetWindow', () => {
  it('builds the same forward-turn values as the full-sheet implementation', () => {
    const result = buildSheetWindow({
      pages: pages(20),
      per: 2,
      currentSheet: 3,
      totalSheets: 10,
      maxReadableSheet: 9,
      turn: { dir: 1, t: 0.5 }
    });

    expect(result.map((sheet) => sheet.k)).toEqual([1, 2, 3, 4, 5]);
    expect(result.find((sheet) => sheet.k === 3)).toMatchObject({
      angle: -90,
      curl: 1,
      active: true,
      z: 13,
      showFront: true,
      showBack: true,
      front: { label: 'Page 7' },
      back: { label: 'Page 8' }
    });
  });

  it('builds the same backward-turn angle', () => {
    const result = buildSheetWindow({
      pages: pages(20),
      per: 2,
      currentSheet: 3,
      totalSheets: 10,
      maxReadableSheet: 9,
      turn: { dir: -1, t: 0.25 }
    });

    expect(result.find((sheet) => sheet.k === 2)).toMatchObject({
      angle: -135,
      active: true,
      showFront: true,
      showBack: true
    });
  });

  it('preserves settled face visibility and absolute stack depth', () => {
    const result = buildSheetWindow({
      pages: pages(20),
      per: 2,
      currentSheet: 3,
      totalSheets: 10,
      maxReadableSheet: 9,
      turn: null
    });

    expect(result.find((sheet) => sheet.k === 2)).toMatchObject({
      angle: -180,
      z: 3,
      showFront: false,
      showBack: true
    });
    expect(result.find((sheet) => sheet.k === 3)).toMatchObject({
      angle: 0,
      z: 8,
      showFront: true,
      showBack: false
    });
  });

  it('keeps an unflipped sheet key and depth stable as the window moves', () => {
    const input = {
      pages: pages(20),
      per: 2,
      totalSheets: 10,
      maxReadableSheet: 9,
      turn: null
    } as const;
    const first = buildSheetWindow({ ...input, currentSheet: 1 });
    const second = buildSheetWindow({ ...input, currentSheet: 2 });

    expect(first.find((sheet) => sheet.k === 3)?.z).toBe(8);
    expect(second.find((sheet) => sheet.k === 3)?.z).toBe(8);
  });

  it('never constructs more than five models for a large book', () => {
    const result = buildSheetWindow({
      pages: pages(2_000),
      per: 2,
      currentSheet: 500,
      totalSheets: 1_000,
      maxReadableSheet: 999,
      turn: null
    });

    expect(result).toHaveLength(5);
  });

  it('does not attach page content beyond the preview boundary', () => {
    const result = buildSheetWindow({
      pages: pages(20),
      per: 2,
      currentSheet: 4,
      totalSheets: 10,
      maxReadableSheet: 3,
      turn: null
    });

    expect(result.map((sheet) => sheet.k)).toEqual([2, 3]);
    expect(result.flatMap((sheet) => [sheet.front, sheet.back]).filter(Boolean)).toHaveLength(4);
    expect(result.every((sheet) => sheet.k <= 3)).toBe(true);
  });
});
