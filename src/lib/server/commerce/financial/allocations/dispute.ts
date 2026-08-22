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
import { replayFinancialExposure } from './exposure';
import type {
  BoundDisputePresentmentEffect,
  DisputeAllocationInput,
  DisputeAllocationPlanBundle,
  UnboundDisputePresentmentEffect
} from './types';

type ComponentWeight = { orderItemId: string; component: 'dispute_subtotal' | 'dispute_tax'; weightMinor: number; tieBreakKey: string };
const DISPUTE_FEE_COMPONENTS = new Set<FinancialAllocationItem['component']>([
  'dispute_fee', 'provider_fee_tax', 'fee_credit', 'other'
]);

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

function assertBoundary(input: DisputeAllocationInput): number {
  assertCurrency(input.settlementCurrency);
  assertCurrency(input.presentmentCurrency);
  assertSafeMoney(input.amountMinor);
  assertSafeMoney(input.feeMinor);
  assertSafeMoney(input.netMinor);
  assertSafeMoney(input.presentmentAmountMinor);
  assertId(input.disputeId);
  assertId(input.providerTransactionId);
  if (input.algorithmVersion !== 1 && input.algorithmVersion !== 2) linkageMismatch();
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

function remainingWeights(
  capacity: ReadonlyMap<string, { subtotalMinor: number; taxMinor: number }>
): ComponentWeight[] {
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
  return [...rows.entries()]
    .filter(([, row]) => row.subtotalMinor + row.taxMinor !== 0)
    .map(([orderItemId, row]) => ({
      allocationId: `${input.allocationIdentityPrefix}:presentment:${orderItemId}`,
      withdrawalSetId: null, disputeId: input.disputeId,
      providerCreatedAt: input.providerCreatedAt,
      providerTransactionId: input.providerTransactionId,
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
  withdrawals: ReadonlyMap<string, BoundDisputePresentmentEffect>,
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
  if (input.algorithmVersion === 2) {
    const expectedComponents = new Map<string, number>();
    for (const effect of exact) {
      for (const [component, effectMinor] of [
        ['dispute_subtotal', effect.subtotalMinor],
        ['dispute_tax', effect.taxMinor]
      ] as const) {
        if (effectMinor === 0) continue;
        const key = `${effect.orderItemId}\u0000${component}`;
        if (expectedComponents.has(key)) linkageMismatch();
        expectedComponents.set(key, effectMinor);
      }
    }
    const actualComponents = new Map(input.withdrawalGrossPlan.items.map((item) => [
      `${item.orderItemId}\u0000${item.component}`,
      item.effectMinor
    ]));
    if (
      actualComponents.size !== expectedComponents.size ||
      [...expectedComponents].some(([key, effectMinor]) =>
        !actualComponents.has(key) ||
        (input.presentmentCurrency === input.settlementCurrency &&
          actualComponents.get(key) !== effectMinor)
      )
    ) linkageMismatch();
  }
  return exact;
}

function assertWithdrawalPlan(plan: FinancialAllocationPlan, input: DisputeAllocationInput): void {
  assertAllocationPlanConserves(plan);
  if (plan.currency !== input.settlementCurrency) throw new PermanentFinancialError('currency_mismatch');
  if (plan.supersedesSetId !== null &&
    (typeof plan.supersedesSetId !== 'string' || plan.supersedesSetId.length === 0)) linkageMismatch();
  if (
    plan.basis !== 'gross_amount' || plan.scope !== 'title' || plan.expectedEffectMinor >= 0 ||
    plan.algorithmVersion !== input.algorithmVersion ||
    plan.reversalOfSetId !== null || plan.balanceTransactionId === input.balanceTransactionId
  ) linkageMismatch();
  if (plan.items.some((item) =>
    item.effectMinor > 0 ||
    (item.component !== 'dispute_subtotal' && item.component !== 'dispute_tax') ||
    item.tieBreakKey !== `${item.orderItemId}:${
      item.component === 'dispute_subtotal' ? 'subtotal' : 'tax'
    }`
  )) linkageMismatch();
}

function reinstatementEffects(
  input: DisputeAllocationInput,
  original: readonly BoundDisputePresentmentEffect[]
): readonly BoundDisputePresentmentEffect[] {
  if (input.algorithmVersion === 2 && input.presentmentCurrency === input.settlementCurrency) {
    if (!input.withdrawalGrossPlan) linkageMismatch();
    const withdrawalByOrderItem = new Map<string, BoundDisputePresentmentEffect>();
    for (const withdrawal of original) {
      if (withdrawalByOrderItem.has(withdrawal.orderItemId)) linkageMismatch();
      withdrawalByOrderItem.set(withdrawal.orderItemId, withdrawal);
    }
    const allocations = allocateComponents(
      input.presentmentAmountMinor,
      input.presentmentCurrency,
      planWeights(input.withdrawalGrossPlan).map((weight) => {
        if (weight.component !== 'dispute_subtotal' && weight.component !== 'dispute_tax') {
          linkageMismatch();
        }
        return {
          orderItemId: weight.orderItemId,
          component: weight.component,
          weightMinor: weight.weightMinor,
          tieBreakKey: weight.tieKey
        };
      })
    );
    const effectsByOrderItem = new Map<string, { subtotalMinor: number; taxMinor: number }>();
    for (const allocation of allocations) {
      const row = effectsByOrderItem.get(allocation.orderItemId) ?? {
        subtotalMinor: 0,
        taxMinor: 0
      };
      if (allocation.component === 'dispute_subtotal') {
        row.subtotalMinor = allocation.effectMinor;
      } else {
        row.taxMinor = allocation.effectMinor;
      }
      effectsByOrderItem.set(allocation.orderItemId, row);
    }
    return original.flatMap((withdrawal) => {
      const row = effectsByOrderItem.get(withdrawal.orderItemId);
      if (!row || row.subtotalMinor + row.taxMinor === 0) return [];
      return [{
        allocationId: `${input.allocationIdentityPrefix}:presentment:${withdrawal.allocationId}`,
        withdrawalSetId: withdrawal.withdrawalSetId,
        disputeId: input.disputeId,
        providerCreatedAt: input.providerCreatedAt,
        providerTransactionId: input.providerTransactionId,
        orderItemId: withdrawal.orderItemId,
        ...row,
        presentmentCurrency: input.presentmentCurrency,
        effect: 'reinstatement' as const,
        reversalOfAllocationId: withdrawal.allocationId
      }];
    });
  }

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
    plan.algorithmVersion !== input.algorithmVersion ||
    plan.reversalOfSetId !== null || plan.balanceTransactionId === input.balanceTransactionId ||
    input.amountMinor > -plan.expectedEffectMinor
  ) linkageMismatch();
  if (plan.items.some((item) =>
    item.effectMinor > 0 || !DISPUTE_FEE_COMPONENTS.has(item.component) ||
    item.tieBreakKey !== `${item.orderItemId}:${item.component}`
  )) linkageMismatch();
  return allocateComponents(
    input.amountMinor,
    input.settlementCurrency,
    planWeights(plan).map((weight) => ({ ...weight, component: 'fee_credit' as const, tieBreakKey: weight.tieKey }))
  ).map((item) => ({ ...item, component: 'fee_credit' as const }));
}

function reinstatementSettlementItems(
  input: DisputeAllocationInput,
  presentmentEffects: readonly BoundDisputePresentmentEffect[]
): readonly FinancialAllocationItem[] {
  if (input.algorithmVersion === 1) {
    return allocateComponents(
      input.amountMinor,
      input.settlementCurrency,
      presentmentEffects.map((effect) => ({
        orderItemId: effect.orderItemId,
        component: 'dispute_reinstatement' as const,
        weightMinor: effect.subtotalMinor + effect.taxMinor,
        tieBreakKey: effect.reversalOfAllocationId!
      }))
    ).map((item) => ({ ...item, component: 'dispute_reinstatement' as const }));
  }

  if (input.algorithmVersion !== 2) linkageMismatch();
  if (!input.withdrawalGrossPlan) linkageMismatch();
  const weights = planWeights(input.withdrawalGrossPlan).map((weight) => {
    if (weight.component !== 'dispute_subtotal' && weight.component !== 'dispute_tax') {
      linkageMismatch();
    }
    return {
      orderItemId: weight.orderItemId,
      component: weight.component === 'dispute_subtotal'
        ? 'dispute_reinstatement' as const
        : 'dispute_tax' as const,
      weightMinor: weight.weightMinor,
      tieBreakKey: weight.tieKey
    };
  });
  return allocateComponents(input.amountMinor, input.settlementCurrency, weights);
}

export function buildDisputeAllocationPlan(input: DisputeAllocationInput): DisputeAllocationPlanBundle {
  assertBoundary(input);
  if (input.effect === 'fee_credit') {
    const grossItems = feeCreditItems(input);
    return { plans: [
      basePlan(input, { basis: 'gross_amount', scope: 'title', expectedEffectMinor: input.amountMinor, items: grossItems, reversalOfSetId: null }),
      basePlan(input, { basis: 'fee', scope: 'title', expectedEffectMinor: 0, items: [] })
    ], presentmentEffects: [] };
  }

  const replayed = replayFinancialExposure({
    presentmentCurrency: input.presentmentCurrency,
    current: {
      providerCreatedAt: input.providerCreatedAt,
      providerId: input.providerTransactionId,
      sourceId: input.disputeId
    },
    paymentItems: input.paymentItems,
    finalizedRefunds: input.finalizedRefunds,
    priorPresentmentEffects: input.priorPresentmentEffects
  });
  const capacity = replayed.capacity;

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
    const feeWeights = affectedFeeWeights.some((weight) => weight.subtotalMinor > 0)
      ? affectedFeeWeights
      : affectedFeeWeights.length === 1
        ? [{ ...affectedFeeWeights[0]!, subtotalMinor: 1 }]
        : affectedFeeWeights;
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
  const grossItems = reinstatementSettlementItems(input, presentmentEffects);
  return { plans: [
    basePlan(input, { basis: 'gross_amount', scope: 'title', expectedEffectMinor: input.amountMinor, items: grossItems, reversalOfSetId: input.reversesSetId }),
    basePlan(input, { basis: 'fee', scope: 'title', expectedEffectMinor: 0, items: [] })
  ], presentmentEffects };
}
