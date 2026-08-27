import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  definitionForJobKind,
  isJobRetryPolicyOutcomeAllowed,
  isOperationalFailureCodeAllowedForJobKind,
  isRegisteredJobKind,
  type JobRetryDisposition,
  type JobRetryPolicyAvailability,
  type OperationalJobFailureCode,
  type OperationalJobStatus,
  type RegisteredJobKind
} from '../../jobs/catalog';
import { isCorrelationId } from '../../observability/contracts';

export type JobRetryReasonCode =
  | 'dependency_recovered'
  | 'configuration_recovered'
  | 'operator_reassessment';

export type JobRetrySuccessResultCode =
  | 'rearmed_existing'
  | 'successor_enqueued'
  | 'already_current';

export type JobRetryDenialResultCode =
  | 'retry_not_supported'
  | 'retry_policy_not_enabled'
  | 'provider_recovery_not_enabled'
  | 'target_not_failed'
  | 'target_state_changed'
  | 'domain_state_not_retryable'
  | 'source_unavailable'
  | 'actor_not_authorized';

export type JobRetryFailureResultCode =
  | 'retry_command_invalid'
  | 'retry_command_exhausted'
  | 'unexpected_failure';

export interface OperationalJobListCursor {
  readonly updatedAt: string;
  readonly jobId: string;
}

export interface OperationalJobListInput {
  readonly kind?: RegisteredJobKind;
  readonly status?: OperationalJobStatus;
  readonly limit: number;
  readonly cursor?: Readonly<OperationalJobListCursor>;
}

export interface OperationalJobDto {
  readonly jobId: string;
  readonly kind: RegisteredJobKind | 'unregistered';
  readonly label: string;
  readonly status: OperationalJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAt: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retryDisposition: JobRetryDisposition;
  readonly policyAvailability: JobRetryPolicyAvailability;
  readonly safeFailureCode: OperationalJobFailureCode | null;
}

export interface JobRetryCommandInput {
  readonly idempotencyKey: string;
  readonly targetJobId: string;
  readonly expectedKind: RegisteredJobKind;
  readonly expectedStatus: 'failed';
  readonly expectedAttempts: number;
  readonly expectedMaxAttempts: number;
  readonly expectedUpdatedAt: string;
  readonly reasonCode: JobRetryReasonCode;
}

interface JobRetryCommandStatusCommon {
  readonly commandId: string;
  readonly kind: 'retry_failed_job';
  readonly targetJobId: string;
  readonly targetKind: RegisteredJobKind;
  readonly reasonCode: JobRetryReasonCode;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PendingJobRetryCommandStatusDto extends JobRetryCommandStatusCommon {
  readonly status: 'pending';
  readonly resultCode: null;
  readonly completedAt: null;
}

export interface SucceededJobRetryCommandStatusDto extends JobRetryCommandStatusCommon {
  readonly status: 'succeeded';
  readonly resultCode: JobRetrySuccessResultCode;
  readonly completedAt: string;
}

export interface DeniedJobRetryCommandStatusDto extends JobRetryCommandStatusCommon {
  readonly status: 'denied';
  readonly resultCode: JobRetryDenialResultCode;
  readonly completedAt: string;
}

export interface FailedJobRetryCommandStatusDto extends JobRetryCommandStatusCommon {
  readonly status: 'failed';
  readonly resultCode: JobRetryFailureResultCode;
  readonly completedAt: string;
}

export type JobRetryCommandStatusDto =
  | PendingJobRetryCommandStatusDto
  | SucceededJobRetryCommandStatusDto
  | DeniedJobRetryCommandStatusDto
  | FailedJobRetryCommandStatusDto;

export interface PreparedJobRetryCommand {
  readonly command: JobRetryCommandInput;
  readonly canonicalInput: string;
  readonly idempotencyKeySha256: string;
  readonly inputFingerprintSha256: string;
}

export class JobOperationsInputError extends Error {
  readonly code = 'invalid_input' as const;

  constructor() {
    super('Invalid job operations input');
    Object.defineProperty(this, 'name', { value: 'JobOperationsInputError' });
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

const LIST_KEYS = ['kind', 'status', 'limit', 'cursor'] as const;
const CURSOR_KEYS = ['updatedAt', 'jobId'] as const;
const JOB_KEYS = [
  'jobId', 'kind', 'label', 'status', 'attempts', 'maxAttempts', 'runAt', 'completedAt',
  'createdAt', 'updatedAt', 'retryDisposition', 'policyAvailability', 'safeFailureCode'
] as const;
const COMMAND_KEYS = [
  'idempotencyKey', 'targetJobId', 'expectedKind', 'expectedStatus', 'expectedAttempts',
  'expectedMaxAttempts', 'expectedUpdatedAt', 'reasonCode'
] as const;
const STATUS_KEYS = [
  'commandId', 'kind', 'targetJobId', 'targetKind', 'reasonCode', 'correlationId', 'status',
  'resultCode', 'createdAt', 'updatedAt', 'completedAt'
] as const;

const OPERATIONAL_STATUSES: readonly OperationalJobStatus[] =
  ['pending', 'running', 'succeeded', 'failed'];
const REASONS: readonly JobRetryReasonCode[] =
  ['dependency_recovered', 'configuration_recovered', 'operator_reassessment'];
const COMMON_FAILURE_RESULTS: readonly JobRetryFailureResultCode[] = [
  'retry_command_invalid', 'retry_command_exhausted', 'unexpected_failure'
];

function invalid(): never {
  throw new JobOperationsInputError();
}

function dataRecord(value: unknown): DataRecord {
  try {
    if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) {
      return invalid();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string') return invalid();
      const descriptorEntry = Object.getOwnPropertyDescriptor(descriptors, key);
      const descriptor = descriptorEntry?.value;
      if (descriptor === null || typeof descriptor !== 'object' ||
        !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return invalid();
      Object.defineProperty(output, key, {
        enumerable: true,
        value: descriptor.value
      });
    }
    return output;
  } catch {
    return invalid();
  }
}

function exactRecord(value: unknown, allowedKeys: readonly string[]): DataRecord {
  const record = dataRecord(value);
  const keys = Object.keys(record);
  if (keys.some((key) => !allowedKeys.includes(key))) return invalid();
  return record;
}

function requiredExactRecord(value: unknown, requiredKeys: readonly string[]): DataRecord {
  const record = exactRecord(value, requiredKeys);
  const keys = Object.keys(record);
  if (keys.length !== requiredKeys.length || requiredKeys.some((key) => !Object.hasOwn(record, key))) {
    return invalid();
  }
  return record;
}

function oneOf<const Item extends string>(value: unknown, values: readonly Item[]): Item {
  return typeof value === 'string' && values.includes(value as Item) ? value as Item : invalid();
}

function nonnegativeInt32(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 0 && value <= 2_147_483_647 ? value : invalid();
}

function positiveInt32(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 1 && value <= 2_147_483_647 ? value : invalid();
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})[.](\d{6})Z$/u.exec(value);
  if (match === null) return invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return invalid();
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]!) return invalid();
  return value;
}

function canonicalUuid(value: unknown): string {
  return typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value)
    ? value
    : invalid();
}

function registeredKind(value: unknown): RegisteredJobKind {
  return isRegisteredJobKind(value) ? value : invalid();
}

function operationalStatus(value: unknown): OperationalJobStatus {
  return oneOf(value, OPERATIONAL_STATUSES);
}

function reasonCode(value: unknown): JobRetryReasonCode {
  return oneOf(value, REASONS);
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : canonicalTimestamp(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function parseCanonicalOperationsUuid(value: unknown): string {
  return canonicalUuid(value);
}

export function parseOperationalJobListInput(value: unknown): OperationalJobListInput {
  const record = exactRecord(value, LIST_KEYS);
  const limit = Object.hasOwn(record, 'limit')
    ? positiveInt32(record.limit)
    : 50;
  if (limit > 100) return invalid();

  const output: {
    kind?: RegisteredJobKind;
    status?: OperationalJobStatus;
    limit: number;
    cursor?: OperationalJobListCursor;
  } = { limit };
  if (Object.hasOwn(record, 'kind')) output.kind = registeredKind(record.kind);
  if (Object.hasOwn(record, 'status')) output.status = operationalStatus(record.status);
  if (Object.hasOwn(record, 'cursor')) {
    const cursor = requiredExactRecord(record.cursor, CURSOR_KEYS);
    output.cursor = Object.freeze({
      updatedAt: canonicalTimestamp(cursor.updatedAt),
      jobId: canonicalUuid(cursor.jobId)
    });
  }
  return Object.freeze(output);
}

export function parseOperationalJobDto(value: unknown): OperationalJobDto {
  const record = requiredExactRecord(value, JOB_KEYS);
  const jobId = canonicalUuid(record.jobId);
  const status = operationalStatus(record.status);
  const attempts = nonnegativeInt32(record.attempts);
  const maxAttempts = positiveInt32(record.maxAttempts);
  if (attempts > maxAttempts) return invalid();
  const runAt = canonicalTimestamp(record.runAt);
  const completedAt = nullableTimestamp(record.completedAt);
  const createdAt = canonicalTimestamp(record.createdAt);
  const updatedAt = canonicalTimestamp(record.updatedAt);

  if (record.kind === 'unregistered') {
    if (record.label !== 'Unregistered job' || record.retryDisposition !== 'never' ||
      record.policyAvailability !== 'excluded' ||
      record.safeFailureCode !== 'unregistered_job_kind') return invalid();
    return Object.freeze({
      jobId,
      kind: 'unregistered',
      label: 'Unregistered job',
      status,
      attempts,
      maxAttempts,
      runAt,
      completedAt,
      createdAt,
      updatedAt,
      retryDisposition: 'never',
      policyAvailability: 'excluded',
      safeFailureCode: 'unregistered_job_kind'
    });
  }

  const kind = registeredKind(record.kind);
  const definition = definitionForJobKind(kind);
  if (definition === undefined || record.label !== definition.label ||
    maxAttempts !== definition.maxAttempts ||
    record.retryDisposition !== definition.retryDisposition ||
    record.policyAvailability !== definition.retryPolicyAvailability) return invalid();
  const safeFailureCode = isOperationalFailureCodeAllowedForJobKind(kind, record.safeFailureCode)
    ? record.safeFailureCode
    : invalid();
  return Object.freeze({
    jobId,
    kind,
    label: definition.label,
    status,
    attempts,
    maxAttempts,
    runAt,
    completedAt,
    createdAt,
    updatedAt,
    retryDisposition: definition.retryDisposition,
    policyAvailability: definition.retryPolicyAvailability,
    safeFailureCode
  });
}

export function prepareJobRetryCommand(value: unknown): PreparedJobRetryCommand {
  const record = requiredExactRecord(value, COMMAND_KEYS);
  const idempotencyKey = canonicalUuid(record.idempotencyKey);
  const targetJobId = canonicalUuid(record.targetJobId);
  const expectedKind = registeredKind(record.expectedKind);
  if (record.expectedStatus !== 'failed') return invalid();
  const expectedAttempts = positiveInt32(record.expectedAttempts);
  const expectedMaxAttempts = positiveInt32(record.expectedMaxAttempts);
  const definition = definitionForJobKind(expectedKind);
  if (definition === undefined || expectedMaxAttempts !== definition.maxAttempts ||
    expectedAttempts > expectedMaxAttempts) return invalid();
  const expectedUpdatedAt = canonicalTimestamp(record.expectedUpdatedAt);
  const parsedReasonCode = reasonCode(record.reasonCode);
  const command: JobRetryCommandInput = Object.freeze({
    idempotencyKey,
    targetJobId,
    expectedKind,
    expectedStatus: 'failed',
    expectedAttempts,
    expectedMaxAttempts,
    expectedUpdatedAt,
    reasonCode: parsedReasonCode
  });
  const canonicalInput = JSON.stringify({
    targetJobId,
    expectedKind,
    expectedStatus: 'failed',
    expectedAttempts,
    expectedMaxAttempts,
    expectedUpdatedAt,
    reasonCode: parsedReasonCode
  });
  return Object.freeze({
    command,
    canonicalInput,
    idempotencyKeySha256: sha256(idempotencyKey),
    inputFingerprintSha256: sha256(canonicalInput)
  });
}

function terminalResultAllowed(
  targetKind: RegisteredJobKind,
  status: 'succeeded' | 'denied' | 'failed',
  resultCode: string
): boolean {
  if (status === 'denied' && resultCode === 'actor_not_authorized') return true;
  if (status === 'failed' && COMMON_FAILURE_RESULTS.includes(
    resultCode as JobRetryFailureResultCode
  )) return true;
  const definition = definitionForJobKind(targetKind);
  return definition !== undefined && isJobRetryPolicyOutcomeAllowed(
    definition.retryPolicyId,
    status,
    resultCode
  );
}

export function parseJobRetryCommandStatusDto(value: unknown): JobRetryCommandStatusDto {
  const record = requiredExactRecord(value, STATUS_KEYS);
  const commandId = canonicalUuid(record.commandId);
  if (record.kind !== 'retry_failed_job') return invalid();
  const targetJobId = canonicalUuid(record.targetJobId);
  const targetKind = registeredKind(record.targetKind);
  const parsedReasonCode = reasonCode(record.reasonCode);
  const correlationId = isCorrelationId(record.correlationId) ? record.correlationId : invalid();
  const createdAt = canonicalTimestamp(record.createdAt);
  const updatedAt = canonicalTimestamp(record.updatedAt);

  const common = {
    commandId,
    kind: 'retry_failed_job' as const,
    targetJobId,
    targetKind,
    reasonCode: parsedReasonCode,
    correlationId,
    createdAt,
    updatedAt
  };

  if (record.status === 'pending') {
    if (record.resultCode !== null || record.completedAt !== null) return invalid();
    return Object.freeze({ ...common, status: 'pending', resultCode: null, completedAt: null });
  }
  if (record.status !== 'succeeded' && record.status !== 'denied' && record.status !== 'failed') {
    return invalid();
  }
  if (typeof record.resultCode !== 'string' ||
    !terminalResultAllowed(targetKind, record.status, record.resultCode)) return invalid();
  const completedAt = canonicalTimestamp(record.completedAt);
  if (record.status === 'succeeded') {
    return Object.freeze({
      ...common,
      status: 'succeeded',
      resultCode: record.resultCode as JobRetrySuccessResultCode,
      completedAt
    });
  }
  if (record.status === 'denied') {
    return Object.freeze({
      ...common,
      status: 'denied',
      resultCode: record.resultCode as JobRetryDenialResultCode,
      completedAt
    });
  }
  return Object.freeze({
    ...common,
    status: 'failed',
    resultCode: record.resultCode as JobRetryFailureResultCode,
    completedAt
  });
}
