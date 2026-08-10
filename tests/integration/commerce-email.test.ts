import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  COMMERCE_CLAIM_EMAIL_JOB,
  claimEmailJobPayloadSchema,
  createClaimEmailHandler,
  createClaimEmailOperations,
  queueCommerceClaimEmail
} from '$lib/server/commerce/claim-email';
import {
  createCommerceMessageEnqueuer
} from '$lib/server/commerce/email/enqueue';
import {
  parseCommerceEmailPayload
} from '$lib/server/commerce/email/payload';
import { fulfillCheckoutEvent } from '$lib/server/commerce/fulfillment';
import { createAuthServer } from '$lib/server/auth/options';
import { canSendMagicLink, ensureCustomerRole } from '$lib/server/auth/identity';
import {
  account,
  guestIdentities,
  jobs,
  orderItems,
  orders,
  outboxMessages,
  stripeEvents,
  titles,
  user,
  verification
} from '$lib/server/db/schema';
import { queueAuthEmail } from '$lib/server/email/enqueue';
import { authEmailPayloadSchema } from '$lib/server/email/payload';
import type { JobRecord } from '$lib/server/jobs/types';
import { OutboxDeduplicationInvariantError } from '$lib/server/outbox/repository';
import { applicationConfig, databaseClient } from './database';

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
    const [identity] = await databaseClient.db.insert(guestIdentities).values({
      email
    }).returning();
    if (!identity) throw new Error('Expected guest identity');
    guestIdentityId = identity.id;
  }
  await databaseClient.db.insert(orders).values({
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
  await databaseClient.db.insert(orderItems).values({
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
  return { orderId, itemId };
}

function createCommerceAuth() {
  const messages = createCommerceMessageEnqueuer(applicationConfig.origin);
  const auth = createAuthServer({
    database: databaseClient.db,
    config: applicationConfig,
    queueVerificationEmail: (input) => queueAuthEmail(databaseClient.db, input),
    queueResetEmail: (input) => queueAuthEmail(databaseClient.db, input),
    queueMagicEmail: (input) => queueAuthEmail(databaseClient.db, input),
    queueCommerceClaimEmail: (input) =>
      queueCommerceClaimEmail(databaseClient.db, messages, input),
    canSendMagicLink: (email) => canSendMagicLink(databaseClient.db, email),
    onUserCreated: (userId) => ensureCustomerRole(databaseClient.db, userId)
  });
  return { auth, messages };
}

function claimJob(orderId: string): JobRecord {
  return {
    id: randomUUID(),
    type: COMMERCE_CLAIM_EMAIL_JOB,
    payload: { orderId },
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

    const messages = await databaseClient.db.select().from(outboxMessages);
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
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(1);
    expect(JSON.stringify(await databaseClient.db.select().from(jobs))).not.toContain('@example.com');

    await databaseClient.db.update(orderItems)
      .set({ titleSnapshot: 'Changed immutable title' })
      .where(eq(orderItems.id, fixture.itemId));
    await expect(databaseClient.db.transaction((transaction) =>
      enqueuer.enqueueAccountReceipt(transaction, fixture.orderId)
    )).rejects.toBeInstanceOf(OutboxDeduplicationInvariantError);
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(1);
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(1);
  });

  it('deduplicates the strict guest claim-preparation job without an email-derived key', async () => {
    const fixture = await createPaidOrder('guest');
    const enqueuer = createCommerceMessageEnqueuer(applicationConfig.origin);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await databaseClient.db.transaction((transaction) =>
        enqueuer.enqueueGuestClaimPreparation(transaction, fixture.orderId)
      );
    }

    const storedJobs = await databaseClient.db.select().from(jobs);
    expect(storedJobs).toHaveLength(1);
    expect(storedJobs[0]).toMatchObject({
      type: COMMERCE_CLAIM_EMAIL_JOB,
      deduplicationKey: `commerce:claim-email:order:${fixture.orderId}:v1`
    });
    expect(claimEmailJobPayloadSchema.parse(storedJobs[0]?.payload)).toEqual({
      orderId: fixture.orderId
    });
    expect(JSON.stringify(storedJobs)).not.toContain('@');
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(0);
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
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(1);
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
    await databaseClient.db.insert(orders).values({
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
    await databaseClient.db.insert(orderItems).values({
      id: itemId,
      orderId,
      titleId: title.id,
      titleSnapshot: title.title,
      creatorNameSnapshot: title.creatorName,
      format: title.format,
      currency: 'USD',
      unitSubtotalMinor: 1299
    });
    const [event] = await databaseClient.db.insert(stripeEvents).values({
      providerEventId: `evt_test_${orderId}`,
      eventType: 'checkout.session.completed',
      objectId: sessionId,
      liveMode: false,
      providerCreatedAt: new Date('2026-08-10T12:05:00.000Z'),
      rawBodySha256: 'e'.repeat(64)
    }).returning();
    if (!event) throw new Error('Expected event');

    await fulfillCheckoutEvent(databaseClient.db, {
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
      (await databaseClient.db.select().from(outboxMessages))[0]?.payload,
      applicationConfig.origin
    )).toMatchObject({
      template: 'commerce.account-receipt',
      messageId: orderId
    });
  });

  it('prepares one hashed, atomic magic link and one matching guest receipt', async () => {
    const fixture = await createPaidOrder('guest', 'claim-reader@example.com');
    const { auth, messages } = createCommerceAuth();
    const handler = createClaimEmailHandler(createClaimEmailOperations(
      databaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ));
    await handler(claimJob(fixture.orderId), new AbortController().signal);

    const commerceRows = (await databaseClient.db.select().from(outboxMessages))
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
    const token = new URL(payload.claimUrl).searchParams.get('token');
    if (!token) throw new Error('Expected magic token');
    const tokenRowsBeforeReplay = await databaseClient.db.select().from(verification);
    expect(tokenRowsBeforeReplay).toHaveLength(1);
    expect(JSON.stringify(tokenRowsBeforeReplay)).not.toContain(token);

    await handler(claimJob(fixture.orderId), new AbortController().signal);
    expect(await databaseClient.db.select().from(verification)).toHaveLength(1);

    const request = () => auth.handler(new Request(payload.claimUrl, {
      headers: { origin: applicationConfig.origin },
      redirect: 'manual'
    }));
    const first = await request();
    expect(first.headers.get('set-cookie')).not.toBeNull();
    const reused = await request();
    expect(reused.headers.get('set-cookie')).toBeNull();
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
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(0);
    expect(JSON.stringify(await databaseClient.db.select().from(jobs)))
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
      databaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ))(claimJob(fixture.orderId), new AbortController().signal);
    const payload = parseCommerceEmailPayload(
      (await databaseClient.db.select().from(outboxMessages)
        .where(eq(outboxMessages.topic, 'email.commerce.v1')))[0]?.payload,
      applicationConfig.origin
    );
    expect(payload.template).toBe('commerce.guest-receipt-claim');
  });

  it('preserves unverified password proof and sends a receipt without a claim action', async () => {
    const email = 'pending-credential@example.com';
    const fixture = await createPaidOrder('guest', email);
    const userId = randomUUID();
    await databaseClient.db.insert(user).values({
      id: userId,
      name: 'Pending credential',
      email,
      emailVerified: false
    });
    await databaseClient.db.insert(account).values({
      id: randomUUID(),
      accountId: email,
      providerId: 'credential',
      userId,
      password: 'test-password-hash'
    });
    const { auth, messages } = createCommerceAuth();
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
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(0);
    await createClaimEmailHandler(createClaimEmailOperations(
      databaseClient.db,
      auth,
      messages,
      applicationConfig.origin
    ))(claimJob(fixture.orderId), new AbortController().signal);

    const rows = await databaseClient.db.select().from(outboxMessages);
    const commerce = rows.find((row) => row.topic === 'email.commerce.v1');
    const verificationMail = rows.find((row) => row.topic === 'email.auth.v1');
    const commercePayload = parseCommerceEmailPayload(
      commerce?.payload,
      applicationConfig.origin
    );
    expect(commercePayload.template).toBe('commerce.account-receipt');
    expect(JSON.stringify(commercePayload)).not.toContain('claimUrl');
    const authPayload = authEmailPayloadSchema.parse(verificationMail?.payload);
    expect(authPayload).toMatchObject({
      template: 'auth.email-verification',
      to: email
    });
    expect(new URL(authPayload.actionUrl).searchParams.get('callbackURL'))
      .toBe('/claim/complete');
    expect(await databaseClient.db.select().from(verification)).not.toHaveLength(0);
  });
});
