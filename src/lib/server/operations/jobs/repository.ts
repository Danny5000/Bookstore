import { isProxy } from 'node:util/types';
import { DrizzleQueryError, sql, type SQL } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import type { CorrelationId } from '$lib/server/observability/contracts';
import {
  parseJobRetryCommandStatusDto,
  parseOperationalJobDto,
  type JobRetryCommandInput,
  type JobRetryCommandStatusDto,
  type OperationalJobDto,
  type OperationalJobListInput
} from './contracts';

export interface SubmitJobRetryCommandRepositoryInput {
  readonly actorId: string;
  readonly command: JobRetryCommandInput;
  readonly correlationId: CorrelationId;
  readonly idempotencyKeySha256: string;
  readonly inputFingerprintSha256: string;
}

export interface JobOperationsRepository {
  listOperationalJobs(
    input: OperationalJobListInput & { readonly actorId: string }
  ): Promise<readonly OperationalJobDto[]>;

  submitJobRetryCommand(
    input: SubmitJobRetryCommandRepositoryInput
  ): Promise<JobRetryCommandStatusDto>;

  getOwnedJobRetryCommand(input: {
    readonly actorId: string;
    readonly commandId: string;
  }): Promise<JobRetryCommandStatusDto | null>;
}

class JobOperationsRepositoryError extends Error {
  constructor() {
    super('Job operations repository returned invalid data.');
    this.name = 'JobOperationsRepositoryError';
  }
}

export class JobRetryCommandSubmissionConflictError extends Error {
  readonly code = 'conflict' as const;

  constructor() {
    super('The job retry command conflicts with current state.');
    this.name = 'JobRetryCommandSubmissionConflictError';
  }
}

export class JobOperationsAuthorizationChangedError extends Error {
  readonly code = 'authorization_changed' as const;

  constructor() {
    super('Job operations authorization is no longer current.');
    this.name = 'JobOperationsAuthorizationChangedError';
  }
}

function invalidRepositoryData(): never {
  throw new JobOperationsRepositoryError();
}

function queryRows(result: unknown, maximumRows: number): readonly unknown[] {
  if (result === null || typeof result !== 'object' || isProxy(result)) {
    return invalidRepositoryData();
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(result, 'rows');
  } catch {
    return invalidRepositoryData();
  }
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
    !Array.isArray(descriptor.value) || isProxy(descriptor.value)) {
    return invalidRepositoryData();
  }
  const source = descriptor.value as readonly unknown[];
  if (source.length > maximumRows) return invalidRepositoryData();
  const rows: unknown[] = [];
  for (let index = 0; index < source.length; index += 1) {
    let rowDescriptor: PropertyDescriptor | undefined;
    try {
      rowDescriptor = Object.getOwnPropertyDescriptor(source, String(index));
    } catch {
      return invalidRepositoryData();
    }
    if (rowDescriptor === undefined || !Object.hasOwn(rowDescriptor, 'value')) {
      return invalidRepositoryData();
    }
    rows.push(rowDescriptor.value);
  }
  return Object.freeze(rows);
}

function parseJob(row: unknown): OperationalJobDto {
  try {
    return parseOperationalJobDto(row);
  } catch {
    return invalidRepositoryData();
  }
}

function parseStatus(row: unknown): JobRetryCommandStatusDto {
  try {
    return parseJobRetryCommandStatusDto(row);
  } catch {
    return invalidRepositoryData();
  }
}

function ownDataValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || isProxy(value)) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function ownDataCode(error: unknown): unknown {
  return ownDataValue(error, 'code');
}

function drizzleQueryCause(error: unknown): unknown {
  if (error === null || typeof error !== 'object' || isProxy(error)) return undefined;
  try {
    if (Object.getPrototypeOf(error) !== DrizzleQueryError.prototype) return undefined;
  } catch {
    return undefined;
  }
  return ownDataValue(error, 'cause');
}

function databaseErrorCode(error: unknown): unknown {
  const directCode = ownDataCode(error);
  return directCode === undefined
    ? ownDataCode(drizzleQueryCause(error))
    : directCode;
}

async function executeRoutine(
  database: Database,
  query: SQL,
  translateConflict: boolean
): Promise<unknown> {
  try {
    return await database.execute(query);
  } catch (error) {
    const code = databaseErrorCode(error);
    if (code === '42501') throw new JobOperationsAuthorizationChangedError();
    if (translateConflict && code === '40900') {
      throw new JobRetryCommandSubmissionConflictError();
    }
    throw error;
  }
}

const STATUS_COLUMNS = sql`
  command_id as "commandId", kind, target_job_id as "targetJobId",
  target_kind as "targetKind", reason_code as "reasonCode",
  correlation_id as "correlationId", status, result_code as "resultCode",
  created_at as "createdAt", updated_at as "updatedAt",
  completed_at as "completedAt"
`;

export function createPostgresJobOperationsRepository(
  database: Database
): JobOperationsRepository {
  return {
    async listOperationalJobs(input) {
      const result = await executeRoutine(database, sql`
        select job_id as "jobId", kind, label, status, attempts,
          max_attempts as "maxAttempts", run_at as "runAt",
          completed_at as "completedAt", created_at as "createdAt",
          updated_at as "updatedAt", retry_disposition as "retryDisposition",
          policy_availability as "policyAvailability",
          safe_failure_code as "safeFailureCode"
        from public.list_operational_jobs(
          ${input.actorId}, ${input.status ?? null}, ${input.kind ?? null},
          ${input.cursor?.updatedAt ?? null}::timestamptz,
          ${input.cursor?.jobId ?? null}, ${input.limit}
        )
      `, false);
      const rows = queryRows(result, input.limit);
      const jobs: OperationalJobDto[] = [];
      for (const row of rows) jobs.push(parseJob(row));
      return Object.freeze(jobs);
    },

    async submitJobRetryCommand(input) {
      const result = await executeRoutine(database, sql`
        select ${STATUS_COLUMNS}
        from public.submit_job_retry_command(
          ${input.actorId}, ${input.command.targetJobId}, ${input.command.expectedKind},
          ${input.command.expectedAttempts}, ${input.command.expectedMaxAttempts},
          ${input.command.expectedUpdatedAt}::timestamptz, ${input.command.reasonCode},
          ${input.correlationId}, ${input.idempotencyKeySha256},
          ${input.inputFingerprintSha256}
        )
      `, true);
      const rows = queryRows(result, 1);
      if (rows.length !== 1) return invalidRepositoryData();
      return parseStatus(rows[0]);
    },

    async getOwnedJobRetryCommand(input) {
      const result = await executeRoutine(database, sql`
        select ${STATUS_COLUMNS}
        from public.get_owned_job_retry_command(${input.actorId}, ${input.commandId})
      `, false);
      const rows = queryRows(result, 1);
      if (rows.length === 0) return null;
      if (rows.length !== 1) return invalidRepositoryData();
      return parseStatus(rows[0]);
    }
  };
}
