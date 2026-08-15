import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import { PermanentJobError } from '$lib/server/jobs/runner';
import { PermanentFinancialError, RetryableFinancialError } from '../errors';
import { FINANCIAL_CLASSIFICATION_JOB } from '../jobs';
import { createFinancialClassificationHandler } from './classification';

const replay = vi.hoisted(() => vi.fn());
vi.mock('../rebase', () => ({ replayFinancialClassification: replay }));

const subjectId = randomUUID();
const fingerprint = 'a'.repeat(64);

function job(payload: Record<string, unknown> = {}) {
  const classificationPayload = {
    subjectType: 'balance_transaction', subjectId,
    sourceFingerprintSha256: fingerprint,
    classifierVersion: 2, allocationAlgorithmVersion: 3,
    replayId: 'c2-a3', ...payload
  };
  return {
    id: randomUUID(), type: FINANCIAL_CLASSIFICATION_JOB,
    payload: classificationPayload,
    deduplicationKey:
      `financial:classification:${classificationPayload.classifierVersion}:` +
      `${classificationPayload.allocationAlgorithmVersion}:` +
      `${classificationPayload.subjectType}:${classificationPayload.subjectId}:` +
      `${classificationPayload.sourceFingerprintSha256}`,
    attempts: 0, maxAttempts: 5, lockedBy: 'classification-worker'
  };
}

describe('createFinancialClassificationHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatches the configured deployed pair', async () => {
    const database = {} as Database;
    const handler = createFinancialClassificationHandler({
      database, targetClassifierVersion: 2, targetAllocationAlgorithmVersion: 3
    });
    const work = job();
    const signal = new AbortController().signal;

    await handler(work, signal);

    expect(replay).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledWith({
      database, targetClassifierVersion: 2, targetAllocationAlgorithmVersion: 3
    }, {
      payload: work.payload,
      correlationId: `financial-classification-${work.id}`,
      signal
    });
  });

  it('dispatches a canonical predecessor pair to the authority-checked replay boundary', async () => {
    const handler = createFinancialClassificationHandler({
      database: {} as Database, targetClassifierVersion: 2,
      targetAllocationAlgorithmVersion: 3
    });
    const predecessor = job({
      classifierVersion: 1, allocationAlgorithmVersion: 1, replayId: 'c1-a1'
    });

    await expect(handler(predecessor, new AbortController().signal)).resolves.toBeUndefined();
    expect(replay).toHaveBeenCalledOnce();
    expect(replay.mock.calls[0]?.[1].payload).toEqual(predecessor.payload);
  });

  it.each([
    ['wrong job family', { type: 'commerce.financial-source' }],
    ['extra payload field', { payload: { ...job().payload, privateProviderText: 'do-not-retain' } }],
    ['tampered deduplication key', { deduplicationKey: 'financial:classification:tampered' }],
    ['null deduplication key', { deduplicationKey: null }],
    ['wrong max attempts', { maxAttempts: 4 }]
  ])('rejects %s before replay', async (_name, override) => {
    const handler = createFinancialClassificationHandler({
      database: {} as Database, targetClassifierVersion: 2,
      targetAllocationAlgorithmVersion: 3
    });
    const failure = await handler(
      { ...job(), ...override } as never,
      new AbortController().signal
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PermanentJobError);
    expect(failure).not.toHaveProperty('cause');
    expect(replay).not.toHaveBeenCalled();
  });

  it.each([
    ['future classifier', { classifierVersion: 3, allocationAlgorithmVersion: 3,
      replayId: 'c3-a3' }],
    ['future algorithm', { classifierVersion: 2, allocationAlgorithmVersion: 4,
      replayId: 'c2-a4' }]
  ])('dispatches a canonical %s pair to the authority boundary', async (_name, payload) => {
    const handler = createFinancialClassificationHandler({
      database: {} as Database, targetClassifierVersion: 2,
      targetAllocationAlgorithmVersion: 3
    });
    const work = job(payload);

    await expect(handler(work, new AbortController().signal)).resolves.toBeUndefined();
    expect(replay).toHaveBeenCalledOnce();
    expect(replay.mock.calls[0]?.[1].payload).toEqual(work.payload);
  });

  it('honors lease loss before parsing or replay', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createFinancialClassificationHandler({
      database: {} as Database, targetClassifierVersion: 2,
      targetAllocationAlgorithmVersion: 3
    })(job(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(replay).not.toHaveBeenCalled();
  });

  it('bounds permanent failures without retaining their cause and preserves retryable failures', async () => {
    const handler = createFinancialClassificationHandler({
      database: {} as Database, targetClassifierVersion: 2,
      targetAllocationAlgorithmVersion: 3
    });
    replay.mockRejectedValueOnce(new PermanentFinancialError('classification_fork'));
    const bounded = await handler(job(), new AbortController().signal)
      .catch((error: unknown) => error);
    expect(bounded).toBeInstanceOf(PermanentJobError);
    expect(bounded).toMatchObject({ message: 'Financial classification evidence is invalid.' });
    expect(bounded).not.toHaveProperty('cause');

    const retryable = new RetryableFinancialError('state_changed');
    replay.mockRejectedValueOnce(retryable);
    await expect(handler(job(), new AbortController().signal)).rejects.toBe(retryable);
  });
});
