import {
  readOptionalSetting,
  readRequiredSetting,
  type EnvironmentValues,
  type SecretFileReader
} from './read-setting';
import {
  parseApplicationConfig,
  parseDatabaseConfig,
  type ApplicationConfig,
  type ApplicationConfigScope,
  type DatabaseConfig
} from './schema';
import { loadWorkerHealthConfig, type WorkerProcessConfig } from './worker';

export type WorkerApplicationConfig = ApplicationConfig & {
  readonly worker: WorkerProcessConfig;
};

const DATABASE_SETTINGS = [
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
  'DATABASE_POOL_MAX',
  'DATABASE_CONNECTION_TIMEOUT_MS',
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'DATABASE_READINESS_TIMEOUT_MS'
] as const;

const REQUIRED_SETTINGS = [
  'APP_ENV',
  'APPLICATION_MODE',
  'ORIGIN',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
  'DATABASE_POOL_MAX',
  'DATABASE_CONNECTION_TIMEOUT_MS',
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'DATABASE_READINESS_TIMEOUT_MS',
  'JOB_POLL_INTERVAL_MS',
  'JOB_LEASE_MS',
  'JOB_RETRY_BASE_MS',
  'JOB_RETRY_MAX_MS',
  'STORAGE_PROVIDER',
  'UPLOAD_MAX_BYTES',
  'INGEST_MAX_EXPANDED_BYTES',
  'INGEST_MAX_ENTRIES',
  'INGEST_MAX_XML_BYTES',
  'INGEST_MAX_IMAGE_PIXELS',
  'INGEST_MAX_COMPRESSION_RATIO',
  'INGEST_TIMEOUT_MS',
  'STORAGE_STAGING_RETENTION_HOURS',
  'STORAGE_ORPHAN_RETENTION_HOURS',
  'AUTH_SECRET',
  'AUTH_SESSION_EXPIRES_SECONDS',
  'AUTH_VERIFICATION_EXPIRES_SECONDS',
  'AUTH_RESET_EXPIRES_SECONDS',
  'AUTH_MAGIC_EXPIRES_SECONDS',
  'AUTH_RATE_LIMIT_WINDOW_SECONDS',
  'AUTH_RATE_LIMIT_MAX',
  'AUTH_LOGIN_RATE_LIMIT_MAX',
  'AUTH_EMAIL_RATE_LIMIT_MAX',
  'STRIPE_ENABLED',
  'STRIPE_TEST_FIXTURE_MODE',
  'STRIPE_LIVE_MODE',
  'STRIPE_AUTOMATIC_TAX_ENABLED',
  'STRIPE_CHECKOUT_DURATION_SECONDS',
  'STRIPE_WEBHOOK_TOLERANCE_SECONDS',
  'COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS',
  'COMMERCE_CHECKOUT_RATE_LIMIT_MAX',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_REQUIRE_TLS',
  'SMTP_FROM',
  'SMTP_CONNECTION_TIMEOUT_MS',
  'SMTP_GREETING_TIMEOUT_MS',
  'SMTP_SOCKET_TIMEOUT_MS'
] as const;

const OPTIONAL_SETTINGS = [
  'SMTP_USER',
  'SMTP_PASSWORD',
  'STORAGE_STAGING_ROOT',
  'STORAGE_PUBLICATION_ROOT',
  'STORAGE_COVERS_ROOT',
  'STORAGE_SCRATCH_ROOT',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_TAX_CODE_PROSE',
  'STRIPE_TAX_CODE_COMIC'
] as const;

function loadScopedApplicationConfig(
  source: EnvironmentValues,
  scope: ApplicationConfigScope,
  optionalSettings: readonly (typeof OPTIONAL_SETTINGS)[number][],
  readSecretFile?: SecretFileReader
): ApplicationConfig {
  return parseApplicationConfig(
    Object.fromEntries([
      ...REQUIRED_SETTINGS.map((name) => [
        name,
        readRequiredSetting(source, name, readSecretFile)
      ]),
      ...optionalSettings.map((name) => [
        name,
        readOptionalSetting(source, name, readSecretFile)
      ])
    ]),
    scope
  );
}

export function loadApplicationConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): ApplicationConfig {
  return loadScopedApplicationConfig(source, 'full', OPTIONAL_SETTINGS, readSecretFile);
}

export function loadWebApplicationConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): ApplicationConfig {
  return loadScopedApplicationConfig(
    source,
    'web',
    OPTIONAL_SETTINGS.filter((name) => name !== 'SMTP_USER' && name !== 'SMTP_PASSWORD'),
    readSecretFile
  );
}

export function loadWorkerApplicationConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): WorkerApplicationConfig {
  return {
    ...loadScopedApplicationConfig(
      source,
      'worker',
      OPTIONAL_SETTINGS.filter((name) => name !== 'STRIPE_WEBHOOK_SECRET'),
      readSecretFile
    ),
    worker: loadWorkerHealthConfig(source, readSecretFile)
  };
}

export function loadDatabaseConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): DatabaseConfig {
  return parseDatabaseConfig(
    Object.fromEntries(
      DATABASE_SETTINGS.map((name) => [name, readRequiredSetting(source, name, readSecretFile)])
    )
  );
}
