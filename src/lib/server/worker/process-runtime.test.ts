import { describe, expect, it } from 'vitest';

import type { WorkerApplicationConfig } from '../config/load';
import { ConfigurationError } from '../config/read-setting';
import type { StructuredLogSink } from '../observability/logger';
import { runWorker } from '../jobs/runner';
import type { WorkerSlotProgressEvent } from '../jobs/runner-observer';
import type { JobHandler, JobRecord, JobRepository } from '../jobs/types';
import {
  WorkerHeartbeatPublicationError,
  type WorkerHeartbeatSupervisor
} from './heartbeat-supervisor';
import {
  runWorkerProcess,
  type RunWorkerProcessOptions,
  type WorkerProcessAssembly,
  type WorkerShutdownDeadline,
  type WorkerSignalSource
} from './process-runtime';

const UUID = '11111111-1111-4111-8111-111111111111';
const STARTED_AT = '2026-08-26T12:00:00.000Z';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function applicationConfig(configuredSlots = 2): WorkerApplicationConfig {
  return {
    environment: 'test',
    jobs: {
      pollIntervalMs: 1_000,
      leaseMs: 60_000,
      retryBaseMs: 1_000,
      retryMaxMs: 10_000
    },
    worker: {
      heartbeatFile: 'worker-heartbeat.json',
      concurrency: configuredSlots,
      heartbeatIntervalMs: 5_000,
      heartbeatMaxAgeMs: 20_000
    }
  } as unknown as WorkerApplicationConfig;
}

class SignalDouble implements WorkerSignalSource {
  readonly listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();

  constructor(private readonly trace: string[]) {}

  subscribe(signal: 'SIGINT' | 'SIGTERM', listener: () => void): () => void {
    this.trace.push(`subscribe:${signal}`);
    this.listeners.set(signal, listener);
    let disposed = false;
    return () => {
      if (disposed) throw new Error(`duplicate unsubscribe ${signal}`);
      disposed = true;
      this.trace.push(`unsubscribe:${signal}`);
      if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
    };
  }

  emit(signal: 'SIGINT' | 'SIGTERM'): void {
    this.trace.push(`signal:${signal}`);
    this.listeners.get(signal)?.();
  }
}

class DeadlineDouble implements WorkerShutdownDeadline {
  readonly gate = deferred<void>();
  readonly expired = this.gate.promise;
  cancelCalls = 0;

  constructor(private readonly trace: string[]) {}

  cancel(): void {
    this.cancelCalls += 1;
    this.trace.push('deadline:cancel');
  }

  expire(): void {
    this.trace.push('deadline:expire');
    this.gate.resolve(undefined);
  }
}

class HeartbeatDouble implements WorkerHeartbeatSupervisor {
  readonly firstPublication = deferred<void>();
  readonly firstHealthyPublication = this.firstPublication.promise;
  readonly runGate = deferred<void>();
  prepareFailure: unknown;
  prepareGate: Deferred<void> | undefined;
  removeFailure: unknown;
  removeGate: Deferred<void> | undefined;
  ignoreAbort = false;

  constructor(readonly trace: string[]) {}

  async prepare(): Promise<void> {
    this.trace.push('heartbeat:prepare');
    if (this.prepareGate !== undefined) await this.prepareGate.promise;
    if (this.prepareFailure !== undefined) throw this.prepareFailure;
  }

  reportSlotProgress(event: WorkerSlotProgressEvent): void {
    this.trace.push(`heartbeat:progress:${event.type}:${event.slotId}`);
  }

  run(signal: AbortSignal): Promise<void> {
    this.trace.push('heartbeat:run');
    if (!this.ignoreAbort) {
      if (signal.aborted) this.runGate.resolve(undefined);
      else signal.addEventListener(
        'abort',
        () => this.runGate.resolve(undefined),
        { once: true }
      );
    }
    return this.runGate.promise;
  }

  sealProgress(): void {
    this.trace.push('heartbeat:seal');
  }

  async removeEvidence(): Promise<void> {
    this.trace.push('heartbeat:remove');
    if (this.removeGate !== undefined) await this.removeGate.promise;
    if (this.removeFailure !== undefined) throw this.removeFailure;
  }

  publishFirst(): void {
    this.trace.push('heartbeat:published');
    this.firstPublication.resolve(undefined);
  }

  failPublication(error: WorkerHeartbeatPublicationError): void {
    this.trace.push('heartbeat:publication-failed');
    this.firstPublication.reject(error);
    this.runGate.reject(error);
  }
}

class AssemblyDouble implements WorkerProcessAssembly {
  readonly runnerGate = deferred<void>();
  probeFailure: unknown;
  probeGate: Deferred<void> | undefined;
  controlFailure: unknown;
  ignoreAbort = false;

  constructor(readonly trace: string[]) {}

  async probeDependencies(): Promise<void> {
    this.trace.push('assembly:probe');
    if (this.probeGate !== undefined) await this.probeGate.promise;
    if (this.probeFailure !== undefined) throw this.probeFailure;
  }

  run(signal: AbortSignal): Promise<void> {
    this.trace.push('runner:run');
    if (!this.ignoreAbort) {
      if (signal.aborted) this.runnerGate.resolve(undefined);
      else signal.addEventListener(
        'abort',
        () => this.runnerGate.resolve(undefined),
        { once: true }
      );
    }
    return this.runnerGate.promise;
  }

  assertControlHealthy(): void {
    this.trace.push('assembly:assert-control');
    if (this.controlFailure !== undefined) throw this.controlFailure;
  }

  resolveRunner(): void {
    this.trace.push('runner:resolve');
    this.runnerGate.resolve(undefined);
  }

  rejectRunner(error: unknown): void {
    this.trace.push('runner:reject');
    this.runnerGate.reject(error);
  }
}

type LogRecord = Readonly<Record<string, unknown>>;

interface ProcessHarness {
  readonly trace: string[];
  readonly rawLines: string[];
  readonly records: LogRecord[];
  readonly heartbeat: HeartbeatDouble;
  readonly assembly: AssemblyDouble;
  readonly signals: SignalDouble;
  readonly deadlines: DeadlineDouble[];
  readonly config: WorkerApplicationConfig;
  readonly options: RunWorkerProcessOptions;
  requestAbort: ((reason?: unknown) => void) | undefined;
  heartbeatInput: Parameters<RunWorkerProcessOptions['createHeartbeat']>[0] | undefined;
  monotonicMs: number;
  run(): Promise<0 | 1>;
}

function createHarness(overrides: Partial<RunWorkerProcessOptions> & {
  readonly config?: WorkerApplicationConfig;
  readonly heartbeat?: HeartbeatDouble;
  readonly assembly?: AssemblyDouble;
  readonly databaseClose?: () => void | Promise<void>;
  readonly emailClose?: () => void | Promise<void>;
} = {}): ProcessHarness {
  const trace: string[] = [];
  const rawLines: string[] = [];
  const records: LogRecord[] = [];
  const config = overrides.config ?? applicationConfig();
  const heartbeat = overrides.heartbeat ?? new HeartbeatDouble(trace);
  const assembly = overrides.assembly ?? new AssemblyDouble(trace);
  const signals = overrides.signals instanceof SignalDouble
    ? overrides.signals
    : new SignalDouble(trace);
  const deadlines: DeadlineDouble[] = [];
  let monotonicMs = 100;
  let requestAbort: ((reason?: unknown) => void) | undefined;
  let heartbeatInput: Parameters<RunWorkerProcessOptions['createHeartbeat']>[0] | undefined;

  const capture: StructuredLogSink = (line) => {
    rawLines.push(line);
    const record = JSON.parse(line) as LogRecord;
    records.push(record);
    trace.push(`log:${String(record.event)}`);
  };

  const options: RunWorkerProcessOptions = {
    environment: { APP_ENV: 'test' },
    loadConfig: (environment) => {
      trace.push('config:load');
      expect(environment).toBe(options.environment);
      return config;
    },
    createHeartbeat: (input) => {
      trace.push('heartbeat:create');
      heartbeatInput = input;
      return heartbeat;
    },
    createAssembly: async (input) => {
      trace.push('assembly:create');
      requestAbort = input.requestAbort;
      input.cleanup.register('database', overrides.databaseClose ?? (() => {
        trace.push('cleanup:database');
      }));
      input.cleanup.register('email', overrides.emailClose ?? (() => {
        trace.push('cleanup:email');
      }));
      return assembly;
    },
    wallNow: () => new Date(STARTED_AT),
    monotonicNow: () => monotonicMs,
    hostnameSource: () => {
      trace.push('identity:hostname');
      return 'worker-host';
    },
    pid: 42,
    uuidSource: () => {
      trace.push('identity:uuid');
      return UUID;
    },
    signals,
    createShutdownDeadline: (milliseconds) => {
      trace.push(`deadline:create:${milliseconds}`);
      const deadline = new DeadlineDouble(trace);
      deadlines.push(deadline);
      return deadline;
    },
    forceExit: (code) => {
      trace.push(`force-exit:${code}`);
    },
    stdout: capture,
    stderr: capture,
    ...overrides
  };

  const harness: ProcessHarness = {
    trace,
    rawLines,
    records,
    heartbeat,
    assembly,
    signals,
    deadlines,
    config,
    options,
    get requestAbort() { return requestAbort; },
    set requestAbort(value) { requestAbort = value; },
    get heartbeatInput() { return heartbeatInput; },
    set heartbeatInput(value) { heartbeatInput = value; },
    get monotonicMs() { return monotonicMs; },
    set monotonicMs(value) { monotonicMs = value; },
    run: () => runWorkerProcess(options)
  };
  return harness;
}

function lifecycle(records: readonly LogRecord[]): readonly LogRecord[] {
  return records.filter((record) => String(record.event).startsWith('worker.'));
}

function eventSummary(records: readonly LogRecord[]): readonly object[] {
  return lifecycle(records).map((record) => ({
    event: record.event,
    ...(record.code === undefined ? {} : { code: record.code }),
    ...(record.workerId === undefined ? {} : { workerId: record.workerId }),
    ...(record.configuredSlots === undefined
      ? {}
      : { configuredSlots: record.configuredSlots }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs })
  }));
}

async function waitForActivities(harness: ProcessHarness): Promise<void> {
  await waitFor(
    () => harness.trace.includes('runner:run') && harness.trace.includes('heartbeat:run'),
    'worker activities'
  );
}

function createRealRunnerRaceHarness(): {
  readonly harness: ProcessHarness;
  readonly claimsStarted: Promise<void>;
  readonly primaryClaim: Deferred<JobRecord | null>;
  readonly siblingClaim: Deferred<JobRecord | null>;
} {
  const claimsStarted = deferred<void>();
  const primaryClaim = deferred<JobRecord | null>();
  const siblingClaim = deferred<JobRecord | null>();
  let claimCount = 0;
  const repository: JobRepository = {
    claimNext(leaseOwner) {
      claimCount += 1;
      if (claimCount === 2) claimsStarted.resolve(undefined);
      return leaseOwner.endsWith(':0') ? primaryClaim.promise : siblingClaim.promise;
    },
    renewLease: async () => true,
    complete: async () => true,
    fail: async () => true,
    failWithDisposition: async () => ({ applied: true, retryScheduled: false }),
    renewOperationsJobLease: async () => true,
    completeOperationsJob: async () => true,
    failOperationsJob: async () => ({ applied: true, retryScheduled: false })
  };
  const harness = createHarness({
    createAssembly: async (input) => {
      harness.trace.push('assembly:create');
      input.cleanup.register('database', () => {
        harness.trace.push('cleanup:database');
      });
      input.cleanup.register('email', () => {
        harness.trace.push('cleanup:email');
      });
      return {
        async probeDependencies() {
          harness.trace.push('assembly:probe');
        },
        run: (signal) => runWorker({
          repository,
          handlers: new Map(),
          workerId: input.workerId,
          concurrency: 2,
          pollIntervalMs: 1,
          leaseRenewalIntervalMs: 1,
          signal,
          onFirstFailure: input.reportRunnerFailure
        }),
        assertControlHealthy() {
          harness.trace.push('assembly:assert-control');
        }
      };
    }
  });
  return {
    harness,
    claimsStarted: claimsStarted.promise,
    primaryClaim,
    siblingClaim
  };
}

describe('runWorkerProcess startup and readiness', () => {
  it('creates the logger before classifying invalid configuration without constructing identity', async () => {
    const canary = 'configuration-private-canary';
    const harness = createHarness({
      loadConfig: () => { throw new ConfigurationError(canary); }
    });

    await expect(harness.run()).resolves.toBe(1);

    expect(eventSummary(harness.records)).toEqual([
      { event: 'worker.failed', code: 'configuration_invalid' }
    ]);
    expect(harness.trace).not.toContain('identity:hostname');
    expect(harness.trace).not.toContain('identity:uuid');
    expect(harness.rawLines.join('')).not.toContain(canary);
  });

  it.each([
    ['invalid PID', { pid: 0 }],
    ['invalid UUID', { uuidSource: () => `${UUID.slice(0, -1)}A` }],
    ['throwing hostname source', { hostnameSource: () => { throw new Error('private-host'); } }]
  ] as const)('fails a %s with a fixed identity code and no worker ID', async (_name, change) => {
    const harness = createHarness(change);

    await expect(harness.run()).resolves.toBe(1);

    expect(eventSummary(harness.records)).toEqual([
      { event: 'worker.failed', code: 'worker_identity_invalid' }
    ]);
    expect(harness.trace).not.toContain('heartbeat:create');
    expect(harness.rawLines.join('')).not.toContain('private-host');
  });

  it('uses the bounded fallback identity and orders prepare, assembly, probes, activities, readiness, and cleanup', async () => {
    const harness = createHarness({ hostnameSource: () => 'invalid hostname/private' });
    const running = harness.run();
    await waitForActivities(harness);

    const workerId = `worker:42:${UUID}`;
    expect(harness.heartbeatInput).toMatchObject({
      config: harness.config,
      workerId,
      processStartedAt: new Date(STARTED_AT)
    });
    for (const [earlier, later] of [
      ['log:worker.started', 'heartbeat:create'],
      ['heartbeat:create', 'heartbeat:prepare'],
      ['heartbeat:prepare', 'assembly:create'],
      ['assembly:create', 'assembly:probe'],
      ['assembly:probe', 'heartbeat:run'],
      ['assembly:probe', 'runner:run']
    ] as const) {
      expect(harness.trace.indexOf(earlier), `${earlier} before ${later}`)
        .toBeLessThan(harness.trace.indexOf(later));
    }
    expect(lifecycle(harness.records).map((record) => record.event)).toEqual([
      'worker.started'
    ]);

    harness.heartbeat.reportSlotProgress({ type: 'poll_succeeded', slotId: 1, claimed: false });
    harness.heartbeat.reportSlotProgress({ type: 'poll_succeeded', slotId: 0, claimed: false });
    await flushMicrotasks();
    expect(lifecycle(harness.records).map((record) => record.event)).toEqual([
      'worker.started'
    ]);

    harness.monotonicMs = 125.9;
    harness.heartbeat.publishFirst();
    await waitFor(
      () => harness.records.some((record) => record.event === 'worker.ready'),
      'ready event'
    );
    harness.monotonicMs = 150.8;
    harness.signals.emit('SIGTERM');
    await expect(running).resolves.toBe(0);

    expect(eventSummary(harness.records)).toEqual([
      { event: 'worker.started', workerId, configuredSlots: 2 },
      { event: 'worker.ready', workerId, configuredSlots: 2, durationMs: 25 },
      { event: 'worker.stopping', workerId, code: 'signal_sigterm' },
      { event: 'worker.stopped', workerId, durationMs: 50 }
    ]);
    expect(harness.trace.indexOf('heartbeat:seal')).toBeLessThan(
      harness.trace.indexOf('heartbeat:remove')
    );
    expect(harness.trace.indexOf('heartbeat:remove')).toBeLessThan(
      harness.trace.indexOf('cleanup:email')
    );
    expect(harness.trace.indexOf('cleanup:email')).toBeLessThan(
      harness.trace.indexOf('cleanup:database')
    );
    expect(harness.trace.filter((entry) => entry === 'unsubscribe:SIGINT')).toHaveLength(1);
    expect(harness.trace.filter((entry) => entry === 'unsubscribe:SIGTERM')).toHaveLength(1);
  });

  it('does not start runner or publisher until the dependency probes finish', async () => {
    const harness = createHarness();
    harness.assembly.probeGate = deferred<void>();
    const running = harness.run();
    await waitFor(() => harness.trace.includes('assembly:probe'), 'probe start');

    expect(harness.trace).not.toContain('heartbeat:run');
    expect(harness.trace).not.toContain('runner:run');
    harness.assembly.probeGate.resolve(undefined);
    await waitForActivities(harness);
    harness.signals.emit('SIGINT');
    await expect(running).resolves.toBe(0);
  });

  it.each([
    ['regression', 50, 0],
    ['NaN', Number.NaN, 0],
    ['infinity', Infinity, 0],
    ['upper cap', 100 + 86_400_001, 86_400_000]
  ] as const)('clamps %s ready and stopped monotonic durations', async (
    _name,
    endedAt,
    expectedDuration
  ) => {
    const harness = createHarness();
    const running = harness.run();
    await waitForActivities(harness);
    harness.monotonicMs = endedAt;
    harness.heartbeat.publishFirst();
    await waitFor(
      () => harness.records.some((record) => record.event === 'worker.ready'),
      'ready event'
    );
    harness.signals.emit('SIGINT');
    await expect(running).resolves.toBe(0);

    const ready = harness.records.find((record) => record.event === 'worker.ready');
    const stopped = harness.records.find((record) => record.event === 'worker.stopped');
    expect(ready?.durationMs).toBe(expectedDuration);
    expect(stopped?.durationMs).toBe(expectedDuration);
  });

  it.each(['construction', 'preparation'] as const)(
    'reports heartbeat then worker failure for heartbeat %s failure',
    async (phase) => {
      const canary = `private-${phase}`;
      const harness = createHarness({
        ...(phase === 'construction'
          ? { createHeartbeat: () => { throw new Error(canary); } }
          : {})
      });
      if (phase === 'preparation') {
        harness.heartbeat.prepareFailure = new Error(canary);
      }

      await expect(harness.run()).resolves.toBe(1);

      expect(eventSummary(harness.records).slice(-2)).toEqual([
        {
          event: 'worker.heartbeat_failed',
          workerId: `worker-host:42:${UUID}`,
          code: 'heartbeat_publication_failed'
        },
        {
          event: 'worker.failed',
          workerId: `worker-host:42:${UUID}`,
          code: 'heartbeat_publication_failed'
        }
      ]);
      expect(harness.rawLines.join('')).not.toContain(canary);
      expect(harness.trace.filter((entry) => entry === 'unsubscribe:SIGINT')).toHaveLength(1);
      expect(harness.trace.filter((entry) => entry === 'unsubscribe:SIGTERM')).toHaveLength(1);
    }
  );

  it.each(['assembly', 'probe'] as const)(
    'classifies %s startup failure and cleans every registered resource in reverse order',
    async (phase) => {
      const harness = createHarness({
        ...(phase === 'assembly'
          ? {
              createAssembly: async (input) => {
                harness.trace.push('assembly:create');
                input.cleanup.register(
                  'database',
                  () => { harness.trace.push('cleanup:database'); }
                );
                throw new Error('private-assembly');
              }
            }
          : {})
      });
      if (phase === 'probe') {
        harness.assembly.probeFailure = new Error('private-probe');
      }

      await expect(harness.run()).resolves.toBe(1);

      expect(eventSummary(harness.records).at(-1)).toEqual({
        event: 'worker.failed',
        workerId: `worker-host:42:${UUID}`,
        code: 'dependency_startup_failed'
      });
      expect(harness.trace.indexOf('heartbeat:remove')).toBeLessThan(
        harness.trace.indexOf(phase === 'assembly' ? 'cleanup:database' : 'cleanup:email')
      );
      if (phase === 'probe') {
        expect(harness.trace.indexOf('cleanup:email')).toBeLessThan(
          harness.trace.indexOf('cleanup:database')
        );
      }
      expect(harness.deadlines).toHaveLength(1);
      expect(harness.deadlines[0]?.cancelCalls).toBe(1);
    }
  );
});

describe('runWorkerProcess runtime races and shutdown', () => {
  it('treats the first pre-readiness signal as normal, suppresses duplicates, and uses no fatal deadline', async () => {
    const harness = createHarness();
    const running = harness.run();
    await waitForActivities(harness);

    harness.signals.emit('SIGINT');
    harness.signals.emit('SIGINT');
    harness.signals.emit('SIGTERM');
    await expect(running).resolves.toBe(0);

    expect(eventSummary(harness.records)).toEqual([
      {
        event: 'worker.started',
        workerId: `worker-host:42:${UUID}`,
        configuredSlots: 2
      },
      {
        event: 'worker.stopping',
        workerId: `worker-host:42:${UUID}`,
        code: 'signal_sigint'
      },
      {
        event: 'worker.stopped',
        workerId: `worker-host:42:${UUID}`,
        durationMs: 0
      }
    ]);
    expect(harness.deadlines).toEqual([]);
    expect(harness.trace).not.toContain('force-exit:1');
  });

  it('latches a signal during a gated probe and suppresses its secondary abort rejection', async () => {
    const harness = createHarness();
    harness.assembly.probeGate = deferred<void>();
    harness.assembly.probeFailure = new Error('probe aborted privately');
    const running = harness.run();
    await waitFor(() => harness.trace.includes('assembly:probe'), 'probe start');

    harness.signals.emit('SIGTERM');
    harness.assembly.probeGate.resolve(undefined);
    await expect(running).resolves.toBe(0);

    expect(lifecycle(harness.records).map((record) => record.event)).toEqual([
      'worker.started',
      'worker.stopping',
      'worker.stopped'
    ]);
  });

  it.each(['preparation', 'assembly', 'probe'] as const)(
    'retains an earlier %s rejection over a later same-turn signal',
    async (phase) => {
      const gate = deferred<never>();
      const harness = createHarness({
        ...(phase === 'assembly'
          ? {
              createAssembly: () => {
                harness.trace.push('assembly:create');
                return gate.promise;
              }
            }
          : {})
      });
      if (phase === 'preparation') {
        harness.heartbeat.prepare = () => {
          harness.trace.push('heartbeat:prepare');
          return gate.promise;
        };
      }
      if (phase === 'probe') {
        harness.assembly.probeDependencies = () => {
          harness.trace.push('assembly:probe');
          return gate.promise;
        };
      }
      const running = harness.run();
      await waitFor(
        () => harness.trace.includes(
          phase === 'preparation'
            ? 'heartbeat:prepare'
            : phase === 'assembly'
              ? 'assembly:create'
              : 'assembly:probe'
        ),
        `${phase} start`
      );

      gate.reject(new Error(`primary-${phase}`));
      harness.signals.emit('SIGTERM');
      await expect(running).resolves.toBe(1);

      const expectedCode = phase === 'preparation'
        ? 'heartbeat_publication_failed'
        : 'dependency_startup_failed';
      expect(eventSummary(harness.records).at(-1)).toMatchObject({
        event: 'worker.failed',
        code: expectedCode
      });
      expect(harness.records.some((record) => record.event === 'worker.stopping')).toBe(false);
      expect(harness.records.some((record) => record.event === 'worker.stopped')).toBe(false);
    }
  );

  it('subscribes before a gated heartbeat preparation and cleans normally after a signal', async () => {
    const harness = createHarness();
    harness.heartbeat.prepareGate = deferred<void>();
    const running = harness.run();
    await waitFor(
      () => harness.trace.includes('heartbeat:prepare'),
      'heartbeat preparation'
    );

    harness.signals.emit('SIGTERM');
    harness.heartbeat.prepareGate.resolve(undefined);
    await expect(running).resolves.toBe(0);

    expect(lifecycle(harness.records).map((record) => record.event)).toEqual([
      'worker.started',
      'worker.stopping',
      'worker.stopped'
    ]);
    expect(harness.trace).not.toContain('assembly:create');
    expect(harness.trace.filter((entry) => entry === 'unsubscribe:SIGINT')).toHaveLength(1);
    expect(harness.trace.filter((entry) => entry === 'unsubscribe:SIGTERM')).toHaveLength(1);
  });

  it('classifies a runner rejection as primary, aborts the publisher, and never emits stopped', async () => {
    const harness = createHarness();
    const running = harness.run();
    await waitForActivities(harness);
    harness.assembly.rejectRunner(new Error('private-runner'));

    await expect(running).resolves.toBe(1);

    expect(eventSummary(harness.records).at(-1)).toEqual({
      event: 'worker.failed',
      workerId: `worker-host:42:${UUID}`,
      code: 'runner_failed'
    });
    expect(harness.records.some((record) => record.event === 'worker.stopped')).toBe(false);
    expect(harness.trace).toContain('heartbeat:seal');
    expect(harness.deadlines[0]?.cancelCalls).toBe(1);
  });

  it('starts the fatal deadline from a real runner first failure while a sibling stays hung', async () => {
    const primaryCanary = 'private-real-runner-primary';
    const handlerStarted = deferred<void>();
    const allowPrimaryFailure = deferred<void>();
    const handlerGate = deferred<void>();
    let handlerSignal: AbortSignal | undefined;
    const claimedJob: JobRecord = {
      id: UUID,
      type: 'test.hung-handler',
      payload: {},
      deduplicationKey: null,
      attempts: 1,
      maxAttempts: 3,
      lockedBy: 'worker-slot-1'
    };
    const repository: JobRepository = {
      claimNext: async (leaseOwner) => {
        if (leaseOwner.endsWith(':0')) {
          await handlerStarted.promise;
          await allowPrimaryFailure.promise;
          throw new Error(primaryCanary);
        }
        return claimedJob;
      },
      renewLease: async () => true,
      complete: async () => true,
      fail: async () => true,
      failWithDisposition: async () => ({ applied: true, retryScheduled: false }),
      renewOperationsJobLease: async () => true,
      completeOperationsJob: async () => true,
      failOperationsJob: async () => ({ applied: true, retryScheduled: false })
    };
    const handler: JobHandler = async (_job, signal) => {
      handlerSignal = signal;
      handlerStarted.resolve(undefined);
      await handlerGate.promise;
    };
    const harness = createHarness({
      createAssembly: async (input) => {
        harness.trace.push('assembly:create');
        input.cleanup.register('database', () => {
          harness.trace.push('cleanup:database');
        });
        input.cleanup.register('email', () => {
          harness.trace.push('cleanup:email');
        });
        return {
          async probeDependencies() {
            harness.trace.push('assembly:probe');
          },
          run: (signal) => runWorker({
            repository,
            handlers: new Map([[claimedJob.type, handler]]),
            workerId: input.workerId,
            concurrency: 2,
            pollIntervalMs: 1,
            leaseRenewalIntervalMs: 1,
            signal,
            onFirstFailure: input.reportRunnerFailure,
            leaseRenewalSleep: async (_milliseconds, renewalSignal) => {
              if (renewalSignal.aborted) return;
              await new Promise<void>((resolve) => {
                renewalSignal.addEventListener('abort', () => resolve(), { once: true });
              });
            }
          }),
          assertControlHealthy() {
            harness.trace.push('assembly:assert-control');
          }
        };
      }
    });
    const running = harness.run();
    await handlerStarted.promise;
    harness.heartbeat.publishFirst();
    await waitFor(
      () => harness.records.some((record) => record.event === 'worker.ready'),
      'real runner readiness'
    );

    allowPrimaryFailure.resolve(undefined);
    await flushMicrotasks(50);
    const deadlineStartedBeforeSiblingSettlement = harness.deadlines.length === 1;
    if (deadlineStartedBeforeSiblingSettlement) {
      expect(eventSummary(harness.records).at(-1)).toMatchObject({
        event: 'worker.failed',
        code: 'runner_failed'
      });
      expect(handlerSignal?.aborted).toBe(true);
      expect(harness.trace).toContain('deadline:create:10000');
      harness.deadlines[0]!.expire();
      await expect(running).resolves.toBe(1);
      handlerGate.resolve(undefined);
      await flushMicrotasks(50);
    } else {
      handlerGate.resolve(undefined);
      await expect(running).resolves.toBe(1);
    }

    expect(deadlineStartedBeforeSiblingSettlement).toBe(true);
    expect(harness.rawLines.join('')).not.toContain(primaryCanary);
    expect(harness.records.some((record) => record.event === 'worker.stopped')).toBe(false);
  });

  it('keeps a real runner failure primary when SIGINT follows in the same turn', async () => {
    const race = createRealRunnerRaceHarness();
    const running = race.harness.run();
    await race.claimsStarted;
    race.harness.heartbeat.publishFirst();
    await waitFor(
      () => race.harness.records.some((record) => record.event === 'worker.ready'),
      'real runner readiness'
    );

    race.primaryClaim.reject(new Error('private-runner-first'));
    race.harness.signals.emit('SIGINT');
    await waitFor(() => race.harness.deadlines.length === 1, 'fatal shutdown deadline');

    expect(eventSummary(race.harness.records).at(-1)).toMatchObject({
      event: 'worker.failed',
      code: 'runner_failed'
    });
    expect(race.harness.records.some((record) => record.event === 'worker.stopping')).toBe(false);
    race.harness.deadlines[0]!.expire();
    await expect(running).resolves.toBe(1);
    race.siblingClaim.resolve(null);
    await flushMicrotasks(50);
    expect(race.harness.rawLines.join('')).not.toContain('private-runner-first');
  });

  it('keeps SIGINT primary when a real runner failure follows in the same turn', async () => {
    const race = createRealRunnerRaceHarness();
    const running = race.harness.run();
    await race.claimsStarted;
    race.harness.heartbeat.publishFirst();
    await waitFor(
      () => race.harness.records.some((record) => record.event === 'worker.ready'),
      'real runner readiness'
    );

    race.harness.signals.emit('SIGINT');
    race.primaryClaim.reject(new Error('private-runner-second'));
    race.siblingClaim.resolve(null);
    await expect(running).resolves.toBe(0);

    expect(lifecycle(race.harness.records).map((record) => record.event)).toEqual([
      'worker.started',
      'worker.ready',
      'worker.stopping',
      'worker.stopped'
    ]);
    expect(race.harness.deadlines).toHaveLength(0);
    expect(race.harness.rawLines.join('')).not.toContain('private-runner-second');
  });

  it('asserts control health before classifying an unsignaled runner resolution', async () => {
    const harness = createHarness();
    const running = harness.run();
    await waitForActivities(harness);
    harness.assembly.resolveRunner();

    await expect(running).resolves.toBe(1);

    expect(harness.trace.indexOf('assembly:assert-control')).toBeLessThan(
      harness.trace.indexOf('log:worker.failed')
    );
    expect(eventSummary(harness.records).at(-1)).toMatchObject({
      event: 'worker.failed',
      code: 'runner_stopped_unexpectedly'
    });
  });

  it('fails with the safe fallback when the publisher resolves without an abort or signal', async () => {
    const harness = createHarness();
    const running = harness.run();
    await waitForActivities(harness);
    harness.heartbeat.runGate.resolve(undefined);

    await expect(running).resolves.toBe(1);

    expect(eventSummary(harness.records).at(-1)).toMatchObject({
      event: 'worker.failed',
      code: 'unexpected_failure'
    });
    expect(harness.records.filter((record) => record.event === 'worker.failed')).toHaveLength(1);
  });

  it('deduplicates one typed publication rejection across readiness and publisher outcomes', async () => {
    const canary = 'private-heartbeat-path-and-record';
    const harness = createHarness();
    const running = harness.run();
    await waitForActivities(harness);
    const failure = new WorkerHeartbeatPublicationError(new Error(canary));
    harness.heartbeat.failPublication(failure);

    await expect(running).resolves.toBe(1);

    expect(eventSummary(harness.records).slice(-2)).toEqual([
      {
        event: 'worker.heartbeat_failed',
        workerId: `worker-host:42:${UUID}`,
        code: 'heartbeat_publication_failed'
      },
      {
        event: 'worker.failed',
        workerId: `worker-host:42:${UUID}`,
        code: 'heartbeat_publication_failed'
      }
    ]);
    expect(harness.records.filter((record) => record.event === 'worker.failed')).toHaveLength(1);
    expect(harness.rawLines.join('')).not.toContain(canary);
  });

  it('retains an earlier same-turn publisher failure after readiness beats a later runner rejection', async () => {
    const harness = createHarness();
    const running = harness.run();
    await waitForActivities(harness);

    harness.heartbeat.publishFirst();
    harness.heartbeat.failPublication(
      new WorkerHeartbeatPublicationError(new Error('private-publication'))
    );
    harness.assembly.rejectRunner(new Error('later-runner'));
    await expect(running).resolves.toBe(1);

    expect(eventSummary(harness.records)).toEqual([
      {
        event: 'worker.started',
        workerId: `worker-host:42:${UUID}`,
        configuredSlots: 2
      },
      {
        event: 'worker.ready',
        workerId: `worker-host:42:${UUID}`,
        configuredSlots: 2,
        durationMs: 0
      },
      {
        event: 'worker.heartbeat_failed',
        workerId: `worker-host:42:${UUID}`,
        code: 'heartbeat_publication_failed'
      },
      {
        event: 'worker.failed',
        workerId: `worker-host:42:${UUID}`,
        code: 'heartbeat_publication_failed'
      }
    ]);
  });

  it.each([
    ['readiness before runner failure', true],
    ['runner failure before readiness', false]
  ] as const)('preserves same-turn %s ordering', async (_name, readinessFirst) => {
    const harness = createHarness();
    const running = harness.run();
    await waitForActivities(harness);

    if (readinessFirst) {
      harness.heartbeat.publishFirst();
      harness.assembly.rejectRunner(new Error('private-runner-second'));
    } else {
      harness.assembly.rejectRunner(new Error('private-runner-first'));
      harness.heartbeat.publishFirst();
    }
    await expect(running).resolves.toBe(1);

    expect(lifecycle(harness.records).map((record) => record.event)).toEqual([
      'worker.started',
      ...(readinessFirst ? ['worker.ready'] : []),
      'worker.failed'
    ]);
    expect(harness.rawLines.join('')).not.toContain('private-runner');
  });

  it('keeps readiness primary over a later synchronous runner start throw', async () => {
    const harness = createHarness({
      createAssembly: async (input) => {
        harness.trace.push('assembly:create');
        input.cleanup.register('database', () => {
          harness.trace.push('cleanup:database');
        });
        input.cleanup.register('email', () => {
          harness.trace.push('cleanup:email');
        });
        return {
          async probeDependencies() {
            harness.trace.push('assembly:probe');
          },
          run() {
            harness.trace.push('runner:run');
            throw new Error('private-synchronous-runner');
          },
          assertControlHealthy() {
            harness.trace.push('assembly:assert-control');
          }
        };
      }
    });
    const normalRun = harness.heartbeat.run.bind(harness.heartbeat);
    harness.heartbeat.run = (signal) => {
      harness.heartbeat.publishFirst();
      return normalRun(signal);
    };

    await expect(harness.run()).resolves.toBe(1);

    expect(lifecycle(harness.records).map((record) => record.event)).toEqual([
      'worker.started',
      'worker.ready',
      'worker.failed'
    ]);
    expect(harness.rawLines.join('')).not.toContain('private-synchronous-runner');
  });

  it('retains an earlier same-turn runner failure over a later signal', async () => {
    const harness = createHarness();
    const running = harness.run();
    await waitForActivities(harness);

    harness.heartbeat.publishFirst();
    harness.assembly.rejectRunner(new Error('primary-runner'));
    harness.signals.emit('SIGINT');
    await expect(running).resolves.toBe(1);

    expect(eventSummary(harness.records)).toEqual([
      {
        event: 'worker.started',
        workerId: `worker-host:42:${UUID}`,
        configuredSlots: 2
      },
      {
        event: 'worker.ready',
        workerId: `worker-host:42:${UUID}`,
        configuredSlots: 2,
        durationMs: 0
      },
      {
        event: 'worker.failed',
        workerId: `worker-host:42:${UUID}`,
        code: 'runner_failed'
      }
    ]);
    expect(harness.records.some((record) => record.event === 'worker.stopping')).toBe(false);
    expect(harness.records.some((record) => record.event === 'worker.stopped')).toBe(false);
  });

  it('distinguishes requestAbort from a user signal and checks control before runner classification', async () => {
    const harness = createHarness();
    harness.assembly.controlFailure = new Error('private-control');
    const running = harness.run();
    await waitForActivities(harness);

    harness.requestAbort?.(new Error('private-request-abort'));
    await expect(running).resolves.toBe(1);

    expect(harness.records.some((record) => record.event === 'worker.stopping')).toBe(false);
    expect(harness.trace.indexOf('assembly:assert-control')).toBeLessThan(
      harness.trace.indexOf('log:worker.failed')
    );
    expect(eventSummary(harness.records).at(-1)).toMatchObject({
      event: 'worker.failed',
      code: 'worker_control_failed'
    });
  });

  it('checks control health before classifying a rejected runner settlement', async () => {
    const harness = createHarness();
    harness.assembly.controlFailure = new Error('private-control');
    harness.assembly.ignoreAbort = true;
    const running = harness.run();
    await waitForActivities(harness);

    harness.requestAbort?.(new Error('private-request-abort'));
    harness.assembly.rejectRunner(new Error('secondary-runner-rejection'));
    await expect(running).resolves.toBe(1);

    expect(harness.records.some((record) => record.event === 'worker.stopping')).toBe(false);
    expect(harness.trace.indexOf('assembly:assert-control')).toBeLessThan(
      harness.trace.indexOf('log:worker.failed')
    );
    expect(eventSummary(harness.records).at(-1)).toMatchObject({
      event: 'worker.failed',
      code: 'worker_control_failed'
    });
  });

  it('turns normal-path cleanup failure into one failure, attempts later cleanup, and emits no stopped', async () => {
    const harness = createHarness({
      emailClose: () => {
        harness.trace.push('cleanup:email');
        throw new Error('private-email-cleanup');
      }
    });
    const running = harness.run();
    await waitForActivities(harness);
    harness.heartbeat.publishFirst();
    await waitFor(
      () => harness.records.some((record) => record.event === 'worker.ready'),
      'ready event'
    );
    harness.signals.emit('SIGTERM');

    await expect(running).resolves.toBe(1);

    expect(eventSummary(harness.records).at(-1)).toMatchObject({
      event: 'worker.failed',
      code: 'cleanup_failed'
    });
    expect(harness.trace).toContain('cleanup:database');
    expect(harness.records.some((record) => record.event === 'worker.stopped')).toBe(false);
    expect(harness.deadlines).toEqual([]);
  });

  it('retains an earlier fatal failure when cleanup also fails', async () => {
    const harness = createHarness({
      emailClose: () => {
        harness.trace.push('cleanup:email');
        throw new Error('secondary-cleanup');
      },
      databaseClose: () => {
        harness.trace.push('cleanup:database');
        throw new Error('third-cleanup');
      }
    });
    const running = harness.run();
    await waitForActivities(harness);
    harness.assembly.rejectRunner(new Error('primary-runner'));

    await expect(running).resolves.toBe(1);

    expect(harness.records.filter((record) => record.event === 'worker.failed')).toHaveLength(1);
    expect(eventSummary(harness.records).at(-1)).toMatchObject({ code: 'runner_failed' });
    expect(harness.trace).toContain('cleanup:email');
    expect(harness.trace).toContain('cleanup:database');
    expect(harness.deadlines[0]?.cancelCalls).toBe(1);
  });

  it.each(['activity', 'cleanup'] as const)(
    'force-exits once when fatal %s settlement exceeds the fixed deadline',
    async (wedged) => {
      const closerGate = deferred<void>();
      const harness = createHarness({
        ...(wedged === 'cleanup'
          ? {
              emailClose: async () => {
                harness.trace.push('cleanup:email');
                await closerGate.promise;
              }
            }
          : {})
      });
      if (wedged === 'activity') harness.heartbeat.ignoreAbort = true;
      const running = harness.run();
      await waitForActivities(harness);
      harness.assembly.rejectRunner(new Error('primary-fatal'));
      await waitFor(() => harness.deadlines.length === 1, 'fatal deadline');
      harness.signals.emit('SIGTERM');
      harness.deadlines[0]!.expire();

      await expect(running).resolves.toBe(1);

      expect(harness.trace.filter((entry) => entry === 'force-exit:1')).toHaveLength(1);
      expect(harness.deadlines[0]?.cancelCalls).toBe(0);
      expect(harness.records.filter((record) => record.event === 'worker.failed')).toHaveLength(1);
      expect(harness.records.some((record) => record.event === 'worker.stopping')).toBe(false);
      expect(harness.records.some((record) => record.event === 'worker.stopped')).toBe(false);
      if (wedged === 'cleanup') {
        closerGate.reject(new Error('late-private-cleanup'));
        await flushMicrotasks();
      }
    }
  );
});

describe('runWorkerProcess logger policy and privacy', () => {
  it('contains production sink failures without changing normal lifecycle or cleanup', async () => {
    const fallbackLines: string[] = [];
    const harness = createHarness({
      environment: { APP_ENV: 'production' },
      stdout: () => { throw new Error('private-stdout'); },
      stderr: (line) => fallbackLines.push(line)
    });
    const running = harness.run();
    await waitForActivities(harness);
    harness.signals.emit('SIGINT');

    await expect(running).resolves.toBe(0);

    expect(fallbackLines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: 'logging.failure', service: 'worker' }),
      expect.objectContaining({ event: 'logging.failure', service: 'worker' }),
      expect.objectContaining({ event: 'logging.failure', service: 'worker' })
    ]);
    expect(harness.trace.indexOf('heartbeat:remove')).toBeLessThan(
      harness.trace.indexOf('cleanup:email')
    );
    expect(harness.trace).not.toContain('force-exit:1');
  });

  it.each(['test', 'development', 'Production', 'staging'])(
    'uses strict nonproduction logging for raw APP_ENV=%s',
    async (rawEnvironment) => {
      const sinkFailure = new Error(`strict-${rawEnvironment}`);
      const harness = createHarness({
        environment: { APP_ENV: rawEnvironment },
        loadConfig: () => { throw new ConfigurationError('invalid config'); },
        stderr: () => { throw sinkFailure; }
      });

      await expect(harness.run()).rejects.toBe(sinkFailure);
    }
  );

  it('never inspects or serializes raw boundary errors, messages, stacks, or privacy canaries', async () => {
    const canary = 'customer@example.test/private/path/secret';
    const accessorNames = ['name', 'message', 'stack', 'code', 'cause'] as const;
    const guarded = <T extends object>(value: T): {
      readonly value: T;
      readonly readCount: () => number;
    } => {
      let reads = 0;
      for (const accessorName of accessorNames) {
        Object.defineProperty(value, accessorName, {
          configurable: true,
          enumerable: true,
          get() {
            reads += 1;
            return `${canary}:${accessorName}`;
          }
        });
      }
      return { value, readCount: () => reads };
    };

    for (const scenarioName of [
      'configuration',
      'probe',
      'runner',
      'heartbeat',
      'control',
      'cleanup'
    ] as const) {
      const guardedCause = guarded(Object.create(null) as object);
      const guardedBoundary = guarded(
        scenarioName === 'configuration'
          ? new ConfigurationError(canary)
          : scenarioName === 'heartbeat'
            ? new WorkerHeartbeatPublicationError(guardedCause.value)
            : Object.create(null) as object
      );
      const boundary = guardedBoundary.value;
      const harness = scenarioName === 'configuration'
        ? createHarness({ loadConfig: () => { throw boundary; } })
        : scenarioName === 'cleanup'
          ? createHarness({ emailClose: () => { throw boundary; } })
          : createHarness();
      if (scenarioName === 'probe') harness.assembly.probeFailure = boundary;
      if (scenarioName === 'control') harness.assembly.controlFailure = boundary;
      const running = harness.run();
      if (scenarioName === 'runner') {
        await waitForActivities(harness);
        harness.assembly.rejectRunner(boundary);
      }
      if (scenarioName === 'heartbeat') {
        await waitForActivities(harness);
        harness.heartbeat.failPublication(boundary as WorkerHeartbeatPublicationError);
      }
      if (scenarioName === 'control') {
        await waitForActivities(harness);
        harness.requestAbort?.(boundary);
      }
      if (scenarioName === 'cleanup') {
        await waitForActivities(harness);
        harness.signals.emit('SIGINT');
      }
      await expect(running).resolves.toBe(1);
      const output = harness.rawLines.join('');
      expect(guardedBoundary.readCount(), scenarioName).toBe(0);
      expect(guardedCause.readCount(), scenarioName).toBe(0);
      expect(output, scenarioName).not.toContain(canary);
      expect(output, scenarioName).not.toContain('"message"');
      expect(output, scenarioName).not.toContain('"stack"');
      expect(output, scenarioName).not.toContain('"cause"');
    }
  });
});
