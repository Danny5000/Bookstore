import { createHash, randomUUID } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { outboxMessages, type JsonObject, type OutboxMessageRow } from '$lib/server/db/schema';
import type { DatabaseExecutor, DatabaseTransaction } from '$lib/server/db/transaction';
import {
  OUTBOX_DISPATCH_JOB,
  OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS
} from '$lib/server/jobs/catalog';
import { enqueueJobReference } from '$lib/server/jobs/repository';

export { OUTBOX_DISPATCH_JOB } from '$lib/server/jobs/catalog';

export interface EnqueueOutboxMessageInput {
  topic: string;
  payload: JsonObject;
  deduplicationKey?: string | null;
}

export class OutboxDeduplicationInvariantError extends Error {
  constructor() {
    super('Outbox deduplication key was reused with different message contents');
    this.name = 'OutboxDeduplicationInvariantError';
  }
}

export async function outboxMessageExistsByDeduplicationKey(
  database: DatabaseExecutor,
  deduplicationKey: string
): Promise<boolean> {
  const result = await database.execute<{ exists: boolean }>(sql`
    select "public"."outbox_message_exists_by_deduplication_key"(
      ${deduplicationKey}::text
    ) as "exists"
  `);
  const exists = result.rows[0]?.exists;
  if (typeof exists !== 'boolean') throw new Error('Outbox existence check returned no result');
  return exists;
}

export interface OutboxMessageInsertValues {
  id: string;
  topic: string;
  payload: JsonObject;
  deduplicationKey: string | null;
  dispatchJobId: string;
}

const OUTBOX_SAFE_SELECTION = {
  id: outboxMessages.id,
  topic: outboxMessages.topic,
  deduplicationKey: outboxMessages.deduplicationKey,
  dispatchJobId: outboxMessages.dispatchJobId,
  status: outboxMessages.status,
  lastError: outboxMessages.lastError,
  deliveredAt: outboxMessages.deliveredAt,
  createdAt: outboxMessages.createdAt,
  updatedAt: outboxMessages.updatedAt
} as const;

export function outboxMessageInsertQuery(
  values: OutboxMessageInsertValues,
  ignoreConflicts: boolean
): SQL {
  const canonicalPayload = JSON.stringify(values.payload);
  const insert = sql`
    insert into "public"."outbox_messages" (
      "id", "topic", "payload", "deduplication_key", "dispatch_job_id"
    ) values (
      ${values.id}::uuid,
      ${values.topic}::text,
      ${canonicalPayload}::jsonb,
      ${values.deduplicationKey}::text,
      ${values.dispatchJobId}::uuid
    )
  `;
  return ignoreConflicts
    ? sql`${insert} on conflict do nothing returning "id"`
    : sql`${insert} returning "id"`;
}

async function loadSafeOutboxMetadata(
  transaction: DatabaseTransaction,
  id: string
): Promise<Omit<OutboxMessageRow, 'payload'> | undefined> {
  const [metadata] = await transaction
    .select(OUTBOX_SAFE_SELECTION)
    .from(outboxMessages)
    .where(eq(outboxMessages.id, id))
    .limit(1);
  return metadata;
}

async function loadDeduplicatedOutboxMessage(
  transaction: DatabaseTransaction,
  deduplicationKey: string,
  input: EnqueueOutboxMessageInput
): Promise<OutboxMessageRow | undefined> {
  const canonicalPayload = JSON.stringify(input.payload);
  const compatible = await transaction.execute<{ id: string }>(sql`
    select "id"
    from "public"."outbox_message_deduplication_metadata"(
      ${deduplicationKey}::text,
      ${input.topic}::text,
      ${canonicalPayload}::jsonb
    )
  `);
  const compatibleId = compatible.rows[0]?.id;
  if (compatibleId) {
    const metadata = await loadSafeOutboxMetadata(transaction, compatibleId);
    if (!metadata ||
      metadata.topic !== input.topic ||
      metadata.deduplicationKey !== deduplicationKey) {
      throw new OutboxDeduplicationInvariantError();
    }
    return {
      ...metadata,
      payload: input.payload
    };
  }

  if (await outboxMessageExistsByDeduplicationKey(transaction, deduplicationKey)) {
    throw new OutboxDeduplicationInvariantError();
  }
  return undefined;
}

export async function enqueueOutboxMessage(
  transaction: DatabaseTransaction,
  input: EnqueueOutboxMessageInput
): Promise<OutboxMessageRow> {
  const deduplicationKey = input.deduplicationKey ?? null;
  if (deduplicationKey) {
    await transaction.execute(sql`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('pale-orbit:outbox:' || ${deduplicationKey}::text, 0)
      )
    `);
    const existing = await loadDeduplicatedOutboxMessage(
      transaction,
      deduplicationKey,
      input
    );
    if (existing) return existing;
  }

  const outboxId = randomUUID();
  const dispatchDeduplicationKey = deduplicationKey
    ? `outbox-key:${createHash('sha256').update(deduplicationKey).digest('hex')}`
    : `outbox:${outboxId}`;
  const job = await enqueueJobReference(transaction, {
    type: OUTBOX_DISPATCH_JOB,
    payload: { outboxId },
    deduplicationKey: dispatchDeduplicationKey,
    maxAttempts: OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS
  });

  const values: OutboxMessageInsertValues = {
    id: outboxId,
    topic: input.topic,
    payload: input.payload,
    deduplicationKey,
    dispatchJobId: job.id
  };
  const insertedResult = await transaction.execute<{ id: string }>(
    outboxMessageInsertQuery(values, deduplicationKey !== null)
  );
  const insertedId = insertedResult.rows[0]?.id;
  if (insertedId) {
    const inserted = await loadSafeOutboxMetadata(transaction, insertedId);
    if (!inserted) throw new Error('Inserted outbox message could not be loaded');
    return { ...inserted, payload: input.payload };
  }
  if (!deduplicationKey) throw new Error('Outbox insert returned no row');

  const raced = await loadDeduplicatedOutboxMessage(transaction, deduplicationKey, input);
  if (raced) return raced;
  throw new Error('Deduplicated outbox message could not be loaded');
}
