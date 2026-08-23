import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  createFixtureProbeManifest,
  createFixtureProbeCommandRuntime,
  createFixtureProbeDockerOperations,
  createFixtureProbeInternalHttpClient,
  executeFixtureRuntimeProbe,
  renderFixtureProbeOverride,
  runFixtureRuntimeProbe,
  runFixtureRuntimeProbeCli,
  validateFixtureProbeManifest,
  type FixtureProbeCommandRuntime,
  type FixtureProbeEvidence,
  type FixtureProbeManifest,
  type FixtureProbeOperations
} from './plan6b-fixture-runtime-probe';
import type { VerifiedProductionImageLease } from './plan6b-production-smoke';

function manifest(): FixtureProbeManifest {
  const runId = '1234567890abcdef';
  const tempDirectory = join(tmpdir(), `pale-orbit-plan6b-6b-ii-fixture-${runId}`);
  return {
    version: 2,
    stage: '6b-ii',
    runId,
    ownershipToken: 'e'.repeat(32),
    project: `pale-orbit-plan6b-6b-ii-fixture-${runId}`,
    imageTag: `pale-orbit:plan6b-6b-ii-fixture-${runId}`,
    tempDirectory,
    overrideFile: join(tempDirectory, 'compose.override.yaml'),
    manifestFile: join(tempDirectory, 'owned-run.json'),
    webHost: '127.0.0.1',
    webPort: 49160,
    databaseHost: '127.0.0.1',
    databasePort: 49161
  };
}

function expectedFixtureUuid(runId: string, purpose: string): string {
  const characters = createHash('sha256')
    .update(runId)
    .update('\0')
    .update(purpose)
    .digest('hex')
    .slice(0, 32)
    .split('');
  characters[12] = '4';
  characters[16] = '8';
  const value = characters.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function lease(
  overrides: Partial<VerifiedProductionImageLease> = {}
): VerifiedProductionImageLease {
  return {
    version: 2,
    stage: '6b-ii',
    sourceTag: 'pale-orbit:plan6b-6b-ii-smoke-0123456789abcdef',
    productionRunId: '0123456789abcdef',
    productionOwnershipToken: 'f'.repeat(32),
    digest: `sha256:${'a'.repeat(64)}`,
    sizeBytes: 42,
    ...overrides
  };
}

const safeEvidence = (): FixtureProbeEvidence => ({
  appEnvironment: 'test',
  workerEnvironment: 'test',
  appStripeEnabled: false,
  workerStripeEnabled: false,
  appFixtureMode: true,
  workerFixtureMode: true,
  appHasStripeSecret: false,
  workerHasStripeSecret: false,
  networkInternal: true,
  acceptedOrderCount: 1,
  checkoutSessionCount: 1,
  completedFinancialScanCount: 1,
  unsafeFinancialJobCount: 0,
  externalStripeRequestCount: 0,
  workerReady: true,
  administratorCommandSucceeded: true,
  administratorWorkerClaimObserved: true,
  administratorSalesReflectionObserved: true,
  administratorAuditReflectionObserved: true,
  webPrivateInputDenied: true,
  webDraftMutationDenied: true
});

function operations(trace: string[], failAt: string | null = null): FixtureProbeOperations {
  const step = async <Value>(name: string, value: Value): Promise<Value> => {
    trace.push(name);
    if (name === failAt) throw new Error(`private-${name}`);
    return value;
  };
  return {
    acquireImage: vi.fn(() => step('image', undefined)),
    revalidatePorts: vi.fn(() => step('ports', undefined)),
    startDependencies: vi.fn(() => step('dependencies', undefined)),
    migrate: vi.fn(() => step('migrate', undefined)),
    provisionRoles: vi.fn(() => step('provision', undefined)),
    bootstrapAdministrator: vi.fn(() => step('bootstrap', undefined)),
    seedPublishedTitles: vi.fn(() => step('seed', undefined)),
    startRuntime: vi.fn(() => step('runtime', undefined)),
    exerciseQuoteAndCheckout: vi.fn(() => step('checkout', undefined)),
    exerciseAdministratorCommand: vi.fn(() => step('administrator-command', undefined)),
    inspect: vi.fn(() => step('inspect', safeEvidence())),
    cleanup: vi.fn(() => step('cleanup', undefined))
  };
}

describe('Plan 6B fixture runtime probe ownership', () => {
  it('accepts only a version-two fixture identity bound to the exact 6b-ii stage', () => {
    const runId = manifest().runId;
    const tempDirectory = join(tmpdir(), `pale-orbit-plan6b-6b-ii-fixture-${runId}`);
    const staged = {
      ...manifest(),
      version: 2,
      stage: '6b-ii',
      project: `pale-orbit-plan6b-6b-ii-fixture-${runId}`,
      imageTag: `pale-orbit:plan6b-6b-ii-fixture-${runId}`,
      tempDirectory,
      overrideFile: join(tempDirectory, 'compose.override.yaml'),
      manifestFile: join(tempDirectory, 'owned-run.json')
    } as unknown as FixtureProbeManifest;

    expect(() => validateFixtureProbeManifest(staged)).not.toThrow();
    for (const invalid of [
      { ...manifest(), version: 1 },
      { ...staged, stage: 'plan6b-i' },
      { ...staged, stage: '6b-i' },
      { ...staged, project: `pale-orbit-plan6b-fixture-${runId}` },
      { ...staged, imageTag: `pale-orbit:plan6b-i-fixture-${runId}` }
    ]) {
      expect(() => validateFixtureProbeManifest(invalid as FixtureProbeManifest)).toThrow();
    }
  });

  it('accepts only the exact fixture project, image, paths, and distinct loopback ports', () => {
    expect(() => validateFixtureProbeManifest(manifest())).not.toThrow();
    for (const invalid of [
      { project: 'default' }, { imageTag: 'pale-orbit:latest' }, { tempDirectory: tmpdir() },
      { webHost: '0.0.0.0' }, { databaseHost: '192.0.2.1' }, { webPort: 80 },
      { databasePort: 5432 }, { databasePort: manifest().webPort }
    ]) expect(() => validateFixtureProbeManifest({ ...manifest(), ...invalid } as FixtureProbeManifest))
      .toThrow();
  });

  it('renders a no-egress fixture runtime using the same unique image for app and worker', () => {
    const source = renderFixtureProbeOverride(manifest());
    expect(source).toContain('internal: true');
    expect(source.match(/pale-orbit:plan6b-6b-ii-fixture-1234567890abcdef/gu)).toHaveLength(6);
    expect(source).toContain('com.paleorbit.plan6b-fixture.stage: 6b-ii');
    expect(source).toContain('APP_ENV: test');
    expect(source).toContain('APPLICATION_MODE: prototype');
    expect(source).toContain('STRIPE_ENABLED: "false"');
    expect(source).toContain('STRIPE_TEST_FIXTURE_MODE: "true"');
    expect(source).toContain('STRIPE_LIVE_MODE: "false"');
    expect(source).toContain('STRIPE_AUTOMATIC_TAX_ENABLED: "false"');
    expect(source).toContain('DATABASE_HOST: postgres');
    expect(source).toContain('DATABASE_OWNER_USER: pale_orbit_test');
    expect(source).toContain('DATABASE_OWNER_PASSWORD: plan6b_fixture_owner_password_0000000000');
    expect(source).toContain('DATABASE_USER: pale_orbit_fixture_web');
    expect(source).toContain('DATABASE_PASSWORD: plan6b_fixture_web_password_000000000000');
    expect(source).toContain('DATABASE_WORKER_USER: pale_orbit_fixture_worker');
    expect(source).toContain('DATABASE_WORKER_PASSWORD: plan6b_fixture_worker_password_0000000000');
    expect(source).toContain(
      'DATABASE_STORAGE_CLEANUP_USER: pale_orbit_fixture_storage_cleanup'
    );
    expect(source).toContain(
      'DATABASE_STORAGE_CLEANUP_PASSWORD: plan6b_fixture_storage_cleanup_password_000000'
    );
    expect(source).toContain('database-role-provision:');
    expect(source).toContain('command: [node, build/services/provision-database-roles.js]');
    const app = source.slice(source.indexOf('  app:'), source.indexOf('  worker:'));
    const worker = source.slice(source.indexOf('  worker:'), source.indexOf('  migrate:'));
    const migrate = source.slice(
      source.indexOf('  migrate:'),
      source.indexOf('  database-role-provision:')
    );
    const provisionIndex = source.indexOf('  database-role-provision:');
    const provision = source.slice(provisionIndex, source.indexOf('\nnetworks:', provisionIndex));
    expect(app).toContain('DATABASE_USER: pale_orbit_fixture_web');
    expect(app).toContain('DATABASE_PASSWORD: plan6b_fixture_web_password_000000000000');
    expect(app).toContain('DATABASE_OWNER_USER: ""');
    expect(app).toContain('DATABASE_WORKER_USER: ""');
    expect(app).toContain('DATABASE_STORAGE_CLEANUP_USER: ""');
    expect(app).toContain('DATABASE_STORAGE_CLEANUP_PASSWORD: ""');
    expect(worker).toContain('DATABASE_WORKER_USER: pale_orbit_fixture_worker');
    expect(worker).toContain('DATABASE_WORKER_PASSWORD: plan6b_fixture_worker_password_0000000000');
    expect(worker).toContain('DATABASE_OWNER_USER: ""');
    expect(worker).toContain('DATABASE_USER: ""');
    expect(worker).toContain('DATABASE_STORAGE_CLEANUP_USER: ""');
    expect(worker).toContain('DATABASE_STORAGE_CLEANUP_PASSWORD: ""');
    expect(migrate).toContain('DATABASE_OWNER_USER: pale_orbit_test');
    expect(migrate).toContain('DATABASE_OWNER_PASSWORD: plan6b_fixture_owner_password_0000000000');
    expect(migrate).not.toContain('DATABASE_USER:');
    expect(migrate).not.toContain('DATABASE_PASSWORD:');
    expect(migrate).not.toContain('DATABASE_WORKER_USER:');
    expect(migrate).not.toContain('DATABASE_WORKER_PASSWORD:');
    expect(migrate).not.toContain('DATABASE_STORAGE_CLEANUP_USER:');
    expect(migrate).not.toContain('DATABASE_STORAGE_CLEANUP_PASSWORD:');
    expect(provision).toContain('DATABASE_OWNER_USER: pale_orbit_test');
    expect(provision).toContain('DATABASE_USER: pale_orbit_fixture_web');
    expect(provision).toContain('DATABASE_WORKER_USER: pale_orbit_fixture_worker');
    expect(provision).toContain(
      'DATABASE_STORAGE_CLEANUP_USER: pale_orbit_fixture_storage_cleanup'
    );
    expect(provision).toContain(
      'DATABASE_STORAGE_CLEANUP_PASSWORD: plan6b_fixture_storage_cleanup_password_000000'
    );
    expect(source).toContain('AUTH_SECRET: plan6b-fixture-auth-secret-0000000000000000');
    expect(source).toContain('SMTP_HOST: mailpit');
    expect(source).toContain('SMTP_PORT: "1025"');
    expect(source).toContain('WORKER_READY_FILE: /tmp/worker-ready');
    expect(source.match(/ports: !override/gu)).toHaveLength(2);
    expect(source).toContain('127.0.0.1:49160:3000');
    expect(source).toContain('127.0.0.1:49161:5432');
    expect(source).toContain('mailpit:');
    expect(source).not.toMatch(/-\s+"?0\.0\.0\.0:/u);
    expect(source.match(/^secrets:$/gmu)).toHaveLength(1);
    expect(source).not.toContain('STRIPE_SECRET_KEY');
    expect(source).not.toContain('STRIPE_WEBHOOK_SECRET');
    const bootstrapStart = source.indexOf('  bootstrap-admin:');
    const bootstrapEnd = source.indexOf('  migrate:');
    const bootstrap = source.slice(bootstrapStart, bootstrapEnd);
    expect(bootstrapStart).toBeGreaterThan(source.indexOf('  worker:'));
    expect(bootstrap).toContain('command: [node, build/services/bootstrap-admin.js]');
    expect(bootstrap).toContain('BOOTSTRAP_ADMIN_PASSWORD_FILE: /run/secrets/bootstrap_admin_password');
    expect(bootstrap).not.toContain('BOOTSTRAP_ADMIN_PASSWORD:');
    expect(bootstrap).not.toContain('DATABASE_MIGRATION_WEB_USER');
    expect(source).toContain('bootstrap_admin_password:');
  });

  it('transports exact role names only through the migration service', () => {
    const source = renderFixtureProbeOverride(manifest());
    const migrateStart = source.indexOf('  migrate:');
    const provisionStart = source.indexOf('  database-role-provision:');
    const migrate = source.slice(migrateStart, provisionStart);
    const nonMigration = `${source.slice(0, migrateStart)}${source.slice(provisionStart)}`;
    const expected = [
      'DATABASE_MIGRATION_WEB_USER: pale_orbit_fixture_web',
      'DATABASE_MIGRATION_WORKER_USER: pale_orbit_fixture_worker',
      'DATABASE_MIGRATION_STORAGE_CLEANUP_USER: pale_orbit_fixture_storage_cleanup'
    ];

    for (const entry of expected) {
      expect(migrate).toContain(entry);
      expect(nonMigration).not.toContain(entry.split(':')[0]);
    }
    for (const applicationCredential of [
      'DATABASE_USER:',
      'DATABASE_PASSWORD:',
      'DATABASE_WORKER_USER:',
      'DATABASE_WORKER_PASSWORD:',
      'DATABASE_STORAGE_CLEANUP_USER:',
      'DATABASE_STORAGE_CLEANUP_PASSWORD:'
    ]) expect(migrate).not.toContain(applicationCredential);
  });

  it('renders an isolated least-privilege Stripe API connection canary with an owned counter', () => {
    const source = renderFixtureProbeOverride(manifest());
    const canary = source.slice(
      source.indexOf('  stripe_api_canary:'),
      source.indexOf('  app:')
    );

    expect(canary).toContain('image: pale-orbit:plan6b-6b-ii-fixture-1234567890abcdef');
    expect(canary).toContain('user: "0:0"');
    expect(canary).toContain('read_only: true');
    expect(canary).toContain('cap_drop:');
    expect(canary).toContain('- ALL');
    expect(canary).toContain('cap_add:');
    expect(canary).toContain('- NET_BIND_SERVICE');
    expect(canary).toContain('no-new-privileges:true');
    expect(canary).toContain('stripe_attempts:/var/lib/pale-orbit/stripe-attempts');
    expect(canary).toContain('- api.stripe.com');
    expect(canary).not.toContain('ports:');
    expect(source.match(/stripe_api_canary:\n {8}condition: service_healthy/gu)).toHaveLength(2);
    expect(source).toContain('stripe_attempts:\n    labels:');
  });

  it('migrates, provisions roles, seeds, exercises the actual web path, inspects the worker, and cleans up', async () => {
    const trace: string[] = [];
    await expect(executeFixtureRuntimeProbe(manifest(), lease(), operations(trace))).resolves.toEqual(
      safeEvidence()
    );
    expect(trace).toEqual([
      'image', 'ports', 'dependencies', 'migrate', 'provision', 'bootstrap', 'seed', 'runtime',
      'checkout', 'administrator-command', 'inspect', 'cleanup'
    ]);
  });

  it.each([
    'image', 'ports', 'dependencies', 'migrate', 'provision', 'bootstrap', 'seed', 'runtime',
    'checkout', 'administrator-command', 'inspect'
  ])(
    'cleans the exact fixture run when %s fails',
    async (failAt) => {
      const trace: string[] = [];
      await expect(executeFixtureRuntimeProbe(
        manifest(), lease(), operations(trace, failAt)
      )).rejects.toThrow();
      expect(trace.at(-1)).toBe('cleanup');
    }
  );

  it('does not remove a pre-existing fixture image when acquisition detects a collision', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => {
        if (args[0] === 'ps' || args[0] === 'network' || args[0] === 'volume') {
          return { status: 0, stdout: '' };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify({
              Id: `sha256:${'b'.repeat(64)}`,
              Size: 84,
              Config: { Labels: { foreign: 'true' } }
            })
          };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      })
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(executeFixtureRuntimeProbe(owned, lease(), docker)).rejects.toThrow(
        '[plan6b-fixture] fixture runtime verification failed'
      );
      expect(command.run).not.toHaveBeenCalledWith(
        ['image', 'rm', owned.imageTag],
        expect.any(Object)
      );
      expect(command.run).not.toHaveBeenCalledWith(
        ['image', 'rm', lease().sourceTag],
        expect.any(Object)
      );
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('fails closed when fixture image inspection and absence verification both fail', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => {
        if (args[0] === 'ps' || args[0] === 'network' || args[0] === 'volume') {
          return { status: 0, stdout: '' };
        }
        if (args[0] === 'image') return { status: 1, stdout: '' };
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      })
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(executeFixtureRuntimeProbe(owned, lease(), docker)).rejects.toThrow(
        '[plan6b-fixture] fixture runtime verification failed'
      );
      expect(command.capture).toHaveBeenCalledWith(
        ['image', 'ls', '--quiet', '--filter', `reference=${owned.imageTag}`],
        { PATH: 'safe-path' },
        true
      );
      expect(command.run).not.toHaveBeenCalledWith(
        ['image', 'tag', lease().sourceTag, owned.imageTag],
        expect.any(Object)
      );
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('fails closed when a created alias cannot be inspected during cleanup', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    let aliasCreated = false;
    let cleanupStarted = false;
    const leasedImage = JSON.stringify({
      Id: lease().digest,
      Size: lease().sizeBytes,
      Config: { Labels: {
        'com.paleorbit.plan6b-smoke.run': lease().productionRunId,
        'com.paleorbit.plan6b-smoke.owner': lease().productionOwnershipToken,
        'com.paleorbit.plan6b-smoke.stage': lease().stage
      } }
    });
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async (args) => {
        if (args[0] === 'image' && args[1] === 'tag') aliasCreated = true;
        if (args[0] === 'compose' && args.includes('down')) cleanupStarted = true;
      }),
      capture: vi.fn(async (args, _environment, allowFailure) => {
        if (args[0] === 'ps' || args[0] === 'network' || args[0] === 'volume') {
          return { status: 0, stdout: '' };
        }
        if (args[0] === 'image' && args[1] === 'ls') {
          return cleanupStarted
            ? { status: 1, stdout: '' }
            : { status: 0, stdout: '' };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          const target = args.at(-1);
          if (target === owned.imageTag && allowFailure && !aliasCreated) {
            return { status: 1, stdout: '' };
          }
          if (target === owned.imageTag && cleanupStarted) {
            return { status: 1, stdout: '' };
          }
          return { status: 0, stdout: leasedImage };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      })
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => {
        throw new Error('private-port-failure');
      }),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(executeFixtureRuntimeProbe(owned, lease(), docker)).rejects.toThrow(
        '[plan6b-fixture] owned cleanup failed'
      );
      expect(command.capture).toHaveBeenCalledWith(
        ['image', 'ls', '--quiet', '--filter', `reference=${owned.imageTag}`],
        { PATH: 'safe-path' },
        true
      );
      expect(command.run).not.toHaveBeenCalledWith(
        ['image', 'rm', owned.imageTag],
        expect.any(Object)
      );
      await expect(stat(owned.tempDirectory)).resolves.toBeDefined();
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('fails cleanup when the exact alias still exists after image removal reports success', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    let aliasCreated = false;
    let removalAttempted = false;
    const leasedImage = JSON.stringify({
      Id: lease().digest,
      Size: lease().sizeBytes,
      Config: { Labels: {
        'com.paleorbit.plan6b-smoke.run': lease().productionRunId,
        'com.paleorbit.plan6b-smoke.owner': lease().productionOwnershipToken,
        'com.paleorbit.plan6b-smoke.stage': lease().stage
      } }
    });
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async (args) => {
        if (args[0] === 'image' && args[1] === 'tag') aliasCreated = true;
        if (args[0] === 'image' && args[1] === 'rm') removalAttempted = true;
      }),
      capture: vi.fn(async (args, _environment, allowFailure) => {
        if (args[0] === 'ps' || args[0] === 'network' || args[0] === 'volume') {
          return { status: 0, stdout: '' };
        }
        if (args[0] === 'image' && args[1] === 'ls') {
          return { status: 0, stdout: '' };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          const target = args.at(-1);
          if (target === owned.imageTag && allowFailure && !aliasCreated) {
            return { status: 1, stdout: '' };
          }
          return { status: 0, stdout: leasedImage };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      })
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => {
        throw new Error('private-port-failure');
      }),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(executeFixtureRuntimeProbe(owned, lease(), docker)).rejects.toThrow(
        '[plan6b-fixture] owned cleanup failed'
      );
      expect(removalAttempted).toBe(true);
      const aliasInspections = vi.mocked(command.capture).mock.calls.filter(([args]) =>
        args[0] === 'image' && args[1] === 'inspect' && args.at(-1) === owned.imageTag
      );
      expect(aliasInspections).toHaveLength(4);
      await expect(stat(owned.tempDirectory)).resolves.toBeDefined();
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('rejects unsafe runtime evidence after cleanup', async () => {
    for (const unsafe of [
      { appEnvironment: 'production' }, { workerFixtureMode: false }, { appStripeEnabled: true },
      { appHasStripeSecret: true }, { networkInternal: false }, { acceptedOrderCount: 2 },
      { checkoutSessionCount: 0 }, { completedFinancialScanCount: 0 },
      { unsafeFinancialJobCount: 1 }, { externalStripeRequestCount: 1 }, { workerReady: false },
      { administratorCommandSucceeded: false },
      { administratorWorkerClaimObserved: false },
      { administratorSalesReflectionObserved: false },
      { administratorAuditReflectionObserved: false },
      { webPrivateInputDenied: false }, { webDraftMutationDenied: false }
    ]) {
      const trace: string[] = [];
      const runtime = operations(trace);
      vi.mocked(runtime.inspect).mockResolvedValue({ ...safeEvidence(), ...unsafe } as FixtureProbeEvidence);
      await expect(executeFixtureRuntimeProbe(manifest(), lease(), runtime)).rejects.toThrow(
        '[plan6b-fixture] fixture runtime verification failed'
      );
      expect(trace.at(-1)).toBe('cleanup');
    }
  });

  it('does not invoke cleanup for an unsafe unowned manifest', async () => {
    const trace: string[] = [];
    await expect(executeFixtureRuntimeProbe(
      { ...manifest(), project: '*' }, lease(), operations(trace)
    )).rejects.toThrow(/project|manifest/u);
    expect(trace).toEqual([]);
  });

  it('rejects an invalid production image lease before invoking fixture operations', async () => {
    const trace: string[] = [];
    await expect(executeFixtureRuntimeProbe(
      manifest(),
      lease({ sourceTag: 'pale-orbit:latest' }),
      operations(trace)
    )).rejects.toThrow(/lease|source/u);
    expect(trace).toEqual([]);
  });

  it('validates the leased source image and tags an exact fixture alias without building', async () => {
    const calls: Array<{
      kind: 'run' | 'capture';
      args: readonly string[];
      environment: NodeJS.ProcessEnv;
    }> = [];
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async (args, environment) => {
        calls.push({ kind: 'run', args, environment });
      }),
      capture: vi.fn(async (args, environment, allowFailure) => {
        calls.push({ kind: 'capture', args, environment });
        if (args[0] === 'image' && args[1] === 'inspect') {
          if (allowFailure && args.at(-1) === owned.imageTag) {
            return { status: 1, stdout: '' };
          }
          return {
            status: 0,
            stdout: JSON.stringify({
              Id: lease().digest,
              Size: lease().sizeBytes,
              Config: {
                Labels: {
                  'com.paleorbit.plan6b-smoke.run': lease().productionRunId,
                  'com.paleorbit.plan6b-smoke.owner': lease().productionOwnershipToken,
                  'com.paleorbit.plan6b-smoke.stage': lease().stage
                }
              }
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const owned = manifest();
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: {
        PATH: 'safe-path',
        STRIPE_SECRET_KEY: 'sk_test_private_canary',
        STRIPE_WEBHOOK_SECRET: 'whsec_private_canary'
      },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    await docker.acquireImage(owned, lease());

    expect(calls.find((call) => call.kind === 'run')?.args).toEqual([
      'image', 'tag', lease().sourceTag,
      'pale-orbit:plan6b-6b-ii-fixture-1234567890abcdef'
    ]);
    expect(JSON.stringify(calls)).not.toContain('"build"');
    expect(JSON.stringify(calls)).not.toContain('sk_test_private_canary');
    expect(JSON.stringify(calls)).not.toContain('whsec_private_canary');
    expect(calls.every((call) =>
      !Object.keys(call.environment).some((key) => key.startsWith('STRIPE_'))
    )).toBe(true);
  });

  it('refuses a fixture Docker collision before building or cleaning foreign resources', async () => {
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: 0,
        stdout: args[0] === 'network' ? `${'a'.repeat(64)}\n` : ''
      }))
    };
    const owned = manifest();
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.acquireImage(owned, lease())).rejects.toThrow(/collides/u);
    expect(command.run).not.toHaveBeenCalled();
  });

  it.each([
    ['container', (owned: ReturnType<typeof manifest>) => `${owned.project}-postgres-1`],
    ['network', (owned: ReturnType<typeof manifest>) => `${owned.project}_default`],
    ['volume', (owned: ReturnType<typeof manifest>) => `${owned.project}_stripe_attempts`]
  ] as const)('refuses a foreign exact-name %s before the first fixture mutation', async (
    resource,
    expectedName
  ) => {
    const owned = manifest();
    const name = expectedName(owned);
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: 0,
        stdout: args[0] === (resource === 'container' ? 'ps' : resource) &&
          args.includes(`name=${name}`) ? `${name}\n` : ''
      }))
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.acquireImage(owned, lease())).rejects.toThrow(/exact-name|collid/iu);
    expect(command.run).not.toHaveBeenCalled();
  });

  it('rechecks exact-name collisions immediately before fixture Compose startup', async () => {
    const owned = manifest();
    const exactVolumeName = `${owned.project}_stripe_attempts`;
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: 0,
        stdout: args[0] === 'volume' && args.includes(`name=${exactVolumeName}`)
          ? `${exactVolumeName}\n`
          : ''
      }))
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.startDependencies(owned)).rejects.toThrow(/exact-name|collid/iu);
    expect(command.run).not.toHaveBeenCalled();
  });

  it('fails closed when Docker inventory cannot be captured before building', async () => {
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async () => ({ status: 1, stdout: '' }))
    };
    const owned = manifest();
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.acquireImage(owned, lease())).rejects.toThrow(/Docker resource inventory failed/u);
    expect(command.run).not.toHaveBeenCalled();
  });

  it('rejects leased source evidence whose digest, size, or ownership does not match', async () => {
    for (const image of [
      { Id: `sha256:${'b'.repeat(64)}`, Size: 42, run: lease().productionRunId,
        owner: lease().productionOwnershipToken },
      { Id: lease().digest, Size: 43, run: lease().productionRunId,
        owner: lease().productionOwnershipToken },
      { Id: lease().digest, Size: 42, run: 'fedcba9876543210',
        owner: lease().productionOwnershipToken }
    ]) {
      const command: FixtureProbeCommandRuntime = {
        run: vi.fn(async () => undefined),
        capture: vi.fn(async (args, _environment, allowFailure) => {
          if (args[0] === 'image' && args[1] === 'inspect') {
            if (allowFailure) return { status: 1, stdout: '' };
            return {
              status: 0,
              stdout: JSON.stringify({
                Id: image.Id,
                Size: image.Size,
                Config: { Labels: {
                  'com.paleorbit.plan6b-smoke.run': image.run,
                  'com.paleorbit.plan6b-smoke.owner': image.owner,
                  'com.paleorbit.plan6b-smoke.stage': lease().stage
                } }
              })
            };
          }
          return { status: 0, stdout: '' };
        })
      };
      const owned = manifest();
      const docker = createFixtureProbeDockerOperations(owned, {
        command,
        environment: { PATH: 'safe-path' },
        assertPortAvailable: vi.fn(async () => undefined),
        postJson: vi.fn(),
        wait: vi.fn(async () => undefined)
      });

      await expect(docker.acquireImage(owned, lease())).rejects.toThrow(/image|lease/u);
      expect(command.run).not.toHaveBeenCalled();
    }
  });

  it('rejects a fixture alias whose image ID does not match the validated source', async () => {
    let imageInspection = 0;
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args, _environment, allowFailure) => {
        if (args[0] === 'image' && args[1] === 'inspect') {
          if (allowFailure) return { status: 1, stdout: '' };
          imageInspection += 1;
          return {
            status: 0,
            stdout: JSON.stringify({
              Id: imageInspection === 1 ? lease().digest : `sha256:${'b'.repeat(64)}`,
              Size: lease().sizeBytes,
              Config: { Labels: {
                'com.paleorbit.plan6b-smoke.run': lease().productionRunId,
                'com.paleorbit.plan6b-smoke.owner': lease().productionOwnershipToken,
                'com.paleorbit.plan6b-smoke.stage': lease().stage
              } }
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const owned = manifest();
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.acquireImage(owned, lease())).rejects.toThrow(/alias|lease/u);
    expect(command.run).toHaveBeenCalledExactlyOnceWith(
      ['image', 'tag', lease().sourceTag, owned.imageTag],
      expect.any(Object)
    );
  });

  it('refuses to remove a created alias that no longer matches the production lease', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    let aliasCreated = false;
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const image = (id: string) => JSON.stringify({
      Id: id,
      Size: lease().sizeBytes,
      Config: { Labels: {
        'com.paleorbit.plan6b-smoke.run': lease().productionRunId,
        'com.paleorbit.plan6b-smoke.owner': lease().productionOwnershipToken,
        'com.paleorbit.plan6b-smoke.stage': lease().stage
      } }
    });
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async (args) => {
        mutableCalls.push([...args]);
        if (args[0] === 'image' && args[1] === 'tag') aliasCreated = true;
        if (args[0] === 'image' && args[1] === 'rm') aliasCreated = false;
      }),
      capture: vi.fn(async (args, _environment, allowFailure) => {
        if (args[0] === 'image' && args[1] === 'inspect') {
          const target = args.at(-1);
          if (allowFailure && target === owned.imageTag && !aliasCreated) {
            return { status: 1, stdout: '' };
          }
          return {
            status: 0,
            stdout: image(target === lease().sourceTag
              ? lease().digest
              : `sha256:${'b'.repeat(64)}`)
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(executeFixtureRuntimeProbe(owned, lease(), docker)).rejects.toThrow(
        '[plan6b-fixture] owned cleanup failed'
      );
      expect(calls).not.toContainEqual(['image', 'rm', owned.imageTag]);
      expect(calls).not.toContainEqual(['image', 'rm', lease().sourceTag]);
      expect(aliasCreated).toBe(true);
      await expect(stat(owned.tempDirectory)).resolves.toBeDefined();
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('cleans an alias materialized before the tag command reports failure', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    let aliasCreated = false;
    const calls: string[][] = [];
    const image = JSON.stringify({
      Id: lease().digest,
      Size: lease().sizeBytes,
      Config: { Labels: {
        'com.paleorbit.plan6b-smoke.run': lease().productionRunId,
        'com.paleorbit.plan6b-smoke.owner': lease().productionOwnershipToken,
        'com.paleorbit.plan6b-smoke.stage': lease().stage
      } }
    });
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async (args) => {
        calls.push([...args]);
        if (args[0] === 'image' && args[1] === 'tag') {
          aliasCreated = true;
          throw new Error('simulated CLI disconnect after Docker materialized the alias');
        }
        if (args[0] === 'image' && args[1] === 'rm') aliasCreated = false;
      }),
      capture: vi.fn(async (args, _environment, allowFailure) => {
        if (args[0] === 'image' && args[1] === 'ls') {
          return { status: 0, stdout: aliasCreated ? `${lease().digest}\n` : '' };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          if (allowFailure && args.at(-1) === owned.imageTag && !aliasCreated) {
            return { status: 1, stdout: '' };
          }
          return { status: 0, stdout: image };
        }
        return { status: 0, stdout: '' };
      })
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(executeFixtureRuntimeProbe(owned, lease(), docker)).rejects.toThrow(
        '[plan6b-fixture] fixture runtime verification failed'
      );
      expect(calls).toContainEqual(['image', 'rm', owned.imageTag]);
      expect(calls).not.toContainEqual(['image', 'rm', lease().sourceTag]);
      expect(aliasCreated).toBe(false);
      await expect(stat(owned.tempDirectory)).rejects.toThrow();
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('materializes unique random owned manifests and overrides in exact temp directories', async () => {
    const first = await createFixtureProbeManifest('6b-ii');
    const second = await createFixtureProbeManifest('6b-ii');
    try {
      validateFixtureProbeManifest(first);
      validateFixtureProbeManifest(second);
      expect(first.runId).not.toBe(second.runId);
      expect(first.ownershipToken).not.toBe(second.ownershipToken);
      expect(first.project).not.toBe(second.project);
      expect(first.imageTag).not.toBe(second.imageTag);
      expect(first.webPort).not.toBe(first.databasePort);
      expect(JSON.parse(await readFile(first.manifestFile, 'utf8'))).toEqual(first);
      expect(await readFile(first.overrideFile, 'utf8')).toBe(renderFixtureProbeOverride(first));
      const firstPassword = await readFile(
        join(first.tempDirectory, 'bootstrap-admin-password'),
        'utf8'
      );
      const secondPassword = await readFile(
        join(second.tempDirectory, 'bootstrap-admin-password'),
        'utf8'
      );
      expect(/^P6b![A-Za-z0-9_-]{43}Aa1$/u.test(firstPassword)).toBe(true);
      expect(firstPassword === secondPassword).toBe(false);
      expect(firstPassword === first.ownershipToken).toBe(false);
      expect(firstPassword.includes(first.ownershipToken)).toBe(false);
      expect((await readFile(first.overrideFile, 'utf8')).includes(firstPassword)).toBe(false);
      expect((await readFile(first.manifestFile, 'utf8')).includes(firstPassword)).toBe(false);
      const source = await readFile(
        new URL('./plan6b-fixture-runtime-probe.ts', import.meta.url),
        'utf8'
      );
      const credentialCreation = source.slice(
        source.indexOf('const administratorPassword ='),
        source.indexOf('writeFile(manifest.overrideFile')
      );
      expect(credentialCreation).toContain('randomBytes(32)');
      expect(credentialCreation).toContain('mode: 0o600');
      expect(credentialCreation).not.toContain('ownershipToken');
    } finally {
      await Promise.all([
        rm(first.tempDirectory, { recursive: true, force: false }),
        rm(second.tempDirectory, { recursive: true, force: false })
      ]);
    }
  });

  it('uses compose.test, seeds two published titles and a customer, then exercises quote and checkout', async () => {
    const calls: Array<{ args: readonly string[]; environment: NodeJS.ProcessEnv }> = [];
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async (args, environment) => {
        calls.push({ args, environment });
      }),
      capture: vi.fn(async () => ({ status: 0, stdout: '' }))
    };
    const postJson = vi.fn(async (
      url: string,
      input: {
        origin: string;
        requestId: string;
        body: Readonly<Record<string, unknown>>;
      }
    ) => {
      const titleIds = input.body.titleIds as string[];
      if (url.endsWith('/quote')) {
        return {
          status: 200,
          body: {
            fingerprint: 'a'.repeat(64),
            currency: 'USD',
            subtotalMinor: 3000,
            items: titleIds.map((titleId, index) => ({
              titleId,
              slug: `plan6b-fixture-${index + 1}`,
              title: `Plan 6B Fixture ${index + 1 === 1 ? 'One' : 'Two'}`,
              creatorName: 'Plan 6B Fixture Author',
              format: 'prose',
              coverUrl: null,
              unitSubtotalMinor: index === 0 ? 1200 : 1800,
              currency: 'USD'
            })),
            alreadyOwnedTitleIds: [],
            claimableTitleIds: [],
            reservedTitleIds: [],
            unavailableTitleIds: [],
            taxNotice: 'calculated_at_checkout',
            canCheckout: true
          }
        };
      }
      return {
        status: 200,
        body: {
          status: 'redirect',
          checkoutUrl: 'https://checkout.stripe.test/session/aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa'
        }
      };
    });
    const assertPortAvailable = vi.fn(async () => undefined);
    const owned = manifest();
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable,
      postJson,
      wait: vi.fn(async () => undefined)
    });

    await docker.revalidatePorts(owned);
    await docker.startDependencies(owned);
    await docker.migrate(owned);
    await docker.provisionRoles(owned);
    await docker.seedPublishedTitles(owned);
    await docker.startRuntime(owned);
    await docker.exerciseQuoteAndCheckout(owned);

    expect(assertPortAvailable.mock.calls).toEqual([
      ['127.0.0.1', 49160],
      ['127.0.0.1', 49161]
    ]);
    const compose = [
      'compose', '--project-name', owned.project,
      '--file', resolve('compose.test.yaml'), '--file', owned.overrideFile
    ];
    expect(calls[0]?.args).toEqual([
      ...compose, 'up', '--detach', '--wait', '--wait-timeout', '120',
      'postgres', 'mailpit', 'stripe_api_canary'
    ]);
    expect(calls[1]?.args).toEqual([
      ...compose, '--profile', 'tools', 'run', '--rm', 'migrate'
    ]);
    expect(calls[2]?.args).toEqual([
      ...compose, '--profile', 'tools', 'run', '--rm', 'database-role-provision'
    ]);
    expect(calls[3]?.args.slice(0, compose.length + 7)).toEqual([
      ...compose, 'exec', '-T', 'postgres', 'psql', '--username', 'pale_orbit_test',
      '--dbname'
    ]);
    expect(calls[3]?.args.at(-1)).toContain('insert into titles');
    expect(calls[3]?.args.at(-1)).toContain('insert into "user"');
    expect(calls[3]?.args.at(-1)).toContain('insert into user_roles');
    expect(calls[4]?.args).toEqual([
      ...compose, 'up', '--detach', '--wait', '--wait-timeout', '120', 'app', 'worker'
    ]);
    expect(postJson).toHaveBeenCalledTimes(2);
    expect(postJson.mock.calls[0]?.[0]).toBe('http://127.0.0.1:49160/api/commerce/quote');
    expect(postJson.mock.calls[1]?.[0]).toBe('http://127.0.0.1:49160/api/commerce/checkout');
    expect(postJson.mock.calls[1]?.[1].body).toMatchObject({
      quoteFingerprint: 'a'.repeat(64),
      titleIds: postJson.mock.calls[0]?.[1].body.titleIds
    });
  });

  it('submits and safely polls one private refund draft command through the real web boundary', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const runCalls: readonly string[][] = [];
    const mutableRunCalls = runCalls as string[][];
    let statusReads = 0;
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async (args) => {
        mutableRunCalls.push([...args]);
      }),
      capture: vi.fn(async (args) => {
        if (args.includes('psql')) {
          const query = String(args.at(-1));
          if (query.includes("root_key = 'commerce.financial-scan:initial:v1'")) {
            return { status: 0, stdout: JSON.stringify({ completedFinancialScanCount: 1 }) };
          }
          if (query.includes("'administratorCommandCount'")) {
            return {
              status: 0,
              stdout: JSON.stringify({ administratorCommandCount: 1, commandId })
            };
          }
        }
        if (args.at(-1) === 'submit') {
          return { status: 0, stdout: JSON.stringify({ submitted: true }) };
        }
        if (args.at(-1) === 'status') {
          statusReads += 1;
          return {
            status: 0,
            stdout: JSON.stringify({
              status: statusReads === 1 ? 'pending' : 'succeeded',
              resultCode: statusReads === 1 ? null : 'draft_saved'
            })
          };
        }
        if (args.at(-1) === 'sales') {
          return { status: 0, stdout: JSON.stringify({ sales: true, detail: true }) };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      })
    };
    const wait = vi.fn(async () => undefined);
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait
    });

    try {
      await docker.bootstrapAdministrator(owned);
      await docker.exerciseAdministratorCommand(owned);

      const compose = [
        'compose', '--project-name', owned.project,
        '--file', resolve('compose.test.yaml'), '--file', owned.overrideFile
      ];
      expect(mutableRunCalls[0]).toEqual([
        ...compose, '--profile', 'tools', 'run', '--rm', 'bootstrap-admin'
      ]);
      const sql = mutableRunCalls
        .filter((args) => args.includes('psql'))
        .map((args) => String(args.at(-1)));
      expect(sql.some((query) => query.includes('insert into refunds'))).toBe(true);
      const boundary = sql.find((query) => query.includes('web-private-input-boundary-failed'));
      expect(boundary).toContain('set local role pale_orbit_fixture_web');
      expect(boundary).toContain('perform private_input from financial_admin_commands');
      expect(boundary).toContain('update refund_allocation_drafts set version = version where false');

      const webCalls = vi.mocked(command.capture).mock.calls.filter(([args]) =>
        args.includes('app') && args.includes('node')
      );
      expect(webCalls.map(([args]) => args.at(-1))).toEqual([
        'submit', 'status', 'status', 'sales'
      ]);
      const clientSource = String(webCalls[0]?.[0].at(-2));
      expect(() => new Script(clientSource)).not.toThrow();
      expect(clientSource).toContain("const internalOrigin='http://127.0.0.1:3000'");
      expect(clientSource).not.toContain('fetch(input.origin');
      expect(clientSource).toContain("'x-sveltekit-action':'true'");
      expect(webCalls.every(([args]) => args.at(-2) === clientSource)).toBe(true);
      const submissionInput = JSON.parse(String(webCalls[0]?.[3])) as Record<string, unknown>;
      const administratorPassword = await readFile(
        join(owned.tempDirectory, 'bootstrap-admin-password'),
        'utf8'
      );
      expect(submissionInput).toMatchObject({
        expectedVersion: null,
        items: [
          { totalPresentmentMinor: 600 },
          { totalPresentmentMinor: 400 }
        ]
      });
      expect(submissionInput.password === administratorPassword).toBe(true);
      expect(administratorPassword.includes(owned.ownershipToken)).toBe(false);
      expect(renderFixtureProbeOverride(owned).includes(administratorPassword)).toBe(false);
      const privateValues = [
        submissionInput.email,
        submissionInput.password,
        submissionInput.refundId,
        submissionInput.idempotencyKey,
        ...(submissionInput.items as Array<Record<string, unknown>>)
          .map((item) => item.orderItemId)
      ];
      const commandArguments = JSON.stringify(webCalls.map(([args]) => args));
      expect(commandArguments.includes(`127.0.0.1:${owned.webPort}`)).toBe(false);
      for (const privateValue of privateValues) {
        expect(typeof privateValue).toBe('string');
        expect(commandArguments.includes(String(privateValue))).toBe(false);
      }
      expect(wait).toHaveBeenCalledWith(500);
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('bounds private Docker standard input and forwards it only through spawn input', async () => {
    const source = await readFile(
      new URL('./plan6b-fixture-runtime-probe.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain('input: standardInput');
    expect(source).not.toContain('argumentsToCapture.push(standardInput)');

    const runtime = createFixtureProbeCommandRuntime();
    await expect(runtime.capture(
      [],
      { PATH: 'safe-path' },
      false,
      'x'.repeat((16 * 1024) + 1)
    )).rejects.toThrow('[plan6b-fixture] Docker standard input is invalid');
  });

  it('executes fixture HTTP requests inside the isolated app container', async () => {
    const owned = manifest();
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async () => ({
        status: 0,
        stdout: JSON.stringify({ status: 200, body: { ok: true } })
      }))
    };
    const postJson = createFixtureProbeInternalHttpClient(
      owned,
      command,
      { PATH: 'safe-path' }
    );
    const body = { titleIds: ['00000000-0000-4000-8000-000000000001'] };

    await expect(postJson('http://127.0.0.1:49160/api/commerce/quote', {
      origin: 'http://127.0.0.1:49160',
      requestId: 'fixture-request',
      body
    })).resolves.toEqual({ status: 200, body: { ok: true } });

    expect(command.capture).toHaveBeenCalledOnce();
    expect(vi.mocked(command.capture).mock.calls[0]?.[0]).toEqual([
      'compose', '--project-name', owned.project,
      '--file', resolve('compose.test.yaml'), '--file', owned.overrideFile,
      'exec', '-T', 'app', 'node', '-e', expect.any(String),
      '/api/commerce/quote', 'http://127.0.0.1:49160', 'fixture-request',
      Buffer.from(JSON.stringify(body)).toString('base64url')
    ]);
    await expect(postJson('https://foreign.invalid/api/commerce/quote', {
      origin: 'https://foreign.invalid', requestId: 'fixture-request', body: {}
    })).rejects.toThrow('[plan6b-fixture] fixture HTTP request is invalid');
    expect(command.capture).toHaveBeenCalledOnce();
  });

  it('boundedly waits for the ready worker and completed empty fixture financial scan', async () => {
    let databaseSnapshots = 0;
    let mismatchWorkerImage = false;
    const databaseQueries: string[] = [];
    const owned = manifest();
    const labels = {
      'com.docker.compose.project': owned.project,
      'com.paleorbit.plan6b-fixture.run': owned.runId,
      'com.paleorbit.plan6b-fixture.owner': owned.ownershipToken,
      'com.paleorbit.plan6b-fixture.stage': owned.stage
    };
    const environment = JSON.stringify([
      'APP_ENV=test',
      'APPLICATION_MODE=prototype',
      'STRIPE_ENABLED=false',
      'STRIPE_TEST_FIXTURE_MODE=true'
    ]);
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => {
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
          return { status: 0, stdout: environment };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Mounts}}')) {
          return { status: 0, stdout: '[]' };
        }
        if (args[0] === 'inspect' && args.includes('{{json .NetworkSettings.Networks}}')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              [`${owned.project}_default`]: { NetworkID: 'c'.repeat(64) }
            })
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Image}}')) {
          return {
            status: 0,
            stdout: JSON.stringify(
              mismatchWorkerImage && args.at(-1) === 'b'.repeat(64)
                ? `sha256:${'d'.repeat(64)}`
                : lease().digest
            )
          };
        }
        if (args[0] === 'network' && args[1] === 'ls') {
          return { status: 0, stdout: `${'c'.repeat(12)}\n` };
        }
        if (args[0] === 'network' && args[1] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify({ Id: 'c'.repeat(64), Internal: true, Labels: labels })
          };
        }
        if (args[0] === 'compose' && args.includes('ps')) {
          return {
            status: 0,
            stdout: `${(args.at(-1) === 'app' ? 'a' : 'b').repeat(64)}\n`
          };
        }
        if (args[0] === 'compose' && args.includes('psql')) {
          databaseSnapshots += 1;
          databaseQueries.push(String(args.at(-1)));
          return {
            status: 0,
            stdout: JSON.stringify({
              acceptedOrderCount: 1,
              checkoutSessionCount: 1,
              completedFinancialScanCount: databaseSnapshots === 1 ? 0 : 1,
              unsafeFinancialJobCount: databaseSnapshots === 1 ? 1 : 0,
              administratorCommandSucceeded: true,
              administratorWorkerClaimObserved: true,
              administratorSalesReflectionObserved: true,
              administratorAuditReflectionObserved: true,
              webPrivateInputDenied: true,
              webDraftMutationDenied: true
            })
          };
        }
        if (args[0] === 'compose' && args.includes('stripe_api_canary')) {
          return { status: 0, stdout: '0' };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      })
    };
    const wait = vi.fn(async () => undefined);
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait
    });

    await expect(docker.inspect(owned, lease())).resolves.toEqual(safeEvidence());
    expect(databaseSnapshots).toBe(2);
    expect(databaseQueries).toHaveLength(2);
    expect(databaseQueries[0]).toContain(
      "stripe_checkout_session_id = 'cs_test_' || replace(purchase.id::text, '-', '')"
    );
    const financialQuery = databaseQueries.at(-1)!;
    const administratorRefundId = expectedFixtureUuid(owned.runId, 'administrator-refund');
    const administratorItemOneId = expectedFixtureUuid(
      owned.runId,
      'administrator-order-item-one'
    );
    const administratorItemTwoId = expectedFixtureUuid(
      owned.runId,
      'administrator-order-item-two'
    );
    expect(financialQuery).toContain(
      `command.private_input ->> 'refundId' = '${administratorRefundId}'`
    );
    expect(financialQuery).toContain(`draft.refund_id = '${administratorRefundId}'::uuid`);
    expect(financialQuery).toContain(`('${administratorItemOneId}'::uuid, 600)`);
    expect(financialQuery).toContain(`('${administratorItemTwoId}'::uuid, 400)`);
    expect(financialQuery.match(/except all/gu)).toHaveLength(2);
    expect(financialQuery).toContain(
      'select item.order_item_id, item.proposed_total_presentment_minor'
    );
    expect(financialQuery).toContain("command.private_input = jsonb_build_object(");
    const psqlCall = vi.mocked(command.capture).mock.calls.find(([args]) =>
      args[0] === 'compose' && args.includes('psql')
    );
    expect(psqlCall?.[0]).toEqual(expect.arrayContaining(['--tuples-only', '--no-align']));
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(500);
    expect(command.run).toHaveBeenCalledWith(
      expect.arrayContaining(['exec', '-T', 'worker', 'node', '-e']),
      expect.not.objectContaining({ STRIPE_SECRET_KEY: expect.anything() })
    );
    expect(command.capture).toHaveBeenCalledWith(
      expect.arrayContaining(['exec', '-T', 'stripe_api_canary', 'node', '-e']),
      expect.not.objectContaining({ STRIPE_SECRET_KEY: expect.anything() })
    );

    mismatchWorkerImage = true;
    await expect(docker.inspect(owned, lease())).rejects.toThrow(/leased image/u);
  });

  it('rejects an observed Stripe API connection attempt', async () => {
    const owned = manifest();
    const labels = {
      'com.docker.compose.project': owned.project,
      'com.paleorbit.plan6b-fixture.run': owned.runId,
      'com.paleorbit.plan6b-fixture.owner': owned.ownershipToken,
      'com.paleorbit.plan6b-fixture.stage': owned.stage
    };
    const environment = JSON.stringify([
      'APP_ENV=test',
      'APPLICATION_MODE=prototype',
      'STRIPE_ENABLED=false',
      'STRIPE_TEST_FIXTURE_MODE=true'
    ]);
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => {
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
          return { status: 0, stdout: environment };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Mounts}}')) {
          return { status: 0, stdout: '[]' };
        }
        if (args[0] === 'inspect' && args.includes('{{json .NetworkSettings.Networks}}')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              [`${owned.project}_default`]: { NetworkID: 'c'.repeat(64) }
            })
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Image}}')) {
          return { status: 0, stdout: JSON.stringify(lease().digest) };
        }
        if (args[0] === 'network' && args[1] === 'ls') {
          return { status: 0, stdout: `${'c'.repeat(12)}\n` };
        }
        if (args[0] === 'network' && args[1] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify({ Id: 'c'.repeat(64), Internal: true, Labels: labels })
          };
        }
        if (args[0] === 'compose' && args.includes('ps')) {
          return {
            status: 0,
            stdout: `${(args.at(-1) === 'app' ? 'a' : 'b').repeat(64)}\n`
          };
        }
        if (args[0] === 'compose' && args.includes('psql')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              acceptedOrderCount: 1,
              checkoutSessionCount: 1,
              completedFinancialScanCount: 1,
              unsafeFinancialJobCount: 0,
              administratorCommandSucceeded: true,
              administratorWorkerClaimObserved: true,
              administratorSalesReflectionObserved: true,
              administratorAuditReflectionObserved: true,
              webPrivateInputDenied: true,
              webDraftMutationDenied: true
            })
          };
        }
        if (args[0] === 'compose' && args.includes('stripe_api_canary')) {
          return { status: 0, stdout: '1' };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      })
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.inspect(owned, lease())).rejects.toThrow(/attempted external Stripe work/u);
  });

  it('removes only resources and the image matching the stored owned-run manifest', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    let aliasCreated = false;
    let resourcesPresent = false;
    const labels = {
      'com.docker.compose.project': owned.project,
      'com.paleorbit.plan6b-fixture.run': owned.runId,
      'com.paleorbit.plan6b-fixture.owner': owned.ownershipToken,
      'com.paleorbit.plan6b-fixture.stage': owned.stage
    };
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async (args) => {
        if (args[0] === 'image' && args[1] === 'tag') {
          aliasCreated = true;
          resourcesPresent = true;
        }
        if (args[0] === 'compose' && args.includes('down')) resourcesPresent = false;
        if (args[0] === 'image' && args[1] === 'rm') aliasCreated = false;
      }),
      capture: vi.fn(async (args, _environment, allowFailure) => {
        if (args[0] === 'ps') {
          return { status: 0, stdout: resourcesPresent ? `${'a'.repeat(64)}\n` : '' };
        }
        if (args[0] === 'network' && args[1] === 'ls') {
          return { status: 0, stdout: resourcesPresent ? `${'b'.repeat(64)}\n` : '' };
        }
        if (args[0] === 'volume' && args[1] === 'ls') {
          return { status: 0, stdout: resourcesPresent ? `${'c'.repeat(64)}\n` : '' };
        }
        if (
          (args[0] === 'inspect' && args.includes('{{json .Config.Labels}}')) ||
          ((args[0] === 'network' || args[0] === 'volume') && args[1] === 'inspect')
        ) return { status: 0, stdout: JSON.stringify(labels) };
        if (args[0] === 'image' && args[1] === 'ls') {
          return { status: 0, stdout: '' };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          if (args.at(-1) === owned.imageTag && allowFailure && !aliasCreated) {
            return { status: 1, stdout: '' };
          }
          return {
            status: 0,
            stdout: JSON.stringify({
              Id: lease().digest,
              Size: lease().sizeBytes,
              Config: {
                Labels: {
                  'com.paleorbit.plan6b-smoke.run': lease().productionRunId,
                  'com.paleorbit.plan6b-smoke.owner': lease().productionOwnershipToken,
                  'com.paleorbit.plan6b-smoke.stage': lease().stage
                }
              }
            })
          };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      })
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    try {
      await docker.acquireImage(owned, lease());
      await docker.cleanup(owned, lease());
      await expect(readFile(owned.manifestFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(command.run).toHaveBeenCalledWith(
        expect.arrayContaining(['down', '--volumes', '--remove-orphans']),
        expect.any(Object)
      );
      expect(command.run).toHaveBeenCalledWith(
        ['image', 'rm', owned.imageTag],
        expect.any(Object)
      );
      expect(command.run).not.toHaveBeenCalledWith(
        ['image', 'rm', lease().sourceTag],
        expect.any(Object)
      );
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('fails cleanup when Compose down succeeds but an owned volume remains', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    const volumeId = 'plan6b-owned-volume';
    let downCalled = false;
    const labels = {
      'com.docker.compose.project': owned.project,
      'com.paleorbit.plan6b-fixture.run': owned.runId,
      'com.paleorbit.plan6b-fixture.owner': owned.ownershipToken,
      'com.paleorbit.plan6b-fixture.stage': owned.stage
    };
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async (args) => {
        if (args[0] === 'compose' && args.includes('down')) downCalled = true;
      }),
      capture: vi.fn(async (args) => {
        if (args[0] === 'volume' && args[1] === 'ls') {
          return { status: 0, stdout: `${volumeId}\n` };
        }
        if (args[0] === 'volume' && args[1] === 'inspect') {
          return { status: 0, stdout: JSON.stringify(labels) };
        }
        return { status: 0, stdout: '' };
      })
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(docker.cleanup(owned, lease())).rejects.toThrow(/resource|volume|cleanup/u);
      expect(downCalled).toBe(true);
      expect(await readFile(owned.manifestFile, 'utf8')).toContain(owned.project);
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('refuses cleanup before Compose down when an exact-name volume has foreign labels', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    const exactVolumeName = `${owned.project}_stripe_attempts`;
    let downCalled = false;
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async (args) => {
        if (args[0] === 'compose' && args.includes('down')) downCalled = true;
      }),
      capture: vi.fn(async (args) => {
        if (args[0] === 'volume' && args[1] === 'ls' &&
          args.includes(`name=${exactVolumeName}`)) {
          return { status: 0, stdout: `${exactVolumeName}\n` };
        }
        if (args[0] === 'volume' && args[1] === 'inspect') {
          return { status: 0, stdout: JSON.stringify({}) };
        }
        return { status: 0, stdout: '' };
      })
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(docker.cleanup(owned, lease())).rejects.toThrow(/foreign|volume|cleanup/u);
      expect(downCalled).toBe(false);
      expect(await readFile(owned.manifestFile, 'utf8')).toContain(owned.project);
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('refuses cleanup when an observed resource has foreign ownership labels', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => {
        if (args[0] === 'ps') return { status: 0, stdout: `${'a'.repeat(64)}\n` };
        if (args[0] === 'network' || args[0] === 'volume') {
          return { status: 0, stdout: '' };
        }
        if (args[0] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify({
              'com.docker.compose.project': owned.project,
              'com.paleorbit.plan6b-fixture.run': owned.runId,
              'com.paleorbit.plan6b-fixture.owner': '0'.repeat(32),
              'com.paleorbit.plan6b-fixture.stage': owned.stage
            })
          };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      })
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(docker.cleanup(owned, lease())).rejects.toThrow(/owner|foreign/u);
      expect(command.run).not.toHaveBeenCalled();
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('fails closed before cleanup when Docker inventory cannot be captured', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    const command: FixtureProbeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async () => ({ status: 1, stdout: '' }))
    };
    const docker = createFixtureProbeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      postJson: vi.fn(),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(docker.cleanup(owned, lease())).rejects.toThrow(/Docker resource inventory failed/u);
      expect(command.run).not.toHaveBeenCalled();
      await expect(readFile(owned.manifestFile, 'utf8')).resolves.toContain(owned.runId);
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('runs the CLI seam and reports only bounded aggregate evidence', async () => {
    const owned = manifest();
    const trace: string[] = [];
    const report = vi.fn();

    await expect(runFixtureRuntimeProbe('6b-ii', lease(), {
      createManifest: vi.fn(async () => owned),
      createOperations: vi.fn(() => operations(trace)),
      report
    })).resolves.toEqual(safeEvidence());

    expect(trace.at(-1)).toBe('cleanup');
    expect(report).toHaveBeenCalledWith('[plan6b-fixture] complete', {
      project: owned.project,
      imageDigest: lease().digest,
      acceptedOrderCount: 1,
      checkoutSessionCount: 1,
      completedFinancialScanCount: 1
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain(owned.ownershipToken);
    expect(JSON.stringify(report.mock.calls)).not.toContain('checkout.stripe.test');
  });

  it('removes the exact unstarted manifest when operation setup fails', async () => {
    const owned = await createFixtureProbeManifest('6b-ii');
    try {
      await expect(runFixtureRuntimeProbe('6b-ii', lease(), {
        createManifest: vi.fn(async () => owned),
        createOperations: vi.fn(() => {
          throw new Error('private-setup-failure');
        }),
        report: vi.fn()
      })).rejects.toThrow('[plan6b-fixture] fixture runtime verification failed');
      await expect(stat(owned.tempDirectory)).rejects.toThrow();
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('requires one exact stage and nests the fixture inside its matching image lease', async () => {
    const verifiedLease = lease();
    const runFixture = vi.fn(async () => safeEvidence());
    const runProduction = vi.fn(async (_stage, consume) => {
      await consume?.(verifiedLease);
      return {
        migrationState: '{}',
        image: { digest: verifiedLease.digest, sizeBytes: verifiedLease.sizeBytes }
      };
    });

    await runFixtureRuntimeProbeCli(['--stage', '6b-ii'], { runProduction, runFixture });

    expect(runProduction).toHaveBeenCalledExactlyOnceWith('6b-ii', expect.any(Function));
    expect(runFixture).toHaveBeenCalledExactlyOnceWith('6b-ii', verifiedLease);

    for (const invalid of [
      [],
      ['--stage'],
      ['--stage', '6b-i'],
      ['--stage', 'plan6b-i'],
      ['--stage', '6b-ii', '--stage', '6b-ii'],
      ['6b-ii']
    ]) {
      const invalidProduction = vi.fn();
      await expect(runFixtureRuntimeProbeCli(invalid, {
        runProduction: invalidProduction,
        runFixture: vi.fn()
      })).rejects.toThrow(/stage arguments are invalid/u);
      expect(invalidProduction).not.toHaveBeenCalled();
    }
  });
});
