import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import { setAdminRole } from '$lib/server/auth/roles';
import { createFinancialClassificationSubjectJob } from
  '$lib/server/commerce/financial/jobs';
import { loadApplicationConfig } from '$lib/server/config/load';
import type { Database } from '$lib/server/db/client';
import { databaseEnvironmentForRole } from
  '$lib/server/db/database-role-provision';
import * as schema from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { RegisteredJobKind } from '$lib/server/jobs/catalog';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { DefiniteRetryableJobError } from '$lib/server/jobs/runner';
import type {
  JobRecord,
  JobRepository,
  OperationsJobLeaseAuthority
} from '$lib/server/jobs/types';
import { createFinancialClassificationJobRetryPolicyAdapter } from
  '$lib/server/operations/jobs/adapters/financial-classification';
import { createStripeEventJobRetryPolicyAdapter } from
  '$lib/server/operations/jobs/adapters/stripe-event';
import { prepareJobRetryCommand } from '$lib/server/operations/jobs/contracts';
import { createOperationsJobRetryHandler } from
  '$lib/server/operations/jobs/handler';
import {
  createJobRetryPolicyAdapters,
  type JobRetryPolicyAdapter,
  type JobRetryPolicyOutcome,
  type JobRetryPolicyTarget
} from '$lib/server/operations/jobs/policies';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient
} from './database';

const AUTHORITY_ERROR = Object.freeze({
  code: '55000',
  message: 'Plan 7A operations job authority is not current'
});
const RACE_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 20_000;
const LONG_TEST_TIMEOUT_MS = 30_000;
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{6}Z$/u;

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface ProbeDatabase {
  readonly database: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

interface OpenTransaction {
  readonly client: PoolClient;
  readonly pid: number;
  open: boolean;
}

interface TargetSnapshot {
  readonly id: string;
  readonly kind: RegisteredJobKind;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly updatedAt: string;
}

interface RetryFixture {
  readonly actor: AdministratorActor;
  readonly commandId: string;
  readonly correlationId: string;
  readonly internalJobId: string;
  readonly target: TargetSnapshot;
}

interface StripeTargetFixture {
  readonly stripeEventId: string;
  readonly target: TargetSnapshot;
}

interface CleanupOperation {
  readonly label: string;
  readonly operation: Promise<unknown> | undefined;
}

interface RejectedAuthority {
  readonly clear: string;
  readonly owner: string;
  readonly generation: number;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function capability(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('base64url');
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function probeName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

function postgresError(error: unknown): { code?: string; message?: string } {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current === null || typeof current !== 'object') break;
    const record = current as {
      readonly cause?: unknown;
      readonly code?: unknown;
      readonly message?: unknown;
    };
    if (typeof record.code === 'string') {
      return typeof record.message === 'string'
        ? { code: record.code, message: record.message }
        : { code: record.code };
    }
    current = record.cause;
  }
  return {};
}

async function expectAuthorityError(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    throw new Error('Expected operations authority rejection');
  } catch (error) {
    expect(postgresError(error)).toEqual(AUTHORITY_ERROR);
  }
}

async function within<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), RACE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function probeDatabase(
  applicationName: string,
  role: 'runtime' | 'worker'
): ProbeDatabase {
  const config = role === 'worker'
    ? loadApplicationConfig(databaseEnvironmentForRole(process.env, 'worker'))
    : applicationConfig;
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    max: 1,
    connectionTimeoutMillis: config.database.connectionTimeoutMs,
    statement_timeout: config.database.statementTimeoutMs,
    options: '-c lock_timeout=5000'
  });
  const base = drizzle({ client: pool, schema }) as Database;
  const database = new Proxy(base, {
    get(target, property) {
      if (property === 'transaction') {
        return (work: (transaction: DatabaseTransaction) => Promise<unknown>) =>
          base.transaction(async (transaction) => {
            await transaction.execute(
              sql`select set_config('application_name', ${applicationName}, true)`
            );
            await transaction.execute(
              sql`select set_config('lock_timeout', '5s', true)`
            );
            return work(transaction);
          });
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return { database, pool, close: () => pool.end() };
}

async function backendPid(pool: Pool): Promise<number> {
  const result = await pool.query<{ pid: number }>('select pg_backend_pid() as pid');
  const pid = result.rows[0]?.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) {
    throw new Error('Expected a PostgreSQL backend PID');
  }
  return pid;
}

async function openOwnerTransaction(applicationName: string): Promise<OpenTransaction> {
  const client = await ownerDatabaseClient.pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('application_name', $1, true)", [
      applicationName
    ]);
    await client.query("select set_config('lock_timeout', '5s', true)");
    const pid = (await client.query<{ pid: number }>(
      'select pg_backend_pid() as pid'
    )).rows[0]?.pid;
    if (typeof pid !== 'number') throw new Error('Expected owner blocker PID');
    return { client, pid, open: true };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    client.release(true);
    throw error;
  }
}

async function beginCapabilityTransaction(
  applicationName: string,
  clearCapability: string
): Promise<OpenTransaction> {
  const client = await workerDatabaseClient.pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('application_name', $1, true)", [
      applicationName
    ]);
    await client.query("select set_config('lock_timeout', '5s', true)");
    await client.query(
      `select set_config(
         'pale_orbit.plan7a_operations_job_capability', $1, true
       )`,
      [clearCapability]
    );
    const pid = (await client.query<{ pid: number }>(
      'select pg_backend_pid() as pid'
    )).rows[0]?.pid;
    if (typeof pid !== 'number') throw new Error('Expected worker transaction PID');
    return { client, pid, open: true };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    client.release(true);
    throw error;
  }
}

async function closeTransaction(
  transaction: OpenTransaction,
  outcome: 'commit' | 'rollback' = 'rollback'
): Promise<void> {
  if (!transaction.open) return;
  transaction.open = false;
  try {
    await within(
      transaction.client.query(outcome),
      `Timed out trying to ${outcome} PostgreSQL race transaction`
    );
    transaction.client.release();
  } catch (error) {
    transaction.client.release(true);
    throw error;
  }
}

async function waitForBlockedQuery(input: {
  readonly pid: number;
  readonly applicationName: string;
  readonly blockerPids: readonly number[];
  readonly queryFragment: string;
  readonly operation: Promise<unknown>;
  readonly exactBlockers?: boolean;
}): Promise<void> {
  const observation = (async () => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = await ownerDatabaseClient.pool.query<{
        blockers: number[];
        query: string;
        waitEventType: string | null;
      }>(`
        select pg_blocking_pids(pid) as blockers, query,
          wait_event_type as "waitEventType"
        from pg_catalog.pg_stat_activity
        where pid = $1 and application_name = $2
      `, [input.pid, input.applicationName]);
      const row = result.rows[0];
      if (row?.waitEventType === 'Lock') {
        const actual = [...row.blockers].sort((left, right) => left - right);
        const expected = [...input.blockerPids].sort((left, right) => left - right);
        if (input.exactBlockers === false) {
          expect(actual).toEqual(expect.arrayContaining(expected));
        } else {
          expect(actual).toEqual(expected);
        }
        expect(row.query.replace(/\s+/gu, ' ').toLowerCase())
          .toContain(input.queryFragment.toLowerCase());
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Expected ${input.applicationName} to block in ${input.queryFragment}`
    );
  })();
  await Promise.race([
    observation,
    input.operation.then(
      () => {
        throw new Error(`${input.applicationName} completed before its lock barrier`);
      },
      (error: unknown) => { throw error; }
    )
  ]);
}

async function waitForIdleTransaction(input: {
  readonly pid: number;
  readonly applicationName: string;
  readonly operation: Promise<unknown>;
}): Promise<void> {
  const observation = (async () => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = await ownerDatabaseClient.pool.query<{
        applicationName: string;
        state: string;
      }>(`
        select application_name as "applicationName", state
        from pg_catalog.pg_stat_activity
        where pid = $1 and application_name = $2
      `, [input.pid, input.applicationName]);
      if (result.rows[0]?.state === 'idle in transaction') return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${input.applicationName} did not pause in its transaction`);
  })();
  await Promise.race([
    observation,
    input.operation.then(
      () => { throw new Error(`${input.applicationName} completed before its barrier`); },
      (error: unknown) => { throw error; }
    )
  ]);
}

async function cleanupProbeResources(
  operations: readonly CleanupOperation[],
  probes: readonly (ProbeDatabase | undefined)[]
): Promise<void> {
  const operationCleanup = await Promise.allSettled(
    operations.flatMap(({ label, operation }) => operation === undefined
      ? []
      : [within(
          operation.then(() => undefined, () => undefined),
          `Timed out cleaning up ${label}`
        )])
  );
  const closeCleanup = await Promise.allSettled(
    probes.flatMap((probe, index) => probe === undefined
      ? []
      : [within(
          probe.close(),
          `Timed out closing operations race probe ${index + 1}`
        )])
  );
  const rejected = [...operationCleanup, ...closeCleanup].find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  );
  if (rejected) throw rejected.reason;
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [id, `Operations race ${label}`, `operations-race-${label}-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [id]
  );
  return { type: 'user', id, roles: ['admin'] };
}

async function insertFailedTarget(input: {
  readonly kind: RegisteredJobKind;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly payload?: unknown;
  readonly deduplicationKey?: string | null;
  readonly lastError?: string;
}): Promise<TargetSnapshot> {
  const id = randomUUID();
  const result = await ownerDatabaseClient.pool.query<{ updatedAt: string }>(
    `insert into jobs (
       id, type, payload, deduplication_key, status, run_at, attempts,
       max_attempts, last_error, completed_at, created_at, updated_at
     ) values (
       $1, $2, $3::jsonb, $4, 'failed',
       pg_catalog.clock_timestamp() - interval '1 hour', $5, $6, $7,
       pg_catalog.clock_timestamp(),
       pg_catalog.clock_timestamp() - interval '2 hours',
       pg_catalog.clock_timestamp()
     ) returning pg_catalog.to_char(
       updated_at at time zone 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
     ) as "updatedAt"`,
    [
      id,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.deduplicationKey ?? null,
      input.attempts,
      input.maxAttempts,
      input.lastError ?? 'Operations race target failure'
    ]
  );
  const updatedAt = result.rows[0]?.updatedAt;
  if (typeof updatedAt !== 'string' || !CANONICAL_TIMESTAMP.test(updatedAt)) {
    throw new Error('Expected a canonical operations target timestamp');
  }
  return {
    id,
    kind: input.kind,
    attempts: input.attempts,
    maxAttempts: input.maxAttempts,
    updatedAt
  };
}

async function createStripeTarget(): Promise<StripeTargetFixture> {
  const suffix = randomUUID().replaceAll('-', '');
  const providerEventId = `evt_operations_race_${suffix}`;
  const event = await databaseClient.pool.query<{ id: string }>(
    `insert into stripe_events (
       provider_event_id, event_type, object_id, live_mode,
       provider_created_at, raw_body_sha256
     ) values ($1, 'checkout.session.completed', $2, false,
       pg_catalog.clock_timestamp(), $3)
     returning id`,
    [
      providerEventId,
      `cs_operations_race_${suffix}`,
      digest(`operations-stripe-race-${suffix}`)
    ]
  );
  const stripeEventId = event.rows[0]?.id;
  if (!stripeEventId) throw new Error('Expected Stripe race event');
  return {
    stripeEventId,
    target: await insertFailedTarget({
      kind: 'commerce.stripe-event',
      attempts: 12,
      maxAttempts: 12,
      payload: { stripeEventId },
      deduplicationKey: `stripe:event:${providerEventId}`,
      lastError: 'Stripe event no longer exists.'
    })
  };
}

async function createClassificationTarget(): Promise<TargetSnapshot> {
  const suffix = randomUUID().replaceAll('-', '');
  const fingerprint = digest(`operations-classification-race-${suffix}`);
  const source = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into stripe_balance_transactions (
       provider_id, live_mode, source_family, source_id, raw_type,
       reporting_category, balance_type, amount_minor, fee_minor,
       net_minor, currency, status, provider_created_at, available_at,
       fingerprint_sha256
     ) values ($1, false, 'adjustment', null, 'adjustment',
       'other_adjustment', 'adjustment', 25, 0, 25, 'USD', 'available',
       pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), $2)
     returning id`,
    [`txn_operations_race_${suffix}`, fingerprint]
  );
  const subjectId = source.rows[0]?.id;
  if (!subjectId) throw new Error('Expected classification race subject');
  const spec = createFinancialClassificationSubjectJob({
    subjectType: 'balance_transaction',
    subjectId,
    sourceFingerprintSha256: fingerprint,
    classifierVersion: 1,
    allocationAlgorithmVersion: 2
  });
  return insertFailedTarget({
    kind: spec.type,
    attempts: spec.maxAttempts,
    maxAttempts: spec.maxAttempts,
    payload: spec.payload,
    deduplicationKey: spec.deduplicationKey,
    lastError: 'Financial classification evidence is invalid.'
  });
}

async function submitRetryCommand(
  actor: AdministratorActor,
  target: TargetSnapshot,
  label: string
): Promise<RetryFixture> {
  const correlationId = `operations-race-${label}-${randomUUID()}`;
  const prepared = prepareJobRetryCommand({
    idempotencyKey: randomUUID(),
    targetJobId: target.id,
    expectedKind: target.kind,
    expectedStatus: 'failed',
    expectedAttempts: target.attempts,
    expectedMaxAttempts: target.maxAttempts,
    expectedUpdatedAt: target.updatedAt,
    reasonCode: 'dependency_recovered'
  });
  const submitted = await databaseClient.pool.query<{ commandId: string }>(
    `select command_id as "commandId"
     from public.submit_job_retry_command(
       $1::uuid, $2::uuid, $3::text, $4::integer, $5::integer,
       $6::timestamptz, 'dependency_recovered'::text, $7::text,
       $8::text, $9::text
     )`,
    [
      actor.id,
      target.id,
      target.kind,
      target.attempts,
      target.maxAttempts,
      target.updatedAt,
      correlationId,
      prepared.idempotencyKeySha256,
      prepared.inputFingerprintSha256
    ]
  );
  const commandId = submitted.rows[0]?.commandId;
  if (!commandId) throw new Error('Expected operations retry command');
  const internal = await ownerDatabaseClient.pool.query<{ id: string }>(
    `select id from jobs
     where type = 'operations.job-retry-command'
       and payload = pg_catalog.jsonb_build_object('commandId', $1::uuid)`,
    [commandId]
  );
  const internalJobId = internal.rows[0]?.id;
  if (!internalJobId) throw new Error('Expected internal operations command job');
  return { actor, commandId, correlationId, internalJobId, target };
}

function createRepository(input: {
  readonly database?: Database;
  readonly leaseMs?: number;
  readonly retryMs?: number;
  readonly capabilitySource?: () => string;
} = {}): JobRepository {
  const retryMs = input.retryMs ?? 1;
  return createPostgresJobRepository(
    input.database ?? workerDatabaseClient.db,
    {
      ...applicationConfig.jobs,
      leaseMs: input.leaseMs ?? 5_000,
      retryBaseMs: retryMs,
      retryMaxMs: retryMs
    },
    undefined,
    'local-only',
    { classifierVersion: 1, allocationAlgorithmVersion: 2 },
    undefined,
    input.capabilitySource
  );
}

function createOperationsHandler(
  database: Database,
  enabled: {
    readonly stripe?: JobRetryPolicyAdapter;
    readonly classification?: JobRetryPolicyAdapter;
  } = {}
) {
  return createOperationsJobRetryHandler({
    database,
    policies: createJobRetryPolicyAdapters({
      rearmPendingStripeEvent:
        enabled.stripe ?? createStripeEventJobRetryPolicyAdapter(),
      rearmFinancialClassification:
        enabled.classification ?? createFinancialClassificationJobRetryPolicyAdapter()
    })
  });
}

function authority(job: JobRecord): OperationsJobLeaseAuthority {
  const clearCapability = job.operationsJobLeaseCapability;
  const generation = job.operationsJobLeaseGeneration;
  if (clearCapability === undefined || generation === undefined) {
    throw new Error('Expected operations job lease authority');
  }
  return Object.freeze({
    jobId: job.id,
    leaseOwner: job.lockedBy,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    generation,
    capability: clearCapability
  });
}

function policyTarget(fixture: RetryFixture): JobRetryPolicyTarget {
  return Object.freeze({
    commandId: fixture.commandId,
    targetJobId: fixture.target.id,
    expectedKind: fixture.target.kind,
    expectedStatus: 'failed',
    expectedAttempts: fixture.target.attempts,
    expectedMaxAttempts: fixture.target.maxAttempts,
    expectedUpdatedAt: fixture.target.updatedAt
  });
}

async function waitUntilDue(jobId: string): Promise<void> {
  for (let poll = 0; poll < 400; poll += 1) {
    const result = await ownerDatabaseClient.pool.query<{ due: boolean }>(
      `select run_at <= pg_catalog.clock_timestamp() as due
       from jobs where id = $1`,
      [jobId]
    );
    if (result.rows[0]?.due) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Operations job ${jobId} did not become due`);
}

async function deadlockCount(): Promise<number> {
  const result = await ownerDatabaseClient.pool.query<{ deadlocks: string }>(
    `select deadlocks::text from pg_catalog.pg_stat_database
     where datname = pg_catalog.current_database()`
  );
  return Number(result.rows[0]?.deadlocks ?? Number.NaN);
}

async function targetState(targetId: string) {
  return (await ownerDatabaseClient.pool.query<{
    attempts: number;
    completedAt: Date | null;
    lastError: string | null;
    lockedAt: Date | null;
    lockedBy: string | null;
    runAt: Date;
    status: string;
    updatedAt: Date;
  }>(
    `select status::text, attempts, run_at as "runAt",
       locked_at as "lockedAt", locked_by as "lockedBy",
       last_error as "lastError", completed_at as "completedAt",
       updated_at as "updatedAt"
     from jobs where id = $1`,
    [targetId]
  )).rows[0];
}

async function commandState(commandId: string) {
  const result = await ownerDatabaseClient.pool.query<{
    attempts: number;
    claimState: string;
    generation: number;
    jobStatus: string;
    resultCode: string | null;
    status: string;
    terminalAudits: number;
  }>(
    `select command.status::text as status,
       command.safe_result_code::text as "resultCode",
       job.status::text as "jobStatus", job.attempts,
       claim.generation, claim.state::text as "claimState",
       (select pg_catalog.count(*)::integer
        from audit_events audit
        where audit.resource_id = command.id::text
          and audit.action in (
            'operations.job_retry.succeeded',
            'operations.job_retry.denied',
            'operations.job_retry.failed'
          )) as "terminalAudits"
     from operations_job_retry_commands command
     join jobs job
       on job.payload = pg_catalog.jsonb_build_object('commandId', command.id)
     join operations_job_retry_claims claim on claim.job_id = job.id
     where command.id = $1`,
    [commandId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected operations command state');
  return row;
}

async function fullFinalAuthorityEvidence(commandId: string): Promise<unknown> {
  const result = await ownerDatabaseClient.pool.query<{ evidence: unknown }>(`
    select pg_catalog.jsonb_build_object(
      'command', pg_catalog.to_jsonb(command),
      'job', pg_catalog.to_jsonb(job),
      'claim', pg_catalog.to_jsonb(claim),
      'terminalAudits', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(audit) order by audit.id)
        from audit_events audit
        where audit.resource_id = command.id::text
          and audit.action in (
            'operations.job_retry.succeeded',
            'operations.job_retry.denied',
            'operations.job_retry.failed'
          )
      ), '[]'::jsonb)
    ) as evidence
    from operations_job_retry_commands command
    join jobs job
      on job.payload = pg_catalog.jsonb_build_object('commandId', command.id)
    join operations_job_retry_claims claim on claim.job_id = job.id
    where command.id = $1
  `, [commandId]);
  return result.rows[0]?.evidence;
}

async function workerCall<Row extends QueryResultRow>(
  clearCapability: string,
  text: string,
  parameters: readonly unknown[]
): Promise<readonly Row[]> {
  const transaction = await beginCapabilityTransaction(
    probeName('operations-private-call'),
    clearCapability
  );
  try {
    const result = await transaction.client.query<Row>(text, [...parameters]);
    await closeTransaction(transaction, 'commit');
    return result.rows;
  } catch (error) {
    await closeTransaction(transaction).catch(() => undefined);
    throw error;
  }
}

async function expectEveryPrivateOperationRejected(
  fixture: RetryFixture,
  candidate: RejectedAuthority
): Promise<void> {
  const identity = [
    fixture.internalJobId,
    candidate.owner,
    8,
    candidate.generation
  ] as const;
  expect(await workerCall(
    candidate.clear,
    'select * from public.plan7a_operations_claim_job($1, $2, 1234)',
    [fixture.internalJobId, candidate.owner]
  )).toEqual([]);
  const operations = [
    {
      text: 'select * from public.plan7a_operations_renew_job_claim($1, $2, $3, $4)',
      parameters: identity
    },
    {
      text: `select * from public.plan7a_operations_relinquish_job(
        $1, $2, $3, $4, 'Transient job handler failure', 1
      )`,
      parameters: identity
    },
    {
      text: 'select * from public.plan7a_operations_complete_job($1, $2, $3, $4)',
      parameters: identity
    },
    {
      text: `select * from public.plan7a_operations_fail_job(
        $1, $2, $3, $4, 'Operations job retry command permanently failed.'
      )`,
      parameters: identity
    },
    {
      text: 'select * from public.plan7a_operations_exhaust_job($1, $2, $3, $4)',
      parameters: identity
    },
    {
      text: `select * from public.plan7a_operations_lock_job_retry_command(
        $1, $2, $3, $4, $5
      )`,
      parameters: [
        fixture.internalJobId,
        fixture.commandId,
        candidate.owner,
        8,
        candidate.generation
      ]
    },
    {
      text: `select * from public.plan7a_operations_transition_job_retry_command(
        $1, $2, $3, $4, $5, 'retry_policy_not_enabled'
      )`,
      parameters: [
        fixture.internalJobId,
        fixture.commandId,
        candidate.owner,
        8,
        candidate.generation
      ]
    }
  ] as const;
  for (const operation of operations) {
    await expectAuthorityError(workerCall(
      candidate.clear,
      operation.text,
      operation.parameters
    ));
  }
}

async function advanceToFinalAttempt(
  fixture: RetryFixture,
  priorDuration: number
): Promise<JobRecord> {
  const issued = Array.from({ length: 8 }, (_, index) =>
    capability(`final-${fixture.commandId}-${index + 1}`));
  let capabilityIndex = 0;
  const repository = createRepository({
    leaseMs: priorDuration,
    retryMs: 1,
    capabilitySource: () => issued[capabilityIndex++]!
  });
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const claimed = await repository.claimNext(`operations-final-${attempt}`);
    expect(claimed).toMatchObject({
      id: fixture.internalJobId,
      attempts: attempt,
      operationsJobLeaseGeneration: attempt,
      operationsJobLeaseCapability: issued[attempt - 1]
    });
    if (!claimed) throw new Error(`Expected operations attempt ${attempt}`);
    await expect(repository.failOperationsJob(
      authority(claimed),
      'Transient job handler failure',
      true
    )).resolves.toEqual({ applied: true, retryScheduled: true });
    await waitUntilDue(fixture.internalJobId);
  }
  const finalClaim = await repository.claimNext('operations-final-8');
  expect(finalClaim).toMatchObject({
    id: fixture.internalJobId,
    attempts: 8,
    maxAttempts: 8,
    operationsJobLeaseGeneration: 8,
    operationsJobLeaseCapability: issued[7]
  });
  if (!finalClaim) throw new Error('Expected operations final-attempt claim');
  return finalClaim;
}

async function lockJobRow(transaction: OpenTransaction, jobId: string): Promise<void> {
  await transaction.client.query('select id from jobs where id = $1 for update', [jobId]);
}

async function lockCommandRow(
  transaction: OpenTransaction,
  commandId: string
): Promise<void> {
  await transaction.client.query(
    'select id from operations_job_retry_commands where id = $1 for update',
    [commandId]
  );
}

async function lockClaimRow(transaction: OpenTransaction, jobId: string): Promise<void> {
  await transaction.client.query(
    'select job_id from operations_job_retry_claims where job_id = $1 for update',
    [jobId]
  );
}

async function lockOperationsLease(
  transaction: OpenTransaction,
  jobId: string,
  mode: 'exclusive' | 'shared' = 'exclusive'
): Promise<void> {
  const lock = mode === 'exclusive'
    ? 'pg_catalog.pg_advisory_xact_lock'
    : 'pg_catalog.pg_advisory_xact_lock_shared';
  await transaction.client.query(
    `select ${lock}(pg_catalog.hashtextextended(
       'pale-orbit:plan7a-operations-job-lease:' || $1::uuid::text, 0
     ))`,
    [jobId]
  );
}

describe('Plan 7A operations deterministic races and crash replay', () => {
  it('grants one first claim after an exact named job-row barrier', async () => {
    const actor = await createAdministrator('claim-uniqueness');
    const target = await insertFailedTarget({
      kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
    });
    const fixture = await submitRetryCommand(actor, target, 'claim-uniqueness');
    const blocker = await openOwnerTransaction(probeName('claim-row-blocker'));
    const firstName = probeName('claim-first');
    const secondName = probeName('claim-second');
    const first = await beginCapabilityTransaction(
      firstName,
      capability(`claim-first-${fixture.commandId}`)
    );
    const second = await beginCapabilityTransaction(
      secondName,
      capability(`claim-second-${fixture.commandId}`)
    );
    let firstWork: Promise<{ rows: readonly QueryResultRow[] }> | undefined;
    let secondWork: Promise<{ rows: readonly QueryResultRow[] }> | undefined;
    try {
      await lockJobRow(blocker, fixture.internalJobId);
      firstWork = first.client.query(
        'select * from public.plan7a_operations_claim_job($1, $2, 60000)',
        [fixture.internalJobId, 'operations-claim-first']
      );
      void firstWork.catch(() => undefined);
      await waitForBlockedQuery({
        pid: first.pid,
        applicationName: firstName,
        blockerPids: [blocker.pid],
        queryFragment: 'plan7a_operations_claim_job',
        operation: firstWork
      });
      secondWork = second.client.query(
        'select * from public.plan7a_operations_claim_job($1, $2, 60000)',
        [fixture.internalJobId, 'operations-claim-second']
      );
      void secondWork.catch(() => undefined);
      await waitForBlockedQuery({
        pid: second.pid,
        applicationName: secondName,
        blockerPids: [first.pid],
        queryFragment: 'plan7a_operations_claim_job',
        operation: secondWork
      });
      await closeTransaction(blocker);
      expect((await within(firstWork, 'First claim did not win its queue')).rows)
        .toMatchObject([{ attempt: 1, lease_generation: 1 }]);
      await waitForBlockedQuery({
        pid: second.pid,
        applicationName: secondName,
        blockerPids: [first.pid],
        queryFragment: 'plan7a_operations_claim_job',
        operation: secondWork
      });
      await closeTransaction(first, 'commit');
      expect((await within(secondWork, 'Second claim did not leave the queue')).rows)
        .toEqual([]);
      await closeTransaction(second, 'commit');
      await expect(ownerDatabaseClient.pool.query(
        `select job.status::text as status, job.attempts,
           claim.generation, claim.lease_owner
         from jobs job
         join operations_job_retry_claims claim on claim.job_id = job.id
         where job.id = $1`,
        [fixture.internalJobId]
      )).resolves.toMatchObject({
        rows: [{
          status: 'running',
          attempts: 1,
          generation: 1,
          lease_owner: 'operations-claim-first'
        }]
      });
    } finally {
      await closeTransaction(blocker).catch(() => undefined);
      await closeTransaction(first).catch(() => undefined);
      await closeTransaction(second).catch(() => undefined);
      await Promise.allSettled([firstWork, secondWork].flatMap((work) => work ?? []));
    }
  }, TEST_TIMEOUT_MS);

  it('takes over in job-row, exclusive-lease, claim, command order without deadlock', async () => {
    const initialDeadlocks = await deadlockCount();
    const actor = await createAdministrator('takeover-lock-order');
    const target = await insertFailedTarget({
      kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
    });
    const fixture = await submitRetryCommand(actor, target, 'takeover-lock-order');
    const initialRepository = createRepository({
      leaseMs: 30,
      capabilitySource: () => capability(`takeover-prior-${fixture.commandId}`)
    });
    expect(await initialRepository.claimNext('operations-takeover-prior'))
      .toMatchObject({ attempts: 1, operationsJobLeaseGeneration: 1 });
    await waitUntilDue(fixture.internalJobId);

    const rowBlocker = await openOwnerTransaction(probeName('takeover-job-row'));
    const leaseBlocker = await openOwnerTransaction(probeName('takeover-lease'));
    const claimBlocker = await openOwnerTransaction(probeName('takeover-claim-row'));
    const commandBlocker = await openOwnerTransaction(probeName('takeover-command-row'));
    const takeoverName = probeName('takeover-worker');
    const takeover = await beginCapabilityTransaction(
      takeoverName,
      capability(`takeover-current-${fixture.commandId}`)
    );
    let takeoverWork: Promise<{ rows: readonly QueryResultRow[] }> | undefined;
    try {
      await lockJobRow(rowBlocker, fixture.internalJobId);
      await lockOperationsLease(leaseBlocker, fixture.internalJobId, 'shared');
      await lockClaimRow(claimBlocker, fixture.internalJobId);
      await lockCommandRow(commandBlocker, fixture.commandId);
      takeoverWork = takeover.client.query(
        'select * from public.plan7a_operations_claim_job($1, $2, 4321)',
        [fixture.internalJobId, 'operations-takeover-current']
      );
      void takeoverWork.catch(() => undefined);
      await waitForBlockedQuery({
        pid: takeover.pid,
        applicationName: takeoverName,
        blockerPids: [rowBlocker.pid],
        queryFragment: 'plan7a_operations_claim_job',
        operation: takeoverWork
      });
      await closeTransaction(rowBlocker);
      await waitForBlockedQuery({
        pid: takeover.pid,
        applicationName: takeoverName,
        blockerPids: [leaseBlocker.pid],
        queryFragment: 'plan7a_operations_claim_job',
        operation: takeoverWork
      });
      await closeTransaction(leaseBlocker);
      await waitForBlockedQuery({
        pid: takeover.pid,
        applicationName: takeoverName,
        blockerPids: [claimBlocker.pid],
        queryFragment: 'plan7a_operations_claim_job',
        operation: takeoverWork
      });
      await closeTransaction(claimBlocker);
      await waitForBlockedQuery({
        pid: takeover.pid,
        applicationName: takeoverName,
        blockerPids: [commandBlocker.pid],
        queryFragment: 'plan7a_operations_claim_job',
        operation: takeoverWork
      });
      await closeTransaction(commandBlocker);
      expect((await within(takeoverWork, 'Takeover did not clear its lock chain')).rows)
        .toMatchObject([{
          attempt: 2,
          lease_owner: 'operations-takeover-current',
          lease_generation: 2
        }]);
      await closeTransaction(takeover, 'commit');
      expect(await deadlockCount()).toBe(initialDeadlocks);
    } finally {
      for (const transaction of [
        rowBlocker,
        leaseBlocker,
        claimBlocker,
        commandBlocker,
        takeover
      ]) await closeTransaction(transaction).catch(() => undefined);
      await Promise.allSettled(takeoverWork === undefined ? [] : [takeoverWork]);
    }
  }, TEST_TIMEOUT_MS);

  it('enters a handler in role, shared-lease, command-row order', async () => {
    const actor = await createAdministrator('handler-lock-order');
    const target = await insertFailedTarget({
      kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
    });
    const fixture = await submitRetryCommand(actor, target, 'handler-lock-order');
    const clear = capability(`handler-lock-order-${fixture.commandId}`);
    const repository = createRepository({
      leaseMs: 60_000,
      capabilitySource: () => clear
    });
    const job = await repository.claimNext('operations-handler-lock-order');
    if (!job) throw new Error('Expected operations handler lock-order claim');

    const roleBlocker = await openOwnerTransaction(probeName('handler-role'));
    const leaseBlocker = await openOwnerTransaction(probeName('handler-lease'));
    const commandBlocker = await openOwnerTransaction(probeName('handler-command'));
    const handlerName = probeName('handler-lock-order');
    let handlerProbe: ProbeDatabase | undefined;
    let handling: Promise<void> | undefined;
    try {
      await roleBlocker.client.query(
        `select pg_catalog.pg_advisory_xact_lock(
           pg_catalog.hashtext('pale-orbit:user-roles:admin')
         )`
      );
      await lockOperationsLease(leaseBlocker, fixture.internalJobId);
      await lockCommandRow(commandBlocker, fixture.commandId);
      handlerProbe = probeDatabase(handlerName, 'worker');
      const handlerPid = await backendPid(handlerProbe.pool);
      handling = createOperationsHandler(handlerProbe.database)(
        job,
        new AbortController().signal
      );
      void handling.catch(() => undefined);
      await waitForBlockedQuery({
        pid: handlerPid,
        applicationName: handlerName,
        blockerPids: [roleBlocker.pid],
        queryFragment: 'plan7a_operations_lock_job_retry_command',
        operation: handling
      });
      await closeTransaction(roleBlocker);
      await waitForBlockedQuery({
        pid: handlerPid,
        applicationName: handlerName,
        blockerPids: [leaseBlocker.pid],
        queryFragment: 'plan7a_operations_lock_job_retry_command',
        operation: handling
      });
      const leaseLocks = await ownerDatabaseClient.pool.query<{
        granted: boolean;
        mode: string;
        pid: number;
      }>(`
        with lease_key as (
          select pg_catalog.hashtextextended(
            'pale-orbit:plan7a-operations-job-lease:' || $2::uuid::text, 0
          ) as value
        )
        select lock.pid, lock.mode, lock.granted
        from pg_catalog.pg_locks lock cross join lease_key
        where lock.pid = any($1::integer[])
          and lock.locktype = 'advisory'
          and lock.classid::bigint =
            ((lease_key.value >> 32) & 4294967295::bigint)
          and lock.objid::bigint =
            (lease_key.value & 4294967295::bigint)
        order by lock.pid, lock.granted desc, lock.mode
      `, [[leaseBlocker.pid, handlerPid], fixture.internalJobId]);
      expect(leaseLocks.rows).toEqual([
        { pid: leaseBlocker.pid, mode: 'ExclusiveLock', granted: true },
        { pid: handlerPid, mode: 'ShareLock', granted: false }
      ].sort((left, right) => left.pid - right.pid));
      await closeTransaction(leaseBlocker);
      await waitForBlockedQuery({
        pid: handlerPid,
        applicationName: handlerName,
        blockerPids: [commandBlocker.pid],
        queryFragment: 'plan7a_operations_lock_job_retry_command',
        operation: handling
      });
      await closeTransaction(commandBlocker);
      await within(handling, 'Handler did not clear its ordered locks');
      expect(await commandState(fixture.commandId)).toMatchObject({
        status: 'denied',
        resultCode: 'retry_policy_not_enabled',
        jobStatus: 'running',
        terminalAudits: 1
      });
      await expect(repository.completeOperationsJob(authority(job))).resolves.toBe(true);
    } finally {
      for (const transaction of [roleBlocker, leaseBlocker, commandBlocker]) {
        await closeTransaction(transaction).catch(() => undefined);
      }
      await cleanupProbeResources([
        { label: 'ordered operations handler', operation: handling }
      ], [handlerProbe]);
    }
  }, TEST_TIMEOUT_MS);

  it('locks a Stripe event before its failed job and rearms once', async () => {
    const actor = await createAdministrator('stripe-lock-order');
    const stripe = await createStripeTarget();
    const fixture = await submitRetryCommand(actor, stripe.target, 'stripe-lock-order');
    const eventBlocker = await openOwnerTransaction(probeName('stripe-event-lock'));
    const jobBlocker = await openOwnerTransaction(probeName('stripe-job-lock'));
    const adapterName = probeName('stripe-adapter-lock-order');
    let adapterProbe: ProbeDatabase | undefined;
    let adapterWork: Promise<JobRetryPolicyOutcome> | undefined;
    try {
      await eventBlocker.client.query(
        'select id from stripe_events where id = $1 for update',
        [stripe.stripeEventId]
      );
      await lockJobRow(jobBlocker, stripe.target.id);
      adapterProbe = probeDatabase(adapterName, 'worker');
      const adapterPid = await backendPid(adapterProbe.pool);
      const adapter = createStripeEventJobRetryPolicyAdapter();
      adapterWork = adapterProbe.database.transaction((transaction) => adapter({
        transaction,
        target: policyTarget(fixture),
        signal: new AbortController().signal
      }));
      void adapterWork.catch(() => undefined);
      await waitForBlockedQuery({
        pid: adapterPid,
        applicationName: adapterName,
        blockerPids: [eventBlocker.pid],
        queryFragment: 'stripe_events',
        operation: adapterWork
      });
      await closeTransaction(eventBlocker);
      await waitForBlockedQuery({
        pid: adapterPid,
        applicationName: adapterName,
        blockerPids: [jobBlocker.pid],
        queryFragment: 'from "public"."jobs"',
        operation: adapterWork
      });
      await closeTransaction(jobBlocker);
      await expect(within(adapterWork, 'Stripe adapter did not clear job lock'))
        .resolves.toEqual({ status: 'succeeded', resultCode: 'rearmed_existing' });
      expect(await targetState(stripe.target.id)).toMatchObject({
        status: 'pending',
        attempts: 0,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        completedAt: null
      });
    } finally {
      await closeTransaction(eventBlocker).catch(() => undefined);
      await closeTransaction(jobBlocker).catch(() => undefined);
      await cleanupProbeResources([
        { label: 'Stripe lock-order adapter', operation: adapterWork }
      ], [adapterProbe]);
    }
  }, TEST_TIMEOUT_MS);

  it('locks classification authority, enrollment, then its failed job', async () => {
    const actor = await createAdministrator('classification-lock-order');
    const target = await createClassificationTarget();
    const fixture = await submitRetryCommand(actor, target, 'classification-lock-order');
    const authorityBlocker = await openOwnerTransaction(
      probeName('classification-authority-lock')
    );
    const enrollmentBlocker = await openOwnerTransaction(
      probeName('classification-enrollment-lock')
    );
    const jobBlocker = await openOwnerTransaction(probeName('classification-job-lock'));
    const adapterName = probeName('classification-adapter-lock-order');
    let adapterProbe: ProbeDatabase | undefined;
    let adapterWork: Promise<JobRetryPolicyOutcome> | undefined;
    try {
      await authorityBlocker.client.query(
        `select singleton from financial_projection_versions
         where singleton = true for update`
      );
      await enrollmentBlocker.client.query(
        `select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
           'pale-orbit:financial:replay-enrollment', 0
         ))`
      );
      await lockJobRow(jobBlocker, target.id);
      adapterProbe = probeDatabase(adapterName, 'worker');
      const adapterPid = await backendPid(adapterProbe.pool);
      const adapter = createFinancialClassificationJobRetryPolicyAdapter();
      adapterWork = adapterProbe.database.transaction((transaction) => adapter({
        transaction,
        target: policyTarget(fixture),
        signal: new AbortController().signal
      }));
      void adapterWork.catch(() => undefined);
      await waitForBlockedQuery({
        pid: adapterPid,
        applicationName: adapterName,
        blockerPids: [authorityBlocker.pid],
        queryFragment: 'financial_projection_versions',
        operation: adapterWork
      });
      await closeTransaction(authorityBlocker);
      await waitForBlockedQuery({
        pid: adapterPid,
        applicationName: adapterName,
        blockerPids: [enrollmentBlocker.pid],
        queryFragment: 'pg_advisory_xact_lock',
        operation: adapterWork
      });
      await closeTransaction(enrollmentBlocker);
      await waitForBlockedQuery({
        pid: adapterPid,
        applicationName: adapterName,
        blockerPids: [jobBlocker.pid],
        queryFragment: 'from "public"."jobs"',
        operation: adapterWork
      });
      await closeTransaction(jobBlocker);
      await expect(within(
        adapterWork,
        'Classification adapter did not clear ordered locks'
      )).resolves.toEqual({ status: 'succeeded', resultCode: 'rearmed_existing' });
      expect(await targetState(target.id)).toMatchObject({
        status: 'pending',
        attempts: 0,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        completedAt: null
      });
    } finally {
      for (const transaction of [authorityBlocker, enrollmentBlocker, jobBlocker]) {
        await closeTransaction(transaction).catch(() => undefined);
      }
      await cleanupProbeResources([
        { label: 'classification lock-order adapter', operation: adapterWork }
      ], [adapterProbe]);
    }
  }, TEST_TIMEOUT_MS);

  it('holds administrator authority through execution while demotion waits', async () => {
    const actor = await createAdministrator('demotion-target');
    const manager = await createAdministrator('demotion-manager');
    const stripe = await createStripeTarget();
    const fixture = await submitRetryCommand(actor, stripe.target, 'demotion');
    const clear = capability(`demotion-${fixture.commandId}`);
    const repository = createRepository({
      leaseMs: 60_000,
      capabilitySource: () => clear
    });
    const job = await repository.claimNext('operations-demotion-handler');
    if (!job) throw new Error('Expected operations demotion claim');
    const entered = deferred();
    const release = deferred();
    const realAdapter = createStripeEventJobRetryPolicyAdapter();
    const pausedAdapter: JobRetryPolicyAdapter = async (context) => {
      entered.resolve();
      await release.promise;
      return realAdapter(context);
    };
    const handlerName = probeName('operations-demotion-handler');
    const demotionName = probeName('operations-demotion-waiter');
    let handlerProbe: ProbeDatabase | undefined;
    let demotionProbe: ProbeDatabase | undefined;
    let handling: Promise<void> | undefined;
    let demotion: Promise<readonly string[]> | undefined;
    try {
      handlerProbe = probeDatabase(handlerName, 'worker');
      demotionProbe = probeDatabase(demotionName, 'runtime');
      const handlerPid = await backendPid(handlerProbe.pool);
      const demotionPid = await backendPid(demotionProbe.pool);
      handling = createOperationsHandler(handlerProbe.database, {
        stripe: pausedAdapter
      })(job, new AbortController().signal);
      void handling.catch(() => undefined);
      await within(entered.promise, 'Operations handler did not enter paused adapter');
      await waitForIdleTransaction({
        pid: handlerPid,
        applicationName: handlerName,
        operation: handling
      });
      demotion = setAdminRole(demotionProbe.database, {
        actor: manager,
        targetUserId: actor.id,
        enabled: false,
        correlationId: `operations-demotion-${randomUUID()}`
      });
      void demotion.catch(() => undefined);
      await waitForBlockedQuery({
        pid: demotionPid,
        applicationName: demotionName,
        blockerPids: [handlerPid],
        queryFragment: 'pg_advisory_xact_lock',
        operation: demotion
      });
      release.resolve();
      await within(handling, 'Operations handler did not release demotion');
      await expect(within(demotion, 'Administrator demotion did not resume'))
        .resolves.not.toContain('admin');
      expect(await commandState(fixture.commandId)).toMatchObject({
        status: 'succeeded',
        resultCode: 'rearmed_existing',
        jobStatus: 'running',
        terminalAudits: 1
      });
      await expect(repository.completeOperationsJob(authority(job))).resolves.toBe(true);
    } finally {
      release.resolve();
      await cleanupProbeResources([
        { label: 'actor-demotion operations handler', operation: handling },
        { label: 'actor-demotion role change', operation: demotion }
      ], [handlerProbe, demotionProbe]);
    }
  }, TEST_TIMEOUT_MS);

  it('commits at most one racing Stripe effect and terminal audit without deadlock', async () => {
    const initialDeadlocks = await deadlockCount();
    const providerSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected provider call from operations race');
    });
    const actor = await createAdministrator('one-effect');
    const stripe = await createStripeTarget();
    const fixture = await submitRetryCommand(actor, stripe.target, 'one-effect');
    const clear = capability(`one-effect-${fixture.commandId}`);
    const repository = createRepository({
      leaseMs: 60_000,
      capabilitySource: () => clear
    });
    const job = await repository.claimNext('operations-one-effect');
    if (!job) throw new Error('Expected operations at-most-one claim');
    const commandBlocker = await openOwnerTransaction(probeName('one-effect-command'));
    const firstName = probeName('one-effect-first');
    const secondName = probeName('one-effect-second');
    let firstProbe: ProbeDatabase | undefined;
    let secondProbe: ProbeDatabase | undefined;
    let firstWork: Promise<void> | undefined;
    let secondWork: Promise<void> | undefined;
    try {
      await lockCommandRow(commandBlocker, fixture.commandId);
      firstProbe = probeDatabase(firstName, 'worker');
      secondProbe = probeDatabase(secondName, 'worker');
      const firstPid = await backendPid(firstProbe.pool);
      const secondPid = await backendPid(secondProbe.pool);
      const firstAdapter = vi.fn<JobRetryPolicyAdapter>(
        createStripeEventJobRetryPolicyAdapter()
      );
      const secondAdapter = vi.fn<JobRetryPolicyAdapter>(
        createStripeEventJobRetryPolicyAdapter()
      );
      firstWork = createOperationsHandler(firstProbe.database, {
        stripe: firstAdapter
      })(job, new AbortController().signal);
      void firstWork.catch(() => undefined);
      await waitForBlockedQuery({
        pid: firstPid,
        applicationName: firstName,
        blockerPids: [commandBlocker.pid],
        queryFragment: 'plan7a_operations_lock_job_retry_command',
        operation: firstWork
      });
      secondWork = createOperationsHandler(secondProbe.database, {
        stripe: secondAdapter
      })(job, new AbortController().signal);
      void secondWork.catch(() => undefined);
      await waitForBlockedQuery({
        pid: secondPid,
        applicationName: secondName,
        blockerPids: [firstPid],
        queryFragment: 'plan7a_operations_lock_job_retry_command',
        operation: secondWork
      });
      await closeTransaction(commandBlocker);
      await within(
        Promise.all([firstWork, secondWork]),
        'Racing operations handlers did not serialize'
      );
      expect(firstAdapter.mock.calls.length + secondAdapter.mock.calls.length).toBe(1);
      expect(await targetState(stripe.target.id)).toMatchObject({
        status: 'pending',
        attempts: 0,
        lastError: null
      });
      expect(await commandState(fixture.commandId)).toMatchObject({
        status: 'succeeded',
        resultCode: 'rearmed_existing',
        terminalAudits: 1
      });
      await expect(repository.completeOperationsJob(authority(job))).resolves.toBe(true);
      expect(providerSpy).not.toHaveBeenCalled();
      expect(await deadlockCount()).toBe(initialDeadlocks);
    } finally {
      await closeTransaction(commandBlocker).catch(() => undefined);
      await cleanupProbeResources([
        { label: 'first at-most-one handler', operation: firstWork },
        { label: 'second at-most-one handler', operation: secondWork }
      ], [firstProbe, secondProbe]);
    }
  }, TEST_TIMEOUT_MS);

  it('rolls back a rearm effect before handler commit', async () => {
    const actor = await createAdministrator('rollback-before-commit');
    const stripe = await createStripeTarget();
    const fixture = await submitRetryCommand(actor, stripe.target, 'rollback-before-commit');
    const clear = capability(`rollback-before-commit-${fixture.commandId}`);
    const repository = createRepository({
      leaseMs: 60_000,
      capabilitySource: () => clear
    });
    const job = await repository.claimNext('operations-rollback-before-commit');
    if (!job) throw new Error('Expected operations rollback claim');
    const beforeTarget = await targetState(stripe.target.id);
    const entered = deferred();
    const release = deferred();
    const realAdapter = createStripeEventJobRetryPolicyAdapter();
    const rollbackAdapter: JobRetryPolicyAdapter = async (context) => {
      const outcome = await realAdapter(context);
      expect(outcome).toEqual({
        status: 'succeeded',
        resultCode: 'rearmed_existing'
      });
      const tentative = await context.transaction.execute(sql<{
        attempts: number;
        completedAt: Date | null;
        lastError: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        status: string;
      }>`
        select status::text, attempts, locked_at as "lockedAt",
          locked_by as "lockedBy", last_error as "lastError",
          completed_at as "completedAt"
        from jobs where id = ${stripe.target.id}
      `);
      expect(tentative.rows).toMatchObject([{
        status: 'pending',
        attempts: 0,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        completedAt: null
      }]);
      entered.resolve();
      await release.promise;
      throw new DefiniteRetryableJobError();
    };
    const handlerName = probeName('rollback-before-commit-handler');
    let handlerProbe: ProbeDatabase | undefined;
    let handling: Promise<void> | undefined;
    try {
      handlerProbe = probeDatabase(handlerName, 'worker');
      const handlerPid = await backendPid(handlerProbe.pool);
      handling = createOperationsHandler(handlerProbe.database, {
        stripe: rollbackAdapter
      })(job, new AbortController().signal);
      void handling.catch(() => undefined);
      await within(entered.promise, 'Rollback adapter did not reach its barrier');
      await waitForIdleTransaction({
        pid: handlerPid,
        applicationName: handlerName,
        operation: handling
      });
      expect(await targetState(stripe.target.id)).toEqual(beforeTarget);
      expect(await commandState(fixture.commandId)).toMatchObject({
        status: 'pending',
        resultCode: null,
        jobStatus: 'running',
        claimState: 'active',
        terminalAudits: 0
      });
      release.resolve();
      await expect(within(handling, 'Rollback handler did not exit'))
        .rejects.toBeInstanceOf(DefiniteRetryableJobError);
      expect(await targetState(stripe.target.id)).toEqual(beforeTarget);
      expect(await commandState(fixture.commandId)).toMatchObject({
        status: 'pending',
        resultCode: null,
        jobStatus: 'running',
        claimState: 'active',
        terminalAudits: 0
      });
    } finally {
      release.resolve();
      await cleanupProbeResources([
        { label: 'rollback-before-commit handler', operation: handling }
      ], [handlerProbe]);
    }
  }, TEST_TIMEOUT_MS);

  it('replays with a fresh generation after terminal commit and crash before completion', async () => {
    const providerSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected provider call from operations crash replay');
    });
    const actor = await createAdministrator('crash-replay');
    const stripe = await createStripeTarget();
    const fixture = await submitRetryCommand(actor, stripe.target, 'crash-replay');
    const firstClear = capability(`crash-first-${fixture.commandId}`);
    const firstRepository = createRepository({
      leaseMs: 750,
      capabilitySource: () => firstClear
    });
    const firstJob = await firstRepository.claimNext('operations-crash-first');
    if (!firstJob) throw new Error('Expected first crash-replay claim');
    const firstAdapter = vi.fn<JobRetryPolicyAdapter>(
      createStripeEventJobRetryPolicyAdapter()
    );
    await createOperationsHandler(workerDatabaseClient.db, {
      stripe: firstAdapter
    })(firstJob, new AbortController().signal);
    expect(firstAdapter).toHaveBeenCalledOnce();
    const targetAfterCommit = await targetState(stripe.target.id);
    expect(targetAfterCommit).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await commandState(fixture.commandId)).toMatchObject({
      status: 'succeeded',
      resultCode: 'rearmed_existing',
      jobStatus: 'running',
      generation: 1,
      claimState: 'active',
      terminalAudits: 1
    });

    await waitUntilDue(fixture.internalJobId);
    const replayClear = capability(`crash-replay-${fixture.commandId}`);
    const replayRepository = createRepository({
      leaseMs: 5_000,
      capabilitySource: () => replayClear
    });
    const replayJob = await replayRepository.claimNext('operations-crash-replay');
    expect(replayJob).toMatchObject({
      id: fixture.internalJobId,
      attempts: 2,
      operationsJobLeaseGeneration: 2,
      operationsJobLeaseCapability: replayClear
    });
    if (!replayJob) throw new Error('Expected fresh-generation replay claim');
    const replayAdapter = vi.fn<JobRetryPolicyAdapter>(
      createStripeEventJobRetryPolicyAdapter()
    );
    await createOperationsHandler(workerDatabaseClient.db, {
      stripe: replayAdapter
    })(replayJob, new AbortController().signal);
    expect(replayAdapter).not.toHaveBeenCalled();
    expect(await targetState(stripe.target.id)).toEqual(targetAfterCommit);
    await expect(replayRepository.completeOperationsJob(authority(replayJob)))
      .resolves.toBe(true);
    expect(await commandState(fixture.commandId)).toMatchObject({
      status: 'succeeded',
      resultCode: 'rearmed_existing',
      jobStatus: 'succeeded',
      attempts: 2,
      generation: 2,
      claimState: 'invalidated',
      terminalAudits: 1
    });
    expect(providerSpy).not.toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);

  it.each([
    {
      name: 'pending',
      expectedCommandStatus: 'failed',
      expectedJobStatus: 'failed',
      expectedResultCode: 'retry_command_exhausted',
      expectedTerminalAction: 'operations.job_retry.failed',
      currentDuration: 4_321,
      currentOwner: 'operations-final-pending'
    },
    {
      name: 'already-terminal',
      expectedCommandStatus: 'denied',
      expectedJobStatus: 'succeeded',
      expectedResultCode: 'retry_policy_not_enabled',
      expectedTerminalAction: 'operations.job_retry.denied',
      currentDuration: 2_345,
      currentOwner: 'operations-final-terminal'
    }
  ] as const)(
    'rotates and consumes fresh final-attempt authority for $name commands',
    async (testCase) => {
      const actor = await createAdministrator(`final-${testCase.name}`);
      const target = await insertFailedTarget({
        kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
      });
      const fixture = await submitRetryCommand(
        actor,
        target,
        `final-${testCase.name}`
      );
      const priorDuration = 750;
      const priorJob = await advanceToFinalAttempt(fixture, priorDuration);
      const priorAuthority = authority(priorJob);
      const priorState = await ownerDatabaseClient.pool.query<{
        generation: number;
        issuedAt: Date;
        leaseDuration: number;
      }>(
        `select generation, issued_at as "issuedAt",
           lease_duration_ms as "leaseDuration"
         from operations_job_retry_claims where job_id = $1`,
        [fixture.internalJobId]
      );
      expect(priorState.rows[0]).toMatchObject({
        generation: 8,
        leaseDuration: priorDuration
      });

      if (testCase.name === 'already-terminal') {
        await createOperationsHandler(workerDatabaseClient.db)(
          priorJob,
          new AbortController().signal
        );
        expect(await commandState(fixture.commandId)).toMatchObject({
          status: 'denied',
          resultCode: 'retry_policy_not_enabled',
          jobStatus: 'running',
          terminalAudits: 1
        });
      } else {
        expect(await commandState(fixture.commandId)).toMatchObject({
          status: 'pending',
          resultCode: null,
          jobStatus: 'running',
          attempts: 8,
          generation: 8,
          claimState: 'active',
          terminalAudits: 0
        });
      }
      await waitUntilDue(fixture.internalJobId);

      const currentClear = capability(
        `final-consumed-${testCase.name}-${fixture.commandId}`
      );
      const currentRepository = createRepository({
        leaseMs: testCase.currentDuration,
        capabilitySource: () => currentClear
      });
      const beforeCall = (await ownerDatabaseClient.pool.query<{ now: Date }>(
        'select pg_catalog.clock_timestamp() as now'
      )).rows[0]!.now;
      await expect(currentRepository.claimNext(testCase.currentOwner))
        .resolves.toBeNull();
      const afterCall = (await ownerDatabaseClient.pool.query<{ now: Date }>(
        'select pg_catalog.clock_timestamp() as now'
      )).rows[0]!.now;

      const terminal = await ownerDatabaseClient.pool.query<{
        attempts: number;
        capabilitySha256: string;
        claimExpiresAt: Date;
        claimState: string;
        commandStatus: string;
        generation: number;
        invalidatedAt: Date | null;
        issuedAt: Date;
        jobExpiresAt: Date;
        jobStatus: string;
        leaseDuration: number;
        leaseOwner: string;
        maxAttempts: number;
        renewedAt: Date | null;
        resultCode: string;
        terminalActions: string[];
      }>(
        `select command.status::text as "commandStatus",
           command.safe_result_code::text as "resultCode",
           job.status::text as "jobStatus", job.attempts,
           job.max_attempts as "maxAttempts", job.run_at as "jobExpiresAt",
           claim.generation, claim.lease_owner as "leaseOwner",
           claim.capability_sha256 as "capabilitySha256",
           claim.lease_duration_ms as "leaseDuration",
           claim.state::text as "claimState", claim.issued_at as "issuedAt",
           claim.renewed_at as "renewedAt",
           claim.expires_at as "claimExpiresAt",
           claim.invalidated_at as "invalidatedAt",
           (select coalesce(pg_catalog.jsonb_agg(
              audit.action order by audit.id
            ), '[]'::jsonb)
            from audit_events audit
            where audit.resource_id = command.id::text
              and audit.action in (
                'operations.job_retry.succeeded',
                'operations.job_retry.denied',
                'operations.job_retry.failed'
              )) as "terminalActions"
         from operations_job_retry_commands command
         join jobs job
           on job.payload = pg_catalog.jsonb_build_object('commandId', command.id)
         join operations_job_retry_claims claim on claim.job_id = job.id
         where command.id = $1`,
        [fixture.commandId]
      );
      const state = terminal.rows[0];
      if (!state) throw new Error('Expected final-attempt terminal state');
      expect(state).toMatchObject({
        commandStatus: testCase.expectedCommandStatus,
        resultCode: testCase.expectedResultCode,
        jobStatus: testCase.expectedJobStatus,
        attempts: 8,
        maxAttempts: 8,
        generation: 9,
        leaseOwner: testCase.currentOwner,
        capabilitySha256: digest(currentClear),
        leaseDuration: testCase.currentDuration,
        claimState: 'invalidated',
        renewedAt: null,
        terminalActions: [testCase.expectedTerminalAction]
      });
      expect(state.generation).toBe(priorState.rows[0]!.generation + 1);
      expect(state.issuedAt.getTime())
        .toBeGreaterThan(priorState.rows[0]!.issuedAt.getTime());
      expect(state.issuedAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(state.issuedAt.getTime()).toBeLessThanOrEqual(afterCall.getTime());
      expect(state.claimExpiresAt.getTime() - state.issuedAt.getTime())
        .toBe(testCase.currentDuration);
      expect(state.jobExpiresAt).toEqual(state.claimExpiresAt);
      expect(state.invalidatedAt).not.toBeNull();
      expect(state.invalidatedAt!.getTime()).toBeGreaterThanOrEqual(state.issuedAt.getTime());

      const beforeRejections = await fullFinalAuthorityEvidence(fixture.commandId);
      await expectEveryPrivateOperationRejected(fixture, {
        clear: priorAuthority.capability,
        owner: priorAuthority.leaseOwner,
        generation: priorAuthority.generation
      });
      await expectEveryPrivateOperationRejected(fixture, {
        clear: currentClear,
        owner: testCase.currentOwner,
        generation: 9
      });
      expect(await fullFinalAuthorityEvidence(fixture.commandId))
        .toEqual(beforeRejections);
    },
    LONG_TEST_TIMEOUT_MS
  );
});
