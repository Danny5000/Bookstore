import { isProxy } from 'node:util/types';
import { sql } from 'drizzle-orm';

import {
  FINANCIAL_CLASSIFICATION_JOB,
  parseFinancialJobIdentity,
  type FinancialClassificationJobSpec,
  type FinancialClassificationSubjectJobPayload
} from '$lib/server/commerce/financial/jobs';
import {
  FINANCIAL_CLASSIFICATION_JOB_MAX_ATTEMPTS
} from '$lib/server/commerce/financial/constants';
import {
  lockFinancialProjectionAuthority,
  lockFinancialProjectionEnrollment,
  type FinancialProjectionAuthority
} from '$lib/server/commerce/financial/projection-authority';
import { rearmFinancialClassificationJob } from '$lib/server/jobs/repository';
import {
  InvalidJobRetryPolicyIdentityError,
  type JobRetryPolicyAdapter,
  type JobRetryPolicyOutcome,
  type JobRetryPolicyTarget
} from '../policies';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const REQUIRED_PAYLOAD_KEYS = Object.freeze([
  'subjectType',
  'subjectId',
  'sourceFingerprintSha256',
  'classifierVersion',
  'allocationAlgorithmVersion',
  'replayId'
] as const);

const REARMED = Object.freeze({
  status: 'succeeded',
  resultCode: 'rearmed_existing'
} as const satisfies JobRetryPolicyOutcome);
const TARGET_STATE_CHANGED = Object.freeze({
  status: 'denied',
  resultCode: 'target_state_changed'
} as const satisfies JobRetryPolicyOutcome);
const DOMAIN_STATE_NOT_RETRYABLE = Object.freeze({
  status: 'denied',
  resultCode: 'domain_state_not_retryable'
} as const satisfies JobRetryPolicyOutcome);
const SOURCE_UNAVAILABLE = Object.freeze({
  status: 'denied',
  resultCode: 'source_unavailable'
} as const satisfies JobRetryPolicyOutcome);
const RETRY_COMMAND_INVALID = Object.freeze({
  status: 'failed',
  resultCode: 'retry_command_invalid'
} as const satisfies JobRetryPolicyOutcome);

interface LockedJobRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly type: unknown;
  readonly payload: unknown;
  readonly deduplicationKey: unknown;
  readonly status: unknown;
  readonly attempts: unknown;
  readonly maxAttempts: unknown;
  readonly updatedAt: unknown;
}

interface ScanRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly rootKey: unknown;
  readonly kind: unknown;
  readonly phase: unknown;
  readonly state: unknown;
  readonly classifierVersion: unknown;
  readonly allocationAlgorithmVersion: unknown;
  readonly replayId: unknown;
  readonly completedAt: unknown;
}

interface SourceRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly sourceFingerprintSha256: unknown;
  readonly balanceTransactionId?: unknown;
}

interface RearmPostconditionRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly runAt: unknown;
  readonly updatedAt: unknown;
  readonly transactionTimestamp: unknown;
}

function impossibleIdentity(): never {
  throw new InvalidJobRetryPolicyIdentityError();
}

function ownDataValue(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    if (isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exactSingleRow<T>(rows: readonly T[]): T | undefined {
  return rows.length === 1 ? rows[0] : undefined;
}

function validTarget(target: JobRetryPolicyTarget): boolean {
  return target.expectedKind === FINANCIAL_CLASSIFICATION_JOB &&
    target.expectedStatus === 'failed' &&
    typeof target.targetJobId === 'string' && UUID_PATTERN.test(target.targetJobId) &&
    Number.isInteger(target.expectedAttempts) && target.expectedAttempts >= 0 &&
    Number.isInteger(target.expectedMaxAttempts) && target.expectedMaxAttempts > 0 &&
    typeof target.expectedUpdatedAt === 'string' &&
    TIMESTAMP_PATTERN.test(target.expectedUpdatedAt);
}

function submittedSnapshotChanged(
  target: JobRetryPolicyTarget,
  job: LockedJobRow
): boolean {
  return ownDataValue(job, 'type') !== target.expectedKind ||
    ownDataValue(job, 'status') !== target.expectedStatus ||
    ownDataValue(job, 'attempts') !== target.expectedAttempts ||
    ownDataValue(job, 'maxAttempts') !== target.expectedMaxAttempts ||
    ownDataValue(job, 'updatedAt') !== target.expectedUpdatedAt;
}

function exactPayloadCopy(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    if (isProxy(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const hasScanRunId = Object.hasOwn(value, 'scanRunId');
    const expectedKeys = hasScanRunId
      ? [...REQUIRED_PAYLOAD_KEYS, 'scanRunId']
      : REQUIRED_PAYLOAD_KEYS;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) =>
        typeof key !== 'string' || !expectedKeys.some((expected) => expected === key)
      )
    ) return undefined;

    const copied: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true
      ) return undefined;
      copied[key] = descriptor.value;
    }
    return copied;
  } catch {
    return undefined;
  }
}

function exactPayloadMatches(
  raw: Record<string, unknown>,
  parsed: FinancialClassificationSubjectJobPayload
): boolean {
  return raw.subjectType === parsed.subjectType &&
    raw.subjectId === parsed.subjectId &&
    raw.sourceFingerprintSha256 === parsed.sourceFingerprintSha256 &&
    raw.classifierVersion === parsed.classifierVersion &&
    raw.allocationAlgorithmVersion === parsed.allocationAlgorithmVersion &&
    raw.replayId === parsed.replayId &&
    raw.scanRunId === parsed.scanRunId &&
    Object.hasOwn(raw, 'scanRunId') === Object.hasOwn(parsed, 'scanRunId');
}

function parseExactSpec(job: LockedJobRow): FinancialClassificationJobSpec | undefined {
  const type = ownDataValue(job, 'type');
  const payload = exactPayloadCopy(ownDataValue(job, 'payload'));
  const deduplicationKey = ownDataValue(job, 'deduplicationKey');
  const maxAttempts = ownDataValue(job, 'maxAttempts');
  if (
    type !== FINANCIAL_CLASSIFICATION_JOB ||
    payload === undefined ||
    typeof deduplicationKey !== 'string' ||
    typeof maxAttempts !== 'number'
  ) return undefined;

  try {
    const parsed = parseFinancialJobIdentity({
      type,
      payload,
      deduplicationKey,
      maxAttempts
    });
    if (
      parsed.type !== FINANCIAL_CLASSIFICATION_JOB ||
      parsed.maxAttempts !== FINANCIAL_CLASSIFICATION_JOB_MAX_ATTEMPTS ||
      !exactPayloadMatches(payload, parsed.payload)
    ) return undefined;
    Object.freeze(parsed.payload);
    return Object.freeze(parsed);
  } catch {
    return undefined;
  }
}

function authorityMatches(
  authority: FinancialProjectionAuthority,
  payload: FinancialClassificationSubjectJobPayload
): boolean {
  if (payload.scanRunId === undefined) {
    return authority.pendingClassifierVersion === null &&
      authority.pendingAllocationAlgorithmVersion === null &&
      authority.pendingReplayId === null &&
      authority.pendingScanRunId === null &&
      payload.classifierVersion === authority.classifierVersion &&
      payload.allocationAlgorithmVersion === authority.allocationAlgorithmVersion &&
      payload.replayId ===
        `c${authority.classifierVersion}-a${authority.allocationAlgorithmVersion}`;
  }
  return payload.classifierVersion === authority.pendingClassifierVersion &&
    payload.allocationAlgorithmVersion === authority.pendingAllocationAlgorithmVersion &&
    payload.replayId === authority.pendingReplayId &&
    payload.scanRunId === authority.pendingScanRunId;
}

function scanMatches(
  scan: ScanRow,
  payload: FinancialClassificationSubjectJobPayload
): boolean {
  return ownDataValue(scan, 'id') === payload.scanRunId &&
    ownDataValue(scan, 'rootKey') ===
      `commerce.financial-classification:scan:${payload.classifierVersion}:` +
        `${payload.allocationAlgorithmVersion}` &&
    ownDataValue(scan, 'kind') === 'classification_replay' &&
    (ownDataValue(scan, 'phase') === 'classification_replay_page' ||
      ownDataValue(scan, 'phase') === 'classification_replay_finalize') &&
    ownDataValue(scan, 'state') === 'running' &&
    ownDataValue(scan, 'classifierVersion') === payload.classifierVersion &&
    ownDataValue(scan, 'allocationAlgorithmVersion') ===
      payload.allocationAlgorithmVersion &&
    ownDataValue(scan, 'replayId') === payload.replayId &&
    ownDataValue(scan, 'completedAt') === null;
}

function returnedPayloadMatches(
  value: unknown,
  expected: FinancialClassificationSubjectJobPayload
): boolean {
  const payload = exactPayloadCopy(value);
  return payload !== undefined && exactPayloadMatches(payload, expected);
}

function sameDate(left: unknown, right: unknown): boolean {
  return left instanceof Date && right instanceof Date &&
    Number.isFinite(left.getTime()) && left.getTime() === right.getTime();
}

function returnedJobMatches(
  row: unknown,
  target: JobRetryPolicyTarget,
  spec: FinancialClassificationJobSpec
): boolean {
  const runAt = ownDataValue(row, 'runAt');
  const updatedAt = ownDataValue(row, 'updatedAt');
  return ownDataValue(row, 'id') === target.targetJobId &&
    ownDataValue(row, 'type') === spec.type &&
    returnedPayloadMatches(ownDataValue(row, 'payload'), spec.payload) &&
    ownDataValue(row, 'deduplicationKey') === spec.deduplicationKey &&
    ownDataValue(row, 'status') === 'pending' &&
    ownDataValue(row, 'attempts') === 0 &&
    ownDataValue(row, 'maxAttempts') === FINANCIAL_CLASSIFICATION_JOB_MAX_ATTEMPTS &&
    sameDate(runAt, updatedAt) &&
    ownDataValue(row, 'lockedAt') === null &&
    ownDataValue(row, 'lockedBy') === null &&
    ownDataValue(row, 'lastError') === null &&
    ownDataValue(row, 'rerunRequestedAt') === null &&
    ownDataValue(row, 'completedAt') === null;
}

function postconditionMatches(
  row: RearmPostconditionRow,
  target: JobRetryPolicyTarget,
  rearmed: unknown
): boolean {
  const timestamp = ownDataValue(row, 'transactionTimestamp');
  const returnedRunAt = ownDataValue(rearmed, 'runAt');
  return ownDataValue(row, 'id') === target.targetJobId &&
    typeof timestamp === 'string' && TIMESTAMP_PATTERN.test(timestamp) &&
    returnedRunAt instanceof Date &&
    returnedRunAt.getTime() === new Date(timestamp).getTime() &&
    ownDataValue(row, 'runAt') === timestamp &&
    ownDataValue(row, 'updatedAt') === timestamp;
}

export function createFinancialClassificationJobRetryPolicyAdapter(): JobRetryPolicyAdapter {
  return async ({ transaction, target }): Promise<JobRetryPolicyOutcome> => {
    if (!validTarget(target)) return RETRY_COMMAND_INVALID;

    const authority = await lockFinancialProjectionAuthority(transaction);
    await lockFinancialProjectionEnrollment(transaction);

    const targetResult = await transaction.execute<LockedJobRow>(sql`
      select queued_job.id::text as "id",
        queued_job.type as "type",
        queued_job.payload as "payload",
        queued_job.deduplication_key as "deduplicationKey",
        queued_job.status::text as "status",
        queued_job.attempts as "attempts",
        queued_job.max_attempts as "maxAttempts",
        pg_catalog.to_char(
          queued_job.updated_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "updatedAt"
      from "public"."jobs" queued_job
      where queued_job.id = ${target.targetJobId}::uuid
      for update
    `);
    if (targetResult.rows.length === 0) return TARGET_STATE_CHANGED;
    const job = exactSingleRow(targetResult.rows);
    if (job === undefined || ownDataValue(job, 'id') !== target.targetJobId) {
      return RETRY_COMMAND_INVALID;
    }
    if (submittedSnapshotChanged(target, job)) return TARGET_STATE_CHANGED;

    const spec = parseExactSpec(job);
    if (spec === undefined) return RETRY_COMMAND_INVALID;
    if (
      ownDataValue(job, 'status') !== 'failed' ||
      typeof ownDataValue(job, 'attempts') !== 'number' ||
      (ownDataValue(job, 'attempts') as number) <
        FINANCIAL_CLASSIFICATION_JOB_MAX_ATTEMPTS
    ) return DOMAIN_STATE_NOT_RETRYABLE;
    if (!authorityMatches(authority, spec.payload)) return DOMAIN_STATE_NOT_RETRYABLE;

    if (spec.payload.scanRunId !== undefined) {
      const scanResult = await transaction.execute<ScanRow>(sql`
        select scan.id::text as "id",
          scan.root_key as "rootKey",
          scan.kind as "kind",
          scan.phase as "phase",
          scan.state::text as "state",
          scan.classifier_version as "classifierVersion",
          scan.allocation_algorithm_version as "allocationAlgorithmVersion",
          scan.replay_id as "replayId",
          scan.completed_at as "completedAt"
        from financial_scan_runs scan
        where scan.id = ${spec.payload.scanRunId}::uuid
        limit 1
      `);
      const scan = exactSingleRow(scanResult.rows);
      if (scan === undefined || !scanMatches(scan, spec.payload)) {
        return DOMAIN_STATE_NOT_RETRYABLE;
      }
    }

    const sourceResult = spec.payload.subjectType === 'balance_transaction'
      ? await transaction.execute<SourceRow>(sql`
          select balance.id::text as "id",
            balance.fingerprint_sha256 as "sourceFingerprintSha256"
          from stripe_balance_transactions balance
          where balance.id = ${spec.payload.subjectId}::uuid
          limit 1
        `)
      : await transaction.execute<SourceRow>(sql`
          select detail.id::text as "id",
            detail.fingerprint_sha256 as "sourceFingerprintSha256",
            balance.id::text as "balanceTransactionId"
          from stripe_balance_transaction_fee_details detail
          join stripe_balance_transactions balance
            on balance.id = detail.balance_transaction_id
          where detail.id = ${spec.payload.subjectId}::uuid
          limit 1
        `);
    if (sourceResult.rows.length === 0) return SOURCE_UNAVAILABLE;
    const source = exactSingleRow(sourceResult.rows);
    if (source === undefined || ownDataValue(source, 'id') !== spec.payload.subjectId) {
      return RETRY_COMMAND_INVALID;
    }
    if (
      ownDataValue(source, 'sourceFingerprintSha256') !==
        spec.payload.sourceFingerprintSha256
    ) return DOMAIN_STATE_NOT_RETRYABLE;

    const rearmed = await rearmFinancialClassificationJob(transaction, spec);
    if (!returnedJobMatches(rearmed, target, spec)) return impossibleIdentity();

    const postconditionResult = await transaction.execute<RearmPostconditionRow>(sql`
      select queued_job.id::text as "id",
        pg_catalog.to_char(
          queued_job.run_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "runAt",
        pg_catalog.to_char(
          queued_job.updated_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "updatedAt",
        pg_catalog.to_char(
          pg_catalog.transaction_timestamp() at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "transactionTimestamp"
      from "public"."jobs" queued_job
      where queued_job.id = ${target.targetJobId}::uuid
      limit 1
    `);
    const postcondition = exactSingleRow(postconditionResult.rows);
    if (
      postcondition === undefined ||
      !postconditionMatches(postcondition, target, rearmed)
    ) {
      return impossibleIdentity();
    }
    return REARMED;
  };
}
