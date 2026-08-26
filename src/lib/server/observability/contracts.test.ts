import { describe, expect, test } from 'vitest';

import {
  isPositiveSignedInt32,
  type StructuredEventInputFor,
  validateLoggingFailure,
  validateStructuredEvent
} from './contracts';

const timestamp = '2026-08-24T12:34:56.789Z';
const correlationId = 'request-1';
const workerId = 'worker:1';
const jobId = '01234567-89ab-cdef-0123-456789abcdef';
const candidateId = 'fedcba98-7654-3210-fedc-ba9876543210';
const fingerprint = 'a'.repeat(64);

type Case = {
  readonly service: 'web' | 'worker' | 'plan6b-production-smoke';
  readonly input: Record<string, unknown>;
  readonly severity: 'debug' | 'info' | 'warn' | 'error';
  readonly outcome: 'started' | 'succeeded' | 'failed' | 'denied' | 'noop';
  readonly sink: 'stdout' | 'stderr';
  readonly keys: readonly string[];
};

const cases: readonly Case[] = [
  { service: 'web', input: { event: 'http.request.completed', correlationId, method: 'GET', route: '/books/[id]', httpStatus: 200, durationMs: 0 }, severity: 'info', outcome: 'succeeded', sink: 'stdout', keys: ['correlationId', 'method', 'route', 'httpStatus', 'durationMs'] },
  { service: 'web', input: { event: 'http.request.rejected', correlationId, method: 'POST', route: '/login', httpStatus: 401, code: 'unauthenticated', durationMs: 1 }, severity: 'warn', outcome: 'denied', sink: 'stderr', keys: ['correlationId', 'method', 'route', 'httpStatus', 'code', 'durationMs'] },
  { service: 'web', input: { event: 'http.request.failed', correlationId, method: 'POST', route: '/checkout', httpStatus: 500, code: 'http_server_error', durationMs: 2 }, severity: 'error', outcome: 'failed', sink: 'stderr', keys: ['correlationId', 'method', 'route', 'httpStatus', 'code', 'durationMs'] },
  { service: 'worker', input: { event: 'worker.started', workerId, configuredSlots: 1 }, severity: 'info', outcome: 'started', sink: 'stdout', keys: ['workerId', 'configuredSlots'] },
  { service: 'worker', input: { event: 'worker.ready', workerId, configuredSlots: 1, durationMs: 3 }, severity: 'info', outcome: 'succeeded', sink: 'stdout', keys: ['workerId', 'configuredSlots', 'durationMs'] },
  { service: 'worker', input: { event: 'worker.stopping', workerId, code: 'signal_sigterm' }, severity: 'info', outcome: 'started', sink: 'stdout', keys: ['workerId', 'code'] },
  { service: 'worker', input: { event: 'worker.stopped', workerId, durationMs: 4 }, severity: 'info', outcome: 'succeeded', sink: 'stdout', keys: ['workerId', 'durationMs'] },
  { service: 'worker', input: { event: 'worker.failed', code: 'runner_failed', workerId }, severity: 'error', outcome: 'failed', sink: 'stderr', keys: ['code', 'workerId'] },
  { service: 'worker', input: { event: 'job.claimed', correlationId, jobId, jobKind: 'outbox.dispatch', attempt: 1, maxAttempts: 2, workerId, slotId: 0, generation: 1 }, severity: 'debug', outcome: 'started', sink: 'stdout', keys: ['correlationId', 'jobId', 'jobKind', 'attempt', 'maxAttempts', 'workerId', 'slotId', 'generation'] },
  { service: 'worker', input: { event: 'job.succeeded', correlationId, jobId, jobKind: 'outbox.dispatch', attempt: 1, workerId, slotId: 0, durationMs: 5 }, severity: 'info', outcome: 'succeeded', sink: 'stdout', keys: ['correlationId', 'jobId', 'jobKind', 'attempt', 'workerId', 'slotId', 'durationMs'] },
  { service: 'worker', input: { event: 'job.failed', correlationId, jobId, jobKind: 'outbox.dispatch', attempt: 1, maxAttempts: 2, workerId, slotId: 0, code: 'permanent_job_failure', durationMs: 6, retryScheduled: true }, severity: 'warn', outcome: 'failed', sink: 'stderr', keys: ['correlationId', 'jobId', 'jobKind', 'attempt', 'maxAttempts', 'workerId', 'slotId', 'code', 'durationMs', 'retryScheduled'] },
  { service: 'worker', input: { event: 'job.lease_lost', correlationId, jobId, jobKind: 'outbox.dispatch', attempt: 1, workerId, slotId: 0, code: 'lease_renewal_failed' }, severity: 'warn', outcome: 'failed', sink: 'stderr', keys: ['correlationId', 'jobId', 'jobKind', 'attempt', 'workerId', 'slotId', 'code'] },
  { service: 'worker', input: { event: 'worker.heartbeat_failed', workerId, code: 'heartbeat_publication_failed' }, severity: 'error', outcome: 'failed', sink: 'stderr', keys: ['workerId', 'code'] },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.stage.started', profile: 'maintenance_fixture', runId: '0123456789abcdef', candidateId, stage: 'preflight' }, severity: 'debug', outcome: 'started', sink: 'stdout', keys: ['profile', 'runId', 'candidateId', 'stage'] },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.stage.succeeded', profile: 'maintenance_fixture', runId: '0123456789abcdef', candidateId, stage: 'preflight', durationMs: 7 }, severity: 'info', outcome: 'succeeded', sink: 'stdout', keys: ['profile', 'runId', 'candidateId', 'stage', 'durationMs'] },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.stage.failed', profile: 'maintenance_fixture', runId: '0123456789abcdef', candidateId, stage: 'preflight', code: 'timeout', durationMs: 8 }, severity: 'error', outcome: 'failed', sink: 'stderr', keys: ['profile', 'runId', 'candidateId', 'stage', 'code', 'durationMs'] },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.cleanup.succeeded', profile: 'maintenance_fixture', runId: '0123456789abcdef', candidateId, durationMs: 9, containerCount: 0, networkCount: 0, volumeCount: 0, temporaryRootCount: 0 }, severity: 'info', outcome: 'succeeded', sink: 'stdout', keys: ['profile', 'runId', 'candidateId', 'durationMs', 'containerCount', 'networkCount', 'volumeCount', 'temporaryRootCount'] },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.cleanup.failed', profile: 'maintenance_fixture', runId: '0123456789abcdef', candidateId, code: 'cleanup_failed', durationMs: 10, containerCount: 0, networkCount: 0, volumeCount: 0, temporaryRootCount: 0 }, severity: 'error', outcome: 'failed', sink: 'stderr', keys: ['profile', 'runId', 'candidateId', 'code', 'durationMs', 'containerCount', 'networkCount', 'volumeCount', 'temporaryRootCount'] },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.run.succeeded', profile: 'maintenance_fixture', runId: '0123456789abcdef', candidateId, durationMs: 11, evidenceFingerprint: fingerprint }, severity: 'info', outcome: 'succeeded', sink: 'stdout', keys: ['profile', 'runId', 'candidateId', 'durationMs', 'evidenceFingerprint'] },
  { service: 'plan6b-production-smoke', input: { event: 'smoke.run.failed', profile: 'maintenance_fixture', runId: '0123456789abcdef', candidateId, stage: 'cleanup', code: 'cleanup_failed', durationMs: 12 }, severity: 'error', outcome: 'failed', sink: 'stderr', keys: ['profile', 'runId', 'candidateId', 'stage', 'code', 'durationMs'] }
];
const webCompleted = cases[0]!;

function validate(case_: Case, input = case_.input, valueTimestamp = timestamp) {
  return validateStructuredEvent(case_.service, valueTimestamp, input as StructuredEventInputFor<typeof case_.service>);
}

describe('structured event contracts', () => {
  test.each(cases)('$input.event uses its exact service envelope and record order', (case_) => {
    const result = validate(case_);
    expect(result.sink).toBe(case_.sink);
    expect(result.record).toEqual({ version: 1, timestamp, severity: case_.severity, service: case_.service, event: case_.input.event, outcome: case_.outcome, ...Object.fromEntries(case_.keys.map((key) => [key, case_.input[key]])) });
    expect(Object.keys(result.record)).toEqual(['version', 'timestamp', 'severity', 'service', 'event', 'outcome', ...case_.keys]);
  });

  test('job.failed is error when no retry is scheduled', () => {
    const case_ = cases.find((value) => value.input.event === 'job.failed')!;
    expect(validate(case_, { ...case_.input, retryScheduled: false }).record.severity).toBe('error');
  });

  test.each([
    ['httpStatus', 599], ['slotId', 2_147_483_647], ['attempt', 2_147_483_647], ['maxAttempts', 2_147_483_647],
    ['configuredSlots', 2_147_483_647], ['generation', 2_147_483_647], ['durationMs', 86_400_000],
    ['route', 'x'.repeat(200)], ['method', 'A'.repeat(16)], ['workerId', `a${'x'.repeat(199)}`]
  ])('accepts the valid upper edge for %s', (key, value) => {
    const case_ = cases.find((entry) => Object.hasOwn(entry.input, key))!;
    expect(() => validate(case_, { ...case_.input, [key]: value })).not.toThrow();
  });

  test.each(cases)('$input.event rejects each missing or undeclared key', (case_) => {
    for (const key of Object.keys(case_.input).filter((key) => !(case_.input.event === 'worker.failed' && key === 'workerId') && key !== 'generation')) {
      const missing = Object.fromEntries(Object.entries(case_.input).filter(([present]) => present !== key));
      expect(() => validate(case_, missing)).toThrow();
    }
    for (const key of ['payload', 'deduplicationKey', 'financialAdminLeaseCapability', 'url', 'headers', 'cookie', 'stack', 'message', 'secret']) {
      expect(() => validate(case_, { ...case_.input, [key]: 'customer@example.test' })).toThrow();
    }
  });

  test.each([
    ['event', 'A'], ['event', 'a'.repeat(101)], ['correlationId', '-bad'], ['correlationId', 'a'.repeat(101)],
    ['workerId', '-bad'], ['workerId', 'a'.repeat(201)], ['method', 'get'], ['method', 'A'.repeat(17)],
    ['route', ''], ['route', 'x'.repeat(201)], ['httpStatus', 99], ['httpStatus', 600], ['slotId', -1],
    ['attempt', 0], ['maxAttempts', 0], ['configuredSlots', 0], ['generation', 0], ['durationMs', -1], ['durationMs', 86400001],
    ['runId', 'A123456789abcdef'], ['candidateId', candidateId.toUpperCase()], ['jobId', jobId.toUpperCase()],
    ['evidenceFingerprint', fingerprint.toUpperCase()]
  ])('rejects invalid primitive neighbor %s', (key, value) => {
    const case_ = cases.find((entry) => Object.hasOwn(entry.input, key))!;
    expect(() => validate(case_, { ...case_.input, [key]: value })).toThrow();
  });

  test.each([null, [], {}, new String('safe'), Number.NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1])('rejects untrusted primitive shape %p', (value) => {
    const case_ = webCompleted;
    expect(() => validate(case_, { ...case_.input, durationMs: value })).toThrow();
  });

  test('rejects accessors and hostile reflection proxies', () => {
    const case_ = webCompleted;
    const accessor = Object.defineProperty({ ...case_.input }, 'durationMs', { enumerable: true, get: () => 1 });
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error('trap'); } });
    expect(() => validate(case_, accessor)).toThrow();
    expect(() => validate(case_, proxy)).toThrow();
  });

  test.each([
    ['http.request.rejected', 'unexpected_failure'], ['http.request.failed', 'invalid_request'], ['worker.stopping', 'runner_failed'],
    ['worker.failed', 'token_that_is_valid'], ['worker.heartbeat_failed', 'runner_failed'], ['job.failed', 'lease_renewal_failed'],
    ['job.lease_lost', 'unexpected_failure'], ['smoke.stage.failed', 'token_that_is_valid'], ['smoke.cleanup.failed', 'token_that_is_valid'], ['smoke.run.failed', 'token_that_is_valid']
  ])('rejects a grammar-valid but unregistered code for %s', (event, code) => {
    const case_ = cases.find((entry) => entry.input.event === event)!;
    expect(() => validate(case_, { ...case_.input, code })).toThrow();
  });

  test('requires canonical finite ISO timestamps and reserves logging.failure', () => {
    expect(() => validate(webCompleted, webCompleted.input, '2026-08-24T12:34:56Z')).toThrow();
    expect(() => validate(webCompleted, webCompleted.input, 'not-a-date')).toThrow();
    expect(() => validate(webCompleted, { event: 'logging.failure' })).toThrow();
  });

  test('excludes logger-internal events from caller inputs at compile time', () => {
    const cannotConstruct = () => {
      // @ts-expect-error logging.failure has no caller-visible input variant
      validateStructuredEvent('worker', timestamp, { event: 'logging.failure' });
    };
    expect(cannotConstruct).toBeTypeOf('function');
  });

  test.each([
    ['web', cases.find((entry) => entry.input.event === 'http.request.completed')!],
    ['worker', cases.find((entry) => entry.input.event === 'worker.started')!],
    ['plan6b-production-smoke', cases.find((entry) => entry.input.event === 'smoke.stage.started')!],
    ['plan6b-fixture-runtime-probe', cases.find((entry) => entry.input.event === 'smoke.stage.started')!],
    ['plan7a-release-candidate', cases.find((entry) => entry.input.event === 'smoke.stage.started')!]
  ] as const)('accepts only compatible registered service %s', (service, case_) => {
    const input = service === 'plan7a-release-candidate' ? { ...case_.input, profile: 'release_candidate' } : case_.input;
    expect(() => validateStructuredEvent(service, timestamp, input as never)).not.toThrow();
  });

  test.each(['nope', '', new String('web'), null, {}, []])('rejects an unregistered runtime service %#', (service) => {
    expect(() => validateStructuredEvent(service as never, timestamp, webCompleted.input as never)).toThrow();
  });

  test('requires the exact smoke service/profile pair', () => {
    const smoke = cases.find((entry) => entry.input.event === 'smoke.stage.started')!;
    expect(() => validateStructuredEvent('plan6b-production-smoke', timestamp, { ...smoke.input, profile: 'release_candidate' } as never)).toThrow();
    expect(() => validateStructuredEvent('plan6b-fixture-runtime-probe', timestamp, { ...smoke.input, profile: 'release_candidate' } as never)).toThrow();
    expect(() => validateStructuredEvent('plan7a-release-candidate', timestamp, smoke.input as never)).toThrow();
    expect(() => validateStructuredEvent('web', timestamp, smoke.input as never)).toThrow();
    expect(() => validateStructuredEvent('worker', timestamp, smoke.input as never)).toThrow();
  });

  test.each(['web', 'worker', 'plan6b-production-smoke', 'plan6b-fixture-runtime-probe', 'plan7a-release-candidate'] as const)('constructs exact internal logging.failure for %s', (service) => {
    const result = validateLoggingFailure(service, timestamp);
    expect(result).toEqual({ record: { version: 1, timestamp, severity: 'error', service, event: 'logging.failure', outcome: 'failed' }, sink: 'stderr' });
    expect(Object.keys(result.record)).toEqual(['version', 'timestamp', 'severity', 'service', 'event', 'outcome']);
  });

  test('rejects invalid fallback service and timestamp', () => {
    expect(() => validateLoggingFailure('nope' as never, timestamp)).toThrow();
    expect(() => validateLoggingFailure('web', '2026-08-24T12:34:56Z')).toThrow();
    expect(() => (validateLoggingFailure as (...arguments_: unknown[]) => unknown)('web', timestamp, { event: 'logging.failure' })).toThrow();
  });

  test('rejects symbol-keyed event extras', () => {
    const symbol = Symbol('payload');
    expect(() => validate(webCompleted, { ...webCompleted.input, [symbol]: 'customer@example.test' })).toThrow();
  });

  test.each([
    ['jobKind', 'a'], ['jobKind', 'a'.repeat(100)], ['profile', 'maintenance_fixture'], ['stage', 'cleanup'],
    ['runId', '0'.repeat(16)], ['evidenceFingerprint', 'a'.repeat(64)], ['correlationId', `a${'x'.repeat(99)}`], ['workerId', `a${'x'.repeat(199)}`]
  ])('accepts named grammar edge %s', (key, value) => {
    const case_ = cases.find((entry) => Object.hasOwn(entry.input, key))!;
    expect(() => validate(case_, { ...case_.input, [key]: value })).not.toThrow();
  });

  test.each([
    ['jobKind', '1bad'], ['profile', 'not_a_profile'], ['stage', 'not_a_registered_stage'], ['runId', 'a'.repeat(15)],
    ['runId', 'A'.repeat(16)], ['evidenceFingerprint', 'a'.repeat(63)], ['candidateId', 'a'.repeat(36)],
    ['correlationId', 'a'.repeat(101)], ['correlationId', ':bad'], ['workerId', ':bad'], ['workerId', 'a'.repeat(201)],
    ['slotId', 2_147_483_648], ['containerCount', 2_147_483_648], ['attempt', 2_147_483_648],
    ['maxAttempts', Number.NaN], ['configuredSlots', Infinity], ['generation', Number.MAX_SAFE_INTEGER + 1]
  ])('rejects named grammar or numeric neighbor %s', (key, value) => {
    const case_ = cases.find((entry) => Object.hasOwn(entry.input, key))!;
    expect(() => validate(case_, { ...case_.input, [key]: value })).toThrow();
  });

  test.each([1, 2_147_483_647])('shares positive signed-int32 rules with heartbeat sequence %s', (sequence) => {
    expect(isPositiveSignedInt32(sequence)).toBe(true);
  });

  test.each([0, -1, 2_147_483_648, 1.1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid heartbeat sequence %s', (sequence) => {
    expect(isPositiveSignedInt32(sequence)).toBe(false);
  });

  test.each(['slotId', 'containerCount', 'networkCount', 'volumeCount', 'temporaryRootCount'])('accepts nonnegative signed-int32 bounds for %s', (key) => {
    const case_ = cases.find((entry) => Object.hasOwn(entry.input, key))!;
    for (const value of [0, 2_147_483_647]) expect(() => validate(case_, { ...case_.input, [key]: value })).not.toThrow();
  });

  test.each(['slotId', 'containerCount', 'networkCount', 'volumeCount', 'temporaryRootCount'])('rejects invalid nonnegative signed-int32 values for %s', (key) => {
    const case_ = cases.find((entry) => Object.hasOwn(entry.input, key))!;
    for (const value of [-1, 2_147_483_648, 1.1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => validate(case_, { ...case_.input, [key]: value })).toThrow();
  });

  test.each(['attempt', 'maxAttempts', 'configuredSlots', 'generation'])('accepts positive signed-int32 bounds for %s', (key) => {
    const case_ = cases.find((entry) => Object.hasOwn(entry.input, key))!;
    for (const value of [1, 2_147_483_647]) expect(() => validate(case_, { ...case_.input, [key]: value })).not.toThrow();
  });

  test.each(['attempt', 'maxAttempts', 'configuredSlots', 'generation'])('rejects invalid positive signed-int32 values for %s', (key) => {
    const case_ = cases.find((entry) => Object.hasOwn(entry.input, key))!;
    for (const value of [0, 2_147_483_648, 1.1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => validate(case_, { ...case_.input, [key]: value })).toThrow();
  });

  test('accepts optional generation and worker.failed workerId omission and presence, but not undefined', () => {
    const claimed = cases.find((entry) => entry.input.event === 'job.claimed')!;
    const failed = cases.find((entry) => entry.input.event === 'worker.failed')!;
    const withoutGeneration = Object.fromEntries(Object.entries(claimed.input).filter(([key]) => key !== 'generation'));
    const withoutWorker = Object.fromEntries(Object.entries(failed.input).filter(([key]) => key !== 'workerId'));
    expect(() => validate(claimed, withoutGeneration)).not.toThrow();
    expect(() => validate(failed, withoutWorker)).not.toThrow();
    expect(() => validate(claimed, { ...claimed.input, generation: undefined })).toThrow();
    expect(() => validate(failed, { ...failed.input, workerId: undefined })).toThrow();
  });

  test('accepts literal lower edges for HTTP and diagnostic identifiers', () => {
    expect(() => validate(webCompleted, { ...webCompleted.input, correlationId: 'a', method: 'A', route: 'x', httpStatus: 100 })).not.toThrow();
    const started = cases.find((entry) => entry.input.event === 'worker.started')!;
    expect(() => validate(started, { ...started.input, workerId: 'a' })).not.toThrow();
  });

  test.each([
    ['runId', 'a'.repeat(17)], ['evidenceFingerprint', 'a'.repeat(65)], ['candidateId', 'a'.repeat(35)],
    ['candidateId', 'a'.repeat(37)], ['jobId', 'a'.repeat(35)], ['jobId', 'a'.repeat(37)]
  ])('rejects documented identifier length neighbor %s', (key, value) => {
    const case_ = cases.find((entry) => Object.hasOwn(entry.input, key))!;
    expect(() => validate(case_, { ...case_.input, [key]: value })).toThrow();
  });

  test('rejects an inherited registry entry for an own unregistered event', () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'evil.event');
    Object.defineProperty(Object.prototype, 'evil.event', {
      configurable: true,
      value: { services: ['web'], fields: [], severity: 'info', outcome: 'succeeded', sink: 'stdout' }
    });
    try {
      expect(() => validateStructuredEvent('web', timestamp, { event: 'evil.event' } as never)).toThrow();
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'evil.event', previous);
      else delete (Object.prototype as Record<string, unknown>)['evil.event'];
    }
  });

  test('does not emit inherited optional worker fields', () => {
    const inherited = [['workerId', 'inherited-worker'], ['generation', 42]] as const;
    const previous = inherited.map(([key]) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const);
    for (const [key, value] of inherited) Object.defineProperty(Object.prototype, key, { configurable: true, writable: true, value });
    try {
      const failed = cases.find((entry) => entry.input.event === 'worker.failed')!;
      const claimed = cases.find((entry) => entry.input.event === 'job.claimed')!;
      const withoutWorker = Object.fromEntries(Object.entries(failed.input).filter(([key]) => key !== 'workerId'));
      const withoutGeneration = Object.fromEntries(Object.entries(claimed.input).filter(([key]) => key !== 'generation'));
      expect(validate(failed, withoutWorker).record).not.toHaveProperty('workerId');
      expect(validate(claimed, withoutGeneration).record).not.toHaveProperty('generation');
      expect(validate(failed, { ...withoutWorker, workerId }).record.workerId).toBe(workerId);
      expect(validate(claimed, { ...withoutGeneration, generation: 1 }).record.generation).toBe(1);
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
        else delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  });

  test('constructs records without invoking inherited setters', () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'durationMs');
    let assigned: unknown;
    Object.defineProperty(Object.prototype, 'durationMs', { configurable: true, set: (value) => { assigned = value; } });
    try {
      const result = validate(webCompleted);
      expect(assigned).toBeUndefined();
      expect(Object.hasOwn(result.record, 'durationMs')).toBe(true);
      expect(result.record.durationMs).toBe(0);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'durationMs', previous);
      else delete (Object.prototype as Record<string, unknown>).durationMs;
    }
  });
});
