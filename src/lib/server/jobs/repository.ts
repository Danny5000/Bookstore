import { randomBytes } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { JobConfig } from '$lib/server/config/schema';
import type { Database } from '$lib/server/db/client';
import { jobs, type JsonObject, type JsonValue, type JobRow } from '$lib/server/db/schema';
import type { DatabaseExecutor, DatabaseTransaction } from '$lib/server/db/transaction';
import { withTransaction } from '$lib/server/db/transaction';
import {
  FINANCIAL_CLASSIFICATION_JOB,
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_SCAN_JOB,
  FINANCIAL_SOURCE_JOB,
  parseFinancialJobIdentity,
  type FinancialClassificationJobSpec,
  type FinancialJobIdentity
} from '$lib/server/commerce/financial/jobs';
import {
  FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  FINANCIAL_CLASSIFIER_VERSION
} from '$lib/server/commerce/financial/constants';
import { STRIPE_EVENT_JOB } from '$lib/server/commerce/job';
import { computeRetryDelayMs } from './backoff';
import type { JobRecord, JobRepository } from './types';

export interface EnqueueJobInput {
  type: string;
  payload: JsonObject;
  deduplicationKey?: string | null;
  runAt?: Date;
  maxAttempts?: number;
}

export interface EnqueuedJobReference {
  readonly id: string;
}

export type EnqueueActiveEntityJobInput =
  | (EnqueueJobInput & {
      readonly type: 'commerce.financial-source';
      readonly deduplicationKey: string;
      readonly maxAttempts: number;
      readonly activeEntity: {
        readonly sourceKind: 'payment' | 'refund' | 'dispute';
        readonly sourceId: string;
      };
    })
  | (EnqueueJobInput & {
      readonly type: 'commerce.financial-payout';
      readonly deduplicationKey: string;
      readonly maxAttempts: number;
      readonly activeEntity: { readonly providerPayoutId: string };
    });

const ACTIVE_JOB_COLUMNS = sql`
  id, type, payload, deduplication_key as "deduplicationKey", status,
  run_at as "runAt", attempts, max_attempts as "maxAttempts",
  locked_at as "lockedAt", locked_by as "lockedBy", last_error as "lastError",
  rerun_requested_at as "rerunRequestedAt",
  completed_at as "completedAt", created_at as "createdAt", updated_at as "updatedAt"
`;

type QueryResult = { rows?: unknown[] };
type ActiveFinancialJobIdentity = Extract<
  FinancialJobIdentity,
  { readonly type: typeof FINANCIAL_SOURCE_JOB | typeof FINANCIAL_PAYOUT_JOB }
>;

interface ValidatedActiveJob {
  readonly identity: ActiveFinancialJobIdentity;
  readonly subset: JsonObject;
  readonly runAt?: Date;
}

function invalidActiveEntityJob(): never {
  throw new Error('Invalid active entity job input');
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length ||
    !actual.every((key) => typeof key === 'string' && keys.includes(key)) ||
    !keys.every((key) => Object.hasOwn(value, key))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => descriptors[key] !== undefined &&
    Object.hasOwn(descriptors[key]!, 'value'));
}

function codePointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalObject(value: Record<string, string>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => codePointOrder(left, right))
  );
}

function canonicalJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidActiveEntityJob();
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!exactObject(value, Reflect.ownKeys(value).map(String))) invalidActiveEntityJob();
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => codePointOrder(left, right))
      .map(([key, item]) => [key, canonicalJsonValue(item)])
  );
}

function parseActiveIdentity(value: {
  readonly type: unknown;
  readonly payload: unknown;
  readonly deduplicationKey: unknown;
  readonly maxAttempts: unknown;
}): ActiveFinancialJobIdentity {
  try {
    const identity = parseFinancialJobIdentity(value);
    if (identity.type !== FINANCIAL_SOURCE_JOB && identity.type !== FINANCIAL_PAYOUT_JOB) {
      return invalidActiveEntityJob();
    }
    return identity;
  } catch {
    return invalidActiveEntityJob();
  }
}

function sameJobIdentity(row: JobRow, identity: ActiveFinancialJobIdentity): boolean {
  const existing = parseActiveIdentity({
    type: row.type,
    payload: row.payload,
    deduplicationKey: row.deduplicationKey,
    maxAttempts: row.maxAttempts
  });
  return JSON.stringify(existing) === JSON.stringify(identity);
}

function sameActiveEntity(
  row: JobRow,
  expected: ActiveFinancialJobIdentity
): boolean {
  const existing = parseActiveIdentity({
    type: row.type,
    payload: row.payload,
    deduplicationKey: row.deduplicationKey,
    maxAttempts: row.maxAttempts
  });
  if (existing.type !== expected.type) return false;
  if (existing.type === FINANCIAL_SOURCE_JOB && expected.type === FINANCIAL_SOURCE_JOB) {
    return existing.payload.sourceKind === expected.payload.sourceKind &&
      existing.payload.sourceId === expected.payload.sourceId;
  }
  if (existing.type === FINANCIAL_PAYOUT_JOB && expected.type === FINANCIAL_PAYOUT_JOB) {
    return existing.payload.providerPayoutId === expected.payload.providerPayoutId;
  }
  return false;
}

function validateActiveJobInput(input: EnqueueActiveEntityJobInput): ValidatedActiveJob {
  try {
    const hasRunAt = Object.hasOwn(input, 'runAt');
    const expectedKeys = hasRunAt
      ? ['type', 'payload', 'deduplicationKey', 'runAt', 'maxAttempts', 'activeEntity']
      : ['type', 'payload', 'deduplicationKey', 'maxAttempts', 'activeEntity'];
    if (!exactObject(input, expectedKeys)) return invalidActiveEntityJob();
    if (hasRunAt && (!(input.runAt instanceof Date) || !Number.isFinite(input.runAt.getTime()))) {
      return invalidActiveEntityJob();
    }
    canonicalJsonValue(input.payload);
    const identity = parseActiveIdentity({
      type: input.type,
      payload: input.payload,
      deduplicationKey: input.deduplicationKey,
      maxAttempts: input.maxAttempts
    });
    if (identity.type === FINANCIAL_SOURCE_JOB) {
      const entity: unknown = input.activeEntity;
      if (!exactObject(entity, ['sourceKind', 'sourceId']) ||
        entity.sourceKind !== identity.payload.sourceKind ||
        entity.sourceId !== identity.payload.sourceId) {
        return invalidActiveEntityJob();
      }
      return {
        identity,
        subset: canonicalObject({
          sourceKind: identity.payload.sourceKind,
          sourceId: identity.payload.sourceId
        }),
        ...(hasRunAt ? { runAt: input.runAt } : {})
      };
    }
    const entity: unknown = input.activeEntity;
    if (identity.payload.trigger.kind === 'continuation') invalidActiveEntityJob();
    if (!exactObject(entity, ['providerPayoutId']) ||
      entity.providerPayoutId !== identity.payload.providerPayoutId) {
      return invalidActiveEntityJob();
    }
    return {
      identity,
      subset: canonicalObject({ providerPayoutId: identity.payload.providerPayoutId }),
      ...(hasRunAt ? { runAt: input.runAt } : {})
    };
  } catch {
    return invalidActiveEntityJob();
  }
}

function assertTransaction(transaction: DatabaseTransaction): void {
  try {
    if (typeof (transaction as unknown as { rollback?: unknown }).rollback !== 'function') {
      invalidActiveEntityJob();
    }
  } catch {
    invalidActiveEntityJob();
  }
}

async function executeJobRows(
  transaction: DatabaseTransaction,
  query: SQL
): Promise<JobRow[]> {
  const result = await transaction.execute(query) as QueryResult;
  return (result.rows ?? []) as JobRow[];
}

export async function enqueueActiveEntityJob(
  transaction: DatabaseTransaction,
  input: EnqueueActiveEntityJobInput
): Promise<JobRow> {
  const validated = validateActiveJobInput(input);
  assertTransaction(transaction);
  const canonicalSubset = JSON.stringify(validated.subset);
  const advisoryKey =
    `pale-orbit:jobs:active-entity:${validated.identity.type}:${canonicalSubset}`;
  await transaction.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${advisoryKey}, 0))
  `);

  const exact = await executeJobRows(transaction, sql`
    select ${ACTIVE_JOB_COLUMNS} from jobs
    where deduplication_key = ${validated.identity.deduplicationKey}
    limit 1 for update
  `);
  if (exact[0]) {
    if (!sameJobIdentity(exact[0], validated.identity)) invalidActiveEntityJob();
    return exact[0];
  }

  const active = await executeJobRows(transaction, sql`
    select ${ACTIVE_JOB_COLUMNS} from jobs
    where type = ${validated.identity.type}
      and status in ('pending', 'running')
      and payload @> ${canonicalSubset}::jsonb
      and (
        type <> ${FINANCIAL_PAYOUT_JOB}
        or payload -> 'trigger' ->> 'kind' is distinct from 'continuation'
      )
    order by created_at, id
    limit 1 for update
  `);
  if (active[0]) {
    if (!sameActiveEntity(active[0], validated.identity)) invalidActiveEntityJob();
    if (active[0].status === 'running') {
      const marked = await executeJobRows(transaction, sql`
        update jobs set rerun_requested_at = coalesce(rerun_requested_at, now()),
          updated_at = now()
        where id = ${active[0].id} and status = 'running'
        returning ${ACTIVE_JOB_COLUMNS}
      `);
      if (!marked[0] || !sameActiveEntity(marked[0], validated.identity)) {
        invalidActiveEntityJob();
      }
      return marked[0];
    }
    return active[0];
  }

  const enqueueInput: EnqueueJobInput = {
    type: validated.identity.type,
    payload: validated.identity.payload,
    deduplicationKey: validated.identity.deduplicationKey,
    maxAttempts: validated.identity.maxAttempts
  };
  if (validated.runAt !== undefined) enqueueInput.runAt = validated.runAt;
  const queued = await enqueueJob(transaction, enqueueInput);
  if (!sameJobIdentity(queued, validated.identity)) invalidActiveEntityJob();
  return queued;
}

export async function enqueueJob(
  database: DatabaseExecutor,
  input: EnqueueJobInput
): Promise<JobRow> {
  const insertedResult = await database.execute<{ id: string }>(
    jobInsertQuery(input)
  );
  const insertedId = insertedResult.rows[0]?.id;

  if (insertedId) {
    const [inserted] = await database
      .select()
      .from(jobs)
      .where(eq(jobs.id, insertedId))
      .limit(1);
    if (!inserted) throw new Error('Inserted job could not be loaded');
    return inserted;
  }
  if (!input.deduplicationKey) throw new Error('Job insert returned no row');

  const [existing] = await database
    .select()
    .from(jobs)
    .where(eq(jobs.deduplicationKey, input.deduplicationKey))
    .limit(1);
  if (!existing) throw new Error('Deduplicated job could not be loaded');
  return existing;
}

export async function enqueueJobReference(
  database: DatabaseExecutor,
  input: EnqueueJobInput
): Promise<EnqueuedJobReference> {
  const result = await database.execute<{ id: string }>(
    jobReferenceInsertQuery(input)
  );
  const row = result.rows[0];
  if (!row) {
    if (!input.deduplicationKey) throw new Error('Job reference could not be recovered');
    const [replayed] = await database
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.deduplicationKey, input.deduplicationKey))
      .limit(1);
    if (!replayed) throw new Error('Job reference could not be recovered');
    return replayed;
  }
  return { id: row.id };
}

export function jobInsertQuery(input: EnqueueJobInput): SQL {
  const canonicalPayload = JSON.stringify(input.payload);
  return sql`
    insert into "public"."jobs" (
      "type", "payload", "deduplication_key", "run_at", "max_attempts"
    ) values (
      ${input.type}::text,
      ${canonicalPayload}::jsonb,
      ${input.deduplicationKey ?? null}::text,
      coalesce(${input.runAt ?? null}::timestamptz, pg_catalog.now()),
      ${input.maxAttempts ?? 5}::integer
    )
    on conflict ("deduplication_key") do nothing
    returning "id"
  `;
}

export function jobReferenceInsertQuery(input: EnqueueJobInput): SQL {
  const canonicalPayload = JSON.stringify(input.payload);
  return sql`
    with inserted as (
      insert into "public"."jobs" (
        "type", "payload", "deduplication_key", "run_at", "max_attempts"
      ) values (
        ${input.type}::text,
        ${canonicalPayload}::jsonb,
        ${input.deduplicationKey ?? null}::text,
        coalesce(${input.runAt ?? null}::timestamptz, pg_catalog.now()),
        ${input.maxAttempts ?? 5}::integer
      )
      on conflict ("deduplication_key") do nothing
      returning "id"
    )
    select "id" from inserted
    union all
    select "id"
    from "public"."jobs"
    where "deduplication_key" = ${input.deduplicationKey ?? null}::text
      and not exists (select 1 from inserted)
    limit 1
  `;
}

function sameClassificationSubject(
  left: Extract<FinancialJobIdentity, { readonly type: typeof FINANCIAL_CLASSIFICATION_JOB }>,
  right: Extract<FinancialJobIdentity, { readonly type: typeof FINANCIAL_CLASSIFICATION_JOB }>
): boolean {
  return left.deduplicationKey === right.deduplicationKey &&
    left.maxAttempts === right.maxAttempts &&
    left.payload.subjectType === right.payload.subjectType &&
    left.payload.subjectId === right.payload.subjectId &&
    left.payload.sourceFingerprintSha256 === right.payload.sourceFingerprintSha256 &&
    left.payload.classifierVersion === right.payload.classifierVersion &&
    left.payload.allocationAlgorithmVersion === right.payload.allocationAlgorithmVersion &&
    left.payload.replayId === right.payload.replayId;
}

/**
 * A permanent subject identity can predate its composite replay or a graph publication that
 * changes its projection. Preserve its permanent key while linking it to the run and, when the
 * caller publishes new graph evidence, durably rearm terminal/running work.
 */
async function enqueueFinancialClassificationJobInternal(
  transaction: DatabaseTransaction,
  input: FinancialClassificationJobSpec,
  rearmExisting: boolean
): Promise<JobRow> {
  assertTransaction(transaction);
  const expected = parseFinancialJobIdentity(input);
  if (expected.type !== FINANCIAL_CLASSIFICATION_JOB) {
    throw new Error('Invalid financial classification job');
  }
  await enqueueJob(transaction, {
    type: expected.type, payload: expected.payload as JsonObject,
    deduplicationKey: expected.deduplicationKey, maxAttempts: expected.maxAttempts
  });
  const locked = await executeJobRows(transaction, sql`
    select ${ACTIVE_JOB_COLUMNS} from jobs
    where deduplication_key = ${expected.deduplicationKey}
    limit 1 for update
  `);
  const row = locked[0];
  if (!row) throw new Error('Financial classification job could not be loaded');
  const existing = parseFinancialJobIdentity({
    type: row.type, payload: row.payload, deduplicationKey: row.deduplicationKey,
    maxAttempts: row.maxAttempts
  });
  if (existing.type !== FINANCIAL_CLASSIFICATION_JOB ||
    !sameClassificationSubject(existing, expected)) {
    throw new Error('Financial classification job identity mismatch');
  }
  const needsAdoption = expected.payload.scanRunId !== undefined &&
    existing.payload.scanRunId === undefined;
  if (expected.payload.scanRunId !== undefined &&
    existing.payload.scanRunId !== undefined &&
    existing.payload.scanRunId !== expected.payload.scanRunId) {
    throw new Error('Financial classification job replay mismatch');
  }
  if (!needsAdoption && !rearmExisting) return row;
  const payload = needsAdoption ? expected.payload : existing.payload;
  const rearmTerminal = rearmExisting;
  const markRunningForRerun = needsAdoption || rearmExisting;
  const adopted = await executeJobRows(transaction, sql`
    update jobs set
      payload = ${payload as JsonObject}::jsonb,
      status = case
        when ${rearmTerminal} and status in ('succeeded', 'failed') then 'pending'::job_status
        else status
      end,
      run_at = case
        when (${rearmTerminal} and status in ('succeeded', 'failed'))
          or (${rearmExisting} and status = 'pending') then now()
        else run_at
      end,
      attempts = case
        when ${rearmExisting} and status in ('pending', 'succeeded', 'failed') then 0
        else attempts
      end,
      locked_at = case
        when ${rearmTerminal} and status in ('succeeded', 'failed') then null
        else locked_at
      end,
      locked_by = case
        when ${rearmTerminal} and status in ('succeeded', 'failed') then null
        else locked_by
      end,
      last_error = case
        when ${rearmExisting} and status in ('pending', 'succeeded', 'failed') then null
        else last_error
      end,
      rerun_requested_at = case
        when ${markRunningForRerun} and status = 'running'
          then coalesce(rerun_requested_at, now())
        else rerun_requested_at
      end,
      completed_at = case
        when ${rearmTerminal} and status in ('succeeded', 'failed') then null
        else completed_at
      end,
      updated_at = now()
    where id = ${row.id}
    returning ${ACTIVE_JOB_COLUMNS}
  `);
  if (adopted.length !== 1) throw new Error('Financial classification job adoption failed');
  return adopted[0]!;
}

export async function enqueueFinancialClassificationJob(
  transaction: DatabaseTransaction,
  input: FinancialClassificationJobSpec
): Promise<JobRow> {
  return enqueueFinancialClassificationJobInternal(transaction, input, false);
}

export async function rearmFinancialClassificationJob(
  transaction: DatabaseTransaction,
  input: FinancialClassificationJobSpec
): Promise<JobRow> {
  return enqueueFinancialClassificationJobInternal(transaction, input, true);
}

export type JobClaimPolicy = 'all' | 'local-only';

export interface FinancialClassificationImplementationVersion {
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
}

export async function rearmPendingStripeEventJob(
  database: DatabaseExecutor,
  stripeEventId: string
): Promise<boolean> {
  const result = await database.execute<{ rearmed: boolean }>(sql`
    select "public"."rearm_pending_stripe_event_job"(${stripeEventId}::uuid) as "rearmed"
  `);
  const rearmed = result.rows[0]?.rearmed;
  if (typeof rearmed !== 'boolean') throw new Error('Stripe event job rearm returned no result');
  return rearmed;
}

interface ClaimedJobRow extends Record<string, unknown> {
  id: string;
  type: string;
  payload: JsonObject;
  deduplicationKey: string | null;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
}

interface LockedClaimCandidate extends ClaimedJobRow {
  status: JobRow['status'];
  runAt: Date;
  lockedAt: Date | null;
  lastError: string | null;
  rerunRequestedAt: Date | null;
  priorStatus: 'pending' | 'running';
  hadRerunRequest: boolean;
}

interface LockedOwnedJob extends ClaimedJobRow {
  status: 'running';
  runAt: Date;
  lockedAt: Date;
  lastError: string | null;
  rerunRequestedAt: Date | null;
}

type FinancialAdminCapabilitySource = () => string;

const FINANCIAL_ADMIN_COMMAND_JOB = 'commerce.financial-admin-command';
const FINANCIAL_ADMIN_LEASE_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FINANCIAL_ADMIN_LEASE_LOCK_PREFIX =
  'pale-orbit:plan6bii-financial-admin-job-lease:';

async function queryRows<T>(
  transaction: DatabaseTransaction,
  query: SQL
): Promise<T[]> {
  const result = await transaction.execute(query) as QueryResult;
  return (result.rows ?? []) as T[];
}

function createFinancialAdminLeaseCapability(
  source: FinancialAdminCapabilitySource
): string {
  const capability = source();
  if (!FINANCIAL_ADMIN_LEASE_CAPABILITY_PATTERN.test(capability)) {
    throw new Error('Financial administrator job lease capability generation failed');
  }
  return capability;
}

async function setFinancialAdminLeaseContext(
  transaction: DatabaseTransaction,
  capability: string,
  leaseDurationMs?: number
): Promise<void> {
  if (leaseDurationMs === undefined) {
    await transaction.execute(sql`
      select pg_catalog.set_config(
        'pale_orbit.plan6bii_financial_admin_job_capability',
        ${capability},
        true
      )
    `);
    return;
  }
  await transaction.execute(sql`
    select
      pg_catalog.set_config(
        'pale_orbit.plan6bii_financial_admin_job_capability',
        ${capability},
        true
      ),
      pg_catalog.set_config(
        'pale_orbit.plan6bii_financial_admin_job_lease_duration_ms',
        ${String(leaseDurationMs)},
        true
      )
  `);
}

async function lockFinancialAdminLease(
  transaction: DatabaseTransaction,
  jobId: string,
  mode: 'shared' | 'exclusive'
): Promise<void> {
  if (mode === 'shared') {
    await transaction.execute(sql`
      select pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended(
          '${sql.raw(FINANCIAL_ADMIN_LEASE_LOCK_PREFIX)}' || ${jobId}::text,
          0
        )
      )
    `);
    return;
  }
  await transaction.execute(sql`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        '${sql.raw(FINANCIAL_ADMIN_LEASE_LOCK_PREFIX)}' || ${jobId}::text,
        0
      )
    )
  `);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = Reflect.get(error, 'code');
  if (typeof direct === 'string') return direct;
  return errorCode(Reflect.get(error, 'cause'));
}

function financialAdminAuthorityFailure(): Error {
  return new Error('Financial administrator job lease authority failed');
}

export function createPostgresJobRepository(
  database: Database,
  config: JobConfig,
  now: () => Date = () => new Date(),
  claimPolicy: JobClaimPolicy = 'all',
  classificationImplementation: FinancialClassificationImplementationVersion = {
    classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
    allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
  },
  financialAdminCapabilitySource: FinancialAdminCapabilitySource = () =>
    randomBytes(32).toString('base64url')
): JobRepository {
  if (claimPolicy !== 'all' && claimPolicy !== 'local-only') {
    throw new Error('Invalid job claim policy');
  }
  if (!classificationImplementation || typeof classificationImplementation !== 'object' ||
    Reflect.ownKeys(classificationImplementation).length !== 2 ||
    !Number.isSafeInteger(classificationImplementation.classifierVersion) ||
    classificationImplementation.classifierVersion < 1 ||
    classificationImplementation.classifierVersion > 2_147_483_647 ||
    !Number.isSafeInteger(classificationImplementation.allocationAlgorithmVersion) ||
    classificationImplementation.allocationAlgorithmVersion < 1 ||
    classificationImplementation.allocationAlgorithmVersion > 2_147_483_647) {
    throw new Error('Invalid financial classification implementation version');
  }
  if (!Number.isSafeInteger(config.leaseMs) ||
    config.leaseMs < 1 || config.leaseMs > 86_400_000) {
    throw new Error('Invalid job lease duration');
  }
  const claimProviderBackedJobs = claimPolicy === 'all';
  const policyAllowsJob = sql`(
    ${claimProviderBackedJobs}
    or type not in (
      ${STRIPE_EVENT_JOB}, ${FINANCIAL_SOURCE_JOB},
      ${FINANCIAL_PAYOUT_JOB}, ${FINANCIAL_SCAN_JOB}
    )
    or type = ${FINANCIAL_CLASSIFICATION_JOB}
    or (
      type = ${FINANCIAL_SCAN_JOB}
      and (
        payload ->> 'kind' = 'composite_replay'
        or (
          payload ->> 'kind' = 'continuation'
          and payload ->> 'phase' in (
            'classification_replay_page', 'classification_replay_finalize'
          )
        )
      )
    )
  )`;
  const replayFinalizerReady = sql`(
    not (
      type = ${FINANCIAL_SCAN_JOB}
      and payload ->> 'kind' = 'continuation'
      and payload ->> 'phase' = 'classification_replay_finalize'
    ) or exists (
      select 1 from financial_scan_runs completed_replay_run
      where completed_replay_run.id::text = jobs.payload ->> 'scanRunId'
        and completed_replay_run.kind = 'classification_replay'
        and completed_replay_run.state = 'completed'
    ) or not exists (
      select 1 from jobs replay_child
      where replay_child.type = ${FINANCIAL_CLASSIFICATION_JOB}
        and replay_child.payload ->> 'scanRunId' = jobs.payload ->> 'scanRunId'
        and replay_child.status <> 'succeeded'
    )
  )`;
  const replayImplementationSupported = sql`(
    not (
      type = ${FINANCIAL_CLASSIFICATION_JOB}
      or (type = ${FINANCIAL_SCAN_JOB} and payload ->> 'kind' = 'composite_replay')
      or (
        type = ${FINANCIAL_SCAN_JOB}
        and payload ->> 'kind' = 'continuation'
        and payload ->> 'phase' in (
          'classification_replay_page', 'classification_replay_finalize'
        )
      )
    )
    or (
      (
        type = ${FINANCIAL_CLASSIFICATION_JOB}
        or (type = ${FINANCIAL_SCAN_JOB} and payload ->> 'kind' = 'composite_replay')
      )
      and payload ->> 'classifierVersion' =
          ${String(classificationImplementation.classifierVersion)}
        and payload ->> 'allocationAlgorithmVersion' =
          ${String(classificationImplementation.allocationAlgorithmVersion)}
    )
    or (
      type = ${FINANCIAL_CLASSIFICATION_JOB}
      and exists (
        select 1 from financial_projection_versions cleanup_authority
        where cleanup_authority.singleton = true
          and case when
            jobs.payload ->> 'classifierVersion' ~ '^[1-9][0-9]{0,9}$'
            and jobs.payload ->> 'allocationAlgorithmVersion' ~ '^[1-9][0-9]{0,9}$'
          then
            (jobs.payload ->> 'classifierVersion')::bigint <=
              cleanup_authority.classifier_version
            and (jobs.payload ->> 'allocationAlgorithmVersion')::bigint <=
              cleanup_authority.allocation_algorithm_version
            and (
              (jobs.payload ->> 'classifierVersion')::bigint <
                cleanup_authority.classifier_version
              or (jobs.payload ->> 'allocationAlgorithmVersion')::bigint <
                cleanup_authority.allocation_algorithm_version
            )
          else false end
          and (
            (
              cleanup_authority.classifier_version =
                ${classificationImplementation.classifierVersion}
              and cleanup_authority.allocation_algorithm_version =
                ${classificationImplementation.allocationAlgorithmVersion}
            )
            or (
              cleanup_authority.pending_classifier_version =
                ${classificationImplementation.classifierVersion}
              and cleanup_authority.pending_allocation_algorithm_version =
                ${classificationImplementation.allocationAlgorithmVersion}
              and cleanup_authority.pending_replay_id is not null
              and cleanup_authority.pending_scan_run_id is not null
            )
          )
      )
    )
    or (
      type = ${FINANCIAL_SCAN_JOB}
      and payload ->> 'kind' = 'continuation'
      and payload ->> 'phase' in (
        'classification_replay_page', 'classification_replay_finalize'
      )
      and exists (
        select 1 from financial_scan_runs replay_run
        where replay_run.id::text = jobs.payload ->> 'scanRunId'
          and replay_run.kind = 'classification_replay'
          and replay_run.classifier_version =
            ${classificationImplementation.classifierVersion}
          and replay_run.allocation_algorithm_version =
            ${classificationImplementation.allocationAlgorithmVersion}
          and (
            (
              replay_run.state = 'running'
              and replay_run.phase = jobs.payload ->> 'phase'
            )
            or (
              jobs.payload ->> 'phase' = 'classification_replay_page'
              and replay_run.phase = 'classification_replay_finalize'
              and replay_run.state in ('running', 'completed')
            )
            or (
              jobs.payload ->> 'phase' = 'classification_replay_finalize'
              and replay_run.state = 'completed'
            )
          )
      )
    )
  )`;
  const providerImplementationSupported = sql`(
    not (
      type = ${STRIPE_EVENT_JOB}
      or type in (${FINANCIAL_SOURCE_JOB}, ${FINANCIAL_PAYOUT_JOB})
      or (
        type = ${FINANCIAL_SCAN_JOB}
        and not coalesce(
          payload ->> 'kind' = 'composite_replay'
          or (
            payload ->> 'kind' = 'continuation'
            and payload ->> 'phase' in (
              'classification_replay_page', 'classification_replay_finalize'
            )
          ),
          false
        )
      )
    )
    or exists (
      select 1 from financial_projection_versions active_projection
      where active_projection.singleton = true
        and active_projection.classifier_version =
          ${classificationImplementation.classifierVersion}
        and active_projection.allocation_algorithm_version =
          ${classificationImplementation.allocationAlgorithmVersion}
        and active_projection.pending_classifier_version is null
        and active_projection.pending_allocation_algorithm_version is null
        and active_projection.pending_replay_id is null
        and active_projection.pending_scan_run_id is null
    )
  )`;
  const claimableJob = sql`
    (${policyAllowsJob}) and (${replayFinalizerReady})
      and (${replayImplementationSupported})
      and (${providerImplementationSupported})
  `;
  return {
    async claimNext(workerId): Promise<JobRecord | null> {
      const claimedAt = now();
      const expiredBefore = new Date(claimedAt.getTime() - config.leaseMs);
      let financialAdminPath = false;
      try {
        return await withTransaction(database, async (transaction) => {
          const [candidate] = await queryRows<LockedClaimCandidate>(transaction, sql`
            select
              jobs.id,
              jobs.type,
              jobs.payload,
              jobs.deduplication_key as "deduplicationKey",
              jobs.status,
              jobs.run_at as "runAt",
              jobs.attempts,
              jobs.max_attempts as "maxAttempts",
              jobs.locked_at as "lockedAt",
              jobs.locked_by as "lockedBy",
              jobs.last_error as "lastError",
              jobs.rerun_requested_at as "rerunRequestedAt",
              jobs.status as "priorStatus",
              jobs.rerun_requested_at is not null as "hadRerunRequest"
            from jobs
            where (
              (
                jobs.status = 'pending'
                and (
                  (
                    jobs.type = ${FINANCIAL_ADMIN_COMMAND_JOB}
                    and jobs.run_at <= pg_catalog.clock_timestamp()
                  ) or (
                    jobs.type <> ${FINANCIAL_ADMIN_COMMAND_JOB}
                    and jobs.run_at <= ${claimedAt}
                  )
                )
                and jobs.attempts < jobs.max_attempts
              ) or (
                jobs.status = 'running'
                and (
                  (
                    jobs.type = ${FINANCIAL_ADMIN_COMMAND_JOB}
                    and jobs.run_at <= pg_catalog.clock_timestamp()
                  ) or (
                    jobs.type <> ${FINANCIAL_ADMIN_COMMAND_JOB}
                    and jobs.locked_at <= ${expiredBefore}
                  )
                )
              )
            ) and (${claimableJob})
            order by jobs.run_at asc, jobs.created_at asc, jobs.id asc
            for update skip locked
            limit 1
          `);
          if (!candidate) return null;

          const isFinancialAdmin = candidate.type === FINANCIAL_ADMIN_COMMAND_JOB;
          financialAdminPath = isFinancialAdmin;
          const isExpiredFinalAttempt = candidate.priorStatus === 'running' &&
            candidate.attempts >= candidate.maxAttempts &&
            !candidate.hadRerunRequest;

          if (isExpiredFinalAttempt) {
            if (isFinancialAdmin) {
              const capability = createFinancialAdminLeaseCapability(
                financialAdminCapabilitySource
              );
              await setFinancialAdminLeaseContext(
                transaction,
                capability,
                config.leaseMs
              );
              await lockFinancialAdminLease(transaction, candidate.id, 'exclusive');
              const adopted = await queryRows<{ id: string }>(transaction, sql`
                update jobs
                set locked_at = pg_catalog.clock_timestamp(),
                    locked_by = ${workerId},
                    rerun_requested_at = null,
                    updated_at = pg_catalog.clock_timestamp()
                where id = ${candidate.id}::uuid
                  and type = ${FINANCIAL_ADMIN_COMMAND_JOB}
                  and status = 'running'
                  and attempts = ${candidate.attempts}
                  and attempts >= max_attempts
                returning id
              `);
              if (adopted.length !== 1) return null;
              const [terminalCommand] = await queryRows<{
                status: 'pending' | 'succeeded' | 'denied' | 'conflict' | 'failed';
              }>(transaction, sql`
                select command.status
                from financial_admin_commands command
                where command.job_id = ${candidate.id}::uuid
                for update
              `);
              if (!terminalCommand) throw financialAdminAuthorityFailure();
              const terminalJobStatus = terminalCommand.status === 'succeeded'
                ? 'succeeded'
                : 'failed';
              const terminalStatusSql = terminalJobStatus === 'succeeded'
                ? sql`'succeeded'::job_status`
                : sql`'failed'::job_status`;
              const terminalError = terminalJobStatus === 'succeeded'
                ? sql`null::text`
                : sql`'Job lease expired after final attempt'`;
              const terminal = await queryRows<{ id: string }>(transaction, sql`
                update jobs
                set status = ${terminalStatusSql},
                    locked_at = null,
                    locked_by = null,
                    last_error = ${terminalError},
                    rerun_requested_at = null,
                    completed_at = pg_catalog.clock_timestamp(),
                    updated_at = pg_catalog.clock_timestamp()
                where id = ${candidate.id}::uuid
                  and type = ${FINANCIAL_ADMIN_COMMAND_JOB}
                  and status = 'running'
                  and locked_by = ${workerId}
                  and attempts = ${candidate.attempts}
                returning id
              `);
              if (terminal.length !== 1) return null;
              return null;
            }

            await transaction.execute(sql`
              update jobs
              set status = case when rerun_requested_at is null
                    then 'failed'::job_status else 'pending'::job_status end,
                  run_at = case when rerun_requested_at is null
                    then run_at else ${claimedAt} end,
                  attempts = case when rerun_requested_at is null then attempts else 0 end,
                  locked_at = null,
                  locked_by = null,
                  last_error = case when rerun_requested_at is null
                    then pg_catalog.coalesce(
                      last_error,
                      'Job lease expired after final attempt'
                    ) else null end,
                  rerun_requested_at = null,
                  completed_at = case when rerun_requested_at is null
                    then ${claimedAt}::timestamptz else null::timestamptz end,
                  updated_at = ${claimedAt}
              where id = ${candidate.id}::uuid
                and status = 'running'
                and locked_by = ${candidate.lockedBy}
                and attempts = ${candidate.attempts}
                and attempts >= max_attempts
            `);
            return null;
          }

          let capability: string | undefined;
          if (isFinancialAdmin) {
            capability = createFinancialAdminLeaseCapability(
              financialAdminCapabilitySource
            );
            await setFinancialAdminLeaseContext(
              transaction,
              capability,
              config.leaseMs
            );
            await lockFinancialAdminLease(transaction, candidate.id, 'exclusive');
          }
          const lockTimestamp = isFinancialAdmin
            ? sql`pg_catalog.clock_timestamp()`
            : sql`${claimedAt}`;
          const claimed = await queryRows<ClaimedJobRow>(transaction, sql`
            update jobs
            set status = 'running',
                attempts = case
                  when ${candidate.priorStatus} = 'running' and
                    ${candidate.hadRerunRequest} then 1
                  else jobs.attempts + 1
                end,
                locked_at = ${lockTimestamp},
                locked_by = ${workerId},
                rerun_requested_at = case when ${candidate.priorStatus} = 'running'
                  then null else jobs.rerun_requested_at end,
                last_error = case
                  when ${candidate.priorStatus} = 'running' and
                    ${candidate.hadRerunRequest} then null
                  else jobs.last_error
                end,
                updated_at = ${lockTimestamp}
            where jobs.id = ${candidate.id}::uuid
              and jobs.status = ${candidate.priorStatus}::job_status
              and jobs.attempts = ${candidate.attempts}
              and (
                jobs.attempts < jobs.max_attempts
                or (
                  ${candidate.priorStatus} = 'running'
                  and ${candidate.hadRerunRequest}
                  and jobs.rerun_requested_at is not null
                  and jobs.attempts = jobs.max_attempts
                )
              )
            returning jobs.id,
                      jobs.type,
                      jobs.payload,
                      jobs.deduplication_key as "deduplicationKey",
                      jobs.attempts,
                      jobs.max_attempts as "maxAttempts",
                      jobs.locked_by as "lockedBy"
          `);
          const record = claimed[0];
          if (!record) return null;
          return capability === undefined
            ? record
            : { ...record, financialAdminLeaseCapability: capability };
        });
      } catch (error: unknown) {
        if (!financialAdminPath) throw error;
        if (errorCode(error) === '55000') return null;
        throw financialAdminAuthorityFailure();
      }
    },

    async renewLease(jobId, workerId, capability): Promise<boolean> {
      let financialAdminPath = false;
      try {
        return await withTransaction(database, async (transaction) => {
          const [job] = await queryRows<LockedOwnedJob>(transaction, sql`
            select id, type, payload,
              deduplication_key as "deduplicationKey",
              status, run_at as "runAt", attempts,
              max_attempts as "maxAttempts", locked_at as "lockedAt",
              locked_by as "lockedBy", last_error as "lastError",
              rerun_requested_at as "rerunRequestedAt"
            from jobs
            where id = ${jobId}::uuid
              and status = 'running'
              and locked_by = ${workerId}
            for update
          `);
          if (!job) return false;
          financialAdminPath = job.type === FINANCIAL_ADMIN_COMMAND_JOB;
          if (!financialAdminPath) {
            const renewedAt = now();
            const renewed = await queryRows<{ id: string }>(transaction, sql`
              update jobs
              set locked_at = ${renewedAt}, updated_at = ${renewedAt}
              where id = ${job.id}::uuid
                and status = 'running'
                and locked_by = ${workerId}
              returning id
            `);
            return renewed.length === 1;
          }
          if (capability === undefined ||
            !FINANCIAL_ADMIN_LEASE_CAPABILITY_PATTERN.test(capability)) return false;
          await setFinancialAdminLeaseContext(transaction, capability);
          await lockFinancialAdminLease(transaction, job.id, 'shared');
          const renewed = await queryRows<{ id: string }>(transaction, sql`
            update jobs
            set locked_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
            where id = ${job.id}::uuid
              and type = ${FINANCIAL_ADMIN_COMMAND_JOB}
              and status = 'running'
              and locked_by = ${workerId}
              and attempts = ${job.attempts}
            returning id
          `);
          return renewed.length === 1;
        });
      } catch (error: unknown) {
        if (!financialAdminPath) throw error;
        if (errorCode(error) === '55000') return false;
        throw financialAdminAuthorityFailure();
      }
    },

    async complete(jobId, workerId, capability): Promise<boolean> {
      let financialAdminPath = false;
      try {
        return await withTransaction(database, async (transaction) => {
          const [job] = await queryRows<LockedOwnedJob>(transaction, sql`
            select id, type, payload,
              deduplication_key as "deduplicationKey",
              status, run_at as "runAt", attempts,
              max_attempts as "maxAttempts", locked_at as "lockedAt",
              locked_by as "lockedBy", last_error as "lastError",
              rerun_requested_at as "rerunRequestedAt"
            from jobs
            where id = ${jobId}::uuid
              and status = 'running'
              and locked_by = ${workerId}
            for update
          `);
          if (!job) return false;
          financialAdminPath = job.type === FINANCIAL_ADMIN_COMMAND_JOB;
          if (financialAdminPath) {
            if (capability === undefined ||
              !FINANCIAL_ADMIN_LEASE_CAPABILITY_PATTERN.test(capability)) return false;
            await setFinancialAdminLeaseContext(transaction, capability);
            await lockFinancialAdminLease(transaction, job.id, 'exclusive');
          }
          const completedAt = now();
          const timestamp = financialAdminPath
            ? sql`pg_catalog.clock_timestamp()`
            : sql`${completedAt}`;
          const completed = job.rerunRequestedAt === null
            ? await queryRows<{ id: string }>(transaction, sql`
                update jobs
                set status = 'succeeded',
                    completed_at = ${timestamp},
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    updated_at = ${timestamp}
                where id = ${job.id}::uuid
                  and status = 'running'
                  and locked_by = ${workerId}
                  and attempts = ${job.attempts}
                returning id
              `)
            : await queryRows<{ id: string }>(transaction, sql`
                update jobs
                set status = 'pending',
                    run_at = ${timestamp},
                    attempts = 0,
                    completed_at = null,
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    rerun_requested_at = null,
                    updated_at = ${timestamp}
                where id = ${job.id}::uuid
                  and status = 'running'
                  and locked_by = ${workerId}
                  and attempts = ${job.attempts}
                returning id
              `);
          return completed.length === 1;
        });
      } catch (error: unknown) {
        if (!financialAdminPath) throw error;
        if (errorCode(error) === '55000') return false;
        throw financialAdminAuthorityFailure();
      }
    },

    async fail(jobId, workerId, safeError, retryable, capability): Promise<boolean> {
      let financialAdminPath = false;
      try {
        return await withTransaction(database, async (transaction) => {
          const [job] = await queryRows<LockedOwnedJob>(transaction, sql`
            select id, type, payload,
              deduplication_key as "deduplicationKey",
              status, run_at as "runAt", attempts,
              max_attempts as "maxAttempts", locked_at as "lockedAt",
              locked_by as "lockedBy", last_error as "lastError",
              rerun_requested_at as "rerunRequestedAt"
            from jobs
            where id = ${jobId}::uuid
              and status = 'running'
              and locked_by = ${workerId}
            for update
          `);
          if (!job) return false;
          financialAdminPath = job.type === FINANCIAL_ADMIN_COMMAND_JOB;
          if (financialAdminPath) {
            if (capability === undefined ||
              !FINANCIAL_ADMIN_LEASE_CAPABILITY_PATTERN.test(capability)) return false;
            await setFinancialAdminLeaseContext(transaction, capability);
            await lockFinancialAdminLease(transaction, job.id, 'exclusive');
          }
          const failedAt = now();
          const timestamp = financialAdminPath
            ? sql`pg_catalog.clock_timestamp()`
            : sql`${failedAt}`;
          if (job.rerunRequestedAt !== null) {
            const requeued = await queryRows<{ id: string }>(transaction, sql`
              update jobs
              set status = 'pending',
                  run_at = ${timestamp},
                  attempts = 0,
                  locked_at = null,
                  locked_by = null,
                  last_error = null,
                  rerun_requested_at = null,
                  completed_at = null,
                  updated_at = ${timestamp}
              where id = ${job.id}::uuid
                and status = 'running'
                and locked_by = ${workerId}
                and attempts = ${job.attempts}
              returning id
            `);
            return requeued.length === 1;
          }
          const exhausted = !retryable || job.attempts >= job.maxAttempts;
          const retryDelay = computeRetryDelayMs(
            job.attempts,
            config.retryBaseMs,
            config.retryMaxMs
          );
          const boundedSafeError = financialAdminPath && capability !== undefined &&
            safeError.includes(capability)
            ? 'Financial administrator job failure'
            : safeError.slice(0, 1000);
          const runAt = exhausted
            ? sql`${job.runAt}`
            : financialAdminPath
              ? sql`pg_catalog.clock_timestamp() +
                  (${retryDelay}::double precision * interval '1 millisecond')`
              : sql`${new Date(failedAt.getTime() + retryDelay)}`;
          const failed = await queryRows<{ id: string }>(transaction, sql`
            update jobs
            set status = ${exhausted ? 'failed' : 'pending'}::job_status,
                run_at = ${runAt},
                locked_at = null,
                locked_by = null,
                last_error = ${boundedSafeError},
                completed_at = ${exhausted ? timestamp : sql`null::timestamptz`},
                updated_at = ${timestamp}
            where id = ${job.id}::uuid
              and status = 'running'
              and locked_by = ${workerId}
              and attempts = ${job.attempts}
            returning id
          `);
          return failed.length === 1;
        });
      } catch (error: unknown) {
        if (!financialAdminPath) throw error;
        if (errorCode(error) === '55000') return false;
        throw financialAdminAuthorityFailure();
      }
    }
  };
}
