import { describe, expect, expectTypeOf, test, vi } from 'vitest';

import type { StructuredEventInputFor } from './contracts';
import { createStructuredLogger } from './logger';

const timestamp = '2026-08-24T12:34:56.789Z';
const clock = () => new Date(timestamp);
const webCompleted = { event: 'http.request.completed', correlationId: 'request-1', method: 'GET', route: '/books', httpStatus: 200, durationMs: 12 } as const;
const webRejected = { event: 'http.request.rejected', correlationId: 'request-1', method: 'GET', route: '/books', httpStatus: 400, code: 'invalid_request' as never, durationMs: 3 } as const;
const workerStarted = { event: 'worker.started', workerId: 'worker-1', configuredSlots: 2 } as const;
const jobFailed = { event: 'job.failed', correlationId: 'request-1', jobId: '01234567-89ab-cdef-0123-456789abcdef', jobKind: 'email', attempt: 1, maxAttempts: 3, workerId: 'worker-1', slotId: 0, code: 'permanent_job_failure' as never, durationMs: 9, retryScheduled: true } as const;
const smokeStarted = { event: 'smoke.stage.started', profile: 'maintenance_fixture', runId: '0123456789abcdef', candidateId: '01234567-89ab-cdef-0123-456789abcdef', stage: 'preflight' } as const;

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

  test.each([
    ['stdout', webCompleted, 'web'],
    ['stderr', webRejected, 'web'],
    ['stdout', workerStarted, 'worker'],
    ['stderr', jobFailed, 'worker'],
    ['stdout', smokeStarted, 'plan6b-production-smoke']
  ] as const)('uses the contract-selected %s sink for %s', (sink, input, service) => {
    const captured = lines();
    const logger = createStructuredLogger({ service, environment: 'development', now: clock, ...captured.sinks });

    logger.emit(input as never);

    expect(sink === 'stdout' ? captured.stdout : captured.stderr).toHaveLength(1);
    expect(sink === 'stdout' ? captured.stderr : captured.stdout).toEqual([]);
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

    expect(() => web.emit(smokeStarted as never)).toThrow('invalid structured event');
    expect(() => smoke.emit(workerStarted as never)).toThrow('invalid structured event');
  });

  test.each(['development', 'test'] as const)('throws validation failures to the caller in %s', (environment) => {
    const logger = createStructuredLogger({ service: 'web', environment, now: clock, ...lines().sinks });

    expect(() => logger.emit({ ...webCompleted, route: 'customer@example.test', secret: 'privacy-canary' } as never)).toThrow('invalid structured event');
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

    logger.emit({ ...webCompleted, secret: 'customer@example.test privacy-canary' } as never);

    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(['{"version":1,"timestamp":"2026-08-24T12:34:56.789Z","severity":"error","service":"web","event":"logging.failure","outcome":"failed"}\n']);
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
