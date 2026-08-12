import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { fulfillDisputeEvent } from '$lib/server/commerce/disputes';
import { createCommerceMessageEnqueuer } from '$lib/server/commerce/email/enqueue';
import { fulfillCheckoutEvent } from '$lib/server/commerce/fulfillment';
import { fulfillRefundEvent } from '$lib/server/commerce/refunds';
import {
  disputes,
  entitlementGrants,
  orderItems,
  orders,
  payments,
  refunds,
  stripeEvents,
  titles,
  user
} from '$lib/server/db/schema';
import type {
  CheckoutSnapshot,
  DisputeSnapshot,
  PaymentSnapshot,
  RefundSnapshot
} from '$lib/server/commerce/stripe/types';
import { applicationConfig, databaseClient } from './database';

const paidAt = new Date('2026-08-10T12:05:00.000Z');
const checkoutExpiresAt = new Date('2026-08-10T12:30:00.000Z');
const messages = createCommerceMessageEnqueuer(applicationConfig.origin);

interface ReadinessFixture {
  orderId: string;
  titleId: string;
  checkoutEventId: string;
  refundEventId: string;
  disputeEventId: string;
  checkout: CheckoutSnapshot;
  payment: PaymentSnapshot;
  refund: RefundSnapshot;
  dispute: DisputeSnapshot;
}

async function createReadinessFixture(): Promise<ReadinessFixture> {
  const suffix = randomUUID();
  const orderId = randomUUID();
  const itemId = randomUUID();
  const titleId = randomUUID();
  const userId = randomUUID();
  const sessionId = `cs_readiness_${suffix}`;
  const paymentIntentId = `pi_readiness_${suffix}`;
  const chargeId = `ch_readiness_${suffix}`;
  const refundId = `re_readiness_${suffix}`;
  const disputeId = `dp_readiness_${suffix}`;
  const email = `readiness-${suffix}@example.com`;

  await databaseClient.db.insert(user).values({
    id: userId,
    name: 'Readiness reader',
    email,
    emailVerified: true
  });
  await databaseClient.db.insert(titles).values({
    id: titleId,
    slug: `readiness-${suffix}`,
    title: 'Private readiness fixture',
    description: 'Private readiness fixture',
    creatorName: 'Private creator',
    format: 'prose',
    priceMinor: 1299,
    currency: 'USD',
    visibility: 'private'
  });
  await databaseClient.db.insert(orders).values({
    id: orderId,
    status: 'checkout_open',
    initiatingUserId: userId,
    purchaseEmail: email,
    currency: 'USD',
    subtotalMinor: 1299,
    taxMinor: null,
    totalMinor: null,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: sessionId,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt
  });
  await databaseClient.db.insert(orderItems).values({
    id: itemId,
    orderId,
    titleId,
    titleSnapshot: 'Private readiness fixture',
    creatorNameSnapshot: 'Private creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 1299
  });
  const [checkoutEvent, refundEvent, disputeEvent] = await databaseClient.db
    .insert(stripeEvents)
    .values([
      {
        providerEventId: `evt_checkout_readiness_${suffix}`,
        eventType: 'checkout.session.async_payment_succeeded',
        objectId: sessionId,
        liveMode: false,
        apiVersion: '2026-07-29.dahlia',
        providerCreatedAt: new Date('2026-08-10T12:06:00.000Z'),
        rawBodySha256: 'c'.repeat(64)
      },
      {
        providerEventId: `evt_refund_readiness_${suffix}`,
        eventType: 'refund.updated',
        objectId: refundId,
        liveMode: false,
        apiVersion: '2026-07-29.dahlia',
        providerCreatedAt: new Date('2026-08-10T12:07:00.000Z'),
        rawBodySha256: 'd'.repeat(64)
      },
      {
        providerEventId: `evt_dispute_readiness_${suffix}`,
        eventType: 'charge.dispute.updated',
        objectId: disputeId,
        liveMode: false,
        apiVersion: '2026-07-29.dahlia',
        providerCreatedAt: new Date('2026-08-10T12:07:00.000Z'),
        rawBodySha256: 'e'.repeat(64)
      }
    ])
    .returning();
  if (!checkoutEvent || !refundEvent || !disputeEvent) throw new Error('Expected events');

  const payment: PaymentSnapshot = {
    paymentIntentId,
    metadataVersion: '1',
    metadataOrderId: orderId,
    latestChargeId: chargeId,
    liveMode: false,
    state: 'succeeded',
    amountMinor: 1403,
    currency: 'usd',
    paidAt,
    paymentMethodCategory: 'card'
  };
  return {
    orderId,
    titleId,
    checkoutEventId: checkoutEvent.id,
    refundEventId: refundEvent.id,
    disputeEventId: disputeEvent.id,
    checkout: {
      providerSessionId: sessionId,
      clientReferenceId: orderId,
      metadataVersion: '1',
      metadataOrderId: orderId,
      liveMode: false,
      mode: 'payment',
      status: 'complete',
      paymentStatus: 'paid',
      paymentIntentId,
      latestChargeId: chargeId,
      customerEmail: email,
      currency: 'usd',
      subtotalMinor: 1299,
      taxMinor: 104,
      totalMinor: 1403,
      expiresAt: checkoutExpiresAt,
      lineItems: [{
        providerLineItemId: `li_readiness_${suffix}`,
        orderItemId: itemId,
        quantity: 1,
        currency: 'usd',
        subtotalMinor: 1299,
        taxMinor: 104,
        totalMinor: 1403
      }]
    },
    payment,
    refund: {
      providerRefundId: refundId,
      paymentIntentId,
      liveMode: false,
      state: 'succeeded',
      amountMinor: 1403,
      currency: 'usd',
      reason: 'requested_by_customer',
      providerCreatedAt: new Date('2026-08-10T12:07:00.000Z'),
      balanceTransactionId: null,
      failureBalanceTransactionId: null
    },
    dispute: {
      providerDisputeId: disputeId,
      paymentIntentId,
      chargeId,
      liveMode: false,
      state: 'open',
      amountMinor: 1403,
      currency: 'usd',
      reason: 'fraudulent',
      providerCreatedAt: new Date('2026-08-10T12:07:00.000Z'),
      balanceTransactionIds: []
    }
  };
}

async function fulfillCheckout(fixture: ReadinessFixture): Promise<void> {
  await fulfillCheckoutEvent(databaseClient.db, {
    stripeEventId: fixture.checkoutEventId,
    session: fixture.checkout,
    payment: fixture.payment
  }, {
    purchaseMessages: messages,
    now: () => new Date('2026-08-10T12:08:00.000Z')
  });
}

describe('out-of-order commerce reconciliation readiness', () => {
  it('rejects an unrelated PaymentIntent instead of retrying it as local readiness', async () => {
    const fixture = await createReadinessFixture();
    const foreignPayment = {
      ...fixture.payment,
      paymentIntentId: `pi_foreign_${randomUUID()}`,
      metadataOrderId: randomUUID()
    };

    await expect(fulfillRefundEvent(databaseClient.db, {
      stripeEventId: fixture.refundEventId,
      refund: { ...fixture.refund, paymentIntentId: foreignPayment.paymentIntentId },
      payment: foreignPayment
    }, {
      messages,
      now: () => new Date('2026-08-10T12:08:00.000Z')
    })).rejects.toMatchObject({ code: 'PERMANENT_COMMERCE_FAILURE' });

    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, fixture.refundEventId)))[0]?.status).toBe('pending');
  });

  it('retries an early refund and reconciles it after checkout fulfillment', async () => {
    const fixture = await createReadinessFixture();
    const command = {
      stripeEventId: fixture.refundEventId,
      refund: fixture.refund,
      payment: fixture.payment
    };

    await expect(fulfillRefundEvent(databaseClient.db, command, {
      messages,
      now: () => new Date('2026-08-10T12:08:00.000Z')
    })).rejects.toMatchObject({ code: 'LOCAL_COMMERCE_NOT_READY' });
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, fixture.refundEventId)))[0]?.status).toBe('pending');
    expect(await databaseClient.db.select().from(refunds)).toHaveLength(0);

    await fulfillCheckout(fixture);
    await fulfillRefundEvent(databaseClient.db, command, {
      messages,
      now: () => new Date('2026-08-10T12:09:00.000Z')
    });

    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, fixture.refundEventId)))[0]?.status).toBe('processed');
    expect((await databaseClient.db.select().from(refunds))[0]?.status).toBe('succeeded');
    expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('revoked');
  });

  it('retries an early dispute and reconciles it after checkout fulfillment', async () => {
    const fixture = await createReadinessFixture();
    const command = {
      stripeEventId: fixture.disputeEventId,
      dispute: fixture.dispute,
      payment: fixture.payment
    };

    await expect(fulfillDisputeEvent(databaseClient.db, command, {
      messages,
      now: () => new Date('2026-08-10T12:08:00.000Z')
    })).rejects.toMatchObject({ code: 'LOCAL_COMMERCE_NOT_READY' });
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, fixture.disputeEventId)))[0]?.status).toBe('pending');
    expect(await databaseClient.db.select().from(disputes)).toHaveLength(0);

    await fulfillCheckout(fixture);
    await fulfillDisputeEvent(databaseClient.db, command, {
      messages,
      now: () => new Date('2026-08-10T12:09:00.000Z')
    });

    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, fixture.disputeEventId)))[0]?.status).toBe('processed');
    expect((await databaseClient.db.select().from(disputes))[0]?.status).toBe('open');
    expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state)
      .toBe('suspended');
    expect((await databaseClient.db.select().from(payments))[0]?.status).toBe('succeeded');
    expect((await databaseClient.db.select().from(orders))[0]?.status).toBe('paid');
  });
});
