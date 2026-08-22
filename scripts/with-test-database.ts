import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { databaseEnvironmentForRole } from '../src/lib/server/db/database-role-provision';
import { withoutTestProcessSecrets } from './test-environment';

const runId = randomBytes(8).toString('hex');
const project = `pale-orbit-test-${runId}`;
const testStoragePrefix = join(resolve(tmpdir()), 'pale-orbit-test-storage-');
const testStorageRoot = await mkdtemp(testStoragePrefix);
const workerReadyFile = join(testStorageRoot, 'worker.ready');
const composeArguments = ['compose', '--project-name', project, '--file', 'compose.test.yaml'];
const argumentsToParse = process.argv.slice(2);
let withWorker = false;
let withBootstrapAdmin = false;
while (argumentsToParse[0]?.startsWith('--')) {
  const flag = argumentsToParse.shift();
  if (flag === '--worker') withWorker = true;
  else if (flag === '--bootstrap-admin') withBootstrapAdmin = true;
  else throw new Error(`Unknown test service flag ${flag}`);
}
const childCommand = argumentsToParse.shift();
const childArguments = argumentsToParse;

if (!childCommand) {
  throw new Error('Expected a command to run after the test database starts');
}

interface CommandInvocation {
  command: string;
  args: string[];
}

function invocation(command: string, args: string[]): CommandInvocation {
  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error('npm_execpath is required to launch npm commands on Windows');
    const cli = command === 'npm' ? npmCli : join(dirname(npmCli), 'npx-cli.js');
    return { command: process.execPath, args: [cli, ...args] };
  }
  return { command, args };
}

function runChecked(command: string, args: string[], environment = process.env): void {
  const resolved = invocation(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    env: environment,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'no status'}`);
  }
}

function capture(command: string, args: string[]): string {
  const resolved = invocation(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'no status'}`);
  }
  return result.stdout.trim();
}

type DockerResourceKind = 'container' | 'network' | 'volume';

const expectedExactDockerResources: ReadonlyArray<{
  kind: DockerResourceKind;
  name: string;
}> = [
  { kind: 'container', name: `${project}-postgres-1` },
  { kind: 'container', name: `${project}-mailpit-1` },
  { kind: 'network', name: `${project}_default` }
];

function identifiers(output: string): string[] {
  return output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
}

function projectResourceIds(kind: DockerResourceKind): string[] {
  const filter = `label=com.docker.compose.project=${project}`;
  const args = kind === 'container'
    ? ['ps', '--all', '--quiet', '--filter', filter]
    : [kind, 'ls', '--quiet', '--filter', filter];
  return identifiers(capture('docker', args));
}

function exactResourceIds(kind: DockerResourceKind, name: string): string[] {
  const filter = kind === 'container' ? `name=^/${name}$` : `name=^${name}$`;
  const args = kind === 'container'
    ? ['ps', '--all', '--quiet', '--filter', filter]
    : [kind, 'ls', '--quiet', '--filter', filter];
  return identifiers(capture('docker', args));
}

function projectLabel(kind: DockerResourceKind, id: string): string {
  const labels = kind === 'container' ? '.Config.Labels' : '.Labels';
  return capture('docker', [
    kind,
    'inspect',
    '--format',
    `{{ index ${labels} "com.docker.compose.project" }}`,
    id
  ]);
}

function assertNoComposeResourceCollision(): void {
  for (const kind of ['container', 'network', 'volume'] as const) {
    if (projectResourceIds(kind).length > 0) {
      throw new Error(`Refusing to reuse existing Docker ${kind} resources for ${project}`);
    }
  }
  for (const { kind, name } of expectedExactDockerResources) {
    if (exactResourceIds(kind, name).length > 0) {
      throw new Error(`Refusing to reuse exact-name Docker ${kind} ${name}`);
    }
  }
}

function assertComposeResourcesOwned(): void {
  for (const kind of ['container', 'network', 'volume'] as const) {
    for (const id of projectResourceIds(kind)) {
      if (projectLabel(kind, id) !== project) {
        throw new Error(`Refusing to remove foreign Docker ${kind} ${id}`);
      }
    }
  }
  for (const { kind, name } of expectedExactDockerResources) {
    for (const id of exactResourceIds(kind, name)) {
      if (projectLabel(kind, id) !== project) {
        throw new Error(`Refusing to remove foreign exact-name Docker ${kind} ${name}`);
      }
    }
  }
}

function publishedPort(service: string, containerPort: string): string {
  const output = capture('docker', [...composeArguments, 'port', service, containerPort]);
  const match = /:(\d+)$/.exec(output);
  if (!match?.[1]) throw new Error(`Could not parse ${service} port from ${output}`);
  return match[1];
}

async function startWorker(environment: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const readyFile = environment.WORKER_READY_FILE;
  if (!readyFile) throw new Error('WORKER_READY_FILE is required');
  if (existsSync(readyFile)) throw new Error('Worker readiness file already exists');
  const worker = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    env: environment,
    stdio: 'inherit'
  });
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  worker.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(readyFile)) {
      if (exit) {
        throw new Error(
          `Worker exited before readiness with ${exit.code ?? exit.signal ?? 'unknown'}`
        );
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for worker readiness');
      await delay(50);
    }
    return worker;
  } catch (cause: unknown) {
    await stopWorker(worker);
    throw cause;
  }
}

async function stopWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
  worker.kill('SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(2_000).then(() => false)
  ]);
  if (stopped) return;
  if (worker.exitCode === null && worker.signalCode === null) {
    worker.kill('SIGKILL');
  }
  await exited;
}

let worker: ChildProcess | undefined;
let composeMutationStarted = false;
try {
  assertNoComposeResourceCollision();
  composeMutationStarted = true;
  runChecked('docker', [...composeArguments, 'up', '--detach', '--wait', '--wait-timeout', '90']);
  const postgresPort = publishedPort('postgres', '5432');
  const smtpPort = publishedPort('mailpit', '1025');
  const mailpitHttpPort = publishedPort('mailpit', '8025');

  const webEnvironment: NodeJS.ProcessEnv = {
    ...withoutTestProcessSecrets(process.env),
    APP_ENV: 'test',
    PALE_ORBIT_TEST_PROJECT: project,
    APPLICATION_MODE: 'prototype',
    ORIGIN: 'http://127.0.0.1:4173',
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: postgresPort,
    DATABASE_NAME: 'pale_orbit_test',
    DATABASE_OWNER_USER: 'pale_orbit_test',
    DATABASE_OWNER_PASSWORD: 'pale_orbit_test_only',
    DATABASE_USER: 'pale_orbit_test_web',
    DATABASE_PASSWORD: 'pale-orbit-test-web-password-2026',
    DATABASE_WORKER_USER: 'pale_orbit_test_worker',
    DATABASE_WORKER_PASSWORD: 'pale-orbit-test-worker-password-2026',
    DATABASE_STORAGE_CLEANUP_USER: 'pale_orbit_test_storage_cleanup',
    DATABASE_STORAGE_CLEANUP_PASSWORD: 'pale-orbit-test-storage-cleanup-password-2026',
    DATABASE_POOL_MAX: '5',
    DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_STATEMENT_TIMEOUT_MS: '30000',
    DATABASE_READINESS_TIMEOUT_MS: '2000',
    JOB_POLL_INTERVAL_MS: '25',
    JOB_LEASE_MS: '5000',
    JOB_RETRY_BASE_MS: '10',
    JOB_RETRY_MAX_MS: '1000',
    WORKER_READY_FILE: workerReadyFile,
    WORKER_CONCURRENCY: '1',
    STORAGE_PROVIDER: 'local',
    STORAGE_STAGING_ROOT: join(testStorageRoot, 'staging'),
    STORAGE_PUBLICATION_ROOT: join(testStorageRoot, 'publication'),
    STORAGE_COVERS_ROOT: join(testStorageRoot, 'covers'),
    STORAGE_SCRATCH_ROOT: join(testStorageRoot, 'scratch'),
    UPLOAD_MAX_BYTES: '1048576',
    INGEST_MAX_EXPANDED_BYTES: '4194304',
    INGEST_MAX_ENTRIES: '1000',
    INGEST_MAX_XML_BYTES: '1048576',
    INGEST_MAX_IMAGE_PIXELS: '100000000',
    INGEST_MAX_COMPRESSION_RATIO: '200',
    INGEST_TIMEOUT_MS: '60000',
    STORAGE_STAGING_RETENTION_HOURS: '1',
    STORAGE_ORPHAN_RETENTION_HOURS: '2',
    AUTH_SECRET: 'test-only-auth-secret-at-least-thirty-two-bytes',
    AUTH_SESSION_EXPIRES_SECONDS: '3600',
    AUTH_VERIFICATION_EXPIRES_SECONDS: '600',
    AUTH_RESET_EXPIRES_SECONDS: '600',
    AUTH_MAGIC_EXPIRES_SECONDS: '600',
    AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
    AUTH_RATE_LIMIT_MAX: '100',
    AUTH_LOGIN_RATE_LIMIT_MAX: '5',
    AUTH_EMAIL_RATE_LIMIT_MAX: '3',
    STRIPE_ENABLED: 'false',
    STRIPE_TEST_FIXTURE_MODE: withWorker ? 'true' : 'false',
    STRIPE_LIVE_MODE: 'false',
    STRIPE_AUTOMATIC_TAX_ENABLED: 'false',
    STRIPE_CHECKOUT_DURATION_SECONDS: '1800',
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: '300',
    COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS: '60',
    COMMERCE_CHECKOUT_RATE_LIMIT_MAX: '5',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: smtpPort,
    SMTP_SECURE: 'false',
    SMTP_REQUIRE_TLS: 'false',
    SMTP_FROM: 'Pale Orbit Test <books@paleorbit.test>',
    SMTP_CONNECTION_TIMEOUT_MS: '5000',
    SMTP_GREETING_TIMEOUT_MS: '5000',
    SMTP_SOCKET_TIMEOUT_MS: '10000',
    MAILPIT_HTTP_URL: `http://127.0.0.1:${mailpitHttpPort}`,
    ...(withBootstrapAdmin
      ? {
          BOOTSTRAP_ADMIN_EMAIL: 'admin@paleorbit.test',
          BOOTSTRAP_ADMIN_NAME: 'Test Administrator',
          BOOTSTRAP_ADMIN_PASSWORD: 'test-admin-password-2026'
        }
      : {})
  };
  const ownerEnvironment: NodeJS.ProcessEnv = {
    ...databaseEnvironmentForRole(webEnvironment, 'owner')
  };
  ownerEnvironment.DATABASE_MIGRATION_WEB_USER = webEnvironment.DATABASE_USER;
  ownerEnvironment.DATABASE_MIGRATION_WORKER_USER = webEnvironment.DATABASE_WORKER_USER;
  ownerEnvironment.DATABASE_MIGRATION_STORAGE_CLEANUP_USER = webEnvironment.DATABASE_STORAGE_CLEANUP_USER;
  delete ownerEnvironment.DATABASE_WORKER_USER;
  delete ownerEnvironment.DATABASE_WORKER_USER_FILE;
  delete ownerEnvironment.DATABASE_WORKER_PASSWORD;
  delete ownerEnvironment.DATABASE_WORKER_PASSWORD_FILE;
  delete ownerEnvironment.DATABASE_STORAGE_CLEANUP_USER;
  delete ownerEnvironment.DATABASE_STORAGE_CLEANUP_USER_FILE;
  delete ownerEnvironment.DATABASE_STORAGE_CLEANUP_PASSWORD;
  delete ownerEnvironment.DATABASE_STORAGE_CLEANUP_PASSWORD_FILE;
  delete ownerEnvironment.BOOTSTRAP_ADMIN_EMAIL;
  delete ownerEnvironment.BOOTSTRAP_ADMIN_EMAIL_FILE;
  delete ownerEnvironment.BOOTSTRAP_ADMIN_NAME;
  delete ownerEnvironment.BOOTSTRAP_ADMIN_NAME_FILE;
  delete ownerEnvironment.BOOTSTRAP_ADMIN_PASSWORD;
  delete ownerEnvironment.BOOTSTRAP_ADMIN_PASSWORD_FILE;

  const provisionEnvironment = { ...webEnvironment };
  delete provisionEnvironment.BOOTSTRAP_ADMIN_EMAIL;
  delete provisionEnvironment.BOOTSTRAP_ADMIN_EMAIL_FILE;
  delete provisionEnvironment.BOOTSTRAP_ADMIN_NAME;
  delete provisionEnvironment.BOOTSTRAP_ADMIN_NAME_FILE;
  delete provisionEnvironment.BOOTSTRAP_ADMIN_PASSWORD;
  delete provisionEnvironment.BOOTSTRAP_ADMIN_PASSWORD_FILE;

  const bootstrapEnvironment = { ...webEnvironment };
  delete bootstrapEnvironment.DATABASE_OWNER_USER;
  delete bootstrapEnvironment.DATABASE_OWNER_USER_FILE;
  delete bootstrapEnvironment.DATABASE_OWNER_PASSWORD;
  delete bootstrapEnvironment.DATABASE_OWNER_PASSWORD_FILE;
  delete bootstrapEnvironment.DATABASE_WORKER_USER;
  delete bootstrapEnvironment.DATABASE_WORKER_USER_FILE;
  delete bootstrapEnvironment.DATABASE_WORKER_PASSWORD;
  delete bootstrapEnvironment.DATABASE_WORKER_PASSWORD_FILE;
  delete bootstrapEnvironment.DATABASE_STORAGE_CLEANUP_USER;
  delete bootstrapEnvironment.DATABASE_STORAGE_CLEANUP_USER_FILE;
  delete bootstrapEnvironment.DATABASE_STORAGE_CLEANUP_PASSWORD;
  delete bootstrapEnvironment.DATABASE_STORAGE_CLEANUP_PASSWORD_FILE;

  const workerEnvironment = databaseEnvironmentForRole(webEnvironment, 'worker');
  delete workerEnvironment.DATABASE_USER;
  delete workerEnvironment.DATABASE_USER_FILE;
  delete workerEnvironment.DATABASE_PASSWORD;
  delete workerEnvironment.DATABASE_PASSWORD_FILE;
  delete workerEnvironment.DATABASE_OWNER_USER;
  delete workerEnvironment.DATABASE_OWNER_USER_FILE;
  delete workerEnvironment.DATABASE_OWNER_PASSWORD;
  delete workerEnvironment.DATABASE_OWNER_PASSWORD_FILE;
  delete workerEnvironment.DATABASE_STORAGE_CLEANUP_USER;
  delete workerEnvironment.DATABASE_STORAGE_CLEANUP_USER_FILE;
  delete workerEnvironment.DATABASE_STORAGE_CLEANUP_PASSWORD;
  delete workerEnvironment.DATABASE_STORAGE_CLEANUP_PASSWORD_FILE;
  delete workerEnvironment.BOOTSTRAP_ADMIN_EMAIL;
  delete workerEnvironment.BOOTSTRAP_ADMIN_EMAIL_FILE;
  delete workerEnvironment.BOOTSTRAP_ADMIN_NAME;
  delete workerEnvironment.BOOTSTRAP_ADMIN_NAME_FILE;
  delete workerEnvironment.BOOTSTRAP_ADMIN_PASSWORD;
  delete workerEnvironment.BOOTSTRAP_ADMIN_PASSWORD_FILE;

  runChecked('npm', ['run', 'db:migrate:raw'], ownerEnvironment);
  runChecked('npm', ['run', 'db:provision-roles:raw'], provisionEnvironment);
  if (withBootstrapAdmin) {
    runChecked('npm', ['run', 'admin:bootstrap:raw'], bootstrapEnvironment);
  }
  if (withWorker) worker = await startWorker(workerEnvironment);

  const childInvocation = invocation(childCommand, childArguments);
  const child = spawnSync(childInvocation.command, childInvocation.args, {
    env: webEnvironment,
    stdio: 'inherit'
  });
  process.exitCode = child.status ?? 1;
} finally {
  try {
    if (worker) await stopWorker(worker);
  } finally {
    try {
      const resolvedStorageRoot = resolve(testStorageRoot);
      if (!resolvedStorageRoot.startsWith(testStoragePrefix)) {
        console.error('[test] refusing to remove an unexpected storage directory');
        process.exitCode = 1;
      } else {
        await rm(resolvedStorageRoot, { recursive: true, force: true });
      }
    } finally {
      if (composeMutationStarted) {
        assertComposeResourcesOwned();
        runChecked('docker', [...composeArguments, 'down', '--volumes', '--remove-orphans']);
        assertNoComposeResourceCollision();
      }
    }
  }
}
