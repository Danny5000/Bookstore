import { createHash, randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import {
  auditEvents,
  disputes,
  orderItems,
  orders,
  payments,
  refunds,
  stripeEvents,
  type OrderItemRow,
  type OrderRow,
  type PaymentRow,
  type RefundRow
} from '$lib/server/db/schema';
import { fulfillDisputeEvent } from '$lib/server/commerce/disputes';
import { createCommerceMessageEnqueuer } from '$lib/server/commerce/email/enqueue';
import {
  fulfillCheckoutEvent,
  recordFulfillmentException
} from '$lib/server/commerce/fulfillment';
import {
  createStripeEventHandler,
  defaultLoadStripeEvent,
  fulfillPayoutEvent
} from '$lib/server/commerce/handler';
import {
  STRIPE_EVENT_JOB,
  createStripeEventJobPayload
} from '$lib/server/commerce/job';
import { fulfillRefundEvent } from '$lib/server/commerce/refunds';
import { createFixtureStripeGateway } from '$lib/server/commerce/stripe/fixture-gateway';
import type {
  CheckoutSnapshot,
  DisputeSnapshot,
  PaymentSnapshot,
  RefundSnapshot,
  VerifiedStripeEvent
} from '$lib/server/commerce/stripe/types';
import { acceptStripeEvent } from '$lib/server/commerce/webhooks';
import type { JobRecord } from '$lib/server/jobs/types';
import type { E2EDatabase } from './database';

type CheckoutState = 'paid' | 'pending' | 'failed' | 'expired';

interface CheckoutFulfillmentOptions {
  state: CheckoutState;
  email: string;
  eventId?: string;
}

interface RefundOptions {
  amountMinor?: number;
  providerRefundId?: string;
  providerCreatedAt?: Date;
  eventId?: string;
}

interface DisputeOptions {
  state: 'open' | 'won' | 'lost';
  providerDisputeId?: string;
  providerCreatedAt?: Date;
  reason?: string | null;
  eventId?: string;
}

export interface DisputeReference {
  providerDisputeId: string;
  providerCreatedAt: Date;
}

export interface CommerceHarnessOptions {
  /**
   * Prevent this in-process fixture gateway from handing provider-backed financial work to the
   * separately spawned E2E worker. Financial E2E fixtures publish their worker-owned facts later.
   */
  readonly financialE2EMode?: true;
}

export interface RefundReviewReference {
  readonly order: OrderRow;
  readonly items: readonly OrderItemRow[];
  readonly payment: PaymentRow;
  readonly refund: RefundRow;
  readonly privateProviderValues: readonly string[];
}

function compact(value: string): string {
  return value.replaceAll('-', '');
}

function providerId(prefix: string, value: string): string {
  return `${prefix}_test_${compact(value)}`;
}

function eventJob(stripeEventId: string): JobRecord {
  return {
    id: randomUUID(),
    type: STRIPE_EVENT_JOB,
    payload: createStripeEventJobPayload(stripeEventId),
    deduplicationKey: `stripe:event:${stripeEventId}`,
    attempts: 1,
    maxAttempts: 8,
    lockedBy: 'playwright-fixture'
  };
}

export function createCommerceHarness(
  database: E2EDatabase,
  applicationOrigin: string,
  options: CommerceHarnessOptions = {}
) {
  const fixture = createFixtureStripeGateway();
  const suppressFinancialHandoff = options.financialE2EMode === true;
  const registeredEvents = new Map<
    string,
    {
      type: VerifiedStripeEvent['type'];
      objectId: string;
      rawBody: Uint8Array;
      signature: string;
      event: VerifiedStripeEvent;
    }
  >();
  const messages = createCommerceMessageEnqueuer(applicationOrigin);
  const handler = createStripeEventHandler(database.workerDb, fixture.gateway, {
    loadStripeEvent: defaultLoadStripeEvent,
    fulfillCheckout: (selectedDatabase, input) =>
      fulfillCheckoutEvent(selectedDatabase, input, {
        purchaseMessages: messages,
        ...(suppressFinancialHandoff
          ? { queueFinancialSourceFromEvent: async () => undefined }
          : {})
      }),
    fulfillRefund: (selectedDatabase, input) =>
      fulfillRefundEvent(selectedDatabase, input, {
        messages,
        ...(suppressFinancialHandoff
          ? { queueFinancialSource: async () => undefined }
          : {})
      }),
    fulfillDispute: (selectedDatabase, input) =>
      fulfillDisputeEvent(selectedDatabase, input, {
        messages,
        ...(suppressFinancialHandoff
          ? { queueFinancialSource: async () => undefined }
          : {})
      }),
    fulfillPayout: (selectedDatabase, input) =>
      fulfillPayoutEvent(
        selectedDatabase,
        input,
        suppressFinancialHandoff
          ? { queueFinancialPayout: async () => undefined }
          : {}
      ),
    recordException: (selectedDatabase, input) =>
      recordFulfillmentException(selectedDatabase, input)
  });

  async function orderFacts(orderId: string): Promise<{
    order: OrderRow;
    items: OrderItemRow[];
  }> {
    const [order] = await database.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) throw new Error('E2E order was not found');
    const items = await database.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.id));
    if (items.length === 0) throw new Error('E2E order has no items');
    return { order, items };
  }

  async function paymentFact(orderId: string): Promise<PaymentRow> {
    const [payment] = await database.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .limit(1);
    if (!payment) throw new Error('E2E payment was not found');
    return payment;
  }

  function canonicalPayment(payment: PaymentRow): PaymentSnapshot {
    if (
      payment.status !== 'succeeded' ||
      !payment.stripeLatestChargeId ||
      !payment.paidAt ||
      !payment.paymentMethodCategory
    )
      throw new Error('E2E payment is not canonically paid');
    return {
      paymentIntentId: payment.stripePaymentIntentId,
      metadataVersion: '1',
      metadataOrderId: payment.orderId,
      latestChargeId: payment.stripeLatestChargeId,
      liveMode: false,
      state: 'succeeded',
      amountMinor: payment.amountMinor,
      currency: payment.currency.toLowerCase(),
      paidAt: payment.paidAt,
      paymentMethodCategory: payment.paymentMethodCategory
    };
  }

  async function processEvent(
    type: VerifiedStripeEvent['type'],
    objectId: string,
    requestedEventId?: string
  ): Promise<string> {
    const eventId = requestedEventId ?? providerId('evt', randomUUID());
    const registered = registeredEvents.get(eventId);
    if (
      registered &&
      (registered.type !== type || registered.objectId !== objectId)
    ) {
      throw new Error('E2E event ID was reused for different immutable facts');
    }
    const rawBody =
      registered?.rawBody ??
      new TextEncoder().encode(JSON.stringify({ id: eventId, type, objectId }));
    const signature = registered?.signature ?? `fixture-signature-${eventId}`;
    const event: VerifiedStripeEvent = registered?.event ?? {
      providerEventId: eventId,
      type,
      objectId,
      liveMode: false,
      apiVersion: '2026-07-29.dahlia',
      providerCreatedAt: new Date(),
      rawBodySha256: createHash('sha256').update(rawBody).digest('hex')
    };
    if (!registered) {
      registeredEvents.set(eventId, {
        type,
        objectId,
        rawBody,
        signature,
        event
      });
    }
    fixture.harness.setWebhook(rawBody, signature, event);
    const verified = fixture.gateway.verifyWebhook(rawBody, signature);
    const accepted = await acceptStripeEvent(database.db, verified, {
      enqueueJob: async () => undefined as never
    });
    if (accepted.status === 'conflict') throw new Error('E2E event conflicted');
    await handler(
      eventJob(accepted.stripeEventId),
      new AbortController().signal
    );
    return accepted.stripeEventId;
  }

  async function fulfillCheckout(
    orderId: string,
    options: CheckoutFulfillmentOptions
  ): Promise<void> {
    const { order, items } = await orderFacts(orderId);
    if (!order.stripeCheckoutSessionId || !order.checkoutExpiresAt) {
      throw new Error('E2E order has no hosted Checkout session');
    }
    const paymentIntentId = providerId('pi', order.id);
    const chargeId = providerId('ch', order.id);
    const isPaid = options.state === 'paid';
    const isExpired = options.state === 'expired';
    const paymentState =
      options.state === 'pending'
        ? 'pending'
        : options.state === 'failed'
          ? 'failed'
          : 'succeeded';
    const session: CheckoutSnapshot = {
      providerSessionId: order.stripeCheckoutSessionId,
      clientReferenceId: order.id,
      metadataVersion: '1',
      metadataOrderId: order.id,
      liveMode: false,
      mode: 'payment',
      status: isExpired ? 'expired' : 'complete',
      paymentStatus: isPaid ? 'paid' : 'unpaid',
      paymentIntentId: isExpired ? null : paymentIntentId,
      latestChargeId: isExpired ? null : chargeId,
      customerEmail: options.email,
      currency: order.currency.toLowerCase(),
      subtotalMinor: order.subtotalMinor,
      taxMinor: 0,
      totalMinor: order.subtotalMinor,
      expiresAt: order.checkoutExpiresAt,
      lineItems: items.map((item) => ({
        providerLineItemId: providerId('li', item.id),
        orderItemId: item.id,
        quantity: 1,
        currency: item.currency.toLowerCase(),
        subtotalMinor: item.unitSubtotalMinor,
        taxMinor: 0,
        totalMinor: item.unitSubtotalMinor
      }))
    };
    fixture.harness.setCheckout(session);
    if (!isExpired) {
      fixture.harness.setPayment({
        paymentIntentId,
        metadataVersion: '1',
        metadataOrderId: order.id,
        latestChargeId: chargeId,
        liveMode: false,
        state: paymentState,
        amountMinor: order.subtotalMinor,
        currency: order.currency.toLowerCase(),
        paidAt: isPaid ? new Date() : null,
        paymentMethodCategory: 'card'
      } satisfies PaymentSnapshot);
    }
    const eventType =
      options.state === 'paid' && order.status === 'payment_pending'
        ? 'checkout.session.async_payment_succeeded'
        : options.state === 'failed'
          ? 'checkout.session.async_payment_failed'
          : options.state === 'expired'
            ? 'checkout.session.expired'
            : 'checkout.session.completed';
    await processEvent(eventType, session.providerSessionId, options.eventId);
  }

  async function fulfillRefund(
    orderId: string,
    options: RefundOptions = {}
  ): Promise<string> {
    const payment = await paymentFact(orderId);
    const canonical = canonicalPayment(payment);
    const providerRefundId =
      options.providerRefundId ?? providerId('re', randomUUID());
    const refund: RefundSnapshot = {
      providerRefundId,
      paymentIntentId: payment.stripePaymentIntentId,
      liveMode: false,
      state: 'succeeded',
      amountMinor: options.amountMinor ?? payment.amountMinor,
      currency: payment.currency.toLowerCase(),
      reason: 'requested_by_customer',
      providerCreatedAt: options.providerCreatedAt ?? new Date(),
      balanceTransactionId: null,
      failureBalanceTransactionId: null
    };
    fixture.harness.setPayment(canonical);
    fixture.harness.setRefund(refund);
    await processEvent('refund.updated', providerRefundId, options.eventId);
    return providerRefundId;
  }

  async function refundReviewReference(
    orderId: string,
    providerRefundId: string
  ): Promise<RefundReviewReference> {
    const { order, items } = await orderFacts(orderId);
    const payment = await paymentFact(orderId);
    const [refund] = await database.db
      .select()
      .from(refunds)
      .where(eq(refunds.stripeRefundId, providerRefundId))
      .limit(1);
    if (!refund || refund.paymentId !== payment.id) {
      throw new Error(
        'E2E refund review reference did not match the requested order'
      );
    }
    return {
      order,
      items,
      payment,
      refund,
      privateProviderValues: [
        order.stripeCheckoutSessionId,
        payment.stripePaymentIntentId,
        payment.stripeLatestChargeId,
        refund.stripeRefundId,
        ...items.map((item) => item.stripeLineItemId)
      ].filter((value): value is string => value !== null)
    };
  }

  async function fulfillDispute(
    orderId: string,
    options: DisputeOptions
  ): Promise<DisputeReference> {
    const payment = await paymentFact(orderId);
    const canonical = canonicalPayment(payment);
    const providerDisputeId =
      options.providerDisputeId ?? providerId('dp', randomUUID());
    const providerCreatedAt = options.providerCreatedAt ?? new Date();
    const dispute: DisputeSnapshot = {
      providerDisputeId,
      paymentIntentId: payment.stripePaymentIntentId,
      chargeId: canonical.latestChargeId!,
      liveMode: false,
      state: options.state,
      amountMinor: payment.amountMinor,
      currency: payment.currency.toLowerCase(),
      reason: options.reason ?? 'fraudulent',
      providerCreatedAt,
      balanceTransactionIds: []
    };
    fixture.harness.setPayment(canonical);
    fixture.harness.setDispute(dispute);
    await processEvent(
      options.state === 'open'
        ? 'charge.dispute.created'
        : 'charge.dispute.closed',
      providerDisputeId,
      options.eventId
    );
    return { providerDisputeId, providerCreatedAt };
  }

  return {
    fulfillCheckout,
    fulfillRefund,
    fulfillDispute,
    refundReviewReference,
    async orderSnapshot(orderId: string) {
      const { order, items } = await orderFacts(orderId);
      return {
        currency: order.currency,
        subtotalMinor: order.subtotalMinor,
        items: items.map((item) => ({
          titleId: item.titleId,
          titleSnapshot: item.titleSnapshot,
          creatorNameSnapshot: item.creatorNameSnapshot,
          format: item.format,
          currency: item.currency,
          unitSubtotalMinor: item.unitSubtotalMinor
        }))
      };
    },
    async privacySnapshot(orderIds: readonly string[]) {
      if (orderIds.length === 0)
        throw new Error('E2E privacy snapshot requires an order');
      const selectedOrders = await database.db
        .select({
          id: orders.id,
          stripeCheckoutSessionId: orders.stripeCheckoutSessionId
        })
        .from(orders)
        .where(inArray(orders.id, [...orderIds]));
      const selectedPayments = await database.db
        .select()
        .from(payments)
        .where(inArray(payments.orderId, [...orderIds]));
      const paymentIds = selectedPayments.map((payment) => payment.id);
      const selectedRefunds =
        paymentIds.length === 0
          ? []
          : await database.db
              .select()
              .from(refunds)
              .where(inArray(refunds.paymentId, paymentIds));
      const selectedDisputes =
        paymentIds.length === 0
          ? []
          : await database.db
              .select()
              .from(disputes)
              .where(inArray(disputes.paymentId, paymentIds));
      const providerObjectIds = [
        ...selectedOrders.flatMap(
          (order) => order.stripeCheckoutSessionId ?? []
        ),
        ...selectedRefunds.map((refund) => refund.stripeRefundId),
        ...selectedDisputes.map((dispute) => dispute.stripeDisputeId)
      ];
      const selectedEvents =
        providerObjectIds.length === 0
          ? []
          : await database.db
              .select()
              .from(stripeEvents)
              .where(inArray(stripeEvents.objectId, providerObjectIds));
      const selectedAudits = await database.db
        .select()
        .from(auditEvents)
        .where(inArray(auditEvents.resourceId, [...orderIds]));
      return {
        payments: selectedPayments,
        refunds: selectedRefunds,
        disputes: selectedDisputes,
        stripeEvents: selectedEvents,
        auditEvents: selectedAudits
      };
    }
  };
}
