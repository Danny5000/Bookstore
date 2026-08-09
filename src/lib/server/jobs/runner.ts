import { setTimeout as delay } from 'node:timers/promises';
import type { JobHandler, JobRepository } from './types';

export class PermanentJobError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'PermanentJobError';
  }
}

interface RunWorkerOptions {
  repository: JobRepository;
  handlers: ReadonlyMap<string, JobHandler>;
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  signal: AbortSignal;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error: unknown) {
    if (!signal.aborted) throw error;
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

    const handler = options.handlers.get(job.type);
    if (!handler) {
      await options.repository.fail(
        job.id,
        options.workerId,
        `No handler registered for ${job.type}`,
        false
      );
      continue;
    }

    try {
      await handler(job, options.signal);
      await options.repository.complete(job.id, options.workerId);
    } catch (error: unknown) {
      const permanent = error instanceof PermanentJobError;
      await options.repository.fail(
        job.id,
        options.workerId,
        permanent ? error.safeMessage : 'Transient job handler failure',
        !permanent
      );
    }
  }
}

export async function runWorker(options: RunWorkerOptions): Promise<void> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new RangeError('Worker concurrency must be a positive integer');
  }
  await Promise.all(
    Array.from({ length: options.concurrency }, (_, slot) =>
      runWorkerLoop({
        repository: options.repository,
        handlers: options.handlers,
        workerId: options.concurrency === 1 ? options.workerId : `${options.workerId}:${slot}`,
        pollIntervalMs: options.pollIntervalMs,
        signal: options.signal,
        ...(options.sleep ? { sleep: options.sleep } : {})
      })
    )
  );
}
