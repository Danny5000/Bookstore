import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import {
  createFinancialScheduleEnsurer,
  ensureHourlyFinancialScan
} from '$lib/server/commerce/financial/scans/scheduler';
import { processFinancialScanJob } from '$lib/server/commerce/financial/scans/service';
import {
  loadFinancialSourceScanPage,
  loadIncompletePayoutRunPage
} from '$lib/server/commerce/financial/scans/repository';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { FinancialScanRunRow } from '$lib/server/db/schema';
import {
  financialReconciliationIssues, financialScanRuns, jobs, orders, payments,
  payoutImportRuns, stripeBalanceTransactions, stripePayouts
} from '$lib/server/db/schema';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { runWorker } from '$lib/server/jobs/runner';
import { applicationConfig, databaseClient } from './database';

it('converges concurrent workers on permanent roots and creates one new hour', async () => {
  const now = new Date('2026-08-12T19:42:00.000Z');
  await Promise.all([
    ensureHourlyFinancialScan(databaseClient.db, {
      now, classifierVersion: 1, allocationAlgorithmVersion: 1
    }),
    ensureHourlyFinancialScan(databaseClient.db, {
      now, classifierVersion: 1, allocationAlgorithmVersion: 1
    })
  ]);
  const firstKeys = [
    'commerce.financial-scan:initial:v1',
    'commerce.financial-scan:2026-08-12T19:00:00.000Z',
    'commerce.financial-classification:scan:1:1'
  ];
  expect(await databaseClient.db.select().from(jobs).where(
    inArray(jobs.deduplicationKey, firstKeys)
  )).toHaveLength(3);

  await ensureHourlyFinancialScan(databaseClient.db, {
    now: new Date('2026-08-12T20:00:00.000Z'),
    classifierVersion: 1,
    allocationAlgorithmVersion: 2
  });
  expect(await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey, 'commerce.financial-scan:2026-08-12T20:00:00.000Z')
  )).toHaveLength(1);
  expect(await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey, 'commerce.financial-classification:scan:1:2')
  )).toHaveLength(1);
});

it('converges two real worker polling loops without retaining a database lease', async () => {
  const now = new Date('2026-08-12T19:42:00.000Z');
  const runOnePoll = async (workerId: string): Promise<void> => {
    const controller = new AbortController();
    const ensure = createFinancialScheduleEnsurer({
      database: databaseClient.db, runtimeMode: 'stripe', classifierVersion: 1,
      allocationAlgorithmVersion: 1
    });
    await runWorker({
      repository: createPostgresJobRepository(databaseClient.db, applicationConfig.jobs),
      handlers: new Map(), workerId, concurrency: 1,
      pollIntervalMs: applicationConfig.jobs.pollIntervalMs,
      heartbeatIntervalMs: Math.max(1, Math.floor(applicationConfig.jobs.leaseMs / 3)),
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
    'commerce.financial-classification:scan:1:1'
  ];
  expect(await databaseClient.db.select().from(jobs).where(
    inArray(jobs.deduplicationKey, keys)
  )).toHaveLength(3);
  await expect(databaseClient.db.execute(sql`select 1 as healthy`)).resolves.toBeDefined();
});

it('commits a bounded source page and its continuation atomically', async () => {
  const suffix = randomUUID();
  const [order] = await databaseClient.db.insert(orders).values({
    status: 'checkout_open', currency: 'USD', subtotalMinor: 1000,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'a'.repeat(64),
    statusTokenSha256: 'b'.repeat(64)
  }).returning();
  const [payment] = await databaseClient.db.insert(payments).values({
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
  await databaseClient.db.insert(orders).values(orderIds.map((id, index) => ({
    id, status: 'checkout_open' as const, currency: 'USD', subtotalMinor: 1000,
    clientCheckoutAttemptId: `00000000-0000-4000-8000-0000000005${String(index + 1).padStart(2, '0')}`,
    quoteFingerprintSha256: 'a'.repeat(64), statusTokenSha256: 'b'.repeat(64)
  })));
  await databaseClient.db.insert(payments).values(paymentIds.map((id, index) => ({
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
    allocationAlgorithmVersion: null, replayId: null, checkpoint: null,
    cursorDigestSha256: null, processedCount: 0, enqueuedCount: 0, pageCount: 0,
    safeOutcome: null, startedAt: now, updatedAt: now, completedAt: null
  };

  const page = await loadFinancialSourceScanPage(databaseClient.db, run, 100);
  expect(page.data).toEqual(paymentIds.slice(0, 3).map((sourceId) => ({
    sourceKind: 'payment', sourceId
  })));
  expect(page.hasMore).toBe(false);
});

it('completes a disabled composite replay across multiple durable pages without provider access', async () => {
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
    payload: { kind: 'composite_replay', classifierVersion: 1,
      allocationAlgorithmVersion: 1, replayId: 'c1-a1' },
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
  })).resolves.toEqual({ status: 'completed', runId: afterFirstPage!.id });

  const [completed] = await databaseClient.db.select().from(financialScanRuns);
  expect(completed).toMatchObject({
    state: 'completed', processedCount: 101, enqueuedCount: 101, pageCount: 2,
    checkpoint: null, cursorDigestSha256: null, safeOutcome: 'completed'
  });
  expect(await databaseClient.db.select().from(jobs).where(
    eq(jobs.type, 'commerce.financial-classification')
  )).toHaveLength(101);
});

it('rediscovers a pending source next hour after its prior generation exhausts', async () => {
  const now = new Date('2026-08-12T21:00:00.000Z');
  const [order] = await databaseClient.db.insert(orders).values({
    status: 'checkout_open', currency: 'USD', subtotalMinor: 1000,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'a'.repeat(64),
    statusTokenSha256: 'b'.repeat(64)
  }).returning();
  const [payment] = await databaseClient.db.insert(payments).values({
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
