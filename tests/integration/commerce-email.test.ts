import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createAuthClient } from 'better-auth/client';
import { describe, expect, it } from 'vitest';
import {
  COMMERCE_CLAIM_EMAIL_JOB,
  COMMERCE_CLAIM_REQUEST_JOB,
  claimEmailJobPayloadSchema,
  createClaimEmailHandler,
  createClaimEmailOperations,
  loadClaimEmailEligibility,
  queueCommerceClaimEmail
} from '$lib/server/commerce/claim-email';
import {
  createCommerceMessageEnqueuer
} from '$lib/server/commerce/email/enqueue';
import {
  parseCommerceEmailPayload
} from '$lib/server/commerce/email/payload';
import { fulfillCheckoutEvent } from '$lib/server/commerce/fulfillment';
import { applyCurrentPasswordResetCredential } from '$lib/server/auth/commerce-claim-authorization';
import {
  canSendCommerceMagicLink,
  canSendMagicLink,
  ensureCustomerRole,
  findOrCreateGuestIdentity
} from '$lib/server/auth/identity';
import {
  registerCommerceClaimIssuance
} from '$lib/server/auth/commerce-claim-capability';
import { createAuthServer } from '$lib/server/auth/options';
import { claimGuestPurchases } from '$lib/server/commerce/claims';
import {
  account,
  commerceClaimIssuances,
  credentialAuthority,
  entitlementGrants,
  jobs,
  orderItems,
  orders,
  outboxMessages,
  payments,
  session,
  stripeEvents,
  titles,
  user,
  verification
} from '$lib/server/db/schema';
import { queueAuthEmail } from '$lib/server/email/enqueue';
import { authEmailPayloadSchema } from '$lib/server/email/payload';
import type { JobRecord } from '$lib/server/jobs/types';
import { OutboxDeduplicationInvariantError } from '$lib/server/outbox/repository';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient
} from './database';
import {
  createCommerceClaimAuthorization,
  traverseCommerceClaimBridge
} from './commerce-claim-capability';

async function createTitle() {
  const id = randomUUID();
  const [title] = await databaseClient.db.insert(titles).values({
    id,
    slug: `commerce-email-${id}`,
    title: 'Safe receipt title',
    description: 'Safe fixture description',
    creatorName: 'Safe creator',
    format: 'prose',
    priceMinor: 1299,
    currency: 'USD',
    visibility: 'private'
  }).returning();
  if (!title) throw new Error('Expected title');
  return title;
}

async function createPaidOrder(
  owner: 'account' | 'guest',
  email = owner === 'account' ? 'reader@example.com' : 'guest@example.com'
) {
  const title = await createTitle();
  const orderId = randomUUID();
  const itemId = randomUUID();
  let initiatingUserId: string | null = null;
  let guestIdentityId: string | null = null;
  if (owner === 'account') {
    initiatingUserId = randomUUID();
    await databaseClient.db.insert(user).values({
      id: initiatingUserId,
      name: 'Receipt reader',
      email,
      emailVerified: true
    });
  } else {
    const identity = await findOrCreateGuestIdentity(databaseClient.db, email);
    guestIdentityId = identity.id;
  }
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    initiatingUserId,
    guestIdentityId,
    purchaseEmail: email,
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
  });
  await ownerDatabaseClient.db.insert(orderItems).values({
    id: itemId,
    orderId,
    titleId: title.id,
    titleSnapshot: title.title,
    creatorNameSnapshot: title.creatorName,
    format: title.format,
    currency: 'USD',
    unitSubtotalMinor: 1299,
    taxMinor: 104,
    totalMinor: 1403,
    stripeLineItemId: `li_test_${itemId}`
  });
  await ownerDatabaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: `pi_test_${orderId}`,
    stripeLatestChargeId: `ch_test_${orderId}`,
    status: 'succeeded',
    amountMinor: 1403,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt: new Date('2026-08-10T12:05:00.000Z')
  });
  await ownerDatabaseClient.db.insert(entitlementGrants).values({
    titleId: title.id,
    userId: initiatingUserId,
    source: 'purchase',
    orderItemId: itemId,
    state: initiatingUserId === null ? 'unclaimed' : 'active',
    stateReason: 'payment_succeeded',
    grantedAt: new Date('2026-08-10T12:05:00.000Z')
  });
  return { orderId, itemId };
}

function createCommerceAuth() {
  const messages = createCommerceMessageEnqueuer(applicationConfig.origin);
  let claimProof: string | null = null;
  const auth = createAuthServer({
    database: databaseClient.db,
    config: applicationConfig,
    queueVerificationEmail: (input) => queueAuthEmail(databaseClient.db, input),
    queueResetEmail: (input) => queueAuthEmail(databaseClient.db, input),
    queueMagicEmail: (input) => queueAuthEmail(databaseClient.db, input),
    queueCommerceClaimEmail: (input) =>
      queueCommerceClaimEmail(workerDatabaseClient.db, messages, input),
    canSendMagicLink: (email) => canSendMagicLink(databaseClient.db, email),
    canSendCommerceMagicLink: (email) => canSendCommerceMagicLink(databaseClient.db, email),
    onUserCreated: (userId) => ensureCustomerRole(databaseClient.db, userId),
    registerCommerceClaimIssuance: (input) =>
      registerCommerceClaimIssuance(workerDatabaseClient.db, input),
    readCommerceClaimProof: () => claimProof,
    clearCommerceClaimProof: () => { claimProof = null; }
  });
  return {
    auth,
    messages,
    openCommerceClaimBridge(claimUrl: string): string {
      const bridge = traverseCommerceClaimBridge(claimUrl, applicationConfig.origin);
      claimProof = bridge.proofCookieValue;
      return bridge.actionUrl;
    },
    currentCommerceClaimProof: () => claimProof
  };
}

function claimJob(orderId: string, type: string = COMMERCE_CLAIM_EMAIL_JOB): JobRecord {
  return {
    id: randomUUID(),
    type,
    payload: { orderId },
    deduplicationKey: `commerce:claim-email:order:${orderId}:v1`,
    attempts: 1,
    maxAttempts: 8,
    lockedBy: 'commerce-email-integration'
  };
}

describe('commerce email persistence', () => {
  it('deduplicates an account receipt and rejects changed immutable content', async () => {
    const fixture = await createPaidOrder('account');
    const enqueuer = createCommerceMessageEnqueuer(applicationConfig.origin);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await databaseClient.db.transaction((transaction) =>
        enqueuer.enqueueAccountReceipt(transaction, fixture.orderId)
      );
    }

    const messages = await ownerDatabaseClient.db.select().from(outboxMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.deduplicationKey).toBe(
      `commerce:receipt:order:${fixture.orderId}:v1`
    );
    expect(parseCommerceEmailPayload(messages[0]?.payload, applicationConfig.origin)).toMatchObject({
      template: 'commerce.account-receipt',
      messageId: fixture.orderId,
      orderNumber: fixture.orderId,
      to: 'reader@example.com'
    });
    expect(await workerDatabaseClient.db.select().from(jobs)).toHaveLength(1);
    expect(JSON.stringify(await workerDatabaseClient.db.select().from(jobs))).not.toContain('@example.com');

    await ownerDatabaseClient.db.update(orderItems)
      .set({ titleSnapshot: 'Changed immutable title' })
      .where(eq(orderItems.id, fixture.itemId));
    await expect(databaseClient.db.transaction((transaction) =>
      enqueuer.enqueueAccountReceipt(transaction, fixture.orderId)
    )).rejects.toBeInstanceOf(OutboxDeduplicationInvariantError);
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(1);
    expect(await workerDatabaseClient.db.select().from(jobs)).toHaveLength(1);
  });

  it('deduplicates the strict guest claim-preparation job without an email-derived key', async () => {
    const fixture = await createPaidOrder('guest');
    const enqueuer = createCommerceMessageEnqueuer(applicationConfig.origin);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await workerDatabaseClient.db.transaction((transaction) =>
        enqueuer.enqueueGuestClaimPreparation(transaction, fixture.orderId)
      );
    }

    const storedJobs = await workerDatabaseClient.db.select().from(jobs);
    expect(storedJobs).toHaveLength(1);
    expect(storedJobs[0]).toMatchObject({
      type: COMMERCE_CLAIM_EMAIL_JOB,
      deduplicationKey: `commerce:claim-email:order:${fixture.orderId}:v1`
    });
    expect(claimEmailJobPayloadSchema.parse(storedJobs[0]?.payload)).toEqual({
      orderId: fixture.orderId
    });
    expect(JSON.stringify(storedJobs)).not.toContain('@');
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(0);
  });

  it('deduplicates access-change messages by internal event UUID', async () => {
    const eventId = randomUUID();
    const enqueuer = createCommerceMessageEnqueuer(applicationConfig.origin);
    const input = {
      template: 'commerce.dispute-access-changed' as const,
      eventId,
      to: 'reader@example.com',
      reasonCategory: 'dispute_opened' as const,
      affectedTitleCount: 2
    };
    await databaseClient.db.transaction((transaction) =>
      enqueuer.enqueueAccessChange(transaction, input)
    );
    await databaseClient.db.transaction((transaction) =>
      enqueuer.enqueueAccessChange(transaction, input)
    );
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(1);
    await expect(databaseClient.db.transaction((transaction) =>
      enqueuer.enqueueAccessChange(transaction, { ...input, affectedTitleCount: 1 })
    )).rejects.toBeInstanceOf(OutboxDeduplicationInvariantError);
  });

  it('enqueues the account receipt inside the paid fulfillment transaction', async () => {
    const title = await createTitle();
    const userId = randomUUID();
    const orderId = randomUUID();
    const itemId = randomUUID();
    const sessionId = `cs_test_${orderId}`;
    const paymentIntentId = `pi_test_${orderId}`;
    const chargeId = `ch_test_${orderId}`;
    await databaseClient.db.insert(user).values({
      id: userId,
      name: 'Fulfillment reader',
      email: 'fulfillment@example.com',
      emailVerified: true
    });
    await ownerDatabaseClient.db.insert(orders).values({
      id: orderId,
      status: 'checkout_open',
      initiatingUserId: userId,
      purchaseEmail: 'fulfillment@example.com',
      currency: 'USD',
      subtotalMinor: 1299,
      clientCheckoutAttemptId: randomUUID(),
      quoteFingerprintSha256: 'c'.repeat(64),
      stripeCheckoutSessionId: sessionId,
      statusTokenSha256: 'd'.repeat(64),
      checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z')
    });
    await ownerDatabaseClient.db.insert(orderItems).values({
      id: itemId,
      orderId,
      titleId: title.id,
      titleSnapshot: title.title,
      creatorNameSnapshot: title.creatorName,
      format: title.format,
      currency: 'USD',
      unitSubtotalMinor: 1299
    });
    const [event] = await ownerDatabaseClient.db.insert(stripeEvents).values({
      providerEventId: `evt_test_${orderId}`,
      eventType: 'checkout.session.completed',
      objectId: sessionId,
      liveMode: false,
      providerCreatedAt: new Date('2026-08-10T12:05:00.000Z'),
      rawBodySha256: 'e'.repeat(64)
    }).returning();
    if (!event) throw new Error('Expected event');

    await fulfillCheckoutEvent(workerDatabaseClient.db, {
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
        customerEmail: 'fulfillment@example.com',
        currency: 'usd',
        subtotalMinor: 1299,
        taxMinor: 104,
        totalMinor: 1403,
        expiresAt: new Date('2026-08-10T12:30:00.000Z'),
        lineItems: [{
          providerLineItemId: `li_test_${itemId}`,
          orderItemId: itemId,
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
        paidAt: new Date('2026-08-10T12:05:00.000Z'),
        paymentMethodCategory: 'card'
      }
    }, {
      purchaseMessages: createCommerceMessageEnqueuer(applicationConfig.origin)
    });

    expect((await databaseClient.db.select().from(orders)
      .where(eq(orders.id, orderId)))[0]?.status).toBe('paid');
    expect(parseCommerceEmailPayload(
      (await ownerDatabaseClient.db.select().from(outboxMessages))[0]?.payload,
      applicationConfig.origin
    )).toMatchObject({
      template: 'commerce.account-receipt',
      messageId: orderId
    });
  });

  it('prepares one hashed, atomic magic link and one matching guest receipt', async () => {
    const fixture = await createPaidOrder('guest', 'claim-reader@example.com');
    const {
      auth,
      messages,
      openCommerceClaimBridge,
      currentCommerceClaimProof
    } = createCommerceAuth();
    const handler = createClaimEmailHandler(createClaimEmailOperations(
      workerDatabaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ));
    await handler(claimJob(fixture.orderId), new AbortController().signal);

    const commerceRows = (await ownerDatabaseClient.db.select().from(outboxMessages))
      .filter((row) => row.topic === 'email.commerce.v1');
    expect(commerceRows).toHaveLength(1);
    const payload = parseCommerceEmailPayload(
      commerceRows[0]?.payload,
      applicationConfig.origin
    );
    expect(payload).toMatchObject({
      template: 'commerce.guest-receipt-claim',
      messageId: fixture.orderId,
      to: 'claim-reader@example.com'
    });
    if (payload.template !== 'commerce.guest-receipt-claim') {
      throw new Error('Expected guest claim payload');
    }
    const token = new URL(
      traverseCommerceClaimBridge(payload.claimUrl, applicationConfig.origin).actionUrl
    ).searchParams.get('token');
    if (!token) throw new Error('Expected magic token');
    const tokenRowsBeforeReplay = await databaseClient.db.select().from(verification);
    expect(tokenRowsBeforeReplay).toHaveLength(2);
    expect(JSON.stringify(tokenRowsBeforeReplay)).not.toContain(token);

    await handler(claimJob(fixture.orderId), new AbortController().signal);
    expect(await databaseClient.db.select().from(verification)).toHaveLength(2);

    await createClaimEmailHandler(createClaimEmailOperations(
      workerDatabaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ), { allowExistingReceipt: true })(
      claimJob(fixture.orderId, COMMERCE_CLAIM_REQUEST_JOB),
      new AbortController().signal
    );
    const replacements = (await ownerDatabaseClient.db.select().from(outboxMessages))
      .filter((row) => row.topic === 'email.commerce.v1');
    expect(replacements).toHaveLength(2);
    expect(replacements[1]?.deduplicationKey).toMatch(
      new RegExp(`^commerce:claim-reissue:order:${fixture.orderId}:action:[a-f0-9]{64}:v1$`, 'u')
    );
    const replacementPayload = parseCommerceEmailPayload(
      replacements[1]?.payload,
      applicationConfig.origin
    );
    if (replacementPayload.template !== 'commerce.guest-receipt-claim') {
      throw new Error('Expected replacement guest claim payload');
    }
    expect(replacementPayload.claimUrl).not.toBe(payload.claimUrl);
    // Better Auth retains both hashed native tokens; the project guard rotates
    // to one current marker, so the older link cannot create a session.
    expect(await databaseClient.db.select().from(verification)).toHaveLength(3);

    const stale = await auth.handler(new Request(openCommerceClaimBridge(payload.claimUrl), {
      headers: { origin: applicationConfig.origin },
      redirect: 'manual'
    }));
    expect(stale.status).toBe(401);
    const staleCookies = stale.headers.get('set-cookie') ?? '';
    expect(staleCookies)
      .not.toContain('pale-orbit-commerce-claim=');
    expect(staleCookies).toMatch(/(?:better-auth|__Secure-better-auth)\.session_token=/u);
    expect(staleCookies).toMatch(/Max-Age=0/iu);
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);

    const request = () => auth.handler(new Request(
      openCommerceClaimBridge(replacementPayload.claimUrl), {
      headers: { origin: applicationConfig.origin },
      redirect: 'manual'
    }));
    const first = await request();
    expect(first.status).toBe(302);
    const firstCookies = first.headers.get('set-cookie') ?? '';
    expect(firstCookies).toMatch(/(?:better-auth|__Secure-better-auth)\.session_token=/u);
    expect(firstCookies).not.toContain('pale-orbit-commerce-claim=');
    expect(currentCommerceClaimProof()).not.toBeNull();
    expect(await databaseClient.db.select().from(session)).toHaveLength(1);
    expect(await ownerDatabaseClient.db
      .select({ state: commerceClaimIssuances.state })
      .from(commerceClaimIssuances))
      .toEqual([{ state: 'authorized' }]);
    const reused = await request();
    expect(reused.headers.get('set-cookie')).toBeNull();
    expect(await databaseClient.db.select().from(session)).toHaveLength(1);
  });

  it('falls back to a receipt when the identity is claimed before its magic job runs', async () => {
    const email = `claimed-before-email-${randomUUID()}@example.com`;
    await createPaidOrder('guest', email);
    const later = await createPaidOrder('guest', email);
    const claimantId = randomUUID();
    await databaseClient.db.insert(user).values({
      id: claimantId,
      name: 'Claimed-before-email reader',
      email,
      emailVerified: true
    });
    const authorizationToken = await createCommerceClaimAuthorization(databaseClient.db, {
      email,
      kind: 'commerce-magic'
    });
    await expect(claimGuestPurchases(databaseClient.db, {
      userId: claimantId,
      correlationId: `claimed-before-email-${later.orderId}`,
      authorizationToken
    })).resolves.toMatchObject({ claimed: true, claimedOrderCount: 2 });
    const verificationBefore = await ownerDatabaseClient.db
      .select({ identifier: verification.identifier })
      .from(verification);
    const issuanceBefore = await ownerDatabaseClient.db
      .select({
        claimProofSha256: commerceClaimIssuances.claimProofSha256,
        state: commerceClaimIssuances.state
      })
      .from(commerceClaimIssuances);

    const { auth, messages } = createCommerceAuth();
    await createClaimEmailHandler(createClaimEmailOperations(
      workerDatabaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ))(claimJob(later.orderId), new AbortController().signal);

    const allMessages = await ownerDatabaseClient.db.select().from(outboxMessages);
    const commerceRows = allMessages
      .filter((row) => row.topic === 'email.commerce.v1');
    expect(commerceRows).toHaveLength(1);
    const payload = parseCommerceEmailPayload(
      commerceRows[0]?.payload,
      applicationConfig.origin
    );
    expect(payload).toMatchObject({
      template: 'commerce.account-receipt',
      messageId: later.orderId,
      to: email
    });
    expect(JSON.stringify(payload)).not.toContain('claimUrl');
    expect(allMessages.filter((row) => row.topic === 'email.auth.v1')).toHaveLength(0);
    expect(await ownerDatabaseClient.db
      .select({ identifier: verification.identifier })
      .from(verification)).toEqual(verificationBefore);
    expect(await ownerDatabaseClient.db
      .select({
        claimProofSha256: commerceClaimIssuances.claimProofSha256,
        state: commerceClaimIssuances.state
      })
      .from(commerceClaimIssuances)).toEqual(issuanceBefore);
  });

  it('cannot turn a pre-issued commerce magic link into claim authority after a credential appears', async () => {
    const email = 'magic-credential-race@example.com';
    const fixture = await createPaidOrder('guest', email);
    const { auth, messages, openCommerceClaimBridge } = createCommerceAuth();
    await createClaimEmailHandler(createClaimEmailOperations(
      workerDatabaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ))(claimJob(fixture.orderId), new AbortController().signal);
    const payload = parseCommerceEmailPayload(
      (await ownerDatabaseClient.db.select().from(outboxMessages)
        .where(eq(outboxMessages.topic, 'email.commerce.v1')))[0]?.payload,
      applicationConfig.origin
    );
    if (payload.template !== 'commerce.guest-receipt-claim') {
      throw new Error('Expected guest claim payload');
    }

    const credentialUserId = randomUUID();
    await databaseClient.db.insert(user).values({
      id: credentialUserId,
      name: 'Verified credential claimant',
      email,
      emailVerified: true
    });
    await databaseClient.db.insert(account).values({
      id: randomUUID(),
      accountId: email,
      providerId: 'credential',
      userId: credentialUserId,
      password: 'test-only-credential-hash'
    });
    await databaseClient.db.insert(credentialAuthority).values({
      userId: credentialUserId,
      authorizedPasswordHash: 'test-only-credential-hash'
    });

    const verified = await auth.handler(new Request(openCommerceClaimBridge(payload.claimUrl), {
      headers: { origin: applicationConfig.origin },
      redirect: 'manual'
    }));
    expect(verified.status).toBe(401);
    expect(await verified.clone().json()).toEqual({
      code: 'INVALID_TOKEN',
      message: 'Invalid or expired authentication link'
    });
    const rejectedCookies = verified.headers.get('set-cookie') ?? '';
    expect(rejectedCookies)
      .not.toContain('pale-orbit-commerce-claim=');
    expect(rejectedCookies).toMatch(/(?:better-auth|__Secure-better-auth)\.session_token=/u);
    expect(rejectedCookies).toMatch(/Max-Age=0/iu);
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);
    expect(await ownerDatabaseClient.db
      .select({ state: commerceClaimIssuances.state })
      .from(commerceClaimIssuances))
      .toEqual([{ state: 'issued' }]);
  });

  it('accepts commerce magic after stripping an intervening unverified credential', async () => {
    const email = 'magic-unverified-credential-race@example.com';
    const fixture = await createPaidOrder('guest', email);
    const {
      auth,
      messages,
      openCommerceClaimBridge,
      currentCommerceClaimProof
    } = createCommerceAuth();
    await createClaimEmailHandler(createClaimEmailOperations(
      workerDatabaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ))(claimJob(fixture.orderId), new AbortController().signal);
    const payload = parseCommerceEmailPayload(
      (await ownerDatabaseClient.db.select().from(outboxMessages)
        .where(eq(outboxMessages.topic, 'email.commerce.v1')))[0]?.payload,
      applicationConfig.origin
    );
    if (payload.template !== 'commerce.guest-receipt-claim') {
      throw new Error('Expected guest claim payload');
    }

    const credentialUserId = randomUUID();
    await databaseClient.db.insert(user).values({
      id: credentialUserId,
      name: 'Unverified credential claimant',
      email,
      emailVerified: false
    });
    await databaseClient.db.insert(account).values({
      id: randomUUID(),
      accountId: email,
      providerId: 'credential',
      userId: credentialUserId,
      password: 'test-only-unverified-credential-hash'
    });
    await databaseClient.db.insert(credentialAuthority).values({
      userId: credentialUserId,
      authorizedPasswordHash: 'test-only-unverified-credential-hash'
    });
    const attackerSessionToken = 'attacker-session-before-mailbox-proof';
    await databaseClient.db.insert(session).values({
      token: attackerSessionToken,
      userId: credentialUserId,
      expiresAt: new Date('2026-08-11T12:00:00.000Z'),
      updatedAt: new Date('2026-08-10T12:00:00.000Z')
    });

    const verified = await auth.handler(new Request(openCommerceClaimBridge(payload.claimUrl), {
      headers: { origin: applicationConfig.origin },
      redirect: 'manual'
    }));
    expect(verified.status).toBe(302);
    const cookies = verified.headers.get('set-cookie') ?? '';
    expect(cookies).toMatch(/(?:better-auth|__Secure-better-auth)\.session_token=/u);
    expect(cookies).not.toContain('pale-orbit-commerce-claim=');
    expect(currentCommerceClaimProof()).not.toBeNull();
    expect(await databaseClient.db.select().from(account)
      .where(eq(account.userId, credentialUserId))).toHaveLength(0);
    expect(await databaseClient.db.select().from(credentialAuthority)
      .where(eq(credentialAuthority.userId, credentialUserId))).toHaveLength(0);
    expect(await databaseClient.db.select().from(session)
      .where(eq(session.token, attackerSessionToken))).toHaveLength(0);
    const survivingSessions = await databaseClient.db.select({ token: session.token })
      .from(session)
      .where(eq(session.userId, credentialUserId));
    expect(survivingSessions).toHaveLength(1);
    expect(survivingSessions[0]?.token).not.toBe(attackerSessionToken);
    expect(await ownerDatabaseClient.db
      .select({ state: commerceClaimIssuances.state })
      .from(commerceClaimIssuances))
      .toEqual([{ state: 'authorized' }]);

    const ordinaryRequest = await auth.handler(new Request(
      `${applicationConfig.origin}/api/auth/sign-in/magic-link`,
      {
        method: 'POST',
        headers: {
          origin: applicationConfig.origin,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ email, callbackURL: '/' })
      }
    ));
    expect(ordinaryRequest.status).toBe(200);
    const ordinaryPayload = authEmailPayloadSchema.parse(
      (await ownerDatabaseClient.db.select().from(outboxMessages)
        .where(eq(outboxMessages.topic, 'email.auth.v1'))).at(-1)?.payload
    );
    expect(ordinaryPayload.template).toBe('auth.magic-link');
    expect((await auth.handler(new Request(ordinaryPayload.actionUrl, {
      headers: { origin: applicationConfig.origin },
      redirect: 'manual'
    }))).status).toBe(302);
  });

  it('rejects older commerce magic after a newer reset generation has applied', async () => {
    const email = 'magic-applied-reset-race@example.com';
    const fixture = await createPaidOrder('guest', email);
    const { auth, messages, openCommerceClaimBridge } = createCommerceAuth();
    await createClaimEmailHandler(createClaimEmailOperations(
      workerDatabaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ))(claimJob(fixture.orderId), new AbortController().signal);
    const payload = parseCommerceEmailPayload(
      (await ownerDatabaseClient.db.select().from(outboxMessages)
        .where(eq(outboxMessages.topic, 'email.commerce.v1')))[0]?.payload,
      applicationConfig.origin
    );
    if (payload.template !== 'commerce.guest-receipt-claim') {
      throw new Error('Expected guest claim payload');
    }

    const credentialUserId = randomUUID();
    await databaseClient.db.insert(user).values({
      id: credentialUserId,
      name: 'Applied reset claimant',
      email,
      emailVerified: false
    });
    await databaseClient.db.insert(account).values({
      id: randomUUID(),
      accountId: email,
      providerId: 'credential',
      userId: credentialUserId,
      password: 'authorized-before-applied-reset'
    });
    await databaseClient.db.insert(credentialAuthority).values({
      userId: credentialUserId,
      authorizedPasswordHash: 'authorized-before-applied-reset'
    });
    expect((await auth.handler(new Request(
      `${applicationConfig.origin}/api/auth/request-password-reset`,
      {
        method: 'POST',
        headers: {
          origin: applicationConfig.origin,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ email, redirectTo: '/reset-password' })
      }
    ))).status).toBe(200);
    const resetPayload = authEmailPayloadSchema.parse(
      (await ownerDatabaseClient.db.select().from(outboxMessages)
        .where(eq(outboxMessages.topic, 'email.auth.v1'))).at(-1)?.payload
    );
    expect(resetPayload.template).toBe('auth.password-reset');
    const resetToken = new URL(resetPayload.actionUrl).pathname.split('/').at(-1);
    if (!resetToken) throw new Error('Expected applied reset token');
    expect(await applyCurrentPasswordResetCredential(databaseClient.db, {
      token: resetToken,
      passwordHash: 'newer-mailbox-proven-applied-hash'
    })).toBe(true);
    // Better Auth can already have decided to revoke an unproven credential
    // before the reset applies; deleting here models that deterministic
    // cleanup/completion interleaving without timing-dependent barriers.
    await databaseClient.db.delete(account).where(eq(account.userId, credentialUserId));

    const rejected = await auth.handler(new Request(openCommerceClaimBridge(payload.claimUrl), {
      headers: { origin: applicationConfig.origin },
      redirect: 'manual'
    }));
    expect(rejected.status).toBe(401);
    expect(await rejected.clone().json()).toEqual({
      code: 'INVALID_TOKEN',
      message: 'Invalid or expired authentication link'
    });
    const cookies = rejected.headers.get('set-cookie') ?? '';
    expect(cookies).not.toContain('pale-orbit-commerce-claim=');
    expect(cookies).toMatch(/(?:better-auth|__Secure-better-auth)\.session_token=/u);
    expect(cookies).toMatch(/Max-Age=0/iu);
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);
    expect(await ownerDatabaseClient.db
      .select({ state: commerceClaimIssuances.state })
      .from(commerceClaimIssuances))
      .toEqual([{ state: 'issued' }]);
    expect(await loadClaimEmailEligibility(databaseClient.db, fixture.orderId)).toMatchObject({
      accountState: 'password-recovery',
      email
    });
  });

  it('invalidates a pending reset when passwordless commerce magic proves ownership', async () => {
    const email = 'passwordless-magic-reset-race@example.com';
    const fixture = await createPaidOrder('guest', email);
    const passwordlessUserId = randomUUID();
    await databaseClient.db.insert(user).values({
      id: passwordlessUserId,
      name: 'Passwordless claimant',
      email,
      emailVerified: true
    });
    const {
      auth,
      messages,
      openCommerceClaimBridge,
      currentCommerceClaimProof
    } = createCommerceAuth();
    await createClaimEmailHandler(createClaimEmailOperations(
      workerDatabaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ))(claimJob(fixture.orderId), new AbortController().signal);
    const payload = parseCommerceEmailPayload(
      (await ownerDatabaseClient.db.select().from(outboxMessages)
        .where(eq(outboxMessages.topic, 'email.commerce.v1')))[0]?.payload,
      applicationConfig.origin
    );
    if (payload.template !== 'commerce.guest-receipt-claim') {
      throw new Error('Expected guest claim payload');
    }

    const resetRequested = await auth.handler(new Request(
      `${applicationConfig.origin}/api/auth/request-password-reset`,
      {
        method: 'POST',
        headers: {
          origin: applicationConfig.origin,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ email, redirectTo: '/reset-password' })
      }
    ));
    expect(resetRequested.status).toBe(200);
    const resetPayload = authEmailPayloadSchema.parse(
      (await ownerDatabaseClient.db.select().from(outboxMessages)
        .where(eq(outboxMessages.topic, 'email.auth.v1'))).at(-1)?.payload
    );
    expect(resetPayload.template).toBe('auth.password-reset');
    const resetToken = new URL(resetPayload.actionUrl).pathname.split('/').at(-1);
    if (!resetToken) throw new Error('Expected pending password reset token');

    const claimed = await auth.handler(new Request(openCommerceClaimBridge(payload.claimUrl), {
      headers: { origin: applicationConfig.origin },
      redirect: 'manual'
    }));
    expect(claimed.status).toBe(302);
    expect(claimed.headers.get('set-cookie') ?? '')
      .not.toContain('pale-orbit-commerce-claim=');
    expect(currentCommerceClaimProof()).not.toBeNull();
    expect(await databaseClient.db.select().from(credentialAuthority)
      .where(eq(credentialAuthority.userId, passwordlessUserId))).toHaveLength(0);
    expect((await databaseClient.db.select().from(verification)).filter((row) =>
      row.identifier.startsWith('reset-password:') ||
      row.identifier.startsWith('pale-orbit:auth-password-reset:')
    )).toHaveLength(0);

    const staleReset = await auth.handler(new Request(
      `${applicationConfig.origin}/api/auth/reset-password`,
      {
        method: 'POST',
        headers: {
          origin: applicationConfig.origin,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          token: resetToken,
          newPassword: 'Stale-passwordless-reset-2026'
        })
      }
    ));
    expect(staleReset.status).not.toBe(200);
    expect(await databaseClient.db.select().from(account)
      .where(eq(account.userId, passwordlessUserId))).toHaveLength(0);
  });

  it('silently refuses mismatched commerce metadata without exposing another order', async () => {
    const victim = await createPaidOrder('guest', 'victim@example.com');
    const { auth } = createCommerceAuth();
    const response = await auth.handler(new Request(
      `${applicationConfig.origin}/api/auth/sign-in/magic-link`,
      {
        method: 'POST',
        headers: {
          origin: applicationConfig.origin,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          email: 'attacker@example.com',
          callbackURL: '/claim/complete',
          metadata: { purpose: 'commerce-claim', orderId: victim.orderId }
        })
      }
    ));
    expect(response.status).toBe(200);
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(0);
    expect(JSON.stringify(await workerDatabaseClient.db.select().from(jobs)))
      .not.toContain(victim.orderId);
  });

  it('uses commerce magic mail for a matching verified account', async () => {
    const email = 'verified-claim@example.com';
    const fixture = await createPaidOrder('guest', email);
    await databaseClient.db.insert(user).values({
      id: randomUUID(),
      name: 'Verified claimant',
      email,
      emailVerified: true
    });
    const { auth, messages } = createCommerceAuth();
    await createClaimEmailHandler(createClaimEmailOperations(
      workerDatabaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ))(claimJob(fixture.orderId), new AbortController().signal);
    const payload = parseCommerceEmailPayload(
      (await ownerDatabaseClient.db.select().from(outboxMessages)
        .where(eq(outboxMessages.topic, 'email.commerce.v1')))[0]?.payload,
      applicationConfig.origin
    );
    expect(payload.template).toBe('commerce.guest-receipt-claim');
  });

  it('forces password recovery for any credential account and blocks direct commerce magic', async () => {
    const email = 'pending-credential@example.com';
    const fixture = await createPaidOrder('guest', email);
    const userId = randomUUID();
    await databaseClient.db.insert(user).values({
      id: userId,
      name: 'Pending credential',
      email,
      emailVerified: true
    });
    await databaseClient.db.insert(account).values({
      id: randomUUID(),
      accountId: email,
      providerId: 'credential',
      userId,
      password: 'test-password-hash'
    });
    const {
      auth,
      messages,
      openCommerceClaimBridge,
      currentCommerceClaimProof
    } = createCommerceAuth();
    const blockedMagic = await auth.handler(new Request(
      `${applicationConfig.origin}/api/auth/sign-in/magic-link`,
      {
        method: 'POST',
        headers: {
          origin: applicationConfig.origin,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          email,
          callbackURL: '/claim/complete',
          metadata: { purpose: 'commerce-claim', orderId: fixture.orderId }
        })
      }
    ));
    expect(blockedMagic.status).toBe(200);
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(0);
    const blockedMagicVerification = await ownerDatabaseClient.db
      .select({ identifier: verification.identifier, value: verification.value })
      .from(verification);
    await createClaimEmailHandler(createClaimEmailOperations(
      workerDatabaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ))(claimJob(fixture.orderId), new AbortController().signal);

    const rows = await ownerDatabaseClient.db.select().from(outboxMessages);
    const commerce = rows.find((row) => row.topic === 'email.commerce.v1');
    const recoveryMail = rows.find((row) => row.topic === 'email.auth.v1');
    const commercePayload = parseCommerceEmailPayload(
      commerce?.payload,
      applicationConfig.origin
    );
    expect(commercePayload.template).toBe('commerce.account-receipt');
    expect(JSON.stringify(commercePayload)).not.toContain('claimUrl');
    const authPayload = authEmailPayloadSchema.parse(recoveryMail?.payload);
    expect(authPayload).toMatchObject({
      template: 'auth.password-reset',
      to: email
    });
    if (authPayload.template !== 'auth.password-reset') {
      throw new Error('Expected commerce password recovery payload');
    }
    const nativeResetAction = new URL(openCommerceClaimBridge(authPayload.actionUrl));
    const resetCallback = new URL(
      nativeResetAction.searchParams.get('callbackURL') ?? '',
      applicationConfig.origin
    );
    expect(resetCallback.pathname).toBe('/reset-password');
    expect(resetCallback.searchParams.size).toBe(2);
    expect(resetCallback.searchParams.get('purpose')).toBe('commerce-claim');
    expect(resetCallback.searchParams.get('orderId')).toBe(fixture.orderId);
    const resetToken = nativeResetAction.pathname.split('/').at(-1);
    if (!resetToken) throw new Error('Expected commerce recovery token');
    expect(await databaseClient.db.select().from(verification)).not.toHaveLength(0);
    const captured: { response?: Response } = {};
    const client = createAuthClient({
      baseURL: `${applicationConfig.origin}/api/auth`,
      fetchOptions: {
        customFetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set('origin', applicationConfig.origin);
          const response = await auth.handler(new Request(input, { ...init, headers }));
          captured.response = response.clone();
          return response;
        }
      }
    });
    const reset = await client.resetPassword({
      token: resetToken,
      newPassword: 'Commerce-recovery-password-2026'
    });
    expect(reset.error).toBeNull();
    expect(reset.data).toMatchObject({ status: true, commerceClaimReady: true });
    expect(await captured.response?.clone().json())
      .toEqual({ status: true, commerceClaimReady: true });
    expect(captured.response?.headers.get('set-cookie') ?? '')
      .not.toContain('pale-orbit-commerce-claim=');
    expect(currentCommerceClaimProof()).not.toBeNull();
    expect(await ownerDatabaseClient.db
      .select({ state: commerceClaimIssuances.state })
      .from(commerceClaimIssuances))
      .toEqual([{ state: 'authorized' }]);
    expect(await ownerDatabaseClient.db
      .select({ identifier: verification.identifier, value: verification.value })
      .from(verification)).toEqual(blockedMagicVerification);
  });
});
