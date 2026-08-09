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

const OPTIONAL_SETTINGS = ['SMTP_USER', 'SMTP_PASSWORD'] as const;

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
