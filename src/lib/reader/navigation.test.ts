import { describe, expect, it } from 'vitest';
import { clampSheet } from './navigation';

describe('clampSheet', () => {
  it('clamps positions below the first sheet', () => {
    expect(clampSheet(-1, 10, 10)).toBe(0);
  });

  it('preserves an interior position', () => {
    expect(clampSheet(4, 10, 10)).toBe(4);
  });

  it('uses the preview limit when it is lower than the book limit', () => {
    expect(clampSheet(9, 10, 6)).toBe(6);
  });

  it('never exceeds the physical end of the book', () => {
    expect(clampSheet(11, 10, 20)).toBe(10);
  });

  it('normalizes negative bounds to an empty range', () => {
    expect(clampSheet(3, -1, -1)).toBe(0);
  });
});
