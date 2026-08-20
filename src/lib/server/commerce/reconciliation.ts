import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  disputes,
  disputeItemAllocations,
  entitlementGrants,
  orderItems,
  orders,
  payments,
  refundAllocationComponents,
  refundAllocationDraftItems,
  refundAllocationDrafts,
  refundAllocations,
  refundReportingCorrectionItems,
  refundReportingCorrectionSets,
  refunds,
  stripeEvents,
  type DisputeItemAllocationRow,
  type DisputeRow,
  type OrderItemRow,
  type OrderRow,
  type PaymentRow,
  type RefundAllocationComponentRow,
  type RefundAllocationDraftItemRow,
  type RefundAllocationDraftRow,
  type RefundAllocationRow,
  type RefundReportingCorrectionItemRow,
  type RefundReportingCorrectionSetRow,
  type RefundRow,
  type StripeEventRow
} from '$lib/server/db/schema';
import { LocalCommerceNotReadyError, PermanentCommerceError } from './errors';
import { lockEntitlementScopes, lockOrder } from './lock';
import type { PaymentSnapshot, VerifiedStripeEvent } from './stripe/types';

export function permanentReconciliationFailure(): never {
  throw new PermanentCommerceError();
}

export function safeMoneyTotal(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function stripeEventValue(row: StripeEventRow): VerifiedStripeEvent {
  return {
    providerEventId: row.providerEventId,
    type: row.eventType,
    objectId: row.objectId,
    liveMode: row.liveMode,
    apiVersion: row.apiVersion,
    providerCreatedAt: row.providerCreatedAt,
    rawBodySha256: row.rawBodySha256
  };
}

export function reconciliationTransitionTime(now: Date, grantedAt: Date): Date {
  return now.getTime() < grantedAt.getTime() ? grantedAt : now;
}

export async function completeCommerceEvent(
  transaction: DatabaseTransaction,
  stripeEventId: string,
  status: 'processed' | 'exception',
  now: Date
): Promise<void> {
  const [completed] = await transaction
    .update(stripeEvents)
    .set({ status, processedAt: now, updatedAt: now })
    .where(and(eq(stripeEvents.id, stripeEventId), eq(stripeEvents.status, 'pending')))
    .returning({ id: stripeEvents.id });
  if (!completed) throw new Error('Pending commerce event could not be completed');
}

function assertCanonicalPayment(
  local: typeof payments.$inferSelect,
  provider: PaymentSnapshot,
  event: StripeEventRow
): void {
  if (
    provider.liveMode !== event.liveMode ||
    provider.paymentIntentId !== local.stripePaymentIntentId ||
    provider.metadataVersion !== '1' ||
    provider.metadataOrderId !== local.orderId ||
    provider.state !== 'succeeded' ||
    provider.amountMinor !== local.amountMinor ||
    provider.currency.toUpperCase() !== local.currency
  ) permanentReconciliationFailure();
}

function assertCompletedCanonicalPayment(
  local: typeof payments.$inferSelect,
  provider: PaymentSnapshot,
  event: StripeEventRow
): void {
  assertCanonicalPayment(local, provider, event);
  if (
    local.status !== 'succeeded' ||
    provider.latestChargeId !== local.stripeLatestChargeId ||
    provider.paidAt?.getTime() !== local.paidAt?.getTime() ||
    provider.paymentMethodCategory !== local.paymentMethodCategory
  ) permanentReconciliationFailure();
}

export async function lockCanonicalPaymentOrder(
  transaction: DatabaseTransaction,
  providerPayment: PaymentSnapshot,
  event: StripeEventRow
) {
  if (
    providerPayment.liveMode !== event.liveMode ||
    providerPayment.state !== 'succeeded' ||
    providerPayment.metadataVersion !== '1'
  ) permanentReconciliationFailure();

  await lockOrder(transaction, providerPayment.metadataOrderId);
  const [order] = await transaction
    .select()
    .from(orders)
    .where(eq(orders.id, providerPayment.metadataOrderId))
    .limit(1)
    .for('update');
  const [payment] = await transaction
    .select()
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, providerPayment.paymentIntentId))
    .limit(1)
    .for('update');
  if (!payment) {
    if (
      !order ||
      order.status === 'paid' ||
      order.status === 'exception' ||
      order.currency !== providerPayment.currency.toUpperCase() ||
      order.subtotalMinor > providerPayment.amountMinor ||
      (order.totalMinor !== null && order.totalMinor !== providerPayment.amountMinor)
    ) permanentReconciliationFailure();
    throw new LocalCommerceNotReadyError();
  }
  assertCanonicalPayment(payment, providerPayment, event);
  if (
    !order ||
    payment.orderId !== order.id ||
    order.currency !== payment.currency ||
    order.status === 'exception' ||
    (order.totalMinor !== null && order.totalMinor !== payment.amountMinor)
  ) permanentReconciliationFailure();
  if (payment.status !== 'succeeded') {
    if (order.status === 'paid') permanentReconciliationFailure();
    throw new LocalCommerceNotReadyError();
  }
  assertCompletedCanonicalPayment(payment, providerPayment, event);
  if (
    order.status !== 'paid' ||
    order.totalMinor !== payment.amountMinor
  ) permanentReconciliationFailure();
  return { payment, order };
}

export interface PaymentPurchaseFacts {
  payment: PaymentRow;
  order: PaymentPurchaseOrderRow;
  refunds: readonly RefundRow[];
  refundDrafts: readonly RefundAllocationDraftRow[];
  refundDraftItems: readonly RefundAllocationDraftItemRow[];
  refundAllocations: readonly RefundAllocationRow[];
  refundComponents: readonly RefundAllocationComponentRow[];
  correctionSets: readonly RefundReportingCorrectionSetRow[];
  correctionItems: readonly RefundReportingCorrectionItemRow[];
  disputes: readonly DisputeRow[];
  disputeItemAllocations: readonly DisputeItemAllocationRow[];
  orderItems: readonly OrderItemRow[];
}

export type PaymentPurchaseOrderRow = Pick<
  OrderRow,
  'id' | 'status' | 'currency' | 'totalMinor' | 'paidAt'
>;

/**
 * Once operation-local event or identity rows are locked, every commerce mutation follows the
 * same purchase-graph order: order, payment, refunds, refund drafts/items, finalized refund
 * allocations/components, correction sets/items, disputes/item allocations, then order items.
 * Financial rows and entitlement scopes/grants extend this sequence in their own shared seams.
 */
export async function lockPaymentPurchaseFacts(
  transaction: DatabaseTransaction,
  payment: PaymentRow,
  order: PaymentPurchaseOrderRow
): Promise<PaymentPurchaseFacts> {
  const lockedRefunds = await transaction
    .select()
    .from(refunds)
    .where(eq(refunds.paymentId, payment.id))
    .orderBy(asc(refunds.id))
    .for('update');
  const lockedRefundDrafts = lockedRefunds.length === 0
    ? []
    : await transaction
        .select()
        .from(refundAllocationDrafts)
        .where(inArray(refundAllocationDrafts.refundId, lockedRefunds.map((row) => row.id)))
        .orderBy(asc(refundAllocationDrafts.id))
        .for('update');
  const lockedRefundDraftItems = lockedRefundDrafts.length === 0
    ? []
    : await transaction
        .select()
        .from(refundAllocationDraftItems)
        .where(inArray(
          refundAllocationDraftItems.draftId,
          lockedRefundDrafts.map((row) => row.id)
        ))
        .orderBy(asc(refundAllocationDraftItems.id))
        .for('update');
  const lockedAllocations = lockedRefunds.length === 0
    ? []
    : await transaction
        .select()
        .from(refundAllocations)
        .where(inArray(refundAllocations.refundId, lockedRefunds.map((row) => row.id)))
        .orderBy(asc(refundAllocations.id))
        .for('update');
  const lockedRefundComponents = lockedRefunds.length === 0
    ? []
    : await transaction
        .select()
        .from(refundAllocationComponents)
        .where(inArray(
          refundAllocationComponents.refundId,
          lockedRefunds.map((row) => row.id)
        ))
        .orderBy(asc(refundAllocationComponents.id))
        .for('update');
  const lockedCorrectionSets = lockedRefunds.length === 0
    ? []
    : await transaction
        .select()
        .from(refundReportingCorrectionSets)
        .where(inArray(
          refundReportingCorrectionSets.refundId,
          lockedRefunds.map((row) => row.id)
        ))
        .orderBy(asc(refundReportingCorrectionSets.id))
        .for('update');
  const lockedCorrectionItems = lockedCorrectionSets.length === 0
    ? []
    : await transaction
        .select()
        .from(refundReportingCorrectionItems)
        .where(inArray(
          refundReportingCorrectionItems.correctionSetId,
          lockedCorrectionSets.map((row) => row.id)
        ))
        .orderBy(asc(refundReportingCorrectionItems.id))
        .for('update');
  const lockedDisputes = await transaction
    .select()
    .from(disputes)
    .where(eq(disputes.paymentId, payment.id))
    .orderBy(asc(disputes.id))
    .for('update');
  const lockedDisputeItemAllocations = lockedDisputes.length === 0
    ? []
    : await transaction
        .select()
        .from(disputeItemAllocations)
        .where(inArray(
          disputeItemAllocations.disputeId,
          lockedDisputes.map((row) => row.id)
        ))
        .orderBy(asc(disputeItemAllocations.id))
        .for('update');
  const items = await transaction
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.id))
    .for('update');
  if (
    items.length === 0 ||
    items.some((item) => item.totalMinor === null || item.currency !== order.currency)
  ) permanentReconciliationFailure();
  const aggregate = safeMoneyTotal(items.map((item) => item.totalMinor!));
  if (aggregate === null || aggregate !== payment.amountMinor) {
    permanentReconciliationFailure();
  }
  return {
    payment,
    order,
    refunds: lockedRefunds,
    refundDrafts: lockedRefundDrafts,
    refundDraftItems: lockedRefundDraftItems,
    refundAllocations: lockedAllocations,
    refundComponents: lockedRefundComponents,
    correctionSets: lockedCorrectionSets,
    correctionItems: lockedCorrectionItems,
    disputes: lockedDisputes,
    disputeItemAllocations: lockedDisputeItemAllocations,
    orderItems: items
  };
}

export async function lockPaymentAccessFacts(
  transaction: DatabaseTransaction,
  payment: PaymentRow,
  order: OrderRow
) {
  const purchaseFacts = await lockPaymentPurchaseFacts(transaction, payment, order);
  const items = purchaseFacts.orderItems;
  const candidateGrants = await transaction
    .select()
    .from(entitlementGrants)
    .where(inArray(entitlementGrants.orderItemId, items.map((item) => item.id)))
    .orderBy(asc(entitlementGrants.id));
  if (
    candidateGrants.length !== items.length ||
    candidateGrants.some((grant) => grant.source !== 'purchase')
  ) {
    permanentReconciliationFailure();
  }
  const itemById = new Map(items.map((item) => [item.id, item]));
  if (candidateGrants.some((grant) => {
    const item = grant.orderItemId ? itemById.get(grant.orderItemId) : undefined;
    return !item || grant.titleId !== item.titleId;
  })) permanentReconciliationFailure();
  await lockEntitlementScopes(
    transaction,
    candidateGrants.flatMap((grant) => grant.userId
      ? [{ userId: grant.userId, titleId: grant.titleId }]
      : [])
  );
  const grants = await transaction
    .select()
    .from(entitlementGrants)
    .where(inArray(entitlementGrants.orderItemId, items.map((item) => item.id)))
    .orderBy(asc(entitlementGrants.id))
    .for('update');
  if (
    grants.length !== candidateGrants.length ||
    grants.some((grant, index) => {
      const candidate = candidateGrants[index];
      return !candidate ||
        grant.id !== candidate.id ||
        grant.orderItemId !== candidate.orderItemId ||
        grant.titleId !== candidate.titleId ||
        grant.userId !== candidate.userId ||
        grant.source !== candidate.source;
    })
  ) permanentReconciliationFailure();
  return {
    ...purchaseFacts,
    grants
  };
}
