import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import {
  createFinancialClassificationSubjectJob,
  createFinancialPayoutScanJob,
  createFinancialSourceScanJob
} from '../jobs';

const jobMocks = vi.hoisted(() => ({
  enqueueActiveEntityJob: vi.fn(),
  enqueueJob: vi.fn()
}));

vi.mock('$lib/server/jobs/repository', () => jobMocks);

import { commitFinancialScanPage } from './repository';

const RUN_ID = '00000000-0000-4000-8000-000000001701';
const SCAN_HOUR = '2026-08-12T22:00:00.000Z';

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    rootKey: 'commerce.financial-scan:2026-08-12T22:00:00.000Z',
    kind: 'hourly', phase: 'source_page', state: 'running',
    classifierVersion: null, allocationAlgorithmVersion: null, replayId: null,
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
    expect(jobMocks.enqueueJob).toHaveBeenCalledTimes(2);
    expect(jobMocks.enqueueJob.mock.calls[0]?.[1]).toMatchObject({
      type: classification.type,
      deduplicationKey: classification.deduplicationKey
    });
    expect(jobMocks.enqueueJob.mock.calls[1]?.[1]).toMatchObject({
      type: 'commerce.financial-scan',
      payload: { kind: 'continuation' }
    });
  });
});
