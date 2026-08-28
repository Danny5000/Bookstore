import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';

import type { Database } from '../../db/client';
import type { DatabaseTransaction } from '../../db/transaction';
import {
  definitionForJobKind,
  JOB_RETRY_POLICY_IDS,
  type JobRetryPolicyId,
  type RegisteredJobKind
} from '../../jobs/catalog';
import {
  DefiniteRetryableJobError,
  PermanentJobError,
  runWorker
} from '../../jobs/runner';
import type { JobRecord, JobRepository } from '../../jobs/types';
import {
  InvalidJobRetryPolicyIdentityError,
  type JobRetryPolicyAdapter
} from './policies';
import { createOperationsJobRetryHandler } from './handler';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_JOB_ID = '44444444-4444-4444-8444-444444444444';
const CAPABILITY = 'CapabilityCanary_'.padEnd(43, 'x');
const UPDATED_AT = '2026-08-26T12:34:56.123456Z';
const COMPLETED_AT = '2026-08-26T12:35:00.654321Z';
const STARTUP_ERROR =
  'Operations job retry policies do not exactly match the registered policy catalog';
const INVALID_IDENTITY = 'Invalid operations job retry command identity.';
const UNKNOWN_OUTCOME = 'Operations job execution outcome is unknown';

interface LockRow extends Record<string, unknown> {
  commandId: unknown;
  commandStatus: unknown;
  resultCode: unknown;
  actorAuthorized: unknown;
  actorUserId: unknown;
  targetJobId: unknown;
  targetJobKind: unknown;
  expectedStatus: unknown;
  expectedAttempts: unknown;
  expectedMaxAttempts: unknown;
  expectedUpdatedAt: unknown;
  reasonCode: unknown;
  correlationId: unknown;
}

interface TransitionRow extends Record<string, unknown> {
  commandId: unknown;
  commandStatus: unknown;
  resultCode: unknown;
  completedAt: unknown;
}

function rendered(query: SQL): { readonly sql: string; readonly params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`
  });
}

function job(overrides: Record<string, unknown> = {}): JobRecord {
  return {
    id: JOB_ID,
    type: 'operations.job-retry-command',
    payload: { commandId: COMMAND_ID },
    deduplicationKey: `operations:job-retry-command:${COMMAND_ID}:v1`,
    attempts: 2,
    maxAttempts: 8,
    lockedBy: 'worker-task15:0',
    operationsJobLeaseCapability: CAPABILITY,
    operationsJobLeaseGeneration: 7,
    ...overrides
  } as unknown as JobRecord;
}

function lockRow(
  overrides: Record<string, unknown> = {},
  targetKind: RegisteredJobKind = 'commerce.stripe-event'
): LockRow {
  const definition = definitionForJobKind(targetKind)!;
  return {
    commandId: COMMAND_ID,
    commandStatus: 'pending',
    resultCode: null,
    actorAuthorized: true,
    actorUserId: ACTOR_ID,
    targetJobId: TARGET_JOB_ID,
    targetJobKind: targetKind,
    expectedStatus: 'failed',
    expectedAttempts: definition.maxAttempts,
    expectedMaxAttempts: definition.maxAttempts,
    expectedUpdatedAt: UPDATED_AT,
    reasonCode: 'dependency_recovered',
    correlationId: 'correlation.task15',
    ...overrides
  };
}

function transitionRow(overrides: Record<string, unknown> = {}): TransitionRow {
  return {
    commandId: COMMAND_ID,
    commandStatus: 'succeeded',
    resultCode: 'rearmed_existing',
    completedAt: COMPLETED_AT,
    ...overrides
  };
}

interface DatabaseHarnessOptions {
  readonly lockRows?: readonly unknown[];
  readonly transitionRows?: readonly unknown[];
  readonly lockFailure?: unknown;
  readonly transitionFailure?: unknown;
  readonly afterCallbackFailure?: unknown;
  readonly onLock?: () => void;
  readonly onTransition?: () => void;
}

function databaseHarness(options: DatabaseHarnessOptions = {}) {
  const calls: SQL[] = [];
  let rolledBack = false;
  const execute = vi.fn(async (query: SQL) => {
    calls.push(query);
    const text = rendered(query).sql;
    if (text.includes('set_config')) return { rows: [] };
    if (text.includes('plan7a_operations_lock_job_retry_command')) {
      options.onLock?.();
      if (Object.hasOwn(options, 'lockFailure')) throw options.lockFailure;
      return { rows: options.lockRows ?? [lockRow()] };
    }
    if (text.includes('plan7a_operations_transition_job_retry_command')) {
      options.onTransition?.();
      if (Object.hasOwn(options, 'transitionFailure')) throw options.transitionFailure;
      return { rows: options.transitionRows ?? [transitionRow()] };
    }
    throw new Error('Unexpected handler SQL');
  });
  const transactionObject = { execute } as unknown as DatabaseTransaction;
  const transaction = vi.fn(async (
    callback: (transaction: DatabaseTransaction) => Promise<unknown>
  ) => {
    let callbackReturned = false;
    try {
      const value = await callback(transactionObject);
      callbackReturned = true;
      if (Object.hasOwn(options, 'afterCallbackFailure')) {
        throw options.afterCallbackFailure;
      }
      return value;
    } catch (error: unknown) {
      if (!callbackReturned) rolledBack = true;
      throw error;
    }
  });
  return {
    database: { transaction } as unknown as Database,
    transaction,
    transactionObject,
    execute,
    calls,
    get rolledBack() { return rolledBack; }
  };
}

function policyFixture(overrides: Partial<Record<JobRetryPolicyId, JobRetryPolicyAdapter>> = {}) {
  const denyRetryNotSupported = vi.fn<JobRetryPolicyAdapter>(async () => Object.freeze({
    status: 'denied', resultCode: 'retry_not_supported'
  }));
  const denyRetryPolicyNotEnabled = vi.fn<JobRetryPolicyAdapter>(async () => Object.freeze({
    status: 'denied', resultCode: 'retry_policy_not_enabled'
  }));
  const denyProviderRecoveryNotEnabled = vi.fn<JobRetryPolicyAdapter>(async () => Object.freeze({
    status: 'denied', resultCode: 'provider_recovery_not_enabled'
  }));
  const rearmPendingStripeEvent = vi.fn<JobRetryPolicyAdapter>(async () => Object.freeze({
    status: 'succeeded', resultCode: 'rearmed_existing'
  }));
  const rearmFinancialClassification = vi.fn<JobRetryPolicyAdapter>(async () => Object.freeze({
    status: 'succeeded', resultCode: 'rearmed_existing'
  }));
  const byId = {
    deny_retry_not_supported: denyRetryNotSupported,
    deny_retry_policy_not_enabled: denyRetryPolicyNotEnabled,
    deny_provider_recovery_not_enabled: denyProviderRecoveryNotEnabled,
    rearm_pending_stripe_event: rearmPendingStripeEvent,
    rearm_financial_classification: rearmFinancialClassification,
    ...overrides
  } satisfies Record<JobRetryPolicyId, JobRetryPolicyAdapter>;
  return {
    byId,
    map: new Map(JOB_RETRY_POLICY_IDS.map((id) => [id, byId[id]] as const))
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected promise to reject');
}

function expectCauseFree(error: unknown, message: string): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ message });
  expect(error).not.toHaveProperty('cause');
  expect(String(error)).not.toContain(CAPABILITY);
  expect(JSON.stringify(error)).not.toContain(CAPABILITY);
}

function queryNames(calls: readonly SQL[]): string[] {
  return calls.map((query) => {
    const text = rendered(query).sql;
    if (text.includes('set_config')) return 'capability';
    if (text.includes('plan7a_operations_lock_job_retry_command')) return 'lock';
    if (text.includes('plan7a_operations_transition_job_retry_command')) return 'transition';
    return 'unexpected';
  });
}

describe('createOperationsJobRetryHandler', () => {
  it.each([
    ['missing policy', () => {
      const fixture = policyFixture();
      fixture.map.delete('deny_provider_recovery_not_enabled');
      return fixture.map;
    }],
    ['extra policy', () => {
      const fixture = policyFixture();
      (fixture.map as Map<string, JobRetryPolicyAdapter>).set('extra', async () => ({
        status: 'denied', resultCode: 'retry_not_supported'
      }));
      return fixture.map;
    }],
    ['reordered policy', () => {
      const fixture = policyFixture();
      return new Map([...fixture.map].reverse());
    }],
    ['nonfunction policy', () => {
      const fixture = policyFixture();
      (fixture.map as Map<string, unknown>).set('rearm_pending_stripe_event', null);
      return fixture.map;
    }],
    ['proxied policy', () => {
      const fixture = policyFixture();
      fixture.map.set(
        'rearm_pending_stripe_event',
        new Proxy(fixture.byId.rearm_pending_stripe_event, {})
      );
      return fixture.map;
    }],
    ['proxied map', () => new Proxy(policyFixture().map, {})]
  ])('rejects a %s map with the one fixed startup error', (_label, createMap) => {
    const database = databaseHarness();
    expect(() => createOperationsJobRetryHandler({
      database: database.database,
      policies: createMap() as ReadonlyMap<JobRetryPolicyId, JobRetryPolicyAdapter>
    })).toThrow(STARTUP_ERROR);
  });

  it('copies the canonical policy map and executes the exact protected routine sequence', async () => {
    const controller = new AbortController();
    const fixture = policyFixture();
    const original = vi.mocked(fixture.byId.rearm_pending_stripe_event);
    const record = job();
    const database = databaseHarness({
      onLock: () => Object.assign(record, {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        lockedBy: 'mutated-owner',
        attempts: 8,
        operationsJobLeaseGeneration: 99,
        operationsJobLeaseCapability: 'M'.repeat(43)
      })
    });
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: fixture.map
    });
    fixture.map.set('rearm_pending_stripe_event', vi.fn<JobRetryPolicyAdapter>(async () => ({
      status: 'denied', resultCode: 'target_state_changed'
    })));
    await expect(handler(record, controller.signal)).resolves.toBeUndefined();

    expect(queryNames(database.calls)).toEqual(['capability', 'lock', 'transition']);
    const queries = database.calls.map(rendered);
    expect(queries[0]!.params).toEqual([CAPABILITY]);
    expect(queries[0]!.sql).toMatch(
      /set_config\(\s*'pale_orbit[.]plan7a_operations_job_capability'\s*,\s*\$1\s*,\s*true\s*\)/u
    );
    expect(queries[1]!.params).toEqual([
      JOB_ID, COMMAND_ID, 'worker-task15:0', 2, 7
    ]);
    expect(queries[2]!.params).toEqual([
      JOB_ID, COMMAND_ID, 'worker-task15:0', 2, 7, 'rearmed_existing'
    ]);
    expect(original).toHaveBeenCalledOnce();
    const policyContext = original.mock.calls[0]![0];
    expect(Object.keys(policyContext)).toEqual(['transaction', 'target', 'signal']);
    expect(policyContext.transaction).toBe(database.transactionObject);
    expect(policyContext.signal).toBe(controller.signal);
    expect(policyContext.target).toEqual({
      commandId: COMMAND_ID,
      targetJobId: TARGET_JOB_ID,
      expectedKind: 'commerce.stripe-event',
      expectedStatus: 'failed',
      expectedAttempts: 12,
      expectedMaxAttempts: 12,
      expectedUpdatedAt: UPDATED_AT
    });
    expect(Object.isFrozen(policyContext.target)).toBe(true);
    expect(JSON.stringify(queries.slice(1))).not.toContain(CAPABILITY);
  });

  it.each([
    ['wrong kind', { type: 'commerce.stripe-event' }],
    ['wrong job ID', { id: 'not-a-uuid' }],
    ['zero attempt', { attempts: 0 }],
    ['attempt beyond maximum', { attempts: 9 }],
    ['wrong maximum', { maxAttempts: 7 }],
    ['unsafe lease owner', { lockedBy: 'unsafe owner' }],
    ['missing capability', { operationsJobLeaseCapability: undefined }],
    ['short capability', { operationsJobLeaseCapability: 'short' }],
    ['zero generation', { operationsJobLeaseGeneration: 0 }],
    ['financial capability field', { financialAdminLeaseCapability: undefined }],
    ['wrong dedupe', { deduplicationKey: 'operations:wrong' }],
    ['extra payload key', { payload: { commandId: COMMAND_ID, extra: true } }],
    ['noncanonical command ID', {
      payload: { commandId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }
    }],
    ['inherited payload', { payload: Object.create({ commandId: COMMAND_ID }) }],
    ['proxied payload', { payload: new Proxy({ commandId: COMMAND_ID }, {}) }]
  ])('rejects a %s before acquiring a transaction', async (_label, override) => {
    const database = databaseHarness();
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: policyFixture().map
    });

    const error = await rejection(handler(job(override), new AbortController().signal));

    expect(error).toBeInstanceOf(PermanentJobError);
    expectCauseFree(error, INVALID_IDENTITY);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects an accessor payload without invoking it', async () => {
    const payload = {};
    const accessor = vi.fn(() => COMMAND_ID);
    Object.defineProperty(payload, 'commandId', { enumerable: true, get: accessor });
    const database = databaseHarness();
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: policyFixture().map
    });

    const error = await rejection(handler(job({ payload }), new AbortController().signal));

    expect(error).toBeInstanceOf(PermanentJobError);
    expect(accessor).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: 'outbox.dispatch' as const,
      policy: 'deny_retry_policy_not_enabled' as const,
      outcome: { status: 'denied', resultCode: 'retry_policy_not_enabled' } as const
    },
    {
      kind: 'commerce.stripe-event' as const,
      policy: 'rearm_pending_stripe_event' as const,
      outcome: { status: 'succeeded', resultCode: 'rearmed_existing' } as const
    },
    {
      kind: 'commerce.financial-classification' as const,
      policy: 'rearm_financial_classification' as const,
      outcome: { status: 'denied', resultCode: 'source_unavailable' } as const
    },
    {
      kind: 'commerce.financial-admin-command' as const,
      policy: 'deny_retry_not_supported' as const,
      outcome: { status: 'denied', resultCode: 'retry_not_supported' } as const
    }
  ])('dispatches $kind only through $policy', async ({ kind, policy, outcome }) => {
    const selected = vi.fn<JobRetryPolicyAdapter>(async () => Object.freeze(outcome));
    const fixture = policyFixture({ [policy]: selected });
    const database = databaseHarness({
      lockRows: [lockRow({}, kind)],
      transitionRows: [transitionRow({
        commandStatus: outcome.status,
        resultCode: outcome.resultCode
      })]
    });
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: fixture.map
    });

    await handler(job(), new AbortController().signal);

    expect(selected).toHaveBeenCalledOnce();
    for (const [id, candidate] of Object.entries(fixture.byId)) {
      if (id !== policy) expect(candidate).not.toHaveBeenCalled();
    }
    expect(rendered(database.calls[2]!).params.at(-1)).toBe(outcome.resultCode);
  });

  it.each([
    ['succeeded', 'rearmed_existing'],
    ['denied', 'target_state_changed'],
    ['failed', 'retry_command_invalid']
  ] as const)('replays a terminal %s command without policy or transition', async (
    commandStatus,
    resultCode
  ) => {
    const fixture = policyFixture();
    const database = databaseHarness({
      lockRows: [lockRow({ commandStatus, resultCode, actorAuthorized: false })]
    });
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: fixture.map
    });

    await expect(handler(job(), new AbortController().signal)).resolves.toBeUndefined();

    expect(queryNames(database.calls)).toEqual(['capability', 'lock']);
    expect(Object.values(fixture.byId).every((policy) =>
      vi.mocked(policy).mock.calls.length === 0
    )).toBe(true);
  });

  it('terminalizes actor demotion without invoking any policy', async () => {
    const fixture = policyFixture();
    const database = databaseHarness({
      lockRows: [lockRow({ actorAuthorized: false })],
      transitionRows: [transitionRow({
        commandStatus: 'denied', resultCode: 'actor_not_authorized'
      })]
    });
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: fixture.map
    });

    await handler(job(), new AbortController().signal);

    expect(Object.values(fixture.byId).every((policy) =>
      vi.mocked(policy).mock.calls.length === 0
    )).toBe(true);
    expect(rendered(database.calls[2]!).params.at(-1)).toBe('actor_not_authorized');
  });

  it.each([
    ['missing row', []],
    ['duplicate row', [lockRow(), lockRow()]],
    ['extra field', [{ ...lockRow(), extra: true }]],
    ['wrong command', [lockRow({ commandId: TARGET_JOB_ID })]],
    ['pending result', [lockRow({ resultCode: 'rearmed_existing' })]],
    ['invalid terminal result', [lockRow({
      commandStatus: 'succeeded', resultCode: 'retry_not_supported'
    })]],
    ['invalid actor flag', [lockRow({ actorAuthorized: 'true' })]],
    ['unknown target kind', [lockRow({ targetJobKind: 'unknown.kind' })]],
    ['wrong expected status', [lockRow({ expectedStatus: 'pending' })]],
    ['attempt beyond maximum', [lockRow({ expectedAttempts: 13 })]],
    ['catalog maximum mismatch', [lockRow({ expectedMaxAttempts: 11 })]],
    ['invalid timestamp', [lockRow({ expectedUpdatedAt: '2026-02-30T00:00:00.000000Z' })]],
    ['invalid reason', [lockRow({ reasonCode: 'private-canary' })]],
    ['invalid correlation', [lockRow({ correlationId: 'unsafe correlation' })]]
  ])('converts a malformed lock %s to the fixed permanent identity error', async (
    _label,
    lockRows
  ) => {
    const database = databaseHarness({ lockRows });
    const fixture = policyFixture();
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: fixture.map
    });

    const error = await rejection(handler(job(), new AbortController().signal));

    expect(error).toBeInstanceOf(PermanentJobError);
    expectCauseFree(error, INVALID_IDENTITY);
    expect(database.rolledBack).toBe(true);
    expect(queryNames(database.calls)).toEqual(['capability', 'lock']);
    expect(Object.values(fixture.byId).every((policy) =>
      vi.mocked(policy).mock.calls.length === 0
    )).toBe(true);
  });

  it.each([
    ['missing row', []],
    ['duplicate row', [transitionRow(), transitionRow()]],
    ['extra field', [{ ...transitionRow(), extra: true }]],
    ['wrong command', [transitionRow({ commandId: TARGET_JOB_ID })]],
    ['wrong status', [transitionRow({ commandStatus: 'denied' })]],
    ['wrong result', [transitionRow({ resultCode: 'target_state_changed' })]],
    ['invalid completed timestamp', [transitionRow({
      completedAt: '2026-02-30T00:00:00.000000Z'
    })]]
  ])('rolls back a malformed transition %s as invalid identity', async (
    _label,
    transitionRows
  ) => {
    const database = databaseHarness({ transitionRows });
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: policyFixture().map
    });

    const error = await rejection(handler(job(), new AbortController().signal));

    expect(error).toBeInstanceOf(PermanentJobError);
    expectCauseFree(error, INVALID_IDENTITY);
    expect(database.rolledBack).toBe(true);
    expect(queryNames(database.calls)).toEqual(['capability', 'lock', 'transition']);
  });

  it('rejects a cross-policy result before transition', async () => {
    const invalidPolicy = vi.fn<JobRetryPolicyAdapter>(async () => ({
      status: 'denied', resultCode: 'retry_policy_not_enabled'
    }));
    const database = databaseHarness();
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: policyFixture({ rearm_pending_stripe_event: invalidPolicy }).map
    });

    const error = await rejection(handler(job(), new AbortController().signal));

    expect(error).toBeInstanceOf(PermanentJobError);
    expectCauseFree(error, INVALID_IDENTITY);
    expect(queryNames(database.calls)).toEqual(['capability', 'lock']);
    expect(database.rolledBack).toBe(true);
  });

  it.each([
    ['Stripe event', 'commerce.stripe-event', 'rearm_pending_stripe_event'],
    [
      'financial classification',
      'commerce.financial-classification',
      'rearm_financial_classification'
    ]
  ] as const)(
    'routes a %s retry-command-invalid outcome through rollback settlement',
    async (_label, targetKind, policyId) => {
      const invalidPolicy = vi.fn<JobRetryPolicyAdapter>(async () => ({
        status: 'failed', resultCode: 'retry_command_invalid'
      }));
      const database = databaseHarness({
        lockRows: [lockRow({}, targetKind)],
        transitionFailure: new Error('forbidden-transition-private-canary')
      });
      const policyOverrides: Partial<Record<JobRetryPolicyId, JobRetryPolicyAdapter>> = {
        [policyId]: invalidPolicy
      };
      const handler = createOperationsJobRetryHandler({
        database: database.database,
        policies: policyFixture(policyOverrides).map
      });

      const error = await rejection(handler(job(), new AbortController().signal));

      expect(error).toBeInstanceOf(PermanentJobError);
      expectCauseFree(error, INVALID_IDENTITY);
      expect(queryNames(database.calls)).toEqual(['capability', 'lock']);
      expect(database.rolledBack).toBe(true);
    }
  );

  it('checks abort immediately before policy', async () => {
    const controller = new AbortController();
    const fixture = policyFixture();
    const database = databaseHarness({ onLock: () => controller.abort(new Error('private')) });
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: fixture.map
    });

    const error = await rejection(handler(job(), controller.signal));

    expect(error).toBeInstanceOf(DefiniteRetryableJobError);
    expectCauseFree(error, 'Retryable job handler transaction failed');
    expect(queryNames(database.calls)).toEqual(['capability', 'lock']);
    expect(fixture.byId.rearm_pending_stripe_event).not.toHaveBeenCalled();
    expect(database.rolledBack).toBe(true);
  });

  it('checks abort after policy and immediately before transition', async () => {
    const controller = new AbortController();
    const policy = vi.fn<JobRetryPolicyAdapter>(async () => {
      controller.abort(new Error('post-policy-private'));
      return { status: 'succeeded', resultCode: 'rearmed_existing' };
    });
    const database = databaseHarness();
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: policyFixture({ rearm_pending_stripe_event: policy }).map
    });

    const error = await rejection(handler(job(), controller.signal));

    expect(error).toBeInstanceOf(DefiniteRetryableJobError);
    expect(queryNames(database.calls)).toEqual(['capability', 'lock']);
    expect(database.rolledBack).toBe(true);
    expect(String(error)).not.toContain('post-policy-private');
  });

  it.each([
    ['definite marker', new DefiniteRetryableJobError()],
    ['permanent marker', new PermanentJobError('Bounded permanent marker')]
  ])('preserves a policy %s through transaction rollback', async (_label, marker) => {
    const policy = vi.fn<JobRetryPolicyAdapter>(async () => { throw marker; });
    const database = databaseHarness();
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: policyFixture({ rearm_pending_stripe_event: policy }).map
    });

    await expect(handler(job(), new AbortController().signal)).rejects.toBe(marker);
    expect(database.rolledBack).toBe(true);
  });

  it('converts a policy identity marker only after confirmed rollback', async () => {
    const marker = new InvalidJobRetryPolicyIdentityError();
    const policy = vi.fn<JobRetryPolicyAdapter>(async () => { throw marker; });
    const database = databaseHarness();
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: policyFixture({ rearm_pending_stripe_event: policy }).map
    });

    const error = await rejection(handler(job(), new AbortController().signal));

    expect(error).not.toBe(marker);
    expect(error).toBeInstanceOf(PermanentJobError);
    expectCauseFree(error, INVALID_IDENTITY);
    expect(database.rolledBack).toBe(true);
  });

  it('maps an unknown callback error to one fresh definite-rollback marker', async () => {
    const original = new Error(`private ${CAPABILITY}`);
    Object.defineProperty(original, 'cause', { value: { private: true } });
    const database = databaseHarness({ lockFailure: original });
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: policyFixture().map
    });

    const error = await rejection(handler(job(), new AbortController().signal));

    expect(error).not.toBe(original);
    expect(error).toBeInstanceOf(DefiniteRetryableJobError);
    expectCauseFree(error, 'Retryable job handler transaction failed');
    expect(database.rolledBack).toBe(true);
  });

  it('maps a revoked callback error without inspecting the hostile value', async () => {
    const hostile = Proxy.revocable({}, {});
    hostile.revoke();
    const database = databaseHarness({ lockFailure: hostile.proxy });
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: policyFixture().map
    });

    const error = await rejection(handler(job(), new AbortController().signal));

    expect(error).toBeInstanceOf(DefiniteRetryableJobError);
    expectCauseFree(error, 'Retryable job handler transaction failed');
    expect(database.rolledBack).toBe(true);
  });

  it.each([
    ['pending transition', lockRow()],
    ['terminal replay', lockRow({
      commandStatus: 'succeeded', resultCode: 'rearmed_existing'
    })]
  ])('maps a post-callback %s commit failure to a fresh unknown outcome', async (
    _label,
    lockedCommand
  ) => {
    const original = new Error(`commit-private ${CAPABILITY}`);
    const database = databaseHarness({
      lockRows: [lockedCommand],
      afterCallbackFailure: original
    });
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: policyFixture().map
    });

    const error = await rejection(handler(job(), new AbortController().signal));

    expect(error).not.toBe(original);
    expectCauseFree(error, UNKNOWN_OUTCOME);
    expect(database.rolledBack).toBe(false);
  });

  it('rolls back an invalid primitive postcondition and lets the runner settle it once', async () => {
    const durableState = 'original';
    let stagedState = durableState;
    const markerPolicy = vi.fn<JobRetryPolicyAdapter>(async () => {
      stagedState = 'mutated';
      return { status: 'failed', resultCode: 'retry_command_invalid' };
    });
    const database = databaseHarness();
    const originalTransaction = database.transaction.getMockImplementation()!;
    database.transaction.mockImplementation(async (callback) => {
      try {
        return await originalTransaction(callback);
      } catch (error: unknown) {
        stagedState = durableState;
        throw error;
      }
    });
    const handler = createOperationsJobRetryHandler({
      database: database.database,
      policies: policyFixture({ rearm_pending_stripe_event: markerPolicy }).map
    });
    const record = job();
    const failOperationsJob = vi.fn().mockResolvedValue({
      applied: true, retryScheduled: false
    });
    const completeOperationsJob = vi.fn().mockResolvedValue(true);
    const genericFailure = vi.fn().mockResolvedValue({
      applied: true, retryScheduled: true
    });
    const repository: JobRepository = {
      claimNext: vi.fn().mockResolvedValueOnce(record).mockResolvedValue(null),
      renewLease: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
      failWithDisposition: genericFailure,
      renewOperationsJobLease: vi.fn().mockResolvedValue(true),
      completeOperationsJob,
      failOperationsJob
    };
    const controller = new AbortController();

    await runWorker({
      repository,
      handlers: new Map([[record.type, handler]]),
      workerId: 'worker-task15',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      sleep: async () => controller.abort()
    });

    expect(stagedState).toBe(durableState);
    expect(queryNames(database.calls)).toEqual(['capability', 'lock']);
    expect(failOperationsJob).toHaveBeenCalledOnce();
    expect(failOperationsJob.mock.calls[0]?.slice(1)).toEqual([
      INVALID_IDENTITY, false
    ]);
    expect(completeOperationsJob).not.toHaveBeenCalled();
    expect(genericFailure).not.toHaveBeenCalled();
  });
});
