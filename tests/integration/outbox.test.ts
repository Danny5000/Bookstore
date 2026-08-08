import { count, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { jobs, outboxMessages } from '$lib/server/db/schema';
import { createOutboxDispatchHandler } from '$lib/server/outbox/dispatcher';
import { enqueueOutboxMessage } from '$lib/server/outbox/repository';
import { databaseClient } from './database';

describe('transactional outbox', () => {
  it('inserts the message and dispatch job in one transaction', async () => {
    const message = await databaseClient.db.transaction((transaction) =>
      enqueueOutboxMessage(transaction, {
        topic: 'test.email',
        payload: { recipient: 'reader@example.com' }
      })
    );

    const [jobCount] = await databaseClient.db.select({ value: count() }).from(jobs);
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

    const [messageCount] = await databaseClient.db
      .select({ value: count() })
      .from(outboxMessages);
    const [jobCount] = await databaseClient.db.select({ value: count() }).from(jobs);
    expect(messageCount?.value).toBe(0);
    expect(jobCount?.value).toBe(0);
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
      databaseClient.db,
      new Map([['test.email', deliver]])
    );
    const job = {
      id: message.dispatchJobId,
      type: 'outbox.dispatch',
      payload: { outboxId: message.id },
      attempts: 1,
      maxAttempts: 5,
      lockedBy: 'worker-test'
    };

    await handler(job, new AbortController().signal);
    await handler(job, new AbortController().signal);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [stored] = await databaseClient.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, message.id));
    expect(stored).toMatchObject({ status: 'delivered', lastError: null });
    expect(stored?.deliveredAt).toBeInstanceOf(Date);
  });
});
