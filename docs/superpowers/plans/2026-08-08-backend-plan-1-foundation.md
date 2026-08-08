# Backend Plan 1: Test Foundation, Environments, and Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a tested, reproducible backend foundation around the existing SvelteKit prototype: browser regression coverage, validated runtime configuration, exact Node/PostgreSQL/Mailpit/Caddy containers, and safe development and production Compose stacks.

**Architecture:** Keep the application as one `adapter-node` SvelteKit service. A small server-only configuration module resolves ordinary environment values and Docker-style `_FILE` secrets, validates the complete configuration once during SvelteKit server initialization, and exposes a typed immutable result. Development runs the prototype with PostgreSQL and Mailpit through Compose. Production runs the built Node service behind Caddy with PostgreSQL private to the Compose network and a process-sourced database-password secret. Until later plans replace the prototype identity, checkout, delivery, and content paths, production starts in an explicit maintenance mode that exposes only liveness and readiness endpoints.

**Tech Stack:** Node.js 26.7.0, npm 11.19.0, SvelteKit 2 with `@sveltejs/adapter-node`, Svelte 5, TypeScript 6.0.3, Vitest 4, Playwright 1.62.1, Zod 4.4.3, PostgreSQL 18.4, Mailpit 1.30.0, Caddy 2.11.4, Docker Compose 2.

---

## Source documents and execution constraints

- Approved design: `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md`
- Dependency rationale: `docs/dependency-decisions.md`
- Stable starting point: `main` at commit `8e0b1eb`
- Execute in an isolated feature worktree created from `main`.
- Use test-driven development for every behavior change: add the failing test, observe the intended failure, implement the minimum behavior, and rerun the focused test.
- Preserve the prototype's current appearance and development behavior except for the explicit guided-comic regression fix.
- Do not add Drizzle, a PostgreSQL driver, migrations, Better Auth, an SMTP library, a worker, durable storage, or Redis. Those belong to Plans 2 through 4.
- PostgreSQL is provisioned in this plan, but readiness only proves that validated configuration and the web process are available. Plan 2 extends readiness with an actual database probe when the database adapter exists.
- Mailpit is provisioned in development, but the provider-neutral SMTP adapter remains Plan 3 work.
- The production stack must not expose the prototype's raw-email cookie identity, client-side purchase grants, in-memory entitlements, or fake delivery behavior. `APPLICATION_MODE=maintenance` blocks every path except `/health/live` and `/health/ready`.
- Production secrets originate in the invoking process environment and use Compose's top-level `secrets.environment` source. No production `.env` file is created, copied into an image, or referenced by `compose.prod.yaml`.
- The PostgreSQL 18 data volume mounts `/var/lib/postgresql`, matching the PostgreSQL 18 official-image layout. Do not use the pre-18 `/var/lib/postgresql/data` volume target.
- The production Compose baseline includes the web service, PostgreSQL, and Caddy. Plan 2 adds the worker once a real worker entry point and PostgreSQL-backed job runner exist. Plan 4 adds the private uploads volume when storage exists.
- Container tags and npm package versions in this plan were verified on 2026-08-08. Re-run the checks in Task 1 before installing anything; if a current stable version has changed, review compatibility and update this plan's version table and exact commands before proceeding.

## Version selections verified on 2026-08-08

| Component | Selected version | Verification and rationale |
| --- | ---: | --- |
| Node.js image | `node:26.7.0-bookworm-slim` | Exact tag exists and matches the repository's Node engine. |
| npm | `11.19.0` | Bundled by the selected Node image; keep local and container installs on the same npm 11 line. npm 12.0.2 is newer but is not selected independently of the official Node image. |
| Playwright | `1.62.1` | Current stable npm release and supports Node 26. |
| Zod | `4.4.3` | Current stable npm release; used only at the server configuration boundary. |
| PostgreSQL | `postgres:18.4-alpine3.24` | Current PostgreSQL 18 patch release with an exact Alpine tag. |
| Mailpit | `axllent/mailpit:v1.30.0` | Current stable release with an exact version tag. |
| Caddy | `caddy:2.11.4-alpine` | Current official Alpine image tag. |
| TypeScript | `6.0.3` | Intentional compatibility pin; `typescript-eslint` 8.66.0 supports TypeScript below 6.1 and does not yet support TypeScript 7. |

## Planned file structure

### Test foundation

- `playwright.config.ts` — browser-test runner and isolated test runtime configuration.
- `tests/e2e/health.spec.ts` — liveness/readiness HTTP contract.
- `tests/e2e/reader-guided.spec.ts` — guided-comic navigation regression.

### Server configuration and safety

- `src/lib/server/config/read-setting.ts` — direct environment and `_FILE` secret resolution.
- `src/lib/server/config/read-setting.test.ts` — secret resolution, conflicts, and redaction behavior.
- `src/lib/server/config/schema.ts` — Zod schema and typed configuration output.
- `src/lib/server/config/index.ts` — environment collection, one-time load, and cache.
- `src/lib/server/config/index.test.ts` — valid and invalid environment combinations.
- `src/lib/server/application-mode.ts` — pure maintenance-path policy.
- `src/lib/server/application-mode.test.ts` — allow/block policy tests.
- `src/hooks.server.ts` — startup validation and maintenance enforcement.
- `src/routes/health/live/+server.ts` — process liveness.
- `src/routes/health/ready/+server.ts` — validated-configuration readiness.

### Containers and environments

- `Dockerfile` — development, build, and non-root production stages.
- `.dockerignore` — exclude local state, secrets, and build/test output.
- `compose.dev.yaml` — source-mounted web service, PostgreSQL, and Mailpit.
- `compose.prod.yaml` — versioned app image, PostgreSQL secret, Caddy, health checks, and resource limits.
- `deploy/Caddyfile` — TLS/reverse-proxy baseline.
- `.env.example` — safe local-development values only.
- `docs/runtime-environments.md` — local and production-baseline operator workflow.

## Task 1: Re-check the baseline and add only the required packages

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/dependency-decisions.md`

- [ ] **Step 1: Verify the untouched baseline**

Run:

```powershell
node --version
npm --version
npm ls --depth=0
npm run verify
```

Expected:

- Node prints `v26.7.0`.
- npm prints `11.19.0`. If local npm is still an earlier npm 11 release, update the local Node/npm installation before modifying the lockfile.
- `npm ls --depth=0` exits successfully.
- The existing Svelte check, ESLint, 44 Vitest tests, and production build pass.

- [ ] **Step 2: Repeat the registry and security checks**

Run:

```powershell
npm view @playwright/test version --json
npm view zod version --json
npm outdated --json
npm audit --audit-level=high
```

Expected at the dated baseline:

- Playwright reports `1.62.1`.
- Zod reports `4.4.3`.
- `npm outdated --json` reports only the intentional TypeScript 6-to-7 difference.
- The audit command exits zero at the high-severity threshold and reports only the already accepted three low-severity `cookie` dependency-path findings.

If another direct package or a high/critical advisory appears, stop this task and resolve or document it before adding packages. Do not run `npm audit fix --force`.

- [ ] **Step 3: Verify the exact service-image tags**

Run:

```powershell
$images = @(
  'node:26.7.0-bookworm-slim',
  'postgres:18.4-alpine3.24',
  'axllent/mailpit:v1.30.0',
  'caddy:2.11.4-alpine'
)

foreach ($image in $images) {
  docker manifest inspect $image *> $null
  if ($LASTEXITCODE -ne 0) { throw "Missing image tag: $image" }
}
```

Expected: all four manifests resolve without throwing.

- [ ] **Step 4: Align the package-manager declaration with the selected Node image**

Change this portion of `package.json`:

```json
"packageManager": "npm@11.19.0",
"engines": {
  "node": ">=26.7.0 <27",
  "npm": ">=11.19.0 <12"
}
```

Do not adopt npm 12 separately in this phase; the exact Node 26.7.0 production image supplies npm 11.19.0.

- [ ] **Step 5: Install Playwright and Zod at the verified stable versions**

Run:

```powershell
npm install --save-dev @playwright/test@1.62.1
npm install zod@4.4.3
npx playwright install chromium
```

Expected:

- `@playwright/test` is recorded in `devDependencies`.
- `zod` is recorded in `dependencies` because production startup validation imports it.
- `package-lock.json` is regenerated by npm 11.19.0.
- Chromium installs successfully for the current user.

- [ ] **Step 6: Record the dated selections**

Add these rows to `docs/dependency-decisions.md` immediately after the adapter-node row:

```markdown
| npm | 11.19.x | Matches the npm release bundled in the exact Node 26.7.0 development and production image; reconsider npm 12 when the selected Node image ships it. |
| Playwright | 1.62.x | Current stable browser-test runner; Chromium is the initial cross-browser contract and more projects can be added when browser-specific defects justify them. |
| Zod | 4.4.x | Current stable runtime schema validator; restricted to trusted configuration and later request-boundary schemas. |
| PostgreSQL image | 18.4 Alpine | Exact production/development database tag; mount `/var/lib/postgresql` for the PostgreSQL 18 image layout. |
| Mailpit image | 1.30.0 | Exact development-only SMTP capture service. |
| Caddy image | 2.11.4 Alpine | Exact production reverse-proxy baseline. |
```

Change the final instruction paragraph from “before completing Plan 0” to “before completing each implementation plan.” Preserve the accepted audit-finding section unchanged.

- [ ] **Step 7: Verify the dependency tree**

Run:

```powershell
npm ls --depth=0
npm audit --audit-level=high
git diff --check
```

Expected: valid dependency tree, no high/critical advisory, and no whitespace errors.

- [ ] **Step 8: Commit the dependency baseline**

```powershell
git add package.json package-lock.json docs/dependency-decisions.md
git commit -m "chore: add backend foundation dependencies"
```

## Task 2: Add Playwright and fix the guided-comic regression test-first

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/reader-guided.spec.ts`
- Modify: `src/lib/components/BookReader.svelte`
- Modify: `package.json`

- [ ] **Step 1: Add browser-test scripts**

Add these scripts to `package.json` while preserving the existing commands:

```json
"test:unit": "vitest run",
"test:e2e": "playwright test",
"test:e2e:headed": "playwright test --headed",
"test:e2e:install": "playwright install chromium"
```

Keep `test` as `vitest run` so focused commands such as `npm test -- src/lib/server/config/index.test.ts` continue to work. Change `verify` to:

```json
"verify": "npm run check && npm run lint && npm run test:unit && npm run test:e2e && npm run build"
```

- [ ] **Step 2: Configure an isolated Playwright web server**

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  )
);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/health/live',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...inheritedEnvironment,
      APP_ENV: 'test',
      APPLICATION_MODE: 'prototype',
      ORIGIN: 'http://127.0.0.1:4173',
      DATABASE_HOST: '127.0.0.1',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'pale_orbit_test',
      DATABASE_USER: 'pale_orbit_test',
      DATABASE_PASSWORD: 'playwright-only'
    }
  }
});
```

The `/health/live` URL will become available in Task 4. Until then, temporarily set `webServer.url` to `http://127.0.0.1:4173/` while proving the guided-reader test; change it back in Task 4.

- [ ] **Step 3: Write the guided-reader regression test**

Create `tests/e2e/reader-guided.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('Previous moves from panel three to panel two on the first comic page', async ({ page }) => {
  await page.goto('/read/vector');

  await page.getByRole('button', { name: 'Open the comic' }).click();
  await expect(
    page.getByRole('application', { name: /Interactive pages for Vector & Vine/ })
  ).toBeVisible({ timeout: 3_000 });

  await page.getByRole('button', { name: 'Page view' }).click();
  await expect(
    page.getByRole('button', { name: /PANEL - establishing shot/ })
  ).toBeVisible();
  await expect(page.getByText(/Page 1\s*·\s*panel 1 of 3/)).toBeVisible();

  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText(/Page 1\s*·\s*panel 3 of 3/)).toBeVisible();

  await page.getByRole('button', { name: 'Previous' }).click();

  await expect(page.getByText(/Page 1\s*·\s*panel 2 of 3/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open the comic' })).toBeHidden();
});
```

- [ ] **Step 4: Run the regression and observe the existing failure**

Run:

```powershell
npm run test:e2e -- tests/e2e/reader-guided.spec.ts
```

Expected: FAIL at the panel-two assertion. The current `turn(-1)` closes the book whenever `sheet === 0` before delegating to guided-panel navigation.

- [ ] **Step 5: Route guided navigation before generic book-edge closing**

In `src/lib/components/BookReader.svelte`, change only the start of `turn` to this ordering:

```ts
function turn(dir: TurnDirection): void {
  if (phase === 'closed') {
    if (dir > 0) openBook();
    return;
  }
  if (phase !== 'reading') return;
  settleTurn();
  if (guided) return turnPanel(dir);
  // Turning back past the first spread closes the book again.
  if (dir < 0 && sheet === 0) {
    startClosing();
    return;
  }
  // At sheet k the visible spread is [back of k-1 | front of k], so the last
  // page only shows once every sheet is turned: sheet === totalSheets.
  if (dir > 0 && !sampling && sheet >= totalSheets) {
    startClosingEnd();
    return;
  }
  if (clampSheet(sheet + dir, totalSheets, limit) === sheet) return;
  runTurn(dir, 0, 1, easeTurn, 720, true);
}
```

- [ ] **Step 6: Prove the fix and the existing reader suite**

Run:

```powershell
npm run test:e2e -- tests/e2e/reader-guided.spec.ts
npm test -- src/lib/reader
npm run check
npm run lint
```

Expected: the browser regression passes, all focused reader unit tests pass, and checks report no errors or warnings.

- [ ] **Step 7: Commit the browser foundation and regression fix**

```powershell
git add package.json playwright.config.ts tests/e2e/reader-guided.spec.ts src/lib/components/BookReader.svelte
git commit -m "test: add reader browser regression coverage"
```

## Task 3: Load and validate ordinary environment values and Docker secrets

**Files:**
- Create: `src/lib/server/config/read-setting.test.ts`
- Create: `src/lib/server/config/read-setting.ts`
- Create: `src/lib/server/config/index.test.ts`
- Create: `src/lib/server/config/schema.ts`
- Create: `src/lib/server/config/index.ts`

- [ ] **Step 1: Write failing direct-value and secret-file tests**

Create `src/lib/server/config/read-setting.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  readRequiredSetting,
  type EnvironmentValues
} from './read-setting';

describe('readRequiredSetting', () => {
  it('returns a direct environment value without reading a file', () => {
    const source: EnvironmentValues = { DATABASE_PASSWORD: 'direct-secret' };

    const value = readRequiredSetting(source, 'DATABASE_PASSWORD', () => {
      throw new Error('the file reader must not run');
    });

    expect(value).toBe('direct-secret');
  });

  it('reads a Docker-style secret file and removes one trailing line ending', () => {
    const source: EnvironmentValues = {
      DATABASE_PASSWORD_FILE: '/run/secrets/database_password'
    };

    const value = readRequiredSetting(source, 'DATABASE_PASSWORD', (path) => {
      expect(path).toBe('/run/secrets/database_password');
      return 'file-secret\r\n';
    });

    expect(value).toBe('file-secret');
  });

  it('rejects ambiguous direct and file-backed values', () => {
    const source: EnvironmentValues = {
      DATABASE_PASSWORD: 'direct-secret',
      DATABASE_PASSWORD_FILE: '/run/secrets/database_password'
    };

    expect(() => readRequiredSetting(source, 'DATABASE_PASSWORD')).toThrow(
      /DATABASE_PASSWORD and DATABASE_PASSWORD_FILE cannot both be set/
    );
  });

  it('rejects a missing required setting', () => {
    expect(() => readRequiredSetting({}, 'DATABASE_PASSWORD')).toThrow(
      /DATABASE_PASSWORD or DATABASE_PASSWORD_FILE is required/
    );
  });

  it('rejects empty direct and file-backed values', () => {
    expect(() => readRequiredSetting({ DATABASE_PASSWORD: '' }, 'DATABASE_PASSWORD')).toThrow(
      /DATABASE_PASSWORD cannot be empty/
    );

    expect(() =>
      readRequiredSetting(
        { DATABASE_PASSWORD_FILE: '/run/secrets/database_password' },
        'DATABASE_PASSWORD',
        () => '\n'
      )
    ).toThrow(/DATABASE_PASSWORD cannot be empty/);
  });

  it('redacts the file path and underlying read error', () => {
    const source: EnvironmentValues = {
      DATABASE_PASSWORD_FILE: 'C:\\private\\database_password'
    };

    let thrown: unknown;
    try {
      readRequiredSetting(source, 'DATABASE_PASSWORD', () => {
        throw new Error('access denied for C:\\private\\database_password');
      });
    } catch (cause: unknown) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as Error).message).toBe(
      'Could not read the secret file configured for DATABASE_PASSWORD_FILE'
    );
  });
});
```

- [ ] **Step 2: Write failing complete-configuration tests**

Create `src/lib/server/config/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadApplicationConfig } from './index';
import { ConfigurationError, type EnvironmentValues } from './read-setting';

const VALID_DEVELOPMENT_ENVIRONMENT: EnvironmentValues = {
  APP_ENV: 'development',
  APPLICATION_MODE: 'prototype',
  ORIGIN: 'http://localhost:5173',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'pale_orbit',
  DATABASE_USER: 'pale_orbit',
  DATABASE_PASSWORD: 'development-only'
};

describe('loadApplicationConfig', () => {
  it('returns a typed configuration from direct development values', () => {
    expect(loadApplicationConfig(VALID_DEVELOPMENT_ENVIRONMENT)).toEqual({
      environment: 'development',
      applicationMode: 'prototype',
      origin: 'http://localhost:5173',
      database: {
        host: 'localhost',
        port: 5432,
        name: 'pale_orbit',
        user: 'pale_orbit',
        password: 'development-only'
      }
    });
  });

  it('loads the database password from a production secret file', () => {
    const source: EnvironmentValues = {
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      APP_ENV: 'production',
      APPLICATION_MODE: 'maintenance',
      ORIGIN: 'https://books.example.com',
      DATABASE_HOST: 'postgres',
      DATABASE_PASSWORD: undefined,
      DATABASE_PASSWORD_FILE: '/run/secrets/database_password'
    };

    const config = loadApplicationConfig(source, (path) => {
      expect(path).toBe('/run/secrets/database_password');
      return 'production-secret\n';
    });

    expect(config.environment).toBe('production');
    expect(config.applicationMode).toBe('maintenance');
    expect(config.database.password).toBe('production-secret');
  });

  it('rejects prototype mode in production', () => {
    const source: EnvironmentValues = {
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      APP_ENV: 'production',
      APPLICATION_MODE: 'prototype',
      ORIGIN: 'https://books.example.com'
    };

    expect(() => loadApplicationConfig(source)).toThrow(
      /APPLICATION_MODE: production must use maintenance mode/
    );
  });

  it.each([
    ['ORIGIN', 'ftp://books.example.com'],
    ['DATABASE_PORT', '0'],
    ['DATABASE_PORT', 'not-a-port']
  ])('rejects invalid %s values', (key, value) => {
    expect(() =>
      loadApplicationConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, [key]: value })
    ).toThrow(ConfigurationError);
  });

  it('does not include the database password in validation errors', () => {
    const source: EnvironmentValues = {
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      DATABASE_PORT: 'invalid',
      DATABASE_PASSWORD: 'must-never-appear-in-an-error'
    };

    let thrown: unknown;
    try {
      loadApplicationConfig(source);
    } catch (cause: unknown) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as Error).message).not.toContain('must-never-appear-in-an-error');
  });
});
```

- [ ] **Step 3: Run both files and observe the missing-module failures**

Run:

```powershell
npm test -- src/lib/server/config/read-setting.test.ts src/lib/server/config/index.test.ts
```

Expected: FAIL because `read-setting.ts` and `index.ts` do not exist.

- [ ] **Step 4: Implement direct and `_FILE` value resolution**

Create `src/lib/server/config/read-setting.ts`:

```ts
import { readFileSync } from 'node:fs';

export type EnvironmentValues = Readonly<Record<string, string | undefined>>;
export type SecretFileReader = (path: string) => string;

export class ConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}

const readUtf8File: SecretFileReader = (path) => readFileSync(path, 'utf8');

function removeOneTrailingLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

export function readRequiredSetting(
  source: EnvironmentValues,
  name: string,
  readSecretFile: SecretFileReader = readUtf8File
): string {
  const directValue = source[name];
  const fileName = `${name}_FILE`;
  const secretPath = source[fileName];

  if (directValue !== undefined && secretPath !== undefined) {
    throw new ConfigurationError(`${name} and ${fileName} cannot both be set`);
  }

  if (directValue !== undefined) {
    if (directValue.length === 0) {
      throw new ConfigurationError(`${name} cannot be empty`);
    }
    return directValue;
  }

  if (secretPath === undefined) {
    throw new ConfigurationError(`${name} or ${fileName} is required`);
  }

  if (secretPath.trim().length === 0) {
    throw new ConfigurationError(`${fileName} cannot be empty`);
  }

  let value: string;
  try {
    value = removeOneTrailingLineEnding(readSecretFile(secretPath.trim()));
  } catch (cause: unknown) {
    throw new ConfigurationError(`Could not read the secret file configured for ${fileName}`, {
      cause
    });
  }

  if (value.length === 0) {
    throw new ConfigurationError(`${name} cannot be empty`);
  }

  return value;
}
```

- [ ] **Step 5: Implement the typed Zod schema**

Create `src/lib/server/config/schema.ts`:

```ts
import { z } from 'zod';
import { ConfigurationError } from './read-setting';

const port = z
  .string()
  .regex(/^\d+$/, 'must be an integer between 1 and 65535')
  .transform((value) => Number.parseInt(value, 10))
  .pipe(z.number().int().min(1).max(65_535));

const rawApplicationConfigSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']),
    APPLICATION_MODE: z.enum(['prototype', 'maintenance']),
    ORIGIN: z.url().refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    }, 'must use http or https'),
    DATABASE_HOST: z.string().trim().min(1),
    DATABASE_PORT: port,
    DATABASE_NAME: z.string().trim().min(1),
    DATABASE_USER: z.string().trim().min(1),
    DATABASE_PASSWORD: z.string().min(1)
  })
  .superRefine((value, context) => {
    if (value.APP_ENV === 'production' && value.APPLICATION_MODE !== 'maintenance') {
      context.addIssue({
        code: 'custom',
        path: ['APPLICATION_MODE'],
        message: 'production must use maintenance mode'
      });
    }
  })
  .transform((value) => ({
    environment: value.APP_ENV,
    applicationMode: value.APPLICATION_MODE,
    origin: value.ORIGIN,
    database: {
      host: value.DATABASE_HOST,
      port: value.DATABASE_PORT,
      name: value.DATABASE_NAME,
      user: value.DATABASE_USER,
      password: value.DATABASE_PASSWORD
    }
  }));

export type ApplicationConfig = z.output<typeof rawApplicationConfigSchema>;
export type ApplicationMode = ApplicationConfig['applicationMode'];

export function parseApplicationConfig(value: unknown): ApplicationConfig {
  const result = rawApplicationConfigSchema.safeParse(value);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
    .join('; ');
  throw new ConfigurationError(`Invalid application configuration: ${details}`);
}
```

- [ ] **Step 6: Implement one-time application configuration loading**

Create `src/lib/server/config/index.ts`:

```ts
import { env } from '$env/dynamic/private';
import {
  readRequiredSetting,
  type EnvironmentValues,
  type SecretFileReader
} from './read-setting';
import { parseApplicationConfig, type ApplicationConfig } from './schema';

export type { ApplicationConfig, ApplicationMode } from './schema';

export function loadApplicationConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): ApplicationConfig {
  return parseApplicationConfig({
    APP_ENV: readRequiredSetting(source, 'APP_ENV', readSecretFile),
    APPLICATION_MODE: readRequiredSetting(source, 'APPLICATION_MODE', readSecretFile),
    ORIGIN: readRequiredSetting(source, 'ORIGIN', readSecretFile),
    DATABASE_HOST: readRequiredSetting(source, 'DATABASE_HOST', readSecretFile),
    DATABASE_PORT: readRequiredSetting(source, 'DATABASE_PORT', readSecretFile),
    DATABASE_NAME: readRequiredSetting(source, 'DATABASE_NAME', readSecretFile),
    DATABASE_USER: readRequiredSetting(source, 'DATABASE_USER', readSecretFile),
    DATABASE_PASSWORD: readRequiredSetting(source, 'DATABASE_PASSWORD', readSecretFile)
  });
}

let cachedConfiguration: ApplicationConfig | undefined;

export function getApplicationConfig(): ApplicationConfig {
  cachedConfiguration ??= loadApplicationConfig(env);
  return cachedConfiguration;
}
```

- [ ] **Step 7: Run the focused configuration suite**

Run:

```powershell
npm test -- src/lib/server/config/read-setting.test.ts src/lib/server/config/index.test.ts
npm run check
npm run lint
```

Expected: all configuration tests pass, Svelte/TypeScript checking passes with zero errors and warnings, and ESLint passes.

- [ ] **Step 8: Commit the configuration boundary**

```powershell
git add src/lib/server/config
git commit -m "feat: validate runtime configuration and secrets"
```

## Task 4: Validate at startup, expose health contracts, and enforce maintenance mode

**Files:**
- Create: `src/lib/server/application-mode.test.ts`
- Create: `src/lib/server/application-mode.ts`
- Create: `tests/e2e/health.spec.ts`
- Create: `src/routes/health/live/+server.ts`
- Create: `src/routes/health/ready/+server.ts`
- Modify: `src/hooks.server.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Write the failing maintenance-path policy tests**

Create `src/lib/server/application-mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isRequestAvailable } from './application-mode';

describe('isRequestAvailable', () => {
  it.each(['/', '/catalog', '/api/checkout', '/read/vector'])(
    'allows %s in prototype mode',
    (path) => {
      expect(isRequestAvailable('prototype', path)).toBe(true);
    }
  );

  it.each(['/health/live', '/health/ready'])(
    'allows %s in maintenance mode',
    (path) => {
      expect(isRequestAvailable('maintenance', path)).toBe(true);
    }
  );

  it.each(['/', '/catalog', '/api/checkout', '/health/private'])(
    'blocks %s in maintenance mode',
    (path) => {
      expect(isRequestAvailable('maintenance', path)).toBe(false);
    }
  );
});
```

- [ ] **Step 2: Write the failing health endpoint contract**

Create `tests/e2e/health.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('liveness reports the running web process', async ({ request }) => {
  const response = await request.get('/health/live');

  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('readiness reports validated application configuration', async ({ request }) => {
  const response = await request.get('/health/ready');

  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'ready' });
});
```

- [ ] **Step 3: Observe both intended failures**

Run:

```powershell
npm test -- src/lib/server/application-mode.test.ts
npm run test:e2e -- tests/e2e/health.spec.ts
```

Expected:

- The unit test fails because `application-mode.ts` does not exist.
- The browser test fails because the health routes do not exist. If Playwright cannot start because its temporary root URL is still in use, keep the temporary root URL from Task 2 until the route implementation is added in Step 5.

- [ ] **Step 4: Implement the narrow maintenance policy**

Create `src/lib/server/application-mode.ts`:

```ts
import type { ApplicationMode } from './config';

const MAINTENANCE_PATHS = new Set(['/health/live', '/health/ready']);

export function isRequestAvailable(mode: ApplicationMode, path: string): boolean {
  return mode === 'prototype' || MAINTENANCE_PATHS.has(path);
}
```

- [ ] **Step 5: Implement liveness and readiness**

Create `src/routes/health/live/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
  json(
    { status: 'ok' },
    {
      headers: { 'cache-control': 'no-store' }
    }
  );
```

Create `src/routes/health/ready/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationConfig } from '$lib/server/config';

export const GET: RequestHandler = () => {
  getApplicationConfig();
  return json(
    { status: 'ready' },
    {
      headers: { 'cache-control': 'no-store' }
    }
  );
};
```

Do not add a fake database check. Plan 2 changes readiness only after a real PostgreSQL adapter exists.

- [ ] **Step 6: Validate configuration before serving and block maintenance traffic**

Replace `src/hooks.server.ts` with:

```ts
import type { Handle, ServerInit } from '@sveltejs/kit';
import { isRequestAvailable } from '$lib/server/application-mode';
import { getApplicationConfig } from '$lib/server/config';

export const init: ServerInit = () => {
  getApplicationConfig();
};

export const handle: Handle = async ({ event, resolve }) => {
  const config = getApplicationConfig();
  event.locals.user = null;

  if (!isRequestAvailable(config.applicationMode, event.url.pathname)) {
    return new Response('Service temporarily unavailable while the backend is being prepared.', {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': '60'
      }
    });
  }

  if (config.applicationMode === 'prototype') {
    const email = event.cookies.get('po_session') ?? null;
    event.locals.user = email ? { email } : null;
  }

  return resolve(event);
};
```

This deliberately keeps the development prototype cookie behavior while making it unreachable in production maintenance mode.

- [ ] **Step 7: Point Playwright startup at liveness**

In `playwright.config.ts`, ensure the final `webServer.url` is:

```ts
url: 'http://127.0.0.1:4173/health/live',
```

- [ ] **Step 8: Run the policy, health, and browser suites**

Run:

```powershell
npm test -- src/lib/server/application-mode.test.ts src/lib/server/config
npm run test:e2e
npm run check
npm run lint
npm run build
```

Expected: all unit tests and both browser files pass; type checking, linting, and the adapter-node production build pass.

- [ ] **Step 9: Commit startup safety and health contracts**

```powershell
git add src/hooks.server.ts src/lib/server/application-mode.ts src/lib/server/application-mode.test.ts src/routes/health tests/e2e/health.spec.ts playwright.config.ts
git commit -m "feat: add startup validation and health checks"
```

## Task 5: Build a reproducible non-root Node image

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Write the multi-stage Dockerfile**

Create `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:26.7.0-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS development
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

FROM dependencies AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "build"]
```

The runtime stage contains the adapter-node build and production dependencies only. It uses the unprivileged `node` user already supplied by the official Node image.

- [ ] **Step 2: Exclude local state and secrets from the build context**

Create `.dockerignore`:

```text
.git
.github
.serena
.svelte-kit
.worktrees
build
node_modules
playwright-report
test-results
.env
.env.*
Dockerfile*
compose*.yaml
docs
npm-debug.log*
```

It is intentional that `.env.example` is excluded together with `.env.*`; runtime configuration is never copied into the image.

- [ ] **Step 3: Build the production stage**

Run:

```powershell
docker build --target runtime --tag pale-orbit:plan1 .
```

Expected: the image builds from `node:26.7.0-bookworm-slim`, `npm ci` honors the lockfile, the adapter-node build passes, and the final image is tagged `pale-orbit:plan1`.

- [ ] **Step 4: Smoke-test configuration, health, and maintenance behavior directly**

Run this exact PowerShell block:

```powershell
docker run --detach --rm `
  --name pale-orbit-plan1-app `
  --publish 127.0.0.1:13001:3000 `
  --env APP_ENV=production `
  --env APPLICATION_MODE=maintenance `
  --env ORIGIN=http://127.0.0.1:13001 `
  --env DATABASE_HOST=postgres `
  --env DATABASE_PORT=5432 `
  --env DATABASE_NAME=pale_orbit `
  --env DATABASE_USER=pale_orbit `
  --env DATABASE_PASSWORD=container-smoke-only `
  pale-orbit:plan1

try {
  curl.exe --retry 20 --retry-connrefused --retry-all-errors --retry-delay 1 --fail `
    http://127.0.0.1:13001/health/ready
  if ($LASTEXITCODE -ne 0) { throw 'Application readiness did not become available' }

  $rootStatus = curl.exe --silent --output NUL --write-out "%{http_code}" `
    http://127.0.0.1:13001/
  if ($rootStatus -ne '503') { throw "Expected maintenance response 503, got $rootStatus" }

  $runtimeUser = docker exec pale-orbit-plan1-app id -un
  if ($runtimeUser -ne 'node') { throw "Expected runtime user node, got $runtimeUser" }
} finally {
  docker rm --force pale-orbit-plan1-app *> $null
}
```

Expected:

- Readiness returns `{"status":"ready"}`.
- The storefront returns 503.
- The running user is `node`.
- The exact smoke-test container is removed even if an assertion fails.

- [ ] **Step 5: Confirm no environment file entered an image layer**

Run:

```powershell
docker history --no-trunc pale-orbit:plan1
```

Expected: the history contains package/build copies only and no `.env`, Stripe key, mail key, or database password value.

- [ ] **Step 6: Commit the application image**

```powershell
git add Dockerfile .dockerignore
git commit -m "build: add reproducible node application image"
```

## Task 6: Add the source-mounted development stack with PostgreSQL and Mailpit

**Files:**
- Create: `compose.dev.yaml`
- Modify: `.env.example`

- [ ] **Step 1: Replace the old provider-specific environment example**

Replace `.env.example` with:

```dotenv
# Application runtime
APP_ENV=development
APPLICATION_MODE=prototype
ORIGIN=http://localhost:5173

# PostgreSQL for host-run development. compose.dev.yaml overrides only the host to `postgres`.
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=pale_orbit
DATABASE_USER=pale_orbit
DATABASE_PASSWORD=pale_orbit_dev_only

# Optional prototype Stripe integration
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
PUBLIC_STRIPE_PUBLISHABLE_KEY=

# Legacy prototype mail seam. Plan 3 replaces this with the provider-neutral SMTP adapter.
MAIL_API_KEY=
MAIL_FROM="Pale Orbit <books@paleorbit.co>"
```

These are development-only examples. No production deployment copies this file.

- [ ] **Step 2: Define the development Compose services**

Create `compose.dev.yaml`:

```yaml
services:
  app:
    build:
      context: .
      target: development
    init: true
    command: [npm, run, dev, --, --host, 0.0.0.0, --port, "5173"]
    env_file:
      - ${DEV_ENV_FILE:-.env}
    environment:
      DATABASE_HOST: postgres
    volumes:
      - .:/app
      - app_node_modules:/app/node_modules
    ports:
      - 127.0.0.1:5173:5173
    depends_on:
      postgres:
        condition: service_healthy
      mailpit:
        condition: service_healthy
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - fetch('http://127.0.0.1:5173/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 15s
    stop_grace_period: 15s

  postgres:
    image: postgres:18.4-alpine3.24
    environment:
      POSTGRES_DB: ${DATABASE_NAME:?DATABASE_NAME must be set}
      POSTGRES_USER: ${DATABASE_USER:?DATABASE_USER must be set}
      POSTGRES_PASSWORD: ${DATABASE_PASSWORD:?DATABASE_PASSWORD must be set}
    volumes:
      - postgres_dev_data:/var/lib/postgresql
    ports:
      - 127.0.0.1:5432:5432
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"']
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 10s
    stop_grace_period: 30s

  mailpit:
    image: axllent/mailpit:v1.30.0
    command: [--max, "500", --max-age, 7d, --disable-version-check]
    ports:
      - 127.0.0.1:1025:1025
      - 127.0.0.1:8025:8025
    healthcheck:
      test: [CMD, /mailpit, readyz]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 5s
    stop_grace_period: 10s

volumes:
  app_node_modules:
  postgres_dev_data:
```

The app service waits for PostgreSQL and Mailpit so `docker compose up` has one unambiguous ready state. PostgreSQL is host-bound only for local tools; Mailpit's SMTP and UI ports are host-bound only for development.

- [ ] **Step 3: Validate interpolation without creating a developer `.env`**

Run:

```powershell
$env:DEV_ENV_FILE = '.env.example'
try {
  docker compose --env-file .env.example -f compose.dev.yaml config --quiet
} finally {
  Remove-Item Env:DEV_ENV_FILE
}
```

Expected: Compose validates with no missing-variable or schema error.

- [ ] **Step 4: Smoke-test the entire development stack**

Run this exact isolated-project smoke test:

```powershell
$env:DEV_ENV_FILE = '.env.example'
try {
  docker compose `
    --project-name pale-orbit-plan1-dev `
    --env-file .env.example `
    --file compose.dev.yaml `
    up --build --detach --wait --wait-timeout 120

  curl.exe --fail http://127.0.0.1:5173/health/ready
  curl.exe --fail http://127.0.0.1:8025/api/v1/info

  docker compose `
    --project-name pale-orbit-plan1-dev `
    --env-file .env.example `
    --file compose.dev.yaml `
    exec --no-TTY postgres `
    psql --username pale_orbit --dbname pale_orbit --command 'select 1;'

  docker compose `
    --project-name pale-orbit-plan1-dev `
    --env-file .env.example `
    --file compose.dev.yaml `
    ps
} finally {
  docker compose `
    --project-name pale-orbit-plan1-dev `
    --env-file .env.example `
    --file compose.dev.yaml `
    down --volumes --remove-orphans
  Remove-Item Env:DEV_ENV_FILE -ErrorAction SilentlyContinue
}
```

Expected:

- All three services become healthy.
- The app returns `{"status":"ready"}`.
- Mailpit's API responds.
- PostgreSQL returns one row containing `1`.
- Cleanup removes only the explicitly named `pale-orbit-plan1-dev` containers, network, and smoke-test volumes.

- [ ] **Step 5: Verify local configuration remains untracked**

Run:

```powershell
git check-ignore .env
git status --short
```

Expected: `.env` is ignored and only the intended Compose/example changes are present.

- [ ] **Step 6: Commit the development environment**

```powershell
git add .env.example compose.dev.yaml
git commit -m "build: add postgres and mailpit development stack"
```

## Task 7: Add the process-secret production stack and Caddy baseline

**Files:**
- Create: `deploy/Caddyfile`
- Create: `compose.prod.yaml`

- [ ] **Step 1: Add the Caddy reverse-proxy configuration**

Create `deploy/Caddyfile`:

```caddyfile
{
	admin off
}

{$SITE_ADDRESS} {
	encode zstd gzip
	reverse_proxy app:3000
}
```

For the actual VPS, `SITE_ADDRESS` is the public hostname and Caddy manages HTTPS automatically. The smoke test uses `:80` so it remains local and does not request a certificate.

- [ ] **Step 2: Define the production Compose stack**

Create `compose.prod.yaml`:

```yaml
services:
  app:
    image: ${APP_IMAGE:?APP_IMAGE must be an immutable versioned image}
    init: true
    environment:
      NODE_ENV: production
      APP_ENV: production
      APPLICATION_MODE: maintenance
      ORIGIN: ${ORIGIN:?ORIGIN must be set}
      DATABASE_HOST: postgres
      DATABASE_PORT: "5432"
      DATABASE_NAME: ${DATABASE_NAME:?DATABASE_NAME must be set}
      DATABASE_USER: ${DATABASE_USER:?DATABASE_USER must be set}
      DATABASE_PASSWORD_FILE: /run/secrets/database_password
      HOST: 0.0.0.0
      PORT: "3000"
      ADDRESS_HEADER: X-Forwarded-For
      XFF_DEPTH: "1"
    secrets:
      - database_password
    depends_on:
      postgres:
        condition: service_healthy
    expose:
      - "3000"
    restart: unless-stopped
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - fetch('http://127.0.0.1:3000/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))
      interval: 10s
      timeout: 3s
      retries: 10
      start_period: 15s
    stop_grace_period: 30s
    deploy:
      resources:
        limits:
          cpus: ${WEB_CPU_LIMIT:-1.00}
          memory: ${WEB_MEMORY_LIMIT:-768M}

  postgres:
    image: postgres:18.4-alpine3.24
    environment:
      POSTGRES_DB: ${DATABASE_NAME:?DATABASE_NAME must be set}
      POSTGRES_USER: ${DATABASE_USER:?DATABASE_USER must be set}
      POSTGRES_PASSWORD_FILE: /run/secrets/database_password
    secrets:
      - database_password
    volumes:
      - postgres_data:/var/lib/postgresql
    restart: unless-stopped
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"']
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
    stop_grace_period: 60s
    shm_size: 128mb
    deploy:
      resources:
        limits:
          cpus: ${POSTGRES_CPU_LIMIT:-1.50}
          memory: ${POSTGRES_MEMORY_LIMIT:-1G}

  caddy:
    image: caddy:2.11.4-alpine
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS:?SITE_ADDRESS must be set}
    ports:
      - ${HTTP_BIND_ADDRESS:-0.0.0.0}:${HTTP_PORT:-80}:80
      - ${HTTPS_BIND_ADDRESS:-0.0.0.0}:${HTTPS_PORT:-443}:443
      - ${HTTPS_BIND_ADDRESS:-0.0.0.0}:${HTTPS_PORT:-443}:443/udp
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      app:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: [CMD-SHELL, 'wget -q --spider http://127.0.0.1/health/live']
      interval: 10s
      timeout: 3s
      retries: 10
      start_period: 10s
    stop_grace_period: 30s
    deploy:
      resources:
        limits:
          cpus: ${CADDY_CPU_LIMIT:-0.50}
          memory: ${CADDY_MEMORY_LIMIT:-256M}

secrets:
  database_password:
    environment: DATABASE_PASSWORD

volumes:
  postgres_data:
  caddy_data:
  caddy_config:
```

Important properties to preserve:

- There is no `env_file` key anywhere in this file.
- The app image is supplied externally and is not built on the VPS.
- Only Caddy publishes ports.
- PostgreSQL receives its password through `/run/secrets/database_password` and has no host port.
- The app receives the same secret file and never receives `DATABASE_PASSWORD` as an environment variable.
- The app remains non-root with `no-new-privileges`; a read-only root filesystem is deferred because Docker Compose cannot materialize an environment-backed secret into a read-only container root filesystem. Plan 7 must revisit this hardening control alongside the deployment secret provider.
- `ADDRESS_HEADER` and `XFF_DEPTH=1` trust exactly the single Caddy hop for client-address handling.
- Resource limits have conservative defaults and remain overridable for the final VPS sizing review in Plan 7.
- `APPLICATION_MODE` is hard-coded to `maintenance`; a later reviewed plan must deliberately change the supported production mode after real authorization and persistence exist.

- [ ] **Step 3: Validate Compose interpolation with process-only values**

Run:

```powershell
$env:APP_IMAGE = 'pale-orbit:plan1'
$env:ORIGIN = 'http://127.0.0.1:18080'
$env:SITE_ADDRESS = ':80'
$env:HTTP_BIND_ADDRESS = '127.0.0.1'
$env:HTTP_PORT = '18080'
$env:HTTPS_BIND_ADDRESS = '127.0.0.1'
$env:HTTPS_PORT = '18443'
$env:DATABASE_NAME = 'pale_orbit'
$env:DATABASE_USER = 'pale_orbit'
$env:DATABASE_PASSWORD = 'compose-smoke-only'

try {
  docker compose --file compose.prod.yaml config --quiet
} finally {
  @(
    'APP_IMAGE',
    'ORIGIN',
    'SITE_ADDRESS',
    'HTTP_BIND_ADDRESS',
    'HTTP_PORT',
    'HTTPS_BIND_ADDRESS',
    'HTTPS_PORT',
    'DATABASE_NAME',
    'DATABASE_USER',
    'DATABASE_PASSWORD'
  ) | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
}
```

Expected: Compose validates without reading a `.env` file and without printing the database-password value.

- [ ] **Step 4: Smoke-test secret mounting, private PostgreSQL, Caddy, and maintenance mode**

Run this exact isolated-project smoke test:

```powershell
$env:APP_IMAGE = 'pale-orbit:plan1'
$env:ORIGIN = 'http://127.0.0.1:18080'
$env:SITE_ADDRESS = ':80'
$env:HTTP_BIND_ADDRESS = '127.0.0.1'
$env:HTTP_PORT = '18080'
$env:HTTPS_BIND_ADDRESS = '127.0.0.1'
$env:HTTPS_PORT = '18443'
$env:DATABASE_NAME = 'pale_orbit'
$env:DATABASE_USER = 'pale_orbit'
$env:DATABASE_PASSWORD = 'compose-smoke-only'

try {
  docker compose `
    --project-name pale-orbit-plan1-prod `
    --file compose.prod.yaml `
    up --detach --wait --wait-timeout 120

  curl.exe --fail http://127.0.0.1:18080/health/live
  curl.exe --fail http://127.0.0.1:18080/health/ready

  $rootStatus = curl.exe --silent --output NUL --write-out "%{http_code}" `
    http://127.0.0.1:18080/
  if ($rootStatus -ne '503') { throw "Expected maintenance response 503, got $rootStatus" }

  docker compose `
    --project-name pale-orbit-plan1-prod `
    --file compose.prod.yaml `
    exec --no-TTY app `
    test -s /run/secrets/database_password

  $databasePasswordEnvironment = docker compose `
    --project-name pale-orbit-plan1-prod `
    --file compose.prod.yaml `
    exec --no-TTY app printenv DATABASE_PASSWORD 2>$null
  if ($LASTEXITCODE -eq 0 -or $databasePasswordEnvironment) {
    throw 'DATABASE_PASSWORD must not be present in the app environment'
  }

  $appUserId = docker compose `
    --project-name pale-orbit-plan1-prod `
    --file compose.prod.yaml `
    exec --no-TTY app id -u
  if ([int]$appUserId -eq 0) { throw 'The app must not run as root' }

  $postgresContainerId = docker compose `
    --project-name pale-orbit-plan1-prod `
    --file compose.prod.yaml `
    ps --quiet postgres
  $postgresContainer = docker inspect $postgresContainerId | ConvertFrom-Json
  $publishedPostgresPorts = $postgresContainer[0].NetworkSettings.Ports.PSObject.Properties |
    Where-Object Value
  if ($publishedPostgresPorts) {
    throw "PostgreSQL must not publish a host port: $publishedPostgresPorts"
  }

  docker compose `
    --project-name pale-orbit-plan1-prod `
    --file compose.prod.yaml `
    ps
} finally {
  docker compose `
    --project-name pale-orbit-plan1-prod `
    --file compose.prod.yaml `
    down --volumes --remove-orphans

  @(
    'APP_IMAGE',
    'ORIGIN',
    'SITE_ADDRESS',
    'HTTP_BIND_ADDRESS',
    'HTTP_PORT',
    'HTTPS_BIND_ADDRESS',
    'HTTPS_PORT',
    'DATABASE_NAME',
    'DATABASE_USER',
    'DATABASE_PASSWORD'
  ) | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
}
```

Expected:

- PostgreSQL, app, and Caddy become healthy.
- Both health endpoints work through Caddy.
- The storefront returns 503 through Caddy.
- The app sees a non-empty secret file and no direct `DATABASE_PASSWORD` environment variable.
- PostgreSQL has no published host port.
- Cleanup removes only the explicitly named `pale-orbit-plan1-prod` containers, network, and smoke-test volumes.

- [ ] **Step 5: Commit the production baseline**

```powershell
git add deploy/Caddyfile compose.prod.yaml
git commit -m "build: add caddy production compose baseline"
```

## Task 8: Document operations and run the complete Plan 1 gate

**Files:**
- Create: `docs/runtime-environments.md`
- Modify: `README.md`

- [ ] **Step 1: Document the environment contract and exact workflows**

Create `docs/runtime-environments.md`:

~~~~markdown
# Runtime environments

## Scope

Plan 1 supplies a development environment and a production infrastructure baseline. The production application intentionally remains in maintenance mode until durable authentication, authorization, catalog, storage, and commerce replace the frontend prototype behavior in later plans.

## Required toolchain

- Node.js 26.7.x
- npm 11.19.x
- Docker Engine 27 or newer
- Docker Compose 2.30 or newer

The application image and local tooling use the same Node 26.7/npm 11.19 line.

## Host-run development

Copy `.env.example` to the ignored `.env`, install dependencies, start PostgreSQL and Mailpit, then run Vite on the host:

```powershell
Copy-Item .env.example .env
npm ci
docker compose --env-file .env --file compose.dev.yaml up postgres mailpit --detach --wait
npm run dev
```

The storefront is at `http://localhost:5173` and Mailpit is at `http://localhost:8025`. The host-run app uses `DATABASE_HOST=localhost` from `.env`.

Stop the service containers without deleting PostgreSQL data:

```powershell
docker compose --env-file .env --file compose.dev.yaml down
```

## Fully containerized development

After creating `.env`, start the source-mounted app, PostgreSQL, and Mailpit together:

```powershell
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

The Compose app overrides `DATABASE_HOST` to the internal service name `postgres`. Source changes are served by Vite from the bind mount. Dependencies remain in the named `app_node_modules` volume.

Stop the stack while retaining PostgreSQL data:

```powershell
docker compose --env-file .env --file compose.dev.yaml down
```

Delete the local PostgreSQL and container-node_modules volumes only when a clean development reset is intentional:

```powershell
docker compose --env-file .env --file compose.dev.yaml down --volumes
```

## Configuration contract

| Setting | Development | Production baseline | Sensitive |
| --- | --- | --- | --- |
| `APP_ENV` | `development` | Compose fixes `production` | No |
| `APPLICATION_MODE` | `prototype` | Compose fixes `maintenance` | No |
| `ORIGIN` | `http://localhost:5173` | Public HTTPS origin | No |
| `DATABASE_HOST` | `localhost` or Compose `postgres` | Compose fixes `postgres` | No |
| `DATABASE_PORT` | `5432` | Compose fixes `5432` | No |
| `DATABASE_NAME` | `.env` | Deployment-process environment | No |
| `DATABASE_USER` | `.env` | Deployment-process environment | No |
| `DATABASE_PASSWORD` | `.env` | Deployment-process environment converted to a Compose secret | Yes |

Every required application value also supports a mutually exclusive `<NAME>_FILE` form. Production uses `DATABASE_PASSWORD_FILE=/run/secrets/database_password`. Startup fails when a value is missing, empty, invalid, or supplied both directly and through `_FILE`.

## Production baseline

Production does not use an environment file. The deployment process exports `APP_IMAGE`, `ORIGIN`, `SITE_ADDRESS`, `DATABASE_NAME`, `DATABASE_USER`, and `DATABASE_PASSWORD`, then runs:

```powershell
docker compose --file compose.prod.yaml config --quiet
docker compose --file compose.prod.yaml up --detach --wait
```

`APP_IMAGE` must identify the already-built immutable application image. Caddy is the only service with published ports. PostgreSQL persists in `postgres_data` and is reachable only on the Compose network. The database password becomes `/run/secrets/database_password` in the app and PostgreSQL containers; it is not stored in a production `.env` file.

The application container runs as the unprivileged `node` user with `no-new-privileges`. Its root filesystem remains writable in Plan 1 because Docker Compose cannot materialize an environment-backed secret into a read-only container root filesystem; Plan 7 must revisit that control alongside the production secret provider.

Check the baseline:

```powershell
docker compose --file compose.prod.yaml ps
docker compose --file compose.prod.yaml logs --tail 100 app postgres caddy
```

`/health/live` proves that the Node process responds. `/health/ready` proves that application configuration loaded successfully. Plan 2 adds a real database readiness probe. All other production paths return 503 while `APPLICATION_MODE=maintenance`.

## Ownership of later work

- Plan 2 adds the database adapter, migrations, worker, jobs, and database readiness.
- Plan 3 adds the provider-neutral SMTP adapter and connects it to Mailpit in development.
- Plan 4 adds the private uploads volume and storage adapters.
- Plan 7 adds the Hetzner deployment runbook, backup/restore procedures, monitoring, final capacity tuning, and the read-only-rootfs review.
~~~~

- [ ] **Step 2: Update the README development entry point**

Replace the current `## Development` section in `README.md` with:

~~~~markdown
## Development

Requirements: Node.js 26.7.x, npm 11.19.x, Docker, and Docker Compose 2.30 or newer.

```powershell
Copy-Item .env.example .env
npm ci
npm run test:e2e:install
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

The storefront runs at `http://localhost:5173`; Mailpit runs at `http://localhost:8025`. See [runtime environments](docs/runtime-environments.md) for host-run development, production process secrets, health checks, and cleanup commands.

Quality gates:

```powershell
npm run check
npm run lint
npm run test:unit
npm run test:e2e
npm run build
npm run verify
```

Development retains the clickable frontend prototype. The production Compose baseline is deliberately locked to maintenance mode until later backend plans replace the prototype's browser identity, local purchase grants, in-memory entitlements, and fake delivery seams.
~~~~

- [ ] **Step 3: Run all application quality gates from a clean process**

Ensure no dev server from an earlier step still owns port 4173, then run:

```powershell
npm ci
npm run verify
npm ls --depth=0
npm audit --audit-level=high
```

Expected:

- `npm ci` succeeds with npm 11.19.x.
- Svelte/TypeScript checking reports zero errors and warnings.
- ESLint passes.
- All unit tests pass.
- Both Playwright files pass in Chromium.
- The adapter-node production build passes.
- The dependency tree is valid.
- The audit exits zero at the high threshold and only the accepted low-severity finding remains.

- [ ] **Step 4: Re-run both Compose schema gates**

Run:

```powershell
$env:DEV_ENV_FILE = '.env.example'
$env:APP_IMAGE = 'pale-orbit:plan1'
$env:ORIGIN = 'http://127.0.0.1:18080'
$env:SITE_ADDRESS = ':80'
$env:DATABASE_NAME = 'pale_orbit'
$env:DATABASE_USER = 'pale_orbit'
$env:DATABASE_PASSWORD = 'compose-validation-only'

try {
  docker compose --env-file .env.example --file compose.dev.yaml config --quiet
  docker compose --file compose.prod.yaml config --quiet
} finally {
  @(
    'DEV_ENV_FILE',
    'APP_IMAGE',
    'ORIGIN',
    'SITE_ADDRESS',
    'DATABASE_NAME',
    'DATABASE_USER',
    'DATABASE_PASSWORD'
  ) | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
}
```

Expected: both files validate successfully. Neither command starts or changes a container.

- [ ] **Step 5: Inspect currency, scope, and repository hygiene**

Run:

```powershell
npm outdated --json
git diff --check
git status --short
git log --oneline --decorate -8
```

Expected:

- Only the documented TypeScript 7 difference remains in `npm outdated`.
- No whitespace errors or generated test reports are tracked.
- Commits are separated by dependency, browser test, configuration, health/safety, image, development Compose, production Compose, and documentation concerns.
- No Drizzle, database driver, auth, SMTP, worker, storage, Redis, or application-domain implementation has entered Plan 1.

- [ ] **Step 6: Commit documentation and final verification state**

```powershell
git add README.md docs/runtime-environments.md
git commit -m "docs: document runtime environments"
git status --short
```

Expected: the final status is clean.

## Plan 1 completion contract

Plan 1 is complete only when all of the following are true:

- [ ] Current stable dependency and image versions were rechecked and dated decisions were recorded.
- [ ] The existing guided-comic defect has a Playwright regression that failed before the minimal fix and passes afterward.
- [ ] Vitest remains the unit-test runner and Playwright runs against an isolated SvelteKit server with explicit test configuration.
- [ ] Required settings accept direct values or mutually exclusive `_FILE` values, reject missing/empty/conflicting input, and never include secret contents in errors.
- [ ] SvelteKit validates all required configuration during server initialization.
- [ ] `/health/live` and `/health/ready` have stable, no-store JSON contracts.
- [ ] Development keeps prototype behavior, while production maintenance mode returns 503 for all non-health paths.
- [ ] The exact non-root Node 26.7.0 application image builds and runs.
- [ ] The development Compose stack starts healthy PostgreSQL 18.4, Mailpit 1.30.0, and the source-mounted app from a local `.env` contract.
- [ ] The production Compose stack starts the versioned app, private PostgreSQL, and Caddy using a process-sourced secret and no production `.env`.
- [ ] PostgreSQL persists at the PostgreSQL 18 volume target and has no published production port.
- [ ] Caddy is the only production ingress and proxies both health contracts.
- [ ] Unit tests, Playwright, checks, lint, build, dependency-tree validation, audit threshold, image smoke, and both Compose smoke tests pass.
- [ ] Runtime documentation states exactly what this phase provides and what later plans own.

## Plan 2 handoff

Plan 2 may begin after this completion contract passes and the branch is reviewed. It should consume the typed database configuration created here, add the PostgreSQL driver and Drizzle test-first, create the migration command and one-shot migration Compose profile, add the real worker service, and extend readiness with a bounded database probe. It must not weaken or bypass production maintenance mode merely to expose unfinished domain routes.

## Authoritative references

- [SvelteKit adapter-node environment, proxy, body-size, and shutdown settings](https://svelte.dev/docs/kit/adapter-node)
- [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)
- [Docker Compose `secrets` reference](https://docs.docker.com/reference/compose-file/secrets/)
- [Official PostgreSQL Docker image](https://hub.docker.com/_/postgres)
- [PostgreSQL 18.4 release](https://www.postgresql.org/docs/release/18.4/)
- [Mailpit releases](https://github.com/axllent/mailpit/releases)
- [Official Caddy Docker image](https://hub.docker.com/_/caddy)
- [Playwright test web-server configuration](https://playwright.dev/docs/test-webserver)
