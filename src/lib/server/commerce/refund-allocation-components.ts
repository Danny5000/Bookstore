import type {
  NewRefundAllocationComponentRow,
  OrderItemRow,
  RefundAllocationComponentRow,
  RefundAllocationRow,
  RefundRow
} from '$lib/server/db/schema';
import { permanentReconciliationFailure } from './reconciliation';

export interface RefundComponentAllocation {
  refundId: string;
  orderItemId: string;
  amountMinor: number;
}

export type RefundComponentWrite = Omit<
  NewRefundAllocationComponentRow,
  'id' | 'refundAllocationId'
>;

function compareC(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function planRefundAllocationComponents(input: {
  items: readonly OrderItemRow[];
  refunds: readonly RefundRow[];
  existingAllocations: readonly RefundAllocationRow[];
  existingComponents: readonly RefundAllocationComponentRow[];
  newAllocations: readonly RefundComponentAllocation[];
  createdAt: Date;
}): ReadonlyArray<{
  allocation: RefundComponentAllocation;
  component: RefundComponentWrite;
}> {
  const itemsById = new Map(input.items.map((item) => [item.id, item]));
  const refundsById = new Map(input.refunds.map((refund) => [refund.id, refund]));
  const remainingByItem = new Map<string, { subtotalMinor: bigint; taxMinor: bigint }>();
  for (const item of input.items) {
    if (
      item.totalMinor === null ||
      item.taxMinor === null ||
      !Number.isSafeInteger(item.unitSubtotalMinor) ||
      !Number.isSafeInteger(item.taxMinor) ||
      !Number.isSafeInteger(item.totalMinor) ||
      item.unitSubtotalMinor < 0 ||
      item.taxMinor < 0 ||
      item.unitSubtotalMinor + item.taxMinor !== item.totalMinor
    ) permanentReconciliationFailure();
    remainingByItem.set(item.id, {
      subtotalMinor: BigInt(item.unitSubtotalMinor),
      taxMinor: BigInt(item.taxMinor)
    });
  }

  const componentByAllocationId = new Map<string, RefundAllocationComponentRow>();
  for (const component of input.existingComponents) {
    if (componentByAllocationId.has(component.refundAllocationId)) {
      permanentReconciliationFailure();
    }
    componentByAllocationId.set(component.refundAllocationId, component);
  }
  if (componentByAllocationId.size !== input.existingAllocations.length) {
    permanentReconciliationFailure();
  }
  for (const allocation of input.existingAllocations) {
    const component = componentByAllocationId.get(allocation.id);
    const item = itemsById.get(allocation.orderItemId);
    const refund = refundsById.get(allocation.refundId);
    const remaining = remainingByItem.get(allocation.orderItemId);
    if (
      !component ||
      !item ||
      !refund ||
      !remaining ||
      component.refundId !== allocation.refundId ||
      component.orderItemId !== allocation.orderItemId ||
      component.currency !== item.currency ||
      component.currency !== refund.currency ||
      component.totalMinor !== allocation.amountMinor ||
      component.subtotalMinor + component.taxMinor !== component.totalMinor ||
      component.subtotalMinor < 0 ||
      component.taxMinor < 0 ||
      BigInt(component.subtotalMinor) > remaining.subtotalMinor ||
      BigInt(component.taxMinor) > remaining.taxMinor
    ) permanentReconciliationFailure();
    remaining.subtotalMinor -= BigInt(component.subtotalMinor);
    remaining.taxMinor -= BigInt(component.taxMinor);
  }

  const sorted = [...input.newAllocations].sort((left, right) => {
    const leftRefund = refundsById.get(left.refundId);
    const rightRefund = refundsById.get(right.refundId);
    if (!leftRefund || !rightRefund) permanentReconciliationFailure();
    return compareC(left.orderItemId, right.orderItemId) ||
      leftRefund.providerCreatedAt.getTime() - rightRefund.providerCreatedAt.getTime() ||
      compareC(leftRefund.stripeRefundId, rightRefund.stripeRefundId) ||
      compareC(leftRefund.id, rightRefund.id) ||
      compareC(left.refundId, right.refundId);
  });
  const seen = new Set<string>();
  return sorted.map((allocation) => {
    const key = `${allocation.refundId}\0${allocation.orderItemId}`;
    const item = itemsById.get(allocation.orderItemId);
    const refund = refundsById.get(allocation.refundId);
    const remaining = remainingByItem.get(allocation.orderItemId);
    if (
      seen.has(key) ||
      !item ||
      !refund ||
      !remaining ||
      refund.status !== 'succeeded' ||
      refund.currency !== item.currency ||
      !Number.isSafeInteger(allocation.amountMinor) ||
      allocation.amountMinor < 1
    ) permanentReconciliationFailure();
    seen.add(key);

    const amountMinor = BigInt(allocation.amountMinor);
    const remainingTotal = remaining.subtotalMinor + remaining.taxMinor;
    if (remainingTotal <= 0n || amountMinor > remainingTotal) {
      permanentReconciliationFailure();
    }
    let subtotalMinor = amountMinor * remaining.subtotalMinor / remainingTotal;
    let taxMinor = amountMinor * remaining.taxMinor / remainingTotal;
    const subtotalRemainder = amountMinor * remaining.subtotalMinor % remainingTotal;
    const taxRemainder = amountMinor * remaining.taxMinor % remainingTotal;
    const leftover = amountMinor - subtotalMinor - taxMinor;
    if (leftover < 0n || leftover > 1n) permanentReconciliationFailure();
    if (leftover === 1n) {
      const subtotalTieKey = `${item.id}:subtotal`;
      const taxTieKey = `${item.id}:tax`;
      if (
        subtotalRemainder > taxRemainder ||
        (subtotalRemainder === taxRemainder && compareC(subtotalTieKey, taxTieKey) < 0)
      ) subtotalMinor += 1n;
      else taxMinor += 1n;
    }
    if (
      subtotalMinor > remaining.subtotalMinor ||
      taxMinor > remaining.taxMinor ||
      subtotalMinor + taxMinor !== amountMinor
    ) permanentReconciliationFailure();
    remaining.subtotalMinor -= subtotalMinor;
    remaining.taxMinor -= taxMinor;
    const component: RefundComponentWrite = {
      refundId: allocation.refundId,
      orderItemId: allocation.orderItemId,
      subtotalMinor: Number(subtotalMinor),
      taxMinor: Number(taxMinor),
      totalMinor: allocation.amountMinor,
      currency: item.currency,
      createdAt: input.createdAt
    };
    return { allocation, component };
  });
}
