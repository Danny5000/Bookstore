import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  executeProductionSmoke,
  createProductionSmokeManifest,
  createProductionSmokeDockerOperations,
  renderProductionSmokeOverride,
  runProductionSmoke,
  validateProductionSmokeManifest,
  type DisabledRuntimeEvidence,
  type ProductionSmokeRunDependencies,
  type ProductionSmokeManifest,
  type ProductionSmokeOperations,
  type ProductionSmokeCommandRuntime
} from './plan6b-production-smoke';

function manifest(): ProductionSmokeManifest {
  const runId = '0123456789abcdef';
  const tempDirectory = join(tmpdir(), `pale-orbit-plan6b-smoke-${runId}`);
  return {
    version: 1,
    runId,
    ownershipToken: 'f'.repeat(32),
    project: `pale-orbit-plan6b-smoke-${runId}`,
    imageTag: `pale-orbit:plan6b-i-smoke-${runId}`,
    tempDirectory,
    overrideFile: join(tempDirectory, 'compose.override.yaml'),
    manifestFile: join(tempDirectory, 'owned-run.json'),
    secretDirectory: join(tempDirectory, 'secrets'),
    httpHost: '127.0.0.1',
    httpsHost: '127.0.0.1',
    httpPort: 49152,
    httpsPort: 49153
  };
}

const safeRuntime = (): DisabledRuntimeEvidence => ({
  storefrontStatus: 503,
  commerceStatus: 503,
  appStripeEnabled: false,
  workerStripeEnabled: false,
  appDatabaseRoleIsWeb: true,
  workerDatabaseRoleIsWorker: true,
  appFixtureMode: false,
  workerFixtureMode: false,
  appHasStripeSecret: false,
  workerHasStripeSecret: false,
  postgresHostPublished: false,
  workerReady: true,
  providerBackedJobCount: 0,
  classificationRootCount: 1,
  classificationRootCompletedCount: 1,
  classificationRootUnsafeCount: 0,
  classificationContinuationCount: 1,
  classificationContinuationCompletedCount: 1,
  classificationContinuationUnsafeCount: 0,
  classificationRunCount: 1,
  classificationRunCompletedCount: 1,
  pendingProjectionVersionCount: 0,
  providerLedgerSubjectCount: 0
});

const migrationState = (
  overrides: Partial<Record<
    | 'migrationCount'
    | 'migrationMax'
    | 'credentialAuthorityCount'
    | 'entitlementGrantCount'
    | 'refundComponentCount'
    | 'financialIssueCount'
    | 'projectionVersionCount'
    | 'activeClassifierVersion'
    | 'activeAllocationAlgorithmVersion',
    number
  >> = {}
): string => JSON.stringify({
  migrationCount: 7,
  migrationMax: 7,
  credentialAuthorityCount: 0,
  entitlementGrantCount: 0,
  refundComponentCount: 0,
  financialIssueCount: 0,
  projectionVersionCount: 1,
  activeClassifierVersion: 1,
  activeAllocationAlgorithmVersion: 1,
  ...overrides
});

function operations(trace: string[], failAt: string | null = null): ProductionSmokeOperations {
  const step = async <Value>(name: string, value: Value): Promise<Value> => {
    trace.push(name);
    if (failAt === name) throw new Error(`private-${name}-failure`);
    return value;
  };
  return {
    build: vi.fn(() => step('build', undefined)),
    revalidatePorts: vi.fn(() => step('ports', undefined)),
    startDatabase: vi.fn(() => step('database', undefined)),
    migrate: vi.fn(() => step('migrate', undefined)),
    snapshotMigrationState: vi.fn(() => step('snapshot', migrationState())),
    startRuntime: vi.fn(() => step('runtime', undefined)),
    inspectDisabledRuntime: vi.fn(() => step('inspect-runtime', safeRuntime())),
    inspectImage: vi.fn(() => step('inspect-image', {
      digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 42
    })),
    cleanup: vi.fn(() => step('cleanup', undefined))
  };
}

describe('Plan 6B production smoke ownership', () => {
  it('publishes only the two explicit Plan 6B smoke entry points', async () => {
    const packageManifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as { scripts?: Record<string, string> };
    expect(packageManifest.scripts).toMatchObject({
      'smoke:plan6b-i': 'node --import tsx scripts/plan6b-production-smoke.ts',
      'smoke:plan6b-fixture': 'node --import tsx scripts/plan6b-fixture-runtime-probe.ts'
    });
  });

  it('accepts only the exact owned project, tag, paths, loopback hosts, and ephemeral ports', () => {
    expect(() => validateProductionSmokeManifest(manifest())).not.toThrow();
    for (const mutate of [
      (value: ProductionSmokeManifest) => ({ ...value, project: 'default' }),
      (value: ProductionSmokeManifest) => ({ ...value, imageTag: 'pale-orbit:latest' }),
      (value: ProductionSmokeManifest) => ({ ...value, tempDirectory: tmpdir() }),
      (value: ProductionSmokeManifest) => ({ ...value, overrideFile: join(tmpdir(), 'foreign.yaml') }),
      (value: ProductionSmokeManifest) => ({ ...value, httpHost: '0.0.0.0' as '127.0.0.1' }),
      (value: ProductionSmokeManifest) => ({ ...value, httpPort: 80 }),
      (value: ProductionSmokeManifest) => ({ ...value, httpsPort: value.httpPort })
    ]) expect(() => validateProductionSmokeManifest(mutate(manifest()))).toThrow();
  });

  it('renders only loopback host publication with the exact unique image and ownership labels', () => {
    const source = renderProductionSmokeOverride(manifest());
    expect(source).toContain('127.0.0.1:49152:80');
    expect(source).toContain('127.0.0.1:49153:443');
    expect(source).toContain('127.0.0.1:49153:443/udp');
    expect(source).toContain('pale-orbit:plan6b-i-smoke-0123456789abcdef');
    expect(source).toContain('com.paleorbit.plan6b-smoke.run: 0123456789abcdef');
    expect(source).toContain(`com.paleorbit.plan6b-smoke.owner: ${'f'.repeat(32)}`);
    expect(source).not.toContain('0.0.0.0:80');
    expect(source).not.toContain('0.0.0.0:443');
  });

  it('builds, migrates twice without drift, checks disabled runtime, and always cleans up', async () => {
    const trace: string[] = [];
    await expect(executeProductionSmoke(manifest(), operations(trace))).resolves.toEqual({
      migrationState: migrationState(),
      image: { digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 42 }
    });
    expect(trace).toEqual([
      'build', 'ports', 'database', 'migrate', 'snapshot', 'migrate', 'snapshot',
      'ports', 'runtime', 'inspect-runtime', 'inspect-image', 'cleanup'
    ]);
  });

  it('leases the validated production image only before owned cleanup', async () => {
    const trace: string[] = [];
    const result = await executeProductionSmoke(
      manifest(),
      operations(trace),
      async (lease) => {
        trace.push('consume-image');
        expect(lease).toEqual({
          version: 1,
          sourceTag: manifest().imageTag,
          productionRunId: manifest().runId,
          productionOwnershipToken: manifest().ownershipToken,
          digest: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 42
        });
      }
    );

    expect(result.image.digest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(trace.slice(-3)).toEqual(['inspect-image', 'consume-image', 'cleanup']);
  });

  it('cleans the production source image when its lease consumer fails', async () => {
    const trace: string[] = [];
    await expect(executeProductionSmoke(
      manifest(),
      operations(trace),
      async () => {
        trace.push('consume-image');
        throw new Error('private-fixture-failure');
      }
    )).rejects.toThrow('[plan6b-smoke] smoke verification failed');
    expect(trace.slice(-3)).toEqual(['inspect-image', 'consume-image', 'cleanup']);
  });

  it('cleans the exact owned manifest when post-manifest setup fails', async () => {
    const owned = manifest();
    const cleanupSetupFailure = vi.fn(async () => undefined);
    const dependencies: ProductionSmokeRunDependencies = {
      createManifest: vi.fn(async () => owned),
      createOperations: vi.fn(async () => {
        throw new Error('private-secret-read-failure');
      }),
      cleanupSetupFailure,
      report: vi.fn()
    };

    await expect(runProductionSmoke(undefined, dependencies)).rejects.toThrow(
      '[plan6b-smoke] smoke verification failed'
    );
    expect(cleanupSetupFailure).toHaveBeenCalledExactlyOnceWith(owned);
    expect(dependencies.report).not.toHaveBeenCalled();
  });

  it.each([
    'build', 'ports', 'database', 'migrate', 'snapshot', 'runtime', 'inspect-runtime', 'inspect-image'
  ])('cleans the exact owned run when %s fails', async (failAt) => {
    const trace: string[] = [];
    await expect(executeProductionSmoke(manifest(), operations(trace, failAt))).rejects.toThrow();
    expect(trace.at(-1)).toBe('cleanup');
  });

  it('rejects migration drift and unsafe disabled-runtime evidence before reporting success', async () => {
    const trace: string[] = [];
    const drift = operations(trace);
    vi.mocked(drift.snapshotMigrationState)
      .mockResolvedValueOnce(migrationState())
      .mockResolvedValueOnce(migrationState({ migrationCount: 8, migrationMax: 8 }));
    await expect(executeProductionSmoke(manifest(), drift)).rejects.toThrow(
      '[plan6b-smoke] smoke verification failed'
    );
    expect(trace.at(-1)).toBe('cleanup');

    for (const unsafe of [
      { appStripeEnabled: true }, { workerFixtureMode: true }, { appHasStripeSecret: true },
      { appDatabaseRoleIsWeb: false }, { workerDatabaseRoleIsWorker: false },
      { postgresHostPublished: true }, { workerReady: false }, { providerBackedJobCount: 1 },
      { classificationRootCount: 2 }, { classificationRootUnsafeCount: 1 },
      { classificationContinuationCount: 0 },
      { classificationContinuationCompletedCount: 0 },
      { classificationContinuationUnsafeCount: 1 },
      { classificationRunCount: 0 }, { classificationRunCompletedCount: 0 },
      { pendingProjectionVersionCount: 1 },
      { storefrontStatus: 200 }, { commerceStatus: 200 }
    ]) {
      const calls: string[] = [];
      const runtime = operations(calls);
      vi.mocked(runtime.inspectDisabledRuntime).mockResolvedValue({ ...safeRuntime(), ...unsafe });
      await expect(executeProductionSmoke(manifest(), runtime)).rejects.toThrow(
        '[plan6b-smoke] smoke verification failed'
      );
      expect(calls.at(-1)).toBe('cleanup');
    }
  });

  it('requires the exact active c1/a1 projection-version singleton before runtime startup', async () => {
    for (const unsafe of [
      { projectionVersionCount: 0 },
      { projectionVersionCount: 2 },
      { activeClassifierVersion: 2 },
      { activeAllocationAlgorithmVersion: 2 }
    ]) {
      const trace: string[] = [];
      const smoke = operations(trace);
      vi.mocked(smoke.snapshotMigrationState).mockResolvedValue(migrationState(unsafe));
      await expect(executeProductionSmoke(manifest(), smoke)).rejects.toThrow(
        '[plan6b-smoke] smoke verification failed'
      );
      expect(smoke.startRuntime).not.toHaveBeenCalled();
      expect(trace.at(-1)).toBe('cleanup');
    }
  });

  it('requires the sole local replay root to complete against an empty provider ledger', async () => {
    for (const unsafe of [
      { classificationRootCompletedCount: 0, providerLedgerSubjectCount: 0 },
      { classificationContinuationCompletedCount: 0, providerLedgerSubjectCount: 0 },
      { classificationRunCompletedCount: 0, providerLedgerSubjectCount: 0 },
      { pendingProjectionVersionCount: 1, providerLedgerSubjectCount: 0 },
      { classificationRootCompletedCount: 1, providerLedgerSubjectCount: 1 }
    ]) {
      const trace: string[] = [];
      const runtime = operations(trace);
      vi.mocked(runtime.inspectDisabledRuntime).mockResolvedValue({
        ...safeRuntime(),
        ...unsafe
      });
      await expect(executeProductionSmoke(manifest(), runtime)).rejects.toThrow(
        '[plan6b-smoke] smoke verification failed'
      );
      expect(trace.at(-1)).toBe('cleanup');
    }
  });

  it('queries the actual provider-ledger tables with valid JSON argument separation', async () => {
    const source = await readFile(
      new URL('./plan6b-production-smoke.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain("          ),\n          'providerLedgerSubjectCount',");
    expect(source).toContain('from stripe_balance_transactions');
    expect(source).toContain('from stripe_balance_transaction_fee_details');
    expect(source).not.toContain('from financial_balance_transactions');
    expect(source).not.toContain('from financial_balance_transaction_fee_details');
  });

  it('recognizes the exact composite replay job payload kind in disabled mode', async () => {
    const source = await readFile(
      new URL('./plan6b-production-smoke.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain("payload->>'kind' = 'composite_replay'");
    expect(source).toContain("payload->>'kind' = 'continuation'");
    expect(source).toContain("'classification_replay_page', 'classification_replay_finalize'");
    expect(source).toContain("'classificationContinuationCompletedCount'");
    expect(source).toContain('from financial_scan_runs');
    expect(source).toContain("'pendingProjectionVersionCount'");
    expect(source).not.toContain("coalesce(payload->>'kind', '') <> 'composite_replay'");
    expect(source).not.toContain("payload->>'kind' = 'classification_replay'");
    expect(source).not.toContain("coalesce(payload->>'kind', '') <> 'classification_replay'");
  });

  it('does not expose operation messages or causes across the smoke boundary', async () => {
    const trace: string[] = [];
    const runtime = operations(trace);
    vi.mocked(runtime.startRuntime).mockRejectedValue(
      Object.assign(new Error('sk_test_private_runtime'), { cause: 'whsec_private_cause' })
    );
    const error = await executeProductionSmoke(manifest(), runtime).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('Error: [plan6b-smoke] smoke verification failed');
    expect(Object.hasOwn(error as object, 'cause')).toBe(false);
  });

  it('refuses an unsafe manifest before invoking cleanup or another operation', async () => {
    const trace: string[] = [];
    await expect(executeProductionSmoke(
      { ...manifest(), project: '*' }, operations(trace)
    )).rejects.toThrow(/manifest|project/u);
    expect(trace).toEqual([]);
  });

  it('invokes Docker without shell interpolation or inherited Stripe secrets', async () => {
    const calls: Array<{ kind: 'run' | 'capture'; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async (args, env) => {
        calls.push({ kind: 'run', args, env });
      }),
      capture: vi.fn(async (args, env) => {
        calls.push({ kind: 'capture', args, env });
        return { status: 0, stdout: '' };
      })
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: {
        PATH: 'safe-path',
        STRIPE_SECRET_KEY: 'sk_test_private_canary',
        STRIPE_WEBHOOK_SECRET: 'whsec_private_canary'
      },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await docker.build(owned);

    expect(calls.find((call) => call.kind === 'run')?.args).toEqual([
      'build', '--target', 'production', '--label',
      'com.paleorbit.plan6b-smoke.run=0123456789abcdef', '--label',
      `com.paleorbit.plan6b-smoke.owner=${'f'.repeat(32)}`, '--tag',
      'pale-orbit:plan6b-i-smoke-0123456789abcdef', '.'
    ]);
    expect(JSON.stringify(calls)).not.toContain('sk_test_private_canary');
    expect(JSON.stringify(calls)).not.toContain('whsec_private_canary');
    expect(calls.every((call) => !Object.keys(call.env).some((key) => key.startsWith('STRIPE_'))))
      .toBe(true);
    expect(calls.every((call) => call.env.ORIGIN === 'https://plan6b-smoke.invalid'))
      .toBe(true);
  });

  it('provisions the fourth role before exercising production cleanup wiring', async () => {
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command: {
        run: vi.fn(async (args, env) => { calls.push({ args, env }); }),
        capture: vi.fn(async () => ({ status: 0, stdout: '' }))
      },
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await docker.migrate(owned);

    expect(calls.map((call) => call.args.at(-1))).toEqual([
      'migrate',
      'database-role-provision',
      'storage-cleanup'
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) =>
      call.env.DATABASE_STORAGE_CLEANUP_USER ===
        'plan6b_smoke_storage_cleanup_0123456789abcdef'
    )).toBe(true);
  });

  it('materializes a private cleanup database secret with the owned smoke manifest', async () => {
    const owned = await createProductionSmokeManifest();
    try {
      await expect(readFile(
        join(owned.secretDirectory, 'database_storage_cleanup_password'),
        'utf8'
      )).resolves.toMatch(/^[a-f0-9]{48}$/u);
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('refuses a Docker project collision before building or cleaning foreign resources', async () => {
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: 0,
        stdout: args[0] === 'ps' ? `${'a'.repeat(64)}\n` : ''
      }))
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.build(owned)).rejects.toThrow(/collides/u);
    expect(command.run).not.toHaveBeenCalled();
  });

  it.each([
    ['container', (owned: ReturnType<typeof manifest>) => `${owned.project}-postgres-1`],
    ['network', (owned: ReturnType<typeof manifest>) => `${owned.project}_default`],
    ['volume', (owned: ReturnType<typeof manifest>) => `${owned.project}_postgres_data`]
  ] as const)('refuses a foreign exact-name %s before the first Docker mutation', async (
    resource,
    expectedName
  ) => {
    const owned = manifest();
    const name = expectedName(owned);
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: 0,
        stdout: args[0] === (resource === 'container' ? 'ps' : resource) &&
          args.includes(`name=${name}`) ? `${name}\n` : ''
      }))
    };
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.build(owned)).rejects.toThrow(/exact-name|collid/iu);
    expect(command.run).not.toHaveBeenCalled();
  });

  it('rechecks exact-name collisions immediately before Compose startup', async () => {
    const owned = manifest();
    const exactVolumeName = `${owned.project}_postgres_data`;
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: 0,
        stdout: args[0] === 'volume' && args.includes(`name=${exactVolumeName}`)
          ? `${exactVolumeName}\n`
          : ''
      }))
    };
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.startDatabase(owned)).rejects.toThrow(/exact-name|collid/iu);
    expect(command.run).not.toHaveBeenCalled();
  });

  it('fails closed when Docker resource inventory cannot be read', async () => {
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: args[0] === 'ps' ? 1 : args[0] === 'image' ? 1 : 0,
        stdout: ''
      }))
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.build(owned)).rejects.toThrow(/inventory/u);
    expect(command.run).not.toHaveBeenCalled();
  });

  it('fails closed when the exact image-tag inventory cannot be read', async () => {
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: args[0] === 'image' ? 1 : 0,
        stdout: ''
      }))
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.build(owned)).rejects.toThrow(/image.*inventory/iu);
    expect(command.run).not.toHaveBeenCalled();
  });

  it('never removes a pre-existing image tag after refusing its collision', async () => {
    const owned = await createProductionSmokeManifest();
    const calls: string[][] = [];
    const imageId = `sha256:${'a'.repeat(64)}`;
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async (args) => { calls.push([...args]); }),
      capture: vi.fn(async (args) => {
        if (args[0] === 'image' && args[1] === 'ls') {
          return { status: 0, stdout: `${imageId}\n` };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify({
              Id: imageId,
              Size: 42,
              Config: { Labels: {
                'com.paleorbit.plan6b-smoke.run': owned.runId,
                'com.paleorbit.plan6b-smoke.owner': owned.ownershipToken
              } }
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(executeProductionSmoke(owned, docker)).rejects.toThrow(
        '[plan6b-smoke] smoke verification failed'
      );
      expect(calls).not.toContainEqual(['image', 'rm', owned.imageTag]);
      await expect(stat(owned.tempDirectory)).rejects.toThrow();
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('revalidates loopback ports immediately before starting the runtime', async () => {
    const trace: string[] = [];
    const smoke = operations(trace);
    await executeProductionSmoke(manifest(), smoke);
    expect(trace).toEqual([
      'build', 'ports', 'database', 'migrate', 'snapshot', 'migrate', 'snapshot',
      'ports', 'runtime', 'inspect-runtime', 'inspect-image', 'cleanup'
    ]);
  });

  it('captures the canonical projection-version seed in stable migration evidence', async () => {
    const queries: string[] = [];
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => {
        if (args.includes('psql')) queries.push(String(args.at(-1)));
        return { status: args[0] === 'image' ? 1 : 0, stdout: '{}' };
      })
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await docker.snapshotMigrationState(owned);
    expect(queries[0]).toContain("'projectionVersionCount'");
    expect(queries[0]).toContain("'activeClassifierVersion'");
    expect(queries[0]).toContain("'activeAllocationAlgorithmVersion'");
  });

  it('inspects app and worker mounts plus /run/secrets instead of trusting environment alone', async () => {
    const runs: readonly string[][] = [];
    const mutableRuns = runs as string[][];
    const appId = 'a'.repeat(64);
    const workerId = 'b'.repeat(64);
    const postgresId = 'c'.repeat(64);
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async (args) => {
        mutableRuns.push([...args]);
      }),
      capture: vi.fn(async (args) => {
        if (args.includes('ps') && args.includes('--quiet')) {
          const service = args.at(-1);
          return {
            status: 0,
            stdout: `${service === 'app' ? appId : service === 'worker' ? workerId : postgresId}\n`
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
          return { status: 0, stdout: '[]' };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Mounts}}')) {
          return {
            status: 0,
            stdout: args.at(-1) === appId
              ? JSON.stringify([{ Destination: '/run/secrets/stripe_api_key' }])
              : '[]'
          };
        }
        if (args[0] === 'port') return { status: 0, stdout: '' };
        if (args.includes('psql')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              providerBackedJobCount: 0,
              classificationRootCount: 1,
              classificationRootCompletedCount: 1,
              classificationRootUnsafeCount: 0,
              classificationContinuationCount: 1,
              classificationContinuationCompletedCount: 1,
              classificationContinuationUnsafeCount: 0,
              classificationRunCount: 1,
              classificationRunCompletedCount: 1,
              pendingProjectionVersionCount: 0,
              providerLedgerSubjectCount: 0
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.inspectDisabledRuntime(owned)).resolves.toMatchObject({
      appHasStripeSecret: true,
      workerHasStripeSecret: false
    });
    for (const service of ['app', 'worker']) {
      expect(mutableRuns.some((args) =>
        args.includes('exec') && args.includes(service) && args.some((arg) => arg.includes('/run/secrets'))
      )).toBe(true);
    }
  });

  it('fails closed when PostgreSQL host-port inspection cannot be read', async () => {
    const appId = 'a'.repeat(64);
    const workerId = 'b'.repeat(64);
    const postgresId = 'c'.repeat(64);
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => {
        if (args.includes('ps') && args.includes('--quiet')) {
          const service = args.at(-1);
          return {
            status: 0,
            stdout: `${service === 'app' ? appId : service === 'worker' ? workerId : postgresId}\n`
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
          return { status: 0, stdout: '[]' };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Mounts}}')) {
          return { status: 0, stdout: '[]' };
        }
        if (args[0] === 'port') return { status: 1, stdout: '' };
        if (args.includes('psql')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              providerBackedJobCount: 0,
              classificationRootCount: 1,
              classificationRootCompletedCount: 1,
              classificationRootUnsafeCount: 0,
              classificationContinuationCount: 1,
              classificationContinuationCompletedCount: 1,
              classificationContinuationUnsafeCount: 0,
              classificationRunCount: 1,
              classificationRunCompletedCount: 1,
              pendingProjectionVersionCount: 0,
              providerLedgerSubjectCount: 0
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.inspectDisabledRuntime(owned)).rejects.toThrow(/port.*evidence/iu);
  });

  it('waits a bounded interval for the disabled composite replay finalizer to complete', async () => {
    const appId = 'a'.repeat(64);
    const workerId = 'b'.repeat(64);
    const postgresId = 'c'.repeat(64);
    let jobSnapshot = 0;
    const wait = vi.fn(async () => undefined);
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => {
        if (args.includes('ps') && args.includes('--quiet')) {
          const service = args.at(-1);
          return {
            status: 0,
            stdout: `${service === 'app' ? appId : service === 'worker' ? workerId : postgresId}\n`
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
          return { status: 0, stdout: '[]' };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Mounts}}')) {
          return { status: 0, stdout: '[]' };
        }
        if (args[0] === 'port') return { status: 0, stdout: '' };
        if (args.includes('psql')) {
          jobSnapshot += 1;
          return {
            status: 0,
            stdout: JSON.stringify({
              providerBackedJobCount: 0,
              classificationRootCount: 1,
              classificationRootCompletedCount: jobSnapshot === 1 ? 0 : 1,
              classificationRootUnsafeCount: 0,
              classificationContinuationCount: jobSnapshot === 1 ? 0 : 1,
              classificationContinuationCompletedCount: jobSnapshot === 1 ? 0 : 1,
              classificationContinuationUnsafeCount: 0,
              classificationRunCount: 1,
              classificationRunCompletedCount: jobSnapshot === 1 ? 0 : 1,
              pendingProjectionVersionCount: 0,
              providerLedgerSubjectCount: 0
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait
    });

    await expect(docker.inspectDisabledRuntime(owned)).resolves.toMatchObject({
      classificationRootCompletedCount: 1,
      classificationContinuationCompletedCount: 1,
      classificationRunCompletedCount: 1,
      pendingProjectionVersionCount: 0
    });
    expect(jobSnapshot).toBe(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('removes and verifies only the exact owned production image tag', async () => {
    const owned = await createProductionSmokeManifest();
    let imagePresent = false;
    const imageInventories: string[][] = [];
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async (args) => {
        if (args[0] === 'build') imagePresent = true;
        if (args[0] === 'image' && args[1] === 'rm') imagePresent = false;
      }),
      capture: vi.fn(async (args) => {
        if (args[0] === 'image' && args[1] === 'ls') {
          imageInventories.push([...args]);
          return { status: 0, stdout: imagePresent ? `sha256:${'a'.repeat(64)}\n` : '' };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify({
              Id: `sha256:${'a'.repeat(64)}`,
              Size: 42,
              Config: { Labels: {
                'com.paleorbit.plan6b-smoke.run': owned.runId,
                'com.paleorbit.plan6b-smoke.owner': owned.ownershipToken
              } }
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    try {
      await docker.build(owned);
      await docker.cleanup(owned);
      expect(imageInventories).toHaveLength(3);
      expect(command.run).toHaveBeenCalledWith(['image', 'rm', owned.imageTag], expect.any(Object));
      expect(imagePresent).toBe(false);
      await expect(stat(owned.tempDirectory)).rejects.toThrow();
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('fails cleanup when Compose down succeeds but an owned volume remains', async () => {
    const owned = await createProductionSmokeManifest();
    const volumeId = 'plan6b-owned-volume';
    let downCalled = false;
    const labels = {
      'com.docker.compose.project': owned.project,
      'com.paleorbit.plan6b-smoke.run': owned.runId,
      'com.paleorbit.plan6b-smoke.owner': owned.ownershipToken
    };
    const command: ProductionSmokeCommandRuntime = {
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
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(docker.cleanup(owned)).rejects.toThrow(/resource|volume|cleanup/u);
      expect(downCalled).toBe(true);
      expect(await readFile(owned.manifestFile, 'utf8')).toContain(owned.project);
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('refuses cleanup before Compose down when an exact-name volume has foreign labels', async () => {
    const owned = await createProductionSmokeManifest();
    const exactVolumeName = `${owned.project}_postgres_data`;
    let downCalled = false;
    const command: ProductionSmokeCommandRuntime = {
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
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(docker.cleanup(owned)).rejects.toThrow(/foreign|volume|cleanup/u);
      expect(downCalled).toBe(false);
      expect(await readFile(owned.manifestFile, 'utf8')).toContain(owned.project);
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });
});
