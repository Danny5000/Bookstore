import { randomUUID } from 'node:crypto';
import { outboxMessages, type JsonObject, type OutboxMessageRow } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { enqueueJob } from '$lib/server/jobs/repository';

export const OUTBOX_DISPATCH_JOB = 'outbox.dispatch';

export interface EnqueueOutboxMessageInput {
  topic: string;
  payload: JsonObject;
  maxAttempts?: number;
}

export async function enqueueOutboxMessage(
  transaction: DatabaseTransaction,
  input: EnqueueOutboxMessageInput
): Promise<OutboxMessageRow> {
  const outboxId = randomUUID();
  const job = await enqueueJob(transaction, {
    type: OUTBOX_DISPATCH_JOB,
    payload: { outboxId },
    deduplicationKey: `outbox:${outboxId}`,
    maxAttempts: input.maxAttempts ?? 5
  });

  const [message] = await transaction
    .insert(outboxMessages)
    .values({
      id: outboxId,
      topic: input.topic,
      payload: input.payload,
      dispatchJobId: job.id
    })
    .returning();
  if (!message) throw new Error('Outbox insert returned no row');
  return message;
}
