import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';

import type { JobRow } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { JobRetryPolicyContext } from '../policies';

const projection = vi.hoisted(() => ({
  lockFinancialProjectionAuthority: vi.fn(),
  lockFinancialProjectionEnrollment: vi.fn()
}));
const repository = vi.hoisted(() => ({
  rearmFinancialClassificationJob: vi.fn()
}));

vi.mock('$lib/server/commerce/financial/projection-authority', () => projection);
vi.mock('$lib/server/jobs/repository', () => repository);

import {
  createFinancialClassificationJobRetryPolicyAdapter
} from './financial-classification';
import { InvalidJobRetryPolicyIdentityError } from '../policies';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT_ID = '33333333-3333-4333-8333-3333333333ab';
const PARENT_ID = '44444444-4444-4444-8444-444444444444';
const SCAN_RUN_ID = '55555555-5555-4555-8555-555555555555';
const UPDATED_AT = '2026-08-26T12:34:56.123456Z';
const REARMED_AT = '2026-08-26T12:35:00.654321Z';
const CREATED_AT = new Date('2026-08-20T09:00:00.000Z');
const REARMED_DATE = new Date('2026-08-26T12:35:00.654Z');
const FINGERPRINT = 'a'.repeat(64);

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`
  });
}

function activeAuthority(overrides: Record<string, unknown> = {}) {
  return {
    classifierVersion: 2,
    allocationAlgorithmVersion: 3,
    pendingClassifierVersion: null,
    pendingAllocationAlgorithmVersion: null,
    pendingReplayId: null,
    pendingScanRunId: null,
    ...overrides
  };
}

function pendingAuthority(overrides: Record<string, unknown> = {}) {
  return activeAuthority({
    pendingClassifierVersion: 4,
    pendingAllocationAlgorithmVersion: 5,
    pendingReplayId: 'c4-a5',
    pendingScanRunId: SCAN_RUN_ID,
    ...overrides
  });
}

function financialPayload(overrides: Record<string, unknown> = {}) {
  return {
    subjectType: 'balance_transaction',
    subjectId: SUBJECT_ID,
    sourceFingerprintSha256: FINGERPRINT,
    classifierVersion: 2,
    allocationAlgorithmVersion: 3,
    replayId: 'c2-a3',
    ...overrides
  };
}

function pendingPayload(overrides: Record<string, unknown> = {}) {
  return financialPayload({
    subjectType: 'fee_detail',
    classifierVersion: 4,
    allocationAlgorithmVersion: 5,
    replayId: 'c4-a5',
    scanRunId: SCAN_RUN_ID,
    ...overrides
  });
}

function deduplicationKey(payload: Record<string, unknown>): string {
  return `financial:classification:${payload.classifierVersion}:` +
    `${payload.allocationAlgorithmVersion}:${payload.subjectType}:` +
    `${payload.subjectId}:${payload.sourceFingerprintSha256}`;
}

function lockedJob(overrides: Record<string, unknown> = {}) {
  const payload = (overrides.payload ?? financialPayload()) as Record<string, unknown>;
  return {
    id: JOB_ID,
    type: 'commerce.financial-classification',
    payload,
    deduplicationKey: deduplicationKey(payload),
    status: 'failed',
    attempts: 5,
    maxAttempts: 5,
    updatedAt: UPDATED_AT,
    ...overrides
  };
}

function retryTarget(overrides: Partial<JobRetryPolicyContext['target']> = {}) {
  return Object.freeze({
    commandId: COMMAND_ID,
    targetJobId: JOB_ID,
    expectedKind: 'commerce.financial-classification' as const,
    expectedStatus: 'failed' as const,
    expectedAttempts: 5,
    expectedMaxAttempts: 5,
    expectedUpdatedAt: UPDATED_AT,
    ...overrides
  });
}

function sourceRow(overrides: Record<string, unknown> = {}) {
  return { id: SUBJECT_ID, sourceFingerprintSha256: FINGERPRINT, ...overrides };
}

function scanRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SCAN_RUN_ID,
    rootKey: 'commerce.financial-classification:scan:4:5',
    kind: 'classification_replay',
    phase: 'classification_replay_page',
    state: 'running',
    classifierVersion: 4,
    allocationAlgorithmVersion: 5,
    replayId: 'c4-a5',
    completedAt: null,
    ...overrides
  };
}

function rearmedJob(job = lockedJob(), overrides: Record<string, unknown> = {}): JobRow {
  return {
    id: job.id,
    type: job.type,
    payload: job.payload,
    deduplicationKey: job.deduplicationKey,
    status: 'pending',
    runAt: REARMED_DATE,
    attempts: 0,
    maxAttempts: 5,
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    rerunRequestedAt: null,
    completedAt: null,
    createdAt: CREATED_AT,
    updatedAt: REARMED_DATE,
    ...overrides
  } as JobRow;
}

function postcondition(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    runAt: REARMED_AT,
    updatedAt: REARMED_AT,
    transactionTimestamp: REARMED_AT,
    ...overrides
  };
}

function fakeDatabase(responses: readonly unknown[][]) {
  const calls: SQL[] = [];
  const operations: string[] = [];
  let index = 0;
  const execute = vi.fn(async (query: SQL) => {
    calls.push(query);
    const statement = rendered(query).sql;
    if (statement.includes('transaction_timestamp()')) operations.push('postcondition');
    else if (statement.includes('from financial_scan_runs')) operations.push('scan-read');
    else if (statement.includes('stripe_balance_transaction_fee_details')) operations.push('source-read');
    else if (statement.includes('stripe_balance_transactions')) operations.push('source-read');
    else operations.push('target-lock');
    return { rows: responses[index++] ?? [] };
  });
  return {
    calls,
    operations,
    transaction: { execute } as unknown as DatabaseTransaction
  };
}

function bindLocks(
  database: ReturnType<typeof fakeDatabase>,
  authority = activeAuthority()
): void {
  projection.lockFinancialProjectionAuthority.mockImplementationOnce(async () => {
    database.operations.push('authority-lock');
    return authority;
  });
  projection.lockFinancialProjectionEnrollment.mockImplementationOnce(async () => {
    database.operations.push('enrollment-lock');
  });
}

function bindPrimitive(
  database: ReturnType<typeof fakeDatabase>,
  returned: JobRow
): void {
  repository.rearmFinancialClassificationJob.mockImplementationOnce(async () => {
    database.operations.push('primitive');
    return returned;
  });
}

function context(
  database: DatabaseTransaction,
  overrides: Partial<JobRetryPolicyContext['target']> = {}
): JobRetryPolicyContext {
  return Object.freeze({
    transaction: database,
    target: retryTarget(overrides),
    signal: new AbortController().signal
  });
}

async function identityFailure(promise: Promise<unknown>): Promise<void> {
  const failure = await promise.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(InvalidJobRetryPolicyIdentityError);
  expect(failure).not.toHaveProperty('cause');
  expect(String(failure)).not.toContain('private-canary');
}

describe('financial-classification operations retry adapter', () => {
  beforeEach(() => {
    projection.lockFinancialProjectionAuthority.mockReset();
    projection.lockFinancialProjectionEnrollment.mockReset();
    repository.rearmFinancialClassificationJob.mockReset();
  });

  it('exports a no-dependency factory', () => {
    expect(createFinancialClassificationJobRetryPolicyAdapter).toBeTypeOf('function');
    expect(createFinancialClassificationJobRetryPolicyAdapter()).toBeTypeOf('function');
  });

  it('rearms an exact active-authority balance job in the approved lock order', async () => {
    const job = lockedJob();
    const database = fakeDatabase([[job], [sourceRow()], [postcondition()]]);
    bindLocks(database);
    bindPrimitive(database, rearmedJob(job));

    const outcome = await createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction)
    );

    expect(outcome).toEqual({ status: 'succeeded', resultCode: 'rearmed_existing' });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(database.operations).toEqual([
      'authority-lock', 'enrollment-lock', 'target-lock', 'source-read',
      'primitive', 'postcondition'
    ]);
    expect(projection.lockFinancialProjectionAuthority)
      .toHaveBeenCalledWith(database.transaction);
    expect(projection.lockFinancialProjectionEnrollment)
      .toHaveBeenCalledWith(database.transaction);
    expect(repository.rearmFinancialClassificationJob).toHaveBeenCalledTimes(1);
    const exactSpec = repository.rearmFinancialClassificationJob.mock.calls[0]![1];
    expect(exactSpec).toEqual({
      type: job.type,
      payload: job.payload,
      deduplicationKey: job.deduplicationKey,
      maxAttempts: 5
    });
    expect(Object.isFrozen(exactSpec)).toBe(true);
    expect(Object.isFrozen(exactSpec.payload)).toBe(true);

    const targetLock = rendered(database.calls[0]!);
    expect(targetLock.sql).toContain('from "public"."jobs"');
    expect(targetLock.sql).toContain('for update');
    expect(targetLock.params).toEqual([JOB_ID]);
    const source = rendered(database.calls[1]!);
    expect(source.sql).toContain('stripe_balance_transactions');
    expect(source.sql).not.toContain('for update');
    expect(source.params).toEqual([SUBJECT_ID]);
  });

  it.each(['classification_replay_page', 'classification_replay_finalize'])(
    'rearms an exact pending replay fee job during %s', async (phase) => {
      const job = lockedJob({ payload: pendingPayload() });
      const database = fakeDatabase([
        [job], [scanRow({ phase })], [sourceRow({ balanceTransactionId: PARENT_ID })],
        [postcondition()]
      ]);
      bindLocks(database, pendingAuthority());
      bindPrimitive(database, rearmedJob(job));

      await expect(createFinancialClassificationJobRetryPolicyAdapter()(
        context(database.transaction)
      )).resolves.toEqual({ status: 'succeeded', resultCode: 'rearmed_existing' });

      expect(database.operations).toEqual([
        'authority-lock', 'enrollment-lock', 'target-lock', 'scan-read',
        'source-read', 'primitive', 'postcondition'
      ]);
      const scan = rendered(database.calls[1]!);
      expect(scan.sql).toContain('from financial_scan_runs');
      expect(scan.sql).not.toContain('for update');
      expect(scan.params).toEqual([SCAN_RUN_ID]);
      const source = rendered(database.calls[2]!);
      expect(source.sql).toContain('stripe_balance_transaction_fee_details');
      expect(source.sql).toContain('join stripe_balance_transactions');
      expect(source.sql).not.toContain('for update');
      expect(source.params).toEqual([SUBJECT_ID]);
    }
  );

  it.each([
    ['kind', { type: 'commerce.financial-source' }],
    ['status', { status: 'pending' }],
    ['attempts', { attempts: 6 }],
    ['maximum', { maxAttempts: 6 }],
    ['timestamp', { updatedAt: '2026-08-26T12:34:56.123457Z' }]
  ])('denies when the submitted %s snapshot changed', async (_label, change) => {
    const database = fakeDatabase([[lockedJob(change)]]);
    bindLocks(database);

    await expect(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction)
    )).resolves.toEqual({ status: 'denied', resultCode: 'target_state_changed' });
    expect(repository.rearmFinancialClassificationJob).not.toHaveBeenCalled();
    expect(database.calls).toHaveLength(1);
  });

  it('maps a missing exact target to changed state', async () => {
    const database = fakeDatabase([[]]);
    bindLocks(database);
    await expect(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction)
    )).resolves.toEqual({ status: 'denied', resultCode: 'target_state_changed' });
  });

  it.each([
    ['extra payload key', lockedJob({ payload: financialPayload({ extra: true }) }), {}],
    ['uppercase raw UUID', lockedJob({ payload: financialPayload({
      subjectId: SUBJECT_ID.toUpperCase()
    }), deduplicationKey: deduplicationKey(financialPayload()) }), {}],
    ['wrong replay identity', lockedJob({ payload: financialPayload({ replayId: 'c2-a4' }) }), {}],
    ['wrong deduplication identity', lockedJob({ deduplicationKey: 'private-canary' }), {}],
    ['wrong catalog maximum', lockedJob({ maxAttempts: 4, attempts: 4 }), {
      expectedAttempts: 4, expectedMaxAttempts: 4
    }]
  ])('fails a %s as invalid command identity', async (_label, job, expected) => {
    const database = fakeDatabase([[job]]);
    bindLocks(database);
    await expect(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction, expected)
    )).resolves.toEqual({ status: 'failed', resultCode: 'retry_command_invalid' });
    expect(repository.rearmFinancialClassificationJob).not.toHaveBeenCalled();
    expect(database.calls).toHaveLength(1);
  });

  it('rejects cross-policy targets before taking financial locks', async () => {
    const database = fakeDatabase([]);
    await expect(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction, { expectedKind: 'commerce.stripe-event' })
    )).resolves.toEqual({ status: 'failed', resultCode: 'retry_command_invalid' });
    expect(projection.lockFinancialProjectionAuthority).not.toHaveBeenCalled();
    expect(database.calls).toHaveLength(0);
  });

  it('denies a failed but nonexhausted job as no longer retryable', async () => {
    const job = lockedJob({ attempts: 4 });
    const database = fakeDatabase([[job]]);
    bindLocks(database);
    await expect(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction, { expectedAttempts: 4 })
    )).resolves.toEqual({ status: 'denied', resultCode: 'domain_state_not_retryable' });
    expect(repository.rearmFinancialClassificationJob).not.toHaveBeenCalled();
  });

  it.each([
    ['active identity while pending authority exists', lockedJob(), pendingAuthority()],
    ['pending identity without pending authority', lockedJob({ payload: pendingPayload() }), activeAuthority()],
    ['obsolete active versions', lockedJob({ payload: financialPayload({
      classifierVersion: 1, allocationAlgorithmVersion: 2, replayId: 'c1-a2'
    }) }), activeAuthority()]
  ])('denies %s as obsolete domain state', async (_label, job, authority) => {
    const database = fakeDatabase([[job]]);
    bindLocks(database, authority);
    await expect(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction)
    )).resolves.toEqual({ status: 'denied', resultCode: 'domain_state_not_retryable' });
    expect(repository.rearmFinancialClassificationJob).not.toHaveBeenCalled();
  });

  it.each([
    ['missing scan', []],
    ['wrong id', [scanRow({ id: JOB_ID })]],
    ['wrong root', [scanRow({ rootKey: 'private-canary' })]],
    ['wrong kind', [scanRow({ kind: 'hourly' })]],
    ['wrong state', [scanRow({ state: 'completed', completedAt: REARMED_AT })]],
    ['wrong phase', [scanRow({ phase: 'source_page' })]],
    ['wrong classifier', [scanRow({ classifierVersion: 3 })]],
    ['wrong allocation', [scanRow({ allocationAlgorithmVersion: 6 })]],
    ['wrong replay', [scanRow({ replayId: 'c4-a6' })]],
    ['completed running scan', [scanRow({ completedAt: REARMED_AT })]]
  ])('denies a pending replay with %s', async (_label, scanRows) => {
    const job = lockedJob({ payload: pendingPayload() });
    const database = fakeDatabase([[job], scanRows]);
    bindLocks(database, pendingAuthority());
    await expect(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction)
    )).resolves.toEqual({ status: 'denied', resultCode: 'domain_state_not_retryable' });
    expect(repository.rearmFinancialClassificationJob).not.toHaveBeenCalled();
  });

  it('distinguishes an absent source from fingerprint drift', async () => {
    const absent = fakeDatabase([[lockedJob()], []]);
    bindLocks(absent);
    await expect(createFinancialClassificationJobRetryPolicyAdapter()(
      context(absent.transaction)
    )).resolves.toEqual({ status: 'denied', resultCode: 'source_unavailable' });

    const drifted = fakeDatabase([[lockedJob()], [sourceRow({
      sourceFingerprintSha256: 'b'.repeat(64)
    })]]);
    bindLocks(drifted);
    await expect(createFinancialClassificationJobRetryPolicyAdapter()(
      context(drifted.transaction)
    )).resolves.toEqual({ status: 'denied', resultCode: 'domain_state_not_retryable' });
    expect(repository.rearmFinancialClassificationJob).not.toHaveBeenCalled();
  });

  it.each([
    ['different target', { id: COMMAND_ID }],
    ['different type', { type: 'commerce.financial-source' }],
    ['adopted scan identity', { payload: { ...financialPayload(), scanRunId: SCAN_RUN_ID } }],
    ['different deduplication key', { deduplicationKey: 'private-canary' }],
    ['wrong status', { status: 'failed' }],
    ['wrong attempts', { attempts: 1 }],
    ['wrong maximum', { maxAttempts: 6 }],
    ['wrong run timestamp', { runAt: new Date(REARMED_DATE.getTime() + 1) }],
    ['uncleared lock time', { lockedAt: REARMED_DATE }],
    ['uncleared lease', { lockedBy: 'private-canary' }],
    ['uncleared error', { lastError: 'private-canary' }],
    ['uncleared rerun request', { rerunRequestedAt: REARMED_DATE }],
    ['uncleared completion', { completedAt: REARMED_DATE }]
  ])('throws a fresh identity marker for a returned row with %s', async (_label, mutation) => {
    const job = lockedJob();
    const database = fakeDatabase([[job], [sourceRow()]]);
    bindLocks(database);
    bindPrimitive(database, rearmedJob(job, mutation));
    await identityFailure(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction)
    ));
  });

  it.each([
    ['dropped', financialPayload({
      subjectType: 'fee_detail', classifierVersion: 4,
      allocationAlgorithmVersion: 5, replayId: 'c4-a5'
    })],
    ['different', pendingPayload({ scanRunId: COMMAND_ID })]
  ])('rejects a primitive that returned a %s pending scan binding', async (_label, payload) => {
    const job = lockedJob({ payload: pendingPayload() });
    const database = fakeDatabase([
      [job], [scanRow()], [sourceRow({ balanceTransactionId: PARENT_ID })]
    ]);
    bindLocks(database, pendingAuthority());
    bindPrimitive(database, rearmedJob(job, { payload }));
    await identityFailure(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction)
    ));
  });

  it('correlates the returned reset time with the transaction timestamp', async () => {
    const job = lockedJob();
    const shifted = new Date(REARMED_DATE.getTime() + 1);
    const database = fakeDatabase([[job], [sourceRow()], [postcondition()]]);
    bindLocks(database);
    bindPrimitive(database, rearmedJob(job, { runAt: shifted, updatedAt: shifted }));
    await identityFailure(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction)
    ));
  });

  it.each([
    ['missing row', []],
    ['different target', [postcondition({ id: COMMAND_ID })]],
    ['different run time', [postcondition({ runAt: UPDATED_AT })]],
    ['different update time', [postcondition({ updatedAt: UPDATED_AT })]],
    ['different transaction time', [postcondition({ transactionTimestamp: UPDATED_AT })]],
    ['noncanonical precision', [postcondition({
      runAt: '2026-08-26T12:35:00.654Z',
      updatedAt: '2026-08-26T12:35:00.654Z',
      transactionTimestamp: '2026-08-26T12:35:00.654Z'
    })]]
  ])('throws a fresh identity marker for a postcondition with %s', async (_label, rows) => {
    const job = lockedJob();
    const database = fakeDatabase([[job], [sourceRow()], rows]);
    bindLocks(database);
    bindPrimitive(database, rearmedJob(job));
    await identityFailure(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction)
    ));
  });

  it('propagates a primitive failure without translating it', async () => {
    const job = lockedJob();
    const database = fakeDatabase([[job], [sourceRow()]]);
    bindLocks(database);
    const failure = new Error('private-canary');
    repository.rearmFinancialClassificationJob.mockRejectedValueOnce(failure);
    await expect(createFinancialClassificationJobRetryPolicyAdapter()(
      context(database.transaction)
    )).rejects.toBe(failure);
  });

  it('contains no provider call, direct transition, successor, or broad scan', () => {
    const source = readFileSync(new URL('./financial-classification.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/StripeGateway|stripeRuntime|\.gateway\b|\bfetch\s*\(|from\s+['"]stripe['"]/u);
    expect(source).not.toMatch(/\bupdate\s+(?:"public"\.)?"?jobs"?/iu);
    expect(source).not.toMatch(/\binsert\s+into\s+(?:"public"\.)?"?jobs"?/iu);
    expect(source).not.toMatch(/successor|order\s+by|\blimit\s+(?!1\b)/iu);
    expect(source).toContain('parseFinancialJobIdentity');
    expect(source).toContain('rearmFinancialClassificationJob');
  });
});
