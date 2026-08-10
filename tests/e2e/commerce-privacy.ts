const forbiddenKeys = new Set([
  'secret',
  'signature',
  'stripesignature',
  'rawbody',
  'rawevent',
  'billingaddress',
  'shippingaddress',
  'cardnumber',
  'cardlast4',
  'cardbrand',
  'last4',
  'brand',
  'billingdetails',
  'paymentmethoddetails',
  'clientsecret'
]);

const forbiddenTextKey = /(?:^|[\s,{])(?:["']|\\")?(?:secret|signature|stripeSignature|rawBody|rawEvent|billingAddress|shippingAddress|cardNumber|cardLast4|cardBrand|last4|brand|billing_details|payment_method_details|client_secret)(?:["']|\\")?\s*:/iu;
const providerSecret = /sk_(?:test|live)_[a-z0-9_-]+|whsec_[a-z0-9_-]+|\b4242\b/iu;

export type CommercePrivacySurface =
  | 'account browser'
  | 'account console'
  | 'account database'
  | 'account response'
  | 'guest browser'
  | 'guest console'
  | 'guest database'
  | 'lifecycle browser'
  | 'lifecycle console'
  | 'lifecycle database';

function normalizedKey(key: string): string {
  return key.replaceAll(/[_-]/gu, '').toLowerCase();
}

function hasSensitiveEvidence(
  value: unknown,
  forbiddenValues: readonly string[],
  visited: WeakSet<object>
): boolean {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    return forbiddenTextKey.test(value) || providerSecret.test(value) || forbiddenValues.some(
      (forbidden) => forbidden.length > 0 && normalized.includes(forbidden.toLowerCase())
    );
  }
  if (value === null || typeof value !== 'object') return false;
  if (visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => hasSensitiveEvidence(entry, forbiddenValues, visited));
  }
  return Object.entries(value).some(([key, entry]) => (
    forbiddenKeys.has(normalizedKey(key)) ||
    hasSensitiveEvidence(entry, forbiddenValues, visited)
  ));
}

export function assertCommercePrivacy(
  surface: CommercePrivacySurface,
  evidence: unknown,
  forbiddenValues: readonly string[] = []
): void {
  if (hasSensitiveEvidence(evidence, forbiddenValues, new WeakSet())) {
    throw new Error(`Sensitive commerce data detected on ${surface}`);
  }
}
