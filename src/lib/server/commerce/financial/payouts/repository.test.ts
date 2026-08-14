import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import { payoutSnapshotFixture } from '../../../../../../tests/fixtures/stripe/payout';

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

import { persistPayoutImportPage, stagePayoutSnapshot } from './repository';

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

  it('sorts and guards related payout roots by their target provider ID', async () => {
    const payoutId = '00000000-0000-4000-8000-000000000102';
    const execute = vi.fn()
      .mockResolvedValue({ rows: [] })
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
});
