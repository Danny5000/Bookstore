import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, type SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { expect, it } from 'vitest';
import { stageBalanceTransaction } from '$lib/server/commerce/financial/ledger';
import { loadCurrentEffectiveAllocationProjection } from '$lib/server/commerce/financial/allocations/repository';
import { reconcilePaymentFinancialSource } from '$lib/server/commerce/financial/sources/payment';
import { createFinancialClassificationHandler } from '$lib/server/commerce/financial/handlers/classification';
import { FINANCIAL_CLASSIFICATION_JOB } from '$lib/server/commerce/financial/jobs';
import {
  FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  FINANCIAL_CLASSIFIER_VERSION,
  FINANCIAL_REPLAY_ID
} from '$lib/server/commerce/financial/constants';
import {
  loadCurrentPayoutEvidence,
  persistPayoutImportPage,
  publishPayoutMembership,
  stagePayoutSnapshot,
  startOrResumePayoutImport
} from '$lib/server/commerce/financial/payouts/repository';
import { reconcileFinancialPayout } from '$lib/server/commerce/financial/payouts/service';
import { replayFinancialClassificationLocked } from '$lib/server/commerce/financial/rebase';
import { processFinancialScanJob } from '$lib/server/commerce/financial/scans/service';
import { derivePublicFinancialState } from '$lib/server/commerce/financial/state';
import { queueFinancialSourceFromEvent } from '$lib/server/commerce/financial/event-handoff';
import { createFixtureStripeGateway } from '$lib/server/commerce/stripe/fixture-gateway';
import {
  auditEvents,
  financialReconciliationIssues,
  financialAllocationSets,
  financialScanRuns,
  guestIdentities,
  jobs,
  orderItems,
  orders,
  payments,
  disputes,
  payoutImportRunEntries,
  payoutImportRuns,
  refundAllocationComponents,
  refundAllocations,
  refunds,
  stripeBalanceTransactions,
  stripeBalanceTransactionFeeDetails,
  stripePayoutBalanceTransactions,
  stripePayouts,
  titles
} from '$lib/server/db/schema';
import { balanceTransactionSnapshotFixture } from '../fixtures/stripe/balance-transaction';
import { chargeSnapshotFixture } from '../fixtures/stripe/charge';
import { paymentSnapshotFixture } from '../fixtures/stripe/payment';
import { payoutSnapshotFixture } from '../fixtures/stripe/payout';
import {
  applicationConfig,
  ownerDatabaseClient,
  workerDatabaseClient,
  workerDatabaseClient as databaseClient
} from './database';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';

const dialect = new PgDialect();
const CLAIM_FIRST = new Date('2000-01-01T00:00:00.000Z');
const ACTIVE_CLASSIFICATION_IMPLEMENTATION = {
  classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
  allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  replayId: FINANCIAL_REPLAY_ID
} as const;
const C2_A2_CLASSIFICATION_IMPLEMENTATION = {
  classifierVersion: 2,
  allocationAlgorithmVersion: 2,
  replayId: 'c2-a2'
} as const;

function rendered(query: unknown): string {
  return dialect.sqlToQuery((query as SQLWrapper).getSQL()).sql;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForBlockedAdvisory(): Promise<number[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await databaseClient.pool.query<{ blockers: number[] }>(`
      select pg_blocking_pids(pid) as blockers
      from pg_stat_activity
      where cardinality(pg_blocking_pids(pid)) > 0
        and wait_event_type = 'Lock' and wait_event = 'advisory'
      order by pid
    `);
    if (result.rows[0]?.blockers.length) return result.rows[0].blockers;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

function databasePausedBeforeAdvisory(
  expectedKey: string,
  reached: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>
): Database {
  return new Proxy(databaseClient.db, {
    get(target, property) {
      if (property === 'transaction') {
        return async (work: (tx: DatabaseTransaction) => Promise<unknown>) =>
          target.transaction(async (tx) => {
            let paused = false;
            const proxy = new Proxy(tx, {
              get(transaction, transactionProperty) {
                if (transactionProperty === 'execute') {
                  return async (query: unknown) => {
                    const compiled = dialect.sqlToQuery((query as SQLWrapper).getSQL());
                    if (!paused && compiled.params.includes(expectedKey)) {
                      paused = true;
                      reached.resolve();
                      await release.promise;
                    }
                    return tx.execute(query as never);
                  };
                }
                const value = Reflect.get(transaction, transactionProperty, transaction);
                return typeof value === 'function' ? value.bind(transaction) : value;
              }
            });
            return work(proxy as unknown as DatabaseTransaction);
          });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as Database;
}

async function claimActiveParentClassificationJob(
  subjectId: string,
  workerId: string
) {
  const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
    eq(stripeBalanceTransactions.id, subjectId)
  );
  if (!balance) throw new Error('Expected the classification subject balance transaction');
  const implementation = ACTIVE_CLASSIFICATION_IMPLEMENTATION;
  const deduplicationKey = `financial:classification:${implementation.classifierVersion}:` +
    `${implementation.allocationAlgorithmVersion}:` +
    `balance_transaction:${subjectId}:${balance.fingerprintSha256}`;
  const matches = (await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey, deduplicationKey)
  )).filter((job) =>
    job.type === FINANCIAL_CLASSIFICATION_JOB &&
    job.status === 'pending' &&
    job.payload.subjectType === 'balance_transaction' &&
    job.payload.subjectId === subjectId &&
    job.payload.sourceFingerprintSha256 === balance.fingerprintSha256 &&
    job.payload.classifierVersion === implementation.classifierVersion &&
    job.payload.allocationAlgorithmVersion === implementation.allocationAlgorithmVersion &&
    job.payload.replayId === implementation.replayId
  );
  expect(matches).toHaveLength(1);
  const target = matches[0];
  if (!target) throw new Error('Expected one pending parent classification job');
  await databaseClient.db.update(jobs).set({ runAt: CLAIM_FIRST }).where(eq(jobs.id, target.id));
  const repository = createPostgresJobRepository(
    databaseClient.db,
    applicationConfig.jobs,
    () => new Date(),
    'local-only',
    {
      classifierVersion: implementation.classifierVersion,
      allocationAlgorithmVersion: implementation.allocationAlgorithmVersion
    }
  );
  const claimed = await repository.claimNext(workerId);
  expect(claimed).toMatchObject({ id: target.id, type: FINANCIAL_CLASSIFICATION_JOB });
  if (!claimed) throw new Error('Expected the parent classification job to be claimable');
  return { repository, claimed, workerId, implementation };
}

async function handleAndCompleteParentClassificationJob(
  claim: Awaited<ReturnType<typeof claimActiveParentClassificationJob>>,
  database: Database = databaseClient.db
) {
  const handler = createFinancialClassificationHandler({
    database,
    targetClassifierVersion: claim.implementation.classifierVersion,
    targetAllocationAlgorithmVersion: claim.implementation.allocationAlgorithmVersion
  });
  await handler(claim.claimed, new AbortController().signal);
  expect(await claim.repository.complete(claim.claimed.id, claim.workerId)).toBe(true);
  const [stored] = await databaseClient.db.select().from(jobs).where(eq(jobs.id, claim.claimed.id));
  if (!stored) throw new Error('Expected the completed parent classification job');
  return stored;
}

async function runActiveParentClassificationJob(
  subjectId: string,
  workerId: string
) {
  const completed = await handleAndCompleteParentClassificationJob(
    await claimActiveParentClassificationJob(subjectId, workerId)
  );
  expect(completed).toMatchObject({
    status: 'succeeded', rerunRequestedAt: null, completedAt: expect.any(Date)
  });
  return completed;
}

async function createPublishableRun(suffix: string, balanceTransactionId?: string) {
  const providerPayoutId = `po_financial_publish_${suffix}`;
  const payoutSnapshot = payoutSnapshotFixture({
    id: providerPayoutId,
    balanceTransactionId: null
  });
  const payout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshot, {
    correlationId: `payout-publish-stage-${suffix}`
  });
  const balanceSnapshot = balanceTransactionSnapshotFixture({
        id: `txn_financial_publish_${suffix}`,
        sourceId: null,
        sourceFamily: 'unknown',
        rawType: 'adjustment',
        reportingCategory: 'other_adjustment'
      });
  const balance = balanceTransactionId === undefined
    ? await stageBalanceTransaction(databaseClient.db, balanceSnapshot, {
        correlationId: `payout-publish-balance-${suffix}`
      })
    : { balanceTransactionId };
  const run = await startOrResumePayoutImport(databaseClient.db, {
    payoutId: payout.payoutId,
    expectedGeneration: 0,
    correlationId: `payout-publish-run-${suffix}`
  });
  await persistPayoutImportPage(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: run.id,
    expectedGeneration: 0,
    expectedPageCount: 0,
    expectedStartingAfter: null,
    balanceTransactionIds: [balance.balanceTransactionId],
    hasMore: false,
    nextStartingAfter: null,
    correlationId: `payout-publish-page-${suffix}`
  });
  return {
    payout, payoutSnapshot, run, balanceSnapshot,
    balanceTransactionId: balance.balanceTransactionId
  };
}

async function createPublishableGeneration(
  payoutId: string,
  generation: number,
  balanceTransactionIds: readonly string[],
  suffix: string
) {
  const run = await startOrResumePayoutImport(databaseClient.db, {
    payoutId,
    expectedGeneration: generation,
    correlationId: `payout-generation-run-${suffix}`
  });
  await persistPayoutImportPage(databaseClient.db, {
    payoutId,
    runId: run.id,
    expectedGeneration: generation,
    expectedPageCount: 0,
    expectedStartingAfter: null,
    balanceTransactionIds,
    hasMore: false,
    nextStartingAfter: null,
    correlationId: `payout-generation-page-${suffix}`
  });
  return run;
}

async function createLateLinkedPayment(suffix: string, paidAt: Date) {
  const [guest] = await ownerDatabaseClient.db.insert(guestIdentities).values({
    email: `${suffix}@example.com`
  }).returning();
  const [title] = await ownerDatabaseClient.db.insert(titles).values({
    slug: suffix, title: 'Late linked reversal title',
    description: 'Late linked reversal description',
    creatorName: 'Late linked reversal creator', format: 'prose',
    priceMinor: 100, currency: 'USD', visibility: 'private'
  }).returning();
  if (!guest || !title) throw new Error('Expected late-link purchase owners');
  const orderId = randomUUID();
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId, status: 'paid', guestIdentityId: guest.id, purchaseEmail: guest.email,
    currency: 'USD', subtotalMinor: 100, taxMinor: 0, totalMinor: 100,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: '8'.repeat(64),
    stripeCheckoutSessionId: `cs_${suffix}`, statusTokenSha256: '9'.repeat(64),
    checkoutExpiresAt: new Date(paidAt.getTime() + 30 * 60 * 1_000), paidAt
  });
  const [item] = await ownerDatabaseClient.db.insert(orderItems).values({
    orderId, titleId: title.id, titleSnapshot: title.title,
    creatorNameSnapshot: title.creatorName, format: 'prose', currency: 'USD',
    unitSubtotalMinor: 100, taxMinor: 0, totalMinor: 100,
    stripeLineItemId: `li_${suffix}`
  }).returning();
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId, stripePaymentIntentId: `pi_${suffix}`, stripeLatestChargeId: `ch_${suffix}`,
    status: 'succeeded', amountMinor: 100, currency: 'USD',
    paymentMethodCategory: 'card', paidAt
  }).returning();
  if (!item || !payment) throw new Error('Expected late-link purchase facts');
  return { orderId, item, payment };
}

it('stages and exactly replays a canonical payout', async () => {
  const suffix = randomUUID();
  const snapshot = payoutSnapshotFixture({
    id: `po_financial_payout_${suffix}`,
    balanceTransactionId: null
  });
  const inserted = await stagePayoutSnapshot(databaseClient.db, snapshot, {
    correlationId: `payout-insert-${suffix}`
  });
  const replayed = await stagePayoutSnapshot(databaseClient.db, structuredClone(snapshot), {
    correlationId: `payout-replay-${suffix}`
  });

  expect(replayed).toEqual({ ...inserted, changed: false });
  expect(await databaseClient.db.select().from(stripePayouts).where(
    eq(stripePayouts.id, inserted.payoutId)
  )).toHaveLength(1);
});

it('leaves terminal projection jobs untouched on an exact payout retrieval', async () => {
  const suffix = randomUUID();
  const providerPayoutId = `po_financial_exact_jobs_${suffix}`;
  const staged = await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
    id: `txn_financial_exact_jobs_${suffix}`,
    sourceFamily: 'payout', sourceId: providerPayoutId,
    rawType: 'payout', reportingCategory: 'payout',
    amountMinor: 100, feeMinor: 10, netMinor: 90,
    feeDetails: [
      { ordinal: 0, rawType: 'stripe_fee', amountMinor: 4, currency: 'USD' },
      { ordinal: 1, rawType: 'tax', amountMinor: 6, currency: 'USD' }
    ]
  }), { correlationId: `exact-jobs-balance-${suffix}` });
  const snapshot = payoutSnapshotFixture({
    id: providerPayoutId,
    balanceTransactionId: `txn_financial_exact_jobs_${suffix}`
  });
  await stagePayoutSnapshot(databaseClient.db, snapshot, {
    correlationId: `exact-jobs-payout-${suffix}`
  });
  const details = await databaseClient.db.select().from(stripeBalanceTransactionFeeDetails).where(
    eq(stripeBalanceTransactionFeeDetails.balanceTransactionId, staged.balanceTransactionId)
  );
  const subjectIds = [staged.balanceTransactionId, ...details.map((detail) => detail.id)];
  const projectionJobs = (await databaseClient.db.select().from(jobs)).filter((job) =>
    job.type === 'commerce.financial-classification' &&
    subjectIds.includes(String(job.payload.subjectId))
  );
  expect(projectionJobs).toHaveLength(3);
  const completedAt = new Date('2026-08-12T21:00:00.000Z');
  await databaseClient.db.update(jobs).set({
    status: 'succeeded', attempts: 1, completedAt, lastError: null
  }).where(eq(jobs.id, projectionJobs[0]!.id));
  await databaseClient.db.update(jobs).set({
    status: 'failed', attempts: 2, completedAt, lastError: 'permanent projection failure'
  }).where(eq(jobs.id, projectionJobs[1]!.id));
  await databaseClient.db.update(jobs).set({
    status: 'failed', attempts: projectionJobs[2]!.maxAttempts,
    completedAt, lastError: 'exhausted projection failure'
  }).where(eq(jobs.id, projectionJobs[2]!.id));
  const before = await databaseClient.db.select().from(jobs).where(inArray(
    jobs.id, projectionJobs.map((job) => job.id)
  ));

  await expect(stagePayoutSnapshot(databaseClient.db, structuredClone(snapshot), {
    correlationId: `exact-jobs-retrieval-${suffix}`
  })).resolves.toMatchObject({ changed: false });

  const after = await databaseClient.db.select().from(jobs).where(inArray(
    jobs.id, projectionJobs.map((job) => job.id)
  ));
  expect(after.map((job) => ({
    id: job.id, status: job.status, attempts: job.attempts,
    completedAt: job.completedAt, lastError: job.lastError
  }))).toEqual(before.map((job) => ({
    id: job.id, status: job.status, attempts: job.attempts,
    completedAt: job.completedAt, lastError: job.lastError
  })));
});

it('advances mutable payout lifecycle without changing its immutable fingerprint', async () => {
  const suffix = randomUUID();
  const snapshot = payoutSnapshotFixture({
    id: `po_financial_lifecycle_${suffix}`,
    balanceTransactionId: null
  });
  const inserted = await stagePayoutSnapshot(databaseClient.db, snapshot, {
    correlationId: `payout-lifecycle-insert-${suffix}`
  });
  const [before] = await databaseClient.db.select().from(stripePayouts).where(
    eq(stripePayouts.id, inserted.payoutId)
  );

  const updated = await stagePayoutSnapshot(databaseClient.db, {
    ...snapshot,
    status: 'failed',
    safeFailureCode: 'provider_failed',
    originalPayoutId: `po_financial_original_${suffix}`
  }, { correlationId: `payout-lifecycle-update-${suffix}` });
  const [after] = await databaseClient.db.select().from(stripePayouts).where(
    eq(stripePayouts.id, inserted.payoutId)
  );

  expect(updated).toEqual({ payoutId: inserted.payoutId, generation: 1, changed: true });
  expect(after).toMatchObject({ status: 'failed', safeFailureCode: 'provider_failed', financialGeneration: 1 });
  expect(after?.fingerprintSha256).toBe(before?.fingerprintSha256);
  expect(await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey, `financial:payout-impact:${inserted.payoutId}:1`)
  )).toHaveLength(1);
  expect(await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey,
      `stripe:financial-payout:link:${snapshot.id}:po_financial_original_${suffix}:${after!.fingerprintSha256}`)
  )).toHaveLength(1);
});

it('commits a bounded immutable-mismatch issue without changing the payout row', async () => {
  const suffix = randomUUID();
  const snapshot = payoutSnapshotFixture({
    id: `po_financial_collision_${suffix}`,
    balanceTransactionId: null
  });
  const inserted = await stagePayoutSnapshot(databaseClient.db, snapshot, {
    correlationId: `payout-collision-insert-${suffix}`
  });

  await expect(stagePayoutSnapshot(databaseClient.db, {
    ...snapshot,
    amountMinor: snapshot.amountMinor + 1
  }, { correlationId: `payout-collision-update-${suffix}` })).rejects.toMatchObject({
    name: 'PermanentFinancialError', safeCode: 'immutable_mismatch'
  });

  const [persisted] = await databaseClient.db.select().from(stripePayouts).where(
    eq(stripePayouts.id, inserted.payoutId)
  );
  expect(persisted).toMatchObject({ amountMinor: snapshot.amountMinor, financialGeneration: 0 });
  expect(await databaseClient.db.select().from(financialReconciliationIssues).where(
    eq(financialReconciliationIssues.resourceId, inserted.payoutId)
  )).toEqual([expect.objectContaining({ safeCode: 'immutable_mismatch', state: 'open' })]);
});

it('persists bounded pages provisionally and publishes one authoritative membership generation', async () => {
  const suffix = randomUUID();
  const payout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: `po_financial_membership_${suffix}`,
    balanceTransactionId: null
  }), { correlationId: `payout-membership-stage-${suffix}` });
  const first = await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
    id: `txn_financial_membership_a_${suffix}`,
    sourceId: null,
    sourceFamily: 'unknown',
    rawType: 'adjustment',
    reportingCategory: 'other_adjustment'
  }), { correlationId: `payout-membership-bt-a-${suffix}` });
  const second = await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
    id: `txn_financial_membership_b_${suffix}`,
    sourceId: null,
    sourceFamily: 'unknown',
    rawType: 'adjustment',
    reportingCategory: 'other_adjustment'
  }), { correlationId: `payout-membership-bt-b-${suffix}` });
  const run = await startOrResumePayoutImport(databaseClient.db, {
    payoutId: payout.payoutId,
    expectedGeneration: 0,
    correlationId: `payout-membership-run-${suffix}`
  });

  const afterFirst = await persistPayoutImportPage(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: run.id,
    expectedGeneration: 0,
    expectedPageCount: 0,
    expectedStartingAfter: null,
    balanceTransactionIds: [first.balanceTransactionId],
    hasMore: true,
    nextStartingAfter: `txn_cursor_${suffix}`,
    correlationId: `payout-membership-page-a-${suffix}`
  });
  expect(afterFirst).toMatchObject({ state: 'collecting', pageCount: 1, candidateCount: 1 });
  expect(await loadCurrentPayoutEvidence(databaseClient.db, [
    first.balanceTransactionId,
    second.balanceTransactionId
  ])).toMatchObject({ authoritativeMembershipCount: 0 });

  const publishable = await persistPayoutImportPage(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: run.id,
    expectedGeneration: 0,
    expectedPageCount: 1,
    expectedStartingAfter: `txn_cursor_${suffix}`,
    balanceTransactionIds: [second.balanceTransactionId, first.balanceTransactionId],
    hasMore: false,
    nextStartingAfter: null,
    correlationId: `payout-membership-page-b-${suffix}`
  });
  expect(publishable).toMatchObject({ state: 'publishable', pageCount: 2, candidateCount: 2 });
  expect(await databaseClient.db.select().from(payoutImportRunEntries).where(
    eq(payoutImportRunEntries.runId, run.id)
  )).toHaveLength(2);

  await expect(publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: run.id,
    expectedGeneration: 0,
    correlationId: `payout-membership-publish-${suffix}`
  })).resolves.toEqual({ generation: 1, membershipCount: 2 });
  await expect(publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: run.id,
    expectedGeneration: 0,
    correlationId: `payout-membership-replay-${suffix}`
  })).resolves.toEqual({ generation: 1, membershipCount: 2 });

  expect(await loadCurrentPayoutEvidence(databaseClient.db, [
    first.balanceTransactionId,
    second.balanceTransactionId
  ])).toMatchObject({
    relevantBalanceTransactionCount: 2,
    authoritativeMembershipCount: 2,
    paidAutomaticStandardCompletedCount: 2,
    conflictingMembershipCount: 0
  });
  expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions).where(
    eq(stripePayoutBalanceTransactions.payoutId, payout.payoutId)
  )).toHaveLength(2);
  expect(await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey, `financial:payout-impact:${payout.payoutId}:1`)
  )).toHaveLength(1);
  expect(await databaseClient.db.select().from(auditEvents).where(and(
    eq(auditEvents.resourceId, payout.payoutId),
    eq(auditEvents.action, 'financial.payout.membership_published')
  ))).toHaveLength(1);

  const resumed = await startOrResumePayoutImport(databaseClient.db, {
    payoutId: payout.payoutId,
    expectedGeneration: 1,
    correlationId: `payout-membership-resume-${suffix}`
  });
  expect(resumed).toMatchObject({ id: run.id, state: 'published', generation: 0 });
  expect(await databaseClient.db.select().from(payoutImportRuns).where(
    eq(payoutImportRuns.payoutId, payout.payoutId)
  )).toHaveLength(1);

  await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: `po_financial_membership_${suffix}`,
    balanceTransactionId: null,
    status: 'failed',
    safeFailureCode: 'provider_failed'
  }), { correlationId: `payout-membership-failed-${suffix}` });
  expect(await loadCurrentPayoutEvidence(databaseClient.db, [first.balanceTransactionId]))
    .toMatchObject({ hasMissingPayoutReversal: true });
});

it('terminates an exact later membership replay without generation, impact, or publication audit churn', async () => {
  const suffix = randomUUID();
  const fixture = await createPublishableRun(suffix);
  await publishPayoutMembership(databaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: fixture.run.id,
    expectedGeneration: 0,
    correlationId: `payout-later-exact-first-${suffix}`
  });
  const advanced = await stagePayoutSnapshot(databaseClient.db, {
    ...fixture.payoutSnapshot,
    arrivalAt: new Date(fixture.payoutSnapshot.arrivalAt.getTime() + 60_000)
  }, { correlationId: `payout-later-exact-advance-${suffix}` });
  expect(advanced.generation).toBe(2);
  const later = await createPublishableGeneration(
    fixture.payout.payoutId,
    advanced.generation,
    [fixture.balanceTransactionId],
    `${suffix}-later`
  );
  const auditsBefore = await databaseClient.db.select().from(auditEvents).where(and(
    eq(auditEvents.resourceId, fixture.payout.payoutId),
    eq(auditEvents.action, 'financial.payout.membership_published')
  ));
  const jobsBefore = await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey, `financial:payout-impact:${fixture.payout.payoutId}:3`)
  );

  await expect(publishPayoutMembership(databaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: later.id,
    expectedGeneration: advanced.generation,
    correlationId: `payout-later-exact-publish-${suffix}`
  })).resolves.toEqual({ generation: 2, membershipCount: 1 });
  await expect(publishPayoutMembership(databaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: later.id,
    expectedGeneration: advanced.generation,
    correlationId: `payout-later-exact-replay-${suffix}`
  })).resolves.toEqual({ generation: 2, membershipCount: 1 });

  expect(await databaseClient.db.select().from(stripePayouts).where(
    eq(stripePayouts.id, fixture.payout.payoutId)
  )).toEqual([expect.objectContaining({ financialGeneration: 2 })]);
  expect(await databaseClient.db.select().from(payoutImportRuns).where(
    eq(payoutImportRuns.id, later.id)
  )).toEqual([expect.objectContaining({ state: 'published', safeOutcome: 'published' })]);
  expect(await databaseClient.db.select().from(auditEvents).where(and(
    eq(auditEvents.resourceId, fixture.payout.payoutId),
    eq(auditEvents.action, 'financial.payout.membership_published')
  ))).toHaveLength(auditsBefore.length);
  expect(jobsBefore).toHaveLength(0);
  expect(await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey, `financial:payout-impact:${fixture.payout.payoutId}:3`)
  )).toHaveLength(0);
});

it('publishes the first empty membership but treats a later empty publication as exact history', async () => {
  const suffix = randomUUID();
  const snapshot = payoutSnapshotFixture({
    id: `po_financial_empty_history_${suffix}`,
    balanceTransactionId: null
  });
  const payout = await stagePayoutSnapshot(databaseClient.db, snapshot, {
    correlationId: `payout-empty-history-stage-${suffix}`
  });
  const first = await createPublishableGeneration(payout.payoutId, 0, [], `${suffix}-first`);
  await expect(publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: first.id,
    expectedGeneration: 0,
    correlationId: `payout-empty-history-publish-${suffix}`
  })).resolves.toEqual({ generation: 1, membershipCount: 0 });
  const advanced = await stagePayoutSnapshot(databaseClient.db, {
    ...snapshot,
    arrivalAt: new Date(snapshot.arrivalAt.getTime() + 60_000)
  }, { correlationId: `payout-empty-history-advance-${suffix}` });
  const later = await createPublishableGeneration(payout.payoutId, advanced.generation, [], `${suffix}-later`);

  await expect(publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: later.id,
    expectedGeneration: advanced.generation,
    correlationId: `payout-empty-history-replay-${suffix}`
  })).resolves.toEqual({ generation: 2, membershipCount: 0 });
  expect(await databaseClient.db.select().from(auditEvents).where(and(
    eq(auditEvents.resourceId, payout.payoutId),
    eq(auditEvents.action, 'financial.payout.membership_published')
  ))).toHaveLength(1);
});

it.each([
  ['reduced', false, false],
  ['expanded', true, true],
  ['substituted', false, true]
] as const)('rejects a %s later membership candidate without mutating authoritative membership', async (
  _label,
  includeExisting,
  includeAdditional
) => {
  const suffix = randomUUID();
  const fixture = await createPublishableRun(`${suffix}-existing`);
  await publishPayoutMembership(databaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: fixture.run.id,
    expectedGeneration: 0,
    correlationId: `payout-later-conflict-first-${suffix}`
  });
  const additional = includeAdditional
    ? await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
        id: `txn_financial_later_conflict_${suffix}`,
        sourceId: null,
        sourceFamily: 'unknown',
        rawType: 'adjustment',
        reportingCategory: 'other_adjustment'
      }), { correlationId: `payout-later-conflict-balance-${suffix}` })
    : null;
  const advanced = await stagePayoutSnapshot(databaseClient.db, {
    ...fixture.payoutSnapshot,
    arrivalAt: new Date(fixture.payoutSnapshot.arrivalAt.getTime() + 60_000)
  }, { correlationId: `payout-later-conflict-advance-${suffix}` });
  const candidates = [
    ...(includeExisting ? [fixture.balanceTransactionId] : []),
    ...(additional ? [additional.balanceTransactionId] : [])
  ];
  const later = await createPublishableGeneration(
    fixture.payout.payoutId,
    advanced.generation,
    candidates,
    `${suffix}-later`
  );

  await expect(publishPayoutMembership(databaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: later.id,
    expectedGeneration: advanced.generation,
    correlationId: `payout-later-conflict-publish-${suffix}`
  })).rejects.toMatchObject({ safeCode: 'payout_membership_conflict' });
  expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions).where(
    eq(stripePayoutBalanceTransactions.payoutId, fixture.payout.payoutId)
  )).toEqual([expect.objectContaining({ balanceTransactionId: fixture.balanceTransactionId })]);
  expect(await databaseClient.db.select().from(stripePayouts).where(
    eq(stripePayouts.id, fixture.payout.payoutId)
  )).toEqual([expect.objectContaining({ financialGeneration: 2 })]);
  expect(await databaseClient.db.select().from(payoutImportRuns).where(
    eq(payoutImportRuns.id, later.id)
  )).toEqual([expect.objectContaining({
    state: 'exception', safeOutcome: 'payout_membership_conflict'
  })]);
});

it('resolves a prior membership conflict only after a later complete set matches history', async () => {
  const suffix = randomUUID();
  const fixture = await createPublishableRun(`${suffix}-recovery`);
  await publishPayoutMembership(databaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: fixture.run.id,
    expectedGeneration: 0,
    correlationId: `payout-conflict-recovery-first-${suffix}`
  });
  const conflictedGeneration = await stagePayoutSnapshot(databaseClient.db, {
    ...fixture.payoutSnapshot,
    arrivalAt: new Date(fixture.payoutSnapshot.arrivalAt.getTime() + 60_000)
  }, { correlationId: `payout-conflict-recovery-advance-${suffix}` });
  const conflicting = await createPublishableGeneration(
    fixture.payout.payoutId,
    conflictedGeneration.generation,
    [],
    `${suffix}-conflict`
  );
  await expect(publishPayoutMembership(databaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: conflicting.id,
    expectedGeneration: conflictedGeneration.generation,
    correlationId: `payout-conflict-recovery-conflict-${suffix}`
  })).rejects.toMatchObject({ safeCode: 'payout_membership_conflict' });

  const recoveredGeneration = await stagePayoutSnapshot(databaseClient.db, {
    ...fixture.payoutSnapshot,
    arrivalAt: new Date(fixture.payoutSnapshot.arrivalAt.getTime() + 120_000)
  }, { correlationId: `payout-conflict-recovery-refresh-${suffix}` });
  const recovered = await createPublishableGeneration(
    fixture.payout.payoutId,
    recoveredGeneration.generation,
    [fixture.balanceTransactionId],
    `${suffix}-exact`
  );
  await expect(publishPayoutMembership(workerDatabaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: recovered.id,
    expectedGeneration: recoveredGeneration.generation,
    correlationId: `payout-conflict-recovery-exact-${suffix}`
  })).resolves.toEqual({
    generation: recoveredGeneration.generation,
    membershipCount: 1
  });

  expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
    eq(financialReconciliationIssues.resourceId, fixture.payout.payoutId),
    eq(financialReconciliationIssues.safeCode, 'payout_membership_conflict')
  ))).toEqual([expect.objectContaining({ state: 'resolved' })]);
});

it('reopens a paid payout when reversal linkage appears and never treats it as current paid evidence again', async () => {
  const suffix = randomUUID();
  const published = await createPublishableRun(suffix);
  await publishPayoutMembership(databaseClient.db, {
    payoutId: published.payout.payoutId,
    runId: published.run.id,
    expectedGeneration: 0,
    correlationId: `payout-reversal-publish-${suffix}`
  });
  const reversingProviderPayoutId = `po_financial_reversing_${suffix}`;

  await stagePayoutSnapshot(databaseClient.db, {
    ...published.payoutSnapshot,
    reversedByPayoutId: reversingProviderPayoutId
  }, { correlationId: `payout-reversal-link-${suffix}` });

  const missing = await loadCurrentPayoutEvidence(databaseClient.db, [
    published.balanceTransactionId
  ]);
  expect(missing).toMatchObject({
    authoritativeMembershipCount: 1,
    paidAutomaticStandardCompletedCount: 0,
    hasMissingPayoutReversal: true
  });
  expect(derivePublicFinancialState({
    financialEvidenceStatus: 'fee_reconciled',
    payoutEvidence: missing
  })).toBe('exception');
  expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
    eq(financialReconciliationIssues.resourceId, published.payout.payoutId),
    eq(financialReconciliationIssues.safeCode, 'payout_reversal_incomplete')
  ))).toEqual([expect.objectContaining({ state: 'open', impact: 'exception' })]);

  const unrelatedReversal = payoutSnapshotFixture({
    id: reversingProviderPayoutId,
    balanceTransactionId: null
  });
  await stagePayoutSnapshot(databaseClient.db, unrelatedReversal, {
    correlationId: `payout-reversal-unlinked-${suffix}`
  });
  expect(await loadCurrentPayoutEvidence(databaseClient.db, [
    published.balanceTransactionId
  ])).toMatchObject({ hasMissingPayoutReversal: true });
  expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
    eq(financialReconciliationIssues.resourceId, published.payout.payoutId),
    eq(financialReconciliationIssues.safeCode, 'payout_reversal_incomplete')
  ))).toEqual([expect.objectContaining({ state: 'open' })]);

  await stagePayoutSnapshot(workerDatabaseClient.db, {
    ...unrelatedReversal,
    originalPayoutId: published.payoutSnapshot.id
  }, { correlationId: `payout-reversal-import-${suffix}` });

  const complete = await loadCurrentPayoutEvidence(databaseClient.db, [
    published.balanceTransactionId
  ]);
  expect(complete).toMatchObject({
    authoritativeMembershipCount: 1,
    paidAutomaticStandardCompletedCount: 0,
    hasMissingPayoutReversal: false
  });
  expect(derivePublicFinancialState({
    financialEvidenceStatus: 'fee_reconciled',
    payoutEvidence: complete
  })).toBe('fee_reconciled');
  expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
    eq(financialReconciliationIssues.resourceId, published.payout.payoutId),
    eq(financialReconciliationIssues.safeCode, 'payout_reversal_incomplete')
  ))).toEqual([expect.objectContaining({ state: 'resolved' })]);
});

it('observes a failed payout without failure evidence and resolves it when the evidence arrives', async () => {
  const suffix = randomUUID();
  const providerPayoutId = `po_financial_failure_evidence_${suffix}`;
  const snapshot = payoutSnapshotFixture({
    id: providerPayoutId,
    balanceTransactionId: null,
    failureBalanceTransactionId: null,
    status: 'failed',
    safeFailureCode: 'provider_failed'
  });
  const payout = await stagePayoutSnapshot(databaseClient.db, snapshot, {
    correlationId: `payout-failure-evidence-missing-${suffix}`
  });
  expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
    eq(financialReconciliationIssues.resourceId, payout.payoutId),
    eq(financialReconciliationIssues.safeCode, 'payout_reversal_incomplete')
  ))).toEqual([expect.objectContaining({ state: 'open', impact: 'exception' })]);

  const failureProviderId = `txn_financial_failure_evidence_${suffix}`;
  await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
    id: failureProviderId,
    sourceFamily: 'payout',
    sourceId: providerPayoutId,
    rawType: 'payout_failure',
    reportingCategory: 'payout'
  }), { correlationId: `payout-failure-evidence-balance-${suffix}` });
  await stagePayoutSnapshot(workerDatabaseClient.db, {
    ...snapshot,
    failureBalanceTransactionId: failureProviderId
  }, { correlationId: `payout-failure-evidence-complete-${suffix}` });

  expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
    eq(financialReconciliationIssues.resourceId, payout.payoutId),
    eq(financialReconciliationIssues.safeCode, 'payout_reversal_incomplete')
  ))).toEqual([expect.objectContaining({ state: 'resolved' })]);
});

it('enqueues current-version account projections for late adjustment and payout evidence', async () => {
  const suffix = randomUUID();
  const adjustment = await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
    id: `txn_financial_late_adjustment_${suffix}`,
    sourceFamily: 'unknown',
    sourceId: null,
    rawType: 'adjustment',
    reportingCategory: 'other_adjustment'
  }), { correlationId: `late-adjustment-${suffix}` });
  expect(await databaseClient.db.select().from(jobs).where(
    like(jobs.deduplicationKey, `financial:classification:%:balance_transaction:${adjustment.balanceTransactionId}:%`)
  )).toHaveLength(1);

  const providerPayoutId = `po_financial_late_balance_${suffix}`;
  await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: providerPayoutId,
    balanceTransactionId: null
  }), { correlationId: `late-payout-first-${suffix}` });
  const latePayoutBalance = await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
    id: `txn_financial_late_payout_${suffix}`,
    sourceFamily: 'payout',
    sourceId: providerPayoutId,
    rawType: 'payout',
    reportingCategory: 'payout'
  }), { correlationId: `late-payout-balance-${suffix}` });
  expect(await databaseClient.db.select().from(jobs).where(
    like(jobs.deduplicationKey, `financial:classification:%:balance_transaction:${latePayoutBalance.balanceTransactionId}:%`)
  )).toHaveLength(1);

  const earlyProviderPayoutId = `po_financial_early_balance_${suffix}`;
  const earlyPayoutBalance = await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
    id: `txn_financial_early_payout_${suffix}`,
    sourceFamily: 'payout',
    sourceId: earlyProviderPayoutId,
    rawType: 'payout',
    reportingCategory: 'payout'
  }), { correlationId: `early-payout-balance-${suffix}` });
  expect(await databaseClient.db.select().from(jobs).where(
    like(jobs.deduplicationKey, `financial:classification:%:balance_transaction:${earlyPayoutBalance.balanceTransactionId}:%`)
  )).toHaveLength(0);
  await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: earlyProviderPayoutId,
    balanceTransactionId: `txn_financial_early_payout_${suffix}`
  }), { correlationId: `early-payout-arrives-${suffix}` });
  expect(await databaseClient.db.select().from(jobs).where(
    like(jobs.deduplicationKey, `financial:classification:%:balance_transaction:${earlyPayoutBalance.balanceTransactionId}:%`)
  )).toHaveLength(1);
});

it('enqueues account projections for payout members without a proven bookstore source', async () => {
  const suffix = randomUUID();
  const payout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: `po_financial_unrelated_${suffix}`,
    balanceTransactionId: null
  }), { correlationId: `unrelated-payout-${suffix}` });
  const members = await Promise.all([
    stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
      id: `txn_financial_unrelated_charge_${suffix}`,
      sourceFamily: 'charge', sourceId: `ch_financial_unrelated_${suffix}`,
      rawType: 'charge', reportingCategory: 'charge'
    }), { correlationId: `unrelated-charge-${suffix}` }),
    stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
      id: `txn_financial_unrelated_refund_${suffix}`,
      sourceFamily: 'refund', sourceId: `re_financial_unrelated_${suffix}`,
      rawType: 'refund', reportingCategory: 'refund', amountMinor: -100,
      feeMinor: 0, netMinor: -100, feeDetails: []
    }), { correlationId: `unrelated-refund-${suffix}` }),
    stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
      id: `txn_financial_unrelated_dispute_${suffix}`,
      sourceFamily: 'dispute', sourceId: `dp_financial_unrelated_${suffix}`,
      rawType: 'adjustment', reportingCategory: 'dispute', amountMinor: -100,
      feeMinor: 0, netMinor: -100, feeDetails: []
    }), { correlationId: `unrelated-dispute-${suffix}` }),
    stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
      id: `txn_financial_unrelated_dispute_credit_${suffix}`,
      sourceFamily: 'dispute', sourceId: `dp_financial_unrelated_credit_${suffix}`,
      rawType: 'stripe_fee', reportingCategory: 'fee', amountMinor: 15,
      feeMinor: 0, netMinor: 15, feeDetails: []
    }), { correlationId: `unrelated-dispute-credit-${suffix}` })
  ]);
  const run = await createPublishableGeneration(
    payout.payoutId,
    payout.generation,
    members.map((member) => member.balanceTransactionId),
    `unrelated-${suffix}`
  );

  await publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: run.id,
    expectedGeneration: payout.generation,
    correlationId: `unrelated-publish-${suffix}`
  });

  for (const member of members) {
    expect(await databaseClient.db.select().from(jobs).where(
      like(jobs.deduplicationKey,
        `financial:classification:%:balance_transaction:${member.balanceTransactionId}:%`)
    )).toHaveLength(1);
    const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
      eq(stripeBalanceTransactions.id, member.balanceTransactionId)
    );
    if (!balance) throw new Error('Expected unrelated payout member');
    await runActiveParentClassificationJob(
      balance.id,
      `unrelated-account-${balance.id}`
    );
    const fallbackSets = await databaseClient.db.select().from(financialAllocationSets).where(
      eq(financialAllocationSets.balanceTransactionId, balance.id)
    );
    expect(fallbackSets).toHaveLength(2);
    expect(fallbackSets.every((set) => set.sourceKind === 'adjustment' &&
      set.sourceInternalId === balance.id)).toBe(true);
  }
  const projections = await loadCurrentEffectiveAllocationProjection(databaseClient.db, {
    balanceTransactionIds: members.map((member) => member.balanceTransactionId)
  });
  expect(projections).toHaveLength(8);
  expect(projections.every((projection) =>
    projection.status === 'complete' && projection.scope === 'account'
  )).toBe(true);
});

it('rejects noncanonical signs for payout-member account fallback classifications', async () => {
  const suffix = randomUUID();
  const payout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: `po_financial_unrelated_sign_${suffix}`,
    balanceTransactionId: null
  }), { correlationId: `unrelated-sign-payout-${suffix}` });
  const cases = [
    { label: 'charge-zero', sourceFamily: 'charge' as const,
      rawType: 'charge', reportingCategory: 'charge', amountMinor: 0 },
    { label: 'charge-negative', sourceFamily: 'charge' as const,
      rawType: 'charge', reportingCategory: 'charge', amountMinor: -100 },
    { label: 'refund-zero', sourceFamily: 'refund' as const,
      rawType: 'refund', reportingCategory: 'refund', amountMinor: 0 },
    { label: 'refund-positive', sourceFamily: 'refund' as const,
      rawType: 'refund', reportingCategory: 'refund', amountMinor: 100 },
    { label: 'refund-failure-zero', sourceFamily: 'refund' as const,
      rawType: 'refund_failure', reportingCategory: 'refund_failure', amountMinor: 0 },
    { label: 'refund-failure-negative', sourceFamily: 'refund' as const,
      rawType: 'refund_failure', reportingCategory: 'refund_failure', amountMinor: -100 },
    { label: 'withdrawal-zero', sourceFamily: 'dispute' as const,
      rawType: 'adjustment', reportingCategory: 'dispute', amountMinor: 0 },
    { label: 'withdrawal-positive', sourceFamily: 'dispute' as const,
      rawType: 'adjustment', reportingCategory: 'dispute', amountMinor: 100 },
    { label: 'reinstatement-zero', sourceFamily: 'dispute' as const,
      rawType: 'adjustment', reportingCategory: 'dispute_reversal', amountMinor: 0 },
    { label: 'reinstatement-negative', sourceFamily: 'dispute' as const,
      rawType: 'adjustment', reportingCategory: 'dispute_reversal', amountMinor: -100 }
  ];
  const staged = await Promise.all(cases.map((candidate) =>
    stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
      id: `txn_financial_unrelated_sign_${candidate.label}_${suffix}`,
      sourceFamily: candidate.sourceFamily,
      sourceId: `${candidate.sourceFamily === 'charge' ? 'ch' :
        candidate.sourceFamily === 'refund' ? 're' : 'dp'}_financial_unrelated_sign_${candidate.label}_${suffix}`,
      rawType: candidate.rawType,
      reportingCategory: candidate.reportingCategory,
      amountMinor: candidate.amountMinor,
      feeMinor: 0,
      netMinor: candidate.amountMinor,
      feeDetails: []
    }), { correlationId: `unrelated-sign-stage-${candidate.label}-${suffix}` })
  ));
  const run = await createPublishableGeneration(
    payout.payoutId,
    payout.generation,
    staged.map((balance) => balance.balanceTransactionId),
    `unrelated-sign-${suffix}`
  );
  await publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: run.id,
    expectedGeneration: payout.generation,
    correlationId: `unrelated-sign-publish-${suffix}`
  });

  for (const [index, balance] of staged.entries()) {
    const [stored] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
      eq(stripeBalanceTransactions.id, balance.balanceTransactionId)
    );
    if (!stored) throw new Error('Expected malformed-sign payout member');
    await expect(databaseClient.db.transaction((tx) => replayFinancialClassificationLocked(tx, {
      subjectType: 'balance_transaction',
      subjectId: stored.id,
      sourceFingerprintSha256: stored.fingerprintSha256,
      ...ACTIVE_CLASSIFICATION_IMPLEMENTATION,
      correlationId: `unrelated-sign-replay-${cases[index]!.label}-${suffix}`
    })), cases[index]!.label).rejects.toMatchObject({
      name: 'PermanentFinancialError',
      safeCode: 'source_linkage_mismatch'
    });
    await expect(databaseClient.db.select().from(financialAllocationSets).where(
      eq(financialAllocationSets.balanceTransactionId, stored.id)
    ), cases[index]!.label).resolves.toHaveLength(0);
  }
});

it('rearms failed pending-replay parent and fee children when payout membership becomes authoritative', async () => {
  const suffix = randomUUID();
  const payout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: `po_financial_pending_membership_${suffix}`,
    balanceTransactionId: null
  }), { correlationId: `pending-membership-payout-${suffix}` });
  const staged = await stageBalanceTransaction(databaseClient.db,
    balanceTransactionSnapshotFixture({
      id: `txn_financial_pending_membership_${suffix}`,
      sourceFamily: 'charge', sourceId: `ch_financial_pending_membership_${suffix}`,
      rawType: 'charge', reportingCategory: 'charge',
      amountMinor: 100, feeMinor: 10, netMinor: 90,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 10, currency: 'USD' }]
    }), { correlationId: `pending-membership-balance-${suffix}` }, {
      classifierVersion: 2, allocationAlgorithmVersion: 2
    });
  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as Parameters<typeof processFinancialScanJob>[0]['gateway'];
  await processFinancialScanJob({
    database: databaseClient.db, gateway, runtimeMode: 'disabled'
  }, {
    payload: { kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2' },
    correlationId: `pending-membership-replay-${suffix}`,
    signal: new AbortController().signal
  });
  const [scan] = await databaseClient.db.select().from(financialScanRuns);
  const details = await databaseClient.db.select().from(stripeBalanceTransactionFeeDetails).where(
    eq(stripeBalanceTransactionFeeDetails.balanceTransactionId, staged.balanceTransactionId)
  );
  const subjectIds = [staged.balanceTransactionId, ...details.map((detail) => detail.id)];
  const linked = (await databaseClient.db.select().from(jobs)).filter((job) =>
    job.type === 'commerce.financial-classification' &&
    subjectIds.includes(String(job.payload.subjectId)) &&
    job.payload.classifierVersion === 2
  );
  expect(linked).toHaveLength(2);
  expect(linked.every((job) => job.payload.scanRunId === scan!.id)).toBe(true);
  await databaseClient.db.update(jobs).set({
    status: 'failed', attempts: 8, lastError: 'Missing payout membership',
    completedAt: new Date()
  }).where(inArray(jobs.id, linked.map((job) => job.id)));

  const run = await createPublishableGeneration(
    payout.payoutId, payout.generation, [staged.balanceTransactionId],
    `pending-membership-${suffix}`
  );
  await publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId, runId: run.id,
    expectedGeneration: payout.generation,
    correlationId: `pending-membership-publish-${suffix}`
  });

  const rearmed = await databaseClient.db.select().from(jobs).where(
    inArray(jobs.id, linked.map((job) => job.id))
  );
  expect(rearmed).toHaveLength(2);
  expect(rearmed.every((job) => job.status === 'pending' && job.attempts === 0 &&
    job.completedAt === null && job.lastError === null &&
    job.payload.scanRunId === scan!.id)).toBe(true);
});

it('retries account fallback when a bookstore charge link appears after routing discovery', async () => {
  const suffix = randomUUID();
  const providerChargeId = `ch_financial_racing_link_${suffix}`;
  const payout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: `po_financial_racing_link_${suffix}`,
    balanceTransactionId: null
  }), { correlationId: `racing-link-payout-${suffix}` });
  const staged = await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
    id: `txn_financial_racing_link_${suffix}`,
    sourceFamily: 'charge', sourceId: providerChargeId,
    amountMinor: 100, feeMinor: 10, netMinor: 90,
    feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 10, currency: 'USD' }]
  }), { correlationId: `racing-link-balance-${suffix}` });
  const run = await createPublishableGeneration(
    payout.payoutId,
    payout.generation,
    [staged.balanceTransactionId],
    `racing-link-${suffix}`
  );
  await publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: run.id,
    expectedGeneration: payout.generation,
    correlationId: `racing-link-publish-${suffix}`
  });
  const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
    eq(stripeBalanceTransactions.id, staged.balanceTransactionId)
  );
  if (!balance) throw new Error('Expected racing payout member');
  const details = await databaseClient.db.select().from(stripeBalanceTransactionFeeDetails).where(
    eq(stripeBalanceTransactionFeeDetails.balanceTransactionId, balance.id)
  );
  const subjectIds = [balance.id, ...details.map((detail) => detail.id)];
  const projectionJobs = (await databaseClient.db.select().from(jobs)).filter((job) =>
    job.type === 'commerce.financial-classification' &&
    subjectIds.includes(String(job.payload.subjectId)) &&
    job.payload.classifierVersion === 1
  );
  expect(projectionJobs).toHaveLength(2);
  const parentJob = projectionJobs.find((job) =>
    job.payload.subjectType === 'balance_transaction'
  );
  const feeJobs = projectionJobs.filter((job) => job.payload.subjectType === 'fee_detail');
  if (!parentJob) throw new Error('Expected the racing parent classification job');
  expect(feeJobs).toHaveLength(1);
  await databaseClient.db.update(jobs).set({
    status: 'failed', attempts: 8, lastError: 'Stale account route', completedAt: new Date()
  }).where(inArray(jobs.id, feeJobs.map((job) => job.id)));

  const routingRead = deferred<void>();
  const releaseReplay = deferred<void>();
  let routingReadCount = 0;
  const staleDatabase = new Proxy(databaseClient.db, {
    get(target, property) {
      if (property === 'transaction') {
        return async (work: (tx: DatabaseTransaction) => Promise<unknown>) =>
          target.transaction(async (tx) => {
            const proxy = new Proxy(tx, {
              get(transaction, transactionProperty) {
                if (transactionProperty === 'execute') {
                  return async (query: unknown) => {
                    const result = await tx.execute(query as never);
                    if (rendered(query).includes(
                      'from payments payment where payment.stripe_latest_charge_id'
                    )) {
                      routingReadCount += 1;
                      if (routingReadCount === 2) {
                        routingRead.resolve();
                        await releaseReplay.promise;
                      }
                    }
                    return result;
                  };
                }
                const value = Reflect.get(transaction, transactionProperty, transaction);
                return typeof value === 'function' ? value.bind(transaction) : value;
              }
            });
            return work(proxy as unknown as DatabaseTransaction);
          });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as Database;
  const staleClaim = await claimActiveParentClassificationJob(
    balance.id,
    `racing-link-stale-${suffix}`
  );
  expect(staleClaim.claimed.id).toBe(parentJob.id);
  const staleReplay = handleAndCompleteParentClassificationJob(staleClaim, staleDatabase);
  await routingRead.promise;

  try {
    await ownerDatabaseClient.db.transaction(async (tx) => {
      const [guest] = await tx.insert(guestIdentities).values({
        email: `racing-link-${suffix}@example.com`
      }).returning();
      const [title] = await tx.insert(titles).values({
        slug: `racing-link-${suffix}`, title: 'Racing linked title',
        description: 'Racing linked description', creatorName: 'Racing linked creator',
        format: 'prose', priceMinor: 100, currency: 'USD', visibility: 'private'
      }).returning();
      if (!guest || !title) throw new Error('Expected racing-link owner rows');
      const orderId = randomUUID();
      await tx.insert(orders).values({
        id: orderId, status: 'paid', guestIdentityId: guest.id, purchaseEmail: guest.email,
        currency: 'USD', subtotalMinor: 100, taxMinor: 0, totalMinor: 100,
        clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'd'.repeat(64),
        stripeCheckoutSessionId: `cs_financial_racing_link_${suffix}`,
        statusTokenSha256: 'e'.repeat(64),
        checkoutExpiresAt: new Date('2026-08-12T00:30:00.000Z'),
        paidAt: balance.providerCreatedAt
      });
      await tx.insert(orderItems).values({
        orderId, titleId: title.id, titleSnapshot: title.title,
        creatorNameSnapshot: title.creatorName, format: 'prose', currency: 'USD',
        unitSubtotalMinor: 100, taxMinor: 0, totalMinor: 100,
        stripeLineItemId: `li_financial_racing_link_${suffix}`
      });
      const [payment] = await tx.insert(payments).values({
        orderId, stripePaymentIntentId: `pi_financial_racing_link_${suffix}`,
        stripeLatestChargeId: providerChargeId, status: 'succeeded',
        amountMinor: 100, currency: 'USD', paymentMethodCategory: 'card',
        paidAt: balance.providerCreatedAt
      }).returning();
      if (!payment) throw new Error('Expected racing-link payment');
      await queueFinancialSourceFromEvent(tx, {
        sourceKind: 'payment', sourceId: payment.id,
        providerEventId: `evt_financial_racing_link_${suffix}`,
        projectionGraphSourceIds: [payment.id]
      });
    });
    const [runningMarker] = await databaseClient.db.select().from(jobs).where(
      eq(jobs.id, parentJob.id)
    );
    expect(runningMarker).toMatchObject({
      status: 'running', rerunRequestedAt: expect.any(Date)
    });
  } finally {
    releaseReplay.resolve();
  }

  await expect(staleReplay).resolves.toMatchObject({
    status: 'pending', attempts: 0, rerunRequestedAt: null, completedAt: null
  });
  const staleSets = await databaseClient.db.select().from(financialAllocationSets).where(
    eq(financialAllocationSets.balanceTransactionId, balance.id)
  );
  expect(staleSets).toHaveLength(2);
  expect(staleSets.every((set) => set.scope === 'account')).toBe(true);
  const rearmed = await databaseClient.db.select().from(jobs).where(
    inArray(jobs.id, projectionJobs.map((job) => job.id))
  );
  expect(rearmed.every((job) => job.status === 'pending' && job.attempts === 0 &&
    job.completedAt === null && job.lastError === null)).toBe(true);

  await runActiveParentClassificationJob(
    balance.id,
    `racing-link-current-${suffix}`
  );
  const current = await loadCurrentEffectiveAllocationProjection(databaseClient.db, {
    balanceTransactionIds: [balance.id]
  });
  expect(current).toEqual([
    expect.objectContaining({ status: 'complete', basis: 'gross_amount', scope: 'title' }),
    expect.objectContaining({ status: 'complete', basis: 'fee', scope: 'title' })
  ]);
});

it('retries account fallback when a bookstore charge link commits before routing recheck', async () => {
  const suffix = randomUUID();
  const providerChargeId = `ch_financial_recheck_link_${suffix}`;
  const payout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: `po_financial_recheck_link_${suffix}`,
    balanceTransactionId: null
  }), { correlationId: `recheck-link-payout-${suffix}` });
  const staged = await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
    id: `txn_financial_recheck_link_${suffix}`,
    sourceFamily: 'charge', sourceId: providerChargeId,
    amountMinor: 100, feeMinor: 10, netMinor: 90,
    feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 10, currency: 'USD' }]
  }), { correlationId: `recheck-link-balance-${suffix}` });
  const run = await createPublishableGeneration(
    payout.payoutId,
    payout.generation,
    [staged.balanceTransactionId],
    `recheck-link-${suffix}`
  );
  await publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: run.id,
    expectedGeneration: payout.generation,
    correlationId: `recheck-link-publish-${suffix}`
  });
  const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
    eq(stripeBalanceTransactions.id, staged.balanceTransactionId)
  );
  if (!balance) throw new Error('Expected routing-recheck payout member');

  const beforeRoutingRecheck = deferred<void>();
  const releaseRoutingRecheck = deferred<void>();
  const replay = databaseClient.db.transaction(async (tx) => {
    let routingReadCount = 0;
    const proxy = new Proxy(tx, {
      get(target, property) {
        if (property === 'execute') {
          return async (query: unknown) => {
            if (rendered(query).includes(
              'from payments payment where payment.stripe_latest_charge_id'
            )) {
              routingReadCount += 1;
              if (routingReadCount === 2) {
                beforeRoutingRecheck.resolve();
                await releaseRoutingRecheck.promise;
              }
            }
            return tx.execute(query as never);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    return replayFinancialClassificationLocked(proxy as DatabaseTransaction, {
      subjectType: 'balance_transaction', subjectId: balance.id,
      sourceFingerprintSha256: balance.fingerprintSha256,
      ...ACTIVE_CLASSIFICATION_IMPLEMENTATION,
      correlationId: `recheck-link-stale-${suffix}`
    });
  });
  await beforeRoutingRecheck.promise;

  try {
    await ownerDatabaseClient.db.transaction(async (tx) => {
      const [guest] = await tx.insert(guestIdentities).values({
        email: `recheck-link-${suffix}@example.com`
      }).returning();
      const [title] = await tx.insert(titles).values({
        slug: `recheck-link-${suffix}`, title: 'Routing recheck title',
        description: 'Routing recheck description', creatorName: 'Routing recheck creator',
        format: 'prose', priceMinor: 100, currency: 'USD', visibility: 'private'
      }).returning();
      if (!guest || !title) throw new Error('Expected routing-recheck owner rows');
      const orderId = randomUUID();
      await tx.insert(orders).values({
        id: orderId, status: 'paid', guestIdentityId: guest.id, purchaseEmail: guest.email,
        currency: 'USD', subtotalMinor: 100, taxMinor: 0, totalMinor: 100,
        clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'f'.repeat(64),
        stripeCheckoutSessionId: `cs_financial_recheck_link_${suffix}`,
        statusTokenSha256: 'a'.repeat(64),
        checkoutExpiresAt: new Date('2026-08-12T00:30:00.000Z'),
        paidAt: balance.providerCreatedAt
      });
      await tx.insert(orderItems).values({
        orderId, titleId: title.id, titleSnapshot: title.title,
        creatorNameSnapshot: title.creatorName, format: 'prose', currency: 'USD',
        unitSubtotalMinor: 100, taxMinor: 0, totalMinor: 100,
        stripeLineItemId: `li_financial_recheck_link_${suffix}`
      });
      const [payment] = await tx.insert(payments).values({
        orderId, stripePaymentIntentId: `pi_financial_recheck_link_${suffix}`,
        stripeLatestChargeId: providerChargeId, status: 'succeeded',
        amountMinor: 100, currency: 'USD', paymentMethodCategory: 'card',
        paidAt: balance.providerCreatedAt
      }).returning();
      if (!payment) throw new Error('Expected routing-recheck payment');
      await queueFinancialSourceFromEvent(tx, {
        sourceKind: 'payment', sourceId: payment.id,
        providerEventId: `evt_financial_recheck_link_${suffix}`,
        projectionGraphSourceIds: [payment.id]
      });
    });
  } finally {
    releaseRoutingRecheck.resolve();
  }

  await expect(replay).rejects.toMatchObject({
    name: 'RetryableFinancialError', safeCode: 'state_changed'
  });
  await expect(databaseClient.db.select().from(financialAllocationSets).where(
    eq(financialAllocationSets.balanceTransactionId, balance.id)
  )).resolves.toHaveLength(0);
});

it('supersedes an unrelated account allocation when a bookstore charge link arrives later', async () => {
  const suffix = randomUUID();
  const providerChargeId = `ch_financial_late_link_${suffix}`;
  const payout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: `po_financial_late_link_${suffix}`,
    balanceTransactionId: null
  }), { correlationId: `late-link-payout-${suffix}` });
  const chargeBalance = balanceTransactionSnapshotFixture({
    id: `txn_financial_late_link_${suffix}`,
    sourceFamily: 'charge', sourceId: providerChargeId,
    amountMinor: 100, feeMinor: 10, netMinor: 90,
    feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 10, currency: 'USD' }]
  });
  const staged = await stageBalanceTransaction(databaseClient.db, chargeBalance, {
    correlationId: `late-link-balance-${suffix}`
  });
  const run = await createPublishableGeneration(
    payout.payoutId,
    payout.generation,
    [staged.balanceTransactionId],
    `late-link-${suffix}`
  );
  await publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId,
    runId: run.id,
    expectedGeneration: payout.generation,
    correlationId: `late-link-publish-${suffix}`
  });
  const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
    eq(stripeBalanceTransactions.id, staged.balanceTransactionId)
  );
  if (!balance) throw new Error('Expected unrelated payout member');
  await runActiveParentClassificationJob(
    balance.id,
    `late-link-account-${suffix}`
  );
  await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
    balanceTransactionIds: [balance.id]
  })).resolves.toEqual([
    expect.objectContaining({
      status: 'complete', basis: 'gross_amount', scope: 'account', expectedEffectMinor: 100
    }),
    expect.objectContaining({
      status: 'complete', basis: 'fee', scope: 'account', expectedEffectMinor: -10
    })
  ]);
  const accountTips = await databaseClient.db.select().from(financialAllocationSets).where(
    eq(financialAllocationSets.balanceTransactionId, balance.id)
  );
  expect(accountTips).toHaveLength(2);
  expect(accountTips).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceKind: 'adjustment', sourceInternalId: balance.id })
  ]));

  const [guest] = await ownerDatabaseClient.db.insert(guestIdentities).values({
    email: `late-link-${suffix}@example.com`
  }).returning();
  const [title] = await ownerDatabaseClient.db.insert(titles).values({
    slug: `late-link-${suffix}`, title: 'Late linked title',
    description: 'Late linked description', creatorName: 'Late linked creator',
    format: 'prose', priceMinor: 100, currency: 'USD', visibility: 'private'
  }).returning();
  if (!guest || !title) throw new Error('Expected late-link owner rows');
  const orderId = randomUUID();
  const paidAt = balance.providerCreatedAt;
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId, status: 'paid', guestIdentityId: guest.id, purchaseEmail: guest.email,
    currency: 'USD', subtotalMinor: 100, taxMinor: 0, totalMinor: 100,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'b'.repeat(64),
    stripeCheckoutSessionId: `cs_financial_late_link_${suffix}`,
    statusTokenSha256: 'c'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-12T00:30:00.000Z'),
    paidAt
  });
  await ownerDatabaseClient.db.insert(orderItems).values({
    orderId, titleId: title.id, titleSnapshot: title.title,
    creatorNameSnapshot: title.creatorName, format: 'prose', currency: 'USD',
    unitSubtotalMinor: 100, taxMinor: 0, totalMinor: 100,
    stripeLineItemId: `li_financial_late_link_${suffix}`
  });
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId, stripePaymentIntentId: `pi_financial_late_link_${suffix}`,
    stripeLatestChargeId: providerChargeId, status: 'succeeded',
    amountMinor: 100, currency: 'USD', paymentMethodCategory: 'card',
    paidAt
  }).returning();
  if (!payment) throw new Error('Expected late-linked payment');

  const stripe = createFixtureStripeGateway();
  stripe.harness.setPayment(paymentSnapshotFixture({
    paymentIntentId: payment.stripePaymentIntentId,
    metadataOrderId: orderId,
    latestChargeId: providerChargeId,
    amountMinor: 100,
    currency: 'usd',
    paidAt
  }));
  stripe.harness.setCharge(chargeSnapshotFixture({
    id: providerChargeId,
    paymentIntentId: payment.stripePaymentIntentId,
    amountMinor: 100,
    currency: 'USD',
    balanceTransactionId: chargeBalance.id,
    createdAt: paidAt
  }));
  stripe.harness.setBalanceTransaction(chargeBalance);
  await expect(reconcilePaymentFinancialSource(databaseClient.db, stripe.gateway, {
    paymentId: payment.id,
    correlationId: `late-link-title-${suffix}`
  }, new AbortController().signal)).resolves.toMatchObject({
    status: 'reconciled', sourceKind: 'payment', sourceId: payment.id
  });
  const current = await loadCurrentEffectiveAllocationProjection(databaseClient.db, {
    balanceTransactionIds: [balance.id]
  });
  expect(current).toEqual([
    expect.objectContaining({ status: 'complete', basis: 'gross_amount', scope: 'title' }),
    expect.objectContaining({ status: 'complete', basis: 'fee', scope: 'title' })
  ]);
  const history = await databaseClient.db.select().from(financialAllocationSets).where(
    eq(financialAllocationSets.balanceTransactionId, balance.id)
  );
  expect(history).toHaveLength(4);
  const titleTips = history.filter((set) => set.sourceKind === 'payment');
  expect(titleTips).toHaveLength(2);
  expect(titleTips.every((set) => set.sourceInternalId === payment.id &&
    accountTips.some((account) => account.id === set.supersedesSetId))).toBe(true);
});

it('supersedes a refund-failure account fallback with title reversal lineage after late linkage', async () => {
  const suffix = randomUUID();
  const providerRefundId = `re_financial_late_failure_${suffix}`;
  const primaryAt = new Date('2026-08-12T01:00:00.000Z');
  const failureAt = new Date('2026-08-12T02:00:00.000Z');
  const primarySnapshot = balanceTransactionSnapshotFixture({
    id: `txn_financial_late_refund_${suffix}`,
    sourceFamily: 'refund', sourceId: providerRefundId,
    rawType: 'refund', reportingCategory: 'refund',
    amountMinor: -100, feeMinor: 0, netMinor: -100, createdAt: primaryAt,
    feeDetails: []
  });
  const failureSnapshot = balanceTransactionSnapshotFixture({
    id: `txn_financial_late_refund_failure_${suffix}`,
    sourceFamily: 'refund', sourceId: providerRefundId,
    rawType: 'refund_failure', reportingCategory: 'refund_failure',
    amountMinor: 100, feeMinor: 0, netMinor: 100, createdAt: failureAt,
    feeDetails: []
  });
  const staged = await Promise.all([primarySnapshot, failureSnapshot].map((snapshot) =>
    stageBalanceTransaction(databaseClient.db, snapshot, {
      correlationId: `late-refund-stage-${snapshot.id}`
    })
  ));
  const payout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: `po_financial_late_refund_${suffix}`, balanceTransactionId: null
  }), { correlationId: `late-refund-payout-${suffix}` });
  const run = await createPublishableGeneration(
    payout.payoutId, payout.generation,
    staged.map((row) => row.balanceTransactionId), `late-refund-${suffix}`
  );
  await publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId, runId: run.id, expectedGeneration: payout.generation,
    correlationId: `late-refund-publish-${suffix}`
  });
  const balances = await databaseClient.db.select().from(stripeBalanceTransactions).where(
    inArray(stripeBalanceTransactions.id, staged.map((row) => row.balanceTransactionId))
  );
  const primary = balances.find((row) => row.providerId === primarySnapshot.id);
  const failure = balances.find((row) => row.providerId === failureSnapshot.id);
  if (!primary || !failure) throw new Error('Expected late-link refund balances');
  const replayAtC2A2 = (balance: typeof failure, correlationId: string) =>
    databaseClient.db.transaction((tx) => replayFinancialClassificationLocked(tx, {
      subjectType: 'balance_transaction', subjectId: balance.id,
      sourceFingerprintSha256: balance.fingerprintSha256,
      ...C2_A2_CLASSIFICATION_IMPLEMENTATION,
      correlationId
    }));

  await runActiveParentClassificationJob(
    failure.id,
    `late-refund-account-${suffix}`
  );
  const fallbackSets = await databaseClient.db.select().from(financialAllocationSets).where(
    eq(financialAllocationSets.balanceTransactionId, failure.id)
  );
  expect(fallbackSets).toHaveLength(2);
  expect(fallbackSets.every((set) => set.sourceKind === 'adjustment' &&
    set.sourceInternalId === failure.id && set.scope === 'account' &&
    set.reversalOfSetId === null)).toBe(true);

  const purchase = await createLateLinkedPayment(`late-refund-${suffix}`,
    new Date('2026-08-12T00:00:00.000Z'));
  const [refund] = await databaseClient.db.insert(refunds).values({
    paymentId: purchase.payment.id, stripeRefundId: providerRefundId, status: 'failed',
    amountMinor: 100, currency: 'USD', reason: 'requested_by_customer',
    providerCreatedAt: primaryAt, allocationStatus: 'finalized'
  }).returning();
  if (!refund) throw new Error('Expected late-link refund');
  const [allocation] = await databaseClient.db.insert(refundAllocations).values({
    refundId: refund.id, orderItemId: purchase.item.id, amountMinor: 100,
    source: 'automatic'
  }).returning();
  if (!allocation) throw new Error('Expected late-link refund allocation');
  await databaseClient.db.insert(refundAllocationComponents).values({
    refundAllocationId: allocation.id, refundId: refund.id,
    orderItemId: purchase.item.id, subtotalMinor: 100, taxMinor: 0,
    totalMinor: 100, currency: 'USD'
  });

  await databaseClient.db.transaction((tx) => queueFinancialSourceFromEvent(tx, {
    sourceKind: 'refund', sourceId: refund.id,
    providerEventId: `evt_financial_late_refund_${suffix}`,
    projectionGraphSourceIds: [refund.id]
  }));
  await runActiveParentClassificationJob(
    primary.id,
    `late-refund-primary-${suffix}`
  );
  await runActiveParentClassificationJob(
    failure.id,
    `late-refund-failure-${suffix}`
  );
  const history = await databaseClient.db.select().from(financialAllocationSets).where(
    inArray(financialAllocationSets.balanceTransactionId, [primary.id, failure.id])
  );
  const linked = history.filter((set) => set.sourceKind === 'refund' &&
    set.sourceInternalId === refund.id);
  expect(linked).toHaveLength(4);
  const primaryGross = linked.find((set) => set.balanceTransactionId === primary.id &&
    set.basis === 'gross_amount');
  const failureGross = linked.find((set) => set.balanceTransactionId === failure.id &&
    set.basis === 'gross_amount');
  const fallbackGross = fallbackSets.find((set) => set.basis === 'gross_amount');
  if (!primaryGross || !failureGross || !fallbackGross) {
    throw new Error('Expected refund reversal lineage');
  }
  expect(primaryGross).toMatchObject({ scope: 'title', supersedesSetId: null,
    reversalOfSetId: null });
  expect(failureGross).toMatchObject({
    scope: 'title', supersedesSetId: fallbackGross.id, reversalOfSetId: primaryGross.id
  });
  const current = await loadCurrentEffectiveAllocationProjection(databaseClient.db, {
    balanceTransactionIds: [primary.id, failure.id]
  });
  expect(current).toHaveLength(4);
  expect(current.every((projection) => projection.status === 'complete' &&
    projection.scope === 'title' &&
    !fallbackSets.some((fallback) => fallback.id === projection.baseSetId))).toBe(true);
  expect(current).toEqual(expect.arrayContaining([
    expect.objectContaining({ balanceTransactionId: primary.id, basis: 'gross_amount',
      baseSetId: primaryGross.id }),
    expect.objectContaining({ balanceTransactionId: failure.id, basis: 'gross_amount',
      baseSetId: failureGross.id })
  ]));

  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as Parameters<typeof processFinancialScanJob>[0]['gateway'];
  await processFinancialScanJob({
    database: databaseClient.db, gateway, runtimeMode: 'disabled'
  }, {
    payload: { kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2' },
    correlationId: `late-refund-c2-root-${suffix}`,
    signal: new AbortController().signal
  });
  await replayAtC2A2(primary, `late-refund-c2-primary-${suffix}`);
  await replayAtC2A2(failure, `late-refund-c2-failure-${suffix}`);
  await expect(replayAtC2A2(
    failure, `late-refund-c2-exact-${suffix}`
  )).resolves.toMatchObject({
    status: 'unchanged', subjectId: failure.id
  });
  const c2RefundSets = (await databaseClient.db.select().from(financialAllocationSets).where(
    inArray(financialAllocationSets.balanceTransactionId, [primary.id, failure.id])
  )).filter((set) => set.sourceKind === 'refund' && set.sourceInternalId === refund.id &&
    set.classifierVersion === 2 && set.algorithmVersion === 2);
  const c2PrimaryGross = c2RefundSets.find((set) =>
    set.balanceTransactionId === primary.id && set.basis === 'gross_amount');
  const c2FailureGross = c2RefundSets.find((set) =>
    set.balanceTransactionId === failure.id && set.basis === 'gross_amount');
  expect(c2RefundSets).toHaveLength(4);
  expect(c2PrimaryGross).toMatchObject({
    supersedesSetId: primaryGross.id, reversalOfSetId: null
  });
  expect(c2FailureGross).toMatchObject({
    supersedesSetId: failureGross.id, reversalOfSetId: c2PrimaryGross!.id
  });
});

it('supersedes a dispute-reinstatement account fallback with title reversal lineage after late linkage', async () => {
  const suffix = randomUUID();
  const providerDisputeId = `dp_financial_late_reinstate_${suffix}`;
  const withdrawalAt = new Date('2026-08-12T03:00:00.000Z');
  const reinstatementAt = new Date('2026-08-12T04:00:00.000Z');
  const withdrawalSnapshot = balanceTransactionSnapshotFixture({
    id: `txn_financial_late_dispute_${suffix}`,
    sourceFamily: 'dispute', sourceId: providerDisputeId,
    rawType: 'adjustment', reportingCategory: 'dispute',
    amountMinor: -100, feeMinor: 0, netMinor: -100, createdAt: withdrawalAt,
    feeDetails: []
  });
  const reinstatementSnapshot = balanceTransactionSnapshotFixture({
    id: `txn_financial_late_reinstatement_${suffix}`,
    sourceFamily: 'dispute', sourceId: providerDisputeId,
    rawType: 'adjustment', reportingCategory: 'dispute_reversal',
    amountMinor: 100, feeMinor: 0, netMinor: 100, createdAt: reinstatementAt,
    feeDetails: []
  });
  const staged = await Promise.all([withdrawalSnapshot, reinstatementSnapshot].map((snapshot) =>
    stageBalanceTransaction(databaseClient.db, snapshot, {
      correlationId: `late-dispute-stage-${snapshot.id}`
    })
  ));
  const payout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
    id: `po_financial_late_dispute_${suffix}`, balanceTransactionId: null
  }), { correlationId: `late-dispute-payout-${suffix}` });
  const run = await createPublishableGeneration(
    payout.payoutId, payout.generation,
    staged.map((row) => row.balanceTransactionId), `late-dispute-${suffix}`
  );
  await publishPayoutMembership(databaseClient.db, {
    payoutId: payout.payoutId, runId: run.id, expectedGeneration: payout.generation,
    correlationId: `late-dispute-publish-${suffix}`
  });
  const balances = await databaseClient.db.select().from(stripeBalanceTransactions).where(
    inArray(stripeBalanceTransactions.id, staged.map((row) => row.balanceTransactionId))
  );
  const withdrawal = balances.find((row) => row.providerId === withdrawalSnapshot.id);
  const reinstatement = balances.find((row) => row.providerId === reinstatementSnapshot.id);
  if (!withdrawal || !reinstatement) throw new Error('Expected late-link dispute balances');
  const replayAtC2A2 = (balance: typeof reinstatement, correlationId: string) =>
    databaseClient.db.transaction((tx) => replayFinancialClassificationLocked(tx, {
      subjectType: 'balance_transaction', subjectId: balance.id,
      sourceFingerprintSha256: balance.fingerprintSha256,
      ...C2_A2_CLASSIFICATION_IMPLEMENTATION,
      correlationId
    }));

  await runActiveParentClassificationJob(
    reinstatement.id,
    `late-dispute-account-${suffix}`
  );
  const fallbackSets = await databaseClient.db.select().from(financialAllocationSets).where(
    eq(financialAllocationSets.balanceTransactionId, reinstatement.id)
  );
  expect(fallbackSets).toHaveLength(2);
  expect(fallbackSets.every((set) => set.sourceKind === 'adjustment' &&
    set.sourceInternalId === reinstatement.id && set.scope === 'account' &&
    set.reversalOfSetId === null)).toBe(true);

  const purchase = await createLateLinkedPayment(`late-dispute-${suffix}`,
    new Date('2026-08-12T00:00:00.000Z'));
  const [dispute] = await databaseClient.db.insert(disputes).values({
    paymentId: purchase.payment.id, stripeDisputeId: providerDisputeId, status: 'won',
    amountMinor: 100, currency: 'USD', reason: 'fraudulent',
    providerCreatedAt: withdrawalAt, providerUpdatedAt: reinstatementAt
  }).returning();
  if (!dispute) throw new Error('Expected late-link dispute');

  await databaseClient.db.transaction((tx) => queueFinancialSourceFromEvent(tx, {
    sourceKind: 'dispute', sourceId: dispute.id,
    providerEventId: `evt_financial_late_dispute_${suffix}`,
    projectionGraphSourceIds: [dispute.id]
  }));
  await runActiveParentClassificationJob(
    withdrawal.id,
    `late-dispute-withdrawal-${suffix}`
  );
  await runActiveParentClassificationJob(
    reinstatement.id,
    `late-dispute-reinstatement-${suffix}`
  );
  const history = await databaseClient.db.select().from(financialAllocationSets).where(
    inArray(financialAllocationSets.balanceTransactionId, [withdrawal.id, reinstatement.id])
  );
  const linked = history.filter((set) => set.sourceKind === 'dispute' &&
    set.sourceInternalId === dispute.id);
  expect(linked).toHaveLength(4);
  const withdrawalGross = linked.find((set) => set.balanceTransactionId === withdrawal.id &&
    set.basis === 'gross_amount');
  const reinstatementGross = linked.find((set) =>
    set.balanceTransactionId === reinstatement.id && set.basis === 'gross_amount');
  const fallbackGross = fallbackSets.find((set) => set.basis === 'gross_amount');
  if (!withdrawalGross || !reinstatementGross || !fallbackGross) {
    throw new Error('Expected dispute reversal lineage');
  }
  expect(withdrawalGross).toMatchObject({ scope: 'title', supersedesSetId: null,
    reversalOfSetId: null });
  expect(reinstatementGross).toMatchObject({
    scope: 'title', supersedesSetId: fallbackGross.id, reversalOfSetId: withdrawalGross.id
  });
  const current = await loadCurrentEffectiveAllocationProjection(databaseClient.db, {
    balanceTransactionIds: [withdrawal.id, reinstatement.id]
  });
  expect(current).toHaveLength(4);
  expect(current.every((projection) => projection.status === 'complete' &&
    projection.scope === 'title' &&
    !fallbackSets.some((fallback) => fallback.id === projection.baseSetId))).toBe(true);
  expect(current).toEqual(expect.arrayContaining([
    expect.objectContaining({ balanceTransactionId: withdrawal.id, basis: 'gross_amount',
      baseSetId: withdrawalGross.id }),
    expect.objectContaining({ balanceTransactionId: reinstatement.id, basis: 'gross_amount',
      baseSetId: reinstatementGross.id })
  ]));

  const gateway = new Proxy({}, {
    get: () => () => { throw new Error('disabled replay must not call the provider'); }
  }) as Parameters<typeof processFinancialScanJob>[0]['gateway'];
  await processFinancialScanJob({
    database: databaseClient.db, gateway, runtimeMode: 'disabled'
  }, {
    payload: { kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2' },
    correlationId: `late-dispute-c2-root-${suffix}`,
    signal: new AbortController().signal
  });
  await replayAtC2A2(withdrawal, `late-dispute-c2-withdrawal-${suffix}`);
  await replayAtC2A2(reinstatement, `late-dispute-c2-reinstatement-${suffix}`);
  await expect(replayAtC2A2(
    reinstatement, `late-dispute-c2-exact-${suffix}`
  )).resolves.toMatchObject({ status: 'unchanged', subjectId: reinstatement.id });
  const c2DisputeSets = (await databaseClient.db.select().from(financialAllocationSets).where(
    inArray(financialAllocationSets.balanceTransactionId, [withdrawal.id, reinstatement.id])
  )).filter((set) => set.sourceKind === 'dispute' && set.sourceInternalId === dispute.id &&
    set.classifierVersion === 2 && set.algorithmVersion === 2);
  const c2WithdrawalGross = c2DisputeSets.find((set) =>
    set.balanceTransactionId === withdrawal.id && set.basis === 'gross_amount');
  const c2ReinstatementGross = c2DisputeSets.find((set) =>
    set.balanceTransactionId === reinstatement.id && set.basis === 'gross_amount');
  expect(c2DisputeSets).toHaveLength(4);
  expect(c2WithdrawalGross).toMatchObject({
    supersedesSetId: withdrawalGross.id, reversalOfSetId: null
  });
  expect(c2ReinstatementGross).toMatchObject({
    supersedesSetId: reinstatementGross.id, reversalOfSetId: c2WithdrawalGross!.id
  });
});

it('runs one bounded provider page through staging and publication, then replays without a new run', async () => {
  const suffix = randomUUID();
  const providerPayoutId = `po_financial_service_${suffix}`;
  const providerBalanceId = `txn_financial_service_${suffix}`;
  const fixture = createFixtureStripeGateway();
  fixture.harness.setPayout(payoutSnapshotFixture({
    id: providerPayoutId,
    balanceTransactionId: null
  }));
  fixture.harness.setBalanceTransactionsForPayout(providerPayoutId, [
    balanceTransactionSnapshotFixture({
      id: providerBalanceId,
      sourceId: null,
      sourceFamily: 'unknown',
      rawType: 'adjustment',
      reportingCategory: 'other_adjustment'
    })
  ]);
  const payload = {
    providerPayoutId,
    trigger: { kind: 'event' as const, providerEventId: `evt_financial_service_${suffix}` }
  };

  const first = await reconcileFinancialPayout({
    database: databaseClient.db,
    gateway: fixture.gateway
  }, {
    payload,
    correlationId: `payout-service-${suffix}`,
    signal: new AbortController().signal
  });
  expect(first).toMatchObject({ status: 'published', generation: 1, membershipCount: 1 });

  const replay = await reconcileFinancialPayout({
    database: databaseClient.db,
    gateway: fixture.gateway
  }, {
    payload,
    correlationId: `payout-service-replay-${suffix}`,
    signal: new AbortController().signal
  });
  expect(replay).toEqual(first);
  const [payout] = await databaseClient.db.select().from(stripePayouts).where(
    eq(stripePayouts.providerId, providerPayoutId)
  );
  expect(payout).toMatchObject({ financialGeneration: 1 });
  expect(await databaseClient.db.select().from(payoutImportRuns).where(
    eq(payoutImportRuns.payoutId, payout!.id)
  )).toHaveLength(1);
});

it('retries a stale provider snapshot instead of poisoning newer payout evidence', async () => {
  const suffix = randomUUID();
  const providerPayoutId = `po_financial_stale_snapshot_${suffix}`;
  const failureProviderBalanceId = `txn_financial_stale_failure_${suffix}`;
  const staleSnapshot = payoutSnapshotFixture({
    id: providerPayoutId,
    balanceTransactionId: null
  });
  const currentSnapshot = payoutSnapshotFixture({
    id: providerPayoutId,
    status: 'failed',
    balanceTransactionId: null,
    failureBalanceTransactionId: failureProviderBalanceId,
    originalPayoutId: `po_financial_stale_original_${suffix}`,
    safeFailureCode: 'provider_failed'
  });
  let releaseStale!: (snapshot: typeof staleSnapshot) => void;
  const staleResponse = new Promise<typeof staleSnapshot>((resolve) => {
    releaseStale = resolve;
  });
  let markStaleRequested!: () => void;
  const staleRequested = new Promise<void>((resolve) => {
    markStaleRequested = resolve;
  });
  let payoutRetrievals = 0;
  const gateway = {
    async retrievePayout() {
      payoutRetrievals += 1;
      if (payoutRetrievals === 1) {
        markStaleRequested();
        return staleResponse;
      }
      return currentSnapshot;
    },
    async retrieveBalanceTransaction() {
      return balanceTransactionSnapshotFixture({
        id: failureProviderBalanceId,
        sourceFamily: 'payout',
        sourceId: providerPayoutId,
        rawType: 'payout_failure',
        reportingCategory: 'payout'
      });
    }
  } as unknown as Parameters<typeof reconcileFinancialPayout>[0]['gateway'];
  const payload = {
    providerPayoutId,
    trigger: { kind: 'event' as const, providerEventId: `evt_financial_stale_${suffix}` }
  };

  const stale = reconcileFinancialPayout({ database: databaseClient.db, gateway }, {
    payload,
    correlationId: `payout-stale-snapshot-old-${suffix}`,
    signal: new AbortController().signal
  });
  await staleRequested;
  await expect(reconcileFinancialPayout({ database: databaseClient.db, gateway }, {
    payload,
    correlationId: `payout-stale-snapshot-current-${suffix}`,
    signal: new AbortController().signal
  })).resolves.toMatchObject({ status: 'abandoned', generation: 0 });

  releaseStale(staleSnapshot);
  await expect(stale).rejects.toMatchObject({
    name: 'RetryableFinancialError', safeCode: 'state_changed'
  });
  await expect(reconcileFinancialPayout({ database: databaseClient.db, gateway }, {
    payload,
    correlationId: `payout-stale-snapshot-retry-${suffix}`,
    signal: new AbortController().signal
  })).resolves.toMatchObject({ status: 'abandoned', generation: 0 });

  const [persisted] = await databaseClient.db.select().from(stripePayouts).where(
    eq(stripePayouts.providerId, providerPayoutId)
  );
  expect(persisted).toMatchObject({
    status: 'failed',
    financialGeneration: 0,
    originalProviderPayoutId: currentSnapshot.originalPayoutId,
    safeFailureCode: 'provider_failed'
  });
  expect(persisted?.failureBalanceTransactionId).not.toBeNull();
  expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
    eq(financialReconciliationIssues.resourceId, persisted!.id),
    eq(financialReconciliationIssues.safeCode, 'immutable_mismatch')
  ))).toHaveLength(0);
  expect(await databaseClient.db.select().from(auditEvents).where(and(
    eq(auditEvents.resourceId, persisted!.id),
    eq(auditEvents.action, 'financial.payout.imported')
  ))).toHaveLength(1);
  expect(payoutRetrievals).toBe(3);
});

it('fails a competing publication atomically and resolves it on a corrected first set', async () => {
  const first = await createPublishableRun(randomUUID());
  await publishPayoutMembership(databaseClient.db, {
    payoutId: first.payout.payoutId,
    runId: first.run.id,
    expectedGeneration: 0,
    correlationId: `payout-conflict-first-${first.run.id}`
  });
  const second = await createPublishableRun(randomUUID(), first.balanceTransactionId);

  await expect(publishPayoutMembership(databaseClient.db, {
    payoutId: second.payout.payoutId,
    runId: second.run.id,
    expectedGeneration: 0,
    correlationId: `payout-conflict-second-${second.run.id}`
  })).rejects.toMatchObject({
    name: 'PermanentFinancialError', safeCode: 'payout_membership_conflict'
  });

  expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions).where(
    eq(stripePayoutBalanceTransactions.balanceTransactionId, first.balanceTransactionId)
  )).toEqual([expect.objectContaining({ payoutId: first.payout.payoutId })]);
  expect(await databaseClient.db.select().from(payoutImportRuns).where(
    eq(payoutImportRuns.id, second.run.id)
  )).toEqual([expect.objectContaining({
    state: 'exception', safeOutcome: 'payout_membership_conflict'
  })]);
  expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
    eq(financialReconciliationIssues.resourceId, second.payout.payoutId),
    eq(financialReconciliationIssues.safeCode, 'payout_membership_conflict')
  ))).toEqual([expect.objectContaining({ state: 'open', impact: 'exception' })]);

  const correctedGeneration = await stagePayoutSnapshot(databaseClient.db, {
    ...second.payoutSnapshot,
    arrivalAt: new Date(second.payoutSnapshot.arrivalAt.getTime() + 60_000)
  }, { correlationId: `payout-conflict-corrected-refresh-${second.run.id}` });
  const corrected = await createPublishableGeneration(
    second.payout.payoutId,
    correctedGeneration.generation,
    [],
    `${second.run.id}-corrected`
  );
  await expect(publishPayoutMembership(workerDatabaseClient.db, {
    payoutId: second.payout.payoutId,
    runId: corrected.id,
    expectedGeneration: correctedGeneration.generation,
    correlationId: `payout-conflict-corrected-publish-${second.run.id}`
  })).resolves.toEqual({
    generation: correctedGeneration.generation + 1,
    membershipCount: 0
  });
  expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
    eq(financialReconciliationIssues.resourceId, second.payout.payoutId),
    eq(financialReconciliationIssues.safeCode, 'payout_membership_conflict')
  ))).toEqual([expect.objectContaining({ state: 'resolved' })]);
});

it('converges concurrent publishers on one membership generation and one audit', async () => {
  const fixture = await createPublishableRun(randomUUID());
  const requests = ['a', 'b'].map((label) => publishPayoutMembership(databaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: fixture.run.id,
    expectedGeneration: 0,
    correlationId: `payout-concurrent-${label}-${fixture.run.id}`
  }));

  await expect(Promise.all(requests)).resolves.toEqual([
    { generation: 1, membershipCount: 1 },
    { generation: 1, membershipCount: 1 }
  ]);
  expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions).where(
    eq(stripePayoutBalanceTransactions.payoutId, fixture.payout.payoutId)
  )).toHaveLength(1);
  expect(await databaseClient.db.select().from(auditEvents).where(and(
    eq(auditEvents.resourceId, fixture.payout.payoutId),
    eq(auditEvents.action, 'financial.payout.membership_published')
  ))).toHaveLength(1);
  expect(await databaseClient.db.select().from(jobs).where(
    eq(jobs.deduplicationKey, `financial:payout-impact:${fixture.payout.payoutId}:1`)
  )).toHaveLength(1);
});

it('orders payout lifecycle staging before membership publication without a lock cycle', async () => {
  const fixture = await createPublishableRun(randomUUID());
  const reachedPayoutLock = deferred<void>();
  const releasePayoutLock = deferred<void>();
  const staging = stagePayoutSnapshot(databasePausedBeforeAdvisory(
    `pale-orbit:financial:payout:${fixture.payoutSnapshot.id}`,
    reachedPayoutLock,
    releasePayoutLock
  ), {
    ...fixture.payoutSnapshot,
    arrivalAt: new Date(fixture.payoutSnapshot.arrivalAt.getTime() + 60_000)
  }, { correlationId: `payout-stage-publish-order-${fixture.run.id}` });
  await reachedPayoutLock.promise;
  const publication = publishPayoutMembership(databaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: fixture.run.id,
    expectedGeneration: fixture.payout.generation,
    correlationId: `payout-stage-publish-publication-${fixture.run.id}`
  });
  const blockers = await waitForBlockedAdvisory();
  releasePayoutLock.resolve();

  await expect(staging).resolves.toMatchObject({ changed: true, generation: 1 });
  await expect(publication).rejects.toMatchObject({
    name: 'RetryableFinancialError', safeCode: 'state_changed'
  });
  expect(blockers).toEqual(expect.arrayContaining([expect.any(Number)]));
}, 15_000);

it('publishes payout membership after exact balance staging without an enrollment-to-BT deadlock', async () => {
  const fixture = await createPublishableRun(randomUUID());
  const reachedBalanceLock = deferred<void>();
  const releaseBalanceLock = deferred<void>();
  const staging = stageBalanceTransaction(databasePausedBeforeAdvisory(
    `pale-orbit:financial:balance-transaction:${fixture.balanceSnapshot.id}`,
    reachedBalanceLock,
    releaseBalanceLock
  ), structuredClone(fixture.balanceSnapshot), {
    correlationId: `payout-balance-publish-order-${fixture.run.id}`
  });
  await reachedBalanceLock.promise;
  const publication = publishPayoutMembership(databaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: fixture.run.id,
    expectedGeneration: fixture.payout.generation,
    correlationId: `payout-balance-publish-publication-${fixture.run.id}`
  });
  const blockers = await waitForBlockedAdvisory();
  releaseBalanceLock.resolve();

  await expect(Promise.all([staging, publication])).resolves.toEqual([
    expect.objectContaining({
      disposition: 'unchanged', balanceTransactionId: fixture.balanceTransactionId
    }),
    { generation: 1, membershipCount: 1 }
  ]);
  expect(blockers).toEqual(expect.arrayContaining([expect.any(Number)]));
}, 15_000);

it('rejects a stale publishable run after a paid payout advances to failed', async () => {
  const fixture = await createPublishableRun(randomUUID());
  await stagePayoutSnapshot(databaseClient.db, {
    ...fixture.payoutSnapshot,
    status: 'failed',
    safeFailureCode: 'provider_failed'
  }, { correlationId: `payout-stale-failed-${fixture.run.id}` });

  await expect(publishPayoutMembership(databaseClient.db, {
    payoutId: fixture.payout.payoutId,
    runId: fixture.run.id,
    expectedGeneration: 0,
    correlationId: `payout-stale-publish-${fixture.run.id}`
  })).rejects.toMatchObject({ name: 'RetryableFinancialError', safeCode: 'state_changed' });
  expect(await databaseClient.db.select().from(payoutImportRuns).where(
    eq(payoutImportRuns.id, fixture.run.id)
  )).toEqual([expect.objectContaining({ state: 'abandoned', safeOutcome: 'payout_changed' })]);
  expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions).where(
    eq(stripePayoutBalanceTransactions.payoutId, fixture.payout.payoutId)
  )).toHaveLength(0);
  expect(await databaseClient.db.select().from(auditEvents).where(and(
    eq(auditEvents.resourceId, fixture.payout.payoutId),
    eq(auditEvents.action, 'financial.payout.membership_published')
  ))).toHaveLength(0);
});
