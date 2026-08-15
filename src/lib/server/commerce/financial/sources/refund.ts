import { and, eq, sql, type SQL } from 'drizzle-orm';
import { appendAuditEvent } from '$lib/server/audit/service';
import { PermanentCommerceError, RetryableProviderError } from '$lib/server/commerce/errors';
import { lockOrder } from '$lib/server/commerce/lock';
import { lockPaymentPurchaseFacts } from '$lib/server/commerce/reconciliation';
import { lockCanonicalPaymentPurchaseFacts } from './payment';
import {
  parseBalanceTransactionSnapshot,
  parseChargeSnapshot
} from '$lib/server/commerce/stripe/financial-schemas';
import {
  parsePaymentSnapshot,
  parseRefundSnapshot
} from '$lib/server/commerce/stripe/schemas';
import type {
  BalanceTransactionSnapshot,
  ChargeSnapshot,
  PaymentSnapshot,
  RefundSnapshot,
  StripeCommerceGateway
} from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import { disputes, orders, payments, refunds } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { allocateFeeDetails, basePlan } from '../allocations/common';
import { buildFailedRefundAllocationPlan, buildRefundAllocationPlan } from '../allocations/refund';
import { compareFinancialExposureChronology } from '../allocations/exposure';
import {
  loadCurrentEffectiveAllocationProjection,
  persistFinancialAllocationReplayPlanLocked
} from '../allocations/repository';
import type {
  BoundDisputePresentmentEffect,
  ClassifiedFeeDetail,
  EarlierFinalizedRefundComponent
} from '../allocations/types';
import {
  FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  FINANCIAL_CLASSIFIER_VERSION,
  FINANCIAL_REPLAY_ID
} from '../constants';
import { PermanentFinancialError, RetryableFinancialError } from '../errors';
import { observeFinancialIssue, resolveFinancialIssueAfterRecompute } from '../issues';
import {
  lockActiveFinancialProjectionImplementation,
  lockFinancialProjectionRows
} from '../locks';
import {
  rearmCurrentProjectionSubjectsForFinancialSources,
  stageBalanceTransaction
} from '../ledger';
import { lockFinancialProjectionEnrollment } from '../rebase';
import type {
  FinancialAllocationPlan,
  FinancialIssueCode,
  FinancialIssueImpact,
  FinancialSourceResult,
  LockedRefundProjectionInput,
  RefundFinancialRecomputeResult
} from '../types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const SAFE_MONEY = 99_999_999;
const ACTOR = { type: 'system', id: 'financial-worker' } as const;
const ISSUE_CODES: readonly FinancialIssueCode[] = [
  'allocation_fork', 'allocation_incomplete', 'allocation_mismatch', 'classification_fork',
  'correction_rebase_required', 'currency_mismatch', 'immutable_mismatch', 'missing_source',
  'source_linkage_mismatch', 'unsupported_category'
];
const ORDINARY_REFUND_SET_ISSUE_CODES: readonly FinancialIssueCode[] = ISSUE_CODES;
const LOCKED_REFUND_KEYS = [
  'orderId', 'paymentId', 'refundId', 'providerStatus', 'allocationStatus', 'amountMinor',
  'currency', 'balanceTransactionIds', 'orderItems', 'finalizedAllocations',
  'refundComponents', 'correlationId'
] as const;
const ORDER_ITEM_KEYS = ['id', 'subtotalMinor', 'taxMinor', 'totalMinor', 'currency'] as const;
const ALLOCATION_KEYS = ['id', 'orderItemId', 'amountMinor'] as const;
const COMPONENT_KEYS = [
  'refundAllocationId', 'orderItemId', 'subtotalMinor', 'taxMinor', 'currency'
] as const;
const REPLAY_VERSION_KEYS = [
  'classifierVersion', 'allocationAlgorithmVersion', 'replayId'
] as const;

type QueryResult = { rows?: unknown[] };

interface LockedBalanceRow {
  readonly id: string;
  readonly providerId: string;
  readonly sourceFamily: string;
  readonly sourceId: string | null;
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly netMinor: number;
  readonly currency: string;
  readonly fingerprintSha256: string;
  readonly providerCreatedAt: Date;
  readonly classification: string | null;
}

interface RefundHistoryRow {
  readonly refundId: string;
  readonly providerRefundId: string;
  readonly providerCreatedAt: Date;
  readonly refundStatus: string;
  readonly allocationStatus: string;
  readonly refundAllocationId: string;
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly currency: string;
}

interface DisputeExposureHistoryRow {
  readonly allocationId: string;
  readonly withdrawalSetId: string;
  readonly disputeId: string;
  readonly providerCreatedAt: Date;
  readonly providerTransactionId: string;
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly presentmentCurrency: string;
  readonly effect: 'withdrawal' | 'reinstatement';
  readonly reversalOfAllocationId: string | null;
}

interface StoredPlan {
  readonly id: string;
  readonly plan: FinancialAllocationPlan;
}

interface ExactActiveRefundTip {
  readonly id: string;
  readonly balanceTransactionId: string;
  readonly basis: 'gross_amount' | 'fee';
}

export interface LockedRefundProjectionReplayVersion {
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
  readonly replayId: string;
}

export interface LockedRefundProjectionReplayReplacement {
  readonly balanceTransactionId: string;
  readonly basis: 'gross_amount' | 'fee';
  readonly previousSetId: string | null;
  readonly replacementSetId: string;
  readonly sourceFingerprint: string;
  readonly disposition: 'inserted' | 'unchanged';
}

export const LOCKED_REFUND_PROJECTION_REPLAY_ISSUE_CODES = [
  'allocation_mismatch', 'currency_mismatch', 'missing_source',
  'source_linkage_mismatch', 'unsupported_category'
] as const satisfies readonly FinancialIssueCode[];
export type LockedRefundProjectionReplayIssueCode =
  (typeof LOCKED_REFUND_PROJECTION_REPLAY_ISSUE_CODES)[number];

export type LockedRefundProjectionReplayResult =
  | {
      readonly status: 'replayed' | 'unchanged';
      readonly refundId: string;
      readonly replacements: readonly LockedRefundProjectionReplayReplacement[];
    }
  | {
      readonly status: 'exception';
      readonly refundId: string;
      readonly safeCode: LockedRefundProjectionReplayIssueCode;
      readonly impact: Exclude<FinancialIssueImpact, 'informational'>;
    };

interface RefundProjectionVersionTarget {
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
  readonly replayId: string;
  readonly mode: 'ordinary' | 'replay';
}

interface PersistedRefundProjectionPlan {
  readonly setId: string;
  readonly disposition: 'inserted' | 'unchanged';
  readonly plan: FinancialAllocationPlan;
}

class RefundProjectionIssue extends Error {
  constructor(
    readonly safeCode: FinancialIssueCode,
    readonly impact: Exclude<FinancialIssueImpact, 'informational'>
  ) {
    super('The locked refund projection requires a durable issue.');
    this.name = 'RefundProjectionIssue';
  }
}

interface ResolvedOrdinaryRefundSetIssue {
  readonly id: string;
  readonly safeCode: FinancialIssueCode;
  readonly impact: FinancialIssueImpact;
}

function compareResolvedSetIssuePriority(
  left: ResolvedOrdinaryRefundSetIssue,
  right: ResolvedOrdinaryRefundSetIssue
): number {
  const impactRank = (impact: FinancialIssueImpact): number =>
    impact === 'exception' ? 0 : impact === 'pending' ? 1 : 2;
  const rank = impactRank(left.impact) - impactRank(right.impact);
  if (rank !== 0) return rank;
  if (left.safeCode !== right.safeCode) return left.safeCode < right.safeCode ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function assertFinancialSourceInput(
  input: unknown,
  idKey: 'refundId' | 'disputeId',
  signal: unknown
): asserts input is Record<typeof idKey, string> & { correlationId: string } {
  if (!exactObject(input, [idKey, 'correlationId']) ||
    typeof input[idKey] !== 'string' || !UUID.test(input[idKey]) ||
    typeof input.correlationId !== 'string' || input.correlationId.length < 1 ||
    input.correlationId.length > 100 ||
    typeof AbortSignal === 'undefined' || !(signal instanceof AbortSignal)) {
    throw new PermanentFinancialError('invalid_job_payload');
  }
}

export function throwIfFinancialSourceAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Financial source reconciliation was aborted.', 'AbortError');
  }
}

export async function financialProviderCall<Value>(
  signal: AbortSignal,
  work: () => Promise<Value>
): Promise<Value> {
  throwIfFinancialSourceAborted(signal);
  try {
    const value = await work();
    throwIfFinancialSourceAborted(signal);
    return value;
  } catch (error) {
    throwIfFinancialSourceAborted(signal);
    if (error instanceof RetryableFinancialError) throw error;
    if (error instanceof RetryableProviderError) {
      throw new RetryableFinancialError('provider_unavailable');
    }
    if (error instanceof PermanentCommerceError) {
      throw new PermanentFinancialError('unsupported_provider_evidence');
    }
    throw new RetryableFinancialError('provider_unavailable');
  }
}

interface RefundRouting {
  readonly id: string;
  readonly stripeRefundId: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly stripePaymentIntentId: string;
}

interface LocalFinancialSourceIssueRouting {
  readonly sourceKind: 'refund' | 'dispute';
  readonly sourceId: string;
  readonly providerSourceId: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly stripePaymentIntentId: string;
}

export async function recordLocalFinancialSourceIssue(
  database: Database,
  routing: LocalFinancialSourceIssueRouting,
  correlationId: string,
  safeCode: FinancialIssueCode,
  impact: FinancialIssueImpact,
  signal: AbortSignal,
  actor: { readonly type: 'system'; readonly id: string }
): Promise<FinancialSourceResult> {
  throwIfFinancialSourceAborted(signal);
  return database.transaction(async (transaction) => {
    throwIfFinancialSourceAborted(signal);
    await lockOrder(transaction, routing.orderId);
    const [order] = await transaction.select().from(orders)
      .where(eq(orders.id, routing.orderId)).limit(1).for('update');
    const [payment] = await transaction.select().from(payments).where(and(
      eq(payments.id, routing.paymentId), eq(payments.orderId, routing.orderId)
    )).limit(1).for('update');
    if (!order || !payment || payment.stripePaymentIntentId !== routing.stripePaymentIntentId) {
      throw new RetryableFinancialError('state_changed');
    }
    let facts: Awaited<ReturnType<typeof lockPaymentPurchaseFacts>>;
    try {
      facts = await lockPaymentPurchaseFacts(transaction, payment, order);
    } catch (error) {
      if (error instanceof PermanentCommerceError) {
        throw new RetryableFinancialError('state_changed');
      }
      throw error;
    }
    const source = routing.sourceKind === 'refund'
      ? facts.refunds.find((row) => row.id === routing.sourceId)
      : facts.disputes.find((row) => row.id === routing.sourceId);
    const providerSourceId = routing.sourceKind === 'refund'
      ? source && 'stripeRefundId' in source ? source.stripeRefundId : null
      : source && 'stripeDisputeId' in source ? source.stripeDisputeId : null;
    if (!source || source.paymentId !== routing.paymentId ||
      providerSourceId !== routing.providerSourceId) {
      throw new RetryableFinancialError('state_changed');
    }
    const issue = await observeFinancialIssue(transaction, {
      resourceType: routing.sourceKind,
      resourceId: routing.sourceId,
      safeCode,
      impact,
      actor,
      correlationId
    });
    const financialEvidenceStatus = impact === 'pending' ? 'pending' : 'exception';
    if (routing.sourceKind === 'refund') {
      await transaction.update(refunds).set({ financialEvidenceStatus })
        .where(eq(refunds.id, routing.sourceId));
    } else {
      await transaction.update(disputes).set({ financialEvidenceStatus })
        .where(eq(disputes.id, routing.sourceId));
    }
    throwIfFinancialSourceAborted(signal);
    return impact === 'pending'
      ? {
          status: 'pending', sourceKind: routing.sourceKind, sourceId: routing.sourceId,
          financialEvidenceStatus: 'pending', safeCode: 'missing_source', issueId: issue.id
        }
      : {
          status: 'exception', sourceKind: routing.sourceKind, sourceId: routing.sourceId,
          financialEvidenceStatus: 'exception', safeCode, issueId: issue.id
        };
  });
}

function parseRefundEvidence(value: unknown): RefundSnapshot {
  try {
    return parseRefundSnapshot(value);
  } catch (error) {
    if (error instanceof PermanentCommerceError) {
      throw new PermanentFinancialError('unsupported_provider_evidence');
    }
    throw error;
  }
}

function parsePaymentEvidence(value: unknown): PaymentSnapshot {
  try {
    return parsePaymentSnapshot(value);
  } catch (error) {
    if (error instanceof PermanentCommerceError) {
      throw new PermanentFinancialError('unsupported_provider_evidence');
    }
    throw error;
  }
}

function parseChargeEvidence(value: unknown, liveMode: boolean): ChargeSnapshot {
  try {
    return parseChargeSnapshot(value, liveMode);
  } catch (error) {
    if (error instanceof PermanentCommerceError) {
      throw new PermanentFinancialError('unsupported_provider_evidence');
    }
    throw error;
  }
}

export function parseBalanceEvidence(
  value: unknown,
  liveMode: boolean
): BalanceTransactionSnapshot {
  try {
    return parseBalanceTransactionSnapshot(value, liveMode);
  } catch (error) {
    if (error instanceof PermanentCommerceError) {
      throw new PermanentFinancialError('unsupported_provider_evidence');
    }
    throw error;
  }
}

async function rows(executor: DatabaseTransaction, query: SQL): Promise<unknown[]> {
  return ((await executor.execute(query)) as QueryResult).rows ?? [];
}

async function discoverExactActiveRefundTips(
  transaction: DatabaseTransaction,
  balanceTransactionIds: readonly string[],
  lockRows = false
): Promise<ExactActiveRefundTip[]> {
  if (balanceTransactionIds.length === 0) return [];
  const tips = await rows(transaction, sql`
    select target_set.id,
      target_set.balance_transaction_id as "balanceTransactionId", target_set.basis
    from financial_allocation_sets target_set
    where target_set.balance_transaction_id in (${sql.join(
      balanceTransactionIds.map((id) => sql`${id}::uuid`), sql`, `
    )})
      and target_set.classifier_version = ${FINANCIAL_CLASSIFIER_VERSION}
      and target_set.algorithm_version = ${FINANCIAL_ALLOCATION_ALGORITHM_VERSION}
      and not exists (
        select 1 from financial_allocation_sets successor
        where successor.supersedes_set_id = target_set.id
          and successor.classifier_version = target_set.classifier_version
          and successor.algorithm_version = target_set.algorithm_version
      )
    order by target_set.balance_transaction_id, target_set.basis, target_set.id
    ${lockRows ? sql`for update` : sql``}
  `) as ExactActiveRefundTip[];
  if (tips.some((tip) => !UUID.test(tip.id) ||
    !balanceTransactionIds.includes(tip.balanceTransactionId) ||
    (tip.basis !== 'gross_amount' && tip.basis !== 'fee'))) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
  return tips;
}

function sameExactActiveRefundTips(
  left: readonly ExactActiveRefundTip[],
  right: readonly ExactActiveRefundTip[]
): boolean {
  return left.length === right.length && left.every((tip, index) => {
    const other = right[index];
    return other?.id === tip.id &&
      other.balanceTransactionId === tip.balanceTransactionId &&
      other.basis === tip.basis;
  });
}

function invalidLockedInput(): never {
  throw new PermanentFinancialError('invalid_job_payload');
}

function safeMoney(value: unknown, nonnegative = false): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= SAFE_MONEY &&
    (!nonnegative || (value as number) >= 0);
}

function assertLockedRefundProjectionInput(
  value: unknown
): asserts value is LockedRefundProjectionInput {
  if (!exactObject(value, LOCKED_REFUND_KEYS) ||
    typeof value.orderId !== 'string' || !UUID.test(value.orderId) ||
    typeof value.paymentId !== 'string' || !UUID.test(value.paymentId) ||
    typeof value.refundId !== 'string' || !UUID.test(value.refundId) ||
    !['pending', 'succeeded', 'failed', 'canceled'].includes(String(value.providerStatus)) ||
    !['not_applicable', 'needs_review', 'draft', 'finalized', 'exception']
      .includes(String(value.allocationStatus)) ||
    !safeMoney(value.amountMinor, true) || value.amountMinor === 0 ||
    typeof value.currency !== 'string' || !CURRENCY.test(value.currency) ||
    !Array.isArray(value.balanceTransactionIds) || value.balanceTransactionIds.length < 1 ||
    value.balanceTransactionIds.length > 2 ||
    value.balanceTransactionIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
    new Set(value.balanceTransactionIds).size !== value.balanceTransactionIds.length ||
    !Array.isArray(value.orderItems) || value.orderItems.length < 1 || value.orderItems.length > 100 ||
    !Array.isArray(value.finalizedAllocations) || value.finalizedAllocations.length > 100 ||
    !Array.isArray(value.refundComponents) || value.refundComponents.length > 100 ||
    typeof value.correlationId !== 'string' || value.correlationId.length < 1 ||
    value.correlationId.length > 100) invalidLockedInput();

  const itemIds = new Set<string>();
  for (const item of value.orderItems) {
    if (!exactObject(item, ORDER_ITEM_KEYS) || typeof item.id !== 'string' || !UUID.test(item.id) ||
      itemIds.has(item.id) || !safeMoney(item.subtotalMinor, true) ||
      !safeMoney(item.taxMinor, true) || !safeMoney(item.totalMinor, true) ||
      BigInt(item.subtotalMinor) + BigInt(item.taxMinor) !== BigInt(item.totalMinor) ||
      typeof item.currency !== 'string' || !CURRENCY.test(item.currency) ||
      item.currency !== value.currency) invalidLockedInput();
    itemIds.add(item.id);
  }
  const allocationIds = new Set<string>();
  const allocatedItemIds = new Set<string>();
  for (const allocation of value.finalizedAllocations) {
    if (!exactObject(allocation, ALLOCATION_KEYS) || typeof allocation.id !== 'string' ||
      !UUID.test(allocation.id) || allocationIds.has(allocation.id) ||
      typeof allocation.orderItemId !== 'string' || !itemIds.has(allocation.orderItemId) ||
      allocatedItemIds.has(allocation.orderItemId) ||
      !safeMoney(allocation.amountMinor, true) || allocation.amountMinor === 0) invalidLockedInput();
    allocationIds.add(allocation.id);
    allocatedItemIds.add(allocation.orderItemId);
  }
  const componentAllocations = new Set<string>();
  for (const component of value.refundComponents) {
    if (!exactObject(component, COMPONENT_KEYS) ||
      typeof component.refundAllocationId !== 'string' ||
      !allocationIds.has(component.refundAllocationId) ||
      componentAllocations.has(component.refundAllocationId) ||
      typeof component.orderItemId !== 'string' || !itemIds.has(component.orderItemId) ||
      !safeMoney(component.subtotalMinor, true) || !safeMoney(component.taxMinor, true) ||
      typeof component.currency !== 'string' || component.currency !== value.currency) {
      invalidLockedInput();
    }
    componentAllocations.add(component.refundAllocationId);
  }
}

function assertLockedRefundProjectionReplayVersion(
  value: unknown
): asserts value is LockedRefundProjectionReplayVersion {
  if (!exactObject(value, REPLAY_VERSION_KEYS) ||
    typeof value.classifierVersion !== 'number' ||
    !Number.isSafeInteger(value.classifierVersion) || value.classifierVersion < 1 ||
    value.classifierVersion > 2_147_483_647 ||
    typeof value.allocationAlgorithmVersion !== 'number' ||
    !Number.isSafeInteger(value.allocationAlgorithmVersion) ||
    value.allocationAlgorithmVersion < 1 || value.allocationAlgorithmVersion > 2_147_483_647 ||
    typeof value.replayId !== 'string' ||
    value.replayId !== `c${value.classifierVersion}-a${value.allocationAlgorithmVersion}`) {
    invalidLockedInput();
  }
}

function sameInstant(left: Date, right: Date): boolean {
  return Number.isFinite(left.getTime()) && Number.isFinite(right.getTime()) &&
    left.getTime() === right.getTime();
}

function compareChronology(
  left: {
    readonly providerCreatedAt: Date;
    readonly providerRefundId: string;
    readonly refundId: string;
  },
  right: {
    readonly providerCreatedAt: Date;
    readonly providerRefundId: string;
    readonly refundId: string;
  }
): number {
  const difference = left.providerCreatedAt.getTime() - right.providerCreatedAt.getTime();
  if (difference !== 0) return difference;
  if (left.providerRefundId !== right.providerRefundId) {
    return left.providerRefundId < right.providerRefundId ? -1 : 1;
  }
  return left.refundId < right.refundId ? -1 : left.refundId > right.refundId ? 1 : 0;
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
      return 'unsupported_category';
    default:
      return null;
  }
}

function lockedReplayIssueCode(
  safeCode: FinancialIssueCode
): LockedRefundProjectionReplayIssueCode | null {
  return (LOCKED_REFUND_PROJECTION_REPLAY_ISSUE_CODES as readonly FinancialIssueCode[])
    .includes(safeCode)
    ? safeCode as LockedRefundProjectionReplayIssueCode
    : null;
}

function classificationComponent(value: string | null): ClassifiedFeeDetail['component'] {
  switch (value) {
    case 'refund_fee': return 'refund_fee';
    case 'provider_fee_tax': return 'provider_fee_tax';
    case 'fee_credit': return 'fee_credit';
    case 'other': return 'other';
    default: throw new PermanentFinancialError('unsupported_provider_evidence');
  }
}

async function loadFeeDetails(
  transaction: DatabaseTransaction,
  balanceTransactionId: string,
  classifierVersion: number
): Promise<readonly ClassifiedFeeDetail[]> {
  const details = await rows(transaction, sql`
    select detail.amount_minor as "amountMinor", decision.classification
    from stripe_balance_transaction_fee_details detail
    left join financial_classification_versions decision
      on decision.subject_type = 'fee_detail' and decision.subject_id = detail.id
      and decision.classifier_version = ${classifierVersion}
      and decision.source_fingerprint_sha256 = detail.fingerprint_sha256
    where detail.balance_transaction_id = ${balanceTransactionId}
    order by detail.ordinal
  `) as Array<{ amountMinor: number; classification: string | null }>;
  return details.map((detail) => {
    if (!safeMoney(detail.amountMinor, true)) {
      throw new PermanentFinancialError('allocation_mismatch');
    }
    return { amountMinor: -detail.amountMinor, component: classificationComponent(detail.classification) };
  });
}

async function loadCurrentStoredPlans(
  transaction: DatabaseTransaction,
  refundId: string,
  balanceTransactionId: string,
  target: Pick<RefundProjectionVersionTarget,
    'classifierVersion' | 'allocationAlgorithmVersion'>
): Promise<ReadonlyMap<'gross_amount' | 'fee', StoredPlan>> {
  const sets = await rows(transaction, sql`
    select allocation.id, allocation.allocation_identity as "allocationIdentity",
      allocation.balance_transaction_id as "balanceTransactionId", allocation.basis,
      allocation.source_kind as "sourceKind",
      allocation.source_internal_id as "sourceId",
      allocation.scope, allocation.currency,
      allocation.expected_effect_minor as "expectedEffectMinor",
      allocation.classifier_version as "classifierVersion",
      allocation.algorithm_version as "algorithmVersion",
      allocation.source_fingerprint_sha256 as "sourceFingerprint",
      allocation.supersedes_set_id as "supersedesSetId",
      allocation.reversal_of_set_id as "reversalOfSetId",
      (
        allocation.classifier_version = ${target.classifierVersion}
        and allocation.algorithm_version = ${target.allocationAlgorithmVersion}
        and not exists (
          select 1 from financial_allocation_sets successor
          where successor.supersedes_set_id = allocation.id
            and successor.classifier_version = allocation.classifier_version
            and successor.algorithm_version = allocation.algorithm_version
        )
      ) as "isTargetTip",
      not exists (
        select 1 from financial_allocation_sets global_successor
        where global_successor.supersedes_set_id = allocation.id
      ) as "isGlobalTip"
    from financial_allocation_sets allocation
    where allocation.balance_transaction_id = ${balanceTransactionId}
      and (
        (
          allocation.classifier_version = ${target.classifierVersion}
          and allocation.algorithm_version = ${target.allocationAlgorithmVersion}
          and not exists (
            select 1 from financial_allocation_sets successor
            where successor.supersedes_set_id = allocation.id
              and successor.classifier_version = allocation.classifier_version
              and successor.algorithm_version = allocation.algorithm_version
          )
        ) or not exists (
          select 1 from financial_allocation_sets global_successor
          where global_successor.supersedes_set_id = allocation.id
        )
      )
    order by allocation.basis, allocation.classifier_version, allocation.algorithm_version,
      allocation.id
    for update
  `) as Array<{
    id: string; allocationIdentity: string; balanceTransactionId: string;
    sourceKind: string; sourceId: string;
    basis: 'gross_amount' | 'fee'; scope: 'title' | 'account' | 'unresolved';
    currency: string; expectedEffectMinor: number; classifierVersion?: number;
    algorithmVersion: number;
    sourceFingerprint: string; supersedesSetId: string | null; reversalOfSetId: string | null;
    isTargetTip?: boolean; isGlobalTip?: boolean;
  }>;
  const result = new Map<'gross_amount' | 'fee', StoredPlan>();
  for (const basis of ['gross_amount', 'fee'] as const) {
    const basisSets = sets.filter((set) => set.basis === basis);
    const targetSets = basisSets.filter((set) => set.isTargetTip === true ||
      (set.isTargetTip === undefined && set.classifierVersion === target.classifierVersion &&
        set.algorithmVersion === target.allocationAlgorithmVersion));
    const fallbackSets = basisSets.filter((set) =>
      (set.isGlobalTip === true || set.isTargetTip === undefined) &&
      (set.classifierVersion === undefined ||
        (set.classifierVersion <= target.classifierVersion &&
          set.algorithmVersion <= target.allocationAlgorithmVersion &&
          (set.classifierVersion < target.classifierVersion ||
            set.algorithmVersion < target.allocationAlgorithmVersion))));
    const selected = targetSets.length > 0 ? targetSets : fallbackSets;
    if (selected.length > 1) {
      throw new PermanentFinancialError('source_linkage_mismatch');
    }
    const set = selected[0];
    if (!set) continue;
    const expectedOwner = set.sourceKind === 'refund' && set.sourceId === refundId;
    const balanceFallback = set.sourceKind === 'adjustment' &&
      set.sourceId === balanceTransactionId;
    if (!expectedOwner && !balanceFallback) {
      throw new PermanentFinancialError('source_linkage_mismatch');
    }
    const items = await rows(transaction, sql`
      select order_item_id as "orderItemId", component, effect_minor as "effectMinor",
        currency, tie_break_key as "tieBreakKey"
      from financial_item_allocations where allocation_set_id = ${set.id}
      order by tie_break_key, order_item_id, component
    `) as FinancialAllocationPlan['items'];
    result.set(basis, {
      id: set.id,
      plan: {
        allocationIdentity: set.allocationIdentity,
        balanceTransactionId: set.balanceTransactionId,
        basis: set.basis,
        scope: set.scope,
        currency: set.currency,
        expectedEffectMinor: set.expectedEffectMinor,
        algorithmVersion: set.algorithmVersion,
        sourceFingerprint: set.sourceFingerprint,
        supersedesSetId: set.supersedesSetId,
        reversalOfSetId: set.reversalOfSetId,
        items
      }
    });
  }
  return result;
}

function predecessorFor(
  current: StoredPlan | undefined,
  desiredIdentity: string
): string | null {
  return current?.plan.allocationIdentity === desiredIdentity
    ? current.plan.supersedesSetId
    : current?.id ?? null;
}

async function recordLockedRefundIssue(
  transaction: DatabaseTransaction,
  input: Pick<LockedRefundProjectionInput, 'refundId' | 'correlationId'>,
  safeCode: FinancialIssueCode,
  impact: FinancialIssueImpact
): Promise<RefundFinancialRecomputeResult> {
  const issue = await observeFinancialIssue(transaction, {
    resourceType: 'refund', resourceId: input.refundId, safeCode, impact,
    actor: ACTOR, correlationId: input.correlationId
  });
  const financialEvidenceStatus = impact === 'pending' ? 'pending' : 'exception';
  await transaction.update(refunds).set({ financialEvidenceStatus }).where(eq(refunds.id, input.refundId));
  return impact === 'pending'
    ? { status: 'pending', refundId: input.refundId, financialEvidenceStatus: 'pending',
        safeCode: safeCode === 'allocation_incomplete' ? 'allocation_incomplete' : 'missing_source',
        issueId: issue.id }
    : { status: 'exception', refundId: input.refundId, financialEvidenceStatus: 'exception',
        safeCode, issueId: issue.id };
}

function assertRefundProviderLinkage(
  routing: RefundRouting,
  refund: RefundSnapshot,
  payment: PaymentSnapshot,
  charge: ChargeSnapshot
): void {
  if (refund.providerRefundId !== routing.stripeRefundId ||
    refund.paymentIntentId !== routing.stripePaymentIntentId ||
    payment.paymentIntentId !== routing.stripePaymentIntentId ||
    payment.metadataVersion !== '1' || payment.metadataOrderId !== routing.orderId ||
    payment.latestChargeId === null || charge.id !== payment.latestChargeId ||
    charge.paymentIntentId !== payment.paymentIntentId) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
  if (refund.liveMode !== payment.liveMode || payment.liveMode !== charge.livemode) {
    throw new PermanentFinancialError('immutable_mismatch');
  }
  if (refund.currency.toUpperCase() !== payment.currency.toUpperCase() ||
    charge.currency !== payment.currency.toUpperCase()) {
    throw new PermanentFinancialError('currency_mismatch');
  }
}

function assertRefundBalanceLinkage(
  refund: RefundSnapshot,
  balance: BalanceTransactionSnapshot,
  kind: 'primary' | 'failure'
): void {
  const expectedId = kind === 'primary'
    ? refund.balanceTransactionId
    : refund.failureBalanceTransactionId;
  const expectedClassification = kind === 'primary' ? 'refund' : 'refund_failure';
  if (expectedId !== balance.id || balance.sourceFamily !== 'refund' ||
    balance.sourceId !== refund.providerRefundId || balance.livemode !== refund.liveMode ||
    balance.reportingCategory !== expectedClassification) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
}

async function loadRefundRouting(database: Database, refundId: string): Promise<RefundRouting> {
  const [routing] = await database.select({
    id: refunds.id,
    stripeRefundId: refunds.stripeRefundId,
    paymentId: payments.id,
    orderId: orders.id,
    stripePaymentIntentId: payments.stripePaymentIntentId
  }).from(refunds).innerJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(refunds.id, refundId)).limit(1);
  if (!routing) throw new RetryableFinancialError('local_state_pending');
  return routing;
}

async function recomputeLockedRefundFinancialProjectionAtVersion(
  transaction: DatabaseTransaction,
  input: LockedRefundProjectionInput,
  target: RefundProjectionVersionTarget,
  ordinarySelectedSetIds: readonly string[] = []
): Promise<RefundFinancialRecomputeResult | LockedRefundProjectionReplayResult> {
  assertLockedRefundProjectionInput(input);
  if (ordinarySelectedSetIds.some((id) => !UUID.test(id)) ||
    new Set(ordinarySelectedSetIds).size !== ordinarySelectedSetIds.length ||
    (target.mode === 'replay' && ordinarySelectedSetIds.length > 0)) {
    invalidLockedInput();
  }
  const [localState] = await rows(transaction, sql`
    select financial_evidence_status as "financialEvidenceStatus"
    from refunds where id = ${input.refundId} for update
  `) as Array<{ financialEvidenceStatus: 'pending' | 'fee_reconciled' | 'exception' }>;
  if (!localState) throw new RetryableFinancialError('state_changed');

  const outcome = await (async () => {
    try {
      const value = await transaction.transaction(async (projectionTx) => {
        const history = await rows(projectionTx, sql`
          select refund.id as "refundId", refund.stripe_refund_id as "providerRefundId",
            refund.provider_created_at as "providerCreatedAt",
            refund.status as "refundStatus", refund.allocation_status as "allocationStatus",
            component.refund_allocation_id as "refundAllocationId",
            component.order_item_id as "orderItemId", component.subtotal_minor as "subtotalMinor",
            component.tax_minor as "taxMinor", component.currency
          from refund_allocation_components component
          join refund_allocations allocation on allocation.id = component.refund_allocation_id
          join refunds refund on refund.id = component.refund_id
          where refund.payment_id = ${input.paymentId}
          order by refund.provider_created_at, refund.stripe_refund_id collate "C",
            refund.id, component.order_item_id
        `) as RefundHistoryRow[];
        const disputeExposureHistory = await rows(projectionTx, sql`
          select allocation.id as "allocationId",
            coalesce(original.gross_allocation_set_id, allocation.gross_allocation_set_id)
              as "withdrawalSetId",
            allocation.dispute_id as "disputeId",
            balance.provider_created_at as "providerCreatedAt",
            balance.provider_id as "providerTransactionId",
            allocation.order_item_id as "orderItemId",
            allocation.subtotal_effect_minor as "subtotalMinor",
            allocation.tax_effect_minor as "taxMinor",
            allocation.currency as "presentmentCurrency",
            allocation.effect,
            allocation.reverses_allocation_id as "reversalOfAllocationId"
          from dispute_item_allocations allocation
          join disputes dispute on dispute.id = allocation.dispute_id
          join financial_allocation_sets allocation_set
            on allocation_set.id = allocation.gross_allocation_set_id
          join stripe_balance_transactions balance
            on balance.id = allocation_set.balance_transaction_id
          join financial_classification_versions decision
            on decision.subject_type = 'balance_transaction'
            and decision.subject_id = balance.id
            and decision.classifier_version = ${target.classifierVersion}
            and decision.source_fingerprint_sha256 = balance.fingerprint_sha256
          left join dispute_item_allocations original
            on original.id = allocation.reverses_allocation_id
          where dispute.payment_id = ${input.paymentId}
            and allocation_set.basis = 'gross_amount'
            and allocation_set.classifier_version = ${target.classifierVersion}
            and allocation_set.algorithm_version = ${target.allocationAlgorithmVersion}
            and (
              decision.classification = 'dispute_withdrawal'
                and allocation.effect = 'withdrawal'
              or decision.classification = 'dispute_reinstatement'
                and allocation.effect = 'reinstatement'
            )
            and not exists (
              select 1 from financial_allocation_sets successor
              where successor.supersedes_set_id = allocation_set.id
                and successor.classifier_version = allocation_set.classifier_version
                and successor.algorithm_version = allocation_set.algorithm_version
            )
          order by balance.provider_created_at, balance.provider_id collate "C",
            allocation.dispute_id, allocation.id
        `) as DisputeExposureHistoryRow[];
        const currentHistory = history.filter((row) => row.refundId === input.refundId);
        const allocationById = new Map(input.finalizedAllocations.map((row) => [row.id, row]));
        if (currentHistory.length !== input.refundComponents.length ||
          input.refundComponents.some((component) => {
            const allocation = allocationById.get(component.refundAllocationId);
            const stored = currentHistory.find((row) =>
              row.refundAllocationId === component.refundAllocationId
            );
            return !allocation || allocation.orderItemId !== component.orderItemId ||
              allocation.amountMinor !== component.subtotalMinor + component.taxMinor ||
              !stored || stored.orderItemId !== component.orderItemId ||
              stored.subtotalMinor !== component.subtotalMinor || stored.taxMinor !== component.taxMinor ||
              stored.currency !== component.currency;
          }) || input.finalizedAllocations.length !== input.refundComponents.length) {
          throw new PermanentFinancialError('allocation_mismatch');
        }
        const finalizedTotal = input.finalizedAllocations.reduce(
          (sum, allocation) => sum + BigInt(allocation.amountMinor), 0n
        );
        const hasFinalizedAttribution = input.finalizedAllocations.length > 0;
        if ((hasFinalizedAttribution && finalizedTotal !== BigInt(input.amountMinor)) ||
          (input.providerStatus === 'succeeded' && input.allocationStatus === 'finalized' &&
            !hasFinalizedAttribution) ||
          (input.providerStatus === 'succeeded' && input.allocationStatus !== 'finalized' &&
            hasFinalizedAttribution) ||
          (input.providerStatus === 'succeeded' && input.allocationStatus === 'exception')) {
          throw new PermanentFinancialError('allocation_mismatch');
        }
        const finalizedChronology = (() => {
          if (!hasFinalizedAttribution) return null;
          const providerCreatedAt = currentHistory[0]?.providerCreatedAt;
          const providerRefundId = currentHistory[0]?.providerRefundId;
          if (!providerCreatedAt || !providerRefundId || currentHistory.some((row) =>
            row.providerRefundId !== providerRefundId ||
            !sameInstant(new Date(row.providerCreatedAt), new Date(providerCreatedAt)))) {
            throw new PermanentFinancialError('source_linkage_mismatch');
          }
          return { providerCreatedAt: new Date(providerCreatedAt), providerRefundId };
        })();
        if (finalizedChronology) {
          const incompleteEarlierDisputes = await rows(projectionTx, sql`
            select dispute_balance.id as "balanceTransactionId"
            from stripe_balance_transactions dispute_balance
            join disputes dispute
              on dispute.stripe_dispute_id = dispute_balance.source_id
            left join financial_classification_versions decision
              on decision.subject_type = 'balance_transaction'
              and decision.subject_id = dispute_balance.id
              and decision.classifier_version = ${target.classifierVersion}
              and decision.source_fingerprint_sha256 = dispute_balance.fingerprint_sha256
            where dispute.payment_id = ${input.paymentId}
              and dispute_balance.source_family = 'dispute'
              and row(
                dispute_balance.provider_created_at,
                dispute_balance.provider_id collate "C",
                dispute.id
              ) < row(
                ${finalizedChronology.providerCreatedAt},
                ${finalizedChronology.providerRefundId} collate "C",
                ${input.refundId}::uuid
              )
              and (
                decision.id is null
                or decision.classification is null
                or decision.classification not in (
                  'dispute_withdrawal', 'dispute_reinstatement', 'fee_credit'
                )
                or exists (
                  select 1 from financial_reconciliation_issues classification_issue
                  where classification_issue.resource_type = 'balance_transaction'
                    and classification_issue.resource_id = dispute_balance.id
                    and classification_issue.safe_code = 'classification_fork'
                    and classification_issue.state = 'open'
                    and classification_issue.impact = 'exception'
                )
                or (
                  decision.classification in ('dispute_withdrawal', 'dispute_reinstatement')
                  and (
                    select count(*)
                    from financial_allocation_sets raw_exposure_set
                    where raw_exposure_set.balance_transaction_id = dispute_balance.id
                      and raw_exposure_set.basis = 'gross_amount'
                      and raw_exposure_set.classifier_version = ${target.classifierVersion}
                      and raw_exposure_set.algorithm_version =
                        ${target.allocationAlgorithmVersion}
                      and not exists (
                        select 1 from financial_allocation_sets raw_successor
                        where raw_successor.supersedes_set_id = raw_exposure_set.id
                          and raw_successor.classifier_version =
                            raw_exposure_set.classifier_version
                          and raw_successor.algorithm_version =
                            raw_exposure_set.algorithm_version
                      )
                  ) <> 1
                )
                or (
                  decision.classification in ('dispute_withdrawal', 'dispute_reinstatement')
                  and (
                    select count(*)
                    from financial_allocation_sets valid_exposure_set
                    where valid_exposure_set.balance_transaction_id = dispute_balance.id
                      and valid_exposure_set.source_kind = 'dispute'
                      and valid_exposure_set.source_internal_id = dispute.id
                      and valid_exposure_set.basis = 'gross_amount'
                      and valid_exposure_set.scope = 'title'
                      and valid_exposure_set.classifier_version = ${target.classifierVersion}
                      and valid_exposure_set.algorithm_version =
                        ${target.allocationAlgorithmVersion}
                      and valid_exposure_set.source_fingerprint_sha256 =
                        dispute_balance.fingerprint_sha256
                      and not exists (
                        select 1 from financial_allocation_sets valid_successor
                        where valid_successor.supersedes_set_id = valid_exposure_set.id
                          and valid_successor.classifier_version =
                            valid_exposure_set.classifier_version
                          and valid_successor.algorithm_version =
                            valid_exposure_set.algorithm_version
                      )
                      and not exists (
                        select 1 from financial_reconciliation_issues exposure_issue
                        where exposure_issue.resource_type = 'allocation_set'
                          and exposure_issue.resource_id = valid_exposure_set.id
                          and exposure_issue.state = 'open'
                          and exposure_issue.impact <> 'informational'
                      )
                      and exists (
                        select 1 from dispute_item_allocations presentment
                        where presentment.gross_allocation_set_id = valid_exposure_set.id
                          and presentment.dispute_id = dispute.id
                          and (
                            decision.classification = 'dispute_withdrawal'
                              and presentment.effect = 'withdrawal'
                            or decision.classification = 'dispute_reinstatement'
                              and presentment.effect = 'reinstatement'
                          )
                      )
                  ) <> 1
                )
                or (
                  decision.classification = 'fee_credit'
                  and exists (
                    select 1
                    from financial_allocation_sets fee_credit_set
                    join dispute_item_allocations fee_credit_presentment
                      on fee_credit_presentment.gross_allocation_set_id = fee_credit_set.id
                    where fee_credit_set.balance_transaction_id = dispute_balance.id
                      and fee_credit_set.basis = 'gross_amount'
                      and fee_credit_set.classifier_version = ${target.classifierVersion}
                      and fee_credit_set.algorithm_version =
                        ${target.allocationAlgorithmVersion}
                      and fee_credit_presentment.dispute_id = dispute.id
                      and not exists (
                        select 1 from financial_allocation_sets fee_credit_successor
                        where fee_credit_successor.supersedes_set_id = fee_credit_set.id
                          and fee_credit_successor.classifier_version =
                            fee_credit_set.classifier_version
                          and fee_credit_successor.algorithm_version =
                            fee_credit_set.algorithm_version
                      )
                  )
                )
              )
            order by dispute_balance.provider_created_at,
              dispute_balance.provider_id collate "C", dispute.id, dispute_balance.id
          `) as Array<{ balanceTransactionId: string }>;
          if (incompleteEarlierDisputes.length > 0) {
            throw new RefundProjectionIssue('missing_source', 'pending');
          }
        }

        const balances = await rows(projectionTx, sql`
          select balance.id, balance.provider_id as "providerId",
            balance.source_family as "sourceFamily", balance.source_id as "sourceId",
            balance.amount_minor as "amountMinor", balance.fee_minor as "feeMinor",
            balance.net_minor as "netMinor", balance.currency,
            balance.fingerprint_sha256 as "fingerprintSha256",
            balance.provider_created_at as "providerCreatedAt", decision.classification
          from stripe_balance_transactions balance
          left join financial_classification_versions decision
            on decision.subject_type = 'balance_transaction' and decision.subject_id = balance.id
            and decision.classifier_version = ${target.classifierVersion}
            and decision.source_fingerprint_sha256 = balance.fingerprint_sha256
          where balance.id in (${sql.join(
            input.balanceTransactionIds.map((id) => sql`${id}::uuid`), sql`, `
          )})
          order by balance.provider_created_at, balance.provider_id
        `) as LockedBalanceRow[];
        if (balances.length !== input.balanceTransactionIds.length ||
          new Set(balances.map((row) => row.id)).size !== balances.length ||
          balances.some((balance) => !input.balanceTransactionIds.includes(balance.id) ||
            balance.sourceFamily !== 'refund' || balance.sourceId === null ||
            !safeMoney(balance.amountMinor) || !safeMoney(balance.feeMinor, true) ||
            !safeMoney(balance.netMinor) ||
            BigInt(balance.amountMinor) - BigInt(balance.feeMinor) !== BigInt(balance.netMinor) ||
            !CURRENCY.test(balance.currency) || !FINGERPRINT.test(balance.fingerprintSha256) ||
            !Number.isFinite(new Date(balance.providerCreatedAt).getTime()))) {
          throw new PermanentFinancialError('source_linkage_mismatch');
        }
        const primaryRows = balances.filter((row) => row.classification === 'refund');
        const failureRows = balances.filter((row) => row.classification === 'refund_failure');
        if (primaryRows.length > 1 || failureRows.length > 1 ||
          primaryRows.length + failureRows.length !== balances.length) {
          throw new RefundProjectionIssue('unsupported_category', 'exception');
        }
        const primary = primaryRows[0];
        const failure = failureRows[0];
        if (input.providerStatus === 'succeeded' && (!primary || failure) ||
          (input.providerStatus === 'failed' || input.providerStatus === 'canceled') && !failure) {
          throw new RefundProjectionIssue('missing_source', 'pending');
        }
        if (input.providerStatus === 'pending') {
          throw new RefundProjectionIssue('missing_source', 'pending');
        }
        if (primary && primary.amountMinor >= 0 || failure && failure.amountMinor <= 0) {
          throw new PermanentFinancialError('allocation_mismatch');
        }
        if (!primary) throw new RefundProjectionIssue('missing_source', 'pending');
        if (failure && primary.currency !== failure.currency) {
          throw new PermanentFinancialError('currency_mismatch');
        }

        const primaryFeeDetails = await loadFeeDetails(
          projectionTx, primary.id, target.classifierVersion
        );
        const primaryCurrent = await loadCurrentStoredPlans(
          projectionTx, input.refundId, primary.id, target
        );
        const primaryMode = hasFinalizedAttribution ? 'finalized' : failure ? 'account' : 'unresolved';
        const replaySuffix = `:replay:${target.replayId}`;
        const primaryPrefix = `refund:${input.refundId}:${primary.id}:${primaryMode}${replaySuffix}`;
        const metadata = {
          sourceKind: 'refund' as const,
          sourceId: input.refundId,
          balanceTransactionId: primary.id,
          allocationIdentityPrefix: primaryPrefix,
          settlementCurrency: primary.currency,
          amountMinor: primary.amountMinor,
          feeMinor: primary.feeMinor,
          netMinor: primary.netMinor,
          sourceFingerprint: primary.fingerprintSha256,
          algorithmVersion: target.allocationAlgorithmVersion,
          supersedesGrossSetId: predecessorFor(
            primaryCurrent.get('gross_amount'), `${primaryPrefix}:gross`
          ),
          supersedesFeeSetId: predecessorFor(primaryCurrent.get('fee'), `${primaryPrefix}:fee`)
        };
        let primaryPlans: readonly [FinancialAllocationPlan, FinancialAllocationPlan];
        if (hasFinalizedAttribution) {
          const currentCreatedAt = finalizedChronology!.providerCreatedAt;
          const currentProviderRefundId = finalizedChronology!.providerRefundId;
          const currentChronology = {
            refundId: input.refundId,
            providerRefundId: currentProviderRefundId,
            providerCreatedAt: new Date(currentCreatedAt)
          };
          const earlierFinalized: EarlierFinalizedRefundComponent[] = history.flatMap((row) => {
            const chronology = {
              refundId: row.refundId,
              providerRefundId: row.providerRefundId,
              providerCreatedAt: new Date(row.providerCreatedAt)
            };
            return row.refundId === input.refundId || row.refundStatus !== 'succeeded' ||
              !['finalized', 'exception'].includes(row.allocationStatus) ||
              compareChronology(chronology, currentChronology) >= 0
              ? []
              : [{ refundId: row.refundId, providerRefundId: row.providerRefundId,
                  providerCreatedAt: chronology.providerCreatedAt.toISOString(),
                  componentId: row.refundAllocationId,
                  orderItemId: row.orderItemId, subtotalMinor: row.subtotalMinor,
                  taxMinor: row.taxMinor, presentmentCurrency: row.currency }];
          });
          const currentExposureChronology = {
            providerCreatedAtMs: new Date(currentCreatedAt).getTime(),
            providerId: currentProviderRefundId,
            sourceId: input.refundId,
            rowId: ''
          };
          const priorPresentmentEffects: BoundDisputePresentmentEffect[] =
            disputeExposureHistory.flatMap((row) =>
              compareFinancialExposureChronology({
                providerCreatedAtMs: new Date(row.providerCreatedAt).getTime(),
                providerId: row.providerTransactionId,
                sourceId: row.disputeId,
                rowId: row.allocationId
              }, currentExposureChronology) >= 0
                ? []
                : [{
                    allocationId: row.allocationId,
                    withdrawalSetId: row.withdrawalSetId,
                    disputeId: row.disputeId,
                    providerCreatedAt: new Date(row.providerCreatedAt).toISOString(),
                    providerTransactionId: row.providerTransactionId,
                    orderItemId: row.orderItemId,
                    subtotalMinor: row.subtotalMinor,
                    taxMinor: row.taxMinor,
                    presentmentCurrency: row.presentmentCurrency,
                    ...(row.effect === 'withdrawal'
                      ? { effect: 'withdrawal' as const, reversalOfAllocationId: null }
                      : {
                          effect: 'reinstatement' as const,
                          reversalOfAllocationId: row.reversalOfAllocationId!
                        })
                  }]
            );
          primaryPlans = buildRefundAllocationPlan({
            ...metadata,
            providerRefundId: currentProviderRefundId,
            providerCreatedAt: new Date(currentCreatedAt).toISOString(),
            presentmentAmountMinor: input.amountMinor,
            presentmentCurrency: input.currency,
            attribution: {
              kind: 'finalized',
              components: input.refundComponents.map((component) => {
                const item = input.orderItems.find((candidate) => candidate.id === component.orderItemId)!;
                return {
                  orderItemId: component.orderItemId,
                  subtotalMinor: component.subtotalMinor,
                  taxMinor: component.taxMinor,
                  remainingSubtotalCapacityMinor: item.subtotalMinor,
                  remainingTaxCapacityMinor: item.taxMinor,
                  presentmentCurrency: component.currency
                };
              })
            },
            paymentItems: input.orderItems.map((item) => ({
              orderItemId: item.id, subtotalMinor: item.subtotalMinor, currency: primary.currency
            })),
            paymentItemCapacities: input.orderItems.map((item) => ({
              orderItemId: item.id, subtotalMinor: item.subtotalMinor, taxMinor: item.taxMinor,
              presentmentCurrency: item.currency
            })),
            earlierFinalized,
            priorPresentmentEffects,
            feeDetails: primaryFeeDetails
          }).plans;
        } else if (!failure) {
          primaryPlans = buildRefundAllocationPlan({
            ...metadata,
            presentmentAmountMinor: input.amountMinor,
            presentmentCurrency: input.currency,
            attribution: { kind: 'unresolved' },
            paymentItems: input.orderItems.map((item) => ({
              orderItemId: item.id, subtotalMinor: item.subtotalMinor, currency: primary.currency
            })),
            feeDetails: primaryFeeDetails
          }).plans;
        } else {
          const paymentItems = input.orderItems.map((item) => ({
            orderItemId: item.id, subtotalMinor: item.subtotalMinor, currency: primary.currency
          }));
          primaryPlans = [
            basePlan(metadata, {
              basis: 'gross_amount', scope: 'account',
              expectedEffectMinor: primary.amountMinor, items: []
            }),
            basePlan(metadata, {
              basis: 'fee', scope: 'title', expectedEffectMinor: -primary.feeMinor,
              items: allocateFeeDetails(primary.feeMinor, primary.currency, paymentItems, primaryFeeDetails)
            })
          ];
        }

        const persisted: PersistedRefundProjectionPlan[] = [];
        for (const plan of primaryPlans) {
          const persistInput = {
            plan, sourceKind: 'refund', sourceId: input.refundId,
            classificationVersion: target.classifierVersion,
            correlationId: input.correlationId
          } as const;
          const stored = await persistFinancialAllocationReplayPlanLocked(
            projectionTx,
            persistInput,
            {
              classifierVersion: target.classifierVersion,
              allocationAlgorithmVersion: target.allocationAlgorithmVersion
            }
          );
          persisted.push({ ...stored, plan });
        }
        if (failure) {
          const failureFeeDetails = await loadFeeDetails(
            projectionTx, failure.id, target.classifierVersion
          );
          const failureCurrent = await loadCurrentStoredPlans(
            projectionTx, input.refundId, failure.id, target
          );
          const failurePrefix = `refund:${input.refundId}:${failure.id}:failure${replaySuffix}`;
          const failurePlans = buildFailedRefundAllocationPlan({
            sourceKind: 'refund', sourceId: input.refundId,
            balanceTransactionId: failure.id,
            allocationIdentityPrefix: failurePrefix,
            settlementCurrency: failure.currency,
            amountMinor: failure.amountMinor,
            feeMinor: failure.feeMinor,
            netMinor: failure.netMinor,
            sourceFingerprint: failure.fingerprintSha256,
            algorithmVersion: target.allocationAlgorithmVersion,
            supersedesGrossSetId: predecessorFor(
              failureCurrent.get('gross_amount'), `${failurePrefix}:gross`
            ),
            supersedesFeeSetId: predecessorFor(failureCurrent.get('fee'), `${failurePrefix}:fee`),
            originalGrossSetId: persisted[0]!.setId,
            originalGrossPlan: primaryPlans[0],
            originalFeeSetId: persisted[1]!.setId,
            originalFeePlan: primaryPlans[1],
            paymentItems: input.orderItems.map((item) => ({
              orderItemId: item.id, subtotalMinor: item.subtotalMinor, currency: failure.currency
            })),
            feeDetails: failureFeeDetails
          }).plans;
          for (const plan of failurePlans) {
            const persistInput = {
              plan, sourceKind: 'refund', sourceId: input.refundId,
              classificationVersion: target.classifierVersion,
              correlationId: input.correlationId
            } as const;
            const stored = await persistFinancialAllocationReplayPlanLocked(
              projectionTx,
              persistInput,
              {
                classifierVersion: target.classifierVersion,
                allocationAlgorithmVersion: target.allocationAlgorithmVersion
              }
            );
            persisted.push({ ...stored, plan });
          }
        }

        if (target.mode === 'replay') {
          return { kind: 'replay' as const, persisted };
        }

        const resolvedAllocationSetIssues: ResolvedOrdinaryRefundSetIssue[] = [];
        const validatedSelectedSetIds = [...new Set(persisted.flatMap((row) => [
          row.setId,
          ...(row.plan.supersedesSetId === null ? [] : [row.plan.supersedesSetId])
        ]).filter((id) => ordinarySelectedSetIds.includes(id)))].sort();
        for (const resourceId of validatedSelectedSetIds) {
          for (const safeCode of ORDINARY_REFUND_SET_ISSUE_CODES) {
            const resolved = await resolveFinancialIssueAfterRecompute(projectionTx, {
              resourceType: 'allocation_set', resourceId, safeCode,
              proof: { status: 'resolved', resourceType: 'allocation_set',
                resourceId, safeCode },
              actor: ACTOR, correlationId: input.correlationId
            });
            if (resolved) resolvedAllocationSetIssues.push({
              id: resolved.id, safeCode: resolved.safeCode, impact: resolved.impact
            });
          }
        }
        const projections = await loadCurrentEffectiveAllocationProjection(projectionTx, {
          balanceTransactionIds: input.balanceTransactionIds
        });
        if (projections.length !== input.balanceTransactionIds.length * 2) {
          throw new PermanentFinancialError('allocation_mismatch');
        }
        const failureProjection = projections.find((projection) => projection.status !== 'complete');
        if (failureProjection) {
          const resolvedBlockingIssue = [...resolvedAllocationSetIssues]
            .sort(compareResolvedSetIssuePriority)
            .find((issue) => issue.impact !== 'informational');
          if (resolvedBlockingIssue) {
            const impact = resolvedBlockingIssue.impact;
            if (impact === 'informational') throw new PermanentFinancialError('immutable_mismatch');
            throw new RefundProjectionIssue(resolvedBlockingIssue.safeCode, impact);
          }
          if (failureProjection.status === 'missing') {
            const expectedAmbiguity = !failure && !hasFinalizedAttribution;
            const safeCode = expectedAmbiguity
              ? 'allocation_incomplete' as const
              : 'missing_source' as const;
            return {
              kind: 'pending' as const,
              safeCode,
              persisted
            };
          }
          throw new RefundProjectionIssue(failureProjection.safeCode, 'exception');
        }
        for (const projection of projections) {
          if (projection.status !== 'complete') continue;
          const balance = balances.find((candidate) => candidate.id === projection.balanceTransactionId);
          const expected = projection.basis === 'gross_amount' ? balance?.amountMinor : -(balance?.feeMinor ?? 0);
          if (!balance || projection.currency !== balance.currency ||
            projection.expectedEffectMinor !== expected) {
            throw new PermanentFinancialError('allocation_mismatch');
          }
        }
        return {
          kind: 'complete' as const,
          persisted,
          projections,
          resolvedAllocationSetIssueIds: resolvedAllocationSetIssues.map((issue) => issue.id)
        };
      });
      return value;
    } catch (error) {
      if (error instanceof RefundProjectionIssue) {
        return { kind: 'issue' as const, safeCode: error.safeCode, impact: error.impact };
      }
      const safeCode = durableIssueCode(error);
      if (safeCode) return { kind: 'issue' as const, safeCode, impact: 'exception' as const };
      throw error;
    }
  })();

  if (outcome.kind === 'replay') {
    if (target.mode !== 'replay') {
      throw new PermanentFinancialError('source_linkage_mismatch');
    }
    return {
      status: outcome.persisted.some((row) => row.disposition === 'inserted')
        ? 'replayed'
        : 'unchanged',
      refundId: input.refundId,
      replacements: outcome.persisted.map((row) => ({
        balanceTransactionId: row.plan.balanceTransactionId,
        basis: row.plan.basis,
        previousSetId: row.plan.supersedesSetId,
        replacementSetId: row.setId,
        sourceFingerprint: row.plan.sourceFingerprint,
        disposition: row.disposition
      }))
    };
  }
  if (target.mode === 'replay') {
    if (outcome.kind === 'pending') {
      const safeCode = lockedReplayIssueCode(outcome.safeCode);
      if (safeCode === null) throw new PermanentFinancialError('source_linkage_mismatch');
      return {
        status: 'exception', refundId: input.refundId,
        safeCode, impact: 'pending'
      };
    }
    if (outcome.kind === 'issue') {
      const safeCode = lockedReplayIssueCode(outcome.safeCode);
      if (safeCode === null) throw new PermanentFinancialError('source_linkage_mismatch');
      return {
        status: 'exception', refundId: input.refundId,
        safeCode, impact: outcome.impact
      };
    }
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
  if (outcome.kind === 'pending' || outcome.kind === 'issue') {
    const safeCode = outcome.safeCode;
    const impact = outcome.kind === 'pending' ? 'pending' : outcome.impact;
    if ((ORDINARY_REFUND_SET_ISSUE_CODES as readonly FinancialIssueCode[])
      .includes(safeCode)) {
      for (const resourceId of ordinarySelectedSetIds) {
        await observeFinancialIssue(transaction, {
          resourceType: 'allocation_set', resourceId, safeCode, impact,
          actor: ACTOR, correlationId: input.correlationId
        });
      }
    }
    await rearmCurrentProjectionSubjectsForFinancialSources(transaction, {
      sourceKind: 'refund', sourceIds: [input.refundId]
    });
  }
  if (outcome.kind === 'pending') {
    return recordLockedRefundIssue(transaction, input, outcome.safeCode, 'pending');
  }
  if (outcome.kind === 'issue') {
    return recordLockedRefundIssue(transaction, input, outcome.safeCode, outcome.impact);
  }
  const resolvedIssueIds: string[] = [...outcome.resolvedAllocationSetIssueIds];
  for (const safeCode of ISSUE_CODES) {
    const resolved = await resolveFinancialIssueAfterRecompute(transaction, {
      resourceType: 'refund', resourceId: input.refundId, safeCode,
      proof: { status: 'resolved', resourceType: 'refund', resourceId: input.refundId, safeCode },
      actor: ACTOR, correlationId: input.correlationId
    });
    if (resolved) resolvedIssueIds.push(resolved.id);
  }
  const changed = localState.financialEvidenceStatus !== 'fee_reconciled' ||
    outcome.persisted.some((row) => row.disposition === 'inserted') || resolvedIssueIds.length > 0;
  if (localState.financialEvidenceStatus !== 'fee_reconciled') {
    await transaction.update(refunds).set({ financialEvidenceStatus: 'fee_reconciled' })
      .where(eq(refunds.id, input.refundId));
  }
  if (changed) {
    await appendAuditEvent(transaction, {
      actor: ACTOR,
      action: 'financial.refund_reconciled',
      outcome: 'succeeded',
      resourceType: 'refund',
      resourceId: input.refundId,
      correlationId: input.correlationId,
      after: {
        refundId: input.refundId,
        orderId: input.orderId,
        financialEvidenceStatus: 'fee_reconciled',
        balanceTransactionCount: input.balanceTransactionIds.length,
        allocationSetCount: outcome.persisted.length,
        allocationItemCount: outcome.projections.reduce(
          (sum, projection) => sum + (projection.status === 'complete' ? projection.items.length : 0), 0
        )
      }
    });
  }
  if (!changed) {
    return {
      status: 'unchanged', refundId: input.refundId,
      financialEvidenceStatus: 'fee_reconciled'
    };
  }
  return {
    status: 'reconciled', refundId: input.refundId,
    financialEvidenceStatus: 'fee_reconciled',
    allocationSetIds: outcome.persisted.map((row) => row.setId),
    resolvedIssueIds
  };
}

export async function recomputeLockedRefundFinancialProjection(
  transaction: DatabaseTransaction,
  input: LockedRefundProjectionInput,
  ordinarySelectedSetIds: readonly string[] = []
): Promise<RefundFinancialRecomputeResult> {
  return recomputeLockedRefundFinancialProjectionAtVersion(transaction, input, {
    classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
    allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
    replayId: FINANCIAL_REPLAY_ID,
    mode: 'ordinary'
  }, ordinarySelectedSetIds) as Promise<RefundFinancialRecomputeResult>;
}

/**
 * Rebuilds the complete, already-locked refund source chronology for an explicit deployed
 * projection pair. The caller owns the canonical payment-purchase and financial row locks,
 * issue transitions, correction rebasing, and activation transaction.
 */
export async function recomputeLockedRefundFinancialProjectionForVersion(
  transaction: DatabaseTransaction,
  input: LockedRefundProjectionInput,
  target: LockedRefundProjectionReplayVersion
): Promise<LockedRefundProjectionReplayResult> {
  assertLockedRefundProjectionReplayVersion(target);
  return recomputeLockedRefundFinancialProjectionAtVersion(transaction, input, {
    ...target,
    mode: 'replay'
  }) as
    Promise<LockedRefundProjectionReplayResult>;
}

export async function reconcileRefundFinancialSource(
  database: Database,
  gateway: StripeCommerceGateway,
  input: { refundId: string; correlationId: string },
  signal: AbortSignal
): Promise<FinancialSourceResult> {
  assertFinancialSourceInput(input, 'refundId', signal);
  throwIfFinancialSourceAborted(signal);
  const routing = await loadRefundRouting(database, input.refundId);
  throwIfFinancialSourceAborted(signal);

  let refund: RefundSnapshot;
  let payment: PaymentSnapshot;
  let charge: ChargeSnapshot;
  const stagedIds: string[] = [];
  try {
    refund = parseRefundEvidence(await financialProviderCall(
      signal,
      () => gateway.retrieveRefund(routing.stripeRefundId)
    ));
    payment = parsePaymentEvidence(await financialProviderCall(
      signal,
      () => gateway.retrievePayment(routing.stripePaymentIntentId)
    ));
    if (payment.latestChargeId === null) {
      throw new RetryableFinancialError('provider_not_ready');
    }
    const latestChargeId = payment.latestChargeId;
    charge = parseChargeEvidence(await financialProviderCall(
      signal,
      () => gateway.retrieveCharge(latestChargeId)
    ), payment.liveMode);
    assertRefundProviderLinkage(routing, refund, payment, charge);

    const providerIds = [refund.balanceTransactionId, refund.failureBalanceTransactionId]
      .filter((value): value is string => value !== null);
    const snapshots: BalanceTransactionSnapshot[] = [];
    for (const [index, providerId] of providerIds.entries()) {
      const snapshot = parseBalanceEvidence(await financialProviderCall(
        signal,
        () => gateway.retrieveBalanceTransaction(providerId)
      ), refund.liveMode);
      assertRefundBalanceLinkage(
        refund,
        snapshot,
        index === 0 && refund.balanceTransactionId !== null ? 'primary' : 'failure'
      );
      snapshots.push(snapshot);
    }
    if (snapshots.length === 0) {
      return recordLocalFinancialSourceIssue(database, {
        sourceKind: 'refund', sourceId: routing.id, providerSourceId: routing.stripeRefundId,
        paymentId: routing.paymentId, orderId: routing.orderId,
        stripePaymentIntentId: routing.stripePaymentIntentId
      }, input.correlationId, 'missing_source', 'pending', signal, ACTOR);
    }
    for (const snapshot of snapshots) {
      const staged = await stageBalanceTransaction(database, snapshot, {
        correlationId: input.correlationId
      });
      stagedIds.push(staged.balanceTransactionId);
      throwIfFinancialSourceAborted(signal);
    }
  } catch (error) {
    const safeCode = durableIssueCode(error);
    if (safeCode) {
      return recordLocalFinancialSourceIssue(database, {
        sourceKind: 'refund', sourceId: routing.id, providerSourceId: routing.stripeRefundId,
        paymentId: routing.paymentId, orderId: routing.orderId,
        stripePaymentIntentId: routing.stripePaymentIntentId
      }, input.correlationId, safeCode, 'exception', signal, ACTOR);
    }
    throw error;
  }
  const closureRows = ((await database.execute(sql`
    select payout.id as "payoutId", payout.financial_generation as "expectedGeneration",
      member.balance_transaction_id as "balanceTransactionId"
    from stripe_payout_balance_transactions source_membership
    join stripe_payouts payout on payout.id = source_membership.payout_id
    join stripe_payout_balance_transactions member on member.payout_id = payout.id
    where source_membership.balance_transaction_id in (
      ${sql.join(stagedIds.map((id) => sql`${id}::uuid`), sql`, `)}
    )
    order by payout.id, member.balance_transaction_id
  `)) as QueryResult).rows as Array<{
    payoutId: string;
    expectedGeneration: number;
    balanceTransactionId: string;
  }> | undefined ?? [];
  const payoutGenerations = [...new Map(closureRows.map((row) => [row.payoutId, {
    payoutId: row.payoutId, expectedGeneration: row.expectedGeneration
  }])).values()].sort((left, right) => left.payoutId < right.payoutId ? -1 : left.payoutId > right.payoutId ? 1 : 0);
  const lockBalanceTransactionIds = [...new Set([
    ...stagedIds, ...closureRows.map((row) => row.balanceTransactionId)
  ])].sort();
  throwIfFinancialSourceAborted(signal);

  return database.transaction(async (transaction) => {
    throwIfFinancialSourceAborted(signal);
    await lockActiveFinancialProjectionImplementation(transaction, {
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    });
    const facts = await lockCanonicalPaymentPurchaseFacts(transaction, {
      paymentId: routing.paymentId,
      orderId: routing.orderId,
      payment,
      charge
    });
    const current = facts.refunds.find((candidate) => candidate.id === routing.id);
    if (!current || current.paymentId !== routing.paymentId ||
      current.stripeRefundId !== refund.providerRefundId || current.status !== refund.state ||
      current.amountMinor !== refund.amountMinor || current.currency !== refund.currency.toUpperCase() ||
      current.reason !== refund.reason ||
      !sameInstant(current.providerCreatedAt, refund.providerCreatedAt)) {
      throw new RetryableFinancialError('state_changed');
    }
    await lockFinancialProjectionEnrollment(transaction);
    const discoveredActiveTips = await discoverExactActiveRefundTips(
      transaction, stagedIds
    );
    await lockFinancialProjectionRows(transaction, {
      payoutGenerations,
      balanceTransactionIds: lockBalanceTransactionIds,
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      issueKeys: [
        ...ISSUE_CODES.map((safeCode) => ({
          resourceType: 'refund' as const,
          resourceId: routing.id,
          safeCode
        })),
        ...discoveredActiveTips.flatMap((tip) =>
          ORDINARY_REFUND_SET_ISSUE_CODES.map((safeCode) => ({
            resourceType: 'allocation_set' as const,
            resourceId: tip.id,
            safeCode
          }))
        )
      ]
    });
    const lockedActiveTips = await discoverExactActiveRefundTips(
      transaction, stagedIds, true
    );
    if (!sameExactActiveRefundTips(discoveredActiveTips, lockedActiveTips)) {
      throw new RetryableFinancialError('state_changed');
    }
    throwIfFinancialSourceAborted(signal);
    const recomputed = await recomputeLockedRefundFinancialProjection(transaction, {
      orderId: routing.orderId,
      paymentId: routing.paymentId,
      refundId: routing.id,
      providerStatus: current.status,
      allocationStatus: current.allocationStatus,
      amountMinor: current.amountMinor,
      currency: current.currency,
      balanceTransactionIds: stagedIds,
      orderItems: facts.orderItems.map((item) => ({
        id: item.id,
        subtotalMinor: item.unitSubtotalMinor,
        taxMinor: item.taxMinor!,
        totalMinor: item.totalMinor!,
        currency: item.currency
      })),
      finalizedAllocations: facts.refundAllocations
        .filter((allocation) => allocation.refundId === routing.id)
        .map((allocation) => ({
          id: allocation.id,
          orderItemId: allocation.orderItemId,
          amountMinor: allocation.amountMinor
        })),
      refundComponents: facts.refundComponents
        .filter((component) => component.refundId === routing.id)
        .map((component) => ({
          refundAllocationId: component.refundAllocationId,
          orderItemId: component.orderItemId,
          subtotalMinor: component.subtotalMinor,
          taxMinor: component.taxMinor,
          currency: component.currency
        })),
      correlationId: input.correlationId
    }, lockedActiveTips.map((tip) => tip.id));
    throwIfFinancialSourceAborted(signal);
    switch (recomputed.status) {
      case 'unchanged':
        return {
          status: 'unchanged', sourceKind: 'refund', sourceId: routing.id,
          financialEvidenceStatus: 'fee_reconciled'
        };
      case 'reconciled':
        return {
          status: 'reconciled', sourceKind: 'refund', sourceId: routing.id,
          financialEvidenceStatus: 'fee_reconciled',
          allocationSetIds: recomputed.allocationSetIds,
          issueIds: recomputed.resolvedIssueIds
        };
      case 'pending':
        return {
          status: 'pending', sourceKind: 'refund', sourceId: routing.id,
          financialEvidenceStatus: 'pending', safeCode: recomputed.safeCode,
          issueId: recomputed.issueId
        };
      case 'exception':
        return {
          status: 'exception', sourceKind: 'refund', sourceId: routing.id,
          financialEvidenceStatus: 'exception', safeCode: recomputed.safeCode,
          issueId: recomputed.issueId
        };
    }
  });
}
