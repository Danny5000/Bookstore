# Plan 7A: Production Operability Foundations Design

**Date:** 2026-08-24

**Design status:** Written review pending — conversational direction approved

**Implementation status:** Not started

**Depends on:** [Bookstore Full-Stack Design](2026-08-08-bookstore-full-stack-design.md), [Plan 6B Financial Reconciliation and Reporting](2026-08-11-stripe-financial-reconciliation-reporting-design.md), and [Plan 6B-II Implementation Refresh](2026-08-20-plan-6b-ii-implementation-refresh-design.md)

**Launch status:** Production remains maintenance-only with Stripe disabled

## 1. Purpose and current-state boundary

Plan 7A establishes the behavior-preserving architecture required by the later production-operability phases. It creates narrow dependency, observability, job-control, worker-health, release-evidence, test-profile, rate-limit, and activation-contract seams before monitoring, recovery interfaces, backup scheduling, deployment hardening, capacity work, or launch are implemented.

The completed Plan 6B baseline is `eee56a1f97eda39ebf772fc94ab1bc2ee9806116`. That baseline is release-gate clean, ends at migration `0014`, preserves four pairwise-distinct database principals, and deliberately rejects production operation outside maintenance mode. Plan 7A must preserve those properties.

Several current modules are large because they encode financial invariants, explicit lock orders, provider evidence, and restore contracts. File size alone is not a reason to rewrite them. Plan 7A changes only dependencies and extension boundaries that later operability work would otherwise couple to domain orchestrators or duplicate across entrypoints.

Plan 7A is not a production launch. Deploying it must leave non-health production routes unavailable and the base production stack Stripe-disabled.

## 2. Source of truth and document strategy

The full-stack design remains authoritative for the complete Plan 7 outcome: container and VPS hardening, remaining rate limits, structured logging, health and capacity monitoring, alerting, encrypted coordinated off-host backups, restore drills, production smoke, a deployment runbook, and a stable interface for future GitHub Actions.

This document defines only the first Plan 7 tranche. It does not supersede the completed Plan 6 designs or rewrite historical implementation plans. When a Plan 7A foundation touches an existing financial, role, migration, checkpoint, or smoke contract, the stricter existing invariant remains authoritative unless this document explicitly narrows the dependency without changing behavior.

The four checkpoint implementation plans will contain exact file edits, test-first steps, commands, commit boundaries, and review checkpoints. This design specifies their shared ownership, state, authority, failure behavior, privacy, ordering, and observable acceptance outcomes.

## 3. Goals and scope

Plan 7A delivers:

1. A leaf financial projection-authority module that removes the direct `rebase` dependency cycles without changing SQL, transaction ownership, lock order, or financial results.
2. A dependency-light structured logger and correlation-context contract adopted at the web, worker, job-runner, shared smoke lifecycle, Plan 6B production-smoke, and Plan 6B fixture-probe boundaries.
3. One exhaustive job-definition catalog and a separate protected operations boundary for minimized job metadata and audited retry commands.
4. A freshness-bearing worker-health contract that detects a stalled polling loop rather than proving startup only.
5. Reusable owned-Compose and production-smoke lifecycle infrastructure with stable safe stage codes, exact cleanup, immutable candidate identity, and machine-readable evidence.
6. Explicit separation between hermetic unit/watch tests and Docker- or PostgreSQL-backed release witnesses.
7. Relocation of the generic PostgreSQL application rate-limit service into a shared security namespace without table, namespace, counting, expiry, or route behavior changes.
8. A typed production-live vocabulary and activation contract that remains unusable until a later Plan 7 phase supplies and verifies the complete launch authorization.

Every intermediate checkpoint must leave the application runnable and production fail-closed.

## 4. Non-goals and later Plan 7 handoff

Plan 7A does not add:

- public production activation or live Stripe enablement;
- an administrator operations page, retry button, or navigation entry;
- monitoring storage, dashboards, alert rules, alert delivery, or service-level objectives;
- new rate-limited routes or final rate-limit values;
- scheduled, encrypted, retained, or off-host backup transport;
- periodic restore-drill scheduling;
- final read-only-root-filesystem, secret-provider, image-digest, host-firewall, SSH, patching, or VPS hardening;
- final web/worker pool, PostgreSQL, CPU, memory, PID, disk, ingestion, or retention tuning;
- a GitHub Actions workflow or automatic deployment;
- zero-downtime deployment, high availability, Redis, S3 migration, service splitting, or queue replacement;
- broad decomposition of refund review, financial source, reconciliation, reporting, database-role, migration, restore-verifier, or browser-harness modules; or
- changes to commerce, entitlement, financial allocation, issue, audit, publication, authentication, or provider semantics.

Later Plan 7 designs use these foundations to add operational monitoring and alerts, administrator recovery experiences, remaining route throttles, automated off-host backup and restore operations, container/VPS hardening, capacity validation, deployment orchestration, and final reversible activation.

## 5. Chosen architecture and rejected alternatives

### 5.1 One foundation specification with internal checkpoints

Plan 7A is one design because correlation, job identity, safe failure vocabulary, candidate identity, and fail-closed evidence must agree across web, worker, operations, and smoke boundaries. Its four independently reviewable checkpoints receive separate implementation plans. This keeps each executable workstream bounded without fragmenting the shared architecture.

Foundation modules are leaves or narrow adapters. A foundation may depend on shared database types, configuration types, or Node primitives. It must not import routes, the worker entrypoint, browser harnesses, or financial orchestrators. Domain adapters may depend on a foundation; the reverse dependency is forbidden.

### 5.2 Rejected: two separate foundation specifications

Splitting release control from observability and job operations would reduce each document's size, but it would create competing definitions for correlation identifiers, safe errors, worker freshness, stage evidence, and operational candidate identity. The internal checkpoints provide the same review isolation without fragmenting those contracts.

### 5.3 Rejected: refactor only while adding each later feature

Deferring every seam until its consuming feature would encourage direct additions to the oversized job repository and smoke runners, inconsistent structured events, and duplicated Docker ownership logic. It would also make later production changes harder to distinguish from behavior-preserving dependency work.

### 5.4 Rejected: broad pre-production rewrite

The financial modules have extensive focused concurrency, lock-order, replay, migration, restore, and browser coverage. Reorganizing their transaction bodies or introducing a generic unit-of-work abstraction before launch has poor risk-to-value. Plan 7A extracts only the authority leaf that later monitoring and retry policy need to consume safely.

## 6. Financial projection-authority leaf

### 6.1 Extracted contract

The current `FinancialProjectionAuthority` type, canonical parser, `loadFinancialProjectionAuthority`, `lockFinancialProjectionAuthority`, and `lockFinancialProjectionEnrollment` move from the replay orchestrator into a leaf financial module. The module owns only authority parsing and its existing read/lock queries.

`rebase`, `ledger`, refund projection, dispute projection, payout, scan, and refund-review consumers import the leaf directly. Tests mock the leaf rather than the replay orchestrator. The extraction removes the direct `rebase ↔ ledger`, `rebase ↔ refund source`, and `rebase ↔ dispute source` cycles.

### 6.2 Preserved behavior

The move must preserve query text and selected columns, canonical validation, error types and safe codes, transaction objects, lock statements, and call order. It must not change classifier or allocation versions, enrollment semantics, projection results, issue transitions, retries, or audit output.

No financial transaction is split or combined. No new transaction abstraction is introduced. Focused projection, source, lock-order, replay, refund-review, and race tests remain authoritative witnesses.

## 7. Structured logging and correlation

### 7.1 Logger boundary

Plan 7A adds an in-repository structured-logging interface with no remote transport. Production records use schema version `1` and are newline-delimited JSON written to standard output or standard error for collection by the container runtime and later monitoring.

Every record contains exactly the common envelope keys `version`, `timestamp`, `severity`, `service`, `event`, and `outcome`, followed only by the event-specific keys in Section 7.4. `version` is the integer `1`, and `timestamp` is RFC 3339 UTC. Severity is exactly `debug`, `info`, `warn`, or `error`; outcome is exactly `started`, `succeeded`, `failed`, `denied`, or `noop`. Service, event, safe-code, job-kind, profile, and stage tokens match `^[a-z][a-z0-9._-]{0,99}$`; IDs documented as UUIDs use canonical lowercase UUID text; `workerId` matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`; `route` is bounded to 200 characters; `slotId` and resource counts are nonnegative 32-bit integers; attempt, generation, configured-slot, and maximum-attempt values are positive 32-bit integers; and `durationMs` is an integer from 0 through 86,400,000. An evidence fingerprint is exactly a lowercase SHA-256 value. All textual fields serialize as JSON strings, numeric fields as JSON integers, and flags as JSON booleans; `null`, arbitrary object spreading, nested values, and undeclared keys are forbidden.

The logger owns serialization, primitive bounds, key allowlists, timestamp injection, and sink selection. Domain code does not construct JSON strings or choose container transports.

### 7.2 Context ownership

Web ingress reads only the `x-request-id` header and creates one logging context before maintenance and authentication decisions. A value matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$` remains stable; an absent or nonmatching value is replaced with a lowercase UUID generated before the first event. The canonical value is used by every Plan 7A-migrated log and audit boundary. Correlation remains diagnostic and never becomes an idempotency input. Plan 7A adds no response-header echo.

The worker creates a child context for each claimed job from safe queue identity: job ID, registered kind, attempt, generation when present, worker ID, and a validated or generated correlation ID. A scheduler or command may supply an existing safe correlation ID; otherwise the worker owns generation.

Node `AsyncLocalStorage` carries logging context across asynchronous calls, but domain authorization, idempotency, locking, database writes, and provider decisions continue to receive explicit inputs. Ambient context is diagnostic only. Tests and command-line entrypoints can inject an explicit context and clock.

### 7.3 Safe error contract

Production structured records never serialize raw exceptions, stacks, SQL, URLs, headers, cookies, secret paths or values, provider bodies, webhook signatures, job or outbox payloads, deduplication keys, email addresses, action URLs, reset tokens, payment or address data, storage object keys, credential hashes, or unrestricted user input.

Errors are reduced to a fixed safe class, safe code, operation, outcome, correlation ID, and bounded public state. Existing domain safe codes remain authoritative and are not replaced with raw messages. Unknown errors become `unexpected_failure`.

Untrusted correlation and error inputs are normalized before event construction. After normalization, event construction accepts exact trusted typed fields only. In development and tests, an unsupported programmer-supplied key or out-of-bounds typed value fails the calling test or explicit validation operation. In production, logging itself must not alter the domain outcome: a serialization or sink-format failure makes one nonrecursive attempt to emit the smallest valid `logging.failure` record and otherwise returns without throwing. Startup configuration validation may still terminate its owning process through the existing fail-closed startup path.

### 7.4 Initial adoption boundary

Plan 7A adopts the logger for `http.request.completed`, `http.request.rejected`, and `http.request.failed`; `worker.started`, `worker.ready`, `worker.stopping`, `worker.stopped`, and `worker.failed`; `job.claimed`, `job.succeeded`, `job.failed`, and `job.lease_lost`; and `worker.heartbeat_failed`. It also uses the same safe-record encoder in the generalized smoke lifecycle, `plan6b-production-smoke`, and `plan6b-fixture-runtime-probe`. Successful heartbeat publication is not logged every interval. Plan 7A does not mechanically replace every historical console call or change unrelated CLI output. Later phases migrate additional entrypoints as they add monitorable events.

The initial event contracts are exact. The fixed `service` value is `web` for HTTP events, `worker` for worker and job events, and the registered consumer identifier `plan6b-production-smoke`, `plan6b-fixture-runtime-probe`, or `plan7a-release-candidate` for smoke events; the shared smoke library cannot accept an arbitrary service string. `method` matches `^[A-Z]{1,16}$`. `route` is a static SvelteKit route identifier or normalized template, never a URL, query, or customer-supplied path segment. `httpStatus` is an integer from 100 through 599. `correlationId` follows Section 7.2. `runId` retains the current owned-resource grammar `^[a-f0-9]{16}$`; `candidateId` and `jobId` are canonical lowercase UUIDs. `retryScheduled` is a boolean. The four cleanup counters are always present, including when zero. A fallback `logging.failure` record retains the fixed service of its producer and has no additional keys, avoiding recursion through field validation.

| Event | Severity / outcome | Required additional keys | Optional additional keys | Sink |
| --- | --- | --- | --- | --- |
| `http.request.completed` | `info` / `succeeded` | `correlationId`, `method`, `route`, `httpStatus`, `durationMs` | none | stdout |
| `http.request.rejected` | `warn` / `denied` | `correlationId`, `method`, `route`, `httpStatus`, `code`, `durationMs` | none | stderr |
| `http.request.failed` | `error` / `failed` | `correlationId`, `method`, `route`, `httpStatus`, `code`, `durationMs` | none | stderr |
| `worker.started` | `info` / `started` | `workerId`, `configuredSlots` | none | stdout |
| `worker.ready` | `info` / `succeeded` | `workerId`, `configuredSlots`, `durationMs` | none | stdout |
| `worker.stopping` | `info` / `started` | `workerId`, `code` | none | stdout |
| `worker.stopped` | `info` / `succeeded` | `workerId`, `durationMs` | none | stdout |
| `worker.failed` | `error` / `failed` | `code` | `workerId` | stderr |
| `job.claimed` | `debug` / `started` | `correlationId`, `jobId`, `jobKind`, `attempt`, `maxAttempts`, `workerId`, `slotId` | `generation` only when the registered parser produces it | stdout |
| `job.succeeded` | `info` / `succeeded` | `correlationId`, `jobId`, `jobKind`, `attempt`, `workerId`, `slotId`, `durationMs` | `generation` under the same rule | stdout |
| `job.failed` | `warn` iff `retryScheduled` is true, otherwise `error`; `failed` | `correlationId`, `jobId`, `jobKind`, `attempt`, `maxAttempts`, `workerId`, `slotId`, `code`, `durationMs`, `retryScheduled` | `generation` under the same rule | stderr |
| `job.lease_lost` | `warn` / `failed` | `correlationId`, `jobId`, `jobKind`, `attempt`, `workerId`, `slotId`, `code` | `generation` under the same rule | stderr |
| `worker.heartbeat_failed` | `error` / `failed` | `workerId`, `code` | none | stderr |
| `logging.failure` | `error` / `failed` | none | none | stderr |
| `smoke.stage.started` | `debug` / `started` | `profile`, `runId`, `candidateId`, `stage` | none | stdout |
| `smoke.stage.succeeded` | `info` / `succeeded` | `profile`, `runId`, `candidateId`, `stage`, `durationMs` | none | stdout |
| `smoke.stage.failed` | `error` / `failed` | `profile`, `runId`, `candidateId`, `stage`, `code`, `durationMs` | none | stderr |
| `smoke.cleanup.succeeded` | `info` / `succeeded` | `profile`, `runId`, `candidateId`, `durationMs`, `containerCount`, `networkCount`, `volumeCount`, `temporaryRootCount` | none | stdout |
| `smoke.cleanup.failed` | `error` / `failed` | `profile`, `runId`, `candidateId`, `code`, `durationMs`, `containerCount`, `networkCount`, `volumeCount`, `temporaryRootCount` | none | stderr |
| `smoke.run.succeeded` | `info` / `succeeded` | `profile`, `runId`, `candidateId`, `durationMs`, `evidenceFingerprint` | none | stdout |
| `smoke.run.failed` | `error` / `failed` | `profile`, `runId`, `candidateId`, `stage`, `code`, `durationMs` | none | stderr |

Event-specific tests assert every required field, reject every extra field, and verify the fixed severity, outcome, bounds, and sink.

Caddy logging remains a separate edge concern. Existing deletion of sensitive URI data and the associated policy test remain mandatory; application correlation must not reintroduce query strings or credentials into proxy logs.

## 8. Job definitions and operations authority

### 8.1 Exhaustive job definition

The current worker binds ten job families: outbox dispatch, claim email, claim request, Stripe event, financial source, financial payout, financial scan, financial classification, financial administrator command, and revision ingestion. Plan 7A adds the internal operations retry-command family.

A dependency-light job-definition catalog owns, for every kind:

- the stable kind string and safe operator label;
- the existing automatic attempt and backoff contract or its authoritative owner;
- the administrator-retry classification;
- the named policy adapter allowed to evaluate or perform recovery;
- whether provider verification is required;
- the safe states and reason codes that operations may expose; and
- whether the kind is excluded from administrator retry.

The worker assembly layer separately binds every definition to one handler. Exact type and test coverage require one definition and one handler for every production kind, with no duplicates or unregistered handlers. Operations code imports definitions and policy interfaces, never the worker entrypoint or handler implementations.

### 8.2 Retry policy classes

There is no generic `reset failed job` method. Every administrator retry is one of four explicit dispositions:

- `never`: the job or its domain command has a terminal one-outcome contract and cannot be retried through general operations;
- `rearm_existing`: an existing domain primitive may rearm the same durable identity only under its current exact predicates;
- `enqueue_successor`: the domain must validate current source state and create or adopt a new generation or permanent key;
- `provider_verified_recovery`: current provider state must be queried and minimized before the domain decides whether any rearm, successor, no-op, or exception is valid.

The financial administrator command and operations retry-command jobs are always `never`; their terminal command results cannot be reopened by resetting queue rows. Delivered outbox messages are never redelivered. Revision ingestion must retain its staged-source, generation, and checksum predicates. Stripe events retain pending-event and provider-identity rules. Financial source, payout, scan, and classification work retain their version, generation, active-entity, replay, and enrollment fences.

Plan 7A implements the catalog and protected command execution boundary. Only adapters backed by an already implemented domain rearm or successor primitive may perform an effect in Plan 7A. `provider_verified_recovery` entries remain explicitly unavailable with the safe result `provider_recovery_not_enabled` until a later design supplies minimized provider verification. A later operator interface may submit supported policies but cannot add a fifth generic escape hatch.

All automatic retries remain owned by the current job repository's configured exponential backoff, `JOB_RETRY_BASE_MS` capped by `JOB_RETRY_MAX_MS`; Plan 7A does not change that algorithm. The exhaustive initial catalog is:

| Stable kind | Automatic maximum | Administrator disposition | Plan 7A adapter and exact eligibility | Provider call |
| --- | ---: | --- | --- | --- |
| `outbox.dispatch` | 8 | `rearm_existing` | Not enabled in 7A; returns `retry_policy_not_enabled`. A later adapter must require the linked outbox message to be failed and undelivered. | No |
| `commerce.claim-email` | 8 | `enqueue_successor` | Not enabled in 7A; returns `retry_policy_not_enabled`. A later adapter must revalidate the current claim receipt and email issuance state. | No |
| `commerce.claim-email-request` | 8 | `enqueue_successor` | Not enabled in 7A; returns `retry_policy_not_enabled`. A later adapter must revalidate the one-use claim-request state. | No |
| `commerce.stripe-event` | 12 | `rearm_existing` | Enabled through the existing pending-event rearm primitive only when the target job is failed and the exact Stripe event remains pending and unprocessed. | No |
| `commerce.financial-source` | 12 | `enqueue_successor` | Not enabled in 7A; returns `retry_policy_not_enabled`. A later adapter must use current source identity, active-entity, version, and enrollment fences. | No |
| `commerce.financial-payout` | 12 | `enqueue_successor` | Not enabled in 7A; returns `retry_policy_not_enabled`. A later adapter must use current payout generation and supported payout-state predicates. | No |
| `commerce.financial-scan` | 8 | `enqueue_successor` | Not enabled in 7A; returns `retry_policy_not_enabled`. A later adapter must preserve scan kind, replay, continuation, and active-child predicates. | No |
| `commerce.financial-classification` | 5 | `rearm_existing` | Enabled through the existing classification rearm primitive only when the target identity, fingerprint, classifier version, allocation version, and replay state remain exact. | No |
| `commerce.financial-admin-command` | 8 | `never` | Always returns `retry_not_supported`; its command result is terminal. | No |
| `catalog.ingest_revision` | 5 | `enqueue_successor` | Not enabled in 7A; returns `retry_policy_not_enabled`. The current primitive performs storage copying before its own transaction and must be redesigned before it can share an atomic operations-command result. | No |
| `operations.job-retry-command` | 8 | `never` | Always returns `retry_not_supported`; terminal recovery commands cannot recursively retry themselves. | No |

The only accepted submission reason codes are `dependency_recovered`, `configuration_recovered`, and `operator_reassessment`. They are audit classifications, not free-form explanations and not proof that recovery occurred. Terminal result codes are exactly:

- success/no-op: `rearmed_existing`, `successor_enqueued`, `already_current`;
- denial: `retry_not_supported`, `retry_policy_not_enabled`, `provider_recovery_not_enabled`, `target_not_failed`, `target_state_changed`, `domain_state_not_retryable`, `source_unavailable`, `actor_not_authorized`; and
- failure: `retry_command_invalid`, `retry_command_exhausted`, `unexpected_failure`.

Adding or enabling a catalog row later requires an approved design amendment or later design that names its adapter, lock order, evidence inputs, exact eligibility, safe results, and denial tests. An implementation plan may implement only the matrix approved here. Catalog completeness alone is never proof that a retry is safe.

The two enabled Plan 7A adapters are fixed as follows:

- **Stripe event:** strict private payload parsing yields only the Stripe-event row ID. In one final transaction, the order is operations command → Stripe event → target job. The adapter reuses the existing event/job identity predicates and additionally requires the submitted target ID, type, attempts, maximum attempts, and `updated_at` to match, the target to be exhausted `failed`, the event to remain `pending`, the payload to equal `{ stripeEventId }`, the deduplication key to match the provider-event identity, and maximum attempts to equal 12. The only success is `rearmed_existing`. A changed target returns `target_state_changed`; a nonpending event or nonretryable domain state returns `domain_state_not_retryable`; an identity-integrity violation fails `retry_command_invalid`. No provider call occurs.
- **Financial classification:** strict private payload parsing yields subject type and ID, source fingerprint, classifier version, allocation version, replay ID, and optional scan-run binding. In one final transaction, the order is operations command → financial projection authority → projection enrollment → target classification job. The adapter requires the active/pending authority and enrollment fence to permit the exact payload versions, the submitted target state to match, the job to be exhausted `failed`, maximum attempts to equal 5, and the permanent identity, replay, and scan-run relationships to pass the existing classification parser. The only success is `rearmed_existing`. Changed job state returns `target_state_changed`; obsolete authority, enrollment, replay, or subject state returns `domain_state_not_retryable`; an identity-integrity violation fails `retry_command_invalid`. No provider call occurs.

### 8.3 Minimized operational read model

Plan 7A preserves the web login's existing narrow column grants: job insert columns plus `jobs.id` and `jobs.deduplication_key`, and outbox insert columns plus its existing non-payload delivery metadata. It does not convert those grants into table-wide access or expose job payload, job status, attempts, raw job error, or worker lease columns directly. The runtime group remains excluded from table-wide `jobs`, outbox, financial-command, and private-claim selection.

The owner-controlled `list_operational_jobs` routine exposes a bounded operational DTO containing only job ID, registered kind and safe label, status, attempts, maximum attempts, run and lifecycle timestamps, safe retry disposition, an allowlisted safe failure code, and the expected-state fields needed by submission. It accepts optional exact registered-kind and status filters, an `(updated_at, id)` descending cursor, and a limit from 1 through 100 with default 50. Unknown filters, malformed cursors, unregistered kinds, and values outside the bound fail before querying. There is no unbounded list, count, offset, text search, or payload predicate.

The DTO excludes payload, deduplication key, raw last error, lease owner, provider evidence, command input, customer identity, and every secret-bearing field. A safe failure code is produced only by exact mapping from the runner's bounded safe messages; every other value becomes `unexpected_failure`. Unknown or unregistered kinds are reported through a safe aggregate/operator code and are never made retryable.

### 8.4 Audited asynchronous retry command

The operations retry-command row has no arbitrary JSON input. It stores only command ID, fixed kind `retry_failed_job`, actor user ID, target job ID and registered type, expected failed status, expected attempts, expected maximum attempts, expected target `updated_at`, one accepted reason code, correlation ID, idempotency-key SHA-256, canonical-input SHA-256, status, safe result code, and created, updated, and completed timestamps. Status is exactly `pending`, `succeeded`, `denied`, or `failed`; the last three are terminal. A `succeeded` no-op uses `already_current`. A pending row has no result or completion time; every terminal row has exactly one allowed result code and finite completion time. Identity, target binding, expected state, reason, correlation, and hashes are immutable.

The internal job payload is exactly `{ "commandId": "<uuid>" }`, its deduplication key is derived from that command ID, and its maximum attempts are 8. Command rows are retained and non-deletable in Plan 7A; protected routines may update only lifecycle columns. Terminal audit evidence remains append-only. No runtime role receives delete authority and no automatic retention task is added.

Submission is the only creator and always creates `pending`. The only authorized command transitions are `pending → succeeded`, `pending → denied`, and `pending → failed`; terminal state never changes. Claim and takeover change only the internal job and its private operations claim. Under the live capability, the handler locks a pending command and performs current-role authorization, expected-state validation, the policy effect or safe disposition, the command terminal transition, and terminal audit in one transaction. An already-terminal command is replay evidence: the handler performs no policy effect and returns normally so the runner can finish the internal job. An exception before the handler transaction commits leaves the command pending.

The existing `jobs.retry` capability governs listing and submission. The Plan 7A service authorizes before parsing or querying; a later route must delegate to that service rather than recreate authorization. Each owner-controlled routine acquires the administrator-role lock, reloads current roles, and requires the capability. Submission validates the job ID, expected registered kind, expected `failed` status, attempts, maximum attempts, and `updated_at` value returned by the safe DTO, validates a bounded reason code and correlation ID, and rejects stale disagreement. It validates the supplied idempotency and input hashes, creates one idempotent retry command and requested audit event, and enqueues the fixed internal operations-command job atomically. Reusing an idempotency key with different canonical input fails without mutation.

The application computes hashes from a canonical lowercase UUID idempotency key and the exact canonical command input, following the existing financial-command pattern. The database validates both lowercase SHA-256 values and the canonical-input binding. Uniqueness is `(actor_user_id, idempotency_key_sha256)`; an exact replay returns the same owner-scoped safe command status.

The owner-controlled callable surface is fixed to `list_operational_jobs(actor uuid, status text, kind text, before_updated_at timestamptz, before_id uuid, page_size integer)`, `submit_job_retry_command(actor uuid, target_job uuid, expected_kind text, expected_attempts integer, expected_max_attempts integer, expected_updated_at timestamptz, reason_code text, correlation_id text, idempotency_key_sha256 text, input_fingerprint_sha256 text)`, and `get_owned_job_retry_command(actor uuid, command_id uuid)`. Nullable filters and cursor pairs must be both absent or both present.

The exact ACL tuples grant `EXECUTE` only to the database owner and `pale_orbit_runtime`; `PUBLIC` and storage cleanup have none. Because the fixed financial-worker group inherits runtime, it has inherited effective `EXECUTE` but no direct ACL tuple. Every web-surface routine therefore applies the existing fail-closed `session_user` guard: the invoker must be a runtime member and must not be a financial-worker or storage-cleanup member. The database owner retains owner privilege but fails that application-caller guard. Private claim and transition routines grant only owner and financial-worker ACL tuples and reject runtime-only and cleanup session identities. ACL verification distinguishes direct tuples from inherited effective privilege and separately proves every `session_user` guard.

Bounded list and owner-scoped status reads are not audited. Submission and every terminal command disposition are audited; a later route does not add duplicate audit events.

The web role receives no new or broader direct command-table, job-table, outbox, audit, or worker mutation grant. Safe list, submission, and owner-scoped status exist only through the complete routines above.

Possession of the worker credential is necessary but not sufficient to mutate an operations retry command. Plan 7A adds a separate opaque, task-specific operations-job lease capability bound to the internal command job ID, claim generation, attempt, lease owner, and current lease. It does not reuse or broaden the financial-administrator claim capability or its private table. Each claim or takeover rotation creates exactly one fresh 256-bit value with Node `randomBytes(32).toString('base64url')`. The 43-character unpadded clear value exists only in worker memory, the internal job record, and the transaction-local `pale_orbit.plan7a_operations_job_capability` setting during an authorized claim, renewal, handler, or terminal transaction. Only its lowercase SHA-256 digest is persisted in the private operations-claim row; the clear capability never enters a table, payload, command, DTO, audit event, log, error, response, or restore evidence.

Claim rotation atomically increments generation, binds the positive attempt and lease owner, resets issuance, renewal, expiry, and invalidation state, and replaces the digest as the job becomes `running`. Renewal accepts only the current clear capability, digest, job, generation, attempt, lease owner, unexpired claim, and running job. Issue, renewal, expiry, takeover, and invalidation use PostgreSQL `clock_timestamp()`; Node time is not lease authority. After an ordinary handler transaction commits a terminal command and audit, a separate capability-aware completion transaction validates that terminal command, changes the internal job from `running` to `succeeded`, and invalidates the claim atomically. Retryable failure or relinquishment before a command result invalidates the claim atomically as the job returns to `pending`; the next claim must rotate to a new capability and strictly greater generation. Only exhausted or early permanent-failure synchronization may atomically terminalize a still-pending command, the failed job, its audit, and claim together. Missing, forged, expired, invalidated, prior-generation, cross-job, cross-attempt, and cross-worker values fail closed without revealing which predicate failed.

The worker reauthorizes the submitting administrator at execution, proves the operations capability, locks and validates the command, compares the target's current state with the submitted expected state, and dispatches the registered policy adapter. The adapter owns its existing domain lock order and complete transaction boundary. The operations layer must not lock a target job and then call a domain routine whose order begins with another entity; target job access occurs at the adapter's published position.

The operations command path is administrator-role advisory lock → per-operations-job shared lease advisory lock → operations command → policy-specific domain order. Claim, takeover, and capability-aware terminal synchronization use internal operations job row → per-operations-job exclusive lease advisory lock → private operations claim → operations command. No path locks the command and then waits for the internal operations job row or exclusive lease lock. Policy adapters publish their target-domain order and must not invert an existing entity → job enqueue order.

Success, denial, no-op, and permanent failure produce one terminal safe command result and terminal audit event. Audit actions are exactly `operations.job_retry.requested`, `operations.job_retry.succeeded`, `operations.job_retry.denied`, and `operations.job_retry.failed`. Audit metadata is limited to command ID, target job ID, registered kind, reason code, result code, correlation ID, and—after a route exists—the exact method and route identifier. It contains no free-form reason, expected-state fingerprint, payload, error, provider evidence, or lease capability.

The domain transition, terminal command state, and append-only audit event commit atomically for every effect and terminal disposition; ordinary internal-job completion is the separate transaction described above. Transient operations-command failures use the same configured exponential backoff and the fixed maximum of 8. If attempts exhaust or the operations handler fails permanently before producing a terminal command result, the runner's capability-aware terminal synchronization changes the still-pending command to `failed` with `retry_command_exhausted` or `unexpected_failure` atomically with job failure, its audit event, and claim invalidation. A crash before the handler commit rolls back. A crash after that commit but before job completion leaves terminal replay evidence; takeover observes it, performs no second effect, and completes the job under a freshly rotated capability.

Plan 7A performs no provider network call for a retry command. A later `provider_verified_recovery` adapter must use two phases: an unlocked, bounded, abortable provider read that produces a minimized canonical evidence fingerprint, followed by one final transaction that reacquires and revalidates current role, live operations capability, command, expected target state, and provider binding before atomically committing the domain transition, terminal result, and audit. Provider I/O while holding database locks is forbidden.

### 8.5 Migration and routine surface

Plan 7A takes the next append-only migration, `0015`, for the operations retry-command schema, complete owner-controlled routines, exact triggers, indexes, constraints, revocations, and worker grants. It does not edit migrations `0001` through `0014`.

The migration and role provisioner preserve the four exact principals and the existing default-ACL baseline. New command and operations-claim storage is private by default. Public routine execution is revoked; only the exact fixed application group receives a direct ACL tuple for each reviewed boundary. Verification separately proves direct ACL tuples, inherited effective privileges, and the fail-closed runtime-identity behavior required by Section 8.4. The migration, role provisioner, schema-preservation tests, executable restore verifier, checkpoint catalog, and distinct-engine rehearsal must agree on the final objects, ownership, ACLs, routine definitions, and triggers.

## 9. Worker freshness contract

The current worker-ready file proves only that initial probes succeeded and the polling loop started. Plan 7A replaces it with a versioned per-process heartbeat record published by one supervisor writer through atomic replace in the worker's private temporary filesystem. Worker slots report progress to the in-memory supervisor and never write the file directly.

The record contains only version `1`, worker ID, process start time, publication time, supervisor sequence, configured slot count, and one entry for every slot. A slot entry contains slot ID, state `polling`, `idle`, or `handling`, its last successful poll time, and its last progress time. An empty poll is successful. A handling slot advances progress only through the existing successful job-lease renewal path or terminal handler completion; merely awaiting a handler does not count. A dependency failure, unhandled poll failure, lost control loop, lost lease, malformed publication, missing slot, or wedged process does not advance the affected progress value.

Plan 7A adds the worker-process-only settings `WORKER_HEARTBEAT_INTERVAL_MS` with default 5,000 and `WORKER_HEARTBEAT_MAX_AGE_MS` with default 20,000. The interval is constrained to 1,000–30,000 milliseconds. Maximum age is constrained to at least three heartbeat intervals, at least `JOB_POLL_INTERVAL_MS + (2 × WORKER_HEARTBEAT_INTERVAL_MS)`, less than `JOB_LEASE_MS`, and no more than 300,000 milliseconds. Clock-future tolerance is fixed at 5,000 milliseconds.

The supervisor refuses its own time or sequence regression and serializes publication. A stateless container health check validates schema, worker-ID grammar, configured slot count, publication freshness, and every slot's progress freshness. Missing, malformed, future-dated beyond tolerance, or stale evidence fails health. No stateless check claims to infer historical counter regression from one record. The health check never needs database credentials and never exposes a public metrics endpoint.

Worker shutdown stops heartbeat updates before database and storage clients close. Startup does not report healthy until dependency probes and the first successful cycle complete. Later monitoring may consume container health and a separate safe aggregate signal; Plan 7A adds no alert transport.

## 10. Smoke lifecycle, release evidence, and test profiles

### 10.1 Shared owned-Compose lifecycle

The Plan 6B smoke and fixture probe already use random owned projects, loopback-only services, resource labels, manifests, bounded subprocesses, nested cleanup, and exact absence checks. Plan 7A extracts those mechanisms into a reusable script library rather than cloning either runner.

The lifecycle owns project and run identity, immutable image reference, approved Compose inputs, created-resource discovery, manifest validation, bounded execution, termination, and cleanup. It refuses resources outside the owned project and expected labels. Cleanup verifies the absence of every owned container, network, volume, and temporary root. It never deletes a resource inferred only from an untrusted name or broad filesystem path.

Existing Plan 6B maintenance smoke remains a supported consumer and retains its behavioral assertions.

### 10.2 Stage and evidence model

Every smoke step has a stable safe stage code. The initial vocabulary includes `preflight`, `build`, `compose-config`, `migrate`, `provision`, `checkpoint-capture`, `restore-rehearsal`, `runtime-start`, `runtime-health`, `inspect`, `behavior`, `shutdown`, and `cleanup`. Consumers may use a documented subset but may not invent raw subprocess text as a stage.

Evidence profiles are exactly `maintenance_fixture` and `release_candidate`. Their required stages are not caller-selectable:

| Profile | Exact required stages in order |
| --- | --- |
| `maintenance_fixture` | `preflight` → `build` → `compose-config` → `migrate` → `provision` → `runtime-start` → `runtime-health` → `inspect` → `behavior` → `shutdown` → `cleanup` |
| `release_candidate` | `preflight` → `build` → `compose-config` → `migrate` → `provision` → `checkpoint-capture` → `restore-rehearsal` → `runtime-start` → `runtime-health` → `inspect` → `behavior` → `shutdown` → `cleanup` |

A maintenance fixture may run from a dirty developer tree, is always marked non-release, and cannot satisfy a later activation input. Its `sourceMode` is `workspace_fixture`; it records the starting `HEAD` as an informational `sourceRevision`, records the actual `sourceClean` boolean, and materializes an exact frozen workspace context containing tracked modifications and untracked nonignored inputs after applying the workspace `.dockerignore`. A release candidate requires a clean Git worktree including no untracked nonignored files. Its `sourceMode` is `committed_revision`, `sourceClean` is true, and the runner exports the exact `HEAD` tree. Both modes use a new restricted empty build root, Docker-compatible ignore matching, and only the selected source blobs plus the selected Dockerfile; both reject submodules, unsupported file modes, path escapes, missing build inputs, or a source change during snapshotting. Ignored worktree content cannot enter either build.

Before invoking Docker, the runner independently computes `buildContextSha256` as lowercase SHA-256 over canonical UTF-8 JSON containing a version-1 marker, `sourceMode`, `sourceClean`, the selected `.dockerignore` and Dockerfile content digests, and the included entries sorted by UTF-8 path, each with exact path, normalized executable/nonexecutable Git mode, and content SHA-256. Object keys are recursively sorted, array order is preserved, and serialization uses LF with no insignificant whitespace. The build sets `org.opencontainers.image.revision` to the lowercase 40-hex starting commit, `com.paleorbit.plan7a.source-mode` to the exact mode, `com.paleorbit.plan7a.source-clean` to `true` or `false`, and `com.paleorbit.plan7a.build-context-sha256` to the computed digest. Inspection requires those exact labels, records Docker's resulting `sha256:<64 lowercase hex>` content-addressed local `imageId`, and makes Compose use that exact local image with pulling disabled. The evidence binds `imageId`, `sourceMode`, `sourceClean`, `sourceRevision`, and `buildContextSha256`; there is no Plan 7A field named `imageDigest`. A mutable tag or externally supplied image cannot satisfy the release-candidate profile. A later design may add a distinct registry-digest field and trusted signed-OCI-provenance alternative. Every success record expires 24 hours after completion; later activation may require a shorter release-candidate window.

The existing `plan6b-production-smoke` and `plan6b-fixture-runtime-probe` consumers may emit only `maintenance_fixture` evidence; neither can claim checkpoint or restore-rehearsal completion. The new `plan7a-release-candidate` coordinator alone owns the complete `release_candidate` stage sequence and may invoke the production-smoke behavior through the shared lifecycle. The fixture-runtime probe remains a separate final-gate witness and cannot be promoted into release-candidate evidence because it deliberately uses test fixture mode.

A successful record is schema version `1`, names its profile, run ID, candidate ID, issued and expiry times, and exact required-stage set, and binds the exact `imageId`, `sourceMode`, `sourceClean`, `sourceRevision`, `buildContextSha256`, verified image labels, Compose project, normalized nonsecret configuration fingerprint, declared origin identity, migration tip, database-role attestation result, stage outcomes, start/completion times, and cleanup result. A profile that requires checkpoint or rehearsal also binds the exact backup and capture/restore engine identities; a profile that omits those stages cannot imply recovery evidence. Release-candidate preflight requires the origin to be exact HTTPS with no credentials, query, fragment, noncanonical path, or implicit host ambiguity; isolated maintenance fixtures may use their already approved loopback origin.

Configuration fingerprinting parses the exact `docker compose config --format json` result, validates the topology and secret-slot scope, replaces secret-bearing values with fixed presence tokens in memory, recursively sorts object keys while preserving array order, serializes canonical UTF-8 JSON with LF endings, and hashes those bytes together with the ordered Compose-file content hashes. It never stores the raw resolved configuration, a secret value or hash, an environment dump, secret path, URL credential, raw log, payload, or personal data. The fingerprint binds secret slot names and presence, not secret values; later activation must bind credential versions through a separately approved secret-provider contract.

Each run uses a new restricted empty evidence directory and refuses a pre-existing candidate target. Success evidence is first written to a run-unique temporary file and atomically published only after cleanup absence checks pass. A failed required stage, timeout, interruption, ownership mismatch, configuration mismatch, or cleanup failure yields a nonzero result and no published success record. A separate bounded failure record may be emitted under the same run ID. Human-readable diagnostics remain bounded and privacy-safe; machine records expose stable codes, not secret-bearing standard error.

Every consumer must be given the expected profile, run ID, candidate ID, `imageId`, `sourceMode`, `sourceClean`, `sourceRevision`, `buildContextSha256`, configuration fingerprint, and current time and must reject disagreement or expiry. A release-candidate consumer additionally requires `committed_revision` and true cleanliness. There is no authoritative `latest` pointer, fixed reusable success path, or fallback to a prior run.

Plan 7A evidence is candidate evidence only. It is not activation authorization, and no production configuration accepts it as permission to serve public routes.

### 10.3 Test profiles

The default unit and watch profiles contain only hermetic tests and must not start Docker, PostgreSQL, browsers, network services, or long-running subprocess witnesses. Script unit tests remain included when they are hermetic.

The PostgreSQL restore/commerce witness currently embedded in the nominal unit profile moves to an explicit service-backed profile with its existing bounded supervisor and cleanup guarantees. The final release gate still runs it. Integration tests remain serial unless measurements and a separate design prove safe parallelism for their DDL, role, lock, and multi-connection behavior.

Browser and upgrade harnesses remain focused release profiles. Plan 7A does not rewrite the large financial browser harness or increase timeouts. When Plan 7A changes the restore contract, the executable verifier is canonical; runbooks invoke or reference it rather than embedding a second generated copy that can drift.

## 11. Shared rate-limit boundary

The existing `application_rate_limits` table and service are already generic despite living under the commerce namespace. Plan 7A moves hashing, validation, cleanup, and SQL consumption to a shared server-security namespace. The shared module exposes a dedicated safe invalid-input error and has no dependency on commerce services. A temporary commerce adapter maps that error to the existing `PermanentCommerceError` while existing consumers migrate, preserving route-visible behavior without reversing the dependency.

The move preserves scope hashing, HMAC use for IP scopes, namespaces, fixed-window calculation, counters, maximum-attempt behavior, retry-after calculation, bounded expired-row cleanup, table schema, indexes, SQL, route-visible errors, configuration, and all existing route behavior. No new namespace or protected route is added in Plan 7A.

Later Plan 7 work applies the shared service to downloads and sensitive administrator mutations with separately approved limits and operator documentation.

## 12. Production-live and activation contract

Plan 7A reserves `live` as the final public production application-mode vocabulary and documents the evidence an eventual activation boundary must consume. Configuration validation rejects the reserved value in every runtime environment until a later approved design replaces that unconditional guard. Plan 7A does not create a usable launch overlay or relax current production validation.

The base production Compose definition remains hard-fixed to `APPLICATION_MODE=maintenance`, `STRIPE_ENABLED=false`, and `STRIPE_LIVE_MODE=false`. The Stripe overlay alone remains a test-provider enablement boundary and never becomes a launch switch. Production configuration continues rejecting `live` until a later Plan 7 design adds the guarded activation mechanism and its independently demonstrated prerequisites.

The eventual activation contract must bind an immutable image, exact normalized configuration, exact HTTPS origin, migration and role state, recent coordinated checkpoint, distinct-engine rehearsal, successful production-image smoke, healthy web and worker evidence, alert delivery, backup freshness, and an operator-approved reversible transition. Plan 7A defines this input shape so later tools do not invent incompatible evidence, but it emits no `authorized` state.

Maintenance remains the rollback and incident-containment state. Prototype is never reused as production-live mode.

## 13. Error, concurrency, and rollback behavior

- Unknown job kinds, missing policy adapters, invalid context, unsafe logging fields, stale retry targets, invalid evidence, and attempted activation fail closed.
- Logger failure cannot change a successful or failed domain transaction. Startup validation remains allowed to fail its process.
- A worker heartbeat advances only after successful poll progress; a stale worker becomes unhealthy without mutating queue state.
- Operations commands use expected-state validation and domain-owned lock order. A stale or no-longer-eligible target terminates safely without a rearm.
- Operations command replay is idempotent and terminal. It never repeats a committed domain effect.
- Smoke cleanup runs after success, failure, timeout, or interruption. Cleanup failure fails the run and withholds success evidence.
- Partial Compose creation is treated as owned state to inspect and remove, not as proof that no cleanup is required.
- A checkpoint capture or distinct-engine rehearsal failure retains the existing blocked replacement disposition; Plan 7A does not restart or activate production after failed recovery evidence.
- No checkpoint may leave production in a less restrictive application mode than it found.

## 14. Security and privacy invariants

Plan 7A preserves these non-negotiable rules:

- The database owner, web login, financial-worker login, and storage-cleanup login remain pairwise distinct and inherit only their exact fixed groups.
- No application process receives database-owner credentials.
- The web login retains only its existing reviewed job enqueue/identity columns and outbox enqueue/delivery-metadata columns plus the new complete operations routines. It gains no table-wide job/outbox access and cannot read job or outbox payloads, private command input, worker claims, provider payloads, or financial mutation tables.
- The worker receives only exact new operations-command authority; storage cleanup receives none.
- Every owner-controlled routine has a fixed complete purpose, pinned safe `search_path`, exact input validation, runtime identity checks, explicit revocations, and current-role reauthorization where an administrator acts.
- Logs, evidence, audit metadata, and safe DTOs are separately allowlisted. A field being safe in one boundary does not make it safe everywhere.
- Caddy remains the only published production network edge. PostgreSQL and storage remain private.
- Web publication storage remains read-only; worker publication writes and cleanup authority remain separate.
- Production uses no `.env` file. Direct and `_FILE` settings retain their current mutual-exclusion and process-scope rules.
- Database plus staging, publication, and covers remain one coordinated recovery unit.
- The release-evidence order remains migrate → role provision/attestation → checkpoint capture → distinct-engine rehearsal → production-image smoke.

## 15. Verification strategy

### 15.1 Unit and static verification

Unit and source-shape tests prove:

- projection authority has one leaf owner and the three direct replay cycles are absent;
- authority parsing and query/lock behavior are unchanged;
- every production job definition matches the exact Section 8.2 policy row and has one handler binding;
- unregistered, duplicate, or policy-less kinds fail before worker startup;
- logging accepts only each event's exact keys and bounded values;
- invalid correlation and error inputs become safe output without changing domain outcomes;
- the single heartbeat publisher serializes per-slot progress, enforces the exact interval/max-age/lease constraints, and becomes stale when any slot stops polling or renewing an owned job lease;
- rate-limit digests, windows, counters, cleanup, and decisions are unchanged;
- smoke stages, clean-tree enforcement, configuration canonicalization, run-unique atomic evidence publication, expiry, consumer matching, timeout handling, and cleanup dispositions are deterministic;
- the unit/watch profile cannot invoke the service-backed restore witness; and
- production-live configuration and every unsupported activation attempt remain rejected.

### 15.2 PostgreSQL, authority, and concurrency verification

Integration tests prove:

- migration `0015` is append-only and preserves the exact preflight baseline;
- role provisioning and postflight produce the exact object, owner, ACL, membership, routine, trigger, and default-ACL state;
- web safe-list/status routines cannot return payload, deduplication key, raw error, lease owner, provider data, or private command input;
- unauthenticated, unauthorized, malformed, and oversized submissions create no command or job and follow the existing bounded denied-audit policy without exposing target state;
- stale-role, unknown-kind, ineligible, nonfailed, stale-state, and terminal-command executions produce one terminal denied command and safe audit event without target-domain or outbox mutation;
- absent, forged, expired, rotated, cross-job, cross-generation, or cross-attempt operations capabilities fail before private command input or target-domain mutation;
- source-shape and privacy tests prove the clear operations capability never enters persistence, payloads, DTOs, audit metadata, errors, or logs, while the private claim row contains only its current verifier digest;
- Stripe-event adapter tests prove the exact operations-command → Stripe-event → target-job order, payload and deduplication identity, submitted-state match, exhausted-failure and pending-event predicates, result mapping, and absence of provider calls;
- financial-classification adapter tests prove the exact operations-command → projection-authority → enrollment → target-job order, payload parser, version, fingerprint, replay, and scan-run fences, submitted-state match, exhausted-failure predicate, result mapping, and absence of provider calls;
- every disabled policy returns its fixed `retry_policy_not_enabled` or `provider_recovery_not_enabled` result without target-domain, outbox, or provider mutation;
- racing submissions are idempotent and racing state changes produce at most one valid domain effect;
- transient worker failure, lease loss, process crash, and terminal replay preserve one command outcome and one effect;
- success, denial, no-op, and permanent-failure audit evidence is atomic with the command transition required by that policy; and
- capture, restore, and distinct-engine rehearsal authenticate the new schema and reject missing, altered, excess, or wrongly privileged objects.

### 15.3 Smoke and failure rehearsal

Script and production-image tests cover dirty release input, nonrevision build input, ignored-file injection, context-digest or label mismatch, missing or mutable image identity, invalid Compose configuration, secret-scope conflicts, failed migration or provision, unhealthy web or worker, stale or missing-slot heartbeat, subprocess timeout, partial resource creation, manifest mismatch, cleanup interruption, residual resources, pre-existing evidence targets, expired or mismatched evidence, and attempted activation.

Machine evidence is parsed independently and checked for prohibited keys and values. Existing Plan 6B maintenance behavior remains green through the generalized smoke substrate.

### 15.4 Final gates and independent review

Final evidence includes type and Svelte checks, lint, hermetic unit tests, the explicit service-backed restore witness, PostgreSQL integration tests, browser tests, production builds, migration and role verification, checkpoint capture, distinct-engine rehearsal, and production-image smoke in the established order.

An independent review must examine scope containment, dependency direction, structured-log privacy, job-policy completeness, database authority, lock ordering, command replay, worker-health semantics, Docker ownership, cleanup, evidence binding, restore coverage, and continued production closure. Review findings are resolved and the relevant focused and full gates rerun before completion.

## 16. Delivery checkpoints

### 16.1 Checkpoint A: dependency and test boundaries

Extract projection authority, relocate the rate-limit service, and separate hermetic tests from the service-backed witness. This checkpoint is behavior-preserving and introduces no migration.

### 16.2 Checkpoint B: observability and worker freshness

Add the logger, diagnostic context, safe errors, web/worker/job lifecycle events, and atomic heartbeat. Keep monitoring and alert delivery absent.

### 16.3 Checkpoint C: operations authority

Add the exhaustive job catalog, migration `0015`, safe operational DTOs, asynchronous retry command, policy adapters, worker binding, exact grants, audit, restore verification, and concurrency witnesses. Keep routes and navigation absent.

### 16.4 Checkpoint D: release-control foundation

Extract the owned-Compose lifecycle, adapt existing smoke consumers, add stage/evidence contracts, document the future activation input, and prove production remains maintenance-only.

Each checkpoint receives focused review and passes its applicable checks. The final candidate receives the full verification and independent review in Section 15.

## 17. Acceptance criteria

Plan 7A is complete when:

- financial projection authority has one dependency-leaf owner and the direct replay cycles are gone without financial behavioral change;
- web, worker, job runner, worker health, shared smoke lifecycle, Plan 6B production smoke, and Plan 6B fixture probe emit versioned structured events with validated correlation and no prohibited data;
- logging failure cannot alter a domain outcome;
- every production worker job kind matches the exact Section 8.2 definition, handler, maximum attempts, automatic-retry owner, administrator disposition, adapter availability, eligibility, provider-call rule, and safe result vocabulary;
- operations can read only bounded safe job metadata through complete routines;
- supported retry commands are idempotent, current-role authorized, expected-state guarded, policy-specific, audited, and worker-executed;
- operations command mutation additionally requires its own task-specific live job-lease capability and never broadens the financial-administrator capability;
- no generic job reset exists, financial administrator commands remain terminal, and delivered outbox messages cannot be redelivered;
- the single supervisor publishes exact progress for every configured worker slot, and health fails when publication or any slot is stale, malformed, missing, or future-dated beyond tolerance;
- production smoke consumers share exact owned-resource lifecycle and emit run-unique, expiring, atomically published deterministic safe stage evidence bound to `imageId`, profile-specific source mode and cleanliness, `sourceRevision`, independently computed `buildContextSha256`, verified image labels, and canonical nonsecret configuration;
- timeout, interruption, partial creation, mismatch, or cleanup residue yields failure and no successful candidate evidence;
- unit and watch tests start no Docker, PostgreSQL, browser, or network service, while the release gate retains the service-backed witness;
- the shared rate-limit implementation preserves every existing namespace and decision;
- migration, role, checkpoint, restore, and distinct-engine verification authenticate every Plan 7A database object and privilege;
- all focused and full gates pass and independent review findings are resolved;
- base production Compose remains maintenance-only and Stripe-disabled;
- production `live` remains rejected and no Plan 7A record authorizes activation; and
- later Plan 7 work has one documented contract for logging, correlation, job recovery, worker freshness, smoke evidence, and activation prerequisites.

## 18. Documentation and next step

Plan 7A implementation updates the runtime, database/worker, commerce recovery, storage/checkpoint, authentication/security, and production Compose documentation only where the implemented foundations change an operator command or invariant. Historical Plan 6 documents remain historical.

The executable restore verifier remains canonical. Documentation references its invocation and verified contract rather than duplicating its generated body.

After this design is approved in written form, four detailed Plan 7A implementation plans will map Checkpoints A through D into test-first tasks, exact files and commands, commits, review gates, and applicable release evidence. They execute in checkpoint order, and Checkpoint A is planned first. No Plan 7A implementation begins from this document alone.

## 19. Authoritative references

- [Bookstore Full-Stack Design](2026-08-08-bookstore-full-stack-design.md)
- [Plan 6B Financial Reconciliation and Reporting](2026-08-11-stripe-financial-reconciliation-reporting-design.md)
- [Plan 6B-II Implementation Refresh](2026-08-20-plan-6b-ii-implementation-refresh-design.md)
- [Runtime Environments](../../runtime-environments.md)
- [Database and Workers](../../database-and-workers.md)
- [Commerce and Guest Claims](../../commerce-and-guest-claims.md)
- [Storage, Ingestion, Publication, and Recovery](../../storage-ingestion-and-publication.md)
- [Authentication and Email](../../authentication-and-email.md)
- [Financial Reconciliation and Reporting](../../financial-reconciliation-and-reporting.md)
- [Stripe Financial Reconciliation](../../stripe-financial-reconciliation.md)
