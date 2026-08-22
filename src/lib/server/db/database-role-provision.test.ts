import { describe, expect, it, vi } from 'vitest';
import {
  databaseEnvironmentForRole,
  loadDatabaseMigrationIdentityConfig,
  loadDatabaseRoleProvisionConfig,
  provisionDatabaseRoles,
  type DatabaseMigrationIdentityConfig,
  type DatabaseRoleProvisionClient
} from './database-role-provision';

function assertMigrationIdentityConfigType(
  _config: DatabaseMigrationIdentityConfig
): void {
  // Compile-time fixture: the public type and loader export must agree once implemented.
}

const secret = (character: string) => character.repeat(40);
const safeGroup = (rolname: string) => ({
  rolname,
  rolcanlogin: false,
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: true,
  rolreplication: false,
  rolbypassrls: false
});
const safeGroups = () => [
  safeGroup('pale_orbit_financial_worker'),
  safeGroup('pale_orbit_runtime'),
  safeGroup('pale_orbit_storage_cleanup')
];
const safeAuthority = (overrides: Record<string, boolean> = {}) => ({
  unsafeMembership: false,
  unsafeOwnership: false,
  unsafeAcl: false,
  unsafeRoleSetting: false,
  missingRequiredAcl: false,
  ...overrides
});
const safeCleanupAuthority = (overrides: Record<string, boolean> = {}) => ({
  unsafeCleanupMembership: false,
  unsafeCleanupOwnership: false,
  unsafeCleanupAcl: false,
  unsafeCleanupRoleSetting: false,
  unsafeCleanupEffectiveAuthority: false,
  missingCleanupAuthority: false,
  ...overrides
});
const safeUnexpectedNamedAuthority = (unsafeUnexpectedNamedAuthority = false) => ({
  unsafeUnexpectedNamedAuthority
});
const environment = (overrides: Record<string, string | undefined> = {}) => ({
  DATABASE_HOST: 'postgres',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'pale_orbit',
  DATABASE_OWNER_USER: 'pale_orbit_owner',
  DATABASE_OWNER_PASSWORD: secret('o'),
  DATABASE_USER: 'pale_orbit_web',
  DATABASE_PASSWORD: secret('w'),
  DATABASE_WORKER_USER: 'pale_orbit_worker_login',
  DATABASE_WORKER_PASSWORD: secret('f'),
  DATABASE_STORAGE_CLEANUP_USER: 'pale_orbit_storage_cleanup_login',
  DATABASE_STORAGE_CLEANUP_PASSWORD: secret('c'),
  DATABASE_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_STATEMENT_TIMEOUT_MS: '30000',
  ...overrides
});

function captureSynchronousError(callback: () => unknown): Error {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('expected callback to fail');
}

function errorChainText(error: Error): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join('\n');
}

const derivedCatalogTables = [
  'prose_sections', 'prose_images', 'prose_blocks', 'comic_pages',
  'revision_cover_suggestions', 'revision_ingestion_warnings'
] as const;

const runtimeColumnPrivileges = [
  'stripe_events:INSERT:provider_event_id',
  'stripe_events:INSERT:event_type',
  'stripe_events:INSERT:object_id',
  'stripe_events:INSERT:live_mode',
  'stripe_events:INSERT:api_version',
  'stripe_events:INSERT:provider_created_at',
  'stripe_events:INSERT:raw_body_sha256',
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

const workerColumnPrivileges = [
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

const publicSensitiveSelectColumns = [
  'outbox_messages:payload',
  'commerce_claim_issuances:*',
  'financial_admin_commands:*',
  'financial_admin_job_claims:*',
  'jobs:*'
] as const;

describe('database role provisioning', () => {
  describe('migration login identity transport', () => {
    it('prefers the three dedicated non-secret names over ordinary application names', () => {
      const config = loadDatabaseMigrationIdentityConfig(environment({
        DATABASE_MIGRATION_WEB_USER: 'migration_attested_web',
        DATABASE_MIGRATION_WORKER_USER: 'migration_attested_worker',
        DATABASE_MIGRATION_STORAGE_CLEANUP_USER: 'migration_attested_cleanup',
        DATABASE_USER: 'ordinary_web',
        DATABASE_WORKER_USER: 'ordinary_worker',
        DATABASE_STORAGE_CLEANUP_USER: 'ordinary_cleanup'
      }));
      assertMigrationIdentityConfigType(config);

      expect(config).toEqual({
        webUser: 'migration_attested_web',
        workerUser: 'migration_attested_worker',
        storageCleanupUser: 'migration_attested_cleanup'
      });
      expect(Object.keys(config).sort()).toEqual([
        'storageCleanupUser',
        'webUser',
        'workerUser'
      ]);
      expect(JSON.stringify(config)).not.toMatch(/password|_file/iu);
    });

    it('falls back only to direct ordinary login names when dedicated names are absent', () => {
      expect(loadDatabaseMigrationIdentityConfig(environment())).toEqual({
        webUser: 'pale_orbit_web',
        workerUser: 'pale_orbit_worker_login',
        storageCleanupUser: 'pale_orbit_storage_cleanup_login'
      });
    });

    it.each([
      ['web', 'DATABASE_MIGRATION_WEB_USER_FILE'],
      ['worker', 'DATABASE_MIGRATION_WORKER_USER_FILE'],
      ['storage cleanup', 'DATABASE_MIGRATION_STORAGE_CLEANUP_USER_FILE']
    ])('rejects an invented %s migration-name file even when every direct name is valid', (
      _label,
      inventedFileName
    ) => {
      const privatePath = `/run/secrets/private-${inventedFileName.toLowerCase()}`;
      const readSecretFile = vi.fn((_path: string) => 'file_supplied_login');
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const failure = captureSynchronousError(() => loadDatabaseMigrationIdentityConfig(environment({
          DATABASE_MIGRATION_WEB_USER: 'migration_attested_web',
          DATABASE_MIGRATION_WORKER_USER: 'migration_attested_worker',
          DATABASE_MIGRATION_STORAGE_CLEANUP_USER: 'migration_attested_cleanup',
          [inventedFileName]: privatePath
        }), readSecretFile));
        const observable = [
          errorChainText(failure),
          JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls])
        ].join('\n');

        expect(readSecretFile).not.toHaveBeenCalled();
        expect(observable).not.toContain(privatePath);
        expect(failure.message).toMatch(/migration.*login|attested.*login|migration identity/iu);
      } finally {
        info.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
    });

    it.each([
      [
        'web',
        'DATABASE_MIGRATION_WEB_USER',
        'DATABASE_USER',
        'DATABASE_USER_FILE'
      ],
      [
        'worker',
        'DATABASE_MIGRATION_WORKER_USER',
        'DATABASE_WORKER_USER',
        'DATABASE_WORKER_USER_FILE'
      ],
      [
        'storage cleanup',
        'DATABASE_MIGRATION_STORAGE_CLEANUP_USER',
        'DATABASE_STORAGE_CLEANUP_USER',
        'DATABASE_STORAGE_CLEANUP_USER_FILE'
      ]
    ])('never resolves a missing %s attested login from an ordinary _FILE fallback', (
      _label,
      dedicatedName,
      ordinaryName,
      ordinaryFileName
    ) => {
      const readSecretFile = vi.fn((_path: string) => 'file_supplied_login');
      const privatePath = `/run/secrets/${ordinaryFileName.toLowerCase()}`;
      const source = environment({
        [dedicatedName]: undefined,
        [ordinaryName]: undefined,
        [ordinaryFileName]: privatePath
      });

      const failure = captureSynchronousError(() =>
        loadDatabaseMigrationIdentityConfig(source, readSecretFile)
      );
      expect(readSecretFile).not.toHaveBeenCalled();
      expect(errorChainText(failure)).not.toContain(privatePath);
      expect(failure.message).toMatch(/migration.*login|attested.*login|migration identity/iu);
    });

    it('accepts the exact 63-character PostgreSQL role-name boundary', () => {
      const boundaryName = `a${'b'.repeat(62)}`;
      expect(loadDatabaseMigrationIdentityConfig(environment({
        DATABASE_MIGRATION_WEB_USER: boundaryName
      })).webUser).toBe(boundaryName);
    });

    it.each([
      ['present but empty dedicated web name', {
        DATABASE_MIGRATION_WEB_USER: ''
      }],
      ['present but empty dedicated worker name', {
        DATABASE_MIGRATION_WORKER_USER: ''
      }],
      ['present but empty dedicated cleanup name', {
        DATABASE_MIGRATION_STORAGE_CLEANUP_USER: ''
      }],
      ['missing dedicated and direct web name', {
        DATABASE_MIGRATION_WEB_USER: undefined,
        DATABASE_USER: undefined
      }],
      ['uppercase role name', {
        DATABASE_MIGRATION_WEB_USER: 'MigrationWeb'
      }],
      ['unsafe role grammar', {
        DATABASE_MIGRATION_WORKER_USER: 'worker;set role'
      }],
      ['64-character role name', {
        DATABASE_MIGRATION_WEB_USER: `a${'b'.repeat(63)}`
      }],
      ['reserved pg_ role', {
        DATABASE_MIGRATION_STORAGE_CLEANUP_USER: 'pg_monitor'
      }],
      ['fixed runtime group', {
        DATABASE_MIGRATION_WEB_USER: 'pale_orbit_runtime'
      }],
      ['fixed worker group', {
        DATABASE_MIGRATION_WORKER_USER: 'pale_orbit_financial_worker'
      }],
      ['fixed cleanup group', {
        DATABASE_MIGRATION_STORAGE_CLEANUP_USER: 'pale_orbit_storage_cleanup'
      }],
      ['duplicate web and worker names', {
        DATABASE_MIGRATION_WEB_USER: 'migration_web',
        DATABASE_MIGRATION_WORKER_USER: 'migration_web'
      }],
      ['duplicate worker and cleanup names', {
        DATABASE_MIGRATION_WORKER_USER: 'migration_worker',
        DATABASE_MIGRATION_STORAGE_CLEANUP_USER: 'migration_worker'
      }],
      ['duplicate web and cleanup names', {
        DATABASE_MIGRATION_WEB_USER: 'migration_shared',
        DATABASE_MIGRATION_STORAGE_CLEANUP_USER: 'migration_shared'
      }],
      ['database owner reused as web name', {
        DATABASE_MIGRATION_WEB_USER: 'pale_orbit_owner'
      }],
      ['database owner reused as worker name', {
        DATABASE_MIGRATION_WORKER_USER: 'pale_orbit_owner'
      }],
      ['database owner reused as cleanup name', {
        DATABASE_MIGRATION_STORAGE_CLEANUP_USER: 'pale_orbit_owner'
      }]
    ])('rejects %s before migration', (_label, overrides) => {
      expect(() => loadDatabaseMigrationIdentityConfig(environment(overrides)))
        .toThrowError(/migration.*login|attested.*login|migration identity/iu);
    });

    it('resolves the owner identity only for distinctness without exposing owner credentials', () => {
      const readSecretFile = vi.fn((path: string) => {
        if (path === '/run/secrets/owner-user') return 'owner_from_file';
        throw new Error(`unexpected secret read ${path}`);
      });

      expect(() => loadDatabaseMigrationIdentityConfig(environment({
        DATABASE_OWNER_USER: undefined,
        DATABASE_OWNER_USER_FILE: '/run/secrets/owner-user',
        DATABASE_MIGRATION_WEB_USER: 'owner_from_file'
      }), readSecretFile)).toThrowError(/migration.*login|attested.*login|migration identity/iu);
      expect(readSecretFile).toHaveBeenCalledTimes(1);
      expect(readSecretFile).toHaveBeenCalledWith('/run/secrets/owner-user');
    });

    it('keeps every login, credential, and file canary out of errors and logs', () => {
      const canaries = [
        'private_web_identity',
        'private_worker_identity',
        'private_cleanup_identity',
        'private-owner-password',
        'private-web-password',
        'private-worker-password',
        'private-cleanup-password',
        '/run/secrets/private-migration-web-user',
        '/run/secrets/private-migration-worker-user',
        '/run/secrets/private-migration-cleanup-user'
      ];
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const failure = captureSynchronousError(() => loadDatabaseMigrationIdentityConfig(environment({
          DATABASE_OWNER_USER: 'private_web_identity',
          DATABASE_OWNER_PASSWORD: 'private-owner-password',
          DATABASE_MIGRATION_WEB_USER: 'private_web_identity',
          DATABASE_MIGRATION_WORKER_USER: 'private_worker_identity',
          DATABASE_MIGRATION_STORAGE_CLEANUP_USER: 'private_cleanup_identity',
          DATABASE_PASSWORD: 'private-web-password',
          DATABASE_WORKER_PASSWORD: 'private-worker-password',
          DATABASE_STORAGE_CLEANUP_PASSWORD: 'private-cleanup-password',
          DATABASE_MIGRATION_WEB_USER_FILE: '/run/secrets/private-migration-web-user',
          DATABASE_MIGRATION_WORKER_USER_FILE: '/run/secrets/private-migration-worker-user',
          DATABASE_MIGRATION_STORAGE_CLEANUP_USER_FILE:
            '/run/secrets/private-migration-cleanup-user'
        })));
        const observable = [
          errorChainText(failure),
          JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls])
        ].join('\n');
        expect(failure.message).toMatch(/migration.*login|attested.*login|migration identity/iu);
        for (const canary of canaries) expect(observable).not.toContain(canary);
      } finally {
        info.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
    });
  });

  it('maps owner, worker, and storage-cleanup credentials onto the generic database contract', () => {
    const source: Record<string, string | undefined> = environment({
      DATABASE_PASSWORD_FILE: 'must-be-cleared',
      DATABASE_OWNER_PASSWORD: undefined,
      DATABASE_OWNER_PASSWORD_FILE: 'owner-secret-file'
    });
    const readSecret = (path: string) => path === 'owner-secret-file' ? secret('o') : secret('x');
    expect(databaseEnvironmentForRole(source, 'owner', readSecret)).toMatchObject({
      DATABASE_USER: 'pale_orbit_owner',
      DATABASE_USER_FILE: undefined,
      DATABASE_PASSWORD: secret('o'),
      DATABASE_PASSWORD_FILE: undefined
    });
    expect(databaseEnvironmentForRole(environment(), 'worker')).toMatchObject({
      DATABASE_USER: 'pale_orbit_worker_login',
      DATABASE_USER_FILE: undefined,
      DATABASE_PASSWORD: secret('f'),
      DATABASE_PASSWORD_FILE: undefined
    });
    const cleanupSource = environment({
      DATABASE_USER: 'stale-generic-user',
      DATABASE_USER_FILE: 'stale-generic-user-file',
      DATABASE_PASSWORD: 'stale-generic-password',
      DATABASE_PASSWORD_FILE: 'stale-generic-password-file',
      DATABASE_STORAGE_CLEANUP_USER: undefined,
      DATABASE_STORAGE_CLEANUP_USER_FILE: 'cleanup-user-file',
      DATABASE_STORAGE_CLEANUP_PASSWORD: undefined,
      DATABASE_STORAGE_CLEANUP_PASSWORD_FILE: 'cleanup-password-file'
    });
    const cleanupSecret = (path: string) => path === 'cleanup-user-file'
      ? 'pale_orbit_storage_cleanup_login'
      : secret('c');
    expect(databaseEnvironmentForRole(cleanupSource, 'storage-cleanup', cleanupSecret))
      .toMatchObject({
        DATABASE_USER: 'pale_orbit_storage_cleanup_login',
        DATABASE_USER_FILE: undefined,
        DATABASE_PASSWORD: secret('c'),
        DATABASE_PASSWORD_FILE: undefined
      });
    expect(source.DATABASE_PASSWORD_FILE).toBe('must-be-cleared');
  });

  it('loads four distinct bounded credentials without exposing secrets', () => {
    const config = loadDatabaseRoleProvisionConfig(environment());
    expect(config).toMatchObject({
      host: 'postgres', port: 5432, database: 'pale_orbit', ownerUser: 'pale_orbit_owner',
      webUser: 'pale_orbit_web', workerUser: 'pale_orbit_worker_login',
      storageCleanupUser: 'pale_orbit_storage_cleanup_login'
    });
    expect(JSON.stringify({ ...config, ownerPassword: undefined, webPassword: undefined,
      workerPassword: undefined, storageCleanupPassword: undefined })).not.toContain(secret('w'));
  });

  it('accepts the pre-split database owner identity while keeping new logins strict', () => {
    const config = loadDatabaseRoleProvisionConfig(environment({
      DATABASE_OWNER_USER: 'pg_legacy_owner',
      DATABASE_OWNER_PASSWORD: 'legacy-secret'
    }));

    expect(config.ownerUser).toBe('pg_legacy_owner');
    expect(config.ownerPassword).toBe('legacy-secret');
    expect(config.webUser).toBe('pale_orbit_web');
    expect(config.workerUser).toBe('pale_orbit_worker_login');
    expect(config.storageCleanupUser).toBe('pale_orbit_storage_cleanup_login');
  });

  it.each([
    ['unsafe web identifier', { DATABASE_USER: 'web;drop role' }],
    ['reserved pg_ web role', { DATABASE_USER: 'pg_monitor' }],
    ['reserved pg_ worker role', { DATABASE_WORKER_USER: 'pg_checkpoint' }],
    ['reserved pg_ cleanup role', { DATABASE_STORAGE_CLEANUP_USER: 'pg_signal_backend' }],
    ['reserved web role', { DATABASE_USER: 'pale_orbit_runtime' }],
    ['reserved cleanup role', { DATABASE_STORAGE_CLEANUP_USER: 'pale_orbit_storage_cleanup' }],
    ['same web and worker', { DATABASE_WORKER_USER: 'pale_orbit_web' }],
    ['same worker and cleanup', { DATABASE_STORAGE_CLEANUP_USER: 'pale_orbit_worker_login' }],
    ['owner reused by web', { DATABASE_USER: 'pale_orbit_owner' }],
    ['owner password reused by web', { DATABASE_PASSWORD: secret('o') }],
    ['owner password reused by worker', { DATABASE_WORKER_PASSWORD: secret('o') }],
    ['web password reused by worker', { DATABASE_WORKER_PASSWORD: secret('w') }],
    ['worker password reused by cleanup', { DATABASE_STORAGE_CLEANUP_PASSWORD: secret('f') }],
    ['short web secret', { DATABASE_PASSWORD: 'short' }],
    ['unsafe port', { DATABASE_PORT: '0' }]
  ])('rejects %s before connecting', (_label, overrides) => {
    expect(() => loadDatabaseRoleProvisionConfig(environment(overrides)))
      .toThrowError(/database role provision/iu);
  });

  it('creates or rotates constrained logins and grants only the intended group memberships', async () => {
    const statements: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client: DatabaseRoleProvisionClient = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        statements.push(values === undefined ? { text } : { text, values });
        if (text.includes('where rolname = any($1::text[])') && text.includes('rolcanlogin')) {
          return { rows: safeGroups() };
        }
        if (text.includes('select rolname from pg_catalog.pg_roles')) return { rows: [] };
        if (text.includes('"unsafeUnexpectedNamedAuthority"')) {
          return { rows: [safeUnexpectedNamedAuthority()] };
        }
        if (text.includes('"unsafeMembership"')) {
          return { rows: [safeAuthority()] };
        }
        if (text.includes('"unsafeCleanupMembership"')) {
          return { rows: [safeCleanupAuthority()] };
        }
        if (text.includes('pg_catalog.format')) {
          return { rows: [{ statement: `FORMATTED ${String(values?.[1])}` }] };
        }
        return { rows: [] };
      })
    };

    await provisionDatabaseRoles(client, loadDatabaseRoleProvisionConfig(environment()));

    expect(statements[0]?.text).toBe('begin');
    expect(statements.at(-1)?.text).toBe('commit');
    expect(statements.some(({ text }) => text === 'FORMATTED pale_orbit_web')).toBe(true);
    expect(statements.some(({ text }) => text === 'FORMATTED pale_orbit_worker_login')).toBe(true);
    expect(statements.some(({ text }) => text === 'FORMATTED pale_orbit_storage_cleanup_login'))
      .toBe(true);
    const grants = statements.map(({ text }) => text).join('\n');
    expect(grants).toContain('REVOKE "pale_orbit_financial_worker" FROM "pale_orbit_web"');
    expect(grants).toContain('REVOKE ALL ON FUNCTION "public"."resolve_financial_issue_after_worker_recompute"(uuid,text) FROM "pale_orbit_web", "pale_orbit_worker_login"');
    expect(grants).toContain('REVOKE CREATE ON SCHEMA "public" FROM "pale_orbit_web", "pale_orbit_worker_login"');
    expect(grants).toContain(
      'GRANT "pale_orbit_runtime" TO "pale_orbit_web" WITH ADMIN FALSE, INHERIT TRUE, SET FALSE'
    );
    expect(grants).toContain(
      'GRANT "pale_orbit_financial_worker" TO "pale_orbit_worker_login" WITH ADMIN FALSE, INHERIT TRUE, SET FALSE'
    );
    expect(grants).toContain(
      'GRANT "pale_orbit_storage_cleanup" TO "pale_orbit_storage_cleanup_login" WITH ADMIN FALSE, INHERIT TRUE, SET FALSE'
    );
    expect(grants).toContain(
      'REVOKE "pale_orbit_storage_cleanup" FROM "pale_orbit_web", "pale_orbit_worker_login"'
    );
    expect(grants).toContain('granted_role.rolname = any($1::text[])');
    expect(grants).toContain('membership.inherit_option');
    expect(grants).toContain('membership.set_option');
    expect(grants).toContain('pg_catalog.aclexplode');
    expect(grants).toContain('pg_catalog.pg_shdepend');
    expect(grants).toContain('pg_catalog.pg_parameter_acl');
    expect(grants).toContain('pg_catalog.pg_default_acl');
    expect(grants).toContain('pg_catalog.pg_db_role_setting');
    expect(grants).toContain('privilege_row.grantee = 0');
    expect(grants).toContain("privilege_row.object_kind like 'default_%'");
    expect(grants).toContain("privilege_row.object_kind = 'parameter'");
    expect(grants).toContain("privilege_row.privilege_type not in ('CONNECT', 'TEMPORARY')");
    expect(grants).toContain(
      "privilege_row.object_oid = 'pg_catalog.pg_settings'::pg_catalog.regclass"
    );
    expect(grants).toContain("pg_catalog.acldefault('f', function_row.proowner)");
    expect(grants).toContain('function_row.prosecdef');
    expect(grants).toContain('setting_row.setrole = 0');
    expect(grants).toContain(
      "pg_catalog.current_setting('session_replication_role') is distinct from 'origin'"
    );
    expect(grants).toContain('as "missingRequiredAcl"');
    const safety = statements.find(({ text }) => text.includes('"unsafeMembership"'));
    expect(safety?.text).toContain("'pale_orbit_runtime', 'pale_orbit_financial_worker'");
    expect(safety?.text).toContain("privilege_row.privilege_type = 'CONNECT'");
    expect(safety?.text).toMatch(
      /has_database_privilege\(\s*\$2::text,\s*pg_catalog\.current_database\(\),\s*'CONNECT'/u
    );
    expect(safety?.text).toMatch(
      /has_database_privilege\(\s*\$3::text,\s*pg_catalog\.current_database\(\),\s*'CONNECT'/u
    );
    expect(safety?.values?.[3]).toEqual([
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
      'disputes',
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
      ...derivedCatalogTables
    ]);
    expect(safety?.values?.[4]).toEqual([
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
      'disputes',
      'entitlement_grants',
      'entitlements',
      ...derivedCatalogTables
    ]);
    expect(safety?.values?.[5]).toEqual([
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
      'stripe_events',
      'orders',
      'order_items',
      'jobs',
      'title_revisions',
      'entitlement_grants',
      'entitlements'
    ]);
    expect(safety?.values?.[6]).toEqual(derivedCatalogTables);
    expect(safety?.values?.[7]).toEqual(runtimeColumnPrivileges);
    expect(safety?.values?.[8]).toEqual(workerColumnPrivileges);
    expect(safety?.values?.[9]).toEqual([
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
      'public.append_financial_sales_export_audit(uuid,text,text,integer,integer,integer,text,text)'
    ]);
    expect(safety?.values?.[10]).toEqual([
      'public.resolve_financial_issue_after_worker_recompute(uuid,text)',
      'public.register_commerce_claim_issuance(text,text,text,uuid,text,timestamp with time zone)',
      'public.purge_commerce_claim_issuances()',
      'public.resolve_financial_issue_after_admin_command(uuid,uuid)',
      'public.transition_administrative_recovery_grant_after_admin_command(uuid)'
    ]);
    expect(safety?.values?.[11]).toEqual([
      'outbox_messages', 'financial_admin_commands', 'jobs'
    ]);
    expect(safety?.values?.[12]).toEqual([
      'commerce_claim_issuances', 'outbox_messages', 'financial_admin_commands',
      'financial_admin_job_claims', 'jobs'
    ]);
    expect(safety?.values?.[13]).toEqual(publicSensitiveSelectColumns);
    expect(grants).toContain("privilege_row.privilege_type = 'SELECT'");
    expect(grants).toContain('allowed_relation.relname = any($12::text[])');
    expect(grants).toContain('required_relation.relname <> all($13::text[])');
    expect(grants).toContain('sensitive_column.token');
    expect(grants).toContain(
      "pg_catalog.split_part(sensitive_column.token, ':', 2) = '*'"
    );
    expect(grants).toMatch(
      /privilege_row\.object_kind = 'relation'\s+and privilege_row\.privilege_type = 'SELECT'\s+and exists \(\s+select 1\s+from pg_catalog\.pg_class sensitive_relation/u
    );
    expect(grants).toContain(
      "'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'"
    );
    expect(grants).toContain(
      'REVOKE ALL ON FUNCTION "public"."rearm_pending_stripe_event_job"(uuid) FROM "pale_orbit_web", "pale_orbit_worker_login"'
    );
    expect(safety?.values?.[11]).not.toContain('financial_admin_job_claims');
    expect(safety?.values?.[9]).not.toContain(
      'public.plan6bii_assert_financial_admin_job_lease(uuid)'
    );
    expect(safety?.values?.[10]).not.toContain(
      'public.plan6bii_guard_financial_admin_job_lease()'
    );
    expect(statements.map(({ text }) => text).join('\n')).not.toContain(secret('w'));
    const cleanupSafety = statements.find(({ text }) =>
      text.includes('"unsafeCleanupMembership"')
    );
    expect(cleanupSafety?.values).toEqual([
      'pale_orbit_storage_cleanup',
      'pale_orbit_storage_cleanup_login',
      'public.storage_cleanup_referenced_keys(text[])',
      'pale_orbit_owner'
    ]);
    expect(cleanupSafety?.text).toContain('routine.proowner = (');
    expect(cleanupSafety?.text).toContain('owner_role.rolname = $4::text');
    expect(cleanupSafety?.text).toContain(
      "dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass"
    );
    expect(cleanupSafety?.text).toContain("acl.privilege_type = 'CONNECT'");
    expect(cleanupSafety?.text).toContain('and not acl.is_grantable');
    expect(cleanupSafety?.text).toMatch(
      /has_database_privilege\(\s*\$2::text,\s*pg_catalog\.current_database\(\),\s*'CONNECT'/u
    );
    for (const contract of [
      'pg_catalog.has_table_privilege',
      'pg_catalog.has_any_column_privilege',
      'pg_catalog.has_sequence_privilege',
      'pg_catalog.has_function_privilege',
      'pg_catalog.has_schema_privilege'
    ]) expect(cleanupSafety?.text).toContain(contract);
  });

  it('rejects unexpected named authority before formatting or mutating any login', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client: DatabaseRoleProvisionClient = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push(values === undefined ? { text } : { text, values });
        if (text.includes('where rolname = any($1::text[])') && text.includes('rolcanlogin')) {
          return { rows: safeGroups() };
        }
        if (text.includes('select rolname from pg_catalog.pg_roles')) {
          return { rows: [{ rolname: 'pale_orbit_web' }] };
        }
        if (text.includes('"unsafeUnexpectedNamedAuthority"')) {
          return { rows: [safeUnexpectedNamedAuthority(true)] };
        }
        if (text.includes('pg_catalog.format')) {
          return { rows: [{ statement: `FORMATTED ${String(values?.[1])}` }] };
        }
        if (text.includes('"unsafeMembership"')) return { rows: [safeAuthority()] };
        if (text.includes('"unsafeCleanupMembership"')) {
          return { rows: [safeCleanupAuthority()] };
        }
        return { rows: [] };
      })
    };

    await expect(provisionDatabaseRoles(client, loadDatabaseRoleProvisionConfig(environment())))
      .rejects.toThrow(/unexpected named database authority/iu);

    const preflight = calls.find(({ text }) => text.includes('"unsafeUnexpectedNamedAuthority"'));
    expect(preflight?.text).toContain('pg_catalog.pg_depend');
    expect(preflight?.text).toContain("extension_dependency.deptype = 'e'");
    expect(preflight?.text).toContain("dependent_object.deptype in ('a', 'i')");
    expect(preflight?.text).toContain('pg_catalog.pg_has_role');
    expect(preflight?.text).toContain("role_row.rolname = 'pg_database_owner'");
    expect(preflight?.text).not.toContain("role_row.rolname ~ '^pg_'");
    expect(preflight?.text).toContain('sensitive_role.rolsuper');
    expect(preflight?.text).toContain("'pale_orbit_runtime'");
    expect(preflight?.text).toContain("'pale_orbit_financial_worker'");
    expect(preflight?.text).toContain("'pale_orbit_storage_cleanup'");
    expect(preflight?.text).toContain("'pg_read_all_data'");
    expect(preflight?.text).toContain("'pg_write_all_data'");
    expect(preflight?.text).toMatch(
      /candidate_role\.rolname = \$1::text\s+and sensitive_role\.rolname = 'pale_orbit_runtime'/u
    );
    expect(preflight?.text).toMatch(
      /candidate_role\.rolname = \$2::text\s+and sensitive_role\.rolname in \(\s*'pale_orbit_runtime', 'pale_orbit_financial_worker'\s*\)/u
    );
    expect(preflight?.text).toMatch(
      /candidate_role\.rolname = \$3::text\s+and sensitive_role\.rolname = 'pale_orbit_storage_cleanup'/u
    );
    expect(preflight?.text).toContain('default_row.defaclnamespace = 0');
    expect(preflight?.values).toEqual([
      'pale_orbit_web',
      'pale_orbit_worker_login',
      'pale_orbit_storage_cleanup_login'
    ]);
    expect(calls.some(({ text }) => text.includes('pg_catalog.format'))).toBe(false);
    expect(calls.some(({ text }) => /^FORMATTED /u.test(text))).toBe(false);
    expect(calls.at(-1)?.text).toBe('rollback');
  });

  it.each([
    ['unexpected inherited authority', safeAuthority({ unsafeMembership: true })],
    ['legacy application ownership', safeAuthority({ unsafeOwnership: true })],
    ['direct object or parameter privileges', safeAuthority({ unsafeAcl: true })],
    ['database-scoped role settings', safeAuthority({ unsafeRoleSetting: true })],
    ['missing required runtime or worker ACL', safeAuthority({ missingRequiredAcl: true })]
  ])('rejects and rolls back %s on a reused login', async (_label, safety) => {
    const calls: string[] = [];
    const client: DatabaseRoleProvisionClient = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push(text);
        if (text.includes('where rolname = any($1::text[])') && text.includes('rolcanlogin')) {
          return { rows: safeGroups() };
        }
        if (text.includes('select rolname from pg_catalog.pg_roles')) return { rows: [] };
        if (text.includes('"unsafeUnexpectedNamedAuthority"')) {
          return { rows: [safeUnexpectedNamedAuthority()] };
        }
        if (text.includes('pg_catalog.format')) {
          return { rows: [{ statement: `FORMATTED ${String(values?.[1])}` }] };
        }
        if (text.includes('"unsafeMembership"')) return { rows: [safety] };
        if (text.includes('"unsafeCleanupMembership"')) {
          return { rows: [safeCleanupAuthority()] };
        }
        return { rows: [] };
      })
    };

    await expect(provisionDatabaseRoles(client, loadDatabaseRoleProvisionConfig(environment())))
      .rejects.toThrow(/unsafe existing database login authority/iu);
    expect(calls.at(-1)).toBe('rollback');
  });

  it.each([
    ['unexpected cleanup membership', safeCleanupAuthority({ unsafeCleanupMembership: true })],
    ['cleanup ownership', safeCleanupAuthority({ unsafeCleanupOwnership: true })],
    ['cleanup direct ACL', safeCleanupAuthority({ unsafeCleanupAcl: true })],
    ['cleanup role setting', safeCleanupAuthority({ unsafeCleanupRoleSetting: true })],
    ['cleanup effective authority', safeCleanupAuthority({ unsafeCleanupEffectiveAuthority: true })],
    ['missing cleanup authority', safeCleanupAuthority({ missingCleanupAuthority: true })]
  ])('rejects and rolls back %s', async (_label, cleanupSafety) => {
    const calls: string[] = [];
    const client: DatabaseRoleProvisionClient = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push(text);
        if (text.includes('where rolname = any($1::text[])') && text.includes('rolcanlogin')) {
          return { rows: safeGroups() };
        }
        if (text.includes('select rolname from pg_catalog.pg_roles')) return { rows: [] };
        if (text.includes('"unsafeUnexpectedNamedAuthority"')) {
          return { rows: [safeUnexpectedNamedAuthority()] };
        }
        if (text.includes('pg_catalog.format')) {
          return { rows: [{ statement: `FORMATTED ${String(values?.[1])}` }] };
        }
        if (text.includes('"unsafeMembership"')) return { rows: [safeAuthority()] };
        if (text.includes('"unsafeCleanupMembership"')) return { rows: [cleanupSafety] };
        return { rows: [] };
      })
    };

    await expect(provisionDatabaseRoles(client, loadDatabaseRoleProvisionConfig(environment())))
      .rejects.toThrow(/unsafe storage cleanup database authority/iu);
    expect(calls.at(-1)).toBe('rollback');
  });

  it('rolls the entire role rotation back and rethrows without logging a credential', async () => {
    const error = new Error('role update failed');
    const calls: string[] = [];
    const client: DatabaseRoleProvisionClient = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes('where rolname = any($1::text[])') && text.includes('rolcanlogin')) {
          return { rows: safeGroups() };
        }
        if (text.includes('select rolname from pg_catalog.pg_roles')) throw error;
        return { rows: [] };
      })
    };

    await expect(provisionDatabaseRoles(client, loadDatabaseRoleProvisionConfig(environment())))
      .rejects.toBe(error);
    expect(calls.at(-1)).toBe('rollback');
  });
});
