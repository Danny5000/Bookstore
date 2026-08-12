import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { stageBalanceTransaction } from '$lib/server/commerce/financial/ledger';
import {
  loadCurrentPayoutEvidence,
  persistPayoutImportPage,
  publishPayoutMembership,
  stagePayoutSnapshot,
  startOrResumePayoutImport
} from '$lib/server/commerce/financial/payouts/repository';
import { reconcileFinancialPayout } from '$lib/server/commerce/financial/payouts/service';
import { createFixtureStripeGateway } from '$lib/server/commerce/stripe/fixture-gateway';
import {
  auditEvents,
  financialReconciliationIssues,
  jobs,
  payoutImportRunEntries,
  payoutImportRuns,
  stripePayoutBalanceTransactions,
  stripePayouts
} from '$lib/server/db/schema';
import { balanceTransactionSnapshotFixture } from '../fixtures/stripe/balance-transaction';
import { payoutSnapshotFixture } from '../fixtures/stripe/payout';
import { databaseClient } from './database';

async function createPublishableRun(suffix: string, balanceTransactionId?: string) {
  const providerPayoutId = `po_financial_publish_${suffix}`;
  const payoutSnapshot = payoutSnapshotFixture({
    id: providerPayoutId,
    balanceTransactionId: null
  });
  const payout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshot, {
    correlationId: `payout-publish-stage-${suffix}`
  });
  const balance = balanceTransactionId === undefined
    ? await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
        id: `txn_financial_publish_${suffix}`,
        sourceId: null,
        sourceFamily: 'unknown',
        rawType: 'adjustment',
        reportingCategory: 'other_adjustment'
      }), { correlationId: `payout-publish-balance-${suffix}` })
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
  return { payout, payoutSnapshot, run, balanceTransactionId: balance.balanceTransactionId };
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

it('fails a competing payout publication atomically with a durable membership-conflict issue', async () => {
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
