import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  loadDatabaseRoleProvisionConfig,
  provisionDatabaseRoles
} from '$lib/server/db/database-role-provision';
import {
  databaseClient,
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
  ['refund_allocation_drafts', ['id']],
  ['refund_allocation_draft_items', ['id']],
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
