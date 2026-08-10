import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject, OutboxMessageRow } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';

const jobMock = vi.hoisted(() => ({
  enqueue: vi.fn(),
  rows: new Map<string, { id: string }>()
}));

vi.mock('$lib/server/jobs/repository', () => ({
  enqueueJob: jobMock.enqueue
}));

import {
  enqueueOutboxMessage,
  OutboxDeduplicationInvariantError,
  type EnqueueOutboxMessageInput
} from './repository';

interface InsertValue {
  id: string;
  topic: string;
  payload: JsonObject;
  dispatchJobId: string;
  deduplicationKey?: string | null;
}

class FakeOutboxTransaction {
  readonly messages: OutboxMessageRow[] = [];
  private attempted: InsertValue | null = null;
  private selectCount = 0;

  insert(): unknown {
    return {
      values: (value: InsertValue) => {
        this.attempted = value;
        this.selectCount = 0;
        const query = {
          onConflictDoNothing: () => query,
          returning: async () => {
            const conflict = value.deduplicationKey
              ? this.messages.find(
                  (message) => message.deduplicationKey === value.deduplicationKey
                )
              : undefined;
            if (conflict) return [];

            const now = new Date('2026-08-10T12:00:00.000Z');
            const message: OutboxMessageRow = {
              ...value,
              deduplicationKey: value.deduplicationKey ?? null,
              status: 'pending',
              lastError: null,
              deliveredAt: null,
              createdAt: now,
              updatedAt: now
            };
            this.messages.push(message);
            return [message];
          }
        };
        return query;
      }
    };
  }

  select(): unknown {
    return {
      from: () => ({
        where: () => ({
          limit: async () => {
            const attempted = this.attempted;
            if (!attempted?.deduplicationKey) return [];
            const existing = this.messages.find(
              (message) => message.deduplicationKey === attempted.deduplicationKey
            );
            if (!existing) return [];

            this.selectCount += 1;
            if (this.selectCount === 1) {
              return existing.topic === attempted.topic &&
                isDeepStrictEqual(existing.payload, attempted.payload)
                ? [existing]
                : [];
            }
            return [existing];
          }
        })
      })
    };
  }
}

function stableInput(
  deduplicationKey: string,
  topic = 'commerce.receipt',
  payload: JsonObject = { orderId: 'order-1', version: 1 }
): EnqueueOutboxMessageInput & { deduplicationKey: string } {
  return { topic, payload, deduplicationKey };
}

describe('enqueueOutboxMessage stable deduplication', () => {
  beforeEach(() => {
    jobMock.rows.clear();
    jobMock.enqueue.mockReset();
    jobMock.enqueue.mockImplementation(async (_transaction, input) => {
      const key = input.deduplicationKey as string;
      const existing = jobMock.rows.get(key);
      if (existing) return existing;
      const row = { id: `job-${jobMock.rows.size + 1}` };
      jobMock.rows.set(key, row);
      return row;
    });
  });

  it('returns one logical outbox row and job for retries with the same stable key', async () => {
    const transaction = new FakeOutboxTransaction();
    const key = 'commerce:receipt:order:order-1:v1';

    const first = await enqueueOutboxMessage(
      transaction as unknown as DatabaseTransaction,
      stableInput(key, 'commerce.receipt', { orderId: 'order-1', version: 1 })
    );
    const second = await enqueueOutboxMessage(
      transaction as unknown as DatabaseTransaction,
      stableInput(key, 'commerce.receipt', { version: 1, orderId: 'order-1' })
    );

    expect(second.id).toBe(first.id);
    expect(transaction.messages).toHaveLength(1);
    expect(jobMock.rows).toHaveLength(1);
    expect(jobMock.enqueue).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        deduplicationKey: `outbox-key:${createHash('sha256').update(key).digest('hex')}`
      })
    );
  });

  it('keeps different stable keys distinct', async () => {
    const transaction = new FakeOutboxTransaction();

    const first = await enqueueOutboxMessage(
      transaction as unknown as DatabaseTransaction,
      stableInput('commerce:receipt:order:order-1:v1')
    );
    const second = await enqueueOutboxMessage(
      transaction as unknown as DatabaseTransaction,
      stableInput('commerce:receipt:order:order-2:v1', 'commerce.receipt', {
        orderId: 'order-2',
        version: 1
      })
    );

    expect(second.id).not.toBe(first.id);
    expect(transaction.messages).toHaveLength(2);
    expect(jobMock.rows).toHaveLength(2);
  });

  it('rejects reuse of a stable key for a different topic or canonical payload', async () => {
    const transaction = new FakeOutboxTransaction();
    const key = 'commerce:receipt:order:order-1:v1';
    await enqueueOutboxMessage(
      transaction as unknown as DatabaseTransaction,
      stableInput(key)
    );

    await expect(
      enqueueOutboxMessage(
        transaction as unknown as DatabaseTransaction,
        stableInput(key, 'commerce.access-changed')
      )
    ).rejects.toBeInstanceOf(OutboxDeduplicationInvariantError);
    await expect(
      enqueueOutboxMessage(
        transaction as unknown as DatabaseTransaction,
        stableInput(key, 'commerce.receipt', { orderId: 'order-2', version: 1 })
      )
    ).rejects.toBeInstanceOf(OutboxDeduplicationInvariantError);
    expect(transaction.messages).toHaveLength(1);
  });
});
