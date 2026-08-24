import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parsePlan6bSmokeStage,
  runProductionSmoke,
  validateVerifiedProductionImageLease,
  type Plan6bSmokeStage,
  type ProductionImageLeaseConsumer,
  type VerifiedProductionImageLease
} from './plan6b-production-smoke';

export interface FixtureProbeManifest {
  readonly version: 2;
  readonly stage: Plan6bSmokeStage;
  readonly runId: string;
  readonly ownershipToken: string;
  readonly project: string;
  readonly imageTag: string;
  readonly tempDirectory: string;
  readonly overrideFile: string;
  readonly manifestFile: string;
  readonly webHost: '127.0.0.1';
  readonly webPort: number;
  readonly databaseHost: '127.0.0.1';
  readonly databasePort: number;
}

export interface FixtureProbeEvidence {
  readonly appEnvironment: 'test';
  readonly workerEnvironment: 'test';
  readonly appStripeEnabled: false;
  readonly workerStripeEnabled: false;
  readonly appFixtureMode: true;
  readonly workerFixtureMode: true;
  readonly appHasStripeSecret: false;
  readonly workerHasStripeSecret: false;
  readonly networkInternal: true;
  readonly acceptedOrderCount: number;
  readonly checkoutSessionCount: number;
  readonly completedFinancialScanCount: number;
  readonly unsafeFinancialJobCount: number;
  readonly externalStripeRequestCount: number;
  readonly workerReady: boolean;
  readonly administratorCommandSucceeded: boolean;
  readonly administratorWorkerClaimObserved: boolean;
  readonly administratorSalesReflectionObserved: boolean;
  readonly administratorAuditReflectionObserved: boolean;
  readonly webPrivateInputDenied: boolean;
  readonly webDraftMutationDenied: boolean;
}

export interface FixtureProbeOperations {
  acquireImage(
    manifest: FixtureProbeManifest,
    lease: VerifiedProductionImageLease
  ): Promise<void>;
  revalidatePorts(manifest: FixtureProbeManifest): Promise<void>;
  startDependencies(manifest: FixtureProbeManifest): Promise<void>;
  migrate(manifest: FixtureProbeManifest): Promise<void>;
  provisionRoles(manifest: FixtureProbeManifest): Promise<void>;
  bootstrapAdministrator(manifest: FixtureProbeManifest): Promise<void>;
  seedPublishedTitles(manifest: FixtureProbeManifest): Promise<void>;
  startRuntime(manifest: FixtureProbeManifest): Promise<void>;
  exerciseQuoteAndCheckout(manifest: FixtureProbeManifest): Promise<void>;
  exerciseAdministratorCommand(manifest: FixtureProbeManifest): Promise<void>;
  inspect(
    manifest: FixtureProbeManifest,
    lease: VerifiedProductionImageLease
  ): Promise<FixtureProbeEvidence>;
  cleanup(
    manifest: FixtureProbeManifest,
    lease: VerifiedProductionImageLease
  ): Promise<void>;
}

export interface FixtureProbeCommandResult {
  readonly status: number;
  readonly stdout: string;
}

export interface FixtureProbeCommandRuntime {
  run(argumentsToRun: readonly string[], environment: NodeJS.ProcessEnv): Promise<void>;
  capture(
    argumentsToCapture: readonly string[],
    environment: NodeJS.ProcessEnv,
    allowFailure?: boolean,
    standardInput?: string
  ): Promise<FixtureProbeCommandResult>;
}

export interface FixtureProbeHttpResult {
  readonly status: number;
  readonly body: unknown;
}

export interface FixtureProbeDockerDependencies {
  readonly command: FixtureProbeCommandRuntime;
  readonly environment: NodeJS.ProcessEnv;
  readonly assertPortAvailable: (host: '127.0.0.1', port: number) => Promise<void>;
  readonly postJson: (
    url: string,
    input: {
      readonly origin: string;
      readonly requestId: string;
      readonly body: Readonly<Record<string, unknown>>;
    }
  ) => Promise<FixtureProbeHttpResult>;
  readonly wait: (milliseconds: number) => Promise<void>;
}

export interface FixtureProbeRunDependencies {
  readonly createManifest: (stage: Plan6bSmokeStage) => Promise<FixtureProbeManifest>;
  readonly createOperations: (manifest: FixtureProbeManifest) => FixtureProbeOperations;
  readonly report: (
    message: '[plan6b-fixture] complete',
    evidence: {
      readonly project: string;
      readonly imageDigest: string;
      readonly acceptedOrderCount: number;
      readonly checkoutSessionCount: number;
      readonly completedFinancialScanCount: number;
    }
  ) => void;
}

export interface FixtureProbeCliDependencies {
  readonly runProduction: (
    stage: Plan6bSmokeStage,
    consumeImage: ProductionImageLeaseConsumer
  ) => Promise<unknown>;
  readonly runFixture: (
    stage: Plan6bSmokeStage,
    lease: VerifiedProductionImageLease
  ) => Promise<FixtureProbeEvidence>;
}

const FIXTURE_STAGE = '6b-ii' satisfies Plan6bSmokeStage;
const RUN_PREFIX = `pale-orbit-plan6b-${FIXTURE_STAGE}-fixture-`;
const TEMP_PREFIX = join(resolve(tmpdir()), RUN_PREFIX);
const STRIPE_ATTEMPT_COUNTER_DIRECTORY = '/var/lib/pale-orbit/stripe-attempts';
const STRIPE_ATTEMPT_COUNTER_FILE = `${STRIPE_ATTEMPT_COUNTER_DIRECTORY}/count`;
const ADMINISTRATOR_PASSWORD_FILE_NAME = 'bootstrap-admin-password';
const ADMINISTRATOR_CONTAINER_PASSWORD_FILE = '/run/secrets/bootstrap_admin_password';
const ADMINISTRATOR_SESSION_FILE = '/tmp/plan6b-fixture-administrator-session';
const PRIVATE_STANDARD_INPUT_LIMIT_BYTES = 16 * 1024;
const STRIPE_ATTEMPT_CANARY_SERVER = `const fs=require('node:fs');
const net=require('node:net');
const file=${JSON.stringify(STRIPE_ATTEMPT_COUNTER_FILE)};
let count=0;
const server=net.createServer((socket)=>{
  count+=1;
  fs.writeFileSync(file,String(count),{encoding:'utf8',mode:0o600});
  socket.destroy();
});
server.listen(443,'0.0.0.0',()=>{
  fs.writeFileSync(file,'0',{encoding:'utf8',mode:0o600});
});`;
const STRIPE_ATTEMPT_CANARY_HEALTHCHECK = `const fs=require('node:fs');
const value=fs.readFileSync(${JSON.stringify(STRIPE_ATTEMPT_COUNTER_FILE)},'utf8').trim();
if(!/^(0|[1-9]\\d*)$/.test(value))process.exit(1);`;
const STRIPE_ATTEMPT_CANARY_READ = `const fs=require('node:fs');
process.stdout.write(fs.readFileSync(${JSON.stringify(STRIPE_ATTEMPT_COUNTER_FILE)},'utf8').trim());`;
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
  'webHost',
  'webPort',
  'databaseHost',
  'databasePort'
] as const;
const EVIDENCE_KEYS = [
  'appEnvironment',
  'workerEnvironment',
  'appStripeEnabled',
  'workerStripeEnabled',
  'appFixtureMode',
  'workerFixtureMode',
  'appHasStripeSecret',
  'workerHasStripeSecret',
  'networkInternal',
  'acceptedOrderCount',
  'checkoutSessionCount',
  'completedFinancialScanCount',
  'unsafeFinancialJobCount',
  'externalStripeRequestCount',
  'workerReady',
  'administratorCommandSucceeded',
  'administratorWorkerClaimObserved',
  'administratorSalesReflectionObserved',
  'administratorAuditReflectionObserved',
  'webPrivateInputDenied',
  'webDraftMutationDenied'
] as const;

function fixtureError(message: string): Error {
  return new Error(`[plan6b-fixture] ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw fixtureError(message);
}

function exactOwnKeys(value: object, keys: readonly string[], description: string): void {
  const actual = Reflect.ownKeys(value);
  assert(
    actual.length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)) &&
      actual.every((key) => typeof key === 'string' && keys.includes(key)),
    `${description} shape is invalid`
  );
}

function safePort(value: number): boolean {
  return Number.isInteger(value) &&
    value >= 1024 && value <= 65_535 &&
    ![3000, 5432].includes(value);
}

function exactPath(actual: string, expected: string, description: string): void {
  assert(resolve(actual) === resolve(expected), `${description} is outside the owned run`);
}

export function validateFixtureProbeManifest(manifest: FixtureProbeManifest): void {
  assert(typeof manifest === 'object' && manifest !== null, 'owned-run manifest is invalid');
  exactOwnKeys(manifest, MANIFEST_KEYS, 'owned-run manifest');
  assert(
    manifest.version === 2 && manifest.stage === FIXTURE_STAGE,
    'owned-run manifest version or stage is invalid'
  );
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
    manifest.imageTag === `pale-orbit:plan6b-${manifest.stage}-fixture-${manifest.runId}`,
    'owned-run manifest image tag is invalid'
  );
  assert(manifest.webHost === '127.0.0.1', 'web endpoint is not loopback');
  assert(manifest.databaseHost === '127.0.0.1', 'database endpoint is not loopback');
  assert(safePort(manifest.webPort), 'web port is not safely ephemeral');
  assert(safePort(manifest.databasePort), 'database port is not safely ephemeral');
  assert(manifest.webPort !== manifest.databasePort, 'owned ports collide');

  const directory = join(resolve(tmpdir()), `${RUN_PREFIX}${manifest.runId}`);
  assert(
    resolve(manifest.tempDirectory) === directory &&
      resolve(manifest.tempDirectory).startsWith(TEMP_PREFIX) &&
      basename(manifest.tempDirectory) === `${RUN_PREFIX}${manifest.runId}`,
    'owned-run temp directory is invalid'
  );
  exactPath(manifest.overrideFile, join(directory, 'compose.override.yaml'), 'override file');
  exactPath(manifest.manifestFile, join(directory, 'owned-run.json'), 'manifest file');
}

export function renderFixtureProbeOverride(manifest: FixtureProbeManifest): string {
  validateFixtureProbeManifest(manifest);
  const labels = `com.paleorbit.plan6b-fixture.run: ${manifest.runId}
      com.paleorbit.plan6b-fixture.owner: ${manifest.ownershipToken}
      com.paleorbit.plan6b-fixture.stage: ${manifest.stage}`;
  return `x-fixture-environment: &fixture-environment
  NODE_ENV: production
  APP_ENV: test
  APPLICATION_MODE: prototype
  ORIGIN: http://${manifest.webHost}:${manifest.webPort}
  DATABASE_HOST: postgres
  DATABASE_PORT: "5432"
  DATABASE_NAME: pale_orbit_test
  DATABASE_POOL_MAX: "5"
  DATABASE_CONNECTION_TIMEOUT_MS: "5000"
  DATABASE_STATEMENT_TIMEOUT_MS: "30000"
  DATABASE_READINESS_TIMEOUT_MS: "2000"
  JOB_POLL_INTERVAL_MS: "250"
  JOB_LEASE_MS: "30000"
  JOB_RETRY_BASE_MS: "1000"
  JOB_RETRY_MAX_MS: "300000"
  WORKER_READY_FILE: /tmp/worker-ready
  WORKER_CONCURRENCY: "1"
  STORAGE_PROVIDER: local
  STORAGE_STAGING_ROOT: /var/lib/pale-orbit/staging
  STORAGE_PUBLICATION_ROOT: /var/lib/pale-orbit/publication
  STORAGE_COVERS_ROOT: /var/lib/pale-orbit/covers
  STORAGE_SCRATCH_ROOT: /tmp/pale-orbit-verified
  UPLOAD_MAX_BYTES: "536870912"
  INGEST_MAX_EXPANDED_BYTES: "2147483648"
  INGEST_MAX_ENTRIES: "10000"
  INGEST_MAX_XML_BYTES: "8388608"
  INGEST_MAX_IMAGE_PIXELS: "100000000"
  INGEST_MAX_COMPRESSION_RATIO: "200"
  INGEST_TIMEOUT_MS: "900000"
  STORAGE_STAGING_RETENTION_HOURS: "24"
  STORAGE_ORPHAN_RETENTION_HOURS: "168"
  AUTH_SECRET: plan6b-fixture-auth-secret-0000000000000000
  AUTH_SESSION_EXPIRES_SECONDS: "604800"
  AUTH_VERIFICATION_EXPIRES_SECONDS: "3600"
  AUTH_RESET_EXPIRES_SECONDS: "3600"
  AUTH_MAGIC_EXPIRES_SECONDS: "900"
  AUTH_RATE_LIMIT_WINDOW_SECONDS: "60"
  AUTH_RATE_LIMIT_MAX: "100"
  AUTH_LOGIN_RATE_LIMIT_MAX: "5"
  AUTH_EMAIL_RATE_LIMIT_MAX: "3"
  STRIPE_ENABLED: "false"
  STRIPE_TEST_FIXTURE_MODE: "true"
  STRIPE_LIVE_MODE: "false"
  STRIPE_AUTOMATIC_TAX_ENABLED: "false"
  STRIPE_CHECKOUT_DURATION_SECONDS: "1800"
  STRIPE_WEBHOOK_TOLERANCE_SECONDS: "300"
  COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS: "60"
  COMMERCE_CHECKOUT_RATE_LIMIT_MAX: "5"
  SMTP_HOST: mailpit
  SMTP_PORT: "1025"
  SMTP_SECURE: "false"
  SMTP_REQUIRE_TLS: "false"
  SMTP_FROM: noreply@plan6b-fixture.invalid
  SMTP_CONNECTION_TIMEOUT_MS: "5000"
  SMTP_GREETING_TIMEOUT_MS: "5000"
  SMTP_SOCKET_TIMEOUT_MS: "10000"

services:
  postgres:
    environment:
      POSTGRES_PASSWORD: plan6b_fixture_owner_password_0000000000
    labels:
      ${labels}
    ports: !override
      - "${manifest.databaseHost}:${manifest.databasePort}:5432"
  mailpit:
    labels:
      ${labels}
    ports: !reset []
  stripe_api_canary:
    image: ${manifest.imageTag}
    user: "0:0"
    read_only: true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    security_opt:
      - no-new-privileges:true
    command: ${JSON.stringify(['node', '-e', STRIPE_ATTEMPT_CANARY_SERVER])}
    volumes:
      - stripe_attempts:${STRIPE_ATTEMPT_COUNTER_DIRECTORY}
    labels:
      ${labels}
    networks:
      default:
        aliases:
          - api.stripe.com
    healthcheck:
      test: ${JSON.stringify(['CMD', 'node', '-e', STRIPE_ATTEMPT_CANARY_HEALTHCHECK])}
      interval: 1s
      timeout: 3s
      retries: 30
      start_period: 2s
  app:
    image: ${manifest.imageTag}
    environment:
      <<: *fixture-environment
      DATABASE_USER: pale_orbit_fixture_web
      DATABASE_PASSWORD: plan6b_fixture_web_password_000000000000
      DATABASE_OWNER_USER: ""
      DATABASE_OWNER_PASSWORD: ""
      DATABASE_WORKER_USER: ""
      DATABASE_WORKER_PASSWORD: ""
      DATABASE_STORAGE_CLEANUP_USER: ""
      DATABASE_STORAGE_CLEANUP_PASSWORD: ""
    labels:
      ${labels}
    ports: !override
      - "${manifest.webHost}:${manifest.webPort}:3000"
    volumes:
      - book_staging:/var/lib/pale-orbit/staging
      - book_publication:/var/lib/pale-orbit/publication:ro
      - book_covers:/var/lib/pale-orbit/covers
    depends_on:
      postgres:
        condition: service_healthy
      mailpit:
        condition: service_healthy
      stripe_api_canary:
        condition: service_healthy
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:3000/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 3s
      retries: 60
      start_period: 5s
  worker:
    image: ${manifest.imageTag}
    command: [node, build/services/worker.js]
    environment:
      <<: *fixture-environment
      DATABASE_WORKER_USER: pale_orbit_fixture_worker
      DATABASE_WORKER_PASSWORD: plan6b_fixture_worker_password_0000000000
      DATABASE_OWNER_USER: ""
      DATABASE_OWNER_PASSWORD: ""
      DATABASE_USER: ""
      DATABASE_PASSWORD: ""
      DATABASE_STORAGE_CLEANUP_USER: ""
      DATABASE_STORAGE_CLEANUP_PASSWORD: ""
    labels:
      ${labels}
    volumes:
      - book_staging:/var/lib/pale-orbit/staging
      - book_publication:/var/lib/pale-orbit/publication
      - book_covers:/var/lib/pale-orbit/covers
    depends_on:
      postgres:
        condition: service_healthy
      mailpit:
        condition: service_healthy
      stripe_api_canary:
        condition: service_healthy
    healthcheck:
      test: [CMD, node, -e, "require('node:fs').statSync('/tmp/worker-ready').size > 0 || process.exit(1)"]
      interval: 2s
      timeout: 3s
      retries: 60
      start_period: 5s
  bootstrap-admin:
    profiles: [tools]
    image: ${manifest.imageTag}
    command: [node, build/services/bootstrap-admin.js]
    environment:
      <<: *fixture-environment
      DATABASE_USER: pale_orbit_fixture_web
      DATABASE_PASSWORD: plan6b_fixture_web_password_000000000000
      DATABASE_OWNER_USER: ""
      DATABASE_OWNER_PASSWORD: ""
      DATABASE_WORKER_USER: ""
      DATABASE_WORKER_PASSWORD: ""
      DATABASE_STORAGE_CLEANUP_USER: ""
      DATABASE_STORAGE_CLEANUP_PASSWORD: ""
      BOOTSTRAP_ADMIN_EMAIL: ${fixtureAdministratorEmail(manifest)}
      BOOTSTRAP_ADMIN_NAME: Plan 6B Fixture Administrator
      BOOTSTRAP_ADMIN_PASSWORD_FILE: ${ADMINISTRATOR_CONTAINER_PASSWORD_FILE}
    secrets:
      - bootstrap_admin_password
    labels:
      ${labels}
    depends_on:
      postgres:
        condition: service_healthy
  migrate:
    profiles: [tools]
    image: ${manifest.imageTag}
    command: [node, build/services/migrate.js]
    environment:
      <<: *fixture-environment
      DATABASE_OWNER_USER: pale_orbit_test
      DATABASE_OWNER_PASSWORD: plan6b_fixture_owner_password_0000000000
      DATABASE_MIGRATION_WEB_USER: pale_orbit_fixture_web
      DATABASE_MIGRATION_WORKER_USER: pale_orbit_fixture_worker
      DATABASE_MIGRATION_STORAGE_CLEANUP_USER: pale_orbit_fixture_storage_cleanup
    labels:
      ${labels}
    depends_on:
      postgres:
        condition: service_healthy
  database-role-provision:
    profiles: [tools]
    image: ${manifest.imageTag}
    command: [node, build/services/provision-database-roles.js]
    environment:
      <<: *fixture-environment
      DATABASE_OWNER_USER: pale_orbit_test
      DATABASE_OWNER_PASSWORD: plan6b_fixture_owner_password_0000000000
      DATABASE_USER: pale_orbit_fixture_web
      DATABASE_PASSWORD: plan6b_fixture_web_password_000000000000
      DATABASE_WORKER_USER: pale_orbit_fixture_worker
      DATABASE_WORKER_PASSWORD: plan6b_fixture_worker_password_0000000000
      DATABASE_STORAGE_CLEANUP_USER: pale_orbit_fixture_storage_cleanup
      DATABASE_STORAGE_CLEANUP_PASSWORD: plan6b_fixture_storage_cleanup_password_000000
    labels:
      ${labels}
    depends_on:
      postgres:
        condition: service_healthy
networks:
  default:
    internal: true
    labels:
      ${labels}
volumes:
  stripe_attempts:
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
secrets:
  bootstrap_admin_password:
    file: ${JSON.stringify(fixtureAdministratorPasswordFile(manifest))}
`;
}

function dockerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('STRIPE_'))
  );
}

async function captureIdentifiers(
  dependencies: FixtureProbeDockerDependencies,
  environment: NodeJS.ProcessEnv,
  argumentsToCapture: readonly string[]
): Promise<string[]> {
  const result = await dependencies.command.capture(argumentsToCapture, environment, true);
  assert(result.status === 0, 'Docker resource inventory failed');
  if (result.stdout.trim().length === 0) return [];
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean);
}

type DockerResourceKind = 'container' | 'network' | 'volume';

function expectedExactDockerResources(
  manifest: FixtureProbeManifest
): ReadonlyArray<readonly [DockerResourceKind, string]> {
  return [
    ...['postgres', 'mailpit', 'stripe_api_canary', 'app', 'worker'].map((service) => (
      ['container', `${manifest.project}-${service}-1`] as const
    )),
    ['network', `${manifest.project}_default`] as const,
    ...['stripe_attempts', 'book_staging', 'book_publication', 'book_covers'].map((volume) => (
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
  dependencies: FixtureProbeDockerDependencies,
  environment: NodeJS.ProcessEnv,
  resource: DockerResourceKind,
  name: string
): Promise<boolean> {
  return (await captureIdentifiers(
    dependencies,
    environment,
    exactNameInventoryArguments(resource, name)
  )).includes(name);
}

async function assertExactNamesAbsent(
  manifest: FixtureProbeManifest,
  dependencies: FixtureProbeDockerDependencies,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  for (const [resource, name] of expectedExactDockerResources(manifest)) {
    assert(
      !(await exactNameExists(dependencies, environment, resource, name)),
      `foreign exact-name Docker ${resource} collides with the owned fixture run`
    );
  }
}

async function assertImageTagAbsentAfterInspectFailure(
  imageTag: string,
  dependencies: FixtureProbeDockerDependencies,
  environment: NodeJS.ProcessEnv,
  description: string
): Promise<void> {
  const imageInventory = await dependencies.command.capture(
    ['image', 'ls', '--quiet', '--filter', `reference=${imageTag}`],
    environment,
    true
  );
  assert(imageInventory.status === 0, `${description} inventory failed`);
  assert(imageInventory.stdout.trim().length === 0, `${description} could not be inspected`);
}

async function assertNoComposeResourceCollision(
  manifest: FixtureProbeManifest,
  dependencies: FixtureProbeDockerDependencies,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  for (const argumentsToCapture of [
    ['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`],
    ['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`],
    ['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${manifest.project}`]
  ]) {
    assert(
      (await captureIdentifiers(dependencies, environment, argumentsToCapture)).length === 0,
      'owned project collides with existing Docker resources'
    );
  }
  await assertExactNamesAbsent(manifest, dependencies, environment);
}

async function assertNoDockerCollision(
  manifest: FixtureProbeManifest,
  dependencies: FixtureProbeDockerDependencies,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  await assertNoComposeResourceCollision(manifest, dependencies, environment);
  const image = await dependencies.command.capture(
    ['image', 'inspect', manifest.imageTag],
    environment,
    true
  );
  if (image.status === 0) throw fixtureError('owned image tag already exists');
  await assertImageTagAbsentAfterInspectFailure(
    manifest.imageTag,
    dependencies,
    environment,
    'owned image tag'
  );
}

function composeArguments(manifest: FixtureProbeManifest): string[] {
  return [
    'compose',
    '--project-name',
    manifest.project,
    '--file',
    resolve('compose.test.yaml'),
    '--file',
    manifest.overrideFile
  ];
}

function psqlArguments(manifest: FixtureProbeManifest, query: string): string[] {
  return [
    ...composeArguments(manifest),
    'exec',
    '-T',
    'postgres',
    'psql',
    '--username',
    'pale_orbit_test',
    '--dbname',
    'pale_orbit_test',
    '--set',
    'ON_ERROR_STOP=1',
    '--tuples-only',
    '--no-align',
    '--command',
    query
  ];
}

function fixtureUuid(manifest: FixtureProbeManifest, purpose: string): string {
  const characters = createHash('sha256')
    .update(manifest.runId)
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

function fixtureAdministratorEmail(manifest: FixtureProbeManifest): string {
  return `administrator-${manifest.runId}@plan6b-fixture.invalid`;
}

function fixtureAdministratorPasswordFile(manifest: FixtureProbeManifest): string {
  return join(manifest.tempDirectory, ADMINISTRATOR_PASSWORD_FILE_NAME);
}

async function readFixtureAdministratorPassword(
  manifest: FixtureProbeManifest
): Promise<string> {
  let password: string;
  try {
    password = await readFile(fixtureAdministratorPasswordFile(manifest), 'utf8');
  } catch {
    throw fixtureError('administrator credential is unavailable');
  }
  assert(
    /^P6b![A-Za-z0-9_-]{43}Aa1$/u.test(password) &&
      Buffer.byteLength(password, 'utf8') <= 128 &&
      !password.includes(manifest.ownershipToken),
    'administrator credential is invalid'
  );
  return password;
}

function seedFixtureSql(manifest: FixtureProbeManifest): string {
  const customerId = fixtureUuid(manifest, 'customer');
  const titleOneId = fixtureUuid(manifest, 'title-one');
  const titleTwoId = fixtureUuid(manifest, 'title-two');
  const revisionOneId = fixtureUuid(manifest, 'revision-one');
  const revisionTwoId = fixtureUuid(manifest, 'revision-two');
  const sectionOneId = fixtureUuid(manifest, 'section-one');
  const sectionTwoId = fixtureUuid(manifest, 'section-two');
  const blockOneId = fixtureUuid(manifest, 'block-one');
  const blockTwoId = fixtureUuid(manifest, 'block-two');
  const presentationOneId = fixtureUuid(manifest, 'presentation-one');
  const presentationTwoId = fixtureUuid(manifest, 'presentation-two');
  return `begin;
insert into "user" (id, name, email, email_verified)
values ('${customerId}', 'Plan 6B Fixture Customer', '${manifest.runId}@plan6b-fixture.invalid', true);
insert into user_roles (user_id, role) values ('${customerId}', 'customer');
insert into titles (id, slug, title, description, creator_name, format, price_minor, currency, visibility)
values
  ('${titleOneId}', 'plan6b-fixture-one-${manifest.runId}', 'Plan 6B Fixture One', 'Fixture title one', 'Plan 6B Fixture Author', 'prose', 1200, 'USD', 'public'),
  ('${titleTwoId}', 'plan6b-fixture-two-${manifest.runId}', 'Plan 6B Fixture Two', 'Fixture title two', 'Plan 6B Fixture Author', 'prose', 1800, 'USD', 'public');
insert into title_revisions (id, title_id, state, created_by_actor_id, change_summary)
values
  ('${revisionOneId}', '${titleOneId}', 'active', 'system:plan6b_fixture', 'Fixture publication'),
  ('${revisionTwoId}', '${titleTwoId}', 'active', 'system:plan6b_fixture', 'Fixture publication');
insert into prose_sections (id, revision_id, ordinal, label, source_reference)
values
  ('${sectionOneId}', '${revisionOneId}', 0, 'Chapter', 'fixture/one.xhtml'),
  ('${sectionTwoId}', '${revisionTwoId}', 0, 'Chapter', 'fixture/two.xhtml');
insert into prose_blocks (id, revision_id, section_id, ordinal, kind, content, image_id)
values
  ('${blockOneId}', '${revisionOneId}', '${sectionOneId}', 0, 'paragraph', '{"kind":"paragraph","fragments":[{"text":"Fixture preview one","marks":[]}]}'::jsonb, null),
  ('${blockTwoId}', '${revisionTwoId}', '${sectionTwoId}', 0, 'paragraph', '{"kind":"paragraph","fragments":[{"text":"Fixture preview two","marks":[]}]}'::jsonb, null);
insert into revision_presentations (
  id, revision_id, state, preview_prose_section_id, preview_prose_block_id
)
values
  ('${presentationOneId}', '${revisionOneId}', 'published', '${sectionOneId}', '${blockOneId}'),
  ('${presentationTwoId}', '${revisionTwoId}', 'published', '${sectionTwoId}', '${blockTwoId}');
update titles set active_revision_id = case id
  when '${titleOneId}' then '${revisionOneId}'::uuid
  when '${titleTwoId}' then '${revisionTwoId}'::uuid
end, updated_at = now() where id in ('${titleOneId}', '${titleTwoId}');
commit;`;
}

function seedAdministratorRefundSql(manifest: FixtureProbeManifest): string {
  const customerId = fixtureUuid(manifest, 'customer');
  const titleOneId = fixtureUuid(manifest, 'title-one');
  const titleTwoId = fixtureUuid(manifest, 'title-two');
  const orderId = fixtureUuid(manifest, 'administrator-order');
  const orderItemOneId = fixtureUuid(manifest, 'administrator-order-item-one');
  const orderItemTwoId = fixtureUuid(manifest, 'administrator-order-item-two');
  const paymentId = fixtureUuid(manifest, 'administrator-payment');
  const refundId = fixtureUuid(manifest, 'administrator-refund');
  const issueId = fixtureUuid(manifest, 'administrator-issue');
  const checkoutAttemptId = fixtureUuid(manifest, 'administrator-checkout-attempt');
  return `begin;
insert into orders (
  id, status, initiating_user_id, purchase_email, currency, subtotal_minor,
  tax_minor, total_minor, client_checkout_attempt_id, quote_fingerprint_sha256,
  status_token_sha256, paid_at
) values (
  '${orderId}', 'paid', '${customerId}', '${manifest.runId}@plan6b-fixture.invalid',
  'USD', 3000, 0, 3000, '${checkoutAttemptId}', repeat('c', 64), repeat('d', 64),
  statement_timestamp() - interval '2 minutes'
);
insert into order_items (
  id, order_id, title_id, title_snapshot, creator_name_snapshot, format,
  currency, unit_subtotal_minor, tax_minor, total_minor
) values
  ('${orderItemOneId}', '${orderId}', '${titleOneId}', 'Plan 6B Fixture One',
   'Plan 6B Fixture Author', 'prose', 'USD', 1200, 0, 1200),
  ('${orderItemTwoId}', '${orderId}', '${titleTwoId}', 'Plan 6B Fixture Two',
   'Plan 6B Fixture Author', 'prose', 'USD', 1800, 0, 1800);
insert into payments (
  id, order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
  amount_minor, currency, paid_at, financial_evidence_status
) values (
  '${paymentId}', '${orderId}', 'pi_fixture_${manifest.runId}',
  'ch_fixture_${manifest.runId}', 'succeeded', 3000, 'USD',
  statement_timestamp() - interval '2 minutes', 'pending'
);
insert into refunds (
  id, payment_id, stripe_refund_id, status, amount_minor, currency,
  provider_created_at, allocation_status, financial_evidence_status
) values (
  '${refundId}', '${paymentId}', 're_fixture_${manifest.runId}', 'succeeded',
  1000, 'USD', statement_timestamp() - interval '1 minute', 'needs_review', 'pending'
);
insert into financial_reconciliation_issues (
  id, resource_type, resource_id, safe_code, impact, correlation_id
) values (
  '${issueId}', 'refund', '${refundId}', 'allocation_incomplete', 'pending',
  '${manifest.runId}-fixture-refund'
);
commit;`;
}

function initialFinancialScanEvidenceSql(): string {
  return `select json_build_object(
  'completedFinancialScanCount', (
    select count(*)::int from financial_scan_runs
    where root_key = 'commerce.financial-scan:initial:v1'
      and kind = 'initial_backfill' and state = 'completed' and safe_outcome = 'completed'
      and processed_count = 0 and enqueued_count = 0 and page_count = 3
  )
)::text`;
}

function webCommandBoundarySql(): string {
  return `begin;
set local role pale_orbit_fixture_web;
do $boundary$
begin
  begin
    perform private_input from financial_admin_commands limit 1;
    raise exception using errcode = 'P0001', message = 'web-private-input-boundary-failed';
  exception when insufficient_privilege then null;
  end;
  begin
    update refund_allocation_drafts set version = version where false;
    raise exception using errcode = 'P0001', message = 'web-draft-mutation-boundary-failed';
  exception when insufficient_privilege then null;
  end;
end
$boundary$;
rollback;`;
}

function administratorCommandDiscoverySql(): string {
  return `select json_build_object(
  'administratorCommandCount', count(*)::int,
  'commandId', case when count(*) = 1 then min(id::text) else null end
)::text from financial_admin_commands`;
}

function record(value: unknown, description: string): Record<string, unknown> {
  assert(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    description
  );
  return value as Record<string, unknown>;
}

function exactStringSet(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value) => typeof value === 'string') &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function parseJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw fixtureError(description);
  }
}

function parseJsonRecord(value: string, description: string): Record<string, unknown> {
  return record(parseJson(value, description), description);
}

function parseEnvironment(value: string): Record<string, string> {
  const parsed = parseJson(value, 'container environment evidence is invalid');
  assert(
    Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string'),
    'container environment evidence is invalid'
  );
  return Object.fromEntries(parsed.map((entry) => {
    const separator = entry.indexOf('=');
    return separator === -1
      ? [entry, '']
      : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
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
  const parsed = parseJson(value, 'container mount evidence is invalid');
  assert(Array.isArray(parsed), 'container mount evidence is invalid');
  return parsed.some((mount) => {
    const entry = record(mount, 'container mount evidence is invalid');
    return typeof entry.Destination === 'string' && /stripe/iu.test(entry.Destination);
  });
}

function exactOwnershipLabels(
  manifest: FixtureProbeManifest,
  labels: Record<string, unknown>
): void {
  assert(
    labels['com.docker.compose.project'] === manifest.project,
    'observed resource project label is foreign'
  );
  assert(
    labels['com.paleorbit.plan6b-fixture.run'] === manifest.runId,
    'observed resource run label is foreign'
  );
  assert(
    labels['com.paleorbit.plan6b-fixture.owner'] === manifest.ownershipToken,
    'observed resource owner label is foreign'
  );
  assert(
    labels['com.paleorbit.plan6b-fixture.stage'] === manifest.stage,
    'observed resource stage label is foreign'
  );
}

function exactManifest(left: FixtureProbeManifest, right: FixtureProbeManifest): boolean {
  return MANIFEST_KEYS.every((key) => left[key] === right[key]);
}

async function inspectLabels(
  dependencies: FixtureProbeDockerDependencies,
  environment: NodeJS.ProcessEnv,
  resource: 'container' | 'network' | 'volume',
  id: string
): Promise<Record<string, unknown>> {
  const argumentsToCapture = resource === 'container'
    ? ['inspect', '--format', '{{json .Config.Labels}}', id]
    : [resource, 'inspect', '--format', '{{json .Labels}}', id];
  const result = await dependencies.command.capture(argumentsToCapture, environment);
  return parseJsonRecord(result.stdout.trim(), `${resource} labels are invalid`);
}

async function validateOwnedResources(
  manifest: FixtureProbeManifest,
  dependencies: FixtureProbeDockerDependencies,
  environment: NodeJS.ProcessEnv
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
    for (const id of await captureIdentifiers(
      dependencies,
      environment,
      argumentsToCapture
    )) {
      exactOwnershipLabels(
        manifest,
        await inspectLabels(dependencies, environment, resource, id)
      );
    }
  }
}

async function validateExactNamedOwnedResources(
  manifest: FixtureProbeManifest,
  dependencies: FixtureProbeDockerDependencies,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  for (const [resource, name] of expectedExactDockerResources(manifest)) {
    if (await exactNameExists(dependencies, environment, resource, name)) {
      exactOwnershipLabels(
        manifest,
        await inspectLabels(dependencies, environment, resource, name)
      );
    }
  }
}

async function assertNoOwnedResourcesRemain(
  manifest: FixtureProbeManifest,
  dependencies: FixtureProbeDockerDependencies,
  environment: NodeJS.ProcessEnv
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
      (await captureIdentifiers(dependencies, environment, argumentsToCapture)).length === 0,
      `owned ${resource} cleanup failed`
    );
  }
  for (const [resource, name] of expectedExactDockerResources(manifest)) {
    assert(
      !(await exactNameExists(dependencies, environment, resource, name)),
      `owned ${resource} cleanup failed`
    );
  }
}

async function containerId(
  manifest: FixtureProbeManifest,
  dependencies: FixtureProbeDockerDependencies,
  environment: NodeJS.ProcessEnv,
  service: 'app' | 'worker'
): Promise<string> {
  const result = await dependencies.command.capture(
    [...composeArguments(manifest), 'ps', '--quiet', service],
    environment
  );
  const id = result.stdout.trim();
  assert(/^[a-f0-9]{12,64}$/u.test(id), `${service} container identity is invalid`);
  return id;
}

function financialEvidenceSql(manifest: FixtureProbeManifest): string {
  const titleOneId = fixtureUuid(manifest, 'title-one');
  const titleTwoId = fixtureUuid(manifest, 'title-two');
  const customerId = fixtureUuid(manifest, 'customer');
  const administratorRefundId = fixtureUuid(manifest, 'administrator-refund');
  const administratorItems = [
    {
      orderItemId: fixtureUuid(manifest, 'administrator-order-item-one'),
      totalPresentmentMinor: 600
    },
    {
      orderItemId: fixtureUuid(manifest, 'administrator-order-item-two'),
      totalPresentmentMinor: 400
    }
  ].sort((left, right) => left.orderItemId.localeCompare(right.orderItemId));
  const administratorPrivateItems = administratorItems.map((item) =>
    `jsonb_build_object('orderItemId', '${item.orderItemId}', ` +
      `'totalPresentmentMinor', ${item.totalPresentmentMinor})`
  ).join(',\n          ');
  const administratorDraftTuples = administratorItems.map((item) =>
    `('${item.orderItemId}'::uuid, ${item.totalPresentmentMinor})`
  ).join(',\n            ');
  return `select json_build_object(
  'acceptedOrderCount', (
    select count(*)::int from orders purchase
    where purchase.status = 'checkout_open'
      and purchase.initiating_user_id is null
      and purchase.stripe_checkout_session_id = 'cs_test_' || replace(purchase.id::text, '-', '')
      and (select count(*) from order_items item where item.order_id = purchase.id) = 2
      and (select count(*) from order_items item where item.order_id = purchase.id
        and item.title_id in ('${titleOneId}', '${titleTwoId}')) = 2
      and exists (select 1 from "user" account join user_roles role on role.user_id = account.id
        where account.id = '${customerId}' and account.email_verified and role.role = 'customer')
  ),
  'checkoutSessionCount', (
    select count(distinct stripe_checkout_session_id)::int from orders
    where stripe_checkout_session_id is not null
  ),
  'completedFinancialScanCount', (
    select count(*)::int from financial_scan_runs
    where root_key = 'commerce.financial-scan:initial:v1'
      and kind = 'initial_backfill' and state = 'completed' and safe_outcome = 'completed'
      and processed_count = 0 and enqueued_count = 0 and page_count = 3
  ),
  'unsafeFinancialJobCount', (
    select count(*)::int from jobs
    where type in (
      'commerce.financial-source', 'commerce.financial-payout',
      'commerce.financial-scan', 'commerce.financial-classification'
    ) and (status <> 'succeeded' or completed_at is null or last_error is not null)
  ),
  'administratorCommandSucceeded', (
    select count(*) = 1
    from financial_admin_commands command
    join jobs job on job.id = command.job_id
    where command.kind = 'refund_draft_save'
      and command.status = 'succeeded'
      and command.safe_result_code = 'draft_saved'
      and command.completed_at is not null
      and command.private_input ->> 'kind' = 'refund_draft_save'
      and command.private_input ->> 'refundId' = '${administratorRefundId}'
      and command.private_input = jsonb_build_object(
        'kind', 'refund_draft_save',
        'refundId', '${administratorRefundId}',
        'expectedVersion', null,
        'items', jsonb_build_array(
          ${administratorPrivateItems}
        )
      )
      and command.safe_result ->> 'refundId' = command.private_input ->> 'refundId'
      and command.safe_result ->> 'draftVersion' = '1'
      and command.safe_result ->> 'changed' = 'true'
      and job.type = 'commerce.financial-admin-command'
      and job.status = 'succeeded' and job.attempts = 1
      and job.completed_at is not null and job.last_error is null
      and exists (
        select 1 from refund_allocation_drafts draft
        where draft.refund_id = '${administratorRefundId}'::uuid
          and draft.refund_id::text = command.safe_result ->> 'refundId'
          and draft.state = 'active' and draft.version = 1
          and not exists (
            (select item.order_item_id, item.proposed_total_presentment_minor
              from refund_allocation_draft_items item where item.draft_id = draft.id)
            except all
            (values
              ${administratorDraftTuples}
            )
          )
          and not exists (
            (values
              ${administratorDraftTuples}
            )
            except all
            (select item.order_item_id, item.proposed_total_presentment_minor
              from refund_allocation_draft_items item where item.draft_id = draft.id)
          )
      )
  ),
  'administratorWorkerClaimObserved', (
    select count(*) = 1
    from financial_admin_job_claims claim
    join financial_admin_commands command on command.job_id = claim.job_id
    join jobs job on job.id = claim.job_id
    where command.kind = 'refund_draft_save' and command.status = 'succeeded'
      and job.status = 'succeeded' and job.attempts = 1
      and claim.attempt = job.attempts and claim.state = 'invalidated'
      and claim.invalidated_at is not null
  ),
  'administratorAuditReflectionObserved', (
    select count(*) = 1
    from audit_events event
    join refund_allocation_drafts draft
      on event.resource_id = draft.id::text
    join financial_admin_commands command
      on command.safe_result ->> 'refundId' = draft.refund_id::text
    where command.kind = 'refund_draft_save' and command.status = 'succeeded'
      and event.action = 'financial.refund_draft.created'
      and event.outcome = 'succeeded'
      and event.resource_type = 'refund_allocation_draft'
      and event.correlation_id = command.correlation_id
  ),
  'administratorSalesReflectionObserved', (
    select count(*) >= 1
    from audit_events event
    join financial_admin_commands command
      on command.safe_result ->> 'refundId' = event.resource_id
    where command.kind = 'refund_draft_save' and command.status = 'succeeded'
      and event.action = 'financial.refund_review.view'
      and event.outcome = 'succeeded' and event.resource_type = 'refund'
  ),
  'webPrivateInputDenied', not pg_catalog.has_column_privilege(
    'pale_orbit_fixture_web', 'financial_admin_commands', 'private_input', 'SELECT'
  ),
  'webDraftMutationDenied', not pg_catalog.has_table_privilege(
    'pale_orbit_fixture_web', 'refund_allocation_drafts', 'INSERT, UPDATE, DELETE, TRUNCATE'
  )
)::text`;
}

function numericEvidence(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  assert(
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0,
    'fixture database evidence is invalid'
  );
  return candidate;
}

function nonnegativeIntegerOutput(value: string, description: string): number {
  const trimmed = value.trim();
  assert(/^(0|[1-9]\d*)$/u.test(trimmed), description);
  const parsed = Number(trimmed);
  assert(Number.isSafeInteger(parsed), description);
  return parsed;
}

const STRIPE_FILE_ASSERTION = `const fs=require('node:fs');
const root='/run/secrets';
const names=fs.existsSync(root)?fs.readdirSync(root):[];
if(names.some((name)=>/stripe/i.test(name)))process.exit(1);`;
const INSPECTION_ATTEMPTS = 120;
const INSPECTION_WAIT_MS = 500;

function validateLeasedImageEvidence(
  value: string,
  lease: VerifiedProductionImageLease,
  description: string
): void {
  validateVerifiedProductionImageLease(lease);
  const image = parseJsonRecord(value, description);
  const config = record(image.Config, description);
  const labels = record(config.Labels, `${description} ownership is invalid`);
  assert(
    image.Id === lease.digest && image.Size === lease.sizeBytes,
    `${description} does not match the production image lease`
  );
  assert(
    labels['com.paleorbit.plan6b-smoke.run'] === lease.productionRunId &&
      labels['com.paleorbit.plan6b-smoke.owner'] === lease.productionOwnershipToken &&
      labels['com.paleorbit.plan6b-smoke.stage'] === lease.stage,
    `${description} ownership is invalid`
  );
}

function booleanEvidence(value: Record<string, unknown>, key: string): boolean {
  const candidate = value[key];
  assert(typeof candidate === 'boolean', 'fixture database evidence is invalid');
  return candidate;
}

const ADMINISTRATOR_HTTP_CLIENT = `const fs=require('node:fs');
const mode=process.argv[1];
const internalOrigin='http://127.0.0.1:3000';
const sessionFile=${JSON.stringify(ADMINISTRATOR_SESSION_FILE)};
const fail=()=>process.exit(1);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Reflect.ownKeys(value).length===keys.length&&keys.every((key)=>Object.hasOwn(value,key));
const boundedText=async(response,limit)=>{const value=await response.text();
  if(Buffer.byteLength(value,'utf8')>limit)fail();return value;};
const readInput=async()=>{let value='';process.stdin.setEncoding('utf8');
  for await(const chunk of process.stdin){value+=chunk;
    if(Buffer.byteLength(value,'utf8')>${PRIVATE_STANDARD_INPUT_LIMIT_BYTES})fail();}
  try{return JSON.parse(value)}catch{return fail()}};
const readSession=()=>{let value;try{value=fs.readFileSync(sessionFile,'utf8')}catch{return fail()}
  if(value.length<1||Buffer.byteLength(value,'utf8')>8192||/[\\r\\n]/.test(value))fail();return value;};
const requestHeaders=(origin,cookie)=>({origin,cookie,'sec-fetch-site':'same-origin'});
(async()=>{
  const input=await readInput();
  if(!input||typeof input.origin!=='string'||!/^http:\\/\\/127\\.0\\.0\\.1:[1-9][0-9]{3,4}$/.test(input.origin))fail();
  if(mode==='submit'){
    const keys=['origin','email','password','refundId','idempotencyKey','expectedVersion','items'];
    if(!exact(input,keys)||typeof input.email!=='string'||typeof input.password!=='string'||
      !uuid.test(input.refundId)||!uuid.test(input.idempotencyKey)||input.expectedVersion!==null||
      !Array.isArray(input.items)||input.items.length!==2||input.items.some((item)=>
        !exact(item,['orderItemId','totalPresentmentMinor'])||!uuid.test(item.orderItemId)||
        !Number.isSafeInteger(item.totalPresentmentMinor)||item.totalPresentmentMinor<0))fail();
    const login=await fetch(internalOrigin+'/api/auth/sign-in/email',{
      method:'POST',headers:{'content-type':'application/json',origin:input.origin},
      body:JSON.stringify({email:input.email,password:input.password,rememberMe:false}),
      redirect:'manual',signal:AbortSignal.timeout(10000)});
    await boundedText(login,16384);if(login.status!==200)fail();
    const getSetCookie=login.headers.getSetCookie;
    const raw=typeof getSetCookie==='function'?getSetCookie.call(login.headers):[login.headers.get('set-cookie')];
    const cookie=raw.filter((value)=>typeof value==='string').map((value)=>value.split(';',1)[0]).join('; ');
    if(cookie.length<1||Buffer.byteLength(cookie,'utf8')>8192||/[\\r\\n]/.test(cookie))fail();
    try{fs.writeFileSync(sessionFile,cookie,{encoding:'utf8',flag:'wx',mode:0o600})}catch{return fail()}
    const form=new URLSearchParams();form.append('idempotencyKey',input.idempotencyKey);
    form.append('expectedVersion','');for(const item of input.items){
      form.append('orderItemId',item.orderItemId);
      form.append('totalPresentmentMinor',String(item.totalPresentmentMinor));}
    const response=await fetch(internalOrigin+'/admin/sales/refunds/'+input.refundId+'?/saveDraft',{
      method:'POST',headers:{...requestHeaders(input.origin,cookie),accept:'application/json',
        'content-type':'application/x-www-form-urlencoded','x-sveltekit-action':'true',
        'x-request-id':'plan6b-fixture-draft-submit'},
      body:form.toString(),redirect:'manual',signal:AbortSignal.timeout(10000)});
    const text=await boundedText(response,32768);let body;try{body=JSON.parse(text)}catch{return fail()}
    if(response.status!==200||!exact(body,['type','status','data'])||
      body.type!=='success'||body.status!==200)fail();
    process.stdout.write(JSON.stringify({submitted:true}));return;
  }
  if(mode==='status'){
    if(!exact(input,['origin','commandId','refundId'])||
      !uuid.test(input.commandId)||!uuid.test(input.refundId))fail();
    const response=await fetch(internalOrigin+'/admin/sales/commands/'+input.commandId,{
      headers:{...requestHeaders(input.origin,readSession()),accept:'application/json'},
      redirect:'manual',signal:AbortSignal.timeout(10000)});
    const text=await boundedText(response,16384);let body;try{body=JSON.parse(text)}catch{return fail()}
    const keys=['commandId','createdAt','updatedAt','kind','status','resultCode','result','completedAt'];
    if(response.status!==200||!exact(body,keys)||body.commandId!==input.commandId||
      body.kind!=='refund_draft_save'||!['pending','succeeded'].includes(body.status))fail();
    if(body.status==='pending'){
      if(body.resultCode!==null||body.result!==null||body.completedAt!==null)fail();
    }else if(body.resultCode!=='draft_saved'||!exact(body.result,['refundId','draftVersion','changed'])||
      body.result.refundId!==input.refundId||body.result.draftVersion!==1||body.result.changed!==true||
      typeof body.completedAt!=='string')fail();
    process.stdout.write(JSON.stringify({status:body.status,resultCode:body.resultCode}));return;
  }
  if(mode==='sales'){
    if(!exact(input,['origin','refundId'])||!uuid.test(input.refundId))fail();
    const cookie=readSession();let overview;let detail;
    try{
      overview=await fetch(internalOrigin+'/admin/sales?range=all',{
        headers:requestHeaders(input.origin,cookie),redirect:'manual',signal:AbortSignal.timeout(10000)});
      detail=await fetch(internalOrigin+'/admin/sales/refunds/'+input.refundId,{
        headers:requestHeaders(input.origin,cookie),redirect:'manual',signal:AbortSignal.timeout(10000)});
      const overviewText=await boundedText(overview,262144);
      const detailText=await boundedText(detail,262144);
      if(overview.status!==200||detail.status!==200||
        !overviewText.includes('Sales overview')||!overviewText.includes('item needs review')||
        !detailText.includes('Shared allocation draft')||!detailText.includes('Version 1'))fail();
    }finally{try{fs.unlinkSync(sessionFile)}catch{fail()}}
    process.stdout.write(JSON.stringify({sales:true,detail:true}));return;
  }
  fail();
})().catch(fail);`;

export function createFixtureProbeDockerOperations(
  manifest: FixtureProbeManifest,
  dependencies: FixtureProbeDockerDependencies
): FixtureProbeOperations {
  validateFixtureProbeManifest(manifest);
  const environment = dockerEnvironment(dependencies.environment);
  const compose = composeArguments(manifest);
  let aliasCreated = false;

  const captureAdministratorWeb = async (
    mode: 'submit' | 'status' | 'sales',
    input: Readonly<Record<string, unknown>>
  ): Promise<Record<string, unknown>> => {
    const standardInput = JSON.stringify(input);
    assert(
      Buffer.byteLength(standardInput, 'utf8') <= PRIVATE_STANDARD_INPUT_LIMIT_BYTES,
      'administrator web input is invalid'
    );
    const result = await dependencies.command.capture([
      ...compose,
      'exec',
      '-T',
      'app',
      'node',
      '-e',
      ADMINISTRATOR_HTTP_CLIENT,
      mode
    ], environment, false, standardInput);
    return parseJsonRecord(result.stdout.trim(), 'administrator web evidence is invalid');
  };

  const waitForInitialFinancialScan = async (
    owned: FixtureProbeManifest
  ): Promise<void> => {
    for (let attempt = 0; attempt < INSPECTION_ATTEMPTS; attempt += 1) {
      const snapshot = parseJsonRecord((await dependencies.command.capture(
        psqlArguments(owned, initialFinancialScanEvidenceSql()),
        environment
      )).stdout.trim(), 'fixture initial financial scan evidence is invalid');
      const count = numericEvidence(snapshot, 'completedFinancialScanCount');
      assert(count <= 1, 'fixture initial financial scan evidence is invalid');
      if (count === 1) return;
      if (attempt + 1 < INSPECTION_ATTEMPTS) await dependencies.wait(INSPECTION_WAIT_MS);
    }
    throw fixtureError('fixture initial financial scan timed out');
  };
  return {
    async acquireImage(owned, lease) {
      validateFixtureProbeManifest(owned);
      validateVerifiedProductionImageLease(lease);
      await assertNoDockerCollision(owned, dependencies, environment);
      const source = await dependencies.command.capture([
        'image',
        'inspect',
        '--format',
        '{{json .}}',
        lease.sourceTag
      ], environment);
      validateLeasedImageEvidence(
        source.stdout.trim(),
        lease,
        'leased source image evidence'
      );
      aliasCreated = true;
      await dependencies.command.run([
        'image',
        'tag',
        lease.sourceTag,
        owned.imageTag
      ], environment);
      const alias = await dependencies.command.capture([
        'image',
        'inspect',
        '--format',
        '{{json .}}',
        owned.imageTag
      ], environment);
      validateLeasedImageEvidence(
        alias.stdout.trim(),
        lease,
        'fixture image alias evidence'
      );
    },
    async revalidatePorts(owned) {
      validateFixtureProbeManifest(owned);
      await dependencies.assertPortAvailable(owned.webHost, owned.webPort);
      await dependencies.assertPortAvailable(owned.databaseHost, owned.databasePort);
    },
    async startDependencies(owned) {
      validateFixtureProbeManifest(owned);
      await assertNoComposeResourceCollision(owned, dependencies, environment);
      await dependencies.command.run([
        ...compose,
        'up',
        '--detach',
        '--wait',
        '--wait-timeout',
        '120',
        'postgres',
        'mailpit',
        'stripe_api_canary'
      ], environment);
    },
    async migrate(owned) {
      validateFixtureProbeManifest(owned);
      await dependencies.command.run([
        ...compose,
        '--profile',
        'tools',
        'run',
        '--rm',
        'migrate'
      ], environment);
    },
    async provisionRoles(owned) {
      validateFixtureProbeManifest(owned);
      await dependencies.command.run([
        ...compose,
        '--profile',
        'tools',
        'run',
        '--rm',
        'database-role-provision'
      ], environment);
    },
    async bootstrapAdministrator(owned) {
      validateFixtureProbeManifest(owned);
      await dependencies.command.run([
        ...compose,
        '--profile',
        'tools',
        'run',
        '--rm',
        'bootstrap-admin'
      ], environment);
    },
    async seedPublishedTitles(owned) {
      validateFixtureProbeManifest(owned);
      await dependencies.command.run(psqlArguments(owned, seedFixtureSql(owned)), environment);
    },
    async startRuntime(owned) {
      validateFixtureProbeManifest(owned);
      await validateOwnedResources(owned, dependencies, environment);
      await validateExactNamedOwnedResources(owned, dependencies, environment);
      await dependencies.command.run([
        ...compose,
        'up',
        '--detach',
        '--wait',
        '--wait-timeout',
        '120',
        'app',
        'worker'
      ], environment);
    },
    async exerciseQuoteAndCheckout(owned) {
      const titleIds = [
        fixtureUuid(owned, 'title-one'),
        fixtureUuid(owned, 'title-two')
      ].sort();
      const checkoutAttemptId = fixtureUuid(owned, 'checkout-attempt');
      const origin = `http://${owned.webHost}:${owned.webPort}`;
      const quoteResponse = await dependencies.postJson(`${origin}/api/commerce/quote`, {
        origin,
        requestId: `${owned.runId}-quote`,
        body: { titleIds, checkoutAttemptId }
      });
      assert(quoteResponse.status === 200, 'fixture quote request failed');
      const quote = record(quoteResponse.body, 'fixture quote response is invalid');
      assert(
        typeof quote.fingerprint === 'string' && /^[a-f0-9]{64}$/u.test(quote.fingerprint),
        'fixture quote response is invalid'
      );
      assert(quote.currency === 'USD' && quote.subtotalMinor === 3000 && quote.canCheckout === true,
        'fixture quote response is invalid');
      const items = quote.items;
      assert(Array.isArray(items) && items.length === 2, 'fixture quote response is invalid');
      assert(
        exactStringSet(items.map((item) => record(item, 'fixture quote item is invalid').titleId), titleIds),
        'fixture quote response is invalid'
      );
      assert(
        exactStringSet(items.map((item) => record(item, 'fixture quote item is invalid').title), [
          'Plan 6B Fixture One',
          'Plan 6B Fixture Two'
        ]),
        'fixture quote response is invalid'
      );
      for (const key of [
        'alreadyOwnedTitleIds',
        'claimableTitleIds',
        'reservedTitleIds',
        'unavailableTitleIds'
      ]) assert(Array.isArray(quote[key]) && quote[key].length === 0,
        'fixture quote response is invalid');

      const checkoutResponse = await dependencies.postJson(
        `${origin}/api/commerce/checkout`,
        {
          origin,
          requestId: `${owned.runId}-checkout`,
          body: {
            titleIds,
            quoteFingerprint: quote.fingerprint,
            checkoutAttemptId
          }
        }
      );
      assert(checkoutResponse.status === 200, 'fixture checkout request failed');
      const checkout = record(checkoutResponse.body, 'fixture checkout response is invalid');
      assert(checkout.status === 'redirect' && typeof checkout.checkoutUrl === 'string',
        'fixture checkout response is invalid');
      let hosted: URL;
      try {
        hosted = new URL(checkout.checkoutUrl);
      } catch {
        throw fixtureError('fixture checkout response is invalid');
      }
      assert(
        hosted.origin === 'https://checkout.stripe.test' &&
          /^\/session\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
            .test(hosted.pathname) &&
          hosted.search === '',
        'fixture checkout response is invalid'
      );
    },
    async exerciseAdministratorCommand(owned) {
      validateFixtureProbeManifest(owned);
      await waitForInitialFinancialScan(owned);
      await dependencies.command.run(
        psqlArguments(owned, seedAdministratorRefundSql(owned)),
        environment
      );
      await dependencies.command.run(
        psqlArguments(owned, webCommandBoundarySql()),
        environment
      );

      const origin = `http://${owned.webHost}:${owned.webPort}`;
      const refundId = fixtureUuid(owned, 'administrator-refund');
      const submission = await captureAdministratorWeb('submit', {
        origin,
        email: fixtureAdministratorEmail(owned),
        password: await readFixtureAdministratorPassword(owned),
        refundId,
        idempotencyKey: fixtureUuid(owned, 'administrator-command-idempotency'),
        expectedVersion: null,
        items: [
          {
            orderItemId: fixtureUuid(owned, 'administrator-order-item-one'),
            totalPresentmentMinor: 600
          },
          {
            orderItemId: fixtureUuid(owned, 'administrator-order-item-two'),
            totalPresentmentMinor: 400
          }
        ]
      });
      exactOwnKeys(submission, ['submitted'], 'administrator submission evidence');
      assert(submission.submitted === true, 'administrator submission evidence is invalid');

      let commandId: string | null = null;
      for (let attempt = 0; attempt < INSPECTION_ATTEMPTS; attempt += 1) {
        const discovery = parseJsonRecord((await dependencies.command.capture(
          psqlArguments(owned, administratorCommandDiscoverySql()),
          environment
        )).stdout.trim(), 'administrator command discovery evidence is invalid');
        exactOwnKeys(
          discovery,
          ['administratorCommandCount', 'commandId'],
          'administrator command discovery evidence'
        );
        const count = numericEvidence(discovery, 'administratorCommandCount');
        assert(count <= 1, 'administrator command discovery evidence is invalid');
        if (count === 1) {
          assert(
            typeof discovery.commandId === 'string' &&
              /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
                .test(discovery.commandId),
            'administrator command discovery evidence is invalid'
          );
          commandId = discovery.commandId;
          break;
        }
        assert(discovery.commandId === null, 'administrator command discovery evidence is invalid');
        if (attempt + 1 < INSPECTION_ATTEMPTS) await dependencies.wait(INSPECTION_WAIT_MS);
      }
      assert(commandId !== null, 'administrator command discovery timed out');

      let succeeded = false;
      for (let attempt = 0; attempt < INSPECTION_ATTEMPTS; attempt += 1) {
        const status = await captureAdministratorWeb('status', {
          origin,
          commandId,
          refundId
        });
        exactOwnKeys(status, ['status', 'resultCode'], 'administrator status evidence');
        if (status.status === 'succeeded' && status.resultCode === 'draft_saved') {
          succeeded = true;
          break;
        }
        assert(
          status.status === 'pending' && status.resultCode === null,
          'administrator command did not succeed'
        );
        if (attempt + 1 < INSPECTION_ATTEMPTS) await dependencies.wait(INSPECTION_WAIT_MS);
      }
      assert(succeeded, 'administrator command status timed out');

      const sales = await captureAdministratorWeb('sales', { origin, refundId });
      exactOwnKeys(sales, ['sales', 'detail'], 'administrator Sales evidence');
      assert(
        sales.sales === true && sales.detail === true,
        'administrator Sales evidence is invalid'
      );
    },
    async inspect(owned, lease) {
      validateFixtureProbeManifest(owned);
      validateVerifiedProductionImageLease(lease);
      const appId = await containerId(owned, dependencies, environment, 'app');
      const workerId = await containerId(owned, dependencies, environment, 'worker');
      const inspectContainer = async (id: string) => {
        const [environmentResult, mountResult, networkResult, imageResult] = await Promise.all([
          dependencies.command.capture(
            ['inspect', '--format', '{{json .Config.Env}}', id],
            environment
          ),
          dependencies.command.capture(
            ['inspect', '--format', '{{json .Mounts}}', id],
            environment
          ),
          dependencies.command.capture(
            ['inspect', '--format', '{{json .NetworkSettings.Networks}}', id],
            environment
          ),
          dependencies.command.capture(
            ['inspect', '--format', '{{json .Image}}', id],
            environment
          )
        ]);
        const imageId = parseJson(imageResult.stdout.trim(), 'container image evidence is invalid');
        assert(imageId === lease.digest, 'fixture container did not use the leased image');
        return {
          environment: parseEnvironment(environmentResult.stdout.trim()),
          hasStripeMount: hasStripeSecretMount(mountResult.stdout.trim()),
          networks: parseJsonRecord(
            networkResult.stdout.trim(),
            'container network evidence is invalid'
          )
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
      await dependencies.command.run([
        ...compose,
        'exec',
        '-T',
        'worker',
        'node',
        '-e',
        "require('node:fs').statSync('/tmp/worker-ready').size > 0 || process.exit(1)"
      ], environment);

      const networkIds = await captureIdentifiers(dependencies, environment, [
        'network',
        'ls',
        '--quiet',
        '--filter',
        `label=com.docker.compose.project=${owned.project}`
      ]);
      assert(networkIds.length === 1, 'fixture network identity is invalid');
      const networkId = networkIds[0]!;
      const network = parseJsonRecord((await dependencies.command.capture([
        'network',
        'inspect',
        '--format',
        '{{json .}}',
        networkId
      ], environment)).stdout.trim(), 'fixture network evidence is invalid');
      assert(
        typeof network.Id === 'string' && /^[a-f0-9]{12,64}$/u.test(network.Id),
        'fixture network evidence is invalid'
      );
      const labels = record(network.Labels, 'fixture network labels are invalid');
      exactOwnershipLabels(owned, labels);
      const expectedNetworkName = `${owned.project}_default`;
      for (const attached of [app.networks, worker.networks]) {
        assert(
          Reflect.ownKeys(attached).length === 1 && Object.hasOwn(attached, expectedNetworkName),
          'fixture container has a foreign network'
        );
        const attachment = record(
          attached[expectedNetworkName],
          'fixture container network evidence is invalid'
        );
        assert(attachment.NetworkID === network.Id, 'fixture container network is foreign');
      }

      for (let attempt = 0; attempt < INSPECTION_ATTEMPTS; attempt += 1) {
        const snapshot = parseJsonRecord((await dependencies.command.capture(
          psqlArguments(owned, financialEvidenceSql(owned)),
          environment
        )).stdout.trim(), 'fixture database evidence is invalid');
        const acceptedOrderCount = numericEvidence(snapshot, 'acceptedOrderCount');
        const checkoutSessionCount = numericEvidence(snapshot, 'checkoutSessionCount');
        const completedFinancialScanCount = numericEvidence(
          snapshot,
          'completedFinancialScanCount'
        );
        const unsafeFinancialJobCount = numericEvidence(snapshot, 'unsafeFinancialJobCount');
        const administratorCommandSucceeded = booleanEvidence(
          snapshot,
          'administratorCommandSucceeded'
        );
        const administratorWorkerClaimObserved = booleanEvidence(
          snapshot,
          'administratorWorkerClaimObserved'
        );
        const administratorAuditReflectionObserved = booleanEvidence(
          snapshot,
          'administratorAuditReflectionObserved'
        );
        const administratorSalesReflectionObserved = booleanEvidence(
          snapshot,
          'administratorSalesReflectionObserved'
        );
        const webPrivateInputDenied = booleanEvidence(snapshot, 'webPrivateInputDenied');
        const webDraftMutationDenied = booleanEvidence(snapshot, 'webDraftMutationDenied');
        assert(
          acceptedOrderCount === 1 && checkoutSessionCount === 1 &&
            completedFinancialScanCount <= 1,
          'fixture database evidence is invalid'
        );
        if (
          completedFinancialScanCount === 1 && unsafeFinancialJobCount === 0 &&
          administratorCommandSucceeded && administratorWorkerClaimObserved &&
          administratorAuditReflectionObserved && administratorSalesReflectionObserved &&
          webPrivateInputDenied && webDraftMutationDenied
        ) {
          const stripeAttemptResult = await dependencies.command.capture([
            ...compose,
            'exec',
            '-T',
            'stripe_api_canary',
            'node',
            '-e',
            STRIPE_ATTEMPT_CANARY_READ
          ], environment);
          assert(stripeAttemptResult.status === 0, 'Stripe API attempt evidence is invalid');
          const externalStripeRequestCount = nonnegativeIntegerOutput(
            stripeAttemptResult.stdout,
            'Stripe API attempt evidence is invalid'
          );
          const evidence = {
            appEnvironment: app.environment.APP_ENV,
            workerEnvironment: worker.environment.APP_ENV,
            appStripeEnabled: app.environment.STRIPE_ENABLED === 'true',
            workerStripeEnabled: worker.environment.STRIPE_ENABLED === 'true',
            appFixtureMode: app.environment.STRIPE_TEST_FIXTURE_MODE === 'true',
            workerFixtureMode: worker.environment.STRIPE_TEST_FIXTURE_MODE === 'true',
            appHasStripeSecret: hasStripeSecret(app.environment) || app.hasStripeMount,
            workerHasStripeSecret: hasStripeSecret(worker.environment) || worker.hasStripeMount,
            networkInternal: network.Internal === true,
            acceptedOrderCount,
            checkoutSessionCount,
            completedFinancialScanCount,
            unsafeFinancialJobCount,
            externalStripeRequestCount,
            workerReady: true,
            administratorCommandSucceeded,
            administratorWorkerClaimObserved,
            administratorSalesReflectionObserved,
            administratorAuditReflectionObserved,
            webPrivateInputDenied,
            webDraftMutationDenied
          } as FixtureProbeEvidence;
          validateEvidence(evidence);
          return evidence;
        }
        if (attempt + 1 < INSPECTION_ATTEMPTS) {
          await dependencies.wait(INSPECTION_WAIT_MS);
        }
      }
      throw fixtureError('fixture financial scan timed out');
    },
    async cleanup(owned, lease) {
      validateFixtureProbeManifest(owned);
      validateVerifiedProductionImageLease(lease);
      const stored = parseJsonRecord(
        await readFile(owned.manifestFile, 'utf8'),
        'stored owned-run manifest is invalid'
      ) as unknown as FixtureProbeManifest;
      validateFixtureProbeManifest(stored);
      assert(exactManifest(stored, owned), 'stored owned-run manifest changed');
      await validateOwnedResources(owned, dependencies, environment);
      await validateExactNamedOwnedResources(owned, dependencies, environment);
      await dependencies.command.run([
        ...compose,
        'down',
        '--volumes',
        '--remove-orphans'
      ], environment);
      await assertNoOwnedResourcesRemain(owned, dependencies, environment);
      if (aliasCreated) {
        const image = await dependencies.command.capture([
          'image',
          'inspect',
          '--format',
          '{{json .}}',
          owned.imageTag
        ], environment, true);
        if (image.status === 0) {
          validateLeasedImageEvidence(
            image.stdout.trim(),
            lease,
            'cleanup fixture image alias evidence'
          );
          await dependencies.command.run(['image', 'rm', owned.imageTag], environment);
          const removed = await dependencies.command.capture([
            'image',
            'inspect',
            '--format',
            '{{json .}}',
            owned.imageTag
          ], environment, true);
          assert(removed.status !== 0, 'cleanup image tag still exists');
          await assertImageTagAbsentAfterInspectFailure(
            owned.imageTag,
            dependencies,
            environment,
            'removed cleanup image tag'
          );
          aliasCreated = false;
        } else {
          await assertImageTagAbsentAfterInspectFailure(
            owned.imageTag,
            dependencies,
            environment,
            'cleanup image tag'
          );
        }
      }
      await rm(owned.tempDirectory, { recursive: true, force: false });
    }
  };
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
          return reject(fixtureError('failed to reserve an ephemeral loopback port'));
        }
        resolvePort(address.port);
      });
    });
  });
}

export async function createFixtureProbeManifest(
  stage: Plan6bSmokeStage
): Promise<FixtureProbeManifest> {
  assert(stage === FIXTURE_STAGE, 'fixture stage is invalid');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const runId = randomBytes(8).toString('hex');
    const tempDirectory = join(resolve(tmpdir()), `${RUN_PREFIX}${runId}`);
    try {
      await mkdir(tempDirectory, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw fixtureError('could not create the owned temp directory');
    }
    try {
      const webPort = await reserveLoopbackPort();
      let databasePort = await reserveLoopbackPort();
      while (databasePort === webPort) databasePort = await reserveLoopbackPort();
      const manifest: FixtureProbeManifest = {
        version: 2,
        stage,
        runId,
        ownershipToken: randomBytes(16).toString('hex'),
        project: `${RUN_PREFIX}${runId}`,
        imageTag: `pale-orbit:plan6b-${stage}-fixture-${runId}`,
        tempDirectory,
        overrideFile: join(tempDirectory, 'compose.override.yaml'),
        manifestFile: join(tempDirectory, 'owned-run.json'),
        webHost: '127.0.0.1',
        webPort,
        databaseHost: '127.0.0.1',
        databasePort
      };
      validateFixtureProbeManifest(manifest);
      const administratorPassword = `P6b!${randomBytes(32).toString('base64url')}Aa1`;
      await Promise.all([
        writeFile(
          fixtureAdministratorPasswordFile(manifest),
          administratorPassword,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        ),
        writeFile(manifest.overrideFile, renderFixtureProbeOverride(manifest), {
          encoding: 'utf8',
          flag: 'wx'
        }),
        writeFile(manifest.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx'
        })
      ]);
      return manifest;
    } catch {
      await rm(tempDirectory, { recursive: true, force: true });
      throw fixtureError('could not materialize the owned fixture run');
    }
  }
  throw fixtureError('could not allocate a unique owned fixture run');
}

function validateEvidence(evidence: FixtureProbeEvidence): void {
  assert(typeof evidence === 'object' && evidence !== null, 'fixture runtime evidence is invalid');
  exactOwnKeys(evidence, EVIDENCE_KEYS, 'fixture runtime evidence');
  assert(
    evidence.appEnvironment === 'test' && evidence.workerEnvironment === 'test',
    'fixture runtime environment is invalid'
  );
  assert(
    !evidence.appStripeEnabled && !evidence.workerStripeEnabled,
    'fixture runtime enabled provider Stripe mode'
  );
  assert(
    evidence.appFixtureMode && evidence.workerFixtureMode,
    'fixture runtime did not enable fixture mode'
  );
  assert(
    !evidence.appHasStripeSecret && !evidence.workerHasStripeSecret,
    'fixture runtime contains a Stripe secret boundary'
  );
  assert(evidence.networkInternal, 'fixture runtime network permits egress');
  assert(evidence.acceptedOrderCount === 1, 'fixture runtime order count is invalid');
  assert(evidence.checkoutSessionCount === 1, 'fixture runtime checkout count is invalid');
  assert(
    evidence.completedFinancialScanCount === 1,
    'fixture runtime financial scan count is invalid'
  );
  assert(evidence.unsafeFinancialJobCount === 0, 'fixture runtime created unsafe financial work');
  assert(evidence.externalStripeRequestCount === 0, 'fixture runtime attempted external Stripe work');
  assert(evidence.workerReady, 'fixture runtime worker is not ready');
  assert(
    evidence.administratorCommandSucceeded &&
      evidence.administratorWorkerClaimObserved &&
      evidence.administratorSalesReflectionObserved &&
      evidence.administratorAuditReflectionObserved,
    'fixture administrator command evidence is invalid'
  );
  assert(
    evidence.webPrivateInputDenied && evidence.webDraftMutationDenied,
    'fixture web command boundary evidence is invalid'
  );
}

export async function executeFixtureRuntimeProbe(
  manifest: FixtureProbeManifest,
  lease: VerifiedProductionImageLease,
  operations: FixtureProbeOperations
): Promise<FixtureProbeEvidence> {
  validateFixtureProbeManifest(manifest);
  validateVerifiedProductionImageLease(lease);
  assert(manifest.stage === lease.stage, 'fixture and production image stages do not match');
  let evidence: FixtureProbeEvidence | undefined;
  let failed = false;
  try {
    await operations.acquireImage(manifest, lease);
    await operations.revalidatePorts(manifest);
    await operations.startDependencies(manifest);
    await operations.migrate(manifest);
    await operations.provisionRoles(manifest);
    await operations.bootstrapAdministrator(manifest);
    await operations.seedPublishedTitles(manifest);
    await operations.startRuntime(manifest);
    await operations.exerciseQuoteAndCheckout(manifest);
    await operations.exerciseAdministratorCommand(manifest);
    evidence = await operations.inspect(manifest, lease);
    validateEvidence(evidence);
  } catch {
    failed = true;
  }

  try {
    await operations.cleanup(manifest, lease);
  } catch {
    throw fixtureError('owned cleanup failed');
  }
  if (failed || !evidence) throw fixtureError('fixture runtime verification failed');
  return evidence;
}

export function createFixtureProbeCommandRuntime(): FixtureProbeCommandRuntime {
  const capture = async (
    argumentsToCapture: readonly string[],
    environment: NodeJS.ProcessEnv,
    allowFailure = false,
    standardInput?: string
  ): Promise<FixtureProbeCommandResult> => {
    assert(
      standardInput === undefined ||
        (typeof standardInput === 'string' &&
          Buffer.byteLength(standardInput, 'utf8') <= PRIVATE_STANDARD_INPUT_LIMIT_BYTES),
      'Docker standard input is invalid'
    );
    const result = spawnSync('docker', [...argumentsToCapture], {
      cwd: resolve('.'),
      env: environment,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      input: standardInput,
      timeout: 30 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024
    });
    const status = result.status ?? 1;
    if ((result.error || status !== 0) && !allowFailure) {
      throw fixtureError('Docker command failed');
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

export async function assertFixtureProbeLoopbackPortAvailable(
  host: '127.0.0.1',
  port: number
): Promise<void> {
  assert(host === '127.0.0.1' && safePort(port), 'port check is unsafe');
  await new Promise<void>((resolveAvailable, reject) => {
    const server = createServer();
    server.once('error', () => reject(
      fixtureError('reserved loopback port is no longer available')
    ));
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => error
        ? reject(fixtureError('loopback port check failed'))
        : resolveAvailable());
    });
  });
}

const INTERNAL_HTTP_CLIENT = `const [path,origin,requestId,encoded]=process.argv.slice(1);
const body=Buffer.from(encoded,'base64url').toString('utf8');
fetch('http://127.0.0.1:3000'+path,{
  method:'POST',headers:{'content-type':'application/json',origin,'x-request-id':requestId},body,
  redirect:'manual',signal:AbortSignal.timeout(10000)
}).then(async(response)=>{
  let parsed;try{parsed=await response.json()}catch{process.exit(2)}
  process.stdout.write(JSON.stringify({status:response.status,body:parsed}));
}).catch(()=>process.exit(1));`;

export function createFixtureProbeInternalHttpClient(
  manifest: FixtureProbeManifest,
  command: FixtureProbeCommandRuntime,
  environment: NodeJS.ProcessEnv
): FixtureProbeDockerDependencies['postJson'] {
  validateFixtureProbeManifest(manifest);
  const compose = composeArguments(manifest);
  return async (url, input) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw fixtureError('fixture HTTP request is invalid');
    }
    const expectedOrigin = `http://${manifest.webHost}:${manifest.webPort}`;
    assert(
      parsedUrl.origin === expectedOrigin && input.origin === expectedOrigin &&
        parsedUrl.search === '' && parsedUrl.hash === '' &&
        (parsedUrl.pathname === '/api/commerce/quote' ||
          parsedUrl.pathname === '/api/commerce/checkout') &&
        typeof input.requestId === 'string' && input.requestId.length > 0 &&
        input.requestId.length <= 100,
      'fixture HTTP request is invalid'
    );
    const encoded = Buffer.from(JSON.stringify(input.body)).toString('base64url');
    const result = await command.capture([
      ...compose, 'exec', '-T', 'app', 'node', '-e', INTERNAL_HTTP_CLIENT,
      parsedUrl.pathname, input.origin, input.requestId, encoded
    ], environment);
    return parseJsonRecord(result.stdout.trim(), 'fixture HTTP response is invalid') as unknown as
      FixtureProbeHttpResult;
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

const defaultRunDependencies: FixtureProbeRunDependencies = {
  createManifest: createFixtureProbeManifest,
  createOperations: (manifest) => {
    const command = createFixtureProbeCommandRuntime();
    const environment = process.env;
    return createFixtureProbeDockerOperations(manifest, {
      command,
      environment,
      assertPortAvailable: assertFixtureProbeLoopbackPortAvailable,
      postJson: createFixtureProbeInternalHttpClient(manifest, command, environment),
      wait
    });
  },
  report: (message, evidence) => console.info(message, evidence)
};

export async function runFixtureRuntimeProbe(
  stage: Plan6bSmokeStage,
  lease: VerifiedProductionImageLease,
  dependencies: FixtureProbeRunDependencies = defaultRunDependencies
): Promise<FixtureProbeEvidence> {
  assert(stage === FIXTURE_STAGE, 'fixture stage is invalid');
  validateVerifiedProductionImageLease(lease);
  assert(lease.stage === stage, 'production image lease stage is invalid');
  const manifest = await dependencies.createManifest(stage);
  assert(manifest.stage === stage, 'owned-run manifest stage is invalid');
  let operations: FixtureProbeOperations;
  try {
    operations = dependencies.createOperations(manifest);
  } catch {
    try {
      await rm(manifest.tempDirectory, { recursive: true, force: false });
    } catch {
      throw fixtureError('owned cleanup failed');
    }
    throw fixtureError('fixture runtime verification failed');
  }
  const evidence = await executeFixtureRuntimeProbe(
    manifest,
    lease,
    operations
  );
  dependencies.report('[plan6b-fixture] complete', {
    project: manifest.project,
    imageDigest: lease.digest,
    acceptedOrderCount: evidence.acceptedOrderCount,
    checkoutSessionCount: evidence.checkoutSessionCount,
    completedFinancialScanCount: evidence.completedFinancialScanCount
  });
  return evidence;
}

const defaultCliDependencies: FixtureProbeCliDependencies = {
  runProduction: (stage, consumeImage) => runProductionSmoke(stage, consumeImage),
  runFixture: (stage, lease) => runFixtureRuntimeProbe(stage, lease)
};

export async function runFixtureRuntimeProbeCli(
  argumentsToParse: readonly string[],
  dependencies: FixtureProbeCliDependencies = defaultCliDependencies
): Promise<void> {
  const stage = parsePlan6bSmokeStage(argumentsToParse);
  await dependencies.runProduction(stage, async (lease) => {
    validateVerifiedProductionImageLease(lease);
    assert(lease.stage === stage, 'production image lease stage is invalid');
    await dependencies.runFixture(stage, lease);
  });
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isMain) {
  runFixtureRuntimeProbeCli(process.argv.slice(2)).catch(() => {
    console.error('[plan6b-fixture] failed');
    process.exitCode = 1;
  });
}
