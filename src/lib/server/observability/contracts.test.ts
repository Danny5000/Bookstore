import { describe, expect, test } from 'vitest';

import {
  type StructuredEventInputFor,
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
});
