export type CorrelationId = string & { readonly __correlationId: unique symbol };
export type SafeCode<T extends string = string> = T & { readonly __safeCode: unique symbol };

export type StructuredLogService =
  | 'web'
  | 'worker'
  | 'plan6b-production-smoke'
  | 'plan6b-fixture-runtime-probe'
  | 'plan7a-release-candidate';

export type HttpRejectedCode = SafeCode<'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'method_not_allowed' | 'conflict' | 'payload_too_large' | 'unsupported_media_type' | 'invalid_input' | 'rate_limited' | 'request_rejected' | 'maintenance_mode'>;
export type HttpFailedCode = SafeCode<'http_server_error' | 'unexpected_failure'>;
export type WorkerStoppingCode = SafeCode<'signal_sigint' | 'signal_sigterm'>;
export type WorkerFailedCode = SafeCode<'configuration_invalid' | 'worker_identity_invalid' | 'dependency_startup_failed' | 'runner_failed' | 'runner_stopped_unexpectedly' | 'heartbeat_publication_failed' | 'worker_control_failed' | 'cleanup_failed' | 'unexpected_failure'>;
export type HeartbeatFailedCode = SafeCode<'heartbeat_publication_failed'>;
export type JobFailedCode = SafeCode<'permanent_job_failure' | 'job_completion_failed' | 'unexpected_failure'>;
export type JobLeaseLostCode = SafeCode<'lease_capability_invalid' | 'lease_renewal_rejected' | 'lease_renewal_failed' | 'completion_rejected' | 'failure_transition_rejected' | 'failure_transition_failed'>;
export type SmokeFailedCode = SafeCode<'required_stage_failed' | 'timeout' | 'interrupted' | 'ownership_mismatch' | 'configuration_mismatch' | 'cleanup_failed' | 'unexpected_failure'>;

type Common = { readonly event: string };
type HttpCommon = { readonly correlationId: CorrelationId; readonly method: string; readonly route: string; readonly httpStatus: number; readonly durationMs: number };
type JobCommon = { readonly correlationId: CorrelationId; readonly jobId: string; readonly jobKind: string; readonly attempt: number; readonly workerId: string; readonly slotId: number; readonly generation?: number };
type SmokeCommon = { readonly profile: 'maintenance_fixture' | 'release_candidate'; readonly runId: string; readonly candidateId: string };

export type WebEventInput =
  | (Common & HttpCommon & { readonly event: 'http.request.completed' })
  | (Common & HttpCommon & { readonly event: 'http.request.rejected'; readonly code: HttpRejectedCode })
  | (Common & HttpCommon & { readonly event: 'http.request.failed'; readonly code: HttpFailedCode });

export type WorkerEventInput =
  | { readonly event: 'worker.started'; readonly workerId: string; readonly configuredSlots: number }
  | { readonly event: 'worker.ready'; readonly workerId: string; readonly configuredSlots: number; readonly durationMs: number }
  | { readonly event: 'worker.stopping'; readonly workerId: string; readonly code: WorkerStoppingCode }
  | { readonly event: 'worker.stopped'; readonly workerId: string; readonly durationMs: number }
  | { readonly event: 'worker.failed'; readonly code: WorkerFailedCode; readonly workerId?: string }
  | (JobCommon & { readonly event: 'job.claimed'; readonly maxAttempts: number })
  | (JobCommon & { readonly event: 'job.succeeded'; readonly durationMs: number })
  | (JobCommon & { readonly event: 'job.failed'; readonly maxAttempts: number; readonly code: JobFailedCode; readonly durationMs: number; readonly retryScheduled: boolean })
  | (JobCommon & { readonly event: 'job.lease_lost'; readonly code: JobLeaseLostCode })
  | { readonly event: 'worker.heartbeat_failed'; readonly workerId: string; readonly code: HeartbeatFailedCode };

export type SmokeEventInput =
  | (SmokeCommon & { readonly event: 'smoke.stage.started'; readonly stage: string })
  | (SmokeCommon & { readonly event: 'smoke.stage.succeeded'; readonly stage: string; readonly durationMs: number })
  | (SmokeCommon & { readonly event: 'smoke.stage.failed'; readonly stage: string; readonly code: SmokeFailedCode; readonly durationMs: number })
  | (SmokeCommon & { readonly event: 'smoke.cleanup.succeeded'; readonly durationMs: number; readonly containerCount: number; readonly networkCount: number; readonly volumeCount: number; readonly temporaryRootCount: number })
  | (SmokeCommon & { readonly event: 'smoke.cleanup.failed'; readonly code: SmokeFailedCode; readonly durationMs: number; readonly containerCount: number; readonly networkCount: number; readonly volumeCount: number; readonly temporaryRootCount: number })
  | (SmokeCommon & { readonly event: 'smoke.run.succeeded'; readonly durationMs: number; readonly evidenceFingerprint: string })
  | (SmokeCommon & { readonly event: 'smoke.run.failed'; readonly stage: string; readonly code: SmokeFailedCode; readonly durationMs: number });

export type StructuredEventInputFor<S extends StructuredLogService> = S extends 'web' ? WebEventInput : S extends 'worker' ? WorkerEventInput : SmokeEventInput;

export interface ValidatedStructuredRecord {
  readonly record: Readonly<Record<string, string | number | boolean>>;
  readonly sink: 'stdout' | 'stderr';
}

const TOKEN = /^[a-z][a-z0-9._-]{0,99}$/;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RUN_ID = /^[a-f0-9]{16}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const STAGES = new Set(['preflight', 'build', 'compose-config', 'migrate', 'provision', 'checkpoint-capture', 'restore-rehearsal', 'runtime-start', 'runtime-health', 'inspect', 'behavior', 'shutdown', 'cleanup']);
const CODES: Readonly<Record<string, ReadonlySet<string>>> = {
  'http.request.rejected': new Set(['invalid_request', 'unauthenticated', 'forbidden', 'not_found', 'method_not_allowed', 'conflict', 'payload_too_large', 'unsupported_media_type', 'invalid_input', 'rate_limited', 'request_rejected', 'maintenance_mode']),
  'http.request.failed': new Set(['http_server_error', 'unexpected_failure']),
  'worker.stopping': new Set(['signal_sigint', 'signal_sigterm']),
  'worker.failed': new Set(['configuration_invalid', 'worker_identity_invalid', 'dependency_startup_failed', 'runner_failed', 'runner_stopped_unexpectedly', 'heartbeat_publication_failed', 'worker_control_failed', 'cleanup_failed', 'unexpected_failure']),
  'worker.heartbeat_failed': new Set(['heartbeat_publication_failed']),
  'job.failed': new Set(['permanent_job_failure', 'job_completion_failed', 'unexpected_failure']),
  'job.lease_lost': new Set(['lease_capability_invalid', 'lease_renewal_rejected', 'lease_renewal_failed', 'completion_rejected', 'failure_transition_rejected', 'failure_transition_failed']),
  'smoke.stage.failed': new Set(['required_stage_failed', 'timeout', 'interrupted', 'ownership_mismatch', 'configuration_mismatch', 'cleanup_failed', 'unexpected_failure']),
  'smoke.cleanup.failed': new Set(['required_stage_failed', 'timeout', 'interrupted', 'ownership_mismatch', 'configuration_mismatch', 'cleanup_failed', 'unexpected_failure']),
  'smoke.run.failed': new Set(['required_stage_failed', 'timeout', 'interrupted', 'ownership_mismatch', 'configuration_mismatch', 'cleanup_failed', 'unexpected_failure'])
};

function invalid(): never { throw new TypeError('invalid structured event'); }
export function isSafeToken(value: unknown): value is string { return typeof value === 'string' && TOKEN.test(value); }
export function isCorrelationId(value: unknown): value is CorrelationId { return typeof value === 'string' && CORRELATION.test(value); }
function object(value: unknown): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) if (!('value' in descriptor) || !descriptor.enumerable) invalid();
    return value as Record<string, unknown>;
  } catch { return invalid(); }
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = object(value);
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
  return record;
}
function string(value: unknown, pattern: RegExp): string { return typeof value === 'string' && pattern.test(value) ? value : invalid(); }
function integer(value: unknown, min: number, max: number): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(); }
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function code(event: string, value: unknown): string { const value_ = string(value, TOKEN); return CODES[event]?.has(value_) ? value_ : invalid(); }
function timestamp(value: string): string { try { return new Date(value).toISOString() === value ? value : invalid(); } catch { return invalid(); } }
function put(record: Record<string, string | number | boolean>, key: string, value: string | number | boolean): void { record[key] = value; }

function http(value: unknown, event: string, timestamp_: string, service: 'web'): ValidatedStructuredRecord {
  const keyed = exact(value, event === 'http.request.completed' ? ['event', 'correlationId', 'method', 'route', 'httpStatus', 'durationMs'] : ['event', 'correlationId', 'method', 'route', 'httpStatus', 'code', 'durationMs']);
  const record: Record<string, string | number | boolean> = { version: 1, timestamp: timestamp_, severity: event === 'http.request.completed' ? 'info' : event === 'http.request.rejected' ? 'warn' : 'error', service, event, outcome: event === 'http.request.completed' ? 'succeeded' : event === 'http.request.rejected' ? 'denied' : 'failed' };
  put(record, 'correlationId', string(keyed.correlationId, CORRELATION)); put(record, 'method', string(keyed.method, /^[A-Z]{1,16}$/)); put(record, 'route', string(keyed.route, /^.{1,200}$/)); put(record, 'httpStatus', integer(keyed.httpStatus, 100, 599));
  if (event !== 'http.request.completed') put(record, 'code', code(event, keyed.code));
  put(record, 'durationMs', integer(keyed.durationMs, 0, 86_400_000));
  return { record, sink: event === 'http.request.completed' ? 'stdout' : 'stderr' };
}

function worker(value: unknown, event: string, timestamp_: string): ValidatedStructuredRecord {
  const specs: Readonly<Record<string, readonly string[]>> = {
    'worker.started': ['event', 'workerId', 'configuredSlots'], 'worker.ready': ['event', 'workerId', 'configuredSlots', 'durationMs'], 'worker.stopping': ['event', 'workerId', 'code'], 'worker.stopped': ['event', 'workerId', 'durationMs'], 'worker.failed': ['event', 'code', 'workerId'], 'worker.heartbeat_failed': ['event', 'workerId', 'code'],
    'job.claimed': ['event', 'correlationId', 'jobId', 'jobKind', 'attempt', 'maxAttempts', 'workerId', 'slotId', 'generation'], 'job.succeeded': ['event', 'correlationId', 'jobId', 'jobKind', 'attempt', 'workerId', 'slotId', 'durationMs'], 'job.failed': ['event', 'correlationId', 'jobId', 'jobKind', 'attempt', 'maxAttempts', 'workerId', 'slotId', 'code', 'durationMs', 'retryScheduled'], 'job.lease_lost': ['event', 'correlationId', 'jobId', 'jobKind', 'attempt', 'workerId', 'slotId', 'code']
  };
  let keyed: Record<string, unknown>;
  if (event === 'worker.failed') {
    const raw = object(value); const keys = Object.keys(raw); if (!keys.every((key) => ['event', 'code', 'workerId'].includes(key)) || !keys.includes('event') || !keys.includes('code')) invalid(); keyed = raw;
  } else if (event.startsWith('job.')) {
    const raw = object(value); const base = specs[event]!; const permitted = [...base, 'generation']; const keys = Object.keys(raw); if (!keys.every((key) => permitted.includes(key)) || base.some((key) => key !== 'generation' && !keys.includes(key))) invalid(); keyed = raw;
  } else keyed = exact(value, specs[event]!);
  const retry = event === 'job.failed' ? bool(keyed.retryScheduled) : false;
  const severity = event === 'worker.started' || event === 'worker.ready' || event === 'worker.stopping' || event === 'worker.stopped' || event === 'job.succeeded' ? 'info' : event === 'job.claimed' ? 'debug' : event === 'job.failed' && retry ? 'warn' : event === 'job.lease_lost' ? 'warn' : 'error';
  const outcome = event === 'worker.started' || event === 'worker.stopping' || event === 'job.claimed' ? 'started' : event === 'worker.ready' || event === 'worker.stopped' || event === 'job.succeeded' ? 'succeeded' : 'failed';
  const record: Record<string, string | number | boolean> = { version: 1, timestamp: timestamp_, severity, service: 'worker', event, outcome };
  if (event.startsWith('job.')) { put(record, 'correlationId', string(keyed.correlationId, CORRELATION)); put(record, 'jobId', string(keyed.jobId, UUID)); put(record, 'jobKind', string(keyed.jobKind, TOKEN)); put(record, 'attempt', integer(keyed.attempt, 1, 2_147_483_647)); if ('maxAttempts' in keyed) put(record, 'maxAttempts', integer(keyed.maxAttempts, 1, 2_147_483_647)); put(record, 'workerId', string(keyed.workerId, WORKER_ID)); put(record, 'slotId', integer(keyed.slotId, 0, 2_147_483_647)); if ('code' in keyed) put(record, 'code', code(event, keyed.code)); if ('durationMs' in keyed) put(record, 'durationMs', integer(keyed.durationMs, 0, 86_400_000)); if ('retryScheduled' in keyed) put(record, 'retryScheduled', retry); if ('generation' in keyed) put(record, 'generation', integer(keyed.generation, 1, 2_147_483_647)); }
  else {
    if (event === 'worker.failed') {
      put(record, 'code', code(event, keyed.code));
      if ('workerId' in keyed) put(record, 'workerId', string(keyed.workerId, WORKER_ID));
    } else {
      if ('workerId' in keyed) put(record, 'workerId', string(keyed.workerId, WORKER_ID));
      if ('configuredSlots' in keyed) put(record, 'configuredSlots', integer(keyed.configuredSlots, 1, 2_147_483_647));
      if ('code' in keyed) put(record, 'code', code(event, keyed.code));
      if ('durationMs' in keyed) put(record, 'durationMs', integer(keyed.durationMs, 0, 86_400_000));
    }
  }
  return { record, sink: event === 'job.claimed' || event === 'job.succeeded' || event.startsWith('worker.') && !event.endsWith('failed') ? 'stdout' : 'stderr' };
}

function smoke(value: unknown, event: string, timestamp_: string, service: Exclude<StructuredLogService, 'web' | 'worker'>): ValidatedStructuredRecord {
  const keys: Readonly<Record<string, readonly string[]>> = {
    'smoke.stage.started': ['event', 'profile', 'runId', 'candidateId', 'stage'], 'smoke.stage.succeeded': ['event', 'profile', 'runId', 'candidateId', 'stage', 'durationMs'], 'smoke.stage.failed': ['event', 'profile', 'runId', 'candidateId', 'stage', 'code', 'durationMs'], 'smoke.cleanup.succeeded': ['event', 'profile', 'runId', 'candidateId', 'durationMs', 'containerCount', 'networkCount', 'volumeCount', 'temporaryRootCount'], 'smoke.cleanup.failed': ['event', 'profile', 'runId', 'candidateId', 'code', 'durationMs', 'containerCount', 'networkCount', 'volumeCount', 'temporaryRootCount'], 'smoke.run.succeeded': ['event', 'profile', 'runId', 'candidateId', 'durationMs', 'evidenceFingerprint'], 'smoke.run.failed': ['event', 'profile', 'runId', 'candidateId', 'stage', 'code', 'durationMs']
  };
  const keyed = exact(value, keys[event]!); const success = event.endsWith('succeeded'); const started = event.endsWith('started');
  const record: Record<string, string | number | boolean> = { version: 1, timestamp: timestamp_, severity: started ? 'debug' : success ? 'info' : 'error', service, event, outcome: started ? 'started' : success ? 'succeeded' : 'failed' };
  put(record, 'profile', keyed.profile === 'maintenance_fixture' || keyed.profile === 'release_candidate' ? keyed.profile : invalid()); put(record, 'runId', string(keyed.runId, RUN_ID)); put(record, 'candidateId', string(keyed.candidateId, UUID));
  if ('stage' in keyed) { const stage = string(keyed.stage, TOKEN); put(record, 'stage', STAGES.has(stage) ? stage : invalid()); } if ('code' in keyed) put(record, 'code', code(event, keyed.code)); if ('durationMs' in keyed) put(record, 'durationMs', integer(keyed.durationMs, 0, 86_400_000)); for (const key of ['containerCount', 'networkCount', 'volumeCount', 'temporaryRootCount'] as const) if (key in keyed) put(record, key, integer(keyed[key], 0, 2_147_483_647)); if ('evidenceFingerprint' in keyed) put(record, 'evidenceFingerprint', string(keyed.evidenceFingerprint, FINGERPRINT));
  return { record, sink: started || success ? 'stdout' : 'stderr' };
}

export function validateStructuredEvent<S extends StructuredLogService>(service: S, valueTimestamp: string, input: StructuredEventInputFor<S>): ValidatedStructuredRecord {
  const timestamp_ = timestamp(valueTimestamp); const raw = object(input); const event = string(raw.event, TOKEN);
  if (service === 'web' && ['http.request.completed', 'http.request.rejected', 'http.request.failed'].includes(event)) return http(input, event, timestamp_, service);
  if (service === 'worker' && ['worker.started', 'worker.ready', 'worker.stopping', 'worker.stopped', 'worker.failed', 'job.claimed', 'job.succeeded', 'job.failed', 'job.lease_lost', 'worker.heartbeat_failed'].includes(event)) return worker(input, event, timestamp_);
  if (service !== 'web' && service !== 'worker' && ['smoke.stage.started', 'smoke.stage.succeeded', 'smoke.stage.failed', 'smoke.cleanup.succeeded', 'smoke.cleanup.failed', 'smoke.run.succeeded', 'smoke.run.failed'].includes(event)) return smoke(input, event, timestamp_, service);
  return invalid();
}
