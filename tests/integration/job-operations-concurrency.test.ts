import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import { prepareJobRetryCommand } from '$lib/server/operations/jobs/contracts';
import { databaseClient, ownerDatabaseClient, workerDatabaseClient } from './database';

const AUTHORITY_ERROR = {
  code: '55000',
  message: 'Plan 7A operations job authority is not current'
} as const;

interface Fixture {
  readonly actorId: string;
  readonly targetJobId: string;
  readonly targetUpdatedAt: string;
  readonly commandId: string;
  readonly internalJobId: string;
}

function clearCapability(): string {
  return randomBytes(32).toString('base64url');
}

function databaseError(error: unknown): { code?: string; message?: string } {
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
  try {
    await operation;
    throw new Error('Expected database operation to fail');
  } catch (error) {
    expect(databaseError(error)).toEqual(expected);
  }
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

async function waitForBlocked(
  pid: number,
  applicationName: string,
  operation: Promise<unknown>
): Promise<readonly number[]> {
  const observation = (async () => {
    for (let count = 0; count < 300; count += 1) {
      const result = await ownerDatabaseClient.pool.query<{
        blockers: number[];
        wait_event_type: string | null;
      }>(`
        select pg_blocking_pids(pid) as blockers, wait_event_type
        from pg_catalog.pg_stat_activity
        where pid = $1 and application_name = $2
      `, [pid, applicationName]);
      if (result.rows[0]?.wait_event_type === 'Lock' &&
        result.rows[0].blockers.length > 0) return result.rows[0].blockers;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${applicationName} did not visibly block`);
  })();
  return Promise.race([
    observation,
    operation.then(
      () => { throw new Error(`${applicationName} completed before blocking`); },
      (error: unknown) => { throw error; }
    )
  ]);
}

async function namedTransaction(
  client: PoolClient,
  applicationName: string
): Promise<number> {
  await client.query('begin');
  await client.query("select set_config('application_name', $1, true)", [applicationName]);
  await client.query("select set_config('lock_timeout', '5s', true)");
  return (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
}

async function createActor(): Promise<string> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Plan 7A concurrency actor', $2, true)`,
    [id, `plan7a-concurrency-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [id]
  );
  return id;
}

async function createTarget(): Promise<{ readonly id: string; readonly updatedAt: string }> {
  const id = randomUUID();
  const result = await ownerDatabaseClient.pool.query<{ updated_at: string }>(
    `insert into jobs (
       id, type, payload, status, run_at, attempts, max_attempts, last_error,
       completed_at, created_at, updated_at
     ) values (
       $1, 'outbox.dispatch', '{}'::jsonb, 'failed',
       '2026-08-26T12:34:56.123456Z', 1, 8,
       'Outbox message does not exist', '2026-08-26T12:34:56.123456Z',
       '2026-08-26T12:34:55.123456Z', '2026-08-26T12:34:56.123456Z'
     ) returning to_char(timezone('UTC', updated_at),
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`,
    [id]
  );
  return { id, updatedAt: result.rows[0]!.updated_at };
}

function submissionArguments(
  actorId: string,
  target: { readonly id: string; readonly updatedAt: string },
  idempotencyKey: string,
  reasonCode: 'dependency_recovered' | 'operator_reassessment',
  correlationId: string
): readonly unknown[] {
  const prepared = prepareJobRetryCommand({
    idempotencyKey,
    targetJobId: target.id,
    expectedKind: 'outbox.dispatch',
    expectedStatus: 'failed',
    expectedAttempts: 1,
    expectedMaxAttempts: 8,
    expectedUpdatedAt: target.updatedAt,
    reasonCode
  });
  return [
    actorId, target.id, 'outbox.dispatch', 1, 8, target.updatedAt, reasonCode,
    correlationId, prepared.idempotencyKeySha256, prepared.inputFingerprintSha256
  ];
}

const SUBMIT_SQL = `select * from public.submit_job_retry_command(
  $1::uuid, $2::uuid, $3::text, $4::integer, $5::integer, $6::timestamptz,
  $7::text, $8::text, $9::text, $10::text
)`;

async function createFixture(): Promise<Fixture> {
  const actorId = await createActor();
  const target = await createTarget();
  const result = await databaseClient.pool.query<{ command_id: string }>(
    SUBMIT_SQL,
    [...submissionArguments(
      actorId, target, randomUUID(), 'dependency_recovered', `plan7a-${randomUUID()}`
    )]
  );
  const commandId = result.rows[0]!.command_id;
  const job = await ownerDatabaseClient.pool.query<{ id: string }>(
    `select id from jobs
     where payload = jsonb_build_object('commandId', $1::uuid)`,
    [commandId]
  );
  return {
    actorId,
    targetJobId: target.id,
    targetUpdatedAt: target.updatedAt,
    commandId,
    internalJobId: job.rows[0]!.id
  };
}

async function beginCapabilityTransaction(
  applicationName: string,
  capability: string
): Promise<{ readonly client: PoolClient; readonly pid: number }> {
  const client = await workerDatabaseClient.pool.connect();
  try {
    const pid = await namedTransaction(client, applicationName);
    await client.query(
      `select set_config(
        'pale_orbit.plan7a_operations_job_capability', $1, true
      )`,
      [capability]
    );
    return { client, pid };
  } catch (error) {
    client.release(true);
    throw error;
  }
}

async function claim(
  fixture: Fixture,
  capability: string,
  owner: string,
  duration: number
): Promise<readonly QueryResultRow[]> {
  const transaction = await beginCapabilityTransaction(
    `plan7a-claim-${randomUUID()}`,
    capability
  );
  try {
    const result = await transaction.client.query(
      'select * from public.plan7a_operations_claim_job($1, $2, $3)',
      [fixture.internalJobId, owner, duration]
    );
    await transaction.client.query('commit');
    return result.rows;
  } catch (error) {
    await transaction.client.query('rollback');
    throw error;
  } finally {
    transaction.client.release();
  }
}

async function invokeWorker<Row extends QueryResultRow>(
  capability: string,
  text: string,
  parameters: readonly unknown[]
): Promise<readonly Row[]> {
  const transaction = await beginCapabilityTransaction(
    `plan7a-worker-${randomUUID()}`,
    capability
  );
  try {
    const result = await transaction.client.query<Row>(text, [...parameters]);
    await transaction.client.query('commit');
    return result.rows;
  } catch (error) {
    await transaction.client.query('rollback');
    throw error;
  } finally {
    transaction.client.release();
  }
}

async function waitUntilDue(jobId: string): Promise<void> {
  for (let poll = 0; poll < 200; poll += 1) {
    const due = await ownerDatabaseClient.pool.query<{ due: boolean }>(
      'select run_at <= clock_timestamp() as due from jobs where id = $1',
      [jobId]
    );
    if (due.rows[0]?.due) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${jobId} did not become due`);
}

async function advanceToFinalAttempt(
  fixture: Fixture
): Promise<{ readonly capability: string; readonly owner: string }> {
  let capability = clearCapability();
  let owner = 'operations-race-ceiling-1';
  await claim(fixture, capability, owner, 60_000);
  for (let attempt = 1; attempt < 8; attempt += 1) {
    expect(await invokeWorker<{ applied: boolean }>(
      capability,
      `select * from public.plan7a_operations_relinquish_job(
        $1, $2, $3, $4, 'Transient job handler failure', 1
      )`,
      [fixture.internalJobId, owner, attempt, attempt]
    )).toEqual([{ applied: true }]);
    await waitUntilDue(fixture.internalJobId);
    capability = clearCapability();
    owner = `operations-race-ceiling-${attempt + 1}`;
    expect(await claim(
      fixture,
      capability,
      owner,
      attempt === 7 ? 50 : 60_000
    )).toMatchObject([{ attempt: attempt + 1, lease_generation: attempt + 1 }]);
  }
  return { capability, owner };
}

describe('Plan 7A operations concurrency authority', () => {
  it('serializes exact and conflicting same-key submissions without raw uniqueness errors', async () => {
    const actorId = await createActor();
    const target = await createTarget();
    const idempotencyKey = randomUUID();
    const exactArguments = submissionArguments(
      actorId, target, idempotencyKey, 'dependency_recovered', 'plan7a-race-a'
    );
    const exact = await Promise.all([
      databaseClient.pool.query<{ command_id: string }>(SUBMIT_SQL, [...exactArguments]),
      databaseClient.pool.query<{ command_id: string }>(SUBMIT_SQL, [
        ...exactArguments.slice(0, 7), 'plan7a-race-b', ...exactArguments.slice(8)
      ])
    ]);
    expect(exact[0].rows[0]!.command_id).toBe(exact[1].rows[0]!.command_id);
    expect((await ownerDatabaseClient.pool.query(`
      select
        (select count(*)::integer from operations_job_retry_commands) as commands,
        (select count(*)::integer from jobs
          where type = 'operations.job-retry-command') as jobs,
        (select count(*)::integer from audit_events
          where action = 'operations.job_retry.requested') as audits
    `)).rows[0]).toEqual({ commands: 1, jobs: 1, audits: 1 });

    await ownerDatabaseClient.pool.query(`
      truncate operations_job_retry_claims, operations_job_retry_commands,
        audit_events, jobs restart identity cascade
    `);
    const conflictingTarget = await createTarget();
    const conflictKey = randomUUID();
    const results = await Promise.allSettled([
      databaseClient.pool.query(
        SUBMIT_SQL,
        [...submissionArguments(
          actorId, conflictingTarget, conflictKey, 'dependency_recovered', 'plan7a-conflict-a'
        )]
      ),
      databaseClient.pool.query(
        SUBMIT_SQL,
        [...submissionArguments(
          actorId, conflictingTarget, conflictKey, 'operator_reassessment', 'plan7a-conflict-b'
        )]
      )
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? databaseError(rejected.reason) : undefined)
      .toEqual({ code: '40900', message: 'job retry command idempotency conflict' });
    expect((await ownerDatabaseClient.pool.query(`
      select
        (select count(*)::integer from operations_job_retry_commands) as commands,
        (select count(*)::integer from jobs
          where type = 'operations.job-retry-command') as jobs,
        (select count(*)::integer from audit_events
          where action = 'operations.job_retry.requested') as audits
    `)).rows[0]).toEqual({ commands: 1, jobs: 1, audits: 1 });
  });

  it('observes lease issuance after a visible command-row wait', async () => {
    const fixture = await createFixture();
    const blocker = await ownerDatabaseClient.pool.connect();
    const transaction = await beginCapabilityTransaction(
      'plan7a-post-lock-lease-clock', clearCapability()
    );
    try {
      await blocker.query('begin');
      await blocker.query(
        'select id from operations_job_retry_commands where id = $1 for update',
        [fixture.commandId]
      );
      const operation = transaction.client.query(
        'select * from public.plan7a_operations_claim_job($1, $2, 50)',
        [fixture.internalJobId, 'operations-clock-worker']
      );
      const blockers = await waitForBlocked(
        transaction.pid,
        'plan7a-post-lock-lease-clock',
        operation
      );
      expect(blockers).toContain((await blocker.query<{ pid: number }>(
        'select pg_backend_pid() as pid'
      )).rows[0]!.pid);
      await blocker.query('select pg_sleep(0.15)');
      const releaseClock = (await blocker.query<{ released_at: Date }>(
        'select clock_timestamp() as released_at'
      )).rows[0]!.released_at;
      await blocker.query('rollback');
      expect((await within(operation, 'claim did not resume after command lock')).rows)
        .toHaveLength(1);
      await transaction.client.query('commit');
      const state = await ownerDatabaseClient.pool.query<{
        issued_at: Date;
        expires_at: Date;
      }>('select issued_at, expires_at from operations_job_retry_claims where job_id = $1', [
        fixture.internalJobId
      ]);
      expect(state.rows[0]!.issued_at.getTime()).toBeGreaterThanOrEqual(releaseClock.getTime());
      expect(state.rows[0]!.expires_at.getTime() - state.rows[0]!.issued_at.getTime())
        .toBe(50);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await transaction.client.query('rollback').catch(() => undefined);
      transaction.client.release();
    }
  });

  it('serializes administrator decisions and shared handler versus exclusive takeover leases', async () => {
    const actorId = await createActor();
    const target = await createTarget();
    const adminBlocker = await ownerDatabaseClient.pool.connect();
    const runtime = await databaseClient.pool.connect();
    try {
      await adminBlocker.query('begin');
      await adminBlocker.query(
        `select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
      );
      const runtimePid = await namedTransaction(runtime, 'plan7a-admin-submit-waiter');
      const blockerPid = (await adminBlocker.query<{ pid: number }>(
        'select pg_backend_pid() as pid'
      )).rows[0]!.pid;
      const submission = runtime.query(
        SUBMIT_SQL,
        [...submissionArguments(
          actorId, target, randomUUID(), 'dependency_recovered', 'plan7a-admin-wait'
        )]
      );
      expect(await waitForBlocked(runtimePid, 'plan7a-admin-submit-waiter', submission))
        .toContain(blockerPid);
      await adminBlocker.query('rollback');
      expect((await within(submission, 'submission did not resume')).rows).toHaveLength(1);
      await runtime.query('commit');
    } finally {
      await adminBlocker.query('rollback').catch(() => undefined);
      adminBlocker.release();
      await runtime.query('rollback').catch(() => undefined);
      runtime.release();
    }

    const fixture = await createFixture();
    const firstCapability = clearCapability();
    await claim(fixture, firstCapability, 'operations-handler-a', 500);
    const handler = await beginCapabilityTransaction(
      'plan7a-shared-handler', firstCapability
    );
    let takeover: Awaited<ReturnType<typeof beginCapabilityTransaction>> | undefined;
    try {
      expect((await handler.client.query(
        `select * from public.plan7a_operations_lock_job_retry_command(
          $1, $2, $3, 1, 1
        )`,
        [fixture.internalJobId, fixture.commandId, 'operations-handler-a']
      )).rows).toHaveLength(1);
      for (let poll = 0; poll < 400; poll += 1) {
        const expired = await ownerDatabaseClient.pool.query<{ expired: boolean }>(
          'select run_at <= clock_timestamp() as expired from jobs where id = $1',
          [fixture.internalJobId]
        );
        if (expired.rows[0]?.expired) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      takeover = await beginCapabilityTransaction(
        'plan7a-exclusive-takeover', clearCapability()
      );
      const takeoverOperation = takeover.client.query(
        'select * from public.plan7a_operations_claim_job($1, $2, 5000)',
        [fixture.internalJobId, 'operations-handler-b']
      );
      expect(await waitForBlocked(
        takeover.pid,
        'plan7a-exclusive-takeover',
        takeoverOperation
      )).toContain(handler.pid);
      const leaseLocks = await ownerDatabaseClient.pool.query<{
        mode: string;
        granted: boolean;
      }>(`
        with lease_key as (
          select hashtextextended(
            'pale-orbit:plan7a-operations-job-lease:' || $1::uuid::text, 0
          ) as value
        )
        select lock.mode, lock.granted
        from pg_catalog.pg_locks lock cross join lease_key
        where lock.locktype = 'advisory'
          and lock.classid::bigint = ((lease_key.value >> 32) & 4294967295::bigint)
          and lock.objid::bigint = (lease_key.value & 4294967295::bigint)
        order by lock.granted desc, lock.mode
      `, [fixture.internalJobId]);
      expect(leaseLocks.rows).toEqual(expect.arrayContaining([
        { mode: 'ShareLock', granted: true },
        { mode: 'ExclusiveLock', granted: false }
      ]));
      await handler.client.query('commit');
      expect((await within(takeoverOperation, 'takeover did not resume')).rows[0])
        .toMatchObject({ attempt: 2, lease_generation: 2 });
      await takeover.client.query('commit');
    } finally {
      await handler.client.query('rollback').catch(() => undefined);
      handler.client.release();
      if (takeover !== undefined) {
        await takeover.client.query('rollback').catch(() => undefined);
        takeover.client.release();
      }
    }
  }, 20_000);

  it('serializes racing final-attempt synchronizers without duplicate terminal effects', async () => {
    const fixture = await createFixture();
    const finalClaim = await advanceToFinalAttempt(fixture);
    await waitUntilDue(fixture.internalJobId);
    const blocker = await ownerDatabaseClient.pool.connect();
    const firstCapability = clearCapability();
    const secondCapability = clearCapability();
    const first = await beginCapabilityTransaction(
      'plan7a-terminal-sync-race-a',
      firstCapability
    );
    const second = await beginCapabilityTransaction(
      'plan7a-terminal-sync-race-b',
      secondCapability
    );
    try {
      await blocker.query('begin');
      await blocker.query('select id from jobs where id = $1 for update', [fixture.internalJobId]);
      const blockerPid = (await blocker.query<{ pid: number }>(
        'select pg_backend_pid() as pid'
      )).rows[0]!.pid;
      const firstOperation = first.client.query(
        'select * from public.plan7a_operations_claim_job($1, $2, 4321)',
        [fixture.internalJobId, 'operations-terminal-race-a']
      );
      const secondOperation = second.client.query(
        'select * from public.plan7a_operations_claim_job($1, $2, 9876)',
        [fixture.internalJobId, 'operations-terminal-race-b']
      );
      expect(await waitForBlocked(
        first.pid,
        'plan7a-terminal-sync-race-a',
        firstOperation
      )).toContain(blockerPid);
      const secondBlockers = await waitForBlocked(
        second.pid,
        'plan7a-terminal-sync-race-b',
        secondOperation
      );
      expect(secondBlockers.some((pid) => pid === blockerPid || pid === first.pid)).toBe(true);
      await blocker.query('rollback');
      const winner = await within(Promise.race([
        firstOperation.then((result) => ({ name: 'first' as const, result })),
        secondOperation.then((result) => ({ name: 'second' as const, result }))
      ]), 'no terminal synchronizer won the race');
      expect(winner.result.rows).toEqual([]);
      const winnerTransaction = winner.name === 'first' ? first : second;
      const loserTransaction = winner.name === 'first' ? second : first;
      const loserOperation = winner.name === 'first' ? secondOperation : firstOperation;
      await winnerTransaction.client.query('commit');
      expect((await within(
        loserOperation,
        'losing terminal synchronizer did not finish after winner commit'
      )).rows).toEqual([]);
      await loserTransaction.client.query('commit');

      const terminal = await ownerDatabaseClient.pool.query<{
        command_status: string;
        result_code: string;
        job_status: string;
        attempts: number;
        generation: number;
        capability_sha256: string;
        duration: number;
        claim_state: string;
        terminal_audits: number;
      }>(`
        select command.status::text as command_status,
          command.safe_result_code::text as result_code,
          job.status::text as job_status, job.attempts,
          claim.generation, claim.capability_sha256,
          claim.lease_duration_ms as duration,
          claim.state::text as claim_state,
          (select count(*)::integer from audit_events audit
            where audit.resource_id = command.id::text
              and audit.action = 'operations.job_retry.failed') as terminal_audits
        from operations_job_retry_commands command
        join jobs job on job.payload = jsonb_build_object('commandId', command.id)
        join operations_job_retry_claims claim on claim.job_id = job.id
        where command.id = $1
      `, [fixture.commandId]);
      expect(terminal.rows[0]).toMatchObject({
        command_status: 'failed',
        result_code: 'retry_command_exhausted',
        job_status: 'failed',
        attempts: 8,
        generation: 9,
        claim_state: 'invalidated',
        terminal_audits: 1
      });
      const winningCapabilities = [firstCapability, secondCapability]
        .filter((candidate) => terminal.rows[0]!.capability_sha256 ===
          createHash('sha256').update(candidate, 'utf8').digest('hex'));
      expect(winningCapabilities).toHaveLength(1);
      expect(terminal.rows[0]!.duration).toBe(
        winningCapabilities[0] === firstCapability ? 4_321 : 9_876
      );
      for (const candidate of [
        { clear: finalClaim.capability, owner: finalClaim.owner, generation: 8 },
        { clear: firstCapability, owner: 'operations-terminal-race-a', generation: 9 },
        { clear: secondCapability, owner: 'operations-terminal-race-b', generation: 9 }
      ]) {
        await expectDatabaseError(
          invokeWorker(
            candidate.clear,
            'select * from public.plan7a_operations_renew_job_claim($1, $2, 8, $3)',
            [fixture.internalJobId, candidate.owner, candidate.generation]
          ),
          AUTHORITY_ERROR
        );
      }
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await first.client.query('rollback').catch(() => undefined);
      first.client.release();
      await second.client.query('rollback').catch(() => undefined);
      second.client.release();
    }
  }, 20_000);

  it('reauthorizes the actor at terminal execution and rolls back forced audit failure', async () => {
    const fixture = await createFixture();
    const capability = clearCapability();
    await claim(fixture, capability, 'operations-terminal-worker', 60_000);
    await expectDatabaseError(
      (async () => {
        const transaction = await beginCapabilityTransaction(
          `plan7a-authorized-denial-${randomUUID()}`, capability
        );
        try {
          return await transaction.client.query(
            `select * from public.plan7a_operations_transition_job_retry_command(
              $1, $2, $3, 1, 1, 'actor_not_authorized'
            )`,
            [fixture.internalJobId, fixture.commandId, 'operations-terminal-worker']
          );
        } finally {
          await transaction.client.query('rollback').catch(() => undefined);
          transaction.client.release();
        }
      })(),
      AUTHORITY_ERROR
    );
    await ownerDatabaseClient.pool.query(
      `delete from user_roles where user_id = $1 and role = 'admin'`,
      [fixture.actorId]
    );
    await expectDatabaseError(
      (async () => {
        const transaction = await beginCapabilityTransaction(
          `plan7a-stale-role-${randomUUID()}`, capability
        );
        try {
          return await transaction.client.query(
            `select * from public.plan7a_operations_transition_job_retry_command(
              $1, $2, $3, 1, 1, 'retry_policy_not_enabled'
            )`,
            [fixture.internalJobId, fixture.commandId, 'operations-terminal-worker']
          );
        } finally {
          await transaction.client.query('rollback').catch(() => undefined);
          transaction.client.release();
        }
      })(),
      AUTHORITY_ERROR
    );

    await ownerDatabaseClient.pool.query(`
      create function public.plan7a_test_force_operations_audit_failure()
      returns trigger language plpgsql as $body$
      begin
        if pg_catalog.left(new.action, 21) = 'operations.job_retry.' then
          raise exception using errcode = '55000', message = 'forced operations audit failure';
        end if;
        return new;
      end
      $body$;
      create trigger plan7a_test_force_operations_audit_failure
      before insert on public.audit_events for each row
      execute function public.plan7a_test_force_operations_audit_failure()
    `);
    try {
      const transition = beginCapabilityTransaction(
        `plan7a-audit-rollback-${randomUUID()}`, capability
      );
      const transaction = await transition;
      try {
        await expectDatabaseError(
          transaction.client.query(
            `select * from public.plan7a_operations_transition_job_retry_command(
              $1, $2, $3, 1, 1, 'actor_not_authorized'
            )`,
            [fixture.internalJobId, fixture.commandId, 'operations-terminal-worker']
          ),
          { code: '55000', message: 'forced operations audit failure' }
        );
        await transaction.client.query('rollback');
      } finally {
        transaction.client.release();
      }
      expect((await ownerDatabaseClient.pool.query(
        'select status, safe_result_code from operations_job_retry_commands where id = $1',
        [fixture.commandId]
      )).rows[0]).toEqual({ status: 'pending', safe_result_code: null });
    } finally {
      await ownerDatabaseClient.pool.query(`
        drop trigger if exists plan7a_test_force_operations_audit_failure
          on public.audit_events;
        drop function if exists public.plan7a_test_force_operations_audit_failure()
      `);
    }
  });
});
