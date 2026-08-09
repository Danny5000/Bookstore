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
      concurrency: 1,
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
      concurrency: 1,
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
      concurrency: 1,
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

  it('runs two independent lease-owner slots concurrently and stops both on abort', async () => {
    const controller = new AbortController();
    const seenWorkers = new Set<string>();
    const complete = vi.fn().mockResolvedValue(undefined);
    const repository: JobRepository = {
      claimNext: vi.fn(async (workerId: string) => {
        if (seenWorkers.has(workerId)) return null;
        seenWorkers.add(workerId);
        return {
          ...job,
          id: workerId.endsWith(':0') ? `${job.id.slice(0, -1)}0` : `${job.id.slice(0, -1)}1`,
          lockedBy: workerId
        };
      }),
      complete,
      fail: vi.fn().mockResolvedValue(undefined)
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximumActive = 0;
    const handler = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await held;
      active -= 1;
    });

    const running = runWorker({
      repository,
      handlers: new Map([['test.handle', handler]]),
      workerId: 'worker-concurrent',
      concurrency: 2,
      pollIntervalMs: 1,
      signal: controller.signal,
      sleep: async () => controller.abort()
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(2);
    expect(seenWorkers).toEqual(new Set(['worker-concurrent:0', 'worker-concurrent:1']));
    release();
    await running;
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
