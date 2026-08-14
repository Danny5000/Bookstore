import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { loadCurrentEffectiveAllocationProjection, persistFinancialAllocationPlanLocked } from './repository';

const ID = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const ORDER = '77777777-7777-4777-8777-777777777777';
const FP = 'a'.repeat(64);
const dialect = new PgDialect();
function rendered(query: unknown) { return dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]); }

function executor(results: readonly unknown[][]) {
  const calls: unknown[] = [];
  let index = 0;
  return { calls, execute: async (query: unknown) => { calls.push(query); return { rows: results[index++] ?? [] }; } };
}

function input() {
  return {
    sourceKind: 'payment' as const, sourceId: ID, classificationVersion: 1, correlationId: 'repository-test',
    plan: { allocationIdentity: 'payment:one:gross', balanceTransactionId: ID, basis: 'gross_amount' as const,
      scope: 'title' as const, currency: 'USD', expectedEffectMinor: 100, algorithmVersion: 1,
      sourceFingerprint: FP, supersedesSetId: null, reversalOfSetId: null,
      items: [{ orderItemId: ITEM, component: 'sale_subtotal' as const, effectMinor: 100, currency: 'USD', tieBreakKey: ITEM }] }
  };
}

describe('financial allocation repository', () => {
  it('strictly rejects malformed or duplicate plan evidence before SQL', async () => {
    const db = executor([]);
    await expect(persistFinancialAllocationPlanLocked(db as never, { ...input(), extra: true } as never))
      .rejects.toMatchObject({ safeCode: 'source_linkage_mismatch' });
    await expect(persistFinancialAllocationPlanLocked(db as never, { ...input(), plan: { ...input().plan,
      items: [...input().plan.items, { ...input().plan.items[0] }] } } as never))
      .rejects.toMatchObject({ safeCode: 'allocation_mismatch' });
    expect(db.calls).toHaveLength(0);
  });

  it('requires exact own string keys and rejects symbol extras', async () => {
    const inherited = Object.create(input()) as ReturnType<typeof input>;
    Object.defineProperty(inherited, 'correlationId', { value: 'own-only', enumerable: true });
    const symbolExtra = { ...input(), [Symbol('provider-object')]: true };
    for (const candidate of [inherited, symbolExtra]) {
      const db = executor([]);
      await expect(persistFinancialAllocationPlanLocked(db as never, candidate as never))
        .rejects.toMatchObject({ safeCode: 'source_linkage_mismatch' });
      expect(db.calls).toHaveLength(0);
    }
  });

  it('rejects non-current classifier and algorithm versions before SQL', async () => {
    for (const candidate of [
      { ...input(), classificationVersion: 2 },
      { ...input(), plan: { ...input().plan, algorithmVersion: 2 } }
    ]) {
      const db = executor([]);
      await expect(persistFinancialAllocationPlanLocked(db as never, candidate))
        .rejects.toMatchObject({ safeCode: 'source_linkage_mismatch' });
      expect(db.calls).toHaveLength(0);
    }
  });

  it('allows a conserving zero-effect title plan with no items', async () => {
    const candidate = { ...input(), plan: { ...input().plan, basis: 'fee' as const,
      expectedEffectMinor: 0, items: [] } };
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'ch_one' }], [{ id: 'classification' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }], [{ id: ID, orderId: ORDER }], [],
      [], [{ id: '33333333-3333-4333-8333-333333333333' }]]);
    await expect(persistFinancialAllocationPlanLocked(db as never, candidate)).resolves.toMatchObject({ disposition: 'inserted' });
  });

  it.each([
    ['payment', 'charge', 'payments'], ['refund', 'refund', 'refunds'],
    ['dispute', 'dispute', 'disputes'], ['payout', 'payout', 'stripe_payouts']
  ] as const)('locks and proves durable %s source linkage', async (sourceKind, family, table) => {
    const candidate = sourceKind === 'payout'
      ? { ...input(), sourceKind, plan: { ...input().plan, scope: 'account' as const, items: [] } }
      : { ...input(), sourceKind };
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: family, providerSourceId: 'provider_source' }], [{ id: 'classification' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }], [{ id: ID, orderId: ORDER }],
      ...(sourceKind === 'payout' ? [] : [[{ id: ITEM }]]), [],
      [], [{ id: '33333333-3333-4333-8333-333333333333' }]]);
    await expect(persistFinancialAllocationPlanLocked(db as never, candidate)).resolves.toMatchObject({ disposition: 'inserted' });
    expect(rendered(db.calls[4]).sql).toContain(`from ${table}`);
    expect(rendered(db.calls[4]).sql).not.toContain('for update');
    expect(rendered(db.calls[0]).sql).toContain('pg_advisory_xact_lock');
  });

  it('requires payout plans to be account scoped with no title items', async () => {
    const db = executor([]);
    await expect(persistFinancialAllocationPlanLocked(db as never, { ...input(), sourceKind: 'payout' }))
      .rejects.toMatchObject({ safeCode: 'source_linkage_mismatch' });
    expect(db.calls).toHaveLength(0);
  });

  it('orders Unicode tie keys by code point for deterministic inserts', async () => {
    const other = '66666666-6666-4666-8666-666666666666';
    const originalItem = input().plan.items[0]!;
    const candidate = { ...input(), plan: { ...input().plan, items: [
      { ...originalItem, orderItemId: ITEM, effectMinor: 40, tieBreakKey: '\u{10000}' },
      { ...originalItem, orderItemId: other, effectMinor: 60, tieBreakKey: '\uE000' }
    ] } };
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }], [{ id: ID, orderId: ORDER }], [{ id: ITEM }, { id: other }], [],
      [], [{ id: '33333333-3333-4333-8333-333333333333' }], [], []]);
    await persistFinancialAllocationPlanLocked(db as never, candidate);
    expect(rendered(db.calls[9]).params).toContain('\uE000');
    expect(rendered(db.calls[10]).params).toContain('\u{10000}');
  });

  it('requires adjustment identity to be the BT and account-only', async () => {
    const db = executor([]);
    await expect(persistFinancialAllocationPlanLocked(db as never, { ...input(), sourceKind: 'adjustment',
      plan: { ...input().plan, scope: 'title' } })).rejects.toMatchObject({ safeCode: 'source_linkage_mismatch' });
    expect(db.calls).toHaveLength(0);
  });

  it('returns unchanged only for an exact identity and item replay', async () => {
    const candidate = input();
    const setId = '33333333-3333-4333-8333-333333333333';
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }], [{ id: ID, orderId: ORDER }], [{ id: ITEM }], [{ id: setId,
        allocationIdentity: candidate.plan.allocationIdentity, balanceTransactionId: ID, sourceKind: 'payment',
        sourceId: ID, basis: 'gross_amount', scope: 'title', expectedEffectMinor: 100, currency: 'USD',
        algorithmVersion: 1, classifierVersion: 1, sourceFingerprint: FP,
        supersedesSetId: null, reversalOfSetId: null }], [[...candidate.plan.items][0]]]);
    await expect(persistFinancialAllocationPlanLocked(db as never, candidate))
      .resolves.toEqual({ setId, disposition: 'unchanged' });
  });

  it('compares exact replay item values independent of object key insertion order', async () => {
    const candidate = input(); const setId = '33333333-3333-4333-8333-333333333333';
    const source = candidate.plan.items[0]!;
    const reordered = { currency: source.currency, effectMinor: source.effectMinor, component: source.component,
      tieBreakKey: source.tieBreakKey, orderItemId: source.orderItemId };
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }],
      [{ id: ID, orderId: ORDER }], [{ id: ITEM }], [{ id: setId, allocationIdentity: candidate.plan.allocationIdentity,
        balanceTransactionId: ID, sourceKind: 'payment', sourceId: ID, basis: 'gross_amount', scope: 'title',
        expectedEffectMinor: 100, currency: 'USD', algorithmVersion: 1, classifierVersion: 1,
        sourceFingerprint: FP, supersedesSetId: null, reversalOfSetId: null }], [reordered]]);
    await expect(persistFinancialAllocationPlanLocked(db as never, candidate))
      .resolves.toEqual({ setId, disposition: 'unchanged' });
  });

  it('rejects a new root identity when the locked current tip already exists before insert', async () => {
    const currentTip = '33333333-3333-4333-8333-333333333333';
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }],
      [{ id: ID, orderId: ORDER }], [{ id: ITEM }], [], [{ id: currentTip }]]);
    await expect(persistFinancialAllocationPlanLocked(db as never, { ...input(),
      plan: { ...input().plan, allocationIdentity: 'payment:second:gross' } }))
      .rejects.toMatchObject({ safeCode: 'source_linkage_mismatch' });
    expect(db.calls).toHaveLength(8);
    expect(rendered(db.calls[7]).sql).toContain('not exists');
    expect(rendered(db.calls[7]).sql).not.toContain('insert into');
  });

  it('requires the exact current predecessor tip and an unreversed nonchained reversal target', async () => {
    const predecessor = '33333333-3333-4333-8333-333333333333';
    const reversal = '44444444-4444-4444-8444-444444444444';
    const candidate = { ...input(), plan: { ...input().plan, supersedesSetId: predecessor, reversalOfSetId: reversal } };
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification', classification: 'charge' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }], [{ id: ID, orderId: ORDER }], [{ id: ITEM }], [], [{ id: predecessor }], [],
      [{ id: reversal, supersedesSetId: null, existingRootId: null }],
      [{ id: predecessor, sourceKind: 'payment', sourceId: ID, scope: 'title',
        reversalOfSetId: reversal, classifierVersion: 1, algorithmVersion: 1 }],
      [{ id: '55555555-5555-4555-8555-555555555555' }], []]);
    await expect(persistFinancialAllocationPlanLocked(db as never, candidate)).resolves.toMatchObject({ disposition: 'inserted' });
    expect(rendered(db.calls[7]).sql).toContain('not exists');
    expect(rendered(db.calls[7]).sql).not.toContain('classifier_version');
    expect(rendered(db.calls[7]).sql).not.toContain('algorithm_version');
    expect(rendered(db.calls[8]).sql).toContain('pg_advisory_xact_lock');
    expect(rendered(db.calls[9]).sql).toContain('existingRootId');
    expect(rendered(db.calls[10]).sql).toContain('reversal_of_set_id');
  });

  it('rejects a second independent reversal root for the same exact target before insert', async () => {
    const reversal = '44444444-4444-4444-8444-444444444444';
    const existingRoot = '55555555-5555-4555-8555-555555555555';
    const candidate = { ...input(), plan: { ...input().plan, reversalOfSetId: reversal } };
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }],
      [{ id: ID, orderId: ORDER }], [{ id: ITEM }], [], [],
      [{ id: reversal, existingRootId: existingRoot }], [{ id: reversal, existingRootId: existingRoot }]]);
    await expect(persistFinancialAllocationPlanLocked(db as never, candidate))
      .rejects.toMatchObject({ safeCode: 'source_linkage_mismatch' });
    expect(rendered(db.calls[8]).sql).toContain('pg_advisory_xact_lock');
    expect(rendered(db.calls[9]).sql).toContain('supersedes_set_id is null');
    expect(db.calls).toHaveLength(10);
  });

  it('requires an append-only reversal successor to preserve its predecessor target', async () => {
    const predecessor = '33333333-3333-4333-8333-333333333333';
    const reversal = '44444444-4444-4444-8444-444444444444';
    const candidate = { ...input(), plan: { ...input().plan, supersedesSetId: predecessor,
      reversalOfSetId: reversal } };
    const differentTarget = '66666666-6666-4666-8666-666666666666';
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification', classification: 'charge' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }],
      [{ id: ID, orderId: ORDER }], [{ id: ITEM }], [], [{ id: predecessor }], [],
      [{ id: reversal, supersedesSetId: null, existingRootId: null }],
      [{ id: predecessor, sourceKind: 'payment', sourceId: ID, scope: 'title',
        reversalOfSetId: differentTarget, classifierVersion: 1, algorithmVersion: 1 }]]);
    await expect(persistFinancialAllocationPlanLocked(db as never, candidate))
      .rejects.toMatchObject({ safeCode: 'source_linkage_mismatch' });
    expect(rendered(db.calls[10]).sql).toContain('reversal_of_set_id');
    expect(db.calls).toHaveLength(11);
  });

  it('maps a concurrent reversal-root unique collision to the bounded service error', async () => {
    const reversal = '44444444-4444-4444-8444-444444444444';
    const candidate = { ...input(), plan: { ...input().plan, reversalOfSetId: reversal } };
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }],
      [{ id: ID, orderId: ORDER }], [{ id: ITEM }], [], [], [], [{ id: reversal, existingRootId: null }]]);
    const execute = db.execute;
    db.execute = async (query: unknown) => {
      if (rendered(query).sql.startsWith('insert into financial_allocation_sets')) {
        throw { code: '23505', constraint: 'financial_allocation_sets_reversal_root_unique' };
      }
      return execute(query);
    };
    await expect(persistFinancialAllocationPlanLocked(db as never, candidate)).rejects.toMatchObject({
      name: 'PermanentFinancialError', safeCode: 'source_linkage_mismatch'
    });
  });

  it('maps a wrapped allocation-identity unique collision to the bounded service error', async () => {
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }],
      [{ id: ID, orderId: ORDER }], [{ id: ITEM }], [], []]);
    const execute = db.execute;
    db.execute = async (query: unknown) => {
      if (rendered(query).sql.startsWith('insert into financial_allocation_sets')) {
        throw { cause: { code: '23505', constraint: 'financial_allocation_sets_identity_unique' } };
      }
      return execute(query);
    };
    await expect(persistFinancialAllocationPlanLocked(db as never, input())).rejects.toMatchObject({
      name: 'PermanentFinancialError', safeCode: 'source_linkage_mismatch'
    });
  });

  it('rethrows unrelated unique collisions without laundering them', async () => {
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }],
      [{ id: ID, orderId: ORDER }], [{ id: ITEM }], [], []]);
    const execute = db.execute;
    const collision = { code: '23505', constraint: 'some_unrelated_unique' };
    db.execute = async (query: unknown) => {
      if (rendered(query).sql.startsWith('insert into financial_allocation_sets')) throw collision;
      return execute(query);
    };
    await expect(persistFinancialAllocationPlanLocked(db as never, input())).rejects.toBe(collision);
  });

  it('rejects a conserving title item owned by another source order', async () => {
    const db = executor([[], [{ amountMinor: 100, feeMinor: 0, currency: 'USD', fingerprint: FP,
      providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification' }],
      [{ detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 }],
      [{ id: ID, orderId: ORDER }], []]);
    await expect(persistFinancialAllocationPlanLocked(db as never, input()))
      .rejects.toMatchObject({ safeCode: 'source_linkage_mismatch' });
  });

  it('fails closed when fee details do not exactly sum to the BT fee or use its currency', async () => {
    for (const detail of [
      { detailCount: 0, classifiedCount: 0, unknownCount: 0, detailAmountSum: '0', currencyMismatchCount: 0 },
      { detailCount: 1, classifiedCount: 1, unknownCount: 0, detailAmountSum: '5', currencyMismatchCount: 1 }
    ]) {
      const originalItem = input().plan.items[0]!;
      const candidate = { ...input(), plan: { ...input().plan, basis: 'fee' as const, expectedEffectMinor: -7,
        items: [{ ...originalItem, component: 'processing_fee' as const, effectMinor: -7 }] } };
      const db = executor([[], [{ amountMinor: 100, feeMinor: 7, currency: 'USD', fingerprint: FP,
        providerSourceFamily: 'charge', providerSourceId: 'provider_source' }], [{ id: 'classification' }], [detail]]);
      await expect(persistFinancialAllocationPlanLocked(db as never, candidate))
        .rejects.toMatchObject({ safeCode: 'source_linkage_mismatch' });
    }
  });

  it('returns two deterministic missing projections per canonical requested id', async () => {
    const db = executor([[]]);
    await expect(loadCurrentEffectiveAllocationProjection(db as never, { balanceTransactionIds: [ID] }))
      .resolves.toEqual([
        { status: 'missing', balanceTransactionId: ID, basis: 'gross_amount', safeCode: 'missing_source' },
        { status: 'missing', balanceTransactionId: ID, basis: 'fee', safeCode: 'missing_source' }
      ]);
  });

  it('maps complete view heads and items while defensively conserving exact sums', async () => {
    const setId = '33333333-3333-4333-8333-333333333333';
    const db = executor([[
      { balanceTransactionId: ID, basis: 'gross_amount', baseSetId: setId, compatibleCorrectionTipId: null,
        scope: 'title', currency: 'USD', expectedEffectMinor: 100, isComplete: true, missingSourceCount: 0, proposedIssueCode: null },
      { balanceTransactionId: ID, basis: 'fee', baseSetId: null, compatibleCorrectionTipId: null,
        scope: null, currency: null, expectedEffectMinor: null, isComplete: false, missingSourceCount: 1, proposedIssueCode: 'missing_source' }
    ], [{ balanceTransactionId: ID, basis: 'gross_amount', baseSetId: setId, compatibleCorrectionTipId: null,
      orderItemId: ITEM, component: 'sale_subtotal', effectMinor: 100, currency: 'USD' }]]);
    const result = await loadCurrentEffectiveAllocationProjection(db as never, { balanceTransactionIds: [ID] });
    expect(result[0]).toMatchObject({ status: 'complete', expectedEffectMinor: 100 });
    expect(result[1]).toEqual({ status: 'missing', balanceTransactionId: ID, basis: 'fee', safeCode: 'missing_source' });
  });

  it('accepts a complete zero-effect title head with no items', async () => {
    const setId = '33333333-3333-4333-8333-333333333333';
    const db = executor([[{ balanceTransactionId: ID, basis: 'fee', baseSetId: setId,
      compatibleCorrectionTipId: null, scope: 'title', currency: 'USD', expectedEffectMinor: 0,
      isComplete: true, missingSourceCount: 0, proposedIssueCode: null }], []]);
    expect(await loadCurrentEffectiveAllocationProjection(db as never, { balanceTransactionIds: [ID] }))
      .toContainEqual({ status: 'complete', balanceTransactionId: ID, basis: 'fee', baseSetId: setId,
        compatibleCorrectionTipId: null, scope: 'title', currency: 'USD', expectedEffectMinor: 0, items: [] });
  });

  it('accepts a complete nonzero account head with no items', async () => {
    const setId = '33333333-3333-4333-8333-333333333333';
    const db = executor([[{ balanceTransactionId: ID, basis: 'gross_amount', baseSetId: setId,
      compatibleCorrectionTipId: null, scope: 'account', currency: 'USD', expectedEffectMinor: 100,
      isComplete: true, missingSourceCount: 0, proposedIssueCode: null }], []]);
    expect(await loadCurrentEffectiveAllocationProjection(db as never, { balanceTransactionIds: [ID] }))
      .toContainEqual({ status: 'complete', balanceTransactionId: ID, basis: 'gross_amount', baseSetId: setId,
        compatibleCorrectionTipId: null, scope: 'account', currency: 'USD', expectedEffectMinor: 100, items: [] });
  });

  it('rejects duplicate heads and foreign or duplicate item decisions', async () => {
    const setId = '33333333-3333-4333-8333-333333333333';
    const head = { balanceTransactionId: ID, basis: 'gross_amount', baseSetId: setId,
      compatibleCorrectionTipId: null, scope: 'title', currency: 'USD', expectedEffectMinor: 100,
      isComplete: true, missingSourceCount: 0, proposedIssueCode: null };
    const duplicateHeads = executor([[head, head], []]);
    expect(await loadCurrentEffectiveAllocationProjection(duplicateHeads as never, { balanceTransactionIds: [ID] }))
      .toContainEqual({ status: 'exception', balanceTransactionId: ID, basis: 'gross_amount', safeCode: 'allocation_fork' });
    const badItems = executor([[head], [
      { balanceTransactionId: ID, basis: 'gross_amount', baseSetId: '44444444-4444-4444-8444-444444444444', compatibleCorrectionTipId: null, orderItemId: ITEM, component: 'sale_subtotal', effectMinor: 50, currency: 'USD' },
      { balanceTransactionId: ID, basis: 'gross_amount', baseSetId: setId, compatibleCorrectionTipId: null, orderItemId: ITEM, component: 'sale_subtotal', effectMinor: 50, currency: 'USD' }
    ]]);
    expect(await loadCurrentEffectiveAllocationProjection(badItems as never, { balanceTransactionIds: [ID] }))
      .toContainEqual({ status: 'exception', balanceTransactionId: ID, basis: 'gross_amount', safeCode: 'allocation_mismatch' });
  });
});
