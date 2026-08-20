# Plan 6B-II Implementation Refresh Design

**Date:** 2026-08-20

**Status:** Approved implementation architecture; superseding implementation plan written

## 1. Purpose

Refresh the unimplemented Plan 6B-II administrator financial reporting and resolution work so it can be built safely on the current hardened database-authority, worker, migration, restore, and deployment foundations.

The approved product behavior in [Plan 6B: Stripe Financial Reconciliation and Reporting](2026-08-11-stripe-financial-reconciliation-reporting-design.md) remains authoritative. This document changes the implementation architecture and delivery structure only where later Plan 6B-I authority work invalidated the original assumptions.

The August 11 implementation plan assumed that an authorized web request could perform financial writes and append `financial.*` audit events in its own database transaction. Current `main` deliberately forbids both. The refreshed design preserves the web/worker credential split instead of weakening it.

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

Sales navigation remains disabled until the complete phase passes its final review. Intermediate milestones are implementation checkpoints, not separately released product surfaces.

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

Owner-owned `SECURITY DEFINER` routines are limited to complete, non-composable boundaries:

- command submission;
- safe command-status retrieval;
- audited financial detail/export completion;
- command-bound linked-issue resolution; and
- command-bound administrative-grant transition protection.

Full financial mutations are not implemented in PL/pgSQL. Doing so would duplicate the signed allocation, projection, rebase, and access algorithms already implemented in TypeScript. Granular privileged mutation helpers are also forbidden because a runtime caller could compose an incomplete transaction.

### 5.2 Forward migration

Plan 6B-II owns the next append-only migration after the current journal. It must not edit migrations `0007` through `0011`.

The migration adds the command schema, routines, triggers, job guard changes, exact worker privileges, runtime revocations, and audit/administrative-grant provenance rules required by this design. It also enters the existing exact catalog, ACL, owner, trigger, routine, upgrade, and restore-verification contracts.

No broad runtime financial grant is permitted. No application process receives owner credentials. Worker privileges are extended only for the exact command operations proved by integration tests.

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

1. Acquire the global administrator-role advisory lock.
2. Lock and revalidate the command/idempotency row.
3. Return a succeeded terminal replay as a no-op, or reproduce the permanent job failure for a denied/conflict/failed terminal replay, before reauthorizing a pending command.
4. For a pending command, reload the submitting user's current roles and require the command kind's fixed capability set.
5. For a projection-dependent finalization, correction, or recovery command, acquire the active financial-projection implementation authority.
6. Enter the canonical domain lock order required by the command.
7. Re-read every submitted version, source fingerprint, correction tip, and provenance link.
8. Apply the domain mutation through existing TypeScript services.
9. Commit domain effects, safe command result, financial audit, projection, entitlement, and outbox effects together.

The role lock precedes the command row in submission, replay, and execution. This matches current role-management serialization and avoids role-revocation races and command/replay deadlocks.

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

A correction command contains only the fixed reason, expected base/correction tip and source fingerprint, approved absolute per-item presentment totals, preview fingerprint, and confirmation.

The worker derives subtotal, tax, settlement, fee, currency, capacity, and signed deltas from locked local evidence. It appends one correction successor and items, preserves zero-sum invariants for every domain/source/currency, recomputes current projection, and audits atomically.

Corrections never change refund allocations, purchase grants, entitlement, copy counts, access, or email. Existing classifier replay continues to rebase a compatible approved absolute distribution and opens `correction_rebase_required` when it cannot.

### 10.4 Administrative recovery

Recovery activation requires immutable finalization provenance proving `revoked_by_finalization`, a current compatible correction tip below the full-refund threshold, the exact purchase grant, and a claimed user. It uses the purchase grant's user/title; callers cannot supply arbitrary identity.

The workflow never reads commerce-claim issuance or credential-authority state, never claims guest purchases, and never manufactures a user for an unclaimed item. Eligibility may be prepared again after the ordinary protected claim lifecycle completes.

Activation creates or reactivates one uniquely linked administrative grant. The grant persists through later refunds, disputes, corrections, and classifier replay until an explicit confirmed deactivation. Automatic refund/dispute/claim reducers may include the grant when projecting effective access but cannot mutate it.

A database trigger plus worker-only command-bound transition routine guards any row transition involving `source = 'administrative'`. The routine independently verifies the running command, exact linkage, and requested transition; runtime receives no execute privilege.

## 11. Lock order

Projection-dependent finalization, correction, and recovery commands use this canonical order:

`administrator-role lock -> command row -> active projection implementation -> order advisory -> order -> payment -> complete refund/draft/allocation/correction/dispute/item closure -> projection-enrollment fence -> payout generation and balance-transaction financial closure -> issue rows -> sorted entitlement scopes and grants`

`lockPaymentPurchaseFacts` is a descendant-lock helper, not the entry point; order and payment are already locked before it runs. Current implementation authority is locked before purchase rows. Matching the existing ordinary-refund and replay paths, projection enrollment is locked after the complete purchase graph and before payout, balance-transaction, allocation, or issue rows.

Multi-row locks are sorted by stable IDs. The handler discovers without locking, enters through the canonical root, then re-reads and locks the target. It never enters through a draft, finalization effect, correction, issue, provenance row, or entitlement grant.

Recovery does not acquire guest-identity, claim-issuance, credential-authority, or user locks after holding an order. It uses the locked purchase grant's user ID; a null user is ineligible. No provider call occurs while any command transaction is open.

## 12. Errors, retries, and browser interaction

Native same-origin forms perform prepare and explicit confirmation. Confirmation submits a command and returns a safe reference with the command's actual status; a new command is pending, while an identical idempotent replay may already be terminal. The browser polls pending commands with bounded backoff, performs one protected status read for a terminal replay, aborts on navigation, and announces progress and terminal outcomes through accessible live regions.

Terminal behavior is:

- `succeeded`: render the committed safe result and reload current facts;
- `denied`: capability was absent at execution; no domain write occurred;
- `conflict`: versions, fingerprints, provenance, or current facts changed; reload and prepare again; and
- `failed`: a safe permanent or exhausted operational failure; show bounded correlation guidance without internal errors.

Transient handler failures roll back and use existing bounded job retry behavior. An exhausted transient command stores one safe failed result; it does not expose `jobs.last_error`. A crash after the domain/result commit but before job completion replays the terminal command as a no-op and completes the job.

Malformed query/body input maps to a safe 400. Unauthorized access maps to 401/403. Undisclosable, absent, or forged cross-linked resources map to safe 404. Stale state maps to 409. Command polling is command-specific and does not create a generic retry/requeue UI.

## 13. Security and privacy invariants

- Web financial relations remain read-only.
- Owner credentials remain migration/provisioning-only.
- Worker credentials remain worker-only.
- Command submission and execution both reauthorize current roles under the role-management lock.
- Runtime cannot read private command input or direct job/outbox payloads.
- Worker jobs accept only command IDs and parse every stored input again.
- Every mutation, audit, safe result, projection, entitlement, and outbox change commits atomically.
- Detail/CSV bytes are complete before their audit commits and before any response is returned.
- Generic issue resolution remains impossible.
- Administrative grant transitions require exact command provenance.
- No route, component, CSV, email, log, or audit payload exposes customer identity, provider data, credential authority, claim bearer, or action URL.
- Existing same-origin, CSRF, strict JSON/form, upload, auth, checkout, claim, and download boundaries remain unchanged.

## 14. Verification strategy

### 14.1 Unit and component tests

Cover capabilities, DTO key allowlists, filters/cursors, signed money, CSV neutralization, command parsing, command/result status, idempotency, preview fingerprints, safe error mapping, native confirmation, accessible polling, keyboard use, responsive presentation, and privacy sentinels.

### 14.2 Static, migration, and role tests

Cover the new migration/journal/snapshot, exact role and column grants, protected routines, trigger provenance, command/job guards, no runtime financial DML, no command-table payload reads, worker-only administrative transition authority, schema preservation, process-secret isolation, and exact restore-catalog parity.

### 14.3 PostgreSQL integration tests

Use web-role clients for route/read/submission behavior, worker-role clients and real handlers for command execution, and owner clients only for explicit fixture/corruption setup.

Cover:

- direct web denial and bounded submit/status success;
- command/job atomic creation;
- current-role reauthorization and administrator demotion races;
- two-administrator draft/finalization/correction races;
- active projection/replay, purchase, payout, issue, and entitlement lock order;
- stale fingerprints and forged cross-links;
- worker crash/retry and post-commit replay;
- audit/outbox/projection fault rollback;
- linked issue resolution without generic resolution;
- automatic reducer isolation from administrative grants;
- the real protected guest-claim lifecycle before recovery eligibility;
- migration from every supported prior fixture through the new journal entry;
- restored ACL, routine, trigger, table, and behavioral integrity; and
- zero owned Docker/PostgreSQL resources after harness cleanup.

### 14.4 Browser and release tests

Browser journeys cover Sales reporting, Needs Review, shared draft conflict, explicit finalization consequences, reporting correction, recovery activation/deactivation, payout detail, CSV privacy, accessibility, responsiveness, and safe command progress.

Release gates include check, lint, unit, integration, E2E, build, upgrade, database-role boundaries, restore-verifier corruption witnesses, maintenance production-image smoke, and fixture-backed web/worker smoke without real Stripe credentials or network calls.

Checkpoint, backup-bundle, restore SQL, catalog, and row-count contracts are updated for the new objects and semantics. A true distinct-engine checkpoint rehearsal remains a mandatory pre-deployment operator gate. It is not evidence that Plan 6B launches production and is not required to pretend that a single-engine development host is distinct.

## 15. Delivery structure

The superseding implementation plan will use three milestones on one unreleased phase:

1. **Authority and contracts:** capabilities, strict contracts, command schema/job, worker authorization, synchronous audit bridge, migration/ACL/restore foundations.
2. **Read-only reporting:** overview, operational Needs Review, safe issue/refund/payout details, filters, pagination, signed metrics, and bounded CSV.
3. **Resolution and release:** drafts, finalization, corrections, recovery, access/email effects, browser journeys, documentation, smoke, release evidence, and final clearance.

Sales navigation is enabled only in the last milestone after every surface exists and the full phase is green.

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
- command retries, idempotency, conflicts, demotion, and post-commit crash replay are deterministic;
- Sales overview and summaries preserve currency, sign, completeness, and sold-as semantics;
- operational Needs Review excludes inactive historical issues without mutating history;
- detail and CSV responses are safe, bounded, and audited before delivery;
- drafts remain non-effective and shared with optimistic conflict handling;
- finalization is one-way, audited, atomically recomputes reporting/access, and exposes exact consequences;
- corrections are append-only, zero-sum, reporting-only, and replay/rebase safe;
- recovery is restricted to the exact causally revoked claimed purchase and persists until explicit deactivation;
- linked issue resolution remains proof-driven and no generic resolution path exists;
- migration, upgrade, role, restore, privacy, integration, browser, build, and smoke gates pass on the final tree;
- documentation truthfully marks Plan 6B complete only after final clearance; and
- production remains maintenance-mode and Stripe-disabled, with Plan 7 explicitly next.

## 18. Supersession and next step

The reviewed executable plan is [Backend Plan 6B-II: Admin Resolution and Reporting Refresh](../plans/2026-08-20-backend-plan-6b-ii-admin-resolution-reporting-refresh.md). It supersedes, without silently rewriting, `2026-08-11-backend-plan-6b-ii-admin-resolution-reporting.md` and contains the exact file paths, RED/GREEN commands, migration and role-boundary steps, release gates, and commit boundaries. The next phase is task-by-task execution of that plan from its recorded approved base.
