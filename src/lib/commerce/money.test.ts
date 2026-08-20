import { describe, expect, it } from 'vitest';
import { formatMinorCurrency, formatSignedMinorCurrency } from './money';

describe('formatMinorCurrency', () => {
  it.each([
    ['JPY', 1234, '¥1,234'],
    ['USD', 1234, '$12.34'],
    ['EUR', 1234, '€12.34'],
    ['BHD', 1234, 'BHD 1.234']
  ] as const)('formats %s using its currency minor-unit exponent', (currency, amount, expected) => {
    expect(formatMinorCurrency(amount, currency)).toBe(expected);
  });

  it.each(['ABC', 'IRR', 'KPW', 'ISK', 'UGX'])(
    'rejects currencies outside the supported commerce subset for %s',
    (currency) => {
      expect(() => formatMinorCurrency(1234, currency)).toThrow(/unsupported currency/iu);
    }
  );

  it('rejects amounts that are not safe integers', () => {
    expect(() => formatMinorCurrency(12.34, 'USD')).toThrow(/safe integer/iu);
  });
});

describe('formatSignedMinorCurrency', () => {
  it.each([
    ['JPY', -1234, '-JPY\u00a01,234'],
    ['USD', -1234, '-USD\u00a012.34'],
    ['BHD', 1234, '+BHD\u00a01.234'],
    ['USD', 0, 'USD\u00a00.00']
  ] as const)(
    'keeps the sign and ISO code for %s minor units',
    (currency, amount, expected) => {
      expect(formatSignedMinorCurrency(amount, currency)).toBe(expected);
    }
  );

  it('renders unavailable money explicitly without inventing a numeric value', () => {
    expect(formatSignedMinorCurrency(null, 'USD')).toBe('USD unavailable');
  });

  it.each([
    ['USD', Number.MAX_SAFE_INTEGER, '+USD\u00a090,071,992,547,409.91'],
    ['USD', Number.MIN_SAFE_INTEGER, '-USD\u00a090,071,992,547,409.91'],
    ['BHD', Number.MAX_SAFE_INTEGER, '+BHD\u00a09,007,199,254,740.991']
  ] as const)(
    'preserves every safe %s minor unit at the integer boundary',
    (currency, amount, expected) => {
      expect(formatSignedMinorCurrency(amount, currency)).toBe(expected);
    }
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 12.34, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe numeric input %s',
    (amount) => {
      expect(() => formatSignedMinorCurrency(amount, 'USD')).toThrow(/safe integer/iu);
    }
  );

  it('rejects unsupported currency semantics', () => {
    expect(() => formatSignedMinorCurrency(-100, 'ABC')).toThrow(/unsupported currency/iu);
  });
});
