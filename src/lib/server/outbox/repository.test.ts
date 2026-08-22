import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject, OutboxMessageRow } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';

const jobMock = vi.hoisted(() => ({
  enqueueFull: vi.fn(),
  enqueueReference: vi.fn(),
  rows: new Map<string, { id: string }>()
}));

vi.mock('$lib/server/jobs/repository', () => ({
  enqueueJob: jobMock.enqueueFull,
  enqueueJobReference: jobMock.enqueueReference
}));

import {
  enqueueOutboxMessage,
  outboxMessageInsertQuery,
  OutboxDeduplicationInvariantError,
  type EnqueueOutboxMessageInput
} from './repository';

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
}

interface InsertValue {
  id: string;
  topic: string;
  payload: JsonObject;
  dispatchJobId: string;
  deduplicationKey?: string | null;
}

class FakeOutboxTransaction {
  readonly messages: OutboxMessageRow[] = [];
  advisoryLockCount = 0;
  safeSelectCount = 0;
  private requested: EnqueueOutboxMessageInput | null = null;
  private executeCount = 0;

  expectRequest(input: EnqueueOutboxMessageInput): void {
    this.requested = input;
    this.executeCount = 0;
  }

  async execute(query: SQL): Promise<{ rows: unknown[] }> {
    const statement = rendered(query);
    if (statement.sql.includes('pg_advisory_xact_lock')) {
      this.advisoryLockCount += 1;
      return { rows: [{}] };
    }
    if (statement.sql.includes('insert into "public"."outbox_messages"')) {
      const [id, topic, rawPayload, deduplicationKey, dispatchJobId] = statement.params;
      const value: InsertValue = {
        id: String(id),
        topic: String(topic),
        payload: JSON.parse(String(rawPayload)) as JsonObject,
        deduplicationKey: deduplicationKey === null ? null : String(deduplicationKey),
        dispatchJobId: String(dispatchJobId)
      };
      const conflict = value.deduplicationKey
        ? this.messages.find(
            (message) => message.deduplicationKey === value.deduplicationKey
          )
        : undefined;
      if (conflict) return { rows: [] };

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
      return { rows: [{ id: message.id }] };
    }
    this.executeCount += 1;
    const requested = this.requested;
    if (!requested?.deduplicationKey) return { rows: [] };
    const existing = this.messages.find(
      (message) => message.deduplicationKey === requested.deduplicationKey
    );
    if (this.executeCount % 2 === 0) return { rows: [{ exists: existing !== undefined }] };
    if (
      !existing ||
      existing.topic !== requested.topic ||
      !isDeepStrictEqual(existing.payload, requested.payload)
    ) return { rows: [] };
    return {
      rows: [{ id: existing.id }]
    };
  }

  select(): unknown {
    return {
      from: () => ({
        where: () => ({
          limit: async () => {
            this.safeSelectCount += 1;
            const requestedKey = this.requested?.deduplicationKey;
            const message = requestedKey
              ? this.messages.find((candidate) => candidate.deduplicationKey === requestedKey)
              : this.messages.at(-1);
            if (!message) return [];
            return [{
              id: message.id,
              topic: message.topic,
              deduplicationKey: message.deduplicationKey,
              dispatchJobId: message.dispatchJobId,
              status: message.status,
              lastError: message.lastError,
              deliveredAt: message.deliveredAt,
              createdAt: message.createdAt,
              updatedAt: message.updatedAt
            }];
          }
        })
      })
    };
  }
}

async function enqueue(
  transaction: FakeOutboxTransaction,
  input: EnqueueOutboxMessageInput
): Promise<OutboxMessageRow> {
  transaction.expectRequest(input);
  return enqueueOutboxMessage(transaction as unknown as DatabaseTransaction, input);
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
    jobMock.enqueueFull.mockReset();
    jobMock.enqueueReference.mockReset();
    jobMock.enqueueReference.mockImplementation(async (_transaction, input) => {
      const key = input.deduplicationKey as string;
      const existing = jobMock.rows.get(key);
      if (existing) return existing;
      const row = { id: `job-${jobMock.rows.size + 1}` };
      jobMock.rows.set(key, row);
      return row;
    });
  });

  it('targets only the five runtime-granted outbox insert columns', () => {
    const query = rendered(outboxMessageInsertQuery({
      id: '00000000-0000-4000-8000-000000000001',
      topic: 'commerce.receipt',
      payload: { orderId: '00000000-0000-4000-8000-000000000002' },
      deduplicationKey: 'commerce:receipt:test:v1',
      dispatchJobId: '00000000-0000-4000-8000-000000000003'
    }, true));
    const normalized = query.sql.replace(/\s+/gu, ' ').trim();
    expect(normalized).toMatch(
      /^insert into "public"\."outbox_messages" \(\s*"id", "topic", "payload", "deduplication_key", "dispatch_job_id"\s*\) values /u
    );
    expect(normalized).toContain('on conflict do nothing returning');
    expect(normalized).toMatch(/returning "id"$/u);
    expect(normalized.slice(0, normalized.indexOf(' values '))).not.toMatch(
      /"(?:status|last_error|delivered_at|created_at|updated_at)"/u
    );
  });

  it('returns one logical outbox row and job for retries with the same stable key', async () => {
    const transaction = new FakeOutboxTransaction();
    const key = 'commerce:receipt:order:order-1:v1';

    const first = await enqueue(
      transaction,
      stableInput(key, 'commerce.receipt', { orderId: 'order-1', version: 1 })
    );
    const second = await enqueue(
      transaction,
      stableInput(key, 'commerce.receipt', { version: 1, orderId: 'order-1' })
    );

    expect(second.id).toBe(first.id);
    expect(first.createdAt).toBeInstanceOf(Date);
    expect(second.createdAt).toBeInstanceOf(Date);
    expect(transaction.messages).toHaveLength(1);
    expect(transaction.safeSelectCount).toBe(2);
    expect(jobMock.rows).toHaveLength(1);
    expect(jobMock.enqueueReference).toHaveBeenCalledTimes(1);
    expect(jobMock.enqueueFull).not.toHaveBeenCalled();
    expect(transaction.advisoryLockCount).toBe(2);
    expect(jobMock.enqueueReference).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        deduplicationKey: `outbox-key:${createHash('sha256').update(key).digest('hex')}`,
        maxAttempts: 8
      })
    );
  });

  it('keeps different stable keys distinct', async () => {
    const transaction = new FakeOutboxTransaction();

    const first = await enqueue(
      transaction,
      stableInput('commerce:receipt:order:order-1:v1')
    );
    const second = await enqueue(
      transaction,
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
    await enqueue(
      transaction,
      stableInput(key)
    );

    await expect(
      enqueue(
        transaction,
        stableInput(key, 'commerce.access-changed')
      )
    ).rejects.toBeInstanceOf(OutboxDeduplicationInvariantError);
    await expect(
      enqueue(
        transaction,
        stableInput(key, 'commerce.receipt', { orderId: 'order-2', version: 1 })
      )
    ).rejects.toBeInstanceOf(OutboxDeduplicationInvariantError);
    expect(transaction.messages).toHaveLength(1);
  });
});
