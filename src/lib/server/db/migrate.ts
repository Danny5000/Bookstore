import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { DatabaseMigrationIdentityConfig } from './database-role-provision';
import type { Database } from './client';
import type { DatabaseTransaction } from './transaction';

async function lockDownLegacyFinancialIssueResolver(database: Database): Promise<void> {
  // Drizzle wraps every pending migration in one transaction. This deliberately executes first
  // as its own autocommit statement so a later data/role preflight failure cannot restore the
  // legacy PUBLIC five-argument resolution API.
  await database.execute(sql`
    do $lockdown$
    declare
      resolver_oid oid;
    begin
      select function_row.oid into resolver_oid
      from pg_catalog.pg_proc function_row
      where function_row.oid = pg_catalog.to_regprocedure(
          'public.resolve_financial_reconciliation_issue(uuid,uuid,public.audit_actor_type,text,text)'
        )
        and function_row.prokind = 'f';
      if resolver_oid is not null then
        execute pg_catalog.format(
          'drop function %s', resolver_oid::pg_catalog.regprocedure
        );
      end if;
    end
    $lockdown$
  `);
}

export async function migrateDatabase(
  database: Database,
  identities: DatabaseMigrationIdentityConfig,
  migrationsFolder = 'drizzle'
): Promise<void> {
  await lockDownLegacyFinancialIssueResolver(database);
  const migrations = readMigrationFiles({ migrationsFolder });

  await database.transaction(async (transaction: DatabaseTransaction) => {
    try {
      const existing = await transaction.execute(sql`
        select
          pg_catalog.current_setting('pale_orbit.migration_expected_web_login', true)
            as expected_web_login,
          pg_catalog.current_setting('pale_orbit.migration_expected_worker_login', true)
            as expected_worker_login,
          pg_catalog.current_setting('pale_orbit.migration_expected_storage_cleanup_login', true)
            as expected_storage_cleanup_login
      `) as unknown as { rows: Array<Record<string, unknown>> };
      const values = existing.rows[0];
      if (existing.rows.length !== 1 || values === undefined || [
        values.expected_web_login,
        values.expected_worker_login,
        values.expected_storage_cleanup_login
      ].some((value) => value !== null && value !== '')) {
        throw new Error('pre-existing migration identity attestation');
      }

      await transaction.execute(sql`
        select
          pg_catalog.set_config('pale_orbit.migration_expected_web_login', ${identities.webUser}, true),
          pg_catalog.set_config('pale_orbit.migration_expected_worker_login', ${identities.workerUser}, true),
          pg_catalog.set_config('pale_orbit.migration_expected_storage_cleanup_login', ${identities.storageCleanupUser}, true)
      `);
    } catch {
      throw new Error('database migration identity attestation failed');
    }

    await transaction.execute(sql`create schema if not exists "drizzle"`);
    await transaction.execute(sql`
      create table if not exists "drizzle"."__drizzle_migrations" (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);
    const journal = await transaction.execute(sql`
      select id, hash, created_at
      from "drizzle"."__drizzle_migrations"
      order by created_at desc limit 1
    `) as unknown as { rows: Array<{ created_at: unknown }> };
    const latest = journal.rows[0];

    for (const migration of migrations) {
      if (latest === undefined || Number(latest.created_at) < migration.folderMillis) {
        for (const statement of migration.sql) {
          await transaction.execute(sql.raw(statement));
        }
        await transaction.execute(sql`
          insert into "drizzle"."__drizzle_migrations" ("hash", "created_at")
          values (${migration.hash}, ${migration.folderMillis})
        `);
      }
    }
  });
}
