import { readFile } from 'node:fs/promises';
import type { PlaywrightTestConfig } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withoutStripeProviderSecrets } from './test-environment';

describe('Playwright commerce fixture isolation', () => {
  let configuration: PlaywrightTestConfig;

  beforeAll(async () => {
    const isolatedEnvironment = {
      APP_ENV: 'test',
      PALE_ORBIT_TEST_PROJECT: 'pale-orbit-test-0123456789abcdef',
      DATABASE_HOST: '127.0.0.1',
      DATABASE_PORT: '55432',
      DATABASE_NAME: 'pale_orbit_test',
      DATABASE_OWNER_USER: 'pale_orbit_test',
      DATABASE_USER: 'pale_orbit_test_web',
      DATABASE_WORKER_USER: 'pale_orbit_test_worker',
      DATABASE_STORAGE_CLEANUP_USER: 'pale_orbit_test_storage_cleanup'
    };
    for (const [name, value] of Object.entries(isolatedEnvironment)) vi.stubEnv(name, value);
    configuration = (await import('../playwright.config')).default;
  });

  afterAll(() => vi.unstubAllEnvs());

  it('does not retain browser traces containing one-use action URLs', () => {
    expect(configuration.use?.trace).toBe('off');
  });

  it('uses the fixture gateway with Stripe disabled and no provider secrets', () => {
    const webServer = configuration.webServer;
    if (!webServer || Array.isArray(webServer)) throw new Error('Expected one Playwright web server');
    expect(webServer.env).toMatchObject({
      APP_ENV: 'test',
      STRIPE_ENABLED: 'false',
      STRIPE_TEST_FIXTURE_MODE: 'true'
    });
    expect(webServer.env).not.toHaveProperty('STRIPE_SECRET_KEY');
    expect(webServer.env).not.toHaveProperty('STRIPE_WEBHOOK_SECRET');
  });

  it('starts the E2E worker in fixture mode without enabling integration fixtures', async () => {
    const source = await readFile(new URL('./with-test-database.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/STRIPE_TEST_FIXTURE_MODE:\s*withWorker\s*\?\s*'true'\s*:\s*'false'/u);
  });

  it('removes direct and file-based Stripe secrets from every child environment', () => {
    expect(withoutStripeProviderSecrets({
      PATH: 'safe-path',
      STRIPE_SECRET_KEY: 'sk_test_private',
      STRIPE_SECRET_KEY_FILE: '/run/secrets/stripe-key',
      STRIPE_WEBHOOK_SECRET: 'whsec_private',
      STRIPE_WEBHOOK_SECRET_FILE: '/run/secrets/stripe-webhook'
    })).toEqual({ PATH: 'safe-path' });
  });
});
