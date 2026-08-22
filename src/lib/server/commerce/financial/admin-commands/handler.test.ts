import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityResolver } from "$lib/server/auth/admin-policy";
import type { AccessChangeInput } from "$lib/server/commerce/email/enqueue";
import type { Database } from "$lib/server/db/client";
import type { DatabaseTransaction } from "$lib/server/db/transaction";
import type { JobRecord } from "$lib/server/jobs/types";
import { PermanentJobError } from "$lib/server/jobs/runner";
import type {
  FinancialAdminCommandKind,
  FinancialAdminCommandStatus,
  FinancialAdminCommandSafeResultDto,
} from "$lib/types/financial-reporting";
import { createFinancialAdminCommandExecutors } from "./executors";
import {
  executeRefundDraftDiscard,
  executeRefundDraftSave,
} from "../refund-review/drafts";
import {
  FINANCIAL_ADMIN_COMMAND_JOB,
  FinancialAdminConflictError,
  FinancialAdminDeniedError,
  FinancialAdminPermanentError,
  createFinancialAdminCommandHandler,
  type FinancialAdminCommandExecutor,
} from "./handler";

const JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMMAND_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEASE_CAPABILITY = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
const HASH = "a".repeat(64);
const ACCESS_CHANGE_INPUT = {
  template: "commerce.refund-access-changed",
  eventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  to: "financial-access@example.com",
  reasonCategory: "refund_completed",
  affectedTitleCount: 1,
} satisfies AccessChangeInput;

const PRIVATE_COMMAND = {
  kind: "refund_draft_save",
  refundId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  expectedVersion: null,
  items: [
    {
      orderItemId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      totalPresentmentMinor: 1250,
    },
  ],
} as const;

const SAFE_RESULT: FinancialAdminCommandSafeResultDto = {
  refundId: PRIVATE_COMMAND.refundId,
  draftVersion: 1,
  changed: true,
};

interface LockedCommand {
  id: string;
  kind: FinancialAdminCommandKind;
  actorUserId: string;
  correlationId: string;
  idempotencyKeySha256: string;
  inputFingerprintSha256: string;
  jobId: string;
  status: FinancialAdminCommandStatus;
}

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`,
  });
}

function baseJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: JOB_ID,
    type: FINANCIAL_ADMIN_COMMAND_JOB,
    payload: { commandId: COMMAND_ID },
    deduplicationKey: `commerce:financial-admin-command:${COMMAND_ID}:v1`,
    attempts: 1,
    maxAttempts: 8,
    lockedBy: "financial-worker-test",
    financialAdminLeaseCapability: LEASE_CAPABILITY,
    ...overrides,
  };
}

function baseLockedCommand(
  overrides: Partial<LockedCommand> = {},
): LockedCommand {
  return {
    id: COMMAND_ID,
    kind: "refund_draft_save",
    actorUserId: ACTOR_ID,
    correlationId: "financial-command-test",
    idempotencyKeySha256: HASH,
    inputFingerprintSha256: HASH,
    jobId: JOB_ID,
    status: "pending",
    ...overrides,
  };
}

class FakeCommandTransaction {
  readonly operations: string[] = [];
  readonly executed: Array<{ sql: string; params: unknown[] }> = [];
  readonly terminalUpdates: Array<Record<string, unknown>> = [];

  constructor(
    private readonly command: LockedCommand,
    private readonly privateInput: unknown,
    private readonly roles: readonly ("customer" | "admin")[],
  ) {}

  async execute(query: SQL): Promise<{ rows: unknown[] }> {
    const statement = rendered(query);
    const normalized = statement.sql.replaceAll(/\s+/gu, " ").trim();
    this.executed.push(statement);

    if (normalized.includes("plan6bii_financial_admin_job_capability")) {
      this.operations.push("set-capability");
      return { rows: [{}] };
    }
    if (normalized.includes("pale-orbit:user-roles:admin")) {
      this.operations.push("role-lock");
      return { rows: [{}] };
    }
    if (normalized.includes("pale-orbit:plan6bii-financial-admin-job-lease:")) {
      this.operations.push("shared-lease-lock");
      return { rows: [{}] };
    }
    if (
      normalized.includes('from "public"."financial_admin_commands"') &&
      normalized.endsWith("for update")
    ) {
      this.operations.push("command-lock");
      return { rows: [{ ...this.command }] };
    }
    throw new Error(
      `Unexpected SQL in fake command transaction: ${normalized}`,
    );
  }

  select(fields?: Record<string, unknown>): unknown {
    const privateInputSelection =
      fields !== undefined && Object.hasOwn(fields, "privateInput");
    const builder = {
      from: () => builder,
      where: async () => {
        if (privateInputSelection) {
          this.operations.push("private-input");
          return [{ privateInput: this.privateInput }];
        }
        this.operations.push("roles");
        return this.roles.map((role) => ({ role }));
      },
    };
    return builder;
  }

  update(): unknown {
    return {
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            this.operations.push("terminal-update");
            this.terminalUpdates.push(values);
            this.command.status = values.status as FinancialAdminCommandStatus;
            return [{ id: this.command.id }];
          },
        }),
      }),
    };
  }
}

class FakeCommandDatabase {
  readonly transactions: FakeCommandTransaction[] = [];
  readonly command: LockedCommand;
  privateInput: unknown;
  roles: readonly ("customer" | "admin")[];

  constructor(
    input: {
      command?: LockedCommand;
      privateInput?: unknown;
      roles?: readonly ("customer" | "admin")[];
    } = {},
  ) {
    this.command = input.command ?? baseLockedCommand();
    this.privateInput = input.privateInput ?? PRIVATE_COMMAND;
    this.roles = input.roles ?? ["customer", "admin"];
  }

  async transaction<T>(
    work: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const snapshot = { ...this.command };
    const transaction = new FakeCommandTransaction(
      this.command,
      this.privateInput,
      this.roles,
    );
    this.transactions.push(transaction);
    try {
      return await work(transaction as unknown as DatabaseTransaction);
    } catch (error) {
      Object.assign(this.command, snapshot);
      throw error;
    }
  }
}

function sixExecutors(
  refundDraftSave: FinancialAdminCommandExecutor = vi.fn(
    async () => SAFE_RESULT,
  ),
): ReadonlyMap<FinancialAdminCommandKind, FinancialAdminCommandExecutor> {
  return createFinancialAdminCommandExecutors({
    refundDraftSave,
    refundDraftDiscard: vi.fn(async () => SAFE_RESULT),
    refundAllocationFinalize: vi.fn(async () => SAFE_RESULT),
    refundReportingCorrectionCreate: vi.fn(async () => SAFE_RESULT),
    administrativeRecoveryActivate: vi.fn(async () => SAFE_RESULT),
    administrativeRecoveryDeactivate: vi.fn(async () => SAFE_RESULT),
  });
}

function handlerFor(
  database: FakeCommandDatabase,
  executor: FinancialAdminCommandExecutor = vi.fn(async () => SAFE_RESULT),
  capabilityResolver?: CapabilityResolver,
) {
  return createFinancialAdminCommandHandler({
    database: database as unknown as Database,
    executors: sixExecutors(executor),
    accessMessages: { enqueueAccessChange: vi.fn(async () => undefined) },
    ...(capabilityResolver ? { capabilityResolver } : {}),
  });
}

describe("createFinancialAdminCommandExecutors", () => {
  it("composes the two real draft executors with four distinct future-task stubs", () => {
    const futureStub = (label: string): FinancialAdminCommandExecutor =>
      vi.fn(async () => {
        throw new Error(`${label} executor is not implemented in Task 11`);
      });
    const executors = createFinancialAdminCommandExecutors({
      refundDraftSave: executeRefundDraftSave as FinancialAdminCommandExecutor,
      refundDraftDiscard: executeRefundDraftDiscard as FinancialAdminCommandExecutor,
      refundAllocationFinalize: futureStub("finalize"),
      refundReportingCorrectionCreate: futureStub("correction"),
      administrativeRecoveryActivate: futureStub("recovery-activate"),
      administrativeRecoveryDeactivate: futureStub("recovery-deactivate"),
    });

    expect(executors.get("refund_draft_save")).toBe(executeRefundDraftSave);
    expect(executors.get("refund_draft_discard")).toBe(executeRefundDraftDiscard);
    expect(new Set(executors.values()).size).toBe(6);
  });

  it("constructs exactly the six fixed command-kind bindings", () => {
    const dependencies = {
      refundDraftSave: vi.fn(),
      refundDraftDiscard: vi.fn(),
      refundAllocationFinalize: vi.fn(),
      refundReportingCorrectionCreate: vi.fn(),
      administrativeRecoveryActivate: vi.fn(),
      administrativeRecoveryDeactivate: vi.fn(),
    } satisfies Record<string, FinancialAdminCommandExecutor>;

    const executors = createFinancialAdminCommandExecutors(dependencies);

    expect([...executors]).toEqual([
      ["refund_draft_save", dependencies.refundDraftSave],
      ["refund_draft_discard", dependencies.refundDraftDiscard],
      ["refund_allocation_finalize", dependencies.refundAllocationFinalize],
      [
        "refund_reporting_correction_create",
        dependencies.refundReportingCorrectionCreate,
      ],
      [
        "administrative_recovery_activate",
        dependencies.administrativeRecoveryActivate,
      ],
      [
        "administrative_recovery_deactivate",
        dependencies.administrativeRecoveryDeactivate,
      ],
    ]);
    expect(executors.size).toBe(6);
  });

  it("rejects missing, duplicate, unknown, or non-callable dependencies", () => {
    const stub = vi.fn();
    const valid = {
      refundDraftSave: vi.fn(),
      refundDraftDiscard: vi.fn(),
      refundAllocationFinalize: vi.fn(),
      refundReportingCorrectionCreate: vi.fn(),
      administrativeRecoveryActivate: vi.fn(),
      administrativeRecoveryDeactivate: vi.fn(),
    };

    const missing: Partial<typeof valid> = { ...valid };
    Reflect.deleteProperty(missing, "refundDraftSave");
    expect(() =>
      createFinancialAdminCommandExecutors(missing as never),
    ).toThrow(/exactly six/u);
    expect(() =>
      createFinancialAdminCommandExecutors({
        ...valid,
        unexpectedKind: vi.fn(),
      } as never),
    ).toThrow(/exactly six/u);
    expect(() =>
      createFinancialAdminCommandExecutors({
        ...valid,
        refundDraftSave: stub,
        refundDraftDiscard: stub,
      }),
    ).toThrow(/duplicate/u);
    expect(() =>
      createFinancialAdminCommandExecutors({
        ...valid,
        refundDraftSave: "not-a-function",
      } as never),
    ).toThrow(/callable/u);
  });
});

describe("financial administrator command job identity", () => {
  it.each([
    ["wrong job type", { type: "commerce.other" }],
    ["missing payload key", { payload: {} }],
    ["extra payload key", { payload: { commandId: COMMAND_ID, extra: true } }],
    [
      "noncanonical command UUID",
      { payload: { commandId: COMMAND_ID.toUpperCase() } },
    ],
    ["noncanonical job UUID", { id: JOB_ID.toUpperCase() }],
    [
      "wrong dedupe",
      { deduplicationKey: `commerce:financial-admin-command:${COMMAND_ID}:v2` },
    ],
    ["wrong maximum attempts", { maxAttempts: 7 }],
    ["unclaimed attempt", { attempts: 0 }],
    ["missing capability", { financialAdminLeaseCapability: undefined }],
    [
      "short capability",
      { financialAdminLeaseCapability: LEASE_CAPABILITY.slice(1) },
    ],
    [
      "long capability",
      { financialAdminLeaseCapability: `${LEASE_CAPABILITY}A` },
    ],
    [
      "padded capability",
      { financialAdminLeaseCapability: `${LEASE_CAPABILITY.slice(0, 42)}=` },
    ],
  ])("rejects %s before opening a transaction", async (_name, overrides) => {
    const database = new FakeCommandDatabase();
    const handler = handlerFor(database);

    await expect(
      handler(
        baseJob(overrides as Partial<JobRecord>),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(database.transactions).toHaveLength(0);
  });

  it("fails proxy and accessor payloads cause-free before opening a transaction", async () => {
    const trapCanary = "private-job-payload-trap-canary";
    const accessorPayload = {};
    Object.defineProperty(accessorPayload, "commandId", {
      enumerable: true,
      get: () => {
        throw new Error(trapCanary);
      },
    });
    const proxyPayload = new Proxy(
      { commandId: COMMAND_ID },
      {
        ownKeys: () => {
          throw new Error(trapCanary);
        },
      },
    );

    for (const payload of [accessorPayload, proxyPayload]) {
      const database = new FakeCommandDatabase();
      const error = await handlerFor(database)(
        baseJob({ payload: payload as JobRecord["payload"] }),
        new AbortController().signal,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(String(error)).not.toContain(trapCanary);
      expect(database.transactions).toHaveLength(0);
    }
  });
});

describe("financial administrator command handler state machine", () => {
  it("requires a callable access-message dependency at construction", () => {
    const database = new FakeCommandDatabase();
    const executors = sixExecutors();

    expect(() =>
      createFinancialAdminCommandHandler({
        database: database as unknown as Database,
        executors,
      } as never),
    ).toThrow(/access-message dependency/u);
    expect(() =>
      createFinancialAdminCommandHandler({
        database: database as unknown as Database,
        executors,
        accessMessages: { enqueueAccessChange: "not-callable" },
      } as never),
    ).toThrow(/access-message dependency/u);
  });

  it("binds only a unary access-message capability to the current command transaction", async () => {
    const database = new FakeCommandDatabase();
    const enqueueAccessChange = vi.fn(async () => undefined);
    const executor = vi.fn<FinancialAdminCommandExecutor>(async (context) => {
      await context.enqueueAccessChange(ACCESS_CHANGE_INPUT);
      return SAFE_RESULT;
    });
    const handler = createFinancialAdminCommandHandler({
      database: database as unknown as Database,
      executors: sixExecutors(executor),
      accessMessages: { enqueueAccessChange },
    });

    await expect(
      handler(baseJob(), new AbortController().signal),
    ).resolves.toBeUndefined();

    const [executorContext] = executor.mock.calls[0]!;
    expect(executorContext).not.toHaveProperty("accessMessages");
    expect(executorContext.enqueueAccessChange).toHaveLength(1);
    expect(enqueueAccessChange).toHaveBeenCalledOnce();
    expect(enqueueAccessChange.mock.calls[0]).toEqual([
      database.transactions[0],
      ACCESS_CHANGE_INPUT,
    ]);
  });

  it("sets the opaque token locally, locks role then lease then command, authorizes, and succeeds", async () => {
    const database = new FakeCommandDatabase();
    const executor = vi.fn(async () => SAFE_RESULT);
    const handler = handlerFor(database, executor);
    const signal = new AbortController().signal;

    await expect(handler(baseJob(), signal)).resolves.toBeUndefined();

    expect(database.transactions).toHaveLength(1);
    const [transaction] = database.transactions;
    expect(transaction?.operations).toEqual([
      "set-capability",
      "role-lock",
      "shared-lease-lock",
      "command-lock",
      "roles",
      "private-input",
      "terminal-update",
    ]);
    expect(transaction?.executed[0]?.params).toEqual([LEASE_CAPABILITY]);
    expect(transaction?.executed[2]?.params).toEqual([JOB_ID]);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(
      {
        transaction: expect.anything(),
        commandId: COMMAND_ID,
        actor: { type: "user", id: ACTOR_ID, roles: ["customer", "admin"] },
        correlationId: "financial-command-test",
        signal,
        enqueueAccessChange: expect.any(Function),
      },
      PRIVATE_COMMAND,
    );
    expect(transaction?.terminalUpdates).toHaveLength(1);
    expect(transaction?.terminalUpdates[0]).toMatchObject({
      status: "succeeded",
      safeResultCode: "draft_saved",
      safeResult: SAFE_RESULT,
    });
  });

  it("reauthorizes both fixed capabilities before selecting private input", async () => {
    const database = new FakeCommandDatabase();
    const executor = vi.fn(async () => SAFE_RESULT);
    const resolver = vi.fn(() => new Set(["sales.read"] as const));
    const handler = handlerFor(database, executor, resolver);

    await expect(
      handler(baseJob(), new AbortController().signal),
    ).rejects.toBeInstanceOf(PermanentJobError);

    expect(executor).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledWith(["customer", "admin"]);
    expect(database.transactions).toHaveLength(2);
    expect(database.transactions[0]?.operations).toEqual([
      "set-capability",
      "role-lock",
      "shared-lease-lock",
      "command-lock",
      "roles",
    ]);
    expect(database.transactions[1]?.operations).toEqual([
      "set-capability",
      "role-lock",
      "shared-lease-lock",
      "command-lock",
      "terminal-update",
    ]);
    expect(database.transactions[1]?.terminalUpdates[0]).toMatchObject({
      status: "denied",
      safeResultCode: "capability_revoked",
      safeResult: null,
    });
  });

  it("returns succeeded terminal replay and permanently rejects other terminal replays without mutation", async () => {
    const succeededDatabase = new FakeCommandDatabase({
      command: baseLockedCommand({ status: "succeeded" }),
    });
    const succeededExecutor = vi.fn(async () => SAFE_RESULT);
    await expect(
      handlerFor(succeededDatabase, succeededExecutor)(
        baseJob(),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    expect(succeededExecutor).not.toHaveBeenCalled();
    expect(succeededDatabase.transactions).toHaveLength(1);
    expect(succeededDatabase.transactions[0]?.operations).toEqual([
      "set-capability",
      "role-lock",
      "shared-lease-lock",
      "command-lock",
    ]);

    for (const status of ["denied", "conflict", "failed"] as const) {
      const database = new FakeCommandDatabase({
        command: baseLockedCommand({ status }),
      });
      const executor = vi.fn(async () => SAFE_RESULT);
      await expect(
        handlerFor(database, executor)(baseJob(), new AbortController().signal),
      ).rejects.toBeInstanceOf(PermanentJobError);
      expect(executor).not.toHaveBeenCalled();
      expect(database.transactions).toHaveLength(1);
      expect(database.transactions[0]?.operations).toEqual([
        "set-capability",
        "role-lock",
        "shared-lease-lock",
        "command-lock",
      ]);
    }
  });

  it.each([
    [
      new FinancialAdminDeniedError("capability_revoked"),
      "denied",
      "capability_revoked",
    ],
    [new FinancialAdminConflictError("stale_state"), "conflict", "stale_state"],
    [
      new FinancialAdminConflictError("not_eligible"),
      "conflict",
      "not_eligible",
    ],
    [
      new FinancialAdminPermanentError("invalid_command"),
      "failed",
      "invalid_command",
    ],
  ] as const)(
    "rolls back %s and uses a fresh ordered transaction for %s/%s",
    async (typedError, status, safeCode) => {
      const database = new FakeCommandDatabase();
      const executor = vi.fn(async () => {
        throw typedError;
      });
      const handler = handlerFor(database, executor);

      await expect(
        handler(baseJob(), new AbortController().signal),
      ).rejects.toBeInstanceOf(PermanentJobError);

      expect(executor).toHaveBeenCalledTimes(1);
      expect(database.transactions).toHaveLength(2);
      expect(database.transactions[1]?.operations).toEqual([
        "set-capability",
        "role-lock",
        "shared-lease-lock",
        "command-lock",
        "terminal-update",
      ]);
      expect(database.transactions[1]?.executed[0]?.params).toEqual([
        LEASE_CAPABILITY,
      ]);
      expect(database.transactions[1]?.terminalUpdates[0]).toMatchObject({
        status,
        safeResultCode: safeCode,
        safeResult: null,
      });
    },
  );

  it("defers failed/command_failed to the runner terminal-sync authority", async () => {
    const database = new FakeCommandDatabase();
    const executor = vi.fn(async () => {
      throw new FinancialAdminPermanentError("command_failed");
    });

    await expect(
      handlerFor(database, executor)(baseJob(), new AbortController().signal),
    ).rejects.toBeInstanceOf(PermanentJobError);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(database.transactions).toHaveLength(1);
    expect(database.transactions[0]?.terminalUpdates).toHaveLength(0);
    expect(database.command.status).toBe("pending");
  });

  it("stores malformed private input as failed/invalid_command without calling an executor", async () => {
    const database = new FakeCommandDatabase({
      privateInput: { ...PRIVATE_COMMAND, unexpected: "private" },
    });
    const executor = vi.fn(async () => SAFE_RESULT);

    await expect(
      handlerFor(database, executor)(baseJob(), new AbortController().signal),
    ).rejects.toBeInstanceOf(PermanentJobError);

    expect(executor).not.toHaveBeenCalled();
    expect(database.transactions).toHaveLength(2);
    expect(database.transactions[1]?.terminalUpdates[0]).toMatchObject({
      status: "failed",
      safeResultCode: "invalid_command",
      safeResult: null,
    });
  });

  it("defers a malformed executor result to runner-owned failed/command_failed sync", async () => {
    const database = new FakeCommandDatabase();
    const executor = vi.fn(
      async () => ({ ...SAFE_RESULT, internal: "not-safe" }) as never,
    );

    await expect(
      handlerFor(database, executor)(baseJob(), new AbortController().signal),
    ).rejects.toBeInstanceOf(PermanentJobError);

    expect(database.transactions).toHaveLength(1);
    expect(database.transactions[0]?.terminalUpdates).toHaveLength(0);
    expect(database.command.status).toBe("pending");
  });

  it("leaves pending state and rethrows an untyped transient executor error", async () => {
    const database = new FakeCommandDatabase();
    const transient = new Error("transient-safe-test-error");
    const executor = vi.fn(async () => {
      throw transient;
    });

    await expect(
      handlerFor(database, executor)(baseJob(), new AbortController().signal),
    ).rejects.toBe(transient);

    expect(database.transactions).toHaveLength(1);
    expect(database.transactions[0]?.terminalUpdates).toHaveLength(0);
    expect(database.command.status).toBe("pending");
  });

  it("respects lease aborts before domain work and before terminal update/commit", async () => {
    const beforeDatabase = new FakeCommandDatabase();
    const beforeExecutor = vi.fn(async () => SAFE_RESULT);
    const beforeController = new AbortController();
    beforeController.abort();
    await expect(
      handlerFor(beforeDatabase, beforeExecutor)(
        baseJob(),
        beforeController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(beforeDatabase.transactions).toHaveLength(0);
    expect(beforeExecutor).not.toHaveBeenCalled();

    const duringDatabase = new FakeCommandDatabase();
    const duringController = new AbortController();
    const duringExecutor = vi.fn(async () => {
      duringController.abort();
      return SAFE_RESULT;
    });
    await expect(
      handlerFor(duringDatabase, duringExecutor)(
        baseJob(),
        duringController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(duringDatabase.transactions).toHaveLength(1);
    expect(duringDatabase.transactions[0]?.terminalUpdates).toHaveLength(0);
    expect(duringDatabase.command.status).toBe("pending");
  });

  it("rejects a cross-job command identity before roles, private input, or executor work", async () => {
    const database = new FakeCommandDatabase({
      command: baseLockedCommand({
        jobId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      }),
    });
    const executor = vi.fn(async () => SAFE_RESULT);

    await expect(
      handlerFor(database, executor)(baseJob(), new AbortController().signal),
    ).rejects.toBeInstanceOf(PermanentJobError);

    expect(executor).not.toHaveBeenCalled();
    expect(database.transactions).toHaveLength(1);
    expect(database.transactions[0]?.operations).toEqual([
      "set-capability",
      "role-lock",
      "shared-lease-lock",
      "command-lock",
    ]);
  });
});
