import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const executeFile = promisify(execFile);

interface ComposeService {
  environment?: Record<string, string>;
  secrets?: Array<{ source: string; target: string }>;
}

interface ComposeConfiguration {
  services: Record<string, ComposeService>;
  secrets: Record<string, { environment: string }>;
}

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

async function composeConfiguration(...files: string[]): Promise<ComposeConfiguration> {
  const arguments_ = [
    ...files.flatMap((file) => ['--file', file]),
    '--profile',
    'tools'
  ];
  const { stdout } = await executeFile(
    'docker',
    ['compose', ...arguments_, 'config', '--format', 'json'],
    {
      cwd: new URL('.', root),
      env: {
        ...process.env,
        APP_IMAGE: 'registry.invalid/pale-orbit@sha256:validation-only',
        ORIGIN: 'https://bookstore.invalid',
        DATABASE_NAME: 'validation_database',
        DATABASE_USER: 'validation_user',
        SMTP_HOST: 'smtp.invalid',
        SMTP_PORT: '587',
        SMTP_SECURE: 'false',
        SMTP_REQUIRE_TLS: 'true',
        SMTP_USER: 'validation_user',
        SMTP_FROM: 'Validation <noreply@bookstore.invalid>',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@bookstore.invalid',
        BOOTSTRAP_ADMIN_NAME: 'Validation Administrator',
        SITE_ADDRESS: 'bookstore.invalid',
        STRIPE_SECRET_KEY: undefined,
        STRIPE_WEBHOOK_SECRET: undefined
      }
    }
  );
  return JSON.parse(stdout) as ComposeConfiguration;
}

function mountedSecretSources(service: ComposeService): string[] {
  return (service.secrets ?? []).map((secret) => secret.source).sort();
}

describe('commerce operations contract', () => {
  it('keeps every production application process disabled and maintenance-only', async () => {
    const compose = await composeConfiguration('compose.prod.yaml');
    for (const name of ['app', 'worker', 'migrate', 'bootstrap-admin']) {
      expect(compose.services[name]?.environment, name).toMatchObject({
        APPLICATION_MODE: 'maintenance',
        STRIPE_ENABLED: 'false',
        STRIPE_TEST_FIXTURE_MODE: 'false',
        STRIPE_LIVE_MODE: 'false',
        STRIPE_CHECKOUT_DURATION_SECONDS: '1800',
        STRIPE_WEBHOOK_TOLERANCE_SECONDS: '300',
        COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS: '60',
        COMMERCE_CHECKOUT_RATE_LIMIT_MAX: '5'
      });
    }
    for (const [name, service] of Object.entries(compose.services)) {
      if (service.environment?.STRIPE_ENABLED !== undefined) {
        expect(service.environment, name).toMatchObject({
          STRIPE_ENABLED: 'false',
          STRIPE_TEST_FIXTURE_MODE: 'false',
          STRIPE_LIVE_MODE: 'false'
        });
      }
      expect(service.environment, name).not.toHaveProperty('STRIPE_SECRET_KEY');
      expect(service.environment, name).not.toHaveProperty('STRIPE_WEBHOOK_SECRET');
      expect(service.environment, name).not.toHaveProperty('STRIPE_SECRET_KEY_FILE');
      expect(service.environment, name).not.toHaveProperty('STRIPE_WEBHOOK_SECRET_FILE');
    }
  });

  it('enables and mounts Stripe secrets only in app and worker after merging the overlay', async () => {
    const baseline = await composeConfiguration('compose.prod.yaml');
    const merged = await composeConfiguration('compose.prod.yaml', 'compose.stripe.yaml');
    const stripeServices = ['app', 'worker'];
    expect(Object.entries(merged.services)
      .filter(([, service]) => service.environment?.STRIPE_ENABLED === 'true')
      .map(([name]) => name)
      .sort()).toEqual(stripeServices);
    for (const fileSetting of ['STRIPE_SECRET_KEY_FILE', 'STRIPE_WEBHOOK_SECRET_FILE']) {
      expect(Object.entries(merged.services)
        .filter(([, service]) => service.environment?.[fileSetting] !== undefined)
        .map(([name]) => name)
        .sort()).toEqual(stripeServices);
    }
    for (const stripeSecret of ['stripe_secret_key', 'stripe_webhook_secret']) {
      expect(Object.entries(merged.services)
        .filter(([, service]) => mountedSecretSources(service).includes(stripeSecret))
        .map(([name]) => name)
        .sort()).toEqual(stripeServices);
    }
    for (const name of stripeServices) {
      expect(merged.services[name]?.environment, name).toMatchObject({
        APPLICATION_MODE: 'maintenance',
        STRIPE_ENABLED: 'true',
        STRIPE_TEST_FIXTURE_MODE: 'false',
        STRIPE_LIVE_MODE: 'false',
        STRIPE_SECRET_KEY_FILE: '/run/secrets/stripe_secret_key',
        STRIPE_WEBHOOK_SECRET_FILE: '/run/secrets/stripe_webhook_secret'
      });
      expect(mountedSecretSources(merged.services[name]!)).toEqual([
        'auth_secret',
        'database_password',
        'smtp_password',
        'stripe_secret_key',
        'stripe_webhook_secret'
      ]);
    }
    for (const name of ['migrate', 'bootstrap-admin', 'storage-cleanup', 'caddy', 'postgres']) {
      expect(merged.services[name]?.environment, name).not.toHaveProperty('STRIPE_ENABLED', 'true');
      expect(merged.services[name]?.environment, name).not.toHaveProperty('STRIPE_SECRET_KEY_FILE');
      expect(merged.services[name]?.environment, name).not.toHaveProperty('STRIPE_WEBHOOK_SECRET_FILE');
      expect(mountedSecretSources(merged.services[name]!)).not.toContain('stripe_secret_key');
      expect(mountedSecretSources(merged.services[name]!)).not.toContain('stripe_webhook_secret');
    }
    for (const [name, service] of Object.entries(baseline.services)) {
      expect(
        mountedSecretSources(merged.services[name]!).filter((secret) => !secret.startsWith('stripe_')),
        name
      ).toEqual(mountedSecretSources(service));
    }
    expect(merged.secrets).toMatchObject({
      database_password: { environment: 'DATABASE_PASSWORD' },
      auth_secret: { environment: 'AUTH_SECRET' },
      smtp_password: { environment: 'SMTP_PASSWORD' },
      stripe_secret_key: { environment: 'STRIPE_SECRET_KEY' },
      stripe_webhook_secret: { environment: 'STRIPE_WEBHOOK_SECRET' }
    });
  });

  it('documents safe commerce, claim, reconciliation, and manual-checkpoint operations', async () => {
    const [runbook, readme, runtime, database, authentication, library] = await Promise.all([
      source('docs/commerce-and-guest-claims.md'),
      source('README.md'),
      source('docs/runtime-environments.md'),
      source('docs/database-and-workers.md'),
      source('docs/authentication-and-email.md'),
      source('docs/customer-library-and-reader.md')
    ]);
    for (const expected of [
      '2026-07-29.dahlia',
      'Tax calculated at checkout',
      'Mailpit',
      'Stripe Dashboard',
      'partial multi-title',
      'Plan 6B',
      'APPLICATION_MODE=maintenance',
      'Never paste Stripe credentials into chat'
    ]) expect(runbook).toContain(expected);
    expect(runbook).toMatch(/STRIPE_CHECKOUT_DURATION_SECONDS=1800/u);
    expect(runbook).toMatch(/STRIPE_WEBHOOK_TOLERANCE_SECONDS=300/u);
    expect(runbook).toMatch(/STRIPE_TEST_FIXTURE_MODE=false/u);
    expect(readme).toContain('docs/commerce-and-guest-claims.md');
    expect(readme).not.toContain('Checkout is not live in Plan 5');
    expect(runtime).toContain('compose.stripe.yaml');
    expect(runtime).toContain('does not verify that environment-backed secret values are present');
    expect(runbook).toContain('does not verify that environment-backed secret values are present');
    expect(database).toContain('stripe_events');
    expect(authentication).toContain('guest purchase');
    expect(library).toContain('entitlement_grants');
  });

  it('keeps example credentials empty and non-secret', async () => {
    const example = await source('.env.example');
    expect(example).toMatch(/^STRIPE_SECRET_KEY=\s*$/mu);
    expect(example).toMatch(/^STRIPE_WEBHOOK_SECRET=\s*$/mu);
    expect(example).not.toMatch(/^STRIPE_SECRET_KEY=sk_(?:test|live)_[^\s]+/mu);
    expect(example).not.toMatch(/^STRIPE_WEBHOOK_SECRET=whsec_[^\s]+/mu);
  });
});
