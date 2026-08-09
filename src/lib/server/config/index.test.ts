import { describe, expect, it } from 'vitest';
import { loadApplicationConfig } from './index';
import { ConfigurationError, type EnvironmentValues } from './read-setting';

const VALID_DEVELOPMENT_ENVIRONMENT: EnvironmentValues = {
  APP_ENV: 'development',
  APPLICATION_MODE: 'prototype',
  ORIGIN: 'http://localhost:5173',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'pale_orbit',
  DATABASE_USER: 'pale_orbit',
  DATABASE_PASSWORD: 'development-only',
  DATABASE_POOL_MAX: '5',
  DATABASE_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_STATEMENT_TIMEOUT_MS: '30000',
  DATABASE_READINESS_TIMEOUT_MS: '2000',
  JOB_POLL_INTERVAL_MS: '1000',
  JOB_LEASE_MS: '30000',
  JOB_RETRY_BASE_MS: '1000',
  JOB_RETRY_MAX_MS: '300000',
  WORKER_READY_FILE: '.worker-ready',
  WORKER_CONCURRENCY: '1',
  STORAGE_PROVIDER: 'local',
  STORAGE_LOCAL_ROOT: '.data/storage',
  UPLOAD_MAX_BYTES: '536870912',
  INGEST_MAX_EXPANDED_BYTES: '2147483648',
  INGEST_MAX_ENTRIES: '10000',
  INGEST_MAX_XML_BYTES: '8388608',
  INGEST_MAX_IMAGE_PIXELS: '100000000',
  INGEST_MAX_COMPRESSION_RATIO: '200',
  INGEST_TIMEOUT_MS: '900000',
  STORAGE_STAGING_RETENTION_HOURS: '24',
  STORAGE_ORPHAN_RETENTION_HOURS: '168',
  AUTH_SECRET: 'test-only-auth-secret-at-least-thirty-two-bytes',
  AUTH_SESSION_EXPIRES_SECONDS: '604800',
  AUTH_VERIFICATION_EXPIRES_SECONDS: '3600',
  AUTH_RESET_EXPIRES_SECONDS: '3600',
  AUTH_MAGIC_EXPIRES_SECONDS: '900',
  AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
  AUTH_RATE_LIMIT_MAX: '100',
  AUTH_LOGIN_RATE_LIMIT_MAX: '5',
  AUTH_EMAIL_RATE_LIMIT_MAX: '3',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  SMTP_REQUIRE_TLS: 'false',
  SMTP_FROM: 'Pale Orbit Press <books@paleorbit.local>',
  SMTP_CONNECTION_TIMEOUT_MS: '5000',
  SMTP_GREETING_TIMEOUT_MS: '5000',
  SMTP_SOCKET_TIMEOUT_MS: '10000'
};

describe('loadApplicationConfig', () => {
  it('returns a typed configuration from direct development values', () => {
    expect(loadApplicationConfig(VALID_DEVELOPMENT_ENVIRONMENT)).toEqual({
      environment: 'development',
      applicationMode: 'prototype',
      origin: 'http://localhost:5173',
      database: {
        host: 'localhost',
        port: 5432,
        name: 'pale_orbit',
        user: 'pale_orbit',
        password: 'development-only',
        poolMax: 5,
        connectionTimeoutMs: 5000,
        statementTimeoutMs: 30000,
        readinessTimeoutMs: 2000
      },
      jobs: {
        pollIntervalMs: 1000,
        leaseMs: 30000,
        retryBaseMs: 1000,
        retryMaxMs: 300000,
        workerReadyFile: '.worker-ready',
        concurrency: 1
      },
      storage: {
        provider: 'local',
        localRoot: '.data/storage',
        stagingRetentionHours: 24,
        orphanRetentionHours: 168
      },
      ingestion: {
        maxUploadBytes: 536870912,
        maxExpandedBytes: 2147483648,
        maxEntries: 10000,
        maxXmlBytes: 8388608,
        maxImagePixels: 100000000,
        maxCompressionRatio: 200,
        timeoutMs: 900000
      },
      auth: {
        secret: 'test-only-auth-secret-at-least-thirty-two-bytes',
        sessionExpiresIn: 604800,
        verificationExpiresIn: 3600,
        resetExpiresIn: 3600,
        magicExpiresIn: 900,
        rateLimit: {
          windowSeconds: 60,
          max: 100,
          loginMax: 5,
          emailMax: 3
        }
      },
      smtp: {
        host: '127.0.0.1',
        port: 1025,
        secure: false,
        requireTls: false,
        user: undefined,
        password: undefined,
        from: 'Pale Orbit Press <books@paleorbit.local>',
        connectionTimeoutMs: 5000,
        greetingTimeoutMs: 5000,
        socketTimeoutMs: 10000
      }
    });
  });

  it('returns bounded database and worker settings', () => {
    const config = loadApplicationConfig(VALID_DEVELOPMENT_ENVIRONMENT);

    expect(config.database).toMatchObject({
      poolMax: 5,
      connectionTimeoutMs: 5000,
      statementTimeoutMs: 30000,
      readinessTimeoutMs: 2000
    });
    expect(config.jobs).toEqual({
      pollIntervalMs: 1000,
      leaseMs: 30000,
      retryBaseMs: 1000,
      retryMaxMs: 300000,
      workerReadyFile: '.worker-ready',
      concurrency: 1
    });
    expect(config.storage).toEqual({
      provider: 'local',
      localRoot: '.data/storage',
      stagingRetentionHours: 24,
      orphanRetentionHours: 168
    });
    expect(config.ingestion).toEqual({
      maxUploadBytes: 536870912,
      maxExpandedBytes: 2147483648,
      maxEntries: 10000,
      maxXmlBytes: 8388608,
      maxImagePixels: 100000000,
      maxCompressionRatio: 200,
      timeoutMs: 900000
    });
  });

  it.each([
    ['DATABASE_POOL_MAX', '0'],
    ['DATABASE_READINESS_TIMEOUT_MS', 'not-a-number'],
    ['JOB_POLL_INTERVAL_MS', '0'],
    ['JOB_LEASE_MS', '500'],
    ['WORKER_CONCURRENCY', '0'],
    ['WORKER_CONCURRENCY', '17'],
    ['UPLOAD_MAX_BYTES', '0'],
    ['INGEST_MAX_ENTRIES', '100001'],
    ['INGEST_MAX_COMPRESSION_RATIO', '0']
  ])('rejects invalid operational setting %s=%s', (key, value) => {
    expect(() =>
      loadApplicationConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, [key]: value })
    ).toThrow(ConfigurationError);
  });

  it('rejects a retry base greater than the retry ceiling', () => {
    expect(() =>
      loadApplicationConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        JOB_RETRY_BASE_MS: '6000',
        JOB_RETRY_MAX_MS: '5000'
      })
    ).toThrow(/JOB_RETRY_BASE_MS: must not exceed JOB_RETRY_MAX_MS/);
  });

  it('rejects inconsistent ingestion and retention bounds', () => {
    expect(() =>
      loadApplicationConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        UPLOAD_MAX_BYTES: '1000',
        INGEST_MAX_EXPANDED_BYTES: '999'
      })
    ).toThrow(/INGEST_MAX_EXPANDED_BYTES: must be greater than or equal to UPLOAD_MAX_BYTES/);

    expect(() =>
      loadApplicationConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        INGEST_MAX_EXPANDED_BYTES: '1000',
        INGEST_MAX_XML_BYTES: '1001'
      })
    ).toThrow(/INGEST_MAX_XML_BYTES: must not exceed INGEST_MAX_EXPANDED_BYTES/);

    expect(() =>
      loadApplicationConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        STORAGE_STAGING_RETENTION_HOURS: '169'
      })
    ).toThrow(/STORAGE_ORPHAN_RETENTION_HOURS: must be at least STORAGE_STAGING_RETENTION_HOURS/);
  });

  it('requires a local root only for local storage', () => {
    const withoutLocalRoot: EnvironmentValues = {
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      STORAGE_LOCAL_ROOT: undefined
    };

    expect(() => loadApplicationConfig(withoutLocalRoot)).toThrow(
      /STORAGE_LOCAL_ROOT: is required for local storage/
    );

    expect(
      loadApplicationConfig({ ...withoutLocalRoot, STORAGE_PROVIDER: 's3' }).storage
    ).toEqual({
      provider: 's3',
      localRoot: undefined,
      stagingRetentionHours: 24,
      orphanRetentionHours: 168
    });
  });

  it('rejects unknown providers and relative production storage roots', () => {
    expect(() =>
      loadApplicationConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, STORAGE_PROVIDER: 'ftp' })
    ).toThrow(/STORAGE_PROVIDER/);

    expect(() =>
      loadApplicationConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        APP_ENV: 'production',
        APPLICATION_MODE: 'maintenance',
        ORIGIN: 'https://books.example.com',
        SMTP_USER: 'mailer',
        SMTP_PASSWORD: 'smtp-secret'
      })
    ).toThrow(/STORAGE_LOCAL_ROOT: must be absolute in production/);
  });

  it('loads the database password from a production secret file', () => {
    const source: EnvironmentValues = {
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      APP_ENV: 'production',
      APPLICATION_MODE: 'maintenance',
      ORIGIN: 'https://books.example.com',
      DATABASE_HOST: 'postgres',
      DATABASE_PASSWORD: undefined,
      DATABASE_PASSWORD_FILE: '/run/secrets/database_password',
      STORAGE_LOCAL_ROOT: 'C:\\pale-orbit-storage',
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'smtp-secret'
    };

    const config = loadApplicationConfig(source, (path) => {
      expect(path).toBe('/run/secrets/database_password');
      return 'production-secret\n';
    });

    expect(config.environment).toBe('production');
    expect(config.applicationMode).toBe('maintenance');
    expect(config.database.password).toBe('production-secret');
  });

  it('rejects prototype mode in production', () => {
    const source: EnvironmentValues = {
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      APP_ENV: 'production',
      APPLICATION_MODE: 'prototype',
      ORIGIN: 'https://books.example.com'
    };

    expect(() => loadApplicationConfig(source)).toThrow(
      /APPLICATION_MODE: production must use maintenance mode/
    );
  });

  it('rejects an auth secret shorter than 32 characters', () => {
    expect(() =>
      loadApplicationConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, AUTH_SECRET: 'too-short' })
    ).toThrow(/AUTH_SECRET/);
  });

  it('rejects invalid SMTP security combinations and credentials', () => {
    expect(() =>
      loadApplicationConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        SMTP_SECURE: 'true',
        SMTP_REQUIRE_TLS: 'true'
      })
    ).toThrow(/SMTP_REQUIRE_TLS/);

    expect(() =>
      loadApplicationConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, SMTP_USER: 'mailer' })
    ).toThrow(/SMTP_PASSWORD/);
  });

  it('requires https and authenticated SMTP in production', () => {
    expect(() =>
      loadApplicationConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        APP_ENV: 'production',
        APPLICATION_MODE: 'maintenance',
        ORIGIN: 'http://books.example.com'
      })
    ).toThrow(/ORIGIN: production must use https/);

    expect(() =>
      loadApplicationConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        APP_ENV: 'production',
        APPLICATION_MODE: 'maintenance',
        ORIGIN: 'https://books.example.com'
      })
    ).toThrow(/SMTP_USER: production SMTP credentials are required/);
  });

  it.each([
    ['ORIGIN', 'ftp://books.example.com'],
    ['DATABASE_PORT', '0'],
    ['DATABASE_PORT', 'not-a-port']
  ])('rejects invalid %s values', (key, value) => {
    expect(() =>
      loadApplicationConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, [key]: value })
    ).toThrow(ConfigurationError);
  });

  it('does not include the database password in validation errors', () => {
    const source: EnvironmentValues = {
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      DATABASE_PORT: 'invalid',
      DATABASE_PASSWORD: 'must-never-appear-in-an-error'
    };

    let thrown: unknown;
    try {
      loadApplicationConfig(source);
    } catch (cause: unknown) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as Error).message).not.toContain('must-never-appear-in-an-error');
  });
});
