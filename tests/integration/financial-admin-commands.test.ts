import { execFile, type ExecFileException } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import type { AdministratorActor } from "$lib/server/auth/admin-policy";
import { setAdminRole } from "$lib/server/auth/roles";
import { appendAuditEvent } from "$lib/server/audit/service";
import { createCommerceMessageEnqueuer } from "$lib/server/commerce/email/enqueue";
import { createFinancialAdminCommandExecutors } from "$lib/server/commerce/financial/admin-commands/executors";
import {
  FINANCIAL_ADMIN_COMMAND_JOB,
  FinancialAdminConflictError,
  createFinancialAdminCommandHandler,
  type FinancialAdminCommandExecutor,
} from "$lib/server/commerce/financial/admin-commands/handler";
import {
  getFinancialAdminCommandStatus,
  submitFinancialAdminCommand,
} from "$lib/server/commerce/financial/admin-commands/repository";
import type { FinancialAdminPrivateCommand } from "$lib/server/commerce/financial/admin-commands/contracts";
import { exportSalesCsv } from "$lib/server/commerce/reporting/csv";
import { databaseEnvironmentForRole } from "$lib/server/db/database-role-provision";
import { createPostgresJobRepository } from "$lib/server/jobs/repository";
import { PermanentJobError, runWorker } from "$lib/server/jobs/runner";
import type { JobRecord, JobRepository } from "$lib/server/jobs/types";
import {
  FINANCIAL_ADMIN_COMMAND_KINDS,
  FINANCIAL_ADMIN_SUCCESS_CODE_BY_KIND,
  parseFinancialAdminCommandStatus,
  type FinancialAdminCommandKind,
  type FinancialAdminCommandSafeResultDto,
} from "$lib/types/financial-reporting";
import { assertCommercePrivacy } from "../e2e/commerce-privacy";
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient,
} from "./database";

vi.mock("$app/navigation", () => ({ invalidateAll: vi.fn() }));
vi.mock("$app/paths", () => ({ resolve: (path: string) => path }));

const FORBIDDEN_STATUS_FIELDS =
  /jobId|payload|attempts|lastError|privateInput|actorUserId|internalError/iu;
const accessMessages = createCommerceMessageEnqueuer(applicationConfig.origin);

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface RestoreVerifierOutput {
  readonly error: ExecFileException | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runExecutableRestoreVerifier(): Promise<RestoreVerifierOutput> {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const verifierPath = fileURLToPath(
    new URL("../../scripts/execute-financial-restore-verifier.ts", import.meta.url),
  );
  const migrationWebUser = process.env.DATABASE_USER?.trim();
  const migrationWorkerUser = process.env.DATABASE_WORKER_USER?.trim();
  const migrationStorageCleanupUser =
    process.env.DATABASE_STORAGE_CLEANUP_USER?.trim();
  if (
    !migrationWebUser ||
    !migrationWorkerUser ||
    !migrationStorageCleanupUser
  ) {
    throw new Error("Restore verifier migration identities are unavailable");
  }
  const ownerEnvironment = {
    ...databaseEnvironmentForRole(process.env, "owner"),
    DATABASE_MIGRATION_WEB_USER: migrationWebUser,
    DATABASE_MIGRATION_WORKER_USER: migrationWorkerUser,
    DATABASE_MIGRATION_STORAGE_CLEANUP_USER: migrationStorageCleanupUser,
  };
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", verifierPath],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: ownerEnvironment,
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 45_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          error,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

async function closeBrowserEvidenceResources(input: {
  readonly page: Page | undefined;
  readonly context: BrowserContext | undefined;
  readonly browser: Browser | undefined;
}): Promise<unknown | undefined> {
  const operations: readonly [string, (() => Promise<void>) | undefined][] = [
    [
      "Timed out closing the sentinel browser page",
      input.page === undefined ? undefined : () => input.page!.close(),
    ],
    [
      "Timed out closing the sentinel browser context",
      input.context === undefined ? undefined : () => input.context!.close(),
    ],
    [
      "Timed out closing the sentinel browser",
      input.browser === undefined ? undefined : () => input.browser!.close(),
    ],
  ];
  let failure: unknown;
  for (const [message, operation] of operations) {
    if (operation === undefined) continue;
    try {
      await within(operation(), 5_000, message);
    } catch (error: unknown) {
      failure ??= error;
    }
  }
  return failure;
}

function assertSentinelAbsent(
  artifact: string,
  value: string,
  privateValues: readonly string[],
): void {
  const normalized = value.toLowerCase();
  if (privateValues.some((privateValue) =>
    privateValue.length > 0 && normalized.includes(privateValue.toLowerCase())
  )) {
    throw new Error(`Sensitive financial sentinel detected in ${artifact}`);
  }
}

function capability(label: string): string {
  return createHash("sha256")
    .update(`financial-admin-integration:${label}`)
    .digest("base64url");
}

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = Reflect.get(error, "code");
  if (typeof direct === "string") return direct;
  return pgCode(Reflect.get(error, "cause"));
}

async function expectPostgresCode(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(pgCode(error)).toBe(expectedCode);
    return;
  }
  throw new Error(`Expected PostgreSQL error ${expectedCode}`);
}

async function expireJobLeaseForFixture(jobId: string): Promise<void> {
  const client = await ownerDatabaseClient.pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    const claim = await client.query(
      `update financial_admin_job_claims
       set expires_at = issued_at + interval '1 millisecond'
       where job_id = $1`,
      [jobId],
    );
    const expired = await client.query(
      `update jobs
       set locked_at = clock_timestamp() - interval '10 seconds',
         run_at = clock_timestamp() - interval '10 seconds'
       where id = $1`,
      [jobId],
    );
    expect(claim.rowCount).toBe(1);
    expect(expired.rowCount).toBe(1);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `
    insert into "user" (id, name, email, email_verified)
    values ($1, $2, $3, true)
  `,
    [id, `Financial administrator ${label}`, `${label}-${id}@example.com`],
  );
  await ownerDatabaseClient.pool.query(
    `
    insert into user_roles (user_id, role) values ($1, 'admin')
  `,
    [id],
  );
  return { type: "user", id, roles: ["admin"] };
}

function draftCommand(): FinancialAdminPrivateCommand & {
  kind: "refund_draft_save";
} {
  return {
    kind: "refund_draft_save",
    refundId: randomUUID(),
    expectedVersion: null,
    items: [{ orderItemId: randomUUID(), totalPresentmentMinor: 725 }],
  };
}

interface CommandLifecycleCase {
  readonly command: FinancialAdminPrivateCommand;
  readonly mutationAction: string;
  readonly mutationResourceType: string;
  readonly mutationResourceId: string;
  readonly safeResult: FinancialAdminCommandSafeResultDto;
}

function commandLifecycleCase(
  kind: FinancialAdminCommandKind,
): CommandLifecycleCase {
  const refundId = randomUUID();
  switch (kind) {
    case "refund_draft_save": {
      return {
        command: {
          kind,
          refundId,
          expectedVersion: null,
          items: [{ orderItemId: randomUUID(), totalPresentmentMinor: 725 }],
        },
        mutationAction: "financial.refund_draft.created",
        mutationResourceType: "refund_allocation_draft",
        mutationResourceId: randomUUID(),
        safeResult: { refundId, draftVersion: 1, changed: true },
      };
    }
    case "refund_draft_discard": {
      return {
        command: {
          kind,
          refundId,
          expectedActiveDraftVersion: 4,
        },
        mutationAction: "financial.refund_draft.discarded",
        mutationResourceType: "refund_allocation_draft",
        mutationResourceId: randomUUID(),
        safeResult: { refundId, draftVersion: 5, changed: true },
      };
    }
    case "refund_allocation_finalize": {
      return {
        command: {
          kind,
          refundId,
          expectedActiveDraftVersion: 2,
          previewFingerprint: "1".repeat(64),
          confirmation: "finalize_refund_allocation",
        },
        mutationAction: "financial.refund_allocation.finalized",
        mutationResourceType: "refund",
        mutationResourceId: refundId,
        safeResult: {
          refundId,
          finalizedDraftVersion: 3,
          accessChanged: true,
          emailQueued: true,
        },
      };
    }
    case "refund_reporting_correction_create": {
      const correctionSetId = randomUUID();
      return {
        command: {
          kind,
          refundId,
          reason: "allocation_attribution_correction",
          expectedNextCorrectionVersion: 2,
          expectedBaseAllocationSetId: randomUUID(),
          expectedSourceFingerprint: "2".repeat(64),
          items: [{ orderItemId: randomUUID(), totalPresentmentMinor: 725 }],
          previewFingerprint: "3".repeat(64),
          confirmation: "create_reporting_correction",
        },
        mutationAction: "financial.refund_correction.created",
        mutationResourceType: "refund_reporting_correction_set",
        mutationResourceId: correctionSetId,
        safeResult: { refundId, correctionSetId, correctionVersion: 2 },
      };
    }
    case "administrative_recovery_activate": {
      const recoveryGrantId = randomUUID();
      return {
        command: {
          kind,
          refundId,
          finalizationEffectId: randomUUID(),
          orderItemId: randomUUID(),
          expectedCorrectionSetId: randomUUID(),
          expectedCorrectionVersion: 2,
          expectedSourceFingerprint: "4".repeat(64),
          previewFingerprint: "5".repeat(64),
          confirmation: "activate_persistent_recovery",
        },
        mutationAction: "financial.recovery_grant.activated",
        mutationResourceType: "entitlement_grant",
        mutationResourceId: recoveryGrantId,
        safeResult: {
          recoveryGrantId,
          accessChanged: true,
          emailQueued: true,
        },
      };
    }
    case "administrative_recovery_deactivate": {
      const recoveryGrantId = randomUUID();
      return {
        command: {
          kind,
          recoveryGrantId,
          recoveryReferenceId: randomUUID(),
          expectedStateChangedAt: "2026-08-22T12:34:56.789Z",
          confirmation: "deactivate_persistent_recovery",
        },
        mutationAction: "financial.recovery_grant.deactivated",
        mutationResourceType: "entitlement_grant",
        mutationResourceId: recoveryGrantId,
        safeResult: {
          recoveryGrantId,
          accessChanged: true,
          emailQueued: true,
        },
      };
    }
    default: {
      kind satisfies never;
      throw new Error("Unhandled financial administrator command kind");
    }
  }
}

function executorsWithEveryCommand(
  executor: FinancialAdminCommandExecutor,
): ReadonlyMap<FinancialAdminCommandKind, FinancialAdminCommandExecutor> {
  const bind = (): FinancialAdminCommandExecutor =>
    (context, command) => executor(context, command);
  return createFinancialAdminCommandExecutors({
    refundDraftSave: bind(),
    refundDraftDiscard: bind(),
    refundAllocationFinalize: bind(),
    refundReportingCorrectionCreate: bind(),
    administrativeRecoveryActivate: bind(),
    administrativeRecoveryDeactivate: bind(),
  });
}

async function submitCommand(
  actor: AdministratorActor,
  command: FinancialAdminPrivateCommand,
  idempotencyKey = randomUUID(),
  correlationId = `financial-admin-${randomUUID()}`,
) {
  return submitFinancialAdminCommand(databaseClient.db, {
    actor,
    idempotencyKey,
    command,
    context: { correlationId },
  });
}

async function submitDraft(
  actor: AdministratorActor,
  command: FinancialAdminPrivateCommand & { kind: "refund_draft_save" },
  idempotencyKey = randomUUID(),
  correlationId = `financial-admin-${randomUUID()}`,
) {
  return submitCommand(actor, command, idempotencyKey, correlationId);
}

function executorsWithDraftSave(
  refundDraftSave: FinancialAdminCommandExecutor,
): ReadonlyMap<FinancialAdminCommandKind, FinancialAdminCommandExecutor> {
  return createFinancialAdminCommandExecutors({
    refundDraftSave,
    refundDraftDiscard: async () => ({
      refundId: randomUUID(),
      draftVersion: 1,
      changed: false,
    }),
    refundAllocationFinalize: async () => ({
      refundId: randomUUID(),
      finalizedDraftVersion: 1,
      accessChanged: false,
      emailQueued: false,
    }),
    refundReportingCorrectionCreate: async () => ({
      refundId: randomUUID(),
      correctionSetId: randomUUID(),
      correctionVersion: 1,
    }),
    administrativeRecoveryActivate: async () => ({
      recoveryGrantId: randomUUID(),
      accessChanged: false,
      emailQueued: false,
    }),
    administrativeRecoveryDeactivate: async () => ({
      recoveryGrantId: randomUUID(),
      accessChanged: false,
      emailQueued: false,
    }),
  });
}

interface RepositoryObservations {
  readonly claims: JobRecord[];
  renewals: number;
  completions: number;
  failures: number;
}

function observeRepository(
  repository: JobRepository,
  observations: RepositoryObservations,
  afterFailure?: (job: JobRecord | undefined) => void,
): JobRepository {
  let current: JobRecord | undefined;
  return {
    async claimNext(workerId) {
      const job = await repository.claimNext(workerId);
      if (job) {
        current = job;
        observations.claims.push(job);
      }
      return job;
    },
    async renewLease(jobId, workerId, leaseCapability) {
      observations.renewals += 1;
      return repository.renewLease(jobId, workerId, leaseCapability);
    },
    async complete(jobId, workerId, leaseCapability) {
      observations.completions += 1;
      return repository.complete(jobId, workerId, leaseCapability);
    },
    async fail(jobId, workerId, safeError, retryable, leaseCapability) {
      observations.failures += 1;
      const result = await repository.fail(
        jobId,
        workerId,
        safeError,
        retryable,
        leaseCapability,
      );
      afterFailure?.(current);
      return result;
    },
    async failWithDisposition(jobId, workerId, safeError, retryable, leaseCapability) {
      observations.failures += 1;
      const result = await repository.failWithDisposition(
        jobId,
        workerId,
        safeError,
        retryable,
        leaseCapability,
      );
      afterFailure?.(current);
      return result;
    },
  };
}

async function runSingleClaim(
  repository: JobRepository,
  handler: ReturnType<typeof createFinancialAdminCommandHandler>,
  workerId: string,
  leaseRenewalIntervalMs = 20,
  controller = new AbortController(),
): Promise<void> {
  let polls = 0;
  await runWorker({
    repository,
    handlers: new Map([[FINANCIAL_ADMIN_COMMAND_JOB, handler]]),
    workerId,
    concurrency: 1,
    pollIntervalMs: 1,
    leaseRenewalIntervalMs,
    signal: controller.signal,
    beforePoll: async () => {
      polls += 1;
      if (polls === 2) controller.abort();
    },
  });
}

async function commandAndJob(commandId: string) {
  return (
    await ownerDatabaseClient.pool.query<{
      command_id: string;
      command_status: string;
      safe_result_code: string | null;
      safe_result: unknown;
      job_id: string;
      job_status: string;
      payload: unknown;
      deduplication_key: string;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
    }>(
      `
    select command.id as command_id, command.status as command_status,
      command.safe_result_code, command.safe_result,
      job.id as job_id, job.status as job_status, job.payload,
      job.deduplication_key, job.attempts, job.max_attempts, job.last_error
    from financial_admin_commands command
    join jobs job on job.id = command.job_id
    where command.id = $1
  `,
      [commandId],
    )
  ).rows[0]!;
}

interface CommandAuditRow {
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly resource_type: string;
  readonly resource_id: string | null;
  readonly correlation_id: string;
  readonly request_metadata: unknown;
  readonly before: unknown;
  readonly after: unknown;
}

async function commandAuditRows(
  commandId: string,
  actionPattern = "financial.admin_command.%",
): Promise<readonly CommandAuditRow[]> {
  return (
    await ownerDatabaseClient.pool.query<CommandAuditRow>(
      `
      select actor_type, actor_id, action, outcome, resource_type, resource_id,
        correlation_id, request_metadata, before, "after"
      from audit_events
      where resource_id = $1 and action like $2
      order by id
    `,
      [commandId, actionPattern],
    )
  ).rows;
}

async function expectNoSentinelPersistenceLeaks(
  secret: string,
  secretDigest: string,
): Promise<void> {
  const secretLeak = await ownerDatabaseClient.pool.query<{
    job_leaks: number;
    command_leaks: number;
    claim_leaks: number;
    audit_leaks: number;
    outbox_leaks: number;
    digest_public_leaks: number;
  }>(
    `
    select
      (select count(*)::integer from jobs
       where row_to_json(jobs)::text like '%' || $1 || '%') as job_leaks,
      (select count(*)::integer from financial_admin_commands
       where row_to_json(financial_admin_commands)::text like '%' || $1 || '%')
        as command_leaks,
      (select count(*)::integer from financial_admin_job_claims
       where row_to_json(financial_admin_job_claims)::text like '%' || $1 || '%')
        as claim_leaks,
      (select count(*)::integer from audit_events
       where row_to_json(audit_events)::text like '%' || $1 || '%') as audit_leaks,
      (select count(*)::integer from outbox_messages
       where row_to_json(outbox_messages)::text like '%' || $1 || '%') as outbox_leaks,
      (
        (select count(*)::integer from jobs
         where row_to_json(jobs)::text like '%' || $2 || '%') +
        (select count(*)::integer from financial_admin_commands
         where row_to_json(financial_admin_commands)::text like '%' || $2 || '%') +
        (select count(*)::integer from audit_events
         where row_to_json(audit_events)::text like '%' || $2 || '%') +
        (select count(*)::integer from outbox_messages
         where row_to_json(outbox_messages)::text like '%' || $2 || '%')
      ) as digest_public_leaks
  `,
    [secret, secretDigest],
  );
  expect(secretLeak.rows).toEqual([
    {
      job_leaks: 0,
      command_leaks: 0,
      claim_leaks: 0,
      audit_leaks: 0,
      outbox_leaks: 0,
      digest_public_leaks: 0,
    },
  ]);
}

function expectMinimalTerminalAudit(input: {
  readonly auditRows: readonly CommandAuditRow[];
  readonly actor: AdministratorActor;
  readonly commandId: string;
  readonly commandKind: FinancialAdminCommandKind;
  readonly correlationId: string;
  readonly status: "denied" | "conflict" | "failed";
  readonly safeResultCode:
    | "capability_revoked"
    | "stale_state"
    | "not_eligible"
    | "invalid_command"
    | "command_failed";
}): void {
  expect(input.auditRows).toEqual([
    {
      actor_type: "user",
      actor_id: input.actor.id,
      action: `financial.admin_command.${input.status}`,
      outcome: input.status === "denied" ? "denied" : "failed",
      resource_type: "financial_admin_command",
      resource_id: input.commandId,
      correlation_id: input.correlationId,
      request_metadata: null,
      before: null,
      after: {
        commandKind: input.commandKind,
        safeResultCode: input.safeResultCode,
      },
    },
  ]);
}

describe("financial administrator command PostgreSQL lifecycle", () => {
  it("confines reporting-correction issue resolution to a current claimed correction command", async () => {
    const actor = await createAdministrator("correction-resolver-target");
    const roleAdministrator = await createAdministrator(
      "correction-resolver-role-authority",
    );
    const ordinary = await submitDraft(actor, draftCommand());
    await expect(
      workerDatabaseClient.pool.query(
        `select id from
          public.resolve_financial_issue_after_reporting_correction_command($1,$2)`,
        [ordinary.commandId, randomUUID()],
      ),
    ).resolves.toMatchObject({ rows: [] });

    const correctionCommand: Extract<
      FinancialAdminPrivateCommand,
      { kind: "refund_reporting_correction_create" }
    > = {
      kind: "refund_reporting_correction_create",
      refundId: randomUUID(),
      reason: "allocation_attribution_correction",
      expectedNextCorrectionVersion: 1,
      expectedBaseAllocationSetId: randomUUID(),
      expectedSourceFingerprint: "8".repeat(64),
      items: [{ orderItemId: randomUUID(), totalPresentmentMinor: 1 }],
      previewFingerprint: "9".repeat(64),
      confirmation: "create_reporting_correction",
    };
    const correction = await submitFinancialAdminCommand(databaseClient.db, {
      actor,
      idempotencyKey: randomUUID(),
      command: correctionCommand,
      context: { correlationId: `correction-resolver-${randomUUID()}` },
    });
    const issueId = randomUUID();
    await expectPostgresCode(
      databaseClient.pool.query(
        `select * from
          public.resolve_financial_issue_after_reporting_correction_command($1,$2)`,
        [correction.commandId, issueId],
      ),
      "42501",
    );
    await expectPostgresCode(
      workerDatabaseClient.pool.query(
        `select * from
          public.resolve_financial_issue_after_reporting_correction_command($1,$2)`,
        [correction.commandId, issueId],
      ),
      "55000",
    );

    await setAdminRole(databaseClient.db, {
      actor: roleAdministrator,
      targetUserId: actor.id,
      enabled: false,
      correlationId: `correction-resolver-demotion-${randomUUID()}`,
    });
    await expectPostgresCode(
      workerDatabaseClient.pool.query(
        `select * from
          public.resolve_financial_issue_after_reporting_correction_command($1,$2)`,
        [correction.commandId, issueId],
      ),
      "42501",
    );
    await expect(
      ownerDatabaseClient.pool.query(
        `select count(*)::integer as count from audit_events
         where action = 'financial.issue.resolved'
           and "after" ->> 'commandId' = $1`,
        [correction.commandId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 15_000);

  it("submits atomically, replays idempotently, rejects conflicting fingerprints, and exposes only safe status", async () => {
    const actor = await createAdministrator("submission-owner");
    const otherActor = await createAdministrator("submission-foreign");
    const command = draftCommand();
    const idempotencyKey = randomUUID();

    const submitted = await submitDraft(actor, command, idempotencyKey);
    const replayed = await submitDraft(actor, command, idempotencyKey);

    expect(replayed).toEqual(submitted);
    expect(await commandAndJob(submitted.commandId)).toMatchObject({
      command_id: submitted.commandId,
      command_status: "pending",
      safe_result_code: null,
      safe_result: null,
      job_status: "pending",
      payload: { commandId: submitted.commandId },
      deduplication_key: `commerce:financial-admin-command:${submitted.commandId}:v1`,
      attempts: 0,
      max_attempts: 8,
      last_error: null,
    });
    await expect(
      ownerDatabaseClient.pool.query(
        `
      select
        (select count(*)::integer from financial_admin_commands
         where actor_user_id = $1) as command_count,
        (select count(*)::integer from jobs
         where type = 'commerce.financial-admin-command') as job_count
    `,
        [actor.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ command_count: 1, job_count: 1 }],
    });

    await expectPostgresCode(
      submitDraft(
        actor,
        {
          ...command,
          items: [{ ...command.items[0]!, totalPresentmentMinor: 726 }],
        },
        idempotencyKey,
      ),
      "40900",
    );
    await expect(
      ownerDatabaseClient.pool.query(`
      select
        (select count(*)::integer from financial_admin_commands) as command_count,
        (select count(*)::integer from jobs
         where type = 'commerce.financial-admin-command') as job_count
    `),
    ).resolves.toMatchObject({
      rows: [{ command_count: 1, job_count: 1 }],
    });

    await expectPostgresCode(
      databaseClient.pool.query(
        "select id from financial_admin_commands where id = $1",
        [submitted.commandId],
      ),
      "42501",
    );
    const linked = await commandAndJob(submitted.commandId);
    await expectPostgresCode(
      databaseClient.pool.query("select payload from jobs where id = $1", [
        linked.job_id,
      ]),
      "42501",
    );

    const workerLock = await workerDatabaseClient.pool.connect();
    try {
      await workerLock.query("begin");
      await expect(
        workerLock.query(
          `
        select id, kind, private_input from financial_admin_commands
        where id = $1 for update
      `,
          [submitted.commandId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await workerLock.query("rollback");
    } finally {
      workerLock.release();
    }
    await expectPostgresCode(
      workerDatabaseClient.pool.query(
        `
      update financial_admin_commands set actor_user_id = $2 where id = $1
    `,
        [submitted.commandId, otherActor.id],
      ),
      "42501",
    );

    const status = await getFinancialAdminCommandStatus(
      databaseClient.db,
      actor,
      submitted.commandId,
    );
    expect(status).toMatchObject({
      commandId: submitted.commandId,
      kind: "refund_draft_save",
      status: "pending",
      resultCode: null,
      result: null,
      completedAt: null,
    });
    expect(JSON.stringify(status)).not.toMatch(FORBIDDEN_STATUS_FIELDS);
    await expect(
      getFinancialAdminCommandStatus(
        databaseClient.db,
        otherActor,
        submitted.commandId,
      ),
    ).resolves.toBeNull();
  });

  it.each(FINANCIAL_ADMIN_COMMAND_KINDS)(
    "commits the fixed %s mutation audit with the submitting actor and terminal result exactly once",
    async (kind) => {
      const actor = await createAdministrator(`success-${kind}`);
      const lifecycle = commandLifecycleCase(kind);
      const correlationId = `financial-admin-success-${randomUUID()}`;
      const submitted = await submitCommand(
        actor,
        lifecycle.command,
        randomUUID(),
        correlationId,
      );
      const executor = vi.fn<FinancialAdminCommandExecutor>(
        async (context, command) => {
          expect(command).toEqual(lifecycle.command);
          expect(context.commandId).toBe(submitted.commandId);
          expect(context.actor).toMatchObject({ type: "user", id: actor.id });
          expect(context.actor.roles).toContain("admin");
          expect(context.correlationId).toBe(correlationId);
          await appendAuditEvent(context.transaction, {
            actor: context.actor,
            action: lifecycle.mutationAction,
            outcome: "succeeded",
            resourceType: lifecycle.mutationResourceType,
            resourceId: lifecycle.mutationResourceId,
            correlationId: context.correlationId,
            after: {
              commandId: context.commandId,
              commandKind: command.kind,
            },
          });
          return lifecycle.safeResult;
        },
      );
      const handler = createFinancialAdminCommandHandler({
        database: workerDatabaseClient.db,
        executors: executorsWithEveryCommand(executor),
        accessMessages,
      });
      const workerId = `financial-admin-success-${kind}`;
      const repository = createPostgresJobRepository(
        workerDatabaseClient.db,
        { ...applicationConfig.jobs, leaseMs: 5_000 },
        undefined,
        "local-only",
        { classifierVersion: 1, allocationAlgorithmVersion: 1 },
        () => capability(`success-${kind}`),
      );
      const job = await repository.claimNext(workerId);
      expect(job).toMatchObject({
        type: FINANCIAL_ADMIN_COMMAND_JOB,
        payload: { commandId: submitted.commandId },
      });

      await handler(job!, new AbortController().signal);
      expect(executor).toHaveBeenCalledOnce();
      expect(await commandAndJob(submitted.commandId)).toMatchObject({
        command_status: "succeeded",
        safe_result_code: FINANCIAL_ADMIN_SUCCESS_CODE_BY_KIND[kind],
        safe_result: lifecycle.safeResult,
        job_status: "running",
        attempts: 1,
      });
      const mutationAudits = await ownerDatabaseClient.pool.query(
        `
        select actor_type, actor_id, action, outcome, resource_type, resource_id,
          correlation_id, request_metadata, before, "after"
        from audit_events
        where correlation_id = $1 and action = $2
        order by id
      `,
        [correlationId, lifecycle.mutationAction],
      );
      expect(mutationAudits.rows).toEqual([
        {
          actor_type: "user",
          actor_id: actor.id,
          action: lifecycle.mutationAction,
          outcome: "succeeded",
          resource_type: lifecycle.mutationResourceType,
          resource_id: lifecycle.mutationResourceId,
          correlation_id: correlationId,
          request_metadata: null,
          before: null,
          after: {
            commandId: submitted.commandId,
            commandKind: kind,
          },
        },
      ]);
      expect(await commandAuditRows(submitted.commandId)).toEqual([]);

      await handler(job!, new AbortController().signal);
      expect(executor).toHaveBeenCalledOnce();
      await expect(
        ownerDatabaseClient.pool.query(
          `select count(*)::integer as count from audit_events
           where correlation_id = $1 and action = $2`,
          [correlationId, lifecycle.mutationAction],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await expect(
        repository.complete(
          job!.id,
          workerId,
          job!.financialAdminLeaseCapability,
        ),
      ).resolves.toBe(true);
      expect(await commandAndJob(submitted.commandId)).toMatchObject({
        command_status: "succeeded",
        job_status: "succeeded",
      });
    },
  );

  it("commits a freshly evaluated semantic no-op without a mutation audit and replays terminally", async () => {
    const actor = await createAdministrator("semantic-no-op");
    const command = draftCommand();
    const correlationId = `financial-admin-no-op-${randomUUID()}`;
    const submitted = await submitDraft(
      actor,
      command,
      randomUUID(),
      correlationId,
    );
    const executor = vi.fn<FinancialAdminCommandExecutor>(async () => ({
      refundId: command.refundId,
      draftVersion: 7,
      changed: false,
    }));
    const handler = createFinancialAdminCommandHandler({
      database: workerDatabaseClient.db,
      executors: executorsWithDraftSave(executor),
      accessMessages,
    });
    const workerId = "financial-admin-no-op-worker";
    const repository = createPostgresJobRepository(
      workerDatabaseClient.db,
      { ...applicationConfig.jobs, leaseMs: 5_000 },
      undefined,
      "local-only",
      { classifierVersion: 1, allocationAlgorithmVersion: 1 },
      () => capability("semantic-no-op"),
    );
    const job = await repository.claimNext(workerId);
    expect(job?.payload).toEqual({ commandId: submitted.commandId });

    await handler(job!, new AbortController().signal);
    await handler(job!, new AbortController().signal);
    expect(executor).toHaveBeenCalledOnce();
    expect(await commandAndJob(submitted.commandId)).toMatchObject({
      command_status: "succeeded",
      safe_result_code: "draft_saved",
      safe_result: {
        refundId: command.refundId,
        draftVersion: 7,
        changed: false,
      },
      job_status: "running",
    });
    await expect(
      ownerDatabaseClient.pool.query(
        `select count(*)::integer as count from audit_events
         where correlation_id = $1 and action like 'financial.refund_draft.%'`,
        [correlationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      repository.complete(
        job!.id,
        workerId,
        job!.financialAdminLeaseCapability,
      ),
    ).resolves.toBe(true);
  });

  it("rolls back a tentative mutation audit and persists one minimized conflict audit", async () => {
    const actor = await createAdministrator("conflict-audit");
    const lifecycle = commandLifecycleCase("refund_draft_save");
    const command = lifecycle.command as Extract<
      FinancialAdminPrivateCommand,
      { kind: "refund_draft_save" }
    >;
    const correlationId = `financial-admin-conflict-${randomUUID()}`;
    const submitted = await submitCommand(
      actor,
      command,
      randomUUID(),
      correlationId,
    );
    const executor = vi.fn<FinancialAdminCommandExecutor>(
      async (context, command) => {
        await appendAuditEvent(context.transaction, {
          actor: context.actor,
          action: lifecycle.mutationAction,
          outcome: "succeeded",
          resourceType: lifecycle.mutationResourceType,
          resourceId: lifecycle.mutationResourceId,
          correlationId: context.correlationId,
          after: {
            commandId: context.commandId,
            commandKind: command.kind,
          },
        });
        throw new FinancialAdminConflictError("stale_state");
      },
    );
    const handler = createFinancialAdminCommandHandler({
      database: workerDatabaseClient.db,
      executors: executorsWithEveryCommand(executor),
      accessMessages,
    });
    const repository = createPostgresJobRepository(
      workerDatabaseClient.db,
      { ...applicationConfig.jobs, leaseMs: 5_000 },
      undefined,
      "local-only",
      { classifierVersion: 1, allocationAlgorithmVersion: 1 },
      () => capability("conflict-audit"),
    );
    const job = await repository.claimNext("financial-admin-conflict-worker");
    expect(job?.payload).toEqual({ commandId: submitted.commandId });

    await expect(
      handler(job!, new AbortController().signal),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(await commandAndJob(submitted.commandId)).toMatchObject({
      command_status: "conflict",
      safe_result_code: "stale_state",
      safe_result: null,
      job_status: "running",
      attempts: 1,
    });
    await expect(
      ownerDatabaseClient.pool.query(
        `select count(*)::integer as count from audit_events
         where correlation_id = $1 and action = $2`,
        [correlationId, lifecycle.mutationAction],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    const conflictAudits = await commandAuditRows(submitted.commandId);
    expectMinimalTerminalAudit({
      auditRows: conflictAudits,
      actor,
      commandId: submitted.commandId,
      commandKind: command.kind,
      correlationId,
      status: "conflict",
      safeResultCode: "stale_state",
    });
    const minimized = JSON.stringify(conflictAudits);
    expect(minimized).not.toContain(command.refundId);
    expect(minimized).not.toContain(command.items[0]!.orderItemId);
    expect(minimized).not.toContain("privateInput");

    await expect(
      handler(job!, new AbortController().signal),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(executor).toHaveBeenCalledOnce();
    expect(await commandAuditRows(submitted.commandId)).toEqual(conflictAudits);
  });

  it("runs a claimed local-only command with heartbeat renewal and serializes concurrent demotion", async () => {
    const actor = await createAdministrator("runner-target");
    const roleAdministrator = await createAdministrator(
      "runner-role-authority",
    );
    const command = draftCommand();
    const submitted = await submitDraft(actor, command);
    const executorStarted = deferred();
    const releaseExecutor = deferred();
    const secret = randomBytes(32).toString("base64url");
    const secretDigest = createHash("sha256").update(secret).digest("hex");
    const privateSentinelValues = [secret, secretDigest] as const;
    const capturedErrors: unknown[][] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...values) => {
      capturedErrors.push(values);
    });
    const executor = vi.fn<FinancialAdminCommandExecutor>(async () => {
      executorStarted.resolve();
      await within(
        releaseExecutor.promise,
        10_000,
        "Timed out waiting to release the sentinel command executor",
      );
      return { refundId: command.refundId, draftVersion: 1, changed: true };
    });
    const handler = createFinancialAdminCommandHandler({
      database: workerDatabaseClient.db,
      executors: executorsWithDraftSave(executor),
      accessMessages,
    });
    const postgresRepository = createPostgresJobRepository(
      workerDatabaseClient.db,
      { ...applicationConfig.jobs, leaseMs: 5_000 },
      undefined,
      "local-only",
      { classifierVersion: 1, allocationAlgorithmVersion: 1 },
      () => secret,
    );
    const observations: RepositoryObservations = {
      claims: [],
      renewals: 0,
      completions: 0,
      failures: 0,
    };
    const repository = observeRepository(postgresRepository, observations);
    const workerController = new AbortController();
    const worker = runSingleClaim(
      repository,
      handler,
      "financial-admin-success-worker",
      10,
      workerController,
    );
    let demotion: ReturnType<typeof setAdminRole> | undefined;
    let roleRegranted = false;
    let runtimeDatabaseMocked = false;
    let browser: Browser | undefined;
    let browserContext: BrowserContext | undefined;
    let browserPage: Page | undefined;
    let testFailure: unknown;
    let cleanupFailure: unknown;
    try {
      await within(
        executorStarted.promise,
        5_000,
        "Timed out waiting for the sentinel command executor",
      );
      let demotionSettled = false;
      demotion = setAdminRole(databaseClient.db, {
        actor: roleAdministrator,
        targetUserId: actor.id,
        enabled: false,
        correlationId: `financial-admin-demotion-${randomUUID()}`,
      }).finally(() => {
        demotionSettled = true;
      });

      await vi.waitFor(() => expect(observations.renewals).toBeGreaterThan(0), {
        timeout: 2_000,
        interval: 10,
      });
      expect(demotionSettled).toBe(false);
      releaseExecutor.resolve();
      await within(
        Promise.all([worker, demotion]),
        10_000,
        "Timed out joining the sentinel worker and administrator demotion",
      );

      expect(executor).toHaveBeenCalledOnce();
      expect(observations.claims).toHaveLength(1);
      const observedClaim = observations.claims[0];
      if (
        observedClaim?.type !== FINANCIAL_ADMIN_COMMAND_JOB ||
        observedClaim.payload.commandId !== submitted.commandId ||
        observedClaim.financialAdminLeaseCapability !== secret
      ) {
        throw new Error("The sentinel claim did not preserve its in-memory capability");
      }
      expect(observations.renewals).toBeGreaterThan(0);
      expect(observations.completions).toBe(1);
      expect(observations.failures).toBe(0);
      expect(await commandAndJob(submitted.commandId)).toMatchObject({
        command_status: "succeeded",
        safe_result_code: "draft_saved",
        safe_result: {
          refundId: command.refundId,
          draftVersion: 1,
          changed: true,
        },
        job_status: "succeeded",
        attempts: 1,
        last_error: null,
      });
      await expect(
        ownerDatabaseClient.pool.query(
          `
        select count(*)::integer as count from audit_events
        where action like 'financial.admin_command.%' and resource_id = $1
      `,
          [submitted.commandId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });

      await expectNoSentinelPersistenceLeaks(secret, secretDigest);
      const capturedErrorText = inspect(capturedErrors, { depth: null });
      assertSentinelAbsent(
        "captured errors",
        capturedErrorText,
        privateSentinelValues,
      );
      const claimState = await ownerDatabaseClient.pool.query<{
        state: string;
        capability_sha256: string;
        invalidated: boolean;
      }>(
        `
        select state, capability_sha256, invalidated_at is not null as invalidated
        from financial_admin_job_claims where job_id = $1
      `,
        [(await commandAndJob(submitted.commandId)).job_id],
      );
      if (
        claimState.rows.length !== 1 ||
        claimState.rows[0]?.state !== "invalidated" ||
        claimState.rows[0]?.capability_sha256 !== secretDigest ||
        claimState.rows[0]?.invalidated !== true
      ) {
        throw new Error("The sentinel claim did not retain its exact invalidated digest");
      }

      await setAdminRole(databaseClient.db, {
        actor: roleAdministrator,
        targetUserId: actor.id,
        enabled: true,
        correlationId: `financial-admin-regrant-${randomUUID()}`,
      });
      roleRegranted = true;
      const status = await getFinancialAdminCommandStatus(
        databaseClient.db,
        actor,
        submitted.commandId,
      );
      expect(status).toMatchObject({
        status: "succeeded",
        resultCode: "draft_saved",
        result: { refundId: command.refundId, draftVersion: 1, changed: true },
      });
      expect(JSON.stringify(status)).not.toMatch(FORBIDDEN_STATUS_FIELDS);
      assertCommercePrivacy(
        "financial status",
        status,
        privateSentinelValues,
      );

      vi.doMock("$lib/server/db/runtime", () => ({
        getDatabaseClient: () => databaseClient,
      }));
      runtimeDatabaseMocked = true;
      const statusRoute = await import(
        "../../src/routes/admin/sales/commands/[commandId]/+server"
      );
      const statusUrl = new URL(
        `/admin/sales/commands/${submitted.commandId}`,
        applicationConfig.origin,
      );
      const endpointResponse = await statusRoute.GET({
        locals: { actor },
        params: { commandId: submitted.commandId },
        request: new Request(statusUrl, {
          headers: {
            origin: statusUrl.origin,
            "sec-fetch-site": "same-origin",
          },
        }),
      } as never);
      if (!(endpointResponse instanceof Response)) {
        throw new Error("Financial command status endpoint returned no Response");
      }
      const endpointHeaders = Object.fromEntries(endpointResponse.headers.entries());
      const endpointBody = await endpointResponse.text();
      expect(endpointResponse.status).toBe(200);
      assertCommercePrivacy(
        "financial status",
        { body: endpointBody, headers: endpointHeaders },
        privateSentinelValues,
      );
      const endpointStatus = parseFinancialAdminCommandStatus(
        JSON.parse(endpointBody) as unknown,
      );

      const { default: FinancialCommandStatus } = await import(
        "$lib/components/admin/FinancialCommandStatus.svelte"
      );
      const statusHtml = render(FinancialCommandStatus, {
        props: { command: endpointStatus },
      }).body;
      assertCommercePrivacy(
        "financial html",
        statusHtml,
        privateSentinelValues,
      );

      const { chromium } = await import("@playwright/test");
      browser = await chromium.launch({ headless: true, timeout: 15_000 });
      browserContext = await within(
        browser.newContext(),
        5_000,
        "Timed out creating the sentinel browser context",
      );
      browserPage = await within(
        browserContext.newPage(),
        5_000,
        "Timed out creating the sentinel browser page",
      );
      await within(
        browserPage.setContent(statusHtml, { waitUntil: "domcontentloaded" }),
        10_000,
        "Timed out loading the sentinel status HTML",
      );
      const [browserHtml, browserText] = await Promise.all([
        within(
          browserPage.content(),
          5_000,
          "Timed out reading the sentinel browser HTML",
        ),
        within(
          browserPage.locator("body").innerText(),
          5_000,
          "Timed out reading the sentinel browser text",
        ),
      ]);
      assertCommercePrivacy(
        "financial browser",
        { html: browserHtml, text: browserText },
        privateSentinelValues,
      );

      const csvExport = await exportSalesCsv(
        databaseClient.db,
        actor,
        { range: "all", sort: "gross_desc", pageSize: 50 },
        {
          correlationId: `financial-admin-sentinel-export-${randomUUID()}`,
          requestMetadata: {
            method: "GET",
            routeId: "/admin/sales/export.csv",
          },
        },
      );
      const csvText = new TextDecoder().decode(csvExport.bytes);
      assertCommercePrivacy(
        "financial csv",
        csvText,
        privateSentinelValues,
      );

      const restoreVerifier = await runExecutableRestoreVerifier();
      assertSentinelAbsent(
        "restore-verifier stdout",
        restoreVerifier.stdout,
        privateSentinelValues,
      );
      assertSentinelAbsent(
        "restore-verifier stderr",
        restoreVerifier.stderr,
        privateSentinelValues,
      );
      if (restoreVerifier.error !== null) {
        throw new Error("Executable restore verifier did not exit cleanly");
      }
      expect(restoreVerifier.stdout).toContain(
        "[restore-verifier] executable SQL returned zero structural violations",
      );
      await expectNoSentinelPersistenceLeaks(secret, secretDigest);
    } catch (error: unknown) {
      testFailure = error;
    } finally {
      if (runtimeDatabaseMocked) vi.doUnmock("$lib/server/db/runtime");
      const browserCleanupFailure = await closeBrowserEvidenceResources({
        page: browserPage,
        context: browserContext,
        browser,
      });
      cleanupFailure ??= browserCleanupFailure;
      workerController.abort();
      releaseExecutor.resolve();
      const cleanup = await Promise.allSettled([
        within(worker, 5_000, "Timed out cleaning up the sentinel command worker"),
        ...(demotion === undefined
          ? []
          : [within(demotion, 5_000, "Timed out cleaning up sentinel demotion")]),
      ]);
      const workerCleanupFailure = cleanup.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      )?.reason;
      cleanupFailure ??= workerCleanupFailure;
      if (demotion !== undefined && !roleRegranted) {
        try {
          await within(
            setAdminRole(databaseClient.db, {
              actor: roleAdministrator,
              targetUserId: actor.id,
              enabled: true,
              correlationId: `financial-admin-regrant-cleanup-${randomUUID()}`,
            }),
            5_000,
            "Timed out restoring the sentinel administrator role",
          );
        } catch (error: unknown) {
          cleanupFailure ??= error;
        }
      }
      try {
        assertSentinelAbsent(
          "captured errors after artifact generation and cleanup",
          inspect(capturedErrors, { depth: null }),
          privateSentinelValues,
        );
      } catch (error: unknown) {
        cleanupFailure ??= error;
      }
      errorSpy.mockRestore();
    }
    if (testFailure !== undefined) throw testFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }, 90_000);

  it("denies a demoted administrator, then safely replays the crash window with a rotated token", async () => {
    const actor = await createAdministrator("denied-target");
    const roleAdministrator = await createAdministrator(
      "denied-role-authority",
    );
    const command = draftCommand();
    const correlationId = `financial-admin-denied-${randomUUID()}`;
    const submitted = await submitDraft(
      actor,
      command,
      randomUUID(),
      correlationId,
    );
    await setAdminRole(databaseClient.db, {
      actor: roleAdministrator,
      targetUserId: actor.id,
      enabled: false,
      correlationId: `financial-admin-pre-execution-demotion-${randomUUID()}`,
    });

    const tokens = [
      capability("denied-generation-1"),
      capability("denied-generation-2"),
    ];
    let capabilityIndex = 0;
    const postgresRepository = createPostgresJobRepository(
      workerDatabaseClient.db,
      { ...applicationConfig.jobs, leaseMs: 5_000 },
      undefined,
      "local-only",
      { classifierVersion: 1, allocationAlgorithmVersion: 1 },
      () => tokens[capabilityIndex++]!,
    );
    const executor = vi.fn<FinancialAdminCommandExecutor>(async () => ({
      refundId: command.refundId,
      draftVersion: 1,
      changed: true,
    }));
    const handler = createFinancialAdminCommandHandler({
      database: workerDatabaseClient.db,
      executors: executorsWithDraftSave(executor),
      accessMessages,
    });

    const firstClaim = await postgresRepository.claimNext(
      "denied-crash-worker",
    );
    expect(firstClaim).toMatchObject({
      type: FINANCIAL_ADMIN_COMMAND_JOB,
      financialAdminLeaseCapability: tokens[0],
    });
    await expect(
      handler(firstClaim!, new AbortController().signal),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(executor).not.toHaveBeenCalled();
    expect(await commandAndJob(submitted.commandId)).toMatchObject({
      command_status: "denied",
      safe_result_code: "capability_revoked",
      safe_result: null,
      job_status: "running",
      attempts: 1,
    });

    await expireJobLeaseForFixture(firstClaim!.id);
    const observations: RepositoryObservations = {
      claims: [],
      renewals: 0,
      completions: 0,
      failures: 0,
    };
    await runSingleClaim(
      observeRepository(postgresRepository, observations),
      handler,
      "denied-takeover-worker",
    );

    expect(observations.claims).toHaveLength(1);
    expect(observations.claims[0]).toMatchObject({
      attempts: 2,
      financialAdminLeaseCapability: tokens[1],
    });
    expect(new Set(tokens).size).toBe(2);
    expect(observations.completions).toBe(0);
    expect(observations.failures).toBe(1);
    expect(await commandAndJob(submitted.commandId)).toMatchObject({
      command_status: "denied",
      safe_result_code: "capability_revoked",
      job_status: "failed",
      attempts: 2,
    });
    const deniedAudits = await commandAuditRows(submitted.commandId);
    expectMinimalTerminalAudit({
      auditRows: deniedAudits,
      actor,
      commandId: submitted.commandId,
      commandKind: command.kind,
      correlationId,
      status: "denied",
      safeResultCode: "capability_revoked",
    });
    const minimized = JSON.stringify(deniedAudits);
    expect(minimized).not.toContain(command.refundId);
    expect(minimized).not.toContain(command.items[0]!.orderItemId);
    expect(minimized).not.toContain("privateInput");
    const linked = await commandAndJob(submitted.commandId);
    await expect(
      postgresRepository.renewLease(
        linked.job_id,
        "denied-crash-worker",
        tokens[0],
      ),
    ).resolves.toBe(false);
  }, 15_000);

  it("retries transient executor failures and synchronizes failed/command_failed only at exhaustion", async () => {
    const actor = await createAdministrator("transient-owner");
    const command = draftCommand();
    const correlationId = `financial-admin-failed-${randomUUID()}`;
    const submitted = await submitDraft(
      actor,
      command,
      randomUUID(),
      correlationId,
    );
    const issuedTokens: string[] = [];
    let generation = 0;
    const postgresRepository = createPostgresJobRepository(
      workerDatabaseClient.db,
      {
        ...applicationConfig.jobs,
        leaseMs: 5_000,
        retryBaseMs: 1,
        retryMaxMs: 1,
      },
      undefined,
      "local-only",
      { classifierVersion: 1, allocationAlgorithmVersion: 1 },
      () => {
        const token = capability(`transient-generation-${generation++}`);
        issuedTokens.push(token);
        return token;
      },
    );
    const privateOperationalDetail =
      "private operational detail must remain transient and hidden";
    const executor = vi.fn<FinancialAdminCommandExecutor>(async () => {
      throw new Error(privateOperationalDetail);
    });
    const handler = createFinancialAdminCommandHandler({
      database: workerDatabaseClient.db,
      executors: executorsWithDraftSave(executor),
      accessMessages,
    });
    const controller = new AbortController();
    const observations: RepositoryObservations = {
      claims: [],
      renewals: 0,
      completions: 0,
      failures: 0,
    };
    const repository = observeRepository(
      postgresRepository,
      observations,
      (job) => {
        if (job?.attempts === job?.maxAttempts) controller.abort();
      },
    );

    await runWorker({
      repository,
      handlers: new Map([[FINANCIAL_ADMIN_COMMAND_JOB, handler]]),
      workerId: "financial-admin-transient-worker",
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 1_000,
      signal: controller.signal,
    });

    expect(executor).toHaveBeenCalledTimes(8);
    expect(observations.claims.map((job) => job.attempts)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(observations.failures).toBe(8);
    expect(observations.completions).toBe(0);
    expect(issuedTokens).toHaveLength(8);
    expect(new Set(issuedTokens).size).toBe(8);
    expect(await commandAndJob(submitted.commandId)).toMatchObject({
      command_status: "failed",
      safe_result_code: "command_failed",
      safe_result: null,
      job_status: "failed",
      attempts: 8,
      last_error: "Transient job handler failure",
    });
    const failedAudits = await commandAuditRows(submitted.commandId);
    expectMinimalTerminalAudit({
      auditRows: failedAudits,
      actor,
      commandId: submitted.commandId,
      commandKind: command.kind,
      correlationId,
      status: "failed",
      safeResultCode: "command_failed",
    });
    const minimized = JSON.stringify(failedAudits);
    expect(minimized).not.toContain(command.refundId);
    expect(minimized).not.toContain(command.items[0]!.orderItemId);
    expect(minimized).not.toContain(privateOperationalDetail);
    expect(minimized).not.toContain("privateInput");
    const persisted = JSON.stringify(await commandAndJob(submitted.commandId));
    for (const token of issuedTokens) expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(privateOperationalDetail);
  }, 20_000);
});
