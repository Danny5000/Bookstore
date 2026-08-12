import { z } from 'zod';
import { permanentStripeFailure } from './errors';
import {
  parseBalanceTransactionSnapshot,
  parseChargeSnapshot,
  parsePayoutSnapshot,
  parseStripeListPage
} from './financial-schemas';
import {
  normalizeDisputeReason,
  normalizeDisputeState,
  normalizeRefundReason,
  normalizeRefundState,
  parseDisputeSnapshot,
  parseRefundSnapshot,
  providerIdSchema
} from './schemas';
import type {
  BalanceTransactionSnapshot,
  ChargeSnapshot,
  DisputeSnapshot,
  PayoutSnapshot,
  RefundSnapshot,
  StripeListPage,
  StripePageRequest
} from './types';

const unixSecondsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const idObjectSchema = z.object({ id: providerIdSchema });
const idReferenceSchema = z.union([providerIdSchema, idObjectSchema]);
const nullableIdReferenceSchema = idReferenceSchema.nullable();

const rawChargeSchema = z.object({
  id: providerIdSchema,
  payment_intent: nullableIdReferenceSchema,
  livemode: z.boolean(),
  amount: z.number(),
  amount_refunded: z.number(),
  currency: z.string(),
  status: z.string(),
  balance_transaction: nullableIdReferenceSchema,
  created: unixSecondsSchema
});

const rawRefundSchema = z.object({
  id: providerIdSchema,
  payment_intent: nullableIdReferenceSchema,
  status: z.string().nullable(),
  amount: z.number(),
  currency: z.string(),
  reason: z.string().nullable(),
  created: unixSecondsSchema,
  balance_transaction: nullableIdReferenceSchema,
  failure_balance_transaction: nullableIdReferenceSchema.optional()
});

const rawDisputeSchema = z.object({
  id: providerIdSchema,
  payment_intent: nullableIdReferenceSchema,
  charge: idReferenceSchema,
  livemode: z.boolean(),
  status: z.string(),
  amount: z.number(),
  currency: z.string(),
  reason: z.string().nullable(),
  created: unixSecondsSchema,
  balance_transactions: z.array(idObjectSchema)
});

const rawBalanceTransactionSourceSchema = z.union([
  providerIdSchema,
  z.object({
    id: providerIdSchema,
    object: z.string().min(1).max(100),
    currency: z.string().optional()
  })
]).nullable();

const rawBalanceTransactionSchema = z.object({
  id: providerIdSchema,
  amount: z.number(),
  available_on: unixSecondsSchema,
  balance_type: z.string(),
  created: unixSecondsSchema,
  currency: z.string(),
  exchange_rate: z.string().nullable(),
  fee: z.number(),
  fee_details: z.array(z.object({
    amount: z.number(),
    currency: z.string(),
    type: z.string()
  })),
  net: z.number(),
  reporting_category: z.string(),
  source: rawBalanceTransactionSourceSchema,
  status: z.string(),
  type: z.string()
});

const rawPayoutSchema = z.object({
  id: providerIdSchema,
  livemode: z.boolean(),
  amount: z.number(),
  currency: z.string(),
  automatic: z.boolean(),
  method: z.string(),
  status: z.string(),
  reconciliation_status: z.string(),
  created: unixSecondsSchema,
  arrival_date: unixSecondsSchema,
  balance_transaction: nullableIdReferenceSchema,
  failure_balance_transaction: nullableIdReferenceSchema,
  original_payout: nullableIdReferenceSchema,
  reversed_by: nullableIdReferenceSchema,
  failure_code: z.string().nullable()
});

const rawFinancialPageSchema = z.object({
  data: z.array(z.unknown()).max(100),
  has_more: z.boolean()
});

function parseProvider<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw permanentStripeFailure(parsed.error);
  return parsed.data;
}

function unixDate(value: number): Date {
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) throw permanentStripeFailure();
  return date;
}

function referencedId(value: z.output<typeof idReferenceSchema> | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : value.id;
}

function requireReferencedId(value: z.output<typeof nullableIdReferenceSchema>): string {
  const id = referencedId(value);
  if (!id) throw permanentStripeFailure();
  return id;
}

function financialCurrency(value: string): string {
  return value.toUpperCase();
}

function transactionSourceId(
  source: z.output<typeof rawBalanceTransactionSourceSchema>
): string | null {
  if (source === null) return null;
  return typeof source === 'string' ? source : source.id;
}

function transactionSourceFamily(
  source: z.output<typeof rawBalanceTransactionSourceSchema>
): BalanceTransactionSnapshot['sourceFamily'] {
  if (source === null || typeof source === 'string') return 'unknown';
  if (
    source.object === 'charge' ||
    source.object === 'refund' ||
    source.object === 'dispute' ||
    source.object === 'payout'
  ) return source.object;
  return 'unknown';
}

function payoutMethod(value: string): PayoutSnapshot['method'] {
  return value === 'standard' || value === 'instant' ? value : 'unknown';
}

export function mapSdkCharge(value: unknown, expectedLiveMode: boolean): ChargeSnapshot {
  const charge = parseProvider(rawChargeSchema, value);
  return parseChargeSnapshot({
    id: charge.id,
    paymentIntentId: requireReferencedId(charge.payment_intent),
    livemode: charge.livemode,
    amountMinor: charge.amount,
    amountRefundedMinor: charge.amount_refunded,
    currency: financialCurrency(charge.currency),
    status: charge.status,
    balanceTransactionId: referencedId(charge.balance_transaction),
    createdAt: unixDate(charge.created)
  }, expectedLiveMode);
}

export function mapSdkRefund(value: unknown, expectedLiveMode: boolean): RefundSnapshot {
  const refund = parseProvider(rawRefundSchema, value);
  if (!refund.status) throw permanentStripeFailure();
  return parseRefundSnapshot({
    providerRefundId: refund.id,
    paymentIntentId: requireReferencedId(refund.payment_intent),
    liveMode: expectedLiveMode,
    state: normalizeRefundState(refund.status),
    amountMinor: refund.amount,
    currency: refund.currency,
    reason: normalizeRefundReason(refund.reason),
    providerCreatedAt: unixDate(refund.created),
    balanceTransactionId: referencedId(refund.balance_transaction),
    failureBalanceTransactionId: referencedId(refund.failure_balance_transaction ?? null)
  });
}

export function mapSdkDispute(value: unknown, expectedLiveMode: boolean): DisputeSnapshot {
  const dispute = parseProvider(rawDisputeSchema, value);
  if (dispute.livemode !== expectedLiveMode) throw permanentStripeFailure();
  return parseDisputeSnapshot({
    providerDisputeId: dispute.id,
    paymentIntentId: requireReferencedId(dispute.payment_intent),
    chargeId: requireReferencedId(dispute.charge),
    liveMode: dispute.livemode,
    state: normalizeDisputeState(dispute.status),
    amountMinor: dispute.amount,
    currency: dispute.currency,
    reason: normalizeDisputeReason(dispute.reason),
    providerCreatedAt: unixDate(dispute.created),
    balanceTransactionIds: dispute.balance_transactions.map((transaction) => transaction.id)
  });
}

export function mapSdkBalanceTransaction(
  value: unknown,
  expectedLiveMode: boolean
): BalanceTransactionSnapshot {
  const transaction = parseProvider(rawBalanceTransactionSchema, value);
  let exchangeSourceCurrency: string | null = null;
  let exchangeTargetCurrency: string | null = null;
  if (transaction.exchange_rate !== null) {
    if (
      transaction.source === null ||
      typeof transaction.source === 'string' ||
      transaction.source.currency === undefined
    ) throw permanentStripeFailure();
    exchangeSourceCurrency = financialCurrency(transaction.source.currency);
    exchangeTargetCurrency = financialCurrency(transaction.currency);
  }
  return parseBalanceTransactionSnapshot({
    id: transaction.id,
    livemode: expectedLiveMode,
    sourceId: transactionSourceId(transaction.source),
    sourceFamily: transactionSourceFamily(transaction.source),
    rawType: transaction.type,
    reportingCategory: transaction.reporting_category,
    amountMinor: transaction.amount,
    feeMinor: transaction.fee,
    netMinor: transaction.net,
    currency: financialCurrency(transaction.currency),
    status: transaction.status,
    balanceType: transaction.balance_type,
    createdAt: unixDate(transaction.created),
    availableAt: unixDate(transaction.available_on),
    exchangeRate: transaction.exchange_rate,
    exchangeSourceCurrency,
    exchangeTargetCurrency,
    feeDetails: transaction.fee_details.map((detail, ordinal) => ({
      ordinal,
      rawType: detail.type,
      amountMinor: detail.amount,
      currency: financialCurrency(detail.currency)
    }))
  }, expectedLiveMode);
}

export function mapSdkPayout(value: unknown, expectedLiveMode: boolean): PayoutSnapshot {
  const payout = parseProvider(rawPayoutSchema, value);
  return parsePayoutSnapshot({
    id: payout.id,
    livemode: payout.livemode,
    amountMinor: payout.amount,
    currency: financialCurrency(payout.currency),
    automatic: payout.automatic,
    method: payoutMethod(payout.method),
    status: payout.status,
    reconciliationStatus: payout.reconciliation_status,
    createdAt: unixDate(payout.created),
    arrivalAt: unixDate(payout.arrival_date),
    balanceTransactionId: referencedId(payout.balance_transaction),
    failureBalanceTransactionId: referencedId(payout.failure_balance_transaction),
    originalPayoutId: referencedId(payout.original_payout),
    reversedByPayoutId: referencedId(payout.reversed_by),
    safeFailureCode: payout.failure_code
  }, expectedLiveMode);
}

export function balanceTransactionRetrievePath(id: string): string {
  const query = new URLSearchParams();
  query.append('expand[]', 'source');
  return `/v1/balance_transactions/${encodeURIComponent(id)}?${query.toString()}`;
}

export function balanceTransactionListPath(
  request: StripePageRequest,
  filter: { source: string } | { payout: string }
): string {
  const query = new URLSearchParams();
  query.set('limit', String(request.limit));
  if (request.startingAfter !== undefined) query.set('starting_after', request.startingAfter);
  if (request.createdGte !== undefined) query.set('created[gte]', String(request.createdGte));
  if (request.createdLt !== undefined) query.set('created[lt]', String(request.createdLt));
  if ('source' in filter) query.set('source', filter.source);
  else query.set('payout', filter.payout);
  query.append('expand[]', 'data.source');
  return `/v1/balance_transactions?${query.toString()}`;
}

export function mapSdkFinancialPage<Value extends { id: string }>(
  rawPage: unknown,
  request: StripePageRequest,
  mapper: (value: unknown) => Value,
  parser: (value: unknown) => Value
): StripeListPage<Value> {
  const page = parseProvider(rawFinancialPageSchema, rawPage);
  if (page.data.length > request.limit) throw permanentStripeFailure();
  const data = page.data.map(mapper);
  const ids = new Set<string>();
  for (const item of data) {
    if (ids.has(item.id) || item.id === request.startingAfter) throw permanentStripeFailure();
    ids.add(item.id);
  }
  const nextStartingAfter = page.has_more ? data.at(-1)?.id ?? null : null;
  if (
    page.has_more &&
    (nextStartingAfter === null || nextStartingAfter === request.startingAfter)
  ) throw permanentStripeFailure();
  return parseStripeListPage({
    data,
    hasMore: page.has_more,
    nextStartingAfter
  }, parser);
}

export function mapSdkBalanceTransactionPage(
  rawPage: unknown,
  request: StripePageRequest,
  expectedLiveMode: boolean
): StripeListPage<BalanceTransactionSnapshot> {
  return mapSdkFinancialPage(
    rawPage,
    request,
    (value) => mapSdkBalanceTransaction(value, expectedLiveMode),
    (value) => parseBalanceTransactionSnapshot(value, expectedLiveMode)
  );
}

export function mapSdkPayoutPage(
  rawPage: unknown,
  request: StripePageRequest,
  expectedLiveMode: boolean
): StripeListPage<PayoutSnapshot> {
  return mapSdkFinancialPage(
    rawPage,
    request,
    (value) => mapSdkPayout(value, expectedLiveMode),
    (value) => parsePayoutSnapshot(value, expectedLiveMode)
  );
}
