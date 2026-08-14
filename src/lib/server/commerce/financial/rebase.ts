import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { sql, type SQL } from 'drizzle-orm';
import { buildChargeAllocationPlan } from './allocations/charge';
import { basePlan } from './allocations/common';
import type { ClassifiedFeeDetail } from './allocations/types';
import { persistFinancialAllocationReplayPlanLocked } from './allocations/repository';
import {
  appendClassificationDecisionLocked,
  classifyBalanceTransaction,
  classifyFeeDetail
} from './classification';
import { PermanentFinancialError, RetryableFinancialError } from './errors';
import {
  observeFinancialIssue,
  resolveFinancialIssueAfterRecompute
} from './issues';
import type { FinancialClassificationSubjectJobPayload } from './jobs';
import {
  lockFinancialProjectionRows,
  type FinancialIssueLockKey
} from './locks';
import { lockOrder } from '$lib/server/commerce/lock';
import {
  lockPaymentPurchaseFacts,
  type PaymentPurchaseFacts
} from '$lib/server/commerce/reconciliation';
import type { OrderRow, PaymentRow } from '$lib/server/db/schema';
import {
  recomputeLockedRefundFinancialProjectionForVersion
} from './sources/refund';
import { recomputeLockedDisputeFinancialProjectionForVersion } from './sources/dispute';
import type {
  ClassificationReplayResult,
  CorrectionRebaseInput,
  FinancialAllocationPlan,
  FinancialClassificationDecision,
  LockedRefundProjectionInput
} from './types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const SAFE_MONEY_MAX = 99_999_999;

type QueryResult = { rows?: unknown[] };

async function rows(transaction: DatabaseTransaction, query: SQL): Promise<unknown[]> {
  return ((await transaction.execute(query)) as QueryResult).rows ?? [];
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function safeMoney(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= -SAFE_MONEY_MAX &&
    (value as number) <= SAFE_MONEY_MAX;
}

function invalid(): never {
  throw new PermanentFinancialError('source_linkage_mismatch');
}

function assertCorrectionRebaseInput(
  value: unknown
): asserts value is CorrectionRebaseInput {
  if (!exact(value, [
    'balanceTransactionId', 'basis', 'previousAllocationSetId',
    'replacementAllocationSetId', 'approvedCorrectionSetId',
    'expectedSourceFingerprint', 'correlationId'
  ]) || !UUID_PATTERN.test(value.balanceTransactionId as string) ||
    (value.basis !== 'gross_amount' && value.basis !== 'fee') ||
    !UUID_PATTERN.test(value.previousAllocationSetId as string) ||
    !UUID_PATTERN.test(value.replacementAllocationSetId as string) ||
    value.previousAllocationSetId === value.replacementAllocationSetId ||
    !UUID_PATTERN.test(value.approvedCorrectionSetId as string) ||
    !FINGERPRINT_PATTERN.test(value.expectedSourceFingerprint as string) ||
    typeof value.correlationId !== 'string' || value.correlationId.length < 1 ||
    value.correlationId.length > 100) invalid();
}

interface CorrectionSetRow {
  readonly id: string;
  readonly refundId: string;
  readonly correctionVersion: number;
  readonly baseAllocationSetId: string;
  readonly predecessorCorrectionSetId: string | null;
  readonly sourceFingerprint: string;
  readonly approvedByAdminId: string;
  readonly refundStatus: string;
  readonly refundAllocationStatus: string;
  readonly successorId?: string | null;
  readonly successorKind?: string | null;
  readonly successorCorrectionVersion?: number | null;
  readonly successorPredecessorCorrectionSetId?: string | null;
  readonly successorBaseAllocationSetId?: string | null;
  readonly successorSourceFingerprint?: string | null;
}

interface AllocationSetRow {
  readonly id: string;
  readonly balanceTransactionId: string;
  readonly basis: 'gross_amount' | 'fee';
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly currency: string;
  readonly expectedEffectMinor: number;
  readonly sourceFingerprint: string;
  readonly supersedesSetId: string | null;
  readonly classifierVersion: number;
  readonly algorithmVersion: number;
}

interface AllocationRebaseMapping {
  readonly previous: AllocationSetRow;
  readonly replacement: AllocationSetRow;
}

interface CorrectionItemRow {
  readonly domain: 'presentment' | 'settlement';
  readonly sourceAllocationSetId: string | null;
  readonly orderItemId: string;
  readonly component: string;
  readonly currency: string;
  readonly approvedAbsoluteMinor: number;
  readonly deltaMinor: number;
  readonly stableTieBreakKey: string;
}

interface AllocationItemRow {
  readonly sourceAllocationSetId: string;
  readonly orderItemId: string;
  readonly component: string;
  readonly effectMinor: number;
  readonly currency: string;
}

interface PresentmentBaseRow {
  readonly orderItemId: string;
  readonly component: string;
  readonly currency: string;
  readonly baseMinor: number;
  readonly cumulativeOtherRefundMinor: string;
  readonly capacityMinor: number;
}

interface RebasedItem extends CorrectionItemRow {
  readonly sourceAllocationSetId: string | null;
  readonly deltaMinor: number;
}

function itemKey(value: {
  readonly orderItemId: string;
  readonly component: string;
  readonly currency: string;
}): string {
  return `${value.orderItemId}\u0000${value.component}\u0000${value.currency}`;
}

function bigintText(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]{0,18})$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function isBoundedCorrectionCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (candidate.code === '23505' && (
    candidate.constraint === 'refund_reporting_correction_sets_identity_unique' ||
    candidate.constraint === 'refund_reporting_correction_sets_successor_unique'
  )) return true;
  return candidate.cause !== error && isBoundedCorrectionCollision(candidate.cause);
}

function isCanonicalCorrectionSuccessor(
  row: unknown,
  correction: CorrectionSetRow,
  input: CorrectionRebaseInput
): row is { readonly id: string } {
  if (!row || typeof row !== 'object') return false;
  const candidate = row as {
    id?: unknown; kind?: unknown; correctionVersion?: unknown;
    predecessorCorrectionSetId?: unknown; baseAllocationSetId?: unknown;
    sourceFingerprint?: unknown;
  };
  return typeof candidate.id === 'string' && UUID_PATTERN.test(candidate.id) &&
    candidate.kind === 'classifier_rebase' &&
    candidate.correctionVersion === correction.correctionVersion + 1 &&
    candidate.predecessorCorrectionSetId === correction.id &&
    candidate.baseAllocationSetId === input.replacementAllocationSetId &&
    candidate.sourceFingerprint === input.expectedSourceFingerprint;
}

function isCorrectionItem(value: unknown): value is CorrectionItemRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CorrectionItemRow>;
  return (row.domain === 'presentment' || row.domain === 'settlement') &&
    (row.sourceAllocationSetId === null ||
      (typeof row.sourceAllocationSetId === 'string' && UUID_PATTERN.test(row.sourceAllocationSetId))) &&
    typeof row.orderItemId === 'string' && UUID_PATTERN.test(row.orderItemId) &&
    typeof row.component === 'string' && row.component.length > 0 && row.component.length <= 100 &&
    typeof row.currency === 'string' && CURRENCY_PATTERN.test(row.currency) &&
    safeMoney(row.approvedAbsoluteMinor) && safeMoney(row.deltaMinor) &&
    typeof row.stableTieBreakKey === 'string' && row.stableTieBreakKey.length > 0 &&
    row.stableTieBreakKey.length <= 255 &&
    ((row.domain === 'presentment' && row.sourceAllocationSetId === null) ||
      (row.domain === 'settlement' && row.sourceAllocationSetId !== null));
}

function validateAllocationMappings(
  allocations: readonly AllocationSetRow[],
  correctionItems: readonly CorrectionItemRow[],
  input: CorrectionRebaseInput,
  correction: CorrectionSetRow
): readonly AllocationRebaseMapping[] {
  if (allocations.some((row) => !UUID_PATTERN.test(row.id) ||
    !UUID_PATTERN.test(row.balanceTransactionId) ||
    (row.basis !== 'gross_amount' && row.basis !== 'fee') ||
    row.sourceKind !== 'refund' || !UUID_PATTERN.test(row.sourceId) ||
    !CURRENCY_PATTERN.test(row.currency) || !safeMoney(row.expectedEffectMinor) ||
    !FINGERPRINT_PATTERN.test(row.sourceFingerprint) ||
    (row.supersedesSetId !== null && !UUID_PATTERN.test(row.supersedesSetId)) ||
    !positiveInt32(row.classifierVersion) || !positiveInt32(row.algorithmVersion))) invalid();
  const sourceIds = [...new Set(correctionItems.flatMap((item) =>
    item.domain === 'settlement' && item.sourceAllocationSetId !== null
      ? [item.sourceAllocationSetId]
      : []))].sort();
  if (sourceIds.length === 0 || !sourceIds.includes(correction.baseAllocationSetId)) invalid();
  const byId = new Map(allocations.map((row) => [row.id, row]));
  if (byId.size !== allocations.length) invalid();
  const mappings = sourceIds.map((sourceId) => {
    const previous = byId.get(sourceId);
    const successors = allocations.filter((row) => row.supersedesSetId === sourceId);
    if (!previous || successors.length !== 1) invalid();
    return { previous, replacement: successors[0]! };
  });
  const anchor = mappings.find((mapping) =>
    mapping.previous.id === input.previousAllocationSetId);
  if (!anchor || correction.baseAllocationSetId !== anchor.previous.id ||
    anchor.replacement.id !== input.replacementAllocationSetId ||
    anchor.previous.balanceTransactionId !== input.balanceTransactionId ||
    anchor.previous.basis !== input.basis) invalid();
  const targetClassifierVersion = anchor.replacement.classifierVersion;
  const targetAlgorithmVersion = anchor.replacement.algorithmVersion;
  for (const { previous, replacement } of mappings) {
    if (previous.sourceKind !== 'refund' || replacement.sourceKind !== 'refund' ||
      previous.sourceId !== correction.refundId || replacement.sourceId !== correction.refundId ||
      previous.balanceTransactionId !== replacement.balanceTransactionId ||
      previous.basis !== replacement.basis || previous.currency !== replacement.currency ||
      previous.expectedEffectMinor !== replacement.expectedEffectMinor ||
      previous.sourceFingerprint !== input.expectedSourceFingerprint ||
      replacement.sourceFingerprint !== input.expectedSourceFingerprint ||
      replacement.supersedesSetId !== previous.id ||
      replacement.classifierVersion !== targetClassifierVersion ||
      replacement.algorithmVersion !== targetAlgorithmVersion) invalid();
  }
  return mappings;
}

function buildRebasedItems(
  correctionItems: readonly CorrectionItemRow[],
  replacementItems: readonly AllocationItemRow[],
  presentmentBases: readonly PresentmentBaseRow[],
  mappings: readonly AllocationRebaseMapping[]
): RebasedItem[] | null {
  if (correctionItems.length === 0 || correctionItems.some((item) => !isCorrectionItem(item))) {
    return null;
  }
  const hasPresentmentDistribution = correctionItems.some(
    (item) => item.domain === 'presentment'
  );
  const tieKeys = new Set<string>();
  const identities = new Set<string>();
  for (const item of correctionItems) {
    const identity = `${item.domain}\u0000${item.sourceAllocationSetId ?? ''}\u0000${itemKey(item)}`;
    if (tieKeys.has(item.stableTieBreakKey) || identities.has(identity)) return null;
    tieKeys.add(item.stableTieBreakKey);
    identities.add(identity);
  }

  const mappingByPrevious = new Map(mappings.map((mapping) =>
    [mapping.previous.id, mapping]));
  const mappingByReplacement = new Map(mappings.map((mapping) =>
    [mapping.replacement.id, mapping]));
  if (mappingByPrevious.size !== mappings.length || mappingByReplacement.size !== mappings.length) {
    return null;
  }
  const replacementByKey = new Map<string, AllocationItemRow>();
  for (const item of replacementItems) {
    const mapping = mappingByReplacement.get(item.sourceAllocationSetId);
    const key = `${item.sourceAllocationSetId}\u0000${itemKey(item)}`;
    if (!mapping || !UUID_PATTERN.test(item.orderItemId) ||
      !safeMoney(item.effectMinor) || item.currency !== mapping.replacement.currency ||
      replacementByKey.has(key)) return null;
    replacementByKey.set(key, item);
  }
  if (presentmentBases.some((row) => !UUID_PATTERN.test(row.orderItemId) ||
    typeof row.component !== 'string' || row.component.length < 1 ||
    row.component.length > 100 || !CURRENCY_PATTERN.test(row.currency) ||
    !safeMoney(row.baseMinor) || row.baseMinor < 0 ||
    bigintText(row.cumulativeOtherRefundMinor) === null ||
    bigintText(row.cumulativeOtherRefundMinor)! < 0n ||
    !safeMoney(row.capacityMinor) || row.capacityMinor < 0)) return null;
  const presentmentByKey = new Map(presentmentBases.map((row) => [itemKey(row), row]));
  if (presentmentByKey.size !== presentmentBases.length) return null;
  const presentmentCorrectionKeys = new Set(correctionItems.flatMap((item) =>
    item.domain === 'presentment' ? [itemKey(item)] : []));
  if (hasPresentmentDistribution && presentmentBases.some((row) =>
      row.baseMinor !== 0 && !presentmentCorrectionKeys.has(itemKey(row)))) return null;
  const usedReplacement = new Set<string>();
  const rebased: RebasedItem[] = [];
  for (const item of correctionItems) {
    if (item.domain === 'settlement' && item.sourceAllocationSetId !== null) {
      const mapping = mappingByPrevious.get(item.sourceAllocationSetId);
      if (!mapping || item.currency !== mapping.replacement.currency) return null;
      const key = `${mapping.replacement.id}\u0000${itemKey(item)}`;
      const base = replacementByKey.get(key);
      const baseMinor = base?.effectMinor ?? 0;
      const delta = BigInt(item.approvedAbsoluteMinor) - BigInt(baseMinor);
      if (delta < BigInt(-SAFE_MONEY_MAX) || delta > BigInt(SAFE_MONEY_MAX)) return null;
      if (base) usedReplacement.add(key);
      rebased.push({ ...item, sourceAllocationSetId: mapping.replacement.id,
        deltaMinor: Number(delta) });
      continue;
    }
    const base = presentmentByKey.get(itemKey(item));
    const cumulativeOtherRefundMinor = bigintText(base?.cumulativeOtherRefundMinor);
    if (!base || base.currency !== item.currency || !safeMoney(base.baseMinor) ||
      cumulativeOtherRefundMinor === null || !safeMoney(base.capacityMinor) ||
      item.approvedAbsoluteMinor < 0 ||
      cumulativeOtherRefundMinor + BigInt(item.approvedAbsoluteMinor) < 0n ||
      cumulativeOtherRefundMinor + BigInt(item.approvedAbsoluteMinor) >
        BigInt(base.capacityMinor)) return null;
    const delta = BigInt(item.approvedAbsoluteMinor) - BigInt(base.baseMinor);
    if (delta < BigInt(-SAFE_MONEY_MAX) || delta > BigInt(SAFE_MONEY_MAX)) return null;
    rebased.push({ ...item, deltaMinor: Number(delta) });
  }
  if ([...replacementByKey.keys()].some((key) => !usedReplacement.has(key) &&
    replacementByKey.get(key)!.effectMinor !== 0)) return null;

  const deltaSums = new Map<string, bigint>();
  const approvedSums = new Map<string, bigint>();
  for (const item of rebased) {
    const group = `${item.domain}\u0000${item.sourceAllocationSetId ?? ''}\u0000${item.currency}`;
    deltaSums.set(group, (deltaSums.get(group) ?? 0n) + BigInt(item.deltaMinor));
    approvedSums.set(group,
      (approvedSums.get(group) ?? 0n) + BigInt(item.approvedAbsoluteMinor));
  }
  if ([...deltaSums.values()].some((sum) => sum !== 0n)) return null;
  for (const { replacement } of mappings) {
    const settlementGroup = `settlement\u0000${replacement.id}\u0000${replacement.currency}`;
    if (approvedSums.get(settlementGroup) !== BigInt(replacement.expectedEffectMinor)) return null;
  }
  if (hasPresentmentDistribution) {
    const presentmentCurrencyTotals = new Map<string, bigint>();
    for (const base of presentmentBases) {
      presentmentCurrencyTotals.set(base.currency,
        (presentmentCurrencyTotals.get(base.currency) ?? 0n) + BigInt(base.baseMinor));
    }
    for (const [currency, total] of presentmentCurrencyTotals) {
      if (approvedSums.get(`presentment\u0000\u0000${currency}`) !== total) return null;
    }
  }
  return rebased.sort((left, right) =>
    left.stableTieBreakKey < right.stableTieBreakKey ? -1 :
      left.stableTieBreakKey > right.stableTieBreakKey ? 1 : 0);
}

async function rebaseFailed(
  transaction: DatabaseTransaction,
  input: CorrectionRebaseInput
): Promise<{ status: 'exception'; issueId: string }> {
  const issue = await observeFinancialIssue(transaction, {
    resourceType: 'balance_transaction', resourceId: input.balanceTransactionId,
    safeCode: 'correction_rebase_required', impact: 'exception',
    actor: { type: 'system', id: 'financial-worker' }, correlationId: input.correlationId
  });
  await appendCorrectionRebaseFailedAudit(transaction, {
    balanceTransactionId: input.balanceTransactionId,
    approvedCorrectionSetId: input.approvedCorrectionSetId,
    previousAllocationSetId: input.previousAllocationSetId,
    replacementAllocationSetId: input.replacementAllocationSetId,
    correlationId: input.correlationId
  });
  return { status: 'exception', issueId: issue.id };
}

async function appendCorrectionRebaseFailedAudit(
  transaction: DatabaseTransaction,
  input: {
    readonly balanceTransactionId: string;
    readonly approvedCorrectionSetId: string;
    readonly previousAllocationSetId: string;
    readonly replacementAllocationSetId: string | null;
    readonly correlationId: string;
  }
): Promise<void> {
  await rows(transaction, sql`
    insert into audit_events
      (actor_type, actor_id, action, outcome, resource_type, resource_id,
        correlation_id, after)
    values ('system', 'financial-worker', 'financial.correction.rebase_failed',
      'failed', 'balance_transaction', ${input.balanceTransactionId},
      ${input.correlationId},
      ${JSON.stringify({ safeCode: 'correction_rebase_required',
        approvedCorrectionSetId: input.approvedCorrectionSetId,
        previousAllocationSetId: input.previousAllocationSetId,
        replacementAllocationSetId: input.replacementAllocationSetId })}::jsonb)
  `);
}

async function resolveCorrectionRebaseIssue(
  transaction: DatabaseTransaction,
  input: Pick<CorrectionRebaseInput, 'balanceTransactionId' | 'correlationId'>
): Promise<void> {
  await resolveFinancialIssueAfterRecompute(transaction, {
    resourceType: 'balance_transaction', resourceId: input.balanceTransactionId,
    safeCode: 'correction_rebase_required',
    proof: { status: 'resolved', resourceType: 'balance_transaction',
      resourceId: input.balanceTransactionId,
      safeCode: 'correction_rebase_required' },
    actor: { type: 'system', id: 'financial-worker' },
    correlationId: input.correlationId
  });
}

export interface FinancialClassificationReplayDependencies {
  readonly database: Database;
  readonly targetClassifierVersion: number;
  readonly targetAllocationAlgorithmVersion: number;
}

export interface FinancialClassificationReplayInput {
  readonly payload: FinancialClassificationSubjectJobPayload;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}

export interface FinancialProjectionAuthority {
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
  readonly pendingClassifierVersion: number | null;
  readonly pendingAllocationAlgorithmVersion: number | null;
  readonly pendingReplayId: string | null;
  readonly pendingScanRunId: string | null;
}

function positiveInt32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 &&
    (value as number) <= 2_147_483_647;
}

function canonicalFinancialProjectionAuthority(
  authorityRows: Array<Record<string, unknown>>
): FinancialProjectionAuthority {
  const raw = authorityRows[0];
  if (!raw || authorityRows.length !== 1 || !positiveInt32(raw.classifierVersion) ||
    !positiveInt32(raw.allocationAlgorithmVersion)) invalid();
  const pendingClassifierVersion = raw.pendingClassifierVersion ?? null;
  const pendingAllocationAlgorithmVersion = raw.pendingAllocationAlgorithmVersion ?? null;
  const pendingReplayId = raw.pendingReplayId ?? null;
  const pendingScanRunId = raw.pendingScanRunId ?? null;
  const pendingValues = [pendingClassifierVersion, pendingAllocationAlgorithmVersion,
    pendingReplayId, pendingScanRunId];
  const hasPending = pendingValues.every((value) => value !== null);
  if (!hasPending && pendingValues.some((value) => value !== null)) invalid();
  if (hasPending && (!positiveInt32(pendingClassifierVersion) ||
    !positiveInt32(pendingAllocationAlgorithmVersion) ||
    typeof pendingReplayId !== 'string' ||
    pendingReplayId !== `c${pendingClassifierVersion}-a${pendingAllocationAlgorithmVersion}` ||
    typeof pendingScanRunId !== 'string' || !UUID_PATTERN.test(pendingScanRunId) ||
    pendingClassifierVersion < raw.classifierVersion ||
    pendingAllocationAlgorithmVersion < raw.allocationAlgorithmVersion ||
    (pendingClassifierVersion === raw.classifierVersion &&
      pendingAllocationAlgorithmVersion === raw.allocationAlgorithmVersion))) invalid();
  return {
    classifierVersion: raw.classifierVersion,
    allocationAlgorithmVersion: raw.allocationAlgorithmVersion,
    pendingClassifierVersion: hasPending ? pendingClassifierVersion as number : null,
    pendingAllocationAlgorithmVersion:
      hasPending ? pendingAllocationAlgorithmVersion as number : null,
    pendingReplayId: hasPending ? pendingReplayId as string : null,
    pendingScanRunId: hasPending ? pendingScanRunId as string : null
  };
}

export async function loadFinancialProjectionAuthority(
  transaction: DatabaseTransaction
): Promise<FinancialProjectionAuthority> {
  return canonicalFinancialProjectionAuthority(await rows(transaction, sql`
    select classifier_version as "classifierVersion",
      allocation_algorithm_version as "allocationAlgorithmVersion",
      pending_classifier_version as "pendingClassifierVersion",
      pending_allocation_algorithm_version as "pendingAllocationAlgorithmVersion",
      pending_replay_id as "pendingReplayId",
      pending_scan_run_id as "pendingScanRunId"
    from financial_projection_versions
    where singleton = true
  `) as Array<Record<string, unknown>>);
}

export async function lockFinancialProjectionAuthority(
  transaction: DatabaseTransaction
): Promise<FinancialProjectionAuthority> {
  return canonicalFinancialProjectionAuthority(await rows(transaction, sql`
    select classifier_version as "classifierVersion",
      allocation_algorithm_version as "allocationAlgorithmVersion",
      pending_classifier_version as "pendingClassifierVersion",
      pending_allocation_algorithm_version as "pendingAllocationAlgorithmVersion",
      pending_replay_id as "pendingReplayId",
      pending_scan_run_id as "pendingScanRunId"
    from financial_projection_versions
    where singleton = true
    for update
  `) as Array<Record<string, unknown>>);
}

/**
 * Serializes every operation that can publish or enroll projection graph evidence. Callers that
 * lock the version authority must do so before this fence; commerce graph publishers take only
 * this fence and read the authority without a row lock.
 */
export async function lockFinancialProjectionEnrollment(
  transaction: DatabaseTransaction
): Promise<void> {
  await rows(transaction, sql`
    select pg_advisory_xact_lock(hashtextextended(
      ${'pale-orbit:financial:replay-enrollment'}, 0
    ))
  `);
}

interface ClassificationReplayLockedInput extends FinancialClassificationSubjectJobPayload {
  readonly correlationId: string;
}

interface ReplayBalanceRow {
  readonly id: string;
  readonly fingerprintSha256: string;
  readonly requestedFingerprintSha256?: string;
  readonly sourceFamily:
    | 'charge' | 'refund' | 'dispute' | 'payout' | 'adjustment' | 'unknown' | null;
  readonly sourceId: string | null;
  readonly rawType: string;
  readonly reportingCategory: string;
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly netMinor: number;
  readonly currency: string;
}

interface ReplayFeeDetailRow {
  readonly id: string;
  readonly balanceTransactionId?: string;
  readonly rawType: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly fingerprintSha256: string;
}

interface ReplayAllocationTipRow {
  readonly id: string;
  readonly balanceTransactionId?: string;
  readonly basis: 'gross_amount' | 'fee';
  readonly allocationIdentity: string;
  readonly supersedesSetId: string | null;
  readonly reversalOfSetId: string | null;
  readonly classifierVersion: number;
  readonly algorithmVersion: number;
}

interface ReplayOrderItemRow {
  readonly id: string;
  readonly orderId: string;
  readonly unitSubtotalMinor: number;
  readonly taxMinor: number | null;
  readonly currency: string;
}

interface RequiredActiveProjectionPredecessor {
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
}

function assertClassificationReplayLockedInput(
  value: unknown
): asserts value is ClassificationReplayLockedInput {
  if (!exact(value, [
    'subjectType', 'subjectId', 'sourceFingerprintSha256', 'classifierVersion',
    'allocationAlgorithmVersion', 'replayId', 'correlationId'
  ]) || (value.subjectType !== 'balance_transaction' && value.subjectType !== 'fee_detail') ||
    !UUID_PATTERN.test(value.subjectId as string) ||
    !FINGERPRINT_PATTERN.test(value.sourceFingerprintSha256 as string) ||
    !positiveInt32(value.classifierVersion) ||
    !positiveInt32(value.allocationAlgorithmVersion) ||
    value.replayId !== `c${value.classifierVersion}-a${value.allocationAlgorithmVersion}` ||
    typeof value.correlationId !== 'string' || value.correlationId.length < 1 ||
    value.correlationId.length > 100) invalid();
}

function validateReplayBalance(value: ReplayBalanceRow): void {
  if (!UUID_PATTERN.test(value.id) || !FINGERPRINT_PATTERN.test(value.fingerprintSha256) ||
    !['charge', 'refund', 'dispute', 'payout', 'adjustment', 'unknown', null]
      .includes(value.sourceFamily) ||
    (value.sourceId !== null && (typeof value.sourceId !== 'string' ||
      value.sourceId.length < 1 || value.sourceId.length > 255)) ||
    typeof value.rawType !== 'string' || value.rawType.length < 1 || value.rawType.length > 100 ||
    typeof value.reportingCategory !== 'string' || value.reportingCategory.length < 1 ||
    value.reportingCategory.length > 100 || !safeMoney(value.amountMinor) ||
    !safeMoney(value.feeMinor) || value.feeMinor < 0 || !safeMoney(value.netMinor) ||
    BigInt(value.amountMinor) - BigInt(value.feeMinor) !== BigInt(value.netMinor) ||
    !CURRENCY_PATTERN.test(value.currency)) invalid();
}

async function discoverReplayBalance(
  transaction: DatabaseTransaction,
  input: ClassificationReplayLockedInput,
  lock: boolean
): Promise<ReplayBalanceRow> {
  const lockClause = lock ? sql`for update of balance` : sql``;
  const candidates = await rows(transaction, input.subjectType === 'balance_transaction'
    ? sql`
      select balance.id, balance.fingerprint_sha256 as "fingerprintSha256",
        balance.fingerprint_sha256 as "requestedFingerprintSha256",
        balance.source_family as "sourceFamily", balance.source_id as "sourceId",
        balance.raw_type as "rawType", balance.reporting_category as "reportingCategory",
        balance.amount_minor as "amountMinor", balance.fee_minor as "feeMinor",
        balance.net_minor as "netMinor", balance.currency
      from stripe_balance_transactions balance
      where balance.id = ${input.subjectId}
      ${lockClause}
    `
    : sql`
      select balance.id, balance.fingerprint_sha256 as "fingerprintSha256",
        detail.fingerprint_sha256 as "requestedFingerprintSha256",
        balance.source_family as "sourceFamily", balance.source_id as "sourceId",
        balance.raw_type as "rawType", balance.reporting_category as "reportingCategory",
        balance.amount_minor as "amountMinor", balance.fee_minor as "feeMinor",
        balance.net_minor as "netMinor", balance.currency
      from stripe_balance_transaction_fee_details detail
      join stripe_balance_transactions balance on balance.id = detail.balance_transaction_id
      where detail.id = ${input.subjectId}
      ${lockClause}
    `) as ReplayBalanceRow[];
  const balance = candidates[0];
  if (!balance || candidates.length !== 1 ||
    (balance.requestedFingerprintSha256 ?? balance.fingerprintSha256) !==
      input.sourceFingerprintSha256) invalid();
  validateReplayBalance(balance);
  return balance;
}

type ReplayGraph =
  | {
      readonly sourceKind: 'payment' | 'refund' | 'dispute';
      readonly sourceId: string;
      readonly paymentId: string;
      readonly orderId: string;
      readonly orderItems: readonly ReplayOrderItemRow[];
      readonly purchaseFacts: PaymentPurchaseFacts;
    }
  | {
      readonly sourceKind: 'payout';
      readonly sourceId: string;
      readonly payoutGeneration: number;
      readonly paymentId: null;
      readonly orderId: null;
      readonly orderItems: readonly [];
    }
  | {
      readonly sourceKind: 'adjustment';
      readonly sourceId: string;
      readonly paymentId: null;
      readonly orderId: null;
      readonly orderItems: readonly [];
      readonly accountFallback: boolean;
    };

async function loadReplayRoutingRows(
  transaction: DatabaseTransaction,
  balance: ReplayBalanceRow
): Promise<unknown[]> {
  if (balance.sourceFamily === 'charge') {
    return rows(transaction, sql`
      select payment.id, payment.id as "paymentId", payment.order_id as "orderId"
      from payments payment where payment.stripe_latest_charge_id = ${balance.sourceId}
    `);
  }
  if (balance.sourceFamily === 'refund') {
    return rows(transaction, sql`
      select refund.id, refund.payment_id as "paymentId", payment.order_id as "orderId"
      from refunds refund join payments payment on payment.id = refund.payment_id
      where refund.stripe_refund_id = ${balance.sourceId}
    `);
  }
  if (balance.sourceFamily === 'dispute') {
    return rows(transaction, sql`
      select dispute.id, dispute.payment_id as "paymentId", payment.order_id as "orderId"
      from disputes dispute join payments payment on payment.id = dispute.payment_id
      where dispute.stripe_dispute_id = ${balance.sourceId}
    `);
  }
  invalid();
}

async function lockReplayGraph(
  transaction: DatabaseTransaction,
  balance: ReplayBalanceRow
): Promise<ReplayGraph> {
  if (balance.sourceFamily === 'adjustment' ||
    balance.sourceFamily === 'unknown' || balance.sourceFamily === null) {
    return { sourceKind: 'adjustment', sourceId: balance.id,
      paymentId: null, orderId: null, orderItems: [], accountFallback: false };
  }
  if (balance.sourceFamily === 'payout') {
    if (balance.sourceId === null) invalid();
    const payoutRows = await rows(transaction, sql`
      select id, financial_generation as "payoutGeneration"
      from stripe_payouts where provider_id = ${balance.sourceId}
    `) as Array<{ id: string; payoutGeneration: number }>;
    const payout = payoutRows[0];
    if (!payout || payoutRows.length !== 1 || !UUID_PATTERN.test(payout.id) ||
      !Number.isSafeInteger(payout.payoutGeneration) || payout.payoutGeneration < 0 ||
      payout.payoutGeneration > 2_147_483_647) invalid();
    return { sourceKind: 'payout', sourceId: payout.id,
      payoutGeneration: payout.payoutGeneration,
      paymentId: null, orderId: null, orderItems: [] };
  }
  const routingRows = await loadReplayRoutingRows(transaction, balance);
  if (routingRows.length === 0) {
    const memberships = await rows(transaction, sql`
      select payout_id from stripe_payout_balance_transactions
      where balance_transaction_id = ${balance.id}
    `);
    if (memberships.length !== 1) invalid();
    return { sourceKind: 'adjustment', sourceId: balance.id,
      paymentId: null, orderId: null, orderItems: [], accountFallback: true };
  }
  const routing = routingRows[0] as {
    id?: unknown; paymentId?: unknown; orderId?: unknown;
  } | undefined;
  if (!routing || routingRows.length !== 1 || typeof routing.id !== 'string' ||
    !UUID_PATTERN.test(routing.id) || typeof routing.paymentId !== 'string' ||
    !UUID_PATTERN.test(routing.paymentId) || typeof routing.orderId !== 'string' ||
    !UUID_PATTERN.test(routing.orderId)) invalid();

  await lockOrder(transaction, routing.orderId);
  const orderRows = await rows(transaction, sql`
    select id, status, initiating_user_id as "initiatingUserId",
      guest_identity_id as "guestIdentityId", purchase_email as "purchaseEmail",
      currency, subtotal_minor as "subtotalMinor", tax_minor as "taxMinor",
      total_minor as "totalMinor", client_checkout_attempt_id as "clientCheckoutAttemptId",
      quote_fingerprint_sha256 as "quoteFingerprintSha256",
      stripe_checkout_session_id as "stripeCheckoutSessionId",
      status_token_sha256 as "statusTokenSha256",
      checkout_expires_at as "checkoutExpiresAt", paid_at as "paidAt",
      created_at as "createdAt", updated_at as "updatedAt"
    from orders where id = ${routing.orderId} for update
  `) as OrderRow[];
  const paymentRows = await rows(transaction, sql`
    select id, order_id as "orderId",
      stripe_payment_intent_id as "stripePaymentIntentId",
      stripe_latest_charge_id as "stripeLatestChargeId", status,
      amount_minor as "amountMinor", currency,
      payment_method_category as "paymentMethodCategory", paid_at as "paidAt",
      financial_evidence_status as "financialEvidenceStatus",
      created_at as "createdAt", updated_at as "updatedAt"
    from payments where id = ${routing.paymentId} and order_id = ${routing.orderId}
    for update
  `) as PaymentRow[];
  const order = orderRows[0];
  const payment = paymentRows[0];
  if (!order || orderRows.length !== 1 || !payment || paymentRows.length !== 1 ||
    order.id !== routing.orderId || payment.id !== routing.paymentId ||
    payment.orderId !== order.id) invalid();
  const purchaseFacts = await lockPaymentPurchaseFacts(transaction, payment, order);
  const sourceMatches = balance.sourceFamily === 'charge'
    ? purchaseFacts.payment.stripeLatestChargeId === balance.sourceId &&
      routing.id === purchaseFacts.payment.id
    : balance.sourceFamily === 'refund'
      ? purchaseFacts.refunds.filter((row) => row.id === routing.id &&
          row.stripeRefundId === balance.sourceId).length === 1
      : balance.sourceFamily === 'dispute'
        ? purchaseFacts.disputes.filter((row) => row.id === routing.id &&
            row.stripeDisputeId === balance.sourceId).length === 1
        : false;
  if (!sourceMatches) invalid();
  const orderItems: ReplayOrderItemRow[] = purchaseFacts.orderItems.map((item) => ({
    id: item.id,
    orderId: item.orderId,
    unitSubtotalMinor: item.unitSubtotalMinor,
    taxMinor: item.taxMinor,
    currency: item.currency
  }));
  if (orderItems.length === 0 || orderItems.some((item) =>
    !UUID_PATTERN.test(item.id) || item.orderId !== routing.orderId ||
    !safeMoney(item.unitSubtotalMinor) || item.unitSubtotalMinor < 0 ||
    !safeMoney(item.taxMinor) || (item.taxMinor as number) < 0 ||
    !CURRENCY_PATTERN.test(item.currency))) invalid();
  return {
    sourceKind: balance.sourceFamily === 'charge' ? 'payment' : balance.sourceFamily,
    sourceId: routing.id, paymentId: routing.paymentId, orderId: routing.orderId,
    orderItems, purchaseFacts
  };
}

async function discoverReplaySourceBalances(
  transaction: DatabaseTransaction,
  discovered: ReplayBalanceRow,
  graph: ReplayGraph
): Promise<readonly ReplayBalanceRow[]> {
  if (graph.sourceKind !== 'refund' && graph.sourceKind !== 'dispute') {
    return [discovered];
  }
  const providerSourceIds = graph.sourceKind === 'refund'
    ? graph.purchaseFacts.refunds
        .filter((row) => row.id === graph.sourceId)
        .map((row) => row.stripeRefundId)
    : graph.purchaseFacts.disputes.map((row) => row.stripeDisputeId);
  if (providerSourceIds.length === 0 || providerSourceIds.some((id) =>
    typeof id !== 'string' || id.length < 1 || id.length > 255)) invalid();
  const balances = await rows(transaction, sql`
    select balance.id, balance.fingerprint_sha256 as "fingerprintSha256",
      balance.source_family as "sourceFamily", balance.source_id as "sourceId",
      balance.raw_type as "rawType", balance.reporting_category as "reportingCategory",
      balance.amount_minor as "amountMinor", balance.fee_minor as "feeMinor",
      balance.net_minor as "netMinor", balance.currency
    from stripe_balance_transactions balance
    where balance.source_family = ${graph.sourceKind}
      and balance.source_id in (${sql.join(providerSourceIds.map((id) => sql`${id}`), sql`, `)})
    order by balance.provider_created_at, balance.provider_id, balance.id
  `) as ReplayBalanceRow[];
  if (balances.length === 0 || !balances.some((row) => row.id === discovered.id) ||
    new Set(balances.map((row) => row.id)).size !== balances.length) invalid();
  for (const balance of balances) {
    validateReplayBalance(balance);
    if (balance.sourceFamily !== graph.sourceKind || balance.sourceId === null ||
      !providerSourceIds.includes(balance.sourceId)) invalid();
  }
  return balances;
}

function componentForFeeDecision(
  decision: FinancialClassificationDecision
): ClassifiedFeeDetail['component'] | null {
  if (decision.status === 'unknown') return null;
  const components = {
    processing_fee: 'processing_fee', refund_fee: 'refund_fee',
    dispute_fee: 'dispute_fee', provider_fee_tax: 'provider_fee_tax',
    fee_credit: 'fee_credit', other: 'other'
  } as const;
  return components[decision.classification as keyof typeof components] ?? null;
}

function accountFallbackClassificationMatches(
  balance: ReplayBalanceRow,
  decision: FinancialClassificationDecision
): boolean {
  if (balance.sourceFamily === 'charge') {
    return decision.classification === 'charge' && balance.amountMinor > 0;
  }
  if (balance.sourceFamily === 'refund') {
    return (decision.classification === 'refund' && balance.amountMinor < 0) ||
      (decision.classification === 'refund_failure' && balance.amountMinor > 0);
  }
  if (balance.sourceFamily === 'dispute') {
    return (decision.classification === 'dispute_withdrawal' && balance.amountMinor < 0) ||
      (['dispute_reinstatement', 'fee_credit'].includes(decision.classification) &&
        balance.amountMinor > 0);
  }
  return false;
}

function predecessorForReplay(
  current: ReplayAllocationTipRow | undefined,
  desiredIdentity: string
): string | null {
  if (!current) return null;
  return current.allocationIdentity === desiredIdentity
    ? current.supersedesSetId
    : current.id;
}

export async function replayFinancialClassificationLocked(
  transaction: DatabaseTransaction,
  input: ClassificationReplayLockedInput,
  requiredActivePredecessor: RequiredActiveProjectionPredecessor | null = null
): Promise<ClassificationReplayResult> {
  assertClassificationReplayLockedInput(input);
  if (requiredActivePredecessor !== null &&
    (!exact(requiredActivePredecessor, ['classifierVersion', 'allocationAlgorithmVersion']) ||
      !positiveInt32(requiredActivePredecessor.classifierVersion) ||
      !positiveInt32(requiredActivePredecessor.allocationAlgorithmVersion) ||
      requiredActivePredecessor.classifierVersion > input.classifierVersion ||
      requiredActivePredecessor.allocationAlgorithmVersion > input.allocationAlgorithmVersion ||
      (requiredActivePredecessor.classifierVersion === input.classifierVersion &&
        requiredActivePredecessor.allocationAlgorithmVersion ===
          input.allocationAlgorithmVersion))) invalid();
  const discovered = await discoverReplayBalance(transaction, input, false);
  const parentDecision = classifyBalanceTransaction({
    sourceFamily: discovered.sourceFamily, rawType: discovered.rawType,
    reportingCategory: discovered.reportingCategory, amountMinor: discovered.amountMinor
  });
  const graph = await lockReplayGraph(transaction, discovered);
  const sourceBalances = await discoverReplaySourceBalances(transaction, discovered, graph);
  const sourceBalanceIds = sourceBalances.map((row) => row.id).sort();
  const payoutClosure = await rows(transaction, sql`
    select payout.id as "payoutId",
      payout.financial_generation as "expectedGeneration",
      member.balance_transaction_id as "balanceTransactionId"
    from stripe_payout_balance_transactions source_membership
    join stripe_payouts payout on payout.id = source_membership.payout_id
    join stripe_payout_balance_transactions member on member.payout_id = payout.id
    where source_membership.balance_transaction_id in (${sql.join(
      sourceBalanceIds.map((id) => sql`${id}::uuid`), sql`, `
    )})
    order by payout.id, member.balance_transaction_id
  `) as Array<{
    payoutId: string;
    expectedGeneration: number;
    balanceTransactionId: string;
  }>;
  const sourcePayoutMembers = graph.sourceKind === 'payout'
    ? await rows(transaction, sql`
        select balance_transaction_id as "balanceTransactionId"
        from stripe_payout_balance_transactions where payout_id = ${graph.sourceId}
        order by balance_transaction_id
      `) as Array<{ balanceTransactionId: string }>
    : [];
  if (graph.sourceKind === 'payout' &&
    (sourcePayoutMembers.length === 0 ||
      sourcePayoutMembers.some((row) => !UUID_PATTERN.test(row.balanceTransactionId)))) invalid();
  const payoutGenerations = [...new Map([
    ...payoutClosure.map((row) => [row.payoutId, {
      payoutId: row.payoutId, expectedGeneration: row.expectedGeneration
    }] as const),
    ...(graph.sourceKind === 'payout' ? [[graph.sourceId, {
      payoutId: graph.sourceId, expectedGeneration: graph.payoutGeneration
    }] as const] : [])
  ]).values()];
  const closureBalanceTransactionIds = [...new Set([
    ...sourceBalanceIds, ...payoutClosure.map((row) => row.balanceTransactionId),
    ...sourcePayoutMembers.map((row) => row.balanceTransactionId)
  ])].sort();
  // Discover every issue identity in the complete payout closure before entering the shared
  // financial lock routine. The routine re-locks the same fee-detail set below; comparing both
  // sets makes discovery safe while preserving classifications -> allocations -> issues.
  const discoveredFeeDetails = await rows(transaction, sql`
    select id, balance_transaction_id as "balanceTransactionId"
    from stripe_balance_transaction_fee_details
    where balance_transaction_id in (${sql.join(
      closureBalanceTransactionIds.map((id) => sql`${id}::uuid`), sql`, `
    )})
    order by balance_transaction_id, ordinal
  `) as Array<{ id: string; balanceTransactionId: string }>;
  if (discoveredFeeDetails.some((detail) => !UUID_PATTERN.test(detail.id) ||
    !closureBalanceTransactionIds.includes(detail.balanceTransactionId)) ||
    new Set(discoveredFeeDetails.map((detail) => detail.id)).size !==
      discoveredFeeDetails.length) invalid();
  const issueKeys: FinancialIssueLockKey[] = sourceBalanceIds.flatMap((resourceId) =>
    ['classification_fork', 'correction_rebase_required', 'unsupported_category'].map(
      (safeCode) => ({
        resourceType: 'balance_transaction' as const,
        resourceId,
        safeCode: safeCode as FinancialIssueLockKey['safeCode']
      })
    ));
  issueKeys.push(...discoveredFeeDetails.flatMap((detail) => [
    { resourceType: 'fee_detail' as const, resourceId: detail.id,
      safeCode: 'classification_fork' as const },
    { resourceType: 'fee_detail' as const, resourceId: detail.id,
      safeCode: 'unsupported_category' as const }
  ]));
  const lockedProjection = await lockFinancialProjectionRows(transaction, {
    payoutGenerations,
    balanceTransactionIds: closureBalanceTransactionIds,
    classifierVersion: input.classifierVersion,
    issueKeys
  });
  const discoveredFeeDetailIds = discoveredFeeDetails.map((detail) => detail.id).sort();
  const lockedFeeDetailIds = [...lockedProjection.feeDetailIds].sort();
  if (lockedFeeDetailIds.length !== discoveredFeeDetailIds.length ||
    lockedFeeDetailIds.some((id, index) => id !== discoveredFeeDetailIds[index])) invalid();
  const lockedSourceBalances = await rows(transaction, sql`
    select balance.id, balance.fingerprint_sha256 as "fingerprintSha256",
      balance.source_family as "sourceFamily", balance.source_id as "sourceId",
      balance.raw_type as "rawType", balance.reporting_category as "reportingCategory",
      balance.amount_minor as "amountMinor", balance.fee_minor as "feeMinor",
      balance.net_minor as "netMinor", balance.currency
    from stripe_balance_transactions balance
    where balance.id in (${sql.join(sourceBalanceIds.map((id) => sql`${id}::uuid`), sql`, `)})
    order by balance.provider_created_at, balance.provider_id, balance.id
    for update of balance
  `) as ReplayBalanceRow[];
  if (lockedSourceBalances.length !== sourceBalances.length) invalid();
  for (const source of sourceBalances) {
    const financialLock = lockedProjection.balanceTransactions.find((row) => row.id === source.id);
    const locked = lockedSourceBalances.find((row) => row.id === source.id);
    if (!locked || !financialLock || financialLock.fingerprintSha256 !== source.fingerprintSha256 ||
      locked.fingerprintSha256 !== source.fingerprintSha256 ||
      locked.sourceFamily !== source.sourceFamily || locked.sourceId !== source.sourceId ||
      locked.rawType !== source.rawType || locked.reportingCategory !== source.reportingCategory ||
      locked.amountMinor !== source.amountMinor || locked.feeMinor !== source.feeMinor ||
      locked.netMinor !== source.netMinor || locked.currency !== source.currency) invalid();
  }
  const balance = lockedSourceBalances.find((row) => row.id === discovered.id);
  if (!balance) invalid();
  const tips = await rows(transaction, sql`
    select allocation.id, allocation.balance_transaction_id as "balanceTransactionId",
      allocation.basis,
      allocation.allocation_identity as "allocationIdentity",
      allocation.supersedes_set_id as "supersedesSetId",
      allocation.reversal_of_set_id as "reversalOfSetId",
      allocation.classifier_version as "classifierVersion",
      allocation.algorithm_version as "algorithmVersion"
    from financial_allocation_sets allocation
    where allocation.balance_transaction_id in (${sql.join(
      sourceBalanceIds.map((id) => sql`${id}::uuid`), sql`, `
    )})
      and not exists (select 1 from financial_allocation_sets successor
        where successor.supersedes_set_id = allocation.id)
    order by allocation.basis, allocation.id for update
  `) as ReplayAllocationTipRow[];
  const tipBalanceId = (tip: ReplayAllocationTipRow): string =>
    tip.balanceTransactionId ?? balance.id;
  if (tips.some((tip) => !UUID_PATTERN.test(tip.id) ||
    !sourceBalanceIds.includes(tipBalanceId(tip)) ||
    (tip.basis !== 'gross_amount' && tip.basis !== 'fee') ||
    !positiveInt32(tip.classifierVersion) || !positiveInt32(tip.algorithmVersion)) ||
    sourceBalanceIds.some((id) =>
      tips.filter((tip) => tipBalanceId(tip) === id && tip.basis === 'gross_amount').length > 1 ||
      tips.filter((tip) => tipBalanceId(tip) === id && tip.basis === 'fee').length > 1)) {
    const issue = await observeFinancialIssue(transaction, {
      resourceType: 'balance_transaction', resourceId: balance.id,
      safeCode: 'classification_fork', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: input.correlationId
    });
    return { status: 'exception', subjectId: input.subjectId,
      safeCode: 'classification_fork', issueId: issue.id };
  }
  const supersedingTips = tips.filter((tip) =>
    tip.classifierVersion >= input.classifierVersion &&
    tip.algorithmVersion >= input.allocationAlgorithmVersion &&
    (tip.classifierVersion > input.classifierVersion ||
      tip.algorithmVersion > input.allocationAlgorithmVersion));
  if (supersedingTips.length > 0) {
    if (supersedingTips.length !== tips.length) invalid();
    return { status: 'unchanged', subjectId: input.subjectId };
  }
  if (tips.some((tip) => tip.classifierVersion > input.classifierVersion ||
    tip.algorithmVersion > input.allocationAlgorithmVersion)) invalid();
  const allDetails = await rows(transaction, sql`
    select id, balance_transaction_id as "balanceTransactionId",
      raw_type as "rawType", amount_minor as "amountMinor", currency,
      fingerprint_sha256 as "fingerprintSha256"
    from stripe_balance_transaction_fee_details
    where balance_transaction_id in (${sql.join(
      sourceBalanceIds.map((id) => sql`${id}::uuid`), sql`, `
    )})
    order by balance_transaction_id, ordinal for update
  `) as ReplayFeeDetailRow[];
  const detailBalanceId = (detail: ReplayFeeDetailRow): string =>
    detail.balanceTransactionId ?? balance.id;
  if (allDetails.some((detail) => !UUID_PATTERN.test(detail.id) ||
    !sourceBalanceIds.includes(detailBalanceId(detail)) ||
    !FINGERPRINT_PATTERN.test(detail.fingerprintSha256) ||
    typeof detail.rawType !== 'string' || detail.rawType.length < 1 ||
    detail.rawType.length > 100 || !safeMoney(detail.amountMinor) ||
    detail.amountMinor < 0 || detail.currency !== lockedSourceBalances.find((candidate) =>
      candidate.id === detailBalanceId(detail))?.currency) ||
    lockedSourceBalances.some((source) => allDetails
      .filter((detail) => detailBalanceId(detail) === source.id)
      .reduce((sum, detail) => sum + BigInt(detail.amountMinor), 0n) !==
        BigInt(source.feeMinor))) invalid();
  if (input.subjectType === 'fee_detail' && !allDetails.some((detail) =>
    detail.id === input.subjectId && detail.fingerprintSha256 === input.sourceFingerprintSha256)) {
    invalid();
  }
  if (requiredActivePredecessor !== null) {
    const hasActiveTips = (balanceTransactionId: string): boolean =>
      (['gross_amount', 'fee'] as const).every((basis) => tips.some((tip) =>
        tipBalanceId(tip) === balanceTransactionId && tip.basis === basis &&
        tip.classifierVersion >= requiredActivePredecessor.classifierVersion &&
        tip.algorithmVersion >= requiredActivePredecessor.allocationAlgorithmVersion));
    const missingActiveTips = sourceBalanceIds.filter((id) => !hasActiveTips(id));
    if (missingActiveTips.length > 0) {
      const activeDecisions = await rows(transaction, sql`
        select subject_type as "subjectType", subject_id as "subjectId",
          classifier_version as "classifierVersion",
          source_fingerprint_sha256 as "sourceFingerprintSha256", classification
        from financial_classification_versions
        where classifier_version = ${requiredActivePredecessor.classifierVersion}
          and ((subject_type = 'balance_transaction' and subject_id in (${sql.join(
            sourceBalanceIds.map((id) => sql`${id}::uuid`), sql`, `
          )}))
          ${allDetails.length === 0 ? sql`` : sql`or
            (subject_type = 'fee_detail' and subject_id in (${sql.join(
              allDetails.map((detail) => sql`${detail.id}::uuid`), sql`, `
            )}))`})
        order by subject_type, subject_id
      `) as Array<{
        subjectType: 'balance_transaction' | 'fee_detail';
        subjectId: string;
        classifierVersion: number;
        sourceFingerprintSha256: string;
        classification: string;
      }>;
      const expectedSubjects = new Map<string, {
        fingerprint: string;
        balanceTransactionId: string;
      }>();
      for (const source of lockedSourceBalances) {
        expectedSubjects.set(`balance_transaction:${source.id}`, {
          fingerprint: source.fingerprintSha256, balanceTransactionId: source.id
        });
      }
      for (const detail of allDetails) {
        expectedSubjects.set(`fee_detail:${detail.id}`, {
          fingerprint: detail.fingerprintSha256,
          balanceTransactionId: detailBalanceId(detail)
        });
      }
      const unknownBalances = new Set<string>();
      const seenSubjects = new Set<string>();
      for (const decision of activeDecisions) {
        const key = `${decision.subjectType}:${decision.subjectId}`;
        const expected = expectedSubjects.get(key);
        if (!expected || seenSubjects.has(key) ||
          decision.classifierVersion !== requiredActivePredecessor.classifierVersion ||
          decision.sourceFingerprintSha256 !== expected.fingerprint) {
          throw new RetryableFinancialError('state_changed');
        }
        seenSubjects.add(key);
        if (decision.classification === 'unknown') {
          unknownBalances.add(expected.balanceTransactionId);
        }
      }
      if (seenSubjects.size !== expectedSubjects.size || missingActiveTips.some((id) =>
        !unknownBalances.has(id))) {
        throw new RetryableFinancialError('state_changed');
      }
    }
  }
  const details = allDetails.filter((detail) => detailBalanceId(detail) === balance.id);

  const balanceDecisions = new Map(lockedSourceBalances.map((source) => [source.id,
    classifyBalanceTransaction({
      sourceFamily: source.sourceFamily, rawType: source.rawType,
      reportingCategory: source.reportingCategory, amountMinor: source.amountMinor
    })]));
  const lockedParentDecision = balanceDecisions.get(balance.id)!;
  if (lockedParentDecision.classification !== parentDecision.classification ||
    lockedParentDecision.status !== parentDecision.status) invalid();
  const detailDecisions = new Map(allDetails.map((detail) => [detail.id, classifyFeeDetail({
    parentClassification: balanceDecisions.get(detailBalanceId(detail))!.classification,
    rawType: detail.rawType, amountMinor: detail.amountMinor
  })]));
  let failingClassificationIdentity: {
    resourceType: 'balance_transaction' | 'fee_detail';
    resourceId: string;
  } = { resourceType: 'balance_transaction', resourceId: balance.id };
  try {
    for (const source of lockedSourceBalances) {
      failingClassificationIdentity = {
        resourceType: 'balance_transaction', resourceId: source.id
      };
      await appendClassificationDecisionLocked(transaction, {
        subjectType: 'balance_transaction', subjectId: source.id,
        classifierVersion: input.classifierVersion,
        sourceFingerprint: source.fingerprintSha256,
        decision: balanceDecisions.get(source.id)!, correlationId: input.correlationId
      });
      for (const detail of allDetails.filter((candidate) =>
        detailBalanceId(candidate) === source.id)) {
        failingClassificationIdentity = {
          resourceType: 'fee_detail', resourceId: detail.id
        };
        await appendClassificationDecisionLocked(transaction, {
          subjectType: 'fee_detail', subjectId: detail.id,
          classifierVersion: input.classifierVersion,
          sourceFingerprint: detail.fingerprintSha256,
          decision: detailDecisions.get(detail.id)!, correlationId: input.correlationId
        });
      }
    }
  } catch (error) {
    if (!(error instanceof PermanentFinancialError) ||
      error.safeCode !== 'classification_fork') throw error;
    const issue = await observeFinancialIssue(transaction, {
      ...failingClassificationIdentity,
      safeCode: 'classification_fork', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: input.correlationId
    });
    return { status: 'exception', subjectId: input.subjectId,
      safeCode: 'classification_fork', issueId: issue.id };
  }
  const unknowns = [
    ...lockedSourceBalances.flatMap((source) =>
      balanceDecisions.get(source.id)!.status === 'unknown'
        ? [{ resourceType: 'balance_transaction' as const, resourceId: source.id }]
        : []),
    ...allDetails.flatMap((detail) => detailDecisions.get(detail.id)!.status === 'unknown'
      ? [{ resourceType: 'fee_detail' as const, resourceId: detail.id }] : [])
  ];
  if (unknowns.length > 0) {
    for (const unknown of unknowns) {
      await observeFinancialIssue(transaction, {
        ...unknown, safeCode: 'unsupported_category', impact: 'exception',
        actor: { type: 'system', id: 'financial-worker' },
        correlationId: input.correlationId
      });
    }
    return { status: 'unchanged', subjectId: input.subjectId };
  }
  const feeDetails = details.map((detail) => {
    const component = componentForFeeDecision(detailDecisions.get(detail.id)!);
    if (!component) invalid();
    return { amountMinor: -detail.amountMinor, component };
  });
  if (graph.sourceKind === 'refund') {
    const refund = graph.purchaseFacts.refunds.find((row) => row.id === graph.sourceId);
    if (!refund || refund.paymentId !== graph.paymentId ||
      refund.stripeRefundId !== balance.sourceId) invalid();
    const lockedInput: LockedRefundProjectionInput = {
      orderId: graph.orderId,
      paymentId: graph.paymentId,
      refundId: refund.id,
      providerStatus: refund.status,
      allocationStatus: refund.allocationStatus,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      balanceTransactionIds: sourceBalanceIds,
      orderItems: graph.purchaseFacts.orderItems.map((item) => {
        if (item.taxMinor === null || item.totalMinor === null) invalid();
        return {
          id: item.id,
          subtotalMinor: item.unitSubtotalMinor,
          taxMinor: item.taxMinor,
          totalMinor: item.totalMinor,
          currency: item.currency
        };
      }),
      finalizedAllocations: graph.purchaseFacts.refundAllocations
        .filter((row) => row.refundId === refund.id)
        .map((row) => ({ id: row.id, orderItemId: row.orderItemId,
          amountMinor: row.amountMinor })),
      refundComponents: graph.purchaseFacts.refundComponents
        .filter((row) => row.refundId === refund.id)
        .map((row) => ({ refundAllocationId: row.refundAllocationId,
          orderItemId: row.orderItemId, subtotalMinor: row.subtotalMinor,
          taxMinor: row.taxMinor, currency: row.currency })),
      correlationId: input.correlationId
    };
    const replay = await recomputeLockedRefundFinancialProjectionForVersion(
      transaction, lockedInput, {
        classifierVersion: input.classifierVersion,
        allocationAlgorithmVersion: input.allocationAlgorithmVersion,
        replayId: input.replayId
      }
    );
    if (replay.status === 'exception') {
      await observeFinancialIssue(transaction, {
        resourceType: 'balance_transaction', resourceId: balance.id,
        safeCode: replay.safeCode, impact: replay.impact,
        actor: { type: 'system', id: 'financial-worker' },
        correlationId: input.correlationId
      });
      return { status: 'unchanged', subjectId: input.subjectId };
    }
    for (const replacement of replay.replacements) {
      if (replacement.disposition !== 'inserted') continue;
      await rows(transaction, sql`
        insert into audit_events
          (actor_type, actor_id, action, outcome, resource_type, resource_id,
            correlation_id, after)
        values ('system', 'financial-worker', 'financial.allocation.superseded',
          'succeeded', 'financial_allocation_set', ${replacement.replacementSetId},
          ${input.correlationId},
          ${JSON.stringify({ balanceTransactionId: replacement.balanceTransactionId,
            basis: replacement.basis,
            predecessorSetId: replacement.previousSetId,
            classifierVersion: input.classifierVersion,
            allocationAlgorithmVersion: input.allocationAlgorithmVersion })}::jsonb)
      `);
    }
    const correctionTips = graph.purchaseFacts.correctionSets.filter((correction) =>
      correction.refundId === refund.id && !graph.purchaseFacts.correctionSets.some(
        (successor) => successor.predecessorCorrectionSetId === correction.id
      ));
    if (correctionTips.length > 1) invalid();
    const correction = correctionTips[0];
    if (correction) {
      const correctedPreviousIds = new Set(graph.purchaseFacts.correctionItems
        .filter((item) => item.correctionSetId === correction.id &&
          item.sourceAllocationSetId !== null)
        .map((item) => item.sourceAllocationSetId!));
      const currentAnchor = replay.replacements.find((replacement) =>
        replacement.replacementSetId === correction.baseAllocationSetId &&
        replacement.sourceFingerprint === correction.sourceFingerprintSha256);
      const currentReplacementIds = new Set(replay.replacements.map(
        (replacement) => replacement.replacementSetId
      ));
      const alreadyCompatible = currentAnchor !== undefined &&
        [...correctedPreviousIds].every((sourceId) => currentReplacementIds.has(sourceId));
      if (alreadyCompatible) {
        await resolveCorrectionRebaseIssue(transaction, {
          balanceTransactionId: currentAnchor.balanceTransactionId,
          correlationId: input.correlationId
        });
      } else {
        const anchor = replay.replacements.find((replacement) =>
          replacement.previousSetId === correction.baseAllocationSetId);
        const allMapped = [...correctedPreviousIds].every((previousId) =>
          replay.replacements.some((replacement) => replacement.previousSetId === previousId));
        if (!anchor || !allMapped || anchor.previousSetId === null) {
          const issue = await observeFinancialIssue(transaction, {
            resourceType: 'balance_transaction', resourceId: balance.id,
            safeCode: 'correction_rebase_required', impact: 'exception',
            actor: { type: 'system', id: 'financial-worker' },
            correlationId: input.correlationId
          });
          await appendCorrectionRebaseFailedAudit(transaction, {
            balanceTransactionId: anchor?.balanceTransactionId ?? balance.id,
            approvedCorrectionSetId: correction.id,
            previousAllocationSetId: correction.baseAllocationSetId,
            replacementAllocationSetId: anchor?.replacementSetId ?? null,
            correlationId: input.correlationId
          });
          return { status: 'exception', subjectId: input.subjectId,
            safeCode: 'correction_rebase_required', issueId: issue.id };
        }
        const rebased = await rebaseApprovedCorrectionDistributionLocked(transaction, {
          balanceTransactionId: anchor.balanceTransactionId,
          basis: anchor.basis,
          previousAllocationSetId: anchor.previousSetId,
          replacementAllocationSetId: anchor.replacementSetId,
          approvedCorrectionSetId: correction.id,
          expectedSourceFingerprint: anchor.sourceFingerprint,
          correlationId: input.correlationId
        });
        if (rebased.status === 'exception') {
          return { status: 'exception', subjectId: input.subjectId,
            safeCode: 'correction_rebase_required', issueId: rebased.issueId };
        }
      }
    }
    for (const identity of [
      ...lockedSourceBalances.map((source) => ({ resourceType: 'balance_transaction' as const,
        resourceId: source.id })),
      ...allDetails.map((detail) => ({ resourceType: 'fee_detail' as const,
        resourceId: detail.id }))
    ]) {
      for (const safeCode of ['classification_fork', 'unsupported_category'] as const) {
        await resolveFinancialIssueAfterRecompute(transaction, {
          ...identity, safeCode,
          proof: { status: 'resolved', ...identity, safeCode },
          actor: { type: 'system', id: 'financial-worker' },
          correlationId: input.correlationId
        });
      }
    }
    const allocationSetIds = replay.replacements.map((row) => row.replacementSetId);
    return replay.status === 'unchanged'
      ? { status: 'unchanged', subjectId: input.subjectId }
      : { status: 'replayed', subjectId: input.subjectId, allocationSetIds };
  }
  if (graph.sourceKind === 'dispute') {
    const replay = await recomputeLockedDisputeFinancialProjectionForVersion(transaction, {
      orderId: graph.orderId,
      paymentId: graph.paymentId,
      balanceTransactionIds: sourceBalanceIds,
      purchaseFacts: graph.purchaseFacts,
      projectionLocks: lockedProjection,
      correlationId: input.correlationId
    }, {
      classifierVersion: input.classifierVersion,
      allocationAlgorithmVersion: input.allocationAlgorithmVersion,
      replayId: input.replayId
    });
    if (replay.status === 'exception') {
      await observeFinancialIssue(transaction, {
        resourceType: 'balance_transaction', resourceId: balance.id,
        safeCode: replay.safeCode, impact: 'exception',
        actor: { type: 'system', id: 'financial-worker' },
        correlationId: input.correlationId
      });
      return { status: 'unchanged', subjectId: input.subjectId };
    }
    for (const replacement of replay.replacements) {
      if (replacement.disposition !== 'inserted') continue;
      await rows(transaction, sql`
        insert into audit_events
          (actor_type, actor_id, action, outcome, resource_type, resource_id,
            correlation_id, after)
        values ('system', 'financial-worker', 'financial.allocation.superseded',
          'succeeded', 'financial_allocation_set', ${replacement.replacementSetId},
          ${input.correlationId},
          ${JSON.stringify({ balanceTransactionId: replacement.balanceTransactionId,
            disputeId: replacement.disputeId, basis: replacement.basis,
            predecessorSetId: replacement.previousSetId,
            classifierVersion: input.classifierVersion,
            allocationAlgorithmVersion: input.allocationAlgorithmVersion })}::jsonb)
      `);
    }
    for (const identity of [
      ...lockedSourceBalances.map((source) => ({ resourceType: 'balance_transaction' as const,
        resourceId: source.id })),
      ...allDetails.map((detail) => ({ resourceType: 'fee_detail' as const,
        resourceId: detail.id }))
    ]) {
      for (const safeCode of ['classification_fork', 'unsupported_category'] as const) {
        await resolveFinancialIssueAfterRecompute(transaction, {
          ...identity, safeCode,
          proof: { status: 'resolved', ...identity, safeCode },
          actor: { type: 'system', id: 'financial-worker' },
          correlationId: input.correlationId
        });
      }
    }
    const allocationSetIds = replay.replacements.map((row) => row.replacementSetId);
    return replay.status === 'unchanged'
      ? { status: 'unchanged', subjectId: input.subjectId }
      : { status: 'replayed', subjectId: input.subjectId, allocationSetIds };
  }
  if (graph.sourceKind === 'adjustment' && graph.accountFallback &&
    (await loadReplayRoutingRows(transaction, balance)).length !== 0) {
    throw new RetryableFinancialError('state_changed');
  }
  const currentGross = tips.find((tip) => tipBalanceId(tip) === balance.id &&
    tip.basis === 'gross_amount');
  const currentFee = tips.find((tip) => tipBalanceId(tip) === balance.id && tip.basis === 'fee');
  let plans: readonly FinancialAllocationPlan[];
  if (graph.sourceKind === 'payment' && parentDecision.classification === 'charge') {
    const prefix = `payment:${graph.sourceId}:${balance.id}:replay:${input.replayId}`;
    plans = buildChargeAllocationPlan({
      sourceKind: 'payment', sourceId: graph.sourceId,
      balanceTransactionId: balance.id, allocationIdentityPrefix: prefix,
      settlementCurrency: balance.currency, amountMinor: balance.amountMinor,
      feeMinor: balance.feeMinor, netMinor: balance.netMinor,
      sourceFingerprint: balance.fingerprintSha256,
      algorithmVersion: input.allocationAlgorithmVersion,
      supersedesGrossSetId: predecessorForReplay(currentGross, `${prefix}:gross`),
      supersedesFeeSetId: predecessorForReplay(currentFee, `${prefix}:fee`),
      items: graph.orderItems.map((item) => ({ orderItemId: item.id,
        subtotalMinor: item.unitSubtotalMinor, taxMinor: item.taxMinor!,
        presentmentCurrency: item.currency })),
      feeDetails
    }).plans;
  } else if (graph.sourceKind === 'payout' || graph.sourceKind === 'adjustment') {
    if ((graph.sourceKind === 'payout' && parentDecision.classification !== 'payout') ||
      (graph.sourceKind === 'adjustment' &&
        !(graph.accountFallback
          ? accountFallbackClassificationMatches(balance, parentDecision)
          : ['other', 'fee_credit', 'provider_fee_tax'].includes(parentDecision.classification)))) {
      invalid();
    }
    const prefix = `${graph.sourceKind}:${graph.sourceId}:${balance.id}:replay:${input.replayId}`;
    const metadata = {
      sourceKind: graph.sourceKind, sourceId: graph.sourceId,
      balanceTransactionId: balance.id, allocationIdentityPrefix: prefix,
      settlementCurrency: balance.currency, amountMinor: balance.amountMinor,
      feeMinor: balance.feeMinor, netMinor: balance.netMinor,
      sourceFingerprint: balance.fingerprintSha256,
      algorithmVersion: input.allocationAlgorithmVersion,
      supersedesGrossSetId: predecessorForReplay(currentGross, `${prefix}:gross`),
      supersedesFeeSetId: predecessorForReplay(currentFee, `${prefix}:fee`)
    };
    plans = [
      basePlan(metadata, { basis: 'gross_amount', scope: 'account',
        expectedEffectMinor: balance.amountMinor, items: [] }),
      basePlan(metadata, { basis: 'fee', scope: 'account',
        expectedEffectMinor: balance.feeMinor === 0 ? 0 : -balance.feeMinor, items: [] })
    ];
  } else {
    // Refund and dispute replay delegate to their chronology-aware provider-free helpers.
    invalid();
  }
  const persisted: Array<{ setId: string; disposition: 'inserted' | 'unchanged' }> = [];
  for (const plan of plans) {
    persisted.push(await persistFinancialAllocationReplayPlanLocked(transaction, {
      plan, sourceKind: graph.sourceKind, sourceId: graph.sourceId,
      classificationVersion: input.classifierVersion,
      correlationId: input.correlationId
    }, {
      classifierVersion: input.classifierVersion,
      allocationAlgorithmVersion: input.allocationAlgorithmVersion
    }));
  }
  for (const [index, saved] of persisted.entries()) {
    if (saved.disposition !== 'inserted') continue;
    const predecessor = index === 0 ? currentGross : currentFee;
    await rows(transaction, sql`
      insert into audit_events
        (actor_type, actor_id, action, outcome, resource_type, resource_id,
          correlation_id, after)
      values ('system', 'financial-worker', 'financial.allocation.superseded',
        'succeeded', 'financial_allocation_set', ${saved.setId},
        ${input.correlationId},
        ${JSON.stringify({ balanceTransactionId: balance.id,
          basis: plans[index]!.basis,
          predecessorSetId: predecessor?.id ?? null,
          classifierVersion: input.classifierVersion,
          allocationAlgorithmVersion: input.allocationAlgorithmVersion })}::jsonb)
    `);
  }
  for (const identity of [
    { resourceType: 'balance_transaction' as const, resourceId: balance.id },
    ...details.map((detail) => ({ resourceType: 'fee_detail' as const,
      resourceId: detail.id }))
  ]) {
    for (const safeCode of ['classification_fork', 'unsupported_category'] as const) {
      await resolveFinancialIssueAfterRecompute(transaction, {
        ...identity, safeCode,
        proof: { status: 'resolved', ...identity, safeCode },
        actor: { type: 'system', id: 'financial-worker' },
        correlationId: input.correlationId
      });
    }
  }
  return persisted.every((saved) => saved.disposition === 'unchanged')
    ? { status: 'unchanged', subjectId: input.subjectId }
    : { status: 'replayed', subjectId: input.subjectId,
        allocationSetIds: persisted.map((saved) => saved.setId) };
}

/**
 * The singleton projection-version row is the global operation-identity lock for replay.
 * It must remain the first database statement in this transaction. Order-scoped commerce and
 * administrative flows never acquire it later, so every replay orders version -> purchase graph
 * -> payout closure -> financial rows and cannot form an order -> version cycle. Subject jobs
 * may build evidence for the registered pending target, but only the terminal scan finalizer may
 * publish that target globally.
 */
export async function replayFinancialClassification(
  dependencies: FinancialClassificationReplayDependencies,
  input: FinancialClassificationReplayInput
): Promise<void> {
  if (input.signal.aborted) {
    throw new DOMException('Financial classification replay was aborted.', 'AbortError');
  }
  if (input.payload.classifierVersion !== dependencies.targetClassifierVersion ||
    input.payload.allocationAlgorithmVersion !==
      dependencies.targetAllocationAlgorithmVersion) invalid();
  await dependencies.database.transaction(async (transaction) => {
    if (input.signal.aborted) {
      throw new DOMException('Financial classification replay was aborted.', 'AbortError');
    }
    const authority = await lockFinancialProjectionAuthority(transaction);
    const targetsActive = authority.classifierVersion === input.payload.classifierVersion &&
      authority.allocationAlgorithmVersion === input.payload.allocationAlgorithmVersion;
    const targetsRegisteredPending = authority.pendingClassifierVersion ===
      input.payload.classifierVersion &&
      authority.pendingAllocationAlgorithmVersion ===
        input.payload.allocationAlgorithmVersion &&
      authority.pendingReplayId === input.payload.replayId &&
      authority.pendingScanRunId !== null;
    const targetsPending = targetsRegisteredPending &&
      authority.pendingScanRunId === (input.payload.scanRunId ?? null);
    const superseded = input.payload.classifierVersion <= authority.classifierVersion &&
      input.payload.allocationAlgorithmVersion <= authority.allocationAlgorithmVersion;
    const advancesActive = input.payload.classifierVersion >= authority.classifierVersion &&
      input.payload.allocationAlgorithmVersion >= authority.allocationAlgorithmVersion;
    if (input.payload.scanRunId === undefined) {
      if (!targetsActive && !targetsRegisteredPending) {
        if (superseded) return;
        if (authority.pendingScanRunId !== null || !advancesActive) invalid();
      }
    } else if (!targetsPending &&
      !(targetsActive && authority.pendingScanRunId === null)) {
      if (superseded) return;
      invalid();
    }
    await replayFinancialClassificationLocked(transaction, {
      subjectType: input.payload.subjectType, subjectId: input.payload.subjectId,
      sourceFingerprintSha256: input.payload.sourceFingerprintSha256,
      classifierVersion: input.payload.classifierVersion,
      allocationAlgorithmVersion: input.payload.allocationAlgorithmVersion,
      replayId: input.payload.replayId, correlationId: input.correlationId
    }, targetsActive ? null : {
      classifierVersion: authority.classifierVersion,
      allocationAlgorithmVersion: authority.allocationAlgorithmVersion
    });
    if (input.signal.aborted) {
      throw new DOMException('Financial classification replay was aborted.', 'AbortError');
    }
  });
}

export async function rebaseApprovedCorrectionDistributionLocked(
  transaction: DatabaseTransaction,
  input: CorrectionRebaseInput
): Promise<
  | { status: 'rebased'; correctionSetId: string }
  | { status: 'exception'; issueId: string }
> {
  assertCorrectionRebaseInput(input);
  // The caller has already locked the complete payment-purchase graph, including this
  // correction row. Do not introduce a late, independent advisory identity lock here.
  const corrections = await rows(transaction, sql`
    select correction.id, correction.refund_id as "refundId",
      correction.correction_version as "correctionVersion",
      correction.base_allocation_set_id as "baseAllocationSetId",
      correction.predecessor_correction_set_id as "predecessorCorrectionSetId",
      correction.source_fingerprint_sha256 as "sourceFingerprint",
      correction.approved_by_admin_id as "approvedByAdminId",
      refund.status as "refundStatus",
      refund.allocation_status as "refundAllocationStatus",
      successor.id as "successorId",
      successor.kind as "successorKind",
      successor.correction_version as "successorCorrectionVersion",
      successor.predecessor_correction_set_id as "successorPredecessorCorrectionSetId",
      successor.base_allocation_set_id as "successorBaseAllocationSetId",
      successor.source_fingerprint_sha256 as "successorSourceFingerprint"
    from refund_reporting_correction_sets correction
    join refunds refund on refund.id = correction.refund_id
    left join refund_reporting_correction_sets successor
      on successor.predecessor_correction_set_id = correction.id
    where correction.id = ${input.approvedCorrectionSetId}
    for update of correction
  `) as CorrectionSetRow[];
  const correction = corrections[0];
  if (!correction || corrections.length !== 1 ||
    correction.id !== input.approvedCorrectionSetId ||
    !UUID_PATTERN.test(correction.refundId) ||
    !UUID_PATTERN.test(correction.baseAllocationSetId) ||
    (correction.predecessorCorrectionSetId !== null &&
      !UUID_PATTERN.test(correction.predecessorCorrectionSetId)) ||
    !Number.isSafeInteger(correction.correctionVersion) || correction.correctionVersion < 1 ||
    correction.correctionVersion >= 2_147_483_647 ||
    correction.sourceFingerprint !== input.expectedSourceFingerprint ||
    !UUID_PATTERN.test(correction.approvedByAdminId) ||
    correction.refundStatus !== 'succeeded' ||
    correction.refundAllocationStatus !== 'finalized') {
    return rebaseFailed(transaction, input);
  }
  if (correction.successorId !== null && correction.successorId !== undefined) {
    if (!UUID_PATTERN.test(correction.successorId) ||
      correction.successorKind !== 'classifier_rebase' ||
      correction.successorCorrectionVersion !== correction.correctionVersion + 1 ||
      correction.successorPredecessorCorrectionSetId !== correction.id ||
      correction.successorBaseAllocationSetId !== input.replacementAllocationSetId ||
      correction.successorSourceFingerprint !== input.expectedSourceFingerprint) {
      return rebaseFailed(transaction, input);
    }
    await resolveCorrectionRebaseIssue(transaction, input);
    return { status: 'rebased', correctionSetId: correction.successorId };
  }
  const correctionItems = await rows(transaction, sql`
    select item.domain, item.source_allocation_set_id as "sourceAllocationSetId",
      item.order_item_id as "orderItemId", item.component, item.currency,
      item.approved_absolute_minor as "approvedAbsoluteMinor",
      item.delta_minor as "deltaMinor",
      item.stable_tie_break_key as "stableTieBreakKey"
    from refund_reporting_correction_items item
    where item.correction_set_id = ${correction.id}
    order by item.stable_tie_break_key, item.id
    for update
  `) as CorrectionItemRow[];
  if (correctionItems.length === 0 || correctionItems.some((item) => !isCorrectionItem(item))) {
    return rebaseFailed(transaction, input);
  }
  const previousSourceIds = [...new Set(correctionItems.flatMap((item) =>
    item.domain === 'settlement' && item.sourceAllocationSetId !== null
      ? [item.sourceAllocationSetId]
      : []))].sort();
  if (previousSourceIds.length === 0 ||
    previousSourceIds.some((id) => !UUID_PATTERN.test(id))) {
    return rebaseFailed(transaction, input);
  }
  const allocations = await rows(transaction, sql`
    select allocation.id,
      allocation.balance_transaction_id as "balanceTransactionId", allocation.basis,
      allocation.source_kind as "sourceKind",
      allocation.source_internal_id as "sourceId", allocation.currency,
      allocation.expected_effect_minor as "expectedEffectMinor",
      allocation.source_fingerprint_sha256 as "sourceFingerprint",
      allocation.supersedes_set_id as "supersedesSetId",
      allocation.classifier_version as "classifierVersion",
      allocation.algorithm_version as "algorithmVersion"
    from financial_allocation_sets allocation
    where allocation.id in (${sql.join(previousSourceIds.map((id) => sql`${id}::uuid`), sql`, `)})
      or (allocation.supersedes_set_id in (${sql.join(
        previousSourceIds.map((id) => sql`${id}::uuid`), sql`, `
      )}) and not exists (
        select 1 from financial_allocation_sets successor_tip
        where successor_tip.supersedes_set_id = allocation.id
      ))
    order by allocation.balance_transaction_id, allocation.basis,
      allocation.supersedes_set_id nulls first, allocation.id
    for update
  `) as AllocationSetRow[];
  let mappings: readonly AllocationRebaseMapping[];
  try {
    mappings = validateAllocationMappings(allocations, correctionItems, input, correction);
  } catch (error) {
    if (error instanceof PermanentFinancialError) return rebaseFailed(transaction, input);
    throw error;
  }
  const replacementIds = mappings.map((mapping) => mapping.replacement.id);
  const replacementItems = await rows(transaction, sql`
    select item.allocation_set_id as "sourceAllocationSetId",
      item.order_item_id as "orderItemId", item.component,
      item.effect_minor as "effectMinor", item.currency
    from financial_item_allocations item
    where item.allocation_set_id in (${sql.join(
      replacementIds.map((id) => sql`${id}::uuid`), sql`, `
    )})
    order by item.order_item_id, item.component, item.id
    for update
  `) as AllocationItemRow[];
  const presentmentBases = await rows(transaction, sql`
    with refund_components as (
      select allocation.refund_id, allocation.order_item_id, allocation.currency,
        value.component, value.amount_minor
      from refund_allocation_components allocation
      cross join lateral (values
        ('refund_subtotal'::financial_component, allocation.subtotal_minor),
        ('refund_tax'::financial_component, allocation.tax_minor)
      ) value(component, amount_minor)
    ), correction_presentment_keys as (
      select distinct item.order_item_id, item.component, item.currency
      from refund_reporting_correction_items item
      where item.correction_set_id = ${correction.id}
        and item.domain = 'presentment'
    ), nonzero_current_presentment_keys as (
      select component.order_item_id, component.component, component.currency
      from refund_components component
      where component.refund_id = ${correction.refundId}
        and component.amount_minor <> 0
    ), presentment_keys as (
      select order_item_id, component, currency from correction_presentment_keys
      union
      select order_item_id, component, currency from nonzero_current_presentment_keys
    ), current_components as (
      select key.order_item_id, key.component, key.currency,
        coalesce(component.amount_minor, 0)::integer as "baseMinor"
      from presentment_keys key
      left join refund_components component
        on component.refund_id = ${correction.refundId}
        and component.order_item_id = key.order_item_id
        and component.component = key.component
        and component.currency = key.currency
    ), other_refunds as (
      select refund.id
      from refunds refund
      where refund.payment_id = (
        select payment_id from refunds where id = ${correction.refundId}
      ) and refund.id <> ${correction.refundId}
        and refund.status = 'succeeded' and refund.allocation_status = 'finalized'
    ), other_presentment_correction_tips as (
      select refund.id as refund_id, correction.id as correction_set_id
      from other_refunds refund
      join refund_reporting_correction_sets correction on correction.refund_id = refund.id
      where not exists (
        select 1 from refund_reporting_correction_sets successor
        where successor.predecessor_correction_set_id = correction.id
      ) and exists (
        select 1 from refund_reporting_correction_items item
        where item.correction_set_id = correction.id and item.domain = 'presentment'
      )
    ), compatible_other_presentment_corrections as (
      select tip.refund_id, tip.correction_set_id
      from other_presentment_correction_tips tip
      where exists (
        select 1 from current_financial_projection_heads head
        where head.compatible_correction_tip_id = tip.correction_set_id
      )
    ), effective_other_components as (
      select component.order_item_id, component.component, component.currency,
        component.amount_minor::bigint as amount_minor
      from refund_components component
      join other_refunds refund on refund.id = component.refund_id
      where not exists (
        select 1 from compatible_other_presentment_corrections compatible
        where compatible.refund_id = component.refund_id
      )
      union all
      select item.order_item_id, item.component, item.currency,
        item.approved_absolute_minor::bigint as amount_minor
      from compatible_other_presentment_corrections compatible
      join refund_reporting_correction_items item
        on item.correction_set_id = compatible.correction_set_id
        and item.domain = 'presentment'
    ), other_effects as (
      select component.order_item_id, component.component, component.currency,
        coalesce(sum(component.amount_minor), 0)::text as "cumulativeOtherRefundMinor"
      from effective_other_components component
      group by component.order_item_id, component.component, component.currency
    )
    select current.order_item_id as "orderItemId", current.component,
      current.currency, current."baseMinor",
      coalesce(other."cumulativeOtherRefundMinor", '0') as "cumulativeOtherRefundMinor",
      case current.component
        when 'refund_subtotal' then order_item.unit_subtotal_minor
        when 'refund_tax' then coalesce(order_item.tax_minor, 0)
        else 0
      end::integer as "capacityMinor"
    from current_components current
    join order_items order_item on order_item.id = current.order_item_id
    left join other_effects other
      on other.order_item_id = current.order_item_id
      and other.component = current.component and other.currency = current.currency
    order by current.order_item_id, current.component
    for update of order_item
  `) as PresentmentBaseRow[];
  const rebasedItems = buildRebasedItems(
    correctionItems, replacementItems, presentmentBases, mappings
  );
  if (!rebasedItems) return rebaseFailed(transaction, input);

  let inserted: { id?: unknown } | undefined;
  try {
    inserted = await transaction.transaction(async (insertTx) =>
      (await rows(insertTx, sql`
        insert into refund_reporting_correction_sets
          (refund_id, correction_version, kind, base_allocation_set_id,
            predecessor_correction_set_id, source_fingerprint_sha256,
            approved_by_admin_id, created_by_admin_id, correlation_id)
        values (${correction.refundId}, ${correction.correctionVersion + 1},
          'classifier_rebase', ${input.replacementAllocationSetId}, ${correction.id},
          ${input.expectedSourceFingerprint}, ${correction.approvedByAdminId}, null,
          ${input.correlationId})
        returning id
      `))[0] as { id?: unknown } | undefined
    );
  } catch (error) {
    if (!isBoundedCorrectionCollision(error)) throw error;
    const successors = await rows(transaction, sql`
      select id, kind, correction_version as "correctionVersion",
        predecessor_correction_set_id as "predecessorCorrectionSetId",
        base_allocation_set_id as "baseAllocationSetId",
        source_fingerprint_sha256 as "sourceFingerprint"
      from refund_reporting_correction_sets
      where predecessor_correction_set_id = ${correction.id}
      for update
    `);
    const successor = successors[0];
    if (successors.length === 1 &&
      isCanonicalCorrectionSuccessor(successor, correction, input)) {
      await resolveCorrectionRebaseIssue(transaction, input);
      return { status: 'rebased', correctionSetId: successor.id };
    }
    return rebaseFailed(transaction, input);
  }
  if (!inserted || typeof inserted.id !== 'string' || !UUID_PATTERN.test(inserted.id)) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
  for (const item of rebasedItems) {
    await rows(transaction, sql`
      insert into refund_reporting_correction_items
        (correction_set_id, domain, source_allocation_set_id, order_item_id,
          component, currency, approved_absolute_minor, delta_minor,
          stable_tie_break_key)
      values (${inserted.id}, ${item.domain}, ${item.sourceAllocationSetId},
        ${item.orderItemId}, ${item.component}, ${item.currency},
        ${item.approvedAbsoluteMinor}, ${item.deltaMinor}, ${item.stableTieBreakKey})
    `);
  }
  await rows(transaction, sql`
    insert into audit_events
      (actor_type, actor_id, action, outcome, resource_type, resource_id,
        correlation_id, after)
    values ('system', 'financial-worker', 'financial.correction.rebased',
      'succeeded', 'refund_reporting_correction', ${inserted.id},
      ${input.correlationId},
      ${JSON.stringify({ refundId: correction.refundId,
        previousAllocationSetId: input.previousAllocationSetId,
        replacementAllocationSetId: input.replacementAllocationSetId,
        rebasedAllocationSetCount: mappings.length,
        correctionVersion: correction.correctionVersion + 1,
        itemCount: rebasedItems.length })}::jsonb)
  `);
  await resolveCorrectionRebaseIssue(transaction, input);
  return { status: 'rebased', correctionSetId: inserted.id };
}
