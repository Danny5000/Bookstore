# Backend Plan 2: Database, Domain, Jobs, and Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the backend foundation's database placeholder with a real PostgreSQL/Drizzle persistence layer, reviewed migrations, transaction-safe catalog and revision skeletons, durable jobs and outbox processing, append-only audit events, foundational admin policy, a production worker, and dependency-aware readiness.

**Architecture:** Keep one modular SvelteKit application and one immutable Node image. The web process, migration command, and worker share narrow server-only modules and the same validated configuration; `node-postgres` owns bounded connection pools, Drizzle owns typed queries and code-first schema, and committed SQL migrations are applied explicitly before services start. PostgreSQL is the only queue: workers claim jobs with `FOR UPDATE SKIP LOCKED`, bounded leases, and deterministic exponential retry. Domain services accept an explicit actor and correlation identifier, enforce admin capabilities before opening transactions, and append redacted audit events in the same transaction as catalog changes.

**Tech Stack:** Node.js 26.7.0, npm 11.19.0, SvelteKit 2.70.2, TypeScript 6.0.3, Vite 8.2.1, Vitest 4.1.10, Playwright 1.62.1, Zod 4.4.3, PostgreSQL 18.4, Drizzle ORM 0.45.2, Drizzle Kit 0.31.10, node-postgres 8.23.0, `@types/pg` 8.21.0, and tsx 4.23.11.

---

## Source of truth and boundaries

This plan implements Plan 2 from `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md` and consumes the completed Plan 1 contract on `main`.

Preserve these boundaries throughout execution:

- Keep development prototype routes clickable and keep production locked to `APPLICATION_MODE=maintenance`.
- Do not integrate Better Auth, sessions, password reset, magic links, SMTP delivery, storage, ingestion, Stripe commerce, entitlements, reader persistence, or admin UI routes. Those remain owned by Plans 3 through 6.
- Do not add Redis. PostgreSQL jobs and outbox messages are the only background-work mechanism in this phase.
- All new primary keys are UUIDs, timestamps use PostgreSQL `timestamptz`, money uses integer minor units plus a three-letter uppercase currency, and important invariants have database constraints.
- Drizzle TypeScript schema is the model source of truth. Generated SQL, snapshots, and the custom append-only audit trigger are committed and reviewed. Production never uses `drizzle-kit push`.
- Integration tests use a disposable real PostgreSQL 18.4 container with a Docker-assigned loopback port. They never reuse or delete a developer's Compose volumes.
- The migration service is an explicit one-shot deployment step. Web and worker processes never apply migrations automatically at startup.
- The application image remains non-root and receives database credentials through the existing `_FILE` secret contract in production.

## Dependency decisions

Registry checks on 2026-08-08 selected these current stable lines:

| Package | Selected | Responsibility |
| --- | --- | --- |
| `drizzle-orm` | 0.45.2 | Typed PostgreSQL schema, queries, transactions, and runtime migrator |
| `drizzle-kit` | 0.31.10 | Development-only SQL migration generation and consistency checking |
| `pg` | 8.23.0 | Long-lived PostgreSQL connection pools for web, worker, and migration processes |
| `@types/pg` | 8.21.0 | Type declarations required by node-postgres |
| `tsx` | 4.23.11 | Development-only execution of TypeScript worker, migration, and test orchestration scripts |

The chosen approach is Drizzle plus node-postgres. It matches the approved design, keeps pool ownership explicit, and follows Drizzle's supported PostgreSQL adapter. Postgres.js would also work but would add no useful capability here; direct SQL without Drizzle would violate the approved schema source-of-truth decision.

## File map

### Configuration and build entry points

- `src/lib/server/config/load.ts` — environment-agnostic application configuration loader used by web, worker, migration, tests, and Drizzle tooling.
- `src/lib/server/config/index.ts` — SvelteKit-only cached configuration accessor using `$env/dynamic/private`.
- `src/lib/server/config/schema.ts` — validated database pool and worker settings in addition to the Plan 1 contract.
- `drizzle.config.ts` — code-first schema/migration generation configuration; it contains no credentials.
- `vite.services.config.ts` — Node SSR bundle with `worker` and `migrate` entry points.
- `src/migrate.ts` — one-shot migration process.
- `src/worker.ts` — long-running worker process and graceful shutdown.

### Database and schema

- `src/lib/server/db/client.ts` — pool construction, Drizzle binding, and explicit close ownership.
- `src/lib/server/db/runtime.ts` — web-process singleton database client.
- `src/lib/server/db/transaction.ts` — transaction callback conventions and executor type.
- `src/lib/server/db/health.ts` — bounded `select 1` readiness probe.
- `src/lib/server/db/migrate.ts` — reusable runtime migration function.
- `src/lib/server/db/schema/catalog.ts` — catalog and immutable revision enums/tables/constraints.
- `src/lib/server/db/schema/operations.ts` — jobs, outbox, and audit enums/tables/indexes/constraints.
- `src/lib/server/db/schema/index.ts` — schema barrel used by Drizzle Kit and the runtime client.
- `drizzle/` — generated and custom reviewed SQL migration history.
- `src/lib/server/prototype-db.ts` — renamed in-memory prototype purchase seam, retained until Plans 5 and 6 replace its callers.

### Domain modules

- `src/lib/server/auth/admin-policy.ts` — actor, role, capability, and typed authorization errors without an auth vendor dependency.
- `src/lib/server/audit/redact.ts` — recursive defensive redaction for audit details.
- `src/lib/server/audit/service.ts` — insert-only audit append API.
- `src/lib/server/catalog/input.ts` — Zod validation and normalization for catalog skeleton commands.
- `src/lib/server/catalog/service.ts` — private-title and revision-skeleton transactions with audit.
- `src/lib/server/jobs/backoff.ts` — bounded deterministic exponential retry calculation.
- `src/lib/server/jobs/repository.ts` — enqueue, lease-based claim, complete, and retry/fail persistence.
- `src/lib/server/jobs/runner.ts` — handler registry and abortable sequential worker loop.
- `src/lib/server/jobs/types.ts` — job records, handlers, and repository contracts.
- `src/lib/server/outbox/repository.ts` — transactional outbox insert paired with a durable dispatch job.
- `src/lib/server/outbox/dispatcher.ts` — at-least-once topic dispatch plus delivered/failed state recording and replay suppression after delivery is recorded.

### Tests and operations

- `compose.test.yaml` — disposable PostgreSQL used only by automated integration and browser tests.
- `scripts/with-test-database.ts` — isolated Compose lifecycle, dynamic port discovery, migrations, child command, and guaranteed cleanup.
- `vitest.integration.config.ts` — serialized real-PostgreSQL integration test project.
- `tests/integration/database.ts` — shared test database client.
- `tests/integration/setup.ts` — per-test truncation and final pool cleanup.
- `tests/integration/*.test.ts` — migrations, constraints, transactions, audit, job claiming, outbox, and catalog behavior.
- `compose.dev.yaml` — source-mounted worker and one-shot migration profile.
- `compose.prod.yaml` — immutable worker and migration services with the existing process-backed secret.
- `Dockerfile` — service bundles and migration SQL in the runtime image.
- `docs/database-and-workers.md` — exact local, test, migration, worker, and production workflows.
- `docs/runtime-environments.md` — updated topology and readiness contract.

## Task 1: Add exact database tooling and preserve the prototype database seam

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/dependency-decisions.md`
- Rename: `src/lib/server/db.ts` to `src/lib/server/prototype-db.ts`
- Modify: `src/routes/api/deliver/+server.ts`
- Modify: `src/routes/api/stripe-webhook/+server.ts`

- [ ] **Step 1: Reconfirm the registry versions before changing the lockfile**

Run:

```powershell
npm view drizzle-orm version peerDependencies --json
npm view drizzle-kit version --json
npm view pg version engines --json
npm view @types/pg version --json
npm view tsx version engines --json
```

Expected: the selected stable versions are `0.45.2`, `0.31.10`, `8.23.0`, `8.21.0`, and `4.23.11`. If a stable version changed, inspect its official release notes and peer requirements, update this plan's version table and commands, and keep all dependency changes in this task.

- [ ] **Step 2: Install the exact runtime and development packages**

Run:

```powershell
npm install --save-exact drizzle-orm@0.45.2 pg@8.23.0
npm install --save-dev --save-exact drizzle-kit@0.31.10 @types/pg@8.21.0 tsx@4.23.11
npm ls drizzle-orm drizzle-kit pg @types/pg tsx
```

Expected: npm reports one valid copy of each selected version and no peer dependency error.

- [ ] **Step 3: Move the prototype seam out of the real database module namespace**

Run:

```powershell
git mv src/lib/server/db.ts src/lib/server/prototype-db.ts
```

Change both prototype route imports to the explicit compatibility seam:

```ts
import { entitlementsFor } from '$lib/server/prototype-db';
```

```ts
import { grantPurchase } from '$lib/server/prototype-db';
```

Do not change the in-memory behavior. Production remains in maintenance mode, and later plans replace these callers with real commerce and entitlement modules.

- [ ] **Step 4: Record the dependency decisions**

Add these rows to `docs/dependency-decisions.md`:

```markdown
| Drizzle ORM | 0.45.2 | Current stable typed PostgreSQL ORM; schema files are the source of truth and runtime code uses the node-postgres adapter. |
| Drizzle Kit | 0.31.10 | Current stable development-only migration generator/checker; generated SQL and snapshots are committed. |
| node-postgres (`pg`) | 8.23.0 | Current stable pooled PostgreSQL driver supported by Drizzle; web, worker, and migration processes own separate bounded pools. |
| `@types/pg` | 8.21.0 | Current node-postgres type declarations required by the strict TypeScript build. |
| tsx | 4.23.11 | Current stable development-only TypeScript runner for worker, migration, and test orchestration entry points. |
```

- [ ] **Step 5: Verify the dependency-only change and preserved prototype**

Run:

```powershell
npm run check
npm run lint
npm run test:unit
npm run build
npm ls --depth=0
npm audit --audit-level=high
```

Expected: all commands exit zero and 67 existing unit tests pass. Document the low-severity `cookie` path plus any current-stable, development-only Drizzle Kit advisory path; do not apply npm's incompatible forced downgrades.

- [ ] **Step 6: Commit the dependency boundary**

```powershell
git add package.json package-lock.json docs/dependency-decisions.md src/lib/server/prototype-db.ts src/routes/api/deliver/+server.ts src/routes/api/stripe-webhook/+server.ts
git commit -m "chore: add postgres and drizzle tooling"
```

## Task 2: Make validated configuration reusable by web, migration, and worker processes

**Files:**
- Create: `src/lib/server/config/load.ts`
- Modify: `src/lib/server/config/index.ts`
- Modify: `src/lib/server/config/schema.ts`
- Modify: `src/lib/server/config/index.test.ts`
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Write failing tests for database and worker settings**

Add these cases to `src/lib/server/config/index.test.ts` and extend the valid fixture with the values shown:

```ts
const VALID_DEVELOPMENT_ENVIRONMENT: EnvironmentValues = {
  APP_ENV: 'development',
  APPLICATION_MODE: 'prototype',
  ORIGIN: 'http://localhost:5173',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'pale_orbit',
  DATABASE_USER: 'pale_orbit',
  DATABASE_PASSWORD: 'development-only',
  DATABASE_POOL_MAX: '5',
  DATABASE_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_STATEMENT_TIMEOUT_MS: '30000',
  DATABASE_READINESS_TIMEOUT_MS: '2000',
  JOB_POLL_INTERVAL_MS: '1000',
  JOB_LEASE_MS: '30000',
  JOB_RETRY_BASE_MS: '1000',
  JOB_RETRY_MAX_MS: '300000',
  WORKER_READY_FILE: '.worker-ready'
};

it('returns bounded database and worker settings', () => {
  const config = loadApplicationConfig(VALID_DEVELOPMENT_ENVIRONMENT);

  expect(config.database).toMatchObject({
    poolMax: 5,
    connectionTimeoutMs: 5000,
    statementTimeoutMs: 30000,
    readinessTimeoutMs: 2000
  });
  expect(config.jobs).toEqual({
    pollIntervalMs: 1000,
    leaseMs: 30000,
    retryBaseMs: 1000,
    retryMaxMs: 300000,
    workerReadyFile: '.worker-ready'
  });
});

it.each([
  ['DATABASE_POOL_MAX', '0'],
  ['DATABASE_READINESS_TIMEOUT_MS', 'not-a-number'],
  ['JOB_POLL_INTERVAL_MS', '0'],
  ['JOB_LEASE_MS', '500']
])('rejects invalid operational setting %s=%s', (key, value) => {
  expect(() =>
    loadApplicationConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, [key]: value })
  ).toThrow(ConfigurationError);
});

it('rejects a retry base greater than the retry ceiling', () => {
  expect(() =>
    loadApplicationConfig({
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      JOB_RETRY_BASE_MS: '6000',
      JOB_RETRY_MAX_MS: '5000'
    })
  ).toThrow(/JOB_RETRY_BASE_MS: must not exceed JOB_RETRY_MAX_MS/);
});
```

Also update existing expected configuration objects to include the new `database` properties and `jobs` object.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npx vitest run src/lib/server/config/index.test.ts
```

Expected: FAIL because the new settings are not loaded and the operational bounds are not enforced.

- [ ] **Step 3: Replace `src/lib/server/config/schema.ts` with the complete expanded schema**

```ts
import { z } from 'zod';
import { ConfigurationError } from './read-setting';

const integerSetting = (minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^\d+$/, `must be an integer between ${minimum} and ${maximum}`)
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().min(minimum).max(maximum));

const port = integerSetting(1, 65_535);
const milliseconds = integerSetting(1, 86_400_000);

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
    DATABASE_PASSWORD: z.string().min(1),
    DATABASE_POOL_MAX: integerSetting(1, 100),
    DATABASE_CONNECTION_TIMEOUT_MS: milliseconds,
    DATABASE_STATEMENT_TIMEOUT_MS: milliseconds,
    DATABASE_READINESS_TIMEOUT_MS: milliseconds,
    JOB_POLL_INTERVAL_MS: milliseconds,
    JOB_LEASE_MS: milliseconds,
    JOB_RETRY_BASE_MS: milliseconds,
    JOB_RETRY_MAX_MS: milliseconds,
    WORKER_READY_FILE: z.string().trim().min(1)
  })
  .superRefine((value, context) => {
    if (value.APP_ENV === 'production' && value.APPLICATION_MODE !== 'maintenance') {
      context.addIssue({
        code: 'custom',
        path: ['APPLICATION_MODE'],
        message: 'production must use maintenance mode'
      });
    }

    if (value.JOB_POLL_INTERVAL_MS >= value.JOB_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        path: ['JOB_LEASE_MS'],
        message: 'must be greater than JOB_POLL_INTERVAL_MS'
      });
    }

    if (value.JOB_RETRY_BASE_MS > value.JOB_RETRY_MAX_MS) {
      context.addIssue({
        code: 'custom',
        path: ['JOB_RETRY_BASE_MS'],
        message: 'must not exceed JOB_RETRY_MAX_MS'
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
      password: value.DATABASE_PASSWORD,
      poolMax: value.DATABASE_POOL_MAX,
      connectionTimeoutMs: value.DATABASE_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: value.DATABASE_STATEMENT_TIMEOUT_MS,
      readinessTimeoutMs: value.DATABASE_READINESS_TIMEOUT_MS
    },
    jobs: {
      pollIntervalMs: value.JOB_POLL_INTERVAL_MS,
      leaseMs: value.JOB_LEASE_MS,
      retryBaseMs: value.JOB_RETRY_BASE_MS,
      retryMaxMs: value.JOB_RETRY_MAX_MS,
      workerReadyFile: value.WORKER_READY_FILE
    }
  }));

export type ApplicationConfig = z.output<typeof rawApplicationConfigSchema>;
export type ApplicationMode = ApplicationConfig['applicationMode'];
export type DatabaseConfig = ApplicationConfig['database'];
export type JobConfig = ApplicationConfig['jobs'];

export function parseApplicationConfig(value: unknown): ApplicationConfig {
  const result = rawApplicationConfigSchema.safeParse(value);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
    .join('; ');
  throw new ConfigurationError(`Invalid application configuration: ${details}`);
}
```

- [ ] **Step 4: Move the environment-agnostic loader to `load.ts`**

Create `src/lib/server/config/load.ts`:

```ts
import {
  readRequiredSetting,
  type EnvironmentValues,
  type SecretFileReader
} from './read-setting';
import { parseApplicationConfig, type ApplicationConfig } from './schema';

const REQUIRED_SETTINGS = [
  'APP_ENV',
  'APPLICATION_MODE',
  'ORIGIN',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
  'DATABASE_POOL_MAX',
  'DATABASE_CONNECTION_TIMEOUT_MS',
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'DATABASE_READINESS_TIMEOUT_MS',
  'JOB_POLL_INTERVAL_MS',
  'JOB_LEASE_MS',
  'JOB_RETRY_BASE_MS',
  'JOB_RETRY_MAX_MS',
  'WORKER_READY_FILE'
] as const;

export function loadApplicationConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): ApplicationConfig {
  return parseApplicationConfig(
    Object.fromEntries(
      REQUIRED_SETTINGS.map((name) => [
        name,
        readRequiredSetting(source, name, readSecretFile)
      ])
    )
  );
}
```

Replace `src/lib/server/config/index.ts` with the SvelteKit-only wrapper:

```ts
import { env } from '$env/dynamic/private';
import { loadApplicationConfig } from './load';
import type { ApplicationConfig } from './schema';

export { loadApplicationConfig } from './load';
export type {
  ApplicationConfig,
  ApplicationMode,
  DatabaseConfig,
  JobConfig
} from './schema';

let cachedConfiguration: ApplicationConfig | undefined;

export function getApplicationConfig(): ApplicationConfig {
  cachedConfiguration ??= loadApplicationConfig(env);
  return cachedConfiguration;
}
```

The worker, migration process, and test orchestration must import `loadApplicationConfig` from `config/load`, never from this SvelteKit wrapper.

- [ ] **Step 5: Extend development and Playwright configuration values**

Add to `.env.example`:

```dotenv
# PostgreSQL pool and readiness bounds
DATABASE_POOL_MAX=5
DATABASE_CONNECTION_TIMEOUT_MS=5000
DATABASE_STATEMENT_TIMEOUT_MS=30000
DATABASE_READINESS_TIMEOUT_MS=2000

# PostgreSQL worker bounds
JOB_POLL_INTERVAL_MS=1000
JOB_LEASE_MS=30000
JOB_RETRY_BASE_MS=1000
JOB_RETRY_MAX_MS=300000
WORKER_READY_FILE=.worker-ready
```

Add the same settings to `playwright.config.ts`'s `webServer.env`, using `WORKER_READY_FILE: '.worker-ready-test'`.

Add the host-run readiness artifact to `.gitignore`:

```gitignore
/.worker-ready*
```

- [ ] **Step 6: Run focused and full configuration tests**

Run:

```powershell
npx vitest run src/lib/server/config/read-setting.test.ts src/lib/server/config/index.test.ts
npm run check
npm run lint
```

Expected: all configuration tests pass and Svelte/TypeScript checking reports zero errors and warnings.

- [ ] **Step 7: Commit the shared process configuration**

```powershell
git add .env.example .gitignore playwright.config.ts src/lib/server/config
git commit -m "feat: share database and worker configuration"
```

## Task 3: Add a disposable PostgreSQL integration harness and pooled database client

**Files:**
- Create: `compose.test.yaml`
- Create: `scripts/with-test-database.ts`
- Create: `vitest.integration.config.ts`
- Create: `src/lib/server/db/client.ts`
- Create: `tests/integration/database.ts`
- Create: `tests/integration/setup.ts`
- Create: `tests/integration/database.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Define an isolated PostgreSQL-only test stack**

Create `compose.test.yaml`:

```yaml
services:
  postgres:
    image: postgres:18.4-alpine3.24
    environment:
      POSTGRES_DB: pale_orbit_test
      POSTGRES_USER: pale_orbit_test
      POSTGRES_PASSWORD: pale_orbit_test_only
    ports:
      - target: 5432
        published: "0"
        host_ip: 127.0.0.1
        protocol: tcp
    tmpfs:
      - /var/lib/postgresql:rw,noexec,nosuid,size=256m
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"']
      interval: 2s
      timeout: 3s
      retries: 30
      start_period: 5s
```

The random published port and per-process Compose project prevent collisions with development PostgreSQL. The tmpfs and final `down --volumes` ensure test data is disposable.

- [ ] **Step 2: Create the cross-platform Compose lifecycle wrapper**

Create `scripts/with-test-database.ts`:

```ts
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
```

- [ ] **Step 3: Write the failing pooled-client integration test**

Create `vitest.integration.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    clearMocks: true,
    restoreMocks: true
  }
});
```

Create `tests/integration/database.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { databaseClient } from './database';

describe('database client', () => {
  it('queries the disposable PostgreSQL instance', async () => {
    const result = await databaseClient.pool.query<{ value: number }>('select 1 as value');
    expect(result.rows).toEqual([{ value: 1 }]);
  });
});
```

Add temporary empty `tests/integration/database.ts` and `tests/integration/setup.ts` modules containing only `export {};`, then add these scripts to `package.json`:

```json
"test:integration:raw": "vitest run --config vitest.integration.config.ts",
"test:integration": "tsx scripts/with-test-database.ts npm run test:integration:raw"
```

- [ ] **Step 4: Run the integration test to verify it fails**

Run:

```powershell
npm run test:integration
```

Expected: FAIL because `databaseClient` and the pooled client module do not exist. The wrapper must still remove its explicitly named Compose project.

- [ ] **Step 5: Implement the pooled node-postgres/Drizzle client**

Create `src/lib/server/db/client.ts`:

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { DatabaseConfig } from '$lib/server/config/schema';

export type Database = NodePgDatabase;

export interface DatabaseClient {
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createDatabaseClient(config: DatabaseConfig): DatabaseClient {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    application_name: 'pale-orbit'
  });

  pool.on('error', (error) => {
    console.error('[database] idle client error', { name: error.name });
  });

  return {
    db: drizzle({ client: pool }),
    pool,
    close: () => pool.end()
  };
}
```

Replace `tests/integration/database.ts`:

```ts
import { loadApplicationConfig } from '$lib/server/config/load';
import { createDatabaseClient } from '$lib/server/db/client';

export const applicationConfig = loadApplicationConfig(process.env);
export const databaseClient = createDatabaseClient(applicationConfig.database);
```

Replace `tests/integration/setup.ts`:

```ts
import { afterAll } from 'vitest';
import { databaseClient } from './database';

afterAll(async () => {
  await databaseClient.close();
});
```

- [ ] **Step 6: Run the real-database test and baseline gates**

Run:

```powershell
npm run test:integration
npm run test:unit
npm run check
npm run lint
```

Expected: the integration test returns `{ value: 1 }`, 67 unit tests pass, and the temporary PostgreSQL container/network is removed.

- [ ] **Step 7: Commit the test harness and client**

```powershell
git add compose.test.yaml scripts/with-test-database.ts vitest.integration.config.ts src/lib/server/db/client.ts tests/integration package.json package-lock.json
git commit -m "test: add disposable postgres integration harness"
```

## Task 4: Define the Plan 2 schema and commit reviewed migrations

**Files:**
- Create: `drizzle.config.ts`
- Create: `src/lib/server/db/schema/json.ts`
- Create: `src/lib/server/db/schema/catalog.ts`
- Create: `src/lib/server/db/schema/operations.ts`
- Create: `src/lib/server/db/schema/index.ts`
- Create: `src/lib/server/db/migrate.ts`
- Create: `src/migrate.ts`
- Create: `tests/integration/schema.test.ts`
- Create: `drizzle/0000_plan2_foundation.sql` and generated metadata
- Create: `drizzle/0001_audit_events_append_only.sql` and generated metadata
- Modify: `src/lib/server/db/client.ts`
- Modify: `scripts/with-test-database.ts`
- Modify: `tests/integration/setup.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing migration/schema integration test**

Create `tests/integration/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { databaseClient } from './database';

const PLAN_2_TABLES = [
  'audit_events',
  'jobs',
  'outbox_messages',
  'title_revisions',
  'titles'
];

describe('Plan 2 migrations', () => {
  it('creates every Plan 2 table', async () => {
    const result = await databaseClient.pool.query<{ table_name: string }>(`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])
      order by table_name
    `, [PLAN_2_TABLES]);

    expect(result.rows.map((row) => row.table_name)).toEqual(PLAN_2_TABLES);
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run:

```powershell
npm run test:integration
```

Expected: FAIL because no Plan 2 tables or migrations exist. The plain `select 1` client test still passes.

- [ ] **Step 3: Define the credential-free Drizzle Kit configuration and JSON types**

Create `drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/server/db/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: true
});
```

Create `src/lib/server/db/schema/json.ts`:

```ts
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
```

Migration generation intentionally needs no database credentials. Applying migrations is owned by the runtime migration entry point below.

- [ ] **Step 4: Define the catalog and immutable revision schema**

Create `src/lib/server/db/schema/catalog.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn
} from 'drizzle-orm/pg-core';

export const titleFormat = pgEnum('title_format', ['prose', 'comic']);
export const titleVisibility = pgEnum('title_visibility', ['private', 'public', 'archived']);
export const revisionState = pgEnum('revision_state', [
  'uploaded',
  'processing',
  'ready_for_review',
  'failed',
  'active',
  'retired'
]);

export const titles = pgTable(
  'titles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description').notNull(),
    creatorName: text('creator_name').notNull(),
    format: titleFormat('format').notNull(),
    priceMinor: integer('price_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    visibility: titleVisibility('visibility').default('private').notNull(),
    activeRevisionId: uuid('active_revision_id').references(
      (): AnyPgColumn => titleRevisions.id,
      { onDelete: 'set null' }
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('titles_slug_unique').on(table.slug),
    index('titles_visibility_created_idx').on(table.visibility, table.createdAt),
    check('titles_price_minor_nonnegative', sql`${table.priceMinor} >= 0`),
    check('titles_currency_iso_shape', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check('titles_slug_shape', sql`${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`)
  ]
);

export const titleRevisions = pgTable(
  'title_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'cascade' }),
    parentRevisionId: uuid('parent_revision_id'),
    state: revisionState('state').default('uploaded').notNull(),
    createdByActorId: text('created_by_actor_id').notNull(),
    changeSummary: text('change_summary').notNull(),
    originalStorageKey: text('original_storage_key'),
    originalChecksumSha256: varchar('original_checksum_sha256', { length: 64 }),
    originalMimeType: text('original_mime_type'),
    originalByteSize: bigint('original_byte_size', { mode: 'number' }),
    originalFilename: text('original_filename'),
    failureCode: text('failure_code'),
    failureDetails: text('failure_details'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true })
  },
  (table) => [
    index('title_revisions_title_created_idx').on(table.titleId, table.createdAt),
    index('title_revisions_state_created_idx').on(table.state, table.createdAt),
    unique('title_revisions_title_id_id_unique').on(table.titleId, table.id),
    uniqueIndex('title_revisions_one_active_per_title')
      .on(table.titleId)
      .where(sql`${table.state} = 'active'`),
    foreignKey({
      name: 'title_revisions_parent_same_title_fk',
      columns: [table.titleId, table.parentRevisionId],
      foreignColumns: [table.titleId, table.id]
    }).onDelete('restrict'),
    check(
      'title_revisions_byte_size_positive',
      sql`${table.originalByteSize} is null or ${table.originalByteSize} > 0`
    ),
    check(
      'title_revisions_checksum_shape',
      sql`${table.originalChecksumSha256} is null or ${table.originalChecksumSha256} ~ '^[0-9a-f]{64}$'`
    )
  ]
);

export type TitleRow = typeof titles.$inferSelect;
export type NewTitleRow = typeof titles.$inferInsert;
export type TitleRevisionRow = typeof titleRevisions.$inferSelect;
export type NewTitleRevisionRow = typeof titleRevisions.$inferInsert;
```

Plan 4 owns asset promotion, lifecycle transitions, preview boundaries, activation, retirement, and rollback. This task creates the constrained durable skeleton without exposing routes.

- [ ] **Step 5: Define jobs, transactional outbox, and audit schema**

Create `src/lib/server/db/schema/operations.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import type { JsonObject, JsonValue } from './json';

export const jobStatus = pgEnum('job_status', ['pending', 'running', 'succeeded', 'failed']);
export const outboxStatus = pgEnum('outbox_status', ['pending', 'delivered', 'failed']);
export const auditActorType = pgEnum('audit_actor_type', [
  'anonymous',
  'guest',
  'user',
  'system'
]);
export const auditOutcome = pgEnum('audit_outcome', ['succeeded', 'failed', 'denied']);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    deduplicationKey: text('deduplication_key'),
    status: jobStatus('status').default('pending').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(5).notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('jobs_deduplication_key_unique').on(table.deduplicationKey),
    index('jobs_claim_idx').on(table.status, table.runAt, table.lockedAt, table.createdAt),
    index('jobs_failed_updated_idx').on(table.status, table.updatedAt),
    check('jobs_attempts_nonnegative', sql`${table.attempts} >= 0`),
    check('jobs_max_attempts_positive', sql`${table.maxAttempts} > 0`),
    check(
      'jobs_running_has_lease',
      sql`(${table.status} = 'running') = (${table.lockedAt} is not null and ${table.lockedBy} is not null)`
    ),
    check(
      'jobs_terminal_has_completion',
      sql`(${table.status} in ('succeeded', 'failed')) = (${table.completedAt} is not null)`
    )
  ]
);

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    dispatchJobId: uuid('dispatch_job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    status: outboxStatus('status').default('pending').notNull(),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('outbox_messages_dispatch_job_unique').on(table.dispatchJobId),
    index('outbox_messages_status_created_idx').on(table.status, table.createdAt),
    check(
      'outbox_delivered_has_timestamp',
      sql`(${table.status} = 'delivered') = (${table.deliveredAt} is not null)`
    )
  ]
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    actorType: auditActorType('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    outcome: auditOutcome('outcome').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    correlationId: text('correlation_id').notNull(),
    before: jsonb('before').$type<JsonValue>(),
    after: jsonb('after').$type<JsonValue>()
  },
  (table) => [
    index('audit_events_occurred_idx').on(table.occurredAt),
    index('audit_events_resource_idx').on(table.resourceType, table.resourceId, table.occurredAt),
    index('audit_events_actor_idx').on(table.actorType, table.actorId, table.occurredAt),
    index('audit_events_correlation_idx').on(table.correlationId),
    check(
      'audit_events_actor_id_required',
      sql`${table.actorType} = 'anonymous' or ${table.actorId} is not null`
    )
  ]
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type OutboxMessageRow = typeof outboxMessages.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
```

Create `src/lib/server/db/schema/index.ts`:

```ts
export * from './catalog';
export * from './json';
export * from './operations';
```

- [ ] **Step 6: Bind the complete schema to the database client**

Update `src/lib/server/db/client.ts` imports and type:

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { DatabaseConfig } from '$lib/server/config/schema';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
```

Change the returned Drizzle instance to:

```ts
db: drizzle({ client: pool, schema }),
```

- [ ] **Step 7: Add the reusable migration function and one-shot entry point**

Create `src/lib/server/db/migrate.ts`:

```ts
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client';

export async function migrateDatabase(
  database: Database,
  migrationsFolder = 'drizzle'
): Promise<void> {
  await migrate(database, { migrationsFolder });
}
```

Create `src/migrate.ts`:

```ts
import { loadApplicationConfig } from '$lib/server/config/load';
import { createDatabaseClient } from '$lib/server/db/client';
import { migrateDatabase } from '$lib/server/db/migrate';

const config = loadApplicationConfig(process.env);
const databaseClient = createDatabaseClient(config.database);

try {
  await migrateDatabase(databaseClient.db);
  console.info('[migration] database is current');
} finally {
  await databaseClient.close();
}
```

Add these scripts to `package.json`:

```json
"db:generate": "drizzle-kit generate",
"db:check": "drizzle-kit check",
"db:migrate:raw": "tsx src/migrate.ts",
"db:migrate": "node --env-file-if-exists=.env --import tsx src/migrate.ts"
```

- [ ] **Step 8: Generate the initial schema migration and custom append-only trigger**

Run:

```powershell
npm run db:generate -- --name=plan2_foundation
npm run db:generate -- --custom --name=audit_events_append_only
```

Expected: with the selected Drizzle Kit 0.31.10 line, Drizzle creates `drizzle/0000_plan2_foundation.sql`, `drizzle/0001_audit_events_append_only.sql`, and the migration metadata it uses under `drizzle/meta/`. Keep the generated snapshot/journal files exactly as produced; do not invent or hand-edit metadata for the custom migration.

Replace the custom migration SQL with:

```sql
CREATE OR REPLACE FUNCTION reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_reject_update
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_reject_delete
BEFORE DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
```

Review the generated initial SQL and confirm it contains all five tables, seven enum groups, declared foreign keys, unique indexes, the partial active-revision index, and check constraints. Do not hand-edit generated schema SQL; change the TypeScript schema and regenerate if it is wrong.

- [ ] **Step 9: Apply migrations automatically inside the disposable test wrapper**

In `scripts/with-test-database.ts`, immediately after constructing `testEnvironment`, add:

```ts
runChecked('npm', ['run', 'db:migrate:raw'], testEnvironment);
```

Replace `tests/integration/setup.ts` with:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import { databaseClient } from './database';

beforeEach(async () => {
  await databaseClient.db.execute(sql`
    truncate table audit_events, outbox_messages, jobs, title_revisions, titles
    restart identity cascade
  `);
});

afterAll(async () => {
  await databaseClient.close();
});
```

- [ ] **Step 10: Verify migrations, schema, and migration consistency**

Run:

```powershell
npm run test:integration
npm run db:check
npm run check
npm run lint
git diff --check
```

Expected: both integration tests pass on a freshly migrated PostgreSQL 18.4 database; Drizzle reports a valid migration history; no whitespace errors exist.

- [ ] **Step 11: Commit the schema and migrations**

```powershell
git add drizzle.config.ts drizzle src/migrate.ts src/lib/server/db scripts/with-test-database.ts tests/integration package.json package-lock.json
git commit -m "feat: add drizzle schema and reviewed migrations"
```

## Task 5: Add transaction conventions and real database readiness

**Files:**
- Create: `src/lib/server/db/transaction.ts`
- Create: `src/lib/server/db/transaction.test.ts`
- Create: `src/lib/server/db/runtime.ts`
- Create: `src/lib/server/db/health.ts`
- Create: `src/lib/server/db/health.test.ts`
- Create: `tests/integration/transaction.test.ts`
- Modify: `src/hooks.server.ts`
- Modify: `src/routes/health/ready/+server.ts`
- Modify: `playwright.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing unit tests for bounded readiness and transaction delegation**

Create `src/lib/server/db/health.test.ts`:

```ts
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { probeDatabase } from './health';

describe('probeDatabase', () => {
  it('runs a bounded select-one query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: 1 }] });
    const pool = { query } as unknown as Pool;

    await expect(probeDatabase(pool, 1750)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith({
      text: 'select 1 as ready',
      query_timeout: 1750
    });
  });

  it('rejects when PostgreSQL does not return the expected value', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [] })
    } as unknown as Pool;

    await expect(probeDatabase(pool, 1000)).rejects.toThrow('Database readiness query failed');
  });
});
```

Create `src/lib/server/db/transaction.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client';
import { withTransaction } from './transaction';

describe('withTransaction', () => {
  it('returns the callback result from Drizzle transaction ownership', async () => {
    const transaction = { marker: 'transaction' };
    const database = {
      transaction: vi.fn(async (work: (value: unknown) => Promise<unknown>) => work(transaction))
    } as unknown as Database;

    await expect(withTransaction(database, async (value) => value)).resolves.toBe(transaction);
  });
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```powershell
npx vitest run src/lib/server/db/health.test.ts src/lib/server/db/transaction.test.ts
```

Expected: FAIL because `health.ts` and `transaction.ts` do not exist.

- [ ] **Step 3: Implement transaction and readiness helpers**

Create `src/lib/server/db/transaction.ts`:

```ts
import type { Database } from './client';

type TransactionCallback = Parameters<Database['transaction']>[0];
export type DatabaseTransaction = Parameters<TransactionCallback>[0];
export type DatabaseExecutor = Database | DatabaseTransaction;

export function withTransaction<T>(
  database: Database,
  work: (transaction: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return database.transaction(work);
}
```

Create `src/lib/server/db/health.ts`:

```ts
import type { Pool, QueryConfig } from 'pg';

interface TimedQueryConfig extends QueryConfig {
  query_timeout: number;
}

export async function probeDatabase(pool: Pool, timeoutMs: number): Promise<void> {
  const query: TimedQueryConfig = {
    text: 'select 1 as ready',
    query_timeout: timeoutMs
  };
  const result = await pool.query<{ ready: number }>(query);

  if (result.rows[0]?.ready !== 1) {
    throw new Error('Database readiness query failed');
  }
}
```

- [ ] **Step 4: Add the web-process database singleton**

Create `src/lib/server/db/runtime.ts`:

```ts
import { getApplicationConfig } from '$lib/server/config';
import { createDatabaseClient, type DatabaseClient } from './client';

let databaseClient: DatabaseClient | undefined;

export function getDatabaseClient(): DatabaseClient {
  databaseClient ??= createDatabaseClient(getApplicationConfig().database);
  return databaseClient;
}
```

Update `src/hooks.server.ts` initialization:

```ts
import { getDatabaseClient } from '$lib/server/db/runtime';

export const init: ServerInit = () => {
  getApplicationConfig();
  getDatabaseClient();
};
```

Pool construction remains lazy with respect to network I/O. The readiness endpoint owns the bounded dependency probe.

- [ ] **Step 5: Replace configuration-only readiness with the real database probe**

Replace `src/routes/health/ready/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationConfig } from '$lib/server/config';
import { probeDatabase } from '$lib/server/db/health';
import { getDatabaseClient } from '$lib/server/db/runtime';

const headers = { 'cache-control': 'no-store' };

export const GET: RequestHandler = async () => {
  const config = getApplicationConfig();
  const databaseClient = getDatabaseClient();

  try {
    await probeDatabase(databaseClient.pool, config.database.readinessTimeoutMs);
    return json({ status: 'ready' }, { headers });
  } catch {
    return json({ status: 'not_ready' }, { status: 503, headers });
  }
};
```

Do not include hostnames, driver messages, or credentials in the 503 body.

- [ ] **Step 6: Add a real transaction rollback integration test**

Create `tests/integration/transaction.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { titles } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { databaseClient } from './database';

describe('database transactions', () => {
  it('rolls back every write when the callback rejects', async () => {
    await expect(
      withTransaction(databaseClient.db, async (transaction) => {
        await transaction.insert(titles).values({
          slug: 'rolled-back-title',
          title: 'Rolled Back Title',
          description: 'This row must not survive.',
          creatorName: 'Pale Orbit',
          format: 'prose',
          priceMinor: 1200,
          currency: 'USD'
        });
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    const count = await databaseClient.db.execute<{ count: number }>(sql`
      select count(*)::int as count from titles
    `);
    expect(count.rows[0]?.count).toBe(0);
  });
});
```

- [ ] **Step 7: Make browser and integration tests share one disposable migrated database**

In `playwright.config.ts`, replace the hard-coded database fields in `webServer.env` with inherited test-database values and safe direct-run fallbacks:

```ts
DATABASE_HOST: process.env.DATABASE_HOST ?? '127.0.0.1',
DATABASE_PORT: process.env.DATABASE_PORT ?? '5432',
DATABASE_NAME: process.env.DATABASE_NAME ?? 'pale_orbit_test',
DATABASE_USER: process.env.DATABASE_USER ?? 'pale_orbit_test',
DATABASE_PASSWORD: process.env.DATABASE_PASSWORD ?? 'pale_orbit_test_only',
DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? '5',
DATABASE_CONNECTION_TIMEOUT_MS: process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? '5000',
DATABASE_STATEMENT_TIMEOUT_MS: process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? '30000',
DATABASE_READINESS_TIMEOUT_MS: process.env.DATABASE_READINESS_TIMEOUT_MS ?? '2000',
JOB_POLL_INTERVAL_MS: process.env.JOB_POLL_INTERVAL_MS ?? '25',
JOB_LEASE_MS: process.env.JOB_LEASE_MS ?? '5000',
JOB_RETRY_BASE_MS: process.env.JOB_RETRY_BASE_MS ?? '10',
JOB_RETRY_MAX_MS: process.env.JOB_RETRY_MAX_MS ?? '1000',
WORKER_READY_FILE: process.env.WORKER_READY_FILE ?? '.worker-ready-test'
```

Replace/add package scripts:

```json
"test:e2e:raw": "playwright test",
"test:e2e": "tsx scripts/with-test-database.ts npm run test:e2e:raw",
"test:database:raw": "npm run test:integration:raw && npm run test:e2e:raw",
"test:database": "tsx scripts/with-test-database.ts npm run test:database:raw",
"verify": "npm run check && npm run lint && npm run test:unit && npm run test:database && npm run build"
```

The existing readiness Playwright test now proves PostgreSQL connectivity rather than only configuration parsing.

- [ ] **Step 8: Run the red-green and complete database-aware gates**

Run:

```powershell
npx vitest run src/lib/server/db/health.test.ts src/lib/server/db/transaction.test.ts
npm run test:integration
npm run test:e2e
npm run check
npm run lint
```

Expected: unit tests pass; integration rollback leaves zero titles; both health endpoints and the reader regression pass against a real disposable PostgreSQL database.

- [ ] **Step 9: Commit transaction and readiness behavior**

```powershell
git add src/hooks.server.ts src/routes/health/ready/+server.ts src/lib/server/db tests/integration/transaction.test.ts playwright.config.ts package.json package-lock.json
git commit -m "feat: add database transactions and readiness"
```

## Task 6: Add foundational admin policy and append-only redacted audit events

**Files:**
- Create: `src/lib/server/auth/admin-policy.ts`
- Create: `src/lib/server/auth/admin-policy.test.ts`
- Create: `src/lib/server/audit/redact.ts`
- Create: `src/lib/server/audit/redact.test.ts`
- Create: `src/lib/server/audit/service.ts`
- Create: `tests/integration/audit.test.ts`

- [ ] **Step 1: Write failing authorization policy tests**

Create `src/lib/server/auth/admin-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AuthorizationError,
  requireCapability,
  type Actor
} from './admin-policy';

describe('requireCapability', () => {
  it('allows an administrator to manage catalog records', () => {
    const actor: Actor = { type: 'user', id: 'admin-1', roles: ['admin'] };
    expect(() => requireCapability(actor, 'catalog.manage')).not.toThrow();
  });

  it('rejects an anonymous actor as unauthenticated', () => {
    expect(() => requireCapability({ type: 'anonymous' }, 'audit.read')).toThrow(
      new AuthorizationError('unauthenticated', 401)
    );
  });

  it('rejects a customer as forbidden', () => {
    const actor: Actor = { type: 'user', id: 'customer-1', roles: ['customer'] };
    expect(() => requireCapability(actor, 'jobs.retry')).toThrow(
      new AuthorizationError('forbidden', 403)
    );
  });

  it('does not treat a background system actor as an administrator', () => {
    expect(() =>
      requireCapability({ type: 'system', id: 'worker-1' }, 'catalog.manage')
    ).toThrow(AuthorizationError);
  });
});
```

- [ ] **Step 2: Write failing recursive audit-redaction tests**

Create `src/lib/server/audit/redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '$lib/server/db/schema';
import { redactAuditDetails } from './redact';

describe('redactAuditDetails', () => {
  it('redacts nested sensitive keys while retaining safe context', () => {
    expect(
      redactAuditDetails({
        title: 'A Safe Title',
        credentials: {
          password: 'never-store-this',
          resetToken: 'never-store-this-either'
        },
        changes: [{ field: 'visibility', value: 'private' }]
      })
    ).toEqual({
      title: 'A Safe Title',
      credentials: '[redacted]',
      changes: [{ field: 'visibility', value: 'private' }]
    });
  });

  it('bounds deeply nested data', () => {
    const value: JsonValue = {};
    let cursor = value as { [key: string]: JsonValue };
    for (let index = 0; index < 12; index += 1) {
      const nested: { [key: string]: JsonValue } = {};
      cursor.nested = nested;
      cursor = nested;
    }
    expect(JSON.stringify(redactAuditDetails(value))).toContain('[truncated]');
  });
});
```

- [ ] **Step 3: Run the focused tests to verify they fail**

Run:

```powershell
npx vitest run src/lib/server/auth/admin-policy.test.ts src/lib/server/audit/redact.test.ts
```

Expected: FAIL because the policy and redaction modules do not exist.

- [ ] **Step 4: Implement the vendor-neutral actor/capability policy**

Create `src/lib/server/auth/admin-policy.ts`:

```ts
export type ApplicationRole = 'customer' | 'admin';
export type AdminCapability = 'catalog.manage' | 'audit.read' | 'jobs.retry';

export type Actor =
  | { type: 'anonymous' }
  | { type: 'guest'; id: string }
  | { type: 'system'; id: string }
  | { type: 'user'; id: string; roles: readonly ApplicationRole[] };

export type AdministratorActor = Extract<Actor, { type: 'user' }> & {
  roles: readonly ApplicationRole[];
};

export class AuthorizationError extends Error {
  constructor(
    readonly code: 'unauthenticated' | 'forbidden',
    readonly status: 401 | 403
  ) {
    super(code);
    this.name = 'AuthorizationError';
  }
}

export function requireCapability(
  actor: Actor,
  _capability: AdminCapability
): asserts actor is AdministratorActor {
  if (actor.type === 'anonymous') {
    throw new AuthorizationError('unauthenticated', 401);
  }
  if (actor.type !== 'user' || !actor.roles.includes('admin')) {
    throw new AuthorizationError('forbidden', 403);
  }
}
```

Plan 3 maps Better Auth sessions and application roles into this actor type. No route may trust a browser-provided actor or role.

- [ ] **Step 5: Implement bounded recursive redaction**

Create `src/lib/server/audit/redact.ts`:

```ts
import type { JsonValue } from '$lib/server/db/schema';

const SENSITIVE_KEY = /password|secret|token|authorization|cookie|credential/i;
const MAX_DEPTH = 8;

export function redactAuditDetails(value: JsonValue, depth = 0): JsonValue {
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((entry) => redactAuditDetails(entry, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : redactAuditDetails(entry, depth + 1)
    ])
  );
}
```

- [ ] **Step 6: Implement the insert-only audit service**

Create `src/lib/server/audit/service.ts`:

```ts
import type { Actor } from '$lib/server/auth/admin-policy';
import { auditEvents, type AuditEventRow, type JsonValue } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { redactAuditDetails } from './redact';

export interface AppendAuditEventInput {
  actor: Actor;
  action: string;
  outcome: 'succeeded' | 'failed' | 'denied';
  resourceType: string;
  resourceId?: string | null;
  correlationId: string;
  before?: JsonValue | null;
  after?: JsonValue | null;
}

export async function appendAuditEvent(
  database: DatabaseExecutor,
  input: AppendAuditEventInput
): Promise<AuditEventRow> {
  const [event] = await database
    .insert(auditEvents)
    .values({
      actorType: input.actor.type,
      actorId: input.actor.type === 'anonymous' ? null : input.actor.id,
      action: input.action,
      outcome: input.outcome,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      correlationId: input.correlationId,
      before: input.before == null ? null : redactAuditDetails(input.before),
      after: input.after == null ? null : redactAuditDetails(input.after)
    })
    .returning();

  if (!event) throw new Error('Audit event insert returned no row');
  return event;
}
```

- [ ] **Step 7: Prove append behavior, redaction, and database immutability**

Create `tests/integration/audit.test.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { appendAuditEvent } from '$lib/server/audit/service';
import { auditEvents } from '$lib/server/db/schema';
import { databaseClient } from './database';

describe('audit events', () => {
  it('appends redacted details and rejects update or delete', async () => {
    const event = await appendAuditEvent(databaseClient.db, {
      actor: { type: 'user', id: 'admin-1', roles: ['admin'] },
      action: 'catalog.title.create',
      outcome: 'succeeded',
      resourceType: 'title',
      resourceId: 'title-1',
      correlationId: 'request-1',
      after: { title: 'Safe', password: 'unsafe' }
    });

    expect(event.after).toEqual({ title: 'Safe', password: '[redacted]' });

    await expect(
      databaseClient.db
        .update(auditEvents)
        .set({ action: 'tampered' })
        .where(eq(auditEvents.id, event.id))
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: '55000',
        message: 'audit_events is append-only'
      })
    });

    await expect(
      databaseClient.db.execute(sql`delete from audit_events where id = ${event.id}`)
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: '55000',
        message: 'audit_events is append-only'
      })
    });
  });
});
```

- [ ] **Step 8: Run unit, integration, type, and lint gates**

Run:

```powershell
npx vitest run src/lib/server/auth/admin-policy.test.ts src/lib/server/audit/redact.test.ts
npm run test:integration
npm run check
npm run lint
```

Expected: authorization and redaction unit tests pass; PostgreSQL rejects both audit mutations with SQLSTATE `55000` while preserving the inserted row.

- [ ] **Step 9: Commit policy and audit foundations**

```powershell
git add src/lib/server/auth src/lib/server/audit tests/integration/audit.test.ts
git commit -m "feat: add admin policy and append-only audit"
```

## Task 7: Add transaction-safe catalog and revision skeleton services

**Files:**
- Create: `src/lib/server/catalog/input.ts`
- Create: `src/lib/server/catalog/input.test.ts`
- Create: `src/lib/server/catalog/service.ts`
- Create: `tests/integration/catalog.test.ts`

- [ ] **Step 1: Write failing catalog command validation tests**

Create `src/lib/server/catalog/input.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseCreateRevisionInput, parseCreateTitleInput } from './input';

describe('catalog inputs', () => {
  it('normalizes a private title command', () => {
    expect(
      parseCreateTitleInput({
        slug: '  vector-and-vine ',
        title: ' Vector & Vine ',
        subtitle: ' ',
        description: ' A comic. ',
        creatorName: ' Pale Orbit ',
        format: 'comic',
        priceMinor: 1299,
        currency: 'usd'
      })
    ).toEqual({
      slug: 'vector-and-vine',
      title: 'Vector & Vine',
      subtitle: null,
      description: 'A comic.',
      creatorName: 'Pale Orbit',
      format: 'comic',
      priceMinor: 1299,
      currency: 'USD'
    });
  });

  it.each([
    { slug: 'Not Valid', currency: 'USD', priceMinor: 100 },
    { slug: 'valid', currency: 'US', priceMinor: 100 },
    { slug: 'valid', currency: 'USD', priceMinor: -1 }
  ])('rejects invalid title money or slug fields', (invalid) => {
    expect(() =>
      parseCreateTitleInput({
        ...invalid,
        title: 'Title',
        description: 'Description',
        creatorName: 'Creator',
        format: 'prose'
      })
    ).toThrow();
  });

  it('validates revision identifiers and trims the change summary', () => {
    expect(
      parseCreateRevisionInput({
        titleId: '4dc17f45-f2ac-4ed1-89eb-c6285808f123',
        parentRevisionId: null,
        changeSummary: ' Initial upload '
      })
    ).toEqual({
      titleId: '4dc17f45-f2ac-4ed1-89eb-c6285808f123',
      parentRevisionId: null,
      changeSummary: 'Initial upload'
    });
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npx vitest run src/lib/server/catalog/input.test.ts
```

Expected: FAIL because the input module does not exist.

- [ ] **Step 3: Implement catalog command validation**

Create `src/lib/server/catalog/input.ts`:

```ts
import { z } from 'zod';

const optionalTrimmedText = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const createTitleInputSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().trim().min(1).max(300),
  subtitle: optionalTrimmedText,
  description: z.string().trim().min(1).max(20_000),
  creatorName: z.string().trim().min(1).max(300),
  format: z.enum(['prose', 'comic']),
  priceMinor: z.number().int().nonnegative().max(2_147_483_647),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)
});

const createRevisionInputSchema = z.object({
  titleId: z.uuid(),
  parentRevisionId: z.uuid().nullable().optional().transform((value) => value ?? null),
  changeSummary: z.string().trim().min(1).max(2_000)
});

export type CreateTitleInput = z.output<typeof createTitleInputSchema>;
export type CreateRevisionInput = z.output<typeof createRevisionInputSchema>;

export function parseCreateTitleInput(value: unknown): CreateTitleInput {
  return createTitleInputSchema.parse(value);
}

export function parseCreateRevisionInput(value: unknown): CreateRevisionInput {
  return createRevisionInputSchema.parse(value);
}
```

- [ ] **Step 4: Write failing integration tests for authorization, atomic audit, and revision ownership**

Create `tests/integration/catalog.test.ts`:

```ts
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import {
  CatalogDomainError,
  createPrivateTitle,
  createRevisionSkeleton
} from '$lib/server/catalog/service';
import { auditEvents, titleRevisions, titles } from '$lib/server/db/schema';
import { databaseClient } from './database';

const admin: Actor = { type: 'user', id: 'admin-1', roles: ['admin'] };
const customer: Actor = { type: 'user', id: 'customer-1', roles: ['customer'] };

const titleInput = {
  slug: 'the-glass-astronomer',
  title: 'The Glass Astronomer',
  subtitle: null,
  description: 'A private prose title.',
  creatorName: 'Pale Orbit',
  format: 'prose' as const,
  priceMinor: 1499,
  currency: 'USD'
};

describe('catalog foundation', () => {
  it('creates a private title and audit event atomically', async () => {
    const title = await createPrivateTitle(databaseClient.db, {
      actor: admin,
      correlationId: 'request-create-title',
      input: titleInput
    });

    expect(title.visibility).toBe('private');
    const [event] = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, title.id));
    expect(event).toMatchObject({
      action: 'catalog.title.create',
      actorId: 'admin-1',
      outcome: 'succeeded'
    });
  });

  it('rejects a customer before writing either table', async () => {
    await expect(
      createPrivateTitle(databaseClient.db, {
        actor: customer,
        correlationId: 'request-denied',
        input: titleInput
      })
    ).rejects.toMatchObject({ code: 'forbidden' });

    const [titleCount] = await databaseClient.db.select({ value: count() }).from(titles);
    const [auditCount] = await databaseClient.db.select({ value: count() }).from(auditEvents);
    expect(titleCount?.value).toBe(0);
    expect(auditCount?.value).toBe(0);
  });

  it('rolls back the audit insert when a duplicate slug fails', async () => {
    await createPrivateTitle(databaseClient.db, {
      actor: admin,
      correlationId: 'request-first',
      input: titleInput
    });

    await expect(
      createPrivateTitle(databaseClient.db, {
        actor: admin,
        correlationId: 'request-duplicate',
        input: titleInput
      })
    ).rejects.toThrow();

    const [auditCount] = await databaseClient.db.select({ value: count() }).from(auditEvents);
    expect(auditCount?.value).toBe(1);
  });

  it('requires a parent revision to belong to the same title', async () => {
    const firstTitle = await createPrivateTitle(databaseClient.db, {
      actor: admin,
      correlationId: 'request-first-title',
      input: titleInput
    });
    const secondTitle = await createPrivateTitle(databaseClient.db, {
      actor: admin,
      correlationId: 'request-second-title',
      input: { ...titleInput, slug: 'second-title', title: 'Second Title' }
    });
    const parent = await createRevisionSkeleton(databaseClient.db, {
      actor: admin,
      correlationId: 'request-parent',
      input: {
        titleId: firstTitle.id,
        parentRevisionId: null,
        changeSummary: 'First candidate'
      }
    });

    await expect(
      createRevisionSkeleton(databaseClient.db, {
        actor: admin,
        correlationId: 'request-invalid-parent',
        input: {
          titleId: secondTitle.id,
          parentRevisionId: parent.id,
          changeSummary: 'Invalid parent'
        }
      })
    ).rejects.toEqual(new CatalogDomainError('parent_revision_not_in_title'));

    const revisions = await databaseClient.db.select().from(titleRevisions);
    expect(revisions).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Run the catalog integration test to verify it fails**

Run:

```powershell
npm run test:integration
```

Expected: FAIL because `catalog/service.ts` does not exist. The wrapper still removes its isolated database project.

- [ ] **Step 6: Implement private-title and revision-skeleton transactions**

Create `src/lib/server/catalog/service.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import {
  requireCapability,
  type Actor
} from '$lib/server/auth/admin-policy';
import { appendAuditEvent } from '$lib/server/audit/service';
import {
  titleRevisions,
  titles,
  type TitleRevisionRow,
  type TitleRow
} from '$lib/server/db/schema';
import type { Database } from '$lib/server/db/client';
import { withTransaction } from '$lib/server/db/transaction';
import {
  parseCreateRevisionInput,
  parseCreateTitleInput,
  type CreateRevisionInput,
  type CreateTitleInput
} from './input';

export class CatalogDomainError extends Error {
  constructor(
    readonly code: 'title_not_found' | 'parent_revision_not_in_title'
  ) {
    super(code);
    this.name = 'CatalogDomainError';
  }
}

interface CatalogCommand<T> {
  actor: Actor;
  correlationId: string;
  input: T;
}

export async function createPrivateTitle(
  database: Database,
  command: CatalogCommand<CreateTitleInput>
): Promise<TitleRow> {
  const actor = command.actor;
  requireCapability(actor, 'catalog.manage');
  const input = parseCreateTitleInput(command.input);

  return withTransaction(database, async (transaction) => {
    const [title] = await transaction
      .insert(titles)
      .values({ ...input, visibility: 'private' })
      .returning();
    if (!title) throw new Error('Title insert returned no row');

    await appendAuditEvent(transaction, {
      actor,
      action: 'catalog.title.create',
      outcome: 'succeeded',
      resourceType: 'title',
      resourceId: title.id,
      correlationId: command.correlationId,
      after: {
        slug: title.slug,
        title: title.title,
        format: title.format,
        visibility: title.visibility,
        priceMinor: title.priceMinor,
        currency: title.currency
      }
    });

    return title;
  });
}

export async function createRevisionSkeleton(
  database: Database,
  command: CatalogCommand<CreateRevisionInput>
): Promise<TitleRevisionRow> {
  const actor = command.actor;
  requireCapability(actor, 'catalog.manage');
  const input = parseCreateRevisionInput(command.input);

  return withTransaction(database, async (transaction) => {
    const [title] = await transaction
      .select({ id: titles.id })
      .from(titles)
      .where(eq(titles.id, input.titleId))
      .limit(1);
    if (!title) throw new CatalogDomainError('title_not_found');

    if (input.parentRevisionId) {
      const [parent] = await transaction
        .select({ id: titleRevisions.id })
        .from(titleRevisions)
        .where(
          and(
            eq(titleRevisions.id, input.parentRevisionId),
            eq(titleRevisions.titleId, input.titleId)
          )
        )
        .limit(1);
      if (!parent) throw new CatalogDomainError('parent_revision_not_in_title');
    }

    const [revision] = await transaction
      .insert(titleRevisions)
      .values({
        titleId: input.titleId,
        parentRevisionId: input.parentRevisionId,
        state: 'uploaded',
        createdByActorId: actor.id,
        changeSummary: input.changeSummary
      })
      .returning();
    if (!revision) throw new Error('Revision insert returned no row');

    await appendAuditEvent(transaction, {
      actor,
      action: 'catalog.revision.create',
      outcome: 'succeeded',
      resourceType: 'title_revision',
      resourceId: revision.id,
      correlationId: command.correlationId,
      after: {
        titleId: revision.titleId,
        parentRevisionId: revision.parentRevisionId,
        state: revision.state,
        changeSummary: revision.changeSummary
      }
    });

    return revision;
  });
}
```

- [ ] **Step 7: Run catalog unit/integration and full static gates**

Run:

```powershell
npx vitest run src/lib/server/catalog/input.test.ts
npm run test:integration
npm run check
npm run lint
```

Expected: all four catalog integration cases pass; unauthorized and failed transactions leave no partial audit or revision rows.

- [ ] **Step 8: Commit the catalog/revision skeleton**

```powershell
git add src/lib/server/catalog tests/integration/catalog.test.ts
git commit -m "feat: add audited catalog domain skeleton"
```

## Task 8: Implement durable PostgreSQL job claiming and bounded retries

**Files:**
- Create: `src/lib/server/jobs/types.ts`
- Create: `src/lib/server/jobs/backoff.ts`
- Create: `src/lib/server/jobs/backoff.test.ts`
- Create: `src/lib/server/jobs/repository.ts`
- Create: `src/lib/server/jobs/runner.ts`
- Create: `src/lib/server/jobs/runner.test.ts`
- Create: `tests/integration/jobs.test.ts`

- [ ] **Step 1: Write failing retry policy tests**

Create `src/lib/server/jobs/backoff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeRetryDelayMs } from './backoff';

describe('computeRetryDelayMs', () => {
  it.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 10_000],
    [50, 10_000]
  ])('bounds attempt %i at %i milliseconds', (attempts, expected) => {
    expect(computeRetryDelayMs(attempts, 1000, 10_000)).toBe(expected);
  });
});
```

- [ ] **Step 2: Write failing worker-runner tests**

Create `src/lib/server/jobs/runner.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { PermanentJobError, runWorker } from './runner';
import type { JobRecord, JobRepository } from './types';

const job: JobRecord = {
  id: 'f1f46ee7-3170-40ea-bfad-d55a734bf37d',
  type: 'test.handle',
  payload: { value: 1 },
  attempts: 1,
  maxAttempts: 5,
  lockedBy: 'worker-test'
};

function repositoryReturning(record: JobRecord): JobRepository {
  return {
    claimNext: vi.fn().mockResolvedValueOnce(record).mockResolvedValue(null),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined)
  };
}

describe('runWorker', () => {
  it('completes a successfully handled job', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);
    const handler = vi.fn().mockResolvedValue(undefined);

    await runWorker({
      repository,
      handlers: new Map([['test.handle', handler]]),
      workerId: 'worker-test',
      pollIntervalMs: 1,
      signal: controller.signal,
      sleep: async () => controller.abort()
    });

    expect(handler).toHaveBeenCalledWith(job, controller.signal);
    expect(repository.complete).toHaveBeenCalledWith(job.id, 'worker-test');
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('marks a permanent handler error as non-retryable', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning(job);

    await runWorker({
      repository,
      handlers: new Map([
        ['test.handle', async () => {
          throw new PermanentJobError('Invalid job payload');
        }]
      ]),
      workerId: 'worker-test',
      pollIntervalMs: 1,
      signal: controller.signal,
      sleep: async () => controller.abort()
    });

    expect(repository.fail).toHaveBeenCalledWith(
      job.id,
      'worker-test',
      'Invalid job payload',
      false
    );
  });

  it('fails an unknown job type without exposing a thrown value', async () => {
    const controller = new AbortController();
    const repository = repositoryReturning({ ...job, type: 'unknown.type' });

    await runWorker({
      repository,
      handlers: new Map(),
      workerId: 'worker-test',
      pollIntervalMs: 1,
      signal: controller.signal,
      sleep: async () => controller.abort()
    });

    expect(repository.fail).toHaveBeenCalledWith(
      job.id,
      'worker-test',
      'No handler registered for unknown.type',
      false
    );
  });
});
```

- [ ] **Step 3: Run the job unit tests to verify they fail**

Run:

```powershell
npx vitest run src/lib/server/jobs/backoff.test.ts src/lib/server/jobs/runner.test.ts
```

Expected: FAIL because the job modules do not exist.

- [ ] **Step 4: Define job contracts and retry calculation**

Create `src/lib/server/jobs/types.ts`:

```ts
import type { JsonObject } from '$lib/server/db/schema';

export interface JobRecord {
  id: string;
  type: string;
  payload: JsonObject;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
}

export type JobHandler = (job: JobRecord, signal: AbortSignal) => Promise<void>;

export interface JobRepository {
  claimNext(workerId: string): Promise<JobRecord | null>;
  complete(jobId: string, workerId: string): Promise<void>;
  fail(
    jobId: string,
    workerId: string,
    safeError: string,
    retryable: boolean
  ): Promise<void>;
}
```

Create `src/lib/server/jobs/backoff.ts`:

```ts
export function computeRetryDelayMs(
  attempts: number,
  baseDelayMs: number,
  maximumDelayMs: number
): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 30);
  return Math.min(maximumDelayMs, baseDelayMs * 2 ** exponent);
}
```

- [ ] **Step 5: Implement enqueue, lease-based claim, completion, and retry/failure**

Create `src/lib/server/jobs/repository.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm';
import type { JobConfig } from '$lib/server/config/schema';
import type { Database } from '$lib/server/db/client';
import { jobs, type JsonObject, type JobRow } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { withTransaction } from '$lib/server/db/transaction';
import { computeRetryDelayMs } from './backoff';
import type { JobRecord, JobRepository } from './types';

export interface EnqueueJobInput {
  type: string;
  payload: JsonObject;
  deduplicationKey?: string | null;
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueueJob(
  database: DatabaseExecutor,
  input: EnqueueJobInput
): Promise<JobRow> {
  const [inserted] = await database
    .insert(jobs)
    .values({
      type: input.type,
      payload: input.payload,
      deduplicationKey: input.deduplicationKey ?? null,
      runAt: input.runAt,
      maxAttempts: input.maxAttempts ?? 5
    })
    .onConflictDoNothing({ target: jobs.deduplicationKey })
    .returning();

  if (inserted) return inserted;
  if (!input.deduplicationKey) throw new Error('Job insert returned no row');

  const [existing] = await database
    .select()
    .from(jobs)
    .where(eq(jobs.deduplicationKey, input.deduplicationKey))
    .limit(1);
  if (!existing) throw new Error('Deduplicated job could not be loaded');
  return existing;
}

interface ClaimedJobRow {
  id: string;
  type: string;
  payload: JsonObject;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
}

export function createPostgresJobRepository(
  database: Database,
  config: JobConfig,
  now: () => Date = () => new Date()
): JobRepository {
  return {
    async claimNext(workerId): Promise<JobRecord | null> {
      const claimedAt = now();
      const expiredBefore = new Date(claimedAt.getTime() - config.leaseMs);
      const result = await database.execute<ClaimedJobRow>(sql`
        with exhausted as (
          update jobs
          set status = 'failed',
              locked_at = null,
              locked_by = null,
              last_error = coalesce(last_error, 'Job lease expired after final attempt'),
              completed_at = ${claimedAt},
              updated_at = ${claimedAt}
          where status = 'running'
            and locked_at <= ${expiredBefore}
            and attempts >= max_attempts
          returning id
        ), candidate as (
          select id
          from jobs
          where (
              status = 'pending'
              and run_at <= ${claimedAt}
              and attempts < max_attempts
            ) or (
              status = 'running'
              and locked_at <= ${expiredBefore}
              and attempts < max_attempts
            )
          order by run_at asc, created_at asc
          for update skip locked
          limit 1
        )
        update jobs
        set status = 'running',
            attempts = jobs.attempts + 1,
            locked_at = ${claimedAt},
            locked_by = ${workerId},
            updated_at = ${claimedAt}
        from candidate
        where jobs.id = candidate.id
        returning jobs.id,
                  jobs.type,
                  jobs.payload,
                  jobs.attempts,
                  jobs.max_attempts as "maxAttempts",
                  jobs.locked_by as "lockedBy"
      `);
      return result.rows[0] ?? null;
    },

    async complete(jobId, workerId): Promise<void> {
      const completedAt = now();
      const [completed] = await database
        .update(jobs)
        .set({
          status: 'succeeded',
          completedAt,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          updatedAt: completedAt
        })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, 'running'),
            eq(jobs.lockedBy, workerId)
          )
        )
        .returning({ id: jobs.id });
      if (!completed) throw new Error('Job lease was lost before completion');
    },

    async fail(jobId, workerId, safeError, retryable): Promise<void> {
      await withTransaction(database, async (transaction) => {
        const [job] = await transaction
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.id, jobId),
              eq(jobs.status, 'running'),
              eq(jobs.lockedBy, workerId)
            )
          )
          .for('update')
          .limit(1);
        if (!job) throw new Error('Job lease was lost before failure handling');

        const failedAt = now();
        const exhausted = !retryable || job.attempts >= job.maxAttempts;
        const retryDelay = computeRetryDelayMs(
          job.attempts,
          config.retryBaseMs,
          config.retryMaxMs
        );

        await transaction
          .update(jobs)
          .set({
            status: exhausted ? 'failed' : 'pending',
            runAt: exhausted ? job.runAt : new Date(failedAt.getTime() + retryDelay),
            lockedAt: null,
            lockedBy: null,
            lastError: safeError.slice(0, 1000),
            completedAt: exhausted ? failedAt : null,
            updatedAt: failedAt
          })
          .where(eq(jobs.id, job.id));
      });
    }
  };
}
```

The lease predicate makes a job reclaimable after a worker crash. Each claim increments `attempts`; expired jobs therefore still converge on `failed` instead of running forever.

- [ ] **Step 6: Implement the abortable worker loop and safe errors**

Create `src/lib/server/jobs/runner.ts`:

```ts
import { setTimeout as delay } from 'node:timers/promises';
import type { JobHandler, JobRepository } from './types';

export class PermanentJobError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'PermanentJobError';
  }
}

interface RunWorkerOptions {
  repository: JobRepository;
  handlers: ReadonlyMap<string, JobHandler>;
  workerId: string;
  pollIntervalMs: number;
  signal: AbortSignal;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error: unknown) {
    if (!signal.aborted) throw error;
  }
}

export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;

  while (!options.signal.aborted) {
    const job = await options.repository.claimNext(options.workerId);
    if (!job) {
      await sleep(options.pollIntervalMs, options.signal);
      continue;
    }

    const handler = options.handlers.get(job.type);
    if (!handler) {
      await options.repository.fail(
        job.id,
        options.workerId,
        `No handler registered for ${job.type}`,
        false
      );
      continue;
    }

    try {
      await handler(job, options.signal);
      await options.repository.complete(job.id, options.workerId);
    } catch (error: unknown) {
      const permanent = error instanceof PermanentJobError;
      await options.repository.fail(
        job.id,
        options.workerId,
        permanent ? error.safeMessage : 'Transient job handler failure',
        !permanent
      );
    }
  }
}
```

Unexpected handler messages and stack traces are not persisted because they may contain secrets or third-party payloads. Structured diagnostics arrive in Plan 7.

- [ ] **Step 7: Write the concurrent claim and retry integration tests**

Create `tests/integration/jobs.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs } from '$lib/server/db/schema';
import { enqueueJob, createPostgresJobRepository } from '$lib/server/jobs/repository';
import { applicationConfig, databaseClient } from './database';

describe('PostgreSQL jobs', () => {
  it('deduplicates enqueue by key', async () => {
    const first = await enqueueJob(databaseClient.db, {
      type: 'test.one',
      payload: { value: 1 },
      deduplicationKey: 'same-key'
    });
    const second = await enqueueJob(databaseClient.db, {
      type: 'test.one',
      payload: { value: 2 },
      deduplicationKey: 'same-key'
    });
    expect(second.id).toBe(first.id);
  });

  it('uses skip locked so two workers claim different jobs', async () => {
    await enqueueJob(databaseClient.db, { type: 'test.one', payload: { order: 1 } });
    await enqueueJob(databaseClient.db, { type: 'test.two', payload: { order: 2 } });
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs
    );

    const [first, second] = await Promise.all([
      repository.claimNext('worker-a'),
      repository.claimNext('worker-b')
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
  });

  it('reschedules a retry and eventually marks an exhausted job failed', async () => {
    let currentTime = new Date('2026-08-08T12:00:00.000Z');
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => currentTime
    );
    const queued = await enqueueJob(databaseClient.db, {
      type: 'test.retry',
      payload: {},
      runAt: currentTime,
      maxAttempts: 2
    });

    const first = await repository.claimNext('worker-a');
    expect(first?.attempts).toBe(1);
    await repository.fail(queued.id, 'worker-a', 'safe transient failure', true);

    const [pending] = await databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id));
    expect(pending).toMatchObject({ status: 'pending', attempts: 1 });

    currentTime = new Date('2026-08-08T12:00:01.000Z');
    const second = await repository.claimNext('worker-b');
    expect(second?.attempts).toBe(2);
    await repository.fail(queued.id, 'worker-b', 'safe transient failure', true);

    const [failed] = await databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id));
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'safe transient failure'
    });
  });

  it('reclaims an expired lease and fails it after the final crashed attempt', async () => {
    let currentTime = new Date('2026-08-08T12:00:00.000Z');
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => currentTime
    );
    const queued = await enqueueJob(databaseClient.db, {
      type: 'test.crash',
      payload: {},
      runAt: currentTime,
      maxAttempts: 2
    });

    expect((await repository.claimNext('worker-a'))?.attempts).toBe(1);
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);
    expect((await repository.claimNext('worker-b'))?.attempts).toBe(2);
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);
    await expect(repository.claimNext('worker-c')).resolves.toBeNull();

    const [failed] = await databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id));
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'Job lease expired after final attempt'
    });
  });
});
```

- [ ] **Step 8: Run job unit, integration, check, and lint gates**

Run:

```powershell
npx vitest run src/lib/server/jobs/backoff.test.ts src/lib/server/jobs/runner.test.ts
npm run test:integration
npm run check
npm run lint
```

Expected: all job tests pass; concurrent claims return different UUIDs; the second failed attempt exhausts the two-attempt job.

- [ ] **Step 9: Commit durable jobs**

```powershell
git add src/lib/server/jobs tests/integration/jobs.test.ts
git commit -m "feat: add postgres job runner"
```

## Task 9: Add transactional outbox dispatch and production service bundles

**Files:**
- Create: `src/lib/server/outbox/repository.ts`
- Create: `src/lib/server/outbox/dispatcher.ts`
- Create: `tests/integration/outbox.test.ts`
- Create: `src/worker.ts`
- Create: `vite.services.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing transactional outbox tests**

Create `tests/integration/outbox.test.ts`:

```ts
import { count, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { jobs, outboxMessages } from '$lib/server/db/schema';
import { createOutboxDispatchHandler } from '$lib/server/outbox/dispatcher';
import { enqueueOutboxMessage } from '$lib/server/outbox/repository';
import { databaseClient } from './database';

describe('transactional outbox', () => {
  it('inserts the message and dispatch job in one transaction', async () => {
    const message = await databaseClient.db.transaction((transaction) =>
      enqueueOutboxMessage(transaction, {
        topic: 'test.email',
        payload: { recipient: 'reader@example.com' }
      })
    );

    const [jobCount] = await databaseClient.db.select({ value: count() }).from(jobs);
    expect(jobCount?.value).toBe(1);
    expect(message.dispatchJobId).toBeDefined();
  });

  it('rolls back both records with the caller transaction', async () => {
    await expect(
      databaseClient.db.transaction(async (transaction) => {
        await enqueueOutboxMessage(transaction, {
          topic: 'test.email',
          payload: { recipient: 'reader@example.com' }
        });
        throw new Error('rollback outbox');
      })
    ).rejects.toThrow('rollback outbox');

    const [messageCount] = await databaseClient.db
      .select({ value: count() })
      .from(outboxMessages);
    const [jobCount] = await databaseClient.db.select({ value: count() }).from(jobs);
    expect(messageCount?.value).toBe(0);
    expect(jobCount?.value).toBe(0);
  });

  it('dispatches once and treats an already-delivered message as idempotent', async () => {
    const message = await databaseClient.db.transaction((transaction) =>
      enqueueOutboxMessage(transaction, {
        topic: 'test.email',
        payload: { recipient: 'reader@example.com' }
      })
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const handler = createOutboxDispatchHandler(databaseClient.db, new Map([
      ['test.email', deliver]
    ]));
    const job = {
      id: message.dispatchJobId,
      type: 'outbox.dispatch',
      payload: { outboxId: message.id },
      attempts: 1,
      maxAttempts: 5,
      lockedBy: 'worker-test'
    };

    await handler(job, new AbortController().signal);
    await handler(job, new AbortController().signal);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [stored] = await databaseClient.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, message.id));
    expect(stored).toMatchObject({ status: 'delivered', lastError: null });
    expect(stored?.deliveredAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run the outbox integration test to verify it fails**

Run:

```powershell
npm run test:integration
```

Expected: FAIL because the outbox repository and dispatcher do not exist.

- [ ] **Step 3: Implement transaction-required outbox enqueue**

Create `src/lib/server/outbox/repository.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { outboxMessages, type JsonObject, type OutboxMessageRow } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { enqueueJob } from '$lib/server/jobs/repository';

export const OUTBOX_DISPATCH_JOB = 'outbox.dispatch';

export interface EnqueueOutboxMessageInput {
  topic: string;
  payload: JsonObject;
  maxAttempts?: number;
}

export async function enqueueOutboxMessage(
  transaction: DatabaseTransaction,
  input: EnqueueOutboxMessageInput
): Promise<OutboxMessageRow> {
  const outboxId = randomUUID();
  const job = await enqueueJob(transaction, {
    type: OUTBOX_DISPATCH_JOB,
    payload: { outboxId },
    deduplicationKey: `outbox:${outboxId}`,
    maxAttempts: input.maxAttempts ?? 5
  });

  const [message] = await transaction
    .insert(outboxMessages)
    .values({
      id: outboxId,
      topic: input.topic,
      payload: input.payload,
      dispatchJobId: job.id
    })
    .returning();
  if (!message) throw new Error('Outbox insert returned no row');
  return message;
}
```

Requiring `DatabaseTransaction` prevents callers from creating an outbox message without atomically creating the state change that requires it.

- [ ] **Step 4: Implement at-least-once topic dispatch with recorded-delivery replay suppression**

Create `src/lib/server/outbox/dispatcher.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import { outboxMessages, type JsonObject } from '$lib/server/db/schema';
import { PermanentJobError } from '$lib/server/jobs/runner';
import type { JobHandler } from '$lib/server/jobs/types';

export type OutboxTopicHandler = (
  payload: JsonObject,
  signal: AbortSignal
) => Promise<void>;

export function createOutboxDispatchHandler(
  database: Database,
  topicHandlers: ReadonlyMap<string, OutboxTopicHandler>
): JobHandler {
  return async (job, signal) => {
    const outboxId = job.payload.outboxId;
    if (typeof outboxId !== 'string') {
      throw new PermanentJobError('Outbox job is missing outboxId');
    }

    const [message] = await database
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, outboxId))
      .limit(1);
    if (!message) throw new PermanentJobError('Outbox message does not exist');
    if (message.status === 'delivered') return;

    const handler = topicHandlers.get(message.topic);
    if (!handler) {
      await database
        .update(outboxMessages)
        .set({
          status: 'failed',
          lastError: `No handler registered for ${message.topic}`,
          updatedAt: new Date()
        })
        .where(eq(outboxMessages.id, message.id));
      throw new PermanentJobError(`No handler registered for ${message.topic}`);
    }

    try {
      await handler(message.payload, signal);
    } catch (error: unknown) {
      const safeError =
        error instanceof PermanentJobError
          ? error.safeMessage
          : 'Transient outbox handler failure';
      await database
        .update(outboxMessages)
        .set({ status: 'failed', lastError: safeError, updatedAt: new Date() })
        .where(eq(outboxMessages.id, message.id));
      throw error;
    }

    const deliveredAt = new Date();
    await database
      .update(outboxMessages)
      .set({
        status: 'delivered',
        lastError: null,
        deliveredAt,
        updatedAt: deliveredAt
      })
      .where(eq(outboxMessages.id, message.id));
  };
}
```

Plan 3 registers the email topic handler. Plan 6 can register reconciliation topics without changing the durable job or outbox contracts. The dispatcher is intentionally at-least-once: if a process dies after a handler's external side effect but before `deliveredAt` commits, the lease retry can call the handler again. Topic handlers must therefore carry a stable provider idempotency key where the provider supports one, or otherwise tolerate duplicates; the `delivered` check suppresses ordinary replay only after the database records completion.

- [ ] **Step 5: Add the production worker entry point**

Create `src/worker.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { rm, writeFile } from 'node:fs/promises';
import { loadApplicationConfig } from '$lib/server/config/load';
import { createDatabaseClient } from '$lib/server/db/client';
import { probeDatabase } from '$lib/server/db/health';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { runWorker } from '$lib/server/jobs/runner';
import type { JobHandler } from '$lib/server/jobs/types';
import {
  createOutboxDispatchHandler,
  type OutboxTopicHandler
} from '$lib/server/outbox/dispatcher';
import { OUTBOX_DISPATCH_JOB } from '$lib/server/outbox/repository';

const config = loadApplicationConfig(process.env);
const databaseClient = createDatabaseClient(config.database);
const controller = new AbortController();
const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const topicHandlers = new Map<string, OutboxTopicHandler>();
const handlers = new Map<string, JobHandler>([
  [OUTBOX_DISPATCH_JOB, createOutboxDispatchHandler(databaseClient.db, topicHandlers)]
]);
const repository = createPostgresJobRepository(databaseClient.db, config.jobs);

function requestShutdown(): void {
  controller.abort();
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

try {
  await probeDatabase(databaseClient.pool, config.database.readinessTimeoutMs);
  await writeFile(config.jobs.workerReadyFile, workerId, { encoding: 'utf8' });
  console.info('[worker] ready', { workerId });
  await runWorker({
    repository,
    handlers,
    workerId,
    pollIntervalMs: config.jobs.pollIntervalMs,
    signal: controller.signal
  });
} catch (error: unknown) {
  console.error('[worker] stopped unexpectedly', {
    name: error instanceof Error ? error.name : 'UnknownError'
  });
  process.exitCode = 1;
} finally {
  await rm(config.jobs.workerReadyFile, { force: true });
  await databaseClient.close();
}
```

An empty topic registry is intentional until Plan 3 adds SMTP delivery. The worker still has a real polling loop and safely rejects unsupported persisted work.

- [ ] **Step 6: Bundle migration and worker entry points with Vite SSR**

Create `vite.services.config.ts`:

```ts
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  ssr: {
    external: true
  },
  build: {
    ssr: true,
    target: 'node26',
    outDir: 'build/services',
    emptyOutDir: true,
    copyPublicDir: false,
    sourcemap: true,
    rolldownOptions: {
      input: {
        migrate: resolve(import.meta.dirname, 'src/migrate.ts'),
        worker: resolve(import.meta.dirname, 'src/worker.ts')
      },
      output: {
        entryFileNames: '[name].js'
      }
    }
  }
});
```

Replace/add package scripts:

```json
"build:web": "vite build",
"build:services": "vite build --config vite.services.config.ts",
"build": "npm run build:web && npm run build:services",
"worker:dev": "node --env-file-if-exists=.env --import tsx src/worker.ts",
"worker:watch": "node --watch --env-file-if-exists=.env --import tsx src/worker.ts"
```

- [ ] **Step 7: Run outbox tests and verify both service bundles**

Run:

```powershell
npm run test:integration
npm run build
Test-Path build/services/migrate.js
Test-Path build/services/worker.js
npm run check
npm run lint
```

Expected: outbox rollback and idempotency tests pass; both `Test-Path` commands print `True`; the adapter-node web build remains intact under `build/`.

- [ ] **Step 8: Commit outbox and process entry points**

```powershell
git add src/lib/server/outbox src/worker.ts vite.services.config.ts tests/integration/outbox.test.ts package.json package-lock.json
git commit -m "feat: add transactional outbox and worker entry"
```

## Task 10: Ship migration and worker services in development and production Compose

**Files:**
- Modify: `Dockerfile`
- Modify: `compose.dev.yaml`
- Modify: `compose.prod.yaml`

- [ ] **Step 1: Include committed migrations in the runtime image**

Add this copy beside the existing runtime `build` copy in `Dockerfile`:

```dockerfile
COPY --from=build --chown=node:node /app/drizzle ./drizzle
```

The existing `COPY --from=build ... /app/build ./build` already includes `build/services/worker.js` and `build/services/migrate.js` after Task 9.

- [ ] **Step 2: Add required operational settings to the development services**

Keep the existing `app` service and add these overrides under its `environment` key:

```yaml
      DATABASE_HOST: postgres
      WORKER_READY_FILE: /tmp/worker-ready
```

Add the source-mounted worker service to `compose.dev.yaml`:

```yaml
  worker:
    build:
      context: .
      target: development
    init: true
    command: [npm, run, worker:watch]
    env_file:
      - ${DEV_ENV_FILE:-.env}
    environment:
      DATABASE_HOST: postgres
      WORKER_READY_FILE: /tmp/worker-ready
    volumes:
      - .:/app
      - app_node_modules:/app/node_modules
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=32m
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: [CMD, node, -e, "require('node:fs').statSync('/tmp/worker-ready').size > 0 || process.exit(1)"]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 15s
    stop_grace_period: 30s
```

Add the one-shot development migration service:

```yaml
  migrate:
    profiles: [tools]
    build:
      context: .
      target: development
    command: [npm, run, db:migrate:raw]
    env_file:
      - ${DEV_ENV_FILE:-.env}
    environment:
      DATABASE_HOST: postgres
      WORKER_READY_FILE: /tmp/worker-ready
    volumes:
      - .:/app
      - app_node_modules:/app/node_modules
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"
```

The worker has no host port. The migration profile runs only when explicitly requested.

- [ ] **Step 3: Add operational values to the production app environment**

Add these fixed, non-sensitive values to the existing `app.environment` in `compose.prod.yaml`:

```yaml
      DATABASE_POOL_MAX: "5"
      DATABASE_CONNECTION_TIMEOUT_MS: "5000"
      DATABASE_STATEMENT_TIMEOUT_MS: "30000"
      DATABASE_READINESS_TIMEOUT_MS: "2000"
      JOB_POLL_INTERVAL_MS: "1000"
      JOB_LEASE_MS: "30000"
      JOB_RETRY_BASE_MS: "1000"
      JOB_RETRY_MAX_MS: "300000"
      WORKER_READY_FILE: /tmp/worker-ready
```

The app does not write the worker file, but the complete validated configuration contract is shared by all processes.

- [ ] **Step 4: Add the immutable production worker**

Add to `compose.prod.yaml`:

```yaml
  worker:
    image: ${APP_IMAGE:?APP_IMAGE must be an immutable versioned image}
    init: true
    command: [node, build/services/worker.js]
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
      DATABASE_POOL_MAX: "5"
      DATABASE_CONNECTION_TIMEOUT_MS: "5000"
      DATABASE_STATEMENT_TIMEOUT_MS: "30000"
      DATABASE_READINESS_TIMEOUT_MS: "2000"
      JOB_POLL_INTERVAL_MS: "1000"
      JOB_LEASE_MS: "30000"
      JOB_RETRY_BASE_MS: "1000"
      JOB_RETRY_MAX_MS: "300000"
      WORKER_READY_FILE: /tmp/worker-ready
    secrets:
      - database_password
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=32m
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: [CMD, node, -e, "require('node:fs').statSync('/tmp/worker-ready').size > 0 || process.exit(1)"]
      interval: 10s
      timeout: 3s
      retries: 10
      start_period: 15s
    stop_grace_period: 30s
    deploy:
      resources:
        limits:
          cpus: ${WORKER_CPU_LIMIT:-0.75}
          memory: ${WORKER_MEMORY_LIMIT:-512M}
```

The worker uses the same process-backed Compose secret as web and PostgreSQL and runs as the image's unprivileged `node` user.

- [ ] **Step 5: Add the explicit production migration profile**

Add to `compose.prod.yaml`:

```yaml
  migrate:
    profiles: [tools]
    image: ${APP_IMAGE:?APP_IMAGE must be an immutable versioned image}
    command: [node, build/services/migrate.js]
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
      DATABASE_POOL_MAX: "1"
      DATABASE_CONNECTION_TIMEOUT_MS: "5000"
      DATABASE_STATEMENT_TIMEOUT_MS: "30000"
      DATABASE_READINESS_TIMEOUT_MS: "2000"
      JOB_POLL_INTERVAL_MS: "1000"
      JOB_LEASE_MS: "30000"
      JOB_RETRY_BASE_MS: "1000"
      JOB_RETRY_MAX_MS: "300000"
      WORKER_READY_FILE: /tmp/worker-ready
    secrets:
      - database_password
    depends_on:
      postgres:
        condition: service_healthy
    security_opt:
      - no-new-privileges:true
    restart: "no"
```

Do not add a dependency from web or worker to this profile. Deployment runs the migration command first and starts the long-running services only after it exits zero.

- [ ] **Step 6: Validate both Compose files without starting containers**

Run:

```powershell
$env:DEV_ENV_FILE = '.env.example'
$env:APP_IMAGE = 'pale-orbit:plan2'
$env:ORIGIN = 'http://127.0.0.1:18080'
$env:SITE_ADDRESS = ':80'
$env:DATABASE_NAME = 'pale_orbit'
$env:DATABASE_USER = 'pale_orbit'
$env:DATABASE_PASSWORD = 'compose-validation-only'

try {
  docker compose --env-file .env.example --file compose.dev.yaml config --quiet
  docker compose --file compose.prod.yaml config --quiet
  docker compose --file compose.prod.yaml --profile tools config --quiet
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

Expected: all three configurations validate. PostgreSQL, worker, and migration services publish no host ports in production.

- [ ] **Step 7: Smoke-test development migration, web readiness, and worker health**

Run this isolated project test:

```powershell
$env:DEV_ENV_FILE = '.env.example'
$project = 'pale-orbit-plan2-dev'
$compose = @('--project-name', $project, '--env-file', '.env.example', '--file', 'compose.dev.yaml')

try {
  docker compose @compose --profile tools run --rm migrate
  if ($LASTEXITCODE -ne 0) { throw 'Development migration failed' }

  docker compose @compose up --detach --build --wait --wait-timeout 180
  if ($LASTEXITCODE -ne 0) { throw 'Development stack failed to become healthy' }

  curl.exe --fail http://127.0.0.1:5173/health/ready
  docker compose @compose exec --no-TTY worker `
    node -e "require('node:fs').statSync('/tmp/worker-ready').size > 0 || process.exit(1)"
  docker compose @compose exec --no-TTY postgres `
    psql -U pale_orbit -d pale_orbit -tAc "select count(*) from drizzle.__drizzle_migrations"
  docker compose @compose ps
} finally {
  docker compose @compose down --volumes --remove-orphans
  Remove-Item Env:DEV_ENV_FILE -ErrorAction SilentlyContinue
}
```

Expected: the one-shot migration exits zero, app and worker become healthy, readiness returns `{"status":"ready"}`, and the Drizzle migration table contains applied rows. Cleanup removes only `pale-orbit-plan2-dev` resources.

- [ ] **Step 8: Build and inspect the final runtime image**

Run:

```powershell
docker build --tag pale-orbit:plan2 --target runtime .
docker run --rm --entrypoint node pale-orbit:plan2 -e `
  "const fs=require('node:fs'); for (const path of ['build/index.js','build/services/migrate.js','build/services/worker.js','drizzle/meta/_journal.json']) { fs.accessSync(path) }"
docker run --rm --entrypoint id pale-orbit:plan2 -u
```

Expected: the build succeeds, all four runtime paths exist, and the UID is `1000` rather than root.

- [ ] **Step 9: Smoke-test the production migration-first topology**

Run:

```powershell
$env:APP_IMAGE = 'pale-orbit:plan2'
$env:ORIGIN = 'http://127.0.0.1:18080'
$env:SITE_ADDRESS = ':80'
$env:HTTP_BIND_ADDRESS = '127.0.0.1'
$env:HTTP_PORT = '18080'
$env:HTTPS_BIND_ADDRESS = '127.0.0.1'
$env:HTTPS_PORT = '18443'
$env:DATABASE_NAME = 'pale_orbit'
$env:DATABASE_USER = 'pale_orbit'
$env:DATABASE_PASSWORD = 'plan2-production-smoke-only'
$project = 'pale-orbit-plan2-prod'
$compose = @('--project-name', $project, '--file', 'compose.prod.yaml')

try {
  docker compose @compose --profile tools run --rm migrate
  if ($LASTEXITCODE -ne 0) { throw 'Production migration failed' }

  docker compose @compose up --detach --wait --wait-timeout 180
  if ($LASTEXITCODE -ne 0) { throw 'Production stack failed to become healthy' }

  curl.exe --fail http://127.0.0.1:18080/health/live
  curl.exe --fail http://127.0.0.1:18080/health/ready
  $rootStatus = curl.exe --silent --output NUL --write-out '%{http_code}' `
    http://127.0.0.1:18080/
  if ($rootStatus -ne '503') { throw "Expected maintenance 503, got $rootStatus" }

  $workerUser = docker compose @compose exec --no-TTY worker id -u
  if ([int]$workerUser -eq 0) { throw 'Worker must not run as root' }
  docker compose @compose exec --no-TTY worker test -s /run/secrets/database_password
  docker compose @compose exec --no-TTY worker `
    node -e "require('node:fs').statSync('/tmp/worker-ready').size > 0 || process.exit(1)"

  $postgresContainerId = docker compose @compose ps --quiet postgres
  $postgresContainer = docker inspect $postgresContainerId | ConvertFrom-Json
  $publishedPostgresPorts = $postgresContainer[0].NetworkSettings.Ports.PSObject.Properties |
    Where-Object Value
  if ($publishedPostgresPorts) { throw 'PostgreSQL must not publish a host port' }

  docker compose @compose ps
} finally {
  docker compose @compose down --volumes --remove-orphans
  @(
    'APP_IMAGE', 'ORIGIN', 'SITE_ADDRESS', 'HTTP_BIND_ADDRESS', 'HTTP_PORT',
    'HTTPS_BIND_ADDRESS', 'HTTPS_PORT', 'DATABASE_NAME', 'DATABASE_USER',
    'DATABASE_PASSWORD'
  ) | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
}
```

Expected: migrations finish before startup; PostgreSQL, app, worker, and Caddy become healthy; readiness proves a real database query; the storefront remains 503; the worker is non-root and sees only the secret file; PostgreSQL remains private.

- [ ] **Step 10: Scan the image history for smoke secrets**

Run:

```powershell
$history = docker history --no-trunc pale-orbit:plan2
if ($history -match 'plan2-production-smoke-only|compose-validation-only') {
  throw 'A validation secret appeared in image history'
}
```

Expected: no match.

- [ ] **Step 11: Commit the worker/migration topology**

```powershell
git add Dockerfile compose.dev.yaml compose.prod.yaml
git commit -m "build: add migration and worker services"
```

## Task 11: Document database operations and run the complete Plan 2 gate

**Files:**
- Create: `docs/database-and-workers.md`
- Modify: `docs/runtime-environments.md`
- Modify: `README.md`
- Modify: `docs/dependency-decisions.md`

- [ ] **Step 1: Create the database and worker runbook**

Create `docs/database-and-workers.md`:

````markdown
# Database and workers

## Ownership

Drizzle schema files under `src/lib/server/db/schema/` are the database model source of truth. Generated SQL and snapshots under `drizzle/` are committed and reviewed. Never use `drizzle-kit push` against shared or production databases.

The web process, migration command, and worker each own a bounded node-postgres pool. The web process uses PostgreSQL for readiness. The worker claims durable jobs from PostgreSQL and dispatches transactional outbox messages. Redis is not part of the current topology.

## Local schema changes

Start from an up-to-date branch and a developer-owned ignored `.env`:

```powershell
Copy-Item .env.example .env
npm ci
```

Edit the TypeScript schema, then generate and review SQL:

```powershell
npm run db:generate -- --name=add_title_language
npm run db:check
git diff -- drizzle src/lib/server/db/schema
```

If Drizzle generated unexpected destructive SQL, fix the TypeScript schema and regenerate before applying it. Do not edit generated schema SQL to hide a mismatch. Custom database objects such as the append-only audit trigger use a named `drizzle-kit generate --custom` migration.

## Host-run development

Start PostgreSQL and Mailpit, apply migrations, then run web and worker in separate terminals:

```powershell
docker compose --env-file .env --file compose.dev.yaml up postgres mailpit --detach --wait
npm run db:migrate
npm run dev
```

```powershell
npm run worker:watch
```

Stop service containers without deleting PostgreSQL data:

```powershell
docker compose --env-file .env --file compose.dev.yaml down
```

## Fully containerized development

Run the explicit migration profile before long-running services:

```powershell
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

The web service is at `http://localhost:5173`; Mailpit is at `http://localhost:8025`. The worker has no published port. Its Compose health check requires a non-empty `/tmp/worker-ready` file written only after the initial database probe succeeds.

## Tests

Unit tests do not require Docker:

```powershell
npm run test:unit
```

Integration and Playwright commands start a uniquely named PostgreSQL 18.4 Compose project, ask Docker for a random loopback port, apply committed migrations, run the requested tests, and remove the test containers, network, and tmpfs data:

```powershell
npm run test:integration
npm run test:e2e
npm run test:database
```

`npm run verify` uses one disposable database for the serialized integration and browser suites.

## Production deployment order

Production configuration comes from the invoking process environment; no production `.env` file is used. With the new immutable `APP_IMAGE` available, run:

```powershell
docker compose --file compose.prod.yaml --profile tools run --rm migrate
docker compose --file compose.prod.yaml up --detach --wait
```

Do not start the new web or worker containers if migration exits nonzero. Re-running the same committed migration set is safe because Drizzle records applied migrations in `drizzle.__drizzle_migrations`.

Check the deployment:

```powershell
docker compose --file compose.prod.yaml ps
docker compose --file compose.prod.yaml logs --tail 100 app worker postgres caddy
```

`/health/live` proves only the web process responds. `/health/ready` performs a bounded PostgreSQL query. Worker health proves the worker completed its initial database probe and entered the polling loop. Production storefront and API paths remain in maintenance mode until later plans replace prototype identity and commerce seams.

## Job behavior

Workers claim one job at a time with `FOR UPDATE SKIP LOCKED`. A lease timestamp makes work recoverable after a process crash. Each claim increments attempts. Transient failures return to `pending` with bounded exponential delay; permanent or exhausted work moves to `failed` for the future admin operations view.

Handlers persist only deliberately safe error text. The outbox pairs a message and dispatch job in the caller's transaction and delivers at least once. A message already recorded as delivered is not sent again on ordinary job replay, while topic handlers remain responsible for the crash window between an external side effect and the `deliveredAt` update.

## Scope of later plans

- Plan 3 registers transactional email outbox topics, integrates Better Auth, and maps sessions/roles to the actor policy.
- Plan 4 adds storage/ingestion jobs and revision lifecycle transitions.
- Plan 6 adds Stripe reconciliation job topics.
- Plan 7 adds failed-job administration, structured logging, queue-age monitoring, backup/restore, and final pool/capacity tuning.
````

- [ ] **Step 2: Update the runtime topology and readiness contract**

In `docs/runtime-environments.md`:

- Add the worker to both development and production service lists.
- State that migrations run through the explicit `tools` profile before app/worker startup.
- Replace the Plan 1 readiness sentence with: `` `/health/ready` performs a bounded `select 1` through the web process's PostgreSQL pool. ``
- Replace the Plan 2 ownership bullet with: `Plan 2 supplies the database adapter, committed migrations, worker, durable jobs/outbox, append-only audit events, and database readiness.`
- Preserve the documented process-backed secret and read-only-rootfs deferral.

- [ ] **Step 3: Update the README development entry point**

Replace the development command block with:

```powershell
Copy-Item .env.example .env
npm ci
npm run test:e2e:install
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

Update the following paragraph to mention that the worker runs without a published port and link both runbooks:

```markdown
The storefront runs at `http://localhost:5173`; Mailpit runs at `http://localhost:8025`; the PostgreSQL-backed worker is private to Compose. See [runtime environments](docs/runtime-environments.md) and [database and workers](docs/database-and-workers.md) for host-run development, migrations, process secrets, health checks, tests, and cleanup commands.
```

Add `npm run test:integration` to the quality-gate block.

- [ ] **Step 4: Run a clean install and the complete application gate**

Ensure no earlier dev server owns port 4173, then run:

```powershell
npm ci
npm run verify
npm run db:check
npm ls --depth=0
npm audit --audit-level=high
```

Expected:

- Svelte/TypeScript checking reports zero errors and warnings.
- ESLint passes.
- All unit tests pass.
- Disposable PostgreSQL starts, committed migrations apply, and all integration tests pass serially.
- Both Playwright files pass in Chromium against database-backed readiness.
- Adapter-node, worker, and migration bundles build.
- The dependency tree is valid.
- The high-threshold audit exits zero; every remaining low/moderate path is explicitly documented, development-only where stated, and has a removal condition.

- [ ] **Step 5: Re-run Compose and image gates**

Run:

```powershell
$env:DEV_ENV_FILE = '.env.example'
$env:APP_IMAGE = 'pale-orbit:plan2'
$env:ORIGIN = 'https://books.example.com'
$env:SITE_ADDRESS = 'books.example.com'
$env:DATABASE_NAME = 'pale_orbit'
$env:DATABASE_USER = 'pale_orbit'
$env:DATABASE_PASSWORD = 'compose-final-validation-only'

try {
  docker compose --env-file .env.example --file compose.dev.yaml config --quiet
  docker compose --file compose.prod.yaml config --quiet
  docker compose --file compose.prod.yaml --profile tools config --quiet

  $caddyFile = (Resolve-Path 'deploy/Caddyfile').Path
  docker run --rm `
    --mount "type=bind,source=$caddyFile,target=/etc/caddy/Caddyfile,readonly" `
    --env SITE_ADDRESS=books.example.com `
    caddy:2.11.4-alpine caddy validate --config /etc/caddy/Caddyfile
} finally {
  @(
    'DEV_ENV_FILE', 'APP_IMAGE', 'ORIGIN', 'SITE_ADDRESS', 'DATABASE_NAME',
    'DATABASE_USER', 'DATABASE_PASSWORD'
  ) | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
}

docker build --tag pale-orbit:plan2 --target runtime .
```

Expected: both Compose topologies and the tools profile validate, Caddy validates for a real hostname, and the final runtime image builds from the clean lockfile.

- [ ] **Step 6: Inspect currency, scope, and repository hygiene**

Run:

```powershell
npm outdated --json
rg -n "better-auth|nodemailer|@aws-sdk|redis|bullmq" package.json package-lock.json src
git diff --check
git status --short
git log --oneline --decorate -12
```

Expected:

- Only the documented TypeScript 7 difference remains in `npm outdated`.
- The scope scan returns no Better Auth, SMTP, S3 SDK, Redis, or BullMQ dependency/import.
- No generated reports, `.env`, worker-ready file, or database data is tracked.
- Commits are separated by dependencies/configuration, test database, schema/migrations, readiness, audit/policy, catalog, jobs, outbox/worker, Compose, and documentation.

- [ ] **Step 7: Commit documentation and final verification state**

```powershell
git add README.md docs/database-and-workers.md docs/runtime-environments.md docs/dependency-decisions.md
git commit -m "docs: document database and worker operations"
git status --short
```

Expected: final status is clean.

## Plan 2 completion contract

Plan 2 is complete only when all of the following are true:

- [ ] Current stable Drizzle/node-postgres/tsx versions are locked and documented; `npm ls` is valid and no unexplained high/critical advisory exists.
- [ ] Unit tests stay Docker-free; integration and Playwright database tests use a disposable PostgreSQL 18.4 Compose project with guaranteed cleanup.
- [ ] Drizzle schema defines constrained title, immutable revision, job, outbox, and audit tables with UUID keys and UTC timestamps.
- [ ] Generated SQL/snapshots and the custom append-only audit migration are committed, reviewed, repeatable, and pass `drizzle-kit check`.
- [ ] Migration is an explicit one-shot command and production Compose profile; web and worker never auto-migrate.
- [ ] Web readiness performs a bounded real PostgreSQL query and returns a non-sensitive 503 when unavailable; liveness remains dependency-free.
- [ ] Transactions roll back atomically, and private title/revision skeleton operations append redacted audit events in the same transaction.
- [ ] Admin capability policy denies anonymous, guest, customer, and system actors; Plan 3 can map authenticated sessions into it without changing domain services.
- [ ] Audit events can be inserted but PostgreSQL rejects update and delete operations.
- [ ] Jobs deduplicate when requested, claim concurrently with `SKIP LOCKED`, recover expired leases, retry with bounded exponential delay, and finish in `failed` when permanent or exhausted.
- [ ] Outbox insertion requires a transaction, creates its dispatch job atomically, records safe failures, and treats delivered-message replay as idempotent.
- [ ] The worker and migration entry points are TypeScript-built into the same immutable non-root image as the web service.
- [ ] Development and production Compose start a private worker with health checks; production retains process-backed database secrets, private PostgreSQL, Caddy-only public ports, and maintenance mode.
- [ ] `npm run verify`, migration checks, Compose validation, Caddy validation, image build, development smoke, and production smoke all pass.
- [ ] Better Auth, SMTP, storage/ingestion, Stripe persistence, Redis, and admin UI remain outside this plan.

## Plan 3 handoff

Plan 3 may begin after this contract passes and the branch is reviewed. It should generate Better Auth's PostgreSQL schema through the approved Drizzle integration, add application role persistence, map sessions into the Plan 2 actor policy, register email outbox topics behind a provider-neutral SMTP adapter, provide first-admin CLI tooling, and add protected dashboard routes. It must reuse the migration, transaction, job, outbox, audit, configuration, test-database, service-bundle, and Compose conventions established here.

## Authoritative references

- [Drizzle PostgreSQL with node-postgres](https://orm.drizzle.team/docs/get-started/postgresql-new)
- [Drizzle migration approaches](https://orm.drizzle.team/docs/migrations)
- [Drizzle Kit configuration](https://orm.drizzle.team/docs/drizzle-config-file)
- [Drizzle Kit generate](https://orm.drizzle.team/docs/drizzle-kit-generate)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
- [node-postgres pool API](https://node-postgres.com/apis/pool)
- [PostgreSQL 18 `SELECT` locking clauses](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [Vite SSR build option](https://vite.dev/config/build-options.html#build-ssr)
- [Docker Compose profiles](https://docs.docker.com/compose/how-tos/profiles/)
