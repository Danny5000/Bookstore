import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import { submitFinancialAdminCommand } from
  '$lib/server/commerce/financial/admin-commands/repository';
import { createFinancialClassificationSubjectJob } from
  '$lib/server/commerce/financial/jobs';
import {
  JOB_DEFINITIONS,
  JOB_RETRY_POLICY_OUTCOMES,
  OPERATIONS_JOB_RETRY_COMMAND_JOB,
  parseRegisteredJobDiagnosticMetadata,
  type JobDefinition,
  type JobRetryCommandResultCode,
  type JobRetryCommandStatus,
  type RegisteredJobKind
} from '$lib/server/jobs/catalog';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import {
  DefiniteRetryableJobError,
  PermanentJobError,
  runWorker
} from '$lib/server/jobs/runner';
import type {
  JobHandler,
  JobRecord,
  JobRepository,
  OperationsJobLeaseAuthority
} from '$lib/server/jobs/types';
import { createFinancialClassificationJobRetryPolicyAdapter } from
  '$lib/server/operations/jobs/adapters/financial-classification';
import { createStripeEventJobRetryPolicyAdapter } from
  '$lib/server/operations/jobs/adapters/stripe-event';
import { prepareJobRetryCommand } from '$lib/server/operations/jobs/contracts';
import { createOperationsJobRetryHandler } from '$lib/server/operations/jobs/handler';
import {
  createJobRetryPolicyAdapters,
  type JobRetryPolicyAdapter
} from '$lib/server/operations/jobs/policies';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient
} from './database';

const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{6}Z$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

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

interface CommandState {
  readonly command_status: JobRetryCommandStatus | 'pending';
  readonly result_code: JobRetryCommandResultCode | null;
  readonly command_completed_at: Date | null;
  readonly job_status: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly attempts: number;
  readonly max_attempts: number;
  readonly run_at: Date;
  readonly updated_at: Date;
  readonly last_error: string | null;
  readonly locked_by: string | null;
  readonly claim_state: 'active' | 'invalidated' | null;
  readonly terminal_audits: number;
}

interface RepositoryOptions {
  readonly leaseMs?: number;
  readonly retryMs?: number;
  readonly capabilitySource?: () => string;
}

function capability(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('base64url');
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function providerFetchSpy() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Unexpected provider call from operations recovery');
  });
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [id, `Operations worker ${label}`, `operations-${label}-${id}@example.test`]
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
     )
     returning pg_catalog.to_char(
       updated_at at time zone 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
     ) as updated_at`,
    [
      id,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.deduplicationKey ?? null,
      input.attempts,
      input.maxAttempts,
      input.lastError ?? 'Operations integration target failure'
    ]
  );
  const updatedAt = result.rows[0]!.updated_at;
  expect(updatedAt).toMatch(CANONICAL_TIMESTAMP);
  return {
    id,
    kind: input.kind,
    attempts: input.attempts,
    maxAttempts: input.maxAttempts,
    updatedAt
  };
}

async function readTarget(jobId: string): Promise<TargetSnapshot> {
  const result = await ownerDatabaseClient.pool.query<{
    id: string;
    kind: RegisteredJobKind;
    attempts: number;
    max_attempts: number;
    updated_at: string;
  }>(
    `select id, type as kind, attempts, max_attempts,
       pg_catalog.to_char(
         updated_at at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) as updated_at
     from jobs where id = $1`,
    [jobId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected operations target job');
  return {
    id: row.id,
    kind: row.kind,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    updatedAt: row.updated_at
  };
}

async function submitRetryCommand(
  actor: AdministratorActor,
  target: TargetSnapshot,
  label: string
): Promise<RetryFixture> {
  const correlationId = `operations-worker-${label}-${randomUUID()}`;
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
    `select command_id from public.submit_job_retry_command(
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
  const commandId = submitted.rows[0]?.command_id;
  if (!commandId) throw new Error('Expected submitted operations retry command');
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

function createRepository(options: RepositoryOptions = {}): JobRepository {
  const retryMs = options.retryMs ?? 1;
  return createPostgresJobRepository(
    workerDatabaseClient.db,
    {
      ...applicationConfig.jobs,
      leaseMs: options.leaseMs ?? 5_000,
      retryBaseMs: retryMs,
      retryMaxMs: retryMs
    },
    undefined,
    'local-only',
    { classifierVersion: 1, allocationAlgorithmVersion: 2 },
    undefined,
    options.capabilitySource
  );
}

function createOperationsHandler(input: {
  readonly stripe?: JobRetryPolicyAdapter;
  readonly classification?: JobRetryPolicyAdapter;
} = {}): JobHandler {
  const policies = createJobRetryPolicyAdapters({
    rearmPendingStripeEvent:
      input.stripe ?? createStripeEventJobRetryPolicyAdapter(),
    rearmFinancialClassification:
      input.classification ?? createFinancialClassificationJobRetryPolicyAdapter()
  });
  return createOperationsJobRetryHandler({
    database: workerDatabaseClient.db,
    policies
  });
}

function authority(job: JobRecord): OperationsJobLeaseAuthority {
  const capabilityValue = job.operationsJobLeaseCapability;
  const generation = job.operationsJobLeaseGeneration;
  if (capabilityValue === undefined || generation === undefined) {
    throw new Error('Expected operations lease authority on claimed job');
  }
  return Object.freeze({
    jobId: job.id,
    leaseOwner: job.lockedBy,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    generation,
    capability: capabilityValue
  });
}

async function runSingleClaim(input: {
  readonly repository: JobRepository;
  readonly handler: JobHandler;
  readonly workerId: string;
}): Promise<void> {
  const controller = new AbortController();
  let polls = 0;
  await runWorker({
    repository: input.repository,
    handlers: new Map([[OPERATIONS_JOB_RETRY_COMMAND_JOB, input.handler]]),
    workerId: input.workerId,
    concurrency: 1,
    pollIntervalMs: 1,
    leaseRenewalIntervalMs: 60_000,
    signal: controller.signal,
    parseJobDiagnosticMetadata: parseRegisteredJobDiagnosticMetadata,
    beforePoll: async () => {
      polls += 1;
      if (polls === 2) controller.abort();
    }
  });
}

async function commandState(commandId: string): Promise<CommandState> {
  const result = await ownerDatabaseClient.pool.query<CommandState>(
    `select command.status::text as command_status,
       command.safe_result_code::text as result_code,
       command.completed_at as command_completed_at,
       job.status::text as job_status, job.attempts, job.max_attempts,
       job.run_at, job.updated_at, job.last_error, job.locked_by,
       claim.state::text as claim_state,
       (select pg_catalog.count(*)::integer
          from audit_events audit
         where audit.resource_id = command.id::text
           and audit.action in (
             'operations.job_retry.succeeded',
             'operations.job_retry.denied',
             'operations.job_retry.failed'
           )) as terminal_audits
     from operations_job_retry_commands command
     join jobs job
       on job.payload = pg_catalog.jsonb_build_object('commandId', command.id)
     left join operations_job_retry_claims claim on claim.job_id = job.id
     where command.id = $1`,
    [commandId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected operations command state');
  return row;
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
  throw new Error('Operations job did not become due');
}

async function claimState(jobId: string) {
  const result = await ownerDatabaseClient.pool.query<{
    generation: number;
    attempt: number;
    lease_owner: string;
    capability_sha256: string;
    lease_duration_ms: number;
    state: 'active' | 'invalidated';
    issued_at: Date;
    renewed_at: Date | null;
    claim_expires_at: Date;
    locked_at: Date | null;
    updated_at: Date;
    job_expires_at: Date;
  }>(
    `select claim.generation, claim.attempt, claim.lease_owner,
       claim.capability_sha256, claim.lease_duration_ms,
       claim.state::text as state, claim.issued_at, claim.renewed_at,
       claim.expires_at as claim_expires_at,
       job.locked_at, job.updated_at, job.run_at as job_expires_at
     from operations_job_retry_claims claim
     join jobs job on job.id = claim.job_id
     where claim.job_id = $1`,
    [jobId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected operations claim state');
  return row;
}

async function terminalAudit(commandId: string) {
  return (await ownerDatabaseClient.pool.query<{
    action: string;
    outcome: string;
    correlation_id: string;
    request_metadata: unknown;
    before: unknown;
    after: unknown;
  }>(
    `select action, outcome, correlation_id, request_metadata, before, "after"
     from audit_events
     where resource_id = $1
       and action in (
         'operations.job_retry.succeeded',
         'operations.job_retry.denied',
         'operations.job_retry.failed'
       )
     order by id`,
    [commandId]
  )).rows;
}

async function createStripeTarget(input: {
  readonly attempts?: number;
  readonly sourcePresent?: boolean;
  readonly corruptPayload?: boolean;
  readonly corruptDeduplication?: boolean;
} = {}): Promise<TargetSnapshot> {
  const suffix = randomUUID().replaceAll('-', '');
  const providerEventId = `evt_operations_${suffix}`;
  let stripeEventId: string = randomUUID();
  if (input.sourcePresent !== false) {
    const event = await databaseClient.pool.query<{ id: string }>(
      `insert into stripe_events (
         provider_event_id, event_type, object_id, live_mode,
         provider_created_at, raw_body_sha256
       ) values ($1, 'checkout.session.completed', $2, false,
         pg_catalog.clock_timestamp(), $3)
       returning id`,
      [providerEventId, `cs_operations_${suffix}`, digest(`stripe-${suffix}`)]
    );
    stripeEventId = event.rows[0]!.id;
  }
  return insertFailedTarget({
    kind: 'commerce.stripe-event',
    attempts: input.attempts ?? 12,
    maxAttempts: 12,
    payload: input.corruptPayload ? {} : { stripeEventId },
    deduplicationKey: input.corruptDeduplication
      ? `stripe:event:corrupt-${suffix}`
      : `stripe:event:${providerEventId}`,
    lastError: 'Stripe event no longer exists.'
  });
}

async function createClassificationTarget(input: {
  readonly sourcePresent?: boolean;
  readonly classifierVersion?: number;
  readonly corruptDeduplication?: boolean;
} = {}): Promise<TargetSnapshot> {
  const suffix = randomUUID().replaceAll('-', '');
  const fingerprint = digest(`classification-${suffix}`);
  let subjectId: string = randomUUID();
  if (input.sourcePresent !== false) {
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
      [`txn_operations_${suffix}`, fingerprint]
    );
    subjectId = source.rows[0]!.id;
  }
  const spec = createFinancialClassificationSubjectJob({
    subjectType: 'balance_transaction',
    subjectId,
    sourceFingerprintSha256: fingerprint,
    classifierVersion: input.classifierVersion ?? 1,
    allocationAlgorithmVersion: 2
  });
  return insertFailedTarget({
    kind: spec.type,
    attempts: spec.maxAttempts,
    maxAttempts: spec.maxAttempts,
    payload: spec.payload,
    deduplicationKey: input.corruptDeduplication
      ? `${spec.deduplicationKey}:corrupt`
      : spec.deduplicationKey,
    lastError: 'Financial classification evidence is invalid.'
  });
}

async function createFailedFinancialAdminTarget(
  actor: AdministratorActor
): Promise<TargetSnapshot> {
  const submitted = await submitFinancialAdminCommand(databaseClient.db, {
    actor,
    idempotencyKey: randomUUID(),
    command: {
      kind: 'refund_draft_save',
      refundId: randomUUID(),
      expectedVersion: null,
      items: [{ orderItemId: randomUUID(), totalPresentmentMinor: 100 }]
    },
    context: { correlationId: `operations-financial-target-${randomUUID()}` }
  });
  const job = await ownerDatabaseClient.pool.query<{ id: string }>(
    `select id from jobs
     where type = 'commerce.financial-admin-command'
       and payload = pg_catalog.jsonb_build_object('commandId', $1::uuid)`,
    [submitted.commandId]
  );
  const jobId = job.rows[0]?.id;
  if (!jobId) throw new Error('Expected financial administrator target job');
  const repository = createRepository();
  const claimed = await repository.claimNext('operations-financial-target-worker');
  if (!claimed || claimed.id !== jobId || !claimed.financialAdminLeaseCapability) {
    throw new Error('Expected claimed financial administrator target');
  }
  expect(await repository.failWithDisposition(
    claimed.id,
    claimed.lockedBy,
    'Operations integration target failure',
    false,
    claimed.financialAdminLeaseCapability
  )).toEqual({ applied: true, retryScheduled: false });
  return readTarget(jobId);
}

async function createFailedOperationsTarget(
  actor: AdministratorActor
): Promise<TargetSnapshot> {
  const target = await insertFailedTarget({
    kind: 'outbox.dispatch',
    attempts: 1,
    maxAttempts: 8
  });
  const seed = await submitRetryCommand(actor, target, 'recursive-seed');
  const repository = createRepository({
    capabilitySource: () => capability(`recursive-seed-${seed.commandId}`)
  });
  const claimed = await repository.claimNext('operations-recursive-target-worker');
  if (!claimed || claimed.id !== seed.internalJobId) {
    throw new Error('Expected claimed recursive seed job');
  }
  expect(await repository.failOperationsJob(
    authority(claimed),
    'Operations job retry command permanently failed.',
    false
  )).toEqual({ applied: true, retryScheduled: false });
  return readTarget(seed.internalJobId);
}

describe('Plan 7A operations worker recovery policies', () => {
  it('keeps a fresh clear capability only in the claim and rotates every ordinary takeover field', async () => {
    const actor = await createAdministrator('claim-takeover');
    const target = await insertFailedTarget({
      kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
    });
    const fixture = await submitRetryCommand(actor, target, 'claim-takeover');
    const firstClear = capability(`first-${fixture.commandId}`);
    const firstRepository = createRepository({
      leaseMs: 25,
      capabilitySource: () => firstClear
    });
    const first = await firstRepository.claimNext('operations-claim-first');
    expect(first).toMatchObject({
      id: fixture.internalJobId,
      type: OPERATIONS_JOB_RETRY_COMMAND_JOB,
      attempts: 1,
      maxAttempts: 8,
      lockedBy: 'operations-claim-first',
      operationsJobLeaseCapability: firstClear,
      operationsJobLeaseGeneration: 1
    });
    expect(first?.operationsJobLeaseCapability).toMatch(CAPABILITY_PATTERN);
    expect(Reflect.ownKeys(first ?? {})).toContain('operationsJobLeaseCapability');
    const firstState = await claimState(fixture.internalJobId);
    expect(firstState).toMatchObject({
      generation: 1,
      attempt: 1,
      lease_owner: 'operations-claim-first',
      capability_sha256: digest(firstClear),
      lease_duration_ms: 25,
      state: 'active',
      renewed_at: null
    });
    expect(firstState.capability_sha256).toMatch(DIGEST_PATTERN);
    expect(firstState.issued_at).toEqual(firstState.locked_at);
    expect(firstState.issued_at).toEqual(firstState.updated_at);
    expect(firstState.claim_expires_at).toEqual(firstState.job_expires_at);
    expect(firstState.claim_expires_at.getTime() - firstState.issued_at.getTime())
      .toBe(25);
    const persisted = await ownerDatabaseClient.pool.query<{ evidence: string }>(
      `select pg_catalog.row_to_json(claim)::text ||
         pg_catalog.row_to_json(job)::text as evidence
       from operations_job_retry_claims claim
       join jobs job on job.id = claim.job_id
       where claim.job_id = $1`,
      [fixture.internalJobId]
    );
    expect(persisted.rows[0]!.evidence).not.toContain(firstClear);

    await waitUntilDue(fixture.internalJobId);
    const secondClear = capability(`second-${fixture.commandId}`);
    const secondRepository = createRepository({
      leaseMs: 4_321,
      capabilitySource: () => secondClear
    });
    const second = await secondRepository.claimNext('operations-claim-second');
    expect(second).toMatchObject({
      id: fixture.internalJobId,
      attempts: 2,
      lockedBy: 'operations-claim-second',
      operationsJobLeaseCapability: secondClear,
      operationsJobLeaseGeneration: 2
    });
    expect(secondClear).not.toBe(firstClear);
    const secondState = await claimState(fixture.internalJobId);
    expect(secondState).toMatchObject({
      generation: 2,
      attempt: 2,
      lease_owner: 'operations-claim-second',
      capability_sha256: digest(secondClear),
      lease_duration_ms: 4_321,
      state: 'active',
      renewed_at: null
    });
    expect(secondState.issued_at.getTime()).toBeGreaterThan(firstState.issued_at.getTime());
    expect(secondState.issued_at).toEqual(secondState.locked_at);
    expect(secondState.issued_at).toEqual(secondState.updated_at);
    expect(secondState.claim_expires_at).toEqual(secondState.job_expires_at);
    expect(secondState.claim_expires_at.getTime() - secondState.issued_at.getTime())
      .toBe(4_321);
  });

  it('renews only exact current authority from one database observation and leaves stale authority inert', async () => {
    const actor = await createAdministrator('renewal');
    const target = await insertFailedTarget({
      kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
    });
    const fixture = await submitRetryCommand(actor, target, 'renewal');
    const clear = capability(`renewal-${fixture.commandId}`);
    const repository = createRepository({
      leaseMs: 3_000,
      capabilitySource: () => clear
    });
    const claimed = await repository.claimNext('operations-renew-current');
    if (!claimed) throw new Error('Expected renewable operations claim');
    const exact = authority(claimed);
    const before = await claimState(fixture.internalJobId);
    const staleAuthorities = [
      { ...exact, leaseOwner: 'operations-renew-stale-owner' },
      { ...exact, attempt: 2 },
      { ...exact, generation: 2 },
      { ...exact, capability: capability(`forged-${fixture.commandId}`) }
    ] satisfies readonly OperationsJobLeaseAuthority[];
    for (const stale of staleAuthorities) {
      await expect(repository.renewOperationsJobLease(stale)).resolves.toBe(false);
      expect(await claimState(fixture.internalJobId)).toEqual(before);
    }

    await expect(repository.renewOperationsJobLease(exact)).resolves.toBe(true);
    const renewed = await claimState(fixture.internalJobId);
    expect(renewed.renewed_at).not.toBeNull();
    expect(renewed.renewed_at).toEqual(renewed.locked_at);
    expect(renewed.renewed_at).toEqual(renewed.updated_at);
    expect(renewed.claim_expires_at).toEqual(renewed.job_expires_at);
    expect(renewed.claim_expires_at.getTime() - renewed.renewed_at!.getTime())
      .toBe(3_000);

    const expiryTarget = await insertFailedTarget({
      kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
    });
    const expiryFixture = await submitRetryCommand(actor, expiryTarget, 'renew-expiry');
    const expiryClear = capability(`expiry-${expiryFixture.commandId}`);
    const expiryRepository = createRepository({
      leaseMs: 20,
      capabilitySource: () => expiryClear
    });
    const expiryClaim = await expiryRepository.claimNext('operations-renew-expired');
    if (!expiryClaim) throw new Error('Expected expiring operations claim');
    await waitUntilDue(expiryFixture.internalJobId);
    const expiredBefore = await claimState(expiryFixture.internalJobId);
    await expect(expiryRepository.renewOperationsJobLease(authority(expiryClaim)))
      .resolves.toBe(false);
    expect(await claimState(expiryFixture.internalJobId)).toEqual(expiredBefore);
  });

  it('rolls back a definite precommit failure, preserves database backoff, and rotates on retry', async () => {
    const actor = await createAdministrator('definite-retry');
    const target = await insertFailedTarget({
      kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
    });
    const fixture = await submitRetryCommand(actor, target, 'definite-retry');
    const issued = [
      capability(`definite-first-${fixture.commandId}`),
      capability(`definite-second-${fixture.commandId}`)
    ];
    let index = 0;
    const repository = createRepository({
      leaseMs: 5_000,
      retryMs: 7,
      capabilitySource: () => issued[index++]!
    });
    const handler = vi.fn<JobHandler>(async () => {
      throw new DefiniteRetryableJobError();
    });
    await runSingleClaim({
      repository,
      handler,
      workerId: 'operations-definite-first'
    });
    expect(handler).toHaveBeenCalledOnce();
    const pending = await commandState(fixture.commandId);
    expect(pending).toMatchObject({
      command_status: 'pending',
      result_code: null,
      command_completed_at: null,
      job_status: 'pending',
      attempts: 1,
      last_error: 'Transient job handler failure',
      locked_by: null,
      claim_state: 'invalidated',
      terminal_audits: 0
    });
    expect(pending.run_at.getTime() - pending.updated_at.getTime()).toBe(7);
    await waitUntilDue(fixture.internalJobId);
    const retried = await repository.claimNext('operations-definite-second');
    expect(retried).toMatchObject({
      attempts: 2,
      operationsJobLeaseCapability: issued[1],
      operationsJobLeaseGeneration: 2
    });
    expect(retried?.operationsJobLeaseCapability).not.toBe(issued[0]);
    expect((await claimState(fixture.internalJobId)).capability_sha256)
      .toBe(digest(issued[1]!));
  });

  it('bounds other permanent failures and maps corrupt enabled identities exactly', async () => {
    const actor = await createAdministrator('permanent');
    const providerSpy = providerFetchSpy();
    const corruptTarget = await createStripeTarget({ corruptPayload: true });
    const corrupt = await submitRetryCommand(actor, corruptTarget, 'invalid-identity');
    await runSingleClaim({
      repository: createRepository(),
      handler: createOperationsHandler(),
      workerId: 'operations-invalid-identity'
    });
    expect(await commandState(corrupt.commandId)).toMatchObject({
      command_status: 'failed',
      result_code: 'retry_command_invalid',
      job_status: 'failed',
      attempts: 1,
      last_error: 'Invalid operations job retry command identity.',
      claim_state: 'invalidated',
      terminal_audits: 1
    });

    const permanentTarget = await insertFailedTarget({
      kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
    });
    const permanent = await submitRetryCommand(actor, permanentTarget, 'permanent');
    const privateDetail = 'private permanent operations implementation detail';
    await runSingleClaim({
      repository: createRepository(),
      handler: async () => {
        throw new PermanentJobError(privateDetail);
      },
      workerId: 'operations-other-permanent'
    });
    const state = await commandState(permanent.commandId);
    expect(state).toMatchObject({
      command_status: 'failed',
      result_code: 'unexpected_failure',
      job_status: 'failed',
      attempts: 1,
      last_error: 'Operations job retry command permanently failed.',
      claim_state: 'invalidated',
      terminal_audits: 1
    });
    expect(JSON.stringify(state)).not.toContain(privateDetail);
    expect(providerSpy).not.toHaveBeenCalled();
  });

  it('exhausts retryable execution at eight attempts with fresh authority each time', async () => {
    const actor = await createAdministrator('exhaustion');
    const target = await insertFailedTarget({
      kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
    });
    const fixture = await submitRetryCommand(actor, target, 'exhaustion');
    const issued: string[] = [];
    let generation = 0;
    const postgresRepository = createRepository({
      retryMs: 1,
      capabilitySource: () => {
        const value = capability(`exhaustion-${fixture.commandId}-${++generation}`);
        issued.push(value);
        return value;
      }
    });
    const controller = new AbortController();
    const claims: JobRecord[] = [];
    const repository: JobRepository = {
      ...postgresRepository,
      async claimNext(workerId) {
        const claimed = await postgresRepository.claimNext(workerId);
        if (claimed) claims.push(claimed);
        return claimed;
      },
      async failOperationsJob(input, safeError, retryable) {
        const result = await postgresRepository.failOperationsJob(
          input,
          safeError,
          retryable
        );
        if (input.attempt === input.maxAttempts) controller.abort();
        return result;
      }
    };
    const handler = vi.fn<JobHandler>(async () => {
      throw new DefiniteRetryableJobError();
    });
    await runWorker({
      repository,
      handlers: new Map([[OPERATIONS_JOB_RETRY_COMMAND_JOB, handler]]),
      workerId: 'operations-exhaustion-worker',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 60_000,
      signal: controller.signal,
      parseJobDiagnosticMetadata: parseRegisteredJobDiagnosticMetadata
    });
    expect(claims.map((job) => job.attempts)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(claims.map((job) => job.operationsJobLeaseGeneration))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(handler).toHaveBeenCalledTimes(8);
    expect(issued).toHaveLength(8);
    expect(new Set(issued).size).toBe(8);
    expect(await commandState(fixture.commandId)).toMatchObject({
      command_status: 'failed',
      result_code: 'retry_command_exhausted',
      job_status: 'failed',
      attempts: 8,
      last_error: 'Operations job retry command exhausted.',
      claim_state: 'invalidated',
      terminal_audits: 1
    });
  }, 20_000);

  it('terminal-synchronizes one expired attempt-eight takeover with fresh invalidated authority', async () => {
    const actor = await createAdministrator('final-takeover');
    const target = await insertFailedTarget({
      kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
    });
    const fixture = await submitRetryCommand(actor, target, 'final-takeover');
    const earlyTokens = Array.from({ length: 7 }, (_, index) =>
      capability(`final-early-${fixture.commandId}-${index + 1}`));
    let earlyIndex = 0;
    const earlyRepository = createRepository({
      retryMs: 1,
      capabilitySource: () => earlyTokens[earlyIndex++]!
    });
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const claimed = await earlyRepository.claimNext(`operations-final-${attempt}`);
      expect(claimed).toMatchObject({
        attempts: attempt,
        operationsJobLeaseGeneration: attempt
      });
      expect(await earlyRepository.failOperationsJob(
        authority(claimed!),
        'Transient job handler failure',
        true
      )).toEqual({ applied: true, retryScheduled: true });
      await waitUntilDue(fixture.internalJobId);
    }

    const attemptEightClear = capability(`final-attempt-eight-${fixture.commandId}`);
    const attemptEightRepository = createRepository({
      leaseMs: 25,
      capabilitySource: () => attemptEightClear
    });
    const attemptEight = await attemptEightRepository.claimNext('operations-final-eight');
    expect(attemptEight).toMatchObject({
      attempts: 8,
      operationsJobLeaseGeneration: 8,
      operationsJobLeaseCapability: attemptEightClear
    });
    const before = await claimState(fixture.internalJobId);
    expect(before).toMatchObject({
      generation: 8,
      attempt: 8,
      lease_duration_ms: 25,
      state: 'active'
    });
    await waitUntilDue(fixture.internalJobId);

    const synchronizerClear = capability(`final-synchronizer-${fixture.commandId}`);
    const synchronizer = createRepository({
      leaseMs: 4_321,
      capabilitySource: () => synchronizerClear
    });
    await expect(synchronizer.claimNext('operations-final-synchronizer'))
      .resolves.toBeNull();
    const after = await claimState(fixture.internalJobId);
    expect(after).toMatchObject({
      generation: 9,
      attempt: 8,
      lease_owner: 'operations-final-synchronizer',
      capability_sha256: digest(synchronizerClear),
      lease_duration_ms: 4_321,
      state: 'invalidated',
      renewed_at: null
    });
    expect(after.issued_at.getTime()).toBeGreaterThan(before.issued_at.getTime());
    expect(after.claim_expires_at.getTime() - after.issued_at.getTime()).toBe(4_321);
    expect(await commandState(fixture.commandId)).toMatchObject({
      command_status: 'failed',
      result_code: 'retry_command_exhausted',
      job_status: 'failed',
      attempts: 8,
      last_error: 'Operations job retry command exhausted.',
      claim_state: 'invalidated',
      terminal_audits: 1
    });
    await expect(attemptEightRepository.renewOperationsJobLease(authority(attemptEight!)))
      .resolves.toBe(false);
    await expect(synchronizer.renewOperationsJobLease({
      jobId: fixture.internalJobId,
      leaseOwner: 'operations-final-synchronizer',
      attempt: 8,
      maxAttempts: 8,
      generation: 9,
      capability: synchronizerClear
    })).resolves.toBe(false);
  }, 20_000);

  it('denies execution after actor demotion and writes one terminal denial', async () => {
    const actor = await createAdministrator('demotion');
    const target = await insertFailedTarget({
      kind: 'outbox.dispatch', attempts: 1, maxAttempts: 8
    });
    const fixture = await submitRetryCommand(actor, target, 'demotion');
    await ownerDatabaseClient.pool.query(
      `delete from user_roles where user_id = $1 and role = 'admin'`,
      [actor.id]
    );
    await runSingleClaim({
      repository: createRepository(),
      handler: createOperationsHandler(),
      workerId: 'operations-demoted-actor'
    });
    expect(await commandState(fixture.commandId)).toMatchObject({
      command_status: 'denied',
      result_code: 'actor_not_authorized',
      job_status: 'succeeded',
      attempts: 1,
      last_error: null,
      claim_state: 'invalidated',
      terminal_audits: 1
    });
    expect(await terminalAudit(fixture.commandId)).toEqual([{
      action: 'operations.job_retry.denied',
      outcome: 'denied',
      correlation_id: fixture.correlationId,
      request_metadata: null,
      before: null,
      after: {
        commandId: fixture.commandId,
        targetJobId: target.id,
        registeredKind: target.kind,
        reasonCode: 'dependency_recovered',
        resultCode: 'actor_not_authorized'
      }
    }]);
  });

  it('settles exactly two excluded and seven disabled catalog policies without providers', async () => {
    const providerSpy = providerFetchSpy();
    const actor = await createAdministrator('fixed-policy-matrix');
    const excluded = JOB_DEFINITIONS.filter((definition) =>
      definition.retryPolicyAvailability === 'excluded');
    const disabled = JOB_DEFINITIONS.filter((definition) =>
      definition.retryPolicyAvailability === 'disabled');
    expect(excluded.map((definition) => definition.kind)).toEqual([
      'commerce.financial-admin-command',
      'operations.job-retry-command'
    ]);
    expect(disabled.map((definition) => definition.kind)).toEqual([
      'outbox.dispatch',
      'commerce.claim-email',
      'commerce.claim-email-request',
      'commerce.financial-source',
      'commerce.financial-payout',
      'commerce.financial-scan',
      'catalog.ingest_revision'
    ]);
    expect(JOB_DEFINITIONS.map((definition) => String(definition.retryPolicyId)))
      .not.toContain('deny_provider_recovery_not_enabled');
    expect(JOB_RETRY_POLICY_OUTCOMES).toContainEqual([
      'deny_provider_recovery_not_enabled',
      'denied',
      'provider_recovery_not_enabled'
    ]);

    const targetForDefinition = async (
      definition: JobDefinition
    ): Promise<TargetSnapshot> => {
      if (definition.kind === 'commerce.financial-admin-command') {
        return createFailedFinancialAdminTarget(actor);
      }
      if (definition.kind === OPERATIONS_JOB_RETRY_COMMAND_JOB) {
        return createFailedOperationsTarget(actor);
      }
      return insertFailedTarget({
        kind: definition.kind,
        attempts: 1,
        maxAttempts: definition.maxAttempts
      });
    };
    const cases = [
      ...excluded.map((definition) => ({
        definition,
        resultCode: 'retry_not_supported' as const
      })),
      ...disabled.map((definition) => ({
        definition,
        resultCode: 'retry_policy_not_enabled' as const
      }))
    ];
    for (const [index, policyCase] of cases.entries()) {
      const target = await targetForDefinition(policyCase.definition);
      const fixture = await submitRetryCommand(
        actor,
        target,
        `fixed-policy-${index}`
      );
      await runSingleClaim({
        repository: createRepository(),
        handler: createOperationsHandler(),
        workerId: `operations-fixed-policy-${index}`
      });
      expect(await commandState(fixture.commandId)).toMatchObject({
        command_status: 'denied',
        result_code: policyCase.resultCode,
        job_status: 'succeeded',
        attempts: 1,
        last_error: null,
        claim_state: 'invalidated',
        terminal_audits: 1
      });
    }
    expect(providerSpy).not.toHaveBeenCalled();
  }, 30_000);

  it('maps every exact, stale, missing, nonretryable, and corrupt Stripe case', async () => {
    const providerSpy = providerFetchSpy();
    const actor = await createAdministrator('stripe-matrix');
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly target: () => Promise<TargetSnapshot>;
      readonly mutate?: (target: TargetSnapshot) => Promise<void>;
      readonly status: JobRetryCommandStatus;
      readonly resultCode: JobRetryCommandResultCode;
      readonly targetStatus: 'pending' | 'failed';
    }> = [
      {
        label: 'exact',
        target: () => createStripeTarget(),
        status: 'succeeded',
        resultCode: 'rearmed_existing',
        targetStatus: 'pending'
      },
      {
        label: 'stale',
        target: () => createStripeTarget(),
        mutate: async (target) => {
          await ownerDatabaseClient.pool.query(
            `update jobs set updated_at = updated_at + interval '1 second'
             where id = $1`,
            [target.id]
          );
        },
        status: 'denied',
        resultCode: 'target_state_changed',
        targetStatus: 'failed'
      },
      {
        label: 'missing-source',
        target: () => createStripeTarget({ sourcePresent: false }),
        status: 'denied',
        resultCode: 'source_unavailable',
        targetStatus: 'failed'
      },
      {
        label: 'nonretryable',
        target: () => createStripeTarget({ attempts: 1 }),
        status: 'denied',
        resultCode: 'domain_state_not_retryable',
        targetStatus: 'failed'
      },
      {
        label: 'corrupt',
        target: () => createStripeTarget({ corruptDeduplication: true }),
        status: 'failed',
        resultCode: 'retry_command_invalid',
        targetStatus: 'failed'
      }
    ];
    for (const [index, policyCase] of cases.entries()) {
      const target = await policyCase.target();
      const fixture = await submitRetryCommand(
        actor,
        target,
        `stripe-${policyCase.label}`
      );
      await policyCase.mutate?.(target);
      await runSingleClaim({
        repository: createRepository(),
        handler: createOperationsHandler(),
        workerId: `operations-stripe-${index}`
      });
      const state = await commandState(fixture.commandId);
      expect(state).toMatchObject({
        command_status: policyCase.status,
        result_code: policyCase.resultCode,
        job_status: policyCase.status === 'failed' ? 'failed' : 'succeeded',
        terminal_audits: 1
      });
      if (policyCase.status === 'failed') {
        expect(state.last_error).toBe('Invalid operations job retry command identity.');
      }
      const targetState = await ownerDatabaseClient.pool.query<{
        status: string;
        attempts: number;
      }>('select status::text, attempts from jobs where id = $1', [target.id]);
      expect(targetState.rows[0]!.status).toBe(policyCase.targetStatus);
      if (policyCase.targetStatus === 'pending') {
        expect(targetState.rows[0]!.attempts).toBe(0);
      }
    }
    expect(providerSpy).not.toHaveBeenCalled();
  }, 20_000);

  it('maps every exact, stale, missing, nonretryable, and corrupt classification case', async () => {
    const providerSpy = providerFetchSpy();
    const actor = await createAdministrator('classification-matrix');
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly target: () => Promise<TargetSnapshot>;
      readonly mutate?: (target: TargetSnapshot) => Promise<void>;
      readonly status: JobRetryCommandStatus;
      readonly resultCode: JobRetryCommandResultCode;
      readonly targetStatus: 'pending' | 'failed';
    }> = [
      {
        label: 'stale',
        target: () => createClassificationTarget(),
        mutate: async (target) => {
          await ownerDatabaseClient.pool.query(
            `update jobs set updated_at = updated_at + interval '1 second'
             where id = $1`,
            [target.id]
          );
        },
        status: 'denied',
        resultCode: 'target_state_changed',
        targetStatus: 'failed'
      },
      {
        label: 'missing-source',
        target: () => createClassificationTarget({ sourcePresent: false }),
        status: 'denied',
        resultCode: 'source_unavailable',
        targetStatus: 'failed'
      },
      {
        label: 'nonretryable',
        target: () => createClassificationTarget({ classifierVersion: 2 }),
        status: 'denied',
        resultCode: 'domain_state_not_retryable',
        targetStatus: 'failed'
      },
      {
        label: 'corrupt',
        target: () => createClassificationTarget({ corruptDeduplication: true }),
        status: 'failed',
        resultCode: 'retry_command_invalid',
        targetStatus: 'failed'
      },
      {
        label: 'exact',
        target: () => createClassificationTarget(),
        status: 'succeeded',
        resultCode: 'rearmed_existing',
        targetStatus: 'pending'
      }
    ];
    for (const [index, policyCase] of cases.entries()) {
      const target = await policyCase.target();
      const fixture = await submitRetryCommand(
        actor,
        target,
        `classification-${policyCase.label}`
      );
      await policyCase.mutate?.(target);
      await runSingleClaim({
        repository: createRepository(),
        handler: createOperationsHandler(),
        workerId: `operations-classification-${index}`
      });
      const state = await commandState(fixture.commandId);
      expect(state).toMatchObject({
        command_status: policyCase.status,
        result_code: policyCase.resultCode,
        job_status: policyCase.status === 'failed' ? 'failed' : 'succeeded',
        terminal_audits: 1
      });
      if (policyCase.status === 'failed') {
        expect(state.last_error).toBe('Invalid operations job retry command identity.');
      }
      const targetState = await ownerDatabaseClient.pool.query<{
        status: string;
        attempts: number;
      }>('select status::text, attempts from jobs where id = $1', [target.id]);
      expect(targetState.rows[0]!.status).toBe(policyCase.targetStatus);
      if (policyCase.targetStatus === 'pending') {
        expect(targetState.rows[0]!.attempts).toBe(0);
      }
    }
    expect(providerSpy).not.toHaveBeenCalled();
  }, 20_000);

  it('replays a terminal command without a second policy effect, audit, or provider call', async () => {
    const providerSpy = providerFetchSpy();
    const actor = await createAdministrator('terminal-replay');
    const target = await createStripeTarget();
    const fixture = await submitRetryCommand(actor, target, 'terminal-replay');
    const clear = capability(`terminal-replay-${fixture.commandId}`);
    const repository = createRepository({ capabilitySource: () => clear });
    const claimed = await repository.claimNext('operations-terminal-replay');
    if (!claimed) throw new Error('Expected terminal replay command claim');
    const stripeAdapter = vi.fn<JobRetryPolicyAdapter>(
      createStripeEventJobRetryPolicyAdapter()
    );
    const handler = createOperationsHandler({ stripe: stripeAdapter });
    await handler(claimed, new AbortController().signal);
    expect(await commandState(fixture.commandId)).toMatchObject({
      command_status: 'succeeded',
      result_code: 'rearmed_existing',
      job_status: 'running',
      terminal_audits: 1
    });
    expect(stripeAdapter).toHaveBeenCalledOnce();
    const firstAudit = await terminalAudit(fixture.commandId);
    const firstTarget = await ownerDatabaseClient.pool.query(
      'select status::text, attempts, updated_at from jobs where id = $1',
      [target.id]
    );

    await handler(claimed, new AbortController().signal);
    expect(stripeAdapter).toHaveBeenCalledOnce();
    expect(await terminalAudit(fixture.commandId)).toEqual(firstAudit);
    expect((await ownerDatabaseClient.pool.query(
      'select status::text, attempts, updated_at from jobs where id = $1',
      [target.id]
    )).rows).toEqual(firstTarget.rows);
    await expect(repository.completeOperationsJob(authority(claimed)))
      .resolves.toBe(true);
    expect(await commandState(fixture.commandId)).toMatchObject({
      command_status: 'succeeded',
      result_code: 'rearmed_existing',
      job_status: 'succeeded',
      claim_state: 'invalidated',
      terminal_audits: 1
    });
    expect(providerSpy).not.toHaveBeenCalled();
  });
});
