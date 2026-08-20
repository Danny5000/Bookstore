import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const launcherSource = join(projectRoot, 'scripts', 'start-dev.ps1');
const readme = readFileSync(join(projectRoot, 'README.md'), 'utf8');
const databaseWorkerRunbook = readFileSync(
  join(projectRoot, 'docs', 'database-and-workers.md'),
  'utf8'
);
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;
const launcherProcessTimeoutMs = 15_000;
const temporaryRoots: string[] = [];
const validEnvironment = [
  'APP_ENV=development',
  'DATABASE_OWNER_USER=pale_orbit_owner',
  'DATABASE_OWNER_PASSWORD=legacy-owner-secret',
  'DATABASE_USER=pale_orbit_web',
  `DATABASE_PASSWORD=${'w'.repeat(40)}`,
  'DATABASE_WORKER_USER=pale_orbit_worker',
  `DATABASE_WORKER_PASSWORD=${'f'.repeat(40)}`,
  'DATABASE_STORAGE_CLEANUP_USER=pale_orbit_storage_cleanup_login',
  `DATABASE_STORAGE_CLEANUP_PASSWORD=${'c'.repeat(40)}`
].join('\n') + '\n';

interface Fixture {
  root: string;
  logPath: string;
  environment: NodeJS.ProcessEnv;
}

function writeCommandShim(path: string, body: string): void {
  writeFileSync(path, `@echo off\r\n${body}\r\n`, 'utf8');
}

function createFixture(existingEnvironment?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'pale-orbit-start-dev-'));
  temporaryRoots.push(root);

  const scriptsDirectory = join(root, 'scripts');
  const shimDirectory = join(root, 'command-shims');
  mkdirSync(scriptsDirectory);
  mkdirSync(shimDirectory);
  copyFileSync(launcherSource, join(scriptsDirectory, 'start-dev.ps1'));
  writeFileSync(join(root, '.env.example'), validEnvironment, 'utf8');
  writeFileSync(join(root, 'compose.dev.yaml'), 'services: {}\n', 'utf8');
  writeFileSync(join(root, 'package-lock.json'), '{}\n', 'utf8');

  if (existingEnvironment !== undefined) {
    writeFileSync(join(root, '.env'), existingEnvironment, 'utf8');
  }

  writeCommandShim(join(shimDirectory, 'node.cmd'), 'exit /b 0');
  writeCommandShim(
    join(shimDirectory, 'npm.cmd'),
    [
      'echo npm %*>>"%START_DEV_LOG%"',
      'if "%MOCK_NPM_EXIT_CODE%"=="" exit /b 0',
      'exit /b %MOCK_NPM_EXIT_CODE%'
    ].join('\r\n')
  );
  writeCommandShim(
    join(shimDirectory, 'docker.cmd'),
    [
      'echo docker %*>>"%START_DEV_LOG%"',
      'if "%MOCK_DOCKER_FAIL_ON%"=="" exit /b 0',
      'echo %* | findstr /C:"%MOCK_DOCKER_FAIL_ON%" >nul',
      'if %errorlevel%==0 exit /b 9',
      'exit /b 0'
    ].join('\r\n')
  );

  const logPath = join(root, 'commands.log');
  return {
    root,
    logPath,
    environment: {
      ...process.env,
      PATH: `${shimDirectory};${process.env.PATH ?? ''}`,
      START_DEV_LOG: logPath
    }
  };
}

function runLauncher(fixture: Fixture) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(fixture.root, 'scripts', 'start-dev.ps1')
    ],
    {
      cwd: dirname(fixture.root),
      encoding: 'utf8',
      env: fixture.environment,
      timeout: launcherProcessTimeoutMs
    }
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describeOnWindows('start-dev.ps1', { timeout: launcherProcessTimeoutMs + 5_000 }, () => {
  it('creates .env and runs install, migration, and startup in order from any directory', () => {
    const fixture = createFixture();

    const result = runLauncher(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.root, '.env'), 'utf8')).toBe(validEnvironment);
    expect(readFileSync(fixture.logPath, 'utf8').trim().split(/\r?\n/)).toEqual([
      'docker compose version',
      'npm ci',
      'docker compose --env-file .env --file compose.dev.yaml stop app worker storage-cleanup',
      'docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate',
      'docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm database-role-provision',
      'docker compose --env-file .env --file compose.dev.yaml up --build --wait'
    ]);
    expect(result.stdout).toContain('http://localhost:5173');
    expect(result.stdout).toContain('http://localhost:8025');
    expect(result.stdout).toContain('logs --follow app worker');
    expect(result.stdout).toContain('down');
  });

  it('preserves an existing .env file', () => {
    const existingEnvironment = `${validEnvironment}DEVELOPER_OWNED=yes\n`;
    const fixture = createFixture(existingEnvironment);

    const result = runLauncher(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.root, '.env'), 'utf8')).toBe(existingEnvironment);
  });

  it('rejects a pre-split .env before migration and preserves it for operator upgrade', () => {
    const legacyEnvironment = [
      'DATABASE_USER=pale_orbit',
      'DATABASE_PASSWORD=legacy-secret'
    ].join('\n') + '\n';
    const fixture = createFixture(legacyEnvironment);

    const result = runLauncher(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('predates the owner/web/worker database role split');
    expect(result.stderr).toContain(
      'Move the existing DATABASE_USER and DATABASE_PASSWORD values to DATABASE_OWNER_USER and DATABASE_OWNER_PASSWORD'
    );
    expect(readFileSync(join(fixture.root, '.env'), 'utf8')).toBe(legacyEnvironment);
    expect(existsSync(fixture.logPath) ? readFileSync(fixture.logPath, 'utf8') : '')
      .not.toContain('run --rm migrate');
  });

  it('rejects reused database role passwords before install or migration', () => {
    const fixture = createFixture(validEnvironment.replace(
      `DATABASE_STORAGE_CLEANUP_PASSWORD=${'c'.repeat(40)}`,
      `DATABASE_STORAGE_CLEANUP_PASSWORD=${'w'.repeat(40)}`
    ));

    const result = runLauncher(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'distinct owner, web, worker, and storage-cleanup database passwords'
    );
    expect(readFileSync(fixture.logPath, 'utf8')).not.toContain('npm ci');
    expect(readFileSync(fixture.logPath, 'utf8')).not.toContain('run --rm migrate');
  });

  it('does not migrate when quiescing an existing app, worker, or cleanup process fails', () => {
    const fixture = createFixture();
    fixture.environment.MOCK_DOCKER_FAIL_ON = 'stop app worker storage-cleanup';

    const result = runLauncher(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed with exit code 9');
    expect(readFileSync(fixture.logPath, 'utf8')).not.toContain('run --rm migrate');
  });

  it('rejects an owner/web/worker environment missing the dedicated cleanup pair', () => {
    const withoutCleanup = validEnvironment
      .split(/\r?\n/u)
      .filter((line) => !line.startsWith('DATABASE_STORAGE_CLEANUP_'))
      .join('\n');
    const fixture = createFixture(`${withoutCleanup}\n`);

    const result = runLauncher(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('predates the dedicated storage-cleanup database role');
    expect(result.stderr).toContain('DATABASE_STORAGE_CLEANUP_USER');
    expect(result.stderr).not.toContain('Move the existing DATABASE_USER');
    expect(existsSync(fixture.logPath) ? readFileSync(fixture.logPath, 'utf8') : '')
      .not.toContain('npm ci');
  });

  it('rejects the reserved cleanup group name as a login before install', () => {
    const fixture = createFixture(validEnvironment.replace(
      'DATABASE_STORAGE_CLEANUP_USER=pale_orbit_storage_cleanup_login',
      'DATABASE_STORAGE_CLEANUP_USER=pale_orbit_storage_cleanup'
    ));

    const result = runLauncher(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid new database login');
    expect(existsSync(fixture.logPath) ? readFileSync(fixture.logPath, 'utf8') : '')
      .not.toContain('npm ci');
  });

  it('stops before startup when migration fails', () => {
    const fixture = createFixture();
    fixture.environment.MOCK_DOCKER_FAIL_ON = 'run --rm migrate';

    const result = runLauncher(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed with exit code 9');
    expect(readFileSync(fixture.logPath, 'utf8')).not.toContain('up --build --wait');
    expect(existsSync(join(fixture.root, '.env'))).toBe(true);
  });

  it('stops before startup when database role provisioning fails', () => {
    const fixture = createFixture();
    fixture.environment.MOCK_DOCKER_FAIL_ON = 'run --rm database-role-provision';

    const result = runLauncher(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed with exit code 9');
    expect(readFileSync(fixture.logPath, 'utf8')).not.toContain('up --build --wait');
  });
});

describe('development database role upgrade documentation', () => {
  it.each([
    ['README', readme],
    ['database and worker runbook', databaseWorkerRunbook]
  ])('maps the pre-split login to owner and quiesces containers in the %s', (_label, source) => {
    expect(source).toContain(
      'move the current `DATABASE_USER` and `DATABASE_PASSWORD` values to `DATABASE_OWNER_USER` and `DATABASE_OWNER_PASSWORD`'
    );
    const stop = source.indexOf(
      'docker compose --env-file .env --file compose.dev.yaml stop app worker storage-cleanup'
    );
    const migrate = source.indexOf(
      'docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate'
    );
    expect(stop).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(stop);
  });

  it('requires host-run web, worker, and cleanup processes to stop before upgrading', () => {
    expect(databaseWorkerRunbook).toContain(
      'Stop any host-run web, worker, and storage-cleanup processes before migration or role provisioning.'
    );
  });
});
