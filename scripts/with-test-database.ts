import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const project = `pale-orbit-test-${process.pid}`;
const composeArguments = ['compose', '--project-name', project, '--file', 'compose.test.yaml'];
const childCommand = process.argv[2];
const childArguments = process.argv.slice(3);

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

try {
  runChecked('docker', [...composeArguments, 'up', '--detach', '--wait', '--wait-timeout', '90']);
  const portOutput = capture('docker', [...composeArguments, 'port', 'postgres', '5432']);
  const portMatch = /:(\d+)$/.exec(portOutput);
  if (!portMatch?.[1]) throw new Error(`Could not parse PostgreSQL port from ${portOutput}`);

  const testEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: 'test',
    APPLICATION_MODE: 'prototype',
    ORIGIN: 'http://127.0.0.1:4173',
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: portMatch[1],
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
    WORKER_READY_FILE: join(tmpdir(), `pale-orbit-worker-${process.pid}.ready`)
  };

  const childInvocation = invocation(childCommand, childArguments);
  const child = spawnSync(childInvocation.command, childInvocation.args, {
    env: testEnvironment,
    stdio: 'inherit'
  });
  process.exitCode = child.status ?? 1;
} finally {
  runChecked('docker', [...composeArguments, 'down', '--volumes', '--remove-orphans']);
}
