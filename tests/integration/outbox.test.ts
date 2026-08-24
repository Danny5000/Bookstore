import { createHash, randomUUID } from 'node:crypto';
import { count, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { jobs, outboxMessages } from '$lib/server/db/schema';
import { createOutboxDispatchHandler } from '$lib/server/outbox/dispatcher';
import {
  enqueueOutboxMessage,
  OutboxDeduplicationInvariantError
} from '$lib/server/outbox/repository';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient
} from './database';

async function waitForBlockedSession(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await ownerDatabaseClient.db.execute<{ blocked: boolean }>(sql`
      select exists (
        select 1
        from pg_catalog.pg_stat_activity activity
        where activity.application_name = ${applicationName}
          and activity.wait_event_type = 'Lock'
      ) as "blocked"
    `);
    if (result.rows[0]?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Concurrent outbox retry did not reach a database lock');
}

describe('transactional outbox', () => {
  it('inserts the message and dispatch job in one transaction', async () => {
    const message = await databaseClient.db.transaction((transaction) =>
      enqueueOutboxMessage(transaction, {
        topic: 'test.email',
        payload: { recipient: 'reader@example.com' }
      })
    );

    const [jobCount] = await workerDatabaseClient.db.select({ value: count() }).from(jobs);
    expect(jobCount?.value).toBe(1);
    expect(message.dispatchJobId).toBeDefined();
  });

  it('rolls back both records with the caller transaction', async () => {
    await expect(
      databaseClient.db.transaction(async (transaction) => {
        await enqueueOutboxMessage(transaction, {
          topic: 'test.email',
          payload: { recipient: 'reader@example.com' }
        });
        throw new Error('rollback outbox');
      })
    ).rejects.toThrow('rollback outbox');

    const [messageCount] = await ownerDatabaseClient.db
      .select({ value: count() })
      .from(outboxMessages);
    const [jobCount] = await workerDatabaseClient.db.select({ value: count() }).from(jobs);
    expect(messageCount?.value).toBe(0);
    expect(jobCount?.value).toBe(0);
  });

  it('deduplicates stable retries by canonical JSONB value and rejects conflicting reuse', async () => {
    const deduplicationKey = 'commerce:receipt:order:order-1:v1';
    const first = await databaseClient.db.transaction((transaction) =>
      enqueueOutboxMessage(transaction, {
        topic: 'commerce.receipt',
        payload: { orderId: 'order-1', version: 1 },
        deduplicationKey
      })
    );
    const second = await databaseClient.db.transaction((transaction) =>
      enqueueOutboxMessage(transaction, {
        topic: 'commerce.receipt',
        payload: { version: 1, orderId: 'order-1' },
        deduplicationKey
      })
    );

    expect(second.id).toBe(first.id);
    const [messageCount] = await ownerDatabaseClient.db
      .select({ value: count() })
      .from(outboxMessages);
    const [jobCount] = await workerDatabaseClient.db.select({ value: count() }).from(jobs);
    expect(messageCount?.value).toBe(1);
    expect(jobCount?.value).toBe(1);

    await expect(
      databaseClient.db.transaction((transaction) =>
        enqueueOutboxMessage(transaction, {
          topic: 'commerce.receipt',
          payload: { orderId: 'order-2', version: 1 },
          deduplicationKey
        })
      )
    ).rejects.toBeInstanceOf(OutboxDeduplicationInvariantError);
  });

  it('serializes two web sessions before allocating a stable-key outbox job', async () => {
    const role = await databaseClient.db.execute<{ currentUser: string }>(sql`
      select current_user as "currentUser"
    `);
    expect(role.rows[0]?.currentUser).toBe(applicationConfig.database.user);

    const applicationName = `outbox-concurrent-${randomUUID()}`;
    const deduplicationKey = `commerce:receipt:concurrent:${randomUUID()}:v1`;
    const input = {
      topic: 'commerce.receipt',
      payload: { orderId: randomUUID(), version: 1 },
      deduplicationKey
    };
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let publishFirst!: (message: Awaited<ReturnType<typeof enqueueOutboxMessage>>) => void;
    const firstPublished = new Promise<Awaited<ReturnType<typeof enqueueOutboxMessage>>>(
      (resolve) => {
        publishFirst = resolve;
      }
    );

    const first = databaseClient.db.transaction(async (transaction) => {
      const message = await enqueueOutboxMessage(transaction, input);
      publishFirst(message);
      await firstRelease;
      return message;
    });
    void first.catch(() => undefined);
    const canonical = await Promise.race([
      firstPublished,
      first.then(() => {
        throw new Error('First outbox transaction completed before publishing its message');
      })
    ]);
    let secondStarted!: () => void;
    const secondStart = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const second = databaseClient.db.transaction(async (transaction) => {
      await transaction.execute(sql`
        select pg_catalog.set_config('application_name', ${applicationName}, true)
      `);
      secondStarted();
      return enqueueOutboxMessage(transaction, input);
    });
    void second.catch(() => undefined);
    const secondCompletedEarly = second.then(() => {
      throw new Error('Second outbox transaction completed before the first was released');
    });

    let released = false;
    try {
      await Promise.race([secondStart, secondCompletedEarly]);
      await Promise.race([waitForBlockedSession(applicationName), secondCompletedEarly]);
      releaseFirst();
      released = true;
      const [firstMessage, secondMessage] = await Promise.all([first, second]);
      expect(firstMessage.id).toBe(canonical.id);
      expect(secondMessage.id).toBe(canonical.id);
    } finally {
      if (!released) releaseFirst();
      await Promise.allSettled([first, second]);
    }

    const dispatchKey = `outbox-key:${createHash('sha256')
      .update(deduplicationKey)
      .digest('hex')}`;
    const [storedJob] = await workerDatabaseClient.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.deduplicationKey, dispatchKey));
    expect(storedJob?.payload).toEqual({ outboxId: canonical.id });
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(1);
    expect(await workerDatabaseClient.db.select().from(jobs)).toHaveLength(1);
  });

  it('keeps different stable outbox keys distinct', async () => {
    const first = await databaseClient.db.transaction((transaction) =>
      enqueueOutboxMessage(transaction, {
        topic: 'commerce.receipt',
        payload: { orderId: 'order-1' },
        deduplicationKey: 'commerce:receipt:order:order-1:v1'
      })
    );
    const second = await databaseClient.db.transaction((transaction) =>
      enqueueOutboxMessage(transaction, {
        topic: 'commerce.receipt',
        payload: { orderId: 'order-2' },
        deduplicationKey: 'commerce:receipt:order:order-2:v1'
      })
    );

    expect(second.id).not.toBe(first.id);
  });

  it('dispatches once and treats an already-delivered message as idempotent', async () => {
    const message = await databaseClient.db.transaction((transaction) =>
      enqueueOutboxMessage(transaction, {
        topic: 'test.email',
        payload: { recipient: 'reader@example.com' }
      })
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const handler = createOutboxDispatchHandler(
      workerDatabaseClient.db,
      new Map([['test.email', deliver]])
    );
    const job = {
      id: message.dispatchJobId,
      type: 'outbox.dispatch',
      payload: { outboxId: message.id },
      deduplicationKey: null,
      attempts: 1,
      maxAttempts: 8,
      lockedBy: 'worker-test'
    };

    await handler(job, new AbortController().signal);
    await handler(job, new AbortController().signal);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [stored] = await ownerDatabaseClient.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, message.id));
    expect(stored).toMatchObject({ status: 'delivered', lastError: null });
    expect(stored?.deliveredAt).toBeInstanceOf(Date);
  });
});
