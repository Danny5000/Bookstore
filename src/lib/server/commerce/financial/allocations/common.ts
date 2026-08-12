import type {
  FinancialAllocationItem,
  FinancialAllocationPlan,
  FinancialComponent
} from '../types';
import { PermanentFinancialError } from '../errors';
import { allocateSignedLargestRemainder } from './largest-remainder';
import type {
  ClassifiedFeeDetail,
  FinancialAllocationMetadata,
  RefundFeeWeight
} from './types';

function allocationMismatch(): never {
  throw new PermanentFinancialError('allocation_mismatch');
}

function sourceLinkageMismatch(): never {
  throw new PermanentFinancialError('source_linkage_mismatch');
}

export function assertSafeMoney(value: number): void {
  if (!Number.isSafeInteger(value)) allocationMismatch();
}

export function assertCurrency(value: string): void {
  if (!/^[A-Z]{3}$/u.test(value)) throw new PermanentFinancialError('currency_mismatch');
}

function assertMetadata(input: FinancialAllocationMetadata): void {
  assertCurrency(input.settlementCurrency);
  assertSafeMoney(input.amountMinor);
  assertSafeMoney(input.feeMinor);
  assertSafeMoney(input.netMinor);
  if (input.feeMinor < 0 || BigInt(input.amountMinor) - BigInt(input.feeMinor) !== BigInt(input.netMinor)) {
    allocationMismatch();
  }
  if (
    input.allocationIdentityPrefix.length === 0 ||
    input.balanceTransactionId.length === 0 ||
    input.sourceId.length === 0 ||
    input.sourceFingerprint.length !== 64 ||
    !/^[a-f0-9]{64}$/u.test(input.sourceFingerprint) ||
    !Number.isSafeInteger(input.algorithmVersion) ||
    input.algorithmVersion < 1
  ) sourceLinkageMismatch();
}

export function assertAllocationPlanConserves(plan: FinancialAllocationPlan): void {
  assertCurrency(plan.currency);
  assertSafeMoney(plan.expectedEffectMinor);
  if (plan.scope !== 'title') {
    if (plan.items.length !== 0) allocationMismatch();
    return;
  }

  const seenTieKeys = new Set<string>();
  const seenComponents = new Set<string>();
  let sum = 0n;
  for (const item of plan.items) {
    assertCurrency(item.currency);
    if (
      item.currency !== plan.currency ||
      item.orderItemId.length === 0 ||
      item.tieBreakKey.length === 0 ||
      seenTieKeys.has(item.tieBreakKey)
    ) allocationMismatch();
    const componentKey = `${item.orderItemId}\u0000${item.component}`;
    if (seenComponents.has(componentKey)) allocationMismatch();
    assertSafeMoney(item.effectMinor);
    seenTieKeys.add(item.tieBreakKey);
    seenComponents.add(componentKey);
    sum += BigInt(item.effectMinor);
  }
  if (sum !== BigInt(plan.expectedEffectMinor)) allocationMismatch();
}

export function basePlan(
  input: FinancialAllocationMetadata,
  options: {
    readonly basis: 'gross_amount' | 'fee';
    readonly scope: 'title' | 'account' | 'unresolved';
    readonly expectedEffectMinor: number;
    readonly items: readonly FinancialAllocationItem[];
    readonly reversalOfSetId?: string | null;
  }
): FinancialAllocationPlan {
  assertMetadata(input);
  assertSafeMoney(options.expectedEffectMinor);
  const plan: FinancialAllocationPlan = {
    allocationIdentity: `${input.allocationIdentityPrefix}:${options.basis === 'gross_amount' ? 'gross' : 'fee'}`,
    balanceTransactionId: input.balanceTransactionId,
    basis: options.basis,
    scope: options.scope,
    currency: input.settlementCurrency,
    expectedEffectMinor: options.expectedEffectMinor,
    algorithmVersion: input.algorithmVersion,
    sourceFingerprint: input.sourceFingerprint,
    supersedesSetId:
      options.basis === 'gross_amount' ? input.supersedesGrossSetId : input.supersedesFeeSetId,
    reversalOfSetId: options.reversalOfSetId ?? null,
    items: options.items
  };
  assertAllocationPlanConserves(plan);
  return plan;
}

export function allocateComponents(
  amountMinor: number,
  currency: string,
  components: readonly {
    readonly orderItemId: string;
    readonly component: FinancialComponent;
    readonly weightMinor: number;
    readonly tieBreakKey: string;
  }[]
): readonly FinancialAllocationItem[] {
  const componentByKey = new Map(components.map((component) => [component.tieBreakKey, component]));
  return allocateSignedLargestRemainder({
    amountMinor,
    weights: components.map(({ tieBreakKey, weightMinor }) => ({ tieKey: tieBreakKey, weightMinor }))
  }).map((allocation) => {
    const component = componentByKey.get(allocation.tieKey);
    if (!component) allocationMismatch();
    return {
      orderItemId: component.orderItemId,
      component: component.component,
      effectMinor: allocation.amountMinor,
      currency,
      tieBreakKey: component.tieBreakKey
    };
  });
}

export function allocateFeeDetails(
  feeMinor: number,
  currency: string,
  weights: readonly RefundFeeWeight[],
  feeDetails: readonly ClassifiedFeeDetail[]
): readonly FinancialAllocationItem[] {
  assertSafeMoney(feeMinor);
  assertCurrency(currency);
  if (feeMinor < 0) allocationMismatch();

  const amountsByComponent = new Map<FinancialComponent, bigint>();
  for (const detail of feeDetails) {
    assertSafeMoney(detail.amountMinor);
    amountsByComponent.set(
      detail.component,
      (amountsByComponent.get(detail.component) ?? 0n) + BigInt(detail.amountMinor)
    );
  }
  const detailTotal = [...amountsByComponent.values()].reduce((sum, amount) => sum + amount, 0n);
  if (detailTotal !== -BigInt(feeMinor)) allocationMismatch();
  if (feeMinor === 0) return [];

  for (const weight of weights) {
    assertSafeMoney(weight.subtotalMinor);
    assertCurrency(weight.currency);
    if (weight.subtotalMinor < 0 || weight.currency !== currency || weight.orderItemId.length === 0) {
      allocationMismatch();
    }
  }
  const positiveWeights = weights.filter((weight) => weight.subtotalMinor > 0);
  const effectiveWeights = positiveWeights.length > 0
    ? positiveWeights
    : weights.length === 1 ? [{ ...weights[0]!, subtotalMinor: 1 }] : [];
  if (effectiveWeights.length === 0) allocationMismatch();

  const result: FinancialAllocationItem[] = [];
  for (const [component, amount] of amountsByComponent) {
    const normalizedAmount = Number(amount);
    if (!Number.isSafeInteger(normalizedAmount)) allocationMismatch();
    const allocations = allocateSignedLargestRemainder({
      amountMinor: normalizedAmount,
      weights: effectiveWeights.map((weight) => ({
        tieKey: weight.orderItemId,
        weightMinor: weight.subtotalMinor
      }))
    });
    for (const allocation of allocations) {
      result.push({
        orderItemId: allocation.tieKey,
        component,
        effectMinor: allocation.amountMinor,
        currency,
        tieBreakKey: `${allocation.tieKey}:${component}`
      });
    }
  }
  return result;
}

export function planWeights(plan: FinancialAllocationPlan): readonly {
  tieKey: string;
  orderItemId: string;
  component: FinancialComponent;
  weightMinor: number;
}[] {
  const rows = new Map<string, {
    tieKey: string;
    orderItemId: string;
    component: FinancialComponent;
    weightMinor: number;
  }>();
  for (const item of plan.items) {
    const key = item.tieBreakKey;
    if (rows.has(key)) allocationMismatch();
    rows.set(key, {
      tieKey: key,
      orderItemId: item.orderItemId,
      component: item.component,
      weightMinor: Math.abs(item.effectMinor)
    });
  }
  return [...rows.values()];
}
