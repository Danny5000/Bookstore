# Development Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe PowerShell launcher that prepares, migrates, builds, and starts the fully containerized development environment, waits for health, prints useful follow-up commands, and returns to the shell.

**Architecture:** `scripts/start-dev.ps1` is a start-only orchestration boundary around the existing npm and Docker Compose interfaces. A Vitest test executes a copied launcher against temporary `.cmd` shims, proving ordering, environment-file preservation, failure propagation, and caller-directory independence without touching project containers or volumes.

**Tech Stack:** PowerShell 5.1+, Docker Compose, npm, Vitest, Node.js filesystem/process APIs

---

## File map

- Create `scripts/start-dev.ps1`: validate prerequisites, resolve the repository root, preserve or create `.env`, run install/migration/start commands, and print the handoff summary.
- Create `scripts/start-dev.test.ts`: exercise the PowerShell launcher against isolated command shims and temporary repository fixtures.
- Modify `vitest.config.ts`: include colocated tests under `scripts/` in the unit suite.
- Modify `README.md`: make the launcher the primary development entry point while retaining links to the manual runbooks.

### Task 1: Implement the tested PowerShell launcher

**Files:**
- Create: `scripts/start-dev.test.ts`
- Create: `scripts/start-dev.ps1`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Write the failing orchestration tests**

Create `scripts/start-dev.test.ts`:

```typescript
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
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(fixture.root, 'scripts', 'start-dev.ps1')],
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
```

- [ ] **Step 2: Run the focused test and verify the missing launcher fails**

Add the script test location to `vitest.config.ts` before running RED:

```typescript
include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
```

Run:

```powershell
npm run test:unit -- scripts/start-dev.test.ts
```

Expected: FAIL because `scripts/start-dev.ps1` does not exist when the fixture calls `copyFileSync`.

- [ ] **Step 3: Implement the minimal launcher**

Create `scripts/start-dev.ps1`:

```powershell
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ApplicationCommand {
  param(
    [Parameter(Mandatory)]
    [string] $Name
  )

  if (-not (Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found on PATH."
  }
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory)]
    [string] $FilePath,

    [string[]] $ArgumentList = @()
  )

  & $FilePath @ArgumentList
  $commandExitCode = $LASTEXITCODE

  if ($commandExitCode -ne 0) {
    $displayCommand = (@($FilePath) + $ArgumentList) -join ' '
    throw "Command failed with exit code ${commandExitCode}: $displayCommand"
  }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$exitCode = 0
$locationPushed = $false

try {
  Push-Location $repositoryRoot
  $locationPushed = $true

  foreach ($requiredCommand in @('node', 'npm', 'docker')) {
    Assert-ApplicationCommand -Name $requiredCommand
  }

  Invoke-CheckedCommand -FilePath 'docker' -ArgumentList @('compose', 'version')

  if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host '[start-dev] Created .env from .env.example.'
  } else {
    Write-Host '[start-dev] Using the existing .env file.'
  }

  Invoke-CheckedCommand -FilePath 'npm' -ArgumentList @('ci')

  $composeArguments = @('compose', '--env-file', '.env', '--file', 'compose.dev.yaml')
  Invoke-CheckedCommand -FilePath 'docker' -ArgumentList (
    $composeArguments + @('--profile', 'tools', 'run', '--rm', 'migrate')
  )
  Invoke-CheckedCommand -FilePath 'docker' -ArgumentList (
    $composeArguments + @('up', '--build', '--wait')
  )

  Write-Host ''
  Write-Host '[start-dev] Development services are healthy.'
  Write-Host '  Storefront: http://localhost:5173'
  Write-Host '  Mailpit:    http://localhost:8025'
  Write-Host ''
  Write-Host 'Follow logs:'
  Write-Host '  docker compose --env-file .env --file compose.dev.yaml logs --follow app worker'
  Write-Host ''
  Write-Host 'Stop services without deleting data:'
  Write-Host '  docker compose --env-file .env --file compose.dev.yaml down'
} catch {
  [Console]::Error.WriteLine("[start-dev] $($_.Exception.Message)")
  $exitCode = 1
} finally {
  if ($locationPushed) {
    Pop-Location
  }
}

exit $exitCode
```

- [ ] **Step 4: Run the focused test and verify all launcher cases pass**

Run:

```powershell
npm run test:unit -- scripts/start-dev.test.ts
```

Expected: 1 test file and 3 tests pass on Windows. On non-Windows hosts the suite is explicitly skipped because the launcher targets Windows PowerShell.

- [ ] **Step 5: Validate the PowerShell parser directly**

Run:

```powershell
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path 'scripts/start-dev.ps1'),
  [ref] $tokens,
  [ref] $errors
) | Out-Null

if ($errors.Count -ne 0) {
  $errors | Format-List
  throw 'PowerShell parser reported errors.'
}
```

Expected: no output and exit zero.

- [ ] **Step 6: Commit the launcher and tests**

```powershell
git add scripts/start-dev.ps1 scripts/start-dev.test.ts vitest.config.ts docs/superpowers/plans/2026-08-08-development-launcher.md
git commit -m "feat: add development launcher"
```

### Task 2: Document and verify the launch workflow

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Make the launcher the README entry point**

Replace the development command block in `README.md` with:

````markdown
```powershell
.\scripts\start-dev.ps1
```
````

Replace the paragraph immediately after it with:

```markdown
The launcher creates `.env` from `.env.example` when needed, installs the locked dependencies, applies committed migrations, and starts the app, worker, PostgreSQL, and Mailpit. It waits for healthy services and then returns to PowerShell. The storefront runs at `http://localhost:5173`; Mailpit runs at `http://localhost:8025`; the PostgreSQL-backed worker is private to Compose. See [runtime environments](docs/runtime-environments.md) and [database and workers](docs/database-and-workers.md) for manual startup, migrations, process secrets, health checks, tests, logs, shutdown, and cleanup commands.
```

- [ ] **Step 2: Run the focused launcher tests after the documentation edit**

Run:

```powershell
npm run test:unit -- scripts/start-dev.test.ts
```

Expected: 1 test file and 3 tests pass.

- [ ] **Step 3: Run the complete repository verification gate**

Run:

```powershell
npm run verify
```

Expected:

- Svelte checking reports zero errors and warnings.
- ESLint passes.
- All unit and PostgreSQL integration tests pass.
- All Chromium tests pass.
- Web, worker, and migration bundles build.

- [ ] **Step 4: Run a real launcher smoke test from outside the repository**

First ensure the default development Compose project is not already running:

```powershell
$existingContainers = docker compose --env-file .env --file compose.dev.yaml ps --quiet
if ($existingContainers) {
  throw 'The development stack is already running; preserve it and perform this smoke test when it is stopped.'
}
```

Then launch from the parent directory, verify both HTTP services, and stop the test stack without deleting data:

```powershell
$repositoryRoot = (Resolve-Path '.').Path
$launcher = Join-Path $repositoryRoot 'scripts/start-dev.ps1'

try {
  Push-Location (Split-Path -Parent $repositoryRoot)
  & $launcher
  if ($LASTEXITCODE -ne 0) { throw 'Development launcher failed.' }
} finally {
  Pop-Location
}

try {
  curl.exe --fail http://localhost:5173/health/live
  curl.exe --fail http://localhost:5173/health/ready
  curl.exe --fail http://localhost:8025/
  docker compose --env-file .env --file compose.dev.yaml ps
} finally {
  docker compose --env-file .env --file compose.dev.yaml down
}
```

Expected: the launcher exits zero after migration and service health, both app health endpoints and Mailpit return success, the app/worker/PostgreSQL/Mailpit services report healthy, and shutdown removes only the containers/network while retaining volumes.

- [ ] **Step 5: Inspect repository hygiene**

Run:

```powershell
git diff --check
git status --short
```

Expected: only `README.md` remains modified and no `.env`, logs, reports, readiness files, or database data are tracked.

- [ ] **Step 6: Commit the documentation**

```powershell
git add README.md
git commit -m "docs: document development launcher"
git status --short
```

Expected: the worktree is clean.
