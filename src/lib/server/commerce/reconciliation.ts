import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  disputes,
  entitlementGrants,
  orderItems,
  orders,
  payments,
  refundAllocations,
  refunds,
  stripeEvents,
  type StripeEventRow
} from '$lib/server/db/schema';
import { PermanentCommerceError } from './errors';
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
    provider.state !== 'succeeded' ||
    local.status !== 'succeeded' ||
    provider.amountMinor !== local.amountMinor ||
    provider.currency.toUpperCase() !== local.currency ||
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
  const [candidate] = await transaction
    .select()
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, providerPayment.paymentIntentId))
    .limit(1);
  if (!candidate) permanentReconciliationFailure();
  await lockOrder(transaction, candidate.orderId);
  const [order] = await transaction
    .select()
    .from(orders)
    .where(eq(orders.id, candidate.orderId))
    .limit(1)
    .for('update');
  const [payment] = await transaction
    .select()
    .from(payments)
    .where(and(
      eq(payments.id, candidate.id),
      eq(payments.stripePaymentIntentId, providerPayment.paymentIntentId)
    ))
    .limit(1)
    .for('update');
  if (!payment) permanentReconciliationFailure();
  assertCanonicalPayment(payment, providerPayment, event);
  if (
    !order ||
    payment.orderId !== order.id ||
    order.status !== 'paid' ||
    order.currency !== payment.currency ||
    order.totalMinor !== payment.amountMinor
  ) permanentReconciliationFailure();
  return { payment, order };
}

/**
 * Once operation-local event or identity rows are locked, every commerce mutation follows the
 * same purchase-graph order: order, payment, refunds, allocations, disputes, items, entitlement
 * scopes, then grants. Keeping this sequence shared prevents cross-flow deadlocks.
 */
export async function lockPaymentAccessFacts(
  transaction: DatabaseTransaction,
  payment: typeof payments.$inferSelect,
  order: typeof orders.$inferSelect
) {
  const lockedRefunds = await transaction
    .select()
    .from(refunds)
    .where(eq(refunds.paymentId, payment.id))
    .orderBy(asc(refunds.id))
    .for('update');
  const lockedAllocations = lockedRefunds.length === 0
    ? []
    : await transaction
        .select()
        .from(refundAllocations)
        .where(inArray(refundAllocations.refundId, lockedRefunds.map((row) => row.id)))
        .orderBy(asc(refundAllocations.id))
        .for('update');
  const lockedDisputes = await transaction
    .select()
    .from(disputes)
    .where(eq(disputes.paymentId, payment.id))
    .orderBy(asc(disputes.id))
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
    refunds: lockedRefunds,
    allocations: lockedAllocations,
    disputes: lockedDisputes,
    items,
    grants
  };
}
