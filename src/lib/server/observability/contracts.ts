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
type Severity = 'debug' | 'info' | 'warn' | 'error';
type Outcome = 'started' | 'succeeded' | 'failed' | 'denied';
type PublicEvent = WebEventInput['event'] | WorkerEventInput['event'] | SmokeEventInput['event'];
type EventName = PublicEvent | 'logging.failure';
type EventMetadata = {
  readonly services: readonly StructuredLogService[];
  readonly fields: readonly string[];
  readonly optional?: 'generation' | 'workerId';
  readonly severity: Severity | ((values: Readonly<Record<string, string | number | boolean>>) => Severity);
  readonly outcome: Outcome;
  readonly sink: 'stdout' | 'stderr';
  readonly codes?: readonly string[];
  readonly profiles?: Partial<Record<Exclude<StructuredLogService, 'web' | 'worker'>, 'maintenance_fixture' | 'release_candidate'>>;
  readonly internal?: true;
};

const EVENTS: Readonly<Record<EventName, EventMetadata>> = {
  'http.request.completed': { services: ['web'], fields: ['correlationId', 'method', 'route', 'httpStatus', 'durationMs'], severity: 'info', outcome: 'succeeded', sink: 'stdout' },
  'http.request.rejected': { services: ['web'], fields: ['correlationId', 'method', 'route', 'httpStatus', 'code', 'durationMs'], severity: 'warn', outcome: 'denied', sink: 'stderr', codes: ['invalid_request', 'unauthenticated', 'forbidden', 'not_found', 'method_not_allowed', 'conflict', 'payload_too_large', 'unsupported_media_type', 'invalid_input', 'rate_limited', 'request_rejected', 'maintenance_mode'] },
  'http.request.failed': { services: ['web'], fields: ['correlationId', 'method', 'route', 'httpStatus', 'code', 'durationMs'], severity: 'error', outcome: 'failed', sink: 'stderr', codes: ['http_server_error', 'unexpected_failure'] },
  'worker.started': { services: ['worker'], fields: ['workerId', 'configuredSlots'], severity: 'info', outcome: 'started', sink: 'stdout' },
  'worker.ready': { services: ['worker'], fields: ['workerId', 'configuredSlots', 'durationMs'], severity: 'info', outcome: 'succeeded', sink: 'stdout' },
  'worker.stopping': { services: ['worker'], fields: ['workerId', 'code'], severity: 'info', outcome: 'started', sink: 'stdout', codes: ['signal_sigint', 'signal_sigterm'] },
  'worker.stopped': { services: ['worker'], fields: ['workerId', 'durationMs'], severity: 'info', outcome: 'succeeded', sink: 'stdout' },
  'worker.failed': { services: ['worker'], fields: ['code'], optional: 'workerId', severity: 'error', outcome: 'failed', sink: 'stderr', codes: ['configuration_invalid', 'worker_identity_invalid', 'dependency_startup_failed', 'runner_failed', 'runner_stopped_unexpectedly', 'heartbeat_publication_failed', 'worker_control_failed', 'cleanup_failed', 'unexpected_failure'] },
  'job.claimed': { services: ['worker'], fields: ['correlationId', 'jobId', 'jobKind', 'attempt', 'maxAttempts', 'workerId', 'slotId'], optional: 'generation', severity: 'debug', outcome: 'started', sink: 'stdout' },
  'job.succeeded': { services: ['worker'], fields: ['correlationId', 'jobId', 'jobKind', 'attempt', 'workerId', 'slotId', 'durationMs'], optional: 'generation', severity: 'info', outcome: 'succeeded', sink: 'stdout' },
  'job.failed': { services: ['worker'], fields: ['correlationId', 'jobId', 'jobKind', 'attempt', 'maxAttempts', 'workerId', 'slotId', 'code', 'durationMs', 'retryScheduled'], optional: 'generation', severity: (values) => values.retryScheduled === true ? 'warn' : 'error', outcome: 'failed', sink: 'stderr', codes: ['permanent_job_failure', 'job_completion_failed', 'unexpected_failure'] },
  'job.lease_lost': { services: ['worker'], fields: ['correlationId', 'jobId', 'jobKind', 'attempt', 'workerId', 'slotId', 'code'], optional: 'generation', severity: 'warn', outcome: 'failed', sink: 'stderr', codes: ['lease_capability_invalid', 'lease_renewal_rejected', 'lease_renewal_failed', 'completion_rejected', 'failure_transition_rejected', 'failure_transition_failed'] },
  'worker.heartbeat_failed': { services: ['worker'], fields: ['workerId', 'code'], severity: 'error', outcome: 'failed', sink: 'stderr', codes: ['heartbeat_publication_failed'] },
  'smoke.stage.started': { services: ['plan6b-production-smoke', 'plan6b-fixture-runtime-probe', 'plan7a-release-candidate'], profiles: { 'plan6b-production-smoke': 'maintenance_fixture', 'plan6b-fixture-runtime-probe': 'maintenance_fixture', 'plan7a-release-candidate': 'release_candidate' }, fields: ['profile', 'runId', 'candidateId', 'stage'], severity: 'debug', outcome: 'started', sink: 'stdout' },
  'smoke.stage.succeeded': { services: ['plan6b-production-smoke', 'plan6b-fixture-runtime-probe', 'plan7a-release-candidate'], profiles: { 'plan6b-production-smoke': 'maintenance_fixture', 'plan6b-fixture-runtime-probe': 'maintenance_fixture', 'plan7a-release-candidate': 'release_candidate' }, fields: ['profile', 'runId', 'candidateId', 'stage', 'durationMs'], severity: 'info', outcome: 'succeeded', sink: 'stdout' },
  'smoke.stage.failed': { services: ['plan6b-production-smoke', 'plan6b-fixture-runtime-probe', 'plan7a-release-candidate'], profiles: { 'plan6b-production-smoke': 'maintenance_fixture', 'plan6b-fixture-runtime-probe': 'maintenance_fixture', 'plan7a-release-candidate': 'release_candidate' }, fields: ['profile', 'runId', 'candidateId', 'stage', 'code', 'durationMs'], severity: 'error', outcome: 'failed', sink: 'stderr', codes: ['required_stage_failed', 'timeout', 'interrupted', 'ownership_mismatch', 'configuration_mismatch', 'cleanup_failed', 'unexpected_failure'] },
  'smoke.cleanup.succeeded': { services: ['plan6b-production-smoke', 'plan6b-fixture-runtime-probe', 'plan7a-release-candidate'], profiles: { 'plan6b-production-smoke': 'maintenance_fixture', 'plan6b-fixture-runtime-probe': 'maintenance_fixture', 'plan7a-release-candidate': 'release_candidate' }, fields: ['profile', 'runId', 'candidateId', 'durationMs', 'containerCount', 'networkCount', 'volumeCount', 'temporaryRootCount'], severity: 'info', outcome: 'succeeded', sink: 'stdout' },
  'smoke.cleanup.failed': { services: ['plan6b-production-smoke', 'plan6b-fixture-runtime-probe', 'plan7a-release-candidate'], profiles: { 'plan6b-production-smoke': 'maintenance_fixture', 'plan6b-fixture-runtime-probe': 'maintenance_fixture', 'plan7a-release-candidate': 'release_candidate' }, fields: ['profile', 'runId', 'candidateId', 'code', 'durationMs', 'containerCount', 'networkCount', 'volumeCount', 'temporaryRootCount'], severity: 'error', outcome: 'failed', sink: 'stderr', codes: ['required_stage_failed', 'timeout', 'interrupted', 'ownership_mismatch', 'configuration_mismatch', 'cleanup_failed', 'unexpected_failure'] },
  'smoke.run.succeeded': { services: ['plan6b-production-smoke', 'plan6b-fixture-runtime-probe', 'plan7a-release-candidate'], profiles: { 'plan6b-production-smoke': 'maintenance_fixture', 'plan6b-fixture-runtime-probe': 'maintenance_fixture', 'plan7a-release-candidate': 'release_candidate' }, fields: ['profile', 'runId', 'candidateId', 'durationMs', 'evidenceFingerprint'], severity: 'info', outcome: 'succeeded', sink: 'stdout' },
  'smoke.run.failed': { services: ['plan6b-production-smoke', 'plan6b-fixture-runtime-probe', 'plan7a-release-candidate'], profiles: { 'plan6b-production-smoke': 'maintenance_fixture', 'plan6b-fixture-runtime-probe': 'maintenance_fixture', 'plan7a-release-candidate': 'release_candidate' }, fields: ['profile', 'runId', 'candidateId', 'stage', 'code', 'durationMs'], severity: 'error', outcome: 'failed', sink: 'stderr', codes: ['required_stage_failed', 'timeout', 'interrupted', 'ownership_mismatch', 'configuration_mismatch', 'cleanup_failed', 'unexpected_failure'] },
  'logging.failure': { services: ['web', 'worker', 'plan6b-production-smoke', 'plan6b-fixture-runtime-probe', 'plan7a-release-candidate'], fields: [], severity: 'error', outcome: 'failed', sink: 'stderr', internal: true }
};

function invalid(): never { throw new TypeError('invalid structured event'); }
export function isSafeToken(value: unknown): value is string { return typeof value === 'string' && TOKEN.test(value); }
export function isCorrelationId(value: unknown): value is CorrelationId { return typeof value === 'string' && CORRELATION.test(value); }
export function isCanonicalLowercaseUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
export function isWorkerId(value: unknown): value is string { return typeof value === 'string' && WORKER_ID.test(value); }
export function isNonnegativeSignedInt32(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647; }
export function isPositiveSignedInt32(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647; }
function isService(value: unknown): value is StructuredLogService { return typeof value === 'string' && EVENTS['logging.failure'].services.includes(value as StructuredLogService); }
function object(value: unknown): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') invalid();
      const entry = Object.getOwnPropertyDescriptor(descriptors, key);
      const descriptor = entry && Object.hasOwn(entry, 'value') ? entry.value : undefined;
      if (descriptor === null || typeof descriptor !== 'object' || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
    }
    return value as Record<string, unknown>;
  } catch { return invalid(); }
}
function metadataOptional(metadata: EventMetadata): 'generation' | 'workerId' | undefined {
  return Object.hasOwn(metadata, 'optional') ? metadata.optional : undefined;
}
function metadataInternal(metadata: EventMetadata): boolean { return Object.hasOwn(metadata, 'internal') && metadata.internal === true; }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = object(value); const actual = Reflect.ownKeys(record);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid();
  return record;
}
function string(value: unknown, pattern: RegExp): string { return typeof value === 'string' && pattern.test(value) ? value : invalid(); }
function integer(value: unknown, min: number, max: number): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(); }
function positive(value: unknown): number { return isPositiveSignedInt32(value) ? value : invalid(); }
function timestamp(value: string): string { try { return new Date(value).toISOString() === value ? value : invalid(); } catch { return invalid(); } }
function bag(): Record<string, string | number | boolean> { return Object.create(null) as Record<string, string | number | boolean>; }
function put(record: Record<string, string | number | boolean>, key: string, value: string | number | boolean): void {
  Object.defineProperty(record, key, { configurable: true, enumerable: true, value, writable: true });
}
function fieldValue(field: string, value: unknown, metadata: EventMetadata, service: StructuredLogService): string | number | boolean {
  switch (field) {
    case 'correlationId': return string(value, CORRELATION);
    case 'method': return string(value, /^[A-Z]{1,16}$/);
    case 'route': return string(value, /^.{1,200}$/);
    case 'httpStatus': return integer(value, 100, 599);
    case 'workerId': return isWorkerId(value) ? value : invalid();
    case 'configuredSlots': case 'attempt': case 'maxAttempts': case 'generation': return positive(value);
    case 'durationMs': return integer(value, 0, 86_400_000);
    case 'jobId': case 'candidateId': return isCanonicalLowercaseUuid(value) ? value : invalid();
    case 'jobKind': return string(value, TOKEN);
    case 'slotId': case 'containerCount': case 'networkCount': case 'volumeCount': case 'temporaryRootCount': return isNonnegativeSignedInt32(value) ? value : invalid();
    case 'retryScheduled': return typeof value === 'boolean' ? value : invalid();
    case 'code': { const code = string(value, TOKEN); return metadata.codes?.includes(code) ? code : invalid(); }
    case 'profile': return metadata.profiles?.[service as Exclude<StructuredLogService, 'web' | 'worker'>] === value ? value as 'maintenance_fixture' | 'release_candidate' : invalid();
    case 'runId': return string(value, RUN_ID);
    case 'stage': { const stage = string(value, TOKEN); return STAGES.has(stage) ? stage : invalid(); }
    case 'evidenceFingerprint': return string(value, FINGERPRINT);
    default: return invalid();
  }
}
function construct(event: EventName, metadata: EventMetadata, service: StructuredLogService, timestamp_: string, values: Readonly<Record<string, string | number | boolean>>, optional = metadataOptional(metadata)): ValidatedStructuredRecord {
  const severity = typeof metadata.severity === 'function' ? metadata.severity(values) : metadata.severity;
  const record = bag();
  put(record, 'version', 1); put(record, 'timestamp', timestamp_); put(record, 'severity', severity); put(record, 'service', service); put(record, 'event', event); put(record, 'outcome', metadata.outcome);
  for (const field of metadata.fields) put(record, field, values[field]!);
  if (optional !== undefined && Object.hasOwn(values, optional)) put(record, optional, values[optional]!);
  return { record, sink: metadata.sink };
}

export function validateStructuredEvent<S extends StructuredLogService>(service: S, valueTimestamp: string, input: StructuredEventInputFor<S>): ValidatedStructuredRecord {
  if (!isService(service)) return invalid();
  const raw = object(input); const event = string(raw.event, TOKEN);
  if (!Object.hasOwn(EVENTS, event)) return invalid();
  const metadata = EVENTS[event as EventName]!;
  const optional = metadataOptional(metadata);
  if (metadataInternal(metadata) || !metadata.services.includes(service)) return invalid();
  const keys = ['event', ...metadata.fields, ...(optional === undefined ? [] : [optional])];
  const hasOptional = optional !== undefined && Object.hasOwn(raw, optional);
  const keyed = exact(raw, hasOptional ? keys : keys.filter((key) => key !== optional));
  const values = bag();
  for (const field of metadata.fields) put(values, field, fieldValue(field, keyed[field], metadata, service));
  if (optional !== undefined && hasOptional) put(values, optional, fieldValue(optional, keyed[optional], metadata, service));
  return construct(event as PublicEvent, metadata, service, timestamp(valueTimestamp), values, optional);
}

export function validateLoggingFailure(service: StructuredLogService, valueTimestamp: string): ValidatedStructuredRecord {
  if (arguments.length !== 2 || !isService(service)) return invalid();
  return construct('logging.failure', EVENTS['logging.failure'], service, timestamp(valueTimestamp), {});
}
