import { describe, expect, it, vi } from 'vitest';
import * as configLoad from './load';
import type { WorkerApplicationConfig } from './load';
import type { EnvironmentValues } from './read-setting';
import type { ApplicationConfig, DatabaseConfig } from './schema';
import { loadWorkerHealthConfig } from './worker';

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
  ): WorkerApplicationConfig;
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
    WORKER_HEARTBEAT_INTERVAL_MS: '5000',
    WORKER_HEARTBEAT_MAX_AGE_MS: '20000',
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

  it.each([
    ['full', scopedLoaders.loadApplicationConfig],
    ['web', scopedLoaders.loadWebApplicationConfig]
  ] as const)(
    '%s configuration neither reads nor retains worker-only direct or file settings',
    (_scope, load) => {
      const readSecretFile = vi.fn(() => {
        throw new Error('common application configuration must not read worker-only files');
      });
      const config = load(
        productionEnvironment({
          WORKER_READY_FILE: '/tmp/ignored-worker-ready',
          WORKER_READY_FILE_FILE: '/run/settings/ignored-worker-ready',
          WORKER_CONCURRENCY: 'invalid-and-ignored',
          WORKER_CONCURRENCY_FILE: '/run/settings/ignored-worker-concurrency',
          WORKER_HEARTBEAT_INTERVAL_MS: 'invalid-and-ignored',
          WORKER_HEARTBEAT_INTERVAL_MS_FILE: '/run/settings/ignored-worker-interval',
          WORKER_HEARTBEAT_MAX_AGE_MS: 'invalid-and-ignored',
          WORKER_HEARTBEAT_MAX_AGE_MS_FILE: '/run/settings/ignored-worker-max-age'
        }),
        readSecretFile
      );

      expect(config).not.toHaveProperty('worker');
      expect(config.jobs).toEqual({
        pollIntervalMs: 1000,
        leaseMs: 30000,
        retryBaseMs: 1000,
        retryMaxMs: 300000
      });
      expect(readSecretFile).not.toHaveBeenCalled();
    }
  );

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
    expect(config.worker).toEqual({
      heartbeatFile: '/tmp/worker-ready',
      concurrency: 1,
      heartbeatIntervalMs: 5000,
      heartbeatMaxAgeMs: 20000
    });
    expect(readSecretFile).not.toHaveBeenCalled();
  });

  it('loads worker health from exactly six noncredential settings', () => {
    const allowedValues: Readonly<Record<string, string>> = {
      '/run/settings/worker-ready': '/tmp/worker-ready\n',
      '/run/settings/worker-concurrency': '2\n',
      '/run/settings/worker-interval': '5000\n',
      '/run/settings/worker-max-age': '20000\n',
      '/run/settings/job-poll': '1000\n',
      '/run/settings/job-lease': '30000\n'
    };
    const readSecretFile = vi.fn((path: string) => {
      const value = allowedValues[path];
      if (value === undefined) throw new Error(`unexpected secret read: ${path}`);
      return value;
    });
    const source: EnvironmentValues = {
      WORKER_READY_FILE_FILE: '/run/settings/worker-ready',
      WORKER_CONCURRENCY_FILE: '/run/settings/worker-concurrency',
      WORKER_HEARTBEAT_INTERVAL_MS_FILE: '/run/settings/worker-interval',
      WORKER_HEARTBEAT_MAX_AGE_MS_FILE: '/run/settings/worker-max-age',
      JOB_POLL_INTERVAL_MS_FILE: '/run/settings/job-poll',
      JOB_LEASE_MS_FILE: '/run/settings/job-lease',
      DATABASE_PASSWORD_FILE: '/run/secrets/database',
      DATABASE_OWNER_PASSWORD_FILE: '/run/secrets/database-owner',
      DATABASE_WORKER_PASSWORD_FILE: '/run/secrets/database-worker',
      DATABASE_STORAGE_CLEANUP_PASSWORD_FILE: '/run/secrets/database-storage-cleanup',
      STORAGE_STAGING_ROOT_FILE: '/run/settings/storage',
      SMTP_USER_FILE: '/run/secrets/smtp-user',
      SMTP_PASSWORD_FILE: '/run/secrets/smtp-password',
      AUTH_SECRET_FILE: '/run/secrets/auth',
      STRIPE_SECRET_KEY_FILE: '/run/secrets/stripe',
      STRIPE_WEBHOOK_SECRET_FILE: '/run/secrets/webhook',
      ORIGIN_FILE: '/run/settings/origin',
      APPLICATION_MODE_FILE: '/run/settings/application-mode',
      JOB_RETRY_BASE_MS_FILE: '/run/settings/retry-base',
      JOB_RETRY_MAX_MS_FILE: '/run/settings/retry-max',
      BOOTSTRAP_ADMIN_PASSWORD_FILE: '/run/secrets/bootstrap'
    };

    expect(loadWorkerHealthConfig(source, readSecretFile)).toEqual({
      heartbeatFile: '/tmp/worker-ready',
      concurrency: 2,
      heartbeatIntervalMs: 5000,
      heartbeatMaxAgeMs: 20000
    });
    expect(readSecretFile.mock.calls.map(([path]) => path)).toEqual([
      '/run/settings/worker-ready',
      '/run/settings/worker-concurrency',
      '/run/settings/worker-interval',
      '/run/settings/worker-max-age',
      '/run/settings/job-poll',
      '/run/settings/job-lease'
    ]);
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
