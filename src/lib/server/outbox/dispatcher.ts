import { eq } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import { outboxMessages, type JsonObject } from '$lib/server/db/schema';
import { PermanentJobError } from '$lib/server/jobs/runner';
import type { JobHandler } from '$lib/server/jobs/types';

export type OutboxTopicHandler = (
  payload: JsonObject,
  signal: AbortSignal
) => Promise<void>;

export function createOutboxDispatchHandler(
  database: Database,
  topicHandlers: ReadonlyMap<string, OutboxTopicHandler>
): JobHandler {
  return async (job, signal) => {
    const outboxId = job.payload.outboxId;
    if (typeof outboxId !== 'string') {
      throw new PermanentJobError('Outbox job is missing outboxId');
    }

    const [message] = await database
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, outboxId))
      .limit(1);
    if (!message) throw new PermanentJobError('Outbox message does not exist');
    if (message.status === 'delivered') return;

    const handler = topicHandlers.get(message.topic);
    if (!handler) {
      await database
        .update(outboxMessages)
        .set({
          status: 'failed',
          lastError: `No handler registered for ${message.topic}`,
          updatedAt: new Date()
        })
        .where(eq(outboxMessages.id, message.id));
      throw new PermanentJobError(`No handler registered for ${message.topic}`);
    }

    try {
      await handler(message.payload, signal);
    } catch (error: unknown) {
      const safeError =
        error instanceof PermanentJobError
          ? error.safeMessage
          : 'Transient outbox handler failure';
      await database
        .update(outboxMessages)
        .set({ status: 'failed', lastError: safeError, updatedAt: new Date() })
        .where(eq(outboxMessages.id, message.id));
      throw error;
    }

    const deliveredAt = new Date();
    await database
      .update(outboxMessages)
      .set({
        status: 'delivered',
        lastError: null,
        deliveredAt,
        updatedAt: deliveredAt
      })
      .where(eq(outboxMessages.id, message.id));
  };
}
