import { describe, expect, it } from 'vitest';
import {
  movePanelBox,
  normalizeDragBox,
  parsePanelBoxes,
  resizePanelBox,
  serializePanelBoxes,
  type NormalizedPanelBox
} from './panel-geometry';

const bounds = { width: 200, height: 100 };

describe('panel editor geometry', () => {
  it.each([
    [{ x: 20, y: 10 }, { x: 180, y: 90 }],
    [{ x: 180, y: 90 }, { x: 20, y: 10 }],
    [{ x: 180, y: 10 }, { x: 20, y: 90 }],
    [{ x: 20, y: 90 }, { x: 180, y: 10 }]
  ])('normalizes a pointer drag in every direction', (start, end) => {
    expect(normalizeDragBox(start, end, bounds)).toEqual({
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.8
    });
  });

  it('clamps drags to the image and rejects near-zero boxes', () => {
    expect(normalizeDragBox({ x: -20, y: -20 }, { x: 240, y: 140 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1
    });
    expect(normalizeDragBox({ x: 10, y: 10 }, { x: 11, y: 10.5 }, bounds)).toBeNull();
  });

  it('moves and resizes within bounds while enforcing the minimum size', () => {
    const box: NormalizedPanelBox = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };
    expect(movePanelBox(box, { x: 180, y: -40 }, bounds)).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 0.4
    });
    expect(resizePanelBox(box, 'se', { x: 200, y: 100 }, bounds)).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.9,
      height: 0.8
    });
    expect(resizePanelBox(box, 'nw', { x: 99, y: 39 }, bounds)).toEqual({
      x: 0.59,
      y: 0.58,
      width: 0.01,
      height: 0.02
    });
  });

  it('round-trips boxes at six-decimal precision and rejects invalid payloads', () => {
    const boxes: NormalizedPanelBox[] = [
      { x: 0.123456789, y: 0.2, width: 0.333333333, height: 0.4 }
    ];
    const serialized = serializePanelBoxes(boxes);
    expect(serialized).toBe('[{"x":0.123457,"y":0.2,"width":0.333333,"height":0.4}]');
    expect(parsePanelBoxes(serialized)).toEqual([
      { x: 0.123457, y: 0.2, width: 0.333333, height: 0.4 }
    ]);
    expect(() => parsePanelBoxes('[{"x":0.9,"y":0,"width":0.2,"height":1}]')).toThrow();
  });
});
