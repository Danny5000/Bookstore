import { env } from '$env/dynamic/private';
import { loadApplicationConfig } from './load';
import type { ApplicationConfig } from './schema';

export { loadApplicationConfig } from './load';
export type {
  ApplicationConfig,
  ApplicationMode,
  DatabaseConfig,
  JobConfig
} from './schema';

let cachedConfiguration: ApplicationConfig | undefined;

export function getApplicationConfig(): ApplicationConfig {
  cachedConfiguration ??= loadApplicationConfig(env);
  return cachedConfiguration;
}
