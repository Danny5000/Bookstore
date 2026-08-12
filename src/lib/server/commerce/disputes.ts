import { eq } from 'drizzle-orm';
import { normalizeEmailAddress } from '$lib/server/auth/identity';
import { appendAuditEvent as defaultAppendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import {
  disputes,
  entitlementGrants,
  stripeEvents,
  user,
  type DisputeRow,
  type NewDisputeRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { PermanentCommerceError } from './errors';
import {
  assertGrantTransitionAllowed,
  projectEffectiveEntitlement as defaultProjectEffectiveEntitlement
} from './grants';
import type { DisputeFulfillmentInput } from './handler';
import {
  completeCommerceEvent,
  lockCanonicalPaymentOrder,
  lockPaymentAccessFacts,
  permanentReconciliationFailure,
  reconciliationTransitionTime,
  stripeEventValue
} from './reconciliation';
import { parseDisputeSnapshot, parsePaymentSnapshot } from './stripe/schemas';
import { describeSupportedStripeEvent } from './webhooks';

export interface DisputedPurchaseGrantFacts {
  hasUser: boolean;
  permanentlyRevoked: boolean;
  itemTotalMinor: number;
  succeededRefundAllocatedMinor: number;
  disputeStates: ReadonlyArray<'open' | 'won' | 'lost'>;
}

export type DisputedPurchaseGrantState = 'unclaimed' | 'active' | 'suspended' | 'revoked';

export function deriveDisputedPurchaseGrantState(
  facts: DisputedPurchaseGrantFacts
): DisputedPurchaseGrantState {
  if (
    typeof facts.hasUser !== 'boolean' ||
    typeof facts.permanentlyRevoked !== 'boolean' ||
    !Number.isSafeInteger(facts.itemTotalMinor) ||
    facts.itemTotalMinor < 1 ||
    !Number.isSafeInteger(facts.succeededRefundAllocatedMinor) ||
    facts.succeededRefundAllocatedMinor < 0 ||
    facts.succeededRefundAllocatedMinor > facts.itemTotalMinor ||
    !Array.isArray(facts.disputeStates) ||
    facts.disputeStates.some((state) => !['open', 'won', 'lost'].includes(state))
  ) throw new PermanentCommerceError();

  if (
    facts.permanentlyRevoked ||
    facts.succeededRefundAllocatedMinor === facts.itemTotalMinor ||
    facts.disputeStates.includes('lost')
  ) return 'revoked';
  if (facts.disputeStates.includes('open')) return 'suspended';
  return facts.hasUser ? 'active' : 'unclaimed';
}

const SAFE_DISPUTE_REASONS = new Set([
  'bank_cannot_process',
  'check_returned',
  'credit_not_processed',
  'customer_initiated',
  'debit_not_authorized',
  'duplicate',
  'fraudulent',
  'general',
  'incorrect_account_details',
  'insufficient_funds',
  'noncompliant',
  'product_not_received',
  'product_unacceptable',
  'subscription_canceled',
  'unrecognized',
  'other'
]);

export function normalizeDisputeReasonCategory(value: string | null): string | null {
  if (value === null) return null;
  return SAFE_DISPUTE_REASONS.has(value) ? value : 'other';
}

export interface DisputeAccessMessageEnqueuer {
  enqueueAccessChange(
    transaction: DatabaseTransaction,
    input: {
      template: 'commerce.dispute-access-changed';
      eventId: string;
      to: string;
      reasonCategory: 'dispute_opened' | 'dispute_resolved';
      affectedTitleCount: number;
    }
  ): Promise<void>;
}

type ProjectEntitlement = typeof defaultProjectEffectiveEntitlement;
type AppendAuditEvent = typeof defaultAppendAuditEvent;

export interface DisputeFulfillmentDependencies {
  messages: DisputeAccessMessageEnqueuer;
  storeDispute?: (
    transaction: DatabaseTransaction,
    existing: DisputeRow | undefined,
    values: NewDisputeRow,
    now: Date
  ) => Promise<DisputeRow>;
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

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

async function storeDispute(
  transaction: DatabaseTransaction,
  existing: DisputeRow | undefined,
  values: NewDisputeRow,
  now: Date
): Promise<DisputeRow> {
  if (!existing) {
    const [inserted] = await transaction.insert(disputes).values(values).returning();
    if (!inserted) permanentReconciliationFailure();
    return inserted;
  }
  if (
    existing.paymentId !== values.paymentId ||
    existing.stripeDisputeId !== values.stripeDisputeId ||
    existing.amountMinor !== values.amountMinor ||
    existing.currency !== values.currency ||
    !sameInstant(existing.providerCreatedAt, values.providerCreatedAt as Date)
  ) permanentReconciliationFailure();
  const incomingUpdatedAt = values.providerUpdatedAt as Date;
  if (
    existing.status !== values.status &&
    existing.status !== 'open' &&
    values.status !== 'open'
  ) permanentReconciliationFailure();
  if (incomingUpdatedAt.getTime() < existing.providerUpdatedAt.getTime()) return existing;
  if (existing.status !== 'open' && values.status === 'open') return existing;
  if (
    sameInstant(incomingUpdatedAt, existing.providerUpdatedAt) &&
    existing.status === values.status &&
    existing.reason !== (values.reason ?? null)
  ) {
    permanentReconciliationFailure();
  }
  const [updated] = await transaction
    .update(disputes)
    .set({
      status: values.status,
      reason: values.reason,
      providerUpdatedAt: incomingUpdatedAt,
      financialEvidenceStatus: 'pending',
      updatedAt: now
    })
    .where(eq(disputes.id, existing.id))
    .returning();
  if (!updated) permanentReconciliationFailure();
  return updated;
}

function assertDisputeEvent(event: typeof stripeEvents.$inferSelect, providerDisputeId: string) {
  const descriptor = describeSupportedStripeEvent(stripeEventValue(event));
  if (
    !descriptor ||
    descriptor.objectFamily !== 'dispute' ||
    event.objectId !== providerDisputeId
  ) permanentReconciliationFailure();
}

function stateReason(
  grant: typeof entitlementGrants.$inferSelect,
  state: DisputedPurchaseGrantState,
  allocatedMinor: number,
  itemTotalMinor: number,
  disputeStates: readonly DisputeRow['status'][]
): string {
  if (grant.state === 'revoked') return grant.stateReason;
  if (state === 'revoked' && allocatedMinor === itemTotalMinor) {
    return 'refund_fully_allocated';
  }
  if (state === 'revoked' && disputeStates.includes('lost')) return 'dispute_lost';
  if (state === 'suspended') return 'dispute_open';
  return 'payment_succeeded';
}

function dominantGrantState(states: readonly DisputedPurchaseGrantState[]) {
  if (states.includes('revoked')) return 'revoked' as const;
  if (states.includes('suspended')) return 'suspended' as const;
  if (states.includes('active')) return 'active' as const;
  return 'unclaimed' as const;
}

export async function fulfillDisputeEvent(
  database: Database,
  input: DisputeFulfillmentInput,
  dependencyOverrides: DisputeFulfillmentDependencies
): Promise<void> {
  const canonicalDispute = parseDisputeSnapshot(input.dispute);
  const canonicalPayment = parsePaymentSnapshot(input.payment);
  const dependencies = {
    messages: dependencyOverrides.messages,
    storeDispute: dependencyOverrides.storeDispute ?? storeDispute,
    projectEntitlement:
      dependencyOverrides.projectEntitlement ?? defaultProjectEffectiveEntitlement,
    appendAuditEvent: dependencyOverrides.appendAuditEvent ?? defaultAppendAuditEvent,
    completeEvent: dependencyOverrides.completeEvent ?? completeCommerceEvent,
    now: dependencyOverrides.now ?? (() => new Date())
  };

  await database.transaction(async (transaction) => {
    const [event] = await transaction
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, input.stripeEventId))
      .limit(1)
      .for('update');
    if (!event) permanentReconciliationFailure();
    if (event.status !== 'pending') return;
    const now = dependencies.now();
    if (!Number.isFinite(now.getTime())) permanentReconciliationFailure();
    assertDisputeEvent(event, canonicalDispute.providerDisputeId);
    if (
      canonicalDispute.liveMode !== event.liveMode ||
      canonicalDispute.paymentIntentId !== canonicalPayment.paymentIntentId ||
      canonicalDispute.chargeId !== canonicalPayment.latestChargeId ||
      canonicalDispute.currency !== canonicalPayment.currency ||
      canonicalDispute.amountMinor > canonicalPayment.amountMinor
    ) permanentReconciliationFailure();

    const { payment, order } = await lockCanonicalPaymentOrder(
      transaction,
      canonicalPayment,
      event
    );
    const facts = await lockPaymentAccessFacts(transaction, payment, order);
    const [collision] = await transaction
      .select({ paymentId: disputes.paymentId })
      .from(disputes)
      .where(eq(disputes.stripeDisputeId, canonicalDispute.providerDisputeId))
      .limit(1);
    if (collision && collision.paymentId !== payment.id) permanentReconciliationFailure();
    const existing = facts.disputes.find(
      (dispute) => dispute.stripeDisputeId === canonicalDispute.providerDisputeId
    );
    const canonicalDisputeRow = await dependencies.storeDispute(transaction, existing, {
      paymentId: payment.id,
      stripeDisputeId: canonicalDispute.providerDisputeId,
      status: canonicalDispute.state,
      amountMinor: canonicalDispute.amountMinor,
      currency: canonicalDispute.currency.toUpperCase(),
      reason: normalizeDisputeReasonCategory(canonicalDispute.reason),
      providerCreatedAt: canonicalDispute.providerCreatedAt,
      providerUpdatedAt: new Date(Math.max(
        canonicalDispute.providerCreatedAt.getTime(),
        event.providerCreatedAt.getTime()
      )),
      financialEvidenceStatus: 'pending',
      createdAt: now,
      updatedAt: now
    }, now);

    const refundById = new Map(facts.refunds.map((refund) => [refund.id, refund]));
    const allocationsByItem = new Map<string, number>();
    for (const allocation of facts.refundAllocations) {
      if (refundById.get(allocation.refundId)?.status !== 'succeeded') continue;
      const total = (allocationsByItem.get(allocation.orderItemId) ?? 0) +
        allocation.amountMinor;
      if (!Number.isSafeInteger(total)) permanentReconciliationFailure();
      allocationsByItem.set(allocation.orderItemId, total);
    }
    const allDisputes = existing
      ? facts.disputes.map((dispute) =>
          dispute.id === canonicalDisputeRow.id ? canonicalDisputeRow : dispute
        )
      : [...facts.disputes, canonicalDisputeRow];
    const disputeStates = allDisputes.map((dispute) => dispute.status);
    const itemById = new Map(facts.orderItems.map((item) => [item.id, item]));
    const changedScopes: Array<{ userId: string; titleId: string }> = [];
    const nextStates: DisputedPurchaseGrantState[] = [];
    for (const grant of facts.grants) {
      const item = grant.orderItemId ? itemById.get(grant.orderItemId) : undefined;
      if (!item?.totalMinor) permanentReconciliationFailure();
      const allocatedMinor = allocationsByItem.get(item.id) ?? 0;
      const nextState = deriveDisputedPurchaseGrantState({
        hasUser: grant.userId !== null,
        permanentlyRevoked: grant.state === 'revoked',
        itemTotalMinor: item.totalMinor,
        succeededRefundAllocatedMinor: allocatedMinor,
        disputeStates
      });
      nextStates.push(nextState);
      assertGrantTransitionAllowed(grant, nextState, 'dispute');
      if (nextState === grant.state) continue;
      await transaction
        .update(entitlementGrants)
        .set({
          state: nextState,
          stateReason: stateReason(
            grant,
            nextState,
            allocatedMinor,
            item.totalMinor,
            disputeStates
          ),
          suspendedAt: nextState === 'suspended'
            ? (grant.suspendedAt ?? reconciliationTransitionTime(now, grant.grantedAt))
            : null,
          revokedAt: nextState === 'revoked'
            ? (grant.revokedAt ?? reconciliationTransitionTime(now, grant.grantedAt))
            : null,
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
    const accessChanged = [];
    for (const scope of uniqueScopes) {
      const projected = await dependencies.projectEntitlement(
        transaction,
        scope.userId,
        scope.titleId,
        now
      );
      if (projected.beforeActive !== projected.afterActive) accessChanged.push(scope);
    }
    const affectedTitleCount = accessChanged.length;
    const disputeState = dominantGrantState(nextStates);
    if (affectedTitleCount > 0) {
      const userIds = new Set(accessChanged.map((scope) => scope.userId));
      if (userIds.size !== 1) permanentReconciliationFailure();
      const [recipient] = await transaction
        .select({ email: user.email, emailVerified: user.emailVerified })
        .from(user)
        .where(eq(user.id, accessChanged[0]!.userId))
        .limit(1);
      if (!recipient?.emailVerified) permanentReconciliationFailure();
      let email: string;
      try {
        email = normalizeEmailAddress(recipient.email);
      } catch {
        return permanentReconciliationFailure();
      }
      await dependencies.messages.enqueueAccessChange(transaction, {
        template: 'commerce.dispute-access-changed',
        eventId: event.id,
        to: email,
        reasonCategory: disputeState === 'suspended'
          ? 'dispute_opened'
          : 'dispute_resolved',
        affectedTitleCount
      });
    }

    await dependencies.appendAuditEvent(transaction, {
      actor: { type: 'system', id: 'commerce-worker' },
      action: 'commerce.dispute_reconciled',
      outcome: 'succeeded',
      resourceType: 'stripe_event',
      resourceId: event.id,
      correlationId: `commerce-dispute-${event.id}`,
      after: { disputeState, affectedTitleCount }
    });
    await dependencies.completeEvent(transaction, event.id, 'processed', now);
  });
}
