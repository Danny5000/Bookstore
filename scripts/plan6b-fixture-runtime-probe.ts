import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runProductionSmoke,
  validateVerifiedProductionImageLease,
  type ProductionImageLeaseConsumer,
  type VerifiedProductionImageLease
} from './plan6b-production-smoke';

export interface FixtureProbeManifest {
  readonly version: 1;
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
}

export interface FixtureProbeOperations {
  acquireImage(
    manifest: FixtureProbeManifest,
    lease: VerifiedProductionImageLease
  ): Promise<void>;
  revalidatePorts(manifest: FixtureProbeManifest): Promise<void>;
  startDependencies(manifest: FixtureProbeManifest): Promise<void>;
  migrate(manifest: FixtureProbeManifest): Promise<void>;
  seedPublishedTitles(manifest: FixtureProbeManifest): Promise<void>;
  startRuntime(manifest: FixtureProbeManifest): Promise<void>;
  exerciseQuoteAndCheckout(manifest: FixtureProbeManifest): Promise<void>;
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
    allowFailure?: boolean
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
  readonly createManifest: () => Promise<FixtureProbeManifest>;
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
    consumeImage: ProductionImageLeaseConsumer
  ) => Promise<unknown>;
  readonly runFixture: (
    lease: VerifiedProductionImageLease
  ) => Promise<FixtureProbeEvidence>;
}

const RUN_PREFIX = 'pale-orbit-plan6b-fixture-';
const TEMP_PREFIX = join(resolve(tmpdir()), RUN_PREFIX);
const STRIPE_ATTEMPT_COUNTER_DIRECTORY = '/var/lib/pale-orbit/stripe-attempts';
const STRIPE_ATTEMPT_COUNTER_FILE = `${STRIPE_ATTEMPT_COUNTER_DIRECTORY}/count`;
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
  'workerReady'
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
    manifest.imageTag === `pale-orbit:plan6b-i-fixture-${manifest.runId}`,
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
      com.paleorbit.plan6b-fixture.owner: ${manifest.ownershipToken}`;
  return `x-fixture-environment: &fixture-environment
  NODE_ENV: production
  APP_ENV: test
  APPLICATION_MODE: prototype
  ORIGIN: http://${manifest.webHost}:${manifest.webPort}
  DATABASE_HOST: postgres
  DATABASE_PORT: "5432"
  DATABASE_NAME: pale_orbit_test
  DATABASE_USER: pale_orbit_test
  DATABASE_PASSWORD: pale_orbit_test_only
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
  STORAGE_LOCAL_ROOT: /var/lib/pale-orbit/storage
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
    labels:
      ${labels}
    ports: !override
      - "${manifest.webHost}:${manifest.webPort}:3000"
    volumes:
      - book_storage:/var/lib/pale-orbit/storage
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
    labels:
      ${labels}
    volumes:
      - book_storage:/var/lib/pale-orbit/storage
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
  migrate:
    profiles: [tools]
    image: ${manifest.imageTag}
    command: [node, build/services/migrate.js]
    environment:
      <<: *fixture-environment
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
  book_storage:
    labels:
      ${labels}
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

async function assertNoDockerCollision(
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
  for (const [resource, name] of [
    ...['postgres', 'mailpit', 'stripe_api_canary', 'app', 'worker'].map((service) => (
      ['container', `${manifest.project}-${service}-1`] as const
    )),
    ['network', `${manifest.project}_default`] as const,
    ...['stripe_attempts', 'book_storage'].map((volume) => (
      ['volume', `${manifest.project}_${volume}`] as const
    ))
  ]) {
    const argumentsToCapture = resource === 'container'
      ? ['ps', '--all', '--filter', `name=${name}`, '--format', '{{.Names}}']
      : [resource, 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}'];
    assert(
      !(await captureIdentifiers(dependencies, environment, argumentsToCapture)).includes(name),
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
      labels['com.paleorbit.plan6b-smoke.owner'] === lease.productionOwnershipToken,
    `${description} ownership is invalid`
  );
}

export function createFixtureProbeDockerOperations(
  manifest: FixtureProbeManifest,
  dependencies: FixtureProbeDockerDependencies
): FixtureProbeOperations {
  validateFixtureProbeManifest(manifest);
  const environment = dockerEnvironment(dependencies.environment);
  const compose = composeArguments(manifest);
  let aliasCreated = false;
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
    async startDependencies() {
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
    async migrate() {
      await dependencies.command.run([
        ...compose,
        '--profile',
        'tools',
        'run',
        '--rm',
        'migrate'
      ], environment);
    },
    async seedPublishedTitles(owned) {
      validateFixtureProbeManifest(owned);
      await dependencies.command.run(psqlArguments(owned, seedFixtureSql(owned)), environment);
    },
    async startRuntime() {
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
        assert(
          acceptedOrderCount === 1 && checkoutSessionCount === 1 &&
            completedFinancialScanCount <= 1,
          'fixture database evidence is invalid'
        );
        if (completedFinancialScanCount === 1 && unsafeFinancialJobCount === 0) {
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
            workerReady: true
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

export async function createFixtureProbeManifest(): Promise<FixtureProbeManifest> {
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
        version: 1,
        runId,
        ownershipToken: randomBytes(16).toString('hex'),
        project: `${RUN_PREFIX}${runId}`,
        imageTag: `pale-orbit:plan6b-i-fixture-${runId}`,
        tempDirectory,
        overrideFile: join(tempDirectory, 'compose.override.yaml'),
        manifestFile: join(tempDirectory, 'owned-run.json'),
        webHost: '127.0.0.1',
        webPort,
        databaseHost: '127.0.0.1',
        databasePort
      };
      validateFixtureProbeManifest(manifest);
      await Promise.all([
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
}

export async function executeFixtureRuntimeProbe(
  manifest: FixtureProbeManifest,
  lease: VerifiedProductionImageLease,
  operations: FixtureProbeOperations
): Promise<FixtureProbeEvidence> {
  validateFixtureProbeManifest(manifest);
  validateVerifiedProductionImageLease(lease);
  let evidence: FixtureProbeEvidence | undefined;
  let failed = false;
  try {
    await operations.acquireImage(manifest, lease);
    await operations.revalidatePorts(manifest);
    await operations.startDependencies(manifest);
    await operations.migrate(manifest);
    await operations.seedPublishedTitles(manifest);
    await operations.startRuntime(manifest);
    await operations.exerciseQuoteAndCheckout(manifest);
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
    allowFailure = false
  ): Promise<FixtureProbeCommandResult> => {
    const result = spawnSync('docker', [...argumentsToCapture], {
      cwd: resolve('.'),
      env: environment,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
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
  lease: VerifiedProductionImageLease,
  dependencies: FixtureProbeRunDependencies = defaultRunDependencies
): Promise<FixtureProbeEvidence> {
  validateVerifiedProductionImageLease(lease);
  const manifest = await dependencies.createManifest();
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
  runProduction: (consumeImage) => runProductionSmoke(consumeImage),
  runFixture: (lease) => runFixtureRuntimeProbe(lease)
};

export async function runFixtureRuntimeProbeCli(
  dependencies: FixtureProbeCliDependencies = defaultCliDependencies
): Promise<void> {
  await dependencies.runProduction(async (lease) => {
    validateVerifiedProductionImageLease(lease);
    await dependencies.runFixture(lease);
  });
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isMain) {
  runFixtureRuntimeProbeCli().catch(() => {
    console.error('[plan6b-fixture] failed');
    process.exitCode = 1;
  });
}
