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
  'email',
  'customer',
  'card',
  'paymentmethod',
  'address',
  'receipturl',
  'description',
  'destination',
  'metadata',
  'paymentmethoddetails',
  'clientsecret',
  'rawobject',
  'providermessage'
]);

const financialArtifactForbiddenKeys = new Set([
  'privateinput',
  'privatecommand',
  'commandinput',
  'idempotencykey',
  'idempotencykeysha256',
  'inputfingerprintsha256',
  'jobid',
  'jobpayload',
  'attempts',
  'maxattempts',
  'financialadminleasecapability',
  'leasecapability',
  'capabilitydigest',
  'capabilitysha256',
  'financialadminleasecapabilitysha256',
  'generation',
  'leasegeneration',
  'expiresat',
  'leaseexpiresat',
  'lasterror',
  'providerrequest',
  'providerresponse',
  'providerbody',
  'providerid',
  'providereventid',
  'providerpayoutid',
  'providerrefundid',
  'providertransactionid',
  'stripepaymentintentid',
  'stripechargeid',
  'striperefundid',
  'stripedisputeid',
  'stripepayoutid',
  'claimproof',
  'authtoken',
  'password',
  'passwordresettoken',
  'resettoken',
  'magiclinktoken',
  'statustokensha256',
  'ipaddress',
  'useragent',
  'sqlerror',
  'stack',
  'stacktrace',
  'databaserole',
  'filesystempath'
]);

const textKeyPattern = /(?:^|[\s,{])(?:["']|\\")?([a-z][a-z0-9_-]*)(?:["']|\\")?\s*:/giu;
const providerSecret = /(?:sk|rk)_(?:test|live)_[a-z0-9_-]+|whsec_[a-z0-9_-]+|BEGIN PRIVATE KEY/iu;
const canonicalUuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const testCardEvidence = /\b4242\b|\b4242(?:[ -]?4242){3}\b/iu;
const providerObjectId = /\b(?:pi|ch|re|dp|po|txn|evt|cus|pm)_[a-z0-9][a-z0-9_-]{3,}\b/iu;
const rawEmail = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/iu;
const networkIdentity = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b|\bMozilla\/[0-9]/iu;
const internalFailure = /\bSQLSTATE\s+[0-9A-Z]{5}\b|(?:^|\n)\s+at\s+[^\n]+:\d+:\d+|\bpale_orbit_(?:test|(?:test|fixture)_(?:web|worker|owner|storage_cleanup)|rehearsal_(?:web|worker|owner|cleanup)|(?:runtime|financial_worker|owner|storage_cleanup|web|worker)(?:_login)?)\b/iu;
const filesystemPath = /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\/(?:app|run\/secrets|var\/lib|tmp)\/)/u;
const bearerCredential = /\bBearer\s+[A-Za-z0-9._~-]+/u;

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
  | 'lifecycle database'
  | 'financial html'
  | 'financial json'
  | 'financial csv'
  | 'financial status'
  | 'financial safe result'
  | 'financial audit'
  | 'financial email'
  | 'financial log'
  | 'financial browser'
  | 'financial restore'
  | 'sales browser'
  | 'sales console'
  | 'sales database'
  | 'sales response'
  | 'sales csv'
  | 'sales audit'
  | 'sales email'
  | 'sales restore';

function normalizedKey(key: string): string {
  return key.replaceAll(/[_-]/gu, '').toLowerCase();
}

function hasForbiddenTextKey(value: string, financialArtifact: boolean): boolean {
  return [...value.matchAll(textKeyPattern)].some(
    (match) => {
      const key = normalizedKey(match[1] ?? '');
      return forbiddenKeys.has(key) ||
        (financialArtifact && financialArtifactForbiddenKeys.has(key));
    }
  );
}

function hasTestCardEvidence(value: string): boolean {
  return testCardEvidence.test(value.replaceAll(canonicalUuid, ''));
}

function hasSensitiveErrorData(
  error: Error,
  forbiddenValues: readonly string[],
  visited: WeakSet<object>,
  financialArtifact: boolean
): boolean {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const sensitiveOwnData = Reflect.ownKeys(descriptors).some((key) => {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
      if (descriptor === undefined) return false;
      if (typeof key === 'string') {
        const normalized = normalizedKey(key);
        if (
          forbiddenKeys.has(normalized) ||
          (financialArtifact && financialArtifactForbiddenKeys.has(normalized))
        ) return true;
      }
      return Object.hasOwn(descriptor, 'value') && hasSensitiveEvidence(
        descriptor.value,
        forbiddenValues,
        visited,
        financialArtifact
      );
    });
    if (sensitiveOwnData) return true;
    for (const key of ['name', 'message', 'stack', 'cause'] as const) {
      let prototype = Object.getPrototypeOf(error) as object | null;
      while (prototype !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
        if (descriptor !== undefined) {
          if (
            Object.hasOwn(descriptor, 'value') &&
            hasSensitiveEvidence(
              descriptor.value,
              forbiddenValues,
              visited,
              financialArtifact
            )
          ) return true;
          break;
        }
        prototype = Object.getPrototypeOf(prototype) as object | null;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function hasSensitiveEvidence(
  value: unknown,
  forbiddenValues: readonly string[],
  visited: WeakSet<object>,
  financialArtifact: boolean
): boolean {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
      return hasForbiddenTextKey(value, financialArtifact) ||
      providerSecret.test(value) ||
      hasTestCardEvidence(value) ||
      (financialArtifact && providerObjectId.test(value)) ||
      rawEmail.test(value) ||
      networkIdentity.test(value) ||
      internalFailure.test(value) ||
      filesystemPath.test(value) ||
      bearerCredential.test(value) ||
      forbiddenValues.some(
        (forbidden) => forbidden.length > 0 && normalized.includes(forbidden.toLowerCase())
      );
  }
  if (value === null || typeof value !== 'object') return false;
  if (visited.has(value)) return false;
  visited.add(value);
  if (value instanceof Error) {
    return hasSensitiveErrorData(value, forbiddenValues, visited, financialArtifact);
  }
  if (Array.isArray(value)) {
    return value.some(
      (entry) => hasSensitiveEvidence(entry, forbiddenValues, visited, financialArtifact)
    );
  }
  return Object.entries(value).some(([key, entry]) => (
    forbiddenKeys.has(normalizedKey(key)) ||
    (financialArtifact && financialArtifactForbiddenKeys.has(normalizedKey(key))) ||
    hasSensitiveEvidence(entry, forbiddenValues, visited, financialArtifact)
  ));
}

export function assertCommercePrivacy(
  surface: CommercePrivacySurface,
  evidence: unknown,
  forbiddenValues: readonly string[] = []
): void {
  const financialArtifact = surface.startsWith('financial ') || surface.startsWith('sales ');
  if (hasSensitiveEvidence(evidence, forbiddenValues, new WeakSet(), financialArtifact)) {
    throw new Error(`Sensitive commerce data detected on ${surface}`);
  }
}
