import { randomUUID } from 'node:crypto';
import { eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { expect, it } from 'vitest';
import {
  FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  FINANCIAL_CLASSIFIER_VERSION,
  FINANCIAL_REPLAY_ID
} from '$lib/server/commerce/financial/constants';
import {
  createFinancialScheduleEnsurer,
  ensureHourlyFinancialScan
} from '$lib/server/commerce/financial/scans/scheduler';
import { processFinancialScanJob } from '$lib/server/commerce/financial/scans/service';
import {
  rearmCurrentProjectionSubjectsForFinancialSource,
  stageBalanceTransaction
} from '$lib/server/commerce/financial/ledger';
import { createFinancialClassificationHandler } from '$lib/server/commerce/financial/handlers/classification';
import { createFinancialClassificationSubjectJob } from '$lib/server/commerce/financial/jobs';
import { replayFinancialClassificationLocked } from '$lib/server/commerce/financial/rebase';
import {
  loadFinancialSourceScanPage,
  startOrResumeFinancialScan,
  loadIncompletePayoutRunPage
} from '$lib/server/commerce/financial/scans/repository';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { FinancialScanRunRow, JsonObject } from '$lib/server/db/schema';
import {
  financialProjectionVersions, financialReconciliationIssues, financialScanRuns, jobs, orders, payments,
  payoutImportRuns, stripeBalanceTransactions, stripePayouts
} from '$lib/server/db/schema';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { runWorker } from '$lib/server/jobs/runner';
import {
  applicationConfig,
  ownerDatabaseClient,
  workerDatabaseClient as databaseClient
} from './database';

const dialect = new PgDialect();

function renderedQuery(query: unknown): string {
  return dialect.sqlToQuery((query as SQLWrapper).getSQL()).sql;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForBlockedProjectionFinalizer(): Promise<number[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await databaseClient.pool.query<{ blockers: number[] }>(`
      select pg_blocking_pids(pid) as blockers
      from pg_stat_activity
      where cardinality(pg_blocking_pids(pid)) > 0
        and query like '%pending_classifier_version%'
      order by pid
    `);
    if (result.rows[0]?.blockers.length) return result.rows[0].blockers;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the replay finalizer at the projection-version fence');
}

async function blockedReplayEnrollmentPids(): Promise<number[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await databaseClient.pool.query<{ blockers: number[] }>(`
      select pg_blocking_pids(pid) as blockers
      from pg_stat_activity
      where cardinality(pg_blocking_pids(pid)) > 0
        and wait_event_type = 'Lock'
        and wait_event = 'advisory'
        and query like '%hashtextextended%'
      order by pid
    `);
    if (result.rows[0]?.blockers.length) return result.rows[0].blockers;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

it('converges concurrent workers on permanent roots and creates one new hour', async () => {
  const now = new Date('2026-08-12T19:42:00.000Z');
  await Promise.all([
    ensureHourlyFinancialScan(databaseClient.db, {
      now, classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    }),
    ensureHourlyFinancialScan(databaseClient.db, {
      now, classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    })
  ]);
  const firstKeys = [
    'commerce.financial-scan:initial:v1',
    'commerce.financial-scan:2026-08-12T19:00:00.000Z',
    `commerce.financial-classification:scan:${FINANCIAL_CLASSIFIER_VERSION}:` +
      FINANCIAL_ALLOCATION_ALGORITHM_VERSION
  ];
  expect(await databaseClient.db.select().from(jobs).where(
    inArray(jobs.deduplicationKey, firstKeys)
  )).toHaveLength(3);

  await ensureHourlyFinancialScan(databaseClient.db, {
    now: new Date('2026-08-12T20:00:00.000Z'),
    classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
    allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
  });
  expect(await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey, 'commerce.financial-scan:2026-08-12T20:00:00.000Z')
  )).toHaveLength(1);
  expect(await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey,
      `commerce.financial-classification:scan:${FINANCIAL_CLASSIFIER_VERSION}:` +
        FINANCIAL_ALLOCATION_ALGORITHM_VERSION)
  )).toHaveLength(1);
});

it('converges two real worker polling loops without retaining a database lease', async () => {
  const now = new Date('2026-08-12T19:42:00.000Z');
  const runOnePoll = async (workerId: string): Promise<void> => {
    const controller = new AbortController();
    const ensure = createFinancialScheduleEnsurer({
      database: databaseClient.db, runtimeMode: 'stripe',
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    });
    await runWorker({
      repository: createPostgresJobRepository(databaseClient.db, applicationConfig.jobs),
      handlers: new Map(), workerId, concurrency: 1,
      pollIntervalMs: applicationConfig.jobs.pollIntervalMs,
      leaseRenewalIntervalMs: Math.max(1, Math.floor(applicationConfig.jobs.leaseMs / 3)),
      signal: controller.signal,
      beforePoll: async ({ signal }) => {
        await ensure({ now, signal });
        controller.abort();
      }
    });
  };

  await Promise.all([runOnePoll('financial-scheduler-a'), runOnePoll('financial-scheduler-b')]);
  const keys = [
    'commerce.financial-scan:initial:v1',
    'commerce.financial-scan:2026-08-12T19:00:00.000Z',
    `commerce.financial-classification:scan:${FINANCIAL_CLASSIFIER_VERSION}:` +
      FINANCIAL_ALLOCATION_ALGORITHM_VERSION
  ];
  expect(await databaseClient.db.select().from(jobs).where(
    inArray(jobs.deduplicationKey, keys)
  )).toHaveLength(3);
  await expect(databaseClient.db.execute(sql`select 1 as healthy`)).resolves.toBeDefined();
});

it('commits a bounded source page and its continuation atomically', async () => {
  const suffix = randomUUID();
  const [order] = await ownerDatabaseClient.db.insert(orders).values({
    status: 'checkout_open', currency: 'USD', subtotalMinor: 1000,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'a'.repeat(64),
    statusTokenSha256: 'b'.repeat(64)
  }).returning();
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId: order!.id, stripePaymentIntentId: `pi_scan_${suffix}`,
    stripeLatestChargeId: `ch_scan_${suffix}`, status: 'succeeded', amountMinor: 1000,
    currency: 'USD', paidAt: new Date('2026-08-12T18:00:00.000Z'),
    paymentMethodCategory: 'card', financialEvidenceStatus: 'pending'
  }).returning();

  await expect(processFinancialScanJob({
    database: databaseClient.db,
    gateway: {} as StripeCommerceGateway,
    runtimeMode: 'stripe'
  }, {
    payload: { kind: 'hourly', scanGenerationHour: '2026-08-12T19:00:00.000Z' },
    correlationId: `scan-source-${suffix}`,
    signal: new AbortController().signal
  })).resolves.toEqual({ status: 'continued', runId: expect.any(String) });

  const [run] = await databaseClient.db.select().from(financialScanRuns);
  expect(run).toMatchObject({
    kind: 'hourly', phase: 'payout_discovery_page', state: 'running',
    processedCount: 1, enqueuedCount: 1, pageCount: 1, checkpoint: null
  });
  expect(await databaseClient.db.select().from(jobs).where(eq(
    jobs.deduplicationKey,
    `financial:source:scan:payment:${payment!.id}:2026-08-12T19:00:00.000Z`
  ))).toHaveLength(1);
  expect(await databaseClient.db.select().from(jobs).where(eq(
    jobs.deduplicationKey,
    `commerce.financial-scan:${run!.id}:payout_discovery_page:${run!.cursorDigestSha256}`
  ))).toHaveLength(1);
});

it('treats a continuation replay after its committed page as unchanged', async () => {
  const signal = new AbortController().signal;
  const gateway = {
    listPayouts: async () => ({ data: [], hasMore: false, nextStartingAfter: null })
  } as unknown as StripeCommerceGateway;
  const root = {
    payload: { kind: 'hourly' as const, scanGenerationHour: '2026-08-12T21:00:00.000Z' },
    correlationId: 'scan-crash-root', signal
  };

  await processFinancialScanJob({ database: databaseClient.db, gateway, runtimeMode: 'stripe' }, root);
  const [afterRoot] = await databaseClient.db.select().from(financialScanRuns);
  const committedPage = {
    kind: 'continuation' as const,
    scanRunId: afterRoot!.id,
    phase: 'payout_discovery_page' as const,
    cursorDigestSha256: afterRoot!.cursorDigestSha256!,
    limit: 100
  };
  await processFinancialScanJob({ database: databaseClient.db, gateway, runtimeMode: 'stripe' }, {
    payload: committedPage, correlationId: 'scan-crash-page', signal
  });

  await expect(processFinancialScanJob({
    database: databaseClient.db, gateway, runtimeMode: 'stripe'
  }, {
    payload: committedPage, correlationId: 'scan-crash-replay', signal
  })).resolves.toEqual({ status: 'unchanged', runId: null });

  const [afterReplay] = await databaseClient.db.select().from(financialScanRuns);
  expect(afterReplay).toMatchObject({
    id: afterRoot!.id, phase: 'incomplete_payout_run_page', state: 'running', pageCount: 2
  });
});

it('pages incomplete payout runs in the same exact order as its run-id checkpoint', async () => {
  const now = new Date('2026-08-12T21:00:00.000Z');
  const payoutAId = '00000000-0000-4000-8000-000000000101';
  const payoutBId = '00000000-0000-4000-8000-000000000102';
  const earlierRunId = '10000000-0000-4000-8000-000000000201';
  const laterRunId = 'f0000000-0000-4000-8000-000000000202';
  await databaseClient.db.insert(stripePayouts).values([
    {
      id: payoutAId, providerId: 'po_scan_order_a', liveMode: false, amountMinor: 1000,
      currency: 'USD', automatic: true, method: 'standard', status: 'paid',
      reconciliationStatus: 'completed', providerCreatedAt: now, arrivalAt: now,
      retrievedAt: now, fingerprintSha256: 'a'.repeat(64)
    },
    {
      id: payoutBId, providerId: 'po_scan_order_b', liveMode: false, amountMinor: 1000,
      currency: 'USD', automatic: true, method: 'standard', status: 'paid',
      reconciliationStatus: 'completed', providerCreatedAt: now, arrivalAt: now,
      retrievedAt: now, fingerprintSha256: 'b'.repeat(64)
    }
  ]);
  await databaseClient.db.insert(payoutImportRuns).values([
    { id: laterRunId, payoutId: payoutAId, generation: 0, state: 'collecting' },
    { id: earlierRunId, payoutId: payoutBId, generation: 0, state: 'collecting' }
  ]);
  const run: FinancialScanRunRow = {
    id: randomUUID(), rootKey: 'commerce.financial-scan:2026-08-12T21:00:00.000Z',
    kind: 'hourly', phase: 'incomplete_payout_run_page', state: 'running',
    classifierVersion: null, allocationAlgorithmVersion: null, replayId: null,
    payoutDiscoveryCreatedGte: null, payoutDiscoveryCreatedLt: null,
    checkpoint: null, cursorDigestSha256: null, processedCount: 0, enqueuedCount: 0,
    pageCount: 0, safeOutcome: null, startedAt: now, updatedAt: now, completedAt: null
  };

  const first = await loadIncompletePayoutRunPage(databaseClient.db, run, 1);
  expect(first).toEqual({
    data: [{ providerPayoutId: 'po_scan_order_b', runId: earlierRunId }],
    hasMore: true,
    checkpoint: earlierRunId
  });
  const second = await loadIncompletePayoutRunPage(databaseClient.db, {
    ...run, checkpoint: first.checkpoint
  }, 1);
  expect(second).toEqual({
    data: [{ providerPayoutId: 'po_scan_order_a', runId: laterRunId }],
    hasMore: false,
    checkpoint: null
  });
});

it('pages open payout-reversal issues through the local incomplete phase', async () => {
  const now = new Date('2026-08-12T21:00:00.000Z');
  const payoutAId = randomUUID();
  const payoutBId = randomUUID();
  const earlierIssueId = '00000000-0000-4000-8000-000000000071';
  const laterIssueId = '00000000-0000-4000-8000-000000000072';
  await databaseClient.db.insert(stripePayouts).values([
    {
      id: payoutAId, providerId: `po_scan_reversal_a_${payoutAId}`, liveMode: false,
      amountMinor: 1000, currency: 'USD', automatic: true, method: 'standard', status: 'failed',
      reconciliationStatus: 'completed', providerCreatedAt: now, arrivalAt: now,
      retrievedAt: now, fingerprintSha256: 'd'.repeat(64)
    },
    {
      id: payoutBId, providerId: `po_scan_reversal_b_${payoutBId}`, liveMode: false,
      amountMinor: 1000, currency: 'USD', automatic: true, method: 'standard', status: 'failed',
      reconciliationStatus: 'completed', providerCreatedAt: now, arrivalAt: now,
      retrievedAt: now, fingerprintSha256: 'e'.repeat(64)
    }
  ]);
  await databaseClient.db.insert(financialReconciliationIssues).values([
    {
      id: laterIssueId, resourceType: 'payout', resourceId: payoutAId,
      safeCode: 'payout_reversal_incomplete', state: 'open', impact: 'exception',
      occurrenceCount: 1, correlationId: 'scan-reversal-a'
    },
    {
      id: earlierIssueId, resourceType: 'payout', resourceId: payoutBId,
      safeCode: 'payout_reversal_incomplete', state: 'open', impact: 'exception',
      occurrenceCount: 1, correlationId: 'scan-reversal-b'
    }
  ]);
  const run: FinancialScanRunRow = {
    id: randomUUID(), rootKey: 'commerce.financial-scan:2026-08-12T21:00:00.000Z',
    kind: 'hourly', phase: 'incomplete_payout_run_page', state: 'running',
    classifierVersion: null, allocationAlgorithmVersion: null, replayId: null,
    payoutDiscoveryCreatedGte: null, payoutDiscoveryCreatedLt: null,
    checkpoint: null, cursorDigestSha256: null, processedCount: 0, enqueuedCount: 0,
    pageCount: 0, safeOutcome: null, startedAt: now, updatedAt: now, completedAt: null
  };

  const first = await loadIncompletePayoutRunPage(databaseClient.db, run, 1);
  expect(first).toEqual({
    data: [{ providerPayoutId: `po_scan_reversal_b_${payoutBId}`, runId: earlierIssueId }],
    hasMore: true,
    checkpoint: earlierIssueId
  });
  const second = await loadIncompletePayoutRunPage(databaseClient.db, {
    ...run, checkpoint: first.checkpoint
  }, 1);
  expect(second).toEqual({
    data: [{ providerPayoutId: `po_scan_reversal_a_${payoutAId}`, runId: laterIssueId }],
    hasMore: false,
    checkpoint: null
  });
});

it('targets a missing referenced reversal payout from its durable local issue', async () => {
  const now = new Date('2026-08-12T21:00:00.000Z');
  const payoutId = randomUUID();
  const issueId = randomUUID();
  const missingProviderPayoutId = `po_scan_missing_reversal_${payoutId}`;
  await databaseClient.db.insert(stripePayouts).values({
    id: payoutId, providerId: `po_scan_reversed_source_${payoutId}`, liveMode: false,
    amountMinor: 1000, currency: 'USD', automatic: true, method: 'standard', status: 'paid',
    reconciliationStatus: 'completed', providerCreatedAt: now, arrivalAt: now,
    retrievedAt: now, reversedByProviderPayoutId: missingProviderPayoutId,
    fingerprintSha256: 'f'.repeat(64)
  });
  await databaseClient.db.insert(financialReconciliationIssues).values({
    id: issueId, resourceType: 'payout', resourceId: payoutId,
    safeCode: 'payout_reversal_incomplete', state: 'open', impact: 'exception',
    occurrenceCount: 1, correlationId: 'scan-missing-reversal'
  });
  const run: FinancialScanRunRow = {
    id: randomUUID(), rootKey: 'commerce.financial-scan:2026-08-12T21:00:00.000Z',
    kind: 'hourly', phase: 'incomplete_payout_run_page', state: 'running',
    classifierVersion: null, allocationAlgorithmVersion: null, replayId: null,
    payoutDiscoveryCreatedGte: null, payoutDiscoveryCreatedLt: null,
    checkpoint: null, cursorDigestSha256: null, processedCount: 0, enqueuedCount: 0,
    pageCount: 0, safeOutcome: null, startedAt: now, updatedAt: now, completedAt: null
  };

  await expect(loadIncompletePayoutRunPage(databaseClient.db, run, 1)).resolves.toEqual({
    data: [{ providerPayoutId: missingProviderPayoutId, runId: issueId }],
    hasMore: false,
    checkpoint: null
  });
});

it('recovers an incomplete payout run through the bounded hourly phase', async () => {
  const now = new Date('2026-08-12T21:00:00.000Z');
  const payoutId = '00000000-0000-4000-8000-000000000211';
  await databaseClient.db.insert(stripePayouts).values({
    id: payoutId, providerId: 'po_scan_incomplete', liveMode: false, amountMinor: 1000,
    currency: 'USD', automatic: true, method: 'standard', status: 'paid',
    reconciliationStatus: 'completed', providerCreatedAt: now, arrivalAt: now,
    retrievedAt: now, fingerprintSha256: 'c'.repeat(64)
  });
  await databaseClient.db.insert(payoutImportRuns).values({
    payoutId, generation: 0, state: 'collecting'
  });
  const gateway = {
    listPayouts: async () => ({ data: [], hasMore: false, nextStartingAfter: null })
  } as unknown as StripeCommerceGateway;
  const dependencies = { database: databaseClient.db, gateway, runtimeMode: 'stripe' as const };
  const signal = new AbortController().signal;
  await processFinancialScanJob(dependencies, {
    payload: { kind: 'hourly', scanGenerationHour: '2026-08-12T21:00:00.000Z' },
    correlationId: 'scan-incomplete-root', signal
  });
  let [run] = await databaseClient.db.select().from(financialScanRuns);
  await processFinancialScanJob(dependencies, {
    payload: { kind: 'continuation', scanRunId: run!.id, phase: 'payout_discovery_page',
      cursorDigestSha256: run!.cursorDigestSha256!, limit: 100 },
    correlationId: 'scan-incomplete-discovery', signal
  });
  [run] = await databaseClient.db.select().from(financialScanRuns);
  await expect(processFinancialScanJob(dependencies, {
    payload: { kind: 'continuation', scanRunId: run!.id,
      phase: 'incomplete_payout_run_page', cursorDigestSha256: run!.cursorDigestSha256!,
      limit: 100 },
    correlationId: 'scan-incomplete-recovery', signal
  })).resolves.toEqual({ status: 'completed', runId: run!.id });

  expect(await databaseClient.db.select().from(jobs).where(eq(
    jobs.deduplicationKey,
    'financial:payout:scan:po_scan_incomplete:2026-08-12T21:00:00.000Z'
  ))).toHaveLength(1);
});

it('scans pending and retryable exceptions but excludes durable exception-impact issues', async () => {
  const now = new Date('2026-08-12T21:00:00.000Z');
  const orderIds = [
    '00000000-0000-4000-8000-000000000301',
    '00000000-0000-4000-8000-000000000302',
    '00000000-0000-4000-8000-000000000303',
    '00000000-0000-4000-8000-000000000304'
  ];
  const paymentIds = [
    '00000000-0000-4000-8000-000000000401',
    '00000000-0000-4000-8000-000000000402',
    '00000000-0000-4000-8000-000000000403',
    '00000000-0000-4000-8000-000000000404'
  ];
  await ownerDatabaseClient.db.insert(orders).values(orderIds.map((id, index) => ({
    id, status: 'checkout_open' as const, currency: 'USD', subtotalMinor: 1000,
    clientCheckoutAttemptId: `00000000-0000-4000-8000-0000000005${String(index + 1).padStart(2, '0')}`,
    quoteFingerprintSha256: 'a'.repeat(64), statusTokenSha256: 'b'.repeat(64)
  })));
  await ownerDatabaseClient.db.insert(payments).values(paymentIds.map((id, index) => ({
    id, orderId: orderIds[index]!, stripePaymentIntentId: `pi_scan_issue_${index}`,
    stripeLatestChargeId: `ch_scan_issue_${index}`, status: 'succeeded' as const,
    amountMinor: 1000, currency: 'USD', paidAt: now, paymentMethodCategory: 'card' as const,
    financialEvidenceStatus: index === 0 ? 'pending' as const : 'exception' as const
  })));
  await databaseClient.db.insert(financialReconciliationIssues).values([
    {
      resourceType: 'payment', resourceId: paymentIds[2]!, safeCode: 'missing_source',
      impact: 'pending', correlationId: 'scan-retryable-issue'
    },
    {
      resourceType: 'payment', resourceId: paymentIds[3]!, safeCode: 'immutable_mismatch',
      impact: 'exception', correlationId: 'scan-durable-issue'
    }
  ]);
  const run: FinancialScanRunRow = {
    id: randomUUID(), rootKey: 'commerce.financial-scan:2026-08-12T21:00:00.000Z',
    kind: 'hourly', phase: 'source_page', state: 'running', classifierVersion: null,
    allocationAlgorithmVersion: null, replayId: null,
    payoutDiscoveryCreatedGte: null, payoutDiscoveryCreatedLt: null, checkpoint: null,
    cursorDigestSha256: null, processedCount: 0, enqueuedCount: 0, pageCount: 0,
    safeOutcome: null, startedAt: now, updatedAt: now, completedAt: null
  };

  const page = await loadFinancialSourceScanPage(databaseClient.db, run, 100);
  expect(page.data).toEqual(paymentIds.slice(0, 3).map((sourceId) => ({
    sourceKind: 'payment', sourceId
  })));
  expect(page.hasMore).toBe(false);
});

it('seals a disabled composite replay behind its durable child barrier without provider access', async () => {
  const now = new Date('2026-08-12T21:00:00.000Z');
  await databaseClient.db.insert(stripeBalanceTransactions).values(
    Array.from({ length: 101 }, (_, index) => ({
      providerId: `txn_scan_replay_${index}`, liveMode: false, sourceFamily: null,
      sourceId: null, rawType: 'charge', reportingCategory: 'charge',
      balanceType: 'payments', amountMinor: 100, feeMinor: 10, netMinor: 90,
      currency: 'USD', status: 'available' as const, providerCreatedAt: now,
      availableAt: now, fingerprintSha256: index.toString(16).padStart(64, '0')
    }))
  );
  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as StripeCommerceGateway;
  const dependencies = { database: databaseClient.db, gateway, runtimeMode: 'disabled' as const };
  const signal = new AbortController().signal;

  await expect(processFinancialScanJob(dependencies, {
    payload: { kind: 'composite_replay', classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      replayId: FINANCIAL_REPLAY_ID },
    correlationId: 'scan-disabled-root', signal
  })).resolves.toEqual({ status: 'continued', runId: expect.any(String) });
  const [afterFirstPage] = await databaseClient.db.select().from(financialScanRuns);
  await expect(processFinancialScanJob(dependencies, {
    payload: {
      kind: 'continuation', scanRunId: afterFirstPage!.id,
      phase: 'classification_replay_page',
      cursorDigestSha256: afterFirstPage!.cursorDigestSha256!, limit: 100
    },
    correlationId: 'scan-disabled-second-page', signal
  })).resolves.toEqual({ status: 'continued', runId: afterFirstPage!.id });

  const [sealed] = await databaseClient.db.select().from(financialScanRuns);
  expect(sealed).toMatchObject({
    state: 'running', phase: 'classification_replay_finalize',
    processedCount: 101, enqueuedCount: 101, pageCount: 2,
    checkpoint: null, cursorDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    safeOutcome: null, completedAt: null
  });
  const children = await databaseClient.db.select().from(jobs).where(
    eq(jobs.type, 'commerce.financial-classification')
  );
  expect(children).toHaveLength(101);
  expect(children.every((job) => job.payload.scanRunId === sealed!.id)).toBe(true);
  expect(await databaseClient.db.select().from(jobs).where(eq(
    jobs.deduplicationKey,
    `commerce.financial-scan:${sealed!.id}:classification_replay_finalize:${sealed!.cursorDigestSha256}`
  ))).toHaveLength(1);
});

it('enrolls evidence inserted after replay enumeration before allowing target activation', async () => {
  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as StripeCommerceGateway;
  const dependencies = { database: databaseClient.db, gateway, runtimeMode: 'disabled' as const };
  const signal = new AbortController().signal;

  await expect(processFinancialScanJob(dependencies, {
    payload: { kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2' },
    correlationId: 'scan-late-evidence-root', signal
  })).resolves.toEqual({ status: 'continued', runId: expect.any(String) });
  const [sealed] = await databaseClient.db.select().from(financialScanRuns);
  expect(sealed).toMatchObject({
    state: 'running', phase: 'classification_replay_finalize', completedAt: null
  });
  const [pendingVersion] = await databaseClient.db.select().from(financialProjectionVersions);
  expect(pendingVersion).toMatchObject({
    classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
    allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
    pendingClassifierVersion: 2, pendingAllocationAlgorithmVersion: 2,
    pendingScanRunId: sealed!.id
  });

  const suffix = randomUUID().replaceAll('-', '');
  await stageBalanceTransaction(databaseClient.db, {
    id: `txn_late_replay_${suffix}`, livemode: false,
    sourceFamily: 'adjustment', sourceId: null, rawType: 'adjustment',
    reportingCategory: 'other_adjustment', balanceType: 'adjustment',
    amountMinor: 25, feeMinor: 1, netMinor: 24, currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T21:00:00.000Z'),
    availableAt: new Date('2026-08-12T21:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null,
    feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 1, currency: 'USD' }]
  }, { correlationId: 'scan-late-evidence-stage' }, {
    classifierVersion: 2, allocationAlgorithmVersion: 2
  });

  const linkedChildren = await databaseClient.db.select().from(jobs).where(
    eq(jobs.type, 'commerce.financial-classification')
  );
  expect(linkedChildren.map((job) => ({
    scanRunId: job.payload.scanRunId, subjectType: job.payload.subjectType
  }))).toEqual(expect.arrayContaining([
    { scanRunId: sealed!.id, subjectType: 'balance_transaction' },
    { scanRunId: sealed!.id, subjectType: 'fee_detail' }
  ]));

  await databaseClient.db.update(jobs).set({
    status: 'failed', attempts: 5, completedAt: new Date(), lastError: 'bounded child failure'
  }).where(eq(jobs.type, 'commerce.financial-classification'));
  const repository = createPostgresJobRepository(
    databaseClient.db, applicationConfig.jobs, () => new Date('2100-01-01T00:00:00.000Z'),
    'local-only', { classifierVersion: 2, allocationAlgorithmVersion: 2 }
  );
  await expect(repository.claimNext('late-replay-finalizer')).resolves.toBeNull();
  expect((await databaseClient.db.select().from(financialProjectionVersions))[0])
    .toMatchObject({ classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION });
  expect((await databaseClient.db.select().from(financialScanRuns))[0])
    .toMatchObject({ state: 'running', completedAt: null });

  await databaseClient.db.update(jobs).set({ status: 'succeeded' }).where(
    eq(jobs.type, 'commerce.financial-classification')
  );
  const finalizer = await repository.claimNext('late-replay-finalizer');
  expect(finalizer).toMatchObject({
    type: 'commerce.financial-scan',
    payload: expect.objectContaining({
      kind: 'continuation', phase: 'classification_replay_finalize',
      scanRunId: sealed!.id
    })
  });
  await expect(processFinancialScanJob(dependencies, {
    payload: finalizer!.payload as never,
    correlationId: 'scan-late-evidence-finalize', signal
  })).resolves.toEqual({ status: 'completed', runId: sealed!.id });
  await expect(repository.complete(finalizer!.id, 'late-replay-finalizer')).resolves.toBe(true);
  expect((await databaseClient.db.select().from(financialProjectionVersions))[0])
    .toMatchObject({
      classifierVersion: 2, allocationAlgorithmVersion: 2,
      pendingClassifierVersion: null, pendingAllocationAlgorithmVersion: null,
      pendingReplayId: null, pendingScanRunId: null
    });
  expect((await databaseClient.db.select().from(financialScanRuns))[0])
    .toMatchObject({ state: 'completed', safeOutcome: 'completed', completedAt: expect.any(Date) });
  await expect(processFinancialScanJob(dependencies, {
    payload: finalizer!.payload as never,
    correlationId: 'scan-late-evidence-finalize-retry', signal
  })).resolves.toEqual({ status: 'unchanged', runId: null });
});

it('rechecks the child barrier after a finalizer claim races an uncommitted late insert', async () => {
  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as StripeCommerceGateway;
  const dependencies = { database: databaseClient.db, gateway, runtimeMode: 'disabled' as const };
  const signal = new AbortController().signal;
  await processFinancialScanJob(dependencies, {
    payload: { kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2' },
    correlationId: 'scan-raced-late-root', signal
  });
  const [sealed] = await databaseClient.db.select().from(financialScanRuns);
  const projectionLocked = deferred<void>();
  const releaseProjection = deferred<void>();
  const stagedDatabase = {
    transaction: (work: (tx: never) => Promise<unknown>) =>
      databaseClient.db.transaction(async (tx) => {
        let gated = false;
        const proxy = new Proxy(tx, {
          get(target, property) {
            if (property === 'execute') {
              return async (query: unknown) => {
                const result = await tx.execute(query as never);
                if (!gated && renderedQuery(query).includes('from financial_projection_versions')) {
                  gated = true;
                  projectionLocked.resolve();
                  await releaseProjection.promise;
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
        return work(proxy as never);
      })
  } as unknown as Database;
  const suffix = randomUUID().replaceAll('-', '');
  const staging = stageBalanceTransaction(stagedDatabase, {
    id: `txn_raced_late_${suffix}`, livemode: false,
    sourceFamily: 'adjustment', sourceId: null, rawType: 'adjustment',
    reportingCategory: 'other_adjustment', balanceType: 'adjustment',
    amountMinor: 25, feeMinor: 0, netMinor: 25, currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T21:00:00.000Z'),
    availableAt: new Date('2026-08-12T21:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
  }, { correlationId: 'scan-raced-late-stage' }, {
    classifierVersion: 2, allocationAlgorithmVersion: 2
  });
  await projectionLocked.promise;

  const repository = createPostgresJobRepository(
    databaseClient.db, applicationConfig.jobs, () => new Date('2100-01-01T00:00:00.000Z'),
    'local-only', { classifierVersion: 2, allocationAlgorithmVersion: 2 }
  );
  const finalizer = await repository.claimNext('raced-late-finalizer');
  expect(finalizer?.payload).toMatchObject({
    phase: 'classification_replay_finalize', scanRunId: sealed!.id
  });
  const finalization = processFinancialScanJob(dependencies, {
    payload: finalizer!.payload as never,
    correlationId: 'scan-raced-late-finalize', signal
  });
  await expect(waitForBlockedProjectionFinalizer()).resolves.toEqual(
    expect.arrayContaining([expect.any(Number)])
  );
  releaseProjection.resolve();
  await expect(staging).resolves.toMatchObject({ disposition: 'inserted' });
  await expect(finalization).rejects.toMatchObject({
    name: 'RetryableFinancialError', safeCode: 'state_changed'
  });
  expect((await databaseClient.db.select().from(jobs).where(eq(jobs.id, finalizer!.id)))[0])
    .toMatchObject({
      status: 'running', attempts: 1, rerunRequestedAt: expect.any(Date)
    });
  await expect(repository.fail(
    finalizer!.id, 'raced-late-finalizer', 'Transient job handler failure', true
  )).resolves.toBe(true);
  expect((await databaseClient.db.select().from(jobs).where(eq(jobs.id, finalizer!.id)))[0])
    .toMatchObject({
      status: 'pending', attempts: 0, rerunRequestedAt: null, completedAt: null
    });
  await expect(repository.claimNext('raced-late-finalizer-retry')).resolves.toMatchObject({
    type: 'commerce.financial-classification',
    payload: expect.objectContaining({ scanRunId: sealed!.id })
  });
  expect((await databaseClient.db.select().from(financialProjectionVersions))[0])
    .toMatchObject({
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      pendingClassifierVersion: 2, pendingAllocationAlgorithmVersion: 2,
      pendingScanRunId: sealed!.id
    });
  expect((await databaseClient.db.select().from(financialScanRuns))[0])
    .toMatchObject({ state: 'running', phase: 'classification_replay_finalize' });
}, 15_000);

it('serializes route publication with finalization before discovering and rearming subjects', async () => {
  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as StripeCommerceGateway;
  const dependencies = { database: databaseClient.db, gateway, runtimeMode: 'disabled' as const };
  const signal = new AbortController().signal;
  const suffix = randomUUID().replaceAll('-', '');
  const providerChargeId = `ch_route_enrollment_${suffix}`;
  const staged = await stageBalanceTransaction(databaseClient.db, {
    id: `txn_route_enrollment_${suffix}`, livemode: false,
    sourceFamily: 'charge', sourceId: providerChargeId, rawType: 'charge',
    reportingCategory: 'charge', balanceType: 'payments', amountMinor: 100,
    feeMinor: 0, netMinor: 100, currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T21:00:00.000Z'),
    availableAt: new Date('2026-08-12T21:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
  }, { correlationId: `route-enrollment-stage-${suffix}` });
  await processFinancialScanJob(dependencies, {
    payload: { kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2' },
    correlationId: `route-enrollment-root-${suffix}`, signal
  });
  const [sealed] = await databaseClient.db.select().from(financialScanRuns);
  await databaseClient.db.update(jobs).set({
    status: 'succeeded', attempts: 1, completedAt: new Date()
  }).where(eq(jobs.type, 'commerce.financial-classification'));

  const [order] = await ownerDatabaseClient.db.insert(orders).values({
    status: 'checkout_open', currency: 'USD', subtotalMinor: 100,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'a'.repeat(64),
    statusTokenSha256: 'b'.repeat(64)
  }).returning();
  const beforeAuthorityRead = deferred<void>();
  const releasePublisher = deferred<void>();
  const publisher = databaseClient.db.transaction(async (tx) => {
    const [payment] = await tx.insert(payments).values({
      orderId: order!.id, stripePaymentIntentId: `pi_route_enrollment_${suffix}`,
      stripeLatestChargeId: providerChargeId, status: 'succeeded', amountMinor: 100,
      currency: 'USD', paymentMethodCategory: 'card', paidAt: new Date()
    }).returning();
    let gated = false;
    const proxy = new Proxy(tx, {
      get(target, property) {
        if (property === 'execute') {
          return async (query: unknown) => {
            if (!gated && renderedQuery(query).includes('from financial_projection_versions')) {
              gated = true;
              beforeAuthorityRead.resolve();
              await releasePublisher.promise;
            }
            return tx.execute(query as never);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    await rearmCurrentProjectionSubjectsForFinancialSource(proxy as DatabaseTransaction, {
      sourceKind: 'payment', sourceId: payment!.id
    });
  });
  await beforeAuthorityRead.promise;

  const repository = createPostgresJobRepository(
    databaseClient.db, applicationConfig.jobs, () => new Date('2100-01-01T00:00:00.000Z'),
    'local-only', { classifierVersion: 2, allocationAlgorithmVersion: 2 }
  );
  const finalizer = await repository.claimNext('route-enrollment-finalizer');
  expect(finalizer?.payload).toMatchObject({
    phase: 'classification_replay_finalize', scanRunId: sealed!.id
  });
  const finalization = processFinancialScanJob(dependencies, {
    payload: finalizer!.payload as never,
    correlationId: `route-enrollment-finalize-${suffix}`, signal
  });
  const blockers = await blockedReplayEnrollmentPids();
  releasePublisher.resolve();
  await expect(publisher).resolves.toBeUndefined();
  const finalOutcome = await finalization.then(
    (value) => ({ status: 'resolved' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error })
  );

  expect(blockers).toEqual(expect.arrayContaining([expect.any(Number)]));
  expect(finalOutcome).toMatchObject({
    status: 'rejected',
    error: { name: 'RetryableFinancialError', safeCode: 'state_changed' }
  });
  expect((await databaseClient.db.select().from(financialProjectionVersions))[0])
    .toMatchObject({
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      pendingClassifierVersion: 2, pendingAllocationAlgorithmVersion: 2,
      pendingScanRunId: sealed!.id
    });
  expect((await databaseClient.db.select().from(jobs).where(eq(
    jobs.type, 'commerce.financial-classification'
  ))).some((job) => job.payload.subjectId === staged.balanceTransactionId &&
    job.payload.scanRunId === sealed!.id && job.status === 'pending')).toBe(true);
}, 15_000);

it('refreshes the retry budget when material route evidence rearms pending work', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const providerChargeId = `ch_retry_budget_${suffix}`;
  const staged = await stageBalanceTransaction(databaseClient.db, {
    id: `txn_retry_budget_${suffix}`, livemode: false,
    sourceFamily: 'charge', sourceId: providerChargeId, rawType: 'charge',
    reportingCategory: 'charge', balanceType: 'payments', amountMinor: 100,
    feeMinor: 0, netMinor: 100, currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T21:00:00.000Z'),
    availableAt: new Date('2026-08-12T21:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
  }, { correlationId: `retry-budget-stage-${suffix}` });
  const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
    eq(stripeBalanceTransactions.id, staged.balanceTransactionId)
  );
  const subject = createFinancialClassificationSubjectJob({
    subjectType: 'balance_transaction', subjectId: staged.balanceTransactionId,
    sourceFingerprintSha256: balance!.fingerprintSha256,
    classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
    allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
  });
  const [insertedSubject] = await ownerDatabaseClient.db.insert(jobs).values({
    type: subject.type, payload: subject.payload as JsonObject,
    deduplicationKey: subject.deduplicationKey, maxAttempts: subject.maxAttempts,
    status: 'pending', attempts: subject.maxAttempts - 1,
    lastError: 'transient failure before route publication',
    runAt: new Date('2100-01-01T00:00:00.000Z')
  }).returning();
  const [order] = await ownerDatabaseClient.db.insert(orders).values({
    status: 'checkout_open', currency: 'USD', subtotalMinor: 100,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'a'.repeat(64),
    statusTokenSha256: 'b'.repeat(64)
  }).returning();
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId: order!.id, stripePaymentIntentId: `pi_retry_budget_${suffix}`,
    stripeLatestChargeId: providerChargeId, status: 'succeeded', amountMinor: 100,
    currency: 'USD', paymentMethodCategory: 'card', paidAt: new Date()
  }).returning();

  await databaseClient.db.transaction((tx) =>
    rearmCurrentProjectionSubjectsForFinancialSource(tx, {
      sourceKind: 'payment', sourceId: payment!.id
    })
  );
  expect((await databaseClient.db.select().from(jobs).where(eq(jobs.id, insertedSubject!.id)))[0])
    .toMatchObject({ status: 'pending', attempts: 0, lastError: null });

  const repository = createPostgresJobRepository(
    databaseClient.db, applicationConfig.jobs, () => new Date('2100-01-01T00:00:00.000Z'),
    'local-only', { classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION }
  );
  const claimed = await repository.claimNext('retry-budget-worker');
  expect(claimed).toMatchObject({ id: insertedSubject!.id, attempts: 1 });
  await expect(repository.fail(
    claimed!.id, 'retry-budget-worker', 'one new transient failure', true
  )).resolves.toBe(true);
  expect((await databaseClient.db.select().from(jobs).where(eq(jobs.id, insertedSubject!.id)))[0])
    .toMatchObject({ status: 'pending', attempts: 1, lastError: 'one new transient failure' });
  expect(staged.balanceTransactionId).toBe(subject.payload.subjectId);
});

it('rejects a linked child with a null target field before activation', async () => {
  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as StripeCommerceGateway;
  const dependencies = { database: databaseClient.db, gateway, runtimeMode: 'disabled' as const };
  const signal = new AbortController().signal;
  await processFinancialScanJob(dependencies, {
    payload: { kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2' },
    correlationId: 'scan-null-child-root', signal
  });
  const [sealed] = await databaseClient.db.select().from(financialScanRuns);
  await ownerDatabaseClient.db.insert(jobs).values({
    type: 'commerce.financial-classification',
    payload: {
      subjectType: 'balance_transaction', subjectId: randomUUID(),
      sourceFingerprintSha256: 'a'.repeat(64), classifierVersion: null,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2', scanRunId: sealed!.id
    },
    deduplicationKey: `malformed-linked-child:${randomUUID()}`,
    status: 'succeeded', attempts: 1, maxAttempts: 5, completedAt: new Date()
  });
  const repository = createPostgresJobRepository(
    databaseClient.db, applicationConfig.jobs, () => new Date('2100-01-01T00:00:00.000Z'),
    'local-only', { classifierVersion: 2, allocationAlgorithmVersion: 2 }
  );
  const finalizer = await repository.claimNext('null-child-finalizer');

  await expect(processFinancialScanJob(dependencies, {
    payload: finalizer!.payload as never,
    correlationId: 'scan-null-child-finalize', signal
  })).rejects.toMatchObject({
    name: 'RetryableFinancialError', safeCode: 'state_changed'
  });
  expect((await databaseClient.db.select().from(financialProjectionVersions))[0])
    .toMatchObject({
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      pendingClassifierVersion: 2, pendingAllocationAlgorithmVersion: 2,
      pendingScanRunId: sealed!.id
    });
});

it('adopts an existing permanent subject job into its replay-run barrier', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  await stageBalanceTransaction(databaseClient.db, {
    id: `txn_replay_adopt_${suffix}`, livemode: false,
    sourceFamily: 'adjustment', sourceId: null, rawType: 'adjustment',
    reportingCategory: 'other_adjustment', balanceType: 'adjustment',
    amountMinor: 25, feeMinor: 0, netMinor: 25, currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T21:00:00.000Z'),
    availableAt: new Date('2026-08-12T21:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
  }, { correlationId: 'scan-adopt-stage' });
  const [ordinary] = await databaseClient.db.select().from(jobs).where(
    eq(jobs.type, 'commerce.financial-classification')
  );
  expect(ordinary?.payload.scanRunId).toBeUndefined();
  await databaseClient.db.update(jobs).set({
    status: 'succeeded', completedAt: new Date()
  }).where(eq(jobs.id, ordinary!.id));

  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as StripeCommerceGateway;
  await processFinancialScanJob({
    database: databaseClient.db, gateway, runtimeMode: 'disabled'
  }, {
    payload: { kind: 'composite_replay', classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      replayId: FINANCIAL_REPLAY_ID },
    correlationId: 'scan-adopt-root', signal: new AbortController().signal
  });
  const [sealed] = await databaseClient.db.select().from(financialScanRuns);
  const [adopted] = await databaseClient.db.select().from(jobs).where(
    eq(jobs.id, ordinary!.id)
  );
  expect(adopted).toMatchObject({
    id: ordinary!.id, status: 'succeeded',
    payload: expect.objectContaining({ scanRunId: sealed!.id })
  });
});

it('adopts an exhausted permanent subject without resurrecting it', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  await stageBalanceTransaction(databaseClient.db, {
    id: `txn_replay_failed_adopt_${suffix}`, livemode: false,
    sourceFamily: 'adjustment', sourceId: null, rawType: 'adjustment',
    reportingCategory: 'other_adjustment', balanceType: 'adjustment',
    amountMinor: 25, feeMinor: 0, netMinor: 25, currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T21:00:00.000Z'),
    availableAt: new Date('2026-08-12T21:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
  }, { correlationId: 'scan-failed-adopt-stage' });
  const [ordinary] = await databaseClient.db.select().from(jobs).where(
    eq(jobs.type, 'commerce.financial-classification')
  );
  await databaseClient.db.update(jobs).set({
    status: 'failed', attempts: ordinary!.maxAttempts,
    completedAt: new Date('2026-08-12T21:30:00.000Z'),
    lastError: 'permanent classification failure'
  }).where(eq(jobs.id, ordinary!.id));

  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as StripeCommerceGateway;
  await processFinancialScanJob({
    database: databaseClient.db, gateway, runtimeMode: 'disabled'
  }, {
    payload: { kind: 'composite_replay', classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      replayId: FINANCIAL_REPLAY_ID },
    correlationId: 'scan-failed-adopt-root', signal: new AbortController().signal
  });
  const [sealed] = await databaseClient.db.select().from(financialScanRuns);
  const [adopted] = await databaseClient.db.select().from(jobs).where(
    eq(jobs.id, ordinary!.id)
  );
  expect(adopted).toMatchObject({
    id: ordinary!.id, status: 'failed', attempts: ordinary!.maxAttempts,
    lastError: 'permanent classification failure',
    payload: expect.objectContaining({ scanRunId: sealed!.id })
  });
});

it('rearms a running permanent subject job after replay-run adoption', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const staged = await stageBalanceTransaction(databaseClient.db, {
    id: `txn_replay_running_adopt_${suffix}`, livemode: false,
    sourceFamily: 'adjustment', sourceId: null, rawType: 'adjustment',
    reportingCategory: 'other_adjustment', balanceType: 'adjustment',
    amountMinor: 25, feeMinor: 0, netMinor: 25, currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T21:00:00.000Z'),
    availableAt: new Date('2026-08-12T21:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
  }, { correlationId: 'scan-running-adopt-stage' }, {
    classifierVersion: 2, allocationAlgorithmVersion: 2
  });
  const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
    eq(stripeBalanceTransactions.id, staged.balanceTransactionId)
  );
  // Seed immutable c1-a1 history explicitly; the active integration authority remains c1-a2.
  await databaseClient.db.transaction((tx) => replayFinancialClassificationLocked(tx, {
    subjectType: 'balance_transaction', subjectId: staged.balanceTransactionId,
    sourceFingerprintSha256: balance!.fingerprintSha256,
    classifierVersion: 1, allocationAlgorithmVersion: 1, replayId: 'c1-a1',
    correlationId: 'scan-running-adopt-historical-predecessor'
  }));
  const ordinary = createFinancialClassificationSubjectJob({
    subjectType: 'balance_transaction', subjectId: staged.balanceTransactionId,
    sourceFingerprintSha256: balance!.fingerprintSha256,
    classifierVersion: 2, allocationAlgorithmVersion: 2
  });
  await ownerDatabaseClient.db.insert(jobs).values({
    type: ordinary.type, payload: ordinary.payload as JsonObject,
    deduplicationKey: ordinary.deduplicationKey, maxAttempts: ordinary.maxAttempts
  });
  const repository = createPostgresJobRepository(
    databaseClient.db, applicationConfig.jobs,
    () => new Date('2100-01-01T00:00:00.000Z'), 'all',
    { classifierVersion: 2, allocationAlgorithmVersion: 2 }
  );
  const claimed = await repository.claimNext('running-adopt-worker');
  expect(claimed).toMatchObject({
    type: 'commerce.financial-classification',
    payload: expect.not.objectContaining({ scanRunId: expect.anything() })
  });

  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as StripeCommerceGateway;
  await processFinancialScanJob({
    database: databaseClient.db, gateway, runtimeMode: 'disabled'
  }, {
    payload: { kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2' },
    correlationId: 'scan-running-adopt-root', signal: new AbortController().signal
  });
  const [sealed] = await databaseClient.db.select().from(financialScanRuns);
  const [adopted] = await databaseClient.db.select().from(jobs).where(eq(jobs.id, claimed!.id));
  expect(adopted).toMatchObject({
    id: claimed!.id, status: 'running', attempts: 1,
    rerunRequestedAt: expect.any(Date),
    payload: expect.objectContaining({ scanRunId: sealed!.id })
  });

  const staleHandler = createFinancialClassificationHandler({
    database: databaseClient.db,
    targetClassifierVersion: 2, targetAllocationAlgorithmVersion: 2
  });
  await expect(staleHandler(claimed!, new AbortController().signal)).resolves.toBeUndefined();
  await expect(repository.complete(claimed!.id, 'running-adopt-worker')).resolves.toBe(true);
  expect((await databaseClient.db.select().from(jobs).where(eq(jobs.id, claimed!.id)))[0])
    .toMatchObject({
      id: claimed!.id, status: 'pending', attempts: 0,
      rerunRequestedAt: null, completedAt: null,
      payload: expect.objectContaining({ scanRunId: sealed!.id })
    });
  await expect(repository.claimNext('running-adopt-retry')).resolves.toMatchObject({
    id: claimed!.id,
    payload: expect.objectContaining({ scanRunId: sealed!.id })
  });
});

it('lets an exact pending target finish before keyset adoption links it', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const staged = await stageBalanceTransaction(databaseClient.db, {
    id: `txn_replay_pending_claim_${suffix}`, livemode: false,
    sourceFamily: 'adjustment', sourceId: null, rawType: 'adjustment',
    reportingCategory: 'other_adjustment', balanceType: 'adjustment',
    amountMinor: 25, feeMinor: 0, netMinor: 25, currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T21:00:00.000Z'),
    availableAt: new Date('2026-08-12T21:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
  }, { correlationId: 'scan-pending-claim-stage' }, {
    classifierVersion: 2, allocationAlgorithmVersion: 2
  });
  const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
    eq(stripeBalanceTransactions.id, staged.balanceTransactionId)
  );
  // Seed immutable c1-a1 history explicitly; the active integration authority remains c1-a2.
  await databaseClient.db.transaction((tx) => replayFinancialClassificationLocked(tx, {
    subjectType: 'balance_transaction', subjectId: staged.balanceTransactionId,
    sourceFingerprintSha256: balance!.fingerprintSha256,
    classifierVersion: 1, allocationAlgorithmVersion: 1, replayId: 'c1-a1',
    correlationId: 'scan-pending-claim-historical-predecessor'
  }));
  const ordinary = createFinancialClassificationSubjectJob({
    subjectType: 'balance_transaction', subjectId: staged.balanceTransactionId,
    sourceFingerprintSha256: balance!.fingerprintSha256,
    classifierVersion: 2, allocationAlgorithmVersion: 2
  });
  await ownerDatabaseClient.db.insert(jobs).values({
    type: ordinary.type, payload: ordinary.payload as JsonObject,
    deduplicationKey: ordinary.deduplicationKey, maxAttempts: ordinary.maxAttempts
  });
  const rootPayload = {
    kind: 'composite_replay' as const, classifierVersion: 2,
    allocationAlgorithmVersion: 2, replayId: 'c2-a2'
  };
  const run = await startOrResumeFinancialScan(databaseClient.db, rootPayload);
  const repository = createPostgresJobRepository(
    databaseClient.db, applicationConfig.jobs,
    () => new Date('2100-01-01T00:00:00.000Z'), 'all',
    { classifierVersion: 2, allocationAlgorithmVersion: 2 }
  );
  const claimed = await repository.claimNext('pending-before-adopt-worker');
  expect(claimed).toMatchObject({ id: expect.any(String), payload: ordinary.payload });
  const handler = createFinancialClassificationHandler({
    database: databaseClient.db,
    targetClassifierVersion: 2, targetAllocationAlgorithmVersion: 2
  });
  await expect(handler(claimed!, new AbortController().signal)).resolves.toBeUndefined();
  await expect(repository.complete(claimed!.id, 'pending-before-adopt-worker')).resolves.toBe(true);

  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as StripeCommerceGateway;
  await processFinancialScanJob({
    database: databaseClient.db, gateway, runtimeMode: 'disabled'
  }, {
    payload: rootPayload, correlationId: 'scan-pending-claim-root',
    signal: new AbortController().signal
  });
  expect((await databaseClient.db.select().from(jobs).where(eq(jobs.id, claimed!.id)))[0])
    .toMatchObject({
      id: claimed!.id, status: 'succeeded',
      payload: expect.objectContaining({ scanRunId: run.id })
    });
});

it('lets an active-version worker enroll new evidence into a newer pending replay', async () => {
  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as StripeCommerceGateway;
  await processFinancialScanJob({
    database: databaseClient.db, gateway, runtimeMode: 'disabled'
  }, {
    payload: { kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2' },
    correlationId: 'scan-active-worker-enrollment-root',
    signal: new AbortController().signal
  });
  const [run] = await databaseClient.db.select().from(financialScanRuns);
  const suffix = randomUUID().replaceAll('-', '');
  const staged = await stageBalanceTransaction(databaseClient.db, {
    id: `txn_replay_active_worker_${suffix}`, livemode: false,
    sourceFamily: 'adjustment', sourceId: null, rawType: 'adjustment',
    reportingCategory: 'other_adjustment', balanceType: 'adjustment',
    amountMinor: 25, feeMinor: 0, netMinor: 25, currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T21:00:00.000Z'),
    availableAt: new Date('2026-08-12T21:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null,
    feeDetails: []
  }, { correlationId: 'scan-active-worker-enrollment-stage' });
  const linked = (await databaseClient.db.select().from(jobs)).filter((job) =>
    job.type === 'commerce.financial-classification' &&
    job.payload.subjectId === staged.balanceTransactionId &&
    job.payload.classifierVersion === 2
  );
  expect(linked).toEqual([
    expect.objectContaining({
      status: 'pending',
      payload: expect.objectContaining({ scanRunId: run!.id, replayId: 'c2-a2' })
    })
  ]);
});

it('rediscovers a pending source next hour after its prior generation exhausts', async () => {
  const now = new Date('2026-08-12T21:00:00.000Z');
  const [order] = await ownerDatabaseClient.db.insert(orders).values({
    status: 'checkout_open', currency: 'USD', subtotalMinor: 1000,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'a'.repeat(64),
    statusTokenSha256: 'b'.repeat(64)
  }).returning();
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId: order!.id, stripePaymentIntentId: 'pi_scan_exhausted',
    stripeLatestChargeId: 'ch_scan_exhausted', status: 'succeeded', amountMinor: 1000,
    currency: 'USD', paidAt: now, paymentMethodCategory: 'card',
    financialEvidenceStatus: 'pending'
  }).returning();
  const dependencies = {
    database: databaseClient.db, gateway: {} as StripeCommerceGateway, runtimeMode: 'stripe' as const
  };
  const signal = new AbortController().signal;
  await processFinancialScanJob(dependencies, {
    payload: { kind: 'hourly', scanGenerationHour: '2026-08-12T21:00:00.000Z' },
    correlationId: 'scan-exhausted-first-hour', signal
  });
  const firstKey = `financial:source:scan:payment:${payment!.id}:2026-08-12T21:00:00.000Z`;
  const [firstJob] = await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey, firstKey)
  );
  await databaseClient.db.update(jobs).set({
    status: 'failed', attempts: firstJob!.maxAttempts, completedAt: now,
    lastError: 'Transient job handler failure'
  }).where(eq(jobs.id, firstJob!.id));

  await processFinancialScanJob(dependencies, {
    payload: { kind: 'hourly', scanGenerationHour: '2026-08-12T22:00:00.000Z' },
    correlationId: 'scan-exhausted-next-hour', signal
  });
  const secondKey = `financial:source:scan:payment:${payment!.id}:2026-08-12T22:00:00.000Z`;
  const rediscovered = await databaseClient.db.select().from(jobs).where(
    inArray(jobs.deduplicationKey, [firstKey, secondKey])
  );
  expect(rediscovered).toEqual(expect.arrayContaining([
    expect.objectContaining({ deduplicationKey: firstKey, status: 'failed' }),
    expect.objectContaining({ deduplicationKey: secondKey, status: 'pending', attempts: 0 })
  ]));
  expect(rediscovered).toHaveLength(2);
});
