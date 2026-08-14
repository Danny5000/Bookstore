import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermanentFinancialError } from './errors';
import {
  rebaseApprovedCorrectionDistributionLocked,
  replayFinancialClassification,
  replayFinancialClassificationLocked
} from './rebase';

const replaySeams = vi.hoisted(() => ({
  appendClassification: vi.fn(), persistAllocation: vi.fn(),
  observeIssue: vi.fn(), resolveIssue: vi.fn(), lockProjection: vi.fn(),
  lockPurchase: vi.fn(), replayRefund: vi.fn(), replayDispute: vi.fn()
}));
vi.mock('./classification', async (importOriginal) => ({
  ...await importOriginal<typeof import('./classification')>(),
  appendClassificationDecisionLocked: replaySeams.appendClassification
}));
vi.mock('./allocations/repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('./allocations/repository')>(),
  persistFinancialAllocationReplayPlanLocked: replaySeams.persistAllocation
}));
vi.mock('./issues', async (importOriginal) => ({
  ...await importOriginal<typeof import('./issues')>(),
  observeFinancialIssue: replaySeams.observeIssue,
  resolveFinancialIssueAfterRecompute: replaySeams.resolveIssue
}));
vi.mock('./locks', async (importOriginal) => ({
  ...await importOriginal<typeof import('./locks')>(),
  lockFinancialProjectionRows: replaySeams.lockProjection
}));
vi.mock('$lib/server/commerce/reconciliation', async (importOriginal) => ({
  ...await importOriginal<typeof import('$lib/server/commerce/reconciliation')>(),
  lockPaymentPurchaseFacts: replaySeams.lockPurchase
}));
vi.mock('./sources/refund', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sources/refund')>(),
  recomputeLockedRefundFinancialProjectionForVersion: replaySeams.replayRefund
}));
vi.mock('./sources/dispute', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sources/dispute')>(),
  recomputeLockedDisputeFinancialProjectionForVersion: replaySeams.replayDispute
}));

const balanceTransactionId = randomUUID();
const previousAllocationSetId = randomUUID();
const replacementAllocationSetId = randomUUID();
const approvedCorrectionSetId = randomUUID();

function input() {
  return {
    balanceTransactionId, basis: 'gross_amount' as const,
    previousAllocationSetId, replacementAllocationSetId, approvedCorrectionSetId,
    expectedSourceFingerprint: 'b'.repeat(64), correlationId: 'rebase-red'
  };
}

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`
  });
}

function executor(responses: unknown[][]) {
  const calls: SQL[] = [];
  const tx = {
    execute: async (query: SQL) => {
      calls.push(query);
      return { rows: responses.shift() ?? [] };
    },
    transaction: async <Value>(work: (transaction: never) => Promise<Value>) =>
      work(tx as never)
  };
  return {
    calls,
    tx: tx as never
  };
}

describe('rebaseApprovedCorrectionDistributionLocked', () => {
  it.each([
    { ...input(), correlationId: '' },
    { ...input(), expectedSourceFingerprint: 'private-provider-object' },
    { ...input(), replacementAllocationSetId: previousAllocationSetId },
    { ...input(), ignored: true }
  ])('rejects malformed or self-referential input without querying', async (candidate) => {
    const database = executor([]);
    await expect(rebaseApprovedCorrectionDistributionLocked(database.tx, candidate as never))
      .rejects.toBeInstanceOf(PermanentFinancialError);
    expect(database.calls).toHaveLength(0);
  });

  it('recomputes successor deltas from approved absolute values instead of copying old deltas', async () => {
    const refundId = randomUUID();
    const orderItemA = randomUUID();
    const orderItemB = randomUUID();
    const successorCorrectionId = randomUUID();
    const adminId = randomUUID();
    const database = executor([
      [{ id: approvedCorrectionSetId, refundId, correctionVersion: 4,
        baseAllocationSetId: previousAllocationSetId, predecessorCorrectionSetId: null,
        sourceFingerprint: 'b'.repeat(64), approvedByAdminId: adminId,
        refundStatus: 'succeeded', refundAllocationStatus: 'finalized' }],
      [{ domain: 'settlement', sourceAllocationSetId: previousAllocationSetId,
        orderItemId: orderItemA, component: 'refund_subtotal', currency: 'USD',
        approvedAbsoluteMinor: -60, deltaMinor: -10, stableTieBreakKey: 'a' },
      { domain: 'settlement', sourceAllocationSetId: previousAllocationSetId,
        orderItemId: orderItemB, component: 'refund_subtotal', currency: 'USD',
        approvedAbsoluteMinor: -40, deltaMinor: 10, stableTieBreakKey: 'b' }],
      [{ id: previousAllocationSetId, balanceTransactionId, basis: 'gross_amount',
        sourceKind: 'refund', sourceId: refundId, currency: 'USD', expectedEffectMinor: -100,
        sourceFingerprint: 'b'.repeat(64), supersedesSetId: null,
        classifierVersion: 1, algorithmVersion: 1 },
      { id: replacementAllocationSetId, balanceTransactionId, basis: 'gross_amount',
        sourceKind: 'refund', sourceId: refundId, currency: 'USD', expectedEffectMinor: -100,
        sourceFingerprint: 'b'.repeat(64), supersedesSetId: previousAllocationSetId,
        classifierVersion: 2, algorithmVersion: 3 }],
      [{ sourceAllocationSetId: replacementAllocationSetId, orderItemId: orderItemA,
        component: 'refund_subtotal', effectMinor: -70, currency: 'USD' },
      { sourceAllocationSetId: replacementAllocationSetId, orderItemId: orderItemB,
        component: 'refund_subtotal', effectMinor: -30, currency: 'USD' }],
      [],
      [{ id: successorCorrectionId }],
      [], [], []
    ]);

    await expect(rebaseApprovedCorrectionDistributionLocked(database.tx, input()))
      .resolves.toEqual({ status: 'rebased', correctionSetId: successorCorrectionId });

    const itemInserts = database.calls.map(rendered).filter((query) =>
      query.sql.includes('insert into') &&
        query.sql.includes('refund_reporting_correction_items'));
    expect(itemInserts).toHaveLength(2);
    expect(itemInserts.map((query) => query.params)).toEqual(expect.arrayContaining([
      expect.arrayContaining([orderItemA, -60, 10]),
      expect.arrayContaining([orderItemB, -40, -10])
    ]));
    const correctionLock = rendered(database.calls[0]!).sql;
    expect(correctionLock).not.toContain('pg_advisory_xact_lock');
    expect(correctionLock).toContain('for update of correction');
    expect(correctionLock).not.toContain('for update of correction, successor');
    const allocationMappingQuery = rendered(database.calls[2]!).sql;
    expect(allocationMappingQuery).toMatch(
      /not exists\s*\(\s*select 1 from financial_allocation_sets successor_tip/iu
    );
    const serialized = JSON.stringify(database.calls.map(rendered));
    expect(serialized).not.toContain('private-provider-object');
  });

  it('rebases gross, refund-fee, and presentment groups together with exact zero sums', async () => {
    const refundId = randomUUID();
    const oldFee = randomUUID();
    const newFee = randomUUID();
    const itemA = randomUUID();
    const itemB = randomUUID();
    const successorCorrectionId = randomUUID();
    const correctionItems = [
      { domain: 'settlement' as const, sourceAllocationSetId: previousAllocationSetId,
        orderItemId: itemA, component: 'refund_subtotal', currency: 'USD',
        approvedAbsoluteMinor: -60, deltaMinor: -10, stableTieBreakKey: 'gross-a' },
      { domain: 'settlement' as const, sourceAllocationSetId: previousAllocationSetId,
        orderItemId: itemB, component: 'refund_subtotal', currency: 'USD',
        approvedAbsoluteMinor: -40, deltaMinor: 10, stableTieBreakKey: 'gross-b' },
      { domain: 'settlement' as const, sourceAllocationSetId: oldFee,
        orderItemId: itemA, component: 'refund_fee', currency: 'USD',
        approvedAbsoluteMinor: -6, deltaMinor: -1, stableTieBreakKey: 'fee-a' },
      { domain: 'settlement' as const, sourceAllocationSetId: oldFee,
        orderItemId: itemB, component: 'refund_fee', currency: 'USD',
        approvedAbsoluteMinor: -4, deltaMinor: 1, stableTieBreakKey: 'fee-b' },
      { domain: 'presentment' as const, sourceAllocationSetId: null,
        orderItemId: itemA, component: 'refund_subtotal', currency: 'USD',
        approvedAbsoluteMinor: 60, deltaMinor: 10, stableTieBreakKey: 'presentment-a' },
      { domain: 'presentment' as const, sourceAllocationSetId: null,
        orderItemId: itemB, component: 'refund_subtotal', currency: 'USD',
        approvedAbsoluteMinor: 40, deltaMinor: -10, stableTieBreakKey: 'presentment-b' }
    ];
    const database = executor([
      [{ id: approvedCorrectionSetId, refundId, correctionVersion: 4,
        baseAllocationSetId: previousAllocationSetId, predecessorCorrectionSetId: null,
        sourceFingerprint: 'b'.repeat(64), approvedByAdminId: randomUUID(),
        refundStatus: 'succeeded', refundAllocationStatus: 'finalized' }],
      correctionItems,
      [
        { id: previousAllocationSetId, balanceTransactionId, basis: 'gross_amount',
          sourceKind: 'refund', sourceId: refundId, currency: 'USD',
          expectedEffectMinor: -100, sourceFingerprint: 'b'.repeat(64),
          supersedesSetId: null, classifierVersion: 1, algorithmVersion: 1 },
        { id: replacementAllocationSetId, balanceTransactionId, basis: 'gross_amount',
          sourceKind: 'refund', sourceId: refundId, currency: 'USD',
          expectedEffectMinor: -100, sourceFingerprint: 'b'.repeat(64),
          supersedesSetId: previousAllocationSetId, classifierVersion: 2,
          algorithmVersion: 3 },
        { id: oldFee, balanceTransactionId, basis: 'fee', sourceKind: 'refund',
          sourceId: refundId, currency: 'USD', expectedEffectMinor: -10,
          sourceFingerprint: 'b'.repeat(64), supersedesSetId: null,
          classifierVersion: 1, algorithmVersion: 1 },
        { id: newFee, balanceTransactionId, basis: 'fee', sourceKind: 'refund',
          sourceId: refundId, currency: 'USD', expectedEffectMinor: -10,
          sourceFingerprint: 'b'.repeat(64), supersedesSetId: oldFee,
          classifierVersion: 2, algorithmVersion: 3 }
      ],
      [
        { sourceAllocationSetId: replacementAllocationSetId, orderItemId: itemA,
          component: 'refund_subtotal', effectMinor: -70, currency: 'USD' },
        { sourceAllocationSetId: replacementAllocationSetId, orderItemId: itemB,
          component: 'refund_subtotal', effectMinor: -30, currency: 'USD' },
        { sourceAllocationSetId: newFee, orderItemId: itemA,
          component: 'refund_fee', effectMinor: -5, currency: 'USD' },
        { sourceAllocationSetId: newFee, orderItemId: itemB,
          component: 'refund_fee', effectMinor: -5, currency: 'USD' }
      ],
      [
        { orderItemId: itemA, component: 'refund_subtotal', currency: 'USD',
          baseMinor: 50, cumulativeOtherRefundMinor: '0', capacityMinor: 100 },
        { orderItemId: itemB, component: 'refund_subtotal', currency: 'USD',
          baseMinor: 50, cumulativeOtherRefundMinor: '0', capacityMinor: 100 }
      ],
      [{ id: successorCorrectionId }],
      ...correctionItems.map(() => []),
      []
    ]);

    await expect(rebaseApprovedCorrectionDistributionLocked(database.tx, input()))
      .resolves.toEqual({ status: 'rebased', correctionSetId: successorCorrectionId });
    const insertedItems = database.calls.map(rendered).filter((query) =>
      query.sql.includes('insert into') &&
      query.sql.includes('refund_reporting_correction_items'));
    expect(insertedItems).toHaveLength(6);
    expect(insertedItems.map((query) => query.params)).toEqual(expect.arrayContaining([
      expect.arrayContaining([replacementAllocationSetId, itemA, -60, 10]),
      expect.arrayContaining([newFee, itemA, -6, -1]),
      expect.arrayContaining([null, itemA, 60, 10])
    ]));
    const presentmentEvidenceQuery = rendered(database.calls[4]!).sql;
    expect(presentmentEvidenceQuery).toContain('cross join lateral');
    expect(presentmentEvidenceQuery).toContain('allocation.subtotal_minor');
    expect(presentmentEvidenceQuery).toContain('allocation.tax_minor');
    expect(presentmentEvidenceQuery).toContain('correction_presentment_keys');
    expect(presentmentEvidenceQuery).toContain('nonzero_current_presentment_keys');
    expect(presentmentEvidenceQuery).toContain('compatible_other_presentment_corrections');
    expect(presentmentEvidenceQuery).toContain('current_financial_projection_heads');
    expect(presentmentEvidenceQuery).toMatch(/left join refund_components component/iu);
    expect(presentmentEvidenceQuery).toContain('::text as "cumulativeOtherRefundMinor"');
  });

  it('preserves a settlement-only correction without inventing a presentment domain', async () => {
    const refundId = randomUUID();
    const itemA = randomUUID();
    const itemB = randomUUID();
    const successorCorrectionId = randomUUID();
    const database = executor([
      [{ id: approvedCorrectionSetId, refundId, correctionVersion: 4,
        baseAllocationSetId: previousAllocationSetId, predecessorCorrectionSetId: null,
        sourceFingerprint: 'b'.repeat(64), approvedByAdminId: randomUUID(),
        refundStatus: 'succeeded', refundAllocationStatus: 'finalized' }],
      [{ domain: 'settlement', sourceAllocationSetId: previousAllocationSetId,
        orderItemId: itemA, component: 'refund_subtotal', currency: 'USD',
        approvedAbsoluteMinor: -60, deltaMinor: -10, stableTieBreakKey: 'a' },
      { domain: 'settlement', sourceAllocationSetId: previousAllocationSetId,
        orderItemId: itemB, component: 'refund_subtotal', currency: 'USD',
        approvedAbsoluteMinor: -40, deltaMinor: 10, stableTieBreakKey: 'b' }],
      [{ id: previousAllocationSetId, balanceTransactionId, basis: 'gross_amount',
        sourceKind: 'refund', sourceId: refundId, currency: 'USD', expectedEffectMinor: -100,
        sourceFingerprint: 'b'.repeat(64), supersedesSetId: null,
        classifierVersion: 1, algorithmVersion: 1 },
      { id: replacementAllocationSetId, balanceTransactionId, basis: 'gross_amount',
        sourceKind: 'refund', sourceId: refundId, currency: 'USD', expectedEffectMinor: -100,
        sourceFingerprint: 'b'.repeat(64), supersedesSetId: previousAllocationSetId,
        classifierVersion: 2, algorithmVersion: 3 }],
      [{ sourceAllocationSetId: replacementAllocationSetId, orderItemId: itemA,
        component: 'refund_subtotal', effectMinor: -70, currency: 'USD' },
      { sourceAllocationSetId: replacementAllocationSetId, orderItemId: itemB,
        component: 'refund_subtotal', effectMinor: -30, currency: 'USD' }],
      [{ orderItemId: itemA, component: 'refund_subtotal', currency: 'USD',
        baseMinor: 50, cumulativeOtherRefundMinor: '0', capacityMinor: 100 },
      { orderItemId: itemB, component: 'refund_subtotal', currency: 'USD',
        baseMinor: 50, cumulativeOtherRefundMinor: '0', capacityMinor: 100 }],
      [{ id: successorCorrectionId }],
      [], [], []
    ]);

    await expect(rebaseApprovedCorrectionDistributionLocked(database.tx, input()))
      .resolves.toEqual({ status: 'rebased', correctionSetId: successorCorrectionId });
    const itemInserts = database.calls.map(rendered).filter((query) =>
      query.sql.includes('insert into') &&
      query.sql.includes('refund_reporting_correction_items'));
    expect(itemInserts).toHaveLength(2);
    expect(itemInserts.every((query) => !query.params.includes('presentment'))).toBe(true);
  });

  it('rejects a presentment correction that omits a nonzero current component', async () => {
    const refundId = randomUUID();
    const itemA = randomUUID();
    const itemB = randomUUID();
    replaySeams.observeIssue.mockResolvedValueOnce({ id: randomUUID() });
    const database = executor([
      [{ id: approvedCorrectionSetId, refundId, correctionVersion: 4,
        baseAllocationSetId: previousAllocationSetId, predecessorCorrectionSetId: null,
        sourceFingerprint: 'b'.repeat(64), approvedByAdminId: randomUUID(),
        refundStatus: 'succeeded', refundAllocationStatus: 'finalized' }],
      [
        { domain: 'settlement', sourceAllocationSetId: previousAllocationSetId,
          orderItemId: itemA, component: 'refund_subtotal', currency: 'USD',
          approvedAbsoluteMinor: -50, deltaMinor: 0, stableTieBreakKey: 'settlement-a' },
        { domain: 'settlement', sourceAllocationSetId: previousAllocationSetId,
          orderItemId: itemB, component: 'refund_subtotal', currency: 'USD',
          approvedAbsoluteMinor: -50, deltaMinor: 0, stableTieBreakKey: 'settlement-b' },
        { domain: 'presentment', sourceAllocationSetId: null,
          orderItemId: itemA, component: 'refund_subtotal', currency: 'USD',
          approvedAbsoluteMinor: 50, deltaMinor: 0, stableTieBreakKey: 'presentment-a' }
      ],
      [
        { id: previousAllocationSetId, balanceTransactionId, basis: 'gross_amount',
          sourceKind: 'refund', sourceId: refundId, currency: 'USD',
          expectedEffectMinor: -100, sourceFingerprint: 'b'.repeat(64),
          supersedesSetId: null, classifierVersion: 1, algorithmVersion: 1 },
        { id: replacementAllocationSetId, balanceTransactionId, basis: 'gross_amount',
          sourceKind: 'refund', sourceId: refundId, currency: 'USD',
          expectedEffectMinor: -100, sourceFingerprint: 'b'.repeat(64),
          supersedesSetId: previousAllocationSetId, classifierVersion: 2,
          algorithmVersion: 3 }
      ],
      [
        { sourceAllocationSetId: replacementAllocationSetId, orderItemId: itemA,
          component: 'refund_subtotal', effectMinor: -50, currency: 'USD' },
        { sourceAllocationSetId: replacementAllocationSetId, orderItemId: itemB,
          component: 'refund_subtotal', effectMinor: -50, currency: 'USD' }
      ],
      [
        { orderItemId: itemA, component: 'refund_subtotal', currency: 'USD',
          baseMinor: 50, cumulativeOtherRefundMinor: '0', capacityMinor: 100 },
        { orderItemId: itemB, component: 'refund_subtotal', currency: 'USD',
          baseMinor: 50, cumulativeOtherRefundMinor: '0', capacityMinor: 100 }
      ],
      [], []
    ]);

    await expect(rebaseApprovedCorrectionDistributionLocked(database.tx, input()))
      .resolves.toMatchObject({ status: 'exception' });
    const sqlText = database.calls.map(rendered).map((query) => query.sql).join('\n');
    expect(sqlText).not.toContain('insert into refund_reporting_correction_sets');
    expect(sqlText).toContain('financial.correction.rebase_failed');
  });

  it('validates capacity against a compatible correction on another refund', async () => {
    const refundId = randomUUID();
    const itemId = randomUUID();
    const successorCorrectionId = randomUUID();
    const database = executor([
      [{ id: approvedCorrectionSetId, refundId, correctionVersion: 4,
        baseAllocationSetId: previousAllocationSetId, predecessorCorrectionSetId: null,
        sourceFingerprint: 'b'.repeat(64), approvedByAdminId: randomUUID(),
        refundStatus: 'succeeded', refundAllocationStatus: 'finalized' }],
      [
        { domain: 'settlement', sourceAllocationSetId: previousAllocationSetId,
          orderItemId: itemId, component: 'refund_subtotal', currency: 'USD',
          approvedAbsoluteMinor: -80, deltaMinor: 0, stableTieBreakKey: 'settlement' },
        { domain: 'presentment', sourceAllocationSetId: null,
          orderItemId: itemId, component: 'refund_subtotal', currency: 'USD',
          approvedAbsoluteMinor: 80, deltaMinor: 0, stableTieBreakKey: 'presentment' }
      ],
      [
        { id: previousAllocationSetId, balanceTransactionId, basis: 'gross_amount',
          sourceKind: 'refund', sourceId: refundId, currency: 'USD',
          expectedEffectMinor: -80, sourceFingerprint: 'b'.repeat(64),
          supersedesSetId: null, classifierVersion: 1, algorithmVersion: 1 },
        { id: replacementAllocationSetId, balanceTransactionId, basis: 'gross_amount',
          sourceKind: 'refund', sourceId: refundId, currency: 'USD',
          expectedEffectMinor: -80, sourceFingerprint: 'b'.repeat(64),
          supersedesSetId: previousAllocationSetId, classifierVersion: 2,
          algorithmVersion: 3 }
      ],
      [{ sourceAllocationSetId: replacementAllocationSetId, orderItemId: itemId,
        component: 'refund_subtotal', effectMinor: -80, currency: 'USD' }],
      [{ orderItemId: itemId, component: 'refund_subtotal', currency: 'USD',
        baseMinor: 80, cumulativeOtherRefundMinor: '20', capacityMinor: 100 }],
      [{ id: successorCorrectionId }],
      [], [], []
    ]);

    await expect(rebaseApprovedCorrectionDistributionLocked(database.tx, input()))
      .resolves.toEqual({ status: 'rebased', correctionSetId: successorCorrectionId });
    const presentmentQuery = database.calls.map(rendered).find((query) =>
      query.sql.includes('effective_other_components'));
    expect(presentmentQuery?.sql).toContain('compatible_correction_tip_id');
    expect(presentmentQuery?.sql).toContain('item.approved_absolute_minor');
    expect(presentmentQuery?.sql).toMatch(
      /not exists[\s\S]*compatible_other_presentment_corrections/iu
    );
  });

  it('converges on the existing correction successor on replay', async () => {
    const successorCorrectionId = randomUUID();
    const database = executor([
      [{ id: approvedCorrectionSetId, refundId: randomUUID(), correctionVersion: 1,
        baseAllocationSetId: previousAllocationSetId, predecessorCorrectionSetId: null,
        sourceFingerprint: 'b'.repeat(64), approvedByAdminId: randomUUID(),
        refundStatus: 'succeeded', refundAllocationStatus: 'finalized',
        successorId: successorCorrectionId,
        successorKind: 'classifier_rebase', successorCorrectionVersion: 2,
        successorPredecessorCorrectionSetId: approvedCorrectionSetId,
        successorBaseAllocationSetId: replacementAllocationSetId,
        successorSourceFingerprint: 'b'.repeat(64) }]
    ]);
    await expect(rebaseApprovedCorrectionDistributionLocked(database.tx, input()))
      .resolves.toEqual({ status: 'rebased', correctionSetId: successorCorrectionId });
    expect(database.calls).toHaveLength(1);
  });

  it('converges on a canonical successor after a bounded insert identity collision', async () => {
    const successorCorrectionId = randomUUID();
    const refundId = randomUUID();
    const itemId = randomUUID();
    const error = Object.assign(new Error('duplicate'), {
      code: '23505', constraint: 'refund_reporting_correction_sets_successor_unique'
    });
    const tx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{
          id: approvedCorrectionSetId, refundId, correctionVersion: 1,
          baseAllocationSetId: previousAllocationSetId, predecessorCorrectionSetId: null,
          sourceFingerprint: 'b'.repeat(64), approvedByAdminId: randomUUID(),
          refundStatus: 'succeeded', refundAllocationStatus: 'finalized'
        }] })
        .mockResolvedValueOnce({ rows: [{ domain: 'settlement',
          sourceAllocationSetId: previousAllocationSetId, orderItemId: itemId,
          component: 'refund_subtotal', currency: 'USD', approvedAbsoluteMinor: -100,
          deltaMinor: 0, stableTieBreakKey: 'one' }] })
        .mockResolvedValueOnce({ rows: [
          { id: previousAllocationSetId, balanceTransactionId, basis: 'gross_amount',
            sourceKind: 'refund', sourceId: refundId, currency: 'USD',
            expectedEffectMinor: -100, sourceFingerprint: 'b'.repeat(64),
            supersedesSetId: null, classifierVersion: 1, algorithmVersion: 1 },
          { id: replacementAllocationSetId, balanceTransactionId, basis: 'gross_amount',
            sourceKind: 'refund', sourceId: refundId, currency: 'USD',
            expectedEffectMinor: -100, sourceFingerprint: 'b'.repeat(64),
            supersedesSetId: previousAllocationSetId, classifierVersion: 2,
            algorithmVersion: 3 }
        ] })
        .mockResolvedValueOnce({ rows: [{ sourceAllocationSetId: replacementAllocationSetId,
          orderItemId: itemId, component: 'refund_subtotal', effectMinor: -100,
          currency: 'USD' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ rows: [{ id: successorCorrectionId,
          kind: 'classifier_rebase', correctionVersion: 2,
          predecessorCorrectionSetId: approvedCorrectionSetId,
          baseAllocationSetId: replacementAllocationSetId,
          sourceFingerprint: 'b'.repeat(64) }] })
    } as { execute: ReturnType<typeof vi.fn>; transaction?: unknown };
    tx.transaction = async (work: (nested: typeof tx) => Promise<unknown>) => work(tx);

    await expect(rebaseApprovedCorrectionDistributionLocked(tx as never, input()))
      .resolves.toEqual({ status: 'rebased', correctionSetId: successorCorrectionId });
  });

  it('does not mistake an intervening administrative correction for an idempotent rebase', async () => {
    const issueId = randomUUID();
    replaySeams.observeIssue.mockResolvedValueOnce({ id: issueId });
    const database = executor([
      [{ id: approvedCorrectionSetId, refundId: randomUUID(), correctionVersion: 1,
        baseAllocationSetId: previousAllocationSetId, predecessorCorrectionSetId: null,
        sourceFingerprint: 'b'.repeat(64), approvedByAdminId: randomUUID(),
        refundStatus: 'succeeded', refundAllocationStatus: 'finalized',
        successorId: randomUUID(), successorKind: 'allocation_attribution_correction',
        successorCorrectionVersion: 2,
        successorPredecessorCorrectionSetId: approvedCorrectionSetId,
        successorBaseAllocationSetId: replacementAllocationSetId,
        successorSourceFingerprint: 'b'.repeat(64) }],
      []
    ]);

    await expect(rebaseApprovedCorrectionDistributionLocked(database.tx, input()))
      .resolves.toEqual({ status: 'exception', issueId });
    expect(rendered(database.calls[1]!).sql).toContain('financial.correction.rebase_failed');
  });

  it('fails closed when the corrected refund is no longer succeeded and finalized', async () => {
    const issueId = randomUUID();
    replaySeams.observeIssue.mockResolvedValueOnce({ id: issueId });
    const database = executor([
      [{ id: approvedCorrectionSetId, refundId: randomUUID(), correctionVersion: 1,
        baseAllocationSetId: previousAllocationSetId, predecessorCorrectionSetId: null,
        sourceFingerprint: 'b'.repeat(64), approvedByAdminId: randomUUID(),
        refundStatus: 'pending', refundAllocationStatus: 'draft',
        successorId: randomUUID(), successorKind: 'classifier_rebase',
        successorCorrectionVersion: 2,
        successorPredecessorCorrectionSetId: approvedCorrectionSetId,
        successorBaseAllocationSetId: replacementAllocationSetId,
        successorSourceFingerprint: 'b'.repeat(64) }],
      []
    ]);

    await expect(rebaseApprovedCorrectionDistributionLocked(database.tx, input()))
      .resolves.toEqual({ status: 'exception', issueId });
  });
});

describe('replayFinancialClassification operation identity lock', () => {
  it('still builds an inactive supported target when no composite barrier is registered', async () => {
    const executorState = executor([
      [{ classifierVersion: 1, allocationAlgorithmVersion: 1,
        pendingClassifierVersion: null, pendingAllocationAlgorithmVersion: null,
        pendingReplayId: null, pendingScanRunId: null }],
      []
    ]);
    const database = {
      transaction: async <Value>(work: (transaction: never) => Promise<Value>) =>
        work(executorState.tx)
    } as never;

    await replayFinancialClassification({
      database, targetClassifierVersion: 2, targetAllocationAlgorithmVersion: 3
    }, {
      payload: {
        subjectType: 'balance_transaction', subjectId: balanceTransactionId,
        sourceFingerprintSha256: 'c'.repeat(64), classifierVersion: 2,
        allocationAlgorithmVersion: 3, replayId: 'c2-a3'
      },
      correlationId: 'inactive-unlinked-replay', signal: new AbortController().signal
    }).catch(() => undefined);

    expect(executorState.calls.length).toBeGreaterThan(1);
    expect(executorState.calls.map((query) => rendered(query).sql).join('\n'))
      .not.toContain('update financial_projection_versions');
  });

  it('still converges a run-linked replay for the already active pair', async () => {
    const executorState = executor([
      [{ classifierVersion: 2, allocationAlgorithmVersion: 3,
        pendingClassifierVersion: null, pendingAllocationAlgorithmVersion: null,
        pendingReplayId: null, pendingScanRunId: null }],
      []
    ]);
    const database = {
      transaction: async <Value>(work: (transaction: never) => Promise<Value>) =>
        work(executorState.tx)
    } as never;

    await replayFinancialClassification({
      database, targetClassifierVersion: 2, targetAllocationAlgorithmVersion: 3
    }, {
      payload: {
        subjectType: 'balance_transaction', subjectId: balanceTransactionId,
        sourceFingerprintSha256: 'c'.repeat(64), classifierVersion: 2,
        allocationAlgorithmVersion: 3, replayId: 'c2-a3', scanRunId: randomUUID()
      },
      correlationId: 'active-run-linked-replay', signal: new AbortController().signal
    }).catch(() => undefined);

    expect(executorState.calls.length).toBeGreaterThan(1);
  });

  it('never activates the pending target from a run-linked child job', async () => {
    const scanRunId = randomUUID();
    const executorState = executor([
      [{ classifierVersion: 1, allocationAlgorithmVersion: 1,
        pendingClassifierVersion: 2, pendingAllocationAlgorithmVersion: 3,
        pendingScanRunId: scanRunId }],
      []
    ]);
    const database = {
      transaction: async <Value>(work: (transaction: never) => Promise<Value>) =>
        work(executorState.tx)
    } as never;

    await replayFinancialClassification({
      database, targetClassifierVersion: 2, targetAllocationAlgorithmVersion: 3
    }, {
      payload: {
        subjectType: 'balance_transaction', subjectId: balanceTransactionId,
        sourceFingerprintSha256: 'c'.repeat(64), classifierVersion: 2,
        allocationAlgorithmVersion: 3, replayId: 'c2-a3', scanRunId
      } as never,
      correlationId: 'pending-child-does-not-activate',
      signal: new AbortController().signal
    }).catch(() => undefined);

    expect(rendered(executorState.calls[0]!).sql).toMatch(
      /from financial_projection_versions[\s\S]*for update/iu
    );
    expect(executorState.calls.map((query) => rendered(query).sql).join('\n'))
      .not.toContain('update financial_projection_versions');
  });

  it('takes the singleton version row as the first transaction statement and no-ops stale work', async () => {
    const executorState = executor([
      [{ classifierVersion: 3, allocationAlgorithmVersion: 4 }]
    ]);
    const database = {
      transaction: async <Value>(work: (transaction: never) => Promise<Value>) =>
        work(executorState.tx)
    } as never;
    await replayFinancialClassification({
      database, targetClassifierVersion: 2, targetAllocationAlgorithmVersion: 3
    }, {
      payload: {
        subjectType: 'balance_transaction', subjectId: balanceTransactionId,
        sourceFingerprintSha256: 'c'.repeat(64), classifierVersion: 2,
        allocationAlgorithmVersion: 3, replayId: 'c2-a3'
      },
      correlationId: 'stale-version-first', signal: new AbortController().signal
    });

    expect(executorState.calls).toHaveLength(1);
    expect(rendered(executorState.calls[0]!).sql).toMatch(
      /from financial_projection_versions[\s\S]*for update/iu
    );
  });
});

describe('replayFinancialClassificationLocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replaySeams.appendClassification.mockResolvedValue({ id: randomUUID() });
    replaySeams.observeIssue.mockResolvedValue({ id: randomUUID() });
    replaySeams.resolveIssue.mockResolvedValue(null);
    replaySeams.lockProjection.mockResolvedValue({
      payouts: [], memberships: [], feeDetailIds: [], allocationSetIds: [], issueIds: [],
      balanceTransactions: [{ id: balanceTransactionId,
        fingerprintSha256: 'c'.repeat(64) }], classifications: []
    });
  });

  it('appends the new decision and reconstructs a charge successor from locked local facts', async () => {
    const paymentId = randomUUID();
    const orderId = randomUUID();
    const itemA = randomUUID();
    const itemB = randomUUID();
    const grossTip = randomUUID();
    const feeTip = randomUUID();
    const feeDetailId = randomUUID();
    const insertedGross = randomUUID();
    const insertedFee = randomUUID();
    replaySeams.persistAllocation
      .mockResolvedValueOnce({ setId: insertedGross, disposition: 'inserted' })
      .mockResolvedValueOnce({ setId: insertedFee, disposition: 'inserted' });
    replaySeams.lockProjection.mockResolvedValueOnce({
      payouts: [], memberships: [], feeDetailIds: [feeDetailId], allocationSetIds: [],
      issueIds: [], classifications: [], balanceTransactions: [{
        id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64)
      }]
    });
    replaySeams.lockPurchase.mockResolvedValueOnce({
      payment: { id: paymentId, stripeLatestChargeId: 'ch_safe' },
      order: { id: orderId },
      refunds: [], refundDrafts: [], refundDraftItems: [], refundAllocations: [],
      refundComponents: [], correctionSets: [], correctionItems: [], disputes: [],
      disputeItemAllocations: [],
      orderItems: [
        { id: itemA, orderId, unitSubtotalMinor: 50, taxMinor: 0, currency: 'USD' },
        { id: itemB, orderId, unitSubtotalMinor: 50, taxMinor: 0, currency: 'USD' }
      ]
    });
    const database = executor([
      [{ id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
        sourceFamily: 'charge', sourceId: 'ch_safe', rawType: 'charge',
        reportingCategory: 'charge', amountMinor: 100, feeMinor: 10,
        netMinor: 90, currency: 'USD' }],
      [{ id: paymentId, paymentId, orderId }],
      [],
      [{ id: orderId, currency: 'USD', totalMinor: 100 }],
      [{ id: paymentId, orderId, stripeLatestChargeId: 'ch_safe' }],
      [],
      [{ id: feeDetailId, balanceTransactionId }],
      [{ id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
        sourceFamily: 'charge', sourceId: 'ch_safe', rawType: 'charge',
        reportingCategory: 'charge', amountMinor: 100, feeMinor: 10,
        netMinor: 90, currency: 'USD' }],
      [{ id: grossTip, basis: 'gross_amount', allocationIdentity: 'payment:v1:gross',
        supersedesSetId: null, reversalOfSetId: null,
        classifierVersion: 1, algorithmVersion: 1 },
      { id: feeTip, basis: 'fee', allocationIdentity: 'payment:v1:fee',
        supersedesSetId: null, reversalOfSetId: null,
        classifierVersion: 1, algorithmVersion: 1 }],
      [{ id: feeDetailId, rawType: 'stripe_fee', amountMinor: 10,
        currency: 'USD', fingerprintSha256: 'd'.repeat(64) }],
      [], [], []
    ]);

    await expect(replayFinancialClassificationLocked(database.tx, {
      subjectType: 'balance_transaction', subjectId: balanceTransactionId,
      sourceFingerprintSha256: 'c'.repeat(64), classifierVersion: 2,
      allocationAlgorithmVersion: 3, replayId: 'c2-a3',
      correlationId: 'replay-payment-c2-a3'
    })).resolves.toEqual({
      status: 'replayed', subjectId: balanceTransactionId,
      allocationSetIds: [insertedGross, insertedFee]
    });

    const sqlText = database.calls.map(rendered).map((query) => query.sql).join('\n');
    expect(sqlText).toContain('financial.allocation.superseded');
    expect(sqlText).not.toMatch(/update\s+financial_classification_versions/iu);
    expect(sqlText).not.toMatch(/update\s+financial_allocation_sets/iu);
    expect(replaySeams.appendClassification).toHaveBeenCalledTimes(2);
    expect(replaySeams.persistAllocation).toHaveBeenCalledTimes(2);
    expect(replaySeams.resolveIssue).toHaveBeenCalledWith(database.tx,
      expect.objectContaining({
        resourceType: 'balance_transaction', resourceId: balanceTransactionId,
        safeCode: 'classification_fork',
        proof: expect.objectContaining({ status: 'resolved', safeCode: 'classification_fork' })
      }));
    expect(replaySeams.lockPurchase).toHaveBeenCalledTimes(1);
    expect(database.calls.map(rendered).flatMap((query) => query.params))
      .toContain(`pale-orbit:commerce:order:${orderId}`);
    expect(replaySeams.lockProjection).toHaveBeenCalledWith(database.tx,
      expect.objectContaining({
        balanceTransactionIds: [balanceTransactionId], classifierVersion: 2,
        issueKeys: expect.arrayContaining([
          { resourceType: 'fee_detail', resourceId: feeDetailId,
            safeCode: 'classification_fork' },
          { resourceType: 'fee_detail', resourceId: feeDetailId,
            safeCode: 'unsupported_category' }
        ])
      }));
  });

  it('opens a bounded BT exception when the same version/fingerprint forks', async () => {
    replaySeams.appendClassification.mockRejectedValueOnce(
      new PermanentFinancialError('classification_fork')
    );
    const issueId = randomUUID();
    replaySeams.observeIssue.mockResolvedValueOnce({ id: issueId });
    const paymentId = randomUUID();
    const orderId = randomUUID();
    const itemId = randomUUID();
    replaySeams.lockPurchase.mockResolvedValueOnce({
      payment: { id: paymentId, stripeLatestChargeId: 'ch_safe' },
      order: { id: orderId },
      refunds: [], refundDrafts: [], refundDraftItems: [], refundAllocations: [],
      refundComponents: [], correctionSets: [], correctionItems: [], disputes: [],
      disputeItemAllocations: [],
      orderItems: [{ id: itemId, orderId, unitSubtotalMinor: 100, taxMinor: 0,
        currency: 'USD' }]
    });
    const database = executor([
      [{ id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
        sourceFamily: 'charge', sourceId: 'ch_safe', rawType: 'charge',
        reportingCategory: 'charge', amountMinor: 100, feeMinor: 0,
        netMinor: 100, currency: 'USD' }],
      [{ id: paymentId, paymentId, orderId }], [],
      [{ id: orderId, currency: 'USD', totalMinor: 100 }],
      [{ id: paymentId, orderId, stripeLatestChargeId: 'ch_safe' }],
      [],
      [],
      [{ id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
        sourceFamily: 'charge', sourceId: 'ch_safe', rawType: 'charge',
        reportingCategory: 'charge', amountMinor: 100, feeMinor: 0,
        netMinor: 100, currency: 'USD' }],
      [], []
    ]);
    replaySeams.lockProjection.mockResolvedValueOnce({ payouts: [], memberships: [],
      feeDetailIds: [], allocationSetIds: [], issueIds: [], classifications: [],
      balanceTransactions: [{ id: balanceTransactionId,
        fingerprintSha256: 'c'.repeat(64) }] });

    await expect(replayFinancialClassificationLocked(database.tx, {
      subjectType: 'balance_transaction', subjectId: balanceTransactionId,
      sourceFingerprintSha256: 'c'.repeat(64), classifierVersion: 2,
      allocationAlgorithmVersion: 3, replayId: 'c2-a3',
      correlationId: 'classification-fork'
    })).resolves.toEqual({ status: 'exception', subjectId: balanceTransactionId,
      safeCode: 'classification_fork', issueId });
    expect(replaySeams.observeIssue).toHaveBeenCalledWith(database.tx, {
      resourceType: 'balance_transaction', resourceId: balanceTransactionId,
      safeCode: 'classification_fork', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: 'classification-fork'
    });
  });

  it('takes the replay enrollment fence before financial rows when a dispute can rearm refunds', async () => {
    const disputeId = randomUUID();
    const refundId = randomUUID();
    const refundAllocationId = randomUUID();
    const paymentId = randomUUID();
    const orderId = randomUUID();
    const itemId = randomUUID();
    const marker = new Error('stop-at-financial-lock');
    const sourceBalance = {
      id: balanceTransactionId,
      fingerprintSha256: 'c'.repeat(64),
      sourceFamily: 'dispute' as const,
      sourceId: 'dp_safe',
      rawType: 'adjustment',
      reportingCategory: 'dispute',
      amountMinor: -100,
      feeMinor: 0,
      netMinor: -100,
      currency: 'USD'
    };
    replaySeams.lockPurchase.mockResolvedValueOnce({
      payment: { id: paymentId, orderId },
      order: { id: orderId },
      refunds: [{ id: refundId, status: 'succeeded' }],
      refundDrafts: [],
      refundDraftItems: [],
      refundAllocations: [{ id: refundAllocationId, refundId, orderItemId: itemId,
        amountMinor: 100 }],
      refundComponents: [{ refundAllocationId, refundId, orderItemId: itemId,
        subtotalMinor: 100, taxMinor: 0, totalMinor: 100, currency: 'USD' }],
      correctionSets: [],
      correctionItems: [],
      disputes: [{ id: disputeId, stripeDisputeId: 'dp_safe' }],
      disputeItemAllocations: [],
      orderItems: [{ id: itemId, orderId, unitSubtotalMinor: 100, taxMinor: 0,
        currency: 'USD' }]
    });
    replaySeams.lockProjection.mockRejectedValueOnce(marker);
    const database = executor([
      [sourceBalance],
      [{ id: disputeId, paymentId, orderId }],
      [],
      [{ id: orderId }],
      [{ id: paymentId, orderId }],
      [],
      [sourceBalance],
      [],
      []
    ]);

    await expect(replayFinancialClassificationLocked(database.tx, {
      subjectType: 'balance_transaction',
      subjectId: balanceTransactionId,
      sourceFingerprintSha256: 'c'.repeat(64),
      classifierVersion: 2,
      allocationAlgorithmVersion: 3,
      replayId: 'c2-a3',
      correlationId: 'replay-dispute-enrollment-order'
    })).rejects.toBe(marker);

    const statements = database.calls.map(rendered);
    const enrollmentIndex = statements.findIndex((query) =>
      query.params.includes('pale-orbit:financial:replay-enrollment'));
    const sourceBalanceIndex = statements.findIndex((query) =>
      query.sql.includes('where balance.source_family ='));
    expect(enrollmentIndex).toBeGreaterThan(0);
    expect(enrollmentIndex).toBeLessThan(sourceBalanceIndex);
  });

  it('rebuilds a refund chronology through the locked provider-free helper', async () => {
    const paymentId = randomUUID();
    const orderId = randomUUID();
    const refundId = randomUUID();
    const itemId = randomUUID();
    const refundAllocationId = randomUUID();
    const grossSetId = randomUUID();
    const feeSetId = randomUUID();
    const sourceBalance = {
      id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
      sourceFamily: 'refund' as const, sourceId: 're_safe', rawType: 'refund',
      reportingCategory: 'refund', amountMinor: -100, feeMinor: 0,
      netMinor: -100, currency: 'USD'
    };
    const orderItem = { id: itemId, orderId, unitSubtotalMinor: 100,
      taxMinor: 0, totalMinor: 100, currency: 'USD' };
    const refund = { id: refundId, paymentId, stripeRefundId: 're_safe',
      status: 'succeeded', allocationStatus: 'finalized', amountMinor: 100,
      currency: 'USD' };
    replaySeams.lockPurchase.mockResolvedValueOnce({
      payment: { id: paymentId, orderId }, order: { id: orderId }, refunds: [refund],
      refundDrafts: [], refundDraftItems: [],
      refundAllocations: [{ id: refundAllocationId, refundId, orderItemId: itemId,
        amountMinor: 100 }],
      refundComponents: [{ refundAllocationId, refundId, orderItemId: itemId,
        subtotalMinor: 100, taxMinor: 0, totalMinor: 100, currency: 'USD' }],
      correctionSets: [], correctionItems: [], disputes: [], disputeItemAllocations: [],
      orderItems: [orderItem]
    });
    replaySeams.lockProjection.mockResolvedValueOnce({ payouts: [], memberships: [],
      feeDetailIds: [], allocationSetIds: [], issueIds: [], classifications: [],
      balanceTransactions: [{ id: balanceTransactionId,
        fingerprintSha256: 'c'.repeat(64) }] });
    replaySeams.replayRefund.mockResolvedValueOnce({
      status: 'replayed', refundId, replacements: [
        { balanceTransactionId, basis: 'gross_amount', previousSetId: null,
          replacementSetId: grossSetId, sourceFingerprint: 'c'.repeat(64),
          disposition: 'inserted' },
        { balanceTransactionId, basis: 'fee', previousSetId: null,
          replacementSetId: feeSetId, sourceFingerprint: 'c'.repeat(64),
          disposition: 'inserted' }
      ]
    });
    const database = executor([
      [sourceBalance],
      [{ id: refundId, paymentId, orderId }],
      [],
      [{ id: orderId }],
      [{ id: paymentId, orderId }],
      [sourceBalance],
      [],
      [],
      [sourceBalance],
      [],
      [],
      [], []
    ]);

    await expect(replayFinancialClassificationLocked(database.tx, {
      subjectType: 'balance_transaction', subjectId: balanceTransactionId,
      sourceFingerprintSha256: 'c'.repeat(64), classifierVersion: 2,
      allocationAlgorithmVersion: 3, replayId: 'c2-a3',
      correlationId: 'replay-refund-c2-a3'
    })).resolves.toEqual({ status: 'replayed', subjectId: balanceTransactionId,
      allocationSetIds: [grossSetId, feeSetId] });

    expect(replaySeams.replayRefund).toHaveBeenCalledWith(database.tx,
      expect.objectContaining({ refundId, paymentId, orderId,
        balanceTransactionIds: [balanceTransactionId] }),
      { classifierVersion: 2, allocationAlgorithmVersion: 3, replayId: 'c2-a3' });
    expect(replaySeams.persistAllocation).not.toHaveBeenCalled();
  });

  it('keeps an already-rebased current correction compatible on repeated refund replay', async () => {
    const paymentId = randomUUID();
    const orderId = randomUUID();
    const refundId = randomUUID();
    const itemId = randomUUID();
    const refundAllocationId = randomUUID();
    const oldGrossSetId = randomUUID();
    const currentGrossSetId = randomUUID();
    const oldFeeSetId = randomUUID();
    const currentFeeSetId = randomUUID();
    const predecessorCorrectionId = randomUUID();
    const currentCorrectionId = randomUUID();
    const sourceBalance = {
      id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
      sourceFamily: 'refund' as const, sourceId: 're_safe', rawType: 'refund',
      reportingCategory: 'refund', amountMinor: -100, feeMinor: 0,
      netMinor: -100, currency: 'USD'
    };
    const orderItem = { id: itemId, orderId, unitSubtotalMinor: 100,
      taxMinor: 0, totalMinor: 100, currency: 'USD' };
    const refund = { id: refundId, paymentId, stripeRefundId: 're_safe',
      status: 'succeeded', allocationStatus: 'finalized', amountMinor: 100,
      currency: 'USD' };
    replaySeams.lockPurchase.mockResolvedValueOnce({
      payment: { id: paymentId, orderId }, order: { id: orderId }, refunds: [refund],
      refundDrafts: [], refundDraftItems: [],
      refundAllocations: [{ id: refundAllocationId, refundId, orderItemId: itemId,
        amountMinor: 100 }],
      refundComponents: [{ refundAllocationId, refundId, orderItemId: itemId,
        subtotalMinor: 100, taxMinor: 0, totalMinor: 100, currency: 'USD' }],
      correctionSets: [
        { id: predecessorCorrectionId, refundId,
          kind: 'allocation_attribution_correction', baseAllocationSetId: oldGrossSetId,
          predecessorCorrectionSetId: null },
        { id: currentCorrectionId, refundId, kind: 'classifier_rebase',
          baseAllocationSetId: currentGrossSetId,
          sourceFingerprintSha256: 'c'.repeat(64),
          predecessorCorrectionSetId: predecessorCorrectionId }
      ],
      correctionItems: [
        { correctionSetId: currentCorrectionId, sourceAllocationSetId: currentGrossSetId },
        { correctionSetId: currentCorrectionId, sourceAllocationSetId: currentFeeSetId }
      ],
      disputes: [], disputeItemAllocations: [], orderItems: [orderItem]
    });
    replaySeams.lockProjection.mockResolvedValueOnce({ payouts: [], memberships: [],
      feeDetailIds: [], allocationSetIds: [], issueIds: [], classifications: [],
      balanceTransactions: [{ id: balanceTransactionId,
        fingerprintSha256: 'c'.repeat(64) }] });
    replaySeams.replayRefund.mockResolvedValueOnce({
      status: 'unchanged', refundId, replacements: [
        { balanceTransactionId, basis: 'gross_amount', previousSetId: oldGrossSetId,
          replacementSetId: currentGrossSetId, sourceFingerprint: 'c'.repeat(64),
          disposition: 'unchanged' },
        { balanceTransactionId, basis: 'fee', previousSetId: oldFeeSetId,
          replacementSetId: currentFeeSetId, sourceFingerprint: 'c'.repeat(64),
          disposition: 'unchanged' }
      ]
    });
    const database = executor([
      [sourceBalance],
      [{ id: refundId, paymentId, orderId }],
      [],
      [{ id: orderId }],
      [{ id: paymentId, orderId }],
      [sourceBalance],
      [],
      [],
      [sourceBalance],
      [],
      [],
      [], []
    ]);

    await expect(replayFinancialClassificationLocked(database.tx, {
      subjectType: 'balance_transaction', subjectId: balanceTransactionId,
      sourceFingerprintSha256: 'c'.repeat(64), classifierVersion: 2,
      allocationAlgorithmVersion: 3, replayId: 'c2-a3',
      correlationId: 'repeat-replay-current-correction'
    })).resolves.toEqual({ status: 'unchanged', subjectId: balanceTransactionId });

    expect(replaySeams.observeIssue).not.toHaveBeenCalled();
    expect(database.calls.map(rendered).map((query) => query.sql).join('\n'))
      .not.toContain('financial.correction.rebase_failed');
  });

  it('replays durable account evidence with a provider source reference into explicit account plans', async () => {
    const insertedGross = randomUUID();
    const insertedFee = randomUUID();
    replaySeams.persistAllocation
      .mockResolvedValueOnce({ setId: insertedGross, disposition: 'inserted' })
      .mockResolvedValueOnce({ setId: insertedFee, disposition: 'inserted' });
    const database = executor([
      [{ id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
        sourceFamily: 'unknown', sourceId: 'src_safe', rawType: 'adjustment',
        reportingCategory: 'other_adjustment', amountMinor: 25, feeMinor: 0,
        netMinor: 25, currency: 'USD' }],
      [],
      [],
      [{ id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
        sourceFamily: 'unknown', sourceId: 'src_safe', rawType: 'adjustment',
        reportingCategory: 'other_adjustment', amountMinor: 25, feeMinor: 0,
        netMinor: 25, currency: 'USD' }],
      [], [],
      [], []
    ]);

    await expect(replayFinancialClassificationLocked(database.tx, {
      subjectType: 'balance_transaction', subjectId: balanceTransactionId,
      sourceFingerprintSha256: 'c'.repeat(64), classifierVersion: 2,
      allocationAlgorithmVersion: 3, replayId: 'c2-a3',
      correlationId: 'replay-adjustment-c2-a3'
    })).resolves.toEqual({ status: 'replayed', subjectId: balanceTransactionId,
      allocationSetIds: [insertedGross, insertedFee] });

    expect(replaySeams.persistAllocation).toHaveBeenCalledTimes(2);
    for (const call of replaySeams.persistAllocation.mock.calls) {
      expect(call[1]).toMatchObject({ sourceKind: 'adjustment',
        sourceId: balanceTransactionId,
        plan: { scope: 'account', items: [] } });
    }
    expect(replaySeams.persistAllocation.mock.calls[0]?.[1].plan)
      .toMatchObject({ basis: 'gross_amount', expectedEffectMinor: 25 });
    expect(replaySeams.persistAllocation.mock.calls[1]?.[1].plan)
      .toMatchObject({ basis: 'fee', expectedEffectMinor: 0 });
  });

  it('records unsupported durable evidence instead of escaping as a permanent handler failure', async () => {
    const issueId = randomUUID();
    replaySeams.observeIssue.mockResolvedValueOnce({ id: issueId });
    const database = executor([
      [{ id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
        sourceFamily: 'unknown', sourceId: null, rawType: 'mystery',
        reportingCategory: 'mystery', amountMinor: 25, feeMinor: 0,
        netMinor: 25, currency: 'USD' }],
      [],
      [],
      [{ id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
        sourceFamily: 'unknown', sourceId: null, rawType: 'mystery',
        reportingCategory: 'mystery', amountMinor: 25, feeMinor: 0,
        netMinor: 25, currency: 'USD' }],
      [], []
    ]);

    await expect(replayFinancialClassificationLocked(database.tx, {
      subjectType: 'balance_transaction', subjectId: balanceTransactionId,
      sourceFingerprintSha256: 'c'.repeat(64), classifierVersion: 2,
      allocationAlgorithmVersion: 3, replayId: 'c2-a3',
      correlationId: 'unsupported-durable-evidence'
    })).resolves.toEqual({ status: 'unchanged', subjectId: balanceTransactionId });
    expect(replaySeams.observeIssue).toHaveBeenCalledWith(database.tx, {
      resourceType: 'balance_transaction', resourceId: balanceTransactionId,
      safeCode: 'unsupported_category', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: 'unsupported-durable-evidence'
    });
    expect(replaySeams.persistAllocation).not.toHaveBeenCalled();
  });

  it('locks a payout subject with its complete durable membership closure before replay', async () => {
    const payoutId = randomUUID();
    const memberId = randomUUID();
    const insertedGross = randomUUID();
    const insertedFee = randomUUID();
    replaySeams.persistAllocation
      .mockResolvedValueOnce({ setId: insertedGross, disposition: 'inserted' })
      .mockResolvedValueOnce({ setId: insertedFee, disposition: 'inserted' });
    replaySeams.lockProjection.mockResolvedValueOnce({ payouts: [{ id: payoutId,
      financialGeneration: 4 }], memberships: [
      { payoutId, balanceTransactionId }, { payoutId, balanceTransactionId: memberId }
    ], feeDetailIds: [], allocationSetIds: [], issueIds: [], classifications: [],
    balanceTransactions: [
      { id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64) },
      { id: memberId, fingerprintSha256: 'e'.repeat(64) }
    ] });
    const database = executor([
      [{ id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
        sourceFamily: 'payout', sourceId: 'po_safe', rawType: 'payout',
        reportingCategory: 'payout', amountMinor: -100, feeMinor: 0,
        netMinor: -100, currency: 'USD' }],
      [{ id: payoutId, payoutGeneration: 4 }],
      [{ payoutId, expectedGeneration: 4, balanceTransactionId },
      { payoutId, expectedGeneration: 4, balanceTransactionId: memberId }],
      [{ balanceTransactionId }, { balanceTransactionId: memberId }],
      [],
      [{ id: balanceTransactionId, fingerprintSha256: 'c'.repeat(64),
        sourceFamily: 'payout', sourceId: 'po_safe', rawType: 'payout',
        reportingCategory: 'payout', amountMinor: -100, feeMinor: 0,
        netMinor: -100, currency: 'USD' }],
      [], [],
      [], []
    ]);

    await expect(replayFinancialClassificationLocked(database.tx, {
      subjectType: 'balance_transaction', subjectId: balanceTransactionId,
      sourceFingerprintSha256: 'c'.repeat(64), classifierVersion: 2,
      allocationAlgorithmVersion: 3, replayId: 'c2-a3',
      correlationId: 'replay-payout-c2-a3'
    })).resolves.toEqual({ status: 'replayed', subjectId: balanceTransactionId,
      allocationSetIds: [insertedGross, insertedFee] });

    expect(replaySeams.lockProjection).toHaveBeenCalledWith(database.tx, expect.objectContaining({
      payoutGenerations: [{ payoutId, expectedGeneration: 4 }],
      balanceTransactionIds: [balanceTransactionId, memberId].sort()
    }));
    expect(replaySeams.persistAllocation.mock.calls[0]?.[1]).toMatchObject({
      sourceKind: 'payout', sourceId: payoutId,
      plan: { scope: 'account', basis: 'gross_amount', expectedEffectMinor: -100 }
    });
  });
});
