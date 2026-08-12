import { describe, expect, it } from 'vitest';
import { PermanentFinancialError } from '../errors';
import { allocateSignedLargestRemainder } from './largest-remainder';

describe('allocateSignedLargestRemainder', () => {
  it.each([
    {
      label: 'positive remainder',
      amountMinor: 10,
      weights: [{ tieKey: 'b', weightMinor: 1 }, { tieKey: 'a', weightMinor: 1 }, { tieKey: 'c', weightMinor: 1 }],
      expected: [{ tieKey: 'a', amountMinor: 4 }, { tieKey: 'b', amountMinor: 3 }, { tieKey: 'c', amountMinor: 3 }]
    },
    {
      label: 'negative remainder',
      amountMinor: -10,
      weights: [{ tieKey: 'b', weightMinor: 1 }, { tieKey: 'a', weightMinor: 1 }, { tieKey: 'c', weightMinor: 1 }],
      expected: [{ tieKey: 'a', amountMinor: -4 }, { tieKey: 'b', amountMinor: -3 }, { tieKey: 'c', amountMinor: -3 }]
    },
    {
      label: 'zero amount',
      amountMinor: 0,
      weights: [{ tieKey: 'b', weightMinor: 0 }, { tieKey: 'a', weightMinor: 2 }],
      expected: [{ tieKey: 'a', amountMinor: 0 }]
    },
    {
      label: 'one target',
      amountMinor: 7,
      weights: [{ tieKey: 'only', weightMinor: 91 }],
      expected: [{ tieKey: 'only', amountMinor: 7 }]
    }
  ])('allocates $label exactly and deterministically', ({ amountMinor, weights, expected }) => {
    const result = allocateSignedLargestRemainder({ amountMinor, weights });
    expect(result).toEqual(expected);
    expect(result.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(amountMinor);
  });

  it.each([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])(
    'conserves safe-integer boundary %s using BigInt intermediates',
    (amountMinor) => {
      const result = allocateSignedLargestRemainder({
        amountMinor,
        weights: [
          { tieKey: 'a', weightMinor: Number.MAX_SAFE_INTEGER },
          { tieKey: 'b', weightMinor: Number.MAX_SAFE_INTEGER - 1 }
        ]
      });
      expect(BigInt(result[0]!.amountMinor) + BigInt(result[1]!.amountMinor))
        .toBe(BigInt(amountMinor));
    }
  );

  it.each([
    ['duplicate tie keys', { amountMinor: 1, weights: [{ tieKey: 'a', weightMinor: 1 }, { tieKey: 'a', weightMinor: 2 }] }],
    ['empty tie key', { amountMinor: 1, weights: [{ tieKey: '', weightMinor: 1 }] }],
    ['unsafe amount', { amountMinor: Number.MAX_SAFE_INTEGER + 1, weights: [{ tieKey: 'a', weightMinor: 1 }] }],
    ['negative weight', { amountMinor: 1, weights: [{ tieKey: 'a', weightMinor: -1 }] }],
    ['fractional weight', { amountMinor: 1, weights: [{ tieKey: 'a', weightMinor: 1.5 }] }],
    ['unsafe weight', { amountMinor: 1, weights: [{ tieKey: 'a', weightMinor: Number.MAX_SAFE_INTEGER + 1 }] }],
    ['nonzero amount without positive weight', { amountMinor: 1, weights: [{ tieKey: 'a', weightMinor: 0 }] }]
  ] as const)('rejects %s', (_label, input) => {
    try {
      allocateSignedLargestRemainder(input);
      throw new Error('expected allocation to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentFinancialError);
      expect(error).toMatchObject({ safeCode: 'allocation_mismatch' });
      expect(error).not.toHaveProperty('cause');
    }
  });

  it('orders ties by Unicode code point and does not mutate input', () => {
    const input = {
      amountMinor: 1,
      weights: [
        { tieKey: '\u{10000}', weightMinor: 1 },
        { tieKey: '\uE000', weightMinor: 1 },
        { tieKey: 'zero', weightMinor: 0 }
      ]
    };
    const before = structuredClone(input);

    expect(allocateSignedLargestRemainder(input)).toEqual([
      { tieKey: '\uE000', amountMinor: 1 },
      { tieKey: '\u{10000}', amountMinor: 0 }
    ]);
    expect(input).toEqual(before);
  });
});
