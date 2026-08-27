import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createFinancialSourceHandler } from '$lib/server/commerce/financial/handlers/source';
import { createFinancialScanHandler } from '$lib/server/commerce/financial/handlers/scan';
import { createFinancialPayoutHandler } from '$lib/server/commerce/financial/handlers/payout';
import {
  createFinancialHourlyScanJob,
  createFinancialPayoutEventJob,
  createFinancialSourceEventJob,
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_SCAN_JOB,
  FINANCIAL_SOURCE_JOB
} from '$lib/server/commerce/financial/jobs';
import { createFixtureStripeGateway } from '$lib/server/commerce/stripe/fixture-gateway';
import type { Database } from '$lib/server/db/client';
import {
  auditEvents,
  guestIdentities,
  financialScanRuns,
  jobs,
  orderItems,
  orders,
  payments,
  payoutImportRunEntries,
  payoutImportRuns,
  stripeBalanceTransactions,
  stripePayoutBalanceTransactions,
  stripePayouts,
  titles,
  type JsonObject
} from '$lib/server/db/schema';
import {
  createPostgresJobRepository,
  enqueueActiveEntityJob,
  enqueueJob
} from '$lib/server/jobs/repository';
import { runWorker } from '$lib/server/jobs/runner';
import type { JobHandler, JobRepository } from '$lib/server/jobs/types';
import { balanceTransactionSnapshotFixture } from '../fixtures/stripe/balance-transaction';
import { chargeSnapshotFixture } from '../fixtures/stripe/charge';
import { paymentSnapshotFixture } from '../fixtures/stripe/payment';
import { payoutSnapshotFixture } from '../fixtures/stripe/payout';
import {
  applicationConfig,
  ownerDatabaseClient,
  workerDatabaseClient as databaseClient
} from './database';

const STARTED_AT = new Date('2098-08-13T12:00:00.000Z');
const RETRY_AT = new Date('2099-08-13T13:00:00.000Z');
const WORKER_DISCONNECT = 'simulated worker connection loss after durable checkpoint';

async function createPaymentFixture() {
  const suffix = randomUUID().replaceAll('-', '');
  const orderId = randomUUID();
  const titleId = randomUUID();
  const [guest] = await ownerDatabaseClient.db.insert(guestIdentities).values({
    email: `financial-recovery-${suffix}@example.com`
  }).returning();
  if (!guest) throw new Error('Expected recovery guest fixture.');
  await ownerDatabaseClient.db.insert(titles).values({
    id: titleId,
    slug: `financial-recovery-${suffix}`,
    title: 'Financial recovery fixture',
    description: 'Financial recovery fixture',
    creatorName: 'Fixture creator',
    format: 'prose',
    priceMinor: 1_000,
    currency: 'USD',
    visibility: 'private'
  });
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    guestIdentityId: guest.id,
    purchaseEmail: guest.email,
    currency: 'USD',
    subtotalMinor: 1_000,
    taxMinor: 0,
    totalMinor: 1_000,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: `cs_recovery_${suffix}`,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-13T12:30:00.000Z'),
    paidAt: STARTED_AT
  });
  await ownerDatabaseClient.db.insert(orderItems).values({
    orderId,
    titleId,
    titleSnapshot: 'Financial recovery fixture',
    creatorNameSnapshot: 'Fixture creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 1_000,
    taxMinor: 0,
    totalMinor: 1_000,
    stripeLineItemId: `li_recovery_${suffix}`
  });
  const paymentIntentId = `pi_recovery_${suffix}`;
  const chargeId = `ch_recovery_${suffix}`;
  const balanceTransactionId = `txn_recovery_${suffix}`;
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: paymentIntentId,
    stripeLatestChargeId: chargeId,
    status: 'succeeded',
    amountMinor: 1_000,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt: STARTED_AT
  }).returning();
  if (!payment) throw new Error('Expected recovery payment fixture.');
  const stripe = createFixtureStripeGateway();
  stripe.harness.setPayment(paymentSnapshotFixture({
    paymentIntentId,
    metadataOrderId: orderId,
    latestChargeId: chargeId,
    amountMinor: 1_000,
    currency: 'usd',
    paidAt: STARTED_AT
  }));
  stripe.harness.setCharge(chargeSnapshotFixture({
    id: chargeId,
    paymentIntentId,
    amountMinor: 1_000,
    currency: 'USD',
    balanceTransactionId,
    createdAt: STARTED_AT
  }));
  stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
    id: balanceTransactionId,
    sourceId: chargeId,
    amountMinor: 1_000,
    feeMinor: 50,
    netMinor: 950,
    currency: 'USD',
    createdAt: STARTED_AT,
    feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 50, currency: 'USD' }]
  }));
  return { payment, balanceTransactionId, stripe };
}

async function enqueueSourceJob(paymentId: string): Promise<string> {
  const spec = createFinancialSourceEventJob({
    sourceKind: 'payment',
    sourceId: paymentId,
    providerEventId: `evt_recovery_${randomUUID().replaceAll('-', '')}`
  });
  const queued = await databaseClient.db.transaction((transaction) => enqueueActiveEntityJob(
    transaction,
    {
      type: spec.type,
      payload: spec.payload as JsonObject,
      deduplicationKey: spec.deduplicationKey,
      maxAttempts: spec.maxAttempts,
      activeEntity: { sourceKind: 'payment', sourceId: paymentId }
    }
  ));
  return queued.id;
}

async function runWorkerUntilHandlerReturns(input: {
  repository: JobRepository;
  handler: JobHandler;
  type: string;
  workerId: string;
}): Promise<void> {
  const controller = new AbortController();
  const handler: JobHandler = async (job, signal) => {
    try {
      await input.handler(job, signal);
    } finally {
      controller.abort();
    }
  };
  await runWorker({
    repository: input.repository,
    handlers: new Map([[input.type, handler]]),
    workerId: input.workerId,
    concurrency: 1,
    pollIntervalMs: 1,
    leaseRenewalIntervalMs: Math.max(1, Math.floor(applicationConfig.jobs.leaseMs / 3)),
    signal: controller.signal,
    sleep: async () => controller.abort()
  });
}

async function enqueuePayoutJob(providerPayoutId: string): Promise<string> {
  const spec = createFinancialPayoutEventJob({
    providerPayoutId,
    providerEventId: `evt_recovery_${randomUUID().replaceAll('-', '')}`
  });
  const queued = await databaseClient.db.transaction((transaction) => enqueueActiveEntityJob(
    transaction,
    {
      type: spec.type,
      payload: spec.payload as JsonObject,
      deduplicationKey: spec.deduplicationKey,
      maxAttempts: spec.maxAttempts,
      activeEntity: { providerPayoutId }
    }
  ));
  return queued.id;
}

function createPayoutFixture(balanceCount: number) {
  const suffix = randomUUID().replaceAll('-', '');
  const providerPayoutId = `po_recovery_${suffix}`;
  const stripe = createFixtureStripeGateway();
  stripe.harness.setPayout(payoutSnapshotFixture({
    id: providerPayoutId,
    balanceTransactionId: null
  }));
  const balances = Array.from({ length: balanceCount }, (_, index) =>
    balanceTransactionSnapshotFixture({
      id: `txn_recovery_${String(index).padStart(3, '0')}_${suffix}`,
      sourceId: null,
      sourceFamily: 'unknown',
      rawType: 'adjustment',
      reportingCategory: 'other_adjustment',
      amountMinor: 100,
      feeMinor: 0,
      netMinor: 100,
      feeDetails: []
    }));
  stripe.harness.setBalanceTransactionsForPayout(providerPayoutId, balances);
  return { providerPayoutId, balances, stripe };
}

async function runWorkerUntilIdle(input: {
  repository: JobRepository;
  handlers: ReadonlyMap<string, JobHandler>;
  workerId: string;
}): Promise<void> {
  const controller = new AbortController();
  await runWorker({
    repository: input.repository,
    handlers: input.handlers,
    workerId: input.workerId,
    concurrency: 1,
    pollIntervalMs: 1,
    leaseRenewalIntervalMs: Math.max(1, Math.floor(applicationConfig.jobs.leaseMs / 3)),
    signal: controller.signal,
    sleep: async () => controller.abort()
  });
}

function crashAfterSuccessfulHandler(handler: JobHandler): JobHandler {
  return async (job, signal) => {
    await handler(job, signal);
    throw new Error('simulated process crash after durable financial checkpoint');
  };
}

function disconnectTerminalWrites(repository: JobRepository): JobRepository {
  const disconnected = async (): Promise<never> => {
    throw new Error(WORKER_DISCONNECT);
  };
  return {
    claimNext: (workerId) => repository.claimNext(workerId),
    renewLease: (jobId, workerId) => repository.renewLease(jobId, workerId),
    complete: disconnected,
    fail: disconnected,
    failWithDisposition: disconnected,
    renewOperationsJobLease: (authority) => repository.renewOperationsJobLease(authority),
    completeOperationsJob: disconnected,
    failOperationsJob: disconnected
  };
}

function crashAfterFirstTransaction(database: Database, controller: AbortController): Database {
  let transactionCount = 0;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (...argumentsToTransaction: Parameters<Database['transaction']>) => {
        const result = await target.transaction(...argumentsToTransaction);
        transactionCount += 1;
        if (transactionCount === 1) controller.abort();
        return result;
      };
    }
  });
}

it('restarts a real source job after crashing immediately after provider staging', async () => {
  const fixture = await createPaymentFixture();
  const jobId = await enqueueSourceJob(fixture.payment.id);
  const crashController = new AbortController();
  const firstRepository = createPostgresJobRepository(
    databaseClient.db,
    applicationConfig.jobs,
    () => STARTED_AT
  );
  await expect(runWorker({
    repository: disconnectTerminalWrites(firstRepository),
    handlers: new Map([[FINANCIAL_SOURCE_JOB, createFinancialSourceHandler({
      database: crashAfterFirstTransaction(databaseClient.db, crashController),
      gateway: fixture.stripe.gateway
    })]]),
    workerId: 'financial-recovery-source-crash',
    concurrency: 1,
    pollIntervalMs: 1,
    leaseRenewalIntervalMs: Math.max(1, Math.floor(applicationConfig.jobs.leaseMs / 3)),
    signal: crashController.signal
  })).rejects.toThrow(WORKER_DISCONNECT);

  expect(await databaseClient.db.select().from(stripeBalanceTransactions).where(
    eq(stripeBalanceTransactions.providerId, fixture.balanceTransactionId)
  )).toHaveLength(1);
  expect(await databaseClient.db.select().from(jobs).where(eq(jobs.id, jobId)))
    .toEqual([expect.objectContaining({
      status: 'running',
      attempts: 1,
      lockedBy: 'financial-recovery-source-crash',
      lockedAt: STARTED_AT
    })]);

  await runWorkerUntilHandlerReturns({
    repository: createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => RETRY_AT
    ),
    handler: createFinancialSourceHandler({
      database: databaseClient.db,
      gateway: fixture.stripe.gateway
    }),
    type: FINANCIAL_SOURCE_JOB,
    workerId: 'financial-recovery-source-restart'
  });

  expect(await databaseClient.db.select().from(stripeBalanceTransactions).where(
    eq(stripeBalanceTransactions.providerId, fixture.balanceTransactionId)
  )).toHaveLength(1);
  expect(await databaseClient.db.select().from(payments).where(eq(payments.id, fixture.payment.id)))
    .toEqual([expect.objectContaining({ financialEvidenceStatus: 'fee_reconciled' })]);
  expect(await databaseClient.db.select().from(jobs).where(eq(jobs.id, jobId)))
    .toEqual([expect.objectContaining({ status: 'succeeded', attempts: 2 })]);
});

it('retries a real scan job after its page and continuation commit, then converges without duplicates', async () => {
  const stripe = createFixtureStripeGateway();
  stripe.harness.setPayouts([]);
  const spec = createFinancialHourlyScanJob({
    scanGenerationHour: '2026-08-13T12:00:00.000Z'
  });
  const queued = await enqueueJob(databaseClient.db, {
    type: spec.type,
    payload: spec.payload as JsonObject,
    deduplicationKey: spec.deduplicationKey,
    maxAttempts: spec.maxAttempts
  });
  const handler = createFinancialScanHandler({
    database: databaseClient.db,
    gateway: stripe.gateway,
    runtimeMode: 'stripe'
  });

  await expect(runWorkerUntilHandlerReturns({
    repository: disconnectTerminalWrites(createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => STARTED_AT
    )),
    handler: crashAfterSuccessfulHandler(handler),
    type: FINANCIAL_SCAN_JOB,
    workerId: 'financial-recovery-scan-crash'
  })).rejects.toThrow(WORKER_DISCONNECT);

  const [checkpoint] = await databaseClient.db.select().from(financialScanRuns);
  expect(checkpoint).toMatchObject({
    phase: 'payout_discovery_page',
    state: 'running',
    processedCount: 0,
    enqueuedCount: 0,
    pageCount: 1
  });
  expect(await databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id)))
    .toEqual([expect.objectContaining({
      status: 'running',
      attempts: 1,
      lockedBy: 'financial-recovery-scan-crash',
      lockedAt: STARTED_AT
    })]);
  expect(await databaseClient.db.select().from(jobs).where(
    eq(jobs.type, FINANCIAL_SCAN_JOB)
  )).toHaveLength(2);

  await runWorkerUntilIdle({
    repository: createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => RETRY_AT
    ),
    handlers: new Map([[FINANCIAL_SCAN_JOB, handler]]),
    workerId: 'financial-recovery-scan-restart'
  });

  expect(await databaseClient.db.select().from(financialScanRuns))
    .toEqual([expect.objectContaining({
      id: checkpoint!.id,
      phase: 'incomplete_payout_run_page',
      state: 'completed',
      processedCount: 0,
      enqueuedCount: 0,
      pageCount: 3,
      safeOutcome: 'completed'
    })]);
  const scanJobs = await databaseClient.db.select().from(jobs).where(
    eq(jobs.type, FINANCIAL_SCAN_JOB)
  );
  expect(scanJobs).toHaveLength(3);
  expect(new Set(scanJobs.map((job) => job.deduplicationKey)).size).toBe(3);
  expect(scanJobs).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: queued.id, status: 'succeeded', attempts: 2 })
  ]));
});

it('resumes a persisted payout page through its durable continuation and publishes one membership', async () => {
  const fixture = createPayoutFixture(101);
  const eventJobId = await enqueuePayoutJob(fixture.providerPayoutId);
  const handler = createFinancialPayoutHandler({
    database: databaseClient.db,
    gateway: fixture.stripe.gateway
  });

  await expect(runWorkerUntilHandlerReturns({
    repository: disconnectTerminalWrites(createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => STARTED_AT
    )),
    handler: crashAfterSuccessfulHandler(handler),
    type: FINANCIAL_PAYOUT_JOB,
    workerId: 'financial-recovery-payout-page-crash'
  })).rejects.toThrow(WORKER_DISCONNECT);

  const [payout] = await databaseClient.db.select().from(stripePayouts).where(
    eq(stripePayouts.providerId, fixture.providerPayoutId)
  );
  const [checkpoint] = await databaseClient.db.select().from(payoutImportRuns).where(
    eq(payoutImportRuns.payoutId, payout!.id)
  );
  expect(checkpoint).toMatchObject({
    state: 'collecting',
    generation: 0,
    candidateCount: 100,
    pageCount: 1,
    nextStartingAfter: fixture.balances[99]!.id
  });
  expect(await databaseClient.db.select().from(payoutImportRunEntries).where(
    eq(payoutImportRunEntries.runId, checkpoint!.id)
  )).toHaveLength(100);
  expect(await databaseClient.db.select().from(stripeBalanceTransactions)).toHaveLength(100);
  expect(await databaseClient.db.select().from(jobs).where(eq(jobs.id, eventJobId)))
    .toEqual([expect.objectContaining({
      status: 'running',
      attempts: 1,
      lockedBy: 'financial-recovery-payout-page-crash',
      lockedAt: STARTED_AT
    })]);
  const payoutJobsAtCheckpoint = await databaseClient.db.select().from(jobs).where(
    eq(jobs.type, FINANCIAL_PAYOUT_JOB)
  );
  expect(payoutJobsAtCheckpoint).toHaveLength(2);
  const continuation = payoutJobsAtCheckpoint.find((job) => job.id !== eventJobId);
  if (!continuation) throw new Error('Expected payout continuation checkpoint.');
  await databaseClient.db.update(jobs).set({ runAt: new Date('2000-01-01T00:00:00.000Z') })
    .where(eq(jobs.id, continuation.id));

  await runWorkerUntilHandlerReturns({
    repository: createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => RETRY_AT
    ),
    handler,
    type: FINANCIAL_PAYOUT_JOB,
    workerId: 'financial-recovery-payout-continuation'
  });

  expect(await databaseClient.db.select().from(payoutImportRuns).where(
    eq(payoutImportRuns.id, checkpoint!.id)
  )).toEqual([expect.objectContaining({
    state: 'published',
    candidateCount: 101,
    pageCount: 2,
    safeOutcome: 'published'
  })]);
  expect(await databaseClient.db.select().from(payoutImportRunEntries).where(
    eq(payoutImportRunEntries.runId, checkpoint!.id)
  )).toHaveLength(101);
  expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions).where(
    eq(stripePayoutBalanceTransactions.payoutId, payout!.id)
  )).toHaveLength(101);
  expect(await databaseClient.db.select().from(stripeBalanceTransactions)).toHaveLength(101);

  await databaseClient.db.update(jobs).set({ runAt: new Date('2100-01-01T00:00:00.000Z') })
    .where(eq(jobs.type, FINANCIAL_SCAN_JOB));
  await databaseClient.db.update(jobs).set({ runAt: new Date('2001-01-01T00:00:00.000Z') })
    .where(eq(jobs.id, eventJobId));
  await runWorkerUntilHandlerReturns({
    repository: createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => RETRY_AT
    ),
    handler,
    type: FINANCIAL_PAYOUT_JOB,
    workerId: 'financial-recovery-payout-event-replay'
  });

  expect(await databaseClient.db.select().from(jobs).where(eq(jobs.id, eventJobId)))
    .toEqual([expect.objectContaining({ status: 'succeeded', attempts: 2 })]);
  expect(await databaseClient.db.select().from(jobs).where(eq(jobs.id, continuation.id)))
    .toEqual([expect.objectContaining({ status: 'succeeded', attempts: 1 })]);
  const payoutJobs = await databaseClient.db.select().from(jobs).where(
    eq(jobs.type, FINANCIAL_PAYOUT_JOB)
  );
  expect(payoutJobs).toHaveLength(2);
  expect(new Set(payoutJobs.map((job) => job.deduplicationKey)).size).toBe(2);
  expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions).where(
    eq(stripePayoutBalanceTransactions.payoutId, payout!.id)
  )).toHaveLength(101);
});

it('replays a job crash after atomic payout publication and impact handoff without duplicating either', async () => {
  const fixture = createPayoutFixture(1);
  const eventJobId = await enqueuePayoutJob(fixture.providerPayoutId);
  const handler = createFinancialPayoutHandler({
    database: databaseClient.db,
    gateway: fixture.stripe.gateway
  });

  await expect(runWorkerUntilHandlerReturns({
    repository: disconnectTerminalWrites(createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => STARTED_AT
    )),
    handler: crashAfterSuccessfulHandler(handler),
    type: FINANCIAL_PAYOUT_JOB,
    workerId: 'financial-recovery-publication-crash'
  })).rejects.toThrow(WORKER_DISCONNECT);

  const [payout] = await databaseClient.db.select().from(stripePayouts).where(
    eq(stripePayouts.providerId, fixture.providerPayoutId)
  );
  const [publishedRun] = await databaseClient.db.select().from(payoutImportRuns).where(
    eq(payoutImportRuns.payoutId, payout!.id)
  );
  expect(payout).toMatchObject({ financialGeneration: 1 });
  expect(publishedRun).toMatchObject({
    state: 'published',
    generation: 0,
    candidateCount: 1,
    pageCount: 1,
    safeOutcome: 'published'
  });
  expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions).where(
    eq(stripePayoutBalanceTransactions.payoutId, payout!.id)
  )).toHaveLength(1);
  expect(await databaseClient.db.select().from(jobs).where(eq(
    jobs.deduplicationKey,
    `financial:payout-impact:${payout!.id}:1`
  ))).toHaveLength(1);
  expect(await databaseClient.db.select().from(auditEvents).where(and(
    eq(auditEvents.resourceId, payout!.id),
    eq(auditEvents.action, 'financial.payout.membership_published')
  ))).toHaveLength(1);
  expect(await databaseClient.db.select().from(jobs).where(eq(jobs.id, eventJobId)))
    .toEqual([expect.objectContaining({
      status: 'running',
      attempts: 1,
      lockedBy: 'financial-recovery-publication-crash',
      lockedAt: STARTED_AT
    })]);

  await databaseClient.db.update(jobs).set({ runAt: new Date('2100-01-01T00:00:00.000Z') })
    .where(eq(jobs.type, FINANCIAL_SCAN_JOB));
  await databaseClient.db.update(jobs).set({ runAt: new Date('2000-01-01T00:00:00.000Z') })
    .where(eq(jobs.id, eventJobId));
  await runWorkerUntilHandlerReturns({
    repository: createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => RETRY_AT
    ),
    handler,
    type: FINANCIAL_PAYOUT_JOB,
    workerId: 'financial-recovery-publication-restart'
  });

  expect(await databaseClient.db.select().from(jobs).where(eq(jobs.id, eventJobId)))
    .toEqual([expect.objectContaining({ status: 'succeeded', attempts: 2 })]);
  expect(await databaseClient.db.select().from(payoutImportRuns).where(
    eq(payoutImportRuns.payoutId, payout!.id)
  )).toHaveLength(1);
  expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions).where(
    eq(stripePayoutBalanceTransactions.payoutId, payout!.id)
  )).toHaveLength(1);
  expect(await databaseClient.db.select().from(jobs).where(eq(
    jobs.deduplicationKey,
    `financial:payout-impact:${payout!.id}:1`
  ))).toHaveLength(1);
  expect(await databaseClient.db.select().from(auditEvents).where(and(
    eq(auditEvents.resourceId, payout!.id),
    eq(auditEvents.action, 'financial.payout.membership_published')
  ))).toHaveLength(1);
});
