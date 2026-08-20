import { and, asc, eq, or } from 'drizzle-orm';
import { appendAuditEvent as defaultAppendAuditEvent } from '$lib/server/audit/service';
import {
  findOrCreateGuestIdentity,
  normalizeEmailAddress
} from '$lib/server/auth/identity';
import type { Database } from '$lib/server/db/client';
import {
  entitlementGrants,
  guestIdentities,
  orderItems,
  orders,
  payments,
  stripeEvents,
  user,
  type GuestIdentityRow,
  type NewEntitlementGrantRow,
  type OrderItemRow,
  type OrderRow,
  type StripeEventRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { PermanentCommerceError } from './errors';
import {
  queueFinancialSourceFromEvent as defaultQueueFinancialSourceFromEvent
} from './financial/event-handoff';
import { projectEffectiveEntitlement as defaultProjectEffectiveEntitlement } from './grants';
import { lockEntitlementScopes, lockOrder } from './lock';
import {
  parseCheckoutSnapshot,
  parsePaymentSnapshot
} from './stripe/schemas';
import type {
  CheckoutSnapshot,
  PaymentSnapshot
} from './stripe/types';
import { describeSupportedStripeEvent } from './webhooks';

export type FulfillmentCommand =
  | {
      state: 'pending';
      orderId: string;
      session: CheckoutSnapshot;
      payment: PaymentSnapshot;
    }
  | {
      state: 'paid';
      orderId: string;
      session: CheckoutSnapshot;
      payment: PaymentSnapshot;
      purchaseEmail: string;
    }
  | {
      state: 'failed';
      orderId: string;
      session: CheckoutSnapshot;
      payment: PaymentSnapshot;
    }
  | {
      state: 'expired';
      orderId: string;
      session: CheckoutSnapshot;
    };

export interface ValidateFulfillmentInput {
  order: OrderRow;
  items: readonly OrderItemRow[];
  session: unknown;
  payment: unknown | null;
  expectedLiveMode: boolean;
}

function permanent(): never {
  throw new PermanentCommerceError();
}

function normalizeEmail(value: string): string {
  try {
    return normalizeEmailAddress(value);
  } catch (error) {
    throw new PermanentCommerceError({ cause: error });
  }
}

function validateLocalAndLineEvidence(
  order: OrderRow,
  items: readonly OrderItemRow[],
  session: CheckoutSnapshot
): void {
  if (
    session.providerSessionId !== order.stripeCheckoutSessionId &&
    order.stripeCheckoutSessionId !== null
  ) permanent();
  if (
    order.stripeCheckoutSessionId === null &&
    (order.status !== 'checkout_pending' || order.checkoutExpiresAt !== null)
  ) permanent();
  if (
    order.stripeCheckoutSessionId !== null &&
    order.checkoutExpiresAt?.getTime() !== session.expiresAt.getTime()
  ) permanent();
  if (
    session.clientReferenceId !== order.id ||
    session.metadataVersion !== '1' ||
    session.metadataOrderId !== order.id ||
    session.mode !== 'payment' ||
    session.currency.toUpperCase() !== order.currency ||
    session.subtotalMinor !== order.subtotalMinor ||
    items.length !== session.lineItems.length ||
    items.length === 0
  ) permanent();

  const localItems = new Map(items.map((item) => [item.id, item]));
  if (localItems.size !== items.length) permanent();
  for (const line of session.lineItems) {
    const item = localItems.get(line.orderItemId);
    if (
      !item ||
      item.orderId !== order.id ||
      line.quantity !== 1 ||
      line.currency.toUpperCase() !== item.currency ||
      line.subtotalMinor !== item.unitSubtotalMinor ||
      (item.stripeLineItemId !== null && item.stripeLineItemId !== line.providerLineItemId) ||
      (item.taxMinor !== null && item.taxMinor !== line.taxMinor) ||
      (item.totalMinor !== null && item.totalMinor !== line.totalMinor)
    ) permanent();
  }
  if (
    (order.taxMinor !== null && order.taxMinor !== session.taxMinor) ||
    (order.totalMinor !== null && order.totalMinor !== session.totalMinor)
  ) permanent();
}

function paidPurchaseEmail(order: OrderRow, session: CheckoutSnapshot): string {
  if (order.initiatingUserId !== null) {
    if (!order.purchaseEmail || !session.customerEmail) return permanent();
    const stored = normalizeEmail(order.purchaseEmail);
    if (normalizeEmail(session.customerEmail) !== stored) return permanent();
    return stored;
  }
  if (!session.customerEmail) return permanent();
  const canonical = normalizeEmail(session.customerEmail);
  if (order.purchaseEmail !== null && normalizeEmail(order.purchaseEmail) !== canonical) {
    return permanent();
  }
  return canonical;
}

export function validateFulfillmentCommand(input: ValidateFulfillmentInput): FulfillmentCommand {
  const session = parseCheckoutSnapshot(input.session);
  if (session.liveMode !== input.expectedLiveMode) return permanent();
  validateLocalAndLineEvidence(input.order, input.items, session);
  if (session.paymentStatus === 'no_payment_required') return permanent();

  if (session.status === 'expired') {
    if (session.paymentStatus !== 'unpaid') return permanent();
    return { state: 'expired', orderId: input.order.id, session };
  }
  if (session.status !== 'complete' || !session.paymentIntentId || input.payment === null) {
    return permanent();
  }

  const payment = parsePaymentSnapshot(input.payment);
  if (
    payment.liveMode !== input.expectedLiveMode ||
    payment.paymentIntentId !== session.paymentIntentId ||
    payment.metadataVersion !== '1' ||
    payment.metadataOrderId !== input.order.id ||
    payment.latestChargeId !== session.latestChargeId ||
    payment.currency.toUpperCase() !== input.order.currency ||
    payment.currency !== session.currency ||
    payment.amountMinor !== session.totalMinor
  ) permanent();

  if (session.paymentStatus === 'paid' && payment.state === 'succeeded') {
    return {
      state: 'paid',
      orderId: input.order.id,
      session,
      payment,
      purchaseEmail: paidPurchaseEmail(input.order, session)
    };
  }
  if (session.paymentStatus === 'unpaid' && payment.state === 'pending') {
    return { state: 'pending', orderId: input.order.id, session, payment };
  }
  if (session.paymentStatus === 'unpaid' && payment.state === 'failed') {
    return { state: 'failed', orderId: input.order.id, session, payment };
  }
  return permanent();
}

export interface PaidFulfillmentOwnership {
  guestIdentityId: string | null;
  grantUserId: string | null;
  message: 'account-receipt' | 'guest-claim-preparation' | 'guest-receipt-without-claim';
}

interface VerifiedClaimant {
  id: string;
  email: string;
  emailVerified: boolean;
}

export function resolvePaidFulfillmentOwnership(
  order: OrderRow,
  purchaseEmail: string,
  guestIdentity: GuestIdentityRow | undefined,
  claimant: VerifiedClaimant | undefined
): PaidFulfillmentOwnership {
  if (order.initiatingUserId !== null) {
    if (guestIdentity || claimant) permanent();
    return {
      guestIdentityId: order.guestIdentityId,
      grantUserId: order.initiatingUserId,
      message: 'account-receipt'
    };
  }
  if (
    !guestIdentity ||
    guestIdentity.email !== purchaseEmail ||
    (order.guestIdentityId !== null && order.guestIdentityId !== guestIdentity.id)
  ) permanent();
  const claimedByUserId = guestIdentity.claimedByUserId;
  if (claimedByUserId === null) {
    if (claimant) permanent();
    return {
      guestIdentityId: guestIdentity.id,
      grantUserId: null,
      message: 'guest-claim-preparation'
    };
  }
  if (
    !claimant ||
    claimant.id !== claimedByUserId ||
    !claimant.emailVerified ||
    claimant.email !== guestIdentity.email ||
    normalizeEmail(claimant.email) !== guestIdentity.email
  ) permanent();
  return {
    guestIdentityId: guestIdentity.id,
    grantUserId: claimant.id,
    message: 'guest-receipt-without-claim'
  };
}

export interface PurchaseMessageEnqueuer {
  enqueueAccountReceipt(transaction: DatabaseTransaction, orderId: string): Promise<void>;
  enqueueGuestReceiptWithoutClaim(
    transaction: DatabaseTransaction,
    orderId: string
  ): Promise<void>;
  enqueueGuestClaimPreparation(
    transaction: DatabaseTransaction,
    orderId: string
  ): Promise<void>;
}

export interface CheckoutFulfillmentInput {
  stripeEventId: string;
  session: unknown;
  payment: unknown | null;
}

export interface FulfillmentExceptionInput {
  stripeEventId: string;
  orderId: string | null;
}

type AppendAuditEvent = typeof defaultAppendAuditEvent;
type ProjectEntitlement = typeof defaultProjectEffectiveEntitlement;
type QueueFinancialSourceFromEvent = typeof defaultQueueFinancialSourceFromEvent;

export interface CheckoutFulfillmentDependencies {
  purchaseMessages: PurchaseMessageEnqueuer;
  createPurchaseGrant?: (
    transaction: DatabaseTransaction,
    grant: NewEntitlementGrantRow
  ) => Promise<void>;
  projectEntitlement?: ProjectEntitlement;
  appendAuditEvent?: AppendAuditEvent;
  queueFinancialSourceFromEvent?: QueueFinancialSourceFromEvent;
  completeStripeEvent?: (
    transaction: DatabaseTransaction,
    stripeEventId: string,
    now: Date
  ) => Promise<void>;
  now?: () => Date;
}

async function createPurchaseGrant(
  transaction: DatabaseTransaction,
  grant: NewEntitlementGrantRow
): Promise<void> {
  await transaction
    .insert(entitlementGrants)
    .values(grant);
}

async function completeStripeEvent(
  transaction: DatabaseTransaction,
  stripeEventId: string,
  now: Date
): Promise<void> {
  const [completed] = await transaction
    .update(stripeEvents)
    .set({ status: 'processed', processedAt: now, updatedAt: now })
    .where(and(eq(stripeEvents.id, stripeEventId), eq(stripeEvents.status, 'pending')))
    .returning({ id: stripeEvents.id });
  if (!completed) throw new PermanentCommerceError();
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

function assertCheckoutEvent(row: StripeEventRow, session: CheckoutSnapshot): void {
  const descriptor = describeSupportedStripeEvent(eventValue(row));
  if (
    !descriptor ||
    descriptor.objectFamily !== 'checkout_session' ||
    row.objectId !== session.providerSessionId
  ) permanent();
}

function assertExistingPayment(
  existing: typeof payments.$inferSelect,
  command: Extract<FulfillmentCommand, { state: 'pending' | 'paid' | 'failed' }>
): void {
  if (
    existing.orderId !== command.orderId ||
    existing.stripePaymentIntentId !== command.payment.paymentIntentId ||
    existing.amountMinor !== command.payment.amountMinor ||
    existing.currency !== command.payment.currency.toUpperCase()
  ) permanent();
}

function assertSucceededPayment(
  existing: typeof payments.$inferSelect,
  command: Extract<FulfillmentCommand, { state: 'paid' }>
): void {
  assertExistingPayment(existing, command);
  if (
    existing.status !== 'succeeded' ||
    existing.stripeLatestChargeId !== command.payment.latestChargeId ||
    existing.paidAt?.getTime() !== command.payment.paidAt?.getTime() ||
    existing.paymentMethodCategory !== command.payment.paymentMethodCategory
  ) permanent();
}

async function storePaymentEvidence(
  transaction: DatabaseTransaction,
  existing: typeof payments.$inferSelect | undefined,
  command: Extract<FulfillmentCommand, { state: 'pending' | 'paid' | 'failed' }>,
  now: Date
): Promise<typeof payments.$inferSelect> {
  if (existing) assertExistingPayment(existing, command);
  const paid = command.state === 'paid';
  const failed = command.state === 'failed';
  if (!existing) {
    const [inserted] = await transaction.insert(payments).values({
      orderId: command.orderId,
      stripePaymentIntentId: command.payment.paymentIntentId,
      stripeLatestChargeId: command.payment.latestChargeId,
      status: paid ? 'succeeded' : failed ? 'failed' : 'pending',
      amountMinor: command.payment.amountMinor,
      currency: command.payment.currency.toUpperCase(),
      paymentMethodCategory: command.payment.paymentMethodCategory,
      paidAt: paid ? command.payment.paidAt : null,
      financialEvidenceStatus: 'pending',
      updatedAt: now
    }).returning();
    if (!inserted) permanent();
    return inserted;
  }
  if (existing.status === 'succeeded') {
    if (command.state !== 'paid') permanent();
    assertSucceededPayment(existing, command);
    return existing;
  }
  if (!paid) {
    const [updated] = await transaction
      .update(payments)
      .set({
        stripeLatestChargeId: command.payment.latestChargeId,
        status: existing.status === 'failed' || failed ? 'failed' : 'pending',
        paymentMethodCategory: command.payment.paymentMethodCategory,
        paidAt: null,
        financialEvidenceStatus: 'pending',
        updatedAt: now
      })
      .where(eq(payments.id, existing.id))
      .returning();
    if (!updated) permanent();
    return updated;
  }
  const [updated] = await transaction
    .update(payments)
    .set({
      stripeLatestChargeId: command.payment.latestChargeId,
      status: 'succeeded',
      paymentMethodCategory: command.payment.paymentMethodCategory,
      paidAt: command.payment.paidAt,
      financialEvidenceStatus: 'pending',
      updatedAt: now
    })
    .where(eq(payments.id, existing.id))
    .returning();
  if (!updated) permanent();
  return updated;
}

async function assertPurchaseGrant(
  transaction: DatabaseTransaction,
  expected: NewEntitlementGrantRow
): Promise<void> {
  const [stored] = await transaction
    .select()
    .from(entitlementGrants)
    .where(eq(entitlementGrants.orderItemId, expected.orderItemId!))
    .limit(1)
    .for('update');
  if (
    !stored ||
    stored.source !== 'purchase' ||
    stored.titleId !== expected.titleId ||
    stored.userId !== (expected.userId ?? null) ||
    stored.state !== expected.state ||
    stored.stateReason !== expected.stateReason
  ) permanent();
}

async function discoverAndLockPaidGuestIdentity(
  transaction: DatabaseTransaction,
  session: CheckoutSnapshot,
  payment: unknown | null,
  expectedLiveMode: boolean
): Promise<GuestIdentityRow | undefined> {
  const [candidateOrder] = await transaction
    .select()
    .from(orders)
    .where(eq(orders.id, session.metadataOrderId))
    .limit(1);
  if (!candidateOrder) permanent();
  if (candidateOrder.initiatingUserId !== null || session.paymentStatus !== 'paid') {
    return undefined;
  }
  const candidateItems = await transaction
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, candidateOrder.id))
    .orderBy(asc(orderItems.id));
  const candidateCommand = validateFulfillmentCommand({
    order: candidateOrder,
    items: candidateItems,
    session,
    payment,
    expectedLiveMode
  });
  if (candidateCommand.state !== 'paid') permanent();
  const discovered = await findOrCreateGuestIdentity(
    transaction,
    candidateCommand.purchaseEmail
  );
  const [lockedIdentity] = await transaction
    .select()
    .from(guestIdentities)
    .where(eq(guestIdentities.id, discovered.id))
    .limit(1)
    .for('update');
  if (!lockedIdentity || lockedIdentity.email !== candidateCommand.purchaseEmail) permanent();
  return lockedIdentity;
}

async function finalizePaidOrder(
  transaction: DatabaseTransaction,
  order: OrderRow,
  items: readonly OrderItemRow[],
  command: Extract<FulfillmentCommand, { state: 'paid' }>,
  dependencies: Required<Pick<
    CheckoutFulfillmentDependencies,
    'purchaseMessages' | 'createPurchaseGrant' | 'projectEntitlement' | 'appendAuditEvent'
  >>,
  ownership: PaidFulfillmentOwnership,
  now: Date
): Promise<void> {
  for (const line of command.session.lineItems) {
    const item = items.find((candidate) => candidate.id === line.orderItemId);
    if (!item) permanent();
    await transaction
      .update(orderItems)
      .set({
        taxMinor: line.taxMinor,
        totalMinor: line.totalMinor,
        stripeLineItemId: line.providerLineItemId
      })
      .where(eq(orderItems.id, item.id));
  }
  await transaction
    .update(orders)
    .set({
      status: 'paid',
      guestIdentityId: ownership.guestIdentityId,
      purchaseEmail: command.purchaseEmail,
      taxMinor: command.session.taxMinor,
      totalMinor: command.session.totalMinor,
      stripeCheckoutSessionId: command.session.providerSessionId,
      checkoutExpiresAt: command.session.expiresAt,
      paidAt: command.payment.paidAt,
      updatedAt: now
    })
    .where(eq(orders.id, order.id));

  const grantState = ownership.grantUserId === null ? 'unclaimed' : 'active';
  for (const item of items) {
    const grant: NewEntitlementGrantRow = {
      titleId: item.titleId,
      userId: ownership.grantUserId,
      source: 'purchase',
      orderItemId: item.id,
      state: grantState,
      stateReason: 'payment_succeeded',
      grantedAt: command.payment.paidAt!,
      createdAt: now,
      updatedAt: now
    };
    await dependencies.createPurchaseGrant(transaction, grant);
    await assertPurchaseGrant(transaction, grant);
  }
  if (ownership.grantUserId !== null) {
    for (const item of items) {
      await dependencies.projectEntitlement(
        transaction,
        ownership.grantUserId,
        item.titleId,
        now
      );
    }
  }
  if (ownership.message === 'account-receipt') {
    await dependencies.purchaseMessages.enqueueAccountReceipt(transaction, order.id);
  } else if (ownership.message === 'guest-receipt-without-claim') {
    await dependencies.purchaseMessages.enqueueGuestReceiptWithoutClaim(transaction, order.id);
  } else {
    await dependencies.purchaseMessages.enqueueGuestClaimPreparation(transaction, order.id);
  }
  await dependencies.appendAuditEvent(transaction, {
    actor: { type: 'system', id: 'commerce-worker' },
    action: 'commerce.fulfillment_paid',
    outcome: 'succeeded',
    resourceType: 'order',
    resourceId: order.id,
    correlationId: `commerce-fulfillment-${order.id}`,
    after: {
      orderId: order.id,
      itemCount: items.length,
      currency: command.session.currency.toUpperCase(),
      subtotalMinor: command.session.subtotalMinor,
      taxMinor: command.session.taxMinor,
      totalMinor: command.session.totalMinor,
      ownerType: ownership.grantUserId === null ? 'guest' : 'account'
    }
  });
}

export async function fulfillCheckoutEvent(
  database: Database,
  input: CheckoutFulfillmentInput,
  dependencyOverrides: CheckoutFulfillmentDependencies
): Promise<void> {
  const session = parseCheckoutSnapshot(input.session);
  const dependencies = {
    purchaseMessages: dependencyOverrides.purchaseMessages,
    createPurchaseGrant: dependencyOverrides.createPurchaseGrant ?? createPurchaseGrant,
    projectEntitlement:
      dependencyOverrides.projectEntitlement ?? defaultProjectEffectiveEntitlement,
    appendAuditEvent: dependencyOverrides.appendAuditEvent ?? defaultAppendAuditEvent,
    queueFinancialSourceFromEvent:
      dependencyOverrides.queueFinancialSourceFromEvent ?? defaultQueueFinancialSourceFromEvent,
    completeStripeEvent: dependencyOverrides.completeStripeEvent ?? completeStripeEvent,
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
    assertCheckoutEvent(event, session);

    const lockedGuestIdentity = await discoverAndLockPaidGuestIdentity(
      transaction,
      session,
      input.payment,
      event.liveMode
    );
    await lockOrder(transaction, session.metadataOrderId);
    const [order] = await transaction
      .select()
      .from(orders)
      .where(eq(orders.id, session.metadataOrderId))
      .limit(1)
      .for('update');
    if (!order) permanent();
    const lockedPayments = await transaction
      .select()
      .from(payments)
      .where(session.paymentIntentId === null
        ? eq(payments.orderId, order.id)
        : or(
            eq(payments.orderId, order.id),
            eq(payments.stripePaymentIntentId, session.paymentIntentId)
          ))
      .orderBy(asc(payments.id))
      .for('update');
    if (lockedPayments.length > 1) permanent();
    const existingPayment = lockedPayments[0];
    if (
      existingPayment &&
      (existingPayment.orderId !== order.id ||
        (session.paymentIntentId !== null &&
          existingPayment.stripePaymentIntentId !== session.paymentIntentId))
    ) permanent();
    const items = await transaction
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.id))
      .for('update');
    if (order.initiatingUserId !== null) {
      await lockEntitlementScopes(
        transaction,
        items.map((item) => ({ userId: order.initiatingUserId!, titleId: item.titleId }))
      );
    }

    const command = validateFulfillmentCommand({
      order,
      items,
      session,
      payment: input.payment,
      expectedLiveMode: event.liveMode
    });
    const now = dependencies.now();
    let paidOwnership: PaidFulfillmentOwnership | undefined;
    if (command.state === 'paid') {
      let claimant: VerifiedClaimant | undefined;
      if (order.initiatingUserId === null) {
        if (!lockedGuestIdentity || lockedGuestIdentity.email !== command.purchaseEmail) {
          permanent();
        }
        const claimedByUserId = lockedGuestIdentity.claimedByUserId;
        if (claimedByUserId !== null) {
          await lockEntitlementScopes(
            transaction,
            items.map((item) => ({ userId: claimedByUserId, titleId: item.titleId }))
          );
          const [lockedClaimant] = await transaction
            .select({ id: user.id, email: user.email, emailVerified: user.emailVerified })
            .from(user)
            .where(eq(user.id, claimedByUserId))
            .limit(1)
            .for('update');
          claimant = lockedClaimant;
        }
      }
      paidOwnership = resolvePaidFulfillmentOwnership(
        order,
        command.purchaseEmail,
        lockedGuestIdentity,
        claimant
      );
    }

    if (order.status === 'paid') {
      if (command.state === 'paid') {
        if (!existingPayment) permanent();
        assertSucceededPayment(existingPayment, command);
      }
      if (existingPayment) {
        await dependencies.queueFinancialSourceFromEvent(transaction, {
          sourceKind: 'payment',
          sourceId: existingPayment.id,
          providerEventId: event.providerEventId,
          projectionGraphSourceIds: []
        });
      }
      await dependencies.completeStripeEvent(transaction, event.id, now);
      return;
    }
    if (order.status === 'expired') {
      if (command.state !== 'expired') permanent();
      await dependencies.completeStripeEvent(transaction, event.id, now);
      return;
    }
    if (order.status === 'exception') permanent();

    let paymentFact: typeof payments.$inferSelect | undefined;
    if (command.state === 'pending') {
      paymentFact = await storePaymentEvidence(transaction, existingPayment, command, now);
      if (order.status === 'checkout_pending' || order.status === 'checkout_open') {
        await transaction.update(orders).set({
          status: 'payment_pending',
          stripeCheckoutSessionId: command.session.providerSessionId,
          checkoutExpiresAt: command.session.expiresAt,
          updatedAt: now
        }).where(eq(orders.id, order.id));
      }
    } else if (command.state === 'paid') {
      if (!paidOwnership) permanent();
      paymentFact = await storePaymentEvidence(transaction, existingPayment, command, now);
      await finalizePaidOrder(
        transaction,
        order,
        items,
        command,
        dependencies,
        paidOwnership,
        now
      );
    } else if (command.state === 'failed') {
      paymentFact = await storePaymentEvidence(transaction, existingPayment, command, now);
      if (['checkout_pending', 'checkout_open', 'payment_pending'].includes(order.status)) {
        await transaction.update(orders).set({
          status: 'failed',
          stripeCheckoutSessionId: command.session.providerSessionId,
          checkoutExpiresAt: command.session.expiresAt,
          updatedAt: now
        }).where(eq(orders.id, order.id));
      }
    } else if ([
      'checkout_pending', 'checkout_open', 'payment_pending', 'failed'
    ].includes(order.status)) {
      await transaction.update(orders).set({
        status: 'expired',
        stripeCheckoutSessionId: command.session.providerSessionId,
        checkoutExpiresAt: command.session.expiresAt,
        updatedAt: now
      }).where(eq(orders.id, order.id));
    }
    if (paymentFact) {
      const projectionGraphPublished = existingPayment === undefined ||
        existingPayment.status !== paymentFact.status ||
        existingPayment.stripeLatestChargeId !== paymentFact.stripeLatestChargeId ||
        existingPayment.paidAt?.getTime() !== paymentFact.paidAt?.getTime() ||
        command.state === 'paid';
      await dependencies.queueFinancialSourceFromEvent(transaction, {
        sourceKind: 'payment',
        sourceId: paymentFact.id,
        providerEventId: event.providerEventId,
        projectionGraphSourceIds: projectionGraphPublished ? [paymentFact.id] : []
      });
    }
    await dependencies.completeStripeEvent(transaction, event.id, now);
  });
}

async function findExceptionOrder(
  transaction: DatabaseTransaction,
  event: StripeEventRow,
  requestedOrderId: string | null
): Promise<OrderRow | null> {
  const [attached] = await transaction
    .select()
    .from(orders)
    .where(eq(orders.stripeCheckoutSessionId, event.objectId))
    .limit(1);
  const candidateId = attached?.id ?? requestedOrderId;
  if (!candidateId) return null;
  await lockOrder(transaction, candidateId);
  const [candidate] = await transaction
    .select()
    .from(orders)
    .where(eq(orders.id, candidateId))
    .limit(1)
    .for('update');
  if (!candidate) return null;
  if (candidate.stripeCheckoutSessionId === event.objectId) return candidate;
  if (
    attached === undefined &&
    candidate.id === requestedOrderId &&
    candidate.stripeCheckoutSessionId === null &&
    candidate.status === 'checkout_pending'
  ) return candidate;
  return null;
}

export async function recordFulfillmentException(
  database: Database,
  input: FulfillmentExceptionInput,
  appendAuditEvent: AppendAuditEvent = defaultAppendAuditEvent,
  now = new Date()
): Promise<void> {
  await database.transaction(async (transaction) => {
    const [event] = await transaction
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, input.stripeEventId))
      .limit(1)
      .for('update');
    if (!event || event.status !== 'pending') return;
    const order = await findExceptionOrder(transaction, event, input.orderId);
    if (order && order.status !== 'paid' && order.status !== 'expired') {
      await transaction
        .update(orders)
        .set({ status: 'exception', updatedAt: now })
        .where(eq(orders.id, order.id));
    }
    await appendAuditEvent(transaction, {
      actor: { type: 'system', id: 'commerce-worker' },
      action: 'commerce.fulfillment_exception',
      outcome: 'failed',
      resourceType: order ? 'order' : 'stripe_event',
      resourceId: order?.id ?? event.id,
      correlationId: `commerce-exception-${event.id}`,
      after: {
        category: 'canonical_mismatch',
        hadAssociatedOrder: order !== null
      }
    });
    const [completed] = await transaction
      .update(stripeEvents)
      .set({ status: 'exception', processedAt: now, updatedAt: now })
      .where(and(eq(stripeEvents.id, event.id), eq(stripeEvents.status, 'pending')))
      .returning({ id: stripeEvents.id });
    if (!completed) permanent();
  });
}
