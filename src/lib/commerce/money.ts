const supportedCommerceCurrencies = new Set(Intl.supportedValuesOf('currency'));

// Stripe encodes these zero-decimal currencies with two trailing zeros, so its charge-unit
// amounts cannot be displayed safely using the Intl/ISO exponent.
const stripeChargeUnitExceptions = new Set(['ISK', 'UGX']);

export function isSupportedCommerceCurrency(currency: string): boolean {
  const normalizedCurrency = currency.trim().toUpperCase();
  return (
    supportedCommerceCurrencies.has(normalizedCurrency) &&
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
