import { describe, expect, it } from 'vitest';
import { ConfigurationError } from './read-setting';
import { loadStorageMaintenanceConfig, parseStorageCleanupArguments } from './storage-maintenance';

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'development',
    DATABASE_HOST: 'localhost',
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'pale_orbit',
    DATABASE_USER: 'pale_orbit',
    DATABASE_PASSWORD: 'local-password',
    DATABASE_POOL_MAX: '2',
    DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_STATEMENT_TIMEOUT_MS: '30000',
    DATABASE_READINESS_TIMEOUT_MS: '2000',
    STORAGE_PROVIDER: 'local',
    STORAGE_LOCAL_ROOT: '.data/storage',
    STORAGE_STAGING_RETENTION_HOURS: '24',
    STORAGE_ORPHAN_RETENTION_HOURS: '168',
    ...overrides
  };
}

describe('storage maintenance configuration', () => {
  it('loads only database, storage, and environment settings', () => {
    const config = loadStorageMaintenanceConfig(environment({
      AUTH_SECRET: 'must-not-be-retained',
      SMTP_PASSWORD: 'must-not-be-retained',
      ORIGIN: 'https://must-not-be-retained.example',
      JOB_LEASE_MS: '9999'
    }));
    expect(config).toEqual({
      environment: 'development',
      database: {
        host: 'localhost', port: 5432, name: 'pale_orbit', user: 'pale_orbit',
        password: 'local-password', poolMax: 2, connectionTimeoutMs: 5000,
        statementTimeoutMs: 30000, readinessTimeoutMs: 2000
      },
      storage: {
        provider: 'local', localRoot: '.data/storage',
        stagingRetentionHours: 24, orphanRetentionHours: 168
      }
    });
    expect(config).not.toHaveProperty('auth');
    expect(config).not.toHaveProperty('smtp');
    expect(config).not.toHaveProperty('origin');
    expect(config).not.toHaveProperty('jobs');
  });

  it('does not require unrelated application settings', () => {
    expect(() => loadStorageMaintenanceConfig(environment())).not.toThrow();
  });

  it('supports the existing database password file convention', () => {
    const values = environment({ DATABASE_PASSWORD: undefined, DATABASE_PASSWORD_FILE: '/run/secrets/database_password' });
    expect(loadStorageMaintenanceConfig(values, (path) => path === '/run/secrets/database_password' ? 'secret-value\n' : '')
      .database.password).toBe('secret-value');
  });

  it('requires an absolute local root in production and preserves the shared bounds', () => {
    expect(() => loadStorageMaintenanceConfig(environment({ APP_ENV: 'production' })))
      .toThrow(ConfigurationError);
    expect(() => loadStorageMaintenanceConfig(environment({ DATABASE_POOL_MAX: '101' })))
      .toThrow(ConfigurationError);
    expect(() => loadStorageMaintenanceConfig(environment({
      STORAGE_STAGING_RETENTION_HOURS: '169', STORAGE_ORPHAN_RETENTION_HOURS: '168'
    }))).toThrow(ConfigurationError);

    const production = loadStorageMaintenanceConfig(environment({
      APP_ENV: 'production', STORAGE_LOCAL_ROOT: '/var/lib/pale-orbit/storage'
    }));
    expect(production.storage.localRoot).toBe('/var/lib/pale-orbit/storage');
  });

  it('allows the provider-neutral S3 value so the storage factory fails explicitly', () => {
    const config = loadStorageMaintenanceConfig(environment({
      STORAGE_PROVIDER: 's3', STORAGE_LOCAL_ROOT: undefined
    }));
    expect(config.storage).toMatchObject({ provider: 's3', localRoot: undefined });
  });

  it('accepts exactly dry-run or explicit apply command arguments', () => {
    expect(parseStorageCleanupArguments([])).toBe('dry-run');
    expect(parseStorageCleanupArguments(['--apply'])).toBe('apply');
    expect(() => parseStorageCleanupArguments(['--dry-run'])).toThrow('Usage:');
    expect(() => parseStorageCleanupArguments(['--apply', 'extra'])).toThrow('Usage:');
  });
});
