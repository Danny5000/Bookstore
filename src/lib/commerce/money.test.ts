import { describe, expect, it } from 'vitest';
import { formatMinorCurrency } from './money';

describe('formatMinorCurrency', () => {
  it.each([
    ['JPY', 1234, '¥1,234'],
    ['USD', 1234, '$12.34'],
    ['EUR', 1234, '€12.34'],
    ['BHD', 1234, 'BHD 1.234']
  ] as const)('formats %s using its currency minor-unit exponent', (currency, amount, expected) => {
    expect(formatMinorCurrency(amount, currency)).toBe(expected);
  });

  it.each(['ABC', 'ISK', 'UGX'])(
    'rejects currencies outside the supported commerce subset for %s',
    (currency) => {
      expect(() => formatMinorCurrency(1234, currency)).toThrow(/unsupported currency/iu);
    }
  );

  it('rejects amounts that are not safe integers', () => {
    expect(() => formatMinorCurrency(12.34, 'USD')).toThrow(/safe integer/iu);
  });
});
