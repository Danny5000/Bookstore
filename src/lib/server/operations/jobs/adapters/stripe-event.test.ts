import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { JobRetryPolicyContext } from '../policies';

const repository = vi.hoisted(() => ({
  rearmPendingStripeEventJob: vi.fn()
}));

vi.mock('$lib/server/jobs/repository', () => repository);

import {
  createStripeEventJobRetryPolicyAdapter
} from './stripe-event';
import { InvalidJobRetryPolicyIdentityError } from '../policies';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const UPDATED_AT = '2026-08-26T12:34:56.123456Z';
const REARMED_AT = '2026-08-26T12:35:00.654321Z';
const PROVIDER_EVENT_ID = 'evt_plan7a_adapter_1';

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`
  });
}

function target(overrides: Partial<JobRetryPolicyContext['target']> = {}) {
  return Object.freeze({
    commandId: '33333333-3333-4333-8333-333333333333',
    targetJobId: JOB_ID,
    expectedKind: 'commerce.stripe-event' as const,
    expectedStatus: 'failed' as const,
    expectedAttempts: 12,
    expectedMaxAttempts: 12,
    expectedUpdatedAt: UPDATED_AT,
    ...overrides
  });
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    providerEventId: PROVIDER_EVENT_ID,
    status: 'pending',
    processedAt: null,
    ...overrides
  };
}

function lockedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    type: 'commerce.stripe-event',
    payload: { stripeEventId: EVENT_ID },
    deduplicationKey: `stripe:event:${PROVIDER_EVENT_ID}`,
    status: 'failed',
    attempts: 12,
    maxAttempts: 12,
    updatedAt: UPDATED_AT,
    ...overrides
  };
}

function rearmedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    status: 'pending',
    attempts: 0,
    maxAttempts: 12,
    runAt: REARMED_AT,
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    rerunRequestedAt: null,
    completedAt: null,
    updatedAt: REARMED_AT,
    transactionTimestamp: REARMED_AT,
    ...overrides
  };
}

function transaction(responses: readonly unknown[][]) {
  const calls: SQL[] = [];
  const operations: string[] = [];
  let index = 0;
  const execute = vi.fn(async (query: SQL) => {
    calls.push(query);
    const statement = rendered(query).sql;
    if (statement.includes('transaction_timestamp()')) operations.push('postcondition');
    else if (statement.includes('from "public"."stripe_events"')) operations.push('event-lock');
    else if (statement.includes('for update')) operations.push('target-lock');
    else operations.push('lookup');
    return { rows: responses[index++] ?? [] };
  });
  return {
    calls,
    operations,
    transaction: { execute } as unknown as DatabaseTransaction
  };
}

function context(
  database: DatabaseTransaction,
  targetOverride: Partial<JobRetryPolicyContext['target']> = {}
): JobRetryPolicyContext {
  return Object.freeze({
    transaction: database,
    target: target(targetOverride),
    signal: new AbortController().signal
  });
}

function successfulDatabase(
  event = eventRow(),
  job = lockedJob(),
  rearmed = rearmedJob()
) {
  return transaction([
    [{ stripeEventId: EVENT_ID }],
    [event],
    [job],
    [rearmed]
  ]);
}

describe('Stripe event operations retry adapter', () => {
  beforeEach(() => {
    repository.rearmPendingStripeEventJob.mockReset();
  });

  it('locks event then exact target, reuses the existing primitive, and verifies the reset', async () => {
    const database = successfulDatabase();
    repository.rearmPendingStripeEventJob.mockImplementationOnce(async () => {
      database.operations.push('primitive');
      return true;
    });
    const adapter = createStripeEventJobRetryPolicyAdapter();

    const outcome = await adapter(context(database.transaction));

    expect(outcome).toEqual({ status: 'succeeded', resultCode: 'rearmed_existing' });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(repository.rearmPendingStripeEventJob)
      .toHaveBeenCalledWith(database.transaction, EVENT_ID);
    expect(database.operations).toEqual([
      'lookup', 'event-lock', 'target-lock', 'primitive', 'postcondition'
    ]);
    expect(database.calls).toHaveLength(4);

    const lookup = rendered(database.calls[0]!);
    expect(lookup.sql).toContain('from "public"."jobs"');
    expect(lookup.sql).toContain('limit 1');
    expect(lookup.sql).not.toContain('for update');
    expect(lookup.sql).toContain('as "stripeEventId"');
    expect(lookup.sql).not.toMatch(/as "(?:type|status|attempts|maxAttempts|updatedAt|deduplicationKey)"/u);
    expect(lookup.params).toEqual([JOB_ID]);

    const eventLock = rendered(database.calls[1]!);
    const targetLock = rendered(database.calls[2]!);
    expect(eventLock.sql).toContain('from "public"."stripe_events"');
    expect(eventLock.sql).toContain('for update');
    expect(eventLock.params).toEqual([EVENT_ID]);
    expect(targetLock.sql).toContain('from "public"."jobs"');
    expect(targetLock.sql).toContain('for update');
    expect(targetLock.params).toEqual([JOB_ID]);

    const postcondition = rendered(database.calls[3]!);
    expect(postcondition.sql).toContain('transaction_timestamp()');
    expect(postcondition.params).toEqual([JOB_ID]);
    expect(database.calls.map((query) => rendered(query).sql).join('\n'))
      .not.toMatch(/update\s+"public"\."jobs"/iu);
  });

  it.each([
    ['type', { type: 'commerce.financial-source' }],
    ['status', { status: 'pending' }],
    ['attempts', { attempts: 13 }],
    ['maximum attempts', { maxAttempts: 13 }],
    ['updated timestamp', { updatedAt: '2026-08-26T12:34:56.123457Z' }]
  ])('denies when the submitted %s snapshot changed', async (_label, changed) => {
    const database = transaction([
      [{ stripeEventId: EVENT_ID }],
      [eventRow()],
      [lockedJob(changed)]
    ]);

    await expect(createStripeEventJobRetryPolicyAdapter()(context(database.transaction)))
      .resolves.toEqual({ status: 'denied', resultCode: 'target_state_changed' });
    expect(repository.rearmPendingStripeEventJob).not.toHaveBeenCalled();
  });

  it('maps a missing target to changed state and a missing event to unavailable source', async () => {
    const missingTarget = transaction([]);
    await expect(createStripeEventJobRetryPolicyAdapter()(context(missingTarget.transaction)))
      .resolves.toEqual({ status: 'denied', resultCode: 'target_state_changed' });

    const missingEvent = transaction([[{ stripeEventId: EVENT_ID }], [], [lockedJob()]]);
    await expect(createStripeEventJobRetryPolicyAdapter()(context(missingEvent.transaction)))
      .resolves.toEqual({ status: 'denied', resultCode: 'source_unavailable' });
    expect(missingEvent.calls).toHaveLength(3);
    expect(repository.rearmPendingStripeEventJob).not.toHaveBeenCalled();
  });

  it.each([
    ['nonpending event', eventRow({ status: 'processed', processedAt: REARMED_AT }), lockedJob(), target()],
    ['processed pending event', eventRow({ processedAt: REARMED_AT }), lockedJob(), target()],
    ['nonexhausted target', eventRow(), lockedJob({ attempts: 11 }), target({ expectedAttempts: 11 })]
  ])('denies a %s as domain state that is no longer retryable', async (_label, event, job, expected) => {
    const database = transaction([
      [{ stripeEventId: EVENT_ID }],
      [event],
      [job]
    ]);

    await expect(createStripeEventJobRetryPolicyAdapter()({
      transaction: database.transaction,
      target: expected,
      signal: new AbortController().signal
    })).resolves.toEqual({ status: 'denied', resultCode: 'domain_state_not_retryable' });
    expect(repository.rearmPendingStripeEventJob).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed payload', lockedJob({ payload: { stripeEventId: EVENT_ID, extra: true } })],
    ['different payload association', lockedJob({ payload: { stripeEventId: '44444444-4444-4444-8444-444444444444' } })],
    ['wrong deduplication identity', lockedJob({ deduplicationKey: 'stripe:event:other' })],
    ['wrong catalog maximum', lockedJob({ maxAttempts: 11, attempts: 11 })]
  ])('fails a %s as an invalid retry-command identity', async (_label, job) => {
    const expected = job.maxAttempts === 11
      ? { expectedAttempts: 11, expectedMaxAttempts: 11 }
      : {};
    const database = transaction([
      [{ stripeEventId: EVENT_ID }],
      [eventRow()],
      [job]
    ]);

    await expect(createStripeEventJobRetryPolicyAdapter()(
      context(database.transaction, expected)
    )).resolves.toEqual({ status: 'failed', resultCode: 'retry_command_invalid' });
    expect(repository.rearmPendingStripeEventJob).not.toHaveBeenCalled();
  });

  it('fails malformed lookup and cross-policy identity without locking domain rows', async () => {
    const malformed = transaction([[{ stripeEventId: 'private-canary' }]]);
    await expect(createStripeEventJobRetryPolicyAdapter()(context(malformed.transaction)))
      .resolves.toEqual({ status: 'failed', resultCode: 'retry_command_invalid' });
    expect(malformed.calls).toHaveLength(1);

    const crossPolicy = transaction([]);
    await expect(createStripeEventJobRetryPolicyAdapter()(context(crossPolicy.transaction, {
      expectedKind: 'commerce.financial-classification'
    }))).resolves.toEqual({ status: 'failed', resultCode: 'retry_command_invalid' });
    expect(crossPolicy.calls).toHaveLength(0);
  });

  it.each([
    ['primitive returned false', false, rearmedJob()],
    ['wrong postcondition target', true, rearmedJob({ id: '55555555-5555-4555-8555-555555555555' })],
    ['wrong status', true, rearmedJob({ status: 'failed' })],
    ['wrong attempts', true, rearmedJob({ attempts: 1 })],
    ['wrong maximum', true, rearmedJob({ maxAttempts: 13 })],
    ['wrong run timestamp', true, rearmedJob({ runAt: '2026-08-26T12:35:00.654322Z' })],
    ['uncleared lock timestamp', true, rearmedJob({ lockedAt: REARMED_AT })],
    ['uncleared lease', true, rearmedJob({ lockedBy: 'private-canary' })],
    ['uncleared error', true, rearmedJob({ lastError: 'private-canary' })],
    ['uncleared rerun request', true, rearmedJob({ rerunRequestedAt: REARMED_AT })],
    ['uncleared completion', true, rearmedJob({ completedAt: REARMED_AT })],
    ['different reset timestamps', true, rearmedJob({ updatedAt: '2026-08-26T12:35:00.654322Z' })],
    ['malformed transaction timestamp', true, rearmedJob({
      runAt: '2026-08-26T12:35:00.654Z',
      updatedAt: '2026-08-26T12:35:00.654Z',
      transactionTimestamp: '2026-08-26T12:35:00.654Z'
    })]
  ])('throws a fresh no-cause identity marker when the %s', async (_label, primitiveResult, postcondition) => {
    repository.rearmPendingStripeEventJob.mockResolvedValueOnce(primitiveResult);
    const database = successfulDatabase(eventRow(), lockedJob(), postcondition);

    const failure = await createStripeEventJobRetryPolicyAdapter()(context(database.transaction))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InvalidJobRetryPolicyIdentityError);
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain('private-canary');
  });

  it('contains no provider dependency or replacement update SQL', () => {
    const source = readFileSync(new URL('./stripe-event.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/StripeGateway|stripeRuntime|\.gateway\b|\bfetch\s*\(|from\s+['"]stripe['"]/u);
    expect(source).not.toMatch(/\bupdate\s+(?:"public"\.)?"?jobs"?/iu);
    expect(source).toContain('rearmPendingStripeEventJob');
  });
});
