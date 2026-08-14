import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '$lib/server/db/client';
import type { FinancialScanRunRow } from '$lib/server/db/schema';
import {
  createFinancialClassificationSubjectJob,
  createFinancialPayoutScanJob,
  createFinancialSourceScanJob
} from '../jobs';

const jobMocks = vi.hoisted(() => ({
  enqueueActiveEntityJob: vi.fn(),
  enqueueFinancialClassificationJob: vi.fn(),
  enqueueJob: vi.fn()
}));

vi.mock('$lib/server/jobs/repository', () => jobMocks);

import {
  commitFinancialScanPage,
  freezePayoutDiscoveryWindow,
  startOrResumeFinancialScan
} from './repository';

const RUN_ID = '00000000-0000-4000-8000-000000001701';
const SCAN_HOUR = '2026-08-12T22:00:00.000Z';
const dialect = new PgDialect();

function rendered(query: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]);
}

function runRow(overrides: Partial<FinancialScanRunRow> = {}): FinancialScanRunRow {
  return {
    id: RUN_ID,
    rootKey: 'commerce.financial-scan:2026-08-12T22:00:00.000Z',
    kind: 'hourly', phase: 'source_page', state: 'running',
    classifierVersion: null, allocationAlgorithmVersion: null, replayId: null,
    payoutDiscoveryCreatedGte: null, payoutDiscoveryCreatedLt: null,
    checkpoint: null, cursorDigestSha256: null,
    processedCount: 0, enqueuedCount: 0, pageCount: 0, safeOutcome: null,
    startedAt: new Date('2026-08-12T22:00:00.000Z'),
    updatedAt: new Date('2026-08-12T22:00:00.000Z'), completedAt: null,
    ...overrides
  };
}

function database(): Database {
  const execute = vi.fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [runRow()] })
    .mockResolvedValueOnce({ rows: [runRow({
      phase: 'payout_discovery_page', checkpoint: 'next', pageCount: 1,
      processedCount: 3, enqueuedCount: 4
    })] });
  return {
    transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
  } as unknown as Database;
}

describe('financial scan page job handoff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('locks replay authority before the projection-enrollment fence during registration', async () => {
    const stoppedAtEnrollment = new Error('stopped at projection enrollment');
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        classifierVersion: 1,
        allocationAlgorithmVersion: 1,
        pendingClassifierVersion: null,
        pendingAllocationAlgorithmVersion: null,
        pendingReplayId: null,
        pendingScanRunId: null
      }] })
      .mockRejectedValueOnce(stoppedAtEnrollment);
    const mocked = {
      transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
    } as unknown as Database;

    await expect(startOrResumeFinancialScan(mocked, {
      kind: 'composite_replay', classifierVersion: 2,
      allocationAlgorithmVersion: 2, replayId: 'c2-a2'
    })).rejects.toBe(stoppedAtEnrollment);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(rendered(execute.mock.calls[0]![0]).sql).toMatch(
      /from financial_projection_versions[\s\S]*for update/u
    );
    expect(rendered(execute.mock.calls[1]![0]).params).toContain(
      'pale-orbit:financial:replay-enrollment'
    );
  });

  it('sorts and guards source/payout roots while leaving classification and continuation generic', async () => {
    const sourceHigh = createFinancialSourceScanJob({
      sourceKind: 'refund', sourceId: '00000000-0000-4000-8000-000000001799',
      scanRunId: RUN_ID, scanGenerationHour: SCAN_HOUR
    });
    const sourceLow = createFinancialSourceScanJob({
      sourceKind: 'payment', sourceId: '00000000-0000-4000-8000-000000001702',
      scanRunId: RUN_ID, scanGenerationHour: SCAN_HOUR
    });
    const payout = createFinancialPayoutScanJob({
      providerPayoutId: 'po_scan_guard_1701', scanRunId: RUN_ID,
      scanGenerationHour: SCAN_HOUR
    });
    const classification = createFinancialClassificationSubjectJob({
      subjectType: 'balance_transaction',
      subjectId: '00000000-0000-4000-8000-000000001703',
      sourceFingerprintSha256: 'a'.repeat(64), classifierVersion: 1,
      allocationAlgorithmVersion: 1
    });

    await commitFinancialScanPage(database(), {
      runId: RUN_ID,
      expectedPhase: 'source_page', expectedCheckpoint: null, expectedPageCount: 0,
      nextPhase: 'payout_discovery_page', nextCheckpoint: 'next', processedCount: 3,
      children: [sourceHigh, classification, payout, sourceLow], complete: false
    });

    expect(jobMocks.enqueueActiveEntityJob).toHaveBeenCalledTimes(3);
    expect(jobMocks.enqueueActiveEntityJob.mock.calls.map(([, input]) =>
      'providerPayoutId' in input.activeEntity
        ? input.activeEntity.providerPayoutId
        : input.activeEntity.sourceId
    )).toEqual([
      'po_scan_guard_1701',
      '00000000-0000-4000-8000-000000001702',
      '00000000-0000-4000-8000-000000001799'
    ]);
    expect(jobMocks.enqueueFinancialClassificationJob).toHaveBeenCalledOnce();
    expect(jobMocks.enqueueFinancialClassificationJob.mock.calls[0]?.[1]).toMatchObject({
      type: classification.type,
      deduplicationKey: classification.deduplicationKey
    });
    expect(jobMocks.enqueueJob).toHaveBeenCalledOnce();
    expect(jobMocks.enqueueJob.mock.calls[0]?.[1]).toMatchObject({
      type: 'commerce.financial-scan',
      payload: { kind: 'continuation' }
    });
  });

  it('freezes an outage-recovery payout window from the durable high-water with 72-hour overlap', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [runRow({ phase: 'payout_discovery_page' })] })
      .mockResolvedValueOnce({ rows: [{ coveredThrough: new Date('2026-08-01T00:00:00.000Z') }] })
      .mockImplementationOnce(async () => {
        return { rows: [runRow({
          phase: 'payout_discovery_page',
          payoutDiscoveryCreatedGte: new Date('2026-07-29T00:00:00.000Z'),
          payoutDiscoveryCreatedLt: new Date('2026-08-12T23:00:00.000Z')
        })] };
      });
    const mocked = {
      transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
    } as unknown as Database;

    await expect(freezePayoutDiscoveryWindow(
      mocked,
      runRow({ phase: 'payout_discovery_page' }),
      SCAN_HOUR
    )).resolves.toEqual({
      createdGte: Math.floor(new Date('2026-07-29T00:00:00.000Z').getTime() / 1000),
      createdLt: Math.floor(new Date('2026-08-12T23:00:00.000Z').getTime() / 1000)
    });
    expect(rendered(execute.mock.calls[3]![0]).params).toEqual(expect.arrayContaining([
      new Date('2026-07-29T00:00:00.000Z'),
      new Date('2026-08-12T23:00:00.000Z')
    ]));
  });

  it('seals a terminal replay page behind a durable finalizer without activating it', async () => {
    const replay = runRow({
      rootKey: 'commerce.financial-classification:scan:2:3',
      kind: 'classification_replay', phase: 'classification_replay_page',
      classifierVersion: 2, allocationAlgorithmVersion: 3, replayId: 'c2-a3'
    });
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [replay] })
      .mockResolvedValueOnce({ rows: [runRow({
        ...replay, phase: 'classification_replay_finalize', state: 'running',
        pageCount: 1, cursorDigestSha256: 'f'.repeat(64)
      })] });
    const mocked = {
      transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
    } as unknown as Database;

    await expect(commitFinancialScanPage(mocked, {
      runId: RUN_ID, expectedPhase: 'classification_replay_page',
      expectedCheckpoint: null, expectedPageCount: 0,
      nextPhase: 'classification_replay_page', nextCheckpoint: null,
      processedCount: 0, children: [], complete: true
    })).resolves.toMatchObject({
      state: 'running', phase: 'classification_replay_finalize', completedAt: null
    });

    expect(execute.mock.calls.map(([query]) => rendered(query).sql).join('\n'))
      .not.toContain('update financial_projection_versions');
    expect(jobMocks.enqueueJob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'commerce.financial-scan',
      payload: expect.objectContaining({
        kind: 'continuation', scanRunId: RUN_ID,
        phase: 'classification_replay_finalize'
      })
    }));
  });

  it('atomically advances contiguous payout coverage on the terminal discovery page', async () => {
    const discovery = runRow({
      phase: 'payout_discovery_page',
      payoutDiscoveryCreatedGte: new Date('2026-08-01T00:00:00.000Z'),
      payoutDiscoveryCreatedLt: new Date('2026-08-12T23:00:00.000Z')
    });
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [discovery] })
      .mockResolvedValueOnce({ rows: [{ coveredThrough: new Date('2026-08-10T00:00:00.000Z') }] })
      .mockResolvedValueOnce({ rows: [{ coveredThrough: new Date('2026-08-12T23:00:00.000Z') }] })
      .mockResolvedValueOnce({ rows: [runRow({
        ...discovery, phase: 'incomplete_payout_run_page', pageCount: 1
      })] });
    const mocked = {
      transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
    } as unknown as Database;

    await commitFinancialScanPage(mocked, {
      runId: RUN_ID, expectedPhase: 'payout_discovery_page', expectedCheckpoint: null,
      expectedPageCount: 0, nextPhase: 'incomplete_payout_run_page', nextCheckpoint: null,
      processedCount: 0, children: [], complete: false
    });

    expect(rendered(execute.mock.calls[2]![0]).sql).toContain('financial_payout_discovery_state');
    expect(rendered(execute.mock.calls[3]![0]).sql).toContain('update financial_payout_discovery_state');
    expect(jobMocks.enqueueJob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'commerce.financial-scan', payload: expect.objectContaining({ kind: 'continuation' })
    }));
  });

  it('rejects a terminal discovery window that would skip beyond the durable high-water', async () => {
    const discovery = runRow({
      phase: 'payout_discovery_page',
      payoutDiscoveryCreatedGte: new Date('2026-08-11T00:00:00.000Z'),
      payoutDiscoveryCreatedLt: new Date('2026-08-12T23:00:00.000Z')
    });
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [discovery] })
      .mockResolvedValueOnce({ rows: [{ coveredThrough: new Date('2026-08-10T00:00:00.000Z') }] });
    const mocked = {
      transaction: vi.fn(async (work) => work({ execute, rollback: vi.fn() }))
    } as unknown as Database;

    await expect(commitFinancialScanPage(mocked, {
      runId: RUN_ID, expectedPhase: 'payout_discovery_page', expectedCheckpoint: null,
      expectedPageCount: 0, nextPhase: 'incomplete_payout_run_page', nextCheckpoint: null,
      processedCount: 0, children: [], complete: false
    })).rejects.toMatchObject({ name: 'RetryableFinancialError', safeCode: 'state_changed' });
    expect(jobMocks.enqueueJob).not.toHaveBeenCalled();
  });
});
