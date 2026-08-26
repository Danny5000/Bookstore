import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';

import type { WorkerApplicationConfig } from '../config/load';
import {
  ConfigurationError,
  type EnvironmentValues
} from '../config/read-setting';
import {
  isCanonicalLowercaseUuid,
  isWorkerId,
  type HeartbeatFailedCode,
  type WorkerFailedCode,
  type WorkerStoppingCode
} from '../observability/contracts';
import {
  createStructuredLogger,
  type StructuredLogger,
  type StructuredLogSink
} from '../observability/logger';
import {
  createSafeDiagnosticError,
  defineSafeCode,
  reduceSafeError,
  type SafeDiagnosticError
} from '../observability/safe-error';
import {
  WorkerHeartbeatPublicationError,
  type WorkerHeartbeatSupervisor
} from './heartbeat-supervisor';

export interface WorkerProcessAssembly {
  probeDependencies(): Promise<void>;
  run(signal: AbortSignal): Promise<void>;
  assertControlHealthy(): void;
}

export interface WorkerCleanupRegistration {
  register(name: 'database' | 'email', close: () => void | Promise<void>): void;
}

export interface WorkerSignalSource {
  subscribe(
    signal: 'SIGINT' | 'SIGTERM',
    listener: () => void
  ): () => void;
}

export interface WorkerShutdownDeadline {
  readonly expired: Promise<void>;
  cancel(): void;
}

export interface RunWorkerProcessOptions {
  readonly environment: EnvironmentValues;
  readonly loadConfig: (environment: EnvironmentValues) => WorkerApplicationConfig;
  readonly createHeartbeat: (input: {
    readonly config: WorkerApplicationConfig;
    readonly workerId: string;
    readonly processStartedAt: Date;
  }) => WorkerHeartbeatSupervisor;
  readonly createAssembly: (input: {
    readonly config: WorkerApplicationConfig;
    readonly workerId: string;
    readonly processStartedAt: Date;
    readonly heartbeat: WorkerHeartbeatSupervisor;
    readonly logger: StructuredLogger<'worker'>;
    readonly signal: AbortSignal;
    readonly requestAbort: (reason?: unknown) => void;
    readonly reportRunnerFailure: () => void;
    readonly cleanup: WorkerCleanupRegistration;
  }) => WorkerProcessAssembly | Promise<WorkerProcessAssembly>;
  readonly wallNow?: () => Date;
  readonly monotonicNow?: () => number;
  readonly hostnameSource?: () => string;
  readonly pid?: number;
  readonly uuidSource?: () => string;
  readonly signals?: WorkerSignalSource;
  readonly createShutdownDeadline?: (
    milliseconds: number
  ) => WorkerShutdownDeadline;
  readonly forceExit?: (code: 1) => void;
  readonly stdout?: StructuredLogSink;
  readonly stderr?: StructuredLogSink;
}

const CONFIGURATION_INVALID = defineSafeCode('configuration_invalid');
const WORKER_IDENTITY_INVALID = defineSafeCode('worker_identity_invalid');
const DEPENDENCY_STARTUP_FAILED = defineSafeCode('dependency_startup_failed');
const RUNNER_FAILED = defineSafeCode('runner_failed');
const RUNNER_STOPPED_UNEXPECTEDLY = defineSafeCode('runner_stopped_unexpectedly');
const HEARTBEAT_PUBLICATION_FAILED = defineSafeCode('heartbeat_publication_failed');
const WORKER_CONTROL_FAILED = defineSafeCode('worker_control_failed');
const CLEANUP_FAILED = defineSafeCode('cleanup_failed');
const UNEXPECTED_FAILURE = defineSafeCode('unexpected_failure');
const SIGNAL_SIGINT = defineSafeCode('signal_sigint');
const SIGNAL_SIGTERM = defineSafeCode('signal_sigterm');
const MAX_DURATION_MS = 86_400_000;
const FATAL_SHUTDOWN_DEADLINE_MS = 10_000;

const processSignals: WorkerSignalSource = {
  subscribe(signal, listener) {
    process.once(signal, listener);
    return () => process.off(signal, listener);
  }
};

function createProcessShutdownDeadline(milliseconds: number): WorkerShutdownDeadline {
  let timeout: ReturnType<typeof setTimeout>;
  const expired = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, milliseconds);
  });
  return {
    expired,
    cancel() {
      clearTimeout(timeout);
    }
  };
}

function forceProcessExit(_code: 1): never {
  process.exit(1);
}

function loggerEnvironment(environment: EnvironmentValues): 'development' | 'test' | 'production' {
  const rawEnvironment = environment.APP_ENV;
  if (rawEnvironment === 'production') return 'production';
  if (rawEnvironment === 'test') return 'test';
  return 'development';
}

function configurationMatcher(cause: unknown): SafeDiagnosticError<'configuration_invalid'> | undefined {
  if (!(cause instanceof ConfigurationError)) return undefined;
  return createSafeDiagnosticError({
    class: 'configuration',
    code: CONFIGURATION_INVALID,
    operation: 'worker.startup',
    outcome: 'failed'
  });
}

function heartbeatMatcher(cause: unknown): SafeDiagnosticError<'heartbeat_publication_failed'> | undefined {
  if (!(cause instanceof WorkerHeartbeatPublicationError)) return undefined;
  return createSafeDiagnosticError({
    class: 'heartbeat',
    code: HEARTBEAT_PUBLICATION_FAILED,
    operation: 'worker.heartbeat',
    outcome: 'failed'
  });
}

function fixedFailure<C extends string>(input: {
  readonly class: 'dependency' | 'heartbeat' | 'shutdown' | 'unexpected';
  readonly code: SafeDiagnosticError<C>['code'];
  readonly operation: 'worker.startup' | 'worker.runtime' | 'worker.heartbeat' | 'worker.shutdown';
}): SafeDiagnosticError<C>['code'] {
  return createSafeDiagnosticError({
    class: input.class,
    code: input.code,
    operation: input.operation,
    outcome: 'failed'
  }).code;
}

function captureDate(source: () => Date): Date {
  const value = source();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('invalid worker process clock');
  }
  return new Date(value.getTime());
}

function createWorkerId(input: {
  readonly hostnameSource: () => string;
  readonly pid: number;
  readonly uuidSource: () => string;
}): string {
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new TypeError('invalid worker identity');
  }
  const uuid = input.uuidSource();
  if (!isCanonicalLowercaseUuid(uuid)) throw new TypeError('invalid worker identity');
  const host = input.hostnameSource();
  if (typeof host !== 'string') throw new TypeError('invalid worker identity');
  const candidate = `${host}:${input.pid}:${uuid}`;
  if (isWorkerId(candidate)) return candidate;
  const fallback = `worker:${input.pid}:${uuid}`;
  if (!isWorkerId(fallback)) throw new TypeError('invalid worker identity');
  return fallback;
}

function captureMonotonic(source: () => number): number {
  try {
    const value = source();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function durationSince(startedAt: number, source: () => number): number {
  let endedAt: number;
  try {
    endedAt = source();
  } catch {
    return 0;
  }
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
    return 0;
  }
  return Math.min(MAX_DURATION_MS, Math.trunc(endedAt - startedAt));
}

type RunnerOutcome =
  | { readonly type: 'runner_resolved' }
  | { readonly type: 'runner_rejected'; readonly cause: unknown }
  | { readonly type: 'runner_failure_reported' };
type PublisherOutcome =
  | { readonly type: 'publisher_resolved' }
  | { readonly type: 'publisher_rejected'; readonly cause: unknown };
type ReadinessOutcome =
  | { readonly type: 'readiness_resolved' }
  | { readonly type: 'readiness_rejected'; readonly cause: unknown };
type SignalOutcome = { readonly type: 'signal_received' };
type RuntimeOutcome = RunnerOutcome | PublisherOutcome | ReadinessOutcome | SignalOutcome;
type StartupOutcome<T> =
  | { readonly type: 'startup_resolved'; readonly value: T }
  | { readonly type: 'startup_rejected'; readonly cause: unknown };
type StartupRaceOutcome<T> = StartupOutcome<T> | {
  readonly type: 'signal_received';
  readonly settlement: StartupOutcome<T>;
};
interface CleanupResult {
  readonly failed: boolean;
  readonly firstFailure: unknown;
}

interface RuntimeOutcomeQueue {
  push(outcome: RuntimeOutcome): void;
  next(): Promise<RuntimeOutcome>;
}

function createRuntimeOutcomeQueue(): RuntimeOutcomeQueue {
  const pending: RuntimeOutcome[] = [];
  let waiting: ((outcome: RuntimeOutcome) => void) | undefined;
  return {
    push(outcome) {
      const resolve = waiting;
      if (resolve === undefined) {
        pending.push(outcome);
        return;
      }
      waiting = undefined;
      resolve(outcome);
    },
    next() {
      const outcome = pending.shift();
      if (outcome !== undefined) return Promise.resolve(outcome);
      return new Promise<RuntimeOutcome>((resolve) => {
        waiting = resolve;
      });
    }
  };
}

function startupOutcome<T>(operation: () => T | PromiseLike<T>): Promise<StartupOutcome<T>> {
  try {
    return Promise.resolve(operation()).then<StartupOutcome<T>, StartupOutcome<T>>(
      (value) => ({ type: 'startup_resolved', value }),
      (cause: unknown) => ({ type: 'startup_rejected', cause })
    );
  } catch (cause: unknown) {
    return Promise.resolve({ type: 'startup_rejected', cause });
  }
}

async function raceStartupOutcome<T>(
  operation: () => T | PromiseLike<T>,
  signal: Promise<SignalOutcome>
): Promise<StartupRaceOutcome<T>> {
  const settlement = startupOutcome(operation);
  const first = await Promise.race([signal, settlement]);
  if (first.type !== 'signal_received') return first;
  return { type: 'signal_received', settlement: await settlement };
}

function runnerOutcome(
  operation: () => Promise<void>,
  deliver: (outcome: RunnerOutcome) => void
): Promise<RunnerOutcome> {
  try {
    return Promise.resolve(operation()).then<RunnerOutcome, RunnerOutcome>(
      () => {
        const outcome = { type: 'runner_resolved' } as const;
        deliver(outcome);
        return outcome;
      },
      (cause: unknown) => {
        const outcome = { type: 'runner_rejected', cause } as const;
        deliver(outcome);
        return outcome;
      }
    );
  } catch (cause: unknown) {
    const outcome = { type: 'runner_rejected', cause } as const;
    return Promise.resolve().then(() => {
      deliver(outcome);
      return outcome;
    });
  }
}

function publisherOutcome(
  operation: () => Promise<void>,
  deliver: (outcome: PublisherOutcome) => void
): Promise<PublisherOutcome> {
  try {
    return Promise.resolve(operation()).then<PublisherOutcome, PublisherOutcome>(
      () => {
        const outcome = { type: 'publisher_resolved' } as const;
        deliver(outcome);
        return outcome;
      },
      (cause: unknown) => {
        const outcome = { type: 'publisher_rejected', cause } as const;
        deliver(outcome);
        return outcome;
      }
    );
  } catch (cause: unknown) {
    const outcome = { type: 'publisher_rejected', cause } as const;
    return Promise.resolve().then(() => {
      deliver(outcome);
      return outcome;
    });
  }
}

function readinessOutcome(
  promise: Promise<void>,
  deliver: (outcome: ReadinessOutcome) => void
): Promise<ReadinessOutcome> {
  return Promise.resolve(promise).then<ReadinessOutcome, ReadinessOutcome>(
    () => {
      const outcome = { type: 'readiness_resolved' } as const;
      deliver(outcome);
      return outcome;
    },
    (cause: unknown) => {
      const outcome = { type: 'readiness_rejected', cause } as const;
      deliver(outcome);
      return outcome;
    }
  );
}

export async function runWorkerProcess(
  options: RunWorkerProcessOptions
): Promise<0 | 1> {
  const wallNow = options.wallNow ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const logger = createStructuredLogger({
    service: 'worker',
    environment: loggerEnvironment(options.environment),
    now: wallNow,
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    ...(options.stderr === undefined ? {} : { stderr: options.stderr })
  });

  let config: WorkerApplicationConfig;
  try {
    config = options.loadConfig(options.environment);
  } catch (cause: unknown) {
    const failure = reduceSafeError(cause, {
      operation: 'worker.startup',
      matchers: [configurationMatcher]
    });
    logger.emit({ event: 'worker.failed', code: failure.code });
    return 1;
  }

  let processStartedAt!: Date;
  let workerId!: string;
  const startedAt = captureMonotonic(monotonicNow);
  try {
    processStartedAt = captureDate(wallNow);
    workerId = createWorkerId({
      hostnameSource: options.hostnameSource ?? hostname,
      pid: options.pid ?? process.pid,
      uuidSource: options.uuidSource ?? randomUUID
    });
  } catch {
    const code = fixedFailure({
      class: 'unexpected',
      code: WORKER_IDENTITY_INVALID,
      operation: 'worker.startup'
    });
    logger.emit({ event: 'worker.failed', code });
    return 1;
  }

  logger.emit({
    event: 'worker.started',
    workerId,
    configuredSlots: config.worker.concurrency
  });

  const controller = new AbortController();
  const signals = options.signals ?? processSignals;
  const signalLatch = Promise.withResolvers<void>();
  const signalOutcome = signalLatch.promise.then<SignalOutcome>(() => ({
    type: 'signal_received'
  }));
  const unsubscribe: Array<() => void> = [];
  const cleanupClosures: Array<() => void | Promise<void>> = [];
  const cleanup: WorkerCleanupRegistration = {
    register(name, close) {
      if ((name !== 'database' && name !== 'email') || typeof close !== 'function') {
        throw new TypeError('invalid worker cleanup registration');
      }
      cleanupClosures.push(close);
    }
  };
  let userSignal: WorkerStoppingCode | undefined;
  let fatalFailure: WorkerFailedCode | undefined;
  let heartbeat: WorkerHeartbeatSupervisor | undefined;
  let heartbeatPrepared = false;
  let assembly: WorkerProcessAssembly | undefined;
  let runner: Promise<RunnerOutcome> | undefined;
  let publisher: Promise<PublisherOutcome> | undefined;
  let pendingUserSignal: WorkerStoppingCode | undefined;
  let internalAbortRequested = false;
  let runnerFailureReported = false;
  let pendingRunnerFailureOutcome: RunnerOutcome | undefined;
  let activeOutcomeQueue: RuntimeOutcomeQueue | undefined;
  let runnerClassified = false;
  let publisherClassified = false;

  const requestAbort = (reason?: unknown): void => {
    internalAbortRequested = true;
    controller.abort(reason);
  };

  const reportRunnerFailure = (): void => {
    if (runnerFailureReported) return;
    runnerFailureReported = true;
    const outcome = { type: 'runner_failure_reported' } as const;
    if (activeOutcomeQueue === undefined) {
      pendingRunnerFailureOutcome = outcome;
      return;
    }
    activeOutcomeQueue.push(outcome);
  };

  const recordFailure = (code: WorkerFailedCode, heartbeatFailure = false): void => {
    if (fatalFailure !== undefined) return;
    fatalFailure = code;
    try {
      if (heartbeatFailure) {
        logger.emit({
          event: 'worker.heartbeat_failed',
          workerId,
          code: HEARTBEAT_PUBLICATION_FAILED as HeartbeatFailedCode
        });
      }
      logger.emit({ event: 'worker.failed', workerId, code });
    } finally {
      controller.abort();
    }
  };

  const recordFixedFailure = (
    code: WorkerFailedCode,
    phase: 'startup' | 'runtime' | 'heartbeat' | 'shutdown',
    heartbeatFailure = false
  ): void => {
    const operation = phase === 'startup'
      ? 'worker.startup'
      : phase === 'heartbeat'
        ? 'worker.heartbeat'
        : phase === 'shutdown'
          ? 'worker.shutdown'
          : 'worker.runtime';
    const failureClass = phase === 'heartbeat'
      ? 'heartbeat'
      : phase === 'shutdown'
        ? 'shutdown'
        : phase === 'startup'
          ? 'dependency'
          : 'unexpected';
    recordFailure(fixedFailure({ class: failureClass, code, operation }), heartbeatFailure);
  };

  const recordHeartbeatFailure = (cause: unknown): void => {
    if (fatalFailure !== undefined || userSignal !== undefined) return;
    const failure = reduceSafeError(cause, {
      operation: 'worker.heartbeat',
      matchers: [heartbeatMatcher]
    });
    if (failure.code === HEARTBEAT_PUBLICATION_FAILED) {
      recordFailure(failure.code, true);
    } else {
      recordFailure(failure.code);
    }
  };

  const receiveSignal = (code: WorkerStoppingCode): void => {
    if (
      pendingUserSignal !== undefined ||
      userSignal !== undefined ||
      fatalFailure !== undefined
    ) return;
    pendingUserSignal = code;
    signalLatch.resolve();
    controller.abort();
  };

  const acceptUserSignal = (): void => {
    if (
      pendingUserSignal === undefined ||
      userSignal !== undefined ||
      fatalFailure !== undefined
    ) return;
    userSignal = pendingUserSignal;
    logger.emit({ event: 'worker.stopping', workerId, code: userSignal });
  };

  const classifyRunner = (outcome: RunnerOutcome): void => {
    if (runnerClassified) return;
    runnerClassified = true;
    try {
      assembly!.assertControlHealthy();
    } catch {
      if (fatalFailure === undefined) {
        recordFixedFailure(WORKER_CONTROL_FAILED, 'runtime');
      }
      return;
    }
    if (outcome.type === 'runner_resolved') {
      if (fatalFailure !== undefined || userSignal !== undefined) return;
      recordFixedFailure(RUNNER_STOPPED_UNEXPECTEDLY, 'runtime');
      return;
    }
    if (fatalFailure !== undefined || userSignal !== undefined) return;
    recordFixedFailure(RUNNER_FAILED, 'runtime');
  };

  const classifyPublisher = (outcome: PublisherOutcome): void => {
    if (publisherClassified) return;
    publisherClassified = true;
    if (fatalFailure !== undefined || userSignal !== undefined) return;
    if (outcome.type === 'publisher_rejected') {
      recordHeartbeatFailure(outcome.cause);
      return;
    }
    if (!controller.signal.aborted) {
      recordFixedFailure(UNEXPECTED_FAILURE, 'heartbeat');
    }
  };

  const settleActivities = async (): Promise<void> => {
    if (runner === undefined || publisher === undefined) return;
    const [runnerResult, publisherResult] = await Promise.all([runner, publisher]);
    classifyRunner(runnerResult);
    classifyPublisher(publisherResult);
  };

  const cleanEvidenceAndResources = async (): Promise<CleanupResult> => {
    let cleanupFailed = false;
    let firstFailure: unknown;
    if (heartbeat !== undefined) {
      try {
        heartbeat.sealProgress();
      } catch (cause: unknown) {
        firstFailure = cause;
        cleanupFailed = true;
      }
      if (heartbeatPrepared) {
        try {
          await heartbeat.removeEvidence();
        } catch (cause: unknown) {
          if (!cleanupFailed) firstFailure = cause;
          cleanupFailed = true;
        }
      }
    }
    for (let index = cleanupClosures.length - 1; index >= 0; index -= 1) {
      try {
        await cleanupClosures[index]!();
      } catch (cause: unknown) {
        if (!cleanupFailed) firstFailure = cause;
        cleanupFailed = true;
      }
    }
    return { failed: cleanupFailed, firstFailure };
  };

  const runFatalCleanup = async (
    operation: () => Promise<CleanupResult>
  ): Promise<1> => {
    const createShutdownDeadline = options.createShutdownDeadline ??
      createProcessShutdownDeadline;
    const forceExit = options.forceExit ?? forceProcessExit;
    const deadline = createShutdownDeadline(FATAL_SHUTDOWN_DEADLINE_MS);
    const cleanupOutcome = Promise.resolve().then(operation).then(
      (result) => ({ type: 'cleanup' as const, result }),
      (firstFailure: unknown) => ({
        type: 'cleanup' as const,
        result: { failed: true, firstFailure }
      })
    );
    const deadlineOutcome = Promise.resolve(deadline.expired).then(
      () => ({ type: 'deadline' as const }),
      () => ({ type: 'deadline' as const })
    );
    const outcome = await Promise.race([cleanupOutcome, deadlineOutcome]);
    if (outcome.type === 'cleanup') {
      try {
        deadline.cancel();
      } catch {
        // A settled fatal cleanup remains authoritative.
      }
      return 1;
    }
    forceExit(1);
    return 1;
  };

  const finish = async (): Promise<0 | 1> => {
    acceptUserSignal();
    if (fatalFailure !== undefined) {
      return runFatalCleanup(async () => {
        await settleActivities();
        return cleanEvidenceAndResources();
      });
    }

    await settleActivities();
    if (fatalFailure !== undefined) {
      return runFatalCleanup(cleanEvidenceAndResources);
    }

    const cleanupResult = await cleanEvidenceAndResources();
    if (cleanupResult.failed) {
      recordFixedFailure(CLEANUP_FAILED, 'shutdown');
      return 1;
    }
    if (userSignal !== undefined) {
      logger.emit({
        event: 'worker.stopped',
        workerId,
        durationMs: durationSince(startedAt, monotonicNow)
      });
      return 0;
    }
    recordFixedFailure(UNEXPECTED_FAILURE, 'runtime');
    return 1;
  };

  try {
    unsubscribe.push(signals.subscribe('SIGINT', () => receiveSignal(SIGNAL_SIGINT)));
    unsubscribe.push(signals.subscribe('SIGTERM', () => receiveSignal(SIGNAL_SIGTERM)));

    try {
      heartbeat = options.createHeartbeat({
        config,
        workerId,
        processStartedAt: new Date(processStartedAt.getTime())
      });
    } catch {
      if (pendingUserSignal === undefined) {
        recordFixedFailure(HEARTBEAT_PUBLICATION_FAILED, 'heartbeat', true);
      }
      return finish();
    }
    const preparation = await raceStartupOutcome(
      () => heartbeat!.prepare(),
      signalOutcome
    );
    if (preparation.type === 'signal_received') {
      if (preparation.settlement.type === 'startup_resolved') {
        heartbeatPrepared = true;
      }
      return finish();
    }
    if (preparation.type === 'startup_rejected') {
      recordFixedFailure(HEARTBEAT_PUBLICATION_FAILED, 'heartbeat', true);
      return finish();
    }
    heartbeatPrepared = true;
    if (pendingUserSignal !== undefined) return finish();

    const assemblyCreation = await raceStartupOutcome(
      () => options.createAssembly({
        config,
        workerId,
        processStartedAt: new Date(processStartedAt.getTime()),
        heartbeat: heartbeat!,
        logger,
        signal: controller.signal,
        requestAbort,
        reportRunnerFailure,
        cleanup
      }),
      signalOutcome
    );
    if (assemblyCreation.type === 'signal_received') {
      if (assemblyCreation.settlement.type === 'startup_resolved') {
        assembly = assemblyCreation.settlement.value;
      }
      return finish();
    }
    if (assemblyCreation.type === 'startup_rejected') {
      recordFixedFailure(DEPENDENCY_STARTUP_FAILED, 'startup');
      return finish();
    }
    assembly = assemblyCreation.value;
    if (pendingUserSignal !== undefined) return finish();

    const probe = await raceStartupOutcome(
      () => assembly!.probeDependencies(),
      signalOutcome
    );
    if (probe.type === 'signal_received') return finish();
    if (probe.type === 'startup_rejected') {
      recordFixedFailure(DEPENDENCY_STARTUP_FAILED, 'startup');
      return finish();
    }
    if (pendingUserSignal !== undefined) return finish();

    const outcomeQueue = createRuntimeOutcomeQueue();
    activeOutcomeQueue = outcomeQueue;
    if (pendingRunnerFailureOutcome !== undefined) {
      outcomeQueue.push(pendingRunnerFailureOutcome);
      pendingRunnerFailureOutcome = undefined;
    }
    void signalLatch.promise.then(() => {
      const outcome = { type: 'signal_received' } as const;
      outcomeQueue.push(outcome);
      return outcome;
    });
    void readinessOutcome(
      heartbeat.firstHealthyPublication,
      (outcome) => outcomeQueue.push(outcome)
    );
    publisher = publisherOutcome(
      () => heartbeat!.run(controller.signal),
      (outcome) => outcomeQueue.push(outcome)
    );
    runner = runnerOutcome(
      () => assembly!.run(controller.signal),
      (outcome) => outcomeQueue.push(outcome)
    );

    while (fatalFailure === undefined && userSignal === undefined) {
      const outcome = await outcomeQueue.next();
      switch (outcome.type) {
        case 'signal_received':
          acceptUserSignal();
          break;
        case 'readiness_resolved':
          if (
            userSignal === undefined &&
            fatalFailure === undefined &&
            !internalAbortRequested &&
            (!controller.signal.aborted || pendingUserSignal !== undefined)
          ) {
            logger.emit({
              event: 'worker.ready',
              workerId,
              configuredSlots: config.worker.concurrency,
              durationMs: durationSince(startedAt, monotonicNow)
            });
          }
          break;
        case 'readiness_rejected':
          recordHeartbeatFailure(outcome.cause);
          break;
        case 'runner_resolved':
        case 'runner_rejected':
        case 'runner_failure_reported':
          classifyRunner(outcome);
          break;
        case 'publisher_resolved':
        case 'publisher_rejected':
          classifyPublisher(outcome);
          break;
      }
    }

    return finish();
  } finally {
    for (let index = unsubscribe.length - 1; index >= 0; index -= 1) {
      try {
        unsubscribe[index]!();
      } catch {
        // Both signal listeners must receive their disposal attempt.
      }
    }
  }
}
