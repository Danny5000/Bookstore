import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { lockOrder } from '$lib/server/commerce/lock';
import { lockPaymentPurchaseFacts } from '$lib/server/commerce/reconciliation';
import { lockCanonicalPaymentPurchaseFacts } from './payment';
import {
  loadCurrentEffectiveAllocationProjection,
  persistFinancialAllocationPlanLocked
} from '../allocations/repository';
import { observeFinancialIssue, resolveFinancialIssueAfterRecompute } from '../issues';
import { lockFinancialProjectionRows } from '../locks';
import { stageBalanceTransaction } from '../ledger';
import { PermanentFinancialError } from '../errors';
import type {
  CurrentEffectiveAllocationProjection,
  FinancialAllocationPlan,
  LockedRefundProjectionInput
} from '../types';
import { recomputeLockedRefundFinancialProjection, reconcileRefundFinancialSource } from './refund';

vi.mock('../ledger', () => ({ stageBalanceTransaction: vi.fn() }));
vi.mock('./payment', () => ({ lockCanonicalPaymentPurchaseFacts: vi.fn() }));
vi.mock('$lib/server/commerce/lock', () => ({ lockOrder: vi.fn() }));
vi.mock('$lib/server/commerce/reconciliation', () => ({ lockPaymentPurchaseFacts: vi.fn() }));
vi.mock('../locks', () => ({ lockFinancialProjectionRows: vi.fn() }));
vi.mock('../allocations/repository', () => ({
  loadCurrentEffectiveAllocationProjection: vi.fn(),
  persistFinancialAllocationPlanLocked: vi.fn()
}));
vi.mock('../issues', () => ({
  observeFinancialIssue: vi.fn(),
  resolveFinancialIssueAfterRecompute: vi.fn()
}));
vi.mock('$lib/server/audit/service', () => ({ appendAuditEvent: vi.fn() }));

const refundId = '00000000-0000-4000-8000-000000000201';
const paymentId = '00000000-0000-4000-8000-000000000202';
const orderId = '00000000-0000-4000-8000-000000000203';
const balanceId = '00000000-0000-4000-8000-000000000204';
const itemId = '00000000-0000-4000-8000-000000000205';
const allocationId = '00000000-0000-4000-8000-000000000206';
const failureBalanceId = '00000000-0000-4000-8000-000000000207';
const issueId = '00000000-0000-4000-8000-000000000211';
const createdAt = new Date('2026-08-10T00:00:00.000Z');
const fingerprint = 'a'.repeat(64);
const dialect = new PgDialect();

interface CanonicalBalanceRow {
  readonly id: string;
  readonly providerId: string;
  readonly sourceFamily: 'refund';
  readonly sourceId: string;
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly netMinor: number;
  readonly currency: string;
  readonly fingerprintSha256: string;
  readonly providerCreatedAt: Date;
  readonly classification: 'refund' | 'refund_failure';
}

function lockedInput(overrides: Partial<LockedRefundProjectionInput> = {}): LockedRefundProjectionInput {
  return {
    orderId,
    paymentId,
    refundId,
    providerStatus: 'succeeded',
    allocationStatus: 'finalized',
    amountMinor: 500,
    currency: 'USD',
    balanceTransactionIds: [balanceId],
    orderItems: [{
      id: itemId, subtotalMinor: 400, taxMinor: 100, totalMinor: 500, currency: 'USD'
    }],
    finalizedAllocations: [{ id: allocationId, orderItemId: itemId, amountMinor: 500 }],
    refundComponents: [{
      refundAllocationId: allocationId, orderItemId: itemId,
      subtotalMinor: 400, taxMinor: 100, currency: 'USD'
    }],
    correlationId: 'refund-recompute',
    ...overrides
  };
}

function canonicalBalance(overrides: Partial<CanonicalBalanceRow> = {}): CanonicalBalanceRow {
  return {
    id: balanceId,
    providerId: 'txn_refund_trace',
    sourceFamily: 'refund',
    sourceId: 're_refund_trace',
    amountMinor: -500,
    feeMinor: 10,
    netMinor: -510,
    currency: 'USD',
    fingerprintSha256: fingerprint,
    providerCreatedAt: createdAt,
    classification: 'refund',
    ...overrides
  };
}

function completeProjections(
  balances: readonly CanonicalBalanceRow[]
): CurrentEffectiveAllocationProjection[] {
  return balances.flatMap((balance, balanceIndex) => ([
    {
      status: 'complete' as const,
      balanceTransactionId: balance.id,
      basis: 'gross_amount' as const,
      baseSetId: `00000000-0000-4000-8000-0000000003${balanceIndex}1`,
      compatibleCorrectionTipId: null,
      scope: balance.classification === 'refund_failure' ? 'account' as const : 'title' as const,
      currency: balance.currency,
      expectedEffectMinor: balance.amountMinor,
      items: balance.classification === 'refund_failure' ? [] : [{
        orderItemId: itemId,
        component: 'refund_subtotal' as const,
        effectMinor: balance.amountMinor,
        currency: balance.currency
      }]
    },
    {
      status: 'complete' as const,
      balanceTransactionId: balance.id,
      basis: 'fee' as const,
      baseSetId: `00000000-0000-4000-8000-0000000003${balanceIndex}2`,
      compatibleCorrectionTipId: null,
      scope: 'title' as const,
      currency: balance.currency,
      expectedEffectMinor: -balance.feeMinor,
      items: balance.feeMinor === 0 ? [] : [{
        orderItemId: itemId,
        component: 'refund_fee' as const,
        effectMinor: -balance.feeMinor,
        currency: balance.currency
      }]
    }
  ]));
}

function projectionTransaction(input: {
  readonly balances: readonly CanonicalBalanceRow[];
  readonly history?: readonly Record<string, unknown>[];
  readonly feeDetails?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}): DatabaseTransaction {
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(async () => ({ rows: [] })) }))
  }));
  const transaction = {
    execute: vi.fn(async (query: unknown) => {
      const rendered = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]);
      if (rendered.sql.includes('from refunds where id')) {
        return { rows: [{ financialEvidenceStatus: 'pending' }] };
      }
      if (rendered.sql.includes('from stripe_balance_transactions')) {
        return { rows: input.balances };
      }
      if (rendered.sql.includes('from stripe_balance_transaction_fee_details')) {
        const balance = input.balances.find((candidate) => rendered.params.includes(candidate.id));
        return { rows: balance ? input.feeDetails?.[balance.id] ?? [] : [] };
      }
      if (rendered.sql.includes('from refund_allocation_components')) {
        return { rows: input.history ?? [] };
      }
      return { rows: [] };
    }),
    transaction: vi.fn(async (work: (tx: DatabaseTransaction) => Promise<unknown>) =>
      work(transaction as unknown as DatabaseTransaction)),
    update
  };
  return transaction as unknown as DatabaseTransaction;
}

function persistedPlans(): FinancialAllocationPlan[] {
  return vi.mocked(persistFinancialAllocationPlanLocked).mock.calls.map((call) => call[1].plan);
}

function routingDatabase(trace: string[]): Database {
  const limit = vi.fn().mockResolvedValue([{
    id: refundId, stripeRefundId: 're_refund_trace', paymentId, orderId,
    stripePaymentIntentId: 'pi_refund_trace'
  }]);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ innerJoin, where }));
  const from = vi.fn(() => ({ innerJoin, where }));
  return {
    select: vi.fn(() => ({ from })),
    execute: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(async () => { trace.push('tx.begin'); throw new Error('projection-stop'); })
  } as unknown as Database;
}

function refundIssueFacts() {
  return {
    order: { id: orderId },
    payment: { id: paymentId, orderId, stripePaymentIntentId: 'pi_refund_trace' },
    refunds: [{
      id: refundId, paymentId, stripeRefundId: 're_refund_trace',
      financialEvidenceStatus: 'pending'
    }],
    refundDrafts: [], refundDraftItems: [], refundAllocations: [], refundComponents: [],
    correctionSets: [], correctionItems: [], disputes: [], disputeItemAllocations: [],
    orderItems: [{ id: itemId }]
  };
}

function prepareRefundIssueTransaction(database: Database): DatabaseTransaction {
  const forUpdate = vi.fn()
    .mockResolvedValueOnce([{ id: orderId }])
    .mockResolvedValueOnce([{
      id: paymentId, orderId, stripePaymentIntentId: 'pi_refund_trace'
    }]);
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
  vi.mocked(lockPaymentPurchaseFacts).mockResolvedValue(refundIssueFacts() as never);
  vi.mocked(observeFinancialIssue).mockResolvedValue({ id: issueId } as never);
  return tx;
}

function gateway(trace: string[]): StripeCommerceGateway {
  return {
    retrieveRefund: vi.fn(async () => {
      trace.push('provider.refund');
      return { providerRefundId: 're_refund_trace', paymentIntentId: 'pi_refund_trace',
        liveMode: false, state: 'succeeded', amountMinor: 100, currency: 'usd', reason: null,
        providerCreatedAt: createdAt, balanceTransactionId: 'txn_refund_trace',
        failureBalanceTransactionId: null };
    }),
    retrievePayment: vi.fn(async () => {
      trace.push('provider.payment');
      return { paymentIntentId: 'pi_refund_trace', metadataVersion: '1', metadataOrderId: orderId,
        latestChargeId: 'ch_refund_trace', liveMode: false, state: 'succeeded', amountMinor: 1000,
        currency: 'usd', paidAt: createdAt, paymentMethodCategory: 'card' };
    }),
    retrieveCharge: vi.fn(async () => {
      trace.push('provider.charge');
      return { id: 'ch_refund_trace', paymentIntentId: 'pi_refund_trace', livemode: false,
        amountMinor: 1000, amountRefundedMinor: 100, currency: 'USD', status: 'succeeded',
        balanceTransactionId: 'txn_charge_trace', createdAt };
    }),
    retrieveBalanceTransaction: vi.fn(async () => {
      trace.push('provider.balance');
      return { id: 'txn_refund_trace', livemode: false, sourceId: 're_refund_trace',
        sourceFamily: 'refund', rawType: 'refund', reportingCategory: 'refund', amountMinor: -100,
        feeMinor: 0, netMinor: -100, currency: 'USD', status: 'available', balanceType: 'payments',
        createdAt, availableAt: createdAt, exchangeRate: null, exchangeSourceCurrency: null,
        exchangeTargetCurrency: null, feeDetails: [] };
    })
  } as unknown as StripeCommerceGateway;
}

describe('reconcileRefundFinancialSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveFinancialIssueAfterRecompute).mockResolvedValue(null);
  });

  it('rejects a non-canonical internal refund job before database or provider work', async () => {
    const database = { select: vi.fn(), transaction: vi.fn() } as unknown as Database;
    const gateway = { retrieveRefund: vi.fn() } as unknown as StripeCommerceGateway;

    await expect(reconcileRefundFinancialSource(database, gateway, {
      refundId: 'not-a-uuid', correlationId: 'refund-red'
    }, new AbortController().signal)).rejects.toMatchObject({
      name: 'PermanentFinancialError', safeCode: 'invalid_job_payload'
    });
    expect(database.select).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
    expect(gateway.retrieveRefund).not.toHaveBeenCalled();
  });

  it('retrieves and stages complete provider evidence before opening the purchase transaction', async () => {
    const trace: string[] = [];
    const database = routingDatabase(trace);
    vi.mocked(stageBalanceTransaction).mockImplementation(async () => {
      trace.push('stage.balance');
      return { balanceTransactionId: balanceId, disposition: 'inserted' };
    });

    await expect(reconcileRefundFinancialSource(database, gateway(trace), {
      refundId, correlationId: 'refund-trace'
    }, new AbortController().signal)).rejects.toThrow('projection-stop');
    expect(trace).toEqual([
      'provider.refund', 'provider.payment', 'provider.charge', 'provider.balance',
      'stage.balance', 'tx.begin'
    ]);
  });

  it('keeps an independently staged transaction but aborts before purchase projection', async () => {
    const trace: string[] = [];
    const controller = new AbortController();
    const database = routingDatabase(trace);
    vi.mocked(stageBalanceTransaction).mockImplementation(async () => {
      trace.push('stage.balance');
      controller.abort();
      return { balanceTransactionId: balanceId, disposition: 'inserted' };
    });

    await expect(reconcileRefundFinancialSource(database, gateway(trace), {
      refundId, correlationId: 'refund-abort'
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(stageBalanceTransaction).toHaveBeenCalledOnce();
  });

  it('records malformed canonical provider evidence as a durable refund exception', async () => {
    const database = routingDatabase([]);
    const transaction = prepareRefundIssueTransaction(database);
    const provider = gateway([]);
    vi.mocked(provider.retrieveRefund).mockResolvedValue({
      providerRefundId: 're_refund_trace', paymentIntentId: 'pi_refund_trace',
      liveMode: false, state: 'succeeded', amountMinor: 100, currency: 'usd', reason: null,
      providerCreatedAt: createdAt, balanceTransactionId: 'txn_refund_trace',
      failureBalanceTransactionId: null, privateProviderMessage: 'must not escape'
    } as never);

    await expect(reconcileRefundFinancialSource(database, provider, {
      refundId, correlationId: 'refund-malformed-provider'
    }, new AbortController().signal)).resolves.toEqual({
      status: 'exception', sourceKind: 'refund', sourceId: refundId,
      financialEvidenceStatus: 'exception', safeCode: 'unsupported_category', issueId
    });

    expect(lockOrder).toHaveBeenCalledWith(transaction, orderId);
    expect(observeFinancialIssue).toHaveBeenCalledWith(transaction, {
      resourceType: 'refund', resourceId: refundId, safeCode: 'unsupported_category',
      impact: 'exception', actor: { type: 'system', id: 'financial-worker' },
      correlationId: 'refund-malformed-provider'
    });
    expect(stageBalanceTransaction).not.toHaveBeenCalled();
  });

  it('preserves a staged ledger collision and records the refund source exception', async () => {
    const database = routingDatabase([]);
    const transaction = prepareRefundIssueTransaction(database);
    vi.mocked(stageBalanceTransaction).mockRejectedValueOnce(
      new PermanentFinancialError('immutable_mismatch')
    );

    await expect(reconcileRefundFinancialSource(database, gateway([]), {
      refundId, correlationId: 'refund-ledger-collision'
    }, new AbortController().signal)).resolves.toEqual({
      status: 'exception', sourceKind: 'refund', sourceId: refundId,
      financialEvidenceStatus: 'exception', safeCode: 'immutable_mismatch', issueId
    });

    expect(stageBalanceTransaction).toHaveBeenCalledOnce();
    expect(observeFinancialIssue).toHaveBeenCalledWith(transaction, expect.objectContaining({
      resourceType: 'refund', resourceId: refundId,
      safeCode: 'immutable_mismatch', impact: 'exception'
    }));
  });

  it('records a zero-transaction refund as durable pending evidence', async () => {
    const database = routingDatabase([]);
    const transaction = prepareRefundIssueTransaction(database);
    const provider = gateway([]);
    vi.mocked(provider.retrieveRefund).mockResolvedValue({
      providerRefundId: 're_refund_trace', paymentIntentId: 'pi_refund_trace',
      liveMode: false, state: 'pending', amountMinor: 100, currency: 'usd', reason: null,
      providerCreatedAt: createdAt, balanceTransactionId: null,
      failureBalanceTransactionId: null
    });

    await expect(reconcileRefundFinancialSource(database, provider, {
      refundId, correlationId: 'refund-zero-transactions'
    }, new AbortController().signal)).resolves.toEqual({
      status: 'pending', sourceKind: 'refund', sourceId: refundId,
      financialEvidenceStatus: 'pending', safeCode: 'missing_source', issueId
    });

    expect(stageBalanceTransaction).not.toHaveBeenCalled();
    expect(observeFinancialIssue).toHaveBeenCalledWith(transaction, expect.objectContaining({
      resourceType: 'refund', resourceId: refundId,
      safeCode: 'missing_source', impact: 'pending'
    }));
  });

  it('revalidates the canonical purchase and locks the full payout member closure before recompute', async () => {
    const balance = canonicalBalance({ amountMinor: -100, feeMinor: 0, netMinor: -100 });
    const closureMemberId = '00000000-0000-4000-8000-000000000208';
    const payoutId = '00000000-0000-4000-8000-000000000209';
    const transaction = projectionTransaction({
      balances: [balance],
      history: [{
        refundId,
        providerCreatedAt: createdAt,
        refundStatus: 'succeeded',
        allocationStatus: 'finalized',
        refundAllocationId: allocationId,
        orderItemId: itemId,
        subtotalMinor: 80,
        taxMinor: 20,
        currency: 'USD'
      }]
    });
    const localRefund = {
      id: refundId, paymentId, stripeRefundId: 're_refund_trace', status: 'succeeded',
      amountMinor: 100, currency: 'USD', reason: null, providerCreatedAt: createdAt,
      allocationStatus: 'finalized', financialEvidenceStatus: 'pending'
    };
    const facts = {
      order: { id: orderId },
      payment: { id: paymentId, orderId },
      refunds: [localRefund],
      refundAllocations: [{ id: allocationId, refundId, orderItemId: itemId, amountMinor: 100 }],
      refundComponents: [{
        refundAllocationId: allocationId, refundId, orderItemId: itemId,
        subtotalMinor: 80, taxMinor: 20, totalMinor: 100, currency: 'USD'
      }],
      orderItems: [{
        id: itemId, unitSubtotalMinor: 400, taxMinor: 100, totalMinor: 500, currency: 'USD'
      }],
      refundDrafts: [], refundDraftItems: [], correctionSets: [], correctionItems: [],
      disputes: [], disputeItemAllocations: []
    };
    vi.mocked(lockCanonicalPaymentPurchaseFacts).mockResolvedValue(facts as never);
    vi.mocked(lockFinancialProjectionRows).mockResolvedValue({
      payouts: [{ id: payoutId, financialGeneration: 7 }],
      balanceTransactions: [
        { id: balanceId, fingerprintSha256: fingerprint },
        { id: closureMemberId, fingerprintSha256: 'b'.repeat(64) }
      ],
      memberships: [{ payoutId, balanceTransactionId: balanceId },
        { payoutId, balanceTransactionId: closureMemberId }],
      classifications: [{ id: 'classification', subjectType: 'balance_transaction',
        subjectId: balanceId, classifierVersion: 1, sourceFingerprintSha256: fingerprint,
        classification: 'refund' }],
      feeDetailIds: [], allocationSetIds: [], issueIds: []
    });
    vi.mocked(stageBalanceTransaction).mockResolvedValue({
      balanceTransactionId: balanceId, disposition: 'inserted'
    });
    let persistedIndex = 0;
    vi.mocked(persistFinancialAllocationPlanLocked).mockImplementation(async () => ({
      setId: `00000000-0000-4000-8000-${String(600 + persistedIndex++).padStart(12, '0')}`,
      disposition: 'inserted'
    }));
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue(completeProjections([balance]));
    const baseGateway = gateway([]);
    vi.mocked(baseGateway.retrieveRefund).mockResolvedValue({
      providerRefundId: 're_refund_trace', paymentIntentId: 'pi_refund_trace',
      liveMode: false, state: 'succeeded', amountMinor: 100, currency: 'usd', reason: null,
      providerCreatedAt: createdAt, balanceTransactionId: 'txn_refund_trace',
      failureBalanceTransactionId: null
    });
    const limit = vi.fn().mockResolvedValue([{
      id: refundId, stripeRefundId: 're_refund_trace', paymentId, orderId,
      stripePaymentIntentId: 'pi_refund_trace'
    }]);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ innerJoin, where }));
    const from = vi.fn(() => ({ innerJoin }));
    const database = {
      select: vi.fn(() => ({ from })),
      execute: vi.fn(async () => ({ rows: [
        { payoutId, expectedGeneration: 7, balanceTransactionId: balanceId },
        { payoutId, expectedGeneration: 7, balanceTransactionId: closureMemberId }
      ] })),
      transaction: vi.fn(async (work: (tx: DatabaseTransaction) => Promise<unknown>) => work(transaction))
    } as unknown as Database;

    await expect(reconcileRefundFinancialSource(database, baseGateway, {
      refundId, correlationId: 'refund-closure'
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'reconciled', sourceKind: 'refund', sourceId: refundId,
      financialEvidenceStatus: 'fee_reconciled'
    });

    expect(lockCanonicalPaymentPurchaseFacts).toHaveBeenCalledWith(transaction, expect.objectContaining({
      paymentId, orderId,
      payment: expect.objectContaining({ paymentIntentId: 'pi_refund_trace' }),
      charge: expect.objectContaining({ id: 'ch_refund_trace' })
    }));
    expect(lockFinancialProjectionRows).toHaveBeenCalledWith(transaction, {
      payoutGenerations: [{ payoutId, expectedGeneration: 7 }],
      balanceTransactionIds: [balanceId, closureMemberId].sort(),
      classifierVersion: 1,
      issueKeys: expect.arrayContaining([
        { resourceType: 'refund', resourceId: refundId, safeCode: 'allocation_incomplete' }
      ])
    });
  });
});

describe('recomputeLockedRefundFinancialProjection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveFinancialIssueAfterRecompute).mockResolvedValue(null);
    let persistedIndex = 0;
    vi.mocked(persistFinancialAllocationPlanLocked).mockImplementation(async () => ({
      setId: `00000000-0000-4000-8000-${String(400 + persistedIndex++).padStart(12, '0')}`,
      disposition: 'inserted'
    }));
  });

  it('rejects malformed locked facts before issuing projection queries', async () => {
    const transaction = { execute: vi.fn() } as unknown as import('$lib/server/db/transaction').DatabaseTransaction;

    await expect(recomputeLockedRefundFinancialProjection(transaction, {
      refundId: 'not-a-uuid'
    } as never)).rejects.toMatchObject({
      name: 'PermanentFinancialError', safeCode: 'invalid_job_payload'
    });
    expect(transaction.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['extra outer key', { ...lockedInput(), providerObject: {} }],
    ['inherited outer facts', Object.assign(Object.create(lockedInput()) as object, {})],
    ['extra item key', { ...lockedInput(), orderItems: [{ ...lockedInput().orderItems[0]!, extra: true }] }],
    ['inherited component fields', { ...lockedInput(), refundComponents: [
      Object.assign(Object.create(lockedInput().refundComponents[0]!) as object, {})
    ] }],
    ['duplicate finalized item attribution', {
      ...lockedInput(),
      finalizedAllocations: [
        lockedInput().finalizedAllocations[0]!,
        { id: '00000000-0000-4000-8000-000000000210', orderItemId: itemId, amountMinor: 1 }
      ],
      refundComponents: [
        lockedInput().refundComponents[0]!,
        { refundAllocationId: '00000000-0000-4000-8000-000000000210', orderItemId: itemId,
          subtotalMinor: 1, taxMinor: 0, currency: 'USD' }
      ]
    }],
    ['duplicate balance id', { ...lockedInput(), balanceTransactionIds: [balanceId, balanceId] }]
  ])('strictly rejects %s before projection SQL', async (_label, candidate) => {
    const transaction = { execute: vi.fn() } as unknown as DatabaseTransaction;

    await expect(recomputeLockedRefundFinancialProjection(
      transaction,
      candidate as LockedRefundProjectionInput
    )).rejects.toMatchObject({
      name: 'PermanentFinancialError', safeCode: 'invalid_job_payload'
    });
    expect(transaction.execute).not.toHaveBeenCalled();
    expect(persistFinancialAllocationPlanLocked).not.toHaveBeenCalled();
  });

  it('persists finalized presentment subtotal/tax and settlement fee projections', async () => {
    const balance = canonicalBalance();
    const transaction = projectionTransaction({
      balances: [balance],
      history: [{
        refundId,
        providerCreatedAt: createdAt,
        refundStatus: 'succeeded',
        allocationStatus: 'finalized',
        refundAllocationId: allocationId,
        orderItemId: itemId,
        subtotalMinor: 400,
        taxMinor: 100,
        currency: 'USD'
      }],
      feeDetails: { [balanceId]: [{ amountMinor: 10, classification: 'refund_fee' }] }
    });
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue(
      completeProjections([balance])
    );

    await expect(recomputeLockedRefundFinancialProjection(
      transaction,
      lockedInput()
    )).resolves.toMatchObject({
      status: 'reconciled',
      refundId,
      financialEvidenceStatus: 'fee_reconciled',
      allocationSetIds: [expect.any(String), expect.any(String)]
    });

    const [gross, fee] = persistedPlans();
    expect(gross).toMatchObject({ basis: 'gross_amount', scope: 'title', expectedEffectMinor: -500 });
    expect(gross?.items.map(({ component, effectMinor }) => ({ component, effectMinor }))).toEqual([
      { component: 'refund_subtotal', effectMinor: -400 },
      { component: 'refund_tax', effectMinor: -100 }
    ]);
    expect(fee).toMatchObject({ basis: 'fee', scope: 'title', expectedEffectMinor: -10 });
    expect(fee?.items).toEqual([expect.objectContaining({
      orderItemId: itemId, component: 'refund_fee', effectMinor: -10
    })]);
    expect(observeFinancialIssue).not.toHaveBeenCalled();
  });

  it('persists unresolved succeeded evidence and records expected ambiguity as pending', async () => {
    const balance = canonicalBalance({ feeMinor: 0, netMinor: -500 });
    const transaction = projectionTransaction({ balances: [balance], history: [] });
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue([
      { status: 'missing', balanceTransactionId: balanceId, basis: 'gross_amount',
        safeCode: 'allocation_incomplete' },
      { status: 'missing', balanceTransactionId: balanceId, basis: 'fee',
        safeCode: 'allocation_incomplete' }
    ]);
    vi.mocked(observeFinancialIssue).mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000501'
    } as Awaited<ReturnType<typeof observeFinancialIssue>>);

    await expect(recomputeLockedRefundFinancialProjection(transaction, lockedInput({
      allocationStatus: 'needs_review',
      finalizedAllocations: [],
      refundComponents: []
    }))).resolves.toEqual({
      status: 'pending',
      refundId,
      financialEvidenceStatus: 'pending',
      safeCode: 'allocation_incomplete',
      issueId: '00000000-0000-4000-8000-000000000501'
    });

    expect(persistedPlans().map((plan) => ({ basis: plan.basis, scope: plan.scope, items: plan.items })))
      .toEqual([
        { basis: 'gross_amount', scope: 'unresolved', items: [] },
        { basis: 'fee', scope: 'unresolved', items: [] }
      ]);
    expect(observeFinancialIssue).toHaveBeenCalledWith(transaction, expect.objectContaining({
      resourceType: 'refund', resourceId: refundId,
      safeCode: 'allocation_incomplete', impact: 'pending'
    }));
  });

  it('records exact account-scoped principal cancellation for an unallocated failed refund', async () => {
    const original = canonicalBalance({ feeMinor: 10, netMinor: -510 });
    const reversal = canonicalBalance({
      id: failureBalanceId,
      providerId: 'txn_refund_failure_trace',
      amountMinor: 500,
      feeMinor: 5,
      netMinor: 495,
      providerCreatedAt: new Date('2026-08-11T00:00:00.000Z'),
      classification: 'refund_failure'
    });
    const transaction = projectionTransaction({
      balances: [original, reversal],
      history: [],
      feeDetails: {
        [balanceId]: [{ amountMinor: 10, classification: 'refund_fee' }],
        [failureBalanceId]: [{ amountMinor: 5, classification: 'refund_fee' }]
      }
    });
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue(
      completeProjections([original, reversal])
    );

    await expect(recomputeLockedRefundFinancialProjection(transaction, lockedInput({
      providerStatus: 'failed',
      allocationStatus: 'not_applicable',
      balanceTransactionIds: [balanceId, failureBalanceId],
      finalizedAllocations: [],
      refundComponents: []
    }))).resolves.toMatchObject({ status: 'reconciled', financialEvidenceStatus: 'fee_reconciled' });

    const [originalGross, originalFee, reversalGross, reversalFee] = persistedPlans();
    expect(originalGross).toMatchObject({
      balanceTransactionId: balanceId, basis: 'gross_amount', scope: 'account',
      expectedEffectMinor: -500, items: []
    });
    expect(originalFee).toMatchObject({
      balanceTransactionId: balanceId, basis: 'fee', scope: 'title', expectedEffectMinor: -10
    });
    expect(reversalGross).toMatchObject({
      balanceTransactionId: failureBalanceId, basis: 'gross_amount', scope: 'account',
      expectedEffectMinor: 500,
      reversalOfSetId: '00000000-0000-4000-8000-000000000400',
      items: []
    });
    expect(reversalFee).toMatchObject({
      balanceTransactionId: failureBalanceId, basis: 'fee', scope: 'title', expectedEffectMinor: -5,
      reversalOfSetId: null
    });
  });

  it('conserves a provider-adjusted partial reversal from finalized title attribution', async () => {
    const original = canonicalBalance({ feeMinor: 0, netMinor: -500 });
    const reversal = canonicalBalance({
      id: failureBalanceId,
      providerId: 'txn_refund_failure_partial_trace',
      amountMinor: 400,
      feeMinor: 0,
      netMinor: 400,
      providerCreatedAt: new Date('2026-08-11T00:00:00.000Z'),
      classification: 'refund_failure'
    });
    const transaction = projectionTransaction({
      balances: [original, reversal],
      history: [{
        refundId,
        providerCreatedAt: createdAt,
        refundStatus: 'failed',
        allocationStatus: 'finalized',
        refundAllocationId: allocationId,
        orderItemId: itemId,
        subtotalMinor: 400,
        taxMinor: 100,
        currency: 'USD'
      }]
    });
    const projections = completeProjections([original, reversal]);
    const failureGross = projections[2];
    if (!failureGross || failureGross.status !== 'complete') {
      throw new Error('Expected a complete failed-refund gross projection fixture.');
    }
    projections[2] = {
      ...failureGross,
      scope: 'title',
      items: [
        {
          orderItemId: itemId,
          component: 'refund_subtotal',
          effectMinor: 320,
          currency: 'USD'
        },
        {
          orderItemId: itemId,
          component: 'refund_tax',
          effectMinor: 80,
          currency: 'USD'
        }
      ]
    };
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue(projections);

    await expect(recomputeLockedRefundFinancialProjection(transaction, lockedInput({
      providerStatus: 'failed',
      allocationStatus: 'finalized',
      balanceTransactionIds: [balanceId, failureBalanceId]
    }))).resolves.toMatchObject({
      status: 'reconciled',
      financialEvidenceStatus: 'fee_reconciled'
    });

    const [, , reversalGross] = persistedPlans();
    expect(reversalGross).toMatchObject({
      balanceTransactionId: failureBalanceId,
      basis: 'gross_amount',
      scope: 'title',
      expectedEffectMinor: 400,
      reversalOfSetId: '00000000-0000-4000-8000-000000000400',
      items: [
        expect.objectContaining({
          orderItemId: itemId,
          component: 'refund_subtotal',
          effectMinor: 320,
          currency: 'USD'
        }),
        expect.objectContaining({
          orderItemId: itemId,
          component: 'refund_tax',
          effectMinor: 80,
          currency: 'USD'
        })
      ]
    });
  });

  it('records a residual failed-refund principal as a durable allocation exception', async () => {
    const original = canonicalBalance({ feeMinor: 0, netMinor: -500 });
    const reversal = canonicalBalance({
      id: failureBalanceId,
      providerId: 'txn_refund_failure_trace',
      amountMinor: 499,
      feeMinor: 0,
      netMinor: 499,
      providerCreatedAt: new Date('2026-08-11T00:00:00.000Z'),
      classification: 'refund_failure'
    });
    const transaction = projectionTransaction({ balances: [original, reversal], history: [] });
    vi.mocked(observeFinancialIssue).mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000502'
    } as Awaited<ReturnType<typeof observeFinancialIssue>>);

    await expect(recomputeLockedRefundFinancialProjection(transaction, lockedInput({
      providerStatus: 'failed',
      allocationStatus: 'not_applicable',
      balanceTransactionIds: [balanceId, failureBalanceId],
      finalizedAllocations: [],
      refundComponents: []
    }))).resolves.toMatchObject({
      status: 'exception', financialEvidenceStatus: 'exception',
      safeCode: 'allocation_mismatch', issueId: '00000000-0000-4000-8000-000000000502'
    });
    expect(observeFinancialIssue).toHaveBeenCalledWith(transaction, expect.objectContaining({
      safeCode: 'allocation_mismatch', impact: 'exception'
    }));
  });
});
