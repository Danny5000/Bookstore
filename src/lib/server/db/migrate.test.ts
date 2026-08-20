import { beforeEach, describe, expect, it, vi } from 'vitest';

const migrateMock = vi.hoisted(() => vi.fn());

vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: migrateMock }));

import { migrateDatabase } from './migrate';

describe('database migration authority lockdown', () => {
  beforeEach(() => migrateMock.mockReset());

  it('commits the legacy resolver removal before entering the Drizzle migration batch', async () => {
    const execute = vi.fn(async (_statement: unknown) => ({ rows: [] }));
    migrateMock.mockResolvedValue(undefined);

    await migrateDatabase({ execute } as never, 'drizzle-test');

    expect(execute).toHaveBeenCalledTimes(1);
    const lockdown = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(lockdown).toContain(
      'public.resolve_financial_reconciliation_issue(uuid,uuid,public.audit_actor_type,text,text)'
    );
    expect(lockdown).toContain("prokind = 'f'");
    expect(lockdown).not.toContain('pronargs');
    expect(migrateMock).toHaveBeenCalledWith(expect.anything(), {
      migrationsFolder: 'drizzle-test'
    });
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      migrateMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
  });
});
