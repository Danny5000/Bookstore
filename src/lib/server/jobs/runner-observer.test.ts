import { describe, expect, it, vi } from 'vitest';

import type { CorrelationId } from '../observability/contracts';
import { createStructuredLogger } from '../observability/logger';
import { defineSafeCode } from '../observability/safe-error';
import {
  createRunnerObserver,
  type JobAttemptIdentity,
  type JobLeaseLostLogCode,
  type RunnerObservation,
  type WorkerSlotProgressEvent
} from './runner-observer';

const correlationId = 'correlation.runner-test' as CorrelationId;
const identity: JobAttemptIdentity = {
  correlationId,
  jobId: 'f1f46ee7-3170-40ea-bfad-d55a734bf37d',
  jobKind: 'test.handle',
  attempt: 2,
  maxAttempts: 5,
  workerId: 'worker-base',
  slotId: 0,
  generation: 7
};

function capturedLogger(environment: 'test' | 'production' = 'test') {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logger = createStructuredLogger({
    service: 'worker',
    environment,
    now: () => new Date('2026-08-26T12:34:56.789Z'),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  });
  return { logger, stdout, stderr };
}

function parseOnly(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe('createRunnerObserver', () => {
  it.each<{
    observation: WorkerSlotProgressEvent;
    expected: WorkerSlotProgressEvent;
  }>([
    {
      observation: { type: 'polling', slotId: 0 },
      expected: { type: 'polling', slotId: 0 }
    },
    {
      observation: { type: 'poll_succeeded', slotId: 1, claimed: false },
      expected: { type: 'poll_succeeded', slotId: 1, claimed: false }
    },
    {
      observation: { type: 'lease_renewed', slotId: 2 },
      expected: { type: 'lease_renewed', slotId: 2 }
    },
    {
      observation: { type: 'terminal_settled', slotId: 3 },
      expected: { type: 'terminal_settled', slotId: 3 }
    },
    {
      observation: { type: 'lease_lost', slotId: 4 },
      expected: { type: 'lease_lost', slotId: 4 }
    }
  ])('forwards only the exact $observation.type slot event', ({ observation, expected }) => {
    const captured = capturedLogger();
    const reportSlotProgress = vi.fn();
    const observe = createRunnerObserver({ logger: captured.logger, reportSlotProgress });
    const poisoned = {
      ...observation,
      payload: 'payload-privacy-canary',
      error: new Error('exception-privacy-canary')
    } as unknown as RunnerObservation;

    observe(poisoned);

    expect(reportSlotProgress).toHaveBeenCalledExactlyOnceWith(expected);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([]);
    expect(JSON.stringify(reportSlotProgress.mock.calls)).not.toContain('privacy-canary');
  });

  it('emits an exact claimed record through the real worker logger', () => {
    const captured = capturedLogger();
    const reportSlotProgress = vi.fn();
    const observe = createRunnerObserver({ logger: captured.logger, reportSlotProgress });

    observe({ type: 'job_claimed', identity });

    expect(parseOnly(captured.stdout)).toEqual({
      version: 1,
      timestamp: '2026-08-26T12:34:56.789Z',
      severity: 'debug',
      service: 'worker',
      event: 'job.claimed',
      outcome: 'started',
      correlationId,
      jobId: identity.jobId,
      jobKind: identity.jobKind,
      attempt: 2,
      maxAttempts: 5,
      workerId: 'worker-base',
      slotId: 0,
      generation: 7
    });
    expect(captured.stderr).toEqual([]);
    expect(reportSlotProgress).not.toHaveBeenCalled();
  });

  it('emits an exact succeeded record without maxAttempts', () => {
    const captured = capturedLogger();
    const observe = createRunnerObserver({
      logger: captured.logger,
      reportSlotProgress: vi.fn()
    });

    observe({ type: 'job_succeeded', identity, durationMs: 42 });

    expect(parseOnly(captured.stdout)).toEqual({
      version: 1,
      timestamp: '2026-08-26T12:34:56.789Z',
      severity: 'info',
      service: 'worker',
      event: 'job.succeeded',
      outcome: 'succeeded',
      correlationId,
      jobId: identity.jobId,
      jobKind: identity.jobKind,
      attempt: 2,
      workerId: 'worker-base',
      slotId: 0,
      durationMs: 42,
      generation: 7
    });
    expect(captured.stderr).toEqual([]);
  });

  it.each([
    {
      code: 'unexpected_failure',
      retryScheduled: true,
      severity: 'warn'
    },
    {
      code: 'permanent_job_failure',
      retryScheduled: false,
      severity: 'error'
    },
    {
      code: 'job_completion_failed',
      retryScheduled: false,
      severity: 'error'
    }
  ] as const)('emits an exact $code failed record with $severity severity', ({
    code: codeValue,
    retryScheduled,
    severity
  }) => {
    const captured = capturedLogger();
    const observe = createRunnerObserver({
      logger: captured.logger,
      reportSlotProgress: vi.fn()
    });
    const code = defineSafeCode(codeValue);

    observe({
      type: 'job_failed',
      identity,
      code,
      durationMs: 51,
      retryScheduled
    });

    expect(parseOnly(captured.stderr)).toEqual({
      version: 1,
      timestamp: '2026-08-26T12:34:56.789Z',
      severity,
      service: 'worker',
      event: 'job.failed',
      outcome: 'failed',
      correlationId,
      jobId: identity.jobId,
      jobKind: identity.jobKind,
      attempt: 2,
      maxAttempts: 5,
      workerId: 'worker-base',
      slotId: 0,
      code: codeValue,
      durationMs: 51,
      retryScheduled,
      generation: 7
    });
    expect(captured.stdout).toEqual([]);
  });

  it.each([
    'lease_capability_invalid',
    'lease_renewal_rejected',
    'lease_renewal_failed',
    'completion_rejected',
    'failure_transition_rejected',
    'failure_transition_failed'
  ] as const)('emits the exact lease-lost record for %s', (value) => {
    const captured = capturedLogger();
    const observe = createRunnerObserver({
      logger: captured.logger,
      reportSlotProgress: vi.fn()
    });
    const code = defineSafeCode(value) as JobLeaseLostLogCode;

    observe({ type: 'job_lease_lost', identity, code });

    expect(parseOnly(captured.stderr)).toEqual({
      version: 1,
      timestamp: '2026-08-26T12:34:56.789Z',
      severity: 'warn',
      service: 'worker',
      event: 'job.lease_lost',
      outcome: 'failed',
      correlationId,
      jobId: identity.jobId,
      jobKind: identity.jobKind,
      attempt: 2,
      workerId: 'worker-base',
      slotId: 0,
      code: value,
      generation: 7
    });
    expect(captured.stdout).toEqual([]);
  });

  it('keeps optional generation absent across every job event when identity omits it', () => {
    const captured = capturedLogger();
    const observe = createRunnerObserver({
      logger: captured.logger,
      reportSlotProgress: vi.fn()
    });
    const withoutGeneration: JobAttemptIdentity = {
      correlationId,
      jobId: identity.jobId,
      jobKind: identity.jobKind,
      attempt: identity.attempt,
      maxAttempts: identity.maxAttempts,
      workerId: identity.workerId,
      slotId: identity.slotId
    };

    observe({ type: 'job_claimed', identity: withoutGeneration });
    observe({ type: 'job_succeeded', identity: withoutGeneration, durationMs: 1 });
    observe({
      type: 'job_failed',
      identity: withoutGeneration,
      code: defineSafeCode('unexpected_failure'),
      durationMs: 2,
      retryScheduled: true
    });
    observe({
      type: 'job_lease_lost',
      identity: withoutGeneration,
      code: defineSafeCode('completion_rejected')
    });

    const encoded = [...captured.stdout, ...captured.stderr].map((line) => JSON.parse(line));
    expect(encoded).toHaveLength(4);
    expect(encoded.every((event) => !Object.hasOwn(event, 'generation'))).toBe(true);
  });

  it('reconstructs job events without privacy canaries or undeclared identity fields', () => {
    const captured = capturedLogger();
    const observe = createRunnerObserver({
      logger: captured.logger,
      reportSlotProgress: vi.fn()
    });
    const poisonedIdentity = {
      ...identity,
      maxAttempts: 5,
      payload: { email: 'person@example.test', storageKey: 'private/storage-key' },
      deduplicationKey: 'deduplication-privacy-canary',
      financialAdminLeaseCapability: 'capability-privacy-canary',
      providerBody: 'provider-body-privacy-canary',
      error: new Error('exception-message-privacy-canary'),
      stack: 'stack-privacy-canary'
    } as unknown as JobAttemptIdentity;

    observe({
      type: 'job_failed',
      identity: poisonedIdentity,
      code: defineSafeCode('unexpected_failure'),
      durationMs: 3,
      retryScheduled: true,
      job: { payload: 'job-privacy-canary' },
      cause: new Error('cause-privacy-canary')
    } as unknown as RunnerObservation);

    const encoded = captured.stderr[0]!;
    for (const canary of [
      'person@example.test',
      'private/storage-key',
      'deduplication-privacy-canary',
      'capability-privacy-canary',
      'provider-body-privacy-canary',
      'exception-message-privacy-canary',
      'stack-privacy-canary',
      'job-privacy-canary',
      'cause-privacy-canary'
    ]) {
      expect(encoded).not.toContain(canary);
    }
    expect(Object.keys(parseOnly(captured.stderr))).toEqual([
      'version',
      'timestamp',
      'severity',
      'service',
      'event',
      'outcome',
      'correlationId',
      'jobId',
      'jobKind',
      'attempt',
      'maxAttempts',
      'workerId',
      'slotId',
      'code',
      'durationMs',
      'retryScheduled',
      'generation'
    ]);
  });

  it('lets the strict test logger reject invalid observations before serialization', () => {
    const captured = capturedLogger();
    const observe = createRunnerObserver({
      logger: captured.logger,
      reportSlotProgress: vi.fn()
    });
    const invalid = {
      ...identity,
      jobId: 'not-a-job-uuid',
      payload: 'invalid-observation-privacy-canary'
    } as unknown as JobAttemptIdentity;

    expect(() => observe({ type: 'job_claimed', identity: invalid })).toThrow(
      'invalid structured event'
    );
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([]);
  });

  it('does not let a production sink failure alter the observer outcome', () => {
    const fallback: string[] = [];
    const logger = createStructuredLogger({
      service: 'worker',
      environment: 'production',
      now: () => new Date('2026-08-26T12:34:56.789Z'),
      stdout: () => { throw new Error('sink-privacy-canary'); },
      stderr: (line) => fallback.push(line)
    });
    const observe = createRunnerObserver({ logger, reportSlotProgress: vi.fn() });

    expect(() => observe({ type: 'job_claimed', identity })).not.toThrow();
    expect(parseOnly(fallback)).toMatchObject({
      service: 'worker',
      event: 'logging.failure',
      severity: 'error',
      outcome: 'failed'
    });
    expect(fallback[0]).not.toContain('sink-privacy-canary');
  });
});
