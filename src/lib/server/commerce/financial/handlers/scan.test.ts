import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import { PermanentFinancialError, RetryableFinancialError } from '../errors';
import { FINANCIAL_SCAN_JOB } from '../jobs';
import { createFinancialScanHandler } from './scan';

const service = vi.hoisted(() => vi.fn());
vi.mock('../scans/service', () => ({ processFinancialScanJob: service }));

describe('financial scan handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('strictly dispatches each root and continuation family with a bounded correlation id', async () => {
    const dependencies = {
      database: {} as Database, gateway: {} as StripeCommerceGateway, runtimeMode: 'stripe' as const
    };
    const handler = createFinancialScanHandler(dependencies);
    for (const payload of [
      { kind: 'initial', version: 1 },
      { kind: 'hourly', scanGenerationHour: '2026-08-12T19:00:00.000Z' },
      { kind: 'payout_impact', payoutId: randomUUID(), payoutGeneration: 1 },
      { kind: 'composite_replay', classifierVersion: 1, allocationAlgorithmVersion: 2,
        replayId: 'c1-a2' },
      { kind: 'continuation', scanRunId: randomUUID(), phase: 'source_page',
        cursorDigestSha256: 'a'.repeat(64), limit: 100 }
    ] as const) {
      const id = randomUUID();
      const signal = new AbortController().signal;
      await handler({ id, type: FINANCIAL_SCAN_JOB, payload, attempts: 1,
        maxAttempts: 8, lockedBy: 'scan-worker' }, signal);
      expect(service).toHaveBeenLastCalledWith(dependencies, {
        payload, correlationId: `financial-scan-${id}`, signal
      });
    }
  });

  it('rejects wrong/extra payloads and abort before service dispatch', async () => {
    const handler = createFinancialScanHandler({
      database: {} as Database, gateway: {} as StripeCommerceGateway, runtimeMode: 'stripe'
    });
    const base = { id: randomUUID(), type: FINANCIAL_SCAN_JOB, attempts: 1,
      maxAttempts: 8, lockedBy: 'scan-worker' };
    await expect(handler({ ...base, payload: { kind: 'initial', version: 1, secret: true } },
      new AbortController().signal)).rejects.toMatchObject({ name: 'PermanentJobError' });
    const controller = new AbortController();
    controller.abort();
    await expect(handler({ ...base, payload: { kind: 'initial', version: 1 } }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(service).not.toHaveBeenCalled();
  });

  it('bounds permanent failures and preserves retryable outcomes', async () => {
    const handler = createFinancialScanHandler({
      database: {} as Database, gateway: {} as StripeCommerceGateway, runtimeMode: 'stripe'
    });
    const job = { id: randomUUID(), type: FINANCIAL_SCAN_JOB,
      payload: { kind: 'initial', version: 1 }, attempts: 1, maxAttempts: 8,
      lockedBy: 'scan-worker' };
    service.mockRejectedValueOnce(new PermanentFinancialError('source_linkage_mismatch'));
    await expect(handler(job, new AbortController().signal))
      .rejects.toMatchObject({ name: 'PermanentJobError' });
    service.mockRejectedValueOnce(new RetryableFinancialError('state_changed'));
    await expect(handler(job, new AbortController().signal))
      .rejects.toMatchObject({ name: 'RetryableFinancialError', safeCode: 'state_changed' });
  });
});
