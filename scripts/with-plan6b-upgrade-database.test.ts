import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupOwnedDatabase,
  createOwnedManifest,
  executeOwnedUpgradeRun,
  parseLoopbackPublishedEndpoint,
  renderOwnedCompose,
  startOwnedDatabase,
  validateOwnedCleanup,
  validateOwnedStartupCleanup,
  type DockerCommandRuntime,
  type OwnedRunManifest,
  type OwnedRuntimeObservation
} from './with-plan6b-upgrade-database';
import { withoutStripeProviderSecrets } from './test-environment';

const manifest = (): OwnedRunManifest => ({
  version: 1,
  runId: '9afaf2bfa875a4b3',
  project: 'pale-orbit-plan6b-9afaf2bfa875a4b3',
  database: 'plan6b_9afaf2bfa875a4b3',
  user: 'plan6b_9afaf2bfa875a4b3',
  password: '7d1cd73db0bf23f97281049aa4a20a65f13ed3d12f5bb120',
  ownershipToken: '5fd1044db566e1b20e04eaa7218b7830',
  host: '127.0.0.1',
  port: 49152,
  containerId: 'a'.repeat(64),
  tempDirectory: join(tmpdir(), 'pale-orbit-plan6b-upgrade-9afaf2bfa875a4b3'),
  composeFile: join(
    tmpdir(),
    'pale-orbit-plan6b-upgrade-9afaf2bfa875a4b3',
    'compose.plan6b.yaml'
  ),
  manifestFile: join(
    tmpdir(),
    'pale-orbit-plan6b-upgrade-9afaf2bfa875a4b3',
    'owned-run.json'
  )
});

const observation = (owned = manifest()): OwnedRuntimeObservation => ({
  project: owned.project,
  cleanupProject: owned.project,
  cleanupComposeFile: owned.composeFile,
  cleanupTempDirectory: owned.tempDirectory,
  containerId: owned.containerId,
  labels: {
    'com.docker.compose.project': owned.project,
    'com.docker.compose.service': 'postgres',
    'com.paleorbit.plan6b-upgrade.run': owned.runId,
    'com.paleorbit.plan6b-upgrade.owner': owned.ownershipToken,
    'com.paleorbit.plan6b-upgrade.database': owned.database,
    'com.paleorbit.plan6b-upgrade.user': owned.user
  },
  containerEnvironment: {
    POSTGRES_DB: owned.database,
    POSTGRES_USER: owned.user,
    POSTGRES_PASSWORD: owned.password
  },
  host: owned.host,
  port: owned.port
});

interface FakeDockerState {
  containerNamesAfterDown?: readonly string[];
  downCalled: boolean;
  downArguments: readonly string[] | null;
  networkNameFormatUsed: boolean;
  networks: Record<string, Record<string, string>>;
  retainVolumeAfterDown?: boolean;
  startupAttempts: number;
  volumes: Record<string, Record<string, string>>;
}

function exactResourceLabels(owned: OwnedRunManifest): Record<string, string> {
  return {
    'com.docker.compose.project': owned.project,
    'com.paleorbit.plan6b-upgrade.run': owned.runId,
    'com.paleorbit.plan6b-upgrade.owner': owned.ownershipToken,
    'com.paleorbit.plan6b-upgrade.database': owned.database,
    'com.paleorbit.plan6b-upgrade.user': owned.user
  };
}

function partialStartupDocker(owned: OwnedRunManifest, state: FakeDockerState): DockerCommandRuntime {
  const composePrefix = [
    'compose', '--project-name', owned.project, '--file', owned.composeFile
  ];
  const same = (actual: readonly string[], expected: readonly string[]) =>
    actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  const expectedNetwork = `${owned.project}_default`;
  const expectedVolume = `${owned.project}_postgres-data`;
  const namesWithProject = (resources: Record<string, Record<string, string>>) =>
    Object.entries(resources)
      .filter(([, labels]) => labels['com.docker.compose.project'] === owned.project)
      .map(([name]) => name)
      .join('\n');
  const namesMatching = (resources: Record<string, Record<string, string>>, name: string) =>
    Object.keys(resources).filter((candidate) => candidate.includes(name)).join('\n');
  return {
    run(argumentsToRun) {
      if (same(argumentsToRun.slice(0, composePrefix.length), composePrefix) && argumentsToRun.includes('up')) {
        state.networks[expectedNetwork] ??= exactResourceLabels(owned);
        state.volumes[expectedVolume] ??= exactResourceLabels(owned);
        state.startupAttempts += 1;
        throw new Error('[plan6b-upgrade] docker compose up exited with 42');
      }
      if (
        same(argumentsToRun, [...composePrefix, 'down', '--volumes']) ||
        same(argumentsToRun, [...composePrefix, 'down', '--volumes', '--remove-orphans'])
      ) {
        state.downCalled = true;
        state.downArguments = [...argumentsToRun];
        delete state.networks[expectedNetwork];
        if (!state.retainVolumeAfterDown) delete state.volumes[expectedVolume];
        return;
      }
      throw new Error(`unexpected fake Docker run: ${argumentsToRun.join(' ')}`);
    },
    capture(argumentsToCapture) {
      if (same(argumentsToCapture, [...composePrefix, 'ps', '--all', '--quiet', 'postgres'])) {
        return '';
      }
      if (same(argumentsToCapture, [
        'ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${owned.project}`
      ])) return '';
      if (same(argumentsToCapture, [
        'ps', '--all', '--filter', `name=${owned.project}-postgres-1`, '--format', '{{.Names}}'
      ])) return state.downCalled ? (state.containerNamesAfterDown ?? []).join('\n') : '';
      if (same(argumentsToCapture, [
        'network', 'ls', '--filter', `label=com.docker.compose.project=${owned.project}`,
        '--format', '{{.Name}}'
      ])) {
        state.networkNameFormatUsed = true;
        return namesWithProject(state.networks);
      }
      if (same(argumentsToCapture, [
        'volume', 'ls', '--filter', `label=com.docker.compose.project=${owned.project}`,
        '--format', '{{.Name}}'
      ])) return namesWithProject(state.volumes);
      if (same(argumentsToCapture, [
        'volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${owned.project}`
      ])) return namesWithProject(state.volumes);
      if (same(argumentsToCapture, [
        'network', 'ls', '--filter', `name=${expectedNetwork}`, '--format', '{{.Name}}'
      ])) return namesMatching(state.networks, expectedNetwork);
      if (same(argumentsToCapture, [
        'volume', 'ls', '--filter', `name=${expectedVolume}`, '--format', '{{.Name}}'
      ])) return namesMatching(state.volumes, expectedVolume);
      if (same(argumentsToCapture, ['network', 'inspect', expectedNetwork])) {
        return JSON.stringify([{
          Name: expectedNetwork,
          Labels: state.networks[expectedNetwork]
        }]);
      }
      if (same(argumentsToCapture, ['volume', 'inspect', expectedVolume])) {
        return JSON.stringify([{
          Name: expectedVolume,
          Labels: state.volumes[expectedVolume]
        }]);
      }
      throw new Error(`unexpected fake Docker capture: ${argumentsToCapture.join(' ')}`);
    }
  };
}

describe('Plan 6B disposable upgrade database ownership', () => {
  it('scrubs ambient Stripe secrets and forces provider execution off for child commands', async () => {
    const source = await readFile(
      new URL('./with-plan6b-upgrade-database.ts', import.meta.url),
      'utf8'
    );
    const childEnvironmentSource = source.match(
      /function childEnvironment\(owned: OwnedRunManifest\): NodeJS\.ProcessEnv \{[\s\S]*?\n\}/u
    )?.[0];

    expect(childEnvironmentSource).toBeDefined();
    expect(childEnvironmentSource).not.toContain('...process.env');
    expect(childEnvironmentSource).toContain('...withoutStripeProviderSecrets(process.env)');
    expect(childEnvironmentSource).toContain("STRIPE_ENABLED: 'false'");
    expect(childEnvironmentSource).toContain("STRIPE_TEST_FIXTURE_MODE: 'false'");
    expect(childEnvironmentSource).toContain("STRIPE_LIVE_MODE: 'false'");
    expect(childEnvironmentSource).toContain("STRIPE_AUTOMATIC_TAX_ENABLED: 'false'");

    expect(withoutStripeProviderSecrets({
      PATH: 'safe-path',
      sTrIpE_sEcReT_kEy: 'sk_live_canary',
      STRIPE_secret_KEY_file: '/run/secrets/stripe-key-canary',
      stripe_WEBHOOK_secret: 'whsec_canary',
      Stripe_Webhook_Secret_File: '/run/secrets/stripe-webhook-canary'
    })).toEqual({ PATH: 'safe-path' });
  });

  it('publishes the preselected ephemeral port explicitly on loopback', () => {
    const source = renderOwnedCompose(manifest());

    expect(source).toContain('- "127.0.0.1:49152:5432"');
    expect(source).toContain('- postgres-data:/var/lib/postgresql');
    expect(source).not.toContain('postgres-data:/var/lib/postgresql/data');
    expect(source).not.toContain('- "127.0.0.1::5432"');
    expect(source).not.toContain('published: "0"');
  });

  it('accepts only a loopback-published ephemeral PostgreSQL endpoint', () => {
    expect(parseLoopbackPublishedEndpoint('127.0.0.1:49152')).toEqual({
      host: '127.0.0.1',
      port: 49152
    });
    expect(() => parseLoopbackPublishedEndpoint('0.0.0.0:49152')).toThrow(/loopback/u);
    expect(() => parseLoopbackPublishedEndpoint('db.example.test:5432')).toThrow(/loopback/u);
    expect(() => parseLoopbackPublishedEndpoint('127.0.0.1:5432')).toThrow(/ephemeral/u);
  });

  it('refuses a prefixed database on an unrelated container', () => {
    const observed = observation();
    observed.containerId = 'b'.repeat(64);

    expect(() => validateOwnedCleanup(manifest(), observed)).toThrow(/container ID/u);
  });

  it.each([
    ['project label', 'com.docker.compose.project', 'another-project'],
    ['run label', 'com.paleorbit.plan6b-upgrade.run', 'another-run'],
    ['owner label', 'com.paleorbit.plan6b-upgrade.owner', 'another-owner'],
    ['database label', 'com.paleorbit.plan6b-upgrade.database', 'another_database'],
    ['user label', 'com.paleorbit.plan6b-upgrade.user', 'another_user']
  ])('refuses a mismatched %s', (_label, key, value) => {
    const observed = observation();
    observed.labels[key] = value;

    expect(() => validateOwnedCleanup(manifest(), observed)).toThrow(/label/u);
  });

  it('refuses mismatched generated database and user identities', () => {
    const databaseMismatch = observation();
    databaseMismatch.containerEnvironment.POSTGRES_DB = 'plan6b_prefixed_but_unowned';
    expect(() => validateOwnedCleanup(manifest(), databaseMismatch)).toThrow(/database identity/u);

    const userMismatch = observation();
    userMismatch.containerEnvironment.POSTGRES_USER = 'plan6b_prefixed_but_unowned';
    expect(() => validateOwnedCleanup(manifest(), userMismatch)).toThrow(/user identity/u);
  });

  it('refuses cleanup without the exact owned-run manifest', () => {
    expect(() => validateOwnedCleanup(undefined, observation())).toThrow(/manifest/u);
  });

  it.each(['', '*', 'pale-orbit-plan6b-*', 'default'])('refuses broad cleanup project %j', (project) => {
    const observed = observation();
    observed.cleanupProject = project;

    expect(() => validateOwnedCleanup(manifest(), observed)).toThrow(/cleanup project/u);
  });

  it('refuses a nonloopback cleanup observation even when names and labels match', () => {
    const observed = observation();
    observed.host = '192.0.2.10';

    expect(() => validateOwnedCleanup(manifest(), observed)).toThrow(/loopback/u);
  });

  it('permits exact cleanup after startup produced an owned but unbound container', () => {
    const owned = manifest();
    const observed = observation(owned);
    observed.host = null;
    observed.port = null;

    expect(() => validateOwnedStartupCleanup(owned, observed)).not.toThrow();
  });

  it('refuses failed-startup cleanup when the container was externally published', () => {
    const owned = manifest();
    const observed = observation(owned);
    observed.host = '0.0.0.0';
    observed.port = 49152;

    expect(() => validateOwnedStartupCleanup(owned, observed)).toThrow(/unbound/u);
  });

  it('runs exact cleanup after start, migration, or child-command failure', async () => {
    for (const failingOperation of ['start', 'applyLegacyMigrations', 'runChild'] as const) {
      const owned = manifest();
      const cleanup = vi.fn().mockResolvedValue(undefined);
      const operations = {
        start: vi.fn().mockResolvedValue(undefined),
        applyLegacyMigrations: vi.fn().mockResolvedValue(undefined),
        runChild: vi.fn().mockResolvedValue(undefined),
        cleanup
      };
      operations[failingOperation].mockRejectedValueOnce(new Error(`failed ${failingOperation}`));

      await expect(executeOwnedUpgradeRun(owned, operations)).rejects.toThrow(
        `failed ${failingOperation}`
      );
      expect(cleanup).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledWith(owned);
    }
  });

  it('preserves the primary operation error when exact cleanup also fails', async () => {
    const primary = new Error('failed startup');
    const cleanup = new Error('failed cleanup');
    let thrown: unknown;

    try {
      await executeOwnedUpgradeRun(manifest(), {
        start: vi.fn().mockRejectedValue(primary),
        applyLegacyMigrations: vi.fn(),
        runChild: vi.fn(),
        cleanup: vi.fn().mockRejectedValue(cleanup)
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([primary, cleanup]);
    expect((thrown as AggregateError).cause).toBe(cleanup);
  });

  it.each([
    ['ephemeral port selection', 'port'],
    ['owned manifest write', 'write']
  ] as const)('removes the exact materialized temp directory after %s fails', async (_label, failAt) => {
    let tempDirectory = '';
    let passwordBearingArtifact = '';
    let passwordBearingContents = '';
    const removeTempDirectory = vi.fn(async (path: string) => {
      tempDirectory = path;
      await rm(path, { recursive: true, force: false });
    });

    await expect(createOwnedManifest({
      async selectPort() {
        if (failAt === 'port') throw new Error('private injected port failure');
        return 49152;
      },
      async writeTextFile(path, contents) {
        if (path.endsWith('compose.plan6b.yaml')) {
          passwordBearingArtifact = path;
          passwordBearingContents = contents;
          await writeFile(path, contents, 'utf8');
          return;
        }
        if (failAt === 'write') throw new Error('private injected write failure');
        await writeFile(path, contents, 'utf8');
      },
      removeTempDirectory
    })).rejects.toThrow(/could not materialize/u);

    expect(removeTempDirectory).toHaveBeenCalledExactlyOnceWith(tempDirectory);
    if (passwordBearingArtifact) {
      expect(passwordBearingContents).toMatch(/POSTGRES_PASSWORD: [a-f0-9]{48}/u);
      expect(await readFile(passwordBearingArtifact, 'utf8').catch(() => null)).toBeNull();
    }
    await expect(stat(tempDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not allow injected setup to substitute a prefix-shaped sibling directory', async () => {
    const suppliedDirectory = join(tmpdir(), 'pale-orbit-plan6b-upgrade-shared');
    const createTempDirectory = vi.fn(async () => suppliedDirectory);
    const removedPaths: string[] = [];
    const dependencies = {
      createTempDirectory,
      selectPort: vi.fn(async () => {
        throw new Error('private injected port failure');
      }),
      writeTextFile: vi.fn(async () => undefined),
      async removeTempDirectory(path) {
        removedPaths.push(path);
        if (path !== suppliedDirectory) await rm(path, { recursive: true, force: false });
      }
    };

    await expect(createOwnedManifest(dependencies)).rejects.toThrow(/materialize/u);

    expect(createTempDirectory).not.toHaveBeenCalled();
    expect(removedPaths).toHaveLength(1);
    expect(removedPaths[0]).not.toBe(suppliedDirectory);
    await expect(stat(removedPaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans only exact owned Compose resources when startup fails before container creation', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'pale-orbit-plan6b-upgrade-'));
    const owned: OwnedRunManifest = {
      ...manifest(),
      containerId: '',
      tempDirectory,
      composeFile: join(tempDirectory, 'compose.plan6b.yaml'),
      manifestFile: join(tempDirectory, 'owned-run.json')
    };
    const state: FakeDockerState = {
      downCalled: false,
      downArguments: null,
      networkNameFormatUsed: false,
      networks: {
        'unrelated-network': { 'com.docker.compose.project': 'unrelated-project' }
      },
      startupAttempts: 0,
      volumes: {
        'unrelated-volume': { 'com.docker.compose.project': 'unrelated-project' }
      }
    };
    await writeFile(owned.composeFile, renderOwnedCompose(owned), 'utf8');
    await writeFile(owned.manifestFile, `${JSON.stringify(owned, null, 2)}\n`, 'utf8');
    const docker = partialStartupDocker(owned, state);

    await expect(executeOwnedUpgradeRun(owned, {
      start: (value) => startOwnedDatabase(value, docker),
      applyLegacyMigrations: vi.fn(),
      runChild: vi.fn(),
      cleanup: (value) => cleanupOwnedDatabase(value, docker)
    })).rejects.toThrow(/exited with 42/u);

    expect(state.startupAttempts).toBe(1);
    expect(state.networkNameFormatUsed).toBe(true);
    expect(state.downCalled).toBe(true);
    expect(state.downArguments).toEqual([
      'compose', '--project-name', owned.project, '--file', owned.composeFile,
      'down', '--volumes'
    ]);
    expect(state.networks).toEqual({
      'unrelated-network': { 'com.docker.compose.project': 'unrelated-project' }
    });
    expect(state.volumes).toEqual({
      'unrelated-volume': { 'com.docker.compose.project': 'unrelated-project' }
    });
    expect(await readFile(owned.composeFile, 'utf8').catch(() => null)).toBeNull();
    expect(await readFile(owned.manifestFile, 'utf8').catch(() => null)).toBeNull();
  });

  it('refuses a same-name volume whose missing ownership labels hide it from project lookup', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'pale-orbit-plan6b-upgrade-'));
    const owned: OwnedRunManifest = {
      ...manifest(),
      containerId: '',
      tempDirectory,
      composeFile: join(tempDirectory, 'compose.plan6b.yaml'),
      manifestFile: join(tempDirectory, 'owned-run.json')
    };
    const expectedVolume = `${owned.project}_postgres-data`;
    const state: FakeDockerState = {
      downCalled: false,
      downArguments: null,
      networkNameFormatUsed: false,
      networks: {
        'unrelated-network': { 'com.docker.compose.project': 'unrelated-project' }
      },
      startupAttempts: 0,
      volumes: {
        [expectedVolume]: {},
        'unrelated-volume': { 'com.docker.compose.project': 'unrelated-project' }
      }
    };
    await writeFile(owned.composeFile, renderOwnedCompose(owned), 'utf8');
    await writeFile(owned.manifestFile, `${JSON.stringify(owned, null, 2)}\n`, 'utf8');

    try {
      await expect(cleanupOwnedDatabase(owned, partialStartupDocker(owned, state)))
        .rejects.toThrow(/volume label/u);
      expect(state.downCalled).toBe(false);
      expect(state.networks).toHaveProperty('unrelated-network');
      expect(state.volumes).toHaveProperty(expectedVolume);
      expect(state.volumes).toHaveProperty('unrelated-volume');
      expect(await readFile(owned.composeFile, 'utf8')).toContain('services:');
      expect(await readFile(owned.manifestFile, 'utf8')).toContain(owned.project);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('fails cleanup when Compose down succeeds but an owned volume remains', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'pale-orbit-plan6b-upgrade-'));
    const owned: OwnedRunManifest = {
      ...manifest(),
      containerId: '',
      tempDirectory,
      composeFile: join(tempDirectory, 'compose.plan6b.yaml'),
      manifestFile: join(tempDirectory, 'owned-run.json')
    };
    const expectedVolume = `${owned.project}_postgres-data`;
    const state: FakeDockerState = {
      downCalled: false,
      downArguments: null,
      networkNameFormatUsed: false,
      networks: {},
      retainVolumeAfterDown: true,
      startupAttempts: 0,
      volumes: { [expectedVolume]: exactResourceLabels(owned) }
    };
    await writeFile(owned.composeFile, renderOwnedCompose(owned), 'utf8');
    await writeFile(owned.manifestFile, `${JSON.stringify(owned, null, 2)}\n`, 'utf8');

    try {
      await expect(cleanupOwnedDatabase(owned, partialStartupDocker(owned, state)))
        .rejects.toThrow(/resource|volume|cleanup/u);
      expect(state.downCalled).toBe(true);
      expect(state.volumes).toHaveProperty(expectedVolume);
      expect(await readFile(owned.manifestFile, 'utf8')).toContain(owned.project);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('fails cleanup when an exact-name container remains without project labels', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'pale-orbit-plan6b-upgrade-'));
    const owned: OwnedRunManifest = {
      ...manifest(),
      containerId: '',
      tempDirectory,
      composeFile: join(tempDirectory, 'compose.plan6b.yaml'),
      manifestFile: join(tempDirectory, 'owned-run.json')
    };
    const state: FakeDockerState = {
      containerNamesAfterDown: [`${owned.project}-postgres-1`],
      downCalled: false,
      downArguments: null,
      networkNameFormatUsed: false,
      networks: {},
      startupAttempts: 0,
      volumes: {}
    };
    await writeFile(owned.composeFile, renderOwnedCompose(owned), 'utf8');
    await writeFile(owned.manifestFile, `${JSON.stringify(owned, null, 2)}\n`, 'utf8');

    try {
      await expect(cleanupOwnedDatabase(owned, partialStartupDocker(owned, state)))
        .rejects.toThrow(/container|cleanup/u);
      expect(state.downCalled).toBe(true);
      expect(await readFile(owned.manifestFile, 'utf8')).toContain(owned.project);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
