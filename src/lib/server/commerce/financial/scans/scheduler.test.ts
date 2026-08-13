import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import { enqueueJob } from '$lib/server/jobs/repository';
import {
  createFinancialScheduleEnsurer,
  ensureHourlyFinancialScan
} from './scheduler';

vi.mock('$lib/server/jobs/repository', () => ({ enqueueJob: vi.fn() }));

const database = {
  transaction: vi.fn(async (work: (tx: object) => Promise<unknown>) => work({}))
} as unknown as Database;

describe('financial scan scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enqueueJob).mockImplementation(async (_executor, input) => ({
      id: input.deduplicationKey
    }) as never);
  });

  it('ensures one initial, canonical UTC-hour, and composite replay root', async () => {
    await expect(ensureHourlyFinancialScan(database, {
      now: new Date('2026-08-12T19:47:59.999Z'),
      classifierVersion: 1,
      allocationAlgorithmVersion: 2
    })).resolves.toEqual({
      enqueued: [
        'commerce.financial-scan:initial:v1',
        'commerce.financial-scan:2026-08-12T19:00:00.000Z',
        'commerce.financial-classification:scan:1:2'
      ]
    });
    expect(vi.mocked(enqueueJob).mock.calls.map(([, input]) => input.deduplicationKey))
      .toEqual([
        'commerce.financial-scan:initial:v1',
        'commerce.financial-scan:2026-08-12T19:00:00.000Z',
        'commerce.financial-classification:scan:1:2'
      ]);
  });

  it('keeps allocation-only version bumps distinct and rejects malformed input before writes', async () => {
    await ensureHourlyFinancialScan(database, {
      now: new Date('2026-08-12T19:00:00.000Z'), classifierVersion: 1,
      allocationAlgorithmVersion: 2
    });
    await ensureHourlyFinancialScan(database, {
      now: new Date('2026-08-12T19:30:00.000Z'), classifierVersion: 1,
      allocationAlgorithmVersion: 3
    });
    expect(vi.mocked(enqueueJob).mock.calls.map(([, input]) => input.deduplicationKey))
      .toContain('commerce.financial-classification:scan:1:3');
    vi.clearAllMocks();
    await expect(ensureHourlyFinancialScan(database, {
      now: new Date('invalid'), classifierVersion: 0, allocationAlgorithmVersion: 1
    })).rejects.toMatchObject({ name: 'PermanentFinancialError', safeCode: 'invalid_job_payload' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('disabled runtime schedules only local composite replay and caches the same replay identity', async () => {
    const ensure = createFinancialScheduleEnsurer({
      database,
      runtimeMode: 'disabled',
      classifierVersion: 2,
      allocationAlgorithmVersion: 3
    });
    const signal = new AbortController().signal;
    await ensure({ now: new Date('2026-08-12T19:01:00.000Z'), signal });
    await ensure({ now: new Date('2026-08-12T19:59:00.000Z'), signal });
    expect(vi.mocked(enqueueJob).mock.calls.map(([, input]) => input.deduplicationKey))
      .toEqual(['commerce.financial-classification:scan:2:3']);
  });

  it('enabled and test-fixture modes ensure provider roots once per hour and honor abort', async () => {
    for (const runtimeMode of ['stripe', 'fixture'] as const) {
      vi.clearAllMocks();
      const ensure = createFinancialScheduleEnsurer({
        database, runtimeMode, classifierVersion: 1, allocationAlgorithmVersion: 1
      });
      const controller = new AbortController();
      await ensure({ now: new Date('2026-08-12T19:01:00.000Z'), signal: controller.signal });
      await ensure({ now: new Date('2026-08-12T19:59:00.000Z'), signal: controller.signal });
      expect(enqueueJob).toHaveBeenCalledTimes(3);
      controller.abort();
      await expect(ensure({
        now: new Date('2026-08-12T20:00:00.000Z'), signal: controller.signal
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(enqueueJob).toHaveBeenCalledTimes(3);
    }
  });
});
