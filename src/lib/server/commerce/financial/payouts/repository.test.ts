import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import { payoutSnapshotFixture } from '../../../../../../tests/fixtures/stripe/payout';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQLWrapper } from 'drizzle-orm';

const jobMocks = vi.hoisted(() => ({
  enqueueActiveEntityJob: vi.fn(),
  enqueueJob: vi.fn()
}));
const lockMocks = vi.hoisted(() => ({ lockPayoutImportRows: vi.fn() }));
const issueMocks = vi.hoisted(() => ({
  observeFinancialIssue: vi.fn(),
  resolveFinancialIssueAfterRecompute: vi.fn()
}));

vi.mock('$lib/server/jobs/repository', () => jobMocks);
vi.mock('../locks', () => lockMocks);
vi.mock('../issues', () => issueMocks);

import {
  persistPayoutImportPage,
  publishPayoutMembership,
  stagePayoutSnapshot
} from './repository';

const dialect = new PgDialect();
const compiled = (query: unknown) => dialect.sqlToQuery((query as SQLWrapper).getSQL());

describe('payout repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockMocks.lockPayoutImportRows.mockResolvedValue({ disposition: 'fresh' });
  });

  it('stages a canonical payout at generation zero', async () => {
    const database = { transaction: vi.fn() } as unknown as Database;
    vi.mocked(database.transaction).mockResolvedValueOnce({
      payoutId: '00000000-0000-4000-8000-000000000101', generation: 0, changed: true
    });

    await expect(stagePayoutSnapshot(database, payoutSnapshotFixture(), {
      correlationId: 'payout-repository-red'
    })).resolves.toEqual({
      payoutId: '00000000-0000-4000-8000-000000000101', generation: 0, changed: true
    });
  });

  it('takes the replay-enrollment fence before the payout graph lock', async () => {
    const stop = new Error('stop after observing lock order');
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(stop);
    const database = {
      transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
    } as unknown as Database;

    await expect(stagePayoutSnapshot(database, payoutSnapshotFixture(), {
      correlationId: 'payout-stage-enrollment-order'
    })).rejects.toBe(stop);

    expect(compiled(execute.mock.calls[0]?.[0]).params).toEqual([
      'pale-orbit:financial:replay-enrollment'
    ]);
    expect(compiled(execute.mock.calls[1]?.[0]).params[0]).toMatch(
      /^pale-orbit:financial:payout:/u
    );
  });

  it('sorts and guards related payout roots by their target provider ID', async () => {
    const payoutId = '00000000-0000-4000-8000-000000000102';
    const execute = vi.fn()
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: payoutId }] })
      .mockResolvedValueOnce({ rows: [] });
    const database = {
      transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
    } as unknown as Database;

    await stagePayoutSnapshot(database, payoutSnapshotFixture({
      balanceTransactionId: null,
      originalPayoutId: 'po_related_z_102',
      reversedByPayoutId: 'po_related_a_102'
    }), { correlationId: 'payout-related-guard' });

    expect(jobMocks.enqueueActiveEntityJob).toHaveBeenCalledTimes(2);
    expect(jobMocks.enqueueActiveEntityJob.mock.calls.map(([, input]) =>
      input.activeEntity.providerPayoutId
    )).toEqual(['po_related_a_102', 'po_related_z_102']);
    expect(jobMocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('keeps an import continuation generic so the running payout root cannot suppress it', async () => {
    const payoutId = '00000000-0000-4000-8000-000000000103';
    const runId = '00000000-0000-4000-8000-000000000104';
    const transactionId = '00000000-0000-4000-8000-000000000105';
    const baseRun = {
      id: runId, payoutId, generation: 0, state: 'collecting', nextStartingAfter: null,
      candidateCount: 0, pageCount: 0, safeOutcome: null,
      startedAt: new Date(), updatedAt: new Date(), completedAt: null
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [baseRun] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ providerId: 'po_continuation_103' }] })
      .mockResolvedValueOnce({ rows: [{
        ...baseRun, pageCount: 1, candidateCount: 1,
        nextStartingAfter: 'txn_continuation_103'
      }] });
    const database = {
      transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
    } as unknown as Database;

    await persistPayoutImportPage(database, {
      payoutId, runId, expectedGeneration: 0, expectedPageCount: 0,
      expectedStartingAfter: null, balanceTransactionIds: [transactionId], hasMore: true,
      nextStartingAfter: 'txn_continuation_103', correlationId: 'payout-continuation-guard'
    });

    expect(jobMocks.enqueueActiveEntityJob).not.toHaveBeenCalled();
    expect(jobMocks.enqueueJob).toHaveBeenCalledOnce();
    expect(jobMocks.enqueueJob.mock.calls[0]?.[1]).toMatchObject({
      type: 'commerce.financial-payout',
      payload: { providerPayoutId: 'po_continuation_103', trigger: { kind: 'continuation' } }
    });
  });

  it('rechecks every locked candidate currency before publishing payout membership', async () => {
    const payoutId = '00000000-0000-4000-8000-000000000106';
    const runId = '00000000-0000-4000-8000-000000000107';
    const balanceTransactionId = '00000000-0000-4000-8000-000000000108';
    lockMocks.lockPayoutImportRows.mockResolvedValueOnce({
      payoutId,
      runId,
      disposition: 'fresh',
      payoutFinancialGeneration: 0,
      runGeneration: 0,
      runState: 'publishable',
      balanceTransactionIds: [balanceTransactionId],
      existingMembershipIds: [],
      hasPublishedHistory: false,
      issueIds: []
    });
    issueMocks.observeFinancialIssue.mockResolvedValueOnce({
      id: '00000000-0000-4000-8000-000000000109'
    });
    const execute = vi.fn(async (query: unknown) => {
      const rendered = compiled(query);
      if (rendered.sql.includes('select candidate_count as "candidateCount"')) {
        return { rows: [{ candidateCount: 1 }] };
      }
      if (rendered.sql.includes('select provider_id as "providerId"')) {
        return { rows: [{
          providerId: 'po_currency_guard_106',
          automatic: true,
          method: 'standard',
          status: 'paid',
          reconciliationStatus: 'completed',
          financialGeneration: 0,
          currency: 'USD'
        }] };
      }
      if (rendered.sql.includes('from stripe_balance_transactions') &&
        rendered.sql.includes('where id in')) {
        return { rows: [{ id: balanceTransactionId, currency: 'EUR' }] };
      }
      return { rows: [] };
    });
    const database = {
      transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
    } as unknown as Database;

    await expect(publishPayoutMembership(database, {
      payoutId,
      runId,
      expectedGeneration: 0,
      correlationId: 'payout-publish-currency-guard'
    })).rejects.toMatchObject({
      name: 'PermanentFinancialError',
      safeCode: 'currency_mismatch'
    });

    expect(issueMocks.observeFinancialIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceType: 'payout',
        resourceId: payoutId,
        safeCode: 'currency_mismatch',
        impact: 'exception'
      })
    );
    expect(execute.mock.calls.map(([query]) => compiled(query).sql)
      .some((statement) => statement.includes('insert into stripe_payout_balance_transactions')))
      .toBe(false);
  });

  it('rejects a published replay whose authoritative membership crosses currencies', async () => {
    const payoutId = '00000000-0000-4000-8000-000000000110';
    const runId = '00000000-0000-4000-8000-000000000111';
    lockMocks.lockPayoutImportRows.mockResolvedValueOnce({
      payoutId,
      runId,
      disposition: 'published_replay',
      payoutFinancialGeneration: 1,
      runGeneration: 0,
      runState: 'published',
      balanceTransactionIds: [],
      existingMembershipIds: [],
      hasPublishedHistory: false,
      issueIds: []
    });
    issueMocks.observeFinancialIssue.mockResolvedValueOnce({
      id: '00000000-0000-4000-8000-000000000112'
    });
    const execute = vi.fn(async (query: unknown) => {
      const rendered = compiled(query);
      if (rendered.sql.includes('from stripe_payout_balance_transactions') &&
        rendered.sql.includes('mismatchCount')) {
        return { rows: [{ count: 1, mismatchCount: 1 }] };
      }
      return { rows: [] };
    });
    const database = {
      transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
    } as unknown as Database;

    await expect(publishPayoutMembership(database, {
      payoutId,
      runId,
      expectedGeneration: 0,
      correlationId: 'payout-published-replay-currency-guard'
    })).rejects.toMatchObject({
      name: 'PermanentFinancialError',
      safeCode: 'currency_mismatch'
    });

    expect(issueMocks.observeFinancialIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceType: 'payout',
        resourceId: payoutId,
        safeCode: 'currency_mismatch',
        impact: 'exception'
      })
    );
    expect(execute.mock.calls.map(([query]) => compiled(query).sql)
      .some((statement) => statement.includes('update payout_import_runs')))
      .toBe(false);
  });

  it('returns the authoritative same-currency membership count on published replay', async () => {
    const payoutId = '00000000-0000-4000-8000-000000000113';
    const runId = '00000000-0000-4000-8000-000000000114';
    lockMocks.lockPayoutImportRows.mockResolvedValueOnce({
      payoutId,
      runId,
      disposition: 'published_replay',
      payoutFinancialGeneration: 1,
      runGeneration: 0,
      runState: 'published',
      balanceTransactionIds: [],
      existingMembershipIds: [],
      hasPublishedHistory: false,
      issueIds: []
    });
    const execute = vi.fn(async () => ({ rows: [{ count: 2, mismatchCount: 0 }] }));
    const database = {
      transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
    } as unknown as Database;

    await expect(publishPayoutMembership(database, {
      payoutId,
      runId,
      expectedGeneration: 0,
      correlationId: 'payout-published-replay-same-currency'
    })).resolves.toEqual({ generation: 1, membershipCount: 2 });
    expect(issueMocks.observeFinancialIssue).not.toHaveBeenCalled();
  });
});
