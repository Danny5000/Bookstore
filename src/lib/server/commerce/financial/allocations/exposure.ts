import { PermanentFinancialError } from '../errors';
import { assertCurrency, assertSafeMoney } from './common';
import type {
  BoundDisputePresentmentEffect,
  DisputePaymentItem,
  FinalizedDisputeRefund
} from './types';

export interface FinancialExposureChronologyKey {
  readonly providerCreatedAtMs: number;
  readonly providerId: string;
  readonly sourceId: string;
  readonly rowId: string;
}

export interface FinancialExposureReplayInput {
  readonly presentmentCurrency: string;
  readonly current: {
    readonly providerCreatedAt: string;
    readonly providerId: string;
    readonly sourceId: string;
  };
  readonly paymentItems: readonly DisputePaymentItem[];
  readonly finalizedRefunds: readonly FinalizedDisputeRefund[];
  readonly priorPresentmentEffects: readonly BoundDisputePresentmentEffect[];
}

export interface FinancialExposureReplayResult {
  readonly capacity: ReadonlyMap<string, { subtotalMinor: number; taxMinor: number }>;
  readonly withdrawals: ReadonlyMap<string, BoundDisputePresentmentEffect>;
  readonly reversedWithdrawalIds: ReadonlySet<string>;
}

function mismatch(): never {
  throw new PermanentFinancialError('allocation_mismatch');
}

function linkageMismatch(): never {
  throw new PermanentFinancialError('source_linkage_mismatch');
}

function assertId(value: string): void {
  if (typeof value !== 'string' || value.length === 0) linkageMismatch();
}

function parseInstant(value: string): number {
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

export function compareFinancialExposureChronology(
  left: FinancialExposureChronologyKey,
  right: FinancialExposureChronologyKey
): number {
  if (left.providerCreatedAtMs !== right.providerCreatedAtMs) {
    return left.providerCreatedAtMs < right.providerCreatedAtMs ? -1 : 1;
  }
  const providerOrder = compareCodePoints(left.providerId, right.providerId);
  if (providerOrder !== 0) return providerOrder;
  const sourceOrder = compareCodePoints(left.sourceId, right.sourceId);
  return sourceOrder === 0 ? compareCodePoints(left.rowId, right.rowId) : sourceOrder;
}

function paymentCapacity(
  input: FinancialExposureReplayInput
): Map<string, { subtotalMinor: number; taxMinor: number }> {
  const capacity = new Map<string, { subtotalMinor: number; taxMinor: number }>();
  for (const item of input.paymentItems) {
    assertId(item.orderItemId);
    assertCurrency(item.presentmentCurrency);
    assertSafeMoney(item.subtotalMinor);
    assertSafeMoney(item.taxMinor);
    if (
      item.presentmentCurrency !== input.presentmentCurrency ||
      item.subtotalMinor < 0 || item.taxMinor < 0 || capacity.has(item.orderItemId)
    ) mismatch();
    capacity.set(item.orderItemId, {
      subtotalMinor: item.subtotalMinor,
      taxMinor: item.taxMinor
    });
  }
  if (capacity.size === 0) mismatch();
  return capacity;
}

function refundKey(
  refund: FinalizedDisputeRefund,
  currency: string
): FinancialExposureChronologyKey {
  assertId(refund.refundId);
  assertId(refund.providerRefundId);
  assertId(refund.componentId);
  assertId(refund.orderItemId);
  assertCurrency(refund.presentmentCurrency);
  assertSafeMoney(refund.subtotalMinor);
  assertSafeMoney(refund.taxMinor);
  if (
    refund.presentmentCurrency !== currency ||
    refund.subtotalMinor < 0 || refund.taxMinor < 0
  ) mismatch();
  return {
    providerCreatedAtMs: parseInstant(refund.providerCreatedAt),
    providerId: refund.providerRefundId,
    sourceId: refund.refundId,
    rowId: refund.componentId
  };
}

function disputeKey(
  effect: BoundDisputePresentmentEffect,
  currency: string
): FinancialExposureChronologyKey {
  assertId(effect.allocationId);
  assertId(effect.withdrawalSetId);
  assertId(effect.disputeId);
  assertId(effect.providerTransactionId);
  assertId(effect.orderItemId);
  assertCurrency(effect.presentmentCurrency);
  assertSafeMoney(effect.subtotalMinor);
  assertSafeMoney(effect.taxMinor);
  if (
    effect.presentmentCurrency !== currency ||
    !['withdrawal', 'reinstatement'].includes(effect.effect) ||
    (effect.effect === 'withdrawal' &&
      (effect.subtotalMinor > 0 || effect.taxMinor > 0 || effect.reversalOfAllocationId !== null)) ||
    (effect.effect === 'reinstatement' &&
      (effect.subtotalMinor < 0 || effect.taxMinor < 0 || !effect.reversalOfAllocationId)) ||
    effect.subtotalMinor + effect.taxMinor === 0
  ) mismatch();
  return {
    providerCreatedAtMs: parseInstant(effect.providerCreatedAt),
    providerId: effect.providerTransactionId,
    sourceId: effect.disputeId,
    rowId: effect.allocationId
  };
}

export function replayFinancialExposure(
  input: FinancialExposureReplayInput
): FinancialExposureReplayResult {
  assertCurrency(input.presentmentCurrency);
  assertId(input.current.providerId);
  assertId(input.current.sourceId);
  const current: FinancialExposureChronologyKey = {
    providerCreatedAtMs: parseInstant(input.current.providerCreatedAt),
    providerId: input.current.providerId,
    sourceId: input.current.sourceId,
    rowId: ''
  };
  const capacity = paymentCapacity(input);
  const refundComponentIds = new Set<string>();
  const refundIdentityById = new Map<string, string>();
  const refundSourceByProviderId = new Map<string, string>();
  const disputeAllocationIds = new Set<string>();
  const transactionKinds = new Map<string, string>();
  const events: Array<
    | { readonly kind: 'refund'; readonly chronology: FinancialExposureChronologyKey;
        readonly refund: FinalizedDisputeRefund }
    | { readonly kind: 'dispute'; readonly chronology: FinancialExposureChronologyKey;
        readonly effect: BoundDisputePresentmentEffect }
  > = [];

  for (const refund of input.finalizedRefunds) {
    const chronology = refundKey(refund, input.presentmentCurrency);
    if (compareFinancialExposureChronology(chronology, current) >= 0) mismatch();
    if (refundComponentIds.has(refund.componentId)) mismatch();
    refundComponentIds.add(refund.componentId);
    const identity = `${chronology.providerCreatedAtMs}\u0000${refund.providerRefundId}`;
    const priorIdentity = refundIdentityById.get(refund.refundId);
    if (priorIdentity !== undefined && priorIdentity !== identity) linkageMismatch();
    refundIdentityById.set(refund.refundId, identity);
    const priorSource = refundSourceByProviderId.get(refund.providerRefundId);
    if (priorSource !== undefined && priorSource !== refund.refundId) linkageMismatch();
    refundSourceByProviderId.set(refund.providerRefundId, refund.refundId);
    events.push({ kind: 'refund', chronology, refund });
  }

  for (const effect of input.priorPresentmentEffects) {
    const chronology = disputeKey(effect, input.presentmentCurrency);
    if (compareFinancialExposureChronology(chronology, current) >= 0) linkageMismatch();
    if (disputeAllocationIds.has(effect.allocationId)) linkageMismatch();
    disputeAllocationIds.add(effect.allocationId);
    const transactionKey = `${effect.disputeId}\u0000${chronology.providerCreatedAtMs}\u0000${effect.providerTransactionId}`;
    const priorKind = transactionKinds.get(transactionKey);
    if (priorKind !== undefined && priorKind !== effect.effect) linkageMismatch();
    transactionKinds.set(transactionKey, effect.effect);
    events.push({ kind: 'dispute', chronology, effect });
  }

  events.sort((left, right) =>
    compareFinancialExposureChronology(left.chronology, right.chronology));
  const withdrawals = new Map<string, BoundDisputePresentmentEffect>();
  const reversed = new Set<string>();
  for (const event of events) {
    const row = event.kind === 'refund' ? event.refund : event.effect;
    const remaining = capacity.get(row.orderItemId);
    if (!remaining) linkageMismatch();
    if (event.kind === 'refund') {
      if (
        row.subtotalMinor > remaining.subtotalMinor ||
        row.taxMinor > remaining.taxMinor
      ) mismatch();
      remaining.subtotalMinor -= row.subtotalMinor;
      remaining.taxMinor -= row.taxMinor;
      continue;
    }
    const effect = event.effect;
    if (effect.effect === 'withdrawal') {
      if (
        effect.subtotalMinor < -remaining.subtotalMinor ||
        effect.taxMinor < -remaining.taxMinor
      ) mismatch();
      remaining.subtotalMinor += effect.subtotalMinor;
      remaining.taxMinor += effect.taxMinor;
      withdrawals.set(effect.allocationId, effect);
      continue;
    }
    const original = withdrawals.get(effect.reversalOfAllocationId);
    if (
      !original || reversed.has(original.allocationId) ||
      original.disputeId !== effect.disputeId ||
      original.withdrawalSetId !== effect.withdrawalSetId ||
      original.orderItemId !== effect.orderItemId ||
      effect.subtotalMinor > -original.subtotalMinor ||
      effect.taxMinor > -original.taxMinor
    ) linkageMismatch();
    reversed.add(original.allocationId);
    remaining.subtotalMinor += effect.subtotalMinor;
    remaining.taxMinor += effect.taxMinor;
  }
  return { capacity, withdrawals, reversedWithdrawalIds: reversed };
}
