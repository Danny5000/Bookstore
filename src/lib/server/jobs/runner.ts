import { setTimeout as delay } from 'node:timers/promises';
import type { JobHandler, JobRecord, JobRepository } from './types';

export class PermanentJobError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'PermanentJobError';
  }
}

export class JobLeaseLostError extends Error {
  constructor() {
    super('Job lease ownership was lost');
    this.name = 'JobLeaseLostError';
  }
}

type WorkerSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;
const FINANCIAL_ADMIN_COMMAND_JOB = 'commerce.financial-admin-command';
const FINANCIAL_ADMIN_LEASE_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type WorkerPollHook = (input: {
  now: Date;
  signal: AbortSignal;
}) => Promise<void>;

export interface RunWorkerOptions {
  repository: JobRepository;
  handlers: ReadonlyMap<string, JobHandler>;
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  signal: AbortSignal;
  beforePoll?: WorkerPollHook;
  sleep?: WorkerSleep;
  heartbeatSleep?: WorkerSleep;
}

type WorkerJobOptions = Omit<RunWorkerOptions, 'concurrency' | 'beforePoll'>;
type WorkerLoopOptions = WorkerJobOptions & { runBeforePoll?: () => Promise<void> };

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error: unknown) {
    if (!signal.aborted) throw error;
  }
}

interface HeartbeatOptions {
  repository: JobRepository;
  jobId: string;
  workerId: string;
  financialAdminLeaseCapability?: string;
  intervalMs: number;
  signal: AbortSignal;
  sleep: WorkerSleep;
  loseLease: () => void;
}

async function heartbeatLease(options: HeartbeatOptions): Promise<void> {
  while (!options.signal.aborted) {
    let renewed: boolean;
    try {
      await options.sleep(options.intervalMs, options.signal);
      if (options.signal.aborted) return;
      renewed = options.financialAdminLeaseCapability === undefined
        ? await options.repository.renewLease(options.jobId, options.workerId)
        : await options.repository.renewLease(
            options.jobId,
            options.workerId,
            options.financialAdminLeaseCapability
          );
    } catch {
      if (options.signal.aborted) return;
      options.loseLease();
      return;
    }
    if (options.signal.aborted) return;
    if (!renewed) {
      options.loseLease();
      return;
    }
  }
}

async function failClaimedJob(
  repository: JobRepository,
  job: JobRecord,
  workerId: string,
  safeError: string,
  retryable: boolean
): Promise<boolean> {
  try {
    return job.financialAdminLeaseCapability === undefined
      ? await repository.fail(job.id, workerId, safeError, retryable)
      : await repository.fail(
          job.id,
          workerId,
          safeError,
          retryable,
          job.financialAdminLeaseCapability
        );
  } catch (error: unknown) {
    if (job.financialAdminLeaseCapability !== undefined) return false;
    throw error;
  }
}

async function runClaimedJob(
  options: WorkerJobOptions,
  job: JobRecord
): Promise<void> {
  if (job.type === FINANCIAL_ADMIN_COMMAND_JOB &&
    (job.financialAdminLeaseCapability === undefined ||
      !FINANCIAL_ADMIN_LEASE_CAPABILITY_PATTERN.test(
        job.financialAdminLeaseCapability
      ))) return;
  const handler = options.handlers.get(job.type);
  if (!handler) {
    await failClaimedJob(
      options.repository,
      job,
      options.workerId,
      `No handler registered for ${job.type}`,
      false
    );
    return;
  }

  const handlerController = new AbortController();
  const heartbeatController = new AbortController();
  let leaseLost = false;
  const loseLease = () => {
    if (leaseLost) return;
    leaseLost = true;
    handlerController.abort(new JobLeaseLostError());
    heartbeatController.abort();
  };
  const forwardShutdown = () => {
    handlerController.abort(options.signal.reason);
    heartbeatController.abort(options.signal.reason);
  };
  if (options.signal.aborted) forwardShutdown();
  else options.signal.addEventListener('abort', forwardShutdown, { once: true });

  const heartbeat = heartbeatLease({
    repository: options.repository,
    jobId: job.id,
    workerId: options.workerId,
    ...(job.financialAdminLeaseCapability === undefined
      ? {}
      : { financialAdminLeaseCapability: job.financialAdminLeaseCapability }),
    intervalMs: options.heartbeatIntervalMs,
    signal: heartbeatController.signal,
    sleep: options.heartbeatSleep ?? abortableSleep,
    loseLease
  });

  let handlerFailed = false;
  let handlerError: unknown;
  try {
    await handler(job, handlerController.signal);
  } catch (error: unknown) {
    handlerFailed = true;
    handlerError = error;
  } finally {
    heartbeatController.abort();
    await heartbeat;
    options.signal.removeEventListener('abort', forwardShutdown);
  }

  if (leaseLost) return;
  if (handlerFailed) {
    let safeMessage = handlerError instanceof PermanentJobError
      ? handlerError.safeMessage
      : 'Transient job handler failure';
    if (job.financialAdminLeaseCapability !== undefined &&
      safeMessage.includes(job.financialAdminLeaseCapability)) {
      safeMessage = 'Permanent job handler failure';
    }
    const retryable = !(handlerError instanceof PermanentJobError);
    const failed = await failClaimedJob(
      options.repository,
      job,
      options.workerId,
      safeMessage,
      retryable
    );
    if (!failed) loseLease();
    return;
  }

  try {
    const completed = job.financialAdminLeaseCapability === undefined
      ? await options.repository.complete(job.id, options.workerId)
      : await options.repository.complete(
          job.id,
          options.workerId,
          job.financialAdminLeaseCapability
        );
    if (!completed) loseLease();
  } catch {
    const failed = await failClaimedJob(
      options.repository,
      job,
      options.workerId,
      'Transient job completion failure',
      true
    );
    if (!failed) loseLease();
  }
}

async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;

  while (!options.signal.aborted) {
    await options.runBeforePoll?.();
    if (options.signal.aborted) return;
    const job = await options.repository.claimNext(options.workerId);
    if (!job) {
      await sleep(options.pollIntervalMs, options.signal);
      continue;
    }

    await runClaimedJob(options, job);
  }
}

export async function runWorker(options: RunWorkerOptions): Promise<void> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new RangeError('Worker concurrency must be a positive integer');
  }
  if (!Number.isSafeInteger(options.heartbeatIntervalMs) || options.heartbeatIntervalMs < 1) {
    throw new RangeError('Worker heartbeat interval must be a positive integer');
  }
  let hookTail = Promise.resolve();
  const runBeforePoll = options.beforePoll
    ? async () => {
        const previous = hookTail;
        let release!: () => void;
        hookTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          if (!options.signal.aborted) {
            await options.beforePoll!({ now: new Date(), signal: options.signal });
          }
        } catch {
          if (!options.signal.aborted) console.error('[jobs] worker poll hook failed');
        } finally {
          release();
        }
      }
    : undefined;
  await Promise.all(
    Array.from({ length: options.concurrency }, (_, slot) =>
      runWorkerLoop({
        repository: options.repository,
        handlers: options.handlers,
        workerId: options.concurrency === 1 ? options.workerId : `${options.workerId}:${slot}`,
        pollIntervalMs: options.pollIntervalMs,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        signal: options.signal,
        ...(runBeforePoll ? { runBeforePoll } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.heartbeatSleep ? { heartbeatSleep: options.heartbeatSleep } : {})
      })
    )
  );
}
