import { describe, expect, it, vi } from 'vitest';
import { getDiagnosticContext } from '../observability/context';
import { createStructuredLogger } from '../observability/logger';
import {
  createRunnerObserver,
  type JobAttemptIdentity,
  type RunnerObservation,
  type RunnerObserver
} from './runner-observer';
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
const GENERATED_CORRELATION_ID = '11111111-2222-4333-8444-555555555555';
const financialAdminJob: JobRecord = {
  ...job,
  id: 'f1f46ee7-3170-40ea-bfad-d55a734bf380',
  type: 'commerce.financial-admin-command',
  payload: { commandId: 'f1f46ee7-3170-40ea-bfad-d55a734bf381' },
  deduplicationKey:
    'commerce:financial-admin-command:f1f46ee7-3170-40ea-bfad-d55a734bf381:v1',
  financialAdminLeaseCapability: FINANCIAL_ADMIN_LEASE_CAPABILITY
};

function captureObservations(): {
  readonly events: RunnerObservation[];
  readonly observer: RunnerObserver;
} {
  const events: RunnerObservation[] = [];
  return { events, observer: (event) => events.push(event) };
}

function jobEvents(events: readonly RunnerObservation[]): RunnerObservation[] {
  return events.filter((event) => event.type.startsWith('job_'));
}

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
      ? {
          applied: true,
          retryScheduled: failureArguments[3] && record.attempts < record.maxAttempts
        }
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
  it('models an exhausted transient failure as terminal in the in-memory adapter', async () => {
    const exhausted = { ...job, attempts: job.maxAttempts };
    const repository = repositoryReturning(exhausted);

    await expect(repository.failWithDisposition(
      exhausted.id,
      exhausted.lockedBy,
      'Transient job handler failure',
      true
    )).resolves.toEqual({ applied: true, retryScheduled: false });
  });

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
      leaseRenewalIntervalMs: 1,
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
      leaseRenewalIntervalMs: 1,
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
      leaseRenewalIntervalMs: 1,
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
      leaseRenewalIntervalMs: 1,
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
      leaseRenewalIntervalMs: 1,
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
      leaseRenewalIntervalMs: 1,
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
        ? {
            applied: true,
            retryScheduled: failureArguments[3] && job.attempts < job.maxAttempts
          }
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
      leaseRenewalIntervalMs: 1,
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
      leaseRenewalIntervalMs: 25,
      signal: controller.signal,
      leaseRenewalSleep: heartbeat.sleep,
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
      leaseRenewalIntervalMs: 25,
      signal: controller.signal,
      leaseRenewalSleep: heartbeat.sleep,
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
      leaseRenewalIntervalMs: 25,
      signal: controller.signal,
      leaseRenewalSleep: heartbeat.sleep,
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
      leaseRenewalIntervalMs: 25,
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
      leaseRenewalIntervalMs: 25,
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
      leaseRenewalIntervalMs: 25,
      signal: controller.signal,
      leaseRenewalSleep: heartbeat.sleep,
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
      leaseRenewalIntervalMs: 25,
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
      leaseRenewalIntervalMs: 25,
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
      leaseRenewalIntervalMs: 25,
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
      leaseRenewalIntervalMs: 25,
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
      leaseRenewalIntervalMs: 25,
      signal: controller.signal,
      sleep: async () => controller.abort()
    })).resolves.toBeUndefined();

    const safeError = vi.mocked(repository.fail).mock.calls[0]?.[2];
    expect(safeError).toBe('Permanent job handler failure');
    expect(safeError).not.toContain(FINANCIAL_ADMIN_LEASE_CAPABILITY);
  });

  it('reports polling before the serialized hook and claim, then an empty successful poll before sleep', async () => {
    const controller = new AbortController();
    const trace: string[] = [];
    const repository = repositoryReturning(job);
    vi.mocked(repository.claimNext).mockReset().mockImplementation(async () => {
      trace.push('claim');
      return null;
    });

    await runWorker({
      repository,
      handlers: new Map(),
      workerId: 'worker-poll-progress',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: (event) => trace.push(
        event.type === 'poll_succeeded'
          ? `${event.type}:${event.claimed}`
          : event.type
      ),
      beforePoll: async () => { trace.push('hook'); },
      sleep: async () => {
        trace.push('sleep');
        controller.abort();
      }
    });

    expect(trace).toEqual([
      'polling',
      'hook',
      'claim',
      'poll_succeeded:false',
      'sleep'
    ]);
  });

  it('reports a successful claim before constructing one stable correlated attempt identity', async () => {
    const controller = new AbortController();
    const captured = captureObservations();
    const repository = repositoryReturning(job);
    const correlationIdSource = vi.fn(() => GENERATED_CORRELATION_ID);
    const clockTrace: string[] = [];
    const times = [100, 137];
    const monotonicNow = vi.fn(() => {
      const value = times.shift();
      if (value === undefined) throw new Error('unexpected monotonic clock read');
      clockTrace.push(value === 100 ? 'clock:start' : 'clock:end');
      return value;
    });
    vi.mocked(repository.complete).mockImplementation(async () => {
      clockTrace.push('complete');
      expect(getDiagnosticContext()).toEqual({
        kind: 'job',
        correlationId: GENERATED_CORRELATION_ID,
        jobId: job.id,
        jobKind: job.type,
        attempt: job.attempts,
        workerId: 'worker-base',
        slotId: 0
      });
      return true;
    });
    const handler = vi.fn(async () => {
      expect(getDiagnosticContext()).toEqual({
        kind: 'job',
        correlationId: GENERATED_CORRELATION_ID,
        jobId: job.id,
        jobKind: job.type,
        attempt: job.attempts,
        workerId: 'worker-base',
        slotId: 0
      });
    });

    await runWorker({
      repository,
      handlers: new Map([[job.type, handler]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource,
      monotonicNow,
      sleep: async () => controller.abort()
    });

    const firstPoll = captured.events[1];
    const claimed = captured.events.find(
      (event): event is Extract<RunnerObservation, { type: 'job_claimed' }> =>
        event.type === 'job_claimed'
    );
    const succeeded = captured.events.find(
      (event): event is Extract<RunnerObservation, { type: 'job_succeeded' }> =>
        event.type === 'job_succeeded'
    );
    expect(firstPoll).toEqual({ type: 'poll_succeeded', slotId: 0, claimed: true });
    expect(claimed).toBeDefined();
    expect(succeeded).toBeDefined();
    expect(succeeded!.identity).toBe(claimed!.identity);
    expect(claimed!.identity).toEqual({
      correlationId: GENERATED_CORRELATION_ID,
      jobId: job.id,
      jobKind: job.type,
      attempt: 1,
      maxAttempts: 5,
      workerId: 'worker-base',
      slotId: 0
    });
    expect(succeeded!.durationMs).toBe(37);
    expect(correlationIdSource).toHaveBeenCalledOnce();
    expect(clockTrace).toEqual(['clock:start', 'complete', 'clock:end']);
    expect(captured.events).toContainEqual({ type: 'terminal_settled', slotId: 0 });
    expect(getDiagnosticContext()).toBeUndefined();
  });

  it('uses valid supplied correlation and positive signed-int32 generation without generating a UUID', async () => {
    const controller = new AbortController();
    const captured = captureObservations();
    const repository = repositoryReturning(job);
    const correlationIdSource = vi.fn(() => GENERATED_CORRELATION_ID);
    const parseJobDiagnosticMetadata = vi.fn(() => ({
      correlationId: 'Scheduler.Correlation:ABC',
      generation: 2_147_483_647
    }));

    await runWorker({
      repository,
      handlers: new Map([[job.type, vi.fn().mockResolvedValue(undefined)]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      parseJobDiagnosticMetadata,
      correlationIdSource,
      sleep: async () => controller.abort()
    });

    const identities = jobEvents(captured.events).map((event) =>
      (event as Extract<RunnerObservation, { identity: JobAttemptIdentity }>).identity
    );
    expect(parseJobDiagnosticMetadata).toHaveBeenCalledExactlyOnceWith(job);
    expect(correlationIdSource).not.toHaveBeenCalled();
    expect(identities).not.toHaveLength(0);
    expect(identities.every((value) => value === identities[0])).toBe(true);
    expect(identities[0]).toMatchObject({
      correlationId: 'Scheduler.Correlation:ABC',
      generation: 2_147_483_647
    });
  });

  it.each([
    {
      name: 'invalid result',
      parser: () => ({ correlationId: ' invalid', generation: 0 })
    },
    {
      name: 'throwing parser',
      parser: () => { throw new Error('metadata-parser-privacy-canary'); }
    }
  ])('falls back safely for a $name without changing job handling', async ({ parser }) => {
    const controller = new AbortController();
    const captured = captureObservations();
    const repository = repositoryReturning(job);
    const handler = vi.fn().mockResolvedValue(undefined);
    const correlationIdSource = vi.fn(() => GENERATED_CORRELATION_ID);

    await runWorker({
      repository,
      handlers: new Map([[job.type, handler]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      parseJobDiagnosticMetadata: parser,
      correlationIdSource,
      sleep: async () => controller.abort()
    });

    const claimed = captured.events.find(
      (event): event is Extract<RunnerObservation, { type: 'job_claimed' }> =>
        event.type === 'job_claimed'
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(repository.complete).toHaveBeenCalledOnce();
    expect(correlationIdSource).toHaveBeenCalledOnce();
    expect(claimed?.identity.correlationId).toBe(GENERATED_CORRELATION_ID);
    expect(claimed?.identity).not.toHaveProperty('generation');
    expect(JSON.stringify(captured.events)).not.toContain('metadata-parser-privacy-canary');
  });

  it('checks handler registration before treating an unregistered unsafe type as a loggable job kind', async () => {
    const controller = new AbortController();
    const record = { ...job, type: 'Unsafe Kind person@example.test' };
    const repository = repositoryReturning(record);
    const captured = captureObservations();

    await expect(runWorker({
      repository,
      handlers: new Map(),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID,
      sleep: async () => controller.abort()
    })).resolves.toBeUndefined();

    expect(repository.failWithDisposition).toHaveBeenCalledWith(
      record.id,
      'worker-base',
      `No handler registered for ${record.type}`,
      false
    );
    expect(jobEvents(captured.events)).toEqual([]);
    expect(captured.events).toContainEqual({ type: 'terminal_settled', slotId: 0 });
  });

  it('keeps the base worker identity and zero-based slots in observations while repository ownership stays unchanged', async () => {
    const controller = new AbortController();
    const captured = captureObservations();
    const claimedOwners = new Set<string>();
    const complete = vi.fn().mockResolvedValue(true);
    const fail = vi.fn().mockResolvedValue(true);
    const repository: JobRepository = {
      claimNext: vi.fn(async (leaseOwner: string) => {
        if (claimedOwners.has(leaseOwner)) return null;
        claimedOwners.add(leaseOwner);
        return {
          ...job,
          id: leaseOwner.endsWith(':0')
            ? '11111111-1111-4111-8111-111111111110'
            : '11111111-1111-4111-8111-111111111111',
          lockedBy: leaseOwner
        };
      }),
      renewLease: vi.fn().mockResolvedValue(true),
      complete,
      fail,
      failWithDisposition: vi.fn().mockResolvedValue({
        applied: true,
        retryScheduled: false
      })
    };
    let releaseHandlers!: () => void;
    const heldHandlers = new Promise<void>((resolve) => { releaseHandlers = resolve; });
    const handler = vi.fn(async () => heldHandlers);

    const running = runWorker({
      repository,
      handlers: new Map([[job.type, handler]]),
      workerId: 'worker-base',
      concurrency: 2,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID,
      sleep: async () => controller.abort()
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    releaseHandlers();
    await running;

    const claimed = captured.events.filter(
      (event): event is Extract<RunnerObservation, { type: 'job_claimed' }> =>
        event.type === 'job_claimed'
    );
    expect(claimed.map((event) => ({
      workerId: event.identity.workerId,
      slotId: event.identity.slotId
    }))).toEqual(expect.arrayContaining([
      { workerId: 'worker-base', slotId: 0 },
      { workerId: 'worker-base', slotId: 1 }
    ]));
    expect(claimedOwners).toEqual(new Set(['worker-base:0', 'worker-base:1']));
    expect(complete.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining(['worker-base:0', 'worker-base:1'])
    );
  });

  it('reports each successful lease renewal without creating a terminal observation', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    const captured = captureObservations();
    const renewal = controlledSleep();
    let releaseHandler!: () => void;
    const heldHandler = new Promise<void>((resolve) => { releaseHandler = resolve; });

    const running = runWorker({
      repository,
      handlers: new Map([[job.type, async () => heldHandler]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 25,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID,
      leaseRenewalSleep: renewal.sleep,
      sleep: async () => controller.abort()
    });
    await vi.waitFor(() => expect(renewal.sleep).toHaveBeenCalledOnce());
    renewal.releaseNext();
    await vi.waitFor(() => expect(repository.renewLease).toHaveBeenCalledOnce());

    expect(captured.events).toContainEqual({ type: 'lease_renewed', slotId: 0 });
    expect(jobEvents(captured.events).filter((event) =>
      event.type !== 'job_claimed'
    )).toEqual([]);
    releaseHandler();
    await running;
  });

  it.each([
    {
      name: 'rejection',
      renewal: () => Promise.resolve(false),
      code: 'lease_renewal_rejected'
    },
    {
      name: 'failure',
      renewal: () => Promise.reject(new Error('renewal-privacy-canary')),
      code: 'lease_renewal_failed'
    }
  ] as const)('reports one lease-loss outcome for lease renewal $name', async ({ renewal, code }) => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    vi.mocked(repository.renewLease).mockImplementation(renewal);
    const captured = captureObservations();
    const controlledRenewal = controlledSleep();
    const handler = vi.fn(async (_record: JobRecord, signal: AbortSignal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {
        once: true
      }));
    });

    const running = runWorker({
      repository,
      handlers: new Map([[job.type, handler]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 25,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID,
      leaseRenewalSleep: controlledRenewal.sleep,
      sleep: async () => controller.abort()
    });
    await vi.waitFor(() => expect(controlledRenewal.sleep).toHaveBeenCalledOnce());
    controlledRenewal.releaseNext();
    await running;

    const terminal = jobEvents(captured.events).filter((event) =>
      event.type !== 'job_claimed'
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: 'job_lease_lost', code });
    expect(captured.events.filter((event) => event.type === 'lease_lost')).toEqual([
      { type: 'lease_lost', slotId: 0 }
    ]);
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.failWithDisposition).not.toHaveBeenCalled();
    expect(JSON.stringify(captured.events)).not.toContain('renewal-privacy-canary');
  });

  it('emits succeeded and terminal progress only after completion is applied', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    const captured = captureObservations();

    await runWorker({
      repository,
      handlers: new Map([[job.type, vi.fn().mockResolvedValue(undefined)]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID,
      monotonicNow: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(25),
      sleep: async () => controller.abort()
    });

    expect(jobEvents(captured.events).map((event) => event.type)).toEqual([
      'job_claimed',
      'job_succeeded'
    ]);
    expect(jobEvents(captured.events)[1]).toMatchObject({ durationMs: 15 });
    expect(captured.events).toContainEqual({ type: 'terminal_settled', slotId: 0 });
  });

  it('maps complete=false to completion_rejected and lease_lost without success or terminal progress', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    vi.mocked(repository.complete).mockResolvedValue(false);
    const captured = captureObservations();

    await runWorker({
      repository,
      handlers: new Map([[job.type, vi.fn().mockResolvedValue(undefined)]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID,
      sleep: async () => controller.abort()
    });

    expect(jobEvents(captured.events).map((event) =>
      event.type === 'job_lease_lost' ? `${event.type}:${event.code}` : event.type
    )).toEqual(['job_claimed', 'job_lease_lost:completion_rejected']);
    expect(captured.events).toContainEqual({ type: 'lease_lost', slotId: 0 });
    expect(captured.events).not.toContainEqual({ type: 'terminal_settled', slotId: 0 });
  });

  it('maps an ambiguous completion followed by an applied failure to job_completion_failed and committed retry disposition', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    vi.mocked(repository.complete).mockRejectedValue(new Error('completion-privacy-canary'));
    vi.mocked(repository.failWithDisposition).mockResolvedValue({
      applied: true,
      retryScheduled: true
    });
    const captured = captureObservations();

    await runWorker({
      repository,
      handlers: new Map([[job.type, vi.fn().mockResolvedValue(undefined)]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID,
      monotonicNow: vi.fn().mockReturnValueOnce(50).mockReturnValueOnce(70),
      sleep: async () => controller.abort()
    });

    expect(repository.failWithDisposition).toHaveBeenCalledWith(
      job.id,
      'worker-base',
      'Transient job completion failure',
      true
    );
    expect(jobEvents(captured.events)[1]).toMatchObject({
      type: 'job_failed',
      code: 'job_completion_failed',
      durationMs: 20,
      retryScheduled: true
    });
    expect(captured.events).toContainEqual({ type: 'terminal_settled', slotId: 0 });
    expect(JSON.stringify(captured.events)).not.toContain('completion-privacy-canary');
  });

  it.each([
    {
      name: 'transient failure',
      record: job,
      error: new Error('handler-transient-privacy-canary'),
      persisted: 'Transient job handler failure',
      code: 'unexpected_failure',
      retryScheduled: true
    },
    {
      name: 'permanent failure',
      record: job,
      error: new PermanentJobError('Bounded permanent reason'),
      persisted: 'Bounded permanent reason',
      code: 'permanent_job_failure',
      retryScheduled: false
    },
    {
      name: 'exhausted transient failure',
      record: { ...job, attempts: job.maxAttempts },
      error: new Error('handler-exhausted-privacy-canary'),
      persisted: 'Transient job handler failure',
      code: 'unexpected_failure',
      retryScheduled: false
    }
  ] as const)('uses safe $name vocabulary and the committed disposition', async ({
    record,
    error,
    persisted,
    code,
    retryScheduled
  }) => {
    const controller = new AbortController();
    const repository = repositoryReturning(record);
    const captured = captureObservations();

    await runWorker({
      repository,
      handlers: new Map([[record.type, async () => { throw error; }]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID,
      monotonicNow: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(105),
      sleep: async () => controller.abort()
    });

    expect(repository.failWithDisposition).toHaveBeenCalledWith(
      record.id,
      'worker-base',
      persisted,
      code === 'unexpected_failure'
    );
    expect(jobEvents(captured.events)[1]).toMatchObject({
      type: 'job_failed',
      code,
      durationMs: 5,
      retryScheduled
    });
    expect(captured.events).toContainEqual({ type: 'terminal_settled', slotId: 0 });
    expect(JSON.stringify(captured.events)).not.toContain('privacy-canary');
    if (error instanceof PermanentJobError) {
      expect(JSON.stringify(captured.events)).not.toContain(error.safeMessage);
    }
  });

  it('maps an applied-false handler failure transition to failure_transition_rejected without failed or terminal progress', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    vi.mocked(repository.failWithDisposition).mockResolvedValue({ applied: false });
    const captured = captureObservations();

    await runWorker({
      repository,
      handlers: new Map([[job.type, async () => { throw new Error('private'); }]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID,
      sleep: async () => controller.abort()
    });

    expect(jobEvents(captured.events).map((event) =>
      event.type === 'job_lease_lost' ? `${event.type}:${event.code}` : event.type
    )).toEqual(['job_claimed', 'job_lease_lost:failure_transition_rejected']);
    expect(captured.events).toContainEqual({ type: 'lease_lost', slotId: 0 });
    expect(captured.events).not.toContainEqual({ type: 'terminal_settled', slotId: 0 });
  });

  it('observes an ordinary failure-transition throw and rethrows the identical error', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    const transitionError = new Error('failure-transition-privacy-canary');
    vi.mocked(repository.failWithDisposition).mockRejectedValue(transitionError);
    const captured = captureObservations();

    await expect(runWorker({
      repository,
      handlers: new Map([[job.type, async () => { throw new Error('handler-private'); }]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID
    })).rejects.toBe(transitionError);

    expect(jobEvents(captured.events)[1]).toMatchObject({
      type: 'job_lease_lost',
      code: 'failure_transition_failed'
    });
    expect(captured.events).toContainEqual({ type: 'lease_lost', slotId: 0 });
    expect(JSON.stringify(captured.events)).not.toContain('failure-transition-privacy-canary');
  });

  it('retains capability failure-transition catch-to-false behavior and reports rejection', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(financialAdminJob);
    vi.mocked(repository.failWithDisposition).mockRejectedValue(
      new Error(`private ${FINANCIAL_ADMIN_LEASE_CAPABILITY}`)
    );
    const captured = captureObservations();

    await expect(runWorker({
      repository,
      handlers: new Map([[
        financialAdminJob.type,
        async () => { throw new Error('private handler'); }
      ]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID,
      sleep: async () => controller.abort()
    })).resolves.toBeUndefined();

    expect(repository.failWithDisposition).toHaveBeenCalledWith(
      financialAdminJob.id,
      'worker-base',
      'Transient job handler failure',
      true,
      FINANCIAL_ADMIN_LEASE_CAPABILITY
    );
    expect(jobEvents(captured.events)[1]).toMatchObject({
      type: 'job_lease_lost',
      code: 'failure_transition_rejected'
    });
    expect(JSON.stringify(captured.events)).not.toContain(FINANCIAL_ADMIN_LEASE_CAPABILITY);
  });

  it.each([undefined, 'short-token'])(
    'emits claimed then lease_capability_invalid for a registered malformed financial capability %s',
    async (financialAdminLeaseCapability) => {
      const controller = new AbortController();
      const record: JobRecord = {
        id: financialAdminJob.id,
        type: financialAdminJob.type,
        payload: financialAdminJob.payload,
        deduplicationKey: financialAdminJob.deduplicationKey,
        attempts: financialAdminJob.attempts,
        maxAttempts: financialAdminJob.maxAttempts,
        lockedBy: financialAdminJob.lockedBy,
        ...(financialAdminLeaseCapability === undefined
          ? {}
          : { financialAdminLeaseCapability })
      };
      const repository = repositoryReturning(record);
      const handler = vi.fn().mockResolvedValue(undefined);
      const captured = captureObservations();

      await runWorker({
        repository,
        handlers: new Map([[record.type, handler]]),
        workerId: 'worker-base',
        concurrency: 1,
        pollIntervalMs: 1,
        leaseRenewalIntervalMs: 10_000,
        signal: controller.signal,
        observer: captured.observer,
        correlationIdSource: () => GENERATED_CORRELATION_ID,
        sleep: async () => controller.abort()
      });

      expect(jobEvents(captured.events).map((event) =>
        event.type === 'job_lease_lost' ? `${event.type}:${event.code}` : event.type
      )).toEqual(['job_claimed', 'job_lease_lost:lease_capability_invalid']);
      expect(captured.events).toContainEqual({ type: 'lease_lost', slotId: 0 });
      expect(handler).not.toHaveBeenCalled();
      expect(repository.complete).not.toHaveBeenCalled();
      expect(repository.failWithDisposition).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])(
    'keeps unknown-kind persistence unstructured and reports terminal progress only when applied=%s',
    async (applied) => {
      const controller = new AbortController();
      const record = { ...job, type: 'unknown.kind' };
      const repository = repositoryReturning(record);
      vi.mocked(repository.failWithDisposition).mockResolvedValue(
        applied ? { applied: true, retryScheduled: false } : { applied: false }
      );
      const captured = captureObservations();

      await runWorker({
        repository,
        handlers: new Map(),
        workerId: 'worker-base',
        concurrency: 1,
        pollIntervalMs: 1,
        leaseRenewalIntervalMs: 10_000,
        signal: controller.signal,
        observer: captured.observer,
        correlationIdSource: () => GENERATED_CORRELATION_ID,
        sleep: async () => controller.abort()
      });

      expect(repository.failWithDisposition).toHaveBeenCalledWith(
        record.id,
        'worker-base',
        'No handler registered for unknown.kind',
        false
      );
      expect(jobEvents(captured.events)).toEqual([]);
      expect(captured.events.filter((event) => event.type === 'terminal_settled')).toEqual(
        applied ? [{ type: 'terminal_settled', slotId: 0 }] : []
      );
    }
  );

  it('keeps the one bounded poll-hook diagnostic and advances poll progress only after claim succeeds', async () => {
    const controller = new AbortController();
    const trace: string[] = [];
    const repository = repositoryReturning(job);
    vi.mocked(repository.claimNext).mockReset().mockResolvedValue(null);
    let hookCalls = 0;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runWorker({
      repository,
      handlers: new Map(),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: (event) => trace.push(
        event.type === 'poll_succeeded'
          ? `${event.type}:${event.claimed}`
          : event.type
      ),
      beforePoll: async () => {
        hookCalls += 1;
        if (hookCalls === 1) throw new Error('poll-hook-privacy-canary');
        controller.abort();
      },
      sleep: async () => undefined
    });

    expect(trace).toEqual([
      'polling',
      'poll_succeeded:false',
      'polling'
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[jobs] worker poll hook failed');
    expect(JSON.stringify(log.mock.calls)).not.toContain('poll-hook-privacy-canary');
    log.mockRestore();
  });

  it('leaves claimNext failure unhandled and never reports a successful poll', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    const claimError = new Error('claim-failure-privacy-canary');
    vi.mocked(repository.claimNext).mockReset().mockRejectedValue(claimError);
    const captured = captureObservations();

    await expect(runWorker({
      repository,
      handlers: new Map(),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer
    })).rejects.toBe(claimError);

    expect(captured.events).toEqual([{ type: 'polling', slotId: 0 }]);
  });

  it('preserves shutdown signal forwarding and settles a handler that resolves after abort', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    const captured = captureObservations();
    let handlerSignal: AbortSignal | undefined;
    const handler = vi.fn(async (_record: JobRecord, signal: AbortSignal) => {
      handlerSignal = signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {
        once: true
      }));
    });

    const running = runWorker({
      repository,
      handlers: new Map([[job.type, handler]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: captured.observer,
      correlationIdSource: () => GENERATED_CORRELATION_ID
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    controller.abort(new Error('shutdown-private-reason'));
    await running;

    expect(handlerSignal?.aborted).toBe(true);
    expect(repository.complete).toHaveBeenCalledWith(job.id, 'worker-base');
    expect(jobEvents(captured.events).map((event) => event.type)).toEqual([
      'job_claimed',
      'job_succeeded'
    ]);
    expect(captured.events).toContainEqual({ type: 'terminal_settled', slotId: 0 });
    expect(JSON.stringify(captured.events)).not.toContain('shutdown-private-reason');
  });

  it('keeps repository and handler outcomes unchanged when the production log sink fails', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    const handler = vi.fn().mockResolvedValue(undefined);
    const fallbackLines: string[] = [];
    const reportSlotProgress = vi.fn();
    const logger = createStructuredLogger({
      service: 'worker',
      environment: 'production',
      now: () => new Date('2026-08-26T12:34:56.789Z'),
      stdout: () => { throw new Error('runner-sink-privacy-canary'); },
      stderr: (line) => fallbackLines.push(line)
    });

    await expect(runWorker({
      repository,
      handlers: new Map([[job.type, handler]]),
      workerId: 'worker-base',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 10_000,
      signal: controller.signal,
      observer: createRunnerObserver({ logger, reportSlotProgress }),
      correlationIdSource: () => GENERATED_CORRELATION_ID,
      sleep: async () => controller.abort()
    })).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledOnce();
    expect(repository.complete).toHaveBeenCalledWith(job.id, 'worker-base');
    expect(repository.failWithDisposition).not.toHaveBeenCalled();
    expect(reportSlotProgress).toHaveBeenCalledWith({
      type: 'terminal_settled',
      slotId: 0
    });
    expect(fallbackLines).toHaveLength(2);
    expect(fallbackLines.every((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      return event.event === 'logging.failure' && !line.includes('privacy-canary');
    })).toBe(true);
  });
});
