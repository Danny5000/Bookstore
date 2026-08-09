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
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;
const temporaryRoots: string[] = [];

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
  writeFileSync(join(root, '.env.example'), 'APP_ENV=development\n', 'utf8');
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
      env: fixture.environment
    }
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describeOnWindows('start-dev.ps1', () => {
  it('creates .env and runs install, migration, and startup in order from any directory', () => {
    const fixture = createFixture();

    const result = runLauncher(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.root, '.env'), 'utf8')).toBe('APP_ENV=development\n');
    expect(readFileSync(fixture.logPath, 'utf8').trim().split(/\r?\n/)).toEqual([
      'docker compose version',
      'npm ci',
      'docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate',
      'docker compose --env-file .env --file compose.dev.yaml up --build --wait'
    ]);
    expect(result.stdout).toContain('http://localhost:5173');
    expect(result.stdout).toContain('http://localhost:8025');
    expect(result.stdout).toContain('logs --follow app worker');
    expect(result.stdout).toContain('down');
  });

  it('preserves an existing .env file', () => {
    const fixture = createFixture('DATABASE_PASSWORD=developer-owned\n');

    const result = runLauncher(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.root, '.env'), 'utf8')).toBe(
      'DATABASE_PASSWORD=developer-owned\n'
    );
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
});
