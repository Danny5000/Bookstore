import {
  AuthorizationError,
  requireCapability,
  type Actor,
  type CapabilityResolver
} from '$lib/server/auth/admin-policy';
import { auditJobRetryRequestDenied } from './audit';
import {
  JobOperationsInputError,
  parseCanonicalOperationsUuid,
  parseOperationalJobListInput,
  prepareJobRetryCommand,
  type JobRetryCommandStatusDto,
  type OperationalJobDto
} from './contracts';
import {
  JobOperationsAuthorizationChangedError,
  JobRetryCommandSubmissionConflictError,
  createPostgresJobOperationsRepository,
  type JobOperationsRepository
} from './repository';

type Database = Parameters<typeof createPostgresJobOperationsRepository>[0];
type CorrelationId = Parameters<typeof auditJobRetryRequestDenied>[2];

export interface JobRetryRequestContext {
  readonly correlationId: CorrelationId;
}

export interface JobOperationsServiceDependencies {
  readonly repository?: JobOperationsRepository;
  readonly capabilityResolver?: CapabilityResolver;
  readonly auditDenied?: typeof auditJobRetryRequestDenied;
}

export class JobOperationsAuditError extends Error {
  constructor() {
    super('The job operations audit could not be recorded.');
    this.name = 'JobOperationsAuditError';
  }
}

function invalidInput(): never {
  throw new JobOperationsInputError();
}

function parseRequestContext(value: JobRetryRequestContext): JobRetryRequestContext {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidInput();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidInput();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 1 || keys[0] !== 'correlationId') return invalidInput();
    const entry = Object.getOwnPropertyDescriptor(descriptors, 'correlationId')?.value;
    if (entry === null || typeof entry !== 'object' || !Object.hasOwn(entry, 'value') ||
      entry.enumerable !== true || typeof entry.value !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(entry.value)) return invalidInput();
    return Object.freeze({ correlationId: entry.value as CorrelationId });
  } catch {
    return invalidInput();
  }
}

async function recordDenial(
  database: Database,
  actor: Actor,
  correlationId: CorrelationId,
  auditDenied: typeof auditJobRetryRequestDenied
): Promise<void> {
  try {
    await auditDenied(database, actor, correlationId);
  } catch {
    throw new JobOperationsAuditError();
  }
}

function repositoryFor(
  database: Database,
  dependencies: JobOperationsServiceDependencies
): JobOperationsRepository {
  return dependencies.repository ?? createPostgresJobOperationsRepository(database);
}

function fixedForbidden(): AuthorizationError {
  return new AuthorizationError('forbidden', 403);
}

export async function listOperationalJobs(
  database: Database,
  actor: Actor,
  input: unknown = {},
  dependencies: JobOperationsServiceDependencies = {}
): Promise<readonly OperationalJobDto[]> {
  requireCapability(actor, 'jobs.retry', dependencies.capabilityResolver);
  const actorId = parseCanonicalOperationsUuid(actor.id);
  const parsedInput = parseOperationalJobListInput(input);
  try {
    return await repositoryFor(database, dependencies).listOperationalJobs({
      actorId,
      ...parsedInput
    });
  } catch (error) {
    if (error instanceof JobOperationsAuthorizationChangedError) throw fixedForbidden();
    throw error;
  }
}

export async function submitJobRetryCommand(
  database: Database,
  actor: Actor,
  input: unknown,
  context: JobRetryRequestContext,
  dependencies: JobOperationsServiceDependencies = {}
): Promise<JobRetryCommandStatusDto> {
  const auditDenied = dependencies.auditDenied ?? auditJobRetryRequestDenied;
  try {
    requireCapability(actor, 'jobs.retry', dependencies.capabilityResolver);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    const parsedContext = parseRequestContext(context);
    await recordDenial(database, actor, parsedContext.correlationId, auditDenied);
    throw error;
  }

  const parsedContext = parseRequestContext(context);
  let actorId: string;
  let prepared: ReturnType<typeof prepareJobRetryCommand>;
  try {
    actorId = parseCanonicalOperationsUuid(actor.id);
    prepared = prepareJobRetryCommand(input);
  } catch (error) {
    if (!(error instanceof JobOperationsInputError)) throw error;
    await recordDenial(database, actor, parsedContext.correlationId, auditDenied);
    throw error;
  }

  try {
    return await repositoryFor(database, dependencies).submitJobRetryCommand({
      actorId,
      command: prepared.command,
      correlationId: parsedContext.correlationId,
      idempotencyKeySha256: prepared.idempotencyKeySha256,
      inputFingerprintSha256: prepared.inputFingerprintSha256
    });
  } catch (error) {
    if (error instanceof JobRetryCommandSubmissionConflictError) {
      await recordDenial(database, actor, parsedContext.correlationId, auditDenied);
      throw error;
    }
    if (error instanceof JobOperationsAuthorizationChangedError) {
      await recordDenial(database, actor, parsedContext.correlationId, auditDenied);
      throw fixedForbidden();
    }
    throw error;
  }
}

export async function getOwnedJobRetryCommand(
  database: Database,
  actor: Actor,
  commandId: unknown,
  dependencies: JobOperationsServiceDependencies = {}
): Promise<JobRetryCommandStatusDto | null> {
  requireCapability(actor, 'jobs.retry', dependencies.capabilityResolver);
  const actorId = parseCanonicalOperationsUuid(actor.id);
  const parsedCommandId = parseCanonicalOperationsUuid(commandId);
  try {
    return await repositoryFor(database, dependencies).getOwnedJobRetryCommand({
      actorId,
      commandId: parsedCommandId
    });
  } catch (error) {
    if (error instanceof JobOperationsAuthorizationChangedError) throw fixedForbidden();
    throw error;
  }
}
