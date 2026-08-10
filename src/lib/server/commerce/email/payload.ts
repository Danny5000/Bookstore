import { z } from 'zod';

export const COMMERCE_EMAIL_TOPIC = 'email.commerce.v1' as const;

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const supportedCurrencies = new Set(Intl.supportedValuesOf('currency'));
const moneySchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safeUrlSchema = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && loopbackHosts.has(url.hostname))) &&
    url.username === '' &&
    url.password === '' &&
    url.hash === ''
  );
}, 'URL must be secure, credential-free, and fragment-free');
const normalizedEmailSchema = z.string().trim().toLowerCase().max(320).pipe(z.email());
const currencySchema = z.string().regex(/^[A-Z]{3}$/u).refine(
  (value) => supportedCurrencies.has(value),
  'unsupported currency'
);
const receiptItemSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
  creatorName: z.string().trim().min(1).max(500),
  format: z.enum(['prose', 'comic'])
});
const common = {
  version: z.literal(1),
  to: normalizedEmailSchema,
  messageId: z.uuid()
};
const receipt = {
  ...common,
  orderNumber: z.uuid(),
  orderDate: z.iso.datetime(),
  currency: currencySchema,
  subtotalMinor: moneySchema,
  taxMinor: moneySchema,
  totalMinor: moneySchema,
  items: z.array(receiptItemSchema).min(1).max(25)
};
const accountReceiptSchema = z.strictObject({
  ...receipt,
  template: z.literal('commerce.account-receipt')
}).refine((value) => value.subtotalMinor + value.taxMinor === value.totalMinor, {
  path: ['totalMinor'],
  message: 'receipt totals do not reconcile'
});
const guestReceiptSchema = z.strictObject({
  ...receipt,
  template: z.literal('commerce.guest-receipt-claim'),
  claimUrl: safeUrlSchema
}).refine((value) => value.subtotalMinor + value.taxMinor === value.totalMinor, {
  path: ['totalMinor'],
  message: 'receipt totals do not reconcile'
});
const refundAccessSchema = z.strictObject({
  ...common,
  template: z.literal('commerce.refund-access-changed'),
  reasonCategory: z.literal('refund_completed'),
  affectedTitleCount: z.number().int().min(1).max(25),
  libraryUrl: safeUrlSchema,
  helpUrl: safeUrlSchema
});
const disputeAccessSchema = z.strictObject({
  ...common,
  template: z.literal('commerce.dispute-access-changed'),
  reasonCategory: z.enum(['dispute_opened', 'dispute_resolved']),
  affectedTitleCount: z.number().int().min(1).max(25),
  libraryUrl: safeUrlSchema,
  helpUrl: safeUrlSchema
});

export const commerceEmailPayloadSchema = z.union([
  accountReceiptSchema,
  guestReceiptSchema,
  refundAccessSchema,
  disputeAccessSchema
]);

export type CommerceEmailPayload = z.output<typeof commerceEmailPayloadSchema>;
export type CommerceEmailTemplate = CommerceEmailPayload['template'];

function parseExpectedOrigin(value: string): URL {
  const parsed = safeUrlSchema.parse(new URL(value).origin);
  return new URL(parsed);
}

function assertSameOrigin(url: URL, origin: URL): void {
  if (url.origin !== origin.origin) throw new Error('Commerce email URL is not same-origin');
}

function assertClaimUrl(value: string, origin: URL): void {
  const url = new URL(value);
  assertSameOrigin(url, origin);
  if (url.pathname !== '/api/auth/magic-link/verify') {
    throw new Error('Commerce claim URL has an unexpected path');
  }
  const allowed = new Set([
    'token',
    'callbackURL',
    'errorCallbackURL',
    'newUserCallbackURL'
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new Error('Commerce claim URL has an unexpected parameter');
  }
  if (!url.searchParams.get('token')) throw new Error('Commerce claim URL lacks a token');
  for (const key of ['callbackURL', 'errorCallbackURL', 'newUserCallbackURL']) {
    const callback = url.searchParams.get(key);
    if (callback === null) continue;
    const callbackUrl = new URL(callback, origin);
    assertSameOrigin(callbackUrl, origin);
    if (callbackUrl.pathname !== '/claim/complete') {
      throw new Error('Commerce claim callback has an unexpected path');
    }
  }
}

function assertApplicationUrl(value: string, origin: URL, path: '/library' | '/help'): void {
  const url = new URL(value);
  assertSameOrigin(url, origin);
  if (url.pathname !== path || url.search !== '') {
    throw new Error('Commerce email application URL has an unexpected path');
  }
}

export function parseCommerceEmailPayload(
  value: unknown,
  expectedOrigin: string
): CommerceEmailPayload {
  const payload = commerceEmailPayloadSchema.parse(value);
  const origin = parseExpectedOrigin(expectedOrigin);
  if (payload.template === 'commerce.guest-receipt-claim') {
    assertClaimUrl(payload.claimUrl, origin);
  } else if (
    payload.template === 'commerce.refund-access-changed' ||
    payload.template === 'commerce.dispute-access-changed'
  ) {
    assertApplicationUrl(payload.libraryUrl, origin, '/library');
    assertApplicationUrl(payload.helpUrl, origin, '/help');
  }
  return payload;
}
