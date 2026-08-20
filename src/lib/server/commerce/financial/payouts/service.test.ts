import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import { balanceTransactionSnapshotFixture } from '../../../../../../tests/fixtures/stripe/balance-transaction';
import { payoutSnapshotFixture } from '../../../../../../tests/fixtures/stripe/payout';
import { reconcileFinancialPayout } from './service';

const ledger = vi.hoisted(() => ({ stage: vi.fn() }));
const repository = vi.hoisted(() => ({
  loadGeneration: vi.fn(), stage: vi.fn(), start: vi.fn(), persist: vi.fn(), publish: vi.fn()
}));
vi.mock('../ledger', () => ({ stageBalanceTransaction: ledger.stage }));
vi.mock('./repository', () => ({
  loadPayoutGeneration: repository.loadGeneration,
  stagePayoutSnapshot: repository.stage,
  startOrResumePayoutImport: repository.start,
  persistPayoutImportPage: repository.persist,
  publishPayoutMembership: repository.publish
}));

const payoutId = '00000000-0000-4000-8000-000000000401';
const runId = '00000000-0000-4000-8000-000000000402';
const balanceId = '00000000-0000-4000-8000-000000000403';

function eventPayload() {
  return {
    providerPayoutId: 'po_test_fixture_101',
    trigger: { kind: 'event' as const, providerEventId: 'evt_payout_red_101' }
  };
}

describe('financial payout service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.loadGeneration.mockResolvedValue(null);
    repository.stage.mockResolvedValue({ payoutId, generation: 0, changed: true });
    repository.start.mockResolvedValue({
      id: runId, payoutId, generation: 0, state: 'collecting', nextStartingAfter: null,
      candidateCount: 0, pageCount: 0, safeOutcome: null, startedAt: new Date(),
      updatedAt: new Date(), completedAt: null
    });
    repository.persist.mockResolvedValue({
      id: runId, payoutId, generation: 0, state: 'publishable', nextStartingAfter: null,
      candidateCount: 0, pageCount: 1, safeOutcome: null, startedAt: new Date(),
      updatedAt: new Date(), completedAt: null
    });
    repository.publish.mockResolvedValue({ generation: 1, membershipCount: 0 });
    ledger.stage.mockResolvedValue({ balanceTransactionId: balanceId, disposition: 'inserted' });
  });

  it('keeps both provider pages outside repository transactions and publishes a terminal page', async () => {
    const trace: string[] = [];
    repository.loadGeneration.mockImplementation(async () => {
      trace.push('repository.load-generation');
      return null;
    });
    repository.stage.mockImplementation(async () => { trace.push('repository.stage-payout'); return { payoutId, generation: 0, changed: true }; });
    repository.start.mockImplementation(async () => { trace.push('repository.start-run'); return {
      id: runId, payoutId, generation: 0, state: 'collecting', nextStartingAfter: null,
      candidateCount: 0, pageCount: 0, safeOutcome: null, startedAt: new Date(),
      updatedAt: new Date(), completedAt: null
    }; });
    repository.persist.mockImplementation(async () => { trace.push('repository.persist-page'); return {
      id: runId, payoutId, generation: 0, state: 'publishable', nextStartingAfter: null,
      candidateCount: 0, pageCount: 1, safeOutcome: null, startedAt: new Date(),
      updatedAt: new Date(), completedAt: null
    }; });
    repository.publish.mockImplementation(async () => { trace.push('repository.publish'); return { generation: 1, membershipCount: 0 }; });
    const gateway = {
      retrievePayout: vi.fn(async () => { trace.push('provider.payout'); return payoutSnapshotFixture({ balanceTransactionId: null }); }),
      listBalanceTransactionsForPayout: vi.fn(async () => { trace.push('provider.page'); return { data: [], hasMore: false, nextStartingAfter: null }; })
    } as unknown as StripeCommerceGateway;

    await expect(reconcileFinancialPayout({ database: {} as Database, gateway }, {
      payload: eventPayload(), correlationId: 'payout-service-trace', signal: new AbortController().signal
    })).resolves.toEqual({
      status: 'published', payoutId, runId, generation: 1, membershipCount: 0
    });
    expect(trace).toEqual([
      'repository.load-generation', 'provider.payout', 'repository.stage-payout', 'repository.start-run',
      'provider.page', 'repository.persist-page', 'repository.publish'
    ]);
  });

  it('retrieves and stages direct payout transactions before staging a manual payout without listing', async () => {
    const trace: string[] = [];
    const direct = balanceTransactionSnapshotFixture({
      id: 'txn_test_payout_101', sourceFamily: 'payout', sourceId: 'po_test_fixture_101',
      currency: 'USD'
    });
    const gateway = {
      retrievePayout: vi.fn(async () => { trace.push('provider.payout'); return payoutSnapshotFixture({
        automatic: false, method: 'standard', reconciliationStatus: 'not_applicable'
      }); }),
      retrieveBalanceTransaction: vi.fn(async () => { trace.push('provider.balance'); return direct; }),
      listBalanceTransactionsForPayout: vi.fn()
    } as unknown as StripeCommerceGateway;
    ledger.stage.mockImplementation(async () => { trace.push('ledger.stage'); return { balanceTransactionId: balanceId, disposition: 'inserted' }; });
    repository.stage.mockImplementation(async () => { trace.push('repository.stage-payout'); return { payoutId, generation: 0, changed: true }; });

    await expect(reconcileFinancialPayout({ database: {} as Database, gateway }, {
      payload: eventPayload(), correlationId: 'payout-service-manual', signal: new AbortController().signal
    })).resolves.toEqual({ status: 'not_applicable', payoutId, generation: 0 });
    expect(trace).toEqual(['provider.payout', 'provider.balance', 'ledger.stage', 'repository.stage-payout']);
    expect(gateway.listBalanceTransactionsForPayout).not.toHaveBeenCalled();
    expect(repository.start).not.toHaveBeenCalled();
  });

  it('fails closed before persistence for malformed jobs and private provider failures', async () => {
    const database = {} as Database;
    const privateError = new Error('private provider payload');
    Object.defineProperty(privateError, 'cause', { value: { secret: 'private' } });
    const gateway = { retrievePayout: vi.fn().mockRejectedValue(privateError) } as unknown as StripeCommerceGateway;

    await expect(reconcileFinancialPayout({ database, gateway }, {
      payload: { ...eventPayload(), extra: true } as never,
      correlationId: 'payout-service-invalid', signal: new AbortController().signal
    })).rejects.toMatchObject({ name: 'PermanentFinancialError', safeCode: 'invalid_job_payload' });
    const rejection = await reconcileFinancialPayout({ database, gateway }, {
      payload: eventPayload(), correlationId: 'payout-service-private', signal: new AbortController().signal
    }).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ name: 'RetryableFinancialError', safeCode: 'provider_unavailable' });
    expect(rejection).not.toHaveProperty('cause');
    expect(JSON.stringify(rejection)).not.toContain('private');
    expect(repository.stage).not.toHaveBeenCalled();
  });

  it('parses the complete provider page before staging any returned evidence', async () => {
    const gateway = {
      retrievePayout: vi.fn(async () => payoutSnapshotFixture({ balanceTransactionId: null })),
      listBalanceTransactionsForPayout: vi.fn(async () => ({
        data: [], hasMore: true, nextStartingAfter: null
      }))
    } as unknown as StripeCommerceGateway;
    const rejection = await reconcileFinancialPayout({ database: {} as Database, gateway }, {
      payload: eventPayload(), correlationId: 'payout-service-page', signal: new AbortController().signal
    }).catch((error: unknown) => error);
    expect(rejection).toMatchObject({
      name: 'PermanentFinancialError', safeCode: 'unsupported_provider_evidence'
    });
    expect(rejection).not.toHaveProperty('cause');
    expect(ledger.stage).not.toHaveBeenCalled();
    expect(repository.persist).not.toHaveBeenCalled();
  });

  it('rejects a payout-filter page whose settlement currency differs from the payout', async () => {
    const gateway = {
      retrievePayout: vi.fn(async () => payoutSnapshotFixture({
        balanceTransactionId: null,
        currency: 'USD'
      })),
      listBalanceTransactionsForPayout: vi.fn(async () => ({
        data: [
          balanceTransactionSnapshotFixture({ id: 'txn_test_payout_page_usd_401' }),
          balanceTransactionSnapshotFixture({
            id: 'txn_test_payout_page_eur_401',
            currency: 'EUR',
            feeDetails: [
              { ordinal: 0, rawType: 'stripe_fee', amountMinor: 71, currency: 'EUR' }
            ]
          })
        ],
        hasMore: false,
        nextStartingAfter: null
      }))
    } as unknown as StripeCommerceGateway;

    await expect(reconcileFinancialPayout({ database: {} as Database, gateway }, {
      payload: eventPayload(),
      correlationId: 'payout-service-page-currency',
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      name: 'PermanentFinancialError',
      safeCode: 'currency_mismatch'
    });
    expect(ledger.stage).not.toHaveBeenCalled();
    expect(repository.persist).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it('rejects a stale continuation identity before requesting another page', async () => {
    const gateway = {
      retrievePayout: vi.fn(async () => payoutSnapshotFixture({ balanceTransactionId: null })),
      listBalanceTransactionsForPayout: vi.fn()
    } as unknown as StripeCommerceGateway;
    await expect(reconcileFinancialPayout({ database: {} as Database, gateway }, {
      payload: {
        providerPayoutId: 'po_test_fixture_101',
        trigger: {
          kind: 'continuation', payoutId: randomUUID(), runId,
          payoutGeneration: 0, cursorDigestSha256: 'a'.repeat(64)
        }
      }, correlationId: 'payout-service-stale', signal: new AbortController().signal
    })).rejects.toMatchObject({ name: 'RetryableFinancialError', safeCode: 'state_changed' });
    expect(gateway.listBalanceTransactionsForPayout).not.toHaveBeenCalled();
  });
});
