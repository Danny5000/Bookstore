import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  AuthorizationError,
  type AdminCapability,
  type AdministratorActor,
  type CapabilityResolver
} from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import * as schema from '$lib/server/db/schema';
import type { CorrelationId } from '$lib/server/observability/contracts';
import type { JobRetryCommandInput } from '$lib/server/operations/jobs/contracts';
import { JobRetryCommandSubmissionConflictError } from '$lib/server/operations/jobs/repository';
import {
  getOwnedJobRetryCommand,
  listOperationalJobs,
  submitJobRetryCommand
} from '$lib/server/operations/jobs/service';
import { databaseClient, ownerDatabaseClient } from './database';

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{6}Z$/u;
const TARGET_CREATED_AT = '2026-08-26T12:34:55.123455Z';
const TARGET_UPDATED_AT = '2026-08-26T12:34:56.123456Z';

interface FailedTarget {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AuditRow extends QueryResultRow {
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly resource_type: string;
  readonly resource_id: string | null;
  readonly correlation_id: string;
  readonly request_metadata: unknown;
  readonly before: unknown;
  readonly after: unknown;
}

interface OperationsInventory extends QueryResultRow {
  readonly commands: number;
  readonly command_jobs: number;
  readonly succeeded_audits: number;
  readonly denied_audits: number;
  readonly operations_audits: number;
}

type SubmissionOutcome =
  | { readonly status: 'resolved'; readonly value: unknown }
  | { readonly status: 'rejected'; readonly error: unknown };

function correlationId(prefix: string): CorrelationId {
  return `${prefix}-${randomUUID()}` as CorrelationId;
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [id, `Job operations ${label}`, `job-operations-${label}-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [id]
  );
  return { type: 'user', id, roles: ['admin'] };
}

async function createFailedTarget(
  updatedAt = TARGET_UPDATED_AT
): Promise<FailedTarget> {
  const id = randomUUID();
  const result = await ownerDatabaseClient.pool.query<{
    created_at: string;
    updated_at: string;
  }>(
    `insert into jobs (
       id, type, payload, status, run_at, attempts, max_attempts, last_error,
       completed_at, created_at, updated_at
     ) values (
       $1, 'outbox.dispatch', '{}'::jsonb, 'failed', $2::timestamptz, 1, 8,
       'Outbox message does not exist', $2::timestamptz,
       $3::timestamptz, $2::timestamptz
     ) returning
       to_char(timezone('UTC', created_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
       to_char(timezone('UTC', updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`,
    [id, updatedAt, TARGET_CREATED_AT]
  );
  return {
    id,
    createdAt: result.rows[0]!.created_at,
    updatedAt: result.rows[0]!.updated_at
  };
}

function retryCommand(
  target: FailedTarget,
  idempotencyKey = randomUUID(),
  reasonCode: JobRetryCommandInput['reasonCode'] = 'dependency_recovered'
): JobRetryCommandInput {
  return {
    idempotencyKey,
    targetJobId: target.id,
    expectedKind: 'outbox.dispatch',
    expectedStatus: 'failed',
    expectedAttempts: 1,
    expectedMaxAttempts: 8,
    expectedUpdatedAt: target.updatedAt,
    reasonCode
  };
}

async function auditRows(correlation: CorrelationId): Promise<readonly AuditRow[]> {
  return (await ownerDatabaseClient.pool.query<AuditRow>(
    `select actor_type::text, actor_id, action, outcome::text, resource_type,
       resource_id, correlation_id, request_metadata, before, after
     from audit_events where correlation_id = $1 order by occurred_at, id`,
    [correlation]
  )).rows;
}

function deniedAudit(actor: AdministratorActor, correlation: CorrelationId): AuditRow {
  return {
    actor_type: 'user',
    actor_id: actor.id,
    action: 'operations.job_retry.requested',
    outcome: 'denied',
    resource_type: 'operations_job_retry_command',
    resource_id: null,
    correlation_id: correlation,
    request_metadata: null,
    before: null,
    after: null
  };
}

async function operationsInventory(): Promise<OperationsInventory> {
  return (await ownerDatabaseClient.pool.query<OperationsInventory>(`
    select
      (select count(*)::integer from operations_job_retry_commands) as commands,
      (select count(*)::integer from jobs
        where type = 'operations.job-retry-command') as command_jobs,
      (select count(*)::integer from audit_events
        where action = 'operations.job_retry.requested'
          and outcome = 'succeeded') as succeeded_audits,
      (select count(*)::integer from audit_events
        where action = 'operations.job_retry.requested'
          and outcome = 'denied') as denied_audits,
      (select count(*)::integer from audit_events
        where action like 'operations.job_retry.%') as operations_audits
  `)).rows[0]!;
}

async function rejected(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject');
}

function expectFixedForbidden(error: unknown): void {
  expect(error).toEqual(new AuthorizationError('forbidden', 403));
  expect(error).toMatchObject({
    name: 'AuthorizationError',
    message: 'forbidden',
    code: 'forbidden',
    status: 403
  });
  expect(Object.hasOwn(error as object, 'cause')).toBe(false);
  expect(Object.hasOwn(error as object, 'query')).toBe(false);
  expect(Object.hasOwn(error as object, 'params')).toBe(false);
  expect(JSON.stringify(error)).not.toMatch(/capability is not current|submit_job_retry_command/iu);
}

async function expectFixedConflict(operation: Promise<unknown>): Promise<void> {
  const error = await rejected(operation);
  expect(error).toEqual(new JobRetryCommandSubmissionConflictError());
  expect(error).toMatchObject({
    name: 'JobRetryCommandSubmissionConflictError',
    message: 'The job retry command conflicts with current state.',
    code: 'conflict'
  });
  expect(Object.hasOwn(error as object, 'cause')).toBe(false);
  expect(Object.hasOwn(error as object, 'query')).toBe(false);
  expect(Object.hasOwn(error as object, 'params')).toBe(false);
  expect(JSON.stringify(error)).not.toMatch(/idempotency conflict|target state conflict/iu);
}

function postgresError(error: unknown): { readonly code?: string; readonly message?: string } {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== 'object') break;
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof record.code === 'string') {
      return typeof record.message === 'string'
        ? { code: record.code, message: record.message }
        : { code: record.code };
    }
    current = record.cause;
  }
  return {};
}

async function expectDatabaseError(
  operation: Promise<unknown>,
  expected: { readonly code: string; readonly message: string }
): Promise<void> {
  expect(postgresError(await rejected(operation))).toEqual(expected);
}

async function within<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 5_000);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForAdministratorBarrier(input: {
  readonly runtimePid: number;
  readonly runtimeApplicationName: string;
  readonly demoterPid: number;
  readonly operation: Promise<SubmissionOutcome>;
}): Promise<void> {
  const observation = (async () => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const activity = await ownerDatabaseClient.pool.query<{
        blockers: number[];
        wait_event_type: string | null;
        wait_event: string | null;
        query: string;
      }>(
        `select pg_catalog.pg_blocking_pids(pid) as blockers,
           wait_event_type, wait_event, query
         from pg_catalog.pg_stat_activity
         where pid = $1 and application_name = $2`,
        [input.runtimePid, input.runtimeApplicationName]
      );
      const waiter = activity.rows[0];
      if (
        activity.rows.length === 1 &&
        waiter?.wait_event_type === 'Lock' &&
        waiter.wait_event === 'advisory' &&
        waiter.blockers.length === 1 &&
        waiter.blockers[0] === input.demoterPid
      ) {
        expect(waiter.query).toMatch(/public[.]submit_job_retry_command/iu);
        return;
      }
      await delay(10);
    }
    throw new Error('Timed out waiting for the job retry submission administrator barrier.');
  })();

  await Promise.race([
    observation,
    input.operation.then(() => {
      throw new Error('Job retry submission settled before reaching the administrator barrier.');
    })
  ]);
}

describe('job operations service PostgreSQL authority', () => {
  it('lists, submits, replays, and scopes exact microsecond-safe DTOs through complete routines', async () => {
    const actor = await createAdministrator('round-trip-owner');
    const otherActor = await createAdministrator('round-trip-foreign');
    const target = await createFailedTarget();

    expect(await listOperationalJobs(databaseClient.db, actor, {
      status: 'failed',
      kind: 'outbox.dispatch',
      limit: 10
    })).toEqual([{
      jobId: target.id,
      kind: 'outbox.dispatch',
      label: 'Outbox dispatch',
      status: 'failed',
      attempts: 1,
      maxAttempts: 8,
      runAt: target.updatedAt,
      completedAt: target.updatedAt,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
      retryDisposition: 'rearm_existing',
      policyAvailability: 'disabled',
      safeFailureCode: 'source_unavailable'
    }]);

    const command = retryCommand(target);
    const submittedCorrelation = correlationId('job-operations-valid');
    const submitted = await submitJobRetryCommand(
      databaseClient.db,
      actor,
      command,
      { correlationId: submittedCorrelation }
    );
    expect(submitted).toMatchObject({
      kind: 'retry_failed_job',
      targetJobId: target.id,
      targetKind: 'outbox.dispatch',
      reasonCode: 'dependency_recovered',
      correlationId: submittedCorrelation,
      status: 'pending',
      resultCode: null,
      completedAt: null
    });
    expect(submitted.createdAt).toMatch(CANONICAL_TIMESTAMP);
    expect(submitted.updatedAt).toBe(submitted.createdAt);
    expect(await getOwnedJobRetryCommand(databaseClient.db, actor, submitted.commandId))
      .toEqual(submitted);
    expect(await getOwnedJobRetryCommand(databaseClient.db, otherActor, submitted.commandId))
      .toBeNull();

    const replayCorrelation = correlationId('job-operations-replay');
    expect(await submitJobRetryCommand(
      databaseClient.db,
      actor,
      command,
      { correlationId: replayCorrelation }
    )).toEqual(submitted);
    expect(await auditRows(replayCorrelation)).toEqual([]);
    expect(await auditRows(submittedCorrelation)).toEqual([{
      actor_type: 'user',
      actor_id: actor.id,
      action: 'operations.job_retry.requested',
      outcome: 'succeeded',
      resource_type: 'operations_job_retry_command',
      resource_id: submitted.commandId,
      correlation_id: submittedCorrelation,
      request_metadata: null,
      before: null,
      after: {
        commandId: submitted.commandId,
        targetJobId: target.id,
        registeredKind: 'outbox.dispatch',
        reasonCode: 'dependency_recovered'
      }
    }]);
    expect(await operationsInventory()).toEqual({
      commands: 1,
      command_jobs: 1,
      succeeded_audits: 1,
      denied_audits: 0,
      operations_audits: 1
    });

    await expectDatabaseError(
      databaseClient.pool.query('select * from operations_job_retry_commands'),
      { code: '42501', message: 'permission denied for table operations_job_retry_commands' }
    );
    await expectDatabaseError(
      databaseClient.pool.query('select * from operations_job_retry_claims'),
      { code: '42501', message: 'permission denied for table operations_job_retry_claims' }
    );
  });

  it('returns fixed conflicts and writes one bounded denied audit for changed and stale inputs', async () => {
    const actor = await createAdministrator('conflicts');
    const target = await createFailedTarget();
    const idempotencyKey = randomUUID();
    const original = retryCommand(target, idempotencyKey);
    const acceptedCorrelation = correlationId('job-operations-conflict-baseline');
    await submitJobRetryCommand(
      databaseClient.db,
      actor,
      original,
      { correlationId: acceptedCorrelation }
    );

    const changedCorrelation = correlationId('job-operations-changed');
    await expectFixedConflict(submitJobRetryCommand(
      databaseClient.db,
      actor,
      retryCommand(target, idempotencyKey, 'operator_reassessment'),
      { correlationId: changedCorrelation }
    ));
    expect(await auditRows(changedCorrelation)).toEqual([
      deniedAudit(actor, changedCorrelation)
    ]);

    await ownerDatabaseClient.pool.query(
      `update jobs set updated_at = updated_at + interval '1 microsecond' where id = $1`,
      [target.id]
    );
    const staleCorrelation = correlationId('job-operations-stale');
    await expectFixedConflict(submitJobRetryCommand(
      databaseClient.db,
      actor,
      retryCommand(target),
      { correlationId: staleCorrelation }
    ));
    expect(await auditRows(staleCorrelation)).toEqual([
      deniedAudit(actor, staleCorrelation)
    ]);

    expect(await operationsInventory()).toEqual({
      commands: 1,
      command_jobs: 1,
      succeeded_audits: 1,
      denied_audits: 2,
      operations_audits: 3
    });
  });

  it('audits pre-routine denial and fails closed when the database role is no longer current', async () => {
    const actor = await createAdministrator('revoked');
    const target = await createFailedTarget();
    const preDeniedCorrelation = correlationId('job-operations-pre-denied');
    const denyJobsRetry: CapabilityResolver = () => new Set<AdminCapability>();

    expectFixedForbidden(await rejected(submitJobRetryCommand(
      databaseClient.db,
      actor,
      retryCommand(target),
      { correlationId: preDeniedCorrelation },
      { capabilityResolver: denyJobsRetry }
    )));
    expect(await auditRows(preDeniedCorrelation)).toEqual([
      deniedAudit(actor, preDeniedCorrelation)
    ]);
    expect(await operationsInventory()).toEqual({
      commands: 0,
      command_jobs: 0,
      succeeded_audits: 0,
      denied_audits: 1,
      operations_audits: 1
    });

    const acceptedCorrelation = correlationId('job-operations-before-revocation');
    const accepted = await submitJobRetryCommand(
      databaseClient.db,
      actor,
      retryCommand(target),
      { correlationId: acceptedCorrelation }
    );
    await ownerDatabaseClient.pool.query(
      `delete from user_roles where user_id = $1 and role = 'admin'`,
      [actor.id]
    );

    expectFixedForbidden(await rejected(listOperationalJobs(databaseClient.db, actor, {
      status: 'failed',
      limit: 10
    })));
    expectFixedForbidden(await rejected(
      getOwnedJobRetryCommand(databaseClient.db, actor, accepted.commandId)
    ));
    const revokedCorrelation = correlationId('job-operations-revoked-submit');
    expectFixedForbidden(await rejected(submitJobRetryCommand(
      databaseClient.db,
      actor,
      retryCommand(target),
      { correlationId: revokedCorrelation }
    )));
    expect(await auditRows(revokedCorrelation)).toEqual([
      deniedAudit(actor, revokedCorrelation)
    ]);
    expect(await operationsInventory()).toEqual({
      commands: 1,
      command_jobs: 1,
      succeeded_audits: 1,
      denied_audits: 2,
      operations_audits: 3
    });
  });

  it('revokes after TypeScript authorization at a deterministic administrator-lock barrier', async () => {
    const actor = await createAdministrator('barrier');
    const target = await createFailedTarget();
    const command = retryCommand(target);
    const requestCorrelation = correlationId('job-operations-barrier');
    const suffix = randomUUID().replaceAll('-', '');
    const runtimeApplicationName = `test-job-operations-runtime-${suffix}`;
    const demoterApplicationName = `test-job-operations-demoter-${suffix}`;
    const runtime = await databaseClient.pool.connect();
    const demoter = await ownerDatabaseClient.pool.connect();
    let demotionOpen = false;
    let operation: Promise<SubmissionOutcome> | undefined;

    try {
      await runtime.query(`select pg_catalog.set_config('application_name', $1, false)`, [
        runtimeApplicationName
      ]);
      await runtime.query(`select pg_catalog.set_config('lock_timeout', '5s', false)`);
      const runtimePid = (await runtime.query<{ pid: number }>(
        `select pg_catalog.pg_backend_pid() as pid`
      )).rows[0]!.pid;
      const pinnedDatabase = drizzle({ client: runtime, schema }) as Database;

      await demoter.query('begin');
      demotionOpen = true;
      await demoter.query(`select pg_catalog.set_config('application_name', $1, true)`, [
        demoterApplicationName
      ]);
      await demoter.query(`select pg_catalog.set_config('lock_timeout', '5s', true)`);
      const demoterPid = (await demoter.query<{ pid: number }>(
        `select pg_catalog.pg_backend_pid() as pid`
      )).rows[0]!.pid;
      await demoter.query(
        `select pg_catalog.pg_advisory_xact_lock(
           pg_catalog.hashtext('pale-orbit:user-roles:admin')
         )`
      );
      expect((await demoter.query(
        `delete from user_roles where user_id = $1 and role = 'admin' returning user_id`,
        [actor.id]
      )).rows).toHaveLength(1);

      operation = submitJobRetryCommand(
        pinnedDatabase,
        actor,
        command,
        { correlationId: requestCorrelation }
      ).then(
        (value) => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      );
      await waitForAdministratorBarrier({
        runtimePid,
        runtimeApplicationName,
        demoterPid,
        operation
      });
      expect(await operationsInventory()).toEqual({
        commands: 0,
        command_jobs: 0,
        succeeded_audits: 0,
        denied_audits: 0,
        operations_audits: 0
      });

      await demoter.query('commit');
      demotionOpen = false;
      const outcome = await within(
        operation,
        'Timed out waiting for the job retry submission after administrator revocation.'
      );
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') throw new Error('Expected revoked submission to reject');
      expectFixedForbidden(outcome.error);
      expect(await auditRows(requestCorrelation)).toEqual([
        deniedAudit(actor, requestCorrelation)
      ]);
      expect(await operationsInventory()).toEqual({
        commands: 0,
        command_jobs: 0,
        succeeded_audits: 0,
        denied_audits: 1,
        operations_audits: 1
      });
      expect((await ownerDatabaseClient.pool.query(
        `select status::text, attempts,
           to_char(timezone('UTC', updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
         from jobs where id = $1`,
        [target.id]
      )).rows).toEqual([{
        status: 'failed',
        attempts: 1,
        updated_at: target.updatedAt
      }]);
    } finally {
      if (demotionOpen) await demoter.query('rollback').catch(() => undefined);
      if (operation !== undefined) {
        await within(operation, 'Timed out settling the job retry barrier during cleanup.')
          .catch(() => undefined);
      }
      runtime.release(true);
      demoter.release(true);
    }
  }, 20_000);
});
