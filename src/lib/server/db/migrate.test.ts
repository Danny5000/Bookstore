import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseMigrationIdentityConfig } from './database-role-provision';

const migrateMock = vi.hoisted(() => vi.fn());
const readMigrationFilesMock = vi.hoisted(() => vi.fn());
const eventTrace = vi.hoisted((): string[] => []);

vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: migrateMock }));
vi.mock('drizzle-orm/migrator', () => ({ readMigrationFiles: readMigrationFilesMock }));

import { migrateDatabase } from './migrate';

const dialect = new PgDialect();
const identities: DatabaseMigrationIdentityConfig = {
  webUser: 'migration_attested_web',
  workerUser: 'migration_attested_worker',
  storageCleanupUser: 'migration_attested_cleanup'
};
const migrationFiles = [
  {
    sql: ["select 'already-applied-marker'"],
    folderMillis: 100,
    hash: 'hash-already-applied',
    bps: true
  },
  {
    sql: ["select 'pending-first-marker'", '', "select 'pending-second-marker'"],
    folderMillis: 200,
    hash: 'hash-pending-a',
    bps: true
  },
  {
    sql: ["select 'pending-third-marker'"],
    folderMillis: 300,
    hash: 'hash-pending-b',
    bps: true
  }
];

function rendered(statement: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(statement as Parameters<typeof dialect.sqlToQuery>[0]);
}

function normalizedSql(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function transactionEvent(query: { sql: string; params: unknown[] }): string {
  const normalized = normalizedSql(query.sql);
  if (normalized.includes('current_setting')) return 'transaction:context-check';
  if (normalized.includes('set_config')) return 'transaction:context-set';
  if (normalized === 'create schema if not exists "drizzle"') {
    return 'transaction:create-schema';
  }
  if (normalized.startsWith(
    'create table if not exists "drizzle"."__drizzle_migrations"'
  )) return 'transaction:create-journal';
  if (normalized.includes('order by created_at desc limit 1')) {
    return 'transaction:read-journal';
  }
  if (normalized.startsWith('insert into "drizzle"."__drizzle_migrations"')) {
    return `transaction:journal:${String(query.params[0])}:${String(query.params[1])}`;
  }
  if (query.sql === '') return 'transaction:statement:empty';
  const marker = /select '([^']+-marker)'/u.exec(query.sql)?.[1];
  if (marker) return `transaction:statement:${marker}`;
  return `transaction:unexpected:${normalized}`;
}

function errorChainText(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join('\n');
}

async function captureAsyncError(callback: () => Promise<unknown>): Promise<Error> {
  try {
    await callback();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('expected async callback to fail');
}

function migrationDatabaseFixture(options: {
  readonly settings?: Record<string, string | null>;
  readonly latestMigration?: Record<string, unknown> | null;
  readonly failOnSql?: string;
  readonly failureError?: Error;
} = {}) {
  const settings = options.settings ?? {
    expected_web_login: null,
    expected_worker_login: null,
    expected_storage_cleanup_login: null
  };
  const latestMigration = Object.hasOwn(options, 'latestMigration')
    ? options.latestMigration
    : {
        id: 1,
        hash: 'hash-already-applied',
        created_at: '100'
      };
  const autocommitExecute = vi.fn(async (_statement: unknown) => {
    eventTrace.push('autocommit:lockdown');
    return { rows: [] };
  });
  const nestedTransaction = vi.fn();
  const transactionExecute = vi.fn(async (statement: unknown) => {
    const query = rendered(statement);
    eventTrace.push(transactionEvent(query));
    if (options.failOnSql && query.sql.includes(options.failOnSql)) {
      throw options.failureError ?? new Error('forced migration statement failure');
    }
    if (query.sql.includes('current_setting')) return { rows: [settings] };
    if (query.sql.includes('order by created_at desc limit 1')) {
      return { rows: latestMigration === null ? [] : [latestMigration] };
    }
    return { rows: [] };
  });
  const transaction = vi.fn(async (callback: (transaction: unknown) => Promise<void>) => {
    eventTrace.push('transaction:begin');
    try {
      await callback({ execute: transactionExecute, transaction: nestedTransaction });
      eventTrace.push('transaction:complete');
    } catch (error) {
      eventTrace.push('transaction:rollback');
      throw error;
    }
  });

  return {
    database: { execute: autocommitExecute, transaction },
    autocommitExecute,
    transaction,
    transactionExecute,
    nestedTransaction,
    events: eventTrace
  };
}

describe('database migration authority lockdown', () => {
  beforeEach(() => {
    eventTrace.length = 0;
    migrateMock.mockReset();
    migrateMock.mockRejectedValue(new Error('stock node-postgres migrator must not be called'));
    readMigrationFilesMock.mockReset();
    readMigrationFilesMock.mockImplementation((config: { migrationsFolder: string }) => {
      eventTrace.push(`parser:read:${config.migrationsFolder}`);
      return migrationFiles;
    });
  });

  it('keeps resolver lockdown autocommit before one pinned application-owned migration transaction', async () => {
    const fixture = migrationDatabaseFixture();

    await migrateDatabase(fixture.database as never, identities, 'drizzle-test');

    expect(fixture.autocommitExecute).toHaveBeenCalledTimes(1);
    const lockdown = rendered(fixture.autocommitExecute.mock.calls[0]?.[0]).sql;
    expect(lockdown).toContain(
      'public.resolve_financial_reconciliation_issue(uuid,uuid,public.audit_actor_type,text,text)'
    );
    expect(lockdown).toContain("prokind = 'f'");
    expect(lockdown).not.toContain('pronargs');
    expect(fixture.autocommitExecute.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.transaction.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.nestedTransaction).not.toHaveBeenCalled();
    expect(readMigrationFilesMock).toHaveBeenCalledWith({ migrationsFolder: 'drizzle-test' });
    expect(migrateMock).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      'autocommit:lockdown',
      'parser:read:drizzle-test',
      'transaction:begin',
      'transaction:context-check',
      'transaction:context-set',
      'transaction:create-schema',
      'transaction:create-journal',
      'transaction:read-journal',
      'transaction:statement:pending-first-marker',
      'transaction:statement:empty',
      'transaction:statement:pending-second-marker',
      'transaction:journal:hash-pending-a:200',
      'transaction:statement:pending-third-marker',
      'transaction:journal:hash-pending-b:300',
      'transaction:complete'
    ]);
  });

  it('binds three local identities before journal DDL and executes only pending parser output', async () => {
    const fixture = migrationDatabaseFixture();

    await migrateDatabase(fixture.database as never, identities, 'drizzle-test');

    const queries = fixture.transactionExecute.mock.calls.map(([statement]) => rendered(statement));
    const sqlText = queries.map((query) => query.sql);
    expect(sqlText[0]).toContain(
      "current_setting('pale_orbit.migration_expected_web_login', true)"
    );
    expect(sqlText[0]).toContain(
      "current_setting('pale_orbit.migration_expected_worker_login', true)"
    );
    expect(sqlText[0]).toContain(
      "current_setting('pale_orbit.migration_expected_storage_cleanup_login', true)"
    );

    expect(sqlText[1]).toContain(
      "set_config('pale_orbit.migration_expected_web_login', $1, true)"
    );
    expect(sqlText[1]).toContain(
      "set_config('pale_orbit.migration_expected_worker_login', $2, true)"
    );
    expect(sqlText[1]).toContain(
      "set_config('pale_orbit.migration_expected_storage_cleanup_login', $3, true)"
    );
    expect(queries[1]?.params).toEqual([
      identities.webUser,
      identities.workerUser,
      identities.storageCleanupUser
    ]);

    const normalized = sqlText.map(normalizedSql);
    const schemaIndex = normalized.indexOf('create schema if not exists "drizzle"');
    const tableDdl =
      'create table if not exists "drizzle"."__drizzle_migrations" ' +
      '( id serial primary key, hash text not null, created_at bigint )';
    const tableIndex = normalized.indexOf(tableDdl);
    const latestSql =
      'select id, hash, created_at from "drizzle"."__drizzle_migrations" ' +
      'order by created_at desc limit 1';
    const latestIndex = normalized.indexOf(latestSql);
    const firstPendingIndex = sqlText.indexOf("select 'pending-first-marker'");
    const emptyParsedStatementIndex = sqlText.indexOf('');
    const secondPendingIndex = sqlText.indexOf("select 'pending-second-marker'");
    const thirdPendingIndex = sqlText.indexOf("select 'pending-third-marker'");
    const journalIndexes = normalized.flatMap((text, index) =>
      text.startsWith('insert into "drizzle"."__drizzle_migrations"') ? [index] : []
    );
    expect(schemaIndex).toBeGreaterThan(1);
    expect(tableIndex).toBeGreaterThan(schemaIndex);
    expect(latestIndex).toBeGreaterThan(tableIndex);
    expect(firstPendingIndex).toBeGreaterThan(latestIndex);
    expect(emptyParsedStatementIndex).toBeGreaterThan(firstPendingIndex);
    expect(secondPendingIndex).toBeGreaterThan(emptyParsedStatementIndex);
    expect(journalIndexes).toHaveLength(2);
    for (const journalIndex of journalIndexes) {
      expect(normalized[journalIndex]).toBe(
        'insert into "drizzle"."__drizzle_migrations" ' +
        '("hash", "created_at") values ($1, $2)'
      );
    }
    expect(journalIndexes[0]).toBeGreaterThan(secondPendingIndex);
    expect(thirdPendingIndex).toBeGreaterThan(journalIndexes[0] ?? Number.MAX_SAFE_INTEGER);
    expect(journalIndexes[1]).toBeGreaterThan(thirdPendingIndex);
    expect(sqlText).not.toContain("select 'already-applied-marker'");
    expect(queries[journalIndexes[0]!]?.params).toEqual(['hash-pending-a', 200]);
    expect(queries[journalIndexes[1]!]?.params).toEqual(['hash-pending-b', 300]);
    expect(sqlText.join('\n')).not.toMatch(/\b(?:begin|commit)\b/iu);
    expect(readMigrationFilesMock).toHaveBeenCalledTimes(1);
    expect(fixture.nestedTransaction).not.toHaveBeenCalled();
    expect(migrateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['web', 'expected_web_login'],
    ['worker', 'expected_worker_login'],
    ['storage cleanup', 'expected_storage_cleanup_login']
  ] as const)(
    'fails before setting or migrating when the pinned session has a %s identity value',
    async (_label, field) => {
      const staleCanary = `private_stale_${field}`;
      const fixture = migrationDatabaseFixture({
        settings: {
          expected_web_login: null,
          expected_worker_login: null,
          expected_storage_cleanup_login: null,
          [field]: staleCanary
        }
      });

      const failure = await captureAsyncError(() =>
        migrateDatabase(fixture.database as never, identities, 'drizzle-test')
      );

      expect(failure.message).toMatch(/pre-existing|already.*migration.*identity|attestation/iu);
      expect(errorChainText(failure)).not.toContain(staleCanary);
      for (const identity of Object.values(identities)) {
        expect(errorChainText(failure)).not.toContain(identity);
      }
      expect(fixture.transactionExecute).toHaveBeenCalledTimes(1);
      const onlyQuery = rendered(fixture.transactionExecute.mock.calls[0]?.[0]);
      expect(onlyQuery.sql).toContain('current_setting');
      expect(onlyQuery.sql).not.toContain('set_config');
      expect(fixture.events).toEqual([
        'autocommit:lockdown',
        'parser:read:drizzle-test',
        'transaction:begin',
        'transaction:context-check',
        'transaction:rollback'
      ]);
      expect(migrateMock).not.toHaveBeenCalled();
    }
  );

  it('accepts PostgreSQL empty custom-setting placeholders but writes no persistent setting SQL', async () => {
    const fixture = migrationDatabaseFixture({
      settings: {
        expected_web_login: '',
        expected_worker_login: '',
        expected_storage_cleanup_login: ''
      }
    });

    await migrateDatabase(fixture.database as never, identities, 'drizzle-test');

    const queries = fixture.transactionExecute.mock.calls.map(([statement]) => rendered(statement));
    const combinedSql = queries.map((query) => query.sql).join('\n');
    expect(combinedSql).not.toMatch(/alter\s+(?:role|database)\b/iu);
    expect(combinedSql).not.toMatch(/create\s+table[^;]*migration_expected/iu);
    expect(combinedSql).not.toContain(identities.webUser);
    expect(combinedSql).not.toContain(identities.workerUser);
    expect(combinedSql).not.toContain(identities.storageCleanupUser);
    expect(migrateMock).not.toHaveBeenCalled();
  });

  it('propagates a migration failure before any later statement or journal insert can run', async () => {
    readMigrationFilesMock.mockReturnValue([{
      sql: [
        "select 'forced-migration-failure'",
        "select 'must-not-run-after-failure'"
      ],
      folderMillis: 300,
      hash: 'hash-failing',
      bps: true
    }]);
    const fixture = migrationDatabaseFixture({
      latestMigration: null,
      failOnSql: 'forced-migration-failure'
    });

    await expect(migrateDatabase(fixture.database as never, identities, 'drizzle-test'))
      .rejects.toThrow('forced migration statement failure');

    const sqlText = fixture.transactionExecute.mock.calls
      .map(([statement]) => rendered(statement).sql);
    expect(sqlText).toContain("select 'forced-migration-failure'");
    expect(sqlText).not.toContain("select 'must-not-run-after-failure'");
    expect(sqlText.some((text) =>
      text.includes('insert into "drizzle"."__drizzle_migrations"')
    )).toBe(false);
    expect(fixture.events.at(-1)).toBe('transaction:rollback');
    expect(fixture.events).not.toContain('transaction:complete');
    expect(migrateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['context inspection', 'current_setting', ['transaction:context-check']],
    [
      'bound context setup',
      'set_config',
      ['transaction:context-check', 'transaction:context-set']
    ]
  ] as const)('sanitizes %s errors and logs', async (_label, failingSql, transactionEvents) => {
    const privateCanaries = [
      ...Object.values(identities),
      'private-migration-password',
      '/run/secrets/private-migration-user'
    ];
    const fixture = migrationDatabaseFixture({
      failOnSql: failingSql,
      failureError: new Error(`query failed with params ${privateCanaries.join(', ')}`)
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const failure = await captureAsyncError(() =>
        migrateDatabase(fixture.database as never, identities, 'drizzle-test')
      );
      const observable = [
        errorChainText(failure),
        JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls])
      ].join('\n');
      expect(failure.message).toMatch(/migration.*identity|attestation/iu);
      for (const canary of privateCanaries) expect(observable).not.toContain(canary);
      expect(fixture.events).toEqual([
        'autocommit:lockdown',
        'parser:read:drizzle-test',
        'transaction:begin',
        ...transactionEvents,
        'transaction:rollback'
      ]);
      expect(migrateMock).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('never logs an attested role name', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fixture = migrationDatabaseFixture();
    try {
      await migrateDatabase(fixture.database as never, identities, 'drizzle-test');
      const logText = JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls]);
      expect([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls]).toEqual([]);
      expect(logText).not.toContain(identities.webUser);
      expect(logText).not.toContain(identities.workerUser);
      expect(logText).not.toContain(identities.storageCleanupUser);
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
