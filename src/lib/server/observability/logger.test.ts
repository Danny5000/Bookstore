import { describe, expect, expectTypeOf, test, vi } from 'vitest';

import type { CorrelationId, SafeCode, StructuredEventInputFor, StructuredLogService } from './contracts';
import { createStructuredLogger } from './logger';

const timestamp = '2026-08-24T12:34:56.789Z';
const clock = () => new Date(timestamp);
const correlationId = 'request-1' as CorrelationId;
const code = <C extends string>(value: C) => value as SafeCode<C>;
const jobId = '01234567-89ab-cdef-0123-456789abcdef';
const runId = '0123456789abcdef';
const webCompleted = { event: 'http.request.completed', correlationId, method: 'GET', route: '/books', httpStatus: 200, durationMs: 12 } satisfies StructuredEventInputFor<'web'>;
const webRejected = { event: 'http.request.rejected', correlationId, method: 'GET', route: '/books', httpStatus: 400, code: code('invalid_request'), durationMs: 3 } satisfies StructuredEventInputFor<'web'>;
const workerStarted = { event: 'worker.started', workerId: 'worker-1', configuredSlots: 2 } satisfies StructuredEventInputFor<'worker'>;
const jobFailed = { event: 'job.failed', correlationId, jobId, jobKind: 'email', attempt: 1, maxAttempts: 3, workerId: 'worker-1', slotId: 0, code: code('permanent_job_failure'), durationMs: 9, retryScheduled: true } satisfies StructuredEventInputFor<'worker'>;
const smokeStarted = { event: 'smoke.stage.started', profile: 'maintenance_fixture', runId, candidateId: jobId, stage: 'preflight' } satisfies StructuredEventInputFor<'plan6b-production-smoke'>;

type SinkFixture =
  | { readonly service: 'web'; readonly input: StructuredEventInputFor<'web'>; readonly sink: 'stdout' | 'stderr'; readonly severity: string; readonly outcome: string }
  | { readonly service: 'worker'; readonly input: StructuredEventInputFor<'worker'>; readonly sink: 'stdout' | 'stderr'; readonly severity: string; readonly outcome: string }
  | { readonly service: 'plan6b-production-smoke'; readonly input: StructuredEventInputFor<'plan6b-production-smoke'>; readonly sink: 'stdout' | 'stderr'; readonly severity: string; readonly outcome: string };

const sinkFixtures: readonly SinkFixture[] = [
  { service: 'web', input: webCompleted, sink: 'stdout', severity: 'info', outcome: 'succeeded' },
  { service: 'web', input: webRejected, sink: 'stderr', severity: 'warn', outcome: 'denied' },
  { service: 'web', input: { event: 'http.request.failed', correlationId, method: 'GET', route: '/books', httpStatus: 500, code: code('http_server_error'), durationMs: 4 }, sink: 'stderr', severity: 'error', outcome: 'failed' },
  { service: 'worker', input: workerStarted, sink: 'stdout', severity: 'info', outcome: 'started' },
  { service: 'worker', input: { event: 'worker.ready', workerId: 'worker-1', configuredSlots: 2, durationMs: 1 }, sink: 'stdout', severity: 'info', outcome: 'succeeded' },
  { service: 'worker', input: { event: 'worker.stopping', workerId: 'worker-1', code: code('signal_sigint') }, sink: 'stdout', severity: 'info', outcome: 'started' },
  { service: 'worker', input: { event: 'worker.stopped', workerId: 'worker-1', durationMs: 1 }, sink: 'stdout', severity: 'info', outcome: 'succeeded' },
  { service: 'worker', input: { event: 'worker.failed', workerId: 'worker-1', code: code('configuration_invalid') }, sink: 'stderr', severity: 'error', outcome: 'failed' },
  { service: 'worker', input: { event: 'job.claimed', correlationId, jobId, jobKind: 'email', attempt: 1, maxAttempts: 3, workerId: 'worker-1', slotId: 0 }, sink: 'stdout', severity: 'debug', outcome: 'started' },
  { service: 'worker', input: { event: 'job.succeeded', correlationId, jobId, jobKind: 'email', attempt: 1, workerId: 'worker-1', slotId: 0, durationMs: 1 }, sink: 'stdout', severity: 'info', outcome: 'succeeded' },
  { service: 'worker', input: jobFailed, sink: 'stderr', severity: 'warn', outcome: 'failed' },
  { service: 'worker', input: { event: 'job.lease_lost', correlationId, jobId, jobKind: 'email', attempt: 1, workerId: 'worker-1', slotId: 0, code: code('lease_renewal_rejected') }, sink: 'stderr', severity: 'warn', outcome: 'failed' },
  { service: 'worker', input: { event: 'worker.heartbeat_failed', workerId: 'worker-1', code: code('heartbeat_publication_failed') }, sink: 'stderr', severity: 'error', outcome: 'failed' },
  { service: 'plan6b-production-smoke', input: smokeStarted, sink: 'stdout', severity: 'debug', outcome: 'started' },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.stage.succeeded', profile: 'maintenance_fixture', runId, candidateId: jobId, stage: 'preflight', durationMs: 1 }, sink: 'stdout', severity: 'info', outcome: 'succeeded' },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.stage.failed', profile: 'maintenance_fixture', runId, candidateId: jobId, stage: 'preflight', code: code('timeout'), durationMs: 1 }, sink: 'stderr', severity: 'error', outcome: 'failed' },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.cleanup.succeeded', profile: 'maintenance_fixture', runId, candidateId: jobId, durationMs: 1, containerCount: 0, networkCount: 0, volumeCount: 0, temporaryRootCount: 0 }, sink: 'stdout', severity: 'info', outcome: 'succeeded' },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.cleanup.failed', profile: 'maintenance_fixture', runId, candidateId: jobId, code: code('cleanup_failed'), durationMs: 1, containerCount: 0, networkCount: 0, volumeCount: 0, temporaryRootCount: 0 }, sink: 'stderr', severity: 'error', outcome: 'failed' },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.run.succeeded', profile: 'maintenance_fixture', runId, candidateId: jobId, durationMs: 1, evidenceFingerprint: 'a'.repeat(64) }, sink: 'stdout', severity: 'info', outcome: 'succeeded' },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.run.failed', profile: 'maintenance_fixture', runId, candidateId: jobId, stage: 'cleanup', code: code('cleanup_failed'), durationMs: 1 }, sink: 'stderr', severity: 'error', outcome: 'failed' }
];

function lines() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, sinks: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
}

describe('strict structured logger', () => {
  test('writes one compact NDJSON object with exactly one trailing newline in envelope-first field order', () => {
    const captured = lines();
    const logger = createStructuredLogger({ service: 'web', environment: 'development', now: clock, ...captured.sinks });

    logger.emit(webCompleted);

    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toEqual(['{"version":1,"timestamp":"2026-08-24T12:34:56.789Z","severity":"info","service":"web","event":"http.request.completed","outcome":"succeeded","correlationId":"request-1","method":"GET","route":"/books","httpStatus":200,"durationMs":12}\n']);
    expect(Object.keys(JSON.parse(captured.stdout[0]!))).toEqual(['version', 'timestamp', 'severity', 'service', 'event', 'outcome', 'correlationId', 'method', 'route', 'httpStatus', 'durationMs']);
  });

  test.each(sinkFixtures)('uses the fixed $sink sink for $input.event', (fixture) => {
    const captured = lines();
    const logger = createStructuredLogger({ service: fixture.service, environment: 'development', now: clock, ...captured.sinks });

    logger.emit(fixture.input);

    const selected = fixture.sink === 'stdout' ? captured.stdout : captured.stderr;
    expect(selected).toHaveLength(1);
    expect(fixture.sink === 'stdout' ? captured.stderr : captured.stdout).toEqual([]);
    expect(JSON.parse(selected[0]!)).toMatchObject({ event: fixture.input.event, severity: fixture.severity, outcome: fixture.outcome });
  });

  test('uses canonical RFC 3339 UTC time from the injected clock', () => {
    const captured = lines();
    const logger = createStructuredLogger({ service: 'worker', environment: 'development', now: () => new Date('2026-08-24T08:34:56.789-04:00'), ...captured.sinks });

    logger.emit(workerStarted);

    expect(JSON.parse(captured.stdout[0]!).timestamp).toBe(timestamp);
  });

  test('assigns both dynamic job.failed severities while retaining stderr', () => {
    const captured = lines();
    const logger = createStructuredLogger({ service: 'worker', environment: 'development', now: clock, ...captured.sinks });

    logger.emit(jobFailed);
    logger.emit({ ...jobFailed, retryScheduled: false });

    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.map((line) => JSON.parse(line).severity)).toEqual(['warn', 'error']);
  });

  test('keeps service-specific emit input types independent', () => {
    const web = createStructuredLogger({ service: 'web', environment: 'test', now: clock, ...lines().sinks });
    const smoke = createStructuredLogger({ service: 'plan6b-production-smoke', environment: 'test', now: clock, ...lines().sinks });
    expectTypeOf(web.emit).toEqualTypeOf<(input: StructuredEventInputFor<'web'>) => void>();
    expectTypeOf(smoke.emit).toEqualTypeOf<(input: StructuredEventInputFor<'plan6b-production-smoke'>) => void>();
    const compileOnly = () => {
      // @ts-expect-error smoke events cannot be emitted by web loggers
      web.emit(smokeStarted);
      // @ts-expect-error worker events cannot be emitted by smoke loggers
      smoke.emit(workerStarted);
    };
    expect(compileOnly).toBeTypeOf('function');
  });

  test('rejects incompatible event families at runtime', () => {
    const web = createStructuredLogger({ service: 'web', environment: 'development', now: clock, ...lines().sinks });
    const smoke = createStructuredLogger({ service: 'plan6b-production-smoke', environment: 'development', now: clock, ...lines().sinks });

    expect(() => Reflect.apply(web.emit, web, [smokeStarted])).toThrow('invalid structured event');
    expect(() => Reflect.apply(smoke.emit, smoke, [workerStarted])).toThrow('invalid structured event');
  });

  test.each(['development', 'test'] as const)('throws validation failures to the caller in %s', (environment) => {
    const logger = createStructuredLogger({ service: 'web', environment, now: clock, ...lines().sinks });

    expect(() => Reflect.apply(logger.emit, logger, [{ ...webCompleted, route: 'customer@example.test', secret: 'privacy-canary' }])).toThrow('invalid structured event');
  });

  test.each(['development', 'test'] as const)('throws clock failures to the caller in %s', (environment) => {
    const logger = createStructuredLogger({ service: 'web', environment, now: () => new Date('not-a-date'), ...lines().sinks });

    expect(() => logger.emit(webCompleted)).toThrow();
  });

  test.each(['development', 'test'] as const)('throws serialization failures to the caller in %s', (environment) => {
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw new Error('serialization privacy-canary'); });
    const logger = createStructuredLogger({ service: 'web', environment, now: clock, ...lines().sinks });

    expect(() => logger.emit(webCompleted)).toThrow('serialization privacy-canary');
    stringify.mockRestore();
  });

  test.each(['development', 'test'] as const)('throws selected sink failures to the caller in %s', (environment) => {
    const logger = createStructuredLogger({ service: 'web', environment, now: clock, stdout: () => { throw new Error('sink privacy-canary'); }, stderr: () => undefined });

    expect(() => logger.emit(webCompleted)).toThrow('sink privacy-canary');
  });

  test('makes one nonrecursive stderr logging.failure attempt for invalid production input', () => {
    const captured = lines();
    const logger = createStructuredLogger({ service: 'web', environment: 'production', now: clock, ...captured.sinks });

    Reflect.apply(logger.emit, logger, [{ ...webCompleted, secret: 'customer@example.test privacy-canary' }]);

    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(['{"version":1,"timestamp":"2026-08-24T12:34:56.789Z","severity":"error","service":"web","event":"logging.failure","outcome":"failed"}\n']);
  });

  test('snapshots factory configuration before a mutable options object changes', () => {
    const original = lines();
    const mutated = lines();
    const options: {
      service: StructuredLogService;
      environment: 'development' | 'test' | 'production';
      now: () => Date;
      stdout: (line: string) => void;
      stderr: (line: string) => void;
    } = { service: 'web', environment: 'production', now: clock, ...original.sinks };
    const logger = createStructuredLogger(options);
    options.service = 'worker';
    options.environment = 'development';
    options.now = () => new Date('not-a-date');
    options.stdout = mutated.sinks.stdout;
    options.stderr = mutated.sinks.stderr;

    Reflect.apply(logger.emit, logger, [webCompleted]);
    expect(() => Reflect.apply(logger.emit, logger, [{ ...webCompleted, secret: 'privacy-canary' }])).not.toThrow();

    expect(original.stdout).toEqual(['{"version":1,"timestamp":"2026-08-24T12:34:56.789Z","severity":"info","service":"web","event":"http.request.completed","outcome":"succeeded","correlationId":"request-1","method":"GET","route":"/books","httpStatus":200,"durationMs":12}\n']);
    expect(original.stderr).toEqual(['{"version":1,"timestamp":"2026-08-24T12:34:56.789Z","severity":"error","service":"web","event":"logging.failure","outcome":"failed"}\n']);
    expect(mutated.stdout).toEqual([]);
    expect(mutated.stderr).toEqual([]);
  });

  test('makes one nonrecursive stderr logging.failure attempt after a production primary-sink failure', () => {
    const calls: Array<{ readonly sink: 'stdout' | 'stderr'; readonly line: string }> = [];
    const logger = createStructuredLogger({
      service: 'web', environment: 'production', now: clock,
      stdout: (line) => { calls.push({ sink: 'stdout', line }); throw new Error('primary raw exception privacy-canary'); },
      stderr: (line) => calls.push({ sink: 'stderr', line })
    });

    expect(() => logger.emit(webCompleted)).not.toThrow();

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.sink)).toEqual(['stdout', 'stderr']);
    expect(JSON.parse(calls[1]!.line)).toEqual({ version: 1, timestamp, severity: 'error', service: 'web', event: 'logging.failure', outcome: 'failed' });
    expect(calls.map((call) => call.line).join('')).not.toContain('primary raw exception');
    expect(calls.map((call) => call.line).join('')).not.toContain('privacy-canary');
  });

  test('uses epoch fallback time for a production clock failure without leaking the cause', () => {
    const captured = lines();
    const logger = createStructuredLogger({ service: 'worker', environment: 'production', now: () => new Date('not-a-date'), ...captured.sinks });

    expect(() => logger.emit(workerStarted)).not.toThrow();

    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(['{"version":1,"timestamp":"1970-01-01T00:00:00.000Z","severity":"error","service":"worker","event":"logging.failure","outcome":"failed"}\n']);
  });

  test('swallows a production fallback-sink failure after its one attempt', () => {
    let fallbackCalls = 0;
    const logger = createStructuredLogger({ service: 'web', environment: 'production', now: clock, stdout: () => { throw new Error('primary'); }, stderr: () => { fallbackCalls += 1; throw new Error('fallback privacy-canary'); } });

    expect(() => logger.emit(webCompleted)).not.toThrow();
    expect(fallbackCalls).toBe(1);
  });
});
