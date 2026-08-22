import { createHash, randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Actor,
  AdminCapability,
  AdministratorActor,
  CapabilityResolver
} from '$lib/server/auth/admin-policy';
import { AuthorizationError } from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { listRolesForUser } from '$lib/server/auth/identity';
import {
  getFinancialAdminCommandStatus,
  submitFinancialAdminCommand
} from './repository';

vi.mock('$lib/server/auth/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/auth/identity')>()),
  listRolesForUser: vi.fn()
}));

const ACTOR_ID = '00000000-0000-4000-8000-000000004001';
const COMMAND_ID = '00000000-0000-4000-8000-000000004002';
const IDEMPOTENCY_KEY = 'abcdef00-0000-4000-8000-000000004003';
const REFUND_ID = '00000000-0000-4000-8000-000000004004';
const ITEM_ID = '00000000-0000-4000-8000-000000004005';
const CREATED_AT = new Date('2026-08-22T12:00:00.000Z');
const UPDATED_AT = new Date('2026-08-22T12:01:00.000Z');
const POSTGRES_CREATED_AT = '2026-08-22 12:00:00.123456+00';
const POSTGRES_UPDATED_AT = '2026-08-22 12:01:00.654321+00';

const admin: AdministratorActor = {
  type: 'user',
  id: ACTOR_ID,
  roles: ['customer', 'admin']
};

const command = {
  kind: 'refund_draft_save' as const,
  refundId: REFUND_ID,
  expectedVersion: null,
  items: [{ orderItemId: ITEM_ID, totalPresentmentMinor: 500 }]
};

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
}

function databaseWithRows(rowsByCall: readonly unknown[][]): {
  readonly database: Database;
  readonly calls: SQL[];
} {
  const calls: SQL[] = [];
  let index = 0;
  const transaction = {
    execute: vi.fn(async (query: SQL) => {
      calls.push(query);
      return { rows: rowsByCall[index++] ?? [] };
    })
  } as unknown as DatabaseTransaction;
  const database = {
    transaction: vi.fn(async (work: (tx: DatabaseTransaction) => Promise<unknown>) =>
      work(transaction))
  } as unknown as Database;
  return { database, calls };
}

function submissionInput() {
  return {
    actor: admin,
    idempotencyKey: IDEMPOTENCY_KEY,
    command,
    context: {
      correlationId: 'financial-admin-command-4001',
      requestMetadata: {
        method: 'POST',
        routeId: `/admin/sales/refunds/${REFUND_ID}`
      }
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listRolesForUser).mockResolvedValue(['customer', 'admin']);
});

describe('financial administrator command submission repository', () => {
  it('authorizes the shared fixed capability map before inspecting private command fields', async () => {
    const itemsGetter = vi.fn(() => command.items);
    const privateCommand = { ...command } as Record<string, unknown>;
    Object.defineProperty(privateCommand, 'items', { enumerable: true, get: itemsGetter });
    const database = { transaction: vi.fn() } as unknown as Database;
    const resolver: CapabilityResolver = () => new Set<AdminCapability>(['sales.read']);

    await expect(submitFinancialAdminCommand(database, {
      ...submissionInput(),
      command: privateCommand as never
    }, { capabilityResolver: resolver })).rejects.toEqual(
      new AuthorizationError('forbidden', 403)
    );

    expect(itemsGetter).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects a noncanonical idempotency UUID before hashing or opening a transaction', async () => {
    const database = { transaction: vi.fn() } as unknown as Database;
    await expect(submitFinancialAdminCommand(database, {
      ...submissionInput(),
      idempotencyKey: IDEMPOTENCY_KEY.toUpperCase()
    })).rejects.toThrow();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('locks roles, reloads and reauthorizes, then calls only the fixed submit routine', async () => {
    const { database, calls } = databaseWithRows([
      [],
      [{
        commandId: COMMAND_ID,
        kind: command.kind,
        status: 'pending',
        createdAt: POSTGRES_CREATED_AT
      }]
    ]);
    const resolver = vi.fn(() => new Set<AdminCapability>([
      'sales.read',
      'reconciliation.manage'
    ]));

    await expect(submitFinancialAdminCommand(
      database,
      submissionInput(),
      { capabilityResolver: resolver }
    )).resolves.toEqual({
      commandId: COMMAND_ID,
      kind: command.kind,
      status: 'pending',
      createdAt: '2026-08-22T12:00:00.123Z'
    });

    expect(resolver).toHaveBeenNthCalledWith(1, admin.roles);
    expect(listRolesForUser).toHaveBeenCalledWith(expect.anything(), ACTOR_ID);
    expect(resolver).toHaveBeenNthCalledWith(2, ['customer', 'admin']);
    expect(calls).toHaveLength(2);
    expect(rendered(calls[0]!).sql).toContain(
      "pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))"
    );
    const submitted = rendered(calls[1]!);
    expect(submitted.sql).toContain('from public.submit_financial_admin_command(');
    expect(submitted.sql).not.toMatch(/\b(?:insert|update|delete)\b/iu);
    const canonicalCommand = JSON.stringify(command);
    expect(submitted.params).toEqual([
      ACTOR_ID,
      'financial-admin-command-4001',
      command.kind,
      createHash('sha256').update(IDEMPOTENCY_KEY).digest('hex'),
      createHash('sha256').update(canonicalCommand).digest('hex'),
      canonicalCommand
    ]);
  });

  it('rejects missing, duplicate, or malformed routine rows instead of guessing', async () => {
    for (const rows of [
      [],
      [
        { commandId: COMMAND_ID, kind: command.kind, status: 'pending', createdAt: CREATED_AT },
        { commandId: randomUUID(), kind: command.kind, status: 'pending', createdAt: CREATED_AT }
      ],
      [{
        commandId: COMMAND_ID,
        kind: command.kind,
        status: 'pending',
        createdAt: CREATED_AT,
        privateInput: command
      }]
    ]) {
      const { database } = databaseWithRows([[], rows]);
      const failure = await submitFinancialAdminCommand(database, submissionInput())
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: 'FinancialAdminCommandRepositoryError',
        message: 'Financial administrator command repository returned invalid data.'
      });
      expect(failure).not.toHaveProperty('cause');
    }
  });
});

describe('financial administrator safe status repository', () => {
  it('requires sales.read before parsing the command id or entering a transaction', async () => {
    const database = { transaction: vi.fn() } as unknown as Database;
    const actor: Actor = { type: 'user', id: ACTOR_ID, roles: ['customer'] };
    await expect(getFinancialAdminCommandStatus(
      database,
      actor,
      'private malformed id'
    )).rejects.toEqual(new AuthorizationError('forbidden', 403));
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('uses the role lock/reload sequence and only the actor-scoped status routine', async () => {
    const { database, calls } = databaseWithRows([
      [],
      [{
        commandId: COMMAND_ID,
        kind: command.kind,
        status: 'pending',
        resultCode: null,
        result: null,
        createdAt: POSTGRES_CREATED_AT,
        updatedAt: POSTGRES_UPDATED_AT,
        completedAt: null
      }]
    ]);

    await expect(getFinancialAdminCommandStatus(database, admin, COMMAND_ID)).resolves.toEqual({
      commandId: COMMAND_ID,
      kind: command.kind,
      status: 'pending',
      resultCode: null,
      result: null,
      createdAt: '2026-08-22T12:00:00.123Z',
      updatedAt: '2026-08-22T12:01:00.654Z',
      completedAt: null
    });

    expect(calls).toHaveLength(2);
    expect(rendered(calls[0]!).sql).toContain(
      "pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))"
    );
    const status = rendered(calls[1]!);
    expect(status.sql).toContain('from public.financial_admin_command_status(');
    expect(status.params).toEqual([ACTOR_ID, COMMAND_ID]);
    expect(JSON.stringify(status)).not.toMatch(
      /job_id|payload|attempts|last_error|private_input|actor_user_id|internal_error/iu
    );
  });

  it('returns null only for an absent or foreign command and rejects malformed results', async () => {
    const absent = databaseWithRows([[], []]);
    await expect(getFinancialAdminCommandStatus(
      absent.database,
      admin,
      COMMAND_ID
    )).resolves.toBeNull();

    const malformed = databaseWithRows([[], [{
      commandId: COMMAND_ID,
      kind: command.kind,
      status: 'succeeded',
      resultCode: 'draft_saved',
      result: { refundId: REFUND_ID, draftVersion: 1, changed: true },
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      completedAt: UPDATED_AT,
      jobId: randomUUID()
    }]]);
    const failure = await getFinancialAdminCommandStatus(
      malformed.database,
      admin,
      COMMAND_ID
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: 'FinancialAdminCommandRepositoryError',
      message: 'Financial administrator command repository returned invalid data.'
    });
    expect(failure).not.toHaveProperty('cause');
  });
});
