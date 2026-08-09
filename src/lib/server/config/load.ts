import {
  readOptionalSetting,
  readRequiredSetting,
  type EnvironmentValues,
  type SecretFileReader
} from './read-setting';
import { parseApplicationConfig, type ApplicationConfig } from './schema';

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
  'WORKER_READY_FILE',
  'WORKER_CONCURRENCY',
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
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_REQUIRE_TLS',
  'SMTP_FROM',
  'SMTP_CONNECTION_TIMEOUT_MS',
  'SMTP_GREETING_TIMEOUT_MS',
  'SMTP_SOCKET_TIMEOUT_MS'
] as const;

const OPTIONAL_SETTINGS = ['SMTP_USER', 'SMTP_PASSWORD', 'STORAGE_LOCAL_ROOT'] as const;

export function loadApplicationConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): ApplicationConfig {
  return parseApplicationConfig(
    Object.fromEntries([
      ...REQUIRED_SETTINGS.map((name) => [
        name,
        readRequiredSetting(source, name, readSecretFile)
      ]),
      ...OPTIONAL_SETTINGS.map((name) => [
        name,
        readOptionalSetting(source, name, readSecretFile)
      ])
    ])
  );
}
