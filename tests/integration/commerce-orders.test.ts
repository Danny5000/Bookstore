import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { createCommerceClaimAuthorization } from './commerce-claim-capability';
import { findOrCreateGuestIdentity } from '$lib/server/auth/identity';
import { claimGuestPurchases } from '$lib/server/commerce/claims';
import {
  CartChangedError,
  CommerceConflictError,
  CommerceRateLimitError,
  PermanentCommerceError
} from '$lib/server/commerce/errors';
import { attachCheckoutSession, createAcceptedOrder } from '$lib/server/commerce/orders';
import {
  checkoutProviderStartDeadline,
  quoteCart
} from '$lib/server/commerce/quote';
import { setPreservedGrantState } from '$lib/server/commerce/grants';
import { matchesOrderStatusToken } from '$lib/server/commerce/status-cookie';
import { getAuthorizedOrderStatus } from '$lib/server/commerce/status';
import {
  auditEvents,
  entitlementGrants,
  entitlements,
  orderItems,
  orders,
  payments,
  proseBlocks,
  proseSections,
  revisionPresentations,
  titleRevisions,
  titles,
  user
} from '$lib/server/db/schema';
import { databaseClient, ownerDatabaseClient, workerDatabaseClient } from './database';

async function createCustomer(label: string): Promise<Extract<Actor, { type: 'user' }>> {
  const id = randomUUID();
  await databaseClient.db.insert(user).values({
    id,
    name: label,
    email: `${id}@example.com`,
    emailVerified: true
  });
  return { type: 'user', id, roles: ['customer'] };
}

async function createOrderTitle(label: string, priceMinor = 1000) {
  const [title] = await ownerDatabaseClient.db.insert(titles).values({
    slug: `order-${randomUUID()}`,
    title: label,
    description: `${label} description`,
    creatorName: `${label} creator`,
    format: 'prose',
    priceMinor,
    currency: 'USD',
    visibility: 'public'
  }).returning();
  if (!title) throw new Error('Expected title');
  const [revision] = await ownerDatabaseClient.db.insert(titleRevisions).values({
    titleId: title.id,
    state: 'active',
    createdByActorId: 'system:test',
    changeSummary: 'Order fixture'
  }).returning();
  if (!revision) throw new Error('Expected revision');
  const [section] = await ownerDatabaseClient.db.insert(proseSections).values({
    revisionId: revision.id,
    ordinal: 0,
    label: 'Chapter',
    sourceReference: 'EPUB/chapter.xhtml'
  }).returning();
  if (!section) throw new Error('Expected section');
  const [block] = await ownerDatabaseClient.db.insert(proseBlocks).values({
    revisionId: revision.id,
    sectionId: section.id,
    ordinal: 0,
    kind: 'paragraph',
    content: { kind: 'paragraph', fragments: [{ text: 'Order preview', marks: [] }] },
    imageId: null
  }).returning();
  if (!block) throw new Error('Expected block');
  await ownerDatabaseClient.db.insert(revisionPresentations).values({
    revisionId: revision.id,
    state: 'published',
    previewProseSectionId: section.id,
    previewProseBlockId: block.id,
    previewComicPageId: null
  });
  await ownerDatabaseClient.db.update(titles)
    .set({ activeRevisionId: revision.id })
    .where(eq(titles.id, title.id));
  return title;
}

async function createPaidGuestPurchase(email: string, titleId: string): Promise<void> {
  const identity = await findOrCreateGuestIdentity(workerDatabaseClient.db, email);
  const orderId = randomUUID();
  const itemId = randomUUID();
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    initiatingUserId: null,
    guestIdentityId: identity.id,
    purchaseEmail: identity.email,
    currency: 'USD',
    subtotalMinor: 1000,
    taxMinor: 0,
    totalMinor: 1000,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'c'.repeat(64),
    stripeCheckoutSessionId: `cs_test_${orderId}`,
    statusTokenSha256: 'd'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt: new Date('2026-08-10T12:05:00.000Z')
  });
  await ownerDatabaseClient.db.insert(orderItems).values({
    id: itemId,
    orderId,
    titleId,
    titleSnapshot: 'Guest purchase title',
    creatorNameSnapshot: 'Guest purchase creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 1000,
    taxMinor: 0,
    totalMinor: 1000,
    stripeLineItemId: `li_test_${itemId}`
  });
  await ownerDatabaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: `pi_test_${orderId}`,
    stripeLatestChargeId: `ch_test_${orderId}`,
    status: 'succeeded',
    amountMinor: 1000,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt: new Date('2026-08-10T12:05:00.000Z')
  });
  await ownerDatabaseClient.db.insert(entitlementGrants).values({
    titleId,
    userId: null,
    source: 'purchase',
    orderItemId: itemId,
    state: 'unclaimed',
    stateReason: 'payment_succeeded',
    grantedAt: new Date('2026-08-10T12:05:00.000Z')
  });
}

function orderInput(
  actor: Actor,
  titleIds: string[],
  quoteFingerprint: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    actor,
    titleIds,
    quoteFingerprint,
    checkoutAttemptId: randomUUID(),
    correlationId: `checkout-${randomUUID()}`,
    requestIp: `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
    applicationSecret: 'integration-application-secret-that-is-long-enough',
    rateLimit: { windowSeconds: 60, maxAttempts: 100 },
    ...overrides
  };
}

describe('durable accepted commerce orders', () => {
  it('creates immutable account and guest snapshots while persisting only the status digest', async () => {
    const account = await createCustomer('Order Account');
    const first = await createOrderTitle('Private Audit Title One', 1200);
    const second = await createOrderTitle('Private Audit Title Two', 800);
    const titleIds = [second.id, first.id];
    const accountQuote = await quoteCart(databaseClient.db, account, titleIds);
    const accountResult = await createAcceptedOrder(
      databaseClient.db,
      orderInput(account, titleIds, accountQuote.fingerprint)
    );
    const guestQuote = await quoteCart(databaseClient.db, { type: 'anonymous' }, [first.id]);
    const guestResult = await createAcceptedOrder(
      databaseClient.db,
      orderInput({ type: 'anonymous' }, [first.id], guestQuote.fingerprint)
    );

    expect(accountResult.reused).toBe(false);
    expect(accountResult.statusToken).toBeNull();
    expect(accountResult.order).toMatchObject({
      initiatingUserId: account.id,
      purchaseEmail: `${account.id}@example.com`,
      guestIdentityId: null,
      status: 'checkout_pending',
      currency: 'USD',
      subtotalMinor: 2000,
      stripeCheckoutSessionId: null,
      checkoutExpiresAt: null
    });
    expect(accountResult.items.map((item) => ({
      titleId: item.titleId,
      title: item.titleSnapshot,
      creator: item.creatorNameSnapshot,
      amount: item.unitSubtotalMinor
    }))).toEqual([
      { titleId: first.id, title: first.title, creator: first.creatorName, amount: 1200 },
      { titleId: second.id, title: second.title, creator: second.creatorName, amount: 800 }
    ].sort((left, right) => left.titleId < right.titleId ? -1 : 1));
    expect(guestResult.order).toMatchObject({
      initiatingUserId: null,
      guestIdentityId: null,
      purchaseEmail: null
    });
    expect(guestResult.statusToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(matchesOrderStatusToken(
      guestResult.statusToken!,
      guestResult.order.statusTokenSha256
    )).toBe(true);
    expect(JSON.stringify(guestResult.order)).not.toContain(guestResult.statusToken);

    const audits = await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'commerce.checkout_created'));
    const ownAudits = audits.filter((event) =>
      event.resourceId === accountResult.order.id || event.resourceId === guestResult.order.id
    );
    expect(ownAudits).toHaveLength(2);
    const serialized = JSON.stringify(ownAudits);
    expect(serialized).not.toMatch(/Private Audit Title|@example\.com|Bearer|user-agent/iu);
    expect(serialized).not.toContain(guestResult.statusToken!);
    expect(ownAudits[0]?.after).toEqual(expect.objectContaining({
      itemCount: expect.any(Number),
      currency: 'USD',
      subtotalMinor: expect.any(Number),
      orderId: expect.any(String)
    }));
  });

  it('returns cart changed and writes no order for a stale or empty accepted quote', async () => {
    const title = await createOrderTitle('Changing Order Title');
    const quote = await quoteCart(databaseClient.db, { type: 'anonymous' }, [title.id]);
    const staleInput = orderInput({ type: 'anonymous' }, [title.id], quote.fingerprint);
    await ownerDatabaseClient.db.update(titles).set({ priceMinor: 1500 })
      .where(eq(titles.id, title.id));

    const before = await databaseClient.db.select({ value: count() }).from(orders);
    const staleError = await createAcceptedOrder(databaseClient.db, staleInput)
      .catch((cause: unknown) => cause);
    expect(staleError).toBeInstanceOf(CartChangedError);
    expect(staleError).toMatchObject({ quote: { subtotalMinor: 1500 } });

    const unknown = randomUUID();
    const emptyQuote = await quoteCart(databaseClient.db, { type: 'anonymous' }, [unknown]);
    await expect(createAcceptedOrder(
      databaseClient.db,
      orderInput({ type: 'anonymous' }, [unknown], emptyQuote.fingerprint)
    )).rejects.toBeInstanceOf(CartChangedError);
    const after = await databaseClient.db.select({ value: count() }).from(orders);
    expect(after[0]?.value).toBe(before[0]?.value);
  });

  it('commits checkout throttle consumption even when an accepted quote is stale', async () => {
    const title = await createOrderTitle('Throttled Stale Order Title');
    const actor: Actor = { type: 'anonymous' };
    const quote = await quoteCart(databaseClient.db, actor, [title.id]);
    await ownerDatabaseClient.db.update(titles).set({ priceMinor: 1700 })
      .where(eq(titles.id, title.id));
    const common = {
      requestIp: '203.0.113.249',
      rateLimit: { windowSeconds: 60, maxAttempts: 1 },
      now: new Date('2026-08-10T12:00:00.000Z')
    };

    await expect(createAcceptedOrder(databaseClient.db, orderInput(
      actor,
      [title.id],
      quote.fingerprint,
      common
    ))).rejects.toBeInstanceOf(CartChangedError);
    await expect(createAcceptedOrder(databaseClient.db, orderInput(
      actor,
      [title.id],
      quote.fingerprint,
      common
    ))).rejects.toBeInstanceOf(CommerceRateLimitError);
  });

  it('serializes concurrent retries to one order and returns the same valid guest credential', async () => {
    const title = await createOrderTitle('Concurrent Order Title');
    const actor: Actor = { type: 'anonymous' };
    const quote = await quoteCart(databaseClient.db, actor, [title.id]);
    const input = orderInput(actor, [title.id], quote.fingerprint);

    const [first, second] = await Promise.all([
      createAcceptedOrder(databaseClient.db, input),
      createAcceptedOrder(databaseClient.db, input)
    ]);
    expect(first.order.id).toBe(second.order.id);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(first.statusToken).toBe(second.statusToken);
    const stored = await databaseClient.db.select().from(orders)
      .where(eq(orders.clientCheckoutAttemptId, input.checkoutAttemptId));
    expect(stored).toHaveLength(1);
    expect(matchesOrderStatusToken(first.statusToken!, stored[0]!.statusTokenSha256)).toBe(true);
    expect(matchesOrderStatusToken(second.statusToken!, stored[0]!.statusTokenSha256)).toBe(true);
    const items = await databaseClient.db.select().from(orderItems)
      .where(eq(orderItems.orderId, stored[0]!.id));
    expect(items).toHaveLength(1);
    const audit = await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.resourceId, stored[0]!.id));
    expect(audit).toHaveLength(1);
  });

  it('serializes distinct signed-in attempts to one active title reservation', async () => {
    const customer = await createCustomer('Reserved Order Customer');
    const title = await createOrderTitle('Reserved Order Title');
    const now = new Date('2026-08-10T12:00:00.000Z');
    const firstAttemptId = randomUUID();
    const secondAttemptId = randomUUID();
    const [firstQuote, secondQuote] = await Promise.all([
      quoteCart(databaseClient.db, customer, [title.id], firstAttemptId),
      quoteCart(databaseClient.db, customer, [title.id], secondAttemptId)
    ]);
    const firstInput = orderInput(customer, [title.id], firstQuote.fingerprint, {
      checkoutAttemptId: firstAttemptId,
      now
    });
    const secondInput = orderInput(customer, [title.id], secondQuote.fingerprint, {
      checkoutAttemptId: secondAttemptId,
      now
    });

    const outcomes = await Promise.allSettled([
      createAcceptedOrder(databaseClient.db, firstInput),
      createAcceptedOrder(databaseClient.db, secondInput)
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: {
        quote: {
          items: [],
          reservedTitleIds: [title.id],
          canCheckout: false
        }
      }
    });
    expect(await databaseClient.db.select().from(orders)
      .where(eq(orders.initiatingUserId, customer.id))).toHaveLength(1);
  });

  it('resumes its own pending attempt and never releases ambiguous states on elapsed local time', async () => {
    const customer = await createCustomer('Reservation Lifetime Customer');
    const title = await createOrderTitle('Reservation Lifetime Title');
    const checkoutAttemptId = randomUUID();
    const quote = await quoteCart(databaseClient.db, customer, [title.id], checkoutAttemptId);
    const input = orderInput(customer, [title.id], quote.fingerprint, {
      checkoutAttemptId
    });
    const accepted = await createAcceptedOrder(databaseClient.db, input);
    const createdAt = accepted.order.createdAt;

    await expect(quoteCart(
      databaseClient.db,
      customer,
      [title.id],
      checkoutAttemptId,
      new Date(createdAt.getTime() + 1_000)
    )).resolves.toMatchObject({
      items: [{ titleId: title.id }],
      reservedTitleIds: []
    });

    const atProviderDeadline = checkoutProviderStartDeadline(createdAt);
    await expect(createAcceptedOrder(databaseClient.db, {
      ...input,
      now: atProviderDeadline
    })).resolves.toMatchObject({ reused: true, order: { id: accepted.order.id } });
    await expect(quoteCart(
      databaseClient.db,
      customer,
      [title.id],
      checkoutAttemptId,
      atProviderDeadline
    )).resolves.toMatchObject({
      items: [{ titleId: title.id }],
      reservedTitleIds: []
    });

    const afterPendingDeadline = new Date(atProviderDeadline.getTime() + 1);
    await expect(createAcceptedOrder(databaseClient.db, {
      ...input,
      now: afterPendingDeadline
    })).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
    await expect(quoteCart(
      databaseClient.db,
      customer,
      [title.id],
      randomUUID(),
      afterPendingDeadline
    )).resolves.toMatchObject({
      items: [],
      reservedTitleIds: [title.id],
      canCheckout: false
    });

    await databaseClient.db.update(orders).set({
      status: 'checkout_open',
      stripeCheckoutSessionId: `cs_test_${accepted.order.id}`,
      checkoutExpiresAt: new Date(createdAt.getTime() + 1_860_000)
    }).where(eq(orders.id, accepted.order.id));
    await expect(quoteCart(
      databaseClient.db,
      customer,
      [title.id],
      checkoutAttemptId,
      new Date(createdAt.getTime() + 1_000)
    )).resolves.toMatchObject({
      items: [{ titleId: title.id }],
      reservedTitleIds: []
    });
    await ownerDatabaseClient.db.update(orders).set({ status: 'payment_pending' })
      .where(eq(orders.id, accepted.order.id));
    await expect(quoteCart(
      databaseClient.db,
      customer,
      [title.id],
      checkoutAttemptId,
      new Date(createdAt.getTime() + 1_000)
    )).resolves.toMatchObject({
      items: [],
      reservedTitleIds: [title.id]
    });

    for (const status of [
      'checkout_pending', 'checkout_open', 'payment_pending', 'failed', 'exception'
    ] as const) {
      await ownerDatabaseClient.db.update(orders).set({ status })
        .where(eq(orders.id, accepted.order.id));
      await expect(quoteCart(
        databaseClient.db,
        customer,
        [title.id],
        randomUUID(),
        new Date('2026-08-12T12:00:00.000Z')
      )).resolves.toMatchObject({
        items: [],
        reservedTitleIds: [title.id],
        canCheckout: false
      });
    }
  });

  it('reuses a partially accepted cart with its exact original reviewed partition', async () => {
    const customer = await createCustomer('Partial Reservation Customer');
    const reserved = await createOrderTitle('Partial Reserved Title');
    const available = await createOrderTitle('Partial Available Title');
    const firstAttemptId = randomUUID();
    const firstQuote = await quoteCart(
      databaseClient.db, customer, [reserved.id], firstAttemptId
    );
    const reservation = await createAcceptedOrder(databaseClient.db, orderInput(
      customer,
      [reserved.id],
      firstQuote.fingerprint,
      { checkoutAttemptId: firstAttemptId }
    ));

    const partialAttemptId = randomUUID();
    const requested = [reserved.id, available.id];
    const partialQuote = await quoteCart(
      databaseClient.db, customer, requested, partialAttemptId
    );
    expect(partialQuote).toMatchObject({
      items: [{ titleId: available.id }],
      reservedTitleIds: [reserved.id]
    });
    const partialInput = orderInput(customer, requested, partialQuote.fingerprint, {
      checkoutAttemptId: partialAttemptId
    });
    const first = await createAcceptedOrder(databaseClient.db, partialInput);
    const retried = await createAcceptedOrder(databaseClient.db, partialInput);

    expect(first.items.map((item) => item.titleId)).toEqual([available.id]);
    expect(retried).toMatchObject({
      reused: true,
      order: { id: first.order.id }
    });
    await ownerDatabaseClient.db.update(orders).set({ status: 'expired' })
      .where(eq(orders.id, reservation.order.id));
    await expect(createAcceptedOrder(databaseClient.db, partialInput)).rejects.toMatchObject({
      code: 'CHECKOUT_ATTEMPT_CONFLICT'
    });
  });

  it('rechecks ownership under the entitlement scope before reusing an attempt', async () => {
    const customer = await createCustomer('Reuse Ownership Customer');
    const title = await createOrderTitle('Reuse Ownership Title');
    const checkoutAttemptId = randomUUID();
    const quote = await quoteCart(databaseClient.db, customer, [title.id], checkoutAttemptId);
    const input = orderInput(customer, [title.id], quote.fingerprint, { checkoutAttemptId });
    await createAcceptedOrder(databaseClient.db, input);
    await workerDatabaseClient.db.transaction((transaction) => setPreservedGrantState(transaction, {
      userId: customer.id,
      titleId: title.id,
      active: true,
      stateReason: 'test_reuse_became_owned'
    }));

    await expect(createAcceptedOrder(databaseClient.db, input)).rejects.toMatchObject({
      code: 'CHECKOUT_ATTEMPT_CONFLICT'
    });
  });

  it('serializes a same-email guest claim against stale signed-in checkout acceptance', async () => {
    const customer = await createCustomer('Concurrent Guest Claim Customer');
    const [account] = await databaseClient.db.select().from(user)
      .where(eq(user.id, customer.id));
    if (!account) throw new Error('Expected customer');
    const title = await createOrderTitle('Concurrent Guest Claim Title');
    const checkoutAttemptId = randomUUID();
    const staleQuote = await quoteCart(
      databaseClient.db, customer, [title.id], checkoutAttemptId
    );
    await createPaidGuestPurchase(account.email, title.id);
    const checkoutInput = orderInput(customer, [title.id], staleQuote.fingerprint, {
      checkoutAttemptId
    });
    const authorizationToken = await createCommerceClaimAuthorization(databaseClient.db, {
      email: account.email,
      kind: 'password-reset'
    });

    const [claimResult, checkoutResult] = await Promise.allSettled([
      claimGuestPurchases(databaseClient.db, {
        userId: customer.id,
        correlationId: `claim-${randomUUID()}`,
        authorizationToken
      }),
      createAcceptedOrder(databaseClient.db, checkoutInput)
    ]);

    expect(claimResult).toMatchObject({ status: 'fulfilled' });
    expect(checkoutResult).toMatchObject({
      status: 'rejected',
      reason: { code: 'CART_CHANGED' }
    });
    expect(await databaseClient.db.select().from(orders)
      .where(eq(orders.initiatingUserId, customer.id))).toHaveLength(0);
    expect(await databaseClient.db.select().from(entitlements)
      .where(eq(entitlements.userId, customer.id))).toEqual([
      expect.objectContaining({ titleId: title.id, revokedAt: null })
    ]);
  });

  it('rejects exact reuse after the checkout attempt reaches a terminal state', async () => {
    const title = await createOrderTitle('Terminal Checkout Attempt Title');
    const actor: Actor = { type: 'anonymous' };
    const quote = await quoteCart(databaseClient.db, actor, [title.id]);
    const input = orderInput(actor, [title.id], quote.fingerprint);
    const accepted = await createAcceptedOrder(databaseClient.db, input);
    await ownerDatabaseClient.db
      .update(orders)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(orders.id, accepted.order.id));

    await expect(createAcceptedOrder(databaseClient.db, input))
      .rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
  });

  it('rejects attempt reuse by another actor or a different exact cart', async () => {
    const firstUser = await createCustomer('First Attempt Owner');
    const otherUser = await createCustomer('Other Attempt Owner');
    const first = await createOrderTitle('Attempt Title One');
    const second = await createOrderTitle('Attempt Title Two');
    const quote = await quoteCart(databaseClient.db, firstUser, [first.id]);
    const input = orderInput(firstUser, [first.id], quote.fingerprint);
    await createAcceptedOrder(databaseClient.db, input);

    await expect(createAcceptedOrder(databaseClient.db, {
      ...input,
      actor: otherUser
    })).rejects.toBeInstanceOf(CommerceConflictError);
    await expect(createAcceptedOrder(databaseClient.db, {
      ...input,
      titleIds: [second.id]
    })).rejects.toBeInstanceOf(CommerceConflictError);
  });

  it('rolls order and items back when the audit write fails', async () => {
    const title = await createOrderTitle('Rollback Order Title');
    const quote = await quoteCart(databaseClient.db, { type: 'anonymous' }, [title.id]);
    const input = orderInput({ type: 'anonymous' }, [title.id], quote.fingerprint);

    await expect(createAcceptedOrder(databaseClient.db, input, {
      appendAuditEvent: async () => {
        throw new Error('forced audit failure');
      }
    })).rejects.toThrow('forced audit failure');
    expect(await databaseClient.db.select().from(orders)
      .where(eq(orders.clientCheckoutAttemptId, input.checkoutAttemptId))).toHaveLength(0);
    expect(await databaseClient.db.select().from(orderItems)
      .where(eq(orderItems.titleId, title.id))).toHaveLength(0);
  });

  it('attaches one provider Session idempotently and commits conflicting IDs as exceptions', async () => {
    const title = await createOrderTitle('Session Attachment Title');
    const actor: Actor = { type: 'anonymous' };
    const quote = await quoteCart(databaseClient.db, actor, [title.id]);
    const accepted = await createAcceptedOrder(
      databaseClient.db,
      orderInput(actor, [title.id], quote.fingerprint)
    );
    const expiresAt = new Date(accepted.order.createdAt.getTime() + 1_800_000);
    const attachInput = {
      orderId: accepted.order.id,
      providerSessionId: 'cs_test_attachment_101',
      checkoutExpiresAt: expiresAt,
      actor,
      correlationId: `attach-${randomUUID()}`
    };

    await attachCheckoutSession(databaseClient.db, attachInput);
    await expect(attachCheckoutSession(databaseClient.db, attachInput)).resolves.toBeUndefined();
    const [opened] = await databaseClient.db.select().from(orders)
      .where(eq(orders.id, accepted.order.id));
    expect(opened).toMatchObject({
      status: 'checkout_open',
      stripeCheckoutSessionId: 'cs_test_attachment_101',
      checkoutExpiresAt: expiresAt
    });
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'commerce.checkout_session_conflict'))).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ resourceId: accepted.order.id })])
      );

    await expect(attachCheckoutSession(databaseClient.db, {
      ...attachInput,
      providerSessionId: 'cs_test_conflicting_202'
    })).rejects.toBeInstanceOf(PermanentCommerceError);
    const [exception] = await databaseClient.db.select().from(orders)
      .where(eq(orders.id, accepted.order.id));
    expect(exception).toMatchObject({
      status: 'exception',
      stripeCheckoutSessionId: 'cs_test_attachment_101'
    });
    const conflictAudits = await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'commerce.checkout_session_conflict'));
    const ownAudit = conflictAudits.find((event) => event.resourceId === accepted.order.id);
    expect(ownAudit?.after).toEqual({
      orderId: accepted.order.id,
      category: 'provider_session_conflict',
      hadAttachedSession: true
    });
    expect(JSON.stringify(ownAudit)).not.toMatch(/cs_test_|Session Attachment Title/iu);
  });

  it('does not reopen a checkout when its provider response arrives after expiry', async () => {
    const title = await createOrderTitle('Late Session Attachment Title');
    const actor: Actor = { type: 'anonymous' };
    const quote = await quoteCart(databaseClient.db, actor, [title.id]);
    const accepted = await createAcceptedOrder(
      databaseClient.db,
      orderInput(actor, [title.id], quote.fingerprint, {
        now: new Date('2026-08-10T12:00:00.000Z')
      })
    );
    const responseAt = new Date(Math.max(Date.now(), accepted.order.createdAt.getTime()));
    const expiresAt = new Date(responseAt.getTime() - 1);

    await expect(attachCheckoutSession(databaseClient.db, {
      orderId: accepted.order.id,
      providerSessionId: 'cs_test_late_attachment_101',
      checkoutExpiresAt: expiresAt,
      actor,
      correlationId: `attach-${randomUUID()}`,
      now: responseAt
    })).rejects.toBeInstanceOf(PermanentCommerceError);

    await expect(databaseClient.db.select().from(orders)
      .where(eq(orders.id, accepted.order.id))).resolves.toEqual([
      expect.objectContaining({
        status: 'checkout_open',
        stripeCheckoutSessionId: 'cs_test_late_attachment_101',
        checkoutExpiresAt: expiresAt
      })
    ]);
  });

  it.each(['payment_pending', 'paid', 'failed', 'expired', 'exception'] as const)(
    'rejects a delayed exact attach after the order becomes %s',
    async (terminalStatus) => {
    const title = await createOrderTitle('Webhook Before Attach Title');
    const actor = await createCustomer(`Attach terminal ${terminalStatus}`);
    const quote = await quoteCart(databaseClient.db, actor, [title.id]);
    const accepted = await createAcceptedOrder(
      databaseClient.db,
      orderInput(actor, [title.id], quote.fingerprint)
    );
    const providerSessionId = 'cs_test_webhook_before_attach_101';
    const checkoutExpiresAt = new Date(accepted.order.createdAt.getTime() + 1_860_000);
    await ownerDatabaseClient.db.update(orders).set({
      status: terminalStatus,
      stripeCheckoutSessionId: providerSessionId,
      checkoutExpiresAt,
      ...(terminalStatus === 'paid'
        ? {
            taxMinor: 0,
            totalMinor: accepted.order.subtotalMinor,
            paidAt: new Date(accepted.order.createdAt.getTime() + 5_000)
          }
        : {})
    }).where(eq(orders.id, accepted.order.id));

    await expect(attachCheckoutSession(databaseClient.db, {
      orderId: accepted.order.id,
      providerSessionId,
      checkoutExpiresAt,
      actor,
      correlationId: `attach-${randomUUID()}`,
      now: new Date(accepted.order.createdAt.getTime() + 10_000)
    })).rejects.toBeInstanceOf(PermanentCommerceError);
    await expect(databaseClient.db.select().from(orders)
      .where(eq(orders.id, accepted.order.id))).resolves.toEqual([
      expect.objectContaining({ status: terminalStatus, stripeCheckoutSessionId: providerSessionId })
    ]);
    }
  );

  it('authorizes persisted status only by the initiating account or exact guest cookie', async () => {
    const account = await createCustomer('Status Account');
    const other = await createCustomer('Status Other Admin');
    const title = await createOrderTitle('Status Authorization Title');
    const accountQuote = await quoteCart(databaseClient.db, account, [title.id]);
    const accountOrder = await createAcceptedOrder(
      databaseClient.db,
      orderInput(account, [title.id], accountQuote.fingerprint)
    );
    await expect(getAuthorizedOrderStatus(databaseClient.db, {
      orderId: accountOrder.order.id,
      actor: account,
      statusToken: null
    })).resolves.toEqual({ status: 'pending' });
    await expect(getAuthorizedOrderStatus(databaseClient.db, {
      orderId: accountOrder.order.id,
      actor: { ...other, roles: ['customer', 'admin'] },
      statusToken: null
    })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });

    const guestQuote = await quoteCart(databaseClient.db, { type: 'anonymous' }, [title.id]);
    const guestOrder = await createAcceptedOrder(
      databaseClient.db,
      orderInput({ type: 'anonymous' }, [title.id], guestQuote.fingerprint)
    );
    const expiresAt = new Date(Date.now() + 1_800_000);
    await attachCheckoutSession(databaseClient.db, {
      orderId: guestOrder.order.id,
      providerSessionId: 'cs_test_status_101',
      checkoutExpiresAt: expiresAt,
      actor: { type: 'anonymous' },
      correlationId: `status-${randomUUID()}`
    });
    await expect(getAuthorizedOrderStatus(databaseClient.db, {
      orderId: guestOrder.order.id,
      actor: { type: 'anonymous' },
      statusToken: guestOrder.statusToken
    })).resolves.toEqual({ status: 'pending' });
    await expect(getAuthorizedOrderStatus(databaseClient.db, {
      orderId: guestOrder.order.id,
      actor: { type: 'anonymous' },
      statusToken: Buffer.alloc(32, 1).toString('base64url')
    })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });
});
