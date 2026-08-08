import { describe, expect, it, vi } from 'vitest';
import { PermanentJobError, runWorker } from './runner';
import type { JobRecord, JobRepository } from './types';

const job: JobRecord = {
  id: 'f1f46ee7-3170-40ea-bfad-d55a734bf37d',
  type: 'test.handle',
  payload: { value: 1 },
  attempts: 1,
  maxAttempts: 5,
  lockedBy: 'worker-test'
};

function repositoryReturning(record: JobRecord): JobRepository {
  return {
    claimNext: vi.fn().mockResolvedValueOnce(record).mockResolvedValue(null),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined)
  };
}

describe('runWorker', () => {
  it('completes a successfully handled job', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    const handler = vi.fn().mockResolvedValue(undefined);

    await runWorker({
      repository,
      handlers: new Map([['test.handle', handler]]),
      workerId: 'worker-test',
      pollIntervalMs: 1,
      signal: controller.signal,
      sleep: async () => controller.abort()
    });

    expect(handler).toHaveBeenCalledWith(job, controller.signal);
    expect(repository.complete).toHaveBeenCalledWith(job.id, 'worker-test');
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('marks a permanent handler error as non-retryable', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);

    await runWorker({
      repository,
      handlers: new Map([
        [
          'test.handle',
          async () => {
            throw new PermanentJobError('Invalid job payload');
          }
        ]
      ]),
      workerId: 'worker-test',
      pollIntervalMs: 1,
      signal: controller.signal,
      sleep: async () => controller.abort()
    });

    expect(repository.fail).toHaveBeenCalledWith(
      job.id,
      'worker-test',
      'Invalid job payload',
      false
    );
  });

  it('fails an unknown job type without exposing a thrown value', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning({ ...job, type: 'unknown.type' });

    await runWorker({
      repository,
      handlers: new Map(),
      workerId: 'worker-test',
      pollIntervalMs: 1,
      signal: controller.signal,
      sleep: async () => controller.abort()
    });

    expect(repository.fail).toHaveBeenCalledWith(
      job.id,
      'worker-test',
      'No handler registered for unknown.type',
      false
    );
  });
});
