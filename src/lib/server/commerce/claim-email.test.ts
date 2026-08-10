import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PermanentJobError } from '$lib/server/jobs/runner';
import type { JobRecord } from '$lib/server/jobs/types';
import {
  COMMERCE_CLAIM_EMAIL_JOB,
  commerceReceiptDeduplicationKey,
  createClaimEmailHandler,
  type ClaimEmailOperations
} from './claim-email';

function job(orderId = randomUUID()): JobRecord {
  return {
    id: randomUUID(),
    type: COMMERCE_CLAIM_EMAIL_JOB,
    payload: { orderId },
    attempts: 1,
    maxAttempts: 8,
    lockedBy: 'claim-test'
  };
}

function operations(overrides: Partial<ClaimEmailOperations> = {}): ClaimEmailOperations {
  return {
    receiptExists: vi.fn(async () => false),
    loadEligibility: vi.fn(async (orderId) => ({
      orderId,
      email: 'guest@example.com',
      accountState: 'magic-link' as const
    })),
    requestMagicLink: vi.fn(async () => undefined),
    requestVerification: vi.fn(async () => undefined),
    enqueueReceiptWithoutClaim: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('commerce claim-email job', () => {
  it('uses an internal order-only receipt key and exits before loading when it exists', async () => {
    const record = job();
    const ops = operations({ receiptExists: vi.fn(async () => true) });
    await createClaimEmailHandler(ops)(record, new AbortController().signal);
    expect(commerceReceiptDeduplicationKey(record.payload.orderId as string)).toBe(
      `commerce:receipt:order:${record.payload.orderId}:v1`
    );
    expect(ops.loadEligibility).not.toHaveBeenCalled();
    expect(ops.requestMagicLink).not.toHaveBeenCalled();
  });

  it('requests one metadata-bound magic link for no account or a verified account', async () => {
    const record = job();
    const ops = operations();
    await createClaimEmailHandler(ops)(record, new AbortController().signal);
    expect(ops.requestMagicLink).toHaveBeenCalledWith({
      orderId: record.payload.orderId,
      email: 'guest@example.com',
      accountState: 'magic-link'
    });
    expect(ops.requestVerification).not.toHaveBeenCalled();
    expect(ops.enqueueReceiptWithoutClaim).not.toHaveBeenCalled();
  });

  it('requests credential verification before enqueueing a receipt with no claim action', async () => {
    const order: string[] = [];
    const record = job();
    const ops = operations({
      loadEligibility: vi.fn(async (orderId) => ({
        orderId,
        email: 'pending@example.com',
        accountState: 'unverified-password' as const
      })),
      requestVerification: vi.fn(async () => { order.push('verification'); }),
      enqueueReceiptWithoutClaim: vi.fn(async () => { order.push('receipt'); })
    });
    await createClaimEmailHandler(ops)(record, new AbortController().signal);
    expect(order).toEqual(['verification', 'receipt']);
    expect(ops.requestMagicLink).not.toHaveBeenCalled();
  });

  it('treats malformed or ineligible jobs as permanent without sending', async () => {
    const malformed = job();
    malformed.payload = { orderId: randomUUID(), email: 'not-allowed@example.com' };
    const malformedOps = operations();
    await expect(createClaimEmailHandler(malformedOps)(
      malformed,
      new AbortController().signal
    )).rejects.toBeInstanceOf(PermanentJobError);
    expect(malformedOps.receiptExists).not.toHaveBeenCalled();

    const ineligibleOps = operations({ loadEligibility: vi.fn(async () => null) });
    await expect(createClaimEmailHandler(ineligibleOps)(
      job(),
      new AbortController().signal
    )).rejects.toBeInstanceOf(PermanentJobError);
    expect(ineligibleOps.requestMagicLink).not.toHaveBeenCalled();
  });

  it('propagates transient auth failures and honors abort before later side effects', async () => {
    const transient = operations({
      requestMagicLink: vi.fn(async () => { throw new Error('temporary auth database failure'); })
    });
    await expect(createClaimEmailHandler(transient)(
      job(),
      new AbortController().signal
    )).rejects.toThrow('temporary auth database failure');

    const controller = new AbortController();
    const aborted = operations({
      loadEligibility: vi.fn(async (orderId) => {
        controller.abort();
        return { orderId, email: 'guest@example.com', accountState: 'magic-link' as const };
      })
    });
    await expect(createClaimEmailHandler(aborted)(job(), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted.requestMagicLink).not.toHaveBeenCalled();
  });
});
