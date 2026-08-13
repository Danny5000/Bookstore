import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ProductionSmokeManifest {
  readonly version: 1;
  readonly runId: string;
  readonly ownershipToken: string;
  readonly project: string;
  readonly imageTag: string;
  readonly tempDirectory: string;
  readonly overrideFile: string;
  readonly manifestFile: string;
  readonly secretDirectory: string;
  readonly httpHost: '127.0.0.1';
  readonly httpsHost: '127.0.0.1';
  readonly httpPort: number;
  readonly httpsPort: number;
}

export interface DisabledRuntimeEvidence {
  readonly storefrontStatus: number;
  readonly commerceStatus: number;
  readonly appStripeEnabled: boolean;
  readonly workerStripeEnabled: boolean;
  readonly appFixtureMode: boolean;
  readonly workerFixtureMode: boolean;
  readonly appHasStripeSecret: boolean;
  readonly workerHasStripeSecret: boolean;
  readonly postgresHostPublished: boolean;
  readonly workerReady: boolean;
  readonly providerBackedJobCount: number;
  readonly classificationRootCount: number;
  readonly classificationRootCompletedCount: number;
  readonly classificationRootUnsafeCount: number;
  readonly providerLedgerSubjectCount: number;
}

export interface ProductionImageEvidence {
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface VerifiedProductionImageLease {
  readonly version: 1;
  readonly sourceTag: string;
  readonly productionRunId: string;
  readonly productionOwnershipToken: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

export type ProductionImageLeaseConsumer = (
  lease: VerifiedProductionImageLease
) => Promise<void>;

export interface ProductionSmokeOperations {
  build(manifest: ProductionSmokeManifest): Promise<void>;
  revalidatePorts(manifest: ProductionSmokeManifest): Promise<void>;
  startDatabase(manifest: ProductionSmokeManifest): Promise<void>;
  migrate(manifest: ProductionSmokeManifest): Promise<void>;
  snapshotMigrationState(manifest: ProductionSmokeManifest): Promise<string>;
  startRuntime(manifest: ProductionSmokeManifest): Promise<void>;
  inspectDisabledRuntime(manifest: ProductionSmokeManifest): Promise<DisabledRuntimeEvidence>;
  inspectImage(manifest: ProductionSmokeManifest): Promise<ProductionImageEvidence>;
  cleanup(manifest: ProductionSmokeManifest): Promise<void>;
}

export interface ProductionSmokeCommandResult {
  readonly status: number;
  readonly stdout: string;
}

export interface ProductionSmokeCommandRuntime {
  run(argumentsToRun: readonly string[], environment: NodeJS.ProcessEnv): Promise<void>;
  capture(
    argumentsToCapture: readonly string[],
    environment: NodeJS.ProcessEnv,
    allowFailure?: boolean
  ): Promise<ProductionSmokeCommandResult>;
}

export interface ProductionSmokeDockerDependencies {
  readonly command: ProductionSmokeCommandRuntime;
  readonly environment: NodeJS.ProcessEnv;
  readonly assertPortAvailable: (host: '127.0.0.1', port: number) => Promise<void>;
  readonly requestStatus: (url: string) => Promise<number>;
  readonly wait: (milliseconds: number) => Promise<void>;
}

export interface ProductionSmokeRunDependencies {
  readonly createManifest: () => Promise<ProductionSmokeManifest>;
  readonly createOperations: (
    manifest: ProductionSmokeManifest
  ) => Promise<ProductionSmokeOperations>;
  readonly cleanupSetupFailure: (manifest: ProductionSmokeManifest) => Promise<void>;
  readonly report: (
    message: '[plan6b-smoke] complete',
    evidence: {
      readonly project: string;
      readonly imageDigest: string;
      readonly imageSizeBytes: number;
    }
  ) => void;
}

const RUN_PREFIX = 'pale-orbit-plan6b-smoke-';
const TEMP_PREFIX = join(resolve(tmpdir()), RUN_PREFIX);
const MANIFEST_KEYS = [
  'version',
  'runId',
  'ownershipToken',
  'project',
  'imageTag',
  'tempDirectory',
  'overrideFile',
  'manifestFile',
  'secretDirectory',
  'httpHost',
  'httpsHost',
  'httpPort',
  'httpsPort'
] as const;
const MIGRATION_EVIDENCE_KEYS = [
  'migrationCount',
  'migrationMax',
  'credentialAuthorityCount',
  'entitlementGrantCount',
  'refundComponentCount',
  'financialIssueCount',
  'projectionVersionCount',
  'activeClassifierVersion',
  'activeAllocationAlgorithmVersion'
] as const;
const IMAGE_LEASE_KEYS = [
  'version',
  'sourceTag',
  'productionRunId',
  'productionOwnershipToken',
  'digest',
  'sizeBytes'
] as const;

function smokeError(message: string): Error {
  return new Error(`[plan6b-smoke] ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw smokeError(message);
}

function exactOwnKeys(value: object, expected: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  assert(
    actual.length === expected.length &&
      expected.every((key) => Object.hasOwn(value, key)) &&
      actual.every((key) => typeof key === 'string' && expected.includes(key)),
    'owned-run manifest shape is invalid'
  );
}

function exactPath(actual: string, expected: string, description: string): void {
  assert(resolve(actual) === resolve(expected), `${description} is outside the owned run`);
}

function safePort(value: number): boolean {
  return Number.isInteger(value) && value >= 1024 && value <= 65_535 && value !== 80 && value !== 443;
}

export function validateProductionSmokeManifest(manifest: ProductionSmokeManifest): void {
  assert(typeof manifest === 'object' && manifest !== null, 'owned-run manifest is invalid');
  exactOwnKeys(manifest, MANIFEST_KEYS);
  assert(manifest.version === 1, 'owned-run manifest version is invalid');
  assert(/^[a-f0-9]{16}$/u.test(manifest.runId), 'owned-run manifest run ID is invalid');
  assert(
    /^[a-f0-9]{32}$/u.test(manifest.ownershipToken),
    'owned-run manifest ownership token is invalid'
  );
  assert(
    manifest.project === `${RUN_PREFIX}${manifest.runId}`,
    'owned-run manifest project is invalid'
  );
  assert(
    manifest.imageTag === `pale-orbit:plan6b-i-smoke-${manifest.runId}`,
    'owned-run manifest image tag is invalid'
  );
  assert(manifest.httpHost === '127.0.0.1', 'HTTP endpoint is not loopback');
  assert(manifest.httpsHost === '127.0.0.1', 'HTTPS endpoint is not loopback');
  assert(safePort(manifest.httpPort), 'HTTP port is not safely ephemeral');
  assert(safePort(manifest.httpsPort), 'HTTPS port is not safely ephemeral');
  assert(manifest.httpPort !== manifest.httpsPort, 'owned ports collide');
  const expectedDirectory = join(resolve(tmpdir()), `${RUN_PREFIX}${manifest.runId}`);
  assert(
    resolve(manifest.tempDirectory) === expectedDirectory &&
      resolve(manifest.tempDirectory).startsWith(TEMP_PREFIX) &&
      basename(manifest.tempDirectory) === `${RUN_PREFIX}${manifest.runId}`,
    'owned-run temp directory is invalid'
  );
  exactPath(manifest.overrideFile, join(expectedDirectory, 'compose.override.yaml'), 'override file');
  exactPath(manifest.manifestFile, join(expectedDirectory, 'owned-run.json'), 'manifest file');
  exactPath(manifest.secretDirectory, join(expectedDirectory, 'secrets'), 'secret directory');
}

export function renderProductionSmokeOverride(manifest: ProductionSmokeManifest): string {
  validateProductionSmokeManifest(manifest);
  const labels = `com.paleorbit.plan6b-smoke.run: ${manifest.runId}
      com.paleorbit.plan6b-smoke.owner: ${manifest.ownershipToken}`;
  return `services:
  app:
    image: ${manifest.imageTag}
    labels:
      ${labels}
  worker:
    image: ${manifest.imageTag}
    labels:
      ${labels}
  migrate:
    image: ${manifest.imageTag}
    labels:
      ${labels}
  postgres:
    labels:
      ${labels}
  caddy:
    labels:
      ${labels}
    ports: !override
      - "${manifest.httpHost}:${manifest.httpPort}:80"
      - "${manifest.httpsHost}:${manifest.httpsPort}:443"
      - "${manifest.httpsHost}:${manifest.httpsPort}:443/udp"
networks:
  default:
    labels:
      ${labels}
volumes:
  postgres_data:
    labels:
      ${labels}
  book_storage:
    labels:
      ${labels}
  caddy_data:
    labels:
      ${labels}
  caddy_config:
    labels:
      ${labels}
`;
}

function exactManifest(left: ProductionSmokeManifest, right: ProductionSmokeManifest): boolean {
  return MANIFEST_KEYS.every((key) => left[key] === right[key]);
}

function parseJsonRecord(value: string, description: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    assert(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), description);
    return parsed as Record<string, unknown>;
  } catch {
    throw smokeError(description);
  }
}

function validateMigrationState(value: string): void {
  const evidence = parseJsonRecord(value, 'migration evidence is invalid');
  const keys = Reflect.ownKeys(evidence);
  assert(
    keys.length === MIGRATION_EVIDENCE_KEYS.length &&
      MIGRATION_EVIDENCE_KEYS.every((key) => Object.hasOwn(evidence, key)) &&
      keys.every((key) => typeof key === 'string' && MIGRATION_EVIDENCE_KEYS.includes(key)),
    'migration evidence is invalid'
  );
  for (const key of MIGRATION_EVIDENCE_KEYS) {
    const candidate = evidence[key];
    assert(
      typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0,
      'migration evidence is invalid'
    );
  }
  assert(
    Number(evidence.migrationCount) > 0 &&
      Number(evidence.migrationMax) > 0 &&
      evidence.projectionVersionCount === 1 &&
      evidence.activeClassifierVersion === 1 &&
      evidence.activeAllocationAlgorithmVersion === 1,
    'migration evidence is invalid'
  );
}

function parseEnvironment(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw smokeError('container environment evidence is invalid');
  }
  assert(
    Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string'),
    'container environment evidence is invalid'
  );
  return Object.fromEntries(
    parsed.map((entry) => {
      const index = entry.indexOf('=');
      return index === -1 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)];
    })
  );
}

function hasStripeSecret(environment: Record<string, string>): boolean {
  return [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_SECRET_KEY_FILE',
    'STRIPE_WEBHOOK_SECRET_FILE'
  ].some((key) => Object.hasOwn(environment, key));
}

function hasStripeSecretMount(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw smokeError('container mount evidence is invalid');
  }
  assert(Array.isArray(parsed), 'container mount evidence is invalid');
  return parsed.some((mount) => {
    assert(typeof mount === 'object' && mount !== null, 'container mount evidence is invalid');
    const destination = (mount as Record<string, unknown>).Destination;
    assert(typeof destination === 'string', 'container mount evidence is invalid');
    return /stripe/iu.test(destination);
  });
}

const STRIPE_FILE_ASSERTION = `const fs=require('node:fs');
const root='/run/secrets';
const names=fs.existsSync(root)?fs.readdirSync(root):[];
if(names.some((name)=>/stripe/i.test(name)))process.exit(1);`;
const RUNTIME_INSPECTION_ATTEMPTS = 120;
const RUNTIME_INSPECTION_WAIT_MS = 500;

function exactOwnershipLabels(
  manifest: ProductionSmokeManifest,
  labels: Record<string, unknown>
): void {
  assert(
    labels['com.docker.compose.project'] === manifest.project,
    'observed resource project label is foreign'
  );
  assert(
    labels['com.paleorbit.plan6b-smoke.run'] === manifest.runId,
    'observed resource run label is foreign'
  );
  assert(
    labels['com.paleorbit.plan6b-smoke.owner'] === manifest.ownershipToken,
    'observed resource owner label is foreign'
  );
}

function composeArguments(manifest: ProductionSmokeManifest): string[] {
  return [
    'compose',
    '--project-name',
    manifest.project,
    '--file',
    resolve('compose.prod.yaml'),
    '--file',
    manifest.overrideFile
  ];
}

function psqlArguments(manifest: ProductionSmokeManifest, query: string): string[] {
  return [
    ...composeArguments(manifest),
    'exec',
    '-T',
    'postgres',
    'psql',
    '--username',
    `plan6b_smoke_${manifest.runId}`,
    '--dbname',
    `plan6b_smoke_${manifest.runId}`,
    '--tuples-only',
    '--no-align',
    '--command',
    query
  ];
}

function dockerEnvironment(
  manifest: ProductionSmokeManifest,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('STRIPE_'))
  );
  return {
    ...sanitized,
    APP_IMAGE: manifest.imageTag,
    ORIGIN: 'https://plan6b-smoke.invalid',
    SITE_ADDRESS: ':80',
    HTTP_BIND_ADDRESS: manifest.httpHost,
    HTTP_PORT: String(manifest.httpPort),
    HTTPS_BIND_ADDRESS: manifest.httpsHost,
    HTTPS_PORT: String(manifest.httpsPort),
    DATABASE_NAME: `plan6b_smoke_${manifest.runId}`,
    DATABASE_USER: `plan6b_smoke_${manifest.runId}`,
    SMTP_HOST: 'postgres',
    SMTP_PORT: '2525',
    SMTP_SECURE: 'false',
    SMTP_REQUIRE_TLS: 'false',
    SMTP_USER: 'plan6b-smoke',
    SMTP_FROM: 'noreply@plan6b-smoke.invalid'
  };
}

async function captureIdentifiers(
  dependencies: ProductionSmokeDockerDependencies,
  argumentsToCapture: readonly string[]
): Promise<string[]> {
  const result = await dependencies.command.capture(
    argumentsToCapture,
    dependencies.environment,
    true
  );
  assert(result.status === 0, 'Docker resource inventory failed');
  if (result.stdout.trim().length === 0) return [];
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean);
}

async function assertNoCollision(
  manifest: ProductionSmokeManifest,
  dependencies: ProductionSmokeDockerDependencies
): Promise<void> {
  const filters = [
    ['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`],
    ['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`],
    ['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`]
  ] as const;
  for (const argumentsToCapture of filters) {
    assert(
      (await captureIdentifiers(dependencies, argumentsToCapture)).length === 0,
      'owned project collides with existing Docker resources'
    );
  }
  const image = await dependencies.command.capture(
    [
      'image', 'ls', '--quiet', '--no-trunc',
      '--filter', `reference=${manifest.imageTag}`
    ],
    dependencies.environment,
    true
  );
  assert(image.status === 0, 'Docker image inventory failed');
  assert(image.stdout.trim().length === 0, 'owned image tag already exists');
}

async function exactImageIds(
  manifest: ProductionSmokeManifest,
  dependencies: ProductionSmokeDockerDependencies
): Promise<string[]> {
  const result = await dependencies.command.capture(
    [
      'image', 'ls', '--quiet', '--no-trunc',
      '--filter', `reference=${manifest.imageTag}`
    ],
    dependencies.environment,
    true
  );
  assert(result.status === 0, 'Docker image inventory failed');
  const ids = result.stdout.trim().length === 0
    ? []
    : result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert(
    ids.length <= 1 && ids.every((id) => /^sha256:[a-f0-9]{64}$/u.test(id)),
    'Docker image inventory is invalid'
  );
  return ids;
}

async function containerId(
  manifest: ProductionSmokeManifest,
  dependencies: ProductionSmokeDockerDependencies,
  service: string
): Promise<string> {
  const result = await dependencies.command.capture(
    [...composeArguments(manifest), 'ps', '--quiet', service],
    dependencies.environment
  );
  const id = result.stdout.trim();
  assert(/^[a-f0-9]{12,64}$/u.test(id), `${service} container identity is invalid`);
  return id;
}

async function inspectLabels(
  dependencies: ProductionSmokeDockerDependencies,
  resource: 'container' | 'network' | 'volume',
  id: string
): Promise<Record<string, unknown>> {
  const argumentsToCapture =
    resource === 'container'
      ? ['inspect', '--format', '{{json .Config.Labels}}', id]
      : [resource, 'inspect', '--format', '{{json .Labels}}', id];
  const result = await dependencies.command.capture(
    argumentsToCapture,
    dependencies.environment
  );
  return parseJsonRecord(result.stdout.trim(), `${resource} labels are invalid`);
}

async function validateOwnedResources(
  manifest: ProductionSmokeManifest,
  dependencies: ProductionSmokeDockerDependencies
): Promise<void> {
  for (const [resource, argumentsToCapture] of [
    [
      'container',
      ['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`]
    ],
    [
      'network',
      ['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`]
    ],
    [
      'volume',
      ['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`]
    ]
  ] as const) {
    for (const id of await captureIdentifiers(dependencies, argumentsToCapture)) {
      exactOwnershipLabels(manifest, await inspectLabels(dependencies, resource, id));
    }
  }
}

export function createProductionSmokeDockerOperations(
  manifest: ProductionSmokeManifest,
  dependencies: ProductionSmokeDockerDependencies
): ProductionSmokeOperations {
  validateProductionSmokeManifest(manifest);
  const environment = dockerEnvironment(manifest, dependencies.environment);
  const compose = composeArguments(manifest);
  let imageTagReservedByThisRun = false;
  const capturePsql = async (query: string): Promise<string> => {
    const result = await dependencies.command.capture(
      psqlArguments(manifest, query),
      environment
    );
    return result.stdout.trim();
  };
  return {
    async build(owned) {
      validateProductionSmokeManifest(owned);
      await assertNoCollision(owned, { ...dependencies, environment });
      imageTagReservedByThisRun = true;
      await dependencies.command.run(
        [
          'build',
          '--target',
          'production',
          '--label',
          `com.paleorbit.plan6b-smoke.run=${owned.runId}`,
          '--label',
          `com.paleorbit.plan6b-smoke.owner=${owned.ownershipToken}`,
          '--tag',
          owned.imageTag,
          '.'
        ],
        environment
      );
    },
    async revalidatePorts(owned) {
      await dependencies.assertPortAvailable(owned.httpHost, owned.httpPort);
      await dependencies.assertPortAvailable(owned.httpsHost, owned.httpsPort);
    },
    async startDatabase() {
      await dependencies.command.run(
        [...compose, 'up', '--detach', '--wait', 'postgres'],
        environment
      );
    },
    async migrate() {
      await dependencies.command.run(
        [...compose, '--profile', 'tools', 'run', '--rm', 'migrate'],
        environment
      );
    },
    async snapshotMigrationState() {
      return capturePsql(`select json_build_object(
        'migrationCount', (select count(*) from drizzle.__drizzle_migrations),
        'migrationMax', (select coalesce(max(id), 0) from drizzle.__drizzle_migrations),
        'credentialAuthorityCount', (select count(*) from credential_authority),
        'entitlementGrantCount', (select count(*) from entitlement_grants),
        'refundComponentCount', (select count(*) from refund_allocation_components),
        'financialIssueCount', (select count(*) from financial_reconciliation_issues),
        'projectionVersionCount', (select count(*) from financial_projection_versions),
        'activeClassifierVersion', (
          select classifier_version from financial_projection_versions where singleton = true
        ),
        'activeAllocationAlgorithmVersion', (
          select allocation_algorithm_version from financial_projection_versions where singleton = true
        )
      )::text`);
    },
    async startRuntime() {
      await dependencies.command.run(
        [...compose, 'up', '--detach', '--wait', 'app', 'worker', 'caddy'],
        environment
      );
    },
    async inspectDisabledRuntime(owned) {
      const appId = await containerId(owned, { ...dependencies, environment }, 'app');
      const workerId = await containerId(owned, { ...dependencies, environment }, 'worker');
      const postgresId = await containerId(owned, { ...dependencies, environment }, 'postgres');
      const inspectContainer = async (id: string) => {
        const [environmentResult, mountResult] = await Promise.all([
          dependencies.command.capture(
            ['inspect', '--format', '{{json .Config.Env}}', id],
            environment
          ),
          dependencies.command.capture(
            ['inspect', '--format', '{{json .Mounts}}', id],
            environment
          )
        ]);
        return {
          environment: parseEnvironment(environmentResult.stdout.trim()),
          hasStripeMount: hasStripeSecretMount(mountResult.stdout.trim())
        };
      };
      const [app, worker] = await Promise.all([
        inspectContainer(appId),
        inspectContainer(workerId)
      ]);
      await Promise.all(['app', 'worker'].map((service) => dependencies.command.run(
        [...compose, 'exec', '-T', service, 'node', '-e', STRIPE_FILE_ASSERTION],
        environment
      )));
      await dependencies.command.run(
        [...compose, 'exec', '-T', 'worker', 'node', '-e',
          "require('node:fs').statSync('/tmp/worker-ready').size > 0 || process.exit(1)"],
        environment
      );
      const postgresPorts = await dependencies.command.capture(
        ['port', postgresId],
        environment
      );
      assert(postgresPorts.status === 0, 'PostgreSQL port evidence is invalid');
      const readJobs = async () => parseJsonRecord(
        await capturePsql(`select json_build_object(
          'providerBackedJobCount', count(*) filter (
            where type in ('commerce.financial-source', 'commerce.financial-payout')
              or (type = 'commerce.financial-scan'
                and coalesce(payload->>'kind', '') <> 'composite_replay')
          ),
          'classificationRootCount', count(*) filter (
            where type = 'commerce.financial-scan'
              and payload->>'kind' = 'composite_replay'
          ),
          'classificationRootCompletedCount', count(*) filter (
            where type = 'commerce.financial-scan'
              and payload->>'kind' = 'composite_replay'
              and status = 'succeeded'
          ),
          'classificationRootUnsafeCount', count(*) filter (
            where type = 'commerce.financial-scan'
              and payload->>'kind' = 'composite_replay'
              and (not payload ?& array['classifierVersion','allocationAlgorithmVersion','replayId']
                or exists (
                  select 1 from jsonb_object_keys(payload) key
                  where key not in ('kind','classifierVersion','allocationAlgorithmVersion','replayId')
                ))
          ),
          'providerLedgerSubjectCount',
            (select count(*) from stripe_balance_transactions) +
            (select count(*) from stripe_balance_transaction_fee_details)
        )::text from jobs`),
        'job evidence is invalid'
      );
      let jobs: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < RUNTIME_INSPECTION_ATTEMPTS; attempt += 1) {
        const candidate = await readJobs();
        const numeric = (key: string): number => {
          const value = candidate[key];
          assert(
            typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
            'job evidence is invalid'
          );
          return value;
        };
        const providerBackedJobCount = numeric('providerBackedJobCount');
        const classificationRootCount = numeric('classificationRootCount');
        const classificationRootCompletedCount = numeric('classificationRootCompletedCount');
        const classificationRootUnsafeCount = numeric('classificationRootUnsafeCount');
        const providerLedgerSubjectCount = numeric('providerLedgerSubjectCount');
        assert(
          providerBackedJobCount === 0 && classificationRootCount <= 1 &&
            classificationRootCompletedCount <= classificationRootCount &&
            classificationRootUnsafeCount === 0 && providerLedgerSubjectCount === 0,
          'job evidence is invalid'
        );
        if (classificationRootCount === 1 && classificationRootCompletedCount === 1) {
          jobs = candidate;
          break;
        }
        if (attempt + 1 < RUNTIME_INSPECTION_ATTEMPTS) {
          await dependencies.wait(RUNTIME_INSPECTION_WAIT_MS);
        }
      }
      assert(jobs, 'disabled financial replay timed out');
      const numeric = (key: string): number => Number(jobs[key]);
      return {
        storefrontStatus: await dependencies.requestStatus(
          `http://${owned.httpHost}:${owned.httpPort}/`
        ),
        commerceStatus: await dependencies.requestStatus(
          `http://${owned.httpHost}:${owned.httpPort}/api/commerce/quote`
        ),
        appStripeEnabled: app.environment.STRIPE_ENABLED === 'true',
        workerStripeEnabled: worker.environment.STRIPE_ENABLED === 'true',
        appFixtureMode: app.environment.STRIPE_TEST_FIXTURE_MODE === 'true',
        workerFixtureMode: worker.environment.STRIPE_TEST_FIXTURE_MODE === 'true',
        appHasStripeSecret: hasStripeSecret(app.environment) || app.hasStripeMount,
        workerHasStripeSecret: hasStripeSecret(worker.environment) || worker.hasStripeMount,
        postgresHostPublished: postgresPorts.stdout.trim().length > 0,
        workerReady: true,
        providerBackedJobCount: numeric('providerBackedJobCount'),
        classificationRootCount: numeric('classificationRootCount'),
        classificationRootCompletedCount: numeric('classificationRootCompletedCount'),
        classificationRootUnsafeCount: numeric('classificationRootUnsafeCount'),
        providerLedgerSubjectCount: numeric('providerLedgerSubjectCount')
      };
    },
    async inspectImage(owned) {
      const result = await dependencies.command.capture(
        ['image', 'inspect', '--format', '{{json .}}', owned.imageTag],
        environment
      );
      const image = parseJsonRecord(result.stdout.trim(), 'image evidence is invalid');
      const labels = image.Config && typeof image.Config === 'object'
        ? (image.Config as Record<string, unknown>).Labels
        : null;
      assert(labels && typeof labels === 'object' && !Array.isArray(labels), 'image labels are invalid');
      assert(
        (labels as Record<string, unknown>)['com.paleorbit.plan6b-smoke.run'] === owned.runId &&
          (labels as Record<string, unknown>)['com.paleorbit.plan6b-smoke.owner'] ===
            owned.ownershipToken,
        'image ownership is invalid'
      );
      assert(typeof image.Id === 'string' && typeof image.Size === 'number', 'image evidence is invalid');
      return { digest: image.Id, sizeBytes: image.Size };
    },
    async cleanup(owned) {
      validateProductionSmokeManifest(owned);
      const stored = parseJsonRecord(
        await readFile(owned.manifestFile, 'utf8'),
        'stored owned-run manifest is invalid'
      ) as unknown as ProductionSmokeManifest;
      validateProductionSmokeManifest(stored);
      assert(exactManifest(stored, owned), 'stored owned-run manifest changed');
      await validateOwnedResources(owned, { ...dependencies, environment });
      await dependencies.command.run(
        [...compose, 'down', '--volumes', '--remove-orphans'],
        environment
      );
      if (imageTagReservedByThisRun) {
        const imageIds = await exactImageIds(owned, { ...dependencies, environment });
        if (imageIds.length === 1) {
          const image = await dependencies.command.capture(
            ['image', 'inspect', '--format', '{{json .}}', owned.imageTag],
            environment
          );
          const inspected = parseJsonRecord(image.stdout.trim(), 'cleanup image evidence is invalid');
          const labels = inspected.Config && typeof inspected.Config === 'object'
            ? (inspected.Config as Record<string, unknown>).Labels
            : null;
          assert(labels && typeof labels === 'object', 'cleanup image labels are invalid');
          assert(
            inspected.Id === imageIds[0] &&
            (labels as Record<string, unknown>)['com.paleorbit.plan6b-smoke.run'] === owned.runId &&
              (labels as Record<string, unknown>)['com.paleorbit.plan6b-smoke.owner'] ===
                owned.ownershipToken,
            'cleanup image ownership is invalid'
          );
          await dependencies.command.run(['image', 'rm', owned.imageTag], environment);
        }
        assert(
          (await exactImageIds(owned, { ...dependencies, environment })).length === 0,
          'owned image cleanup failed'
        );
      }
      await rm(owned.tempDirectory, { recursive: true, force: false });
    }
  };
}

function validateDisabledRuntime(evidence: DisabledRuntimeEvidence): void {
  assert(evidence.storefrontStatus === 503, 'runtime storefront is not in maintenance');
  assert(evidence.commerceStatus === 503, 'runtime commerce endpoint is not in maintenance');
  assert(!evidence.appStripeEnabled && !evidence.workerStripeEnabled, 'runtime enabled Stripe');
  assert(!evidence.appFixtureMode && !evidence.workerFixtureMode, 'runtime enabled fixture mode');
  assert(
    !evidence.appHasStripeSecret && !evidence.workerHasStripeSecret,
    'runtime contains a Stripe secret boundary'
  );
  assert(!evidence.postgresHostPublished, 'runtime published PostgreSQL to the host');
  assert(evidence.workerReady, 'runtime worker is not ready');
  assert(evidence.providerBackedJobCount === 0, 'runtime created provider-backed financial work');
  assert(evidence.classificationRootCount === 1, 'runtime classification root count is invalid');
  assert(
    evidence.classificationRootCompletedCount === 1,
    'runtime classification root did not complete'
  );
  assert(
    evidence.classificationRootUnsafeCount === 0,
    'runtime classification root contains unsafe work'
  );
  assert(evidence.providerLedgerSubjectCount === 0, 'runtime provider ledger is not empty');
}

function validateImage(evidence: ProductionImageEvidence): void {
  assert(/^sha256:[a-f0-9]{64}$/u.test(evidence.digest), 'image digest is invalid');
  assert(
    Number.isSafeInteger(evidence.sizeBytes) && evidence.sizeBytes > 0,
    'image size is invalid'
  );
}

export function validateVerifiedProductionImageLease(
  lease: VerifiedProductionImageLease
): void {
  assert(typeof lease === 'object' && lease !== null, 'production image lease is invalid');
  const keys = Reflect.ownKeys(lease);
  assert(
    keys.length === IMAGE_LEASE_KEYS.length &&
      IMAGE_LEASE_KEYS.every((key) => Object.hasOwn(lease, key)) &&
      keys.every((key) => typeof key === 'string' && IMAGE_LEASE_KEYS.includes(key)),
    'production image lease shape is invalid'
  );
  assert(lease.version === 1, 'production image lease version is invalid');
  assert(
    /^[a-f0-9]{16}$/u.test(lease.productionRunId) &&
      lease.sourceTag === `pale-orbit:plan6b-i-smoke-${lease.productionRunId}`,
    'production image lease source is invalid'
  );
  assert(
    /^[a-f0-9]{32}$/u.test(lease.productionOwnershipToken),
    'production image lease ownership is invalid'
  );
  validateImage(lease);
}

function verifiedProductionImageLease(
  manifest: ProductionSmokeManifest,
  image: ProductionImageEvidence
): VerifiedProductionImageLease {
  const lease: VerifiedProductionImageLease = {
    version: 1,
    sourceTag: manifest.imageTag,
    productionRunId: manifest.runId,
    productionOwnershipToken: manifest.ownershipToken,
    digest: image.digest,
    sizeBytes: image.sizeBytes
  };
  validateVerifiedProductionImageLease(lease);
  return lease;
}

export async function executeProductionSmoke(
  manifest: ProductionSmokeManifest,
  operations: ProductionSmokeOperations,
  consumeImage?: ProductionImageLeaseConsumer
): Promise<{ readonly migrationState: string; readonly image: ProductionImageEvidence }> {
  validateProductionSmokeManifest(manifest);
  let result:
    | { readonly migrationState: string; readonly image: ProductionImageEvidence }
    | undefined;
  let failed = false;
  try {
    await operations.build(manifest);
    await operations.revalidatePorts(manifest);
    await operations.startDatabase(manifest);
    await operations.migrate(manifest);
    const before = await operations.snapshotMigrationState(manifest);
    validateMigrationState(before);
    await operations.migrate(manifest);
    const after = await operations.snapshotMigrationState(manifest);
    validateMigrationState(after);
    assert(after === before, 'migration evidence changed on the second run');
    await operations.revalidatePorts(manifest);
    await operations.startRuntime(manifest);
    validateDisabledRuntime(await operations.inspectDisabledRuntime(manifest));
    const image = await operations.inspectImage(manifest);
    validateImage(image);
    if (consumeImage) {
      await consumeImage(verifiedProductionImageLease(manifest, image));
    }
    result = { migrationState: after, image };
  } catch {
    failed = true;
  }

  try {
    await operations.cleanup(manifest);
  } catch {
    throw smokeError('owned cleanup failed');
  }
  if (failed || !result) throw smokeError('smoke verification failed');
  return result;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (!address || typeof address === 'string' || !safePort(address.port)) {
          return reject(smokeError('failed to reserve an ephemeral loopback port'));
        }
        resolvePort(address.port);
      });
    });
  });
}

export async function assertLoopbackPortAvailable(
  host: '127.0.0.1',
  port: number
): Promise<void> {
  assert(host === '127.0.0.1' && safePort(port), 'port check is unsafe');
  await new Promise<void>((resolveAvailable, reject) => {
    const server = createServer();
    server.once('error', () => reject(smokeError('reserved loopback port is no longer available')));
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => error ? reject(smokeError('loopback port check failed')) : resolveAvailable());
    });
  });
}

export async function createProductionSmokeManifest(): Promise<ProductionSmokeManifest> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const runId = randomBytes(8).toString('hex');
    const tempDirectory = join(resolve(tmpdir()), `${RUN_PREFIX}${runId}`);
    try {
      await mkdir(tempDirectory, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw smokeError('could not create the owned temp directory');
    }
    const secretDirectory = join(tempDirectory, 'secrets');
    try {
      await mkdir(secretDirectory, { recursive: false });
      const httpPort = await reserveLoopbackPort();
      let httpsPort = await reserveLoopbackPort();
      while (httpsPort === httpPort) httpsPort = await reserveLoopbackPort();
      const manifest: ProductionSmokeManifest = {
        version: 1,
        runId,
        ownershipToken: randomBytes(16).toString('hex'),
        project: `${RUN_PREFIX}${runId}`,
        imageTag: `pale-orbit:plan6b-i-smoke-${runId}`,
        tempDirectory,
        overrideFile: join(tempDirectory, 'compose.override.yaml'),
        manifestFile: join(tempDirectory, 'owned-run.json'),
        secretDirectory,
        httpHost: '127.0.0.1',
        httpsHost: '127.0.0.1',
        httpPort,
        httpsPort
      };
      validateProductionSmokeManifest(manifest);
      await Promise.all([
        writeFile(manifest.overrideFile, renderProductionSmokeOverride(manifest), {
          encoding: 'utf8',
          flag: 'wx'
        }),
        writeFile(manifest.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx'
        }),
        ...[
          ['database_password', 24],
          ['auth_secret', 32],
          ['smtp_password', 24],
          ['bootstrap_admin_password', 24]
        ].map(([name, bytes]) =>
          writeFile(join(secretDirectory, String(name)), randomBytes(Number(bytes)).toString('hex'), {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600
          })
        )
      ]);
      return manifest;
    } catch {
      await rm(tempDirectory, { recursive: true, force: true });
      throw smokeError('could not materialize the owned smoke run');
    }
  }
  throw smokeError('could not allocate a unique owned smoke run');
}

export function createProductionSmokeCommandRuntime(): ProductionSmokeCommandRuntime {
  const capture = async (
    argumentsToCapture: readonly string[],
    environment: NodeJS.ProcessEnv,
    allowFailure = false
  ): Promise<ProductionSmokeCommandResult> => {
    const result = spawnSync('docker', [...argumentsToCapture], {
      cwd: resolve('.'),
      env: environment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024
    });
    const status = result.status ?? 1;
    if ((result.error || status !== 0) && !allowFailure) {
      throw smokeError('Docker command failed');
    }
    return { status, stdout: result.stdout ?? '' };
  };
  return {
    async run(argumentsToRun, environment) {
      await capture(argumentsToRun, environment, false);
    },
    capture
  };
}

async function createDefaultProductionSmokeOperations(
  manifest: ProductionSmokeManifest
): Promise<ProductionSmokeOperations> {
  const [databasePassword, authSecret, smtpPassword, bootstrapPassword] = await Promise.all([
    readFile(join(manifest.secretDirectory, 'database_password'), 'utf8'),
    readFile(join(manifest.secretDirectory, 'auth_secret'), 'utf8'),
    readFile(join(manifest.secretDirectory, 'smtp_password'), 'utf8'),
    readFile(join(manifest.secretDirectory, 'bootstrap_admin_password'), 'utf8')
  ]);
  return createProductionSmokeDockerOperations(manifest, {
    command: createProductionSmokeCommandRuntime(),
    environment: {
      ...process.env,
      DATABASE_PASSWORD: databasePassword,
      AUTH_SECRET: authSecret,
      SMTP_PASSWORD: smtpPassword,
      BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
      BOOTSTRAP_ADMIN_EMAIL: 'admin@plan6b-smoke.invalid',
      BOOTSTRAP_ADMIN_NAME: 'Plan 6B Smoke Admin'
    },
    assertPortAvailable: assertLoopbackPortAvailable,
    async requestStatus(url) {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      return response.status;
    },
    wait: (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
  });
}

function createSetupCleanupOperations(
  manifest: ProductionSmokeManifest
): ProductionSmokeOperations {
  return createProductionSmokeDockerOperations(manifest, {
    command: createProductionSmokeCommandRuntime(),
    environment: {
      ...process.env,
      DATABASE_PASSWORD: 'plan6b-smoke-setup-cleanup',
      AUTH_SECRET: 'plan6b-smoke-setup-cleanup',
      SMTP_PASSWORD: 'plan6b-smoke-setup-cleanup',
      BOOTSTRAP_ADMIN_PASSWORD: 'plan6b-smoke-setup-cleanup'
    },
    assertPortAvailable: assertLoopbackPortAvailable,
    async requestStatus() {
      throw smokeError('runtime request is unavailable during setup cleanup');
    },
    wait: (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
  });
}

const defaultRunDependencies: ProductionSmokeRunDependencies = {
  createManifest: createProductionSmokeManifest,
  createOperations: createDefaultProductionSmokeOperations,
  cleanupSetupFailure: async (manifest) => {
    await createSetupCleanupOperations(manifest).cleanup(manifest);
  },
  report: (message, evidence) => console.info(message, evidence)
};

export async function runProductionSmoke(
  consumeImage?: ProductionImageLeaseConsumer,
  dependencies: ProductionSmokeRunDependencies = defaultRunDependencies
): Promise<{
  readonly migrationState: string;
  readonly image: ProductionImageEvidence;
}> {
  const manifest = await dependencies.createManifest();
  let operations: ProductionSmokeOperations;
  try {
    operations = await dependencies.createOperations(manifest);
  } catch {
    try {
      await dependencies.cleanupSetupFailure(manifest);
    } catch {
      throw smokeError('owned cleanup failed');
    }
    throw smokeError('smoke verification failed');
  }
  const result = await executeProductionSmoke(manifest, operations, consumeImage);
  dependencies.report('[plan6b-smoke] complete', {
    project: manifest.project,
    imageDigest: result.image.digest,
    imageSizeBytes: result.image.sizeBytes
  });
  return result;
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isMain) {
  runProductionSmoke().catch(() => {
    console.error('[plan6b-smoke] failed');
    process.exitCode = 1;
  });
}
