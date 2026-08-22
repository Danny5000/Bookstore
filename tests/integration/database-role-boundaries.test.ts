import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  createPostgresJobRepository,
  enqueueJobReference
} from '$lib/server/jobs/repository';
import {
  loadDatabaseRoleProvisionConfig,
  provisionDatabaseRoles
} from '$lib/server/db/database-role-provision';
import {
  databaseClient,
  applicationConfig,
  ownerDatabaseClient,
  storageCleanupDatabaseClient,
  workerDatabaseClient
} from './database';

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
  'stripe_payouts',
  'payments',
  'refunds',
  'refund_allocations',
  'disputes'
] as const;

const financialWorkerInsertTables = new Set([
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
]);

const financialWorkerUpdateTables = new Set([
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
]);

const orderWebInsertColumns = [
  'initiating_user_id', 'purchase_email', 'currency', 'subtotal_minor',
  'client_checkout_attempt_id', 'quote_fingerprint_sha256', 'status_token_sha256'
] as const;
const orderWebUpdateColumns = [
  'status', 'stripe_checkout_session_id', 'checkout_expires_at', 'updated_at'
] as const;
const orderItemWebInsertColumns = [
  'order_id', 'title_id', 'title_snapshot', 'creator_name_snapshot', 'format',
  'currency', 'unit_subtotal_minor'
] as const;
const jobWebInsertColumns = [
  'type', 'payload', 'deduplication_key', 'run_at', 'max_attempts'
] as const;
const outboxWebInsertColumns = [
  'id', 'topic', 'payload', 'deduplication_key', 'dispatch_job_id'
] as const;
const outboxWorkerUpdateColumns = [
  'status', 'last_error', 'delivered_at', 'updated_at'
] as const;
const reconciliationWorkerLockColumns = new Map([
  ['refund_allocations', ['id']],
  ['refund_allocation_components', ['id']],
  ['refund_reporting_correction_sets', ['id']],
  ['refund_reporting_correction_items', ['id']],
  ['dispute_item_allocations', ['id']],
  ['stripe_payout_balance_transactions', ['id']],
  ['stripe_balance_transaction_fee_details', ['id']],
  ['financial_classification_versions', ['id']],
  ['financial_allocation_sets', ['id']],
  ['financial_item_allocations', ['id']],
  ['payout_import_run_entries', ['id']]
] as const);
const refundDraftWorkerUpdateColumns = [
  'state', 'version', 'updated_by_admin_id', 'updated_correlation_id',
  'updated_at', 'finalized_at', 'discarded_at'
] as const;
const refundDraftItemWorkerUpdateColumns = [
  'proposed_total_presentment_minor', 'updated_at'
] as const;
const financialAdminCommandWorkerUpdateColumns = [
  'status', 'safe_result_code', 'safe_result', 'updated_at', 'completed_at'
] as const;
const outboxWebSelectColumns = [
  'id', 'topic', 'deduplication_key', 'dispatch_job_id', 'status', 'last_error',
  'delivered_at', 'created_at', 'updated_at'
] as const;
const titleRevisionWebInsertColumns = [
  'title_id', 'parent_revision_id', 'created_by_actor_id', 'change_summary',
  'staging_storage_key', 'staging_checksum_sha256', 'staging_byte_size',
  'upload_filename', 'upload_mime_type'
] as const;
const titleRevisionWebUpdateColumns = [
  'state', 'staging_storage_key', 'ingestion_generation', 'processing_started_at',
  'processed_at', 'failure_code', 'failure_details', 'activated_at', 'retired_at'
] as const;
const workerDerivedCatalogTables = [
  'prose_sections', 'prose_images', 'prose_blocks', 'comic_pages',
  'revision_cover_suggestions', 'revision_ingestion_warnings'
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
  'commerce-worker', 'financial-worker', 'publication-ingestion-worker'
] as const;

async function columnPrivileges(
  pool: Pool,
  table: string,
  privilege: 'INSERT' | 'SELECT' | 'UPDATE'
) {
  return (await pool.query<{ column_name: string }>(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = $1
      and has_column_privilege(format('public.%I', $1), column_name, $2)
    order by ordinal_position
  `, [table, privilege])).rows.map((row) => row.column_name);
}

async function insertTitle(id: string): Promise<void> {
  await ownerDatabaseClient.pool.query(`
    insert into titles (id, slug, title, description, creator_name, format, price_minor, currency)
    values ($1, $2, 'Role boundary title', 'Role boundary description', 'Boundary Author',
      'prose', 1200, 'USD')
  `, [id, `role-boundary-${id.slice(-4)}`]);
}

async function waitForFinancialAdminLeaseWriter(
  pool: Pool,
  jobId: string
): Promise<{ shared_granted: number; exclusive_waiting: number }> {
  for (let poll = 0; poll < 200; poll += 1) {
    const state = (await pool.query<{
      shared_granted: number;
      exclusive_waiting: number;
    }>(`
      with lease_key as (
        select hashtextextended(
          'pale-orbit:plan6bii-financial-admin-job-lease:' || $1::uuid::text, 0
        ) as value
      )
      select
        count(*) filter (
          where lease.mode = 'ShareLock' and lease.granted
        )::integer as shared_granted,
        count(*) filter (
          where lease.mode = 'ExclusiveLock' and not lease.granted
        )::integer as exclusive_waiting
      from pg_catalog.pg_locks lease
      cross join lease_key
      where lease.locktype = 'advisory'
        and lease.classid::bigint =
          ((lease_key.value >> 32) & 4294967295::bigint)
        and lease.objid::bigint =
          (lease_key.value & 4294967295::bigint)
    `, [jobId])).rows[0]!;
    if (state.shared_granted >= 1 && state.exclusive_waiting >= 1) return state;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('financial administrator lease writer did not block behind a reader');
}

async function financialPrivileges(pool: Pool) {
  return (await pool.query<{
    table_name: string;
    can_select: boolean;
    can_insert: boolean;
    can_update: boolean;
    can_delete: boolean;
  }>(`
    select table_name,
      has_table_privilege(format('public.%I', table_name), 'SELECT') as can_select,
      has_table_privilege(format('public.%I', table_name), 'INSERT') as can_insert,
      has_table_privilege(format('public.%I', table_name), 'UPDATE') as can_update,
      has_table_privilege(format('public.%I', table_name), 'DELETE') as can_delete
    from unnest($1::text[]) table_name
    order by table_name
  `, [financialWorkerWriteTables])).rows;
}

async function expectRoleProvisionRejected(): Promise<void> {
  const connection = await ownerDatabaseClient.pool.connect();
  try {
    const config = loadDatabaseRoleProvisionConfig(process.env);
    await expect(provisionDatabaseRoles({
      query: async (text, values) => connection.query(
        text, values === undefined ? undefined : [...values]
      )
    }, config)).rejects.toThrow(/unsafe existing database login authority/iu);
  } finally {
    connection.release();
  }
}

async function expectUnexpectedNamedAuthorityProvisionRejected(): Promise<void> {
  const connection = await ownerDatabaseClient.pool.connect();
  try {
    const config = loadDatabaseRoleProvisionConfig(process.env);
    await expect(provisionDatabaseRoles({
      query: async (text, values) => connection.query(
        text, values === undefined ? undefined : [...values]
      )
    }, config)).rejects.toThrow(/unexpected named database authority/iu);
  } finally {
    connection.release();
  }
}

async function runRoleProvision(): Promise<void> {
  const connection = await ownerDatabaseClient.pool.connect();
  try {
    await provisionDatabaseRoles({
      query: async (text, values) => connection.query(
        text, values === undefined ? undefined : [...values]
      )
    }, loadDatabaseRoleProvisionConfig(process.env));
  } finally {
    connection.release();
  }
}

async function expectStorageCleanupProvisionRejected(): Promise<void> {
  const connection = await ownerDatabaseClient.pool.connect();
  try {
    const config = loadDatabaseRoleProvisionConfig(process.env);
    await expect(provisionDatabaseRoles({
      query: async (text, values) => connection.query(
        text, values === undefined ? undefined : [...values]
      )
    }, config)).rejects.toThrow(/unsafe storage cleanup database authority/iu);
  } finally {
    connection.release();
  }
}

describe('database runtime role boundaries', () => {
  it('keeps financial DML worker-only while preserving web reads and intake writes', async () => {
    const webPrivileges = await financialPrivileges(databaseClient.pool);
    const workerPrivileges = await financialPrivileges(workerDatabaseClient.pool);

    expect(webPrivileges).toHaveLength(financialWorkerWriteTables.length);
    expect(webPrivileges.every((row) =>
      row.can_select && !row.can_insert && !row.can_update && !row.can_delete
    )).toBe(true);
    expect(workerPrivileges.every((row) =>
      row.can_select &&
      row.can_insert === financialWorkerInsertTables.has(row.table_name) &&
      row.can_update === financialWorkerUpdateTables.has(row.table_name) &&
      !row.can_delete
    )).toBe(true);

    const intake = await databaseClient.pool.query<{
      stripe_events_table_insert: boolean;
      stripe_events_provider_id_insert: boolean;
      stripe_events_status_insert: boolean;
      jobs_insert: boolean;
    }>(`
      select has_table_privilege('public.stripe_events', 'INSERT') as stripe_events_table_insert,
        has_column_privilege('public.stripe_events', 'provider_event_id', 'INSERT')
          as stripe_events_provider_id_insert,
        has_column_privilege('public.stripe_events', 'status', 'INSERT')
          as stripe_events_status_insert,
        has_table_privilege('public.jobs', 'INSERT') as jobs_insert
    `);
    expect(intake.rows).toEqual([{
      stripe_events_table_insert: false,
      stripe_events_provider_id_insert: true,
      stripe_events_status_insert: false,
      jobs_insert: false
    }]);
    const workerEventPrivileges = await workerDatabaseClient.pool.query<{
      can_update: boolean;
      can_delete: boolean;
    }>(`
      select has_table_privilege('public.stripe_events', 'UPDATE') as can_update,
        has_table_privilege('public.stripe_events', 'DELETE') as can_delete
    `);
    expect(workerEventPrivileges.rows).toEqual([{ can_update: true, can_delete: false }]);

    const projectionViewPrivileges = await databaseClient.pool.query<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(`
      select table_name,
        has_table_privilege(format('public.%I', table_name), 'SELECT') as can_select,
        has_table_privilege(format('public.%I', table_name), 'INSERT') as can_insert,
        has_table_privilege(format('public.%I', table_name), 'UPDATE') as can_update,
        has_table_privilege(format('public.%I', table_name), 'DELETE') as can_delete
      from unnest(array[
        'current_financial_projection_heads', 'current_financial_projection_items'
      ]) table_name
      order by table_name
    `);
    expect(projectionViewPrivileges.rows.every((row) =>
      row.can_select && !row.can_insert && !row.can_update && !row.can_delete
    )).toBe(true);
  });

  it('removes PUBLIC object authority without revoking normal database access', async () => {
    const authority = await ownerDatabaseClient.pool.query<{
      public_object_authority: boolean;
      public_default_authority: boolean;
      public_database_privileges: string[];
      public_pg_settings_update: boolean;
    }>(`
      select exists (
          select 1
          from pg_catalog.pg_namespace namespace_row
          cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) acl
          where namespace_row.nspname = 'public' and acl.grantee = 0
          union all
          select 1
          from pg_catalog.pg_class relation_row
          join pg_catalog.pg_namespace namespace_row
            on namespace_row.oid = relation_row.relnamespace
          cross join lateral pg_catalog.aclexplode(relation_row.relacl) acl
          where namespace_row.nspname = 'public' and acl.grantee = 0
          union all
          select 1
          from pg_catalog.pg_attribute attribute_row
          join pg_catalog.pg_class relation_row on relation_row.oid = attribute_row.attrelid
          join pg_catalog.pg_namespace namespace_row
            on namespace_row.oid = relation_row.relnamespace
          cross join lateral pg_catalog.aclexplode(attribute_row.attacl) acl
          where namespace_row.nspname = 'public' and acl.grantee = 0
          union all
          select 1
          from pg_catalog.pg_proc function_row
          join pg_catalog.pg_namespace namespace_row
            on namespace_row.oid = function_row.pronamespace
          cross join lateral pg_catalog.aclexplode(
            coalesce(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
          ) acl
          where namespace_row.nspname = 'public' and acl.grantee = 0
        ) as public_object_authority,
        exists (
          select 1
          from pg_catalog.pg_default_acl default_row
          cross join lateral pg_catalog.aclexplode(default_row.defaclacl) acl
          where acl.grantee = 0
        ) as public_default_authority,
        array(
          select acl.privilege_type
          from pg_catalog.pg_database database_row
          cross join lateral pg_catalog.aclexplode(
            coalesce(database_row.datacl, pg_catalog.acldefault('d', database_row.datdba))
          ) acl
          where database_row.datname = pg_catalog.current_database() and acl.grantee = 0
          order by acl.privilege_type
        ) as public_database_privileges,
        exists (
          select 1
          from pg_catalog.pg_class relation_row
          join pg_catalog.pg_namespace namespace_row
            on namespace_row.oid = relation_row.relnamespace
          cross join lateral pg_catalog.aclexplode(relation_row.relacl) acl
          where namespace_row.nspname = 'pg_catalog'
            and relation_row.relname = 'pg_settings'
            and acl.grantee = 0 and acl.privilege_type = 'UPDATE'
            and not acl.is_grantable
        ) as public_pg_settings_update
    `);
    expect(authority.rows).toEqual([{
      public_object_authority: false,
      public_default_authority: false,
      public_database_privileges: ['CONNECT', 'TEMPORARY'],
      public_pg_settings_update: true
    }]);
    await expect(databaseClient.pool.query("set session_replication_role = 'replica'"))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('grants non-grantable CONNECT directly to each fixed group and effectively to each login', async () => {
    const config = loadDatabaseRoleProvisionConfig(process.env);
    const authority = await ownerDatabaseClient.pool.query<{
      direct_connect_groups: string[];
      grantable_connect_groups: string[];
      web_can_connect: boolean;
      worker_can_connect: boolean;
      cleanup_can_connect: boolean;
    }>(`
      select array(
          select grantee_role.rolname::text
          from pg_catalog.pg_database database_row
          cross join lateral pg_catalog.aclexplode(database_row.datacl) acl
          join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
          where database_row.datname = pg_catalog.current_database()
            and grantee_role.rolname = any($1::text[])
            and acl.privilege_type = 'CONNECT' and not acl.is_grantable
          order by grantee_role.rolname
        ) as direct_connect_groups,
        array(
          select grantee_role.rolname::text
          from pg_catalog.pg_database database_row
          cross join lateral pg_catalog.aclexplode(database_row.datacl) acl
          join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
          where database_row.datname = pg_catalog.current_database()
            and grantee_role.rolname = any($1::text[])
            and acl.privilege_type = 'CONNECT' and acl.is_grantable
          order by grantee_role.rolname
        ) as grantable_connect_groups,
        pg_catalog.has_database_privilege(
          $2::text, pg_catalog.current_database(), 'CONNECT'
        ) as web_can_connect,
        pg_catalog.has_database_privilege(
          $3::text, pg_catalog.current_database(), 'CONNECT'
        ) as worker_can_connect,
        pg_catalog.has_database_privilege(
          $4::text, pg_catalog.current_database(), 'CONNECT'
        ) as cleanup_can_connect
    `, [[
      'pale_orbit_runtime', 'pale_orbit_financial_worker', 'pale_orbit_storage_cleanup'
    ], config.webUser, config.workerUser, config.storageCleanupUser]);

    expect(authority.rows).toEqual([{
      direct_connect_groups: [
        'pale_orbit_financial_worker', 'pale_orbit_runtime', 'pale_orbit_storage_cleanup'
      ],
      grantable_connect_groups: [],
      web_can_connect: true,
      worker_can_connect: true,
      cleanup_can_connect: true
    }]);
  });

  it('gives the cleanup login only its exact inherited reference-check authority', async () => {
    const authority = await storageCleanupDatabaseClient.pool.query<{
      schema_usage: boolean;
      schema_create: boolean;
      routine_execute: boolean;
      relation_authority: boolean;
      column_authority: boolean;
      sequence_authority: boolean;
      other_routine_authority: boolean;
    }>(`
      select
        has_schema_privilege('public', 'USAGE') as schema_usage,
        has_schema_privilege('public', 'CREATE') as schema_create,
        has_function_privilege(
          'public.storage_cleanup_referenced_keys(text[])', 'EXECUTE'
        ) as routine_execute,
        exists (
          select 1
          from pg_catalog.pg_class relation_row
          join pg_catalog.pg_namespace namespace_row
            on namespace_row.oid = relation_row.relnamespace
          cross join unnest(array[
            'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
            'REFERENCES', 'TRIGGER', 'MAINTAIN'
          ]::text[]) privilege(privilege_name)
          where namespace_row.nspname = 'public'
            and relation_row.relkind in ('r', 'p', 'v', 'm', 'f')
            and has_table_privilege(relation_row.oid, privilege.privilege_name)
        ) as relation_authority,
        exists (
          select 1
          from pg_catalog.pg_class relation_row
          join pg_catalog.pg_namespace namespace_row
            on namespace_row.oid = relation_row.relnamespace
          cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[])
            privilege(privilege_name)
          where namespace_row.nspname = 'public'
            and relation_row.relkind in ('r', 'p', 'v', 'm', 'f')
            and has_any_column_privilege(relation_row.oid, privilege.privilege_name)
        ) as column_authority,
        exists (
          select 1
          from pg_catalog.pg_class sequence_row
          join pg_catalog.pg_namespace namespace_row
            on namespace_row.oid = sequence_row.relnamespace
          cross join unnest(array['SELECT', 'USAGE', 'UPDATE']::text[])
            privilege(privilege_name)
          where namespace_row.nspname = 'public' and sequence_row.relkind = 'S'
            and has_sequence_privilege(sequence_row.oid, privilege.privilege_name)
        ) as sequence_authority,
        exists (
          select 1
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace_row on namespace_row.oid = routine.pronamespace
          where namespace_row.nspname = 'public'
            and routine.oid <> to_regprocedure(
              'public.storage_cleanup_referenced_keys(text[])'
            )
            and has_function_privilege(routine.oid, 'EXECUTE')
        ) as other_routine_authority
    `);
    expect(authority.rows).toEqual([{
      schema_usage: true,
      schema_create: false,
      routine_execute: true,
      relation_authority: false,
      column_authority: false,
      sequence_authority: false,
      other_routine_authority: false
    }]);

    const membership = await ownerDatabaseClient.pool.query(`
      select granted.rolname as granted_role, member.rolname as member_role,
        membership.admin_option, membership.inherit_option, membership.set_option
      from pg_catalog.pg_auth_members membership
      join pg_catalog.pg_roles granted on granted.oid = membership.roleid
      join pg_catalog.pg_roles member on member.oid = membership.member
      where granted.rolname = 'pale_orbit_storage_cleanup'
         or member.rolname = 'pale_orbit_storage_cleanup'
         or granted.rolname = $1
         or member.rolname = $1
      order by granted.rolname, member.rolname
    `, [loadDatabaseRoleProvisionConfig(process.env).storageCleanupUser]);
    expect(membership.rows).toEqual([{
      granted_role: 'pale_orbit_storage_cleanup',
      member_role: loadDatabaseRoleProvisionConfig(process.env).storageCleanupUser,
      admin_option: false,
      inherit_option: true,
      set_option: false
    }]);

    await expect(storageCleanupDatabaseClient.pool.query('select * from public.titles limit 1'))
      .rejects.toMatchObject({ code: '42501' });
    const candidate = `staging/uploads/${randomUUID()}`;
    for (const pool of [databaseClient.pool, workerDatabaseClient.pool]) {
      await expect(pool.query(
        'select * from public.storage_cleanup_referenced_keys($1::text[])',
        [[candidate]]
      )).rejects.toMatchObject({ code: '42501' });
    }
    await ownerDatabaseClient.pool.query(
      `grant execute on function public.storage_cleanup_referenced_keys(text[])
        to pale_orbit_runtime`
    );
    try {
      await expect(databaseClient.pool.query(
        'select * from public.storage_cleanup_referenced_keys($1::text[])',
        [[candidate]]
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ownerDatabaseClient.pool.query(
        `revoke execute on function public.storage_cleanup_referenced_keys(text[])
          from pale_orbit_runtime`
      );
    }
  });

  it('rejects malformed, ambiguous, or oversized cleanup candidate arrays', async () => {
    const canonical = `staging/uploads/${randomUUID()}`;
    const candidateTitleId = randomUUID();
    const candidateRevisionId = randomUUID();
    const canonicalKeys = [
      canonical,
      `health/probes/${randomUUID()}`,
      `titles/${candidateTitleId}/covers/${randomUUID()}.webp`,
      `titles/${candidateTitleId}/revisions/${candidateRevisionId}/derived/v1/prose-images/${randomUUID()}.webp`,
      `titles/${candidateTitleId}/revisions/${candidateRevisionId}/derived/v1/generations/2147483647/cover-suggestions/${randomUUID()}.webp`
    ];
    const invoke = (candidates: Array<string | null> | null) =>
      storageCleanupDatabaseClient.pool.query(
        'select * from public.storage_cleanup_referenced_keys($1::text[])',
        [candidates]
      );
    await expect(invoke([])).resolves.toMatchObject({ rows: [] });
    await expect(invoke(canonicalKeys)).resolves.toMatchObject({ rows: [] });
    await expect(invoke(Array.from(
      { length: 500 },
      () => `health/probes/${randomUUID()}`
    ))).resolves.toMatchObject({ rows: [] });
    for (const candidates of [
      null,
      [null],
      [canonical, canonical],
      Array.from({ length: 501 }, () => `staging/uploads/${randomUUID()}`),
      [`staging/uploads/not-a-uuid`],
      [`health/probes/not-a-uuid`],
      [`health/probes/${randomUUID().toUpperCase()}`],
      [`staging/uploads/${randomUUID()}\n`],
      [`titles/${randomUUID()}/revisions/${randomUUID()}/original`],
      [`titles/${randomUUID()}/revisions/${randomUUID()}/derived/v1/arbitrary`],
      [`titles/${randomUUID()}/revisions/${randomUUID()}/derived/v1/generations/01/prose-images/${randomUUID()}.webp`],
      [`titles/${randomUUID()}/revisions/${randomUUID()}/derived/v1/generations/2147483648/prose-images/${randomUUID()}.webp`]
    ] as Array<Array<string | null> | null>) {
      await expect(invoke(candidates)).rejects.toMatchObject({ code: '22023' });
    }
    const dimensionalCandidates = Array.from({ length: 4 }, () => (
      `staging/uploads/${randomUUID()}`
    ));
    await expect(storageCleanupDatabaseClient.pool.query(
      `select * from public.storage_cleanup_referenced_keys(
        array[
          array[$1::text, $2::text],
          array[$3::text, $4::text]
        ]
      )`,
      dimensionalCandidates
    )).rejects.toMatchObject({ code: '22023' });
  });

  it('rejects cleanup routine ownership by an arbitrary third role', async () => {
    const driftRole = `pale_orbit_cleanup_drift_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const quotedDriftRole = `"${driftRole}"`;
    const config = loadDatabaseRoleProvisionConfig(process.env);
    const quotedOwner = `"${config.ownerUser.replaceAll('"', '""')}"`;
    await ownerDatabaseClient.pool.query(`create role ${quotedDriftRole} with nologin`);
    try {
      await ownerDatabaseClient.pool.query(
        `alter function public.storage_cleanup_referenced_keys(text[]) owner to ${quotedDriftRole}`
      );
      await expectUnexpectedNamedAuthorityProvisionRejected();
    } finally {
      await ownerDatabaseClient.pool.query(
        `alter function public.storage_cleanup_referenced_keys(text[]) owner to ${quotedOwner}`
      );
      await ownerDatabaseClient.pool.query(`drop role ${quotedDriftRole}`);
    }
  });

  it('reserves worker audit actions and identities from the web credential', async () => {
    for (const [index, action] of [
      'financial.role_boundary_forgery', ...workerOnlyAuditActions
    ].entries()) {
      await expect(databaseClient.pool.query(`
        insert into audit_events (
          actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id
        ) values ('system', 'web-boundary', $1, 'succeeded', 'role_boundary', $2, $3)
      `, [action, `action-${index}`, `audit-action-boundary-${index}`]))
        .rejects.toMatchObject({ code: '55000' });
    }
    for (const [index, actorId] of workerAuditActorIds.entries()) {
      await expect(databaseClient.pool.query(`
        insert into audit_events (
          actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id
        ) values ('system', $1, 'role_boundary.audit', 'succeeded', 'role_boundary', $2, $3)
      `, [actorId, `actor-${index}`, `audit-actor-boundary-${index}`]))
        .rejects.toMatchObject({ code: '55000' });
    }
    await expect(databaseClient.pool.query(`
      insert into audit_events (
        actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id
      ) values (
        'system', 'web-boundary', 'role_boundary.audit', 'succeeded',
        'role_boundary', 'web-allowed', 'audit-web-allowed'
      )
    `)).resolves.toMatchObject({ rowCount: 1 });
    await expect(workerDatabaseClient.pool.query(`
      insert into audit_events (
        actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id
      ) values (
        'system', 'financial-worker', 'financial.issue.opened', 'succeeded',
        'financial_issue', 'worker-allowed', 'audit-worker-allowed'
      )
    `)).resolves.toMatchObject({ rowCount: 1 });
  });

  it('pins guest-claim and outbox authority without exposing claim or payload data', async () => {
    expect((await columnPrivileges(databaseClient.pool, 'outbox_messages', 'SELECT')).sort())
      .toEqual([...outboxWebSelectColumns].sort());
    expect(await columnPrivileges(workerDatabaseClient.pool, 'outbox_messages', 'SELECT'))
      .toContain('payload');
    expect(await columnPrivileges(databaseClient.pool, 'commerce_claim_issuances', 'SELECT'))
      .toEqual([]);
    expect(await columnPrivileges(
      workerDatabaseClient.pool, 'commerce_claim_issuances', 'SELECT'
    )).toEqual([]);

    const webTables = await databaseClient.pool.query<{
      guest_table_insert: boolean;
      guest_email_insert: boolean;
      guest_claim_insert: boolean;
      guest_update: boolean;
      guest_delete: boolean;
      grants_insert: boolean;
      grants_update: boolean;
      entitlements_insert: boolean;
      entitlements_update: boolean;
      issuance_insert: boolean;
      issuance_update: boolean;
      issuance_delete: boolean;
    }>(`
      select has_table_privilege('public.guest_identities', 'INSERT') as guest_table_insert,
        has_column_privilege('public.guest_identities', 'email', 'INSERT')
          as guest_email_insert,
        has_column_privilege('public.guest_identities', 'claimed_by_user_id', 'INSERT')
          as guest_claim_insert,
        has_table_privilege('public.guest_identities', 'UPDATE') as guest_update,
        has_table_privilege('public.guest_identities', 'DELETE') as guest_delete,
        has_table_privilege('public.entitlement_grants', 'INSERT') as grants_insert,
        has_table_privilege('public.entitlement_grants', 'UPDATE') as grants_update,
        has_table_privilege('public.entitlements', 'INSERT') as entitlements_insert,
        has_table_privilege('public.entitlements', 'UPDATE') as entitlements_update,
        has_table_privilege('public.commerce_claim_issuances', 'INSERT') as issuance_insert,
        has_table_privilege('public.commerce_claim_issuances', 'UPDATE') as issuance_update,
        has_table_privilege('public.commerce_claim_issuances', 'DELETE') as issuance_delete
    `);
    expect(webTables.rows).toEqual([{
      guest_table_insert: false,
      guest_email_insert: true,
      guest_claim_insert: false,
      guest_update: false,
      guest_delete: false,
      grants_insert: false,
      grants_update: false,
      entitlements_insert: false,
      entitlements_update: false,
      issuance_insert: false,
      issuance_update: false,
      issuance_delete: false
    }]);

    const workerTables = await workerDatabaseClient.pool.query<{
      guest_table_insert: boolean;
      guest_email_insert: boolean;
      guest_update: boolean;
      guest_delete: boolean;
      grants_insert: boolean;
      grants_update: boolean;
      grants_delete: boolean;
      entitlements_insert: boolean;
      entitlements_update: boolean;
      entitlements_delete: boolean;
      issuance_insert: boolean;
      issuance_update: boolean;
      issuance_delete: boolean;
    }>(`
      select has_table_privilege('public.guest_identities', 'INSERT') as guest_table_insert,
        has_column_privilege('public.guest_identities', 'email', 'INSERT')
          as guest_email_insert,
        has_table_privilege('public.guest_identities', 'UPDATE') as guest_update,
        has_table_privilege('public.guest_identities', 'DELETE') as guest_delete,
        has_table_privilege('public.entitlement_grants', 'INSERT') as grants_insert,
        has_table_privilege('public.entitlement_grants', 'UPDATE') as grants_update,
        has_table_privilege('public.entitlement_grants', 'DELETE') as grants_delete,
        has_table_privilege('public.entitlements', 'INSERT') as entitlements_insert,
        has_table_privilege('public.entitlements', 'UPDATE') as entitlements_update,
        has_table_privilege('public.entitlements', 'DELETE') as entitlements_delete,
        has_table_privilege('public.commerce_claim_issuances', 'INSERT') as issuance_insert,
        has_table_privilege('public.commerce_claim_issuances', 'UPDATE') as issuance_update,
        has_table_privilege('public.commerce_claim_issuances', 'DELETE') as issuance_delete
    `);
    expect(workerTables.rows).toEqual([{
      guest_table_insert: false,
      guest_email_insert: true,
      guest_update: false,
      guest_delete: false,
      grants_insert: true,
      grants_update: true,
      grants_delete: false,
      entitlements_insert: true,
      entitlements_update: true,
      entitlements_delete: false,
      issuance_insert: false,
      issuance_update: false,
      issuance_delete: false
    }]);

    const runtimeFunctions = [
      'public.authorize_commerce_claim_issuance(text,text)',
      'public.claim_guest_purchases_after_authorization(text,text)',
      'public.outbox_message_exists_by_deduplication_key(text)',
      'public.outbox_message_deduplication_metadata(text,text,jsonb)'
    ];
    const workerFunctions = [
      'public.register_commerce_claim_issuance(text,text,text,uuid,text,timestamp with time zone)',
      'public.purge_commerce_claim_issuances()'
    ];
    for (const signature of runtimeFunctions) {
      await expect(databaseClient.pool.query(
        'select has_function_privilege($1, \'EXECUTE\') as allowed', [signature]
      )).resolves.toMatchObject({ rows: [{ allowed: true }] });
      await expect(workerDatabaseClient.pool.query(
        'select has_function_privilege($1, \'EXECUTE\') as allowed', [signature]
      )).resolves.toMatchObject({ rows: [{ allowed: true }] });
    }
    for (const signature of workerFunctions) {
      await expect(databaseClient.pool.query(
        'select has_function_privilege($1, \'EXECUTE\') as allowed', [signature]
      )).resolves.toMatchObject({ rows: [{ allowed: false }] });
      await expect(workerDatabaseClient.pool.query(
        'select has_function_privilege($1, \'EXECUTE\') as allowed', [signature]
      )).resolves.toMatchObject({ rows: [{ allowed: true }] });
    }
  });

  it('pins exact administrator-command, job-reference, and routine authority', async () => {
    expect(await columnPrivileges(databaseClient.pool, 'financial_admin_commands', 'SELECT'))
      .toEqual([]);
    expect(await columnPrivileges(databaseClient.pool, 'financial_admin_job_claims', 'SELECT'))
      .toEqual([]);
    expect(await columnPrivileges(
      workerDatabaseClient.pool, 'financial_admin_job_claims', 'SELECT'
    )).toEqual([]);
    expect((await columnPrivileges(databaseClient.pool, 'jobs', 'SELECT')).sort())
      .toEqual(['deduplication_key', 'id']);
    expect(await columnPrivileges(workerDatabaseClient.pool, 'jobs', 'SELECT'))
      .toContain('payload');
    const jobsTriggerAuthority = await ownerDatabaseClient.pool.query<{
      role_name: string;
      can_trigger: boolean;
    }>(`
      select role_name,
        has_table_privilege(role_name, 'public.jobs', 'TRIGGER') as can_trigger
      from unnest(array[
        'public', 'pale_orbit_runtime', 'pale_orbit_financial_worker',
        'pale_orbit_storage_cleanup'
      ]::text[]) role_name
      order by role_name
    `);
    expect(jobsTriggerAuthority.rows.every((row) => !row.can_trigger)).toBe(true);
    const jobsTriggerInventory = await ownerDatabaseClient.pool.query<{
      trigger_name: string;
      enabled_mode: string;
      trigger_type: number;
      routine_name: string;
      argument_count: number;
      argument_bytes: string;
      updated_columns: string;
      has_no_qualifier: boolean;
    }>(`
      select trigger_row.tgname::text as trigger_name,
        trigger_row.tgenabled::text as enabled_mode,
        trigger_row.tgtype::integer as trigger_type,
        routine.proname::text as routine_name,
        trigger_row.tgnargs::integer as argument_count,
        encode(trigger_row.tgargs, 'hex') as argument_bytes,
        trigger_row.tgattr::text as updated_columns,
        trigger_row.tgqual is null as has_no_qualifier
      from pg_catalog.pg_trigger trigger_row
      join pg_catalog.pg_proc routine on routine.oid = trigger_row.tgfoid
      where trigger_row.tgrelid = 'public.jobs'::pg_catalog.regclass
        and not trigger_row.tgisinternal
      order by trigger_row.tgname collate "C"
    `);
    expect(jobsTriggerInventory.rows).toEqual([
      {
        trigger_name: 'jobs_plan6b_web_insert_guard',
        enabled_mode: 'O',
        trigger_type: 7,
        routine_name: 'plan6b_guard_job_insert',
        argument_count: 0,
        argument_bytes: '',
        updated_columns: '',
        has_no_qualifier: true
      },
      {
        trigger_name: 'jobs_plan6bii_financial_admin_lease_guard',
        enabled_mode: 'O',
        trigger_type: 19,
        routine_name: 'plan6bii_guard_financial_admin_job_lease',
        argument_count: 0,
        argument_bytes: '',
        updated_columns: '',
        has_no_qualifier: true
      },
      {
        trigger_name: 'jobs_plan6bii_financial_admin_terminal_sync',
        enabled_mode: 'O',
        trigger_type: 19,
        routine_name: 'plan6bii_sync_failed_financial_admin_command',
        argument_count: 0,
        argument_bytes: '',
        updated_columns: '',
        has_no_qualifier: true
      }
    ]);
    expect((await columnPrivileges(
      workerDatabaseClient.pool, 'financial_admin_commands', 'UPDATE'
    )).sort()).toEqual([...financialAdminCommandWorkerUpdateColumns].sort());

    const tableAuthority = await ownerDatabaseClient.pool.query<{
      role_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(`
      select role_name,
        has_table_privilege(role_name, 'public.financial_admin_commands', 'SELECT')
          as can_select,
        has_table_privilege(role_name, 'public.financial_admin_commands', 'INSERT')
          as can_insert,
        has_table_privilege(role_name, 'public.financial_admin_commands', 'UPDATE')
          as can_update,
        has_table_privilege(role_name, 'public.financial_admin_commands', 'DELETE')
          as can_delete
      from unnest(array[
        'pale_orbit_runtime', 'pale_orbit_financial_worker',
        'pale_orbit_storage_cleanup'
      ]::text[]) role_name
      order by role_name
    `);
    expect(tableAuthority.rows).toEqual([
      {
        role_name: 'pale_orbit_financial_worker',
        can_select: true,
        can_insert: false,
        can_update: false,
        can_delete: false
      },
      {
        role_name: 'pale_orbit_runtime',
        can_select: false,
        can_insert: false,
        can_update: false,
        can_delete: false
      },
      {
        role_name: 'pale_orbit_storage_cleanup',
        can_select: false,
        can_insert: false,
        can_update: false,
        can_delete: false
      }
    ]);

    const privateClaimAuthority = await ownerDatabaseClient.pool.query<{
      role_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(`
      select role_name,
        has_table_privilege(role_name, 'public.financial_admin_job_claims', 'SELECT')
          as can_select,
        has_table_privilege(role_name, 'public.financial_admin_job_claims', 'INSERT')
          as can_insert,
        has_table_privilege(role_name, 'public.financial_admin_job_claims', 'UPDATE')
          as can_update,
        has_table_privilege(role_name, 'public.financial_admin_job_claims', 'DELETE')
          as can_delete
      from unnest(array[
        'public', 'pale_orbit_runtime', 'pale_orbit_financial_worker',
        'pale_orbit_storage_cleanup'
      ]::text[]) role_name
      order by role_name
    `);
    expect(privateClaimAuthority.rows.every((row) =>
      !row.can_select && !row.can_insert && !row.can_update && !row.can_delete
    )).toBe(true);

    const routineAcl = await ownerDatabaseClient.pool.query<{
      role_name: string;
      execute_count: number;
    }>(`
      select coalesce(grantee.rolname, 'PUBLIC') as role_name,
        count(*)::integer as execute_count
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace_row
        on namespace_row.oid = routine.pronamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
      ) acl
      left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
      where namespace_row.nspname = 'public'
        and routine.proname = any($1::text[])
        and acl.privilege_type = 'EXECUTE'
        and (acl.grantee = 0 or grantee.rolname in (
          'pale_orbit_runtime', 'pale_orbit_financial_worker',
          'pale_orbit_storage_cleanup'
        ))
      group by coalesce(grantee.rolname, 'PUBLIC')
      order by role_name
    `, [[
      'submit_financial_admin_command',
      'financial_admin_command_status',
      'append_financial_issue_view_audit',
      'append_financial_refund_review_view_audit',
      'append_financial_payout_view_audit',
      'append_financial_sales_export_audit',
      'resolve_financial_issue_after_admin_command',
      'resolve_financial_issue_after_reporting_correction_command',
      'transition_administrative_recovery_grant_after_admin_command'
    ]]);
    expect(routineAcl.rows).toEqual([
      { role_name: 'pale_orbit_financial_worker', execute_count: 3 },
      { role_name: 'pale_orbit_runtime', execute_count: 6 }
    ]);

    const privateRoutineAcl = await ownerDatabaseClient.pool.query<{ count: number }>(`
      select count(*)::integer as count
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace_row
        on namespace_row.oid = routine.pronamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
      ) acl
      where namespace_row.nspname = 'public'
        and routine.proname in (
          'plan6bii_assert_financial_admin_job_lease',
          'plan6bii_guard_financial_admin_job_lease'
        ) and acl.grantee <> routine.proowner
    `);
    expect(privateRoutineAcl.rows).toEqual([{ count: 0 }]);
  });

  it('exposes only the exact mixed-table producer and lifecycle columns', async () => {
    const expectColumns = async (
      pool: Pool,
      table: string,
      privilege: 'INSERT' | 'UPDATE',
      expected: readonly string[]
    ) => {
      expect((await columnPrivileges(pool, table, privilege)).sort())
        .toEqual([...expected].sort());
    };
    await expectColumns(databaseClient.pool, 'orders', 'INSERT', orderWebInsertColumns);
    await expectColumns(databaseClient.pool, 'orders', 'UPDATE', orderWebUpdateColumns);
    await expectColumns(databaseClient.pool, 'order_items', 'INSERT', orderItemWebInsertColumns);
    await expectColumns(databaseClient.pool, 'jobs', 'INSERT', jobWebInsertColumns);
    await expectColumns(databaseClient.pool, 'guest_identities', 'UPDATE', ['updated_at']);
    await expectColumns(workerDatabaseClient.pool, 'guest_identities', 'UPDATE', ['updated_at']);
    await expectColumns(databaseClient.pool, 'outbox_messages', 'INSERT', outboxWebInsertColumns);
    await expectColumns(
      workerDatabaseClient.pool,
      'outbox_messages',
      'UPDATE',
      outboxWorkerUpdateColumns
    );
    for (const [table, columns] of reconciliationWorkerLockColumns) {
      await expectColumns(databaseClient.pool, table, 'UPDATE', []);
      await expectColumns(workerDatabaseClient.pool, table, 'UPDATE', columns);
    }
    await expectColumns(databaseClient.pool, 'refund_allocation_drafts', 'UPDATE', []);
    await expectColumns(
      workerDatabaseClient.pool,
      'refund_allocation_drafts',
      'UPDATE',
      refundDraftWorkerUpdateColumns
    );
    await expectColumns(databaseClient.pool, 'refund_allocation_draft_items', 'UPDATE', []);
    await expectColumns(
      workerDatabaseClient.pool,
      'refund_allocation_draft_items',
      'UPDATE',
      refundDraftItemWorkerUpdateColumns
    );
    await expectColumns(
      databaseClient.pool,
      'title_revisions',
      'INSERT',
      titleRevisionWebInsertColumns
    );
    await expectColumns(
      databaseClient.pool,
      'title_revisions',
      'UPDATE',
      titleRevisionWebUpdateColumns
    );

    const mixed = await Promise.all([
      ['orders', true], ['order_items', true], ['jobs', true], ['title_revisions', true]
    ].map(async ([table, workerCanUpdate]) => ({
      table,
      web: (await databaseClient.pool.query<{ insert: boolean; update: boolean; delete: boolean }>(`
        select has_table_privilege($1, 'INSERT') as insert,
          has_table_privilege($1, 'UPDATE') as update,
          has_table_privilege($1, 'DELETE') as delete
      `, [`public.${table}`])).rows[0],
      worker: (await workerDatabaseClient.pool.query<{
        update: boolean;
        delete: boolean;
      }>(`
        select has_table_privilege($1, 'UPDATE') as update,
          has_table_privilege($1, 'DELETE') as delete
      `, [`public.${table}`])).rows[0],
      workerCanUpdate
    })));
    expect(mixed.every(({ web }) =>
      web?.insert === false && web.update === false && web.delete === false
    )).toBe(true);
    expect(
      mixed.every(
        ({ worker, workerCanUpdate }) =>
          worker !== undefined && worker.update === workerCanUpdate && worker.delete === false
      )
    ).toBe(true);

    const outboxTables = await Promise.all([
      databaseClient.pool, workerDatabaseClient.pool
    ].map((pool) => pool.query<{ insert: boolean; update: boolean; delete: boolean }>(`
      select has_table_privilege('public.outbox_messages', 'INSERT') as insert,
        has_table_privilege('public.outbox_messages', 'UPDATE') as update,
        has_table_privilege('public.outbox_messages', 'DELETE') as delete
    `)));
    expect(outboxTables.map((result) => result.rows[0])).toEqual([
      { insert: false, update: false, delete: false },
      { insert: false, update: false, delete: false }
    ]);

    for (const table of workerDerivedCatalogTables) {
      const [web, worker] = await Promise.all([
        databaseClient.pool.query<{
          select: boolean; insert: boolean; update: boolean; delete: boolean;
        }>(`
          select has_table_privilege($1, 'SELECT') as select,
            has_table_privilege($1, 'INSERT') as insert,
            has_table_privilege($1, 'UPDATE') as update,
            has_table_privilege($1, 'DELETE') as delete
        `, [`public.${table}`]),
        workerDatabaseClient.pool.query<{
          select: boolean; insert: boolean; update: boolean; delete: boolean;
        }>(`
          select has_table_privilege($1, 'SELECT') as select,
            has_table_privilege($1, 'INSERT') as insert,
            has_table_privilege($1, 'UPDATE') as update,
            has_table_privilege($1, 'DELETE') as delete
        `, [`public.${table}`])
      ]);
      expect(web.rows[0]).toEqual({ select: true, insert: false, update: false, delete: false });
      expect(worker.rows[0]).toEqual({ select: true, insert: true, update: false, delete: true });
    }
  });

  it('lets the worker lock every lock-only financial table without permitting history mutation', async () => {
    for (const table of reconciliationWorkerLockColumns.keys()) {
      await expect(workerDatabaseClient.pool.query(
        `select id from "${table}" where false for update`
      )).resolves.toMatchObject({ rowCount: 0 });
    }

    const balanceTransactionId = randomUUID();
    const payoutId = randomUUID();
    const runId = randomUUID();
    const entryId = randomUUID();
    try {
      await ownerDatabaseClient.pool.query(`
        insert into stripe_balance_transactions (
          id, provider_id, live_mode, raw_type, reporting_category, balance_type,
          amount_minor, fee_minor, net_minor, currency, status, provider_created_at,
          available_at, fingerprint_sha256
        ) values (
          $1, $2, false, 'adjustment', 'adjustment', 'payments',
          0, 0, 0, 'USD', 'available', clock_timestamp(), clock_timestamp(), repeat('a', 64)
        )
      `, [balanceTransactionId, `txn_role_lock_${balanceTransactionId}`]);
      await ownerDatabaseClient.pool.query(`
        insert into stripe_payouts (
          id, provider_id, live_mode, amount_minor, currency, automatic, method, status,
          reconciliation_status, provider_created_at, arrival_at, retrieved_at,
          fingerprint_sha256
        ) values (
          $1, $2, false, 0, 'USD', true, 'standard', 'pending', 'in_progress',
          clock_timestamp(), clock_timestamp(), clock_timestamp(), repeat('b', 64)
        )
      `, [payoutId, `po_role_lock_${payoutId}`]);
      await ownerDatabaseClient.pool.query(`
        insert into payout_import_runs (id, payout_id, generation)
        values ($1, $2, 0)
      `, [runId, payoutId]);
      await ownerDatabaseClient.pool.query(`
        insert into payout_import_run_entries (id, run_id, balance_transaction_id)
        values ($1, $2, $3)
      `, [entryId, runId, balanceTransactionId]);

      await expect(workerDatabaseClient.pool.query(
        'select id from payout_import_run_entries where id = $1 for update',
        [entryId]
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(workerDatabaseClient.pool.query(
        'update payout_import_run_entries set id = $2 where id = $1',
        [entryId, randomUUID()]
      )).rejects.toMatchObject({ code: '55000' });
      await expect(ownerDatabaseClient.pool.query(
        'select id from payout_import_run_entries where id = $1',
        [entryId]
      )).resolves.toMatchObject({ rows: [{ id: entryId }] });
    } finally {
      const cleanup = await ownerDatabaseClient.pool.connect();
      let cleanupCommitted = false;
      try {
        await cleanup.query('begin');
        await cleanup.query("set local session_replication_role = 'replica'");
        await cleanup.query('delete from payout_import_run_entries where id = $1', [entryId]);
        await cleanup.query('delete from payout_import_runs where id = $1', [runId]);
        await cleanup.query('delete from stripe_payouts where id = $1', [payoutId]);
        await cleanup.query(
          'delete from stripe_balance_transactions where id = $1',
          [balanceTransactionId]
        );
        await cleanup.query('commit');
        cleanupCommitted = true;
      } finally {
        if (!cleanupCommitted) await cleanup.query('rollback').catch(() => undefined);
        cleanup.release();
      }
    }
  });

  it.each([
    'stripe_payout_balance_transactions',
    'stripe_balance_transactions',
    'financial_reconciliation_issues',
    'payments',
    'refunds',
    'refund_allocations',
    'disputes'
  ])('denies a web insert into %s before row validation', async (table) => {
    await expect(databaseClient.pool.query(`insert into "${table}" default values`))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('denies a web insert that forges terminal Stripe event state', async () => {
    await expect(databaseClient.pool.query(`
      insert into stripe_events (
        provider_event_id, event_type, object_id, live_mode, provider_created_at,
        raw_body_sha256, status, processed_at
      ) values (
        'evt_terminal_role_boundary', 'checkout.session.completed', 'cs_role_boundary',
        false, clock_timestamp(), repeat('a', 64), 'processed', clock_timestamp()
      )
    `)).rejects.toMatchObject({ code: '42501' });
  });

  it('guards web order creation, item attachment, and checkout-session transitions', async () => {
    const titleId = '00000000-0000-4000-8000-000000009101';
    const userId = '00000000-0000-4000-8000-000000009102';
    await insertTitle(titleId);
    await ownerDatabaseClient.pool.query(`
      insert into "user" (id, name, email, email_verified)
      values ($1, 'Boundary Buyer', 'buyer@example.com', true)
    `, [userId]);

    const order = (await databaseClient.pool.query<{ id: string }>(`
      insert into orders (
        initiating_user_id, purchase_email, currency, subtotal_minor,
        client_checkout_attempt_id, quote_fingerprint_sha256, status_token_sha256
      ) values (
        null, null, 'USD', 1200,
        '00000000-0000-4000-8000-000000009103', repeat('a', 64), repeat('b', 64)
      ) returning id
    `)).rows[0]!;
    await expect(databaseClient.pool.query(`
      insert into orders (
        initiating_user_id, purchase_email, currency, subtotal_minor,
        client_checkout_attempt_id, quote_fingerprint_sha256, status_token_sha256
      ) values (
        $1, 'attacker@example.com', 'USD', 1200,
        '00000000-0000-4000-8000-000000009104', repeat('c', 64), repeat('d', 64)
      )
    `, [userId])).rejects.toMatchObject({ code: '55000' });

    const item = (await databaseClient.pool.query<{ id: string }>(`
      insert into order_items (
        order_id, title_id, title_snapshot, creator_name_snapshot, format,
        currency, unit_subtotal_minor
      ) values ($1, $2, 'Role boundary title', 'Boundary Author', 'prose', 'USD', 1200)
      returning id
    `, [order.id, titleId])).rows[0]!;
    await expect(databaseClient.pool.query(`
      insert into order_items (
        order_id, title_id, title_snapshot, creator_name_snapshot, format,
        currency, unit_subtotal_minor, tax_minor
      ) values ($1, $2, 'Forged', 'Forged', 'prose', 'USD', 1200, 10)
    `, [order.id, titleId])).rejects.toMatchObject({ code: '42501' });

    await expect(databaseClient.pool.query(`
      update orders
      set status = 'checkout_open', stripe_checkout_session_id = 'cs_boundary_9101',
        checkout_expires_at = clock_timestamp() + interval '30 minutes',
        updated_at = clock_timestamp()
      where id = $1
    `, [order.id])).resolves.toMatchObject({ rowCount: 1 });
    await expect(databaseClient.pool.query(`
      insert into order_items (
        order_id, title_id, title_snapshot, creator_name_snapshot, format,
        currency, unit_subtotal_minor
      ) values ($1, $2, 'Late item', 'Boundary Author', 'prose', 'USD', 1200)
    `, [order.id, titleId])).rejects.toMatchObject({ code: '55000' });
    await expect(databaseClient.pool.query(`
      update orders set status = 'paid', updated_at = clock_timestamp() where id = $1
    `, [order.id])).rejects.toMatchObject({ code: '55000' });
    await expect(databaseClient.pool.query(`
      update orders set subtotal_minor = 1 where id = $1
    `, [order.id])).rejects.toMatchObject({ code: '42501' });
    await expect(databaseClient.pool.query('delete from orders where id = $1', [order.id]))
      .rejects.toMatchObject({ code: '42501' });

    await expect(workerDatabaseClient.pool.query(`
      update orders set tax_minor = 0, total_minor = subtotal_minor where id = $1
    `, [order.id])).resolves.toMatchObject({ rowCount: 1 });
    await expect(workerDatabaseClient.pool.query(`
      update order_items set tax_minor = 0, total_minor = unit_subtotal_minor where id = $1
    `, [item.id])).resolves.toMatchObject({ rowCount: 1 });
  });

  it('admits only the four canonical web job families and lets worker producers bypass them', async () => {
    const titleId = '00000000-0000-4000-8000-000000009201';
    const guestId = '00000000-0000-4000-8000-000000009202';
    const claimOrderId = '00000000-0000-4000-8000-000000009203';
    const outboxId = '00000000-0000-4000-8000-000000009204';
    await insertTitle(titleId);
    await ownerDatabaseClient.pool.query(`
      insert into guest_identities (id, email) values ($1, 'guest@example.com')
    `, [guestId]);
    await ownerDatabaseClient.pool.query(`
      insert into orders (
        id, status, initiating_user_id, guest_identity_id, purchase_email, currency,
        subtotal_minor, tax_minor, total_minor, client_checkout_attempt_id,
        quote_fingerprint_sha256, status_token_sha256, paid_at
      ) values (
        $1, 'paid', null, $2, 'guest@example.com', 'USD', 1200, 0, 1200,
        '00000000-0000-4000-8000-000000009205', repeat('e', 64), repeat('f', 64),
        clock_timestamp()
      )
    `, [claimOrderId, guestId]);
    const stripeEvent = (await databaseClient.pool.query<{ id: string }>(`
      insert into stripe_events (
        provider_event_id, event_type, object_id, live_mode, api_version,
        provider_created_at, raw_body_sha256
      ) values (
        'evt_job_boundary_9201', 'checkout.session.completed', 'cs_job_boundary_9201',
        false, null, clock_timestamp(), repeat('1', 64)
      ) returning id
    `)).rows[0]!;
    const revision = (await databaseClient.pool.query<{ id: string }>(`
      insert into title_revisions (
        title_id, parent_revision_id, created_by_actor_id, change_summary,
        staging_storage_key, staging_checksum_sha256, staging_byte_size,
        upload_filename, upload_mime_type
      ) values (
        $1, null, 'boundary-admin', 'Boundary upload', 'staging/boundary.epub',
        repeat('2', 64), 256, 'boundary.epub', 'application/epub+zip'
      ) returning id
    `, [titleId])).rows[0]!;

    const canonicalJobs = [
      {
        type: 'commerce.stripe-event',
        payload: { stripeEventId: stripeEvent.id },
        dedup: 'stripe:event:evt_job_boundary_9201',
        max: 12
      },
      {
        type: 'catalog.ingest_revision',
        payload: { revisionId: revision.id, generation: 0 },
        dedup: `catalog.ingest:${revision.id}:0`,
        max: 5
      },
      {
        type: 'commerce.claim-email-request',
        payload: { orderId: claimOrderId },
        dedup: `commerce:claim-request:order:${claimOrderId}:window:12345:v1`,
        max: 8
      },
      {
        type: 'outbox.dispatch',
        payload: { outboxId },
        dedup: `outbox:${outboxId}`,
        max: 8
      }
    ] as const;
    const insertedIds: string[] = [];
    for (const job of canonicalJobs) {
      const inserted = await databaseClient.pool.query<{ id: string }>(`
        insert into jobs (type, payload, deduplication_key, run_at, max_attempts)
        values ($1, $2::jsonb, $3, transaction_timestamp(), $4)
        returning id
      `, [job.type, JSON.stringify(job.payload), job.dedup, job.max]);
      insertedIds.push(inserted.rows[0]!.id);
    }

    const referenceProviderEventId = `evt_reference_${randomUUID()}`;
    const referenceEvent = (await databaseClient.pool.query<{ id: string }>(`
      insert into stripe_events (
        provider_event_id, event_type, object_id, live_mode, provider_created_at,
        raw_body_sha256
      ) values (
        $1, 'checkout.session.completed', $2, false, clock_timestamp(), repeat('7', 64)
      ) returning id
    `, [referenceProviderEventId, `cs_reference_${randomUUID()}`])).rows[0]!;
    const referenceInput = {
      type: 'commerce.stripe-event',
      payload: { stripeEventId: referenceEvent.id },
      deduplicationKey: `stripe:event:${referenceProviderEventId}`,
      maxAttempts: 12
    } as const;
    const firstReference = await enqueueJobReference(databaseClient.db, referenceInput);
    const replayedReference = await enqueueJobReference(databaseClient.db, referenceInput);
    expect(replayedReference.id).toBe(firstReference.id);
    await expect(databaseClient.pool.query(
      'select payload from jobs where id = $1', [firstReference.id]
    )).rejects.toMatchObject({ code: '42501' });
    await expect(ownerDatabaseClient.pool.query(
      'select payload from jobs where id = $1', [firstReference.id]
    )).resolves.toMatchObject({
      rows: [{ payload: { stripeEventId: referenceEvent.id } }]
    });

    await expect(databaseClient.pool.query(`
      insert into jobs (type, payload, deduplication_key, run_at, max_attempts)
      values (
        'commerce.financial-source', '{"sourceKind":"refund"}'::jsonb,
        'forged-financial-job', transaction_timestamp(), 12
      )
    `)).rejects.toMatchObject({ code: '55000' });
    await expect(databaseClient.pool.query(`
      insert into jobs (type, payload, deduplication_key, run_at, max_attempts)
      values (
        'commerce.stripe-event', $1::jsonb, 'stripe:event:forged',
        transaction_timestamp(), 12
      )
    `, [JSON.stringify({ stripeEventId: stripeEvent.id, private: true })]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(databaseClient.pool.query(`
      insert into jobs (type, payload, deduplication_key, run_at, max_attempts)
      values (
        'catalog.ingest_revision', $1::jsonb, $2,
        transaction_timestamp(), 5
      )
    `, [JSON.stringify({ revisionId: revision.id, generation: 1 }),
      `catalog.ingest:${revision.id}:1`])).rejects.toMatchObject({ code: '55000' });
    await expect(databaseClient.pool.query(`
      insert into jobs (type, payload, deduplication_key, run_at, max_attempts)
      values (
        'outbox.dispatch', $1::jsonb, $2,
        transaction_timestamp() + interval '1 hour', 8
      )
    `, [JSON.stringify({ outboxId: '00000000-0000-4000-8000-000000009299' }),
      'outbox:00000000-0000-4000-8000-000000009299']))
      .rejects.toMatchObject({ code: '55000' });
    await expect(databaseClient.pool.query(`
      update jobs set status = 'failed' where id = $1
    `, [insertedIds[0]])).rejects.toMatchObject({ code: '42501' });

    await expect(workerDatabaseClient.pool.query(`
      insert into jobs (type, payload, deduplication_key, run_at, max_attempts)
      values (
        'commerce.financial-source', '{"sourceKind":"refund"}'::jsonb,
        'worker-financial-job', transaction_timestamp() + interval '1 hour', 12
      )
    `)).resolves.toMatchObject({ rowCount: 1 });
  });

  it('submits, replays, transitions, synchronizes, audits, and reauthorizes admin commands', async () => {
    const actorId = randomUUID();
    await ownerDatabaseClient.pool.query(`
      insert into "user" (id, name, email, email_verified)
      values ($1, 'Financial command administrator', $2, true)
    `, [actorId, `financial-command-${actorId}@example.com`]);
    await ownerDatabaseClient.pool.query(
      `insert into user_roles (user_id, role) values ($1, 'admin')`,
      [actorId]
    );

    type SubmittedCommand = {
      command_id: string;
      command_kind: string;
      command_status: string;
      created_at: Date;
    };
    const submit = async (
      kind: string,
      privateInput: Record<string, unknown>,
      idempotencyHash: string,
      fingerprintHash: string
    ): Promise<SubmittedCommand> => {
      const result = await databaseClient.pool.query<SubmittedCommand>(`
        select * from public.submit_financial_admin_command(
          $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::jsonb
        )
      `, [
        actorId,
        `admin-command-${randomUUID()}`,
        kind,
        idempotencyHash,
        fingerprintHash,
        JSON.stringify(privateInput)
      ]);
      expect(result.rows).toHaveLength(1);
      return result.rows[0]!;
    };

    const refundId = randomUUID();
    const orderItemId = randomUUID();
    const draftInput = {
      kind: 'refund_draft_save',
      refundId,
      expectedVersion: null,
      items: [{ orderItemId, totalPresentmentMinor: 10 }]
    };
    const draftCommand = await submit(
      'refund_draft_save', draftInput, '1'.repeat(64), 'a'.repeat(64)
    );
    const replay = await databaseClient.pool.query<SubmittedCommand>(`
      select * from public.submit_financial_admin_command(
        $1::uuid, 'admin-command-replay', 'refund_draft_save',
        $2::text, $3::text, $4::jsonb
      )
    `, [actorId, '1'.repeat(64), 'a'.repeat(64), JSON.stringify(draftInput)]);
    expect(replay.rows[0]).toMatchObject({
      command_id: draftCommand.command_id,
      command_kind: 'refund_draft_save',
      command_status: 'pending'
    });
    const validInputShapes: ReadonlyArray<{
      kind: string;
      input: Record<string, unknown>;
      nullableKeys?: readonly string[];
    }> = [
      { kind: 'refund_draft_save', input: draftInput, nullableKeys: ['expectedVersion'] },
      {
        kind: 'refund_draft_discard',
        input: {
          kind: 'refund_draft_discard', refundId, expectedActiveDraftVersion: 1
        }
      },
      {
        kind: 'refund_allocation_finalize',
        input: {
          kind: 'refund_allocation_finalize', refundId, expectedActiveDraftVersion: 1,
          previewFingerprint: 'b'.repeat(64), confirmation: 'finalize_refund_allocation'
        }
      },
      {
        kind: 'refund_reporting_correction_create',
        input: {
          kind: 'refund_reporting_correction_create', refundId,
          reason: 'allocation_attribution_correction', expectedNextCorrectionVersion: 1,
          expectedBaseAllocationSetId: randomUUID(),
          expectedSourceFingerprint: 'c'.repeat(64),
          items: [{ orderItemId, totalPresentmentMinor: 10 }],
          previewFingerprint: 'd'.repeat(64), confirmation: 'create_reporting_correction'
        }
      },
      {
        kind: 'administrative_recovery_activate',
        input: {
          kind: 'administrative_recovery_activate', refundId,
          finalizationEffectId: randomUUID(), orderItemId,
          expectedCorrectionSetId: randomUUID(), expectedCorrectionVersion: 1,
          expectedSourceFingerprint: 'e'.repeat(64), previewFingerprint: 'f'.repeat(64),
          confirmation: 'activate_persistent_recovery'
        }
      },
      {
        kind: 'administrative_recovery_deactivate',
        input: {
          kind: 'administrative_recovery_deactivate', recoveryGrantId: randomUUID(),
          recoveryReferenceId: randomUUID(),
          expectedStateChangedAt: '2026-08-21T12:34:56.789Z',
          confirmation: 'deactivate_persistent_recovery'
        }
      }
    ];
    const invalidPrivateInputs: Array<{
      kind: string;
      input: Record<string, unknown>;
      label: string;
    }> = [];
    for (const shape of validInputShapes) {
      for (const key of Object.keys(shape.input)) {
        const missing = { ...shape.input };
        delete missing[key];
        invalidPrivateInputs.push({
          kind: shape.kind,
          input: missing,
          label: `${shape.kind} missing ${key}`
        });
        if (!shape.nullableKeys?.includes(key)) {
          invalidPrivateInputs.push({
            kind: shape.kind,
            input: { ...shape.input, [key]: null },
            label: `${shape.kind} null ${key}`
          });
        }
      }
    }
    for (const shape of validInputShapes.filter((item) => Array.isArray(item.input.items))) {
      const [validItem] = shape.input.items as Array<Record<string, unknown>>;
      for (const key of ['orderItemId', 'totalPresentmentMinor'] as const) {
        const missingItem = { ...validItem };
        delete missingItem[key];
        invalidPrivateInputs.push({
          kind: shape.kind,
          input: { ...shape.input, items: [missingItem] },
          label: `${shape.kind} item missing ${key}`
        }, {
          kind: shape.kind,
          input: { ...shape.input, items: [{ ...validItem, [key]: null }] },
          label: `${shape.kind} item null ${key}`
        });
      }
      for (const invalidItems of [{}, 'items', 1, true]) {
        invalidPrivateInputs.push({
          kind: shape.kind,
          input: { ...shape.input, items: invalidItems },
          label: `${shape.kind} rejects ${typeof invalidItems} items`
        });
      }
      for (const invalidItem of [null, 'item', 1, true]) {
        invalidPrivateInputs.push({
          kind: shape.kind,
          input: { ...shape.input, items: [invalidItem] },
          label: `${shape.kind} rejects ${String(invalidItem)} item`
        });
      }
    }
    invalidPrivateInputs.push({
      kind: 'refund_allocation_finalize',
      input: { ...validInputShapes[2]!.input, previewFingerprint: 123 },
      label: 'numeric preview fingerprint'
    }, {
      kind: 'administrative_recovery_activate',
      input: { ...validInputShapes[4]!.input, expectedSourceFingerprint: 123 },
      label: 'numeric source fingerprint'
    }, {
      kind: 'refund_draft_save',
      input: { ...draftInput, actorUserId: actorId },
      label: 'extra private identity'
    }, {
      kind: 'administrative_recovery_deactivate',
      input: {
        ...validInputShapes[5]!.input,
        expectedStateChangedAt: '2026-08-21T24:00:00.000Z'
      },
      label: 'normalizable but noncanonical recovery timestamp'
    });
    const invalidSideEffects = async () => (await ownerDatabaseClient.pool.query<{
      commands: number;
      jobs: number;
      audits: number;
    }>(`
      select
        (select count(*)::integer from financial_admin_commands command
         where command.actor_user_id = $1) as commands,
        (select count(*)::integer from jobs job
         join financial_admin_commands command on command.job_id = job.id
         where command.actor_user_id = $1) as jobs,
        (select count(*)::integer from audit_events audit
         where audit.correlation_id like 'invalid-admin-command-%') as audits
    `, [actorId])).rows[0]!;
    const invalidSideEffectsBefore = await invalidSideEffects();
    for (const [index, invalid] of invalidPrivateInputs.entries()) {
      await expect(databaseClient.pool.query(`
        select * from public.submit_financial_admin_command(
          $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::jsonb
        )
      `, [
        actorId,
        `invalid-admin-command-${index}`,
        invalid.kind,
        createHash('sha256').update(`invalid-idempotency:${index}`).digest('hex'),
        createHash('sha256').update(`invalid-fingerprint:${index}`).digest('hex'),
        JSON.stringify(invalid.input)
      ]), invalid.label).rejects.toMatchObject({ code: '22023' });
    }
    expect(await invalidSideEffects()).toEqual(invalidSideEffectsBefore);
    await expect(databaseClient.pool.query(`
      select * from public.submit_financial_admin_command(
        $1::uuid, 'admin-command-conflicting-replay', 'refund_draft_save',
        $2::text, $3::text, $4::jsonb
      )
    `, [
      actorId,
      '1'.repeat(64),
      'b'.repeat(64),
      JSON.stringify(draftInput)
    ])).rejects.toMatchObject({ code: '40900' });

    await expect(databaseClient.pool.query(
      'select id from financial_admin_commands where id = $1', [draftCommand.command_id]
    )).rejects.toMatchObject({ code: '42501' });
    const draftCommandJobId = (await ownerDatabaseClient.pool.query<{ job_id: string }>(
      'select job_id from financial_admin_commands where id = $1',
      [draftCommand.command_id]
    )).rows[0]!.job_id;
    await expect(databaseClient.pool.query(
      'select payload from jobs where id = $1', [draftCommandJobId]
    )).rejects.toMatchObject({ code: '42501' });
    const status = await databaseClient.pool.query<{
      command_id: string; command_status: string; safe_result: unknown;
    }>(`
      select command_id, command_status, safe_result
      from public.financial_admin_command_status($1::uuid, $2::uuid)
    `, [actorId, draftCommand.command_id]);
    expect(status.rows).toEqual([{
      command_id: draftCommand.command_id,
      command_status: 'pending',
      safe_result: null
    }]);
    await expect(workerDatabaseClient.pool.query(`
      select * from public.submit_financial_admin_command(
        $1::uuid, 'worker-submit-denied', 'refund_draft_save',
        $2::text, $3::text, $4::jsonb
      )
    `, [actorId, '2'.repeat(64), 'b'.repeat(64), JSON.stringify(draftInput)]))
      .rejects.toMatchObject({ code: '42501' });

    const commandJob = (await ownerDatabaseClient.pool.query<{
      job_id: string; payload: unknown; deduplication_key: string; max_attempts: number;
    }>(`
      select command.job_id, job.payload, job.deduplication_key, job.max_attempts
      from financial_admin_commands command
      join jobs job on job.id = command.job_id
      where command.id = $1
    `, [draftCommand.command_id])).rows[0]!;
    expect(commandJob).toEqual({
      job_id: expect.any(String),
      payload: { commandId: draftCommand.command_id },
      deduplication_key:
        `commerce:financial-admin-command:${draftCommand.command_id}:v1`,
      max_attempts: 8
    });

    const commandRepository = createPostgresJobRepository(
      workerDatabaseClient.db,
      { ...applicationConfig.jobs, leaseMs: 5_000 }
    );
    const claimExpectedCommandJob = async (
      jobId: string,
      workerId: string,
      repository = commandRepository
    ) => {
      const delayed = (await ownerDatabaseClient.pool.query<{
        id: string;
        run_at: Date;
      }>(`
        with due_job as (
          select id, run_at from jobs
          where status = 'pending' and type <> 'commerce.financial-admin-command'
            and run_at <= clock_timestamp()
          for update
        )
        update jobs set run_at = 'infinity'::timestamptz
        from due_job
        where jobs.id = due_job.id
        returning jobs.id, due_job.run_at
      `)).rows;
      try {
        const claimed = await repository.claimNext(workerId);
        expect(claimed).toMatchObject({
          id: jobId,
          type: 'commerce.financial-admin-command',
          financialAdminLeaseCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u)
        });
        return claimed!;
      } finally {
        for (const delayedJob of delayed) {
          await ownerDatabaseClient.pool.query(`
            update jobs set run_at = $2
            where id = $1 and status = 'pending'
          `, [delayedJob.id, delayedJob.run_at]);
        }
      }
    };
    const transitionCommandSucceeded = async (
      commandId: string,
      jobId: string,
      capability: string,
      safeResultCode: string,
      result: Record<string, unknown>
    ) => {
      const transition = await workerDatabaseClient.pool.connect();
      try {
        await transition.query('begin');
        await transition.query(
          `select pg_catalog.set_config(
            'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
          )`,
          [capability]
        );
        await transition.query(
          `select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
        );
        await transition.query(`
          select pg_advisory_xact_lock_shared(hashtextextended(
            'pale-orbit:plan6bii-financial-admin-job-lease:' || $1::uuid::text, 0
          ))
        `, [jobId]);
        await transition.query(`
          with terminal_clock as materialized (
            select clock_timestamp() as transition_at
          )
          update financial_admin_commands
          set status = 'succeeded', safe_result_code = $3,
            safe_result = $2::jsonb, updated_at = terminal_clock.transition_at,
            completed_at = terminal_clock.transition_at
          from terminal_clock
          where financial_admin_commands.id = $1
        `, [commandId, JSON.stringify(result), safeResultCode]);
        await transition.query('commit');
      } catch (error) {
        await transition.query('rollback');
        throw error;
      } finally {
        transition.release();
      }
    };

    await expect(workerDatabaseClient.pool.query(`
      with terminal_clock as materialized (
        select clock_timestamp() as transition_at
      )
      update financial_admin_commands
      set status = 'failed', safe_result_code = 'command_failed',
        updated_at = terminal_clock.transition_at,
        completed_at = terminal_clock.transition_at
      from terminal_clock
      where financial_admin_commands.id = $1
    `, [draftCommand.command_id])).rejects.toMatchObject({ code: '55000' });
    const claimedDraft = await claimExpectedCommandJob(
      commandJob.job_id,
      'financial-command-boundary'
    );
    const draftCapability = claimedDraft.financialAdminLeaseCapability!;
    const spoofedTerminalSync = await workerDatabaseClient.pool.connect();
    try {
      await spoofedTerminalSync.query('begin');
      await spoofedTerminalSync.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        ), pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_terminal_sync_command_id', $2, true
        )
      `, [draftCapability, draftCommand.command_id]);
      await expect(spoofedTerminalSync.query(`
        with terminal_clock as materialized (
          select clock_timestamp() as transition_at
        )
        update financial_admin_commands
        set status = 'failed', safe_result_code = 'command_failed',
          safe_result = null, updated_at = terminal_clock.transition_at,
          completed_at = terminal_clock.transition_at
        from terminal_clock
        where financial_admin_commands.id = $1
      `, [draftCommand.command_id])).rejects.toMatchObject({ code: '55000' });
      await spoofedTerminalSync.query('rollback');
    } catch (error) {
      await spoofedTerminalSync.query('rollback');
      throw error;
    } finally {
      spoofedTerminalSync.release();
    }
    await expect(workerDatabaseClient.pool.query(`
      with terminal_clock as materialized (
        select clock_timestamp() as transition_at
      )
      update financial_admin_commands
      set status = 'succeeded', safe_result_code = 'draft_saved',
        safe_result = $2::jsonb, updated_at = terminal_clock.transition_at,
        completed_at = terminal_clock.transition_at
      from terminal_clock
      where financial_admin_commands.id = $1
    `, [draftCommand.command_id, JSON.stringify({
      refundId,
      draftVersion: 1,
      changed: false
    })])).rejects.toMatchObject({ code: '55000' });
    const invalidTimestampTransition = await workerDatabaseClient.pool.connect();
    try {
      await invalidTimestampTransition.query('begin');
      await invalidTimestampTransition.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        )
      `, [draftCapability]);
      await invalidTimestampTransition.query(
        `select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
      );
      await invalidTimestampTransition.query(`
        select pg_advisory_xact_lock_shared(hashtextextended(
          'pale-orbit:plan6bii-financial-admin-job-lease:' || $1::uuid::text, 0
        ))
      `, [commandJob.job_id]);
      await expect(invalidTimestampTransition.query(`
        update financial_admin_commands
        set status = 'succeeded', safe_result_code = 'draft_saved',
          safe_result = $2::jsonb, updated_at = created_at - interval '1 second',
          completed_at = created_at - interval '1 second'
        where id = $1
      `, [draftCommand.command_id, JSON.stringify({
        refundId, draftVersion: 1, changed: false
      })])).rejects.toMatchObject({ code: '55000' });
    } finally {
      await invalidTimestampTransition.query('rollback');
      invalidTimestampTransition.release();
    }
    await transitionCommandSucceeded(
      draftCommand.command_id,
      commandJob.job_id,
      draftCapability,
      'draft_saved',
      { refundId, draftVersion: 1, changed: false }
    );
    await expect(workerDatabaseClient.pool.query(`
      update financial_admin_commands set updated_at = clock_timestamp() where id = $1
    `, [draftCommand.command_id])).rejects.toMatchObject({ code: '55000' });
    await expect(commandRepository.complete(
      commandJob.job_id,
      'financial-command-boundary',
      draftCapability
    )).resolves.toBe(true);
    await expect(ownerDatabaseClient.pool.query(
      'delete from financial_admin_commands where id = $1', [draftCommand.command_id]
    )).rejects.toMatchObject({ code: '55000' });

    const failedCommand = await submit(
      'refund_draft_save', draftInput, '3'.repeat(64), 'c'.repeat(64)
    );
    const failedJob = (await ownerDatabaseClient.pool.query<{ job_id: string }>(
      'select job_id from financial_admin_commands where id = $1',
      [failedCommand.command_id]
    )).rows[0]!;
    await expect(workerDatabaseClient.pool.query(`
      with terminal_clock as materialized (
        select clock_timestamp() as transition_at
      )
      update financial_admin_commands
      set status = 'failed', safe_result_code = 'command_failed',
        updated_at = terminal_clock.transition_at,
        completed_at = terminal_clock.transition_at
      from terminal_clock
      where financial_admin_commands.id = $1
    `, [failedCommand.command_id])).rejects.toMatchObject({ code: '55000' });
    const claimedFailed = await claimExpectedCommandJob(
      failedJob.job_id,
      'financial-command-failure-boundary'
    );
    const failedCapability = claimedFailed.financialAdminLeaseCapability!;
    expect(failedCapability).not.toBe(draftCapability);
    await expect(commandRepository.fail(
      failedJob.job_id,
      'financial-command-failure-boundary',
      'bounded terminal fixture',
      false,
      failedCapability
    )).resolves.toBe(true);
    await expect(ownerDatabaseClient.pool.query(`
      select status, safe_result_code, safe_result
      from financial_admin_commands where id = $1
    `, [failedCommand.command_id])).resolves.toMatchObject({
      rows: [{ status: 'failed', safe_result_code: 'command_failed', safe_result: null }]
    });
    await expect(ownerDatabaseClient.pool.query(`
      select count(*)::integer as count from audit_events
      where action = 'financial.admin_command.failed' and resource_id = $1
    `, [failedCommand.command_id])).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const spoofRecoveryReferenceId = randomUUID();
    const spoofRecoveryCommand = await submit(
      'administrative_recovery_activate',
      {
        kind: 'administrative_recovery_activate',
        refundId: randomUUID(),
        finalizationEffectId: randomUUID(),
        orderItemId: randomUUID(),
        expectedCorrectionSetId: randomUUID(),
        expectedCorrectionVersion: 1,
        expectedSourceFingerprint: '8'.repeat(64),
        previewFingerprint: '8'.repeat(64),
        confirmation: 'activate_persistent_recovery'
      },
      '0'.repeat(64),
      'd'.repeat(64)
    );
    const spoofRecoveryJob = (await ownerDatabaseClient.pool.query<{ job_id: string }>(
      'select job_id from financial_admin_commands where id = $1',
      [spoofRecoveryCommand.command_id]
    )).rows[0]!;
    const claimedSpoofRecovery = await claimExpectedCommandJob(
      spoofRecoveryJob.job_id,
      'financial-command-grant-spoof'
    );
    const spoofRecoveryCapability =
      claimedSpoofRecovery.financialAdminLeaseCapability!;
    const spoofedGrant = await workerDatabaseClient.pool.connect();
    try {
      await spoofedGrant.query('begin');
      await spoofedGrant.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        ), pg_catalog.set_config(
          'pale_orbit.plan6bii_administrative_grant_command_id', $2, true
        ), pg_catalog.set_config(
          'pale_orbit.plan6bii_administrative_grant_job_id', $3, true
        ), pg_catalog.set_config(
          'pale_orbit.plan6bii_administrative_grant_reference_id', $4, true
        )
      `, [
        spoofRecoveryCapability,
        spoofRecoveryCommand.command_id,
        spoofRecoveryJob.job_id,
        spoofRecoveryReferenceId
      ]);
      await expect(spoofedGrant.query(`
        insert into entitlement_grants (
          title_id, user_id, source, recovery_refund_allocation_id,
          state, state_reason
        ) values ($1, $2, 'administrative', $3, 'active',
          'refund_allocation_recovery')
      `, [randomUUID(), actorId, spoofRecoveryReferenceId]))
        .rejects.toMatchObject({ code: '55000' });
      await spoofedGrant.query('rollback');
    } catch (error) {
      await spoofedGrant.query('rollback');
      throw error;
    } finally {
      spoofedGrant.release();
    }
    await transitionCommandSucceeded(
      spoofRecoveryCommand.command_id,
      spoofRecoveryJob.job_id,
      spoofRecoveryCapability,
      'recovery_activated',
      { recoveryGrantId: randomUUID(), accessChanged: false, emailQueued: false }
    );
    await expect(commandRepository.complete(
      spoofRecoveryJob.job_id,
      'financial-command-grant-spoof',
      spoofRecoveryCapability
    )).resolves.toBe(true);

    const crossCommandA = await submit(
      'refund_draft_save', draftInput, '6'.repeat(64), '6'.repeat(64)
    );
    const crossCommandB = await submit(
      'refund_draft_save', draftInput, '7'.repeat(64), '7'.repeat(64)
    );
    const crossJobs = (await ownerDatabaseClient.pool.query<{
      id: string;
      command_id: string;
    }>(`
      select job.id, command.id as command_id
      from financial_admin_commands command
      join jobs job on job.id = command.job_id
      where command.id = any($1::uuid[])
      order by command.created_at, command.id
    `, [[crossCommandA.command_id, crossCommandB.command_id]])).rows;
    expect(crossJobs).toHaveLength(2);
    const claimedCrossA = await claimExpectedCommandJob(
      crossJobs[0]!.id,
      'financial-command-cross-a'
    );
    const claimedCrossB = await claimExpectedCommandJob(
      crossJobs[1]!.id,
      'financial-command-cross-b'
    );
    const crossCapabilityA = claimedCrossA.financialAdminLeaseCapability!;
    const crossCapabilityB = claimedCrossB.financialAdminLeaseCapability!;
    expect(new Set([
      draftCapability,
      failedCapability,
      crossCapabilityA,
      crossCapabilityB
    ]).size).toBe(4);
    await expect(commandRepository.renewLease(
      crossJobs[0]!.id,
      'financial-command-cross-a'
    )).resolves.toBe(false);
    await expect(commandRepository.renewLease(
      crossJobs[0]!.id,
      'financial-command-cross-a',
      'A'.repeat(43)
    )).resolves.toBe(false);
    await expect(commandRepository.renewLease(
      crossJobs[1]!.id,
      'financial-command-cross-b',
      crossCapabilityA
    )).resolves.toBe(false);
    await expect(commandRepository.renewLease(
      crossJobs[0]!.id,
      'financial-command-cross-a',
      crossCapabilityA
    )).resolves.toBe(true);
    await expect(commandRepository.renewLease(
      crossJobs[1]!.id,
      'financial-command-cross-b',
      crossCapabilityB
    )).resolves.toBe(true);
    const priorAttemptState = (await ownerDatabaseClient.pool.query<{
      generation: number;
      attempt: number;
      capability_sha256: string;
      renewed_at: Date | null;
      expires_at: Date;
    }>(`
      select generation, attempt, capability_sha256, renewed_at, expires_at
      from financial_admin_job_claims where job_id = $1
    `, [crossJobs[0]!.id])).rows[0]!;
    const priorAttemptFixture = await ownerDatabaseClient.pool.connect();
    try {
      await priorAttemptFixture.query('begin');
      await priorAttemptFixture.query(`set local session_replication_role = replica`);
      await priorAttemptFixture.query(`
        update financial_admin_job_claims
        set attempt = attempt + 1
        where job_id = $1
      `, [crossJobs[0]!.id]);
      await priorAttemptFixture.query('commit');
    } catch (error) {
      await priorAttemptFixture.query('rollback');
      throw error;
    } finally {
      priorAttemptFixture.release();
    }
    await expect(commandRepository.renewLease(
      crossJobs[0]!.id,
      'financial-command-cross-a',
      crossCapabilityA
    )).resolves.toBe(false);
    await expect(ownerDatabaseClient.pool.query(`
      select generation, attempt - 1 as attempt, capability_sha256,
        renewed_at, expires_at
      from financial_admin_job_claims where job_id = $1
    `, [crossJobs[0]!.id])).resolves.toMatchObject({ rows: [priorAttemptState] });
    const priorAttemptRepair = await ownerDatabaseClient.pool.connect();
    try {
      await priorAttemptRepair.query('begin');
      await priorAttemptRepair.query(`set local session_replication_role = replica`);
      await priorAttemptRepair.query(`
        update financial_admin_job_claims set attempt = $2 where job_id = $1
      `, [crossJobs[0]!.id, priorAttemptState.attempt]);
      await priorAttemptRepair.query('commit');
    } catch (error) {
      await priorAttemptRepair.query('rollback');
      throw error;
    } finally {
      priorAttemptRepair.release();
    }
    const secretPersistence = await ownerDatabaseClient.pool.query<{
      clear_capability_column_count: number;
      leaked_payload_count: number;
      leaked_error_count: number;
    }>(`
      select
        (select count(*)::integer from information_schema.columns
         where table_schema = 'public' and table_name = 'financial_admin_job_claims'
           and column_name like '%capability%' and column_name <> 'capability_sha256')
          as clear_capability_column_count,
        (select count(*)::integer from jobs
         where id = any($1::uuid[]) and (
           payload::text like '%' || $2 || '%' or payload::text like '%' || $3 || '%'
         )) as leaked_payload_count,
        (select count(*)::integer from jobs
         where id = any($1::uuid[]) and (
           coalesce(last_error, '') like '%' || $2 || '%' or
           coalesce(last_error, '') like '%' || $3 || '%'
         )) as leaked_error_count
    `, [[crossJobs[0]!.id, crossJobs[1]!.id], crossCapabilityA, crossCapabilityB]);
    expect(secretPersistence.rows).toEqual([{
      clear_capability_column_count: 0,
      leaked_payload_count: 0,
      leaked_error_count: 0
    }]);
    await expect(commandRepository.fail(
      crossJobs[0]!.id,
      'financial-command-cross-a',
      'cross-job cleanup',
      false,
      crossCapabilityA
    )).resolves.toBe(true);
    await expect(commandRepository.fail(
      crossJobs[1]!.id,
      'financial-command-cross-b',
      'cross-job cleanup',
      false,
      crossCapabilityB
    )).resolves.toBe(true);
    await expect(commandRepository.renewLease(
      crossJobs[0]!.id,
      'financial-command-cross-a',
      crossCapabilityA
    )).resolves.toBe(false);

    const takeoverCommand = await submit(
      'refund_draft_save', draftInput, '8'.repeat(64), '8'.repeat(64)
    );
    const takeoverJob = (await ownerDatabaseClient.pool.query<{ job_id: string }>(
      'select job_id from financial_admin_commands where id = $1',
      [takeoverCommand.command_id]
    )).rows[0]!;
    const shortLeaseRepository = createPostgresJobRepository(
      workerDatabaseClient.db,
      { ...applicationConfig.jobs, leaseMs: 5_000 }
    );
    const firstTakeoverClaim = await claimExpectedCommandJob(
      takeoverJob.job_id,
      'financial-command-old-generation',
      shortLeaseRepository
    );
    const oldGenerationCapability = firstTakeoverClaim.financialAdminLeaseCapability!;
    await expect(shortLeaseRepository.renewLease(
      takeoverJob.job_id,
      'financial-command-old-generation',
      oldGenerationCapability
    )).resolves.toBe(true);
    await expect(ownerDatabaseClient.pool.query(`
      select job.run_at = claim.expires_at as expiry_mirrored
      from jobs job
      join financial_admin_job_claims claim on claim.job_id = job.id
      where job.id = $1
    `, [takeoverJob.job_id])).resolves.toMatchObject({
      rows: [{ expiry_mirrored: true }]
    });
    const pausedOldGenerationSession = await workerDatabaseClient.pool.connect();
    let pausedOldGenerationSessionOpen = true;
    onTestFinished(async () => {
      if (!pausedOldGenerationSessionOpen) return;
      await pausedOldGenerationSession.query('rollback').catch(() => undefined);
      pausedOldGenerationSession.release();
      pausedOldGenerationSessionOpen = false;
    });
    await pausedOldGenerationSession.query('begin');
    await pausedOldGenerationSession.query(`
      select pg_catalog.set_config(
        'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
      )
    `, [oldGenerationCapability]);
    const expiryFixture = await ownerDatabaseClient.pool.connect();
    try {
      await expiryFixture.query('begin');
      await expiryFixture.query(`set local session_replication_role = replica`);
      const expiredAt = (await expiryFixture.query<{ expired_at: Date }>(`
        select date_trunc('milliseconds', clock_timestamp()) - interval '1 minute'
          as expired_at
      `)).rows[0]!.expired_at;
      await expiryFixture.query(`
        update jobs
        set locked_at = $2::timestamptz - interval '1 minute',
          run_at = $2::timestamptz
        where id = $1
      `, [takeoverJob.job_id, expiredAt]);
      await expiryFixture.query(`
        update financial_admin_job_claims
        set issued_at = $2::timestamptz - interval '2 minutes',
          renewed_at = $2::timestamptz - interval '1 minute',
          expires_at = $2::timestamptz
        where job_id = $1
      `, [takeoverJob.job_id, expiredAt]);
      await expiryFixture.query('commit');
    } catch (error) {
      await expiryFixture.query('rollback');
      throw error;
    } finally {
      expiryFixture.release();
    }
    const expiredClaimState = (await ownerDatabaseClient.pool.query<{
      generation: number;
      attempt: number;
      capability_sha256: string;
      state: string;
      issued_at: Date;
      renewed_at: Date | null;
      expires_at: Date;
    }>(`
      select generation, attempt, capability_sha256, state,
        issued_at, renewed_at, expires_at
      from financial_admin_job_claims where job_id = $1
    `, [takeoverJob.job_id])).rows[0]!;
    await expect(shortLeaseRepository.renewLease(
      takeoverJob.job_id,
      'financial-command-old-generation',
      oldGenerationCapability
    )).resolves.toBe(false);
    expect((await ownerDatabaseClient.pool.query(`
      select generation, attempt, capability_sha256, state,
        issued_at, renewed_at, expires_at
      from financial_admin_job_claims where job_id = $1
    `, [takeoverJob.job_id])).rows[0]).toEqual(expiredClaimState);
    const secondTakeoverClaim = await claimExpectedCommandJob(
      takeoverJob.job_id,
      'financial-command-new-generation',
      shortLeaseRepository
    );
    const newGenerationCapability = secondTakeoverClaim.financialAdminLeaseCapability!;
    expect(newGenerationCapability).not.toBe(oldGenerationCapability);
    await expect(shortLeaseRepository.renewLease(
      takeoverJob.job_id,
      'financial-command-new-generation',
      oldGenerationCapability
    )).resolves.toBe(false);
    await expect(shortLeaseRepository.renewLease(
      takeoverJob.job_id,
      'financial-command-new-generation',
      newGenerationCapability
    )).resolves.toBe(true);
    await expect(pausedOldGenerationSession.query(`
      with terminal_clock as materialized (
        select clock_timestamp() as transition_at
      )
      update financial_admin_commands
      set status = 'succeeded', safe_result_code = 'draft_saved',
        safe_result = $2::jsonb, updated_at = terminal_clock.transition_at,
        completed_at = terminal_clock.transition_at
      from terminal_clock
      where financial_admin_commands.id = $1
    `, [takeoverCommand.command_id, JSON.stringify({
      refundId: draftInput.refundId,
      draftVersion: 1,
      changed: false
    })])).rejects.toMatchObject({ code: '55000' });
    await pausedOldGenerationSession.query('rollback');
    pausedOldGenerationSession.release();
    pausedOldGenerationSessionOpen = false;
    await expect(ownerDatabaseClient.pool.query(`
      select status, safe_result_code, safe_result, completed_at
      from financial_admin_commands where id = $1
    `, [takeoverCommand.command_id])).resolves.toMatchObject({ rows: [{
      status: 'pending',
      safe_result_code: null,
      safe_result: null,
      completed_at: null
    }] });
    await expect(ownerDatabaseClient.pool.query(`
      select job.run_at = claim.expires_at as expiry_mirrored
      from jobs job
      join financial_admin_job_claims claim on claim.job_id = job.id
      where job.id = $1
    `, [takeoverJob.job_id])).resolves.toMatchObject({
      rows: [{ expiry_mirrored: true }]
    });
    await expect(shortLeaseRepository.fail(
      takeoverJob.job_id,
      'financial-command-new-generation',
      'takeover cleanup',
      false,
      newGenerationCapability
    )).resolves.toBe(true);
    await expect(ownerDatabaseClient.pool.query(`
      select generation, attempt, state, invalidated_at is not null as invalidated
      from financial_admin_job_claims where job_id = $1
    `, [takeoverJob.job_id])).resolves.toMatchObject({ rows: [{
      generation: 2,
      attempt: 2,
      state: 'invalidated',
      invalidated: true
    }] });

    const rerunResetCommand = await submit(
      'refund_draft_save', draftInput, 'b'.repeat(64), 'b'.repeat(64)
    );
    const rerunResetJob = (await ownerDatabaseClient.pool.query<{ job_id: string }>(
      'select job_id from financial_admin_commands where id = $1',
      [rerunResetCommand.command_id]
    )).rows[0]!;
    const rerunFixture = await ownerDatabaseClient.pool.connect();
    try {
      await rerunFixture.query('begin');
      await rerunFixture.query(`set local session_replication_role = replica`);
      await rerunFixture.query(`
        update jobs
        set status = 'running', attempts = 8,
          run_at = clock_timestamp() - interval '30 minutes',
          locked_at = clock_timestamp() - interval '1 hour',
          locked_by = 'expired-rerun-worker',
          last_error = 'bounded prior attempt failure',
          rerun_requested_at = clock_timestamp() - interval '30 minutes',
          updated_at = clock_timestamp() - interval '1 hour'
        where id = $1
      `, [rerunResetJob.job_id]);
      await rerunFixture.query(`
        insert into financial_admin_job_claims (
          job_id, generation, attempt, capability_sha256, lease_duration_ms,
          state, expires_at, issued_at
        ) values (
          $1, 3, 8, repeat('7', 64), 5000, 'active',
          clock_timestamp() - interval '30 minutes',
          clock_timestamp() - interval '1 hour'
        )
      `, [rerunResetJob.job_id]);
      await rerunFixture.query('commit');
    } catch (error) {
      await rerunFixture.query('rollback');
      throw error;
    } finally {
      rerunFixture.release();
    }
    const resetRerunClaim = await claimExpectedCommandJob(
      rerunResetJob.job_id,
      'financial-command-rerun-reset'
    );
    const resetRerunCapability = resetRerunClaim.financialAdminLeaseCapability!;
    expect(resetRerunClaim.attempts).toBe(1);
    await expect(ownerDatabaseClient.pool.query(`
      select job.attempts, job.last_error, job.rerun_requested_at,
        claim.generation, claim.attempt, claim.state,
        claim.capability_sha256 <> repeat('7', 64) as capability_rotated
      from jobs job
      join financial_admin_job_claims claim on claim.job_id = job.id
      where job.id = $1
    `, [rerunResetJob.job_id])).resolves.toMatchObject({ rows: [{
      attempts: 1,
      last_error: null,
      rerun_requested_at: null,
      generation: 4,
      attempt: 1,
      state: 'active',
      capability_rotated: true
    }] });
    await expect(commandRepository.fail(
      rerunResetJob.job_id,
      'financial-command-rerun-reset',
      'rerun reset cleanup',
      false,
      resetRerunCapability
    )).resolves.toBe(true);

    const matrixCommands: SubmittedCommand[] = [];
    for (const idempotencyDigit of ['a', 'c', 'd', 'e']) {
      matrixCommands.push(await submit(
        'refund_draft_save',
        draftInput,
        idempotencyDigit.repeat(64),
        idempotencyDigit.repeat(64)
      ));
    }
    const matrixJobs = (await ownerDatabaseClient.pool.query<{
      id: string;
      command_id: string;
    }>(`
      select job.id, command.id as command_id
      from unnest($1::uuid[]) with ordinality requested(command_id, ordinal)
      join financial_admin_commands command on command.id = requested.command_id
      join jobs job on job.id = command.job_id
      order by requested.ordinal
    `, [matrixCommands.map((command) => command.command_id)])).rows;
    expect(matrixJobs).toHaveLength(4);

    const matrixFixture = await ownerDatabaseClient.pool.connect();
    try {
      await matrixFixture.query('begin');
      await matrixFixture.query(`set local session_replication_role = replica`);
      for (const [index, job] of matrixJobs.entries()) {
        if (index < 2) {
          await matrixFixture.query(`
            update jobs
            set run_at = '2001-01-01 00:00:0${index + 1}+00'::timestamptz,
              updated_at = clock_timestamp()
            where id = $1
          `, [job.id]);
          continue;
        }
        await matrixFixture.query(`
          update jobs
          set status = 'running', attempts = 8,
            run_at = $2::timestamptz,
            locked_at = clock_timestamp() - interval '1 hour',
            locked_by = $3,
            updated_at = clock_timestamp() - interval '1 hour'
          where id = $1
        `, [
          job.id,
          `2001-01-01T00:00:0${index + 1}.000Z`,
          `expired-matrix-worker-${index}`
        ]);
        await matrixFixture.query(`
          insert into financial_admin_job_claims (
            job_id, generation, attempt, capability_sha256, lease_duration_ms,
            state, expires_at, issued_at
          ) values (
            $1, $2, 8, $3, 30000, 'active',
            clock_timestamp() - interval '30 minutes',
            clock_timestamp() - interval '1 hour'
          )
        `, [job.id, index + 1, String(index + 1).repeat(64)]);
      }
      await matrixFixture.query(`
        with terminal_clock as materialized (
          select clock_timestamp() as terminal_at
        )
        update financial_admin_commands
        set status = 'succeeded', safe_result_code = 'draft_saved',
          safe_result = $2::jsonb, updated_at = terminal_clock.terminal_at,
          completed_at = terminal_clock.terminal_at
        from terminal_clock
        where id = $1
      `, [matrixJobs[3]!.command_id, JSON.stringify({
        refundId,
        draftVersion: 1,
        changed: false
      })]);
      await matrixFixture.query('commit');
    } catch (error) {
      await matrixFixture.query('rollback');
      throw error;
    } finally {
      matrixFixture.release();
    }

    type MatrixClaimState = {
      id: string;
      job_status: string;
      attempts: number;
      command_status: string;
      generation: number | null;
      claim_attempt: number | null;
      claim_state: string | null;
      capability_sha256: string | null;
    };
    const readMatrixState = async (): Promise<MatrixClaimState[]> => (
      await ownerDatabaseClient.pool.query<MatrixClaimState>(`
        select job.id, job.status as job_status, job.attempts,
          command.status as command_status, claim.generation,
          claim.attempt as claim_attempt, claim.state as claim_state,
          claim.capability_sha256
        from unnest($1::uuid[]) with ordinality requested(job_id, ordinal)
        join jobs job on job.id = requested.job_id
        join financial_admin_commands command on command.job_id = job.id
        left join financial_admin_job_claims claim on claim.job_id = job.id
        order by requested.ordinal
      `, [matrixJobs.map((job) => job.id)])
    ).rows;
    const matrixBefore = await readMatrixState();
    expect(matrixBefore).toEqual([
      {
        id: matrixJobs[0]!.id,
        job_status: 'pending',
        attempts: 0,
        command_status: 'pending',
        generation: null,
        claim_attempt: null,
        claim_state: null,
        capability_sha256: null
      },
      {
        id: matrixJobs[1]!.id,
        job_status: 'pending',
        attempts: 0,
        command_status: 'pending',
        generation: null,
        claim_attempt: null,
        claim_state: null,
        capability_sha256: null
      },
      {
        id: matrixJobs[2]!.id,
        job_status: 'running',
        attempts: 8,
        command_status: 'pending',
        generation: 3,
        claim_attempt: 8,
        claim_state: 'active',
        capability_sha256: '3'.repeat(64)
      },
      {
        id: matrixJobs[3]!.id,
        job_status: 'running',
        attempts: 8,
        command_status: 'succeeded',
        generation: 4,
        claim_attempt: 8,
        claim_state: 'active',
        capability_sha256: '4'.repeat(64)
      }
    ]);

    const delayedMatrixCompetitors = (await ownerDatabaseClient.pool.query<{
      id: string;
      run_at: Date;
    }>(`
      with due_job as (
        select id, run_at from jobs
        where status = 'pending' and id <> all($1::uuid[])
          and run_at <= clock_timestamp()
        for update
      )
      update jobs set run_at = 'infinity'::timestamptz
      from due_job
      where jobs.id = due_job.id
      returning jobs.id, due_job.run_at
    `, [matrixJobs.map((job) => job.id)])).rows;
    const matrixCapabilities: string[] = [];
    const matrixRepository = createPostgresJobRepository(
      workerDatabaseClient.db,
      { ...applicationConfig.jobs, leaseMs: 30_000 },
      () => new Date(),
      'all',
      { classifierVersion: 1, allocationAlgorithmVersion: 1 },
      () => {
        const capability = randomBytes(32).toString('base64url');
        matrixCapabilities.push(capability);
        return capability;
      }
    );
    try {
      const firstMatrixClaim = await matrixRepository.claimNext('financial-command-matrix');
      expect(firstMatrixClaim).toMatchObject({ id: matrixJobs[0]!.id, attempts: 1 });
      const afterFirstMatrixClaim = await readMatrixState();
      expect(afterFirstMatrixClaim[0]).toMatchObject({
        job_status: 'running', attempts: 1, command_status: 'pending',
        generation: 1, claim_attempt: 1, claim_state: 'active'
      });
      expect(afterFirstMatrixClaim.slice(1)).toEqual(matrixBefore.slice(1));

      const secondMatrixClaim = await matrixRepository.claimNext('financial-command-matrix');
      expect(secondMatrixClaim).toMatchObject({ id: matrixJobs[1]!.id, attempts: 1 });
      const afterSecondMatrixClaim = await readMatrixState();
      expect(afterSecondMatrixClaim[0]).toEqual(afterFirstMatrixClaim[0]);
      expect(afterSecondMatrixClaim[1]).toMatchObject({
        job_status: 'running', attempts: 1, command_status: 'pending',
        generation: 1, claim_attempt: 1, claim_state: 'active'
      });
      expect(afterSecondMatrixClaim.slice(2)).toEqual(matrixBefore.slice(2));

      await expect(matrixRepository.claimNext('financial-command-matrix'))
        .resolves.toBeNull();
      const afterThirdMatrixClaim = await readMatrixState();
      expect(afterThirdMatrixClaim.slice(0, 2)).toEqual(afterSecondMatrixClaim.slice(0, 2));
      expect(afterThirdMatrixClaim[2]).toMatchObject({
        job_status: 'failed', attempts: 8, command_status: 'failed',
        generation: 4, claim_attempt: 8, claim_state: 'invalidated'
      });
      expect(afterThirdMatrixClaim[3]).toEqual(matrixBefore[3]);

      await expect(matrixRepository.claimNext('financial-command-matrix'))
        .resolves.toBeNull();
      const afterFourthMatrixClaim = await readMatrixState();
      expect(afterFourthMatrixClaim.slice(0, 3)).toEqual(afterThirdMatrixClaim.slice(0, 3));
      expect(afterFourthMatrixClaim[3]).toMatchObject({
        job_status: 'succeeded', attempts: 8, command_status: 'succeeded',
        generation: 5, claim_attempt: 8, claim_state: 'invalidated'
      });

      expect(matrixCapabilities).toHaveLength(4);
      expect(new Set(matrixCapabilities).size).toBe(4);
      const expectedMatrixDigests = matrixCapabilities.map((capability) =>
        createHash('sha256').update(capability, 'utf8').digest('hex')
      );
      expect(new Set(expectedMatrixDigests).size).toBe(4);
      expect(afterFourthMatrixClaim.map((state, index) =>
        state.capability_sha256 === expectedMatrixDigests[index]
      )).toEqual([true, true, true, true]);
      await expect(matrixRepository.renewLease(
        matrixJobs[1]!.id,
        'financial-command-matrix',
        matrixCapabilities[0]
      )).resolves.toBe(false);
      await expect(matrixRepository.fail(
        matrixJobs[0]!.id,
        'financial-command-matrix',
        'matrix cleanup',
        false,
        matrixCapabilities[0]
      )).resolves.toBe(true);
      await expect(matrixRepository.fail(
        matrixJobs[1]!.id,
        'financial-command-matrix',
        'matrix cleanup',
        false,
        matrixCapabilities[1]
      )).resolves.toBe(true);
    } finally {
      for (const delayedJob of delayedMatrixCompetitors) {
        await ownerDatabaseClient.pool.query(`
          update jobs set run_at = $2
          where id = $1 and status = 'pending'
        `, [delayedJob.id, delayedJob.run_at]);
      }
    }

    const stableLeaseHash = createHash('sha256')
      .update(`stable-lease:${randomUUID()}`, 'utf8').digest('hex');
    const stableLeaseCommand = await submit(
      'refund_draft_save', draftInput, stableLeaseHash, stableLeaseHash
    );
    const stableLeaseJobId = (await ownerDatabaseClient.pool.query<{ job_id: string }>(`
      select job_id from financial_admin_commands where id = $1
    `, [stableLeaseCommand.command_id])).rows[0]!.job_id;
    const longLeaseRepository = createPostgresJobRepository(
      workerDatabaseClient.db,
      { ...applicationConfig.jobs, leaseMs: 60_000 }
    );
    const stableLeaseClaim = await claimExpectedCommandJob(
      stableLeaseJobId,
      'financial-command-stable-lease',
      longLeaseRepository
    );
    const stableLeaseCapability = stableLeaseClaim.financialAdminLeaseCapability!;
    const staleProcessClockFixture = await ownerDatabaseClient.pool.connect();
    try {
      await staleProcessClockFixture.query('begin');
      await staleProcessClockFixture.query(`set local session_replication_role = replica`);
      await staleProcessClockFixture.query(`
        update jobs set locked_at = clock_timestamp() - interval '2 minutes'
        where id = $1
      `, [stableLeaseJobId]);
      await staleProcessClockFixture.query('commit');
    } catch (error) {
      await staleProcessClockFixture.query('rollback');
      throw error;
    } finally {
      staleProcessClockFixture.release();
    }

    const changedConfigHash = createHash('sha256')
      .update(`changed-config:${randomUUID()}`, 'utf8').digest('hex');
    const changedConfigCommand = await submit(
      'refund_draft_save', draftInput, changedConfigHash, changedConfigHash
    );
    const changedConfigJobId = (await ownerDatabaseClient.pool.query<{ job_id: string }>(`
      select job_id from financial_admin_commands where id = $1
    `, [changedConfigCommand.command_id])).rows[0]!.job_id;
    const changedConfigCapabilities: string[] = [];
    const changedConfigRepository = createPostgresJobRepository(
      workerDatabaseClient.db,
      { ...applicationConfig.jobs, leaseMs: 30_000 },
      () => new Date(),
      'all',
      { classifierVersion: 1, allocationAlgorithmVersion: 1 },
      () => {
        const capability = randomBytes(32).toString('base64url');
        changedConfigCapabilities.push(capability);
        return capability;
      }
    );
    const changedConfigClaim = await claimExpectedCommandJob(
      changedConfigJobId,
      'financial-command-changed-config',
      changedConfigRepository
    );
    expect(changedConfigCapabilities).toHaveLength(1);
    expect(changedConfigClaim.id).toBe(changedConfigJobId);
    await expect(longLeaseRepository.renewLease(
      stableLeaseJobId,
      'financial-command-stable-lease',
      stableLeaseCapability
    )).resolves.toBe(true);
    await expect(longLeaseRepository.fail(
      stableLeaseJobId,
      'financial-command-stable-lease',
      'stable lease cleanup',
      false,
      stableLeaseCapability
    )).resolves.toBe(true);
    await expect(changedConfigRepository.fail(
      changedConfigJobId,
      'financial-command-changed-config',
      'changed configuration cleanup',
      false,
      changedConfigClaim.financialAdminLeaseCapability!
    )).resolves.toBe(true);

    const terminalConcurrencyHash = createHash('sha256')
      .update(`terminal-concurrency:${randomUUID()}`, 'utf8').digest('hex');
    const terminalConcurrencyCommand = await submit(
      'refund_draft_save', draftInput, terminalConcurrencyHash, terminalConcurrencyHash
    );
    const terminalConcurrencyJobId = (await ownerDatabaseClient.pool.query<{
      job_id: string;
    }>(`
      select job_id from financial_admin_commands where id = $1
    `, [terminalConcurrencyCommand.command_id])).rows[0]!.job_id;
    const terminalConcurrencyClaim = await claimExpectedCommandJob(
      terminalConcurrencyJobId,
      'financial-command-terminal-concurrency'
    );
    const terminalConcurrencyCapability =
      terminalConcurrencyClaim.financialAdminLeaseCapability!;
    const terminalReader = await workerDatabaseClient.pool.connect();
    let terminalReaderOpen = false;
    let terminalSettled = false;
    let terminalWrite: Promise<boolean> | undefined;
    try {
      await terminalReader.query('begin');
      terminalReaderOpen = true;
      await terminalReader.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        )
      `, [terminalConcurrencyCapability]);
      await terminalReader.query(
        `select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
      );
      await terminalReader.query(`
        select pg_advisory_xact_lock_shared(hashtextextended(
          'pale-orbit:plan6bii-financial-admin-job-lease:' || $1::uuid::text, 0
        ))
      `, [terminalConcurrencyJobId]);
      await terminalReader.query(`
        select id from financial_admin_commands where id = $1 for update
      `, [terminalConcurrencyCommand.command_id]);

      await expect(commandRepository.renewLease(
        terminalConcurrencyJobId,
        'financial-command-terminal-concurrency',
        terminalConcurrencyCapability
      )).resolves.toBe(true);

      terminalWrite = commandRepository.fail(
        terminalConcurrencyJobId,
        'financial-command-terminal-concurrency',
        'terminal concurrency cleanup',
        false,
        terminalConcurrencyCapability
      ).then((completed) => {
        terminalSettled = true;
        return completed;
      }, () => {
        terminalSettled = true;
        return false;
      });
      await expect(waitForFinancialAdminLeaseWriter(
        ownerDatabaseClient.pool,
        terminalConcurrencyJobId
      )).resolves.toMatchObject({ shared_granted: 1, exclusive_waiting: 1 });
      expect(terminalSettled).toBe(false);
      await terminalReader.query('commit');
      terminalReaderOpen = false;
      await expect(terminalWrite).resolves.toBe(true);
      await expect(ownerDatabaseClient.pool.query(`
        select job.status as job_status, command.status as command_status,
          claim.state as claim_state, claim.invalidated_at is not null as invalidated
        from jobs job
        join financial_admin_commands command on command.job_id = job.id
        join financial_admin_job_claims claim on claim.job_id = job.id
        where job.id = $1
      `, [terminalConcurrencyJobId])).resolves.toMatchObject({ rows: [{
        job_status: 'failed', command_status: 'failed',
        claim_state: 'invalidated', invalidated: true
      }] });
    } finally {
      if (terminalReaderOpen) await terminalReader.query('rollback');
      terminalReader.release();
      if (terminalWrite !== undefined) await terminalWrite;
    }

    const takeoverConcurrencyHash = createHash('sha256')
      .update(`takeover-concurrency:${randomUUID()}`, 'utf8').digest('hex');
    const takeoverConcurrencyCommand = await submit(
      'refund_draft_save', draftInput, takeoverConcurrencyHash, takeoverConcurrencyHash
    );
    const takeoverConcurrencyJobId = (await ownerDatabaseClient.pool.query<{
      job_id: string;
    }>(`
      select job_id from financial_admin_commands where id = $1
    `, [takeoverConcurrencyCommand.command_id])).rows[0]!.job_id;
    const takeoverConcurrencyClaim = await claimExpectedCommandJob(
      takeoverConcurrencyJobId,
      'financial-command-takeover-reader'
    );
    const takeoverConcurrencyCapability =
      takeoverConcurrencyClaim.financialAdminLeaseCapability!;
    const takeoverReader = await workerDatabaseClient.pool.connect();
    let takeoverReaderOpen = false;
    let takeoverSettled = false;
    let takeoverWrite: Promise<typeof takeoverConcurrencyClaim | null> | undefined;
    try {
      await takeoverReader.query('begin');
      takeoverReaderOpen = true;
      await takeoverReader.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        )
      `, [takeoverConcurrencyCapability]);
      await takeoverReader.query(
        `select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
      );
      await takeoverReader.query(`
        select pg_advisory_xact_lock_shared(hashtextextended(
          'pale-orbit:plan6bii-financial-admin-job-lease:' || $1::uuid::text, 0
        ))
      `, [takeoverConcurrencyJobId]);
      await takeoverReader.query(`
        select id from financial_admin_commands where id = $1 for update
      `, [takeoverConcurrencyCommand.command_id]);

      const takeoverExpiry = await ownerDatabaseClient.pool.connect();
      try {
        await takeoverExpiry.query('begin');
        await takeoverExpiry.query(`set local session_replication_role = replica`);
        await takeoverExpiry.query(`
          update jobs
          set locked_at = clock_timestamp() - interval '2 minutes',
            run_at = clock_timestamp() - interval '1 minute'
          where id = $1
        `, [takeoverConcurrencyJobId]);
        await takeoverExpiry.query(`
          update financial_admin_job_claims
          set issued_at = clock_timestamp() - interval '3 minutes',
            renewed_at = clock_timestamp() - interval '2 minutes',
            expires_at = clock_timestamp() - interval '1 minute'
          where job_id = $1
        `, [takeoverConcurrencyJobId]);
        await takeoverExpiry.query('commit');
      } catch (error) {
        await takeoverExpiry.query('rollback');
        throw error;
      } finally {
        takeoverExpiry.release();
      }

      takeoverWrite = claimExpectedCommandJob(
        takeoverConcurrencyJobId,
        'financial-command-takeover-writer',
        commandRepository
      ).then((claimed) => {
        takeoverSettled = true;
        return claimed;
      }, () => {
        takeoverSettled = true;
        return null;
      });
      await expect(waitForFinancialAdminLeaseWriter(
        ownerDatabaseClient.pool,
        takeoverConcurrencyJobId
      )).resolves.toMatchObject({ shared_granted: 1, exclusive_waiting: 1 });
      expect(takeoverSettled).toBe(false);
      await takeoverReader.query('commit');
      takeoverReaderOpen = false;

      const takenOver = await takeoverWrite;
      expect(takenOver).toMatchObject({
        id: takeoverConcurrencyJobId,
        attempts: 2,
        financialAdminLeaseCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u)
      });
      const takeoverWriterCapability = takenOver!.financialAdminLeaseCapability!;
      expect(takeoverWriterCapability).not.toBe(takeoverConcurrencyCapability);
      await expect(commandRepository.renewLease(
        takeoverConcurrencyJobId,
        'financial-command-takeover-writer',
        takeoverConcurrencyCapability
      )).resolves.toBe(false);
      await expect(commandRepository.fail(
        takeoverConcurrencyJobId,
        'financial-command-takeover-writer',
        'takeover concurrency cleanup',
        false,
        takeoverWriterCapability
      )).resolves.toBe(true);
    } finally {
      if (takeoverReaderOpen) await takeoverReader.query('rollback');
      takeoverReader.release();
      if (takeoverWrite !== undefined) await takeoverWrite;
    }

    const detailTargets = [randomUUID(), randomUUID(), randomUUID()];
    const auditCountBeforeInvalid = (await ownerDatabaseClient.pool.query<{ count: string }>(
      'select count(*)::text as count from audit_events'
    )).rows[0]!.count;
    await expect(databaseClient.pool.query(
      `select public.append_financial_issue_view_audit(
        $1::uuid, $2::uuid, null::text, 'GET'::text, $3::text
      )`,
      [actorId, detailTargets[0], `/admin/sales/issues/${detailTargets[0]}`]
    )).rejects.toMatchObject({ code: '22023' });
    await expect(databaseClient.pool.query(
      `select public.append_financial_refund_review_view_audit(
        $1::uuid, $2::uuid, $3::text, null::text, $4::text
      )`,
      [actorId, detailTargets[1], 'null-audit-refund',
        `/admin/sales/refunds/${detailTargets[1]}`]
    )).rejects.toMatchObject({ code: '22023' });
    await expect(databaseClient.pool.query(
      `select public.append_financial_payout_view_audit(
        $1::uuid, $2::uuid, $3::text, 'GET'::text, null::text
      )`,
      [actorId, detailTargets[2], 'null-audit-payout']
    )).rejects.toMatchObject({ code: '22023' });
    await expect(databaseClient.pool.query(
      `select public.append_financial_sales_export_audit(
        $1::uuid, null::text, $2::text, null::integer, null::integer,
        null::integer, null::text, null::text
      )`,
      [actorId, 'null-audit-export']
    )).rejects.toMatchObject({ code: '22023' });
    await expect(ownerDatabaseClient.pool.query<{ count: string }>(
      'select count(*)::text as count from audit_events'
    )).resolves.toMatchObject({ rows: [{ count: auditCountBeforeInvalid }] });
    await databaseClient.pool.query(
      `select public.append_financial_issue_view_audit($1,$2,$3,'GET',$4)`,
      [actorId, detailTargets[0], 'issue-view-boundary',
        `/admin/sales/issues/${detailTargets[0]}`]
    );
    await databaseClient.pool.query(
      `select public.append_financial_refund_review_view_audit($1,$2,$3,'GET',$4)`,
      [actorId, detailTargets[1], 'refund-view-boundary',
        `/admin/sales/refunds/${detailTargets[1]}`]
    );
    await databaseClient.pool.query(
      `select public.append_financial_payout_view_audit($1,$2,$3,'GET',$4)`,
      [actorId, detailTargets[2], 'payout-view-boundary',
        `/admin/sales/payouts/${detailTargets[2]}`]
    );
    await databaseClient.pool.query(`
      select public.append_financial_sales_export_audit(
        $1, $2, 'sales-export-boundary', 2, 256, 1, 'GET',
        '/admin/sales/export.csv'
      )
    `, [actorId, 'd'.repeat(64)]);
    await expect(ownerDatabaseClient.pool.query(`
      select action from audit_events
      where correlation_id in (
        'issue-view-boundary', 'refund-view-boundary',
        'payout-view-boundary', 'sales-export-boundary'
      ) order by action
    `)).resolves.toMatchObject({ rows: [
      { action: 'financial.issue.view' },
      { action: 'financial.payout.view' },
      { action: 'financial.refund_review.view' },
      { action: 'financial.sales_export' }
    ] });

    const activationTargetRefundId = randomUUID();
    const activationSiblingRefundId = randomUUID();
    const activationTitleId = randomUUID();
    const activationTargetFingerprint = '6'.repeat(64);
    const activationSiblingFingerprint = '7'.repeat(64);
    await insertTitle(activationTitleId);
    const activationOrder = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into orders (
        status, initiating_user_id, purchase_email, currency, subtotal_minor,
        tax_minor, total_minor, client_checkout_attempt_id,
        quote_fingerprint_sha256, status_token_sha256, paid_at
      ) values (
        'paid', $1, $2, 'USD', 1000, 100, 1100, $3,
        repeat('3', 64), repeat('4', 64), clock_timestamp()
      ) returning id
    `, [
      actorId,
      `activation-${activationTargetRefundId}@example.com`,
      randomUUID()
    ])).rows[0]!;
    const activationOrderItem = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into order_items (
        order_id, title_id, title_snapshot, creator_name_snapshot, format,
        currency, unit_subtotal_minor, tax_minor, total_minor
      ) values ($1, $2, 'Activation title', 'Activation author', 'prose',
        'USD', 1000, 100, 1100)
      returning id
    `, [activationOrder.id, activationTitleId])).rows[0]!;
    const activationPayment = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into payments (
        order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
        amount_minor, currency, paid_at
      ) values ($1, $2, $3, 'succeeded', 1100, 'USD', clock_timestamp())
      returning id
    `, [
      activationOrder.id,
      `pi_activation_${randomUUID()}`,
      `ch_activation_${randomUUID()}`
    ])).rows[0]!;
    const activationTargetStripeRefundId = `re_activation_target_${randomUUID()}`;
    const activationSiblingStripeRefundId = `re_activation_sibling_${randomUUID()}`;
    await ownerDatabaseClient.pool.query(`
      insert into refunds (
        id, payment_id, stripe_refund_id, status, amount_minor, currency,
        provider_created_at, allocation_status
      ) values
        ($1, $2, $3, 'succeeded', 100, 'USD', clock_timestamp(), 'finalized'),
        ($4, $2, $5, 'succeeded', 50, 'USD', clock_timestamp(), 'finalized')
    `, [
      activationTargetRefundId,
      activationPayment.id,
      activationTargetStripeRefundId,
      activationSiblingRefundId,
      activationSiblingStripeRefundId
    ]);
    const activationTransactions = (await ownerDatabaseClient.pool.query<{
      id: string;
      source_id: string;
    }>(`
      insert into stripe_balance_transactions (
        provider_id, live_mode, source_family, source_id, raw_type,
        reporting_category, balance_type, amount_minor, fee_minor, net_minor,
        currency, status, provider_created_at, available_at, fingerprint_sha256
      ) values
        ($1, false, 'refund', $2, 'refund', 'refund', 'payments',
          -100, 0, -100, 'USD', 'available', clock_timestamp(),
          clock_timestamp(), $3),
        ($4, false, 'refund', $5, 'refund', 'refund', 'payments',
          -50, 0, -50, 'USD', 'available', clock_timestamp(),
          clock_timestamp(), $6)
      returning id, source_id
    `, [
      `txn_activation_target_${randomUUID()}`,
      activationTargetStripeRefundId,
      activationTargetFingerprint,
      `txn_activation_sibling_${randomUUID()}`,
      activationSiblingStripeRefundId,
      activationSiblingFingerprint
    ])).rows;
    const activationTargetTransactionId = activationTransactions.find(
      (row) => row.source_id === activationTargetStripeRefundId
    )!.id;
    const activationSiblingTransactionId = activationTransactions.find(
      (row) => row.source_id === activationSiblingStripeRefundId
    )!.id;
    const activationProjection = (await ownerDatabaseClient.pool.query<{
      classifier_version: number;
      allocation_algorithm_version: number;
    }>(`
      select classifier_version, allocation_algorithm_version
      from financial_projection_versions
      where singleton = true
    `)).rows[0]!;
    await ownerDatabaseClient.pool.query(`
      insert into financial_classification_versions (
        subject_type, subject_id, classifier_version, classification,
        source_fingerprint_sha256
      ) values
        ('balance_transaction', $1, $2, 'refund', $3),
        ('balance_transaction', $4, $2, 'refund', $5)
    `, [
      activationTargetTransactionId,
      activationProjection.classifier_version,
      activationTargetFingerprint,
      activationSiblingTransactionId,
      activationSiblingFingerprint
    ]);
    const activationSets = (await ownerDatabaseClient.pool.query<{
      id: string;
      source_internal_id: string;
      basis: 'gross_amount' | 'fee';
    }>(`
      insert into financial_allocation_sets (
        allocation_identity, balance_transaction_id, source_kind,
        source_internal_id, basis, scope, expected_effect_minor, currency,
        algorithm_version, classifier_version, source_fingerprint_sha256
      ) values
        ($1, $2, 'refund', $3, 'gross_amount', 'title', -100, 'USD', $4, $5, $6),
        ($7, $2, 'refund', $3, 'fee', 'title', 0, 'USD', $4, $5, $6),
        ($8, $9, 'refund', $10, 'gross_amount', 'title', -50, 'USD', $4, $5, $11),
        ($12, $9, 'refund', $10, 'fee', 'title', 0, 'USD', $4, $5, $11)
      returning id, source_internal_id, basis
    `, [
      `activation-target-gross-${randomUUID()}`,
      activationTargetTransactionId,
      activationTargetRefundId,
      activationProjection.allocation_algorithm_version,
      activationProjection.classifier_version,
      activationTargetFingerprint,
      `activation-target-fee-${randomUUID()}`,
      `activation-sibling-gross-${randomUUID()}`,
      activationSiblingTransactionId,
      activationSiblingRefundId,
      activationSiblingFingerprint,
      `activation-sibling-fee-${randomUUID()}`
    ])).rows;
    const activationSetId = (
      refundId: string,
      basis: 'gross_amount' | 'fee'
    ) => activationSets.find(
      (row) => row.source_internal_id === refundId && row.basis === basis
    )!.id;
    const activationTargetGrossSetId = activationSetId(
      activationTargetRefundId,
      'gross_amount'
    );
    const activationTargetFeeSetId = activationSetId(
      activationTargetRefundId,
      'fee'
    );
    const activationSiblingGrossSetId = activationSetId(
      activationSiblingRefundId,
      'gross_amount'
    );
    const activationSiblingFeeSetId = activationSetId(
      activationSiblingRefundId,
      'fee'
    );
    await ownerDatabaseClient.pool.query(`
      insert into financial_item_allocations (
        allocation_set_id, order_item_id, component, effect_minor, currency,
        tie_break_key
      ) values
        ($1, $2, 'refund_subtotal', -90, 'USD', $3),
        ($1, $2, 'refund_tax', -10, 'USD', $4),
        ($5, $2, 'refund_subtotal', -40, 'USD', $6),
        ($5, $2, 'refund_tax', -10, 'USD', $7)
    `, [
      activationTargetGrossSetId,
      activationOrderItem.id,
      `activation-target-subtotal-${randomUUID()}`,
      `activation-target-tax-${randomUUID()}`,
      activationSiblingGrossSetId,
      `activation-sibling-subtotal-${randomUUID()}`,
      `activation-sibling-tax-${randomUUID()}`
    ]);
    const activationAllocations = (await ownerDatabaseClient.pool.query<{
      id: string;
      refund_id: string;
    }>(`
      insert into refund_allocations (
        refund_id, order_item_id, amount_minor, source
      ) values
        ($1, $2, 100, 'administrative'),
        ($3, $2, 50, 'automatic')
      returning id, refund_id
    `, [
      activationTargetRefundId,
      activationOrderItem.id,
      activationSiblingRefundId
    ])).rows;
    const activationTargetAllocationId = activationAllocations.find(
      (row) => row.refund_id === activationTargetRefundId
    )!.id;
    const activationSiblingAllocationId = activationAllocations.find(
      (row) => row.refund_id === activationSiblingRefundId
    )!.id;
    await ownerDatabaseClient.pool.query(`
      insert into refund_allocation_components (
        refund_allocation_id, refund_id, order_item_id, subtotal_minor,
        tax_minor, total_minor, currency
      ) values
        ($1, $2, $3, 90, 10, 100, 'USD'),
        ($4, $5, $3, 40, 10, 50, 'USD')
    `, [
      activationTargetAllocationId,
      activationTargetRefundId,
      activationOrderItem.id,
      activationSiblingAllocationId,
      activationSiblingRefundId
    ]);
    const activationCorrection = (await ownerDatabaseClient.pool.query<{
      id: string;
    }>(`
      insert into refund_reporting_correction_sets (
        refund_id, correction_version, kind, base_allocation_set_id,
        source_fingerprint_sha256, approved_by_admin_id, created_by_admin_id,
        correlation_id
      ) values (
        $1, 1, 'allocation_attribution_correction', $2, $3, $4, $4, $5
      ) returning id
    `, [
      activationTargetRefundId,
      activationTargetGrossSetId,
      activationTargetFingerprint,
      actorId,
      `activation-correction-${randomUUID()}`
    ])).rows[0]!;
    await ownerDatabaseClient.pool.query(`
      insert into refund_reporting_correction_items (
        correction_set_id, domain, source_allocation_set_id, order_item_id,
        component, currency, approved_absolute_minor, delta_minor,
        stable_tie_break_key
      ) values
        ($1, 'settlement', $2, $3, 'refund_subtotal', 'USD', -90, 0, $4),
        ($1, 'settlement', $2, $3, 'refund_tax', 'USD', -10, 0, $5)
    `, [
      activationCorrection.id,
      activationTargetGrossSetId,
      activationOrderItem.id,
      `activation-correction-subtotal-${randomUUID()}`,
      `activation-correction-tax-${randomUUID()}`
    ]);
    const activationPurchaseGrant = (await ownerDatabaseClient.pool.query<{
      id: string;
    }>(`
      insert into entitlement_grants (
        title_id, user_id, source, order_item_id, state, state_reason
      ) values ($1, $2, 'purchase', $3, 'active', 'paid')
      returning id
    `, [activationTitleId, actorId, activationOrderItem.id])).rows[0]!;
    const activationDraft = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into refund_allocation_drafts (
        refund_id, state, version, created_by_admin_id, updated_by_admin_id,
        created_correlation_id, updated_correlation_id
      ) values ($1, 'active', 1, $2, $2, $3, $3)
      returning id
    `, [
      activationTargetRefundId,
      actorId,
      `activation-draft-${randomUUID()}`
    ])).rows[0]!;
    await ownerDatabaseClient.pool.query(`
      insert into refund_allocation_draft_items (
        draft_id, order_item_id, proposed_total_presentment_minor
      ) values ($1, $2, 100)
    `, [activationDraft.id, activationOrderItem.id]);
    await ownerDatabaseClient.pool.query(`
      update refund_allocation_drafts
      set state = 'finalized', version = 2, finalized_at = clock_timestamp(),
        updated_at = clock_timestamp(), updated_by_admin_id = $2,
        updated_correlation_id = $3
      where id = $1
    `, [
      activationDraft.id,
      actorId,
      `activation-finalize-${randomUUID()}`
    ]);
    await ownerDatabaseClient.pool.query(`
      update entitlement_grants
      set state = 'revoked', state_reason = 'refunded',
        revoked_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = $1
    `, [activationPurchaseGrant.id]);
    const activationEffect = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into refund_allocation_finalization_effects (
        refund_id, refund_allocation_id, draft_id, draft_version, order_item_id,
        purchase_grant_id, before_purchase_grant_state, after_purchase_grant_state,
        before_effective_access, after_effective_access, transition, correlation_id
      ) values (
        $1, $2, $3, 2, $4, $5, 'active', 'revoked', true, false,
        'revoked_by_finalization', $6
      ) returning id
    `, [
      activationTargetRefundId,
      activationTargetAllocationId,
      activationDraft.id,
      activationOrderItem.id,
      activationPurchaseGrant.id,
      `activation-effect-${randomUUID()}`
    ])).rows[0]!;

    const activationHeads = (await ownerDatabaseClient.pool.query<{
      source_internal_id: string;
      basis: 'gross_amount' | 'fee';
      base_set_id: string;
      compatible_correction_tip_id: string | null;
      is_complete: boolean;
    }>(`
      select allocation.source_internal_id, head.basis, head.base_set_id,
        head.compatible_correction_tip_id, head.is_complete
      from current_financial_projection_heads head
      join financial_allocation_sets allocation on allocation.id = head.base_set_id
      where allocation.source_internal_id = any($1::uuid[])
      order by allocation.source_internal_id::text collate "C",
        case head.basis when 'gross_amount' then 1 else 2 end
    `, [[activationTargetRefundId, activationSiblingRefundId]])).rows;
    expect(activationHeads.filter(
      (head) => head.source_internal_id === activationTargetRefundId
    )).toEqual([
      expect.objectContaining({
        basis: 'gross_amount', base_set_id: activationTargetGrossSetId,
        compatible_correction_tip_id: activationCorrection.id, is_complete: true
      }),
      expect.objectContaining({
        basis: 'fee', base_set_id: activationTargetFeeSetId,
        compatible_correction_tip_id: activationCorrection.id, is_complete: true
      })
    ]);
    expect(activationHeads.filter(
      (head) => head.source_internal_id === activationSiblingRefundId
    )).toEqual([
      expect.objectContaining({
        basis: 'gross_amount', base_set_id: activationSiblingGrossSetId,
        compatible_correction_tip_id: null, is_complete: true
      }),
      expect.objectContaining({
        basis: 'fee', base_set_id: activationSiblingFeeSetId,
        compatible_correction_tip_id: null, is_complete: true
      })
    ]);
    await expect(ownerDatabaseClient.pool.query(`
      select count(*)::integer as count
      from refund_reporting_correction_items
      where correction_set_id = $1 and domain = 'presentment'
    `, [activationCorrection.id])).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const activationEvidenceRows = [
      {
        refundId: activationTargetRefundId,
        allocationId: activationTargetAllocationId,
        subtotal: 90,
        tax: 10
      },
      {
        refundId: activationSiblingRefundId,
        allocationId: activationSiblingAllocationId,
        subtotal: 40,
        tax: 10
      }
    ].sort((left, right) => left.refundId < right.refundId ? -1 :
      left.refundId > right.refundId ? 1 : 0).flatMap((evidence) => [
      `presentment_evidence=${evidence.refundId}|base|${evidence.allocationId}|-|-|refund_subtotal|${evidence.subtotal}`,
      `presentment_evidence=${evidence.refundId}|base|${evidence.allocationId}|-|-|refund_tax|${evidence.tax}`
    ]);
    const activationPreviewPreimage = [
      'pale-orbit.admin-recovery-preview.v1',
      `refund_id=${activationTargetRefundId}`,
      `payment_id=${activationPayment.id}`,
      `order_id=${activationOrder.id}`,
      `finalization_effect_id=${activationEffect.id}`,
      `recovery_reference_id=${activationTargetAllocationId}`,
      `finalization_draft_id=${activationDraft.id}`,
      'finalization_draft_version=2',
      `order_item_id=${activationOrderItem.id}`,
      `title_id=${activationTitleId}`,
      `purchase_grant_id=${activationPurchaseGrant.id}`,
      'allocation_total_minor=100',
      'allocation_subtotal_minor=90',
      'allocation_tax_minor=10',
      'item_subtotal_minor=1000',
      'item_tax_minor=100',
      'item_total_minor=1100',
      'item_currency=USD',
      'existing_recovery_grant_id=-',
      'existing_recovery_grant_state=absent',
      'existing_recovery_grant_state_changed_at=-',
      `correction_set_id=${activationCorrection.id}`,
      'correction_version=1',
      'correction_kind=allocation_attribution_correction',
      `correction_base_set_id=${activationTargetGrossSetId}`,
      'correction_predecessor_correction_set_id=-',
      `correction_source_fingerprint_sha256=${activationTargetFingerprint}`,
      `projection_classifier_version=${activationProjection.classifier_version}`,
      `projection_allocation_algorithm_version=${activationProjection.allocation_algorithm_version}`,
      `source_balance_transaction_id=${activationTargetTransactionId}`,
      `source_fingerprint_sha256=${activationTargetFingerprint}`,
      'projection_head_count=2',
      `projection_head=gross_amount|${activationTargetGrossSetId}|${activationCorrection.id}|title|USD|-100|1|0|-`,
      `projection_head=fee|${activationTargetFeeSetId}|${activationCorrection.id}|title|USD|0|1|0|-`,
      'projection_item_count=2',
      `projection_item=gross_amount|${activationTargetGrossSetId}|${activationCorrection.id}|${activationOrderItem.id}|refund_subtotal|-90|USD`,
      `projection_item=gross_amount|${activationTargetGrossSetId}|${activationCorrection.id}|${activationOrderItem.id}|refund_tax|-10|USD`,
      'presentment_evidence_count=4',
      ...activationEvidenceRows,
      'cumulative_refund_subtotal_minor=130',
      'cumulative_refund_tax_minor=20',
      'cumulative_refund_total_minor=150',
      'remaining_unrefunded_minor=950',
      'effective_access_before=0',
      'effective_access_after=1',
      'access_changed=1',
      'email_queued=1',
      ''
    ].join('\n');
    const activationInput = {
      kind: 'administrative_recovery_activate',
      refundId: activationTargetRefundId,
      finalizationEffectId: activationEffect.id,
      orderItemId: activationOrderItem.id,
      expectedCorrectionSetId: activationCorrection.id,
      expectedCorrectionVersion: 1,
      expectedSourceFingerprint: activationTargetFingerprint,
      previewFingerprint: createHash('sha256')
        .update(activationPreviewPreimage, 'utf8').digest('hex'),
      confirmation: 'activate_persistent_recovery'
    };
    const activationCommand = await submit(
      'administrative_recovery_activate',
      activationInput,
      createHash('sha256').update('positive-mixed-recovery-activation').digest('hex'),
      createHash('sha256').update(JSON.stringify(activationInput)).digest('hex')
    );
    const activationJob = (await ownerDatabaseClient.pool.query<{ job_id: string }>(
      'select job_id from financial_admin_commands where id = $1',
      [activationCommand.command_id]
    )).rows[0]!;
    const claimedActivation = await claimExpectedCommandJob(
      activationJob.job_id,
      'financial-command-recovery-activation'
    );
    const activationCapability = claimedActivation.financialAdminLeaseCapability!;
    const activationTransition = await workerDatabaseClient.pool.connect();
    let activationRecoveryGrantId: string;
    try {
      await activationTransition.query('begin');
      await activationTransition.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        )
      `, [activationCapability]);
      const activated = await activationTransition.query<{
        recovery_grant_id: string;
        previous_state: string | null;
        next_state: string;
      }>(`
        select recovery_grant_id, previous_state, next_state
        from public.transition_administrative_recovery_grant_after_admin_command($1)
      `, [activationCommand.command_id]);
      expect(activated.rows).toEqual([{
        recovery_grant_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        previous_state: null,
        next_state: 'active'
      }]);
      activationRecoveryGrantId = activated.rows[0]!.recovery_grant_id;
      await activationTransition.query('commit');
    } catch (error) {
      await activationTransition.query('rollback');
      throw error;
    } finally {
      activationTransition.release();
    }
    if (activationRecoveryGrantId === undefined) {
      throw new Error('protected administrative recovery activation returned no grant');
    }
    await expect(ownerDatabaseClient.pool.query(`
      select source, recovery_refund_allocation_id, state, state_reason,
        user_id, title_id, order_item_id,
        updated_at = date_trunc('milliseconds', updated_at) as millisecond_exact
      from entitlement_grants where id = $1
    `, [activationRecoveryGrantId])).resolves.toMatchObject({ rows: [{
      source: 'administrative',
      recovery_refund_allocation_id: activationTargetAllocationId,
      state: 'active',
      state_reason: 'refund_allocation_recovery',
      user_id: actorId,
      title_id: activationTitleId,
      order_item_id: null,
      millisecond_exact: true
    }] });
    await expect(ownerDatabaseClient.pool.query(`
      select action, actor_id, resource_id, outcome
      from audit_events
      where action = 'financial.recovery_grant.activated'
        and "after" ->> 'commandId' = $1
    `, [activationCommand.command_id])).resolves.toMatchObject({ rows: [{
      action: 'financial.recovery_grant.activated',
      actor_id: actorId,
      resource_id: activationRecoveryGrantId,
      outcome: 'succeeded'
    }] });
    await transitionCommandSucceeded(
      activationCommand.command_id,
      activationJob.job_id,
      activationCapability,
      'recovery_activated',
      {
        recoveryGrantId: activationRecoveryGrantId,
        accessChanged: true,
        emailQueued: true
      }
    );
    await expect(commandRepository.complete(
      activationJob.job_id,
      'financial-command-recovery-activation',
      activationCapability
    )).resolves.toBe(true);

    const reportingCorrectionIssueId = randomUUID();
    await ownerDatabaseClient.pool.query(`
      insert into financial_reconciliation_issues (
        id, resource_type, resource_id, safe_code, impact, correlation_id
      ) values (
        $1, 'allocation_set', $2, 'correction_rebase_required', 'exception', $3
      )
    `, [
      reportingCorrectionIssueId,
      activationTargetGrossSetId,
      `reporting-correction-issue-${randomUUID()}`
    ]);
    const reportingCorrectionInput = {
      kind: 'refund_reporting_correction_create',
      refundId: activationTargetRefundId,
      reason: 'allocation_attribution_correction',
      expectedNextCorrectionVersion: 2,
      expectedBaseAllocationSetId: activationTargetGrossSetId,
      expectedSourceFingerprint: activationTargetFingerprint,
      items: [{ orderItemId: activationOrderItem.id, totalPresentmentMinor: 100 }],
      previewFingerprint: createHash('sha256')
        .update(`reporting-correction-preview:${activationTargetRefundId}`)
        .digest('hex'),
      confirmation: 'create_reporting_correction'
    };
    const reportingCorrectionCommand = await submit(
      'refund_reporting_correction_create',
      reportingCorrectionInput,
      createHash('sha256').update('reporting-correction-positive').digest('hex'),
      createHash('sha256').update(JSON.stringify(reportingCorrectionInput)).digest('hex')
    );
    const reportingCorrectionJob = (await ownerDatabaseClient.pool.query<{
      job_id: string;
    }>(`
      select job_id from financial_admin_commands where id = $1
    `, [reportingCorrectionCommand.command_id])).rows[0]!;
    const claimedReportingCorrection = await claimExpectedCommandJob(
      reportingCorrectionJob.job_id,
      'financial-command-reporting-correction'
    );
    const reportingCorrectionCapability =
      claimedReportingCorrection.financialAdminLeaseCapability!;
    const reportingCorrectionSideEffects = async () => (await ownerDatabaseClient.pool.query<{
      issue_state: string;
      correction_count: number;
      audit_count: number;
    }>(`
      select
        (select state::text from financial_reconciliation_issues where id = $1)
          as issue_state,
        (select count(*)::integer from refund_reporting_correction_sets
          where refund_id = $2) as correction_count,
        (select count(*)::integer from audit_events
          where action = 'financial.issue.resolved'
            and "after" ->> 'commandId' = $3) as audit_count
    `, [
      reportingCorrectionIssueId,
      activationTargetRefundId,
      reportingCorrectionCommand.command_id
    ])).rows[0]!;
    const correctionSideEffectsBefore = await reportingCorrectionSideEffects();

    const wrongRowTransition = await workerDatabaseClient.pool.connect();
    try {
      await wrongRowTransition.query('begin');
      await wrongRowTransition.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        )
      `, [reportingCorrectionCapability]);
      await wrongRowTransition.query(`
        insert into refund_reporting_correction_sets (
          refund_id, correction_version, kind, base_allocation_set_id,
          predecessor_correction_set_id, source_fingerprint_sha256,
          approved_by_admin_id, created_by_admin_id, correlation_id
        ) values (
          $1, 2, 'allocation_attribution_correction', $2, $3, $4,
          $5, $5, $6
        )
      `, [
        activationTargetRefundId,
        activationTargetGrossSetId,
        activationCorrection.id,
        activationTargetFingerprint,
        actorId,
        `wrong-command-correlation-${randomUUID()}`
      ]);
      await expect(wrongRowTransition.query(`
        select * from
          public.resolve_financial_issue_after_reporting_correction_command($1,$2)
      `, [reportingCorrectionCommand.command_id, reportingCorrectionIssueId]))
        .rejects.toMatchObject({ code: '55000' });
    } finally {
      await wrongRowTransition.query('rollback');
      wrongRowTransition.release();
    }
    expect(await reportingCorrectionSideEffects()).toEqual(correctionSideEffectsBefore);

    const wrongTopologyTransition = await workerDatabaseClient.pool.connect();
    try {
      await wrongTopologyTransition.query('begin');
      await wrongTopologyTransition.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        )
      `, [reportingCorrectionCapability]);
      const wrongTopologyTip = (await wrongTopologyTransition.query<{ id: string }>(`
        insert into refund_reporting_correction_sets (
          refund_id, correction_version, kind, base_allocation_set_id,
          predecessor_correction_set_id, source_fingerprint_sha256,
          approved_by_admin_id, created_by_admin_id, correlation_id
        )
        select $1, 2, 'allocation_attribution_correction', $2, $3, $4,
          command.actor_user_id, command.actor_user_id, command.correlation_id
        from financial_admin_commands command where command.id = $5
        returning id
      `, [
        activationTargetRefundId,
        activationTargetGrossSetId,
        activationCorrection.id,
        activationTargetFingerprint,
        reportingCorrectionCommand.command_id
      ])).rows[0]!;
      await wrongTopologyTransition.query(`
        insert into refund_reporting_correction_sets (
          refund_id, correction_version, kind, base_allocation_set_id,
          predecessor_correction_set_id, source_fingerprint_sha256,
          approved_by_admin_id, created_by_admin_id, correlation_id
        ) values (
          $1, 3, 'allocation_attribution_correction', $2, $3, $4,
          $5, $5, $6
        )
      `, [
        activationTargetRefundId,
        activationTargetGrossSetId,
        wrongTopologyTip.id,
        activationTargetFingerprint,
        actorId,
        `wrong-topology-${randomUUID()}`
      ]);
      await expect(wrongTopologyTransition.query(`
        select * from
          public.resolve_financial_issue_after_reporting_correction_command($1,$2)
      `, [reportingCorrectionCommand.command_id, reportingCorrectionIssueId]))
        .rejects.toMatchObject({ code: '55000' });
    } finally {
      await wrongTopologyTransition.query('rollback');
      wrongTopologyTransition.release();
    }
    expect(await reportingCorrectionSideEffects()).toEqual(correctionSideEffectsBefore);

    const presentmentSubtotalTie =
      `presentment:${activationOrderItem.id}:refund_subtotal`;
    const presentmentTaxTie = `presentment:${activationOrderItem.id}:refund_tax`;
    const settlementSubtotalTie =
      `settlement:gross:${activationOrderItem.id}:refund_subtotal`;
    const settlementTaxTie = `settlement:gross:${activationOrderItem.id}:refund_tax`;
    const validDirectProofItems = [
      {
        domain: 'presentment', sourceAllocationSetId: null,
        component: 'refund_subtotal', approvedAbsoluteMinor: 90,
        deltaMinor: 0, stableTieBreakKey: presentmentSubtotalTie
      },
      {
        domain: 'presentment', sourceAllocationSetId: null,
        component: 'refund_tax', approvedAbsoluteMinor: 10,
        deltaMinor: 0, stableTieBreakKey: presentmentTaxTie
      },
      {
        domain: 'settlement', sourceAllocationSetId: activationTargetGrossSetId,
        component: 'refund_subtotal', approvedAbsoluteMinor: -90,
        deltaMinor: 0, stableTieBreakKey: settlementSubtotalTie
      },
      {
        domain: 'settlement', sourceAllocationSetId: activationTargetGrossSetId,
        component: 'refund_tax', approvedAbsoluteMinor: -10,
        deltaMinor: 0, stableTieBreakKey: settlementTaxTie
      }
    ] as const;
    const insertDirectProofItems = async (
      client: PoolClient,
      correctionSetId: string,
      items: ReadonlyArray<{
        domain: string;
        sourceAllocationSetId: string | null;
        component: string;
        approvedAbsoluteMinor: number;
        deltaMinor: number;
        stableTieBreakKey: string;
      }>
    ): Promise<void> => {
      await client.query(`
        insert into refund_reporting_correction_items (
          correction_set_id, domain, source_allocation_set_id, order_item_id,
          component, currency, approved_absolute_minor, delta_minor,
          stable_tie_break_key
        )
        select $1, item.domain::refund_correction_domain,
          item.source_allocation_set_id::uuid, $2,
          item.component::financial_component, 'USD',
          item.approved_absolute_minor, item.delta_minor, item.stable_tie_break_key
        from pg_catalog.jsonb_to_recordset($3::jsonb) item(
          domain text, source_allocation_set_id text, component text,
          approved_absolute_minor integer, delta_minor integer,
          stable_tie_break_key text
        )
      `, [correctionSetId, activationOrderItem.id, JSON.stringify(items.map((item) => ({
        domain: item.domain,
        source_allocation_set_id: item.sourceAllocationSetId,
        component: item.component,
        approved_absolute_minor: item.approvedAbsoluteMinor,
        delta_minor: item.deltaMinor,
        stable_tie_break_key: item.stableTieBreakKey
      })))]);
    };
    const expectDirectProofRejection = async (
      label: string,
      items: Parameters<typeof insertDirectProofItems>[2],
      prepare?: (client: PoolClient) => Promise<void>
    ): Promise<void> => {
      const transition = await workerDatabaseClient.pool.connect();
      try {
        await transition.query('begin');
        await transition.query(`
          select pg_catalog.set_config(
            'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
          )
        `, [reportingCorrectionCapability]);
        await prepare?.(transition);
        const correction = (await transition.query<{ id: string }>(`
          insert into refund_reporting_correction_sets (
            refund_id, correction_version, kind, base_allocation_set_id,
            predecessor_correction_set_id, source_fingerprint_sha256,
            approved_by_admin_id, created_by_admin_id, correlation_id
          )
          select $1, 2, 'allocation_attribution_correction', $2, $3, $4,
            command.actor_user_id, command.actor_user_id, command.correlation_id
          from financial_admin_commands command where command.id = $5
          returning id
        `, [
          activationTargetRefundId,
          activationTargetGrossSetId,
          activationCorrection.id,
          activationTargetFingerprint,
          reportingCorrectionCommand.command_id
        ])).rows[0]!;
        await insertDirectProofItems(transition, correction.id, items);
        await expect(transition.query(`
          select * from
            public.resolve_financial_issue_after_reporting_correction_command($1,$2)
        `, [reportingCorrectionCommand.command_id, reportingCorrectionIssueId]), label)
          .rejects.toMatchObject({ code: '55000' });
      } finally {
        await transition.query('rollback');
        transition.release();
      }
      expect(await reportingCorrectionSideEffects(), label)
        .toEqual(correctionSideEffectsBefore);
    };

    await expectDirectProofRejection('direct item arithmetic', [
      ...validDirectProofItems.slice(0, 2),
      { ...validDirectProofItems[2], approvedAbsoluteMinor: -89 },
      { ...validDirectProofItems[3], approvedAbsoluteMinor: -11 }
    ]);
    await expectDirectProofRejection('direct grouped conservation', [
      ...validDirectProofItems.slice(0, 2),
      { ...validDirectProofItems[2], approvedAbsoluteMinor: -89, deltaMinor: 1 },
      validDirectProofItems[3]
    ]);
    await expectDirectProofRejection('direct complete base coverage', [
      ...validDirectProofItems.slice(0, 2),
      { ...validDirectProofItems[2], approvedAbsoluteMinor: -100, deltaMinor: -10 }
    ]);
    await expectDirectProofRejection('direct representable fee basis', [
      ...validDirectProofItems,
      {
        domain: 'settlement', sourceAllocationSetId: activationTargetFeeSetId,
        component: 'refund_subtotal', approvedAbsoluteMinor: 1,
        deltaMinor: 1,
        stableTieBreakKey: `settlement:fee:${activationOrderItem.id}:refund_subtotal`
      },
      {
        domain: 'settlement', sourceAllocationSetId: activationTargetFeeSetId,
        component: 'refund_tax', approvedAbsoluteMinor: -1,
        deltaMinor: -1,
        stableTieBreakKey: `settlement:fee:${activationOrderItem.id}:refund_tax`
      }
    ]);
    await expectDirectProofRejection(
      'direct effective sibling capacity',
      validDirectProofItems,
      async (client) => {
        const overCapacityRefundId = randomUUID();
        await client.query(`
          insert into refunds (
            id, payment_id, stripe_refund_id, status, amount_minor, currency,
            provider_created_at, allocation_status
          ) values (
            $1, $2, $3, 'succeeded', 1000, 'USD', clock_timestamp(), 'finalized'
          )
        `, [
          overCapacityRefundId,
          activationPayment.id,
          `re_capacity_${randomUUID()}`
        ]);
        const overCapacityAllocation = (await client.query<{ id: string }>(`
          insert into refund_allocations (
            refund_id, order_item_id, amount_minor, source
          ) values ($1, $2, 1000, 'automatic') returning id
        `, [overCapacityRefundId, activationOrderItem.id])).rows[0]!;
        await client.query(`
          insert into refund_allocation_components (
            refund_allocation_id, refund_id, order_item_id, subtotal_minor,
            tax_minor, total_minor, currency
          ) values ($1, $2, $3, 900, 100, 1000, 'USD')
        `, [overCapacityAllocation.id, overCapacityRefundId, activationOrderItem.id]);
      }
    );

    const appendedReportingCorrection = (await ownerDatabaseClient.pool.query<{
      id: string;
    }>(`
      insert into refund_reporting_correction_sets (
        refund_id, correction_version, kind, base_allocation_set_id,
        predecessor_correction_set_id, source_fingerprint_sha256,
        approved_by_admin_id, created_by_admin_id, correlation_id
      )
      select $1, 2, 'allocation_attribution_correction', $2, $3, $4,
        command.actor_user_id, command.actor_user_id, command.correlation_id
      from financial_admin_commands command where command.id = $5
      returning id
    `, [
      activationTargetRefundId,
      activationTargetGrossSetId,
      activationCorrection.id,
      activationTargetFingerprint,
      reportingCorrectionCommand.command_id
    ])).rows[0]!;
    await ownerDatabaseClient.pool.query(`
      insert into refund_reporting_correction_items (
        correction_set_id, domain, source_allocation_set_id, order_item_id,
        component, currency, approved_absolute_minor, delta_minor,
        stable_tie_break_key
      ) values
        ($1, 'presentment', null, $2, 'refund_subtotal', 'USD', 90, 0, $3),
        ($1, 'presentment', null, $2, 'refund_tax', 'USD', 10, 0, $4),
        ($1, 'settlement', $5, $2, 'refund_subtotal', 'USD', -90, 0, $6),
        ($1, 'settlement', $5, $2, 'refund_tax', 'USD', -10, 0, $7)
    `, [
      appendedReportingCorrection.id,
      activationOrderItem.id,
      `presentment:${activationOrderItem.id}:refund_subtotal`,
      `presentment:${activationOrderItem.id}:refund_tax`,
      activationTargetGrossSetId,
      `settlement:gross:${activationOrderItem.id}:refund_subtotal`,
      `settlement:gross:${activationOrderItem.id}:refund_tax`
    ]);
    const outOfScopeCorrectionIssueId = randomUUID();
    await ownerDatabaseClient.pool.query(`
      insert into financial_reconciliation_issues (
        id, resource_type, resource_id, safe_code, impact, correlation_id
      ) values ($1, 'allocation_set', $2, 'allocation_mismatch', 'exception', $3)
    `, [
      outOfScopeCorrectionIssueId,
      activationSiblingGrossSetId,
      `out-of-scope-correction-issue-${randomUUID()}`
    ]);
    const outOfScopeTransition = await workerDatabaseClient.pool.connect();
    try {
      await outOfScopeTransition.query('begin');
      await outOfScopeTransition.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        )
      `, [reportingCorrectionCapability]);
      await expect(outOfScopeTransition.query(`
        select * from
          public.resolve_financial_issue_after_reporting_correction_command($1,$2)
      `, [reportingCorrectionCommand.command_id, outOfScopeCorrectionIssueId]))
        .rejects.toMatchObject({ code: '55000' });
    } finally {
      await outOfScopeTransition.query('rollback');
      outOfScopeTransition.release();
    }
    await expect(ownerDatabaseClient.pool.query(`
      select state, resolved_by_admin_id, resolved_at,
        (select count(*)::integer from audit_events
          where action = 'financial.issue.resolved'
            and resource_id = $1::text) as audit_count
      from financial_reconciliation_issues where id = $1::uuid
    `, [outOfScopeCorrectionIssueId])).resolves.toMatchObject({ rows: [{
      state: 'open',
      resolved_by_admin_id: null,
      resolved_at: null,
      audit_count: 0
    }] });
    await expect(ownerDatabaseClient.pool.query(`
      select base_set_id, compatible_correction_tip_id, is_complete,
        proposed_issue_code
      from current_financial_projection_heads
      where balance_transaction_id = $1 and basis = 'gross_amount'
    `, [activationTargetTransactionId])).resolves.toMatchObject({ rows: [{
      base_set_id: null,
      compatible_correction_tip_id: null,
      is_complete: false,
      proposed_issue_code: 'correction_rebase_required'
    }] });

    const correctionTransition = await workerDatabaseClient.pool.connect();
    try {
      await correctionTransition.query('begin');
      await correctionTransition.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        )
      `, [reportingCorrectionCapability]);
      await expect(correctionTransition.query<{
        id: string;
        state: string;
        resolved_by_admin_id: string;
      }>(`
        select id, state, resolved_by_admin_id
        from public.resolve_financial_issue_after_reporting_correction_command($1,$2)
      `, [reportingCorrectionCommand.command_id, reportingCorrectionIssueId]))
        .resolves.toMatchObject({ rows: [{
          id: reportingCorrectionIssueId,
          state: 'resolved',
          resolved_by_admin_id: actorId
        }] });
      await correctionTransition.query('commit');
    } catch (error) {
      await correctionTransition.query('rollback');
      throw error;
    } finally {
      correctionTransition.release();
    }
    await expect(ownerDatabaseClient.pool.query(`
      select basis, base_set_id, compatible_correction_tip_id, is_complete
      from current_financial_projection_heads
      where balance_transaction_id = $1
      order by case basis when 'gross_amount' then 1 else 2 end
    `, [activationTargetTransactionId])).resolves.toMatchObject({ rows: [
      {
        basis: 'gross_amount',
        base_set_id: activationTargetGrossSetId,
        compatible_correction_tip_id: appendedReportingCorrection.id,
        is_complete: true
      },
      {
        basis: 'fee',
        base_set_id: activationTargetFeeSetId,
        compatible_correction_tip_id: appendedReportingCorrection.id,
        is_complete: true
      }
    ] });
    await expect(ownerDatabaseClient.pool.query(`
      select action, actor_id, resource_id, outcome
      from audit_events
      where action = 'financial.issue.resolved'
        and "after" ->> 'commandId' = $1
    `, [reportingCorrectionCommand.command_id])).resolves.toMatchObject({ rows: [{
      action: 'financial.issue.resolved',
      actor_id: actorId,
      resource_id: reportingCorrectionIssueId,
      outcome: 'succeeded'
    }] });
    await transitionCommandSucceeded(
      reportingCorrectionCommand.command_id,
      reportingCorrectionJob.job_id,
      reportingCorrectionCapability,
      'correction_created',
      {
        refundId: activationTargetRefundId,
        correctionSetId: appendedReportingCorrection.id,
        correctionVersion: 2
      }
    );
    await expect(commandRepository.complete(
      reportingCorrectionJob.job_id,
      'financial-command-reporting-correction',
      reportingCorrectionCapability
    )).resolves.toBe(true);

    const resolvedRefundId = randomUUID();
    const crossLinkedRefundId = randomUUID();
    const resolverTitleId = randomUUID();
    await insertTitle(resolverTitleId);
    const resolverOrder = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into orders (
        status, initiating_user_id, purchase_email, currency, subtotal_minor,
        tax_minor, total_minor, client_checkout_attempt_id,
        quote_fingerprint_sha256, status_token_sha256, paid_at
      ) values (
        'paid', $1, $2, 'USD', 1000, 100, 1100, $3,
        repeat('1', 64), repeat('2', 64), clock_timestamp()
      ) returning id
    `, [
      actorId,
      `resolver-${resolvedRefundId}@example.com`,
      randomUUID()
    ])).rows[0]!;
    const resolverOrderItem = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into order_items (
        order_id, title_id, title_snapshot, creator_name_snapshot, format,
        currency, unit_subtotal_minor, tax_minor, total_minor
      ) values ($1, $2, 'Resolver title', 'Resolver author', 'prose',
        'USD', 1000, 100, 1100)
      returning id
    `, [resolverOrder.id, resolverTitleId])).rows[0]!;
    const resolverPayment = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into payments (
        order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
        amount_minor, currency, paid_at
      ) values ($1, $2, $3, 'succeeded', 1100, 'USD', clock_timestamp())
      returning id
    `, [
      resolverOrder.id,
      `pi_resolver_${randomUUID()}`,
      `ch_resolver_${randomUUID()}`
    ])).rows[0]!;
    const resolvedStripeRefundId = `re_resolver_${randomUUID()}`;
    const crossLinkedStripeRefundId = `re_cross_${randomUUID()}`;
    await ownerDatabaseClient.pool.query(`
      insert into refunds (
        id, payment_id, stripe_refund_id, status, amount_minor, currency,
        provider_created_at, allocation_status
      ) values
        ($1, $2, $3, 'succeeded', 100, 'USD', clock_timestamp(), 'finalized'),
        ($4, $2, $5, 'succeeded', 50, 'USD', clock_timestamp(), 'finalized')
    `, [
      resolvedRefundId,
      resolverPayment.id,
      resolvedStripeRefundId,
      crossLinkedRefundId,
      crossLinkedStripeRefundId
    ]);
    const resolverTransactions = (await ownerDatabaseClient.pool.query<{
      id: string;
      source_id: string;
    }>(`
      insert into stripe_balance_transactions (
        provider_id, live_mode, source_family, source_id, raw_type,
        reporting_category, balance_type, amount_minor, fee_minor, net_minor,
        currency, status, provider_created_at, available_at, fingerprint_sha256
      ) values
        ($1, false, 'refund', $2, 'refund', 'refund', 'payments',
          -100, 0, -100, 'USD', 'available', clock_timestamp(),
          clock_timestamp(), repeat('9', 64)),
        ($3, false, 'refund', $4, 'refund', 'refund', 'payments',
          -50, 0, -50, 'USD', 'available', clock_timestamp(),
          clock_timestamp(), repeat('8', 64))
      returning id, source_id
    `, [
      `txn_resolver_${randomUUID()}`,
      resolvedStripeRefundId,
      `txn_cross_${randomUUID()}`,
      crossLinkedStripeRefundId
    ])).rows;
    const resolvedBalanceTransactionId = resolverTransactions.find(
      (row) => row.source_id === resolvedStripeRefundId
    )!.id;
    const crossLinkedBalanceTransactionId = resolverTransactions.find(
      (row) => row.source_id === crossLinkedStripeRefundId
    )!.id;
    const resolverAllocationSets = (await ownerDatabaseClient.pool.query<{
      id: string;
      source_internal_id: string;
    }>(`
      insert into financial_allocation_sets (
        allocation_identity, balance_transaction_id, source_kind,
        source_internal_id, basis, scope, expected_effect_minor, currency,
        algorithm_version, classifier_version, source_fingerprint_sha256
      )
      select candidate.allocation_identity, candidate.balance_transaction_id,
        'refund', candidate.source_internal_id, 'gross_amount', 'title',
        candidate.expected_effect_minor, 'USD',
        projection.allocation_algorithm_version, projection.classifier_version,
        candidate.source_fingerprint_sha256
      from financial_projection_versions projection
      cross join (values
        ($1::text, $2::uuid, $3::uuid, -100, repeat('9', 64)),
        ($4::text, $5::uuid, $6::uuid, -50, repeat('8', 64))
      ) candidate(
        allocation_identity, balance_transaction_id, source_internal_id,
        expected_effect_minor, source_fingerprint_sha256
      )
      where projection.singleton = true
        and projection.pending_classifier_version is null
        and projection.pending_allocation_algorithm_version is null
        and projection.pending_replay_id is null
        and projection.pending_scan_run_id is null
      returning id, source_internal_id
    `, [
      `resolver-allocation-${randomUUID()}`,
      resolvedBalanceTransactionId,
      resolvedRefundId,
      `cross-allocation-${randomUUID()}`,
      crossLinkedBalanceTransactionId,
      crossLinkedRefundId
    ])).rows;
    const resolvedAllocationSetId = resolverAllocationSets.find(
      (row) => row.source_internal_id === resolvedRefundId
    )!.id;
    const crossLinkedAllocationSetId = resolverAllocationSets.find(
      (row) => row.source_internal_id === crossLinkedRefundId
    )!.id;
    const linkedRefundIssueId = randomUUID();
    const linkedSelectedSetIssueId = randomUUID();
    const crossLinkedSetIssueId = randomUUID();
    const retiredUnsupportedIssueId = randomUUID();
    const retiredClassificationId = randomUUID();
    const issueFixture = await ownerDatabaseClient.pool.connect();
    try {
      await issueFixture.query('begin');
      await issueFixture.query(`
        insert into financial_classification_versions (
          id, subject_type, subject_id, classifier_version, classification,
          source_fingerprint_sha256
        ) values (
          $1, 'balance_transaction', $2,
          (select classifier_version from financial_projection_versions
            where singleton = true),
          'unknown', repeat('9', 64)
        )
      `, [retiredClassificationId, resolvedBalanceTransactionId]);
      await issueFixture.query(`
        insert into financial_reconciliation_issues (
          id, resource_type, resource_id, safe_code, impact, correlation_id
        ) values
          ($1, 'refund', $2, 'allocation_mismatch', 'exception', $3),
          ($4, 'allocation_set', $5, 'allocation_mismatch', 'exception', $6),
          ($7, 'allocation_set', $8, 'allocation_mismatch', 'exception', $9),
          ($10, 'financial_classification', $11, 'unsupported_category',
            'exception', $12)
      `, [
        linkedRefundIssueId,
        resolvedRefundId,
        `linked-refund-issue-${randomUUID()}`,
        linkedSelectedSetIssueId,
        resolvedAllocationSetId,
        `linked-set-issue-${randomUUID()}`,
        crossLinkedSetIssueId,
        crossLinkedAllocationSetId,
        `cross-set-issue-${randomUUID()}`,
        retiredUnsupportedIssueId,
        retiredClassificationId,
        `retired-classification-issue-${randomUUID()}`
      ]);
      await issueFixture.query('commit');
    } catch (error) {
      await issueFixture.query('rollback');
      throw error;
    } finally {
      issueFixture.release();
    }
    const issueFinalizeInput = {
      kind: 'refund_allocation_finalize',
      refundId: resolvedRefundId,
      expectedActiveDraftVersion: 1,
      previewFingerprint: '9'.repeat(64),
      confirmation: 'finalize_refund_allocation'
    };
    const issueFinalizeCommand = await submit(
      'refund_allocation_finalize',
      issueFinalizeInput,
      '9'.repeat(64),
      '9'.repeat(64)
    );
    const issueFinalizeJob = (await ownerDatabaseClient.pool.query<{ job_id: string }>(
      'select job_id from financial_admin_commands where id = $1',
      [issueFinalizeCommand.command_id]
    )).rows[0]!;
    const claimedIssueFinalize = await claimExpectedCommandJob(
      issueFinalizeJob.job_id,
      'financial-command-issue-resolution'
    );
    const issueCapability = claimedIssueFinalize.financialAdminLeaseCapability!;
    const issueTransition = await workerDatabaseClient.pool.connect();
    try {
      for (const rejectedIssueId of [
        crossLinkedSetIssueId,
        retiredUnsupportedIssueId
      ]) {
        await issueTransition.query('begin');
        await issueTransition.query(`
          select pg_catalog.set_config(
            'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
          )
        `, [issueCapability]);
        await expect(issueTransition.query(`
          select * from public.resolve_financial_issue_after_admin_command($1,$2)
        `, [issueFinalizeCommand.command_id, rejectedIssueId]))
          .rejects.toMatchObject({ code: '55000' });
        await issueTransition.query('rollback');
      }
      await issueTransition.query('begin');
      await issueTransition.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        )
      `, [issueCapability]);
      await expect(issueTransition.query<{
        id: string;
        state: string;
        resolved_by_admin_id: string;
      }>(`
        select id, state, resolved_by_admin_id
        from public.resolve_financial_issue_after_admin_command($1,$2)
      `, [issueFinalizeCommand.command_id, linkedRefundIssueId])).resolves.toMatchObject({ rows: [{
        id: linkedRefundIssueId,
        state: 'resolved',
        resolved_by_admin_id: actorId
      }] });
      await expect(issueTransition.query<{
        id: string;
        state: string;
        resolved_by_admin_id: string;
      }>(`
        select id, state, resolved_by_admin_id
        from public.resolve_financial_issue_after_admin_command($1,$2)
      `, [issueFinalizeCommand.command_id, linkedSelectedSetIssueId]))
        .resolves.toMatchObject({ rows: [{
          id: linkedSelectedSetIssueId,
          state: 'resolved',
          resolved_by_admin_id: actorId
        }] });
      await issueTransition.query('commit');
    } catch (error) {
      await issueTransition.query('rollback');
      throw error;
    } finally {
      issueTransition.release();
    }
    await transitionCommandSucceeded(
      issueFinalizeCommand.command_id,
      issueFinalizeJob.job_id,
      issueCapability,
      'allocation_finalized',
      {
        refundId: resolvedRefundId,
        finalizedDraftVersion: 2,
        accessChanged: false,
        emailQueued: false
      }
    );
    await expect(commandRepository.complete(
      issueFinalizeJob.job_id,
      'financial-command-issue-resolution',
      issueCapability
    )).resolves.toBe(true);

    const recoveryAllocation = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
      values ($1, $2, 100, 'administrative')
      returning id
    `, [resolvedRefundId, resolverOrderItem.id])).rows[0]!;
    const recoveryPurchaseGrant = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into entitlement_grants (
        title_id, user_id, source, order_item_id, state, state_reason
      ) values ($1, $2, 'purchase', $3, 'active', 'paid')
      returning id
    `, [resolverTitleId, actorId, resolverOrderItem.id])).rows[0]!;
    const recoveryDraft = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into refund_allocation_drafts (
        refund_id, state, version, created_by_admin_id, updated_by_admin_id,
        created_correlation_id, updated_correlation_id
      ) values ($1, 'active', 1, $2, $2, $3, $3)
      returning id
    `, [
      resolvedRefundId,
      actorId,
      `recovery-draft-${randomUUID()}`
    ])).rows[0]!;
    await ownerDatabaseClient.pool.query(`
      insert into refund_allocation_draft_items (
        draft_id, order_item_id, proposed_total_presentment_minor
      ) values ($1, $2, 100)
    `, [recoveryDraft.id, resolverOrderItem.id]);
    await ownerDatabaseClient.pool.query(`
      update refund_allocation_drafts
      set state = 'finalized', version = 2, finalized_at = clock_timestamp(),
        updated_at = clock_timestamp(), updated_by_admin_id = $2,
        updated_correlation_id = $3
      where id = $1
    `, [recoveryDraft.id, actorId, `recovery-finalize-${randomUUID()}`]);
    await ownerDatabaseClient.pool.query(`
      update entitlement_grants
      set state = 'revoked', state_reason = 'refunded',
        revoked_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = $1
    `, [recoveryPurchaseGrant.id]);
    const recoveryEffect = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into refund_allocation_finalization_effects (
        refund_id, refund_allocation_id, draft_id, draft_version, order_item_id,
        purchase_grant_id, before_purchase_grant_state, after_purchase_grant_state,
        before_effective_access, after_effective_access, transition, correlation_id
      ) values (
        $1, $2, $3, 2, $4, $5, 'active', 'revoked', true, false,
        'revoked_by_finalization', $6
      ) returning id
    `, [
      resolvedRefundId,
      recoveryAllocation.id,
      recoveryDraft.id,
      resolverOrderItem.id,
      recoveryPurchaseGrant.id,
      `recovery-effect-${randomUUID()}`
    ])).rows[0]!;
    expect(recoveryEffect.id).toMatch(/^[0-9a-f-]{36}$/u);

    const recoveryFixture = await ownerDatabaseClient.pool.connect();
    let recoveryGrant: { id: string; state_changed_at: string };
    try {
      await recoveryFixture.query('begin');
      await recoveryFixture.query(`set local session_replication_role = replica`);
      recoveryGrant = (await recoveryFixture.query<{
        id: string;
        state_changed_at: string;
      }>(`
        with fixture_clock as (
          select date_trunc('milliseconds', clock_timestamp()) as state_changed_at
        ), inserted as (
          insert into entitlement_grants (
            title_id, user_id, source, recovery_refund_allocation_id, state,
            state_reason, granted_at, created_at, updated_at
          )
          select $1, $2, 'administrative', $3, 'active',
            'refund_allocation_recovery', state_changed_at, state_changed_at,
            state_changed_at
          from fixture_clock
          returning id, updated_at
        )
        select id, to_char(timezone('UTC', updated_at),
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as state_changed_at
        from inserted
      `, [resolverTitleId, actorId, recoveryAllocation.id])).rows[0]!;
      await recoveryFixture.query('commit');
    } catch (error) {
      await recoveryFixture.query('rollback');
      throw error;
    } finally {
      recoveryFixture.release();
    }
    if (recoveryGrant === undefined) {
      throw new Error('administrative recovery grant fixture did not return a row');
    }
    const deactivationInput = {
      kind: 'administrative_recovery_deactivate',
      recoveryGrantId: recoveryGrant.id,
      recoveryReferenceId: recoveryAllocation.id,
      expectedStateChangedAt: recoveryGrant.state_changed_at,
      confirmation: 'deactivate_persistent_recovery'
    };
    const deactivationCommand = await submit(
      'administrative_recovery_deactivate',
      deactivationInput,
      createHash('sha256').update('positive-recovery-deactivation').digest('hex'),
      createHash('sha256').update(JSON.stringify(deactivationInput)).digest('hex')
    );
    const deactivationJob = (await ownerDatabaseClient.pool.query<{ job_id: string }>(
      'select job_id from financial_admin_commands where id = $1',
      [deactivationCommand.command_id]
    )).rows[0]!;
    const claimedDeactivation = await claimExpectedCommandJob(
      deactivationJob.job_id,
      'financial-command-recovery-deactivation'
    );
    const deactivationCapability = claimedDeactivation.financialAdminLeaseCapability!;
    const recoveryTransition = await workerDatabaseClient.pool.connect();
    try {
      await recoveryTransition.query('begin');
      await recoveryTransition.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        )
      `, [deactivationCapability]);
      await expect(recoveryTransition.query(`
        select recovery_grant_id, previous_state, next_state,
          state_changed_at = date_trunc('milliseconds', state_changed_at) as millisecond_exact
        from public.transition_administrative_recovery_grant_after_admin_command($1)
      `, [deactivationCommand.command_id])).resolves.toMatchObject({ rows: [{
        recovery_grant_id: recoveryGrant.id,
        previous_state: 'active',
        next_state: 'revoked',
        millisecond_exact: true
      }] });
      await recoveryTransition.query('commit');
    } catch (error) {
      await recoveryTransition.query('rollback');
      throw error;
    } finally {
      recoveryTransition.release();
    }
    await expect(ownerDatabaseClient.pool.query(`
      select state, revoked_at = updated_at as timestamps_match,
        updated_at = date_trunc('milliseconds', updated_at) as millisecond_exact
      from entitlement_grants where id = $1
    `, [recoveryGrant.id])).resolves.toMatchObject({ rows: [{
      state: 'revoked', timestamps_match: true, millisecond_exact: true
    }] });
    await expect(ownerDatabaseClient.pool.query(`
      select action, actor_id, resource_id, outcome
      from audit_events
      where action = 'financial.recovery_grant.deactivated'
        and "after" ->> 'commandId' = $1
    `, [deactivationCommand.command_id])).resolves.toMatchObject({
      rows: [{
        action: 'financial.recovery_grant.deactivated', actor_id: actorId,
        resource_id: recoveryGrant.id, outcome: 'succeeded'
      }]
    });
    await transitionCommandSucceeded(
      deactivationCommand.command_id,
      deactivationJob.job_id,
      deactivationCapability,
      'recovery_deactivated',
      { recoveryGrantId: recoveryGrant.id, accessChanged: true, emailQueued: false }
    );
    await expect(commandRepository.complete(
      deactivationJob.job_id,
      'financial-command-recovery-deactivation',
      deactivationCapability
    )).resolves.toBe(true);

    const staleDeactivationCommand = await submit(
      'administrative_recovery_deactivate',
      deactivationInput,
      createHash('sha256').update('stale-recovery-deactivation').digest('hex'),
      createHash('sha256').update(`stale:${JSON.stringify(deactivationInput)}`).digest('hex')
    );
    const staleDeactivationJob = (await ownerDatabaseClient.pool.query<{ job_id: string }>(
      'select job_id from financial_admin_commands where id = $1',
      [staleDeactivationCommand.command_id]
    )).rows[0]!;
    const claimedStaleDeactivation = await claimExpectedCommandJob(
      staleDeactivationJob.job_id,
      'financial-command-stale-recovery-deactivation'
    );
    const staleDeactivationCapability =
      claimedStaleDeactivation.financialAdminLeaseCapability!;
    const staleRecoveryTransition = await workerDatabaseClient.pool.connect();
    try {
      await staleRecoveryTransition.query('begin');
      await staleRecoveryTransition.query(`
        select pg_catalog.set_config(
          'pale_orbit.plan6bii_financial_admin_job_capability', $1, true
        )
      `, [staleDeactivationCapability]);
      await expect(staleRecoveryTransition.query(`
        select * from public.transition_administrative_recovery_grant_after_admin_command($1)
      `, [staleDeactivationCommand.command_id])).rejects.toMatchObject({ code: '40001' });
    } finally {
      await staleRecoveryTransition.query('rollback');
      staleRecoveryTransition.release();
    }
    await expect(commandRepository.fail(
      staleDeactivationJob.job_id,
      'financial-command-stale-recovery-deactivation',
      'stale administrative recovery state',
      false,
      staleDeactivationCapability
    )).resolves.toBe(true);

    const finalizeInput = {
      kind: 'refund_allocation_finalize',
      refundId: randomUUID(),
      expectedActiveDraftVersion: 1,
      previewFingerprint: 'e'.repeat(64),
      confirmation: 'finalize_refund_allocation'
    };
    const finalizeCommand = await submit(
      'refund_allocation_finalize', finalizeInput, '4'.repeat(64), 'e'.repeat(64)
    );
    const recoveryInput = {
      kind: 'administrative_recovery_activate',
      refundId: randomUUID(),
      finalizationEffectId: randomUUID(),
      orderItemId: randomUUID(),
      expectedCorrectionSetId: randomUUID(),
      expectedCorrectionVersion: 1,
      expectedSourceFingerprint: 'f'.repeat(64),
      previewFingerprint: '0'.repeat(64),
      confirmation: 'activate_persistent_recovery'
    };
    const recoveryCommand = await submit(
      'administrative_recovery_activate', recoveryInput, '5'.repeat(64), 'f'.repeat(64)
    );
    const guardedCorrectionInput = {
      kind: 'refund_reporting_correction_create',
      refundId: randomUUID(),
      reason: 'allocation_attribution_correction',
      expectedNextCorrectionVersion: 1,
      expectedBaseAllocationSetId: randomUUID(),
      expectedSourceFingerprint: '6'.repeat(64),
      items: [{ orderItemId: randomUUID(), totalPresentmentMinor: 1 }],
      previewFingerprint: '7'.repeat(64),
      confirmation: 'create_reporting_correction'
    };
    const guardedCorrectionCommand = await submit(
      'refund_reporting_correction_create',
      guardedCorrectionInput,
      createHash('sha256').update('guarded-correction-idempotency').digest('hex'),
      createHash('sha256').update('guarded-correction-fingerprint').digest('hex')
    );
    await expect(workerDatabaseClient.pool.query(
      `select * from
        public.resolve_financial_issue_after_reporting_correction_command($1,$2)`,
      [guardedCorrectionCommand.command_id, randomUUID()]
    )).rejects.toMatchObject({ code: '55000' });
    await expect(databaseClient.pool.query(
      `select * from
        public.resolve_financial_issue_after_reporting_correction_command($1,$2)`,
      [guardedCorrectionCommand.command_id, randomUUID()]
    )).rejects.toMatchObject({ code: '42501' });
    await expect(workerDatabaseClient.pool.query<{
      id: string;
    }>(`
      select id from
        public.resolve_financial_issue_after_reporting_correction_command($1,$2)
    `, [finalizeCommand.command_id, randomUUID()])).resolves.toMatchObject({ rows: [] });
    const demotion = await ownerDatabaseClient.pool.connect();
    try {
      await demotion.query('begin');
      await demotion.query(
        `select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
      );
      await demotion.query(
        `delete from user_roles where user_id = $1 and role = 'admin'`, [actorId]
      );
      await demotion.query('commit');
    } catch (error) {
      await demotion.query('rollback');
      throw error;
    } finally {
      demotion.release();
    }
    await expect(workerDatabaseClient.pool.query(
      `select * from public.resolve_financial_issue_after_admin_command($1,$2)`,
      [finalizeCommand.command_id, randomUUID()]
    )).rejects.toMatchObject({ code: '42501' });
    await expect(workerDatabaseClient.pool.query(
      `select * from
        public.resolve_financial_issue_after_reporting_correction_command($1,$2)`,
      [guardedCorrectionCommand.command_id, randomUUID()]
    )).rejects.toMatchObject({ code: '42501' });
    await expect(workerDatabaseClient.pool.query(
      `select * from public.transition_administrative_recovery_grant_after_admin_command($1)`,
      [recoveryCommand.command_id]
    )).rejects.toMatchObject({ code: '42501' });
    await expect(databaseClient.pool.query(
      `select * from public.financial_admin_command_status($1,$2)`,
      [actorId, finalizeCommand.command_id]
    )).rejects.toMatchObject({ code: '42501' });
  }, 60_000);

  it('rearms only the exact exhausted job derived from a pending Stripe event', async () => {
    const event = (await databaseClient.pool.query<{ id: string }>(`
      insert into stripe_events (
        provider_event_id, event_type, object_id, live_mode, provider_created_at, raw_body_sha256
      ) values (
        'evt_rearm_boundary_9301', 'checkout.session.completed', 'cs_rearm_boundary_9301',
        false, clock_timestamp(), repeat('3', 64)
      ) returning id
    `)).rows[0]!;
    const job = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into jobs (
        type, payload, deduplication_key, status, run_at, attempts, max_attempts,
        last_error, completed_at
      ) values (
        'commerce.stripe-event', $1::jsonb, 'stripe:event:evt_rearm_boundary_9301',
        'failed', clock_timestamp() - interval '1 hour', 12, 12,
        'safe exhausted error', clock_timestamp()
      ) returning id
    `, [JSON.stringify({ stripeEventId: event.id })])).rows[0]!;

    const rearmed = await databaseClient.pool.query<{ rearmed: boolean }>(`
      select public.rearm_pending_stripe_event_job($1::uuid) as rearmed
    `, [event.id]);
    expect(rearmed.rows).toEqual([{ rearmed: true }]);
    const state = await ownerDatabaseClient.pool.query<{
      status: string; attempts: number; max_attempts: number; locked_at: Date | null;
      locked_by: string | null; last_error: string | null; completed_at: Date | null;
      rerun_requested_at: Date | null;
    }>(`
      select status, attempts, max_attempts, locked_at, locked_by, last_error,
        completed_at, rerun_requested_at
      from jobs where id = $1
    `, [job.id]);
    expect(state.rows).toEqual([{
      status: 'pending', attempts: 0, max_attempts: 12, locked_at: null,
      locked_by: null, last_error: null, completed_at: null, rerun_requested_at: null
    }]);
    await expect(databaseClient.pool.query(`
      select public.rearm_pending_stripe_event_job($1::uuid)
    `, [event.id])).resolves.toMatchObject({ rows: [{ rearm_pending_stripe_event_job: false }] });

    const mismatchedEvent = (await databaseClient.pool.query<{ id: string }>(`
      insert into stripe_events (
        provider_event_id, event_type, object_id, live_mode, provider_created_at, raw_body_sha256
      ) values (
        'evt_rearm_boundary_9302', 'refund.updated', 're_rearm_boundary_9302',
        false, clock_timestamp(), repeat('4', 64)
      ) returning id
    `)).rows[0]!;
    await ownerDatabaseClient.pool.query(`
      insert into jobs (
        type, payload, deduplication_key, status, run_at, attempts, max_attempts,
        last_error, completed_at
      ) values (
        'commerce.financial-source', '{"sourceKind":"refund"}'::jsonb,
        'stripe:event:evt_rearm_boundary_9302', 'failed', clock_timestamp(), 12, 12,
        'mismatched identity', clock_timestamp()
      )
    `);
    await expect(databaseClient.pool.query(`
      select public.rearm_pending_stripe_event_job($1::uuid)
    `, [mismatchedEvent.id])).rejects.toMatchObject({ code: '55000' });
  });

  it('separates outbox production from worker-owned delivery lifecycle fields', async () => {
    const outboxId = '00000000-0000-4000-8000-000000009401';
    const dispatchJob = (await databaseClient.pool.query<{ id: string }>(`
      insert into jobs (type, payload, deduplication_key, run_at, max_attempts)
      values (
        'outbox.dispatch', $1::jsonb, $2, transaction_timestamp(), 8
      ) returning id
    `, [JSON.stringify({ outboxId }), `outbox:${outboxId}`])).rows[0]!;
    await expect(databaseClient.pool.query(`
      insert into outbox_messages (id, topic, payload, deduplication_key, dispatch_job_id)
      values ($1, 'email.auth.v1', '{"version":1}'::jsonb, null, $2)
    `, [outboxId, dispatchJob.id])).resolves.toMatchObject({ rowCount: 1 });

    await expect(databaseClient.pool.query(`
      update outbox_messages
      set status = 'delivered', delivered_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = $1
    `, [outboxId])).rejects.toMatchObject({ code: '42501' });
    await expect(databaseClient.pool.query(
      'delete from outbox_messages where id = $1', [outboxId]
    )).rejects.toMatchObject({ code: '42501' });
    await expect(workerDatabaseClient.pool.query(`
      update outbox_messages
      set status = 'delivered', last_error = null, delivered_at = clock_timestamp(),
        updated_at = clock_timestamp()
      where id = $1
    `, [outboxId])).resolves.toMatchObject({ rowCount: 1 });
    await expect(workerDatabaseClient.pool.query(`
      update outbox_messages set payload = '{"forged":true}'::jsonb where id = $1
    `, [outboxId])).rejects.toMatchObject({ code: '42501' });

    const unrelatedJob = (await ownerDatabaseClient.pool.query<{ id: string }>(`
      insert into jobs (type, payload, deduplication_key)
      values (
        'outbox.dispatch', '{"outboxId":"00000000-0000-4000-8000-000000009499"}'::jsonb,
        'outbox:00000000-0000-4000-8000-000000009499'
      ) returning id
    `)).rows[0]!;
    await expect(databaseClient.pool.query(`
      insert into outbox_messages (id, topic, payload, deduplication_key, dispatch_job_id)
      values (
        '00000000-0000-4000-8000-000000009498', 'email.auth.v1', '{}', null, $1
      )
    `, [unrelatedJob.id])).rejects.toMatchObject({ code: '55000' });
  });

  it('guards web revision chronology while reserving derived ingestion rows for workers', async () => {
    const titleId = '00000000-0000-4000-8000-000000009501';
    const sectionId = '00000000-0000-4000-8000-000000009502';
    const blockId = '00000000-0000-4000-8000-000000009503';
    await insertTitle(titleId);
    const revision = (await databaseClient.pool.query<{ id: string }>(`
      insert into title_revisions (
        title_id, parent_revision_id, created_by_actor_id, change_summary,
        staging_storage_key, staging_checksum_sha256, staging_byte_size,
        upload_filename, upload_mime_type
      ) values (
        $1, null, 'boundary-admin', 'Boundary revision', 'staging/revision-9501.epub',
        repeat('5', 64), 512, 'revision-9501.epub', 'application/epub+zip'
      ) returning id
    `, [titleId])).rows[0]!;

    const retryRevision = (await databaseClient.pool.query<{ id: string }>(`
      insert into title_revisions (
        title_id, parent_revision_id, created_by_actor_id, change_summary,
        staging_storage_key, staging_checksum_sha256, staging_byte_size,
        upload_filename, upload_mime_type
      ) values (
        $1, $2, 'boundary-admin', 'Retry revision', 'staging/retry-9501.epub',
        repeat('6', 64), 256, 'retry-9501.epub', 'application/epub+zip'
      ) returning id
    `, [titleId, revision.id])).rows[0]!;
    await workerDatabaseClient.pool.query(`
      update title_revisions
      set state = 'failed', processing_started_at = clock_timestamp(),
        processed_at = clock_timestamp(), failure_code = 'invalid_archive',
        failure_details = 'Safe failure'
      where id = $1
    `, [retryRevision.id]);
    await expect(databaseClient.pool.query(`
      update title_revisions
      set state = 'uploaded', staging_storage_key = 'staging/retry-9501-v2.epub',
        ingestion_generation = 1, processing_started_at = null, processed_at = null,
        failure_code = null, failure_details = null
      where id = $1
    `, [retryRevision.id])).resolves.toMatchObject({ rowCount: 1 });
    await workerDatabaseClient.pool.query(`
      update title_revisions
      set state = 'failed', processing_started_at = clock_timestamp(),
        processed_at = clock_timestamp(), failure_code = 'invalid_archive',
        failure_details = 'Safe failure'
      where id = $1
    `, [retryRevision.id]);
    await expect(databaseClient.pool.query(`
      update title_revisions
      set state = 'uploaded', staging_storage_key = 'staging/retry-9501-v3.epub',
        ingestion_generation = 3, processing_started_at = null, processed_at = null,
        failure_code = null, failure_details = null
      where id = $1
    `, [retryRevision.id])).rejects.toMatchObject({ code: '55000' });

    await expect(databaseClient.pool.query(`
      update title_revisions
      set state = 'active', activated_at = clock_timestamp()
      where id = $1
    `, [revision.id])).rejects.toMatchObject({ code: '55000' });
    await expect(databaseClient.pool.query(`
      insert into prose_sections (revision_id, ordinal, source_reference)
      values ($1, 0, 'forged-web-section')
    `, [revision.id])).rejects.toMatchObject({ code: '42501' });

    await expect(workerDatabaseClient.pool.query(`
      update title_revisions
      set state = 'processing', processing_started_at = clock_timestamp(),
        processed_at = null, failure_code = null, failure_details = null
      where id = $1
    `, [revision.id])).resolves.toMatchObject({ rowCount: 1 });
    await workerDatabaseClient.pool.query(`
      insert into prose_sections (id, revision_id, ordinal, source_reference)
      values ($1, $2, 0, 'chapter-1')
    `, [sectionId, revision.id]);
    await workerDatabaseClient.pool.query(`
      insert into prose_blocks (id, revision_id, section_id, ordinal, kind, content)
      values ($1, $2, $3, 0, 'paragraph', '{"text":"Preview"}'::jsonb)
    `, [blockId, revision.id, sectionId]);
    await workerDatabaseClient.pool.query(`
      insert into revision_ingestion_warnings (revision_id, ordinal, code, safe_message)
      values ($1, 0, 'boundary_warning', 'Boundary warning')
    `, [revision.id]);
    await expect(workerDatabaseClient.pool.query(`
      update revision_ingestion_warnings set safe_message = 'forged' where revision_id = $1
    `, [revision.id])).rejects.toMatchObject({ code: '42501' });
    await expect(workerDatabaseClient.pool.query(`
      delete from revision_ingestion_warnings where revision_id = $1
    `, [revision.id])).resolves.toMatchObject({ rowCount: 1 });

    await expect(workerDatabaseClient.pool.query(`
      update title_revisions
      set state = 'ready_for_review', original_storage_key = 'original/revision-9501.epub',
        original_checksum_sha256 = repeat('5', 64),
        original_mime_type = 'application/epub+zip', original_byte_size = 512,
        original_filename = 'revision-9501.epub', staging_storage_key = null,
        staging_checksum_sha256 = null, staging_byte_size = null,
        failure_code = null, failure_details = null, processed_at = clock_timestamp()
      where id = $1
    `, [revision.id])).resolves.toMatchObject({ rowCount: 1 });
    await ownerDatabaseClient.pool.query(`
      insert into revision_presentations (
        revision_id, state, preview_prose_section_id, preview_prose_block_id
      ) values ($1, 'published', $2, $3)
    `, [revision.id, sectionId, blockId]);

    await expect(databaseClient.pool.query(`
      update title_revisions
      set state = 'active', activated_at = clock_timestamp(), retired_at = null
      where id = $1
    `, [revision.id])).resolves.toMatchObject({ rowCount: 1 });
    await expect(databaseClient.pool.query(`
      update title_revisions
      set state = 'retired', processed_at = clock_timestamp() + interval '1 second',
        retired_at = clock_timestamp()
      where id = $1
    `, [revision.id])).rejects.toMatchObject({ code: '55000' });
    await expect(databaseClient.pool.query(`
      update title_revisions
      set state = 'retired', retired_at = clock_timestamp()
      where id = $1
    `, [revision.id])).resolves.toMatchObject({ rowCount: 1 });
    await expect(databaseClient.pool.query(`
      update title_revisions
      set state = 'active', activated_at = clock_timestamp(), retired_at = null
      where id = $1
    `, [revision.id])).resolves.toMatchObject({ rowCount: 1 });
    await expect(databaseClient.pool.query(
      'delete from title_revisions where id = $1', [revision.id]
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects configured-login direct ACLs before role rotation', async () => {
    const config = loadDatabaseRoleProvisionConfig(process.env);
    const databaseIdentifier = `"${config.database.replaceAll('"', '""')}"`;
    const webIdentifier = `"${config.webUser}"`;
    for (const witness of [
      {
        introduce: `grant connect on database ${databaseIdentifier} to ${webIdentifier}`,
        restore: `revoke connect on database ${databaseIdentifier} from ${webIdentifier}`
      },
      {
        introduce: `grant select on table public.payments to ${webIdentifier}`,
        restore: `revoke select on table public.payments from ${webIdentifier}`
      }
    ]) {
      await ownerDatabaseClient.pool.query(witness.introduce);
      try {
        await expectUnexpectedNamedAuthorityProvisionRejected();
      } finally {
        await ownerDatabaseClient.pool.query(witness.restore);
      }
    }
  });

  it.each([
    {
      label: 'direct application SELECT',
      introduce: 'grant select on table public.payments to plan6b_reporting_fixture',
      restore: 'revoke select on table public.payments from plan6b_reporting_fixture'
    },
    {
      label: 'owner default SELECT',
      introduce: `alter default privileges in schema public
        grant select on tables to plan6b_reporting_fixture`,
      restore: `alter default privileges in schema public
        revoke select on tables from plan6b_reporting_fixture`
    },
    {
      label: 'inherited pg_read_all_data',
      introduce: 'grant pg_read_all_data to plan6b_reporting_fixture',
      restore: 'revoke pg_read_all_data from plan6b_reporting_fixture'
    },
    {
      label: 'public object ownership',
      introduce: `create table public.plan6b_reporting_owned_fixture (id integer);
        alter table public.plan6b_reporting_owned_fixture owner to plan6b_reporting_fixture`,
      restore: 'drop table public.plan6b_reporting_owned_fixture'
    }
  ])('rejects unexpected named authority through $label before role rotation', async ({
    introduce, restore
  }) => {
    await ownerDatabaseClient.pool.query(`
      create role plan6b_reporting_fixture with nologin nosuperuser nocreatedb nocreaterole
        inherit noreplication nobypassrls connection limit -1
    `);
    await ownerDatabaseClient.pool.query(introduce);
    try {
      await expectUnexpectedNamedAuthorityProvisionRejected();
    } finally {
      await ownerDatabaseClient.pool.query(restore);
      await ownerDatabaseClient.pool.query('drop role plan6b_reporting_fixture');
    }
  });

  it('rejects predefined pg_ role direct application SELECT before role rotation', async () => {
    await ownerDatabaseClient.pool.query(
      'grant select on table public.payments to pg_monitor'
    );
    try {
      await expectUnexpectedNamedAuthorityProvisionRejected();
    } finally {
      await ownerDatabaseClient.pool.query(
        'revoke select on table public.payments from pg_monitor'
      );
    }
  });

  it('permits unrelated public-schema USAGE and extension-member ACLs', async () => {
    const extensionWasPresent = (await ownerDatabaseClient.pool.query<{ present: boolean }>(`
      select exists (
        select 1 from pg_catalog.pg_extension where extname = 'hstore'
      ) as present
    `)).rows[0]?.present === true;
    await ownerDatabaseClient.pool.query(`
      create role plan6b_reporting_fixture with nologin nosuperuser nocreatedb nocreaterole
        inherit noreplication nobypassrls connection limit -1
    `);
    try {
      await ownerDatabaseClient.pool.query(
        'grant usage on schema public to plan6b_reporting_fixture'
      );
      await ownerDatabaseClient.pool.query('create extension if not exists hstore with schema public');
      await ownerDatabaseClient.pool.query(
        'grant usage on type public.hstore to plan6b_reporting_fixture'
      );
      await expect(runRoleProvision()).resolves.toBeUndefined();
    } finally {
      await ownerDatabaseClient.pool.query(
        'revoke usage on type public.hstore from plan6b_reporting_fixture'
      );
      await ownerDatabaseClient.pool.query(
        'revoke usage on schema public from plan6b_reporting_fixture'
      );
      await ownerDatabaseClient.pool.query('drop role plan6b_reporting_fixture');
      if (!extensionWasPresent) await ownerDatabaseClient.pool.query('drop extension hstore');
    }
  });

  it.each([
    {
      label: 'PUBLIC relation writes',
      introduce: 'grant update on table public.payments to public',
      restore: 'revoke update on table public.payments from public'
    },
    {
      label: 'PUBLIC schema creation',
      introduce: 'grant create on schema public to public',
      restore: 'revoke create on schema public from public'
    },
    {
      label: 'PUBLIC SECURITY DEFINER execution',
      introduce: `grant execute on function
        public.resolve_financial_issue_after_worker_recompute(uuid,text) to public`,
      restore: `revoke execute on function
        public.resolve_financial_issue_after_worker_recompute(uuid,text) from public`
    },
    {
      label: 'PUBLIC default table writes',
      introduce: 'alter default privileges in schema public grant insert on tables to public',
      restore: 'alter default privileges in schema public revoke insert on tables from public'
    },
    {
      label: 'PUBLIC parameter SET',
      introduce: 'grant set on parameter session_replication_role to public',
      restore: 'revoke set on parameter session_replication_role from public'
    },
    {
      label: 'PUBLIC outbox payload column reads',
      introduce: 'grant select (payload) on table public.outbox_messages to public',
      restore: 'revoke select (payload) on table public.outbox_messages from public'
    },
    {
      label: 'PUBLIC claim issuance column reads',
      introduce: 'grant select (state) on table public.commerce_claim_issuances to public',
      restore: 'revoke select (state) on table public.commerce_claim_issuances from public'
    },
    {
      label: 'PUBLIC outbox table reads',
      introduce: 'grant select on table public.outbox_messages to public',
      restore: 'revoke select on table public.outbox_messages from public'
    },
    {
      label: 'PUBLIC claim issuance table reads',
      introduce: 'grant select on table public.commerce_claim_issuances to public',
      restore: 'revoke select on table public.commerce_claim_issuances from public'
    },
    {
      label: 'runtime outbox table reads',
      introduce: 'grant select on table public.outbox_messages to pale_orbit_runtime',
      restore: `revoke select on table public.outbox_messages from pale_orbit_runtime;
        grant select (
          id, topic, deduplication_key, dispatch_job_id, status, last_error,
          delivered_at, created_at, updated_at
        ) on table public.outbox_messages to pale_orbit_runtime`
    },
    {
      label: 'runtime claim issuance column reads',
      introduce: `grant select (state) on table public.commerce_claim_issuances
        to pale_orbit_runtime`,
      restore: `revoke select (state) on table public.commerce_claim_issuances
        from pale_orbit_runtime`
    },
    {
      label: 'worker claim issuance table reads',
      introduce: `grant select on table public.commerce_claim_issuances
        to pale_orbit_financial_worker`,
      restore: `revoke select on table public.commerce_claim_issuances
        from pale_orbit_financial_worker`
    },
    {
      label: 'runtime guest identity table INSERT',
      introduce: 'grant insert on table public.guest_identities to pale_orbit_runtime',
      restore: `revoke insert on table public.guest_identities from pale_orbit_runtime;
        grant insert (email) on table public.guest_identities to pale_orbit_runtime`
    }
  ])('rejects provisioned database drift through $label', async ({ introduce, restore }) => {
    await ownerDatabaseClient.pool.query(introduce);
    try {
      await expectRoleProvisionRejected();
    } finally {
      await ownerDatabaseClient.pool.query(restore);
    }
  });

  it('rejects direct storage-cleanup relation authority', async () => {
    await ownerDatabaseClient.pool.query(
      'grant select on table public.titles to pale_orbit_storage_cleanup'
    );
    try {
      await expectStorageCleanupProvisionRejected();
    } finally {
      await ownerDatabaseClient.pool.query(
        'revoke select on table public.titles from pale_orbit_storage_cleanup'
      );
    }
  });

  it.each([
    {
      label: 'PUBLIC benign relation SELECT',
      introduce: 'grant select on table public.titles to public',
      restore: 'revoke select on table public.titles from public',
      rejection: 'cleanup'
    },
    {
      label: 'PUBLIC benign column SELECT',
      introduce: 'grant select (slug) on table public.titles to public',
      restore: 'revoke select (slug) on table public.titles from public',
      rejection: 'cleanup'
    },
    {
      label: 'PUBLIC ordinary routine EXECUTE',
      introduce: 'grant execute on function public.plan6b_guard_job_insert() to public',
      restore: 'revoke execute on function public.plan6b_guard_job_insert() from public',
      rejection: 'general'
    }
  ])('rejects effective cleanup authority inherited through $label', async ({
    introduce, restore, rejection
  }) => {
    await ownerDatabaseClient.pool.query(introduce);
    try {
      if (rejection === 'general') await expectRoleProvisionRejected();
      else await expectStorageCleanupProvisionRejected();
    } finally {
      await ownerDatabaseClient.pool.query(restore);
    }
  });

  it('rejects unsafe all-role settings on the current database', async () => {
    const config = loadDatabaseRoleProvisionConfig(process.env);
    const databaseIdentifier = `"${config.database.replaceAll('"', '""')}"`;
    const connection = await ownerDatabaseClient.pool.connect();
    try {
      await connection.query(`alter database ${databaseIdentifier} set row_security = 'off'`);
      await expect(provisionDatabaseRoles({
        query: async (text, values) => connection.query(
          text, values === undefined ? undefined : [...values]
        )
      }, config)).rejects.toThrow(/unsafe existing database login authority/iu);
    } finally {
      await connection.query(`alter database ${databaseIdentifier} reset row_security`);
      connection.release();
    }
  });

  it.each([
    ['pale_orbit_runtime', 'general'],
    ['pale_orbit_financial_worker', 'general'],
    ['pale_orbit_storage_cleanup', 'cleanup']
  ] as const)('rejects missing fixed-group CONNECT for %s', async (role, rejection) => {
    const config = loadDatabaseRoleProvisionConfig(process.env);
    const databaseIdentifier = `"${config.database.replaceAll('"', '""')}"`;
    const roleIdentifier = `"${role}"`;
    await ownerDatabaseClient.pool.query(
      `revoke connect on database ${databaseIdentifier} from ${roleIdentifier}`
    );
    try {
      if (rejection === 'cleanup') await expectStorageCleanupProvisionRejected();
      else await expectRoleProvisionRejected();
    } finally {
      await ownerDatabaseClient.pool.query(
        `grant connect on database ${databaseIdentifier} to ${roleIdentifier}`
      );
    }
  });

  it.each([
    {
      label: 'worker financial INSERT',
      revoke: 'revoke insert on table public.payments from pale_orbit_financial_worker',
      restore: 'grant insert on table public.payments to pale_orbit_financial_worker'
    },
    {
      label: 'web Stripe ingress column INSERT',
      revoke: `revoke insert (provider_event_id) on table public.stripe_events
        from pale_orbit_runtime`,
      restore: `grant insert (provider_event_id) on table public.stripe_events
        to pale_orbit_runtime`
    },
    {
      label: 'web guest identity email INSERT',
      revoke: `revoke insert (email) on table public.guest_identities
        from pale_orbit_runtime`,
      restore: `grant insert (email) on table public.guest_identities
        to pale_orbit_runtime`
    },
    {
      label: 'worker entitlement grant INSERT',
      revoke: 'revoke insert on table public.entitlement_grants from pale_orbit_financial_worker',
      restore: 'grant insert on table public.entitlement_grants to pale_orbit_financial_worker'
    },
    {
      label: 'worker outbox SELECT',
      revoke: 'revoke select on table public.outbox_messages from pale_orbit_financial_worker',
      restore: 'grant select on table public.outbox_messages to pale_orbit_financial_worker'
    },
    {
      label: 'web claim authorization EXECUTE',
      revoke: `revoke execute on function public.authorize_commerce_claim_issuance(text,text)
        from pale_orbit_runtime`,
      restore: `grant execute on function public.authorize_commerce_claim_issuance(text,text)
        to pale_orbit_runtime`
    },
    {
      label: 'worker claim registration EXECUTE',
      revoke: `revoke execute on function
        public.register_commerce_claim_issuance(text,text,text,uuid,text,timestamp with time zone)
        from pale_orbit_financial_worker`,
      restore: `grant execute on function
        public.register_commerce_claim_issuance(text,text,text,uuid,text,timestamp with time zone)
        to pale_orbit_financial_worker`
    }
  ])('rejects a provisioned database missing required $label authority', async ({
    revoke, restore
  }) => {
    await ownerDatabaseClient.pool.query(revoke);
    try {
      await expectRoleProvisionRejected();
    } finally {
      await ownerDatabaseClient.pool.query(restore);
    }
  });

  it('rejects missing storage-cleanup reference EXECUTE authority', async () => {
    await ownerDatabaseClient.pool.query(
      `revoke execute on function public.storage_cleanup_referenced_keys(text[])
        from pale_orbit_storage_cleanup`
    );
    try {
      await expectStorageCleanupProvisionRejected();
    } finally {
      await ownerDatabaseClient.pool.query(
        `grant execute on function public.storage_cleanup_referenced_keys(text[])
          to pale_orbit_storage_cleanup`
      );
    }
  });
});
