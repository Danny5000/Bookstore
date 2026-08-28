import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import { submitFinancialAdminCommand } from
  '$lib/server/commerce/financial/admin-commands/repository';
import {
  OPERATIONS_JOB_RETRY_COMMAND_JOB,
  parseRegisteredJobDiagnosticMetadata,
  type RegisteredJobKind
} from '$lib/server/jobs/catalog';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { runWorker } from '$lib/server/jobs/runner';
import type {
  JobRecord,
  JobRepository,
  OperationsJobLeaseAuthority
} from '$lib/server/jobs/types';
import {
  createRunnerObserver,
  type RunnerObservation
} from '$lib/server/jobs/runner-observer';
import { createStructuredLogger } from '$lib/server/observability/logger';
import { createFinancialClassificationJobRetryPolicyAdapter } from
  '$lib/server/operations/jobs/adapters/financial-classification';
import { createStripeEventJobRetryPolicyAdapter } from
  '$lib/server/operations/jobs/adapters/stripe-event';
import {
  parseJobRetryCommandStatusDto,
  parseOperationalJobDto,
  prepareJobRetryCommand
} from '$lib/server/operations/jobs/contracts';
import { createOperationsJobRetryHandler } from
  '$lib/server/operations/jobs/handler';
import {
  createJobRetryPolicyAdapters,
  type JobRetryPolicyAdapter
} from '$lib/server/operations/jobs/policies';
import { createPostgresJobOperationsRepository } from
  '$lib/server/operations/jobs/repository';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  storageCleanupDatabaseClient,
  workerDatabaseClient
} from './database';

const OPERATIONS_CAPABILITY_CANARY = 'O'.repeat(43);
const FINANCIAL_CAPABILITY_CANARY = 'F'.repeat(43);
const OPERATIONS_CAPABILITY_DIGEST = digest(OPERATIONS_CAPABILITY_CANARY);
const FINANCIAL_CAPABILITY_DIGEST = digest(FINANCIAL_CAPABILITY_CANARY);
const AUTHORITY_ERROR = {
  code: '55000',
  message: 'Plan 7A operations job authority is not current'
} as const;

const PRIVATE_OPERATIONS_CALLS = Object.freeze([
  'select * from public.plan7a_operations_claim_job(null::uuid, null::text, null::integer)',
  'select * from public.plan7a_operations_renew_job_claim(null::uuid, null::text, null::integer, null::integer)',
  'select * from public.plan7a_operations_relinquish_job(null::uuid, null::text, null::integer, null::integer, null::text, null::integer)',
  'select * from public.plan7a_operations_complete_job(null::uuid, null::text, null::integer, null::integer)',
  'select * from public.plan7a_operations_fail_job(null::uuid, null::text, null::integer, null::integer, null::text)',
  'select * from public.plan7a_operations_exhaust_job(null::uuid, null::text, null::integer, null::integer)',
  'select * from public.plan7a_operations_lock_job_retry_command(null::uuid, null::uuid, null::text, null::integer, null::integer)',
  'select * from public.plan7a_operations_transition_job_retry_command(null::uuid, null::uuid, null::text, null::integer, null::integer, null::operations_job_retry_result_code)'
] as const);

interface FailedTarget {
  readonly attempts: number;
  readonly id: string;
  readonly kind: RegisteredJobKind;
  readonly maxAttempts: number;
  readonly updatedAt: string;
}

interface RetryFixture {
  readonly actor: AdministratorActor;
  readonly commandId: string;
  readonly internalJobId: string;
  readonly target: FailedTarget;
}

interface FinancialFixture {
  readonly internalJobId: string;
}

interface DatabaseErrorEvidence {
  readonly code?: string;
  readonly message?: string;
  readonly causes: readonly Readonly<Record<string, string>>[];
}

let fetchProviderSpy: ReturnType<typeof vi.spyOn>;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function databaseError(error: unknown): { code?: string; message?: string } {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== 'object') break;
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const code = descriptors.code?.value;
    const message = descriptors.message?.value;
    if (typeof code === 'string') {
      return typeof message === 'string' ? { code, message } : { code };
    }
    current = descriptors.cause?.value;
  }
  return {};
}

function errorEvidence(error: unknown): DatabaseErrorEvidence {
  const causes: Array<Readonly<Record<string, string>>> = [];
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== 'object') break;
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const evidence: Record<string, string> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'string') {
        evidence[key] = descriptor.value;
      }
    }
    causes.push(Object.freeze(evidence));
    current = descriptors.cause?.value;
  }
  return { ...databaseError(error), causes: Object.freeze(causes) };
}

async function expectDatabaseCode(
  operation: Promise<unknown>,
  expectedCode: string
): Promise<DatabaseErrorEvidence> {
  try {
    await operation;
    throw new Error('Expected database operation to fail');
  } catch (error) {
    const evidence = errorEvidence(error);
    expect(evidence.code === expectedCode, 'database error code was not expected')
      .toBe(true);
    return evidence;
  }
}

function serialized(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function expectClearCapabilitiesAbsent(label: string, value: unknown): void {
  const evidence = serialized(value);
  expect(
    evidence.includes(OPERATIONS_CAPABILITY_CANARY),
    `${label} contained the clear operations capability`
  ).toBe(false);
  expect(
    evidence.includes(FINANCIAL_CAPABILITY_CANARY),
    `${label} contained the clear financial capability`
  ).toBe(false);
}

function sameSerialized(left: unknown, right: unknown): boolean {
  return serialized(left) === serialized(right);
}

function labelsContaining(
  locations: Readonly<Record<string, string>>,
  value: string
): readonly string[] {
  return Object.entries(locations)
    .filter(([, evidence]) => evidence.includes(value))
    .map(([label]) => label)
    .sort();
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [id, `Plan 7A privacy ${label}`, `plan7a-privacy-${label}-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [id]
  );
  return { type: 'user', id, roles: ['admin'] };
}

async function createFailedTarget(input: {
  readonly attempts?: number;
  readonly deduplicationKey?: string | null;
  readonly kind?: RegisteredJobKind;
  readonly lastError?: string;
  readonly maxAttempts?: number;
  readonly payload?: unknown;
} = {}): Promise<FailedTarget> {
  const id = randomUUID();
  const result = await ownerDatabaseClient.pool.query<{ updated_at: string }>(
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
     ) as updated_at`,
    [
      id,
      input.kind ?? 'outbox.dispatch',
      JSON.stringify(input.payload ?? {}),
      input.deduplicationKey ?? null,
      input.attempts ?? 1,
      input.maxAttempts ?? 8,
      input.lastError ?? 'Outbox message does not exist'
    ]
  );
  return {
    attempts: input.attempts ?? 1,
    id,
    kind: input.kind ?? 'outbox.dispatch',
    maxAttempts: input.maxAttempts ?? 8,
    updatedAt: result.rows[0]!.updated_at
  };
}

async function createFailedStripeTarget(): Promise<FailedTarget> {
  const suffix = randomUUID().replaceAll('-', '');
  const providerEventId = `evt_plan7a_privacy_${suffix}`;
  const event = await databaseClient.pool.query<{ id: string }>(
    `insert into stripe_events (
       provider_event_id, event_type, object_id, live_mode,
       provider_created_at, raw_body_sha256
     ) values ($1, 'checkout.session.completed', $2, false,
       pg_catalog.clock_timestamp(), $3)
     returning id`,
    [
      providerEventId,
      `cs_plan7a_privacy_${suffix}`,
      digest(`plan7a-privacy-stripe-${suffix}`)
    ]
  );
  const stripeEventId = event.rows[0]?.id;
  if (!stripeEventId) throw new Error('Expected a privacy Stripe event');
  return createFailedTarget({
    kind: 'commerce.stripe-event',
    attempts: 12,
    maxAttempts: 12,
    payload: { stripeEventId },
    deduplicationKey: `stripe:event:${providerEventId}`,
    lastError: 'Stripe event no longer exists.'
  });
}

async function createRetryFixture(
  label: string,
  suppliedTarget?: FailedTarget
): Promise<RetryFixture> {
  const actor = await createAdministrator(`${label}-operations`);
  const target = suppliedTarget ?? await createFailedTarget();
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
  const submitted = await databaseClient.pool.query<{ command_id: string }>(
    `select * from public.submit_job_retry_command(
       $1::uuid, $2::uuid, $3::text, $4::integer, $5::integer,
       $6::timestamptz, 'dependency_recovered', $7::text, $8::text, $9::text
     )`,
    [
      actor.id,
      target.id,
      target.kind,
      target.attempts,
      target.maxAttempts,
      target.updatedAt,
      `plan7a-privacy-${label}-${randomUUID()}`,
      prepared.idempotencyKeySha256,
      prepared.inputFingerprintSha256
    ]
  );
  const commandId = submitted.rows[0]?.command_id;
  if (!commandId) throw new Error('Expected a privacy retry command');
  const internal = await ownerDatabaseClient.pool.query<{ id: string }>(
    `select id from jobs
     where type = 'operations.job-retry-command'
       and payload = pg_catalog.jsonb_build_object('commandId', $1::uuid)`,
    [commandId]
  );
  const internalJobId = internal.rows[0]?.id;
  if (!internalJobId) throw new Error('Expected a privacy operations job');
  return { actor, commandId, internalJobId, target };
}

async function createFinancialFixture(
  actor: AdministratorActor,
  label: string
): Promise<FinancialFixture> {
  const submitted = await submitFinancialAdminCommand(databaseClient.db, {
    actor,
    idempotencyKey: randomUUID(),
    command: {
      kind: 'refund_draft_save',
      refundId: randomUUID(),
      expectedVersion: null,
      items: [{ orderItemId: randomUUID(), totalPresentmentMinor: 100 }]
    },
    context: { correlationId: `plan7a-privacy-${label}-${randomUUID()}` }
  });
  const result = await ownerDatabaseClient.pool.query<{ id: string }>(
    `select id from jobs
     where type = 'commerce.financial-admin-command'
       and payload = pg_catalog.jsonb_build_object('commandId', $1::uuid)`,
    [submitted.commandId]
  );
  const internalJobId = result.rows[0]?.id;
  if (!internalJobId) throw new Error('Expected a privacy financial job');
  return { internalJobId };
}

function createRepository(input: {
  readonly financialCapability?: () => string;
  readonly operationsCapability?: () => string;
} = {}): JobRepository {
  return createPostgresJobRepository(
    workerDatabaseClient.db,
    { ...applicationConfig.jobs, leaseMs: 60_000 },
    undefined,
    'local-only',
    { classifierVersion: 1, allocationAlgorithmVersion: 2 },
    input.financialCapability,
    input.operationsCapability
  );
}

async function claimOperations(
  fixture: RetryFixture,
  capability: string,
  leaseOwner: string
): Promise<void> {
  const connection = await workerDatabaseClient.pool.connect();
  try {
    await connection.query('begin');
    await connection.query(
      `select pg_catalog.set_config(
         'pale_orbit.plan7a_operations_job_capability', $1, true
       )`,
      [capability]
    );
    const claimed = await connection.query(
      'select * from public.plan7a_operations_claim_job($1, $2, 60000)',
      [fixture.internalJobId, leaseOwner]
    );
    expect(claimed.rows.length, 'operations capability claim row count').toBe(1);
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function operationsAuthority(
  fixture: RetryFixture,
  capability: string,
  leaseOwner: string
): OperationsJobLeaseAuthority {
  return Object.freeze({
    jobId: fixture.internalJobId,
    leaseOwner,
    attempt: 1,
    maxAttempts: 8,
    generation: 1,
    capability
  });
}

async function workerCapabilityCall<Row extends QueryResultRow>(
  capability: string,
  text: string,
  parameters: readonly unknown[]
): Promise<readonly Row[]> {
  const connection = await workerDatabaseClient.pool.connect();
  try {
    await connection.query('begin');
    await connection.query(
      `select pg_catalog.set_config(
         'pale_orbit.plan7a_operations_job_capability', $1, true
       )`,
      [capability]
    );
    const result = await connection.query<Row>(text, [...parameters]);
    await connection.query('commit');
    return result.rows;
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function publicTableEvidence(): Promise<Readonly<Record<string, string>>> {
  const relations = await ownerDatabaseClient.pool.query<{ name: string }>(`
    select relation.relname as name
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'public'
      and relation.relkind in ('r', 'p')
    order by relation.relname
  `);
  const evidence: Record<string, string> = {};
  for (const { name } of relations.rows) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const result = await ownerDatabaseClient.pool.query<{ evidence: string }>(
      `select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_value)),
         '[]'::jsonb)::text as evidence
       from public.${quoted} row_value`
    );
    evidence[name] = result.rows[0]!.evidence;
  }
  return Object.freeze(evidence);
}

async function setForgerySettings(
  connection: PoolClient,
  input: {
    readonly commandId: string;
    readonly jobId: string;
  }
): Promise<void> {
  await connection.query(
    `select pg_catalog.set_config(
       'pale_orbit.plan7a_operations_command_insert_id', $1, true
     )`,
    [input.commandId]
  );
  await connection.query(
    `select pg_catalog.set_config(
       'pale_orbit.plan7a_operations_command_transition_id', $1, true
     )`,
    [input.commandId]
  );
  await connection.query(
    `select pg_catalog.set_config(
       'pale_orbit.plan7a_operations_job_transition_id', $1, true
     )`,
    [input.jobId]
  );
  await connection.query(
    `select pg_catalog.set_config(
       'pale_orbit.plan7a_operations_job_capability', $1, true
     )`,
    [OPERATIONS_CAPABILITY_CANARY]
  );
  await connection.query(
    `select pg_catalog.set_config(
       'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
     )`,
    [FINANCIAL_CAPABILITY_CANARY]
  );
}

async function protectedJobState(
  ordinaryJobId: string,
  operationsJobId: string
): Promise<unknown> {
  const result = await ownerDatabaseClient.pool.query<{ snapshot: unknown }>(`
    select pg_catalog.jsonb_build_object(
      'ordinary', (select pg_catalog.to_jsonb(job) from jobs job where job.id = $1),
      'operations', (select pg_catalog.to_jsonb(job) from jobs job where job.id = $2),
      'claim', (select pg_catalog.to_jsonb(claim)
        from operations_job_retry_claims claim where claim.job_id = $2)
    ) as snapshot
  `, [ordinaryJobId, operationsJobId]);
  return result.rows[0]!.snapshot;
}

beforeEach(() => {
  fetchProviderSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Unexpected provider call from Plan 7A privacy evidence');
  });
});

afterEach(() => {
  const providerCalls = fetchProviderSpy.mock.calls.length;
  fetchProviderSpy.mockRestore();
  expect(providerCalls, 'operations privacy evidence made a provider call').toBe(0);
});

describe('Plan 7A operations capability privacy', () => {
  it('leaves hostile capability accessors untouched during diagnostic and DTO mapping', () => {
    let accessorReads = 0;
    const capabilityAccessor = () => {
      accessorReads += 1;
      throw new Error('Hostile capability accessor was read');
    };
    const operationsJob = {
      id: randomUUID(),
      type: OPERATIONS_JOB_RETRY_COMMAND_JOB,
      payload: { commandId: randomUUID() },
      deduplicationKey: null,
      attempts: 1,
      maxAttempts: 8,
      lockedBy: 'privacy-accessor-worker'
    } as JobRecord;
    Object.defineProperties(operationsJob, {
      operationsJobLeaseCapability: {
        enumerable: true,
        get: capabilityAccessor
      },
      operationsJobLeaseGeneration: {
        enumerable: true,
        get: capabilityAccessor
      },
      financialAdminLeaseCapability: {
        enumerable: true,
        get: capabilityAccessor
      }
    });

    const diagnostic = parseRegisteredJobDiagnosticMetadata(operationsJob);
    expect(
      Object.keys(diagnostic).length === 0,
      'diagnostic metadata exposed a capability field'
    ).toBe(true);

    const operationalDto: Record<string, unknown> = {
      jobId: randomUUID(),
      kind: 'commerce.stripe-event',
      label: 'Stripe event',
      status: 'failed',
      attempts: 12,
      maxAttempts: 12,
      runAt: '2026-08-27T12:00:00.123456Z',
      completedAt: '2026-08-27T12:01:00.123456Z',
      createdAt: '2026-08-27T11:00:00.123456Z',
      updatedAt: '2026-08-27T12:01:00.123456Z',
      retryDisposition: 'rearm_existing',
      policyAvailability: 'enabled',
      safeFailureCode: 'source_unavailable'
    };
    Object.defineProperties(operationalDto, {
      operationsJobLeaseCapability: {
        enumerable: true,
        get: capabilityAccessor
      },
      financialAdminLeaseCapability: {
        enumerable: true,
        get: capabilityAccessor
      }
    });
    expect(() => parseOperationalJobDto(operationalDto)).toThrow(
      'Invalid job operations input'
    );

    const statusDto: Record<string, unknown> = {
      commandId: randomUUID(),
      kind: 'retry_failed_job',
      targetJobId: randomUUID(),
      targetKind: 'commerce.stripe-event',
      reasonCode: 'dependency_recovered',
      correlationId: 'plan7a-privacy-accessors',
      status: 'succeeded',
      resultCode: 'rearmed_existing',
      createdAt: '2026-08-27T12:00:00.123456Z',
      updatedAt: '2026-08-27T12:01:00.123456Z',
      completedAt: '2026-08-27T12:01:00.123456Z'
    };
    Object.defineProperties(statusDto, {
      operationsJobLeaseCapability: {
        enumerable: true,
        get: capabilityAccessor
      },
      financialAdminLeaseCapability: {
        enumerable: true,
        get: capabilityAccessor
      }
    });
    expect(() => parseJobRetryCommandStatusDto(statusDto)).toThrow(
      'Invalid job operations input'
    );
    expect(accessorReads).toBe(0);
  });

  it('denies runtime and cleanup reads and every private operations routine', async () => {
    const errors: DatabaseErrorEvidence[] = [];
    for (const [role, pool] of [
      ['runtime', databaseClient.pool],
      ['cleanup', storageCleanupDatabaseClient.pool]
    ] as const) {
      for (const table of [
        'operations_job_retry_commands',
        'operations_job_retry_claims'
      ]) {
        const error = await expectDatabaseCode(
          pool.query(`select * from public.${table}`),
          '42501'
        );
        expect(
          error.message?.includes('permission denied') === true,
          `${role} ${table} did not return the expected denial`
        ).toBe(true);
        errors.push(error);
      }
      for (const [index, call] of PRIVATE_OPERATIONS_CALLS.entries()) {
        const error = await expectDatabaseCode(pool.query(call), '42501');
        expect(
          error.message?.includes('permission denied') === true,
          `${role} private routine ${index} did not return the expected denial`
        ).toBe(true);
        errors.push(error);
      }
    }
    expectClearCapabilitiesAbsent('private authority errors and causes', errors);
  });

  it('persists only each designed digest and keeps clear canaries out of all safe evidence', async () => {
    const fixture = await createRetryFixture(
      'containment',
      await createFailedStripeTarget()
    );
    const stripePolicySpy = vi.fn<JobRetryPolicyAdapter>(
      createStripeEventJobRetryPolicyAdapter()
    );
    const classificationPolicySpy = vi.fn<JobRetryPolicyAdapter>(
      createFinancialClassificationJobRetryPolicyAdapter()
    );
    const handler = createOperationsJobRetryHandler({
      database: workerDatabaseClient.db,
      policies: createJobRetryPolicyAdapters({
        rearmPendingStripeEvent: stripePolicySpy,
        rearmFinancialClassification: classificationPolicySpy
      })
    });
    const repository = createRepository({
      financialCapability: () => FINANCIAL_CAPABILITY_CANARY,
      operationsCapability: () => OPERATIONS_CAPABILITY_CANARY
    });
    const observations: RunnerObservation[] = [];
    const slotProgress: RunnerObservation[] = [];
    const structuredLogLines: string[] = [];
    const logger = createStructuredLogger({
      service: 'worker',
      environment: 'test',
      now: () => new Date('2026-08-27T12:34:56.789Z'),
      stdout: (line) => structuredLogLines.push(line),
      stderr: (line) => structuredLogLines.push(line)
    });
    const productionObserver = createRunnerObserver({
      logger,
      reportSlotProgress: (observation) => slotProgress.push(observation)
    });
    const controller = new AbortController();
    let polls = 0;
    try {
      await runWorker({
        repository,
        handlers: new Map([[OPERATIONS_JOB_RETRY_COMMAND_JOB, handler]]),
        workerId: 'operations-privacy-canary-worker',
        concurrency: 1,
        pollIntervalMs: 1,
        leaseRenewalIntervalMs: 60_000,
        signal: controller.signal,
        parseJobDiagnosticMetadata: parseRegisteredJobDiagnosticMetadata,
        observer: (observation) => {
          observations.push(observation);
          productionObserver(observation);
        },
        beforePoll: async () => {
          polls += 1;
          if (polls === 2) controller.abort();
        }
      });
    } finally {
      controller.abort();
    }
    expect(stripePolicySpy.mock.calls.length, 'real Stripe retry policy call count')
      .toBe(1);
    expect(
      classificationPolicySpy.mock.calls.length,
      'unrelated classification retry policy call count'
    ).toBe(0);
    expect(structuredLogLines.length > 0, 'production observer emitted no records')
      .toBe(true);
    const logs = structuredLogLines.map(
      (line) => JSON.parse(line) as Readonly<Record<string, unknown>>
    );
    expect(logs.map((record) => record.event)).toEqual([
      'job.claimed',
      'job.succeeded'
    ]);

    const financialFixture = await createFinancialFixture(fixture.actor, 'containment');
    const financialJob = await repository.claimNext('financial-privacy-canary-worker');
    expect(
      financialJob?.id === financialFixture.internalJobId &&
        financialJob.type === 'commerce.financial-admin-command' &&
        financialJob.lockedBy === 'financial-privacy-canary-worker' &&
        financialJob.financialAdminLeaseCapability === FINANCIAL_CAPABILITY_CANARY,
      'financial claim did not carry the exact in-memory financial authority'
    ).toBe(true);
    expect(
      financialJob !== null && (
        Object.hasOwn(financialJob, 'operationsJobLeaseCapability') ||
        Object.hasOwn(financialJob, 'operationsJobLeaseGeneration')
      ),
      'financial claim exposed operations authority fields'
    ).toBe(false);

    const publicRepository = createPostgresJobOperationsRepository(databaseClient.db);
    const [listed, status] = await Promise.all([
      publicRepository.listOperationalJobs({ actorId: fixture.actor.id, limit: 100 }),
      publicRepository.getOwnedJobRetryCommand({
        actorId: fixture.actor.id,
        commandId: fixture.commandId
      })
    ]);
    expect(status).not.toBeNull();

    let rejectedError: DatabaseErrorEvidence | undefined;
    try {
      await workerCapabilityCall(
        FINANCIAL_CAPABILITY_CANARY,
        'select * from public.plan7a_operations_renew_job_claim($1, $2, 1, 1)',
        [fixture.internalJobId, 'operations-privacy-canary-worker']
      );
      throw new Error('Expected cross-capability renewal to fail');
    } catch (error) {
      rejectedError = errorEvidence(error);
    }
    expect(
      rejectedError?.code === AUTHORITY_ERROR.code &&
        rejectedError.message === AUTHORITY_ERROR.message,
      'cross-capability rejection was not the safe authority error'
    ).toBe(true);

    const tables = await publicTableEvidence();
    expect(labelsContaining(tables, OPERATIONS_CAPABILITY_CANARY)).toEqual([]);
    expect(labelsContaining(tables, FINANCIAL_CAPABILITY_CANARY)).toEqual([]);
    expect(labelsContaining(tables, OPERATIONS_CAPABILITY_DIGEST)).toEqual([
      'operations_job_retry_claims'
    ]);
    expect(labelsContaining(tables, FINANCIAL_CAPABILITY_DIGEST)).toEqual([
      'financial_admin_job_claims'
    ]);
    const digestPlacement = await ownerDatabaseClient.pool.query<{
      financialExactCount: number;
      financialUnexpectedCount: number;
      operationsExactCount: number;
      operationsUnexpectedCount: number;
    }>(`
      select
        (select pg_catalog.count(*)::integer
         from operations_job_retry_claims claim
         where claim.capability_sha256 = $1) as "operationsExactCount",
        (select pg_catalog.count(*)::integer
         from operations_job_retry_claims claim
         where (pg_catalog.to_jsonb(claim) - 'capability_sha256')::text
           like '%' || $1 || '%') as "operationsUnexpectedCount",
        (select pg_catalog.count(*)::integer
         from financial_admin_job_claims claim
         where claim.capability_sha256 = $2) as "financialExactCount",
        (select pg_catalog.count(*)::integer
         from financial_admin_job_claims claim
         where (pg_catalog.to_jsonb(claim) - 'capability_sha256')::text
           like '%' || $2 || '%') as "financialUnexpectedCount"
    `, [OPERATIONS_CAPABILITY_DIGEST, FINANCIAL_CAPABILITY_DIGEST]);
    expect(digestPlacement.rows).toEqual([{
      operationsExactCount: 1,
      operationsUnexpectedCount: 0,
      financialExactCount: 1,
      financialUnexpectedCount: 0
    }]);

    const catalog = await ownerDatabaseClient.pool.query<{ evidence: unknown }>(`
      select pg_catalog.jsonb_build_object(
        'catalog', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(catalog_row))
          from public.plan7a_operations_job_catalog() catalog_row),
        'routines', (select pg_catalog.jsonb_agg(pg_catalog.pg_get_functiondef(routine.oid))
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace_row
            on namespace_row.oid = routine.pronamespace
          where namespace_row.nspname = 'public'
            and (routine.proname like 'plan7a_operations_%'
              or routine.proname in (
                'list_operational_jobs', 'submit_job_retry_command',
                'get_owned_job_retry_command', 'plan6b_guard_job_insert',
                'plan6b_guard_audit_insert'
              )))
      ) as evidence
    `);
    const safeEvidence = {
      listed,
      status,
      observations,
      slotProgress,
      logs,
      error: rejectedError,
      catalog: catalog.rows
    };
    expectClearCapabilitiesAbsent('DTO, observation, log, error, and catalog evidence', safeEvidence);
    const serializedSafeEvidence = serialized(safeEvidence);
    expect(
      serializedSafeEvidence.includes(OPERATIONS_CAPABILITY_DIGEST),
      'safe evidence contained the operations capability digest'
    ).toBe(false);
    expect(
      serializedSafeEvidence.includes(FINANCIAL_CAPABILITY_DIGEST),
      'safe evidence contained the financial capability digest'
    ).toBe(false);
  });

  it('rejects operations and financial capabilities used across authorities without mutation', async () => {
    const fixture = await createRetryFixture('cross-authority');
    const operationsLeaseOwner = 'operations-cross-authority-worker';
    await claimOperations(
      fixture,
      OPERATIONS_CAPABILITY_CANARY,
      operationsLeaseOwner
    );
    const financialFixture = await createFinancialFixture(fixture.actor, 'cross-authority');
    const repository = createRepository({
      financialCapability: () => FINANCIAL_CAPABILITY_CANARY,
      operationsCapability: () => OPERATIONS_CAPABILITY_CANARY
    });
    const financialJob = await repository.claimNext('financial-cross-authority-worker');
    if (financialJob?.id !== financialFixture.internalJobId ||
      financialJob.financialAdminLeaseCapability !== FINANCIAL_CAPABILITY_CANARY) {
      throw new Error('Expected an exact financial capability claim');
    }

    const protectedState = async (): Promise<unknown> => (
      await ownerDatabaseClient.pool.query<{ snapshot: unknown }>(`
        select pg_catalog.jsonb_build_object(
          'operationsJob', (select pg_catalog.to_jsonb(job)
            from jobs job where job.id = $1),
          'operationsClaim', (select pg_catalog.to_jsonb(claim)
            from operations_job_retry_claims claim where claim.job_id = $1),
          'financialJob', (select pg_catalog.to_jsonb(job)
            from jobs job where job.id = $2),
          'financialClaim', (select pg_catalog.to_jsonb(claim)
            from financial_admin_job_claims claim where claim.job_id = $2)
        ) as snapshot
      `, [fixture.internalJobId, financialFixture.internalJobId])
    ).rows[0]!.snapshot;
    const baseline = await protectedState();

    await expect(repository.renewOperationsJobLease(operationsAuthority(
      fixture,
      FINANCIAL_CAPABILITY_CANARY,
      operationsLeaseOwner
    ))).resolves.toBe(false);
    await expect(repository.renewLease(
      financialJob.id,
      financialJob.lockedBy,
      OPERATIONS_CAPABILITY_CANARY
    )).resolves.toBe(false);
    expect(
      sameSerialized(await protectedState(), baseline),
      'cross-authority rejection mutated protected state'
    ).toBe(true);

    await expect(repository.renewOperationsJobLease(operationsAuthority(
      fixture,
      OPERATIONS_CAPABILITY_CANARY,
      operationsLeaseOwner
    ))).resolves.toBe(true);
    await expect(repository.renewLease(
      financialJob.id,
      financialJob.lockedBy,
      FINANCIAL_CAPABILITY_CANARY
    )).resolves.toBe(true);
  });
});

describe('Plan 7A reserved identity isolation', () => {
  it('rejects runtime and financial-worker orphan and cross-paired inserts with all GUCs', async () => {
    const commandId = randomUUID();
    const jobId = randomUUID();
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly text: string;
      readonly parameters: readonly unknown[];
    }> = [
      {
        label: 'orphan exact operations job identity',
        text: `insert into jobs (
          type, payload, deduplication_key, max_attempts
        ) values (
          'operations.job-retry-command',
          pg_catalog.jsonb_build_object('commandId', $1::uuid),
          'operations:job-retry-command:' || $1::uuid::text || ':v1', 8
        )`,
        parameters: [commandId]
      },
      {
        label: 'reserved type with ordinary deduplication identity',
        text: `insert into jobs (
          type, payload, deduplication_key, max_attempts
        ) values (
          'operations.job-retry-command', '{}'::jsonb,
          'privacy:ordinary', 8
        )`,
        parameters: []
      },
      {
        label: 'ordinary type with reserved deduplication identity',
        text: `insert into jobs (
          type, payload, deduplication_key, max_attempts
        ) values (
          'outbox.dispatch', '{}'::jsonb,
          'operations:job-retry-command:' || $1::uuid::text || ':v1', 8
        )`,
        parameters: [commandId]
      },
      {
        label: 'reserved audit action with ordinary resource identity',
        text: `insert into audit_events (
          actor_type, actor_id, action, outcome, resource_type,
          correlation_id
        ) values (
          'system', 'financial-worker', 'operations.job_retry.forged',
          'failed', 'job', 'plan7a-privacy-forged-action'
        )`,
        parameters: []
      },
      {
        label: 'ordinary audit action with reserved resource identity',
        text: `insert into audit_events (
          actor_type, actor_id, action, outcome, resource_type,
          correlation_id
        ) values (
          'system', 'financial-worker', 'commerce.refund_reconciled',
          'failed', 'operations_job_retry_command',
          'plan7a-privacy-forged-resource'
        )`,
        parameters: []
      }
    ];
    const residue = async (): Promise<unknown> => (
      await ownerDatabaseClient.pool.query(`
        select
          (select pg_catalog.count(*)::integer
             from operations_job_retry_commands) as commands,
          (select pg_catalog.count(*)::integer
             from operations_job_retry_claims) as claims,
          (select pg_catalog.count(*)::integer from jobs
             where type = 'operations.job-retry-command'
                or deduplication_key like 'operations:job-retry-command:%') as jobs,
          (select pg_catalog.count(*)::integer from audit_events
             where action like 'operations.job_retry.%'
                or resource_type = 'operations_job_retry_command') as audits
      `)
    ).rows[0];
    const baseline = await residue();
    const errors: DatabaseErrorEvidence[] = [];

    for (const [role, pool] of [
      ['runtime', databaseClient.pool],
      ['financial-worker', workerDatabaseClient.pool]
    ] as const) {
      for (const testCase of cases) {
        const connection = await pool.connect();
        try {
          await connection.query('begin');
          await setForgerySettings(connection, { commandId, jobId });
          const error = await expectDatabaseCode(
            connection.query(testCase.text, [...testCase.parameters]),
            '55000'
          );
          expect(
            typeof error.message === 'string' &&
              /(?:reserved|invalid operations job retry command identity)/u
                .test(error.message),
            `${role}: ${testCase.label} did not return the expected denial`
          ).toBe(true);
          errors.push(error);
        } finally {
          await connection.query('rollback').catch(() => undefined);
          connection.release();
        }
        expect(await residue(), `${role}: ${testCase.label}`).toEqual(baseline);
      }
    }
    expectClearCapabilitiesAbsent('reserved insert errors and causes', errors);
  });

  it('rejects runtime and financial-worker transitions into, out of, and across either reserved half', async () => {
    const fixture = await createRetryFixture('reserved-updates');
    const leaseOwner = 'operations-reserved-update-worker';
    await claimOperations(fixture, OPERATIONS_CAPABILITY_CANARY, leaseOwner);
    const ordinary = await createFailedTarget();
    const crossCommandId = randomUUID();
    const baseline = await protectedJobState(ordinary.id, fixture.internalJobId);
    const errors: DatabaseErrorEvidence[] = [];

    for (const [label, text, parameters] of [
      [
        'runtime into reserved type',
        "update jobs set type = 'operations.job-retry-command' where id = $1",
        [ordinary.id]
      ],
      [
        'runtime out of reserved type',
        "update jobs set type = 'outbox.dispatch' where id = $1",
        [fixture.internalJobId]
      ]
    ] as const) {
      const error = await expectDatabaseCode(
        databaseClient.pool.query(text, [...parameters]),
        '42501'
      );
      expect(
        error.message?.includes('permission denied') === true,
        `${label} did not return the expected denial`
      ).toBe(true);
      errors.push(error);
      expect(
        sameSerialized(
          await protectedJobState(ordinary.id, fixture.internalJobId),
          baseline
        ),
        `${label} mutated protected state`
      ).toBe(true);
    }

    const updateCases: ReadonlyArray<{
      readonly label: string;
      readonly text: string;
      readonly parameters: readonly unknown[];
      readonly jobId: string;
    }> = [
      {
        label: 'ordinary row into reserved type',
        text: "update jobs set type = 'operations.job-retry-command' where id = $1",
        parameters: [ordinary.id],
        jobId: ordinary.id
      },
      {
        label: 'ordinary row into reserved deduplication half',
        text: `update jobs set deduplication_key =
          'operations:job-retry-command:' || $2::uuid::text || ':v1'
          where id = $1`,
        parameters: [ordinary.id, fixture.commandId],
        jobId: ordinary.id
      },
      {
        label: 'ordinary row into both reserved halves',
        text: `update jobs set
          type = 'operations.job-retry-command',
          payload = pg_catalog.jsonb_build_object('commandId', $2::uuid),
          deduplication_key =
            'operations:job-retry-command:' || $2::uuid::text || ':v1'
          where id = $1`,
        parameters: [ordinary.id, fixture.commandId],
        jobId: ordinary.id
      },
      {
        label: 'operations row out of reserved type',
        text: "update jobs set type = 'outbox.dispatch' where id = $1",
        parameters: [fixture.internalJobId],
        jobId: fixture.internalJobId
      },
      {
        label: 'operations row out of reserved deduplication half',
        text: "update jobs set deduplication_key = 'privacy:ordinary' where id = $1",
        parameters: [fixture.internalJobId],
        jobId: fixture.internalJobId
      },
      {
        label: 'operations row out of both reserved halves',
        text: `update jobs set type = 'outbox.dispatch', payload = '{}'::jsonb,
          deduplication_key = 'privacy:ordinary' where id = $1`,
        parameters: [fixture.internalJobId],
        jobId: fixture.internalJobId
      },
      {
        label: 'operations row across reserved command pairing',
        text: `update jobs set
          payload = pg_catalog.jsonb_build_object('commandId', $2::uuid),
          deduplication_key =
            'operations:job-retry-command:' || $2::uuid::text || ':v1'
          where id = $1`,
        parameters: [fixture.internalJobId, crossCommandId],
        jobId: fixture.internalJobId
      }
    ];

    for (const testCase of updateCases) {
      const connection = await workerDatabaseClient.pool.connect();
      try {
        await connection.query('begin');
        await setForgerySettings(connection, {
          commandId: fixture.commandId,
          jobId: testCase.jobId
        });
        const error = await expectDatabaseCode(
          connection.query(testCase.text, [...testCase.parameters]),
          '55000'
        );
        expect(
          error.message?.includes('authority') === true,
          `${testCase.label} did not return the expected authority denial`
        ).toBe(true);
        errors.push(error);
      } finally {
        await connection.query('rollback').catch(() => undefined);
        connection.release();
      }
      expect(
        sameSerialized(
          await protectedJobState(ordinary.id, fixture.internalJobId),
          baseline
        ),
        `${testCase.label} mutated protected state`
      ).toBe(true);
    }
    expectClearCapabilitiesAbsent('reserved update errors and causes', errors);
  });
});
