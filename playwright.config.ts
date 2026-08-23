import { defineConfig, devices } from '@playwright/test';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { assertIsolatedTestDatabaseEnvironment } from './scripts/test-environment';

assertIsolatedTestDatabaseEnvironment(process.env);

function sameResolvedPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function createEmptyE2EEnvironmentDirectory(): string {
  const workerReadyFile = process.env.WORKER_READY_FILE;
  if (
    workerReadyFile === undefined ||
    !isAbsolute(workerReadyFile) ||
    basename(workerReadyFile) !== 'worker.ready'
  ) {
    throw new Error('Invalid E2E environment isolation root');
  }

  const ownedRoot = dirname(resolve(workerReadyFile));
  const temporaryRoot = resolve(tmpdir());
  if (
    !sameResolvedPath(dirname(ownedRoot), temporaryRoot) ||
    !/^pale-orbit-test-storage-[A-Za-z0-9-]+$/u.test(basename(ownedRoot))
  ) {
    throw new Error('Invalid E2E environment isolation root');
  }

  const ownedRootStatus = lstatSync(ownedRoot);
  if (
    !ownedRootStatus.isDirectory() ||
    ownedRootStatus.isSymbolicLink() ||
    !sameResolvedPath(resolve(realpathSync(ownedRoot)), ownedRoot)
  ) {
    throw new Error('Invalid E2E environment isolation root');
  }

  const emptyDirectory = join(ownedRoot, 'dotenv-empty');
  try {
    mkdirSync(emptyDirectory);
  } catch (error: unknown) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error;
    }
  }
  const emptyDirectoryStatus = lstatSync(emptyDirectory);
  if (
    !emptyDirectoryStatus.isDirectory() ||
    emptyDirectoryStatus.isSymbolicLink() ||
    !sameResolvedPath(resolve(realpathSync(emptyDirectory)), emptyDirectory) ||
    readdirSync(emptyDirectory).length !== 0
  ) {
    throw new Error('Invalid E2E environment isolation directory');
  }
  return emptyDirectory;
}

const emptyE2EEnvironmentDirectory = createEmptyE2EEnvironmentDirectory();

const operatingEnvironmentNames = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SHELL',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR'
]);

const inheritedEnvironmentTombstones = Object.fromEntries(
  Object.keys(process.env).map((name) => [name, undefined])
);
const projectedOperatingEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      operatingEnvironmentNames.has(entry[0].toUpperCase())
  )
);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'off',
    screenshot: 'off',
    video: 'off'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command:
      'npm run build:web && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/health/live',
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      // Playwright merges the runner's process.env before this object. Undefined
      // entries therefore become deletion tombstones when Node spawns the web
      // process, while the runner retains its fixture-only credentials.
      ...inheritedEnvironmentTombstones,
      ...projectedOperatingEnvironment,
      APP_ENV: 'test',
      APPLICATION_MODE: 'prototype',
      ORIGIN: 'http://127.0.0.1:4173',
      PALE_ORBIT_E2E_ENV_ISOLATION: '1',
      PALE_ORBIT_E2E_EMPTY_ENV_DIR: emptyE2EEnvironmentDirectory,
      DATABASE_HOST: process.env.DATABASE_HOST ?? '127.0.0.1',
      DATABASE_PORT: process.env.DATABASE_PORT ?? '5432',
      DATABASE_NAME: process.env.DATABASE_NAME ?? 'pale_orbit_test',
      DATABASE_USER: process.env.DATABASE_USER ?? 'pale_orbit_test_web',
      DATABASE_PASSWORD:
        process.env.DATABASE_PASSWORD ?? 'pale_orbit_test_only',
      DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? '5',
      DATABASE_CONNECTION_TIMEOUT_MS:
        process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? '5000',
      DATABASE_STATEMENT_TIMEOUT_MS:
        process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? '30000',
      DATABASE_READINESS_TIMEOUT_MS:
        process.env.DATABASE_READINESS_TIMEOUT_MS ?? '2000',
      JOB_POLL_INTERVAL_MS: process.env.JOB_POLL_INTERVAL_MS ?? '25',
      JOB_LEASE_MS: process.env.JOB_LEASE_MS ?? '5000',
      JOB_RETRY_BASE_MS: process.env.JOB_RETRY_BASE_MS ?? '10',
      JOB_RETRY_MAX_MS: process.env.JOB_RETRY_MAX_MS ?? '1000',
      WORKER_READY_FILE: '.worker-ready-web-process-unused',
      WORKER_CONCURRENCY: '1',
      STORAGE_PROVIDER: process.env.STORAGE_PROVIDER ?? 'local',
      STORAGE_STAGING_ROOT:
        process.env.STORAGE_STAGING_ROOT ?? '.data/test-e2e-storage-staging',
      STORAGE_PUBLICATION_ROOT:
        process.env.STORAGE_PUBLICATION_ROOT ??
        '.data/test-e2e-storage-publication',
      STORAGE_COVERS_ROOT:
        process.env.STORAGE_COVERS_ROOT ?? '.data/test-e2e-storage-covers',
      STORAGE_SCRATCH_ROOT:
        process.env.STORAGE_SCRATCH_ROOT ??
        join(tmpdir(), `pale-orbit-e2e-storage-scratch-${process.pid}`),
      UPLOAD_MAX_BYTES: process.env.UPLOAD_MAX_BYTES ?? '1048576',
      INGEST_MAX_EXPANDED_BYTES:
        process.env.INGEST_MAX_EXPANDED_BYTES ?? '4194304',
      INGEST_MAX_ENTRIES: process.env.INGEST_MAX_ENTRIES ?? '1000',
      INGEST_MAX_XML_BYTES: process.env.INGEST_MAX_XML_BYTES ?? '1048576',
      INGEST_MAX_IMAGE_PIXELS:
        process.env.INGEST_MAX_IMAGE_PIXELS ?? '100000000',
      INGEST_MAX_COMPRESSION_RATIO:
        process.env.INGEST_MAX_COMPRESSION_RATIO ?? '200',
      INGEST_TIMEOUT_MS: process.env.INGEST_TIMEOUT_MS ?? '60000',
      STORAGE_STAGING_RETENTION_HOURS:
        process.env.STORAGE_STAGING_RETENTION_HOURS ?? '1',
      STORAGE_ORPHAN_RETENTION_HOURS:
        process.env.STORAGE_ORPHAN_RETENTION_HOURS ?? '2',
      AUTH_SECRET: 'test-only-web-auth-secret-at-least-thirty-two-bytes',
      AUTH_SESSION_EXPIRES_SECONDS:
        process.env.AUTH_SESSION_EXPIRES_SECONDS ?? '3600',
      AUTH_VERIFICATION_EXPIRES_SECONDS:
        process.env.AUTH_VERIFICATION_EXPIRES_SECONDS ?? '600',
      AUTH_RESET_EXPIRES_SECONDS:
        process.env.AUTH_RESET_EXPIRES_SECONDS ?? '600',
      AUTH_MAGIC_EXPIRES_SECONDS:
        process.env.AUTH_MAGIC_EXPIRES_SECONDS ?? '600',
      AUTH_RATE_LIMIT_WINDOW_SECONDS:
        process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS ?? '60',
      // Every E2E context shares the loopback IP, so layout session polling and legitimate
      // cross-journey sign-ins otherwise consume one suite-wide bucket. Integration tests
      // retain the production limiter values and prove the endpoint-specific boundaries.
      AUTH_RATE_LIMIT_MAX: '100000',
      AUTH_LOGIN_RATE_LIMIT_MAX: '10000',
      AUTH_EMAIL_RATE_LIMIT_MAX: process.env.AUTH_EMAIL_RATE_LIMIT_MAX ?? '3',
      STRIPE_ENABLED: 'false',
      STRIPE_TEST_FIXTURE_MODE: 'true',
      STRIPE_LIVE_MODE: 'false',
      STRIPE_AUTOMATIC_TAX_ENABLED:
        process.env.STRIPE_AUTOMATIC_TAX_ENABLED ?? 'false',
      STRIPE_CHECKOUT_DURATION_SECONDS:
        process.env.STRIPE_CHECKOUT_DURATION_SECONDS ?? '1800',
      STRIPE_WEBHOOK_TOLERANCE_SECONDS:
        process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS ?? '300',
      COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS:
        process.env.COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS ?? '60',
      COMMERCE_CHECKOUT_RATE_LIMIT_MAX:
        process.env.COMMERCE_CHECKOUT_RATE_LIMIT_MAX ?? '5',
      SMTP_HOST: process.env.SMTP_HOST ?? '127.0.0.1',
      SMTP_PORT: process.env.SMTP_PORT ?? '1025',
      SMTP_SECURE: process.env.SMTP_SECURE ?? 'false',
      SMTP_REQUIRE_TLS: process.env.SMTP_REQUIRE_TLS ?? 'false',
      SMTP_FROM:
        process.env.SMTP_FROM ?? 'Pale Orbit Test <books@paleorbit.test>',
      SMTP_CONNECTION_TIMEOUT_MS:
        process.env.SMTP_CONNECTION_TIMEOUT_MS ?? '5000',
      SMTP_GREETING_TIMEOUT_MS: process.env.SMTP_GREETING_TIMEOUT_MS ?? '5000',
      SMTP_SOCKET_TIMEOUT_MS: process.env.SMTP_SOCKET_TIMEOUT_MS ?? '10000'
    } as Record<string, string>
  }
});
