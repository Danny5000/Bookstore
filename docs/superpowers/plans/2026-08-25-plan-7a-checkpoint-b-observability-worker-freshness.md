# Plan 7A Checkpoint B: Observability and Worker Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Plan 7A Checkpoint B by adding exact versioned structured logging and diagnostic correlation at the web, worker, and job-runner boundaries, and by replacing startup-only worker readiness with an atomic per-slot freshness heartbeat, without adding monitoring, alert delivery, database changes, or production activation.

**Architecture:** Dependency-light observability leaf modules own strict event contracts, safe-error reduction, NDJSON serialization, and `AsyncLocalStorage` diagnostic context. SvelteKit ingress establishes one correlation context before maintenance and authentication, while a narrow worker observer translates runner lifecycle signals into structured events and heartbeat progress without exposing payloads or capabilities. A single in-memory heartbeat supervisor atomically publishes one versioned record for every configured slot; a separate stateless health executable validates that record without reading or requiring database credentials.

**Tech Stack:** Node.js 26.7.x, npm 11.19.x, SvelteKit 2.70.x, Svelte 5.56.x, TypeScript 6.0.x, PostgreSQL 18.4, Drizzle ORM 0.45.2, Vitest 4.1.x, Docker Compose, and ESLint 10.x. No logging, tracing, metrics, or transport dependency is added.

---

## Source of truth, approved base, and checkpoint boundary

The authoritative design is `docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md`, especially Sections 5.1, 7, 9, 13-16, and the Checkpoint B acceptance clauses in Section 17. The approved Plan 7A design commit is `1c330693b67a1aa34c413bd8d2ec23ff8628236e`. The required implementation base is `db3f48d92b759685070988daf9602d2c00ad0ca3`, where Checkpoint A is complete, Checkpoints B-D are unstarted, the migration chain ends at `0014`, and production remains maintenance-only with Stripe disabled.

Before implementation, create or reuse an isolated worktree from `db3f48d92b759685070988daf9602d2c00ad0ca3`. If `main` has advanced, prove both source commits remain ancestors and re-read the approved design before rebasing. Do not silently reinterpret Checkpoint B from a newer document.

Checkpoint B owns exactly:

1. the version-1 structured-event contracts, strict logger, safe-error reducer, and diagnostic context;
2. one canonical web request correlation identity and the exact HTTP lifecycle events;
3. exact worker and job lifecycle events, including actual retry disposition and lease-loss outcomes;
4. a version-1, one-writer, atomic, per-slot worker-heartbeat record;
5. a stateless worker-health executable and worker-only heartbeat configuration;
6. compatibility updates to development, E2E, Plan 6B smoke, and fixture health consumers; and
7. operator documentation for the implemented logging and worker-freshness contracts.

Checkpoint B does **not** add the Checkpoint C job catalog, policy table, migration `0015`, operations DTOs, administrator commands, grants, routes, retry buttons, or navigation. It does not add Checkpoint D's shared owned-Compose lifecycle, release-candidate coordinator, candidate evidence, `smoke.*` emission, or activation input. It adds no monitoring storage, metrics endpoint, dashboard, SLO, alert rule, alert delivery, remote log transport, Caddy access logging, backup schedule, off-host transfer, hardening, capacity tuning, CI workflow, new rate limit, production `live` mode, or Stripe activation.

## Resolved design decisions

These decisions remove ambiguities without expanding the approved scope:

1. **Smoke split:** Checkpoint B implements and exhaustively tests all Section 7.4 event schemas, including the reserved smoke schemas, so there is one encoder and vocabulary. Only `web` and `worker` producers are wired now. Checkpoint D owns `smoke.*` emission, candidate identity, stage/evidence orchestration, and adapting smoke output. Checkpoint B may change existing smoke scripts only where they must invoke the new worker-health executable or rehearse its failure behavior.
2. **HTTP outcome matrix:** A canonical response with status 100-399 emits `http.request.completed`. Status 400-499 emits `http.request.rejected` with a fixed lowercase status-family code. A returned 500-599 response emits `http.request.failed` with `http_server_error`. The intentional maintenance 503 emits `http.request.rejected` with `maintenance_mode`. An exception escaping the request operation emits `http.request.failed` with status 500 and `unexpected_failure`, then the original exception is rethrown.
3. **Safe log codes:** Existing API, audit, database, and domain codes remain unchanged. Logging uses an explicit lowercase allowlisted vocabulary. No logger reflects an arbitrary `.code`, `.safeCode`, `.name`, or `.message` from an unknown object.
4. **Safe-error shape:** The richer safe-error object is internal and exact: class, code, operation, outcome, correlation identity when applicable, and one optional bounded primitive public state. Each event emits only the fields allowlisted by its Section 7.4 schema; for current failure events that means only the safe `code` plus the event's other required fields.
5. **Request correlation:** `x-request-id` is accepted only when the original header value matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$`. It is not trimmed or echoed. Missing or invalid input becomes a canonical lowercase UUID before maintenance or authentication. `AsyncLocalStorage` carries that diagnostic value; domain and audit calls still receive a string explicitly. Existing route helpers source that explicit string from the active request context and fall back to the same validator only in direct unit invocation.
6. **HTTP route safety:** The logged route is `event.route.id` only when it is a nonempty string of at most 200 characters. Otherwise it is the fixed value `unmatched`. `event.url`, `pathname`, query text, params, headers, and response bodies are never inspected for logging.
7. **Job diagnostic metadata:** Checkpoint B generates one lowercase UUID for each claimed attempt and uses the claimed job UUID as a separate `jobId`. It defines an injected strict metadata-resolver seam for a future registered parser, but the production worker does not inspect arbitrary payloads or create a second job catalog in Checkpoint B. Consequently `generation` is omitted until a registered resolver returns a positive signed-int32 value; Checkpoint C's exhaustive catalog will own that production mapping.
8. **Retry evidence:** The existing boolean `JobRepository.fail` remains available to all current callers. A new runner-only settlement method returns `{ applied: true, retryScheduled }` or `{ applied: false }` from the same transaction so `job.failed.retryScheduled` reflects the committed pending/failed disposition, including a pre-existing rerun request. No SQL predicate, delay, attempt, capability, or lock order changes.
9. **Worker identity:** Database lease ownership remains exactly the current base worker ID for one slot and `${workerId}:${slotId}` for multiple slots. Logs and heartbeat records always use the base process `workerId` plus a numeric zero-based `slotId`; they never replace or reinterpret the repository lease owner.
10. **Progress semantics:** A successful empty or claimed repository poll advances both last-successful-poll and progress. A successful lease renewal or terminal repository settlement advances progress. Entering a poll, waiting in a handler, a poll-hook failure by itself, claim failure, failed renewal, lost lease, or failed terminal settlement does not advance progress. Preserve the current poll-hook failure behavior: emit the existing bounded static console line, continue to `claimNext` when the signal remains active, and let only that subsequent successful repository poll advance freshness.
11. **Heartbeat failure policy:** Failure to encode, write, sync, rename, or continue publishing the heartbeat emits one `worker.heartbeat_failed` event, aborts the worker process, and exits nonzero after bounded cleanup. Docker's restart policy can then replace it. Merely continuing an unhealthy worker is rejected because Docker does not restart a container solely because it is unhealthy.
12. **Configuration compatibility:** `WORKER_READY_FILE` retains its name and path ownership because integration control and Compose already depend on it. Its contents change from an opaque marker to the version-1 heartbeat. `WORKER_HEARTBEAT_INTERVAL_MS` and `WORKER_HEARTBEAT_MAX_AGE_MS` are read only by the worker-scoped loader and the health-only loader; web and database-only loaders neither read nor retain them.

## Target dependency and runtime topology

```text
web request
  -> observability/context (validate or generate correlation ID; AsyncLocalStorage)
  -> hooks.server request operation
  -> observability/http-lifecycle (safe route/method/status/duration)
  -> observability/logger -> one NDJSON line on stdout/stderr

worker process
  -> observability/logger (worker lifecycle)
  -> jobs/runner -> jobs/runner-observer
       |                 |-> job lifecycle NDJSON
       |                 `-> per-slot progress signals
       `-> unchanged repository lease owner and handler calls
                              |
                              v
                  worker/heartbeat-supervisor
                    -> atomic same-directory replace
                    -> WORKER_READY_FILE version-1 JSON

Docker health / test harness / smoke probe
  -> build/services/worker-health.js
  -> config/worker (six nonsecret health settings only)
  -> worker/health-check -> worker/heartbeat-contract
  -> no database, storage, SMTP, Stripe, route, or secret dependency
```

Forbidden reverse dependencies are `observability/* -> routes|worker entrypoint|jobs repository|commerce|financial`, `worker/heartbeat-contract -> config|database|storage|runner`, and `jobs/runner -> worker entrypoint|Compose|smoke scripts`. No logger input type may contain job payloads, deduplication keys, lease capabilities, request objects, URLs, headers, exceptions, or arbitrary records.

## Execution and evidence discipline

- Work in task order. Use RED -> smallest implementation -> focused GREEN -> self-review -> literal-path commit for each change.
- A task without a commit step is an intermediate phase, not permission to commit a broken tree or duplicate authority.
- Run hermetic tests freely. Serialize every Docker, PostgreSQL, Mailpit, Playwright, restore, upgrade, and broad `verify` command; no parallel agent may start a service-backed command.
- Do not use live sockets, Docker, PostgreSQL, browser processes, or timers that depend on wall-clock waiting in unit tests. Inject clocks, UUID sources, sinks, sleeps, filesystem operations, runner observers, and command runtimes.
- Before every service-backed command, snapshot existing Compose-labeled containers, networks, volumes, and `pale-orbit-test-storage-*` directories. After the command, prove the exact harness-owned project and temporary root are absent and the baseline is otherwise unchanged. Never remove an unknown or pre-existing resource.
- Do not run a broad suite to diagnose a focused RED. Capture the first failing assertion, correct the demonstrated cause, and rerun the same bounded command.
- Use `apply_patch` for hand edits. Do not run Drizzle Kit: Checkpoint B adds no migration, schema object, role, grant, or database snapshot change.
- Preserve user changes in a dirty worktree. Every path-limited Git command in this plan uses `git --literal-pathspecs`; do not drop that option for SvelteKit `[param]` route paths. Stage literal paths, run `git diff --cached --check`, inspect the staged diff, and commit at each boundary. Never use `git add .`.
- A logger or observer failure may fail strict tests, but the production logger must never throw into a domain operation. Startup and heartbeat publication remain fail-closed process boundaries.
- Never weaken Caddy's sensitive-URI policy or add a response `x-request-id` header.

Use this exact fail-closed, read-only wrapper in the same PowerShell session for every service-backed command. It validates Docker reads, preserves the target command's exit status, always captures the post-command state, compares all Compose-labeled resources and harness storage roots, and never deletes anything:

```powershell
function Get-CheckpointBServiceBaseline {
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

function Invoke-CheckpointBServiceCommand {
  param(
    [Parameter(Mandatory)]
    [scriptblock]$Command
  )

  $before = Get-CheckpointBServiceBaseline | ConvertTo-Json -Compress -Depth 4
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
    $after = Get-CheckpointBServiceBaseline | ConvertTo-Json -Compress -Depth 4
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
    throw "Checkpoint B service wrapper failed: $($failures -join '; ')"
  }
}
```

Invoke exactly one native command per wrapper, for example `Invoke-CheckpointBServiceCommand { npm run test:integration }`. If it fails, inspect exact new labels and paths and let only the owning harness remove resources it proves it owns. Do not turn the wrapper into cleanup logic and do not start a second service command until the discrepancy is resolved.

## File ownership map

### Structured logging and context

- `src/lib/server/observability/contracts.ts` owns schema version 1, exact event-field types, event/service compatibility, primitive validators, fixed severity/outcome/sink selection, and reconstruction of validated primitive-only records.
- `src/lib/server/observability/logger.ts` owns timestamp injection, envelope ordering, NDJSON serialization, stdout/stderr sinks, strict-mode failures, and the one nonrecursive production `logging.failure` fallback.
- `src/lib/server/observability/safe-error.ts` owns the exact internal safe-error object and the `unexpected_failure` reduction. It never reflects raw unknown properties.
- `src/lib/server/observability/context.ts` is the sole owner of `x-request-id` validation, lowercase UUID generation, and diagnostic `AsyncLocalStorage`.
- `src/lib/server/observability/http-lifecycle.ts` owns safe method/route normalization, the exact response-status matrix, integer duration calculation, and HTTP event emission.
- Adjacent tests exhaustively cover the contracts without starting a network service.

### Web adoption

- `src/hooks.server.ts` establishes context before maintenance and authentication, preserves the current session/actor flow, canonicalizes bodyless redirects before classifying the response, and rethrows the original error after safe failure emission.
- Existing request-to-audit helpers import `correlationIdForRequest` from the new context owner instead of independently parsing the header or generating a UUID.
- `scripts/observability-boundaries.test.ts` proves sole header ownership, migrated-boundary source shape, forbidden-field absence, and no Caddy policy regression.

### Job and worker events

- `src/lib/server/jobs/types.ts` adds the exact runner-only failure-settlement result while retaining the public boolean failure method.
- `src/lib/server/jobs/repository.ts` derives actual retry scheduling in the existing failure transaction and preserves the boolean adapter for every historical caller.
- `src/lib/server/jobs/runner-observer.ts` defines only safe job and slot events and adapts them to the worker logger and heartbeat supervisor.
- `src/lib/server/jobs/runner.ts` creates the per-attempt child diagnostic context and emits observer signals around the existing poll, claim, lease, handler, complete, and fail paths without changing their order or authority.
- `src/lib/server/worker/process-runtime.ts` owns testable worker started/ready/stopping/stopped/failed sequencing, orderly signal cleanup, and a bounded fatal-failure cleanup path; `src/worker.ts` remains the composition root for handlers, database, storage, SMTP, Stripe, signals, and the exact existing lease identity.

### Worker freshness

- `src/lib/server/worker/heartbeat-contract.ts` owns the exact version-1 record, canonical JSON parser, and stateless freshness decision.
- `src/lib/server/worker/heartbeat-supervisor.ts` owns in-memory per-slot state, serialized publication, monotonic time/sequence, same-directory atomic replacement, first-publication readiness, failure propagation, and file cleanup.
- `src/lib/server/worker/health-check.ts` owns bounded open-handle reading and fixed success/failure behavior; `src/worker-health.ts` loads only the health-specific nonsecret settings and sets the process exit code without printing record contents.
- `vite.services.config.ts` builds `build/services/worker-health.js`; `package.json` exposes the source entry only for host/development use.

### Configuration

- `src/lib/server/config/worker.ts` owns the six-setting, dependency-light worker-health parser and `WorkerProcessConfig`.
- `src/lib/server/config/load.ts` combines that leaf with the existing common application configuration only for the worker process.
- Web, general application, database-only, migration, bootstrap, and cleanup loaders do not read or retain worker-only settings.

### Runtime consumers and documentation

- `compose.dev.yaml` and `compose.prod.yaml` set the two worker-only timing values and invoke the source/built health executable instead of testing file size.
- `scripts/with-test-database.ts` waits for a valid fresh record and uses 1,000/4,000 ms heartbeat values with its 5,000 ms lease.
- `scripts/plan6b-production-smoke.ts` verifies the live built health executable and production-image stale/missing-slot rejection without mutating the live heartbeat.
- `scripts/plan6b-fixture-runtime-probe.ts` renders and directly invokes the built health executable in its generated Compose runtime.
- Existing static tests for process scope, Compose, Playwright, fixture smoke, and storage isolation are updated rather than bypassed.
- `.env.example`, `README.md`, `docs/database-and-workers.md`, and `docs/runtime-environments.md` document exact values, privacy, lifecycle, and the fact that monitoring and activation remain deferred.

## Non-negotiable preserved behavior

- The migration chain remains exactly `0014`; there is no schema, snapshot, role, group, ACL, default-ACL, routine, trigger, or restore-contract change.
- The four database principals remain pairwise distinct. No process receives owner credentials, and no web/worker/storage-cleanup privilege changes.
- Job selection SQL, `FOR UPDATE SKIP LOCKED`, attempt increments, retry delays, rerun requests, financial capability checks, capability transaction settings, advisory locks, lease owner strings, handler order, terminal writes, and persisted safe error text remain unchanged.
- No log contains raw exceptions, names, messages, stacks, SQL, URLs, paths derived from requests, headers, cookies, secrets, `_FILE` paths, provider bodies, webhook signatures, job/outbox payloads, deduplication keys, email addresses, action URLs, reset tokens, payment/address data, storage keys, credential hashes, or financial-administrator capabilities.
- Correlation is diagnostic only. It never becomes an authorization, idempotency, locking, command eligibility, job identity, deduplication, provider, or database-write input except where an existing domain/audit API already explicitly accepts a correlation string.
- `x-request-id` is not echoed. Invalid input is replaced rather than logged. Caddy access logging remains disabled and its sensitive URI deletion policy remains intact.
- Logging failure never changes a returned response, committed transaction, job settlement, or handler result. Only existing startup validation and the new heartbeat publisher may terminate their owning process fail-closed.
- The heartbeat record contains only version, base worker ID, process start, publication time, sequence, configured slots, and exact per-slot safe state/timestamps. It contains no host path, PID as a separate field, database identity, job identity, payload, error, provider, correlation, or secret.
- Health reads no database/storage/SMTP/Stripe/auth configuration and makes no network request. A malformed, oversized, missing, stale, future-dated, wrong-slot-count, duplicate-slot, or missing-slot record fails.
- The heartbeat publisher is the only file writer. Slots report in memory only. File replacement is same-directory and atomic; a failed partial write is never accepted as health evidence.
- Successful heartbeat publication is not logged each interval. No alert, monitor store, public health expansion, or metrics endpoint is added.
- Existing Plan 6B smoke remains maintenance-only, Stripe-disabled, provider-network-free in the base profile, exactly owned, and exactly cleaned. Its human output is not converted to Checkpoint D evidence here.
- Unit/watch remain hermetic. Production remains `APPLICATION_MODE=maintenance`; `live` remains rejected and the base Compose stack remains Stripe-disabled.

## Milestone A — establish the exact handoff

### Task 1: Verify the approved Checkpoint A base and preserve the planning boundary

**Files:** None.

- [ ] **Step 1: Confirm the isolated worktree, ancestry, and approved design**

```powershell
git status --short --branch
git rev-parse HEAD
git merge-base --is-ancestor db3f48d92b759685070988daf9602d2c00ad0ca3 HEAD
if ($LASTEXITCODE -ne 0) { throw 'The accepted Checkpoint A commit is not an ancestor.' }
git --literal-pathspecs ls-files --error-unmatch -- docs/superpowers/plans/2026-08-25-plan-7a-checkpoint-b-observability-worker-freshness.md
if ($LASTEXITCODE -ne 0) { throw 'The reviewed Checkpoint B plan is not committed.' }
git merge-base --is-ancestor 1c330693b67a1aa34c413bd8d2ec23ff8628236e HEAD
if ($LASTEXITCODE -ne 0) { throw 'The approved Plan 7A design is not an ancestor.' }
if (-not (Select-String `
  -Path docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md `
  -Pattern '^\*\*Design status:\*\* Approved$' `
  -Quiet)) {
  throw 'Plan 7A design is not approved.'
}
if (-not (Select-String `
  -Path docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md `
  -Pattern '^\*\*Implementation status:\*\* Checkpoint A complete; Checkpoints B-D not started$' `
  -Quiet)) {
  throw 'The required Checkpoint A completion status is absent.'
}
git diff --check
```

Expected: the feature worktree is clean, `db3f48d92b759685070988daf9602d2c00ad0ca3` is an ancestor of the plan-bearing implementation HEAD, both design assertions pass, and the diff check exits zero. Record the plan commit as the handoff HEAD; do not change the functional base silently.

- [ ] **Step 2: Record the baseline toolchain and hermetic result**

```powershell
node --version
npm --version
npm ci
npm run test:unit
```

Expected: Node is `v26.7.x`, npm is `11.19.x`, dependency installation succeeds without modifying tracked files, and the accepted baseline reports 234 passing unit files and 3,407 passing tests. Treat the existing npm audit advisory count as dependency metadata, not as authorization to run `npm audit fix` or broaden this checkpoint.

- [ ] **Step 3: Prove the database and launch boundary before any edits**

```powershell
$migration = Get-ChildItem -LiteralPath drizzle -Filter '*.sql' |
  Sort-Object Name |
  Select-Object -Last 1 -ExpandProperty BaseName
if ($migration -notmatch '^0014') { throw "Unexpected migration head: $migration" }
if (Get-ChildItem -LiteralPath drizzle -Filter '0015*.sql') {
  throw 'Checkpoint B must not contain migration 0015.'
}
rg -n "APPLICATION_MODE|STRIPE_ENABLED|STRIPE_LIVE_MODE" compose.prod.yaml .env.example
```

Expected: the migration head is `0014`, no `0015` file exists, and production remains maintenance-only with Stripe disabled. Do not commit a Task 1 change.

## Milestone B — define the safe structured-record boundary

### Task 2: Implement exact event contracts and safe-error reduction

**Files:**

- Create: `src/lib/server/observability/contracts.ts`
- Create: `src/lib/server/observability/contracts.test.ts`
- Create: `src/lib/server/observability/safe-error.ts`
- Create: `src/lib/server/observability/safe-error.test.ts`

- [ ] **Step 1: Write the event-contract RED**

Create table-driven tests for every one of these caller-visible events and no others:

```text
web:
  http.request.completed
  http.request.rejected
  http.request.failed

worker:
  worker.started
  worker.ready
  worker.stopping
  worker.stopped
  worker.failed
  job.claimed
  job.succeeded
  job.failed
  job.lease_lost
  worker.heartbeat_failed

registered smoke producer only:
  smoke.stage.started
  smoke.stage.succeeded
  smoke.stage.failed
  smoke.cleanup.succeeded
  smoke.cleanup.failed
  smoke.run.succeeded
  smoke.run.failed
```

The tests must assert the exact Section 7.4 required and optional keys, fixed service compatibility, fixed outcome, fixed sink, and fixed severity, including `job.failed` being `warn` only when `retryScheduled=true` and `error` otherwise. Assert that `logging.failure` is reserved for logger internals and cannot be supplied through the public event union.

For every primitive class, exercise both valid edges and invalid neighbors:

- token `^[a-z][a-z0-9._-]{0,99}$` for event vocabulary, safe codes, job kinds, profile, and stage;
- canonical lowercase UUID for documented UUID fields;
- correlation `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$`;
- worker ID `^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`;
- method `^[A-Z]{1,16}$`, route length 1-200, HTTP status 100-599;
- nonnegative signed-int32 slot and cleanup counts;
- positive signed-int32 attempt, maximum-attempt, configured-slot, generation, and heartbeat sequence values;
- integer duration 0-86,400,000; run ID `^[a-f0-9]{16}$`; and lowercase 64-character SHA-256 evidence fingerprints.

Reject missing keys, every extra key, `null`, arrays, nested values, boxed primitives, nonintegers, `NaN`, infinities, unsafe integers, accessors, and a proxy whose reflection trap throws. Include privacy canaries as undeclared keys and values: `payload`, `deduplicationKey`, `financialAdminLeaseCapability`, `url`, `headers`, `cookie`, `stack`, `message`, `secret`, and `customer@example.test`.

Run:

```powershell
npx vitest run src/lib/server/observability/contracts.test.ts --reporter=verbose
```

Expected RED: the file is discovered and fails only because `contracts.ts` and its exact validators/registry do not exist.

- [ ] **Step 2: Add the exact typed event union and registry**

Implement a discriminated caller-input union that excludes envelope fields and `logging.failure`. The logger will be generic over this fixed service type:

```ts
export type CorrelationId = string & {
  readonly __correlationId: unique symbol;
};

export type SafeCode<T extends string = string> = T & {
  readonly __safeCode: unique symbol;
};

export type StructuredLogService =
  | 'web'
  | 'worker'
  | 'plan6b-production-smoke'
  | 'plan6b-fixture-runtime-probe'
  | 'plan7a-release-candidate';

export type StructuredEventInputFor<S extends StructuredLogService> =
  S extends 'web'
    ? WebEventInput
    : S extends 'worker'
      ? WorkerEventInput
      : SmokeEventInput;

export interface ValidatedStructuredRecord {
  readonly record: Readonly<Record<string, string | number | boolean>>;
  readonly sink: 'stdout' | 'stderr';
}

export function validateStructuredEvent<S extends StructuredLogService>(
  service: S,
  timestamp: string,
  input: StructuredEventInputFor<S>
): ValidatedStructuredRecord;
```

`contracts.ts` owns these two branded primitive types and dependency-free grammar validators before `safe-error.ts` or `context.ts` exists. `context.ts` later owns header reading/generation and imports the correlation primitive; it does not duplicate the grammar. Require log timestamps supplied to `validateStructuredEvent` to equal their finite `Date.toISOString()` round trip.

Every event `code` property uses a closed branded alias such as `SafeCode<'invalid_request' | 'unexpected_failure'>`, never the open `SafeCode<string>` type. Define the exact HTTP, worker lifecycle, worker heartbeat, job-failure, job-lease-loss, and smoke code aliases next to their event inputs. Tests must reject a token that satisfies the lowercase grammar but is absent from that event's finite allowlist. For the reserved Checkpoint B smoke schemas, all three failure events use exactly `SafeCode<'required_stage_failed' | 'timeout' | 'interrupted' | 'ownership_mismatch' | 'configuration_mismatch' | 'cleanup_failed' | 'unexpected_failure'>`, derived from design Section 10.2. Checkpoint D may narrow these by event or extend them only by changing and reviewing this sole registry.

Construct `record` anew in this exact insertion order: `version`, `timestamp`, `severity`, `service`, `event`, `outcome`, followed by each event's required keys in the Section 7.4 table order and then its one allowed optional `generation` or `workerId` when present. Do not spread caller input. Do not accept caller-selected version, timestamp, severity, service, outcome, or sink.

The registry must encode all 20 caller-visible events now, including smoke contracts, plus the one fixed internal `logging.failure` fallback. Production wiring remains limited to `web` and `worker` in this checkpoint. The three smoke logger services are a closed union; no shared helper accepts an arbitrary service string.

- [ ] **Step 3: Write the safe-error RED**

Test the exact internal, nonserialized boundary:

```ts
export type SafeErrorClass =
  | 'configuration'
  | 'dependency'
  | 'request'
  | 'job'
  | 'heartbeat'
  | 'shutdown'
  | 'unexpected';

export type SafeErrorOperation =
  | 'http.request'
  | 'worker.startup'
  | 'worker.runtime'
  | 'worker.heartbeat'
  | 'worker.shutdown'
  | 'job.claim'
  | 'job.poll'
  | 'job.handler'
  | 'job.completion'
  | 'job.failure_transition'
  | 'job.lease_renewal';

export interface SafePublicState {
  readonly name: string;
  readonly value: string | number | boolean;
}

export interface SafeDiagnosticError<C extends string = string> {
  readonly class: SafeErrorClass;
  readonly code: SafeCode<C>;
  readonly operation: SafeErrorOperation;
  readonly outcome: 'denied' | 'failed';
  readonly correlationId?: CorrelationId;
  readonly publicState?: SafePublicState;
}
```

Require public-state names to use the safe-token grammar, public string values to be at most 100 characters, numbers to be signed 32-bit integers, and no optional key to be present with `undefined`. Test trusted constructor validation, registered `instanceof` matcher mapping, matcher throw, arbitrary `Error`, string, plain object, object with hostile getters, proxy, forged `.code`/`.safeCode`, and nested causes. Unknown or unsafe cases must yield the fixed `unexpected` / `unexpected_failure` descriptor without copying any unknown value.

Run:

```powershell
npx vitest run src/lib/server/observability/safe-error.test.ts --reporter=verbose
```

Expected RED: only the missing reducer and validators fail.

- [ ] **Step 4: Implement trusted safe-error construction and unknown reduction**

Expose only trusted constructors and matcher results:

```ts
export type SafeErrorMatcher<C extends string = string> = (
  cause: unknown
) => SafeDiagnosticError<C> | undefined;

export function defineSafeCode<const C extends string>(value: C): SafeCode<C>;

export function createSafeDiagnosticError<const C extends string>(
  input: SafeDiagnosticError<C>
): SafeDiagnosticError<C>;

export function reduceSafeError<const C extends string = never>(
  cause: unknown,
  options: {
    readonly operation: SafeErrorOperation;
    readonly correlationId?: CorrelationId;
    readonly matchers?: readonly SafeErrorMatcher<C>[];
  }
): SafeDiagnosticError<C | 'unexpected_failure'>;
```

`reduceSafeError` may call only the supplied fixed matchers. It catches matcher failures, validates the returned descriptor from scratch, and otherwise creates `class='unexpected'`, `code='unexpected_failure'`, the caller's fixed operation, `outcome='failed'`, and the already-normalized optional correlation. Its generic result preserves the exact matcher-code union plus `unexpected_failure`, so a boundary can project `.code` into its matching closed event union without widening that event to every grammar-valid token. It never reads arbitrary properties from `cause`; specifically, it must not reflect `.code`, `.safeCode`, `.name`, `.message`, `.stack`, or `.cause`.

- [ ] **Step 5: Run focused GREEN, type, lint, and diff checks**

```powershell
npx vitest run src/lib/server/observability/contracts.test.ts src/lib/server/observability/safe-error.test.ts --reporter=verbose
npm run check
npx eslint src/lib/server/observability/contracts.ts src/lib/server/observability/contracts.test.ts src/lib/server/observability/safe-error.ts src/lib/server/observability/safe-error.test.ts
git diff --check
```

Expected: every focused case passes, Svelte/TypeScript checks pass, lint exits zero, and there is no whitespace error.

- [ ] **Step 6: Review and commit the structured contract**

```powershell
git --literal-pathspecs diff -- src/lib/server/observability/contracts.ts src/lib/server/observability/contracts.test.ts src/lib/server/observability/safe-error.ts src/lib/server/observability/safe-error.test.ts
git --literal-pathspecs add -- src/lib/server/observability/contracts.ts src/lib/server/observability/contracts.test.ts src/lib/server/observability/safe-error.ts src/lib/server/observability/safe-error.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: add safe structured event contracts"
```

### Task 3: Implement the strict NDJSON logger and production fallback

**Files:**

- Create: `src/lib/server/observability/logger.ts`
- Create: `src/lib/server/observability/logger.test.ts`

- [ ] **Step 1: Write sink, ordering, and failure-policy tests**

Use injected `now`, `stdout`, and `stderr` functions. Cover:

1. one compact JSON object followed by exactly one `\n` per event;
2. the exact envelope-first and event-field insertion order;
3. canonical RFC 3339 UTC timestamps from the injected clock;
4. fixed stdout/stderr selection for every event row;
5. both dynamic `job.failed` severities;
6. independent service typing and runtime rejection of a smoke event for `web` or a worker event for a smoke producer;
7. development/test validation, clock, serialization, and sink failures throwing into the calling test;
8. production invalid input or primary-sink failure making exactly one direct, nonrecursive `logging.failure` attempt on stderr;
9. production fallback-sink failure being swallowed after that one attempt; and
10. no raw exception text or privacy canary in either the primary or fallback line.

Run:

```powershell
npx vitest run src/lib/server/observability/logger.test.ts --reporter=verbose
```

Expected RED: tests fail because the logger factory is absent.

- [ ] **Step 2: Implement the logger without a dependency**

Use this public surface:

```ts
export type StructuredLogSink = (line: string) => void;

export interface StructuredLogger<S extends StructuredLogService> {
  emit(input: StructuredEventInputFor<S>): void;
}

export function createStructuredLogger<S extends StructuredLogService>(
  options: {
    readonly service: S;
    readonly environment: 'development' | 'test' | 'production';
    readonly now?: () => Date;
    readonly stdout?: StructuredLogSink;
    readonly stderr?: StructuredLogSink;
  }
): StructuredLogger<S>;
```

Default sinks call `process.stdout.write` and `process.stderr.write`. The strict path obtains and validates the time, delegates exact reconstruction to `validateStructuredEvent`, serializes, appends one newline, and calls only the selected sink.

The production catch block must not call `emit` recursively. It constructs the fixed minimal record directly in envelope order:

```json
{"version":1,"timestamp":"<validated current UTC>","severity":"error","service":"<fixed factory service>","event":"logging.failure","outcome":"failed"}
```

If the clock itself is invalid, use the fixed `1970-01-01T00:00:00.000Z` fallback timestamp; never include the cause. Attempt the configured stderr sink once and return regardless of its result. There is no buffering, retry loop, remote transport, log-level setting, request/body inspection, or console monkey-patch.

- [ ] **Step 3: Run the focused and combined contract suites**

```powershell
npx vitest run src/lib/server/observability/contracts.test.ts src/lib/server/observability/safe-error.test.ts src/lib/server/observability/logger.test.ts --reporter=verbose
npm run check
npx eslint src/lib/server/observability/contracts.ts src/lib/server/observability/contracts.test.ts src/lib/server/observability/safe-error.ts src/lib/server/observability/safe-error.test.ts src/lib/server/observability/logger.ts src/lib/server/observability/logger.test.ts
git diff --check
```

Expected: all structured-record tests pass and all static checks exit zero.

- [ ] **Step 4: Review and commit the logger**

```powershell
git --literal-pathspecs diff -- src/lib/server/observability/logger.ts src/lib/server/observability/logger.test.ts
git --literal-pathspecs add -- src/lib/server/observability/logger.ts src/lib/server/observability/logger.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: add strict structured logger"
```

## Milestone C — establish one web correlation and lifecycle

### Task 4: Add diagnostic context and migrate explicit audit correlation

**Files:**

- Create: `src/lib/server/observability/context.ts`
- Create: `src/lib/server/observability/context.test.ts`
- Modify: `src/lib/server/http/strict-json.ts`
- Modify: `src/lib/server/http/strict-json.test.ts`
- Modify: `src/routes/admin/catalog/route-support.ts`
- Modify: `src/routes/admin/catalog/catalog-routes.test.ts`
- Modify: `src/routes/admin/catalog/[titleId]/cover/+server.ts`
- Modify: `src/routes/admin/catalog/[titleId]/revisions/upload/+server.ts`
- Modify: `src/routes/admin/catalog/[titleId]/revisions/upload/server.test.ts`
- Modify: `src/routes/admin/catalog/[titleId]/revisions/[revisionId]/original/+server.ts`
- Modify: `src/routes/admin/sales/route-support.ts`
- Modify: `src/routes/admin/sales/route-support.test.ts`
- Modify: `src/routes/admin/users/+page.server.ts`
- Modify: `src/routes/admin/users/page-server.test.ts`
- Modify: `src/routes/admin/audit/[eventId]/+page.server.ts`
- Modify: `src/routes/admin/audit/audit-routes.test.ts`
- Modify: `src/routes/library/[titleId]/download/+server.ts`
- Modify: `src/routes/library/[titleId]/download/route.test.ts`
- Modify: `src/routes/read/[id]/+page.server.ts`
- Modify: `src/routes/read/[id]/page.server.test.ts`
- Modify: `src/routes/read/[id]/route.test.ts`
- Modify: `src/routes/media/media-routes.test.ts`

- [ ] **Step 1: Write context normalization and isolation tests**

Test this exact public contract:

```ts
export interface WebDiagnosticContext {
  readonly kind: 'web';
  readonly correlationId: CorrelationId;
}

export interface JobDiagnosticContext {
  readonly kind: 'job';
  readonly correlationId: CorrelationId;
  readonly jobId: string;
  readonly jobKind: string;
  readonly attempt: number;
  readonly generation?: number;
  readonly workerId: string;
  readonly slotId: number;
}

export type DiagnosticContext = WebDiagnosticContext | JobDiagnosticContext;

export function normalizeOrCreateCorrelationId(
  value: unknown,
  uuidSource?: () => string
): CorrelationId;

export function runWithDiagnosticContext<T>(
  context: DiagnosticContext,
  callback: () => T
): T;

export function getDiagnosticContext(): DiagnosticContext | undefined;

export function correlationIdForRequest(
  request: Request,
  uuidSource?: () => string
): CorrelationId;
```

Cases must cover valid edge lengths 1 and 100, every allowed punctuation character, absent and invalid replacement, 101 characters, leading punctuation, spaces, non-ASCII, newline rejection by the `Headers` implementation, no trimming, canonical lowercase UUID generation, rejection of a bad injected UUID source, synchronous and asynchronous propagation, concurrent isolation, nested job-over-web context and restoration, and no context after a callback settles.

`correlationIdForRequest` must prefer an active web or job diagnostic correlation over a conflicting raw header. Only direct route/unit invocation outside ingress reads and normalizes the header. Neither function mutates the request nor adds a response header.

Run:

```powershell
npx vitest run src/lib/server/observability/context.test.ts --reporter=verbose
```

Expected RED: the tests fail only because the context owner is absent.

- [ ] **Step 2: Implement the sole request-ID owner**

Use one module-private `AsyncLocalStorage<DiagnosticContext>`. Reconstruct and freeze contexts from exact primitive fields; validate the job context using the same safe UUID/token/integer helpers as event construction. Preserve a valid incoming correlation byte-for-byte, including case. Generate with `randomUUID()` only for absent/invalid input and validate the injected generator as a canonical lowercase UUID.

Do not add diagnostic state to `App.Locals`, authorization types, database transaction types, or request metadata. Do not export the storage object.

- [ ] **Step 3: Put every current request-to-domain correlation behind the context helper**

First update the listed route tests so their old 200-character trimmed behavior is replaced by the approved 100-character, no-trim grammar and so an ambient correlation wins over a conflicting header. Then make these exact production changes:

- preserve the `correlationIdForRequest` export from `strict-json.ts`, but make it a re-export/import of the new sole owner so checkout, claim, and reader-state callers adopt ingress correlation without changing their signatures;
- leave `commandContext(request, routeId)` and `createFinancialRequestContext(request, routeId)` signatures and explicit audit/domain arguments unchanged;
- remove each bespoke request-ID Zod schema and request-specific `randomUUID()` fallback from catalog route support, sales route support, admin users, audit detail, cover upload, revision upload, original download, library download, and entitled-reader initialization;
- add `request` to the entitled reader load destructure and pass `correlationIdForRequest(request)` explicitly;
- retain unrelated UUID generation for staging storage keys, idempotency keys, fixture identities, entity IDs, and tests; and
- leave `safeAuditRequestMetadata`, its independent route bound, audit schemas, SQL, transactions, and response behavior unchanged.

Run the route-level RED before changing production files:

```powershell
npx vitest run src/lib/server/http/strict-json.test.ts src/routes/admin/catalog/catalog-routes.test.ts "src/routes/admin/catalog/[titleId]/revisions/upload/server.test.ts" src/routes/admin/sales/route-support.test.ts src/routes/admin/users/page-server.test.ts src/routes/admin/audit/audit-routes.test.ts "src/routes/library/[titleId]/download/route.test.ts" "src/routes/read/[id]/page.server.test.ts" "src/routes/read/[id]/route.test.ts" src/routes/media/media-routes.test.ts --reporter=verbose
```

Expected RED: the new 100-character/no-trim and ambient-context assertions fail against the duplicated old parsers; unrelated route behavior remains green.

- [ ] **Step 4: Run the full focused correlation GREEN**

```powershell
npx vitest run src/lib/server/observability/context.test.ts src/lib/server/http/strict-json.test.ts src/routes/admin/catalog/catalog-routes.test.ts "src/routes/admin/catalog/[titleId]/revisions/upload/server.test.ts" src/routes/admin/sales/route-support.test.ts src/routes/admin/users/page-server.test.ts src/routes/admin/audit/audit-routes.test.ts "src/routes/library/[titleId]/download/route.test.ts" "src/routes/read/[id]/page.server.test.ts" "src/routes/read/[id]/route.test.ts" src/routes/media/media-routes.test.ts --reporter=verbose
npm run check
npx eslint src/lib/server/observability/context.ts src/lib/server/observability/context.test.ts src/lib/server/http/strict-json.ts src/lib/server/http/strict-json.test.ts src/routes/admin/catalog/route-support.ts src/routes/admin/catalog/catalog-routes.test.ts "src/routes/admin/catalog/[titleId]/cover/+server.ts" "src/routes/admin/catalog/[titleId]/revisions/upload/+server.ts" "src/routes/admin/catalog/[titleId]/revisions/upload/server.test.ts" "src/routes/admin/catalog/[titleId]/revisions/[revisionId]/original/+server.ts" src/routes/admin/sales/route-support.ts src/routes/admin/sales/route-support.test.ts src/routes/admin/users/+page.server.ts src/routes/admin/users/page-server.test.ts "src/routes/admin/audit/[eventId]/+page.server.ts" src/routes/admin/audit/audit-routes.test.ts "src/routes/library/[titleId]/download/+server.ts" "src/routes/library/[titleId]/download/route.test.ts" "src/routes/read/[id]/+page.server.ts" "src/routes/read/[id]/page.server.test.ts" "src/routes/read/[id]/route.test.ts" src/routes/media/media-routes.test.ts
git diff --check
```

Expected: all focused tests and static checks pass. A source search finds no remaining production request-header parser outside `observability/context.ts`:

```powershell
$matches = @(rg -n 'x-request-id|requestIdSchema' src --glob '*.ts' --glob '!*.test.ts')
$matches
if (@($matches | Where-Object { $_ -notmatch 'src[/\\]lib[/\\]server[/\\]observability[/\\]context\.ts' }).Count -ne 0) {
  throw 'A duplicate production request-ID parser remains.'
}
```

- [ ] **Step 5: Review and commit the context migration**

```powershell
git --literal-pathspecs diff -- src/lib/server/observability/context.ts src/lib/server/observability/context.test.ts src/lib/server/http/strict-json.ts src/lib/server/http/strict-json.test.ts src/routes/admin src/routes/library src/routes/read src/routes/media
git --literal-pathspecs add -- src/lib/server/observability/context.ts src/lib/server/observability/context.test.ts src/lib/server/http/strict-json.ts src/lib/server/http/strict-json.test.ts src/routes/admin/catalog/route-support.ts src/routes/admin/catalog/catalog-routes.test.ts "src/routes/admin/catalog/[titleId]/cover/+server.ts" "src/routes/admin/catalog/[titleId]/revisions/upload/+server.ts" "src/routes/admin/catalog/[titleId]/revisions/upload/server.test.ts" "src/routes/admin/catalog/[titleId]/revisions/[revisionId]/original/+server.ts" src/routes/admin/sales/route-support.ts src/routes/admin/sales/route-support.test.ts src/routes/admin/users/+page.server.ts src/routes/admin/users/page-server.test.ts "src/routes/admin/audit/[eventId]/+page.server.ts" src/routes/admin/audit/audit-routes.test.ts "src/routes/library/[titleId]/download/+server.ts" "src/routes/library/[titleId]/download/route.test.ts" "src/routes/read/[id]/+page.server.ts" "src/routes/read/[id]/page.server.test.ts" "src/routes/read/[id]/route.test.ts" src/routes/media/media-routes.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: centralize diagnostic correlation context"
```

### Task 5: Emit one safe HTTP lifecycle event at SvelteKit ingress

**Files:**

- Create: `src/lib/server/observability/http-lifecycle.ts`
- Create: `src/lib/server/observability/http-lifecycle.test.ts`
- Create: `src/hooks.server.test.ts`
- Modify: `src/hooks.server.ts`
- Create: `scripts/observability-boundaries.test.ts`
- Inspect only: `deploy/Caddyfile`
- Inspect only: `scripts/caddy-sensitive-uri-logging.test.ts`

The Caddy files are listed only for no-regression inspection. Do not change the production policy or enable access logging.

- [ ] **Step 1: Write the pure HTTP classifier RED**

Build a pure classifier around fixed trusted inputs. Its exact matrix is:

| Observed terminal condition | Event | Code |
| --- | --- | --- |
| final response 100-399, including redirects | `http.request.completed` | absent |
| response 400 | `http.request.rejected` | `invalid_request` |
| response 401 | `http.request.rejected` | `unauthenticated` |
| response 403 | `http.request.rejected` | `forbidden` |
| response 404 | `http.request.rejected` | `not_found` |
| response 405 | `http.request.rejected` | `method_not_allowed` |
| response 409 | `http.request.rejected` | `conflict` |
| response 413 | `http.request.rejected` | `payload_too_large` |
| response 415 | `http.request.rejected` | `unsupported_media_type` |
| response 422 | `http.request.rejected` | `invalid_input` |
| response 429 | `http.request.rejected` | `rate_limited` |
| any other response 400-499 | `http.request.rejected` | `request_rejected` |
| intentional maintenance short-circuit 503 | `http.request.rejected` | `maintenance_mode` |
| any other returned response 500-599 | `http.request.failed` | `http_server_error` |
| exception escaping hook-owned work | `http.request.failed`, status 500 | `unexpected_failure` |

Test route selection from a static SvelteKit route ID, dynamic template, empty/undefined/overlong ID to fixed `unmatched`, and prove `url`, `pathname`, query, and params are neither accepted nor read. Test uppercase methods of length 1-16, normalization of ordinary lowercase methods, and fixed `UNKNOWN` for empty, non-ASCII, punctuation, or overlong values. Measure with an injected monotonic source; truncate/clamp to integer 0-86,400,000 and handle clock regression as zero.

Run:

```powershell
npx vitest run src/lib/server/observability/http-lifecycle.test.ts --reporter=verbose
```

Expected RED: only the missing classifier/emitter fails.

- [ ] **Step 2: Implement response classification without reading a body**

The helper accepts normalized correlation, raw method, `event.route.id`, start/end monotonic values, and either a final status plus `maintenance: boolean` or `escapedException: true`. It returns one exact `StructuredEventInputFor<'web'>` and can pass that input to an injected web logger. It never accepts a `Request`, `URL`, `Response` body, headers, cookies, params, form data, action payload, exception, or domain response code.

For an escaping exception, `hooks.server.ts` calls `reduceSafeError(cause, { operation: 'http.request', correlationId })` and projects only the returned `code` into the lifecycle helper. With no boundary-owned matcher, the result is exactly `unexpected_failure`; the exception object itself never enters the classifier/logger and is rethrown unchanged after emission.

SvelteKit route errors, redirects, endpoint failures, and unmatched routes that `resolve` converts into a `Response` are classified by their final response status. Enhanced action failure encoded inside an HTTP 200 response remains `http.request.completed`; the hook does not inspect bodies to invent a domain outcome.

- [ ] **Step 3: Write hook behavior and privacy RED tests**

Mock the config/auth/database/storage boundaries and injected sinks. Prove:

1. build mode retains the current resolve/canonicalization behavior and emits no runtime event;
2. a top-level request validates/generates correlation before maintenance and auth;
3. maintenance still initializes anonymous locals, does not call auth, returns the exact current body/status/headers, and emits one rejected/503/`maintenance_mode` event;
4. success, 3xx canonical redirect, 4xx, and returned 5xx each emit exactly one correct event after canonicalization;
5. a hook-level exception emits one failed/500/`unexpected_failure` event and the identical exception object is rethrown;
6. valid and generated correlation propagates through awaited auth, actor lookup, `resolve`, and explicit audit helpers;
7. an internal `event.isSubRequest` reuses ambient context and emits no second ingress lifecycle record;
8. the hook constructs the logger exactly as `createStructuredLogger({ service: 'web', environment: config.environment })` after configuration succeeds;
9. development and test logger failures remain strict, while production fallback cannot change the response or thrown domain error;
10. no response adds `x-request-id`; and
11. canary query, pathname segment, cookie, auth values, error message, and stack do not occur in emitted lines.

Run:

```powershell
npx vitest run src/hooks.server.test.ts --reporter=verbose
```

Expected RED: the new lifecycle expectations fail while the current response behavior assertions remain green.

- [ ] **Step 4: Wrap the existing hook operation without changing its domain order**

Preserve this order exactly:

1. initialize anonymous locals;
2. retain the build-mode branch without runtime logging;
3. obtain config and construct the fixed logger as `createStructuredLogger({ service: 'web', environment: config.environment })`;
4. for top-level runtime ingress, normalize `x-request-id` and enter `runWithDiagnosticContext`;
5. start monotonic timing;
6. check maintenance before creating/using auth;
7. resolve Better Auth session and actor exactly as today;
8. call `svelteKitHandler` and `canonicalizeBodylessRedirect` exactly as today;
9. emit one terminal event from the final canonical response; or
10. on an escaping exception, emit the fixed safe failure and rethrow the original object.

Keep lifecycle emission outside the request-operation `try` so a strict development/test logger assertion is not caught and mislabeled as an HTTP domain failure. In hook tests, mock the factory only to prove the exact `service`/`environment` construction and inject controlled sinks through the logger module's own tests; do not add a runtime test-only hook option. A production logger handles its own failure and returns. Do not change response bodies, status, headers, redirects, auth, actor construction, maintenance allowlists, or `init` resource ownership.

- [ ] **Step 5: Add a source-shape privacy and ownership proof**

In `scripts/observability-boundaries.test.ts`, normalize CRLF on file reads and assert:

- `context.ts` is the sole production reader of `x-request-id`;
- `hooks.server.ts` establishes context before maintenance/auth and contains no URL/query/header serialization;
- logger inputs never mention the forbidden privacy-field names;
- no response header assignment contains `x-request-id`;
- no raw `console.*` call is introduced in the new observability modules or migrated web hook;
- no smoke script imports the logger in Checkpoint B;
- `src/app.d.ts` has no diagnostic authorization-local addition.

Rerun the existing `scripts/caddy-sensitive-uri-logging.test.ts` unchanged to retain its authoritative edge-logging proof.

- [ ] **Step 6: Run focused GREEN and commit web lifecycle adoption**

```powershell
npx vitest run src/lib/server/observability/http-lifecycle.test.ts src/hooks.server.test.ts scripts/observability-boundaries.test.ts scripts/caddy-sensitive-uri-logging.test.ts --reporter=verbose
npm run check
npx eslint src/lib/server/observability/http-lifecycle.ts src/lib/server/observability/http-lifecycle.test.ts src/hooks.server.ts src/hooks.server.test.ts scripts/observability-boundaries.test.ts
git diff --check
git --literal-pathspecs diff -- src/lib/server/observability/http-lifecycle.ts src/lib/server/observability/http-lifecycle.test.ts src/hooks.server.ts src/hooks.server.test.ts scripts/observability-boundaries.test.ts deploy/Caddyfile scripts/caddy-sensitive-uri-logging.test.ts
git --literal-pathspecs add -- src/lib/server/observability/http-lifecycle.ts src/lib/server/observability/http-lifecycle.test.ts src/hooks.server.ts src/hooks.server.test.ts scripts/observability-boundaries.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: emit correlated HTTP lifecycle events"
```

Expected: all focused tests and checks pass; `deploy/Caddyfile` and its existing test remain unstaged and unchanged. The committed hook preserves every existing response behavior and emits one privacy-safe lifecycle record per top-level request.

## Milestone D — observe jobs without changing queue authority

### Task 6: Return the committed retry disposition from job failure settlement

**Files:**

- Modify: `src/lib/server/jobs/types.ts`
- Modify: `src/lib/server/jobs/repository.ts`
- Modify: `src/lib/server/jobs/repository.test.ts`
- Modify mechanically: `src/lib/server/jobs/runner.test.ts`
- Modify mechanically: `src/lib/server/jobs/test-worker-control.test.ts`
- Modify mechanically: `tests/integration/financial-admin-commands.test.ts`
- Modify mechanically: `tests/integration/financial-recovery.test.ts`
- Modify: `tests/integration/jobs.test.ts`

- [ ] **Step 1: Write the repository disposition RED**

Add this exact result while retaining the historical boolean method:

```ts
export type JobFailureTransition =
  | { readonly applied: false }
  | {
      readonly applied: true;
      readonly retryScheduled: boolean;
    };

export interface JobRepository {
  // Existing claimNext, renewLease, complete, and fail signatures stay present.
  failWithDisposition(
    jobId: string,
    workerId: string,
    safeError: string,
    retryable: boolean,
    financialAdminLeaseCapability?: string
  ): Promise<JobFailureTransition>;
}
```

In the existing repository unit harness, cover all branches:

- retryable, attempts below maximum -> `{ applied: true, retryScheduled: true }`;
- retryable, attempts at maximum -> `{ applied: true, retryScheduled: false }`;
- nonretryable -> `{ applied: true, retryScheduled: false }`;
- a pre-existing `rerun_requested_at` -> `{ applied: true, retryScheduled: true }` even when the ordinary failure is nonretryable or exhausted;
- missing row/ownership, stale attempt, invalid or rejected financial capability -> `{ applied: false }`;
- SQL/transaction error on ordinary work still throws;
- protected financial authority error retains its current fixed error mapping; and
- legacy `fail(...)` returns only `.applied` for the same cases.

Run:

```powershell
npx vitest run src/lib/server/jobs/repository.test.ts --reporter=verbose
```

Expected RED: only the missing result method and result-shape assertions fail; existing SQL/order assertions remain green.

- [ ] **Step 2: Share one failure transaction and derive status from its update**

Extract one internal function used by both public methods. Keep the existing transaction, row lock, capability context/lock order, predicates, attempts, retry-delay calculation, timestamp authority, safe-error truncation, rerun reset, and column assignments byte-for-byte except that both update branches return `id, status`.

Map no row to `{ applied: false }`; map returned `status='pending'` to `{ applied: true, retryScheduled: true }`; map returned `status='failed'` to `{ applied: true, retryScheduled: false }`. Reject any other returned status as an internal invariant failure. The boolean adapter awaits the same internal function and returns `result.applied`.

Never derive `retryScheduled` in the runner from `retryable`, `attempts`, or `maxAttempts`: only this committed row transition is authoritative, especially when a concurrent rerun request exists.

Add the new required method to every hand-written `JobRepository` test adapter in the listed runner/control/financial files. A forwarding decorator forwards it. A terminal-write-disconnection adapter rejects or returns `{ applied: false }` consistently with the existing failure it simulates. An in-memory repository maps its existing boolean outcome to the discriminated shape. Do not change runner production code to call the method until Task 7.

- [ ] **Step 3: Add the PostgreSQL witness without running it yet**

In `tests/integration/jobs.test.ts`, use the existing disposable database fixture to prove pending, terminal, rerun-requested, lost-ownership, and capability-protected results against real PostgreSQL. Assert durable status and result agree in the same test. Do not add a migration, new column, trigger, routine, role, or grant. The service-backed test runs only in the serialized checkpoint gates.

- [ ] **Step 4: Run focused GREEN and commit**

```powershell
npx vitest run src/lib/server/jobs/repository.test.ts src/lib/server/jobs/runner.test.ts src/lib/server/jobs/test-worker-control.test.ts --reporter=verbose
npm run check
npx eslint src/lib/server/jobs/types.ts src/lib/server/jobs/repository.ts src/lib/server/jobs/repository.test.ts src/lib/server/jobs/runner.test.ts src/lib/server/jobs/test-worker-control.test.ts tests/integration/jobs.test.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-recovery.test.ts
git diff --check
git --literal-pathspecs diff -- src/lib/server/jobs/types.ts src/lib/server/jobs/repository.ts src/lib/server/jobs/repository.test.ts src/lib/server/jobs/runner.test.ts src/lib/server/jobs/test-worker-control.test.ts tests/integration/jobs.test.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-recovery.test.ts
git --literal-pathspecs add -- src/lib/server/jobs/types.ts src/lib/server/jobs/repository.ts src/lib/server/jobs/repository.test.ts src/lib/server/jobs/runner.test.ts src/lib/server/jobs/test-worker-control.test.ts tests/integration/jobs.test.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-recovery.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: expose committed job retry disposition"
```

Expected: the hermetic repository suite passes, static checks are green, and the staged diff has no SQL-authority or schema expansion.

### Task 7: Add correlated runner observations and exact slot progress

**Files:**

- Create: `src/lib/server/jobs/runner-observer.ts`
- Create: `src/lib/server/jobs/runner-observer.test.ts`
- Modify: `src/lib/server/jobs/runner.ts`
- Modify: `src/lib/server/jobs/runner.test.ts`
- Modify mechanically: `src/worker.ts`
- Modify type adapters only: `src/lib/server/jobs/test-worker-control.test.ts`
- Modify type adapters only: `tests/integration/financial-admin-commands.test.ts`
- Modify type adapters only: `tests/integration/financial-corrections.test.ts`
- Modify type adapters only: `tests/integration/financial-lock-order.test.ts`
- Modify type adapters only: `tests/integration/financial-privacy.test.ts`
- Modify type adapters only: `tests/integration/financial-recovery.test.ts`
- Modify type adapters only: `tests/integration/financial-scheduler.test.ts`

- [ ] **Step 1: Define the observer and metadata seam in tests**

Use an exact primitive-only observation union. It may contain only these variants:

```ts
export type WorkerSlotProgressEvent =
  | { readonly type: 'polling'; readonly slotId: number }
  | {
      readonly type: 'poll_succeeded';
      readonly slotId: number;
      readonly claimed: boolean;
    }
  | { readonly type: 'lease_renewed'; readonly slotId: number }
  | { readonly type: 'terminal_settled'; readonly slotId: number }
  | { readonly type: 'lease_lost'; readonly slotId: number };

export interface JobAttemptIdentity {
  readonly correlationId: CorrelationId;
  readonly jobId: string;
  readonly jobKind: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly workerId: string;
  readonly slotId: number;
  readonly generation?: number;
}

export type JobRunnerObservation =
  | { readonly type: 'job_claimed'; readonly identity: JobAttemptIdentity }
  | {
      readonly type: 'job_succeeded';
      readonly identity: JobAttemptIdentity;
      readonly durationMs: number;
    }
  | {
      readonly type: 'job_failed';
      readonly identity: JobAttemptIdentity;
      readonly code: JobFailureLogCode;
      readonly durationMs: number;
      readonly retryScheduled: boolean;
    }
  | {
      readonly type: 'job_lease_lost';
      readonly identity: JobAttemptIdentity;
      readonly code: JobLeaseLostLogCode;
    };

export type RunnerObservation = WorkerSlotProgressEvent | JobRunnerObservation;
export type RunnerObserver = (event: RunnerObservation) => void;

export interface JobDiagnosticMetadata {
  readonly correlationId?: unknown;
  readonly generation?: unknown;
}

export type JobDiagnosticMetadataParser = (
  job: Readonly<JobRecord>
) => JobDiagnosticMetadata;
```

The exact logging vocabularies are:

```text
job.failed:
  permanent_job_failure
  job_completion_failed
  unexpected_failure

job.lease_lost:
  lease_capability_invalid
  lease_renewal_rejected
  lease_renewal_failed
  completion_rejected
  failure_transition_rejected
  failure_transition_failed
```

`createRunnerObserver({ logger, reportSlotProgress })` maps job variants to exact worker logger inputs and forwards only slot variants to the heartbeat callback. It reconstructs every event field; it never spreads an identity or accepts a `JobRecord`, error, payload, deduplication key, or capability.

Test exact field presence/absence for claimed, succeeded, retrying failed, terminal failed, and every lease-loss code. Assert stable optional generation, base worker ID, numeric zero-based slot, sink/severity selection through the real test logger, and absence of privacy canaries.

Run:

```powershell
npx vitest run src/lib/server/jobs/runner-observer.test.ts --reporter=verbose
```

Expected RED: the observer module does not exist.

- [ ] **Step 2: Write runner sequencing, identity, and outcome RED tests**

Extend `RunWorkerOptions` with:

```ts
readonly observer?: RunnerObserver;
readonly parseJobDiagnosticMetadata?: JobDiagnosticMetadataParser;
readonly correlationIdSource?: () => string;
readonly monotonicNow?: () => number;
```

Rename the current job-lease options from `heartbeatIntervalMs`/`heartbeatSleep` to `leaseRenewalIntervalMs`/`leaseRenewalSleep`; do not confuse either with process heartbeat publication or its publisher sleep. Thread separate identities for every slot:

```ts
const slotId = index;
const leaseOwner = options.concurrency === 1
  ? options.workerId
  : `${options.workerId}:${slotId}`;
```

Write deterministic tests for:

1. `polling` before each serialized poll hook and repository claim;
2. successful empty poll -> `poll_succeeded(claimed=false)` before sleep;
3. successful claim -> `poll_succeeded(claimed=true)` before attempt observation;
4. handler-map registration before treating `job.type` as a safe registered kind;
5. one generated lowercase UUID and one stable attempt identity across claimed and terminal events;
6. valid supplied correlation and positive signed-int32 generation from an injected parser;
7. invalid/throwing parser falling back to generated correlation and omitted generation without changing job handling;
8. base `workerId`/zero-based `slotId` in observations while all repository calls retain the exact old `leaseOwner` string;
9. injected monotonic duration from claim return through the applied terminal write;
10. successful lease renewal -> `lease_renewed`, while false/throw emits the respective lease-loss event once;
11. successful completion -> succeeded plus `terminal_settled`;
12. `complete=false` -> `completion_rejected` plus `lease_lost`, no succeeded/terminal progress;
13. a completion throw followed by applied failure -> failed/`job_completion_failed` with committed retry disposition;
14. unknown/transient and permanent handler failure -> `unexpected_failure` or `permanent_job_failure` plus committed disposition, and `terminal_settled` only when that failure transition is applied;
15. an applied-false failure transition -> `failure_transition_rejected`, no failed/terminal progress; an ordinary non-capability transition throw -> `failure_transition_failed` and rethrow of the identical error after observation; the protected-capability path retains its existing catch-to-false behavior and therefore uses `failure_transition_rejected`;
16. malformed financial capability -> claimed then `lease_capability_invalid`, with no handler or terminal progress;
17. an unknown unregistered job kind retains its existing nonretryable persisted message, emits no job event requiring a registered `jobKind`, and reports terminal progress only when settlement applies;
18. a non-aborting failed serialized poll hook preserves exactly one historical bounded `[jobs] worker poll hook failed` console line, still calls `claimNext` in that cycle, and advances poll/progress only if that repository call succeeds; a hook that aborts the shared signal retains the existing pre-claim exit;
19. `claimNext` failure remains unhandled so the worker process can fail closed; and
20. shutdown/abort preserves current handler and settlement semantics.

The existing unknown-handler persisted text and bounded `PermanentJobError.safeMessage` persistence remain unchanged. Neither persisted string enters structured event construction; structured logs receive only the fixed `permanent_job_failure` code for registered permanent handler failures.

Run:

```powershell
npx vitest run src/lib/server/jobs/runner.test.ts --reporter=verbose
```

Expected RED: new observer/progress assertions fail; existing handler, capability, lease, retry, concurrency, and shutdown behavior stays characterized.

- [ ] **Step 3: Implement observation around existing authority, not inside it**

For a registered claimed attempt:

1. defensively call the optional metadata parser; Checkpoint B's production worker supplies none;
2. normalize the parser correlation or generate one canonical lowercase UUID;
3. accept `generation` only when it is a positive signed-int32 integer;
4. build and validate one `JobAttemptIdentity` from explicit primitives;
5. enter a `JobDiagnosticContext` with `runWithDiagnosticContext`;
6. emit `job_claimed` before handler execution;
7. keep lease renewal, handler execution, and terminal settlement inside that context; and
8. emit at most one succeeded, failed, or lease-lost terminal observation before returning.

Use `reduceSafeError` for a thrown handler value with one boundary-owned `PermanentJobError` matcher. That matcher returns a trusted `permanent_job_failure` descriptor without copying `safeMessage`; every other thrown value reduces to `unexpected_failure` while retaining existing retryable settlement behavior. Use `createSafeDiagnosticError` for fixed operation results such as completion failure and lease/capability rejection, then project only `.code` into the matching closed event-code union. Do not create ad hoc error objects or bypass the safe-error validators.

Call `failWithDisposition`, not the boolean adapter, from the runner. `job.failed.retryScheduled` comes only from its applied result. Preserve `failClaimedJob`'s exception boundary exactly: an ordinary transition error emits `job.lease_lost` with `failure_transition_failed` and is then rethrown unchanged so the worker fails closed; a capability-bearing transition error remains converted to the same applied-false/rejected path as today. A successful attempt is logged as succeeded even when `complete` honors a concurrent rerun request and leaves the durable row pending; it is an attempt outcome, not a claim about final queue status.

Observation does not authorize, lock, settle, retry, or identify database ownership. Never put correlation or generation into repository calls. Preserve handler order, capability transaction behavior, signal forwarding, lease loss aborts, safe persisted messages, and every repository argument.

- [ ] **Step 4: Implement the observer adapter and exhaustive privacy tests**

Project each primitive explicitly into the logger. Never pass `identity.maxAttempts` to succeeded/lease-lost, and never omit it from claimed/failed. Keep one optional generation presence/value across the attempt.

Add poisoned jobs/errors containing payload, deduplication key, capability, email, storage key, provider body, exception message, and stack. Assert none reaches captured events or encoded lines. In production mode, an injected sink failure must not change repository/handler outcomes. In strict test mode, a deliberately invalid observation should fail the test before it can serialize.

- [ ] **Step 5: Update structural test adapters without changing their behavior**

Every in-memory object typed as `JobRepository` already implements `failWithDisposition` from Task 6; retain that behavior. Update `heartbeatIntervalMs`/`heartbeatSleep` option keys to `leaseRenewalIntervalMs`/`leaseRenewalSleep` in every runner caller, including the mechanical `src/worker.ts` interval call-site rename. Do not change integration timing, handler maps, database setup, capabilities, or assertions except where the new observation contract requires capture.

- [ ] **Step 6: Run focused GREEN and commit**

```powershell
npx vitest run src/lib/server/jobs/runner-observer.test.ts src/lib/server/jobs/runner.test.ts src/lib/server/jobs/test-worker-control.test.ts --reporter=verbose
npm run check
npx eslint src/lib/server/jobs/runner-observer.ts src/lib/server/jobs/runner-observer.test.ts src/lib/server/jobs/runner.ts src/lib/server/jobs/runner.test.ts src/lib/server/jobs/test-worker-control.test.ts src/worker.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-corrections.test.ts tests/integration/financial-lock-order.test.ts tests/integration/financial-privacy.test.ts tests/integration/financial-recovery.test.ts tests/integration/financial-scheduler.test.ts
git diff --check
git --literal-pathspecs diff -- src/lib/server/jobs/runner-observer.ts src/lib/server/jobs/runner-observer.test.ts src/lib/server/jobs/runner.ts src/lib/server/jobs/runner.test.ts src/lib/server/jobs/test-worker-control.test.ts src/worker.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-corrections.test.ts tests/integration/financial-lock-order.test.ts tests/integration/financial-privacy.test.ts tests/integration/financial-recovery.test.ts tests/integration/financial-scheduler.test.ts
git --literal-pathspecs add -- src/lib/server/jobs/runner-observer.ts src/lib/server/jobs/runner-observer.test.ts src/lib/server/jobs/runner.ts src/lib/server/jobs/runner.test.ts src/lib/server/jobs/test-worker-control.test.ts src/worker.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-corrections.test.ts tests/integration/financial-lock-order.test.ts tests/integration/financial-privacy.test.ts tests/integration/financial-recovery.test.ts tests/integration/financial-scheduler.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: emit correlated job lifecycle events"
```

Expected: all hermetic runner/observer/control tests and static checks pass. The diff changes observation and the exact settlement return only; it does not change job SQL selection, retry delay, lease-owner grammar, poll-hook continuation/static diagnostic, handler order, ordinary transition rethrow, capability authority, or payload shapes.

## Milestone E — replace startup evidence with per-slot freshness

### Task 8: Define and strictly validate the version-1 heartbeat record

**Files:**

- Create: `src/lib/server/worker/heartbeat-contract.ts`
- Create: `src/lib/server/worker/heartbeat-contract.test.ts`

- [ ] **Step 1: Write the record/encoder/parser RED**

Use exactly this public record:

```ts
export type WorkerSlotState = 'polling' | 'idle' | 'handling';

export interface WorkerHeartbeatSlotRecord {
  readonly slotId: number;
  readonly state: WorkerSlotState;
  readonly lastSuccessfulPollAt: string;
  readonly lastProgressAt: string;
}

export interface WorkerHeartbeatRecord {
  readonly version: 1;
  readonly workerId: string;
  readonly processStartedAt: string;
  readonly publishedAt: string;
  readonly sequence: number;
  readonly configuredSlots: number;
  readonly slots: readonly WorkerHeartbeatSlotRecord[];
}

export const WORKER_HEARTBEAT_MAX_BYTES = 65_536;
export const WORKER_HEARTBEAT_FUTURE_TOLERANCE_MS = 5_000;

export function encodeWorkerHeartbeat(
  record: WorkerHeartbeatRecord
): string;

export function parseWorkerHeartbeat(raw: string): WorkerHeartbeatRecord;

export function validateWorkerHeartbeatFreshness(
  record: WorkerHeartbeatRecord,
  options: {
    readonly now: Date;
    readonly configuredSlots: number;
    readonly maxAgeMs: number;
  }
): void;
```

The encoder reconstructs keys in the interface order and emits compact canonical JSON with no trailing newline. The parser accepts only that canonical representation, a plain top-level object, exact keys, exact primitive types, version `1`, a valid worker ID, a positive signed-int32 sequence/configured-slot count, and one exact slot object per configured slot in ascending order `0..configuredSlots-1`. It rejects extra/missing keys, `null`, arrays, nested extras, duplicate/missing/out-of-order/noncanonical slot IDs, invalid states, oversized strings, and any noncanonical timestamp.

Canonical timestamps are exactly `new Date(value).toISOString()` values: UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, finite, and round-tripping byte-for-byte. Within one record require:

```text
processStartedAt <= lastSuccessfulPollAt <= lastProgressAt <= publishedAt
processStartedAt <= publishedAt
```

For freshness, require `configuredSlots` to equal the independently loaded expected value; publication and every `lastProgressAt` must be no older than `maxAgeMs`; every timestamp must be no more than 5,000 ms in the future. `lastSuccessfulPollAt` is structurally and order validated but is not independently required to be fresh, because a long handler proves progress through successful lease renewal. A single record must not claim to prove historical sequence monotonicity.

Test exact valid `polling`, `idle`, and `handling` records; boundary age/future tolerance; one millisecond outside each bound; wall-clock invalidity; negative/zero/overflow counts; stale publication; stale one slot among fresh peers; and privacy canaries in extra fields/values.

Run:

```powershell
npx vitest run src/lib/server/worker/heartbeat-contract.test.ts --reporter=verbose
```

Expected RED: the heartbeat contract module is missing.

- [ ] **Step 2: Implement validation and canonical encoding from primitives**

Do not use the general log encoder: this is one state record, not NDJSON. Share only small primitive predicates if doing so preserves the forbidden dependency directions. Do not accept a Zod passthrough object, spread parsed input, retain unknown keys, or expose parser failure details to the health CLI.

`parseWorkerHeartbeat` must use `Buffer.byteLength(raw, 'utf8')` and reject input longer than `WORKER_HEARTBEAT_MAX_BYTES` before JSON parsing. Catch `JSON.parse` failures and replace them with one fixed internal validation error. Reconstruction returns frozen plain records and slots.

- [ ] **Step 3: Run focused GREEN and commit the contract**

```powershell
npx vitest run src/lib/server/worker/heartbeat-contract.test.ts --reporter=verbose
npm run check
npx eslint src/lib/server/worker/heartbeat-contract.ts src/lib/server/worker/heartbeat-contract.test.ts
git diff --check
git --literal-pathspecs diff -- src/lib/server/worker/heartbeat-contract.ts src/lib/server/worker/heartbeat-contract.test.ts
git --literal-pathspecs add -- src/lib/server/worker/heartbeat-contract.ts src/lib/server/worker/heartbeat-contract.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: define worker heartbeat contract"
```

### Task 9: Publish one atomic record from a serialized heartbeat supervisor

**Files:**

- Create: `src/lib/server/worker/heartbeat-supervisor.ts`
- Create: `src/lib/server/worker/heartbeat-supervisor.test.ts`

- [ ] **Step 1: Write deterministic state-machine and readiness RED tests**

Use this interface:

```ts
export interface WorkerHeartbeatSupervisor {
  readonly firstHealthyPublication: Promise<void>;
  prepare(): Promise<void>;
  reportSlotProgress(event: WorkerSlotProgressEvent): void;
  run(signal: AbortSignal): Promise<void>;
  sealProgress(): void;
  removeEvidence(): Promise<void>;
}

export interface WorkerHeartbeatFileHandle {
  writeFile(value: string, options: { readonly encoding: 'utf8' }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkerHeartbeatFilesystem {
  open(path: string, flags: 'wx', mode: number): Promise<WorkerHeartbeatFileHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { readonly force: true }): Promise<void>;
}

export function createWorkerHeartbeatSupervisor(options: {
  readonly workerId: string;
  readonly configuredSlots: number;
  readonly heartbeatFile: string;
  readonly intervalMs: number;
  readonly processStartedAt: Date;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly filesystem?: WorkerHeartbeatFilesystem;
}): WorkerHeartbeatSupervisor;
```

Inject clock, sleep, and a narrow filesystem adapter; use no real waiting. Test these transitions exactly:

| Input | Allowed prior state | New state | Poll time | Progress time |
| --- | --- | --- | --- | --- |
| `polling` | initial, polling, idle | `polling` | unchanged | unchanged |
| `poll_succeeded(claimed=false)` | `polling` | `idle` | advance | advance |
| `poll_succeeded(claimed=true)` | `polling` | `handling` | advance | advance |
| `lease_renewed` | `handling` | `handling` | unchanged | advance |
| `terminal_settled` | `handling` | `idle` | unchanged | advance |
| `lease_lost` | `handling` | `idle` | unchanged | unchanged |

Repeated `polling -> polling` is intentionally idempotent and never advances either timestamp; test duplicate reports followed by a normal successful poll. Reject a configured-slot count that is zero, noninteger, unsafe, or above signed-int32, an unknown event slot, renewal outside handling, terminal/lost outside handling, claim success outside polling, time regression, nonfinite clock, sequence overflow, a second `run`, and reports after explicit `sealProgress()`. Duplicate, missing, and out-of-order serialized slot IDs remain Task 8 parser cases because the supervisor derives its own canonical `0..configuredSlots-1` slot set rather than accepting one. A rejected construction or transition is a programmer/runtime invariant failure and must never create evidence.

The initial in-memory state for every slot is `polling` with no timestamps. No target file may exist until every configured slot has one successful poll. Once the final first poll succeeds, publish immediately; resolve `firstHealthyPublication` only after the atomic rename succeeds. Test both concurrency 1 and multiple slots whose first cycles finish in different orders.

Run:

```powershell
npx vitest run src/lib/server/worker/heartbeat-supervisor.test.ts --reporter=verbose
```

Expected RED: supervisor construction and readiness behavior are absent.

- [ ] **Step 2: Specify and test the exact atomic replacement sequence**

The supervisor owns only the target path and deterministic sibling `${heartbeatFile}.tmp`. `prepare()` removes those two exact stale paths with `force: true`; it does not remove their parent or any glob. It is idempotent before `run`, and `run` refuses to start until preparation succeeds. `run` does not repeat or defer preparation past dependency probes. Every publication is serialized and performs:

1. call the injected wall clock and reject regression from the prior accepted supervisor time;
2. increment a positive signed-int32 sequence, starting at 1;
3. snapshot every slot into a newly reconstructed record;
4. canonical-encode the record;
5. open the same-directory temp path with exclusive create (`wx`) and mode `0o600`;
6. write the full UTF-8 content through the open handle;
7. call the handle's `sync()`;
8. close the handle in `finally`;
9. rename the temp path over the target atomically; and
10. retain no open handle or pending overlapping publication.

The sole retry exception is transient Windows replacement contention at step 9. After the deterministic temp has been written, synced, and closed, retry only that same `rename(tempPath, heartbeatFile)` when safe inspection finds an own data property `code` whose value is exactly `EPERM`, `EACCES`, or `EBUSY`; proxy values, including revoked proxies, are nonretryable, and inspection never invokes an accessor or proxy trap. Before the first rename, establish one monotonic deadline `min(intervalMs, 1_000)` milliseconds away. Use injected monotonic-now and abort-aware retry-wait seams distinct from the wall clock and cadence sleep, and wait for `min(10, remainingMilliseconds)` between attempts. Reject invalid or regressing monotonic readings. The reading immediately after each positive retry wait must advance strictly, while equal readings immediately around rename attempts remain valid. Do not use a fixed attempt count or exceed the deadline. An abort or sealed supervisor during retry settles the publisher normally after best-effort temp removal, while a retry-wait failure while active is fatal.

On open/write/sync/close failure, any nontransient, non-data, or hostile rename error, deadline exhaustion, invalid retry time, or active retry-wait failure, remove only the temp path, leave the previous good target coherent until fatal cleanup, reject `run`, and reject an unresolved `firstHealthyPublication`. Never reopen, rewrite, resync, reclose, or re-encode; generate an alternate temp name; delete or truncate the target; advance sequence or wall time again; log the record, path, or raw error; or retry indefinitely. Final `removeEvidence()` remains authoritative.

Test each injected failure point, close failure precedence, cleanup failure masking rules, old-target preservation, mode/flags, exact operation order, interval serialization, abort while sleeping, abort before first readiness, idempotent pre-run `prepare`, refusal to run unprepared, progress reports accepted while an aborted publisher has settled but the runner is unwinding, idempotent `sealProgress`, rejection only after sealing, and idempotent final `removeEvidence`. `removeEvidence()` is valid after successful `prepare()` even when `run()` never started: it removes the exact target/temp paths, seals further starts/reports, and does not resolve the never-achieved `firstHealthyPublication`. A normal abort is not a publication failure.

- [ ] **Step 3: Implement the single writer and interval loop**

Keep all mutable slot state and publication sequencing module-private. `reportSlotProgress` mutates memory synchronously after validating the event and time. It wakes the publisher when the first readiness barrier becomes satisfiable. After first publication, `run` waits the injected interval and publishes the latest snapshot until aborted.

Publisher settlement does not seal the in-memory reporter: on shutdown the runner may still emit its final lease/settlement observation. The process runtime first awaits runner and publisher settlement, then calls `sealProgress()`, then removes evidence. After sealing, reports fail as lifecycle misuse and no new publication is possible.

An empty poll can make a slot healthy. Awaiting a handler alone cannot. A poll-hook failure alone, claim throw, renewal false/throw, terminal false/throw, or lost lease cannot advance progress; if the preserved post-hook `claimNext` call succeeds, that repository success advances freshness normally. Publication itself updates only `publishedAt` and `sequence`; it never refreshes slot progress.

- [ ] **Step 4: Run focused GREEN, stress the serialization model, and commit**

```powershell
npx vitest run src/lib/server/worker/heartbeat-contract.test.ts src/lib/server/worker/heartbeat-supervisor.test.ts --reporter=verbose
npm run check
npx eslint src/lib/server/worker/heartbeat-contract.ts src/lib/server/worker/heartbeat-contract.test.ts src/lib/server/worker/heartbeat-supervisor.ts src/lib/server/worker/heartbeat-supervisor.test.ts
git diff --check
git --literal-pathspecs diff -- src/lib/server/worker/heartbeat-supervisor.ts src/lib/server/worker/heartbeat-supervisor.test.ts
git --literal-pathspecs add -- src/lib/server/worker/heartbeat-supervisor.ts src/lib/server/worker/heartbeat-supervisor.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: publish atomic worker freshness heartbeat"
```

Expected: all heartbeat tests pass without wall-clock sleeps or leaked files/handles. Static checks pass and the commit contains one writer only.

## Milestone F — scope, package, and operate worker health

### Task 10: Isolate worker-only configuration and enforce freshness inequalities

**Files:**

- Modify: `src/lib/server/config/read-setting.ts`
- Modify: `src/lib/server/config/read-setting.test.ts`
- Modify: `src/lib/server/config/schema.ts`
- Create: `src/lib/server/config/worker.ts`
- Create: `src/lib/server/config/worker.test.ts`
- Modify: `src/lib/server/config/load.ts`
- Modify: `src/lib/server/config/index.ts`
- Modify: `src/lib/server/config/index.test.ts`
- Modify: `src/lib/server/config/process-scopes.test.ts`
- Modify mechanically: `src/lib/server/jobs/repository.test.ts`
- Modify mechanically: `scripts/execute-financial-restore-verifier.ts`
- Modify mechanically: `src/worker.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write default-reading and process-scope RED tests**

Add a helper with this behavior:

```ts
export function readDefaultedSetting(
  source: EnvironmentValues,
  name: string,
  defaultValue: string,
  readSecretFile?: SecretFileReader
): string;
```

It returns the default only when both `NAME` and `NAME_FILE` are absent. If either key is present, it delegates to required-setting semantics: direct-plus-file fails, an empty direct value fails, an empty file path fails, unreadable file fails safely, and empty file contents fail. Test every branch; do not use `readOptionalSetting`, because its trimming/empty-as-absent behavior would silently turn invalid explicit input into a default.

Then write loader tests for these exact types:

```ts
export interface WorkerProcessConfig {
  readonly heartbeatFile: string;
  readonly concurrency: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatMaxAgeMs: number;
}

export type WorkerApplicationConfig = ApplicationConfig & {
  readonly worker: WorkerProcessConfig;
};

export function loadWorkerApplicationConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): WorkerApplicationConfig;

export function loadWorkerHealthConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): WorkerProcessConfig;
```

Own `WorkerProcessConfig`, its six-setting parser, and `loadWorkerHealthConfig` in dependency-light `config/worker.ts`. Define the `ApplicationConfig & { worker: WorkerProcessConfig }` composition type in `config/load.ts`, where the common `ApplicationConfig` type is already available. `config/load.ts` imports the worker leaf only to combine common application configuration with `worker` for `loadWorkerApplicationConfig`; the health entrypoint imports the leaf directly and never loads the common application schema.

`ApplicationConfig.jobs` retains only `pollIntervalMs`, `leaseMs`, `retryBaseMs`, and `retryMaxMs`. `workerReadyFile` and `concurrency` move to `WorkerApplicationConfig.worker` as `heartbeatFile` and `concurrency`; the two new timings join them there.

Prove with a recording secret-file reader that `loadApplicationConfig` and `loadWebApplicationConfig` neither read nor retain `WORKER_READY_FILE`, `WORKER_CONCURRENCY`, `WORKER_HEARTBEAT_INTERVAL_MS`, their `_FILE` forms, or `WORKER_HEARTBEAT_MAX_AGE_MS` and its `_FILE` form. Prove `loadWorkerHealthConfig` reads only:

```text
WORKER_READY_FILE
WORKER_CONCURRENCY
WORKER_HEARTBEAT_INTERVAL_MS
WORKER_HEARTBEAT_MAX_AGE_MS
JOB_POLL_INTERVAL_MS
JOB_LEASE_MS
```

It must not read or retain database, storage, SMTP, auth, Stripe, origin, application-mode, retry, bootstrap, or owner credentials.

Run the new assertions before implementation:

```powershell
npx vitest run src/lib/server/config/read-setting.test.ts src/lib/server/config/worker.test.ts src/lib/server/config/index.test.ts src/lib/server/config/process-scopes.test.ts --reporter=verbose
```

Expected RED: default and worker-health loaders are missing, worker fields still live in common job config, and web still reads them.

- [ ] **Step 2: Implement the worker schemas and exact defaults**

Parse `WORKER_READY_FILE` as a nonempty trimmed filesystem string and concurrency as integer 1-16. Defaults apply only to the two new settings:

```text
WORKER_HEARTBEAT_INTERVAL_MS=5000
WORKER_HEARTBEAT_MAX_AGE_MS=20000
```

Enforce all constraints together using integer arithmetic:

```text
1,000 <= heartbeatIntervalMs <= 30,000
heartbeatMaxAgeMs >= 3 * heartbeatIntervalMs
heartbeatMaxAgeMs >= pollIntervalMs + 2 * heartbeatIntervalMs
heartbeatMaxAgeMs < leaseMs
heartbeatMaxAgeMs <= 300,000
```

Use field-specific fixed configuration messages and collect all applicable issues consistently with the existing configuration contract. The health loader reads poll/lease only to validate the inequalities and does not return them.

Split raw common application parsing from raw worker-process parsing rather than accepting unknown worker keys through a permissive schema. `config/worker.ts` may import only Zod and `read-setting.ts`; it must not import `schema.ts`, `load.ts`, or any credential-bearing client. Keep existing full/web/worker SMTP and Stripe scope behavior intact. Export `WorkerApplicationConfig` and `WorkerProcessConfig` from the config barrel; `getApplicationConfig()` remains web-only and returns `ApplicationConfig`.

- [ ] **Step 3: Remove obsolete worker fields from common job fixtures**

Remove only `workerReadyFile` and `concurrency` from inline `JobConfig` values in `repository.test.ts` and `execute-financial-restore-verifier.ts`. Mechanically change the existing worker entrypoint's four config reads from `config.jobs.workerReadyFile`/`config.jobs.concurrency` to `config.worker.heartbeatFile`/`config.worker.concurrency`; do not add heartbeat behavior until Task 12. Do not change poll, lease, retry values, restore behavior, repository construction, or financial verification. Worker/runner `concurrency` options elsewhere are not `JobConfig` and stay present.

Update `.env.example` by keeping `WORKER_READY_FILE` and `WORKER_CONCURRENCY` and adding the two defaults adjacent to them. Do not add secret files, logging transport settings, alert settings, or activation values.

- [ ] **Step 4: Run boundary GREEN and commit**

```powershell
npx vitest run src/lib/server/config/read-setting.test.ts src/lib/server/config/worker.test.ts src/lib/server/config/index.test.ts src/lib/server/config/process-scopes.test.ts src/lib/server/jobs/repository.test.ts --reporter=verbose
npm run check
npx eslint src/lib/server/config/read-setting.ts src/lib/server/config/read-setting.test.ts src/lib/server/config/schema.ts src/lib/server/config/worker.ts src/lib/server/config/worker.test.ts src/lib/server/config/load.ts src/lib/server/config/index.ts src/lib/server/config/index.test.ts src/lib/server/config/process-scopes.test.ts src/lib/server/jobs/repository.test.ts scripts/execute-financial-restore-verifier.ts src/worker.ts
git diff --check
git --literal-pathspecs diff -- src/lib/server/config src/lib/server/jobs/repository.test.ts scripts/execute-financial-restore-verifier.ts src/worker.ts .env.example
git --literal-pathspecs add -- src/lib/server/config/read-setting.ts src/lib/server/config/read-setting.test.ts src/lib/server/config/schema.ts src/lib/server/config/worker.ts src/lib/server/config/worker.test.ts src/lib/server/config/load.ts src/lib/server/config/index.ts src/lib/server/config/index.test.ts src/lib/server/config/process-scopes.test.ts src/lib/server/jobs/repository.test.ts scripts/execute-financial-restore-verifier.ts src/worker.ts .env.example
git diff --cached --check
git diff --cached
git commit -m "feat: isolate worker freshness configuration"
```

Expected: configuration tests pass, web/full loaders ignore worker-only settings, the health loader has no credential dependency, and common job behavior remains unchanged.

### Task 11: Build a stateless, credential-independent worker-health executable

**Files:**

- Create: `src/lib/server/worker/health-check.ts`
- Create: `src/lib/server/worker/health-check.test.ts`
- Create: `src/worker-health.ts`
- Modify: `vite.services.config.ts`
- Modify: `package.json`
- Modify: `scripts/process-secret-scope.test.ts`
- Modify: `scripts/storage-process-isolation.test.ts`
- Modify: `scripts/observability-boundaries.test.ts`

- [ ] **Step 1: Write bounded-file and CLI RED tests**

Expose a testable operation:

```ts
export interface WorkerHealthCheckOptions {
  readonly heartbeatFile: string;
  readonly configuredSlots: number;
  readonly maxAgeMs: number;
  readonly now?: () => Date;
  readonly filesystem?: WorkerHealthFilesystem;
  readonly stderr?: (line: string) => void;
}

export interface WorkerHealthFileStat {
  readonly size: number;
  isFile(): boolean;
}

export interface WorkerHealthFileHandle {
  stat(): Promise<WorkerHealthFileStat>;
  readFile(options: { readonly encoding: 'utf8' }): Promise<string>;
  close(): Promise<void>;
}

export interface WorkerHealthFilesystem {
  open(path: string, flags: 'r'): Promise<WorkerHealthFileHandle>;
}

export async function runWorkerHealthCheck(
  options: WorkerHealthCheckOptions
): Promise<0 | 1>;
```

The filesystem adapter opens the target read-only, obtains size/type from the open handle, rejects a nonregular, zero-byte, or over-65,536-byte file before reading content, reads one UTF-8 snapshot through that handle, and always closes it. After reading, require `Buffer.byteLength(raw, 'utf8') === stat.size`; a mismatch is the exact short/changed-read failure and the content is not decoded. Atomic rename means an already opened prior inode remains a valid coherent snapshot. It does not stat then reopen by path.

Test valid record -> `0` and no output. Missing, inaccessible, empty, oversized, short read, malformed, noncanonical, wrong-slot, stale, future, invalid clock, read, and close failures -> `1` plus exactly this fixed line and no error detail:

```text
[worker-health] unhealthy
```

Assert the path, record, worker ID, timestamps, raw content, and thrown message never appear on stderr. No case throws to the CLI caller.

Run:

```powershell
npx vitest run src/lib/server/worker/health-check.test.ts --reporter=verbose
```

Expected RED: the health operation is missing.

- [ ] **Step 2: Implement the health operation and thin entrypoint**

`health-check.ts` depends only on Node filesystem types and `heartbeat-contract.ts`. It validates the independently supplied configured-slot count and maximum age. It has no config, database, storage, SMTP, auth, Stripe, SvelteKit, route, job repository, or network import.

`src/worker-health.ts` performs only:

1. `loadWorkerHealthConfig(process.env)` imported directly from `$lib/server/config/worker`;
2. call `runWorkerHealthCheck` with the loaded path/count/max age and current time; and
3. set `process.exitCode` to the returned code.

Catch configuration failure through the same fixed unhealthy output, with exit 1 and no raw configuration message. Do not create a public endpoint or emit a structured application log from this one-shot health process.

- [ ] **Step 3: Package the source and production entrypoints**

Add this service-build input:

```ts
'worker-health': resolve(import.meta.dirname, 'src/worker-health.ts')
```

Add this development/host script:

```json
"worker:health": "node --env-file-if-exists=.env --import tsx src/worker-health.ts"
```

Production uses only `node build/services/worker-health.js`. Do not add a runtime dependency or copy source/tsx into the production image for health.

- [ ] **Step 4: Extend static credential and package-boundary proof**

Update the two existing static tests to assert:

- the health library has no imports from config/database/storage/auth/commerce/email/jobs/routes;
- the entrypoint imports only the worker-health loader and health operation;
- the service build emits the named worker-health input;
- no database, SMTP, Stripe, auth, owner, bootstrap, storage credential, or credential `_FILE` value is required by the health loader;
- the fixed failure line contains no interpolation; and
- no network listener/fetch/socket or public route is added.

Keep `scripts/observability-boundaries.test.ts` source/config-boundary-only so it stays hermetic and does not depend on a pre-existing ignored build artifact. The fail-closed PowerShell assertions in Step 5 run only after `build:services`; they require the fixed unhealthy line and `WORKER_READY_FILE`, and reject the credential/application tokens `DATABASE_PASSWORD`, `SMTP_PASSWORD`, `STRIPE_SECRET_KEY`, `BETTER_AUTH_SECRET`, `STORAGE_ACCESS_KEY`, `createDatabaseClient`, `createObjectStorage`, `nodemailer`, `sveltekit`, `fetch(`, and `listen(` case-insensitively. Those executable post-build assertions—not a display-only search—are the artifact dependency proof.

- [ ] **Step 5: Run focused GREEN, inspect the built artifact, and commit**

```powershell
npx vitest run src/lib/server/worker/heartbeat-contract.test.ts src/lib/server/worker/health-check.test.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts scripts/observability-boundaries.test.ts --reporter=verbose
npm run check
npm run build:services
if (-not (Test-Path -LiteralPath build/services/worker-health.js -PathType Leaf)) {
  throw 'The production worker-health artifact is missing.'
}
$artifact = Get-Content -LiteralPath build/services/worker-health.js -Raw
foreach ($required in @('[worker-health] unhealthy', 'WORKER_READY_FILE')) {
  if ($artifact.IndexOf($required, [StringComparison]::Ordinal) -lt 0) {
    throw "The worker-health artifact is missing required token: $required"
  }
}
foreach ($forbidden in @('DATABASE_PASSWORD', 'SMTP_PASSWORD', 'STRIPE_SECRET_KEY', 'BETTER_AUTH_SECRET', 'STORAGE_ACCESS_KEY', 'createDatabaseClient', 'createObjectStorage', 'nodemailer', 'sveltekit', 'fetch(', 'listen(')) {
  if ($artifact.IndexOf($forbidden, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    throw "The worker-health artifact contains forbidden token: $forbidden"
  }
}
npx eslint src/lib/server/worker/health-check.ts src/lib/server/worker/health-check.test.ts src/worker-health.ts vite.services.config.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts scripts/observability-boundaries.test.ts
git diff --check
git --literal-pathspecs diff -- src/lib/server/worker/health-check.ts src/lib/server/worker/health-check.test.ts src/worker-health.ts vite.services.config.ts package.json scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts scripts/observability-boundaries.test.ts
git --literal-pathspecs add -- src/lib/server/worker/health-check.ts src/lib/server/worker/health-check.test.ts src/worker-health.ts vite.services.config.ts package.json scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts scripts/observability-boundaries.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: package stateless worker health check"
```

Expected: tests and build pass, `build/services/worker-health.js` exists, and inspection shows only expected health/config parsing references—not credential-bearing application clients. Build output remains untracked.

### Task 12: Wire worker lifecycle, runner progress, and fatal publication policy

**Files:**

- Create: `src/lib/server/worker/process-runtime.ts`
- Create: `src/lib/server/worker/process-runtime.test.ts`
- Modify: `src/worker.ts`
- Modify: `src/lib/server/worker/heartbeat-supervisor.ts`
- Modify: `src/lib/server/worker/heartbeat-supervisor.test.ts`
- Modify: `scripts/process-secret-scope.test.ts`
- Modify: `scripts/storage-process-isolation.test.ts`
- Modify: `scripts/observability-boundaries.test.ts`

- [ ] **Step 1: Write lifecycle ordering and failure RED tests**

Extract orchestration behind this injected boundary:

```ts
export interface WorkerProcessAssembly {
  probeDependencies(): Promise<void>;
  run(signal: AbortSignal): Promise<void>;
  assertControlHealthy(): void;
}

export interface WorkerCleanupRegistration {
  register(name: 'database' | 'email', close: () => void | Promise<void>): void;
}

export interface WorkerSignalSource {
  subscribe(
    signal: 'SIGINT' | 'SIGTERM',
    listener: () => void
  ): () => void;
}

export interface WorkerShutdownDeadline {
  readonly expired: Promise<void>;
  cancel(): void;
}

export interface RunWorkerProcessOptions {
  readonly environment: EnvironmentValues;
  readonly loadConfig: (environment: EnvironmentValues) => WorkerApplicationConfig;
  readonly createHeartbeat: (input: {
    readonly config: WorkerApplicationConfig;
    readonly workerId: string;
    readonly processStartedAt: Date;
  }) => WorkerHeartbeatSupervisor;
  readonly createAssembly: (input: {
    readonly config: WorkerApplicationConfig;
    readonly workerId: string;
    readonly processStartedAt: Date;
    readonly heartbeat: WorkerHeartbeatSupervisor;
    readonly logger: StructuredLogger<'worker'>;
    readonly signal: AbortSignal;
    readonly requestAbort: (reason?: unknown) => void;
    readonly cleanup: WorkerCleanupRegistration;
  }) => WorkerProcessAssembly | Promise<WorkerProcessAssembly>;
  readonly wallNow?: () => Date;
  readonly monotonicNow?: () => number;
  readonly hostnameSource?: () => string;
  readonly pid?: number;
  readonly uuidSource?: () => string;
  readonly signals?: WorkerSignalSource;
  readonly createShutdownDeadline?: (
    milliseconds: number
  ) => WorkerShutdownDeadline;
  readonly forceExit?: (code: 1) => void;
  readonly stdout?: StructuredLogSink;
  readonly stderr?: StructuredLogSink;
}

export async function runWorkerProcess(
  options: RunWorkerProcessOptions
): Promise<0 | 1>;
```

The production logger is created before configuration parsing. Select logger failure behavior from raw `APP_ENV` only: exact `production` uses production containment, exact `test` uses strict test behavior, and every other raw value uses strict development behavior. This selection does not make invalid config valid.

Test exact event order/fields/durations and return codes for:

1. invalid configuration before worker identity -> one `worker.failed(configuration_invalid)` without `workerId`, return 1;
2. invalid UUID/PID identity source -> `worker.failed(worker_identity_invalid)` without `workerId`, return 1;
3. valid config/ID -> `worker.started`, dependency-light heartbeat construction, and `heartbeat.prepare()` before resource assembly and dependency probes;
4. heartbeat construction/preparation failure -> `worker.heartbeat_failed(heartbeat_publication_failed)` then `worker.failed(heartbeat_publication_failed)`, return 1;
5. assembly or probe failure after stale evidence is gone -> one `worker.failed(dependency_startup_failed)` with ID, cleanup, return 1;
6. runner and publisher starting only after both probes pass;
7. every slot's first successful poll plus first atomic publication before `worker.ready`;
8. signal before readiness -> one `worker.stopping(signal_sigint|signal_sigterm)`, no ready/failed, ordered cleanup, then `worker.stopped`, return 0;
9. signal after readiness -> started, ready, stopping, stopped, return 0;
10. runner reject -> abort publisher, `worker.failed(runner_failed)`, no stopped, return 1;
11. runner resolve without a signal -> `worker.failed(runner_stopped_unexpectedly)`, return 1;
12. typed heartbeat publication rejection -> `worker.heartbeat_failed(heartbeat_publication_failed)`, then `worker.failed(heartbeat_publication_failed)`, return 1;
13. test-control `requestAbort(reason)` causes runner settlement, then `assertControlHealthy()` runs before unexpected-runner classification and emits `worker.failed(worker_control_failed)`, return 1;
14. normal-path cleanup failure -> `worker.failed(cleanup_failed)`, no stopped, return 1;
15. cleanup failure after an earlier failure -> no second `worker.failed`; retain return 1;
16. after a fatal startup/runner/control/heartbeat failure, activities or cleanup that do not settle before the injected 10,000 ms fatal-shutdown deadline -> no second worker failure, one `forceExit(1)`, and no success/stopped event;
17. production logger sink failure -> lifecycle/domain order and return code unchanged; and
18. raw configuration, probe, runner, heartbeat, control, and cleanup messages/stacks/privacy canaries absent.

The exact fixed codes are:

```text
worker.stopping:
  signal_sigint
  signal_sigterm

worker.failed:
  configuration_invalid
  worker_identity_invalid
  dependency_startup_failed
  runner_failed
  runner_stopped_unexpectedly
  heartbeat_publication_failed
  worker_control_failed
  cleanup_failed
  unexpected_failure

worker.heartbeat_failed:
  heartbeat_publication_failed
```

Run:

```powershell
npx vitest run src/lib/server/worker/process-runtime.test.ts --reporter=verbose
```

Expected RED: process runtime and lifecycle reporter do not exist.

- [ ] **Step 2: Implement bounded identity and lifecycle reporting**

Create a worker ID candidate `${hostname}:${pid}:${uuid}`. If hostname makes the candidate violate `^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`, use `worker:${pid}:${uuid}`. Require a positive safe-integer PID and canonical lowercase UUID; if the fallback is invalid, fail identity creation rather than trimming or logging the raw hostname.

The runtime captures wall and monotonic start times, emits `worker.started(workerId, configuredSlots)`, and reconstructs every lifecycle input. Ready/stopped duration is the clamped integer monotonic time since started. Subscribe once for each signal through the injected source, suppress duplicate signal events, invoke both returned unsubscribe functions in `finally`, and never emit stopped after failed. The production adapter uses `process.once` and returns a disposer that calls `process.off` with the same listener.

Every thrown boundary value goes through `reduceSafeError` with fixed matchers for `ConfigurationError` and `WorkerHeartbeatPublicationError`, or through `createSafeDiagnosticError` for an already-known lifecycle phase. Only the validated safe code reaches worker events. No catch block reads `.name`, `.message`, `.stack`, `.code`, or `.cause` from an unknown value.

The cleanup registration records no paths or credentials and runs resource closures in reverse registration order. `src/worker.ts` registers database cleanup immediately after creating the database client and email cleanup immediately after creating the transport, so final order is heartbeat stop/evidence removal, email close, database close. A partial assembly failure still executes everything already registered. The runtime owns one fixed 10,000 ms deadline only after a fatal startup/runner/control/heartbeat failure is known; production creates it with `setTimeout`/`clearTimeout`, while tests inject a manually controlled deadline and never wait on wall time. A normal SIGINT/SIGTERM retains the existing Compose 30-second stop grace and is not shortened by this internal fatal-path deadline.

- [ ] **Step 3: Implement the readiness and failure race**

After config, identity, and `worker.started`, construct the dependency-light heartbeat supervisor and await `heartbeat.prepare()` before calling `createAssembly`; this guarantees a slow or failing resource assembly cannot leave prior fresh evidence visible. Then create the assembly and run dependency probes. After both complete:

1. start `heartbeat.run(signal)` and runner `run(signal)` concurrently;
2. race `firstHealthyPublication` against early runner completion/rejection, publisher completion/rejection, and signal;
3. emit ready only if the first healthy publication wins while not aborted;
4. after readiness, continue racing runner/publisher/signal;
5. on typed publication error, emit `worker.heartbeat_failed`, abort the shared controller, and retain failure status;
6. on any failure, abort both activities without converting secondary aborts into new primary events;
7. whenever runner `run` resolves, call `assertControlHealthy()` first; classify a thrown control failure as `worker_control_failed`, otherwise treat a user signal as normal and an unsignaled resolution as `runner_stopped_unexpectedly`;
8. await runner and publisher settlement, call `heartbeat.sealProgress()`, remove the target and temp evidence (also when only `prepare()` succeeded), and run email/database cleanup; when a fatal failure is already known, race that whole sequence against one 10,000 ms deadline;
9. if cleanup wins a fatal race, cancel its deadline; after a normal user signal, use the same ordered sequence without the internal deadline, emit stopped only on successful cleanup, and retain Compose's 30-second stop grace;
10. if the fatal deadline wins, do not emit a second `worker.failed`, call the injected `forceExit(1)`, and return 1 only if a test double returns. Production `forceExit` is exactly `process.exit(1)`, so a wedged fatal path cannot keep an unhealthy container alive.

Export a fixed `WorkerHeartbeatPublicationError` from the supervisor. It contains no path, record, or raw cause in its public message. The supervisor may retain the original cause only as an internal `cause`; the reducer/logger never traverses it. A normal abort must not be wrapped as publication failure.

Docker Compose restart behavior is driven by the process returning 1; unhealthy status alone is not treated as a restart mechanism.

- [ ] **Step 4: Recompose `src/worker.ts` around the runtime**

Keep all current handler construction, topic maps, financial executors, Stripe-disabled behavior, database role transformation, test control, schedule/purge hook, database/storage probes, and dependency arguments. Move them into the injected assembly factory without changing their order or values.

Create the worker logger and runtime through `runWorkerProcess`. Supply a separate dependency-light `createHeartbeat` factory, invoked before resource assembly, from:

```ts
config.worker.heartbeatFile
config.worker.concurrency
config.worker.heartbeatIntervalMs
processStartedAt
```

Pass the runtime-owned `requestAbort` callback to `createTestWorkerControl` as its existing `abortWorker`; do not create a second controller inside the assembly. Create one runner observer from the same worker logger plus `heartbeat.reportSlotProgress`. Pass it to `runWorker` with the base worker ID and `config.worker.concurrency`. Rename the lease option and derive its interval exactly as:

```ts
const leaseRenewalIntervalMs = Math.max(
  1,
  Math.min(
    Math.floor(config.jobs.leaseMs / 3),
    Math.floor(config.worker.heartbeatMaxAgeMs / 2)
  )
);
```

Defaults retain the existing 10-second lease-renewal cadence. Short valid test settings cannot let a healthy long-running handler exceed maximum age before its next successful lease renewal.

Checkpoint B passes no production `parseJobDiagnosticMetadata`; correlation is generated per claimed attempt and generation is absent. Preserve `WORKER_READY_FILE` in raw test-control environment so its owned sibling protocol continues to find `worker.ready`; pass parsed `config.worker.concurrency` as today.

Delete top-level ready-file `writeFile`, direct `rm`, and raw worker lifecycle `console.info`/`console.error`. Preserve only the runner's exact historical `[jobs] worker poll hook failed` line. Set `process.exitCode` from an ordinary `runWorkerProcess` return; the only direct exit is the runtime's injected production `forceExit(1)` after the fixed fatal-shutdown deadline expires.

- [ ] **Step 5: Strengthen entrypoint source-shape assertions**

Update the existing static tests to prove:

- worker assembly uses the worker-scoped config fields;
- lease owner remains base ID for one slot and `${workerId}:${slotId}` for multiple slots;
- no direct marker write or raw worker lifecycle console output remains, and the one exact legacy poll-hook line is the only allowlisted runner console call;
- stale evidence is removed before probes;
- readiness follows all-slot success and first publication;
- heartbeat stops and evidence is removed before email/database close;
- publisher failure is fatal and structured, and the fixed deadline force-exits a wedged shutdown;
- health code neither reads nor retains inherited database credential values; and
- no handler map, Stripe mode, financial authority, storage roots, SMTP configuration, or test-control eligibility changed.

- [ ] **Step 6: Run focused GREEN and commit worker integration**

```powershell
npx vitest run src/lib/server/worker/process-runtime.test.ts src/lib/server/worker/heartbeat-supervisor.test.ts src/lib/server/jobs/runner-observer.test.ts src/lib/server/jobs/runner.test.ts src/lib/server/jobs/test-worker-control.test.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts scripts/observability-boundaries.test.ts --reporter=verbose
npm run check
npm run build:services
npx eslint src/lib/server/worker/process-runtime.ts src/lib/server/worker/process-runtime.test.ts src/lib/server/worker/heartbeat-supervisor.ts src/lib/server/worker/heartbeat-supervisor.test.ts src/worker.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts scripts/observability-boundaries.test.ts
git diff --check
git --literal-pathspecs diff -- src/lib/server/worker/process-runtime.ts src/lib/server/worker/process-runtime.test.ts src/lib/server/worker/heartbeat-supervisor.ts src/lib/server/worker/heartbeat-supervisor.test.ts src/worker.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts scripts/observability-boundaries.test.ts
git --literal-pathspecs add -- src/lib/server/worker/process-runtime.ts src/lib/server/worker/process-runtime.test.ts src/lib/server/worker/heartbeat-supervisor.ts src/lib/server/worker/heartbeat-supervisor.test.ts src/worker.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts scripts/observability-boundaries.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: wire observable worker freshness lifecycle"
```

Expected: focused tests, type checks, service build, lint, and diff checks pass. The worker artifact contains structured lifecycle/job emission, no opaque marker writer, no raw lifecycle console output, and only the preserved bounded poll-hook diagnostic.

### Task 13: Migrate Compose, test harnesses, and smoke health consumers

**Files:**

- Modify: `compose.dev.yaml`
- Modify: `compose.prod.yaml`
- Modify: `scripts/with-test-database.ts`
- Modify: `scripts/with-test-database.test.ts`
- Modify: `playwright.config.ts`
- Modify: `scripts/playwright-commerce-config.test.ts`
- Modify: `scripts/plan6b-production-smoke.ts`
- Modify: `scripts/plan6b-production-smoke.test.ts`
- Modify: `scripts/plan6b-fixture-runtime-probe.ts`
- Modify: `scripts/plan6b-fixture-runtime-probe.test.ts`
- Modify: `scripts/process-secret-scope.test.ts`
- Modify: `scripts/storage-process-isolation.test.ts`
- Create: `scripts/worker-heartbeat-deployment.test.ts`
- Inspect only: `src/lib/server/jobs/test-worker-control.ts`

- [ ] **Step 1: Write the deployment and harness RED**

In the new static test, normalize CRLF and inspect service blocks with bounded source helpers. Assert:

1. production `app`, `migrate`, `database-role-provision`, `bootstrap-admin`, and `storage-cleanup` do not receive any worker-only setting;
2. production `worker` alone receives path, concurrency, interval, and maximum age;
3. every non-worker development service using the shared `env_file`—`app`, `migrate`, `database-role-provision`, `bootstrap-admin`, and `storage-cleanup`—explicitly blanks each direct and file form so the file cannot leak worker settings;
4. development `worker` owns the four values;
5. production worker health is exactly `[CMD, node, build/services/worker-health.js]`;
6. development worker health invokes `node --import tsx src/worker-health.ts`;
7. neither Compose file contains a size/nonempty marker check;
8. worker `/tmp` remains a private tmpfs and no worker port is published;
9. the service build contains `worker-health`;
10. both smoke harnesses invoke the built health executable;
11. the production smoke contains isolated stale and missing-slot rejection rehearsals; and
12. no app/public readiness endpoint is expanded to expose worker state.

Update existing harness tests first to require valid-record waiting, new environment values, exact health commands, fixed failure rehearsal, and unchanged owned path. Run:

```powershell
npx vitest run scripts/worker-heartbeat-deployment.test.ts scripts/with-test-database.test.ts scripts/playwright-commerce-config.test.ts scripts/storage-process-isolation.test.ts scripts/process-secret-scope.test.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.test.ts --reporter=verbose
```

Expected RED: every old file-size/existence assumption and shared worker setting is identified; resource ownership and unrelated smoke behavior remain green.

- [ ] **Step 2: Scope worker settings and replace Compose health commands**

In `compose.prod.yaml`, remove `WORKER_CONCURRENCY` from `x-publication-settings` and remove `WORKER_READY_FILE` from `app`. Add only to `worker`:

```yaml
WORKER_READY_FILE: /tmp/worker-ready
WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-1}
WORKER_HEARTBEAT_INTERVAL_MS: ${WORKER_HEARTBEAT_INTERVAL_MS:-5000}
WORKER_HEARTBEAT_MAX_AGE_MS: ${WORKER_HEARTBEAT_MAX_AGE_MS:-20000}
```

Replace its health command with the built executable. Preserve interval 10s, timeout 3s, retries 10, start period 15s, restart policy, tmpfs, security options, resources, dependencies, volumes, and lack of published port.

In `compose.dev.yaml`, set the same values only on worker and invoke the source entrypoint with the existing `tsx` loader. Explicitly blank these on each of `app`, `migrate`, `database-role-provision`, `bootstrap-admin`, and `storage-cleanup`, including file indirection:

```text
WORKER_READY_FILE
WORKER_READY_FILE_FILE
WORKER_CONCURRENCY
WORKER_CONCURRENCY_FILE
WORKER_HEARTBEAT_INTERVAL_MS
WORKER_HEARTBEAT_INTERVAL_MS_FILE
WORKER_HEARTBEAT_MAX_AGE_MS
WORKER_HEARTBEAT_MAX_AGE_MS_FILE
```

Keep the current development health timing, worker command/watch behavior, mounts, and test-control path.

- [ ] **Step 3: Make the disposable PostgreSQL harness wait for valid freshness**

Keep `workerReadyFile = join(testStorageRoot, 'worker.ready')`; do not rename or relocate it. Add to the spawned worker environment:

```text
WORKER_HEARTBEAT_INTERVAL_MS=1000
WORKER_HEARTBEAT_MAX_AGE_MS=4000
```

These satisfy a 25 ms poll and 5,000 ms lease. Replace existence polling with `runWorkerHealthCheck` using configured slots 1, max age 4,000, injected silent stderr, and the existing bounded readiness deadline/polling supervisor. A missing/malformed/stale file keeps waiting until the deadline; the final harness error remains fixed and contains no heartbeat content.

Do not import the CLI entrypoint, start a network service, query the database for health, or alter owned-root creation/cleanup. `test-worker-control.ts` remains unchanged because it depends only on the same exact regular `worker.ready` path and never reads its content.

- [ ] **Step 4: Remove dummy worker config from the Playwright web process**

The top-level E2E isolation environment may continue to use `WORKER_READY_FILE` to derive the owned temporary root and control siblings. When constructing the SvelteKit web-server environment, omit all worker-only direct/file settings rather than passing `.worker-ready-web-process-unused` and concurrency 1. Preserve database web credentials, app port, storage isolation, bootstrap behavior, and parent/worker control environment.

- [ ] **Step 5: Make both Plan 6B harnesses consume the packaged validator**

For production smoke, extend `ProductionSmokeDockerDependencies` with `readonly now: () => Date`; the production adapter supplies `() => new Date()`, and every test dependency supplies a deterministic clock without real waiting. Then:

- replace live file-size inspection with `docker compose exec -T worker node build/services/worker-health.js` through the existing bounded command runtime;
- retain the evidence property name `workerReady` and set it from exit zero;
- after live validation, create two exact run-owned files inside worker-private `/tmp`: one canonical but stale record and one schema-shaped, exact-key-order but intentionally invalid JSON record missing slot 0, constructed directly without `encodeWorkerHeartbeat`;
- invoke the same built executable with only `WORKER_READY_FILE` overridden to each synthetic path and require nonzero;
- remove those two exact paths in nested `finally` cleanup; and
- never overwrite, rename, or delete the live `/tmp/worker-ready` during rehearsal.

Synthetic records use safe fixed worker IDs, configured slot count from the worker environment, exact canonical key order, and timestamps derived only from `dependencies.now()`. The harness records only pass/fail, not record contents. Expected nonzero commands use the runtime's explicit `allowFailure` path and are asserted, not ignored.

For the fixture runtime probe, update generated Compose so only its worker receives the four settings and its health check runs `node build/services/worker-health.js`. Replace its direct worker marker assertion with a bounded exec of that same artifact. Preserve its random owned project, immutable image, labels, loopback services, manifests, cleanup, and human-readable output.

Do not import the structured logger or emit `smoke.*`; Checkpoint D owns generalized smoke lifecycle/evidence adoption.

- [ ] **Step 6: Run the complete hermetic consumer GREEN**

```powershell
npx vitest run scripts/worker-heartbeat-deployment.test.ts scripts/with-test-database.test.ts scripts/playwright-commerce-config.test.ts scripts/storage-process-isolation.test.ts scripts/process-secret-scope.test.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.test.ts src/lib/server/config/process-scopes.test.ts --reporter=verbose
npm run check
npx eslint scripts/worker-heartbeat-deployment.test.ts scripts/with-test-database.ts scripts/with-test-database.test.ts playwright.config.ts scripts/playwright-commerce-config.test.ts scripts/plan6b-production-smoke.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.ts scripts/plan6b-fixture-runtime-probe.test.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts
git diff --check
```

Expected: all tests and static checks pass without starting Docker or PostgreSQL. Source search finds no old marker test:

```powershell
$oldChecks = @(rg -n "statSync\([^\r\n]*worker-ready|workerReady[^\r\n]*size" compose.dev.yaml compose.prod.yaml scripts src)
$oldChecks
if ($oldChecks.Count -ne 0) { throw 'An opaque worker-ready assumption remains.' }
```

- [ ] **Step 7: Review and commit runtime-consumer adoption**

```powershell
git --literal-pathspecs diff -- compose.dev.yaml compose.prod.yaml scripts/with-test-database.ts scripts/with-test-database.test.ts playwright.config.ts scripts/playwright-commerce-config.test.ts scripts/plan6b-production-smoke.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.ts scripts/plan6b-fixture-runtime-probe.test.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts scripts/worker-heartbeat-deployment.test.ts
git --literal-pathspecs add -- compose.dev.yaml compose.prod.yaml scripts/with-test-database.ts scripts/with-test-database.test.ts playwright.config.ts scripts/playwright-commerce-config.test.ts scripts/plan6b-production-smoke.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.ts scripts/plan6b-fixture-runtime-probe.test.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts scripts/worker-heartbeat-deployment.test.ts
git diff --cached --check
git diff --cached
git commit -m "test: adopt worker freshness health consumers"
```

### Task 14: Document the implemented operator contract and deferred monitoring

**Files:**

- Modify: `README.md`
- Modify: `docs/database-and-workers.md`
- Modify: `docs/runtime-environments.md`
- Verify already modified: `.env.example`
- Modify: `scripts/worker-heartbeat-deployment.test.ts`

- [ ] **Step 1: Update the documentation assertions before prose**

Require the deployment static test to find all of these operator truths and reject the old startup-only wording:

- structured version-1 NDJSON is local stdout/stderr only;
- correlation input grammar, invalid replacement, no echo, and no URL/query/body/error logging;
- the fixed web/worker/job adoption boundary, with smoke emission deferred to Checkpoint D;
- heartbeat record fields and `polling|idle|handling` state semantics;
- successful poll, lease-renewal, and terminal-settlement progress rules;
- default values and all four maximum-age inequalities;
- first healthy publication readiness barrier;
- same-directory atomic replacement, fatal publisher failure, its 10-second cleanup deadline/force-exit policy, and unchanged 30-second normal-signal grace;
- exact development and production health commands;
- 5,000 ms future tolerance and 65,536-byte bound;
- health does not read or require database credentials and has no network endpoint or public response;
- Compose does not restart merely unhealthy containers, while fatal publisher failure exits nonzero under `restart: unless-stopped`; and
- monitoring, alert transport, generalized smoke evidence, operations catalog/UI, activation, and Stripe enablement remain deferred.

Run:

```powershell
npx vitest run scripts/worker-heartbeat-deployment.test.ts --reporter=verbose
```

Expected RED: existing documentation still describes a nonempty startup marker and all Plan 7 work as deferred.

- [ ] **Step 2: Update worker and database operations documentation**

In `docs/database-and-workers.md`, replace both startup-marker descriptions with the exact record/readiness/freshness contract. Document that:

- the worker has no published port;
- slots are zero-based and every configured slot appears once;
- empty poll is progress, awaiting a handler is not, and a long handler stays fresh only through successful lease renewal;
- missing/malformed/stale/future/wrong-slot evidence is unhealthy;
- publisher failure aborts work, attempts the ordered cleanup for at most 10 seconds, and force-exits nonzero if that fatal cleanup wedges;
- shutdown stops publication and removes evidence before clients close; and
- operators may run `npm run worker:health` on a host/development environment or `node build/services/worker-health.js` in the production image.

Keep migration head `0014`, database principals, queue/retry behavior, maintenance closure, and deferred operations catalog accurate.

- [ ] **Step 3: Update environment and top-level status documentation**

In `docs/runtime-environments.md`, add the two worker-process-only settings with defaults, scope, and exact constraints to the environment table. Explain that web/migration/bootstrap/cleanup do not read them; the one-shot health loader reads only the six nonsecret health values. Update Compose health descriptions and preserve production maintenance/Stripe closure.

In `README.md`, state that Plan 7A Checkpoint A's dependency/test boundaries and Checkpoint B's structured logging/correlation/worker freshness are implemented. Keep general job operations, monitoring/alerts, generalized release evidence, off-host backup scheduling, deployment hardening, capacity tuning, activation, and Stripe enablement in the deferred list. Do not call Plan 7A complete.

Verify `.env.example` contains the exact worker defaults adjacent to the preserved ready-file/concurrency names and no logging endpoint/token or alert destination.

- [ ] **Step 4: Run documentation/static GREEN and commit**

```powershell
npx vitest run scripts/worker-heartbeat-deployment.test.ts scripts/observability-boundaries.test.ts --reporter=verbose
npx eslint scripts/worker-heartbeat-deployment.test.ts scripts/observability-boundaries.test.ts
git diff --check
git --literal-pathspecs diff -- README.md docs/database-and-workers.md docs/runtime-environments.md .env.example scripts/worker-heartbeat-deployment.test.ts
git --literal-pathspecs add -- README.md docs/database-and-workers.md docs/runtime-environments.md scripts/worker-heartbeat-deployment.test.ts
git diff --cached --check
git diff --cached
git commit -m "docs: document checkpoint B observability and health"
```

Expected: documentation assertions pass, old marker wording is absent, deferred work remains explicit, `.env.example` is already clean from Task 10, and the documentation commit contains no application behavior change.

## Milestone G — checkpoint evidence, review, and status

### Task 15: Run the complete Checkpoint B verification matrix

**Files:** None unless a proven defect requires a focused RED/GREEN correction.

- [ ] **Step 1: Run one aggregate focused hermetic gate**

```powershell
npx vitest run src/lib/server/observability/contracts.test.ts src/lib/server/observability/safe-error.test.ts src/lib/server/observability/logger.test.ts src/lib/server/observability/context.test.ts src/lib/server/observability/http-lifecycle.test.ts src/hooks.server.test.ts src/lib/server/jobs/repository.test.ts src/lib/server/jobs/runner-observer.test.ts src/lib/server/jobs/runner.test.ts src/lib/server/worker/heartbeat-contract.test.ts src/lib/server/worker/heartbeat-supervisor.test.ts src/lib/server/worker/health-check.test.ts src/lib/server/worker/process-runtime.test.ts src/lib/server/config/read-setting.test.ts src/lib/server/config/worker.test.ts src/lib/server/config/index.test.ts src/lib/server/config/process-scopes.test.ts scripts/observability-boundaries.test.ts scripts/worker-heartbeat-deployment.test.ts scripts/with-test-database.test.ts scripts/playwright-commerce-config.test.ts scripts/storage-process-isolation.test.ts scripts/process-secret-scope.test.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.test.ts --reporter=verbose
```

Expected: every Checkpoint B unit, source-shape, privacy, config-scope, harness, and failure-rehearsal test passes without Docker, PostgreSQL, Mailpit, Playwright, network listeners, or wall-clock sleeps.

- [ ] **Step 2: Run the complete unit profile directly and prove it remains hermetic**

```powershell
npm run test:unit
```

Expected: the unit command exits zero. The source-shape profile tests prove this command cannot invoke Docker/PostgreSQL/browser/network service code; the verification shell itself does not call Docker. If a file fails, rerun only that file until fixed; do not start a service-backed lane while diagnosing it.

- [ ] **Step 3: Run type, lint, build, and repository diff gates**

```powershell
npm run check
npm run lint
npm run build
git diff --check
git status --short
```

Expected: all commands exit zero, both web and service builds succeed, `build/services/worker-health.js` exists, and the worktree is clean at the current implementation HEAD.

- [ ] **Step 4: Run the repository verification gate once, serially**

```powershell
Invoke-CheckpointBServiceCommand { npm run verify }
```

Expected order remains check, lint, hermetic unit, explicit restore witness, PostgreSQL integration, disposable-worker Playwright, then full build. The new real-PostgreSQL failure-disposition witness passes, E2E waits for validated heartbeat freshness, and every nested harness completes its exact cleanup proof before the wrapper compares the global baseline.

- [ ] **Step 5: Run the applicable upgrade and production-image profiles serially**

Wait for each command and wrapper to finish before beginning the next:

```powershell
Invoke-CheckpointBServiceCommand { npm run test:plan6b-upgrade }
Invoke-CheckpointBServiceCommand { npm run smoke:plan6b -- --stage 6b-ii }
Invoke-CheckpointBServiceCommand { npm run smoke:plan6b-fixture -- --stage 6b-ii }
```

Expected: the supported prior-schema fixture reaches unchanged migration `0014`; production smoke validates the live heartbeat and rejects isolated stale/missing-slot records using the built artifact; fixture smoke validates its generated worker through the same artifact; maintenance/Stripe/provider-network closure remains unchanged; and all owned resources/temporary roots are absent afterward.

Fresh coordinated checkpoint capture and distinct-engine rehearsal remain deferred at Checkpoint B. This checkpoint adds no migration, catalog, role, ACL, backup format, restore contract, or activation input; its container-health change is exercised in both production-image profiles. Design Section 15 requires the final Checkpoint D candidate to rerun capture and the operator-supplied distinct-engine rehearsal after Checkpoint C's migration/catalog and Checkpoint D's evidence coordinator exist. Do not call Checkpoint B a Plan 7A release candidate.

- [ ] **Step 6: Prove scope containment from the exact final tree**

```powershell
git status --short --branch
git log --oneline --decorate db3f48d92b759685070988daf9602d2c00ad0ca3..HEAD
git diff --stat db3f48d92b759685070988daf9602d2c00ad0ca3..HEAD
git diff --name-only db3f48d92b759685070988daf9602d2c00ad0ca3..HEAD
if (Get-ChildItem -LiteralPath drizzle -Filter '0015*.sql') {
  throw 'Unexpected migration 0015 in Checkpoint B.'
}
$databaseAuthorityChanges = @(
  git --literal-pathspecs diff --name-only db3f48d92b759685070988daf9602d2c00ad0ca3..HEAD -- drizzle src/lib/server/db
)
if ($LASTEXITCODE -ne 0) {
  throw 'Git could not inspect the Checkpoint B database-authority diff.'
}
if ($databaseAuthorityChanges.Count -ne 0) {
  $databaseAuthorityChanges
  throw 'Checkpoint B unexpectedly changed migration or database authority files.'
}
rg -n "http\.request\.|worker\.(started|ready|stopping|stopped|failed|heartbeat_failed)|job\.(claimed|succeeded|failed|lease_lost)|logging\.failure|smoke\." src scripts docs README.md
rg -n "WORKER_HEARTBEAT_|WORKER_READY_FILE|worker-health" compose.dev.yaml compose.prod.yaml .env.example src scripts docs README.md
rg -n 'APPLICATION_MODE.*live|STRIPE_ENABLED:\s*"?true|operations\.job-retry|0015' compose.prod.yaml src scripts docs README.md drizzle
```

Expected: intended event and heartbeat boundaries are visible; no migration/database authority file changed; no production-live/Stripe activation, operations job catalog/command, arbitrary smoke service, monitoring/alert transport, or unrelated endpoint was added. Any match from explanatory documentation must still describe deferred or rejected behavior.

- [ ] **Step 7: Capture immutable verification evidence**

```powershell
git rev-parse HEAD
git status --porcelain=v1
git log --format='%H %s' db3f48d92b759685070988daf9602d2c00ad0ca3..HEAD
```

Record the exact HEAD, command results/counts/durations, and zero-output porcelain status for review. Do not edit after capturing it unless a review finding is accepted; any edit invalidates the evidence and requires the full Task 15 sequence again.

### Task 16: Request independent review and close Checkpoint B

**Files:**

- Modify only after review and fresh evidence: `docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md`

- [ ] **Step 1: Request an independent code review**

Use `superpowers:requesting-code-review`. Give the reviewer the approved design, this plan, base commit `db3f48d92b759685070988daf9602d2c00ad0ca3`, exact reviewed HEAD, and Task 15 evidence. Ask them to inspect:

- all 20 caller-visible event schemas plus the one internal fallback, envelope order, validation, fixed sinks/outcomes/severity, smoke deferral, and one-shot production containment;
- correlation normalization/ALS isolation, sole header ownership, no echo, safe route/method/status classification, and unchanged hook response/auth/maintenance behavior;
- safe-error nonreflection and privacy canaries across HTTP, worker, and job logs;
- race-exact retry disposition from the committed failure transaction, unchanged SQL/locks/capability/lease owner, stable attempt context, and terminal-event correctness;
- slot progress semantics, all-slot readiness, atomic one-writer publication, clock/sequence refusal, stale/future/malformed/wrong-slot rejection, and no historical-sequence overclaim;
- worker lifecycle ordering, fatal publisher failure, forced fatal-shutdown deadline, unchanged normal-signal grace, evidence-before-client cleanup, no raw lifecycle console output, and only the exact preserved poll-hook diagnostic;
- worker-only/default config handling, health-loader credential independence, Compose process scope, private tmpfs/no port, built artifact use, and unchanged test-control ownership;
- live/synthetic smoke health coverage without Checkpoint D evidence expansion;
- no migration/schema/ACL/operations/monitoring/activation/Stripe expansion; and
- documentation accuracy and exact deferred boundary.

The reviewer must not start a service-backed command in parallel with the primary agent.

- [ ] **Step 2: Handle every accepted finding with fresh evidence**

For every accepted finding:

1. reproduce it with the smallest focused RED where applicable;
2. implement only the demonstrated correction;
3. rerun its focused GREEN, `npm run check`, targeted lint, and `git diff --check`;
4. stage literal paths and inspect the cached diff;
5. commit as `fix: address Plan 7A checkpoint B review`;
6. rerun the entire Task 15 matrix—including `verify`, upgrade, and both production-image profiles—against the new immutable HEAD; and
7. ask the reviewer to inspect that exact replacement HEAD.

Continue until no accepted finding remains. Do not dismiss a technically valid defect to preserve the planned commit count, and do not reuse pre-fix broad evidence.

- [ ] **Step 3: Record Checkpoint B completion only after review and fresh gates**

Change only this design header line:

```text
**Implementation status:** Checkpoint A complete; Checkpoints B-D not started
```

to:

```text
**Implementation status:** Checkpoints A-B complete; Checkpoints C-D not started
```

Do not mark Plan 7A complete. Do not alter:

```text
**Launch status:** Production remains maintenance-only with Stripe disabled
```

- [ ] **Step 4: Commit the reviewed status update**

```powershell
git --literal-pathspecs add -- docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md
git diff --cached --check
git diff --cached
git commit -m "docs: record Plan 7A checkpoint B completion"
git status --short --branch
```

Expected: the status commit changes only the implementation-status line and the worktree is clean. If that commit changes HEAD after the reviewer/gates, rerun the documentation/static checks plus `git diff --check`; the status-only commit does not require rebuilding service images unless its diff contains anything beyond the approved line.

- [ ] **Step 5: Verify completion and finish the branch**

Use `superpowers:verification-before-completion` before any completion claim, then `superpowers:finishing-a-development-branch`. Report exact fresh command results, review disposition, final commit IDs, and pre-existing npm audit advisories separately from implementation correctness. Integrate/push only through the user-approved branch workflow. Local merge/push authority does not authorize production deployment, `APPLICATION_MODE=live`, Stripe enablement, secret rotation, monitor creation, or alert delivery.

## Expected implementation commit sequence

```text
feat: add safe structured event contracts
feat: add strict structured logger
feat: centralize diagnostic correlation context
feat: emit correlated HTTP lifecycle events
feat: expose committed job retry disposition
feat: emit correlated job lifecycle events
feat: define worker heartbeat contract
feat: publish atomic worker freshness heartbeat
feat: isolate worker freshness configuration
feat: package stateless worker health check
feat: wire observable worker freshness lifecycle
test: adopt worker freshness health consumers
docs: document checkpoint B observability and health
docs: record Plan 7A checkpoint B completion
```

The plan document itself is committed before implementation. This is the minimum ordered spine; explicit accepted-review fix commits are allowed and remain visible. Do not commit a RED-only or missing-module tree, squash away evidence boundaries during development, or create empty commits merely to match the list.

## Checkpoint B acceptance checklist

- [ ] Schema version 1 has one exact common envelope, primitive validators, fixed service/event compatibility, exact field allowlists, deterministic key order, all 20 approved caller-visible event schemas, and the one fixed internal `logging.failure` record.
- [ ] Development/test logging fails invalid programmer input; production logging makes at most one nonrecursive minimal `logging.failure` attempt and never changes the domain outcome.
- [ ] Only web and worker/job producers are wired in Checkpoint B; smoke schemas exist and are tested, but generalized smoke event/evidence emission remains Checkpoint D.
- [ ] Safe-error reduction never reflects arbitrary error properties/messages/stacks/causes, and privacy canaries are absent from all records/fallbacks.
- [ ] One owner validates or generates correlation before maintenance/auth, ALS is isolated/restored, audit/domain calls remain explicit, and `x-request-id` is neither echoed nor used for authority/idempotency.
- [ ] Each top-level SvelteKit request emits exactly one safe completed/rejected/failed event from the fixed status matrix without reading URL/query/body/cookies/params or changing response/auth/maintenance behavior.
- [ ] The runner retains exact base/suffixed lease-owner strings while logs/heartbeat use base worker ID plus zero-based slot ID.
- [ ] A registered claimed attempt has one stable correlation/optional generation, one claimed event, and at most one succeeded/failed/lease-lost event before crash; payload, dedupe key, capabilities, and raw errors never enter construction.
- [ ] `job.failed.retryScheduled` is derived from the committed repository transition, including rerun-requested races; the historical boolean failure method and every SQL/lock/capability/retry invariant remain intact.
- [ ] Successful poll, lease renewal, and applied terminal settlement are the only progress advances; a hook failure itself, failed polls/renewals/settlements, waiting handlers, and lost leases do not advance freshness, while the preserved repository poll after a non-aborting hook failure advances normally if it succeeds.
- [ ] No heartbeat file exists before every slot's first successful poll and the first atomic publication; `worker.ready` follows that barrier.
- [ ] The heartbeat record is canonical, versioned, primitive-only, one entry per zero-based configured slot, and contains no job/correlation/error/path/credential data.
- [ ] One supervisor serializes same-directory exclusive-temp write/sync/close/atomic rename, refuses time/sequence regression, preserves the last good target on partial failure, and removes owned evidence before clients close.
- [ ] Health rejects missing, nonregular, empty, oversized, malformed, noncanonical, stale, future, and wrong-slot records through a bounded open-handle read; success is silent and failure output is one fixed line.
- [ ] Worker heartbeat settings use exact defaults/constraints and are read only by worker and health loaders; health imports no credential-bearing application schema/client and makes no network request.
- [ ] Heartbeat publication failure emits its fixed event, aborts work, attempts ordered cleanup under the fatal deadline, emits worker failure, and exits nonzero even if forced; normal signals whose ordered cleanup succeeds emit stopping/stopped without failure and retain Compose's 30-second grace.
- [ ] Development/production Compose uses the source/built validator, preserves private tmpfs/no worker port, and does not expose worker-only settings to unrelated services.
- [ ] Disposable database/E2E control keeps the exact owned `worker.ready` path, waits for valid freshness, and retains all resource-ownership/cleanup protections.
- [ ] Production and fixture smoke invoke the built validator; production separately rejects synthetic stale/missing-slot evidence without touching the live heartbeat; Checkpoint D smoke evidence remains absent.
- [ ] Operator docs describe exact logging, correlation, record, freshness, configuration, health, failure, and deferred-monitoring behavior; no startup-only marker claim remains.
- [ ] Migration head remains `0014`; no schema, role, grant, route, job catalog, operations command, monitor/alert transport, activation input, production-live mode, or Stripe enablement lands.
- [ ] Focused tests, full unit, check, lint, build, serialized verify, upgrade, both production-image profiles, scope review, and independent review are green against the final implementation tree.
- [ ] Plan 7A remains incomplete overall; only Checkpoints A-B are complete and Checkpoints C-D remain explicitly unstarted.
