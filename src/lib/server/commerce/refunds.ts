import { and, asc, eq, inArray } from 'drizzle-orm';
import { normalizeEmailAddress } from '$lib/server/auth/identity';
import { appendAuditEvent as defaultAppendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import {
  entitlementGrants,
  orderItems,
  orders,
  payments,
  refundAllocations,
  refunds,
  stripeEvents,
  user,
  type NewRefundAllocationRow,
  type RefundRow,
  type StripeEventRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { PermanentCommerceError } from './errors';
import type { RefundFulfillmentInput } from './handler';
import {
  assertGrantTransitionAllowed,
  projectEffectiveEntitlement as defaultProjectEffectiveEntitlement
} from './grants';
import { lockEntitlementScopes, lockOrder } from './lock';
import { parsePaymentSnapshot, parseRefundSnapshot } from './stripe/schemas';
import { describeSupportedStripeEvent } from './webhooks';

export interface RefundAllocationItemFact {
  orderItemId: string;
  totalMinor: number;
  currency: string;
}

export interface RefundAllocationRefundFact {
  refundId: string;
  providerRefundId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  amountMinor: number;
  currency: string;
  providerCreatedAt: Date;
}

export interface ExistingRefundAllocationFact {
  refundId: string;
  orderItemId: string;
  amountMinor: number;
}

export interface RefundAllocationFacts {
  items: readonly RefundAllocationItemFact[];
  refunds: readonly RefundAllocationRefundFact[];
  existingAllocations: readonly ExistingRefundAllocationFact[];
}

export interface NewRefundAllocation {
  refundId: string;
  orderItemId: string;
  amountMinor: number;
}

export type RefundAllocationResult =
  | { state: 'allocated'; allocations: readonly NewRefundAllocation[] }
  | { state: 'noop' | 'exception'; allocations: readonly [] };

const exception = (): RefundAllocationResult => ({ state: 'exception', allocations: [] });
const noop = (): RefundAllocationResult => ({ state: 'noop', allocations: [] });

function safeTotal(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function compareRefunds(
  left: RefundAllocationRefundFact,
  right: RefundAllocationRefundFact
): number {
  return left.providerCreatedAt.getTime() - right.providerCreatedAt.getTime() ||
    left.providerRefundId.localeCompare(right.providerRefundId) ||
    left.refundId.localeCompare(right.refundId);
}

export function allocateDeterministicRefunds(
  facts: RefundAllocationFacts
): RefundAllocationResult {
  if (!Array.isArray(facts.items) || facts.items.length === 0) return exception();
  if (!Array.isArray(facts.refunds) || !Array.isArray(facts.existingAllocations)) {
    return exception();
  }

  const items = [...facts.items].sort((left, right) =>
    left.orderItemId.localeCompare(right.orderItemId)
  );
  const currency = items[0]?.currency;
  const itemIds = new Set<string>();
  for (const item of items) {
    if (
      !item.orderItemId ||
      itemIds.has(item.orderItemId) ||
      !Number.isSafeInteger(item.totalMinor) ||
      item.totalMinor < 1 ||
      !/^[A-Z]{3}$/u.test(item.currency) ||
      item.currency !== currency
    ) return exception();
    itemIds.add(item.orderItemId);
  }

  const refundIds = new Set<string>();
  const providerRefundIds = new Set<string>();
  const refundsById = new Map<string, RefundAllocationRefundFact>();
  for (const refund of facts.refunds) {
    if (
      !refund.refundId ||
      !refund.providerRefundId ||
      refundIds.has(refund.refundId) ||
      providerRefundIds.has(refund.providerRefundId) ||
      !['pending', 'succeeded', 'failed', 'canceled'].includes(refund.status) ||
      !Number.isSafeInteger(refund.amountMinor) ||
      refund.amountMinor < 1 ||
      refund.currency !== currency ||
      !Number.isFinite(refund.providerCreatedAt.getTime())
    ) return exception();
    refundIds.add(refund.refundId);
    providerRefundIds.add(refund.providerRefundId);
    refundsById.set(refund.refundId, refund);
  }

  const allocationKeys = new Set<string>();
  const allocatedByRefund = new Map<string, number>();
  const allocatedByItem = new Map<string, number>();
  for (const allocation of facts.existingAllocations) {
    const refund = refundsById.get(allocation.refundId);
    const key = `${allocation.refundId}\0${allocation.orderItemId}`;
    if (
      !refund ||
      refund.status !== 'succeeded' ||
      !itemIds.has(allocation.orderItemId) ||
      allocationKeys.has(key) ||
      !Number.isSafeInteger(allocation.amountMinor) ||
      allocation.amountMinor < 1
    ) return exception();
    allocationKeys.add(key);
    const refundTotal = (allocatedByRefund.get(allocation.refundId) ?? 0) +
      allocation.amountMinor;
    const itemTotal = (allocatedByItem.get(allocation.orderItemId) ?? 0) +
      allocation.amountMinor;
    if (!Number.isSafeInteger(refundTotal) || !Number.isSafeInteger(itemTotal)) {
      return exception();
    }
    allocatedByRefund.set(allocation.refundId, refundTotal);
    allocatedByItem.set(allocation.orderItemId, itemTotal);
  }

  const succeeded = facts.refunds
    .filter((refund) => refund.status === 'succeeded')
    .sort(compareRefunds);
  const itemTotal = safeTotal(items.map((item) => item.totalMinor));
  const refundedTotal = safeTotal(succeeded.map((refund) => refund.amountMinor));
  if (itemTotal === null || refundedTotal === null || refundedTotal > itemTotal) {
    return exception();
  }
  for (const refund of succeeded) {
    if ((allocatedByRefund.get(refund.refundId) ?? 0) > refund.amountMinor) {
      return exception();
    }
  }
  for (const item of items) {
    if ((allocatedByItem.get(item.orderItemId) ?? 0) > item.totalMinor) {
      return exception();
    }
  }

  if (items.length === 1) {
    const target = items[0]!;
    const allocations = succeeded.flatMap((refund): NewRefundAllocation[] => {
      const amountMinor = refund.amountMinor - (allocatedByRefund.get(refund.refundId) ?? 0);
      return amountMinor === 0
        ? []
        : [{ refundId: refund.refundId, orderItemId: target.orderItemId, amountMinor }];
    });
    return allocations.length === 0 ? noop() : { state: 'allocated', allocations };
  }

  const remainingByItem = new Map(items.map((item) => [
    item.orderItemId,
    item.totalMinor - (allocatedByItem.get(item.orderItemId) ?? 0)
  ]));
  const remainingByRefund = new Map(succeeded.map((refund) => [
    refund.refundId,
    refund.amountMinor - (allocatedByRefund.get(refund.refundId) ?? 0)
  ]));
  const remainingRefunds = succeeded.filter(
    (refund) => (remainingByRefund.get(refund.refundId) ?? 0) > 0
  );
  if (remainingRefunds.length === 0) return noop();
  const remainingItemTotal = safeTotal([...remainingByItem.values()]);
  const remainingRefundTotal = safeTotal([...remainingByRefund.values()]);
  if (
    remainingItemTotal === null ||
    remainingRefundTotal === null ||
    remainingRefundTotal !== remainingItemTotal ||
    (refundedTotal !== itemTotal && remainingRefunds.length !== 1)
  ) return exception();

  const allocations: NewRefundAllocation[] = [];
  for (const refund of remainingRefunds) {
    let refundRemaining = remainingByRefund.get(refund.refundId) ?? 0;
    for (const item of items) {
      const itemRemaining = remainingByItem.get(item.orderItemId) ?? 0;
      const amountMinor = Math.min(refundRemaining, itemRemaining);
      if (amountMinor === 0) continue;
      allocations.push({ refundId: refund.refundId, orderItemId: item.orderItemId, amountMinor });
      refundRemaining -= amountMinor;
      remainingByItem.set(item.orderItemId, itemRemaining - amountMinor);
    }
    if (refundRemaining !== 0) return exception();
  }
  return [...remainingByItem.values()].some((remaining) => remaining !== 0)
    ? exception()
    : { state: 'allocated', allocations };
}

export interface RefundAccessMessageEnqueuer {
  enqueueAccessChange(
    transaction: DatabaseTransaction,
    input: {
      template: 'commerce.refund-access-changed';
      eventId: string;
      to: string;
      reasonCategory: 'refund_completed';
      affectedTitleCount: number;
    }
  ): Promise<void>;
}

type ProjectEntitlement = typeof defaultProjectEffectiveEntitlement;
type AppendAuditEvent = typeof defaultAppendAuditEvent;

export interface RefundFulfillmentDependencies {
  messages: RefundAccessMessageEnqueuer;
  createAllocation?: (
    transaction: DatabaseTransaction,
    allocation: NewRefundAllocationRow
  ) => Promise<void>;
  projectEntitlement?: ProjectEntitlement;
  appendAuditEvent?: AppendAuditEvent;
  completeEvent?: (
    transaction: DatabaseTransaction,
    stripeEventId: string,
    status: 'processed' | 'exception',
    now: Date
  ) => Promise<void>;
  now?: () => Date;
}

async function createAllocation(
  transaction: DatabaseTransaction,
  allocation: NewRefundAllocationRow
): Promise<void> {
  await transaction.insert(refundAllocations).values(allocation);
}

async function completeEvent(
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
  if (!completed) throw new Error('Pending refund event could not be completed');
}

function permanent(): never {
  throw new PermanentCommerceError();
}

function eventValue(row: StripeEventRow) {
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

function assertRefundEvent(event: StripeEventRow, providerRefundId: string): void {
  const descriptor = describeSupportedStripeEvent(eventValue(event));
  if (
    !descriptor ||
    descriptor.objectFamily !== 'refund' ||
    event.objectId !== providerRefundId
  ) permanent();
}

function assertCanonicalPayment(
  local: typeof payments.$inferSelect,
  provider: ReturnType<typeof parsePaymentSnapshot>,
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
  ) permanent();
}

function assertExistingRefund(
  existing: RefundRow,
  canonical: ReturnType<typeof parseRefundSnapshot>,
  paymentId: string
): void {
  if (
    existing.paymentId !== paymentId ||
    existing.stripeRefundId !== canonical.providerRefundId ||
    existing.amountMinor !== canonical.amountMinor ||
    existing.currency !== canonical.currency.toUpperCase() ||
    existing.providerCreatedAt.getTime() !== canonical.providerCreatedAt.getTime()
  ) permanent();
}

async function storeCanonicalRefund(
  transaction: DatabaseTransaction,
  existing: RefundRow | undefined,
  paymentId: string,
  canonical: ReturnType<typeof parseRefundSnapshot>,
  now: Date
): Promise<RefundRow> {
  if (!existing) {
    const [inserted] = await transaction.insert(refunds).values({
      paymentId,
      stripeRefundId: canonical.providerRefundId,
      status: canonical.state,
      amountMinor: canonical.amountMinor,
      currency: canonical.currency.toUpperCase(),
      reason: canonical.reason,
      providerCreatedAt: canonical.providerCreatedAt,
      reconciliationStatus: 'pending',
      createdAt: now,
      updatedAt: now
    }).returning();
    if (!inserted) permanent();
    return inserted;
  }
  assertExistingRefund(existing, canonical, paymentId);
  const status = existing.status === 'succeeded' ? 'succeeded' : canonical.state;
  const [updated] = await transaction
    .update(refunds)
    .set({
      status,
      reason: status === existing.status ? existing.reason : canonical.reason,
      reconciliationStatus: 'pending',
      updatedAt: now
    })
    .where(eq(refunds.id, existing.id))
    .returning();
  if (!updated) permanent();
  return updated;
}

function transitionTime(now: Date, grantedAt: Date): Date {
  return now.getTime() < grantedAt.getTime() ? grantedAt : now;
}

export async function fulfillRefundEvent(
  database: Database,
  input: RefundFulfillmentInput,
  dependencyOverrides: RefundFulfillmentDependencies
): Promise<void> {
  const canonicalRefund = parseRefundSnapshot(input.refund);
  const canonicalPayment = parsePaymentSnapshot(input.payment);
  const dependencies = {
    messages: dependencyOverrides.messages,
    createAllocation: dependencyOverrides.createAllocation ?? createAllocation,
    projectEntitlement:
      dependencyOverrides.projectEntitlement ?? defaultProjectEffectiveEntitlement,
    appendAuditEvent: dependencyOverrides.appendAuditEvent ?? defaultAppendAuditEvent,
    completeEvent: dependencyOverrides.completeEvent ?? completeEvent,
    now: dependencyOverrides.now ?? (() => new Date())
  };

  await database.transaction(async (transaction) => {
    const [event] = await transaction
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, input.stripeEventId))
      .limit(1)
      .for('update');
    if (!event) permanent();
    if (event.status !== 'pending') return;
    const now = dependencies.now();
    if (!Number.isFinite(now.getTime())) permanent();
    assertRefundEvent(event, canonicalRefund.providerRefundId);
    if (
      canonicalRefund.liveMode !== event.liveMode ||
      canonicalRefund.paymentIntentId !== canonicalPayment.paymentIntentId ||
      canonicalRefund.currency !== canonicalPayment.currency
    ) permanent();

    const [payment] = await transaction
      .select()
      .from(payments)
      .where(eq(payments.stripePaymentIntentId, canonicalPayment.paymentIntentId))
      .limit(1)
      .for('update');
    if (!payment) permanent();
    assertCanonicalPayment(payment, canonicalPayment, event);

    await lockOrder(transaction, payment.orderId);
    const [order] = await transaction
      .select()
      .from(orders)
      .where(eq(orders.id, payment.orderId))
      .limit(1)
      .for('update');
    if (
      !order ||
      order.status !== 'paid' ||
      order.currency !== payment.currency ||
      order.totalMinor !== payment.amountMinor
    ) permanent();

    const lockedRefunds = await transaction
      .select()
      .from(refunds)
      .where(eq(refunds.paymentId, payment.id))
      .orderBy(asc(refunds.id))
      .for('update');
    const providerCollision = await transaction
      .select()
      .from(refunds)
      .where(eq(refunds.stripeRefundId, canonicalRefund.providerRefundId))
      .limit(1)
      .for('update');
    const collision = providerCollision[0];
    if (collision && collision.paymentId !== payment.id) permanent();
    const existing = lockedRefunds.find(
      (refund) => refund.stripeRefundId === canonicalRefund.providerRefundId
    );
    const storedRefund = await storeCanonicalRefund(
      transaction,
      existing,
      payment.id,
      canonicalRefund,
      now
    );
    const allRefunds = existing
      ? lockedRefunds.map((refund) => refund.id === storedRefund.id ? storedRefund : refund)
      : [...lockedRefunds, storedRefund].sort((left, right) => left.id.localeCompare(right.id));

    const lockedAllocations = await transaction
      .select()
      .from(refundAllocations)
      .where(inArray(refundAllocations.refundId, allRefunds.map((refund) => refund.id)))
      .orderBy(asc(refundAllocations.id))
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
    ) permanent();
    const itemAggregate = safeTotal(items.map((item) => item.totalMinor!));
    if (itemAggregate === null || itemAggregate !== payment.amountMinor) permanent();
    const grants = await transaction
      .select()
      .from(entitlementGrants)
      .where(inArray(entitlementGrants.orderItemId, items.map((item) => item.id)))
      .orderBy(asc(entitlementGrants.id))
      .for('update');
    if (
      grants.length !== items.length ||
      grants.some((grant) => grant.source !== 'purchase')
    ) permanent();
    const itemById = new Map(items.map((item) => [item.id, item]));
    if (grants.some((grant) => {
      const item = grant.orderItemId ? itemById.get(grant.orderItemId) : undefined;
      return !item || grant.titleId !== item.titleId;
    })) permanent();
    const scopes = grants.flatMap((grant) => grant.userId
      ? [{ userId: grant.userId, titleId: grant.titleId }]
      : []);
    await lockEntitlementScopes(transaction, scopes);

    const allocation = allocateDeterministicRefunds({
      items: items.map((item) => ({
        orderItemId: item.id,
        totalMinor: item.totalMinor!,
        currency: item.currency
      })),
      refunds: allRefunds.map((refund) => ({
        refundId: refund.id,
        providerRefundId: refund.stripeRefundId,
        status: refund.status,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        providerCreatedAt: refund.providerCreatedAt
      })),
      existingAllocations: lockedAllocations.map((row) => ({
        refundId: row.refundId,
        orderItemId: row.orderItemId,
        amountMinor: row.amountMinor
      }))
    });
    const reconciliationStatus = allocation.state === 'exception' ? 'exception' : 'pending';
    await transaction
      .update(refunds)
      .set({ reconciliationStatus, updatedAt: now })
      .where(inArray(refunds.id, allRefunds.map((refund) => refund.id)));

    const eventStatus = allocation.state === 'exception' ? 'exception' : 'processed';
    let affectedTitleCount = 0;
    if (allocation.state !== 'exception') {
      for (const row of allocation.allocations) {
        await dependencies.createAllocation(transaction, {
          refundId: row.refundId,
          orderItemId: row.orderItemId,
          amountMinor: row.amountMinor,
          source: 'automatic',
          createdAt: now
        });
      }
      const allAllocations = [...lockedAllocations, ...allocation.allocations];
      const fullyAllocatedItems = new Set(items.filter((item) => {
        const total = allAllocations
          .filter((row) => row.orderItemId === item.id)
          .reduce((sum, row) => sum + row.amountMinor, 0);
        return total === item.totalMinor;
      }).map((item) => item.id));
      const changedScopes: Array<{ userId: string; titleId: string }> = [];
      for (const grant of grants) {
        if (!grant.orderItemId || !fullyAllocatedItems.has(grant.orderItemId)) continue;
        assertGrantTransitionAllowed(grant, 'revoked', 'refund');
        if (grant.state === 'revoked') continue;
        await transaction
          .update(entitlementGrants)
          .set({
            state: 'revoked',
            stateReason: 'refund_fully_allocated',
            suspendedAt: null,
            revokedAt: transitionTime(now, grant.grantedAt),
            updatedAt: now
          })
          .where(eq(entitlementGrants.id, grant.id));
        if (grant.userId) changedScopes.push({ userId: grant.userId, titleId: grant.titleId });
      }
      const uniqueScopes = [...new Map(changedScopes.map((scope) => [
        `${scope.userId}\0${scope.titleId}`,
        scope
      ])).values()].sort((left, right) =>
        left.userId.localeCompare(right.userId) || left.titleId.localeCompare(right.titleId)
      );
      const accessChangedScopes = [];
      for (const scope of uniqueScopes) {
        const projected = await dependencies.projectEntitlement(
          transaction,
          scope.userId,
          scope.titleId,
          now
        );
        if (projected.beforeActive !== projected.afterActive) accessChangedScopes.push(scope);
      }
      affectedTitleCount = accessChangedScopes.length;
      if (affectedTitleCount > 0) {
        const userIds = new Set(accessChangedScopes.map((scope) => scope.userId));
        if (userIds.size !== 1) permanent();
        const userId = accessChangedScopes[0]!.userId;
        const [recipient] = await transaction
          .select({ email: user.email, emailVerified: user.emailVerified })
          .from(user)
          .where(eq(user.id, userId))
          .limit(1);
        if (!recipient?.emailVerified) permanent();
        let email: string;
        try {
          email = normalizeEmailAddress(recipient.email);
        } catch {
          return permanent();
        }
        await dependencies.messages.enqueueAccessChange(transaction, {
          template: 'commerce.refund-access-changed',
          eventId: event.id,
          to: email,
          reasonCategory: 'refund_completed',
          affectedTitleCount
        });
      }
    }

    await dependencies.appendAuditEvent(transaction, {
      actor: { type: 'system', id: 'commerce-worker' },
      action: 'commerce.refund_reconciled',
      outcome: eventStatus === 'exception' ? 'failed' : 'succeeded',
      resourceType: 'stripe_event',
      resourceId: event.id,
      correlationId: `commerce-refund-${event.id}`,
      after: {
        allocationState: allocation.state,
        affectedTitleCount
      }
    });
    await dependencies.completeEvent(transaction, event.id, eventStatus, now);
  });
}
