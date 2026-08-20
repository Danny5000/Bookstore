import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { commerceClaimTokenSha256 } from '$lib/server/auth/commerce-claim-capability';
import { findOrCreateGuestIdentity } from '$lib/server/auth/identity';
import { createCommerceClaimAuthorization } from './commerce-claim-capability';
import {
  claimGuestPurchases,
  requestGuestClaimEmails
} from '$lib/server/commerce/claims';
import { COMMERCE_CLAIM_REQUEST_JOB } from '$lib/server/commerce/claim-email';
import {
  auditEvents,
  account,
  applicationRateLimits,
  commerceClaimIssuances,
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
import { databaseClient, ownerDatabaseClient, workerDatabaseClient } from './database';

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
  const identity = await findOrCreateGuestIdentity(workerDatabaseClient.db, input.email);
  const title = input.titleId
    ? { id: input.titleId }
    : await createTitle(`Claim title ${randomUUID()}`);
  const orderId = randomUUID();
  const itemId = randomUUID();
  const paymentIntentId = `pi_test_${orderId}`;
  const [order] = await ownerDatabaseClient.db.insert(orders).values({
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
  await ownerDatabaseClient.db.insert(orderItems).values({
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
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
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
  await ownerDatabaseClient.db.insert(entitlementGrants).values({
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
    const [refund] = await ownerDatabaseClient.db.insert(refunds).values({
      paymentId: payment.id,
      stripeRefundId: `re_test_${orderId}`,
      status: 'succeeded',
      amountMinor: 1403,
      currency: 'USD',
      reason: 'requested_by_customer',
      providerCreatedAt: new Date('2026-08-10T13:00:00.000Z')
    }).returning();
    if (!refund) throw new Error('Expected refund');
    await ownerDatabaseClient.db.insert(refundAllocations).values({
      refundId: refund.id,
      orderItemId: itemId,
      amountMinor: 1403,
      source: 'automatic'
    });
  }
  if (input.adverse === 'open-dispute' || input.adverse === 'lost-dispute') {
    const state = input.adverse === 'open-dispute' ? 'open' : 'lost';
    await ownerDatabaseClient.db.insert(disputes).values({
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

async function command(userId: string) {
  const [claimant] = await databaseClient.db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId));
  if (!claimant) throw new Error('Expected claim user');
  const authorizationToken = await createCommerceClaimAuthorization(databaseClient.db, {
    email: claimant.email,
    kind: 'password-reset'
  });
  return { userId, correlationId: `claim-${randomUUID()}`, authorizationToken };
}

describe('atomic guest purchase claiming', () => {
  it('rejects a direct web forgery of the exact aggregate claim audit shape', async () => {
    await expect(databaseClient.pool.query(`
      insert into audit_events (
        actor_type, actor_id, action, outcome, resource_type, resource_id,
        correlation_id, before, after
      ) values (
        'user', $1, 'commerce.guest_claimed', 'succeeded',
        'guest_identity', $2, $3, null,
        '{"claimedOrderCount":1,"claimedTitleCount":1}'::jsonb
      )
    `, [randomUUID(), randomUUID(), `forged-claim-${randomUUID()}`]))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('claims every paid order, projects each unique scope once, and audits only aggregates', async () => {
    const email = ' multi-claim@example.com ';
    const claimant = await createUser(email);
    const sharedTitle = await createTitle('Shared claim title');
    const first = await createGuestPurchase({ email, titleId: sharedTitle.id });
    await createGuestPurchase({ email, titleId: sharedTitle.id });
    await createGuestPurchase({ email });
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(0);

    const claimInput = await command(claimant.id);
    const result = await claimGuestPurchases(databaseClient.db, claimInput);

    expect(result).toEqual({
      claimed: true,
      changed: true,
      claimedOrderCount: 3,
      claimedTitleCount: 2
    });
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
    expect(audits[0]?.correlationId).toBe(claimInput.correlationId);
    expect(JSON.stringify(audits)).not.toMatch(/multi-claim@|Private claim|pi_test|cs_test/iu);
    const [tombstone] = await ownerDatabaseClient.db
      .select()
      .from(commerceClaimIssuances)
      .where(eq(
        commerceClaimIssuances.claimProofSha256,
        commerceClaimTokenSha256(claimInput.authorizationToken)
      ));
    expect(tombstone).toMatchObject({
      state: 'consumed',
      authTokenSha256: null,
      normalizedEmail: null,
      anchorOrderId: null,
      authorizedUserId: null,
      resultDisposition: 'claimed',
      resultChanged: true,
      resultOrderCount: 3,
      resultTitleCount: 2
    });

    const replay = await claimGuestPurchases(databaseClient.db, claimInput);
    expect(replay).toEqual(result);
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

    await claimGuestPurchases(databaseClient.db, await command(claimant.id));
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

  it('denies unverified and foreign-claimed identities generically', async () => {
    const purchase = await createGuestPurchase({ email: 'owner@example.com' });
    const unverified = await createUser('owner@example.com', false);
    await expect(claimGuestPurchases(databaseClient.db, await command(unverified.id)))
      .rejects.toMatchObject({ code: 'CLAIM_AUTHORIZATION_REQUIRED' });
    await databaseClient.db.update(user)
      .set({ emailVerified: true })
      .where(eq(user.id, unverified.id));
    const authorization = await command(unverified.id);
    const foreignClaimant = await createUser('foreign@example.com');
    await ownerDatabaseClient.db.update(guestIdentities).set({
      claimedByUserId: foreignClaimant.id,
      claimedAt: new Date()
    }).where(eq(guestIdentities.id, purchase.identity.id));
    await expect(claimGuestPurchases(databaseClient.db, authorization))
      .rejects.toMatchObject({
        code: 'IDENTITY_ALREADY_CLAIMED'
      });
    expect((await databaseClient.db.select().from(entitlementGrants)
      .where(eq(entitlementGrants.orderItemId, purchase.itemId)))[0]?.userId)
      .toBeNull();
  });

  it('makes the newest mailbox action win across live issuances for one email', async () => {
    const email = 'latest-claim@example.com';
    const claimant = await createUser(email);
    await createGuestPurchase({ email });
    await createGuestPurchase({ email });
    const superseded = await command(claimant.id);
    const latest = await command(claimant.id);

    await expect(claimGuestPurchases(databaseClient.db, superseded))
      .rejects.toMatchObject({ code: 'CLAIM_AUTHORIZATION_REQUIRED' });
    await expect(claimGuestPurchases(databaseClient.db, latest))
      .resolves.toMatchObject({ claimed: true, changed: true });
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'commerce.guest_claimed'))).toHaveLength(1);
  });

  it('replays one committed outcome across concurrent use and post-commit retry', async () => {
    const email = 'one-use-claim@example.com';
    const claimant = await createUser(email);
    await createGuestPurchase({ email });
    const authorizationToken = await createCommerceClaimAuthorization(databaseClient.db, {
      email,
      kind: 'password-reset'
    });
    const input = {
      userId: claimant.id,
      correlationId: `claim-${randomUUID()}`,
      authorizationToken
    };

    const concurrent = await Promise.all([
      claimGuestPurchases(databaseClient.db, input),
      claimGuestPurchases(databaseClient.db, input)
    ]);
    expect(concurrent[0]).toEqual(concurrent[1]);
    expect(concurrent[0]).toMatchObject({ claimed: true, changed: true });
    await expect(claimGuestPurchases(databaseClient.db, input))
      .resolves.toEqual(concurrent[0]);
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'commerce.guest_claimed'))).toHaveLength(1);
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(1);
  });

  it('requires one email-bound authorization and rejects magic authority for a credential account', async () => {
    const email = 'credential-claim@example.com';
    const claimant = await createUser(email);
    await databaseClient.db.insert(account).values({
      id: randomUUID(),
      accountId: claimant.id,
      providerId: 'credential',
      userId: claimant.id,
      password: 'test-only-hash'
    });
    await createGuestPurchase({ email });

    await expect(claimGuestPurchases(databaseClient.db, {
      userId: claimant.id,
      correlationId: `claim-${randomUUID()}`
    } as never)).rejects.toMatchObject({ code: 'CLAIM_AUTHORIZATION_REQUIRED' });

    const magicAuthorization = await createCommerceClaimAuthorization(databaseClient.db, {
      email,
      kind: 'commerce-magic'
    });
    await expect(claimGuestPurchases(databaseClient.db, {
      userId: claimant.id,
      correlationId: `claim-${randomUUID()}`,
      authorizationToken: magicAuthorization
    })).rejects.toMatchObject({ code: 'CLAIM_AUTHORIZATION_REQUIRED' });
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(0);

    const resetAuthorization = await createCommerceClaimAuthorization(databaseClient.db, {
      email,
      kind: 'password-reset'
    });
    await expect(claimGuestPurchases(databaseClient.db, {
      userId: claimant.id,
      correlationId: `claim-${randomUUID()}`,
      authorizationToken: resetAuthorization
    })).resolves.toMatchObject({ claimed: true, changed: true });
  });

  it('rolls identity, grants, entitlements, audit, and proof back after a mid-claim failure', async () => {
    const email = 'rollback-claim@example.com';
    const claimant = await createUser(email);
    const first = await createGuestPurchase({ email });
    await createGuestPurchase({ email });
    const authorizationToken = await createCommerceClaimAuthorization(
      databaseClient.db,
      { email, kind: 'password-reset' }
    );
    await ownerDatabaseClient.db.execute(sql`
      create function "public"."test_reject_commerce_claim_audit"() returns trigger
      language plpgsql set search_path = 'pg_catalog' as $$
      begin
        if NEW.action = 'commerce.guest_claimed' then
          raise exception 'forced claim audit failure';
        end if;
        return NEW;
      end;
      $$
    `);
    await ownerDatabaseClient.db.execute(sql`
      create trigger "audit_events_test_reject_commerce_claim"
      before insert on "public"."audit_events"
      for each row execute function "public"."test_reject_commerce_claim_audit"()
    `);
    try {
      await expect(claimGuestPurchases(databaseClient.db, {
        userId: claimant.id,
        correlationId: `claim-${randomUUID()}`,
        authorizationToken
      })).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'forced claim audit failure' })
      });
    } finally {
      await ownerDatabaseClient.db.execute(sql`
        drop trigger if exists "audit_events_test_reject_commerce_claim"
        on "public"."audit_events"
      `);
      await ownerDatabaseClient.db.execute(sql`
        drop function if exists "public"."test_reject_commerce_claim_audit"()
      `);
    }
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
    await expect(claimGuestPurchases(databaseClient.db, {
      userId: claimant.id,
      correlationId: `claim-${randomUUID()}`,
      authorizationToken
    })).resolves.toMatchObject({ claimed: true });
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
    await claimGuestPurchases(databaseClient.db, await command(claimant.id));
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
