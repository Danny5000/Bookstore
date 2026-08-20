import { describe, expect, it, vi } from 'vitest';
import * as configLoad from './load';
import type { EnvironmentValues } from './read-setting';
import type { ApplicationConfig, DatabaseConfig } from './schema';

const scopedLoaders = configLoad as typeof configLoad & {
  loadDatabaseConfig(
    source: EnvironmentValues,
    readSecretFile?: (path: string) => string
  ): DatabaseConfig;
  loadWebApplicationConfig(
    source: EnvironmentValues,
    readSecretFile?: (path: string) => string
  ): ApplicationConfig;
  loadWorkerApplicationConfig(
    source: EnvironmentValues,
    readSecretFile?: (path: string) => string
  ): ApplicationConfig;
};

function productionEnvironment(overrides: EnvironmentValues = {}): EnvironmentValues {
  return {
    APP_ENV: 'production',
    APPLICATION_MODE: 'maintenance',
    ORIGIN: 'https://books.example.com',
    DATABASE_HOST: 'postgres',
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'pale_orbit',
    DATABASE_USER: 'pale_orbit_web',
    DATABASE_PASSWORD: 'web-password',
    DATABASE_POOL_MAX: '5',
    DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_STATEMENT_TIMEOUT_MS: '30000',
    DATABASE_READINESS_TIMEOUT_MS: '2000',
    JOB_POLL_INTERVAL_MS: '1000',
    JOB_LEASE_MS: '30000',
    JOB_RETRY_BASE_MS: '1000',
    JOB_RETRY_MAX_MS: '300000',
    WORKER_READY_FILE: '/tmp/worker-ready',
    WORKER_CONCURRENCY: '1',
    STORAGE_PROVIDER: 'local',
    STORAGE_STAGING_ROOT: '/var/lib/pale-orbit/staging',
    STORAGE_PUBLICATION_ROOT: '/var/lib/pale-orbit/publication',
    STORAGE_COVERS_ROOT: '/var/lib/pale-orbit/covers',
    STORAGE_SCRATCH_ROOT: '/tmp/pale-orbit-verified',
    UPLOAD_MAX_BYTES: '536870912',
    INGEST_MAX_EXPANDED_BYTES: '2147483648',
    INGEST_MAX_ENTRIES: '10000',
    INGEST_MAX_XML_BYTES: '8388608',
    INGEST_MAX_IMAGE_PIXELS: '100000000',
    INGEST_MAX_COMPRESSION_RATIO: '200',
    INGEST_TIMEOUT_MS: '900000',
    STORAGE_STAGING_RETENTION_HOURS: '24',
    STORAGE_ORPHAN_RETENTION_HOURS: '168',
    AUTH_SECRET: 'production-auth-secret-at-least-thirty-two-bytes',
    AUTH_SESSION_EXPIRES_SECONDS: '604800',
    AUTH_VERIFICATION_EXPIRES_SECONDS: '3600',
    AUTH_RESET_EXPIRES_SECONDS: '3600',
    AUTH_MAGIC_EXPIRES_SECONDS: '900',
    AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
    AUTH_RATE_LIMIT_MAX: '100',
    AUTH_LOGIN_RATE_LIMIT_MAX: '5',
    AUTH_EMAIL_RATE_LIMIT_MAX: '3',
    STRIPE_ENABLED: 'true',
    STRIPE_TEST_FIXTURE_MODE: 'false',
    STRIPE_LIVE_MODE: 'false',
    STRIPE_SECRET_KEY: 'sk_test_process_scope_only',
    STRIPE_WEBHOOK_SECRET: 'whsec_process_scope_only',
    STRIPE_AUTOMATIC_TAX_ENABLED: 'false',
    STRIPE_CHECKOUT_DURATION_SECONDS: '1800',
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: '300',
    COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS: '60',
    COMMERCE_CHECKOUT_RATE_LIMIT_MAX: '5',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_REQUIRE_TLS: 'true',
    SMTP_USER: 'mailer',
    SMTP_PASSWORD: 'smtp-password',
    SMTP_FROM: 'Pale Orbit Press <books@example.com>',
    SMTP_CONNECTION_TIMEOUT_MS: '5000',
    SMTP_GREETING_TIMEOUT_MS: '5000',
    SMTP_SOCKET_TIMEOUT_MS: '10000',
    ...overrides
  };
}

describe('process-scoped configuration loaders', () => {
  it('loads database-only configuration without reading unrelated secret pointers', () => {
    const readSecretFile = vi.fn((path: string) => {
      if (path === '/run/secrets/database') return 'database-password\n';
      throw new Error(`unexpected secret read: ${path}`);
    });
    const source: EnvironmentValues = {
      DATABASE_HOST: 'postgres',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'pale_orbit',
      DATABASE_USER: 'pale_orbit_owner',
      DATABASE_PASSWORD_FILE: '/run/secrets/database',
      DATABASE_POOL_MAX: '1',
      DATABASE_CONNECTION_TIMEOUT_MS: '5000',
      DATABASE_STATEMENT_TIMEOUT_MS: '30000',
      DATABASE_READINESS_TIMEOUT_MS: '2000',
      AUTH_SECRET_FILE: '/run/secrets/auth',
      SMTP_PASSWORD_FILE: '/run/secrets/smtp',
      STRIPE_SECRET_KEY_FILE: '/run/secrets/stripe',
      STRIPE_WEBHOOK_SECRET_FILE: '/run/secrets/webhook'
    };

    expect(scopedLoaders.loadDatabaseConfig(source, readSecretFile)).toEqual({
      host: 'postgres',
      port: 5432,
      name: 'pale_orbit',
      user: 'pale_orbit_owner',
      password: 'database-password',
      poolMax: 1,
      connectionTimeoutMs: 5000,
      statementTimeoutMs: 30000,
      readinessTimeoutMs: 2000
    });
    expect(readSecretFile).toHaveBeenCalledTimes(1);
  });

  it('loads web configuration without reading or retaining SMTP credentials', () => {
    const readSecretFile = vi.fn(() => {
      throw new Error('web must not read SMTP credential files');
    });
    const config = scopedLoaders.loadWebApplicationConfig(productionEnvironment({
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      SMTP_USER_FILE: '/run/secrets/smtp-user',
      SMTP_PASSWORD_FILE: '/run/secrets/smtp-password'
    }), readSecretFile);

    expect(config.smtp).toMatchObject({ user: undefined, password: undefined });
    expect(config.storage).toMatchObject({
      stagingRoot: '/var/lib/pale-orbit/staging',
      publicationRoot: '/var/lib/pale-orbit/publication',
      coversRoot: '/var/lib/pale-orbit/covers',
      scratchRoot: '/tmp/pale-orbit-verified'
    });
    expect(config.stripe).toMatchObject({
      secretKey: 'sk_test_process_scope_only',
      webhookSecret: 'whsec_process_scope_only'
    });
    expect(readSecretFile).not.toHaveBeenCalled();
  });

  it('loads worker configuration without reading or retaining the webhook secret', () => {
    const readSecretFile = vi.fn(() => {
      throw new Error('worker must not read the webhook secret file');
    });
    const config = scopedLoaders.loadWorkerApplicationConfig(productionEnvironment({
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_WEBHOOK_SECRET_FILE: '/run/secrets/webhook'
    }), readSecretFile);

    expect(config.smtp).toMatchObject({ user: 'mailer', password: 'smtp-password' });
    expect(config.stripe).toMatchObject({
      secretKey: 'sk_test_process_scope_only',
      webhookSecret: undefined
    });
    expect(readSecretFile).not.toHaveBeenCalled();
  });

  it('fails closed for secrets required by each long-lived process', () => {
    expect(() => scopedLoaders.loadWebApplicationConfig(productionEnvironment({
      STRIPE_WEBHOOK_SECRET: undefined
    }))).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(() => scopedLoaders.loadWebApplicationConfig(productionEnvironment({
      STRIPE_SECRET_KEY: undefined
    }))).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => scopedLoaders.loadWorkerApplicationConfig(productionEnvironment({
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined
    }))).toThrow(/SMTP_USER/);
    expect(() => scopedLoaders.loadWorkerApplicationConfig(productionEnvironment({
      STRIPE_SECRET_KEY: undefined
    }))).toThrow(/STRIPE_SECRET_KEY/);
  });
});
