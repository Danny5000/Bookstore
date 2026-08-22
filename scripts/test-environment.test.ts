import { describe, expect, it } from 'vitest';
import {
  assertIsolatedTestDatabaseEnvironment,
  withoutStripeProviderSecrets
} from './test-environment';

describe('test subprocess environment isolation', () => {
  it('removes production database, auth, bootstrap, SMTP, and Stripe credentials', () => {
    expect(withoutStripeProviderSecrets({
      PATH: 'safe-path',
      CI: 'true',
      DATABASE_URL: 'postgres://production-secret',
      DATABASE_HOST_FILE: '/run/secrets/database-host',
      DATABASE_OWNER_USER: 'production-owner',
      DATABASE_OWNER_USER_FILE: '/run/secrets/owner-user',
      DATABASE_OWNER_PASSWORD: 'owner-secret',
      database_owner_password_file: '/run/secrets/owner',
      DATABASE_USER: 'production-web',
      database_user_file: '/run/secrets/web-user',
      DATABASE_PASSWORD: 'web-secret',
      Database_Password_File: '/run/secrets/web',
      DATABASE_WORKER_USER: 'production-worker',
      DATABASE_WORKER_USER_FILE: '/run/secrets/worker-user',
      DATABASE_WORKER_PASSWORD: 'worker-secret',
      DATABASE_WORKER_PASSWORD_FILE: '/run/secrets/worker',
      DATABASE_STORAGE_CLEANUP_USER: 'production-cleanup',
      Database_Storage_Cleanup_User_File: '/run/secrets/cleanup-user',
      DATABASE_STORAGE_CLEANUP_PASSWORD: 'cleanup-secret',
      database_storage_cleanup_password_file: '/run/secrets/cleanup',
      DATABASE_MIGRATION_WEB_USER: 'production-web-attestation',
      DATABASE_MIGRATION_WORKER_USER: 'production-worker-attestation',
      DATABASE_MIGRATION_STORAGE_CLEANUP_USER: 'production-cleanup-attestation',
      database_migration_web_user: 'mixed-case-production-web-attestation',
      Database_Migration_Worker_User: 'mixed-case-production-worker-attestation',
      database_MIGRATION_storage_cleanup_USER: 'mixed-case-production-cleanup-attestation',
      PGPASSWORD: 'postgres-client-secret',
      PGPASSFILE: '/run/secrets/pgpass',
      PGSSLMODE: 'require',
      PGOPTIONS: '-c session_replication_role=replica',
      PGCLIENTENCODING: 'LATIN1',
      POSTGRES_PASSWORD: 'container-secret',
      POSTGRES_PASSWORD_FILE: '/run/secrets/postgres',
      AUTH_SECRET: 'auth-secret',
      AUTH_SECRET_FILE: '/run/secrets/auth',
      APP_ENV_FILE: '/run/config/app-env',
      BOOTSTRAP_ADMIN_EMAIL: 'production-admin@example.com',
      BOOTSTRAP_ADMIN_EMAIL_FILE: '/run/secrets/bootstrap-email',
      BOOTSTRAP_ADMIN_NAME: 'Production Administrator',
      BOOTSTRAP_ADMIN_NAME_FILE: '/run/secrets/bootstrap-name',
      BOOTSTRAP_ADMIN_PASSWORD: 'bootstrap-secret',
      BOOTSTRAP_ADMIN_PASSWORD_FILE: '/run/secrets/bootstrap',
      SMTP_USER: 'production-smtp-user',
      SMTP_USER_FILE: '/run/secrets/smtp-user',
      SMTP_PASSWORD: 'smtp-secret',
      SMTP_PASSWORD_FILE: '/run/secrets/smtp',
      SMTP_HOST_FILE: '/run/config/smtp-host',
      STRIPE_SECRET_KEY: 'sk_live_secret',
      STRIPE_SECRET_KEY_FILE: '/run/secrets/stripe-key',
      STRIPE_WEBHOOK_SECRET: 'whsec_secret',
      STRIPE_WEBHOOK_SECRET_FILE: '/run/secrets/stripe-webhook'
    })).toEqual({ PATH: 'safe-path', CI: 'true' });
  });

  const safeTarget = {
    APP_ENV: 'test',
    PALE_ORBIT_TEST_PROJECT: 'pale-orbit-test-0123456789abcdef',
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: '54321',
    DATABASE_NAME: 'pale_orbit_test',
    DATABASE_OWNER_USER: 'pale_orbit_test',
    DATABASE_USER: 'pale_orbit_test_web',
    DATABASE_WORKER_USER: 'pale_orbit_test_worker',
    DATABASE_STORAGE_CLEANUP_USER: 'pale_orbit_test_storage_cleanup'
  };

  it('accepts only the wrapper-attested disposable database target', () => {
    expect(() => assertIsolatedTestDatabaseEnvironment(safeTarget)).not.toThrow();
  });

  it.each([
    ['production mode', { APP_ENV: 'production' }],
    ['missing wrapper project', { PALE_ORBIT_TEST_PROJECT: undefined }],
    ['foreign wrapper project', { PALE_ORBIT_TEST_PROJECT: 'production' }],
    ['remote host', { DATABASE_HOST: 'db.internal' }],
    ['default PostgreSQL port', { DATABASE_PORT: '5432' }],
    ['non-test database', { DATABASE_NAME: 'pale_orbit' }],
    ['owner login drift', { DATABASE_OWNER_USER: 'production_owner' }],
    ['web login drift', { DATABASE_USER: 'production_web' }],
    ['worker login drift', { DATABASE_WORKER_USER: 'production_worker' }],
    ['cleanup login drift', { DATABASE_STORAGE_CLEANUP_USER: 'production_cleanup' }]
  ])('rejects %s before destructive test setup', (_label, override) => {
    expect(() => assertIsolatedTestDatabaseEnvironment({
      ...safeTarget,
      ...override
    })).toThrow('Refusing to use a non-isolated test database');
  });
});
