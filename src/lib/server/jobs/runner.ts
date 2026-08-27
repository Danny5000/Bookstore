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
import {
  FINANCIAL_ADMIN_COMMAND_JOB,
  OPERATIONS_JOB_RETRY_COMMAND_JOB,
  OPERATIONS_JOB_RETRY_COMMAND_MAX_ATTEMPTS
} from './catalog';
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
  JobRepository,
  OperationsJobLeaseAuthority,
  OperationsJobSafeError
} from './types';

export class PermanentJobError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'PermanentJobError';
  }
}

export class DefiniteRetryableJobError extends Error {
  constructor() {
    super('Retryable job handler transaction failed');
    this.name = 'DefiniteRetryableJobError';
  }
}

export class JobLeaseLostError extends Error {
  constructor() {
    super('Job lease ownership was lost');
    this.name = 'JobLeaseLostError';
  }
}

type WorkerSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;
const FINANCIAL_ADMIN_LEASE_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const OPERATIONS_JOB_LEASE_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_DURATION_MS = 86_400_000;
const OPERATIONS_UNKNOWN_OUTCOME = 'Operations job execution outcome is unknown';
const OPERATIONS_PERMANENT_FAILURE = 'Operations job retry command permanently failed.';
const OPERATIONS_INVALID_IDENTITY = 'Invalid operations job retry command identity.';

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
  readonly onFirstFailure?: () => void;
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
  readonly reportFailure: (error: unknown) => void;
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

type OwnDataInspection =
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'data'; value: unknown }>
  | Readonly<{ state: 'invalid' }>;

interface OperationsTransportSnapshot {
  readonly capability: OwnDataInspection;
  readonly generation: OwnDataInspection;
}

function inspectOwnDataProperty(value: object, key: PropertyKey): OwnDataInspection {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return Object.freeze({ state: 'absent' });
    if (!Object.hasOwn(descriptor, 'value')) return Object.freeze({ state: 'invalid' });
    return Object.freeze({ state: 'data', value: descriptor.value });
  } catch {
    return Object.freeze({ state: 'invalid' });
  }
}

function inspectOperationsTransport(job: Readonly<JobRecord>): OperationsTransportSnapshot {
  return Object.freeze({
    capability: inspectOwnDataProperty(job, 'operationsJobLeaseCapability'),
    generation: inspectOwnDataProperty(job, 'operationsJobLeaseGeneration')
  });
}

function hasOperationsTransport(snapshot: OperationsTransportSnapshot): boolean {
  return snapshot.capability.state !== 'absent' || snapshot.generation.state !== 'absent';
}

function reconstructOperationsAuthority(
  options: WorkerJobOptions,
  job: Readonly<JobRecord>,
  identity: JobAttemptIdentity,
  snapshot: OperationsTransportSnapshot
): Readonly<OperationsJobLeaseAuthority> | null | undefined {
  if (identity.jobKind !== OPERATIONS_JOB_RETRY_COMMAND_JOB) {
    return hasOperationsTransport(snapshot) ? null : undefined;
  }

  const financialCapability = inspectOwnDataProperty(job, 'financialAdminLeaseCapability');
  if (snapshot.capability.state !== 'data' ||
    typeof snapshot.capability.value !== 'string' ||
    !OPERATIONS_JOB_LEASE_CAPABILITY_PATTERN.test(snapshot.capability.value) ||
    snapshot.generation.state !== 'data' ||
    !isPositiveSignedInt32(snapshot.generation.value) ||
    financialCapability.state !== 'absent' ||
    identity.maxAttempts !== OPERATIONS_JOB_RETRY_COMMAND_MAX_ATTEMPTS ||
    identity.attempt > identity.maxAttempts) {
    return null;
  }

  return Object.freeze({
    jobId: identity.jobId,
    leaseOwner: options.leaseOwner,
    attempt: identity.attempt,
    maxAttempts: identity.maxAttempts,
    generation: snapshot.generation.value,
    capability: snapshot.capability.value
  }) satisfies OperationsJobLeaseAuthority;
}

function operationsOutcomeUnknown(): Error {
  return new Error(OPERATIONS_UNKNOWN_OUTCOME);
}

function isDefiniteRetryableJobError(cause: unknown): boolean {
  try {
    return cause instanceof DefiniteRetryableJobError;
  } catch {
    return false;
  }
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
  readonly operationsAuthority?: Readonly<OperationsJobLeaseAuthority>;
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  readonly sleep: WorkerSleep;
  readonly renewed: () => void;
  readonly loseLease: (code: JobLeaseLostLogCode) => void;
}

async function renewLease(options: LeaseRenewalOptions): Promise<void> {
  while (!options.signal.aborted) {
    try {
      await options.sleep(options.intervalMs, options.signal);
    } catch {
      if (options.signal.aborted) return;
      options.loseLease(LEASE_RENEWAL_FAILED);
      return;
    }
    if (options.signal.aborted) return;

    let renewed: boolean;
    try {
      renewed = options.operationsAuthority !== undefined
        ? await options.repository.renewOperationsJobLease(options.operationsAuthority)
        : options.financialAdminLeaseCapability === undefined
          ? await options.repository.renewLease(options.jobId, options.leaseOwner)
          : await options.repository.renewLease(
            options.jobId,
            options.leaseOwner,
            options.financialAdminLeaseCapability
          );
    } catch {
      options.loseLease(LEASE_RENEWAL_FAILED);
      return;
    }
    if (!renewed) {
      options.loseLease(LEASE_RENEWAL_REJECTED);
      return;
    }
    options.renewed();
  }
}

function permanentSafeMessage(cause: unknown): string | undefined {
  try {
    if (!(cause instanceof PermanentJobError)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(cause, 'safeMessage');
    return descriptor && Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string'
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

interface OperationsFailureDisposition {
  readonly safeError: OperationsJobSafeError;
  readonly retryable: boolean;
  readonly permanent: boolean;
}

function operationsFailureDisposition(
  cause: unknown
): OperationsFailureDisposition | undefined {
  if (isDefiniteRetryableJobError(cause)) {
    return Object.freeze({
      safeError: 'Transient job handler failure',
      retryable: true,
      permanent: false
    });
  }
  const trustedPermanentMessage = permanentSafeMessage(cause);
  if (trustedPermanentMessage === undefined) return undefined;
  return Object.freeze({
    safeError: trustedPermanentMessage === OPERATIONS_INVALID_IDENTITY
      ? OPERATIONS_INVALID_IDENTITY
      : OPERATIONS_PERMANENT_FAILURE,
    retryable: false,
    permanent: true
  });
}

function operationsFailureCode(
  identity: JobAttemptIdentity,
  permanent: boolean
): JobFailureLogCode {
  return permanent
    ? createSafeDiagnosticError({
        class: 'job',
        code: PERMANENT_JOB_FAILURE,
        operation: 'job.handler',
        outcome: 'failed',
        correlationId: identity.correlationId
      }).code
    : reduceSafeError(undefined, {
        operation: 'job.handler',
        correlationId: identity.correlationId
      }).code;
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
  handler: JobHandler | undefined,
  claimedAt: number,
  operationsTransport: OperationsTransportSnapshot
): Promise<void> {
  const identity = createAttemptIdentity(options, job);
  const operationsAuthority = reconstructOperationsAuthority(
    options,
    job,
    identity,
    operationsTransport
  );
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

    if (operationsAuthority === null) {
      options.observer({
        type: 'job_lease_lost',
        identity,
        code: fixedLeaseLossCode(LEASE_CAPABILITY_INVALID, 'job.claim', identity)
      });
      options.observer({ type: 'lease_lost', slotId: options.slotId });
      return;
    }

    if (operationsAuthority === undefined && job.type === FINANCIAL_ADMIN_COMMAND_JOB &&
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

    if (handler === undefined) {
      if (operationsAuthority === undefined) {
        throw new TypeError('invalid operations job lease authority');
      }
      let transition: JobFailureTransition;
      try {
        transition = await options.repository.failOperationsJob(
          operationsAuthority,
          OPERATIONS_PERMANENT_FAILURE,
          false
        );
      } catch {
        throw operationsOutcomeUnknown();
      }
      if (!transition.applied) {
        options.observer({
          type: 'job_lease_lost',
          identity,
          code: fixedLeaseLossCode(
            FAILURE_TRANSITION_REJECTED,
            'job.failure_transition',
            identity
          )
        });
        options.observer({ type: 'lease_lost', slotId: options.slotId });
        return;
      }
      options.observer({
        type: 'job_failed',
        identity,
        code: operationsFailureCode(identity, true),
        durationMs: normalizeDuration(claimedAt, options.monotonicNow()),
        retryScheduled: transition.retryScheduled
      });
      options.observer({ type: 'terminal_settled', slotId: options.slotId });
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
      jobId: identity.jobId,
      leaseOwner: options.leaseOwner,
      ...(operationsAuthority !== undefined
        ? { operationsAuthority }
        : job.financialAdminLeaseCapability === undefined
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
      if (operationsAuthority !== undefined) {
        const disposition = operationsFailureDisposition(handlerError);
        if (disposition === undefined) throw operationsOutcomeUnknown();
        let transition: JobFailureTransition;
        try {
          transition = await options.repository.failOperationsJob(
            operationsAuthority,
            disposition.safeError,
            disposition.retryable
          );
        } catch {
          throw operationsOutcomeUnknown();
        }
        if (!transition.applied) {
          rejectSettlement(FAILURE_TRANSITION_REJECTED, 'job.failure_transition');
          return;
        }
        options.observer({
          type: 'job_failed',
          identity,
          code: operationsFailureCode(identity, disposition.permanent),
          durationMs: normalizeDuration(claimedAt, options.monotonicNow()),
          retryScheduled: transition.retryScheduled
        });
        options.observer({ type: 'terminal_settled', slotId: options.slotId });
        return;
      }
      const trustedPermanentMessage = permanentSafeMessage(handlerError);
      const reduced = reduceSafeError(handlerError, {
        operation: 'job.handler',
        correlationId: identity.correlationId,
        matchers: [
          () => trustedPermanentMessage !== undefined
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
      let safeMessage = trustedPermanentMessage !== undefined
        ? trustedPermanentMessage
        : 'Transient job handler failure';
      if (job.financialAdminLeaseCapability !== undefined &&
        safeMessage.includes(job.financialAdminLeaseCapability)) {
        safeMessage = 'Permanent job handler failure';
      }
      const retryable = trustedPermanentMessage === undefined;
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
      completed = operationsAuthority !== undefined
        ? await options.repository.completeOperationsJob(operationsAuthority)
        : job.financialAdminLeaseCapability === undefined
          ? await options.repository.complete(job.id, options.leaseOwner)
          : await options.repository.complete(
            job.id,
            options.leaseOwner,
            job.financialAdminLeaseCapability
          );
    } catch {
      if (operationsAuthority !== undefined) throw operationsOutcomeUnknown();
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
  const operationsTransport = inspectOperationsTransport(job);
  const handler = options.handlers.get(job.type);
  if (!handler && job.type !== OPERATIONS_JOB_RETRY_COMMAND_JOB &&
    !hasOperationsTransport(operationsTransport)) {
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
  await runRegisteredJob(options, job, handler, claimedAt, operationsTransport);
}

async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;

  try {
    while (!options.signal.aborted) {
      options.observer({ type: 'polling', slotId: options.slotId });
      await options.runBeforePoll?.();
      if (options.signal.aborted) return;
      const job = await options.repository.claimNext(options.leaseOwner);
      if (job === null && options.signal.aborted) return;
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
  } catch (error: unknown) {
    options.reportFailure(error);
    throw error;
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
  const workerController = new AbortController();
  const forwardShutdown = () => workerController.abort(options.signal.reason);
  if (options.signal.aborted) forwardShutdown();
  else options.signal.addEventListener('abort', forwardShutdown, { once: true });
  let hookTail = Promise.resolve();
  const runBeforePoll = options.beforePoll
    ? async () => {
        const previous = hookTail;
        let release!: () => void;
        hookTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          if (!workerController.signal.aborted) {
            await options.beforePoll!({
              now: new Date(),
              signal: workerController.signal
            });
          }
        } catch {
          if (!workerController.signal.aborted) {
            console.error('[jobs] worker poll hook failed');
          }
        } finally {
          release();
        }
      }
    : undefined;
  const observer = options.observer ?? NOOP_OBSERVER;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  let failed = false;
  let primaryFailure: unknown;
  const reportFailure = (error: unknown): void => {
    if (failed) return;
    failed = true;
    primaryFailure = error;
    try {
      options.onFirstFailure?.();
    } catch {
      // Notification cannot replace the authoritative slot failure.
    }
    workerController.abort();
  };

  try {
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
          signal: workerController.signal,
          observer,
          monotonicNow,
          reportFailure,
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
        }).catch(reportFailure);
      })
    );
    if (failed) throw primaryFailure;
  } finally {
    options.signal.removeEventListener('abort', forwardShutdown);
  }
}
