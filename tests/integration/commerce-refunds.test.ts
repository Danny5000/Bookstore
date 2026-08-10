import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createCommerceMessageEnqueuer } from '$lib/server/commerce/email/enqueue';
import { parseCommerceEmailPayload } from '$lib/server/commerce/email/payload';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import { projectEffectiveEntitlement } from '$lib/server/commerce/grants';
import {
  fulfillRefundEvent,
  type RefundFulfillmentDependencies
} from '$lib/server/commerce/refunds';
import {
  auditEvents,
  entitlementGrants,
  entitlements,
  guestIdentities,
  orderItems,
  orders,
  outboxMessages,
  payments,
  refundAllocations,
  refunds,
  stripeEvents,
  titles,
  user
} from '$lib/server/db/schema';
import { applicationConfig, databaseClient } from './database';

const now = new Date('2026-08-10T14:00:00.000Z');

interface PurchaseFixture {
  orderId: string;
  paymentId: string;
  paymentIntentId: string;
  userId: string | null;
  email: string;
  items: Array<{ id: string; titleId: string; totalMinor: number }>;
}

async function createPurchase(
  totals: readonly number[],
  owner: 'account' | 'guest' = 'account'
): Promise<PurchaseFixture> {
  const orderId = randomUUID();
  const email = `${owner}-${orderId}@example.com`;
  let userId: string | null = null;
  let guestIdentityId: string | null = null;
  if (owner === 'account') {
    userId = randomUUID();
    await databaseClient.db.insert(user).values({
      id: userId,
      name: 'Refund reader',
      email,
      emailVerified: true
    });
  } else {
    const [identity] = await databaseClient.db.insert(guestIdentities)
      .values({ email })
      .returning();
    if (!identity) throw new Error('Expected identity');
    guestIdentityId = identity.id;
  }

  const totalMinor = totals.reduce((sum, value) => sum + value, 0);
  await databaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    initiatingUserId: userId,
    guestIdentityId,
    purchaseEmail: email,
    currency: 'USD',
    subtotalMinor: totalMinor,
    taxMinor: 0,
    totalMinor,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: `cs_test_${orderId}`,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt: new Date('2026-08-10T12:05:00.000Z')
  });

  const items: PurchaseFixture['items'] = [];
  for (const [index, itemTotal] of totals.entries()) {
    const titleId = randomUUID();
    const itemId = randomUUID();
    await databaseClient.db.insert(titles).values({
      id: titleId,
      slug: `refund-title-${titleId}`,
      title: `Private refund title ${index}`,
      description: 'Private refund fixture',
      creatorName: 'Private creator',
      format: 'prose',
      priceMinor: itemTotal,
      currency: 'USD',
      visibility: 'private'
    });
    await databaseClient.db.insert(orderItems).values({
      id: itemId,
      orderId,
      titleId,
      titleSnapshot: `Private refund title ${index}`,
      creatorNameSnapshot: 'Private creator',
      format: 'prose',
      currency: 'USD',
      unitSubtotalMinor: itemTotal,
      taxMinor: 0,
      totalMinor: itemTotal,
      stripeLineItemId: `li_test_${itemId}`
    });
    await databaseClient.db.insert(entitlementGrants).values({
      titleId,
      userId,
      source: 'purchase',
      orderItemId: itemId,
      state: userId ? 'active' : 'unclaimed',
      stateReason: 'payment_succeeded',
      grantedAt: new Date('2026-08-10T12:05:00.000Z')
    });
    items.push({ id: itemId, titleId, totalMinor: itemTotal });
  }

  const paymentIntentId = `pi_test_${orderId}`;
  const [payment] = await databaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: paymentIntentId,
    stripeLatestChargeId: `ch_test_${orderId}`,
    status: 'succeeded',
    amountMinor: totalMinor,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt: new Date('2026-08-10T12:05:00.000Z')
  }).returning();
  if (!payment) throw new Error('Expected payment');
  if (userId) {
    await databaseClient.db.transaction(async (transaction) => {
      for (const item of items) {
        await projectEffectiveEntitlement(transaction, userId!, item.titleId, now);
      }
    });
  }
  return { orderId, paymentId: payment.id, paymentIntentId, userId, email, items };
}

async function createRefundEvent(providerRefundId: string, sequence = 1) {
  const [event] = await databaseClient.db.insert(stripeEvents).values({
    providerEventId: `evt_refund_${sequence}_${randomUUID()}`,
    eventType: 'refund.updated',
    objectId: providerRefundId,
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: new Date(`2026-08-10T13:0${sequence}:00.000Z`),
    rawBodySha256: sequence.toString(16).padStart(64, '0')
  }).returning();
  if (!event) throw new Error('Expected event');
  return event;
}

function snapshots(
  fixture: PurchaseFixture,
  event: { id: string; objectId: string },
  amountMinor: number,
  state: 'pending' | 'succeeded' | 'failed' | 'canceled' = 'succeeded',
  sequence = 1
) {
  return {
    stripeEventId: event.id,
    refund: {
      providerRefundId: event.objectId,
      paymentIntentId: fixture.paymentIntentId,
      liveMode: false,
      state,
      amountMinor,
      currency: 'usd',
      reason: 'requested_by_customer' as const,
      providerCreatedAt: new Date(`2026-08-10T13:0${sequence}:00.000Z`)
    },
    payment: {
      paymentIntentId: fixture.paymentIntentId,
      latestChargeId: `ch_test_${fixture.orderId}`,
      liveMode: false,
      state: 'succeeded' as const,
      amountMinor: fixture.items.reduce((sum, item) => sum + item.totalMinor, 0),
      currency: 'usd',
      paidAt: new Date('2026-08-10T12:05:00.000Z'),
      paymentMethodCategory: 'card'
    }
  };
}

function dependencies(
  overrides: Partial<RefundFulfillmentDependencies> = {}
): RefundFulfillmentDependencies {
  return {
    messages: createCommerceMessageEnqueuer(applicationConfig.origin),
    now: () => now,
    ...overrides
  };
}

describe('canonical refund fulfillment', () => {
  it('allocates cumulative single-title refunds and revokes only at the full paid total', async () => {
    const fixture = await createPurchase([1403]);
    const first = await createRefundEvent(`re_test_${randomUUID()}`, 1);
    await fulfillRefundEvent(
      databaseClient.db,
      snapshots(fixture, first, 500, 'succeeded', 1),
      dependencies()
    );
    expect(await databaseClient.db.select().from(refundAllocations)).toEqual([
      expect.objectContaining({ orderItemId: fixture.items[0]!.id, amountMinor: 500 })
    ]);
    expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('active');
    expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt).toBeNull();
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(0);

    const second = await createRefundEvent(`re_test_${randomUUID()}`, 2);
    await fulfillRefundEvent(
      databaseClient.db,
      snapshots(fixture, second, 903, 'succeeded', 2),
      dependencies()
    );
    expect((await databaseClient.db.select().from(refundAllocations))
      .reduce((sum, allocation) => sum + allocation.amountMinor, 0)).toBe(1403);
    expect((await databaseClient.db.select().from(entitlementGrants))[0]).toMatchObject({
      state: 'revoked',
      stateReason: 'refund_fully_allocated',
      revokedAt: expect.any(Date)
    });
    expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt)
      .toEqual(expect.any(Date));
    const mail = await databaseClient.db.select().from(outboxMessages);
    expect(mail).toHaveLength(1);
    expect(parseCommerceEmailPayload(mail[0]?.payload, applicationConfig.origin)).toMatchObject({
      template: 'commerce.refund-access-changed',
      affectedTitleCount: 1
    });

    await fulfillRefundEvent(
      databaseClient.db,
      snapshots(fixture, second, 903, 'succeeded', 2),
      dependencies()
    );
    expect(await databaseClient.db.select().from(refundAllocations)).toHaveLength(2);
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(1);
  });

  it('deterministically allocates one full multi-title refund and sends one aggregate change', async () => {
    const fixture = await createPurchase([1000, 1500]);
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await fulfillRefundEvent(databaseClient.db, snapshots(fixture, event, 2500), dependencies());
    expect((await databaseClient.db.select().from(refundAllocations))
      .map((allocation) => allocation.amountMinor).sort((a, b) => a - b))
      .toEqual([1000, 1500]);
    expect((await databaseClient.db.select().from(entitlementGrants))
      .every((grant) => grant.state === 'revoked')).toBe(true);
    expect(parseCommerceEmailPayload(
      (await databaseClient.db.select().from(outboxMessages))[0]?.payload,
      applicationConfig.origin
    )).toMatchObject({ affectedTitleCount: 2 });
  });

  it('stores ambiguous partial multi-title refunds as inspectable exceptions without guessing', async () => {
    const fixture = await createPurchase([1000, 1500]);
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await fulfillRefundEvent(databaseClient.db, snapshots(fixture, event, 800), dependencies());
    expect(await databaseClient.db.select().from(refundAllocations)).toHaveLength(0);
    expect((await databaseClient.db.select().from(refunds))[0]).toMatchObject({
      status: 'succeeded',
      reconciliationStatus: 'exception'
    });
    expect((await databaseClient.db.select().from(stripeEvents))[0]).toMatchObject({
      status: 'exception',
      processedAt: expect.any(Date)
    });
    expect((await databaseClient.db.select().from(entitlementGrants))
      .every((grant) => grant.state === 'active')).toBe(true);
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(0);
  });

  it('recomputes prior ambiguous rows when cumulative refunds prove the whole order', async () => {
    const fixture = await createPurchase([1000, 1500]);
    const first = await createRefundEvent(`re_test_${randomUUID()}`, 1);
    await fulfillRefundEvent(databaseClient.db, snapshots(fixture, first, 800, 'succeeded', 1), dependencies());
    const second = await createRefundEvent(`re_test_${randomUUID()}`, 2);
    await fulfillRefundEvent(databaseClient.db, snapshots(fixture, second, 1700, 'succeeded', 2), dependencies());
    expect((await databaseClient.db.select().from(refundAllocations))
      .reduce((sum, allocation) => sum + allocation.amountMinor, 0)).toBe(2500);
    expect((await databaseClient.db.select().from(refunds))
      .every((refund) => refund.reconciliationStatus === 'pending')).toBe(true);
    expect((await databaseClient.db.select().from(entitlementGrants))
      .every((grant) => grant.state === 'revoked')).toBe(true);
  });

  it.each(['pending', 'failed', 'canceled'] as const)(
    'persists a %s refund without allocating or changing access',
    async (state) => {
      const fixture = await createPurchase([1403]);
      const event = await createRefundEvent(`re_test_${randomUUID()}`);
      await fulfillRefundEvent(
        databaseClient.db,
        snapshots(fixture, event, 1403, state),
        dependencies()
      );
      expect((await databaseClient.db.select().from(refunds))[0]?.status).toBe(state);
      expect(await databaseClient.db.select().from(refundAllocations)).toHaveLength(0);
      expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('active');
      expect((await databaseClient.db.select().from(stripeEvents))[0]?.status).toBe('processed');
    }
  );

  it('revokes an unclaimed guest grant without creating access or sending mail', async () => {
    const fixture = await createPurchase([1403], 'guest');
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await fulfillRefundEvent(databaseClient.db, snapshots(fixture, event, 1403), dependencies());
    expect((await databaseClient.db.select().from(entitlementGrants))[0]).toMatchObject({
      userId: null,
      state: 'revoked'
    });
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(0);
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(0);
  });

  it('keeps effective access when another preserved grant remains active', async () => {
    const fixture = await createPurchase([1403]);
    await databaseClient.db.insert(entitlementGrants).values({
      userId: fixture.userId!,
      titleId: fixture.items[0]!.titleId,
      source: 'preserved',
      state: 'active',
      stateReason: 'administrative_preservation',
      grantedAt: now
    });
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await fulfillRefundEvent(databaseClient.db, snapshots(fixture, event, 1403), dependencies());
    expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt).toBeNull();
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(0);
  });

  it('preserves succeeded refund state against an out-of-order canonical regression', async () => {
    const fixture = await createPurchase([1403]);
    const providerRefundId = `re_test_${randomUUID()}`;
    const first = await createRefundEvent(providerRefundId, 1);
    await fulfillRefundEvent(databaseClient.db, snapshots(fixture, first, 1403), dependencies());
    const replay = await createRefundEvent(providerRefundId, 2);
    await fulfillRefundEvent(
      databaseClient.db,
      snapshots(fixture, replay, 1403, 'pending', 1),
      dependencies()
    );
    expect((await databaseClient.db.select().from(refunds))[0]?.status).toBe('succeeded');
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, replay.id)))[0]?.status).toBe('processed');
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(1);
  });

  it('serializes concurrent over-refunds without exceeding the item total', async () => {
    const fixture = await createPurchase([1403]);
    const first = await createRefundEvent(`re_test_${randomUUID()}`, 1);
    const second = await createRefundEvent(`re_test_${randomUUID()}`, 2);
    await Promise.all([
      fulfillRefundEvent(databaseClient.db, snapshots(fixture, first, 800, 'succeeded', 1), dependencies()),
      fulfillRefundEvent(databaseClient.db, snapshots(fixture, second, 800, 'succeeded', 2), dependencies())
    ]);
    expect((await databaseClient.db.select().from(refundAllocations))
      .reduce((sum, allocation) => sum + allocation.amountMinor, 0)).toBe(800);
    expect((await databaseClient.db.select().from(stripeEvents))
      .filter((event) => event.status === 'exception')).toHaveLength(1);
  });

  it('rejects a paid order whose item aggregate no longer matches canonical payment evidence', async () => {
    const fixture = await createPurchase([1403]);
    await databaseClient.db.update(orderItems)
      .set({ unitSubtotalMinor: 1300, totalMinor: 1300 })
      .where(eq(orderItems.id, fixture.items[0]!.id));
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await expect(fulfillRefundEvent(
      databaseClient.db,
      snapshots(fixture, event, 500),
      dependencies()
    )).rejects.toBeInstanceOf(PermanentCommerceError);
    expect(await databaseClient.db.select().from(refunds)).toHaveLength(0);
    expect((await databaseClient.db.select().from(stripeEvents))[0]?.status).toBe('pending');
  });

  it('rejects a purchase grant that does not belong to its immutable order item title', async () => {
    const fixture = await createPurchase([1403]);
    const otherTitleId = randomUUID();
    await databaseClient.db.insert(titles).values({
      id: otherTitleId,
      slug: `refund-mismatch-${otherTitleId}`,
      title: 'Mismatched title',
      description: 'Mismatch fixture',
      creatorName: 'Mismatch creator',
      format: 'prose',
      priceMinor: 1403,
      currency: 'USD',
      visibility: 'private'
    });
    await databaseClient.db.update(entitlementGrants)
      .set({ titleId: otherTitleId })
      .where(eq(entitlementGrants.orderItemId, fixture.items[0]!.id));
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await expect(fulfillRefundEvent(
      databaseClient.db,
      snapshots(fixture, event, 1403),
      dependencies()
    )).rejects.toBeInstanceOf(PermanentCommerceError);
    expect(await databaseClient.db.select().from(refunds)).toHaveLength(0);
    expect((await databaseClient.db.select().from(stripeEvents))[0]?.status).toBe('pending');
  });

  it.each(['allocation', 'projection', 'email', 'audit', 'event'] as const)(
    'rolls every refund write back when %s persistence fails',
    async (failure) => {
      const fixture = await createPurchase([1403]);
      const event = await createRefundEvent(`re_test_${randomUUID()}`);
      const base = dependencies();
      const overrides: RefundFulfillmentDependencies = {
        ...base,
        ...(failure === 'allocation'
          ? { createAllocation: async () => { throw new Error('forced allocation failure'); } }
          : {}),
        ...(failure === 'projection'
          ? { projectEntitlement: async () => { throw new Error('forced projection failure'); } }
          : {}),
        ...(failure === 'email'
          ? {
              messages: {
                enqueueAccessChange: async () => { throw new Error('forced email failure'); }
              }
            }
          : {}),
        ...(failure === 'audit'
          ? { appendAuditEvent: async () => { throw new Error('forced audit failure'); } }
          : {}),
        ...(failure === 'event'
          ? { completeEvent: async () => { throw new Error('forced event failure'); } }
          : {})
      };
      await expect(fulfillRefundEvent(
        databaseClient.db,
        snapshots(fixture, event, 1403),
        overrides
      )).rejects.toThrow(`forced ${failure} failure`);
      expect(await databaseClient.db.select().from(refunds)).toHaveLength(0);
      expect(await databaseClient.db.select().from(refundAllocations)).toHaveLength(0);
      expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('active');
      expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt).toBeNull();
      expect((await databaseClient.db.select().from(stripeEvents))[0]?.status).toBe('pending');
      expect(await databaseClient.db.select().from(auditEvents)).toHaveLength(0);
      expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(0);
    }
  );

  it('keeps refund audit data aggregate and free of email, provider IDs, titles, and amounts', async () => {
    const fixture = await createPurchase([1403]);
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    const clock = vi.fn(() => now);
    await fulfillRefundEvent(
      databaseClient.db,
      snapshots(fixture, event, 500),
      dependencies({ now: clock })
    );
    expect(clock).toHaveBeenCalledOnce();
    const audit = await databaseClient.db.select().from(auditEvents);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toEqual({
      allocationState: 'allocated',
      affectedTitleCount: 0
    });
    expect(JSON.stringify(audit)).not.toMatch(/@example|re_test|Private|500|1403/iu);
  });
});
