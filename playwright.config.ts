import { defineConfig, devices } from '@playwright/test';

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  )
);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/health/live',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...inheritedEnvironment,
      APP_ENV: 'test',
      APPLICATION_MODE: 'prototype',
      ORIGIN: 'http://127.0.0.1:4173',
      DATABASE_HOST: process.env.DATABASE_HOST ?? '127.0.0.1',
      DATABASE_PORT: process.env.DATABASE_PORT ?? '5432',
      DATABASE_NAME: process.env.DATABASE_NAME ?? 'pale_orbit_test',
      DATABASE_USER: process.env.DATABASE_USER ?? 'pale_orbit_test',
      DATABASE_PASSWORD: process.env.DATABASE_PASSWORD ?? 'pale_orbit_test_only',
      DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? '5',
      DATABASE_CONNECTION_TIMEOUT_MS: process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? '5000',
      DATABASE_STATEMENT_TIMEOUT_MS: process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? '30000',
      DATABASE_READINESS_TIMEOUT_MS: process.env.DATABASE_READINESS_TIMEOUT_MS ?? '2000',
      JOB_POLL_INTERVAL_MS: process.env.JOB_POLL_INTERVAL_MS ?? '25',
      JOB_LEASE_MS: process.env.JOB_LEASE_MS ?? '5000',
      JOB_RETRY_BASE_MS: process.env.JOB_RETRY_BASE_MS ?? '10',
      JOB_RETRY_MAX_MS: process.env.JOB_RETRY_MAX_MS ?? '1000',
      WORKER_READY_FILE: process.env.WORKER_READY_FILE ?? '.worker-ready-test'
    }
  }
});
