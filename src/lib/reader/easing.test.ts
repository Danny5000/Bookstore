import { describe, expect, it } from 'vitest';
import { cubicBezier } from './easing';

describe('cubicBezier', () => {
  it('keeps the endpoints fixed', () => {
    const easing = cubicBezier(0.22, 0.61, 0.28, 1);
    expect(easing(0)).toBeCloseTo(0);
    expect(easing(1)).toBeCloseTo(1);
  });

  it('matches the prototype turn curve at the midpoint', () => {
    const easing = cubicBezier(0.22, 0.61, 0.28, 1);
    expect(easing(0.5)).toBeCloseTo(0.895, 2);
  });

  it('is monotonic across a page turn', () => {
    const easing = cubicBezier(0.16, 0.78, 0.32, 1);
    const samples = [0, 0.25, 0.5, 0.75, 1].map(easing);
    expect(samples).toEqual([...samples].sort((left, right) => left - right));
  });
});
