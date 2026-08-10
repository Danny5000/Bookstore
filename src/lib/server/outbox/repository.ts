import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { outboxMessages, type JsonObject, type OutboxMessageRow } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { enqueueJob } from '$lib/server/jobs/repository';

export const OUTBOX_DISPATCH_JOB = 'outbox.dispatch';

export interface EnqueueOutboxMessageInput {
  topic: string;
  payload: JsonObject;
  deduplicationKey?: string | null;
  maxAttempts?: number;
}

export class OutboxDeduplicationInvariantError extends Error {
  constructor() {
    super('Outbox deduplication key was reused with different message contents');
    this.name = 'OutboxDeduplicationInvariantError';
  }
}

export async function enqueueOutboxMessage(
  transaction: DatabaseTransaction,
  input: EnqueueOutboxMessageInput
): Promise<OutboxMessageRow> {
  const outboxId = randomUUID();
  const deduplicationKey = input.deduplicationKey ?? null;
  const dispatchDeduplicationKey = deduplicationKey
    ? `outbox-key:${createHash('sha256').update(deduplicationKey).digest('hex')}`
    : `outbox:${outboxId}`;
  const job = await enqueueJob(transaction, {
    type: OUTBOX_DISPATCH_JOB,
    payload: { outboxId },
    deduplicationKey: dispatchDeduplicationKey,
    maxAttempts: input.maxAttempts ?? 5
  });

  const values = {
    id: outboxId,
    topic: input.topic,
    payload: input.payload,
    deduplicationKey,
    dispatchJobId: job.id
  };
  const [inserted] = deduplicationKey
    ? await transaction
        .insert(outboxMessages)
        .values(values)
        .onConflictDoNothing()
        .returning()
    : await transaction.insert(outboxMessages).values(values).returning();
  if (inserted) return inserted;
  if (!deduplicationKey) throw new Error('Outbox insert returned no row');

  const canonicalPayload = JSON.stringify(input.payload);
  const [compatible] = await transaction
    .select()
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.deduplicationKey, deduplicationKey),
        eq(outboxMessages.topic, input.topic),
        sql`${outboxMessages.payload} = ${canonicalPayload}::jsonb`
      )
    )
    .limit(1);
  if (compatible) return compatible;

  const [existing] = await transaction
    .select({ id: outboxMessages.id })
    .from(outboxMessages)
    .where(eq(outboxMessages.deduplicationKey, deduplicationKey))
    .limit(1);
  if (existing) throw new OutboxDeduplicationInvariantError();
  throw new Error('Deduplicated outbox message could not be loaded');
}
