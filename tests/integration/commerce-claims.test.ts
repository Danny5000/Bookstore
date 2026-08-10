import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { findOrCreateGuestIdentity } from '$lib/server/auth/identity';
import {
  claimGuestPurchases,
  requestGuestClaimEmails,
  type ClaimGuestPurchasesDependencies
} from '$lib/server/commerce/claims';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import { COMMERCE_CLAIM_REQUEST_JOB } from '$lib/server/commerce/claim-email';
import { projectEffectiveEntitlement } from '$lib/server/commerce/grants';
import {
  auditEvents,
  applicationRateLimits,
  disputes,
  entitlementGrants,
  entitlements,
  guestIdentities,
  jobs,
  orderItems,
  orders,
  payments,
  refundAllocations,
  refunds,
  titles,
  user
} from '$lib/server/db/schema';
import { databaseClient } from './database';

async function createUser(email: string, verified = true) {
  const [created] = await databaseClient.db.insert(user).values({
    id: randomUUID(),
    name: 'Claim reader',
    email: email.trim().toLowerCase(),
    emailVerified: verified
  }).returning();
  if (!created) throw new Error('Expected user');
  return created;
}

async function createTitle(label: string) {
  const id = randomUUID();
  const [title] = await databaseClient.db.insert(titles).values({
    id,
    slug: `claim-${id}`,
    title: label,
    description: `${label} description`,
    creatorName: `${label} creator`,
    format: 'prose',
    priceMinor: 1299,
    currency: 'USD',
    visibility: 'private'
  }).returning();
  if (!title) throw new Error('Expected title');
  return title;
}

async function createGuestPurchase(input: {
  email: string;
  titleId?: string;
  adverse?: 'open-dispute' | 'lost-dispute' | 'full-refund' | 'permanent';
}) {
  const identity = await findOrCreateGuestIdentity(databaseClient.db, input.email);
  const title = input.titleId
    ? { id: input.titleId }
    : await createTitle(`Claim title ${randomUUID()}`);
  const orderId = randomUUID();
  const itemId = randomUUID();
  const paymentIntentId = `pi_test_${orderId}`;
  const [order] = await databaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    initiatingUserId: null,
    guestIdentityId: identity.id,
    purchaseEmail: identity.email,
    currency: 'USD',
    subtotalMinor: 1299,
    taxMinor: 104,
    totalMinor: 1403,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: `cs_test_${orderId}`,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt: new Date('2026-08-10T12:05:00.000Z')
  }).returning();
  if (!order) throw new Error('Expected order');
  await databaseClient.db.insert(orderItems).values({
    id: itemId,
    orderId,
    titleId: title.id,
    titleSnapshot: 'Private claim title',
    creatorNameSnapshot: 'Private claim creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 1299,
    taxMinor: 104,
    totalMinor: 1403,
    stripeLineItemId: `li_test_${itemId}`
  });
  const [payment] = await databaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: paymentIntentId,
    stripeLatestChargeId: `ch_test_${orderId}`,
    status: 'succeeded',
    amountMinor: 1403,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt: new Date('2026-08-10T12:05:00.000Z')
  }).returning();
  if (!payment) throw new Error('Expected payment');
  await databaseClient.db.insert(entitlementGrants).values({
    titleId: title.id,
    userId: null,
    source: 'purchase',
    orderItemId: itemId,
    state: input.adverse === 'permanent' ? 'revoked' : 'unclaimed',
    stateReason: input.adverse === 'permanent' ? 'permanently_revoked' : 'payment_succeeded',
    grantedAt: new Date('2026-08-10T12:05:00.000Z'),
    revokedAt: input.adverse === 'permanent'
      ? new Date('2026-08-10T13:00:00.000Z')
      : null
  });
  if (input.adverse === 'full-refund') {
    const [refund] = await databaseClient.db.insert(refunds).values({
      paymentId: payment.id,
      stripeRefundId: `re_test_${orderId}`,
      status: 'succeeded',
      amountMinor: 1403,
      currency: 'USD',
      reason: 'requested_by_customer',
      providerCreatedAt: new Date('2026-08-10T13:00:00.000Z')
    }).returning();
    if (!refund) throw new Error('Expected refund');
    await databaseClient.db.insert(refundAllocations).values({
      refundId: refund.id,
      orderItemId: itemId,
      amountMinor: 1403,
      source: 'automatic'
    });
  }
  if (input.adverse === 'open-dispute' || input.adverse === 'lost-dispute') {
    const state = input.adverse === 'open-dispute' ? 'open' : 'lost';
    await databaseClient.db.insert(disputes).values({
      paymentId: payment.id,
      stripeDisputeId: `dp_test_${orderId}`,
      status: state,
      amountMinor: 1403,
      currency: 'USD',
      reason: 'fraudulent',
      providerCreatedAt: new Date('2026-08-10T13:00:00.000Z'),
      providerUpdatedAt: new Date('2026-08-10T13:05:00.000Z')
    });
  }
  return { identity, titleId: title.id, orderId, itemId };
}

function command(userId: string) {
  return { userId, correlationId: `claim-${randomUUID()}` };
}

describe('atomic guest purchase claiming', () => {
  it('claims every paid order, projects each unique scope once, and audits only aggregates', async () => {
    const email = ' multi-claim@example.com ';
    const claimant = await createUser(email);
    const sharedTitle = await createTitle('Shared claim title');
    const first = await createGuestPurchase({ email, titleId: sharedTitle.id });
    await createGuestPurchase({ email, titleId: sharedTitle.id });
    await createGuestPurchase({ email });
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(0);

    const project = vi.fn(projectEffectiveEntitlement);
    const result = await claimGuestPurchases(
      databaseClient.db,
      { ...command(claimant.id), correlationId: 'multi-claim@example.com' },
      { projectEntitlement: project }
    );

    expect(result).toEqual({
      claimed: true,
      changed: true,
      claimedOrderCount: 3,
      claimedTitleCount: 2
    });
    expect(project).toHaveBeenCalledTimes(2);
    expect(await databaseClient.db.select().from(entitlementGrants)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: claimant.id, state: 'active' })
      ])
    );
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(2);
    expect((await databaseClient.db.select().from(guestIdentities)
      .where(eq(guestIdentities.id, first.identity.id)))[0]).toMatchObject({
      claimedByUserId: claimant.id,
      claimedAt: expect.any(Date)
    });
    const audits = await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'commerce.guest_claimed'));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after).toEqual({
      claimedOrderCount: 3,
      claimedTitleCount: 2
    });
    expect(audits[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(audits)).not.toMatch(/multi-claim@|Private claim|pi_test|cs_test/iu);

    const replay = await claimGuestPurchases(databaseClient.db, command(claimant.id));
    expect(replay).toEqual({
      claimed: true,
      changed: false,
      claimedOrderCount: 3,
      claimedTitleCount: 2
    });
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'commerce.guest_claimed'))).toHaveLength(1);
  });

  it('derives active, suspended, and revoked states from locked financial facts', async () => {
    const email = 'claim-states@example.com';
    const claimant = await createUser(email);
    const active = await createGuestPurchase({ email });
    const suspended = await createGuestPurchase({ email, adverse: 'open-dispute' });
    const refunded = await createGuestPurchase({ email, adverse: 'full-refund' });
    const lost = await createGuestPurchase({ email, adverse: 'lost-dispute' });
    const permanent = await createGuestPurchase({ email, adverse: 'permanent' });

    await claimGuestPurchases(databaseClient.db, command(claimant.id));
    const grants = await databaseClient.db.select().from(entitlementGrants);
    const state = (itemId: string) => grants.find((grant) => grant.orderItemId === itemId)?.state;
    expect(state(active.itemId)).toBe('active');
    expect(state(suspended.itemId)).toBe('suspended');
    expect(state(refunded.itemId)).toBe('revoked');
    expect(state(lost.itemId)).toBe('revoked');
    expect(state(permanent.itemId)).toBe('revoked');
    expect(await databaseClient.db.select().from(entitlements)).toEqual([
      expect.objectContaining({ userId: claimant.id, titleId: active.titleId, revokedAt: null })
    ]);
  });

  it('denies unverified, different-email, and foreign-claimed identities generically', async () => {
    const purchase = await createGuestPurchase({ email: 'owner@example.com' });
    const unverified = await createUser('owner@example.com', false);
    await expect(claimGuestPurchases(databaseClient.db, command(unverified.id)))
      .rejects.toBeInstanceOf(PermanentCommerceError);
    await databaseClient.db.update(user)
      .set({ email: 'unverified-moved@example.com' })
      .where(eq(user.id, unverified.id));
    const otherEmail = await createUser('other@example.com');
    await expect(claimGuestPurchases(databaseClient.db, command(otherEmail.id)))
      .resolves.toEqual({
        claimed: false,
        changed: false,
        claimedOrderCount: 0,
        claimedTitleCount: 0
      });

    const firstClaimant = await createUser('owner@example.com');
    await claimGuestPurchases(databaseClient.db, command(firstClaimant.id));
    const replacement = await createUser('replacement@example.com');
    await databaseClient.db.update(user)
      .set({ email: 'moved@example.com' })
      .where(eq(user.id, firstClaimant.id));
    await databaseClient.db.update(user)
      .set({ email: 'owner@example.com' })
      .where(eq(user.id, replacement.id));
    await expect(claimGuestPurchases(databaseClient.db, command(replacement.id)))
      .rejects.toMatchObject({
        code: 'IDENTITY_ALREADY_CLAIMED'
      });
    expect((await databaseClient.db.select().from(entitlementGrants)
      .where(eq(entitlementGrants.orderItemId, purchase.itemId)))[0]?.userId)
      .toBe(firstClaimant.id);
  });

  it('serializes concurrent same-user claims to one transition and one audit', async () => {
    const email = 'concurrent-claim@example.com';
    const claimant = await createUser(email);
    await createGuestPurchase({ email });
    await createGuestPurchase({ email });
    const [first, second] = await Promise.all([
      claimGuestPurchases(databaseClient.db, command(claimant.id)),
      claimGuestPurchases(databaseClient.db, command(claimant.id))
    ]);
    expect([first.changed, second.changed].sort()).toEqual([false, true]);
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'commerce.guest_claimed'))).toHaveLength(1);
  });

  it('rolls identity, grants, entitlements, and audit back after a mid-claim failure', async () => {
    const email = 'rollback-claim@example.com';
    const claimant = await createUser(email);
    const first = await createGuestPurchase({ email });
    await createGuestPurchase({ email });
    let projections = 0;
    const dependencies: ClaimGuestPurchasesDependencies = {
      projectEntitlement: async (...args) => {
        projections += 1;
        await projectEffectiveEntitlement(...args);
        if (projections === 2) throw new Error('forced claim projection failure');
        return { beforeActive: false, afterActive: true };
      }
    };

    await expect(claimGuestPurchases(
      databaseClient.db,
      command(claimant.id),
      dependencies
    )).rejects.toThrow('forced claim projection failure');
    expect((await databaseClient.db.select().from(guestIdentities)
      .where(eq(guestIdentities.id, first.identity.id)))[0]).toMatchObject({
      claimedByUserId: null,
      claimedAt: null
    });
    expect(await databaseClient.db.select().from(entitlementGrants)).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: null, state: 'unclaimed' })])
    );
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(0);
    expect(await databaseClient.db.select().from(auditEvents)).toHaveLength(0);
  });
});

describe('enumeration-resistant claim requests', () => {
  it('rate-limits a private HMAC scope and enqueues only deduplicated order IDs', async () => {
    const email = 'claim-request@example.com';
    const first = await createGuestPurchase({ email });
    const second = await createGuestPurchase({ email });
    const input = {
      email: ` ${email.toUpperCase()} `,
      requestIp: '203.0.113.91',
      applicationSecret: 'claim-request-application-secret',
      windowSeconds: 60,
      maxAttempts: 2,
      now: new Date('2026-08-10T14:00:00.000Z')
    };

    await expect(requestGuestClaimEmails(databaseClient.db, input)).resolves.toBeUndefined();
    await expect(requestGuestClaimEmails(databaseClient.db, input)).resolves.toBeUndefined();
    await expect(requestGuestClaimEmails(databaseClient.db, input)).resolves.toBeUndefined();

    const queued = await databaseClient.db.select().from(jobs);
    expect(queued).toHaveLength(2);
    expect(queued.map((job) => job.payload)).toEqual(expect.arrayContaining([
      { orderId: first.orderId },
      { orderId: second.orderId }
    ]));
    expect(queued.every((job) => job.type === COMMERCE_CLAIM_REQUEST_JOB)).toBe(true);
    expect(queued.map((job) => job.deduplicationKey)).toEqual(expect.arrayContaining([
      `commerce:claim-request:order:${first.orderId}:window:29772840:v1`,
      `commerce:claim-request:order:${second.orderId}:window:29772840:v1`
    ]));
    const limits = await databaseClient.db.select().from(applicationRateLimits);
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      namespace: 'commerce.claim-request',
      count: 3,
      scopeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(JSON.stringify({ queued, limits })).not.toMatch(
      /claim-request@|203\.0\.113\.91/iu
    );
  });

  it('is a successful no-op for absent and already-claimed identities', async () => {
    await expect(requestGuestClaimEmails(databaseClient.db, {
      email: 'absent@example.com',
      requestIp: '203.0.113.92',
      applicationSecret: 'claim-request-application-secret',
      windowSeconds: 60,
      maxAttempts: 3
    })).resolves.toBeUndefined();

    const email = 'already-claimed@example.com';
    await createGuestPurchase({ email });
    const claimant = await createUser(email);
    await claimGuestPurchases(databaseClient.db, command(claimant.id));
    await expect(requestGuestClaimEmails(databaseClient.db, {
      email,
      requestIp: '203.0.113.93',
      applicationSecret: 'claim-request-application-secret',
      windowSeconds: 60,
      maxAttempts: 3
    })).resolves.toBeUndefined();
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(0);
  });
});
