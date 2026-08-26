import { describe, expect, it, vi } from 'vitest';
import { PermanentJobError, runWorker } from './runner';
import type { JobFailureTransition, JobRecord, JobRepository } from './types';

const job: JobRecord = {
  id: 'f1f46ee7-3170-40ea-bfad-d55a734bf37d',
  type: 'test.handle',
  payload: { value: 1 },
  deduplicationKey: null,
  attempts: 1,
  maxAttempts: 5,
  lockedBy: 'worker-test'
};

const FINANCIAL_ADMIN_LEASE_CAPABILITY = 'A'.repeat(43);
const financialAdminJob: JobRecord = {
  ...job,
  id: 'f1f46ee7-3170-40ea-bfad-d55a734bf380',
  type: 'commerce.financial-admin-command',
  payload: { commandId: 'f1f46ee7-3170-40ea-bfad-d55a734bf381' },
  deduplicationKey:
    'commerce:financial-admin-command:f1f46ee7-3170-40ea-bfad-d55a734bf381:v1',
  financialAdminLeaseCapability: FINANCIAL_ADMIN_LEASE_CAPABILITY
};

function repositoryReturning(record: JobRecord): JobRepository {
  const fail = vi.fn().mockResolvedValue(true);
  return {
    claimNext: vi.fn().mockResolvedValueOnce(record).mockResolvedValue(null),
    renewLease: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    fail,
    failWithDisposition: vi.fn(async (
      ...failureArguments: Parameters<JobRepository['fail']>
    ): Promise<JobFailureTransition> => await fail(...failureArguments)
      ? { applied: true, retryScheduled: failureArguments[3] }
      : { applied: false })
  };
}

function controlledSleep() {
  const releases: Array<() => void> = [];
  const sleep = vi.fn((_milliseconds: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      releases.push(finish);
      signal.addEventListener('abort', finish, { once: true });
    }));
  return {
    sleep,
    releaseNext() {
      const release = releases.shift();
      if (!release) throw new Error('Expected a pending controlled sleep');
      release();
    }
  };
}

describe('runWorker', () => {
  it('runs the poll hook before each claim cycle and stops before claiming after abort', async () => {
    const controller = new AbortController();
    const trace: string[] = [];
    let hookCount = 0;
    const repository = repositoryReturning(job);
    vi.mocked(repository.claimNext).mockReset().mockImplementation(async () => {
      trace.push('claim');
      return null;
    });

    await runWorker({
      repository,
      handlers: new Map(),
      workerId: 'worker-hook-order',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 1,
      signal: controller.signal,
      beforePoll: async ({ now, signal }) => {
        trace.push('hook');
        expect(now).toBeInstanceOf(Date);
        expect(signal).toBe(controller.signal);
        hookCount += 1;
        if (hookCount === 2) controller.abort();
      },
      sleep: async () => { if (hookCount === 0) controller.abort(); }
    });

    expect(trace).toEqual(['hook', 'claim', 'hook']);
  });

  it('logs a bounded poll-hook failure and continues to a later poll', async () => {
    const controller = new AbortController();
    const privateFailure = new Error('private scheduler payload');
    Object.defineProperty(privateFailure, 'cause', { value: { secret: true } });
    let hookCount = 0;
    const repository = repositoryReturning(job);
    vi.mocked(repository.claimNext).mockReset().mockResolvedValue(null);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runWorker({
      repository,
      handlers: new Map(),
      workerId: 'worker-hook-failure',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 1,
      signal: controller.signal,
      beforePoll: async () => {
        hookCount += 1;
        if (hookCount === 1) throw privateFailure;
        controller.abort();
      },
      sleep: async () => { if (hookCount === 0) controller.abort(); }
    });

    expect(hookCount).toBe(2);
    expect(repository.claimNext).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('[jobs] worker poll hook failed');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
    log.mockRestore();
  });

  it('serializes one poll hook across concurrent worker slots', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    vi.mocked(repository.claimNext).mockReset().mockResolvedValue(null);
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const beforePoll = vi.fn(async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) await firstHeld;
      else controller.abort();
      active -= 1;
    });

    const running = runWorker({
      repository,
      handlers: new Map(),
      workerId: 'worker-hook-concurrent',
      concurrency: 2,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 1,
      signal: controller.signal,
      beforePoll,
      sleep: async () => controller.abort()
    });
    await vi.waitFor(() => expect(beforePoll).toHaveBeenCalledOnce());
    expect(maximumActive).toBe(1);
    releaseFirst();
    await running;

    expect(beforePoll).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
  });

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
      heartbeatIntervalMs: 1,
      signal: controller.signal,
      sleep: async () => controller.abort()
    });

    expect(handler).toHaveBeenCalledWith(job, expect.any(AbortSignal));
    expect(handler.mock.calls[0]?.[1]).not.toBe(controller.signal);
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
      heartbeatIntervalMs: 1,
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
      heartbeatIntervalMs: 1,
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
    const complete = vi.fn().mockResolvedValue(true);
    const fail = vi.fn().mockResolvedValue(true);
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
      renewLease: vi.fn().mockResolvedValue(true),
      complete,
      fail,
      failWithDisposition: vi.fn(async (
        ...failureArguments: Parameters<JobRepository['fail']>
      ): Promise<JobFailureTransition> => await fail(...failureArguments)
        ? { applied: true, retryScheduled: failureArguments[3] }
        : { applied: false })
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
      heartbeatIntervalMs: 1,
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

  it('renews an owned lease while a handler is running and stops after completion', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    const heartbeat = controlledSleep();
    let releaseHandler!: () => void;
    const heldHandler = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const handler = vi.fn(async () => heldHandler);

    const running = runWorker({
      repository,
      handlers: new Map([['test.handle', handler]]),
      workerId: 'worker-test',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 25,
      signal: controller.signal,
      heartbeatSleep: heartbeat.sleep,
      sleep: async () => controller.abort()
    });

    await vi.waitFor(() => expect(heartbeat.sleep).toHaveBeenCalledTimes(1));
    heartbeat.releaseNext();
    await vi.waitFor(() => expect(repository.renewLease).toHaveBeenCalledWith(
      job.id,
      'worker-test'
    ));
    releaseHandler();
    await running;

    expect(repository.complete).toHaveBeenCalledOnce();
    const renewalCount = vi.mocked(repository.renewLease).mock.calls.length;
    await Promise.resolve();
    expect(repository.renewLease).toHaveBeenCalledTimes(renewalCount);
  });

  it('aborts the handler and skips terminal writes when lease renewal loses ownership', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    vi.mocked(repository.renewLease).mockResolvedValue(false);
    const heartbeat = controlledSleep();
    let handlerSignal: AbortSignal | undefined;
    const handler = vi.fn(async (_record: JobRecord, signal: AbortSignal) => {
      handlerSignal = signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {
        once: true
      }));
    });

    const running = runWorker({
      repository,
      handlers: new Map([['test.handle', handler]]),
      workerId: 'worker-test',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 25,
      signal: controller.signal,
      heartbeatSleep: heartbeat.sleep,
      sleep: async () => controller.abort()
    });

    await vi.waitFor(() => expect(heartbeat.sleep).toHaveBeenCalledTimes(1));
    heartbeat.releaseNext();
    await running;

    expect(handlerSignal?.aborted).toBe(true);
    expect(handlerSignal?.reason).toMatchObject({ name: 'JobLeaseLostError' });
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('conservatively aborts and skips terminal writes when lease renewal throws', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    vi.mocked(repository.renewLease).mockRejectedValue(new Error('database unavailable'));
    const heartbeat = controlledSleep();
    let handlerSignal: AbortSignal | undefined;
    const handler = vi.fn(async (_record: JobRecord, signal: AbortSignal) => {
      handlerSignal = signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {
        once: true
      }));
    });

    const running = runWorker({
      repository,
      handlers: new Map([['test.handle', handler]]),
      workerId: 'worker-test',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 25,
      signal: controller.signal,
      heartbeatSleep: heartbeat.sleep,
      sleep: async () => controller.abort()
    });

    await vi.waitFor(() => expect(heartbeat.sleep).toHaveBeenCalledTimes(1));
    heartbeat.releaseNext();
    await running;

    expect(handlerSignal?.reason).toMatchObject({ name: 'JobLeaseLostError' });
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('treats a stale completion as lost ownership without attempting a stale failure', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    vi.mocked(repository.complete).mockResolvedValue(false);

    await expect(runWorker({
      repository,
      handlers: new Map([['test.handle', vi.fn().mockResolvedValue(undefined)]]),
      workerId: 'worker-test',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 25,
      signal: controller.signal,
      sleep: async () => controller.abort()
    })).resolves.toBeUndefined();

    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('does not crash when ambiguous completion is followed by a stale failure write', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    vi.mocked(repository.complete).mockRejectedValue(new Error('ambiguous completion'));
    vi.mocked(repository.fail).mockResolvedValue(false);

    await expect(runWorker({
      repository,
      handlers: new Map([['test.handle', vi.fn().mockResolvedValue(undefined)]]),
      workerId: 'worker-test',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 25,
      signal: controller.signal,
      sleep: async () => controller.abort()
    })).resolves.toBeUndefined();

    expect(repository.fail).toHaveBeenCalledWith(
      job.id,
      'worker-test',
      'Transient job completion failure',
      true
    );
  });

  it('forwards the financial-admin capability to heartbeat and completion without logging it', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(financialAdminJob);
    const heartbeat = controlledSleep();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let releaseHandler!: () => void;
    const heldHandler = new Promise<void>((resolve) => { releaseHandler = resolve; });

    const running = runWorker({
      repository,
      handlers: new Map([[financialAdminJob.type, async () => heldHandler]]),
      workerId: 'worker-test',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 25,
      signal: controller.signal,
      heartbeatSleep: heartbeat.sleep,
      sleep: async () => controller.abort()
    });

    await vi.waitFor(() => expect(heartbeat.sleep).toHaveBeenCalledOnce());
    heartbeat.releaseNext();
    await vi.waitFor(() => expect(repository.renewLease).toHaveBeenCalledWith(
      financialAdminJob.id,
      'worker-test',
      FINANCIAL_ADMIN_LEASE_CAPABILITY
    ));
    releaseHandler();
    await running;

    expect(repository.complete).toHaveBeenCalledWith(
      financialAdminJob.id,
      'worker-test',
      FINANCIAL_ADMIN_LEASE_CAPABILITY
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(FINANCIAL_ADMIN_LEASE_CAPABILITY);
    log.mockRestore();
  });

  it.each([
    {
      name: 'permanent failure',
      record: financialAdminJob,
      handler: async () => { throw new PermanentJobError('Invalid job payload'); },
      expected: ['Invalid job payload', false] as const
    },
    {
      name: 'transient retry',
      record: financialAdminJob,
      handler: async () => { throw new Error('private transient detail'); },
      expected: ['Transient job handler failure', true] as const
    },
    {
      name: 'exhausted transient failure',
      record: { ...financialAdminJob, attempts: financialAdminJob.maxAttempts },
      handler: async () => { throw new Error('private exhausted detail'); },
      expected: ['Transient job handler failure', true] as const
    }
  ])('forwards the financial-admin capability on $name', async ({ record, handler, expected }) => {
    const controller = new AbortController();
    const repository = repositoryReturning(record);

    await runWorker({
      repository,
      handlers: new Map([[record.type, handler]]),
      workerId: 'worker-test',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 25,
      signal: controller.signal,
      sleep: async () => controller.abort()
    });

    expect(repository.fail).toHaveBeenCalledWith(
      record.id,
      'worker-test',
      expected[0],
      expected[1],
      FINANCIAL_ADMIN_LEASE_CAPABILITY
    );
  });

  it('forwards the capability to the ambiguous-completion fallback and bounds errors', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(financialAdminJob);
    vi.mocked(repository.complete).mockRejectedValue(
      new Error(`ambiguous ${FINANCIAL_ADMIN_LEASE_CAPABILITY}`)
    );

    await expect(runWorker({
      repository,
      handlers: new Map([[financialAdminJob.type, vi.fn().mockResolvedValue(undefined)]]),
      workerId: 'worker-test',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 25,
      signal: controller.signal,
      sleep: async () => controller.abort()
    })).resolves.toBeUndefined();

    expect(repository.fail).toHaveBeenCalledWith(
      financialAdminJob.id,
      'worker-test',
      'Transient job completion failure',
      true,
      FINANCIAL_ADMIN_LEASE_CAPABILITY
    );
    expect(JSON.stringify(vi.mocked(repository.fail).mock.calls))
      .toContain(FINANCIAL_ADMIN_LEASE_CAPABILITY);
    expect(vi.mocked(repository.fail).mock.calls[0]?.[2])
      .not.toContain(FINANCIAL_ADMIN_LEASE_CAPABILITY);
  });

  it('forwards the capability on unknown-handler failure', async () => {
    const controller = new AbortController();
    const record = { ...financialAdminJob, type: 'unknown.financial-admin' };
    const repository = repositoryReturning(record);

    await runWorker({
      repository,
      handlers: new Map(),
      workerId: 'worker-test',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 25,
      signal: controller.signal,
      sleep: async () => controller.abort()
    });

    expect(repository.fail).toHaveBeenCalledWith(
      record.id,
      'worker-test',
      'No handler registered for unknown.financial-admin',
      false,
      FINANCIAL_ADMIN_LEASE_CAPABILITY
    );
  });

  it.each([undefined, 'short-token'])(
    'fails closed before the handler for an invalid financial-admin capability %s',
    async (financialAdminLeaseCapability) => {
    const controller = new AbortController();
    const financialAdminJobWithoutCapability: JobRecord = {
      id: financialAdminJob.id,
      type: financialAdminJob.type,
      payload: financialAdminJob.payload,
      deduplicationKey: financialAdminJob.deduplicationKey,
      attempts: financialAdminJob.attempts,
      maxAttempts: financialAdminJob.maxAttempts,
      lockedBy: financialAdminJob.lockedBy
    };
    const record: JobRecord = financialAdminLeaseCapability === undefined
      ? financialAdminJobWithoutCapability
      : { ...financialAdminJobWithoutCapability, financialAdminLeaseCapability };
    const repository = repositoryReturning(record);
    const handler = vi.fn().mockResolvedValue(undefined);

    await expect(runWorker({
      repository,
      handlers: new Map([[record.type, handler]]),
      workerId: 'worker-test',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 25,
      signal: controller.signal,
      sleep: async () => controller.abort()
    })).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(repository.renewLease).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
    }
  );

  it('never copies the capability into a safe handler failure or propagated error', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(financialAdminJob);
    vi.mocked(repository.fail).mockRejectedValue(
      new Error(`database detail ${FINANCIAL_ADMIN_LEASE_CAPABILITY}`)
    );

    await expect(runWorker({
      repository,
      handlers: new Map([[
        financialAdminJob.type,
        async () => {
          throw new PermanentJobError(
            `unsafe ${FINANCIAL_ADMIN_LEASE_CAPABILITY}`
          );
        }
      ]]),
      workerId: 'worker-test',
      concurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 25,
      signal: controller.signal,
      sleep: async () => controller.abort()
    })).resolves.toBeUndefined();

    const safeError = vi.mocked(repository.fail).mock.calls[0]?.[2];
    expect(safeError).toBe('Permanent job handler failure');
    expect(safeError).not.toContain(FINANCIAL_ADMIN_LEASE_CAPABILITY);
  });
});
