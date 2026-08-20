import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client';

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
  migrationsFolder = 'drizzle'
): Promise<void> {
  await lockDownLegacyFinancialIssueResolver(database);
  await migrate(database, { migrationsFolder });
}
