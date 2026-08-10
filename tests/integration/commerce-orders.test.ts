import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import {
  CartChangedError,
  CommerceConflictError,
  CommerceRateLimitError,
  PermanentCommerceError
} from '$lib/server/commerce/errors';
import { attachCheckoutSession, createAcceptedOrder } from '$lib/server/commerce/orders';
import { quoteCart } from '$lib/server/commerce/quote';
import { matchesOrderStatusToken } from '$lib/server/commerce/status-cookie';
import { getAuthorizedOrderStatus } from '$lib/server/commerce/status';
import {
  auditEvents,
  orderItems,
  orders,
  proseBlocks,
  proseSections,
  revisionPresentations,
  titleRevisions,
  titles,
  user
} from '$lib/server/db/schema';
import { databaseClient } from './database';

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
  const [title] = await databaseClient.db.insert(titles).values({
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
  const [revision] = await databaseClient.db.insert(titleRevisions).values({
    titleId: title.id,
    state: 'active',
    createdByActorId: 'system:test',
    changeSummary: 'Order fixture'
  }).returning();
  if (!revision) throw new Error('Expected revision');
  const [section] = await databaseClient.db.insert(proseSections).values({
    revisionId: revision.id,
    ordinal: 0,
    label: 'Chapter',
    sourceReference: 'EPUB/chapter.xhtml'
  }).returning();
  if (!section) throw new Error('Expected section');
  const [block] = await databaseClient.db.insert(proseBlocks).values({
    revisionId: revision.id,
    sectionId: section.id,
    ordinal: 0,
    kind: 'paragraph',
    content: { kind: 'paragraph', fragments: [{ text: 'Order preview', marks: [] }] },
    imageId: null
  }).returning();
  if (!block) throw new Error('Expected block');
  await databaseClient.db.insert(revisionPresentations).values({
    revisionId: revision.id,
    state: 'published',
    previewProseSectionId: section.id,
    previewProseBlockId: block.id,
    previewComicPageId: null
  });
  await databaseClient.db.update(titles)
    .set({ activeRevisionId: revision.id })
    .where(eq(titles.id, title.id));
  return title;
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
    await databaseClient.db.update(titles).set({ priceMinor: 1500 }).where(eq(titles.id, title.id));

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
    await databaseClient.db.update(titles).set({ priceMinor: 1700 }).where(eq(titles.id, title.id));
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

  it('serializes concurrent retries to one order and rotates only the guest credential', async () => {
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
    expect(first.statusToken).not.toBe(second.statusToken);
    const stored = await databaseClient.db.select().from(orders)
      .where(eq(orders.clientCheckoutAttemptId, input.checkoutAttemptId));
    expect(stored).toHaveLength(1);
    const currentToken = first.reused ? first.statusToken : second.statusToken;
    const supersededToken = first.reused ? second.statusToken : first.statusToken;
    expect(matchesOrderStatusToken(currentToken!, stored[0]!.statusTokenSha256)).toBe(true);
    expect(matchesOrderStatusToken(supersededToken!, stored[0]!.statusTokenSha256)).toBe(false);
    const items = await databaseClient.db.select().from(orderItems)
      .where(eq(orderItems.orderId, stored[0]!.id));
    expect(items).toHaveLength(1);
    const audit = await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.resourceId, stored[0]!.id));
    expect(audit).toHaveLength(1);
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
