import { describe, expect, it } from 'vitest';
import { computeRetryDelayMs } from './backoff';

describe('computeRetryDelayMs', () => {
  it.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 10_000],
    [50, 10_000]
  ])('bounds attempt %i at %i milliseconds', (attempts, expected) => {
    expect(computeRetryDelayMs(attempts, 1000, 10_000)).toBe(expected);
  });
});
