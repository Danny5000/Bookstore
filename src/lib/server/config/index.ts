import { env } from '$env/dynamic/private';
import {
  readRequiredSetting,
  type EnvironmentValues,
  type SecretFileReader
} from './read-setting';
import { parseApplicationConfig, type ApplicationConfig } from './schema';

export type { ApplicationConfig, ApplicationMode } from './schema';

export function loadApplicationConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): ApplicationConfig {
  return parseApplicationConfig({
    APP_ENV: readRequiredSetting(source, 'APP_ENV', readSecretFile),
    APPLICATION_MODE: readRequiredSetting(source, 'APPLICATION_MODE', readSecretFile),
    ORIGIN: readRequiredSetting(source, 'ORIGIN', readSecretFile),
    DATABASE_HOST: readRequiredSetting(source, 'DATABASE_HOST', readSecretFile),
    DATABASE_PORT: readRequiredSetting(source, 'DATABASE_PORT', readSecretFile),
    DATABASE_NAME: readRequiredSetting(source, 'DATABASE_NAME', readSecretFile),
    DATABASE_USER: readRequiredSetting(source, 'DATABASE_USER', readSecretFile),
    DATABASE_PASSWORD: readRequiredSetting(source, 'DATABASE_PASSWORD', readSecretFile)
  });
}

let cachedConfiguration: ApplicationConfig | undefined;

export function getApplicationConfig(): ApplicationConfig {
  cachedConfiguration ??= loadApplicationConfig(env);
  return cachedConfiguration;
}
