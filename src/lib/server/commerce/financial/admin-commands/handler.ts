import { isProxy } from "node:util/types";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AuthorizationError,
  requireFinancialCommandExecutionCapabilities,
  type AdministratorActor,
  type CapabilityResolver,
} from "$lib/server/auth/admin-policy";
import { listRolesForUser } from "$lib/server/auth/identity";
import type { Database } from "$lib/server/db/client";
import { financialAdminCommands, type JsonObject } from "$lib/server/db/schema";
import {
  withTransaction,
  type DatabaseTransaction,
} from "$lib/server/db/transaction";
import { PermanentJobError } from "$lib/server/jobs/runner";
import type { JobHandler, JobRecord } from "$lib/server/jobs/types";
import {
  FINANCIAL_ADMIN_COMMAND_KINDS,
  FINANCIAL_ADMIN_COMMAND_STATUSES,
  FINANCIAL_ADMIN_SUCCESS_CODE_BY_KIND,
  parseFinancialAdminCommandStatus,
  type FinancialAdminCommandKind,
  type FinancialAdminCommandSafeResultDto,
  type FinancialAdminCommandStatus,
} from "$lib/types/financial-reporting";
import {
  parseFinancialAdminPrivateCommand,
  type FinancialAdminPrivateCommand,
} from "./contracts";

export const FINANCIAL_ADMIN_COMMAND_JOB =
  "commerce.financial-admin-command" as const;

const FINANCIAL_ADMIN_COMMAND_MAX_ATTEMPTS = 8;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const LEASE_CAPABILITY = /^[A-Za-z0-9_-]{43}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const RESULT_SCHEMA_TIMESTAMP = "2000-01-01T00:00:00.000Z";

const canonicalUuidSchema = z.string().regex(CANONICAL_UUID);
const commandKindSchema = z.enum(FINANCIAL_ADMIN_COMMAND_KINDS);
const commandStatusSchema = z.enum(FINANCIAL_ADMIN_COMMAND_STATUSES);
const lockedCommandSchema = z.strictObject({
  id: canonicalUuidSchema,
  kind: commandKindSchema,
  actorUserId: canonicalUuidSchema,
  correlationId: z.string().regex(CORRELATION_ID),
  idempotencyKeySha256: z.string().regex(SHA256),
  inputFingerprintSha256: z.string().regex(SHA256),
  jobId: canonicalUuidSchema,
  status: commandStatusSchema,
});
const privateInputRowSchema = z.strictObject({ privateInput: z.unknown() });
const terminalRowSchema = z.strictObject({ id: canonicalUuidSchema });

type LockedCommand = z.infer<typeof lockedCommandSchema>;
type QueryResult = { readonly rows?: readonly unknown[] };

export interface FinancialAdminCommandExecutorContext {
  readonly transaction: DatabaseTransaction;
  readonly commandId: string;
  readonly actor: AdministratorActor;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}

export type FinancialAdminCommandExecutor = (
  context: FinancialAdminCommandExecutorContext,
  command: FinancialAdminPrivateCommand,
) => Promise<FinancialAdminCommandSafeResultDto>;

export class FinancialAdminDeniedError extends Error {
  readonly terminalStatus = "denied" as const;

  constructor(readonly safeCode: "capability_revoked") {
    super(safeCode);
    this.name = "FinancialAdminDeniedError";
  }
}

export class FinancialAdminConflictError extends Error {
  readonly terminalStatus = "conflict" as const;

  constructor(readonly safeCode: "stale_state" | "not_eligible") {
    super(safeCode);
    this.name = "FinancialAdminConflictError";
  }
}

export class FinancialAdminPermanentError extends Error {
  readonly terminalStatus = "failed" as const;

  constructor(readonly safeCode: "invalid_command" | "command_failed") {
    super(safeCode);
    this.name = "FinancialAdminPermanentError";
  }
}

type FinancialAdminTerminalError =
  | FinancialAdminDeniedError
  | FinancialAdminConflictError
  | FinancialAdminPermanentError;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException(
      "Financial administrator command handling was aborted.",
      "AbortError",
    );
  }
}

function queryRows(result: unknown): readonly unknown[] {
  if (!result || typeof result !== "object") {
    throw new Error(
      "Financial administrator command query returned an invalid result",
    );
  }
  const rows = (result as QueryResult).rows;
  if (!Array.isArray(rows)) {
    throw new Error(
      "Financial administrator command query returned an invalid result",
    );
  }
  return rows;
}

function commandIdFromJobPayload(payload: unknown): string | null {
  try {
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      isProxy(payload)
    ) {
      return null;
    }
    const prototype = Object.getPrototypeOf(payload) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(payload);
    if (ownKeys.length !== 1 || ownKeys[0] !== "commandId") return null;
    const descriptor = Object.getOwnPropertyDescriptor(payload, "commandId");
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      return null;
    return typeof descriptor.value === "string" &&
      CANONICAL_UUID.test(descriptor.value)
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function parseJobIdentity(job: JobRecord): string {
  if (
    job.type !== FINANCIAL_ADMIN_COMMAND_JOB ||
    !CANONICAL_UUID.test(job.id) ||
    job.maxAttempts !== FINANCIAL_ADMIN_COMMAND_MAX_ATTEMPTS ||
    !Number.isSafeInteger(job.attempts) ||
    job.attempts < 1 ||
    job.attempts > job.maxAttempts ||
    typeof job.financialAdminLeaseCapability !== "string" ||
    !LEASE_CAPABILITY.test(job.financialAdminLeaseCapability)
  ) {
    throw new PermanentJobError(
      "Invalid financial administrator command job identity.",
    );
  }

  const commandId = commandIdFromJobPayload(job.payload);
  if (
    commandId === null ||
    job.deduplicationKey !== `commerce:financial-admin-command:${commandId}:v1`
  ) {
    throw new PermanentJobError(
      "Invalid financial administrator command job identity.",
    );
  }
  return commandId;
}

async function establishCommandTransactionAuthority(
  transaction: DatabaseTransaction,
  job: JobRecord,
): Promise<void> {
  await transaction.execute(sql`
    select pg_catalog.set_config(
      'pale_orbit.plan6bii_financial_admin_job_capability',
      ${job.financialAdminLeaseCapability},
      true
    )
  `);
  await transaction.execute(sql`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('pale-orbit:user-roles:admin')
    )
  `);
  await transaction.execute(sql`
    select pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended(
        'pale-orbit:plan6bii-financial-admin-job-lease:' || ${job.id}::text,
        0
      )
    )
  `);
}

async function lockCommandIdentity(
  transaction: DatabaseTransaction,
  commandId: string,
  job: JobRecord,
): Promise<LockedCommand> {
  await establishCommandTransactionAuthority(transaction, job);
  const result = await transaction.execute(sql`
    select command.id as id, command.kind as kind,
      command.actor_user_id as "actorUserId",
      command.correlation_id as "correlationId",
      command.idempotency_key_sha256 as "idempotencyKeySha256",
      command.input_fingerprint_sha256 as "inputFingerprintSha256",
      command.job_id as "jobId", command.status as status
    from "public"."financial_admin_commands" command
    where command.id = ${commandId}::uuid
    for update
  `);
  const rows = queryRows(result);
  if (rows.length !== 1) {
    throw new PermanentJobError(
      "Financial administrator command identity is invalid.",
    );
  }

  let command: LockedCommand;
  try {
    command = lockedCommandSchema.parse(rows[0]);
  } catch {
    throw new PermanentJobError(
      "Financial administrator command identity is invalid.",
    );
  }
  if (command.id !== commandId || command.jobId !== job.id) {
    throw new PermanentJobError(
      "Financial administrator command identity is invalid.",
    );
  }
  return command;
}

async function loadPrivateCommand(
  transaction: DatabaseTransaction,
  command: LockedCommand,
): Promise<FinancialAdminPrivateCommand> {
  const rows = await transaction
    .select({ privateInput: financialAdminCommands.privateInput })
    .from(financialAdminCommands)
    .where(
      and(
        eq(financialAdminCommands.id, command.id),
        eq(financialAdminCommands.jobId, command.jobId),
        eq(financialAdminCommands.status, "pending"),
      ),
    );
  if (rows.length !== 1)
    throw new FinancialAdminPermanentError("invalid_command");

  try {
    const row = privateInputRowSchema.parse(rows[0]);
    if (!Object.hasOwn(row, "privateInput")) {
      throw new Error("missing private command input");
    }
    const privateCommand = parseFinancialAdminPrivateCommand(row.privateInput);
    if (privateCommand.kind !== command.kind) {
      throw new Error("private command kind mismatch");
    }
    return privateCommand;
  } catch {
    throw new FinancialAdminPermanentError("invalid_command");
  }
}

function parseExecutorResult(
  command: LockedCommand,
  value: unknown,
): FinancialAdminCommandSafeResultDto {
  try {
    const parsed = parseFinancialAdminCommandStatus({
      commandId: command.id,
      kind: command.kind,
      status: "succeeded",
      resultCode: FINANCIAL_ADMIN_SUCCESS_CODE_BY_KIND[command.kind],
      result: value,
      createdAt: RESULT_SCHEMA_TIMESTAMP,
      updatedAt: RESULT_SCHEMA_TIMESTAMP,
      completedAt: RESULT_SCHEMA_TIMESTAMP,
    });
    if (parsed.status !== "succeeded")
      throw new Error("unexpected result status");
    return parsed.result;
  } catch {
    throw new FinancialAdminPermanentError("command_failed");
  }
}

async function updateTerminalCommand(
  transaction: DatabaseTransaction,
  command: LockedCommand,
  status: Exclude<FinancialAdminCommandStatus, "pending">,
  safeResultCode: string,
  safeResult: FinancialAdminCommandSafeResultDto | null,
): Promise<void> {
  const terminalAt = sql`pg_catalog.statement_timestamp()`;
  const rows = await transaction
    .update(financialAdminCommands)
    .set({
      status,
      safeResultCode,
      safeResult: safeResult as JsonObject | null,
      updatedAt: terminalAt,
      completedAt: terminalAt,
    })
    .where(
      and(
        eq(financialAdminCommands.id, command.id),
        eq(financialAdminCommands.jobId, command.jobId),
        eq(financialAdminCommands.status, "pending"),
      ),
    )
    .returning({ id: financialAdminCommands.id });
  if (rows.length !== 1 || terminalRowSchema.parse(rows[0]).id !== command.id) {
    throw new Error(
      "Financial administrator command terminal update did not affect one row",
    );
  }
}

function isTerminalError(error: unknown): error is FinancialAdminTerminalError {
  return (
    error instanceof FinancialAdminDeniedError ||
    error instanceof FinancialAdminConflictError ||
    error instanceof FinancialAdminPermanentError
  );
}

function terminalJobMessage(error: FinancialAdminTerminalError): string {
  if (error.terminalStatus === "denied") {
    return "Financial administrator command was denied.";
  }
  if (error.terminalStatus === "conflict") {
    return "Financial administrator command conflicted with current state.";
  }
  return "Financial administrator command permanently failed.";
}

function validatedExecutorMap(
  executors: ReadonlyMap<
    FinancialAdminCommandKind,
    FinancialAdminCommandExecutor
  >,
): ReadonlyMap<FinancialAdminCommandKind, FinancialAdminCommandExecutor> {
  if (
    executors.size !== FINANCIAL_ADMIN_COMMAND_KINDS.length ||
    [...executors.keys()].some(
      (kind) => !FINANCIAL_ADMIN_COMMAND_KINDS.includes(kind),
    ) ||
    FINANCIAL_ADMIN_COMMAND_KINDS.some(
      (kind) => typeof executors.get(kind) !== "function",
    )
  ) {
    throw new Error(
      "Financial administrator command handler requires the complete executor map",
    );
  }
  return new Map(executors);
}

async function persistTerminalFailure(
  database: Database,
  commandId: string,
  job: JobRecord,
  error: FinancialAdminTerminalError,
  signal: AbortSignal,
): Promise<void> {
  await withTransaction(database, async (transaction) => {
    const command = await lockCommandIdentity(transaction, commandId, job);
    if (command.status !== "pending") return;
    throwIfAborted(signal);
    await updateTerminalCommand(
      transaction,
      command,
      error.terminalStatus,
      error.safeCode,
      null,
    );
    throwIfAborted(signal);
  });
}

export function createFinancialAdminCommandHandler(input: {
  readonly database: Database;
  readonly executors: ReadonlyMap<
    FinancialAdminCommandKind,
    FinancialAdminCommandExecutor
  >;
  readonly capabilityResolver?: CapabilityResolver;
}): JobHandler {
  const executors = validatedExecutorMap(input.executors);

  return async (job, signal) => {
    throwIfAborted(signal);
    const commandId = parseJobIdentity(job);

    try {
      await withTransaction(input.database, async (transaction) => {
        const command = await lockCommandIdentity(transaction, commandId, job);
        if (command.status === "succeeded") return;
        if (command.status !== "pending") {
          throw new PermanentJobError(
            "Financial administrator command is already terminal.",
          );
        }

        const actor: AdministratorActor = {
          type: "user",
          id: command.actorUserId,
          roles: await listRolesForUser(transaction, command.actorUserId),
        };
        try {
          requireFinancialCommandExecutionCapabilities(actor, command.kind, {
            ...(input.capabilityResolver
              ? { capabilityResolver: input.capabilityResolver }
              : {}),
          });
        } catch (error) {
          if (error instanceof AuthorizationError) {
            throw new FinancialAdminDeniedError("capability_revoked");
          }
          throw error;
        }

        const privateCommand = await loadPrivateCommand(transaction, command);
        const executor = executors.get(command.kind);
        if (!executor) throw new FinancialAdminPermanentError("command_failed");
        throwIfAborted(signal);
        const safeResult = parseExecutorResult(
          command,
          await executor(
            {
              transaction,
              commandId: command.id,
              actor,
              correlationId: command.correlationId,
              signal,
            },
            privateCommand,
          ),
        );
        throwIfAborted(signal);
        await updateTerminalCommand(
          transaction,
          command,
          "succeeded",
          FINANCIAL_ADMIN_SUCCESS_CODE_BY_KIND[command.kind],
          safeResult,
        );
        throwIfAborted(signal);
      });
    } catch (error) {
      if (!isTerminalError(error)) throw error;
      if (
        error instanceof FinancialAdminPermanentError &&
        error.safeCode === "command_failed"
      ) {
        throwIfAborted(signal);
        throw new PermanentJobError(terminalJobMessage(error));
      }
      await persistTerminalFailure(
        input.database,
        commandId,
        job,
        error,
        signal,
      );
      throw new PermanentJobError(terminalJobMessage(error));
    }
  };
}
