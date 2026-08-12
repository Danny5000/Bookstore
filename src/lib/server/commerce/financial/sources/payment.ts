import { and, eq, sql, type SQL } from 'drizzle-orm';
import { appendAuditEvent } from '$lib/server/audit/service';
import { PermanentCommerceError, RetryableProviderError } from '$lib/server/commerce/errors';
import { lockOrder } from '$lib/server/commerce/lock';
import { lockPaymentPurchaseFacts, type PaymentPurchaseFacts } from '$lib/server/commerce/reconciliation';
import { parseChargeSnapshot } from '$lib/server/commerce/stripe/financial-schemas';
import { parsePaymentSnapshot } from '$lib/server/commerce/stripe/schemas';
import type {
  BalanceTransactionSnapshot,
  ChargeSnapshot,
  PaymentSnapshot,
  StripeCommerceGateway
} from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import { orders, payments } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { buildChargeAllocationPlan } from '../allocations/charge';
import {
  loadCurrentEffectiveAllocationProjection,
  persistFinancialAllocationPlanLocked
} from '../allocations/repository';
import {
  FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  FINANCIAL_CLASSIFIER_VERSION
} from '../constants';
import { PermanentFinancialError, RetryableFinancialError } from '../errors';
import { observeFinancialIssue, resolveFinancialIssueAfterRecompute } from '../issues';
import { stageBalanceTransaction } from '../ledger';
import { lockFinancialProjectionRows } from '../locks';
import type {
  FinancialEvidenceStatus,
  FinancialIssueCode,
  FinancialIssueImpact,
  FinancialSourceResult
} from '../types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISSUE_CODES: readonly FinancialIssueCode[] = [
  'allocation_fork', 'allocation_incomplete', 'allocation_mismatch', 'classification_fork',
  'correction_rebase_required', 'currency_mismatch', 'immutable_mismatch', 'missing_source',
  'source_linkage_mismatch', 'unsupported_category'
];
const ACTOR = { type: 'system', id: 'financial-worker' } as const;
const PAYMENT_SNAPSHOT_KEYS = [
  'paymentIntentId', 'metadataVersion', 'metadataOrderId', 'latestChargeId', 'liveMode', 'state',
  'amountMinor', 'currency', 'paidAt', 'paymentMethodCategory'
] as const;
const CHARGE_SNAPSHOT_KEYS = [
  'id', 'paymentIntentId', 'livemode', 'amountMinor', 'amountRefundedMinor', 'currency', 'status',
  'balanceTransactionId', 'createdAt'
] as const;

export function assertPaymentChargeProjectionConservation(input: {
  readonly grossExpectedEffectMinor: number;
  readonly feeExpectedEffectMinor: number;
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly netMinor: number;
}): void {
  if (!Number.isSafeInteger(input.grossExpectedEffectMinor) ||
    !Number.isSafeInteger(input.feeExpectedEffectMinor) ||
    !Number.isSafeInteger(input.amountMinor) || !Number.isSafeInteger(input.feeMinor) ||
    !Number.isSafeInteger(input.netMinor) || input.grossExpectedEffectMinor !== input.amountMinor ||
    input.feeExpectedEffectMinor !== -input.feeMinor ||
    BigInt(input.grossExpectedEffectMinor) + BigInt(input.feeExpectedEffectMinor) !== BigInt(input.netMinor)) {
    throw new PermanentFinancialError('allocation_mismatch');
  }
}

interface RoutingFacts {
  readonly id: string;
  readonly orderId: string;
  readonly stripePaymentIntentId: string;
  readonly stripeLatestChargeId: string | null;
  readonly paymentStatus: string;
  readonly orderStatus: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly paidAt: Date | null;
  readonly paymentMethodCategory: string | null;
  readonly orderTotalMinor: number | null;
  readonly orderCurrency: string;
  readonly orderPaidAt: Date | null;
}

class LockedProjectionIssue extends Error {
  constructor(
    readonly safeCode: FinancialIssueCode,
    readonly impact: FinancialIssueImpact,
    readonly pendingResultCode: 'allocation_incomplete' | 'missing_source'
  ) {
    super('The locked financial projection requires a durable issue.');
    this.name = 'LockedProjectionIssue';
  }
}

export interface CanonicalPaymentPurchaseLockInput {
  readonly paymentId: string;
  readonly orderId: string;
  readonly payment: PaymentSnapshot;
  readonly charge: ChargeSnapshot;
}

type QueryResult = { rows?: unknown[] };

async function rows(tx: DatabaseTransaction, query: SQL): Promise<unknown[]> {
  return ((await tx.execute(query)) as QueryResult).rows ?? [];
}

function invalidPayload(): never {
  throw new PermanentFinancialError('invalid_job_payload');
}

function stateChanged(): never {
  throw new RetryableFinancialError('state_changed');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Financial source reconciliation was aborted.', 'AbortError');
}

function normalizedDecimal(value: string | null): string | null {
  if (value === null) return null;
  const [integer = '', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/u, '');
  return trimmed.length === 0 ? integer : `${integer}.${trimmed}`;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function sameTime(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null : right !== null && left.getTime() === right.getTime();
}

function assertJobInput(input: unknown, signal: unknown): asserts input is { paymentId: string; correlationId: string } {
  if (!exactObject(input, ['paymentId', 'correlationId']) ||
    typeof input.paymentId !== 'string' || !UUID.test(input.paymentId) ||
    typeof input.correlationId !== 'string' || input.correlationId.length < 1 || input.correlationId.length > 100 ||
    typeof AbortSignal === 'undefined' || !(signal instanceof AbortSignal)) invalidPayload();
}

function validatePaymentIntent(
  routing: RoutingFacts,
  payment: PaymentSnapshot
): FinancialIssueCode | null {
  if (payment.paymentIntentId !== routing.stripePaymentIntentId || payment.metadataVersion !== '1' ||
    payment.metadataOrderId !== routing.orderId ||
    (payment.latestChargeId !== null && payment.latestChargeId !== routing.stripeLatestChargeId)) {
    return 'source_linkage_mismatch';
  }
  if (payment.currency.toUpperCase() !== routing.currency || routing.orderCurrency !== routing.currency) {
    return 'currency_mismatch';
  }
  if (payment.amountMinor !== routing.amountMinor || routing.orderTotalMinor !== routing.amountMinor ||
    (payment.paidAt !== null && (!sameTime(payment.paidAt, routing.paidAt) ||
      !sameTime(payment.paidAt, routing.orderPaidAt))) ||
    (payment.paymentMethodCategory !== null && payment.paymentMethodCategory !== routing.paymentMethodCategory)) {
    return 'immutable_mismatch';
  }
  return null;
}

function validateCharge(
  payment: PaymentSnapshot,
  charge: ChargeSnapshot
): FinancialIssueCode | null {
  if (payment.latestChargeId !== charge.id || charge.paymentIntentId !== payment.paymentIntentId) {
    return 'source_linkage_mismatch';
  }
  if (payment.currency.toUpperCase() !== charge.currency) return 'currency_mismatch';
  if (payment.paidAt === null || payment.liveMode !== charge.livemode ||
    payment.amountMinor !== charge.amountMinor || payment.paidAt.getTime() !== charge.createdAt.getTime()) {
    return 'immutable_mismatch';
  }
  return null;
}

function prevalidateProvider(
  routing: RoutingFacts,
  payment: PaymentSnapshot,
  charge: ChargeSnapshot,
  balance: BalanceTransactionSnapshot
): FinancialIssueCode | null {
  const paymentMismatch = validatePaymentIntent(routing, payment);
  if (paymentMismatch) return paymentMismatch;
  const chargeMismatch = validateCharge(payment, charge);
  if (chargeMismatch) return chargeMismatch;
  if (payment.latestChargeId !== routing.stripeLatestChargeId ||
    charge.balanceTransactionId !== balance.id || balance.sourceFamily !== 'charge' || balance.sourceId !== charge.id) {
    return 'source_linkage_mismatch';
  }
  const hasExchangeEvidence = balance.exchangeRate !== null || balance.exchangeSourceCurrency !== null ||
    balance.exchangeTargetCurrency !== null;
  if (hasExchangeEvidence) {
    if (balance.exchangeRate === null || balance.exchangeSourceCurrency !== charge.currency ||
      balance.exchangeTargetCurrency !== balance.currency || charge.currency === balance.currency) {
      return 'currency_mismatch';
    }
  } else if (charge.currency !== balance.currency) return 'currency_mismatch';
  if (
    payment.state !== 'succeeded' || charge.status !== 'succeeded' || payment.paidAt === null ||
    charge.livemode !== balance.livemode ||
    (!hasExchangeEvidence && charge.amountMinor !== balance.amountMinor) ||
    charge.createdAt.getTime() !== balance.createdAt.getTime()
  ) return 'immutable_mismatch';
  return null;
}

function assertLockedCanonical(
  facts: PaymentPurchaseFacts,
  input: CanonicalPaymentPurchaseLockInput
): void {
  const local = facts.payment;
  const order = facts.order;
  const provider = input.payment;
  const charge = input.charge;
  if (
    local.id !== input.paymentId || local.orderId !== input.orderId || order.id !== input.orderId ||
    local.stripePaymentIntentId !== provider.paymentIntentId ||
    local.stripeLatestChargeId !== provider.latestChargeId || provider.latestChargeId !== charge.id ||
    charge.paymentIntentId !== provider.paymentIntentId ||
    provider.metadataVersion !== '1' || provider.metadataOrderId !== order.id ||
    provider.state !== 'succeeded' || charge.status !== 'succeeded' ||
    local.status !== 'succeeded' || order.status !== 'paid' ||
    provider.paidAt === null || local.paidAt === null || order.paidAt === null ||
    local.amountMinor !== provider.amountMinor || order.totalMinor !== provider.amountMinor ||
    local.currency !== provider.currency.toUpperCase() || order.currency !== local.currency ||
    local.paymentMethodCategory !== provider.paymentMethodCategory ||
    local.paidAt.getTime() !== provider.paidAt.getTime() ||
    order.paidAt.getTime() !== provider.paidAt.getTime() ||
    charge.amountMinor !== provider.amountMinor || charge.currency !== local.currency ||
    charge.createdAt.getTime() !== provider.paidAt.getTime()
  ) stateChanged();
}

function parseCanonicalPaymentPurchaseLockInput(value: unknown): CanonicalPaymentPurchaseLockInput {
  if (!exactObject(value, ['paymentId', 'orderId', 'payment', 'charge']) ||
    typeof value.paymentId !== 'string' || !UUID.test(value.paymentId) ||
    typeof value.orderId !== 'string' || !UUID.test(value.orderId) ||
    !exactObject(value.payment, PAYMENT_SNAPSHOT_KEYS) ||
    !exactObject(value.charge, CHARGE_SNAPSHOT_KEYS)) invalidPayload();
  try {
    const payment = parsePaymentSnapshot(value.payment);
    const charge = parseChargeSnapshot(value.charge, payment.liveMode);
    return { paymentId: value.paymentId, orderId: value.orderId, payment, charge };
  } catch (error) {
    if (error instanceof PermanentCommerceError) invalidPayload();
    throw error;
  }
}

/** Provider-event-independent order -> payment -> purchase-graph lock and canonical revalidation. */
export async function lockCanonicalPaymentPurchaseFacts(
  tx: DatabaseTransaction,
  input: CanonicalPaymentPurchaseLockInput
): Promise<PaymentPurchaseFacts> {
  const canonical = parseCanonicalPaymentPurchaseLockInput(input);
  await lockOrder(tx, canonical.orderId);
  const [order] = await tx.select().from(orders).where(eq(orders.id, canonical.orderId)).limit(1).for('update');
  const [payment] = await tx.select().from(payments).where(and(
    eq(payments.id, canonical.paymentId), eq(payments.orderId, canonical.orderId)
  )).limit(1).for('update');
  if (!order || !payment) stateChanged();
  let facts: PaymentPurchaseFacts;
  try {
    facts = await lockPaymentPurchaseFacts(tx, payment, order);
  } catch (error) {
    if (error instanceof PermanentCommerceError) stateChanged();
    throw error;
  }
  assertLockedCanonical(facts, canonical);
  return facts;
}

async function lockRoutingPurchaseFacts(tx: DatabaseTransaction, routing: RoutingFacts): Promise<PaymentPurchaseFacts> {
  await lockOrder(tx, routing.orderId);
  const [order] = await tx.select().from(orders).where(eq(orders.id, routing.orderId)).limit(1).for('update');
  const [payment] = await tx.select().from(payments).where(eq(payments.id, routing.id)).limit(1).for('update');
  if (!order || !payment || payment.orderId !== routing.orderId || order.id !== routing.orderId ||
    payment.stripePaymentIntentId !== routing.stripePaymentIntentId ||
    payment.stripeLatestChargeId !== routing.stripeLatestChargeId ||
    payment.status !== routing.paymentStatus || order.status !== routing.orderStatus ||
    payment.amountMinor !== routing.amountMinor || payment.currency !== routing.currency ||
    !sameTime(payment.paidAt, routing.paidAt) ||
    payment.paymentMethodCategory !== routing.paymentMethodCategory ||
    order.totalMinor !== routing.orderTotalMinor || order.currency !== routing.orderCurrency ||
    !sameTime(order.paidAt, routing.orderPaidAt)) stateChanged();
  try {
    return await lockPaymentPurchaseFacts(tx, payment, order);
  } catch (error) {
    if (error instanceof PermanentCommerceError) stateChanged();
    throw error;
  }
}

async function recordLockedIssue(
  tx: DatabaseTransaction,
  facts: PaymentPurchaseFacts,
  routing: RoutingFacts,
  correlationId: string,
  safeCode: FinancialIssueCode,
  impact: FinancialIssueImpact,
  pendingResultCode: 'allocation_incomplete' | 'missing_source' | 'provider_not_ready',
  signal?: AbortSignal
): Promise<FinancialSourceResult> {
  const issue = await observeFinancialIssue(tx, {
    resourceType: 'payment', resourceId: routing.id, safeCode, impact, actor: ACTOR, correlationId
  });
  const financialEvidenceStatus: FinancialEvidenceStatus = impact === 'pending' ? 'pending' : 'exception';
  if (facts.payment.financialEvidenceStatus !== financialEvidenceStatus) {
    await tx.update(payments).set({ financialEvidenceStatus }).where(eq(payments.id, routing.id));
  }
  if (signal) throwIfAborted(signal);
  return impact === 'pending'
    ? { status: 'pending', sourceKind: 'payment', sourceId: routing.id,
        financialEvidenceStatus: 'pending', safeCode: pendingResultCode, issueId: issue.id }
    : { status: 'exception', sourceKind: 'payment', sourceId: routing.id,
        financialEvidenceStatus: 'exception', safeCode, issueId: issue.id };
}

async function recordIssue(
  database: Database,
  routing: RoutingFacts,
  correlationId: string,
  safeCode: FinancialIssueCode,
  impact: FinancialIssueImpact,
  pendingResultCode: 'allocation_incomplete' | 'missing_source' | 'provider_not_ready' = 'missing_source',
  signal?: AbortSignal
): Promise<FinancialSourceResult> {
  if (signal) throwIfAborted(signal);
  return database.transaction(async (tx) => {
    if (signal) throwIfAborted(signal);
    const facts = await lockRoutingPurchaseFacts(tx, routing);
    return recordLockedIssue(
      tx, facts, routing, correlationId, safeCode, impact, pendingResultCode, signal
    );
  });
}

async function providerCall<Value>(signal: AbortSignal, work: () => Promise<Value>): Promise<Value> {
  throwIfAborted(signal);
  try {
    const value = await work();
    throwIfAborted(signal);
    return value;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof RetryableFinancialError) throw error;
    if (error instanceof RetryableProviderError) throw new RetryableFinancialError('provider_unavailable');
    if (error instanceof PermanentCommerceError) {
      throw new PermanentFinancialError('unsupported_provider_evidence');
    }
    throw new RetryableFinancialError('provider_unavailable');
  }
}

function projectionFailureCode(
  projections: Awaited<ReturnType<typeof loadCurrentEffectiveAllocationProjection>>
): { code: FinancialIssueCode; impact: FinancialIssueImpact } | null {
  for (const projection of projections) {
    if (projection.status === 'missing') return { code: projection.safeCode, impact: 'pending' };
    if (projection.status === 'exception') return { code: projection.safeCode, impact: 'exception' };
  }
  return null;
}

function durableIssueCode(error: unknown): FinancialIssueCode | null {
  if (!(error instanceof PermanentFinancialError)) return null;
  switch (error.safeCode) {
    case 'allocation_mismatch':
    case 'classification_fork':
    case 'correction_rebase_required':
    case 'currency_mismatch':
    case 'immutable_mismatch':
    case 'source_linkage_mismatch':
      return error.safeCode;
    case 'unsupported_provider_evidence':
      return 'immutable_mismatch';
    default:
      return null;
  }
}

export async function reconcilePaymentFinancialSource(
  database: Database,
  gateway: StripeCommerceGateway,
  input: { paymentId: string; correlationId: string },
  signal: AbortSignal
): Promise<FinancialSourceResult> {
  assertJobInput(input, signal);
  throwIfAborted(signal);
  const [routing] = await database.select({
    id: payments.id, orderId: payments.orderId, stripePaymentIntentId: payments.stripePaymentIntentId,
    stripeLatestChargeId: payments.stripeLatestChargeId,
    paymentStatus: payments.status, orderStatus: orders.status, amountMinor: payments.amountMinor,
    currency: payments.currency, paidAt: payments.paidAt,
    paymentMethodCategory: payments.paymentMethodCategory, orderTotalMinor: orders.totalMinor,
    orderCurrency: orders.currency, orderPaidAt: orders.paidAt
  }).from(payments).innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(payments.id, input.paymentId)).limit(1);
  throwIfAborted(signal);
  if (!routing || routing.paymentStatus !== 'succeeded' || routing.orderStatus !== 'paid' ||
    routing.stripeLatestChargeId === null) {
    throw new RetryableFinancialError('local_state_pending');
  }

  let providerPayment: PaymentSnapshot;
  try {
    providerPayment = await providerCall(signal, () => gateway.retrievePayment(routing.stripePaymentIntentId));
  } catch (error) {
    const safeCode = durableIssueCode(error);
    if (safeCode) return recordIssue(database, routing, input.correlationId, safeCode, 'exception', 'missing_source', signal);
    throw error;
  }
  const paymentMismatch = validatePaymentIntent(routing, providerPayment);
  if (paymentMismatch) {
    return recordIssue(database, routing, input.correlationId, paymentMismatch, 'exception', 'missing_source', signal);
  }
  if (providerPayment.state === 'failed') {
    return recordIssue(database, routing, input.correlationId, 'immutable_mismatch', 'exception', 'missing_source', signal);
  }
  if (providerPayment.state === 'pending' || providerPayment.paidAt === null || providerPayment.latestChargeId === null) {
    return recordIssue(database, routing, input.correlationId, 'missing_source', 'pending', 'provider_not_ready', signal);
  }
  let charge: ChargeSnapshot;
  try {
    charge = await providerCall(signal, () => gateway.retrieveCharge(providerPayment.latestChargeId!));
  } catch (error) {
    const safeCode = durableIssueCode(error);
    if (safeCode) return recordIssue(database, routing, input.correlationId, safeCode, 'exception', 'missing_source', signal);
    throw error;
  }
  const chargeMismatch = validateCharge(providerPayment, charge);
  if (chargeMismatch) {
    return recordIssue(database, routing, input.correlationId, chargeMismatch, 'exception', 'missing_source', signal);
  }
  if (charge.status === 'failed') {
    return recordIssue(database, routing, input.correlationId, 'immutable_mismatch', 'exception', 'missing_source', signal);
  }
  if (charge.status === 'pending' || charge.balanceTransactionId === null) {
    return recordIssue(database, routing, input.correlationId, 'missing_source', 'pending', 'provider_not_ready', signal);
  }
  let balance: BalanceTransactionSnapshot;
  try {
    balance = await providerCall(signal, () => gateway.retrieveBalanceTransaction(charge.balanceTransactionId!));
  } catch (error) {
    const safeCode = durableIssueCode(error);
    if (safeCode) return recordIssue(database, routing, input.correlationId, safeCode, 'exception', 'missing_source', signal);
    throw error;
  }
  throwIfAborted(signal);
  const mismatch = prevalidateProvider(routing, providerPayment, charge, balance);
  if (mismatch) return recordIssue(database, routing, input.correlationId, mismatch, 'exception', 'missing_source', signal);

  let staged: Awaited<ReturnType<typeof stageBalanceTransaction>>;
  try {
    staged = await stageBalanceTransaction(database, balance, { correlationId: input.correlationId });
  } catch (error) {
    const safeCode = durableIssueCode(error);
    if (safeCode) return recordIssue(database, routing, input.correlationId, safeCode, 'exception', 'missing_source', signal);
    throw error;
  }
  throwIfAborted(signal);

  const closureRows = (await database.execute(sql`
    select payout.id as "payoutId", payout.financial_generation as "expectedGeneration",
      member.balance_transaction_id as "balanceTransactionId"
    from stripe_payout_balance_transactions source_membership
    join stripe_payouts payout on payout.id = source_membership.payout_id
    join stripe_payout_balance_transactions member on member.payout_id = payout.id
    where source_membership.balance_transaction_id = ${staged.balanceTransactionId}
    order by payout.id, member.balance_transaction_id
  `) as QueryResult).rows as Array<{
    payoutId: string;
    expectedGeneration: number;
    balanceTransactionId: string;
  }> | undefined ?? [];
  const payoutGenerations = [...new Map(closureRows.map((row) => [row.payoutId, {
    payoutId: row.payoutId, expectedGeneration: row.expectedGeneration
  }])).values()].sort((left, right) => left.payoutId < right.payoutId ? -1 : left.payoutId > right.payoutId ? 1 : 0);
  const balanceTransactionIds = [...new Set([
    staged.balanceTransactionId, ...closureRows.map((row) => row.balanceTransactionId)
  ])].sort();
  throwIfAborted(signal);

  return database.transaction(async (tx) => {
    const facts = await lockCanonicalPaymentPurchaseFacts(tx, {
      paymentId: routing.id, orderId: routing.orderId, payment: providerPayment, charge
    });
    const lockRows = await lockFinancialProjectionRows(tx, {
      payoutGenerations,
      balanceTransactionIds,
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      issueKeys: ISSUE_CODES.map((safeCode) => ({ resourceType: 'payment' as const, resourceId: routing.id, safeCode }))
    });
    const lockedBalance = lockRows.balanceTransactions.find((row) => row.id === staged.balanceTransactionId);
    if (!lockedBalance) stateChanged();
    const [lockedCanonicalBalance] = await rows(tx, sql`
      select provider_id as "providerId", live_mode as "liveMode", source_family as "sourceFamily",
        source_id as "sourceId", amount_minor as "amountMinor", fee_minor as "feeMinor",
        net_minor as "netMinor", currency, status, provider_created_at as "createdAt",
        exchange_rate as "exchangeRate", exchange_source_currency as "exchangeSourceCurrency",
        exchange_target_currency as "exchangeTargetCurrency", fingerprint_sha256 as "fingerprintSha256"
      from stripe_balance_transactions where id = ${staged.balanceTransactionId} for update
    `) as Array<{ providerId: string; liveMode: boolean; sourceFamily: string; sourceId: string | null;
      amountMinor: number; feeMinor: number; netMinor: number; currency: string; status: string;
      createdAt: Date; exchangeRate: string | null; exchangeSourceCurrency: string | null;
      exchangeTargetCurrency: string | null; fingerprintSha256: string }>;
    if (!lockedCanonicalBalance || lockedCanonicalBalance.providerId !== balance.id ||
      lockedCanonicalBalance.liveMode !== balance.livemode || lockedCanonicalBalance.sourceFamily !== 'charge' ||
      lockedCanonicalBalance.sourceId !== charge.id || lockedCanonicalBalance.amountMinor !== balance.amountMinor ||
      lockedCanonicalBalance.feeMinor !== balance.feeMinor || lockedCanonicalBalance.netMinor !== balance.netMinor ||
      lockedCanonicalBalance.currency !== balance.currency || lockedCanonicalBalance.status !== balance.status ||
      new Date(lockedCanonicalBalance.createdAt).getTime() !== balance.createdAt.getTime() ||
      normalizedDecimal(lockedCanonicalBalance.exchangeRate) !== normalizedDecimal(balance.exchangeRate) ||
      lockedCanonicalBalance.exchangeSourceCurrency !== balance.exchangeSourceCurrency ||
      lockedCanonicalBalance.exchangeTargetCurrency !== balance.exchangeTargetCurrency ||
      lockedCanonicalBalance.fingerprintSha256 !== lockedBalance.fingerprintSha256) stateChanged();
    const detailRows = await rows(tx, sql`
      select detail.id, detail.amount_minor as "amountMinor", classification.classification
      from stripe_balance_transaction_fee_details detail
      left join financial_classification_versions classification
        on classification.subject_type = 'fee_detail' and classification.subject_id = detail.id
        and classification.classifier_version = ${FINANCIAL_CLASSIFIER_VERSION}
        and classification.source_fingerprint_sha256 = detail.fingerprint_sha256
      where detail.balance_transaction_id = ${staged.balanceTransactionId}
      order by detail.ordinal
    `) as Array<{ id: string; amountMinor: number; classification: string | null }>;
    const parentClassifications = lockRows.classifications.filter((row) =>
      row.subjectType === 'balance_transaction' && row.subjectId === staged.balanceTransactionId
    );
    if (parentClassifications.length !== 1 || parentClassifications[0]?.classification !== 'charge' ||
      detailRows.some((row) => row.classification === null || row.classification === 'unknown')) {
      return recordLockedIssue(
        tx, facts, routing, input.correlationId, 'unsupported_category', 'exception', 'missing_source', signal
      );
    }
    const projectionOutcome = await (async () => {
      try {
        const value = await tx.transaction(async (projectionTx) => {
          const componentByClassification = {
            processing_fee: 'processing_fee', provider_fee_tax: 'provider_fee_tax',
            fee_credit: 'fee_credit', other: 'other'
          } as const;
          const feeDetails = detailRows.map((row) => {
            const component = componentByClassification[row.classification as keyof typeof componentByClassification];
            if (!component) throw new PermanentFinancialError('unsupported_provider_evidence');
            return { amountMinor: -row.amountMinor, component };
          });
          const { plans } = buildChargeAllocationPlan({
            sourceKind: 'payment', sourceId: routing.id, balanceTransactionId: staged.balanceTransactionId,
            allocationIdentityPrefix: `payment:${routing.id}:${staged.balanceTransactionId}`,
            settlementCurrency: balance.currency, amountMinor: balance.amountMinor, feeMinor: balance.feeMinor,
            netMinor: balance.netMinor, sourceFingerprint: lockedBalance.fingerprintSha256,
            algorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
            supersedesGrossSetId: null, supersedesFeeSetId: null,
            items: facts.orderItems.map((item) => ({ orderItemId: item.id,
              subtotalMinor: item.unitSubtotalMinor, taxMinor: item.taxMinor!, presentmentCurrency: item.currency })),
            feeDetails
          });
          const persisted = [] as Array<{ setId: string; disposition: 'inserted' | 'unchanged' }>;
          for (const plan of plans) persisted.push(await persistFinancialAllocationPlanLocked(projectionTx, {
            plan, sourceKind: 'payment', sourceId: routing.id,
            classificationVersion: FINANCIAL_CLASSIFIER_VERSION, correlationId: input.correlationId
          }));
          const projections = await loadCurrentEffectiveAllocationProjection(projectionTx, {
            balanceTransactionIds: [staged.balanceTransactionId]
          });
          if (projections.length !== 2) throw new PermanentFinancialError('allocation_mismatch');
          const failure = projectionFailureCode(projections);
          if (failure) {
            throw new LockedProjectionIssue(
              failure.code,
              failure.impact,
              failure.code === 'allocation_incomplete' ? 'allocation_incomplete' : 'missing_source'
            );
          }
          const [gross, fee] = projections;
          if (!gross || !fee || gross.status !== 'complete' || fee.status !== 'complete' ||
            gross.basis !== 'gross_amount' || fee.basis !== 'fee' || gross.currency !== balance.currency ||
            fee.currency !== balance.currency) throw new PermanentFinancialError('allocation_mismatch');
          assertPaymentChargeProjectionConservation({
            grossExpectedEffectMinor: gross.expectedEffectMinor,
            feeExpectedEffectMinor: fee.expectedEffectMinor,
            amountMinor: balance.amountMinor,
            feeMinor: balance.feeMinor,
            netMinor: balance.netMinor
          });
          return { persisted, gross, fee };
        });
        return { kind: 'complete' as const, value };
      } catch (error) {
        if (error instanceof LockedProjectionIssue) {
          const result = await recordLockedIssue(tx, facts, routing, input.correlationId, error.safeCode,
            error.impact, error.pendingResultCode, signal);
          return { kind: 'issue' as const, result };
        }
        const safeCode = durableIssueCode(error);
        if (safeCode) {
          const result = await recordLockedIssue(
            tx, facts, routing, input.correlationId, safeCode, 'exception', 'missing_source', signal
          );
          return { kind: 'issue' as const, result };
        }
        throw error;
      }
    })();
    if (projectionOutcome.kind === 'issue') return projectionOutcome.result;
    const { persisted, gross, fee } = projectionOutcome.value;
    const resolvedIssueIds: string[] = [];
    for (const safeCode of ISSUE_CODES) {
      const resolved = await resolveFinancialIssueAfterRecompute(tx, {
        resourceType: 'payment', resourceId: routing.id, safeCode,
        proof: { status: 'resolved', resourceType: 'payment', resourceId: routing.id, safeCode },
        actor: ACTOR, correlationId: input.correlationId
      });
      if (resolved) resolvedIssueIds.push(resolved.id);
    }
    const changed = facts.payment.financialEvidenceStatus !== 'fee_reconciled' ||
      persisted.some((value) => value.disposition === 'inserted') || resolvedIssueIds.length > 0;
    if (facts.payment.financialEvidenceStatus !== 'fee_reconciled') {
      await tx.update(payments).set({ financialEvidenceStatus: 'fee_reconciled' }).where(eq(payments.id, routing.id));
    }
    if (!changed) {
      throwIfAborted(signal);
      return { status: 'unchanged', sourceKind: 'payment', sourceId: routing.id,
        financialEvidenceStatus: 'fee_reconciled' };
    }
    await appendAuditEvent(tx, {
      actor: ACTOR, action: 'financial.payment_reconciled', outcome: 'succeeded',
      resourceType: 'payment', resourceId: routing.id, correlationId: input.correlationId,
      after: { paymentId: routing.id, orderId: routing.orderId, financialEvidenceStatus: 'fee_reconciled',
        settlementCurrency: balance.currency, amountMinor: balance.amountMinor, feeMinor: balance.feeMinor,
        netMinor: balance.netMinor, grossAllocationCount: gross.items.length, feeAllocationCount: fee.items.length }
    });
    throwIfAborted(signal);
    return { status: 'reconciled', sourceKind: 'payment', sourceId: routing.id,
      financialEvidenceStatus: 'fee_reconciled', allocationSetIds: persisted.map((value) => value.setId),
      issueIds: resolvedIssueIds };
  });
}
