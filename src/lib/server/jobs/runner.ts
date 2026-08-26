import { setTimeout as delay } from 'node:timers/promises';

import {
  normalizeOrCreateCorrelationId,
  runWithDiagnosticContext
} from '../observability/context';
import {
  isCanonicalLowercaseUuid,
  isNonnegativeSignedInt32,
  isPositiveSignedInt32,
  isSafeToken,
  isWorkerId
} from '../observability/contracts';
import {
  createSafeDiagnosticError,
  defineSafeCode,
  reduceSafeError
} from '../observability/safe-error';
import type {
  JobAttemptIdentity,
  JobDiagnosticMetadataParser,
  JobFailureLogCode,
  JobLeaseLostLogCode,
  RunnerObserver
} from './runner-observer';
import type {
  JobFailureTransition,
  JobHandler,
  JobRecord,
  JobRepository
} from './types';

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
const MAX_DURATION_MS = 86_400_000;

const PERMANENT_JOB_FAILURE = defineSafeCode('permanent_job_failure');
const JOB_COMPLETION_FAILED = defineSafeCode('job_completion_failed');
const LEASE_CAPABILITY_INVALID = defineSafeCode('lease_capability_invalid');
const LEASE_RENEWAL_REJECTED = defineSafeCode('lease_renewal_rejected');
const LEASE_RENEWAL_FAILED = defineSafeCode('lease_renewal_failed');
const COMPLETION_REJECTED = defineSafeCode('completion_rejected');
const FAILURE_TRANSITION_REJECTED = defineSafeCode('failure_transition_rejected');
const FAILURE_TRANSITION_FAILED = defineSafeCode('failure_transition_failed');
const NOOP_OBSERVER: RunnerObserver = () => undefined;

export type WorkerPollHook = (input: {
  now: Date;
  signal: AbortSignal;
}) => Promise<void>;

export interface RunWorkerOptions {
  readonly repository: JobRepository;
  readonly handlers: ReadonlyMap<string, JobHandler>;
  readonly workerId: string;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly leaseRenewalIntervalMs: number;
  readonly signal: AbortSignal;
  readonly beforePoll?: WorkerPollHook;
  readonly sleep?: WorkerSleep;
  readonly leaseRenewalSleep?: WorkerSleep;
  readonly observer?: RunnerObserver;
  readonly parseJobDiagnosticMetadata?: JobDiagnosticMetadataParser;
  readonly correlationIdSource?: () => string;
  readonly monotonicNow?: () => number;
}

interface WorkerJobOptions {
  readonly repository: JobRepository;
  readonly handlers: ReadonlyMap<string, JobHandler>;
  readonly workerId: string;
  readonly leaseOwner: string;
  readonly slotId: number;
  readonly leaseRenewalIntervalMs: number;
  readonly signal: AbortSignal;
  readonly leaseRenewalSleep?: WorkerSleep;
  readonly observer: RunnerObserver;
  readonly parseJobDiagnosticMetadata?: JobDiagnosticMetadataParser;
  readonly correlationIdSource?: () => string;
  readonly monotonicNow: () => number;
}

interface WorkerLoopOptions extends WorkerJobOptions {
  readonly pollIntervalMs: number;
  readonly sleep?: WorkerSleep;
  readonly runBeforePoll?: () => Promise<void>;
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error: unknown) {
    if (!signal.aborted) throw error;
  }
}

function normalizeDuration(startedAt: number, endedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
    return 0;
  }
  return Math.min(MAX_DURATION_MS, Math.trunc(endedAt - startedAt));
}

function readDiagnosticMetadata(
  parser: JobDiagnosticMetadataParser | undefined,
  job: Readonly<JobRecord>
): { readonly correlationId: unknown; readonly generation: unknown } {
  if (parser === undefined) return { correlationId: undefined, generation: undefined };
  try {
    const metadata: unknown = parser(job);
    if (metadata === null || typeof metadata !== 'object') {
      return { correlationId: undefined, generation: undefined };
    }
    const correlationDescriptor = Object.getOwnPropertyDescriptor(metadata, 'correlationId');
    const generationDescriptor = Object.getOwnPropertyDescriptor(metadata, 'generation');
    return {
      correlationId: correlationDescriptor && Object.hasOwn(correlationDescriptor, 'value')
        ? correlationDescriptor.value
        : undefined,
      generation: generationDescriptor && Object.hasOwn(generationDescriptor, 'value')
        ? generationDescriptor.value
        : undefined
    };
  } catch {
    return { correlationId: undefined, generation: undefined };
  }
}

function createAttemptIdentity(
  options: WorkerJobOptions,
  job: Readonly<JobRecord>
): JobAttemptIdentity {
  const metadata = readDiagnosticMetadata(options.parseJobDiagnosticMetadata, job);
  const correlationId = normalizeOrCreateCorrelationId(
    metadata.correlationId,
    options.correlationIdSource
  );
  const generation = isPositiveSignedInt32(metadata.generation)
    ? metadata.generation
    : undefined;

  if (!isCanonicalLowercaseUuid(job.id)
    || !isSafeToken(job.type)
    || !isPositiveSignedInt32(job.attempts)
    || !isPositiveSignedInt32(job.maxAttempts)
    || !isWorkerId(options.workerId)
    || !isNonnegativeSignedInt32(options.slotId)) {
    throw new TypeError('invalid job attempt identity');
  }

  return generation === undefined
    ? Object.freeze({
        correlationId,
        jobId: job.id,
        jobKind: job.type,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        workerId: options.workerId,
        slotId: options.slotId
      })
    : Object.freeze({
        correlationId,
        jobId: job.id,
        jobKind: job.type,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        workerId: options.workerId,
        slotId: options.slotId,
        generation
      });
}

function fixedLeaseLossCode(
  code: JobLeaseLostLogCode,
  operation: 'job.claim' | 'job.completion' | 'job.failure_transition' | 'job.lease_renewal',
  identity: JobAttemptIdentity
): JobLeaseLostLogCode {
  return createSafeDiagnosticError({
    class: 'job',
    code,
    operation,
    outcome: 'failed',
    correlationId: identity.correlationId
  }).code;
}

function completionFailureCode(identity: JobAttemptIdentity): JobFailureLogCode {
  return createSafeDiagnosticError({
    class: 'job',
    code: JOB_COMPLETION_FAILED,
    operation: 'job.completion',
    outcome: 'failed',
    correlationId: identity.correlationId
  }).code;
}

interface LeaseRenewalOptions {
  readonly repository: JobRepository;
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly financialAdminLeaseCapability?: string;
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  readonly sleep: WorkerSleep;
  readonly renewed: () => void;
  readonly loseLease: (code: JobLeaseLostLogCode) => void;
}

async function renewLease(options: LeaseRenewalOptions): Promise<void> {
  while (!options.signal.aborted) {
    let renewed: boolean;
    try {
      await options.sleep(options.intervalMs, options.signal);
      if (options.signal.aborted) return;
      renewed = options.financialAdminLeaseCapability === undefined
        ? await options.repository.renewLease(options.jobId, options.leaseOwner)
        : await options.repository.renewLease(
            options.jobId,
            options.leaseOwner,
            options.financialAdminLeaseCapability
          );
    } catch {
      if (options.signal.aborted) return;
      options.loseLease(LEASE_RENEWAL_FAILED);
      return;
    }
    if (options.signal.aborted) return;
    if (!renewed) {
      options.loseLease(LEASE_RENEWAL_REJECTED);
      return;
    }
    options.renewed();
  }
}

async function failClaimedJob(
  repository: JobRepository,
  job: JobRecord,
  leaseOwner: string,
  safeError: string,
  retryable: boolean
): Promise<JobFailureTransition> {
  try {
    return job.financialAdminLeaseCapability === undefined
      ? await repository.failWithDisposition(job.id, leaseOwner, safeError, retryable)
      : await repository.failWithDisposition(
          job.id,
          leaseOwner,
          safeError,
          retryable,
          job.financialAdminLeaseCapability
        );
  } catch (error: unknown) {
    if (job.financialAdminLeaseCapability !== undefined) return { applied: false };
    throw error;
  }
}

function observeUnregisteredSettlement(
  options: WorkerJobOptions,
  transition: JobFailureTransition
): void {
  if (transition.applied) {
    options.observer({ type: 'terminal_settled', slotId: options.slotId });
  } else {
    options.observer({ type: 'lease_lost', slotId: options.slotId });
  }
}

async function runRegisteredJob(
  options: WorkerJobOptions,
  job: JobRecord,
  handler: JobHandler,
  claimedAt: number
): Promise<void> {
  const identity = createAttemptIdentity(options, job);
  await runWithDiagnosticContext({
    kind: 'job',
    correlationId: identity.correlationId,
    jobId: identity.jobId,
    jobKind: identity.jobKind,
    attempt: identity.attempt,
    ...(identity.generation === undefined ? {} : { generation: identity.generation }),
    workerId: identity.workerId,
    slotId: identity.slotId
  }, async () => {
    options.observer({ type: 'job_claimed', identity });

    if (job.type === FINANCIAL_ADMIN_COMMAND_JOB &&
      (job.financialAdminLeaseCapability === undefined ||
        !FINANCIAL_ADMIN_LEASE_CAPABILITY_PATTERN.test(
          job.financialAdminLeaseCapability
        ))) {
      options.observer({
        type: 'job_lease_lost',
        identity,
        code: fixedLeaseLossCode(LEASE_CAPABILITY_INVALID, 'job.claim', identity)
      });
      options.observer({ type: 'lease_lost', slotId: options.slotId });
      return;
    }

    const handlerController = new AbortController();
    const renewalController = new AbortController();
    let leaseLost = false;
    const loseLease = (
      code: JobLeaseLostLogCode,
      operation: 'job.completion' | 'job.failure_transition' | 'job.lease_renewal' =
        'job.lease_renewal'
    ) => {
      if (leaseLost) return;
      leaseLost = true;
      handlerController.abort(new JobLeaseLostError());
      renewalController.abort();
      options.observer({
        type: 'job_lease_lost',
        identity,
        code: fixedLeaseLossCode(code, operation, identity)
      });
      options.observer({ type: 'lease_lost', slotId: options.slotId });
    };
    const rejectSettlement = (
      code: JobLeaseLostLogCode,
      operation: 'job.completion' | 'job.failure_transition'
    ) => {
      loseLease(code, operation);
    };
    const forwardShutdown = () => {
      handlerController.abort(options.signal.reason);
      renewalController.abort(options.signal.reason);
    };
    if (options.signal.aborted) forwardShutdown();
    else options.signal.addEventListener('abort', forwardShutdown, { once: true });

    const renewal = renewLease({
      repository: options.repository,
      jobId: job.id,
      leaseOwner: options.leaseOwner,
      ...(job.financialAdminLeaseCapability === undefined
        ? {}
        : { financialAdminLeaseCapability: job.financialAdminLeaseCapability }),
      intervalMs: options.leaseRenewalIntervalMs,
      signal: renewalController.signal,
      sleep: options.leaseRenewalSleep ?? abortableSleep,
      renewed: () => options.observer({
        type: 'lease_renewed',
        slotId: options.slotId
      }),
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
      renewalController.abort();
      await renewal;
      options.signal.removeEventListener('abort', forwardShutdown);
    }

    if (leaseLost) return;
    if (handlerFailed) {
      const reduced = reduceSafeError(handlerError, {
        operation: 'job.handler',
        correlationId: identity.correlationId,
        matchers: [
          (cause) => cause instanceof PermanentJobError
            ? createSafeDiagnosticError({
                class: 'job',
                code: PERMANENT_JOB_FAILURE,
                operation: 'job.handler',
                outcome: 'failed',
                correlationId: identity.correlationId
              })
            : undefined
        ]
      });
      let safeMessage = handlerError instanceof PermanentJobError
        ? handlerError.safeMessage
        : 'Transient job handler failure';
      if (job.financialAdminLeaseCapability !== undefined &&
        safeMessage.includes(job.financialAdminLeaseCapability)) {
        safeMessage = 'Permanent job handler failure';
      }
      const retryable = !(handlerError instanceof PermanentJobError);
      let transition: JobFailureTransition;
      try {
        transition = await failClaimedJob(
          options.repository,
          job,
          options.leaseOwner,
          safeMessage,
          retryable
        );
      } catch (error: unknown) {
        rejectSettlement(FAILURE_TRANSITION_FAILED, 'job.failure_transition');
        throw error;
      }
      if (!transition.applied) {
        rejectSettlement(FAILURE_TRANSITION_REJECTED, 'job.failure_transition');
        return;
      }
      options.observer({
        type: 'job_failed',
        identity,
        code: reduced.code,
        durationMs: normalizeDuration(claimedAt, options.monotonicNow()),
        retryScheduled: transition.retryScheduled
      });
      options.observer({ type: 'terminal_settled', slotId: options.slotId });
      return;
    }

    let completed: boolean;
    try {
      completed = job.financialAdminLeaseCapability === undefined
        ? await options.repository.complete(job.id, options.leaseOwner)
        : await options.repository.complete(
            job.id,
            options.leaseOwner,
            job.financialAdminLeaseCapability
          );
    } catch {
      let transition: JobFailureTransition;
      try {
        transition = await failClaimedJob(
          options.repository,
          job,
          options.leaseOwner,
          'Transient job completion failure',
          true
        );
      } catch (error: unknown) {
        rejectSettlement(FAILURE_TRANSITION_FAILED, 'job.failure_transition');
        throw error;
      }
      if (!transition.applied) {
        rejectSettlement(FAILURE_TRANSITION_REJECTED, 'job.failure_transition');
        return;
      }
      options.observer({
        type: 'job_failed',
        identity,
        code: completionFailureCode(identity),
        durationMs: normalizeDuration(claimedAt, options.monotonicNow()),
        retryScheduled: transition.retryScheduled
      });
      options.observer({ type: 'terminal_settled', slotId: options.slotId });
      return;
    }

    if (!completed) {
      rejectSettlement(COMPLETION_REJECTED, 'job.completion');
      return;
    }
    options.observer({
      type: 'job_succeeded',
      identity,
      durationMs: normalizeDuration(claimedAt, options.monotonicNow())
    });
    options.observer({ type: 'terminal_settled', slotId: options.slotId });
  });
}

async function runClaimedJob(
  options: WorkerJobOptions,
  job: JobRecord,
  claimedAt: number
): Promise<void> {
  const handler = options.handlers.get(job.type);
  if (!handler) {
    const transition = await failClaimedJob(
      options.repository,
      job,
      options.leaseOwner,
      `No handler registered for ${job.type}`,
      false
    );
    observeUnregisteredSettlement(options, transition);
    return;
  }
  await runRegisteredJob(options, job, handler, claimedAt);
}

async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;

  while (!options.signal.aborted) {
    options.observer({ type: 'polling', slotId: options.slotId });
    await options.runBeforePoll?.();
    if (options.signal.aborted) return;
    const job = await options.repository.claimNext(options.leaseOwner);
    const claimedAt = job === null ? undefined : options.monotonicNow();
    options.observer({
      type: 'poll_succeeded',
      slotId: options.slotId,
      claimed: job !== null
    });
    if (!job) {
      await sleep(options.pollIntervalMs, options.signal);
      continue;
    }

    await runClaimedJob(options, job, claimedAt!);
  }
}

export async function runWorker(options: RunWorkerOptions): Promise<void> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new RangeError('Worker concurrency must be a positive integer');
  }
  if (!Number.isSafeInteger(options.leaseRenewalIntervalMs) ||
    options.leaseRenewalIntervalMs < 1) {
    throw new RangeError('Worker lease renewal interval must be a positive integer');
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
  const observer = options.observer ?? NOOP_OBSERVER;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());

  await Promise.all(
    Array.from({ length: options.concurrency }, (_, slotId) => {
      const leaseOwner = options.concurrency === 1
        ? options.workerId
        : `${options.workerId}:${slotId}`;
      return runWorkerLoop({
        repository: options.repository,
        handlers: options.handlers,
        workerId: options.workerId,
        leaseOwner,
        slotId,
        pollIntervalMs: options.pollIntervalMs,
        leaseRenewalIntervalMs: options.leaseRenewalIntervalMs,
        signal: options.signal,
        observer,
        monotonicNow,
        ...(runBeforePoll ? { runBeforePoll } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.leaseRenewalSleep
          ? { leaseRenewalSleep: options.leaseRenewalSleep }
          : {}),
        ...(options.parseJobDiagnosticMetadata
          ? { parseJobDiagnosticMetadata: options.parseJobDiagnosticMetadata }
          : {}),
        ...(options.correlationIdSource
          ? { correlationIdSource: options.correlationIdSource }
          : {})
      });
    })
  );
}
