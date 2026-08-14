import { randomUUID } from 'node:crypto';
import { eq, sql, type SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  fingerprintBalanceTransaction,
  stageBalanceTransaction
} from '$lib/server/commerce/financial/ledger';
import { appendClassificationDecisionLocked } from '$lib/server/commerce/financial/classification';
import {
  rebaseApprovedCorrectionDistributionLocked,
  replayFinancialClassification,
  replayFinancialClassificationLocked
} from '$lib/server/commerce/financial/rebase';
import {
  commitFinancialScanPage,
  finalizeFinancialReplay,
  startOrResumeFinancialScan
} from '$lib/server/commerce/financial/scans/repository';
import {
  loadCurrentEffectiveAllocationProjection,
  persistFinancialAllocationPlanLocked
} from '$lib/server/commerce/financial/allocations/repository';
import { observeFinancialIssue } from '$lib/server/commerce/financial/issues';
import { lockOrder } from '$lib/server/commerce/lock';
import { lockPaymentPurchaseFacts } from '$lib/server/commerce/reconciliation';
import {
  guestIdentities, orderItems, orders, payments, refunds, titles
} from '$lib/server/db/schema';
import {
  financialClassificationVersions,
  stripeBalanceTransactions
} from '$lib/server/db/schema/financial-provider';
import { databaseClient } from './database';

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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

async function adjustmentFixture(label: string) {
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
    currency: 'USD', algorithmVersion: 1, sourceFingerprint: fingerprint,
    supersedesSetId: null, reversalOfSetId: null, items: []
  };
  const roots = await databaseClient.db.transaction(async (tx) => [
    await persistFinancialAllocationPlanLocked(tx, {
      sourceKind: 'adjustment', sourceId: staged.balanceTransactionId,
      classificationVersion: 1, correlationId: `${label}-gross`,
      plan: { ...common, allocationIdentity: `adjustment:${suffix}:gross`,
        basis: 'gross_amount', expectedEffectMinor: 25 }
    }),
    await persistFinancialAllocationPlanLocked(tx, {
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
  await databaseClient.db.insert(financialClassificationVersions).values({
    subjectType: 'balance_transaction', subjectId: balance.id,
    classifierVersion: 1, classification: 'unknown',
    sourceFingerprintSha256: fingerprint
  });
  return { balanceTransactionId: balance.id, fingerprint };
}

async function chargeFixture(
  label: string,
  withRefund = false,
  seedVersionOne = true,
  withFeeDetail = false
) {
  const suffix = `${label}_${randomUUID().replaceAll('-', '')}`;
  const orderId = randomUUID();
  const itemId = randomUUID();
  const titleId = randomUUID();
  const chargeId = `ch_${suffix}`;
  const [guest] = await databaseClient.db.insert(guestIdentities).values({
    email: `${suffix}@example.com`
  }).returning();
  if (!guest) throw new Error('Expected replay guest fixture');
  await databaseClient.db.insert(titles).values({
    id: titleId, slug: `replay-${randomUUID()}`, title: 'Replay title',
    description: 'Replay description',
    creatorName: 'Replay creator', format: 'prose', priceMinor: 100,
    currency: 'USD', visibility: 'private'
  });
  await databaseClient.db.insert(orders).values({
    id: orderId, status: 'paid', guestIdentityId: guest.id, purchaseEmail: guest.email,
    currency: 'USD', subtotalMinor: 100, taxMinor: 0, totalMinor: 100,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'b'.repeat(64),
    stripeCheckoutSessionId: `cs_${suffix}`, statusTokenSha256: 'c'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-12T00:30:00.000Z'),
    paidAt: new Date('2026-08-12T00:00:00.000Z')
  });
  await databaseClient.db.insert(orderItems).values({
    id: itemId, orderId, titleId, titleSnapshot: 'Replay title',
    creatorNameSnapshot: 'Replay creator', format: 'prose', currency: 'USD',
    unitSubtotalMinor: 100, taxMinor: 0, totalMinor: 100,
    stripeLineItemId: `li_${suffix}`
  });
  const [payment] = await databaseClient.db.insert(payments).values({
    orderId, stripePaymentIntentId: `pi_${suffix}`, stripeLatestChargeId: chargeId,
    status: 'succeeded', amountMinor: 100, currency: 'USD',
    paymentMethodCategory: 'card', paidAt: new Date('2026-08-12T00:00:00.000Z')
  }).returning();
  if (!payment) throw new Error('Expected replay payment fixture');
  const [refund] = withRefund
    ? await databaseClient.db.insert(refunds).values({
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
    currency: 'USD', algorithmVersion: 1, sourceFingerprint: fingerprint,
    supersedesSetId: null, reversalOfSetId: null
  };
  if (seedVersionOne) await databaseClient.db.transaction(async (tx) => {
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
  const [guest] = await databaseClient.db.insert(guestIdentities).values({
    email: `${suffix}@example.com`
  }).returning();
  if (!guest) throw new Error('Expected correction replay guest');
  const admin = await databaseClient.pool.query<{ id: string }>(
    `insert into "user" (name, email, email_verified)
     values ('Correction admin', $1, true) returning id`,
    [`admin_${suffix}@example.com`]
  );
  const titleIds: string[] = [];
  for (const side of ['a', 'b']) {
    const [title] = await databaseClient.db.insert(titles).values({
      slug: `rebase-${side}-${randomUUID()}`, title: `Rebase ${side}`,
      description: 'Rebase description', creatorName: 'Rebase creator',
      format: 'prose', priceMinor: 100, currency: 'USD', visibility: 'private'
    }).returning();
    if (!title) throw new Error('Expected correction replay title');
    titleIds.push(title.id);
  }
  const orderId = randomUUID();
  await databaseClient.db.insert(orders).values({
    id: orderId, status: 'paid', guestIdentityId: guest.id, purchaseEmail: guest.email,
    currency: 'USD', subtotalMinor: 200, taxMinor: 0, totalMinor: 200,
    clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: '8'.repeat(64),
    stripeCheckoutSessionId: `cs_${suffix}`, statusTokenSha256: '9'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-12T00:30:00.000Z'),
    paidAt: new Date('2026-08-12T00:00:00.000Z')
  });
  const itemIds: string[] = [];
  for (const [index, titleId] of titleIds.entries()) {
    const [item] = await databaseClient.db.insert(orderItems).values({
      orderId, titleId, titleSnapshot: `Rebase ${index}`,
      creatorNameSnapshot: 'Rebase creator', format: 'prose', currency: 'USD',
      unitSubtotalMinor: 100, taxMinor: 0, totalMinor: 100,
      stripeLineItemId: `li_${index}_${suffix}`
    }).returning();
    if (!item) throw new Error('Expected correction replay item');
    itemIds.push(item.id);
  }
  const [payment] = await databaseClient.db.insert(payments).values({
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
  distribution: readonly [number, number]
) {
  const suffix = `${label}_${randomUUID().replaceAll('-', '')}`;
  const providerRefundId = `re_${suffix}`;
  const amountMinor = distribution[0] + distribution[1];
  const [refund] = await databaseClient.db.insert(refunds).values({
    paymentId: graph.paymentId, stripeRefundId: providerRefundId, status: 'succeeded',
    amountMinor, currency: 'USD', providerCreatedAt: new Date('2026-08-12T00:10:00.000Z'),
    allocationStatus: 'finalized'
  }).returning();
  if (!refund) throw new Error('Expected correction replay refund');
  for (const [index, amount] of distribution.entries()) {
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
  it('defers c2 until late c1 preserves the active view, then converges on c2', async () => {
    const pending = await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2'
    });
    const fixture = await chargeFixture('reclassification-c2-first', false, false);
    const replay = (classifierVersion: number, allocationAlgorithmVersion: number,
      correlationId: string, scanRunId?: string) => replayFinancialClassification({
        database: databaseClient.db,
        targetClassifierVersion: classifierVersion,
        targetAllocationAlgorithmVersion: allocationAlgorithmVersion
      }, {
        payload: {
        subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
        sourceFingerprintSha256: fixture.fingerprint, classifierVersion,
        allocationAlgorithmVersion,
        replayId: `c${classifierVersion}-a${allocationAlgorithmVersion}`,
          ...(scanRunId === undefined ? {} : { scanRunId })
        },
        correlationId, signal: new AbortController().signal
      });

    await expect(replay(2, 2, 'reclassification-c2-first-create', pending.id))
      .rejects.toMatchObject({ safeCode: 'state_changed' });
    await expect(replay(1, 1, 'reclassification-c1-late'))
      .resolves.toBeUndefined();
    const activeBeforeC2 = await loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    });
    expect(activeBeforeC2).toEqual([
      expect.objectContaining({ status: 'complete', basis: 'gross_amount' }),
      expect.objectContaining({ status: 'complete', basis: 'fee' })
    ]);
    await expect(replay(2, 2, 'reclassification-c2-after-c1', pending.id))
      .resolves.toBeUndefined();
    await expect(replay(2, 2, 'reclassification-c2-exact-retry', pending.id))
      .resolves.toBeUndefined();

    const sealed = await commitFinancialScanPage(databaseClient.db, {
      runId: pending.id, expectedPhase: 'classification_replay_page',
      expectedCheckpoint: null, expectedPageCount: 0,
      nextPhase: 'classification_replay_page', nextCheckpoint: null,
      processedCount: 0, children: [], complete: true
    });
    const failedSibling = await databaseClient.pool.query(
      `insert into jobs
         (type, payload, deduplication_key, status, attempts, max_attempts,
          completed_at, last_error)
       values ('commerce.financial-classification', $1::jsonb, $2, 'failed', 5, 5,
         now(), 'bounded sibling failure') returning id`,
      [JSON.stringify({
        subjectType: 'balance_transaction', subjectId: randomUUID(),
        sourceFingerprintSha256: 'f'.repeat(64), classifierVersion: 2,
        allocationAlgorithmVersion: 2, replayId: 'c2-a2', scanRunId: pending.id
      }), `reclassification-failed-sibling:${randomUUID()}`]
    );
    expect(failedSibling.rowCount).toBe(1);
    await expect(finalizeFinancialReplay(databaseClient.db, {
      runId: pending.id, expectedCursorDigestSha256: sealed.cursorDigestSha256!,
      expectedPageCount: sealed.pageCount, classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      correlationId: 'reclassification-c2-blocked-finalize'
    })).rejects.toMatchObject({ safeCode: 'state_changed' });
    const authority = await databaseClient.pool.query<{
      classifier_version: number; allocation_algorithm_version: number;
      pending_classifier_version: number | null;
      pending_allocation_algorithm_version: number | null;
    }>(`select classifier_version, allocation_algorithm_version,
          pending_classifier_version, pending_allocation_algorithm_version
        from financial_projection_versions where singleton=true`);
    expect(authority.rows[0]).toEqual({
      classifier_version: 1, allocation_algorithm_version: 1,
      pending_classifier_version: 2, pending_allocation_algorithm_version: 2
    });

    const sets = await databaseClient.pool.query<{
      id: string; classifier_version: number; algorithm_version: number;
      allocation_identity: string;
    }>(`select id, classifier_version, algorithm_version, allocation_identity
      from financial_allocation_sets
        where balance_transaction_id=$1 order by basis`, [fixture.balanceTransactionId]);
    expect(sets.rows).toHaveLength(4);
    expect(sets.rows.filter((set) => set.classifier_version === 2 &&
      set.algorithm_version === 2 && set.allocation_identity.includes(':replay:c2-a2:')))
      .toHaveLength(2);
    const current = await loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    });
    expect(current).toEqual([
      expect.objectContaining({ status: 'complete', basis: 'gross_amount',
        baseSetId: expect.stringMatching(/^[0-9a-f-]{36}$/u) }),
      expect.objectContaining({ status: 'complete', basis: 'fee',
        baseSetId: expect.stringMatching(/^[0-9a-f-]{36}$/u) })
    ]);
    const activeIds = sets.rows.filter((set) => set.classifier_version === 1 &&
      set.algorithm_version === 1).map((set) => set.id).sort();
    expect(current.map((head) => 'baseSetId' in head ? head.baseSetId : null).sort())
      .toEqual(activeIds);
  });

  it('appends a target decision and successor sets without editing version-one history', async () => {
    const fixture = await adjustmentFixture('reclassification-append');
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
    await databaseClient.pool.query(
      'alter table financial_classification_versions disable trigger ' +
      'financial_classification_versions_immutable'
    );
    try {
      await databaseClient.pool.query(
        `delete from financial_classification_versions
          where subject_type='fee_detail' and subject_id=$1 and classifier_version=1`,
        [fixture.feeDetailId]
      );
    } finally {
      await databaseClient.pool.query(
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
      await appendClassificationDecisionLocked(tx, {
        subjectType: 'fee_detail', subjectId: fixture.feeDetailId!,
        classifierVersion: 1, sourceFingerprint: fixture.feeDetailFingerprint!,
        decision: { status: 'unknown', classification: 'unknown', impact: 'exception',
          safeCode: 'unsupported_category' },
        correlationId: 'reclassification-active-unknown-fee'
      });
    });
    await expect(databaseClient.pool.query(
      `select id from financial_allocation_sets where balance_transaction_id=$1`,
      [fixture.balanceTransactionId]
    )).resolves.toMatchObject({ rowCount: 0 });

    await expect(replayFinancialClassification({
      database: databaseClient.db,
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
    const results = await Promise.all([
      databaseClient.db.transaction((tx) => replayFinancialClassificationLocked(tx,
        { ...input, correlationId: 'reclassification-race-a' })),
      databaseClient.db.transaction((tx) => replayFinancialClassificationLocked(tx,
        { ...input, correlationId: 'reclassification-race-b' }))
    ]);
    expect(results.filter((row) => row.status === 'replayed')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'unchanged')).toHaveLength(1);
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

  it('fails a stale classification fork closed before a BT correction issue takes precedence', async () => {
    const fixture = await adjustmentFixture('reclassification-fail-closed');
    await databaseClient.db.transaction((tx) => appendClassificationDecisionLocked(tx, {
      subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
      classifierVersion: 2, sourceFingerprint: fixture.fingerprint,
      decision: { status: 'classified', classification: 'fee_credit',
        impact: 'informational' }, correlationId: 'reclassification-seed-fork'
    }));
    await databaseClient.db.transaction((tx) => activateProjectionVersionForFixture(tx, {
      classifierVersion: 2, allocationAlgorithmVersion: 1,
      correlationId: 'reclassification-fork-activate'
    }));
    await expect(databaseClient.db.transaction((tx) =>
      replayFinancialClassificationLocked(tx, {
        subjectType: 'balance_transaction', subjectId: fixture.balanceTransactionId,
        sourceFingerprintSha256: fixture.fingerprint, classifierVersion: 2,
        allocationAlgorithmVersion: 1, replayId: 'c2-a1',
        correlationId: 'reclassification-fork-replay'
      }))).resolves.toMatchObject({ status: 'exception',
        safeCode: 'classification_fork' });

    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    })).resolves.toEqual([
      { status: 'exception', balanceTransactionId: fixture.balanceTransactionId,
        basis: 'gross_amount', safeCode: 'classification_fork' },
      { status: 'exception', balanceTransactionId: fixture.balanceTransactionId,
        basis: 'fee', safeCode: 'classification_fork' }
    ]);

    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, {
      resourceType: 'balance_transaction', resourceId: fixture.balanceTransactionId,
      safeCode: 'correction_rebase_required', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: 'reclassification-overlay'
    }));
    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [fixture.balanceTransactionId]
    })).resolves.toEqual([
      { status: 'exception', balanceTransactionId: fixture.balanceTransactionId,
        basis: 'gross_amount', safeCode: 'correction_rebase_required' },
      { status: 'exception', balanceTransactionId: fixture.balanceTransactionId,
        basis: 'fee', safeCode: 'correction_rebase_required' }
    ]);
    const oldRows = await databaseClient.pool.query(
      'select id from financial_allocation_sets where balance_transaction_id=$1',
      [fixture.balanceTransactionId]
    );
    expect(oldRows.rows).toHaveLength(2);
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
      expectedEffectMinor: -50, classifierVersion: 1, algorithmVersion: 1,
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
      expectedEffectMinor: -100, classifierVersion: 1, algorithmVersion: 1,
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
      expectedEffectMinor: -100, classifierVersion: 1, algorithmVersion: 1,
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
           where resource_type='balance_transaction' and resource_id=$2
             and safe_code='correction_rebase_required' and state='open') as issues`,
      [targetCorrection, target.balanceTransactionId]);
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
    await expect(databaseClient.db.execute(sql`
      delete from financial_projection_versions where singleton = true
    `)).rejects.toMatchObject({ cause: { code: '55000' } });
  });
});
