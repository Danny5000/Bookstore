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
  it('keeps historical rollback proofs while repaired and valid flows reach 0015 once', async () => {
    const [journalText, fixture, packageText] = await Promise.all([
      readFile('drizzle/meta/_journal.json', 'utf8'),
      readFile('tests/integration/financial-migration.test.ts', 'utf8'),
      readFile('package.json', 'utf8')
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const block = (start: string, end: string): string => {
      const startIndex = fixture.indexOf(start);
      const endIndex = fixture.indexOf(end, startIndex + start.length);
      expect(startIndex, start).toBeGreaterThanOrEqual(0);
      expect(endIndex, end).toBeGreaterThan(startIndex);
      return fixture.slice(startIndex, endIndex);
    };

    expect(journal.entries.map(({ idx }) => idx)).toEqual(
      Array.from({ length: 16 }, (_value, idx) => idx)
    );
    expect(journal.entries.at(-1)).toEqual(expect.objectContaining({
      idx: 15,
      tag: '0015_plan7a_operations_authority'
    }));
    const packageManifest = JSON.parse(packageText) as { scripts: Record<string, string> };
    expect(packageManifest.scripts['test:plan6b-upgrade']).toBe(
      'tsx scripts/with-plan6b-upgrade-database.ts --phase-command tsx tests/integration/financial-migration.test.ts'
    );
    expect(packageManifest.scripts['smoke:plan6b'])
      .toBe('node --import tsx scripts/plan6b-production-smoke.ts');
    expect(Object.hasOwn(packageManifest.scripts, 'smoke:plan6b-i')).toBe(false);
    expect(fixture).toContain(
      'maxMigrationIndex: 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15'
    );
    const plan7aFixturePreparation = block(
      'async function prepareCommitted0014Fixture(',
      'async function seedPlan7aAtomicityHistory('
    );
    expect(plan7aFixturePreparation).toMatch(
      /try \{\s+await createPlan6biiAttestedRoles\(pool, 0b111\);/u
    );

    const repairedHeadCall = 'await runRepairedFixtureThroughPlan6biiHead(pool';
    for (const [start, end] of [
      ['async function runValidFixture(', 'async function runInvalidFixture('],
      ['async function runFixedGroupAttributePreflightFixture(',
        'async function expectUnexpectedNamedAuthorityFailure('],
      ['async function runUnexpectedNamedAuthorityPreflightFixture(',
        'async function assertFailed0011LeftNoPartialAuthority('],
      ['async function runStorageCleanupAuthorityPreflightFixture(',
        'const PLAN6BII_ROUTINES ='],
      ['async function runPostPlan6BInvalidFixture(', 'async function expect0010Failure('],
      ['async function runClaimAuthorityInvalidFixture(',
        'async function runClaimIdentityAuthorityInvalidFixture('],
      ['async function runClaimIdentityAuthorityInvalidFixture(',
        'async function runEntitlementProjectionInvalidFixture('],
      ['async function runEntitlementProjectionInvalidFixture(', 'async function main(']
    ] as const) expect(block(start, end), start).toContain(repairedHeadCall);

    expect(block(
      'async function runFixedGroupAttributePreflightFixture(',
      'async function expectUnexpectedNamedAuthorityFailure('
    )).toContain("rollback does not advance the 0009 journal");
    expect(block(
      'async function expect0010Failure(',
      'async function runClaimAuthorityInvalidFixture('
    )).toContain("rollback does not advance the 0010 journal");
    expect(block(
      'async function assertFailed0011LeftNoPartialAuthority(',
      'async function runStorageCleanupAuthorityPreflightFixture('
    )).toContain("rollback does not advance the 0011 journal");

    const headHelper = block(
      'async function runRepairedFixtureThroughPlan6biiHead(',
      'const REPORTING_CORRECTION_RESOLVER ='
    );
    expect(headHelper).toContain('createMigrationFolderThrough(14)');
    expect(headHelper).toContain('createMigrationFolderThrough(15)');
    expect(headHelper).toContain("equal(await migrationCount(pool), 16");
    expect(headHelper.match(/runCommittedPlan6biiAttestedMigration\(/gu)).toHaveLength(8);
    expect(headHelper).toContain('second 0012 migration pass is a no-op');
    expect(headHelper).toContain('second 0013 migration pass is a no-op');
    expect(headHelper).toContain('second 0014 migration pass is a no-op');
    expect(headHelper).toContain('second 0015 migration pass is a no-op');

    const correctionAuthorityHelper = block(
      'const REPORTING_CORRECTION_RESOLVER =',
      'type Plan6biiIdentityPrepare ='
    );
    for (const witness of [
      '0013 routine-name collision',
      '0013 prerequisite owner drift',
      '0013 prerequisite security drift',
      '0013 prerequisite search_path drift',
      '0013 prerequisite ACL drift',
      '0013 issue-trigger drift'
    ]) expect(correctionAuthorityHelper).toContain(witness);
    expect(correctionAuthorityHelper).toContain(
      'rollback leaves no 0013 resolver or ACL'
    );
    expect(correctionAuthorityHelper).toContain(
      'a second 0013 migrator pass is a no-op'
    );

    const plan7aUpgradeHarness = block(
      'type Plan7aNamespaceCollisionFixture =',
      'async function runValidFixture('
    );
    for (const witness of [
      'Plan 7A test-only late migration fault',
      'test-only late fault is inserted before commit',
      'late 0015 rollback leaves the journal at exact 0014',
      'late 0015 rollback leaves every exact 0014 journal row unchanged',
      'late 0015 rollback removes every 0015 object',
      'late 0015 rollback restores both historical guards exactly',
      'late 0015 rollback preserves historical data exactly',
      'late 0015 rollback preserves the complete 0014 catalog',
      'clean 0015 applies exactly once',
      'a second 0015 migrator pass is a no-op',
      'Plan 7A operations namespace is not empty',
      'namespace collision rollback leaves the journal at exact 0014',
      'namespace collision rollback leaves every exact 0014 journal row unchanged',
      'namespace collision rollback removes every 0015 object',
      'namespace collision rollback preserves the complete 0014 catalog',
      'namespace collision rollback preserves the seeded historical row exactly',
      'jobs is the first protected-table lock acquisition',
      'audit lock is attempted only after the jobs lock is granted',
      'migration did not hold both protected locks at the barrier',
      'writer did not visibly wait behind the migration',
      'resumes against the closed 0015 guard',
      'Plan 7A operations authority relation baseline is not canonical',
      'Plan 7A predecessor ACL inventory is not canonical',
      'leaves the committed predecessor drift unchanged',
      'exposes the exact noncanonical migration namespace',
      'Plan 7A operations authority search path is not canonical',
      'restores the canonical migration search path without residue',
      'leaves the complete 0014 catalog unchanged',
      'Plan 7A operations authority object namespace is not canonical',
      'create type drizzle."_operations_job_retry_claim_state"',
      'create type drizzle."operations_job_retry_commands"',
      'create type drizzle."_operations_job_retry_commands"',
      'create index "plan7a_operations_retry_claims_command_unique"',
      'generated object collision rollback preserves the seeded catalog exactly',
      'generated object collision rollback leaves every exact 0014 journal row unchanged',
      'generated object collision rollback removes every 0015 object',
      'Plan 7A operations authority ACL postflight failed',
      'FROM CURRENT_USER;',
      'test-only owner ACL drift is inserted immediately before postflight',
      'owner ACL postflight rollback preserves the complete 0014 catalog',
      'owner ACL postflight rollback leaves every exact 0014 journal row unchanged',
      'owner ACL postflight rollback removes every 0015 object',
      'Plan 7A operations authority trigger postflight failed',
      'DROP TRIGGER "audit_events_plan6b_web_insert_guard"',
      'test-only audit trigger drift is inserted immediately before postflight',
      'audit trigger postflight rollback preserves the complete 0014 catalog',
      'audit trigger postflight rollback leaves every exact 0014 journal row unchanged',
      'audit trigger postflight rollback restores both historical guards exactly',
      'audit trigger postflight rollback removes every 0015 object'
    ]) expect(plan7aUpgradeHarness).toContain(witness);
    expect(plan7aUpgradeHarness).toContain(
      "equal(postgresError.code, '55000', 'namespace collision uses the fixed SQLSTATE')"
    );
    const namespaceRaceHarness = block(
      'async function runPlan7aNamespaceRaceFixture(',
      'async function runPlan7aPredecessorDriftFixture('
    );
    expect(namespaceRaceHarness).toContain('let workerPool: Pool | undefined;');
    expect(namespaceRaceHarness).toContain('let migrationOperation: Promise<void> | undefined;');
    expect(namespaceRaceHarness).toContain('let mutationOperation: Promise<unknown> | undefined;');
    expect(namespaceRaceHarness.match(
      /migrationOperation = runCommittedPlan6biiAttestedMigration\(/gu
    )).toHaveLength(2);
    expect(namespaceRaceHarness).toContain(
      'await migrationOperation.catch(() => undefined);'
    );
    expect(namespaceRaceHarness).toContain(
      'await mutationOperation.catch(() => undefined);'
    );
    expect(namespaceRaceHarness.indexOf('workerPool = await createPlan7aWorkerPool(pool);'))
      .toBeGreaterThan(namespaceRaceHarness.indexOf('try {'));
    for (const fixtureName of [
      'plan7a-upgrade-atomicity',
      'plan7a-operations-job-type-collision',
      'plan7a-operations-deduplication-prefix-collision',
      'plan7a-operations-audit-action-prefix-collision',
      'plan7a-operations-resource-type-collision',
      'plan7a-operations-prelock-job-type',
      'plan7a-operations-prelock-deduplication-prefix',
      'plan7a-operations-prelock-audit-action-prefix',
      'plan7a-operations-prelock-resource-type',
      'plan7a-operations-postlock-job-type',
      'plan7a-operations-postlock-deduplication-prefix',
      'plan7a-operations-postlock-audit-action-prefix',
      'plan7a-operations-postlock-resource-type',
      'plan7a-predecessor-jobs-trigger-drift',
      'plan7a-predecessor-direct-acl-drift',
      'plan7a-predecessor-jobs-index-drift',
      'plan7a-predecessor-default-acl-drift',
      'plan7a-generated-enum-array-type-collision',
      'plan7a-generated-table-row-type-collision',
      'plan7a-generated-table-array-type-collision',
      'plan7a-generated-index-name-collision',
      'plan7a-postflight-owner-acl-drift',
      'plan7a-postflight-audit-trigger-drift',
      'plan7a-postflight-column-acl-drift',
      'plan7a-postflight-claims-trigger-drift',
      'plan7a-postflight-generated-storage-drift',
      'plan7a-postflight-default-acl-drift',
      'plan7a-postflight-historical-inheritance-drift',
      'plan7a-noncanonical-migration-search-path'
    ]) expect(fixture).toContain(`'${fixtureName}'`);

    const mainHarness = block('async function main(): Promise<void> {', 'const entryPoint =');
    expect(mainHarness).toContain('...PLAN7A_MIGRATION_CONTEXT_DRIFT_FIXTURES');
    expect(mainHarness).toContain('...PLAN7A_GENERATED_OBJECT_COLLISION_FIXTURES');
    expect(
      mainHarness.match(/isPlan7aMigrationContextDriftFixture\(rawFixture\)/gu)
    ).toHaveLength(2);
    expect(mainHarness).toContain(
      `else if (isPlan7aMigrationContextDriftFixture(rawFixture)) {
      await runPlan7aMigrationContextDriftFixture(pool, rawFixture);`
    );
    expect(mainHarness).toContain(
      `else if (isPlan7aGeneratedObjectCollisionFixture(rawFixture)) {
      await runPlan7aGeneratedObjectCollisionFixture(pool, rawFixture);`
    );
    expect(mainHarness).toContain(
      `else if (rawFixture === 'plan7a-postflight-owner-acl-drift') {
      await runPlan7aPostflightOwnerAclDriftFixture(pool);`
    );
    expect(mainHarness).toContain(
      `else if (rawFixture === 'plan7a-postflight-audit-trigger-drift') {
      await runPlan7aPostflightAuditTriggerDriftFixture(pool);`
    );
    expect(mainHarness).toContain(
      `else if (rawFixture === 'plan7a-postflight-column-acl-drift') {
      await runPlan7aPostflightColumnAclDriftFixture(pool);`
    );
    expect(mainHarness).toContain(
      `else if (rawFixture === 'plan7a-postflight-claims-trigger-drift') {
      await runPlan7aPostflightClaimsTriggerDriftFixture(pool);`
    );
    expect(mainHarness).toContain(
      `else if (rawFixture === 'plan7a-postflight-generated-storage-drift') {
      await runPlan7aPostflightGeneratedStorageDriftFixture(pool);`
    );
    expect(mainHarness).toContain(
      `else if (rawFixture === 'plan7a-postflight-default-acl-drift') {
      await runPlan7aPostflightDefaultAclDriftFixture(pool);`
    );
    expect(mainHarness).toContain(
      `else if (rawFixture === 'plan7a-postflight-historical-inheritance-drift') {
      await runPlan7aPostflightHistoricalInheritanceDriftFixture(pool);`
    );
  });

  it('refuses a foreign exact-name volume before Compose can mount or mutate it', async () => {
    const owned = { ...manifest(), containerId: '' };
    const exactVolume = `${owned.project}_postgres-data`;
    const docker: DockerCommandRuntime = {
      run: vi.fn(() => { throw new Error('Docker mutation must not run'); }),
      capture: vi.fn((args) => (
        args[0] === 'volume' && args.includes(`name=${exactVolume}`) ? exactVolume : ''
      ))
    };

    await expect(startOwnedDatabase(owned, docker)).rejects.toThrow(/exact-name|collid/iu);
    expect(docker.run).not.toHaveBeenCalled();
  });

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
