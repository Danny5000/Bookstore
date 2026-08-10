import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { OutboxDeduplicationInvariantError } from '$lib/server/outbox/repository';
import {
  createCommerceMessageEnqueuer,
  type ReceiptSnapshot
} from './enqueue';
import { COMMERCE_CLAIM_EMAIL_JOB } from '../claim-email';

const origin = 'https://books.example.com';
const transaction = {} as DatabaseTransaction;

function snapshot(overrides: Partial<ReceiptSnapshot> = {}): ReceiptSnapshot {
  const orderId = randomUUID();
  return {
    orderId,
    purchaseEmail: 'reader@example.com',
    paidAt: new Date('2026-08-10T12:05:00.000Z'),
    currency: 'USD',
    subtotalMinor: 1299,
    taxMinor: 104,
    totalMinor: 1403,
    ownerType: 'account',
    items: [{ title: 'Safe Book', creatorName: 'Writer', format: 'prose' }],
    ...overrides
  };
}

function harness(initial = snapshot()) {
  let current = initial;
  const stored = new Map<string, { topic: string; payload: JsonObject }>();
  const enqueueOutboxMessage = vi.fn(async (_transaction, input) => {
    const key = input.deduplicationKey!;
    const next = { topic: input.topic, payload: input.payload };
    const existing = stored.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(next)) {
      throw new OutboxDeduplicationInvariantError();
    }
    stored.set(key, next);
    return { id: randomUUID() } as never;
  });
  const enqueueJob = vi.fn(async () => ({ id: randomUUID() }) as never);
  const loadReceiptSnapshot = vi.fn(async () => current);
  const enqueuer = createCommerceMessageEnqueuer(origin, {
    enqueueOutboxMessage,
    enqueueJob,
    loadReceiptSnapshot
  });
  return {
    snapshot: initial,
    enqueuer,
    enqueueOutboxMessage,
    enqueueJob,
    loadReceiptSnapshot,
    setSnapshot(value: ReceiptSnapshot) { current = value; }
  };
}

describe('transactional commerce email enqueue', () => {
  it('uses the order UUID for one stable account receipt message and key', async () => {
    const test = harness();
    const orderId = test.snapshot.orderId;
    await test.enqueuer.enqueueAccountReceipt(transaction, orderId);
    await test.enqueuer.enqueueAccountReceipt(transaction, orderId);

    expect(test.enqueueOutboxMessage).toHaveBeenCalledTimes(2);
    expect(test.enqueueOutboxMessage).toHaveBeenLastCalledWith(transaction, {
      topic: 'email.commerce.v1',
      deduplicationKey: `commerce:receipt:order:${orderId}:v1`,
      maxAttempts: 8,
      payload: expect.objectContaining({
        version: 1,
        template: 'commerce.account-receipt',
        messageId: orderId,
        orderNumber: orderId,
        to: 'reader@example.com'
      })
    });
    expect(JSON.stringify(test.enqueueOutboxMessage.mock.calls[0])).not.toMatch(
      /provider|stripe|card|billing|storage|media/iu
    );
  });

  it('lets the outbox reject a stable receipt key reconstructed with changed content', async () => {
    const first = snapshot();
    const test = harness(first);
    await test.enqueuer.enqueueAccountReceipt(transaction, first.orderId);
    test.setSnapshot({
      ...first,
      items: [{ ...first.items[0]!, title: 'Changed snapshot' }]
    });
    await expect(test.enqueuer.enqueueAccountReceipt(transaction, first.orderId))
      .rejects.toBeInstanceOf(OutboxDeduplicationInvariantError);
  });

  it('enqueues only the strict order-id claim job with an email-free stable key', async () => {
    const test = harness();
    const orderId = randomUUID();
    await test.enqueuer.enqueueGuestClaimPreparation(transaction, orderId);

    expect(test.enqueueJob).toHaveBeenCalledWith(transaction, {
      type: COMMERCE_CLAIM_EMAIL_JOB,
      payload: { orderId },
      deduplicationKey: `commerce:claim-email:order:${orderId}:v1`,
      maxAttempts: 8
    });
    expect(JSON.stringify(test.enqueueJob.mock.calls)).not.toContain('@');
    expect(test.enqueueOutboxMessage).not.toHaveBeenCalled();
  });

  it('uses the internal event UUID for idempotent access-change mail', async () => {
    const test = harness();
    const eventId = randomUUID();
    const input = {
      template: 'commerce.refund-access-changed' as const,
      eventId,
      to: 'reader@example.com',
      reasonCategory: 'refund_completed' as const,
      affectedTitleCount: 2
    };
    await test.enqueuer.enqueueAccessChange(transaction, input);
    await test.enqueuer.enqueueAccessChange(transaction, input);
    expect(test.enqueueOutboxMessage).toHaveBeenLastCalledWith(transaction, {
      topic: 'email.commerce.v1',
      deduplicationKey: `commerce:access-change:event:${eventId}:v1`,
      maxAttempts: 8,
      payload: expect.objectContaining({
        messageId: eventId,
        libraryUrl: `${origin}/library`,
        helpUrl: `${origin}/help`
      })
    });
    await expect(test.enqueuer.enqueueAccessChange(transaction, {
      ...input,
      affectedTitleCount: 1
    })).rejects.toBeInstanceOf(OutboxDeduplicationInvariantError);
  });
});
