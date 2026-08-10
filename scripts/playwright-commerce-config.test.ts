import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import configuration from '../playwright.config';
import { withoutStripeProviderSecrets } from './test-environment';

describe('Playwright commerce fixture isolation', () => {
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
