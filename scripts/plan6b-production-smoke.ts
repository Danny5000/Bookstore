import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { createSocket, type Socket as DgramSocket } from 'node:dgram';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Plan6bSmokeStage = '6b-ii';

export interface ProductionSmokeManifest {
  readonly version: 2;
  readonly stage: Plan6bSmokeStage;
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
  readonly appDatabaseRoleIsWeb: boolean;
  readonly workerDatabaseRoleIsWorker: boolean;
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
  readonly classificationContinuationCount: number;
  readonly classificationContinuationCompletedCount: number;
  readonly classificationContinuationUnsafeCount: number;
  readonly classificationRunCount: number;
  readonly classificationRunCompletedCount: number;
  readonly pendingProjectionVersionCount: number;
  readonly activeClassifierVersion: number;
  readonly activeAllocationAlgorithmVersion: number;
  readonly providerLedgerSubjectCount: number;
}

export interface ProductionImageEvidence {
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface VerifiedProductionImageLease {
  readonly version: 2;
  readonly stage: Plan6bSmokeStage;
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
  readonly now: () => Date;
  readonly assertPortAvailable: (
    host: '127.0.0.1',
    port: number,
    requireUdp?: boolean
  ) => Promise<void>;
  readonly requestStatus: (url: string) => Promise<number>;
  readonly wait: (milliseconds: number) => Promise<void>;
}

export interface ProductionSmokeRunDependencies {
  readonly createManifest: (stage: Plan6bSmokeStage) => Promise<ProductionSmokeManifest>;
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

export interface ProductionSmokePortLease {
  readonly port: number;
  close(): Promise<void>;
}

export interface ProductionSmokePortRuntime {
  readonly randomInteger: (minimum: number, maximumExclusive: number) => number;
  readonly leaseTcpLoopback: (port: number) => Promise<ProductionSmokePortLease>;
  readonly leaseUdpLoopback: (port: number) => Promise<ProductionSmokePortLease>;
}

export interface ProductionSmokePortOperations {
  allocateLoopbackPort(requireUdp?: boolean, excludedPort?: number): Promise<number>;
  probeLoopbackPort(
    host: '127.0.0.1',
    port: number,
    requireUdp?: boolean
  ): Promise<void>;
}

const PLAN6B_SMOKE_STAGE: Plan6bSmokeStage = '6b-ii';
const RUN_PREFIX = `pale-orbit-plan6b-${PLAN6B_SMOKE_STAGE}-smoke-`;
const IMAGE_TAG_PREFIX = `pale-orbit:plan6b-${PLAN6B_SMOKE_STAGE}-smoke-`;
const TEMP_PREFIX = join(resolve(tmpdir()), RUN_PREFIX);
const MANIFEST_KEYS = [
  'version',
  'stage',
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
  'stage',
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

export function parsePlan6bSmokeStage(
  argumentsToParse: readonly string[]
): Plan6bSmokeStage {
  assert(
    argumentsToParse.length === 2 &&
      argumentsToParse[0] === '--stage' &&
      argumentsToParse[1] === PLAN6B_SMOKE_STAGE,
    'stage arguments are invalid'
  );
  return PLAN6B_SMOKE_STAGE;
}

function validatePlan6bSmokeStage(stage: unknown): asserts stage is Plan6bSmokeStage {
  assert(stage === PLAN6B_SMOKE_STAGE, 'stage is invalid');
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
  assert(manifest.version === 2, 'owned-run manifest version is invalid');
  validatePlan6bSmokeStage(manifest.stage);
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
    manifest.imageTag === `${IMAGE_TAG_PREFIX}${manifest.runId}`,
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
  const labels = `com.paleorbit.plan6b-smoke.stage: ${manifest.stage}
      com.paleorbit.plan6b-smoke.run: ${manifest.runId}
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
  database-role-provision:
    image: ${manifest.imageTag}
    labels:
      ${labels}
  storage-cleanup:
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
  book_staging:
    labels:
      ${labels}
  book_publication:
    labels:
      ${labels}
  book_covers:
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
const WORKER_HEALTH_ARTIFACT = 'build/services/worker-health.js';
const WRITE_WORKER_HEARTBEAT_REHEARSAL = `const fs=require('node:fs');
const [path,encoded]=process.argv.slice(1);
if(!path||!encoded)process.exit(1);
fs.writeFileSync(path,Buffer.from(encoded,'base64url').toString('utf8'),{
  encoding:'utf8',flag:'wx',mode:0o600
});`;
const REMOVE_WORKER_HEARTBEAT_REHEARSAL = `const fs=require('node:fs');
const [path]=process.argv.slice(1);
if(!path)process.exit(1);
fs.rmSync(path,{force:true});`;
const RUNTIME_INSPECTION_ATTEMPTS = 120;
const RUNTIME_INSPECTION_WAIT_MS = 500;

function positiveWorkerSetting(
  environment: Record<string, string>,
  name: 'WORKER_CONCURRENCY' | 'WORKER_HEARTBEAT_MAX_AGE_MS'
): number {
  const raw = environment[name];
  const value = raw === undefined ? Number.NaN : Number(raw);
  assert(
    raw !== undefined && /^\d+$/u.test(raw) && Number.isSafeInteger(value) && value > 0,
    'worker health configuration evidence is invalid'
  );
  return value;
}

function heartbeatSlot(slotId: number, timestamp: string): Record<string, unknown> {
  return {
    slotId,
    state: 'idle',
    lastSuccessfulPollAt: timestamp,
    lastProgressAt: timestamp
  };
}

function workerHeartbeatRehearsals(
  now: Date,
  configuredSlots: number,
  maxAgeMs: number
): { readonly stale: string; readonly missingSlot: string } {
  const nowMilliseconds = Date.prototype.getTime.call(now) as number;
  assert(Number.isFinite(nowMilliseconds), 'worker health rehearsal clock is invalid');
  const currentTimestamp = new Date(nowMilliseconds).toISOString();
  const staleTimestamp = new Date(nowMilliseconds - maxAgeMs - 1).toISOString();
  const record = (
    workerId: string,
    timestamp: string,
    slots: readonly Record<string, unknown>[]
  ): string => JSON.stringify({
    version: 1,
    workerId,
    processStartedAt: timestamp,
    publishedAt: timestamp,
    sequence: 1,
    configuredSlots,
    slots
  });
  return {
    stale: record(
      'worker:plan6b-smoke-stale',
      staleTimestamp,
      Array.from({ length: configuredSlots }, (_, slotId) =>
        heartbeatSlot(slotId, staleTimestamp)
      )
    ),
    missingSlot: record(
      'worker:plan6b-smoke-missing-slot',
      currentTimestamp,
      Array.from({ length: configuredSlots - 1 }, (_, index) =>
        heartbeatSlot(index + 1, currentTimestamp)
      )
    )
  };
}

function exactOwnershipLabels(
  manifest: ProductionSmokeManifest,
  labels: Record<string, unknown>
): void {
  assert(
    labels['com.docker.compose.project'] === manifest.project,
    'observed resource project label is foreign'
  );
  assert(
    labels['com.paleorbit.plan6b-smoke.stage'] === manifest.stage,
    'observed resource stage label is foreign'
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
    `plan6b_smoke_owner_${manifest.runId}`,
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
    DATABASE_OWNER_USER: `plan6b_smoke_owner_${manifest.runId}`,
    DATABASE_USER: `plan6b_smoke_web_${manifest.runId}`,
    DATABASE_WORKER_USER: `plan6b_smoke_worker_${manifest.runId}`,
    DATABASE_STORAGE_CLEANUP_USER: `plan6b_smoke_storage_cleanup_${manifest.runId}`,
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

type DockerResourceKind = 'container' | 'network' | 'volume';

function expectedExactDockerResources(
  manifest: ProductionSmokeManifest
): ReadonlyArray<readonly [DockerResourceKind, string]> {
  return [
    ...['postgres', 'app', 'worker', 'caddy'].map((service) => (
      ['container', `${manifest.project}-${service}-1`] as const
    )),
    ['network', `${manifest.project}_default`] as const,
    ...[
      'postgres_data',
      'book_staging',
      'book_publication',
      'book_covers',
      'caddy_data',
      'caddy_config'
    ].map((volume) => (
      ['volume', `${manifest.project}_${volume}`] as const
    ))
  ];
}

function exactNameInventoryArguments(
  resource: DockerResourceKind,
  name: string
): readonly string[] {
  return resource === 'container'
    ? ['ps', '--all', '--filter', `name=${name}`, '--format', '{{.Names}}']
    : [resource, 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}'];
}

async function exactNameExists(
  dependencies: ProductionSmokeDockerDependencies,
  resource: DockerResourceKind,
  name: string
): Promise<boolean> {
  return (await captureIdentifiers(
    dependencies,
    exactNameInventoryArguments(resource, name)
  )).includes(name);
}

async function assertExactNamesAbsent(
  manifest: ProductionSmokeManifest,
  dependencies: ProductionSmokeDockerDependencies
): Promise<void> {
  for (const [resource, name] of expectedExactDockerResources(manifest)) {
    assert(
      !(await exactNameExists(dependencies, resource, name)),
      `foreign exact-name Docker ${resource} collides with the owned run`
    );
  }
}

async function assertNoComposeResourceCollision(
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
  await assertExactNamesAbsent(manifest, dependencies);
}

async function assertNoCollision(
  manifest: ProductionSmokeManifest,
  dependencies: ProductionSmokeDockerDependencies
): Promise<void> {
  await assertNoComposeResourceCollision(manifest, dependencies);
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

async function validateExactNamedOwnedResources(
  manifest: ProductionSmokeManifest,
  dependencies: ProductionSmokeDockerDependencies
): Promise<void> {
  for (const [resource, name] of expectedExactDockerResources(manifest)) {
    if (await exactNameExists(dependencies, resource, name)) {
      exactOwnershipLabels(manifest, await inspectLabels(dependencies, resource, name));
    }
  }
}

async function assertNoOwnedResourcesRemain(
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
    assert(
      (await captureIdentifiers(dependencies, argumentsToCapture)).length === 0,
      `owned ${resource} cleanup failed`
    );
  }
  for (const [resource, name] of expectedExactDockerResources(manifest)) {
    assert(
      !(await exactNameExists(dependencies, resource, name)),
      `owned ${resource} cleanup failed`
    );
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
  const workerHealthArguments = (heartbeatFile?: string): string[] => [
    ...compose,
    'exec',
    '-T',
    ...(heartbeatFile === undefined
      ? []
      : ['--env', `WORKER_READY_FILE=${heartbeatFile}`]),
    'worker',
    'node',
    WORKER_HEALTH_ARTIFACT
  ];
  const materializeWorkerHeartbeat = async (path: string, raw: string): Promise<void> => {
    await dependencies.command.run([
      ...compose,
      'exec',
      '-T',
      'worker',
      'node',
      '-e',
      WRITE_WORKER_HEARTBEAT_REHEARSAL,
      path,
      Buffer.from(raw, 'utf8').toString('base64url')
    ], environment);
  };
  const removeWorkerHeartbeat = async (path: string): Promise<void> => {
    await dependencies.command.run([
      ...compose,
      'exec',
      '-T',
      'worker',
      'node',
      '-e',
      REMOVE_WORKER_HEARTBEAT_REHEARSAL,
      path
    ], environment);
  };
  const rehearseWorkerHealthFailures = async (
    owned: ProductionSmokeManifest,
    workerEnvironment: Record<string, string>
  ): Promise<void> => {
    const configuredSlots = positiveWorkerSetting(workerEnvironment, 'WORKER_CONCURRENCY');
    const maxAgeMs = positiveWorkerSetting(
      workerEnvironment,
      'WORKER_HEARTBEAT_MAX_AGE_MS'
    );
    const rehearsals = workerHeartbeatRehearsals(
      dependencies.now(),
      configuredSlots,
      maxAgeMs
    );
    const stalePath = `/tmp/worker-heartbeat-stale-${owned.runId}.json`;
    const missingSlotPath = `/tmp/worker-heartbeat-missing-slot-${owned.runId}.json`;
    let staleCreated = false;

    try {
      await materializeWorkerHeartbeat(stalePath, rehearsals.stale);
      staleCreated = true;
      const stale = await dependencies.command.capture(
        workerHealthArguments(stalePath),
        environment,
        true
      );
      assert(stale.status !== 0, 'stale worker health rehearsal was accepted');

      let missingSlotCreated = false;
      try {
        await materializeWorkerHeartbeat(missingSlotPath, rehearsals.missingSlot);
        missingSlotCreated = true;
        const missingSlot = await dependencies.command.capture(
          workerHealthArguments(missingSlotPath),
          environment,
          true
        );
        assert(missingSlot.status !== 0, 'missing-slot worker health rehearsal was accepted');
      } finally {
        if (missingSlotCreated) await removeWorkerHeartbeat(missingSlotPath);
      }
    } finally {
      if (staleCreated) await removeWorkerHeartbeat(stalePath);
    }
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
          `com.paleorbit.plan6b-smoke.stage=${owned.stage}`,
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
      await dependencies.assertPortAvailable(owned.httpHost, owned.httpPort, false);
      await dependencies.assertPortAvailable(owned.httpsHost, owned.httpsPort, true);
    },
    async startDatabase(owned) {
      validateProductionSmokeManifest(owned);
      await assertNoComposeResourceCollision(owned, { ...dependencies, environment });
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
      await dependencies.command.run(
        [...compose, '--profile', 'tools', 'run', '--rm', 'database-role-provision'],
        environment
      );
      await dependencies.command.run(
        [...compose, '--profile', 'tools', 'run', '--rm', 'storage-cleanup'],
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
    async startRuntime(owned) {
      validateProductionSmokeManifest(owned);
      await validateOwnedResources(owned, { ...dependencies, environment });
      await validateExactNamedOwnedResources(owned, { ...dependencies, environment });
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
      const liveWorkerHealth = await dependencies.command.capture(
        workerHealthArguments(),
        environment,
        true
      );
      const workerReady = liveWorkerHealth.status === 0;
      assert(workerReady, 'runtime worker is not ready');
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
                and not coalesce(
                  payload->>'kind' = 'composite_replay'
                  or (payload->>'kind' = 'continuation'
                    and payload->>'phase' in
                      ('classification_replay_page', 'classification_replay_finalize')),
                  false
                ))
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
          'classificationContinuationCount', count(*) filter (
            where type = 'commerce.financial-scan'
              and payload->>'kind' = 'continuation'
              and payload->>'phase' in
                ('classification_replay_page', 'classification_replay_finalize')
          ),
          'classificationContinuationCompletedCount', count(*) filter (
            where type = 'commerce.financial-scan'
              and payload->>'kind' = 'continuation'
              and payload->>'phase' in
                ('classification_replay_page', 'classification_replay_finalize')
              and status = 'succeeded'
          ),
          'classificationContinuationUnsafeCount', count(*) filter (
            where type = 'commerce.financial-scan'
              and payload->>'kind' = 'continuation'
              and payload->>'phase' in
                ('classification_replay_page', 'classification_replay_finalize')
              and (
                not payload ?& array['scanRunId','phase','cursorDigestSha256','limit']
                or exists (
                  select 1 from jsonb_object_keys(payload) key
                  where key not in ('kind','scanRunId','phase','cursorDigestSha256','limit')
                )
                or coalesce(payload->>'scanRunId', '') !~
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                or coalesce(payload->>'cursorDigestSha256', '') !~ '^[a-f0-9]{64}$'
                or coalesce(payload->>'limit', '') <> '100'
                or not exists (
                  select 1 from financial_scan_runs replay_run
                  where replay_run.id::text = payload->>'scanRunId'
                    and replay_run.kind = 'classification_replay'
                )
              )
          ),
          'classificationRunCount', (
            select count(*) from financial_scan_runs
            where kind = 'classification_replay'
          ),
          'classificationRunCompletedCount', (
            select count(*) from financial_scan_runs
            where kind = 'classification_replay'
              and state = 'completed'
              and phase = 'classification_replay_finalize'
              and classifier_version = 1
              and allocation_algorithm_version = 2
              and replay_id = 'c1-a2'
              and checkpoint is null
              and cursor_digest_sha256 is null
              and safe_outcome = 'completed'
              and completed_at is not null
          ),
          'pendingProjectionVersionCount', (
            select count(*) from financial_projection_versions
            where pending_classifier_version is not null
              or pending_allocation_algorithm_version is not null
              or pending_replay_id is not null
              or pending_scan_run_id is not null
          ),
          'activeClassifierVersion', (
            select classifier_version
            from financial_projection_versions
            where singleton = true
          ),
          'activeAllocationAlgorithmVersion', (
            select allocation_algorithm_version
            from financial_projection_versions
            where singleton = true
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
        const classificationContinuationCount = numeric('classificationContinuationCount');
        const classificationContinuationCompletedCount =
          numeric('classificationContinuationCompletedCount');
        const classificationContinuationUnsafeCount =
          numeric('classificationContinuationUnsafeCount');
        const classificationRunCount = numeric('classificationRunCount');
        const classificationRunCompletedCount = numeric('classificationRunCompletedCount');
        const pendingProjectionVersionCount = numeric('pendingProjectionVersionCount');
        const activeClassifierVersion = numeric('activeClassifierVersion');
        const activeAllocationAlgorithmVersion = numeric('activeAllocationAlgorithmVersion');
        const providerLedgerSubjectCount = numeric('providerLedgerSubjectCount');
        assert(
          providerBackedJobCount === 0 && classificationRootCount <= 1 &&
            classificationRootCompletedCount <= classificationRootCount &&
            classificationRootUnsafeCount === 0 && classificationContinuationCount <= 1 &&
            classificationContinuationCompletedCount <= classificationContinuationCount &&
            classificationContinuationUnsafeCount === 0 && classificationRunCount <= 1 &&
            classificationRunCompletedCount <= classificationRunCount &&
            pendingProjectionVersionCount <= 1 && activeClassifierVersion >= 1 &&
            activeAllocationAlgorithmVersion >= 1 && providerLedgerSubjectCount === 0,
          'job evidence is invalid'
        );
        if (classificationRootCount === 1 && classificationRootCompletedCount === 1 &&
          classificationContinuationCount === 1 &&
          classificationContinuationCompletedCount === 1 &&
          classificationRunCount === 1 && classificationRunCompletedCount === 1 &&
          pendingProjectionVersionCount === 0 && activeClassifierVersion === 1 &&
          activeAllocationAlgorithmVersion === 2) {
          jobs = candidate;
          break;
        }
        if (attempt + 1 < RUNTIME_INSPECTION_ATTEMPTS) {
          await dependencies.wait(RUNTIME_INSPECTION_WAIT_MS);
        }
      }
      assert(jobs, 'disabled financial replay timed out');
      await rehearseWorkerHealthFailures(owned, worker.environment);
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
        appDatabaseRoleIsWeb:
          app.environment.DATABASE_USER === `plan6b_smoke_web_${owned.runId}`,
        workerDatabaseRoleIsWorker:
          worker.environment.DATABASE_WORKER_USER === `plan6b_smoke_worker_${owned.runId}` &&
          worker.environment.DATABASE_USER === undefined &&
          worker.environment.DATABASE_OWNER_USER === undefined,
        appFixtureMode: app.environment.STRIPE_TEST_FIXTURE_MODE === 'true',
        workerFixtureMode: worker.environment.STRIPE_TEST_FIXTURE_MODE === 'true',
        appHasStripeSecret: hasStripeSecret(app.environment) || app.hasStripeMount,
        workerHasStripeSecret: hasStripeSecret(worker.environment) || worker.hasStripeMount,
        postgresHostPublished: postgresPorts.stdout.trim().length > 0,
        workerReady,
        providerBackedJobCount: numeric('providerBackedJobCount'),
        classificationRootCount: numeric('classificationRootCount'),
        classificationRootCompletedCount: numeric('classificationRootCompletedCount'),
        classificationRootUnsafeCount: numeric('classificationRootUnsafeCount'),
        classificationContinuationCount: numeric('classificationContinuationCount'),
        classificationContinuationCompletedCount:
          numeric('classificationContinuationCompletedCount'),
        classificationContinuationUnsafeCount: numeric('classificationContinuationUnsafeCount'),
        classificationRunCount: numeric('classificationRunCount'),
        classificationRunCompletedCount: numeric('classificationRunCompletedCount'),
        pendingProjectionVersionCount: numeric('pendingProjectionVersionCount'),
        activeClassifierVersion: numeric('activeClassifierVersion'),
        activeAllocationAlgorithmVersion: numeric('activeAllocationAlgorithmVersion'),
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
        (labels as Record<string, unknown>)['com.paleorbit.plan6b-smoke.stage'] === owned.stage &&
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
      await validateExactNamedOwnedResources(owned, { ...dependencies, environment });
      await dependencies.command.run(
        [...compose, 'down', '--volumes', '--remove-orphans'],
        environment
      );
      await assertNoOwnedResourcesRemain(owned, { ...dependencies, environment });
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
              (labels as Record<string, unknown>)['com.paleorbit.plan6b-smoke.stage'] ===
                owned.stage &&
              (labels as Record<string, unknown>)['com.paleorbit.plan6b-smoke.run'] ===
                owned.runId &&
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
  assert(
    evidence.appDatabaseRoleIsWeb && evidence.workerDatabaseRoleIsWorker,
    'runtime database authority roles are not isolated'
  );
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
  assert(
    evidence.classificationContinuationCount === 1 &&
      evidence.classificationContinuationCompletedCount === 1,
    'runtime classification finalizer did not complete'
  );
  assert(
    evidence.classificationContinuationUnsafeCount === 0,
    'runtime classification continuation contains unsafe work'
  );
  assert(
    evidence.classificationRunCount === 1 && evidence.classificationRunCompletedCount === 1,
    'runtime classification scan did not complete'
  );
  assert(
    evidence.pendingProjectionVersionCount === 0,
    'runtime projection authority is still pending'
  );
  assert(
    evidence.activeClassifierVersion === 1 &&
      evidence.activeAllocationAlgorithmVersion === 2,
    'runtime projection authority did not activate c1-a2'
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
  assert(lease.version === 2, 'production image lease version is invalid');
  validatePlan6bSmokeStage(lease.stage);
  assert(
    /^[a-f0-9]{16}$/u.test(lease.productionRunId) &&
      lease.sourceTag === `${IMAGE_TAG_PREFIX}${lease.productionRunId}`,
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
    version: 2,
    stage: manifest.stage,
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

const LOOPBACK_PORT_RESERVATION_ATTEMPTS = 32;
const EPHEMERAL_PORT_MIN = 49_152;
const EPHEMERAL_PORT_MAX_EXCLUSIVE = 65_536;

function leaseExclusiveTcpLoopback(port: number): Promise<ProductionSmokePortLease> {
  return new Promise((resolveLease, reject) => {
    const server = createServer((socket) => socket.destroy());
    const rejectUnavailable = (error: Error) => reject(error);
    server.once('error', rejectUnavailable);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.removeListener('error', rejectUnavailable);
      const address = server.address();
      resolveLease({
        port: address && typeof address !== 'string' ? address.port : 0,
        close: () => closeTcpServer(server)
      });
    });
  });
}

function closeTcpServer(server: TcpServer): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.close((error) => {
      if (error) return reject(error);
      resolveClosed();
    });
  });
}

function closeUdpSocket(socket: DgramSocket): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    try {
      socket.close(resolveClosed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
        resolveClosed();
        return;
      }
      reject(error as Error);
    }
  });
}

function leaseExclusiveUdpLoopback(port: number): Promise<ProductionSmokePortLease> {
  const socket = createSocket({ type: 'udp4', reuseAddr: false });
  return new Promise((resolveLease, reject) => {
    const rejectUnavailable = (error: Error) => {
      void closeUdpSocket(socket).then(
        () => reject(error),
        () => reject(error)
      );
    };
    socket.once('error', rejectUnavailable);
    socket.bind({ address: '127.0.0.1', port, exclusive: true }, () => {
      socket.removeListener('error', rejectUnavailable);
      resolveLease({ port, close: () => closeUdpSocket(socket) });
    });
  });
}

async function acquirePortLease(
  acquire: (port: number) => Promise<ProductionSmokePortLease>,
  port: number,
  errorMessage: string
): Promise<ProductionSmokePortLease> {
  try {
    return await acquire(port);
  } catch {
    throw smokeError(errorMessage);
  }
}

async function closePortLease(
  lease: ProductionSmokePortLease,
  errorMessage: string
): Promise<void> {
  try {
    await lease.close();
  } catch {
    throw smokeError(errorMessage);
  }
}

function hasExactPortIdentity(lease: ProductionSmokePortLease, port: number): boolean {
  return safePort(lease.port) && lease.port === port;
}

export function createProductionSmokePortOperations(
  runtime: ProductionSmokePortRuntime
): ProductionSmokePortOperations {
  return {
    async allocateLoopbackPort(requireUdp = false, excludedPort?: number) {
      for (let attempt = 0; attempt < LOOPBACK_PORT_RESERVATION_ATTEMPTS; attempt += 1) {
        let tcpLease: ProductionSmokePortLease | undefined;
        let udpLease: ProductionSmokePortLease | undefined;
        try {
          const candidatePort = requireUdp
            ? runtime.randomInteger(EPHEMERAL_PORT_MIN, EPHEMERAL_PORT_MAX_EXCLUSIVE)
            : 0;
          if (candidatePort === excludedPort) continue;
          tcpLease = await acquirePortLease(
            runtime.leaseTcpLoopback,
            candidatePort,
            requireUdp
              ? 'ephemeral loopback port is unavailable for TCP'
              : 'failed to reserve an ephemeral loopback port'
          );
          if (!safePort(tcpLease.port) || tcpLease.port === excludedPort ||
              (candidatePort !== 0 && tcpLease.port !== candidatePort)) {
            continue;
          }
          if (requireUdp) {
            udpLease = await acquirePortLease(
              runtime.leaseUdpLoopback,
              tcpLease.port,
              'ephemeral loopback port is unavailable for UDP'
            );
            if (!hasExactPortIdentity(udpLease, tcpLease.port)) continue;
          }
          return tcpLease.port;
        } catch {
          // Try another bounded candidate when either required protocol is unavailable.
        } finally {
          await Promise.all([
            udpLease
              ? closePortLease(udpLease, 'loopback UDP socket cleanup failed')
              : Promise.resolve(),
            tcpLease
              ? closePortLease(tcpLease, 'loopback TCP socket cleanup failed')
              : Promise.resolve()
          ]);
        }
      }
      throw smokeError(
        requireUdp
          ? 'failed to reserve an ephemeral TCP and UDP loopback port'
          : 'failed to reserve an ephemeral loopback port'
      );
    },
    async probeLoopbackPort(host, port, requireUdp = false) {
      assert(host === '127.0.0.1' && safePort(port), 'port check is unsafe');
      let tcpLease: ProductionSmokePortLease | undefined;
      let udpLease: ProductionSmokePortLease | undefined;
      try {
        tcpLease = await acquirePortLease(
          runtime.leaseTcpLoopback,
          port,
          'reserved loopback port is no longer available'
        );
        assert(
          hasExactPortIdentity(tcpLease, port),
          'reserved loopback port is no longer available'
        );
        if (requireUdp) {
          udpLease = await acquirePortLease(
            runtime.leaseUdpLoopback,
            port,
            'reserved loopback port is no longer available'
          );
          assert(
            hasExactPortIdentity(udpLease, port),
            'reserved loopback port is no longer available'
          );
        }
      } finally {
        await Promise.all([
          udpLease
            ? closePortLease(udpLease, 'loopback port check failed')
            : Promise.resolve(),
          tcpLease
            ? closePortLease(tcpLease, 'loopback port check failed')
            : Promise.resolve()
        ]);
      }
    }
  };
}

const defaultProductionSmokePortOperations = createProductionSmokePortOperations({
  randomInteger: (minimum, maximumExclusive) => randomInt(minimum, maximumExclusive),
  leaseTcpLoopback: leaseExclusiveTcpLoopback,
  leaseUdpLoopback: leaseExclusiveUdpLoopback
});

export async function assertLoopbackPortAvailable(
  host: '127.0.0.1',
  port: number,
  requireUdp = false
): Promise<void> {
  await defaultProductionSmokePortOperations.probeLoopbackPort(host, port, requireUdp);
}

export async function createProductionSmokeManifest(
  stage: Plan6bSmokeStage,
  portOperations: ProductionSmokePortOperations = defaultProductionSmokePortOperations
): Promise<ProductionSmokeManifest> {
  validatePlan6bSmokeStage(stage);
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
      const httpPort = await portOperations.allocateLoopbackPort();
      const httpsPort = await portOperations.allocateLoopbackPort(true, httpPort);
      const manifest: ProductionSmokeManifest = {
        version: 2,
        stage,
        runId,
        ownershipToken: randomBytes(16).toString('hex'),
        project: `${RUN_PREFIX}${runId}`,
        imageTag: `${IMAGE_TAG_PREFIX}${runId}`,
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
          ['database_owner_password', 24],
          ['database_password', 24],
          ['database_worker_password', 24],
          ['database_storage_cleanup_password', 24],
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
  const [databaseOwnerPassword, databasePassword, databaseWorkerPassword,
    databaseStorageCleanupPassword, authSecret, smtpPassword, bootstrapPassword] =
    await Promise.all([
      readFile(join(manifest.secretDirectory, 'database_owner_password'), 'utf8'),
      readFile(join(manifest.secretDirectory, 'database_password'), 'utf8'),
      readFile(join(manifest.secretDirectory, 'database_worker_password'), 'utf8'),
      readFile(join(manifest.secretDirectory, 'database_storage_cleanup_password'), 'utf8'),
      readFile(join(manifest.secretDirectory, 'auth_secret'), 'utf8'),
      readFile(join(manifest.secretDirectory, 'smtp_password'), 'utf8'),
      readFile(join(manifest.secretDirectory, 'bootstrap_admin_password'), 'utf8')
    ]);
  return createProductionSmokeDockerOperations(manifest, {
    command: createProductionSmokeCommandRuntime(),
    environment: {
      ...process.env,
      DATABASE_OWNER_PASSWORD: databaseOwnerPassword,
      DATABASE_PASSWORD: databasePassword,
      DATABASE_WORKER_PASSWORD: databaseWorkerPassword,
      DATABASE_STORAGE_CLEANUP_PASSWORD: databaseStorageCleanupPassword,
      AUTH_SECRET: authSecret,
      SMTP_PASSWORD: smtpPassword,
      BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
      BOOTSTRAP_ADMIN_EMAIL: 'admin@plan6b-smoke.invalid',
      BOOTSTRAP_ADMIN_NAME: 'Plan 6B Smoke Admin'
    },
    assertPortAvailable: assertLoopbackPortAvailable,
    now: () => new Date(),
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
      DATABASE_OWNER_PASSWORD: 'plan6b-smoke-setup-cleanup-owner',
      DATABASE_PASSWORD: 'plan6b-smoke-setup-cleanup',
      DATABASE_WORKER_PASSWORD: 'plan6b-smoke-setup-cleanup-worker',
      DATABASE_STORAGE_CLEANUP_PASSWORD: 'plan6b-smoke-setup-cleanup-storage',
      AUTH_SECRET: 'plan6b-smoke-setup-cleanup',
      SMTP_PASSWORD: 'plan6b-smoke-setup-cleanup',
      BOOTSTRAP_ADMIN_PASSWORD: 'plan6b-smoke-setup-cleanup'
    },
    assertPortAvailable: assertLoopbackPortAvailable,
    now: () => new Date(),
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
  stage: Plan6bSmokeStage,
  consumeImage?: ProductionImageLeaseConsumer,
  dependencies: ProductionSmokeRunDependencies = defaultRunDependencies
): Promise<{
  readonly migrationState: string;
  readonly image: ProductionImageEvidence;
}> {
  validatePlan6bSmokeStage(stage);
  const manifest = await dependencies.createManifest(stage);
  validateProductionSmokeManifest(manifest);
  assert(manifest.stage === stage, 'owned-run manifest stage changed');
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
  Promise.resolve()
    .then(() => parsePlan6bSmokeStage(process.argv.slice(2)))
    .then((stage) => runProductionSmoke(stage))
    .catch(() => {
      console.error('[plan6b-smoke] failed');
      process.exitCode = 1;
    });
}
