import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type {
  BalanceTransactionSnapshot,
  StripeCommerceGateway
} from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { lockOrder } from '$lib/server/commerce/lock';
import { lockPaymentPurchaseFacts } from '$lib/server/commerce/reconciliation';
import { lockCanonicalPaymentPurchaseFacts } from './payment';
import {
  loadCurrentEffectiveAllocationProjection,
  persistFinancialAllocationPlanLocked,
  persistFinancialAllocationReplayPlanLocked
} from '../allocations/repository';
import { observeFinancialIssue, resolveFinancialIssueAfterRecompute } from '../issues';
import {
  lockActiveFinancialProjectionImplementation,
  lockFinancialProjectionRows
} from '../locks';
import {
  rearmCurrentProjectionSubjectsForFinancialSources,
  stageBalanceTransaction
} from '../ledger';
import { lockFinancialProjectionEnrollment } from '../rebase';
import { PermanentFinancialError } from '../errors';
import type {
  CurrentEffectiveAllocationProjection,
  FinancialAllocationPlan,
  LockedRefundProjectionInput
} from '../types';
import {
  recomputeLockedRefundFinancialProjection,
  recomputeLockedRefundFinancialProjectionForVersion,
  reconcileRefundFinancialSource
} from './refund';
import * as refundSource from './refund';

vi.mock('../ledger', () => ({
  rearmCurrentProjectionSubjectsForFinancialSources: vi.fn(),
  stageBalanceTransaction: vi.fn()
}));
vi.mock('../rebase', () => ({ lockFinancialProjectionEnrollment: vi.fn() }));
vi.mock('./payment', () => ({ lockCanonicalPaymentPurchaseFacts: vi.fn() }));
vi.mock('$lib/server/commerce/lock', () => ({ lockOrder: vi.fn() }));
vi.mock('$lib/server/commerce/reconciliation', () => ({ lockPaymentPurchaseFacts: vi.fn() }));
vi.mock('../locks', () => ({
  lockActiveFinancialProjectionImplementation: vi.fn(),
  lockFinancialProjectionRows: vi.fn()
}));
vi.mock('../allocations/repository', () => ({
  loadCurrentEffectiveAllocationProjection: vi.fn(),
  persistFinancialAllocationPlanLocked: vi.fn(),
  persistFinancialAllocationReplayPlanLocked: vi.fn()
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
const selectedGrossSetId = '00000000-0000-4000-8000-000000000215';
const selectedFeeSetId = '00000000-0000-4000-8000-000000000216';
const createdAt = new Date('2026-08-10T00:00:00.000Z');
const fingerprint = 'a'.repeat(64);
const dialect = new PgDialect();

describe('versioned locked refund projection replay', () => {
  it('exports a provider-free explicit-version replay seam', () => {
    expect(refundSource).toHaveProperty('recomputeLockedRefundFinancialProjectionForVersion');
  });
});

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
  readonly incompleteEarlierDisputes?: readonly Record<string, unknown>[];
  readonly feeDetails?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly currentSets?: readonly Record<string, unknown>[];
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
      if (rendered.sql.includes('from stripe_balance_transactions dispute_balance')) {
        return { rows: input.incompleteEarlierDisputes ?? [] };
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
      if (rendered.sql.includes('from financial_allocation_sets allocation')) {
        const currentSets = input.currentSets ?? [];
        return { rows: rendered.sql.includes("allocation.source_kind = 'refund'")
          ? currentSets.filter((set) => set.sourceKind === 'refund' && set.sourceId === refundId)
          : currentSets };
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
  const replayCalls = vi.mocked(persistFinancialAllocationReplayPlanLocked).mock.calls;
  const calls = replayCalls.length > 0
    ? replayCalls.map((call) => call[1])
    : vi.mocked(persistFinancialAllocationPlanLocked).mock.calls.map((call) => call[1]);
  return calls.map((call) => call.plan);
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

type RefundFxBalance = Pick<
  BalanceTransactionSnapshot,
  'currency' | 'exchangeRate' | 'exchangeSourceCurrency' | 'exchangeTargetCurrency'
>;

const USD_WITHOUT_EXCHANGE: RefundFxBalance = {
  currency: 'USD', exchangeRate: null,
  exchangeSourceCurrency: null, exchangeTargetCurrency: null
};
const EUR_TO_USD: RefundFxBalance = {
  currency: 'USD', exchangeRate: '1.250000000000000000',
  exchangeSourceCurrency: 'EUR', exchangeTargetCurrency: 'USD'
};

function refundFxGateway(
  trace: string[],
  sourceCurrency: string,
  primary: RefundFxBalance,
  failure: RefundFxBalance,
  settlementAmountMinor = 100
): StripeCommerceGateway {
  const provider = gateway(trace);
  vi.mocked(provider.retrieveRefund).mockImplementation(async () => {
    trace.push('provider.refund');
    return {
      providerRefundId: 're_refund_trace', paymentIntentId: 'pi_refund_trace',
      liveMode: false, state: 'failed', amountMinor: 100,
      currency: sourceCurrency.toLowerCase(), reason: null, providerCreatedAt: createdAt,
      balanceTransactionId: 'txn_refund_trace',
      failureBalanceTransactionId: 'txn_refund_failure_trace'
    };
  });
  vi.mocked(provider.retrievePayment).mockImplementation(async () => {
    trace.push('provider.payment');
    return {
      paymentIntentId: 'pi_refund_trace', metadataVersion: '1', metadataOrderId: orderId,
      latestChargeId: 'ch_refund_trace', liveMode: false, state: 'succeeded', amountMinor: 1000,
      currency: sourceCurrency.toLowerCase(), paidAt: createdAt, paymentMethodCategory: 'card'
    };
  });
  vi.mocked(provider.retrieveCharge).mockImplementation(async () => {
    trace.push('provider.charge');
    return {
      id: 'ch_refund_trace', paymentIntentId: 'pi_refund_trace', livemode: false,
      amountMinor: 1000, amountRefundedMinor: 100, currency: sourceCurrency.toUpperCase(),
      status: 'succeeded', balanceTransactionId: 'txn_charge_trace', createdAt
    };
  });
  vi.mocked(provider.retrieveBalanceTransaction).mockImplementation(async (id) => {
    trace.push(`provider.balance.${id}`);
    const isFailure = id === 'txn_refund_failure_trace';
    const evidence = isFailure ? failure : primary;
    const amountMinor = isFailure ? settlementAmountMinor : -settlementAmountMinor;
    return {
      id, livemode: false, sourceId: 're_refund_trace', sourceFamily: 'refund',
      rawType: isFailure ? 'refund_failure' : 'refund',
      reportingCategory: isFailure ? 'refund_failure' : 'refund',
      amountMinor, feeMinor: 0, netMinor: amountMinor, currency: evidence.currency,
      status: 'available', balanceType: 'payments', createdAt, availableAt: createdAt,
      exchangeRate: evidence.exchangeRate,
      exchangeSourceCurrency: evidence.exchangeSourceCurrency,
      exchangeTargetCurrency: evidence.exchangeTargetCurrency,
      feeDetails: []
    };
  });
  return provider;
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

  it.each([
    {
      label: 'a cross-currency primary without exchange evidence',
      primary: USD_WITHOUT_EXCHANGE,
      failure: EUR_TO_USD,
      expectedSafeCode: 'currency_mismatch'
    },
    {
      label: 'a cross-currency failure without exchange evidence',
      primary: EUR_TO_USD,
      failure: USD_WITHOUT_EXCHANGE,
      expectedSafeCode: 'currency_mismatch'
    },
    {
      label: 'a primary whose exchange source is not the refund currency',
      primary: { ...EUR_TO_USD, exchangeSourceCurrency: 'GBP' },
      failure: EUR_TO_USD,
      expectedSafeCode: 'currency_mismatch'
    },
    {
      label: 'a failure whose exchange target is not its settlement currency',
      primary: EUR_TO_USD,
      failure: { ...EUR_TO_USD, exchangeTargetCurrency: 'GBP' },
      expectedSafeCode: 'unsupported_category'
    }
  ])('rejects $label before staging', async ({ primary, failure, expectedSafeCode }) => {
    const database = routingDatabase([]);
    prepareRefundIssueTransaction(database);
    const provider = refundFxGateway([], 'EUR', primary, failure);

    await expect(reconcileRefundFinancialSource(database, provider, {
      refundId, correlationId: `refund-fx-${expectedSafeCode}`
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'exception', sourceKind: 'refund', sourceId: refundId,
      financialEvidenceStatus: 'exception', safeCode: expectedSafeCode
    });

    expect(stageBalanceTransaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'same-currency primary and failure transactions without exchange evidence',
      sourceCurrency: 'USD', primary: USD_WITHOUT_EXCHANGE, failure: USD_WITHOUT_EXCHANGE
    },
    {
      label: 'primary and failure transactions with exact cross-currency evidence',
      sourceCurrency: 'EUR', primary: EUR_TO_USD, failure: EUR_TO_USD
    }
  ])('admits $label', async ({ sourceCurrency, primary, failure }) => {
    const database = routingDatabase([]);
    vi.mocked(stageBalanceTransaction).mockImplementation(async (_database, snapshot) => ({
      balanceTransactionId: snapshot.id === 'txn_refund_trace' ? balanceId : failureBalanceId,
      disposition: 'inserted'
    }));

    await expect(reconcileRefundFinancialSource(
      database,
      refundFxGateway([], sourceCurrency, primary, failure),
      { refundId, correlationId: `refund-fx-valid-${sourceCurrency}` },
      new AbortController().signal
    )).rejects.toThrow('projection-stop');

    expect(stageBalanceTransaction).toHaveBeenCalledTimes(2);
  });

  it('rejects a conserved failed-refund pair that differs from its same-currency amount', async () => {
    const database = routingDatabase([]);
    prepareRefundIssueTransaction(database);
    const provider = refundFxGateway(
      [],
      'USD',
      USD_WITHOUT_EXCHANGE,
      USD_WITHOUT_EXCHANGE,
      90
    );
    vi.mocked(stageBalanceTransaction).mockImplementation(async (_database, snapshot) => ({
      balanceTransactionId: snapshot.id === 'txn_refund_trace' ? balanceId : failureBalanceId,
      disposition: 'inserted'
    }));
    vi.mocked(lockCanonicalPaymentPurchaseFacts).mockRejectedValueOnce(
      new Error('projection-stop-after-mismatched-refund-staging')
    );

    try {
      await expect(reconcileRefundFinancialSource(database, provider, {
        refundId,
        correlationId: 'refund-same-currency-amount-mismatch'
      }, new AbortController().signal)).resolves.toMatchObject({
        status: 'exception',
        sourceKind: 'refund',
        sourceId: refundId,
        financialEvidenceStatus: 'exception',
        safeCode: 'immutable_mismatch'
      });

      expect(stageBalanceTransaction).not.toHaveBeenCalled();
    } finally {
      vi.mocked(lockCanonicalPaymentPurchaseFacts).mockReset();
    }
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
        providerRefundId: 're_refund_trace',
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

    expect(lockActiveFinancialProjectionImplementation).toHaveBeenCalledWith(transaction, {
      classifierVersion: 1,
      allocationAlgorithmVersion: 1
    });
    expect(lockCanonicalPaymentPurchaseFacts).toHaveBeenCalledWith(transaction, expect.objectContaining({
      paymentId, orderId,
      payment: expect.objectContaining({ paymentIntentId: 'pi_refund_trace' }),
      charge: expect.objectContaining({ id: 'ch_refund_trace' })
    }));
    expect(vi.mocked(lockActiveFinancialProjectionImplementation).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(lockCanonicalPaymentPurchaseFacts).mock.invocationCallOrder[0]!);
    expect(lockFinancialProjectionEnrollment).toHaveBeenCalledWith(transaction);
    expect(vi.mocked(lockCanonicalPaymentPurchaseFacts).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(lockFinancialProjectionEnrollment).mock.invocationCallOrder[0]!);
    expect(vi.mocked(lockFinancialProjectionEnrollment).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(transaction.execute).mock.invocationCallOrder[0]!);
    expect(vi.mocked(lockFinancialProjectionEnrollment).mock.invocationCallOrder[0])
      .toBeLessThan(
        vi.mocked(persistFinancialAllocationReplayPlanLocked).mock.invocationCallOrder[0]!
      );
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
    vi.mocked(persistFinancialAllocationReplayPlanLocked).mockImplementation(async () => ({
      setId: `00000000-0000-4000-8000-${String(500 + persistedIndex++).padStart(12, '0')}`,
      disposition: 'inserted'
    }));
  });

  it('rebuilds locked immutable refund facts for an explicit pair without source status side effects', async () => {
    const balance = canonicalBalance();
    const transaction = projectionTransaction({
      balances: [balance],
      history: [{
        refundId,
        providerRefundId: 're_refund_trace',
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

    await expect(recomputeLockedRefundFinancialProjectionForVersion(
      transaction,
      lockedInput(),
      { classifierVersion: 2, allocationAlgorithmVersion: 3, replayId: 'c2-a3' }
    )).resolves.toEqual({
      status: 'replayed',
      refundId,
      replacements: [
        expect.objectContaining({
          balanceTransactionId: balanceId,
          basis: 'gross_amount',
          previousSetId: null,
          replacementSetId: expect.any(String),
          sourceFingerprint: fingerprint,
          disposition: 'inserted'
        }),
        expect.objectContaining({
          balanceTransactionId: balanceId,
          basis: 'fee',
          previousSetId: null,
          replacementSetId: expect.any(String),
          sourceFingerprint: fingerprint,
          disposition: 'inserted'
        })
      ]
    });

    expect(persistFinancialAllocationPlanLocked).not.toHaveBeenCalled();
    expect(persistFinancialAllocationReplayPlanLocked).toHaveBeenCalledTimes(2);
    for (const [, persistInput, authorized] of
      vi.mocked(persistFinancialAllocationReplayPlanLocked).mock.calls) {
      expect(authorized).toEqual({ classifierVersion: 2, allocationAlgorithmVersion: 3 });
      expect(persistInput.classificationVersion).toBe(2);
      expect(persistInput.plan.algorithmVersion).toBe(3);
      expect(persistInput.plan.allocationIdentity).toContain(':replay:c2-a3:');
    }
    expect(loadCurrentEffectiveAllocationProjection).not.toHaveBeenCalled();
    expect(transaction.update).not.toHaveBeenCalled();
    const disputeHistoryQuery = vi.mocked(transaction.execute).mock.calls
      .map(([query]) => dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]))
      .find((query) => query.sql.includes('from dispute_item_allocations allocation'));
    expect(disputeHistoryQuery?.sql).toMatch(
      /allocation_set\.classifier_version\s*=\s*\$\d+[\s\S]*allocation_set\.algorithm_version\s*=\s*\$\d+/u
    );
    expect(disputeHistoryQuery?.sql).toMatch(
      /successor\.classifier_version\s*=\s*allocation_set\.classifier_version[\s\S]*successor\.algorithm_version\s*=\s*allocation_set\.algorithm_version/u
    );
    expect(disputeHistoryQuery?.sql).toMatch(
      /join financial_classification_versions decision[\s\S]*decision\.classification = 'dispute_withdrawal'[\s\S]*allocation\.effect = 'withdrawal'[\s\S]*decision\.classification = 'dispute_reinstatement'[\s\S]*allocation\.effect = 'reinstatement'/iu
    );
    expect(disputeHistoryQuery?.params).toEqual(expect.arrayContaining([2, 3]));
    const storedPlanQuery = vi.mocked(transaction.execute).mock.calls
      .map(([query]) => dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]))
      .find((query) => query.sql.includes('allocation.allocation_identity') &&
        query.sql.includes('from financial_allocation_sets allocation'));
    expect(storedPlanQuery?.sql).toMatch(
      /allocation\.classifier_version\s*=\s*\$\d+[\s\S]*allocation\.algorithm_version\s*=\s*\$\d+/u
    );
    expect(storedPlanQuery?.sql).toMatch(
      /successor\.classifier_version\s*=\s*allocation\.classifier_version[\s\S]*successor\.algorithm_version\s*=\s*allocation\.algorithm_version/u
    );
    expect(storedPlanQuery?.params).toEqual(expect.arrayContaining([2, 3]));
  });

  it('blocks a target refund replay until every earlier dispute has target exposure membership', async () => {
    const balance = canonicalBalance();
    const earlierDisputeBalanceId = '00000000-0000-4000-8000-000000000214';
    const transaction = projectionTransaction({
      balances: [balance],
      history: [{
        refundId,
        providerRefundId: 're_refund_trace',
        providerCreatedAt: createdAt,
        refundStatus: 'succeeded',
        allocationStatus: 'finalized',
        refundAllocationId: allocationId,
        orderItemId: itemId,
        subtotalMinor: 400,
        taxMinor: 100,
        currency: 'USD'
      }],
      incompleteEarlierDisputes: [{ balanceTransactionId: earlierDisputeBalanceId }],
      feeDetails: { [balanceId]: [{ amountMinor: 10, classification: 'refund_fee' }] }
    });

    await expect(recomputeLockedRefundFinancialProjectionForVersion(
      transaction,
      lockedInput(),
      { classifierVersion: 2, allocationAlgorithmVersion: 3, replayId: 'c2-a3' }
    )).resolves.toEqual({
      status: 'exception', refundId, safeCode: 'missing_source', impact: 'pending'
    });

    expect(persistFinancialAllocationReplayPlanLocked).not.toHaveBeenCalled();
    const completenessQuery = vi.mocked(transaction.execute).mock.calls
      .map(([query]) => dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]))
      .find((query) => query.sql.includes('from stripe_balance_transactions dispute_balance'));
    expect(completenessQuery?.sql).toMatch(
      /decision\.classification\s+not\s+in\s*\(\s*'dispute_withdrawal'\s*,\s*'dispute_reinstatement'\s*,\s*'fee_credit'\s*\)/iu
    );
    expect(completenessQuery?.sql).toMatch(
      /not exists\s*\(\s*select 1 from financial_reconciliation_issues exposure_issue[\s\S]*exposure_issue\.resource_type = 'allocation_set'[\s\S]*exposure_issue\.resource_id = valid_exposure_set\.id[\s\S]*exposure_issue\.state = 'open'[\s\S]*exposure_issue\.impact <> 'informational'/iu
    );
    expect(completenessQuery?.sql).toMatch(
      /or exists\s*\(\s*select 1 from financial_reconciliation_issues classification_issue[\s\S]*classification_issue\.resource_type = 'balance_transaction'[\s\S]*classification_issue\.resource_id = dispute_balance\.id[\s\S]*classification_issue\.safe_code = 'classification_fork'[\s\S]*classification_issue\.state = 'open'[\s\S]*classification_issue\.impact = 'exception'/iu
    );
    expect(completenessQuery?.sql).toMatch(
      /select count\(\*\)[\s\S]*from financial_allocation_sets raw_exposure_set[\s\S]*raw_exposure_set\.balance_transaction_id = dispute_balance\.id[\s\S]*raw_exposure_set\.basis = 'gross_amount'[\s\S]*raw_exposure_set\.classifier_version[\s\S]*raw_exposure_set\.algorithm_version[\s\S]*\) <> 1/iu
    );
    expect(completenessQuery?.sql).toMatch(
      /select count\(\*\)[\s\S]*from financial_allocation_sets valid_exposure_set[\s\S]*valid_exposure_set\.source_kind = 'dispute'[\s\S]*valid_exposure_set\.source_internal_id = dispute\.id[\s\S]*\) <> 1/iu
    );
  });

  it('allows an earlier fee credit without dispute presentment exposure', async () => {
    const balance = canonicalBalance();
    const transaction = projectionTransaction({
      balances: [balance],
      history: [{
        refundId,
        providerRefundId: 're_refund_trace',
        providerCreatedAt: createdAt,
        refundStatus: 'succeeded',
        allocationStatus: 'finalized',
        refundAllocationId: allocationId,
        orderItemId: itemId,
        subtotalMinor: 400,
        taxMinor: 100,
        currency: 'USD'
      }],
      incompleteEarlierDisputes: [],
      feeDetails: { [balanceId]: [{ amountMinor: 10, classification: 'refund_fee' }] }
    });

    await expect(recomputeLockedRefundFinancialProjectionForVersion(
      transaction,
      lockedInput(),
      { classifierVersion: 2, allocationAlgorithmVersion: 3, replayId: 'c2-a3' }
    )).resolves.toMatchObject({ status: 'replayed', refundId });

    const completenessQuery = vi.mocked(transaction.execute).mock.calls
      .map(([query]) => dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]))
      .find((query) => query.sql.includes('from stripe_balance_transactions dispute_balance'));
    expect(completenessQuery?.sql).toContain("'fee_credit'");
    expect(completenessQuery?.sql).toMatch(
      /decision\.classification = 'fee_credit'[\s\S]*exists\s*\([\s\S]*from financial_allocation_sets fee_credit_set[\s\S]*join dispute_item_allocations fee_credit_presentment[\s\S]*fee_credit_presentment\.gross_allocation_set_id = fee_credit_set\.id/iu
    );
  });

  it('records incomplete earlier dispute evidence as durable pending in ordinary mode', async () => {
    const balance = canonicalBalance();
    const transaction = projectionTransaction({
      balances: [balance],
      history: [{
        refundId,
        providerRefundId: 're_refund_trace',
        providerCreatedAt: createdAt,
        refundStatus: 'succeeded',
        allocationStatus: 'finalized',
        refundAllocationId: allocationId,
        orderItemId: itemId,
        subtotalMinor: 400,
        taxMinor: 100,
        currency: 'USD'
      }],
      incompleteEarlierDisputes: [{
        balanceTransactionId: '00000000-0000-4000-8000-000000000214'
      }],
      feeDetails: { [balanceId]: [{ amountMinor: 10, classification: 'refund_fee' }] }
    });
    vi.mocked(observeFinancialIssue).mockResolvedValue({ id: issueId } as never);

    await expect(recomputeLockedRefundFinancialProjection(
      transaction,
      lockedInput()
    )).resolves.toEqual({
      status: 'pending', refundId, financialEvidenceStatus: 'pending',
      safeCode: 'missing_source', issueId
    });

    expect(observeFinancialIssue).toHaveBeenCalledWith(transaction, expect.objectContaining({
      resourceType: 'refund', resourceId: refundId,
      safeCode: 'missing_source', impact: 'pending'
    }));
    expect(persistFinancialAllocationPlanLocked).not.toHaveBeenCalled();
  });

  it('overlays every selected ordinary refund tip and rearms classification after rollback', async () => {
    const balance = canonicalBalance();
    const transaction = projectionTransaction({
      balances: [balance],
      history: [{
        refundId,
        providerRefundId: 're_refund_trace',
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
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue([
      { status: 'exception', balanceTransactionId: balanceId,
        basis: 'gross_amount', safeCode: 'allocation_fork' },
      { status: 'complete', balanceTransactionId: balanceId, basis: 'fee',
        baseSetId: selectedFeeSetId, scope: 'title', currency: 'USD',
        expectedEffectMinor: -10, items: [] }
    ] as never);
    vi.mocked(observeFinancialIssue).mockResolvedValue({ id: issueId } as never);

    await expect(recomputeLockedRefundFinancialProjection(
      transaction,
      lockedInput(),
      [selectedGrossSetId, selectedFeeSetId]
    )).resolves.toMatchObject({
      status: 'exception', refundId, safeCode: 'allocation_fork', issueId
    });

    for (const resourceId of [selectedGrossSetId, selectedFeeSetId]) {
      expect(observeFinancialIssue).toHaveBeenCalledWith(transaction, expect.objectContaining({
        resourceType: 'allocation_set', resourceId,
        safeCode: 'allocation_fork', impact: 'exception'
      }));
    }
    expect(rearmCurrentProjectionSubjectsForFinancialSources).toHaveBeenCalledWith(
      transaction,
      { sourceKind: 'refund', sourceIds: [refundId] }
    );
  });

  it('rolls back a premature set-issue resolution and increments the same open issue on retry', async () => {
    const balance = canonicalBalance();
    const transaction = projectionTransaction({
      balances: [balance],
      history: [{
        refundId,
        providerRefundId: 're_refund_trace',
        providerCreatedAt: createdAt,
        refundStatus: 'succeeded',
        allocationStatus: 'finalized',
        refundAllocationId: allocationId,
        orderItemId: itemId,
        subtotalMinor: 400,
        taxMinor: 100,
        currency: 'USD'
      }],
      feeDetails: { [balanceId]: [{ amountMinor: 10, classification: 'refund_fee' }] },
      currentSets: [
        {
          id: selectedGrossSetId, allocationIdentity: 'selected-old-gross',
          balanceTransactionId: balanceId, sourceKind: 'refund', sourceId: refundId,
          basis: 'gross_amount', scope: 'title', currency: 'USD',
          expectedEffectMinor: -500, classifierVersion: 1, algorithmVersion: 1,
          sourceFingerprint: fingerprint, supersedesSetId: null, reversalOfSetId: null,
          isTargetTip: true, isGlobalTip: true
        },
        {
          id: selectedFeeSetId, allocationIdentity: 'selected-old-fee',
          balanceTransactionId: balanceId, sourceKind: 'refund', sourceId: refundId,
          basis: 'fee', scope: 'title', currency: 'USD', expectedEffectMinor: -10,
          classifierVersion: 1, algorithmVersion: 1, sourceFingerprint: fingerprint,
          supersedesSetId: null, reversalOfSetId: null,
          isTargetTip: true, isGlobalTip: true
        }
      ]
    });
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue([
      { status: 'missing', balanceTransactionId: balanceId,
        basis: 'gross_amount', safeCode: 'missing_source' },
      { status: 'complete', balanceTransactionId: balanceId, basis: 'fee',
        baseSetId: selectedFeeSetId, scope: 'title', currency: 'USD',
        expectedEffectMinor: -10, items: [] }
    ] as never);

    let issueState: 'open' | 'resolved' = 'open';
    let occurrenceCount = 1;
    let createdReplacementIssue = false;
    vi.mocked(resolveFinancialIssueAfterRecompute).mockImplementation(async (_tx, input) => {
      if (input.resourceType === 'allocation_set' &&
        input.resourceId === selectedGrossSetId && input.safeCode === 'missing_source' &&
        issueState === 'open') {
        issueState = 'resolved';
        return { id: issueId, safeCode: 'missing_source', impact: 'pending' } as never;
      }
      return null;
    });
    vi.mocked(observeFinancialIssue).mockImplementation(async (_tx, input) => {
      if (input.resourceType === 'allocation_set' &&
        input.resourceId === selectedGrossSetId && input.safeCode === 'missing_source') {
        createdReplacementIssue ||= issueState !== 'open';
        issueState = 'open';
        occurrenceCount += 1;
      }
      return { id: issueId } as never;
    });
    vi.mocked(transaction.transaction).mockImplementation(async (work) => {
      const savedIssueState = issueState;
      try {
        return await work(transaction);
      } catch (error) {
        issueState = savedIssueState;
        throw error;
      }
    });

    for (const correlationId of ['refund-retry-one', 'refund-retry-two']) {
      await expect(recomputeLockedRefundFinancialProjection(
        transaction,
        lockedInput({ correlationId }),
        [selectedGrossSetId, selectedFeeSetId]
      )).resolves.toMatchObject({
        status: 'pending', refundId, safeCode: 'missing_source', issueId
      });
    }

    expect(issueState).toBe('open');
    expect(occurrenceCount).toBe(3);
    expect(createdReplacementIssue).toBe(false);
    expect(resolveFinancialIssueAfterRecompute).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        resourceType: 'allocation_set', resourceId: selectedGrossSetId,
        safeCode: 'missing_source'
      })
    );
  });

  it('preserves the highest-priority resolved set issue when the marker masks the view', async () => {
    const balance = canonicalBalance();
    const transaction = projectionTransaction({
      balances: [balance],
      history: [{
        refundId,
        providerRefundId: 're_refund_trace',
        providerCreatedAt: createdAt,
        refundStatus: 'succeeded',
        allocationStatus: 'finalized',
        refundAllocationId: allocationId,
        orderItemId: itemId,
        subtotalMinor: 400,
        taxMinor: 100,
        currency: 'USD'
      }],
      feeDetails: { [balanceId]: [{ amountMinor: 10, classification: 'refund_fee' }] },
      currentSets: [
        {
          id: selectedGrossSetId, allocationIdentity: 'selected-old-gross',
          balanceTransactionId: balanceId, sourceKind: 'refund', sourceId: refundId,
          basis: 'gross_amount', scope: 'title', currency: 'USD',
          expectedEffectMinor: -500, classifierVersion: 1, algorithmVersion: 1,
          sourceFingerprint: fingerprint, supersedesSetId: null, reversalOfSetId: null,
          isTargetTip: true, isGlobalTip: true
        },
        {
          id: selectedFeeSetId, allocationIdentity: 'selected-old-fee',
          balanceTransactionId: balanceId, sourceKind: 'refund', sourceId: refundId,
          basis: 'fee', scope: 'title', currency: 'USD', expectedEffectMinor: -10,
          classifierVersion: 1, algorithmVersion: 1, sourceFingerprint: fingerprint,
          supersedesSetId: null, reversalOfSetId: null,
          isTargetTip: true, isGlobalTip: true
        }
      ]
    });
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue([
      { status: 'missing', balanceTransactionId: balanceId,
        basis: 'gross_amount', safeCode: 'missing_source' },
      { status: 'complete', balanceTransactionId: balanceId, basis: 'fee',
        baseSetId: selectedFeeSetId, scope: 'title', currency: 'USD',
        expectedEffectMinor: -10, items: [] }
    ] as never);
    vi.mocked(resolveFinancialIssueAfterRecompute).mockImplementation(async (_tx, input) => {
      if (input.resourceType !== 'allocation_set' || input.resourceId !== selectedGrossSetId) {
        return null;
      }
      if (input.safeCode === 'allocation_mismatch') {
        return { id: '00000000-0000-4000-8000-000000000215',
          safeCode: 'allocation_mismatch', impact: 'exception' } as never;
      }
      if (input.safeCode === 'missing_source') {
        return { id: issueId, safeCode: 'missing_source', impact: 'pending' } as never;
      }
      return null;
    });
    vi.mocked(observeFinancialIssue).mockResolvedValue({ id: issueId } as never);

    await expect(recomputeLockedRefundFinancialProjection(
      transaction,
      lockedInput({ correlationId: 'refund-resolved-issue-priority' }),
      [selectedGrossSetId, selectedFeeSetId]
    )).resolves.toMatchObject({
      status: 'exception', refundId, safeCode: 'allocation_mismatch', issueId
    });

    for (const resourceId of [selectedGrossSetId, selectedFeeSetId]) {
      expect(observeFinancialIssue).toHaveBeenCalledWith(transaction, expect.objectContaining({
        resourceType: 'allocation_set', resourceId,
        safeCode: 'allocation_mismatch', impact: 'exception'
      }));
    }
    expect(observeFinancialIssue).not.toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ resourceType: 'allocation_set', safeCode: 'missing_source' })
    );
  });

  it('keeps immutable component-backed exception refunds in later refund capacity', async () => {
    const priorRefundId = '00000000-0000-4000-8000-000000000212';
    const priorAllocationId = '00000000-0000-4000-8000-000000000213';
    const balance = canonicalBalance();
    const transaction = projectionTransaction({
      balances: [balance],
      history: [
        {
          refundId: priorRefundId,
          providerRefundId: 're_prior_exception',
          providerCreatedAt: new Date(createdAt.getTime() - 1000),
          refundStatus: 'succeeded',
          allocationStatus: 'exception',
          refundAllocationId: priorAllocationId,
          orderItemId: itemId,
          subtotalMinor: 80,
          taxMinor: 20,
          currency: 'USD'
        },
        {
          refundId,
          providerRefundId: 're_refund_trace',
          providerCreatedAt: createdAt,
          refundStatus: 'succeeded',
          allocationStatus: 'finalized',
          refundAllocationId: allocationId,
          orderItemId: itemId,
          subtotalMinor: 400,
          taxMinor: 100,
          currency: 'USD'
        }
      ],
      feeDetails: { [balanceId]: [{ amountMinor: 10, classification: 'refund_fee' }] }
    });

    await expect(recomputeLockedRefundFinancialProjectionForVersion(
      transaction,
      lockedInput(),
      { classifierVersion: 2, allocationAlgorithmVersion: 3, replayId: 'c2-a3' }
    )).resolves.toMatchObject({
      status: 'exception', refundId, safeCode: 'allocation_mismatch'
    });
  });

  it('supersedes balance-owned account tips after the refund becomes locally linked', async () => {
    const balance = canonicalBalance();
    const currentSets = (['gross_amount', 'fee'] as const).map((basis, index) => ({
      id: `00000000-0000-4000-8000-00000000060${index + 1}`,
      allocationIdentity: `adjustment:${balanceId}:${balanceId}:replay:c1-a1:${basis}`,
      balanceTransactionId: balanceId,
      sourceKind: 'adjustment',
      sourceId: balanceId,
      basis,
      scope: 'account',
      currency: 'USD',
      expectedEffectMinor: basis === 'gross_amount' ? -500 : -10,
      algorithmVersion: 1,
      sourceFingerprint: fingerprint,
      supersedesSetId: null,
      reversalOfSetId: null
    }));
    const transaction = projectionTransaction({
      balances: [balance],
      currentSets,
      history: [{
        refundId,
        providerRefundId: 're_refund_trace',
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

    await recomputeLockedRefundFinancialProjectionForVersion(
      transaction,
      lockedInput(),
      { classifierVersion: 1, allocationAlgorithmVersion: 1, replayId: 'c1-a1' }
    );

    const plans = persistedPlans();
    expect(plans.find((plan) => plan.basis === 'gross_amount')?.supersedesSetId)
      .toBe(currentSets[0]!.id);
    expect(plans.find((plan) => plan.basis === 'fee')?.supersedesSetId)
      .toBe(currentSets[1]!.id);
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
        providerRefundId: 're_refund_trace',
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
    expect(persistFinancialAllocationPlanLocked).not.toHaveBeenCalled();
    expect(persistFinancialAllocationReplayPlanLocked).toHaveBeenCalledTimes(2);
    for (const [, persistInput, authorized] of
      vi.mocked(persistFinancialAllocationReplayPlanLocked).mock.calls) {
      expect(authorized).toEqual({ classifierVersion: 1, allocationAlgorithmVersion: 1 });
      expect(persistInput.plan.allocationIdentity).toContain(':replay:c1-a1:');
    }
    expect(observeFinancialIssue).not.toHaveBeenCalled();
  });

  it('uses provider refund identity for equal-time finalized-history capacity', async () => {
    const balance = canonicalBalance();
    const transaction = projectionTransaction({
      balances: [balance],
      history: [
        {
          refundId,
          providerRefundId: 're_z_current',
          providerCreatedAt: createdAt,
          refundStatus: 'succeeded',
          allocationStatus: 'finalized',
          refundAllocationId: allocationId,
          orderItemId: itemId,
          subtotalMinor: 400,
          taxMinor: 100,
          currency: 'USD'
        },
        {
          refundId: 'ffffffff-ffff-4fff-bfff-fffffffffff3',
          providerRefundId: 're_a_earlier',
          providerCreatedAt: createdAt,
          refundStatus: 'succeeded',
          allocationStatus: 'finalized',
          refundAllocationId: '00000000-0000-4000-8000-000000000299',
          orderItemId: itemId,
          subtotalMinor: 1,
          taxMinor: 0,
          currency: 'USD'
        }
      ],
      feeDetails: {
        [balanceId]: [{ amountMinor: 10, classification: 'refund_fee' }]
      }
    });
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue(
      completeProjections([balance])
    );
    vi.mocked(observeFinancialIssue).mockResolvedValue({
      id: issueId
    } as Awaited<ReturnType<typeof observeFinancialIssue>>);

    await expect(recomputeLockedRefundFinancialProjection(
      transaction,
      lockedInput()
    )).resolves.toMatchObject({
      status: 'exception',
      refundId,
      financialEvidenceStatus: 'exception',
      safeCode: 'allocation_mismatch',
      issueId
    });
    expect(persistFinancialAllocationReplayPlanLocked).not.toHaveBeenCalled();
    expect(observeFinancialIssue).toHaveBeenCalledWith(transaction, expect.objectContaining({
      resourceType: 'refund',
      resourceId: refundId,
      safeCode: 'allocation_mismatch',
      impact: 'exception'
    }));
  });

  it('persists unresolved succeeded evidence and records expected ambiguity as pending', async () => {
    const balance = canonicalBalance({ feeMinor: 0, netMinor: -500 });
    const transaction = projectionTransaction({ balances: [balance], history: [] });
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue([
      { status: 'missing', balanceTransactionId: balanceId, basis: 'gross_amount',
        safeCode: 'missing_source' },
      { status: 'missing', balanceTransactionId: balanceId, basis: 'fee',
        safeCode: 'missing_source' }
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
      reversalOfSetId: '00000000-0000-4000-8000-000000000500',
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
        providerRefundId: 're_refund_trace',
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
      reversalOfSetId: '00000000-0000-4000-8000-000000000500',
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

  it('rejects a locked conserved failed-refund pair that differs from its same-currency amount', async () => {
    const original = canonicalBalance({
      amountMinor: -90,
      feeMinor: 0,
      netMinor: -90
    });
    const reversal = canonicalBalance({
      id: failureBalanceId,
      providerId: 'txn_refund_failure_amount_mismatch_trace',
      amountMinor: 90,
      feeMinor: 0,
      netMinor: 90,
      providerCreatedAt: new Date('2026-08-11T00:00:00.000Z'),
      classification: 'refund_failure'
    });
    const transaction = projectionTransaction({
      balances: [original, reversal],
      history: []
    });
    vi.mocked(loadCurrentEffectiveAllocationProjection).mockResolvedValue(
      completeProjections([original, reversal])
    );
    vi.mocked(observeFinancialIssue).mockResolvedValue({ id: issueId } as never);

    await expect(recomputeLockedRefundFinancialProjection(transaction, lockedInput({
      providerStatus: 'failed',
      allocationStatus: 'not_applicable',
      amountMinor: 100,
      balanceTransactionIds: [balanceId, failureBalanceId],
      finalizedAllocations: [],
      refundComponents: []
    }))).resolves.toEqual({
      status: 'exception',
      refundId,
      financialEvidenceStatus: 'exception',
      safeCode: 'immutable_mismatch',
      issueId
    });

    expect(persistFinancialAllocationReplayPlanLocked).not.toHaveBeenCalled();
    expect(persistFinancialAllocationPlanLocked).not.toHaveBeenCalled();
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
