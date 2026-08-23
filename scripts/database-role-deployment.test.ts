import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => {
  const absolute = resolve(path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8').replace(/\r\n?/gu, '\n') : '';
};

const financialWorkerWriteTables = [
  'dispute_item_allocations',
  'financial_allocation_sets',
  'financial_item_allocations',
  'financial_reconciliation_issues',
  'refund_allocation_components',
  'refund_allocation_draft_items',
  'refund_allocation_drafts',
  'refund_allocation_finalization_effects',
  'refund_reporting_correction_items',
  'refund_reporting_correction_sets',
  'financial_classification_versions',
  'financial_projection_versions',
  'financial_payout_discovery_state',
  'financial_scan_runs',
  'payout_import_run_entries',
  'payout_import_runs',
  'stripe_balance_transaction_fee_details',
  'stripe_balance_transactions',
  'stripe_payout_balance_transactions',
  'stripe_payouts'
] as const;

const financialWorkerInsertTables = [
  'dispute_item_allocations',
  'financial_allocation_sets',
  'financial_item_allocations',
  'financial_reconciliation_issues',
  'refund_allocation_components',
  'refund_reporting_correction_items',
  'refund_reporting_correction_sets',
  'financial_classification_versions',
  'financial_scan_runs',
  'payout_import_run_entries',
  'payout_import_runs',
  'stripe_balance_transaction_fee_details',
  'stripe_balance_transactions',
  'stripe_payout_balance_transactions',
  'stripe_payouts'
] as const;

const financialWorkerUpdateTables = [
  'financial_reconciliation_issues',
  'financial_projection_versions',
  'financial_payout_discovery_state',
  'financial_scan_runs',
  'payout_import_runs',
  'stripe_balance_transactions',
  'stripe_payouts'
] as const;

const canonicalFinancialWorkerWriteTables = [
  'payments',
  'refunds',
  'refund_allocations',
  'disputes'
] as const;

const stripeEventWebInsertColumns = [
  'provider_event_id',
  'event_type',
  'object_id',
  'live_mode',
  'api_version',
  'provider_created_at',
  'raw_body_sha256'
] as const;

const orderWebInsertColumns = [
  'initiating_user_id',
  'purchase_email',
  'currency',
  'subtotal_minor',
  'client_checkout_attempt_id',
  'quote_fingerprint_sha256',
  'status_token_sha256'
] as const;

const orderWebUpdateColumns = [
  'status',
  'stripe_checkout_session_id',
  'checkout_expires_at',
  'updated_at'
] as const;

const orderItemWebInsertColumns = [
  'order_id',
  'title_id',
  'title_snapshot',
  'creator_name_snapshot',
  'format',
  'currency',
  'unit_subtotal_minor'
] as const;

const jobWebInsertColumns = [
  'type',
  'payload',
  'deduplication_key',
  'run_at',
  'max_attempts'
] as const;

const outboxWebInsertColumns = [
  'id',
  'topic',
  'payload',
  'deduplication_key',
  'dispatch_job_id'
] as const;

const outboxWorkerUpdateColumns = [
  'status',
  'last_error',
  'delivered_at',
  'updated_at'
] as const;

const titleRevisionWebInsertColumns = [
  'title_id',
  'parent_revision_id',
  'created_by_actor_id',
  'change_summary',
  'staging_storage_key',
  'staging_checksum_sha256',
  'staging_byte_size',
  'upload_filename',
  'upload_mime_type'
] as const;

const titleRevisionWebUpdateColumns = [
  'state',
  'staging_storage_key',
  'ingestion_generation',
  'processing_started_at',
  'processed_at',
  'failure_code',
  'failure_details',
  'activated_at',
  'retired_at'
] as const;

const workerDerivedCatalogTables = [
  'prose_sections',
  'prose_images',
  'prose_blocks',
  'comic_pages',
  'revision_cover_suggestions',
  'revision_ingestion_warnings'
] as const;

const workerOnlyAuditActions = [
  'commerce.fulfillment_paid',
  'commerce.fulfillment_exception',
  'commerce.refund_reconciled',
  'commerce.dispute_reconciled',
  'catalog.revision.ingest.succeeded',
  'catalog.revision.ingest.failed'
] as const;

const workerAuditActorIds = [
  'commerce-worker',
  'financial-worker',
  'publication-ingestion-worker'
] as const;

const financialWorkerInsertTableSet = new Set<string>(financialWorkerInsertTables);
const financialWorkerUpdateTableSet = new Set<string>(financialWorkerUpdateTables);

function serviceBlock(compose: string, name: string): string {
  const match = new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|^networks:|^volumes:|^secrets:)`, 'mu')
    .exec(compose);
  expect(match, `missing ${name} service`).not.toBeNull();
  return match?.[0] ?? '';
}

describe('production database authority split', () => {
  it('rejects noncanonical preexisting fixed groups before any role mutation', () => {
    const migration = source('drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql');
    const firstLock = migration.indexOf('LOCK TABLE');
    const preflight = migration.slice(0, firstLock);

    expect(firstLock).toBeGreaterThan(0);
    for (const roleName of ['pale_orbit_runtime', 'pale_orbit_financial_worker']) {
      expect(preflight).toContain(`'${roleName}'`);
    }
    for (const unsafeAttribute of [
      'role_row.rolcanlogin',
      'role_row.rolsuper',
      'role_row.rolcreatedb',
      'role_row.rolcreaterole',
      'NOT role_row.rolinherit',
      'role_row.rolreplication',
      'role_row.rolbypassrls',
      'role_row.rolconnlimit <> -1',
      'role_row.rolvaliduntil IS NOT NULL',
      'role_row.rolconfig IS NOT NULL'
    ]) expect(preflight).toContain(unsafeAttribute);
    expect(preflight).toContain('pg_catalog.pg_db_role_setting');
    expect(preflight).toContain("ERRCODE = '42501'");
    expect(preflight).toContain(
      "MESSAGE = 'preexisting Plan 6B group role has noncanonical attributes'"
    );
    expect(preflight).not.toMatch(
      /(?:CREATE|ALTER) ROLE "pale_orbit_(?:runtime|financial_worker)"/u
    );
  });

  it('stages a rollback-safe 0009 fixed-group collision upgrade fixture', () => {
    const upgrade = source('tests/integration/financial-migration.test.ts');
    const fixtureStart = upgrade.indexOf(
      'async function runFixedGroupAttributePreflightFixture'
    );
    const fixtureEnd = upgrade.indexOf('\nasync function ', fixtureStart + 1);
    const fixture = upgrade.slice(fixtureStart, fixtureEnd);

    expect(fixtureStart).toBeGreaterThanOrEqual(0);
    expect(fixture).toContain('createMigrationFolderThrough(8)');
    expect(fixture).toContain("equal(await migrationCount(pool), 9");
    expect(fixture).toContain('create role pale_orbit_runtime with login');
    expect(fixture).toContain("equal(postgresError.code, '42501'");
    expect(fixture).toContain('failed 0009 preserves the unsafe fixed group unchanged');
    expect(fixture).toContain('failed 0009 leaves no partial worker authority');
    expect(fixture).toContain('createMigrationFolderThrough(11)');
    expect(fixture).toContain("equal(await migrationCount(pool), 12");
    expect(upgrade).toContain("'fixed-group-attribute-preflight'");
  });

  it('fails closed on unexpected named application authority before 0009 mutates the database', () => {
    const migration = source('drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql');
    const provisioner = source('src/lib/server/db/database-role-provision.ts');
    const firstLock = migration.indexOf('LOCK TABLE');
    const preflight = migration.slice(0, firstLock);

    expect(firstLock).toBeGreaterThan(0);
    for (const contract of [
      'unexpected named Plan 6B database authority',
      'pg_catalog.pg_depend',
      "extension_dependency.deptype = 'e'",
      "dependent_object.deptype IN ('a', 'i')",
      "role_row.rolname = 'pg_database_owner'",
      'pg_catalog.pg_has_role',
      "'pg_read_all_data'",
      "'pg_write_all_data'",
      'default_row.defaclnamespace = 0',
      "privilege_row.privilege_type NOT IN ('CONNECT', 'TEMPORARY')"
    ]) expect(preflight).toContain(contract);
    expect(preflight).not.toContain("role_row.rolname ~ '^pg_'");
    expect(preflight).toContain('sensitive_role.rolsuper');
    expect(preflight).toContain("ERRCODE = '42501'");

    expect(provisioner).toMatch(
      /function roleName[\s\S]*?value\.startsWith\('pg_'\)[\s\S]*?is invalid/u
    );

    const provision = provisioner.slice(provisioner.indexOf('export async function provisionDatabaseRoles'));
    expect(provisioner).toContain('as "unsafeUnexpectedNamedAuthority"');
    expect(provisioner).toContain('Unexpected named database authority requires operator remediation');
    expect(provision.indexOf('as "unsafeUnexpectedNamedAuthority"'))
      .toBeLessThan(provision.indexOf('const statement = await formattedRoleStatement('));

    const upgrade = source('tests/integration/financial-migration.test.ts');
    const fixtureStart = upgrade.indexOf(
      'async function runUnexpectedNamedAuthorityPreflightFixture'
    );
    const fixtureEnd = upgrade.indexOf('\nasync function ', fixtureStart + 1);
    const fixture = upgrade.slice(fixtureStart, fixtureEnd);
    expect(fixtureStart).toBeGreaterThanOrEqual(0);
    expect(fixture).toContain('direct reporting-role SELECT');
    expect(fixture).toContain('predefined pg_ role direct SELECT');
    expect(fixture).toContain('owner default SELECT');
    expect(fixture).toContain('inherited pg_write_all_data authority');
    expect(fixture).toContain('unexpected public object ownership');
    expect(fixture).toContain('create extension hstore with schema public');
    expect(fixture).toContain('public schema USAGE and extension-member ACLs');
    expect(upgrade).toContain("'unexpected-named-authority-preflight'");

    const boundaries = source('tests/integration/database-role-boundaries.test.ts');
    for (const witness of [
      'rejects configured-login direct ACLs before role rotation',
      'direct application SELECT',
      'owner default SELECT',
      'inherited pg_read_all_data',
      'predefined pg_ role direct application SELECT',
      'public object ownership',
      'permits unrelated public-schema USAGE and extension-member ACLs'
    ]) expect(boundaries).toContain(witness);
  });

  it('pins database CONNECT to the fixed groups without grant option or PUBLIC dependence', () => {
    const workerMigration = source(
      'drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql'
    );
    const cleanupMigration = source('drizzle/0011_plan6b_storage_cleanup_authority.sql');
    const provisioner = source('src/lib/server/db/database-role-provision.ts');

    expect(workerMigration).toContain(
      'GRANT CONNECT ON DATABASE %I TO "pale_orbit_runtime", "pale_orbit_financial_worker"'
    );
    expect(cleanupMigration).toContain(
      'GRANT CONNECT ON DATABASE %I TO "pale_orbit_storage_cleanup"'
    );
    expect(cleanupMigration).toContain("acl.privilege_type = 'CONNECT'");
    expect(cleanupMigration).toContain('NOT acl.is_grantable');
    expect(workerMigration).not.toMatch(/GRANT CONNECT[^;]+WITH GRANT OPTION/iu);
    expect(cleanupMigration).not.toMatch(/GRANT CONNECT[^;]+WITH GRANT OPTION/iu);

    expect(provisioner).toContain("grantee_role.rolname = 'pale_orbit_runtime'");
    expect(provisioner).toContain("grantee_role.rolname = 'pale_orbit_financial_worker'");
    expect(provisioner).toContain("grantee_role.rolname = $1::text");
    expect(provisioner).toMatch(
      /pg_catalog\.has_database_privilege\(\s*\$2::text,\s*pg_catalog\.current_database\(\),\s*'CONNECT'/u
    );
    expect(provisioner).toMatch(
      /pg_catalog\.has_database_privilege\(\s*\$3::text,\s*pg_catalog\.current_database\(\),\s*'CONNECT'/u
    );
    const boundaries = source('tests/integration/database-role-boundaries.test.ts');
    expect(boundaries).toContain('direct_connect_groups');
    expect(boundaries).toContain('grantable_connect_groups');
    expect(boundaries.match(/select grantee_role\.rolname::text/gu)).toHaveLength(2);
    expect(boundaries).toContain('rejects missing fixed-group CONNECT for %s');
  });

  it('reserves financial-table writes for the worker while retaining runtime reads', () => {
    const migration = source('drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql');
    const provisioner = source('src/lib/server/db/database-role-provision.ts');
    const statements = migration.split('--> statement-breakpoint')
      .map((value) => value.trim().replace(/;$/u, ''));
    const revoke = statements.find((value) =>
      value.startsWith('REVOKE INSERT, UPDATE, DELETE ON TABLE')
    );
    const tables = (statement: string | undefined) => [
      ...(statement ?? '').matchAll(/"public"\."([a-z0-9_]+)"/gu)
    ].map((match) => match[1]);

    expect(tables(revoke)).toEqual(financialWorkerWriteTables);
    expect(revoke).toContain('FROM "pale_orbit_runtime"');
    const actualWorkerPrivileges = Object.fromEntries(
      financialWorkerWriteTables.map((table) => [table, [] as string[]])
    );
    for (const grant of statements.filter((value) =>
      value.startsWith('GRANT ') && /\sON TABLE\s/u.test(value) &&
      value.endsWith('TO "pale_orbit_financial_worker"')
    )) {
      const privileges = /^GRANT ([A-Z, ]+)\s+ON TABLE\s/u.exec(grant)?.[1]
        ?.split(',').map((value) => value.trim()) ?? [];
      for (const table of tables(grant)) actualWorkerPrivileges[table]?.push(...privileges);
    }
    const expectedWorkerPrivileges = Object.fromEntries(
      financialWorkerWriteTables.map((table) => [table, [
        ...(financialWorkerInsertTableSet.has(table) ? ['INSERT'] : []),
        ...(financialWorkerUpdateTableSet.has(table) ? ['UPDATE'] : [])
      ]])
    );
    expect(actualWorkerPrivileges).toEqual(expectedWorkerPrivileges);
    const defaultTablePrivileges = statements.find((value) =>
      value.startsWith('ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT') &&
      value.includes(' ON TABLES TO "pale_orbit_runtime"')
    );
    expect(defaultTablePrivileges).toBe(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES TO "pale_orbit_runtime"'
    );
    expect(provisioner).toContain('const FINANCIAL_WORKER_WRITE_TABLES = [');
    for (const table of financialWorkerWriteTables) {
      expect(provisioner).toContain(`'${table}'`);
    }
    expect(provisioner).toContain("privilege_row.privilege_type = 'SELECT'");
    expect(provisioner).toContain("privilege_row.privilege_type = 'INSERT'");
    expect(provisioner).toContain("privilege_row.privilege_type = 'UPDATE'");
    expect(provisioner).toContain("privilege_row.privilege_type = 'DELETE'");
    expect(provisioner).toContain('allowed_relation.relname = any($7::text[])');
    expect(provisioner).toContain('protected_relation.relname = any($4::text[])');
    expect(provisioner).toContain('allowed_relation.relname = any($5::text[])');
    expect(provisioner).toContain('allowed_relation.relname = any($6::text[])');

    const canonicalRevoke = statements.find((value) =>
      value.startsWith('REVOKE INSERT, UPDATE, DELETE ON TABLE') &&
      value.includes('"public"."payments"')
    );
    expect(tables(canonicalRevoke)).toEqual(canonicalFinancialWorkerWriteTables);
    const canonicalWorkerPrivileges = Object.fromEntries(
      canonicalFinancialWorkerWriteTables.map((table) => [table, [] as string[]])
    );
    for (const grant of statements.filter((value) =>
      value.startsWith('GRANT ') && /\sON TABLE\s/u.test(value) &&
      value.endsWith('TO "pale_orbit_financial_worker"')
    )) {
      const privileges = /^GRANT ([A-Z, ]+)\s+ON TABLE\s/u.exec(grant)?.[1]
        ?.split(',').map((value) => value.trim()) ?? [];
      for (const table of tables(grant)) canonicalWorkerPrivileges[table]?.push(...privileges);
    }
    expect(canonicalWorkerPrivileges).toEqual({
      payments: ['INSERT', 'UPDATE'],
      refunds: ['INSERT', 'UPDATE'],
      refund_allocations: ['INSERT'],
      disputes: ['INSERT', 'UPDATE']
    });

    const stripeEventRevoke = statements.find((value) =>
      value === 'REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."stripe_events" FROM "pale_orbit_runtime"'
    );
    const stripeEventInsert = statements.find((value) =>
      value.startsWith('GRANT INSERT (') && value.endsWith(
        'ON TABLE "public"."stripe_events" TO "pale_orbit_runtime"'
      )
    );
    expect(stripeEventRevoke).toBeDefined();
    expect([...(stripeEventInsert ?? '').matchAll(/"([a-z0-9_]+)"/gu)]
      .map((match) => match[1]).slice(0, stripeEventWebInsertColumns.length))
      .toEqual(stripeEventWebInsertColumns);
    expect(statements).toContain(
      'GRANT UPDATE ON TABLE "public"."stripe_events" TO "pale_orbit_financial_worker"'
    );
    expect(statements).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."current_financial_projection_heads", "public"."current_financial_projection_items" FROM "pale_orbit_runtime"'
    );
    expect(provisioner).toContain('const STRIPE_EVENT_WEB_INSERT_COLUMNS = [');
    for (const column of stripeEventWebInsertColumns) {
      expect(provisioner).toContain(`'${column}'`);
    }
    expect(provisioner).toContain('as "missingRequiredAcl"');

    const webhookSource = source('src/lib/server/commerce/webhooks.ts');
    const acceptedValues = webhookSource.slice(
      webhookSource.indexOf('insert into "stripe_events"'),
      webhookSource.indexOf('on conflict ("provider_event_id")')
    );
    expect(acceptedValues).toContain('"provider_event_id", "event_type", "object_id"');
    expect(acceptedValues).toContain('"provider_created_at", "raw_body_sha256"');
    expect(acceptedValues).not.toContain("status: 'pending'");
    expect(acceptedValues).not.toContain('processedAt: null');
    expect(acceptedValues).not.toContain('"status"');
    expect(acceptedValues).not.toContain('"processed_at"');
    expect(webhookSource).not.toContain('.insert(stripeEvents)');
    expect(webhookSource).not.toContain(".for('update')");
  });

  it('enforces exact mixed commerce, queue, outbox, and catalog authority', () => {
    const migration = source('drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql');
    const provisioner = source('src/lib/server/db/database-role-provision.ts');
    const statements = migration.split('--> statement-breakpoint')
      .map((value) => value.trim().replace(/;$/u, ''));
    const columns = (statement: string | undefined) => [
      ...(statement ?? '').matchAll(/^\s*"([a-z0-9_]+)"\s*,?$/gmu)
    ].map((match) => match[1]);
    const columnGrant = (privilege: 'INSERT' | 'UPDATE', table: string, role: string) =>
      statements.find((value) => value.startsWith(`GRANT ${privilege} (`) &&
        value.endsWith(`ON TABLE "public"."${table}" TO "${role}"`));

    for (const table of ['orders', 'order_items', 'jobs', 'outbox_messages', 'title_revisions']) {
      expect(statements).toContain(
        `REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."${table}" FROM "pale_orbit_runtime"`
      );
    }
    expect(columns(columnGrant('INSERT', 'orders', 'pale_orbit_runtime')))
      .toEqual(orderWebInsertColumns);
    expect(columns(columnGrant('UPDATE', 'orders', 'pale_orbit_runtime')))
      .toEqual(orderWebUpdateColumns);
    expect(columns(columnGrant('INSERT', 'order_items', 'pale_orbit_runtime')))
      .toEqual(orderItemWebInsertColumns);
    expect(columns(columnGrant('INSERT', 'jobs', 'pale_orbit_runtime')))
      .toEqual(jobWebInsertColumns);
    expect(columns(columnGrant('INSERT', 'outbox_messages', 'pale_orbit_runtime')))
      .toEqual(outboxWebInsertColumns);
    expect(columns(columnGrant('UPDATE', 'outbox_messages', 'pale_orbit_financial_worker')))
      .toEqual(outboxWorkerUpdateColumns);
    expect(columns(columnGrant('INSERT', 'title_revisions', 'pale_orbit_runtime')))
      .toEqual(titleRevisionWebInsertColumns);
    expect(columns(columnGrant('UPDATE', 'title_revisions', 'pale_orbit_runtime')))
      .toEqual(titleRevisionWebUpdateColumns);

    for (const statement of [
      'GRANT UPDATE ON TABLE "public"."orders" TO "pale_orbit_financial_worker"',
      'GRANT UPDATE ON TABLE "public"."order_items" TO "pale_orbit_financial_worker"',
      'GRANT UPDATE ON TABLE "public"."jobs" TO "pale_orbit_financial_worker"',
      'GRANT UPDATE ON TABLE "public"."title_revisions" TO "pale_orbit_financial_worker"'
    ]) expect(statements).toContain(statement);

    const derivedRevoke = statements.find((value) =>
      value.startsWith('REVOKE INSERT, UPDATE, DELETE ON TABLE') &&
      value.includes('"public"."prose_sections"')
    );
    const derivedWorkerGrant = statements.find((value) =>
      value.startsWith('GRANT INSERT, DELETE ON TABLE') &&
      value.includes('"public"."prose_sections"')
    );
    const tables = (statement: string | undefined) => [
      ...(statement ?? '').matchAll(/"public"\."([a-z0-9_]+)"/gu)
    ].map((match) => match[1]);
    expect(tables(derivedRevoke)).toEqual(workerDerivedCatalogTables);
    expect(tables(derivedWorkerGrant)).toEqual(workerDerivedCatalogTables);

    for (const name of [
      'plan6b_guard_order_write',
      'plan6b_guard_order_item_insert',
      'plan6b_guard_job_insert',
      'plan6b_guard_outbox_insert',
      'plan6b_guard_title_revision_write'
    ]) {
      expect(migration).toContain(`CREATE FUNCTION "public"."${name}"`);
      expect(migration).toContain(`EXECUTE FUNCTION "public"."${name}"()`);
    }
    expect(migration).toContain(
      'CREATE FUNCTION "public"."rearm_pending_stripe_event_job"(p_stripe_event_id uuid)'
    );
    expect(migration).toContain('SECURITY DEFINER\nSET search_path = \'pg_catalog\'');
    expect(statements).toContain(
      'REVOKE ALL ON FUNCTION "public"."rearm_pending_stripe_event_job"(uuid) FROM PUBLIC'
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION "public"."rearm_pending_stripe_event_job"(uuid) TO "pale_orbit_runtime"'
    );
    for (const name of ['plan6b_guard_job_insert', 'plan6b_guard_outbox_insert']) {
      expect(statements).toContain(`REVOKE ALL ON FUNCTION "public"."${name}"() FROM PUBLIC`);
      expect(statements).toContain(
        `REVOKE ALL ON FUNCTION "public"."${name}"() FROM "pale_orbit_runtime"`
      );
    }
    expect(migration).toContain("NEW.type = 'commerce.stripe-event'");
    expect(migration).toContain("NEW.type = 'catalog.ingest_revision'");
    expect(migration).toContain("NEW.type = 'commerce.claim-email-request'");
    expect(migration).toContain("NEW.type = 'outbox.dispatch'");
    expect(migration).toContain("pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')");
    expect(migration).toContain("pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')");

    for (const constant of [
      'PROTECTED_RUNTIME_WRITE_TABLES',
      'WORKER_INSERT_TABLES',
      'WORKER_UPDATE_TABLES',
      'WORKER_DELETE_TABLES',
      'RUNTIME_COLUMN_PRIVILEGES',
      'WORKER_COLUMN_PRIVILEGES',
      'RUNTIME_EXECUTE_FUNCTIONS',
      'WORKER_EXECUTE_FUNCTIONS',
      'WORKER_SELECT_TABLES',
      'RUNTIME_TABLE_SELECT_EXCLUSIONS',
      'PUBLIC_SENSITIVE_SELECT_COLUMNS'
    ]) expect(provisioner).toContain(`const ${constant}`);

    for (const contract of [
      "'guest_identities'",
      "'entitlement_grants'",
      "'entitlements'",
      "'commerce_claim_issuances'",
      "'guest_identities:INSERT:email'",
      "'outbox_messages:SELECT:id'",
      "'outbox_messages:SELECT:updated_at'",
      "'public.authorize_commerce_claim_issuance(text,text)'",
      "'public.claim_guest_purchases_after_authorization(text,text)'",
      "'public.outbox_message_exists_by_deduplication_key(text)'",
      "'public.outbox_message_deduplication_metadata(text,text,jsonb)'",
      "'public.register_commerce_claim_issuance(text,text,text,uuid,text,timestamp with time zone)'",
      "'public.purge_commerce_claim_issuances()'",
      "'outbox_messages:payload'",
      "'commerce_claim_issuances:*'"
    ]) expect(provisioner).toContain(contract);

    const orderSource = source('src/lib/server/commerce/orders.ts');
    const orderInsert = orderSource.slice(
      orderSource.indexOf('.insert(orders)'),
      orderSource.indexOf('.returning()', orderSource.indexOf('.insert(orders)'))
    );
    for (const forbidden of [
      'status', 'guestIdentityId', 'taxMinor', 'totalMinor', 'stripeCheckoutSessionId',
      'checkoutExpiresAt', 'paidAt', 'createdAt', 'updatedAt'
    ]) expect(orderInsert).not.toMatch(new RegExp(`\\b${forbidden}\\s*:`, 'u'));
    const itemInsert = orderSource.slice(
      orderSource.indexOf('.insert(orderItems)'),
      orderSource.indexOf('.returning()', orderSource.indexOf('.insert(orderItems)'))
    );
    for (const forbidden of ['taxMinor', 'totalMinor', 'stripeLineItemId', 'createdAt']) {
      expect(itemInsert).not.toMatch(new RegExp(`\\b${forbidden}\\s*:`, 'u'));
    }

    const jobsSource = source('src/lib/server/jobs/repository.ts');
    const webhookSource = source('src/lib/server/commerce/webhooks.ts');
    expect(jobsSource).toContain('export async function rearmPendingStripeEventJob(');
    expect(jobsSource).toContain('rearm_pending_stripe_event_job');
    expect(jobsSource).not.toContain('export async function rearmExhaustedJob(');
    expect(webhookSource).toContain('rearmPendingStripeEventJob(transaction, existing.id)');
    expect(webhookSource).not.toContain('rearmExhaustedJob');

    const revisionSource = source('src/lib/server/catalog/revisions.ts');
    const revisionInsert = revisionSource.slice(
      revisionSource.indexOf('.insert(titleRevisions)'),
      revisionSource.indexOf('.returning()', revisionSource.indexOf('.insert(titleRevisions)'))
    );
    expect(revisionInsert).not.toContain("state: 'uploaded'");
    expect(revisionInsert).not.toContain('ingestionGeneration: 0');
  });

  it('reserves worker audit provenance and closes inherited PUBLIC authority', () => {
    const migration = source('drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql');
    const provisioner = source('src/lib/server/db/database-role-provision.ts');
    const statements = migration.split('--> statement-breakpoint')
      .map((value) => value.trim().replace(/;$/u, ''));
    const auditGuard = /CREATE FUNCTION "public"\."plan6b_guard_audit_insert"\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/u
      .exec(migration)?.[1] ?? '';

    expect(auditGuard).toContain("NEW.action LIKE 'financial.%'");
    for (const action of workerOnlyAuditActions) expect(auditGuard).toContain(`'${action}'`);
    for (const actorId of workerAuditActorIds) expect(auditGuard).toContain(`'${actorId}'`);
    expect(auditGuard).toContain("pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')");
    expect(auditGuard).toContain(
      "NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')"
    );
    expect(statements).toContain(
      'CREATE TRIGGER "audit_events_plan6b_web_insert_guard"\n' +
      'BEFORE INSERT ON "public"."audit_events"\n' +
      'FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_guard_audit_insert"()'
    );

    for (const statement of [
      'REVOKE ALL ON SCHEMA "public" FROM PUBLIC',
      'REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM PUBLIC',
      'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "public" FROM PUBLIC',
      'REVOKE ALL ON ALL ROUTINES IN SCHEMA "public" FROM PUBLIC',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON TABLES FROM PUBLIC',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM PUBLIC',
      'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON ROUTINES FROM PUBLIC'
    ]) expect(statements).toContain(statement);

    for (const contract of [
      'privilege_row.grantee = 0',
      "privilege_row.object_kind like 'default_%'",
      "privilege_row.object_kind = 'parameter'",
      "privilege_row.privilege_type not in ('CONNECT', 'TEMPORARY')",
      "privilege_row.object_oid = 'pg_catalog.pg_settings'::pg_catalog.regclass",
      'pg_catalog.acldefault(\'f\', function_row.proowner)',
      'function_row.prosecdef',
      'setting_row.setrole = 0',
      "pg_catalog.current_setting('session_replication_role') is distinct from 'origin'"
    ]) {
      expect(migration.toLowerCase()).toContain(contract.toLowerCase());
      expect(provisioner.toLowerCase()).toContain(contract.toLowerCase());
    }
    for (const sensitiveColumn of [
      'outbox_messages:payload',
      'commerce_claim_issuances:*'
    ]) {
      expect(migration).toContain(`'${sensitiveColumn}'`);
      expect(provisioner).toContain(`'${sensitiveColumn}'`);
    }
    const sensitiveTableSelect =
      /privilege_row\.object_kind = 'relation'\s+and privilege_row\.privilege_type = 'select'\s+and exists \(\s+select 1\s+from pg_catalog\.pg_class sensitive_relation/iu;
    expect(migration).toMatch(sensitiveTableSelect);
    expect(provisioner).toMatch(sensitiveTableSelect);
  });

  it('restores exact column ACLs after table-level drift witnesses', () => {
    const boundaries = source('tests/integration/database-role-boundaries.test.ts');
    const caseBlock = (label: string) => {
      const start = boundaries.indexOf(`label: '${label}'`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = boundaries.indexOf('\n    },', start);
      expect(end).toBeGreaterThan(start);
      return boundaries.slice(start, end);
    };
    const outboxRestore = caseBlock('runtime outbox table reads');
    expect(outboxRestore).toContain(
      'revoke select on table public.outbox_messages from pale_orbit_runtime'
    );
    for (const column of [
      'id', 'topic', 'deduplication_key', 'dispatch_job_id', 'status', 'last_error',
      'delivered_at', 'created_at', 'updated_at'
    ]) {
      expect(outboxRestore).toMatch(new RegExp(`grant select \\([\\s\\S]*?\\b${column}\\b`, 'u'));
    }
    expect(outboxRestore).not.toMatch(/grant select \([\s\S]*?\bpayload\b/u);

    const guestIdentityRestore = caseBlock('runtime guest identity table INSERT');
    expect(guestIdentityRestore).toContain(
      'revoke insert on table public.guest_identities from pale_orbit_runtime'
    );
    expect(guestIdentityRestore).toContain(
      'grant insert (email) on table public.guest_identities to pale_orbit_runtime'
    );
  });

  it('keeps all four database credentials on their exact services and secrets', () => {
    const compose = source('compose.prod.yaml');
    const app = serviceBlock(compose, 'app');
    const worker = serviceBlock(compose, 'worker');
    const migrate = serviceBlock(compose, 'migrate');
    const provision = serviceBlock(compose, 'database-role-provision');
    const bootstrap = serviceBlock(compose, 'bootstrap-admin');
    const cleanup = serviceBlock(compose, 'storage-cleanup');
    const postgres = serviceBlock(compose, 'postgres');

    expect(app).toContain('DATABASE_USER: ${DATABASE_USER:');
    expect(app).toContain('DATABASE_PASSWORD_FILE: /run/secrets/database_password');
    expect(app).not.toMatch(/DATABASE_(?:OWNER|WORKER|STORAGE_CLEANUP)_/u);
    expect(worker).toContain('DATABASE_WORKER_USER: ${DATABASE_WORKER_USER:');
    expect(worker).toContain('DATABASE_WORKER_PASSWORD_FILE: /run/secrets/database_worker_password');
    expect(worker).not.toContain('/run/secrets/database_owner_password');
    expect(worker).not.toContain('DATABASE_STORAGE_CLEANUP_');
    expect(migrate).toContain('DATABASE_OWNER_USER: ${DATABASE_OWNER_USER:');
    expect(migrate).toContain('DATABASE_OWNER_PASSWORD_FILE: /run/secrets/database_owner_password');
    expect(migrate).toContain('DATABASE_MIGRATION_WEB_USER: ${DATABASE_USER:');
    expect(migrate).toContain('DATABASE_MIGRATION_WORKER_USER: ${DATABASE_WORKER_USER:');
    expect(migrate).toContain(
      'DATABASE_MIGRATION_STORAGE_CLEANUP_USER: ${DATABASE_STORAGE_CLEANUP_USER:'
    );
    expect(migrate).not.toMatch(/^\s+DATABASE_PASSWORD(?:_FILE)?:/mu);
    expect(postgres).toContain('POSTGRES_USER: ${DATABASE_OWNER_USER:');
    expect(postgres).toContain('POSTGRES_PASSWORD_FILE: /run/secrets/database_owner_password');
    expect(cleanup).toContain('DATABASE_STORAGE_CLEANUP_USER: ${DATABASE_STORAGE_CLEANUP_USER:');
    expect(cleanup).toContain(
      'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE: /run/secrets/database_storage_cleanup_password'
    );
    expect(cleanup).not.toContain('DATABASE_USER:');
    expect(cleanup).not.toContain('/run/secrets/database_password');
    expect(provision).toContain('build/services/provision-database-roles.js');
    expect(provision).toContain('/run/secrets/database_owner_password');
    expect(provision).toContain('/run/secrets/database_password');
    expect(provision).toContain('/run/secrets/database_worker_password');
    expect(provision).toContain('/run/secrets/database_storage_cleanup_password');
    for (const block of [app, worker, migrate, bootstrap, postgres]) {
      expect(block).not.toContain('/run/secrets/database_storage_cleanup_password');
    }
    for (const block of [app, worker, provision, bootstrap, cleanup, postgres]) {
      expect(block).not.toContain('DATABASE_MIGRATION_');
    }
    expect(compose).toMatch(
      /database_storage_cleanup_password:\r?\n {4}environment: DATABASE_STORAGE_CLEANUP_PASSWORD/u
    );
  });

  it('builds and exercises role provisioning before production runtime startup', () => {
    const build = source('vite.services.config.ts');
    const smoke = source('scripts/plan6b-production-smoke.ts');
    const migrationEntrypoint = source('src/migrate.ts');
    const workerEntrypoint = source('src/worker.ts');
    expect(build).toContain("'provision-database-roles': resolve(");
    expect(build).toContain("'src/provision-database-roles.ts'");
    expect(smoke).toContain("'database_owner_password'");
    expect(smoke).toContain("'database_worker_password'");
    expect(smoke).toContain("'database_storage_cleanup_password'");
    expect(smoke).toContain('DATABASE_OWNER_USER:');
    expect(smoke).toContain('DATABASE_WORKER_USER:');
    expect(smoke).toContain('DATABASE_STORAGE_CLEANUP_USER:');
    const provisionIndex = smoke.indexOf("'database-role-provision'");
    expect(provisionIndex).toBeGreaterThan(-1);
    expect(provisionIndex).toBeLessThan(smoke.indexOf('async startRuntime'));
    expect(migrationEntrypoint).toContain(
      "databaseEnvironmentForRole(process.env, 'owner')"
    );
    expect(workerEntrypoint).toContain(
      "databaseEnvironmentForRole(rawWorkerEnvironment, 'worker')"
    );
    expect(source('src/cleanup-storage.ts')).toContain(
      "databaseEnvironmentForRole(process.env, 'storage-cleanup')"
    );
  });

  it('keeps smoke, fixture, and checkpoint migration identity transport on migration only', () => {
    const smoke = source('scripts/plan6b-production-smoke.ts');
    const fixture = source('scripts/plan6b-fixture-runtime-probe.ts');
    const checkpoint = source('scripts/deployment-checkpoint.ts');
    const fixtureMigration = serviceBlock(fixture, 'migrate');

    expect(smoke).toContain("resolve('compose.prod.yaml')");
    expect(checkpoint).toContain("const composeFile = resolve('compose.prod.yaml')");
    for (const [name, value] of [
      ['DATABASE_MIGRATION_WEB_USER', 'pale_orbit_fixture_web'],
      ['DATABASE_MIGRATION_WORKER_USER', 'pale_orbit_fixture_worker'],
      ['DATABASE_MIGRATION_STORAGE_CLEANUP_USER', 'pale_orbit_fixture_storage_cleanup']
    ] as const) {
      expect(fixtureMigration).toContain(`${name}: ${value}`);
    }
    expect(fixtureMigration).not.toMatch(/^\s+DATABASE_PASSWORD(?:_FILE)?:/mu);
    for (const name of ['app', 'worker', 'database-role-provision']) {
      expect(serviceBlock(fixture, name), name).not.toContain('DATABASE_MIGRATION_');
    }
  });

  it('masks the shared env file and removes unrelated credentials from long-running development services', () => {
    const compose = source('compose.dev.yaml');
    const app = serviceBlock(compose, 'app');
    const worker = serviceBlock(compose, 'worker');
    const migrate = serviceBlock(compose, 'migrate');
    const bootstrap = serviceBlock(compose, 'bootstrap-admin');
    const cleanup = serviceBlock(compose, 'storage-cleanup');

    for (const block of [app, worker, bootstrap, cleanup]) {
      expect(block).toContain('DATABASE_OWNER_PASSWORD: ""');
    }
    for (const block of [app, bootstrap, cleanup]) {
      expect(block).toContain('DATABASE_WORKER_PASSWORD: ""');
    }
    expect(migrate).toContain('DATABASE_WORKER_PASSWORD: ""');
    for (const block of [app, worker]) {
      expect(block).toContain('./deploy/container.env:/app/.env:ro');
    }
    for (const name of [
      'DATABASE_OWNER_USER', 'DATABASE_OWNER_PASSWORD', 'DATABASE_OWNER_PASSWORD_FILE',
      'DATABASE_WORKER_USER', 'DATABASE_WORKER_PASSWORD', 'DATABASE_WORKER_PASSWORD_FILE',
      'DATABASE_STORAGE_CLEANUP_USER', 'DATABASE_STORAGE_CLEANUP_USER_FILE',
      'DATABASE_STORAGE_CLEANUP_PASSWORD', 'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE'
    ]) expect(app).toContain(`${name}: ""`);
    for (const name of [
      'DATABASE_OWNER_USER', 'DATABASE_OWNER_PASSWORD', 'DATABASE_OWNER_PASSWORD_FILE',
      'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_PASSWORD_FILE',
      'DATABASE_STORAGE_CLEANUP_USER', 'DATABASE_STORAGE_CLEANUP_USER_FILE',
      'DATABASE_STORAGE_CLEANUP_PASSWORD', 'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE'
    ]) expect(worker).toContain(`${name}: ""`);
    for (const name of [
      'DATABASE_OWNER_USER', 'DATABASE_OWNER_USER_FILE',
      'DATABASE_OWNER_PASSWORD', 'DATABASE_OWNER_PASSWORD_FILE',
      'DATABASE_USER', 'DATABASE_USER_FILE', 'DATABASE_PASSWORD', 'DATABASE_PASSWORD_FILE',
      'DATABASE_WORKER_USER', 'DATABASE_WORKER_USER_FILE',
      'DATABASE_WORKER_PASSWORD', 'DATABASE_WORKER_PASSWORD_FILE'
    ]) expect(cleanup).toContain(`${name}: ""`);
  });

  it('documents all four production database credentials without supplying real secrets', () => {
    const example = source('.env.example');
    for (const name of [
      'DATABASE_OWNER_USER', 'DATABASE_OWNER_PASSWORD',
      'DATABASE_USER', 'DATABASE_PASSWORD',
      'DATABASE_WORKER_USER', 'DATABASE_WORKER_PASSWORD',
      'DATABASE_STORAGE_CLEANUP_USER', 'DATABASE_STORAGE_CLEANUP_PASSWORD'
    ]) expect(example).toContain(`${name}=`);
    expect(example).not.toMatch(/DATABASE_(?:OWNER_|WORKER_|STORAGE_CLEANUP_)?PASSWORD=(?!replace-|pale_orbit_.*dev_only)[^\r\n]+/u);

    for (const path of [
      'README.md',
      'docs/runtime-environments.md',
      'docs/authentication-and-email.md',
      'docs/database-and-workers.md'
    ]) {
      const document = source(path);
      expect(document, path).toContain('DATABASE_OWNER_USER');
      expect(document, path).toContain('DATABASE_OWNER_PASSWORD');
      expect(document, path).toContain('DATABASE_WORKER_USER');
      expect(document, path).toContain('DATABASE_WORKER_PASSWORD');
      expect(document, path).toContain('DATABASE_STORAGE_CLEANUP_USER');
      expect(document, path).toContain('DATABASE_STORAGE_CLEANUP_PASSWORD');
      const migrateIndex = document.indexOf('run --rm migrate');
      const provisionIndex = document.indexOf('run --rm database-role-provision');
      expect(migrateIndex, path).toBeGreaterThan(-1);
      expect(provisionIndex, path).toBeGreaterThan(migrateIndex);
    }

    const databaseRunbook = source('docs/database-and-workers.md');
    expect(databaseRunbook).toContain('existing PostgreSQL data volume');
    expect(databaseRunbook).toContain('DATABASE_OWNER_USER` to the existing database owner');
    expect(databaseRunbook).toContain('must not reuse that owner name for `DATABASE_USER`');
    expect(databaseRunbook).toContain('stop app worker');
    expect(databaseRunbook).toContain('forward-fix-only');
    expect(databaseRunbook).toContain('rotate the formerly shared owner password');
    expect(databaseRunbook).toContain('deploy/container.env');
    expect(databaseRunbook).toContain('Plan 6B financial relations are read-only to the web');
    expect(databaseRunbook).toContain('SELECT-only default privileges');
    const runtimeEnvironments = source('docs/runtime-environments.md');
    expect(runtimeEnvironments).toContain('Plan 6B financial relations are read-only to the web');
    expect(runtimeEnvironments).toContain('SELECT-only default privileges');
  });

  it('adds one bounded storage-cleanup definer with isolated append-only authority', () => {
    const migration = source('drizzle/0011_plan6b_storage_cleanup_authority.sql');
    const provisioner = source('src/lib/server/db/database-role-provision.ts');
    const catalog = source('src/lib/server/db/schema/catalog.ts');
    const operations = source('src/lib/server/db/schema/operations.ts');
    const snapshot = source('drizzle/meta/0011_snapshot.json');
    const journal = JSON.parse(source('drizzle/meta/_journal.json')) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries.find((entry) => entry.idx === 11)).toMatchObject({
      idx: 11,
      tag: '0011_plan6b_storage_cleanup_authority'
    });
    expect(migration).toContain('CREATE ROLE "pale_orbit_storage_cleanup" WITH NOLOGIN');
    expect(migration.indexOf('pg_catalog.pg_auth_members'))
      .toBeLessThan(migration.indexOf('CREATE ROLE "pale_orbit_storage_cleanup"'));
    expect(migration.indexOf('pg_catalog.pg_shdepend'))
      .toBeLessThan(migration.indexOf('CREATE ROLE "pale_orbit_storage_cleanup"'));
    expect(migration).toContain(
      'CREATE FUNCTION "public"."storage_cleanup_referenced_keys"(p_candidate_keys text[])'
    );
    expect(migration.match(/SECURITY DEFINER/gu)).toHaveLength(1);
    expect(migration).toContain('STABLE\nROWS 500\nSECURITY DEFINER');
    expect(migration).toContain("SET search_path = 'pg_catalog'");
    expect(migration).toContain('candidate_count := pg_catalog.cardinality(p_candidate_keys)');
    expect(migration).toContain('IF candidate_count > 500 THEN');
    expect(migration).toContain('pg_catalog.array_ndims(p_candidate_keys) <> 1');
    expect(migration).toContain('pg_catalog.count(DISTINCT candidate_key)');
    expect(migration).toContain('2147483647');
    expect(migration).toContain('generations/');
    expect(migration).toContain('referenced_storage_key text');
    expect(migration).not.toContain('storage_class text');
    expect(migration).toContain(
      "session_user, 'pale_orbit_storage_cleanup', 'MEMBER'"
    );
    expect(migration).toContain("session_user, 'pale_orbit_runtime', 'MEMBER'");
    expect(migration).toContain(
      "session_user, 'pale_orbit_financial_worker', 'MEMBER'"
    );
    expect(migration).not.toContain('\\\\.webp');
    expect(migration).toContain('[.]webp');
    for (const value of [
      'staging/uploads/',
      'prose-images',
      'comic-pages',
      'cover-suggestions'
    ]) expect(migration).toContain(value);
    expect(migration).toContain(
      "'^health/probes/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"
    );
    expect(migration).toContain(
      "WHEN candidate.candidate_key LIKE 'health/probes/%' THEN 'health-probe'"
    );
    expect(migration).toContain("parsed.candidate_class <> 'health-probe'");
    expect(migration.match(/FROM "public"\./gu)).toHaveLength(11);
    for (const reference of [
      '"public"."titles" referenced_title',
      'referenced_title.cover_storage_key',
      '"public"."title_revisions" referenced_revision',
      'referenced_revision.staging_storage_key',
      'referenced_revision.original_storage_key',
      '"public"."prose_images"',
      '"public"."comic_pages"',
      '"public"."revision_cover_suggestions"',
      '"public"."jobs" active_job',
      "active_job.payload ->> 'revisionId'",
      "active_job.payload ->> 'generation'"
    ]) expect(migration).toContain(reference);
    expect(migration).toContain("pg_catalog.split_part(candidate.candidate_key, '/', 2)::uuid");
    expect(migration).toContain('referenced_revision.id = parsed.revision_id');
    expect(migration).not.toContain('referenced_revision.id::text = parsed.revision_id');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION "public"."storage_cleanup_referenced_keys"(text[]) FROM PUBLIC'
    );
    expect(migration).toContain(
      'GRANT USAGE ON SCHEMA "public" TO "pale_orbit_storage_cleanup"'
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION "public"\."storage_cleanup_referenced_keys"\(text\[\]\)\s+TO "pale_orbit_storage_cleanup"/u
    );
    expect(migration).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE).*pale_orbit_storage_cleanup/iu);

    for (const indexName of [
      'titles_cover_storage_key_idx',
      'title_revisions_staging_storage_key_idx',
      'title_revisions_original_storage_key_idx'
    ]) {
      expect(catalog).toContain(`index('${indexName}')`);
      expect(migration).toContain(`CREATE INDEX "${indexName}"`);
      expect(snapshot).toContain(`"${indexName}"`);
    }
    expect(operations).toContain("index('jobs_active_ingest_revision_identity_idx')");
    expect(migration).toContain('CREATE INDEX "jobs_active_ingest_revision_identity_idx"');
    expect(snapshot).toContain('"jobs_active_ingest_revision_identity_idx"');
    expect(migration).toContain("payload" + " ->> 'revisionId'");
    expect(migration).toContain("payload" + " ->> 'generation'");
    expect(migration).toContain("status" + " IN ('pending', 'running')");

    expect(provisioner).toContain("'pale_orbit_storage_cleanup'");
    expect(provisioner).toContain("'storage-cleanup'");
    expect(provisioner).toContain('DATABASE_STORAGE_CLEANUP_USER');
    expect(provisioner).toContain('DATABASE_STORAGE_CLEANUP_PASSWORD');
    expect(provisioner).toContain('"unsafeCleanupEffectiveAuthority"');
    const boundaries = source('tests/integration/database-role-boundaries.test.ts');
    const ownershipWitnessStart = boundaries.indexOf(
      "it('rejects cleanup routine ownership by an arbitrary third role'"
    );
    const ownershipWitnessEnd = boundaries.indexOf('\n  it(', ownershipWitnessStart + 1);
    const ownershipWitness = boundaries.slice(ownershipWitnessStart, ownershipWitnessEnd);
    expect(ownershipWitnessStart).toBeGreaterThanOrEqual(0);
    expect(ownershipWitness).toContain('expectUnexpectedNamedAuthorityProvisionRejected()');
    expect(ownershipWitness).not.toContain('expectStorageCleanupProvisionRejected()');
    expect(source('docs/storage-ingestion-and-publication.md')).toContain(
      'health probes older than `STORAGE_STAGING_RETENTION_HOURS`'
    );
  });

  it('pins Plan 6B-II command routines, runtime privacy, and worker transition authority', () => {
    const migration = source('drizzle/0012_plan6bii_admin_command_authority.sql');
    const correctionMigration = source(
      'drizzle/0013_plan6bii_reporting_correction_authority.sql'
    );
    const provisioner = source('src/lib/server/db/database-role-provision.ts');
    const runtimeRoutines = [
      'submit_financial_admin_command(uuid,text,text,text,text,jsonb)',
      'financial_admin_command_status(uuid,uuid)',
      'append_financial_issue_view_audit(uuid,uuid,text,text,text)',
      'append_financial_refund_review_view_audit(uuid,uuid,text,text,text)',
      'append_financial_payout_view_audit(uuid,uuid,text,text,text)',
      'append_financial_sales_export_audit(uuid,text,text,integer,integer,integer,text,text)'
    ] as const;
    const workerRoutines = [
      'resolve_financial_issue_after_admin_command(uuid,uuid)',
      'transition_administrative_recovery_grant_after_admin_command(uuid)'
    ] as const;

    for (const signature of runtimeRoutines) {
      expect(provisioner).toContain(`'public.${signature}'`);
      const [name, argumentsList] = signature.split('(');
      expect(migration).toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION "public"\\."${name}"\\(${argumentsList!.replace(')', '\\)')} TO "pale_orbit_runtime"`,
        'u'
      ));
    }
    for (const signature of workerRoutines) {
      expect(provisioner).toContain(`'public.${signature}'`);
      expect(migration).toContain(`TO "pale_orbit_financial_worker"`);
    }
    const correctionResolver =
      'resolve_financial_issue_after_reporting_correction_command(uuid,uuid)';
    expect(provisioner).toContain(`'public.${correctionResolver}'`);
    expect(correctionMigration).toContain(
      `GRANT EXECUTE ON FUNCTION "public"."${correctionResolver.replace('(uuid,uuid)', '')}"(uuid,uuid) TO "pale_orbit_financial_worker"`
    );
    expect(correctionMigration).toContain(
      `REVOKE ALL ON FUNCTION "public"."${correctionResolver.replace('(uuid,uuid)', '')}"(uuid,uuid) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup"`
    );
    expect(provisioner).toContain("'financial_admin_commands'");
    expect(provisioner).toContain("'financial_admin_job_claims'");
    expect(provisioner).toContain("'jobs:SELECT:id'");
    expect(provisioner).toContain("'jobs:SELECT:deduplication_key'");
    expect(provisioner).toContain("'jobs:*'");
    expect(provisioner).toContain(
      "'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'"
    );
    for (const forbidden of [
      'jobs:SELECT:payload', 'jobs:SELECT:status', 'jobs:SELECT:attempts',
      'jobs:SELECT:last_error', 'jobs:SELECT:locked_at', 'jobs:SELECT:locked_by'
    ]) expect(provisioner).not.toContain(`'${forbidden}'`);
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "public"."financial_admin_commands" FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup"'
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "public"."financial_admin_job_claims" FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup"'
    );
    expect(migration).toContain(
      'GRANT SELECT ON TABLE "public"."financial_admin_commands" TO "pale_orbit_financial_worker"'
    );
    expect(migration).toContain(
      'GRANT UPDATE ("status", "safe_result_code", "safe_result", "updated_at", "completed_at")'
    );
    for (const privateSignature of [
      'public.plan6bii_assert_financial_admin_job_lease(uuid)',
      'public.plan6bii_guard_financial_admin_job_lease()'
    ]) {
      expect(provisioner).not.toContain(`'${privateSignature}'`);
      const [name] = privateSignature.replace('public.', '').split('(');
      expect(migration).not.toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION "public"\\."${name}"`,
        'u'
      ));
    }
  });
});
