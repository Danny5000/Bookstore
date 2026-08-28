import { isProxy } from 'node:util/types';
import { sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../db/client';
import { withTransaction, type DatabaseTransaction } from '../../db/transaction';
import {
  definitionForJobKind,
  isJobRetryPolicyOutcomeAllowed,
  isRegisteredJobKind,
  JOB_RETRY_POLICY_IDS,
  OPERATIONS_JOB_RETRY_COMMAND_JOB,
  OPERATIONS_JOB_RETRY_COMMAND_MAX_ATTEMPTS,
  type JobDefinition,
  type JobRetryCommandResultCode,
  type JobRetryCommandStatus
} from '../../jobs/catalog';
import {
  DefiniteRetryableJobError,
  PermanentJobError
} from '../../jobs/runner';
import type { JobHandler, JobRecord } from '../../jobs/types';
import {
  isCorrelationId,
  isPositiveSignedInt32,
  isWorkerId
} from '../../observability/contracts';
import type {
  JobRetryDenialResultCode,
  JobRetryFailureResultCode,
  JobRetryReasonCode
} from './contracts';
import {
  InvalidJobRetryPolicyIdentityError,
  validateJobRetryPolicyOutcome,
  type JobRetryPolicyAdapter,
  type JobRetryPolicyAdapterId,
  type JobRetryPolicyOutcome,
  type JobRetryPolicyTarget
} from './policies';

export interface OperationsJobRetryHandlerDependencies {
  readonly database: Database;
  readonly policies: ReadonlyMap<
    JobRetryPolicyAdapterId,
    JobRetryPolicyAdapter
  >;
}

interface JobIdentity {
  readonly jobId: string;
  readonly commandId: string;
  readonly leaseOwner: string;
  readonly attempt: number;
  readonly generation: number;
  readonly capability: string;
}

interface LockedCommand {
  readonly status: 'pending' | JobRetryCommandStatus;
  readonly actorAuthorized: boolean;
  readonly definition: JobDefinition;
  readonly target: JobRetryPolicyTarget;
}

type TerminalOutcome = Readonly<{
  status: JobRetryCommandStatus;
  resultCode: JobRetryCommandResultCode;
}>;

type DataRecord = Readonly<Record<string, unknown>>;
type QueryResult = Readonly<{ rows?: readonly unknown[] }>;

const STARTUP_ERROR =
  'Operations job retry policies do not exactly match the registered policy catalog';
const INVALID_IDENTITY = 'Invalid operations job retry command identity.';
const UNKNOWN_OUTCOME = 'Operations job execution outcome is unknown';
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LEASE_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CANONICAL_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})[.](\d{6})Z$/u;
const PAYLOAD_KEYS = Object.freeze(['commandId'] as const);
const LOCK_KEYS = Object.freeze([
  'commandId',
  'commandStatus',
  'resultCode',
  'actorAuthorized',
  'actorUserId',
  'targetJobId',
  'targetJobKind',
  'expectedStatus',
  'expectedAttempts',
  'expectedMaxAttempts',
  'expectedUpdatedAt',
  'reasonCode',
  'correlationId'
] as const);
const TRANSITION_KEYS = Object.freeze([
  'commandId',
  'commandStatus',
  'resultCode',
  'completedAt'
] as const);
const REASON_CODES = Object.freeze([
  'dependency_recovered',
  'configuration_recovered',
  'operator_reassessment'
] as const satisfies readonly JobRetryReasonCode[]);
const COMMON_FAILURE_RESULTS = Object.freeze([
  'retry_command_invalid',
  'retry_command_exhausted',
  'unexpected_failure'
] as const satisfies readonly JobRetryFailureResultCode[]);

function invalidPolicyIdentity(): never {
  throw new InvalidJobRetryPolicyIdentityError();
}

function invalidJobIdentity(): never {
  throw new PermanentJobError(INVALID_IDENTITY);
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[]
): DataRecord {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      isProxy(value) ||
      Array.isArray(value)
    ) return invalidPolicyIdentity();

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidPolicyIdentity();
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) return invalidPolicyIdentity();

    const record: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true
      ) return invalidPolicyIdentity();
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return invalidPolicyIdentity();
  }
}

function queryRows(result: unknown): readonly unknown[] {
  try {
    if (result === null || typeof result !== 'object' || isProxy(result)) {
      return invalidPolicyIdentity();
    }
    const descriptor = Object.getOwnPropertyDescriptor(result, 'rows');
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      !Array.isArray(descriptor.value) ||
      isProxy(descriptor.value)
    ) return invalidPolicyIdentity();

    const rows = descriptor.value as readonly unknown[];
    if (rows.length !== 1) return invalidPolicyIdentity();
    const row = Object.getOwnPropertyDescriptor(rows, '0');
    if (row === undefined || !Object.hasOwn(row, 'value')) {
      return invalidPolicyIdentity();
    }
    return Object.freeze([row.value]);
  } catch {
    return invalidPolicyIdentity();
  }
}

async function executeRows(
  transaction: DatabaseTransaction,
  query: SQL
): Promise<readonly unknown[]> {
  return queryRows(await transaction.execute(query) as QueryResult);
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') return invalidPolicyIdentity();
  const match = CANONICAL_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return invalidPolicyIdentity();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) return invalidPolicyIdentity();
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [
    31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31
  ];
  if (day < 1 || day > daysByMonth[month - 1]!) return invalidPolicyIdentity();
  return value;
}

function terminalResultAllowed(
  definition: JobDefinition,
  status: JobRetryCommandStatus,
  resultCode: unknown
): resultCode is JobRetryCommandResultCode {
  if (typeof resultCode !== 'string') return false;
  if (status === 'denied' && resultCode === 'actor_not_authorized') return true;
  if (
    status === 'failed' &&
    COMMON_FAILURE_RESULTS.includes(resultCode as JobRetryFailureResultCode)
  ) return true;
  return isJobRetryPolicyOutcomeAllowed(
    definition.retryPolicyId,
    status,
    resultCode
  );
}

function parseLockedCommand(row: unknown, identity: JobIdentity): LockedCommand {
  const record = exactDataRecord(row, LOCK_KEYS);
  const kind = record.targetJobKind;
  const definition = definitionForJobKind(kind);
  if (
    record.commandId !== identity.commandId ||
    typeof record.commandId !== 'string' ||
    !CANONICAL_UUID_PATTERN.test(record.commandId) ||
    typeof record.actorAuthorized !== 'boolean' ||
    typeof record.actorUserId !== 'string' ||
    !CANONICAL_UUID_PATTERN.test(record.actorUserId) ||
    typeof record.targetJobId !== 'string' ||
    !CANONICAL_UUID_PATTERN.test(record.targetJobId) ||
    !isRegisteredJobKind(kind) ||
    definition === undefined ||
    record.expectedStatus !== 'failed' ||
    !isPositiveSignedInt32(record.expectedAttempts) ||
    !isPositiveSignedInt32(record.expectedMaxAttempts) ||
    record.expectedAttempts > record.expectedMaxAttempts ||
    record.expectedMaxAttempts !== definition.maxAttempts ||
    !REASON_CODES.includes(record.reasonCode as JobRetryReasonCode) ||
    !isCorrelationId(record.correlationId)
  ) return invalidPolicyIdentity();

  const expectedUpdatedAt = canonicalTimestamp(record.expectedUpdatedAt);
  const status = record.commandStatus;
  if (
    status !== 'pending' &&
    status !== 'succeeded' &&
    status !== 'denied' &&
    status !== 'failed'
  ) return invalidPolicyIdentity();
  if (status === 'pending') {
    if (record.resultCode !== null) return invalidPolicyIdentity();
  } else if (!terminalResultAllowed(definition, status, record.resultCode)) {
    return invalidPolicyIdentity();
  }

  return Object.freeze({
    status,
    actorAuthorized: record.actorAuthorized,
    definition,
    target: Object.freeze({
      commandId: identity.commandId,
      targetJobId: record.targetJobId,
      expectedKind: kind,
      expectedStatus: 'failed',
      expectedAttempts: record.expectedAttempts,
      expectedMaxAttempts: record.expectedMaxAttempts,
      expectedUpdatedAt
    })
  });
}

function parseTransition(
  row: unknown,
  identity: JobIdentity,
  expected: TerminalOutcome
): void {
  const record = exactDataRecord(row, TRANSITION_KEYS);
  if (
    record.commandId !== identity.commandId ||
    record.commandStatus !== expected.status ||
    record.resultCode !== expected.resultCode
  ) return invalidPolicyIdentity();
  canonicalTimestamp(record.completedAt);
}

function ownEnumerableDataValue(record: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.enumerable !== true
  ) return invalidPolicyIdentity();
  return descriptor.value;
}

function parseJobIdentity(job: JobRecord): JobIdentity {
  try {
    if (
      job === null ||
      typeof job !== 'object' ||
      isProxy(job) ||
      Array.isArray(job)
    ) return invalidJobIdentity();
    const prototype = Object.getPrototypeOf(job);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidJobIdentity();
    }
    if (Object.hasOwn(job, 'financialAdminLeaseCapability')) {
      return invalidJobIdentity();
    }

    const jobId = ownEnumerableDataValue(job, 'id');
    const type = ownEnumerableDataValue(job, 'type');
    const payload = ownEnumerableDataValue(job, 'payload');
    const deduplicationKey = ownEnumerableDataValue(job, 'deduplicationKey');
    const attempt = ownEnumerableDataValue(job, 'attempts');
    const maximum = ownEnumerableDataValue(job, 'maxAttempts');
    const leaseOwner = ownEnumerableDataValue(job, 'lockedBy');
    const capability = ownEnumerableDataValue(job, 'operationsJobLeaseCapability');
    const generation = ownEnumerableDataValue(job, 'operationsJobLeaseGeneration');
    const parsedPayload = exactDataRecord(payload, PAYLOAD_KEYS);
    const commandId = parsedPayload.commandId;

    if (
      type !== OPERATIONS_JOB_RETRY_COMMAND_JOB ||
      typeof jobId !== 'string' ||
      !CANONICAL_UUID_PATTERN.test(jobId) ||
      typeof commandId !== 'string' ||
      !CANONICAL_UUID_PATTERN.test(commandId) ||
      deduplicationKey !== `operations:job-retry-command:${commandId}:v1` ||
      !isPositiveSignedInt32(attempt) ||
      maximum !== OPERATIONS_JOB_RETRY_COMMAND_MAX_ATTEMPTS ||
      attempt > maximum ||
      !isWorkerId(leaseOwner) ||
      typeof capability !== 'string' ||
      !LEASE_CAPABILITY_PATTERN.test(capability) ||
      !isPositiveSignedInt32(generation)
    ) return invalidJobIdentity();

    return Object.freeze({
      jobId,
      commandId,
      leaseOwner,
      attempt,
      generation,
      capability
    });
  } catch (error: unknown) {
    if (error instanceof PermanentJobError) throw error;
    return invalidJobIdentity();
  }
}

function validatedPolicyMap(
  policies: ReadonlyMap<JobRetryPolicyAdapterId, JobRetryPolicyAdapter>
): ReadonlyMap<JobRetryPolicyAdapterId, JobRetryPolicyAdapter> {
  try {
    if (
      policies === null ||
      typeof policies !== 'object' ||
      isProxy(policies) ||
      Object.getPrototypeOf(policies) !== Map.prototype
    ) throw new Error(STARTUP_ERROR);
    const entries = Array.from(
      Map.prototype.entries.call(policies) as IterableIterator<[
        JobRetryPolicyAdapterId,
        JobRetryPolicyAdapter
      ]>
    );
    if (
      entries.length !== JOB_RETRY_POLICY_IDS.length ||
      entries.some(([id, policy], index) =>
        id !== JOB_RETRY_POLICY_IDS[index] ||
        typeof policy !== 'function' ||
        isProxy(policy)
      )
    ) throw new Error(STARTUP_ERROR);
    return new Map(entries);
  } catch {
    throw new Error(STARTUP_ERROR);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DefiniteRetryableJobError();
}

function isHostileProxy(value: unknown): boolean {
  return (
    (typeof value === 'object' && value !== null) ||
    typeof value === 'function'
  ) && isProxy(value);
}

async function lockCommand(
  transaction: DatabaseTransaction,
  identity: JobIdentity
): Promise<LockedCommand> {
  const rows = await executeRows(transaction, sql`
    select locked.command_id as "commandId",
      locked.command_status as "commandStatus",
      locked.result_code as "resultCode",
      locked.actor_authorized as "actorAuthorized",
      locked.actor_user_id as "actorUserId",
      locked.target_job_id as "targetJobId",
      locked.target_job_kind as "targetJobKind",
      locked.expected_status as "expectedStatus",
      locked.expected_attempts as "expectedAttempts",
      locked.expected_max_attempts as "expectedMaxAttempts",
      locked.expected_updated_at as "expectedUpdatedAt",
      locked.reason_code as "reasonCode",
      locked.correlation_id as "correlationId"
    from "public"."plan7a_operations_lock_job_retry_command"(
      ${identity.jobId}::uuid,
      ${identity.commandId}::uuid,
      ${identity.leaseOwner}::text,
      ${identity.attempt}::integer,
      ${identity.generation}::integer
    ) locked
  `);
  return parseLockedCommand(rows[0], identity);
}

async function transitionCommand(
  transaction: DatabaseTransaction,
  identity: JobIdentity,
  outcome: TerminalOutcome
): Promise<void> {
  const rows = await executeRows(transaction, sql`
    select transitioned.command_id as "commandId",
      transitioned.command_status as "commandStatus",
      transitioned.result_code as "resultCode",
      transitioned.completed_at as "completedAt"
    from "public"."plan7a_operations_transition_job_retry_command"(
      ${identity.jobId}::uuid,
      ${identity.commandId}::uuid,
      ${identity.leaseOwner}::text,
      ${identity.attempt}::integer,
      ${identity.generation}::integer,
      ${outcome.resultCode}::"public"."operations_job_retry_result_code"
    ) transitioned
  `);
  parseTransition(rows[0], identity, outcome);
}

async function executeCommandTransaction(
  transaction: DatabaseTransaction,
  identity: JobIdentity,
  policies: ReadonlyMap<JobRetryPolicyAdapterId, JobRetryPolicyAdapter>,
  signal: AbortSignal
): Promise<void> {
  await transaction.execute(sql`
    select pg_catalog.set_config(
      'pale_orbit.plan7a_operations_job_capability',
      ${identity.capability},
      true
    )
  `);
  const command = await lockCommand(transaction, identity);
  if (command.status !== 'pending') return;

  let outcome: JobRetryPolicyOutcome | TerminalOutcome;
  if (!command.actorAuthorized) {
    outcome = Object.freeze({
      status: 'denied',
      resultCode: 'actor_not_authorized'
    } as const satisfies Readonly<{
      status: 'denied';
      resultCode: JobRetryDenialResultCode;
    }>);
  } else {
    const policy = policies.get(command.definition.retryPolicyId);
    if (policy === undefined) return invalidPolicyIdentity();
    throwIfAborted(signal);
    const policyOutcome = validateJobRetryPolicyOutcome(
      command.definition,
      await policy(Object.freeze({
        transaction,
        target: command.target,
        signal
      }))
    );
    if (policyOutcome.status === 'failed') return invalidPolicyIdentity();
    outcome = policyOutcome;
  }

  throwIfAborted(signal);
  await transitionCommand(transaction, identity, outcome);
}

export function createOperationsJobRetryHandler(
  dependencies: OperationsJobRetryHandlerDependencies
): JobHandler {
  const policies = validatedPolicyMap(dependencies.policies);
  const database = dependencies.database;

  return async (job, signal) => {
    const identity = parseJobIdentity(job);
    let callbackCompleted = false;
    try {
      await withTransaction(database, async (transaction) => {
        await executeCommandTransaction(transaction, identity, policies, signal);
        callbackCompleted = true;
      });
    } catch (error: unknown) {
      if (callbackCompleted) {
        // The authority contract deliberately forbids reflecting a commit error as cause.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(UNKNOWN_OUTCOME);
      }
      if (!isHostileProxy(error)) {
        if (
          error instanceof PermanentJobError ||
          error instanceof DefiniteRetryableJobError
        ) throw error;
        if (error instanceof InvalidJobRetryPolicyIdentityError) {
          throw new PermanentJobError(INVALID_IDENTITY);
        }
      }
      throw new DefiniteRetryableJobError();
    }
  };
}
