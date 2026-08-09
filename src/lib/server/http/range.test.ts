import { describe, expect, it } from 'vitest';
import { parseSingleRange, RangeNotSatisfiableError } from './range';

describe('single byte range parsing', () => {
  it('returns null when the header is absent', () => {
    expect(parseSingleRange(null, 100)).toBeNull();
    expect(parseSingleRange(null, 0)).toBeNull();
  });

  it.each([
    ['bytes=10-19', 100, { start: 10, endInclusive: 19 }],
    ['bytes=10-', 100, { start: 10, endInclusive: 99 }],
    ['bytes=-10', 100, { start: 90, endInclusive: 99 }],
    ['bytes=90-200', 100, { start: 90, endInclusive: 99 }],
    ['bytes=-200', 100, { start: 0, endInclusive: 99 }]
  ])('parses %s', (header, size, expected) => {
    expect(parseSingleRange(header, size)).toEqual(expected);
  });

  it.each([
    'items=0-1',
    'bytes=',
    'bytes=1-2,4-5',
    'bytes=abc-def',
    'bytes=-0',
    'bytes=10-9',
    'bytes=100-'
  ])('rejects malformed, multiple, or unsatisfiable range %s', (header) => {
    expect(() => parseSingleRange(header, 100)).toThrow(RangeNotSatisfiableError);
  });

  it('rejects every explicit range for a zero-sized object', () => {
    expect(() => parseSingleRange('bytes=0-', 0)).toThrowError(
      expect.objectContaining({ status: 416, size: 0 })
    );
  });
});
