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

interface RunWorkerOptions {
  repository: JobRepository;
  handlers: ReadonlyMap<string, JobHandler>;
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  signal: AbortSignal;
  sleep?: WorkerSleep;
  heartbeatSleep?: WorkerSleep;
}

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
      renewed = await options.repository.renewLease(options.jobId, options.workerId);
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

async function runClaimedJob(
  options: Omit<RunWorkerOptions, 'concurrency'>,
  job: JobRecord
): Promise<void> {
  const handler = options.handlers.get(job.type);
  if (!handler) {
    await options.repository.fail(
      job.id,
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
    const safeMessage = handlerError instanceof PermanentJobError
      ? handlerError.safeMessage
      : 'Transient job handler failure';
    const retryable = !(handlerError instanceof PermanentJobError);
    const failed = await options.repository.fail(
      job.id,
      options.workerId,
      safeMessage,
      retryable
    );
    if (!failed) loseLease();
    return;
  }

  try {
    const completed = await options.repository.complete(job.id, options.workerId);
    if (!completed) loseLease();
  } catch {
    const failed = await options.repository.fail(
      job.id,
      options.workerId,
      'Transient job completion failure',
      true
    );
    if (!failed) loseLease();
  }
}

async function runWorkerLoop(options: Omit<RunWorkerOptions, 'concurrency'>): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;

  while (!options.signal.aborted) {
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
  await Promise.all(
    Array.from({ length: options.concurrency }, (_, slot) =>
      runWorkerLoop({
        repository: options.repository,
        handlers: options.handlers,
        workerId: options.concurrency === 1 ? options.workerId : `${options.workerId}:${slot}`,
        pollIntervalMs: options.pollIntervalMs,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        signal: options.signal,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.heartbeatSleep ? { heartbeatSleep: options.heartbeatSleep } : {})
      })
    )
  );
}
