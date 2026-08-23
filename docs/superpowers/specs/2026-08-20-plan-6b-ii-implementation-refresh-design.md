# Plan 6B-II Implementation Refresh Design

**Date:** 2026-08-20

**Architecture status:** Approved implementation architecture

**Implementation status:** Plan 6B candidate — independent review pending

## 1. Purpose

This design refreshed the then-unimplemented Plan 6B-II administrator financial reporting and resolution work so it could be built safely on the hardened database-authority, worker, migration, restore, and deployment foundations.

The approved product behavior in [Plan 6B: Stripe Financial Reconciliation and Reporting](2026-08-11-stripe-financial-reconciliation-reporting-design.md) remains authoritative. This document changes the implementation architecture and delivery structure only where later Plan 6B-I authority work invalidated the original assumptions.

The August 11 implementation plan assumed that an authorized web request could perform financial writes and append `financial.*` audit events in its own database transaction. Current `main` deliberately forbids both. The refreshed design preserves the web/worker credential split instead of weakening it.

The resulting unified Plan 6B candidate is migrated through `0013`: `0012` retains its historical eight callable public boundary routines and `0013` adds the final ninth. Its exact pairwise-distinct principals are `DATABASE_OWNER_USER`, `DATABASE_USER`, `DATABASE_WORKER_USER`, and `DATABASE_STORAGE_CLEANUP_USER`. The web principal owns command submission, owner-scoped status, and route-authorized audit boundaries; only the financial-worker principal owns protected mutation. Candidate evidence remains ordered migrate → provision → checkpoint capture → distinct-engine rehearsal → smoke. Production remains in maintenance mode with Stripe disabled, and Plan 7 owns activation and operability. See the [financial reconciliation and reporting operator guide](../../financial-reconciliation-and-reporting.md).

## 2. Source of truth and document strategy

The behavioral source of truth remains the August 11 Plan 6B design. In particular, this refresh preserves:

- signed, currency-separated financial reporting;
- operational Needs Review without generic issue resolution;
- shared non-effective refund drafts;
- one-way administrative refund finalization;
- append-only reporting corrections that never alter access;
- narrowly proven persistent administrative recovery grants;
- local-only payout reporting;
- bounded, privacy-safe aggregate CSV;
- route and service capability checks, audit atomicity, accessibility, and final independent review; and
- maintenance-mode, Stripe-disabled production through Plan 6B.

The existing August 11 implementation plan remains historical. The executable replacement is [Backend Plan 6B-II: Admin Resolution and Reporting Refresh](../plans/2026-08-20-backend-plan-6b-ii-admin-resolution-reporting-refresh.md); the old plan carries a clear superseded-by pointer. A delta addendum is rejected because implementers would have to reconcile two conflicting mutation architectures. An in-place rewrite is rejected because it would obscure why the authority model changed.

## 3. Scope

Plan 6B-II delivers:

1. Distinct `sales.read`, `sales.export`, and `reconciliation.manage` capabilities.
2. Strict browser-safe financial DTOs, filters, cursors, signed-money display, and command-result contracts.
3. A protected financial-administrator command authority executed by the existing worker.
4. A narrow synchronous audit bridge for audited financial detail reads and completed CSV exports.
5. Sales overview, operational Needs Review, safe issue/refund/payout detail, and aggregate CSV.
6. Shared refund drafts, finalization, reporting corrections, and administrative recovery activation/deactivation.
7. Database-role, migration, restore-catalog, lock-order, privacy, browser, smoke, and release evidence for the completed phase.

Sales navigation remains `Sales — Upcoming` without a live link until the unified candidate passes final review. Direct routes exist only for controlled candidate evidence. Intermediate milestones are implementation checkpoints, not separately released product surfaces.

## 4. Non-goals

Plan 6B-II does not add:

- production activation or live Stripe configuration;
- generic failed-job, outbox, provider-sync, or retry administration;
- monitoring, alerts, backup scheduling, capacity tuning, or CI/CD;
- a generic reconciliation-issue Resolve button;
- customer-identity, provider-object, raw-evidence, or credential-authority exposure;
- browser-initiated Stripe refunds;
- a new web-held financial-worker or owner credential;
- direct web DML on financial, grant, entitlement, job-result, or audit-authority tables; or
- S3, Redis, high availability, zero-downtime deployment, search, series, reviews, subscriptions, or formal accounting.

Those operational launch concerns remain Plan 7 work unless they are required solely to preserve an existing migration, role, restore, or release contract touched by this phase.

## 5. Chosen architecture

### 5.1 Authority split

The web process remains the synchronous read, authorization, validation, and command-submission boundary. It uses only the existing web database credential.

The existing worker remains the financial mutation authority. It executes strict administrator commands using the worker database credential and the canonical TypeScript financial, lock, projection, grant, entitlement, audit, and outbox services.

For a financial-administrator job, possession of the worker credential is necessary but not sufficient to perform a command transition. The current worker generation must also hold the opaque, task-specific job-lease capability described in Section 6.5. This additional proof is deliberately narrower than a generic redesign of job authority.

Owner-owned `SECURITY DEFINER` routines are limited to complete, non-composable boundaries:

- command submission;
- safe command-status retrieval;
- audited financial detail/export completion;
- command-bound linked-issue resolution, with separate finalization and reporting-correction routines; and
- command-bound administrative-grant transition protection.

Full financial mutations are not implemented in PL/pgSQL. Doing so would duplicate the signed allocation, projection, rebase, and access algorithms already implemented in TypeScript. Granular privileged mutation helpers are also forbidden because a runtime caller could compose an incomplete transaction.

### 5.2 Forward migration

Plan 6B-II took the next append-only migration as `0012`; the later correction-authority boundary added append-only `0013`. Neither migration edits `0007` through `0011`.

The migration adds the command schema, routines, triggers, job guard changes, exact worker privileges, runtime revocations, and audit/administrative-grant provenance rules required by this design. It also enters the existing exact catalog, ACL, owner, trigger, routine, upgrade, and restore-verification contracts.

The absolute preflight must preserve, not blanket-reject, migration 0009's canonical normalized default-ACL baseline. With the database owner as both default-ACL owner and grantor and every grant non-grantable, that baseline is: in `public`, the database owner has `INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN` for future tables and `USAGE, SELECT, UPDATE` for future sequences; `pale_orbit_runtime` has `SELECT` for future tables and `USAGE, SELECT, UPDATE` for future sequences; globally, the database owner has routine `EXECUTE` and `PUBLIC` has no routine-`EXECUTE` tuple. Preflight rejects a missing or excess tuple or privilege, an unexpected grantee, namespace/object-type drift, grant option, default-ACL owner drift, or grantor drift before the first persistent 0012 statement.

Because that baseline gives runtime `SELECT` on a newly created table, the migration immediately and explicitly revokes all inherited table authority on both `financial_admin_commands` and `financial_admin_job_claims` from `PUBLIC`, runtime, the financial worker, and storage cleanup before granting back only the specified command-table worker privileges. It likewise explicitly revokes all authority on each private lease helper from those principals immediately after creation. Configured application logins receive no direct ACL; the claim table and private helpers finish owner-only. Static and restore verification assert these exact final ACLs rather than relying on defaults.

No broad runtime financial grant is permitted. No application process receives owner credentials. Worker privileges are extended only for the exact command operations proved by integration tests.

### 5.3 Migration login-identity attestation

Migration 0012 must distinguish a fresh database, where application logins have not yet been provisioned, from an upgrade, where the configured logins already inherit the fixed application groups. Structural membership alone is insufficient: a different strict login substituted into the worker group would inherit the new command authority during the interval between migration and role provisioning.

The migration entrypoint therefore receives three non-secret identifiers, `DATABASE_MIGRATION_WEB_USER`, `DATABASE_MIGRATION_WORKER_USER`, and `DATABASE_MIGRATION_STORAGE_CLEANUP_USER`. They contain names only, never passwords or secret-file paths. Isolated Compose and test migration processes receive those dedicated names directly. To preserve the documented host `npm run db:migrate` workflow, an absent dedicated value may be derived only from the corresponding direct `DATABASE_USER`, `DATABASE_WORKER_USER`, or `DATABASE_STORAGE_CLEANUP_USER` value before owner credential projection; a `_FILE` value is never a fallback. The entrypoint validates the same lowercase role-name grammar and reserved-name rules as role provisioning, requires three distinct names distinct from the database owner and fixed groups, and places them in three transaction-local owner-controlled PostgreSQL settings on the same pinned connection that executes the migration batch.

The entrypoint rejects nonempty `PGOPTIONS` before connecting. The transaction also rejects any pre-existing value for the three custom settings before installing them, and the absolute preflight rejects owner/database defaults for those names in `pg_db_role_setting`. The settings are owner-entrypoint configuration binding for the migration, not authentication against a malicious database owner; the database owner is already the deployment trust anchor.

The legacy resolver lockdown remains its deliberate preceding autocommit operation. The entrypoint then begins one owner transaction and installs the three local settings. It uses Drizzle's public `readMigrationFiles` parser but an application-owned executor for the fixed `drizzle.__drizzle_migrations` journal: create the journal schema/table, read the latest journal timestamp, execute each pending parsed statement, and insert its parser-supplied hash/timestamp on that same transaction object. The pinned Drizzle 0.45.2 node-postgres migrator is not called from inside the transaction because it dereferences the underlying session and issues a top-level `BEGIN`/`COMMIT`, which could commit the owner transaction rather than create a savepoint. Failure rolls back the settings, migration journal, and every 0012 effect together. Commit or rollback leaves no usable attestation value on that session; an implementation may observe PostgreSQL's empty custom-parameter placeholder, but never one of the three names.

The absolute preflight evaluates each attested login independently. An attested role may be absent only when its canonical membership edge is absent. If present, it must be a nonreserved `LOGIN` role with the provisioner's exact attributes, infinity validity, null role configuration, no `pg_db_role_setting`, and exactly its canonical edge: web-to-runtime, worker-to-financial-worker, or cleanup-to-storage-cleanup with the canonical admin/inherit/set options. The financial-worker-group-to-runtime-group edge is always required. No other inbound or outbound membership involving the three attested logins, three fixed groups, or database owner exists.

This admits a fresh all-absent bootstrap, a historical web-and-worker-present/cleanup-absent 0010-to-0012 upgrade, a fully provisioned deployment, and every other safe subset whose present identities and edges are exact. An attested role that exists without its exact edge, an edge for an absent identity, absent attestation, swapped identity, unknown member, extra inheritance, role setting, attribute drift, or option drift fails with `42501` before any persistent 0012 statement. Production and development Compose pass only the dedicated names to the migration process in addition to its owner connection settings and explicitly remove them from every other process. Test and upgrade harnesses use the same pinned-connection helper and cover all eight absent/present subsets plus rollback for every rejected state. Role provisioning still performs its exact-name postflight after migration as defense in depth.

## 6. Financial administrator commands

### 6.1 Command kinds

The initial fixed command vocabulary is:

- `refund_draft_save`
- `refund_draft_discard`
- `refund_allocation_finalize`
- `refund_reporting_correction_create`
- `administrative_recovery_activate`
- `administrative_recovery_deactivate`

Callers cannot supply a capability name, audit action, job type, result code, actor roles, customer identity, provider identity, free-form evidence, or arbitrary grant source. Each command kind maps in server code to one fixed required capability set and one strict input schema.

### 6.2 Stored command state

The protected command relation stores:

- a canonical internal command ID;
- fixed command kind;
- submitting administrator user ID;
- bounded correlation ID;
- canonical idempotency identity and input fingerprint;
- strict bounded private input;
- `pending | succeeded | denied | conflict | failed` status;
- a separate allowlisted safe terminal result; and
- creation, update, and completion timestamps.

The job payload contains only the command ID. It never contains command input, roles, customer data, financial evidence, provider identifiers, CSV bytes, or a result.

Runtime receives no table or column access to private command state. Submission and polling occur only through the bounded routines. Polling exposes the command ID, kind, safe status, safe result code/data, and safe timestamps required by the browser contract.

Commands are not deleted in Plan 6B-II. Their administrator-only volume is bounded operational history. Purge scheduling, if later justified, belongs to Plan 7 and requires its own retention design.

### 6.3 Submission and idempotency

Routes authorize before parsing identifiers or request bodies. After strict parsing, submission occurs in one transaction:

1. Acquire the existing global administrator-role advisory lock.
2. Reload the current user roles and require the fixed capability set for the command kind.
3. Call the command-submission routine.
4. Insert or recover the canonical command by idempotency identity.
5. Atomically insert the exact local-only command job.
6. Commit and return the safe command reference with its actual status. A first submission is pending; an identical idempotent replay may recover an already-terminal command.

Reusing an idempotency identity with the identical canonical command returns the existing command. Reusing it with a different kind or fingerprint is a conflict. Browser polling or refresh never resubmits automatically.

### 6.4 Worker execution

The worker maps the command job to one strict parser and handler. It does not trust roles, capabilities, fingerprints, or resource relationships stored by the caller.

Execution uses this prefix:

1. Set the opaque job capability transaction-locally and acquire the global administrator-role advisory lock.
2. Acquire the linked job's shared financial-admin lease advisory lock.
3. Lock and revalidate only the command identity/status/idempotency fields; do not load private input yet.
4. Return a succeeded terminal replay as a no-op, or reproduce the permanent job failure for a denied/conflict/failed terminal replay.
5. For a pending command, take the submitting-user identity only from that bounded locked row, reload that user's current roles, require the command kind's fixed capability set, and only then load and parse the private input.
6. For a projection-dependent finalization, correction, or recovery command, acquire the active financial-projection implementation authority.
7. Enter the canonical domain lock order required by the command and re-read every submitted version, source fingerprint, correction tip, and provenance link.
8. Apply the domain mutation through existing TypeScript services.
9. Commit domain effects, safe command result, financial audit, projection, entitlement, and outbox effects together; the final command transition reasserts the current claim through the owner guard.

The role lock precedes the shared lease lock and command row in execution; submission keeps its existing role-lock-before-command order. This matches current role-management serialization and avoids role-revocation races, stale-generation effects, and command/replay deadlocks.

### 6.5 Task-specific financial-administrator job claims

This boundary addresses stale, crashed, retried, or cross-session worker generations that all run under the trusted financial-worker credential. It prevents an old generation from continuing a financial-administrator command after its lease expired or another generation took over. The worker credential and worker process remain trusted and non-Byzantine: this design does not claim to resist a malicious credential holder that deliberately deviates from the worker protocol, extracts in-memory secrets, or invokes every privilege available to that role. Such resistance would require a broader generic job-authority and credential-isolation redesign outside Plan 6B-II.

The owner-only `financial_admin_job_claims` table has exactly one row per financial-administrator command job and contains:

- `job_id uuid` as its primary key and a restrictive `ON UPDATE RESTRICT ON DELETE RESTRICT` foreign key to `jobs.id`;
- positive `generation integer` and `attempt integer`, each bounded to `1..2147483647`;
- `capability_sha256 text`, constrained to exactly 64 lowercase hexadecimal characters;
- `lease_duration_ms integer`, bounded to `1..86400000`;
- `expires_at`, `issued_at`, nullable `renewed_at`, and nullable `invalidated_at` timestamp-with-time-zone columns; and
- `state text`, constrained to `active | invalidated` with a total, NULL-safe timestamp/state lifecycle predicate.

An active row has no `invalidated_at`, has `expires_at` after its most recent issue or renewal time, and matches the linked running job's positive attempt. An invalidated row has an `invalidated_at` at or after issue/renewal and belongs to a terminal job. Only a terminal job transition sets `state = 'invalidated'`; a retryable failure or rerun relinquishes the current claim by expiring it at database time, and the next claim rotates it. An invalidated row is never reactivated. The table has no table or column ACL for `PUBLIC`, either application group or login, or the storage-cleanup role/login; only the database owner can inspect or mutate it.

Each `claimNext` invocation and transaction selects, locks, and processes at most one target job, whether it is normally pending, an expired running retry/takeover, or an expired final-attempt cleanup. Only after that one locked target is identified as `commerce.financial-admin-command` does the repository create exactly one fresh 256-bit capability with Node `randomBytes(32).toString('base64url')` for that job's one generation rotation. A claim transaction never bulk-updates exhausted jobs and never places one transaction-local capability over multiple job IDs. Outside the deliberately transient transaction-local transport, the 43-character unpadded base64url value exists only in worker memory and in the internal `JobRecord.financialAdminLeaseCapability` field. It is placed in the transaction-local `pale_orbit.plan6bii_financial_admin_job_capability` setting only for an authorized claim/heartbeat/handler/terminal transaction and disappears at transaction end. Only its lowercase SHA-256 digest is stored. The clear capability is never written to a table, job or command payload, audit row, result, log, error, trace, API response, email, browser artifact, or restore manifest.

Claim rotation increments `generation`, records the job's new positive `attempt`, resets issue/renewal/invalidation timestamps, and replaces the digest atomically with the job's transition to `running`. Heartbeat renewal accepts only the current token, current generation/attempt, current running job, and unexpired claim, then advances `renewed_at` and `expires_at`. All issue, renewal, expiry, takeover, and invalidation decisions use PostgreSQL `clock_timestamp()`; Node time is not lease authority. Completion and permanent/exhausted failure validate the current capability and invalidate the claim in the same transaction as the terminal job state. A retryable failure or rerun expires the claim in the same transaction as the return to `pending`; its next claimant must rotate to a new capability and generation.

If a process crashes during the final allowed attempt and the running lease later expires, the cleanup claimant locks the job, creates a fresh exhaustion-adoption capability, rotates the generation without increasing the already-maximal attempt, and immediately uses that new current capability to fail the job and invalidate the claim in the same transaction. It never terminalizes an expired job under the prior generation's token and never returns the short-lived exhaustion token to a handler.

The clear capability is transport, not authority. Authority is the SHA-256 match against the private row plus its current generation, attempt, state, linked job state, and database-clock expiry. The owner-owned `SECURITY DEFINER` helper `plan6bii_assert_financial_admin_job_lease(uuid)` performs that total validation from the transaction-local value. The owner-owned `SECURITY DEFINER` trigger function `plan6bii_guard_financial_admin_job_lease()` and trigger `jobs_plan6bii_financial_admin_lease_guard` protect every claim, renewal, relinquish, and terminal transition of a `commerce.financial-admin-command` job. Both functions use `SET search_path = pg_catalog`, fully qualify application objects, and have no direct execute grant to any application role or `PUBLIC`. Migration 0012 establishes exactly eight public callable boundary-routine signatures; its helper and trigger remain private implementation authority. Task 13's append-only migration 0013 adds the separate worker-only `resolve_financial_issue_after_reporting_correction_command(uuid,uuid)` boundary, so the final surface is nine public callable routines. It does not broaden or replace 0012's finalization-only `resolve_financial_issue_after_admin_command(uuid,uuid)`.

The worker repository and runner carry the capability only as an opaque optional internal value. They pass it to heartbeat, completion, and failure operations; a financial-administrator job without it fails closed, while all other job types retain their current behavior. Each financial-administrator handler transaction—including the separate terminal transaction after a denied, conflict, or permanent failure—sets the capability transaction-locally, acquires the administrator-role lock, and then acquires the per-job shared advisory lease lock before the command row. The command-update guard, issue-resolution routine, and administrative-grant routine invoke the private assertion before accepting an effect.

On exhausted failure, the earlier lease-guard trigger validates the active token and atomically invalidates the owner-private claim while the outer job row is still observably the exact running, locked row. The later terminal-sync trigger may update the linked still-pending command only in that same relational-temporal window: the claim is invalidated for the exact attempt, the persisted job is still running with the exact payload/dedupe/lock facts, and the following outer transition is the exact terminal job update. The absolute preflight proves the canonical enabled `BEFORE UPDATE` trigger graph/order and exact `jobs` ACL, including no application or `PUBLIC` `TRIGGER` privilege, so another trigger cannot create or retain that window. Call-stack text, trigger depth, or a custom setting alone is never authority.

The administrative-grant trigger is `SECURITY INVOKER`. Direct worker DML therefore runs with worker `current_user` and is rejected even when the caller sets matching custom settings and holds a valid job token. DML performed inside the owner-owned administrative-recovery routine reaches the invoker trigger with the routine owner's `current_user`, then must also pass the current lease and exact command/reference linkage. The worker credential remains trusted for its documented command protocol, but neither transition uses a caller-writable setting as its sole provenance proof.

Locking uses one namespaced advisory key derived solely from `job_id`. Claim, takeover, and terminal job transitions take its exclusive transaction lock; heartbeat and command-handler transactions take its shared transaction lock. The repository selects and locks the candidate job row with `FOR UPDATE SKIP LOCKED`, revalidates it, and then acquires the advisory lock before touching the private claim row. The command path is `administrator-role advisory lock -> per-job shared lease advisory lock -> command row -> domain locks`; it loads only bounded identity/status fields at the command lock, then performs current-role reauthorization before reading private command input or applying an effect. Claim/takeover/terminal is `job row -> per-job exclusive lease advisory lock -> claim row -> command row` only when terminal synchronization is needed. Heartbeat is `job row -> per-job shared lease advisory lock -> claim row` and never locks a command. No path locks a command and then waits for a job row or lease lock. These rules allow heartbeats to coexist with a handler, make takeover wait for an in-flight handler transaction, and avoid job/command inversion.

If a process crashes before a command commit, its transaction rolls back; once heartbeat stops, the claim expires and a new generation rotates the token before retry. If it crashes after command/result/audit commit but before job completion, the new generation observes the terminal command, performs the existing no-op/permanent replay, and completes or fails the job with its new token. The old token fails after expiry or rotation even if the old session resumes. Reusing a token for another job, an earlier generation/attempt, a renewed-after-expiry claim, or a terminal claim raises `55000` without domain, command, audit, or job change.

## 7. Synchronous reporting and audit

List and filter operations are not audited. Successful safe detail views and completed exports remain audited before their response is returned.

For an audited detail or CSV request, the web service:

1. Authorizes before parsing or querying.
2. Begins a bounded transaction and acquires the administrator-role lock.
3. Reloads roles and requires the exact capability.
4. Builds the complete safe DTO or complete bounded CSV bytes.
5. Calls a narrow owner routine with one fixed action and typed, minimized metadata.
6. Commits before returning the DTO or bytes.

Audit failure prevents the response. The routine cannot accept arbitrary audit action text or arbitrary JSON. Export audit receives only the normalized filter fingerprint and bounded counts/bytes, never CSV contents. Detail audits receive only the internal resource identity and safe request metadata.

The audit trigger admits these events only through exact routine provenance. The general runtime prohibition on `financial.*` audit inserts remains unchanged.

## 8. Capabilities and routes

The capability map adds:

- `sales.read`
- `sales.export`
- `reconciliation.manage`

All three initially map to the administrator role, but the types, route guards, service guards, command-kind map, and tests remain independent. `requireCapability` must consult the requested capability instead of treating every administrator capability as equivalent.

The route surface is:

- `/admin/sales`
- `/admin/sales/review`
- `/admin/sales/review/[issueId]`
- `/admin/sales/refunds/[refundId]`
- `/admin/sales/payouts`
- `/admin/sales/payouts/[payoutId]`
- `/admin/sales/export.csv`

Every loader, action, detail service, command submission, status poll, and export authorizes independently. Routes do not call Stripe and do not import raw Stripe SDK types.

## 9. Reporting model

### 9.1 Overview

Overview services compose bounded SQL directly over the current financial projection head/item views and immutable order/item snapshots. They do not repeatedly call the maximum-100-ID allocation loader and do not reimplement current allocation selection.

Incomplete projection heads remain visible. A missing item join means the metric is unavailable, not zero and not a dropped row. Current title metadata is display-only; sold-as title, creator, and format snapshots remain immutable evidence.

Totals remain separated by presentment and settlement currency. Pending settlement remains explicitly pending. Account-scoped effects do not become title revenue. No mixed-currency aggregate is invented.

Tax-safe dispute reinstatement requires allocation algorithm version 2. Version 1 remains immutable historical evidence, but its settlement `dispute_reinstatement` item combines customer tax with subtotal and therefore cannot support an exact tax-excluded title estimate. Version 2 allocates from the persisted withdrawal settlement plan: predecessor `dispute_subtotal` weights become positive `dispute_reinstatement` subtotal effects, while predecessor `dispute_tax` weights remain separate positive `dispute_tax` effects. Same-currency partial reinstatements use the same component-level largest-remainder order in presentment and settlement; full FX reinstatements reverse the persisted weights in each currency domain. Positive, cross-version, malformed-component, or unsupported-version predecessor evidence fails closed.

The deployed target becomes `c1-a2`, reached through the existing allocation-only replay and activation authority. The migration seed remains `c1-a1`; no schema migration or direct version activation is introduced. Reporting treats a version-1 combined reinstatement as unavailable rather than estimating a subtotal/tax split. Restore verification preserves version-1 semantics while independently validating version-2 predecessor signs and component/title membership, reconstructing withdrawal settlement allocations from persisted presentment weights, and reconstructing reinstatements from the validated withdrawal settlement plan.

### 9.2 Operational Needs Review

Needs Review is not a query for every historically open issue.

It includes classification issues only when they belong to the active classifier and current source fingerprint. Allocation-set issues are included only for current raw active-pair tips, without trusting a projection-head base pointer that an issue may deliberately null. Retired-classifier `unsupported_category` issues remain immutable stored history but do not pollute the current operational queue.

There is no generic issue-resolution control. Linked issues close only after canonical worker recomputation proves the relevant invariant.

### 9.3 Payouts and CSV

Payout list/detail reads remain local-only and distinguish account-total evidence from bookstore-linked amounts. They preserve automatic/manual, standard/instant, current paid/failed/canceled state, reconciliation state, settlement currency, membership completeness, and reversal evidence without implying unsupported exact membership.

CSV exports the full normalized filter cohort, not the current cursor tail. It retains the approved maximums of 10,000 rows, 10 MiB, and 25 seconds, fixed columns, text-only formula neutralization, and no partial file or audit on failure.

No DTO or CSV contains customer/user identity, email, provider IDs, raw evidence, command input, job payload, internal error, audit metadata, credential authority, claim proof, or action URL.

## 10. Mutation workflows

### 10.1 Shared drafts

Draft save/discard commands enter through routing discovery, the order advisory lock, locked order/payment, and the complete purchase graph before re-reading the target refund and draft.

Saving uses a complete bounded item snapshot. Existing rows are updated, new rows are inserted, and omitted rows are set to zero. The phase does not add broad financial `DELETE`. An active draft transition increments its version exactly once. Draft mutations do not change reporting projection, financial evidence, grants, entitlement, or email.

### 10.2 Finalization

Finalization input carries `expectedActiveDraftVersion`, the preview fingerprint, and the fixed confirmation literal. The stored finalization-effect version is the incremented finalized draft version, not the submitted active version.

Under locks, finalization:

- revalidates the succeeded ambiguous refund, exact total, capacities, draft, current projection authority, and financial closure;
- inserts immutable administrative refund allocations and components;
- freezes the draft at the incremented version;
- calls the current refund projection recomputation with the locked/revalidated ordinary selected-set IDs;
- resolves every canonically satisfied allowlisted issue linked to the locked refund or selected sets, in stable issue order, through the command-bound worker resolver;
- recomputes purchase grants and effective entitlement through the extracted canonical access reducer;
- inserts finalization effects only after the referenced purchase grant is in its recorded after-state;
- queues access email only when effective access changes.

Exact replay returns the committed safe result without duplicating any effect.

### 10.3 Reporting corrections

Page load uses a distinct, non-confirmable `getReportingCorrectionSeed(...)` read rather than manufacturing a no-op preview. Its strict safe DTO contains the refund ID, fixed `allocation_attribution_correction` reason, nullable expected next version/base-set/source-fingerprint bindings, raw predecessor correction-set ID, compatible correction-set ID, `immutable_base | compatible_correction` baseline kind, current-reporting completeness, nullable presentment/settlement currencies and baseline total, eligibility with only `provider_evidence_pending | immutable_conflict | not_finalized | null`, and sorted item rows containing order-item/title/sold-as identity plus baseline total, subtotal, tax, settlement gross, and refund-fee impact. `getRefundReviewDetail(...)` remains the `sales.read` detail query and its `correctionPreview` remains action state only. The seed and preview services each independently require both `sales.read` and `reconciliation.manage` before inspecting an identifier/input or performing database work; the route applies the same dual check before parsing.

Prepare accepts exactly `reason`, `expectedNextCorrectionVersion`, `expectedBaseAllocationSetId`, `expectedSourceFingerprint`, and repeated paired `orderItemId`/`totalPresentmentMinor` fields. Confirm accepts exactly those fields plus `idempotencyKey`, `previewFingerprint`, and the literal `confirmation=create_reporting_correction`; the route-derived refund ID is never accepted from the form. Both URL-encoded parsers are bounded to 16 KiB and enforce only syntax, exact key/multiplicity, paired-array length, canonical UUID/hash/integer grammar, version `1..2147483647`, 1–25 unique item IDs, totals `0..99,999,999`, fixed literals, and canonical sorting. They do not decide current item membership. After dual authorization, the shared planner compares the sorted submission with locked/current facts and requires the complete exact order-item set including explicit zeros. The stored command remains the already-approved strict shape: kind, route-derived refund ID, fixed reason, expected next version/base/fingerprint, sorted absolute totals, fingerprint, and fixed confirmation. It does not accept a raw-tip ID, compatible-tip ID, component split, currency, settlement value, fee value, delta, capacity, actor, or audit action.

The seed and locked planner distinguish two authorities. The raw tip is the unique correction-chain node with no successor, whether or not it is compatible with current projection authority; the compatible tip is the independently proven current effective tip. The next row always succeeds the raw tip and uses its version plus one, while approved absolute values use the compatible tip as their display baseline when one exists. The three cases are:

- first correction: raw predecessor and compatible tip are null, next version is 1, the current immutable gross base is the anchor, and immutable components are the baseline;
- normal successor: raw predecessor and compatible tip are the same current tip, next version is that tip's version plus one, and its compatible approved absolutes are the baseline; and
- repair after incompatible classifier rebase: raw predecessor is the incompatible raw tip, compatible tip is null, next version is the raw tip's version plus one, the current immutable gross base and source fingerprint are the new anchor, immutable components are the baseline, and `currentReportingComplete` is false until the proposed valid successor restores completeness.

The browser never submits either derived tip ID. The preview exposes `compatibilityRepair = !currentReportingComplete && proposedReportingComplete`. The canonical preview fingerprint binds both IDs, baseline kind, current/proposed completeness and repair state, active projection implementation, current immutable base/fingerprint, next version, sorted requested totals, exact preview rows, and every persistable component/source/currency/tie-key value. Confirmation re-plans from locked facts and requires exact fingerprint equality.

The worker derives presentment subtotal/tax, settlement gross, refund-fee attribution, currencies, effective sibling-refund capacity, approved absolutes, and signed deltas from locked local evidence with the existing deterministic largest-remainder primitives. Capacity uses every succeeded sibling refund's current effective distribution, including its compatible correction, rather than raw `refund_allocation_components`. Stable tie-break keys contain stable semantic item/component identity and never a generated allocation- or correction-set ID, so classifier rebase preserves them.

Stored `delta_minor` is always `proposed approved absolute - current immutable base component`; a successor never stores the UI delta from the prior compatible correction. The preview displays the separate baseline-to-proposed subtotal and tax changes, but conservation is enforced over their coalesced presentment source-allocation set for each `(domain, source-allocation-set, currency)` group. Settlement gross and fee remain independently zero-sum because they belong to distinct gross and fee source sets. Correcting a settlement source includes every nonzero immutable base item/component for that source; any presentment correction includes every nonzero immutable presentment base component. A nonzero active fee distribution containing `provider_fee_tax`, `other`, or another component the correction schema cannot represent is `immutable_conflict`; it is never dropped or reclassified. Eligibility requires either a component-distribution change or an incomplete-to-complete compatibility repair. Therefore a repair whose proposed immutable-baseline distribution produces only numeric zero deltas remains eligible, receives a fingerprint, and appends the successor needed to restore compatibility. `no_change` applies only when reporting is already complete and the proposed effective distribution is equivalent. A locked no-op conflict likewise applies only when that complete/equivalent state already exists.

Under locks, the executor appends exactly one `allocation_attribution_correction` row and its sorted items, then calls the correction-specific canonical refund recompute. That recompute resolves only issues whose issue-independent compatibility proof succeeds. After resolution, TypeScript reads the current heads and requires the new row to be the unique exposed compatible raw tip with every relevant head complete before appending `financial.refund_correction.created`. Correction insert/items, projection recompute, issue transitions and their audits, post-resolution head verification, correction audit, and safe command result commit in one transaction; any forced failure rolls all of them back.

Migration 0013 adds the owner-owned, worker-only `SECURITY DEFINER` routine `resolve_financial_issue_after_reporting_correction_command(uuid,uuid)`. It uses `SET search_path = pg_catalog`, fully qualifies all application objects, repeats the role lock, shared current-job lease, pending correction command, current-admin-role, and exact correction-input checks, and proves the appended row's refund/version/current immutable base/fingerprint, raw-predecessor topology, fixed kind, actor, correlation, item arithmetic, full coverage, grouped conservation, representable fee basis, and effective sibling capacity directly from locked canonical facts. It must not require that issue-dependent current-head views already expose the row: the still-open issue may intentionally suppress that exposure. Once this direct proof succeeds, it applies the nine-code allowlist and refund/current-selected-set lineage scope, sets the same three guarded issue-transition settings, records the submitting administrator as resolver, and writes the fixed issue audit. The 0012 finalization resolver remains byte-for-byte finalization-only. The TypeScript source exposes a correction-specific wrapper/recompute mode and cannot route a correction through the finalization resolver.

Corrections never change refund allocations, purchase grants, entitlement, copy counts, access, or email. Existing classifier replay continues to call `rebaseApprovedCorrectionDistributionLocked` for a compatible approved absolute distribution and opens `correction_rebase_required` when it cannot; the raw-tip repair case above is the only administrative path that restores a new compatible successor without rewriting history.

### 10.4 Administrative recovery

Recovery activation requires immutable finalization provenance proving `revoked_by_finalization`, a current compatible correction tip below the full-refund threshold, the exact purchase grant, and a claimed user. It uses the purchase grant's user/title; callers cannot supply arbitrary identity.

The activation preview and command are bound to the exact refund, finalization effect, order item, current correction-set ID/version, current source fingerprint, and active projection implementation. Under the projection and purchase locks, the executor re-reads every binding, recomputes the preview fingerprint from those locked values and the predicted access/email consequences, and rejects any correction-tip, source-fingerprint, projection-head, projection-implementation, or provenance drift as `conflict/stale_state`. The owner routine repeats the exact command/target/correction/source/projection linkage check before allowing the grant transition. Deactivation likewise binds the exact recovery grant, immutable recovery reference, and expected state-change timestamp.

The workflow never reads commerce-claim issuance or credential-authority state, never claims guest purchases, and never manufactures a user for an unclaimed item. Eligibility may be prepared again after the ordinary protected claim lifecycle completes.

Activation creates or reactivates one uniquely linked administrative grant. The grant persists through later refunds, disputes, corrections, and classifier replay until an explicit confirmed deactivation. Automatic refund/dispute/claim reducers may include the grant when projecting effective access but cannot mutate it.

A database trigger plus worker-only command-bound transition routine guards any row transition involving `source = 'administrative'`. The routine independently verifies the running command's current financial-admin claim capability, exact linkage, correction/source/projection bindings, and requested transition; runtime receives no execute privilege.

The routine recomputes and compares the complete activation preview fingerprint before it
classifies a relationship that has become cumulatively fully refunded as ineligible. Thus a
full-refund change after prepare is stale state, while an input fingerprint matching the
current intrinsically ineligible facts remains not eligible. Existing-row transitions use a
canonical millisecond timestamp strictly greater than the row's preceding `updated_at`, so
active -> revoked -> active cannot exhibit an ABA concurrency token or reuse an access-email
dedupe key. Because 0012 is still unmerged and undeployed during this implementation, these
two defects are corrected in the original authority migration before its first release; its
signature, owner, ACL, security mode, search path, journal identity, and snapshot do not change.
Both preview and protected execution cap the cumulative presentment closure at 100 succeeded
refunds so their representable preimages and eligibility decisions remain exact.

## 11. Lock order

Projection-dependent finalization, correction, and recovery commands use this canonical order:

`administrator-role lock -> per-job shared financial-admin lease lock -> command row -> active projection implementation -> order advisory -> order -> payment -> complete refund/draft/allocation/correction/dispute/item closure -> projection-enrollment fence -> payout generation and balance-transaction financial closure -> issue rows -> sorted entitlement scopes and grants`

`lockPaymentPurchaseFacts` is a descendant-lock helper, not the entry point; order and payment are already locked before it runs. Current implementation authority is locked before purchase rows. Matching the existing ordinary-refund and replay paths, projection enrollment is locked after the complete purchase graph and before payout, balance-transaction, allocation, or issue rows.

Multi-row locks are sorted by stable IDs. The handler discovers without locking, enters through the canonical root, then re-reads and locks the target. It never enters through a draft, finalization effect, correction, issue, provenance row, or entitlement grant.

For a reporting correction, the exact suffix first discovers refund -> payment -> order routing without taking a row or advisory lock; it then locks active projection authority and rejects pending authority; takes order advisory, order-row, and payment-row locks; calls `lockPaymentPurchaseFacts` for the complete refund/draft/allocation/correction/dispute/item graph; takes `lockFinancialProjectionEnrollment`; discovers the bounded financial closure; calls `lockFinancialProjectionRows` with sorted payout, balance-transaction, classification, allocation, and issue identities; and re-reads the exact raw tip, compatible tip, immutable base, source fingerprint, effective sibling capacity, and fee/component evidence before planning or inserting. It then inserts the correction set and sorted items, runs correction-specific recomputation/resolution, and verifies current projection completeness. It never calls `enqueueAccessChange` and never locks or writes entitlement, grant, email, outbox, or copy rows.

Recovery does not acquire guest-identity, claim-issuance, credential-authority, or user locks after holding an order. It uses the locked purchase grant's user ID; a null user is ineligible. No provider call occurs while any command transaction is open.

## 12. Errors, retries, and browser interaction

Native same-origin forms perform prepare and explicit confirmation. Confirmation submits a command and returns a safe reference with the command's actual status; a new command is pending, while an identical idempotent replay may already be terminal. The browser polls pending commands with bounded backoff, performs one protected status read for a terminal replay, aborts on navigation, and announces progress and terminal outcomes through accessible live regions.

An ambiguous correction-confirmation `503` never triggers automatic resubmission. The browser freezes the complete confirmed payload—including the same idempotency key, expected bindings, sorted full item arrays, preview fingerprint, reason, and confirmation—and offers an explicit retry. Only that user action resubmits the exact frozen payload and same key, allowing command recovery; editing or preparing again discards the frozen retry and requires a new key. Refresh, polling, backoff, and component remount cannot submit it.

Terminal behavior is:

- `succeeded`: render the committed safe result and reload current facts;
- `denied`: capability was absent at execution; no domain write occurred;
- `conflict`: versions, fingerprints, provenance, or current facts changed; reload and prepare again; and
- `failed`: a safe permanent or exhausted operational failure; show bounded correlation guidance without internal errors.

Transient handler failures roll back and use existing bounded job retry behavior. An exhausted transient command stores one safe failed result; it does not expose `jobs.last_error`. A crash after the domain/result commit but before job completion replays the terminal command as a no-op and completes the job.

Every retry or takeover uses a new financial-admin lease capability and a strictly greater generation. Heartbeat cannot revive an expired claim, terminal invalidation cannot be reversed, and completion/failure with a stale, forged, missing, cross-job, or prior-generation capability fails closed. Lease-capability failures are internal `55000` authority failures and never alter the browser-safe terminal vocabulary or disclose whether a token, digest, generation, attempt, or expiry mismatched.

Malformed query/body input maps to a safe 400. Unauthorized access maps to 401/403. Undisclosable, absent, or forged cross-linked resources map to safe 404. Stale state maps to 409. Command polling is command-specific and does not create a generic retry/requeue UI.

## 13. Security and privacy invariants

- Web financial relations remain read-only.
- Owner credentials remain migration/provisioning-only.
- Worker credentials remain worker-only.
- Financial-administrator command effects require both the trusted worker credential and the current unexpired task-specific claim capability; this is stale-generation protection, not malicious-worker resistance.
- Command submission and execution both reauthorize current roles under the role-management lock.
- Runtime cannot read private command input or direct job/outbox payloads.
- Worker jobs accept only command IDs and parse every stored input again.
- Every mutation, audit, safe result, projection, entitlement, and outbox change commits atomically.
- Detail/CSV bytes are complete before their audit commits and before any response is returned.
- Generic issue resolution remains impossible.
- Administrative grant transitions require exact command provenance.
- No route, component, CSV, email, log, or audit payload exposes customer identity, provider data, credential authority, claim bearer, or action URL.
- Existing same-origin, CSRF, strict JSON/form, upload, auth, checkout, claim, and download boundaries remain unchanged.
- SQL JSON, lifecycle, and version validation is total and NULL-safe: missing keys and JSON `null` cannot pass a `CHECK` through SQL UNKNOWN, exact key/type predicates must evaluate `TRUE`, and every database-backed version/generation/attempt is bounded to `1..2147483647`.

## 14. Verification strategy

### 14.1 Unit and component tests

Cover capabilities, DTO key allowlists, filters/cursors, signed money, CSV neutralization, command parsing, command/result status, idempotency, preview fingerprints, safe error mapping, native confirmation, accessible polling, keyboard use, responsive presentation, and privacy sentinels.

### 14.2 Static, migration, and role tests

Cover the new migration/journal/snapshot, exact role and column grants, protected routines, trigger provenance, command/job/claim guards, owner-only claim-table ACLs, no runtime financial DML, no command-table payload reads, worker-only administrative transition authority, NULL-safe constraints, schema preservation, process-secret isolation, and exact restore-catalog parity. Migration preflight proves absolute object ownership and ACLs, default ACLs, attested configured-login identities, fixed memberships, prerequisite functions, and the exact enabled prerequisite trigger graph before the first persistent 0012 statement. Entry-point tests prove the three identifiers are validated before connecting, installed only transaction-locally on the pinned migration connection, absent from logs, and never accompanied by runtime/worker/cleanup passwords.

### 14.3 PostgreSQL integration tests

Use web-role clients for route/read/submission behavior, worker-role clients and real handlers for command execution, and owner clients only for explicit fixture/corruption setup.

Cover:

- direct web denial and bounded submit/status success;
- command/job atomic creation;
- positive claimed command, renewal, command transition, command-bound routine, and terminal invalidation paths;
- database-clock expiry, heartbeat, retry/takeover generation rotation, stale/forged/cross-job token rejection, and old-session resumption;
- two normal and two expired final-attempt jobs claimed in four separate `claimNext` transactions, proving one-row mutation per invocation, exactly one fresh capability per rotation, four distinct capabilities/digests, and cross-job rejection;
- current-role reauthorization and administrator demotion races;
- two-administrator draft/finalization/correction races;
- active projection/replay, purchase, payout, issue, entitlement, and per-job shared/exclusive lease lock order with no command-to-job inversion or deadlock;
- stale fingerprints—including recovery correction/source/projection bindings—and forged cross-links;
- worker crash/retry and post-commit replay;
- audit/outbox/projection fault rollback;
- linked issue resolution without generic resolution;
- automatic reducer isolation from administrative grants;
- the real protected guest-claim lifecycle before recovery eligibility;
- migration from every supported prior fixture through the new journal entry;
- restored ACL, routine, trigger, table, and behavioral integrity;
- no plaintext lease capability in database rows, payloads, audit, logs, APIs, browser artifacts, or restore evidence; and
- zero owned Docker/PostgreSQL resources after harness cleanup.

### 14.4 Browser and release tests

Browser journeys cover Sales reporting, Needs Review, shared draft conflict, explicit finalization consequences, reporting correction, recovery activation/deactivation, payout detail, CSV privacy, accessibility, responsiveness, and safe command progress.

Release gates include check, lint, unit, integration, E2E, build, upgrade, database-role boundaries, restore-verifier corruption witnesses, maintenance production-image smoke, and fixture-backed web/worker smoke without real Stripe credentials or network calls.

Checkpoint, backup-bundle, restore SQL, catalog, and row-count contracts are updated for the new objects and semantics. A true distinct-engine checkpoint rehearsal remains a mandatory pre-deployment operator gate. It is not evidence that Plan 6B launches production and is not required to pretend that a single-engine development host is distinct.

## 15. Delivery structure

The superseding implementation plan used three milestones on one unreleased phase:

1. **Authority and contracts:** capabilities, strict contracts, command schema/job, worker authorization, synchronous audit bridge, migration/ACL/restore foundations.
2. **Read-only reporting:** overview, operational Needs Review, safe issue/refund/payout details, filters, pagination, signed metrics, and bounded CSV.
3. **Resolution and release:** drafts, finalization, corrections, recovery, access/email effects, browser journeys, documentation, smoke, release evidence, and final clearance.

Sales navigation remains disabled on the candidate even after every surface is green; enabling it requires the final independent clearance rather than serving as pre-clearance evidence.

## 16. Review discipline

The candidate receives three bounded independent reviews:

1. Financial correctness, signed math, projection semantics, and lock/concurrency behavior.
2. Application authorization, database authority, privacy, audit, command provenance, CSV, and secret isolation.
3. Administrator UX, accessibility, documentation, smoke, restore/checkpoint integration, and release evidence.

Accepted behavioral findings require a failing regression before a fix. Unrelated Plan 7 observations are recorded in the next-phase ledger rather than expanding Plan 6B-II. After fixes, affected focused gates and the final complete gate are rerun. Reviewers clear one frozen final candidate; no code, tests, scripts, or documentation change after the last clearance.

## 17. Acceptance criteria

Plan 6B-II is complete when:

- the three capabilities are independently enforced at route, service, command, and execution boundaries;
- web runtime cannot directly mutate financial/admin-grant state or append reserved financial audits;
- strict commands execute under current worker authority with execution-time role reauthorization;
- fresh and upgrade migrations admit every safe subset of exact attested logins, reject any present identity/edge drift or unexpected membership before granting 0012 authority, and preserve the documented host migration path;
- stale, crashed, and cross-session worker generations cannot use an expired, rotated, forged, cross-job, or terminal financial-admin job capability;
- command retries, idempotency, conflicts, demotion, and post-commit crash replay are deterministic;
- Sales overview and summaries preserve currency, sign, completeness, and sold-as semantics;
- operational Needs Review excludes inactive historical issues without mutating history;
- detail and CSV responses are safe, bounded, and audited before delivery;
- drafts remain non-effective and shared with optimistic conflict handling;
- finalization is one-way, audited, atomically recomputes reporting/access, and exposes exact consequences;
- corrections are append-only, grouped-zero-sum, reporting-only, replay/rebase safe, and can repair an incompatible raw chain only by succeeding its raw tip from the current immutable baseline;
- migration 0012 retains its historical eight callable routines while migration 0013 adds exactly one correction-only worker routine for a final callable surface of nine;
- recovery is restricted to the exact causally revoked claimed purchase and persists until explicit deactivation;
- linked issue resolution remains proof-driven and no generic resolution path exists;
- migration, upgrade, role, restore, privacy, integration, browser, build, and smoke gates pass on the final tree;
- documentation truthfully marks Plan 6B complete only after final clearance; and
- production remains maintenance-mode and Stripe-disabled, with Plan 7 explicitly next.

## 18. Supersession and next step

The reviewed executable plan is [Backend Plan 6B-II: Admin Resolution and Reporting Refresh](../plans/2026-08-20-backend-plan-6b-ii-admin-resolution-reporting-refresh.md). It supersedes, without silently rewriting, `2026-08-11-backend-plan-6b-ii-admin-resolution-reporting.md` and contains the exact file paths, RED/GREEN commands, migration and role-boundary steps, release gates, and commit boundaries. Its implementation now forms the unified Plan 6B candidate and awaits the prescribed independent review loop; no candidate status is production clearance.
