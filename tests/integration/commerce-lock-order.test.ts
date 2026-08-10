import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { claimGuestPurchases } from '$lib/server/commerce/claims';
import { fulfillDisputeEvent } from '$lib/server/commerce/disputes';
import { setPreservedGrantState } from '$lib/server/commerce/grants';
import { fulfillRefundEvent } from '$lib/server/commerce/refunds';
import {
  disputes,
  entitlementGrants,
  guestIdentities,
  orderItems,
  orders,
  payments,
  refunds,
  stripeEvents,
  titles,
  user
} from '$lib/server/db/schema';
import { databaseClient } from './database';

const paidAt = new Date('2026-08-10T12:05:00.000Z');
const providerCreatedAt = new Date('2026-08-10T14:00:00.000Z');
const eventCreatedAt = new Date('2026-08-10T14:01:00.000Z');

interface LockFixture {
  claimantId: string;
  disputeId: string;
  grantId: string;
  itemId: string;
  orderId: string;
  paymentId: string;
  paymentIntentId: string;
  refundId: string;
  stripeDisputeId: string;
  stripeRefundId: string;
  titleId: string;
}

async function createLockFixture(
  options: { assignedPurchase?: boolean } = {}
): Promise<LockFixture> {
  const orderId = randomUUID();
  const itemId = randomUUID();
  const titleId = randomUUID();
  const claimantId = randomUUID();
  const email = `lock-order-${orderId}@example.com`;
  const paymentIntentId = `pi_lock_${orderId}`;
  const stripeDisputeId = `dp_lock_${orderId}`;
  const stripeRefundId = `re_lock_${orderId}`;

  const [identity] = await databaseClient.db.insert(guestIdentities).values({ email }).returning();
  if (!identity) throw new Error('Expected guest identity');
  await databaseClient.db.insert(user).values({
    id: claimantId,
    name: 'Lock-order reader',
    email,
    emailVerified: true
  });
  await databaseClient.db.insert(titles).values({
    id: titleId,
    slug: `lock-order-${titleId}`,
    title: 'Private lock-order title',
    description: 'Private lock-order fixture',
    creatorName: 'Private creator',
    format: 'prose',
    priceMinor: 1403,
    currency: 'USD',
    visibility: 'private'
  });
  await databaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    initiatingUserId: null,
    guestIdentityId: identity.id,
    purchaseEmail: email,
    currency: 'USD',
    subtotalMinor: 1403,
    taxMinor: 0,
    totalMinor: 1403,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: `cs_lock_${orderId}`,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt
  });
  await databaseClient.db.insert(orderItems).values({
    id: itemId,
    orderId,
    titleId,
    titleSnapshot: 'Private lock-order title',
    creatorNameSnapshot: 'Private creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 1403,
    taxMinor: 0,
    totalMinor: 1403,
    stripeLineItemId: `li_lock_${itemId}`
  });
  const [payment] = await databaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: paymentIntentId,
    stripeLatestChargeId: `ch_lock_${orderId}`,
    status: 'succeeded',
    amountMinor: 1403,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt
  }).returning();
  if (!payment) throw new Error('Expected payment');
  const [grant] = await databaseClient.db.insert(entitlementGrants).values({
    titleId,
    userId: options.assignedPurchase ? claimantId : null,
    source: 'purchase',
    orderItemId: itemId,
    state: options.assignedPurchase ? 'active' : 'unclaimed',
    stateReason: 'payment_succeeded',
    grantedAt: paidAt
  }).returning();
  if (!grant) throw new Error('Expected purchase grant');
  const [refund] = await databaseClient.db.insert(refunds).values({
    paymentId: payment.id,
    stripeRefundId,
    status: 'pending',
    amountMinor: 1403,
    currency: 'USD',
    reason: 'requested_by_customer',
    providerCreatedAt
  }).returning();
  if (!refund) throw new Error('Expected refund');
  const [dispute] = await databaseClient.db.insert(disputes).values({
    paymentId: payment.id,
    stripeDisputeId,
    status: 'open',
    amountMinor: 1403,
    currency: 'USD',
    reason: 'fraudulent',
    providerCreatedAt,
    providerUpdatedAt: eventCreatedAt
  }).returning();
  if (!dispute) throw new Error('Expected dispute');

  return {
    claimantId,
    disputeId: dispute.id,
    grantId: grant.id,
    itemId,
    orderId,
    paymentId: payment.id,
    paymentIntentId,
    refundId: refund.id,
    stripeDisputeId,
    stripeRefundId,
    titleId
  };
}

async function waitForBlockedRowLock(
  relation: 'entitlement_grants' | 'orders' | 'refunds'
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await databaseClient.pool.query<{ blocked: boolean }>(`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike $1
      ) as blocked
    `, [`%from "${relation}"%for update%`]);
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected commerce transaction to wait for the held ${relation} row`);
}

async function beginBlocker(refundId: string): Promise<PoolClient> {
  const blocker = await databaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query('select id from refunds where id = $1 for update', [refundId]);
  return blocker;
}

async function beginOrderBlocker(orderId: string): Promise<PoolClient> {
  const blocker = await databaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query('select id from orders where id = $1 for update', [orderId]);
  return blocker;
}

async function beginGrantBlocker(grantId: string): Promise<PoolClient> {
  const blocker = await databaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query('select id from entitlement_grants where id = $1 for update', [grantId]);
  return blocker;
}

async function beginClaimCreationBlocker(
  refundId: string,
  grantId: string
): Promise<PoolClient> {
  const blocker = await databaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query('select id from refunds where id = $1 for update', [refundId]);
  await blocker.query('select id from entitlement_grants where id = $1 for update', [grantId]);
  return blocker;
}

async function waitForBlockedLockCount(minimum: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await databaseClient.pool.query<{ blocked: number }>(`
      select count(*)::int as blocked
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and application_name = 'pale-orbit'
        and wait_event_type = 'Lock'
    `);
    if ((result.rows[0]?.blocked ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected at least ${minimum} blocked commerce transactions`);
}

async function releaseBlocker(blocker: PoolClient): Promise<void> {
  try {
    await blocker.query('rollback');
  } finally {
    blocker.release();
  }
}

async function createDisputeEvent(fixture: LockFixture): Promise<string> {
  const [event] = await databaseClient.db.insert(stripeEvents).values({
    providerEventId: `evt_lock_${randomUUID()}`,
    eventType: 'charge.dispute.updated',
    objectId: fixture.stripeDisputeId,
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: eventCreatedAt,
    rawBodySha256: 'c'.repeat(64)
  }).returning();
  if (!event) throw new Error('Expected Stripe event');
  return event.id;
}

function reconcileDispute(fixture: LockFixture, stripeEventId: string): Promise<void> {
  return fulfillDisputeEvent(databaseClient.db, {
    stripeEventId,
    dispute: {
      providerDisputeId: fixture.stripeDisputeId,
      paymentIntentId: fixture.paymentIntentId,
      chargeId: `ch_lock_${fixture.orderId}`,
      liveMode: false,
      state: 'open',
      amountMinor: 1403,
      currency: 'usd',
      reason: 'fraudulent',
      providerCreatedAt
    },
    payment: {
      paymentIntentId: fixture.paymentIntentId,
      latestChargeId: `ch_lock_${fixture.orderId}`,
      liveMode: false,
      state: 'succeeded',
      amountMinor: 1403,
      currency: 'usd',
      paidAt,
      paymentMethodCategory: 'card'
    }
  }, {
    messages: { enqueueAccessChange: async () => undefined },
    now: () => new Date('2026-08-10T16:00:00.000Z')
  });
}

async function createRefundEvent(fixture: LockFixture): Promise<string> {
  const [event] = await databaseClient.db.insert(stripeEvents).values({
    providerEventId: `evt_lock_refund_${randomUUID()}`,
    eventType: 'refund.updated',
    objectId: fixture.stripeRefundId,
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: eventCreatedAt,
    rawBodySha256: 'd'.repeat(64)
  }).returning();
  if (!event) throw new Error('Expected Stripe refund event');
  return event.id;
}

function reconcileRefund(fixture: LockFixture, stripeEventId: string): Promise<void> {
  return fulfillRefundEvent(databaseClient.db, {
    stripeEventId,
    refund: {
      providerRefundId: fixture.stripeRefundId,
      paymentIntentId: fixture.paymentIntentId,
      liveMode: false,
      state: 'succeeded',
      amountMinor: 1403,
      currency: 'usd',
      reason: 'requested_by_customer',
      providerCreatedAt
    },
    payment: {
      paymentIntentId: fixture.paymentIntentId,
      latestChargeId: `ch_lock_${fixture.orderId}`,
      liveMode: false,
      state: 'succeeded',
      amountMinor: 1403,
      currency: 'usd',
      paidAt,
      paymentMethodCategory: 'card'
    }
  }, {
    messages: { enqueueAccessChange: async () => undefined },
    now: () => new Date('2026-08-10T16:00:00.000Z')
  });
}

async function setPreservedGrant(fixture: LockFixture): Promise<void> {
  await databaseClient.db.transaction(async (transaction) => {
    await setPreservedGrantState(transaction, {
      userId: fixture.claimantId,
      titleId: fixture.titleId,
      active: true,
      stateReason: 'lock_order_regression',
      now: new Date('2026-08-10T15:00:00.000Z')
    });
  });
}

async function expectNoEntitlementDeadlock(
  fixture: LockFixture,
  operation: () => Promise<unknown>
): Promise<void> {
  await databaseClient.db.insert(entitlementGrants).values({
    titleId: fixture.titleId,
    userId: fixture.claimantId,
    source: 'preserved',
    state: 'active',
    stateReason: 'lock_order_fixture',
    grantedAt: new Date('2026-08-10T14:30:00.000Z')
  });
  const blocker = await beginGrantBlocker(fixture.grantId);
  let released = false;
  const mutation = operation();
  let preservation: Promise<void> | undefined;
  void mutation.catch(() => undefined);

  try {
    await waitForBlockedRowLock('entitlement_grants');
    preservation = setPreservedGrant(fixture);
    void preservation.catch(() => undefined);
    await waitForBlockedLockCount(2);
    await blocker.query('commit');
    released = true;
    blocker.release();

    const results = await Promise.allSettled([mutation, preservation]);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejected) throw rejected.reason;
  } finally {
    if (!released) await releaseBlocker(blocker).catch(() => undefined);
    await Promise.allSettled(preservation ? [mutation, preservation] : [mutation]);
  }
}

async function expectNoClaimCreationDeadlock(fixture: LockFixture): Promise<void> {
  const blocker = await beginClaimCreationBlocker(fixture.refundId, fixture.grantId);
  let released = false;
  const claim = claimGuestPurchases(databaseClient.db, {
    userId: fixture.claimantId,
    correlationId: `lock-order-new-preserved-claim-${fixture.orderId}`
  });
  let preservation: Promise<void> | undefined;
  void claim.catch(() => undefined);

  try {
    await waitForBlockedRowLock('refunds');
    preservation = setPreservedGrant(fixture);
    void preservation.catch(() => undefined);
    await waitForBlockedLockCount(2);
    await blocker.query('commit');
    released = true;
    blocker.release();

    const results = await Promise.allSettled([claim, preservation]);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejected) throw rejected.reason;
  } finally {
    if (!released) await releaseBlocker(blocker).catch(() => undefined);
    await Promise.allSettled(preservation ? [claim, preservation] : [claim]);
  }
}

describe('commerce transaction lock order', () => {
  it('lets a refund holder lock an item while a guest claim waits on the refund', async () => {
    const fixture = await createLockFixture();
    const blocker = await beginBlocker(fixture.refundId);
    const claim = claimGuestPurchases(databaseClient.db, {
      userId: fixture.claimantId,
      correlationId: `lock-order-claim-${fixture.orderId}`
    });
    void claim.catch(() => undefined);

    try {
      await waitForBlockedRowLock('refunds');
      await expect(blocker.query(
        'select id from order_items where id = $1 for update',
        [fixture.itemId]
      )).resolves.toBeDefined();
      await blocker.query('commit');
      await expect(claim).resolves.toMatchObject({ claimed: true, changed: true });
      blocker.release();
    } catch (error) {
      await releaseBlocker(blocker).catch(() => undefined);
      await claim.catch(() => undefined);
      throw error;
    }
  }, 15_000);

  it('lets a refund holder lock a dispute while dispute reconciliation waits on the refund', async () => {
    const fixture = await createLockFixture();
    const stripeEventId = await createDisputeEvent(fixture);
    const blocker = await beginBlocker(fixture.refundId);
    const reconciliation = reconcileDispute(fixture, stripeEventId);
    void reconciliation.catch(() => undefined);

    try {
      await waitForBlockedRowLock('refunds');
      await expect(blocker.query(
        'select id from disputes where id = $1 for update',
        [fixture.disputeId]
      )).resolves.toBeDefined();
      await blocker.query('commit');
      await expect(reconciliation).resolves.toBeUndefined();
      blocker.release();
    } catch (error) {
      await releaseBlocker(blocker).catch(() => undefined);
      await reconciliation.catch(() => undefined);
      throw error;
    }
  }, 15_000);

  it('lets an order holder lock its payment while reconciliation waits on the order', async () => {
    const fixture = await createLockFixture();
    const stripeEventId = await createDisputeEvent(fixture);
    const blocker = await beginOrderBlocker(fixture.orderId);
    const reconciliation = reconcileDispute(fixture, stripeEventId);
    void reconciliation.catch(() => undefined);

    try {
      await waitForBlockedRowLock('orders');
      await expect(blocker.query(
        'select id from payments where id = $1 for update',
        [fixture.paymentId]
      )).resolves.toBeDefined();
      await blocker.query('commit');
      await expect(reconciliation).resolves.toBeUndefined();
      blocker.release();
    } catch (error) {
      await releaseBlocker(blocker).catch(() => undefined);
      await reconciliation.catch(() => undefined);
      throw error;
    }
  }, 15_000);

  it('serializes refund reconciliation with preserved-grant changes without deadlocking', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });
    const stripeEventId = await createRefundEvent(fixture);

    await expectNoEntitlementDeadlock(
      fixture,
      () => reconcileRefund(fixture, stripeEventId)
    );
  }, 15_000);

  it('serializes dispute reconciliation with preserved-grant changes without deadlocking', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });
    const stripeEventId = await createDisputeEvent(fixture);

    await expectNoEntitlementDeadlock(
      fixture,
      () => reconcileDispute(fixture, stripeEventId)
    );
  }, 15_000);

  it('serializes guest claims with preserved-grant changes without deadlocking', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });

    await expectNoEntitlementDeadlock(
      fixture,
      () => claimGuestPurchases(databaseClient.db, {
        userId: fixture.claimantId,
        correlationId: `lock-order-preserved-claim-${fixture.orderId}`
      })
    );
  }, 15_000);

  it('serializes guest claims with preserved-grant creation without deadlocking', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });

    await expectNoClaimCreationDeadlock(fixture);
  }, 15_000);
});
