import { randomUUID } from 'node:crypto';
import { eq, sql, type SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  fingerprintBalanceTransaction,
  rearmCurrentProjectionSubjectsForFinancialSources,
  stageBalanceTransaction
} from '$lib/server/commerce/financial/ledger';
import { appendClassificationDecisionLocked } from '$lib/server/commerce/financial/classification';
import {
  rebaseApprovedCorrectionDistributionLocked,
  replayFinancialClassification,
  replayFinancialClassificationLocked
} from '$lib/server/commerce/financial/rebase';
import { createFinancialClassificationHandler } from '$lib/server/commerce/financial/handlers/classification';
import {
  commitFinancialScanPage,
  finalizeFinancialReplay,
  loadClassificationReplayPage,
  startOrResumeFinancialScan
} from '$lib/server/commerce/financial/scans/repository';
import { createFinancialClassificationSubjectJob } from '$lib/server/commerce/financial/jobs';
import {
  loadCurrentEffectiveAllocationProjection,
  persistFinancialAllocationPlanLocked,
  persistFinancialAllocationReplayPlanLocked
} from '$lib/server/commerce/financial/allocations/repository';
import { FINANCIAL_ALLOCATION_ALGORITHM_VERSION } from '$lib/server/commerce/financial/constants';
import { observeFinancialIssue } from '$lib/server/commerce/financial/issues';
import { lockOrder } from '$lib/server/commerce/lock';
import { lockPaymentPurchaseFacts } from '$lib/server/commerce/reconciliation';
import {
  disputes, guestIdentities, orderItems, orders, payments,
  refundAllocationComponents, refundAllocations, refunds, titles
} from '$lib/server/db/schema';
import {
  createPostgresJobRepository,
  enqueueJob,
  rearmFinancialClassificationJob
} from '$lib/server/jobs/repository';
import {
  financialClassificationVersions,
  stripeBalanceTransactions
} from '$lib/server/db/schema/financial-provider';
import {
  applicationConfig,
  ownerDatabaseClient,
  workerDatabaseClient,
  workerDatabaseClient as databaseClient
} from './database';

const dialect = new PgDialect();

function rendered(query: unknown): string {
  return dialect.sqlToQuery((query as SQLWrapper).getSQL()).sql;
}

async function activateProjectionVersionForFixture(
  transaction: DatabaseTransaction,
  input: {
    classifierVersion: number;
    allocationAlgorithmVersion: number;
    correlationId: string;
  }
): Promise<void> {
  const scanRunId = randomUUID();
  await transaction.execute(sql`
    update financial_projection_versions set
      pending_classifier_version = ${input.classifierVersion},
      pending_allocation_algorithm_version = ${input.allocationAlgorithmVersion},
      pending_replay_id = ${`c${input.classifierVersion}-a${input.allocationAlgorithmVersion}`},
      pending_scan_run_id = ${scanRunId}
    where singleton = true
  `);
  await transaction.execute(sql`
    update financial_projection_versions set
      classifier_version = ${input.classifierVersion},
      allocation_algorithm_version = ${input.allocationAlgorithmVersion},
      pending_classifier_version = null, pending_allocation_algorithm_version = null,
      pending_replay_id = null, pending_scan_run_id = null,
      activated_at = now(), activation_correlation_id = ${input.correlationId}
    where singleton = true
  `);
}

async function resetProjectionVersionForFixture(input: {
  classifierVersion: number;
  allocationAlgorithmVersion: number;
  correlationId: string;
}): Promise<void> {
  await ownerDatabaseClient.db.execute(sql`truncate table financial_projection_versions`);
  await ownerDatabaseClient.db.execute(sql`
    insert into financial_projection_versions
      (singleton, classifier_version, allocation_algorithm_version,
        activation_correlation_id)
    values (true, ${input.classifierVersion}, ${input.allocationAlgorithmVersion},
      ${input.correlationId})
  `);
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

async function adjustmentFixture(
  label: string,
  algorithmVersion = FINANCIAL_ALLOCATION_ALGORITHM_VERSION
) {
  const suffix = `${label}_${randomUUID().replaceAll('-', '')}`;
  const staged = await stageBalanceTransaction(databaseClient.db, {
    id: `txn_${suffix}`, livemode: false, sourceFamily: 'adjustment', sourceId: null,
    rawType: 'adjustment', reportingCategory: 'other_adjustment', balanceType: 'adjustment',
    amountMinor: 25, feeMinor: 0, netMinor: 25, currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T00:00:00.000Z'),
    availableAt: new Date('2026-08-12T01:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
  }, { correlationId: `${label}-stage` });
  const fingerprint = (await databaseClient.pool.query<{ fingerprint_sha256: string }>(
    'select fingerprint_sha256 from stripe_balance_transactions where id=$1',
    [staged.balanceTransactionId]
  )).rows[0]!.fingerprint_sha256;
  const common = {
    balanceTransactionId: staged.balanceTransactionId, scope: 'account' as const,
    currency: 'USD', algorithmVersion, sourceFingerprint: fingerprint,
    supersedesSetId: null, reversalOfSetId: null, items: []
  };
  const persist = (transaction: DatabaseTransaction,
    input: Parameters<typeof persistFinancialAllocationPlanLocked>[1]) =>
    algorithmVersion === FINANCIAL_ALLOCATION_ALGORITHM_VERSION
      ? persistFinancialAllocationPlanLocked(transaction, input)
      : persistFinancialAllocationReplayPlanLocked(transaction, input, {
          classifierVersion: 1, allocationAlgorithmVersion: algorithmVersion
        });
  const roots = await databaseClient.db.transaction(async (tx) => [
    await persist(tx, {
      sourceKind: 'adjustment', sourceId: staged.balanceTransactionId,
      classificationVersion: 1, correlationId: `${label}-gross`,
      plan: { ...common, allocationIdentity: `adjustment:${suffix}:gross`,
        basis: 'gross_amount', expectedEffectMinor: 25 }
    }),
    await persist(tx, {
      sourceKind: 'adjustment', sourceId: staged.balanceTransactionId,
      classificationVersion: 1, correlationId: `${label}-fee`,
      plan: { ...common, allocationIdentity: `adjustment:${suffix}:fee`,
        basis: 'fee', expectedEffectMinor: 0 }
    })
  ]);
  return { balanceTransactionId: staged.balanceTransactionId, fingerprint, roots };
}

async function legacyUnknownAdjustmentFixture(label: string) {
  const providerId = `txn_${label}_${randomUUID().replaceAll('-', '')}`;
  const snapshot = {
    id: providerId, livemode: false, sourceFamily: 'adjustment', sourceId: null,
    rawType: 'adjustment', reportingCategory: 'other_adjustment',
    balanceType: 'adjustment', amountMinor: 25, feeMinor: 0, netMinor: 25,
    currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T00:00:00.000Z'),
    availableAt: new Date('2026-08-12T01:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
  } as const;
  const fingerprint = fingerprintBalanceTransaction(snapshot);
  const [balance] = await databaseClient.db.insert(stripeBalanceTransactions).values({
    providerId, liveMode: false, sourceFamily: 'adjustment', sourceId: null,
    rawType: 'adjustment', reportingCategory: 'other_adjustment',
    balanceType: 'adjustment', amountMinor: 25, feeMinor: 0, netMinor: 25,
    currency: 'USD', status: 'available', providerCreatedAt: snapshot.createdAt,
    availableAt: snapshot.availableAt, fingerprintSha256: fingerprint
  }).returning();
  if (!balance) throw new Error('Expected legacy replay balance');
  await databaseClient.db.transaction(async (tx) => {
    const [classification] = await tx.insert(financialClassificationVersions).values({
      subjectType: 'balance_transaction', subjectId: balance.id,
      classifierVersion: 1, classification: 'unknown',
      sourceFingerprintSha256: fingerprint
    }).returning();
    if (!classification) throw new Error('Expected legacy unknown classification');
    await observeFinancialIssue(tx, {
      resourceType: 'financial_classification', resourceId: classification.id,
      safeCode: 'unsupported_category', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: `legacy-unknown-${label}`
    });
  });
  return { balanceTransactionId: balance.id, fingerprint };
}

async function chargeFixture(
  label: string,
  withRefund = false,
  seedCurrentVersion = true,
  withFeeDetail = false
) {
  const suffix = `${label}_${randomUUID().replaceAll('-', '')}`;
  const orderId = randomUUID();
  const itemId = randomUUID();
  const titleId = randomUUID();
  const chargeId = `ch_${suffix}`;
  const [guest] = await ownerDatabaseClient.db.insert(guestIdentities).values({
    email: `${suffix}@example.com`
  }).returning();
  if (!guest) throw new Error('Expected replay guest fixture');
  await ownerDatabaseClient.db.insert(titles).values({
    id: titleId, slug: `replay-${randomUUID()}`, title: 'Replay title',
    description: 'Replay description',
    creatorName: 'Replay creator', format: 'prose', priceMinor: 100,
    currency: 'USD', visibility: 'private'
  });
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId, status: 'paid', guestIdentityId: guest.id, purchaseEmail: guest.email,
    currency: 'USD', subtotalMinor: 100, taxMinor: 0, totalMinor: 100,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'b'.repeat(64),
    stripeCheckoutSessionId: `cs_${suffix}`, statusTokenSha256: 'c'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-12T00:30:00.000Z'),
    paidAt: new Date('2026-08-12T00:00:00.000Z')
  });
  await ownerDatabaseClient.db.insert(orderItems).values({
    id: itemId, orderId, titleId, titleSnapshot: 'Replay title',
    creatorNameSnapshot: 'Replay creator', format: 'prose', currency: 'USD',
    unitSubtotalMinor: 100, taxMinor: 0, totalMinor: 100,
    stripeLineItemId: `li_${suffix}`
  });
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId, stripePaymentIntentId: `pi_${suffix}`, stripeLatestChargeId: chargeId,
    status: 'succeeded', amountMinor: 100, currency: 'USD',
    paymentMethodCategory: 'card', paidAt: new Date('2026-08-12T00:00:00.000Z')
  }).returning();
  if (!payment) throw new Error('Expected replay payment fixture');
  const [refund] = withRefund
    ? await ownerDatabaseClient.db.insert(refunds).values({
        paymentId: payment.id, stripeRefundId: `re_${suffix}`, status: 'succeeded',
        amountMinor: 100, currency: 'USD', providerCreatedAt: new Date('2026-08-12T00:10:00.000Z'),
        allocationStatus: 'draft'
      }).returning()
    : [undefined];
  const staged = await stageBalanceTransaction(databaseClient.db, {
    id: `txn_${suffix}`, livemode: false, sourceFamily: 'charge', sourceId: chargeId,
    rawType: 'charge', reportingCategory: 'charge', balanceType: 'payments',
    amountMinor: 100, feeMinor: withFeeDetail ? 10 : 0,
    netMinor: withFeeDetail ? 90 : 100, currency: 'USD', status: 'available',
    createdAt: new Date('2026-08-12T00:00:00.000Z'),
    availableAt: new Date('2026-08-12T01:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null,
    feeDetails: withFeeDetail
      ? [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 10, currency: 'USD' }]
      : []
  }, { correlationId: `${label}-stage` });
  const fingerprint = (await databaseClient.pool.query<{ fingerprint_sha256: string }>(
    'select fingerprint_sha256 from stripe_balance_transactions where id=$1',
    [staged.balanceTransactionId]
  )).rows[0]!.fingerprint_sha256;
  const feeDetail = withFeeDetail
    ? (await databaseClient.pool.query<{
        id: string; fingerprint_sha256: string;
      }>(`select id, fingerprint_sha256
          from stripe_balance_transaction_fee_details
          where balance_transaction_id=$1`, [staged.balanceTransactionId])).rows[0]
    : undefined;
  const common = {
    balanceTransactionId: staged.balanceTransactionId, scope: 'title' as const,
    currency: 'USD', algorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
    sourceFingerprint: fingerprint, supersedesSetId: null, reversalOfSetId: null
  };
  if (seedCurrentVersion) await databaseClient.db.transaction(async (tx) => {
    await persistFinancialAllocationPlanLocked(tx, {
      sourceKind: 'payment', sourceId: payment.id, classificationVersion: 1,
      correlationId: `${label}-gross`, plan: {
        ...common, allocationIdentity: `payment:${payment.id}:gross`,
        basis: 'gross_amount', expectedEffectMinor: 100,
        items: [{ orderItemId: itemId, component: 'sale_subtotal', effectMinor: 100,
          currency: 'USD', tieBreakKey: itemId }]
      }
    });
    await persistFinancialAllocationPlanLocked(tx, {
      sourceKind: 'payment', sourceId: payment.id, classificationVersion: 1,
      correlationId: `${label}-fee`, plan: {
        ...common, allocationIdentity: `payment:${payment.id}:fee`, basis: 'fee',
        expectedEffectMinor: 0, items: []
      }
    });
  });
  return { orderId, itemId, paymentId: payment.id, refundId: refund?.id,
    balanceTransactionId: staged.balanceTransactionId, fingerprint,
    feeDetailId: feeDetail?.id, feeDetailFingerprint: feeDetail?.fingerprint_sha256 };
}

async function correctionRebaseGraph(label: string) {
  const suffix = `${label}_${randomUUID().replaceAll('-', '')}`;
  const [guest] = await ownerDatabaseClient.db.insert(guestIdentities).values({
    email: `${suffix}@example.com`
  }).returning();
  if (!guest) throw new Error('Expected correction replay guest');
  const admin = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into "user" (name, email, email_verified)
     values ('Correction admin', $1, true) returning id`,
    [`admin_${suffix}@example.com`]
  );
  const titleIds: string[] = [];
  for (const side of ['a', 'b']) {
    const [title] = await ownerDatabaseClient.db.insert(titles).values({
      slug: `rebase-${side}-${randomUUID()}`, title: `Rebase ${side}`,
      description: 'Rebase description', creatorName: 'Rebase creator',
      format: 'prose', priceMinor: 100, currency: 'USD', visibility: 'private'
    }).returning();
    if (!title) throw new Error('Expected correction replay title');
    titleIds.push(title.id);
  }
  const orderId = randomUUID();
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId, status: 'paid', guestIdentityId: guest.id, purchaseEmail: guest.email,
    currency: 'USD', subtotalMinor: 200, taxMinor: 0, totalMinor: 200,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: '8'.repeat(64),
    stripeCheckoutSessionId: `cs_${suffix}`, statusTokenSha256: '9'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-12T00:30:00.000Z'),
    paidAt: new Date('2026-08-12T00:00:00.000Z')
  });
  const itemIds: string[] = [];
  for (const [index, titleId] of titleIds.entries()) {
    const [item] = await ownerDatabaseClient.db.insert(orderItems).values({
      orderId, titleId, titleSnapshot: `Rebase ${index}`,
      creatorNameSnapshot: 'Rebase creator', format: 'prose', currency: 'USD',
      unitSubtotalMinor: 100, taxMinor: 0, totalMinor: 100,
      stripeLineItemId: `li_${index}_${suffix}`
    }).returning();
    if (!item) throw new Error('Expected correction replay item');
    itemIds.push(item.id);
  }
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId, stripePaymentIntentId: `pi_${suffix}`, stripeLatestChargeId: `ch_${suffix}`,
    status: 'succeeded', amountMinor: 200, currency: 'USD',
    paymentMethodCategory: 'card', paidAt: new Date('2026-08-12T00:00:00.000Z')
  }).returning();
  if (!payment || !admin.rows[0] || itemIds.length !== 2) {
    throw new Error('Expected complete correction replay graph');
  }
  return { adminId: admin.rows[0].id, orderId, paymentId: payment.id,
    itemA: itemIds[0]!, itemB: itemIds[1]! };
}

async function finalizedRefundEvidence(
  graph: Awaited<ReturnType<typeof correctionRebaseGraph>>,
  label: string,
  distribution: readonly [number, number],
  allocationStatus: 'draft' | 'finalized' = 'finalized'
) {
  const suffix = `${label}_${randomUUID().replaceAll('-', '')}`;
  const providerRefundId = `re_${suffix}`;
  const amountMinor = distribution[0] + distribution[1];
  const [refund] = await databaseClient.db.insert(refunds).values({
    paymentId: graph.paymentId, stripeRefundId: providerRefundId, status: 'succeeded',
    amountMinor, currency: 'USD', providerCreatedAt: new Date('2026-08-12T00:10:00.000Z'),
    allocationStatus
  }).returning();
  if (!refund) throw new Error('Expected correction replay refund');
  for (const [index, amount] of allocationStatus === 'finalized'
    ? distribution.entries() : []) {
    if (amount === 0) continue;
    const orderItemId = index === 0 ? graph.itemA : graph.itemB;
    const allocation = await databaseClient.pool.query<{ id: string }>(
      `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
       values ($1, $2, $3, 'administrative') returning id`,
      [refund.id, orderItemId, amount]
    );
    await databaseClient.pool.query(
      `insert into refund_allocation_components
         (refund_allocation_id, refund_id, order_item_id, subtotal_minor, tax_minor,
          total_minor, currency)
       values ($1, $2, $3, $4, 0, $4, 'USD')`,
      [allocation.rows[0]!.id, refund.id, orderItemId, amount]
    );
  }
  const staged = await stageBalanceTransaction(databaseClient.db, {
    id: `txn_${suffix}`, livemode: false, sourceFamily: 'refund', sourceId: providerRefundId,
    rawType: 'refund', reportingCategory: 'refund', balanceType: 'payments',
    amountMinor: -amountMinor, feeMinor: 0, netMinor: -amountMinor,
    currency: 'USD', status: 'available', createdAt: new Date('2026-08-12T00:10:00.000Z'),
    availableAt: new Date('2026-08-12T01:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
  }, { correlationId: `${label}-stage` });
  const fingerprint = (await databaseClient.pool.query<{ fingerprint_sha256: string }>(
    'select fingerprint_sha256 from stripe_balance_transactions where id=$1',
    [staged.balanceTransactionId]
  )).rows[0]!.fingerprint_sha256;
  await databaseClient.db.transaction((tx) => appendClassificationDecisionLocked(tx, {
    subjectType: 'balance_transaction', subjectId: staged.balanceTransactionId,
    classifierVersion: 2, sourceFingerprint: fingerprint,
    decision: { status: 'classified', classification: 'refund', impact: 'informational' },
    correlationId: `${label}-classify-v2`
  }));
  return { refundId: refund.id, balanceTransactionId: staged.balanceTransactionId,
    fingerprint, amountMinor };
}

async function stagedDisputeEvidence(
  graph: Awaited<ReturnType<typeof correctionRebaseGraph>>,
  label: string,
  kind: 'withdrawal' | 'other' | 'unknown' | 'fee_credit'
) {
  const suffix = `${label}_${randomUUID().replaceAll('-', '')}`;
  const providerDisputeId = `dp_${suffix}`;
  const createdAt = new Date('2026-08-12T00:05:00.000Z');
  const amountMinor = kind === 'fee_credit' ? 10 : -100;
  const [dispute] = await databaseClient.db.insert(disputes).values({
    paymentId: graph.paymentId,
    stripeDisputeId: providerDisputeId,
    status: 'open',
    amountMinor: 100,
    currency: 'USD',
    reason: 'fraudulent',
    providerCreatedAt: createdAt,
    providerUpdatedAt: createdAt
  }).returning();
  if (!dispute) throw new Error('Expected replay dispute fixture');
  const classification = kind === 'withdrawal'
    ? { rawType: 'adjustment', reportingCategory: 'dispute' }
    : kind === 'other'
      ? { rawType: 'adjustment', reportingCategory: 'other_adjustment' }
      : kind === 'fee_credit'
        ? { rawType: 'stripe_fee', reportingCategory: 'fee' }
        : { rawType: 'unrecognized_dispute', reportingCategory: 'unrecognized_dispute' };
  const staged = await stageBalanceTransaction(databaseClient.db, {
    id: `txn_${suffix}`,
    livemode: false,
    sourceFamily: 'dispute',
    sourceId: providerDisputeId,
    rawType: classification.rawType,
    reportingCategory: classification.reportingCategory,
    balanceType: 'payments',
    amountMinor,
    feeMinor: 0,
    netMinor: amountMinor,
    currency: 'USD',
    status: 'available',
    createdAt,
    availableAt: new Date('2026-08-12T01:00:00.000Z'),
    exchangeRate: null,
    exchangeSourceCurrency: null,
    exchangeTargetCurrency: null,
    feeDetails: []
  }, { correlationId: `${label}-stage` });
  const fingerprint = (await databaseClient.pool.query<{ fingerprint_sha256: string }>(
    'select fingerprint_sha256 from stripe_balance_transactions where id=$1',
    [staged.balanceTransactionId]
  )).rows[0]!.fingerprint_sha256;
  return { disputeId: dispute.id, balanceTransactionId: staged.balanceTransactionId,
    fingerprint };
}

async function taxedDisputeReplayGraph(label: string) {
  const suffix = `${label}_${randomUUID().replaceAll('-', '')}`;
  const paidAt = new Date('2026-08-12T00:00:00.000Z');
  const withdrawalAt = new Date('2026-08-12T00:05:00.000Z');
  const reinstatementAt = new Date('2026-08-12T00:06:00.000Z');
  const [guest] = await ownerDatabaseClient.db.insert(guestIdentities).values({
    email: `${suffix}@example.com`
  }).returning();
  if (!guest) throw new Error('Expected taxed replay guest fixture');
  const [title] = await ownerDatabaseClient.db.insert(titles).values({
    slug: `taxed-replay-${randomUUID()}`, title: 'Taxed replay title',
    description: 'Taxed replay description', creatorName: 'Taxed replay creator',
    format: 'prose', priceMinor: 100, currency: 'USD', visibility: 'private'
  }).returning();
  if (!title) throw new Error('Expected taxed replay title fixture');
  const [order] = await ownerDatabaseClient.db.insert(orders).values({
    status: 'paid', guestIdentityId: guest.id, purchaseEmail: guest.email,
    currency: 'USD', subtotalMinor: 100, taxMinor: 10, totalMinor: 110,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: '4'.repeat(64),
    stripeCheckoutSessionId: `cs_${suffix}`, statusTokenSha256: '5'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-12T00:30:00.000Z'), paidAt
  }).returning();
  if (!order) throw new Error('Expected taxed replay order fixture');
  const [item] = await ownerDatabaseClient.db.insert(orderItems).values({
    orderId: order.id, titleId: title.id, titleSnapshot: title.title,
    creatorNameSnapshot: title.creatorName, format: 'prose', currency: 'USD',
    unitSubtotalMinor: 100, taxMinor: 10, totalMinor: 110,
    stripeLineItemId: `li_${suffix}`
  }).returning();
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId: order.id, stripePaymentIntentId: `pi_${suffix}`,
    stripeLatestChargeId: `ch_${suffix}`, status: 'succeeded', amountMinor: 110,
    currency: 'USD', paymentMethodCategory: 'card', paidAt
  }).returning();
  if (!item || !payment) throw new Error('Expected taxed replay purchase fixture');
  const providerDisputeId = `dp_${suffix}`;
  const [dispute] = await databaseClient.db.insert(disputes).values({
    paymentId: payment.id, stripeDisputeId: providerDisputeId, status: 'open',
    amountMinor: 110, currency: 'USD', reason: 'fraudulent',
    providerCreatedAt: withdrawalAt, providerUpdatedAt: withdrawalAt
  }).returning();
  if (!dispute) throw new Error('Expected taxed replay dispute fixture');
  return { disputeId: dispute.id, orderItemId: item.id, providerDisputeId,
    withdrawalAt, reinstatementAt };
}

async function stageTaxedDisputeReplayBalance(
  graph: Awaited<ReturnType<typeof taxedDisputeReplayGraph>>,
  label: string,
  effect: 'withdrawal' | 'reinstatement'
) {
  const withdrawal = effect === 'withdrawal';
  const staged = await stageBalanceTransaction(databaseClient.db, {
    id: `txn_${label}_${randomUUID().replaceAll('-', '')}`,
    livemode: false, sourceFamily: 'dispute', sourceId: graph.providerDisputeId,
    rawType: 'adjustment', reportingCategory: withdrawal ? 'dispute' : 'dispute_reversal',
    balanceType: 'payments', amountMinor: withdrawal ? -110 : 110, feeMinor: 0,
    netMinor: withdrawal ? -110 : 110, currency: 'USD', status: 'available',
    createdAt: withdrawal ? graph.withdrawalAt : graph.reinstatementAt,
    availableAt: new Date('2026-08-12T01:00:00.000Z'), exchangeRate: null,
    exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
  }, { correlationId: `${label}-stage` });
  const fingerprint = (await databaseClient.pool.query<{ fingerprint_sha256: string }>(
    'select fingerprint_sha256 from stripe_balance_transactions where id=$1',
    [staged.balanceTransactionId]
  )).rows[0]!.fingerprint_sha256;
  return { balanceTransactionId: staged.balanceTransactionId, fingerprint };
}

async function replayFixtureSubject(
  fixture: { balanceTransactionId: string; fingerprint: string },
  correlationId: string,
  classifierVersion = 1,
  allocationAlgorithmVersion = FINANCIAL_ALLOCATION_ALGORITHM_VERSION
): Promise<void> {
  await replayFinancialClassification({
    database: workerDatabaseClient.db,
    targetClassifierVersion: classifierVersion,
    targetAllocationAlgorithmVersion: allocationAlgorithmVersion
  }, {
    payload: {
      subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
      sourceFingerprintSha256: fixture.fingerprint, classifierVersion,
      allocationAlgorithmVersion,
      replayId: `c${classifierVersion}-a${allocationAlgorithmVersion}`
    },
    correlationId,
    signal: new AbortController().signal
  });
}

async function insertRefundAllocationSet(input: {
  label: string; refundId: string; balanceTransactionId: string; fingerprint: string;
  expectedEffectMinor: number; classifierVersion: number; algorithmVersion: number;
  supersedesSetId?: string; items: readonly { orderItemId: string; effectMinor: number }[];
  basis?: 'gross_amount' | 'fee';
}) {
  const result = await databaseClient.pool.query<{ id: string }>(
    `insert into financial_allocation_sets
       (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
        basis, scope, expected_effect_minor, currency, algorithm_version,
        classifier_version, source_fingerprint_sha256, supersedes_set_id)
     values ($1, $2, 'refund', $3, $4, 'title', $5, 'USD', $6, $7, $8, $9)
     returning id`,
    [`${input.label}_${randomUUID()}`, input.balanceTransactionId, input.refundId,
      input.basis ?? 'gross_amount', input.expectedEffectMinor, input.algorithmVersion,
      input.classifierVersion, input.fingerprint, input.supersedesSetId ?? null]
  );
  const setId = result.rows[0]!.id;
  for (const [index, item] of input.items.entries()) {
    await databaseClient.pool.query(
      `insert into financial_item_allocations
         (allocation_set_id, order_item_id, component, effect_minor, currency, tie_break_key)
       values ($1, $2, 'refund_subtotal', $3, 'USD', $4)`,
      [setId, item.orderItemId, item.effectMinor, `${input.label}-${index}`]
    );
  }
  return setId;
}

async function insertRefundCorrection(input: {
  label: string; refundId: string; baseSetId: string; fingerprint: string; adminId: string;
  items: readonly { domain: 'settlement' | 'presentment'; sourceSetId: string | null;
    orderItemId: string; approvedMinor: number; deltaMinor: number }[];
}) {
  const correction = await databaseClient.pool.query<{ id: string }>(
    `insert into refund_reporting_correction_sets
       (refund_id, correction_version, kind, base_allocation_set_id,
        source_fingerprint_sha256, approved_by_admin_id, created_by_admin_id, correlation_id)
     values ($1, 1, 'allocation_attribution_correction', $2, $3, $4, $4, $5)
     returning id`,
    [input.refundId, input.baseSetId, input.fingerprint, input.adminId, input.label]
  );
  for (const [index, item] of input.items.entries()) {
    await databaseClient.pool.query(
      `insert into refund_reporting_correction_items
         (correction_set_id, domain, source_allocation_set_id, order_item_id, component,
          currency, approved_absolute_minor, delta_minor, stable_tie_break_key)
       values ($1, $2, $3, $4, 'refund_subtotal', 'USD', $5, $6, $7)`,
      [correction.rows[0]!.id, item.domain, item.sourceSetId, item.orderItemId,
        item.approvedMinor, item.deltaMinor, `${input.label}-${index}`]
    );
  }
  return correction.rows[0]!.id;
}

function replayInput(fixture: { balanceTransactionId: string; fingerprint: string },
  correlationId: string) {
  return {
    payload: {
      subjectType: 'balance_transaction' as const,
      subjectId: fixture.balanceTransactionId,
      sourceFingerprintSha256: fixture.fingerprint,
      classifierVersion: 2,
      allocationAlgorithmVersion: 3,
      replayId: 'c2-a3'
    },
    correlationId,
    signal: new AbortController().signal
  };
}

function versionBarrierDatabase(arrivalCount: number): Database {
  const reached = deferred<void>();
  let arrivals = 0;
  return {
    transaction: (work: (tx: never) => Promise<unknown>) =>
      databaseClient.db.transaction(async (tx) => {
        let gated = false;
        const proxy = new Proxy(tx, {
          get(target, property) {
            if (property === 'execute') {
              return async (query: unknown) => {
                if (!gated && rendered(query).includes('from financial_projection_versions')) {
                  gated = true;
                  arrivals += 1;
                  if (arrivals === arrivalCount) reached.resolve();
                  await reached.promise;
                }
                return tx.execute(query as never);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
        return work(proxy as never);
      })
  } as unknown as Database;
}

async function waitForBlockedPid(pid: number, queryFragment: string): Promise<number[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await databaseClient.pool.query<{
      query: string; blockers: number[];
    }>(`select query, pg_blocking_pids(pid) as blockers
        from pg_stat_activity where pid=$1`, [pid]);
    const row = result.rows[0];
    if (row?.query.includes(queryFragment) && row.blockers.length > 0) return row.blockers;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for replay pid ${pid} at ${queryFragment}`);
}

describe('financial classifier and allocation-version replay', () => {
  it('builds a pending root when provider evidence predates replay registration', async () => {
    const fixture = await chargeFixture('reclassification-stage-before-registration', false, false);
    const pending = await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2'
    });
    const page = await loadClassificationReplayPage(databaseClient.db, pending, 100);
    expect(page.hasMore).toBe(false);
    const children = page.data.map((subject) => createFinancialClassificationSubjectJob({
      ...subject, classifierVersion: 2, allocationAlgorithmVersion: 2,
      scanRunId: pending.id
    }));
    expect(children).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ subjectId: fixture.balanceTransactionId })
    })]);
    const sealed = await commitFinancialScanPage(databaseClient.db, {
      runId: pending.id, expectedPhase: 'classification_replay_page',
      expectedCheckpoint: null, expectedPageCount: 0,
      nextPhase: 'classification_replay_page', nextCheckpoint: null,
      processedCount: page.data.length, children, complete: true
    });
    for (const child of children) {
      await expect(replayFinancialClassification({
        database: databaseClient.db,
        targetClassifierVersion: 2,
        targetAllocationAlgorithmVersion: 2
      }, {
        payload: child.payload,
        correlationId: 'reclassification-stage-before-registration-child',
        signal: new AbortController().signal
      })).resolves.toBeUndefined();
      await databaseClient.pool.query(
        `update jobs set status='succeeded', attempts=1, completed_at=now(),
           locked_at=null, locked_by=null, last_error=null
         where deduplication_key=$1`, [child.deduplicationKey]
      );
    }
    const activeBeforeActivation = await loadCurrentEffectiveAllocationProjection(
      databaseClient.db, { balanceTransactionIds: [fixture.balanceTransactionId] }
    );
    expect(activeBeforeActivation.every((head) => head.status !== 'complete')).toBe(true);
    await expect(finalizeFinancialReplay(databaseClient.db, {
      runId: pending.id, expectedCursorDigestSha256: sealed.cursorDigestSha256!,
      expectedPageCount: sealed.pageCount, classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      correlationId: 'reclassification-stage-before-registration-activate'
    })).resolves.toMatchObject({ state: 'completed', safeOutcome: 'completed' });
    const sets = await databaseClient.pool.query<{
      id: string; classifier_version: number; algorithm_version: number;
      allocation_identity: string; supersedes_set_id: string | null;
    }>(`select id, classifier_version, algorithm_version, allocation_identity
        , supersedes_set_id
      from financial_allocation_sets
        where balance_transaction_id=$1 order by basis`, [fixture.balanceTransactionId]);
    expect(sets.rows).toEqual([
      expect.objectContaining({ classifier_version: 2, algorithm_version: 2,
        supersedes_set_id: null }),
      expect.objectContaining({ classifier_version: 2, algorithm_version: 2,
        supersedes_set_id: null })
    ]);
    const current = await loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    });
    expect(current).toEqual([
      expect.objectContaining({ status: 'complete', basis: 'gross_amount',
        baseSetId: expect.stringMatching(/^[0-9a-f-]{36}$/u) }),
      expect.objectContaining({ status: 'complete', basis: 'fee',
        baseSetId: expect.stringMatching(/^[0-9a-f-]{36}$/u) })
    ]);
  });

  it('activates tax-safe c1-a2 dispute successors without mutating c1-a1 history', async () => {
    await resetProjectionVersionForFixture({
      classifierVersion: 1, allocationAlgorithmVersion: 1,
      correlationId: 'reclassification-tax-safe-seed-c1-a1'
    });
    await expect(databaseClient.pool.query<{
      classifier_version: number; allocation_algorithm_version: number;
      activation_correlation_id: string;
    }>(`select classifier_version, allocation_algorithm_version,
          activation_correlation_id
        from financial_projection_versions where singleton=true`)).resolves.toMatchObject({
      rows: [{ classifier_version: 1, allocation_algorithm_version: 1,
        activation_correlation_id: 'reclassification-tax-safe-seed-c1-a1' }]
    });

    const graph = await taxedDisputeReplayGraph('reclassification-tax-safe');
    const withdrawal = await stageTaxedDisputeReplayBalance(
      graph, 'reclassification-tax-safe-withdrawal', 'withdrawal'
    );
    await replayFixtureSubject(
      withdrawal, 'reclassification-tax-safe-withdrawal-c1-a1', 1, 1
    );
    await databaseClient.db.update(disputes).set({
      status: 'won', providerUpdatedAt: graph.reinstatementAt
    }).where(eq(disputes.id, graph.disputeId));
    const reinstatement = await stageTaxedDisputeReplayBalance(
      graph, 'reclassification-tax-safe-reinstatement', 'reinstatement'
    );
    await replayFixtureSubject(
      reinstatement, 'reclassification-tax-safe-reinstatement-c1-a1', 1, 1
    );

    type AllocationSetRow = {
      id: string; provider_id: string; basis: 'gross_amount' | 'fee';
      expected_effect_minor: number; algorithm_version: number; classifier_version: number;
      supersedes_set_id: string | null; reversal_of_set_id: string | null;
    };
    type AllocationItemRow = {
      provider_id: string; allocation_set_id: string; order_item_id: string;
      component: string; effect_minor: number; currency: string;
    };
    const loadVersionedSets = (algorithmVersion: number) =>
      databaseClient.pool.query<AllocationSetRow>(
        `select allocation.id, balance.provider_id, allocation.basis,
           allocation.expected_effect_minor, allocation.algorithm_version,
           allocation.classifier_version, allocation.supersedes_set_id,
           allocation.reversal_of_set_id
         from financial_allocation_sets allocation
         join stripe_balance_transactions balance
           on balance.id=allocation.balance_transaction_id
         where allocation.source_kind='dispute'
           and allocation.source_internal_id=$1
           and allocation.algorithm_version=$2
         order by balance.provider_created_at, balance.provider_id,
           case allocation.basis when 'gross_amount' then 0 else 1 end`,
        [graph.disputeId, algorithmVersion]
      );
    const loadVersionedItems = (algorithmVersion: number) =>
      databaseClient.pool.query<AllocationItemRow>(
        `select balance.provider_id, item.allocation_set_id, item.order_item_id,
           item.component, item.effect_minor, item.currency
         from financial_item_allocations item
         join financial_allocation_sets allocation on allocation.id=item.allocation_set_id
         join stripe_balance_transactions balance
           on balance.id=allocation.balance_transaction_id
         where allocation.source_kind='dispute'
           and allocation.source_internal_id=$1
           and allocation.algorithm_version=$2
         order by balance.provider_created_at, balance.provider_id,
           item.order_item_id, item.component`,
        [graph.disputeId, algorithmVersion]
      );
    const loadImmutableV1History = async () => ({
      sets: (await databaseClient.pool.query<Record<string, unknown>>(
        `select allocation.* from financial_allocation_sets allocation
         where allocation.source_kind='dispute'
           and allocation.source_internal_id=$1 and allocation.algorithm_version=1
         order by allocation.id`, [graph.disputeId]
      )).rows,
      items: (await databaseClient.pool.query<Record<string, unknown>>(
        `select item.* from financial_item_allocations item
         join financial_allocation_sets allocation on allocation.id=item.allocation_set_id
         where allocation.source_kind='dispute'
           and allocation.source_internal_id=$1 and allocation.algorithm_version=1
         order by item.allocation_set_id, item.id`, [graph.disputeId]
      )).rows
    });
    const v1Sets = (await loadVersionedSets(1)).rows;
    const v1Items = (await loadVersionedItems(1)).rows;
    expect(v1Sets).toHaveLength(4);
    expect(v1Sets.every((row) => row.classifier_version === 1 &&
      row.algorithm_version === 1)).toBe(true);
    expect(v1Items).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_id: expect.stringContaining('withdrawal'),
        order_item_id: graph.orderItemId, component: 'dispute_subtotal', effect_minor: -100 }),
      expect.objectContaining({ provider_id: expect.stringContaining('withdrawal'),
        order_item_id: graph.orderItemId, component: 'dispute_tax', effect_minor: -10 }),
      expect.objectContaining({ provider_id: expect.stringContaining('reinstatement'),
        order_item_id: graph.orderItemId, component: 'dispute_reinstatement',
        effect_minor: 110 })
    ]));
    expect(v1Items).toHaveLength(3);
    const v1HistoryBefore = await loadImmutableV1History();
    const v1WithdrawalGross = v1Sets.find((row) =>
      row.provider_id.includes('withdrawal') && row.basis === 'gross_amount');
    const v1ReinstatementGross = v1Sets.find((row) =>
      row.provider_id.includes('reinstatement') && row.basis === 'gross_amount');
    if (!v1WithdrawalGross || !v1ReinstatementGross) {
      throw new Error('Expected complete c1-a1 dispute history');
    }
    expect(v1ReinstatementGross.reversal_of_set_id).toBe(v1WithdrawalGross.id);

    const pending = await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay', classifierVersion: 1,
      allocationAlgorithmVersion: 2, replayId: 'c1-a2'
    });
    const page = await loadClassificationReplayPage(databaseClient.db, pending, 100);
    expect(page.hasMore).toBe(false);
    const children = page.data.map((subject) => createFinancialClassificationSubjectJob({
      ...subject, classifierVersion: 1, allocationAlgorithmVersion: 2,
      scanRunId: pending.id
    }));
    expect(children).toHaveLength(2);
    expect(children.map((child) => child.payload.subjectId)).toEqual(expect.arrayContaining([
      withdrawal.balanceTransactionId, reinstatement.balanceTransactionId
    ]));
    const sealed = await commitFinancialScanPage(databaseClient.db, {
      runId: pending.id, expectedPhase: 'classification_replay_page',
      expectedCheckpoint: null, expectedPageCount: 0,
      nextPhase: 'classification_replay_page', nextCheckpoint: null,
      processedCount: page.data.length, children, complete: true
    });
    await expect(databaseClient.pool.query<{
      classifier_version: number; allocation_algorithm_version: number;
      pending_classifier_version: number | null;
      pending_allocation_algorithm_version: number | null;
      pending_replay_id: string | null; pending_scan_run_id: string | null;
    }>(`select classifier_version, allocation_algorithm_version,
          pending_classifier_version, pending_allocation_algorithm_version,
          pending_replay_id, pending_scan_run_id
        from financial_projection_versions where singleton=true`)).resolves.toMatchObject({
      rows: [{ classifier_version: 1, allocation_algorithm_version: 1,
        pending_classifier_version: 1, pending_allocation_algorithm_version: 2,
        pending_replay_id: 'c1-a2', pending_scan_run_id: pending.id }]
    });

    const childBySubject = new Map(children.map((child) =>
      [child.payload.subjectId, child] as const));
    const orderedChildren = [withdrawal.balanceTransactionId, reinstatement.balanceTransactionId]
      .map((subjectId) => childBySubject.get(subjectId));
    if (orderedChildren.some((child) => child === undefined)) {
      throw new Error('Expected both c1-a2 dispute replay children');
    }
    for (const child of orderedChildren) {
      await replayFinancialClassification({
        database: workerDatabaseClient.db, targetClassifierVersion: 1,
        targetAllocationAlgorithmVersion: 2
      }, {
        payload: child!.payload,
        correlationId: `reclassification-tax-safe-c1-a2-${child!.payload.subjectId}`,
        signal: new AbortController().signal
      });
      await databaseClient.pool.query(
        `update jobs set status='succeeded', attempts=1, completed_at=now(),
           locked_at=null, locked_by=null, last_error=null
         where deduplication_key=$1`, [child!.deduplicationKey]
      );
    }

    const v2HistoryBeforeRetry = {
      sets: (await databaseClient.pool.query<Record<string, unknown>>(
        `select allocation.* from financial_allocation_sets allocation
         where allocation.source_kind='dispute'
           and allocation.source_internal_id=$1 and allocation.algorithm_version=2
         order by allocation.id`, [graph.disputeId]
      )).rows,
      items: (await databaseClient.pool.query<Record<string, unknown>>(
        `select item.* from financial_item_allocations item
         join financial_allocation_sets allocation on allocation.id=item.allocation_set_id
         where allocation.source_kind='dispute'
           and allocation.source_internal_id=$1 and allocation.algorithm_version=2
         order by item.allocation_set_id, item.id`, [graph.disputeId]
      )).rows
    };
    const reinstatementChild = childBySubject.get(reinstatement.balanceTransactionId);
    if (!reinstatementChild) throw new Error('Expected c1-a2 reinstatement child');
    await replayFinancialClassification({
      database: workerDatabaseClient.db, targetClassifierVersion: 1,
      targetAllocationAlgorithmVersion: 2
    }, {
      payload: reinstatementChild.payload,
      correlationId: 'reclassification-tax-safe-c1-a2-reinstatement-retry',
      signal: new AbortController().signal
    });
    expect({
      sets: (await databaseClient.pool.query<Record<string, unknown>>(
        `select allocation.* from financial_allocation_sets allocation
         where allocation.source_kind='dispute'
           and allocation.source_internal_id=$1 and allocation.algorithm_version=2
         order by allocation.id`, [graph.disputeId]
      )).rows,
      items: (await databaseClient.pool.query<Record<string, unknown>>(
        `select item.* from financial_item_allocations item
         join financial_allocation_sets allocation on allocation.id=item.allocation_set_id
         where allocation.source_kind='dispute'
           and allocation.source_internal_id=$1 and allocation.algorithm_version=2
         order by item.allocation_set_id, item.id`, [graph.disputeId]
      )).rows
    }).toEqual(v2HistoryBeforeRetry);

    await expect(finalizeFinancialReplay(databaseClient.db, {
      runId: pending.id, expectedCursorDigestSha256: sealed.cursorDigestSha256!,
      expectedPageCount: sealed.pageCount, classifierVersion: 1,
      allocationAlgorithmVersion: 2,
      correlationId: 'reclassification-tax-safe-activate-c1-a2'
    })).resolves.toMatchObject({ state: 'completed', safeOutcome: 'completed' });

    expect(await loadImmutableV1History()).toEqual(v1HistoryBefore);
    const v2Sets = (await loadVersionedSets(2)).rows;
    const v2Items = (await loadVersionedItems(2)).rows;
    expect(v2Sets).toHaveLength(4);
    expect(v2Sets.every((row) => row.classifier_version === 1 &&
      row.algorithm_version === 2)).toBe(true);
    const v2WithdrawalGross = v2Sets.find((row) =>
      row.provider_id.includes('withdrawal') && row.basis === 'gross_amount');
    const v2ReinstatementGross = v2Sets.find((row) =>
      row.provider_id.includes('reinstatement') && row.basis === 'gross_amount');
    if (!v2WithdrawalGross || !v2ReinstatementGross) {
      throw new Error('Expected complete c1-a2 dispute successors');
    }
    expect(v2WithdrawalGross.supersedes_set_id).toBe(v1WithdrawalGross.id);
    expect(v2ReinstatementGross.supersedes_set_id).toBe(v1ReinstatementGross.id);
    expect(v2ReinstatementGross.reversal_of_set_id).toBe(v2WithdrawalGross.id);
    expect(v2Items).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_id: expect.stringContaining('withdrawal'),
        allocation_set_id: v2WithdrawalGross.id, order_item_id: graph.orderItemId,
        component: 'dispute_subtotal', effect_minor: -100, currency: 'USD' }),
      expect.objectContaining({ provider_id: expect.stringContaining('withdrawal'),
        allocation_set_id: v2WithdrawalGross.id, order_item_id: graph.orderItemId,
        component: 'dispute_tax', effect_minor: -10, currency: 'USD' }),
      expect.objectContaining({ provider_id: expect.stringContaining('reinstatement'),
        allocation_set_id: v2ReinstatementGross.id, order_item_id: graph.orderItemId,
        component: 'dispute_reinstatement', effect_minor: 100, currency: 'USD' }),
      expect.objectContaining({ provider_id: expect.stringContaining('reinstatement'),
        allocation_set_id: v2ReinstatementGross.id, order_item_id: graph.orderItemId,
        component: 'dispute_tax', effect_minor: 10, currency: 'USD' })
    ]));
    expect(v2Items).toHaveLength(4);

    await expect(databaseClient.pool.query<{
      classifier_version: number; allocation_algorithm_version: number;
      pending_replay_id: string | null; pending_scan_run_id: string | null;
      activation_correlation_id: string;
    }>(`select classifier_version, allocation_algorithm_version,
          pending_replay_id, pending_scan_run_id, activation_correlation_id
        from financial_projection_versions where singleton=true`)).resolves.toMatchObject({
      rows: [{ classifier_version: 1, allocation_algorithm_version: 2,
        pending_replay_id: null, pending_scan_run_id: null,
        activation_correlation_id: 'reclassification-tax-safe-activate-c1-a2' }]
    });
    const current = await loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [withdrawal.balanceTransactionId,
        reinstatement.balanceTransactionId]
    });
    expect(current).toHaveLength(4);
    expect(current.every((head) => head.status === 'complete')).toBe(true);
    expect(new Set(current.flatMap((head) => head.status === 'complete'
      ? [head.baseSetId] : []))).toEqual(new Set(v2Sets.map((row) => row.id)));
    const currentReinstatement = current.find((head) =>
      head.status === 'complete' && head.balanceTransactionId === reinstatement.balanceTransactionId &&
      head.basis === 'gross_amount');
    expect(currentReinstatement).toMatchObject({
      status: 'complete', baseSetId: v2ReinstatementGross.id, expectedEffectMinor: 110,
      items: expect.arrayContaining([
        expect.objectContaining({ orderItemId: graph.orderItemId,
          component: 'dispute_reinstatement', effectMinor: 100 }),
        expect.objectContaining({ orderItemId: graph.orderItemId,
          component: 'dispute_tax', effectMinor: 10 })
      ])
    });
  }, 20_000);

  it('uses active markers while one deployed worker replays dispute-to-refund dependencies', async () => {
    const graph = await correctionRebaseGraph('reclassification-job-ordering');
    const refund = await finalizedRefundEvidence(
      graph, 'reclassification-job-ordering-refund', [50, 50]
    );
    await replayFixtureSubject(refund, 'reclassification-job-ordering-seed-c1');
    const activeSpec = createFinancialClassificationSubjectJob({
      subjectType: 'balance_transaction', subjectId: refund.balanceTransactionId,
      sourceFingerprintSha256: refund.fingerprint,
      classifierVersion: 1,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    });
    const activeQueued = await enqueueJob(databaseClient.db, {
      ...activeSpec, payload: activeSpec.payload as never, runAt: new Date(0)
    });
    await databaseClient.pool.query(
      `update jobs set status='succeeded', attempts=1, completed_at=now(),
         locked_at=null, locked_by=null, last_error=null
       where id=$1`, [activeQueued.id]
    );
    const pending = await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2'
    });
    const page = await loadClassificationReplayPage(databaseClient.db, pending, 100);
    const children = page.data.map((subject) => createFinancialClassificationSubjectJob({
      ...subject, classifierVersion: 2, allocationAlgorithmVersion: 2,
      scanRunId: pending.id
    }));
    expect(children).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ subjectId: refund.balanceTransactionId })
    })]);
    const sealed = await commitFinancialScanPage(databaseClient.db, {
      runId: pending.id, expectedPhase: 'classification_replay_page',
      expectedCheckpoint: null, expectedPageCount: 0,
      nextPhase: 'classification_replay_page', nextCheckpoint: null,
      processedCount: page.data.length, children, complete: true
    });
    const now = new Date('2099-08-14T12:00:00.000Z');
    const deployedRepository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => now, 'all',
      { classifierVersion: 2, allocationAlgorithmVersion: 2 }
    );
    const withdrawal = await stagedDisputeEvidence(
      graph, 'reclassification-job-ordering-withdrawal', 'withdrawal'
    );
    await databaseClient.pool.query(
      `update jobs set run_at='2200-01-01T00:00:00Z'
       where type='commerce.financial-classification'
         and payload->>'subjectId'=$1
         and (payload->>'classifierVersion')::integer=2`,
      [refund.balanceTransactionId]
    );

    const disputeWorker = 'reclassification-job-ordering-c2-dispute';
    const disputeChild = await deployedRepository.claimNext(disputeWorker);
    expect(disputeChild).toMatchObject({ type: 'commerce.financial-classification',
      payload: expect.objectContaining({ subjectId: withdrawal.balanceTransactionId,
        classifierVersion: 2, allocationAlgorithmVersion: 2 }) });
    await expect(replayFinancialClassification({
      database: databaseClient.db, targetClassifierVersion: 2,
      targetAllocationAlgorithmVersion: 2
    }, {
      payload: disputeChild!.payload as never,
      correlationId: 'reclassification-job-ordering-dispute-c2',
      signal: new AbortController().signal
    })).resolves.toBeUndefined();
    await expect(deployedRepository.complete(disputeChild!.id, disputeWorker))
      .resolves.toBe(true);
    const markers = await databaseClient.pool.query<{
      subject_id: string; status: string;
    }>(`select payload->>'subjectId' as subject_id, status::text
        from jobs where type='commerce.financial-classification'
          and (payload->>'classifierVersion')::integer=1
        order by payload->>'subjectId'`);
    expect(markers.rows).toEqual([
      { subject_id: refund.balanceTransactionId, status: 'succeeded' }
    ]);
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'complete' }),
      expect.objectContaining({ basis: 'fee', status: 'complete' })
    ]);

    const refundWorker = 'reclassification-job-ordering-c2-refund';
    const refundChild = await deployedRepository.claimNext(refundWorker);
    expect(refundChild).toMatchObject({ type: 'commerce.financial-classification',
      payload: expect.objectContaining({ subjectId: refund.balanceTransactionId,
        classifierVersion: 2, allocationAlgorithmVersion: 2 }) });
    await expect(replayFinancialClassification({
      database: databaseClient.db, targetClassifierVersion: 2,
      targetAllocationAlgorithmVersion: 2
    }, {
      payload: refundChild!.payload as never,
      correlationId: 'reclassification-job-ordering-refund-c2',
      signal: new AbortController().signal
    })).resolves.toBeUndefined();
    await expect(deployedRepository.complete(refundChild!.id, refundWorker)).resolves.toBe(true);
    const finalizerWorker = 'reclassification-job-ordering-finalizer';
    const finalizer = await deployedRepository.claimNext(finalizerWorker);
    expect(finalizer).toMatchObject({ type: 'commerce.financial-scan',
      payload: expect.objectContaining({ scanRunId: pending.id,
        phase: 'classification_replay_finalize' }) });
    await expect(finalizeFinancialReplay(databaseClient.db, {
      runId: pending.id, expectedCursorDigestSha256: sealed.cursorDigestSha256!,
      expectedPageCount: sealed.pageCount, classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      correlationId: 'reclassification-job-ordering-activate-c2'
    })).resolves.toMatchObject({ state: 'completed', safeOutcome: 'completed' });
    await expect(deployedRepository.complete(finalizer!.id, finalizerWorker)).resolves.toBe(true);
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'complete' }),
      expect.objectContaining({ basis: 'fee', status: 'complete' })
    ]);
  });

  it('drains an activated historical-scan marker only after the later upgrade activates', async () => {
    const graph = await correctionRebaseGraph('reclassification-historical-scan-id');
    const refund = await finalizedRefundEvidence(
      graph, 'reclassification-historical-scan-id-refund', [50, 50]
    );
    const withdrawal = await stagedDisputeEvidence(
      graph, 'reclassification-historical-scan-id-withdrawal', 'withdrawal'
    );
    await replayFixtureSubject(withdrawal, 'reclassification-historical-scan-id-c1-dispute');
    await replayFixtureSubject(refund, 'reclassification-historical-scan-id-c1-refund');
    await databaseClient.pool.query(
      `update jobs set status='succeeded', attempts=1, completed_at=now(),
         locked_at=null, locked_by=null, last_error=null
       where type='commerce.financial-classification'
         and (payload->>'classifierVersion')::integer=1
         and payload->>'subjectId'=any($1::text[])`,
      [[withdrawal.balanceTransactionId, refund.balanceTransactionId]]
    );

    const c2 = await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2'
    });
    const c2Page = await loadClassificationReplayPage(databaseClient.db, c2, 100);
    const c2Children = c2Page.data.map((subject) => createFinancialClassificationSubjectJob({
      ...subject, classifierVersion: 2, allocationAlgorithmVersion: 2,
      scanRunId: c2.id
    }));
    const c2Sealed = await commitFinancialScanPage(databaseClient.db, {
      runId: c2.id, expectedPhase: 'classification_replay_page',
      expectedCheckpoint: null, expectedPageCount: 0,
      nextPhase: 'classification_replay_page', nextCheckpoint: null,
      processedCount: c2Page.data.length, children: c2Children, complete: true
    });
    for (const subjectId of [withdrawal.balanceTransactionId, refund.balanceTransactionId]) {
      const child = c2Children.find((candidate) => candidate.payload.subjectId === subjectId);
      if (!child) throw new Error(`Expected c2 child for ${subjectId}`);
      await replayFinancialClassification({
        database: databaseClient.db, targetClassifierVersion: 2,
        targetAllocationAlgorithmVersion: 2
      }, {
        payload: child.payload,
        correlationId: `reclassification-historical-scan-id-c2-${subjectId}`,
        signal: new AbortController().signal
      });
      if (subjectId === withdrawal.balanceTransactionId) {
        await databaseClient.pool.query(
          `update jobs set status='succeeded', attempts=1, completed_at=now(),
             locked_at=null, locked_by=null, last_error=null
           where type='commerce.financial-classification'
             and (payload->>'classifierVersion')::integer=1
             and payload->>'subjectId'=$1`,
          [refund.balanceTransactionId]
        );
      }
    }
    await databaseClient.pool.query(
      `update jobs set status='succeeded', attempts=1, completed_at=now(),
         locked_at=null, locked_by=null, last_error=null
       where payload->>'scanRunId'=$1`, [c2.id]
    );
    await expect(finalizeFinancialReplay(databaseClient.db, {
      runId: c2.id, expectedCursorDigestSha256: c2Sealed.cursorDigestSha256!,
      expectedPageCount: c2Sealed.pageCount, classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      correlationId: 'reclassification-historical-scan-id-activate-c2'
    })).resolves.toMatchObject({ state: 'completed', safeOutcome: 'completed' });

    const c3 = await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay', classifierVersion: 3,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      replayId: 'c3-a2'
    });
    const c3Page = await loadClassificationReplayPage(databaseClient.db, c3, 100);
    const c3Children = c3Page.data.map((subject) => createFinancialClassificationSubjectJob({
      ...subject, classifierVersion: 3,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      scanRunId: c3.id
    }));
    const c3Sealed = await commitFinancialScanPage(databaseClient.db, {
      runId: c3.id, expectedPhase: 'classification_replay_page',
      expectedCheckpoint: null, expectedPageCount: 0,
      nextPhase: 'classification_replay_page', nextCheckpoint: null,
      processedCount: c3Page.data.length, children: c3Children, complete: true
    });
    for (const child of c3Children.filter((candidate) =>
      candidate.payload.subjectId !== refund.balanceTransactionId)) {
      await replayFinancialClassification({
        database: databaseClient.db, targetClassifierVersion: 3,
        targetAllocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
      }, {
        payload: child.payload,
        correlationId: `reclassification-historical-scan-id-c3-${child.payload.subjectId}`,
        signal: new AbortController().signal
      });
      await databaseClient.pool.query(
        `update jobs set status='succeeded', attempts=greatest(attempts, 1),
           completed_at=now(), locked_at=null, locked_by=null, last_error=null
         where deduplication_key=$1`, [child.deduplicationKey]
      );
    }
    await databaseClient.db.transaction((transaction) =>
      rearmCurrentProjectionSubjectsForFinancialSources(transaction, {
        sourceKind: 'refund', sourceIds: [refund.refundId]
      })
    );

    const c2RefundSpec = c2Children.find((candidate) =>
      candidate.payload.subjectId === refund.balanceTransactionId);
    if (!c2RefundSpec) throw new Error('Expected c2 refund child');
    const retainedPayload = await databaseClient.pool.query<{
      status: string; scan_run_id: string | null;
    }>(`select status, payload->>'scanRunId' as scan_run_id
        from jobs where deduplication_key=$1`, [c2RefundSpec.deduplicationKey]);
    expect(retainedPayload.rows).toEqual([{ status: 'pending', scan_run_id: c2.id }]);

    const now = new Date('2099-08-14T12:00:00.000Z');
    const c3Repository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => now, 'all',
      { classifierVersion: 3,
        allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION }
    );
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'missing',
        safeCode: 'missing_source' }),
      expect.objectContaining({ basis: 'fee', status: 'missing', safeCode: 'missing_source' })
    ]);

    const c3Worker = 'reclassification-historical-scan-id-c3-worker';
    const c3Claim = await c3Repository.claimNext(c3Worker);
    expect(c3Claim).toMatchObject({
      id: expect.any(String),
      payload: expect.objectContaining({
        subjectId: refund.balanceTransactionId, scanRunId: c3.id,
        classifierVersion: 3,
        allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
      })
    });
    await expect(replayFinancialClassification({
      database: databaseClient.db, targetClassifierVersion: 3,
      targetAllocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    }, {
      payload: c3Claim!.payload as never,
      correlationId: 'reclassification-historical-scan-id-replay-c3',
      signal: new AbortController().signal
    })).resolves.toBeUndefined();
    await expect(c3Repository.complete(c3Claim!.id, c3Worker)).resolves.toBe(true);

    const finalizerWorker = 'reclassification-historical-scan-id-c3-finalizer';
    const finalizer = await c3Repository.claimNext(finalizerWorker);
    expect(finalizer).toMatchObject({ type: 'commerce.financial-scan',
      payload: expect.objectContaining({ scanRunId: c3.id,
        phase: 'classification_replay_finalize' }) });
    await expect(finalizeFinancialReplay(databaseClient.db, {
      runId: c3.id, expectedCursorDigestSha256: c3Sealed.cursorDigestSha256!,
      expectedPageCount: c3Sealed.pageCount, classifierVersion: 3,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      correlationId: 'reclassification-historical-scan-id-activate-c3'
    })).resolves.toMatchObject({ state: 'completed', safeOutcome: 'completed' });
    await expect(c3Repository.complete(finalizer!.id, finalizerWorker)).resolves.toBe(true);

    const cleanupWorker = 'reclassification-historical-scan-id-c2-cleanup';
    const c2Cleanup = await c3Repository.claimNext(cleanupWorker);
    expect(c2Cleanup).toMatchObject({
      payload: expect.objectContaining({
        subjectId: refund.balanceTransactionId, scanRunId: c2.id,
        classifierVersion: 2, allocationAlgorithmVersion: 2
      })
    });
    await expect(replayFinancialClassification({
      database: databaseClient.db, targetClassifierVersion: 3,
      targetAllocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    }, {
      payload: c2Cleanup!.payload as never,
      correlationId: 'reclassification-historical-scan-id-cleanup-c2',
      signal: new AbortController().signal
    })).resolves.toBeUndefined();
    await expect(c3Repository.complete(c2Cleanup!.id, cleanupWorker)).resolves.toBe(true);
    await expect(databaseClient.pool.query<{ status: string }>(
      `select status::text from jobs where deduplication_key=$1`,
      [c2RefundSpec.deduplicationKey]
    )).resolves.toMatchObject({ rows: [{ status: 'succeeded' }] });
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'complete' }),
      expect.objectContaining({ basis: 'fee', status: 'complete' })
    ]);
  });

  it('reports an exception issue ahead of a pending issue on the selected set', async () => {
    const fixture = await adjustmentFixture('reclassification-set-issue-precedence');
    const grossSetId = fixture.roots.find((root) => root.setId)?.setId;
    if (!grossSetId) throw new Error('Expected gross allocation set');
    await databaseClient.db.transaction(async (transaction) => {
      await observeFinancialIssue(transaction, {
        resourceType: 'allocation_set', resourceId: grossSetId,
        safeCode: 'missing_source', impact: 'pending',
        actor: { type: 'system', id: 'financial-worker' },
        correlationId: 'reclassification-set-issue-precedence-pending'
      });
      await observeFinancialIssue(transaction, {
        resourceType: 'allocation_set', resourceId: grossSetId,
        safeCode: 'source_linkage_mismatch', impact: 'exception',
        actor: { type: 'system', id: 'financial-worker' },
        correlationId: 'reclassification-set-issue-precedence-exception'
      });
      await rearmFinancialClassificationJob(transaction,
        createFinancialClassificationSubjectJob({
          subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
          sourceFingerprintSha256: fixture.fingerprint,
          classifierVersion: 1,
          allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
        }));
    });

    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'exception',
        safeCode: 'source_linkage_mismatch' }),
      expect.objectContaining({ basis: 'fee', status: 'missing', safeCode: 'missing_source' })
    ]);
  });

  it('treats an exact active non-succeeded classification job as a missing head', async () => {
    const fixture = await adjustmentFixture('reclassification-active-job-marker');
    const spec = createFinancialClassificationSubjectJob({
      subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
      sourceFingerprintSha256: fixture.fingerprint,
      classifierVersion: 1,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    });
    await databaseClient.db.transaction((transaction) =>
      rearmFinancialClassificationJob(transaction, spec)
    );
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'missing',
        safeCode: 'missing_source' }),
      expect.objectContaining({ basis: 'fee', status: 'missing', safeCode: 'missing_source' })
    ]);
    await databaseClient.pool.query(
      `update jobs set status='succeeded', attempts=1, completed_at=now()
       where deduplication_key=$1`, [spec.deduplicationKey]
    );
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'complete' }),
      expect.objectContaining({ basis: 'fee', status: 'complete' })
    ]);
  });

  it('orders a claimed pending replay behind finalization and recovers only at its target version', async () => {
    await resetProjectionVersionForFixture({
      classifierVersion: 1, allocationAlgorithmVersion: 1,
      correlationId: 'reclassification-finalized-upgrade-order-seed-c1-a1'
    });
    const graph = await correctionRebaseGraph('reclassification-finalized-upgrade-order');
    const refund = await finalizedRefundEvidence(
      graph, 'reclassification-finalized-upgrade-order-refund', [50, 50], 'draft'
    );
    await replayFixtureSubject(
      refund, 'reclassification-finalized-upgrade-order-c1', 1, 1
    );
    await expect(databaseClient.pool.query<{
      classifier_version: number; algorithm_version: number; scope: string;
    }>(`select classifier_version, algorithm_version, scope
        from financial_allocation_sets where balance_transaction_id=$1 order by basis`,
      [refund.balanceTransactionId])).resolves.toMatchObject({ rows: [
      { classifier_version: 1, algorithm_version: 1, scope: 'unresolved' },
      { classifier_version: 1, algorithm_version: 1, scope: 'unresolved' }
    ] });
    await databaseClient.pool.query(
      `update jobs set status='succeeded', attempts=1, completed_at=now(),
         locked_at=null, locked_by=null, last_error=null
       where type='commerce.financial-classification'
         and payload->>'subjectId'=$1
         and (payload->>'classifierVersion')::integer=1`,
      [refund.balanceTransactionId]
    );

    const pending = await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2'
    });
    const page = await loadClassificationReplayPage(databaseClient.db, pending, 100);
    const children = page.data.map((subject) => createFinancialClassificationSubjectJob({
      ...subject, classifierVersion: 2, allocationAlgorithmVersion: 2,
      scanRunId: pending.id
    }));
    const child = children.find((candidate) =>
      candidate.payload.subjectId === refund.balanceTransactionId);
    if (!child) throw new Error('Expected pending refund child');
    const sealed = await commitFinancialScanPage(databaseClient.db, {
      runId: pending.id, expectedPhase: 'classification_replay_page',
      expectedCheckpoint: null, expectedPageCount: 0,
      nextPhase: 'classification_replay_page', nextCheckpoint: null,
      processedCount: page.data.length, children, complete: true
    });
    const now = new Date('2099-08-14T12:00:00.000Z');
    const deployedRepository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => now, 'all',
      { classifierVersion: 2, allocationAlgorithmVersion: 2 }
    );
    const deployedHandler = createFinancialClassificationHandler({
      database: databaseClient.db, targetClassifierVersion: 2,
      targetAllocationAlgorithmVersion: 2
    });
    const firstC2Worker = 'reclassification-finalized-upgrade-order-c2-unresolved';
    const firstC2Claim = await deployedRepository.claimNext(firstC2Worker);
    expect(firstC2Claim).toMatchObject({
      payload: expect.objectContaining({ subjectId: refund.balanceTransactionId })
    });
    await expect(deployedHandler(firstC2Claim!, new AbortController().signal))
      .resolves.toBeUndefined();
    await expect(deployedRepository.complete(firstC2Claim!.id, firstC2Worker))
      .resolves.toBe(true);
    await expect(databaseClient.pool.query<{ scope: string }>(
      `select scope from financial_allocation_sets
       where balance_transaction_id=$1 and classifier_version=2 and algorithm_version=2
       order by basis`, [refund.balanceTransactionId]
    )).resolves.toMatchObject({ rows: [{ scope: 'unresolved' }, { scope: 'unresolved' }] });

    await databaseClient.db.transaction((transaction) =>
      rearmFinancialClassificationJob(transaction, child)
    );
    const claimedBeforeFinalizationWorker =
      'reclassification-finalized-upgrade-order-c2-before-finalization';
    const claimedBeforeFinalization = await deployedRepository.claimNext(
      claimedBeforeFinalizationWorker
    );
    expect(claimedBeforeFinalization).toMatchObject({ id: firstC2Claim!.id, attempts: 1 });

    await databaseClient.db.transaction(async (transaction) => {
      await lockOrder(transaction, graph.orderId);
      const [order] = await transaction.select().from(orders)
        .where(eq(orders.id, graph.orderId)).for('update');
      const [payment] = await transaction.select().from(payments)
        .where(eq(payments.id, graph.paymentId)).for('update');
      if (!order || !payment) throw new Error('Expected finalization purchase graph');
      await lockPaymentPurchaseFacts(transaction, payment, order);
      for (const orderItemId of [graph.itemA, graph.itemB]) {
        const [allocation] = await transaction.insert(refundAllocations).values({
          refundId: refund.refundId, orderItemId, amountMinor: 50,
          source: 'administrative'
        }).returning();
        if (!allocation) throw new Error('Expected finalized refund allocation');
        await transaction.insert(refundAllocationComponents).values({
          refundAllocationId: allocation.id, refundId: refund.refundId, orderItemId,
          subtotalMinor: 50, taxMinor: 0, totalMinor: 50, currency: 'USD'
        });
      }
      await transaction.update(refunds).set({ allocationStatus: 'finalized' })
        .where(eq(refunds.id, refund.refundId));
      await rearmCurrentProjectionSubjectsForFinancialSources(transaction, {
        sourceKind: 'refund', sourceIds: [refund.refundId]
      });
    });
    await expect(deployedRepository.claimNext(
      'reclassification-finalized-upgrade-order-active-marker-probe'
    )).resolves.toBeNull();
    await expect(deployedHandler(
      claimedBeforeFinalization!, new AbortController().signal
    )).resolves.toBeUndefined();
    await expect(deployedRepository.complete(
      claimedBeforeFinalization!.id, claimedBeforeFinalizationWorker
    )).resolves.toBe(true);
    const markedC1 = await databaseClient.pool.query<{
      set_count: string; open_issue_count: string; marker_status: string;
    }>(`select
          (select count(*)::text from financial_allocation_sets
           where balance_transaction_id=$1::uuid and classifier_version=1
             and algorithm_version=1) as set_count,
          (select count(*)::text from financial_reconciliation_issues issue
           join financial_allocation_sets allocation on allocation.id=issue.resource_id
           where issue.resource_type='allocation_set' and issue.state='open'
             and allocation.balance_transaction_id=$1::uuid
             and allocation.classifier_version=1
             and allocation.algorithm_version=1) as open_issue_count,
          (select status::text from jobs
           where type='commerce.financial-classification'
             and payload->>'subjectId'=$1::text
             and (payload->>'classifierVersion')::integer=1) as marker_status`,
      [refund.balanceTransactionId]);
    expect(markedC1.rows).toEqual([{
      set_count: '2', open_issue_count: '0', marker_status: 'pending'
    }]);
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'missing',
        safeCode: 'missing_source' }),
      expect.objectContaining({ basis: 'fee', status: 'missing', safeCode: 'missing_source' })
    ]);

    const repairedC2Worker = 'reclassification-finalized-upgrade-order-c2-finalized';
    const repairedC2 = await deployedRepository.claimNext(repairedC2Worker);
    expect(repairedC2).toMatchObject({ id: firstC2Claim!.id, attempts: 1 });
    await expect(deployedHandler(repairedC2!, new AbortController().signal))
      .resolves.toBeUndefined();
    await expect(deployedRepository.complete(repairedC2!.id, repairedC2Worker))
      .resolves.toBe(true);
    const finalizerWorker = 'reclassification-finalized-upgrade-order-finalizer';
    const finalizer = await deployedRepository.claimNext(finalizerWorker);
    expect(finalizer).toMatchObject({ type: 'commerce.financial-scan' });
    await expect(finalizeFinancialReplay(databaseClient.db, {
      runId: pending.id, expectedCursorDigestSha256: sealed.cursorDigestSha256!,
      expectedPageCount: sealed.pageCount, classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      correlationId: 'reclassification-finalized-upgrade-order-activate-c2'
    })).resolves.toMatchObject({ state: 'completed', safeOutcome: 'completed' });
    await expect(deployedRepository.complete(finalizer!.id, finalizerWorker)).resolves.toBe(true);

    const history = await databaseClient.pool.query<{
      classifier_version: number; algorithm_version: number; scope: string; tip: boolean;
    }>(`select allocation.classifier_version, allocation.algorithm_version, allocation.scope,
          not exists (select 1 from financial_allocation_sets successor
            where successor.supersedes_set_id=allocation.id) as tip
        from financial_allocation_sets allocation
        where allocation.balance_transaction_id=$1
        order by allocation.classifier_version, allocation.algorithm_version,
          allocation.basis, allocation.created_at, allocation.id`, [refund.balanceTransactionId]);
    expect(history.rows.filter((row) => row.classifier_version === 1)).toHaveLength(2);
    expect(history.rows.filter((row) => row.classifier_version === 2)).toHaveLength(4);
    expect(history.rows.filter((row) => row.tip)).toEqual([
      expect.objectContaining({ classifier_version: 2, algorithm_version: 2, scope: 'title' }),
      expect.objectContaining({ classifier_version: 2, algorithm_version: 2, scope: 'title' })
    ]);
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'complete' }),
      expect.objectContaining({ basis: 'fee', status: 'complete' })
    ]);
    const cleanupWorker = 'reclassification-finalized-upgrade-order-c1-cleanup';
    const cleanup = await deployedRepository.claimNext(cleanupWorker);
    expect(cleanup).toMatchObject({
      payload: expect.objectContaining({ subjectId: refund.balanceTransactionId,
        classifierVersion: 1, allocationAlgorithmVersion: 1 })
    });
    await expect(deployedHandler(cleanup!, new AbortController().signal))
      .resolves.toBeUndefined();
    await expect(deployedRepository.complete(cleanup!.id, cleanupWorker)).resolves.toBe(true);
  });

  it('fails a no-tip pending refund child without inventing a set-scoped issue', async () => {
    const graph = await correctionRebaseGraph('reclassification-no-tip-blocker');
    const refund = await finalizedRefundEvidence(
      graph, 'reclassification-no-tip-blocker-refund', [50, 50]
    );
    const withdrawal = await stagedDisputeEvidence(
      graph, 'reclassification-no-tip-blocker-withdrawal', 'withdrawal'
    );
    await databaseClient.pool.query(
      `update jobs set status='failed', attempts=max_attempts, completed_at=now(),
         locked_at=null, locked_by=null, last_error='active fixture terminal'
       where type='commerce.financial-classification'
         and (payload->>'classifierVersion')::integer=1`,
      []
    );
    await expect(databaseClient.pool.query(
      `select id from financial_allocation_sets where balance_transaction_id=$1`,
      [refund.balanceTransactionId]
    )).resolves.toMatchObject({ rowCount: 0 });

    const pending = await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2'
    });
    const page = await loadClassificationReplayPage(databaseClient.db, pending, 100);
    const children = page.data.map((subject) => createFinancialClassificationSubjectJob({
      ...subject, classifierVersion: 2, allocationAlgorithmVersion: 2,
      scanRunId: pending.id
    }));
    const refundChild = children.find((candidate) =>
      candidate.payload.subjectId === refund.balanceTransactionId);
    if (!refundChild) throw new Error('Expected blocked pending refund child');
    await commitFinancialScanPage(databaseClient.db, {
      runId: pending.id, expectedPhase: 'classification_replay_page',
      expectedCheckpoint: null, expectedPageCount: 0,
      nextPhase: 'classification_replay_page', nextCheckpoint: null,
      processedCount: page.data.length, children, complete: true
    });
    await databaseClient.pool.query(
      `update jobs set run_at='2200-01-01T00:00:00.000Z'
       where type='commerce.financial-classification'
         and payload->>'scanRunId'=$1 and payload->>'subjectId'=$2`,
      [pending.id, withdrawal.balanceTransactionId]
    );

    let now = new Date('2099-08-14T12:00:00.000Z');
    const repository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => now, 'all',
      { classifierVersion: 2, allocationAlgorithmVersion: 2 }
    );
    for (let attempt = 1; attempt <= refundChild.maxAttempts; attempt += 1) {
      const worker = `reclassification-no-tip-blocker-attempt-${attempt}`;
      const claimed = await repository.claimNext(worker);
      expect(claimed).toMatchObject({
        payload: expect.objectContaining({ subjectId: refund.balanceTransactionId }), attempts: attempt
      });
      await expect(replayFinancialClassification({
        database: databaseClient.db, targetClassifierVersion: 2,
        targetAllocationAlgorithmVersion: 2
      }, {
        payload: claimed!.payload as never,
        correlationId: `reclassification-no-tip-blocker-attempt-${attempt}`,
        signal: new AbortController().signal
      })).rejects.toMatchObject({ safeCode: 'state_changed' });
      await expect(repository.fail(
        claimed!.id, worker, 'Earlier dispute projection is missing.', true
      )).resolves.toBe(true);
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
    const evidence = await databaseClient.pool.query<{
      status: string; attempts: number; allocation_set_count: string; set_issue_count: string;
    }>(`select job.status, job.attempts,
          (select count(*)::text from financial_allocation_sets
           where balance_transaction_id=$2 and classifier_version=2
             and algorithm_version=2) as allocation_set_count,
          (select count(*)::text from financial_reconciliation_issues
           where resource_type='allocation_set') as set_issue_count
        from jobs job where job.deduplication_key=$1`,
      [refundChild.deduplicationKey, refund.balanceTransactionId]);
    expect(evidence.rows).toEqual([{
      status: 'failed', attempts: refundChild.maxAttempts,
      allocation_set_count: '0', set_issue_count: '0'
    }]);
    await expect(repository.claimNext('reclassification-no-tip-blocker-finalizer'))
      .resolves.toBeNull();
    await expect(databaseClient.pool.query<{
      classifier_version: number; algorithm_version: number;
      pending_classifier_version: number | null; pending_allocation_algorithm_version: number | null;
    }>(`select classifier_version, allocation_algorithm_version as algorithm_version,
          pending_classifier_version,
          pending_allocation_algorithm_version
        from financial_projection_versions where singleton=true`)).resolves.toMatchObject({ rows: [{
      classifier_version: 1,
      algorithm_version: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      pending_classifier_version: 2, pending_allocation_algorithm_version: 2
    }] });
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'missing' }),
      expect.objectContaining({ basis: 'fee', status: 'missing' })
    ]);
  });

  it('fails an active refund closed until earlier dispute exposure is valid and issue-free', async () => {
    const graph = await correctionRebaseGraph('reclassification-refund-dispute-dependency');
    const refund = await finalizedRefundEvidence(
      graph, 'reclassification-refund-dispute-dependency-refund', [50, 50]
    );
    await replayFixtureSubject(refund, 'reclassification-refund-active-seed');
    const withdrawal = await stagedDisputeEvidence(
      graph, 'reclassification-refund-dispute-dependency-withdrawal', 'withdrawal'
    );

    await expect(replayFixtureSubject(refund, 'reclassification-refund-missing-dispute'))
      .rejects.toMatchObject({ safeCode: 'state_changed' });
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ status: 'missing', basis: 'gross_amount',
        safeCode: 'missing_source' }),
      expect.objectContaining({ status: 'missing', basis: 'fee',
        safeCode: 'missing_source' })
    ]);
    const blockedRefundIssues = await databaseClient.pool.query<{ state: string }>(
      `select issue.state
       from financial_reconciliation_issues issue
       join financial_allocation_sets allocation on allocation.id=issue.resource_id
       where issue.resource_type='allocation_set' and issue.safe_code='missing_source'
         and allocation.balance_transaction_id=$1`, [refund.balanceTransactionId]
    );
    expect(blockedRefundIssues.rows).toEqual([{ state: 'open' }, { state: 'open' }]);

    await replayFixtureSubject(withdrawal, 'reclassification-dispute-exposure-seed');
    const disputeGross = await databaseClient.pool.query<{ id: string }>(
      `select id from financial_allocation_sets
       where balance_transaction_id=$1 and basis='gross_amount'
         and classifier_version=1 and algorithm_version=2`,
      [withdrawal.balanceTransactionId]
    );
    expect(disputeGross.rows).toHaveLength(1);
    await databaseClient.db.transaction((transaction) => observeFinancialIssue(transaction, {
      resourceType: 'allocation_set', resourceId: disputeGross.rows[0]!.id,
      safeCode: 'allocation_mismatch', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: 'reclassification-dispute-exposure-invalid'
    }));
    await expect(replayFixtureSubject(refund, 'reclassification-refund-invalid-dispute-set'))
      .rejects.toMatchObject({ safeCode: 'state_changed' });

    await replayFixtureSubject(withdrawal, 'reclassification-dispute-exposure-revalidated');
    const refundRepository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => new Date(), 'all',
      { classifierVersion: 1,
        allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION }
    );
    await databaseClient.pool.query(
      `update jobs set run_at='2200-01-01T00:00:00.000Z'
       where type='commerce.financial-classification'
         and payload->>'subjectId'<>$1`, [refund.balanceTransactionId]
    );
    const refundWorker = 'reclassification-refund-dependency-recovered-worker';
    const refundClaim = await refundRepository.claimNext(refundWorker);
    expect(refundClaim).toMatchObject({ payload: expect.objectContaining({
      subjectId: refund.balanceTransactionId, classifierVersion: 1,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    }) });
    await expect(replayFinancialClassification({
      database: workerDatabaseClient.db, targetClassifierVersion: 1,
      targetAllocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    }, {
      payload: refundClaim!.payload as never,
      correlationId: 'reclassification-refund-dependency-recovered',
      signal: new AbortController().signal
    })).resolves.toBeUndefined();
    await expect(refundRepository.complete(refundClaim!.id, refundWorker)).resolves.toBe(true);
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ status: 'complete', basis: 'gross_amount' }),
      expect.objectContaining({ status: 'complete', basis: 'fee' })
    ]);
    const resolvedIssues = await databaseClient.pool.query<{ state: string }>(
      `select issue.state
       from financial_reconciliation_issues issue
       join financial_allocation_sets allocation on allocation.id=issue.resource_id
       where issue.resource_type='allocation_set'
         and allocation.balance_transaction_id in ($1, $2)
       order by issue.resource_id, issue.safe_code`,
      [refund.balanceTransactionId, withdrawal.balanceTransactionId]
    );
    expect(resolvedIssues.rows.length).toBeGreaterThanOrEqual(3);
    expect(resolvedIssues.rows.every((issue) => issue.state === 'resolved')).toBe(true);
  });

  it.each(['unknown', 'other'] as const)(
    'blocks an earlier %s dispute classification from acting as zero exposure',
    async (classification) => {
      const graph = await correctionRebaseGraph(`reclassification-${classification}-dispute`);
      const refund = await finalizedRefundEvidence(
        graph, `reclassification-${classification}-refund`, [100, 0]
      );
      await replayFixtureSubject(refund, `reclassification-${classification}-refund-seed`);
      await stagedDisputeEvidence(
        graph, `reclassification-${classification}-dispute`, classification
      );

      await expect(replayFixtureSubject(
        refund, `reclassification-${classification}-refund-blocked`
      )).rejects.toMatchObject({ safeCode: 'state_changed' });
      await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
        balanceTransactionIds: [refund.balanceTransactionId]
      })).resolves.toEqual([
        expect.objectContaining({ status: 'missing', basis: 'gross_amount',
          safeCode: 'missing_source' }),
        expect.objectContaining({ status: 'missing', basis: 'fee',
          safeCode: 'missing_source' })
      ]);
    }
  );

  it('allows an earlier fee credit to remain trusted zero presentment exposure', async () => {
    const graph = await correctionRebaseGraph('reclassification-fee-credit-dispute');
    const refund = await finalizedRefundEvidence(
      graph, 'reclassification-fee-credit-refund', [100, 0]
    );
    await replayFixtureSubject(refund, 'reclassification-fee-credit-refund-seed');
    const feeCredit = await stagedDisputeEvidence(
      graph, 'reclassification-fee-credit-dispute', 'fee_credit'
    );

    await expect(replayFixtureSubject(refund, 'reclassification-fee-credit-refund-replay'))
      .resolves.toBeUndefined();
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ status: 'complete', basis: 'gross_amount' }),
      expect.objectContaining({ status: 'complete', basis: 'fee' })
    ]);
    await databaseClient.db.transaction((transaction) => observeFinancialIssue(transaction, {
      resourceType: 'balance_transaction', resourceId: feeCredit.balanceTransactionId,
      safeCode: 'classification_fork', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: 'reclassification-fee-credit-classification-fork'
    }));
    await expect(replayFixtureSubject(
      refund, 'reclassification-fee-credit-fork-blocks-refund'
    )).rejects.toMatchObject({ safeCode: 'state_changed' });
  });

  it('rejects relationally valid presentment rows on an earlier fee credit', async () => {
    const graph = await correctionRebaseGraph('reclassification-fee-credit-rogue');
    const refund = await finalizedRefundEvidence(
      graph, 'reclassification-fee-credit-rogue-refund', [50, 50]
    );
    await replayFixtureSubject(refund, 'reclassification-fee-credit-rogue-refund-seed');
    const feeCredit = await stagedDisputeEvidence(
      graph, 'reclassification-fee-credit-rogue-dispute', 'fee_credit'
    );
    const set = await databaseClient.pool.query<{ id: string }>(
      `insert into financial_allocation_sets
         (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
          basis, scope, expected_effect_minor, currency, algorithm_version,
          classifier_version, source_fingerprint_sha256)
       values ($1, $2, 'dispute', $3, 'gross_amount', 'title', 0, 'USD', 2, 1, $4)
       returning id`,
      [`fee-credit-rogue:${feeCredit.disputeId}:${randomUUID()}`,
        feeCredit.balanceTransactionId, feeCredit.disputeId, feeCredit.fingerprint]
    );
    await databaseClient.pool.query(
      `insert into dispute_item_allocations
         (allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
          effect, reverses_allocation_id, subtotal_effect_minor, tax_effect_minor,
          total_effect_minor, currency)
       values ($1, $2, $3, $4, 'withdrawal', null, 0, 0, 0, 'USD')`,
      [`fee-credit-rogue-presentment:${randomUUID()}`, feeCredit.disputeId,
        set.rows[0]!.id, graph.itemA]
    );

    await expect(replayFixtureSubject(refund, 'reclassification-fee-credit-rogue-blocked'))
      .rejects.toMatchObject({ safeCode: 'state_changed' });
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'missing',
        safeCode: 'missing_source' }),
      expect.objectContaining({ basis: 'fee', status: 'missing', safeCode: 'missing_source' })
    ]);
  });

  it('rejects a raw exact-target dispute fork even when one exposure tip is valid', async () => {
    const graph = await correctionRebaseGraph('reclassification-dispute-raw-fork');
    const refund = await finalizedRefundEvidence(
      graph, 'reclassification-dispute-raw-fork-refund', [50, 50]
    );
    await replayFixtureSubject(refund, 'reclassification-dispute-raw-fork-refund-seed');
    const withdrawal = await stagedDisputeEvidence(
      graph, 'reclassification-dispute-raw-fork-withdrawal', 'withdrawal'
    );
    await replayFixtureSubject(withdrawal, 'reclassification-dispute-raw-fork-valid-tip');
    await databaseClient.pool.query(
      `insert into financial_allocation_sets
         (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
          basis, scope, expected_effect_minor, currency, algorithm_version,
          classifier_version, source_fingerprint_sha256)
       values ($1, $2, 'dispute', $3, 'gross_amount', 'account', 0, 'USD', 2, 1, $4)`,
      [`dispute-raw-fork:${withdrawal.disputeId}:${randomUUID()}`,
        withdrawal.balanceTransactionId, withdrawal.disputeId, 'f'.repeat(64)]
    );

    await expect(replayFixtureSubject(refund, 'reclassification-dispute-raw-fork-blocked'))
      .rejects.toMatchObject({ safeCode: 'state_changed' });
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [refund.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'missing',
        safeCode: 'missing_source' }),
      expect.objectContaining({ basis: 'fee', status: 'missing', safeCode: 'missing_source' })
    ]);
  });

  it('appends a target decision and successor sets without editing version-one history', async () => {
    await resetProjectionVersionForFixture({
      classifierVersion: 1, allocationAlgorithmVersion: 1,
      correlationId: 'reclassification-append-seed-c1-a1'
    });
    const fixture = await adjustmentFixture('reclassification-append', 1);
    const result = await databaseClient.db.transaction(async (tx) => {
      await activateProjectionVersionForFixture(tx, {
        classifierVersion: 2, allocationAlgorithmVersion: 3,
        correlationId: 'reclassification-activate-c2-a3'
      });
      return replayFinancialClassificationLocked(tx, {
        subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
        sourceFingerprintSha256: fixture.fingerprint, classifierVersion: 2,
        allocationAlgorithmVersion: 3, replayId: 'c2-a3',
        correlationId: 'reclassification-replay-c2-a3'
      });
    });

    expect(result).toMatchObject({ status: 'replayed',
      subjectId: fixture.balanceTransactionId });
    const history = await databaseClient.pool.query<{
      id: string; classifier_version: number; algorithm_version: number;
      supersedes_set_id: string | null;
    }>(`select id, classifier_version, algorithm_version, supersedes_set_id
        from financial_allocation_sets where balance_transaction_id=$1
        order by basis, created_at, id`, [fixture.balanceTransactionId]);
    expect(history.rows).toHaveLength(4);
    expect(history.rows.filter((row) => row.classifier_version === 1 &&
      row.algorithm_version === 1)).toHaveLength(2);
    expect(history.rows.filter((row) => row.classifier_version === 2 &&
      row.algorithm_version === 3)).toHaveLength(2);
    expect(new Set(history.rows.filter((row) => row.supersedes_set_id !== null)
      .map((row) => row.supersedes_set_id))).toEqual(
        new Set(fixture.roots.map((root) => root.setId)));
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ status: 'complete', basis: 'gross_amount',
        expectedEffectMinor: 25, scope: 'account' }),
      expect.objectContaining({ status: 'complete', basis: 'fee',
        expectedEffectMinor: 0, scope: 'account' })
    ]);
    const audits = await databaseClient.pool.query<{ action: string }>(
      `select action from audit_events where correlation_id in
        ('reclassification-activate-c2-a3', 'reclassification-replay-c2-a3')`
    );
    expect(audits.rows.filter((row) => row.action ===
      'financial.classification.appended')).toHaveLength(1);
    expect(audits.rows.filter((row) => row.action ===
      'financial.allocation.superseded')).toHaveLength(2);
  });

  it('reclassifies historical unknown durable evidence as supported without mutating history', async () => {
    const fixture = await legacyUnknownAdjustmentFixture('reclassification-unknown');
    const pending = await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 3, replayId: 'c2-a3'
    });
    await expect(databaseClient.pool.query(
      `select id from financial_allocation_sets where balance_transaction_id=$1`,
      [fixture.balanceTransactionId]
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(replayFinancialClassification({
      database: databaseClient.db,
      targetClassifierVersion: 2,
      targetAllocationAlgorithmVersion: 3
    }, {
      payload: {
        subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
        sourceFingerprintSha256: fixture.fingerprint, classifierVersion: 2,
        allocationAlgorithmVersion: 3, replayId: 'c2-a3',
        scanRunId: pending.id
      },
      correlationId: 'reclassification-unknown-replay',
      signal: new AbortController().signal
    })).resolves.toBeUndefined();

    const classifications = await databaseClient.pool.query<{
      classifier_version: number; classification: string;
    }>(`select classifier_version, classification
        from financial_classification_versions where subject_type='balance_transaction'
          and subject_id=$1 order by classifier_version`, [fixture.balanceTransactionId]);
    expect(classifications.rows).toEqual([
      { classifier_version: 1, classification: 'unknown' },
      { classifier_version: 2, classification: 'other' }
    ]);
    const allocations = await databaseClient.pool.query<{
      classifier_version: number; algorithm_version: number;
      supersedes_set_id: string | null;
    }>(`select classifier_version, algorithm_version, supersedes_set_id
        from financial_allocation_sets where balance_transaction_id=$1
        order by basis`, [fixture.balanceTransactionId]);
    expect(allocations.rows).toEqual([
      { classifier_version: 2, algorithm_version: 3, supersedes_set_id: null },
      { classifier_version: 2, algorithm_version: 3, supersedes_set_id: null }
    ]);
    await databaseClient.db.execute(sql`
      update financial_projection_versions set
        classifier_version = 2, allocation_algorithm_version = 3,
        pending_classifier_version = null, pending_allocation_algorithm_version = null,
        pending_replay_id = null, pending_scan_run_id = null,
        activated_at = now(),
        activation_correlation_id = 'reclassification-unknown-activate'
      where singleton = true and pending_scan_run_id = ${pending.id}
    `);
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ status: 'complete', basis: 'gross_amount',
        expectedEffectMinor: 25, scope: 'account' }),
      expect.objectContaining({ status: 'complete', basis: 'fee',
        expectedEffectMinor: 0, scope: 'account' })
    ]);
  });

  it('lets c2 recover an exact active unknown fee-detail exception with no allocation tips', async () => {
    const pending = await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2'
    });
    const fixture = await chargeFixture(
      'reclassification-unknown-fee', false, false, true
    );
    if (!fixture.feeDetailId || !fixture.feeDetailFingerprint) {
      throw new Error('Expected fee-detail replay fixture');
    }
    await ownerDatabaseClient.pool.query(
      'alter table financial_classification_versions disable trigger ' +
      'financial_classification_versions_immutable'
    );
    try {
      await ownerDatabaseClient.pool.query(
        `delete from financial_classification_versions
          where subject_type='fee_detail' and subject_id=$1 and classifier_version=1`,
        [fixture.feeDetailId]
      );
    } finally {
      await ownerDatabaseClient.pool.query(
        'alter table financial_classification_versions enable trigger ' +
        'financial_classification_versions_immutable'
      );
    }
    await databaseClient.db.transaction(async (tx) => {
      await appendClassificationDecisionLocked(tx, {
        subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
        classifierVersion: 1, sourceFingerprint: fixture.fingerprint,
        decision: { status: 'classified', classification: 'charge',
          impact: 'informational' },
        correlationId: 'reclassification-active-charge'
      });
      const unknownFeeClassification = await appendClassificationDecisionLocked(tx, {
        subjectType: 'fee_detail', subjectId: fixture.feeDetailId!,
        classifierVersion: 1, sourceFingerprint: fixture.feeDetailFingerprint!,
        decision: { status: 'unknown', classification: 'unknown', impact: 'exception',
          safeCode: 'unsupported_category' },
        correlationId: 'reclassification-active-unknown-fee'
      });
      await observeFinancialIssue(tx, {
        resourceType: 'financial_classification', resourceId: unknownFeeClassification.id,
        safeCode: 'unsupported_category', impact: 'exception',
        actor: { type: 'system', id: 'financial-worker' },
        correlationId: 'reclassification-active-unknown-fee'
      });
    });
    await expect(databaseClient.pool.query(
      `select id from financial_allocation_sets where balance_transaction_id=$1`,
      [fixture.balanceTransactionId]
    )).resolves.toMatchObject({ rowCount: 0 });

    await expect(replayFinancialClassification({
      database: workerDatabaseClient.db,
      targetClassifierVersion: 2,
      targetAllocationAlgorithmVersion: 2
    }, {
      payload: {
        subjectType: 'fee_detail', subjectId: fixture.feeDetailId,
        sourceFingerprintSha256: fixture.feeDetailFingerprint,
        classifierVersion: 2, allocationAlgorithmVersion: 2,
        replayId: 'c2-a2', scanRunId: pending.id
      },
      correlationId: 'reclassification-unknown-fee-replay',
      signal: new AbortController().signal
    })).resolves.toBeUndefined();

    const target = await databaseClient.pool.query<{
      subject_type: string; classification: string;
    }>(`select subject_type, classification from financial_classification_versions
        where classifier_version=2 and subject_id in ($1, $2)
        order by subject_type`, [fixture.balanceTransactionId, fixture.feeDetailId]);
    expect(target.rows).toEqual([
      { subject_type: 'balance_transaction', classification: 'charge' },
      { subject_type: 'fee_detail', classification: 'processing_fee' }
    ]);
    await expect(databaseClient.pool.query(
      `select id from financial_allocation_sets
        where balance_transaction_id=$1 and classifier_version=2 and algorithm_version=2`,
      [fixture.balanceTransactionId]
    )).resolves.toMatchObject({ rowCount: 2 });
  });

  it('converges two target jobs on one physical successor per basis', async () => {
    const fixture = await adjustmentFixture('reclassification-race');
    await databaseClient.db.transaction((tx) => activateProjectionVersionForFixture(tx, {
      classifierVersion: 2, allocationAlgorithmVersion: 3,
      correlationId: 'reclassification-race-activate'
    }));
    const input = {
      subjectType: 'balance_transaction' as const,
      subjectId: fixture.balanceTransactionId,
      sourceFingerprintSha256: fixture.fingerprint,
      classifierVersion: 2, allocationAlgorithmVersion: 3, replayId: 'c2-a3'
    };
    const attempts = [
      databaseClient.db.transaction((tx) => replayFinancialClassificationLocked(tx,
        { ...input, correlationId: 'reclassification-race-a' })),
      databaseClient.db.transaction((tx) => replayFinancialClassificationLocked(tx,
        { ...input, correlationId: 'reclassification-race-b' }))
    ];
    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []);
    const rejected = settled.flatMap((result, index) =>
      result.status === 'rejected' ? [{ reason: result.reason, index }] : []);
    expect(fulfilled.filter((row) => row.status === 'replayed')).toHaveLength(1);
    for (const failure of rejected) {
      expect(failure.reason).toMatchObject({ safeCode: 'state_changed' });
    }
    const retries = await Promise.all(rejected.map((failure) =>
      databaseClient.db.transaction((tx) => replayFinancialClassificationLocked(tx, {
        ...input, correlationId: `reclassification-race-retry-${failure.index}`
      }))
    ));
    expect([...fulfilled, ...retries].filter((row) => row.status === 'unchanged'))
      .toHaveLength(1);
    const tips = await databaseClient.pool.query<{ basis: string; count: string }>(
      `select tip.basis, count(*)::text
       from financial_allocation_sets tip
       where tip.balance_transaction_id=$1 and not exists
         (select 1 from financial_allocation_sets successor where successor.supersedes_set_id=tip.id)
       group by tip.basis order by tip.basis`, [fixture.balanceTransactionId]
    );
    expect(tips.rows).toEqual([{ basis: 'gross_amount', count: '1' },
      { basis: 'fee', count: '1' }]);
  });

  it('serializes concurrent different-order jobs at the singleton before either purchase graph', async () => {
    const [first, second] = await Promise.all([
      chargeFixture('reclassification-order-a'),
      chargeFixture('reclassification-order-b')
    ]);
    const database = versionBarrierDatabase(2);
    const dependencies = {
      database, targetClassifierVersion: 2, targetAllocationAlgorithmVersion: 3
    };
    const results = await Promise.all([
      replayFinancialClassification(dependencies, replayInput(first,
        'reclassification-order-a-replay')),
      replayFinancialClassification(dependencies, replayInput(second,
        'reclassification-order-b-replay'))
    ]);
    expect(results).toEqual([undefined, undefined]);
    const targetRows = await databaseClient.pool.query<{ balance_transaction_id: string }>(
      `select balance_transaction_id from financial_allocation_sets
       where classifier_version=2 and algorithm_version=3 order by balance_transaction_id`
    );
    expect(new Set(targetRows.rows.map((row) => row.balance_transaction_id))).toEqual(
      new Set([first.balanceTransactionId, second.balanceTransactionId]));
    expect(targetRows.rows).toHaveLength(4);
  });

  it('keeps a refund-finalization purchase mutation ahead of replay without deadlock', async () => {
    const fixture = await chargeFixture('reclassification-finalization-barrier', true);
    if (!fixture.refundId) throw new Error('Expected refund barrier fixture');
    const finalizerLocked = deferred<void>();
    const releaseFinalizer = deferred<void>();
    const finalization = databaseClient.db.transaction(async (tx) => {
      await lockOrder(tx, fixture.orderId);
      const [order] = await tx.select().from(orders)
        .where(eq(orders.id, fixture.orderId)).for('update');
      const [payment] = await tx.select().from(payments)
        .where(eq(payments.id, fixture.paymentId)).for('update');
      if (!order || !payment) throw new Error('Expected finalization purchase roots');
      await lockPaymentPurchaseFacts(tx, payment, order);
      finalizerLocked.resolve();
      await releaseFinalizer.promise;
      await tx.update(refunds).set({ allocationStatus: 'finalized' })
        .where(eq(refunds.id, fixture.refundId!));
    });
    await finalizerLocked.promise;

    const replayPid = deferred<number>();
    const replayDatabase = {
      transaction: (work: (tx: never) => Promise<unknown>) =>
        databaseClient.db.transaction(async (tx) => {
          let captured = false;
          const proxy = new Proxy(tx, {
            get(target, property) {
              if (property === 'execute') {
                return async (query: unknown) => {
                  const result = await tx.execute(query as never);
                  if (!captured && rendered(query).includes('from financial_projection_versions')) {
                    captured = true;
                    const pid = await tx.execute(sql<{ pid: number }>`select pg_backend_pid() as pid`);
                    const value = (pid.rows[0] as { pid?: unknown } | undefined)?.pid;
                    if (typeof value !== 'number') throw new Error('Expected replay backend pid');
                    replayPid.resolve(value);
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
    const replay = replayFinancialClassification({
      database: replayDatabase, targetClassifierVersion: 2,
      targetAllocationAlgorithmVersion: 3
    }, replayInput(fixture, 'reclassification-finalization-replay'));
    const pid = await replayPid.promise;
    await expect(waitForBlockedPid(pid, 'pg_advisory_xact_lock')).resolves.toEqual(
      expect.arrayContaining([expect.any(Number)])
    );
    releaseFinalizer.resolve();
    await expect(Promise.all([finalization, replay])).resolves.toEqual([undefined, undefined]);
    const [refund] = await databaseClient.db.select().from(refunds)
      .where(eq(refunds.id, fixture.refundId));
    expect(refund?.allocationStatus).toBe('finalized');
  }, 15_000);

  it('does not let a superseded-set correction diagnostic override a global classification fork', async () => {
    const fixture = await adjustmentFixture('reclassification-fail-closed');
    const grossSetId = fixture.roots[0]?.setId;
    if (!grossSetId) throw new Error('Expected gross allocation set');
    const forkRepository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => new Date(), 'all',
      { classifierVersion: 1,
        allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION }
    );
    const forkMarker = createFinancialClassificationSubjectJob({
      subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
      sourceFingerprintSha256: fixture.fingerprint,
      classifierVersion: 1,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    });
    await enqueueJob(databaseClient.db, {
      ...forkMarker, payload: forkMarker.payload as never, runAt: new Date(0)
    });
    const forkWorker = 'reclassification-fail-closed-marker';
    const forkClaim = await forkRepository.claimNext(forkWorker);
    expect(forkClaim).toMatchObject({ payload: expect.objectContaining({
      subjectId: fixture.balanceTransactionId, classifierVersion: 1,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    }) });
    await expect(replayFinancialClassification({
      database: databaseClient.db, targetClassifierVersion: 1,
      targetAllocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    }, {
      payload: forkClaim!.payload as never,
      correlationId: 'reclassification-fail-closed-marker-run',
      signal: new AbortController().signal
    })).resolves.toBeUndefined();
    await expect(forkRepository.complete(forkClaim!.id, forkWorker)).resolves.toBe(true);
    const setsBeforeDiagnostics = await databaseClient.pool.query<{ count: string }>(
      `select count(*)::text as count from financial_allocation_sets
       where balance_transaction_id=$1`, [fixture.balanceTransactionId]
    );
    await expect(databaseClient.pool.query<{ count: string }>(
      `select count(*)::text as count from financial_allocation_sets
       where supersedes_set_id=$1`, [grossSetId]
    )).resolves.toMatchObject({ rows: [{ count: '1' }] });

    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, {
      resourceType: 'balance_transaction', resourceId: fixture.balanceTransactionId,
      safeCode: 'classification_fork', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: 'reclassification-global-allocation-tip-fork'
    }));

    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    })).resolves.toEqual([
      { status: 'exception', balanceTransactionId: fixture.balanceTransactionId,
        basis: 'gross_amount', safeCode: 'classification_fork' },
      { status: 'exception', balanceTransactionId: fixture.balanceTransactionId,
        basis: 'fee', safeCode: 'classification_fork' }
    ]);

    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, {
      resourceType: 'allocation_set', resourceId: grossSetId,
      safeCode: 'correction_rebase_required', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: 'reclassification-overlay'
    }));
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    })).resolves.toEqual([
      { status: 'exception', balanceTransactionId: fixture.balanceTransactionId,
        basis: 'gross_amount', safeCode: 'classification_fork' },
      { status: 'exception', balanceTransactionId: fixture.balanceTransactionId,
        basis: 'fee', safeCode: 'classification_fork' }
    ]);
    await expect(databaseClient.pool.query<{ count: string }>(
      `select count(*)::text as count from financial_reconciliation_issues
       where resource_type='allocation_set' and resource_id=$1
         and safe_code='correction_rebase_required' and state='open'`,
      [grossSetId]
    )).resolves.toMatchObject({ rows: [{ count: '1' }] });
    const setsAfterDiagnostics = await databaseClient.pool.query<{ count: string }>(
      `select count(*)::text as count from financial_allocation_sets
       where balance_transaction_id=$1`,
      [fixture.balanceTransactionId]
    );
    expect(setsAfterDiagnostics.rows).toEqual(setsBeforeDiagnostics.rows);
  });

  it('does not let a no-tip pending decision fork suppress the active pair', async () => {
    const fixture = await adjustmentFixture('reclassification-pending-decision-fork');
    await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2'
    });
    await databaseClient.db.transaction((tx) => appendClassificationDecisionLocked(tx, {
      subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
      classifierVersion: 2, sourceFingerprint: fixture.fingerprint,
      decision: { status: 'classified', classification: 'fee_credit',
        impact: 'informational' }, correlationId: 'reclassification-pending-fork-seed'
    }));

    await expect(databaseClient.db.transaction((tx) =>
      replayFinancialClassificationLocked(tx, {
        subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
        sourceFingerprintSha256: fixture.fingerprint, classifierVersion: 2,
        allocationAlgorithmVersion: 2, replayId: 'c2-a2',
        correlationId: 'reclassification-pending-fork-replay'
      }))).resolves.toEqual({ status: 'exception',
        subjectId: fixture.balanceTransactionId,
        safeCode: 'classification_fork', issueId: null });
    await expect(databaseClient.pool.query<{ count: string }>(
      `select count(*)::text as count from financial_reconciliation_issues
       where safe_code='classification_fork' and state='open'`
    )).resolves.toMatchObject({ rows: [{ count: '0' }] });
    await databaseClient.pool.query(
      `update jobs set status='succeeded', attempts=greatest(attempts, 1),
         completed_at=now(), locked_at=null, locked_by=null, last_error=null
       where type='commerce.financial-classification'
         and payload->>'subjectId'=$1
         and (payload->>'classifierVersion')::integer=1`,
      [fixture.balanceTransactionId]
    );
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({ basis: 'gross_amount', status: 'complete' }),
      expect.objectContaining({ basis: 'fee', status: 'complete' })
    ]);
  });

  it('scopes a correction rebase failure to its exact replacement set', async () => {
    const graph = await correctionRebaseGraph('reclassification-correction-issue-scope');
    const target = await finalizedRefundEvidence(
      graph, 'correction-issue-scope-target', [50, 50]
    );
    const oldGross = await insertRefundAllocationSet({
      label: 'correction-issue-scope-old-gross', refundId: target.refundId,
      balanceTransactionId: target.balanceTransactionId, fingerprint: target.fingerprint,
      expectedEffectMinor: -100, classifierVersion: 1,
      algorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      items: [{ orderItemId: graph.itemA, effectMinor: -50 },
        { orderItemId: graph.itemB, effectMinor: -50 }]
    });
    await insertRefundAllocationSet({
      label: 'correction-issue-scope-old-fee', refundId: target.refundId,
      balanceTransactionId: target.balanceTransactionId, fingerprint: target.fingerprint,
      expectedEffectMinor: 0, classifierVersion: 1,
      algorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      basis: 'fee', items: []
    });
    const correction = await insertRefundCorrection({
      label: 'correction-issue-scope-approved', refundId: target.refundId,
      baseSetId: oldGross, fingerprint: target.fingerprint, adminId: graph.adminId,
      items: [
        { domain: 'settlement', sourceSetId: oldGross, orderItemId: graph.itemA,
          approvedMinor: -50, deltaMinor: 0 },
        { domain: 'settlement', sourceSetId: oldGross, orderItemId: graph.itemB,
          approvedMinor: -50, deltaMinor: 0 },
        { domain: 'presentment', sourceSetId: null, orderItemId: graph.itemA,
          approvedMinor: 50, deltaMinor: 0 },
        { domain: 'presentment', sourceSetId: null, orderItemId: graph.itemB,
          approvedMinor: 50, deltaMinor: 0 }
      ]
    });
    const newGross = await insertRefundAllocationSet({
      label: 'correction-issue-scope-new-gross', refundId: target.refundId,
      balanceTransactionId: target.balanceTransactionId, fingerprint: target.fingerprint,
      expectedEffectMinor: -100, classifierVersion: 2, algorithmVersion: 3,
      supersedesSetId: oldGross,
      items: [{ orderItemId: graph.itemA, effectMinor: -50 },
        { orderItemId: graph.itemB, effectMinor: -50 }]
    });

    await expect(databaseClient.db.transaction((tx) =>
      rebaseApprovedCorrectionDistributionLocked(tx, {
        balanceTransactionId: target.balanceTransactionId, basis: 'gross_amount',
        previousAllocationSetId: oldGross, replacementAllocationSetId: newGross,
        approvedCorrectionSetId: correction,
        expectedSourceFingerprint: 'd'.repeat(64),
        correlationId: 'reclassification-correction-issue-scope-rebase'
      }))).resolves.toMatchObject({ status: 'exception' });

    await expect(databaseClient.pool.query<{
      resource_type: string; resource_id: string;
    }>(`select resource_type, resource_id::text
        from financial_reconciliation_issues
        where safe_code='correction_rebase_required' and state='open'
        order by resource_type, resource_id`
    )).resolves.toMatchObject({ rows: [{
      resource_type: 'allocation_set', resource_id: newGross
    }] });
    await expect(databaseClient.pool.query<{
      base_set_id: string; compatible_correction_tip_id: string | null;
      is_complete: boolean;
    }>(`select base_set_id, compatible_correction_tip_id, is_complete
        from current_financial_projection_heads
        where balance_transaction_id=$1 and basis='gross_amount'`,
      [target.balanceTransactionId])).resolves.toMatchObject({ rows: [{
      base_set_id: oldGross, compatible_correction_tip_id: correction, is_complete: true
    }] });
  });

  it('uses another compatible correction distribution when enforcing refund capacity', async () => {
    const graph = await correctionRebaseGraph('reclassification-corrected-capacity');
    const other = await finalizedRefundEvidence(graph, 'capacity-other', [20, 80]);
    const otherGross = await insertRefundAllocationSet({
      label: 'capacity-other-gross', refundId: other.refundId,
      balanceTransactionId: other.balanceTransactionId, fingerprint: other.fingerprint,
      expectedEffectMinor: -100, classifierVersion: 2, algorithmVersion: 3,
      items: [{ orderItemId: graph.itemA, effectMinor: -20 },
        { orderItemId: graph.itemB, effectMinor: -80 }]
    });
    await insertRefundAllocationSet({
      label: 'capacity-other-fee', refundId: other.refundId,
      balanceTransactionId: other.balanceTransactionId, fingerprint: other.fingerprint,
      expectedEffectMinor: 0, classifierVersion: 2, algorithmVersion: 3,
      basis: 'fee', items: []
    });
    const otherCorrection = await insertRefundCorrection({
      label: 'capacity-other-correction', refundId: other.refundId,
      baseSetId: otherGross, fingerprint: other.fingerprint, adminId: graph.adminId,
      items: [
        { domain: 'settlement', sourceSetId: otherGross, orderItemId: graph.itemA,
          approvedMinor: -20, deltaMinor: 0 },
        { domain: 'settlement', sourceSetId: otherGross, orderItemId: graph.itemB,
          approvedMinor: -80, deltaMinor: 0 },
        { domain: 'presentment', sourceSetId: null, orderItemId: graph.itemA,
          approvedMinor: 80, deltaMinor: 60 },
        { domain: 'presentment', sourceSetId: null, orderItemId: graph.itemB,
          approvedMinor: 20, deltaMinor: -60 }
      ]
    });
    const target = await finalizedRefundEvidence(graph, 'capacity-target', [20, 30]);
    const targetOld = await insertRefundAllocationSet({
      label: 'capacity-target-old', refundId: target.refundId,
      balanceTransactionId: target.balanceTransactionId, fingerprint: target.fingerprint,
      expectedEffectMinor: -50, classifierVersion: 1,
      algorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      items: [{ orderItemId: graph.itemA, effectMinor: -20 },
        { orderItemId: graph.itemB, effectMinor: -30 }]
    });
    const targetNew = await insertRefundAllocationSet({
      label: 'capacity-target-new', refundId: target.refundId,
      balanceTransactionId: target.balanceTransactionId, fingerprint: target.fingerprint,
      expectedEffectMinor: -50, classifierVersion: 2, algorithmVersion: 3,
      supersedesSetId: targetOld,
      items: [{ orderItemId: graph.itemA, effectMinor: -20 },
        { orderItemId: graph.itemB, effectMinor: -30 }]
    });
    const targetCorrection = await insertRefundCorrection({
      label: 'capacity-target-correction', refundId: target.refundId,
      baseSetId: targetOld, fingerprint: target.fingerprint, adminId: graph.adminId,
      items: [
        { domain: 'settlement', sourceSetId: targetOld, orderItemId: graph.itemA,
          approvedMinor: -20, deltaMinor: 0 },
        { domain: 'settlement', sourceSetId: targetOld, orderItemId: graph.itemB,
          approvedMinor: -30, deltaMinor: 0 },
        { domain: 'presentment', sourceSetId: null, orderItemId: graph.itemA,
          approvedMinor: 50, deltaMinor: 30 },
        { domain: 'presentment', sourceSetId: null, orderItemId: graph.itemB,
          approvedMinor: 0, deltaMinor: -30 }
      ]
    });
    await databaseClient.db.transaction((tx) => activateProjectionVersionForFixture(tx, {
      classifierVersion: 2, allocationAlgorithmVersion: 3,
      correlationId: 'reclassification-corrected-capacity-activate'
    }));
    const otherHead = await databaseClient.pool.query<{
      compatible_correction_tip_id: string | null; is_complete: boolean;
    }>(`select compatible_correction_tip_id, is_complete
        from current_financial_projection_heads
        where balance_transaction_id=$1 and basis='gross_amount'`,
      [other.balanceTransactionId]);
    expect(otherHead.rows).toEqual([{
      compatible_correction_tip_id: otherCorrection, is_complete: true
    }]);

    const result = await databaseClient.db.transaction((tx) =>
      rebaseApprovedCorrectionDistributionLocked(tx, {
        balanceTransactionId: target.balanceTransactionId, basis: 'gross_amount',
        previousAllocationSetId: targetOld, replacementAllocationSetId: targetNew,
        approvedCorrectionSetId: targetCorrection,
        expectedSourceFingerprint: target.fingerprint,
        correlationId: 'reclassification-corrected-capacity-rebase'
      }));
    expect(result).toMatchObject({ status: 'exception' });
    const successors = await databaseClient.pool.query<{ count: string }>(
      `select count(*)::text as count from refund_reporting_correction_sets
       where predecessor_correction_set_id=$1`, [targetCorrection]
    );
    expect(successors.rows).toEqual([{ count: '0' }]);
  });

  it('keeps the active correction tip visible while its target-version successor is pending', async () => {
    const graph = await correctionRebaseGraph('reclassification-pending-correction');
    const target = await finalizedRefundEvidence(graph, 'pending-correction-target', [50, 50]);
    const oldGross = await insertRefundAllocationSet({
      label: 'pending-correction-old', refundId: target.refundId,
      balanceTransactionId: target.balanceTransactionId, fingerprint: target.fingerprint,
      expectedEffectMinor: -100, classifierVersion: 1,
      algorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      items: [{ orderItemId: graph.itemA, effectMinor: -50 },
        { orderItemId: graph.itemB, effectMinor: -50 }]
    });
    const newGross = await insertRefundAllocationSet({
      label: 'pending-correction-new', refundId: target.refundId,
      balanceTransactionId: target.balanceTransactionId, fingerprint: target.fingerprint,
      expectedEffectMinor: -100, classifierVersion: 2, algorithmVersion: 3,
      supersedesSetId: oldGross,
      items: [{ orderItemId: graph.itemA, effectMinor: -50 },
        { orderItemId: graph.itemB, effectMinor: -50 }]
    });
    const oldCorrection = await insertRefundCorrection({
      label: 'pending-correction-approved', refundId: target.refundId,
      baseSetId: oldGross, fingerprint: target.fingerprint, adminId: graph.adminId,
      items: [
        { domain: 'settlement', sourceSetId: oldGross, orderItemId: graph.itemA,
          approvedMinor: -50, deltaMinor: 0 },
        { domain: 'settlement', sourceSetId: oldGross, orderItemId: graph.itemB,
          approvedMinor: -50, deltaMinor: 0 },
        { domain: 'presentment', sourceSetId: null, orderItemId: graph.itemA,
          approvedMinor: 50, deltaMinor: 0 },
        { domain: 'presentment', sourceSetId: null, orderItemId: graph.itemB,
          approvedMinor: 50, deltaMinor: 0 }
      ]
    });

    await expect(databaseClient.db.transaction((tx) =>
      rebaseApprovedCorrectionDistributionLocked(tx, {
        balanceTransactionId: target.balanceTransactionId, basis: 'gross_amount',
        previousAllocationSetId: oldGross, replacementAllocationSetId: newGross,
        approvedCorrectionSetId: oldCorrection,
        expectedSourceFingerprint: target.fingerprint,
        correlationId: 'reclassification-pending-correction-rebase'
      }))).resolves.toMatchObject({ status: 'rebased' });

    const activeHead = await databaseClient.pool.query<{
      base_set_id: string; compatible_correction_tip_id: string | null; is_complete: boolean;
    }>(`select base_set_id, compatible_correction_tip_id, is_complete
        from current_financial_projection_heads
        where balance_transaction_id=$1 and basis='gross_amount'`,
      [target.balanceTransactionId]);
    expect(activeHead.rows).toEqual([{
      base_set_id: oldGross,
      compatible_correction_tip_id: oldCorrection,
      is_complete: true
    }]);
  });

  it('refuses to rebase a correction omitting a nonzero presentment component', async () => {
    const graph = await correctionRebaseGraph('reclassification-omitted-presentment');
    const target = await finalizedRefundEvidence(graph, 'omitted-target', [50, 50]);
    const targetOld = await insertRefundAllocationSet({
      label: 'omitted-target-old', refundId: target.refundId,
      balanceTransactionId: target.balanceTransactionId, fingerprint: target.fingerprint,
      expectedEffectMinor: -100, classifierVersion: 1,
      algorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      items: [{ orderItemId: graph.itemA, effectMinor: -50 },
        { orderItemId: graph.itemB, effectMinor: -50 }]
    });
    const targetNew = await insertRefundAllocationSet({
      label: 'omitted-target-new', refundId: target.refundId,
      balanceTransactionId: target.balanceTransactionId, fingerprint: target.fingerprint,
      expectedEffectMinor: -100, classifierVersion: 2, algorithmVersion: 3,
      supersedesSetId: targetOld,
      items: [{ orderItemId: graph.itemA, effectMinor: -50 },
        { orderItemId: graph.itemB, effectMinor: -50 }]
    });
    const targetCorrection = await insertRefundCorrection({
      label: 'omitted-target-correction', refundId: target.refundId,
      baseSetId: targetOld, fingerprint: target.fingerprint, adminId: graph.adminId,
      items: [
        { domain: 'settlement', sourceSetId: targetOld, orderItemId: graph.itemA,
          approvedMinor: -50, deltaMinor: 0 },
        { domain: 'settlement', sourceSetId: targetOld, orderItemId: graph.itemB,
          approvedMinor: -50, deltaMinor: 0 },
        { domain: 'presentment', sourceSetId: null, orderItemId: graph.itemA,
          approvedMinor: 50, deltaMinor: 0 }
      ]
    });
    await databaseClient.db.transaction((tx) => activateProjectionVersionForFixture(tx, {
      classifierVersion: 2, allocationAlgorithmVersion: 3,
      correlationId: 'reclassification-omitted-presentment-activate'
    }));

    const result = await databaseClient.db.transaction((tx) =>
      rebaseApprovedCorrectionDistributionLocked(tx, {
        balanceTransactionId: target.balanceTransactionId, basis: 'gross_amount',
        previousAllocationSetId: targetOld, replacementAllocationSetId: targetNew,
        approvedCorrectionSetId: targetCorrection,
        expectedSourceFingerprint: target.fingerprint,
        correlationId: 'reclassification-omitted-presentment-rebase'
      }));
    expect(result).toMatchObject({ status: 'exception' });
    const evidence = await databaseClient.pool.query<{
      successors: string; issues: string;
    }>(`select
          (select count(*)::text from refund_reporting_correction_sets
           where predecessor_correction_set_id=$1) as successors,
          (select count(*)::text from financial_reconciliation_issues
           where resource_type='allocation_set' and resource_id=$2
              and safe_code='correction_rebase_required' and state='open') as issues`,
      [targetCorrection, targetNew]);
    expect(evidence.rows).toEqual([{ successors: '0', issues: '1' }]);
  });

  it('enforces singleton activation as componentwise-monotonic durable state', async () => {
    await expect(databaseClient.db.execute(sql`
      update financial_projection_versions
      set classifier_version = 2, allocation_algorithm_version = 3,
        activated_at = now(), activation_correlation_id = 'barrier-free-forbidden'
      where singleton = true
    `)).rejects.toMatchObject({ cause: { code: '55000' } });
    await databaseClient.db.transaction((tx) => activateProjectionVersionForFixture(tx, {
      classifierVersion: 2, allocationAlgorithmVersion: 3,
      correlationId: 'reclassification-monotonic'
    }));
    await expect(databaseClient.db.execute(sql`
      update financial_projection_versions
      set classifier_version = 1, allocation_algorithm_version = 4
      where singleton = true
    `)).rejects.toMatchObject({ cause: { code: '55000' } });
    await expect(ownerDatabaseClient.db.execute(sql`
      delete from financial_projection_versions where singleton = true
    `)).rejects.toMatchObject({ cause: { code: '55000' } });
  });
});
