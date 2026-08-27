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
import { wrapCommerceClaimActionUrl } from '$lib/server/auth/commerce-claim-capability';

const origin = 'https://books.example.com';
const transaction = {} as DatabaseTransaction;

function commerceClaimBridgeUrl(trustedOrigin = origin): string {
  const orderId = randomUUID();
  const action = new URL('/api/auth/magic-link/verify', trustedOrigin);
  action.searchParams.set('token', 'native-token');
  action.searchParams.set('callbackURL', '/claim/complete');
  action.searchParams.set('errorCallbackURL', '/claim/complete?error=magic-link');
  action.searchParams.set('newUserCallbackURL', '/claim/complete');
  return wrapCommerceClaimActionUrl({
    actionUrl: action.toString(),
    claimProofToken: 'b'.repeat(43),
    anchorOrderId: orderId,
    kind: 'commerce-magic',
    trustedOrigin
  });
}

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
  const enqueueJobReference = vi.fn(async () => ({ id: randomUUID() }) as never);
  const loadReceiptSnapshot = vi.fn(async () => current);
  const enqueuer = createCommerceMessageEnqueuer(origin, {
    enqueueOutboxMessage,
    enqueueJob: enqueueJobReference,
    loadReceiptSnapshot
  });
  return {
    snapshot: initial,
    enqueuer,
    stored,
    enqueueOutboxMessage,
    enqueueJob,
    enqueueJobReference,
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

    expect(test.enqueueJobReference).toHaveBeenCalledWith(transaction, {
      type: COMMERCE_CLAIM_EMAIL_JOB,
      payload: { orderId },
      deduplicationKey: `commerce:claim-email:order:${orderId}:v1`,
      maxAttempts: 8
    });
    expect(test.enqueueJob).not.toHaveBeenCalled();
    expect(JSON.stringify(test.enqueueJobReference.mock.calls)).not.toContain('@');
    expect(test.enqueueOutboxMessage).not.toHaveBeenCalled();
  });

  it('deduplicates a replacement claim message by a digest of its one-use action', async () => {
    const initial = snapshot({ ownerType: 'guest' });
    const test = harness(initial);
    const claimUrl = commerceClaimBridgeUrl();
    await test.enqueuer.enqueueGuestClaimReissue(transaction, initial.orderId, claimUrl);
    await test.enqueuer.enqueueGuestClaimReissue(transaction, initial.orderId, claimUrl);

    const calls = test.enqueueOutboxMessage.mock.calls;
    expect(calls).toHaveLength(2);
    const key = calls[0]?.[1].deduplicationKey;
    expect(key).toMatch(
      new RegExp(`^commerce:claim-reissue:order:${initial.orderId}:action:[a-f0-9]{64}:v1$`, 'u')
    );
    expect(key).not.toContain('replacement-safe');
    expect(calls[0]?.[1].payload).toMatchObject({
      template: 'commerce.guest-receipt-claim',
      messageId: initial.orderId,
      claimUrl
    });
  });

  it('rejects malformed and off-origin claim bridges through the production enqueuer', async () => {
    const initial = snapshot({ ownerType: 'guest' });
    const test = harness(initial);
    const malformed = new URL(commerceClaimBridgeUrl());
    malformed.hash = 'proof=' + 'b'.repeat(43);
    const offOrigin = new URL(commerceClaimBridgeUrl());
    offOrigin.hostname = 'evil.example';

    for (const claimUrl of [malformed.toString(), offOrigin.toString()]) {
      await expect(test.enqueuer.enqueueGuestClaimReissue(
        transaction,
        initial.orderId,
        claimUrl
      )).rejects.toThrow();
    }
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

  it('deduplicates administrative-recovery mail from the actual grant transition', async () => {
    const test = harness();
    const eventId = randomUUID();
    const recoveryGrantId = randomUUID();
    const stateChangedAt = '2026-08-22T12:34:56.789Z';
    const input = {
      template: 'commerce.administrative-recovery-access-changed' as const,
      eventId,
      to: ' Reader@Example.COM ',
      soldAsTitle: 'The Recovered Book',
      accessState: 'active' as const,
      recoveryGrantId,
      stateChangedAt
    };

    await test.enqueuer.enqueueAccessChange(transaction, input);
    await test.enqueuer.enqueueAccessChange(transaction, input);

    const expectedKey =
      `commerce:recovery-access:${recoveryGrantId}:active:${Date.parse(stateChangedAt)}`;
    expect(test.enqueueOutboxMessage).toHaveBeenCalledTimes(2);
    expect(test.stored.size).toBe(1);
    expect(test.enqueueOutboxMessage).toHaveBeenLastCalledWith(transaction, {
      topic: 'email.commerce.v1',
      deduplicationKey: expectedKey,
      payload: {
        version: 1,
        template: 'commerce.administrative-recovery-access-changed',
        to: 'reader@example.com',
        messageId: eventId,
        soldAsTitle: 'The Recovered Book',
        accessState: 'active'
      }
    });
    const serializedPayload = JSON.stringify(test.enqueueOutboxMessage.mock.calls[0]?.[1].payload);
    expect(serializedPayload).not.toContain(recoveryGrantId);
    expect(serializedPayload).not.toContain(stateChangedAt);
  });

  it('uses the exact active or revoked outcome in the recovery deduplication key', async () => {
    const test = harness();
    const recoveryGrantId = randomUUID();
    const activeAt = '2026-08-22T12:34:56.789Z';
    const revokedAt = '2026-08-22T12:35:00.001Z';
    await test.enqueuer.enqueueAccessChange(transaction, {
      template: 'commerce.administrative-recovery-access-changed',
      eventId: randomUUID(),
      to: 'reader@example.com',
      soldAsTitle: 'The Recovered Book',
      accessState: 'active',
      recoveryGrantId,
      stateChangedAt: activeAt
    });
    await test.enqueuer.enqueueAccessChange(transaction, {
      template: 'commerce.administrative-recovery-access-changed',
      eventId: randomUUID(),
      to: 'reader@example.com',
      soldAsTitle: 'The Recovered Book',
      accessState: 'revoked',
      recoveryGrantId,
      stateChangedAt: revokedAt
    });

    expect(test.enqueueOutboxMessage.mock.calls.map((call) => call[1].deduplicationKey))
      .toEqual([
        `commerce:recovery-access:${recoveryGrantId}:active:${Date.parse(activeAt)}`,
        `commerce:recovery-access:${recoveryGrantId}:revoked:${Date.parse(revokedAt)}`
      ]);
  });

  it.each([
    ['uppercase event UUID', { eventId: randomUUID().toUpperCase() }],
    ['uppercase grant UUID', { recoveryGrantId: randomUUID().toUpperCase() }],
    ['missing milliseconds', { stateChangedAt: '2026-08-22T12:34:56Z' }],
    ['short milliseconds', { stateChangedAt: '2026-08-22T12:34:56.78Z' }],
    ['offset timestamp', { stateChangedAt: '2026-08-22T12:34:56.789+00:00' }],
    ['impossible date', { stateChangedAt: '2026-02-29T12:34:56.789Z' }],
    ['unknown input field', { administratorId: randomUUID() }]
  ])('rejects malformed administrative-recovery enqueue input: %s',
    async (_label, overrides) => {
      const test = harness();
      await expect(test.enqueuer.enqueueAccessChange(transaction, {
        template: 'commerce.administrative-recovery-access-changed',
        eventId: randomUUID(),
        to: 'reader@example.com',
        soldAsTitle: 'The Recovered Book',
        accessState: 'active',
        recoveryGrantId: randomUUID(),
        stateChangedAt: '2026-08-22T12:34:56.789Z',
        ...overrides
      } as never)).rejects.toThrow();
      expect(test.enqueueOutboxMessage).not.toHaveBeenCalled();
    });
});
