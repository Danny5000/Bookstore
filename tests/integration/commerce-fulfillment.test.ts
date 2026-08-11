import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  auditEvents,
  entitlementGrants,
  entitlements,
  guestIdentities,
  orderItems,
  orders,
  payments,
  stripeEvents,
  titles,
  user
} from '$lib/server/db/schema';
import {
  fulfillCheckoutEvent,
  recordFulfillmentException,
  type CheckoutFulfillmentDependencies
} from '$lib/server/commerce/fulfillment';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import type { CheckoutSnapshot, PaymentSnapshot } from '$lib/server/commerce/stripe/types';
import { databaseClient } from './database';

interface Fixture {
  orderId: string;
  orderItemId: string;
  titleId: string;
  userId: string | null;
  stripeEventId: string;
  session: CheckoutSnapshot;
  payment: PaymentSnapshot;
}

async function createFixture(options: {
  guest?: boolean;
  orderStatus?: 'checkout_pending' | 'checkout_open' | 'payment_pending' | 'paid' | 'failed' | 'expired';
  eventType?: string;
  attachSession?: boolean;
  customerEmail?: string;
} = {}): Promise<Fixture> {
  const suffix = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const titleId = randomUUID();
  const sessionId = `cs_test_${suffix}`;
  const paymentIntentId = `pi_test_${suffix}`;
  const chargeId = `ch_test_${suffix}`;
  const lineId = `li_test_${suffix}`;
  const eventType = options.eventType ?? 'checkout.session.async_payment_succeeded';
  const guest = options.guest ?? false;
  const userId = guest ? null : randomUUID();
  const status = options.orderStatus ?? 'checkout_open';
  const paid = status === 'paid';
  const attached = options.attachSession ?? true;
  const accountEmail = userId === null ? null : `${userId}@example.com`;
  const customerEmail = options.customerEmail ?? accountEmail ?? 'guest@example.com';
  const paidAt = new Date('2026-08-10T12:05:00.000Z');

  if (userId) {
    await databaseClient.db.insert(user).values({
      id: userId,
      name: 'Commerce reader',
      email: accountEmail!,
      emailVerified: true
    });
  }
  await databaseClient.db.insert(titles).values({
    id: titleId,
    slug: `fulfillment-${suffix}`,
    title: 'Private fulfillment fixture',
    description: 'Fixture description',
    creatorName: 'Fixture creator',
    format: 'prose',
    priceMinor: 1299,
    currency: 'USD',
    visibility: 'private'
  });
  await databaseClient.db.insert(orders).values({
    id: orderId,
    status,
    initiatingUserId: userId,
    guestIdentityId: null,
    purchaseEmail: accountEmail,
    currency: 'USD',
    subtotalMinor: 1299,
    taxMinor: paid ? 104 : null,
    totalMinor: paid ? 1403 : null,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: attached ? sessionId : null,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: attached ? new Date('2026-08-10T12:30:00.000Z') : null,
    paidAt: paid ? paidAt : null
  });
  await databaseClient.db.insert(orderItems).values({
    id: orderItemId,
    orderId,
    titleId,
    titleSnapshot: 'Private fulfillment fixture',
    creatorNameSnapshot: 'Fixture creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 1299,
    taxMinor: paid ? 104 : null,
    totalMinor: paid ? 1403 : null,
    stripeLineItemId: paid ? lineId : null
  });
  if (paid) {
    await databaseClient.db.insert(payments).values({
      orderId,
      stripePaymentIntentId: paymentIntentId,
      stripeLatestChargeId: chargeId,
      status: 'succeeded',
      amountMinor: 1403,
      currency: 'USD',
      paymentMethodCategory: 'card',
      paidAt
    });
  }
  const [event] = await databaseClient.db.insert(stripeEvents).values({
    providerEventId: `evt_test_${suffix}`,
    eventType,
    objectId: sessionId,
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: new Date('2026-08-10T12:06:00.000Z'),
    rawBodySha256: 'c'.repeat(64),
    status: 'pending'
  }).returning();
  if (!event) throw new Error('Expected event fixture');

  return {
    orderId,
    orderItemId,
    titleId,
    userId,
    stripeEventId: event.id,
    session: {
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
      customerEmail,
      currency: 'usd',
      subtotalMinor: 1299,
      taxMinor: 104,
      totalMinor: 1403,
      expiresAt: new Date('2026-08-10T12:30:00.000Z'),
      lineItems: [{
        providerLineItemId: lineId,
        orderItemId,
        quantity: 1,
        currency: 'usd',
        subtotalMinor: 1299,
        taxMinor: 104,
        totalMinor: 1403
      }]
    },
    payment: {
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
    }
  };
}

function dependencies(
  overrides: Partial<CheckoutFulfillmentDependencies> = {}
): CheckoutFulfillmentDependencies {
  return {
    purchaseMessages: {
      enqueueAccountReceipt: vi.fn(async () => undefined),
      enqueueGuestClaimPreparation: vi.fn(async () => undefined)
    },
    ...overrides
  };
}

async function fulfill(fixture: Fixture, deps = dependencies()): Promise<void> {
  await fulfillCheckoutEvent(databaseClient.db, {
    stripeEventId: fixture.stripeEventId,
    session: fixture.session,
    payment: fixture.payment
  }, deps);
}

describe('canonical Stripe checkout fulfillment', () => {
  it('records completed-unpaid payment evidence without granting access or email', async () => {
    const fixture = await createFixture({ eventType: 'checkout.session.completed' });
    const deps = dependencies();
    const session: CheckoutSnapshot = {
      ...fixture.session,
      paymentStatus: 'unpaid',
      latestChargeId: null
    };
    const payment: PaymentSnapshot = {
      ...fixture.payment,
      state: 'pending',
      latestChargeId: null,
      paidAt: null
    };
    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: fixture.stripeEventId,
      session,
      payment
    }, deps);

    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, fixture.orderId)))[0]).toMatchObject({
      status: 'payment_pending', taxMinor: null, totalMinor: null, paidAt: null
    });
    expect(await databaseClient.db.select().from(payments)
      .where(eq(payments.orderId, fixture.orderId))).toEqual([
      expect.objectContaining({ status: 'pending', amountMinor: 1403 })
    ]);
    expect(await databaseClient.db.select().from(entitlementGrants)).toHaveLength(0);
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(0);
    expect(deps.purchaseMessages.enqueueAccountReceipt).not.toHaveBeenCalled();
    expect(deps.purchaseMessages.enqueueGuestClaimPreparation).not.toHaveBeenCalled();
  });

  it('atomically finalizes account and normalized guest purchases', async () => {
    const account = await createFixture();
    const accountDeps = dependencies();
    await fulfill(account, accountDeps);
    const guest = await createFixture({
      guest: true,
      customerEmail: ' Guest@Example.COM ',
      attachSession: false,
      orderStatus: 'checkout_pending'
    });
    const guestDeps = dependencies();
    await fulfill(guest, guestDeps);

    const storedOrders = await databaseClient.db.select().from(orders);
    expect(storedOrders.find((row) => row.id === account.orderId)).toMatchObject({
      status: 'paid', taxMinor: 104, totalMinor: 1403,
      initiatingUserId: account.userId, guestIdentityId: null
    });
    const guestOrder = storedOrders.find((row) => row.id === guest.orderId);
    expect(guestOrder).toMatchObject({
      status: 'paid', purchaseEmail: 'guest@example.com',
      initiatingUserId: null, stripeCheckoutSessionId: guest.session.providerSessionId
    });
    const identities = await databaseClient.db.select().from(guestIdentities);
    expect(identities).toEqual([
      expect.objectContaining({ id: guestOrder!.guestIdentityId, email: 'guest@example.com' })
    ]);
    expect(await databaseClient.db.select().from(payments)).toHaveLength(2);
    const grants = await databaseClient.db.select().from(entitlementGrants);
    expect(grants.find((grant) => grant.orderItemId === account.orderItemId)).toMatchObject({
      state: 'active', userId: account.userId, stateReason: 'payment_succeeded'
    });
    expect(grants.find((grant) => grant.orderItemId === guest.orderItemId)).toMatchObject({
      state: 'unclaimed', userId: null, stateReason: 'payment_succeeded'
    });
    expect(await databaseClient.db.select().from(entitlements)).toEqual([
      expect.objectContaining({ userId: account.userId, titleId: account.titleId, revokedAt: null })
    ]);
    expect(accountDeps.purchaseMessages.enqueueAccountReceipt)
      .toHaveBeenCalledWith(expect.anything(), account.orderId);
    expect(guestDeps.purchaseMessages.enqueueGuestClaimPreparation)
      .toHaveBeenCalledWith(expect.anything(), guest.orderId);
  });

  it('reuses a normalized guest identity even when earlier purchases were claimed', async () => {
    const claimantId = randomUUID();
    await databaseClient.db.insert(user).values({
      id: claimantId,
      name: 'Earlier claimant',
      email: 'guest@example.com',
      emailVerified: true
    });
    const [identity] = await databaseClient.db.insert(guestIdentities).values({
      email: 'guest@example.com',
      claimedByUserId: claimantId,
      claimedAt: new Date('2026-08-10T11:00:00.000Z')
    }).returning();
    if (!identity) throw new Error('Expected guest identity');
    const guest = await createFixture({ guest: true, customerEmail: 'guest@example.com' });

    await fulfill(guest);

    expect(await databaseClient.db.select().from(guestIdentities)).toHaveLength(1);
    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, guest.orderId)))[0]?.guestIdentityId).toBe(identity.id);
    expect((await databaseClient.db.select().from(entitlementGrants)
      .where(eq(entitlementGrants.orderItemId, guest.orderItemId)))[0]).toMatchObject({
      userId: null,
      state: 'unclaimed'
    });
  });

  it('finalizes every item and projects every title in a multi-title purchase', async () => {
    const fixture = await createFixture();
    const secondTitleId = randomUUID();
    const secondItemId = randomUUID();
    const secondLineId = `li_test_${randomUUID()}`;
    await databaseClient.db.insert(titles).values({
      id: secondTitleId,
      slug: `fulfillment-${randomUUID()}`,
      title: 'Second private title',
      description: 'Second fixture description',
      creatorName: 'Second fixture creator',
      format: 'comic',
      priceMinor: 1000,
      currency: 'USD',
      visibility: 'private'
    });
    await databaseClient.db.insert(orderItems).values({
      id: secondItemId,
      orderId: fixture.orderId,
      titleId: secondTitleId,
      titleSnapshot: 'Second private title',
      creatorNameSnapshot: 'Second fixture creator',
      format: 'comic',
      currency: 'USD',
      unitSubtotalMinor: 1000
    });
    await databaseClient.db.update(orders)
      .set({ subtotalMinor: 2299 })
      .where(eq(orders.id, fixture.orderId));
    const session: CheckoutSnapshot = {
      ...fixture.session,
      subtotalMinor: 2299,
      taxMinor: 184,
      totalMinor: 2483,
      lineItems: [
        ...fixture.session.lineItems,
        {
          providerLineItemId: secondLineId,
          orderItemId: secondItemId,
          quantity: 1,
          currency: 'usd',
          subtotalMinor: 1000,
          taxMinor: 80,
          totalMinor: 1080
        }
      ]
    };
    const payment: PaymentSnapshot = { ...fixture.payment, amountMinor: 2483 };

    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: fixture.stripeEventId,
      session,
      payment
    }, dependencies());

    expect(await databaseClient.db.select().from(entitlementGrants)).toHaveLength(2);
    expect(await databaseClient.db.select().from(entitlements)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: fixture.userId, titleId: fixture.titleId }),
        expect.objectContaining({ userId: fixture.userId, titleId: secondTitleId })
      ])
    );
    expect(await databaseClient.db.select().from(orderItems)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixture.orderItemId, taxMinor: 104, totalMinor: 1403 }),
        expect.objectContaining({ id: secondItemId, taxMinor: 80, totalMinor: 1080 })
      ])
    );
  });

  it('applies failure and expiry only to unpaid orders and never regresses paid state', async () => {
    const failed = await createFixture({ eventType: 'checkout.session.async_payment_failed' });
    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: failed.stripeEventId,
      session: { ...failed.session, paymentStatus: 'unpaid', latestChargeId: null },
      payment: { ...failed.payment, state: 'failed', latestChargeId: null, paidAt: null }
    }, dependencies());
    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, failed.orderId)))[0]?.status).toBe('failed');

    const expired = await createFixture({ eventType: 'checkout.session.expired' });
    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: expired.stripeEventId,
      session: {
        ...expired.session,
        status: 'expired', paymentStatus: 'unpaid', paymentIntentId: null, latestChargeId: null
      },
      payment: null
    }, dependencies());
    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, expired.orderId)))[0]?.status).toBe('expired');

    const alreadyPaid = await createFixture({
      orderStatus: 'paid',
      eventType: 'checkout.session.async_payment_failed'
    });
    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: alreadyPaid.stripeEventId,
      session: { ...alreadyPaid.session, paymentStatus: 'unpaid', latestChargeId: null },
      payment: { ...alreadyPaid.payment, state: 'failed', latestChargeId: null, paidAt: null }
    }, dependencies());
    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, alreadyPaid.orderId)))[0]?.status).toBe('paid');
  });

  it('releases failed only after signed expiry and rejects every later non-expired command', async () => {
    const fixture = await createFixture({
      orderStatus: 'failed',
      eventType: 'checkout.session.expired'
    });
    const expiredSession = {
      ...fixture.session,
      status: 'expired' as const,
      paymentStatus: 'unpaid' as const,
      paymentIntentId: null,
      latestChargeId: null
    };
    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: fixture.stripeEventId,
      session: expiredSession,
      payment: null
    }, dependencies());
    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, fixture.orderId)))[0]?.status).toBe('expired');

    const [latePaidEvent] = await databaseClient.db.insert(stripeEvents).values({
      providerEventId: `evt_test_${randomUUID()}`,
      eventType: 'checkout.session.async_payment_succeeded',
      objectId: fixture.session.providerSessionId,
      liveMode: false,
      apiVersion: '2026-07-29.dahlia',
      providerCreatedAt: new Date('2026-08-10T12:31:00.000Z'),
      rawBodySha256: '9'.repeat(64)
    }).returning();
    if (!latePaidEvent) throw new Error('Expected late event');

    await expect(fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: latePaidEvent.id,
      session: fixture.session,
      payment: fixture.payment
    }, dependencies())).rejects.toBeInstanceOf(PermanentCommerceError);
    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, fixture.orderId)))[0]?.status).toBe('expired');
    expect(await databaseClient.db.select().from(entitlementGrants)
      .where(eq(entitlementGrants.orderItemId, fixture.orderItemId))).toHaveLength(0);
  });

  it('keeps repeated failure terminal and permits only a later canonical success', async () => {
    const fixture = await createFixture({ eventType: 'checkout.session.completed' });
    const pendingSession = {
      ...fixture.session,
      paymentStatus: 'unpaid' as const,
      latestChargeId: null
    };
    const pendingPayment = {
      ...fixture.payment,
      state: 'pending' as const,
      latestChargeId: null,
      paidAt: null,
      paymentMethodCategory: null
    };
    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: fixture.stripeEventId,
      session: pendingSession,
      payment: pendingPayment
    }, dependencies());

    const [failedEvent] = await databaseClient.db.insert(stripeEvents).values({
      providerEventId: `evt_test_${randomUUID()}`,
      eventType: 'checkout.session.async_payment_failed',
      objectId: fixture.session.providerSessionId,
      liveMode: false,
      apiVersion: '2026-07-29.dahlia',
      providerCreatedAt: new Date('2026-08-10T12:07:00.000Z'),
      rawBodySha256: 'e'.repeat(64)
    }).returning();
    if (!failedEvent) throw new Error('Expected failed event');

    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: failedEvent.id,
      session: pendingSession,
      payment: { ...pendingPayment, state: 'failed' }
    }, dependencies());

    expect((await databaseClient.db.select().from(payments)
      .where(eq(payments.orderId, fixture.orderId)))[0]).toMatchObject({
      status: 'failed',
      paidAt: null
    });

    const [repeatedFailedEvent, succeededEvent] = await databaseClient.db
      .insert(stripeEvents)
      .values([
        {
          providerEventId: `evt_test_${randomUUID()}`,
          eventType: 'checkout.session.async_payment_failed',
          objectId: fixture.session.providerSessionId,
          liveMode: false,
          apiVersion: '2026-07-29.dahlia',
          providerCreatedAt: new Date('2026-08-10T12:08:00.000Z'),
          rawBodySha256: 'f'.repeat(64)
        },
        {
          providerEventId: `evt_test_${randomUUID()}`,
          eventType: 'checkout.session.async_payment_succeeded',
          objectId: fixture.session.providerSessionId,
          liveMode: false,
          apiVersion: '2026-07-29.dahlia',
          providerCreatedAt: new Date('2026-08-10T12:09:00.000Z'),
          rawBodySha256: '0'.repeat(64)
        }
      ])
      .returning();
    if (!repeatedFailedEvent || !succeededEvent) throw new Error('Expected follow-up events');

    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: repeatedFailedEvent.id,
      session: pendingSession,
      payment: { ...pendingPayment, state: 'failed' }
    }, dependencies());
    expect((await databaseClient.db.select().from(payments)
      .where(eq(payments.orderId, fixture.orderId)))[0]?.status).toBe('failed');

    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: succeededEvent.id,
      session: fixture.session,
      payment: fixture.payment
    }, dependencies());
    expect((await databaseClient.db.select().from(payments)
      .where(eq(payments.orderId, fixture.orderId)))[0]?.status).toBe('succeeded');
    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, fixture.orderId)))[0]?.status).toBe('paid');
    expect(await databaseClient.db.select().from(entitlementGrants)).toHaveLength(1);
  });

  it('advances failed charge evidence when the same PaymentIntent is attempted again', async () => {
    const fixture = await createFixture({ eventType: 'checkout.session.async_payment_failed' });
    const oldChargeId = `ch_test_old_${randomUUID()}`;
    const newChargeId = `ch_test_new_${randomUUID()}`;
    const failedSession = {
      ...fixture.session,
      paymentStatus: 'unpaid' as const,
      latestChargeId: oldChargeId
    };
    const failedPayment = {
      ...fixture.payment,
      state: 'failed' as const,
      latestChargeId: oldChargeId,
      paidAt: null
    };
    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: fixture.stripeEventId,
      session: failedSession,
      payment: failedPayment
    }, dependencies());

    const [retriedEvent] = await databaseClient.db.insert(stripeEvents).values({
      providerEventId: `evt_test_${randomUUID()}`,
      eventType: 'checkout.session.async_payment_failed',
      objectId: fixture.session.providerSessionId,
      liveMode: false,
      apiVersion: '2026-07-29.dahlia',
      providerCreatedAt: new Date('2026-08-10T12:08:00.000Z'),
      rawBodySha256: '1'.repeat(64)
    }).returning();
    if (!retriedEvent) throw new Error('Expected retried payment event');

    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: retriedEvent.id,
      session: { ...failedSession, latestChargeId: newChargeId },
      payment: { ...failedPayment, latestChargeId: newChargeId }
    }, dependencies());

    expect((await databaseClient.db.select().from(payments)
      .where(eq(payments.orderId, fixture.orderId)))[0]).toMatchObject({
      status: 'failed',
      stripeLatestChargeId: newChargeId,
      paidAt: null
    });
  });

  it('fulfills a retried PaymentIntent when success replaces failed charge evidence', async () => {
    const fixture = await createFixture({ eventType: 'checkout.session.async_payment_failed' });
    const oldChargeId = `ch_test_old_${randomUUID()}`;
    const newChargeId = `ch_test_new_${randomUUID()}`;
    const failedSession = {
      ...fixture.session,
      paymentStatus: 'unpaid' as const,
      latestChargeId: oldChargeId
    };
    const failedPayment = {
      ...fixture.payment,
      state: 'failed' as const,
      latestChargeId: oldChargeId,
      paidAt: null
    };
    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: fixture.stripeEventId,
      session: failedSession,
      payment: failedPayment
    }, dependencies());

    const [succeededEvent] = await databaseClient.db.insert(stripeEvents).values({
      providerEventId: `evt_test_${randomUUID()}`,
      eventType: 'checkout.session.async_payment_succeeded',
      objectId: fixture.session.providerSessionId,
      liveMode: false,
      apiVersion: '2026-07-29.dahlia',
      providerCreatedAt: new Date('2026-08-10T12:09:00.000Z'),
      rawBodySha256: '2'.repeat(64)
    }).returning();
    if (!succeededEvent) throw new Error('Expected succeeded payment event');

    await fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: succeededEvent.id,
      session: { ...fixture.session, latestChargeId: newChargeId },
      payment: { ...fixture.payment, latestChargeId: newChargeId }
    }, dependencies());

    expect((await databaseClient.db.select().from(payments)
      .where(eq(payments.orderId, fixture.orderId)))[0]).toMatchObject({
      status: 'succeeded',
      stripeLatestChargeId: newChargeId,
      paidAt: fixture.payment.paidAt
    });
    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, fixture.orderId)))[0]?.status).toBe('paid');
    expect(await databaseClient.db.select().from(entitlementGrants)).toHaveLength(1);
  });

  it('keeps duplicate, out-of-order, and concurrent success jobs monotonic', async () => {
    const fixture = await createFixture();
    const [secondEvent] = await databaseClient.db.insert(stripeEvents).values({
      providerEventId: `evt_test_${randomUUID()}`,
      eventType: 'checkout.session.completed',
      objectId: fixture.session.providerSessionId,
      liveMode: false,
      providerCreatedAt: new Date('2026-08-10T12:04:00.000Z'),
      rawBodySha256: 'd'.repeat(64)
    }).returning();
    if (!secondEvent) throw new Error('Expected second event');
    await Promise.all([
      fulfill(fixture),
      fulfillCheckoutEvent(databaseClient.db, {
        stripeEventId: secondEvent.id,
        session: fixture.session,
        payment: fixture.payment
      }, dependencies())
    ]);
    await fulfill(fixture);

    expect((await databaseClient.db.select({ value: count() }).from(payments))[0]?.value).toBe(1);
    expect((await databaseClient.db.select({ value: count() }).from(entitlementGrants))[0]?.value).toBe(1);
    expect((await databaseClient.db.select({ value: count() }).from(entitlements))[0]?.value).toBe(1);
    expect(await databaseClient.db.select().from(stripeEvents)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixture.stripeEventId, status: 'processed' }),
        expect.objectContaining({ id: secondEvent.id, status: 'processed' })
      ])
    );
  });

  it('does not acknowledge a paid order whose locked payment evidence is incomplete', async () => {
    const fixture = await createFixture({ orderStatus: 'paid' });
    await databaseClient.db.update(payments).set({
      status: 'pending',
      paidAt: null
    }).where(eq(payments.orderId, fixture.orderId));

    await expect(fulfill(fixture)).rejects.toThrow();

    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, fixture.stripeEventId)))[0]?.status).toBe('pending');
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.resourceId, fixture.orderId))).toHaveLength(0);
  });

  it('classifies a PaymentIntent already bound to another order as permanent', async () => {
    const existing = await createFixture({ orderStatus: 'paid' });
    const target = await createFixture();
    const session: CheckoutSnapshot = {
      ...target.session,
      paymentIntentId: existing.payment.paymentIntentId,
      latestChargeId: existing.payment.latestChargeId
    };
    const payment: PaymentSnapshot = {
      ...target.payment,
      paymentIntentId: existing.payment.paymentIntentId,
      latestChargeId: existing.payment.latestChargeId
    };

    await expect(fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: target.stripeEventId,
      session,
      payment
    }, dependencies())).rejects.toBeInstanceOf(PermanentCommerceError);
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, target.stripeEventId)))[0]?.status).toBe('pending');
  });

  it.each([
    ['grant', { createPurchaseGrant: async () => { throw new Error('forced grant failure'); } }],
    ['projection', { projectEntitlement: async () => { throw new Error('forced projection failure'); } }],
    ['audit', { appendAuditEvent: async () => { throw new Error('forced audit failure'); } }],
    ['event completion', { completeStripeEvent: async () => { throw new Error('forced event failure'); } }]
  ] as const)('rolls back every paid write when %s fails', async (_label, override) => {
    const fixture = await createFixture();
    await expect(fulfill(fixture, dependencies(override))).rejects.toThrow(/forced/u);
    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, fixture.orderId)))[0]).toMatchObject({
      status: 'checkout_open', taxMinor: null, totalMinor: null, paidAt: null
    });
    expect(await databaseClient.db.select().from(payments)
      .where(eq(payments.orderId, fixture.orderId))).toHaveLength(0);
    expect(await databaseClient.db.select().from(entitlementGrants)).toHaveLength(0);
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(0);
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, fixture.stripeEventId)))[0]?.status).toBe('pending');
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.resourceId, fixture.orderId))).toHaveLength(0);
  });

  it('rolls back the paid transition when transactional message enqueue fails', async () => {
    const fixture = await createFixture();
    const deps = dependencies();
    vi.mocked(deps.purchaseMessages.enqueueAccountReceipt)
      .mockRejectedValueOnce(new Error('forced email failure'));
    await expect(fulfill(fixture, deps)).rejects.toThrow('forced email failure');
    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, fixture.orderId)))[0]?.status).toBe('checkout_open');
    expect(await databaseClient.db.select().from(payments)).toHaveLength(0);
    expect(await databaseClient.db.select().from(entitlementGrants)).toHaveLength(0);
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(0);
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.resourceId, fixture.orderId))).toHaveLength(0);
  });

  it('records canonical mismatch as a minimized permanent exception with no access', async () => {
    const fixture = await createFixture();
    await expect(fulfillCheckoutEvent(databaseClient.db, {
      stripeEventId: fixture.stripeEventId,
      session: { ...fixture.session, clientReferenceId: randomUUID() },
      payment: fixture.payment
    }, dependencies())).rejects.toThrow();
    await recordFulfillmentException(databaseClient.db, {
      stripeEventId: fixture.stripeEventId,
      orderId: fixture.orderId
    });

    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, fixture.orderId)))[0]?.status).toBe('exception');
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, fixture.stripeEventId)))[0]).toMatchObject({
      status: 'exception', processedAt: expect.any(Date)
    });
    expect(await databaseClient.db.select().from(entitlementGrants)).toHaveLength(0);
    const audit = (await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.resourceId, fixture.orderId)))[0];
    expect(audit).toMatchObject({
      actorType: 'system', actorId: 'commerce-worker',
      action: 'commerce.fulfillment_exception', outcome: 'failed'
    });
    expect(JSON.stringify(audit)).not.toMatch(/private fulfillment|@example|cs_test|pi_test|ch_test/iu);
  });

  it('never regresses a signed-expired order back into a purchase reservation', async () => {
    const fixture = await createFixture({ orderStatus: 'expired' });

    await recordFulfillmentException(databaseClient.db, {
      stripeEventId: fixture.stripeEventId,
      orderId: fixture.orderId
    });

    expect((await databaseClient.db.select({ status: orders.status }).from(orders)
      .where(eq(orders.id, fixture.orderId)))[0]?.status).toBe('expired');
    expect((await databaseClient.db.select({ status: stripeEvents.status }).from(stripeEvents)
      .where(eq(stripeEvents.id, fixture.stripeEventId)))[0]?.status).toBe('exception');
  });
});
