import { z, type ZodType } from 'zod';
import { permanentStripeFailure } from './errors';
import type {
  CheckoutSnapshot,
  CreateCheckoutSessionInput,
  CreatedCheckoutSession,
  DisputeSnapshot,
  PaymentSnapshot,
  RefundSnapshot,
  VerifiedStripeEvent
} from './types';

const providerIdSchema = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/u);
const uuidSchema = z.uuid();
const moneySchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveMoneySchema = moneySchema.refine((value) => value > 0);
const dateSchema = z.date().refine((value) => Number.isFinite(value.getTime()));
const normalizedEmailSchema = z.string().trim().toLowerCase().max(320).pipe(z.email());
const supportedCurrencies = new Set(Intl.supportedValuesOf('currency').map((value) => value.toLowerCase()));
const currencySchema = z.string().regex(/^[a-z]{3}$/u).refine(
  (value) => supportedCurrencies.has(value),
  'unsupported currency'
);

const checkoutLineSnapshotSchema = z.strictObject({
  providerLineItemId: providerIdSchema,
  orderItemId: uuidSchema,
  quantity: z.literal(1),
  currency: currencySchema,
  subtotalMinor: moneySchema,
  taxMinor: moneySchema,
  totalMinor: moneySchema
}).refine(
  (value) => value.subtotalMinor + value.taxMinor === value.totalMinor,
  'line totals do not reconcile'
);

const createdCheckoutSessionSchema = z.strictObject({
  providerSessionId: providerIdSchema,
  checkoutUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com';
  }),
  expiresAt: dateSchema
});

const checkoutSnapshotSchema = z.strictObject({
  providerSessionId: providerIdSchema,
  clientReferenceId: uuidSchema,
  metadataVersion: z.literal('1'),
  metadataOrderId: uuidSchema,
  liveMode: z.boolean(),
  mode: z.literal('payment'),
  status: z.enum(['open', 'complete', 'expired']),
  paymentStatus: z.enum(['unpaid', 'paid', 'no_payment_required']),
  paymentIntentId: providerIdSchema.nullable(),
  latestChargeId: providerIdSchema.nullable(),
  customerEmail: normalizedEmailSchema.nullable(),
  currency: currencySchema,
  subtotalMinor: moneySchema,
  taxMinor: moneySchema,
  totalMinor: moneySchema,
  expiresAt: dateSchema,
  lineItems: z.array(checkoutLineSnapshotSchema).min(1).max(25)
}).superRefine((value, context) => {
  const providerIds = new Set<string>();
  const orderItemIds = new Set<string>();
  let subtotal = 0;
  let tax = 0;
  let total = 0;
  for (const [index, line] of value.lineItems.entries()) {
    if (providerIds.has(line.providerLineItemId)) {
      context.addIssue({ code: 'custom', path: ['lineItems', index, 'providerLineItemId'], message: 'duplicate provider line item' });
    }
    if (orderItemIds.has(line.orderItemId)) {
      context.addIssue({ code: 'custom', path: ['lineItems', index, 'orderItemId'], message: 'duplicate order item' });
    }
    if (line.currency !== value.currency) {
      context.addIssue({ code: 'custom', path: ['lineItems', index, 'currency'], message: 'currency mismatch' });
    }
    providerIds.add(line.providerLineItemId);
    orderItemIds.add(line.orderItemId);
    subtotal += line.subtotalMinor;
    tax += line.taxMinor;
    total += line.totalMinor;
  }
  if (![subtotal, tax, total].every(Number.isSafeInteger)) {
    context.addIssue({ code: 'custom', path: ['lineItems'], message: 'aggregate exceeds safe integer range' });
  }
  if (subtotal !== value.subtotalMinor || tax !== value.taxMinor || total !== value.totalMinor) {
    context.addIssue({ code: 'custom', path: ['lineItems'], message: 'aggregate totals do not reconcile' });
  }
  if (value.subtotalMinor + value.taxMinor !== value.totalMinor) {
    context.addIssue({ code: 'custom', path: ['totalMinor'], message: 'session totals do not reconcile' });
  }
});

const paymentSnapshotSchema = z.strictObject({
  paymentIntentId: providerIdSchema,
  latestChargeId: providerIdSchema.nullable(),
  liveMode: z.boolean(),
  state: z.enum(['pending', 'succeeded', 'failed']),
  amountMinor: moneySchema,
  currency: currencySchema,
  paidAt: dateSchema.nullable(),
  paymentMethodCategory: z.enum(['card', 'link', 'cashapp', 'amazon_pay', 'other']).nullable()
}).superRefine((value, context) => {
  if (value.state === 'succeeded' && (!value.latestChargeId || !value.paidAt)) {
    context.addIssue({ code: 'custom', path: ['state'], message: 'succeeded payment lacks charge evidence' });
  }
  if (value.state !== 'succeeded' && value.paidAt !== null) {
    context.addIssue({ code: 'custom', path: ['paidAt'], message: 'non-succeeded payment cannot be paid' });
  }
});

const refundSnapshotSchema = z.strictObject({
  providerRefundId: providerIdSchema,
  paymentIntentId: providerIdSchema,
  liveMode: z.boolean(),
  state: z.enum(['pending', 'succeeded', 'failed', 'canceled']),
  amountMinor: positiveMoneySchema,
  currency: currencySchema,
  reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer', 'other']).nullable(),
  providerCreatedAt: dateSchema
});

const disputeReasonValues = [
  'bank_cannot_process',
  'check_returned',
  'credit_not_processed',
  'customer_initiated',
  'debit_not_authorized',
  'duplicate',
  'fraudulent',
  'general',
  'incorrect_account_details',
  'insufficient_funds',
  'noncompliant',
  'product_not_received',
  'product_unacceptable',
  'subscription_canceled',
  'unrecognized',
  'other'
] as const;
const disputeReasonSchema = z.enum(disputeReasonValues);

const disputeSnapshotSchema = z.strictObject({
  providerDisputeId: providerIdSchema,
  paymentIntentId: providerIdSchema,
  chargeId: providerIdSchema,
  liveMode: z.boolean(),
  state: z.enum(['open', 'won', 'lost']),
  amountMinor: positiveMoneySchema,
  currency: currencySchema,
  reason: disputeReasonSchema.nullable(),
  providerCreatedAt: dateSchema,
  providerUpdatedAt: dateSchema
}).refine(
  (value) => value.providerUpdatedAt >= value.providerCreatedAt,
  'provider update precedes creation'
);

const verifiedStripeEventSchema = z.strictObject({
  providerEventId: providerIdSchema,
  type: z.string().trim().min(1).max(200).regex(/^[a-z0-9_.]+$/u),
  objectId: providerIdSchema,
  liveMode: z.boolean(),
  apiVersion: z.string().trim().min(1).max(100).nullable(),
  providerCreatedAt: dateSchema,
  rawBodySha256: z.string().regex(/^[a-f0-9]{64}$/u)
});

export const createCheckoutSessionInputSchema = z.strictObject({
  orderId: uuidSchema,
  accountEmail: normalizedEmailSchema.nullable(),
  currency: currencySchema,
  automaticTaxEnabled: z.boolean(),
  expiresAt: dateSchema,
  successUrl: z.url(),
  cancelUrl: z.url(),
  items: z.array(z.strictObject({
    orderItemId: uuidSchema,
    title: z.string().trim().min(1).max(500),
    format: z.enum(['prose', 'comic']),
    unitSubtotalMinor: positiveMoneySchema,
    taxCode: z.string().regex(/^txcd_[A-Za-z0-9]+$/u).max(200).nullable()
  })).min(1).max(25)
}).superRefine((value, context) => {
  const orderItemIds = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (orderItemIds.has(item.orderItemId)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'orderItemId'], message: 'duplicate order item' });
    }
    if (value.automaticTaxEnabled && item.taxCode === null) {
      context.addIssue({ code: 'custom', path: ['items', index, 'taxCode'], message: 'automatic tax requires a tax code' });
    }
    orderItemIds.add(item.orderItemId);
  }
}) satisfies ZodType<CreateCheckoutSessionInput>;

function parseCanonical<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw permanentStripeFailure(parsed.error);
  return parsed.data;
}

export const parseCreatedCheckoutSession = (value: unknown): CreatedCheckoutSession =>
  parseCanonical(createdCheckoutSessionSchema, value);
export const parseCheckoutSnapshot = (value: unknown): CheckoutSnapshot =>
  parseCanonical(checkoutSnapshotSchema, value);
export const parsePaymentSnapshot = (value: unknown): PaymentSnapshot =>
  parseCanonical(paymentSnapshotSchema, value);
export const parseRefundSnapshot = (value: unknown): RefundSnapshot =>
  parseCanonical(refundSnapshotSchema, value);
export const parseDisputeSnapshot = (value: unknown): DisputeSnapshot =>
  parseCanonical(disputeSnapshotSchema, value);
export const parseVerifiedStripeEvent = (value: unknown): VerifiedStripeEvent =>
  parseCanonical(verifiedStripeEventSchema, value);

export function normalizePaymentState(value: string): PaymentSnapshot['state'] {
  if (value === 'succeeded') return 'succeeded';
  if (value === 'canceled') return 'failed';
  if (['processing', 'requires_action', 'requires_confirmation', 'requires_capture', 'requires_payment_method'].includes(value)) return 'pending';
  throw permanentStripeFailure();
}

export function normalizeRefundState(value: string): RefundSnapshot['state'] {
  if (value === 'succeeded' || value === 'failed' || value === 'canceled') return value;
  if (value === 'pending' || value === 'requires_action') return 'pending';
  throw permanentStripeFailure();
}

export function normalizeDisputeState(value: string): DisputeSnapshot['state'] {
  if (value === 'won' || value === 'lost') return value;
  if (['warning_needs_response', 'warning_under_review', 'warning_closed', 'needs_response', 'under_review', 'prevented'].includes(value)) return 'open';
  throw permanentStripeFailure();
}

export function normalizePaymentMethodCategory(value: string | null): PaymentSnapshot['paymentMethodCategory'] {
  if (value === null) return null;
  if (value === 'card' || value === 'link' || value === 'cashapp' || value === 'amazon_pay') return value;
  return 'other';
}

export function normalizeRefundReason(value: string | null): RefundSnapshot['reason'] {
  if (value === null) return null;
  if (value === 'duplicate' || value === 'fraudulent' || value === 'requested_by_customer') return value;
  return 'other';
}

const disputeReasons = new Set<string>(disputeReasonValues);

export function normalizeDisputeReason(value: string | null): DisputeSnapshot['reason'] {
  if (value === null) return null;
  return disputeReasons.has(value) ? value : 'other';
}
