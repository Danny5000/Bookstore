import { isProxy } from 'node:util/types';
import { DrizzleQueryError, type SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import type { CorrelationId } from '$lib/server/observability/contracts';
import {
  JobOperationsAuthorizationChangedError,
  JobRetryCommandSubmissionConflictError,
  createPostgresJobOperationsRepository,
  type SubmitJobRetryCommandRepositoryInput
} from './repository';

const ACTOR_ID = '00000000-0000-4000-8000-000000000101';
const JOB_ID = '00000000-0000-4000-8000-000000000202';
const COMMAND_ID = '00000000-0000-4000-8000-000000000303';
const TIMESTAMP_1 = '2026-08-26T14:15:16.123456Z';
const TIMESTAMP_2 = '2026-08-26T14:15:17.234567Z';
const TIMESTAMP_3 = '2026-08-26T14:15:18.345678Z';
const IDEMPOTENCY_HASH = 'a'.repeat(64);
const FINGERPRINT_HASH = 'b'.repeat(64);
const CORRELATION_ID = 'operations-retry-101' as CorrelationId;

function validJob(changes: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    jobId: JOB_ID,
    kind: 'commerce.stripe-event',
    label: 'Stripe event',
    status: 'failed',
    attempts: 12,
    maxAttempts: 12,
    runAt: TIMESTAMP_1,
    completedAt: TIMESTAMP_2,
    createdAt: TIMESTAMP_1,
    updatedAt: TIMESTAMP_2,
    retryDisposition: 'rearm_existing',
    policyAvailability: 'enabled',
    safeFailureCode: 'source_unavailable',
    ...changes
  };
}

function validStatus(changes: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    commandId: COMMAND_ID,
    kind: 'retry_failed_job',
    targetJobId: JOB_ID,
    targetKind: 'commerce.stripe-event',
    reasonCode: 'dependency_recovered',
    correlationId: CORRELATION_ID,
    status: 'pending',
    resultCode: null,
    createdAt: TIMESTAMP_2,
    updatedAt: TIMESTAMP_2,
    completedAt: null,
    ...changes
  };
}

function databaseWithResults(...results: readonly unknown[]): {
  readonly database: Database;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly calls: SQL[];
} {
  const calls: SQL[] = [];
  let index = 0;
  const execute = vi.fn(async (query: SQL) => {
    calls.push(query);
    const result = results[index++];
    if (result instanceof Error) throw result;
    if (typeof result === 'function') return (result as () => unknown)();
    return result;
  });
  return { database: { execute } as unknown as Database, execute, calls };
}

function rendered(query: SQL): { readonly sql: string; readonly params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
}

function compact(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(/[(] /gu, '(').replace(/ [)]/gu, ')').trim();
}

async function repositoryFailure(operation: () => Promise<unknown>): Promise<Error> {
  const failure = await operation().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  return failure as Error;
}

async function expectRepositoryError(operation: () => Promise<unknown>): Promise<Error> {
  const failure = await repositoryFailure(operation);
  expect(failure).toMatchObject({
    name: 'JobOperationsRepositoryError',
    message: 'Job operations repository returned invalid data.'
  });
  expect(Object.hasOwn(failure, 'cause')).toBe(false);
  expect(JSON.stringify(failure)).not.toMatch(
    /payload|dedup|raw|lease|private|hash|actor|provider|select|routine/iu
  );
  return failure;
}

function listInput() {
  return {
    actorId: ACTOR_ID,
    kind: 'commerce.stripe-event' as const,
    status: 'failed' as const,
    limit: 2,
    cursor: { updatedAt: TIMESTAMP_2, jobId: JOB_ID }
  };
}

function submissionInput(): SubmitJobRetryCommandRepositoryInput {
  return {
    actorId: ACTOR_ID,
    command: {
      idempotencyKey: '00000000-0000-4000-8000-000000000404',
      targetJobId: JOB_ID,
      expectedKind: 'commerce.stripe-event' as const,
      expectedStatus: 'failed' as const,
      expectedAttempts: 12,
      expectedMaxAttempts: 12,
      expectedUpdatedAt: TIMESTAMP_2,
      reasonCode: 'dependency_recovered' as const
    },
    correlationId: CORRELATION_ID,
    idempotencyKeySha256: IDEMPOTENCY_HASH,
    inputFingerprintSha256: FINGERPRINT_HASH
  };
}

describe('protected job operations repository SQL', () => {
  it('calls only the list routine with exact aliases, order, bound values, and timestamp cast', async () => {
    const row = validJob();
    const { database, calls } = databaseWithResults({ rows: [row] });
    const repository = createPostgresJobOperationsRepository(database);

    const result = await repository.listOperationalJobs(listInput());

    expect(result).toEqual([row]);
    expect(result[0]).not.toBe(row);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(calls).toHaveLength(1);
    const query = rendered(calls[0]!);
    expect(compact(query.sql)).toBe(compact(`
      select job_id as "jobId", kind, label, status, attempts,
        max_attempts as "maxAttempts", run_at as "runAt",
        completed_at as "completedAt", created_at as "createdAt",
        updated_at as "updatedAt", retry_disposition as "retryDisposition",
        policy_availability as "policyAvailability",
        safe_failure_code as "safeFailureCode"
      from public.list_operational_jobs($1, $2, $3, $4::timestamptz, $5, $6)
    `));
    expect(query.params).toEqual([
      ACTOR_ID, 'failed', 'commerce.stripe-event', TIMESTAMP_2, JOB_ID, 2
    ]);
    expect(query.params[3]).toBeTypeOf('string');
    expect(query.params.some((value) => value instanceof Date)).toBe(false);
  });

  it('passes absent list filters and cursor as null scalar parameters in exact routine order', async () => {
    const { database, calls } = databaseWithResults({ rows: [] });
    const repository = createPostgresJobOperationsRepository(database);
    await expect(repository.listOperationalJobs({ actorId: ACTOR_ID, limit: 100 }))
      .resolves.toEqual([]);
    expect(rendered(calls[0]!).params).toEqual([ACTOR_ID, null, null, null, null, 100]);
  });

  it('calls only the submit routine with exact aliases, order, scalar values, and timestamp cast', async () => {
    const row = validStatus();
    const { database, calls } = databaseWithResults({ rows: [row] });
    const repository = createPostgresJobOperationsRepository(database);

    await expect(repository.submitJobRetryCommand(submissionInput())).resolves.toEqual(row);

    expect(calls).toHaveLength(1);
    const query = rendered(calls[0]!);
    expect(compact(query.sql)).toBe(compact(`
      select command_id as "commandId", kind, target_job_id as "targetJobId",
        target_kind as "targetKind", reason_code as "reasonCode",
        correlation_id as "correlationId", status, result_code as "resultCode",
        created_at as "createdAt", updated_at as "updatedAt",
        completed_at as "completedAt"
      from public.submit_job_retry_command(
        $1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10
      )
    `));
    expect(query.params).toEqual([
      ACTOR_ID,
      JOB_ID,
      'commerce.stripe-event',
      12,
      12,
      TIMESTAMP_2,
      'dependency_recovered',
      'operations-retry-101',
      IDEMPOTENCY_HASH,
      FINGERPRINT_HASH
    ]);
    expect(query.params[5]).toBeTypeOf('string');
    const serialized = JSON.stringify(query);
    expect(serialized).not.toContain(submissionInput().command.idempotencyKey);
    expect(serialized).not.toMatch(/expectedStatus|canonicalInput|actorRoles|targetPayload/iu);
  });

  it('calls only the owned-status routine with exact aliases and actor-first arguments', async () => {
    const row = validStatus({ status: 'succeeded', resultCode: 'rearmed_existing',
      completedAt: TIMESTAMP_3, updatedAt: TIMESTAMP_3 });
    const { database, calls } = databaseWithResults({ rows: [row] });
    const repository = createPostgresJobOperationsRepository(database);

    await expect(repository.getOwnedJobRetryCommand({ actorId: ACTOR_ID, commandId: COMMAND_ID }))
      .resolves.toEqual(row);

    const query = rendered(calls[0]!);
    expect(compact(query.sql)).toBe(compact(`
      select command_id as "commandId", kind, target_job_id as "targetJobId",
        target_kind as "targetKind", reason_code as "reasonCode",
        correlation_id as "correlationId", status, result_code as "resultCode",
        created_at as "createdAt", updated_at as "updatedAt",
        completed_at as "completedAt"
      from public.get_owned_job_retry_command($1, $2)
    `));
    expect(query.params).toEqual([ACTOR_ID, COMMAND_ID]);
  });
});

describe('protected job operations repository row reconstruction', () => {
  it('rejects malformed query result containers and a list larger than the requested limit', async () => {
    const hostileRows = Object.defineProperty({}, 'rows', {
      get: () => { throw new Error('private-result-canary'); }
    });
    for (const result of [null, undefined, {}, { rows: null }, { rows: {} }, hostileRows]) {
      const harness = databaseWithResults(() => result);
      await expectRepositoryError(() =>
        createPostgresJobOperationsRepository(harness.database)
          .listOperationalJobs({ actorId: ACTOR_ID, limit: 1 })
      );
    }
    const overLimit = databaseWithResults({ rows: [validJob(), validJob()] });
    await expectRepositoryError(() =>
      createPostgresJobOperationsRepository(overLimit.database)
        .listOperationalJobs({ actorId: ACTOR_ID, limit: 1 })
    );
  });

  it('rejects malformed or sensitive list rows through the shared strict DTO parser', async () => {
    const malformed = [
      validJob({ label: 'Stripe webhook' }),
      validJob({ maxAttempts: 11 }),
      validJob({ retryDisposition: 'enqueue_successor' }),
      validJob({ policyAvailability: 'disabled' }),
      validJob({ updatedAt: '2026-08-26T14:15:17.234Z' }),
      validJob({ payload: { private: true } }),
      validJob({ deduplicationKey: 'private' }),
      validJob({ rawError: 'private' }),
      validJob({ lease: 'private' }),
      validJob({ privateInput: 'private' }),
      validJob({ inputFingerprintSha256: FINGERPRINT_HASH }),
      validJob({ actor: ACTOR_ID }),
      validJob({ provider: 'stripe' })
    ];
    for (const row of malformed) {
      const { database } = databaseWithResults({ rows: [row] });
      await expectRepositoryError(() =>
        createPostgresJobOperationsRepository(database).listOperationalJobs(listInput())
      );
    }
  });

  it('rejects zero/multiple submit rows and invalid status/result families or private columns', async () => {
    const invalidRows = [
      [],
      [validStatus(), validStatus()],
      [validStatus({ status: 'pending', resultCode: 'rearmed_existing' })],
      [validStatus({ status: 'succeeded', resultCode: 'target_state_changed',
        completedAt: TIMESTAMP_3 })],
      [validStatus({ status: 'denied', resultCode: 'rearmed_existing',
        completedAt: TIMESTAMP_3 })],
      [validStatus({ status: 'failed', resultCode: null, completedAt: TIMESTAMP_3 })],
      [validStatus({ payload: 'private' })],
      [validStatus({ idempotencyKeySha256: IDEMPOTENCY_HASH })],
      [validStatus({ actorUserId: ACTOR_ID })],
      [validStatus({ provider: 'private' })]
    ];
    for (const rows of invalidRows) {
      const { database } = databaseWithResults({ rows });
      await expectRepositoryError(() =>
        createPostgresJobOperationsRepository(database).submitJobRetryCommand(submissionInput())
      );
    }
  });

  it('returns null only for no owned status row and rejects multiple or malformed status rows', async () => {
    const absent = databaseWithResults({ rows: [] });
    await expect(createPostgresJobOperationsRepository(absent.database)
      .getOwnedJobRetryCommand({ actorId: ACTOR_ID, commandId: COMMAND_ID }))
      .resolves.toBeNull();

    for (const rows of [
      [validStatus(), validStatus()],
      [validStatus({ updatedAt: new Date(0) })],
      [validStatus({ privateInput: 'private' })]
    ]) {
      const { database } = databaseWithResults({ rows });
      await expectRepositoryError(() =>
        createPostgresJobOperationsRepository(database)
          .getOwnedJobRetryCommand({ actorId: ACTOR_ID, commandId: COMMAND_ID })
      );
    }
  });

  it('rejects accessor array elements without reading them for list, submit, or status', async () => {
    const operations = [
      (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
        repository.listOperationalJobs(listInput()),
      (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
        repository.submitJobRetryCommand(submissionInput()),
      (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
        repository.getOwnedJobRetryCommand({ actorId: ACTOR_ID, commandId: COMMAND_ID })
    ];
    const outcomes = await Promise.all(operations.map(async (operation) => {
      let reads = 0;
      const rows: unknown[] = [];
      Object.defineProperty(rows, '0', {
        configurable: true,
        enumerable: true,
        get: () => {
          reads += 1;
          throw new Error('private-array-element-canary');
        }
      });
      const { database } = databaseWithResults({ rows });
      const failure = await repositoryFailure(() =>
        operation(createPostgresJobOperationsRepository(database))
      );
      return { failure, reads };
    }));
    for (const { failure, reads } of outcomes) {
      expect(failure).toMatchObject({
        name: 'JobOperationsRepositoryError',
        message: 'Job operations repository returned invalid data.'
      });
      expect(Object.hasOwn(failure, 'cause')).toBe(false);
      expect(reads).toBe(0);
    }
  });

  it('does not look up an overridden array map property while reconstructing list rows', async () => {
    let reads = 0;
    const rows = [validJob()];
    Object.defineProperty(rows, 'map', {
      get: () => {
        reads += 1;
        throw new Error('private-array-map-canary');
      }
    });
    const { database } = databaseWithResults({ rows });
    await expect(createPostgresJobOperationsRepository(database).listOperationalJobs(listInput()))
      .resolves.toEqual([validJob()]);
    expect(reads).toBe(0);
  });
});

describe('protected job operations repository error translation', () => {
  it('maps a submit 40900 own data code to fresh fixed detail-free conflicts', async () => {
    const operation = async () => {
      const failure = Object.assign(new Error('private database conflict'), { code: '40900' });
      const { database } = databaseWithResults(failure);
      return createPostgresJobOperationsRepository(database).submitJobRetryCommand(submissionInput());
    };
    const first = await repositoryFailure(operation);
    const second = await repositoryFailure(operation);
    expect(first).toEqual(new JobRetryCommandSubmissionConflictError());
    expect(second).toEqual(new JobRetryCommandSubmissionConflictError());
    expect(first).not.toBe(second);
    expect(Object.hasOwn(first, 'cause')).toBe(false);
    expect(JSON.stringify(first)).not.toContain('private database conflict');
  });

  it('maps a 42501 own data code from each routine to fresh fixed authorization errors', async () => {
    const operations = [
      (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
        repository.listOperationalJobs(listInput()),
      (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
        repository.submitJobRetryCommand(submissionInput()),
      (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
        repository.getOwnedJobRetryCommand({ actorId: ACTOR_ID, commandId: COMMAND_ID })
    ];
    for (const operation of operations) {
      const invoke = async () => {
        const failure = Object.assign(new Error('private database authorization'), { code: '42501' });
        const { database } = databaseWithResults(failure);
        return operation(createPostgresJobOperationsRepository(database));
      };
      const first = await repositoryFailure(invoke);
      const second = await repositoryFailure(invoke);
      expect(first).toEqual(new JobOperationsAuthorizationChangedError());
      expect(second).toEqual(new JobOperationsAuthorizationChangedError());
      expect(first).not.toBe(second);
      expect(Object.hasOwn(first, 'cause')).toBe(false);
      expect(JSON.stringify(first)).not.toContain('private database authorization');
    }
  });

  it('maps SQLSTATEs from the installed Drizzle query wrapper without leaking it', async () => {
    const cases = [
      {
        code: '40900',
        expected: new JobRetryCommandSubmissionConflictError(),
        operation: (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
          repository.submitJobRetryCommand(submissionInput())
      },
      ...[
        (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
          repository.listOperationalJobs(listInput()),
        (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
          repository.submitJobRetryCommand(submissionInput()),
        (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
          repository.getOwnedJobRetryCommand({ actorId: ACTOR_ID, commandId: COMMAND_ID })
      ].map((operation) => ({
        code: '42501',
        expected: new JobOperationsAuthorizationChangedError(),
        operation
      }))
    ];
    for (const { code, expected, operation } of cases) {
      const cause = Object.assign(new Error('private driver detail'), { code });
      const wrapper = new DrizzleQueryError(
        'select private_query_text from private_relation where actor_id = $1',
        ['private-parameter'],
        cause
      );
      const { database } = databaseWithResults(wrapper);
      const failure = await repositoryFailure(() =>
        operation(createPostgresJobOperationsRepository(database))
      );
      expect(failure).toEqual(expected);
      expect(Object.hasOwn(failure, 'cause')).toBe(false);
      expect(JSON.stringify(failure)).not.toMatch(
        /private driver detail|private_query_text|private_relation|private-parameter/iu
      );
    }
  });

  it('does not read hostile Drizzle causes or unwrap cause-shaped non-wrappers', async () => {
    let causeReads = 0;
    let proxyTraps = 0;
    const accessorWrapper = new DrizzleQueryError('private accessor query', [], new Error());
    Object.defineProperty(accessorWrapper, 'cause', {
      get: () => {
        causeReads += 1;
        throw new Error('private-cause-accessor-canary');
      }
    });
    const proxyCause = new Proxy(Object.assign(new Error('proxy cause'), { code: '42501' }), {
      getOwnPropertyDescriptor: () => {
        proxyTraps += 1;
        throw new Error('private-cause-proxy-canary');
      },
      get: () => {
        proxyTraps += 1;
        throw new Error('private-cause-proxy-canary');
      }
    });
    const proxyWrapper = new DrizzleQueryError(
      'private proxy query',
      [],
      proxyCause as Error
    );
    const causeShaped = Object.assign(new Error('not a Drizzle wrapper'), {
      cause: Object.assign(new Error('nested code'), { code: '42501' })
    });

    for (const failure of [accessorWrapper, proxyWrapper, causeShaped]) {
      const execute = vi.fn(async () => { throw failure; });
      const database = { execute } as unknown as Database;
      const observed = await createPostgresJobOperationsRepository(database)
        .listOperationalJobs(listInput())
        .catch((error: unknown) => error);
      expect(observed).toBe(failure);
    }
    expect(causeReads).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  it('does not inspect inherited, accessor, or proxy error codes and propagates unchanged', async () => {
    let accessorReads = 0;
    const inherited = Object.create({ code: '42501' }) as Error;
    Object.defineProperties(inherited, {
      name: { value: 'Error', enumerable: false },
      message: { value: 'inherited-code', enumerable: false }
    });
    const accessor = Object.defineProperty(new Error('accessor-code'), 'code', {
      get: () => {
        accessorReads += 1;
        return '42501';
      }
    });
    let proxyTraps = 0;
    const proxy = new Proxy(new Error('proxy-code'), {
      getOwnPropertyDescriptor: () => {
        proxyTraps += 1;
        throw new Error('private-proxy-canary');
      },
      get: () => {
        proxyTraps += 1;
        throw new Error('private-proxy-canary');
      }
    });
    expect(isProxy(proxy)).toBe(true);

    for (const failure of [inherited, accessor, proxy]) {
      const execute = vi.fn(async () => { throw failure; });
      const database = { execute } as unknown as Database;
      let propagatedUnchanged = false;
      try {
        await createPostgresJobOperationsRepository(database).listOperationalJobs(listInput());
      } catch (error) {
        propagatedUnchanged = error === failure;
      }
      expect(propagatedUnchanged).toBe(true);
    }
    expect(accessorReads).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  it('requires exact string SQLSTATE values and limits conflict translation to submission', async () => {
    const cases = [
      {
        failure: Object.assign(new Error('numeric authorization lookalike'), { code: 42501 }),
        operation: (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
          repository.listOperationalJobs(listInput())
      },
      {
        failure: Object.assign(new Error('numeric conflict lookalike'), { code: 40900 }),
        operation: (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
          repository.submitJobRetryCommand(submissionInput())
      },
      {
        failure: Object.assign(new Error('list conflict'), { code: '40900' }),
        operation: (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
          repository.listOperationalJobs(listInput())
      },
      {
        failure: Object.assign(new Error('status conflict'), { code: '40900' }),
        operation: (repository: ReturnType<typeof createPostgresJobOperationsRepository>) =>
          repository.getOwnedJobRetryCommand({ actorId: ACTOR_ID, commandId: COMMAND_ID })
      }
    ];
    for (const { failure, operation } of cases) {
      const execute = vi.fn(async () => { throw failure; });
      const database = { execute } as unknown as Database;
      let propagatedUnchanged = false;
      try {
        await operation(createPostgresJobOperationsRepository(database));
      } catch (error) {
        propagatedUnchanged = error === failure;
      }
      expect(propagatedUnchanged).toBe(true);
    }
  });

  it('propagates every other database failure unchanged', async () => {
    for (const failure of [
      new Error('ordinary failure'),
      Object.assign(new Error('invalid input'), { code: '22023' }),
      Object.assign(new Error('worker state'), { code: '55000' }),
      'non-object failure',
      null
    ]) {
      const execute = vi.fn(async () => { throw failure; });
      const database = { execute } as unknown as Database;
      const observed = await createPostgresJobOperationsRepository(database)
        .getOwnedJobRetryCommand({ actorId: ACTOR_ID, commandId: COMMAND_ID })
        .catch((error: unknown) => error);
      expect(observed).toBe(failure);
    }
  });
});
