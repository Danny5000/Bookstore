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
    STORAGE_STAGING_ROOT: '.data/storage-staging',
    STORAGE_PUBLICATION_ROOT: '.data/storage-publication',
    STORAGE_COVERS_ROOT: '.data/storage-covers',
    STORAGE_SCRATCH_ROOT: 'C:\\Temp\\pale-orbit-storage-scratch',
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
        provider: 'local',
        stagingRoot: '.data/storage-staging',
        publicationRoot: '.data/storage-publication',
        coversRoot: '.data/storage-covers',
        scratchRoot: 'C:\\Temp\\pale-orbit-storage-scratch',
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

  it('requires absolute disjoint local roots in production and preserves the shared bounds', () => {
    expect(() => loadStorageMaintenanceConfig(environment({ APP_ENV: 'production' })))
      .toThrow(ConfigurationError);
    expect(() => loadStorageMaintenanceConfig(environment({ DATABASE_POOL_MAX: '101' })))
      .toThrow(ConfigurationError);
    expect(() => loadStorageMaintenanceConfig(environment({
      STORAGE_STAGING_RETENTION_HOURS: '169', STORAGE_ORPHAN_RETENTION_HOURS: '168'
    }))).toThrow(ConfigurationError);

    const production = loadStorageMaintenanceConfig(environment({
      APP_ENV: 'production',
      STORAGE_STAGING_ROOT: '/var/lib/pale-orbit/staging',
      STORAGE_PUBLICATION_ROOT: '/var/lib/pale-orbit/publication',
      STORAGE_COVERS_ROOT: '/var/lib/pale-orbit/covers',
      STORAGE_SCRATCH_ROOT: '/tmp/pale-orbit-verified'
    }));
    expect(production.storage).toMatchObject({
      stagingRoot: '/var/lib/pale-orbit/staging',
      publicationRoot: '/var/lib/pale-orbit/publication',
      coversRoot: '/var/lib/pale-orbit/covers',
      scratchRoot: '/tmp/pale-orbit-verified'
    });
    expect(() => loadStorageMaintenanceConfig(environment({
      STORAGE_PUBLICATION_ROOT: '.data/storage-staging'
    }))).toThrow(/mutually disjoint/);
  });

  it('allows the provider-neutral S3 value so the storage factory fails explicitly', () => {
    const config = loadStorageMaintenanceConfig(environment({
      STORAGE_PROVIDER: 's3',
      STORAGE_STAGING_ROOT: undefined,
      STORAGE_PUBLICATION_ROOT: undefined,
      STORAGE_COVERS_ROOT: undefined,
      STORAGE_SCRATCH_ROOT: undefined
    }));
    expect(config.storage).toMatchObject({
      provider: 's3',
      stagingRoot: undefined,
      publicationRoot: undefined,
      coversRoot: undefined,
      scratchRoot: undefined
    });
  });

  it('accepts dry-run or the exact writer-quiescence apply attestation', () => {
    expect(parseStorageCleanupArguments([])).toBe('dry-run');
    expect(parseStorageCleanupArguments(['--apply', '--writers-quiesced'])).toBe('apply');
    for (const invalid of [
      ['--apply'],
      ['--writers-quiesced'],
      ['--writers-quiesced', '--apply'],
      ['--apply', '--writers-quiesced', '--writers-quiesced'],
      ['--apply', '--writers-quiesced', 'extra'],
      ['--dry-run']
    ]) {
      expect(() => parseStorageCleanupArguments(invalid)).toThrow(
        'Usage: storage:cleanup [--apply --writers-quiesced]'
      );
    }
  });
});
