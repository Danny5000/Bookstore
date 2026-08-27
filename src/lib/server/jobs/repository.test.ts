import { createHash } from 'node:crypto';
import { DrizzleQueryError, type SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { JobRow } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  createFinancialPayoutContinuationJob,
  createFinancialSourceScanJob
} from '$lib/server/commerce/financial/jobs';
import * as jobRepository from './repository';
import {
  createPostgresJobRepository,
  enqueueActiveEntityJob,
  enqueueJob,
  jobInsertQuery
} from './repository';
import type {
  OperationsJobLeaseAuthority,
  OperationsJobSafeError
} from './types';

const SOURCE_ID = '00000000-0000-4000-8000-000000001611';
const NOW = new Date('2026-08-12T12:00:00.000Z');
const FINANCIAL_ADMIN_JOB = 'commerce.financial-admin-command';
const FINANCIAL_ADMIN_COMMAND_ID = '00000000-0000-4000-8000-000000001701';
const FINANCIAL_ADMIN_JOB_ID = '00000000-0000-4000-8000-000000001702';
const FINANCIAL_ADMIN_LEASE_CAPABILITY = 'B'.repeat(43);
const OPERATIONS_JOB = 'operations.job-retry-command';
const OPERATIONS_COMMAND_ID = '00000000-0000-4000-8000-000000001801';
const OPERATIONS_JOB_ID = '00000000-0000-4000-8000-000000001802';
const OPERATIONS_LEASE_CAPABILITY = 'O'.repeat(43);
const OPERATIONS_WORKER = 'operations-worker';

function jobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: '00000000-0000-4000-8000-000000001612',
    type: 'commerce.financial-source',
    payload: {
      sourceKind: 'refund', sourceId: SOURCE_ID,
      trigger: { kind: 'event', providerEventId: 'evt_repository_1611' }
    },
    deduplicationKey: 'stripe:financial-source:event:evt_repository_1611',
    status: 'pending',
    runAt: NOW,
    attempts: 0,
    maxAttempts: 12,
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    rerunRequestedAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function transaction(responses: readonly unknown[][]): {
  readonly calls: SQL[];
  readonly transaction: DatabaseTransaction;
} {
  const calls: SQL[] = [];
  let index = 0;
  return {
    calls,
    transaction: {
      rollback: vi.fn(() => { throw new Error('rollback should not be called'); }),
      execute: vi.fn(async (query: SQL) => {
        calls.push(query);
        return { rows: responses[index++] ?? [] };
      })
    } as never
  };
}

function sourceInput(activeEntity: {
  sourceKind: 'payment' | 'refund' | 'dispute';
  sourceId: string;
} = {
  sourceKind: 'refund', sourceId: SOURCE_ID
}) {
  return {
    type: 'commerce.financial-source' as const,
    payload: {
      sourceKind: 'refund', sourceId: SOURCE_ID,
      trigger: { kind: 'event', providerEventId: 'evt_repository_1611' }
    },
    deduplicationKey: 'stripe:financial-source:event:evt_repository_1611',
    maxAttempts: 12,
    activeEntity
  };
}

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
}

describe('job enqueue insert authority', () => {
  it('offers a runtime-safe reference seam that never selects a full job row', async () => {
    const enqueueReference = (jobRepository as unknown as Record<string, unknown>)
      .enqueueJobReference;
    expect(typeof enqueueReference).toBe('function');
    if (typeof enqueueReference !== 'function') return;

    const execute = vi.fn(async (_query: SQL) => ({
      rows: [{
        id: '00000000-0000-4000-8000-000000001612',
        deduplicationKey: 'email:test:v1'
      }]
    }));
    const select = vi.fn(() => {
      throw new Error('runtime-safe enqueue must not select jobs');
    });
    const result = await (enqueueReference as (
      database: unknown,
      input: unknown
    ) => Promise<unknown>)({ execute, select }, {
      type: 'commerce.email',
      payload: { purpose: 'test' },
      deduplicationKey: 'email:test:v1',
      maxAttempts: 7
    });

    expect(result).toEqual({ id: '00000000-0000-4000-8000-000000001612' });
    expect(execute).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    const query = rendered(execute.mock.calls[0]![0] as SQL).sql;
    expect(query).not.toContain('as "deduplicationKey"');
  });

  it('recovers a concurrently committed replay through an ID-only follow-up read', async () => {
    const existingId = '00000000-0000-4000-8000-000000001613';
    const execute = vi.fn(async () => ({ rows: [] }));
    const limit = vi.fn(async () => [{ id: existingId }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    await expect(jobRepository.enqueueJobReference({ execute, select } as never, {
      type: 'commerce.email',
      payload: { purpose: 'test' },
      deduplicationKey: 'email:test:race:v1',
      maxAttempts: 7
    })).resolves.toEqual({ id: existingId });

    expect(select).toHaveBeenCalledWith({ id: expect.anything() });
    expect(limit).toHaveBeenCalledWith(1);
  });

  it('targets only the five runtime-granted columns and preserves defaults', async () => {
    const query = rendered(jobInsertQuery({
      type: 'commerce.email',
      payload: { purpose: 'test' },
      deduplicationKey: 'email:test:v1',
      maxAttempts: 7
    }));
    const normalized = query.sql.replace(/\s+/gu, ' ').trim();
    expect(normalized).toMatch(
      /^insert into "public"\."jobs" \(\s*"type", "payload", "deduplication_key", "run_at", "max_attempts"\s*\) values /u
    );
    expect(normalized).toContain('on conflict ("deduplication_key") do nothing returning');
    expect(normalized).toMatch(/returning "id"$/u);
    expect(normalized).toContain('coalesce($4::timestamptz, pg_catalog.now())');
    expect(normalized).not.toContain('pg_catalog.coalesce(');
    expect(normalized.slice(0, normalized.indexOf(' values '))).not.toMatch(
      /"(?:id|status|attempts|locked_at|locked_by|last_error|rerun_requested_at|completed_at|created_at|updated_at)"/u
    );
    expect(query.params).toEqual([
      'commerce.email',
      JSON.stringify({ purpose: 'test' }),
      'email:test:v1',
      null,
      7
    ]);

    const inserted = jobRow({
      type: 'commerce.email',
      payload: { purpose: 'test' },
      deduplicationKey: 'email:test:v1',
      maxAttempts: 7
    });
    const execute = vi.fn(async () => ({ rows: [{ id: inserted.id }] }));
    const select = vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: async () => [inserted] })
      })
    }));
    const result = await enqueueJob({ execute, select } as never, {
      type: 'commerce.email',
      payload: { purpose: 'test' },
      deduplicationKey: 'email:test:v1',
      maxAttempts: 7
    });
    expect(result).toEqual(inserted);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(execute).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
  });
});

describe('Stripe event job rearm authority', () => {
  it('delegates one Stripe event id to the owner-defined database routine', async () => {
    const calls: SQL[] = [];
    const database = {
      execute: vi.fn(async (query: SQL) => {
        calls.push(query);
        return { rows: [{ rearmed: true }] };
      })
    };
    const rearm = (jobRepository as unknown as Record<string, unknown>)
      .rearmPendingStripeEventJob;

    expect(typeof rearm).toBe('function');
    if (typeof rearm !== 'function') return;
    await expect((rearm as (
      database: unknown,
      stripeEventId: string
    ) => Promise<boolean>)(database, SOURCE_ID)).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    const query = rendered(calls[0]!);
    expect(query.sql).toContain('rearm_pending_stripe_event_job');
    expect(query.params).toEqual([SOURCE_ID]);
  });
});

describe('active entity jobs', () => {
  async function expectSafeInvalid(input: unknown): Promise<void> {
    const database = transaction([]);
    const failure = await enqueueActiveEntityJob(database.transaction, input as never)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain('private-canary');
    expect(database.calls).toHaveLength(0);
  }

  it('returns the exact permanent-dedupe row before considering another active generation', async () => {
    const exact = jobRow({
      status: 'succeeded', completedAt: NOW
    });
    const database = transaction([[], [exact]]);

    await expect(enqueueActiveEntityJob(database.transaction, sourceInput()))
      .resolves.toEqual(exact);
    expect(database.calls).toHaveLength(2);
    expect(rendered(database.calls[1]!).sql).toContain('deduplication_key');
  });

  it('fails closed when a permanent key resolves to a different job identity', async () => {
    const collision = jobRow({
      payload: {
        sourceKind: 'refund',
        sourceId: '00000000-0000-4000-8000-000000001699',
        trigger: { kind: 'event', providerEventId: 'evt_repository_1611' }
      }
    });
    const database = transaction([[], [collision]]);

    let failure: unknown;
    try {
      await enqueueActiveEntityJob(database.transaction, sourceInput());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain('00000000-0000-4000-8000-000000001699');
    expect(database.calls).toHaveLength(2);
  });

  it('uses a JSON subset and marks a running entity for one durable rerun', async () => {
    const active = jobRow({ status: 'running', attempts: 1, lockedAt: NOW, lockedBy: 'worker-a' });
    const marked = { ...active, rerunRequestedAt: NOW };
    const database = transaction([[], [], [active], [marked]]);
    const scan = createFinancialSourceScanJob({
      sourceKind: 'refund',
      sourceId: SOURCE_ID,
      scanRunId: '00000000-0000-4000-8000-000000001613',
      scanGenerationHour: '2026-08-12T12:00:00.000Z'
    });

    await expect(enqueueActiveEntityJob(database.transaction, {
      ...scan,
      activeEntity: { sourceKind: scan.payload.sourceKind, sourceId: scan.payload.sourceId }
    })).resolves.toEqual(marked);

    const activeQuery = rendered(database.calls[2]!);
    expect(activeQuery.sql).toContain("status in ('pending', 'running')");
    expect(activeQuery.sql).toContain('payload @>');
    expect(activeQuery.sql).toContain(
      "payload -> 'trigger' ->> 'kind' is distinct from 'continuation'"
    );
    expect(activeQuery.sql).toContain('order by created_at, id');
    expect(activeQuery.params).toContain(JSON.stringify({ sourceId: SOURCE_ID, sourceKind: 'refund' }));
    expect(rendered(database.calls[3]!).sql).toContain('rerun_requested_at');
  });

  it('derives one code-point-canonical advisory identity independent of object insertion order', async () => {
    const first = transaction([[], [], [jobRow()]]);
    const second = transaction([[], [], [jobRow()]]);
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => { throw new Error('locale ordering is not deterministic'); });
    try {
      await enqueueActiveEntityJob(first.transaction, sourceInput({
        sourceKind: 'refund', sourceId: SOURCE_ID
      }));
      await enqueueActiveEntityJob(second.transaction, sourceInput({
        sourceId: SOURCE_ID, sourceKind: 'refund'
      }));
    } finally {
      localeCompare.mockRestore();
    }

    const firstKey = rendered(first.calls[0]!).params[0];
    const secondKey = rendered(second.calls[0]!).params[0];
    expect(firstKey).toBe(secondKey);
    expect(firstKey).toBe(
      'pale-orbit:jobs:active-entity:commerce.financial-source:' +
      JSON.stringify({ sourceId: SOURCE_ID, sourceKind: 'refund' })
    );
  });

  it('fails closed before SQL when entity identity is mismatched, nonfinancial, or private', async () => {
    const database = transaction([]);
    const inheritedEntity = Object.create({ email: 'private@example.com' });
    Object.assign(inheritedEntity, { sourceKind: 'refund', sourceId: SOURCE_ID });
    const inheritedTrigger = Object.create({ email: 'private@example.com' });
    Object.assign(inheritedTrigger, { kind: 'event', providerEventId: 'evt_repository_1611' });
    for (const input of [
      sourceInput({ sourceKind: 'payment', sourceId: SOURCE_ID }),
      { ...sourceInput(), type: 'commerce.email' },
      { ...sourceInput(), activeEntity: {
        sourceKind: 'refund', sourceId: SOURCE_ID, email: 'private@example.com'
      } },
      { ...sourceInput(), activeEntity: inheritedEntity },
      {
        ...sourceInput(),
        payload: { sourceKind: 'refund', sourceId: SOURCE_ID, trigger: inheritedTrigger }
      }
    ]) {
      let failure: unknown;
      try {
        await enqueueActiveEntityJob(database.transaction, input as never);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toHaveProperty('cause');
      expect(String(failure)).not.toContain('private@example.com');
    }
    expect(database.calls).toHaveLength(0);
  });

  it('validates the complete canonical Task 7 identity before SQL', async () => {
    const privateSymbol = Symbol('private-canary');
    const cases: unknown[] = [
      { ...sourceInput(), payload: { ...sourceInput().payload, privateField: 'private-canary' } },
      { ...sourceInput(), payload: { ...sourceInput().payload, [privateSymbol]: 'private-canary' } },
      { ...sourceInput(), payload: {
        ...sourceInput().payload, trigger: { kind: 'bogus', providerEventId: 'private-canary' }
      } },
      { ...sourceInput(), maxAttempts: 11 },
      { ...sourceInput(), deduplicationKey: 'private-canary' },
      { ...sourceInput(), runAt: new Date(Number.NaN) },
      { ...sourceInput(), privateField: 'private-canary' }
    ];
    for (const input of cases) await expectSafeInvalid(input);
  });

  it('rejects immutable-cursor payout continuations from the active-root API', async () => {
    const continuation = createFinancialPayoutContinuationJob({
      providerPayoutId: 'po_repository_continuation_1611',
      payoutId: '00000000-0000-4000-8000-000000001614',
      runId: '00000000-0000-4000-8000-000000001615',
      payoutGeneration: 0,
      cursorDigestSha256: 'b'.repeat(64)
    });
    await expectSafeInvalid({
      ...continuation,
      activeEntity: { providerPayoutId: continuation.payload.providerPayoutId }
    });
  });

  it('accepts every canonical UUID version accepted by Task 7', async () => {
    const sourceId = '00000000-0000-7000-8000-000000000001';
    const input = {
      ...sourceInput(),
      payload: {
        sourceKind: 'refund' as const,
        sourceId,
        trigger: { kind: 'event' as const, providerEventId: 'evt_repository_uuid_v7' }
      },
      deduplicationKey: 'stripe:financial-source:event:evt_repository_uuid_v7',
      activeEntity: { sourceKind: 'refund' as const, sourceId }
    };
    const exact = jobRow({
      payload: input.payload,
      deduplicationKey: input.deduplicationKey
    });
    const database = transaction([[], [exact]]);
    await expect(enqueueActiveEntityJob(database.transaction, input)).resolves.toEqual(exact);
    expect(rendered(database.calls[0]!).params[0]).toContain(sourceId);
  });

  it('rejects a base database executor before taking a statement-scoped advisory lock', async () => {
    const execute = vi.fn();
    const failure = await enqueueActiveEntityJob({ execute } as never, sourceInput())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('cause');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a malformed active row instead of suppressing canonical work', async () => {
    const malformed = jobRow({
      deduplicationKey: 'private-canary',
      payload: { ...jobRow().payload, privateField: 'private-canary' }
    });
    const database = transaction([[], [], [malformed]]);
    const failure = await enqueueActiveEntityJob(database.transaction, {
      ...sourceInput(),
      deduplicationKey:
        'financial:source:scan:refund:' + SOURCE_ID + ':2026-08-12T12:00:00.000Z'
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain('private-canary');
  });
});

describe('job claim policy', () => {
  it('renders a pending-version barrier for every provider-backed financial family', async () => {
    const claimQueries: SQL[] = [];
    const execute = vi.fn(async (query: SQL) => {
      claimQueries.push(query);
      return { rows: [] };
    });
    const transaction = { execute };
    const transact = vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work(transaction));
    const repository = createPostgresJobRepository(
      { transaction: transact } as never,
      {
        pollIntervalMs: 1,
        leaseMs: 1_000,
        retryBaseMs: 1,
        retryMaxMs: 1
      },
      () => NOW,
      'all',
      { classifierVersion: 2, allocationAlgorithmVersion: 3 }
    );

    await expect(repository.claimNext('claim-policy-worker')).resolves.toBeNull();

    expect(transact).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(claimQueries).toHaveLength(1);
    const claim = rendered(claimQueries[0]!);
    expect(claim.sql).toContain('pending_classifier_version is null');
    expect(claim.sql).toContain('pending_allocation_algorithm_version is null');
    expect(claim.sql).toContain('pending_replay_id is null');
    expect(claim.sql).toContain('pending_scan_run_id is null');
    expect(claim.params.filter((value) => value === 'commerce.stripe-event')).toHaveLength(2);
    expect(claim.params.filter((value) => value === 'commerce.financial-source'))
      .toHaveLength(2);
    expect(claim.params.filter((value) => value === 'commerce.financial-payout'))
      .toHaveLength(2);
    expect(claim.params.filter((value) => value === 'commerce.financial-scan').length)
      .toBeGreaterThanOrEqual(2);
    expect(claim.sql).toContain("payload ->> 'kind' = 'composite_replay'");
    expect(claim.sql).toContain("'classification_replay_page', 'classification_replay_finalize'");
    expect(claim.params).toEqual(expect.arrayContaining([
      'commerce.financial-classification',
      '2',
      '3'
    ]));
    expect(claim.sql).not.toContain('active_predecessor_job');
    expect(claim.sql).toMatch(
      /financial_projection_versions cleanup_authority[\s\S]+?cleanup_authority\.classifier_version[\s\S]+?cleanup_authority\.allocation_algorithm_version/u
    );
    expect(claim.sql).toMatch(
      /cleanup_authority\.classifier_version\s*=\s*\$\d+[\s\S]+?cleanup_authority\.pending_classifier_version\s*=\s*\$\d+/u
    );
  });

  it('claims one financial-admin target in one transaction with one opaque capability', async () => {
    const calls: SQL[] = [];
    const candidate = {
      ...jobRow({
        id: FINANCIAL_ADMIN_JOB_ID,
        type: FINANCIAL_ADMIN_JOB,
        payload: { commandId: FINANCIAL_ADMIN_COMMAND_ID },
        deduplicationKey:
          `commerce:financial-admin-command:${FINANCIAL_ADMIN_COMMAND_ID}:v1`,
        attempts: 0,
        maxAttempts: 8
      }),
      priorStatus: 'pending',
      hadRerunRequest: false
    };
    const claimed = {
      id: candidate.id,
      type: candidate.type,
      payload: candidate.payload,
      deduplicationKey: candidate.deduplicationKey,
      attempts: 1,
      maxAttempts: candidate.maxAttempts,
      lockedBy: 'financial-admin-worker'
    };
    const transaction = {
      execute: vi.fn(async (query: SQL) => {
        calls.push(query);
        const statement = rendered(query).sql;
        if (statement.includes('for update skip locked')) return { rows: [candidate] };
        if (statement.includes('returning') && statement.includes('update')) {
          return { rows: [claimed] };
        }
        return { rows: [] };
      })
    };
    const database = {
      execute: vi.fn(async () => ({ rows: [claimed] })),
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction))
    };
    const capabilitySource = vi.fn(() => FINANCIAL_ADMIN_LEASE_CAPABILITY);
    const repository = createPostgresJobRepository(
      database as never,
      {
        pollIntervalMs: 1,
        leaseMs: 30_000,
        retryBaseMs: 1,
        retryMaxMs: 1
      },
      () => NOW,
      'local-only',
      { classifierVersion: 2, allocationAlgorithmVersion: 3 },
      capabilitySource
    );

    await expect(repository.claimNext('financial-admin-worker')).resolves.toEqual({
      ...claimed,
      financialAdminLeaseCapability: FINANCIAL_ADMIN_LEASE_CAPABILITY
    });

    expect(database.transaction).toHaveBeenCalledOnce();
    expect(database.execute).not.toHaveBeenCalled();
    expect(capabilitySource).toHaveBeenCalledOnce();
    const statements = calls.map((query) => rendered(query));
    expect(statements.filter((item) => item.sql.includes('for update skip locked')))
      .toHaveLength(1);
    const candidateSelection = statements.find((item) =>
      item.sql.includes('for update skip locked'))!;
    expect(candidateSelection.sql).toContain('limit 1');
    expect(candidateSelection.sql).toContain(
      'jobs.run_at <= pg_catalog.clock_timestamp()'
    );
    expect(candidateSelection.sql.match(
      /jobs\.run_at <= pg_catalog\.clock_timestamp\(\)/gu
    )).toHaveLength(2);
    // The four occurrences are only the pending/running database-clock routing
    // equality/inequality branches above. Any fifth occurrence would put this
    // local command behind a provider or projection-readiness predicate.
    expect(candidateSelection.params.filter((value) => value === FINANCIAL_ADMIN_JOB))
      .toHaveLength(4);
    expect(candidateSelection.params).toContain(false);
    expect(candidateSelection.sql).not.toContain(
      "jobs.locked_at <= pg_catalog.clock_timestamp() -"
    );
    expect(candidateSelection.params).not.toContain(30_000);
    expect(statements.some((item) => item.sql.includes('with exhausted as'))).toBe(false);
    const tokenSetting = statements.find((item) =>
      item.sql.includes('plan6bii_financial_admin_job_capability'));
    expect(tokenSetting?.params).toContain(FINANCIAL_ADMIN_LEASE_CAPABILITY);
    expect(statements.some((item) =>
      item.sql.includes('plan6bii_financial_admin_job_lease_duration_ms'))).toBe(true);
    expect(statements.some((item) =>
      item.sql.includes('pg_advisory_xact_lock') &&
      item.sql.includes('pale-orbit:plan6bii-financial-admin-job-lease:'))).toBe(true);
  });

  it('does not generate a capability when no target is locked', async () => {
    const transaction = { execute: vi.fn(async () => ({ rows: [] })) };
    const database = {
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction))
    };
    const capabilitySource = vi.fn(() => FINANCIAL_ADMIN_LEASE_CAPABILITY);
    const repository = createPostgresJobRepository(
      database as never,
      {
        pollIntervalMs: 1,
        leaseMs: 30_000,
        retryBaseMs: 1,
        retryMaxMs: 1
      },
      () => NOW,
      'local-only',
      { classifierVersion: 2, allocationAlgorithmVersion: 3 },
      capabilitySource
    );

    await expect(repository.claimNext('financial-admin-worker')).resolves.toBeNull();
    expect(capabilitySource).not.toHaveBeenCalled();
  });

  it.each([3, 8])(
    'rotates an expired rerun request from attempt %i back to attempt one',
    async (priorAttempts) => {
    const calls: SQL[] = [];
    const candidate = {
      ...jobRow({
        id: FINANCIAL_ADMIN_JOB_ID,
        type: FINANCIAL_ADMIN_JOB,
        payload: { commandId: FINANCIAL_ADMIN_COMMAND_ID },
        deduplicationKey:
          `commerce:financial-admin-command:${FINANCIAL_ADMIN_COMMAND_ID}:v1`,
        status: 'running',
        attempts: priorAttempts,
        maxAttempts: 8,
        lockedAt: new Date('2026-08-12T11:00:00.000Z'),
        lockedBy: 'expired-worker',
        lastError: 'prior safe failure',
        rerunRequestedAt: new Date('2026-08-12T11:30:00.000Z')
      }),
      priorStatus: 'running' as const,
      hadRerunRequest: true
    };
    const claimed = {
      id: candidate.id,
      type: candidate.type,
      payload: candidate.payload,
      deduplicationKey: candidate.deduplicationKey,
      attempts: 1,
      maxAttempts: candidate.maxAttempts,
      lockedBy: 'rerun-worker'
    };
    const transaction = {
      execute: vi.fn(async (query: SQL) => {
        calls.push(query);
        const statement = rendered(query).sql;
        if (statement.includes('for update skip locked')) return { rows: [candidate] };
        if (statement.includes('returning jobs.id')) return { rows: [claimed] };
        return { rows: [] };
      })
    };
    const database = {
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction))
    };
    const capabilitySource = vi.fn(() => FINANCIAL_ADMIN_LEASE_CAPABILITY);
    const repository = createPostgresJobRepository(
      database as never,
      {
        pollIntervalMs: 1,
        leaseMs: 30_000,
        retryBaseMs: 1,
        retryMaxMs: 1
      },
      () => NOW,
      'local-only',
      { classifierVersion: 2, allocationAlgorithmVersion: 3 },
      capabilitySource
    );

    await expect(repository.claimNext('rerun-worker')).resolves.toEqual({
      ...claimed,
      financialAdminLeaseCapability: FINANCIAL_ADMIN_LEASE_CAPABILITY
    });
    expect(capabilitySource).toHaveBeenCalledOnce();
    const update = calls.map((query) => rendered(query)).find((statement) =>
      statement.sql.includes('returning jobs.id'));
    expect(update?.sql).toContain('then 1');
    expect(update?.sql).toContain('then null');
    expect(update?.sql).toContain('jobs.rerun_requested_at is not null');
    expect(update?.sql).toContain('jobs.attempts = jobs.max_attempts');
    expect(update?.params).toEqual(expect.arrayContaining(['running', true]));
  });

  it.each([
    { commandStatus: 'pending', terminalJobStatus: 'failed' },
    { commandStatus: 'succeeded', terminalJobStatus: 'succeeded' }
  ] as const)(
    'adopts one expired final-attempt target and maps a $commandStatus command to a $terminalJobStatus job',
    async ({ commandStatus, terminalJobStatus }) => {
    const calls: SQL[] = [];
    const candidate = {
      ...jobRow({
        id: FINANCIAL_ADMIN_JOB_ID,
        type: FINANCIAL_ADMIN_JOB,
        payload: { commandId: FINANCIAL_ADMIN_COMMAND_ID },
        deduplicationKey:
          `commerce:financial-admin-command:${FINANCIAL_ADMIN_COMMAND_ID}:v1`,
        status: 'running',
        attempts: 8,
        maxAttempts: 8,
        lockedAt: new Date('2026-08-12T11:00:00.000Z'),
        lockedBy: 'expired-worker'
      }),
      priorStatus: 'running',
      hadRerunRequest: false,
      claimExpired: true
    };
    let returnedCandidate = false;
    const transaction = {
      execute: vi.fn(async (query: SQL) => {
        calls.push(query);
        const statement = rendered(query).sql;
        if (statement.includes('for update skip locked')) {
          if (returnedCandidate) return { rows: [] };
          returnedCandidate = true;
          return { rows: [candidate] };
        }
        if (statement.includes('from financial_admin_commands')) {
          return { rows: [{ status: commandStatus }] };
        }
        if (statement.includes('returning')) return { rows: [{ id: candidate.id }] };
        return { rows: [] };
      })
    };
    const database = {
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction))
    };
    const capabilitySource = vi.fn(() => FINANCIAL_ADMIN_LEASE_CAPABILITY);
    const repository = createPostgresJobRepository(
      database as never,
      {
        pollIntervalMs: 1,
        leaseMs: 30_000,
        retryBaseMs: 1,
        retryMaxMs: 1
      },
      () => NOW,
      'local-only',
      { classifierVersion: 2, allocationAlgorithmVersion: 3 },
      capabilitySource
    );

    await expect(repository.claimNext('financial-admin-worker')).resolves.toBeNull();
    expect(capabilitySource).toHaveBeenCalledOnce();
    expect(calls.filter((query) => rendered(query).sql.includes('for update skip locked')))
      .toHaveLength(1);
    expect(calls.some((query) => rendered(query).sql.includes('with exhausted as'))).toBe(false);
    expect(calls.filter((query) =>
      rendered(query).sql.trimStart().startsWith('update jobs')))
      .toHaveLength(2);
    expect(calls.filter((query) =>
      rendered(query).sql.includes('from financial_admin_commands')))
      .toHaveLength(1);
    const terminalUpdate = calls.map((query) => rendered(query).sql).filter((statement) =>
      statement.trimStart().startsWith('update jobs'))[1]!;
    expect(terminalUpdate).toContain(`status = '${terminalJobStatus}'`);
  });

  it('uses four distinct capabilities and digests for two normal and two exhausted targets', async () => {
    const commandIds = [1, 2, 3, 4].map((suffix) =>
      `00000000-0000-4000-8000-${String(1_800 + suffix).padStart(12, '0')}`
    );
    const candidates = commandIds.map((commandId, index) => ({
      ...jobRow({
        id: `00000000-0000-4000-8000-${String(1_900 + index).padStart(12, '0')}`,
        type: FINANCIAL_ADMIN_JOB,
        payload: { commandId },
        deduplicationKey: `commerce:financial-admin-command:${commandId}:v1`,
        status: index < 2 ? 'pending' : 'running',
        attempts: index < 2 ? 0 : 8,
        maxAttempts: 8,
        lockedAt: index < 2 ? null : new Date('2026-08-12T11:00:00.000Z'),
        lockedBy: index < 2 ? null : `expired-worker-${index}`
      }),
      priorStatus: index < 2 ? 'pending' as const : 'running' as const,
      hadRerunRequest: false,
      claimExpired: index >= 2
    }));
    const capabilities = ['C', 'D', 'E', 'F'].map((value) => value.repeat(43));
    let candidateIndex = 0;
    let currentCandidate = candidates[0]!;
    const calls: SQL[] = [];
    const transaction = {
      execute: vi.fn(async (query: SQL) => {
        calls.push(query);
        const statement = rendered(query).sql;
        if (statement.includes('for update skip locked')) {
          currentCandidate = candidates[candidateIndex++]!;
          return { rows: [currentCandidate] };
        }
        if (statement.includes('returning jobs.id')) {
          return { rows: [{
            id: currentCandidate.id,
            type: currentCandidate.type,
            payload: currentCandidate.payload,
            deduplicationKey: currentCandidate.deduplicationKey,
            attempts: 1,
            maxAttempts: currentCandidate.maxAttempts,
            lockedBy: 'four-token-worker'
          }] };
        }
        if (statement.includes('from financial_admin_commands')) {
          return { rows: [{ status: 'pending' }] };
        }
        if (statement.includes('returning id')) {
          return { rows: [{ id: currentCandidate.id }] };
        }
        return { rows: [] };
      })
    };
    const database = {
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction))
    };
    let capabilityIndex = 0;
    const capabilitySource = vi.fn(() => capabilities[capabilityIndex++]!);
    const repository = createPostgresJobRepository(
      database as never,
      {
        pollIntervalMs: 1,
        leaseMs: 30_000,
        retryBaseMs: 1,
        retryMaxMs: 1
      },
      () => NOW,
      'local-only',
      { classifierVersion: 2, allocationAlgorithmVersion: 3 },
      capabilitySource
    );

    const results = [];
    for (let index = 0; index < 4; index += 1) {
      results.push(await repository.claimNext('four-token-worker'));
    }

    expect(results.slice(0, 2).map((result) =>
      result?.financialAdminLeaseCapability
    )).toEqual(capabilities.slice(0, 2));
    expect(results.slice(2)).toEqual([null, null]);
    expect(capabilitySource).toHaveBeenCalledTimes(4);
    expect(new Set(capabilities).size).toBe(4);
    expect(new Set(capabilities.map((capability) =>
      createHash('sha256').update(capability, 'utf8').digest('hex')
    )).size).toBe(4);
    const renderedCalls = calls.map((query) => rendered(query));
    for (const capability of capabilities) {
      expect(renderedCalls.some((call) => call.params.includes(capability))).toBe(true);
      expect(renderedCalls.every((call) => !call.sql.includes(capability))).toBe(true);
    }
  });

  it.each([
    { operation: 'renewLease', lock: 'pg_advisory_xact_lock_shared' },
    { operation: 'complete', lock: 'pg_advisory_xact_lock' },
    { operation: 'retry', lock: 'pg_advisory_xact_lock' },
    { operation: 'permanent failure', lock: 'pg_advisory_xact_lock' }
  ] as const)(
    'locks the job before the lease and forwards the opaque capability for $operation',
    async ({ operation, lock }) => {
      const calls: SQL[] = [];
      const running = jobRow({
        id: FINANCIAL_ADMIN_JOB_ID,
        type: FINANCIAL_ADMIN_JOB,
        payload: { commandId: FINANCIAL_ADMIN_COMMAND_ID },
        deduplicationKey:
          `commerce:financial-admin-command:${FINANCIAL_ADMIN_COMMAND_ID}:v1`,
        status: 'running',
        attempts: 1,
        maxAttempts: 8,
        lockedAt: NOW,
        lockedBy: 'financial-admin-worker'
      });
      const transaction = {
        execute: vi.fn(async (query: SQL) => {
          calls.push(query);
          const statement = rendered(query).sql;
          if (statement.includes('for update')) return { rows: [running] };
          if (statement.includes('returning')) {
            return {
              rows: [{
                id: running.id,
                status: operation === 'retry' ? 'pending' : 'failed'
              }]
            };
          }
          return { rows: [] };
        })
      };
      const database = {
        transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction))
      };
      const repository = createPostgresJobRepository(database as never, {
        pollIntervalMs: 1,
        leaseMs: 30_000,
        retryBaseMs: 1,
        retryMaxMs: 1
      });

      const result = operation === 'renewLease'
        ? repository.renewLease(
            running.id,
            'financial-admin-worker',
            FINANCIAL_ADMIN_LEASE_CAPABILITY
          )
        : operation === 'complete'
          ? repository.complete(
              running.id,
              'financial-admin-worker',
              FINANCIAL_ADMIN_LEASE_CAPABILITY
            )
          : repository.fail(
              running.id,
              'financial-admin-worker',
              operation === 'retry' ? 'Transient job handler failure' : 'Invalid job payload',
              operation === 'retry',
              FINANCIAL_ADMIN_LEASE_CAPABILITY
            );
      await expect(result).resolves.toBe(true);

      const statements = calls.map((query) => rendered(query));
      const rowLock = statements.findIndex((item) => item.sql.includes('for update'));
      const capability = statements.findIndex((item) =>
        item.sql.includes('plan6bii_financial_admin_job_capability'));
      const advisory = statements.findIndex((item) => item.sql.includes(lock));
      const update = statements.findIndex((item) =>
        item.sql.trimStart().startsWith('update jobs'));
      expect(rowLock).toBe(0);
      expect(capability).toBeGreaterThan(rowLock);
      expect(advisory).toBeGreaterThan(capability);
      expect(update).toBeGreaterThan(advisory);
      expect(statements[capability]?.params).toContain(FINANCIAL_ADMIN_LEASE_CAPABILITY);
      if (operation === 'renewLease') {
        expect(statements[update]?.sql).toContain('clock_timestamp()');
      }
    }
  );

  it('rejects missing financial-admin capabilities before a lease mutation', async () => {
    const calls: SQL[] = [];
    const running = jobRow({
      id: FINANCIAL_ADMIN_JOB_ID,
      type: FINANCIAL_ADMIN_JOB,
      payload: { commandId: FINANCIAL_ADMIN_COMMAND_ID },
      status: 'running',
      attempts: 1,
      maxAttempts: 8,
      lockedAt: NOW,
      lockedBy: 'financial-admin-worker'
    });
    const transaction = {
      execute: vi.fn(async (query: SQL) => {
        calls.push(query);
        return { rows: [running] };
      })
    };
    const database = {
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction))
    };
    const repository = createPostgresJobRepository(database as never, {
      pollIntervalMs: 1,
      leaseMs: 30_000,
      retryBaseMs: 1,
      retryMaxMs: 1
    });

    await expect(repository.renewLease(running.id, 'financial-admin-worker'))
      .resolves.toBe(false);
    expect(calls).toHaveLength(1);
    expect(rendered(calls[0]!).sql).toContain('for update');
  });

  it('does not copy the financial-admin capability into a persisted safe error', async () => {
    const calls: SQL[] = [];
    const running = jobRow({
      id: FINANCIAL_ADMIN_JOB_ID,
      type: FINANCIAL_ADMIN_JOB,
      payload: { commandId: FINANCIAL_ADMIN_COMMAND_ID },
      status: 'running',
      attempts: 1,
      maxAttempts: 8,
      lockedAt: NOW,
      lockedBy: 'financial-admin-worker'
    });
    const transaction = {
      execute: vi.fn(async (query: SQL) => {
        calls.push(query);
        const statement = rendered(query).sql;
        if (statement.includes('for update')) return { rows: [running] };
        if (statement.includes('returning')) {
          return { rows: [{ id: running.id, status: 'failed' }] };
        }
        return { rows: [] };
      })
    };
    const database = {
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction))
    };
    const repository = createPostgresJobRepository(database as never, {
      pollIntervalMs: 1,
      leaseMs: 30_000,
      retryBaseMs: 1,
      retryMaxMs: 1
    });

    await expect(repository.fail(
      running.id,
      'financial-admin-worker',
      `unsafe ${FINANCIAL_ADMIN_LEASE_CAPABILITY}`,
      false,
      FINANCIAL_ADMIN_LEASE_CAPABILITY
    )).resolves.toBe(true);

    const update = calls.map((query) => rendered(query)).find((item) =>
      item.sql.trimStart().startsWith('update jobs'));
    expect(update?.params).not.toContain(`unsafe ${FINANCIAL_ADMIN_LEASE_CAPABILITY}`);
    expect(update?.params).toContain('Financial administrator job failure');
  });
});

function runningJob(overrides: Partial<JobRow> = {}): JobRow {
  return jobRow({
    type: 'test.failure-disposition',
    payload: {},
    deduplicationKey: null,
    status: 'running',
    attempts: 1,
    maxAttempts: 5,
    lockedAt: NOW,
    lockedBy: 'failure-worker',
    ...overrides
  });
}

function failureDispositionHarness(input: {
  readonly job?: JobRow | null;
  readonly returnedStatus?: unknown;
  readonly returnRowWithoutStatus?: boolean;
  readonly returnedRows?: readonly unknown[];
  readonly authorityFailure?: Error;
}) {
  const calls: SQL[] = [];
  const transaction = {
    execute: vi.fn(async (query: SQL) => {
      calls.push(query);
      const statement = rendered(query).sql;
      if (statement.includes('for update')) {
        return { rows: input.job === null ? [] : [input.job ?? runningJob()] };
      }
      if (statement.includes('pg_advisory_xact_lock')) {
        if (input.authorityFailure) throw input.authorityFailure;
        return { rows: [] };
      }
      if (statement.includes('returning id')) {
        if (input.returnedRows !== undefined) return { rows: input.returnedRows };
        if (input.returnRowWithoutStatus) {
          return { rows: [{ id: input.job?.id ?? runningJob().id }] };
        }
        return input.returnedStatus === undefined
          ? { rows: [] }
          : { rows: [{ id: input.job?.id ?? runningJob().id, status: input.returnedStatus }] };
      }
      return { rows: [] };
    })
  };
  const database = {
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction))
  };
  const repository = createPostgresJobRepository(database as never, {
    pollIntervalMs: 1,
    leaseMs: 30_000,
    retryBaseMs: 10,
    retryMaxMs: 1_000
  });
  return {
    calls,
    database,
    repository
  };
}

describe('job failure committed retry disposition', () => {
  it.each([
    {
      label: 'an ordinary retry below the attempt limit',
      job: runningJob({ attempts: 1, maxAttempts: 5 }),
      retryable: true,
      returnedStatus: 'pending',
      expected: { applied: true, retryScheduled: true }
    },
    {
      label: 'an exhausted retry',
      job: runningJob({ attempts: 5, maxAttempts: 5 }),
      retryable: true,
      returnedStatus: 'failed',
      expected: { applied: true, retryScheduled: false }
    },
    {
      label: 'a nonretryable failure',
      job: runningJob({ attempts: 1, maxAttempts: 5 }),
      retryable: false,
      returnedStatus: 'failed',
      expected: { applied: true, retryScheduled: false }
    },
    {
      label: 'a rerun requested before a nonretryable settlement',
      job: runningJob({
        attempts: 1,
        maxAttempts: 5,
        rerunRequestedAt: new Date('2026-08-12T11:59:59.000Z')
      }),
      retryable: false,
      returnedStatus: 'pending',
      expected: { applied: true, retryScheduled: true }
    },
    {
      label: 'a rerun requested before an exhausted retryable settlement',
      job: runningJob({
        attempts: 5,
        maxAttempts: 5,
        rerunRequestedAt: new Date('2026-08-12T11:59:59.000Z')
      }),
      retryable: true,
      returnedStatus: 'pending',
      expected: { applied: true, retryScheduled: true }
    }
  ])('returns the committed status for $label', async ({
    job, retryable, returnedStatus, expected
  }) => {
    const harness = failureDispositionHarness({ job, returnedStatus });

    await expect(harness.repository.failWithDisposition(
      job.id,
      'failure-worker',
      'Bounded failure',
      retryable
    )).resolves.toEqual(expected);

    expect(harness.database.transaction).toHaveBeenCalledOnce();
    const update = harness.calls.map(rendered).find((call) =>
      call.sql.trimStart().startsWith('update jobs'));
    expect(update?.sql).toContain('returning id, status');
  });

  it.each([
    { label: 'a missing or unowned job', job: null, returnedStatus: undefined },
    { label: 'a stale attempt rejected by the update predicate', job: runningJob(), returnedStatus: undefined }
  ])('returns not-applied for $label', async ({ job, returnedStatus }) => {
    const harness = failureDispositionHarness({ job, returnedStatus });

    await expect(harness.repository.failWithDisposition(
      runningJob().id,
      'failure-worker',
      'Bounded failure',
      true
    )).resolves.toEqual({ applied: false });
  });

  it('rejects an invalid financial capability before mutation', async () => {
    const job = runningJob({
      id: FINANCIAL_ADMIN_JOB_ID,
      type: FINANCIAL_ADMIN_JOB,
      payload: { commandId: FINANCIAL_ADMIN_COMMAND_ID },
      deduplicationKey:
        `commerce:financial-admin-command:${FINANCIAL_ADMIN_COMMAND_ID}:v1`
    });
    const harness = failureDispositionHarness({ job, returnedStatus: 'failed' });

    await expect(harness.repository.failWithDisposition(
      job.id,
      'failure-worker',
      'Bounded failure',
      false,
      'invalid capability'
    )).resolves.toEqual({ applied: false });
    expect(harness.calls).toHaveLength(1);
  });

  it('maps a rejected financial capability to not-applied', async () => {
    const job = runningJob({
      id: FINANCIAL_ADMIN_JOB_ID,
      type: FINANCIAL_ADMIN_JOB,
      payload: { commandId: FINANCIAL_ADMIN_COMMAND_ID },
      deduplicationKey:
        `commerce:financial-admin-command:${FINANCIAL_ADMIN_COMMAND_ID}:v1`
    });
    const rejected = Object.assign(new Error('private database authority detail'), {
      code: '55000'
    });
    const harness = failureDispositionHarness({ job, authorityFailure: rejected });

    await expect(harness.repository.failWithDisposition(
      job.id,
      'failure-worker',
      'Bounded failure',
      false,
      FINANCIAL_ADMIN_LEASE_CAPABILITY
    )).resolves.toEqual({ applied: false });
  });

  it('preserves the fixed financial authority failure mapping', async () => {
    const job = runningJob({
      id: FINANCIAL_ADMIN_JOB_ID,
      type: FINANCIAL_ADMIN_JOB,
      payload: { commandId: FINANCIAL_ADMIN_COMMAND_ID },
      deduplicationKey:
        `commerce:financial-admin-command:${FINANCIAL_ADMIN_COMMAND_ID}:v1`
    });
    const harness = failureDispositionHarness({
      job,
      authorityFailure: new Error('private database authority detail')
    });

    await expect(harness.repository.failWithDisposition(
      job.id,
      'failure-worker',
      'Bounded failure',
      false,
      FINANCIAL_ADMIN_LEASE_CAPABILITY
    )).rejects.toThrow('Financial administrator job lease authority failed');
  });

  it('propagates an ordinary transaction failure', async () => {
    const failure = new Error('ordinary transaction failed');
    const database = {
      transaction: vi.fn(async () => { throw failure; })
    };
    const repository = createPostgresJobRepository(database as never, {
      pollIntervalMs: 1,
      leaseMs: 30_000,
      retryBaseMs: 10,
      retryMaxMs: 1_000
    });

    await expect(repository.failWithDisposition(
      runningJob().id,
      'failure-worker',
      'Bounded failure',
      true
    )).rejects.toBe(failure);
  });

  it('rejects an impossible committed failure status', async () => {
    const harness = failureDispositionHarness({ returnedStatus: 'running' });

    await expect(harness.repository.failWithDisposition(
      runningJob().id,
      'failure-worker',
      'Bounded failure',
      true
    )).rejects.toThrow('Invalid job failure transition status');
  });

  it('rejects a returned failure row without its committed status', async () => {
    const harness = failureDispositionHarness({ returnRowWithoutStatus: true });

    await expect(harness.repository.failWithDisposition(
      runningJob().id,
      'failure-worker',
      'Bounded failure',
      true
    )).rejects.toThrow('Invalid job failure transition status');
  });

  it.each([
    {
      label: 'multiple committed rows',
      returnedRows: [
        { id: runningJob().id, status: 'pending' },
        { id: runningJob().id, status: 'pending' }
      ]
    },
    {
      label: 'a mismatched committed row identity',
      returnedRows: [{
        id: '00000000-0000-4000-8000-000000001699',
        status: 'pending'
      }]
    }
  ])('rejects $label through both failure APIs', async ({ returnedRows }) => {
    for (const operation of ['failWithDisposition', 'fail'] as const) {
      const harness = failureDispositionHarness({ returnedRows });
      const result = operation === 'failWithDisposition'
        ? harness.repository.failWithDisposition(
            runningJob().id,
            'failure-worker',
            'Bounded failure',
            true
          )
        : harness.repository.fail(
            runningJob().id,
            'failure-worker',
            'Bounded failure',
            true
          );

      await expect(result).rejects.toThrow('Invalid job failure transition status');
    }
  });

  it.each([
    { returnedStatus: 'pending', expected: true },
    { returnedStatus: 'failed', expected: true },
    { returnedStatus: undefined, expected: false }
  ])('keeps legacy fail as the applied-only adapter for $returnedStatus', async ({
    returnedStatus, expected
  }) => {
    const harness = failureDispositionHarness({ returnedStatus });

    const result = await harness.repository.fail(
      runningJob().id,
      'failure-worker',
      'Bounded failure',
      returnedStatus === 'pending'
    );

    expect(result).toBe(expected);
    expect(typeof result).toBe('boolean');
  });
});

function operationsCandidate(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ...jobRow({
      id: OPERATIONS_JOB_ID,
      type: OPERATIONS_JOB,
      payload: { commandId: OPERATIONS_COMMAND_ID },
      deduplicationKey: `operations:job-retry-command:${OPERATIONS_COMMAND_ID}:v1`,
      status: 'pending',
      attempts: 0,
      maxAttempts: 8,
      lockedAt: null,
      lockedBy: null
    }),
    priorStatus: 'pending',
    hadRerunRequest: false,
    ...overrides
  };
}

function operationsClaimRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: OPERATIONS_JOB_ID,
    type: OPERATIONS_JOB,
    payload: { commandId: OPERATIONS_COMMAND_ID },
    deduplicationKey: `operations:job-retry-command:${OPERATIONS_COMMAND_ID}:v1`,
    attempts: 1,
    maxAttempts: 8,
    lockedBy: OPERATIONS_WORKER,
    operationsJobLeaseGeneration: 1,
    ...overrides
  };
}

function operationsAuthority(
  overrides: Partial<OperationsJobLeaseAuthority> = {}
): OperationsJobLeaseAuthority {
  return {
    jobId: OPERATIONS_JOB_ID,
    leaseOwner: OPERATIONS_WORKER,
    attempt: 1,
    maxAttempts: 8,
    generation: 1,
    capability: OPERATIONS_LEASE_CAPABILITY,
    ...overrides
  };
}

const OPERATIONS_ROUTINES = [
  'plan7a_operations_claim_job',
  'plan7a_operations_renew_job_claim',
  'plan7a_operations_relinquish_job',
  'plan7a_operations_complete_job',
  'plan7a_operations_fail_job',
  'plan7a_operations_exhaust_job'
] as const;

type OperationsRoutine = typeof OPERATIONS_ROUTINES[number];

function operationsHarness(input: {
  readonly candidateRows?: readonly unknown[];
  readonly claimRows?: readonly unknown[];
  readonly appliedRows?: readonly unknown[];
  readonly routineFailure?: unknown;
  readonly operationsCapabilitySource?: () => unknown;
} = {}) {
  const calls: SQL[] = [];
  const candidateRows = input.candidateRows ?? [operationsCandidate()];
  const execute = vi.fn(async (query: SQL) => {
    calls.push(query);
    const statement = rendered(query).sql;
    if (statement.includes('for update skip locked')) return { rows: candidateRows };
    const routine = OPERATIONS_ROUTINES.find((name) => statement.includes(name));
    if (routine !== undefined) {
      if (input.routineFailure !== undefined) throw input.routineFailure;
      return {
        rows: routine === 'plan7a_operations_claim_job'
          ? input.claimRows ?? [operationsClaimRow()]
          : input.appliedRows ?? [{ applied: true }]
      };
    }
    return { rows: [] };
  });
  const transaction = { execute };
  const database = {
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction))
  };
  const financialCapabilitySource = vi.fn(() => FINANCIAL_ADMIN_LEASE_CAPABILITY);
  const operationsCapabilitySource = vi.fn(
    (input.operationsCapabilitySource ?? (() => OPERATIONS_LEASE_CAPABILITY)) as () => string
  );
  const nowSource = vi.fn(() => NOW);
  const repository = createPostgresJobRepository(
    database as never,
    {
      pollIntervalMs: 1,
      leaseMs: 30_000,
      retryBaseMs: 10,
      retryMaxMs: 1_000
    },
    nowSource,
    'all',
    { classifierVersion: 2, allocationAlgorithmVersion: 3 },
    financialCapabilitySource,
    operationsCapabilitySource
  );
  return {
    calls,
    database,
    execute,
    financialCapabilitySource,
    nowSource,
    operationsCapabilitySource,
    repository
  };
}

async function repositoryFailure(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected repository operation to reject');
}

function expectOperationsAuthorityFailure(error: Error): void {
  expect(error).toEqual(new Error('Operations job lease authority failed'));
  expect(error.name).toBe('Error');
  expect(Object.hasOwn(error, 'cause')).toBe(false);
  expect(Object.hasOwn(error, 'query')).toBe(false);
  expect(Object.hasOwn(error, 'params')).toBe(false);
  expect(JSON.stringify(error)).not.toMatch(/private|plan7a_operations|capability/iu);
}

function operationsRoutineCall(calls: readonly SQL[], routine: OperationsRoutine) {
  return calls.map(rendered).find((call) => call.sql.includes(routine));
}

describe('operations job lease authority transport', () => {
  it('claims an operations candidate with PostgreSQL time and one fresh operations capability', async () => {
    const harness = operationsHarness();

    await expect(harness.repository.claimNext(OPERATIONS_WORKER)).resolves.toEqual({
      ...operationsClaimRow(),
      operationsJobLeaseCapability: OPERATIONS_LEASE_CAPABILITY
    });

    expect(harness.database.transaction).toHaveBeenCalledOnce();
    expect(harness.operationsCapabilitySource).toHaveBeenCalledOnce();
    expect(harness.financialCapabilitySource).not.toHaveBeenCalled();
    const statements = harness.calls.map(rendered);
    const candidate = statements.find((call) => call.sql.includes('for update skip locked'))!;
    expect(candidate.params.filter((value) => value === OPERATIONS_JOB)).toHaveLength(4);
    expect(candidate.sql.match(
      /jobs[.]run_at <= pg_catalog[.]clock_timestamp[(][)]/gu
    )).toHaveLength(2);
    expect(candidate.sql).toMatch(
      /jobs[.]type in [(]\$\d+,\s*\$\d+[)]\s+and jobs[.]run_at <= pg_catalog[.]clock_timestamp[(][)]/u
    );
    expect(candidate.sql).not.toMatch(
      /jobs[.]type = \$\d+\s+and jobs[.]locked_at <= \$\d+/u
    );

    const setting = statements.find((call) =>
      call.sql.includes('pale_orbit.plan7a_operations_job_capability'))!;
    expect(setting.params).toEqual([OPERATIONS_LEASE_CAPABILITY]);
    expect(setting.sql).not.toContain('plan6bii_financial_admin');
    const claim = operationsRoutineCall(harness.calls, 'plan7a_operations_claim_job')!;
    expect(claim.params).toEqual([OPERATIONS_JOB_ID, OPERATIONS_WORKER, 30_000]);
    expect(claim.sql).toMatch(/from public[.]plan7a_operations_claim_job/u);
    expect(statements.every((call) => !call.sql.includes('plan6bii_financial_admin'))).toBe(true);
  });

  it('lets the protected claim routine exclusively synchronize an expired ceiling target', async () => {
    const harness = operationsHarness({
      candidateRows: [operationsCandidate({
        status: 'running',
        priorStatus: 'running',
        attempts: 8,
        maxAttempts: 8,
        lockedAt: new Date('2026-08-12T11:00:00.000Z'),
        lockedBy: 'expired-operations-worker',
        runAt: new Date('2026-08-12T11:30:00.000Z')
      })],
      claimRows: []
    });

    await expect(harness.repository.claimNext(OPERATIONS_WORKER)).resolves.toBeNull();

    expect(harness.operationsCapabilitySource).toHaveBeenCalledOnce();
    expect(operationsRoutineCall(harness.calls, 'plan7a_operations_claim_job')?.params)
      .toEqual([OPERATIONS_JOB_ID, OPERATIONS_WORKER, 30_000]);
    expect(harness.calls.map(rendered).filter((call) =>
      call.sql.includes('plan7a_operations_')).map((call) => call.sql))
      .toHaveLength(2);
    expect(operationsRoutineCall(harness.calls, 'plan7a_operations_exhaust_job'))
      .toBeUndefined();
    expect(harness.calls.map(rendered).some((call) =>
      call.sql.trimStart().startsWith('update jobs'))).toBe(false);
  });

  it.each([
    { label: 'a throwing source', source: () => { throw new Error('private source detail'); } },
    { label: 'a non-string source', source: () => 43 },
    { label: 'a short source', source: () => 'short' },
    { label: 'an object source', source: () => new String(OPERATIONS_LEASE_CAPABILITY) },
    {
      label: 'a hostile callable source',
      source: new Proxy(() => OPERATIONS_LEASE_CAPABILITY, {
        apply: () => { throw new Error('private callable source detail'); }
      })
    }
  ])('collapses $label to the fixed capability-generation error', async ({ source }) => {
    const harness = operationsHarness({ operationsCapabilitySource: source });

    const error = await repositoryFailure(harness.repository.claimNext(OPERATIONS_WORKER));

    expect(error).toEqual(new Error('Operations job lease capability generation failed'));
    expect(Object.hasOwn(error, 'cause')).toBe(false);
    expect(JSON.stringify(error)).not.toContain('private source detail');
    expect(harness.calls).toHaveLength(1);
    expect(rendered(harness.calls[0]!).sql).toContain('for update skip locked');
  });

  it.each([
    { label: 'multiple rows', rows: [operationsClaimRow(), operationsClaimRow()] },
    {
      label: 'a missing generation',
      rows: [{
        id: OPERATIONS_JOB_ID,
        type: OPERATIONS_JOB,
        payload: { commandId: OPERATIONS_COMMAND_ID },
        deduplicationKey: `operations:job-retry-command:${OPERATIONS_COMMAND_ID}:v1`,
        attempts: 1,
        maxAttempts: 8,
        lockedBy: OPERATIONS_WORKER
      }]
    },
    {
      label: 'a mismatched job',
      rows: [operationsClaimRow({
        id: '00000000-0000-4000-8000-000000001899'
      })]
    },
    {
      label: 'an invalid lease owner',
      rows: [operationsClaimRow({ lockedBy: 'invalid owner' })]
    },
    {
      label: 'an extra field',
      rows: [operationsClaimRow({ clearCapability: OPERATIONS_LEASE_CAPABILITY })]
    },
    {
      label: 'a proxy row',
      rows: [new Proxy(operationsClaimRow(), {
        ownKeys: () => { throw new Error('private row proxy detail'); }
      })]
    },
    { label: 'a sparse result', rows: new Array<unknown>(1) }
  ])('rejects $label from the protected claim routine', async ({ rows }) => {
    const harness = operationsHarness({ claimRows: rows });

    expectOperationsAuthorityFailure(
      await repositoryFailure(harness.repository.claimNext(OPERATIONS_WORKER))
    );
  });

  it('binds exact validated authority to renew and complete routines', async () => {
    for (const operation of ['renewOperationsJobLease', 'completeOperationsJob'] as const) {
      const harness = operationsHarness();
      const authority = operationsAuthority({ attempt: 3, generation: 7 });

      await expect(harness.repository[operation](authority)).resolves.toBe(true);

      expect(harness.calls).toHaveLength(2);
      const statements = harness.calls.map(rendered);
      expect(statements[0]?.sql).toContain('pale_orbit.plan7a_operations_job_capability');
      expect(statements[0]?.params).toEqual([OPERATIONS_LEASE_CAPABILITY]);
      expect(statements.every((call) => !call.sql.includes('plan6bii_financial_admin')))
        .toBe(true);
      const routine = operation === 'renewOperationsJobLease'
        ? 'plan7a_operations_renew_job_claim'
        : 'plan7a_operations_complete_job';
      expect(operationsRoutineCall(harness.calls, routine)?.params).toEqual([
        OPERATIONS_JOB_ID,
        OPERATIONS_WORKER,
        3,
        7
      ]);
    }
  });

  it.each([
    {
      label: 'a handler retry below the ceiling',
      authority: operationsAuthority({ attempt: 3, generation: 4 }),
      safeError: 'Transient job handler failure' as OperationsJobSafeError,
      retryable: true,
      routine: 'plan7a_operations_relinquish_job' as const,
      parameters: [
        OPERATIONS_JOB_ID, OPERATIONS_WORKER, 3, 4,
        'Transient job handler failure', 40
      ],
      expected: { applied: true, retryScheduled: true }
    },
    {
      label: 'a completion retry below the ceiling',
      authority: operationsAuthority({ attempt: 2, generation: 5 }),
      safeError: 'Transient job completion failure' as OperationsJobSafeError,
      retryable: true,
      routine: 'plan7a_operations_relinquish_job' as const,
      parameters: [
        OPERATIONS_JOB_ID, OPERATIONS_WORKER, 2, 5,
        'Transient job completion failure', 20
      ],
      expected: { applied: true, retryScheduled: true }
    },
    {
      label: 'a retry at the ceiling',
      authority: operationsAuthority({ attempt: 8, generation: 9 }),
      safeError: 'Transient job handler failure' as OperationsJobSafeError,
      retryable: true,
      routine: 'plan7a_operations_exhaust_job' as const,
      parameters: [OPERATIONS_JOB_ID, OPERATIONS_WORKER, 8, 9],
      expected: { applied: true, retryScheduled: false }
    },
    ...([
      'Invalid operations job retry command identity.',
      'Operations job retry command permanently failed.',
      'Permanent job handler failure'
    ] as const).map((safeError, index) => ({
      label: `permanent failure ${index + 1}`,
      authority: operationsAuthority({ attempt: 2, generation: 10 + index }),
      safeError,
      retryable: false,
      routine: 'plan7a_operations_fail_job' as const,
      parameters: [OPERATIONS_JOB_ID, OPERATIONS_WORKER, 2, 10 + index, safeError],
      expected: { applied: true, retryScheduled: false }
    }))
  ])('routes $label to its one protected settlement routine', async ({
    authority,
    safeError,
    retryable,
    routine,
    parameters,
    expected
  }) => {
    const harness = operationsHarness();

    await expect(harness.repository.failOperationsJob(
      authority,
      safeError,
      retryable
    )).resolves.toEqual(expected);

    expect(harness.calls).toHaveLength(2);
    expect(operationsRoutineCall(harness.calls, routine)?.params).toEqual(parameters);
    expect(harness.calls.map(rendered).filter((call) =>
      OPERATIONS_ROUTINES.some((name) => call.sql.includes(name))))
      .toHaveLength(1);
  });

  it('rejects every malformed authority without invoking accessors, proxies, or SQL', async () => {
    let accessorReads = 0;
    let proxyTraps = 0;
    const accessor = Object.defineProperty(
      { ...operationsAuthority() },
      'capability',
      {
        enumerable: true,
        get: () => {
          accessorReads += 1;
          throw new Error('private authority accessor detail');
        }
      }
    );
    const proxy = new Proxy(operationsAuthority(), {
      ownKeys: () => {
        proxyTraps += 1;
        throw new Error('private authority proxy detail');
      },
      getOwnPropertyDescriptor: () => {
        proxyTraps += 1;
        throw new Error('private authority proxy detail');
      }
    });
    const malformed: unknown[] = [
      null,
      [],
      { ...operationsAuthority(), extra: true },
      { ...operationsAuthority(), jobId: '00000000-0000-4000-8000-00000000180A' },
      { ...operationsAuthority(), leaseOwner: 'invalid owner' },
      { ...operationsAuthority(), attempt: 0 },
      { ...operationsAuthority(), attempt: 9 },
      { ...operationsAuthority(), maxAttempts: 7 },
      { ...operationsAuthority(), generation: 0 },
      { ...operationsAuthority(), capability: 'short' },
      accessor,
      proxy
    ];

    for (const value of malformed) {
      for (const operation of [
        (harness: ReturnType<typeof operationsHarness>) =>
          harness.repository.renewOperationsJobLease(value as OperationsJobLeaseAuthority),
        (harness: ReturnType<typeof operationsHarness>) =>
          harness.repository.completeOperationsJob(value as OperationsJobLeaseAuthority),
        (harness: ReturnType<typeof operationsHarness>) =>
          harness.repository.failOperationsJob(
            value as OperationsJobLeaseAuthority,
            'Permanent job handler failure',
            false
          )
      ]) {
        const harness = operationsHarness();
        expectOperationsAuthorityFailure(await repositoryFailure(operation(harness)));
        expect(harness.database.transaction).not.toHaveBeenCalled();
      }
    }
    expect(accessorReads).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  it.each([
    {
      label: 'a permanent error marked retryable',
      safeError: 'Permanent job handler failure' as OperationsJobSafeError,
      retryable: true
    },
    {
      label: 'a transient error marked permanent',
      safeError: 'Transient job handler failure' as OperationsJobSafeError,
      retryable: false
    },
    {
      label: 'an unknown safe error',
      safeError: 'private arbitrary error' as OperationsJobSafeError,
      retryable: false
    }
  ])('rejects $label before SQL', async ({ safeError, retryable }) => {
    const harness = operationsHarness();

    expectOperationsAuthorityFailure(await repositoryFailure(
      harness.repository.failOperationsJob(operationsAuthority(), safeError, retryable)
    ));
    expect(harness.database.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'zero rows', rows: [] },
    { label: 'multiple rows', rows: [{ applied: true }, { applied: true }] },
    { label: 'false', rows: [{ applied: false }] },
    { label: 'an extra field', rows: [{ applied: true, private: true }] },
    {
      label: 'an accessor',
      rows: [Object.defineProperty({}, 'applied', {
        enumerable: true,
        get: () => { throw new Error('private applied accessor detail'); }
      })]
    },
    {
      label: 'a proxy',
      rows: [new Proxy({ applied: true }, {
        ownKeys: () => { throw new Error('private applied proxy detail'); }
      })]
    },
    { label: 'a sparse result', rows: new Array<unknown>(1) }
  ])('fails safely on $label from an applied routine', async ({ rows }) => {
    for (const operation of [
      (harness: ReturnType<typeof operationsHarness>) =>
        harness.repository.renewOperationsJobLease(operationsAuthority()),
      (harness: ReturnType<typeof operationsHarness>) =>
        harness.repository.completeOperationsJob(operationsAuthority()),
      (harness: ReturnType<typeof operationsHarness>) =>
        harness.repository.failOperationsJob(
          operationsAuthority(),
          'Permanent job handler failure',
          false
        )
    ]) {
      const harness = operationsHarness({ appliedRows: rows });
      expectOperationsAuthorityFailure(await repositoryFailure(operation(harness)));
    }
  });

  it('maps raw and installed-Drizzle 55000 failures for every operations path', async () => {
    const failures = [
      Object.assign(new Error('private raw authority detail'), { code: '55000' }),
      new DrizzleQueryError(
        'select private_operations_query',
        ['private-operations-param'],
        Object.assign(new Error('private wrapped authority detail'), { code: '55000' })
      )
    ];
    for (const failure of failures) {
      const claimHarness = operationsHarness({ routineFailure: failure });
      await expect(claimHarness.repository.claimNext(OPERATIONS_WORKER)).resolves.toBeNull();
      for (const operation of [
        (harness: ReturnType<typeof operationsHarness>) =>
          harness.repository.renewOperationsJobLease(operationsAuthority()),
        (harness: ReturnType<typeof operationsHarness>) =>
          harness.repository.completeOperationsJob(operationsAuthority()),
        (harness: ReturnType<typeof operationsHarness>) =>
          harness.repository.failOperationsJob(
            operationsAuthority(),
            'Transient job handler failure',
            true
          ),
        (harness: ReturnType<typeof operationsHarness>) =>
          harness.repository.failOperationsJob(
            operationsAuthority({ attempt: 8 }),
            'Transient job handler failure',
            true
          ),
        (harness: ReturnType<typeof operationsHarness>) =>
          harness.repository.failOperationsJob(
            operationsAuthority(),
            'Permanent job handler failure',
            false
          )
      ]) {
        const harness = operationsHarness({ routineFailure: failure });
        const result = await operation(harness);
        expect(result).toEqual(
          typeof result === 'boolean' ? false : { applied: false }
        );
      }
    }
  });

  it('never invokes hostile error reflection while replacing non-55000 failures', async () => {
    let accessorReads = 0;
    let proxyTraps = 0;
    const accessor = Object.defineProperty(new Error('private accessor error'), 'code', {
      get: () => {
        accessorReads += 1;
        throw new Error('private error accessor detail');
      }
    });
    const proxy = new Proxy(new Error('private proxy error'), {
      get: () => {
        proxyTraps += 1;
        throw new Error('private error proxy detail');
      },
      getOwnPropertyDescriptor: () => {
        proxyTraps += 1;
        throw new Error('private error proxy detail');
      },
      getPrototypeOf: () => {
        proxyTraps += 1;
        throw new Error('private error proxy detail');
      }
    });
    const cyclic = new Error('private cyclic error') as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    const causeShaped = Object.assign(new Error('private cause-shaped error'), {
      cause: Object.assign(new Error('private nested authority detail'), { code: '55000' })
    });
    const wrapperAccessor = new DrizzleQueryError('private wrapper query', [], new Error());
    Object.defineProperty(wrapperAccessor, 'cause', {
      get: () => {
        accessorReads += 1;
        throw new Error('private wrapper cause detail');
      }
    });

    for (const failure of [accessor, proxy, cyclic, causeShaped, wrapperAccessor]) {
      const claimHarness = operationsHarness({ routineFailure: failure });
      expectOperationsAuthorityFailure(await repositoryFailure(
        claimHarness.repository.claimNext(OPERATIONS_WORKER)
      ));
      const harness = operationsHarness({ routineFailure: failure });
      expectOperationsAuthorityFailure(await repositoryFailure(
        harness.repository.renewOperationsJobLease(operationsAuthority())
      ));
    }
    expect(accessorReads).toBe(0);
    expect(proxyTraps).toBe(0);
  });
});
