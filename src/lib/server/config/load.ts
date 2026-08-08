import {
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
  'WORKER_READY_FILE'
] as const;

export function loadApplicationConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): ApplicationConfig {
  return parseApplicationConfig(
    Object.fromEntries(
      REQUIRED_SETTINGS.map((name) => [
        name,
        readRequiredSetting(source, name, readSecretFile)
      ])
    )
  );
}
