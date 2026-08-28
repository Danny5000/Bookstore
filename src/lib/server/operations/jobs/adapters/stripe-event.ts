import { isProxy } from 'node:util/types';
import { sql } from 'drizzle-orm';
import {
  STRIPE_EVENT_JOB,
  STRIPE_EVENT_JOB_MAX_ATTEMPTS
} from '$lib/server/jobs/catalog';
import { rearmPendingStripeEventJob } from '$lib/server/jobs/repository';
import {
  InvalidJobRetryPolicyIdentityError,
  type JobRetryPolicyAdapter,
  type JobRetryPolicyOutcome,
  type JobRetryPolicyTarget
} from '../policies';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

const REARMED = Object.freeze({
  status: 'succeeded',
  resultCode: 'rearmed_existing'
} as const satisfies JobRetryPolicyOutcome);
const TARGET_STATE_CHANGED = Object.freeze({
  status: 'denied',
  resultCode: 'target_state_changed'
} as const satisfies JobRetryPolicyOutcome);
const DOMAIN_STATE_NOT_RETRYABLE = Object.freeze({
  status: 'denied',
  resultCode: 'domain_state_not_retryable'
} as const satisfies JobRetryPolicyOutcome);
const SOURCE_UNAVAILABLE = Object.freeze({
  status: 'denied',
  resultCode: 'source_unavailable'
} as const satisfies JobRetryPolicyOutcome);
const RETRY_COMMAND_INVALID = Object.freeze({
  status: 'failed',
  resultCode: 'retry_command_invalid'
} as const satisfies JobRetryPolicyOutcome);

interface TargetLookupRow extends Record<string, unknown> {
  readonly stripeEventId: unknown;
}

interface LockedStripeEventRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly providerEventId: unknown;
  readonly status: unknown;
  readonly processedAt: unknown;
}

interface LockedJobRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly type: unknown;
  readonly payload: unknown;
  readonly deduplicationKey: unknown;
  readonly status: unknown;
  readonly attempts: unknown;
  readonly maxAttempts: unknown;
  readonly updatedAt: unknown;
}

interface RearmedJobRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly status: unknown;
  readonly attempts: unknown;
  readonly maxAttempts: unknown;
  readonly runAt: unknown;
  readonly lockedAt: unknown;
  readonly lockedBy: unknown;
  readonly lastError: unknown;
  readonly rerunRequestedAt: unknown;
  readonly completedAt: unknown;
  readonly updatedAt: unknown;
  readonly transactionTimestamp: unknown;
}

function validTarget(target: JobRetryPolicyTarget): boolean {
  return target.expectedKind === STRIPE_EVENT_JOB &&
    target.expectedStatus === 'failed' &&
    typeof target.targetJobId === 'string' && UUID_PATTERN.test(target.targetJobId) &&
    Number.isInteger(target.expectedAttempts) && target.expectedAttempts >= 0 &&
    Number.isInteger(target.expectedMaxAttempts) && target.expectedMaxAttempts > 0 &&
    typeof target.expectedUpdatedAt === 'string' &&
    TIMESTAMP_PATTERN.test(target.expectedUpdatedAt);
}

function ownDataValue(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    if (isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exactStripeEventPayload(value: unknown, stripeEventId: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    if (isProxy(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== 'stripeEventId') return false;
    return ownDataValue(value, 'stripeEventId') === stripeEventId;
  } catch {
    return false;
  }
}

function exactSingleRow<T>(rows: readonly T[]): T | undefined {
  return rows.length === 1 ? rows[0] : undefined;
}

function impossibleIdentity(): never {
  throw new InvalidJobRetryPolicyIdentityError();
}

function submittedSnapshotChanged(
  target: JobRetryPolicyTarget,
  job: LockedJobRow
): boolean {
  return ownDataValue(job, 'type') !== target.expectedKind ||
    ownDataValue(job, 'status') !== target.expectedStatus ||
    ownDataValue(job, 'attempts') !== target.expectedAttempts ||
    ownDataValue(job, 'maxAttempts') !== target.expectedMaxAttempts ||
    ownDataValue(job, 'updatedAt') !== target.expectedUpdatedAt;
}

function rearmPostconditionHolds(
  target: JobRetryPolicyTarget,
  job: RearmedJobRow
): boolean {
  const timestamp = ownDataValue(job, 'transactionTimestamp');
  return ownDataValue(job, 'id') === target.targetJobId &&
    ownDataValue(job, 'status') === 'pending' &&
    ownDataValue(job, 'attempts') === 0 &&
    ownDataValue(job, 'maxAttempts') === STRIPE_EVENT_JOB_MAX_ATTEMPTS &&
    typeof timestamp === 'string' && TIMESTAMP_PATTERN.test(timestamp) &&
    ownDataValue(job, 'runAt') === timestamp &&
    ownDataValue(job, 'updatedAt') === timestamp &&
    ownDataValue(job, 'lockedAt') === null &&
    ownDataValue(job, 'lockedBy') === null &&
    ownDataValue(job, 'lastError') === null &&
    ownDataValue(job, 'rerunRequestedAt') === null &&
    ownDataValue(job, 'completedAt') === null;
}

export function createStripeEventJobRetryPolicyAdapter(): JobRetryPolicyAdapter {
  return async ({ transaction, target }): Promise<JobRetryPolicyOutcome> => {
    if (!validTarget(target)) return RETRY_COMMAND_INVALID;

    const lookup = await transaction.execute<TargetLookupRow>(sql`
      select queued_job.payload ->> 'stripeEventId' as "stripeEventId"
      from "public"."jobs" queued_job
      where queued_job.id = ${target.targetJobId}::uuid
      limit 1
    `);
    if (lookup.rows.length === 0) return TARGET_STATE_CHANGED;
    const lookupRow = exactSingleRow(lookup.rows);
    if (lookupRow === undefined) return RETRY_COMMAND_INVALID;
    const stripeEventId = ownDataValue(lookupRow, 'stripeEventId');
    if (typeof stripeEventId !== 'string' || !UUID_PATTERN.test(stripeEventId)) {
      return RETRY_COMMAND_INVALID;
    }

    const eventResult = await transaction.execute<LockedStripeEventRow>(sql`
      select event.id::text as "id",
        event.provider_event_id as "providerEventId",
        event.status::text as "status",
        event.processed_at as "processedAt"
      from "public"."stripe_events" event
      where event.id = ${stripeEventId}::uuid
      for update
    `);
    if (eventResult.rows.length > 1) return RETRY_COMMAND_INVALID;

    const targetResult = await transaction.execute<LockedJobRow>(sql`
      select queued_job.id::text as "id",
        queued_job.type as "type",
        queued_job.payload as "payload",
        queued_job.deduplication_key as "deduplicationKey",
        queued_job.status::text as "status",
        queued_job.attempts as "attempts",
        queued_job.max_attempts as "maxAttempts",
        pg_catalog.to_char(
          queued_job.updated_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "updatedAt"
      from "public"."jobs" queued_job
      where queued_job.id = ${target.targetJobId}::uuid
      for update
    `);
    if (targetResult.rows.length === 0) return TARGET_STATE_CHANGED;
    const job = exactSingleRow(targetResult.rows);
    if (job === undefined) return RETRY_COMMAND_INVALID;
    if (ownDataValue(job, 'id') !== target.targetJobId) return RETRY_COMMAND_INVALID;
    if (submittedSnapshotChanged(target, job)) return TARGET_STATE_CHANGED;

    const event = exactSingleRow(eventResult.rows);
    if (event === undefined) return SOURCE_UNAVAILABLE;
    if (ownDataValue(event, 'id') !== stripeEventId) return RETRY_COMMAND_INVALID;
    const providerEventId = ownDataValue(event, 'providerEventId');
    if (typeof providerEventId !== 'string' || providerEventId.length === 0) {
      return RETRY_COMMAND_INVALID;
    }

    if (
      ownDataValue(job, 'type') !== STRIPE_EVENT_JOB ||
      ownDataValue(job, 'maxAttempts') !== STRIPE_EVENT_JOB_MAX_ATTEMPTS ||
      !exactStripeEventPayload(ownDataValue(job, 'payload'), stripeEventId) ||
      ownDataValue(job, 'deduplicationKey') !== `stripe:event:${providerEventId}`
    ) return RETRY_COMMAND_INVALID;

    if (
      ownDataValue(event, 'status') !== 'pending' ||
      ownDataValue(event, 'processedAt') !== null ||
      ownDataValue(job, 'status') !== 'failed' ||
      typeof ownDataValue(job, 'attempts') !== 'number' ||
      (ownDataValue(job, 'attempts') as number) < STRIPE_EVENT_JOB_MAX_ATTEMPTS
    ) return DOMAIN_STATE_NOT_RETRYABLE;

    if (!await rearmPendingStripeEventJob(transaction, stripeEventId)) {
      return impossibleIdentity();
    }

    const postconditionResult = await transaction.execute<RearmedJobRow>(sql`
      select queued_job.id::text as "id",
        queued_job.status::text as "status",
        queued_job.attempts as "attempts",
        queued_job.max_attempts as "maxAttempts",
        pg_catalog.to_char(
          queued_job.run_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "runAt",
        queued_job.locked_at as "lockedAt",
        queued_job.locked_by as "lockedBy",
        queued_job.last_error as "lastError",
        queued_job.rerun_requested_at as "rerunRequestedAt",
        queued_job.completed_at as "completedAt",
        pg_catalog.to_char(
          queued_job.updated_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "updatedAt",
        pg_catalog.to_char(
          pg_catalog.transaction_timestamp() at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "transactionTimestamp"
      from "public"."jobs" queued_job
      where queued_job.id = ${target.targetJobId}::uuid
      limit 1
    `);
    const postcondition = exactSingleRow(postconditionResult.rows);
    if (postcondition === undefined || !rearmPostconditionHolds(target, postcondition)) {
      return impossibleIdentity();
    }
    return REARMED;
  };
}
