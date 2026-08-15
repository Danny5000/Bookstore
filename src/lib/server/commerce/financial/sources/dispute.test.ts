import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { appendAuditEvent } from '$lib/server/audit/service';
import { lockOrder } from '$lib/server/commerce/lock';
import { lockPaymentPurchaseFacts } from '$lib/server/commerce/reconciliation';
import { lockCanonicalPaymentPurchaseFacts } from './payment';
import { buildDisputeAllocationPlan } from '../allocations/dispute';
import {
  loadCurrentEffectiveAllocationProjection,
  persistFinancialAllocationPlanLocked,
  persistFinancialAllocationReplayPlanLocked
} from '../allocations/repository';
import { observeFinancialIssue, resolveFinancialIssueAfterRecompute } from '../issues';
import {
  lockActiveFinancialProjectionImplementation,
  lockFinancialProjectionRows,
  type FinancialProjectionLockRows
} from '../locks';
import {
  rearmCurrentProjectionSubjectsForFinancialSources,
  stageBalanceTransaction
} from '../ledger';
import { lockFinancialProjectionEnrollment } from '../rebase';
import { PermanentFinancialError } from '../errors';
import {
  recomputeLockedDisputeFinancialProjectionForVersion,
  reconcileDisputeFinancialSource
} from './dispute';

vi.mock('../ledger', () => ({
  rearmCurrentProjectionSubjectsForFinancialSources: vi.fn(),
  stageBalanceTransaction: vi.fn()
}));
vi.mock('../rebase', () => ({ lockFinancialProjectionEnrollment: vi.fn() }));
vi.mock('./payment', () => ({ lockCanonicalPaymentPurchaseFacts: vi.fn() }));
vi.mock('$lib/server/commerce/lock', () => ({ lockOrder: vi.fn() }));
vi.mock('$lib/server/commerce/reconciliation', () => ({ lockPaymentPurchaseFacts: vi.fn() }));
vi.mock('../allocations/dispute', () => ({ buildDisputeAllocationPlan: vi.fn() }));
vi.mock('../allocations/repository', () => ({
  loadCurrentEffectiveAllocationProjection: vi.fn(),
  persistFinancialAllocationPlanLocked: vi.fn(),
  persistFinancialAllocationReplayPlanLocked: vi.fn()
}));
vi.mock('../issues', () => ({
  observeFinancialIssue: vi.fn(),
  resolveFinancialIssueAfterRecompute: vi.fn()
}));
vi.mock('../locks', () => ({
  lockActiveFinancialProjectionImplementation: vi.fn(),
  lockFinancialProjectionRows: vi.fn()
}));
vi.mock('$lib/server/audit/service', () => ({ appendAuditEvent: vi.fn() }));

const disputeId = '00000000-0000-4000-8000-000000000301';
const siblingDisputeId = '00000000-0000-4000-8000-000000000305';
const paymentId = '00000000-0000-4000-8000-000000000302';
const orderId = '00000000-0000-4000-8000-000000000303';
const balanceId = '00000000-0000-4000-8000-000000000304';
const siblingBalanceId = '00000000-0000-4000-8000-000000000306';
const orderItemId = '00000000-0000-4000-8000-000000000307';
const payoutId = '00000000-0000-4000-8000-000000000308';
const allocationId = '00000000-0000-4000-8000-000000000309';
const grossSetId = '00000000-0000-4000-8000-000000000310';
const feeSetId = '00000000-0000-4000-8000-000000000311';
const issueId = '00000000-0000-4000-8000-000000000312';
const refundId = '00000000-0000-4000-8000-000000000313';
const createdAt = new Date('2026-08-10T00:00:00.000Z');

function render(query: unknown): { sql: string; params: unknown[] } {
  if (
    typeof query === 'string' ||
    !query ||
    typeof query !== 'object' ||
    typeof (query as Partial<SQLWrapper>).getSQL !== 'function'
  ) {
    throw new Error('Expected a Drizzle SQL query');
  }
  return (query as SQLWrapper).getSQL().toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
}

function mockedDatabaseExecute(database: Database): ReturnType<typeof vi.fn> {
  return database.execute as unknown as ReturnType<typeof vi.fn>;
}

function projectionLockRows(
  overrides: Partial<FinancialProjectionLockRows> = {}
): FinancialProjectionLockRows {
  return {
    payouts: [],
    balanceTransactions: [],
    memberships: [],
    classifications: [],
    feeDetailIds: [],
    allocationSetIds: [],
    issueIds: [],
    ...overrides
  };
}

function classificationRow(
  subjectId: string,
  classification: string,
  sourceFingerprintSha256: string
): FinancialProjectionLockRows['classifications'][number] {
  return {
    id: allocationId,
    subjectType: 'balance_transaction',
    subjectId,
    classifierVersion: 1,
    sourceFingerprintSha256,
    classification
  };
}

function updateChain(): Pick<DatabaseTransaction, 'update'> {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) }))
    }))
  } as unknown as Pick<DatabaseTransaction, 'update'>;
}

function lockedFacts(
  options: {
    financialEvidenceStatus?: 'pending' | 'fee_reconciled' | 'exception';
    disputeItemAllocations?: readonly Record<string, unknown>[];
  } = {}
) {
  return {
    payment: { id: paymentId },
    order: { id: orderId },
    refunds: [],
    refundDrafts: [],
    refundDraftItems: [],
    refundAllocations: [],
    refundComponents: [],
    correctionSets: [],
    correctionItems: [],
    disputes: [
      {
        id: disputeId,
        paymentId,
        stripeDisputeId: 'dp_dispute_trace',
        status: 'won',
        amountMinor: 100,
        currency: 'USD',
        reason: null,
        providerCreatedAt: createdAt,
        providerUpdatedAt: createdAt,
        financialEvidenceStatus: options.financialEvidenceStatus ?? 'pending'
      }
    ],
    disputeItemAllocations: options.disputeItemAllocations ?? [],
    orderItems: [
      {
        id: orderItemId,
        orderId,
        unitSubtotalMinor: 90,
        taxMinor: 10,
        totalMinor: 100,
        currency: 'USD'
      }
    ]
  };
}

function oneTransactionGateway(trace: string[] = []): StripeCommerceGateway {
  const value = gateway(trace);
  vi.mocked(value.retrieveDispute).mockResolvedValue({
    providerDisputeId: 'dp_dispute_trace',
    paymentIntentId: 'pi_dispute_trace',
    chargeId: 'ch_dispute_trace',
    liveMode: false,
    state: 'won',
    amountMinor: 100,
    currency: 'usd',
    reason: null,
    providerCreatedAt: createdAt,
    balanceTransactionIds: ['txn_withdrawal_trace']
  });
  return value;
}

function routingDatabase(trace: string[]): Database {
  const limit = vi.fn().mockResolvedValue([
    {
      id: disputeId,
      stripeDisputeId: 'dp_dispute_trace',
      paymentId,
      orderId,
      stripePaymentIntentId: 'pi_dispute_trace'
    }
  ]);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ innerJoin, where }));
  const from = vi.fn(() => ({ innerJoin, where }));
  return {
    select: vi.fn(() => ({ from })),
    execute: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(async () => {
      trace.push('tx.begin');
      throw new Error('projection-stop');
    })
  } as unknown as Database;
}

function prepareDisputeIssueTransaction(database: Database): DatabaseTransaction {
  const forUpdate = vi
    .fn()
    .mockResolvedValueOnce([{ id: orderId }])
    .mockResolvedValueOnce([
      {
        id: paymentId,
        orderId,
        stripePaymentIntentId: 'pi_dispute_trace'
      }
    ]);
  const limit = vi.fn(() => ({ for: forUpdate }));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const tx = {
    select: vi.fn(() => ({ from })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) }))
    }))
  } as unknown as DatabaseTransaction;
  vi.mocked(database.transaction).mockImplementation(async (work) => work(tx));
  vi.mocked(lockPaymentPurchaseFacts).mockResolvedValue(lockedFacts() as never);
  vi.mocked(observeFinancialIssue).mockResolvedValue({ id: issueId } as never);
  return tx;
}

function gateway(trace: string[]): StripeCommerceGateway {
  const later = new Date(createdAt.getTime() + 1000);
  return {
    retrieveDispute: vi.fn(async () => {
      trace.push('provider.dispute');
      return {
        providerDisputeId: 'dp_dispute_trace',
        paymentIntentId: 'pi_dispute_trace',
        chargeId: 'ch_dispute_trace',
        liveMode: false,
        state: 'won',
        amountMinor: 100,
        currency: 'usd',
        reason: null,
        providerCreatedAt: createdAt,
        balanceTransactionIds: ['txn_reinstatement_trace', 'txn_withdrawal_trace']
      };
    }),
    retrievePayment: vi.fn(async () => {
      trace.push('provider.payment');
      return {
        paymentIntentId: 'pi_dispute_trace',
        metadataVersion: '1',
        metadataOrderId: orderId,
        latestChargeId: 'ch_dispute_trace',
        liveMode: false,
        state: 'succeeded',
        amountMinor: 1000,
        currency: 'usd',
        paidAt: createdAt,
        paymentMethodCategory: 'card'
      };
    }),
    retrieveCharge: vi.fn(async () => {
      trace.push('provider.charge');
      return {
        id: 'ch_dispute_trace',
        paymentIntentId: 'pi_dispute_trace',
        livemode: false,
        amountMinor: 1000,
        amountRefundedMinor: 0,
        currency: 'USD',
        status: 'succeeded',
        balanceTransactionId: 'txn_charge_trace',
        createdAt
      };
    }),
    retrieveBalanceTransaction: vi.fn(async (id) => {
      trace.push(`provider.balance.${id}`);
      const reinstatement = id === 'txn_reinstatement_trace';
      return {
        id,
        livemode: false,
        sourceId: 'dp_dispute_trace',
        sourceFamily: 'dispute',
        rawType: 'adjustment',
        reportingCategory: reinstatement ? 'dispute_reversal' : 'dispute',
        amountMinor: reinstatement ? 100 : -100,
        feeMinor: 0,
        netMinor: reinstatement ? 100 : -100,
        currency: 'USD',
        status: 'available',
        balanceType: 'payments',
        createdAt: reinstatement ? later : createdAt,
        availableAt: later,
        exchangeRate: null,
        exchangeSourceCurrency: null,
        exchangeTargetCurrency: null,
        feeDetails: []
      };
    })
  } as unknown as StripeCommerceGateway;
}

describe('versioned locked dispute projection replay', () => {
  beforeEach(() => vi.resetAllMocks());

  it('reports when an identical withdrawal first joins the target replay pair', async () => {
    const fingerprint = 'a'.repeat(64);
    const oldGross = '00000000-0000-4000-8000-000000000319';
    const insertedGross = '00000000-0000-4000-8000-000000000320';
    const insertedFee = '00000000-0000-4000-8000-000000000321';
    const plans = [
      { allocationIdentity: `dispute:${disputeId}:${balanceId}:replay:c2-a3:gross`,
        balanceTransactionId: balanceId, basis: 'gross_amount', scope: 'title',
        currency: 'USD', expectedEffectMinor: -100, algorithmVersion: 3,
        sourceFingerprint: fingerprint, supersedesSetId: null, reversalOfSetId: null,
        items: [] },
      { allocationIdentity: `dispute:${disputeId}:${balanceId}:replay:c2-a3:fee`,
        balanceTransactionId: balanceId, basis: 'fee', scope: 'title', currency: 'USD',
        expectedEffectMinor: 0, algorithmVersion: 3, sourceFingerprint: fingerprint,
        supersedesSetId: null, reversalOfSetId: null, items: [] }
    ] as never;
    vi.mocked(buildDisputeAllocationPlan).mockReturnValue({ plans,
      presentmentEffects: [{
        allocationId: `dispute:${disputeId}:${balanceId}:presentment:${orderItemId}`,
        withdrawalSetId: null,
        disputeId,
        providerCreatedAt: createdAt.toISOString(),
        providerTransactionId: 'txn_dispute',
        orderItemId,
        subtotalMinor: -90,
        taxMinor: -10,
        presentmentCurrency: 'USD',
        effect: 'withdrawal',
        reversalOfAllocationId: null
      }] } as never);
    vi.mocked(persistFinancialAllocationReplayPlanLocked)
      .mockResolvedValueOnce({ setId: insertedGross, disposition: 'inserted' })
      .mockResolvedValueOnce({ setId: insertedFee, disposition: 'inserted' });
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: balanceId, providerId: 'txn_dispute',
        sourceId: 'dp_dispute_trace', amountMinor: -100, feeMinor: 0,
        netMinor: -100, currency: 'USD', fingerprintSha256: fingerprint,
        providerCreatedAt: createdAt, classification: 'dispute_withdrawal' }] })
      .mockResolvedValueOnce({ rows: [{ id: oldGross, balanceTransactionId: balanceId,
        basis: 'gross_amount', allocationIdentity: 'dispute:old-v1:gross',
        supersedesSetId: null, classifierVersion: 1, algorithmVersion: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: oldGross, balanceTransactionId: balanceId,
        allocationIdentity: 'dispute:old-v1:gross', expectedEffectMinor: -100,
        currency: 'USD', algorithmVersion: 1, sourceFingerprint: fingerprint,
        supersedesSetId: null, reversalOfSetId: null, scope: 'title' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: allocationId }] });
    const tx = { execute, transaction: vi.fn() } as unknown as DatabaseTransaction;
    vi.mocked(tx.transaction).mockImplementation(async (work) => work(tx));
    const facts = {
      ...lockedFacts({
        disputeItemAllocations: [{
          id: allocationId,
          disputeId,
          grossAllocationSetId: oldGross,
          orderItemId,
          effect: 'withdrawal',
          reversesAllocationId: null,
          subtotalEffectMinor: -90,
          taxEffectMinor: -10,
          totalEffectMinor: -100,
          currency: 'USD'
        }]
      }),
      payment: { id: paymentId, orderId },
      refunds: [{
        id: refundId,
        status: 'succeeded',
        stripeRefundId: 're_after_dispute',
        providerCreatedAt: new Date(createdAt.getTime() + 1000)
      }],
      refundComponents: [{
        refundId,
        refundAllocationId: '00000000-0000-4000-8000-000000000314',
        orderItemId,
        subtotalMinor: 9,
        taxMinor: 1,
        currency: 'USD'
      }]
    } as never;
    const projectionLocks = projectionLockRows({
      balanceTransactions: [{ id: balanceId, fingerprintSha256: fingerprint }]
    });

    await expect(recomputeLockedDisputeFinancialProjectionForVersion(tx, {
      orderId, paymentId, balanceTransactionIds: [balanceId], purchaseFacts: facts,
      projectionLocks, correlationId: 'dispute-replay-c2-a3'
    }, { classifierVersion: 2, allocationAlgorithmVersion: 3, replayId: 'c2-a3' }))
      .resolves.toEqual({ status: 'replayed', replacements: [
        expect.objectContaining({ balanceTransactionId: balanceId, disputeId,
          basis: 'gross_amount', previousSetId: null,
          replacementSetId: insertedGross, disposition: 'inserted' }),
        expect.objectContaining({ balanceTransactionId: balanceId, disputeId,
          basis: 'fee', previousSetId: null,
          replacementSetId: insertedFee, disposition: 'inserted' })
      ] });

    expect(buildDisputeAllocationPlan).toHaveBeenCalledWith(expect.objectContaining({
      algorithmVersion: 3, effect: 'withdrawal', sourceFingerprint: fingerprint
    }));
    expect(persistFinancialAllocationReplayPlanLocked).toHaveBeenCalledTimes(2);
    expect(rearmCurrentProjectionSubjectsForFinancialSources).not.toHaveBeenCalled();
    expect(render(execute.mock.calls[0]?.[0]).sql).toMatch(
      /order by balance\.provider_created_at, balance\.provider_id collate "C", balance\.id/iu
    );
    expect(render(execute.mock.calls[1]?.[0]).sql).toMatch(
      /allocation\.classifier_version\s*=\s*\$\d+[\s\S]*allocation\.algorithm_version\s*=\s*\$\d+[\s\S]*successor\.classifier_version\s*=\s*allocation\.classifier_version[\s\S]*successor\.algorithm_version\s*=\s*allocation\.algorithm_version/iu
    );
    expect(render(execute.mock.calls[1]?.[0]).params).toEqual(expect.arrayContaining([2, 3]));
    expect(tx.transaction).toHaveBeenCalledOnce();
    for (const [, persistInput, version] of
      vi.mocked(persistFinancialAllocationReplayPlanLocked).mock.calls) {
      expect(persistInput.classificationVersion).toBe(2);
      expect(version).toEqual({ classifierVersion: 2, allocationAlgorithmVersion: 3 });
    }
  });

  it('rolls back an unchanged target plan whose stored presentment membership diverges', async () => {
    const fingerprint = 'a'.repeat(64);
    const grossIdentity = `dispute:${disputeId}:${balanceId}:replay:c2-a3:gross`;
    const feeIdentity = `dispute:${disputeId}:${balanceId}:replay:c2-a3:fee`;
    const plans = [
      { allocationIdentity: grossIdentity, balanceTransactionId: balanceId,
        basis: 'gross_amount', scope: 'title', currency: 'USD', expectedEffectMinor: -100,
        algorithmVersion: 3, sourceFingerprint: fingerprint, supersedesSetId: null,
        reversalOfSetId: null, items: [] },
      { allocationIdentity: feeIdentity, balanceTransactionId: balanceId,
        basis: 'fee', scope: 'title', currency: 'USD', expectedEffectMinor: 0,
        algorithmVersion: 3, sourceFingerprint: fingerprint, supersedesSetId: null,
        reversalOfSetId: null, items: [] }
    ] as never;
    vi.mocked(buildDisputeAllocationPlan).mockReturnValue({ plans,
      presentmentEffects: [{
        allocationId: `dispute:${disputeId}:${balanceId}:presentment:${orderItemId}`,
        withdrawalSetId: null, disputeId, providerCreatedAt: createdAt.toISOString(),
        providerTransactionId: 'txn_dispute', orderItemId,
        subtotalMinor: -90, taxMinor: -10, presentmentCurrency: 'USD',
        effect: 'withdrawal', reversalOfAllocationId: null
      }] } as never);
    vi.mocked(persistFinancialAllocationReplayPlanLocked)
      .mockResolvedValueOnce({ setId: grossSetId, disposition: 'unchanged' })
      .mockResolvedValueOnce({ setId: feeSetId, disposition: 'unchanged' });
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: balanceId, providerId: 'txn_dispute',
        sourceId: 'dp_dispute_trace', amountMinor: -100, feeMinor: 0,
        netMinor: -100, currency: 'USD', fingerprintSha256: fingerprint,
        providerCreatedAt: createdAt, classification: 'dispute_withdrawal' }] })
      .mockResolvedValueOnce({ rows: [
        { id: grossSetId, balanceTransactionId: balanceId, basis: 'gross_amount',
          allocationIdentity: grossIdentity, supersedesSetId: null,
          classifierVersion: 2, algorithmVersion: 3, isTargetTip: true,
          isGlobalTip: true },
        { id: feeSetId, balanceTransactionId: balanceId, basis: 'fee',
          allocationIdentity: feeIdentity, supersedesSetId: null,
          classifierVersion: 2, algorithmVersion: 3, isTargetTip: true,
          isGlobalTip: true }
      ] })
      .mockResolvedValueOnce({ rows: [{ id: grossSetId,
        balanceTransactionId: balanceId, allocationIdentity: grossIdentity,
        expectedEffectMinor: -100, currency: 'USD', algorithmVersion: 3,
        sourceFingerprint: fingerprint, supersedesSetId: null,
        reversalOfSetId: null, scope: 'title' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: feeSetId,
        balanceTransactionId: balanceId, allocationIdentity: feeIdentity,
        expectedEffectMinor: 0, currency: 'USD', algorithmVersion: 3,
        sourceFingerprint: fingerprint, supersedesSetId: null,
        reversalOfSetId: null, scope: 'title' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    let rolledBack = false;
    const tx = { execute, transaction: vi.fn() } as unknown as DatabaseTransaction;
    vi.mocked(tx.transaction).mockImplementation(async (work) => {
      try {
        return await work(tx);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    const facts = { ...lockedFacts(), payment: { id: paymentId, orderId } } as never;
    const projectionLocks = projectionLockRows({
      balanceTransactions: [{ id: balanceId, fingerprintSha256: fingerprint }]
    });

    await expect(recomputeLockedDisputeFinancialProjectionForVersion(tx, {
      orderId, paymentId, balanceTransactionIds: [balanceId], purchaseFacts: facts,
      projectionLocks, correlationId: 'dispute-unchanged-presentment-mismatch'
    }, { classifierVersion: 2, allocationAlgorithmVersion: 3, replayId: 'c2-a3' }))
      .resolves.toEqual({ status: 'exception', safeCode: 'allocation_mismatch' });

    expect(rolledBack).toBe(true);
    expect(persistFinancialAllocationReplayPlanLocked).toHaveBeenCalledTimes(2);
    expect(rearmCurrentProjectionSubjectsForFinancialSources).not.toHaveBeenCalled();
  });

  it('rolls back earlier sibling writes when a later replay subject fails safely', async () => {
    const laterBalanceId = '00000000-0000-4000-8000-000000000322';
    const fingerprint = 'a'.repeat(64);
    const plans = [
      { allocationIdentity: `dispute:${disputeId}:${balanceId}:replay:c2-a3:gross`,
        balanceTransactionId: balanceId, basis: 'gross_amount', scope: 'title',
        currency: 'USD', expectedEffectMinor: -100, algorithmVersion: 3,
        sourceFingerprint: fingerprint, supersedesSetId: null, reversalOfSetId: null,
        items: [] },
      { allocationIdentity: `dispute:${disputeId}:${balanceId}:replay:c2-a3:fee`,
        balanceTransactionId: balanceId, basis: 'fee', scope: 'title', currency: 'USD',
        expectedEffectMinor: 0, algorithmVersion: 3, sourceFingerprint: fingerprint,
        supersedesSetId: null, reversalOfSetId: null, items: [] }
    ] as never;
    vi.mocked(buildDisputeAllocationPlan).mockReturnValue({ plans,
      presentmentEffects: [] } as never);
    vi.mocked(persistFinancialAllocationReplayPlanLocked)
      .mockResolvedValueOnce({ setId: grossSetId, disposition: 'inserted' })
      .mockResolvedValueOnce({ setId: feeSetId, disposition: 'inserted' });
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { id: balanceId, providerId: 'txn_dispute', sourceId: 'dp_dispute_trace',
          amountMinor: -100, feeMinor: 0, netMinor: -100, currency: 'USD',
          fingerprintSha256: fingerprint, providerCreatedAt: createdAt,
          classification: 'dispute_withdrawal' },
        { id: laterBalanceId, providerId: 'txn_missing', sourceId: 'dp_missing',
          amountMinor: -100, feeMinor: 0, netMinor: -100, currency: 'USD',
          fingerprintSha256: fingerprint,
          providerCreatedAt: new Date(createdAt.getTime() + 1000),
          classification: 'dispute_withdrawal' }
      ] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    let rolledBack = false;
    const tx = { execute, transaction: vi.fn() } as unknown as DatabaseTransaction;
    vi.mocked(tx.transaction).mockImplementation(async (work) => {
      try {
        return await work(tx);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    const facts = { ...lockedFacts(), payment: { id: paymentId, orderId } } as never;
    const projectionLocks = projectionLockRows({ balanceTransactions: [
      { id: balanceId, fingerprintSha256: fingerprint },
      { id: laterBalanceId, fingerprintSha256: fingerprint }
    ] });

    await expect(recomputeLockedDisputeFinancialProjectionForVersion(tx, {
      orderId, paymentId, balanceTransactionIds: [balanceId, laterBalanceId],
      purchaseFacts: facts, projectionLocks, correlationId: 'dispute-replay-rollback'
    }, { classifierVersion: 2, allocationAlgorithmVersion: 3, replayId: 'c2-a3' }))
      .resolves.toEqual({ status: 'exception', safeCode: 'source_linkage_mismatch' });

    expect(persistFinancialAllocationReplayPlanLocked).toHaveBeenCalledTimes(2);
    expect(rolledBack).toBe(true);
  });

  it('rolls back and returns a durable exception when allocation construction throws', async () => {
    const fingerprint = 'a'.repeat(64);
    const actual = await vi.importActual<typeof import('../allocations/dispute')>(
      '../allocations/dispute'
    );
    vi.mocked(buildDisputeAllocationPlan).mockImplementationOnce(
      actual.buildDisputeAllocationPlan
    );
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: balanceId, providerId: 'txn_dispute', sourceId: 'dp_dispute_trace',
        amountMinor: -101, feeMinor: 0, netMinor: -101, currency: 'USD',
        fingerprintSha256: fingerprint, providerCreatedAt: createdAt,
        classification: 'dispute_withdrawal'
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    let rolledBack = false;
    const tx = { execute, transaction: vi.fn() } as unknown as DatabaseTransaction;
    vi.mocked(tx.transaction).mockImplementation(async (work) => {
      try {
        return await work(tx);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    const baseFacts = lockedFacts();
    const facts = { ...baseFacts, payment: { id: paymentId, orderId },
      disputes: baseFacts.disputes.map((dispute) => ({ ...dispute, amountMinor: 101 })) } as never;

    await expect(recomputeLockedDisputeFinancialProjectionForVersion(tx, {
      orderId, paymentId, balanceTransactionIds: [balanceId], purchaseFacts: facts,
      projectionLocks: projectionLockRows({ balanceTransactions: [
        { id: balanceId, fingerprintSha256: fingerprint }
      ] }), correlationId: 'dispute-replay-durable-allocation-error'
    }, { classifierVersion: 2, allocationAlgorithmVersion: 3, replayId: 'c2-a3' }))
      .resolves.toEqual({ status: 'exception', safeCode: 'allocation_mismatch' });

    expect(rolledBack).toBe(true);
  });
});

describe('reconcileDisputeFinancialSource', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue([]);
    vi.mocked(observeFinancialIssue).mockResolvedValue({ id: issueId } as never);
  });

  it('rejects a non-canonical internal dispute job before database or provider work', async () => {
    const database = { select: vi.fn(), transaction: vi.fn() } as unknown as Database;
    const gateway = { retrieveDispute: vi.fn() } as unknown as StripeCommerceGateway;

    await expect(
      reconcileDisputeFinancialSource(
        database,
        gateway,
        {
          disputeId: 'not-a-uuid',
          correlationId: 'dispute-red'
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      name: 'PermanentFinancialError',
      safeCode: 'invalid_job_payload'
    });
    expect(database.select).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
    expect(gateway.retrieveDispute).not.toHaveBeenCalled();
  });

  it('sorts canonical dispute effects before independently staging them and opening purchase projection', async () => {
    const trace: string[] = [];
    const database = routingDatabase(trace);
    vi.mocked(stageBalanceTransaction).mockImplementation(async (_database, snapshot) => {
      trace.push(`stage.${snapshot.id}`);
      return {
        balanceTransactionId:
          snapshot.id === 'txn_withdrawal_trace'
            ? '00000000-0000-4000-8000-000000000304'
            : '00000000-0000-4000-8000-000000000305',
        disposition: 'inserted'
      };
    });

    await expect(
      reconcileDisputeFinancialSource(
        database,
        gateway(trace),
        {
          disputeId,
          correlationId: 'dispute-trace'
        },
        new AbortController().signal
      )
    ).rejects.toThrow('projection-stop');
    expect(trace).toEqual([
      'provider.dispute',
      'provider.payment',
      'provider.charge',
      'provider.balance.txn_reinstatement_trace',
      'provider.balance.txn_withdrawal_trace',
      'stage.txn_withdrawal_trace',
      'stage.txn_reinstatement_trace',
      'tx.begin'
    ]);
  });

  it('records malformed canonical provider evidence as a durable dispute exception', async () => {
    const database = routingDatabase([]);
    const transaction = prepareDisputeIssueTransaction(database);
    const provider = oneTransactionGateway();
    vi.mocked(provider.retrieveDispute).mockResolvedValue({
      providerDisputeId: 'dp_dispute_trace',
      paymentIntentId: 'pi_dispute_trace',
      chargeId: 'ch_dispute_trace',
      liveMode: false,
      state: 'won',
      amountMinor: 100,
      currency: 'usd',
      reason: null,
      providerCreatedAt: createdAt,
      balanceTransactionIds: ['txn_withdrawal_trace'],
      privateProviderMessage: 'must not escape'
    } as never);

    await expect(
      reconcileDisputeFinancialSource(
        database,
        provider,
        {
          disputeId,
          correlationId: 'dispute-malformed-provider'
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'exception',
      sourceKind: 'dispute',
      sourceId: disputeId,
      financialEvidenceStatus: 'exception',
      safeCode: 'unsupported_category',
      issueId
    });

    expect(lockOrder).toHaveBeenCalledWith(transaction, orderId);
    expect(observeFinancialIssue).toHaveBeenCalledWith(transaction, {
      resourceType: 'dispute',
      resourceId: disputeId,
      safeCode: 'unsupported_category',
      impact: 'exception',
      actor: { type: 'system', id: 'commerce-worker' },
      correlationId: 'dispute-malformed-provider'
    });
    expect(stageBalanceTransaction).not.toHaveBeenCalled();
  });

  it('records a staged ledger collision as a durable dispute exception', async () => {
    const database = routingDatabase([]);
    const transaction = prepareDisputeIssueTransaction(database);
    vi.mocked(stageBalanceTransaction).mockRejectedValueOnce(
      new PermanentFinancialError('immutable_mismatch')
    );

    await expect(
      reconcileDisputeFinancialSource(
        database,
        oneTransactionGateway(),
        {
          disputeId,
          correlationId: 'dispute-ledger-collision'
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'exception',
      sourceKind: 'dispute',
      sourceId: disputeId,
      financialEvidenceStatus: 'exception',
      safeCode: 'immutable_mismatch',
      issueId
    });

    expect(stageBalanceTransaction).toHaveBeenCalledOnce();
    expect(observeFinancialIssue).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        resourceType: 'dispute',
        resourceId: disputeId,
        safeCode: 'immutable_mismatch',
        impact: 'exception'
      })
    );
  });

  it('records a zero-transaction dispute as durable missing_source without constructing an empty IN clause', async () => {
    const database = routingDatabase([]);
    const provider = oneTransactionGateway();
    vi.mocked(provider.retrieveDispute).mockResolvedValue({
      providerDisputeId: 'dp_dispute_trace',
      paymentIntentId: 'pi_dispute_trace',
      chargeId: 'ch_dispute_trace',
      liveMode: false,
      state: 'won',
      amountMinor: 100,
      currency: 'usd',
      reason: null,
      providerCreatedAt: createdAt,
      balanceTransactionIds: []
    });
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      ...updateChain()
    } as unknown as DatabaseTransaction;
    vi.mocked(database.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(lockCanonicalPaymentPurchaseFacts).mockResolvedValue(lockedFacts() as never);
    vi.mocked(lockFinancialProjectionRows).mockResolvedValue(projectionLockRows());
    vi.mocked(observeFinancialIssue).mockResolvedValue({ id: issueId } as never);

    await expect(
      reconcileDisputeFinancialSource(
        database,
        provider,
        {
          disputeId,
          correlationId: 'dispute-zero'
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'pending',
      sourceKind: 'dispute',
      sourceId: disputeId,
      financialEvidenceStatus: 'pending',
      safeCode: 'missing_source',
      issueId
    });

    expect(stageBalanceTransaction).not.toHaveBeenCalled();
    expect(observeFinancialIssue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        resourceType: 'dispute',
        resourceId: disputeId,
        safeCode: 'missing_source',
        impact: 'pending'
      })
    );
    const rendered = mockedDatabaseExecute(database).mock.calls.map(([query]) => render(query).sql);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain('from stripe_balance_transactions balance');
    expect(rendered.join('\n')).not.toMatch(/\bin\s*\(\s*\)/iu);
  });

  it('expands a staged dispute transaction to the complete payout generation lock closure', async () => {
    const database = routingDatabase([]);
    mockedDatabaseExecute(database).mockImplementation(async (query: unknown) => {
      const text = render(query).sql;
      return text.includes('join disputes dispute on dispute.stripe_dispute_id')
        ? { rows: [{
            balanceTransactionId: balanceId, disputeId,
            providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'a'.repeat(64)
          }] }
        : {
            rows: [
              { payoutId, expectedGeneration: 7, balanceTransactionId: balanceId },
              { payoutId, expectedGeneration: 7, balanceTransactionId: siblingBalanceId }
            ]
          };
    });
    vi.mocked(stageBalanceTransaction).mockResolvedValue({
      balanceTransactionId: balanceId,
      disposition: 'inserted'
    });
    const tx = {
      execute: vi.fn(async (query: SQL) => {
        const text = render(query).sql;
        return text.includes('join disputes dispute on dispute.stripe_dispute_id')
          ? { rows: [{
              balanceTransactionId: balanceId, disputeId,
              providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'a'.repeat(64)
            }] }
          : { rows: [] };
      }),
      ...updateChain()
    } as unknown as DatabaseTransaction;
    vi.mocked(database.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(lockCanonicalPaymentPurchaseFacts).mockResolvedValue({
      ...lockedFacts(),
      refunds: [{ id: refundId, status: 'succeeded' }],
      refundComponents: [{
        refundId,
        refundAllocationId: '00000000-0000-4000-8000-000000000314',
        orderItemId,
        subtotalMinor: 9,
        taxMinor: 1,
        currency: 'USD'
      }]
    } as never);
    const marker = new Error('stop-after-closure-lock');
    vi.mocked(lockFinancialProjectionRows).mockRejectedValue(marker);

    await expect(
      reconcileDisputeFinancialSource(
        database,
        oneTransactionGateway(),
        {
          disputeId,
          correlationId: 'dispute-payout-closure'
        },
        new AbortController().signal
      )
    ).rejects.toBe(marker);

    expect(lockFinancialProjectionRows).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        payoutGenerations: [{ payoutId, expectedGeneration: 7 }],
        balanceTransactionIds: [balanceId, siblingBalanceId].sort()
      })
    );
    expect(lockActiveFinancialProjectionImplementation).toHaveBeenCalledWith(tx, {
      classifierVersion: 1,
      allocationAlgorithmVersion: 1
    });
    expect(vi.mocked(lockActiveFinancialProjectionImplementation).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(lockCanonicalPaymentPurchaseFacts).mock.invocationCallOrder[0]!);
    expect(lockFinancialProjectionEnrollment).toHaveBeenCalledWith(tx);
    expect(vi.mocked(lockCanonicalPaymentPurchaseFacts).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(lockFinancialProjectionEnrollment).mock.invocationCallOrder[0]!);
    expect(vi.mocked(lockFinancialProjectionEnrollment).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(lockFinancialProjectionRows).mock.invocationCallOrder[0]!);
  });

  it('retries when the dispute balance-owner closure changes after authority enrollment', async () => {
    const database = routingDatabase([]);
    mockedDatabaseExecute(database).mockImplementation(async (query: unknown) => {
      const text = render(query).sql;
      if (text.includes('join disputes dispute')) {
        return { rows: [{
          balanceTransactionId: balanceId, disputeId,
          providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'a'.repeat(64)
        }] };
      }
      return { rows: [] };
    });
    vi.mocked(stageBalanceTransaction).mockResolvedValue({
      balanceTransactionId: balanceId,
      disposition: 'unchanged'
    });
    const tx = {
      execute: vi.fn(async (query: SQL) => {
        const text = render(query).sql;
        if (text.includes('join disputes dispute')) {
          return { rows: [
            { balanceTransactionId: balanceId, disputeId,
              providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'a'.repeat(64) },
            { balanceTransactionId: siblingBalanceId, disputeId: siblingDisputeId,
              providerSourceId: 'dp_sibling', fingerprintSha256: 'b'.repeat(64) }
          ] };
        }
        return { rows: [] };
      }),
      ...updateChain()
    } as unknown as DatabaseTransaction;
    vi.mocked(database.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(lockCanonicalPaymentPurchaseFacts).mockResolvedValue(lockedFacts() as never);
    vi.mocked(lockFinancialProjectionRows).mockRejectedValue(
      new Error('financial-lock-should-not-be-reached')
    );

    await expect(reconcileDisputeFinancialSource(
      database,
      oneTransactionGateway(),
      { disputeId, correlationId: 'dispute-owner-closure-drift' },
      new AbortController().signal
    )).rejects.toMatchObject({ name: 'RetryableFinancialError', safeCode: 'state_changed' });

    expect(lockFinancialProjectionEnrollment).toHaveBeenCalledWith(tx);
    expect(lockFinancialProjectionRows).not.toHaveBeenCalled();
  });

  it('fails an unchanged ordinary target closed when stored presentment diverges', async () => {
    const allocationIdentity = `dispute:${disputeId}:${balanceId}:presentment:${orderItemId}`;
    const facts = {
      ...lockedFacts({
      financialEvidenceStatus: 'fee_reconciled',
      disputeItemAllocations: [
        {
          id: allocationId,
          allocationIdentity,
          disputeId,
          grossAllocationSetId: grossSetId,
          orderItemId,
          effect: 'withdrawal',
          reversesAllocationId: null,
          subtotalEffectMinor: -80,
          taxEffectMinor: -10,
          totalEffectMinor: -90,
          currency: 'USD'
        }
      ]
      }),
      refunds: [{
        id: refundId, status: 'succeeded', stripeRefundId: 're_after_dispute',
        providerCreatedAt: new Date(createdAt.getTime() + 1000)
      }],
      refundComponents: [{
        refundId,
        refundAllocationId: '00000000-0000-4000-8000-000000000314',
        orderItemId, subtotalMinor: 1, taxMinor: 0, currency: 'USD'
      }]
    };
    const database = routingDatabase([]);
    mockedDatabaseExecute(database).mockImplementation(async (query: unknown) => {
      const text = render(query).sql;
      return text.includes('join disputes dispute on dispute.stripe_dispute_id')
        ? { rows: [{
            balanceTransactionId: balanceId, disputeId,
            providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'a'.repeat(64)
          }] }
        : { rows: [] };
    });
    vi.mocked(stageBalanceTransaction).mockResolvedValue({
      balanceTransactionId: balanceId,
      disposition: 'unchanged'
    });
    const txExecute = vi.fn(async (query: SQL) => {
      const text = render(query).sql;
      if (text.includes('join disputes dispute on dispute.stripe_dispute_id')) {
        return { rows: [{
          balanceTransactionId: balanceId, disputeId,
          providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'a'.repeat(64)
        }] };
      }
      if (text.includes('select distinct allocation_set.balance_transaction_id')) {
        return { rows: [{ balanceTransactionId: balanceId }] };
      }
      if (text.includes('from financial_allocation_sets target_set')) {
        return { rows: [
          { id: feeSetId, balanceTransactionId: balanceId, basis: 'fee' },
          { id: grossSetId, balanceTransactionId: balanceId, basis: 'gross_amount' }
        ] };
      }
      if (text.includes('select id, provider_id as "providerId", provider_created_at')) {
        return {
          rows: [
            { id: balanceId, providerId: 'txn_withdrawal_trace', providerCreatedAt: createdAt }
          ]
        };
      }
      if (text.includes('fee_minor as "feeMinor"')) {
        return {
          rows: [
            {
              id: balanceId,
              providerId: 'txn_withdrawal_trace',
              sourceId: 'dp_dispute_trace',
              amountMinor: -100,
              feeMinor: 0,
              netMinor: -100,
              currency: 'USD',
              fingerprintSha256: 'a'.repeat(64),
              providerCreatedAt: createdAt
            }
          ]
        };
      }
      if (text.includes('from stripe_balance_transaction_fee_details')) return { rows: [] };
      if (text.includes('from financial_allocation_sets where id')) {
        const fee = render(query).params[0] === feeSetId;
        return { rows: [{
          id: fee ? feeSetId : grossSetId, balanceTransactionId: balanceId,
          allocationIdentity: `dispute:${disputeId}:${balanceId}:${fee ? 'fee' : 'gross'}`,
          expectedEffectMinor: fee ? 0 : -100, currency: 'USD', algorithmVersion: 1,
          sourceFingerprint: 'a'.repeat(64), supersedesSetId: null,
          reversalOfSetId: null, scope: 'title'
        }] };
      }
      if (text.includes('from financial_item_allocations')) {
        return render(query).params[0] === feeSetId ? { rows: [] } : { rows: [{
          orderItemId, component: 'dispute_subtotal', effectMinor: -100,
          currency: 'USD', tieBreakKey: `${orderItemId}:subtotal`
        }] };
      }
      if (text.includes('insert into dispute_item_allocations')) return { rows: [] };
      if (text.includes('from dispute_item_allocations where allocation_identity')) {
        return {
          rows: [
            {
              id: allocationId,
              disputeId,
              orderItemId,
              effect: 'withdrawal',
              reversesAllocationId: null,
              subtotalMinor: -80,
              taxMinor: -10,
              currency: 'USD'
            }
          ]
        };
      }
      throw new Error(`unexpected dispute replay SQL: ${text}`);
    });
    const tx = {
      execute: txExecute,
      transaction: vi.fn(),
      ...updateChain()
    } as unknown as DatabaseTransaction;
    vi.mocked(tx.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(database.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(lockCanonicalPaymentPurchaseFacts).mockResolvedValue(facts as never);
    vi.mocked(lockFinancialProjectionRows).mockResolvedValue(
      projectionLockRows({
        balanceTransactions: [{ id: balanceId, fingerprintSha256: 'a'.repeat(64) }],
        classifications: [classificationRow(balanceId, 'dispute_withdrawal', 'a'.repeat(64))]
      })
    );
    vi.mocked(buildDisputeAllocationPlan).mockReturnValue({
      plans: [
        {
          allocationIdentity: `dispute:${disputeId}:${balanceId}:gross`,
          balanceTransactionId: balanceId, basis: 'gross_amount', scope: 'title',
          currency: 'USD', expectedEffectMinor: -100, algorithmVersion: 1,
          sourceFingerprint: 'a'.repeat(64), supersedesSetId: grossSetId,
          reversalOfSetId: null, items: [{ orderItemId, component: 'dispute_subtotal',
            effectMinor: -100, currency: 'USD', tieBreakKey: `${orderItemId}:subtotal` }]
        },
        {
          allocationIdentity: `dispute:${disputeId}:${balanceId}:fee`,
          balanceTransactionId: balanceId, basis: 'fee', scope: 'title',
          currency: 'USD', expectedEffectMinor: 0, algorithmVersion: 1,
          sourceFingerprint: 'a'.repeat(64), supersedesSetId: feeSetId,
          reversalOfSetId: null, items: []
        }
      ],
      presentmentEffects: [
        {
          allocationId: allocationIdentity,
          withdrawalSetId: null,
          disputeId,
          providerCreatedAt: createdAt.toISOString(),
          providerTransactionId: 'txn_withdrawal_trace',
          orderItemId,
          subtotalMinor: -90,
          taxMinor: -10,
          presentmentCurrency: 'USD',
          effect: 'withdrawal',
          reversalOfAllocationId: null
        }
      ]
    } as never);
    vi.mocked(persistFinancialAllocationPlanLocked)
      .mockResolvedValueOnce({ setId: grossSetId, disposition: 'unchanged' })
      .mockResolvedValueOnce({ setId: feeSetId, disposition: 'unchanged' });
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue([
      { status: 'complete', balanceTransactionId: balanceId, basis: 'gross_amount',
        baseSetId: grossSetId, scope: 'title', currency: 'USD',
        expectedEffectMinor: -100, items: [] },
      { status: 'complete', balanceTransactionId: balanceId, basis: 'fee',
        baseSetId: feeSetId, scope: 'title', currency: 'USD',
        expectedEffectMinor: 0, items: [] }
    ] as never);
    vi.mocked(resolveFinancialIssueAfterRecompute).mockResolvedValue(null);

    await expect(
      reconcileDisputeFinancialSource(
        database,
        oneTransactionGateway(),
        {
          disputeId,
          correlationId: 'dispute-replay'
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'exception',
      sourceKind: 'dispute',
      sourceId: disputeId,
      financialEvidenceStatus: 'exception',
      safeCode: 'allocation_mismatch',
      issueId
    });

    expect(buildDisputeAllocationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        balanceTransactionId: balanceId,
        priorPresentmentEffects: []
      })
    );
    expect(observeFinancialIssue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        resourceType: 'allocation_set',
        resourceId: grossSetId,
        safeCode: 'allocation_mismatch',
        impact: 'exception'
      })
    );
    expect(appendAuditEvent).not.toHaveBeenCalled();
    expect(rearmCurrentProjectionSubjectsForFinancialSources).toHaveBeenCalledWith(tx, {
      sourceKind: 'dispute', sourceIds: [disputeId]
    });
    expect(rearmCurrentProjectionSubjectsForFinancialSources).toHaveBeenCalledWith(tx, {
      sourceKind: 'refund', sourceIds: [refundId]
    });
  });

  it('binds a classified dispute fee credit to the exact outstanding withdrawal fee set', async () => {
    const priorAllocationIdentity = `dispute:${disputeId}:${siblingBalanceId}:presentment:${orderItemId}`;
    const facts = lockedFacts({
      disputeItemAllocations: [
        {
          id: allocationId,
          allocationIdentity: priorAllocationIdentity,
          disputeId,
          grossAllocationSetId: grossSetId,
          orderItemId,
          effect: 'withdrawal',
          reversesAllocationId: null,
          subtotalEffectMinor: -90,
          taxEffectMinor: -10,
          totalEffectMinor: -100,
          currency: 'USD'
        }
      ]
    });
    const provider = oneTransactionGateway();
    vi.mocked(provider.retrieveDispute).mockResolvedValue({
      providerDisputeId: 'dp_dispute_trace',
      paymentIntentId: 'pi_dispute_trace',
      chargeId: 'ch_dispute_trace',
      liveMode: false,
      state: 'won',
      amountMinor: 100,
      currency: 'usd',
      reason: null,
      providerCreatedAt: createdAt,
      balanceTransactionIds: ['txn_fee_credit_trace']
    });
    vi.mocked(provider.retrieveBalanceTransaction).mockResolvedValue({
      id: 'txn_fee_credit_trace',
      livemode: false,
      sourceId: 'dp_dispute_trace',
      sourceFamily: 'dispute',
      rawType: 'stripe_fee',
      reportingCategory: 'fee',
      amountMinor: 15,
      feeMinor: 0,
      netMinor: 15,
      currency: 'USD',
      status: 'available',
      balanceType: 'payments',
      createdAt,
      availableAt: createdAt,
      exchangeRate: null,
      exchangeSourceCurrency: null,
      exchangeTargetCurrency: null,
      feeDetails: []
    });
    const database = routingDatabase([]);
    mockedDatabaseExecute(database).mockImplementation(async (query: unknown) => {
      const text = render(query).sql;
      return text.includes('join disputes dispute on dispute.stripe_dispute_id')
        ? { rows: [
            { balanceTransactionId: balanceId, disputeId,
              providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'b'.repeat(64) },
            { balanceTransactionId: siblingBalanceId, disputeId,
              providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'c'.repeat(64) }
          ] }
        : { rows: [] };
    });
    vi.mocked(stageBalanceTransaction).mockResolvedValue({
      balanceTransactionId: balanceId,
      disposition: 'inserted'
    });
    const priorCreatedAt = new Date(createdAt.getTime() - 1000);
    const txExecute = vi.fn(async (query: SQL) => {
      const rendered = render(query);
      if (rendered.sql.includes('join disputes dispute on dispute.stripe_dispute_id')) {
        return { rows: [
          { balanceTransactionId: balanceId, disputeId,
            providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'b'.repeat(64) },
          { balanceTransactionId: siblingBalanceId, disputeId,
            providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'c'.repeat(64) }
        ] };
      }
      if (rendered.sql.includes('select distinct allocation_set.balance_transaction_id')) {
        return { rows: [{ balanceTransactionId: siblingBalanceId }] };
      }
      if (rendered.sql.includes('from financial_allocation_sets target_set')) {
        return {
          rows: [
            { id: feeSetId, balanceTransactionId: siblingBalanceId, basis: 'fee' },
            { id: grossSetId, balanceTransactionId: siblingBalanceId, basis: 'gross_amount' }
          ]
        };
      }
      if (rendered.sql.includes('fee_minor as "feeMinor"') &&
        rendered.params[0] === siblingBalanceId) {
        return {
          rows: [
            {
              id: siblingBalanceId,
              providerId: 'txn_withdrawal_prior',
              sourceId: 'dp_dispute_trace',
              amountMinor: -100,
              feeMinor: 15,
              netMinor: -115,
              currency: 'USD',
              fingerprintSha256: 'c'.repeat(64),
              providerCreatedAt: priorCreatedAt
            }
          ]
        };
      }
      if (rendered.sql.includes('fee_minor as "feeMinor"')) {
        return {
          rows: [
            {
              id: balanceId,
              providerId: 'txn_fee_credit_trace',
              sourceId: 'dp_dispute_trace',
              amountMinor: 15,
              feeMinor: 0,
              netMinor: 15,
              currency: 'USD',
              fingerprintSha256: 'b'.repeat(64),
              providerCreatedAt: createdAt
            }
          ]
        };
      }
      if (rendered.sql.includes('from stripe_balance_transaction_fee_details')) return { rows: [] };
      if (rendered.sql.includes('from financial_allocation_sets where id')) {
        const requestedId = rendered.params[0];
        const fee = requestedId === feeSetId;
        return {
          rows: [
            {
              id: requestedId,
              balanceTransactionId: siblingBalanceId,
              allocationIdentity: `dispute:${disputeId}:${siblingBalanceId}:${fee ? 'fee' : 'gross'}`,
              expectedEffectMinor: fee ? -15 : -100,
              currency: 'USD',
              algorithmVersion: 1,
              sourceFingerprint: 'c'.repeat(64),
              supersedesSetId: null,
              reversalOfSetId: null,
              scope: 'title'
            }
          ]
        };
      }
      if (rendered.sql.includes('from financial_item_allocations')) {
        if (rendered.params[0] === feeSetId) return { rows: [] };
        return {
          rows: [
            {
              orderItemId,
              component: rendered.params[0] === feeSetId ? 'dispute_fee' : 'dispute_subtotal',
              effectMinor: rendered.params[0] === feeSetId ? -15 : -100,
              currency: 'USD',
              tieBreakKey: `${orderItemId}:subtotal`
            }
          ]
        };
      }
      throw new Error(`unexpected dispute fee-credit SQL: ${rendered.sql}`);
    });
    const tx = {
      execute: txExecute,
      transaction: vi.fn(),
      ...updateChain()
    } as unknown as DatabaseTransaction;
    vi.mocked(tx.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(database.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(lockCanonicalPaymentPurchaseFacts).mockResolvedValue(facts as never);
    vi.mocked(lockFinancialProjectionRows).mockResolvedValue(
      projectionLockRows({
        balanceTransactions: [
          { id: balanceId, fingerprintSha256: 'b'.repeat(64) },
          { id: siblingBalanceId, fingerprintSha256: 'c'.repeat(64) }
        ],
        classifications: [
          classificationRow(siblingBalanceId, 'dispute_withdrawal', 'c'.repeat(64)),
          classificationRow(balanceId, 'fee_credit', 'b'.repeat(64))
        ]
      })
    );
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue([
      {
        status: 'complete',
        balanceTransactionId: siblingBalanceId,
        basis: 'gross_amount',
        baseSetId: grossSetId,
        scope: 'title',
        currency: 'USD',
        expectedEffectMinor: -100,
        items: []
      },
      {
        status: 'complete',
        balanceTransactionId: siblingBalanceId,
        basis: 'fee',
        baseSetId: feeSetId,
        scope: 'title',
        currency: 'USD',
        expectedEffectMinor: -15,
        items: []
      }
    ] as never);
    vi.mocked(persistFinancialAllocationPlanLocked).mockImplementation(async (_tx, value) => ({
      setId: value.plan.basis === 'gross_amount' ? grossSetId : feeSetId,
      disposition: 'unchanged'
    }));
    const marker = new Error('fee-credit-plan-reached');
    vi.mocked(buildDisputeAllocationPlan).mockImplementation((allocationInput) => {
      if (allocationInput.balanceTransactionId === balanceId) throw marker;
      return {
        plans: [
          {
            allocationIdentity: 'prior-gross', balanceTransactionId: siblingBalanceId,
            basis: 'gross_amount', scope: 'title', currency: 'USD',
            expectedEffectMinor: -100, algorithmVersion: 1,
            sourceFingerprint: 'c'.repeat(64), supersedesSetId: grossSetId,
            reversalOfSetId: null, items: [{ orderItemId, component: 'dispute_subtotal',
              effectMinor: -100, currency: 'USD', tieBreakKey: `${orderItemId}:subtotal` }]
          },
          {
            allocationIdentity: 'prior-fee', balanceTransactionId: siblingBalanceId,
            basis: 'fee', scope: 'title', currency: 'USD', expectedEffectMinor: -15,
            algorithmVersion: 1, sourceFingerprint: 'c'.repeat(64),
            supersedesSetId: feeSetId, reversalOfSetId: null,
            items: [{ orderItemId, component: 'dispute_fee', effectMinor: -15,
              currency: 'USD', tieBreakKey: `${orderItemId}:subtotal` }]
          }
        ],
        presentmentEffects: [{
          allocationId: priorAllocationIdentity, withdrawalSetId: null, disputeId,
          providerCreatedAt: priorCreatedAt.toISOString(),
          providerTransactionId: 'txn_withdrawal_prior', orderItemId,
          subtotalMinor: -90, taxMinor: -10, presentmentCurrency: 'USD',
          effect: 'withdrawal', reversalOfAllocationId: null
        }]
      } as never;
    });

    await expect(
      reconcileDisputeFinancialSource(
        database,
        provider,
        {
          disputeId,
          correlationId: 'dispute-fee-credit'
        },
        new AbortController().signal
      )
    ).rejects.toBe(marker);

    expect(buildDisputeAllocationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: 'fee_credit',
        presentmentAmountMinor: 15,
        presentmentCurrency: 'USD',
        reversesSetId: null,
        reversesFeeSetId: feeSetId,
        withdrawalGrossPlan: null,
        withdrawalFeePlan: expect.objectContaining({
          basis: 'fee',
          balanceTransactionId: siblingBalanceId,
          expectedEffectMinor: -15
        })
      })
    );
  });

  it('uses the observed same-currency amount for a partial reinstatement of an exact withdrawal set', async () => {
    const priorAllocationIdentity = `dispute:${disputeId}:${siblingBalanceId}:presentment:${orderItemId}`;
    const facts = lockedFacts({
      disputeItemAllocations: [
        {
          id: allocationId,
          allocationIdentity: priorAllocationIdentity,
          disputeId,
          grossAllocationSetId: grossSetId,
          orderItemId,
          effect: 'withdrawal',
          reversesAllocationId: null,
          subtotalEffectMinor: -90,
          taxEffectMinor: -10,
          totalEffectMinor: -100,
          currency: 'USD'
        }
      ]
    });
    const provider = oneTransactionGateway();
    vi.mocked(provider.retrieveDispute).mockResolvedValue({
      providerDisputeId: 'dp_dispute_trace',
      paymentIntentId: 'pi_dispute_trace',
      chargeId: 'ch_dispute_trace',
      liveMode: false,
      state: 'won',
      amountMinor: 100,
      currency: 'usd',
      reason: null,
      providerCreatedAt: createdAt,
      balanceTransactionIds: ['txn_partial_reinstatement_trace']
    });
    vi.mocked(provider.retrieveBalanceTransaction).mockResolvedValue({
      id: 'txn_partial_reinstatement_trace',
      livemode: false,
      sourceId: 'dp_dispute_trace',
      sourceFamily: 'dispute',
      rawType: 'adjustment',
      reportingCategory: 'dispute_reversal',
      amountMinor: 50,
      feeMinor: 0,
      netMinor: 50,
      currency: 'USD',
      status: 'available',
      balanceType: 'payments',
      createdAt,
      availableAt: createdAt,
      exchangeRate: null,
      exchangeSourceCurrency: null,
      exchangeTargetCurrency: null,
      feeDetails: []
    });
    const database = routingDatabase([]);
    mockedDatabaseExecute(database).mockImplementation(async (query: unknown) => {
      const text = render(query).sql;
      return text.includes('join disputes dispute on dispute.stripe_dispute_id')
        ? { rows: [
            { balanceTransactionId: balanceId, disputeId,
              providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'd'.repeat(64) },
            { balanceTransactionId: siblingBalanceId, disputeId,
              providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'c'.repeat(64) }
          ] }
        : { rows: [] };
    });
    vi.mocked(stageBalanceTransaction).mockResolvedValue({
      balanceTransactionId: balanceId,
      disposition: 'inserted'
    });
    const priorCreatedAt = new Date(createdAt.getTime() - 1000);
    const txExecute = vi.fn(async (query: SQL) => {
      const rendered = render(query);
      if (rendered.sql.includes('join disputes dispute on dispute.stripe_dispute_id')) {
        return { rows: [
          { balanceTransactionId: balanceId, disputeId,
            providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'd'.repeat(64) },
          { balanceTransactionId: siblingBalanceId, disputeId,
            providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'c'.repeat(64) }
        ] };
      }
      if (rendered.sql.includes('select distinct allocation_set.balance_transaction_id')) {
        return { rows: [{ balanceTransactionId: siblingBalanceId }] };
      }
      if (rendered.sql.includes('from financial_allocation_sets target_set')) {
        return {
          rows: [
            { id: feeSetId, balanceTransactionId: siblingBalanceId, basis: 'fee' },
            { id: grossSetId, balanceTransactionId: siblingBalanceId, basis: 'gross_amount' }
          ]
        };
      }
      if (rendered.sql.includes('fee_minor as "feeMinor"') &&
        rendered.params[0] === siblingBalanceId) {
        return {
          rows: [
            {
              id: siblingBalanceId,
              providerId: 'txn_withdrawal_prior',
              sourceId: 'dp_dispute_trace',
              amountMinor: -100,
              feeMinor: 0,
              netMinor: -100,
              currency: 'USD',
              fingerprintSha256: 'c'.repeat(64),
              providerCreatedAt: priorCreatedAt
            }
          ]
        };
      }
      if (rendered.sql.includes('fee_minor as "feeMinor"')) {
        return {
          rows: [
            {
              id: balanceId,
              providerId: 'txn_partial_reinstatement_trace',
              sourceId: 'dp_dispute_trace',
              amountMinor: 50,
              feeMinor: 0,
              netMinor: 50,
              currency: 'USD',
              fingerprintSha256: 'd'.repeat(64),
              providerCreatedAt: createdAt
            }
          ]
        };
      }
      if (rendered.sql.includes('from stripe_balance_transaction_fee_details')) return { rows: [] };
      if (rendered.sql.includes('from financial_allocation_sets where id')) {
        return {
          rows: [
            {
              id: grossSetId,
              balanceTransactionId: siblingBalanceId,
              allocationIdentity: `dispute:${disputeId}:${siblingBalanceId}:gross`,
              expectedEffectMinor: -100,
              currency: 'USD',
              algorithmVersion: 1,
              sourceFingerprint: 'c'.repeat(64),
              supersedesSetId: null,
              reversalOfSetId: null,
              scope: 'title'
            }
          ]
        };
      }
      if (rendered.sql.includes('from financial_item_allocations')) {
        if (rendered.params[0] === feeSetId) return { rows: [] };
        return {
          rows: [
            {
              orderItemId,
              component: 'dispute_subtotal',
              effectMinor: -100,
              currency: 'USD',
              tieBreakKey: `${orderItemId}:subtotal`
            }
          ]
        };
      }
      throw new Error(`unexpected partial-reinstatement SQL: ${rendered.sql}`);
    });
    const tx = {
      execute: txExecute,
      transaction: vi.fn(),
      ...updateChain()
    } as unknown as DatabaseTransaction;
    vi.mocked(tx.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(database.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(lockCanonicalPaymentPurchaseFacts).mockResolvedValue(facts as never);
    vi.mocked(lockFinancialProjectionRows).mockResolvedValue(
      projectionLockRows({
        balanceTransactions: [
          { id: balanceId, fingerprintSha256: 'd'.repeat(64) },
          { id: siblingBalanceId, fingerprintSha256: 'c'.repeat(64) }
        ],
        classifications: [
          classificationRow(siblingBalanceId, 'dispute_withdrawal', 'c'.repeat(64)),
          classificationRow(balanceId, 'dispute_reinstatement', 'd'.repeat(64))
        ]
      })
    );
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue([
      { status: 'complete', balanceTransactionId: siblingBalanceId, basis: 'gross_amount',
        baseSetId: grossSetId, scope: 'title', currency: 'USD',
        expectedEffectMinor: -100, items: [] },
      { status: 'complete', balanceTransactionId: siblingBalanceId, basis: 'fee',
        baseSetId: feeSetId, scope: 'title', currency: 'USD',
        expectedEffectMinor: 0, items: [] }
    ] as never);
    vi.mocked(persistFinancialAllocationPlanLocked).mockImplementation(async (_tx, value) => ({
      setId: value.plan.basis === 'gross_amount' ? grossSetId : feeSetId,
      disposition: 'unchanged'
    }));
    const marker = new Error('partial-reinstatement-plan-reached');
    vi.mocked(buildDisputeAllocationPlan).mockImplementation((allocationInput) => {
      if (allocationInput.balanceTransactionId === balanceId) throw marker;
      return {
        plans: [
          {
            allocationIdentity: 'prior-gross', balanceTransactionId: siblingBalanceId,
            basis: 'gross_amount', scope: 'title', currency: 'USD',
            expectedEffectMinor: -100, algorithmVersion: 1,
            sourceFingerprint: 'c'.repeat(64), supersedesSetId: grossSetId,
            reversalOfSetId: null, items: [{ orderItemId, component: 'dispute_subtotal',
              effectMinor: -100, currency: 'USD', tieBreakKey: `${orderItemId}:subtotal` }]
          },
          {
            allocationIdentity: 'prior-fee', balanceTransactionId: siblingBalanceId,
            basis: 'fee', scope: 'title', currency: 'USD', expectedEffectMinor: 0,
            algorithmVersion: 1, sourceFingerprint: 'c'.repeat(64),
            supersedesSetId: feeSetId, reversalOfSetId: null, items: []
          }
        ],
        presentmentEffects: [{
          allocationId: priorAllocationIdentity, withdrawalSetId: null, disputeId,
          providerCreatedAt: priorCreatedAt.toISOString(),
          providerTransactionId: 'txn_withdrawal_prior', orderItemId,
          subtotalMinor: -90, taxMinor: -10, presentmentCurrency: 'USD',
          effect: 'withdrawal', reversalOfAllocationId: null
        }]
      } as never;
    });

    await expect(
      reconcileDisputeFinancialSource(
        database,
        provider,
        {
          disputeId,
          correlationId: 'dispute-partial-reinstatement'
        },
        new AbortController().signal
      )
    ).rejects.toBe(marker);

    expect(buildDisputeAllocationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: 'reinstatement',
        presentmentAmountMinor: 50,
        presentmentCurrency: 'USD',
        reversesSetId: grossSetId,
        withdrawalGrossPlan: expect.objectContaining({
          basis: 'gross_amount',
          balanceTransactionId: siblingBalanceId,
          expectedEffectMinor: -100
        })
      })
    );
  });

  it('rolls back an overexposed withdrawal and records one durable allocation exception', async () => {
    const provider = oneTransactionGateway();
    vi.mocked(provider.retrieveDispute).mockResolvedValue({
      providerDisputeId: 'dp_dispute_trace',
      paymentIntentId: 'pi_dispute_trace',
      chargeId: 'ch_dispute_trace',
      liveMode: false,
      state: 'won',
      amountMinor: 101,
      currency: 'usd',
      reason: null,
      providerCreatedAt: createdAt,
      balanceTransactionIds: ['txn_withdrawal_overexposed']
    });
    vi.mocked(provider.retrieveBalanceTransaction).mockResolvedValue({
      id: 'txn_withdrawal_overexposed',
      livemode: false,
      sourceId: 'dp_dispute_trace',
      sourceFamily: 'dispute',
      rawType: 'adjustment',
      reportingCategory: 'dispute',
      amountMinor: -101,
      feeMinor: 0,
      netMinor: -101,
      currency: 'USD',
      status: 'available',
      balanceType: 'payments',
      createdAt,
      availableAt: createdAt,
      exchangeRate: null,
      exchangeSourceCurrency: null,
      exchangeTargetCurrency: null,
      feeDetails: []
    });
    const database = routingDatabase([]);
    mockedDatabaseExecute(database).mockImplementation(async (query: unknown) => {
      const text = render(query).sql;
      return text.includes('join disputes dispute on dispute.stripe_dispute_id')
        ? { rows: [{
            balanceTransactionId: balanceId, disputeId,
            providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'e'.repeat(64)
          }] }
        : { rows: [] };
    });
    vi.mocked(stageBalanceTransaction).mockResolvedValue({
      balanceTransactionId: balanceId,
      disposition: 'inserted'
    });
    const txExecute = vi.fn(async (query: SQL) => {
      const text = render(query).sql;
      if (text.includes('join disputes dispute on dispute.stripe_dispute_id')) {
        return { rows: [{
          balanceTransactionId: balanceId, disputeId,
          providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'e'.repeat(64)
        }] };
      }
      if (text.includes('select distinct allocation_set.balance_transaction_id')) {
        return { rows: [] };
      }
      if (text.includes('from financial_allocation_sets target_set')) return { rows: [] };
      if (text.includes('fee_minor as "feeMinor"')) {
        return {
          rows: [
            {
              id: balanceId,
              providerId: 'txn_withdrawal_overexposed',
              sourceId: 'dp_dispute_trace',
              amountMinor: -101,
              feeMinor: 0,
              netMinor: -101,
              currency: 'USD',
              fingerprintSha256: 'e'.repeat(64),
              providerCreatedAt: createdAt
            }
          ]
        };
      }
      if (text.includes('from stripe_balance_transaction_fee_details')) return { rows: [] };
      throw new Error(`unexpected overexposure SQL: ${text}`);
    });
    const tx = {
      execute: txExecute,
      transaction: vi.fn(),
      ...updateChain()
    } as unknown as DatabaseTransaction;
    vi.mocked(tx.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(database.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(lockCanonicalPaymentPurchaseFacts).mockResolvedValue({
      ...lockedFacts({ financialEvidenceStatus: 'pending' }),
      disputes: [
        {
          ...lockedFacts().disputes[0],
          amountMinor: 101
        }
      ]
    } as never);
    vi.mocked(lockFinancialProjectionRows).mockResolvedValue(
      projectionLockRows({
        balanceTransactions: [{ id: balanceId, fingerprintSha256: 'e'.repeat(64) }],
        classifications: [classificationRow(balanceId, 'dispute_withdrawal', 'e'.repeat(64))]
      })
    );
    const actual =
      await vi.importActual<typeof import('../allocations/dispute')>('../allocations/dispute');
    vi.mocked(buildDisputeAllocationPlan).mockImplementation(actual.buildDisputeAllocationPlan);
    vi.mocked(observeFinancialIssue).mockResolvedValue({ id: issueId } as never);

    await expect(
      reconcileDisputeFinancialSource(
        database,
        provider,
        {
          disputeId,
          correlationId: 'dispute-overexposed'
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'exception',
      sourceKind: 'dispute',
      sourceId: disputeId,
      financialEvidenceStatus: 'exception',
      safeCode: 'allocation_mismatch',
      issueId
    });

    expect(persistFinancialAllocationPlanLocked).not.toHaveBeenCalled();
    expect(observeFinancialIssue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        resourceType: 'dispute',
        resourceId: disputeId,
        safeCode: 'allocation_mismatch',
        impact: 'exception'
      })
    );
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it('records a classified unknown transaction as unsupported_category rather than immutable evidence', async () => {
    const database = routingDatabase([]);
    mockedDatabaseExecute(database).mockImplementation(async (query: unknown) => {
      const text = render(query).sql;
      return text.includes('join disputes dispute on dispute.stripe_dispute_id')
        ? { rows: [{
            balanceTransactionId: balanceId, disputeId,
            providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'f'.repeat(64)
          }] }
        : { rows: [] };
    });
    vi.mocked(stageBalanceTransaction).mockResolvedValue({
      balanceTransactionId: balanceId,
      disposition: 'inserted'
    });
    const txExecute = vi.fn(async (query: SQL) => {
      const text = render(query).sql;
      if (text.includes('join disputes dispute on dispute.stripe_dispute_id')) {
        return { rows: [{
          balanceTransactionId: balanceId, disputeId,
          providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'f'.repeat(64)
        }] };
      }
      if (text.includes('select distinct allocation_set.balance_transaction_id')) {
        return { rows: [] };
      }
      if (text.includes('from financial_allocation_sets target_set')) return { rows: [] };
      if (text.includes('fee_minor as "feeMinor"')) {
        return {
          rows: [
            {
              id: balanceId,
              providerId: 'txn_withdrawal_trace',
              sourceId: 'dp_dispute_trace',
              amountMinor: -100,
              feeMinor: 0,
              netMinor: -100,
              currency: 'USD',
              fingerprintSha256: 'f'.repeat(64),
              providerCreatedAt: createdAt
            }
          ]
        };
      }
      throw new Error(`unexpected unsupported-category SQL: ${text}`);
    });
    const tx = {
      execute: txExecute,
      transaction: vi.fn(),
      ...updateChain()
    } as unknown as DatabaseTransaction;
    vi.mocked(tx.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(database.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(lockCanonicalPaymentPurchaseFacts).mockResolvedValue(lockedFacts() as never);
    vi.mocked(lockFinancialProjectionRows).mockResolvedValue(
      projectionLockRows({
        balanceTransactions: [{ id: balanceId, fingerprintSha256: 'f'.repeat(64) }],
        classifications: [classificationRow(balanceId, 'unknown', 'f'.repeat(64))]
      })
    );
    vi.mocked(observeFinancialIssue).mockResolvedValue({ id: issueId } as never);

    await expect(
      reconcileDisputeFinancialSource(
        database,
        oneTransactionGateway(),
        {
          disputeId,
          correlationId: 'dispute-unknown-category'
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'exception',
      sourceKind: 'dispute',
      sourceId: disputeId,
      financialEvidenceStatus: 'exception',
      safeCode: 'unsupported_category',
      issueId
    });

    expect(buildDisputeAllocationPlan).not.toHaveBeenCalled();
    expect(observeFinancialIssue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        safeCode: 'unsupported_category',
        impact: 'exception'
      })
    );
  });

  it('attributes a prior sibling projection failure to the sibling dispute', async () => {
    const database = routingDatabase([]);
    const ownerRows = [
      { balanceTransactionId: balanceId, disputeId,
        providerSourceId: 'dp_dispute_trace', fingerprintSha256: 'a'.repeat(64) },
      { balanceTransactionId: siblingBalanceId, disputeId: siblingDisputeId,
        providerSourceId: 'dp_sibling', fingerprintSha256: 'b'.repeat(64) }
    ];
    mockedDatabaseExecute(database).mockImplementation(async (query: unknown) => ({
      rows: render(query).sql.includes('join disputes dispute on dispute.stripe_dispute_id')
        ? ownerRows
        : []
    }));
    vi.mocked(stageBalanceTransaction).mockResolvedValue({
      balanceTransactionId: balanceId,
      disposition: 'inserted'
    });
    const tx = {
      execute: vi.fn(async (query: SQL) => ({
        rows: render(query).sql.includes('join disputes dispute on dispute.stripe_dispute_id')
          ? ownerRows
          : render(query).sql.includes('select distinct allocation_set.balance_transaction_id')
            ? [{ balanceTransactionId: siblingBalanceId }]
            : []
      })),
      transaction: vi.fn(),
      ...updateChain()
    } as unknown as DatabaseTransaction;
    vi.mocked(tx.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(database.transaction).mockImplementation(async (work) => work(tx));
    vi.mocked(lockCanonicalPaymentPurchaseFacts).mockResolvedValue({
      ...lockedFacts(),
      disputes: [
        lockedFacts().disputes[0],
        {
          ...lockedFacts().disputes[0],
          id: siblingDisputeId,
          stripeDisputeId: 'dp_sibling',
          financialEvidenceStatus: 'exception'
        }
      ]
    } as never);
    vi.mocked(lockFinancialProjectionRows).mockResolvedValue(projectionLockRows());
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue([
      {
        status: 'exception',
        balanceTransactionId: siblingBalanceId,
        basis: 'gross_amount',
        safeCode: 'correction_rebase_required'
      }
    ] as never);
    vi.mocked(observeFinancialIssue).mockResolvedValue({ id: issueId } as never);

    await expect(
      reconcileDisputeFinancialSource(
        database,
        oneTransactionGateway(),
        { disputeId, correlationId: 'dispute-sibling-failure' },
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      status: 'exception',
      sourceId: siblingDisputeId,
      safeCode: 'allocation_mismatch'
    });

    expect(observeFinancialIssue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        resourceType: 'dispute',
        resourceId: siblingDisputeId,
        safeCode: 'allocation_mismatch'
      })
    );
  });
});
