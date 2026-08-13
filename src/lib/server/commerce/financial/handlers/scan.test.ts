import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import { PermanentFinancialError, RetryableFinancialError } from '../errors';
import { FINANCIAL_SCAN_JOB, createFinancialInitialScanJob } from '../jobs';
import { createFinancialScanHandler } from './scan';

const service = vi.hoisted(() => vi.fn());
vi.mock('../scans/service', () => ({ processFinancialScanJob: service }));

function scanKey(payload: Record<string, unknown>): string {
  if (payload.kind === 'initial') return 'commerce.financial-scan:initial:v1';
  if (payload.kind === 'hourly') return `commerce.financial-scan:${payload.scanGenerationHour}`;
  if (payload.kind === 'payout_impact') {
    return `financial:payout-impact:${payload.payoutId}:${payload.payoutGeneration}`;
  }
  if (payload.kind === 'composite_replay') {
    return `commerce.financial-classification:scan:${payload.classifierVersion}:` +
      String(payload.allocationAlgorithmVersion);
  }
  return `commerce.financial-scan:${payload.scanRunId}:${payload.phase}:` +
    String(payload.cursorDigestSha256);
}

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
        deduplicationKey: scanKey(payload), maxAttempts: 8, lockedBy: 'scan-worker' }, signal);
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
      deduplicationKey: 'commerce.financial-scan:initial:v1',
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
      deduplicationKey: 'commerce.financial-scan:initial:v1', lockedBy: 'scan-worker' };
    service.mockRejectedValueOnce(new PermanentFinancialError('source_linkage_mismatch'));
    await expect(handler(job, new AbortController().signal))
      .rejects.toMatchObject({ name: 'PermanentJobError' });
    service.mockRejectedValueOnce(new RetryableFinancialError('state_changed'));
    await expect(handler(job, new AbortController().signal))
      .rejects.toMatchObject({ name: 'RetryableFinancialError', safeCode: 'state_changed' });
  });

  it('rejects tampered permanent identity before scan work', async () => {
    const handler = createFinancialScanHandler({
      database: {} as Database, gateway: {} as StripeCommerceGateway, runtimeMode: 'stripe'
    });
    const definition = createFinancialInitialScanJob();
    const base = { id: randomUUID(), ...definition, attempts: 0, lockedBy: 'scan-identity' };
    for (const job of [
      { ...base, deduplicationKey: 'private-key' },
      { ...base, deduplicationKey: null },
      { ...base, maxAttempts: definition.maxAttempts - 1 },
      { ...base, payload: { ...definition.payload, privateField: true } }
    ]) {
      const failure = await handler(job as never, new AbortController().signal)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: 'PermanentJobError' });
      expect(failure).not.toHaveProperty('cause');
    }
    expect(service).not.toHaveBeenCalled();
  });
});
