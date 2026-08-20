export const MAX_CATALOG_PRICE_MINOR = 49_999_999;
export const MAX_CHECKOUT_SUBTOTAL_MINOR = MAX_CATALOG_PRICE_MINOR;
export const MAX_STRIPE_AMOUNT_MINOR = 99_999_999;

// Stripe presentment currencies pinned from https://docs.stripe.com/currencies on 2026-08-10.
// Runtime Intl support is still required because all storefront amounts use the ISO exponent
// reported by Intl.NumberFormat.
const stripePresentmentCurrencies = new Set<string>([
  'USD', 'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM',
  'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BWP', 'BYN',
  'BZD',
  'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP',
  'DZD', 'EGP', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GIP', 'GMD', 'GNF', 'GTQ',
  'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JMD', 'JPY', 'KES',
  'KGS', 'KHR', 'KMF', 'KRW', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'MAD',
  'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN',
  'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN',
  'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SEK', 'SGD', 'SHP',
  'SLE', 'SOS', 'SRD', 'STD', 'SZL', 'THB', 'TJS', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS',
  'UAH', 'UGX', 'UYU', 'UZS', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XOF', 'XPF',
  'YER', 'ZAR', 'ZMW'
]);
const intlSupportedCurrencies = new Set(Intl.supportedValuesOf('currency'));

// Stripe encodes these zero-decimal currencies with two trailing zeros, so its charge-unit
// amounts cannot be displayed safely using the Intl/ISO exponent.
const stripeChargeUnitExceptions = new Set(['ISK', 'UGX']);

export function isSupportedCommerceCurrency(currency: string): boolean {
  const normalizedCurrency = currency.trim().toUpperCase();
  return (
    stripePresentmentCurrencies.has(normalizedCurrency) &&
    intlSupportedCurrencies.has(normalizedCurrency) &&
    !stripeChargeUnitExceptions.has(normalizedCurrency)
  );
}

export function formatMinorCurrency(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError('Minor currency amount must be a safe integer');
  }
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!isSupportedCommerceCurrency(normalizedCurrency)) {
    throw new RangeError(`Unsupported currency minor-unit semantics: ${currency}`);
  }
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: normalizedCurrency
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
  if (fractionDigits === undefined) {
    throw new RangeError(`Unsupported currency minor-unit semantics: ${currency}`);
  }
  return formatter.format(amountMinor / 10 ** fractionDigits);
}

export function formatSignedMinorCurrency(
  amountMinor: number | null,
  currency: string
): string {
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!isSupportedCommerceCurrency(normalizedCurrency)) {
    throw new RangeError(`Unsupported currency minor-unit semantics: ${currency}`);
  }
  if (amountMinor === null) return `${normalizedCurrency} unavailable`;
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError('Minor currency amount must be a safe integer');
  }
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: normalizedCurrency
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
  if (fractionDigits === undefined) {
    throw new RangeError(`Unsupported currency minor-unit semantics: ${currency}`);
  }
  const signedMinor = BigInt(amountMinor);
  const absoluteMinor = signedMinor < 0n ? -signedMinor : signedMinor;
  const scale = 10n ** BigInt(fractionDigits);
  const whole = absoluteMinor / scale;
  const remainder = absoluteMinor % scale;
  const groupedWhole = new Intl.NumberFormat('en-US', {
    useGrouping: true,
    maximumFractionDigits: 0
  }).format(whole);
  const fraction = fractionDigits === 0
    ? ''
    : `.${remainder.toString().padStart(fractionDigits, '0')}`;
  const sign = amountMinor < 0 ? '-' : amountMinor > 0 ? '+' : '';
  return `${sign}${normalizedCurrency}\u00a0${groupedWhole}${fraction}`;
}
