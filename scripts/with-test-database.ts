import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { withoutStripeProviderSecrets } from './test-environment';

const project = `pale-orbit-test-${process.pid}`;
const testStoragePrefix = join(resolve(tmpdir()), 'pale-orbit-test-storage-');
const testStorageRoot = await mkdtemp(testStoragePrefix);
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

function publishedPort(service: string, containerPort: string): string {
  const output = capture('docker', [...composeArguments, 'port', service, containerPort]);
  const match = /:(\d+)$/.exec(output);
  if (!match?.[1]) throw new Error(`Could not parse ${service} port from ${output}`);
  return match[1];
}

async function startWorker(environment: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const worker = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    env: environment,
    stdio: 'inherit'
  });
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  worker.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  const readyFile = environment.WORKER_READY_FILE;
  if (!readyFile) throw new Error('WORKER_READY_FILE is required');
  const deadline = Date.now() + 15_000;
  while (!existsSync(readyFile)) {
    if (exit) {
      throw new Error(`Worker exited before readiness with ${exit.code ?? exit.signal ?? 'unknown'}`);
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for worker readiness');
    await delay(50);
  }
  return worker;
}

async function stopWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  worker.kill('SIGTERM');
  const exited = new Promise<boolean>((resolve) => {
    worker.once('exit', () => resolve(true));
    setTimeout(() => resolve(false), 2_000).unref();
  });
  if (!(await exited) && worker.exitCode === null && worker.signalCode === null) {
    worker.kill('SIGKILL');
    await new Promise<void>((resolve) => worker.once('exit', () => resolve()));
  }
}

let worker: ChildProcess | undefined;
try {
  runChecked('docker', [...composeArguments, 'up', '--detach', '--wait', '--wait-timeout', '90']);
  const postgresPort = publishedPort('postgres', '5432');
  const smtpPort = publishedPort('mailpit', '1025');
  const mailpitHttpPort = publishedPort('mailpit', '8025');

  const testEnvironment: NodeJS.ProcessEnv = {
    ...withoutStripeProviderSecrets(process.env),
    APP_ENV: 'test',
    APPLICATION_MODE: 'prototype',
    ORIGIN: 'http://127.0.0.1:4173',
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: postgresPort,
    DATABASE_NAME: 'pale_orbit_test',
    DATABASE_USER: 'pale_orbit_test',
    DATABASE_PASSWORD: 'pale_orbit_test_only',
    DATABASE_POOL_MAX: '5',
    DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_STATEMENT_TIMEOUT_MS: '30000',
    DATABASE_READINESS_TIMEOUT_MS: '2000',
    JOB_POLL_INTERVAL_MS: '25',
    JOB_LEASE_MS: '5000',
    JOB_RETRY_BASE_MS: '10',
    JOB_RETRY_MAX_MS: '1000',
    WORKER_READY_FILE: join(tmpdir(), `pale-orbit-worker-${process.pid}.ready`),
    WORKER_CONCURRENCY: '1',
    STORAGE_PROVIDER: 'local',
    STORAGE_LOCAL_ROOT: testStorageRoot,
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

  runChecked('npm', ['run', 'db:migrate:raw'], testEnvironment);
  if (withBootstrapAdmin) {
    runChecked('npm', ['run', 'admin:bootstrap:raw'], testEnvironment);
  }
  if (withWorker) worker = await startWorker(testEnvironment);

  const childInvocation = invocation(childCommand, childArguments);
  const child = spawnSync(childInvocation.command, childInvocation.args, {
    env: testEnvironment,
    stdio: 'inherit'
  });
  process.exitCode = child.status ?? 1;
} finally {
  if (worker) await stopWorker(worker);
  const resolvedStorageRoot = resolve(testStorageRoot);
  if (!resolvedStorageRoot.startsWith(testStoragePrefix)) {
    console.error('[test] refusing to remove an unexpected storage directory');
    process.exitCode = 1;
  } else {
    await rm(resolvedStorageRoot, { recursive: true, force: true });
  }
  runChecked('docker', [...composeArguments, 'down', '--volumes', '--remove-orphans']);
}
