import {
  ConfigurationError,
  readRequiredSetting,
  type EnvironmentValues,
  type SecretFileReader
} from '$lib/server/config/read-setting';

const ROLE_NAME = /^[a-z][a-z0-9_]{0,62}$/u;
const STORAGE_CLEANUP_GROUP = 'pale_orbit_storage_cleanup';
const STORAGE_CLEANUP_FUNCTION = 'public.storage_cleanup_referenced_keys(text[])';
const RESERVED_ROLES = new Set([
  'pale_orbit_runtime',
  'pale_orbit_financial_worker',
  STORAGE_CLEANUP_GROUP
]);

const FINANCIAL_WORKER_WRITE_TABLES = [
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
  'stripe_payouts',
  'payments',
  'refunds',
  'refund_allocations',
  'disputes'
] as const;

const FINANCIAL_WORKER_INSERT_TABLES = [
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
  'financial_scan_runs',
  'payout_import_run_entries',
  'payout_import_runs',
  'stripe_balance_transaction_fee_details',
  'stripe_balance_transactions',
  'stripe_payout_balance_transactions',
  'stripe_payouts',
  'payments',
  'refunds',
  'refund_allocations',
  'disputes'
] as const;

const FINANCIAL_WORKER_UPDATE_TABLES = [
  'financial_reconciliation_issues',
  'financial_projection_versions',
  'financial_payout_discovery_state',
  'financial_scan_runs',
  'payout_import_runs',
  'stripe_balance_transactions',
  'stripe_payouts',
  'payments',
  'refunds',
  'disputes',
  'stripe_events'
] as const;

const STRIPE_EVENT_WEB_INSERT_COLUMNS = [
  'provider_event_id',
  'event_type',
  'object_id',
  'live_mode',
  'api_version',
  'provider_created_at',
  'raw_body_sha256'
] as const;

const WORKER_DERIVED_CATALOG_TABLES = [
  'prose_sections',
  'prose_images',
  'prose_blocks',
  'comic_pages',
  'revision_cover_suggestions',
  'revision_ingestion_warnings'
] as const;

const PROTECTED_RUNTIME_WRITE_TABLES = [
  ...FINANCIAL_WORKER_WRITE_TABLES,
  'stripe_events',
  'current_financial_projection_heads',
  'current_financial_projection_items',
  'orders',
  'order_items',
  'jobs',
  'outbox_messages',
  'title_revisions',
  'guest_identities',
  'entitlement_grants',
  'entitlements',
  'commerce_claim_issuances',
  'financial_admin_commands',
  'financial_admin_job_claims',
  'operations_job_retry_commands',
  'operations_job_retry_claims',
  ...WORKER_DERIVED_CATALOG_TABLES
] as const;

const WORKER_INSERT_TABLES = [
  ...FINANCIAL_WORKER_INSERT_TABLES,
  'entitlement_grants',
  'entitlements',
  ...WORKER_DERIVED_CATALOG_TABLES
] as const;

const WORKER_UPDATE_TABLES = [
  ...FINANCIAL_WORKER_UPDATE_TABLES,
  'orders',
  'order_items',
  'jobs',
  'title_revisions',
  'entitlement_grants',
  'entitlements'
] as const;

const WORKER_DELETE_TABLES = [...WORKER_DERIVED_CATALOG_TABLES] as const;

const RUNTIME_COLUMN_PRIVILEGES = [
  ...STRIPE_EVENT_WEB_INSERT_COLUMNS.map((column) =>
    `stripe_events:INSERT:${column}` as const
  ),
  'orders:INSERT:initiating_user_id',
  'orders:INSERT:purchase_email',
  'orders:INSERT:currency',
  'orders:INSERT:subtotal_minor',
  'orders:INSERT:client_checkout_attempt_id',
  'orders:INSERT:quote_fingerprint_sha256',
  'orders:INSERT:status_token_sha256',
  'orders:UPDATE:status',
  'orders:UPDATE:stripe_checkout_session_id',
  'orders:UPDATE:checkout_expires_at',
  'orders:UPDATE:updated_at',
  'order_items:INSERT:order_id',
  'order_items:INSERT:title_id',
  'order_items:INSERT:title_snapshot',
  'order_items:INSERT:creator_name_snapshot',
  'order_items:INSERT:format',
  'order_items:INSERT:currency',
  'order_items:INSERT:unit_subtotal_minor',
  'jobs:INSERT:type',
  'jobs:INSERT:payload',
  'jobs:INSERT:deduplication_key',
  'jobs:INSERT:run_at',
  'jobs:INSERT:max_attempts',
  'jobs:SELECT:id',
  'jobs:SELECT:deduplication_key',
  'guest_identities:INSERT:email',
  'guest_identities:UPDATE:updated_at',
  'outbox_messages:INSERT:id',
  'outbox_messages:INSERT:topic',
  'outbox_messages:INSERT:payload',
  'outbox_messages:INSERT:deduplication_key',
  'outbox_messages:INSERT:dispatch_job_id',
  'outbox_messages:SELECT:id',
  'outbox_messages:SELECT:topic',
  'outbox_messages:SELECT:deduplication_key',
  'outbox_messages:SELECT:dispatch_job_id',
  'outbox_messages:SELECT:status',
  'outbox_messages:SELECT:last_error',
  'outbox_messages:SELECT:delivered_at',
  'outbox_messages:SELECT:created_at',
  'outbox_messages:SELECT:updated_at',
  'title_revisions:INSERT:title_id',
  'title_revisions:INSERT:parent_revision_id',
  'title_revisions:INSERT:created_by_actor_id',
  'title_revisions:INSERT:change_summary',
  'title_revisions:INSERT:staging_storage_key',
  'title_revisions:INSERT:staging_checksum_sha256',
  'title_revisions:INSERT:staging_byte_size',
  'title_revisions:INSERT:upload_filename',
  'title_revisions:INSERT:upload_mime_type',
  'title_revisions:UPDATE:state',
  'title_revisions:UPDATE:staging_storage_key',
  'title_revisions:UPDATE:ingestion_generation',
  'title_revisions:UPDATE:processing_started_at',
  'title_revisions:UPDATE:processed_at',
  'title_revisions:UPDATE:failure_code',
  'title_revisions:UPDATE:failure_details',
  'title_revisions:UPDATE:activated_at',
  'title_revisions:UPDATE:retired_at'
] as const;

const WORKER_COLUMN_PRIVILEGES = [
  'outbox_messages:UPDATE:status',
  'outbox_messages:UPDATE:last_error',
  'outbox_messages:UPDATE:delivered_at',
  'outbox_messages:UPDATE:updated_at',
  'financial_admin_commands:UPDATE:status',
  'financial_admin_commands:UPDATE:safe_result_code',
  'financial_admin_commands:UPDATE:safe_result',
  'financial_admin_commands:UPDATE:updated_at',
  'financial_admin_commands:UPDATE:completed_at',
  'refund_allocation_drafts:UPDATE:state',
  'refund_allocation_drafts:UPDATE:version',
  'refund_allocation_drafts:UPDATE:updated_by_admin_id',
  'refund_allocation_drafts:UPDATE:updated_correlation_id',
  'refund_allocation_drafts:UPDATE:updated_at',
  'refund_allocation_drafts:UPDATE:finalized_at',
  'refund_allocation_drafts:UPDATE:discarded_at',
  'refund_allocation_draft_items:UPDATE:proposed_total_presentment_minor',
  'refund_allocation_draft_items:UPDATE:updated_at',
  'refund_allocations:UPDATE:id',
  'refund_allocation_components:UPDATE:id',
  'refund_reporting_correction_sets:UPDATE:id',
  'refund_reporting_correction_items:UPDATE:id',
  'dispute_item_allocations:UPDATE:id',
  'stripe_payout_balance_transactions:UPDATE:id',
  'stripe_balance_transaction_fee_details:UPDATE:id',
  'financial_classification_versions:UPDATE:id',
  'financial_allocation_sets:UPDATE:id',
  'financial_item_allocations:UPDATE:id',
  'payout_import_run_entries:UPDATE:id'
] as const;

const RUNTIME_EXECUTE_FUNCTIONS = [
  'public.rearm_pending_stripe_event_job(uuid)',
  'public.authorize_commerce_claim_issuance(text,text)',
  'public.claim_guest_purchases_after_authorization(text,text)',
  'public.outbox_message_exists_by_deduplication_key(text)',
  'public.outbox_message_deduplication_metadata(text,text,jsonb)',
  'public.submit_financial_admin_command(uuid,text,text,text,text,jsonb)',
  'public.financial_admin_command_status(uuid,uuid)',
  'public.append_financial_issue_view_audit(uuid,uuid,text,text,text)',
  'public.append_financial_refund_review_view_audit(uuid,uuid,text,text,text)',
  'public.append_financial_payout_view_audit(uuid,uuid,text,text,text)',
  'public.append_financial_sales_export_audit(uuid,text,text,integer,integer,integer,text,text)',
  'public.list_operational_jobs(uuid,text,text,timestamp with time zone,uuid,integer)',
  'public.submit_job_retry_command(uuid,uuid,text,integer,integer,timestamp with time zone,text,text,text,text)',
  'public.get_owned_job_retry_command(uuid,uuid)'
] as const;

const WORKER_EXECUTE_FUNCTIONS = [
  'public.resolve_financial_issue_after_worker_recompute(uuid,text)',
  'public.register_commerce_claim_issuance(text,text,text,uuid,text,timestamp with time zone)',
  'public.purge_commerce_claim_issuances()',
  'public.resolve_financial_issue_after_admin_command(uuid,uuid)',
  'public.resolve_financial_issue_after_reporting_correction_command(uuid,uuid)',
  'public.transition_administrative_recovery_grant_after_admin_command(uuid)',
  'public.plan7a_operations_claim_job(uuid,text,integer)',
  'public.plan7a_operations_renew_job_claim(uuid,text,integer,integer)',
  'public.plan7a_operations_relinquish_job(uuid,text,integer,integer,text,integer)',
  'public.plan7a_operations_complete_job(uuid,text,integer,integer)',
  'public.plan7a_operations_fail_job(uuid,text,integer,integer,text)',
  'public.plan7a_operations_exhaust_job(uuid,text,integer,integer)',
  'public.plan7a_operations_lock_job_retry_command(uuid,uuid,text,integer,integer)',
  'public.plan7a_operations_transition_job_retry_command(uuid,uuid,text,integer,integer,operations_job_retry_result_code)'
] as const;

const WORKER_USAGE_TYPES = [
  'public.operations_job_retry_result_code'
] as const;

const PROTECTED_OPERATIONS_TYPES = [
  'public.operations_job_retry_command_status',
  'public.operations_job_retry_result_code',
  'public.operations_job_retry_reason_code',
  'public.operations_job_retry_claim_state'
] as const;

const PROTECTED_OPERATIONS_GUCS = [
  'pale_orbit.plan7a_operations_command_insert_id',
  'pale_orbit.plan7a_operations_command_transition_id',
  'pale_orbit.plan7a_operations_job_transition_id',
  'pale_orbit.plan7a_operations_job_capability'
] as const;

const WORKER_SELECT_TABLES = [
  'outbox_messages', 'financial_admin_commands', 'jobs'
] as const;

const RUNTIME_TABLE_SELECT_EXCLUSIONS = [
  'commerce_claim_issuances',
  'outbox_messages',
  'financial_admin_commands',
  'financial_admin_job_claims',
  'operations_job_retry_commands',
  'operations_job_retry_claims',
  'jobs'
] as const;

const PUBLIC_SENSITIVE_SELECT_COLUMNS = [
  'outbox_messages:payload',
  'commerce_claim_issuances:*',
  'financial_admin_commands:*',
  'financial_admin_job_claims:*',
  'operations_job_retry_commands:*',
  'operations_job_retry_claims:*',
  'jobs:*'
] as const;

export type DatabaseRuntimeRole = 'owner' | 'worker' | 'storage-cleanup';

export interface DatabaseMigrationIdentityConfig {
  readonly webUser: string;
  readonly workerUser: string;
  readonly storageCleanupUser: string;
}

export interface DatabaseRoleProvisionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly ownerUser: string;
  readonly ownerPassword: string;
  readonly webUser: string;
  readonly webPassword: string;
  readonly workerUser: string;
  readonly workerPassword: string;
  readonly storageCleanupUser: string;
  readonly storageCleanupPassword: string;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface DatabaseRoleProvisionClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

function invalid(detail: string): never {
  throw new ConfigurationError(`database role provision ${detail}`);
}

function boundedText(value: string, name: string, maximum = 255): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) invalid(`${name} is invalid`);
  return normalized;
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/u.test(value)) invalid(`${name} is invalid`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < minimum || parsed > maximum) invalid(`${name} is invalid`);
  return parsed;
}

function roleName(value: string, name: string): string {
  if (!ROLE_NAME.test(value) || value.startsWith('pg_') || RESERVED_ROLES.has(value)) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function invalidMigrationIdentity(): never {
  throw new ConfigurationError('database migration login identity configuration is invalid');
}

export function loadDatabaseMigrationIdentityConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): DatabaseMigrationIdentityConfig {
  if (source.PGOPTIONS !== undefined && source.PGOPTIONS.length > 0) {
    invalidMigrationIdentity();
  }
  for (const fileName of [
    'DATABASE_MIGRATION_WEB_USER_FILE',
    'DATABASE_MIGRATION_WORKER_USER_FILE',
    'DATABASE_MIGRATION_STORAGE_CLEANUP_USER_FILE'
  ]) {
    if (source[fileName] !== undefined) invalidMigrationIdentity();
  }

  let ownerUser: string;
  try {
    ownerUser = boundedText(
      readRequiredSetting(source, 'DATABASE_OWNER_USER', readSecretFile),
      'owner user',
      63
    );
  } catch {
    invalidMigrationIdentity();
  }

  const resolveLogin = (dedicatedName: string, ordinaryName: string): string => {
    const value = source[dedicatedName] !== undefined
      ? source[dedicatedName]
      : source[ordinaryName];
    if (value === undefined || value.length === 0) invalidMigrationIdentity();
    try {
      return roleName(value, 'migration login identity');
    } catch {
      invalidMigrationIdentity();
    }
  };

  const identities: DatabaseMigrationIdentityConfig = {
    webUser: resolveLogin('DATABASE_MIGRATION_WEB_USER', 'DATABASE_USER'),
    workerUser: resolveLogin('DATABASE_MIGRATION_WORKER_USER', 'DATABASE_WORKER_USER'),
    storageCleanupUser: resolveLogin(
      'DATABASE_MIGRATION_STORAGE_CLEANUP_USER',
      'DATABASE_STORAGE_CLEANUP_USER'
    )
  };
  if (new Set([ownerUser, ...Object.values(identities)]).size !== 4) {
    invalidMigrationIdentity();
  }
  return identities;
}

function password(value: string, name: string): string {
  if (value.length < 32 || value.length > 256 || value.includes('\0') || /[\r\n]/u.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function legacyOwnerPassword(value: string): string {
  if (value.length < 1 || value.length > 256 || value.includes('\0') || /[\r\n]/u.test(value)) {
    invalid('owner password is invalid');
  }
  return value;
}

export function databaseEnvironmentForRole(
  source: EnvironmentValues,
  role: DatabaseRuntimeRole,
  readSecretFile?: SecretFileReader
): EnvironmentValues {
  const prefix = role === 'owner'
    ? 'DATABASE_OWNER'
    : role === 'worker'
      ? 'DATABASE_WORKER'
      : 'DATABASE_STORAGE_CLEANUP';
  return {
    ...source,
    DATABASE_USER: readRequiredSetting(source, `${prefix}_USER`, readSecretFile),
    DATABASE_USER_FILE: undefined,
    DATABASE_PASSWORD: readRequiredSetting(source, `${prefix}_PASSWORD`, readSecretFile),
    DATABASE_PASSWORD_FILE: undefined
  };
}

export function loadDatabaseRoleProvisionConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): DatabaseRoleProvisionConfig {
  const required = (name: string) => readRequiredSetting(source, name, readSecretFile);
  // The owner may be the pre-split production login. It is connection data only and is never
  // interpolated into role DDL, so preserve the legacy nonempty identifier/secret contract.
  const ownerUser = boundedText(required('DATABASE_OWNER_USER'), 'owner user', 63);
  const webUser = roleName(required('DATABASE_USER'), 'web user');
  const workerUser = roleName(required('DATABASE_WORKER_USER'), 'worker user');
  const storageCleanupUser = roleName(
    required('DATABASE_STORAGE_CLEANUP_USER'), 'storage cleanup user'
  );
  if (RESERVED_ROLES.has(ownerUser) ||
    new Set([ownerUser, webUser, workerUser, storageCleanupUser]).size !== 4) {
    invalid('login users must be distinct');
  }
  const ownerPassword = legacyOwnerPassword(required('DATABASE_OWNER_PASSWORD'));
  const webPassword = password(required('DATABASE_PASSWORD'), 'web password');
  const workerPassword = password(required('DATABASE_WORKER_PASSWORD'), 'worker password');
  const storageCleanupPassword = password(
    required('DATABASE_STORAGE_CLEANUP_PASSWORD'), 'storage cleanup password'
  );
  if (new Set([
    ownerPassword, webPassword, workerPassword, storageCleanupPassword
  ]).size !== 4) {
    invalid('login passwords must be distinct');
  }
  return {
    host: boundedText(required('DATABASE_HOST'), 'host'),
    port: integer(required('DATABASE_PORT'), 'port', 1, 65_535),
    database: boundedText(required('DATABASE_NAME'), 'database'),
    ownerUser,
    ownerPassword,
    webUser,
    webPassword,
    workerUser,
    workerPassword,
    storageCleanupUser,
    storageCleanupPassword,
    connectionTimeoutMs: integer(
      required('DATABASE_CONNECTION_TIMEOUT_MS'), 'connection timeout', 1, 86_400_000
    ),
    statementTimeoutMs: integer(
      required('DATABASE_STATEMENT_TIMEOUT_MS'), 'statement timeout', 1, 86_400_000
    )
  };
}

function quoteRole(name: string): string {
  if (!ROLE_NAME.test(name)) throw new Error('Invalid provisioned database role identifier');
  return `"${name}"`;
}

async function formattedRoleStatement(
  client: DatabaseRoleProvisionClient,
  role: string,
  rolePassword: string,
  exists: boolean
): Promise<string> {
  const template = exists
    ? "ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD %L"
    : "CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD %L";
  const result = await client.query(
    'select pg_catalog.format($1::text, $2::text, $3::text) as statement',
    [template, role, rolePassword]
  );
  const statement = (result.rows[0] as { statement?: unknown } | undefined)?.statement;
  if (typeof statement !== 'string' || statement.length < 1) {
    throw new Error('Database did not format the role provision statement');
  }
  return statement;
}

export async function provisionDatabaseRoles(
  client: DatabaseRoleProvisionClient,
  config: DatabaseRoleProvisionConfig
): Promise<void> {
  await client.query('begin');
  try {
    await client.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pale-orbit:database-role-provision'))"
    );
    const groups = await client.query(
      `select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls
       from pg_catalog.pg_roles
       where rolname = any($1::text[]) order by rolname`,
      [['pale_orbit_financial_worker', 'pale_orbit_runtime', STORAGE_CLEANUP_GROUP]]
    );
    const groupRows = groups.rows as Array<{
      rolname?: unknown;
      rolcanlogin?: unknown;
      rolsuper?: unknown;
      rolcreatedb?: unknown;
      rolcreaterole?: unknown;
      rolinherit?: unknown;
      rolreplication?: unknown;
      rolbypassrls?: unknown;
    }>;
    if (groupRows.length !== 3 || groupRows.some((row) =>
      (row.rolname !== 'pale_orbit_runtime' &&
        row.rolname !== 'pale_orbit_financial_worker' &&
        row.rolname !== STORAGE_CLEANUP_GROUP) ||
      row.rolcanlogin !== false || row.rolsuper !== false || row.rolcreatedb !== false ||
      row.rolcreaterole !== false || row.rolinherit !== true || row.rolreplication !== false ||
      row.rolbypassrls !== false
    )) throw new Error('Required database group roles are absent or unsafe');

    const logins = await client.query(
      'select rolname from pg_catalog.pg_roles where rolname = any($1::text[]) order by rolname',
      [[config.webUser, config.workerUser, config.storageCleanupUser]]
    );
    const existing = new Set(logins.rows.map((row) => (row as { rolname: string }).rolname));
    const unexpectedNamedAuthority = await client.query(
      `with recursive trusted_roles as (
         select role_row.oid
         from pg_catalog.pg_roles role_row
         where role_row.rolsuper
           or role_row.rolname = 'pg_database_owner'
           or role_row.rolname = current_user
           or role_row.rolname in (
             'pale_orbit_runtime', 'pale_orbit_financial_worker',
             'pale_orbit_storage_cleanup'
           )
           or role_row.oid = (
             select database_row.datdba
             from pg_catalog.pg_database database_row
             where database_row.datname = pg_catalog.current_database()
           )
       ), extension_objects as (
         select extension_dependency.classid, extension_dependency.objid,
                extension_dependency.objsubid
         from pg_catalog.pg_depend extension_dependency
         where extension_dependency.deptype = 'e'
         union
         select dependent_object.classid, dependent_object.objid, dependent_object.objsubid
         from pg_catalog.pg_depend dependent_object
         join extension_objects extension_object
           on extension_object.classid = dependent_object.refclassid
          and extension_object.objid = dependent_object.refobjid
          and (extension_object.objsubid = 0
            or extension_object.objsubid = dependent_object.refobjsubid)
         where dependent_object.deptype in ('a', 'i')
       ), named_object_acl as (
         select 'database'::text as object_kind, null::text as schema_name,
                database_row.oid as object_oid, acl.grantee, acl.privilege_type,
                acl.is_grantable
         from pg_catalog.pg_database database_row
         cross join lateral pg_catalog.aclexplode(database_row.datacl) acl
         where database_row.datname = pg_catalog.current_database()
         union all
         select 'schema', namespace_row.nspname, namespace_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_namespace namespace_row
         cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) acl
         where namespace_row.nspname = 'public'
         union all
         select case when relation_row.relkind = 'S' then 'sequence' else 'relation' end,
                namespace_row.nspname, relation_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_class relation_row
         join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation_row.relnamespace
         cross join lateral pg_catalog.aclexplode(relation_row.relacl) acl
         where namespace_row.nspname = 'public'
           and relation_row.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
           and not exists (
             select 1 from extension_objects extension_object
             where extension_object.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
               and extension_object.objid = relation_row.oid
               and extension_object.objsubid = 0
           )
         union all
         select 'column:' || attribute_row.attname, namespace_row.nspname,
                relation_row.oid, acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_attribute attribute_row
         join pg_catalog.pg_class relation_row on relation_row.oid = attribute_row.attrelid
         join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation_row.relnamespace
         cross join lateral pg_catalog.aclexplode(attribute_row.attacl) acl
         where namespace_row.nspname = 'public'
           and relation_row.relkind in ('r', 'p', 'v', 'm', 'f')
           and attribute_row.attnum > 0 and not attribute_row.attisdropped
           and not exists (
             select 1 from extension_objects extension_object
             where extension_object.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
               and extension_object.objid = relation_row.oid
               and extension_object.objsubid = 0
           )
         union all
         select 'function', namespace_row.nspname, function_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_proc function_row
         join pg_catalog.pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
         cross join lateral pg_catalog.aclexplode(function_row.proacl) acl
         where namespace_row.nspname = 'public'
           and not exists (
             select 1 from extension_objects extension_object
             where extension_object.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
               and extension_object.objid = function_row.oid
               and extension_object.objsubid = 0
           )
         union all
          select 'type', namespace_row.nspname, type_row.oid,
                 acl.grantee, acl.privilege_type, acl.is_grantable
          from pg_catalog.pg_type type_row
          join pg_catalog.pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
          cross join lateral pg_catalog.aclexplode(type_row.typacl) acl
         where namespace_row.nspname = 'public'
           and not exists (
             select 1 from extension_objects extension_object
             where extension_object.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
               and extension_object.objid in (type_row.oid, type_row.typelem)
               and extension_object.objsubid = 0
           )
           and not exists (
             select 1 from extension_objects extension_object
             where extension_object.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
               and extension_object.objid = type_row.typrelid
               and extension_object.objsubid = 0
           )
       ), unexpected_authority as (
         select grantee_role.oid
         from named_object_acl privilege_row
         join pg_catalog.pg_roles grantee_role on grantee_role.oid = privilege_row.grantee
         where not exists (
             select 1 from trusted_roles trusted_role where trusted_role.oid = grantee_role.oid
           ) and (
             grantee_role.rolname in ($1::text, $2::text, $3::text)
             or privilege_row.object_kind = 'database'
               and privilege_row.privilege_type not in ('CONNECT', 'TEMPORARY')
             or privilege_row.object_kind = 'schema'
               and (privilege_row.privilege_type <> 'USAGE' or privilege_row.is_grantable)
             or privilege_row.object_kind not in ('database', 'schema')
           )
         union all
         select grantee_role.oid
         from pg_catalog.pg_default_acl default_row
         join pg_catalog.pg_roles owner_role on owner_role.oid = default_row.defaclrole
         cross join lateral pg_catalog.aclexplode(default_row.defaclacl) acl
         join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
         where (
             owner_role.rolname = current_user
             or owner_role.oid = (
               select database_row.datdba
               from pg_catalog.pg_database database_row
               where database_row.datname = pg_catalog.current_database()
             )
           ) and (
             default_row.defaclnamespace = 0
             or default_row.defaclnamespace = 'public'::pg_catalog.regnamespace
           ) and not exists (
             select 1 from trusted_roles trusted_role where trusted_role.oid = grantee_role.oid
           )
         union all
         select owner_role.oid
         from (
           select namespace_row.nspowner as owner_oid
           from pg_catalog.pg_namespace namespace_row
           where namespace_row.nspname = 'public'
           union all
           select relation_row.relowner
           from pg_catalog.pg_class relation_row
           join pg_catalog.pg_namespace namespace_row
             on namespace_row.oid = relation_row.relnamespace
           where namespace_row.nspname = 'public'
             and relation_row.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
             and not exists (
               select 1 from extension_objects extension_object
               where extension_object.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                 and extension_object.objid = relation_row.oid
                 and extension_object.objsubid = 0
             )
           union all
           select function_row.proowner
           from pg_catalog.pg_proc function_row
           join pg_catalog.pg_namespace namespace_row
             on namespace_row.oid = function_row.pronamespace
           where namespace_row.nspname = 'public'
             and not exists (
               select 1 from extension_objects extension_object
               where extension_object.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                 and extension_object.objid = function_row.oid
                 and extension_object.objsubid = 0
             )
           union all
           select type_row.typowner
           from pg_catalog.pg_type type_row
           join pg_catalog.pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
           where namespace_row.nspname = 'public'
             and not exists (
               select 1 from extension_objects extension_object
               where extension_object.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
                 and extension_object.objid in (type_row.oid, type_row.typelem)
                 and extension_object.objsubid = 0
             )
             and not exists (
               select 1 from extension_objects extension_object
               where extension_object.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                 and extension_object.objid = type_row.typrelid
                 and extension_object.objsubid = 0
             )
         ) owned_object
         join pg_catalog.pg_roles owner_role on owner_role.oid = owned_object.owner_oid
         where not exists (
           select 1 from trusted_roles trusted_role where trusted_role.oid = owner_role.oid
         )
         union all
         select member_role.oid
         from pg_catalog.pg_auth_members membership
         join pg_catalog.pg_roles member_role on member_role.oid = membership.member
         join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
         where (
             member_role.rolname in (
               $1::text, $2::text, $3::text,
               'pale_orbit_runtime', 'pale_orbit_financial_worker',
               'pale_orbit_storage_cleanup'
             )
             or granted_role.rolname in (
               $1::text, $2::text, $3::text,
               'pale_orbit_runtime', 'pale_orbit_financial_worker',
               'pale_orbit_storage_cleanup'
             )
           ) and not (
             member_role.rolname = $1::text
               and granted_role.rolname = 'pale_orbit_runtime'
               and not membership.admin_option and membership.inherit_option
               and not membership.set_option
             or member_role.rolname = $2::text
               and granted_role.rolname = 'pale_orbit_financial_worker'
               and not membership.admin_option and membership.inherit_option
               and not membership.set_option
             or member_role.rolname = $3::text
               and granted_role.rolname = 'pale_orbit_storage_cleanup'
               and not membership.admin_option and membership.inherit_option
               and not membership.set_option
             or member_role.rolname = 'pale_orbit_financial_worker'
               and granted_role.rolname = 'pale_orbit_runtime'
               and not membership.admin_option and membership.inherit_option
               and not membership.set_option
           )
         union all
         select candidate_role.oid
         from pg_catalog.pg_roles candidate_role
         cross join pg_catalog.pg_roles sensitive_role
         where (
             sensitive_role.rolsuper
             or sensitive_role.rolname in (
               'pg_database_owner', 'pg_read_all_data', 'pg_write_all_data',
               'pale_orbit_runtime', 'pale_orbit_financial_worker',
               'pale_orbit_storage_cleanup'
             )
             or sensitive_role.rolname = current_user
             or sensitive_role.oid = (
               select database_row.datdba
               from pg_catalog.pg_database database_row
               where database_row.datname = pg_catalog.current_database()
             )
           ) and candidate_role.oid <> sensitive_role.oid
           and not exists (
             select 1 from trusted_roles trusted_role where trusted_role.oid = candidate_role.oid
           )
           and not (
             candidate_role.rolname = $1::text
               and sensitive_role.rolname = 'pale_orbit_runtime'
             or candidate_role.rolname = $2::text
               and sensitive_role.rolname in (
                 'pale_orbit_runtime', 'pale_orbit_financial_worker'
               )
             or candidate_role.rolname = $3::text
               and sensitive_role.rolname = 'pale_orbit_storage_cleanup'
           )
           and pg_catalog.pg_has_role(candidate_role.oid, sensitive_role.oid, 'MEMBER')
       )
       select exists (select 1 from unexpected_authority)
         as "unsafeUnexpectedNamedAuthority"`,
      [config.webUser, config.workerUser, config.storageCleanupUser]
    );
    const unexpectedNamedAuthorityRow = unexpectedNamedAuthority.rows[0] as {
      unsafeUnexpectedNamedAuthority?: unknown;
    } | undefined;
    if (unexpectedNamedAuthorityRow?.unsafeUnexpectedNamedAuthority !== false) {
      throw new Error('Unexpected named database authority requires operator remediation');
    }
    for (const [role, rolePassword] of [
      [config.webUser, config.webPassword],
      [config.workerUser, config.workerPassword],
      [config.storageCleanupUser, config.storageCleanupPassword]
    ] as const) {
      const statement = await formattedRoleStatement(
        client, role, rolePassword, existing.has(role)
      );
      await client.query(statement);
      await client.query(`ALTER ROLE ${quoteRole(role)} RESET ALL`);
    }

    const web = quoteRole(config.webUser);
    const worker = quoteRole(config.workerUser);
    const storageCleanup = quoteRole(config.storageCleanupUser);
    await client.query(`REVOKE "pale_orbit_financial_worker" FROM ${web}`);
    await client.query(`REVOKE "${STORAGE_CLEANUP_GROUP}" FROM ${web}, ${worker}`);
    await client.query(
      `REVOKE "pale_orbit_runtime", "pale_orbit_financial_worker" FROM ${storageCleanup}`
    );
    await client.query(
      `GRANT "pale_orbit_runtime" TO ${web} WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`
    );
    await client.query(
      `GRANT "pale_orbit_financial_worker" TO ${worker} WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`
    );
    await client.query(
      `GRANT "${STORAGE_CLEANUP_GROUP}" TO ${storageCleanup} WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`
    );
    const safety = await client.query(
      `with direct_acl as (
         select 'database'::text as object_kind, null::text as schema_name,
                database_row.oid as object_oid, acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_database database_row
         cross join lateral pg_catalog.aclexplode(database_row.datacl) acl
         union all
         select 'schema', namespace_row.nspname, namespace_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_namespace namespace_row
         cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) acl
         union all
         select case when relation_row.relkind = 'S' then 'sequence' else 'relation' end,
                namespace_row.nspname, relation_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_class relation_row
         join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation_row.relnamespace
         cross join lateral pg_catalog.aclexplode(relation_row.relacl) acl
         union all
         select 'column:' || attribute_row.attname,
                namespace_row.nspname, attribute_row.attrelid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_attribute attribute_row
         join pg_catalog.pg_class relation_row on relation_row.oid = attribute_row.attrelid
         join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation_row.relnamespace
         cross join lateral pg_catalog.aclexplode(attribute_row.attacl) acl
         union all
         select 'function', namespace_row.nspname, function_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_proc function_row
         join pg_catalog.pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
         cross join lateral pg_catalog.aclexplode(
           coalesce(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
         ) acl
         union all
         select 'type', namespace_row.nspname, type_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_type type_row
         join pg_catalog.pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
         cross join lateral pg_catalog.aclexplode(
           coalesce(type_row.typacl, pg_catalog.acldefault('T', type_row.typowner))
         ) acl
         union all
         select 'language', null, language_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_language language_row
         cross join lateral pg_catalog.aclexplode(language_row.lanacl) acl
         union all
         select 'large_object', null, large_object_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_largeobject_metadata large_object_row
         cross join lateral pg_catalog.aclexplode(large_object_row.lomacl) acl
         union all
         select 'tablespace', null, tablespace_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_tablespace tablespace_row
         cross join lateral pg_catalog.aclexplode(tablespace_row.spcacl) acl
         union all
         select 'foreign_data_wrapper', null, wrapper_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_foreign_data_wrapper wrapper_row
         cross join lateral pg_catalog.aclexplode(wrapper_row.fdwacl) acl
         union all
         select 'foreign_server', null, server_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_foreign_server server_row
         cross join lateral pg_catalog.aclexplode(server_row.srvacl) acl
         union all
         select 'parameter', null, parameter_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_parameter_acl parameter_row
         cross join lateral pg_catalog.aclexplode(parameter_row.paracl) acl
         union all
         select case default_row.defaclobjtype
                  when 'r' then 'default_relation'
                  when 'S' then 'default_sequence'
                  else 'default_other'
                end,
                namespace_row.nspname, default_row.oid,
                acl.grantee, acl.privilege_type, acl.is_grantable
         from pg_catalog.pg_default_acl default_row
         left join pg_catalog.pg_namespace namespace_row
           on namespace_row.oid = default_row.defaclnamespace
         cross join lateral pg_catalog.aclexplode(default_row.defaclacl) acl
       )
       select
         exists (
           select 1
           from pg_catalog.pg_auth_members membership
           join pg_catalog.pg_roles member_role on member_role.oid = membership.member
           join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
           where (
               member_role.rolname = any($1::text[])
               or granted_role.rolname = any($1::text[])
             )
              and not (
                (member_role.rolname = $2::text and granted_role.rolname = 'pale_orbit_runtime'
                  and not membership.admin_option and membership.inherit_option
                  and not membership.set_option)
                or (member_role.rolname = $3::text and granted_role.rolname = 'pale_orbit_financial_worker'
                  and not membership.admin_option and membership.inherit_option
                  and not membership.set_option)
                or (member_role.rolname = 'pale_orbit_financial_worker'
                  and granted_role.rolname = 'pale_orbit_runtime'
                  and not membership.admin_option and membership.inherit_option
                  and not membership.set_option)
              )
         ) as "unsafeMembership",
         exists (
           select 1
           from pg_catalog.pg_shdepend owner_dependency
           join pg_catalog.pg_roles owner_role on owner_role.oid = owner_dependency.refobjid
           where owner_dependency.deptype = 'o'
             and owner_role.rolname = any($1::text[])
         ) as "unsafeOwnership",
         (
           exists (
             select 1
             from direct_acl privilege_row
             join pg_catalog.pg_roles grantee_role on grantee_role.oid = privilege_row.grantee
             where grantee_role.rolname = any($1::text[])
               and not (
                 grantee_role.rolname = 'pale_orbit_runtime'
                 and not privilege_row.is_grantable
                  and (
                    (privilege_row.object_kind = 'database'
                      and privilege_row.object_oid = (
                        select database_row.oid
                        from pg_catalog.pg_database database_row
                        where database_row.datname = pg_catalog.current_database()
                      )
                      and privilege_row.privilege_type = 'CONNECT')
                    or privilege_row.schema_name = 'public' and (
                    (privilege_row.object_kind = 'schema'
                      and privilege_row.privilege_type = 'USAGE')
                    or (privilege_row.object_kind = 'relation'
                      and privilege_row.privilege_type = 'SELECT'
                      and not exists (
                        select 1
                        from pg_catalog.pg_class excluded_relation
                        join pg_catalog.pg_namespace excluded_namespace
                          on excluded_namespace.oid = excluded_relation.relnamespace
                        where excluded_relation.oid = privilege_row.object_oid
                          and excluded_namespace.nspname = 'public'
                          and excluded_relation.relname = any($13::text[])
                      ))
                    or (privilege_row.object_kind = 'relation'
                      and privilege_row.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
                      and not exists (
                        select 1
                        from pg_catalog.pg_class protected_relation
                        join pg_catalog.pg_namespace protected_namespace
                          on protected_namespace.oid = protected_relation.relnamespace
                        where protected_relation.oid = privilege_row.object_oid
                          and protected_namespace.nspname = 'public'
                          and protected_relation.relname = any($4::text[])
                      ))
                    or (privilege_row.object_kind = 'default_relation'
                      and privilege_row.privilege_type = 'SELECT')
                    or (privilege_row.object_kind in ('sequence', 'default_sequence')
                      and privilege_row.privilege_type in ('USAGE', 'SELECT', 'UPDATE'))
                    or (privilege_row.object_kind like 'column:%'
                      and exists (
                        select 1
                        from pg_catalog.pg_class allowed_relation
                        join pg_catalog.pg_namespace allowed_namespace
                          on allowed_namespace.oid = allowed_relation.relnamespace
                        where allowed_relation.oid = privilege_row.object_oid
                          and allowed_namespace.nspname = 'public'
                          and allowed_relation.relname || ':' ||
                            privilege_row.privilege_type || ':' ||
                            pg_catalog.substr(privilege_row.object_kind, 8) = any($8::text[])
                      ))
                    or (privilege_row.object_kind = 'function'
                      and privilege_row.privilege_type = 'EXECUTE'
                      and exists (
                        select 1 from unnest($10::text[]) allowed_function(signature)
                        where privilege_row.object_oid =
                          pg_catalog.to_regprocedure(allowed_function.signature)
                      ))
                    )
                  )
                  or grantee_role.rolname = 'pale_orbit_financial_worker'
                  and not privilege_row.is_grantable
                  and (
                    privilege_row.object_kind = 'database'
                    and privilege_row.object_oid = (
                      select database_row.oid
                      from pg_catalog.pg_database database_row
                      where database_row.datname = pg_catalog.current_database()
                    )
                    and privilege_row.privilege_type = 'CONNECT'
                    or privilege_row.object_kind = 'relation'
                    and privilege_row.privilege_type = 'SELECT'
                    and exists (
                      select 1
                      from pg_catalog.pg_class allowed_relation
                      join pg_catalog.pg_namespace allowed_namespace
                        on allowed_namespace.oid = allowed_relation.relnamespace
                      where allowed_relation.oid = privilege_row.object_oid
                        and allowed_namespace.nspname = 'public'
                        and allowed_relation.relname = any($12::text[])
                    )
                    or privilege_row.object_kind = 'relation'
                    and privilege_row.privilege_type = 'INSERT'
                    and exists (
                      select 1
                      from pg_catalog.pg_class allowed_relation
                      join pg_catalog.pg_namespace allowed_namespace
                        on allowed_namespace.oid = allowed_relation.relnamespace
                      where allowed_relation.oid = privilege_row.object_oid
                        and allowed_namespace.nspname = 'public'
                        and allowed_relation.relname = any($5::text[])
                    )
                    or privilege_row.object_kind = 'relation'
                    and privilege_row.privilege_type = 'UPDATE'
                    and exists (
                      select 1
                      from pg_catalog.pg_class allowed_relation
                      join pg_catalog.pg_namespace allowed_namespace
                        on allowed_namespace.oid = allowed_relation.relnamespace
                      where allowed_relation.oid = privilege_row.object_oid
                        and allowed_namespace.nspname = 'public'
                        and allowed_relation.relname = any($6::text[])
                    )
                    or privilege_row.object_kind = 'relation'
                    and privilege_row.privilege_type = 'DELETE'
                    and exists (
                      select 1
                      from pg_catalog.pg_class allowed_relation
                      join pg_catalog.pg_namespace allowed_namespace
                        on allowed_namespace.oid = allowed_relation.relnamespace
                      where allowed_relation.oid = privilege_row.object_oid
                        and allowed_namespace.nspname = 'public'
                        and allowed_relation.relname = any($7::text[])
                    )
                    or privilege_row.object_kind like 'column:%'
                    and exists (
                      select 1
                      from pg_catalog.pg_class allowed_relation
                      join pg_catalog.pg_namespace allowed_namespace
                        on allowed_namespace.oid = allowed_relation.relnamespace
                      where allowed_relation.oid = privilege_row.object_oid
                        and allowed_namespace.nspname = 'public'
                        and allowed_relation.relname || ':' ||
                          privilege_row.privilege_type || ':' ||
                          pg_catalog.substr(privilege_row.object_kind, 8) = any($9::text[])
                    )
                    or privilege_row.object_kind = 'function'
                    and privilege_row.privilege_type = 'EXECUTE'
                    and exists (
                      select 1 from unnest($11::text[]) allowed_function(signature)
                      where privilege_row.object_oid =
                        pg_catalog.to_regprocedure(allowed_function.signature)
                    )
                    or privilege_row.object_kind = 'type'
                    and privilege_row.privilege_type = 'USAGE'
                    and exists (
                      select 1 from unnest($15::text[]) allowed_type(type_name)
                      where privilege_row.object_oid =
                        pg_catalog.to_regtype(allowed_type.type_name)
                    )
                  )
                 )
             ) or exists (
               select 1
               from direct_acl privilege_row
               where privilege_row.grantee = 0
                 and not (
                   privilege_row.object_kind = 'relation'
                   and privilege_row.object_oid = 'pg_catalog.pg_settings'::pg_catalog.regclass
                   and privilege_row.privilege_type = 'UPDATE'
                   and not privilege_row.is_grantable
                 )
                 and (
                   privilege_row.is_grantable
                   or privilege_row.object_kind like 'default_%'
                   or privilege_row.object_kind = 'parameter'
                   or privilege_row.object_kind = 'database'
                     and privilege_row.privilege_type not in ('CONNECT', 'TEMPORARY')
                   or privilege_row.object_kind = 'schema'
                     and privilege_row.privilege_type = 'CREATE'
                   or privilege_row.object_kind = 'relation'
                     and privilege_row.privilege_type = 'SELECT'
                     and exists (
                       select 1
                       from pg_catalog.pg_class sensitive_relation
                       join pg_catalog.pg_namespace sensitive_namespace
                         on sensitive_namespace.oid = sensitive_relation.relnamespace
                       cross join unnest($14::text[]) sensitive_column(token)
                       where sensitive_relation.oid = privilege_row.object_oid
                         and sensitive_namespace.nspname = 'public'
                         and sensitive_relation.relname =
                           pg_catalog.split_part(sensitive_column.token, ':', 1)
                     )
                   or privilege_row.object_kind = 'relation'
                      and privilege_row.privilege_type in (
                        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
                      )
                   or privilege_row.object_kind like 'column:%'
                     and privilege_row.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
                   or privilege_row.object_kind like 'column:%'
                     and privilege_row.privilege_type = 'SELECT'
                     and exists (
                       select 1
                       from pg_catalog.pg_class sensitive_relation
                       join pg_catalog.pg_namespace sensitive_namespace
                         on sensitive_namespace.oid = sensitive_relation.relnamespace
                       cross join unnest($14::text[]) sensitive_column(token)
                       where sensitive_relation.oid = privilege_row.object_oid
                         and sensitive_namespace.nspname = 'public'
                         and sensitive_relation.relname =
                           pg_catalog.split_part(sensitive_column.token, ':', 1)
                         and (
                           pg_catalog.split_part(sensitive_column.token, ':', 2) = '*'
                           or pg_catalog.substr(privilege_row.object_kind, 8) =
                             pg_catalog.split_part(sensitive_column.token, ':', 2)
                         )
                     )
                   or privilege_row.object_kind = 'sequence'
                     and privilege_row.privilege_type in ('USAGE', 'UPDATE')
                   or privilege_row.object_kind = 'function'
                     and privilege_row.privilege_type = 'EXECUTE'
                     and privilege_row.schema_name !~ '^pg_'
                     and privilege_row.schema_name <> 'information_schema'
                     and exists (
                       select 1
                       from pg_catalog.pg_proc function_row
                       where function_row.oid = privilege_row.object_oid
                         and function_row.prosecdef
                     )
                   or privilege_row.object_kind = 'type'
                     and privilege_row.privilege_type = 'USAGE'
                     and exists (
                      select 1 from unnest($16::text[]) protected_type(type_name)
                       where privilege_row.object_oid =
                         pg_catalog.to_regtype(protected_type.type_name)
                     )
                   or privilege_row.object_kind = 'large_object'
                     and privilege_row.privilege_type = 'UPDATE'
                   or privilege_row.object_kind = 'tablespace'
                     and privilege_row.privilege_type = 'CREATE'
                   or privilege_row.object_kind in (
                     'foreign_data_wrapper', 'foreign_server'
                   )
                 )
             ) or exists (
              select 1
              from pg_catalog.pg_shdepend authority_dependency
             join pg_catalog.pg_roles authority_role
               on authority_role.oid = authority_dependency.refobjid
             where authority_dependency.deptype in ('a', 'i', 'r')
               and authority_role.rolname = any($1::text[])
                and not (
                  authority_dependency.deptype = 'a'
                  and (
                    authority_dependency.classid =
                      'pg_catalog.pg_database'::pg_catalog.regclass
                    and authority_dependency.objid = (
                      select database_row.oid
                      from pg_catalog.pg_database database_row
                      where database_row.datname = pg_catalog.current_database()
                    )
                    and authority_role.rolname in (
                      'pale_orbit_runtime', 'pale_orbit_financial_worker'
                    )
                    or authority_dependency.dbid = (
                      select database_row.oid
                      from pg_catalog.pg_database database_row
                      where database_row.datname = pg_catalog.current_database()
                    ) and (
                    authority_role.rolname = 'pale_orbit_runtime'
                   and (
                     authority_dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
                     and authority_dependency.objid = 'public'::pg_catalog.regnamespace
                     or authority_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                     and exists (
                       select 1
                       from pg_catalog.pg_class allowed_relation
                       join pg_catalog.pg_namespace allowed_namespace
                         on allowed_namespace.oid = allowed_relation.relnamespace
                       where allowed_relation.oid = authority_dependency.objid
                         and allowed_namespace.nspname = 'public'
                     )
                      or authority_dependency.classid = 'pg_catalog.pg_default_acl'::pg_catalog.regclass
                     and exists (
                       select 1
                       from pg_catalog.pg_default_acl allowed_default
                       join pg_catalog.pg_namespace allowed_namespace
                         on allowed_namespace.oid = allowed_default.defaclnamespace
                       where allowed_default.oid = authority_dependency.objid
                         and allowed_namespace.nspname = 'public'
                          and allowed_default.defaclobjtype in ('r', 'S')
                      )
                      or authority_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                      and exists (
                        select 1 from unnest($10::text[]) allowed_function(signature)
                        where authority_dependency.objid =
                          pg_catalog.to_regprocedure(allowed_function.signature)
                      )
                   )
                    or authority_role.rolname = 'pale_orbit_financial_worker'
                    and (
                      authority_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                      and exists (
                        select 1
                        from pg_catalog.pg_class allowed_relation
                        join pg_catalog.pg_namespace allowed_namespace
                          on allowed_namespace.oid = allowed_relation.relnamespace
                        where allowed_relation.oid = authority_dependency.objid
                          and allowed_namespace.nspname = 'public'
                          and (
                             allowed_relation.relname = any($5::text[])
                             or allowed_relation.relname = any($6::text[])
                             or allowed_relation.relname = any($7::text[])
                             or allowed_relation.relname = any($12::text[])
                             or allowed_relation.relname in (
                              select pg_catalog.split_part(allowed_column.token, ':', 1)
                              from unnest($9::text[]) allowed_column(token)
                            )
                          )
                      )
                      or authority_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                      and exists (
                        select 1 from unnest($11::text[]) allowed_function(signature)
                        where authority_dependency.objid =
                          pg_catalog.to_regprocedure(allowed_function.signature)
                      )
                      or authority_dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
                      and exists (
                        select 1 from unnest($15::text[]) allowed_type(type_name)
                        where authority_dependency.objid =
                          pg_catalog.to_regtype(allowed_type.type_name)
                      )
                    )
                  )
                  )
                )
            )
         ) as "unsafeAcl",
           (
             pg_catalog.current_setting('session_replication_role') is distinct from 'origin'
             or exists (
               select 1
               from pg_catalog.pg_db_role_setting setting_row
               cross join lateral pg_catalog.unnest(setting_row.setconfig)
                 configured_setting(value)
               where exists (
                 select 1
                 from pg_catalog.pg_roles setting_role
                 where setting_role.oid = setting_row.setrole
                   and setting_role.rolname = any($1::text[])
               ) or setting_row.setrole = 0
                 and (
                   setting_row.setdatabase = 0 or setting_row.setdatabase = (
                     select database_row.oid
                     from pg_catalog.pg_database database_row
                     where database_row.datname = pg_catalog.current_database()
                   )
                 )
                 and (
                   pg_catalog.split_part(configured_setting.value, '=', 1) =
                     'session_replication_role'
                     and pg_catalog.lower(
                       pg_catalog.split_part(configured_setting.value, '=', 2)
                     ) <> 'origin'
                   or pg_catalog.split_part(configured_setting.value, '=', 1) = 'role'
                     and pg_catalog.lower(
                       pg_catalog.split_part(configured_setting.value, '=', 2)
                     ) <> 'none'
                   or pg_catalog.split_part(configured_setting.value, '=', 1) = 'search_path'
                    or pg_catalog.split_part(configured_setting.value, '=', 1) = 'row_security'
                      and pg_catalog.lower(
                        pg_catalog.split_part(configured_setting.value, '=', 2)
                      ) = 'off'
                  )
                or setting_row.setrole in (
                    0::oid,
                    (
                      select database_row.datdba
                      from pg_catalog.pg_database database_row
                      where database_row.datname = pg_catalog.current_database()
                    )
                  )
                  and setting_row.setdatabase in (
                    0::oid,
                    (
                      select database_row.oid
                      from pg_catalog.pg_database database_row
                      where database_row.datname = pg_catalog.current_database()
                    )
                  )
                  and pg_catalog.split_part(configured_setting.value, '=', 1) = any($17::text[])
              )
            ) as "unsafeRoleSetting",
           (
             not exists (
               select 1
               from direct_acl privilege_row
               join pg_catalog.pg_roles grantee_role on grantee_role.oid = privilege_row.grantee
               where grantee_role.rolname = 'pale_orbit_runtime'
                 and privilege_row.object_kind = 'schema'
                 and privilege_row.schema_name = 'public'
                 and privilege_row.privilege_type = 'USAGE'
                 and not privilege_row.is_grantable
             ) or exists (
               select 1
               from pg_catalog.pg_class required_relation
               join pg_catalog.pg_namespace required_namespace
                 on required_namespace.oid = required_relation.relnamespace
                where required_namespace.nspname = 'public'
                  and required_relation.relkind in ('r', 'p', 'v', 'm', 'f')
                  and required_relation.relname <> all($13::text[])
                  and not exists (
                   select 1
                   from direct_acl privilege_row
                   join pg_catalog.pg_roles grantee_role
                     on grantee_role.oid = privilege_row.grantee
                   where grantee_role.rolname = 'pale_orbit_runtime'
                     and privilege_row.object_kind = 'relation'
                     and privilege_row.object_oid = required_relation.oid
                     and privilege_row.privilege_type = 'SELECT'
                     and not privilege_row.is_grantable
                 )
              ) or exists (
                select 1
                from unnest($12::text[]) required_table(relname)
                left join pg_catalog.pg_namespace required_namespace
                  on required_namespace.nspname = 'public'
                left join pg_catalog.pg_class required_relation
                  on required_relation.relnamespace = required_namespace.oid
                 and required_relation.relname = required_table.relname
                where required_relation.oid is null or not exists (
                  select 1
                  from direct_acl privilege_row
                  join pg_catalog.pg_roles grantee_role
                    on grantee_role.oid = privilege_row.grantee
                  where grantee_role.rolname = 'pale_orbit_financial_worker'
                    and privilege_row.object_kind = 'relation'
                    and privilege_row.object_oid = required_relation.oid
                    and privilege_row.privilege_type = 'SELECT'
                    and not privilege_row.is_grantable
                )
              ) or exists (
                select 1
                from pg_catalog.pg_class required_sequence
               join pg_catalog.pg_namespace required_namespace
                 on required_namespace.oid = required_sequence.relnamespace
               cross join unnest(array['USAGE', 'SELECT', 'UPDATE']::text[])
                 required_privilege(privilege_type)
               where required_namespace.nspname = 'public'
                 and required_sequence.relkind = 'S'
                 and not exists (
                   select 1
                   from direct_acl privilege_row
                   join pg_catalog.pg_roles grantee_role
                     on grantee_role.oid = privilege_row.grantee
                   where grantee_role.rolname = 'pale_orbit_runtime'
                     and privilege_row.object_kind = 'sequence'
                     and privilege_row.object_oid = required_sequence.oid
                     and privilege_row.privilege_type = required_privilege.privilege_type
                     and not privilege_row.is_grantable
                 )
             ) or not exists (
               select 1
               from direct_acl privilege_row
               join pg_catalog.pg_roles grantee_role on grantee_role.oid = privilege_row.grantee
               where grantee_role.rolname = 'pale_orbit_runtime'
                 and privilege_row.object_kind = 'default_relation'
                 and privilege_row.schema_name = 'public'
                 and privilege_row.privilege_type = 'SELECT'
                 and not privilege_row.is_grantable
             ) or exists (
               select 1
               from unnest(array['USAGE', 'SELECT', 'UPDATE']::text[])
                 required_privilege(privilege_type)
               where not exists (
                 select 1
                 from direct_acl privilege_row
                 join pg_catalog.pg_roles grantee_role
                   on grantee_role.oid = privilege_row.grantee
                 where grantee_role.rolname = 'pale_orbit_runtime'
                   and privilege_row.object_kind = 'default_sequence'
                   and privilege_row.schema_name = 'public'
                   and privilege_row.privilege_type = required_privilege.privilege_type
                   and not privilege_row.is_grantable
               )
             ) or exists (
               select 1
               from unnest($5::text[]) required_table(relname)
               left join pg_catalog.pg_namespace required_namespace
                 on required_namespace.nspname = 'public'
               left join pg_catalog.pg_class required_relation
                 on required_relation.relnamespace = required_namespace.oid
                and required_relation.relname = required_table.relname
               where required_relation.oid is null or not exists (
                 select 1
                 from direct_acl privilege_row
                 join pg_catalog.pg_roles grantee_role
                   on grantee_role.oid = privilege_row.grantee
                 where grantee_role.rolname = 'pale_orbit_financial_worker'
                   and privilege_row.object_kind = 'relation'
                   and privilege_row.object_oid = required_relation.oid
                   and privilege_row.privilege_type = 'INSERT'
                   and not privilege_row.is_grantable
               )
             ) or exists (
               select 1
               from unnest($6::text[]) required_table(relname)
               left join pg_catalog.pg_namespace required_namespace
                 on required_namespace.nspname = 'public'
               left join pg_catalog.pg_class required_relation
                 on required_relation.relnamespace = required_namespace.oid
                and required_relation.relname = required_table.relname
               where required_relation.oid is null or not exists (
                 select 1
                 from direct_acl privilege_row
                 join pg_catalog.pg_roles grantee_role
                   on grantee_role.oid = privilege_row.grantee
                 where grantee_role.rolname = 'pale_orbit_financial_worker'
                   and privilege_row.object_kind = 'relation'
                   and privilege_row.object_oid = required_relation.oid
                   and privilege_row.privilege_type = 'UPDATE'
                   and not privilege_row.is_grantable
               )
              ) or exists (
                select 1
                from unnest($7::text[]) required_table(relname)
                left join pg_catalog.pg_namespace required_namespace
                  on required_namespace.nspname = 'public'
                left join pg_catalog.pg_class required_relation
                  on required_relation.relnamespace = required_namespace.oid
                 and required_relation.relname = required_table.relname
                where required_relation.oid is null or not exists (
                  select 1
                  from direct_acl privilege_row
                  join pg_catalog.pg_roles grantee_role
                    on grantee_role.oid = privilege_row.grantee
                  where grantee_role.rolname = 'pale_orbit_financial_worker'
                    and privilege_row.object_kind = 'relation'
                    and privilege_row.object_oid = required_relation.oid
                    and privilege_row.privilege_type = 'DELETE'
                    and not privilege_row.is_grantable
                )
              ) or exists (
                select 1
                from unnest($8::text[]) required_column(token)
                left join pg_catalog.pg_namespace required_namespace
                  on required_namespace.nspname = 'public'
                left join pg_catalog.pg_class required_relation
                  on required_relation.relnamespace = required_namespace.oid
                 and required_relation.relname =
                   pg_catalog.split_part(required_column.token, ':', 1)
                left join pg_catalog.pg_attribute attribute_row
                  on attribute_row.attrelid = required_relation.oid
                 and attribute_row.attname =
                   pg_catalog.split_part(required_column.token, ':', 3)
                 and not attribute_row.attisdropped
                where required_relation.oid is null or attribute_row.attnum is null or not exists (
                  select 1
                  from pg_catalog.aclexplode(attribute_row.attacl) acl
                  join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
                  where grantee_role.rolname = 'pale_orbit_runtime'
                    and acl.privilege_type =
                      pg_catalog.split_part(required_column.token, ':', 2)
                    and not acl.is_grantable
                )
              ) or exists (
                select 1
                from unnest($9::text[]) required_column(token)
                left join pg_catalog.pg_namespace required_namespace
                  on required_namespace.nspname = 'public'
                left join pg_catalog.pg_class required_relation
                  on required_relation.relnamespace = required_namespace.oid
                 and required_relation.relname =
                   pg_catalog.split_part(required_column.token, ':', 1)
                left join pg_catalog.pg_attribute attribute_row
                  on attribute_row.attrelid = required_relation.oid
                 and attribute_row.attname =
                   pg_catalog.split_part(required_column.token, ':', 3)
                 and not attribute_row.attisdropped
                where required_relation.oid is null or attribute_row.attnum is null or not exists (
                  select 1
                  from pg_catalog.aclexplode(attribute_row.attacl) acl
                  join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
                  where grantee_role.rolname = 'pale_orbit_financial_worker'
                    and acl.privilege_type =
                      pg_catalog.split_part(required_column.token, ':', 2)
                    and not acl.is_grantable
                )
              ) or exists (
                select 1
                from unnest($10::text[]) required_function(signature)
                where pg_catalog.to_regprocedure(required_function.signature) is null or
                  not exists (
                    select 1
                    from direct_acl privilege_row
                    join pg_catalog.pg_roles grantee_role
                      on grantee_role.oid = privilege_row.grantee
                    where grantee_role.rolname = 'pale_orbit_runtime'
                      and privilege_row.object_kind = 'function'
                      and privilege_row.object_oid =
                        pg_catalog.to_regprocedure(required_function.signature)
                      and privilege_row.privilege_type = 'EXECUTE'
                      and not privilege_row.is_grantable
                  )
              ) or exists (
                select 1
                from unnest($11::text[]) required_function(signature)
                where pg_catalog.to_regprocedure(required_function.signature) is null or
                  not exists (
                    select 1
                    from direct_acl privilege_row
                    join pg_catalog.pg_roles grantee_role
                      on grantee_role.oid = privilege_row.grantee
                    where grantee_role.rolname = 'pale_orbit_financial_worker'
                      and privilege_row.object_kind = 'function'
                      and privilege_row.object_oid =
                        pg_catalog.to_regprocedure(required_function.signature)
                      and privilege_row.privilege_type = 'EXECUTE'
                      and not privilege_row.is_grantable
                  )
              ) or exists (
                select 1
                from unnest($15::text[]) required_type(type_name)
                where pg_catalog.to_regtype(required_type.type_name) is null or
                  not exists (
                    select 1
                    from direct_acl privilege_row
                    join pg_catalog.pg_roles grantee_role
                      on grantee_role.oid = privilege_row.grantee
                    where grantee_role.rolname = 'pale_orbit_financial_worker'
                      and privilege_row.object_kind = 'type'
                      and privilege_row.object_oid =
                        pg_catalog.to_regtype(required_type.type_name)
                      and privilege_row.privilege_type = 'USAGE'
                      and not privilege_row.is_grantable
                  )
              ) or exists (
                select 1
                from unnest(array[
                  'pale_orbit_runtime', 'pale_orbit_financial_worker'
                ]::text[]) required_group(rolname)
                where not exists (
                  select 1
                  from direct_acl privilege_row
                  join pg_catalog.pg_roles grantee_role
                    on grantee_role.oid = privilege_row.grantee
                  where grantee_role.rolname = required_group.rolname
                    and privilege_row.object_kind = 'database'
                    and privilege_row.object_oid = (
                      select database_row.oid
                      from pg_catalog.pg_database database_row
                      where database_row.datname = pg_catalog.current_database()
                    )
                    and privilege_row.privilege_type = 'CONNECT'
                    and not privilege_row.is_grantable
                )
              ) or not pg_catalog.has_database_privilege(
                $2::text, pg_catalog.current_database(), 'CONNECT'
              ) or not pg_catalog.has_database_privilege(
                $3::text, pg_catalog.current_database(), 'CONNECT'
              )
            ) as "missingRequiredAcl"`,
      [[config.webUser, config.workerUser, 'pale_orbit_runtime',
        'pale_orbit_financial_worker'], config.webUser, config.workerUser,
      PROTECTED_RUNTIME_WRITE_TABLES, WORKER_INSERT_TABLES,
      WORKER_UPDATE_TABLES, WORKER_DELETE_TABLES,
      RUNTIME_COLUMN_PRIVILEGES, WORKER_COLUMN_PRIVILEGES,
      RUNTIME_EXECUTE_FUNCTIONS, WORKER_EXECUTE_FUNCTIONS,
      WORKER_SELECT_TABLES, RUNTIME_TABLE_SELECT_EXCLUSIONS,
        PUBLIC_SENSITIVE_SELECT_COLUMNS, WORKER_USAGE_TYPES, PROTECTED_OPERATIONS_TYPES,
        PROTECTED_OPERATIONS_GUCS]
    );
    const safetyRow = safety.rows[0] as {
      unsafeMembership?: unknown;
      unsafeOwnership?: unknown;
      unsafeAcl?: unknown;
      unsafeRoleSetting?: unknown;
      missingRequiredAcl?: unknown;
    } | undefined;
    if (safetyRow?.unsafeMembership !== false || safetyRow.unsafeOwnership !== false ||
      safetyRow.unsafeAcl !== false || safetyRow.unsafeRoleSetting !== false ||
      safetyRow.missingRequiredAcl !== false) {
      throw new Error('Unsafe existing database login authority requires operator remediation');
    }
    const cleanupSafety = await client.query(
      `with cleanup_roles as (
         select role_row.oid, role_row.rolname, role_row.rolcanlogin, role_row.rolsuper,
                role_row.rolcreatedb, role_row.rolcreaterole, role_row.rolinherit,
                role_row.rolreplication, role_row.rolbypassrls, role_row.rolconnlimit,
                role_row.rolvaliduntil, role_row.rolconfig
         from pg_catalog.pg_roles role_row
         where role_row.rolname in ($1::text, $2::text)
       ), cleanup_function as (
         select pg_catalog.to_regprocedure($3::text) as oid
       )
       select
         (
           exists (
             select 1
             from pg_catalog.pg_auth_members membership
             join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
             join pg_catalog.pg_roles member_role on member_role.oid = membership.member
             where (membership.roleid in (select oid from cleanup_roles)
                 or membership.member in (select oid from cleanup_roles))
               and not (
                 granted_role.rolname = $1::text and member_role.rolname = $2::text and
                 not membership.admin_option and membership.inherit_option and
                 not membership.set_option
               )
           ) or not exists (
             select 1
             from pg_catalog.pg_auth_members membership
             join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
             join pg_catalog.pg_roles member_role on member_role.oid = membership.member
             where granted_role.rolname = $1::text and member_role.rolname = $2::text
               and not membership.admin_option and membership.inherit_option and
               not membership.set_option
           )
         ) as "unsafeCleanupMembership",
         exists (
           select 1
           from pg_catalog.pg_shdepend dependency
           where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
             and dependency.refobjid in (select oid from cleanup_roles)
             and dependency.deptype = 'o'
         ) as "unsafeCleanupOwnership",
         (
           exists (
             select 1
             from pg_catalog.pg_shdepend dependency
             join cleanup_roles grantee_role on grantee_role.oid = dependency.refobjid
             cross join cleanup_function required_function
             where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                and dependency.deptype = 'a'
                and not (
                  grantee_role.rolname = $1::text and dependency.objsubid = 0 and
                  (
                    dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
                    and dependency.objid = (
                      select database_row.oid
                      from pg_catalog.pg_database database_row
                      where database_row.datname = pg_catalog.current_database()
                    )
                    or dependency.dbid = (
                      select database_row.oid
                      from pg_catalog.pg_database database_row
                      where database_row.datname = pg_catalog.current_database()
                    ) and (
                      (dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
                        and dependency.objid = 'public'::pg_catalog.regnamespace)
                      or (dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                        and dependency.objid = required_function.oid)
                    )
                  )
                )
            ) or exists (
              select 1
              from pg_catalog.pg_database database_row
              cross join lateral pg_catalog.aclexplode(database_row.datacl) acl
              join cleanup_roles grantee_role on grantee_role.oid = acl.grantee
              where database_row.datname = pg_catalog.current_database()
                and not (
                  grantee_role.rolname = $1::text
                  and acl.privilege_type = 'CONNECT'
                  and not acl.is_grantable
                )
            ) or exists (
             select 1
             from pg_catalog.pg_namespace namespace_row
             cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) acl
             join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
             where namespace_row.nspname = 'public' and grantee_role.rolname = $1::text
               and (acl.privilege_type <> 'USAGE' or acl.is_grantable)
           ) or exists (
             select 1
             from pg_catalog.pg_proc routine
             cross join cleanup_function required_function
             cross join lateral pg_catalog.aclexplode(
               coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
             ) acl
             join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
             where routine.oid = required_function.oid and grantee_role.rolname = $1::text
               and (acl.privilege_type <> 'EXECUTE' or acl.is_grantable)
           )
         ) as "unsafeCleanupAcl",
         exists (
           select 1
           from pg_catalog.pg_db_role_setting setting_row
           where setting_row.setrole in (select oid from cleanup_roles)
         ) as "unsafeCleanupRoleSetting",
         (
           (select pg_catalog.count(*) from cleanup_roles) <> 2
           or exists (
             select 1
             from cleanup_roles role_row
             where role_row.rolsuper or role_row.rolcreatedb or role_row.rolcreaterole or
               not role_row.rolinherit or role_row.rolreplication or role_row.rolbypassrls or
               role_row.rolconnlimit <> -1 or role_row.rolconfig is not null or
               (role_row.rolname = $1::text and (
                 role_row.rolcanlogin or role_row.rolvaliduntil is not null
               )) or
               (role_row.rolname = $2::text and (
                 not role_row.rolcanlogin or role_row.rolvaliduntil is distinct from
                   'infinity'::timestamp with time zone
               ))
           ) or exists (
             select 1
             from cleanup_roles role_row
             where pg_catalog.has_database_privilege(
               role_row.rolname, pg_catalog.current_database(), 'CREATE'
             )
           ) or exists (
             select 1
             from cleanup_roles role_row
             cross join pg_catalog.pg_namespace namespace_row
             where namespace_row.nspname !~ '^pg_' and
               namespace_row.nspname <> 'information_schema' and (
                 (namespace_row.nspname = 'public' and (
                   not pg_catalog.has_schema_privilege(
                     role_row.rolname, namespace_row.oid, 'USAGE'
                   ) or pg_catalog.has_schema_privilege(
                     role_row.rolname, namespace_row.oid, 'CREATE'
                   )
                 )) or
                 (namespace_row.nspname <> 'public' and (
                   pg_catalog.has_schema_privilege(
                     role_row.rolname, namespace_row.oid, 'USAGE'
                   ) or pg_catalog.has_schema_privilege(
                     role_row.rolname, namespace_row.oid, 'CREATE'
                   )
                 ))
               )
           ) or exists (
             select 1
             from cleanup_roles role_row
             cross join pg_catalog.pg_class relation_row
             join pg_catalog.pg_namespace namespace_row
               on namespace_row.oid = relation_row.relnamespace
             cross join pg_catalog.unnest(array[
               'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
               'REFERENCES', 'TRIGGER', 'MAINTAIN'
             ]::text[]) privilege(privilege_name)
             where namespace_row.nspname = 'public'
               and relation_row.relkind in ('r', 'p', 'v', 'm', 'f')
               and pg_catalog.has_table_privilege(
                 role_row.rolname, relation_row.oid, privilege.privilege_name
               )
           ) or exists (
             select 1
             from cleanup_roles role_row
             cross join pg_catalog.pg_class relation_row
             join pg_catalog.pg_namespace namespace_row
               on namespace_row.oid = relation_row.relnamespace
             cross join pg_catalog.unnest(
               array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
             ) privilege(privilege_name)
             where namespace_row.nspname = 'public'
               and relation_row.relkind in ('r', 'p', 'v', 'm', 'f')
               and pg_catalog.has_any_column_privilege(
                 role_row.rolname, relation_row.oid, privilege.privilege_name
               )
           ) or exists (
             select 1
             from cleanup_roles role_row
             cross join pg_catalog.pg_class sequence_row
             join pg_catalog.pg_namespace namespace_row
               on namespace_row.oid = sequence_row.relnamespace
             cross join pg_catalog.unnest(array['SELECT', 'USAGE', 'UPDATE']::text[])
               privilege(privilege_name)
             where namespace_row.nspname = 'public' and sequence_row.relkind = 'S'
               and pg_catalog.has_sequence_privilege(
                 role_row.rolname, sequence_row.oid, privilege.privilege_name
               )
           ) or exists (
             select 1
             from cleanup_roles role_row
             cross join pg_catalog.pg_proc routine
             join pg_catalog.pg_namespace namespace_row on namespace_row.oid = routine.pronamespace
             cross join cleanup_function required_function
             where namespace_row.nspname !~ '^pg_'
               and namespace_row.nspname <> 'information_schema'
               and routine.oid is distinct from required_function.oid
               and pg_catalog.has_function_privilege(
                 role_row.rolname, routine.oid, 'EXECUTE'
               )
           )
         ) as "unsafeCleanupEffectiveAuthority",
         (
           (select oid from cleanup_function) is null or not exists (
             select 1
             from pg_catalog.pg_proc routine
             cross join cleanup_function required_function
             where routine.oid = required_function.oid and routine.prosecdef
               and routine.provolatile = 's'
               and routine.proconfig is not distinct from array['search_path=pg_catalog']::text[]
               and routine.proowner = (
                 select owner_role.oid
                 from pg_catalog.pg_roles owner_role
                 where owner_role.rolname = $4::text
               )
           ) or not exists (
             select 1
             from pg_catalog.pg_namespace namespace_row
             cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) acl
             join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
             where namespace_row.nspname = 'public' and grantee_role.rolname = $1::text
               and acl.privilege_type = 'USAGE' and not acl.is_grantable
           ) or not exists (
             select 1
             from pg_catalog.pg_proc routine
             cross join cleanup_function required_function
             cross join lateral pg_catalog.aclexplode(
               coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
             ) acl
             join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
             where routine.oid = required_function.oid and grantee_role.rolname = $1::text
               and acl.privilege_type = 'EXECUTE' and not acl.is_grantable
            ) or not exists (
              select 1
              from pg_catalog.pg_database database_row
              cross join lateral pg_catalog.aclexplode(database_row.datacl) acl
              join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
              where database_row.datname = pg_catalog.current_database()
                and grantee_role.rolname = $1::text
                and acl.privilege_type = 'CONNECT'
                and not acl.is_grantable
            ) or not pg_catalog.has_database_privilege(
              $2::text, pg_catalog.current_database(), 'CONNECT'
            ) or not pg_catalog.has_function_privilege($1::text, $3::text, 'EXECUTE')
              or not pg_catalog.has_function_privilege($2::text, $3::text, 'EXECUTE')
         ) as "missingCleanupAuthority"`,
      [
        STORAGE_CLEANUP_GROUP,
        config.storageCleanupUser,
        STORAGE_CLEANUP_FUNCTION,
        config.ownerUser
      ]
    );
    const cleanupSafetyRow = cleanupSafety.rows[0] as {
      unsafeCleanupMembership?: unknown;
      unsafeCleanupOwnership?: unknown;
      unsafeCleanupAcl?: unknown;
      unsafeCleanupRoleSetting?: unknown;
      unsafeCleanupEffectiveAuthority?: unknown;
      missingCleanupAuthority?: unknown;
    } | undefined;
    if (cleanupSafetyRow?.unsafeCleanupMembership !== false ||
      cleanupSafetyRow.unsafeCleanupOwnership !== false ||
      cleanupSafetyRow.unsafeCleanupAcl !== false ||
      cleanupSafetyRow.unsafeCleanupRoleSetting !== false ||
      cleanupSafetyRow.unsafeCleanupEffectiveAuthority !== false ||
      cleanupSafetyRow.missingCleanupAuthority !== false) {
      throw new Error('Unsafe storage cleanup database authority requires operator remediation');
    }
    await client.query(
      `REVOKE ALL ON FUNCTION "public"."resolve_financial_issue_after_worker_recompute"(uuid,text) FROM ${web}, ${worker}`
    );
    await client.query(
      `REVOKE ALL ON FUNCTION "public"."rearm_pending_stripe_event_job"(uuid) FROM ${web}, ${worker}`
    );
    await client.query(`REVOKE CREATE ON SCHEMA "public" FROM ${web}, ${worker}`);
    await client.query(
      `REVOKE ALL ON FUNCTION "public"."storage_cleanup_referenced_keys"(text[]) FROM ${web}, ${worker}, ${storageCleanup}`
    );
    await client.query(`REVOKE CREATE ON SCHEMA "public" FROM ${storageCleanup}`);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  }
}
