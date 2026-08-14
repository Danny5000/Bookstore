import { PermanentFinancialError } from '../errors';
import type { FinancialAllocationPlan } from '../types';
import type {
  FailedRefundAllocationInput,
  FinancialAllocationPlanBundle,
  RefundAllocationComponent,
  RefundAllocationInput
} from './types';
import { replayFinancialExposure } from './exposure';
import {
  allocateComponents,
  allocateFeeDetails,
  assertAllocationPlanConserves,
  assertCurrency,
  assertSafeMoney,
  basePlan,
  planWeights
} from './common';

function mismatch(): never {
  throw new PermanentFinancialError('allocation_mismatch');
}

function linkageMismatch(): never {
  throw new PermanentFinancialError('source_linkage_mismatch');
}

function assertNonEmptyId(value: string): void {
  if (typeof value !== 'string' || value.length === 0) linkageMismatch();
}

function assertRefundBoundary(input: RefundAllocationInput): void {
  assertCurrency(input.settlementCurrency);
  assertCurrency(input.presentmentCurrency);
  assertSafeMoney(input.presentmentAmountMinor);
  assertSafeMoney(input.amountMinor);
  assertSafeMoney(input.feeMinor);
  assertSafeMoney(input.netMinor);
  if (input.presentmentAmountMinor <= 0 || input.amountMinor >= 0 || input.feeMinor < 0) mismatch();
  if (BigInt(input.amountMinor) - BigInt(input.feeMinor) !== BigInt(input.netMinor)) mismatch();
}

function componentRows(components: readonly RefundAllocationComponent[]) {
  return components.flatMap((component) => [
    ...(component.subtotalMinor === 0 ? [] : [{
      orderItemId: component.orderItemId,
      component: 'refund_subtotal' as const,
      weightMinor: component.subtotalMinor,
      tieBreakKey: `${component.orderItemId}:subtotal`
    }]),
    ...(component.taxMinor === 0 ? [] : [{
      orderItemId: component.orderItemId,
      component: 'refund_tax' as const,
      weightMinor: component.taxMinor,
      tieBreakKey: `${component.orderItemId}:tax`
    }])
  ]);
}

function assertFinalizedComponents(input: RefundAllocationInput, components: readonly RefundAllocationComponent[]): void {
  const ids = new Set<string>();
  let total = 0n;
  for (const component of components) {
    assertNonEmptyId(component.orderItemId);
    assertCurrency(component.presentmentCurrency);
    assertSafeMoney(component.subtotalMinor);
    assertSafeMoney(component.taxMinor);
    assertSafeMoney(component.remainingSubtotalCapacityMinor);
    assertSafeMoney(component.remainingTaxCapacityMinor);
    if (
      ids.has(component.orderItemId) ||
      component.presentmentCurrency !== input.presentmentCurrency ||
      component.subtotalMinor < 0 || component.taxMinor < 0 ||
      component.remainingSubtotalCapacityMinor < 0 || component.remainingTaxCapacityMinor < 0
    ) mismatch();
    ids.add(component.orderItemId);
    total += BigInt(component.subtotalMinor) + BigInt(component.taxMinor);
  }
  if (total !== BigInt(input.presentmentAmountMinor)) mismatch();
}

function computedCapacity(
  input: RefundAllocationInput,
  components: readonly RefundAllocationComponent[]
): ReadonlyMap<string, { subtotalMinor: number; taxMinor: number }> | null {
  const hasAnyChronology = input.providerRefundId !== undefined ||
    input.providerCreatedAt !== undefined ||
    input.paymentItemCapacities !== undefined || input.earlierFinalized !== undefined ||
    input.priorPresentmentEffects !== undefined;
  if (!hasAnyChronology) return null;
  if (!input.providerRefundId || !input.providerCreatedAt ||
    !input.paymentItemCapacities || !input.earlierFinalized ||
    !input.priorPresentmentEffects) {
    linkageMismatch();
  }
  assertNonEmptyId(input.providerRefundId);
  const replayed = replayFinancialExposure({
    presentmentCurrency: input.presentmentCurrency,
    current: {
      providerCreatedAt: input.providerCreatedAt,
      providerId: input.providerRefundId,
      sourceId: input.sourceId
    },
    paymentItems: input.paymentItemCapacities,
    finalizedRefunds: input.earlierFinalized,
    priorPresentmentEffects: input.priorPresentmentEffects
  });
  for (const component of components) {
    const remaining = replayed.capacity.get(component.orderItemId);
    if (!remaining || component.subtotalMinor > remaining.subtotalMinor || component.taxMinor > remaining.taxMinor) mismatch();
  }
  return replayed.capacity;
}

function validateFeeEffects(input: RefundAllocationInput, weights: RefundAllocationInput['paymentItems']): void {
  // This intentionally invokes the shared signed-detail validator even when attribution is unresolved.
  allocateFeeDetails(input.feeMinor, input.settlementCurrency, weights, input.feeDetails);
}

export function buildRefundAllocationPlan(input: RefundAllocationInput): FinancialAllocationPlanBundle {
  assertRefundBoundary(input);
  if (input.attribution.kind === 'unresolved') {
    validateFeeEffects(input, input.feeMinor === 0 ? input.paymentItems : [{
      orderItemId: 'unresolved-fee-validation', subtotalMinor: 1, currency: input.settlementCurrency
    }]);
    return { plans: [
      basePlan(input, { basis: 'gross_amount', scope: 'unresolved', expectedEffectMinor: input.amountMinor, items: [] }),
      basePlan(input, { basis: 'fee', scope: 'unresolved', expectedEffectMinor: input.feeMinor === 0 ? 0 : -input.feeMinor, items: [] })
    ] };
  }

  const components = input.attribution.components;
  assertFinalizedComponents(input, components);
  const historyCapacity = computedCapacity(input, components);
  if (!historyCapacity) {
    for (const component of components) {
      if (
        component.subtotalMinor > component.remainingSubtotalCapacityMinor ||
        component.taxMinor > component.remainingTaxCapacityMinor
      ) mismatch();
    }
  }
  if (input.presentmentCurrency === input.settlementCurrency && -input.amountMinor !== input.presentmentAmountMinor) mismatch();

  const grossItems = allocateComponents(input.amountMinor, input.settlementCurrency, componentRows(components));
  const currentSubtotalWeights = components.map((component) => ({
    orderItemId: component.orderItemId,
    subtotalMinor: component.subtotalMinor,
    currency: input.settlementCurrency
  }));
  const feeWeights = currentSubtotalWeights.some((weight) => weight.subtotalMinor > 0)
    ? currentSubtotalWeights
    : currentSubtotalWeights.length === 1
      ? [{ ...currentSubtotalWeights[0]!, subtotalMinor: 1 }]
      : currentSubtotalWeights;
  const feeItems = allocateFeeDetails(
    input.feeMinor,
    input.settlementCurrency,
    feeWeights,
    input.feeDetails
  );
  return { plans: [
    basePlan(input, { basis: 'gross_amount', scope: 'title', expectedEffectMinor: input.amountMinor, items: grossItems }),
    basePlan(input, { basis: 'fee', scope: 'title', expectedEffectMinor: input.feeMinor === 0 ? 0 : -input.feeMinor, items: feeItems })
  ] };
}

function assertFailedRefundBoundary(input: FailedRefundAllocationInput): void {
  assertCurrency(input.settlementCurrency);
  assertSafeMoney(input.amountMinor);
  assertSafeMoney(input.feeMinor);
  assertSafeMoney(input.netMinor);
  if (input.amountMinor <= 0 || input.feeMinor < 0 || BigInt(input.amountMinor) - BigInt(input.feeMinor) !== BigInt(input.netMinor)) mismatch();
}

function assertOriginalPlan(plan: FinancialAllocationPlan, setId: string, input: FailedRefundAllocationInput): void {
  assertNonEmptyId(setId);
  if (plan.supersedesSetId !== null) {
    assertNonEmptyId(plan.supersedesSetId);
    if (plan.supersedesSetId === setId) linkageMismatch();
  }
  assertAllocationPlanConserves(plan);
  if (plan.currency !== input.settlementCurrency) {
    throw new PermanentFinancialError('currency_mismatch');
  }
  if (
    plan.basis !== 'gross_amount' ||
    plan.reversalOfSetId !== null ||
    plan.balanceTransactionId === input.balanceTransactionId
  ) linkageMismatch();
}

function assertOriginalFeeEvidence(input: FailedRefundAllocationInput): void {
  const setId = input.originalFeeSetId;
  const plan = input.originalFeePlan;
  if ((setId === null) !== (plan === null)) linkageMismatch();
  if (setId === null || plan === null) return;

  assertNonEmptyId(setId);
  if (plan.supersedesSetId !== null) {
    assertNonEmptyId(plan.supersedesSetId);
    if (plan.supersedesSetId === setId) linkageMismatch();
  }
  assertAllocationPlanConserves(plan);
  if (plan.currency !== input.settlementCurrency) {
    throw new PermanentFinancialError('currency_mismatch');
  }
  if (
    plan.basis !== 'fee' ||
    plan.scope !== 'title' ||
    plan.reversalOfSetId !== null ||
    plan.balanceTransactionId !== input.originalGrossPlan.balanceTransactionId ||
    plan.sourceFingerprint !== input.originalGrossPlan.sourceFingerprint ||
    plan.algorithmVersion !== input.originalGrossPlan.algorithmVersion
  ) linkageMismatch();
}

export function buildFailedRefundAllocationPlan(input: FailedRefundAllocationInput): FinancialAllocationPlanBundle {
  assertFailedRefundBoundary(input);
  const original = input.originalGrossPlan;
  assertOriginalPlan(original, input.originalGrossSetId, input);
  assertOriginalFeeEvidence(input);
  if (original.scope === 'unresolved') mismatch();

  let grossScope: 'title' | 'account';
  let grossItems: ReturnType<typeof allocateComponents> = [];
  if (original.scope === 'account') {
    if (original.items.length !== 0 || BigInt(original.expectedEffectMinor) + BigInt(input.amountMinor) !== 0n) mismatch();
    grossScope = 'account';
  } else if (original.scope === 'title') {
    if (original.items.length === 0 || original.expectedEffectMinor >= 0 || input.amountMinor > -original.expectedEffectMinor) mismatch();
    grossScope = 'title';
    grossItems = allocateComponents(
      input.amountMinor,
      input.settlementCurrency,
      planWeights(original).map((weight) => ({ ...weight, tieBreakKey: weight.tieKey }))
    );
  } else {
    mismatch();
  }

  const feeItems = allocateFeeDetails(input.feeMinor, input.settlementCurrency, input.paymentItems, input.feeDetails);
  return { plans: [
    basePlan(input, {
      basis: 'gross_amount', scope: grossScope, expectedEffectMinor: input.amountMinor,
      items: grossItems, reversalOfSetId: input.originalGrossSetId
    }),
    basePlan(input, {
      basis: 'fee', scope: 'title', expectedEffectMinor: input.feeMinor === 0 ? 0 : -input.feeMinor,
      items: feeItems
    })
  ] };
}
