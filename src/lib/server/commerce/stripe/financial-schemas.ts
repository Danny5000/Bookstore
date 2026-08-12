import { z, type ZodType } from 'zod';
import {
  isSupportedCommerceCurrency,
  MAX_STRIPE_AMOUNT_MINOR
} from '$lib/commerce/money';
import { FINANCIAL_PAGE_SIZE } from '$lib/server/commerce/financial/constants';
import { permanentStripeFailure } from './errors';
import { dateSchema, providerIdSchema } from './schemas';
import type {
  BalanceTransactionSnapshot,
  ChargeSnapshot,
  PayoutSnapshot,
  StripeListPage,
  StripePageRequest
} from './financial-types';

const signedMoneySchema = z.number().int()
  .min(-MAX_STRIPE_AMOUNT_MINOR)
  .max(MAX_STRIPE_AMOUNT_MINOR);
const moneySchema = z.number().int().min(0).max(MAX_STRIPE_AMOUNT_MINOR);
const financialCurrencySchema = z.string().regex(/^[A-Z]{3}$/u).refine(
  isSupportedCommerceCurrency,
  'unsupported currency'
);
const boundedProviderValueSchema = z.string().min(1).max(100)
  .regex(/^[A-Za-z0-9_.-]+$/u);
const unixSecondsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safeFailureCodeSchema = z.string().regex(/^[a-z0-9_]{1,100}$/u);

const exactDecimalSchema = z.string().refine((value) => {
  if (!/^(?:0\.[0-9]+|[1-9][0-9]*(?:\.[0-9]+)?)$/u.test(value)) return false;
  const [integer, fraction = ''] = value.split('.');
  if (integer === undefined || integer.length > 20 || fraction.length > 18) return false;
  if (integer.length + fraction.length > 38) return false;
  return /[1-9]/u.test(value);
}, 'exchange rate is not a canonical positive exact decimal');

const feeDetailSchema = z.strictObject({
  ordinal: z.number().int().min(0).max(2_147_483_647),
  rawType: boundedProviderValueSchema,
  amountMinor: moneySchema,
  currency: financialCurrencySchema
});

const chargeSnapshotSchema = z.strictObject({
  id: providerIdSchema,
  paymentIntentId: providerIdSchema,
  livemode: z.boolean(),
  amountMinor: moneySchema,
  amountRefundedMinor: moneySchema,
  currency: financialCurrencySchema,
  status: z.enum(['succeeded', 'pending', 'failed']),
  balanceTransactionId: providerIdSchema.nullable(),
  createdAt: dateSchema
}).refine(
  (value) => value.amountRefundedMinor <= value.amountMinor,
  { path: ['amountRefundedMinor'], message: 'refunded amount exceeds charge amount' }
) satisfies ZodType<ChargeSnapshot>;

const balanceTransactionSnapshotSchema = z.strictObject({
  id: providerIdSchema,
  livemode: z.boolean(),
  sourceId: providerIdSchema.nullable(),
  sourceFamily: z.enum(['charge', 'refund', 'dispute', 'payout', 'adjustment', 'unknown']),
  rawType: boundedProviderValueSchema,
  reportingCategory: boundedProviderValueSchema,
  amountMinor: signedMoneySchema,
  feeMinor: moneySchema,
  netMinor: signedMoneySchema,
  currency: financialCurrencySchema,
  status: z.enum(['pending', 'available']),
  balanceType: boundedProviderValueSchema,
  createdAt: dateSchema,
  availableAt: dateSchema,
  exchangeRate: exactDecimalSchema.nullable(),
  exchangeSourceCurrency: financialCurrencySchema.nullable(),
  exchangeTargetCurrency: financialCurrencySchema.nullable(),
  feeDetails: z.array(feeDetailSchema).max(FINANCIAL_PAGE_SIZE)
}).superRefine((value, context) => {
  if (value.netMinor !== value.amountMinor - value.feeMinor) {
    context.addIssue({ code: 'custom', path: ['netMinor'], message: 'transaction net does not reconcile' });
  }
  const ordinals = new Set<number>();
  for (const [index, detail] of value.feeDetails.entries()) {
    if (ordinals.has(detail.ordinal)) {
      context.addIssue({ code: 'custom', path: ['feeDetails', index, 'ordinal'], message: 'duplicate fee ordinal' });
    }
    if (detail.currency !== value.currency) {
      context.addIssue({ code: 'custom', path: ['feeDetails', index, 'currency'], message: 'fee currency mismatch' });
    }
    ordinals.add(detail.ordinal);
  }
  const exchangeValues = [
    value.exchangeRate,
    value.exchangeSourceCurrency,
    value.exchangeTargetCurrency
  ];
  const hasExchangeEvidence = exchangeValues.every((item) => item !== null);
  if (!hasExchangeEvidence && exchangeValues.some((item) => item !== null)) {
    context.addIssue({ code: 'custom', path: ['exchangeRate'], message: 'incomplete exchange evidence' });
  }
  if (
    hasExchangeEvidence &&
    (value.exchangeSourceCurrency === value.exchangeTargetCurrency ||
      value.exchangeTargetCurrency !== value.currency)
  ) {
    context.addIssue({ code: 'custom', path: ['exchangeTargetCurrency'], message: 'invalid exchange currency pair' });
  }
}) satisfies ZodType<BalanceTransactionSnapshot>;

const payoutSnapshotSchema = z.strictObject({
  id: providerIdSchema,
  livemode: z.boolean(),
  amountMinor: signedMoneySchema,
  currency: financialCurrencySchema,
  automatic: z.boolean(),
  method: z.enum(['standard', 'instant', 'unknown']),
  status: z.enum(['pending', 'in_transit', 'paid', 'failed', 'canceled']),
  reconciliationStatus: z.enum(['in_progress', 'completed', 'not_applicable']),
  createdAt: dateSchema,
  arrivalAt: dateSchema,
  balanceTransactionId: providerIdSchema.nullable(),
  failureBalanceTransactionId: providerIdSchema.nullable(),
  originalPayoutId: providerIdSchema.nullable(),
  reversedByPayoutId: providerIdSchema.nullable(),
  safeFailureCode: safeFailureCodeSchema.nullable()
}).superRefine((value, context) => {
  if (
    value.balanceTransactionId !== null &&
    value.balanceTransactionId === value.failureBalanceTransactionId
  ) {
    context.addIssue({ code: 'custom', path: ['failureBalanceTransactionId'], message: 'duplicate payout balance transaction' });
  }
  for (const field of ['originalPayoutId', 'reversedByPayoutId'] as const) {
    if (value[field] === value.id) {
      context.addIssue({ code: 'custom', path: [field], message: 'payout cannot reference itself' });
    }
  }
  if (
    value.reconciliationStatus !== 'not_applicable' &&
    (!value.automatic || value.method !== 'standard')
  ) {
    context.addIssue({ code: 'custom', path: ['reconciliationStatus'], message: 'unsupported payout reconciliation' });
  }
}) satisfies ZodType<PayoutSnapshot>;

const stripePageRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(FINANCIAL_PAGE_SIZE),
  startingAfter: providerIdSchema.optional(),
  createdGte: unixSecondsSchema.optional(),
  createdLt: unixSecondsSchema.optional()
}).refine(
  (value) => value.createdGte === undefined || value.createdLt === undefined ||
    value.createdGte < value.createdLt,
  { path: ['createdLt'], message: 'invalid created range' }
);

function parseCanonical<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw permanentStripeFailure(parsed.error);
  return parsed.data;
}

export function parseFinancialProviderId(value: unknown): string {
  return parseCanonical(providerIdSchema, value);
}

function assertExpectedLivemode<Value extends { livemode: boolean }>(
  value: Value,
  expectedLiveMode: boolean
): Value {
  if (value.livemode !== expectedLiveMode) throw permanentStripeFailure();
  return value;
}

export function parseChargeSnapshot(value: unknown, expectedLiveMode: boolean): ChargeSnapshot {
  return assertExpectedLivemode(parseCanonical(chargeSnapshotSchema, value), expectedLiveMode);
}

export function parseBalanceTransactionSnapshot(
  value: unknown,
  expectedLiveMode: boolean
): BalanceTransactionSnapshot {
  return assertExpectedLivemode(
    parseCanonical(balanceTransactionSnapshotSchema, value),
    expectedLiveMode
  );
}

export function parsePayoutSnapshot(value: unknown, expectedLiveMode: boolean): PayoutSnapshot {
  return assertExpectedLivemode(parseCanonical(payoutSnapshotSchema, value), expectedLiveMode);
}

export function parseStripePageRequest(value: unknown): StripePageRequest {
  const parsed = parseCanonical(stripePageRequestSchema, value);
  return {
    limit: parsed.limit,
    ...(parsed.startingAfter === undefined ? {} : { startingAfter: parsed.startingAfter }),
    ...(parsed.createdGte === undefined ? {} : { createdGte: parsed.createdGte }),
    ...(parsed.createdLt === undefined ? {} : { createdLt: parsed.createdLt })
  };
}

export function parseStripeListPage<Value>(
  value: unknown,
  itemParser: (item: unknown) => Value
): StripeListPage<Value> {
  const shape = parseCanonical(z.strictObject({
    data: z.array(z.unknown()).max(FINANCIAL_PAGE_SIZE),
    hasMore: z.boolean(),
    nextStartingAfter: providerIdSchema.nullable()
  }), value);
  if (shape.hasMore !== (shape.nextStartingAfter !== null)) throw permanentStripeFailure();
  return {
    data: shape.data.map((item) => itemParser(item)),
    hasMore: shape.hasMore,
    nextStartingAfter: shape.nextStartingAfter
  };
}
