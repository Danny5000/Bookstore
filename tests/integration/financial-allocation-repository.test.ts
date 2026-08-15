import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { stageBalanceTransaction } from '$lib/server/commerce/financial/ledger';
import { loadCurrentEffectiveAllocationProjection, persistFinancialAllocationPlanLocked } from '$lib/server/commerce/financial/allocations/repository';
import { financialAllocationSets, financialItemAllocations, guestIdentities, orderItems, orders, payments, titles } from '$lib/server/db/schema';
import { databaseClient } from './database';

const dialect = new PgDialect();
function rendered(query: unknown): string {
  return dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
}

describe('financial allocation repository', () => {
  it('reads exactly two deterministic missing projection heads for a staged transaction without allocations', async () => {
    const suffix = randomUUID();
    const staged = await stageBalanceTransaction(databaseClient.db, {
      id: `txn_allocation_repository_${suffix}`, livemode: false, sourceFamily: 'charge',
      sourceId: `ch_allocation_repository_${suffix}`, rawType: 'charge', reportingCategory: 'charge',
      balanceType: 'payments', amountMinor: 100, feeMinor: 0, netMinor: 100, currency: 'USD',
      status: 'available', createdAt: new Date('2026-08-01T00:00:00.000Z'),
      availableAt: new Date('2026-08-02T00:00:00.000Z'), exchangeRate: null,
      exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
    }, { correlationId: 'allocation-repository-missing' });

    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [staged.balanceTransactionId]
    })).resolves.toEqual([
      { status: 'missing', balanceTransactionId: staged.balanceTransactionId, basis: 'gross_amount', safeCode: 'missing_source' },
      { status: 'missing', balanceTransactionId: staged.balanceTransactionId, basis: 'fee', safeCode: 'missing_source' }
    ]);
  });

  it('surfaces a current unknown parent classification even while its exact active job is pending', async () => {
    const suffix = randomUUID();
    const staged = await stageBalanceTransaction(databaseClient.db, {
      id: `txn_allocation_unknown_${suffix}`, livemode: false, sourceFamily: 'unknown', sourceId: null,
      rawType: 'future_kind', reportingCategory: 'future_category', balanceType: 'payments',
      amountMinor: 100, feeMinor: 0, netMinor: 100, currency: 'USD', status: 'available',
      createdAt: new Date('2026-08-01T00:00:00.000Z'), availableAt: new Date('2026-08-02T00:00:00.000Z'),
      exchangeRate: null, exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
    }, { correlationId: 'allocation-repository-unknown' });
    const marker = await databaseClient.pool.query<{ status: string }>(
      `select status::text
       from jobs
       where type='commerce.financial-classification'
         and payload->>'subjectType'='balance_transaction'
         and payload->>'subjectId'=$1
         and (payload->>'classifierVersion')::integer=1
         and (payload->>'allocationAlgorithmVersion')::integer=1`,
      [staged.balanceTransactionId]
    );
    expect(marker.rows).toEqual([{ status: 'pending' }]);

    await expect(loadCurrentEffectiveAllocationProjection(databaseClient.db, {
      balanceTransactionIds: [staged.balanceTransactionId]
    })).resolves.toEqual([
      { status: 'exception', balanceTransactionId: staged.balanceTransactionId, basis: 'gross_amount', safeCode: 'unsupported_category' },
      { status: 'exception', balanceTransactionId: staged.balanceTransactionId, basis: 'fee', safeCode: 'unsupported_category' }
    ]);
  });

  it('persists and exactly replays linked payment gross and zero-fee title projections', async () => {
    const suffix = randomUUID();
    const titleId = randomUUID(); const orderId = randomUUID(); const itemId = randomUUID();
    const chargeId = `ch_allocation_repository_${suffix}`;
    const [guest] = await databaseClient.db.insert(guestIdentities).values({ email: `allocation-${suffix}@example.com` }).returning();
    if (!guest) throw new Error('Expected guest fixture');
    await databaseClient.db.insert(titles).values({ id: titleId, slug: `allocation-${suffix}`, title: 'Allocation title',
      description: 'Allocation description', creatorName: 'Allocation creator', format: 'prose', priceMinor: 100,
      currency: 'USD', visibility: 'private' });
    await databaseClient.db.insert(orders).values({ id: orderId, status: 'paid', guestIdentityId: guest.id, purchaseEmail: guest.email,
      currency: 'USD', subtotalMinor: 100, taxMinor: 0, totalMinor: 100, clientCheckoutAttemptId: randomUUID(),
      quoteFingerprintSha256: 'b'.repeat(64), stripeCheckoutSessionId: `cs_${suffix}`,
      statusTokenSha256: 'c'.repeat(64), checkoutExpiresAt: new Date('2026-08-01T00:30:00.000Z'),
      paidAt: new Date('2026-08-01T00:00:00.000Z') });
    await databaseClient.db.insert(orderItems).values({ id: itemId, orderId, titleId, titleSnapshot: 'Allocation title',
      creatorNameSnapshot: 'Allocation creator', format: 'prose', currency: 'USD', unitSubtotalMinor: 100,
      taxMinor: 0, totalMinor: 100, stripeLineItemId: `li_${suffix}` });
    const [payment] = await databaseClient.db.insert(payments).values({ orderId,
      stripePaymentIntentId: `pi_${suffix}`, stripeLatestChargeId: chargeId, status: 'succeeded', amountMinor: 100,
      currency: 'USD', paymentMethodCategory: 'card', paidAt: new Date('2026-08-01T00:00:00.000Z') }).returning();
    if (!payment) throw new Error('Expected payment fixture');
    const staged = await stageBalanceTransaction(databaseClient.db, { id: `txn_allocation_persist_${suffix}`,
      livemode: false, sourceFamily: 'charge', sourceId: chargeId, rawType: 'charge', reportingCategory: 'charge',
      balanceType: 'payments', amountMinor: 100, feeMinor: 0, netMinor: 100, currency: 'USD', status: 'available',
      createdAt: new Date('2026-08-01T00:00:00.000Z'), availableAt: new Date('2026-08-02T00:00:00.000Z'),
      exchangeRate: null, exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
    }, { correlationId: 'allocation-repository-persist' });
    const fingerprint = (await databaseClient.pool.query<{ fingerprint_sha256: string }>(
      'select fingerprint_sha256 from stripe_balance_transactions where id=$1', [staged.balanceTransactionId])).rows[0]!.fingerprint_sha256;
    const common = { balanceTransactionId: staged.balanceTransactionId, currency: 'USD', algorithmVersion: 1,
      sourceFingerprint: fingerprint, supersedesSetId: null, reversalOfSetId: null };
    const gross = { sourceKind: 'payment' as const, sourceId: payment.id, classificationVersion: 1,
      correlationId: 'allocation-repository-gross', plan: { ...common, allocationIdentity: `payment:${payment.id}:gross`,
        basis: 'gross_amount' as const, scope: 'title' as const, expectedEffectMinor: 100,
        items: [{ orderItemId: itemId, component: 'sale_subtotal' as const, effectMinor: 100, currency: 'USD', tieBreakKey: itemId }] } };
    const fee = { sourceKind: 'payment' as const, sourceId: payment.id, classificationVersion: 1,
      correlationId: 'allocation-repository-fee', plan: { ...common, allocationIdentity: `payment:${payment.id}:fee`,
        basis: 'fee' as const, scope: 'title' as const, expectedEffectMinor: 0, items: [] } };
    const inserted = await databaseClient.db.transaction(async (tx) => [
      await persistFinancialAllocationPlanLocked(tx, gross), await persistFinancialAllocationPlanLocked(tx, fee)
    ]);
    expect(inserted.map((entry) => entry.disposition)).toEqual(['inserted', 'inserted']);
    await expect(databaseClient.db.transaction(async (tx) => [
      await persistFinancialAllocationPlanLocked(tx, gross), await persistFinancialAllocationPlanLocked(tx, fee)
    ])).resolves.toEqual(inserted.map((entry) => ({ ...entry, disposition: 'unchanged' })));
    await expect(databaseClient.db.transaction((tx) => persistFinancialAllocationPlanLocked(tx, {
      sourceKind: 'adjustment', sourceId: staged.balanceTransactionId,
      classificationVersion: 1, correlationId: 'allocation-repository-owner-downgrade',
      plan: {
        ...common, allocationIdentity: `adjustment:${staged.balanceTransactionId}:wrong-owner`,
        basis: 'gross_amount', scope: 'account', expectedEffectMinor: 100, items: [],
        supersedesSetId: inserted[0]!.setId
      }
    }))).rejects.toMatchObject({
      name: 'PermanentFinancialError', safeCode: 'source_linkage_mismatch'
    });
    const direct = await databaseClient.pool.connect();
    try {
      await direct.query('begin');
      await expect(direct.query(
        `insert into financial_allocation_sets
           (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
            basis, scope, expected_effect_minor, currency, algorithm_version,
            classifier_version, source_fingerprint_sha256, supersedes_set_id)
         values ($1, $2, 'adjustment', $2, 'gross_amount', 'account', 100, 'USD',
           1, 1, $3, $4)`,
        [`adjustment:${staged.balanceTransactionId}:direct-wrong-owner`,
          staged.balanceTransactionId, fingerprint, inserted[0]!.setId]
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await direct.query('rollback');
      direct.release();
    }
    const missingBalanceId = randomUUID();
    const missingFingerprint = 'f'.repeat(64);
    await databaseClient.pool.query(
      `insert into stripe_balance_transactions
         (id, provider_id, live_mode, source_family, source_id, raw_type,
          reporting_category, balance_type, amount_minor, fee_minor, net_minor,
          currency, status, provider_created_at, available_at, fingerprint_sha256)
       values ($1, $2, false, 'adjustment', null, 'adjustment', 'other_adjustment',
         'adjustment', 100, 0, 100, 'USD', 'available', $3, $3, $4)`,
      [missingBalanceId, `txn_allocation_missing_classification_${suffix}`,
        new Date('2026-08-01T00:00:00.000Z'), missingFingerprint]
    );
    const missingPredecessorId = randomUUID();
    const missingEvidence = await databaseClient.pool.connect();
    try {
      await missingEvidence.query('begin');
      await missingEvidence.query(
        `insert into financial_allocation_sets
           (id, allocation_identity, balance_transaction_id, source_kind, source_internal_id,
            basis, scope, expected_effect_minor, currency, algorithm_version,
            classifier_version, source_fingerprint_sha256)
         values ($1, $2, $3, 'adjustment', $3, 'gross_amount', 'account', 100,
           'USD', 1, 1, $4)`,
        [missingPredecessorId,
          `adjustment:${missingBalanceId}:missing-classification-root`,
          missingBalanceId, missingFingerprint]
      );
      await expect(missingEvidence.query(
        `insert into financial_allocation_sets
           (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
            basis, scope, expected_effect_minor, currency, algorithm_version,
            classifier_version, source_fingerprint_sha256, supersedes_set_id)
         values ($1, $2, 'payment', $3, 'gross_amount', 'title', 100, 'USD',
           1, 1, $4, $5)`,
        [`payment:${payment.id}:missing-classification-successor`,
          missingBalanceId, payment.id, missingFingerprint,
          missingPredecessorId]
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await missingEvidence.query('rollback');
      missingEvidence.release();
    }
    expect(await loadCurrentEffectiveAllocationProjection(databaseClient.db, { balanceTransactionIds: [staged.balanceTransactionId] }))
      .toEqual([{ status: 'complete', balanceTransactionId: staged.balanceTransactionId, basis: 'gross_amount',
        baseSetId: inserted[0]!.setId, compatibleCorrectionTipId: null, scope: 'title', currency: 'USD', expectedEffectMinor: 100,
        items: [{ orderItemId: itemId, component: 'sale_subtotal', effectMinor: 100, currency: 'USD' }] },
      { status: 'complete', balanceTransactionId: staged.balanceTransactionId, basis: 'fee', baseSetId: inserted[1]!.setId,
        compatibleCorrectionTipId: null, scope: 'title', currency: 'USD', expectedEffectMinor: 0, items: [] }]);
    expect(await databaseClient.db.select().from(financialAllocationSets)).toHaveLength(2);
    expect(await databaseClient.db.select().from(financialItemAllocations)).toHaveLength(1);
    await expect(databaseClient.db.transaction((tx) => persistFinancialAllocationPlanLocked(tx, {
      ...gross, sourceId: randomUUID(), plan: { ...gross.plan, allocationIdentity: `${gross.plan.allocationIdentity}:wrong` }
    }))).rejects.toMatchObject({ safeCode: 'source_linkage_mismatch' });
    expect(await databaseClient.db.select().from(financialAllocationSets)).toHaveLength(2);
  });

  it('rejects a second reversal root for one target while allowing successors in that chain', async () => {
    const suffix = randomUUID();
    const titleId = randomUUID(); const orderId = randomUUID(); const itemId = randomUUID();
    const chargeId = `ch_allocation_reversal_${suffix}`;
    const [guest] = await databaseClient.db.insert(guestIdentities)
      .values({ email: `allocation-reversal-${suffix}@example.com` }).returning();
    if (!guest) throw new Error('Expected guest fixture');
    await databaseClient.db.insert(titles).values({ id: titleId, slug: `allocation-reversal-${suffix}`,
      title: 'Allocation reversal title', description: 'Allocation reversal description',
      creatorName: 'Allocation reversal creator', format: 'prose', priceMinor: 100,
      currency: 'USD', visibility: 'private' });
    await databaseClient.db.insert(orders).values({ id: orderId, status: 'paid', guestIdentityId: guest.id,
      purchaseEmail: guest.email, currency: 'USD', subtotalMinor: 100, taxMinor: 0, totalMinor: 100,
      clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'b'.repeat(64),
      stripeCheckoutSessionId: `cs_reversal_${suffix}`, statusTokenSha256: 'c'.repeat(64),
      checkoutExpiresAt: new Date('2026-08-01T00:30:00.000Z'), paidAt: new Date('2026-08-01T00:00:00.000Z') });
    await databaseClient.db.insert(orderItems).values({ id: itemId, orderId, titleId,
      titleSnapshot: 'Allocation reversal title', creatorNameSnapshot: 'Allocation reversal creator',
      format: 'prose', currency: 'USD', unitSubtotalMinor: 100, taxMinor: 0, totalMinor: 100,
      stripeLineItemId: `li_reversal_${suffix}` });
    const [payment] = await databaseClient.db.insert(payments).values({ orderId,
      stripePaymentIntentId: `pi_reversal_${suffix}`, stripeLatestChargeId: chargeId,
      status: 'succeeded', amountMinor: 100, currency: 'USD', paymentMethodCategory: 'card',
      paidAt: new Date('2026-08-01T00:00:00.000Z') }).returning();
    if (!payment) throw new Error('Expected payment fixture');

    const staged: Array<{ balanceTransactionId: string }> = [];
    for (const label of ['target', 'root-one', 'root-two'] as const) {
      staged.push(await stageBalanceTransaction(databaseClient.db, {
        id: `txn_allocation_reversal_${label}_${suffix}`, livemode: false, sourceFamily: 'charge',
        sourceId: chargeId, rawType: 'charge', reportingCategory: 'charge', balanceType: 'payments',
        amountMinor: 100, feeMinor: 0, netMinor: 100, currency: 'USD', status: 'available',
        createdAt: new Date('2026-08-01T00:00:00.000Z'), availableAt: new Date('2026-08-02T00:00:00.000Z'),
        exchangeRate: null, exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
      }, { correlationId: `allocation-reversal-${label}` }));
    }
    const fingerprints = await Promise.all(staged.map(async ({ balanceTransactionId }) =>
      (await databaseClient.pool.query<{ fingerprint_sha256: string }>(
        'select fingerprint_sha256 from stripe_balance_transactions where id=$1', [balanceTransactionId]
      )).rows[0]!.fingerprint_sha256));
    const planFor = (index: number, allocationIdentity: string, supersedesSetId: string | null,
      reversalOfSetId: string | null) => ({ sourceKind: 'payment' as const, sourceId: payment.id,
      classificationVersion: 1, correlationId: allocationIdentity, plan: {
        allocationIdentity, balanceTransactionId: staged[index]!.balanceTransactionId,
        basis: 'gross_amount' as const, scope: 'title' as const, currency: 'USD', expectedEffectMinor: 100,
        algorithmVersion: 1, sourceFingerprint: fingerprints[index]!, supersedesSetId, reversalOfSetId,
        items: [{ orderItemId: itemId, component: 'sale_subtotal' as const, effectMinor: 100,
          currency: 'USD', tieBreakKey: itemId }]
      } });
    const target = await databaseClient.db.transaction((tx) =>
      persistFinancialAllocationPlanLocked(tx, planFor(0, `payment:${payment.id}:target`, null, null)));
    const competingRoots = await Promise.allSettled([1, 2].map((index) =>
      databaseClient.db.transaction((tx) => persistFinancialAllocationPlanLocked(tx,
        planFor(index, `payment:${payment.id}:reversal-root-${index}`, null, target.setId)))));
    expect(competingRoots.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(competingRoots.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({
        name: 'PermanentFinancialError', safeCode: 'source_linkage_mismatch'
      }) })
    ]);
    const winnerIndex = competingRoots.findIndex((result) => result.status === 'fulfilled') + 1;
    const root = competingRoots.find((result) => result.status === 'fulfilled');
    if (!root || root.status !== 'fulfilled') throw new Error('Expected one reversal root');
    await expect(databaseClient.db.transaction((tx) => persistFinancialAllocationPlanLocked(tx,
      planFor(winnerIndex, `payment:${payment.id}:reversal-successor`, root.value.setId, target.setId))))
      .resolves.toMatchObject({ disposition: 'inserted' });
  });

  it('bounds a concurrent allocation-identity collision across different lock keys', async () => {
    const suffix = randomUUID();
    const staged: Array<{ balanceTransactionId: string }> = [];
    for (const label of ['gross', 'fee'] as const) {
      staged.push(await stageBalanceTransaction(databaseClient.db, {
        id: `txn_allocation_identity_${label}_${suffix}`, livemode: false,
        sourceFamily: 'adjustment', sourceId: `adj_allocation_identity_${label}_${suffix}`,
        rawType: 'adjustment', reportingCategory: 'other_adjustment', balanceType: 'adjustment',
        amountMinor: 100, feeMinor: 0, netMinor: 100, currency: 'USD', status: 'available',
        createdAt: new Date('2026-08-01T00:00:00.000Z'), availableAt: new Date('2026-08-02T00:00:00.000Z'),
        exchangeRate: null, exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
      }, { correlationId: `allocation-identity-${label}` }));
    }
    const fingerprints = await Promise.all(staged.map(async ({ balanceTransactionId }) =>
      (await databaseClient.pool.query<{ fingerprint_sha256: string }>(
        'select fingerprint_sha256 from stripe_balance_transactions where id=$1', [balanceTransactionId]
      )).rows[0]!.fingerprint_sha256));
    const identity = `adjustment:shared-identity:${suffix}`;
    const plans = staged.map(({ balanceTransactionId }, index) => ({
      sourceKind: 'adjustment' as const, sourceId: balanceTransactionId, classificationVersion: 1,
      correlationId: `allocation-identity-race-${index}`, plan: {
        allocationIdentity: identity, balanceTransactionId,
        basis: (index === 0 ? 'gross_amount' : 'fee') as 'gross_amount' | 'fee',
        scope: 'account' as const, currency: 'USD', expectedEffectMinor: index === 0 ? 100 : 0,
        algorithmVersion: 1, sourceFingerprint: fingerprints[index]!, supersedesSetId: null,
        reversalOfSetId: null, items: []
      }
    }));

    let arrivals = 0;
    let release!: () => void;
    const bothAtInsert = new Promise<void>((resolve) => { release = resolve; });
    const results = await Promise.allSettled(plans.map((plan) => databaseClient.db.transaction((tx) => {
      const gated = {
        execute: async (query: unknown) => {
          if (rendered(query).startsWith('insert into financial_allocation_sets')) {
            arrivals += 1;
            if (arrivals === 2) release();
            await bothAtInsert;
          }
          return tx.execute(query as never);
        }
      };
      return persistFinancialAllocationPlanLocked(gated as never, plan);
    })));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({
        name: 'PermanentFinancialError', safeCode: 'source_linkage_mismatch'
      }) })
    ]);
  });
});
