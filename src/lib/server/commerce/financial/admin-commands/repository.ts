import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  FINANCIAL_ADMIN_COMMAND_CAPABILITIES,
  requireCapability,
  requireFinancialCommandSubmissionCapabilities,
  type Actor,
  type AdministratorActor,
  type FinancialAuthorizationDependencies
} from '$lib/server/auth/admin-policy';
import { listRolesForUser } from '$lib/server/auth/identity';
import type { Database } from '$lib/server/db/client';
import { withTransaction } from '$lib/server/db/transaction';
import type { FinancialRequestContext } from '$lib/server/commerce/reporting/context';
import {
  FINANCIAL_ADMIN_COMMAND_KINDS,
  FINANCIAL_ADMIN_COMMAND_STATUSES,
  parseFinancialAdminCommandStatus,
  type FinancialAdminCommandKind,
  type FinancialAdminCommandReferenceDto,
  type FinancialAdminCommandStatusDto
} from '$lib/types/financial-reporting';
import {
  parseFinancialAdminPrivateCommand,
  type FinancialAdminPrivateCommand
} from './contracts';

const canonicalUuidSchema = z.uuid().refine((value) => value === value.toLowerCase());
const correlationIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u);
const commandKindSchema = z.enum(FINANCIAL_ADMIN_COMMAND_KINDS);
const commandStatusSchema = z.enum(FINANCIAL_ADMIN_COMMAND_STATUSES);
const postgresTimestampPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/u;

function timestampDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  let normalized = value.replace(' ', 'T');
  normalized = normalized.replace(/([+-][0-9]{2})$/u, '$1:00');
  normalized = normalized.replace(/([+-][0-9]{2})([0-9]{2})$/u, '$1:$2');
  return new Date(normalized);
}

const databaseTimestampSchema = z
  .union([
    z.date(),
    z.string().regex(postgresTimestampPattern)
  ])
  .refine((value) => Number.isFinite(timestampDate(value).getTime()))
  .transform((value) => timestampDate(value).toISOString());

const referenceRowSchema = z.strictObject({
  commandId: canonicalUuidSchema,
  kind: commandKindSchema,
  status: commandStatusSchema,
  createdAt: databaseTimestampSchema
});

const statusRowSchema = z.strictObject({
  commandId: canonicalUuidSchema,
  kind: commandKindSchema,
  status: commandStatusSchema,
  resultCode: z.string().nullable(),
  result: z.unknown(),
  createdAt: databaseTimestampSchema,
  updatedAt: databaseTimestampSchema,
  completedAt: databaseTimestampSchema.nullable()
});

type QueryResult = { readonly rows?: readonly unknown[] };

export interface SubmitFinancialAdminCommandInput {
  readonly actor: AdministratorActor;
  readonly idempotencyKey: string;
  readonly command: FinancialAdminPrivateCommand;
  readonly context: FinancialRequestContext;
}

class FinancialAdminCommandRepositoryError extends Error {
  constructor() {
    super('Financial administrator command repository returned invalid data.');
    this.name = 'FinancialAdminCommandRepositoryError';
  }
}

export class FinancialAdminCommandSubmissionConflictError extends Error {
  readonly code = 'stale_state' as const;

  constructor() {
    super('The financial administrator command conflicts with an existing submission.');
    this.name = 'FinancialAdminCommandSubmissionConflictError';
  }
}

function isSubmissionConflict(error: unknown): boolean {
  try {
    return error instanceof Error &&
      (error as Error & { readonly code?: unknown }).code === '40900';
  } catch {
    return false;
  }
}

function invalidRepositoryData(): never {
  throw new FinancialAdminCommandRepositoryError();
}

function queryRows(result: unknown): readonly unknown[] {
  if (!result || typeof result !== 'object') {
    return invalidRepositoryData();
  }
  const rows = (result as QueryResult).rows;
  if (!Array.isArray(rows)) {
    return invalidRepositoryData();
  }
  return rows;
}

function parseProtectedRow<T>(schema: z.ZodType<T>, row: unknown): T {
  const parsed = schema.safeParse(row);
  if (!parsed.success) return invalidRepositoryData();
  return parsed.data;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function commandKind(value: FinancialAdminPrivateCommand): FinancialAdminCommandKind {
  const kind = value.kind;
  if (!Object.hasOwn(FINANCIAL_ADMIN_COMMAND_CAPABILITIES, kind)) {
    throw new Error('Invalid financial administrator command kind');
  }
  return kind;
}

async function acquireAdministratorRoleLock(transaction: Parameters<Parameters<Database['transaction']>[0]>[0]): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
  );
}

export async function submitFinancialAdminCommand(
  database: Database,
  input: SubmitFinancialAdminCommandInput,
  dependencies: FinancialAuthorizationDependencies = {}
): Promise<FinancialAdminCommandReferenceDto> {
  const idempotencyKey = canonicalUuidSchema.parse(input.idempotencyKey);
  const kind = commandKind(input.command);

  // This check intentionally precedes private-command canonicalization and hashing.
  requireFinancialCommandSubmissionCapabilities(input.actor, kind, dependencies);

  const actorId = canonicalUuidSchema.parse(input.actor.id);
  const correlationId = correlationIdSchema.parse(input.context.correlationId);
  const command = parseFinancialAdminPrivateCommand(input.command);
  const canonicalCommand = JSON.stringify(command);
  const idempotencyKeySha256 = sha256(idempotencyKey);
  const inputFingerprintSha256 = sha256(canonicalCommand);

  return withTransaction(database, async (transaction) => {
    await acquireAdministratorRoleLock(transaction);
    const authorizedActor: AdministratorActor = {
      type: 'user',
      id: actorId,
      roles: await listRolesForUser(transaction, actorId)
    };
    requireFinancialCommandSubmissionCapabilities(authorizedActor, kind, dependencies);

    let result: unknown;
    try {
      result = await transaction.execute(sql`
        select command_id as "commandId", command_kind as kind,
          command_status as status, created_at as "createdAt"
        from public.submit_financial_admin_command(
          ${actorId}, ${correlationId}, ${kind}, ${idempotencyKeySha256},
          ${inputFingerprintSha256}, ${canonicalCommand}::jsonb
        )
      `);
    } catch (error) {
      if (isSubmissionConflict(error)) {
        throw new FinancialAdminCommandSubmissionConflictError();
      }
      throw error;
    }
    const rows = queryRows(result);
    if (rows.length !== 1) return invalidRepositoryData();
    return parseProtectedRow(referenceRowSchema, rows[0]) as FinancialAdminCommandReferenceDto;
  });
}

export async function getFinancialAdminCommandStatus(
  database: Database,
  actor: Actor,
  commandId: string,
  dependencies: FinancialAuthorizationDependencies = {}
): Promise<FinancialAdminCommandStatusDto | null> {
  // The private kind is not available before the protected routine call.
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  const parsedCommandId = canonicalUuidSchema.parse(commandId);
  const actorId = canonicalUuidSchema.parse(actor.id);

  return withTransaction(database, async (transaction) => {
    await acquireAdministratorRoleLock(transaction);
    const authorizedActor: AdministratorActor = {
      type: 'user',
      id: actorId,
      roles: await listRolesForUser(transaction, actorId)
    };
    requireCapability(authorizedActor, 'sales.read', dependencies.capabilityResolver);

    const result = await transaction.execute(sql`
      select command_id as "commandId", command_kind as kind,
        command_status as status, safe_result_code as "resultCode",
        safe_result as result, created_at as "createdAt", updated_at as "updatedAt",
        completed_at as "completedAt"
      from public.financial_admin_command_status(${actorId}, ${parsedCommandId})
    `);
    const rows = queryRows(result);
    if (rows.length === 0) return null;
    if (rows.length !== 1) return invalidRepositoryData();
    const statusRow = parseProtectedRow(statusRowSchema, rows[0]);
    try {
      return parseFinancialAdminCommandStatus(statusRow);
    } catch {
      return invalidRepositoryData();
    }
  });
}
