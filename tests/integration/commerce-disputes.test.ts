import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  fulfillDisputeEvent,
  type DisputeFulfillmentDependencies
} from '$lib/server/commerce/disputes';
import { createCommerceMessageEnqueuer } from '$lib/server/commerce/email/enqueue';
import { parseCommerceEmailPayload } from '$lib/server/commerce/email/payload';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import { projectEffectiveEntitlement } from '$lib/server/commerce/grants';
import {
  auditEvents,
  disputes,
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

const fixedNow = new Date('2026-08-10T16:00:00.000Z');

interface Fixture {
  orderId: string;
  paymentId: string;
  paymentIntentId: string;
  userId: string | null;
  email: string;
  items: Array<{ id: string; titleId: string; totalMinor: number }>;
}

async function createPurchase(
  totals: readonly number[] = [1403],
  owner: 'account' | 'guest' = 'account'
): Promise<Fixture> {
  const orderId = randomUUID();
  const email = `dispute-${orderId}@example.com`;
  let userId: string | null = null;
  let guestIdentityId: string | null = null;
  if (owner === 'account') {
    userId = randomUUID();
    await databaseClient.db.insert(user).values({
      id: userId,
      name: 'Dispute reader',
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
    quoteFingerprintSha256: 'c'.repeat(64),
    stripeCheckoutSessionId: `cs_test_${orderId}`,
    statusTokenSha256: 'd'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt: new Date('2026-08-10T12:05:00.000Z')
  });
  const items: Fixture['items'] = [];
  for (const [index, total] of totals.entries()) {
    const titleId = randomUUID();
    const itemId = randomUUID();
    await databaseClient.db.insert(titles).values({
      id: titleId,
      slug: `dispute-title-${titleId}`,
      title: `Private dispute title ${index}`,
      description: 'Private dispute fixture',
      creatorName: 'Private creator',
      format: 'prose',
      priceMinor: total,
      currency: 'USD',
      visibility: 'private'
    });
    await databaseClient.db.insert(orderItems).values({
      id: itemId,
      orderId,
      titleId,
      titleSnapshot: `Private dispute title ${index}`,
      creatorNameSnapshot: 'Private creator',
      format: 'prose',
      currency: 'USD',
      unitSubtotalMinor: total,
      taxMinor: 0,
      totalMinor: total,
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
    items.push({ id: itemId, titleId, totalMinor: total });
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
        await projectEffectiveEntitlement(transaction, userId!, item.titleId, fixedNow);
      }
    });
  }
  return { orderId, paymentId: payment.id, paymentIntentId, userId, email, items };
}

async function createDisputeEvent(
  providerDisputeId: string,
  sequence: number,
  providerCreatedAt = new Date(`2026-08-10T14:0${sequence}:00.000Z`)
) {
  const [event] = await databaseClient.db.insert(stripeEvents).values({
    providerEventId: `evt_dispute_${sequence}_${randomUUID()}`,
    eventType: 'charge.dispute.updated',
    objectId: providerDisputeId,
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt,
    rawBodySha256: (sequence + 10).toString(16).padStart(64, '0')
  }).returning();
  if (!event) throw new Error('Expected event');
  return event;
}

function command(
  fixture: Fixture,
  event: { id: string; objectId: string },
  state: 'open' | 'won' | 'lost',
  _sequence: number
) {
  return {
    stripeEventId: event.id,
    dispute: {
      providerDisputeId: event.objectId,
      paymentIntentId: fixture.paymentIntentId,
      chargeId: `ch_test_${fixture.orderId}`,
      liveMode: false,
      state,
      amountMinor: fixture.items.reduce((sum, item) => sum + item.totalMinor, 0),
      currency: 'usd',
      reason: 'fraudulent',
      providerCreatedAt: new Date('2026-08-10T14:00:00.000Z')
    },
    payment: {
      paymentIntentId: fixture.paymentIntentId,
      metadataVersion: '1' as const,
      metadataOrderId: fixture.orderId,
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
  overrides: Partial<DisputeFulfillmentDependencies> = {}
): DisputeFulfillmentDependencies {
  return {
    messages: createCommerceMessageEnqueuer(applicationConfig.origin),
    now: () => fixedNow,
    ...overrides
  };
}

async function accessMessages() {
  return (await databaseClient.db.select().from(outboxMessages))
    .map((row) => parseCommerceEmailPayload(row.payload, applicationConfig.origin));
}

describe('canonical dispute fulfillment', () => {
  it('suspends every otherwise-active payment grant and sends one aggregate opened message', async () => {
    const fixture = await createPurchase([1000, 1500]);
    const event = await createDisputeEvent(`dp_test_${randomUUID()}`, 1);
    const orderBefore = await databaseClient.db.select().from(orders);
    const paymentBefore = await databaseClient.db.select().from(payments);
    const itemsBefore = await databaseClient.db.select().from(orderItems);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, event, 'open', 1), dependencies());
    expect((await databaseClient.db.select().from(disputes))[0]).toMatchObject({
      status: 'open',
      financialEvidenceStatus: 'pending'
    });
    expect((await databaseClient.db.select().from(entitlementGrants))
      .every((grant) => grant.state === 'suspended')).toBe(true);
    expect((await databaseClient.db.select().from(entitlements))
      .every((entitlement) => entitlement.revokedAt instanceof Date)).toBe(true);
    expect(await accessMessages()).toEqual([
      expect.objectContaining({
        template: 'commerce.dispute-access-changed',
        reasonCategory: 'dispute_opened',
        affectedTitleCount: 2
      })
    ]);
    expect(await databaseClient.db.select().from(orders)).toEqual(orderBefore);
    expect(await databaseClient.db.select().from(payments)).toEqual(paymentBefore);
    expect(await databaseClient.db.select().from(orderItems)).toEqual(itemsBefore);
  });

  it('restores access after canonical won state and ignores an older out-of-order open snapshot', async () => {
    const fixture = await createPurchase();
    const disputeId = `dp_test_${randomUUID()}`;
    const opened = await createDisputeEvent(disputeId, 1);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, opened, 'open', 1), dependencies());
    const won = await createDisputeEvent(disputeId, 2);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, won, 'won', 2), dependencies());
    expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('active');
    expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt).toBeNull();
    expect((await accessMessages()).map((message) =>
      'reasonCategory' in message ? message.reasonCategory : null
    )).toEqual(['dispute_opened', 'dispute_resolved']);

    const stale = await createDisputeEvent(
      disputeId,
      3,
      new Date('2026-08-10T14:01:30.000Z')
    );
    await fulfillDisputeEvent(databaseClient.db, command(fixture, stale, 'open', 1), dependencies());
    expect((await databaseClient.db.select().from(disputes))[0]?.status).toBe('won');
    expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('active');
    expect(await accessMessages()).toHaveLength(2);
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, stale.id)))[0]?.status).toBe('processed');
  });

  it.each([
    ['won', 'active'],
    ['lost', 'revoked']
  ] as const)(
    'advances an open dispute to %s when signed events share the same provider second',
    async (terminalState, expectedGrantState) => {
      const fixture = await createPurchase();
      const disputeId = `dp_test_${randomUUID()}`;
      const sharedSecond = new Date('2026-08-10T14:01:00.000Z');
      const opened = await createDisputeEvent(disputeId, 1, sharedSecond);
      await fulfillDisputeEvent(
        databaseClient.db,
        command(fixture, opened, 'open', 1),
        dependencies()
      );
      const terminal = await createDisputeEvent(disputeId, 2, sharedSecond);
      await fulfillDisputeEvent(
        databaseClient.db,
        command(fixture, terminal, terminalState, 2),
        dependencies()
      );

      expect((await databaseClient.db.select().from(disputes))[0]?.status).toBe(terminalState);
      expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state)
        .toBe(expectedGrantState);
      expect((await databaseClient.db.select().from(stripeEvents)
        .where(eq(stripeEvents.id, terminal.id)))[0]?.status).toBe('processed');
    }
  );

  it('does not regress a terminal dispute to open at the same provider second', async () => {
    const fixture = await createPurchase();
    const disputeId = `dp_test_${randomUUID()}`;
    const sharedSecond = new Date('2026-08-10T14:01:00.000Z');
    const won = await createDisputeEvent(disputeId, 1, sharedSecond);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, won, 'won', 1), dependencies());
    const delayedOpen = await createDisputeEvent(disputeId, 2, sharedSecond);

    await fulfillDisputeEvent(
      databaseClient.db,
      command(fixture, delayedOpen, 'open', 2),
      dependencies()
    );

    expect((await databaseClient.db.select().from(disputes))[0]?.status).toBe('won');
    expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('active');
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, delayedOpen.id)))[0]?.status).toBe('processed');
  });

  it('does not regress a terminal dispute to a later open snapshot', async () => {
    const fixture = await createPurchase();
    const disputeId = `dp_test_${randomUUID()}`;
    const won = await createDisputeEvent(disputeId, 1);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, won, 'won', 1), dependencies());
    const laterOpen = await createDisputeEvent(disputeId, 2);

    await fulfillDisputeEvent(
      databaseClient.db,
      command(fixture, laterOpen, 'open', 2),
      dependencies()
    );

    expect((await databaseClient.db.select().from(disputes))[0]?.status).toBe('won');
    expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('active');
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, laterOpen.id)))[0]?.status).toBe('processed');
  });

  it('rejects conflicting terminal dispute states at the same provider second', async () => {
    const fixture = await createPurchase();
    const disputeId = `dp_test_${randomUUID()}`;
    const sharedSecond = new Date('2026-08-10T14:01:00.000Z');
    const won = await createDisputeEvent(disputeId, 1, sharedSecond);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, won, 'won', 1), dependencies());
    const lost = await createDisputeEvent(disputeId, 2, sharedSecond);

    await expect(fulfillDisputeEvent(
      databaseClient.db,
      command(fixture, lost, 'lost', 2),
      dependencies()
    )).rejects.toBeInstanceOf(PermanentCommerceError);

    expect((await databaseClient.db.select().from(disputes))[0]?.status).toBe('won');
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, lost.id)))[0]?.status).toBe('pending');
  });

  it('rejects a later conflicting terminal state and preserves permanent loss', async () => {
    const fixture = await createPurchase();
    const disputeId = `dp_test_${randomUUID()}`;
    const lost = await createDisputeEvent(disputeId, 1);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, lost, 'lost', 1), dependencies());
    const won = await createDisputeEvent(disputeId, 2);
    await expect(fulfillDisputeEvent(
      databaseClient.db,
      command(fixture, won, 'won', 2),
      dependencies()
    )).rejects.toBeInstanceOf(PermanentCommerceError);
    expect((await databaseClient.db.select().from(disputes))[0]?.status).toBe('lost');
    expect((await databaseClient.db.select().from(entitlementGrants))[0]).toMatchObject({
      state: 'revoked',
      stateReason: 'dispute_lost'
    });
    expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt)
      .toEqual(expect.any(Date));
    expect(await accessMessages()).toHaveLength(1);
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, won.id)))[0]?.status).toBe('pending');
  });

  it('does not restore a fully refunded grant after a won dispute', async () => {
    const fixture = await createPurchase();
    const [refund] = await databaseClient.db.insert(refunds).values({
      paymentId: fixture.paymentId,
      stripeRefundId: `re_test_${randomUUID()}`,
      status: 'succeeded',
      amountMinor: 1403,
      currency: 'USD',
      reason: 'requested_by_customer',
      providerCreatedAt: new Date('2026-08-10T13:00:00.000Z')
    }).returning();
    if (!refund) throw new Error('Expected refund');
    await databaseClient.db.insert(refundAllocations).values({
      refundId: refund.id,
      orderItemId: fixture.items[0]!.id,
      amountMinor: 1403,
      source: 'automatic'
    });
    const event = await createDisputeEvent(`dp_test_${randomUUID()}`, 1);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, event, 'won', 1), dependencies());
    expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('revoked');
    expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt)
      .toEqual(expect.any(Date));
  });

  it('keeps effective access when a preserved grant remains active', async () => {
    const fixture = await createPurchase();
    await databaseClient.db.insert(entitlementGrants).values({
      userId: fixture.userId!,
      titleId: fixture.items[0]!.titleId,
      source: 'preserved',
      state: 'active',
      stateReason: 'administrative_preservation',
      grantedAt: fixedNow
    });
    const event = await createDisputeEvent(`dp_test_${randomUUID()}`, 1);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, event, 'open', 1), dependencies());
    expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt).toBeNull();
    expect(await accessMessages()).toHaveLength(0);
  });

  it('changes guest grant state without creating access or sending mail', async () => {
    const fixture = await createPurchase([1403], 'guest');
    const disputeId = `dp_test_${randomUUID()}`;
    const opened = await createDisputeEvent(disputeId, 1);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, opened, 'open', 1), dependencies());
    expect((await databaseClient.db.select().from(entitlementGrants))[0]).toMatchObject({
      userId: null,
      state: 'suspended'
    });
    const won = await createDisputeEvent(disputeId, 2);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, won, 'won', 2), dependencies());
    expect((await databaseClient.db.select().from(entitlementGrants))[0]).toMatchObject({
      userId: null,
      state: 'unclaimed'
    });
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(0);
    expect(await accessMessages()).toHaveLength(0);
  });

  it('converges concurrent disputes by lost/open/won precedence', async () => {
    const fixture = await createPurchase();
    const openEvent = await createDisputeEvent(`dp_test_${randomUUID()}`, 1);
    const wonEvent = await createDisputeEvent(`dp_test_${randomUUID()}`, 2);
    await Promise.all([
      fulfillDisputeEvent(databaseClient.db, command(fixture, openEvent, 'open', 1), dependencies()),
      fulfillDisputeEvent(databaseClient.db, command(fixture, wonEvent, 'won', 2), dependencies())
    ]);
    expect((await databaseClient.db.select().from(disputes)).map((row) => row.status).sort())
      .toEqual(['open', 'won']);
    expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('suspended');
    expect((await databaseClient.db.select().from(outboxMessages))).toHaveLength(1);
  });

  it.each(['store', 'projection', 'email', 'audit', 'event'] as const)(
    'rolls the entire dispute transition back when %s persistence fails',
    async (failure) => {
      const fixture = await createPurchase();
      const event = await createDisputeEvent(`dp_test_${randomUUID()}`, 1);
      const base = dependencies();
      const overrides: DisputeFulfillmentDependencies = {
        ...base,
        ...(failure === 'store'
          ? { storeDispute: async () => { throw new Error('forced store failure'); } }
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
      await expect(fulfillDisputeEvent(
        databaseClient.db,
        command(fixture, event, 'open', 1),
        overrides
      )).rejects.toThrow(`forced ${failure} failure`);
      expect(await databaseClient.db.select().from(disputes)).toHaveLength(0);
      expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('active');
      expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt).toBeNull();
      expect((await databaseClient.db.select().from(stripeEvents))[0]?.status).toBe('pending');
      expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(0);
      expect(await databaseClient.db.select().from(auditEvents)).toHaveLength(0);
    }
  );

  it('writes only aggregate minimized audit state', async () => {
    const fixture = await createPurchase();
    const event = await createDisputeEvent(`dp_test_${randomUUID()}`, 1);
    await fulfillDisputeEvent(databaseClient.db, command(fixture, event, 'open', 1), dependencies());
    const audit = await databaseClient.db.select().from(auditEvents);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toEqual({
      disputeState: 'suspended',
      affectedTitleCount: 1
    });
    expect(JSON.stringify(audit)).not.toMatch(/@example|dp_test|Private|1403|fraud/iu);
  });
});
