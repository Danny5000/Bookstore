import { env } from '$env/dynamic/private';
import { loadWebApplicationConfig } from './load';
import type { ApplicationConfig } from './schema';

export {
  loadApplicationConfig,
  loadDatabaseConfig,
  loadWebApplicationConfig,
  loadWorkerApplicationConfig
} from './load';
export type { WorkerApplicationConfig } from './load';
export type {
  ApplicationConfig,
  ApplicationMode,
  AuthConfig,
  CommerceConfig,
  DatabaseConfig,
  IngestionConfig,
  JobConfig,
  SmtpConfig,
  StorageConfig,
  StripeConfig
} from './schema';
export type { WorkerProcessConfig } from './worker';

let cachedConfiguration: ApplicationConfig | undefined;

export function getApplicationConfig(): ApplicationConfig {
  cachedConfiguration ??= loadWebApplicationConfig(env);
  return cachedConfiguration;
}
