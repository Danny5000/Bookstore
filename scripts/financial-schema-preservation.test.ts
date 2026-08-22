import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getViewConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  currentFinancialProjectionHeads,
  currentFinancialProjectionItems
} from '../src/lib/server/db/schema/financial-allocation';

function source(relativePath: string): string {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const PROVIDER_TABLES = [
  'financial_projection_versions',
  'financial_payout_discovery_state',
  'stripe_balance_transactions',
  'stripe_balance_transaction_fee_details',
  'financial_classification_versions',
  'stripe_payouts',
  'payout_import_runs',
  'payout_import_run_entries',
  'stripe_payout_balance_transactions',
  'financial_scan_runs'
] as const;

const ALLOCATION_TABLES = [
  'financial_allocation_sets',
  'financial_item_allocations',
  'financial_reconciliation_issues',
  'refund_allocation_components',
  'dispute_item_allocations',
  'refund_allocation_drafts',
  'refund_allocation_draft_items',
  'refund_reporting_correction_sets',
  'refund_reporting_correction_items',
  'refund_allocation_finalization_effects'
] as const;

const ROW_ALIASES = [
  'FinancialProjectionVersionRow',
  'FinancialPayoutDiscoveryStateRow',
  'StripeBalanceTransactionRow',
  'StripeBalanceTransactionFeeDetailRow',
  'FinancialClassificationVersionRow',
  'StripePayoutRow',
  'PayoutImportRunRow',
  'PayoutImportRunEntryRow',
  'StripePayoutBalanceTransactionRow',
  'FinancialScanRunRow',
  'FinancialAllocationSetRow',
  'FinancialItemAllocationRow',
  'FinancialIssueRow',
  'RefundAllocationComponentRow',
  'DisputeItemAllocationRow',
  'RefundAllocationDraftRow',
  'RefundAllocationDraftItemRow',
  'RefundReportingCorrectionSetRow',
  'RefundReportingCorrectionItemRow',
  'RefundAllocationFinalizationEffectRow'
] as const;

const IMMUTABLE_GUARD_TABLES = [
  'stripe_balance_transaction_fee_details',
  'financial_classification_versions',
  'stripe_payout_balance_transactions',
  'financial_allocation_sets',
  'financial_item_allocations',
  'refund_allocation_components',
  'dispute_item_allocations',
  'refund_reporting_correction_sets',
  'refund_reporting_correction_items',
  'refund_allocation_finalization_effects',
  'refund_allocations'
] as const;

const NARROW_UPDATE_GUARD_TABLES = [
  'financial_projection_versions',
  'stripe_balance_transactions',
  'stripe_payouts',
  'refund_allocation_drafts',
  'refund_allocation_draft_items',
  'financial_reconciliation_issues'
] as const;

const ADMIN_COMMAND_MIGRATION = '../drizzle/0012_plan6bii_admin_command_authority.sql';

function renderedProjectionHeads(): string {
  return getViewConfig(currentFinancialProjectionHeads).query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  }).sql.replaceAll('\r\n', '\n');
}

function renderedProjectionItems(): string {
  return getViewConfig(currentFinancialProjectionItems).query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  }).sql.replaceAll('\r\n', '\n');
}

function triggerAttachment(tableName: string): RegExp {
  return new RegExp(
    `create\\s+trigger\\s+"?[a-z0-9_]+"?\\s+before\\s+(?:update\\s+or\\s+delete|delete\\s+or\\s+update)\\s+on\\s+"?(?:public\\.)?"?${tableName}"?`,
    'iu'
  );
}

describe('Plan 6B financial schema preservation', () => {
  it('casts every dynamic pg_catalog.format parameter in the migration fixture', () => {
    const integration = source('../tests/integration/financial-migration.test.ts');
    const helperStart = integration.indexOf('async function formattedRoleStatement(');
    const helperEnd = integration.indexOf(
      'async function runPlan6biiMigrationIdentityCases(',
      helperStart
    );
    const helper = integration.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(helper).toContain('`$${index + 2}::text`');
    expect(helper).toContain(
      '`select pg_catalog.format($1::text, ${placeholders}) as statement`'
    );
  });

  it('pins catalog-cleared migration settings and non-origin preflight rollback', () => {
    const integration = source('../tests/integration/financial-migration.test.ts');
    const settingsStart = integration.indexOf(
      'async function assertPlan6biiMigrationSettingsCleared('
    );
    const settingsEnd = integration.indexOf(
      'async function runCommittedPlan6biiAttestedMigration(',
      settingsStart
    );
    const settings = integration.slice(settingsStart, settingsEnd);

    expect(settingsStart).toBeGreaterThanOrEqual(0);
    expect(settingsEnd).toBeGreaterThan(settingsStart);
    expect(settings).toContain('pg_catalog.pg_db_role_setting');
    expect(settings).toContain('pg_catalog.unnest(setting_row.setconfig)');
    expect(settings).toContain('persisted_setting_count');
    for (const name of [
      'pale_orbit.migration_expected_web_login',
      'pale_orbit.migration_expected_worker_login',
      'pale_orbit.migration_expected_storage_cleanup_login'
    ]) expect(settings).toContain(name);
    expect(settings).toMatch(
      /equal\(\s*persisted\.persisted_setting_count,\s*0,\s*'migration login attestation persisted in role\/database settings'\s*\)/u
    );

    const identityFailureStart = integration.indexOf(
      'async function expectPlan6biiIdentityFailure('
    );
    const identityFailureEnd = integration.indexOf(
      'async function expectPlan6biiNonOriginSessionReplicationFailure(',
      identityFailureStart
    );
    const identityFailure = integration.slice(identityFailureStart, identityFailureEnd);
    expect(identityFailure.indexOf('await cleanup?.();')).toBeLessThan(
      identityFailure.indexOf('await assertPlan6biiMigrationSettingsCleared(client);')
    );
    expect(identityFailure).toContain(
      '...Object.values(identities).filter((identity) =>\n' +
      '            !PLAN6BII_PUBLIC_ROLE_NAMES.has(identity)\n' +
      '          )'
    );
    expect(identityFailure.indexOf('!PLAN6BII_PUBLIC_ROLE_NAMES.has(identity)'))
      .toBeLessThan(identityFailure.indexOf('process.env.DATABASE_PASSWORD'));
    const roleEdgesStart = integration.indexOf('const PLAN6BII_ATTESTED_ROLE_EDGES');
    const publicRoleNamesStart = integration.indexOf(
      'const PLAN6BII_PUBLIC_ROLE_NAMES',
      roleEdgesStart
    );
    const publicRoleNamesEnd = integration.indexOf(
      'async function dropPlan6biiAttestedRoles(',
      publicRoleNamesStart
    );
    const publicRoleNames = integration.slice(roleEdgesStart, publicRoleNamesEnd);
    expect(roleEdgesStart).toBeGreaterThanOrEqual(0);
    expect(publicRoleNamesStart).toBeGreaterThanOrEqual(0);
    expect(publicRoleNamesEnd).toBeGreaterThan(publicRoleNamesStart);
    expect(publicRoleNames).toContain(
      'new Set<string>(\n  PLAN6BII_ATTESTED_ROLE_EDGES.map(([, groupName]) => groupName)\n)'
    );
    for (const roleName of [
      'pale_orbit_runtime',
      'pale_orbit_financial_worker',
      'pale_orbit_storage_cleanup'
    ]) expect(publicRoleNames).toContain(`'${roleName}'`);

    const nonOriginStart = identityFailureEnd;
    const nonOriginEnd = integration.indexOf(
      'async function expectPlan6biiIdentitySuccess(',
      nonOriginStart
    );
    const nonOrigin = integration.slice(nonOriginStart, nonOriginEnd);
    expect(nonOriginStart).toBeGreaterThan(identityFailureStart);
    expect(nonOriginEnd).toBeGreaterThan(nonOriginStart);
    const replica = nonOrigin.indexOf('set session_replication_role = replica');
    const migrate = nonOrigin.indexOf('await migrateDatabase(drizzle(client)');
    const restore = nonOrigin.indexOf('set session_replication_role = origin');
    const settingsCleared = nonOrigin.indexOf(
      'await assertPlan6biiMigrationSettingsCleared(client);'
    );
    expect(replica).toBeGreaterThanOrEqual(0);
    expect(migrate).toBeGreaterThan(replica);
    expect(restore).toBeGreaterThan(migrate);
    expect(settingsCleared).toBeGreaterThan(restore);
    expect(nonOrigin).toContain("equal(postgresError.code, '42501'");
    expect(nonOrigin).toContain('Plan 6B-II migration requires canonical owner authority');
    expect(nonOrigin).toContain("equal(await migrationCount(casePool), 12");
    expect(nonOrigin).toContain('await plan6biiCatalogState(casePool)');
    expect(nonOrigin).toContain('before');
    expect(nonOrigin).toContain('finally {');
    expect(integration).toContain(
      'await expectPlan6biiNonOriginSessionReplicationFailure(pool, migrationsFolder);'
    );
  });

  it('clones Plan 6B-II identity cases from a quiescent owned through-0011 source', () => {
    const integration = source('../tests/integration/financial-migration.test.ts');
    const attestationStart = integration.indexOf(
      'async function assertPlan6biiMigrationIdentityAttestation('
    );
    const attestationEnd = integration.indexOf(
      'async function expectPlan6biiCollisionFailure(',
      attestationStart
    );
    const attestation = integration.slice(attestationStart, attestationEnd);
    const fixtureStart = integration.indexOf(
      'async function runPlan6biiAdminCommandAuthorityFixture('
    );
    const fixtureEnd = integration.indexOf('async function runValidFixture(', fixtureStart);
    const fixture = integration.slice(fixtureStart, fixtureEnd);
    const main = integration.slice(integration.indexOf('async function main(): Promise<void>'));
    const caseStart = integration.indexOf('async function withPlan6biiIdentityCase(');
    const caseEnd = integration.indexOf(
      'async function expectPlan6biiIdentityFailure(',
      caseStart
    );
    const identityCase = integration.slice(caseStart, caseEnd);
    const cloneHelperStart = integration.indexOf('async function createPlan6biiDatabase(');
    const cloneHelperEnd = integration.indexOf(
      'async function dropPlan6biiDatabase(',
      cloneHelperStart
    );
    const cloneHelper = integration.slice(cloneHelperStart, cloneHelperEnd);

    expect(attestationStart).toBeGreaterThanOrEqual(0);
    expect(attestationEnd).toBeGreaterThan(attestationStart);
    expect(attestation).not.toContain("'template0'");
    expect(attestation).not.toContain('createMigrationFolderThrough(11)');
    expect(integration).toContain('function plan6biiOwnedSourceDatabaseName(): string');
    expect(integration).toContain('process.env.DATABASE_NAME');
    expect(integration).toContain('database === `plan6b_${runId}`');

    const through11 = fixture.indexOf('createMigrationFolderThrough(11)');
    const population = fixture.indexOf('insertUserAndTitles(populationClient, 1)');
    const sourceClose = fixture.indexOf('await sourcePool.end();');
    const controlOpen = fixture.indexOf("controlPool = plan6biiPool('postgres');");
    const disableStatement = fixture.indexOf(
      "'alter database %I with allow_connections false'"
    );
    const restoreStatement = fixture.indexOf(
      "'alter database %I with allow_connections true'",
      disableStatement
    );
    const restorationOwed = fixture.indexOf(
      'sourceConnectionsRestorationOwed = true;',
      restoreStatement
    );
    const disableExecute = fixture.indexOf(
      'await controlPool.query(disableSourceConnectionsStatement);',
      restorationOwed
    );
    const terminateSessions = fixture.indexOf(
      'pg_catalog.pg_terminate_backend(activity.pid)',
      disableExecute
    );
    const proveDrained = fixture.indexOf(
      "assert(sourceSessionsDrained, 'Plan 6B-II source database did not quiesce');",
      terminateSessions
    );
    const templateClone = fixture.indexOf(
      'await createPlan6biiDatabase(controlPool, template, sourceDatabase);'
    );
    const restoreExecute = fixture.indexOf(
      'await controlPool.query(restoreSourceConnectionsStatement);',
      templateClone
    );
    const restorationCleared = fixture.indexOf(
      'sourceConnectionsRestorationOwed = false;',
      restoreExecute
    );
    const replacementOpen = fixture.indexOf('sourcePool = databasePool();', templateClone);
    expect(through11).toBeGreaterThanOrEqual(0);
    expect(population).toBeGreaterThan(through11);
    expect(sourceClose).toBeGreaterThan(population);
    expect(sourceClose).toBeGreaterThanOrEqual(0);
    expect(controlOpen).toBeGreaterThan(sourceClose);
    expect(disableStatement).toBeGreaterThan(controlOpen);
    expect(restoreStatement).toBeGreaterThan(disableStatement);
    expect(restorationOwed).toBeGreaterThan(restoreStatement);
    expect(disableExecute).toBeGreaterThan(restorationOwed);
    expect(terminateSessions).toBeGreaterThan(disableExecute);
    expect(proveDrained).toBeGreaterThan(terminateSessions);
    expect(templateClone).toBeGreaterThan(proveDrained);
    expect(restoreExecute).toBeGreaterThan(templateClone);
    expect(restorationCleared).toBeGreaterThan(restoreExecute);
    expect(replacementOpen).toBeGreaterThan(restorationCleared);
    expect(fixture).toContain("'alter database %I with allow_connections true'");
    expect(fixture).toContain('for (let drainAttempt = 0; drainAttempt < 20; drainAttempt += 1)');
    expect(fixture).toContain('activity.datname = $1');
    expect(fixture).toContain('activity.pid <> pg_catalog.pg_backend_pid()');
    expect(fixture).toContain('[sourceDatabase]');
    expect(fixture).not.toContain('alter database ${sourceDatabase}');
    expect(fixture).toContain('finally {');
    expect(fixture).toContain('await dropPlan6biiDatabase(activeControlPool, template);');
    expect(fixture).toContain('if (sourceConnectionsRestorationOwed)');
    expect(fixture).toContain('let primaryFailed = false;');
    expect(fixture).toContain('let primaryFailure: unknown;');
    expect(fixture).toContain('primaryFailed = true;');
    expect(fixture).toContain('if (primaryFailed) {');
    expect(fixture).toContain('throw primaryFailure;');
    expect(fixture).toContain('if (cleanupFailure !== undefined) {');
    expect(fixture.lastIndexOf('await activeControlPool.query(restoreSourceConnectionsStatement);'))
      .toBeLessThan(fixture.lastIndexOf('await activeControlPool.end();'));
    expect(fixture.lastIndexOf('await dropPlan6biiDatabase(activeControlPool, template);'))
      .toBeLessThan(fixture.lastIndexOf('await activeControlPool.end();'));
    expect(fixture.match(/await sourcePool\.end\(\);/gu)).toHaveLength(2);
    expect(fixture.match(/await migrate\(drizzle\(pool\)/gu)).toHaveLength(1);
    expect(fixture).toMatch(
      /'unsafe fixed-group membership option',\s*\/Plan 6B-II migration login identity is not canonical\/iu/u
    );

    expect(identityCase).toContain('finally {');
    expect(identityCase).toContain('await casePool.end();');
    expect(identityCase).toContain('await dropPlan6biiDatabase(pool, database);');
    expect(cloneHelperStart).toBeGreaterThanOrEqual(0);
    expect(cloneHelperEnd).toBeGreaterThan(cloneHelperStart);
    expect(cloneHelper).toContain("'grant connect on database %I to %I, %I, %I'");
    for (const roleName of [
      'pale_orbit_runtime',
      'pale_orbit_financial_worker',
      'pale_orbit_storage_cleanup'
    ]) expect(cloneHelper).toContain(`'${roleName}'`);
    expect(cloneHelper.indexOf('await pool.query(statement);')).toBeLessThan(
      cloneHelper.indexOf('await pool.query(connectStatement);')
    );

    const ownedDispatch = main.indexOf(
      "if (rawFixture === 'plan6bii-admin-command-authority')"
    );
    const genericPoolOpen = main.indexOf('const pool = databasePool();');
    expect(ownedDispatch).toBeGreaterThanOrEqual(0);
    expect(ownedDispatch).toBeLessThan(genericPoolOpen);
    expect(main.slice(genericPoolOpen)).not.toContain(
      'runPlan6biiAdminCommandAuthorityFixture(pool)'
    );

    const identityCasesStart = integration.indexOf(
      'async function runPlan6biiMigrationIdentityCases('
    );
    const identityCasesEnd = integration.indexOf(
      'async function assertPlan6biiMigrationIdentityAttestation(',
      identityCasesStart
    );
    const roleCases = integration.slice(identityCasesStart, identityCasesEnd);
    for (const cleanupState of [
      'unexpectedLoginCreated', 'unexpectedLoginGranted',
      'ownerEdgeRoleCreated', 'ownerEdgeRoleGranted'
    ]) expect(roleCases).toContain(`let ${cleanupState} = false;`);
    expect(roleCases).toMatch(
      /try \{[\s\S]*create role "\$\{unexpectedLogin\}"[\s\S]*unexpectedLoginCreated = true;[\s\S]*unexpectedLoginGranted = true;[\s\S]*finally \{[\s\S]*revoke "pale_orbit_runtime" from "\$\{unexpectedLogin\}"[\s\S]*finally \{[\s\S]*drop role "\$\{unexpectedLogin\}"/u
    );
    expect(roleCases).toMatch(
      /try \{[\s\S]*create role "\$\{ownerEdgeRole\}"[\s\S]*ownerEdgeRoleCreated = true;[\s\S]*ownerEdgeRoleGranted = true;[\s\S]*finally \{[\s\S]*revoke %I from %I[\s\S]*finally \{[\s\S]*drop role "\$\{ownerEdgeRole\}"/u
    );

    for (const [startMarker, endMarker] of [
      [
        'async function runCommittedPlan6biiAttestedMigration(',
        'async function runRepairedFixtureThroughPlan6biiHead('
      ],
      [
        'async function expectPlan6biiIdentityFailure(',
        'async function expectPlan6biiIdentitySuccess('
      ],
      [
        'async function expectPlan6biiIdentitySuccess(',
        'async function formattedRoleStatement('
      ],
      [
        'async function expectPlan6biiCollisionFailure(',
        'async function runPlan6biiAdminCommandAuthorityFixture('
      ]
    ] as const) {
      const start = integration.indexOf(startMarker);
      const end = integration.indexOf(endMarker, start);
      const attempt = integration.slice(start, end);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(attempt).toContain('await migrateDatabase(');
      expect(attempt).not.toMatch(/await migrate\(/u);
    }
  });

  it('pins the protected administrator-command schema, lifecycle, and provenance guards', () => {
    const schemaModule = source('../src/lib/server/db/schema/financial-admin.ts');
    const schemaIndex = source('../src/lib/server/db/schema/index.ts');
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const snapshot = source('../drizzle/meta/0012_snapshot.json');
    const journal = source('../drizzle/meta/_journal.json');

    expect(schemaModule).toMatch(/pgTable\(\s*'financial_admin_commands'/u);
    expect(schemaModule).toMatch(/pgTable\(\s*'financial_admin_job_claims'/u);
    expect(schemaIndex).toContain("export * from './financial-admin';");
    expect(snapshot).toContain('public.financial_admin_commands');
    expect(snapshot).toContain('public.financial_admin_job_claims');
    expect(snapshot).toContain('financial_admin_commands_input_kind_consistent');
    expect(snapshot).toContain(
      'case when pg_catalog.jsonb_typeof(\\"financial_admin_commands\\".\\"private_input\\" -> \'items\' -> 0) = \'object\''
    );
    expect(snapshot).toContain(
      '(\\"financial_admin_commands\\".\\"private_input\\" -> \'items\' -> 0) - \'orderItemId\''
    );
    expect(journal).toContain('0012_plan6bii_admin_command_authority');
    for (const vocabulary of [
      'financial_admin_command_kind', 'financial_admin_command_status',
      'refund_draft_save', 'refund_draft_discard', 'refund_allocation_finalize',
      'refund_reporting_correction_create', 'administrative_recovery_activate',
      'administrative_recovery_deactivate', 'pending', 'succeeded', 'denied',
      'conflict', 'failed'
    ]) expect(migration).toContain(vocabulary);
    for (const invariant of [
      'financial_admin_commands_actor_idempotency_unique',
      'financial_admin_commands_job_unique',
      'financial_admin_commands_status_created_idx',
      'financial_admin_commands_input_kind_consistent',
      'financial_admin_commands_job_id_jobs_id_fk',
      'financial_admin_job_claims_job_id_jobs_id_fk',
      'financial_admin_job_claims_capability_sha256_valid',
      'financial_admin_job_claims_lifecycle_consistent',
      'DEFERRABLE INITIALLY DEFERRED',
      "'^[a-f0-9]{64}$'", 'pg_catalog.isfinite'
    ]) expect(migration).toContain(invariant);
    expect(migration).toMatch(/pg_column_size\([^)]*"private_input"\) <= 8192/u);
    expect(migration).toMatch(/pg_column_size\([^)]*"safe_result"\) <= 4096/u);
    expect(migration).toContain(
      'CONSTRAINT "financial_admin_commands_lifecycle_consistent" CHECK (('
    );
    for (const guard of [
      'plan6bii_guard_financial_admin_command_update',
      'financial_admin_commands_plan6bii_update_guard',
      'plan6bii_guard_financial_admin_command_delete',
      'financial_admin_commands_plan6bii_delete_guard',
      'plan6bii_assert_financial_admin_job_lease',
      'plan6bii_guard_financial_admin_job_lease',
      'jobs_plan6bii_financial_admin_lease_guard',
      'plan6bii_guard_administrative_grant_transition',
      'entitlement_grants_plan6bii_administrative_guard',
      'plan6bii_sync_failed_financial_admin_command',
      'jobs_plan6bii_financial_admin_terminal_sync'
    ]) expect(migration).toContain(guard);
    expect(migration).toContain('?& ARRAY[');
    expect(migration).toContain('IS DISTINCT FROM TRUE');
    expect(migration).not.toContain('pg_catalog.greatest');
    const submitRoutine = migration.slice(
      migration.indexOf('CREATE FUNCTION "public"."submit_financial_admin_command"'),
      migration.indexOf(
        'REVOKE ALL ON FUNCTION "public"."submit_financial_admin_command"'
      )
    );
    expect(submitRoutine).toContain('expectedStateChangedAt');
    expect(submitRoutine).toContain('pg_catalog.to_char(');
    expect(submitRoutine).toMatch(/pg_catalog\.timezone\(\s*'UTC'/u);
    const commandUpdateGuard = migration.slice(
      migration.indexOf(
        'CREATE FUNCTION "public"."plan6bii_guard_financial_admin_command_update"'
      ),
      migration.indexOf(
        'REVOKE ALL ON FUNCTION "public"."plan6bii_guard_financial_admin_command_update"'
      )
    );
    expect(commandUpdateGuard).toContain(
      "CASE WHEN pg_catalog.jsonb_typeof(NEW.safe_result) = 'object' THEN"
    );
  });

  it('puts a total authority/default-ACL/trigger preflight before every persistent statement', () => {
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const firstType = migration.indexOf('CREATE TYPE "public"."financial_admin_command_kind"');
    const preflightEnd = migration.indexOf('$plan6bii_preflight$;--> statement-breakpoint');
    const preflight = migration.slice(0, preflightEnd);

    expect(migration.startsWith('DO $plan6bii_preflight$')).toBe(true);
    expect(preflightEnd).toBeGreaterThan(0);
    expect(preflightEnd).toBeLessThan(firstType);
    for (const authorityFact of [
      'session_replication_role', 'pg_default_acl', 'aclexplode',
      'pg_parameter_acl', 'unsafe_parameter_acl',
      'defaclobjtype', 'defaclrole', 'grantor', 'is_grantable',
      'actual_default_acl_identity', 'expected_default_acl_identity',
      'default_acl_identity_delta',
      'actual_database_acl', 'expected_database_acl', 'database_acl_delta',
      'actual_schema_acl', 'expected_schema_acl', 'schema_acl_delta',
      'actual_relation_acl', 'expected_relation_acl', 'relation_acl_delta',
      'actual_column_acl', 'expected_column_acl', 'column_acl_delta',
      'actual_routine_acl', 'expected_routine_acl', 'routine_acl_delta',
      'actual_type_acl', 'expected_type_acl', 'type_acl_delta',
      'unexpected_jobs_before_update_trigger',
      'tgnargs', 'tgargs', 'tgattr', 'tgqual',
      'jobs_plan6b_web_insert_guard', 'audit_events_plan6b_web_insert_guard',
      'financial_reconciliation_issues_narrow_update',
      'expected_jobs_trigger_inventory', 'expected_nonjob_trigger_inventory',
      'plan6b_guard_job_insert()', 'plan6b_guard_audit_insert()',
      'plan6b_validate_issue_transition()', 'pale_orbit_runtime',
      'pale_orbit_financial_worker', 'pale_orbit_storage_cleanup'
    ]) expect(preflight).toContain(authorityFact);
    expect(preflight).toContain('has_table_privilege(\n    \'pale_orbit_financial_worker\'');
    expect(preflight).toContain("'public.jobs'::pg_catalog.regclass");
    expect(preflight).toMatch(
      /namespace_row\.nspowner NOT IN \(\s*database_owner,\s*'pg_database_owner'::pg_catalog\.regrole\s*\)/u
    );
    expect(preflight).not.toContain('namespace_row.nspowner <> database_owner');
    const schemaAclStart = preflight.indexOf('), actual_schema_acl AS (');
    const schemaAclEnd = preflight.indexOf('), schema_acl_delta AS (', schemaAclStart);
    expect(schemaAclStart).toBeGreaterThanOrEqual(0);
    expect(schemaAclEnd).toBeGreaterThan(schemaAclStart);
    const schemaAclInventory = preflight.slice(schemaAclStart, schemaAclEnd);
    expect(schemaAclInventory).toMatch(
      /privilege\.grantee IN \(\s*database_owner,\s*'pg_database_owner'::pg_catalog\.regrole\s*\)/u
    );
    expect(schemaAclInventory).toMatch(
      /privilege\.grantor IN \(\s*database_owner,\s*'pg_database_owner'::pg_catalog\.regrole\s*\)/u
    );
    expect(schemaAclInventory).toContain("THEN 'DATABASE_OWNER'");
    expect(schemaAclInventory).toContain("('DATABASE_OWNER', 'CREATE')");
    expect(schemaAclInventory).toContain("('DATABASE_OWNER', 'USAGE')");
    const schemaAclDeltaEnd = preflight.indexOf(
      '), protected_acl_relations(relation_name) AS (',
      schemaAclEnd
    );
    expect(schemaAclDeltaEnd).toBeGreaterThan(schemaAclEnd);
    const schemaAclDelta = preflight.slice(schemaAclEnd, schemaAclDeltaEnd);
    expect(schemaAclDelta.match(/EXCEPT ALL/gu)).toHaveLength(2);
    expect(preflight).toContain(
      "'public.reject_audit_event_mutation()'::pg_catalog.regprocedure"
    );
    expect(preflight).toContain(
      "'public.plan6b_validate_issue_insert()'::pg_catalog.regprocedure"
    );
    for (const prerequisite of [
      "'public.stripe_events'",
      "'public.title_revisions'",
      "'public.claim_guest_purchases_after_authorization(text,text)'",
      "'public.resolve_financial_issue_after_worker_recompute(uuid,text)'",
      "'public.stripe_event_status'",
      "'public.revision_state'"
    ]) expect(preflight).toContain(prerequisite);
    for (const aclTuple of [
      "('stripe_events','pale_orbit_runtime','SELECT')",
      "('stripe_events','pale_orbit_financial_worker','UPDATE')",
      "('title_revisions','pale_orbit_runtime','SELECT')",
      "('title_revisions','pale_orbit_financial_worker','UPDATE')",
      "('stripe_events.provider_event_id','pale_orbit_runtime','INSERT')",
      "('title_revisions.state','pale_orbit_runtime','UPDATE')",
      "('text, text:claim_guest_purchases_after_authorization','pale_orbit_runtime')",
      "('uuid, text:resolve_financial_issue_after_worker_recompute','pale_orbit_financial_worker')"
    ]) expect(preflight).toContain(aclTuple);
    expect(preflight).toContain("(trigger_row.tgtype & 2) = 2");
    expect(preflight).toContain("(trigger_row.tgtype & 16) = 16");
    expect(preflight).toContain("ERRCODE = '42501'");
    expect(preflight).not.toContain('privilege.grantee <> database_owner');
    const defaultIdentityStart = preflight.indexOf('WITH actual_default_acl_identity(');
    const defaultIdentityEnd = preflight.indexOf(
      '), expected_default_acl_identity(',
      defaultIdentityStart
    );
    expect(defaultIdentityStart).toBeGreaterThanOrEqual(0);
    expect(defaultIdentityEnd).toBeGreaterThan(defaultIdentityStart);
    const defaultIdentityInventory = preflight.slice(
      defaultIdentityStart,
      defaultIdentityEnd
    );
    expect(defaultIdentityInventory).toContain('FROM pg_catalog.pg_default_acl default_acl');
    expect(defaultIdentityInventory).not.toContain('WHERE');
  });

  it('normalizes only implicit per-schema owner table and sequence default privileges', () => {
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const preflightEnd = migration.indexOf('$plan6bii_preflight$;--> statement-breakpoint');
    const preflight = migration.slice(0, preflightEnd);
    const rawStart = preflight.indexOf('WITH raw_explicit_default_acl AS (');
    const implicitStart = preflight.indexOf(
      '), implicit_owner_default_acl AS (',
      rawStart
    );
    const normalizedStart = preflight.indexOf(
      '), normalized_effective_default_acl AS (',
      implicitStart
    );
    const expectedStart = preflight.indexOf(
      '), expected_default_acl(',
      normalizedStart
    );
    const deltaStart = preflight.indexOf('), default_acl_delta AS (', expectedStart);
    const deltaEnd = preflight.indexOf('SELECT 1 FROM default_acl_delta', deltaStart);

    expect(rawStart).toBeGreaterThanOrEqual(0);
    expect(implicitStart).toBeGreaterThan(rawStart);
    expect(normalizedStart).toBeGreaterThan(implicitStart);
    expect(expectedStart).toBeGreaterThan(normalizedStart);
    expect(deltaStart).toBeGreaterThan(expectedStart);
    expect(deltaEnd).toBeGreaterThan(deltaStart);
    const raw = preflight.slice(rawStart, implicitStart);
    const implicit = preflight.slice(implicitStart, normalizedStart);
    const normalized = preflight.slice(normalizedStart, expectedStart);
    const expected = preflight.slice(expectedStart, deltaStart);
    const delta = preflight.slice(deltaStart, deltaEnd);

    expect(raw).toContain('FROM pg_catalog.pg_default_acl default_acl');
    expect(raw).not.toContain('WHERE default_acl.defaclrole = database_owner');
    expect(implicit).toContain('default_acl.defaclrole = database_owner');
    expect(implicit).toContain(
      "default_acl.defaclnamespace = 'public'::pg_catalog.regnamespace::oid"
    );
    expect(implicit).toContain("default_acl.defaclobjtype IN ('r'::\"char\", 'S'::\"char\")");
    expect(implicit).not.toContain("'f'::\"char\"");
    for (const ownerPrivilege of [
      "('r','INSERT')", "('r','SELECT')", "('r','UPDATE')", "('r','DELETE')",
      "('r','TRUNCATE')", "('r','REFERENCES')", "('r','TRIGGER')",
      "('r','MAINTAIN')", "('S','USAGE')", "('S','SELECT')", "('S','UPDATE')"
    ]) expect(implicit).toContain(ownerPrivilege);
    expect(normalized).toMatch(
      /SELECT \* FROM raw_explicit_default_acl\s+UNION ALL\s+SELECT \* FROM implicit_owner_default_acl/u
    );
    for (const expectedOwnerTuple of [
      "('public','r',database_owner_name::text,'INSERT')",
      "('public','r',database_owner_name::text,'MAINTAIN')",
      "('public','S',database_owner_name::text,'USAGE')",
      "('global','f',database_owner_name::text,'EXECUTE')"
    ]) expect(expected).toContain(expectedOwnerTuple);
    expect(delta.match(/EXCEPT ALL/gu)).toHaveLength(2);
    expect(delta).toContain('normalized_effective_default_acl');

    const integration = source('../tests/integration/financial-migration.test.ts');
    expect(integration).toContain('redundant explicit database-owner default ACL');
    expect(integration).toMatch(
      /alter default privileges in schema public\s+grant select on tables to current_user/u
    );
    expect(integration).toMatch(
      /alter default privileges in schema public\s+revoke select on tables from current_user/u
    );
  });

  it('attests three exact login identities independently instead of accepting anonymous counts', () => {
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const preflightEnd = migration.indexOf('$plan6bii_preflight$;--> statement-breakpoint');
    const preflight = migration.slice(0, preflightEnd);

    for (const [setting, variable, group] of [
      [
        'pale_orbit.migration_expected_web_login',
        'expected_web_login',
        'pale_orbit_runtime'
      ],
      [
        'pale_orbit.migration_expected_worker_login',
        'expected_worker_login',
        'pale_orbit_financial_worker'
      ],
      [
        'pale_orbit.migration_expected_storage_cleanup_login',
        'expected_storage_cleanup_login',
        'pale_orbit_storage_cleanup'
      ]
    ] as const) {
      expect(preflight).toContain(`current_setting('${setting}', true)`);
      expect(preflight).toContain(variable);
      expect(preflight).toContain(group);
    }
    expect(preflight).toContain("'^[a-z][a-z0-9_]{0,62}$'");
    for (const structuralProof of [
      'attested_login_expectations',
      'present_attested_logins',
      'absent_attested_logins',
      'invalid_present_attested_logins',
      'invalid_absent_attested_logins',
      'relevant_role_names',
      'actual_relevant_memberships',
      'expected_relevant_memberships',
      'relevant_membership_delta',
      'unsafe_attestation_setting_default'
    ]) expect(preflight).toContain(structuralProof);
    expect(preflight).toMatch(
      /present_attested_logins\s+AS\s*\([\s\S]*?role_oid\s+IS\s+NOT\s+NULL[\s\S]*?\),\s*absent_attested_logins/iu
    );
    expect(preflight).toMatch(
      /absent_attested_logins\s+AS\s*\([\s\S]*?role_oid\s+IS\s+NULL[\s\S]*?\),\s*invalid_present_attested_logins/iu
    );
    for (const exactEdge of [
      "(expected_web_login::text,'pale_orbit_runtime'::text,false,true,false)",
      "(expected_worker_login::text,'pale_orbit_financial_worker'::text,false,true,false)",
      "(expected_storage_cleanup_login::text,'pale_orbit_storage_cleanup'::text,false,true,false)",
      "('pale_orbit_financial_worker','pale_orbit_runtime',false,true,false)"
    ]) expect(preflight.replace(/\s+/gu, '')).toContain(exactEdge.replace(/\s+/gu, ''));
    expect(preflight).toMatch(
      /actual_relevant_memberships[\s\S]*database_owner_name[\s\S]*expected_relevant_memberships[\s\S]*relevant_membership_delta/iu
    );
    expect(preflight).toMatch(
      /actual_relevant_memberships\s+AS\s*\([\s\S]*?member_role\.rolname\s+IN\s*\([\s\S]*?relevant_role_names[\s\S]*?OR[\s\S]*?granted_role\.rolname\s+IN\s*\([\s\S]*?relevant_role_names/iu
    );
    expect(preflight).toMatch(
      /unsafe_attestation_setting_default[\s\S]*pg_catalog\.pg_db_role_setting[\s\S]*setrole[\s\S]*database_owner[\s\S]*setdatabase[\s\S]*database_oid/iu
    );
    expect(preflight).not.toContain('login_membership_count');
    expect(preflight).not.toContain('configured_login_memberships');
    expect(preflight).not.toMatch(/membership_count\s+NOT IN\s*\(0,\s*3\)/iu);
    expect(migration).not.toMatch(
      /alter\s+(?:role|database)[\s\S]{0,160}migration_expected_(?:web|worker|storage_cleanup)_login/iu
    );
    expect(migration).not.toMatch(
      /create\s+table[\s\S]{0,120}(?:migration_(?:identity|attestation)|expected_login)/iu
    );
  });

  it('postflights every protected command privilege including MAINTAIN and private helpers', () => {
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const postflight = migration.slice(migration.indexOf('DO $plan6bii_postflight$'));

    expect(postflight).toContain("('MAINTAIN')");
    for (const column of [
      'status', 'safe_result_code', 'safe_result', 'updated_at', 'completed_at'
    ]) expect(postflight).toContain(
      `('financial_admin_commands','${column}','pale_orbit_financial_worker','UPDATE')`
    );
    expect(migration).toContain(
      'REVOKE UPDATE ("id") ON TABLE "public"."refund_allocation_drafts"'
    );
    expect(migration).toContain(
      'REVOKE UPDATE ("id") ON TABLE "public"."refund_allocation_draft_items"'
    );
    for (const tuple of [
      "('refund_allocation_drafts','state','pale_orbit_financial_worker','UPDATE')",
      "('refund_allocation_drafts','discarded_at','pale_orbit_financial_worker','UPDATE')",
      "('refund_allocation_draft_items','proposed_total_presentment_minor',",
      "('refund_allocation_finalization_effects','pale_orbit_financial_worker','INSERT')"
    ]) expect(postflight).toContain(tuple);
    for (const routine of [
      'plan6bii_assert_financial_admin_job_lease',
      'plan6bii_guard_financial_admin_job_lease',
      'plan6bii_guard_financial_admin_command_update',
      'plan6bii_guard_financial_admin_command_delete',
      'plan6bii_sync_failed_financial_admin_command',
      'plan6bii_guard_administrative_grant_transition'
    ]) expect(postflight).toContain(`'public.${routine}`);
  });

  it('pins the digest-only database-clock claim lifecycle and owner-private helpers', () => {
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const assertionStart = migration.indexOf(
      'CREATE FUNCTION "public"."plan6bii_assert_financial_admin_job_lease"(uuid)'
    );
    const guardStart = migration.indexOf(
      'CREATE FUNCTION "public"."plan6bii_guard_financial_admin_job_lease"()'
    );
    const assertion = migration.slice(assertionStart, guardStart);
    const guardEnd = migration.indexOf('$financial_admin_lease_guard$;--> statement-breakpoint');
    const guard = migration.slice(guardStart, guardEnd);

    expect(assertionStart).toBeGreaterThanOrEqual(0);
    expect(guardStart).toBeGreaterThan(assertionStart);
    for (const invariant of [
      'pale_orbit.plan6bii_financial_admin_job_capability',
      "'^[A-Za-z0-9_-]{43}$'", 'pg_catalog.sha256', 'pg_catalog.convert_to',
      'capability_sha256', 'generation', 'attempt', "state = 'active'",
      'expires_at > pg_catalog.clock_timestamp()', "ERRCODE = '55000'"
    ]) expect(assertion).toContain(invariant);
    for (const lifecycle of [
      'pale_orbit.plan6bii_financial_admin_job_lease_duration_ms',
      'pg_catalog.clock_timestamp()', 'lease_duration_ms',
      "state = 'invalidated'", 'invalidated_at', 'renewed_at',
      'pg_advisory_xact_lock', 'pg_advisory_xact_lock_shared',
      'OLD.rerun_requested_at IS NOT NULL', 'NEW.attempts = 1',
      'NEW.last_error IS NULL'
    ]) expect(guard).toContain(lifecycle);
    const initialClaim = guard.slice(
      guard.indexOf("IF OLD.status = 'pending' AND NEW.status = 'running'"),
      guard.indexOf("IF OLD.status = 'running' AND NEW.status = 'running'")
    );
    expect(initialClaim).toContain('NEW.attempts IS DISTINCT FROM OLD.attempts + 1');
    expect(initialClaim).not.toContain('NEW.attempts NOT IN (OLD.attempts + 1, 1)');
    expect(initialClaim.indexOf('pg_advisory_xact_lock(')).toBeLessThan(
      initialClaim.indexOf('FROM "public"."financial_admin_job_claims"')
    );
    expect(initialClaim.indexOf('FROM "public"."financial_admin_job_claims"')).toBeLessThan(
      initialClaim.indexOf('FROM "public"."financial_admin_commands"')
    );
    const runningClaim = guard.slice(
      guard.indexOf("IF OLD.status = 'running' AND NEW.status = 'running'"),
      guard.indexOf("IF OLD.status = 'running' AND NEW.status = 'pending'")
    );
    const heartbeat = runningClaim.slice(
      0,
      runningClaim.indexOf("IF supplied_duration_text !~")
    );
    expect(heartbeat).toContain('prior_claim.attempt IS DISTINCT FROM OLD.attempts');
    for (const leaseRotation of [initialClaim, heartbeat]) {
      expect(leaseRotation).toContain('lease_expires_at := lease_now +');
      expect(leaseRotation).toContain('NEW.run_at := lease_expires_at');
      expect(leaseRotation).toContain('NEW.locked_at := lease_now');
      expect(leaseRotation).toContain('NEW.updated_at := lease_now');
    }
    expect(runningClaim).toMatch(
      /OLD\.attempts < OLD\.max_attempts AND\s+NEW\.attempts = OLD\.attempts \+ 1/u
    );
    expect(runningClaim).toMatch(
      /OLD\.attempts = OLD\.max_attempts AND\s+NEW\.attempts = OLD\.attempts/u
    );
    const pendingTransition = guard.slice(
      guard.indexOf("IF OLD.status = 'running' AND NEW.status = 'pending'"),
      guard.indexOf("IF OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed')")
    );
    expect(pendingTransition).toContain("NEW.run_at > lease_now");
    expect(pendingTransition).toContain("interval '1 day'");
    expect(pendingTransition).toContain('NEW.run_at := lease_now');
    expect(pendingTransition).toContain('NEW.updated_at := lease_now');
    const terminalTransition = guard.slice(
      guard.indexOf("IF OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed')")
    );
    expect(terminalTransition).toContain('NEW.completed_at := lease_now');
    expect(terminalTransition).toContain('NEW.updated_at := lease_now');
    expect(runningClaim).toMatch(
      /OLD\.rerun_requested_at IS NOT NULL AND\s+OLD\.attempts BETWEEN 1 AND OLD\.max_attempts/u
    );
    expect(runningClaim.indexOf('pg_advisory_xact_lock_shared')).toBeLessThan(
      runningClaim.indexOf('FROM "public"."financial_admin_job_claims"')
    );
    const relinquish = guard.slice(
      guard.indexOf("IF OLD.status = 'running' AND NEW.status = 'pending'"),
      guard.indexOf("IF OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed')")
    );
    expect(relinquish).toContain(
      'OLD.rerun_requested_at IS NOT NULL AND NEW.attempts = 0'
    );
    expect(relinquish).toContain(
      'OLD.rerun_requested_at IS NULL AND NEW.attempts = OLD.attempts'
    );
    expect(migration).toMatch(
      /CREATE TRIGGER "jobs_plan6bii_financial_admin_lease_guard"[\s\S]+?BEFORE UPDATE ON "public"\."jobs"/u
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "public"."financial_admin_job_claims" FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup"'
    );
    for (const helper of [
      'plan6bii_assert_financial_admin_job_lease"(uuid)',
      'plan6bii_guard_financial_admin_job_lease"()'
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION "public"."${helper}`);
      expect(migration).not.toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION "public"\\."${helper.replace(/[()]/gu, '\\$&')}`,
        'u'
      ));
    }
  });

  it('makes every fixed financial read-audit argument predicate total', () => {
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const routines = [
      ['append_financial_issue_view_audit', '$financial_issue_view_audit$'],
      ['append_financial_refund_review_view_audit', '$financial_refund_review_view_audit$'],
      ['append_financial_payout_view_audit', '$financial_payout_view_audit$'],
      ['append_financial_sales_export_audit', '$financial_sales_export_audit$']
    ] as const;
    for (const [name, endMarker] of routines) {
      const start = migration.indexOf(`CREATE FUNCTION "public"."${name}"`);
      const routine = migration.slice(start, migration.indexOf(`${endMarker};`, start));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(routine).toContain('requested_correlation IS NULL');
      expect(routine).toContain('requested_method IS NULL');
      expect(routine).toContain('requested_route IS NULL');
      expect(routine).toContain("ERRCODE = '22023'");
    }
    const exportStart = migration.indexOf(
      'CREATE FUNCTION "public"."append_financial_sales_export_audit"'
    );
    const exportRoutine = migration.slice(
      exportStart, migration.indexOf('$financial_sales_export_audit$;', exportStart)
    );
    for (const required of [
      'filter_fingerprint IS NULL', 'row_count IS NULL', 'byte_count IS NULL',
      'currency_pair_count IS NULL'
    ]) expect(exportRoutine).toContain(required);
  });

  it('requires unspoofable nested-trigger and owner-routine provenance', () => {
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const commandGuard = migration.slice(
      migration.indexOf(
        'CREATE FUNCTION "public"."plan6bii_guard_financial_admin_command_update"()'
      ),
      migration.indexOf('$financial_admin_command_update_guard$;--> statement-breakpoint')
    );
    const grantGuard = migration.slice(
      migration.indexOf(
        'CREATE FUNCTION "public"."plan6bii_guard_administrative_grant_transition"()'
      ),
      migration.indexOf('$administrative_grant_guard$;--> statement-breakpoint')
    );
    const resolver = migration.slice(
      migration.indexOf(
        'CREATE FUNCTION "public"."resolve_financial_issue_after_admin_command"'
      ),
      migration.indexOf('$admin_financial_issue_resolution$;--> statement-breakpoint')
    );

    expect(commandGuard).toContain('pg_catalog.pg_trigger_depth() = 2');
    expect(commandGuard).toContain('FROM "public"."financial_admin_job_claims" claim');
    expect(commandGuard).toContain("claim.state = 'invalidated'");
    expect(commandGuard).toContain("persisted_job.status = 'running'");
    expect(commandGuard).toContain('persisted_job.locked_at IS NOT NULL');
    expect(commandGuard).toContain('persisted_job.locked_by IS NOT NULL');
    expect(grantGuard).toContain('SECURITY INVOKER');
    expect(grantGuard).not.toContain('PG_CONTEXT');
    expect(grantGuard).toContain(
      'transition_administrative_recovery_grant_after_admin_command(uuid)'
    );
    expect(grantGuard).toContain('command.private_input');
    expect(grantGuard).toContain("command.kind = 'administrative_recovery_activate'");
    expect(grantGuard).toContain("command.kind = 'administrative_recovery_deactivate'");
    expect(grantGuard).toContain('effect.refund_allocation_id =');
    expect(grantGuard).toContain("guarded_row.state IS DISTINCT FROM 'active'");
    expect(grantGuard).toContain("guarded_row.state IS DISTINCT FROM 'revoked'");

    expect(resolver).toContain('allowlisted_issue');
    expect(resolver).toContain('current_selected_set_lineage');
    expect(resolver).toContain('expectedActiveDraftVersion');
    expect(resolver).toContain("issue_row.safe_code IN (");
    expect(resolver).not.toContain('issue_satisfied');
    expect(resolver).not.toContain('current_financial_projection_heads');
    expect(resolver).not.toContain("'unsupported_category'");
    expect(resolver).not.toContain("issue_row.safe_code = 'unsupported_category' OR NOT");
  });

  it('pins command-bound administrative recovery and its exact authority envelope', () => {
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const transitionStart = migration.indexOf(
      'CREATE FUNCTION "public"."transition_administrative_recovery_grant_after_admin_command"'
    );
    const transitionEnd = migration.indexOf(
      '$administrative_recovery$;--> statement-breakpoint',
      transitionStart
    );
    const transition = migration.slice(transitionStart, transitionEnd);

    expect(transitionStart).toBeGreaterThanOrEqual(0);
    expect(transition).toContain("pg_has_role(\n    session_user, 'pale_orbit_financial_worker', 'MEMBER'");
    expect(transition).toContain("hashtext('pale-orbit:user-roles:admin')");
    expect(transition).toContain('FROM "public"."financial_admin_commands"');
    expect(transition).not.toContain('FROM "public"."jobs"');
    expect(transition).toContain('plan6bii_assert_financial_admin_job_lease');
    expect(transition).toContain('pg_advisory_xact_lock_shared');
    expect(transition).toContain('FROM "public"."refund_allocation_finalization_effects"');
    expect(transition).toContain('FROM "public"."refund_allocations"');
    expect(transition).toContain('FROM "public"."entitlement_grants"');
    expect(transition).toContain("effect_row.transition <> 'revoked_by_finalization'");
    for (const boundFact of [
      'expectedCorrectionSetId', 'expectedCorrectionVersion',
      'expectedSourceFingerprint', 'previewFingerprint',
      'finalizationEffectId', 'orderItemId', 'projection_implementation'
    ]) expect(transition).toContain(boundFact);
    expect(transition).toContain("'financial.recovery_grant.activated'");
    expect(transition).toContain("'financial.recovery_grant.deactivated'");
    expect(transition).toContain('pale_orbit.plan6bii_administrative_grant_command_id');

    expect(migration).toContain(
      'CREATE FUNCTION "public"."plan6bii_guard_administrative_grant_transition"()'
    );
    expect(migration).toMatch(
      /CREATE TRIGGER "entitlement_grants_plan6bii_administrative_guard"\s+BEFORE INSERT OR UPDATE OR DELETE ON "public"\."entitlement_grants"/u
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "public"."financial_admin_commands" FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup"'
    );
    expect(migration).toContain(
      'GRANT SELECT ON TABLE "public"."financial_admin_commands" TO "pale_orbit_financial_worker"'
    );
    expect(migration).toContain(
      'GRANT SELECT ("id", "deduplication_key") ON TABLE "public"."jobs" TO "pale_orbit_runtime"'
    );
    expect(migration).toMatch(
      /plan6bii_sync_failed_financial_admin_command[\s\S]+?OLD\.status <> 'running'[\s\S]+?OLD\.locked_at IS NULL[\s\S]+?OLD\.locked_by IS NULL/u
    );
  });

  it('pins the eligible-only administrative-recovery v1 preimage and canonical lock root', () => {
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const transitionStart = migration.indexOf(
      'CREATE FUNCTION "public"."transition_administrative_recovery_grant_after_admin_command"'
    );
    const transitionEnd = migration.indexOf(
      '$administrative_recovery$;--> statement-breakpoint',
      transitionStart
    );
    const transition = migration.slice(transitionStart, transitionEnd);

    expect(transition).not.toContain('PLAN6BII_PREVIEW_V1_PENDING');
    expect(transition).toContain("pale-orbit.admin-recovery-preview.v1\\n");
    for (const canonicalLine of [
      'refund_id=', 'payment_id=', 'order_id=', 'finalization_effect_id=',
      'recovery_reference_id=', 'finalization_draft_id=',
      'finalization_draft_version=', 'order_item_id=', 'title_id=',
      'purchase_grant_id=', 'allocation_total_minor=',
      'allocation_subtotal_minor=', 'allocation_tax_minor=',
      'item_subtotal_minor=', 'item_tax_minor=', 'item_total_minor=',
      'item_currency=', 'existing_recovery_grant_id=',
      'existing_recovery_grant_state=', 'existing_recovery_grant_state_changed_at=',
      'correction_set_id=', 'correction_version=', 'correction_kind=',
      'correction_base_set_id=', 'correction_predecessor_correction_set_id=',
      'correction_source_fingerprint_sha256=', 'projection_classifier_version=',
      'projection_allocation_algorithm_version=', 'source_balance_transaction_id=',
      'source_fingerprint_sha256=', 'projection_head_count=2',
      'projection_head=', 'projection_item_count=', 'projection_item=',
      'presentment_evidence_count=', 'presentment_evidence=',
      'cumulative_refund_subtotal_minor=', 'cumulative_refund_tax_minor=',
      'cumulative_refund_total_minor=', 'remaining_unrefunded_minor=',
      'effective_access_before=', 'effective_access_after=',
      'access_changed=', 'email_queued='
    ]) expect(transition).toContain(canonicalLine);
    expect(transition).toContain('pg_catalog.encode(');
    expect(transition).toContain('pg_catalog.sha256(');
    expect(transition).toContain("pg_catalog.convert_to(preview_preimage, 'UTF8')");
    expect(transition).not.toContain('pg_catalog.concat_ws');
    expect(transition).toContain("pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())");
    expect(transition).toContain("pg_catalog.to_char(");
    expect(transition).toContain(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
    expect(transition).toContain('projection_incomplete');
    expect(transition).toContain('allocation_status <> \'finalized\'');
    expect(transition).toContain('cumulative_refund_subtotal_minor');
    expect(transition).toContain('cumulative_refund_tax_minor');
    expect(transition).toContain('corrected_presentment_total < order_item_row.total_minor');

    const sharedLease = transition.indexOf('pg_advisory_xact_lock_shared');
    const commandLock = transition.indexOf('FOR UPDATE;', transition.indexOf(
      'FROM "public"."financial_admin_commands"'
    ));
    const projectionLock = transition.indexOf('FROM "public"."financial_projection_versions"');
    const orderAdvisory = transition.indexOf('pale-orbit:commerce:order:');
    const orderLock = transition.indexOf('FROM "public"."orders"');
    const paymentLock = transition.indexOf('FROM "public"."payments"');
    const effectLock = transition.indexOf(
      'FROM "public"."refund_allocation_finalization_effects"'
    );
    expect(sharedLease).toBeGreaterThanOrEqual(0);
    expect(commandLock).toBeGreaterThan(sharedLease);
    expect(projectionLock).toBeGreaterThan(commandLock);
    expect(orderAdvisory).toBeGreaterThan(projectionLock);
    expect(orderLock).toBeGreaterThan(orderAdvisory);
    expect(paymentLock).toBeGreaterThan(orderLock);
    expect(effectLock).toBeGreaterThan(paymentLock);
  });

  it('admits a canonical base-only evidence topology only for a non-target sibling refund', () => {
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const resolvedEvidenceStart = migration.indexOf(
      '), resolved_evidence AS MATERIALIZED ('
    );
    const resolvedEvidenceEnd = migration.indexOf(
      '), serialized_evidence AS (',
      resolvedEvidenceStart
    );
    const resolvedEvidence = migration.slice(
      resolvedEvidenceStart,
      resolvedEvidenceEnd
    );

    expect(resolvedEvidenceStart).toBeGreaterThanOrEqual(0);
    expect(resolvedEvidenceEnd).toBeGreaterThan(resolvedEvidenceStart);
    expect(resolvedEvidence.match(/evidence_context\.tip_count = 2/gu) ?? []).toHaveLength(1);
    expect(resolvedEvidence.match(/evidence_context\.tip_count = 0/gu) ?? []).toHaveLength(1);
    expect(resolvedEvidence).toMatch(
      /\(\s*\(\s*evidence_context\.tip_count = 2[\s\S]+?evidence_context\.source_fingerprint_sha256 =\s*\([\s\S]+?tip\.id = evidence_context\.correction_tip_id[\s\S]+?evidence_context\.refund_id <> input_refund_id OR\s*evidence_context\.correction_tip_id = input_correction_id\s*\)\s*\) OR \(\s*evidence_context\.refund_id <> input_refund_id AND\s*evidence_context\.tip_count = 0 AND\s*evidence_context\.distinct_tip_count = 0 AND\s*evidence_context\.correction_tip_id IS NULL AND\s*evidence_context\.correction_version IS NULL\s*\)\s*\)/u
    );
    expect(resolvedEvidence).toMatch(
      /NOT evidence_context\.uses_correction[\s\S]+?evidence_context\.base_allocation_id IS NULL[\s\S]+?evidence_context\.base_allocation_id IS NOT NULL/u
    );
  });

  it('fences every recovery fingerprint input in the shared financial lock order', () => {
    const migration = source(ADMIN_COMMAND_MIGRATION);
    const transitionStart = migration.indexOf(
      'CREATE FUNCTION "public"."transition_administrative_recovery_grant_after_admin_command"'
    );
    const transitionEnd = migration.indexOf(
      '$administrative_recovery$;--> statement-breakpoint',
      transitionStart
    );
    const transition = migration.slice(transitionStart, transitionEnd);
    const activation = transition.slice(
      transition.indexOf("IF locked_command_kind = 'administrative_recovery_activate' THEN"),
      transition.indexOf("IF NOT ((\n    pg_catalog.jsonb_typeof(command_input) = 'object'", transition.indexOf("IF locked_command_kind = 'administrative_recovery_activate' THEN"))
    );
    const deactivation = transition.slice(activation.length + transition.indexOf("IF locked_command_kind = 'administrative_recovery_activate' THEN"));

    expect(transition.indexOf("IF locked_command_kind = 'administrative_recovery_activate' THEN"))
      .toBeLessThan(transition.indexOf('FROM "public"."financial_projection_versions"'));

    for (const requiredProof of [
      'evidence_context.head_count = 2',
      'evidence_context.basis_count = 2',
      'evidence_context.balance_transaction_count = 1',
      'evidence_context.tip_count = 2',
      'evidence_context.distinct_tip_count = 1',
      'evidence_context.heads_complete',
      'active_balance_transaction_ids',
      'discovered_payout_generations',
      'financial_issue_lock_keys',
      'pale-orbit:financial:issue:',
      'allocation_order_item.order_id IS DISTINCT FROM order_row.id',
      'purchase_order_item_count',
      'purchase_order_item_total_minor',
      'candidate_entitlement_scopes'
    ]) expect(activation).toContain(requiredProof);

    expect(
      transition.match(/SELECT DISTINCT candidate\.user_id, candidate\.title_id/gu) ?? []
    ).toHaveLength(2);
    expect(
      transition.match(
        /SELECT scope\.user_id, scope\.title_id\s+FROM candidate_entitlement_scopes scope\s+ORDER BY scope\.user_id::text COLLATE "C", scope\.title_id::text COLLATE "C"/gu
      ) ?? []
    ).toHaveLength(2);
    expect(transition).not.toMatch(
      /SELECT DISTINCT scope\.user_id, scope\.title_id\s+FROM candidate_entitlement_scopes scope\s+ORDER BY/u
    );

    const payoutAdvisory = activation.indexOf('pale-orbit:financial:payout:');
    const payoutRows = activation.indexOf('FROM "public"."stripe_payouts"');
    const balanceAdvisory = activation.indexOf('pale-orbit:financial:balance-transaction:');
    const balanceRows = activation.indexOf('FROM "public"."stripe_balance_transactions"');
    const membershipRows = activation.indexOf(
      'FROM "public"."stripe_payout_balance_transactions" membership',
      balanceRows
    );
    const feeRows = activation.indexOf(
      'FROM "public"."stripe_balance_transaction_fee_details" detail'
    );
    const effectRevalidation = activation.lastIndexOf(
      'FROM "public"."refund_allocation_finalization_effects" effect'
    );
    const issueRows = activation.indexOf(
      'FROM "public"."financial_reconciliation_issues" issue'
    );
    expect(payoutRows).toBeGreaterThan(payoutAdvisory);
    expect(balanceAdvisory).toBeGreaterThan(payoutRows);
    expect(balanceRows).toBeGreaterThan(balanceAdvisory);
    expect(membershipRows).toBeGreaterThan(balanceRows);
    expect(feeRows).toBeGreaterThan(membershipRows);
    expect(activation).toContain('ORDER BY detail.balance_transaction_id, detail.ordinal');
    expect(effectRevalidation).toBeGreaterThan(issueRows);

    expect(deactivation).not.toContain('pale-orbit:financial:balance-transaction:');
    expect(deactivation).not.toContain('pale-orbit:financial:allocation:');
    expect(deactivation).not.toContain(
      'FROM "public"."financial_reconciliation_issues" issue'
    );
  });

  it('keeps provider, allocation, view, and row contracts in project-owned modules', () => {
    const provider = source('../src/lib/server/db/schema/financial-provider.ts');
    const allocation = source('../src/lib/server/db/schema/financial-allocation.ts');
    const schemaIndex = source('../src/lib/server/db/schema/index.ts');

    for (const tableName of PROVIDER_TABLES) {
      expect(provider).toMatch(new RegExp(`pgTable\\(\\s*'${tableName}'`, 'u'));
    }
    for (const tableName of ALLOCATION_TABLES) {
      expect(allocation).toMatch(new RegExp(`pgTable\\(\\s*'${tableName}'`, 'u'));
    }
    expect(allocation).toMatch(/pgView\(\s*'current_financial_projection_heads'/u);
    expect(allocation).toMatch(/pgView\(\s*'current_financial_projection_items'/u);
    for (const alias of ROW_ALIASES) {
      expect(`${provider}\n${allocation}`).toContain(`export type ${alias} =`);
      expect(`${provider}\n${allocation}`).toContain(`export type New${alias} =`);
    }
    expect(schemaIndex).toContain("export * from './financial-provider';");
    expect(schemaIndex).toContain("export * from './financial-allocation';");
  });

  it('keeps generated SQL complete and structurally free of sensitive provider data', () => {
    const provider = source('../src/lib/server/db/schema/financial-provider.ts');
    const allocation = source('../src/lib/server/db/schema/financial-allocation.ts');
    const migration = source('../drizzle/0007_plan6b_financial_reconciliation.sql');
    const snapshot = source('../drizzle/meta/0007_snapshot.json');
    const combined = `${provider}\n${allocation}\n${migration}\n${snapshot}`;

    for (const tableName of [...PROVIDER_TABLES, ...ALLOCATION_TABLES]) {
      expect(migration).toContain(`"${tableName}"`);
    }
    expect(migration).toContain('current_financial_projection_heads');
    expect(migration).toContain('current_financial_projection_items');
    const projectionHeads = renderedProjectionHeads();
    const snapshotJson = JSON.parse(snapshot) as {
      views: Record<string, { definition: string }>;
    };
    expect(
      snapshotJson.views['public.current_financial_projection_heads']?.definition.replaceAll(
        '\r\n',
        '\n'
      )
    ).toBe(projectionHeads);
    expect(migration.replaceAll('\r\n', '\n')).toContain(
      `CREATE VIEW "public"."current_financial_projection_heads" AS (${projectionHeads}\n);`
    );
    const projectionItems = renderedProjectionItems();
    expect(
      snapshotJson.views['public.current_financial_projection_items']?.definition.replaceAll(
        '\r\n',
        '\n'
      )
    ).toBe(projectionItems);
    expect(migration.replaceAll('\r\n', '\n')).toContain(
      `CREATE VIEW "public"."current_financial_projection_items" AS (${projectionItems}\n);`
    );
    for (const generatedContract of [migration, snapshot]) {
      expect(generatedContract).toContain('financial_projection_versions');
      expect(generatedContract).toMatch(
        /classifier_version\s*=\s*active_projection_version\.classifier_version/iu
      );
      expect(generatedContract).toMatch(
        /algorithm_version\s*=\s*active_projection_version\.allocation_algorithm_version/iu
      );
      expect(generatedContract).toContain('current_parent_classification_candidates');
      expect(generatedContract).toContain('current_fee_detail_classification_candidates');
      expect(generatedContract).toContain('current_fee_classification_candidates');
      expect(generatedContract).not.toMatch(/classifier_version\s*=\s*1/iu);
      expect(generatedContract).not.toMatch(/algorithm_version\s*=\s*1/iu);
      expect(generatedContract).toContain('correction_rebase_required');
      expect(generatedContract).toContain("resource_type = 'balance_transaction'");
      expect(generatedContract).toMatch(
        /group\s+by\s+(?:"?detail"?\.)?"?balance_transaction_id"?,\s*(?:"?detail"?\.)?"?id"?/iu
      );
      expect(generatedContract).toContain('fee_detail_amount_sum');
      expect(generatedContract).toContain('invalid_delta_group_count');
      expect(generatedContract).toContain('invalid_settlement_arithmetic_count');
      expect(generatedContract).toContain('invalid_presentment_arithmetic_count');
      expect(generatedContract).toContain('presentment_capacity_status');
      expect(generatedContract).toMatch(/base_item_count\s*=\s*0\s+and\s+expected_effect_minor\s*<>\s*0/iu);
    }
    for (const generatedContract of [allocation, migration, snapshot]) {
      expect(generatedContract).toContain('financial_allocation_sets_reversal_root_unique');
      expect(generatedContract).toMatch(
        /reversal_of_set_id[\s\S]+?supersedes_set_id[\s\S]+?is\s+null/iu
      );
    }

    const forbiddenColumnDeclarations = [
      /(?:varchar|text|jsonb)\(['"]raw_(?:payload|response)['"]/u,
      /(?:varchar|text|jsonb)\(['"]provider_(?:payload|message)['"]/u,
      /(?:varchar|text|jsonb)\(['"](?:description|destination|statement_descriptor|metadata)['"]/u,
      /(?:varchar|text|jsonb)\(['"](?:customer|billing|card|payment_method)['"]/u,
      /(?:varchar|text|jsonb)\(['"](?:receipt_url|action_url|client_secret|secret_key|webhook_secret)['"]/u,
      /"(?:raw_payload|raw_response|provider_payload|provider_message|destination|statement_descriptor|metadata|customer|billing_address|card_number|receipt_url|action_url|client_secret|secret_key|webhook_secret)"\s/u
    ];
    for (const forbidden of forbiddenColumnDeclarations) {
      expect(combined).not.toMatch(forbidden);
    }
  });

  it('keeps the 0006-to-0007 backfill fact-derived and transactionally defensive', () => {
    const migration = source('../drizzle/0007_plan6b_financial_reconciliation.sql');

    expect(migration).toMatch(/\bcase\b[\s\S]+?"reconciliation_status"/iu);
    expect(migration).toMatch(
      /update\s+"payments"[\s\S]+?"financial_evidence_status"/iu
    );
    expect(migration).toMatch(
      /update\s+"refunds"[\s\S]+?"allocation_status"[\s\S]+?"financial_evidence_status"/iu
    );
    expect(migration).toMatch(
      /update\s+"disputes"[\s\S]+?"financial_evidence_status"/iu
    );
    expect(migration).toMatch(
      /insert\s+into\s+"refund_allocation_components"[\s\S]+?"subtotal_minor"[\s\S]+?"tax_minor"/iu
    );
    expect(migration).toMatch(
      /insert\s+into\s+"financial_reconciliation_issues"[\s\S]+?allocation_incomplete/iu
    );
    expect(migration).toMatch(
      /raise\s+exception[\s\S]+?(?:over[-_ ]allocation|capacity)/iu
    );
    expect(migration).toMatch(
      /raise\s+exception[\s\S]+?(?:currency|cross[-_ ]currency)/iu
    );
    expect(migration).toMatch(
      /raise\s+exception[\s\S]+?(?:partial|incomplete)[-_ ](?:allocation|facts?)/iu
    );

    expect(migration).not.toMatch(
      /"reconciliation_status"\s*::\s*(?:text\s*::\s*)?"?financial_evidence_status"?/iu
    );
    expect(migration).not.toMatch(
      /when\s+['"]?reconciled['"]?\s+then\s+['"]?fee_reconciled['"]?/iu
    );

    for (const tableName of ['payments', 'refunds', 'disputes'] as const) {
      const backfillPosition = migration.search(
        new RegExp(`update\\s+"${tableName}"`, 'iu')
      );
      const dropPosition = migration.search(
        new RegExp(
          `alter\\s+table\\s+"${tableName}"\\s+drop\\s+column\\s+"reconciliation_status"`,
          'iu'
        )
      );
      expect(backfillPosition).toBeGreaterThanOrEqual(0);
      expect(dropPosition).toBeGreaterThan(backfillPosition);
    }
  });

  it('keeps every durable financial-history guard attached in migration 0007', () => {
    const migration = source('../drizzle/0007_plan6b_financial_reconciliation.sql');
    const schema = source('../src/lib/server/db/schema/financial-allocation.ts');
    const snapshot = source('../drizzle/meta/0007_snapshot.json');

    expect(migration).toMatch(/create\s+(?:or\s+replace\s+)?function/iu);
    expect(migration).toMatch(/raise\s+exception[\s\S]+?errcode\s*=\s*'55000'/iu);

    for (const tableName of [...IMMUTABLE_GUARD_TABLES, ...NARROW_UPDATE_GUARD_TABLES]) {
      expect(migration, `${tableName} must have an UPDATE/DELETE guard`).toMatch(
        triggerAttachment(tableName)
      );
    }

    expect(migration).toMatch(/pending[\s\S]+?available/iu);
    expect(migration).toMatch(/last_imported_at/iu);
    expect(migration).toMatch(/financial_generation/iu);
    expect(migration).toMatch(/state[\s\S]+?active[\s\S]+?finalized/iu);
    expect(migration).toMatch(/occurrence_count/iu);
    expect(migration).toMatch(/resolved_at/iu);
    expect(migration).toContain('CREATE FUNCTION "public"."resolve_financial_reconciliation_issue"');
    const resolver = migration.slice(
      migration.indexOf('CREATE FUNCTION "public"."resolve_financial_reconciliation_issue"'),
      migration.indexOf('CREATE FUNCTION "public"."plan6b_validate_issue_transition"')
    );
    expect(resolver).toMatch(
      /p_issue_id uuid,\s+p_resolved_by_admin_id uuid,\s+p_actor_type "public"\."audit_actor_type",\s+p_actor_id text,\s+p_correlation_id text/iu
    );
    expect(resolver).toContain('FROM "public"."financial_reconciliation_issues" issue');
    expect(resolver).toContain('FROM "public"."user_roles" resolver_role');
    expect(resolver).toContain("resolver_role.role = 'admin'");
    expect(resolver).toContain('UPDATE "public"."financial_reconciliation_issues"');
    expect(resolver).toContain('INSERT INTO "public"."audit_events"');
    expect(resolver).toContain("char_length(p_actor_id) NOT BETWEEN 1 AND 100");
    expect(resolver).toContain("char_length(p_correlation_id) NOT BETWEEN 1 AND 100");
    expect(resolver.indexOf("immutable classification diagnostics cannot be resolved"))
      .toBeLessThan(resolver.indexOf("set_config('pale_orbit.financial_issue_resolution'"));
    expect(resolver.indexOf('UPDATE "public"."financial_reconciliation_issues"'))
      .toBeLessThan(resolver.indexOf('INSERT INTO "public"."audit_events"'));
    expect(resolver).toContain("'financial.issue.resolved'");
    expect(resolver).toContain("'financial_issue'");
    expect(resolver).toContain("set_config('pale_orbit.financial_issue_resolution', p_issue_id::text, true)");
    expect(migration).toContain("current_setting('pale_orbit.financial_issue_resolution', true) IS DISTINCT FROM OLD.id::text");
    expect(migration).toContain('GET DIAGNOSTICS call_context = PG_CONTEXT');
    expect(migration).toContain(
      "call_context !~ E'(^|\\\\n)PL/pgSQL function resolve_financial_reconciliation_issue\\\\(uuid,uuid,audit_actor_type,text,text\\\\) line [0-9]+ at SQL statement($|\\\\n)'"
    );
    expect(migration).toContain('CREATE FUNCTION "public"."plan6b_validate_issue_insert"');
    expect(migration).toMatch(
      /CREATE TRIGGER "financial_reconciliation_issues_validate_insert" BEFORE INSERT ON "financial_reconciliation_issues"/u
    );
    expect(migration).toContain('financial_reconciliation_issues_immutable_classification_open');
    expect(schema).toMatch(
      /table\.resourceType[^\n]+financial_classification[^\n]+table\.safeCode[^\n]+unsupported_category[^\n]+table\.state[^\n]+open/u
    );
    expect(snapshot).toMatch(
      /resource_type[^\n]+financial_classification[^\n]+safe_code[^\n]+unsupported_category[^\n]+state[^\n]+open/iu
    );
  });

  it('ships a fail-closed worker-only issue-resolution authority boundary after migration 0007', () => {
    const lockdown = source('../drizzle/0008_plan6b_worker_issue_resolution.sql');
    const migration = source('../drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql');

    expect(lockdown).toContain('pg_catalog.to_regprocedure(');
    expect(lockdown).toContain(
      'public.resolve_financial_reconciliation_issue(uuid,uuid,public.audit_actor_type,text,text)'
    );
    expect(lockdown).toContain("function_row.prokind = 'f'");
    expect(lockdown).not.toContain('pronargs');
    expect(lockdown).toContain("'DROP FUNCTION %s'");
    expect(lockdown).not.toContain('resolve_financial_issue_after_worker_recompute');
    expect(migration).toContain('CREATE ROLE "pale_orbit_runtime" NOLOGIN');
    expect(migration).toContain('CREATE ROLE "pale_orbit_financial_worker" NOLOGIN');
    expect(migration).toContain(
      'ALTER ROLE "pale_orbit_runtime" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
    );
    expect(migration).toContain(
      'ALTER ROLE "pale_orbit_financial_worker" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
    );
    expect(migration).toContain('FROM pg_catalog.pg_auth_members membership');
    expect(migration).toContain('pg_catalog.aclexplode');
    expect(migration).toContain('pg_catalog.pg_parameter_acl');
    expect(migration).toContain('pg_catalog.pg_default_acl');
    expect(migration).toContain('pg_catalog.pg_db_role_setting');
    expect(migration).toContain('pg_catalog.pg_shdepend');
    expect(migration).toContain('WITH ADMIN FALSE, INHERIT TRUE, SET FALSE');
    expect(migration).toContain('unsafe pre-existing Plan 6B database authority roles');
    expect(migration).toContain('financial_reconciliation_issues_semantic_identity');
    expect(migration).toContain('invalid legacy financial issue resource/code identity');
    expect(migration).toContain('financial_reconciliation_issues_semantic_impact');
    expect(migration).toContain('invalid legacy financial issue impact');
    expect(migration).toContain('invalid legacy financial issue resource identity');
    expect(migration).toContain('missing legacy unknown classification issue');
    expect(migration).toContain('invalid legacy financial issue resolution audit provenance');
    expect(migration).toContain("audit.actor_id = 'commerce-worker'");
    expect(migration).toMatch(
      /resource_type = 'dispute'[\s\S]*resource_type = 'allocation_set'[\s\S]*'allocation_mismatch'[\s\S]*'unsupported_category'/u
    );
    expect(migration).toMatch(
      /resource_type in \('payment', 'refund', 'dispute', 'allocation_set'\)[\s\S]*safe_code in \([\s\S]*'allocation_fork'[\s\S]*'unsupported_category'[\s\S]*resource_type = 'payout'[\s\S]*'payout_membership_conflict'[\s\S]*resource_type = 'balance_transaction'[\s\S]*'classification_fork'[\s\S]*resource_type = 'financial_classification'[\s\S]*safe_code = 'unsupported_category'/u
    );
    expect(migration).toMatch(
      /safe_code in \('allocation_incomplete', 'missing_source'\)[\s\S]*impact = 'pending'[\s\S]*impact = 'exception'/u
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION "public"."plan6b_validate_issue_insert"'
    );
    expect(migration).toContain('FOR KEY SHARE');
    expect(migration).toContain(
      'CREATE FUNCTION "public"."plan6b_validate_unknown_classification_issue"'
    );
    expect(migration).toContain('financial_classification_versions_unknown_issue_required');
    expect(migration).toContain(
      'CREATE FUNCTION "public"."plan6b_guard_financial_issue_subject_mutation"'
    );
    for (const trigger of [
      'payments_financial_issue_subject_guard',
      'refunds_financial_issue_subject_guard',
      'disputes_financial_issue_subject_guard'
    ]) expect(migration).toContain(trigger);
    expect(migration).toContain('REVOKE ALL ON SCHEMA "public" FROM PUBLIC');
    expect(migration).toContain(
      'CREATE FUNCTION "public"."resolve_financial_issue_after_worker_recompute"'
    );
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("SET search_path = 'pg_catalog'");
    expect(migration).toContain("'system'::\"public\".\"audit_actor_type\"");
    expect(migration).toContain("'financial-worker'");
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION "public"."resolve_financial_issue_after_worker_recompute"(uuid,text) FROM PUBLIC'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION "public"."resolve_financial_issue_after_worker_recompute"(uuid,text) TO "pale_orbit_financial_worker"'
    );
    expect(migration).toContain('current_user IS DISTINCT FROM');
    expect(migration).toContain(
      "'public.resolve_financial_issue_after_worker_recompute(uuid,text)'::pg_catalog.regprocedure"
    );
    expect(migration).not.toContain('PG_CONTEXT');
    expect(migration).not.toContain('p_actor_type');
    expect(migration).not.toContain('p_actor_id');
    expect(migration).not.toContain('p_resolved_by_admin_id');
  });

  it('locks and rejects contradictory legacy payout membership and source-principal evidence before 0009', () => {
    const migration = source('../drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql');
    const lockStatement = migration.match(/(?:^|\r?\n)LOCK TABLE[\s\S]*?IN SHARE ROW EXCLUSIVE MODE;/u)?.[0];
    const principalPreflight = migration.match(
      /IF EXISTS \([\s\S]*?invalid legacy fee-reconciled source principal parity[\s\S]*?END IF;/u
    )?.[0];

    expect(lockStatement).toBeDefined();
    expect(lockStatement).toContain('"stripe_payout_balance_transactions"');
    expect(migration).toContain('invalid legacy payout membership currency');
    expect(migration).toMatch(
      /stripe_payout_balance_transactions[\s\S]*?stripe_payouts[\s\S]*?stripe_balance_transactions[\s\S]*?balance\.currency is distinct from payout\.currency/iu
    );
    expect(principalPreflight).toBeDefined();
    expect(principalPreflight).toContain('first_dispute_withdrawal_balance');
    expect(principalPreflight).toMatch(
      /balance\.source_family = 'charge'[\s\S]*?balance\.source_id = payment\.stripe_latest_charge_id[\s\S]*?balance\.reporting_category = 'charge'[\s\S]*?payment\.financial_evidence_status = 'fee_reconciled'[\s\S]*?balance\.currency = payment\.currency[\s\S]*?balance\.amount_minor <> payment\.amount_minor/u
    );
    expect(principalPreflight).toMatch(
      /balance\.source_family = 'refund'[\s\S]*?balance\.source_id = refund\.stripe_refund_id[\s\S]*?balance\.reporting_category = 'refund'[\s\S]*?refund\.financial_evidence_status = 'fee_reconciled'[\s\S]*?balance\.currency = refund\.currency[\s\S]*?balance\.amount_minor <> -refund\.amount_minor/u
    );
    expect(principalPreflight).toMatch(
      /first_dispute_withdrawal_balance[\s\S]*?reporting_category = 'dispute'[\s\S]*?provider_created_at[\s\S]*?provider_id collate "C"[\s\S]*?classification = 'dispute_withdrawal'[\s\S]*?sum\(presentment\.total_effect_minor\)[\s\S]*?<>\s*-first_withdrawal\.amount_minor/iu
    );
    expect(principalPreflight).not.toMatch(
      /reporting_category = 'dispute_reversal'[\s\S]*?amount_minor <> -dispute\.amount_minor/u
    );
    expect(principalPreflight).not.toMatch(
      /reporting_category = 'fee'[\s\S]*?amount_minor <> -dispute\.amount_minor/u
    );
  });

  it('binds every dispute presentment row to its exact dispute gross allocation set', () => {
    const migration = source('../drizzle/0007_plan6b_financial_reconciliation.sql');

    expect(migration).toContain('financial_allocation_sets_source_identity_unique');
    expect(migration).toContain('dispute_item_allocations_gross_set_graph_fk');
    expect(migration).toContain('CREATE FUNCTION "public"."plan6b_validate_dispute_gross_allocation_set"');
    expect(migration).toMatch(
      /source_kind[\s\S]+?=\s*'dispute'[\s\S]+?basis[\s\S]+?=\s*'gross_amount'/iu
    );
    expect(migration).toMatch(
      /create\s+trigger\s+"dispute_item_allocations_validate_gross_set"\s+before\s+insert\s+on\s+"dispute_item_allocations"/iu
    );
  });

  it('resets and reseeds the singleton active projection pair in integration cleanup', () => {
    const setup = source('../tests/integration/setup.ts');

    expect(setup).toMatch(/truncate table[\s\S]+?financial_projection_versions/iu);
    expect(setup).toMatch(
      /insert\s+into\s+financial_projection_versions[\s\S]+?values\s*\(true,\s*1,\s*1,/iu
    );
  });
});
