import { eq, sql } from 'drizzle-orm';
import { appendAuditEvent } from '$lib/server/audit/service';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import { lockCanonicalPaymentPurchaseFacts } from './payment';
import { parseDisputeSnapshot, parsePaymentSnapshot } from '$lib/server/commerce/stripe/schemas';
import { parseChargeSnapshot } from '$lib/server/commerce/stripe/financial-schemas';
import type {
  BalanceTransactionSnapshot,
  ChargeSnapshot,
  DisputeSnapshot,
  PaymentSnapshot,
  StripeCommerceGateway
} from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import { disputes, orders, payments } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { buildDisputeAllocationPlan } from '../allocations/dispute';
import { compareFinancialExposureChronology } from '../allocations/exposure';
import {
  loadCurrentEffectiveAllocationProjection,
  persistFinancialAllocationPlanLocked,
  persistFinancialAllocationReplayPlanLocked
} from '../allocations/repository';
import type {
  BoundDisputePresentmentEffect,
  ClassifiedFeeDetail,
  DisputePaymentItem,
  FinalizedDisputeRefund
} from '../allocations/types';
import { FINANCIAL_ALLOCATION_ALGORITHM_VERSION, FINANCIAL_CLASSIFIER_VERSION } from '../constants';
import { PermanentFinancialError, RetryableFinancialError } from '../errors';
import { observeFinancialIssue, resolveFinancialIssueAfterRecompute } from '../issues';
import {
  lockActiveFinancialProjectionImplementation,
  lockFinancialProjectionRows,
  type FinancialProjectionLockRows
} from '../locks';
import type { PaymentPurchaseFacts } from '$lib/server/commerce/reconciliation';
import type {
  FinancialAllocationPlan,
  FinancialIssueCode,
  FinancialIssueImpact,
  FinancialSourceResult
} from '../types';
import {
  rearmCurrentProjectionSubjectsForFinancialSources,
  stageBalanceTransaction
} from '../ledger';
import { lockFinancialProjectionEnrollment } from '../rebase';
import {
  assertFinancialSourceInput,
  financialProviderCall,
  parseBalanceEvidence,
  recordLocalFinancialSourceIssue,
  throwIfFinancialSourceAborted
} from './refund';

interface DisputeRouting {
  readonly id: string;
  readonly stripeDisputeId: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly stripePaymentIntentId: string;
}

type QueryResult = { rows?: unknown[] };
const ACTOR = { type: 'system', id: 'commerce-worker' } as const;
const ISSUE_CODES: readonly FinancialIssueCode[] = [
  'allocation_fork',
  'allocation_incomplete',
  'allocation_mismatch',
  'classification_fork',
  'correction_rebase_required',
  'currency_mismatch',
  'immutable_mismatch',
  'missing_source',
  'source_linkage_mismatch',
  'unsupported_category'
];
const CROSS_DISPUTE_PROJECTION_ISSUE_CODES: readonly FinancialIssueCode[] = [
  'allocation_fork',
  'allocation_incomplete',
  'allocation_mismatch',
  'correction_rebase_required'
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const SAFE_MONEY = 99_999_999;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedMoney(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= -SAFE_MONEY &&
    (value as number) <= SAFE_MONEY;
}

async function rows(tx: DatabaseTransaction, query: ReturnType<typeof sql>): Promise<unknown[]> {
  return ((await tx.execute(query)) as QueryResult).rows ?? [];
}

function stateChanged(): never {
  throw new RetryableFinancialError('state_changed');
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

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function providerEvidence<Value>(work: () => Value): Value {
  try {
    return work();
  } catch (error) {
    if (error instanceof PermanentCommerceError) {
      throw new PermanentFinancialError('unsupported_provider_evidence');
    }
    throw error;
  }
}

function assertDisputeLinkage(
  routing: DisputeRouting,
  dispute: DisputeSnapshot,
  payment: PaymentSnapshot,
  charge: ChargeSnapshot
): void {
  if (
    dispute.providerDisputeId !== routing.stripeDisputeId ||
    dispute.paymentIntentId !== routing.stripePaymentIntentId ||
    payment.paymentIntentId !== routing.stripePaymentIntentId ||
    payment.metadataVersion !== '1' ||
    payment.metadataOrderId !== routing.orderId ||
    payment.latestChargeId !== dispute.chargeId ||
    charge.id !== dispute.chargeId ||
    charge.paymentIntentId !== payment.paymentIntentId
  ) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
  if (dispute.liveMode !== payment.liveMode || payment.liveMode !== charge.livemode) {
    throw new PermanentFinancialError('immutable_mismatch');
  }
  if (
    dispute.currency.toUpperCase() !== payment.currency.toUpperCase() ||
    charge.currency !== payment.currency.toUpperCase()
  ) {
    throw new PermanentFinancialError('currency_mismatch');
  }
}

function assertDisputeBalance(dispute: DisputeSnapshot, balance: BalanceTransactionSnapshot): void {
  if (
    !dispute.balanceTransactionIds.includes(balance.id) ||
    balance.sourceFamily !== 'dispute' ||
    balance.sourceId !== dispute.providerDisputeId ||
    balance.livemode !== dispute.liveMode ||
    !['dispute', 'dispute_reversal', 'fee'].includes(balance.reportingCategory)
  ) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
}

async function recordLockedIssue(
  tx: DatabaseTransaction,
  disputeId: string,
  correlationId: string,
  safeCode: FinancialIssueCode,
  impact: FinancialIssueImpact,
  signal: AbortSignal
): Promise<FinancialSourceResult> {
  const issue = await observeFinancialIssue(tx, {
    resourceType: 'dispute',
    resourceId: disputeId,
    safeCode,
    impact,
    actor: ACTOR,
    correlationId
  });
  const financialEvidenceStatus = impact === 'pending' ? 'pending' : 'exception';
  await tx.update(disputes).set({ financialEvidenceStatus }).where(eq(disputes.id, disputeId));
  throwIfFinancialSourceAborted(signal);
  return impact === 'pending'
    ? {
        status: 'pending',
        sourceKind: 'dispute',
        sourceId: disputeId,
        financialEvidenceStatus: 'pending',
        safeCode: 'missing_source',
        issueId: issue.id
      }
    : {
        status: 'exception',
        sourceKind: 'dispute',
        sourceId: disputeId,
        financialEvidenceStatus: 'exception',
        safeCode,
        issueId: issue.id
      };
}

interface LockedBalance {
  readonly id: string;
  readonly providerId: string;
  readonly sourceId: string;
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly netMinor: number;
  readonly currency: string;
  readonly fingerprintSha256: string;
  readonly providerCreatedAt: Date;
}

export interface LockedDisputeProjectionReplayVersion {
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
  readonly replayId: string;
}

export interface LockedDisputeProjectionReplayInput {
  readonly orderId: string;
  readonly paymentId: string;
  readonly balanceTransactionIds: readonly string[];
  readonly purchaseFacts: PaymentPurchaseFacts;
  readonly projectionLocks: FinancialProjectionLockRows;
  readonly correlationId: string;
}

export interface LockedDisputeProjectionReplayReplacement {
  readonly balanceTransactionId: string;
  readonly disputeId: string;
  readonly basis: 'gross_amount' | 'fee';
  readonly previousSetId: string | null;
  readonly replacementSetId: string;
  readonly sourceFingerprint: string;
  readonly disposition: 'inserted' | 'unchanged';
}

export type LockedDisputeProjectionReplayResult =
  | {
      readonly status: 'replayed' | 'unchanged';
      readonly replacements: readonly LockedDisputeProjectionReplayReplacement[];
    }
  | {
      readonly status: 'exception';
      readonly safeCode: FinancialIssueCode;
    };

class DisputeReplayRollback extends Error {
  readonly safeCode: FinancialIssueCode;

  constructor(safeCode: FinancialIssueCode) {
    super('Dispute projection replay must roll back.');
    this.name = 'DisputeReplayRollback';
    this.safeCode = safeCode;
  }
}

interface StoredSet {
  readonly id: string;
  readonly balanceTransactionId: string;
  readonly allocationIdentity: string;
  readonly expectedEffectMinor: number;
  readonly currency: string;
  readonly sourceFingerprint: string;
}

async function loadStoredPlan(
  tx: DatabaseTransaction,
  setId: string,
  basis: 'gross_amount' | 'fee'
): Promise<FinancialAllocationPlan> {
  const [set] = (await rows(
    tx,
    sql`
    select id, balance_transaction_id as "balanceTransactionId",
      allocation_identity as "allocationIdentity", expected_effect_minor as "expectedEffectMinor",
      currency, algorithm_version as "algorithmVersion",
      source_fingerprint_sha256 as "sourceFingerprint", supersedes_set_id as "supersedesSetId",
      reversal_of_set_id as "reversalOfSetId", scope
    from financial_allocation_sets where id = ${setId} and basis = ${basis}
  `
  )) as Array<
    StoredSet & {
      algorithmVersion: number;
      supersedesSetId: string | null;
      reversalOfSetId: string | null;
      scope: 'title' | 'account' | 'unresolved';
    }
  >;
  if (!set) throw new PermanentFinancialError('source_linkage_mismatch');
  const items = (await rows(
    tx,
    sql`
    select order_item_id as "orderItemId", component, effect_minor as "effectMinor",
      currency, tie_break_key as "tieBreakKey"
    from financial_item_allocations where allocation_set_id = ${setId}
    order by tie_break_key, order_item_id, component
  `
  )) as FinancialAllocationPlan['items'];
  return {
    allocationIdentity: set.allocationIdentity,
    balanceTransactionId: set.balanceTransactionId,
    basis,
    scope: set.scope,
    currency: set.currency,
    expectedEffectMinor: set.expectedEffectMinor,
    algorithmVersion: set.algorithmVersion,
    sourceFingerprint: set.sourceFingerprint,
    supersedesSetId: set.supersedesSetId,
    reversalOfSetId: set.reversalOfSetId,
    items
  };
}

async function loadCausalRootPlan(
  tx: DatabaseTransaction,
  setId: string,
  basis: 'gross_amount' | 'fee',
  plans: Map<string, FinancialAllocationPlan>
): Promise<{ readonly setId: string; readonly plan: FinancialAllocationPlan }> {
  const visited = new Set<string>();
  let currentId = setId;
  while (true) {
    if (visited.has(currentId)) throw new PermanentFinancialError('source_linkage_mismatch');
    visited.add(currentId);
    const plan = plans.get(currentId) ?? await loadStoredPlan(tx, currentId, basis);
    plans.set(currentId, plan);
    if (plan.supersedesSetId === null) return { setId: currentId, plan };
    currentId = plan.supersedesSetId;
  }
}

function sameProjection(
  current: FinancialAllocationPlan,
  candidate: FinancialAllocationPlan
): boolean {
  return (
    current.balanceTransactionId === candidate.balanceTransactionId &&
    current.basis === candidate.basis &&
    current.scope === candidate.scope &&
    current.currency === candidate.currency &&
    current.expectedEffectMinor === candidate.expectedEffectMinor &&
    current.algorithmVersion === candidate.algorithmVersion &&
    current.sourceFingerprint === candidate.sourceFingerprint &&
    current.reversalOfSetId === candidate.reversalOfSetId &&
    JSON.stringify([...current.items].sort((left, right) =>
      left.tieBreakKey < right.tieBreakKey ? -1 : left.tieBreakKey > right.tieBreakKey ? 1 : 0
    )) === JSON.stringify([...candidate.items].sort((left, right) =>
      left.tieBreakKey < right.tieBreakKey ? -1 : left.tieBreakKey > right.tieBreakKey ? 1 : 0
    ))
  );
}

function samePresentmentProjection(
  current: readonly BoundDisputePresentmentEffect[],
  candidate: ReturnType<typeof buildDisputeAllocationPlan>['presentmentEffects']
): boolean {
  const material = (effect: (typeof current)[number] | (typeof candidate)[number]) => ({
    disputeId: effect.disputeId,
    orderItemId: effect.orderItemId,
    subtotalMinor: effect.subtotalMinor,
    taxMinor: effect.taxMinor,
    presentmentCurrency: effect.presentmentCurrency,
    effect: effect.effect,
    reversalOfAllocationId: effect.reversalOfAllocationId
  });
  const stable = (effect: ReturnType<typeof material>) =>
    `${effect.orderItemId}\u0000${effect.effect}\u0000${effect.reversalOfAllocationId ?? ''}`;
  return JSON.stringify(current.map(material).sort((left, right) =>
    stable(left) < stable(right) ? -1 : stable(left) > stable(right) ? 1 : 0
  )) === JSON.stringify(candidate.map(material).sort((left, right) =>
    stable(left) < stable(right) ? -1 : stable(left) > stable(right) ? 1 : 0
  ));
}

function componentBackedSucceededRefundIds(
  facts: Pick<PaymentPurchaseFacts, 'refunds' | 'refundComponents'>
): readonly string[] {
  const componentBacked = new Set(facts.refundComponents.map((row) => row.refundId));
  return [...new Set(facts.refunds
    .filter((row) => row.status === 'succeeded' && componentBacked.has(row.id))
    .map((row) => row.id))].sort();
}

function storedEffectsForCurrentSet(
  facts: Awaited<ReturnType<typeof lockCanonicalPaymentPurchaseFacts>>,
  balance: LockedBalance,
  grossSetId: string,
  _plans: ReadonlyMap<string, FinancialAllocationPlan>
): readonly BoundDisputePresentmentEffect[] {
  const allocationById = new Map(facts.disputeItemAllocations.map((row) => [row.id, row]));
  return facts.disputeItemAllocations
    .filter((row) => row.grossAllocationSetId === grossSetId)
    .map((row) => {
      const original =
        row.reversesAllocationId === null ? row : allocationById.get(row.reversesAllocationId);
      if (!original) throw new PermanentFinancialError('source_linkage_mismatch');
      const withdrawalSetId = original.grossAllocationSetId;
      return {
        allocationId: row.id,
        withdrawalSetId,
        disputeId: row.disputeId,
        providerCreatedAt: new Date(balance.providerCreatedAt).toISOString(),
        providerTransactionId: balance.providerId,
        orderItemId: row.orderItemId,
        subtotalMinor: row.subtotalEffectMinor,
        taxMinor: row.taxEffectMinor,
        presentmentCurrency: row.currency,
        effect: row.effect,
        reversalOfAllocationId: row.reversesAllocationId
      } as BoundDisputePresentmentEffect;
    });
}

async function persistPresentmentEffects(
  tx: DatabaseTransaction,
  disputeId: string,
  grossSetId: string,
  withdrawalRootSetId: string,
  effects: ReturnType<typeof buildDisputeAllocationPlan>['presentmentEffects']
): Promise<readonly BoundDisputePresentmentEffect[]> {
  const bound: BoundDisputePresentmentEffect[] = [];
  for (const effect of effects) {
    const reversalId = effect.effect === 'reinstatement' ? effect.reversalOfAllocationId : null;
    const inserted = await rows(
      tx,
      sql`
      insert into dispute_item_allocations (
        allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
        effect, reverses_allocation_id,
        subtotal_effect_minor, tax_effect_minor, total_effect_minor, currency
      ) values (
        ${`${effect.allocationId}:gross:${grossSetId}`}, ${disputeId}, ${grossSetId},
        ${effect.orderItemId}, ${effect.effect}, ${reversalId},
        ${effect.subtotalMinor}, ${effect.taxMinor},
        ${effect.subtotalMinor + effect.taxMinor}, ${effect.presentmentCurrency}
      ) on conflict (gross_allocation_set_id, order_item_id) do nothing returning id
    `
    );
    let allocationId = (inserted[0] as { id?: string } | undefined)?.id;
    if (!allocationId) {
      const existing = (await rows(
        tx,
        sql`
        select id, dispute_id as "disputeId", order_item_id as "orderItemId", effect,
          gross_allocation_set_id as "grossAllocationSetId",
          reverses_allocation_id as "reversesAllocationId",
          subtotal_effect_minor as "subtotalMinor", tax_effect_minor as "taxMinor", currency
        from dispute_item_allocations
        where gross_allocation_set_id = ${grossSetId} and order_item_id = ${effect.orderItemId}
      `
      )) as Array<{
        disputeId: string;
        orderItemId: string;
        effect: string;
        grossAllocationSetId: string;
        reversesAllocationId: string | null;
        subtotalMinor: number;
        taxMinor: number;
        currency: string;
      }>;
      const row = existing[0] as ((typeof existing)[number] & { id?: string }) | undefined;
      if (
        !row ||
        row.disputeId !== disputeId ||
        row.grossAllocationSetId !== grossSetId ||
        row.orderItemId !== effect.orderItemId ||
        row.effect !== effect.effect ||
        row.reversesAllocationId !== reversalId ||
        row.subtotalMinor !== effect.subtotalMinor ||
        row.taxMinor !== effect.taxMinor ||
        row.currency !== effect.presentmentCurrency
      ) {
        throw new PermanentFinancialError('source_linkage_mismatch');
      }
      allocationId = row.id;
    }
    if (!allocationId) throw new PermanentFinancialError('source_linkage_mismatch');
    bound.push({
      ...effect,
      allocationId,
      withdrawalSetId: effect.effect === 'withdrawal'
        ? withdrawalRootSetId
        : effect.withdrawalSetId
    } as BoundDisputePresentmentEffect);
  }
  return bound;
}

interface ReplayStoredTip {
  readonly id: string;
  readonly balanceTransactionId: string;
  readonly basis: 'gross_amount' | 'fee';
  readonly allocationIdentity: string;
  readonly supersedesSetId: string | null;
  readonly classifierVersion: number;
  readonly algorithmVersion: number;
}

interface ReplayDisputeBalance extends LockedBalance {
  readonly classification: string | null;
}

function assertDisputeReplayBoundary(
  input: unknown,
  target: unknown
): asserts input is LockedDisputeProjectionReplayInput {
  if (!exact(input, [
    'orderId', 'paymentId', 'balanceTransactionIds', 'purchaseFacts',
    'projectionLocks', 'correlationId'
  ]) || !UUID.test(input.orderId as string) || !UUID.test(input.paymentId as string) ||
    !Array.isArray(input.balanceTransactionIds) || input.balanceTransactionIds.length < 1 ||
    input.balanceTransactionIds.length > 100 ||
    input.balanceTransactionIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
    new Set(input.balanceTransactionIds).size !== input.balanceTransactionIds.length ||
    !input.purchaseFacts || typeof input.purchaseFacts !== 'object' ||
    !input.projectionLocks || typeof input.projectionLocks !== 'object' ||
    typeof input.correlationId !== 'string' || input.correlationId.length < 1 ||
    input.correlationId.length > 100 || !exact(target, [
      'classifierVersion', 'allocationAlgorithmVersion', 'replayId'
    ]) || typeof target.classifierVersion !== 'number' ||
    !Number.isSafeInteger(target.classifierVersion) || target.classifierVersion < 1 ||
    target.classifierVersion > 2_147_483_647 ||
    typeof target.allocationAlgorithmVersion !== 'number' ||
    !Number.isSafeInteger(target.allocationAlgorithmVersion) ||
    target.allocationAlgorithmVersion < 1 || target.allocationAlgorithmVersion > 2_147_483_647 ||
    target.replayId !== `c${target.classifierVersion}-a${target.allocationAlgorithmVersion}`) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
}

function predecessorForReplay(
  tip: ReplayStoredTip | undefined,
  desiredIdentity: string
): string | null {
  if (!tip) return null;
  return tip.allocationIdentity === desiredIdentity ? tip.supersedesSetId : tip.id;
}

/**
 * Rebuilds the complete already-locked dispute chronology using only durable local facts.
 * The caller owns the canonical purchase/payout/financial lock closure and issue transitions.
 */
async function recomputeLockedDisputeFinancialProjectionForVersionInSavepoint(
  tx: DatabaseTransaction,
  input: LockedDisputeProjectionReplayInput,
  target: LockedDisputeProjectionReplayVersion
): Promise<LockedDisputeProjectionReplayResult> {
  assertDisputeReplayBoundary(input, target);
  if (input.purchaseFacts.order.id !== input.orderId ||
    input.purchaseFacts.payment.id !== input.paymentId ||
    input.purchaseFacts.payment.orderId !== input.orderId) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
  const lockedIds = new Set(input.projectionLocks.balanceTransactions.map((row) => row.id));
  if (input.balanceTransactionIds.some((id) => !lockedIds.has(id))) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
  const balances = await rows(tx, sql`
    select balance.id, balance.provider_id as "providerId", balance.source_id as "sourceId",
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
    )}) and balance.source_family = 'dispute'
    order by balance.provider_created_at, balance.provider_id collate "C", balance.id
    for update of balance
  `) as ReplayDisputeBalance[];
  if (balances.length !== input.balanceTransactionIds.length ||
    new Set(balances.map((row) => row.id)).size !== balances.length ||
    balances.some((balance) => !UUID.test(balance.id) || !FINGERPRINT.test(balance.fingerprintSha256) ||
      !input.projectionLocks.balanceTransactions.some((locked) => locked.id === balance.id &&
        locked.fingerprintSha256 === balance.fingerprintSha256) ||
      typeof balance.sourceId !== 'string' || balance.sourceId.length < 1 ||
      !boundedMoney(balance.amountMinor) || !boundedMoney(balance.feeMinor) ||
      balance.feeMinor < 0 || !boundedMoney(balance.netMinor) ||
      BigInt(balance.amountMinor) - BigInt(balance.feeMinor) !== BigInt(balance.netMinor) ||
      !CURRENCY.test(balance.currency) ||
      !['dispute_withdrawal', 'dispute_reinstatement', 'fee_credit']
        .includes(balance.classification ?? ''))) {
    return { status: 'exception', safeCode: 'source_linkage_mismatch' };
  }
  const tips = await rows(tx, sql`
    select allocation.id, allocation.balance_transaction_id as "balanceTransactionId",
      allocation.basis, allocation.allocation_identity as "allocationIdentity",
      allocation.supersedes_set_id as "supersedesSetId",
      allocation.classifier_version as "classifierVersion",
      allocation.algorithm_version as "algorithmVersion"
    from financial_allocation_sets allocation
    where allocation.balance_transaction_id in (${sql.join(
      input.balanceTransactionIds.map((id) => sql`${id}::uuid`), sql`, `
    )}) and not exists (
      select 1 from financial_allocation_sets successor
      where successor.supersedes_set_id = allocation.id
    )
    order by allocation.balance_transaction_id, allocation.basis, allocation.id
    for update
  `) as ReplayStoredTip[];
  if (tips.some((tip) => !UUID.test(tip.id) ||
    !input.balanceTransactionIds.includes(tip.balanceTransactionId) ||
    !Number.isSafeInteger(tip.classifierVersion) || tip.classifierVersion < 1 ||
    !Number.isSafeInteger(tip.algorithmVersion) || tip.algorithmVersion < 1) ||
    input.balanceTransactionIds.some((id) =>
      tips.filter((tip) => tip.balanceTransactionId === id && tip.basis === 'gross_amount').length > 1 ||
      tips.filter((tip) => tip.balanceTransactionId === id && tip.basis === 'fee').length > 1)) {
    return { status: 'exception', safeCode: 'allocation_fork' };
  }

  const planBySetId = new Map<string, FinancialAllocationPlan>();
  const causalRootByGrossSet = new Map<string, string>();
  const activeSetByBalanceBasis = new Map<string, string>();
  for (const tip of tips) {
    const plan = await loadStoredPlan(tx, tip.id, tip.basis);
    planBySetId.set(tip.id, plan);
    activeSetByBalanceBasis.set(`${tip.balanceTransactionId}:${tip.basis}`, tip.id);
    if (tip.basis === 'gross_amount') {
      causalRootByGrossSet.set(tip.id,
        (await loadCausalRootPlan(tx, tip.id, tip.basis, planBySetId)).setId);
    }
  }

  const priorEffects: BoundDisputePresentmentEffect[] = [];
  const replacements: LockedDisputeProjectionReplayReplacement[] = [];
  let exposureChanged = false;
  for (const balance of balances) {
    const sourceDispute = input.purchaseFacts.disputes.find((candidate) =>
      candidate.stripeDisputeId === balance.sourceId);
    if (!sourceDispute || sourceDispute.paymentId !== input.paymentId) {
      return { status: 'exception', safeCode: 'source_linkage_mismatch' };
    }
    const detailRows = await rows(tx, sql`
      select detail.amount_minor as "amountMinor", decision.classification
      from stripe_balance_transaction_fee_details detail
      left join financial_classification_versions decision
        on decision.subject_type = 'fee_detail' and decision.subject_id = detail.id
        and decision.classifier_version = ${target.classifierVersion}
        and decision.source_fingerprint_sha256 = detail.fingerprint_sha256
      where detail.balance_transaction_id = ${balance.id}
      order by detail.ordinal
      for update of detail
    `) as Array<{ amountMinor: number; classification: string | null }>;
    const componentByClassification = {
      dispute_fee: 'dispute_fee', provider_fee_tax: 'provider_fee_tax',
      fee_credit: 'fee_credit', other: 'other'
    } as const;
    const feeDetails: ClassifiedFeeDetail[] = [];
    for (const detail of detailRows) {
      const component = componentByClassification[
        detail.classification as keyof typeof componentByClassification
      ];
      if (!boundedMoney(detail.amountMinor) || detail.amountMinor < 0 || !component) {
        return { status: 'exception', safeCode: 'unsupported_category' };
      }
      feeDetails.push({ amountMinor: -detail.amountMinor, component });
    }
    if (detailRows.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n) !==
      BigInt(balance.feeMinor)) {
      return { status: 'exception', safeCode: 'allocation_mismatch' };
    }
    const effectKind = balance.classification === 'dispute_withdrawal'
      ? 'withdrawal' as const
      : balance.classification === 'dispute_reinstatement'
        ? 'reinstatement' as const
        : 'fee_credit' as const;
    const outstandingSetIds = [...new Set(priorEffects.filter((row) =>
      row.disputeId === sourceDispute.id && row.effect === 'withdrawal' &&
      !priorEffects.some((candidate) => candidate.effect === 'reinstatement' &&
        candidate.reversalOfAllocationId === row.allocationId)
    ).map((row) => row.withdrawalSetId))];
    if (effectKind !== 'withdrawal' && outstandingSetIds.length !== 1) {
      return { status: 'exception', safeCode: 'allocation_mismatch' };
    }
    const outstandingGrossSetId = effectKind === 'withdrawal' ? null : outstandingSetIds[0]!;
    const causalWithdrawal = outstandingGrossSetId === null ? null :
      await loadCausalRootPlan(tx, outstandingGrossSetId, 'gross_amount', planBySetId);
    const currentWithdrawalGrossSetId = causalWithdrawal === null ? null :
      activeSetByBalanceBasis.get(`${causalWithdrawal.plan.balanceTransactionId}:gross_amount`) ?? null;
    const currentWithdrawalGrossPlan = currentWithdrawalGrossSetId === null ? null :
      planBySetId.get(currentWithdrawalGrossSetId) ?? null;
    let reversesFeeSetId: string | null = null;
    let withdrawalFeePlan: FinancialAllocationPlan | null = null;
    if (effectKind === 'fee_credit') {
      if (!currentWithdrawalGrossPlan) {
        return { status: 'exception', safeCode: 'source_linkage_mismatch' };
      }
      reversesFeeSetId = activeSetByBalanceBasis.get(
        `${currentWithdrawalGrossPlan.balanceTransactionId}:fee`
      ) ?? null;
      withdrawalFeePlan = reversesFeeSetId === null ? null :
        planBySetId.get(reversesFeeSetId) ?? null;
      if (!withdrawalFeePlan) return { status: 'exception', safeCode: 'allocation_mismatch' };
    }
    const finalizedRefunds: FinalizedDisputeRefund[] = input.purchaseFacts.refundComponents
      .flatMap((component) => {
        const refund = input.purchaseFacts.refunds.find((candidate) =>
          candidate.id === component.refundId);
        return !refund || refund.status !== 'succeeded' ||
          compareFinancialExposureChronology({
            providerCreatedAtMs: refund.providerCreatedAt.getTime(),
            providerId: refund.stripeRefundId,
            sourceId: refund.id,
            rowId: component.refundAllocationId
          }, {
            providerCreatedAtMs: new Date(balance.providerCreatedAt).getTime(),
            providerId: balance.providerId,
            sourceId: sourceDispute.id,
            rowId: ''
          }) >= 0
          ? [] : [{ refundId: refund.id, providerRefundId: refund.stripeRefundId,
              componentId: component.refundAllocationId,
              providerCreatedAt: refund.providerCreatedAt.toISOString(),
              orderItemId: component.orderItemId, subtotalMinor: component.subtotalMinor,
              taxMinor: component.taxMinor, presentmentCurrency: component.currency }];
      });
    const grossTip = tips.find((tip) => tip.balanceTransactionId === balance.id &&
      tip.basis === 'gross_amount');
    const feeTip = tips.find((tip) => tip.balanceTransactionId === balance.id &&
      tip.basis === 'fee');
    const prefix = `dispute:${sourceDispute.id}:${balance.id}:replay:${target.replayId}`;
    const exactOutstandingPresentment = outstandingGrossSetId === null ? null :
      -priorEffects.filter((row) => row.disputeId === sourceDispute.id &&
        row.effect === 'withdrawal' && row.withdrawalSetId === outstandingGrossSetId &&
        !priorEffects.some((candidate) => candidate.effect === 'reinstatement' &&
          candidate.reversalOfAllocationId === row.allocationId))
        .reduce((sum, row) => sum + row.subtotalMinor + row.taxMinor, 0);
    const presentmentCurrency = effectKind === 'fee_credit'
      ? balance.currency : sourceDispute.currency;
    const presentmentAmountMinor = effectKind === 'fee_credit'
      ? Math.abs(balance.amountMinor)
      : balance.currency === sourceDispute.currency
        ? Math.abs(balance.amountMinor)
        : effectKind === 'reinstatement'
          ? (exactOutstandingPresentment ?? 0)
          : sourceDispute.amountMinor;
    const bundle = buildDisputeAllocationPlan({
      sourceKind: 'dispute', sourceId: sourceDispute.id, disputeId: sourceDispute.id,
      balanceTransactionId: balance.id, providerTransactionId: balance.providerId,
      providerCreatedAt: new Date(balance.providerCreatedAt).toISOString(),
      allocationIdentityPrefix: prefix, settlementCurrency: balance.currency,
      amountMinor: balance.amountMinor, feeMinor: balance.feeMinor, netMinor: balance.netMinor,
      sourceFingerprint: balance.fingerprintSha256,
      algorithmVersion: target.allocationAlgorithmVersion,
      supersedesGrossSetId: predecessorForReplay(grossTip, `${prefix}:gross`),
      supersedesFeeSetId: predecessorForReplay(feeTip, `${prefix}:fee`),
      effect: effectKind, presentmentAmountMinor, presentmentCurrency,
      paymentItems: input.purchaseFacts.orderItems.map((item) => {
        if (item.taxMinor === null) throw new PermanentFinancialError('allocation_mismatch');
        return { orderItemId: item.id, subtotalMinor: item.unitSubtotalMinor,
          taxMinor: item.taxMinor, presentmentCurrency: item.currency };
      }),
      finalizedRefunds, priorPresentmentEffects: [...priorEffects], withdrawalSetId: null,
      reversesSetId: effectKind === 'reinstatement' ? outstandingGrossSetId : null,
      reversesFeeSetId,
      withdrawalGrossPlan: effectKind === 'reinstatement' ? currentWithdrawalGrossPlan : null,
      withdrawalFeePlan, feeDetails
    });
    const currentTargetPresentmentEffects = grossTip === undefined ||
      grossTip.classifierVersion !== target.classifierVersion ||
      grossTip.algorithmVersion !== target.allocationAlgorithmVersion
      ? []
      : storedEffectsForCurrentSet(
          input.purchaseFacts, balance, grossTip.id, planBySetId
        );
    const pair: Array<{ setId: string; disposition: 'inserted' | 'unchanged';
      plan: FinancialAllocationPlan }> = [];
    for (const plan of bundle.plans) {
      const saved = await persistFinancialAllocationReplayPlanLocked(tx, {
        plan, sourceKind: 'dispute', sourceId: sourceDispute.id,
        classificationVersion: target.classifierVersion,
        correlationId: input.correlationId
      }, { classifierVersion: target.classifierVersion,
        allocationAlgorithmVersion: target.allocationAlgorithmVersion });
      pair.push({ ...saved, plan });
      planBySetId.set(saved.setId, plan);
      activeSetByBalanceBasis.set(`${balance.id}:${plan.basis}`, saved.setId);
      replacements.push({ balanceTransactionId: balance.id, disputeId: sourceDispute.id,
        basis: plan.basis, previousSetId: plan.supersedesSetId,
        replacementSetId: saved.setId, sourceFingerprint: plan.sourceFingerprint,
        disposition: saved.disposition });
      if (plan.basis === 'gross_amount') {
        causalRootByGrossSet.set(saved.setId, saved.setId);
      }
    }
    const savedGross = pair.find((row) => row.plan.basis === 'gross_amount');
    if (savedGross?.disposition === 'inserted' &&
      !samePresentmentProjection(
        currentTargetPresentmentEffects, bundle.presentmentEffects
      )) {
      exposureChanged = true;
    }
    if (bundle.presentmentEffects.length > 0) {
      priorEffects.push(...await persistPresentmentEffects(tx, sourceDispute.id,
        pair[0]!.setId, pair[0]!.setId,
        bundle.presentmentEffects));
    }
  }
  const affectedRefundIds = exposureChanged
    ? componentBackedSucceededRefundIds(input.purchaseFacts)
    : [];
  if (affectedRefundIds.length > 0) {
    await rearmCurrentProjectionSubjectsForFinancialSources(tx, {
      sourceKind: 'refund', sourceIds: affectedRefundIds
    });
  }
  return replacements.some((row) => row.disposition === 'inserted')
    ? { status: 'replayed', replacements }
    : { status: 'unchanged', replacements };
}

export async function recomputeLockedDisputeFinancialProjectionForVersion(
  tx: DatabaseTransaction,
  input: LockedDisputeProjectionReplayInput,
  target: LockedDisputeProjectionReplayVersion
): Promise<LockedDisputeProjectionReplayResult> {
  assertDisputeReplayBoundary(input, target);
  try {
    return await tx.transaction(async (replayTx) => {
      const result = await recomputeLockedDisputeFinancialProjectionForVersionInSavepoint(
        replayTx, input, target
      );
      if (result.status === 'exception') throw new DisputeReplayRollback(result.safeCode);
      return result;
    });
  } catch (error) {
    if (error instanceof DisputeReplayRollback) {
      return { status: 'exception', safeCode: error.safeCode };
    }
    throw error;
  }
}

export async function reconcileDisputeFinancialSource(
  database: Database,
  gateway: StripeCommerceGateway,
  input: { disputeId: string; correlationId: string },
  signal: AbortSignal
): Promise<FinancialSourceResult> {
  assertFinancialSourceInput(input, 'disputeId', signal);
  throwIfFinancialSourceAborted(signal);
  const [routing] = await database
    .select({
      id: disputes.id,
      stripeDisputeId: disputes.stripeDisputeId,
      paymentId: payments.id,
      orderId: orders.id,
      stripePaymentIntentId: payments.stripePaymentIntentId
    })
    .from(disputes)
    .innerJoin(payments, eq(payments.id, disputes.paymentId))
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(disputes.id, input.disputeId))
    .limit(1);
  if (!routing) throw new RetryableFinancialError('local_state_pending');
  throwIfFinancialSourceAborted(signal);

  let canonicalDispute: DisputeSnapshot;
  let payment: PaymentSnapshot;
  let charge: ChargeSnapshot;
  const snapshots: BalanceTransactionSnapshot[] = [];
  const staged: Array<{
    internalId: string;
    snapshot: BalanceTransactionSnapshot;
  }> = [];
  try {
    const rawDispute = await financialProviderCall(signal, () =>
      gateway.retrieveDispute(routing.stripeDisputeId)
    );
    canonicalDispute = providerEvidence(() => parseDisputeSnapshot(rawDispute));
    const rawPayment = await financialProviderCall(signal, () =>
      gateway.retrievePayment(routing.stripePaymentIntentId)
    );
    payment = providerEvidence(() => parsePaymentSnapshot(rawPayment));
    if (payment.latestChargeId === null) throw new RetryableFinancialError('provider_not_ready');
    const latestChargeId = payment.latestChargeId;
    const rawCharge = await financialProviderCall(signal, () =>
      gateway.retrieveCharge(latestChargeId)
    );
    charge = providerEvidence(() => parseChargeSnapshot(rawCharge, payment.liveMode));
    assertDisputeLinkage(routing, canonicalDispute, payment, charge);

    for (const providerId of canonicalDispute.balanceTransactionIds) {
      const snapshot = parseBalanceEvidence(
        await financialProviderCall(signal, () => gateway.retrieveBalanceTransaction(providerId)),
        canonicalDispute.liveMode
      );
      assertDisputeBalance(canonicalDispute, snapshot);
      snapshots.push(snapshot);
    }
    snapshots.sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
    for (const snapshot of snapshots) {
      const result = await stageBalanceTransaction(database, snapshot, {
        correlationId: input.correlationId
      });
      staged.push({ internalId: result.balanceTransactionId, snapshot });
      throwIfFinancialSourceAborted(signal);
    }
  } catch (error) {
    const safeCode = durableIssueCode(error);
    if (safeCode) {
      return recordLocalFinancialSourceIssue(
        database,
        {
          sourceKind: 'dispute',
          sourceId: routing.id,
          providerSourceId: routing.stripeDisputeId,
          paymentId: routing.paymentId,
          orderId: routing.orderId,
          stripePaymentIntentId: routing.stripePaymentIntentId
        },
        input.correlationId,
        safeCode,
        'exception',
        signal,
        ACTOR
      );
    }
    throw error;
  }

  const priorBalanceRows =
    ((
      (await database.execute(sql`
    select distinct allocation_set.balance_transaction_id as "balanceTransactionId",
      allocation_set.source_internal_id as "disputeId"
    from financial_allocation_sets allocation_set
    join disputes dispute on dispute.id = allocation_set.source_internal_id
    where allocation_set.source_kind = 'dispute' and dispute.payment_id = ${routing.paymentId}
    order by allocation_set.balance_transaction_id
  `)) as QueryResult
    ).rows as Array<{ balanceTransactionId: string; disputeId: string }> | undefined) ?? [];
  const priorBalanceIds = priorBalanceRows.map((row) => row.balanceTransactionId);
  const sourceDisputeIdByBalance = new Map(
    priorBalanceRows.map((row) => [row.balanceTransactionId, row.disputeId])
  );
  for (const value of staged) sourceDisputeIdByBalance.set(value.internalId, routing.id);
  const sourceBalanceIds = [
    ...new Set([...staged.map((value) => value.internalId), ...priorBalanceIds])
  ].sort();
  const closureRows =
    sourceBalanceIds.length === 0
      ? []
      : (((
          (await database.execute(sql`
    select payout.id as "payoutId", payout.financial_generation as "expectedGeneration",
      member.balance_transaction_id as "balanceTransactionId"
    from stripe_payout_balance_transactions source_membership
    join stripe_payouts payout on payout.id = source_membership.payout_id
    join stripe_payout_balance_transactions member on member.payout_id = payout.id
    where source_membership.balance_transaction_id in (
      ${sql.join(
        sourceBalanceIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )}
    )
    order by payout.id, member.balance_transaction_id
  `)) as QueryResult
        ).rows as
          | Array<{
              payoutId: string;
              expectedGeneration: number;
              balanceTransactionId: string;
            }>
          | undefined) ?? []);
  const payoutGenerations = [
    ...new Map(
      closureRows.map((row) => [
        row.payoutId,
        {
          payoutId: row.payoutId,
          expectedGeneration: row.expectedGeneration
        }
      ])
    ).values()
  ].sort((left, right) => (left.payoutId < right.payoutId ? -1 : 1));
  const lockBalanceIds = [
    ...new Set([...sourceBalanceIds, ...closureRows.map((row) => row.balanceTransactionId)])
  ].sort();
  const affectedDisputeIds = [
    ...new Set([routing.id, ...sourceDisputeIdByBalance.values()])
  ].sort();
  throwIfFinancialSourceAborted(signal);

  return database.transaction(async (tx) => {
    throwIfFinancialSourceAborted(signal);
    await lockActiveFinancialProjectionImplementation(tx, {
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    });
    const facts = await lockCanonicalPaymentPurchaseFacts(tx, {
      paymentId: routing.paymentId,
      orderId: routing.orderId,
      payment,
      charge
    });
    const current = facts.disputes.find((value) => value.id === routing.id);
    if (
      !current ||
      current.paymentId !== routing.paymentId ||
      current.stripeDisputeId !== canonicalDispute.providerDisputeId ||
      current.status !== canonicalDispute.state ||
      current.amountMinor !== canonicalDispute.amountMinor ||
      current.currency !== canonicalDispute.currency.toUpperCase() ||
      !sameInstant(current.providerCreatedAt, canonicalDispute.providerCreatedAt)
    )
      stateChanged();
    const affectedRefundIds = componentBackedSucceededRefundIds(facts);
    if (affectedRefundIds.length > 0) {
      await lockFinancialProjectionEnrollment(tx);
    }
    const lockRows = await lockFinancialProjectionRows(tx, {
      payoutGenerations,
      balanceTransactionIds: lockBalanceIds,
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      issueKeys: affectedDisputeIds.flatMap((resourceId) =>
        ISSUE_CODES.map((safeCode) => ({
          resourceType: 'dispute' as const,
          resourceId,
          safeCode
        }))
      )
    });
    if (staged.length === 0) {
      return recordLockedIssue(
        tx,
        routing.id,
        input.correlationId,
        'missing_source',
        'pending',
        signal
      );
    }

    let failingDisputeId = routing.id;
    const outcome = await (async () => {
      try {
        const value = await tx.transaction(async (projectionTx) => {
          const persisted: Array<{
            setId: string;
            disposition: 'inserted' | 'unchanged';
            sourceDisputeId: string;
          }> = [];
          const planBySetId = new Map<string, FinancialAllocationPlan>();
          const causalRootByGrossSet = new Map<string, string>();
          const activeSetByBalanceBasis = new Map<string, string>();
          let exposureChanged = false;
          const stagedByBalanceId = new Map(
            staged.map((value) => [value.internalId, value.snapshot])
          );
          const currentProjections =
            (await loadCurrentEffectiveAllocationProjection(projectionTx, {
              balanceTransactionIds: sourceBalanceIds
            })) ?? [];
          const currentByBalanceBasis = new Map(
            currentProjections.map((projection) => [
              `${projection.balanceTransactionId}:${projection.basis}`,
              projection
            ])
          );
          for (const balanceId of sourceBalanceIds) {
            for (const basis of ['gross_amount', 'fee'] as const) {
              const projection = currentByBalanceBasis.get(`${balanceId}:${basis}`);
              failingDisputeId = sourceDisputeIdByBalance.get(balanceId) ?? routing.id;
              if (!projection) {
                if (priorBalanceIds.includes(balanceId)) {
                  throw new PermanentFinancialError('allocation_mismatch');
                }
                continue;
              }
              if (projection.status !== 'complete') {
                if (!priorBalanceIds.includes(balanceId)) continue;
                throw new PermanentFinancialError(
                  projection?.status === 'exception' &&
                    projection.safeCode === 'correction_rebase_required'
                    ? 'correction_rebase_required'
                    : 'allocation_mismatch'
                );
              }
              const plan = await loadStoredPlan(
                projectionTx, projection.baseSetId, basis
              );
              planBySetId.set(projection.baseSetId, plan);
              if (basis === 'gross_amount') {
                causalRootByGrossSet.set(
                  projection.baseSetId,
                  (await loadCausalRootPlan(
                    projectionTx, projection.baseSetId, basis, planBySetId
                  )).setId
                );
              }
            }
          }

          const balances: LockedBalance[] = [];
          for (const balanceId of sourceBalanceIds) {
            const [balance] = (await rows(
              projectionTx,
              sql`
              select id, provider_id as "providerId", source_id as "sourceId",
                amount_minor as "amountMinor",
                fee_minor as "feeMinor", net_minor as "netMinor", currency,
                fingerprint_sha256 as "fingerprintSha256",
                provider_created_at as "providerCreatedAt"
              from stripe_balance_transactions where id = ${balanceId} for update
            `
            )) as LockedBalance[];
            const lockedFingerprint = lockRows.balanceTransactions.find(
              (row) => row.id === balanceId
            )?.fingerprintSha256;
            const snapshot = stagedByBalanceId.get(balanceId);
            if (
              !balance ||
              balance.fingerprintSha256 !== lockedFingerprint ||
              (snapshot &&
                (balance.providerId !== snapshot.id ||
                  balance.sourceId !== snapshot.sourceId ||
                  balance.amountMinor !== snapshot.amountMinor ||
                  balance.feeMinor !== snapshot.feeMinor ||
                  balance.netMinor !== snapshot.netMinor ||
                  balance.currency !== snapshot.currency ||
                  !sameInstant(new Date(balance.providerCreatedAt), snapshot.createdAt)))
            )
              stateChanged();
            balances.push(balance);
          }
          balances.sort(
            (left, right) =>
              new Date(left.providerCreatedAt).getTime() -
                new Date(right.providerCreatedAt).getTime() ||
              (left.providerId < right.providerId ? -1 : left.providerId > right.providerId ? 1 : 0)
          );

          const priorEffects: BoundDisputePresentmentEffect[] = [];
          for (const balance of balances) {
            failingDisputeId = sourceDisputeIdByBalance.get(balance.id) ?? routing.id;
            const sourceDispute = facts.disputes.find(
              (candidate) => candidate.stripeDisputeId === balance.sourceId
            );
            if (!sourceDispute) throw new PermanentFinancialError('source_linkage_mismatch');
            failingDisputeId = sourceDispute.id;
            const classification = lockRows.classifications.filter(
              (row) => row.subjectType === 'balance_transaction' && row.subjectId === balance.id
            );
            if (
              classification.length !== 1 ||
              !['dispute_withdrawal', 'dispute_reinstatement', 'fee_credit'].includes(
                classification[0]!.classification
              )
            ) {
              throw new PermanentFinancialError('unsupported_provider_evidence');
            }
            const detailRows = (await rows(
              projectionTx,
              sql`
              select detail.amount_minor as "amountMinor", decision.classification
              from stripe_balance_transaction_fee_details detail
              left join financial_classification_versions decision
                on decision.subject_type = 'fee_detail' and decision.subject_id = detail.id
                and decision.classifier_version = ${FINANCIAL_CLASSIFIER_VERSION}
                and decision.source_fingerprint_sha256 = detail.fingerprint_sha256
              where detail.balance_transaction_id = ${balance.id}
              order by detail.ordinal
            `
            )) as Array<{ amountMinor: number; classification: string | null }>;
            const componentByClassification = {
              dispute_fee: 'dispute_fee',
              provider_fee_tax: 'provider_fee_tax',
              fee_credit: 'fee_credit',
              other: 'other'
            } as const;
            const feeDetails: ClassifiedFeeDetail[] = detailRows.map((row) => {
              const component =
                componentByClassification[
                  row.classification as keyof typeof componentByClassification
                ];
              if (!component) throw new PermanentFinancialError('unsupported_provider_evidence');
              return { amountMinor: -row.amountMinor, component };
            });
            const effectKind =
              classification[0]!.classification === 'dispute_withdrawal'
                ? ('withdrawal' as const)
                : classification[0]!.classification === 'dispute_reinstatement'
                  ? ('reinstatement' as const)
                  : ('fee_credit' as const);
            const withdrawal = effectKind === 'withdrawal';
            const outstandingSetIds = [
              ...new Set(
                priorEffects
                  .filter(
                    (row) =>
                      row.disputeId === sourceDispute.id &&
                      row.effect === 'withdrawal' &&
                      !priorEffects.some(
                        (candidate) =>
                          candidate.effect === 'reinstatement' &&
                          candidate.reversalOfAllocationId === row.allocationId
                      )
                  )
                  .map((row) => row.withdrawalSetId)
              )
            ];
            if (!withdrawal && outstandingSetIds.length !== 1) {
              throw new PermanentFinancialError('allocation_mismatch');
            }
            const outstandingGrossSetId = withdrawal ? null : outstandingSetIds[0]!;
            const causalWithdrawal = outstandingGrossSetId === null
              ? null
              : await loadCausalRootPlan(
                  projectionTx, outstandingGrossSetId, 'gross_amount', planBySetId
                );
            const currentWithdrawalGrossSetId = causalWithdrawal === null
              ? null
              : activeSetByBalanceBasis.get(
                  `${causalWithdrawal.plan.balanceTransactionId}:gross_amount`
                ) ?? null;
            const currentWithdrawalGrossPlan = currentWithdrawalGrossSetId === null
              ? null
              : planBySetId.get(currentWithdrawalGrossSetId) ?? null;
            let reversesFeeSetId: string | null = null;
            let withdrawalFeePlan: FinancialAllocationPlan | null = null;
            if (effectKind === 'fee_credit') {
              if (!currentWithdrawalGrossPlan) {
                throw new PermanentFinancialError('source_linkage_mismatch');
              }
              reversesFeeSetId =
                activeSetByBalanceBasis.get(
                  `${currentWithdrawalGrossPlan.balanceTransactionId}:fee`
                ) ??
                null;
              withdrawalFeePlan =
                reversesFeeSetId === null ? null : (planBySetId.get(reversesFeeSetId) ?? null);
              if (!withdrawalFeePlan) throw new PermanentFinancialError('allocation_mismatch');
            }
            const paymentItems: DisputePaymentItem[] = facts.orderItems.map((item) => ({
              orderItemId: item.id,
              subtotalMinor: item.unitSubtotalMinor,
              taxMinor: item.taxMinor!,
              presentmentCurrency: item.currency
            }));
            const finalizedRefunds: FinalizedDisputeRefund[] = facts.refundComponents.flatMap(
              (component) => {
                const refund = facts.refunds.find(
                  (candidate) => candidate.id === component.refundId
                );
                return !refund || refund.status !== 'succeeded' ||
                  compareFinancialExposureChronology({
                    providerCreatedAtMs: refund.providerCreatedAt.getTime(),
                    providerId: refund.stripeRefundId,
                    sourceId: refund.id,
                    rowId: component.refundAllocationId
                  }, {
                    providerCreatedAtMs: new Date(balance.providerCreatedAt).getTime(),
                    providerId: balance.providerId,
                    sourceId: sourceDispute.id,
                    rowId: ''
                  }) >= 0
                  ? []
                  : [
                      {
                        refundId: refund.id,
                        providerRefundId: refund.stripeRefundId,
                        componentId: component.refundAllocationId,
                        providerCreatedAt: refund.providerCreatedAt.toISOString(),
                        orderItemId: component.orderItemId,
                        subtotalMinor: component.subtotalMinor,
                        taxMinor: component.taxMinor,
                        presentmentCurrency: component.currency
                      }
                    ];
              }
            );
            const grossKey = `${balance.id}:gross_amount`;
            const feeKey = `${balance.id}:fee`;
            const currentGross = currentByBalanceBasis.get(grossKey);
            const currentFee = currentByBalanceBasis.get(feeKey);
            const currentGrossSetId =
              currentGross?.status === 'complete' ? currentGross.baseSetId : null;
            const currentFeeSetId = currentFee?.status === 'complete' ? currentFee.baseSetId : null;
            const exactOutstandingPresentment =
              outstandingGrossSetId === null
                ? null
                : -priorEffects
                    .filter(
                      (row) =>
                        row.disputeId === sourceDispute.id &&
                        row.effect === 'withdrawal' &&
                        row.withdrawalSetId === outstandingGrossSetId &&
                        !priorEffects.some(
                          (candidate) =>
                            candidate.effect === 'reinstatement' &&
                            candidate.reversalOfAllocationId === row.allocationId
                        )
                    )
                    .reduce((sum, row) => sum + row.subtotalMinor + row.taxMinor, 0);
            const presentmentCurrency =
              effectKind === 'fee_credit' ? balance.currency : sourceDispute.currency;
            const presentmentAmountMinor =
              effectKind === 'fee_credit'
                ? Math.abs(balance.amountMinor)
                : balance.currency === sourceDispute.currency
                  ? Math.abs(balance.amountMinor)
                  : effectKind === 'reinstatement'
                    ? (exactOutstandingPresentment ?? 0)
                    : sourceDispute.amountMinor;
            const bundle = buildDisputeAllocationPlan({
              sourceKind: 'dispute',
              sourceId: sourceDispute.id,
              disputeId: sourceDispute.id,
              balanceTransactionId: balance.id,
              providerTransactionId: balance.providerId,
              providerCreatedAt: new Date(balance.providerCreatedAt).toISOString(),
              allocationIdentityPrefix: `dispute:${sourceDispute.id}:${balance.id}:v:${currentGrossSetId ?? 'root'}:${currentFeeSetId ?? 'root'}`,
              settlementCurrency: balance.currency,
              amountMinor: balance.amountMinor,
              feeMinor: balance.feeMinor,
              netMinor: balance.netMinor,
              sourceFingerprint: balance.fingerprintSha256,
              algorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
              supersedesGrossSetId: currentGrossSetId,
              supersedesFeeSetId: currentFeeSetId,
              effect: effectKind,
              presentmentAmountMinor,
              presentmentCurrency,
              paymentItems,
              finalizedRefunds,
              priorPresentmentEffects: [...priorEffects],
              withdrawalSetId: null,
              reversesSetId: effectKind === 'reinstatement' ? outstandingGrossSetId : null,
              reversesFeeSetId,
              withdrawalGrossPlan: effectKind === 'reinstatement'
                ? currentWithdrawalGrossPlan
                : null,
              withdrawalFeePlan,
              feeDetails
            });
            const currentPresentmentEffects = currentGrossSetId === null
              ? []
              : storedEffectsForCurrentSet(
                  facts, balance, currentGrossSetId, planBySetId
                );
            const pair: Array<{
              setId: string;
              disposition: 'inserted' | 'unchanged';
            }> = [];
            for (const plan of bundle.plans) {
              const currentSetId =
                plan.basis === 'gross_amount' ? currentGrossSetId : currentFeeSetId;
              const currentPlan =
                currentSetId === null ? null : (planBySetId.get(currentSetId) ?? null);
              const currentEffects =
                plan.basis !== 'gross_amount' || currentSetId === null
                  ? []
                  : currentPresentmentEffects;
              const unchanged =
                currentPlan !== null &&
                sameProjection(currentPlan, plan) &&
                (plan.basis !== 'gross_amount' ||
                  samePresentmentProjection(currentEffects, bundle.presentmentEffects));
              const saved = unchanged
                ? { setId: currentSetId!, disposition: 'unchanged' as const }
                : await persistFinancialAllocationPlanLocked(projectionTx, {
                    plan,
                    sourceKind: 'dispute',
                    sourceId: sourceDispute.id,
                    classificationVersion: FINANCIAL_CLASSIFIER_VERSION,
                    correlationId: input.correlationId
                  });
              pair.push(saved);
              planBySetId.set(saved.setId, unchanged ? currentPlan! : plan);
              if (plan.basis === 'gross_amount') {
                causalRootByGrossSet.set(saved.setId, saved.setId);
              }
              activeSetByBalanceBasis.set(`${balance.id}:${plan.basis}`, saved.setId);
            }
            const savedGross = pair[0];
            if (savedGross?.disposition === 'inserted' &&
              !samePresentmentProjection(
                currentPresentmentEffects, bundle.presentmentEffects
              )) {
              exposureChanged = true;
            }
            persisted.push(
              ...pair.map((value) => ({ ...value, sourceDisputeId: sourceDispute.id }))
            );
            if (bundle.presentmentEffects.length !== 0) {
              priorEffects.push(
                ...(pair[0]!.disposition === 'unchanged'
                  ? storedEffectsForCurrentSet(
                      facts, balance, pair[0]!.setId, planBySetId
                    )
                  : await persistPresentmentEffects(
                      projectionTx,
                      sourceDispute.id,
                      pair[0]!.setId,
                      pair[0]!.setId,
                      bundle.presentmentEffects
                    ))
              );
            }
          }
          const projections = await loadCurrentEffectiveAllocationProjection(projectionTx, {
            balanceTransactionIds: sourceBalanceIds
          });
          if (
            projections.length !== sourceBalanceIds.length * 2 ||
            projections.some((projection) => projection.status !== 'complete')
          ) {
            const failure = projections.find((projection) => projection.status !== 'complete');
            const failedBalanceId =
              failure?.balanceTransactionId ??
              sourceBalanceIds.find(
                (balanceId) =>
                  projections.filter(
                    (projection) => projection.balanceTransactionId === balanceId
                  ).length !== 2
              );
            if (failedBalanceId) {
              failingDisputeId =
                sourceDisputeIdByBalance.get(failedBalanceId) ?? routing.id;
            }
            throw new PermanentFinancialError(
              failure?.status === 'exception' && failure.safeCode === 'correction_rebase_required'
                ? 'correction_rebase_required'
                : 'allocation_mismatch'
            );
          }
          return {
            persisted,
            balanceSummaries: balances.map((balance) => ({
              balanceTransactionId: balance.id,
              sourceDisputeId: sourceDisputeIdByBalance.get(balance.id) ?? routing.id,
              currency: balance.currency
            })),
            projectionSummaries: projections.map((projection) => ({
              sourceDisputeId:
                sourceDisputeIdByBalance.get(projection.balanceTransactionId) ?? routing.id,
              allocationItemCount:
                projection.status === 'complete' ? projection.items.length : 0
            })),
            exposureChanged
          };
        });
        return { kind: 'complete' as const, value };
      } catch (error) {
        const safeCode = durableIssueCode(error);
        if (!safeCode) throw error;
        return {
          kind: 'issue' as const,
          result: await recordLockedIssue(
            tx,
            failingDisputeId,
            input.correlationId,
            safeCode,
            'exception',
            signal
          )
        };
      }
    })();
    if (outcome.kind === 'issue') return outcome.result;

    const resolvedIssueIds: string[] = [];
    let changed = false;
    for (const affectedDisputeId of affectedDisputeIds) {
      const source = facts.disputes.find((value) => value.id === affectedDisputeId);
      if (!source) throw new PermanentFinancialError('source_linkage_mismatch');
      const sourceResolvedIssueIds: string[] = [];
      const provableIssueCodes =
        affectedDisputeId === routing.id ? ISSUE_CODES : CROSS_DISPUTE_PROJECTION_ISSUE_CODES;
      for (const safeCode of provableIssueCodes) {
        const resolved = await resolveFinancialIssueAfterRecompute(tx, {
          resourceType: 'dispute',
          resourceId: affectedDisputeId,
          safeCode,
          proof: {
            status: 'resolved',
            resourceType: 'dispute',
            resourceId: affectedDisputeId,
            safeCode
          },
          actor: ACTOR,
          correlationId: input.correlationId
        });
        if (resolved) {
          resolvedIssueIds.push(resolved.id);
          sourceResolvedIssueIds.push(resolved.id);
        }
      }
      const sourcePersisted = outcome.value.persisted.filter(
        (value) => value.sourceDisputeId === affectedDisputeId
      );
      const openIssueImpacts =
        affectedDisputeId === routing.id
          ? []
          : ((await rows(
              tx,
              sql`
                select distinct impact
                from financial_reconciliation_issues
                where resource_type = 'dispute'
                  and resource_id = ${affectedDisputeId}
                  and state = 'open'
              `
            )) as Array<{ impact: FinancialIssueImpact }>);
      const nextStatus =
        affectedDisputeId === routing.id
          ? 'fee_reconciled'
          : openIssueImpacts.some((value) => value.impact === 'exception')
            ? 'exception'
            : openIssueImpacts.some((value) => value.impact === 'pending')
              ? 'pending'
              : sourceResolvedIssueIds.length > 0 ||
                  source.financialEvidenceStatus === 'fee_reconciled'
                ? 'fee_reconciled'
                : source.financialEvidenceStatus;
      const sourceChanged =
        source.financialEvidenceStatus !== nextStatus ||
        sourcePersisted.some((value) => value.disposition === 'inserted') ||
        sourceResolvedIssueIds.length > 0;
      changed ||= sourceChanged;
      if (source.financialEvidenceStatus !== nextStatus) {
        await tx
          .update(disputes)
          .set({ financialEvidenceStatus: nextStatus })
          .where(eq(disputes.id, affectedDisputeId));
      }
      if (!sourceChanged || nextStatus !== 'fee_reconciled') continue;
      const sourceBalances = outcome.value.balanceSummaries.filter(
        (value) => value.sourceDisputeId === affectedDisputeId
      );
      await appendAuditEvent(tx, {
        actor: ACTOR,
        action: 'financial.dispute_reconciled',
        outcome: 'succeeded',
        resourceType: 'dispute',
        resourceId: affectedDisputeId,
        correlationId: input.correlationId,
        after: {
          disputeId: affectedDisputeId,
          orderId: routing.orderId,
          financialEvidenceStatus: 'fee_reconciled',
          transactionCount: sourceBalances.length,
          allocationSetCount: sourcePersisted.length,
          allocationItemCount: outcome.value.projectionSummaries
            .filter((value) => value.sourceDisputeId === affectedDisputeId)
            .reduce((sum, value) => sum + value.allocationItemCount, 0),
          settlementCurrencies: [...new Set(sourceBalances.map((value) => value.currency))].sort()
        }
      });
    }
    if (outcome.value.exposureChanged) {
      if (affectedRefundIds.length > 0) {
        await rearmCurrentProjectionSubjectsForFinancialSources(tx, {
          sourceKind: 'refund', sourceIds: affectedRefundIds
        });
      }
    }
    if (!changed) {
      throwIfFinancialSourceAborted(signal);
      return {
        status: 'unchanged',
        sourceKind: 'dispute',
        sourceId: routing.id,
        financialEvidenceStatus: 'fee_reconciled'
      };
    }
    throwIfFinancialSourceAborted(signal);
    return {
      status: 'reconciled',
      sourceKind: 'dispute',
      sourceId: routing.id,
      financialEvidenceStatus: 'fee_reconciled',
      allocationSetIds: outcome.value.persisted.map((value) => value.setId),
      issueIds: resolvedIssueIds
    };
  });
}
