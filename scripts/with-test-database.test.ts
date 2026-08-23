import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('routine database test harness role separation', () => {
  it('uses a unique owned Compose identity and verifies exact Docker ownership around cleanup', async () => {
    const source = await readFile(new URL('./with-test-database.ts', import.meta.url), 'utf8');
    const preflight = source.indexOf('assertNoComposeResourceCollision();');
    const startup = source.indexOf("runChecked('docker', [...composeArguments, 'up'");
    const ownershipCheck = source.indexOf('assertComposeResourcesOwned();');
    const teardown = source.indexOf("runChecked('docker', [...composeArguments, 'down'");
    const postTeardown = source.lastIndexOf('assertNoComposeResourceCollision();');

    expect(source).toContain("randomBytes(8).toString('hex')");
    expect(source).toContain('const project = `pale-orbit-test-${runId}`;');
    expect(source).not.toContain('`pale-orbit-test-${process.pid}`');
    expect(source).toContain("label=com.docker.compose.project=${project}");
    expect(source).toContain('composeMutationStarted = true;');
    expect(source).toContain('if (composeMutationStarted)');
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(startup);
    expect(ownershipCheck).toBeGreaterThan(startup);
    expect(ownershipCheck).toBeLessThan(teardown);
    expect(postTeardown).toBeGreaterThan(teardown);
  });

  it('puts the worker readiness marker under the unique owned temp root and rejects stale state', async () => {
    const source = await readFile(new URL('./with-test-database.ts', import.meta.url), 'utf8');

    expect(source).toContain("const workerReadyFile = join(testStorageRoot, 'worker.ready');");
    expect(source).toContain('if (existsSync(readyFile))');
    expect(source).toContain("throw new Error('Worker readiness file already exists')");
    expect(source).toContain('WORKER_READY_FILE: workerReadyFile');
    expect(source).not.toContain('`pale-orbit-worker-${process.pid}.ready`');
  });

  it('gives worker startup bounded load headroom and stops the child on readiness failure', async () => {
    const source = await readFile(new URL('./with-test-database.ts', import.meta.url), 'utf8');
    const startWorker = source.slice(
      source.indexOf('async function startWorker'),
      source.indexOf('async function stopWorker')
    );
    const readinessDeadline = startWorker.indexOf('Date.now() + 30_000');
    const cleanup = startWorker.indexOf('await stopWorker(worker);');
    const rethrow = startWorker.indexOf('throw cause;');

    expect(readinessDeadline).toBeGreaterThan(-1);
    expect(startWorker).toContain('catch (cause: unknown)');
    expect(cleanup).toBeGreaterThan(readinessDeadline);
    expect(rethrow).toBeGreaterThan(cleanup);
  });

  it('registers one worker-exit promise before signaling and reuses it after SIGKILL', async () => {
    const source = await readFile(new URL('./with-test-database.ts', import.meta.url), 'utf8');
    const stopWorker = source.slice(
      source.indexOf('async function stopWorker'),
      source.indexOf('let worker: ChildProcess')
    );
    const exitPromise = stopWorker.indexOf('const exited = new Promise<void>');
    const sigterm = stopWorker.indexOf("worker.kill('SIGTERM')");
    const sigkill = stopWorker.indexOf("worker.kill('SIGKILL')");

    expect(exitPromise).toBeGreaterThan(-1);
    expect(exitPromise).toBeLessThan(sigterm);
    expect(sigterm).toBeLessThan(sigkill);
    expect(stopWorker.match(/worker\.once\('exit'/gu)).toHaveLength(1);
    expect(stopWorker).toMatch(
      /if \(worker\.exitCode === null && worker\.signalCode === null\) \{\s*worker\.kill\('SIGKILL'\);\s*\}\s*await exited;/u
    );
    expect(stopWorker).not.toContain(
      "await new Promise<void>((resolve) => worker.once('exit', () => resolve()))"
    );
  });

  it('configures distinct disposable owner, web, worker, and storage-cleanup credentials', async () => {
    const source = await readFile(new URL('./with-test-database.ts', import.meta.url), 'utf8');

    expect(source).toContain("DATABASE_OWNER_USER: 'pale_orbit_test'");
    expect(source).toContain("DATABASE_OWNER_PASSWORD: 'pale_orbit_test_only'");
    expect(source).toContain("DATABASE_USER: 'pale_orbit_test_web'");
    expect(source).toContain("DATABASE_PASSWORD: 'pale-orbit-test-web-password-2026'");
    expect(source).toContain("DATABASE_WORKER_USER: 'pale_orbit_test_worker'");
    expect(source).toContain(
      "DATABASE_WORKER_PASSWORD: 'pale-orbit-test-worker-password-2026'"
    );
    expect(source).toContain(
      "DATABASE_STORAGE_CLEANUP_USER: 'pale_orbit_test_storage_cleanup'"
    );
    expect(source).toContain(
      "DATABASE_STORAGE_CLEANUP_PASSWORD: 'pale-orbit-test-storage-cleanup-password-2026'"
    );
    expect(source).toContain('PALE_ORBIT_TEST_PROJECT: project');
  });

  it('migrates as owner, provisions the roles, and launches web and worker separately', async () => {
    const source = await readFile(new URL('./with-test-database.ts', import.meta.url), 'utf8');
    const migration = source.indexOf(
      "runChecked('npm', ['run', 'db:migrate:raw'], ownerEnvironment)"
    );
    const provision = source.indexOf(
      "runChecked('npm', ['run', 'db:provision-roles:raw'], provisionEnvironment)"
    );

    expect(source).toContain(
      "databaseEnvironmentForRole(webEnvironment, 'owner')"
    );
    expect(source).toContain(
      "databaseEnvironmentForRole(webEnvironment, 'worker')"
    );
    expect(source).toContain('delete workerEnvironment.DATABASE_OWNER_USER;');
    expect(source).toContain('delete workerEnvironment.DATABASE_OWNER_PASSWORD;');
    expect(source).toContain('delete workerEnvironment.DATABASE_OWNER_PASSWORD_FILE;');
    expect(migration).toBeGreaterThan(-1);
    expect(provision).toBeGreaterThan(migration);
    expect(source).toContain('startWorker(workerEnvironment)');
    expect(source).toMatch(/spawnSync\(childInvocation\.command, childInvocation\.args, \{\s*env: webEnvironment,/u);
  });

  it('re-adds non-secret login attestations only to the owner migration child', async () => {
    const source = await readFile(new URL('./with-test-database.ts', import.meta.url), 'utf8');
    const ownerDeclaration = /const ownerEnvironment: NodeJS\.ProcessEnv = \{\r?\n\s*\.\.\.databaseEnvironmentForRole\(webEnvironment, 'owner'\)\r?\n\s*\};/u
      .exec(source);
    const ownerProjection = ownerDeclaration?.index ?? -1;
    const webName = source.indexOf(
      'ownerEnvironment.DATABASE_MIGRATION_WEB_USER = webEnvironment.DATABASE_USER;'
    );
    const workerName = source.indexOf(
      'ownerEnvironment.DATABASE_MIGRATION_WORKER_USER = webEnvironment.DATABASE_WORKER_USER;'
    );
    const cleanupName = source.indexOf(
      'ownerEnvironment.DATABASE_MIGRATION_STORAGE_CLEANUP_USER = webEnvironment.DATABASE_STORAGE_CLEANUP_USER;'
    );
    const migration = source.indexOf(
      "runChecked('npm', ['run', 'db:migrate:raw'], ownerEnvironment)"
    );
    const webEnvironmentLiteral = source.slice(
      source.indexOf('const webEnvironment:'),
      ownerProjection
    );
    const ownerMigrationScope = source.slice(
      ownerProjection,
      migration + "runChecked('npm', ['run', 'db:migrate:raw'], ownerEnvironment)".length
    );
    const downstream = source.slice(
      migration + "runChecked('npm', ['run', 'db:migrate:raw'], ownerEnvironment)".length
    );
    const requiredOwnerCredentialDeletions = [
      'DATABASE_WORKER_USER',
      'DATABASE_WORKER_USER_FILE',
      'DATABASE_WORKER_PASSWORD',
      'DATABASE_WORKER_PASSWORD_FILE',
      'DATABASE_STORAGE_CLEANUP_USER',
      'DATABASE_STORAGE_CLEANUP_USER_FILE',
      'DATABASE_STORAGE_CLEANUP_PASSWORD',
      'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE',
      'BOOTSTRAP_ADMIN_EMAIL',
      'BOOTSTRAP_ADMIN_EMAIL_FILE',
      'BOOTSTRAP_ADMIN_NAME',
      'BOOTSTRAP_ADMIN_NAME_FILE',
      'BOOTSTRAP_ADMIN_PASSWORD',
      'BOOTSTRAP_ADMIN_PASSWORD_FILE'
    ];

    expect(ownerProjection).toBeGreaterThan(-1);
    expect(webName).toBeGreaterThan(ownerProjection);
    expect(workerName).toBeGreaterThan(webName);
    expect(cleanupName).toBeGreaterThan(workerName);
    expect(migration).toBeGreaterThan(cleanupName);
    expect(webEnvironmentLiteral).not.toContain('DATABASE_MIGRATION_');
    expect(ownerMigrationScope.match(/DATABASE_MIGRATION_/gu)).toHaveLength(3);
    expect(ownerMigrationScope).not.toMatch(/DATABASE_MIGRATION_[A-Z_]*(?:PASSWORD|_FILE)/u);
    expect(ownerMigrationScope).not.toContain('...ownerEnvironment');
    expect(ownerMigrationScope).not.toMatch(
      /(?:provision|bootstrap|worker|web)Environment\s*=\s*ownerEnvironment/u
    );
    expect(ownerMigrationScope).not.toMatch(
      /ownerEnvironment\.[A-Z0-9_]*(?:PASSWORD|SECRET)[A-Z0-9_]*\s*=/u
    );
    for (const credential of requiredOwnerCredentialDeletions) {
      const deletion = `delete ownerEnvironment.${credential};`;
      const deletionIndex = source.indexOf(deletion);
      expect(deletionIndex, deletion).toBeGreaterThan(cleanupName);
      expect(deletionIndex, deletion).toBeLessThan(migration);
      expect(source.indexOf(deletion, migration + 1), `${deletion} after migration launch`)
        .toBe(-1);
    }
    expect(downstream).not.toContain('DATABASE_MIGRATION_');
    expect(downstream).not.toContain('ownerEnvironment');
    expect(source.match(/DATABASE_MIGRATION_/gu)).toHaveLength(3);
    expect(source).not.toContain('provisionEnvironment.DATABASE_MIGRATION_');
    expect(source).not.toContain('bootstrapEnvironment.DATABASE_MIGRATION_');
    expect(source).not.toContain('workerEnvironment.DATABASE_MIGRATION_');
  });

  it('scopes migration, provisioning, and bootstrap one-shot environments to required secrets', async () => {
    const source = await readFile(new URL('./with-test-database.ts', import.meta.url), 'utf8');
    const bootstrapNames = [
      'BOOTSTRAP_ADMIN_EMAIL',
      'BOOTSTRAP_ADMIN_EMAIL_FILE',
      'BOOTSTRAP_ADMIN_NAME',
      'BOOTSTRAP_ADMIN_NAME_FILE',
      'BOOTSTRAP_ADMIN_PASSWORD',
      'BOOTSTRAP_ADMIN_PASSWORD_FILE'
    ];
    const ownerNames = [
      'DATABASE_OWNER_USER',
      'DATABASE_OWNER_USER_FILE',
      'DATABASE_OWNER_PASSWORD',
      'DATABASE_OWNER_PASSWORD_FILE'
    ];
    const workerNames = [
      'DATABASE_WORKER_USER',
      'DATABASE_WORKER_USER_FILE',
      'DATABASE_WORKER_PASSWORD',
      'DATABASE_WORKER_PASSWORD_FILE'
    ];
    const cleanupNames = [
      'DATABASE_STORAGE_CLEANUP_USER',
      'DATABASE_STORAGE_CLEANUP_USER_FILE',
      'DATABASE_STORAGE_CLEANUP_PASSWORD',
      'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE'
    ];

    for (const name of [...workerNames, ...cleanupNames, ...bootstrapNames]) {
      expect(source).toContain(`delete ownerEnvironment.${name};`);
    }
    for (const name of bootstrapNames) {
      expect(source).toContain(`delete provisionEnvironment.${name};`);
    }
    for (const name of [...ownerNames, ...workerNames, ...cleanupNames]) {
      expect(source).toContain(`delete bootstrapEnvironment.${name};`);
    }
    expect(source).toContain("runChecked('npm', ['run', 'db:migrate:raw'], ownerEnvironment)");
    expect(source).toContain(
      "runChecked('npm', ['run', 'db:provision-roles:raw'], provisionEnvironment)"
    );
    expect(source).toContain(
      "runChecked('npm', ['run', 'admin:bootstrap:raw'], bootstrapEnvironment)"
    );
  });

  it('keeps only worker-specific database credentials in the long-lived worker environment', async () => {
    const source = await readFile(new URL('./with-test-database.ts', import.meta.url), 'utf8');

    for (const name of [
      'DATABASE_USER',
      'DATABASE_USER_FILE',
      'DATABASE_PASSWORD',
      'DATABASE_PASSWORD_FILE',
      'DATABASE_OWNER_USER',
      'DATABASE_OWNER_USER_FILE',
      'DATABASE_OWNER_PASSWORD',
      'DATABASE_OWNER_PASSWORD_FILE',
      'DATABASE_STORAGE_CLEANUP_USER',
      'DATABASE_STORAGE_CLEANUP_USER_FILE',
      'DATABASE_STORAGE_CLEANUP_PASSWORD',
      'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE',
      'BOOTSTRAP_ADMIN_EMAIL',
      'BOOTSTRAP_ADMIN_EMAIL_FILE',
      'BOOTSTRAP_ADMIN_NAME',
      'BOOTSTRAP_ADMIN_NAME_FILE',
      'BOOTSTRAP_ADMIN_PASSWORD',
      'BOOTSTRAP_ADMIN_PASSWORD_FILE'
    ]) {
      expect(source).toContain(`delete workerEnvironment.${name};`);
    }
    expect(source).not.toContain('delete workerEnvironment.DATABASE_WORKER_USER;');
    expect(source).not.toContain('delete workerEnvironment.DATABASE_WORKER_PASSWORD;');
  });

  it('uses the owner only for fixture cleanup and closes every role client', async () => {
    const databaseSource = await readFile(
      new URL('../tests/integration/database.ts', import.meta.url),
      'utf8'
    );
    const source = await readFile(
      new URL('../tests/integration/setup.ts', import.meta.url),
      'utf8'
    );

    expect(databaseSource).toContain("databaseEnvironmentForRole(process.env, 'owner')");
    expect(databaseSource).toContain("databaseEnvironmentForRole(process.env, 'worker')");
    expect(databaseSource).toContain(
      "databaseEnvironmentForRole(process.env, 'storage-cleanup')"
    );
    expect(databaseSource).toContain('export const ownerDatabaseClient');
    expect(databaseSource).toContain('export const workerDatabaseClient');
    expect(databaseSource).toContain('export const storageCleanupDatabaseClient');
    expect(databaseSource).toContain('loadDatabaseConfig(');
    expect(databaseSource).toContain('assertIsolatedTestDatabaseEnvironment(process.env)');
    expect(source).toContain('ownerDatabaseClient.db.execute');
    expect(source).toContain('ownerDatabaseClient.close()');
    expect(source).toContain('workerDatabaseClient.close()');
    expect(source).toContain('storageCleanupDatabaseClient.close()');
  });

  it('keeps E2E request setup on web authority and background work on worker authority', async () => {
    const databaseSource = await readFile(
      new URL('../tests/e2e/database.ts', import.meta.url),
      'utf8'
    );
    const playwrightConfigSource = await readFile(
      new URL('../playwright.config.ts', import.meta.url),
      'utf8'
    );
    const commerceHarnessSource = await readFile(
      new URL('../tests/e2e/commerce-harness.ts', import.meta.url),
      'utf8'
    );

    expect(databaseSource).toMatch(
      /databaseEnvironmentForRole\(\s*process\.env,\s*['"]worker['"]\s*\)/u
    );
    expect(playwrightConfigSource).toContain(
      'assertIsolatedTestDatabaseEnvironment(process.env)'
    );
    expect(databaseSource).toContain('assertIsolatedTestDatabaseEnvironment(process.env)');
    expect(databaseSource).toContain('readonly workerDb: Database');
    expect(databaseSource).toContain('workerDatabase.transaction((transaction) =>');
    expect(databaseSource).toContain('const results = await Promise.allSettled(');
    expect(databaseSource).toMatch(
      /await closeClients\(\s*\[ownerFixtureClient,\s*workerClient,\s*client\],/u
    );
    expect(commerceHarnessSource).toContain(
      'createStripeEventHandler(database.workerDb, fixture.gateway'
    );
    expect(commerceHarnessSource).toContain(
      'acceptStripeEvent(database.db, verified'
    );
  });

  it('runs storage cleanup through the dedicated database client', async () => {
    const source = await readFile(
      new URL('../tests/integration/storage-cleanup.test.ts', import.meta.url),
      'utf8'
    );

    expect(source).toContain('storageCleanupDatabaseClient');
    expect(source).toContain('database: storageCleanupDatabaseClient.db');
  });
});
