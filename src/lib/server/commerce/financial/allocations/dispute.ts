import { PermanentFinancialError } from '../errors';
import type { FinancialAllocationItem, FinancialAllocationPlan } from '../types';
import {
  allocateComponents,
  allocateFeeDetails,
  assertAllocationPlanConserves,
  assertCurrency,
  assertSafeMoney,
  basePlan,
  planWeights
} from './common';
import type {
  BoundDisputePresentmentEffect,
  DisputeAllocationInput,
  DisputeAllocationPlanBundle,
  DisputePaymentItem,
  FinalizedDisputeRefund,
  UnboundDisputePresentmentEffect
} from './types';

type Capacity = { subtotalMinor: number; taxMinor: number };
type ComponentWeight = { orderItemId: string; component: 'dispute_subtotal' | 'dispute_tax'; weightMinor: number; tieBreakKey: string };
type ChronologyKey = {
  readonly providerCreatedAtMs: number;
  readonly providerTransactionId: string;
  readonly allocationId: string;
};

function mismatch(): never {
  throw new PermanentFinancialError('allocation_mismatch');
}

function linkageMismatch(): never {
  throw new PermanentFinancialError('source_linkage_mismatch');
}

function assertId(value: string): void {
  if (typeof value !== 'string' || value.length === 0) linkageMismatch();
}

function parseChronologyInstant(value: string): number {
  if (typeof value !== 'string') linkageMismatch();
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) linkageMismatch();
  return instant;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

function compareChronology(left: ChronologyKey, right: ChronologyKey): number {
  if (left.providerCreatedAtMs !== right.providerCreatedAtMs) {
    return left.providerCreatedAtMs < right.providerCreatedAtMs ? -1 : 1;
  }
  const transactionOrder = compareCodePoints(left.providerTransactionId, right.providerTransactionId);
  return transactionOrder === 0
    ? compareCodePoints(left.allocationId, right.allocationId)
    : transactionOrder;
}

function assertBoundary(input: DisputeAllocationInput): number {
  assertCurrency(input.settlementCurrency);
  assertCurrency(input.presentmentCurrency);
  assertSafeMoney(input.amountMinor);
  assertSafeMoney(input.feeMinor);
  assertSafeMoney(input.netMinor);
  assertSafeMoney(input.presentmentAmountMinor);
  assertId(input.disputeId);
  assertId(input.providerTransactionId);
  const providerCreatedAtMs = parseChronologyInstant(input.providerCreatedAt);
  if (
    input.sourceKind !== 'dispute' ||
    !['withdrawal', 'reinstatement', 'fee_credit'].includes(input.effect) ||
    input.presentmentAmountMinor <= 0 || input.feeMinor < 0 ||
    BigInt(input.amountMinor) - BigInt(input.feeMinor) !== BigInt(input.netMinor)
  ) mismatch();
  if (
    (input.effect === 'withdrawal' && input.amountMinor >= 0) ||
    (input.effect !== 'withdrawal' && input.amountMinor <= 0)
  ) mismatch();
  if (input.presentmentCurrency === input.settlementCurrency && Math.abs(input.amountMinor) !== input.presentmentAmountMinor) {
    mismatch();
  }
  return providerCreatedAtMs;
}

function capacityFromPayment(input: DisputeAllocationInput): Map<string, Capacity> {
  const capacity = new Map<string, Capacity>();
  for (const item of input.paymentItems) assertPaymentItem(item, input.presentmentCurrency, capacity);
  if (capacity.size === 0) mismatch();
  return capacity;
}

function assertPaymentItem(item: DisputePaymentItem, currency: string, capacity: Map<string, Capacity>): void {
  assertId(item.orderItemId);
  assertCurrency(item.presentmentCurrency);
  assertSafeMoney(item.subtotalMinor);
  assertSafeMoney(item.taxMinor);
  if (
    item.presentmentCurrency !== currency || item.subtotalMinor < 0 || item.taxMinor < 0 ||
    capacity.has(item.orderItemId)
  ) mismatch();
  capacity.set(item.orderItemId, { subtotalMinor: item.subtotalMinor, taxMinor: item.taxMinor });
}

function applyRefunds(
  input: DisputeAllocationInput,
  capacity: Map<string, Capacity>,
  currentProviderCreatedAtMs: number
): void {
  const seen = new Set<string>();
  const current = {
    providerCreatedAtMs: currentProviderCreatedAtMs,
    providerTransactionId: input.providerTransactionId,
    allocationId: ''
  };
  const refunds = input.finalizedRefunds.map((refund) => ({
    refund,
    chronology: {
      providerCreatedAtMs: assertRefund(refund, input.presentmentCurrency),
      providerTransactionId: refund.refundId,
      allocationId: ''
    }
  })).sort((left, right) => compareChronology(left.chronology, right.chronology));
  for (const { refund, chronology } of refunds) {
    const key = `${refund.refundId}\u0000${chronology.providerCreatedAtMs}\u0000${refund.orderItemId}`;
    if (seen.has(key) || compareChronology(chronology, current) >= 0) mismatch();
    seen.add(key);
    const remaining = capacity.get(refund.orderItemId);
    if (!remaining || refund.subtotalMinor > remaining.subtotalMinor || refund.taxMinor > remaining.taxMinor) mismatch();
    remaining.subtotalMinor -= refund.subtotalMinor;
    remaining.taxMinor -= refund.taxMinor;
  }
}

function assertRefund(refund: FinalizedDisputeRefund, currency: string): number {
  assertId(refund.refundId);
  assertId(refund.orderItemId);
  const providerCreatedAtMs = parseChronologyInstant(refund.providerCreatedAt);
  assertCurrency(refund.presentmentCurrency);
  assertSafeMoney(refund.subtotalMinor);
  assertSafeMoney(refund.taxMinor);
  if (refund.presentmentCurrency !== currency || refund.subtotalMinor < 0 || refund.taxMinor < 0) mismatch();
  return providerCreatedAtMs;
}

function validatePresentmentEffect(effect: BoundDisputePresentmentEffect, currency: string): number {
  assertId(effect.allocationId);
  assertId(effect.withdrawalSetId);
  assertId(effect.disputeId);
  assertId(effect.providerTransactionId);
  assertId(effect.orderItemId);
  const providerCreatedAtMs = parseChronologyInstant(effect.providerCreatedAt);
  assertCurrency(effect.presentmentCurrency);
  assertSafeMoney(effect.subtotalMinor);
  assertSafeMoney(effect.taxMinor);
  if (
    effect.presentmentCurrency !== currency ||
    !['withdrawal', 'reinstatement'].includes(effect.effect) ||
    (effect.effect === 'withdrawal' && (effect.subtotalMinor > 0 || effect.taxMinor > 0 || effect.reversalOfAllocationId !== null)) ||
    (effect.effect === 'reinstatement' && (effect.subtotalMinor < 0 || effect.taxMinor < 0 || !effect.reversalOfAllocationId)) ||
    effect.subtotalMinor + effect.taxMinor === 0
  ) mismatch();
  return providerCreatedAtMs;
}

function replayPriorEffects(
  input: DisputeAllocationInput,
  capacity: Map<string, Capacity>,
  currentProviderCreatedAtMs: number
): {
  readonly withdrawals: Map<string, BoundDisputePresentmentEffect>;
  readonly reversedWithdrawalIds: ReadonlySet<string>;
} {
  const effects = input.priorPresentmentEffects.map((effect) => ({
    effect,
    chronology: {
      providerCreatedAtMs: validatePresentmentEffect(effect, input.presentmentCurrency),
      providerTransactionId: effect.providerTransactionId,
      allocationId: effect.allocationId
    }
  })).sort((left, right) => compareChronology(left.chronology, right.chronology));
  const seenIds = new Set<string>();
  const reversed = new Set<string>();
  const withdrawals = new Map<string, BoundDisputePresentmentEffect>();
  const current = {
    providerCreatedAtMs: currentProviderCreatedAtMs,
    providerTransactionId: input.providerTransactionId,
    allocationId: ''
  };
  const transactionKinds = new Map<string, string>();
  for (const { effect, chronology } of effects) {
    if (seenIds.has(effect.allocationId) || compareChronology(chronology, current) >= 0) linkageMismatch();
    seenIds.add(effect.allocationId);
    const transactionKey = `${effect.disputeId}\u0000${chronology.providerCreatedAtMs}\u0000${effect.providerTransactionId}`;
    const kind = transactionKinds.get(transactionKey);
    if (kind && kind !== effect.effect) linkageMismatch();
    transactionKinds.set(transactionKey, effect.effect);
    const remaining = capacity.get(effect.orderItemId);
    if (!remaining) linkageMismatch();
    if (effect.effect === 'withdrawal') {
      if (effect.subtotalMinor < -remaining.subtotalMinor || effect.taxMinor < -remaining.taxMinor) mismatch();
      remaining.subtotalMinor += effect.subtotalMinor;
      remaining.taxMinor += effect.taxMinor;
      withdrawals.set(effect.allocationId, effect);
      continue;
    }
    const original = withdrawals.get(effect.reversalOfAllocationId!);
    if (
      !original || reversed.has(original.allocationId) ||
      original.disputeId !== effect.disputeId || original.withdrawalSetId !== effect.withdrawalSetId ||
      effect.subtotalMinor > -original.subtotalMinor || effect.taxMinor > -original.taxMinor
    ) linkageMismatch();
    reversed.add(original.allocationId);
    remaining.subtotalMinor += effect.subtotalMinor;
    remaining.taxMinor += effect.taxMinor;
  }
  return { withdrawals, reversedWithdrawalIds: reversed };
}

function remainingWeights(capacity: Map<string, Capacity>): ComponentWeight[] {
  return [...capacity.entries()].flatMap(([orderItemId, item]) => [
    ...(item.subtotalMinor === 0 ? [] : [{ orderItemId, component: 'dispute_subtotal' as const, weightMinor: item.subtotalMinor, tieBreakKey: `${orderItemId}:subtotal` }]),
    ...(item.taxMinor === 0 ? [] : [{ orderItemId, component: 'dispute_tax' as const, weightMinor: item.taxMinor, tieBreakKey: `${orderItemId}:tax` }])
  ]);
}

function withdrawalEffects(
  input: DisputeAllocationInput,
  presentmentItems: readonly FinancialAllocationItem[]
): readonly UnboundDisputePresentmentEffect[] {
  const rows = new Map<string, { subtotalMinor: number; taxMinor: number }>();
  for (const item of presentmentItems) {
    const row = rows.get(item.orderItemId) ?? { subtotalMinor: 0, taxMinor: 0 };
    if (item.component === 'dispute_subtotal') row.subtotalMinor += item.effectMinor;
    else row.taxMinor += item.effectMinor;
    rows.set(item.orderItemId, row);
  }
  return [...rows.entries()].map(([orderItemId, row]) => ({
    allocationId: `${input.allocationIdentityPrefix}:presentment:${orderItemId}`,
    withdrawalSetId: null, disputeId: input.disputeId,
    providerCreatedAt: input.providerCreatedAt, providerTransactionId: input.providerTransactionId,
    orderItemId, ...row, presentmentCurrency: input.presentmentCurrency,
    effect: 'withdrawal', reversalOfAllocationId: null
  }));
}

function assertWithdrawalShape(input: DisputeAllocationInput): void {
  if (
    input.withdrawalSetId !== null || input.reversesSetId !== null || input.reversesFeeSetId !== null ||
    input.withdrawalGrossPlan !== null || input.withdrawalFeePlan !== null
  ) linkageMismatch();
}

function assertReinstatementShape(
  input: DisputeAllocationInput,
  withdrawals: Map<string, BoundDisputePresentmentEffect>,
  reversedWithdrawalIds: ReadonlySet<string>
): readonly BoundDisputePresentmentEffect[] {
  if (
    input.withdrawalSetId !== null || !input.reversesSetId || input.reversesFeeSetId !== null ||
    input.withdrawalFeePlan !== null || !input.withdrawalGrossPlan
  ) linkageMismatch();
  assertWithdrawalPlan(input.withdrawalGrossPlan, input);
  const exact = [...withdrawals.values()].filter((effect) =>
    effect.disputeId === input.disputeId && effect.withdrawalSetId === input.reversesSetId
  );
  if (exact.length === 0) linkageMismatch();
  if (exact.some((effect) => reversedWithdrawalIds.has(effect.allocationId))) linkageMismatch();
  const expected = exact.reduce((sum, effect) => sum + effect.subtotalMinor + effect.taxMinor, 0);
  if (input.presentmentCurrency === input.settlementCurrency &&
    expected !== input.withdrawalGrossPlan.expectedEffectMinor) linkageMismatch();
  if (input.presentmentCurrency !== input.settlementCurrency &&
    (input.amountMinor !== -input.withdrawalGrossPlan.expectedEffectMinor ||
      input.presentmentAmountMinor !== -expected)) mismatch();
  if (input.presentmentAmountMinor > -expected) mismatch();
  return exact;
}

function assertWithdrawalPlan(plan: FinancialAllocationPlan, input: DisputeAllocationInput): void {
  assertAllocationPlanConserves(plan);
  if (plan.currency !== input.settlementCurrency) throw new PermanentFinancialError('currency_mismatch');
  if (plan.supersedesSetId !== null &&
    (typeof plan.supersedesSetId !== 'string' || plan.supersedesSetId.length === 0)) linkageMismatch();
  if (
    plan.basis !== 'gross_amount' || plan.scope !== 'title' || plan.expectedEffectMinor >= 0 ||
    plan.reversalOfSetId !== null || plan.balanceTransactionId === input.balanceTransactionId
  ) linkageMismatch();
}

function reinstatementEffects(
  input: DisputeAllocationInput,
  original: readonly BoundDisputePresentmentEffect[]
): readonly BoundDisputePresentmentEffect[] {
  const weights = original.map((effect) => ({
    orderItemId: effect.allocationId,
    component: 'dispute_reinstatement' as const,
    weightMinor: -effect.subtotalMinor - effect.taxMinor,
    tieBreakKey: effect.allocationId
  }));
  const allocations = allocateComponents(input.presentmentAmountMinor, input.presentmentCurrency, weights);
  return allocations.filter((allocation) => allocation.effectMinor !== 0).map((allocation) => {
    const withdrawal = original.find((effect) => effect.allocationId === allocation.orderItemId);
    if (!withdrawal) linkageMismatch();
    const split = allocateComponents(allocation.effectMinor, input.presentmentCurrency, [
      ...(withdrawal.subtotalMinor === 0 ? [] : [{ orderItemId: withdrawal.orderItemId, component: 'dispute_subtotal' as const, weightMinor: -withdrawal.subtotalMinor, tieBreakKey: 'subtotal' }]),
      ...(withdrawal.taxMinor === 0 ? [] : [{ orderItemId: withdrawal.orderItemId, component: 'dispute_tax' as const, weightMinor: -withdrawal.taxMinor, tieBreakKey: 'tax' }])
    ]);
    return {
      allocationId: `${input.allocationIdentityPrefix}:presentment:${withdrawal.allocationId}`,
      withdrawalSetId: withdrawal.withdrawalSetId, disputeId: input.disputeId,
      providerCreatedAt: input.providerCreatedAt, providerTransactionId: input.providerTransactionId,
      orderItemId: withdrawal.orderItemId,
      subtotalMinor: split.find((item) => item.component === 'dispute_subtotal')?.effectMinor ?? 0,
      taxMinor: split.find((item) => item.component === 'dispute_tax')?.effectMinor ?? 0,
      presentmentCurrency: input.presentmentCurrency, effect: 'reinstatement', reversalOfAllocationId: withdrawal.allocationId
    };
  });
}

function feeCreditItems(input: DisputeAllocationInput): readonly FinancialAllocationItem[] {
  if (
    input.withdrawalSetId !== null || input.reversesSetId !== null || !input.reversesFeeSetId || !input.withdrawalFeePlan ||
    input.feeMinor !== 0 || input.feeDetails.length !== 0
  ) linkageMismatch();
  const plan = input.withdrawalFeePlan;
  assertAllocationPlanConserves(plan);
  if (plan.currency !== input.settlementCurrency) throw new PermanentFinancialError('currency_mismatch');
  if (plan.supersedesSetId !== null &&
    (typeof plan.supersedesSetId !== 'string' || plan.supersedesSetId.length === 0)) linkageMismatch();
  if (
    plan.basis !== 'fee' || plan.scope !== 'title' || plan.expectedEffectMinor >= 0 ||
    plan.reversalOfSetId !== null || plan.balanceTransactionId === input.balanceTransactionId ||
    input.amountMinor > -plan.expectedEffectMinor
  ) linkageMismatch();
  return allocateComponents(
    input.amountMinor,
    input.settlementCurrency,
    planWeights(plan).map((weight) => ({ ...weight, component: 'fee_credit' as const, tieBreakKey: weight.tieKey }))
  ).map((item) => ({ ...item, component: 'fee_credit' as const }));
}

export function buildDisputeAllocationPlan(input: DisputeAllocationInput): DisputeAllocationPlanBundle {
  const currentProviderCreatedAtMs = assertBoundary(input);
  if (input.effect === 'fee_credit') {
    const grossItems = feeCreditItems(input);
    return { plans: [
      basePlan(input, { basis: 'gross_amount', scope: 'title', expectedEffectMinor: input.amountMinor, items: grossItems, reversalOfSetId: null }),
      basePlan(input, { basis: 'fee', scope: 'title', expectedEffectMinor: 0, items: [] })
    ], presentmentEffects: [] };
  }

  const capacity = capacityFromPayment(input);
  applyRefunds(input, capacity, currentProviderCreatedAtMs);
  const replayed = replayPriorEffects(input, capacity, currentProviderCreatedAtMs);

  if (input.effect === 'withdrawal') {
    assertWithdrawalShape(input);
    const weights = remainingWeights(capacity);
    const available = weights.reduce((sum, weight) => sum + weight.weightMinor, 0);
    if (available === 0 || input.presentmentAmountMinor > available) mismatch();
    const presentmentItems = allocateComponents(-input.presentmentAmountMinor, input.presentmentCurrency, weights);
    const grossItems = allocateComponents(
      input.amountMinor,
      input.settlementCurrency,
      presentmentItems.map((item) => ({ ...item, weightMinor: -item.effectMinor, tieBreakKey: item.tieBreakKey }))
    );
    const presentmentEffects = withdrawalEffects(input, presentmentItems);
    const affectedFeeWeights = presentmentEffects.map((effect) => ({
      orderItemId: effect.orderItemId,
      subtotalMinor: -effect.subtotalMinor,
      currency: input.settlementCurrency
    }));
    const feeWeights = affectedFeeWeights.some((weight) => weight.subtotalMinor > 0) || affectedFeeWeights.length === 1
      ? affectedFeeWeights
      : input.paymentItems.map((item) => ({
          orderItemId: item.orderItemId,
          subtotalMinor: item.subtotalMinor,
          currency: input.settlementCurrency
        }));
    const feeItems = allocateFeeDetails(
      input.feeMinor,
      input.settlementCurrency,
      feeWeights,
      input.feeDetails
    );
    return { plans: [
      basePlan(input, { basis: 'gross_amount', scope: 'title', expectedEffectMinor: input.amountMinor, items: grossItems }),
      basePlan(input, { basis: 'fee', scope: 'title', expectedEffectMinor: input.feeMinor === 0 ? 0 : -input.feeMinor, items: feeItems })
    ], presentmentEffects };
  }

  const original = assertReinstatementShape(input, replayed.withdrawals, replayed.reversedWithdrawalIds);
  const presentmentEffects = reinstatementEffects(input, original);
  const grossItems = allocateComponents(
    input.amountMinor,
    input.settlementCurrency,
    presentmentEffects.map((effect) => ({
      orderItemId: effect.orderItemId, component: 'dispute_reinstatement' as const,
      weightMinor: effect.subtotalMinor + effect.taxMinor, tieBreakKey: effect.reversalOfAllocationId!
    }))
  ).map((item) => ({ ...item, component: 'dispute_reinstatement' as const }));
  return { plans: [
    basePlan(input, { basis: 'gross_amount', scope: 'title', expectedEffectMinor: input.amountMinor, items: grossItems, reversalOfSetId: input.reversesSetId }),
    basePlan(input, { basis: 'fee', scope: 'title', expectedEffectMinor: 0, items: [] })
  ], presentmentEffects };
}
