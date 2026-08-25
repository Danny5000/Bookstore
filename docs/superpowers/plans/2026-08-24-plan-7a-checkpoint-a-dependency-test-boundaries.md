# Plan 7A Checkpoint A: Dependency and Test Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Plan 7A Checkpoint A by extracting financial projection authority into one dependency leaf, relocating the generic PostgreSQL application rate-limit service behind a shared security boundary, and removing the Docker/PostgreSQL restore witness from the hermetic unit/watch profile without changing domain behavior, database schema, or production closure.

**Architecture:** Financial consumers depend directly on a leaf `projection-authority` module rather than reaching through the replay orchestrator. Commerce callers retain their existing error contract through a narrow adapter over a commerce-independent shared rate-limit core. Vitest gains an explicit serial service profile whose sole test invokes the existing bounded restore witness; default unit and watch profiles remain service-free while the release gate still requires the witness.

**Tech Stack:** Node.js 26.7.x, npm 11.19.x, SvelteKit 2.70.x, Svelte 5.56.x, TypeScript 6.0.x, PostgreSQL 18.4, Drizzle ORM 0.45.2, Vitest 4.1.x, Docker Compose, and ESLint 10.x.

---

## Source of truth, approved base, and checkpoint boundary

The authoritative design is `docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md`, especially Sections 5.1, 6, 10.3, 11, 15, and 16.1. The approved implementation base is commit `1c330693b67a1aa34c413bd8d2ec23ff8628236e` on `main`; it includes the approved Plan 7A design and ends at migration `0014`.

Before implementation, create or reuse an isolated worktree from that approved commit. If `main` has advanced, record the ancestry and prove the approved design remains present before rebasing this plan. Do not silently reinterpret Checkpoint A from a newer spec.

Checkpoint A owns exactly:

1. the financial projection-authority dependency leaf;
2. the shared application rate-limit core and temporary commerce adapter;
3. the hermetic/unit/watch versus service-backed Vitest split; and
4. the small Windows line-ending normalization required for the source-shape tests to be portable.

Checkpoint A does **not** add Plan 7A structured logging, correlation context, worker heartbeats, job definitions, administrator operations, migration `0015`, release-candidate evidence, production-live activation, new rate-limit namespaces, new protected routes, or any schema/configuration value change. Those remain Checkpoints B-D or later Plan 7 work. Production remains maintenance-only and Stripe-disabled.

## Target dependency and test topology

```text
financial replay/orchestrators ─────────────┐
financial ledger/sources/repositories ──────┼──> financial/projection-authority
refund-review services ─────────────────────┘       ├── db transaction type
                                                    ├── Drizzle SQL
                                                    └── financial safe error

quote/orders/claims ──> commerce/rate-limit adapter ──> security/rate-limit core
                              │                              ├── crypto
                              └── commerce error             ├── schema + SQL
                                                             └── db executor type

npm test / test:unit / test:watch ──> hermetic Vitest config
npm run test:service ───────────────> one serial bounded restore witness
npm run verify ─────────────────────> unit -> service -> integration/E2E -> build
```

Forbidden reverse edges are `projection-authority -> rebase|ledger|sources|routes|worker`, `security/rate-limit -> commerce/*`, and any default unit/watch path that can invoke the real restore witness.

## Execution and evidence discipline

- Work in task order. Use RED -> smallest implementation -> focused GREEN -> self-review -> literal-path commit for each change.
- Tasks 2-4 form one projection RED/GREEN commit, Tasks 5-7 form one rate-limit RED/GREEN commit, and Tasks 8-11 form one test-profile RED/GREEN commit. A numbered task without a commit step is an intermediate phase, not permission to commit a missing-module or duplicate-owner tree.
- Run hermetic tests freely. Serialize every Docker, PostgreSQL, Mailpit, Playwright, restore, and broad `verify` command; no parallel agent may start a service-backed command.
- Before every service-backed command, snapshot existing Compose-labeled containers, networks, volumes, and `pale-orbit-test-storage-*` directories. After the command, prove the exact harness-owned project and temporary root are absent and the baseline is otherwise unchanged. Never remove an unknown or pre-existing resource.
- Do not weaken the bounded restore supervisor, process-tree termination checks, Compose label/config-path ownership checks, or temporary-root confinement while moving it.
- Do not run a broad suite to diagnose a focused RED. Capture the first failing assertion, fix the demonstrated cause, and rerun the same bounded command.
- Use `apply_patch` for hand edits. Do not run Drizzle Kit because Checkpoint A creates no migration or schema snapshot.
- Preserve user changes in a dirty worktree. Stage literal paths, run `git diff --cached --check`, inspect the staged diff, and commit at each task boundary. Never use `git add .`.
- Do not add compatibility re-exports from `rebase.ts` and do not move existing commerce callers directly to the shared rate-limit core in this checkpoint.

Use this exact fail-closed, read-only wrapper in the same PowerShell session for every service-backed command. It validates every Docker read, preserves the target command's exit status, always takes the post-command snapshot, compares all Compose-labeled resources plus the harness storage-root namespace, and never deletes anything:

```powershell
function Get-CheckpointAServiceBaseline {
  $containers = @(
    docker ps --all --filter label=com.docker.compose.project `
      --format '{{.ID}}|{{.Names}}|{{.Label "com.docker.compose.project"}}'
  )
  if ($LASTEXITCODE -ne 0) { throw "docker ps failed with exit $LASTEXITCODE" }
  $networks = @(
    docker network ls --filter label=com.docker.compose.project `
      --format '{{.ID}}|{{.Name}}|{{.Label "com.docker.compose.project"}}'
  )
  if ($LASTEXITCODE -ne 0) { throw "docker network ls failed with exit $LASTEXITCODE" }
  $volumes = @(
    docker volume ls --filter label=com.docker.compose.project `
      --format '{{.Name}}|{{.Label "com.docker.compose.project"}}'
  )
  if ($LASTEXITCODE -ne 0) { throw "docker volume ls failed with exit $LASTEXITCODE" }

  [pscustomobject]@{
    Containers = @($containers | Sort-Object)
    Networks = @($networks | Sort-Object)
    Volumes = @($volumes | Sort-Object)
    StorageRoots = @(
      Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory `
        -Filter 'pale-orbit-test-storage-*' -ErrorAction Stop |
        Select-Object -ExpandProperty FullName |
        Sort-Object
    )
  }
}

function Invoke-CheckpointAServiceCommand {
  param(
    [Parameter(Mandatory)]
    [scriptblock]$Command
  )

  $before = Get-CheckpointAServiceBaseline | ConvertTo-Json -Compress -Depth 4
  $commandFailure = $null
  $commandExit = 0
  try {
    & $Command
    $commandExit = $LASTEXITCODE
  } catch {
    $commandFailure = $_
    $commandExit = 1
  }

  $after = $null
  $baselineFailure = $null
  try {
    $after = Get-CheckpointAServiceBaseline | ConvertTo-Json -Compress -Depth 4
  } catch {
    $baselineFailure = $_
  }

  $failures = @()
  if ($commandFailure) {
    $failures += "command threw: $($commandFailure.Exception.Message)"
  }
  if ($commandExit -ne 0) {
    $failures += "command exited with $commandExit"
  }
  if ($baselineFailure) {
    $failures += "post-command baseline failed: $($baselineFailure.Exception.Message)"
  } elseif (-not [string]::Equals($before, $after, [StringComparison]::Ordinal)) {
    $failures += 'command changed the disposable-resource baseline'
  }
  if ($failures.Count -gt 0) {
    throw "Checkpoint A service wrapper failed: $($failures -join '; ')"
  }
}
```

Invoke exactly one native command per wrapper, for example `Invoke-CheckpointAServiceCommand { npm run test:service -- --reporter=verbose }`. If the wrapper fails, inspect exact new labels/paths and let the owning harness clean only what it can prove it owns. Do not turn the wrapper into a cleanup command and do not run a second service command until the discrepancy is resolved.

## File ownership map

### Financial authority

- `src/lib/server/commerce/financial/projection-authority.ts` is the sole production owner of `FinancialProjectionAuthority`, its canonical row parser, the read query, the `FOR UPDATE` query, and the replay-enrollment advisory lock.
- `src/lib/server/commerce/financial/rebase.ts` remains the replay/correction orchestrator and imports the leaf. Replay-local helpers still used elsewhere in that file remain local.
- `scripts/financial-projection-authority-boundary.test.ts` proves unique ownership, exact leaf dependencies, direct consumer imports, mock paths, and removal of the three reciprocal replay edges.
- `src/lib/server/commerce/financial/projection-authority.test.ts` characterizes parsing, SQL, transaction reuse, and errors through the four public exports.

### Rate limiting

- `src/lib/server/security/rate-limit.ts` owns scope hashing, validation, fixed-window calculation, cleanup, SQL consumption, and the dedicated shared invalid-input error.
- `src/lib/server/commerce/rate-limit.ts` is a compatibility adapter that maps only the shared invalid-input error to `PermanentCommerceError`.
- Existing quote, checkout, orders, and claims production callers continue importing the commerce adapter.
- `tests/integration/commerce-rate-limit.test.ts` imports the shared core directly so PostgreSQL behavior is witnessed at its new owner.

### Test profiles

- `vitest.config.ts` owns hermetic `src` and `scripts` tests and explicitly excludes service tests.
- `vitest.service.config.ts` owns exactly `tests/service/financial-restore-witness.test.ts` and executes serially.
- `scripts/financial-restore-witness-harness.ts` owns the mechanically extracted bounded supervisor and cleanup machinery.
- `scripts/commerce-operations.test.ts` retains all hermetic source-shape, confinement, ownership, timeout, and process-termination tests; it no longer invokes PostgreSQL.
- `scripts/test-profile-boundaries.test.ts` proves discovery and package-script boundaries without starting Docker.
- `README.md` and `docs/database-and-workers.md` describe the new explicit service command and final gate order.

## Non-negotiable preserved behavior

- No migration, table, column, index, role, grant, configuration key/value, namespace, route, retry, or timeout change.
- Projection queries retain their exact selected columns and predicates. The lock query alone ends in `FOR UPDATE`; enrollment retains `pg_advisory_xact_lock(hashtextextended('pale-orbit:financial:replay-enrollment', 0))`.
- Projection parsing retains positive signed-int32 bounds, all-or-none pending fields, canonical replay ID and lowercase UUID rules, monotonic pending versions, the same tolerated extra row properties, and `PermanentFinancialError('source_linkage_mismatch')` for every invalid row shape.
- Existing projection authority -> enrollment -> domain-lock ordering and caller-owned transaction objects remain unchanged.
- Rate limiting retains authenticated SHA-256 scope, anonymous HMAC-SHA-256 over the trimmed IP, exact namespace/digest validation, fixed windows, cleanup-before-consumption, cleanup limits `100`/`500`/`1000`, the same upsert target, `least(count + 1, maxAttempts + 1)`, retry-after bounds, and route-visible commerce behavior.
- Database and unknown failures from the shared rate-limit core propagate unchanged through the commerce adapter.
- `npm test`, `npm run test:unit`, and `npm run test:watch` start no Docker, PostgreSQL, browser, network service, or long-running restore subprocess. `npm run verify` still requires the moved service witness.

## Milestone A — establish the portable handoff

### Task 1: Verify the approved base and normalize source-shape line endings

**Files:**

- Modify: `scripts/process-secret-scope.test.ts`
- Modify: `scripts/financial-schema-preservation.test.ts`

- [ ] **Step 1: Confirm the exact worktree and approved design**

```powershell
git status --short --branch
git rev-parse HEAD
git merge-base --is-ancestor 1c330693b67a1aa34c413bd8d2ec23ff8628236e HEAD
if ($LASTEXITCODE -ne 0) { throw 'Approved Plan 7A base is not an ancestor of HEAD.' }
if (-not (Select-String `
  -Path docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md `
  -Pattern '^\*\*Design status:\*\* Approved$' `
  -Quiet)) {
  throw 'Plan 7A design is not approved.'
}
git diff --check
```

Expected: a clean feature worktree, the ancestry command exits zero, the approved status is present, and the diff check is clean.

- [ ] **Step 2: Reproduce the Windows-only source-shape failure before editing**

```powershell
git config --show-origin --get core.autocrlf
npx vitest run scripts/process-secret-scope.test.ts scripts/financial-schema-preservation.test.ts --reporter=verbose
```

Expected on the approved Windows worktree with `core.autocrlf=true`: 5 failures and 32 passes. The failures are trailing-CR or multiline-fragment mismatches only; there is no application, schema, or migration failure. If the checkout already uses LF, record that this RED was reproduced on the approved Windows planning worktree and continue with the same minimal normalization; do not manufacture a product failure or change repository-wide line-ending policy.

- [ ] **Step 3: Normalize only the two source readers**

Change `scripts/process-secret-scope.test.ts` to:

```ts
const source = (path: string) =>
  readFileSync(resolve(path), 'utf8').replace(/\r\n?/gu, '\n');
```

Change `scripts/financial-schema-preservation.test.ts` to:

```ts
function source(relativePath: string): string {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return existsSync(path)
    ? readFileSync(path, 'utf8').replace(/\r\n?/gu, '\n')
    : '';
}
```

Do not edit source contract literals, production files, migrations, `.gitattributes`, or Git configuration. This matches the established reader pattern in `scripts/database-role-deployment.test.ts`.

- [ ] **Step 4: Run the focused GREEN and static checks**

```powershell
npx vitest run scripts/process-secret-scope.test.ts scripts/financial-schema-preservation.test.ts --reporter=verbose
npx eslint scripts/process-secret-scope.test.ts scripts/financial-schema-preservation.test.ts
git diff --check
```

Expected: 37/37 focused tests pass; lint and diff checks exit zero.

- [ ] **Step 5: Review and commit the portability repair**

```powershell
git diff -- scripts/process-secret-scope.test.ts scripts/financial-schema-preservation.test.ts
git add scripts/process-secret-scope.test.ts scripts/financial-schema-preservation.test.ts
git diff --cached --check
git diff --cached
git commit -m "test: normalize source-shape line endings"
```

## Milestone B — extract projection authority

### Task 2: Write the financial dependency-boundary RED

**Files:**

- Create: `scripts/financial-projection-authority-boundary.test.ts`

- [ ] **Step 1: Add the complete AST-backed boundary test**

Create `scripts/financial-projection-authority-boundary.test.ts` with this complete implementation. It resolves from `import.meta.url`, tolerates the intentionally missing leaf during RED, normalizes Windows paths/line endings, excludes tests from production ownership, distinguishes declarations from imported bindings, and inspects static imports, import types, `vi.mock`, and re-exports:

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const financialRoot = 'src/lib/server/commerce/financial';
const leafPath = `${financialRoot}/projection-authority.ts`;
const rebasePath = `${financialRoot}/rebase.ts`;

const publicAuthorityExports = [
  'FinancialProjectionAuthority',
  'loadFinancialProjectionAuthority',
  'lockFinancialProjectionAuthority',
  'lockFinancialProjectionEnrollment'
] as const;
const ownedAuthorityDeclarations = [
  ...publicAuthorityExports,
  'canonicalFinancialProjectionAuthority'
] as const;
const leafDependencies = [
  '$lib/server/db/transaction',
  './errors',
  'drizzle-orm'
] as const;
const consumers = new Map<string, string>([
  [`${financialRoot}/rebase.ts`, './projection-authority'],
  [`${financialRoot}/ledger.ts`, './projection-authority'],
  [`${financialRoot}/sources/refund.ts`, '../projection-authority'],
  [`${financialRoot}/sources/dispute.ts`, '../projection-authority'],
  [`${financialRoot}/payouts/repository.ts`, '../projection-authority'],
  [`${financialRoot}/scans/repository.ts`, '../projection-authority'],
  [
    `${financialRoot}/refund-review/corrections.ts`,
    '$lib/server/commerce/financial/projection-authority'
  ],
  [
    `${financialRoot}/refund-review/finalize.ts`,
    '$lib/server/commerce/financial/projection-authority'
  ]
]);
const mockConsumers = new Map<string, string>([
  [`${financialRoot}/sources/refund.test.ts`, '../projection-authority'],
  [`${financialRoot}/sources/dispute.test.ts`, '../projection-authority'],
  [
    `${financialRoot}/refund-review/corrections.test.ts`,
    '$lib/server/commerce/financial/projection-authority'
  ],
  [
    `${financialRoot}/refund-review/finalize.test.ts`,
    '$lib/server/commerce/financial/projection-authority'
  ]
]);

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function source(relativePath: string): string {
  const absolute = resolve(repositoryRoot, relativePath);
  return existsSync(absolute)
    ? readFileSync(absolute, 'utf8').replace(/\r\n?/gu, '\n')
    : '';
}

function syntax(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    source(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function productionFiles(relativeRoot: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(normalizedPath(relative(repositoryRoot, absolute)));
      }
    }
  };
  visit(resolve(repositoryRoot, relativeRoot));
  return files.sort();
}

interface ModuleFacts {
  readonly importSpecifiers: ReadonlySet<string>;
  readonly importTypeSpecifiers: ReadonlySet<string>;
  readonly mockSpecifiers: ReadonlySet<string>;
  readonly namedImports: ReadonlyMap<string, ReadonlySet<string>>;
  readonly reexportSpecifiers: ReadonlySet<string>;
  readonly reexportedNames: ReadonlySet<string>;
}

function moduleFacts(relativePath: string): ModuleFacts {
  const importSpecifiers = new Set<string>();
  const importTypeSpecifiers = new Set<string>();
  const mockSpecifiers = new Set<string>();
  const namedImports = new Map<string, Set<string>>();
  const reexportSpecifiers = new Set<string>();
  const reexportedNames = new Set<string>();
  const addNamedImport = (specifier: string, name: string): void => {
    const names = namedImports.get(specifier) ?? new Set<string>();
    names.add(name);
    namedImports.set(specifier, names);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      importSpecifiers.add(specifier);
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          addNamedImport(specifier, element.propertyName?.text ?? element.name.text);
        }
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      importTypeSpecifiers.add(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'vi' &&
      node.expression.name.text === 'mock' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      mockSpecifiers.add(node.arguments[0].text);
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        reexportSpecifiers.add(node.moduleSpecifier.text);
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          reexportedNames.add(element.propertyName?.text ?? element.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax(relativePath));
  return {
    importSpecifiers,
    importTypeSpecifiers,
    mockSpecifiers,
    namedImports,
    reexportSpecifiers,
    reexportedNames
  };
}

function declarationOwners(name: string): readonly string[] {
  return productionFiles(financialRoot).filter((relativePath) =>
    syntax(relativePath).statements.some((statement) =>
      (ts.isInterfaceDeclaration(statement) || ts.isFunctionDeclaration(statement)) &&
      statement.name?.text === name
    )
  );
}

describe('financial projection authority dependency boundary', () => {
  it('gives the public contract and private parser one leaf owner', () => {
    for (const name of ownedAuthorityDeclarations) {
      expect(declarationOwners(name), name).toEqual([leafPath]);
    }
  });

  it('limits the leaf to its exact dependency set', () => {
    expect([...moduleFacts(leafPath).importSpecifiers].sort()).toEqual(leafDependencies);
  });

  it('routes all eight production consumers directly to the leaf', () => {
    for (const [relativePath, expectedSpecifier] of consumers) {
      expect(
        moduleFacts(relativePath).importSpecifiers.has(expectedSpecifier),
        relativePath
      ).toBe(true);
    }
  });

  it('removes the three reciprocal replay imports', () => {
    for (const [relativePath, forbiddenSpecifier] of [
      [`${financialRoot}/ledger.ts`, './rebase'],
      [`${financialRoot}/sources/refund.ts`, '../rebase'],
      [`${financialRoot}/sources/dispute.ts`, '../rebase']
    ] as const) {
      expect(
        moduleFacts(relativePath).importSpecifiers.has(forbiddenSpecifier),
        relativePath
      ).toBe(false);
    }
  });

  it('moves direct-consumer imports, mocks, and import types off rebase', () => {
    for (const [relativePath, expectedSpecifier] of mockConsumers) {
      const facts = moduleFacts(relativePath);
      const forbiddenSpecifier = expectedSpecifier.replace('projection-authority', 'rebase');
      expect(facts.mockSpecifiers.has(expectedSpecifier), relativePath).toBe(true);
      expect(facts.importSpecifiers.has(forbiddenSpecifier), relativePath).toBe(false);
      expect(facts.importTypeSpecifiers.has(forbiddenSpecifier), relativePath).toBe(false);
      expect(facts.mockSpecifiers.has(forbiddenSpecifier), relativePath).toBe(false);
      if (relativePath.includes('/sources/')) {
        expect(facts.importSpecifiers.has(expectedSpecifier), relativePath).toBe(true);
      } else {
        expect(facts.importTypeSpecifiers.has(expectedSpecifier), relativePath).toBe(true);
      }
    }
  });

  it('splits the integration lock and replay imports by owner', () => {
    const facts = moduleFacts('tests/integration/financial-lock-order.test.ts');
    expect(
      facts.namedImports
        .get('$lib/server/commerce/financial/projection-authority')
        ?.has('lockFinancialProjectionAuthority')
    ).toBe(true);
    expect(
      facts.namedImports
        .get('$lib/server/commerce/financial/rebase')
        ?.has('replayFinancialClassification')
    ).toBe(true);
    expect(
      facts.namedImports
        .get('$lib/server/commerce/financial/rebase')
        ?.has('lockFinancialProjectionAuthority')
    ).not.toBe(true);
  });

  it('does not retain an authority declaration or re-export in rebase', () => {
    const facts = moduleFacts(rebasePath);
    expect([...facts.reexportSpecifiers]).not.toContain('./projection-authority');
    for (const name of publicAuthorityExports) {
      expect(declarationOwners(name), name).not.toContain(rebasePath);
      expect(facts.reexportedNames.has(name), name).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the focused RED**

```powershell
npm run test:unit -- scripts/financial-projection-authority-boundary.test.ts --reporter=verbose
```

Expected RED: the leaf is absent, declarations are owned by `rebase.ts`, consumers still import `rebase`, and the three reciprocal edges remain. The test itself must compile and report contract failures rather than throwing because a file is missing.

- [ ] **Step 3: Inspect the RED without implementing yet**

```powershell
git status --short -- scripts/financial-projection-authority-boundary.test.ts
git add --intent-to-add scripts/financial-projection-authority-boundary.test.ts
Get-Content scripts/financial-projection-authority-boundary.test.ts
npx eslint scripts/financial-projection-authority-boundary.test.ts
git diff --check -- scripts/financial-projection-authority-boundary.test.ts
git diff -- scripts/financial-projection-authority-boundary.test.ts
```

Expected: only the deliberate behavioral assertions fail; lint and diff checks pass.

### Task 3: Characterize and extract the projection-authority leaf

**Files:**

- Create: `src/lib/server/commerce/financial/projection-authority.ts`
- Create: `src/lib/server/commerce/financial/projection-authority.test.ts`

- [ ] **Step 1: Write the missing-module unit RED through public functions**

Create `src/lib/server/commerce/financial/projection-authority.test.ts` with this complete public-surface characterization. The fake exposes only `execute`, proving the helpers reuse the supplied transaction rather than opening one:

```ts
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { describe, expect, it, vi } from 'vitest';
import { PermanentFinancialError } from './errors';
import {
  loadFinancialProjectionAuthority,
  lockFinancialProjectionAuthority,
  lockFinancialProjectionEnrollment
} from './projection-authority';

const dialect = new PgDialect();
const activeAuthority = {
  classifierVersion: 1,
  allocationAlgorithmVersion: 1
};
const canonicalActiveAuthority = {
  ...activeAuthority,
  pendingClassifierVersion: null,
  pendingAllocationAlgorithmVersion: null,
  pendingReplayId: null,
  pendingScanRunId: null
};
const pendingAuthority = {
  ...activeAuthority,
  pendingClassifierVersion: 2,
  pendingAllocationAlgorithmVersion: 3,
  pendingReplayId: 'c2-a3',
  pendingScanRunId: '00000000-0000-4000-8000-000000000001'
};

function fakeTransaction(result: unknown = { rows: [activeAuthority] }) {
  const execute = vi.fn(async (_query: unknown) => {
    if (result instanceof Error) throw result;
    return result;
  });
  return {
    execute,
    transaction: { execute } as unknown as DatabaseTransaction
  };
}

function compiled(query: unknown): { sql: string; params: unknown[] } {
  const result = dialect.sqlToQuery(
    query as Parameters<typeof dialect.sqlToQuery>[0]
  );
  return {
    sql: result.sql.replaceAll(/\s+/gu, ' ').trim(),
    params: result.params
  };
}

async function capturedRejection(
  rows: Array<Record<string, unknown>> | undefined
): Promise<unknown> {
  const result = rows === undefined ? {} : { rows };
  const { transaction } = fakeTransaction(result);
  return loadFinancialProjectionAuthority(transaction).catch((error: unknown) => error);
}

function expectSourceLinkageError(error: unknown): void {
  expect(error).toBeInstanceOf(PermanentFinancialError);
  expect((error as PermanentFinancialError).safeCode).toBe('source_linkage_mismatch');
}

describe('financial projection authority', () => {
  it('canonicalizes omitted pending properties to null and tolerates extra properties', async () => {
    const { transaction } = fakeTransaction({
      rows: [{ ...activeAuthority, extraProviderColumn: 'tolerated' }]
    });
    await expect(loadFinancialProjectionAuthority(transaction))
      .resolves.toEqual(canonicalActiveAuthority);
  });

  it('preserves one valid all-present pending tuple', async () => {
    const { transaction } = fakeTransaction({ rows: [pendingAuthority] });
    await expect(loadFinancialProjectionAuthority(transaction))
      .resolves.toEqual(pendingAuthority);
  });

  it('uses the exact six-column read and lock queries', async () => {
    const load = fakeTransaction();
    const lock = fakeTransaction();
    await loadFinancialProjectionAuthority(load.transaction);
    await lockFinancialProjectionAuthority(lock.transaction);
    expect(load.execute).toHaveBeenCalledTimes(1);
    expect(lock.execute).toHaveBeenCalledTimes(1);

    const expectedSelect = [
      'select classifier_version as "classifierVersion",',
      'allocation_algorithm_version as "allocationAlgorithmVersion",',
      'pending_classifier_version as "pendingClassifierVersion",',
      'pending_allocation_algorithm_version as "pendingAllocationAlgorithmVersion",',
      'pending_replay_id as "pendingReplayId",',
      'pending_scan_run_id as "pendingScanRunId"',
      'from financial_projection_versions',
      'where singleton = true'
    ].join(' ');
    expect(compiled(load.execute.mock.calls[0]![0])).toEqual({
      sql: expectedSelect,
      params: []
    });
    expect(compiled(lock.execute.mock.calls[0]![0])).toEqual({
      sql: `${expectedSelect} for update`,
      params: []
    });
  });

  it('uses the exact replay-enrollment transaction advisory lock', async () => {
    const { execute, transaction } = fakeTransaction({ rows: [] });
    await expect(lockFinancialProjectionEnrollment(transaction)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    const query = compiled(execute.mock.calls[0]![0]);
    expect(query.sql).toBe(
      'select pg_advisory_xact_lock(hashtextextended( $1, 0 ))'
    );
    expect(query.params).toEqual(['pale-orbit:financial:replay-enrollment']);
  });

  it.each([
    ['classifier zero', { ...activeAuthority, classifierVersion: 0 }],
    ['classifier fractional', { ...activeAuthority, classifierVersion: 1.5 }],
    [
      'classifier unsafe',
      { ...activeAuthority, classifierVersion: Number.MAX_SAFE_INTEGER + 1 }
    ],
    ['classifier above int32', { ...activeAuthority, classifierVersion: 2_147_483_648 }],
    ['allocation zero', { ...activeAuthority, allocationAlgorithmVersion: 0 }],
    ['allocation fractional', { ...activeAuthority, allocationAlgorithmVersion: 1.5 }],
    [
      'allocation above int32',
      { ...activeAuthority, allocationAlgorithmVersion: 2_147_483_648 }
    ]
  ])('rejects invalid active version: %s', async (_name, row) => {
    expectSourceLinkageError(await capturedRejection([row]));
  });

  it.each([
    ['no row', []],
    ['duplicate rows', [activeAuthority, activeAuthority]],
    [
      'partial tuple',
      [{ ...activeAuthority, pendingClassifierVersion: 2 }]
    ],
    [
      'zero pending classifier',
      [{ ...pendingAuthority, pendingClassifierVersion: 0, pendingReplayId: 'c0-a3' }]
    ],
    [
      'malformed pending allocation',
      [{ ...pendingAuthority, pendingAllocationAlgorithmVersion: '3' }]
    ],
    [
      'mismatched replay id',
      [{ ...pendingAuthority, pendingReplayId: 'c2-a4' }]
    ],
    [
      'uppercase UUID',
      [{ ...pendingAuthority, pendingScanRunId: '00000000-0000-4000-8000-00000000000A' }]
    ],
    [
      'regressing classifier',
      [{ ...pendingAuthority, classifierVersion: 2, pendingClassifierVersion: 1,
        pendingReplayId: 'c1-a3' }]
    ],
    [
      'regressing allocation',
      [{ ...pendingAuthority, allocationAlgorithmVersion: 4,
        pendingAllocationAlgorithmVersion: 3 }]
    ],
    [
      'target equal to active pair',
      [{ ...pendingAuthority, classifierVersion: 2, allocationAlgorithmVersion: 3 }]
    ]
  ] as Array<[string, Array<Record<string, unknown>>]>)(
    'rejects invalid authority rows: %s',
    async (_name, rows) => {
      expectSourceLinkageError(await capturedRejection(rows));
    }
  );

  it('treats a missing rows property as no authority rows', async () => {
    expectSourceLinkageError(await capturedRejection(undefined));
  });

  it.each([
    loadFinancialProjectionAuthority,
    lockFinancialProjectionAuthority,
    lockFinancialProjectionEnrollment
  ])('propagates executor rejection by identity', async (operation) => {
    const failure = new Error('database unavailable');
    const { transaction } = fakeTransaction(failure);
    await expect(operation(transaction)).rejects.toBe(failure);
  });
});
```

Run:

```powershell
npm run test:unit -- src/lib/server/commerce/financial/projection-authority.test.ts --reporter=verbose
```

Expected RED: Vite cannot resolve `./projection-authority`.

- [ ] **Step 2: Create the complete leaf implementation**

Create `src/lib/server/commerce/financial/projection-authority.ts` exactly as follows. This is the current implementation mechanically extracted; do not simplify or tighten it:

```ts
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { sql, type SQL } from 'drizzle-orm';
import { PermanentFinancialError } from './errors';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type QueryResult = { rows?: unknown[] };

async function rows(transaction: DatabaseTransaction, query: SQL): Promise<unknown[]> {
  return ((await transaction.execute(query)) as QueryResult).rows ?? [];
}

function invalid(): never {
  throw new PermanentFinancialError('source_linkage_mismatch');
}

export interface FinancialProjectionAuthority {
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
  readonly pendingClassifierVersion: number | null;
  readonly pendingAllocationAlgorithmVersion: number | null;
  readonly pendingReplayId: string | null;
  readonly pendingScanRunId: string | null;
}

function positiveInt32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 &&
    (value as number) <= 2_147_483_647;
}

function canonicalFinancialProjectionAuthority(
  authorityRows: Array<Record<string, unknown>>
): FinancialProjectionAuthority {
  const raw = authorityRows[0];
  if (!raw || authorityRows.length !== 1 || !positiveInt32(raw.classifierVersion) ||
    !positiveInt32(raw.allocationAlgorithmVersion)) invalid();
  const pendingClassifierVersion = raw.pendingClassifierVersion ?? null;
  const pendingAllocationAlgorithmVersion = raw.pendingAllocationAlgorithmVersion ?? null;
  const pendingReplayId = raw.pendingReplayId ?? null;
  const pendingScanRunId = raw.pendingScanRunId ?? null;
  const pendingValues = [pendingClassifierVersion, pendingAllocationAlgorithmVersion,
    pendingReplayId, pendingScanRunId];
  const hasPending = pendingValues.every((value) => value !== null);
  if (!hasPending && pendingValues.some((value) => value !== null)) invalid();
  if (hasPending && (!positiveInt32(pendingClassifierVersion) ||
    !positiveInt32(pendingAllocationAlgorithmVersion) ||
    typeof pendingReplayId !== 'string' ||
    pendingReplayId !== `c${pendingClassifierVersion}-a${pendingAllocationAlgorithmVersion}` ||
    typeof pendingScanRunId !== 'string' || !UUID_PATTERN.test(pendingScanRunId) ||
    pendingClassifierVersion < raw.classifierVersion ||
    pendingAllocationAlgorithmVersion < raw.allocationAlgorithmVersion ||
    (pendingClassifierVersion === raw.classifierVersion &&
      pendingAllocationAlgorithmVersion === raw.allocationAlgorithmVersion))) invalid();
  return {
    classifierVersion: raw.classifierVersion,
    allocationAlgorithmVersion: raw.allocationAlgorithmVersion,
    pendingClassifierVersion: hasPending ? pendingClassifierVersion as number : null,
    pendingAllocationAlgorithmVersion:
      hasPending ? pendingAllocationAlgorithmVersion as number : null,
    pendingReplayId: hasPending ? pendingReplayId as string : null,
    pendingScanRunId: hasPending ? pendingScanRunId as string : null
  };
}

export async function loadFinancialProjectionAuthority(
  transaction: DatabaseTransaction
): Promise<FinancialProjectionAuthority> {
  return canonicalFinancialProjectionAuthority(await rows(transaction, sql`
    select classifier_version as "classifierVersion",
      allocation_algorithm_version as "allocationAlgorithmVersion",
      pending_classifier_version as "pendingClassifierVersion",
      pending_allocation_algorithm_version as "pendingAllocationAlgorithmVersion",
      pending_replay_id as "pendingReplayId",
      pending_scan_run_id as "pendingScanRunId"
    from financial_projection_versions
    where singleton = true
  `) as Array<Record<string, unknown>>);
}

export async function lockFinancialProjectionAuthority(
  transaction: DatabaseTransaction
): Promise<FinancialProjectionAuthority> {
  return canonicalFinancialProjectionAuthority(await rows(transaction, sql`
    select classifier_version as "classifierVersion",
      allocation_algorithm_version as "allocationAlgorithmVersion",
      pending_classifier_version as "pendingClassifierVersion",
      pending_allocation_algorithm_version as "pendingAllocationAlgorithmVersion",
      pending_replay_id as "pendingReplayId",
      pending_scan_run_id as "pendingScanRunId"
    from financial_projection_versions
    where singleton = true
    for update
  `) as Array<Record<string, unknown>>);
}

/**
 * Serializes every operation that can publish or enroll projection graph evidence. Callers that
 * lock the version authority must do so before this fence; commerce graph publishers take only
 * this fence and read the authority without a row lock.
 */
export async function lockFinancialProjectionEnrollment(
  transaction: DatabaseTransaction
): Promise<void> {
  await rows(transaction, sql`
    select pg_advisory_xact_lock(hashtextextended(
      ${'pale-orbit:financial:replay-enrollment'}, 0
    ))
  `);
}
```

The parser and helpers remain private. The only imports are the exact three module specifiers shown above; there is no `rebase.ts` dependency.

- [ ] **Step 3: Prove the leaf behavior while the boundary remains deliberately RED**

```powershell
npm run test:unit -- src/lib/server/commerce/financial/projection-authority.test.ts --reporter=verbose
npm run test:unit -- scripts/financial-projection-authority-boundary.test.ts --reporter=verbose
```

Expected: the new behavior test passes. The boundary test still fails because both `rebase.ts` and the leaf temporarily own the declarations and consumers have not moved. Do not commit this duplicate-owner state.

### Task 4: Rewire every authority consumer and remove the direct cycles

**Files:**

- Modify: `src/lib/server/commerce/financial/ledger.ts`
- Modify: `src/lib/server/commerce/financial/rebase.ts`
- Modify: `src/lib/server/commerce/financial/sources/refund.ts`
- Modify: `src/lib/server/commerce/financial/sources/dispute.ts`
- Modify: `src/lib/server/commerce/financial/payouts/repository.ts`
- Modify: `src/lib/server/commerce/financial/scans/repository.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/corrections.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/finalize.ts`
- Modify: `src/lib/server/commerce/financial/sources/refund.test.ts`
- Modify: `src/lib/server/commerce/financial/sources/dispute.test.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/corrections.test.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/finalize.test.ts`
- Modify: `tests/integration/financial-lock-order.test.ts`
- Test: `scripts/financial-projection-authority-boundary.test.ts`
- Test: `src/lib/server/commerce/financial/projection-authority.test.ts`

- [ ] **Step 1: Change production imports only, leaving call sites untouched**

Apply this exact map:

| Consumer | New module specifier | Imported authority symbols |
| --- | --- | --- |
| `ledger.ts` | `./projection-authority` | type plus load, lock, enrollment |
| `sources/refund.ts` | `../projection-authority` | enrollment |
| `sources/dispute.ts` | `../projection-authority` | enrollment |
| `payouts/repository.ts` | `../projection-authority` | enrollment |
| `scans/repository.ts` | `../projection-authority` | lock plus enrollment |
| `refund-review/corrections.ts` | `$lib/server/commerce/financial/projection-authority` | type plus load, lock, enrollment |
| `refund-review/finalize.ts` | `$lib/server/commerce/financial/projection-authority` | type plus load, lock, enrollment |

Do not move, wrap, reorder, split, or combine the calls. In particular, preserve every current authority -> enrollment -> domain-lock sequence and the exact caller-owned transaction.

- [ ] **Step 2: Move only the four direct-consumer test mocks**

Change the import/mock module in:

```text
sources/refund.test.ts                    ../projection-authority
sources/dispute.test.ts                   ../projection-authority
refund-review/corrections.test.ts         $lib/server/commerce/financial/projection-authority
refund-review/finalize.test.ts            $lib/server/commerce/financial/projection-authority
```

For the two refund-review partial mocks, change both `vi.mock(...)` and the generic `import(...)` passed to `importOriginal`. Do not mechanically replace unrelated `rebase` imports or mocks: classification handler and replay tests must continue using `rebase.ts`.

- [ ] **Step 3: Split the integration import by responsibility**

In `tests/integration/financial-lock-order.test.ts`, use:

```ts
import { lockFinancialProjectionAuthority } from
  '$lib/server/commerce/financial/projection-authority';
import { replayFinancialClassification } from
  '$lib/server/commerce/financial/rebase';
```

Do not alter any integration test body, race timing, lock probe, or assertion.

- [ ] **Step 4: Remove the old owner only after every dependent import is ready**

In the same working-tree change as Steps 1-3, delete from `rebase.ts` only `FinancialProjectionAuthority`, `canonicalFinancialProjectionAuthority`, `loadFinancialProjectionAuthority`, `lockFinancialProjectionAuthority`, `lockFinancialProjectionEnrollment`, and the enrollment comment moved with it. Keep replay's `UUID_PATTERN`, `QueryResult`, `rows`, `invalid`, and `positiveInt32`, because replay still uses them elsewhere.

Add only the two functions that `rebase.ts` actually calls:

```ts
import {
  lockFinancialProjectionAuthority,
  lockFinancialProjectionEnrollment
} from './projection-authority';
```

Do not import the unused load helper and do not re-export any authority symbol through `rebase.ts`. Apply Steps 1-4 atomically before running a module-loading test; an intermediate tree with deleted exports and old consumer imports is intentionally invalid and must never be committed.

- [ ] **Step 5: Run the dependency and behavior GREEN**

```powershell
npm run test:unit -- scripts/financial-projection-authority-boundary.test.ts src/lib/server/commerce/financial/projection-authority.test.ts --reporter=verbose
```

Expected: one production owner, exact three leaf dependencies, all eight direct consumers, correct test mocks, correct integration import, and no `rebase` edge from ledger/refund/dispute.

- [ ] **Step 6: Run focused financial regression witnesses**

```powershell
npm run test:unit -- scripts/financial-projection-authority-boundary.test.ts src/lib/server/commerce/financial/projection-authority.test.ts src/lib/server/commerce/financial/rebase.test.ts src/lib/server/commerce/financial/ledger.test.ts src/lib/server/commerce/financial/payouts/repository.test.ts src/lib/server/commerce/financial/scans/repository.test.ts src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/sources/dispute.test.ts src/lib/server/commerce/financial/refund-review/corrections.test.ts src/lib/server/commerce/financial/refund-review/finalize.test.ts --reporter=verbose
```

Expected: all listed files pass. Existing query-count, transaction reuse, replay, and lock-order expectations remain unchanged.

- [ ] **Step 7: Run the six focused PostgreSQL authority/race witnesses serially**

Run this one command through the fail-closed wrapper:

```powershell
Invoke-CheckpointAServiceCommand {
  npx tsx scripts/with-test-database.ts npx vitest run --config vitest.integration.config.ts tests/integration/financial-sources.test.ts tests/integration/financial-reclassification.test.ts tests/integration/financial-refund-review.test.ts tests/integration/financial-lock-order.test.ts -t "retries when a sibling dispute balance joins the graph before authority enrollment|keeps classifier rebase behind real finalization projection authority before purchase|rejects a finalization when a projection replay becomes pending after preview|locks active projection authority before the finalization order graph|lets recovery hold projection authority while waiting on the order graph without mutation|keeps classifier rebase behind correction projection authority"
}
```

Expected: all six selected tests pass and the wrapper exits zero.

- [ ] **Step 8: Type-check, lint, inspect, and commit the leaf**

```powershell
npm run check
npx eslint scripts/financial-projection-authority-boundary.test.ts src/lib/server/commerce/financial/projection-authority.ts src/lib/server/commerce/financial/projection-authority.test.ts src/lib/server/commerce/financial/rebase.ts src/lib/server/commerce/financial/ledger.ts src/lib/server/commerce/financial/sources/refund.ts src/lib/server/commerce/financial/sources/dispute.ts src/lib/server/commerce/financial/payouts/repository.ts src/lib/server/commerce/financial/scans/repository.ts src/lib/server/commerce/financial/refund-review/corrections.ts src/lib/server/commerce/financial/refund-review/finalize.ts src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/sources/dispute.test.ts src/lib/server/commerce/financial/refund-review/corrections.test.ts src/lib/server/commerce/financial/refund-review/finalize.test.ts tests/integration/financial-lock-order.test.ts
git status --short
git diff --check
git diff --stat
```

Review the full diff for SQL, error, transaction, and call-order drift. Then:

```powershell
git add scripts/financial-projection-authority-boundary.test.ts src/lib/server/commerce/financial/projection-authority.ts src/lib/server/commerce/financial/projection-authority.test.ts src/lib/server/commerce/financial/rebase.ts src/lib/server/commerce/financial/ledger.ts src/lib/server/commerce/financial/sources/refund.ts src/lib/server/commerce/financial/sources/dispute.ts src/lib/server/commerce/financial/payouts/repository.ts src/lib/server/commerce/financial/scans/repository.ts src/lib/server/commerce/financial/refund-review/corrections.ts src/lib/server/commerce/financial/refund-review/finalize.ts src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/sources/dispute.test.ts src/lib/server/commerce/financial/refund-review/corrections.test.ts src/lib/server/commerce/financial/refund-review/finalize.test.ts tests/integration/financial-lock-order.test.ts
git diff --cached --check
git diff --cached --stat
git diff --cached
git commit -m "refactor: extract financial projection authority leaf"
```

## Milestone C — relocate the shared rate-limit service

### Task 5: Write the shared-core RED

**Files:**

- Create: `src/lib/server/security/rate-limit.test.ts`

- [ ] **Step 1: Move and extend the digest characterization tests at the intended owner**

Copy the three existing digest cases from `src/lib/server/commerce/rate-limit.test.ts` into the new shared-core test. Add explicit assertions that:

- authenticated scope equals SHA-256 of `user:<id>` and is independent of IP and application secret;
- anonymous scope equals HMAC-SHA-256 of `ip:<trimmed-ip>` under the application secret;
- empty or whitespace-only anonymous IP and an exactly empty-string secret reject with the dedicated shared error;
- a nonempty whitespace-only secret remains accepted, preserving the current nonempty-string check;
- `guest` and `system` actors retain the current non-user branch and therefore use the same IP-HMAC scope as an anonymous actor with the same IP/secret;
- neither digest contains the raw ID or IP; and
- the core source has no import whose specifier contains `/commerce/` or begins with `../commerce`.

- [ ] **Step 2: Add table-driven shared validation tests**

Use the exact shared error contract selected for this checkpoint:

```ts
export class InvalidRateLimitInputError extends Error {
  readonly code = 'invalid_rate_limit_input' as const;

  constructor() {
    super('Rate-limit input is invalid.');
    this.name = 'InvalidRateLimitInputError';
  }
}
```

For every invalid namespace, digest, window, maximum, anonymous scope, and cleanup limit, assert all three properties:

```ts
expect(error).toBeInstanceOf(InvalidRateLimitInputError);
expect((error as InvalidRateLimitInputError).code).toBe('invalid_rate_limit_input');
expect((error as Error).message).toBe('Rate-limit input is invalid.');
```

The matrix must include empty/uppercase/over-100-character namespaces, non-lowercase or non-64-character digests, zero/fractional windows and maximums, cleanup limits `0`, `1001`, and fractional values, an empty or whitespace-only anonymous IP, and an exactly empty-string secret. Do not trim or newly reject a nonempty whitespace-only secret, and do not echo any rejected input into the error.

- [ ] **Step 3: Characterize SQL decisions with a fake fluent executor**

Add unit witnesses for:

- cleanup runs before insert and uses automatic batch `100`;
- fixed-window start and expiry are computed from the provided `now`;
- the upsert conflict target remains namespace + digest + window start;
- the count expression saturates at `maxAttempts + 1`;
- allowed/remaining/retry-after values for counts `1`, `N`, and `N+1` remain exact;
- explicit cleanup defaults to `500`, accepts `1..1000`, returns `deleted.rows.length`, and preserves the exact ordering/`FOR UPDATE SKIP LOCKED` shape; and
- an absent upsert row throws the existing unexpected `Error('Rate-limit upsert returned no row')`, not the invalid-input error.

Use this complete fake-chain shape in that file so the RED cannot be caused by a malformed Drizzle double; replace the old Vitest import with the `vi`-inclusive import below rather than duplicating it:

```ts
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { applicationRateLimits } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { describe, expect, it, vi } from 'vitest';

const dialect = new PgDialect();

function compiled(query: unknown): { sql: string; params: unknown[] } {
  const result = dialect.sqlToQuery(
    query as Parameters<typeof dialect.sqlToQuery>[0]
  );
  return { sql: result.sql.replaceAll(/\s+/gu, ' ').trim(), params: result.params };
}

function fakeRateLimitDatabase(options: {
  readonly count?: number | null;
  readonly deleted?: number;
} = {}) {
  const returning = vi.fn(async () =>
    options.count === null ? [] : [{ count: options.count ?? 1 }]
  );
  const onConflictDoUpdate = vi.fn((_input: unknown) => ({ returning }));
  const values = vi.fn((_input: unknown) => ({ onConflictDoUpdate }));
  const insert = vi.fn((_table: unknown) => ({ values }));
  const execute = vi.fn(async (_query: SQL) => ({
    rows: Array.from({ length: options.deleted ?? 0 }, () => ({ deleted: 1 }))
  }));
  return {
    database: { execute, insert } as unknown as DatabaseExecutor,
    execute,
    insert,
    onConflictDoUpdate,
    returning,
    values
  };
}
```

Use `mock.invocationCallOrder` to prove cleanup precedes insert. Inspect `values.mock.calls[0]![0]` for `windowStart`/`expiresAt`; inspect `onConflictDoUpdate.mock.calls[0]![0]` to compare the target to the three exact `applicationRateLimits` columns and compile `set.count`; compile `execute.mock.calls[0]![0]` to prove cleanup order, `FOR UPDATE SKIP LOCKED`, and limits. Configure `count: null` for the absent-row error and `deleted` for the cleanup return count.

- [ ] **Step 4: Run the intended shared-core RED only**

```powershell
npm run test:unit -- src/lib/server/security/rate-limit.test.ts --reporter=verbose
```

Expected RED: the shared module is missing. The test file itself compiles through collection far enough to report that missing intended owner; do not attempt the adapter RED until the core exists.

### Task 6: Create the shared core and narrow commerce adapter

**Files:**

- Create: `src/lib/server/security/rate-limit.ts`
- Test: `src/lib/server/security/rate-limit.test.ts`
- Modify: `src/lib/server/commerce/rate-limit.ts`
- Test: `src/lib/server/commerce/rate-limit.test.ts`

- [ ] **Step 1: Relocate the implementation literally into the shared core**

Move `AUTOMATIC_CLEANUP_LIMIT`, the four public interfaces, digest logic, input validation, `consumeRateLimit`, and `cleanupExpiredRateLimits` from the commerce module. Retain the existing type-only `Actor` import so the public scope-input contract does not change. Replace only the six current `new PermanentCommerceError()` validation throws with `new InvalidRateLimitInputError()`.

The core imports must be exactly the dependencies it needs and include no commerce path:

```ts
import { createHash, createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Actor } from '$lib/server/auth/admin-policy';
import { applicationRateLimits } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
```

After those imports, use this complete body:

```ts
const AUTOMATIC_CLEANUP_LIMIT = 100;

export class InvalidRateLimitInputError extends Error {
  readonly code = 'invalid_rate_limit_input' as const;

  constructor() {
    super('Rate-limit input is invalid.');
    this.name = 'InvalidRateLimitInputError';
  }
}

export interface RateLimitScopeInput {
  actor: Actor;
  requestIp: string;
  applicationSecret: string;
}

export function rateLimitScopeDigest(input: RateLimitScopeInput): string {
  if (input.actor.type === 'user') {
    return createHash('sha256').update(`user:${input.actor.id}`, 'utf8').digest('hex');
  }
  const requestIp = input.requestIp.trim();
  if (!requestIp || !input.applicationSecret) throw new InvalidRateLimitInputError();
  return createHmac('sha256', input.applicationSecret)
    .update(`ip:${requestIp}`, 'utf8')
    .digest('hex');
}

export interface ConsumeRateLimitInput {
  namespace: string;
  scopeSha256: string;
  windowSeconds: number;
  maxAttempts: number;
  now?: Date;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

function validateLimitInput(input: ConsumeRateLimitInput): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(input.namespace)) {
    throw new InvalidRateLimitInputError();
  }
  if (!/^[a-f0-9]{64}$/u.test(input.scopeSha256)) {
    throw new InvalidRateLimitInputError();
  }
  if (!Number.isInteger(input.windowSeconds) || input.windowSeconds < 1) {
    throw new InvalidRateLimitInputError();
  }
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new InvalidRateLimitInputError();
  }
}

export async function consumeRateLimit(
  database: DatabaseExecutor,
  input: ConsumeRateLimitInput
): Promise<RateLimitDecision> {
  validateLimitInput(input);
  const now = input.now ?? new Date();
  await cleanupExpiredRateLimits(database, {
    namespace: input.namespace,
    now,
    limit: AUTOMATIC_CLEANUP_LIMIT
  });
  const windowMilliseconds = input.windowSeconds * 1000;
  const windowStart = new Date(
    Math.floor(now.getTime() / windowMilliseconds) * windowMilliseconds
  );
  const expiresAt = new Date(windowStart.getTime() + windowMilliseconds);
  const [row] = await database
    .insert(applicationRateLimits)
    .values({
      namespace: input.namespace,
      scopeSha256: input.scopeSha256,
      windowStart,
      count: 1,
      expiresAt,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [
        applicationRateLimits.namespace,
        applicationRateLimits.scopeSha256,
        applicationRateLimits.windowStart
      ],
      set: {
        count: sql`least(${applicationRateLimits.count} + 1, ${input.maxAttempts + 1})`,
        updatedAt: now
      }
    })
    .returning({ count: applicationRateLimits.count });
  if (!row) throw new Error('Rate-limit upsert returned no row');

  const allowed = row.count <= input.maxAttempts;
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(
        1,
        Math.min(
          input.windowSeconds,
          Math.ceil((expiresAt.getTime() - now.getTime()) / 1000)
        )
      );
  return {
    allowed,
    limit: input.maxAttempts,
    remaining: Math.max(0, input.maxAttempts - row.count),
    retryAfterSeconds
  };
}

export interface CleanupExpiredRateLimitsInput {
  namespace: string;
  now?: Date;
  limit?: number;
}

export async function cleanupExpiredRateLimits(
  database: DatabaseExecutor,
  input: CleanupExpiredRateLimitsInput
): Promise<number> {
  const limit = input.limit ?? 500;
  if (
    !/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(input.namespace) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    throw new InvalidRateLimitInputError();
  }
  const now = input.now ?? new Date();
  const deleted = await database.execute<{ deleted: number }>(sql`
    with candidates as (
      select namespace, scope_sha256, window_start
      from application_rate_limits
      where namespace = ${input.namespace}
        and expires_at <= ${now}
      order by expires_at asc, scope_sha256 asc, window_start asc
      for update skip locked
      limit ${limit}
    )
    delete from application_rate_limits target
    using candidates
    where target.namespace = candidates.namespace
      and target.scope_sha256 = candidates.scope_sha256
      and target.window_start = candidates.window_start
    returning 1 as deleted
  `);
  return deleted.rows.length;
}
```

Do not move `applicationRateLimits`, alter its schema or migration, add a namespace, or change any SQL/calculation.

- [ ] **Step 2: Run the shared-core GREEN before writing the adapter RED**

```powershell
npm run test:unit -- src/lib/server/security/rate-limit.test.ts --reporter=verbose
```

Expected: all digest, actor-branch, validation, safe-error, SQL-chain, cleanup, window, decision, and unexpected-row tests pass. The commerce implementation is still unchanged at this point.

- [ ] **Step 3: Rewrite the commerce test as the adapter contract**

Replace the old digest-only commerce test with this complete adapter-focused shape; extend the three mapped-error assertions rather than retaining duplicated digest behavior here:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { describe, expect, it, vi } from 'vitest';
import { InvalidRateLimitInputError } from '$lib/server/security/rate-limit';
import { PermanentCommerceError } from './errors';
import * as rateLimitAdapter from './rate-limit';

function expectMappedInvalidInput(error: unknown): void {
  expect(error).toBeInstanceOf(PermanentCommerceError);
  expect((error as Error).cause).toBeInstanceOf(InvalidRateLimitInputError);
}

describe('commerce rate-limit compatibility adapter', () => {
  it('maps invalid digest scope and retains the shared error only as cause', () => {
    let thrown: unknown;
    try {
      rateLimitAdapter.rateLimitScopeDigest({
        actor: { type: 'anonymous' },
        requestIp: '   ',
        applicationSecret: 'test-only-application-secret-123456789'
      });
    } catch (error) {
      thrown = error;
    }
    expectMappedInvalidInput(thrown);
  });

  it('maps invalid consume input through the asynchronous wrapper', async () => {
    const error = await rateLimitAdapter.consumeRateLimit({} as DatabaseExecutor, {
      namespace: 'INVALID',
      scopeSha256: 'a'.repeat(64),
      windowSeconds: 60,
      maxAttempts: 5
    }).catch((cause: unknown) => cause);
    expectMappedInvalidInput(error);
  });

  it('maps invalid cleanup input through the asynchronous wrapper', async () => {
    const error = await rateLimitAdapter.cleanupExpiredRateLimits(
      {} as DatabaseExecutor,
      { namespace: 'commerce.quote', limit: 1001 }
    ).catch((cause: unknown) => cause);
    expectMappedInvalidInput(error);
  });

  it('does not re-export the shared invalid-input error', () => {
    expect(Reflect.has(rateLimitAdapter, 'InvalidRateLimitInputError')).toBe(false);
  });

  it('rethrows a valid-input database failure by identity', async () => {
    const failure = new Error('database unavailable');
    const database = {
      execute: vi.fn().mockRejectedValue(failure)
    } as unknown as DatabaseExecutor;
    await expect(rateLimitAdapter.consumeRateLimit(database, {
      namespace: 'commerce.quote',
      scopeSha256: 'a'.repeat(64),
      windowSeconds: 60,
      maxAttempts: 5,
      now: new Date('2026-08-24T12:00:00.000Z')
    })).rejects.toBe(failure);
  });

  it('contains no hashing, SQL, schema, cleanup, or validation implementation', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./rate-limit.ts', import.meta.url)),
      'utf8'
    ).replace(/\r\n?/gu, '\n');
    for (const forbidden of [
      'node:crypto',
      'drizzle-orm',
      'applicationRateLimits',
      'AUTOMATIC_CLEANUP_LIMIT',
      'onConflictDoUpdate',
      'skip locked',
      '[a-z0-9._-]'
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 4: Run the adapter RED against the old commerce implementation**

```powershell
npm run test:unit -- src/lib/server/commerce/rate-limit.test.ts --reporter=verbose
```

Expected RED: the current commerce implementation throws `PermanentCommerceError` without the shared cause and still contains hashing/SQL/schema/validation. The shared core now resolves, so missing-module failure cannot mask this RED.

- [ ] **Step 5: Replace the commerce implementation with this exact adapter shape**

```ts
import {
  cleanupExpiredRateLimits as cleanupShared,
  consumeRateLimit as consumeShared,
  InvalidRateLimitInputError,
  rateLimitScopeDigest as digestShared
} from '$lib/server/security/rate-limit';
import type {
  CleanupExpiredRateLimitsInput,
  ConsumeRateLimitInput,
  RateLimitDecision,
  RateLimitScopeInput
} from '$lib/server/security/rate-limit';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { PermanentCommerceError } from './errors';

export type {
  CleanupExpiredRateLimitsInput,
  ConsumeRateLimitInput,
  RateLimitDecision,
  RateLimitScopeInput
};

function mapInvalidInput(error: unknown): never {
  if (error instanceof InvalidRateLimitInputError) {
    throw new PermanentCommerceError({ cause: error });
  }
  throw error;
}

export function rateLimitScopeDigest(input: RateLimitScopeInput): string {
  try {
    return digestShared(input);
  } catch (error) {
    return mapInvalidInput(error);
  }
}

export async function consumeRateLimit(
  database: DatabaseExecutor,
  input: ConsumeRateLimitInput
): Promise<RateLimitDecision> {
  try {
    return await consumeShared(database, input);
  } catch (error) {
    return mapInvalidInput(error);
  }
}

export async function cleanupExpiredRateLimits(
  database: DatabaseExecutor,
  input: CleanupExpiredRateLimitsInput
): Promise<number> {
  try {
    return await cleanupShared(database, input);
  } catch (error) {
    return mapInvalidInput(error);
  }
}
```

The `await` inside each asynchronous `try` is required; returning the promise directly would bypass rejection mapping.

- [ ] **Step 6: Run the shared and adapter GREEN**

```powershell
npm run test:unit -- src/lib/server/security/rate-limit.test.ts src/lib/server/commerce/rate-limit.test.ts --reporter=verbose
```

Expected: digest, validation, SQL characterization, safe shared error, error mapping, unexpected-error propagation, and dependency-shape cases all pass.

- [ ] **Step 7: Confirm production callers still use the adapter**

```powershell
rg -n "commerce/rate-limit|from './rate-limit'" src/lib/server/commerce src/routes/api/commerce -g '!*.test.ts'
rg -n "server/security/rate-limit" src/lib/server/commerce src/routes/api/commerce -g '!*.test.ts'
```

Expected: quote, orders, and claims still point to the commerce adapter. No route/domain caller imports the shared core directly. The only `security/rate-limit` production import in the commerce tree is the adapter itself.

### Task 7: Move the PostgreSQL witness to the shared rate-limit owner

**Files:**

- Modify: `tests/integration/commerce-rate-limit.test.ts`
- Modify: `src/routes/claim/page.server.test.ts`
- Test without modification: `src/routes/api/commerce/quote/route.test.ts`
- Test without modification: `src/routes/api/commerce/checkout/route.test.ts`
- Test without modification: `src/lib/server/commerce/orders.test.ts`
- Test without modification: `src/lib/server/commerce/claims.test.ts`

- [ ] **Step 1: Change only the integration service import and suite label**

In `tests/integration/commerce-rate-limit.test.ts`, import the three functions from:

```ts
import {
  cleanupExpiredRateLimits,
  consumeRateLimit,
  rateLimitScopeDigest
} from '$lib/server/security/rate-limit';
```

Rename the describe label from `application commerce rate limits` to `shared application rate limits`. Keep the historical filename and every namespace/behavior assertion unchanged.

- [ ] **Step 2: Characterize the claim action's mapped failure boundary**

Add `import { PermanentCommerceError } from '$lib/server/commerce/errors';` to `src/routes/claim/page.server.test.ts`, then add:

```ts
it('returns one bounded unavailable result when commerce rate limiting rejects', async () => {
  dependencies.requestGuestClaimEmails.mockRejectedValueOnce(
    new PermanentCommerceError()
  );

  const result = await submit(event('private-reader@example.com') as never);

  expect(result).toMatchObject({ status: 503, data: { unavailable: true } });
  expect(JSON.stringify(result)).not.toMatch(
    /private-reader|203\.0\.113\.41|PERMANENT_COMMERCE_FAILURE/iu
  );
});
```

This is a behavior-preservation witness; it should pass against both the old implementation and the completed adapter. Do not change the route's generic catch or response.

- [ ] **Step 3: Run focused hermetic consumers**

```powershell
npm run test:unit -- src/lib/server/security/rate-limit.test.ts src/lib/server/commerce/rate-limit.test.ts src/routes/api/commerce/quote/route.test.ts src/routes/api/commerce/checkout/route.test.ts src/routes/claim/page.server.test.ts src/lib/server/commerce/orders.test.ts src/lib/server/commerce/claims.test.ts src/lib/server/db/schema/commerce.test.ts --reporter=verbose
```

Expected: all listed tests pass. Route mocks continue targeting the commerce adapter, quote/checkout errors are unchanged, and claims remain non-enumerating.

- [ ] **Step 4: Run focused PostgreSQL rate-limit consumers serially**

Run this one command through the fail-closed wrapper:

```powershell
Invoke-CheckpointAServiceCommand {
  npm run test:integration -- tests/integration/commerce-rate-limit.test.ts tests/integration/commerce-orders.test.ts tests/integration/commerce-claims.test.ts --reporter=verbose
}
```

Expected: existing counter, cleanup, concurrency, privacy, checkout-429, and claim non-enumeration witnesses pass against migration `0014`, and the wrapper exits zero.

- [ ] **Step 5: Type-check, lint, inspect, and commit the relocation**

```powershell
npm run check
npx eslint src/lib/server/security/rate-limit.ts src/lib/server/security/rate-limit.test.ts src/lib/server/commerce/rate-limit.ts src/lib/server/commerce/rate-limit.test.ts src/routes/claim/page.server.test.ts tests/integration/commerce-rate-limit.test.ts
git status --short
git diff --check
git diff -- src/lib/server/security/rate-limit.ts src/lib/server/security/rate-limit.test.ts src/lib/server/commerce/rate-limit.ts src/lib/server/commerce/rate-limit.test.ts src/routes/claim/page.server.test.ts tests/integration/commerce-rate-limit.test.ts
```

Review specifically for copied SQL/calculation drift and over-catching. Then:

```powershell
git add src/lib/server/security/rate-limit.ts src/lib/server/security/rate-limit.test.ts src/lib/server/commerce/rate-limit.ts src/lib/server/commerce/rate-limit.test.ts src/routes/claim/page.server.test.ts tests/integration/commerce-rate-limit.test.ts
git diff --cached --check
git diff --cached --stat
git diff --cached
git commit -m "refactor: relocate shared rate limit service"
```

## Milestone D — separate hermetic and service-backed tests

### Task 8: Write the executable test-profile boundary RED

**Files:**

- Create: `scripts/test-profile-boundaries.test.ts`

- [ ] **Steps 1-3: Create the complete static contract test**

Create `scripts/test-profile-boundaries.test.ts` exactly as follows. Missing planned files return normalized empty text, so the initial run reports assertion failures instead of aborting with `ENOENT`. The test never spawns a process or service:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function source(relativePath: string): string {
  const absolute = resolve(repositoryRoot, relativePath);
  return existsSync(absolute)
    ? readFileSync(absolute, 'utf8').replace(/\r\n?/gu, '\n')
    : '';
}

function occurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1;
}

interface PackageJson {
  readonly scripts: Readonly<Record<string, string>>;
}

const packageJson = JSON.parse(source('package.json')) as PackageJson;
const scripts = packageJson.scripts;
const unitConfig = source('vitest.config.ts');
const serviceConfig = source('vitest.service.config.ts');
const commerceOperations = source('scripts/commerce-operations.test.ts');
const serviceTest = source('tests/service/financial-restore-witness.test.ts');
const witnessHarness = source('scripts/financial-restore-witness-harness.ts');

describe('test profile boundaries', () => {
  it('pins the four public test commands and release-gate order', () => {
    expect(scripts.test).toBe('vitest run --config vitest.config.ts');
    expect(scripts['test:unit']).toBe('vitest run --config vitest.config.ts');
    expect(scripts['test:service']).toBe(
      'vitest run --config vitest.service.config.ts'
    );
    expect(scripts['test:watch']).toBe('vitest --config vitest.config.ts');
    expect(scripts.verify).toBe(
      'npm run check && npm run lint && npm run test:unit && npm run test:service && ' +
      'npm run test:database && npm run build'
    );

    const verifySteps = scripts.verify?.split(' && ') ?? [];
    expect(verifySteps.filter((step) => step === 'npm run test:service')).toHaveLength(1);
    expect(verifySteps.indexOf('npm run test:service'))
      .toBeGreaterThan(verifySteps.indexOf('npm run test:unit'));
    expect(verifySteps.indexOf('npm run test:service'))
      .toBeLessThan(verifySteps.indexOf('npm run test:database'));
  });

  it('does not rewrite existing database, browser, or upgrade commands', () => {
    expect({
      'test:integration:raw': scripts['test:integration:raw'],
      'test:integration': scripts['test:integration'],
      'test:plan6b-upgrade': scripts['test:plan6b-upgrade'],
      'test:e2e:raw': scripts['test:e2e:raw'],
      'test:e2e': scripts['test:e2e'],
      'test:database': scripts['test:database']
    }).toEqual({
      'test:integration:raw': 'vitest run --config vitest.integration.config.ts',
      'test:integration':
        'tsx scripts/with-test-database.ts npm run test:integration:raw',
      'test:plan6b-upgrade':
        'tsx scripts/with-plan6b-upgrade-database.ts --phase-command tsx tests/integration/financial-migration.test.ts',
      'test:e2e:raw': 'playwright test',
      'test:e2e':
        'tsx scripts/with-test-database.ts --worker --bootstrap-admin npm run test:e2e:raw',
      'test:database': 'npm run test:integration && npm run test:e2e'
    });
  });

  it('keeps unit discovery hermetic and service discovery singular and serial', () => {
    expect(unitConfig).toContain(
      "include: ['src/**/*.test.ts', 'scripts/**/*.test.ts']"
    );
    expect(unitConfig).toContain("exclude: ['tests/service/**/*.test.ts']");
    expect(serviceConfig).toContain(
      "include: ['tests/service/financial-restore-witness.test.ts']"
    );
    expect(serviceConfig).toContain("environment: 'node'");
    expect(serviceConfig).toContain('fileParallelism: false');
    expect(serviceConfig).toContain('maxWorkers: 1');
    expect(serviceConfig).toContain('clearMocks: true');
    expect(serviceConfig).toContain('restoreMocks: true');
    expect(serviceConfig).not.toMatch(/tests\/(?:integration|e2e)|upgrade|smoke/iu);
    expect(serviceConfig).not.toContain('tests/service/**/*.test.ts');
  });

  it('places the one active PostgreSQL invocation only in the service test', () => {
    const invocation = 'await runBoundedFinancialWitnessHarness()';
    expect(occurrences(commerceOperations, invocation)).toBe(0);
    expect(occurrences(serviceTest, invocation)).toBe(1);
    expect(serviceTest).toContain(
      'executes schema-object, source-parity, deterministic-allocation, audit, payout, and chronology verifier witnesses in PostgreSQL'
    );
    expect(serviceTest).toContain('financialWitnessTestTimeoutMs');
  });

  it('retains the bounded supervisor and exact cleanup safeguards', () => {
    for (const required of [
      'const financialWitnessHarnessTimeoutMs = 1_200_000',
      'npm_execpath is required for the direct Node test-database harness',
      'terminateFinancialWitnessHarnessProcessTree',
      "'down', '--volumes', '--remove-orphans'",
      'pale-orbit-test-[0-9a-f]{16}',
      'pale-orbit-test-storage-',
      'exactNewFinancialHarnessProject',
      'exactNewFinancialHarnessStorageDirectory',
      'assertFinancialHarnessProjectOwned'
    ]) {
      expect(witnessHarness, required).toContain(required);
    }
  });
});
```

The exact awaited-call count avoids a false positive from the hermetic `runBoundedFinancialWitnessHarness.toString()` assertion.

- [ ] **Step 4: Run the focused RED**

```powershell
npm run test:unit -- scripts/test-profile-boundaries.test.ts --reporter=verbose
```

Expected RED: the service script/config/test/harness split is absent, `verify` lacks the service lane, and the active witness still resides in the unit test. The boundary test itself must not start Docker.

### Task 9: Extract the bounded witness harness without weakening it

**Files:**

- Create: `scripts/financial-restore-witness-harness.ts`
- Create: `tests/service/financial-restore-witness.test.ts`
- Modify: `scripts/commerce-operations.test.ts`
- Test: `scripts/test-profile-boundaries.test.ts`

- [ ] **Step 1: Move the supervisor and ownership machinery mechanically**

Move the current implementation spanning `restoreVerifierWitnessPath` through `runBoundedFinancialWitnessHarness` into `scripts/financial-restore-witness-harness.ts`. Give that module its own `root = new URL('../', import.meta.url)` and only the Node imports used by the moved code.

Export exactly what the remaining hermetic tests or the service test consume. The following block is a nonliteral API checklist of signatures; do not paste the bodyless declarations. Add `export` to the corresponding mechanically moved, initialized declarations and concrete functions:

```ts
export const restoreVerifierWitnessPath: string;
export const ownerRestoreVerifierLauncher: string;
export const financialWitnessHarnessTimeoutMs = 1_200_000;
export const financialWitnessTestTimeoutMs = 1_500_000;

export interface FinancialHarnessDockerResource {
  readonly id: string;
  readonly kind: 'container' | 'network' | 'volume';
  readonly labels: Readonly<Record<string, string>>;
}

export interface BoundedFinancialWitnessHarnessResult {
  readonly cleanup: string | null;
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface FinancialWitnessHarnessClose {
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
}

export function exactNewFinancialHarnessProject(
  baseline: ReadonlyMap<string, FinancialHarnessDockerResource>,
  current: ReadonlyMap<string, FinancialHarnessDockerResource>
): string;

export function exactNewFinancialHarnessStorageDirectory(
  baseline: ReadonlySet<string>,
  current: ReadonlySet<string>
): string | null;

export function assertFinancialHarnessProjectOwned(
  project: string,
  baseline: ReadonlyMap<string, FinancialHarnessDockerResource>
): void;

export function waitForFinancialWitnessHarnessClose(
  close: Promise<FinancialWitnessHarnessClose>,
  timeoutMs: number
): Promise<FinancialWitnessHarnessClose | null>;

export function runBoundedFinancialWitnessHarness():
  Promise<BoundedFinancialWitnessHarnessResult>;
```

The signatures above specify the exported surface; the implementation is the existing concrete body moved byte-for-behavior. Keep `financialWitnessCloseGraceMs`, Docker command/snapshot helpers, storage enumeration, cleanup, fingerprinting, direct-Node environment guard, patterns, and Compose path private.

Do not redesign the supervisor. Preserve:

- the 1,200,000 ms child deadline and 1,500,000 ms Vitest deadline;
- the 15,000 ms close grace;
- detached POSIX process groups and Windows `taskkill.exe /T /F`;
- the second tree-kill attempt, direct `SIGKILL` fallback, and refusal to clean before exact termination is confirmed;
- baseline resource and storage snapshots;
- one-new-project and at-most-one-new-storage-root rules;
- project-name grammar, exact container/network names, label checks, exact `compose.test.yaml` path check, and baseline fingerprint preservation;
- `docker compose down --volumes --remove-orphans` against only the proven project; and
- exact temporary-root parent/name validation before removal.

- [ ] **Step 2: Import the moved symbols into the hermetic test**

At the top of `scripts/commerce-operations.test.ts`, import:

```ts
import {
  assertFinancialHarnessProjectOwned,
  exactNewFinancialHarnessProject,
  exactNewFinancialHarnessStorageDirectory,
  financialWitnessHarnessTimeoutMs,
  financialWitnessTestTimeoutMs,
  ownerRestoreVerifierLauncher,
  restoreVerifierWitnessPath,
  runBoundedFinancialWitnessHarness,
  waitForFinancialWitnessHarnessClose,
  type FinancialHarnessDockerResource,
  type FinancialWitnessHarnessClose
} from './financial-restore-witness-harness';
```

Prune only Node imports made unused by the move. Keep `root`, `executeFile`, and `stripePreflightPath` in the test file because other hermetic tests still use them.

- [ ] **Step 3: Retarget source-shape assertions to the new owner**

In the catalog-contract test that currently reads `scripts/commerce-operations.test.ts`, also read:

```ts
const financialWitnessHarnessSource = await source(
  'scripts/financial-restore-witness-harness.ts'
);
```

Move assertions for `directNodeHarnessEnvironment`, timeout literals, bounded runner, timeout cleanup, `taskkill.exe`, Compose-down flags, storage-name grammar, and the `npm_execpath` guard to `financialWitnessHarnessSource`. Keep unrelated contract-test assertions on `contractTestSource`.

Retain unchanged:

- the fail-closed verifier-confinement test;
- the ambiguous-cleanup-target test;
- the process-tree timeout/termination test; and
- every other commerce/source-shape test.

- [ ] **Step 4: Remove only the active PostgreSQL test block**

Delete from `scripts/commerce-operations.test.ts` only the `it(...)` whose title is:

```text
executes schema-object, source-parity, deterministic-allocation, audit, payout, and chronology verifier witnesses in PostgreSQL
```

Do not delete the adjacent pure supervisor tests or executable-SQL tests.

- [ ] **Step 5: Create the service test with the unchanged witness assertion**

Use this complete file shape:

```ts
import { describe, expect, it } from 'vitest';
import {
  financialWitnessHarnessTimeoutMs,
  financialWitnessTestTimeoutMs,
  runBoundedFinancialWitnessHarness
} from '../../scripts/financial-restore-witness-harness';

describe('financial restore verifier service witness', () => {
  it(
    'executes schema-object, source-parity, deterministic-allocation, audit, payout, and chronology verifier witnesses in PostgreSQL',
    async () => {
      const result = await runBoundedFinancialWitnessHarness();
      const output = `${result.stdout}${result.stderr}`;
      expect(
        result.timedOut,
        `financial witness harness exceeded ${financialWitnessHarnessTimeoutMs}ms; ${
          result.cleanup ?? 'timeout cleanup was not attempted'
        }\n${output.slice(-20_000)}`
      ).toBe(false);
      expect(output).toContain(
        '[restore-verifier] schema-object, issue-identity, source-parity, deterministic-allocation, audit, classification, payout, replay-child, allocation-graph, refund-component, dispute-presentment, and combined-chronology witnesses passed'
      );
      expect(result.status).toBe(0);
    },
    financialWitnessTestTimeoutMs
  );
});
```

- [ ] **Step 6: Run the hermetic extraction GREEN before adding profile scripts**

```powershell
npx vitest run --config vitest.config.ts scripts/commerce-operations.test.ts --reporter=verbose
```

Expected: every hermetic source-shape, confinement, ownership, and timeout test passes without starting Docker. The new service file is not discovered by this focused command.

### Task 10: Add the explicit serial service profile and retain it in release verification

**Files:**

- Create: `vitest.service.config.ts`
- Modify: `vitest.config.ts`
- Modify: `package.json`
- Test: `scripts/test-profile-boundaries.test.ts`

- [ ] **Step 1: Make the default config explicitly hermetic**

Retain the current plugins and test defaults, adding only the explicit service exclusion:

```ts
export default defineConfig({
  plugins: [sveltekit()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['tests/service/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true
  }
});
```

- [ ] **Step 2: Add the one-test serial service config**

Create `vitest.service.config.ts` as:

```ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    environment: 'node',
    include: ['tests/service/financial-restore-witness.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    clearMocks: true,
    restoreMocks: true
  }
});
```

Do not modify `vitest.integration.config.ts`, Playwright configuration, service timeouts, or integration parallelism.

- [ ] **Step 3: Change only the package test-profile scripts and verify order**

Use these exact values:

```json
"test": "vitest run --config vitest.config.ts",
"test:unit": "vitest run --config vitest.config.ts",
"test:service": "vitest run --config vitest.service.config.ts",
"test:watch": "vitest --config vitest.config.ts",
"test:database": "npm run test:integration && npm run test:e2e",
"verify": "npm run check && npm run lint && npm run test:unit && npm run test:service && npm run test:database && npm run build"
```

Leave all existing raw/integration/E2E/upgrade scripts byte-equivalent. No dependency or lockfile change is required.

- [ ] **Step 4: Run the static profile GREEN**

```powershell
npm run test:unit -- scripts/test-profile-boundaries.test.ts --reporter=verbose
```

Expected: exact package commands, gate order, unit exclusion, one-test serial service inclusion, single active witness invocation, preserved supervisor safeguards, and unchanged existing database/browser commands all pass.

- [ ] **Step 5: Prove actual discovery without running tests**

```powershell
npx vitest list --config vitest.config.ts --filesOnly --staticParse
npx vitest list --config vitest.service.config.ts --filesOnly --staticParse
```

Expected: unit discovery includes the existing `src/**/*.test.ts` and `scripts/**/*.test.ts` set but not `tests/service/financial-restore-witness.test.ts`; service discovery prints exactly that one file.

- [ ] **Step 6: Prove all three default entrypoints stay service-free**

Run each service-freedom proof through its own fail-closed wrapper:

```powershell
Invoke-CheckpointAServiceCommand {
  npm test -- scripts/test-profile-boundaries.test.ts --reporter=verbose
}
Invoke-CheckpointAServiceCommand {
  npm run test:unit -- scripts/test-profile-boundaries.test.ts --reporter=verbose
}
Invoke-CheckpointAServiceCommand {
  npm run test:watch -- --run scripts/test-profile-boundaries.test.ts --reporter=verbose
}
```

Expected: all three wrappers exit zero; no command creates a container, network, volume, storage root, browser, or long-running child witness.

### Task 11: Document the profile boundary and run the service witness

**Files:**

- Modify: `README.md`
- Modify: `docs/database-and-workers.md`
- Test: `scripts/test-profile-boundaries.test.ts`
- Test: `scripts/commerce-operations.test.ts`
- Service test: `tests/service/financial-restore-witness.test.ts`

- [ ] **Step 1: Add documentation assertions and capture their RED**

Extend `scripts/test-profile-boundaries.test.ts` with:

```ts
const readme = source('README.md');
const databaseGuide = source('docs/database-and-workers.md');

it('documents the explicit service lane without folding it into test:database', () => {
  const qualityGates = readme.match(
    /Quality gates:[\s\S]*?```powershell\n([\s\S]*?)\n```/u
  )?.[1] ?? '';
  expect(qualityGates.indexOf('npm run test:service'))
    .toBeGreaterThan(qualityGates.indexOf('npm run test:unit'));
  expect(qualityGates.indexOf('npm run test:service'))
    .toBeLessThan(qualityGates.indexOf('npm run test:integration'));
  expect(databaseGuide).toContain(
    '`npm test`, `npm run test:unit`, and `npm run test:watch` are hermetic'
  );
  expect(databaseGuide).toContain('`npm run test:service`');
  expect(databaseGuide).toContain('does not include `npm run test:service`');
  expect(databaseGuide).toContain(
    'check -> lint -> unit -> service -> integration/E2E -> build'
  );
  expect(databaseGuide).toContain('npm_execpath');
  expect(databaseGuide).toContain('bounded supervisor');
});
```

Run:

```powershell
npm run test:unit -- scripts/test-profile-boundaries.test.ts --reporter=verbose
```

Expected RED: README lacks the service command and the database guide lacks the explicit boundary phrases. All earlier package/config/harness assertions remain green.

- [ ] **Step 2: Update the concise quality-gate list**

In `README.md`, add `npm run test:service` immediately after `npm run test:unit`. Do not change the Plan 6B status, migration tip, or production-closure text.

- [ ] **Step 3: Replace the tests paragraph with the explicit boundary**

In `docs/database-and-workers.md`, document:

- `npm test`, `npm run test:unit`, and `npm run test:watch` are hermetic/default and do not start Docker, PostgreSQL, browsers, network services, or the restore witness;
- `npm run test:service` runs the one Docker/PostgreSQL financial restore/commerce witness;
- that service witness retains its bounded supervisor, unique project/storage ownership, exact Compose-path/label checks, process-tree termination, and teardown absence proof;
- integration and E2E retain their existing uniquely named disposable environments;
- `npm run verify` executes check -> lint -> unit -> service -> integration/E2E -> build; and
- the official Windows service command is npm-driven because the direct-Node harness requires `npm_execpath`.

Include the exact sentence fragment “`npm run test:database` does not include `npm run test:service`” so the distinction is unambiguous and statically witnessed. Do not duplicate executable verifier logic in the runbook; the service lane is included explicitly by `verify`.

- [ ] **Step 4: Run all focused hermetic profile witnesses**

```powershell
npm run test:unit -- scripts/test-profile-boundaries.test.ts scripts/commerce-operations.test.ts scripts/process-secret-scope.test.ts scripts/financial-schema-preservation.test.ts --reporter=verbose
npm run check
npx eslint scripts/financial-restore-witness-harness.ts tests/service/financial-restore-witness.test.ts scripts/commerce-operations.test.ts scripts/test-profile-boundaries.test.ts vitest.config.ts vitest.service.config.ts
git diff --check
```

Expected: all focused tests, type/Svelte checks, lint, and diff checks pass without Docker activity.

- [ ] **Step 5: Run the moved service witness through its official command**

Run the official command alone through the fail-closed wrapper:

```powershell
Invoke-CheckpointAServiceCommand {
  npm run test:service -- --reporter=verbose
}
```

Expected: Vitest discovers exactly one test; the existing restore verifier reports the full schema-object/issue-identity/source-parity/deterministic-allocation/audit/classification/payout/replay-child/allocation-graph/refund-component/dispute-presentment/combined-chronology success marker; the wrapper exits zero before the existing timeout.

- [ ] **Step 6: Review and commit the test-profile split**

Review the move with rename-aware diff output and verify the supervisor was not weakened:

```powershell
git diff --find-renames -- scripts/financial-restore-witness-harness.ts scripts/commerce-operations.test.ts tests/service/financial-restore-witness.test.ts
git diff -- package.json vitest.config.ts vitest.service.config.ts scripts/test-profile-boundaries.test.ts README.md docs/database-and-workers.md
git diff --check
```

Then stage literal paths:

```powershell
git add package.json vitest.config.ts vitest.service.config.ts scripts/test-profile-boundaries.test.ts scripts/financial-restore-witness-harness.ts scripts/commerce-operations.test.ts tests/service/financial-restore-witness.test.ts README.md docs/database-and-workers.md
git diff --cached --check
git diff --cached --stat
git diff --cached
git commit -m "test: separate service-backed restore witness"
```

## Milestone E — checkpoint review and completion evidence

### Task 12: Run cross-boundary regression gates

**Files:** None unless a proven defect requires a focused fix.

- [ ] **Step 1: Run the complete hermetic unit profile and prove it stays hermetic**

Run the complete unit profile through the fail-closed wrapper so service freedom and the test exit are both proved:

```powershell
Invoke-CheckpointAServiceCommand { npm run test:unit }
```

Expected: the wrapper exits zero and no Docker/service resource appears. If it fails, rerun only the failed file(s); do not invoke the service witness while diagnosing a hermetic failure.

- [ ] **Step 2: Run type, lint, and build gates**

```powershell
npm run check
npm run lint
npm run build
git diff --check
```

Expected: all commands exit zero. The build remains production-maintenance-only and Stripe-disabled by existing configuration.

- [ ] **Step 3: Run the repository verification gate once**

After focused and hermetic gates are green, run the repository gate through the fail-closed wrapper:

```powershell
Invoke-CheckpointAServiceCommand { npm run verify }
```

Expected order is check, lint, hermetic unit, the one explicit restore witness, serial PostgreSQL integration, Playwright in its disposable project, then build. Every nested harness must complete its own exact absence proof before `verify` can advance to the next lane, and the outer wrapper exits zero.

- [ ] **Step 4: Run the applicable focused release profiles serially**

Run each command separately through a fresh wrapper invocation, waiting for its final exit before starting the next:

```powershell
Invoke-CheckpointAServiceCommand { npm run test:plan6b-upgrade }
Invoke-CheckpointAServiceCommand { npm run smoke:plan6b -- --stage 6b-ii }
Invoke-CheckpointAServiceCommand { npm run smoke:plan6b-fixture -- --stage 6b-ii }
```

Expected: the supported prior-schema fixture reaches migration `0014`; both current Plan 6B smoke profiles pass against the unchanged production-maintenance/Stripe-disabled contract; every wrapper exits zero.

Fresh coordinated checkpoint capture and distinct-engine rehearsal are deferred at Checkpoint A because this checkpoint changes no migration, catalog, backup format, executable restore contract, container topology, or production activation input. The already accepted Plan 6B evidence remains the recovery baseline, while Plan 7A's final Checkpoint D candidate must rerun capture and rehearsal with operator-supplied distinct-engine coordinates as required by design Section 15.4. Do not call Checkpoint A a complete Plan 7A release candidate.

- [ ] **Step 5: Prove scope containment from the final diff**

```powershell
git status --short
git log --oneline --decorate 1c330693b67a1aa34c413bd8d2ec23ff8628236e..HEAD
git diff --stat 1c330693b67a1aa34c413bd8d2ec23ff8628236e..HEAD
git diff --name-only 1c330693b67a1aa34c413bd8d2ec23ff8628236e..HEAD
if (Get-ChildItem -LiteralPath drizzle -Filter '0015*.sql') {
  throw 'Unexpected migration 0015 in Checkpoint A.'
}
rg -n "APPLICATION_MODE.*live|test:service|projection-authority|security/rate-limit" drizzle src scripts tests package.json
rg -n "test:service|projection-authority|security/rate-limit" . -g 'vitest*.config.ts'
```

Expected: no migration `0015`, activation, new namespace, or new route exists. The only intended new boundaries are the projection leaf, security rate-limit core/adapter, service harness/profile/test, and static contracts/docs.

### Task 13: Request independent review and close Checkpoint A

**Files:**

- Modify after all evidence passes: `docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md`

- [ ] **Step 1: Request an independent code review**

Use `superpowers:requesting-code-review`. Give the reviewer the approved spec, this plan, base commit, final commit, and verification output. Ask them to inspect:

- unique projection-authority ownership and absence of replay cycles;
- byte/behavior preservation of SQL, parser rules, transaction ownership, and lock order;
- rate-limit dependency direction, SQL/calculation preservation, safe error mapping, and unknown-error propagation;
- exact unit/service discovery, no Docker path from default/watch scripts, and continued service inclusion in `verify`;
- bounded supervisor ownership, termination, and cleanup preservation;
- no schema/migration/config/route/namespace/activation expansion; and
- documentation accuracy.

The reviewer must not start service-backed suites in parallel with the primary agent. For every accepted finding, first write a focused RED where applicable, implement the smallest correction, rerun focused GREEN/check/lint/diff checks, stage literal paths, inspect the cached diff, and commit with `fix: address Plan 7A checkpoint A review`. Then rerun the complete Task 12 sequence—including `verify`, upgrade, and both smoke profiles—against the new immutable HEAD and have the reviewer inspect that exact HEAD again. Continue until no accepted finding remains; a review fix may not bypass fresh full evidence.

- [ ] **Step 2: Record Checkpoint A completion only after review and fresh evidence**

Change the design header from:

```text
**Implementation status:** Not started
```

to:

```text
**Implementation status:** Checkpoint A complete; Checkpoints B-D not started
```

Do not mark Plan 7A complete and do not alter the launch status.

- [ ] **Step 3: Commit the evidence/status update**

```powershell
git add docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md
git diff --cached --check
git diff --cached
git commit -m "docs: record Plan 7A checkpoint A completion"
git status --short --branch
```

Expected: the worktree is clean. The history contains at least the ordered implementation spine below plus any explicit accepted-review fix commits; do not rewrite accurate review history merely to force an exact commit count.

- [ ] **Step 4: Use verification-before-completion and finish the branch**

Use `superpowers:verification-before-completion` before claiming success, then `superpowers:finishing-a-development-branch`. Report exact fresh command results, review disposition, final commit IDs, and any pre-existing npm audit advisories separately from implementation correctness. Integrate or push only through the user-approved branch workflow; never infer production deployment or activation authority from merge permission.

## Expected commit sequence

```text
test: normalize source-shape line endings
refactor: extract financial projection authority leaf
refactor: relocate shared rate limit service
test: separate service-backed restore witness
docs: record Plan 7A checkpoint A completion
```

The plan document itself is committed before implementation. The list above is the minimum ordered spine, not a prohibition on explicit accepted-review fix commits. Do not squash implementation tasks during development; their focused evidence and review boundaries are intentional. A later user-approved merge may preserve or combine commits according to repository policy, but must not alter the verified tree.

## Checkpoint A acceptance checklist

- [ ] `projection-authority.ts` is the sole production owner of the public type, private canonical parser, and three public functions; `rebase.ts` neither declares nor re-exports them.
- [ ] The leaf has exactly the three approved module dependencies, all eight production consumers import it directly, the four direct-consumer tests mock/import it, and the integration lock helper comes from it.
- [ ] Ledger, refund, and dispute no longer form direct reciprocal `rebase` dependencies.
- [ ] Projection SQL, parsing, safe errors, transaction reuse, and lock order are unchanged under unit and PostgreSQL witnesses.
- [ ] `security/rate-limit.ts` imports no `$lib/server/commerce/*` module and has no commerce service/error dependency; its schema-barrel import remains allowed, and it owns hashing, validation, cleanup, and SQL.
- [ ] Existing callers retain route-visible behavior through the commerce adapter; only the fixed, non-input-bearing `InvalidRateLimitInputError` is mapped, it is retained only as `cause`, and the adapter does not export it.
- [ ] Rate-limit SHA/HMAC digests, actor branches, schema, namespaces, configuration, SQL/upsert target, `maxAttempts + 1` saturation, windows, retry-after calculation, cleanup, and concurrency behavior are unchanged.
- [ ] Default/test:unit/test:watch are hermetic and cannot invoke the service witness.
- [ ] `test:service` discovers exactly one serial bounded restore witness.
- [ ] `verify` retains the service witness between unit and database/browser lanes.
- [ ] The bounded supervisor and exact ownership/cleanup safeguards remain present and tested.
- [ ] No migration, production activation, logging, heartbeat, job-operations, release-evidence, or unrelated refactor landed.
- [ ] Focused tests, full unit, check, lint, build, serialized service/integration/browser/upgrade/smoke gates, and independent review are green.
- [ ] Plan 7A remains incomplete overall; Checkpoints B-D remain explicitly unstarted.
