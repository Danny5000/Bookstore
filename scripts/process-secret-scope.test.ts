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

function environmentKeys(block: string): string[] {
  const match = /^ {4}environment:\r?\n([\s\S]*?)(?=^ {4}[a-z][a-z0-9_-]*:|^ {2}[a-z])/mu
    .exec(block);
  if (!match) throw new Error('Missing Compose environment block');
  return [...match[1]!.matchAll(/^ {6}([A-Za-z0-9_]+):/gmu)].map((entry) => entry[1]!);
}

function secretNames(block: string): string[] {
  const match = /^ {4}secrets:\r?\n([\s\S]*?)(?=^ {4}[a-z][a-z0-9_-]*:|^ {2}[a-z])/mu
    .exec(block);
  if (!match) return [];
  return [...match[1]!.matchAll(/^ {6}- ([A-Za-z0-9_-]+)\s*$/gmu)]
    .map((entry) => entry[1]!);
}

describe('process secret scope', () => {
  it('uses a role-specific loader at every application entrypoint', () => {
    expect(source('src/lib/server/config/index.ts')).toContain(
      'cachedConfiguration ??= loadWebApplicationConfig(env)'
    );
    expect(source('src/worker.ts')).toContain(
      'loadWorkerApplicationConfig(databaseEnvironmentForRole(process.env, \'worker\'))'
    );
    const migrationEntrypoint = source('src/migrate.ts');
    expect(migrationEntrypoint).toContain(
      'loadDatabaseMigrationIdentityConfig(process.env)'
    );
    expect(migrationEntrypoint).toContain(
      "loadDatabaseConfig(databaseEnvironmentForRole(process.env, 'owner'))"
    );
    expect(migrationEntrypoint).toContain(
      'await migrateDatabase(databaseClient.db, migrationIdentities)'
    );
    expect(migrationEntrypoint.match(/console\.(?:log|info|warn|error)\s*\(/gu)).toEqual([
      'console.info('
    ]);
    expect(migrationEntrypoint.match(/console\.(?:log|info|warn|error)\([^\n]+/gu)).toEqual([
      "console.info('[migration] database is current');"
    ]);
    expect(source('src/cleanup-storage.ts')).toContain(
      "loadStorageMaintenanceConfig(databaseEnvironmentForRole(process.env, 'storage-cleanup'))"
    );
    expect(source('src/bootstrap-admin.ts')).toContain('loadDatabaseConfig(process.env)');
  });

  it('rejects inherited PGOPTIONS and validates identities before opening a migration connection', () => {
    const migrationEntrypoint = source('src/migrate.ts');
    const pgOptionsGuard = migrationEntrypoint.indexOf('process.env.PGOPTIONS');
    const identityLoad = migrationEntrypoint.indexOf(
      'loadDatabaseMigrationIdentityConfig(process.env)'
    );
    const ownerProjection = migrationEntrypoint.indexOf(
      "databaseEnvironmentForRole(process.env, 'owner')"
    );
    const connection = migrationEntrypoint.indexOf('createDatabaseClient(');

    expect(pgOptionsGuard).toBeGreaterThan(-1);
    expect(migrationEntrypoint).toMatch(
      /process\.env\.PGOPTIONS\s*!==\s*undefined[\s\S]*process\.env\.PGOPTIONS\.length\s*>\s*0[\s\S]*throw new Error\([^)]*PGOPTIONS/iu
    );
    expect(migrationEntrypoint).not.toMatch(/PGOPTIONS[^\n]*trim\(\)/iu);
    expect(pgOptionsGuard).toBeLessThan(identityLoad);
    expect(identityLoad).toBeLessThan(ownerProjection);
    expect(ownerProjection).toBeLessThan(connection);
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
    const migrateEnvironmentKeys = environmentKeys(migrate);
    const bootstrapEnvironmentKeys = environmentKeys(bootstrap);

    for (const prefix of unrelatedPrefixes) {
      const normalizedPrefix = prefix.replace(/:$/u, '');
      expect(migrateEnvironmentKeys.some((key) => key.startsWith(normalizedPrefix)), prefix)
        .toBe(false);
      expect(bootstrapEnvironmentKeys.some((key) => key.startsWith(normalizedPrefix)), prefix)
        .toBe(false);
    }
    expect(bootstrap).toContain('BOOTSTRAP_ADMIN_EMAIL:');
    expect(bootstrap).toContain('BOOTSTRAP_ADMIN_NAME:');
    expect(bootstrap).toContain('BOOTSTRAP_ADMIN_PASSWORD_FILE:');
    expect(migrate).not.toContain('BOOTSTRAP_ADMIN_');
  });

  it('passes only non-secret application login names to the production migration process', () => {
    const compose = source('compose.prod.yaml');
    const migrate = serviceBlock(compose, 'migrate');
    const migrationNames = [
      'DATABASE_MIGRATION_WEB_USER',
      'DATABASE_MIGRATION_WORKER_USER',
      'DATABASE_MIGRATION_STORAGE_CLEANUP_USER'
    ];

    expect(migrate).toContain(
      'DATABASE_MIGRATION_WEB_USER: ${DATABASE_USER:?DATABASE_USER must be set}'
    );
    expect(migrate).toContain(
      'DATABASE_MIGRATION_WORKER_USER: ${DATABASE_WORKER_USER:?DATABASE_WORKER_USER must be set}'
    );
    expect(migrate).toContain(
      'DATABASE_MIGRATION_STORAGE_CLEANUP_USER: ${DATABASE_STORAGE_CLEANUP_USER:?DATABASE_STORAGE_CLEANUP_USER must be set}'
    );
    expect(migrate).not.toMatch(/DATABASE_(?:WORKER_|STORAGE_CLEANUP_)?PASSWORD/iu);
    expect(migrate).not.toMatch(/database_(?:worker_|storage_cleanup_)?password/iu);
    expect(environmentKeys(migrate)).toEqual([
      'NODE_ENV',
      'DATABASE_HOST',
      'DATABASE_PORT',
      'DATABASE_NAME',
      'DATABASE_OWNER_USER',
      'DATABASE_OWNER_PASSWORD_FILE',
      'DATABASE_MIGRATION_WEB_USER',
      'DATABASE_MIGRATION_WORKER_USER',
      'DATABASE_MIGRATION_STORAGE_CLEANUP_USER',
      'DATABASE_POOL_MAX',
      'DATABASE_CONNECTION_TIMEOUT_MS',
      'DATABASE_STATEMENT_TIMEOUT_MS',
      'DATABASE_READINESS_TIMEOUT_MS'
    ]);
    expect(secretNames(migrate)).toEqual(['database_owner_password']);
    for (const forbidden of [
      'DATABASE_USER',
      'DATABASE_USER_FILE',
      'DATABASE_PASSWORD',
      'DATABASE_PASSWORD_FILE',
      'DATABASE_WORKER_USER',
      'DATABASE_WORKER_USER_FILE',
      'DATABASE_WORKER_PASSWORD',
      'DATABASE_WORKER_PASSWORD_FILE',
      'DATABASE_STORAGE_CLEANUP_USER',
      'DATABASE_STORAGE_CLEANUP_USER_FILE',
      'DATABASE_STORAGE_CLEANUP_PASSWORD',
      'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE'
    ]) expect(migrate).not.toMatch(new RegExp(`^      ${forbidden}:`, 'mu'));

    for (const service of [
      'app',
      'worker',
      'database-role-provision',
      'bootstrap-admin',
      'storage-cleanup',
      'postgres'
    ]) {
      const block = serviceBlock(compose, service);
      for (const name of migrationNames) expect(block, `${service}:${name}`).not.toContain(name);
    }
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
    const migrationNames = [
      'DATABASE_MIGRATION_WEB_USER',
      'DATABASE_MIGRATION_WORKER_USER',
      'DATABASE_MIGRATION_STORAGE_CLEANUP_USER'
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

    const migrate = serviceBlock(compose, 'migrate');
    expect(migrate).toContain('DATABASE_MIGRATION_WEB_USER: ${DATABASE_USER:?DATABASE_USER must be set}');
    expect(migrate).toContain(
      'DATABASE_MIGRATION_WORKER_USER: ${DATABASE_WORKER_USER:?DATABASE_WORKER_USER must be set}'
    );
    expect(migrate).toContain(
      'DATABASE_MIGRATION_STORAGE_CLEANUP_USER: ${DATABASE_STORAGE_CLEANUP_USER:?DATABASE_STORAGE_CLEANUP_USER must be set}'
    );
    expect(environmentKeys(migrate)).toEqual([
      'DATABASE_HOST',
      'DATABASE_MIGRATION_WEB_USER',
      'DATABASE_MIGRATION_WORKER_USER',
      'DATABASE_MIGRATION_STORAGE_CLEANUP_USER',
      'DATABASE_USER',
      'DATABASE_USER_FILE',
      'DATABASE_PASSWORD',
      'DATABASE_PASSWORD_FILE',
      'DATABASE_WORKER_USER',
      'DATABASE_WORKER_USER_FILE',
      'DATABASE_WORKER_PASSWORD',
      'DATABASE_WORKER_PASSWORD_FILE',
      'DATABASE_STORAGE_CLEANUP_USER',
      'DATABASE_STORAGE_CLEANUP_USER_FILE',
      'DATABASE_STORAGE_CLEANUP_PASSWORD',
      'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE',
      'AUTH_SECRET',
      'AUTH_SECRET_FILE',
      'SMTP_USER',
      'SMTP_USER_FILE',
      'SMTP_PASSWORD',
      'SMTP_PASSWORD_FILE',
      'STRIPE_SECRET_KEY',
      'STRIPE_SECRET_KEY_FILE',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_WEBHOOK_SECRET_FILE',
      'BOOTSTRAP_ADMIN_EMAIL',
      'BOOTSTRAP_ADMIN_EMAIL_FILE',
      'BOOTSTRAP_ADMIN_NAME',
      'BOOTSTRAP_ADMIN_NAME_FILE',
      'BOOTSTRAP_ADMIN_PASSWORD',
      'BOOTSTRAP_ADMIN_PASSWORD_FILE'
    ]);
    expect(secretNames(migrate)).toEqual([]);
    for (const service of [
      'app',
      'worker',
      'database-role-provision',
      'bootstrap-admin',
      'storage-cleanup'
    ]) {
      expectedEmpty(service, migrationNames);
    }
  });
});
