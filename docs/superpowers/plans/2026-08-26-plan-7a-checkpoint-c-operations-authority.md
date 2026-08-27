# Plan 7A Checkpoint C: Operations Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Plan 7A Checkpoint C by adding one exhaustive production-job catalog and a protected, asynchronous, expected-state-guarded operations retry-command boundary with exact database authority, two approved no-provider-call recovery adapters, audit, restore, and concurrency evidence—without adding an administrator route, navigation, monitoring, release-candidate evidence, production activation, or Stripe enablement.

**Architecture:** A dependency-light TypeScript catalog is the application source of truth for all eleven production job kinds, safe operator metadata, retry policy, diagnostic metadata, and handler completeness. A closed SQL mirror exposes only the same safe catalog projection through three owner-controlled routines; exact parity tests prevent drift. Migration `0015` adds durable retry-command and private operations-claim state, while an operations-specific lease capability and handler path remain isolated from the proven financial-administrator capability. Policy adapters own their published domain lock orders, and only the existing Stripe-event and financial-classification rearm behaviors are enabled.

**Tech Stack:** Node.js 26.7.x, npm 11.19.x, SvelteKit 2.70.x, Svelte 5.56.x, TypeScript 6.0.x, PostgreSQL 18.4, Drizzle ORM 0.45.2, Vitest 4.1.x, Docker Compose, and ESLint 10.x. No queue, provider, monitoring, route, UI, or third-party dependency is added.

---

## Source of truth, approved base, and checkpoint boundary

The authoritative design is `docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md`, especially Sections 5.1, 8, 13-16, and the Checkpoint C acceptance clauses in Section 17. The approved Plan 7A design commit is `1c330693b67a1aa34c413bd8d2ec23ff8628236e`. The required implementation base is `651a12483ce94e330dac6ea83be6ea841b4713da`, where Checkpoints A-B are complete, Checkpoints C-D are unstarted, the migration chain ends at `0014`, and production remains maintenance-only with Stripe disabled.

Before implementation, create or reuse an isolated worktree from `651a12483ce94e330dac6ea83be6ea841b4713da`. If `main` has advanced, prove both source commits remain ancestors and re-read the approved design before rebasing. Do not silently reinterpret Checkpoint C from a newer document.

Checkpoint C owns exactly:

1. one exhaustive definition for every production job kind and one validated handler binding for each;
2. the safe operational list/status DTOs and strict application service governed by `jobs.retry`;
3. append-only migration `0015` with retry-command and private claim state, complete routines, triggers, constraints, indexes, revocations, and grants;
4. one operations-specific in-memory lease capability and capability-aware claim, renewal, failure, completion, exhaustion, takeover, and replay path;
5. fixed disabled-policy results plus the two approved Stripe-event and financial-classification rearm adapters;
6. requested and terminal audit evidence, privacy/authority/lock/race witnesses, and exact restore/checkpoint agreement; and
7. operator documentation for the implemented backend boundary and continued absence of a general operations UI.

Checkpoint C does **not** add an admin route, page, form action, retry button, navigation item, public API, job payload viewer, generic SQL reset, provider call, provider-verification adapter, fifth retry disposition, monitor, alert, metric, dashboard, SLO, backup schedule, off-host transport, shared Checkpoint D smoke lifecycle, release-candidate evidence, activation input, production `live` mode, or Stripe activation. It does not broaden web table access, storage-cleanup authority, the financial-administrator capability, or the existing specialized revision-ingestion retry.

## Resolved implementation decisions

These decisions make the approved design executable without expanding it:

1. **One plan, six milestones:** Checkpoint C remains one implementation plan and one acceptance gate. Catalog/contracts, database authority, application service, worker capability, policy adapters, and evidence land in ordered reviewable commits; migration `0015`, its ACLs, and its restore catalog are never split into independently acceptable authority states.
2. **Catalog authority:** `src/lib/server/jobs/catalog.ts` is the application source of truth. PostgreSQL uses a closed `VALUES` relation inside `list_operational_jobs` because SQL cannot import TypeScript. A hermetic extractor/parity test compares every mirrored kind, label, maximum, disposition, policy identifier, provider flag, and retry availability byte-for-byte.
3. **Exact safe labels:** labels are `Outbox dispatch`, `Claim email`, `Claim email request`, `Stripe event`, `Financial source`, `Financial payout`, `Financial scan`, `Financial classification`, `Financial administrator command`, `Revision ingestion`, and `Operations job retry command`.
4. **Exact policy identifiers:** the registry contains only `deny_retry_not_supported`, `deny_retry_policy_not_enabled`, `deny_provider_recovery_not_enabled`, `rearm_pending_stripe_event`, and `rearm_financial_classification`. Each catalog row selects one identifier and separately declares availability as `enabled`, `disabled`, or `excluded`; an identifier is never treated as proof that its effect is enabled. No Checkpoint C production row selects `deny_provider_recovery_not_enabled`.
5. **Automatic retry ownership:** every row names `postgres_job_repository_exponential_backoff` as the scheduler/backoff owner and preserves its approved maximum. Domain handlers continue deciding whether a thrown failure is retryable or permanent; the catalog does not change that behavior.
6. **Provider vocabulary:** the four disposition and complete terminal-result unions retain `provider_verified_recovery` and `provider_recovery_not_enabled` for later compatible expansion, but no production Checkpoint C row uses the provider disposition and no test-only production definition is invented. All eleven rows have `providerVerificationRequired: false` and `providerCallsInPlan7A: false`.
7. **Unknown jobs:** list output never reflects an unregistered persisted type. It emits `kind: 'unregistered'`, label `Unregistered job`, disposition `never`, policy availability `excluded`, and safe failure code `unregistered_job_kind`; such a row cannot be submitted for retry. The kind filter accepts only the eleven registered strings.
8. **Safe failure mapping:** the catalog owns exact `(registered kind, bounded persisted last_error)` mappings to only `invalid_job_identity`, `source_unavailable`, `domain_state_not_retryable`, `retry_command_exhausted`, or `unexpected_failure`; an unknown kind always yields `unregistered_job_kind`, null stays null for a registered kind, and every unmapped or malformed non-null value yields `unexpected_failure`. Raw text is never returned. Milestone A freezes every currently emitted production message explicitly so a later wording change fails tests instead of silently changing operator semantics.
9. **Operational list shape:** `OperationalJobDto` contains only `jobId`, safe `kind`/`label`, `status`, `attempts`, `maxAttempts`, `runAt`, `createdAt`, `updatedAt`, nullable `completedAt`, `retryDisposition`, `policyAvailability`, and nullable `safeFailureCode`. It omits `lockedAt` as lease evidence and omits every payload, deduplication, raw-error, provider, actor, customer, and capability field. Every timestamp returned from a protected routine, and every application-level timestamp supplied to its repository, is canonical six-fraction UTC text (`YYYY-MM-DDTHH:mm:ss.ffffffZ`) and is never round-tripped through JavaScript `Date`; the approved SQL signatures still receive cursor/expected timestamps as `timestamptz` through an explicit bound-text cast.
10. **Owned command status shape:** `JobRetryCommandStatusDto` contains only `commandId`, fixed `kind`, `targetJobId`, `targetKind`, `reasonCode`, `correlationId`, `status`, nullable `resultCode`, and created/updated/nullable-completed timestamps with the same exact six-fraction UTC contract. It returns neither hashes nor submitted expected-state fields.
11. **Canonical submission fingerprint:** canonical JSON has this insertion order: `targetJobId`, `expectedKind`, `expectedStatus`, `expectedAttempts`, `expectedMaxAttempts`, `expectedUpdatedAt`, `reasonCode`. `expectedStatus` is fixed `failed`, UUIDs are lowercase, and `expectedUpdatedAt` is canonical six-fraction UTC text. Actor, the separately hashed idempotency key, diagnostic correlation, and the fixed `retry_failed_job` kind are excluded. The lowercase SHA-256 of that exact UTF-8 JSON is the input fingerprint; this follows the existing financial-command rule that correlation is diagnostic rather than idempotency input.
12. **Internal job identity:** the payload is exactly `{ "commandId": "<lowercase-uuid>" }`, the type is `operations.job-retry-command`, maximum attempts is `8`, and the deduplication key is `operations:job-retry-command:<command-id>:v1`. The command row does not add an unapproved `job_id` column; the job payload and private claim `command_id` provide the durable association.
13. **Physical database names and internal provenance:** the protected tables in schema `public` are `operations_job_retry_commands` and `operations_job_retry_claims`. Enums are `operations_job_retry_command_status`, `operations_job_retry_result_code`, `operations_job_retry_reason_code`, and `operations_job_retry_claim_state`; command kind remains checked text fixed to `retry_failed_job`. All new constraint, trigger, function, GUC, and advisory-lock names use the `plan7a_operations` prefix. The exact transaction-local settings are `pale_orbit.plan7a_operations_job_capability`, `pale_orbit.plan7a_operations_command_insert_id`, `pale_orbit.plan7a_operations_command_transition_id`, and `pale_orbit.plan7a_operations_job_transition_id`; the lease namespace is `pale-orbit:plan7a-operations-job-lease:<job-id>`. The last three settings are nonsecret routine-to-trigger witnesses, never sole authority: invoker guards also require the expected owner `current_user` and exact row/command/claim linkage. Both replaced insert guards put closed reserved-identity branches before their historical financial-worker/session-identity early returns; the job branch activates on either reserved type/deduplication half and additionally requires an existing exact pending command plus their canonical pairing, while the audit branch activates on either reserved action/resource half and admits only the exact approved pairings. The new invoker job-update guard activates when either `OLD` or `NEW` contains either reserved job-identity half, forbidding entry, exit, or cross-pair mutation except through one exact owner-routine transition with immutable canonical identity.
14. **Authorization before inspection:** TypeScript services call `requireCapability(actor, 'jobs.retry')` before parsing filters, IDs, cursors, expected state, reason, or hashes and before acquiring a client for the requested operation. Owner-controlled routines then take the administrator-role advisory lock, reload current roles, and reauthorize. A new narrow `auditJobRetryRequestDenied` helper wraps the existing `appendAuditEvent` boundary for pre-routine authorization/shape failures and a fixed SQL-time reauthorization denial: action `operations.job_retry.requested`, outcome `denied`, resource type `operations_job_retry_command`, null resource ID, the already-bounded diagnostic correlation ID, and null request/before/after metadata. It may acquire its own audit executor after denial and may not inspect or receive target input. The repository maps an own-data SQLSTATE `42501` from a complete public routine to one fixed nonreflective authorization-changed error; submission audits that outcome once and returns a fixed forbidden error, while list/status return the same fixed forbidden error without audit. SQL owns the `succeeded` requested audit after a valid submission and every terminal audit. Migration `0015` extends the existing audit-insert guard so runtime-only callers may write only that exact operations denial shape and neither runtime nor worker callers can forge successful requests or terminal operations actions.
15. **Audit placement:** every operations event uses resource type `operations_job_retry_command`; pre-routine denial has null resource ID, while SQL-owned requested success and terminal events use the canonical command UUID as resource ID. `audit_events.correlation_id` owns correlation. `after` contains only the allowlisted metadata object `{ commandId, targetJobId, registeredKind, reasonCode, resultCode? }`. `resultCode` is terminal-only. `before` and `request_metadata` remain null until a later route exists; no method or route key is fabricated.
16. **Separate operations capability:** existing financial capability parameters, GUC, claim table, random source, generation, lock prefix, and terminal semantics remain unchanged. `JobRecord` adds optional `operationsJobLeaseCapability` and `operationsJobLeaseGeneration` only for the internal operations kind. The repository interface adds operations-specific renewal/completion/failure methods rather than adding another positional parameter to historical methods.
17. **Terminal replay:** an already-terminal operations command is authoritative replay evidence. Its handler performs no policy effect and returns normally; capability-aware completion succeeds and invalidates the current claim. A denied or failed command therefore does not force the internal job back to failed after its terminal command/audit transaction committed.
18. **Enabled adapters are strict wrappers around the existing rearm primitives:** Stripe locks command → event → exact target job, validates the operations snapshot and existing identity predicates, invokes `rearmPendingStripeEventJob` under those already-held locks, and verifies the exact target was rearmed. Classification locks command → projection authority → enrollment advisory → exact target job, validates the complete authority/identity snapshot, invokes `rearmFinancialClassificationJob` with the exact already-locked identity, and verifies the returned job is that target with no adoption or successor. Neither adapter duplicates the domain transition SQL, broadens either primitive, or makes a provider call.
19. **Specialized ingestion remains separate:** `catalog.ingest_revision` is disabled only in the general operations command. The existing staged-source/checksum/generation-specific admin retry continues unchanged.
20. **Checkpoint D remains deferred:** Checkpoint C updates the migration/role/restore contract and may run existing smoke profiles as compatibility evidence, but it does not create generalized stage evidence or claim release-candidate status.

## Target dependency and authority topology

~~~text
application caller (future route; absent in Checkpoint C)
  -> operations/service
       -> jobs/catalog (safe catalog only)
       -> auth/admin-policy (jobs.retry before input inspection)
       -> operations/jobs/contracts (strict DTO/canonical input)
       -> operations/jobs/repository
            -> owner-controlled list/submit/get routines
                 -> administrator-role lock + current-role reauthorization
                 -> closed safe SQL catalog mirror
                 -> pending command + requested audit + internal job

worker composition
  -> jobs/catalog + exact handler binding validation
  -> jobs/runner
       -> unchanged ordinary/financial paths
       -> operations-specific capability transport
            -> jobs/repository claim/renew/complete/fail
                 -> job row -> exclusive operations lease lock
                 -> private operations claim -> command
       -> operations/jobs/handler
            -> role lock -> shared operations lease lock -> command
            -> operations/jobs/policies registry
                 |-> disabled/excluded fixed result
                 |-> Stripe: command -> event -> target job
                 `-> classification: command -> authority -> enrollment -> target job

migration 0015
  -> protected command/claim tables and exact routines/triggers/ACLs
  -> role provisioner and schema-preservation parity
  -> restore catalog/row counts/executable verifier/checkpoint rehearsal
~~~

Forbidden reverse dependencies are `jobs/catalog -> worker entrypoint|operations service|handler implementations|routes`, `operations/jobs/contracts -> database|worker|providers`, `operations/jobs/service -> worker entrypoint|routes`, and `operations/jobs/policies -> worker entrypoint|provider gateway`. No catalog, DTO, audit, error, log, or restore record may contain a job payload, deduplication key, raw `last_error`, lease owner, clear capability, provider object, customer identity, or arbitrary JSON.

## Execution and evidence discipline

- Work in task order. Use RED → smallest implementation → focused GREEN → self-review → literal-path commit for each independently coherent change.
- A task without a commit step is an intermediate authority phase; do not commit a migration whose matching grants, manifest, or restore contract is knowingly incomplete.
- Run hermetic tests freely. Serialize every Docker, PostgreSQL, Mailpit, Playwright, restore, upgrade, checkpoint, rehearsal, and broad `verify` command; no parallel agent may start a service-backed command.
- Do not use Docker, PostgreSQL, browsers, network providers, or wall-clock leases in unit tests. Inject UUID/capability sources, clocks, policy registries, and database executors. Integration tests use PostgreSQL `clock_timestamp()` as lease authority.
- Before every service-backed command, snapshot existing Compose-labeled containers, networks, volumes, and `pale-orbit-test-storage-*` directories. After the command, prove the exact harness-owned project and temporary root are absent and the baseline is otherwise unchanged. Never remove an unknown or pre-existing resource.
- Do not run broad profiles to diagnose a focused RED. Capture the first failing assertion, correct the demonstrated cause, and rerun the same bounded command.
- Use `apply_patch` for hand edits. Use Drizzle Kit only to generate `0015` and its snapshot/journal metadata; inspect generated SQL, then append the reviewed custom authority SQL. Never edit `0001` through `0014` or prior snapshots.
- Preserve user changes in a dirty worktree. Every path-limited Git command in this plan uses `git --literal-pathspecs`. Stage literal paths, run `git diff --cached --check`, inspect the staged diff, and never use `git add .`.
- Treat clear capabilities as secrets even in tests: fixed canaries may prove absence but may never be printed. Raw provider, payload, hash, lease, SQL, and exception content stays outside safe boundaries.
- No route or Svelte file changes in Checkpoint C. Any such diff is a scope violation unless the approved design is amended first.

Use this exact fail-closed, read-only wrapper in the same PowerShell session for every service-backed command. It preserves the command exit status, always captures post-command state, compares all Compose-labeled resources and harness storage roots, and never deletes anything:

~~~powershell
function Get-CheckpointCServiceBaseline {
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

function Invoke-CheckpointCServiceCommand {
  param(
    [Parameter(Mandatory)]
    [scriptblock]$Command
  )

  $before = Get-CheckpointCServiceBaseline | ConvertTo-Json -Compress -Depth 4
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
    $after = Get-CheckpointCServiceBaseline | ConvertTo-Json -Compress -Depth 4
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
    throw "Checkpoint C service wrapper failed: $($failures -join '; ')"
  }
}
~~~

Invoke exactly one native command per wrapper, for example `Invoke-CheckpointCServiceCommand { npm run test:integration }`. If it fails, inspect exact new labels and paths and let only the owning harness remove resources it proves it owns. Do not turn the wrapper into cleanup logic and do not start a second service command until the discrepancy is resolved.

## File ownership map

### Job catalog and safe contracts

- `src/lib/server/jobs/catalog.ts` owns the exact eleven-row catalog, safe operator metadata, automatic retry owner/maximum, administrative disposition, policy identifier/availability, provider flag, safe list projection, diagnostic metadata parser, and exhaustive validators.
- `src/lib/server/jobs/catalog.test.ts` proves exact matrix completeness, uniqueness, immutability, safe values, diagnostic parsing, SQL-mirror parity, and absence of reverse dependencies.
- `src/lib/server/jobs/handler-bindings.ts` validates an exact one-to-one catalog/handler binding before worker startup without importing handler implementations.
- `src/lib/server/operations/jobs/contracts.ts` owns exact reason/result/status unions, list and owned-command DTOs, filter/cursor parsers, internal payload parser, canonical fingerprint serialization, and safe database-row reconstruction. It stays server-only; later route work must deliberately extract a client-safe response contract instead of importing this module into browser code.

### Database schema and authority

- `src/lib/server/db/schema/job-operations.ts` owns Drizzle enums/tables and only their row types; `src/lib/server/db/schema/index.ts` exports them.
- `drizzle/0015_plan7a_operations_authority.sql` is the sole append-only migration for command/claim storage, the SQL catalog mirror, three public routines, private helpers, triggers, constraints, indexes, revocations, grants, and exact pre/postflight guards.
- `src/lib/server/db/database-role-provision.ts` retains the exact four principals while registering only the new reviewed tables, columns, and routine signatures.
- `scripts/financial-schema-preservation.test.ts`, `scripts/database-role-deployment.test.ts`, migration/integration role tests, and the restore verifier prove exact definitions, owners, direct/inherited ACLs, session guards, and absence of excess authority.

### Application operations boundary

- `src/lib/server/operations/jobs/repository.ts` calls only the three complete public routines and parses every result through `operations/jobs/contracts`.
- `src/lib/server/operations/jobs/audit.ts` exposes only `auditJobRetryRequestDenied`, fixes the denial action/outcome/resource fields, receives no target input, and delegates to the existing append-only audit service.
- `src/lib/server/operations/jobs/service.ts` owns authorize-before-inspection behavior, canonical hashing, narrow denied-audit invocation, and future-route-independent list/submit/status methods.
- Checkpoint C adds no route. A later route must call `operations/jobs/service` and must not duplicate authorization, target inspection, hashing, SQL, or audit.

### Worker capability and policy execution

- `src/lib/server/jobs/types.ts` adds the minimal operations-only in-memory claim fields and repository methods while preserving historical method signatures.
- `src/lib/server/jobs/repository.ts` owns operations capability generation/transport and exact capability-aware claim/renew/complete/fail SQL; its financial and ordinary branches remain behaviorally unchanged.
- `src/lib/server/jobs/runner.ts` selects operations-specific repository methods only for `operations.job-retry-command` and keeps every existing poll, observer, retry, and lease behavior.
- `src/lib/server/operations/jobs/handler.ts` parses only `{ commandId }`, establishes the transaction-local capability, locks/revalidates the command and actor, handles terminal replay, and dispatches one registered policy.
- `src/lib/server/operations/jobs/policies.ts` owns the exact policy registry and disabled/excluded result mapping.
- `src/lib/server/operations/jobs/adapters/stripe-event.ts` and `financial-classification.ts` own the two approved no-provider-call final transactions and published domain lock orders.
- `src/worker.ts` remains the composition root and binds the operations handler only after all contracts exist.

### Restore, checkpoint, and documentation

- `scripts/capture-restore-row-counts.sql` remains catalog-derived and is not hand-edited; restore tests prove its dynamic output includes both new durable tables.
- `scripts/verify-financial-restore.sql` advances the canonical catalog version and verifies every `0015` object, definition, trigger, constraint, owner, ACL, and invariant without exposing clear capability material.
- `scripts/execute-financial-restore-verifier.ts`, checkpoint tests, upgrade fixtures, and distinct-engine rehearsal use that canonical contract rather than duplicating it.
- `README.md`, `docs/database-and-workers.md`, `docs/authentication-and-email.md`, `docs/storage-ingestion-and-publication.md`, and `docs/runtime-environments.md` document migration `0015`, the protected backend, fixed enabled/disabled policies, no manual reset, no provider call, and the continued UI/monitoring/activation deferral.

## Non-negotiable preserved behavior

- Migrations `0001` through `0014` and every prior snapshot remain byte-for-byte unchanged.
- The four database principals remain pairwise distinct. No process receives owner credentials; the runtime/web role receives no table-wide job/outbox/audit/command access; storage cleanup receives no operations authority.
- Existing automatic retry scheduling, `FOR UPDATE SKIP LOCKED` selection, attempt increments, backoff, rerun requests, lease-owner strings, job observer events, heartbeat progress, and safe persisted error text remain unchanged.
- The financial-administrator capability, claim table, GUC, random source, generation, lock namespace, trigger/routine definitions, and success/failure semantics remain unchanged.
- Existing Stripe webhook acceptance and pending-event rearm semantics remain unchanged outside the new operations wrapper. No Stripe API call occurs.
- Existing classification authority, enrollment, replay, scan-run, fingerprint, classifier-version, allocation-version, and active-entity rules remain unchanged.
- Existing revision-ingestion retry continues to require its specialized staged-source/checksum/generation workflow; generic operations cannot invoke it.
- Audit remains append-only and separately allowlisted from DTOs/logs. List and status reads are not audited; valid submission and terminal disposition are each audited exactly once.
- Production remains `APPLICATION_MODE=maintenance` with `STRIPE_ENABLED=false` and `STRIPE_LIVE_MODE=false`. `live` remains rejected.

## Milestone A — exact catalog and application contracts

### Task 1: Verify the approved Checkpoint B handoff and closed production boundary

**Files:** None.

- [ ] **Step 1: Confirm the isolated worktree, ancestry, and approved documents**

```powershell
git status --short --branch
git rev-parse HEAD
git merge-base --is-ancestor 651a12483ce94e330dac6ea83be6ea841b4713da HEAD
if ($LASTEXITCODE -ne 0) { throw 'The accepted Checkpoint B commit is not an ancestor.' }
git merge-base --is-ancestor 1c330693b67a1aa34c413bd8d2ec23ff8628236e HEAD
if ($LASTEXITCODE -ne 0) { throw 'The approved Plan 7A design is not an ancestor.' }
git --literal-pathspecs ls-files --error-unmatch -- `
  docs/superpowers/plans/2026-08-26-plan-7a-checkpoint-c-operations-authority.md
if ($LASTEXITCODE -ne 0) { throw 'The reviewed Checkpoint C plan is not committed.' }
if (-not (Select-String `
  -Path docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md `
  -Pattern '^\*\*Design status:\*\* Approved$' -Quiet)) {
  throw 'Plan 7A design is not approved.'
}
if (-not (Select-String `
  -Path docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md `
  -Pattern '^\*\*Implementation status:\*\* Checkpoints A-B complete; Checkpoints C-D not started$' `
  -Quiet)) {
  throw 'The required Checkpoint B completion status is absent.'
}
git diff --check
```

Expected: the implementation worktree is clean; the reviewed plan commit descends from both fixed source commits; both status assertions pass; and `git diff --check` exits zero. Record the plan-bearing HEAD as the implementation handoff. If `main` advanced, do not silently reinterpret or rebase the checkpoint.

- [ ] **Step 2: Record the exact baseline toolchain and hermetic result**

```powershell
node --version
npm --version
npm ci
npm run test:unit
git status --short
```

Expected: Node is `v26.7.x`, npm is `11.19.x`, installation changes no tracked file, and the accepted warmed baseline reports 248 passing files and 4,194 passing tests. A one-off cold-process timeout must be rerun as the exact focused test and diagnosed under `superpowers:systematic-debugging`; it is not permission to raise timeouts or alter production code. Record the existing 4 low and 4 moderate audit advisories, with no high or critical advisory, but do not run `npm audit fix`.

- [ ] **Step 3: Prove migration, route, provider, and launch closure before edits**

```powershell
$migration = Get-ChildItem -LiteralPath drizzle -Filter '*.sql' |
  Sort-Object Name |
  Select-Object -Last 1 -ExpandProperty BaseName
if ($migration -notmatch '^0014') { throw "Unexpected migration head: $migration" }
if (Get-ChildItem -LiteralPath drizzle -Filter '0015*.sql') {
  throw 'Checkpoint C must start before migration 0015 exists.'
}
foreach ($path in @('src/routes/admin/jobs', 'src/routes/admin/operations')) {
  if (Test-Path -LiteralPath $path) { throw "Unexpected operations route: $path" }
}
rg -n "APPLICATION_MODE|STRIPE_ENABLED|STRIPE_LIVE_MODE" compose.prod.yaml .env.example
```

Expected: the migration head is `0014`; there is no operations route or `0015`; production remains maintenance-only with Stripe disabled; and no Task 1 change is committed.

### Task 2: Establish the exhaustive eleven-row job catalog and sole constant owner

**Files:**

- Create: `src/lib/server/jobs/catalog.ts`
- Create: `src/lib/server/jobs/catalog.test.ts`
- Create: `scripts/job-catalog-boundary.test.ts`
- Modify: `src/lib/server/outbox/repository.ts`
- Modify: `src/lib/server/email/enqueue.ts`
- Modify: `src/lib/server/commerce/email/enqueue.ts`
- Modify: `src/lib/server/commerce/email/enqueue.test.ts`
- Modify: `src/lib/server/commerce/claim-email.ts`
- Modify: `src/lib/server/commerce/claims.ts`
- Modify: `src/lib/server/commerce/job.ts`
- Modify: `src/lib/server/commerce/financial/constants.ts`
- Modify: `src/lib/server/commerce/financial/jobs.ts`
- Modify: `src/lib/server/commerce/financial/admin-commands/handler.ts`
- Modify: `src/lib/server/ingestion/job.ts`
- Modify: `src/lib/server/jobs/repository.ts`

- [ ] **Step 1: Write the exact catalog RED**

Freeze this matrix in `catalog.test.ts`; assert the complete objects, stable order, uniqueness, deep immutability, and the exact five-policy registry:

| Kind | Label | Max | Disposition | Policy | Availability | Diagnostic generation |
| --- | --- | ---: | --- | --- | --- | --- |
| `outbox.dispatch` | `Outbox dispatch` | 8 | `rearm_existing` | `deny_retry_policy_not_enabled` | `disabled` | `none` |
| `commerce.claim-email` | `Claim email` | 8 | `enqueue_successor` | `deny_retry_policy_not_enabled` | `disabled` | `none` |
| `commerce.claim-email-request` | `Claim email request` | 8 | `enqueue_successor` | `deny_retry_policy_not_enabled` | `disabled` | `none` |
| `commerce.stripe-event` | `Stripe event` | 12 | `rearm_existing` | `rearm_pending_stripe_event` | `enabled` | `none` |
| `commerce.financial-source` | `Financial source` | 12 | `enqueue_successor` | `deny_retry_policy_not_enabled` | `disabled` | `none` |
| `commerce.financial-payout` | `Financial payout` | 12 | `enqueue_successor` | `deny_retry_policy_not_enabled` | `disabled` | `none` |
| `commerce.financial-scan` | `Financial scan` | 8 | `enqueue_successor` | `deny_retry_policy_not_enabled` | `disabled` | `none` |
| `commerce.financial-classification` | `Financial classification` | 5 | `rearm_existing` | `rearm_financial_classification` | `enabled` | `none` |
| `commerce.financial-admin-command` | `Financial administrator command` | 8 | `never` | `deny_retry_not_supported` | `excluded` | `none` |
| `catalog.ingest_revision` | `Revision ingestion` | 5 | `enqueue_successor` | `deny_retry_policy_not_enabled` | `disabled` | `payload_generation` |
| `operations.job-retry-command` | `Operations job retry command` | 8 | `never` | `deny_retry_not_supported` | `excluded` | `operations_lease_generation` |

Every row also has:

```ts
automaticRetryOwner: 'postgres_job_repository_exponential_backoff'
providerVerificationRequired: false
providerCallsInPlan7A: false
safeStatuses: ['pending', 'running', 'succeeded', 'failed']
```

The policy registry is exactly:

```ts
[
  'deny_retry_not_supported',
  'deny_retry_policy_not_enabled',
  'deny_provider_recovery_not_enabled',
  'rearm_pending_stripe_event',
  'rearm_financial_classification'
]
```

Prove `deny_provider_recovery_not_enabled` is a valid closed-registry member but no initial row selects it. Prove exactly two rows are `enabled`, exactly two are `excluded`, and every enabled row has `providerCallsInPlan7A: false`.

The catalog also owns the exact policy-outcome matrix mirrored by SQL:

| Policy | Allowed adapter outcome |
| --- | --- |
| `deny_retry_not_supported` | `denied/retry_not_supported` |
| `deny_retry_policy_not_enabled` | `denied/retry_policy_not_enabled` |
| `deny_provider_recovery_not_enabled` | `denied/provider_recovery_not_enabled` (closed interface only; no production row selects it) |
| `rearm_pending_stripe_event` | `succeeded/rearmed_existing`; `denied/target_state_changed`, `domain_state_not_retryable`, or `source_unavailable`; `failed/retry_command_invalid` |
| `rearm_financial_classification` | `succeeded/rearmed_existing`; `denied/target_state_changed`, `domain_state_not_retryable`, or `source_unavailable`; `failed/retry_command_invalid` |

`denied/actor_not_authorized` is the one common pre-policy terminal outcome. Capability-aware early failure/exhaustion routines, not adapters, may produce `failed/retry_command_invalid`, `failed/retry_command_exhausted`, or `failed/unexpected_failure` under their exact source conditions. `successor_enqueued`, `already_current`, and `target_not_failed` remain in the approved protocol vocabulary but no Checkpoint C production policy emits them. Export one exhaustive validator for this matrix and prove its TypeScript/SQL parity; a globally valid status/result family is not sufficient.

- [ ] **Step 2: Write exact safe-failure and boundary REDs**

`safeOperationalFailureCode(kind, lastError)` must map only these exact current persisted messages:

- `invalid_job_identity`
  - outbox: `Outbox job is missing outboxId`, `Invalid auth email payload`, `Invalid commerce email payload`;
  - both claim-email kinds: `Invalid commerce claim-email payload`;
  - Stripe event: `Invalid Stripe event job payload.`;
  - financial source/payout/scan: their exact `Invalid financial ... job identity.` messages;
  - financial classification: `Invalid financial classification job payload.`;
  - financial administrator: `Invalid financial administrator command job identity.` and `Financial administrator command identity is invalid.`;
  - revision ingestion: `Invalid revision ingestion payload`;
  - operations command: `Invalid operations job retry command identity.`;
- `source_unavailable`
  - outbox: `Outbox message does not exist`;
  - Stripe event: `Stripe event no longer exists.`;
  - revision ingestion: `Revision ingestion target does not exist` and `Revision staging metadata is incomplete`;
- `domain_state_not_retryable`
  - both claim-email kinds: `Commerce claim-email order is not eligible`;
  - each financial source/payout/scan/classification exact `... evidence is invalid.` message;
  - financial administrator: `Financial administrator command is already terminal.`, `Financial administrator command was denied.`, and `Financial administrator command conflicted with current state.`;
- `retry_command_exhausted`
  - operations command: `Operations job retry command exhausted.`.

For a registered kind, null returns null. `Transient job handler failure`, `Transient job completion failure`, `Permanent job handler failure`, both bounded financial-administrator failure messages, `Operations job retry command permanently failed.`, every unmatched string, and every malformed value become `unexpected_failure`. An unregistered kind becomes `unregistered_job_kind` before inspecting a hostile `lastError`.

`scripts/job-catalog-boundary.test.ts` must initially fail because production kind/max literals have multiple owners. It may allow only the intentional SQL mirror added in migration `0015`; no handler, route, service, schema module, or test fixture may become another production authority.

- [ ] **Step 3: Run the focused RED**

```powershell
npx vitest run `
  src/lib/server/jobs/catalog.test.ts `
  scripts/job-catalog-boundary.test.ts `
  --reporter=verbose
```

Expected: FAIL because `catalog.ts` and its exports do not exist.

- [ ] **Step 4: Implement the dependency-light catalog**

Use these public types and selectors:

```ts
export const REGISTERED_JOB_KINDS = [
  'outbox.dispatch',
  'commerce.claim-email',
  'commerce.claim-email-request',
  'commerce.stripe-event',
  'commerce.financial-source',
  'commerce.financial-payout',
  'commerce.financial-scan',
  'commerce.financial-classification',
  'commerce.financial-admin-command',
  'catalog.ingest_revision',
  'operations.job-retry-command'
] as const;

export type RegisteredJobKind = typeof REGISTERED_JOB_KINDS[number];
export type OperationalJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type JobRetryDisposition =
  | 'never'
  | 'rearm_existing'
  | 'enqueue_successor'
  | 'provider_verified_recovery';
export type JobRetryPolicyAvailability = 'enabled' | 'disabled' | 'excluded';
export type OperationalJobFailureCode =
  | 'unregistered_job_kind'
  | 'invalid_job_identity'
  | 'source_unavailable'
  | 'domain_state_not_retryable'
  | 'retry_command_exhausted'
  | 'unexpected_failure';

export function isRegisteredJobKind(value: unknown): value is RegisteredJobKind;
export function definitionForJobKind(value: unknown): JobDefinition | undefined;
export function safeOperationalFailureCode(
  kind: unknown,
  lastError: unknown
): OperationalJobFailureCode | null;
```

Export every existing compatibility kind/max constant from this file. Existing domain modules may re-export old public names, but literal declarations must disappear. The catalog imports only dependency-light types; it does not import a handler, worker entrypoint, database client, operations service, route, provider gateway, or Svelte module.

- [ ] **Step 5: Move production constants without changing enqueue behavior**

Replace outbox, claim, Stripe, financial, administrator-command, and ingestion magic strings/maxima with catalog imports. Remove `maxAttempts?: number` from `EnqueueOutboxMessageInput`; all outbox dispatch jobs use the approved maximum 8. Preserve all payloads, deduplication keys, transaction boundaries, retryable/permanent error choices, and the specialized ingestion-retry path.

- [ ] **Step 6: Run focused GREEN and compatibility coverage**

```powershell
npx vitest run `
  src/lib/server/jobs/catalog.test.ts `
  scripts/job-catalog-boundary.test.ts `
  src/lib/server/outbox/repository.test.ts `
  src/lib/server/commerce/email/enqueue.test.ts `
  src/lib/server/commerce/claim-email.test.ts `
  src/lib/server/commerce/job.test.ts `
  src/lib/server/commerce/financial/jobs.test.ts `
  src/lib/server/commerce/financial/admin-commands/handler.test.ts `
  src/lib/server/ingestion/job.test.ts `
  --reporter=verbose
```

Expected: PASS; all TypeScript production kind/max literals have one authority and all historical behavior remains green.

- [ ] **Step 7: Review and commit the catalog**

Use literal pathspecs for only the files named by this task, then:

```powershell
git diff --check
git diff --cached --check
git commit -m "feat: define exhaustive production job catalog"
```

### Task 3: Add exact handler-bijection validation

**Files:**

- Create: `src/lib/server/jobs/handler-bindings.ts`
- Create: `src/lib/server/jobs/handler-bindings.test.ts`
- Test: `src/lib/server/jobs/catalog.test.ts`

- [ ] **Step 1: Write missing, duplicate, unregistered, nonfunction, and ordering REDs**

Test that `createRegisteredJobHandlerMap` accepts the eleven bindings in any input order but returns a read-only map in canonical catalog order. Missing, duplicate, unregistered, and nonfunction bindings all throw exactly:

```text
Worker job handlers do not exactly match the registered catalog
```

Use fake handlers only; do not import the worker entrypoint or production handler implementations.

- [ ] **Step 2: Run the RED**

```powershell
npx vitest run `
  src/lib/server/jobs/handler-bindings.test.ts `
  src/lib/server/jobs/catalog.test.ts `
  --reporter=verbose
```

Expected: FAIL because `handler-bindings.ts` is missing.

- [ ] **Step 3: Implement the dependency-light validator**

```ts
export interface RegisteredJobHandlerBinding {
  readonly kind: RegisteredJobKind;
  readonly handler: JobHandler;
}

export function createRegisteredJobHandlerMap(
  bindings: readonly RegisteredJobHandlerBinding[]
): ReadonlyMap<RegisteredJobKind, JobHandler>;
```

Validate unknown runtime values rather than trusting the TypeScript type. Detect duplicates before insertion, compare the final set to `REGISTERED_JOB_KINDS`, and reconstruct the returned map in catalog order. Keep production composition in `src/worker.ts` deferred until Task 16, when the eleventh handler exists.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npx vitest run `
  src/lib/server/jobs/handler-bindings.test.ts `
  src/lib/server/jobs/catalog.test.ts `
  --reporter=verbose
git --literal-pathspecs add -- `
  src/lib/server/jobs/handler-bindings.ts `
  src/lib/server/jobs/handler-bindings.test.ts
git diff --cached --check
git commit -m "feat: validate registered job handler bindings"
```

### Task 4: Define strict server-only operations DTOs, inputs, and hashes

**Files:**

- Create: `src/lib/server/operations/jobs/contracts.ts`
- Create: `src/lib/server/operations/jobs/contracts.test.ts`

- [ ] **Step 1: Write strict list, cursor, DTO, command, and result REDs**

Test exact job statuses; the three reason codes; all success, denial, and failure result codes; list limit default 50 and bounds 1–100; optional exact kind/status filters; and an all-or-nothing `(updatedAt, jobId)` cursor. Reject explicit nulls, offsets, text search, counts, partial cursors, unknown keys, unknown statuses/kinds, accessors, proxies, cycles, and exotic objects.

Freeze these DTOs:

```ts
export interface OperationalJobDto {
  readonly jobId: string;
  readonly kind: RegisteredJobKind | 'unregistered';
  readonly label: string;
  readonly status: OperationalJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAt: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retryDisposition: JobRetryDisposition;
  readonly policyAvailability: JobRetryPolicyAvailability;
  readonly safeFailureCode: OperationalJobFailureCode | null;
}

export interface JobRetryCommandInput {
  readonly idempotencyKey: string;
  readonly targetJobId: string;
  readonly expectedKind: RegisteredJobKind;
  readonly expectedStatus: 'failed';
  readonly expectedAttempts: number;
  readonly expectedMaxAttempts: number;
  readonly expectedUpdatedAt: string;
  readonly reasonCode: JobRetryReasonCode;
}

export type JobRetryCommandStatusDto =
  | PendingJobRetryCommandStatusDto
  | SucceededJobRetryCommandStatusDto
  | DeniedJobRetryCommandStatusDto
  | FailedJobRetryCommandStatusDto;
```

Every status member contains only `commandId`, fixed kind `retry_failed_job`, `targetJobId`, `targetKind`, `reasonCode`, `correlationId`, `status`, `resultCode`, `createdAt`, `updatedAt`, and `completedAt`. Pending requires null result/completion; each terminal status requires the result family allowed for that status and a completion time.

All UUIDs are canonical lowercase. Every database timestamp must match exactly:

```ts
/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{6}Z$/u
```

Do not use `Date` to parse, normalize, or serialize these values. Tests must reject calendar-invalid dates even when they match the lexical pattern.

- [ ] **Step 2: Freeze the exact canonical hash witness**

For:

```ts
{
  idempotencyKey: '00000000-0000-4000-8000-000000000202',
  targetJobId: '00000000-0000-4000-8000-000000000101',
  expectedKind: 'commerce.stripe-event',
  expectedStatus: 'failed',
  expectedAttempts: 12,
  expectedMaxAttempts: 12,
  expectedUpdatedAt: '2026-08-26T14:15:16.123456Z',
  reasonCode: 'dependency_recovered'
}
```

require exact canonical input:

```json
{"targetJobId":"00000000-0000-4000-8000-000000000101","expectedKind":"commerce.stripe-event","expectedStatus":"failed","expectedAttempts":12,"expectedMaxAttempts":12,"expectedUpdatedAt":"2026-08-26T14:15:16.123456Z","reasonCode":"dependency_recovered"}
```

and exact hashes:

```text
inputFingerprintSha256=e6df7201a7ee2edc48002ab36dfafe042c6f45091bb32d97a14fc863bc04bd1e
idempotencyKeySha256=1a4832b559a43c0d8c0d857fadbf9bc1b6325c144e28b0c9f909d84196cd8220
```

Changing diagnostic correlation must not change the fingerprint. Actor, correlation, clear idempotency key, and fixed kind never enter the canonical JSON.

- [ ] **Step 3: Run the RED**

```powershell
npx vitest run src/lib/server/operations/jobs/contracts.test.ts --reporter=verbose
```

Expected: FAIL because `contracts.ts` is missing.

- [ ] **Step 4: Implement strict reconstruction and preparation**

Export only:

```ts
export class JobOperationsInputError extends Error {
  readonly code = 'invalid_input' as const;
}

export function parseOperationalJobListInput(value: unknown): OperationalJobListInput;
export function parseOperationalJobDto(value: unknown): OperationalJobDto;
export function parseJobRetryCommandStatusDto(value: unknown): JobRetryCommandStatusDto;
export function parseCanonicalOperationsUuid(value: unknown): string;
export function prepareJobRetryCommand(value: unknown): PreparedJobRetryCommand;
```

`parseOperationalJobDto` cross-checks every registered label, maximum, disposition, availability, and safe failure code against the catalog. The `unregistered` sentinel is accepted only with `Unregistered job`, `never`, `excluded`, and `unregistered_job_kind`. Terminal command reconstruction cross-checks target kind, selected catalog policy, status/result, and the common execution-failure exceptions against the exact policy-outcome matrix; it rejects a globally valid but policy-invalid pair. All DTO parsers reject extra payload, deduplication, raw-error, locked-by, lease, provider, actor, expected-state, input, and hash fields.

- [ ] **Step 5: Run GREEN, static checks, and commit**

```powershell
npx vitest run `
  src/lib/server/operations/jobs/contracts.test.ts `
  src/lib/server/jobs/catalog.test.ts `
  --reporter=verbose
npm run check
git --literal-pathspecs add -- `
  src/lib/server/operations/jobs/contracts.ts `
  src/lib/server/operations/jobs/contracts.test.ts
git diff --cached --check
git commit -m "feat: define strict job operations contracts"
```

## Milestone B — append-only database and restore authority

### Task 5: Declare the minimized schema and generate only migration 0015

**Files:**

- Create: `src/lib/server/db/schema/job-operations.ts`
- Create: `src/lib/server/db/schema/job-operations.test.ts`
- Modify: `src/lib/server/db/schema/index.ts`
- Modify: `scripts/financial-schema-preservation.test.ts`
- Generate: `drizzle/0015_plan7a_operations_authority.sql`
- Generate: `drizzle/meta/0015_snapshot.json`
- Modify through Drizzle Kit: `drizzle/meta/_journal.json`

- [ ] **Step 1: Write schema and historical-byte REDs**

Freeze exactly four enum label orders:

```text
operations_job_retry_command_status:
  pending | succeeded | denied | failed

operations_job_retry_result_code:
  rearmed_existing | successor_enqueued | already_current |
  retry_not_supported | retry_policy_not_enabled |
  provider_recovery_not_enabled | target_not_failed |
  target_state_changed | domain_state_not_retryable |
  source_unavailable | actor_not_authorized |
  retry_command_invalid | retry_command_exhausted |
  unexpected_failure

operations_job_retry_reason_code:
  dependency_recovered | configuration_recovered | operator_reassessment

operations_job_retry_claim_state:
  active | invalidated
```

Freeze the exact command column order:

```text
id, kind, actor_user_id, target_job_id, target_job_kind,
expected_status, expected_attempts, expected_max_attempts,
expected_updated_at, reason_code, correlation_id,
idempotency_key_sha256, input_fingerprint_sha256, status,
safe_result_code, created_at, updated_at, completed_at
```

Freeze the exact claim column order:

```text
job_id, command_id, generation, attempt, lease_owner,
capability_sha256, lease_duration_ms, state, expires_at,
issued_at, renewed_at, invalidated_at
```

Assert there is no command `job_id`, JSON/private input, arbitrary reason, clear token/capability column, provider evidence, or delete cascade. The command references the submitting user and target job with `RESTRICT`; the claim references its job and command with `RESTRICT`.

Extend the historical-byte test with the already verified hashes:

```text
drizzle/0012_plan6bii_admin_command_authority.sql
  8bb618005b1c3f42aebaf3e2d8c18aa1028b8c0c68ebc325e5c748be09b43065
drizzle/0013_plan6bii_reporting_correction_authority.sql
  daf2263c57d6916cfd1866f668ba5af090d614455ad5885291501ad75bfd4925
drizzle/0014_plan6bii_issue_transition_fail_closed.sql
  ad1a3c421bd1c16a15b8334b4b4664157988b1c7119a92259f89874527d90b51
drizzle/meta/0012_snapshot.json
  0f9d40c2ccc4333f90914bef6d787f0a5ab835f3d203d19bbbac71123f5c4001
drizzle/meta/0013_snapshot.json
  88395adb4c8a7c3f6337892add36da93f95eebdcb99380d31e623011d0c4cfe6
drizzle/meta/0014_snapshot.json
  65b1746fb89547bee312133720e12504225e0d1f3b87b2d69b313b2462990c74
```

- [ ] **Step 2: Run the schema RED**

```powershell
npx vitest run `
  src/lib/server/db/schema/job-operations.test.ts `
  scripts/financial-schema-preservation.test.ts `
  --reporter=verbose
```

Expected: FAIL because the new schema/export is absent and the journal still ends at index 14.

- [ ] **Step 3: Implement the Drizzle declarations**

Name every constraint and explicit index:

```text
plan7a_operations_retry_commands_pkey
plan7a_operations_retry_commands_actor_fk
plan7a_operations_retry_commands_target_job_fk
plan7a_operations_retry_commands_kind_fixed
plan7a_operations_retry_commands_target_kind_registered
plan7a_operations_retry_commands_expected_state_consistent
plan7a_operations_retry_commands_correlation_canonical
plan7a_operations_retry_commands_hashes_sha256
plan7a_operations_retry_commands_lifecycle_consistent
plan7a_operations_retry_commands_actor_idempotency_unique
plan7a_operations_retry_commands_status_created_idx
plan7a_operations_retry_commands_target_created_idx

plan7a_operations_retry_claims_pkey
plan7a_operations_retry_claims_job_fk
plan7a_operations_retry_claims_command_fk
plan7a_operations_retry_claims_generation_positive
plan7a_operations_retry_claims_attempt_positive
plan7a_operations_retry_claims_lease_owner_canonical
plan7a_operations_retry_claims_capability_sha256
plan7a_operations_retry_claims_lease_duration_bounded
plan7a_operations_retry_claims_lifecycle_consistent
plan7a_operations_retry_claims_command_unique
```

Command expected state is fixed failed with `1 <= attempts <= max <= 2147483647` and a finite timestamp. Command lifecycle requires finite monotonic timestamps, pending/null result/null completion, or a terminal status with `completed_at = updated_at` and the exact current target-kind/policy result allowed by Task 2, including only the common actor-denial and protected early-failure/exhaustion exceptions. A merely valid global result family is insufficient. Claim generation/attempt are positive signed-int32; lease owner is the bounded safe worker token; duration is 1–86,400,000 ms; digest is lowercase SHA-256; active/invalidated timestamps are mutually consistent.

- [ ] **Step 4: Generate once and inspect before custom SQL**

```powershell
npm run db:generate -- --name plan7a_operations_authority
```

Require exactly `drizzle/0015_plan7a_operations_authority.sql`, `drizzle/meta/0015_snapshot.json`, and journal index 15. If Drizzle proposes any change to migrations/snapshots `0001`–`0014`, stop, fix the TypeScript schema, and regenerate. Do not use `drizzle-kit push`.

- [ ] **Step 5: Run generated-schema GREEN without committing**

```powershell
npx vitest run `
  src/lib/server/db/schema/job-operations.test.ts `
  scripts/financial-schema-preservation.test.ts `
  --reporter=verbose
npm run db:check
git diff --check
```

Expected: the model and generated metadata are coherent. Do not commit: the custom routines, ACLs, provisioner, and restore catalog must land atomically with `0015`.

### Task 6: Implement migration authority, routines, ACLs, and database races

**Files:**

- Modify: `drizzle/0015_plan7a_operations_authority.sql`
- Modify: `src/lib/server/db/database-role-provision.ts`
- Modify: `src/lib/server/db/database-role-provision.test.ts`
- Modify: `scripts/database-role-deployment.test.ts`
- Modify: `scripts/financial-schema-preservation.test.ts`
- Modify: `scripts/guest-claim-authority.test.ts`
- Modify: `scripts/with-plan6b-upgrade-database.test.ts`
- Modify: `src/lib/server/jobs/catalog.test.ts`
- Modify: `tests/integration/setup.ts`
- Modify: `tests/integration/financial-schema.test.ts`
- Modify: `tests/integration/financial-migration.test.ts`
- Modify: `tests/integration/database-role-boundaries.test.ts`
- Create: `tests/integration/job-operations-authority.test.ts`
- Create: `tests/integration/job-operations-concurrency.test.ts`

- [ ] **Step 1: Write source-shape, provisioner, and SQL-parity REDs**

Require migration `0015` to have an absolute `0014` preflight; reject name/overload/shadow collisions, unsafe membership/default/direct/parameter ACLs, altered role/database settings, non-origin replication role, rules/inheritance, disabled triggers, or normalized drift in either replaced historical guard. At the start of the migration transaction and before the emptiness query, DDL, or mutation, execute two explicit `LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE` statements in the fixed order `public.jobs` then `public.audit_events`—not one dynamically ordered relation list—and hold both locks through commit. This order matches command/job-before-audit production mutation and blocks every concurrent row insert/update/delete across the guard-replacement window without blocking plain inspection. Under those locks, require the newly reserved data namespaces to be empty: no job has exact type `operations.job-retry-command`, no job deduplication key begins `operations:job-retry-command:`, no audit action begins `operations.job_retry.`, and no audit resource type equals `operations_job_retry_command`. Any one collision raises SQLSTATE `55000` with fixed message `Plan 7A operations namespace is not empty`; do not reinterpret or adopt pre-existing rows. Its complete postflight fingerprints every created or replaced object and proves untouched historical authority remains exact.

Add committed-`0014` negative upgrade fixtures for each reserved type/prefix/resource collision. Each fixture seeds exactly one otherwise-valid historical row, attempts `0015`, and proves the migration fails before journal advance or object creation while the seeded row and the entire `0014` catalog remain unchanged. Also add barrier-based, independent-client races for every reserved job/audit namespace—never sleep-only checks—covering both sides of lock acquisition: a pre-lock insert or financial-worker job update commits before migration can inspect and is then detected, while an insert/update started after the migration holds both locks is visibly blocked and, after `0015` commits, resumes only against the replaced insert/update guard and fails without residue. Assert the exact fixed lock order with `pg_blocking_pids` and bounded lock/test timeouts. Keep these distinct from the late-`0015` fault-injection fixture, which proves transactional rollback after partial statements on a collision-free database.

Add a hermetic extractor that compares every TypeScript catalog field and every safe-failure mapping to the closed SQL mirror byte-for-byte. There is no second hand-maintained test matrix.

The final SQL catalog helper returns:

```text
kind, label, max_attempts, automatic_retry_owner,
retry_disposition, policy_adapter, policy_availability,
provider_verification_required, provider_calls_in_plan7a,
administrator_retry_excluded, safe_statuses, diagnostic_generation,
allowed_policy_outcomes
```

`allowed_policy_outcomes` is a canonical ordered text array of `status/result` tokens from Task 2; the SQL helper and TypeScript catalog must agree byte-for-byte.

The owner-only `plan7a_operations_safe_failure_code(text,text)` implements the exact Task 2 mapping. Both helpers are `SECURITY DEFINER`, `search_path = 'pg_catalog'`, and have no runtime, worker, cleanup, or PUBLIC execution.

- [ ] **Step 2: Freeze all routine signatures**

The only application-callable routines are the three design signatures, returning safe columns only:

```sql
list_operational_jobs(
  uuid, text, text, timestamptz, uuid, integer
)

submit_job_retry_command(
  uuid, uuid, text, integer, integer, timestamptz,
  text, text, text, text
)

get_owned_job_retry_command(uuid, uuid)
```

`list_operational_jobs` returns `job_id`, safe `kind`, `label`, `status`, attempts/max, canonical text run/completed/created/updated timestamps, disposition, policy availability, and safe failure code. The two command routines return only the exact `JobRetryCommandStatusDto` fields. Every timestamp returned across a protected public or private routine boundary is text, never raw `timestamptz`: in particular `plan7a_operations_lock_job_retry_command` returns submitted `expected_updated_at` as canonical text and `plan7a_operations_transition_job_retry_command` returns canonical completion text. The approved cursor and expected-state input signatures remain `timestamptz`; repositories bind already-canonical text and cast it explicitly without constructing a `Date`. Format every returned timestamp with:

```sql
pg_catalog.to_char(
  pg_catalog.timezone('UTC', timestamp_value),
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
)
```

Filter/order comparisons remain on raw `(updated_at,id)`. Validate nullable cursor pairs, exact kind/status, and page size before reading `jobs`.

The worker-callable surface is exactly:

```sql
plan7a_operations_claim_job(uuid,text,integer)
plan7a_operations_renew_job_claim(uuid,text,integer,integer)
plan7a_operations_relinquish_job(uuid,text,integer,integer,text,integer)
plan7a_operations_complete_job(uuid,text,integer,integer)
plan7a_operations_fail_job(uuid,text,integer,integer,text)
plan7a_operations_exhaust_job(uuid,text,integer,integer)
plan7a_operations_lock_job_retry_command(uuid,uuid,text,integer,integer)
plan7a_operations_transition_job_retry_command(
  uuid,uuid,text,integer,integer,operations_job_retry_result_code
)
```

The owner-only capability helper is:

```sql
plan7a_operations_assert_job_capability(
  uuid,uuid,text,integer,integer
)
```

Every application-callable, worker-callable, and owner-only helper routine uses `SECURITY DEFINER`, pinned `pg_catalog`, exact validation, and nonreflective failures. Public routines use fixed `42501` authorization, `22023` input, and `40900` stale/idempotency-conflict failures where applicable. Private capability/transition routines and the owner-only assertion helper collapse authority predicate failures to the single fixed SQLSTATE `55000` error. The new row-transition trigger functions are `SECURITY INVOKER`; direct worker DML therefore retains worker `current_user`, while DML inside an owner routine reaches the guard as that routine owner. The two replaced historical guards retain their existing security mode and pinned search path.

- [ ] **Step 3: Write complete PostgreSQL RED witnesses**

Before finishing custom SQL, add tests for:

- exact enum/table/column/default/nullability/constraint/index/FK/trigger catalogs and all four exact transaction-local setting names;
- list bounds, filters, cursor pairing, raw descending keyset order, microsecond text, sentinel handling, and prohibited-field absence;
- exact application and private routine definitions, owner/security/search-path, direct versus inherited ACLs, and all `session_user` guards;
- successful request audit, owner-scoped status, cross-owner absence, exact replay, changed-input conflict, stale target conflict, and one command/job/request audit under racing submissions;
- canonical fingerprint/idempotency witnesses from Task 4;
- a fresh idempotency key with a well-formed but incorrect input fingerprint, proving SQL independently rebuilds the exact canonical preimage/hash and rolls back command, job, and audit rather than trusting the first caller-supplied digest;
- command immutability, exact target-policy/result combinations rather than only global result families, nondeletability, audit atomicity, direct runtime-only plus financial-worker attempts to insert an orphan operations job, and financial-worker attempts to update a job into/out of/cross-pair the reserved identity with each/all nonsecret provenance settings forged;
- fresh digest-only claims, generation rotation, current-call duration replacement on both ordinary and final takeovers, `issued_at = lease_now`/`renewed_at = NULL` issuance, atomic same-clock job/claim renewal, PostgreSQL-clock expiry/invalidation, final-attempt zero-row synchronization, and terminal replay;
- missing, malformed, forged, expired, invalidated, prior-generation, cross-job, cross-attempt, and cross-worker capabilities all failing identically;
- administrator-role serialization, shared handler versus exclusive takeover advisory-lock evidence, terminal-sync races, forced-audit rollback, and no deadlock;
- fixed clear-capability canaries absent from all database text, JSON, errors, catalog output, and evidence.

Add new tables before `audit_events`/`jobs` in integration truncation order:

```sql
operations_job_retry_claims,
operations_job_retry_commands,
audit_events,
-- existing dependent tables
jobs
```

- [ ] **Step 4: Run service-free and serialized service RED**

```powershell
npx vitest run `
  src/lib/server/db/schema/job-operations.test.ts `
  src/lib/server/db/database-role-provision.test.ts `
  src/lib/server/jobs/catalog.test.ts `
  scripts/database-role-deployment.test.ts `
  scripts/financial-schema-preservation.test.ts `
  scripts/guest-claim-authority.test.ts `
  scripts/with-plan6b-upgrade-database.test.ts `
  --reporter=verbose
```

Expected: FAIL on absent routine inventories, stale journal/head assertions, or incomplete migration bodies.

```powershell
Invoke-CheckpointCServiceCommand {
  npm run test:integration -- `
    tests/integration/financial-schema.test.ts `
    tests/integration/database-role-boundaries.test.ts `
    tests/integration/job-operations-authority.test.ts `
    tests/integration/job-operations-concurrency.test.ts `
    --reporter=verbose
}
```

Expected: FAIL on the deliberate missing authority, with the resource baseline restored.

- [ ] **Step 5: Complete storage, transition, claim, and audit authority**

Submission atomically creates one pending command, exact internal job, and one `operations.job_retry.requested`/`succeeded` audit. Before either first insert or replay logic, SQL reconstructs the exact Task 4 canonical JSON from normalized scalar arguments, formats `expected_updated_at` to six fractional UTC digits, computes lowercase SHA-256 itself, and compares it with the supplied fingerprint. A fresh key carrying any other well-formed digest raises fixed `40900` without command, job, or audit. Exact replay under `(actor_user_id,idempotency_key_sha256)` returns the original status without a second job or audit, even if diagnostic correlation differs. Different semantic input or stale target disagreement likewise raises `40900` without mutation.

Build the preimage by explicit ordered concatenation with `pg_catalog.to_json(value)::text` for each string and canonical decimal integer text; do not use `jsonb`, whose key order differs, or `json_build_object(... )::text`, whose whitespace differs from `JSON.stringify`. The SQL preimage is byte-for-byte:

```sql
'{"targetJobId":' || pg_catalog.to_json(target_job::text)::text ||
',"expectedKind":' || pg_catalog.to_json(expected_kind)::text ||
',"expectedStatus":"failed"' ||
',"expectedAttempts":' || expected_attempts::text ||
',"expectedMaxAttempts":' || expected_max_attempts::text ||
',"expectedUpdatedAt":' || pg_catalog.to_json(canonical_expected_updated_at)::text ||
',"reasonCode":' || pg_catalog.to_json(reason_code::text)::text || '}'
```

Hash `pg_catalog.convert_to(canonical_input, 'UTF8')` with `pg_catalog.sha256` and lowercase hex encoding; the fixed witness must equal Task 4 in both Node and PostgreSQL.

The internal job is exactly:

```json
{"commandId":"<canonical-lowercase-uuid>"}
```

with kind `operations.job-retry-command`, maximum 8, and dedupe `operations:job-retry-command:<command-id>:v1`.

Add only these new triggers:

```text
plan7a_operations_retry_commands_update_guard
  -> plan7a_operations_guard_command_update()
plan7a_operations_retry_commands_delete_guard
  -> plan7a_operations_guard_command_delete()
plan7a_operations_jobs_transition_guard
  -> plan7a_operations_guard_job_transition()
```

Replace—but do not edit historical migrations for—`plan6b_guard_job_insert()` and `plan6b_guard_audit_insert()`. In `plan6b_guard_job_insert()`, put one closed reserved-namespace branch **before** the historical runtime-only/session-identity early return. Enter it when `NEW.type = 'operations.job-retry-command'` **or** the deduplication key begins `operations:job-retry-command:`; requiring only the type selector would let a caller pollute the reserved deduplication namespace through another historically allowed type. The historical early return admits a financial-worker `session_user`, which inherits the runtime job-insert columns, and therefore cannot bypass this branch. The branch accepts only when both the exact type and canonical per-command deduplication key are present together with the matching command-insert GUC, an already-visible exact pending command row, canonical command payload, maximum 8, and every normal web-job default. Any selected row that does not satisfy all predicates raises fixed SQLSTATE `55000` and cannot fall through to the historical early return. After that branch, preserve the early return and every prior non-operations branch byte-for-byte after normalization.

In the audit guard, put one closed reserved-namespace branch **before** the historical runtime-only/session-identity early return; otherwise a financial-worker session could inherit audit insert authority and bypass the new checks. Enter it when the action begins `operations.job_retry.` **or** resource type equals `operations_job_retry_command`, so neither half of the reserved identity can be paired with an unrelated historical value. Allow only:

- a runtime-only, non-worker direct insert for the exact pre-routine requested/denied shape: resource type `operations_job_retry_command`, null resource ID, null request/before/after, bounded actor/correlation, and no operations provenance setting;
- requested/succeeded only when `current_user` is the exact `submit_job_retry_command` owner, `pale_orbit.plan7a_operations_command_insert_id` equals the command/resource/`after.commandId`, and the immutable command actor/target/kind/reason/correlation linkage matches; and
- succeeded/denied/failed terminal actions only when `current_user` is the exact owning transition/fail/exhaust routine owner, `pale_orbit.plan7a_operations_command_transition_id` equals the command/resource/`after.commandId`, and status, result, actor, target, kind, reason, correlation, and exact policy/source outcome all match the locked command.

Reject every unknown operations action/resource pairing and every direct runtime or worker attempt to forge requested success or terminal provenance, even when the caller sets all known custom settings. After this closed branch, retain the historical early return and every non-operations branch byte-for-byte after normalization. Separately prove runtime-only and financial-worker direct inserts fail for a canonical-looking orphan operations job, an allowed historical job type carrying the reserved deduplication prefix, a reserved audit action carrying another resource type, and the reserved resource type carrying another action—even after setting the command-insert setting and all other known operations GUCs; no job, command, claim, or audit residue may remain.

Prove financial-worker direct updates likewise fail when moving an ordinary row into either/both reserved job halves, moving an operations row out of either/both halves, or cross-pairing them, even with the real current clear capability and every provenance GUC; runtime-only update fails at ACL before the trigger. All rejected updates leave both the job and claim unchanged.

Pin mutation provenance rather than relying on row shape alone:

- `submit_job_retry_command` sets `pale_orbit.plan7a_operations_command_insert_id` transaction-locally to the new command UUID immediately around the exact command/internal-job insert. The operations branch added to `plan6b_guard_job_insert()` requires that value, an existing exact pending command, canonical payload/deduplication identity, and the normal web-job defaults. A caller-set value without the protected command row and unique binding cannot admit an operations job.
- Owner routines set `pale_orbit.plan7a_operations_command_transition_id` immediately around an authorized command update. `plan7a_operations_guard_command_update()` is invoker-security and requires the expected owner `current_user`, the matching command UUID, an allowed pending-to-terminal transition, and exact immutable fields.
- Owner routines set `pale_orbit.plan7a_operations_job_transition_id` immediately around an operations-job update. `plan7a_operations_guard_job_transition()` is invoker-security and first enters whenever `OLD.type` or `NEW.type` equals `operations.job-retry-command`, or either old/new deduplication key begins `operations:job-retry-command:`. Once selected, `OLD.id = NEW.id`, `OLD.created_at = NEW.created_at`, and both rows must retain the same exact canonical operations type, payload, command-derived deduplication key, and maximum; any transition into, out of, or cross-pairing either reserved half raises fixed `55000`. Only then may the guard require the expected owner `current_user`, matching old/new job UUID/provenance setting, live exact claim/capability linkage, and the one complete lifecycle transition shape owned by the calling routine, rejecting every extra changed column. A nonreserved old/new pair returns unchanged so historical jobs retain their existing worker behavior.

The three provenance settings are nonsecret and may remain transaction-local until transaction end because direct DML after a definer routine returns no longer has owner `current_user`; no guard treats a caller-writable setting as sufficient. They and the capability setting have no role/database default or parameter ACL, never enter a row, DTO, audit, log, error, or evidence payload, and are covered by direct-DML forgery tests.

Terminal audit actions/outcomes are exact:

```text
operations.job_retry.succeeded / succeeded
operations.job_retry.denied    / denied
operations.job_retry.failed    / failed
```

Successful requested/terminal `after` contains only `commandId`, `targetJobId`, `registeredKind`, `reasonCode`, and terminal-only `resultCode`; correlation stays in its column.

The SQL catalog mirror exposes the exact policy-outcome matrix from Task 2. `plan7a_operations_transition_job_retry_command`, the command update guard, and the lifecycle constraint all reject a status/result that is globally well-formed but invalid for the command's frozen target kind and selected policy. Capability-aware fail/exhaust routines admit only their exact fixed failure codes and provenance. Integration tests attempt every cross-policy forgery, including Stripe/`successor_enqueued`, a disabled row/`target_state_changed`, and an excluded row/`rearmed_existing`.

- [ ] **Step 6: Implement exact claim and lock semantics**

The clear 43-character capability is read only from transaction-local `pale_orbit.plan7a_operations_job_capability`; only its lowercase digest persists. Claim/takeover/complete/relinquish/fail/exhaust lock:

```text
internal job row
→ exclusive pale-orbit:plan7a-operations-job-lease:<job-id>
→ private claim
→ command
```

Renewal locks job row → shared lease advisory → claim. It validates the exact running job/owner/attempt and live claim/generation/digest first, then takes one `renew_now := clock_timestamp()` observation and atomically sets job `locked_at = renew_now`, `updated_at = renew_now`, and `run_at = renew_expires_at` while setting claim `renewed_at = renew_now` and `expires_at = renew_expires_at`, where `renew_expires_at = renew_now + persisted current-generation lease_duration_ms`. Every other job and claim field remains unchanged. Thus the queue row and private claim always expose the same expiry window; neither can appear expired while the other is current. Handler lock is administrator-role advisory → shared lease advisory → command. No path locks command before waiting for the internal job or exclusive lease.

Every successful pending claim or expired takeover below the ceiling consumes the current call's fresh capability and validated duration. A first issuance inserts generation 1; every later issuance advances the prior generation exactly once. Each issuance replaces claim attempt, owner, digest, and `lease_duration_ms`, sets claim `issued_at = lease_now`, `renewed_at = NULL`, `expires_at = lease_expires_at`, `state = 'active'`, and `invalidated_at = NULL`, and changes the job to running with `locked_at = updated_at = lease_now`, `locked_by` equal to that owner, and `run_at = lease_expires_at`, where `lease_expires_at = lease_now + current lease_duration_ms` from one PostgreSQL clock observation. Only the atomic renewal above sets non-null `renewed_at`. Tests deliberately vary prior and current call durations on an ordinary expired takeover so retaining the old job or claim window fails.

Every running operations job already has one private claim; a missing or mismatched claim is an authority failure, never a reason to weaken the job-transition guard. For an expired running job at the exact attempt ceiling, `plan7a_operations_claim_job` must apply the same issuance invariant under the published job row → exclusive lease advisory → claim → command order before any terminal job update: generation becomes exactly prior generation plus one, attempt remains exactly `max_attempts` without increment, and the job is adopted to the current owner/`lease_now` without changing its attempt count. `plan7a_operations_guard_job_transition()` therefore observes a live exact job/generation/attempt/owner/capability/GUC binding during terminal synchronization.

With that fresh live binding, a pending command becomes failed/`retry_command_exhausted` with one terminal audit while the internal job becomes failed with bounded error `Operations job retry command exhausted.`; an already-terminal command performs no effect or second audit and synchronizes the internal job to succeeded. Either branch invalidates the just-rotated claim atomically and returns zero rows. The fresh clear capability is never returned in a `JobRecord` and is discarded by the caller; after commit neither the expired prior capability nor the newly consumed capability can authorize any operation. Any failed validation or transition rolls back the rotation and all terminal mutations. Relinquish accepts only the two fixed transient runner messages and an integer backoff duration, then anchors `run_at` to `clock_timestamp()`.

- [ ] **Step 7: Apply exact grants and provisioner inventories**

Add the three public signatures to the runtime execute inventory and the eight private signatures to the financial-worker execute inventory. Public routines have direct owner/runtime tuples; worker effective execution is inherited and rejected by the web-surface guard. Private routines have only owner/financial-worker tuples. Owner-only helpers/trigger functions and both tables have no runtime, worker, cleanup, login, column, or PUBLIC tuple.

Public routines require runtime membership while excluding financial-worker and cleanup identities before inspecting inputs; the owner fails the application-caller guard. Private routines admit owner/financial-worker only. Preserve the four pairwise-distinct principals and every default ACL.

- [ ] **Step 8: Run GREEN and upgrade evidence without committing**

In `tests/integration/financial-migration.test.ts`, add a committed-`0014` → `0015` atomicity fixture. Against a disposable `0014` database, use the migration harness's test-only fault hook (or an in-memory fault-injected migration copy, never an edit to the checked-in file) to raise after the new DDL and both historical guard replacements but before the migration transaction commits. Prove the journal remains at `0014`, every `0015` object is absent, both guards retain their exact pre-`0015` definitions, data is unchanged, and no partial ACL/default/setting change survives. Remove the fault, apply `0015` exactly once, verify every new/replaced descriptor, and prove a second migrator pass is a no-op.

```powershell
npx vitest run `
  src/lib/server/db/schema/job-operations.test.ts `
  src/lib/server/db/database-role-provision.test.ts `
  src/lib/server/jobs/catalog.test.ts `
  scripts/database-role-deployment.test.ts `
  scripts/financial-schema-preservation.test.ts `
  scripts/guest-claim-authority.test.ts `
  scripts/with-plan6b-upgrade-database.test.ts `
  --reporter=verbose

Invoke-CheckpointCServiceCommand {
  npm run test:integration -- `
    tests/integration/financial-schema.test.ts `
    tests/integration/database-role-boundaries.test.ts `
    tests/integration/job-operations-authority.test.ts `
    tests/integration/job-operations-concurrency.test.ts `
    --reporter=verbose
}

Invoke-CheckpointCServiceCommand { npm run test:plan6b-upgrade }
```

`test:plan6b-upgrade` executes the modified `tests/integration/financial-migration.test.ts` against every supported historical fixture. Expected: exact migration count 16, no excess authority, no duplicate outcome/audit, no deadlock, every collision-free historical fixture upgrades without data loss and is a no-op on a second migrator pass, while each dedicated reserved-namespace collision fixture fails before mutation with its original data and `0014` journal intact. Do not commit until restore Task 7 is green.

### Task 7: Advance the executable restore and checkpoint contract with 0015

**Files:**

- Modify: `scripts/verify-financial-restore.sql`
- Modify: `scripts/execute-financial-restore-verifier.ts`
- Modify: `scripts/commerce-operations.test.ts`
- Modify: `scripts/deployment-checkpoint.test.ts`
- Modify: `scripts/deployment-checkpoint-runtime.test.ts`
- Modify: `scripts/deployment-backup-bundle.test.ts`
- Modify: `tests/service/financial-restore-witness.test.ts`
- Modify exact executable marker only: `docs/stripe-financial-reconciliation.md`
- Verify dynamically: `scripts/capture-restore-row-counts.sql`

- [ ] **Step 1: Write the v1 restore-contract RED**

Require:

```text
plan7a-database-catalog-v1
0015_plan7a_operations_authority
protected journal count 16
```

and explicitly reject `plan6b-financial-catalog-v4` as the current marker. Preserve every **unaffected** v4 descriptor byte-for-byte. Recalibrate only the intentionally replaced `plan6b_guard_job_insert` and `plan6b_guard_audit_insert` function descriptors, add the new jobs transition trigger and all other `0015` descriptors, and prove no unrelated v4 digest changed. This is a version advance plus complete `0015` expansion, not a reset.

```powershell
npx vitest run `
  scripts/commerce-operations.test.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/deployment-checkpoint-runtime.test.ts `
  scripts/deployment-backup-bundle.test.ts `
  --reporter=verbose
```

Expected: FAIL on the old marker and `0014` current head.

- [ ] **Step 2: Extend the canonical executable inventory**

Add all four enums, both tables, every shape/owner/ACL/constraint/FK/index/trigger descriptor, the three public and eight worker routines, owner-only helpers, replaced guard definitions, the four exact GUC names and absence of role/database defaults or parameter ACLs, SQL catalog rows, command/job/claim/audit invariants, and clear-capability absence.

Load `0015` alongside `0012`–`0014`; source-parity repair extracts the reviewed definitions from the migration rather than duplicating them in TypeScript. Add reversible corruption witnesses for missing/excess/wrong objects, enum order, catalog drift, routine source/owner/security/search-path/ACL, disabled/reordered triggers, excess direct/effective authority, stale guards, claim association/lifecycle/digest, audit provenance, and a synthetic clear-token column/value.

`capture-restore-row-counts.sql` remains a catalog-derived query. Tests prove its output now contains both new base tables; do not replace it with a hand-maintained list.

- [ ] **Step 3: Calibrate once through the disposable verifier path**

Only after migration/role tests are green, use the existing bounded `--print-financial-catalog-contract` service path. Require one BEGIN/END payload; independently recompute every descriptor digest; reject duplicate keys, sentinels, or truncation; remove the unique calibration log in `finally`; and never print a clear capability.

Mechanically replace the executable marker in `docs/stripe-financial-reconciliation.md` so its bytes equal the SQL marker. Do not hand-edit descriptor hashes.

- [ ] **Step 4: Run restore/checkpoint GREEN**

```powershell
npx vitest run `
  scripts/commerce-operations.test.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/deployment-checkpoint-runtime.test.ts `
  scripts/deployment-backup-bundle.test.ts `
  --reporter=verbose

Invoke-CheckpointCServiceCommand { npm run test:service -- --reporter=verbose }
```

Expected: prior financial witnesses plus exact operations schema/catalog/ACL/capability/audit evidence pass, the dynamic row-count inventory contains both tables, and the harness leaves no resource delta. Fresh coordinated capture and operator-supplied distinct-engine release-candidate rehearsal remain deferred until Checkpoint D.

- [ ] **Step 5: Review and commit the single database-authority change**

Stage only every Task 5–7 path with literal pathspecs. Inspect the complete generated/custom migration, snapshot/journal diff, provisioner, tests, executable verifier, and marker; then:

```powershell
git diff --cached --check
git diff --cached --stat
git commit -m "feat: add protected operations retry authority"
```

The commit is acceptable only if migration `0015`, its direct/inherited ACL proofs, restore contract, checkpoint consumers, and exact SQL/TypeScript catalog parity are all present together.

## Milestone C — authorization-first application operations boundary

### Task 8: Add the protected-routine repository and strict row reconstruction

**Files:**

- Create: `src/lib/server/operations/jobs/repository.ts`
- Create: `src/lib/server/operations/jobs/repository.test.ts`

- [ ] **Step 1: Write exact SQL-call and result-shape REDs**

Render and assert only these calls, in this argument order:

```sql
public.list_operational_jobs(
  actor, status, kind, before_updated_at, before_id, page_size
)

public.submit_job_retry_command(
  actor, target_job, expected_kind, expected_attempts,
  expected_max_attempts, expected_updated_at, reason_code,
  correlation_id, idempotency_key_sha256, input_fingerprint_sha256
)

public.get_owned_job_retry_command(actor, command_id)
```

The repository passes exact six-fraction cursor/expected timestamps as bound text cast to `timestamptz`; it never constructs a `Date`. Reject more list rows than the requested limit, zero/multiple submit rows, multiple status rows, invalid result/status pairs, wrong catalog labels/maxima/disposition/availability, noncanonical timestamps, or any extra payload, dedupe, raw error, lease, private input, hash, actor, or provider column.

- [ ] **Step 2: Run the RED**

```powershell
npx vitest run src/lib/server/operations/jobs/repository.test.ts --reporter=verbose
```

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement the exact repository interface**

```ts
export interface SubmitJobRetryCommandRepositoryInput {
  readonly actorId: string;
  readonly command: JobRetryCommandInput;
  readonly correlationId: CorrelationId;
  readonly idempotencyKeySha256: string;
  readonly inputFingerprintSha256: string;
}

export interface JobOperationsRepository {
  listOperationalJobs(
    input: OperationalJobListInput & { readonly actorId: string }
  ): Promise<readonly OperationalJobDto[]>;

  submitJobRetryCommand(
    input: SubmitJobRetryCommandRepositoryInput
  ): Promise<JobRetryCommandStatusDto>;

  getOwnedJobRetryCommand(input: {
    readonly actorId: string;
    readonly commandId: string;
  }): Promise<JobRetryCommandStatusDto | null>;
}

export function createPostgresJobOperationsRepository(
  database: Database
): JobOperationsRepository;
```

Inspect only an own data `code` property. Map `40900` to:

```ts
export class JobRetryCommandSubmissionConflictError extends Error {
  readonly code = 'conflict' as const;
  constructor() {
    super('The job retry command conflicts with current state.');
    this.name = 'JobRetryCommandSubmissionConflictError';
  }
}
```

Map `42501` from any of the three complete public routines to:

```ts
export class JobOperationsAuthorizationChangedError extends Error {
  readonly code = 'authorization_changed' as const;
  constructor() {
    super('Job operations authorization is no longer current.');
    this.name = 'JobOperationsAuthorizationChangedError';
  }
}
```

Attach no database error or cause. Every other database error propagates. Every row-shape error becomes one fixed `JobOperationsRepositoryError` without attaching the returned row, query, SQL, or cause. Submission passes scalar fields only—never canonical JSON, arbitrary JSON, clear idempotency key, actor roles, or target payload.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npx vitest run `
  src/lib/server/operations/jobs/repository.test.ts `
  src/lib/server/operations/jobs/contracts.test.ts `
  --reporter=verbose
npm run check
git --literal-pathspecs add -- `
  src/lib/server/operations/jobs/repository.ts `
  src/lib/server/operations/jobs/repository.test.ts
git diff --cached --check
git commit -m "feat: call protected job operations routines"
```

### Task 9: Add denied-request audit and authorization-first services

**Files:**

- Create: `src/lib/server/operations/jobs/audit.ts`
- Create: `src/lib/server/operations/jobs/audit.test.ts`
- Create: `src/lib/server/operations/jobs/service.ts`
- Create: `src/lib/server/operations/jobs/service.test.ts`
- Create: `scripts/job-operations-boundaries.test.ts`
- Create: `tests/integration/job-operations-service.test.ts`

- [ ] **Step 1: Write hostile-input authorization-order REDs**

For list, submit, and owned status, pass proxies whose `ownKeys`, property reads, or coercions throw. Anonymous, guest, system, and an administrator denied `jobs.retry` must fail before the hostile operation input, actor UUID parsing, hashing, repository construction, or repository call.

Submission receives a separately constructed, already-bounded Checkpoint B web diagnostic context:

```ts
export interface JobRetryRequestContext {
  readonly correlationId: CorrelationId;
}
```

It is not part of the command fingerprint. The future route must obtain it from the validated request context rather than from form/body/query input.

- [ ] **Step 2: Write the narrow denied-audit RED**

Export only:

```ts
export async function auditJobRetryRequestDenied(
  database: DatabaseExecutor,
  actor: Actor,
  correlationId: CorrelationId
): Promise<void>;
```

Its fixed call to `appendAuditEvent` is:

```ts
{
  actor,
  action: 'operations.job_retry.requested',
  outcome: 'denied',
  resourceType: 'operations_job_retry_command',
  resourceId: null,
  correlationId,
  requestMetadata: null,
  before: null,
  after: null
}
```

The function receives no target, expected state, key, hash, reason, payload, method, or route. Initial authorization errors, authorized parse/size failures, repository `conflict`, and `JobOperationsAuthorizationChangedError` each invoke it once and then preserve the original safe denial if the audit succeeds. For the SQL-time authorization-changed case, throw a fresh `AuthorizationError('forbidden', 403)` after audit; never expose the database error. If denied-audit persistence fails, throw one fixed `JobOperationsAuditError` without a cause; never continue to repository mutation.

List/status reads and valid submission do not call this helper. The protected SQL submission owns the single successful requested audit; terminal SQL owns terminal audit.

- [ ] **Step 3: Run the RED**

```powershell
npx vitest run `
  src/lib/server/operations/jobs/audit.test.ts `
  src/lib/server/operations/jobs/service.test.ts `
  scripts/job-operations-boundaries.test.ts `
  --reporter=verbose
```

Expected: FAIL because the audit/service/static-boundary modules are missing.

- [ ] **Step 4: Implement exact services**

```ts
export interface JobOperationsServiceDependencies {
  readonly repository?: JobOperationsRepository;
  readonly capabilityResolver?: CapabilityResolver;
  readonly auditDenied?: typeof auditJobRetryRequestDenied;
}

export async function listOperationalJobs(
  database: Database,
  actor: Actor,
  input: unknown = {},
  dependencies: JobOperationsServiceDependencies = {}
): Promise<readonly OperationalJobDto[]>;

export async function submitJobRetryCommand(
  database: Database,
  actor: Actor,
  input: unknown,
  context: JobRetryRequestContext,
  dependencies: JobOperationsServiceDependencies = {}
): Promise<JobRetryCommandStatusDto>;

export async function getOwnedJobRetryCommand(
  database: Database,
  actor: Actor,
  commandId: unknown,
  dependencies: JobOperationsServiceDependencies = {}
): Promise<JobRetryCommandStatusDto | null>;
```

List order is capability → actor/filter parsing → repository. Status order is capability → actor/command parsing → repository. Submission order is capability → actor/context/input parsing → canonical hashes → repository. The denial path may use only actor and already-bounded correlation; it must not inspect the hostile command input after authorization has failed. List/status translate repository authorization-changed to the same fresh fixed forbidden error without audit. Submission catches it, writes exactly one bounded denied audit, and then throws that fixed forbidden error.

No service reads roles from tables. Each complete SQL routine owns advisory locking and current-role reauthorization.

- [ ] **Step 5: Freeze dependency direction and absence of UI**

`scripts/job-operations-boundaries.test.ts` initially covers:

- contracts import no database, worker, provider, route, or browser module;
- repository calls exactly three complete routines and imports no command/job/audit schema table;
- service imports authorization/contracts/repository/audit only and performs no SQL;
- only `audit.ts` imports the existing audit service;
- list/get are unaudited, valid request/terminal provenance is SQL-owned, and pre-routine denied audit has the fixed null shape;
- no `src/routes/admin/jobs`, `src/routes/admin/operations`, route action, page, navigation link, component, polling helper, public API, or retry button exists;
- no operations module imports a provider gateway, SDK, `fetch`, or the worker entrypoint.

Later worker/privacy/documentation tasks extend this same plural file; never create a singular duplicate.

- [ ] **Step 6: Run unit GREEN and the PostgreSQL service witness**

```powershell
npx vitest run `
  src/lib/server/operations/jobs/audit.test.ts `
  src/lib/server/operations/jobs/service.test.ts `
  src/lib/server/operations/jobs/repository.test.ts `
  src/lib/server/operations/jobs/contracts.test.ts `
  scripts/job-operations-boundaries.test.ts `
  --reporter=verbose
npm run check

Invoke-CheckpointCServiceCommand {
  npm run test:integration -- `
    tests/integration/job-operations-service.test.ts `
    --reporter=verbose
}
```

Integration evidence covers valid list/submit/get, exact replay, changed-input/stale conflicts, current-role revocation, pre-routine denied audit, SQL-owned requested audit, owner scoping, microsecond timestamps, and no direct table privilege. A deterministic administrator-lock barrier proves a role revoked after TypeScript authorization but before SQL reauthorization creates no command/job/success audit, produces exactly one fixed-shape denied audit, and returns only the fixed forbidden error.

- [ ] **Step 7: Review and commit the application boundary**

```powershell
git --literal-pathspecs add -- `
  src/lib/server/operations/jobs/audit.ts `
  src/lib/server/operations/jobs/audit.test.ts `
  src/lib/server/operations/jobs/service.ts `
  src/lib/server/operations/jobs/service.test.ts `
  scripts/job-operations-boundaries.test.ts `
  tests/integration/job-operations-service.test.ts
git diff --cached --check
git commit -m "feat: add authorization-first job operations service"
```

## Milestone D — operations-specific worker lease capability

### Task 10: Add operations authority transport to the job repository

**Files:**

- Modify: `src/lib/server/jobs/types.ts`
- Modify: `src/lib/server/jobs/repository.ts`
- Modify: `src/lib/server/jobs/repository.test.ts`
- Modify: `src/lib/server/jobs/catalog.ts`
- Modify: `src/lib/server/jobs/catalog.test.ts`
- Modify explicit repository stubs/delegates in:
  - `src/lib/server/jobs/runner.test.ts`
  - `src/lib/server/jobs/test-worker-control.test.ts`
  - `src/lib/server/worker/process-runtime.test.ts`
  - `tests/integration/financial-admin-commands.test.ts`
  - `tests/integration/financial-recovery.test.ts`

- [ ] **Step 1: Write the operations-only type and routine-call RED**

Add new named methods rather than another historical positional parameter:

```ts
export interface OperationsJobLeaseAuthority {
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly generation: number;
  readonly capability: string;
}

export type OperationsJobSafeError =
  | 'Invalid operations job retry command identity.'
  | 'Operations job retry command permanently failed.'
  | 'Permanent job handler failure'
  | 'Transient job handler failure'
  | 'Transient job completion failure';

export interface JobRepository {
  // Preserve every current method/signature.
  renewOperationsJobLease(
    authority: OperationsJobLeaseAuthority
  ): Promise<boolean>;
  completeOperationsJob(
    authority: OperationsJobLeaseAuthority
  ): Promise<boolean>;
  failOperationsJob(
    authority: OperationsJobLeaseAuthority,
    safeError: OperationsJobSafeError,
    retryable: boolean
  ): Promise<JobFailureTransition>;
}
```

`JobRecord` adds only optional `operationsJobLeaseCapability` and `operationsJobLeaseGeneration`. Tests fail all explicit structural stubs until they implement the three methods. Preserve `financialAdminLeaseCapability` and all current positional signatures exactly.

- [ ] **Step 2: Write capability generation, claim, and settlement REDs**

Append a seventh optional constructor dependency without reordering the existing six:

```ts
type OperationsCapabilitySource = () => string;

operationsCapabilitySource: OperationsCapabilitySource = () =>
  randomBytes(32).toString('base64url')
```

Require the exact 43-character base64url pattern and fixed safe errors:

```text
Operations job lease capability generation failed
Operations job lease authority failed
```

For an operations candidate, expect a transaction-local set of `pale_orbit.plan7a_operations_job_capability` followed by `plan7a_operations_claim_job(job_id,lease_owner,lease_duration_ms)`. One valid row returns attempt/generation plus the clear capability only in `JobRecord`; zero rows returns null and discards the value only after the protected routine either lost the candidate race or used that fresh value to perform the Task 6 retry-ceiling rotation, terminal synchronization, and immediate invalidation. Multiple/malformed rows fail safely. Operations candidate selection uses PostgreSQL time: pending rows require `run_at <= clock_timestamp()`, running rows require their job-side lease expiry `run_at <= clock_timestamp()`, and the protected routine still validates the matching private claim expiry under lock. Node `now()` must not decide operations claimability, issue/renew/expiry, or retry `run_at`; preserve the ordinary-job path unchanged.

Assert exact renew/complete/relinquish/exhaust/fail calls and argument order from Task 6. For a retry below attempt 8, TypeScript computes the unchanged current backoff duration and SQL anchors it. At the ceiling call exhaust. Permanent failure calls fail.

- [ ] **Step 3: Run the RED**

```powershell
npx vitest run `
  src/lib/server/jobs/repository.test.ts `
  src/lib/server/jobs/runner.test.ts `
  src/lib/server/jobs/test-worker-control.test.ts `
  src/lib/server/worker/process-runtime.test.ts `
  --reporter=verbose
npm run check
```

Expected: missing fields/methods, operations jobs still using the generic path, and structural delegate failures.

- [ ] **Step 4: Implement strict operations repository methods**

Validate one frozen exact authority: canonical UUID, bounded worker owner, max attempts exactly 8, `1 <= attempt <= max`, positive signed-int32 generation, and 43-character capability. Set only the operations GUC transaction-locally with a bound value.

Map SQLSTATE `55000` to `false`/`{ applied:false }`. Replace every other database error with `Operations job lease authority failed` and no cause. Never set/read the financial-admin GUC, reuse its token source, or take its advisory namespace.

Zero claim rows means the protected routine lost the race or already performed final-attempt terminal synchronization under a freshly rotated claim. Do not call exhaust again and do not construct a job record. Unit tests inject a deterministic fresh capability for the ceiling case and prove the repository sets it only as the transaction-local operations GUC, returns null, discards it, and makes no follow-up settlement call; the service-backed tests own proof that the corresponding digest/generation was committed only in invalidated form.

- [ ] **Step 5: Add safe registered diagnostic parsing**

Export from `catalog.ts`:

```ts
export function parseRegisteredJobDiagnosticMetadata(
  job: Readonly<JobRecord>
): JobDiagnosticMetadata;
```

It returns only positive signed-int32 `payload.generation` for a strictly shaped `catalog.ingest_revision` job and positive signed-int32 `operationsJobLeaseGeneration` for the operations command. All other/malformed/unregistered/proxy/accessor inputs return `{}`. It never reads, enumerates, copies, reflects, or returns `operationsJobLeaseCapability`.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npx vitest run `
  src/lib/server/jobs/repository.test.ts `
  src/lib/server/jobs/catalog.test.ts `
  src/lib/server/jobs/runner.test.ts `
  src/lib/server/jobs/test-worker-control.test.ts `
  src/lib/server/worker/process-runtime.test.ts `
  --reporter=verbose
npm run check

Invoke-CheckpointCServiceCommand {
  npm run test:integration -- `
    tests/integration/financial-admin-commands.test.ts `
    tests/integration/financial-recovery.test.ts `
    --reporter=verbose
}

npx eslint `
  src/lib/server/jobs/types.ts `
  src/lib/server/jobs/repository.ts `
  src/lib/server/jobs/repository.test.ts `
  src/lib/server/jobs/catalog.ts `
  src/lib/server/jobs/catalog.test.ts
git diff --check
```

Stage only the named implementation/stub paths with literal pathspecs, then:

```powershell
git diff --cached --check
git commit -m "feat: add operations job lease authority transport"
```

### Task 11: Preserve rollback, crash, and completion ambiguity in the runner

**Files:**

- Modify: `src/lib/server/jobs/runner.ts`
- Modify: `src/lib/server/jobs/runner.test.ts`
- Modify: `src/lib/server/jobs/runner-observer.test.ts`
- Modify: `src/lib/server/jobs/test-worker-control.test.ts`
- Modify: `src/lib/server/worker/process-runtime.test.ts`

- [ ] **Step 1: Write operations settlement REDs**

Add the no-cause marker used only when the handler knows its database callback rolled back:

```ts
export class DefiniteRetryableJobError extends Error {
  constructor() {
    super('Retryable job handler transaction failed');
    this.name = 'DefiniteRetryableJobError';
  }
}
```

Freeze the behavior matrix:

| Runner event | Operations settlement |
| --- | --- |
| Lease renewal | `renewOperationsJobLease(authority)` |
| `DefiniteRetryableJobError` | `failOperationsJob(authority, 'Transient job handler failure', true)` |
| Invalid-identity `PermanentJobError` | preserve exact identity message, retryable false |
| Other `PermanentJobError` | `Operations job retry command permanently failed.`, retryable false |
| Unknown handler error | no settlement; throw fresh `Operations job execution outcome is unknown` |
| Handler success | `completeOperationsJob(authority)` |
| Completion throws | no fallback; throw the same fresh unknown-outcome error |
| Completion returns false | normal lease-lost observation |
| Missing handler with valid operations authority | operations permanent settlement, never generic |

Tests prove capability/generation missing or malformed cannot enter generic settlement; a non-operations job carrying either field is rejected; and unknown/commit-ambiguous errors, logs, observations, and thrown values contain neither the original exception nor clear capability.

- [ ] **Step 2: Run the RED**

```powershell
npx vitest run `
  src/lib/server/jobs/runner.test.ts `
  src/lib/server/jobs/runner-observer.test.ts `
  --reporter=verbose
```

Expected: the current runner uses generic failure/completion fallback and has no definite-rollback marker.

- [ ] **Step 3: Freeze authority once and branch before generic settlement**

Immediately after job identity validation, reconstruct and freeze:

```ts
const authority = Object.freeze({
  jobId: job.id,
  leaseOwner: options.leaseOwner,
  attempt: job.attempts,
  maxAttempts: job.maxAttempts,
  generation: job.operationsJobLeaseGeneration,
  capability: job.operationsJobLeaseCapability
}) satisfies OperationsJobLeaseAuthority;
```

Never re-read mutable job fields. Preserve every ordinary/financial-admin branch, observer event, lease-owner string, heartbeat progress rule, and safe persisted error. The DB-compatible safe-error union contains `Transient job completion failure`, but operations completion ambiguity must never emit it or schedule a retry.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npx vitest run `
  src/lib/server/jobs/runner.test.ts `
  src/lib/server/jobs/runner-observer.test.ts `
  src/lib/server/jobs/test-worker-control.test.ts `
  src/lib/server/worker/process-runtime.test.ts `
  --reporter=verbose
npm run check
npx eslint `
  src/lib/server/jobs/runner.ts `
  src/lib/server/jobs/runner.test.ts `
  src/lib/server/jobs/runner-observer.test.ts
git diff --check
git --literal-pathspecs add -- `
  src/lib/server/jobs/runner.ts `
  src/lib/server/jobs/runner.test.ts `
  src/lib/server/jobs/runner-observer.test.ts `
  src/lib/server/jobs/test-worker-control.test.ts `
  src/lib/server/worker/process-runtime.test.ts
git diff --cached --check
git commit -m "feat: preserve operations job crash semantics"
```

## Milestone E — closed policies, exact adapters, and worker execution

### Task 12: Create the closed policy registry and fixed denials

**Files:**

- Create: `src/lib/server/operations/jobs/policies.ts`
- Create: `src/lib/server/operations/jobs/policies.test.ts`

- [ ] **Step 1: Write exact registry and hostile-construction REDs**

Use:

```ts
export interface JobRetryPolicyTarget {
  readonly commandId: string;
  readonly targetJobId: string;
  readonly expectedKind: RegisteredJobKind;
  readonly expectedStatus: 'failed';
  readonly expectedAttempts: number;
  readonly expectedMaxAttempts: number;
  readonly expectedUpdatedAt: string;
}

export interface JobRetryPolicyContext {
  readonly transaction: DatabaseTransaction;
  readonly target: JobRetryPolicyTarget;
  readonly signal: AbortSignal;
}

export type JobRetryPolicyOutcome =
  | Readonly<{ status: 'succeeded'; resultCode: JobRetrySuccessResultCode }>
  | Readonly<{ status: 'denied'; resultCode: JobRetryDenialResultCode }>
  | Readonly<{
      status: 'failed';
      resultCode: Extract<JobRetryFailureResultCode, 'retry_command_invalid'>;
    }>;

export type JobRetryPolicyAdapter =
  (context: JobRetryPolicyContext) => Promise<JobRetryPolicyOutcome>;

export class InvalidJobRetryPolicyIdentityError extends Error {
  constructor() {
    super('Invalid job retry policy identity');
    this.name = 'InvalidJobRetryPolicyIdentityError';
  }
}
```

`createJobRetryPolicyAdapters` requires exactly two enabled functions and returns a copied read-only map in canonical five-ID order. Reject proxies, accessors, extra/missing keys, and nonfunctions. Fixed adapters return immutable:

```text
deny_retry_not_supported
  -> denied/retry_not_supported
deny_retry_policy_not_enabled
  -> denied/retry_policy_not_enabled
deny_provider_recovery_not_enabled
  -> denied/provider_recovery_not_enabled
```

They do not inspect target state or touch a transaction. Policy context contains no actor, payload, capability, raw row, provider client, or gateway.

Export an exhaustive `validateJobRetryPolicyOutcome(definition, outcome)` backed by the Task 2 matrix. It accepts the exact fixed or enabled-adapter result for that catalog row and rejects every cross-policy status/result pair. Actor demotion and capability-aware early failure/exhaustion stay outside adapter output and are validated at their owning handler/routine boundary.

- [ ] **Step 2: Run RED, implement, and run GREEN**

```powershell
npx vitest run src/lib/server/operations/jobs/policies.test.ts --reporter=verbose
```

Expected RED: module missing.

```powershell
npx vitest run src/lib/server/operations/jobs/policies.test.ts --reporter=verbose
npm run check
npx eslint `
  src/lib/server/operations/jobs/policies.ts `
  src/lib/server/operations/jobs/policies.test.ts
git diff --check
```

- [ ] **Step 3: Commit**

```powershell
git --literal-pathspecs add -- `
  src/lib/server/operations/jobs/policies.ts `
  src/lib/server/operations/jobs/policies.test.ts
git diff --cached --check
git commit -m "feat: add closed job retry policy registry"
```

### Task 13: Add the exact pending Stripe-event rearm adapter

**Files:**

- Create: `src/lib/server/operations/jobs/adapters/stripe-event.ts`
- Create: `src/lib/server/operations/jobs/adapters/stripe-event.test.ts`
- Test compatibility: `src/lib/server/commerce/job.test.ts`
- Test compatibility: `src/lib/server/jobs/repository.test.ts`

- [ ] **Step 1: Write eligibility, lock-order, mapping, and no-provider REDs**

The exported factory accepts no dependency:

```ts
export function createStripeEventJobRetryPolicyAdapter():
  JobRetryPolicyAdapter;
```

After the handler holds the command, an unlocked bounded target lookup may derive only the Stripe-event row ID. The final lock order is Stripe event → exact target job. Under locks require:

- exact submitted target ID/type/status/attempts/max/updated-at;
- kind `commerce.stripe-event`, maximum 12, and exhausted failed state;
- exact payload `{ stripeEventId }`;
- exact dedupe `stripe:event:<provider_event_id>`;
- the same event/job association;
- event status `pending` and no processed result.

Map:

| Condition | Outcome |
| --- | --- |
| Submitted status/attempt/max/timestamp/type changed | `denied/target_state_changed` |
| Event missing | `denied/source_unavailable` |
| Event nonpending/processed or target nonexhausted | `denied/domain_state_not_retryable` |
| Malformed payload/dedupe/association/identity | `failed/retry_command_invalid` |
| Exact current evidence | `succeeded/rearmed_existing` |

After those operations-specific checks hold under the event and exact target locks, call the existing `rearmPendingStripeEventJob(transaction, stripeEventId)` primitive in the same transaction. Its reentrant event → job locks are already held. Require `true`, re-read the exact target, and verify that primitive reset status to pending, attempts to 0, run/updated to one PostgreSQL transaction timestamp, and cleared `locked_at`, `locked_by`, `last_error`, `rerun_requested_at`, and `completed_at`. An impossible false/mismatched postcondition throws the no-cause `InvalidJobRetryPolicyIdentityError`; the handler preserves it through transaction rollback and then converts it to the exact permanent invalid-identity job failure, so capability-aware settlement records `failed/retry_command_invalid` rather than retrying toward exhaustion. Do not substitute duplicate update SQL.

The wrapper adds the submitted-snapshot/command checks that the existing primitive does not know, but it must preserve and reuse that primitive. It must not import/call `StripeGateway`, `stripeRuntime.gateway`, `fetch`, an SDK, or any provider method.

- [ ] **Step 2: Run RED, implement the minimum transaction, and run GREEN**

```powershell
npx vitest run `
  src/lib/server/operations/jobs/adapters/stripe-event.test.ts `
  src/lib/server/commerce/job.test.ts `
  src/lib/server/jobs/repository.test.ts `
  --reporter=verbose
```

Expected RED: adapter module missing.

```powershell
npx vitest run `
  src/lib/server/operations/jobs/adapters/stripe-event.test.ts `
  src/lib/server/commerce/job.test.ts `
  src/lib/server/jobs/repository.test.ts `
  --reporter=verbose
npm run check
npx eslint `
  src/lib/server/operations/jobs/adapters/stripe-event.ts `
  src/lib/server/operations/jobs/adapters/stripe-event.test.ts
git diff --check
```

- [ ] **Step 3: Commit**

```powershell
git --literal-pathspecs add -- `
  src/lib/server/operations/jobs/adapters/stripe-event.ts `
  src/lib/server/operations/jobs/adapters/stripe-event.test.ts
git diff --cached --check
git commit -m "feat: rearm failed Stripe event jobs through operations"
```

### Task 14: Add the exact financial-classification rearm adapter

**Files:**

- Create: `src/lib/server/operations/jobs/adapters/financial-classification.ts`
- Create: `src/lib/server/operations/jobs/adapters/financial-classification.test.ts`
- Test compatibility: `src/lib/server/commerce/financial/jobs.test.ts`
- Test compatibility: `src/lib/server/commerce/financial/projection-authority.test.ts`

- [ ] **Step 1: Write active/pending authority and lock-order REDs**

Export a no-dependency factory:

```ts
export function createFinancialClassificationJobRetryPolicyAdapter():
  JobRetryPolicyAdapter;
```

After the command row, acquire:

```text
lockFinancialProjectionAuthority(transaction)
→ lockFinancialProjectionEnrollment(transaction)
→ exact target classification job FOR UPDATE
```

Strictly parse with `parseFinancialJobIdentity`. Require kind classification, maximum 5, exhausted failed, exact submitted state/timestamp, and exact permanent dedupe/payload identity.

The active-authority path requires no pending authority fields; the job classifier/allocation versions equal current active authority; replay identity is current; and no scan binding exists. The pending-replay path requires exact pending versions/replay/scan ID, a matching `classification_replay` scan in its approved running state, and exact scan/authority/job relationships. Both require the referenced balance or fee-detail subject and its current financial fingerprint to match.

Map malformed identity to `failed/retry_command_invalid`; changed submitted snapshot to `denied/target_state_changed`; obsolete authority/enrollment/replay/scan/subject/fingerprint to `denied/domain_state_not_retryable`; genuine required-source absence to `denied/source_unavailable`; and exact evidence to direct `succeeded/rearmed_existing`.

After all checks hold under the authority, enrollment, and exact target locks, call the existing `rearmFinancialClassificationJob(transaction, exactSpec)` with the already-validated immutable identity. Its reentrant exact-job lock is already held. Require the returned row to have the same target ID, payload, deduplication key, maximum, and Task 13 rearm fields/timestamp; any identity adoption, successor, different job, or mismatched postcondition throws `InvalidJobRetryPolicyIdentityError`, rolls back the primitive effect, and follows the same permanent `retry_command_invalid` settlement as Task 13. Do not duplicate its transition SQL, mutate authority, adopt a substitute subject, enqueue a successor, scan broadly, or call a provider.

- [ ] **Step 2: Run RED, implement, and run GREEN**

```powershell
npx vitest run `
  src/lib/server/operations/jobs/adapters/financial-classification.test.ts `
  src/lib/server/commerce/financial/jobs.test.ts `
  src/lib/server/commerce/financial/projection-authority.test.ts `
  --reporter=verbose
```

Expected RED: adapter module missing.

```powershell
npx vitest run `
  src/lib/server/operations/jobs/adapters/financial-classification.test.ts `
  src/lib/server/commerce/financial/jobs.test.ts `
  src/lib/server/commerce/financial/projection-authority.test.ts `
  --reporter=verbose
npm run check
npx eslint `
  src/lib/server/operations/jobs/adapters/financial-classification.ts `
  src/lib/server/operations/jobs/adapters/financial-classification.test.ts
git diff --check
```

- [ ] **Step 3: Commit**

```powershell
git --literal-pathspecs add -- `
  src/lib/server/operations/jobs/adapters/financial-classification.ts `
  src/lib/server/operations/jobs/adapters/financial-classification.test.ts
git diff --cached --check
git commit -m "feat: rearm failed financial classification jobs through operations"
```

### Task 15: Implement the retry-command handler and terminal replay

**Files:**

- Create: `src/lib/server/operations/jobs/handler.ts`
- Create: `src/lib/server/operations/jobs/handler.test.ts`

- [ ] **Step 1: Write construction, identity, execution, and ambiguity REDs**

```ts
export interface OperationsJobRetryHandlerDependencies {
  readonly database: Database;
  readonly policies: ReadonlyMap<
    JobRetryPolicyAdapterId,
    JobRetryPolicyAdapter
  >;
}

export function createOperationsJobRetryHandler(
  dependencies: OperationsJobRetryHandlerDependencies
): JobHandler;
```

Construction copies and revalidates every and only the five policy IDs in canonical order. Otherwise fail startup with:

```text
Operations job retry policies do not exactly match the registered policy catalog
```

Before a transaction, strictly validate operations kind/max, exact own-data payload `{ commandId }`, exact dedupe, attempt/generation/capability/lease owner, and canonical IDs. Invalid identity throws `PermanentJobError('Invalid operations job retry command identity.')`.

- [ ] **Step 2: Freeze the handler transaction**

In one `withTransaction` callback:

1. set the operations capability GUC transaction-locally;
2. call `plan7a_operations_lock_job_retry_command(job_id,command_id,lease_owner,attempt,generation)`;
3. parse exactly one nonreflective row, including canonical six-fraction `expected_updated_at` text;
4. if command status is terminal, return without policy or transition;
5. if current actor authorization is false, select `actor_not_authorized`;
6. resolve the registered definition and its policy;
7. check abort immediately before policy and before transition;
8. pass only `{ transaction, target, signal }`;
9. validate the exact catalog policy/status/result combination, not only its global family;
10. call `plan7a_operations_transition_job_retry_command` with its result code;
11. validate one matching terminal status/result and canonical completion text.

The adapter effect, command transition, and terminal audit commit together.

- [ ] **Step 3: Distinguish definite rollback from commit ambiguity**

Use a callback-completed bit. Unknown errors thrown while the callback is active become the no-cause `DefiniteRetryableJobError`; errors after the callback returned become a fresh no-cause `Error('Operations job execution outcome is unknown')`. Preserve `PermanentJobError`, `DefiniteRetryableJobError`, and `InvalidJobRetryPolicyIdentityError` through the transaction wrapper. After a confirmed rollback, convert only the policy-identity marker to `PermanentJobError('Invalid operations job retry command identity.')`; the runner's capability-aware permanent settlement then owns the single `retry_command_invalid` command/job/audit transaction. Never reflect or attach the unknown exception.

Tests cover actor demotion, all fixed policies, both enabled result families, terminal succeeded/denied/failed replay, malformed lock/transition rows, missing/duplicate rows, abort before policy/transition, definite rollback, commit ambiguity, and capability canary absence. Fault each primitive's postcondition after it reports success and prove the domain mutation rolls back, the handler returns the exact permanent invalid-identity error, and capability-aware settlement produces one `retry_command_invalid` terminal result/audit with no retry or exhaustion.

- [ ] **Step 4: Run RED and GREEN**

```powershell
npx vitest run `
  src/lib/server/operations/jobs/handler.test.ts `
  src/lib/server/operations/jobs/policies.test.ts `
  src/lib/server/jobs/runner.test.ts `
  --reporter=verbose
```

Expected RED: handler module missing.

```powershell
npx vitest run `
  src/lib/server/operations/jobs/handler.test.ts `
  src/lib/server/operations/jobs/policies.test.ts `
  src/lib/server/jobs/runner.test.ts `
  --reporter=verbose
npm run check
npx eslint `
  src/lib/server/operations/jobs/handler.ts `
  src/lib/server/operations/jobs/handler.test.ts
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git --literal-pathspecs add -- `
  src/lib/server/operations/jobs/handler.ts `
  src/lib/server/operations/jobs/handler.test.ts
git diff --cached --check
git commit -m "feat: execute operations retry commands"
```

### Task 16: Bind all policies, eleven handlers, and safe diagnostics at startup

**Files:**

- Modify: `src/worker.ts`
- Modify: `scripts/job-catalog-boundary.test.ts`
- Modify: `scripts/job-operations-boundaries.test.ts`
- Modify: `scripts/storage-process-isolation.test.ts`
- Test: `src/lib/server/jobs/handler-bindings.test.ts`
- Test: `src/lib/server/jobs/runner-observer.test.ts`

- [ ] **Step 1: Extend the static RED**

Require `src/worker.ts` to construct the two no-provider adapters, the exact five-policy registry, and the operations handler; replace its raw ten-handler map with `createRegisteredJobHandlerMap` in catalog order; bind the eleventh operations kind; and pass `parseRegisteredJobDiagnosticMetadata` as `parseJobDiagnosticMetadata`.

Require startup failure before polling for missing/duplicate/unregistered/nonfunction handlers or policies. Preserve worker lifecycle, readiness, heartbeat, client ownership, claim policy, and process-secret separation.

- [ ] **Step 2: Run the RED**

```powershell
npx vitest run `
  src/lib/server/jobs/catalog.test.ts `
  src/lib/server/jobs/handler-bindings.test.ts `
  scripts/job-catalog-boundary.test.ts `
  scripts/job-operations-boundaries.test.ts `
  scripts/storage-process-isolation.test.ts `
  scripts/process-secret-scope.test.ts `
  --reporter=verbose
```

Expected: the raw ten-entry map, absent operations assembly, and missing diagnostic parser fail.

- [ ] **Step 3: Recompose the worker only at the composition root**

```ts
const retryPolicies = createJobRetryPolicyAdapters({
  rearmPendingStripeEvent: createStripeEventJobRetryPolicyAdapter(),
  rearmFinancialClassification:
    createFinancialClassificationJobRetryPolicyAdapter()
});

const operationsRetryCommandHandler = createOperationsJobRetryHandler({
  database: databaseClient.db,
  policies: retryPolicies
});
```

Bind all eleven catalog constants to the existing ten handlers plus this handler. Import kinds directly from the catalog; domain modules own handler factories, not kind authority. No `stripeRuntime.gateway` or provider object enters the retry construction graph.

- [ ] **Step 4: Complete the plural boundary gate**

The gate now additionally proves:

- worker uses the exact catalog/policy validators and safe diagnostic parser;
- only two policies are enabled and every row forbids Plan 7A provider calls;
- policies/handler/adapters import no provider/fetch/SDK dependency;
- operations capability appears only in allowed in-memory repository/runner/handler transport and tests;
- it never enters DTOs, audits, payload/dedupe, errors, logger inputs, config/environment, restore evidence, or documentation examples;
- no route/UI/navigation/polling/manual-reset surface exists.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx vitest run `
  src/lib/server/jobs/catalog.test.ts `
  src/lib/server/jobs/handler-bindings.test.ts `
  src/lib/server/jobs/runner.test.ts `
  src/lib/server/jobs/runner-observer.test.ts `
  scripts/job-catalog-boundary.test.ts `
  scripts/job-operations-boundaries.test.ts `
  scripts/storage-process-isolation.test.ts `
  scripts/process-secret-scope.test.ts `
  --reporter=verbose
npm run check
npx eslint `
  src/worker.ts `
  scripts/job-operations-boundaries.test.ts `
  scripts/storage-process-isolation.test.ts
git diff --check
git --literal-pathspecs add -- `
  src/worker.ts `
  scripts/job-catalog-boundary.test.ts `
  scripts/job-operations-boundaries.test.ts `
  scripts/storage-process-isolation.test.ts
git diff --cached --check
git commit -m "feat: bind exhaustive job catalog at worker startup"
```

### Task 17: Prove the complete worker and policy matrix against PostgreSQL

**Files:**

- Create: `tests/integration/job-operations-worker.test.ts`

- [ ] **Step 1: Write the complete service-backed RED**

Prove:

- claim returns a fresh 43-character clear capability only in `JobRecord`, while persistence has its lowercase digest;
- ordinary takeover rotates capability/digest/owner, increments generation, replaces a deliberately different prior duration with the current call duration, resets `issued_at`, leaves `renewed_at` null, and derives expiry from the fresh database observation;
- exact authority renewal alone uses one database observation to set job `locked_at`/`updated_at`, job `run_at`, claim `renewed_at`, and claim expiry to the same current-generation window, while stale owner/attempt/generation/capability/expiry fails without changing either row;
- definite precommit failure leaves command pending, returns job pending with DB-anchored existing backoff, invalidates claim, and rotates on retry;
- invalid identity yields job error `Invalid operations job retry command identity.`, command failed/`retry_command_invalid`, and one terminal audit;
- other permanent failure uses the bounded operations message and `unexpected_failure`;
- exhaustion uses the bounded exhausted message and `retry_command_exhausted`;
- an expired attempt-8 takeover returns no job, keeps attempts at 8, advances generation exactly once, replaces the digest/owner/issued timestamp and a deliberately different prior lease duration with the deterministic fresh claim/current call duration, leaves `renewed_at` null, terminal-synchronizes once, and invalidates that fresh claim;
- actor demotion yields denied/`actor_not_authorized`;
- both excluded rows yield `retry_not_supported`;
- all seven disabled rows yield `retry_policy_not_enabled`;
- provider-denial remains unit-covered but unused by the eleven rows;
- Stripe and classification exact-current cases rearm once, with every stale/missing/nonretryable/corrupt case mapped exactly;
- terminal replay performs no second effect or audit;
- every provider spy remains zero.

- [ ] **Step 2: Run RED, finish minimum corrections, and run GREEN**

```powershell
Invoke-CheckpointCServiceCommand {
  npm run test:integration -- `
    tests/integration/job-operations-worker.test.ts `
    --reporter=verbose
}
```

Expected RED: any missing worker routine, handler binding, policy, or lifecycle contract fails with clean teardown. If it exposes an implementation defect, reproduce it in the owning focused unit/SQL test, make the minimum correction, and commit the literal implementation/test paths separately as `fix: correct Plan 7A checkpoint C worker behavior`. Rerun focused GREEN and this integration test. Do not hide production corrections in the integration-test commit; once the production tree is green, commit only this task's new evidence:

```powershell
git --literal-pathspecs add -- tests/integration/job-operations-worker.test.ts
git diff --cached --check
git commit -m "test: prove operations worker recovery policies"
```

### Task 18: Prove takeover, crash replay, lock order, and privacy

**Files:**

- Create: `tests/integration/job-operations-races.test.ts`
- Create: `tests/integration/job-operations-privacy.test.ts`
- Modify: `scripts/job-operations-boundaries.test.ts`

- [ ] **Step 1: Write deterministic concurrency REDs**

Use independent clients, explicit barriers, `pg_stat_activity`, `pg_blocking_pids`, a five-second lock timeout, and bounded Vitest timeouts—never sleep-only ordering assertions.

Prove concurrent claim uniqueness; job-row/exclusive-lease/claim/command takeover order; role/shared-lease/command handler order; Stripe event-before-job; classification authority/enrollment/job; actor-demotion serialization; at-most-one target effect/audit; rollback before commit; crash after terminal commit and before internal completion; fresh-generation replay completion; and absence of deadlocks. For both pending and already-terminal final-attempt commands, capture the deterministic fresh capability supplied by the zero-row claimant and use different prior/current lease durations to prove the job remains at `attempts = max_attempts = 8`, generation advances exactly once, digest, owner, and persisted duration rotate to the current call, `issued_at` and expiry use the fresh PostgreSQL observation/current duration while `renewed_at` resets to null, the final claim is invalidated in the same transaction, the command/job/audit outcome occurs exactly once, and both the expired prior capability and the freshly consumed clear capability reject every later private operation.

- [ ] **Step 2: Write privacy and authority-isolation REDs**

Use two valid fixed 43-character canaries. Assert their expected digests appear only where designed and clear values appear nowhere in jobs, command/claim rows, audits, DTOs, observations, logs, errors/causes, verifier, checkpoint artifacts, config, or documentation.

Prove hostile capability accessors are untouched by diagnostic/DTO mapping; operations and financial capabilities cannot authorize each other; runtime-only/cleanup cannot call private routines or read tables; runtime-only and financial-worker callers cannot insert an orphan or cross-paired reserved operations job/audit identity; financial-worker cannot update into, out of, or across either reserved job-identity half even with the current capability and every known GUC; and provider spies stay zero.

- [ ] **Step 3: Run serialized RED/GREEN**

```powershell
Invoke-CheckpointCServiceCommand {
  npm run test:integration -- `
    tests/integration/job-operations-races.test.ts `
    --reporter=verbose
}

Invoke-CheckpointCServiceCommand {
  npm run test:integration -- `
    tests/integration/job-operations-privacy.test.ts `
    --reporter=verbose
}
```

Expected: both pass after focused corrections, every harness restores the baseline, no capability/provider value leaks, and every race has one authoritative outcome. If either suite exposes an implementation defect, first add the owning focused RED, commit the literal production/focused-test paths separately as `fix: correct Plan 7A checkpoint C race behavior`, and rerun both suites. The evidence commit below must not silently omit or absorb production changes.

- [ ] **Step 4: Commit the race/privacy evidence**

```powershell
git --literal-pathspecs add -- `
  tests/integration/job-operations-races.test.ts `
  tests/integration/job-operations-privacy.test.ts `
  scripts/job-operations-boundaries.test.ts
git diff --cached --check
git commit -m "test: prove operations races and privacy"
```

## Milestone F — operator contract, full evidence, and reviewed completion

### Task 19: Update current operator documentation without claiming Checkpoint D

**Files:**

- Modify: `README.md`
- Modify: `docs/authentication-and-email.md`
- Modify: `docs/commerce-and-guest-claims.md`
- Modify: `docs/customer-library-and-reader.md`
- Modify: `docs/database-and-workers.md`
- Modify: `docs/dependency-decisions.md`
- Modify: `docs/financial-reconciliation-and-reporting.md`
- Modify: `docs/runtime-environments.md`
- Modify: `docs/storage-ingestion-and-publication.md`
- Modify: `docs/stripe-financial-reconciliation.md`
- Modify: `scripts/job-operations-boundaries.test.ts`

- [ ] **Step 1: Write documentation/source-shape REDs**

Require current operator material to state:

- the migration chain ends at `0015_plan7a_operations_authority`;
- the executable verifier is `plan7a-database-catalog-v1`;
- the backend-only list/submit/status surface is protected by `jobs.retry` and current-role reauthorization;
- exactly eleven production kinds exist;
- only pending Stripe-event and exact financial-classification rearm are enabled;
- all other initial policies are disabled/excluded fixed results;
- no generic job reset, delivered-outbox redelivery, recursive command retry, or general ingestion retry exists;
- no provider call occurs;
- operations capabilities are per-claim, memory/transaction-local only, and digest-persisted—not environment secrets;
- financial-admin and revision-ingestion authority remain separate;
- command/audit/restore authority is exact and command history retained;
- no operations route, page, navigation, polling, or button exists;
- monitoring/alerts, generalized stage evidence, production-live activation, Stripe enablement, fresh release-candidate capture, and Checkpoint D remain deferred;
- production stays maintenance-only and Stripe-disabled.

Historical specs/plans retain historical `0014`/v4 statements and are not rewritten. Current guides clearly distinguish that history from current head.

- [ ] **Step 2: Run the RED and update only relevant current sections**

```powershell
npx vitest run scripts/job-operations-boundaries.test.ts --reporter=verbose
rg -n `
  'migration chain ends at `0014`|through `0014`|plan6b-financial-catalog-v4' `
  README.md docs `
  -g '*.md' `
  -g '!docs/superpowers/**'
```

Expected RED: stale current-head text or missing Checkpoint C boundaries. Update prose without duplicating the executable verifier body; keep the calibrated marker in `docs/stripe-financial-reconciliation.md` byte-identical to SQL.

- [ ] **Step 3: Run documentation GREEN and commit**

```powershell
npx vitest run `
  scripts/job-operations-boundaries.test.ts `
  scripts/commerce-operations.test.ts `
  --reporter=verbose
npm run check
git diff --check
```

The stale-text scan may retain only clearly historical occurrences. Stage the eleven named files with literal pathspecs, inspect, then:

```powershell
git diff --cached --check
git commit -m "docs: document checkpoint C operations authority"
```

Do not yet change the approved design's implementation-status line; reviewed completion occurs in Task 21.

### Task 20: Run the complete Checkpoint C verification matrix

**Files:** None unless a focused RED demonstrates a defect.

- [ ] **Step 1: Run one aggregate hermetic focused gate**

```powershell
npx vitest run `
  src/lib/server/jobs/catalog.test.ts `
  src/lib/server/jobs/handler-bindings.test.ts `
  src/lib/server/jobs/repository.test.ts `
  src/lib/server/jobs/runner.test.ts `
  src/lib/server/jobs/runner-observer.test.ts `
  src/lib/server/db/schema/job-operations.test.ts `
  src/lib/server/db/database-role-provision.test.ts `
  src/lib/server/operations/jobs/contracts.test.ts `
  src/lib/server/operations/jobs/repository.test.ts `
  src/lib/server/operations/jobs/audit.test.ts `
  src/lib/server/operations/jobs/service.test.ts `
  src/lib/server/operations/jobs/policies.test.ts `
  src/lib/server/operations/jobs/adapters/stripe-event.test.ts `
  src/lib/server/operations/jobs/adapters/financial-classification.test.ts `
  src/lib/server/operations/jobs/handler.test.ts `
  src/lib/server/commerce/job.test.ts `
  src/lib/server/commerce/financial/jobs.test.ts `
  src/lib/server/commerce/financial/projection-authority.test.ts `
  src/lib/server/worker/process-runtime.test.ts `
  src/lib/server/jobs/test-worker-control.test.ts `
  scripts/job-catalog-boundary.test.ts `
  scripts/job-operations-boundaries.test.ts `
  scripts/storage-process-isolation.test.ts `
  scripts/process-secret-scope.test.ts `
  scripts/commerce-operations.test.ts `
  scripts/commerce-privacy.test.ts `
  scripts/database-role-deployment.test.ts `
  scripts/financial-schema-preservation.test.ts `
  scripts/deployment-backup-bundle.test.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/deployment-checkpoint-runtime.test.ts `
  scripts/with-plan6b-upgrade-database.test.ts `
  --reporter=verbose
```

Expected: all focused hermetic/static suites pass without starting Docker, PostgreSQL, a browser, or a network provider.

- [ ] **Step 2: Run full hermetic, type, lint, schema, and build gates**

```powershell
npm run test:unit
npm run check
npm run lint
npm run db:check
npm run build
git diff --check
```

Expected: all pass against the exact candidate tree. Any test failure is handled under systematic debugging with the narrowest reproducer; do not weaken timeouts, privacy assertions, or authority checks to obtain green.

- [ ] **Step 3: Run the complete repository gate once**

```powershell
Invoke-CheckpointCServiceCommand { npm run verify }
```

Expected order remains type/Svelte check, lint, unit, explicit service-backed restore witness, PostgreSQL integration, disposable-worker Playwright, and build. The operations service/worker/race/privacy tests pass and every nested harness cleans before global baseline comparison.

- [ ] **Step 4: Run upgrade and both production-image compatibility profiles**

Wait for each wrapper to finish before starting the next:

```powershell
Invoke-CheckpointCServiceCommand { npm run test:plan6b-upgrade }
Invoke-CheckpointCServiceCommand { npm run smoke:plan6b -- --stage 6b-ii }
Invoke-CheckpointCServiceCommand { npm run smoke:plan6b-fixture -- --stage 6b-ii }
```

Expected: supported historical fixtures reach `0015`; restore/checkpoint consumers authenticate `plan7a-database-catalog-v1`; both existing smoke profiles remain maintenance-only, Stripe-disabled, provider-network closed, and clean. Checkpoint C does not emit Checkpoint D stage evidence or claim release-candidate status.

- [ ] **Step 5: Prove exact scope, migration, provider, and capability containment**

```powershell
git status --short --branch
git log --oneline 651a12483ce94e330dac6ea83be6ea841b4713da..HEAD
git diff --name-only 651a12483ce94e330dac6ea83be6ea841b4713da..HEAD
git diff --name-only `
  651a12483ce94e330dac6ea83be6ea841b4713da..HEAD -- `
  src/routes package.json package-lock.json compose.prod.yaml
rg -n 'StripeGateway|stripeRuntime[.]gateway|fetch[(]' `
  src/lib/server/operations/jobs src/worker.ts
rg -n `
  'operationsJobLeaseCapability|pale_orbit[.]plan7a_operations_job_capability' `
  src scripts tests docs
```

Review every capability match against the explicit in-memory/GUC/test whitelist. Expected: no route/dependency/Compose/activation diff; no provider import/call; no historical migration byte change; only migration `0015` is added; no forbidden clear capability sink; and no unrelated worktree change.

- [ ] **Step 6: Capture immutable verification evidence**

Record exact candidate SHA, command exit codes, test/file counts, upgrade head/count, restore marker, production-image profile outcomes, and the pre/post resource baseline. Record the existing audit advisory count separately. Do not store logs containing SQL rows, provider data, clear capabilities, environment values, or arbitrary exceptions.

Fresh coordinated checkpoint capture and operator-supplied distinct-engine release-candidate rehearsal remain deferred until Checkpoint D adds the evidence coordinator. Checkpoint C proves their current executable catalog consumers are updated and green; it does not create or bless production candidate evidence.

### Task 21: Request independent review and record Checkpoint C completion

**Files after review only:**

- Modify: `docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md`
- Modify if needed for the status assertion: `scripts/job-operations-boundaries.test.ts`

- [ ] **Step 1: Request independent review against exact evidence**

Use `superpowers:requesting-code-review` and give reviewers the approved design, this plan, base `651a12483ce94e330dac6ea83be6ea841b4713da`, exact candidate HEAD, and Task 20 evidence. Parallel independent reviews may cover:

1. catalog/application/scope and privacy;
2. migration/roles/ACL/restore authority;
3. capability lifecycle/runner ambiguity/lock order/adapters/races.

They must inspect the eleven-row TypeScript/SQL bijection, public/private routine signatures, preflight denied audit, idempotency fingerprint, six-fraction timestamps, task-specific GUC/digest lifecycle, final-attempt zero-row semantics, terminal replay, exactly-once effect/audit, both adapter lock orders and eligibility, zero provider calls, restore/upgrade/smoke compatibility, and continued absence of UI/activation.

- [ ] **Step 2: Resolve every accepted finding with fresh RED/GREEN evidence**

For each finding:

1. reproduce or add the focused RED;
2. make the smallest correction;
3. run focused GREEN, `npm run check`, targeted ESLint, and `git diff --check`;
4. stage only literal affected paths and commit:

```powershell
git commit -m "fix: address Plan 7A checkpoint C review"
```

5. rerun the entire Task 20 matrix;
6. request review again against the new exact HEAD.

Do not dismiss a finding merely because broad tests pass. Do not accept a proposed change that broadens scope or contradicts the design; document the evidence and ask the reviewer to reassess.

- [ ] **Step 3: Update status only after no-findings review and fresh full evidence**

Change exactly:

```text
**Implementation status:** Checkpoints A-B complete; Checkpoints C-D not started
```

to:

```text
**Implementation status:** Checkpoints A-C complete; Checkpoint D not started
```

Preserve:

```text
**Launch status:** Production remains maintenance-only with Stripe disabled
```

Update the static status assertion, then run:

```powershell
npx vitest run `
  scripts/job-operations-boundaries.test.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/deployment-checkpoint-runtime.test.ts `
  --reporter=verbose
git diff --check
```

- [ ] **Step 4: Commit the reviewed status**

```powershell
git --literal-pathspecs add -- `
  docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md `
  scripts/job-operations-boundaries.test.ts
git diff --cached --check
git commit -m "docs: record Plan 7A checkpoint C completion"
```

- [ ] **Step 5: Verify completion and finish the branch**

The status commit changes `HEAD`, so all prior evidence is provisional. Rerun the entire Task 20 matrix—including both production-image compatibility profiles and scope/privacy checks—against the exact status-commit SHA, recapture immutable evidence, and request one final independent review against that same SHA. If that post-status review finds an accepted issue, reproduce it with a focused RED, make the smallest correction, run the Step 2 focused checks, stage only literal affected paths, and commit `fix: address Plan 7A checkpoint C final review`. The design status is already Checkpoints A-C complete: skip Steps 3-4 rather than attempting the one-time status replacement again, then rerun the complete Task 20 matrix, recapture evidence, and request final review against the new exact SHA. Repeat this post-status loop for every later accepted finding; every correction and commit invalidates all prior evidence.

Only after the exact final SHA has fresh complete evidence and a no-findings review, use `superpowers:verification-before-completion`, confirm the worktree is clean and `HEAD` equals the reviewed/evidenced SHA, then use `superpowers:finishing-a-development-branch`. Merge/push only with the user's current integration authorization. Do not deploy, activate production, enable Stripe/provider behavior, add monitoring, or begin Checkpoint D from this checkpoint.

## Expected implementation commit sequence

1. `feat: define exhaustive production job catalog`
2. `feat: validate registered job handler bindings`
3. `feat: define strict job operations contracts`
4. `feat: add protected operations retry authority`
5. `feat: call protected job operations routines`
6. `feat: add authorization-first job operations service`
7. `feat: add operations job lease authority transport`
8. `feat: preserve operations job crash semantics`
9. `feat: add closed job retry policy registry`
10. `feat: rearm failed Stripe event jobs through operations`
11. `feat: rearm failed financial classification jobs through operations`
12. `feat: execute operations retry commands`
13. `feat: bind exhaustive job catalog at worker startup`
14. `test: prove operations worker recovery policies`
15. `test: prove operations races and privacy`
16. `docs: document checkpoint C operations authority`
17. zero or more focused `fix: correct Plan 7A checkpoint C worker behavior` / `fix: correct Plan 7A checkpoint C race behavior` commits at the point their RED exposes a defect
18. zero or more pre-status `fix: address Plan 7A checkpoint C review` commits
19. `docs: record Plan 7A checkpoint C completion`
20. zero or more post-status `fix: address Plan 7A checkpoint C final review` commits; each invalidates evidence and is followed by the complete Task 20 matrix and another final review

Do not squash away the reviewed authority boundaries unless the final integration workflow explicitly requires it.

## Checkpoint C acceptance checklist

- [ ] The application catalog contains exactly eleven frozen production definitions, one owner for every kind/max literal, one handler binding per row, and exact SQL mirror/failure-map parity.
- [ ] Only Stripe-event and financial-classification rows are enabled; seven rows are disabled, two are excluded, the provider-denial interface remains unused, and every row forbids Plan 7A provider calls.
- [ ] Safe list/status DTOs are strict, bounded, microsecond-exact, payload-free, lease-free, provider-free, and use an `unregistered` sentinel rather than raw unknown kind text.
- [ ] Canonical retry input and fixed SHA-256 witnesses exclude actor, correlation, clear key, and fixed kind; exact replay is owner-scoped and changed input conflicts without mutation.
- [ ] `jobs.retry` authorization occurs before hostile input inspection, parsing, hashing, repository work, or target access; valid SQL routines reauthorize current roles behind the administrator lock.
- [ ] Pre-routine denial audit has one fixed null-metadata shape; valid requested and terminal provenance is SQL-owned, atomic, allowlisted, and never duplicated by service/route code.
- [ ] Migration `0015` alone adds the four enums, two protected tables, exact routines/triggers/indexes/constraints/revocations/grants, locks jobs then audit events before its reserved-namespace preflight, fails closed without a TOCTOU window on every pre-existing/concurrent operations job/audit namespace collision, and preserves migrations/snapshots `0001`–`0014` byte-for-byte.
- [ ] Runtime can call only the three complete public routines and receives no new table read/mutation authority; worker private authority is exact; cleanup receives none; both replaced insert guards reserve either identity half before historical session-identity early returns; the invoker update guard reserves either half in both `OLD` and `NEW`; direct versus inherited tuples, session guards, owner provenance, orphan/cross-pair/into/out-of rejection, and direct-setting forgery failures are proven.
- [ ] The operations capability is fresh 256-bit base64url per claim/takeover, bound to job/generation/attempt/owner/lease, clear only in memory/GUC, digest-only in the private claim, and isolated from financial-admin authority.
- [ ] Claim, renewal, expiry, takeover, invalidation, backoff, failure, exhaustion, completion, and final-attempt zero-row synchronization use PostgreSQL clock and the published lock order; every issuance uses the current call duration with fresh `issued_at`, null `renewed_at`, and matching job/claim expiry, renewal updates both rows from one clock observation, and the zero-row ceiling path never increments beyond maximum before invalidating the fresh binding atomically so both old and newly consumed authorities are unusable.
- [ ] Unknown handler/commit ambiguity leaves operations work running for safe takeover; definite callback rollback alone schedules retry; terminal replay never repeats an effect or terminal audit.
- [ ] Fixed policies inspect no domain state; the two enabled adapters own their exact domain lock orders and expected-state/identity/version predicates, reuse and post-verify the existing rearm primitives, and prove no provider call.
- [ ] Revision ingestion retains its specialized staged-source/checksum/generation retry, and financial administrator commands remain terminal under their unchanged capability.
- [ ] `plan7a-database-catalog-v1` carries all prior descriptors plus every 0015 object/invariant; dynamic row counts, restore witness, upgrade fixtures, checkpoint consumers, and both existing production-image profiles agree.
- [ ] There is no generic reset, delivered-outbox redelivery, route, UI, navigation, public API, polling, monitoring/alerting, activation input, production-live mode, Stripe enablement, or Checkpoint D evidence coordinator.
- [ ] Focused tests, full unit, check, lint, schema check, build, serialized verify, upgrade, both production-image profiles, scope/privacy review, and independent reviews are green against the exact final SHA.
- [ ] The design records Checkpoints A-C complete and Checkpoint D unstarted while production remains maintenance-only and Stripe-disabled.

## Execution handoff

After this plan is reviewed and approved, execute it in this order with `superpowers:subagent-driven-development`. Assign only independent, non-overlapping tasks to parallel subagents; the primary agent owns skill instructions, migration/service serialization, shared-file reconciliation, verification evidence, and every commit. Do not begin implementation from an uncommitted or unapproved plan.
