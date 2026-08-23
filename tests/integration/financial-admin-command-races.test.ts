import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthorizationError,
  type AdministratorActor
} from '$lib/server/auth/admin-policy';
import { setAdminRole } from '$lib/server/auth/roles';
import { loadApplicationConfig } from '$lib/server/config/load';
import { createCommerceMessageEnqueuer } from '$lib/server/commerce/email/enqueue';
import { createFinancialAdminCommandExecutors } from '$lib/server/commerce/financial/admin-commands/executors';
import {
  createFinancialAdminCommandHandler,
  type FinancialAdminCommandExecutor
} from '$lib/server/commerce/financial/admin-commands/handler';
import {
  submitFinancialAdminCommand
} from '$lib/server/commerce/financial/admin-commands/repository';
import type {
  FinancialAdminPrivateCommand
} from '$lib/server/commerce/financial/admin-commands/contracts';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { databaseEnvironmentForRole } from '$lib/server/db/database-role-provision';
import * as schema from '$lib/server/db/schema';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import type { JobRecord } from '$lib/server/jobs/types';
import type { FinancialAdminCommandKind } from '$lib/types/financial-reporting';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient
} from './database';

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface ProbeDatabase {
  readonly database: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

interface OpenBlocker {
  readonly client: PoolClient;
  readonly pid: number;
  open: boolean;
}

interface CleanupOperation {
  readonly label: string;
  readonly operation: Promise<unknown> | undefined;
}

const accessMessages = createCommerceMessageEnqueuer(applicationConfig.origin);

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function probeName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

function postgresCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    const record = current as { readonly code?: unknown; readonly cause?: unknown };
    if (typeof record.code === 'string') return record.code;
    current = record.cause;
  }
  return undefined;
}

async function within<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
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
  return {
    database,
    pool,
    close: () => pool.end()
  };
}

async function backendPid(pool: Pool): Promise<number> {
  const result = await pool.query<{ pid: number }>('select pg_backend_pid() as pid');
  const pid = result.rows[0]?.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) {
    throw new Error('Expected a PostgreSQL backend PID');
  }
  return pid;
}

async function waitForBlockedQuery(input: {
  readonly pid: number;
  readonly applicationName: string;
  readonly blockerPid: number | readonly number[];
  readonly queryFragment: string;
}): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await ownerDatabaseClient.pool.query<{
      blockers: number[];
      query: string;
      waitEventType: string | null;
    }>(`
      select pg_blocking_pids(pid) as blockers, query,
        wait_event_type as "waitEventType"
      from pg_stat_activity
      where pid = $1 and application_name = $2
    `, [input.pid, input.applicationName]);
    const row = result.rows[0];
    if (row?.waitEventType === 'Lock') {
      const expectedBlockers = typeof input.blockerPid === 'number'
        ? [input.blockerPid]
        : [...input.blockerPid];
      expect([...row.blockers].sort((left, right) => left - right))
        .toEqual(expectedBlockers.sort((left, right) => left - right));
      expect(row.query.replace(/\s+/gu, ' ').toLowerCase())
        .toContain(input.queryFragment.toLowerCase());
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Expected ${input.applicationName} to block in ${input.queryFragment}`
  );
}

async function lockAdministratorRoleRow(
  applicationName: string,
  userId: string
): Promise<OpenBlocker> {
  const client = await ownerDatabaseClient.pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('application_name', $1, true)", [
      applicationName
    ]);
    const result = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    const pid = result.rows[0]?.pid;
    if (typeof pid !== 'number') throw new Error('Expected blocker PID');
    await client.query(
      `select user_id from user_roles
       where user_id = $1 and role = 'admin' for update`,
      [userId]
    );
    return { client, pid, open: true };
  } catch (error) {
    try {
      await within(
        client.query('rollback'),
        5_000,
        'Timed out rolling back administrator-role blocker setup'
      );
      client.release();
    } catch {
      client.release(true);
    }
    throw error;
  }
}

async function releaseBlocker(blocker: OpenBlocker): Promise<void> {
  if (!blocker.open) return;
  blocker.open = false;
  try {
    await within(
      blocker.client.query('rollback'),
      5_000,
      'Timed out releasing administrator-role blocker'
    );
    blocker.client.release();
  } catch (error) {
    blocker.client.release(true);
    throw error;
  }
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
          5_000,
          `Timed out cleaning up ${label}`
        )])
  );
  const closeCleanup = await Promise.allSettled(
    probes.flatMap((probe, index) => probe === undefined
      ? []
      : [within(
          probe.close(),
          5_000,
          `Timed out closing financial race probe ${index + 1}`
        )])
  );
  const rejected = [...operationCleanup, ...closeCleanup].find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  );
  if (rejected) throw rejected.reason;
}

async function acquireExclusiveFinancialAdminLease(
  database: Database,
  jobId: string
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'pale-orbit:plan6bii-financial-admin-job-lease:' || ${jobId}::text,
          0
        )
      )
    `);
  });
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [id, `Race administrator ${label}`, `${label}-${id}@example.com`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [id]
  );
  return { type: 'user', id, roles: ['admin'] };
}

function draftCommand(): Extract<
  FinancialAdminPrivateCommand,
  { kind: 'refund_draft_save' }
> {
  return {
    kind: 'refund_draft_save',
    refundId: randomUUID(),
    expectedVersion: null,
    items: [{ orderItemId: randomUUID(), totalPresentmentMinor: 725 }]
  };
}

function completeExecutors(
  refundDraftSave: FinancialAdminCommandExecutor
): ReadonlyMap<FinancialAdminCommandKind, FinancialAdminCommandExecutor> {
  return createFinancialAdminCommandExecutors({
    refundDraftSave,
    refundDraftDiscard: async () => ({
      refundId: randomUUID(), draftVersion: 1, changed: false
    }),
    refundAllocationFinalize: async () => ({
      refundId: randomUUID(),
      finalizedDraftVersion: 1,
      accessChanged: false,
      emailQueued: false
    }),
    refundReportingCorrectionCreate: async () => ({
      refundId: randomUUID(),
      correctionSetId: randomUUID(),
      correctionVersion: 1
    }),
    administrativeRecoveryActivate: async () => ({
      recoveryGrantId: randomUUID(),
      accessChanged: false,
      emailQueued: false
    }),
    administrativeRecoveryDeactivate: async () => ({
      recoveryGrantId: randomUUID(),
      accessChanged: false,
      emailQueued: false
    })
  });
}

function commandHandler(
  database: Database,
  executor: FinancialAdminCommandExecutor
) {
  return createFinancialAdminCommandHandler({
    database,
    executors: completeExecutors(executor),
    accessMessages
  });
}

function leaseCapability(): string {
  return randomBytes(32).toString('base64url');
}

function commandRepository(
  database: Database,
  capabilitySource: () => string = leaseCapability
) {
  return createPostgresJobRepository(
    database,
    { ...applicationConfig.jobs, leaseMs: 60_000 },
    undefined,
    'local-only',
    { classifierVersion: 1, allocationAlgorithmVersion: 2 },
    capabilitySource
  );
}

async function submitDraft(
  database: Database,
  actor: AdministratorActor,
  command: ReturnType<typeof draftCommand>,
  idempotencyKey = randomUUID(),
  correlationId = `financial-admin-race-${randomUUID()}`
) {
  return submitFinancialAdminCommand(database, {
    actor,
    command,
    idempotencyKey,
    context: { correlationId }
  });
}

async function claimCommand(
  repository: ReturnType<typeof commandRepository>,
  workerId: string,
  expectedCommandId: string
): Promise<JobRecord> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const job = await repository.claimNext(workerId);
    if (job?.payload &&
      typeof job.payload === 'object' &&
      Reflect.get(job.payload, 'commandId') === expectedCommandId) {
      return job;
    }
    if (!job) break;
  }
  throw new Error(`Expected command job ${expectedCommandId}`);
}

async function expireClaimForFixture(jobId: string): Promise<void> {
  const client = await ownerDatabaseClient.pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(
      `update jobs set locked_at = clock_timestamp() - interval '3 minutes',
         run_at = clock_timestamp() - interval '2 minutes'
       where id = $1`,
      [jobId]
    );
    await client.query(
      `update financial_admin_job_claims
       set issued_at = clock_timestamp() - interval '4 minutes',
         renewed_at = clock_timestamp() - interval '3 minutes',
         expires_at = clock_timestamp() - interval '2 minutes'
       where job_id = $1`,
      [jobId]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function authoritySnapshot(commandIds: readonly string[]): Promise<unknown> {
  const authority = await ownerDatabaseClient.pool.query(
    `select command.id as command_id, command.status as command_status,
       command.safe_result_code, command.safe_result,
       job.id as job_id, job.status as job_status, job.attempts,
       job.locked_by, job.locked_at, job.run_at, job.last_error,
       claim.generation, claim.attempt as claim_attempt, claim.state as claim_state,
       claim.capability_sha256, claim.issued_at, claim.renewed_at,
       claim.expires_at, claim.invalidated_at
     from financial_admin_commands command
     join jobs job on job.id = command.job_id
     join financial_admin_job_claims claim on claim.job_id = job.id
     where command.id = any($1::uuid[])
     order by command.id`,
    [commandIds]
  );
  const sideEffects = await ownerDatabaseClient.pool.query(
    `select
       (select count(*)::integer from audit_events) as audit_count,
       (select count(*)::integer from outbox_messages) as outbox_count,
       (select count(*)::integer from refund_allocation_drafts) as draft_count,
       (select count(*)::integer from refund_allocation_finalization_effects)
         as finalization_count,
       (select count(*)::integer from refund_reporting_correction_sets)
         as correction_count,
       (select count(*)::integer from entitlement_grants) as grant_count`
  );
  return JSON.parse(JSON.stringify({
    authority: authority.rows,
    sideEffects: sideEffects.rows
  })) as unknown;
}

function pauseAfterProtectedSubmit(
  database: Database,
  entered: Deferred,
  release: Deferred
): Database {
  return {
    transaction: (work) => database.transaction(async (transaction) => {
      let executeCount = 0;
      const wrapped = new Proxy(transaction, {
        get(target, property) {
          if (property === 'execute') {
            return async (query: Parameters<typeof target.execute>[0]) => {
              const result = await target.execute(query);
              executeCount += 1;
              if (executeCount === 2) {
                entered.resolve();
                await release.promise;
              }
              return result;
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      return work(wrapped);
    })
  } as Database;
}

function pauseAfterHeartbeatUpdate(
  database: Database,
  entered: Deferred,
  release: Deferred
): Database {
  return {
    transaction: (work) => database.transaction(async (transaction) => {
      let executeCount = 0;
      const wrapped = new Proxy(transaction, {
        get(target, property) {
          if (property === 'execute') {
            return async (query: Parameters<typeof target.execute>[0]) => {
              const result = await target.execute(query);
              executeCount += 1;
              if (executeCount === 4) {
                entered.resolve();
                await release.promise;
              }
              return result;
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      return work(wrapped);
    })
  } as Database;
}

describe('financial administrator command deterministic races', () => {
  it('serializes demotion ahead of submit and rechecks authority before parsing private work', async () => {
    const target = await createAdministrator('demotion-submit-target');
    const manager = await createAdministrator('demotion-submit-manager');
    const demotionName = probeName('financial-demotion-submit');
    const submitName = probeName('financial-submit-after-demotion');
    const blockerName = probeName('financial-role-row-blocker');
    const command = draftCommand();
    const correlationId = `demotion-submit-${randomUUID()}`;
    let demotion: ProbeDatabase | undefined;
    let submission: ProbeDatabase | undefined;
    let blocker: OpenBlocker | undefined;
    let demotionWork: Promise<readonly string[]> | undefined;
    let submitWork: Promise<unknown> | undefined;

    try {
      demotion = probeDatabase(demotionName, 'runtime');
      submission = probeDatabase(submitName, 'runtime');
      const demotionPid = await backendPid(demotion.pool);
      const submitPid = await backendPid(submission.pool);
      blocker = await lockAdministratorRoleRow(blockerName, target.id);
      await expect(ownerDatabaseClient.pool.query(
        `select application_name as "applicationName", state
         from pg_stat_activity where pid = $1`,
        [blocker.pid]
      )).resolves.toMatchObject({
        rows: [{ applicationName: blockerName, state: 'idle in transaction' }]
      });
      demotionWork = setAdminRole(demotion.database, {
        actor: manager,
        targetUserId: target.id,
        enabled: false,
        correlationId: `demote-${randomUUID()}`
      });
      void demotionWork.catch(() => undefined);
      await waitForBlockedQuery({
        pid: demotionPid,
        applicationName: demotionName,
        blockerPid: blocker.pid,
        queryFragment: 'delete from "user_roles"'
      });

      submitWork = submitDraft(
        submission.database,
        target,
        command,
        randomUUID(),
        correlationId
      );
      void submitWork.catch(() => undefined);
      await waitForBlockedQuery({
        pid: submitPid,
        applicationName: submitName,
        blockerPid: demotionPid,
        queryFragment: 'pg_advisory_xact_lock'
      });

      await releaseBlocker(blocker);
      await expect(demotionWork).resolves.not.toContain('admin');
      await expect(submitWork).rejects.toBeInstanceOf(AuthorizationError);
      await expect(ownerDatabaseClient.pool.query(
        `select count(*)::integer as count from financial_admin_commands
         where actor_user_id = $1 and correlation_id = $2`,
        [target.id, correlationId]
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      if (blocker !== undefined) await releaseBlocker(blocker).catch(() => undefined);
      await cleanupProbeResources([
        { label: 'demotion-before-submit work', operation: demotionWork },
        { label: 'submission-after-demotion work', operation: submitWork }
      ], [demotion, submission]);
    }
  }, 20_000);

  it('holds administrator authority through execution while a named demotion waits on its exact PID', async () => {
    const target = await createAdministrator('demotion-execution-target');
    const manager = await createAdministrator('demotion-execution-manager');
    const command = draftCommand();
    const submitted = await submitDraft(databaseClient.db, target, command);
    const handlerName = probeName('financial-handler-demotion');
    const demotionName = probeName('financial-demotion-execution');
    const entered = deferred();
    const release = deferred();
    const executor = vi.fn<FinancialAdminCommandExecutor>(async () => {
      entered.resolve();
      await release.promise;
      return { refundId: command.refundId, draftVersion: 1, changed: true };
    });
    let handlerProbe: ProbeDatabase | undefined;
    let demotionProbe: ProbeDatabase | undefined;
    let handling: Promise<void> | undefined;
    let demotionWork: Promise<readonly string[]> | undefined;

    try {
      handlerProbe = probeDatabase(handlerName, 'worker');
      demotionProbe = probeDatabase(demotionName, 'runtime');
      const handlerPid = await backendPid(handlerProbe.pool);
      const demotionPid = await backendPid(demotionProbe.pool);
      const repository = commandRepository(handlerProbe.database);
      const job = await claimCommand(
        repository,
        'demotion-execution-worker',
        submitted.commandId
      );
      handling = commandHandler(handlerProbe.database, executor)(
        job,
        new AbortController().signal
      );
      void handling.catch(() => undefined);
      await within(
        entered.promise,
        5_000,
        'Timed out waiting for demotion-execution handler entry'
      );
      demotionWork = setAdminRole(demotionProbe.database, {
        actor: manager,
        targetUserId: target.id,
        enabled: false,
        correlationId: `demotion-execution-${randomUUID()}`
      });
      void demotionWork.catch(() => undefined);
      await waitForBlockedQuery({
        pid: demotionPid,
        applicationName: demotionName,
        blockerPid: handlerPid,
        queryFragment: 'pg_advisory_xact_lock'
      });
      release.resolve();
      await within(handling, 5_000, 'Timed out releasing demotion-execution handler');
      await within(demotionWork, 5_000, 'Timed out releasing named administrator demotion');
      await expect(repository.complete(
        job.id,
        'demotion-execution-worker',
        job.financialAdminLeaseCapability
      )).resolves.toBe(true);
      expect(executor).toHaveBeenCalledOnce();
      await expect(ownerDatabaseClient.pool.query(
        `select command.status as command_status, job.status as job_status
         from financial_admin_commands command
         join jobs job on job.id = command.job_id
         where command.id = $1`,
        [submitted.commandId]
      )).resolves.toMatchObject({
        rows: [{ command_status: 'succeeded', job_status: 'succeeded' }]
      });
    } finally {
      release.resolve();
      await cleanupProbeResources([
        { label: 'demotion-execution handler', operation: handling },
        { label: 'demotion-execution role change', operation: demotionWork }
      ], [handlerProbe, demotionProbe]);
    }
  }, 20_000);

  it('returns one identity when an exact replay waits behind the same pending submission', async () => {
    const actor = await createAdministrator('pending-replay');
    const command = draftCommand();
    const idempotencyKey = randomUUID();
    const firstName = probeName('financial-first-submit');
    const replayName = probeName('financial-pending-replay');
    const entered = deferred();
    const release = deferred();
    let first: ProbeDatabase | undefined;
    let replay: ProbeDatabase | undefined;
    let firstWork: ReturnType<typeof submitDraft> | undefined;
    let replayWork: ReturnType<typeof submitDraft> | undefined;

    try {
      first = probeDatabase(firstName, 'runtime');
      replay = probeDatabase(replayName, 'runtime');
      const firstPid = await backendPid(first.pool);
      const replayPid = await backendPid(replay.pool);
      firstWork = submitDraft(
        pauseAfterProtectedSubmit(first.database, entered, release),
        actor,
        command,
        idempotencyKey
      );
      void firstWork.catch(() => undefined);
      await within(
        entered.promise,
        5_000,
        'Timed out waiting for protected idempotent submission'
      );
      replayWork = submitDraft(replay.database, actor, command, idempotencyKey);
      void replayWork.catch(() => undefined);
      await waitForBlockedQuery({
        pid: replayPid,
        applicationName: replayName,
        blockerPid: firstPid,
        queryFragment: 'pg_advisory_xact_lock'
      });
      release.resolve();
      const [created, replayed] = await within(
        Promise.all([firstWork, replayWork]),
        5_000,
        'Timed out releasing pending idempotent replay'
      );
      expect(replayed).toEqual(created);
      await expect(ownerDatabaseClient.pool.query(
        `select count(*)::integer as count from financial_admin_commands
         where actor_user_id = $1 and idempotency_key_sha256 = $2`,
        [
          actor.id,
          createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')
        ]
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      release.resolve();
      await cleanupProbeResources([
        { label: 'first idempotent submission', operation: firstWork },
        { label: 'pending idempotent replay', operation: replayWork }
      ], [first, replay]);
    }
  }, 20_000);

  it('rejects every stale or foreign lease token without changing authority or domain state', async () => {
    const actor = await createAdministrator('lease-token-matrix');
    const first = await submitDraft(databaseClient.db, actor, draftCommand());
    const second = await submitDraft(databaseClient.db, actor, draftCommand());
    const issued = [leaseCapability(), leaseCapability(), leaseCapability()];
    let capabilityIndex = 0;
    const repository = commandRepository(
      workerDatabaseClient.db,
      () => issued[capabilityIndex++]!
    );
    const workerId = 'financial-token-matrix-worker';
    const claimed = [
      await repository.claimNext(workerId),
      await repository.claimNext(workerId)
    ];
    expect(claimed.every((job) => job !== null)).toBe(true);
    const jobsByCommand = new Map(claimed.map((job) => [
      Reflect.get(job!.payload as object, 'commandId') as string,
      job!
    ]));
    const target = jobsByCommand.get(first.commandId);
    const foreign = jobsByCommand.get(second.commandId);
    if (!target || !foreign ||
      !target.financialAdminLeaseCapability ||
      !foreign.financialAdminLeaseCapability) {
      throw new Error('Expected two claimed financial command jobs');
    }
    const commandIds = [first.commandId, second.commandId];

    for (const rejectedCapability of [
      undefined,
      leaseCapability(),
      foreign.financialAdminLeaseCapability
    ]) {
      const before = await authoritySnapshot(commandIds);
      await expect(repository.renewLease(
        target.id,
        workerId,
        rejectedCapability
      )).resolves.toBe(false);
      expect(await authoritySnapshot(commandIds)).toEqual(before);
    }

    await expireClaimForFixture(target.id);
    const expiredState = await authoritySnapshot(commandIds);
    await expect(repository.renewLease(
      target.id,
      workerId,
      target.financialAdminLeaseCapability
    )).resolves.toBe(false);
    expect(await authoritySnapshot(commandIds)).toEqual(expiredState);

    const takenOver = await repository.claimNext('financial-token-takeover');
    expect(takenOver).toMatchObject({ id: target.id, attempts: 2 });
    if (!takenOver?.financialAdminLeaseCapability) {
      throw new Error('Expected a rotated takeover capability');
    }
    expect(takenOver.financialAdminLeaseCapability)
      .not.toBe(target.financialAdminLeaseCapability);
    const priorGenerationState = await authoritySnapshot(commandIds);
    await expect(repository.renewLease(
      target.id,
      'financial-token-takeover',
      target.financialAdminLeaseCapability
    )).resolves.toBe(false);
    expect(await authoritySnapshot(commandIds)).toEqual(priorGenerationState);

    await expect(repository.fail(
      target.id,
      'financial-token-takeover',
      'token matrix terminal fixture',
      false,
      takenOver.financialAdminLeaseCapability
    )).resolves.toBe(true);
    const invalidatedState = await authoritySnapshot(commandIds);
    await expect(repository.renewLease(
      target.id,
      'financial-token-takeover',
      takenOver.financialAdminLeaseCapability
    )).resolves.toBe(false);
    expect(await authoritySnapshot(commandIds)).toEqual(invalidatedState);

    await expect(repository.fail(
      foreign.id,
      workerId,
      'token matrix cleanup',
      false,
      foreign.financialAdminLeaseCapability
    )).resolves.toBe(true);
  }, 20_000);

  it('lets a real paused heartbeat share the handler lease while an exact exclusive waiter names both PIDs', async () => {
    const actor = await createAdministrator('handler-heartbeat');
    const command = draftCommand();
    const submitted = await submitDraft(databaseClient.db, actor, command);
    const handlerName = probeName('financial-handler-shared');
    const heartbeatName = probeName('financial-heartbeat-shared');
    const exclusiveName = probeName('financial-lease-exclusive-waiter');
    const capability = leaseCapability();
    const handlerEntered = deferred();
    const handlerRelease = deferred();
    const heartbeatEntered = deferred();
    const heartbeatRelease = deferred();
    const executor = vi.fn<FinancialAdminCommandExecutor>(async () => {
      handlerEntered.resolve();
      await handlerRelease.promise;
      return { refundId: command.refundId, draftVersion: 1, changed: true };
    });
    let handlerProbe: ProbeDatabase | undefined;
    let heartbeatProbe: ProbeDatabase | undefined;
    let exclusiveProbe: ProbeDatabase | undefined;
    let handling: Promise<void> | undefined;
    let renewal: Promise<boolean> | undefined;
    let exclusiveWaiter: Promise<void> | undefined;

    try {
      handlerProbe = probeDatabase(handlerName, 'worker');
      heartbeatProbe = probeDatabase(heartbeatName, 'worker');
      exclusiveProbe = probeDatabase(exclusiveName, 'worker');
      const handlerPid = await backendPid(handlerProbe.pool);
      const heartbeatPid = await backendPid(heartbeatProbe.pool);
      const exclusivePid = await backendPid(exclusiveProbe.pool);
      const handlerRepository = commandRepository(handlerProbe.database, () => capability);
      const heartbeatRepository = commandRepository(
        pauseAfterHeartbeatUpdate(
          heartbeatProbe.database,
          heartbeatEntered,
          heartbeatRelease
        )
      );
      const job = await claimCommand(
        handlerRepository,
        'handler-heartbeat-worker',
        submitted.commandId
      );
      handling = commandHandler(handlerProbe.database, executor)(
        job,
        new AbortController().signal
      );
      void handling.catch(() => undefined);
      await within(
        handlerEntered.promise,
        5_000,
        'Timed out waiting for shared-lease handler entry'
      );
      renewal = heartbeatRepository.renewLease(
        job.id,
        'handler-heartbeat-worker',
        capability
      );
      void renewal.catch(() => undefined);
      await within(
        heartbeatEntered.promise,
        5_000,
        'Timed out waiting for heartbeat shared-lease acquisition'
      );

      const activity = await ownerDatabaseClient.pool.query<{
        applicationName: string;
        pid: number;
        state: string;
      }>(
        `select pid, application_name as "applicationName", state
         from pg_stat_activity where pid = any($1::integer[]) order by pid`,
        [[handlerPid, heartbeatPid]]
      );
      expect(activity.rows).toEqual([
        { pid: handlerPid, applicationName: handlerName, state: 'idle in transaction' },
        { pid: heartbeatPid, applicationName: heartbeatName, state: 'idle in transaction' }
      ].sort((left, right) => left.pid - right.pid));

      const advisoryLocks = await ownerDatabaseClient.pool.query<{
        count: number;
        mode: string;
        pid: number;
      }>(
        `select pid, mode, count(*)::integer as count
         from pg_locks
         where pid = any($1::integer[]) and locktype = 'advisory' and granted
         group by pid, mode order by pid, mode`,
        [[handlerPid, heartbeatPid]]
      );
      expect(advisoryLocks.rows.filter((row) => row.pid === handlerPid)).toEqual([
        { pid: handlerPid, mode: 'ExclusiveLock', count: 1 },
        { pid: handlerPid, mode: 'ShareLock', count: 1 }
      ]);
      expect(advisoryLocks.rows.filter((row) => row.pid === heartbeatPid)).toEqual([
        { pid: heartbeatPid, mode: 'ShareLock', count: 1 }
      ]);
      await expect(ownerDatabaseClient.pool.query<{ count: number }>(
        `select count(*)::integer as count
         from pg_locks held
         join pg_class relation on relation.oid = held.relation
         where held.pid = $1 and relation.relname = 'financial_admin_commands'`,
        [heartbeatPid]
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });

      exclusiveWaiter = acquireExclusiveFinancialAdminLease(
        exclusiveProbe.database,
        job.id
      );
      void exclusiveWaiter.catch(() => undefined);
      await waitForBlockedQuery({
        pid: exclusivePid,
        applicationName: exclusiveName,
        blockerPid: [handlerPid, heartbeatPid],
        queryFragment: 'pg_advisory_xact_lock'
      });

      heartbeatRelease.resolve();
      await expect(within(
        renewal,
        5_000,
        'Timed out releasing the paused heartbeat'
      )).resolves.toBe(true);
      await waitForBlockedQuery({
        pid: exclusivePid,
        applicationName: exclusiveName,
        blockerPid: handlerPid,
        queryFragment: 'pg_advisory_xact_lock'
      });

      handlerRelease.resolve();
      await within(handling, 5_000, 'Timed out releasing the shared-lease handler');
      await within(
        exclusiveWaiter,
        5_000,
        'Timed out releasing the exclusive financial-admin lease waiter'
      );
      await expect(handlerRepository.complete(
        job.id,
        'handler-heartbeat-worker',
        capability
      )).resolves.toBe(true);
    } finally {
      heartbeatRelease.resolve();
      handlerRelease.resolve();
      await cleanupProbeResources([
        { label: 'handler-heartbeat command handler', operation: handling },
        { label: 'paused financial-admin heartbeat', operation: renewal },
        { label: 'exclusive financial-admin lease waiter', operation: exclusiveWaiter }
      ], [handlerProbe, heartbeatProbe, exclusiveProbe]);
    }
  }, 20_000);

  it('blocks an expired takeover exclusive lease on the old handler PID and rotates generation', async () => {
    const actor = await createAdministrator('takeover-handler');
    const command = draftCommand();
    const submitted = await submitDraft(databaseClient.db, actor, command);
    const handlerName = probeName('financial-old-handler');
    const takeoverName = probeName('financial-takeover');
    const oldCapability = leaseCapability();
    const newCapability = leaseCapability();
    const entered = deferred();
    const release = deferred();
    const executor = vi.fn<FinancialAdminCommandExecutor>(async () => {
      entered.resolve();
      await release.promise;
      return { refundId: command.refundId, draftVersion: 1, changed: true };
    });
    let handlerProbe: ProbeDatabase | undefined;
    let takeoverProbe: ProbeDatabase | undefined;
    let handling: Promise<void> | undefined;
    let takeover: Promise<JobRecord | null> | undefined;

    try {
      handlerProbe = probeDatabase(handlerName, 'worker');
      takeoverProbe = probeDatabase(takeoverName, 'worker');
      const handlerPid = await backendPid(handlerProbe.pool);
      const takeoverPid = await backendPid(takeoverProbe.pool);
      const handlerRepository = commandRepository(handlerProbe.database, () => oldCapability);
      const takeoverRepository = commandRepository(takeoverProbe.database, () => newCapability);
      const job = await claimCommand(
        handlerRepository,
        'old-handler-worker',
        submitted.commandId
      );
      handling = commandHandler(handlerProbe.database, executor)(
        job,
        new AbortController().signal
      );
      void handling.catch(() => undefined);
      await within(
        entered.promise,
        5_000,
        'Timed out waiting for expired old handler entry'
      );
      await expireClaimForFixture(job.id);
      takeover = takeoverRepository.claimNext('takeover-worker');
      void takeover.catch(() => undefined);
      await waitForBlockedQuery({
        pid: takeoverPid,
        applicationName: takeoverName,
        blockerPid: handlerPid,
        queryFragment: 'pg_advisory_xact_lock'
      });
      release.resolve();
      try {
        await within(
          handling,
          5_000,
          'Timed out releasing the expired old handler'
        );
        throw new Error('Expected the expired old handler authority to be rejected');
      } catch (error) {
        expect(postgresCode(error)).toBe('55000');
      }
      const claimed = await within(
        takeover,
        5_000,
        'Timed out releasing the exact expired-claim takeover'
      );
      expect(claimed).toMatchObject({
        id: job.id,
        attempts: 2,
        financialAdminLeaseCapability: newCapability
      });
      await expect(takeoverRepository.renewLease(
        job.id,
        'takeover-worker',
        oldCapability
      )).resolves.toBe(false);
      await expect(ownerDatabaseClient.pool.query(
        `select generation, attempt, state from financial_admin_job_claims
         where job_id = $1`,
        [job.id]
      )).resolves.toMatchObject({
        rows: [{ generation: 2, attempt: 2, state: 'active' }]
      });
      if (!claimed) throw new Error('Expected the rotated takeover claim');
      await within(
        commandHandler(
          takeoverProbe.database,
          async () => ({
            refundId: command.refundId,
            draftVersion: 1,
            changed: true
          })
        )(claimed, new AbortController().signal),
        5_000,
        'Timed out executing the rotated takeover generation'
      );
      await expect(takeoverRepository.complete(
        job.id,
        'takeover-worker',
        claimed.financialAdminLeaseCapability
      )).resolves.toBe(true);
    } finally {
      release.resolve();
      await cleanupProbeResources([
        { label: 'expired old command handler', operation: handling },
        { label: 'financial-admin takeover claim', operation: takeover }
      ], [handlerProbe, takeoverProbe]);
    }
  }, 20_000);

  it('synchronizes a failed terminal job only after the pending command handler rolls back', async () => {
    const actor = await createAdministrator('terminal-handler');
    const command = draftCommand();
    const correlationId = `terminal-sync-${randomUUID()}`;
    const submitted = await submitDraft(
      databaseClient.db,
      actor,
      command,
      randomUUID(),
      correlationId
    );
    const handlerName = probeName('financial-terminal-handler');
    const terminalName = probeName('financial-terminal-writer');
    const capability = leaseCapability();
    const entered = deferred();
    const release = deferred();
    const executor = vi.fn<FinancialAdminCommandExecutor>(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('Terminal synchronization handler rollback fixture');
    });
    let handlerProbe: ProbeDatabase | undefined;
    let terminalProbe: ProbeDatabase | undefined;
    let handling: Promise<void> | undefined;
    let terminal: Promise<boolean> | undefined;

    try {
      handlerProbe = probeDatabase(handlerName, 'worker');
      terminalProbe = probeDatabase(terminalName, 'worker');
      const handlerPid = await backendPid(handlerProbe.pool);
      const terminalPid = await backendPid(terminalProbe.pool);
      const handlerRepository = commandRepository(handlerProbe.database, () => capability);
      const terminalRepository = commandRepository(terminalProbe.database);
      const job = await claimCommand(
        handlerRepository,
        'terminal-worker',
        submitted.commandId
      );
      handling = commandHandler(handlerProbe.database, executor)(
        job,
        new AbortController().signal
      );
      void handling.catch(() => undefined);
      await within(
        entered.promise,
        5_000,
        'Timed out waiting for terminal synchronization handler entry'
      );
      terminal = terminalRepository.fail(
        job.id,
        'terminal-worker',
        'Terminal synchronization race fixture.',
        false,
        capability
      );
      void terminal.catch(() => undefined);
      await waitForBlockedQuery({
        pid: terminalPid,
        applicationName: terminalName,
        blockerPid: handlerPid,
        queryFragment: 'pg_advisory_xact_lock'
      });
      const leaseLocks = await ownerDatabaseClient.pool.query<{
        classid: number;
        database: number;
        expectedJobLock: boolean;
        granted: boolean;
        mode: string;
        objid: number;
        objsubid: number;
        pid: number;
      }>(
        `with lease_key as (
           select hashtextextended(
             'pale-orbit:plan6bii-financial-admin-job-lease:' || $2::uuid::text,
             0
           ) as value
         )
         select lease.pid, lease.database, lease.classid, lease.objid,
           lease.objsubid, lease.mode, lease.granted,
           (
             lease.classid::bigint =
               ((lease_key.value >> 32) & 4294967295::bigint)
             and lease.objid::bigint =
               (lease_key.value & 4294967295::bigint)
             and lease.objsubid = 1
           ) as "expectedJobLock"
         from pg_catalog.pg_locks lease
         cross join lease_key
         where lease.pid = any($1::integer[])
           and lease.locktype = 'advisory'
         order by lease.pid, lease.mode, lease.granted`,
        [[handlerPid, terminalPid], job.id]
      );
      const expectedJobLocks = leaseLocks.rows.filter(
        (lock) => lock.expectedJobLock
      );
      expect(expectedJobLocks.map(({ pid, mode, granted }) => ({
        pid,
        mode,
        granted
      }))).toEqual([
        { pid: handlerPid, mode: 'ShareLock', granted: true },
        { pid: terminalPid, mode: 'ExclusiveLock', granted: false }
      ].sort((left, right) => left.pid - right.pid));
      expect(leaseLocks.rows.filter((lock) => lock.pid === terminalPid))
        .toEqual(expectedJobLocks.filter((lock) => lock.pid === terminalPid));
      const handlerSharedLock = expectedJobLocks.find(
        (lock) => lock.pid === handlerPid && lock.mode === 'ShareLock' && lock.granted
      );
      const terminalExclusiveLock = expectedJobLocks.find(
        (lock) => lock.pid === terminalPid && lock.mode === 'ExclusiveLock' && !lock.granted
      );
      expect(handlerSharedLock).toBeDefined();
      expect(terminalExclusiveLock).toBeDefined();
      expect({
        database: terminalExclusiveLock?.database,
        classid: terminalExclusiveLock?.classid,
        objid: terminalExclusiveLock?.objid,
        objsubid: terminalExclusiveLock?.objsubid
      }).toEqual({
        database: handlerSharedLock?.database,
        classid: handlerSharedLock?.classid,
        objid: handlerSharedLock?.objid,
        objsubid: handlerSharedLock?.objsubid
      });
      const pendingState = await ownerDatabaseClient.pool.query(
        `select job.status as job_status, command.status as command_status,
           claim.state as claim_state,
           (select count(*)::integer from audit_events audit
            where audit.resource_id = command.id::text
              and audit.action like 'financial.admin_command.%') as command_audit_count
         from jobs job
         join financial_admin_commands command on command.job_id = job.id
         join financial_admin_job_claims claim on claim.job_id = job.id
         where job.id = $1`,
        [job.id]
      );
      expect(pendingState.rows).toEqual([{
        job_status: 'running',
        command_status: 'pending',
        claim_state: 'active',
        command_audit_count: 0
      }]);
      release.resolve();
      await expect(within(
        handling,
        5_000,
        'Timed out rolling back the pending command handler'
      )).rejects.toThrow('Terminal synchronization handler rollback fixture');
      await expect(within(
        terminal,
        5_000,
        'Timed out synchronizing the failed terminal job'
      )).resolves.toBe(true);
      expect(executor).toHaveBeenCalledOnce();
      const terminalState = await ownerDatabaseClient.pool.query(
        `select job.status as job_status, command.status as command_status,
           job.attempts, job.last_error, command.safe_result_code,
           command.safe_result, command.completed_at is not null as command_completed,
           claim.state as claim_state,
           claim.generation, claim.attempt as claim_attempt,
           claim.invalidated_at is not null as invalidated
         from jobs job
         join financial_admin_commands command on command.job_id = job.id
         join financial_admin_job_claims claim on claim.job_id = job.id
         where job.id = $1`,
        [job.id]
      );
      expect(terminalState.rows).toEqual([{
        job_status: 'failed',
        command_status: 'failed',
        attempts: 1,
        last_error: 'Terminal synchronization race fixture.',
        safe_result_code: 'command_failed',
        safe_result: null,
        command_completed: true,
        claim_state: 'invalidated',
        generation: 1,
        claim_attempt: 1,
        invalidated: true
      }]);
      const terminalAudits = await ownerDatabaseClient.pool.query(
        `select actor_type, actor_id, action, outcome, resource_type, resource_id,
           correlation_id, request_metadata, before, "after"
         from audit_events
         where resource_id = $1 and action like 'financial.admin_command.%'
         order by id`,
        [submitted.commandId]
      );
      expect(terminalAudits.rows).toEqual([{
        actor_type: 'user',
        actor_id: actor.id,
        action: 'financial.admin_command.failed',
        outcome: 'failed',
        resource_type: 'financial_admin_command',
        resource_id: submitted.commandId,
        correlation_id: correlationId,
        request_metadata: null,
        before: null,
        after: {
          commandKind: 'refund_draft_save',
          safeResultCode: 'command_failed'
        }
      }]);
    } finally {
      release.resolve();
      await cleanupProbeResources([
        { label: 'rolling-back terminal command handler', operation: handling },
        { label: 'failed terminal job synchronization', operation: terminal }
      ], [handlerProbe, terminalProbe]);
    }
  }, 20_000);
});
