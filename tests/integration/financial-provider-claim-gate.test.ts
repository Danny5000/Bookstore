import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { persistFinancialAllocationPlanLocked } from '$lib/server/commerce/financial/allocations/repository';
import {
  createFinancialClassificationSubjectJob,
  createFinancialSourceEventJob
} from '$lib/server/commerce/financial/jobs';
import { stageBalanceTransaction } from '$lib/server/commerce/financial/ledger';
import { replayFinancialClassification } from '$lib/server/commerce/financial/rebase';
import { reconcilePaymentFinancialSource } from '$lib/server/commerce/financial/sources/payment';
import {
  commitFinancialScanPage,
  finalizeFinancialReplay,
  startOrResumeFinancialScan
} from '$lib/server/commerce/financial/scans/repository';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import {
  financialAllocationSets,
  guestIdentities,
  jobs,
  orderItems,
  orders,
  payments,
  titles
} from '$lib/server/db/schema';
import { createPostgresJobRepository, enqueueJob } from '$lib/server/jobs/repository';
import { applicationConfig, databaseClient } from './database';

const PROVIDER_SNAPSHOT = {
  livemode: false,
  sourceFamily: 'charge' as const,
  rawType: 'charge',
  reportingCategory: 'charge',
  balanceType: 'payments',
  amountMinor: 100,
  feeMinor: 0,
  netMinor: 100,
  currency: 'USD',
  status: 'available' as const,
  createdAt: new Date('2026-08-14T12:00:00.000Z'),
  availableAt: new Date('2026-08-14T13:00:00.000Z'),
  exchangeRate: null,
  exchangeSourceCurrency: null,
  exchangeTargetCurrency: null,
  feeDetails: []
};

async function providerProjectionFixture() {
  const suffix = randomUUID().replaceAll('-', '');
  const titleId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const paymentIntentId = `pi_claim_gate_${suffix}`;
  const chargeId = `ch_claim_gate_${suffix}`;
  const providerTransactionId = `txn_claim_gate_${suffix}`;
  const [guest] = await databaseClient.db.insert(guestIdentities).values({
    email: `claim-gate-${suffix}@example.com`
  }).returning();
  if (!guest) throw new Error('Expected provider claim-gate guest');
  await databaseClient.db.insert(titles).values({
    id: titleId,
    slug: `claim-gate-${suffix}`,
    title: 'Claim gate title',
    description: 'Rolling deployment claim gate fixture',
    creatorName: 'Claim gate creator',
    format: 'prose',
    priceMinor: 100,
    currency: 'USD',
    visibility: 'private'
  });
  await databaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    guestIdentityId: guest.id,
    purchaseEmail: guest.email,
    currency: 'USD',
    subtotalMinor: 100,
    taxMinor: 0,
    totalMinor: 100,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: `cs_claim_gate_${suffix}`,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-14T12:30:00.000Z'),
    paidAt: PROVIDER_SNAPSHOT.createdAt
  });
  await databaseClient.db.insert(orderItems).values({
    id: orderItemId,
    orderId,
    titleId,
    titleSnapshot: 'Claim gate title',
    creatorNameSnapshot: 'Claim gate creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 100,
    taxMinor: 0,
    totalMinor: 100,
    stripeLineItemId: `li_claim_gate_${suffix}`
  });
  const [payment] = await databaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: paymentIntentId,
    stripeLatestChargeId: chargeId,
    status: 'succeeded',
    amountMinor: 100,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt: PROVIDER_SNAPSHOT.createdAt,
    financialEvidenceStatus: 'fee_reconciled'
  }).returning();
  if (!payment) throw new Error('Expected provider claim-gate payment');

  const snapshot = {
    ...PROVIDER_SNAPSHOT,
    id: providerTransactionId,
    sourceId: chargeId
  };
  const staged = await stageBalanceTransaction(databaseClient.db, snapshot, {
    correlationId: `claim-gate-stage-c1-${suffix}`
  });
  const fingerprintResult = await databaseClient.pool.query<{ fingerprint_sha256: string }>(
    'select fingerprint_sha256 from stripe_balance_transactions where id=$1',
    [staged.balanceTransactionId]
  );
  const fingerprint = fingerprintResult.rows[0]?.fingerprint_sha256;
  if (!fingerprint) throw new Error('Expected provider claim-gate fingerprint');
  const common = {
    balanceTransactionId: staged.balanceTransactionId,
    scope: 'title' as const,
    currency: 'USD',
    algorithmVersion: 1,
    sourceFingerprint: fingerprint,
    supersedesSetId: null,
    reversalOfSetId: null
  };
  await databaseClient.db.transaction(async (transaction) => {
    await persistFinancialAllocationPlanLocked(transaction, {
      sourceKind: 'payment',
      sourceId: payment.id,
      classificationVersion: 1,
      correlationId: `claim-gate-gross-c1-${suffix}`,
      plan: {
        ...common,
        allocationIdentity:
          `payment:${payment.id}:${staged.balanceTransactionId}:replay:c1-a1:gross`,
        basis: 'gross_amount',
        expectedEffectMinor: 100,
        items: [{
          orderItemId,
          component: 'sale_subtotal',
          effectMinor: 100,
          currency: 'USD',
          tieBreakKey: orderItemId
        }]
      }
    });
    await persistFinancialAllocationPlanLocked(transaction, {
      sourceKind: 'payment',
      sourceId: payment.id,
      classificationVersion: 1,
      correlationId: `claim-gate-fee-c1-${suffix}`,
      plan: {
        ...common,
        allocationIdentity:
          `payment:${payment.id}:${staged.balanceTransactionId}:replay:c1-a1:fee`,
        basis: 'fee',
        expectedEffectMinor: 0,
        items: []
      }
    });
  });
  await databaseClient.db.delete(jobs);
  return {
    orderId,
    orderItemId,
    paymentId: payment.id,
    paymentIntentId,
    chargeId,
    balanceTransactionId: staged.balanceTransactionId,
    fingerprint,
    snapshot
  };
}

async function registerAndReplaySuccessor(
  fixture: Awaited<ReturnType<typeof providerProjectionFixture>>,
  claimTime: Date,
  correlationId: string
) {
  const pending = await startOrResumeFinancialScan(databaseClient.db, {
    kind: 'composite_replay',
    classifierVersion: 2,
    allocationAlgorithmVersion: 2,
    replayId: 'c2-a2'
  });
  const replayChildSpec = createFinancialClassificationSubjectJob({
    subjectType: 'balance_transaction',
    subjectId: fixture.balanceTransactionId,
    sourceFingerprintSha256: fixture.fingerprint,
    classifierVersion: 2,
    allocationAlgorithmVersion: 2,
    scanRunId: pending.id
  });
  const sealed = await commitFinancialScanPage(databaseClient.db, {
    runId: pending.id,
    expectedPhase: 'classification_replay_page',
    expectedCheckpoint: null,
    expectedPageCount: 0,
    nextPhase: 'classification_replay_page',
    nextCheckpoint: null,
    processedCount: 1,
    children: [replayChildSpec],
    complete: true
  });
  const successorWorker = createPostgresJobRepository(
    databaseClient.db,
    applicationConfig.jobs,
    () => claimTime,
    'all',
    { classifierVersion: 2, allocationAlgorithmVersion: 2 }
  );
  const replayChild = await successorWorker.claimNext(`${correlationId}-replay-child`);
  expect(replayChild).toMatchObject({
    type: 'commerce.financial-classification',
    payload: expect.objectContaining({
      subjectId: fixture.balanceTransactionId,
      classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      scanRunId: pending.id
    })
  });
  await replayFinancialClassification({
    database: databaseClient.db,
    targetClassifierVersion: 2,
    targetAllocationAlgorithmVersion: 2
  }, {
    payload: replayChild!.payload as never,
    correlationId: `${correlationId}-replay-c2-a2`,
    signal: new AbortController().signal
  });
  await expect(successorWorker.complete(replayChild!.id, `${correlationId}-replay-child`))
    .resolves.toBe(true);
  return { pending, sealed, successorWorker };
}

async function durableProjectionState(paymentId: string, balanceTransactionId: string) {
  const allocations = await databaseClient.pool.query<{
    allocation_identity: string;
    basis: string;
    classifier_version: number;
    algorithm_version: number;
    is_tip: boolean;
  }>(`
    select allocation.allocation_identity, allocation.basis,
      allocation.classifier_version, allocation.algorithm_version,
      not exists (
        select 1 from financial_allocation_sets successor
        where successor.supersedes_set_id = allocation.id
      ) as is_tip
    from financial_allocation_sets allocation
    where allocation.balance_transaction_id = $1
    order by allocation.classifier_version, allocation.algorithm_version,
      allocation.basis, allocation.id
  `, [balanceTransactionId]);
  const payment = await databaseClient.pool.query<{
    financial_evidence_status: string;
  }>('select financial_evidence_status from payments where id=$1', [paymentId]);
  const issues = await databaseClient.pool.query<{ safe_code: string; state: string }>(`
    select safe_code, state from financial_reconciliation_issues
    where resource_id in ($1, $2) order by safe_code, state
  `, [paymentId, balanceTransactionId]);
  return {
    allocations: allocations.rows,
    paymentStatus: payment.rows[0]?.financial_evidence_status,
    issues: issues.rows
  };
}

it('defers an active provider refresh after successor writes, then converges under the activated implementation', async () => {
  const fixture = await providerProjectionFixture();
  const pending = await startOrResumeFinancialScan(databaseClient.db, {
    kind: 'composite_replay',
    classifierVersion: 2,
    allocationAlgorithmVersion: 2,
    replayId: 'c2-a2'
  });
  const replayChildSpec = createFinancialClassificationSubjectJob({
    subjectType: 'balance_transaction',
    subjectId: fixture.balanceTransactionId,
    sourceFingerprintSha256: fixture.fingerprint,
    classifierVersion: 2,
    allocationAlgorithmVersion: 2,
    scanRunId: pending.id
  });
  const sealed = await commitFinancialScanPage(databaseClient.db, {
    runId: pending.id,
    expectedPhase: 'classification_replay_page',
    expectedCheckpoint: null,
    expectedPageCount: 0,
    nextPhase: 'classification_replay_page',
    nextCheckpoint: null,
    processedCount: 1,
    children: [replayChildSpec],
    complete: true
  });
  const claimTime = new Date('2099-08-14T14:00:00.000Z');
  const activeWorker = createPostgresJobRepository(
    databaseClient.db,
    applicationConfig.jobs,
    () => claimTime,
    'all',
    { classifierVersion: 1, allocationAlgorithmVersion: 1 }
  );
  const successorWorker = createPostgresJobRepository(
    databaseClient.db,
    applicationConfig.jobs,
    () => claimTime,
    'all',
    { classifierVersion: 2, allocationAlgorithmVersion: 2 }
  );

  await expect(activeWorker.claimNext('claim-gate-replay-child-c1')).resolves.toBeNull();
  const replayChild = await successorWorker.claimNext('claim-gate-replay-child-c2');
  expect(replayChild).toMatchObject({
    type: 'commerce.financial-classification',
    payload: expect.objectContaining({
      subjectId: fixture.balanceTransactionId,
      classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      scanRunId: pending.id
    })
  });
  await expect(replayFinancialClassification({
    database: databaseClient.db,
    targetClassifierVersion: 2,
    targetAllocationAlgorithmVersion: 2
  }, {
    payload: replayChild!.payload as never,
    correlationId: 'claim-gate-pending-replay-c2-a2',
    signal: new AbortController().signal
  })).resolves.toBeUndefined();
  await expect(successorWorker.complete(replayChild!.id, 'claim-gate-replay-child-c2'))
    .resolves.toBe(true);
  const beforeBarrier = await durableProjectionState(
    fixture.paymentId,
    fixture.balanceTransactionId
  );
  expect(beforeBarrier.allocations.filter((row) => row.is_tip)).toEqual([
    expect.objectContaining({ basis: 'gross_amount', classifier_version: 2, algorithm_version: 2 }),
    expect.objectContaining({ basis: 'fee', classifier_version: 2, algorithm_version: 2 })
  ]);

  const sourceSpec = createFinancialSourceEventJob({
    sourceKind: 'payment',
    sourceId: fixture.paymentId,
    providerEventId: 'evt_claim_gate_pending_refresh'
  });
  const queued = await enqueueJob(databaseClient.db, {
    ...sourceSpec,
    runAt: new Date(0)
  });

  await expect(activeWorker.claimNext('claim-gate-active-c1')).resolves.toBeNull();
  const finalizer = await successorWorker.claimNext('claim-gate-finalizer-c2');
  expect(finalizer).toMatchObject({
    type: 'commerce.financial-scan',
    payload: expect.objectContaining({
      kind: 'continuation',
      phase: 'classification_replay_finalize',
      scanRunId: pending.id
    })
  });
  await expect(databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id)))
    .resolves.toEqual([expect.objectContaining({ status: 'pending', attempts: 0 })]);
  await expect(durableProjectionState(fixture.paymentId, fixture.balanceTransactionId))
    .resolves.toEqual(beforeBarrier);

  await expect(activeWorker.claimNext('claim-gate-finalizer-c1')).resolves.toBeNull();
  await expect(finalizeFinancialReplay(databaseClient.db, {
    runId: pending.id,
    expectedCursorDigestSha256: sealed.cursorDigestSha256!,
    expectedPageCount: sealed.pageCount,
    classifierVersion: 2,
    allocationAlgorithmVersion: 2,
    correlationId: 'claim-gate-activate-c2-a2'
  })).resolves.toMatchObject({ state: 'completed', safeOutcome: 'completed' });
  await expect(successorWorker.complete(finalizer!.id, 'claim-gate-finalizer-c2'))
    .resolves.toBe(true);

  await expect(activeWorker.claimNext('claim-gate-retired-c1')).resolves.toBeNull();
  const claimedSource = await successorWorker.claimNext('claim-gate-active-c2-source');
  expect(claimedSource).toMatchObject({
    id: queued.id,
    type: 'commerce.financial-source',
    attempts: 1,
    lockedBy: 'claim-gate-active-c2-source'
  });
  await expect(stageBalanceTransaction(
    databaseClient.db,
    fixture.snapshot,
    { correlationId: 'claim-gate-refresh-active-c2' },
    { classifierVersion: 2, allocationAlgorithmVersion: 2 }
  )).resolves.toMatchObject({
    balanceTransactionId: fixture.balanceTransactionId,
    disposition: 'unchanged'
  });
  await expect(replayFinancialClassification({
    database: databaseClient.db,
    targetClassifierVersion: 2,
    targetAllocationAlgorithmVersion: 2
  }, {
    payload: {
      subjectType: 'balance_transaction',
      subjectId: fixture.balanceTransactionId,
      sourceFingerprintSha256: fixture.fingerprint,
      classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      replayId: 'c2-a2'
    },
    correlationId: 'claim-gate-recompute-active-c2',
    signal: new AbortController().signal
  })).resolves.toBeUndefined();
  await expect(successorWorker.complete(queued.id, 'claim-gate-active-c2-source'))
    .resolves.toBe(true);

  const converged = await durableProjectionState(fixture.paymentId, fixture.balanceTransactionId);
  expect(converged.paymentStatus).toBe('fee_reconciled');
  expect(converged.issues).toEqual([]);
  expect(converged.allocations).toHaveLength(4);
  expect(converged.allocations.filter((row) => row.is_tip)).toEqual([
    {
      allocation_identity:
        `payment:${fixture.paymentId}:${fixture.balanceTransactionId}:replay:c2-a2:gross`,
      basis: 'gross_amount',
      classifier_version: 2,
      algorithm_version: 2,
      is_tip: true
    },
    {
      allocation_identity:
        `payment:${fixture.paymentId}:${fixture.balanceTransactionId}:replay:c2-a2:fee`,
      basis: 'fee',
      classifier_version: 2,
      algorithm_version: 2,
      is_tip: true
    }
  ]);
  await expect(databaseClient.db.select().from(jobs))
    .resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: queued.id, status: 'succeeded', attempts: 1 }),
      expect.objectContaining({ id: finalizer!.id, status: 'succeeded', attempts: 1 })
    ]));
  expect(await databaseClient.db.select().from(financialAllocationSets))
    .toHaveLength(4);
});

it('retries a source claimed before pending registration when it reaches projection after successor writes', async () => {
  const fixture = await providerProjectionFixture();
  const claimTime = new Date('2099-08-14T15:00:00.000Z');
  const activeWorkerName = 'claim-gate-race-c1';
  const activeWorker = createPostgresJobRepository(
    databaseClient.db,
    applicationConfig.jobs,
    () => claimTime,
    'all',
    { classifierVersion: 1, allocationAlgorithmVersion: 1 }
  );
  const queued = await enqueueJob(databaseClient.db, {
    ...createFinancialSourceEventJob({
      sourceKind: 'payment',
      sourceId: fixture.paymentId,
      providerEventId: 'evt_claim_gate_preclaimed_race'
    }),
    runAt: new Date(0)
  });
  const claimed = await activeWorker.claimNext(activeWorkerName);
  expect(claimed).toMatchObject({
    id: queued.id,
    type: 'commerce.financial-source',
    attempts: 1,
    lockedBy: activeWorkerName
  });

  const providerCallEntered = Promise.withResolvers<void>();
  const releaseProviderCall = Promise.withResolvers<void>();
  const gateway = {
    retrievePayment: async () => ({
      paymentIntentId: fixture.paymentIntentId,
      metadataVersion: '1' as const,
      metadataOrderId: fixture.orderId,
      latestChargeId: fixture.chargeId,
      liveMode: false,
      state: 'succeeded' as const,
      amountMinor: 100,
      currency: 'usd',
      paidAt: PROVIDER_SNAPSHOT.createdAt,
      paymentMethodCategory: 'card'
    }),
    retrieveCharge: async () => ({
      id: fixture.chargeId,
      paymentIntentId: fixture.paymentIntentId,
      livemode: false,
      amountMinor: 100,
      amountRefundedMinor: 0,
      currency: 'USD',
      status: 'succeeded' as const,
      balanceTransactionId: fixture.snapshot.id,
      createdAt: PROVIDER_SNAPSHOT.createdAt
    }),
    retrieveBalanceTransaction: async () => {
      providerCallEntered.resolve();
      await releaseProviderCall.promise;
      return fixture.snapshot;
    }
  } as unknown as StripeCommerceGateway;
  const staleProjection = reconcilePaymentFinancialSource(
    databaseClient.db,
    gateway,
    { paymentId: fixture.paymentId, correlationId: 'claim-gate-preclaimed-c1' },
    new AbortController().signal
  );
  await providerCallEntered.promise;

  const { pending, sealed, successorWorker } = await registerAndReplaySuccessor(
    fixture,
    claimTime,
    'claim-gate-race'
  );
  const afterSuccessor = await durableProjectionState(
    fixture.paymentId,
    fixture.balanceTransactionId
  );
  expect(afterSuccessor.allocations.filter((row) => row.is_tip)).toEqual([
    expect.objectContaining({ basis: 'gross_amount', classifier_version: 2, algorithm_version: 2 }),
    expect.objectContaining({ basis: 'fee', classifier_version: 2, algorithm_version: 2 })
  ]);

  releaseProviderCall.resolve();
  await expect(staleProjection).rejects.toMatchObject({
    name: 'RetryableFinancialError',
    safeCode: 'state_changed'
  });
  await expect(activeWorker.fail(
    queued.id,
    activeWorkerName,
    'Financial projection authority changed.',
    true
  )).resolves.toBe(true);
  await expect(durableProjectionState(fixture.paymentId, fixture.balanceTransactionId))
    .resolves.toEqual(afterSuccessor);
  await expect(databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id)))
    .resolves.toEqual([expect.objectContaining({
      status: 'pending',
      attempts: 1,
      lockedBy: null
    })]);

  const finalizerWorkerName = 'claim-gate-race-finalizer-c2';
  const finalizer = await successorWorker.claimNext(finalizerWorkerName);
  expect(finalizer).toMatchObject({
    type: 'commerce.financial-scan',
    payload: expect.objectContaining({
      kind: 'continuation',
      phase: 'classification_replay_finalize',
      scanRunId: pending.id
    })
  });
  await expect(finalizeFinancialReplay(databaseClient.db, {
    runId: pending.id,
    expectedCursorDigestSha256: sealed.cursorDigestSha256!,
    expectedPageCount: sealed.pageCount,
    classifierVersion: 2,
    allocationAlgorithmVersion: 2,
    correlationId: 'claim-gate-race-activate-c2-a2'
  })).resolves.toMatchObject({ state: 'completed', safeOutcome: 'completed' });
  await expect(successorWorker.complete(finalizer!.id, finalizerWorkerName)).resolves.toBe(true);
  await expect(durableProjectionState(fixture.paymentId, fixture.balanceTransactionId))
    .resolves.toEqual(afterSuccessor);
  await expect(activeWorker.claimNext('claim-gate-race-retired-c1')).resolves.toBeNull();
});
