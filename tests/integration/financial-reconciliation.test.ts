import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  createFinancialClassificationHandler
} from '$lib/server/commerce/financial/handlers/classification';
import { createFinancialPayoutHandler } from '$lib/server/commerce/financial/handlers/payout';
import { createFinancialScanHandler } from '$lib/server/commerce/financial/handlers/scan';
import { createFinancialSourceHandler } from '$lib/server/commerce/financial/handlers/source';
import {
  createFinancialClassificationSubjectJob,
  createFinancialPayoutEventJob,
  createFinancialSourceEventJob,
  createFinancialSourceScanJob,
  FINANCIAL_CLASSIFICATION_JOB,
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_SCAN_JOB,
  FINANCIAL_SOURCE_JOB,
  type FinancialPayoutJobSpec,
  type FinancialSourceJobSpec
} from '$lib/server/commerce/financial/jobs';
import {
  fingerprintBalanceTransaction,
  stageBalanceTransaction
} from '$lib/server/commerce/financial/ledger';
import {
  loadCurrentPayoutEvidence,
  persistPayoutImportPage,
  publishPayoutMembership,
  stagePayoutSnapshot,
  startOrResumePayoutImport
} from '$lib/server/commerce/financial/payouts/repository';
import { derivePublicFinancialState } from '$lib/server/commerce/financial/state';
import { createFixtureStripeGateway } from '$lib/server/commerce/stripe/fixture-gateway';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import {
  auditEvents,
  currentFinancialProjectionHeads,
  entitlementGrants,
  entitlements,
  financialAllocationSets,
  financialClassificationVersions,
  financialProjectionVersions,
  financialReconciliationIssues,
  financialItemAllocations,
  guestIdentities,
  jobs,
  orderItems,
  orders,
  outboxMessages,
  payments,
  payoutImportRuns,
  stripeBalanceTransactions,
  stripePayoutBalanceTransactions,
  stripePayouts,
  titles,
  refundAllocationComponents,
  refundAllocations,
  refunds,
  disputeItemAllocations,
  disputes,
  user,
  type JsonObject
} from '$lib/server/db/schema';
import {
  createPostgresJobRepository,
  enqueueActiveEntityJob,
  enqueueJob
} from '$lib/server/jobs/repository';
import type { JobHandler } from '$lib/server/jobs/types';
import { balanceTransactionSnapshotFixture } from '../fixtures/stripe/balance-transaction';
import { chargeSnapshotFixture } from '../fixtures/stripe/charge';
import { paymentSnapshotFixture } from '../fixtures/stripe/payment';
import { payoutSnapshotFixture } from '../fixtures/stripe/payout';
import { refundSnapshotFixture } from '../fixtures/stripe/refund';
import { disputeSnapshotFixture } from '../fixtures/stripe/dispute';
import { applicationConfig, databaseClient } from './database';

const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');

interface PurchaseFixture {
  readonly orderId: string;
  readonly paymentId: string;
  readonly orderItemIds: readonly string[];
  readonly orderItemFacts: readonly {
    readonly id: string;
    readonly subtotalMinor: number;
    readonly taxMinor: number;
  }[];
  readonly paidAt: Date;
  readonly provider: {
    readonly paymentIntentId: string;
    readonly chargeId: string;
    readonly balanceTransactionId: string;
  };
  readonly settlement: {
    readonly currency: string;
    readonly amountMinor: number;
    readonly feeMinor: number;
    readonly netMinor: number;
  };
  readonly stripe: ReturnType<typeof createFixtureStripeGateway>;
}

function token(): string {
  return randomUUID().replaceAll('-', '');
}

async function createPaidPurchase(settlementCurrency: 'USD' | 'EUR'): Promise<PurchaseFixture> {
  const suffix = token();
  const orderId = randomUUID();
  const paidAt = new Date('2026-08-10T12:01:00.000Z');
  const [guest] = await databaseClient.db.insert(guestIdentities).values({
    email: `financial-reconciliation-${suffix}@example.com`
  }).returning();
  if (!guest) throw new Error('Expected a guest fixture.');

  const itemFacts = [
    { id: randomUUID(), titleId: randomUUID(), subtotalMinor: 800, taxMinor: 80 },
    { id: randomUUID(), titleId: randomUUID(), subtotalMinor: 450, taxMinor: 70 }
  ];
  await databaseClient.db.insert(titles).values(itemFacts.map((item, index) => ({
    id: item.titleId,
    slug: `financial-reconciliation-${index}-${suffix}`,
    title: `Financial reconciliation ${index}`,
    description: 'Financial reconciliation fixture',
    creatorName: 'Fixture creator',
    format: 'prose' as const,
    priceMinor: item.subtotalMinor,
    currency: 'USD',
    visibility: 'private' as const
  })));
  await databaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    guestIdentityId: guest.id,
    purchaseEmail: guest.email,
    currency: 'USD',
    subtotalMinor: 1250,
    taxMinor: 150,
    totalMinor: 1400,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: `cs_reconciliation_${suffix}`,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt
  });
  await databaseClient.db.insert(orderItems).values(itemFacts.map((item, index) => ({
    id: item.id,
    orderId,
    titleId: item.titleId,
    titleSnapshot: `Financial reconciliation ${index}`,
    creatorNameSnapshot: 'Fixture creator',
    format: 'prose' as const,
    currency: 'USD',
    unitSubtotalMinor: item.subtotalMinor,
    taxMinor: item.taxMinor,
    totalMinor: item.subtotalMinor + item.taxMinor,
    stripeLineItemId: `li_reconciliation_${index}_${suffix}`
  })));

  const provider = {
    paymentIntentId: `pi_reconciliation_${suffix}`,
    chargeId: `ch_reconciliation_${suffix}`,
    balanceTransactionId: `txn_reconciliation_${suffix}`
  };
  const [payment] = await databaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: provider.paymentIntentId,
    stripeLatestChargeId: provider.chargeId,
    status: 'succeeded',
    amountMinor: 1400,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt
  }).returning();
  if (!payment) throw new Error('Expected a payment fixture.');

  const settlement = settlementCurrency === 'USD'
    ? { currency: 'USD', amountMinor: 1400, feeMinor: 70, netMinor: 1330 }
    : { currency: 'EUR', amountMinor: 1260, feeMinor: 60, netMinor: 1200 };
  const stripe = createFixtureStripeGateway();
  stripe.harness.setPayment(paymentSnapshotFixture({
    paymentIntentId: provider.paymentIntentId,
    metadataOrderId: orderId,
    latestChargeId: provider.chargeId,
    amountMinor: 1400,
    currency: 'usd',
    paidAt
  }));
  stripe.harness.setCharge(chargeSnapshotFixture({
    id: provider.chargeId,
    paymentIntentId: provider.paymentIntentId,
    amountMinor: 1400,
    currency: 'USD',
    balanceTransactionId: provider.balanceTransactionId,
    createdAt: paidAt
  }));
  stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
    id: provider.balanceTransactionId,
    sourceId: provider.chargeId,
    amountMinor: settlement.amountMinor,
    feeMinor: settlement.feeMinor,
    netMinor: settlement.netMinor,
    currency: settlement.currency,
    createdAt: paidAt,
    exchangeRate: settlementCurrency === 'EUR' ? '0.9' : null,
    exchangeSourceCurrency: settlementCurrency === 'EUR' ? 'USD' : null,
    exchangeTargetCurrency: settlementCurrency === 'EUR' ? 'EUR' : null,
    feeDetails: settlement.feeMinor === 0 ? [] : [{
      ordinal: 0,
      rawType: 'stripe_fee',
      amountMinor: settlement.feeMinor,
      currency: settlement.currency
    }]
  }));

  return {
    orderId,
    paymentId: payment.id,
    orderItemIds: itemFacts.map((item) => item.id),
    orderItemFacts: itemFacts.map((item) => ({
      id: item.id,
      subtotalMinor: item.subtotalMinor,
      taxMinor: item.taxMinor
    })),
    paidAt,
    provider,
    settlement,
    stripe
  };
}

function financialHandlers(
  gateway: StripeCommerceGateway,
  versions: { classifierVersion: number; allocationAlgorithmVersion: number } = {
    classifierVersion: 1,
    allocationAlgorithmVersion: 1
  }
): ReadonlyMap<string, JobHandler> {
  return new Map([
    [FINANCIAL_SOURCE_JOB, createFinancialSourceHandler({
      database: databaseClient.db,
      gateway
    })],
    [FINANCIAL_PAYOUT_JOB, createFinancialPayoutHandler({
      database: databaseClient.db,
      gateway
    })],
    [FINANCIAL_SCAN_JOB, createFinancialScanHandler({
      database: databaseClient.db,
      gateway,
      runtimeMode: 'stripe'
    })],
    [FINANCIAL_CLASSIFICATION_JOB, createFinancialClassificationHandler({
      database: databaseClient.db,
      targetClassifierVersion: versions.classifierVersion,
      targetAllocationAlgorithmVersion: versions.allocationAlgorithmVersion
    })]
  ]);
}

async function drainFinancialJobs(
  handlers: ReadonlyMap<string, JobHandler>,
  maximum = 24
): Promise<readonly string[]> {
  const repository = createPostgresJobRepository(
    databaseClient.db,
    applicationConfig.jobs,
    () => FAR_FUTURE
  );
  const completed: string[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const workerId = `financial-acceptance-${index}`;
    const job = await repository.claimNext(workerId);
    if (!job) return completed;
    const handler = handlers.get(job.type);
    if (!handler) throw new Error(`Unexpected financial job type: ${job.type}`);
    try {
      await handler(job, new AbortController().signal);
    } catch (error) {
      await repository.fail(job.id, workerId, 'acceptance handler failed', false);
      throw error;
    }
    expect(await repository.complete(job.id, workerId)).toBe(true);
    completed.push(job.id);
  }
  throw new Error(`Financial acceptance work exceeded ${maximum} jobs.`);
}

async function enqueueSource(spec: FinancialSourceJobSpec): Promise<string> {
  const row = await databaseClient.db.transaction((transaction) => enqueueActiveEntityJob(
    transaction,
    {
      type: spec.type,
      payload: spec.payload as JsonObject,
      deduplicationKey: spec.deduplicationKey,
      maxAttempts: spec.maxAttempts,
      activeEntity: {
        sourceKind: spec.payload.sourceKind,
        sourceId: spec.payload.sourceId
      }
    }
  ));
  return row.id;
}

async function enqueuePayout(spec: FinancialPayoutJobSpec): Promise<string> {
  const row = await databaseClient.db.transaction((transaction) => enqueueActiveEntityJob(
    transaction,
    {
      type: spec.type,
      payload: spec.payload as JsonObject,
      deduplicationKey: spec.deduplicationKey,
      maxAttempts: spec.maxAttempts,
      activeEntity: { providerPayoutId: spec.payload.providerPayoutId }
    }
  ));
  return row.id;
}

async function reconcilePurchaseThroughJobs(fixture: PurchaseFixture): Promise<void> {
  const event = createFinancialSourceEventJob({
    sourceKind: 'payment',
    sourceId: fixture.paymentId,
    providerEventId: `evt_reconciliation_${token()}`
  });
  const eventId = await enqueueSource(event);
  const duplicateId = await enqueueSource(event);
  const earlyScanId = await enqueueSource(createFinancialSourceScanJob({
    sourceKind: 'payment',
    sourceId: fixture.paymentId,
    scanRunId: randomUUID(),
    scanGenerationHour: '2026-08-12T12:00:00.000Z'
  }));
  expect({ eventId, duplicateId, earlyScanId }).toEqual({
    eventId,
    duplicateId: eventId,
    earlyScanId: eventId
  });

  await drainFinancialJobs(financialHandlers(fixture.stripe.gateway));
  const laterScanId = await enqueueSource(createFinancialSourceScanJob({
    sourceKind: 'payment',
    sourceId: fixture.paymentId,
    scanRunId: randomUUID(),
    scanGenerationHour: '2026-08-12T13:00:00.000Z'
  }));
  expect(laterScanId).not.toBe(eventId);
  await drainFinancialJobs(financialHandlers(fixture.stripe.gateway));
}

async function expectExactAllocationConservation(fixture: PurchaseFixture): Promise<void> {
  const rows = ((await databaseClient.db.execute(sql`
    select allocation.id, allocation.basis, allocation.scope,
      allocation.currency, allocation.expected_effect_minor as "expectedEffectMinor",
      count(item.id)::int as "itemCount",
      coalesce(sum(item.effect_minor), 0)::int as "itemEffectMinor"
    from financial_allocation_sets allocation
    left join financial_item_allocations item on item.allocation_set_id = allocation.id
    where allocation.source_kind = 'payment'
      and allocation.source_internal_id = ${fixture.paymentId}
    group by allocation.id
    order by allocation.basis, allocation.id
  `)) as { rows?: Array<{
    id: string;
    basis: 'fee' | 'gross_amount';
    scope: string;
    currency: string;
    expectedEffectMinor: number;
    itemCount: number;
    itemEffectMinor: number;
  }> }).rows ?? [];
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => ({
    basis: row.basis,
    scope: row.scope,
    currency: row.currency,
    expectedEffectMinor: row.expectedEffectMinor,
    itemCount: row.itemCount,
    itemEffectMinor: row.itemEffectMinor
  }))).toEqual([
    {
      basis: 'gross_amount',
      scope: 'title',
      currency: fixture.settlement.currency,
      expectedEffectMinor: fixture.settlement.amountMinor,
      itemCount: fixture.orderItemIds.length * 2,
      itemEffectMinor: fixture.settlement.amountMinor
    },
    {
      basis: 'fee',
      scope: 'title',
      currency: fixture.settlement.currency,
      expectedEffectMinor: -fixture.settlement.feeMinor,
      itemCount: fixture.orderItemIds.length,
      itemEffectMinor: -fixture.settlement.feeMinor
    }
  ]);
  expect(rows.reduce((sum, row) => sum + row.expectedEffectMinor, 0))
    .toBe(fixture.settlement.netMinor);

  const [provider] = await databaseClient.db.select().from(stripeBalanceTransactions)
    .where(eq(stripeBalanceTransactions.providerId, fixture.provider.balanceTransactionId));
  expect(provider).toMatchObject({
    amountMinor: fixture.settlement.amountMinor,
    feeMinor: fixture.settlement.feeMinor,
    netMinor: fixture.settlement.netMinor,
    currency: fixture.settlement.currency
  });
  expect((provider?.amountMinor ?? 0) - (provider?.feeMinor ?? 0)).toBe(provider?.netMinor);
}

type RefundOrDispute = 'refund' | 'dispute';

async function loadSourceProjectionSnapshot(sourceKind: RefundOrDispute, sourceId: string) {
  const sets = await databaseClient.db.select({
    id: financialAllocationSets.id,
    allocationIdentity: financialAllocationSets.allocationIdentity,
    balanceTransactionId: financialAllocationSets.balanceTransactionId,
    basis: financialAllocationSets.basis,
    scope: financialAllocationSets.scope,
    expectedEffectMinor: financialAllocationSets.expectedEffectMinor,
    currency: financialAllocationSets.currency,
    supersedesSetId: financialAllocationSets.supersedesSetId,
    reversalOfSetId: financialAllocationSets.reversalOfSetId
  }).from(financialAllocationSets).where(and(
    eq(financialAllocationSets.sourceKind, sourceKind),
    eq(financialAllocationSets.sourceInternalId, sourceId)
  )).orderBy(asc(financialAllocationSets.id));
  const items = await databaseClient.db.select({
    id: financialItemAllocations.id,
    allocationSetId: financialItemAllocations.allocationSetId,
    orderItemId: financialItemAllocations.orderItemId,
    component: financialItemAllocations.component,
    effectMinor: financialItemAllocations.effectMinor,
    currency: financialItemAllocations.currency,
    tieBreakKey: financialItemAllocations.tieBreakKey
  }).from(financialItemAllocations).innerJoin(
    financialAllocationSets,
    eq(financialAllocationSets.id, financialItemAllocations.allocationSetId)
  ).where(and(
    eq(financialAllocationSets.sourceKind, sourceKind),
    eq(financialAllocationSets.sourceInternalId, sourceId)
  )).orderBy(asc(financialItemAllocations.id));
  return { sets, items };
}

async function expectSourceProjectionConservation(
  sourceKind: RefundOrDispute,
  sourceId: string
): Promise<readonly {
  providerId: string;
  basis: 'gross_amount' | 'fee';
  expectedEffectMinor: number;
}[]> {
  const rows = ((await databaseClient.db.execute(sql`
    select allocation.id, allocation.basis, allocation.scope,
      allocation.expected_effect_minor as "expectedEffectMinor",
      balance.provider_id as "providerId", balance.amount_minor as "amountMinor",
      balance.fee_minor as "feeMinor", balance.net_minor as "netMinor",
      count(item.id)::int as "itemCount",
      coalesce(sum(item.effect_minor), 0)::int as "itemEffectMinor"
    from financial_allocation_sets allocation
    join stripe_balance_transactions balance on balance.id = allocation.balance_transaction_id
    left join financial_item_allocations item on item.allocation_set_id = allocation.id
    where allocation.source_kind = ${sourceKind}
      and allocation.source_internal_id = ${sourceId}
    group by allocation.id, balance.id
    order by balance.provider_id, allocation.basis
  `)) as { rows?: Array<{
    id: string;
    providerId: string;
    basis: 'gross_amount' | 'fee';
    scope: 'title' | 'account' | 'unresolved';
    expectedEffectMinor: number;
    amountMinor: number;
    feeMinor: number;
    netMinor: number;
    itemCount: number;
    itemEffectMinor: number;
  }> }).rows ?? [];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.amountMinor - row.feeMinor, row.providerId).toBe(row.netMinor);
    expect(row.expectedEffectMinor, `${row.providerId}:${row.basis}`).toBe(
      row.basis === 'gross_amount' ? row.amountMinor : row.feeMinor === 0 ? 0 : -row.feeMinor
    );
    if (row.scope === 'title') {
      expect(row.itemEffectMinor, `${row.providerId}:${row.basis}:items`)
        .toBe(row.expectedEffectMinor);
    } else {
      expect(row.itemCount, `${row.providerId}:${row.basis}:account`).toBe(0);
    }
  }
  return rows;
}

async function reconcileSourceThroughEventAndScan(
  fixture: PurchaseFixture,
  sourceKind: RefundOrDispute,
  sourceId: string
) {
  const event = createFinancialSourceEventJob({
    sourceKind,
    sourceId,
    providerEventId: `evt_${sourceKind}_${token()}`
  });
  const eventId = await enqueueSource(event);
  expect(await enqueueSource(event)).toBe(eventId);
  await drainFinancialJobs(financialHandlers(fixture.stripe.gateway));

  const afterEvent = await loadSourceProjectionSnapshot(sourceKind, sourceId);
  expect(afterEvent.sets.length).toBeGreaterThan(0);
  const scanId = await enqueueSource(createFinancialSourceScanJob({
    sourceKind,
    sourceId,
    scanRunId: randomUUID(),
    scanGenerationHour: '2026-08-12T16:00:00.000Z'
  }));
  expect(scanId).not.toBe(eventId);
  await drainFinancialJobs(financialHandlers(fixture.stripe.gateway));
  expect(await loadSourceProjectionSnapshot(sourceKind, sourceId)).toEqual(afterEvent);
  expect(await databaseClient.db.select({
    id: jobs.id,
    status: jobs.status,
    attempts: jobs.attempts
  }).from(jobs).where(inArray(jobs.id, [eventId, scanId])).orderBy(asc(jobs.id)))
    .toEqual([
      expect.objectContaining({ status: 'succeeded', attempts: 1 }),
      expect.objectContaining({ status: 'succeeded', attempts: 1 })
    ]);
  return afterEvent;
}

async function seedActivePurchaseAccess(fixture: PurchaseFixture): Promise<void> {
  const userId = randomUUID();
  await databaseClient.db.insert(user).values({
    id: userId,
    name: 'Financial acceptance reader',
    email: `financial-acceptance-${token()}@example.com`,
    emailVerified: true
  });
  const items = await databaseClient.db.select({
    id: orderItems.id,
    titleId: orderItems.titleId
  }).from(orderItems).where(inArray(orderItems.id, fixture.orderItemIds)).orderBy(asc(orderItems.id));
  await databaseClient.db.insert(entitlementGrants).values(items.map((item) => ({
    titleId: item.titleId,
    userId,
    source: 'purchase' as const,
    orderItemId: item.id,
    state: 'active' as const,
    stateReason: 'payment_succeeded',
    grantedAt: fixture.paidAt
  })));
  await databaseClient.db.insert(entitlements).values(items.map((item) => ({
    userId,
    titleId: item.titleId,
    grantedAt: fixture.paidAt
  })));
}

async function loadPurchaseAccessSnapshot(fixture: PurchaseFixture) {
  const items = await databaseClient.db.select({
    id: orderItems.id,
    titleId: orderItems.titleId
  }).from(orderItems).where(inArray(orderItems.id, fixture.orderItemIds)).orderBy(asc(orderItems.id));
  return {
    grants: await databaseClient.db.select().from(entitlementGrants).where(inArray(
      entitlementGrants.orderItemId,
      items.map((item) => item.id)
    )).orderBy(asc(entitlementGrants.id)),
    entitlements: await databaseClient.db.select().from(entitlements).where(inArray(
      entitlements.titleId,
      items.map((item) => item.titleId)
    )).orderBy(asc(entitlements.id)),
    outbox: await databaseClient.db.select().from(outboxMessages).where(
      sql`${outboxMessages.payload}::text like ${`%${fixture.orderId}%`}`
    ).orderBy(asc(outboxMessages.id))
  };
}

describe('financial reconciliation acceptance', () => {
  it.each(['USD', 'EUR'] as const)(
    'converges duplicate and out-of-order %s source jobs with exact currency-local conservation',
    async (settlementCurrency) => {
      const fixture = await createPaidPurchase(settlementCurrency);
      await reconcilePurchaseThroughJobs(fixture);

      await expectExactAllocationConservation(fixture);
      expect((await databaseClient.db.select().from(payments)
        .where(eq(payments.id, fixture.paymentId)))[0]).toMatchObject({
        status: 'succeeded',
        financialEvidenceStatus: 'fee_reconciled'
      });
      expect(await databaseClient.db.select().from(auditEvents).where(and(
        eq(auditEvents.action, 'financial.payment_reconciled'),
        eq(auditEvents.resourceId, fixture.paymentId)
      ))).toHaveLength(1);
      expect(await databaseClient.db.select().from(jobs).where(and(
        eq(jobs.type, FINANCIAL_SOURCE_JOB),
        eq(jobs.status, 'succeeded')
      ))).toHaveLength(2);
    }
  );

  it('keeps an ambiguous multi-title refund pending, unresolved, replay-stable, and access-neutral', async () => {
    const fixture = await createPaidPurchase('USD');
    await reconcilePurchaseThroughJobs(fixture);
    await seedActivePurchaseAccess(fixture);
    const accessBefore = await loadPurchaseAccessSnapshot(fixture);
    const suffix = token();
    const refundAt = new Date('2026-08-10T12:30:00.000Z');
    const providerRefundId = `re_ambiguous_acceptance_${suffix}`;
    const providerBalanceId = `txn_refund_ambiguous_acceptance_${suffix}`;
    const [refund] = await databaseClient.db.insert(refunds).values({
      paymentId: fixture.paymentId,
      stripeRefundId: providerRefundId,
      status: 'succeeded',
      amountMinor: 500,
      currency: 'USD',
      reason: 'requested_by_customer',
      providerCreatedAt: refundAt,
      allocationStatus: 'needs_review'
    }).returning();
    if (!refund) throw new Error('Expected an ambiguous refund fixture.');

    fixture.stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400,
      currency: 'usd',
      paidAt: fixture.paidAt
    }));
    fixture.stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400,
      amountRefundedMinor: 500,
      currency: 'USD',
      balanceTransactionId: fixture.provider.balanceTransactionId,
      createdAt: fixture.paidAt
    }));
    fixture.stripe.harness.setRefund(refundSnapshotFixture({
      providerRefundId,
      paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 500,
      providerCreatedAt: refundAt,
      balanceTransactionId: providerBalanceId
    }));
    fixture.stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerBalanceId,
      sourceId: providerRefundId,
      sourceFamily: 'refund',
      rawType: 'refund',
      reportingCategory: 'refund',
      amountMinor: -500,
      feeMinor: 10,
      netMinor: -510,
      currency: 'USD',
      createdAt: refundAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 10, currency: 'USD' }]
    }));

    const replayStable = await reconcileSourceThroughEventAndScan(fixture, 'refund', refund.id);
    expect(replayStable.items).toHaveLength(0);
    expect(replayStable.sets.map((set) => ({
      basis: set.basis,
      scope: set.scope,
      expectedEffectMinor: set.expectedEffectMinor
    }))).toEqual(expect.arrayContaining([
      { basis: 'gross_amount', scope: 'unresolved', expectedEffectMinor: -500 },
      { basis: 'fee', scope: 'unresolved', expectedEffectMinor: -10 }
    ]));
    expect(await expectSourceProjectionConservation('refund', refund.id)).toHaveLength(2);
    expect((await databaseClient.db.select().from(refunds).where(eq(refunds.id, refund.id)))[0])
      .toMatchObject({
        status: 'succeeded',
        allocationStatus: 'needs_review',
        financialEvidenceStatus: 'pending'
      });
    const issues = await databaseClient.db.select().from(financialReconciliationIssues).where(and(
      eq(financialReconciliationIssues.resourceType, 'refund'),
      eq(financialReconciliationIssues.resourceId, refund.id)
    ));
    expect(issues).toEqual([expect.objectContaining({
      safeCode: 'allocation_incomplete',
      state: 'open',
      impact: 'pending',
      occurrenceCount: 2
    })]);
    expect(await databaseClient.db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'financial.issue.opened'),
      eq(auditEvents.resourceId, issues[0]!.id)
    ))).toHaveLength(1);
    expect(await databaseClient.db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'financial.refund_reconciled'),
      eq(auditEvents.resourceId, refund.id)
    ))).toHaveLength(0);
    expect(await loadPurchaseAccessSnapshot(fixture)).toEqual(accessBefore);
  }, 15_000);

  it('converges two finalized refunds to a full cumulative refund and exactly reverses a failed refund', async () => {
    const fixture = await createPaidPurchase('USD');
    await reconcilePurchaseThroughJobs(fixture);
    const suffix = token();
    const firstAt = new Date('2026-08-10T13:00:00.000Z');
    const secondAt = new Date('2026-08-10T13:10:00.000Z');
    const failedAt = new Date('2026-08-10T13:20:00.000Z');
    const providerIds = {
      firstRefund: `re_partial_${suffix}`,
      secondRefund: `re_full_${suffix}`,
      failedRefund: `re_failed_${suffix}`,
      firstBalance: `txn_refund_partial_${suffix}`,
      secondBalance: `txn_refund_full_${suffix}`,
      failedBalance: `txn_refund_failed_debit_${suffix}`,
      failedReversal: `txn_refund_failed_reversal_${suffix}`
    };
    const inserted = await databaseClient.db.insert(refunds).values([
      {
        paymentId: fixture.paymentId,
        stripeRefundId: providerIds.firstRefund,
        status: 'succeeded',
        amountMinor: 500,
        currency: 'USD',
        reason: 'requested_by_customer',
        providerCreatedAt: firstAt,
        allocationStatus: 'finalized'
      },
      {
        paymentId: fixture.paymentId,
        stripeRefundId: providerIds.secondRefund,
        status: 'succeeded',
        amountMinor: 900,
        currency: 'USD',
        reason: 'requested_by_customer',
        providerCreatedAt: secondAt,
        allocationStatus: 'finalized'
      },
      {
        paymentId: fixture.paymentId,
        stripeRefundId: providerIds.failedRefund,
        status: 'failed',
        amountMinor: 200,
        currency: 'USD',
        reason: 'requested_by_customer',
        providerCreatedAt: failedAt,
        allocationStatus: 'not_applicable'
      }
    ]).returning();
    const first = inserted.find((row) => row.stripeRefundId === providerIds.firstRefund);
    const second = inserted.find((row) => row.stripeRefundId === providerIds.secondRefund);
    const failed = inserted.find((row) => row.stripeRefundId === providerIds.failedRefund);
    if (!first || !second || !failed) throw new Error('Expected canonical refund fixtures.');

    const firstAllocations = await databaseClient.db.insert(refundAllocations).values([
      {
        refundId: first.id,
        orderItemId: fixture.orderItemFacts[0]!.id,
        amountMinor: 440,
        source: 'automatic'
      },
      {
        refundId: first.id,
        orderItemId: fixture.orderItemFacts[1]!.id,
        amountMinor: 60,
        source: 'automatic'
      }
    ]).returning();
    const secondAllocations = await databaseClient.db.insert(refundAllocations).values([
      {
        refundId: second.id,
        orderItemId: fixture.orderItemFacts[0]!.id,
        amountMinor: 440,
        source: 'automatic'
      },
      {
        refundId: second.id,
        orderItemId: fixture.orderItemFacts[1]!.id,
        amountMinor: 460,
        source: 'automatic'
      }
    ]).returning();
    await databaseClient.db.insert(refundAllocationComponents).values([
      {
        refundAllocationId: firstAllocations[0]!.id,
        refundId: first.id,
        orderItemId: fixture.orderItemFacts[0]!.id,
        subtotalMinor: 400,
        taxMinor: 40,
        totalMinor: 440,
        currency: 'USD'
      },
      {
        refundAllocationId: firstAllocations[1]!.id,
        refundId: first.id,
        orderItemId: fixture.orderItemFacts[1]!.id,
        subtotalMinor: 50,
        taxMinor: 10,
        totalMinor: 60,
        currency: 'USD'
      },
      {
        refundAllocationId: secondAllocations[0]!.id,
        refundId: second.id,
        orderItemId: fixture.orderItemFacts[0]!.id,
        subtotalMinor: 400,
        taxMinor: 40,
        totalMinor: 440,
        currency: 'USD'
      },
      {
        refundAllocationId: secondAllocations[1]!.id,
        refundId: second.id,
        orderItemId: fixture.orderItemFacts[1]!.id,
        subtotalMinor: 400,
        taxMinor: 60,
        totalMinor: 460,
        currency: 'USD'
      }
    ]);

    fixture.stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400,
      currency: 'usd',
      paidAt: fixture.paidAt
    }));
    fixture.stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400,
      amountRefundedMinor: 1400,
      currency: 'USD',
      balanceTransactionId: fixture.provider.balanceTransactionId,
      createdAt: fixture.paidAt
    }));
    fixture.stripe.harness.setRefund(refundSnapshotFixture({
      providerRefundId: providerIds.firstRefund,
      paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 500,
      providerCreatedAt: firstAt,
      balanceTransactionId: providerIds.firstBalance
    }));
    fixture.stripe.harness.setRefund(refundSnapshotFixture({
      providerRefundId: providerIds.secondRefund,
      paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 900,
      providerCreatedAt: secondAt,
      balanceTransactionId: providerIds.secondBalance
    }));
    fixture.stripe.harness.setRefund(refundSnapshotFixture({
      providerRefundId: providerIds.failedRefund,
      paymentIntentId: fixture.provider.paymentIntentId,
      state: 'failed',
      amountMinor: 200,
      providerCreatedAt: failedAt,
      balanceTransactionId: providerIds.failedBalance,
      failureBalanceTransactionId: providerIds.failedReversal
    }));
    fixture.stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerIds.firstBalance,
      sourceId: providerIds.firstRefund,
      sourceFamily: 'refund',
      rawType: 'refund',
      reportingCategory: 'refund',
      amountMinor: -500,
      feeMinor: 10,
      netMinor: -510,
      createdAt: firstAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 10, currency: 'USD' }]
    }));
    fixture.stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerIds.secondBalance,
      sourceId: providerIds.secondRefund,
      sourceFamily: 'refund',
      rawType: 'refund',
      reportingCategory: 'refund',
      amountMinor: -900,
      feeMinor: 14,
      netMinor: -914,
      createdAt: secondAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 14, currency: 'USD' }]
    }));
    fixture.stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerIds.failedBalance,
      sourceId: providerIds.failedRefund,
      sourceFamily: 'refund',
      rawType: 'refund',
      reportingCategory: 'refund',
      amountMinor: -200,
      feeMinor: 6,
      netMinor: -206,
      createdAt: failedAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 6, currency: 'USD' }]
    }));
    fixture.stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerIds.failedReversal,
      sourceId: providerIds.failedRefund,
      sourceFamily: 'refund',
      rawType: 'refund_failure',
      reportingCategory: 'refund_failure',
      amountMinor: 200,
      feeMinor: 2,
      netMinor: 198,
      createdAt: new Date('2026-08-10T13:21:00.000Z'),
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 2, currency: 'USD' }]
    }));

    await reconcileSourceThroughEventAndScan(fixture, 'refund', first.id);
    await reconcileSourceThroughEventAndScan(fixture, 'refund', second.id);
    await reconcileSourceThroughEventAndScan(fixture, 'refund', failed.id);

    expect(await expectSourceProjectionConservation('refund', first.id)).toHaveLength(2);
    expect(await expectSourceProjectionConservation('refund', second.id)).toHaveLength(2);
    const failedProjection = await expectSourceProjectionConservation('refund', failed.id);
    expect(failedProjection).toHaveLength(4);
    const successfulEffects = await databaseClient.db.select({
      component: financialItemAllocations.component,
      effectMinor: financialItemAllocations.effectMinor
    }).from(financialItemAllocations).innerJoin(
      financialAllocationSets,
      eq(financialAllocationSets.id, financialItemAllocations.allocationSetId)
    ).where(and(
      eq(financialAllocationSets.sourceKind, 'refund'),
      inArray(financialAllocationSets.sourceInternalId, [first.id, second.id])
    ));
    expect(successfulEffects.filter((row) => row.component === 'refund_subtotal')
      .reduce((sum, row) => sum + row.effectMinor, 0)).toBe(-1250);
    expect(successfulEffects.filter((row) => row.component === 'refund_tax')
      .reduce((sum, row) => sum + row.effectMinor, 0)).toBe(-150);

    const failedSets = await databaseClient.db.select({
      providerId: stripeBalanceTransactions.providerId,
      basis: financialAllocationSets.basis,
      id: financialAllocationSets.id,
      reversalOfSetId: financialAllocationSets.reversalOfSetId
    }).from(financialAllocationSets).innerJoin(
      stripeBalanceTransactions,
      eq(stripeBalanceTransactions.id, financialAllocationSets.balanceTransactionId)
    ).where(eq(financialAllocationSets.sourceInternalId, failed.id));
    const originalGross = failedSets.find((row) =>
      row.providerId === providerIds.failedBalance && row.basis === 'gross_amount');
    expect(failedSets.find((row) =>
      row.providerId === providerIds.failedReversal && row.basis === 'gross_amount'))
      .toMatchObject({ reversalOfSetId: originalGross?.id });
    expect(failedSets.find((row) =>
      row.providerId === providerIds.failedReversal && row.basis === 'fee'))
      .toMatchObject({ reversalOfSetId: null });
    expect(await databaseClient.db.select().from(refunds).where(inArray(
      refunds.id,
      [first.id, second.id, failed.id]
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, financialEvidenceStatus: 'fee_reconciled' }),
      expect.objectContaining({ id: second.id, financialEvidenceStatus: 'fee_reconciled' }),
      expect.objectContaining({
        id: failed.id,
        status: 'failed',
        allocationStatus: 'not_applicable',
        financialEvidenceStatus: 'fee_reconciled'
      })
    ]));
    for (const refund of [first, second, failed]) {
      expect(await databaseClient.db.select().from(auditEvents).where(and(
        eq(auditEvents.action, 'financial.refund_reconciled'),
        eq(auditEvents.resourceId, refund.id)
      ))).toHaveLength(1);
    }
  }, 15_000);

  it('converges an open dispute withdrawal through event and scan jobs without changing access', async () => {
    const fixture = await createPaidPurchase('USD');
    await reconcilePurchaseThroughJobs(fixture);
    await seedActivePurchaseAccess(fixture);
    const accessBefore = await loadPurchaseAccessSnapshot(fixture);
    const suffix = token();
    const openedAt = new Date('2026-08-10T13:30:00.000Z');
    const providerDisputeId = `dp_open_acceptance_${suffix}`;
    const providerWithdrawalId = `txn_dispute_open_acceptance_${suffix}`;
    const [dispute] = await databaseClient.db.insert(disputes).values({
      paymentId: fixture.paymentId,
      stripeDisputeId: providerDisputeId,
      status: 'open',
      amountMinor: 600,
      currency: 'USD',
      reason: 'fraudulent',
      providerCreatedAt: openedAt,
      providerUpdatedAt: openedAt
    }).returning();
    if (!dispute) throw new Error('Expected an open dispute fixture.');

    fixture.stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400,
      currency: 'usd',
      paidAt: fixture.paidAt
    }));
    fixture.stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400,
      currency: 'USD',
      balanceTransactionId: fixture.provider.balanceTransactionId,
      createdAt: fixture.paidAt
    }));
    fixture.stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId,
      paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId,
      state: 'open',
      amountMinor: 600,
      providerCreatedAt: openedAt,
      balanceTransactionIds: [providerWithdrawalId]
    }));
    fixture.stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerWithdrawalId,
      sourceId: providerDisputeId,
      sourceFamily: 'dispute',
      rawType: 'adjustment',
      reportingCategory: 'dispute',
      amountMinor: -600,
      feeMinor: 15,
      netMinor: -615,
      currency: 'USD',
      createdAt: openedAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 15, currency: 'USD' }]
    }));

    await reconcileSourceThroughEventAndScan(fixture, 'dispute', dispute.id);
    const projection = await expectSourceProjectionConservation('dispute', dispute.id);
    expect(projection).toHaveLength(2);
    expect(projection.reduce((sum, row) => sum + row.expectedEffectMinor, 0)).toBe(-615);
    const effects = await databaseClient.db.select().from(disputeItemAllocations).where(eq(
      disputeItemAllocations.disputeId,
      dispute.id
    ));
    expect(effects).toHaveLength(fixture.orderItemIds.length);
    expect(effects.every((effect) =>
      effect.effect === 'withdrawal' && effect.reversesAllocationId === null)).toBe(true);
    expect(effects.reduce((sum, effect) => sum + effect.totalEffectMinor, 0)).toBe(-600);
    expect((await databaseClient.db.select().from(disputes).where(eq(disputes.id, dispute.id)))[0])
      .toMatchObject({ status: 'open', financialEvidenceStatus: 'fee_reconciled' });
    expect(await databaseClient.db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'financial.dispute_reconciled'),
      eq(auditEvents.resourceId, dispute.id)
    ))).toHaveLength(1);
    expect(await loadPurchaseAccessSnapshot(fixture)).toEqual(accessBefore);
  }, 15_000);

  it('converges a full dispute reinstatement with exact item and allocation-set reversal identity', async () => {
    const fixture = await createPaidPurchase('USD');
    await reconcilePurchaseThroughJobs(fixture);
    await seedActivePurchaseAccess(fixture);
    const accessBefore = await loadPurchaseAccessSnapshot(fixture);
    const suffix = token();
    const withdrawnAt = new Date('2026-08-10T14:30:00.000Z');
    const reinstatedAt = new Date('2026-08-10T15:30:00.000Z');
    const providerDisputeId = `dp_full_reinstatement_${suffix}`;
    const providerWithdrawalId = `txn_dispute_full_withdrawal_${suffix}`;
    const providerReinstatementId = `txn_dispute_full_reinstatement_${suffix}`;
    const [dispute] = await databaseClient.db.insert(disputes).values({
      paymentId: fixture.paymentId,
      stripeDisputeId: providerDisputeId,
      status: 'won',
      amountMinor: 500,
      currency: 'USD',
      reason: 'fraudulent',
      providerCreatedAt: withdrawnAt,
      providerUpdatedAt: reinstatedAt
    }).returning();
    if (!dispute) throw new Error('Expected a fully reinstated dispute fixture.');

    fixture.stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400,
      currency: 'usd',
      paidAt: fixture.paidAt
    }));
    fixture.stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400,
      currency: 'USD',
      balanceTransactionId: fixture.provider.balanceTransactionId,
      createdAt: fixture.paidAt
    }));
    fixture.stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId,
      paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId,
      state: 'won',
      amountMinor: 500,
      providerCreatedAt: withdrawnAt,
      balanceTransactionIds: [providerReinstatementId, providerWithdrawalId]
    }));
    fixture.stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerWithdrawalId,
      sourceId: providerDisputeId,
      sourceFamily: 'dispute',
      rawType: 'adjustment',
      reportingCategory: 'dispute',
      amountMinor: -500,
      feeMinor: 12,
      netMinor: -512,
      currency: 'USD',
      createdAt: withdrawnAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 12, currency: 'USD' }]
    }));
    fixture.stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerReinstatementId,
      sourceId: providerDisputeId,
      sourceFamily: 'dispute',
      rawType: 'adjustment',
      reportingCategory: 'dispute_reversal',
      amountMinor: 500,
      feeMinor: 0,
      netMinor: 500,
      currency: 'USD',
      createdAt: reinstatedAt,
      feeDetails: []
    }));

    await reconcileSourceThroughEventAndScan(fixture, 'dispute', dispute.id);
    const projection = await expectSourceProjectionConservation('dispute', dispute.id);
    expect(projection).toHaveLength(4);
    expect(projection.reduce((sum, row) => sum + row.expectedEffectMinor, 0)).toBe(-12);
    const effects = await databaseClient.db.select().from(disputeItemAllocations).where(eq(
      disputeItemAllocations.disputeId,
      dispute.id
    ));
    const withdrawals = effects.filter((effect) => effect.effect === 'withdrawal');
    const reinstatements = effects.filter((effect) => effect.effect === 'reinstatement');
    expect(withdrawals.reduce((sum, effect) => sum + effect.totalEffectMinor, 0)).toBe(-500);
    expect(reinstatements.reduce((sum, effect) => sum + effect.totalEffectMinor, 0)).toBe(500);
    expect(reinstatements).toHaveLength(withdrawals.length);
    const withdrawalsById = new Map(withdrawals.map((effect) => [effect.id, effect]));
    for (const reinstatement of reinstatements) {
      const withdrawal = withdrawalsById.get(reinstatement.reversesAllocationId!);
      expect(withdrawal).toBeDefined();
      expect(reinstatement.orderItemId).toBe(withdrawal?.orderItemId);
      expect(reinstatement.subtotalEffectMinor).toBe(-(withdrawal?.subtotalEffectMinor ?? 0));
      expect(reinstatement.taxEffectMinor).toBe(-(withdrawal?.taxEffectMinor ?? 0));
      expect(reinstatement.totalEffectMinor).toBe(-(withdrawal?.totalEffectMinor ?? 0));
    }
    const sets = await databaseClient.db.select({
      providerId: stripeBalanceTransactions.providerId,
      basis: financialAllocationSets.basis,
      id: financialAllocationSets.id,
      reversalOfSetId: financialAllocationSets.reversalOfSetId
    }).from(financialAllocationSets).innerJoin(
      stripeBalanceTransactions,
      eq(stripeBalanceTransactions.id, financialAllocationSets.balanceTransactionId)
    ).where(eq(financialAllocationSets.sourceInternalId, dispute.id));
    const withdrawalGross = sets.find((set) =>
      set.providerId === providerWithdrawalId && set.basis === 'gross_amount');
    expect(sets.find((set) =>
      set.providerId === providerReinstatementId && set.basis === 'gross_amount'))
      .toMatchObject({ reversalOfSetId: withdrawalGross?.id });
    expect((await databaseClient.db.select().from(disputes).where(eq(disputes.id, dispute.id)))[0])
      .toMatchObject({ status: 'won', financialEvidenceStatus: 'fee_reconciled' });
    expect(await databaseClient.db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'financial.dispute_reconciled'),
      eq(auditEvents.resourceId, dispute.id)
    ))).toHaveLength(1);
    expect(await loadPurchaseAccessSnapshot(fixture)).toEqual(accessBefore);
  }, 15_000);

  it('converges a lost dispute withdrawal and a won partial reinstatement with exact reversal linkage', async () => {
    const fixture = await createPaidPurchase('USD');
    await reconcilePurchaseThroughJobs(fixture);
    const suffix = token();
    const lostAt = new Date('2026-08-10T14:00:00.000Z');
    const wonAt = new Date('2026-08-10T15:00:00.000Z');
    const reinstatedAt = new Date('2026-08-10T16:00:00.000Z');
    const providerIds = {
      lostDispute: `dp_lost_${suffix}`,
      wonDispute: `dp_won_${suffix}`,
      lostWithdrawal: `txn_dispute_lost_${suffix}`,
      wonWithdrawal: `txn_dispute_won_${suffix}`,
      partialReinstatement: `txn_dispute_partial_${suffix}`
    };
    const inserted = await databaseClient.db.insert(disputes).values([
      {
        paymentId: fixture.paymentId,
        stripeDisputeId: providerIds.lostDispute,
        status: 'lost',
        amountMinor: 600,
        currency: 'USD',
        reason: 'fraudulent',
        providerCreatedAt: lostAt,
        providerUpdatedAt: lostAt
      },
      {
        paymentId: fixture.paymentId,
        stripeDisputeId: providerIds.wonDispute,
        status: 'won',
        amountMinor: 500,
        currency: 'USD',
        reason: 'fraudulent',
        providerCreatedAt: wonAt,
        providerUpdatedAt: reinstatedAt
      }
    ]).returning();
    const lost = inserted.find((row) => row.stripeDisputeId === providerIds.lostDispute);
    const won = inserted.find((row) => row.stripeDisputeId === providerIds.wonDispute);
    if (!lost || !won) throw new Error('Expected canonical dispute fixtures.');

    fixture.stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400,
      currency: 'usd',
      paidAt: fixture.paidAt
    }));
    fixture.stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400,
      currency: 'USD',
      balanceTransactionId: fixture.provider.balanceTransactionId,
      createdAt: fixture.paidAt
    }));
    fixture.stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId: providerIds.lostDispute,
      paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId,
      state: 'lost',
      amountMinor: 600,
      providerCreatedAt: lostAt,
      balanceTransactionIds: [providerIds.lostWithdrawal]
    }));
    fixture.stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId: providerIds.wonDispute,
      paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId,
      state: 'won',
      amountMinor: 500,
      providerCreatedAt: wonAt,
      balanceTransactionIds: [providerIds.partialReinstatement, providerIds.wonWithdrawal]
    }));
    fixture.stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerIds.lostWithdrawal,
      sourceId: providerIds.lostDispute,
      sourceFamily: 'dispute',
      rawType: 'adjustment',
      reportingCategory: 'dispute',
      amountMinor: -600,
      feeMinor: 15,
      netMinor: -615,
      createdAt: lostAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 15, currency: 'USD' }]
    }));
    fixture.stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerIds.wonWithdrawal,
      sourceId: providerIds.wonDispute,
      sourceFamily: 'dispute',
      rawType: 'adjustment',
      reportingCategory: 'dispute',
      amountMinor: -500,
      feeMinor: 12,
      netMinor: -512,
      createdAt: wonAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 12, currency: 'USD' }]
    }));
    fixture.stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerIds.partialReinstatement,
      sourceId: providerIds.wonDispute,
      sourceFamily: 'dispute',
      rawType: 'adjustment',
      reportingCategory: 'dispute_reversal',
      amountMinor: 200,
      feeMinor: 0,
      netMinor: 200,
      createdAt: reinstatedAt,
      feeDetails: []
    }));

    await reconcileSourceThroughEventAndScan(fixture, 'dispute', lost.id);
    await reconcileSourceThroughEventAndScan(fixture, 'dispute', won.id);

    const lostProjection = await expectSourceProjectionConservation('dispute', lost.id);
    const wonProjection = await expectSourceProjectionConservation('dispute', won.id);
    expect(lostProjection).toHaveLength(2);
    expect(lostProjection.reduce((sum, row) => sum + row.expectedEffectMinor, 0)).toBe(-615);
    expect(wonProjection).toHaveLength(4);
    expect(wonProjection.reduce((sum, row) => sum + row.expectedEffectMinor, 0)).toBe(-312);

    const lostEffects = await databaseClient.db.select().from(disputeItemAllocations)
      .where(eq(disputeItemAllocations.disputeId, lost.id));
    expect(lostEffects.every((row) =>
      row.effect === 'withdrawal' && row.reversesAllocationId === null)).toBe(true);
    expect(lostEffects.reduce((sum, row) => sum + row.totalEffectMinor, 0)).toBe(-600);

    const wonEffects = await databaseClient.db.select().from(disputeItemAllocations)
      .where(eq(disputeItemAllocations.disputeId, won.id));
    const withdrawals = wonEffects.filter((row) => row.effect === 'withdrawal');
    const reinstatements = wonEffects.filter((row) => row.effect === 'reinstatement');
    expect(withdrawals.reduce((sum, row) => sum + row.totalEffectMinor, 0)).toBe(-500);
    expect(reinstatements.reduce((sum, row) => sum + row.totalEffectMinor, 0)).toBe(200);
    const withdrawalById = new Map(withdrawals.map((row) => [row.id, row]));
    for (const reinstatement of reinstatements) {
      const withdrawal = withdrawalById.get(reinstatement.reversesAllocationId!);
      expect(withdrawal).toBeDefined();
      expect(reinstatement.orderItemId).toBe(withdrawal?.orderItemId);
      expect(reinstatement.totalEffectMinor).toBeGreaterThan(0);
      expect(reinstatement.totalEffectMinor).toBeLessThanOrEqual(
        Math.abs(withdrawal?.totalEffectMinor ?? 0)
      );
    }

    const wonSets = await databaseClient.db.select({
      providerId: stripeBalanceTransactions.providerId,
      basis: financialAllocationSets.basis,
      id: financialAllocationSets.id,
      reversalOfSetId: financialAllocationSets.reversalOfSetId
    }).from(financialAllocationSets).innerJoin(
      stripeBalanceTransactions,
      eq(stripeBalanceTransactions.id, financialAllocationSets.balanceTransactionId)
    ).where(eq(financialAllocationSets.sourceInternalId, won.id));
    const withdrawalGross = wonSets.find((row) =>
      row.providerId === providerIds.wonWithdrawal && row.basis === 'gross_amount');
    expect(wonSets.find((row) =>
      row.providerId === providerIds.partialReinstatement && row.basis === 'gross_amount'))
      .toMatchObject({ reversalOfSetId: withdrawalGross?.id });
    expect(await databaseClient.db.select().from(disputes).where(inArray(
      disputes.id,
      [lost.id, won.id]
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: lost.id,
        status: 'lost',
        financialEvidenceStatus: 'fee_reconciled'
      }),
      expect.objectContaining({
        id: won.id,
        status: 'won',
        financialEvidenceStatus: 'fee_reconciled'
      })
    ]));
    for (const dispute of [lost, won]) {
      expect(await databaseClient.db.select().from(auditEvents).where(and(
        eq(auditEvents.action, 'financial.dispute_reconciled'),
        eq(auditEvents.resourceId, dispute.id)
      ))).toHaveLength(1);
    }
  }, 15_000);

  it('publishes an automatic payout once, then immediately reopens derived state on canonical failure', async () => {
    const fixture = await createPaidPurchase('USD');
    await reconcilePurchaseThroughJobs(fixture);
    const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions)
      .where(eq(stripeBalanceTransactions.providerId, fixture.provider.balanceTransactionId));
    if (!balance) throw new Error('Expected a staged payment balance transaction.');

    const providerPayoutId = `po_reconciliation_${token()}`;
    const paid = payoutSnapshotFixture({
      id: providerPayoutId,
      amountMinor: fixture.settlement.netMinor,
      currency: fixture.settlement.currency,
      balanceTransactionId: null
    });
    fixture.stripe.harness.setPayout(paid);
    fixture.stripe.harness.setBalanceTransactionsForPayout(providerPayoutId, [
      balanceTransactionSnapshotFixture({
        id: fixture.provider.balanceTransactionId,
        sourceId: fixture.provider.chargeId,
        amountMinor: fixture.settlement.amountMinor,
        feeMinor: fixture.settlement.feeMinor,
        netMinor: fixture.settlement.netMinor,
        currency: fixture.settlement.currency,
        createdAt: fixture.paidAt,
        feeDetails: [{
          ordinal: 0,
          rawType: 'stripe_fee',
          amountMinor: fixture.settlement.feeMinor,
          currency: fixture.settlement.currency
        }]
      })
    ]);
    await enqueuePayout(createFinancialPayoutEventJob({
      providerPayoutId,
      providerEventId: `evt_payout_paid_${token()}`
    }));
    await drainFinancialJobs(financialHandlers(fixture.stripe.gateway));

    const payment = (await databaseClient.db.select().from(payments)
      .where(eq(payments.id, fixture.paymentId)))[0]!;
    const paidEvidence = await loadCurrentPayoutEvidence(databaseClient.db, [balance.id]);
    expect(paidEvidence).toEqual({
      relevantBalanceTransactionCount: 1,
      authoritativeMembershipCount: 1,
      paidAutomaticStandardCompletedCount: 1,
      conflictingMembershipCount: 0,
      hasOpenExceptionIssue: false,
      hasMissingPayoutReversal: false
    });
    expect(derivePublicFinancialState({
      financialEvidenceStatus: payment.financialEvidenceStatus,
      payoutEvidence: paidEvidence
    })).toBe('payout_reconciled');

    const failed = { ...paid, status: 'failed' as const, safeFailureCode: 'provider_failed' };
    fixture.stripe.harness.setPayout(failed);
    const failedSpec = createFinancialPayoutEventJob({
      providerPayoutId,
      providerEventId: `evt_payout_failed_${token()}`
    });
    const failedId = await enqueuePayout(failedSpec);
    const outOfOrderWhileActive = await enqueuePayout(createFinancialPayoutEventJob({
      providerPayoutId,
      providerEventId: `evt_payout_stale_paid_${token()}`
    }));
    expect(outOfOrderWhileActive).toBe(failedId);
    await drainFinancialJobs(financialHandlers(fixture.stripe.gateway));

    const lateOldEventId = await enqueuePayout(createFinancialPayoutEventJob({
      providerPayoutId,
      providerEventId: `evt_payout_late_paid_${token()}`
    }));
    expect(lateOldEventId).not.toBe(failedId);
    await drainFinancialJobs(financialHandlers(fixture.stripe.gateway));

    const failedEvidence = await loadCurrentPayoutEvidence(databaseClient.db, [balance.id]);
    expect(failedEvidence).toMatchObject({
      authoritativeMembershipCount: 1,
      paidAutomaticStandardCompletedCount: 0,
      hasMissingPayoutReversal: true
    });
    expect(derivePublicFinancialState({
      financialEvidenceStatus: payment.financialEvidenceStatus,
      payoutEvidence: failedEvidence
    })).toBe('exception');
    expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions)
      .where(eq(stripePayoutBalanceTransactions.balanceTransactionId, balance.id)))
      .toHaveLength(1);
    expect((await databaseClient.db.select().from(stripePayouts)
      .where(eq(stripePayouts.providerId, providerPayoutId)))[0]).toMatchObject({
      status: 'failed',
      financialGeneration: 2
    });
    expect(await databaseClient.db.select().from(auditEvents).where(eq(
      auditEvents.action, 'financial.payout.membership_published'
    ))).toHaveLength(1);
  });

  it.each([
    { label: 'manual', automatic: false, method: 'standard' as const },
    { label: 'instant', automatic: true, method: 'instant' as const }
  ])('keeps a $label payout fee-reconciled without authoritative membership', async ({
    automatic, method
  }) => {
    const fixture = await createPaidPurchase('USD');
    await reconcilePurchaseThroughJobs(fixture);
    const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions)
      .where(eq(stripeBalanceTransactions.providerId, fixture.provider.balanceTransactionId));
    if (!balance) throw new Error('Expected a staged payment balance transaction.');

    const providerPayoutId = `po_nonautomatic_${token()}`;
    fixture.stripe.harness.setPayout(payoutSnapshotFixture({
      id: providerPayoutId,
      amountMinor: fixture.settlement.netMinor,
      balanceTransactionId: null,
      automatic,
      method,
      reconciliationStatus: 'not_applicable'
    }));
    await enqueuePayout(createFinancialPayoutEventJob({
      providerPayoutId,
      providerEventId: `evt_nonautomatic_${token()}`
    }));
    await drainFinancialJobs(financialHandlers(fixture.stripe.gateway));

    const evidence = await loadCurrentPayoutEvidence(databaseClient.db, [balance.id]);
    expect(evidence).toMatchObject({
      relevantBalanceTransactionCount: 1,
      authoritativeMembershipCount: 0,
      paidAutomaticStandardCompletedCount: 0
    });
    expect(derivePublicFinancialState({
      financialEvidenceStatus: 'fee_reconciled',
      payoutEvidence: evidence
    })).toBe('fee_reconciled');
    expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions)).toHaveLength(0);
    expect(await databaseClient.db.select().from(payoutImportRuns)).toHaveLength(0);
  });

  it('rolls payout membership, generation, impact handoff, and audit back as one mutation', async () => {
    const suffix = token();
    const stagedBalance = await stageBalanceTransaction(
      databaseClient.db,
      balanceTransactionSnapshotFixture({
        id: `txn_audit_rollback_${suffix}`,
        sourceId: null,
        sourceFamily: 'adjustment',
        rawType: 'adjustment',
        reportingCategory: 'other_adjustment',
        amountMinor: 25,
        feeMinor: 0,
        netMinor: 25,
        feeDetails: []
      }),
      { correlationId: `rollback-balance-${suffix}` }
    );
    const stagedPayout = await stagePayoutSnapshot(databaseClient.db, payoutSnapshotFixture({
      id: `po_audit_rollback_${suffix}`,
      amountMinor: 25,
      balanceTransactionId: null
    }), { correlationId: `rollback-payout-${suffix}` });
    const run = await startOrResumePayoutImport(databaseClient.db, {
      payoutId: stagedPayout.payoutId,
      expectedGeneration: 0,
      correlationId: `rollback-run-${suffix}`
    });
    await persistPayoutImportPage(databaseClient.db, {
      payoutId: stagedPayout.payoutId,
      runId: run.id,
      expectedGeneration: 0,
      expectedPageCount: 0,
      expectedStartingAfter: null,
      balanceTransactionIds: [stagedBalance.balanceTransactionId],
      hasMore: false,
      nextStartingAfter: null,
      correlationId: `rollback-page-${suffix}`
    });

    const triggerName = `payout_audit_fail_${suffix}`;
    const functionName = `${triggerName}_fn`;
    await databaseClient.db.execute(sql.raw(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.action = 'financial.payout.membership_published' then
          raise exception 'forced financial payout audit failure';
        end if;
        return new;
      end;
      $$
    `));
    await databaseClient.db.execute(sql.raw(`
      create trigger ${triggerName} before insert on audit_events
      for each row execute function ${functionName}()
    `));
    try {
      await expect(publishPayoutMembership(databaseClient.db, {
        payoutId: stagedPayout.payoutId,
        runId: run.id,
        expectedGeneration: 0,
        correlationId: `rollback-publish-${suffix}`
      })).rejects.toThrow();
    } finally {
      await databaseClient.db.execute(sql.raw(`drop trigger ${triggerName} on audit_events`));
      await databaseClient.db.execute(sql.raw(`drop function ${functionName}()`));
    }

    expect(await databaseClient.db.select().from(stripePayoutBalanceTransactions)).toHaveLength(0);
    expect((await databaseClient.db.select().from(stripePayouts)
      .where(eq(stripePayouts.id, stagedPayout.payoutId)))[0]?.financialGeneration).toBe(0);
    expect((await databaseClient.db.select().from(payoutImportRuns)
      .where(eq(payoutImportRuns.id, run.id)))[0]).toMatchObject({
      state: 'publishable',
      generation: 0,
      completedAt: null
    });
    expect(await databaseClient.db.select().from(jobs).where(eq(
      jobs.deduplicationKey,
      `financial:payout-impact:${stagedPayout.payoutId}:1`
    ))).toHaveLength(0);
    expect(await databaseClient.db.select().from(auditEvents).where(eq(
      auditEvents.action,
      'financial.payout.membership_published'
    ))).toHaveLength(0);
  });

  it('replays a durable unknown adjustment to one supported append-only version and new tips', async () => {
    const suffix = token();
    const snapshot = balanceTransactionSnapshotFixture({
      id: `txn_classifier_replay_${suffix}`,
      sourceId: null,
      sourceFamily: 'adjustment',
      rawType: 'adjustment',
      reportingCategory: 'other_adjustment',
      amountMinor: 25,
      feeMinor: 0,
      netMinor: 25,
      feeDetails: []
    });
    const fingerprint = fingerprintBalanceTransaction(snapshot);
    const [balance] = await databaseClient.db.insert(stripeBalanceTransactions).values({
      providerId: snapshot.id,
      liveMode: snapshot.livemode,
      sourceFamily: snapshot.sourceFamily,
      sourceId: snapshot.sourceId,
      rawType: snapshot.rawType,
      reportingCategory: snapshot.reportingCategory,
      balanceType: snapshot.balanceType,
      amountMinor: snapshot.amountMinor,
      feeMinor: snapshot.feeMinor,
      netMinor: snapshot.netMinor,
      currency: snapshot.currency,
      status: snapshot.status,
      providerCreatedAt: snapshot.createdAt,
      availableAt: snapshot.availableAt,
      fingerprintSha256: fingerprint
    }).returning();
    if (!balance) throw new Error('Expected a replay balance fixture.');
    await databaseClient.db.insert(financialClassificationVersions).values({
      subjectType: 'balance_transaction',
      subjectId: balance.id,
      classifierVersion: 1,
      classification: 'unknown',
      sourceFingerprintSha256: fingerprint
    });
    const oldSets = await databaseClient.db.insert(financialAllocationSets).values([
      {
        allocationIdentity: `adjustment:${balance.id}:${balance.id}:replay:c1-a1:gross`,
        balanceTransactionId: balance.id,
        sourceKind: 'adjustment' as const,
        sourceInternalId: balance.id,
        basis: 'gross_amount' as const,
        scope: 'account' as const,
        expectedEffectMinor: 25,
        currency: 'USD',
        algorithmVersion: 1,
        classifierVersion: 1,
        sourceFingerprintSha256: fingerprint
      },
      {
        allocationIdentity: `adjustment:${balance.id}:${balance.id}:replay:c1-a1:fee`,
        balanceTransactionId: balance.id,
        sourceKind: 'adjustment' as const,
        sourceInternalId: balance.id,
        basis: 'fee' as const,
        scope: 'account' as const,
        expectedEffectMinor: 0,
        currency: 'USD',
        algorithmVersion: 1,
        classifierVersion: 1,
        sourceFingerprintSha256: fingerprint
      }
    ]).returning();
    await databaseClient.db.insert(financialReconciliationIssues).values({
      resourceType: 'balance_transaction',
      resourceId: balance.id,
      safeCode: 'unsupported_category',
      impact: 'exception',
      correlationId: `unknown-v1-${suffix}`
    });
    const oldRowsBefore = await databaseClient.db.select().from(financialAllocationSets)
      .where(inArray(financialAllocationSets.id, oldSets.map((row) => row.id)))
      .orderBy(asc(financialAllocationSets.id));

    const replaySpec = createFinancialClassificationSubjectJob({
      subjectType: 'balance_transaction',
      subjectId: balance.id,
      sourceFingerprintSha256: fingerprint,
      classifierVersion: 2,
      allocationAlgorithmVersion: 1
    });
    const queued = await enqueueJob(databaseClient.db, {
      type: replaySpec.type,
      payload: replaySpec.payload as JsonObject,
      deduplicationKey: replaySpec.deduplicationKey,
      maxAttempts: replaySpec.maxAttempts
    });
    await drainFinancialJobs(financialHandlers({} as StripeCommerceGateway, {
      classifierVersion: 2,
      allocationAlgorithmVersion: 1
    }));

    expect((await databaseClient.db.select().from(jobs)
      .where(eq(jobs.id, queued.id)))[0]).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(await databaseClient.db.select().from(financialProjectionVersions)).toEqual([
      expect.objectContaining({ classifierVersion: 2, allocationAlgorithmVersion: 1 })
    ]);
    expect((await databaseClient.db.select({
      classifierVersion: financialClassificationVersions.classifierVersion,
      classification: financialClassificationVersions.classification
    }).from(financialClassificationVersions)
      .where(eq(financialClassificationVersions.subjectId, balance.id))
      .orderBy(asc(financialClassificationVersions.classifierVersion))))
      .toEqual([
        { classifierVersion: 1, classification: 'unknown' },
        { classifierVersion: 2, classification: 'other' }
      ]);

    const allSets = await databaseClient.db.select().from(financialAllocationSets)
      .where(eq(financialAllocationSets.balanceTransactionId, balance.id));
    expect(allSets).toHaveLength(4);
    expect(await databaseClient.db.select().from(financialAllocationSets)
      .where(inArray(financialAllocationSets.id, oldSets.map((row) => row.id)))
      .orderBy(asc(financialAllocationSets.id))).toEqual(oldRowsBefore);
    for (const oldSet of oldSets) {
      expect(allSets.filter((candidate) => candidate.supersedesSetId === oldSet.id)).toEqual([
        expect.objectContaining({
          basis: oldSet.basis,
          classifierVersion: 2,
          algorithmVersion: 1,
          expectedEffectMinor: oldSet.expectedEffectMinor,
          scope: 'account'
        })
      ]);
    }
    expect(await databaseClient.db.select().from(currentFinancialProjectionHeads)
      .where(eq(currentFinancialProjectionHeads.balanceTransactionId, balance.id))
      .orderBy(asc(currentFinancialProjectionHeads.basis))).toEqual([
      expect.objectContaining({
        basis: 'gross_amount', scope: 'account', expectedEffectMinor: 25, isComplete: true
      }),
      expect.objectContaining({
        basis: 'fee', scope: 'account', expectedEffectMinor: 0, isComplete: true
      })
    ]);
    expect((await databaseClient.db.select().from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.resourceId, balance.id)))[0]).toMatchObject({
      safeCode: 'unsupported_category',
      state: 'resolved'
    });
    expect(await databaseClient.db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'financial.allocation.superseded'),
      inArray(auditEvents.resourceId, allSets
        .filter((row) => row.classifierVersion === 2)
        .map((row) => row.id))
    ))).toHaveLength(2);

    const replayedQueue = await enqueueJob(databaseClient.db, {
      type: replaySpec.type,
      payload: replaySpec.payload as JsonObject,
      deduplicationKey: replaySpec.deduplicationKey,
      maxAttempts: replaySpec.maxAttempts
    });
    expect(replayedQueue.id).toBe(queued.id);
    expect(await drainFinancialJobs(financialHandlers({} as StripeCommerceGateway, {
      classifierVersion: 2,
      allocationAlgorithmVersion: 1
    }))).toEqual([]);
    expect(await databaseClient.db.select().from(financialAllocationSets)
      .where(eq(financialAllocationSets.balanceTransactionId, balance.id))).toHaveLength(4);
  });
});
