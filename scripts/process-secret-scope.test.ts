import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

function serviceBlock(compose: string, name: string): string {
  const match = new RegExp(
    `^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|^secrets:|^networks:|^volumes:)`,
    'mu'
  ).exec(compose);
  if (!match) throw new Error(`Missing Compose service ${name}`);
  return match[0];
}

describe('process secret scope', () => {
  it('uses a role-specific loader at every application entrypoint', () => {
    expect(source('src/lib/server/config/index.ts')).toContain(
      'cachedConfiguration ??= loadWebApplicationConfig(env)'
    );
    expect(source('src/worker.ts')).toContain(
      'loadWorkerApplicationConfig(databaseEnvironmentForRole(process.env, \'worker\'))'
    );
    expect(source('src/migrate.ts')).toContain(
      "loadDatabaseConfig(databaseEnvironmentForRole(process.env, 'owner'))"
    );
    expect(source('src/cleanup-storage.ts')).toContain(
      "loadStorageMaintenanceConfig(databaseEnvironmentForRole(process.env, 'storage-cleanup'))"
    );
    expect(source('src/bootstrap-admin.ts')).toContain('loadDatabaseConfig(process.env)');
  });

  it('uses the API-only Stripe runtime in the production-shaped worker', () => {
    const worker = source('src/worker.ts');
    const runtime = source('src/lib/server/commerce/stripe/runtime-core.ts');

    expect(worker).toContain('createStripeWorkerRuntime(config)');
    expect(worker).not.toContain('createStripeCommerceRuntime(config)');
    const workerFactory = runtime.slice(runtime.indexOf('export function createStripeWorkerRuntime'));
    expect(workerFactory).toContain('createStripeSdkWorkerGateway');
    expect(workerFactory).not.toContain('webhookSecret');
  });

  it('mounts SMTP credentials only into the production worker', () => {
    const compose = source('compose.prod.yaml');
    const app = serviceBlock(compose, 'app');
    const worker = serviceBlock(compose, 'worker');
    const migrate = serviceBlock(compose, 'migrate');
    const bootstrap = serviceBlock(compose, 'bootstrap-admin');

    for (const block of [app, migrate, bootstrap]) {
      expect(block).not.toContain('SMTP_USER:');
      expect(block).not.toContain('SMTP_USER_FILE:');
      expect(block).not.toContain('SMTP_PASSWORD:');
      expect(block).not.toContain('SMTP_PASSWORD_FILE:');
      expect(block).not.toMatch(/^\s+- smtp_password\s*$/mu);
    }
    expect(worker).toContain('SMTP_USER:');
    expect(worker).toContain('SMTP_PASSWORD_FILE: /run/secrets/smtp_password');
    expect(worker).toMatch(/^\s+- smtp_password\s*$/mu);
  });

  it('gives migration only database settings and bootstrap only database plus bootstrap input', () => {
    const compose = source('compose.prod.yaml');
    const migrate = serviceBlock(compose, 'migrate');
    const bootstrap = serviceBlock(compose, 'bootstrap-admin');
    const unrelatedPrefixes = [
      'AUTH_',
      'SMTP_',
      'STRIPE_',
      'STORAGE_',
      'UPLOAD_',
      'INGEST_',
      'JOB_',
      'COMMERCE_',
      'ORIGIN:'
    ];

    for (const prefix of unrelatedPrefixes) {
      expect(migrate, prefix).not.toContain(prefix);
      expect(bootstrap, prefix).not.toContain(prefix);
    }
    expect(bootstrap).toContain('BOOTSTRAP_ADMIN_EMAIL:');
    expect(bootstrap).toContain('BOOTSTRAP_ADMIN_NAME:');
    expect(bootstrap).toContain('BOOTSTRAP_ADMIN_PASSWORD_FILE:');
    expect(migrate).not.toContain('BOOTSTRAP_ADMIN_');
  });

  it('mounts the Stripe webhook verification secret only into the web process', () => {
    const overlay = source('compose.stripe.yaml');
    const app = serviceBlock(overlay, 'app');
    const worker = serviceBlock(overlay, 'worker');

    expect(app).toContain('STRIPE_SECRET_KEY_FILE: /run/secrets/stripe_secret_key');
    expect(app).toContain('STRIPE_WEBHOOK_SECRET_FILE: /run/secrets/stripe_webhook_secret');
    expect(app).toMatch(/^\s+- stripe_webhook_secret\s*$/mu);
    expect(worker).toContain('STRIPE_SECRET_KEY_FILE: /run/secrets/stripe_secret_key');
    expect(worker).not.toContain('STRIPE_WEBHOOK_SECRET');
    expect(worker).not.toMatch(/^\s+- stripe_webhook_secret\s*$/mu);
  });

  it('overrides development env-file secrets that each process must not inherit', () => {
    const compose = source('compose.dev.yaml');
    const expectedEmpty = (name: string, keys: readonly string[]) => {
      const block = serviceBlock(compose, name);
      for (const key of keys) {
        expect(block, `${name}:${key}`).toMatch(new RegExp(`^      ${key}: ["']{2}$`, 'mu'));
      }
    };
    const smtpCredentials = [
      'SMTP_USER',
      'SMTP_USER_FILE',
      'SMTP_PASSWORD',
      'SMTP_PASSWORD_FILE'
    ];
    const stripeWebhook = ['STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET_FILE'];
    const stripeApi = ['STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY_FILE'];
    const auth = ['AUTH_SECRET', 'AUTH_SECRET_FILE'];
    const bootstrap = [
      'BOOTSTRAP_ADMIN_EMAIL',
      'BOOTSTRAP_ADMIN_EMAIL_FILE',
      'BOOTSTRAP_ADMIN_NAME',
      'BOOTSTRAP_ADMIN_NAME_FILE',
      'BOOTSTRAP_ADMIN_PASSWORD',
      'BOOTSTRAP_ADMIN_PASSWORD_FILE'
    ];
    const ownerDatabase = [
      'DATABASE_OWNER_USER',
      'DATABASE_OWNER_USER_FILE',
      'DATABASE_OWNER_PASSWORD',
      'DATABASE_OWNER_PASSWORD_FILE'
    ];
    const webDatabase = [
      'DATABASE_USER',
      'DATABASE_USER_FILE',
      'DATABASE_PASSWORD',
      'DATABASE_PASSWORD_FILE'
    ];
    const workerDatabase = [
      'DATABASE_WORKER_USER',
      'DATABASE_WORKER_USER_FILE',
      'DATABASE_WORKER_PASSWORD',
      'DATABASE_WORKER_PASSWORD_FILE'
    ];
    const cleanupDatabase = [
      'DATABASE_STORAGE_CLEANUP_USER',
      'DATABASE_STORAGE_CLEANUP_USER_FILE',
      'DATABASE_STORAGE_CLEANUP_PASSWORD',
      'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE'
    ];

    expectedEmpty('app', [...smtpCredentials, ...bootstrap]);
    expectedEmpty('worker', [...stripeWebhook, ...bootstrap]);
    expectedEmpty('migrate', [...auth, ...smtpCredentials, ...stripeApi, ...stripeWebhook, ...bootstrap]);
    expectedEmpty('bootstrap-admin', [...auth, ...smtpCredentials, ...stripeApi, ...stripeWebhook]);
    expectedEmpty('database-role-provision', [
      ...auth,
      ...smtpCredentials,
      ...stripeApi,
      ...stripeWebhook,
      ...bootstrap
    ]);
    expectedEmpty('storage-cleanup', [
      ...auth,
      ...smtpCredentials,
      ...stripeApi,
      ...stripeWebhook,
      ...bootstrap
    ]);
    expectedEmpty('app', [...ownerDatabase, ...workerDatabase, ...cleanupDatabase]);
    expectedEmpty('worker', [...ownerDatabase, ...webDatabase, ...cleanupDatabase]);
    expectedEmpty('migrate', [...webDatabase, ...workerDatabase, ...cleanupDatabase]);
    expectedEmpty('bootstrap-admin', [...ownerDatabase, ...workerDatabase, ...cleanupDatabase]);
    expectedEmpty('storage-cleanup', [...ownerDatabase, ...webDatabase, ...workerDatabase]);
  });
});
