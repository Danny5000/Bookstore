import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { AdministratorActor } from "$lib/server/auth/admin-policy";
import { setAdminRole } from "$lib/server/auth/roles";
import { createFinancialAdminCommandExecutors } from "$lib/server/commerce/financial/admin-commands/executors";
import {
  FINANCIAL_ADMIN_COMMAND_JOB,
  createFinancialAdminCommandHandler,
  type FinancialAdminCommandExecutor,
} from "$lib/server/commerce/financial/admin-commands/handler";
import {
  getFinancialAdminCommandStatus,
  submitFinancialAdminCommand,
} from "$lib/server/commerce/financial/admin-commands/repository";
import type { FinancialAdminPrivateCommand } from "$lib/server/commerce/financial/admin-commands/contracts";
import { createPostgresJobRepository } from "$lib/server/jobs/repository";
import { PermanentJobError, runWorker } from "$lib/server/jobs/runner";
import type { JobRecord, JobRepository } from "$lib/server/jobs/types";
import type { FinancialAdminCommandKind } from "$lib/types/financial-reporting";
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient,
} from "./database";

const FORBIDDEN_STATUS_FIELDS =
  /jobId|payload|attempts|lastError|privateInput|actorUserId|internalError/iu;

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

async function submitDraft(
  actor: AdministratorActor,
  command: FinancialAdminPrivateCommand & { kind: "refund_draft_save" },
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
  };
}

async function runSingleClaim(
  repository: JobRepository,
  handler: ReturnType<typeof createFinancialAdminCommandHandler>,
  workerId: string,
  heartbeatIntervalMs = 20,
): Promise<void> {
  const controller = new AbortController();
  let polls = 0;
  await runWorker({
    repository,
    handlers: new Map([[FINANCIAL_ADMIN_COMMAND_JOB, handler]]),
    workerId,
    concurrency: 1,
    pollIntervalMs: 1,
    heartbeatIntervalMs,
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

describe("financial administrator command PostgreSQL lifecycle", () => {
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

  it("runs a claimed local-only command with heartbeat renewal and serializes concurrent demotion", async () => {
    const actor = await createAdministrator("runner-target");
    const roleAdministrator = await createAdministrator(
      "runner-role-authority",
    );
    const command = draftCommand();
    const submitted = await submitDraft(actor, command);
    const executorStarted = deferred();
    const releaseExecutor = deferred();
    const secret = capability("runner-success-secret-sentinel");
    const executor = vi.fn<FinancialAdminCommandExecutor>(async () => {
      executorStarted.resolve();
      await releaseExecutor.promise;
      return { refundId: command.refundId, draftVersion: 1, changed: true };
    });
    const handler = createFinancialAdminCommandHandler({
      database: workerDatabaseClient.db,
      executors: executorsWithDraftSave(executor),
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
    const worker = runSingleClaim(
      repository,
      handler,
      "financial-admin-success-worker",
      10,
    );

    await executorStarted.promise;
    let demotionSettled = false;
    const demotion = setAdminRole(databaseClient.db, {
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
    await Promise.all([worker, demotion]);

    expect(executor).toHaveBeenCalledOnce();
    expect(observations.claims).toHaveLength(1);
    expect(observations.claims[0]).toMatchObject({
      type: FINANCIAL_ADMIN_COMMAND_JOB,
      payload: { commandId: submitted.commandId },
      financialAdminLeaseCapability: secret,
    });
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

    const secretLeak = await ownerDatabaseClient.pool.query<{
      job_leaks: number;
      command_leaks: number;
      claim_leaks: number;
      audit_leaks: number;
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
         where row_to_json(audit_events)::text like '%' || $1 || '%') as audit_leaks
    `,
      [secret],
    );
    expect(secretLeak.rows).toEqual([
      {
        job_leaks: 0,
        command_leaks: 0,
        claim_leaks: 0,
        audit_leaks: 0,
      },
    ]);
    await expect(
      ownerDatabaseClient.pool.query(
        `
      select state, capability_sha256, invalidated_at is not null as invalidated
      from financial_admin_job_claims where job_id = $1
    `,
        [(await commandAndJob(submitted.commandId)).job_id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "invalidated",
          capability_sha256: createHash("sha256").update(secret).digest("hex"),
          invalidated: true,
        },
      ],
    });

    await setAdminRole(databaseClient.db, {
      actor: roleAdministrator,
      targetUserId: actor.id,
      enabled: true,
      correlationId: `financial-admin-regrant-${randomUUID()}`,
    });
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
  }, 15_000);

  it("denies a demoted administrator, then safely replays the crash window with a rotated token", async () => {
    const actor = await createAdministrator("denied-target");
    const roleAdministrator = await createAdministrator(
      "denied-role-authority",
    );
    const command = draftCommand();
    const submitted = await submitDraft(actor, command);
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
      { ...applicationConfig.jobs, leaseMs: 60 },
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

    await delay(100);
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
    await expect(
      ownerDatabaseClient.pool.query(
        `
      select count(*)::integer as count from audit_events
      where action = 'financial.admin_command.denied' and resource_id = $1
    `,
        [submitted.commandId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
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
    const submitted = await submitDraft(actor, command);
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
    const executor = vi.fn<FinancialAdminCommandExecutor>(async () => {
      throw new Error(
        "private operational detail must remain transient and hidden",
      );
    });
    const handler = createFinancialAdminCommandHandler({
      database: workerDatabaseClient.db,
      executors: executorsWithDraftSave(executor),
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
      heartbeatIntervalMs: 1_000,
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
    await expect(
      ownerDatabaseClient.pool.query(
        `
      select count(*)::integer as count from audit_events
      where action = 'financial.admin_command.failed' and resource_id = $1
    `,
        [submitted.commandId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    const persisted = JSON.stringify(await commandAndJob(submitted.commandId));
    for (const token of issuedTokens) expect(persisted).not.toContain(token);
    expect(persisted).not.toContain("private operational detail");
  }, 20_000);
});
