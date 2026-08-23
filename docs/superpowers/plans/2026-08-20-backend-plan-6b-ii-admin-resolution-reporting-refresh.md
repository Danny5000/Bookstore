# Backend Plan 6B-II: Admin Resolution and Reporting Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the administrator-only Sales, reconciliation-resolution, payout, and bounded CSV experience while preserving the hardened web/worker database-authority split introduced after Plan 6B-I.

**Architecture:** The web process performs authorized reads and submits strict durable `financial_admin_commands` through owner-owned bounded routines; it never receives financial write authority. The existing worker reauthorizes the submitting administrator under the role-management lock and executes each command through the canonical TypeScript financial, projection, grant, entitlement, audit, and outbox services. A private owner-only claim row and a per-generation 256-bit opaque capability prevent stale/crashed/cross-session worker generations from exercising a financial-admin job after expiry or takeover; this is task-specific lease proof under a trusted worker credential, not Byzantine-worker resistance. Safe detail and export reads stay synchronous and commit their audit through narrow typed routines only after the complete DTO or CSV bytes exist.

**Tech Stack:** Node.js 26.7.x, npm 11.19.x, SvelteKit 2.70.x, Svelte 5.56.x, TypeScript 6.0.x, PostgreSQL 18.4, Drizzle ORM 0.45.2 and Drizzle Kit 0.31.10, Stripe Node 22.5.x pinned to API version `2026-07-29.dahlia`, Zod 4.4.x, Vitest 4.1.x, and Playwright 1.62.x.

---

## Source of truth, base, and supersession

The product behavior remains defined by:

- `docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md`
- `docs/superpowers/specs/2026-08-20-plan-6b-ii-implementation-refresh-design.md`

This plan supersedes `docs/superpowers/plans/2026-08-11-backend-plan-6b-ii-admin-resolution-reporting.md`. The older plan is historical because its direct-web-write and direct-web-audit assumptions are incompatible with current database authority.

The approved implementation base is commit `355ee582050414d7daa120f73406f19aeeeca955`, whose parent is current hardened `main` commit `9e92aa26754a0a00bd657f299c917be46ccea4cc`. Before implementation, rebase or merge the approved design commit onto the intended feature worktree without changing the behavioral contracts below.

This remains one plan because its three milestones are not independently releasable: the authority migration is required by every mutation; reporting and command DTOs share capability/privacy contracts; Sales navigation remains disabled until every read, mutation, browser, restore, and release gate is green.

## Scope boundary

Plan 6B-II owns:

1. `sales.read`, `sales.export`, and `reconciliation.manage` capability enforcement.
2. Browser-safe reporting, command, result, and error contracts.
3. The next append-only migration after `0011`, including command authority, exact ACLs, provenance guards, and restore-catalog coverage.
4. Sales overview, operational Needs Review, safe issue/refund/payout details, and bounded aggregate CSV.
5. Shared refund drafts, one-way allocation finalization, append-only reporting corrections, and narrowly proven administrative recovery.
6. Unit, PostgreSQL, browser, migration, role, restore, smoke, checkpoint, privacy, and final independent-review evidence.

Plan 6B-II does not activate production or live Stripe; initiate provider refunds/disputes; expose generic job/outbox/provider retry or requeue controls; add generic issue resolution; purge/retain administrator commands; schedule/encrypt/ship off-host backups; add monitoring/alerts; tune pools/capacity; add CI/CD; or broaden web/owner credentials. Its private capability protects only financial-admin jobs from stale/crashed/cross-session generations under a trusted worker credential; it does not claim malicious/Byzantine worker resistance or redesign generic job authority. Production remains maintenance-mode and Stripe-disabled; those launch and operability concerns remain Plan 7.

## Execution and evidence discipline

- Complete Tasks 1–3, then execute Task 5 immediately so migration 0012 and exact restore/catalog v2 land in one commit. Execute Task 4 only after that authority commit, then resume Tasks 6–17 in order. This one documented jump prevents an intermediate commit whose current restore verifier rejects 0012; do not expose a route before its service, capability, authority, and privacy contract exists.
- Use RED -> minimal implementation -> focused GREEN -> commit for every behavior change.
- Run service-free tests freely. Serialize every Docker/PostgreSQL/Mailpit/Playwright command; do not launch service-backed suites from parallel agents.
- Before each service-backed command, record the disposable-resource and temp-directory baseline. After it exits, verify the harness-owned project is gone and the baseline is unchanged. Never clean unknown or pre-existing resources.
- Do not run a broad suite to diagnose a focused RED. Capture the exact first failing assertion/SQLSTATE, fix the proven cause, then rerun the same bounded command.
- Use web-role clients for route/read/submission behavior, worker-role clients for worker/domain behavior, and owner-role clients only for explicit fixture/corruption setup.
- Use `apply_patch` for hand edits and Drizzle Kit only for generated migration/snapshot metadata. Inspect generated SQL before adding the reviewed custom authority statements.
- Stage literal paths, run `git diff --cached --check`, inspect the staged diff, and commit at every task boundary. Never use `git add .`.

## Fixed command and audit vocabulary

The only administrator command kinds in this plan are:

```ts
export const FINANCIAL_ADMIN_COMMAND_KINDS = [
  'refund_draft_save',
  'refund_draft_discard',
  'refund_allocation_finalize',
  'refund_reporting_correction_create',
  'administrative_recovery_activate',
  'administrative_recovery_deactivate'
] as const;
```

The only browser-visible command statuses are:

```ts
export const FINANCIAL_ADMIN_COMMAND_STATUSES = [
  'pending',
  'succeeded',
  'denied',
  'conflict',
  'failed'
] as const;
```

The exact new audit actions are:

```text
financial.issue.view
financial.refund_review.view
financial.refund_draft.created
financial.refund_draft.updated
financial.refund_draft.discarded
financial.refund_allocation.finalized
financial.refund_correction.created
financial.recovery_grant.activated
financial.recovery_grant.deactivated
financial.payout.view
financial.sales_export
financial.admin_command.denied
financial.admin_command.conflict
financial.admin_command.failed
```

Existing worker financial actions remain unchanged. No action named `financial.issue.resolve`, `financial.job.retry`, or any caller-selected action is added.

## File ownership map

### Authority and transport

- `src/lib/server/db/schema/financial-admin.ts` owns the command enums/table and the private `financial_admin_job_claims` table; no second claim schema file is created.
- `drizzle/0012_plan6bii_admin_command_authority.sql` owns both tables, the deferred command/job relationship, private claim lifecycle, routines, triggers, routine provenance, and exact grants/revokes.
- `drizzle/0013_plan6bii_reporting_correction_authority.sql` owns only the ninth, correction-specific issue-resolution routine and its exact revoke/grant/postflight; it never replaces 0012's finalization resolver or issue trigger.
- `src/lib/server/jobs/types.ts`, `src/lib/server/jobs/runner.ts`, and `src/lib/server/jobs/repository.ts` carry and consume the opaque capability only inside the worker process; no route-facing type contains it.
- `src/lib/server/commerce/financial/admin-commands/contracts.ts` owns strict private command parsing and safe result parsing.
- `src/lib/server/commerce/financial/admin-commands/repository.ts` is the only TypeScript wrapper around submit/status and terminal-state database operations.
- `src/lib/server/commerce/financial/admin-commands/handler.ts` owns job parsing, execution-time reauthorization, terminal classification, and replay behavior.
- `src/lib/server/commerce/financial/admin-commands/executors.ts` is the fixed command-kind-to-domain-executor registry.
- `src/lib/server/commerce/reporting/audit.ts` is the only TypeScript wrapper for synchronous financial detail/export audit routines.

### Reporting and browser contracts

- `src/lib/types/financial-reporting.ts` contains browser-safe DTOs and no Drizzle/Stripe types.
- `src/lib/server/commerce/reporting/` owns filters, metrics, overview, review, payouts, and CSV queries.
- `src/lib/server/commerce/financial/refund-review/` owns strict inputs, safe refund detail/preview reads, and worker-only domain executors.
- `src/routes/admin/sales/` contains thin authorized loaders/actions/status endpoints.
- `src/lib/components/admin/` contains presentation-only Sales/refund components.

### Verification and operations

- `tests/integration/` proves real PostgreSQL authority, state transitions, races, and atomicity.
- `scripts/verify-financial-restore.sql` and its exact runbook mirror own the versioned restored-catalog contract.
- Existing role, migration, smoke, fixture, checkpoint, privacy, and process-isolation suites are extended rather than duplicated.

## Milestone A — authority and contracts

### Task 1: Verify and record the hardened handoff

**Files:** None.

- [ ] **Step 1: Confirm the exact feature branch and clean base**

```powershell
git status --short --branch
git rev-parse HEAD
git log -5 --oneline --decorate
```

Expected: the worktree is clean and contains approved design commit `355ee582050414d7daa120f73406f19aeeeca955`. If the hash differs because the design was merged, record the merge/rebase relationship and prove the design file is byte-identical before continuing.

- [ ] **Step 2: Verify current schema/journal and exact consumed seams**

```powershell
npm run db:check
Get-Content drizzle/meta/_journal.json | Select-Object -Last 45
rg -n "export (async )?function (lockActiveFinancialProjectionImplementation|lockFinancialProjectionEnrollment|lockFinancialProjectionRows|lockPaymentPurchaseFacts|loadCurrentEffectiveAllocationProjection|recomputeLockedRefundFinancialProjection|rebaseApprovedCorrectionDistributionLocked|resolveFinancialIssueAfterRecompute)" src/lib/server/commerce
rg -n "refundAllocationDrafts|refundAllocationFinalizationEffects|refundReportingCorrectionSets|currentFinancialProjectionHeads|currentFinancialProjectionItems" src/lib/server/db/schema
```

Expected: journal indices `0007` through `0011` exist; every seam above exists. Record exact signatures in the task ledger and use them directly—do not create compatibility wrappers for the historical plan.

- [ ] **Step 3: Run the service-free handoff gate**

```powershell
npx vitest run src/lib/server/auth/admin-policy.test.ts src/lib/server/commerce/financial src/lib/server/commerce/grants.test.ts src/lib/server/jobs/repository.test.ts scripts/database-role-deployment.test.ts scripts/financial-schema-preservation.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero. Stop on a failure; do not start Plan 6B-II by changing an existing invariant without a reviewed RED.

### Task 2: Add independent capabilities, strict filters, safe DTOs, and command contracts

**Files:**
- Modify: `src/lib/server/auth/admin-policy.ts`
- Modify: `src/lib/server/auth/admin-policy.test.ts`
- Create: `src/lib/types/financial-reporting.ts`
- Create: `src/lib/types/financial-reporting.test.ts`
- Create: `src/lib/server/commerce/reporting/filters.ts`
- Create: `src/lib/server/commerce/reporting/filters.test.ts`
- Create: `src/lib/server/commerce/reporting/context.ts`
- Create: `src/lib/server/commerce/reporting/context.test.ts`
- Create: `src/routes/admin/sales/route-support.ts`
- Create: `src/routes/admin/sales/route-support.test.ts`
- Modify: `src/lib/commerce/money.ts`
- Modify: `src/lib/commerce/money.test.ts`

- [ ] **Step 1: Write failing independent-capability tests**

Require this exact policy shape:

```ts
export type AdminCapability =
  | 'admin.access'
  | 'catalog.manage'
  | 'roles.manage'
  | 'audit.read'
  | 'jobs.retry'
  | 'sales.read'
  | 'sales.export'
  | 'reconciliation.manage';

export const CAPABILITIES_BY_ROLE: Readonly<
  Record<ApplicationRole, ReadonlySet<AdminCapability>>
> = {
  customer: new Set(),
  admin: new Set([
    'admin.access', 'catalog.manage', 'roles.manage', 'audit.read', 'jobs.retry',
    'sales.read', 'sales.export', 'reconciliation.manage'
  ])
};

export function capabilitiesForRoles(
  roles: readonly ApplicationRole[]
): ReadonlySet<AdminCapability>;

export type CapabilityResolver = (
  roles: readonly ApplicationRole[]
) => ReadonlySet<AdminCapability>;

export interface FinancialAuthorizationDependencies {
  readonly capabilityResolver?: CapabilityResolver;
}

export const FINANCIAL_ADMIN_COMMAND_CAPABILITIES: Readonly<
  Record<FinancialAdminCommandKind,
    readonly ['sales.read', 'reconciliation.manage']>
>;

export function requireCapability(
  actor: Actor,
  capability: AdminCapability,
  capabilityResolver?: CapabilityResolver
): asserts actor is AdministratorActor;
```

`capabilityResolver` defaults to `capabilitiesForRoles`; production callers never supply a weaker resolver. Every Plan 6B-II route/service dependency object embeds `FinancialAuthorizationDependencies`, and every command submission and worker handler reads the one shared `FINANCIAL_ADMIN_COMMAND_CAPABILITIES` map. Test the three new capabilities independently, test a synthetic resolver missing each one at route, service, submission, and execution boundaries, and prove `requireCapability(actor, requested, resolver)` consults `requested` rather than only checking `roles.includes('admin')`.

- [ ] **Step 2: Write failing filter, cursor, and request-context tests**

Require:

```ts
export function parseSalesOverviewFilters(url: URL, now: Date): SalesOverviewFilters;
export function encodeSalesCursor(cursor: SalesCursor): string;
export function decodeSalesCursor(
  value: string,
  expectedFilterFingerprint: string
): SalesCursor;
export function fingerprintSalesFilters(filters: SalesOverviewFilters): string;
export const SALES_CURSOR_MAX_ENCODED_LENGTH = 2_674;
export const SALES_CURSOR_MAX_DECODED_BYTES = 2_005;

export interface FinancialRequestContext {
  readonly correlationId: string;
  readonly requestMetadata?: AuditRequestMetadata;
}
```

Accept only one value for `range=7|30|90|all|custom`, `from`, `to`, canonical `titleId`, `format=prose|comic`, presentment currency, settlement currency or `pending`, `state=pending|fee_reconciled|payout_reconciled|exception`, `sort=gross_desc|title_asc`, and a canonical unpadded-base64url cursor of at most 2,674 ASCII characters whose decoded UTF-8 JSON is at most 2,005 bytes. The cursor is the strict five-key JSON object `filterFingerprint`, `primary`, `titleId`, `presentmentCurrency`, `settlementCurrency` in that exact order. For `title_asc`, `primary` is the exact stored current title (1–300 UTF-16 code units) without normalization, truncation, hashing, or cursor-only character restrictions; for `gross_desc`, it is a safe integer. Reject the encoded bound before decoding and reject the decoded bound before JSON parsing. Reject unknown, duplicate, incompatible, noncanonical, extra-key, unsafe-number, bad-currency, bad-UUID, wrong-key-order, and wrong-filter-fingerprint inputs with safe 400 errors. Boundary tests must round-trip `"\u0001".repeat(300)` at exactly 2,005 decoded bytes and 2,674 encoded characters, accept it through `parseSalesOverviewFilters`, reject 2,675 encoded characters before decoding, reject a 301-code-unit title, and preserve decomposed Unicode losslessly. Path UUIDs use the existing undisclosable safe-404 convention.

Use complete UTC-day half-open intervals. The default is the prior 30 complete days ending at today's `00:00Z`; 7 and 90 follow the same rule; `custom` converts inclusive dates to `[from 00:00Z, to + 1 day 00:00Z)`; `all` has no time predicate. Page size is fixed at 50. Cursor order is `sort primary -> titleId -> presentmentCurrency -> settlementCurrency-or-empty`.

- [ ] **Step 3: Write failing DTO, command-result, and signed-money tests**

Define and enumerate exact keys for title rows, currency summaries, issues, refund detail/draft/finalization/correction/recovery previews, payouts, CSV rows, and this command envelope:

```ts
export type FinancialAdminCommandKind =
  (typeof FINANCIAL_ADMIN_COMMAND_KINDS)[number];
export type FinancialAdminCommandStatus =
  (typeof FINANCIAL_ADMIN_COMMAND_STATUSES)[number];

export type FinancialAdminCommandResultCode =
  | 'draft_saved'
  | 'draft_discarded'
  | 'allocation_finalized'
  | 'correction_created'
  | 'recovery_activated'
  | 'recovery_deactivated'
  | 'capability_revoked'
  | 'not_eligible'
  | 'stale_state'
  | 'invalid_command'
  | 'command_failed';

export interface FinancialAdminCommandSafeResultByCode {
  readonly draft_saved: { readonly refundId: string; readonly draftVersion: number; readonly changed: boolean };
  readonly draft_discarded: { readonly refundId: string; readonly draftVersion: number; readonly changed: boolean };
  readonly allocation_finalized: { readonly refundId: string; readonly finalizedDraftVersion: number; readonly accessChanged: boolean; readonly emailQueued: boolean };
  readonly correction_created: { readonly refundId: string; readonly correctionSetId: string; readonly correctionVersion: number };
  readonly recovery_activated: { readonly recoveryGrantId: string; readonly accessChanged: boolean; readonly emailQueued: boolean };
  readonly recovery_deactivated: { readonly recoveryGrantId: string; readonly accessChanged: boolean; readonly emailQueued: boolean };
  readonly capability_revoked: null;
  readonly not_eligible: null;
  readonly stale_state: null;
  readonly invalid_command: null;
  readonly command_failed: null;
}

export type FinancialAdminCommandSafeResultDto = Exclude<
  FinancialAdminCommandSafeResultByCode[FinancialAdminCommandResultCode],
  null
>;

export interface FinancialAdminCommandReferenceDto {
  readonly commandId: string;
  readonly kind: FinancialAdminCommandKind;
  readonly status: FinancialAdminCommandStatus;
  readonly createdAt: string;
}

interface FinancialAdminCommandStatusBaseDto<
  Kind extends FinancialAdminCommandKind = FinancialAdminCommandKind
> {
  readonly commandId: string;
  readonly kind: Kind;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FinancialAdminSuccessCodeByKind {
  readonly refund_draft_save: 'draft_saved';
  readonly refund_draft_discard: 'draft_discarded';
  readonly refund_allocation_finalize: 'allocation_finalized';
  readonly refund_reporting_correction_create: 'correction_created';
  readonly administrative_recovery_activate: 'recovery_activated';
  readonly administrative_recovery_deactivate: 'recovery_deactivated';
}

type FinancialAdminSucceededStatusDto = {
  [Kind in FinancialAdminCommandKind]:
      FinancialAdminCommandStatusBaseDto<Kind> & {
        readonly status: 'succeeded';
        readonly resultCode: FinancialAdminSuccessCodeByKind[Kind];
        readonly result: FinancialAdminCommandSafeResultByCode[
          FinancialAdminSuccessCodeByKind[Kind]
        ];
        readonly completedAt: string;
      }
}[FinancialAdminCommandKind];

export type FinancialAdminCommandStatusDto =
  | (FinancialAdminCommandStatusBaseDto & {
      readonly status: 'pending';
      readonly resultCode: null;
      readonly result: null;
      readonly completedAt: null;
    })
  | FinancialAdminSucceededStatusDto
  | (FinancialAdminCommandStatusBaseDto & {
      readonly status: 'denied';
      readonly resultCode: 'capability_revoked';
      readonly result: null;
      readonly completedAt: string;
    })
  | (FinancialAdminCommandStatusBaseDto & {
      readonly status: 'conflict';
      readonly resultCode: 'stale_state' | 'not_eligible';
      readonly result: null;
      readonly completedAt: string;
    })
  | (FinancialAdminCommandStatusBaseDto & {
      readonly status: 'failed';
      readonly resultCode: 'invalid_command' | 'command_failed';
      readonly result: null;
      readonly completedAt: string;
    });
```

An identical idempotent submission may recover a terminal command, so the receipt reports the actual safe status rather than falsely promising `pending`; the browser always obtains terminal data through the status endpoint. Command results may contain only the stable internal command/resource ID, version, changed flag, email-queued flag, and timestamps needed by the originating workflow. Result code is separate from data and the discriminated union ties command kind, status, code, data, and completion together; the runtime parser must refine the same kind-to-success-code map. Reject raw input, actor/user/customer/email, job ID/payload/error, provider ID/evidence, audit body, credential/claim data, and URLs.

Add a signed display formatter that validates safe integers, preserves negative signs and ISO currency codes, supports zero- and three-decimal currencies, and renders an explicit unavailable value. It never parses display text back into server money.

- [ ] **Step 4: Run the focused tests and confirm RED**

```powershell
npx vitest run src/lib/server/auth/admin-policy.test.ts src/lib/types/financial-reporting.test.ts src/lib/server/commerce/reporting/filters.test.ts src/lib/server/commerce/reporting/context.test.ts src/routes/admin/sales/route-support.test.ts src/lib/commerce/money.test.ts
```

Expected: FAIL because the new capabilities, DTOs, command envelopes, filters, route support, and formatter do not exist.

- [ ] **Step 5: Implement the exact pure contracts**

`route-support.ts` authorizes before reading params/query/body and maps only:

```ts
export type FinancialRouteFailure =
  | { readonly status: 400; readonly code: 'invalid_request' }
  | { readonly status: 401; readonly code: 'unauthenticated' }
  | { readonly status: 403; readonly code: 'forbidden' }
  | { readonly status: 404; readonly code: 'not_found' }
  | { readonly status: 409; readonly code: 'stale_state' }
  | { readonly status: 503; readonly code: 'temporarily_unavailable' };
```

It may create a bounded correlation ID and safe audit metadata after authorization. It must not import Drizzle rows, Stripe types, provider services, cookies, sessions, credentials, or raw `Request` into reusable reporting/domain contracts.

- [ ] **Step 6: Run the focused GREEN gate**

```powershell
npx vitest run src/lib/server/auth/admin-policy.test.ts src/lib/types/financial-reporting.test.ts src/lib/server/commerce/reporting/filters.test.ts src/lib/server/commerce/reporting/context.test.ts src/routes/admin/sales/route-support.test.ts src/lib/commerce/money.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 7: Commit the contracts**

```powershell
git add src/lib/server/auth/admin-policy.ts src/lib/server/auth/admin-policy.test.ts src/lib/types/financial-reporting.ts src/lib/types/financial-reporting.test.ts src/lib/server/commerce/reporting/filters.ts src/lib/server/commerce/reporting/filters.test.ts src/lib/server/commerce/reporting/context.ts src/lib/server/commerce/reporting/context.test.ts src/routes/admin/sales/route-support.ts src/routes/admin/sales/route-support.test.ts src/lib/commerce/money.ts src/lib/commerce/money.test.ts
git diff --cached --check
git commit -m "feat: add Plan 6B-II reporting contracts"
```

### Task 3: Add the protected administrator-command schema, lease capability, and authority migration

**Files:**
- Create: `src/lib/server/db/schema/financial-admin.ts`
- Create: `src/lib/server/db/schema/financial-admin.test.ts`
- Modify: `src/lib/server/db/schema/index.ts`
- Create: `drizzle/0012_plan6bii_admin_command_authority.sql`
- Create: `drizzle/meta/0012_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/server/db/database-role-provision.ts`
- Modify: `src/lib/server/db/database-role-provision.test.ts`
- Modify: `src/lib/server/db/migrate.ts`
- Modify: `src/lib/server/db/migrate.test.ts`
- Modify: `src/migrate.ts`
- Modify: `compose.prod.yaml`
- Modify: `compose.dev.yaml`
- Modify: `scripts/database-role-deployment.test.ts`
- Modify: `scripts/financial-schema-preservation.test.ts`
- Modify: `scripts/process-secret-scope.test.ts`
- Modify: `scripts/test-environment.ts`
- Modify: `scripts/test-environment.test.ts`
- Modify: `scripts/with-test-database.ts`
- Modify: `scripts/with-test-database.test.ts`
- Modify: `tests/integration/financial-schema.test.ts`
- Modify: `tests/integration/financial-migration.test.ts`
- Modify: `tests/integration/database-role-boundaries.test.ts`
- Modify: `src/lib/server/jobs/repository.ts`
- Modify: `src/lib/server/jobs/repository.test.ts`
- Modify: `src/lib/server/jobs/types.ts`
- Modify: `src/lib/server/jobs/runner.ts`
- Modify: `src/lib/server/jobs/runner.test.ts`
- Modify: `src/lib/server/commerce/claims.ts`
- Modify: `src/lib/server/commerce/claims.test.ts`
- Modify: `src/lib/server/outbox/repository.ts`
- Modify: `src/lib/server/outbox/repository.test.ts`
- Modify: `src/lib/server/commerce/email/enqueue.ts`
- Modify: `src/lib/server/commerce/email/enqueue.test.ts`
- Modify: `src/lib/server/ingestion/job.ts`
- Modify: `src/lib/server/ingestion/job.test.ts`
- Modify: `src/lib/server/commerce/webhooks.ts`
- Modify: `src/lib/server/commerce/webhooks.test.ts`

- [ ] **Step 1: Write failing schema and static deployment tests**

Before implementing the migration, add service-free REDs for the owner-controlled login-identity transport. `database-role-provision.test.ts` requires one strict loader for `DATABASE_MIGRATION_WEB_USER`, `DATABASE_MIGRATION_WORKER_USER`, and `DATABASE_MIGRATION_STORAGE_CLEANUP_USER`: the values use the existing lowercase role-name/reserved-name contract, are distinct from each other, the owner, and the fixed groups, and contain no password or `_FILE` input. An isolated migration process provides those dedicated values. For backward-compatible host `npm run db:migrate`, an absent dedicated value may fall back only to the corresponding direct ordinary login-name value before owner credential projection; never resolve a user from `_FILE`. Missing/empty/invalid names and nonempty `PGOPTIONS` abort before connecting.

`migrate.test.ts` requires the legacy resolver lockdown to remain a preceding autocommit statement, followed by one pinned database transaction that first proves the three settings have no pre-existing nonempty value and then installs exactly these transaction-local settings:

```text
pale_orbit.migration_expected_web_login
pale_orbit.migration_expected_worker_login
pale_orbit.migration_expected_storage_cleanup_login
```

Do not call the pinned `drizzle-orm/node-postgres` migrator inside that transaction: it dereferences the underlying session and issues a top-level `BEGIN`/`COMMIT` instead of using `NodePgTransaction.transaction`. REDs require an application-owned executor that consumes public `readMigrationFiles` output and reproduces the fixed `drizzle.__drizzle_migrations` journal contract entirely on the outer transaction: create schema/table, read the latest timestamp, execute every pending parsed statement, and insert the parser-supplied hash/timestamp. Pin exact statement/journal order and prove no commit can occur before the outer callback finishes.

The RED must prove missing/invalid/duplicate identities abort before migration; settings use bound values rather than SQL interpolation; pre-existing session values and relevant owner/database `pg_db_role_setting` defaults fail closed; the transaction rolls back on migration failure; no identifier is logged; and no session/database/role-persistent setting is written. Compose and process-scope tests require the migration service to receive only the three non-secret names plus its owner connection settings, never application passwords, and every non-migration service to have the names absent or explicitly blank. `test-environment.test.ts` requires all three names to be removed from downstream web/worker/test environments. `with-test-database.test.ts` requires the disposable harness to re-add those three attested names only to the owner migration environment even while stripping worker/cleanup credentials.

Require these enums and table shape:

```ts
export const financialAdminCommandKind = pgEnum('financial_admin_command_kind', [
  'refund_draft_save',
  'refund_draft_discard',
  'refund_allocation_finalize',
  'refund_reporting_correction_create',
  'administrative_recovery_activate',
  'administrative_recovery_deactivate'
]);

export const financialAdminCommandStatus = pgEnum('financial_admin_command_status', [
  'pending', 'succeeded', 'denied', 'conflict', 'failed'
]);

export const financialAdminCommands = pgTable('financial_admin_commands', {
  id: uuid('id').defaultRandom().primaryKey(),
  kind: financialAdminCommandKind('kind').notNull(),
  actorUserId: uuid('actor_user_id').notNull().references(() => user.id, {
    onDelete: 'restrict'
  }),
  correlationId: varchar('correlation_id', { length: 100 }).notNull(),
  idempotencyKeySha256: varchar('idempotency_key_sha256', { length: 64 }).notNull(),
  inputFingerprintSha256: varchar('input_fingerprint_sha256', { length: 64 }).notNull(),
  privateInput: jsonb('private_input').$type<JsonObject>().notNull(),
  jobId: uuid('job_id').notNull(),
  status: financialAdminCommandStatus('status').default('pending').notNull(),
  safeResultCode: varchar('safe_result_code', { length: 100 }),
  safeResult: jsonb('safe_result').$type<JsonObject>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true })
}, (table) => [
  uniqueIndex('financial_admin_commands_actor_idempotency_unique').on(
    table.actorUserId, table.idempotencyKeySha256
  ),
  uniqueIndex('financial_admin_commands_job_unique').on(table.jobId),
  index('financial_admin_commands_status_created_idx').on(
    table.status, table.createdAt, table.id
  )
]);

export const financialAdminJobClaims = pgTable('financial_admin_job_claims', {
  jobId: uuid('job_id').primaryKey().references(() => jobs.id, {
    onUpdate: 'restrict',
    onDelete: 'restrict'
  }),
  generation: integer('generation').notNull(),
  attempt: integer('attempt').notNull(),
  capabilitySha256: text('capability_sha256').notNull(),
  leaseDurationMs: integer('lease_duration_ms').notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  renewedAt: timestamp('renewed_at', { withTimezone: true }),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true })
}, (table) => [
  check('financial_admin_job_claims_generation_positive',
    sql`(${table.generation} between 1 and 2147483647) is true`),
  check('financial_admin_job_claims_attempt_positive',
    sql`(${table.attempt} between 1 and 2147483647) is true`),
  check('financial_admin_job_claims_capability_sha256_valid',
    sql`(${table.capabilitySha256} ~ '^[a-f0-9]{64}$') is true`),
  check('financial_admin_job_claims_lease_duration_bounded',
    sql`(${table.leaseDurationMs} between 1 and 86400000) is true`),
  check('financial_admin_job_claims_lifecycle_consistent', sql`(
    (${table.state} = 'active' and ${table.invalidatedAt} is null and
      (${table.renewedAt} is null or ${table.renewedAt} >= ${table.issuedAt}) and
      ${table.expiresAt} > coalesce(${table.renewedAt}, ${table.issuedAt}))
    or
    (${table.state} = 'invalidated' and ${table.invalidatedAt} is not null and
      (${table.renewedAt} is null or ${table.renewedAt} >= ${table.issuedAt}) and
      ${table.invalidatedAt} >= coalesce(${table.renewedAt}, ${table.issuedAt}))
  ) is true`)
]);
```

Add `integer` and `text` imports and import `jobs` from the existing operations schema; keep this private table in `financial-admin.ts`. Static tests must require SHA-256 lowercase hex, bounded canonical correlation IDs, JSON object input/result with `pg_column_size(private_input) <= 8192` and `pg_column_size(safe_result) <= 4096`, immutable identity/input/job fields, terminal immutability, no delete path, and a deferred restrictive `job_id -> jobs.id` foreign key. The command lifecycle constraint is exact: pending means code/result/completion are null; succeeded means a kind-matched success code, exact safe-result object, and completion are present; denied/conflict/failed mean their fixed failure code and completion are present while result is null. All SQL JSON/key/type/lifecycle predicates are total and NULL-safe: required keys are explicitly present, extra keys are absent, JSON `null` is rejected, guarded casts use `pg_input_is_valid`, and the complete accepted predicate must be `IS TRUE` so SQL UNKNOWN cannot satisfy a `CHECK`. Every JSON version later stored or compared to a PostgreSQL `integer` is `1..2147483647`, not merely a JavaScript safe integer.

The claim relation has exactly the columns and checks above, one row per financial-admin job, no clear-token column, and no application ACL. `generation` increases on every initial claim/retry/takeover rotation; `attempt` equals the linked job attempt. `active` has no invalidation timestamp and an expiry later than issue/latest renewal; only a terminal job produces `invalidated`, which is irreversible. A retryable failure or rerun keeps the row nonterminal but expires it at database time so the next claim must rotate it.

In the same RED, require an `EnqueuedJobReference` seam that inserts/replays a job but returns only the job ID and, only where a caller must compare it, deterministic deduplication identity. Runtime-capable claim-request, outbox-dispatch, commerce-email, ingestion-submission, and Stripe-webhook call sites must use this seam without selecting `jobs.payload`; worker-owned flows that need a parsed full job row may retain the full-row helper.

Require this internal runner plumbing without changing any browser/public DTO:

```ts
export interface JobRecord {
  id: string;
  type: string;
  payload: JsonObject;
  deduplicationKey: string | null;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
  financialAdminLeaseCapability?: string;
}

export interface JobRepository {
  claimNext(workerId: string): Promise<JobRecord | null>;
  renewLease(
    jobId: string,
    workerId: string,
    financialAdminLeaseCapability?: string
  ): Promise<boolean>;
  complete(
    jobId: string,
    workerId: string,
    financialAdminLeaseCapability?: string
  ): Promise<boolean>;
  fail(
    jobId: string,
    workerId: string,
    safeError: string,
    retryable: boolean,
    financialAdminLeaseCapability?: string
  ): Promise<boolean>;
}
```

`runner.test.ts` must prove the runner passes the exact opaque value from the claimed record to renewal, completion, permanent failure, transient retry, exhausted failure, and ambiguous-completion fallback; it must also prove missing/stale lease responses abort without another terminal write and that no log/error contains the token. Existing nonfinancial records omit the optional field and retain their current behavior.

- [ ] **Step 2: Write failing migration rollback and collision fixtures**

Extend `financial-migration.test.ts` with isolated `through(11) -> 0012` fixtures for:

- an unsafe pre-existing enum, either table, routine, or trigger name, including `financial_admin_job_claims`, `plan6bii_assert_financial_admin_job_lease(uuid)`, `plan6bii_guard_financial_admin_job_lease()`, or `jobs_plan6bii_financial_admin_lease_guard`;
- unsafe prerequisite owner/direct ACL/default ACL/fixed-group membership, a disabled or displaced prerequisite job/audit/issue trigger, and a non-origin `session_replication_role`;
- malformed legacy command-like data is impossible because the table is new;
- a clean populated 0011 database migrates through 0012;
- every one of the eight absent/present combinations of the three attested roles succeeds only when each present role has the provisioner's exact attributes, null role/database settings, infinity validity, and its exact web-to-runtime, worker-to-financial-worker, or cleanup-to-storage-cleanup edge/options, each absent role has no edge, and the financial-worker-to-runtime edge is exact;
- this matrix explicitly includes fresh all-absent, historical web+worker-present/cleanup-absent, and fully provisioned states;
- an existing attested role without its edge, an edge for an absent identity, swapped, duplicate, reserved, attribute-drifted, setting-bearing, unexpectedly inherited, or additional login/member state fails before any 0012 object or grant;
- failure leaves journal at 0011 and creates no partial enum/table/routine/trigger/ACL;
- repair then applies 0012 once, and a second migrator pass is a no-op.

Expected migration errors are SQLSTATE `42501` for authority/collision preflight and transactional rollback for every later failure.

- [ ] **Step 3: Run the focused tests and confirm RED**

```powershell
npx vitest run src/lib/server/db/schema/financial-admin.test.ts src/lib/server/db/database-role-provision.test.ts src/lib/server/db/migrate.test.ts scripts/database-role-deployment.test.ts scripts/financial-schema-preservation.test.ts scripts/process-secret-scope.test.ts scripts/test-environment.test.ts scripts/with-test-database.test.ts src/lib/server/jobs/repository.test.ts src/lib/server/jobs/runner.test.ts src/lib/server/commerce/claims.test.ts src/lib/server/outbox/repository.test.ts src/lib/server/commerce/email/enqueue.test.ts src/lib/server/ingestion/job.test.ts src/lib/server/commerce/webhooks.test.ts
```

Expected: FAIL because the private claim schema, 0012 journal entry, capability-aware repository/runner, functions, triggers, and privilege contracts do not exist.

- [ ] **Step 4: Implement the schema, generate the metadata, and capture attestation RED**

```powershell
npm run db:generate -- --name plan6bii_admin_command_authority
```

Expected: Drizzle creates index `12`, one SQL file, and `drizzle/meta/0012_snapshot.json`. Rename only the generated SQL suffix if necessary so its committed name is exactly `0012_plan6bii_admin_command_authority.sql`; update the journal tag with the same basename. Do not edit prior snapshots or migrations.

Before implementing the identity transport or absolute preflight, obtain the serialized disposable-PostgreSQL slot and run the already-written bounded authority fixture once:

```powershell
node --import tsx scripts/with-plan6b-upgrade-database.ts --phase-command tsx tests/integration/financial-migration.test.ts --fixture plan6bii-admin-command-authority
```

Expected: RED on the first identity-attestation assertion because the generated migration still accepts a swapped, edge-drifted, or unexpected login topology. Record the exact failing assertion and prove the harness-owned project is absent afterward. Do not use this pre-implementation run as GREEN evidence.

- [ ] **Step 5: Add absolute-first preflight and complete bounded SQL routines**

Implement the migration identity transport before the SQL preflight. `src/migrate.ts` resolves and validates the three non-secret attested login names before replacing connection credentials with the owner role. Dedicated values take precedence; only when a dedicated value is absent may the host command use its corresponding direct ordinary login-name value. Reject nonempty `PGOPTIONS` before creating a client. `migrateDatabase` keeps the legacy resolver lockdown as its current separate autocommit operation and reads migrations through public `readMigrationFiles`, then opens one pinned owner transaction. Before setting anything, it requires all three `current_setting(name, true)` values to be null or empty. It calls bound `set_config(..., true)` for the names and executes the fixed Drizzle journal/statement algorithm itself on that same transaction; do not invoke the stock node-postgres migrator inside the callback. Any setting, journal, or migration failure rolls back the local settings, journal row, and 0012 effects together. Persistent `ALTER ROLE|DATABASE SET` and a registry table are forbidden substitutes.

Production and development Compose map the ordinary configured login-name variables into the three dedicated migration-name variables without mounting or passing the corresponding application password secrets. Every other development service explicitly blanks those names despite its shared `env_file`; production services never receive them. `withoutTestProcessSecrets` strips them from inherited child environments, and the disposable database harness re-adds them only to the owner migration child. The upgrade fixture must exercise 0012 through the production `migrateDatabase` path or an exact pinned-transaction equivalent; do not issue `SET` on a pool and then invoke a migrator that may use another connection.

Before any persistent or conditionally persistent 0012 statement, run one absolute preflight and fail with `42501` on any mismatch. It must prove: the current role is the exact database owner; `session_replication_role = 'origin'`; both new type names, both new table names, every new function signature, and every new trigger name are wholly absent; every prerequisite relation/function/type has the exact owner; the prerequisite database/schema/table/column/function ACLs are exact; and each attested login/fixed-group relationship satisfies the exact independent state below with no unexpected membership or option.

Read the attested identities only from the three transaction-local settings and validate them again inside the absolute-first block. Reject any owner/database default for those setting names in `pg_db_role_setting`. Evaluate each attested role independently: absent requires no canonical edge; present requires exact strict-login attributes/settings and exactly its configured edge from Step 2. Always require the canonical financial-worker-group-to-runtime-group edge. Reject every other inbound or outbound membership involving an attested login, fixed group, or the database owner. This admits every safe absent/present subset while ensuring a swapped or unknown login never inherits transient command authority.

Do not blanket-reject the canonical owner default ACLs established by migration 0009. Normalize `pg_default_acl` through `aclexplode` and require exactly these tuples, with database owner as both default-ACL owner and grantor and every grant non-grantable:

```text
public / table: DATABASE_OWNER -> INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
public / table: pale_orbit_runtime -> SELECT
public / sequence: DATABASE_OWNER -> USAGE, SELECT, UPDATE
public / sequence: pale_orbit_runtime -> USAGE, SELECT, UPDATE
global / routine: DATABASE_OWNER -> EXECUTE
global / routine: PUBLIC -> no tuple
```

Reject a missing or extra default-ACL row/privilege, another grantee, namespace/object-type drift, grant option, owner drift, or grantor drift. No default ACL may name the worker, storage-cleanup group/login, configured application logins, or another role. Also prove `jobs_plan6b_web_insert_guard -> plan6b_guard_job_insert()`, `audit_events_plan6b_web_insert_guard -> plan6b_guard_audit_insert()`, and `financial_reconciliation_issues_narrow_update -> plan6b_validate_issue_transition()` exist on the exact relations, are enabled in origin mode, and have the expected owner-controlled functions. Do not create an object, revoke a default, repair a trigger, or otherwise mutate state before this entire check passes.

Then add these exact public callable signatures, unchanged by the private claim design:

```sql
public.submit_financial_admin_command(uuid,text,text,text,text,jsonb)
public.financial_admin_command_status(uuid,uuid)
public.append_financial_issue_view_audit(uuid,uuid,text,text,text)
public.append_financial_refund_review_view_audit(uuid,uuid,text,text,text)
public.append_financial_payout_view_audit(uuid,uuid,text,text,text)
public.append_financial_sales_export_audit(uuid,text,text,integer,integer,integer,text,text)
public.resolve_financial_issue_after_admin_command(uuid,uuid)
public.transition_administrative_recovery_grant_after_admin_command(uuid)
```

Also create these private owner helpers and exact job trigger; they are not a ninth callable application boundary:

```sql
public.plan6bii_assert_financial_admin_job_lease(uuid)
public.plan6bii_guard_financial_admin_job_lease()

CREATE TRIGGER jobs_plan6bii_financial_admin_lease_guard
BEFORE UPDATE ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.plan6bii_guard_financial_admin_job_lease();
```

Both helpers are database-owner owned, `SECURITY DEFINER`, use `SET search_path = pg_catalog`, fully qualify every application object, and have all function privileges revoked from `PUBLIC`, both application groups/logins, and storage cleanup. `plan6bii_assert_financial_admin_job_lease(job_id)` reads only the transaction-local `pale_orbit.plan6bii_financial_admin_job_capability`, requires the exact 43-character unpadded base64url grammar, hashes it with `encode(sha256(convert_to(token, 'UTF8')), 'hex')`, and accepts only a matching owner-private row whose generation/attempt/state, linked job type/status/attempt, and `expires_at > clock_timestamp()` are current. A missing, malformed, forged, cross-job, expired, prior-generation, prior-attempt, or invalidated capability raises `55000` with one constant safe message.

Because the canonical table default grants runtime `SELECT`, immediately after creating the two protected tables—and before any subsequent callable routine or trigger can expose them—execute explicit `REVOKE ALL ON TABLE public.financial_admin_commands, public.financial_admin_job_claims FROM PUBLIC, pale_orbit_runtime, pale_orbit_financial_worker, pale_orbit_storage_cleanup`. After each private helper is created, explicitly `REVOKE ALL ON FUNCTION` for its exact signature from those same four principals. At the Task 3/5 migration-0012 commit boundary, prove configured application logins have no direct ACL, then grant back only the command-table worker SELECT/column UPDATE and the eight callable routine EXECUTE privileges listed in Step 7. The claim table and two private functions finish owner-only; do not rely on a default-ACL assumption for their final authority. Task 13 later adds the independently reviewed ninth correction-only routine through migration 0013.

`plan6bii_guard_financial_admin_job_lease()` applies only to `commerce.financial-admin-command` jobs and uses PostgreSQL `clock_timestamp()` as the sole lease clock. On `pending -> running` or an expired `running -> running` takeover, it acquires/reenters the exclusive per-job advisory transaction lock and requires the transaction-local capability plus canonical integer `pale_orbit.plan6bii_financial_admin_job_lease_duration_ms`, then inserts or rotates the private row: `generation = old + 1` (or `1`), `attempt = NEW.attempts`, new digest, bounded lease duration, `state = 'active'`, new issue/expiry, and null renewal/invalidation. On a same-generation heartbeat it acquires/reenters the shared advisory lock plus the current unexpired capability, preserves generation/attempt/digest/duration, and advances only `renewed_at`/`expires_at`. On a retryable failure or rerun to `pending`, it requires the current capability and expires the active claim at database time without marking it terminal. On `succeeded|failed`, it acquires/reenters the exclusive advisory lock and requires the current capability, then atomically sets `state = 'invalidated'`/`invalidated_at`; invalidated rows cannot rotate or renew. It rejects direct or structurally inconsistent job transitions before the existing terminal-sync trigger runs.

For one lock namespace, use `hashtextextended('pale-orbit:plan6bii-financial-admin-job-lease:' || job_id::text, 0)`. Claim/takeover/complete/fail lock and revalidate the job row first and then acquire its exclusive transaction lock; heartbeat locks/revalidates the job row and then acquires its shared transaction lock. Every command-handler transaction uses exactly `set transaction-local token -> administrator-role advisory lock -> shared per-job lease advisory lock -> bounded command identity/status row lock -> terminal replay handling`. Only when that bounded row remains pending does the handler take the actor identity from that row, reload the actor's current roles, require the fixed capabilities, and then load private input or enter domain work. Heartbeat takes no command lock, and no command-holding path waits for a job row or lease lock. At the migration-0012 Task 3/5 boundary, the public eight routines are the only application-callable SQL surface; Task 13's migration 0013 later adds only the ninth correction-specific resolver.

Every callable routine is database-owner owned, `SECURITY DEFINER`, uses `SET search_path = pg_catalog`, fully qualifies every application relation/type, rejects `PUBLIC`, and validates the fixed caller group before any read or write. Submit/status/the four fixed-action read-audit routines are executable only by `pale_orbit_runtime`. Issue and administrative-grant transitions are executable only by `pale_orbit_financial_worker`. Neither application login receives direct function grants; it inherits through its fixed group.

`submit_financial_admin_command` must:

1. validate exact actor UUID, canonical correlation text, kind, two lowercase SHA-256 values, and per-kind exact JSON keys/types/ranges with total NULL-safe predicates: require `jsonb_typeof(input) IS NOT DISTINCT FROM 'object'`, explicit required-key presence, exact key subtraction/equality, non-JSON-null typed values, guarded casts, and a final `... IS TRUE`; bound every database version to `1..2147483647`;
2. independently acquire `pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`, then prove the actor currently has `admin` in `user_roles` (the lock is reentrant when TypeScript already holds it);
3. insert or recover one row by `(actor_user_id, idempotency_key_sha256)`;
4. reject the same identity with a different kind, fingerprint, or input;
5. precompute the job UUID, insert the command first, then insert exactly one `commerce.financial-admin-command` job whose payload is `{"commandId": <uuid>}`, dedupe is `commerce:financial-admin-command:<uuid>:v1`, and `max_attempts = 8`; and
6. return only command ID, kind, actual safe status, and created timestamp, because an identical replay may recover a terminal command.

The command table's input/result/lifecycle checks follow the same total-Boolean rule. PostgreSQL `CHECK` treats UNKNOWN as accepted, so no required JSON key, `jsonb_typeof`, UUID/hash test, numeric range, kind/result pairing, or timestamp relation may be left nullable. Tests insert missing keys and explicit JSON `null` at every required position and prove each is rejected without a row/job/audit side effect.

Replace `plan6b_guard_job_insert()` with its complete previous definition plus one exact command-job branch. That branch must load the uncommitted command row, require `command.job_id = NEW.id`, exact payload/dedupe/defaults/max-attempts, and reject every other new web job type. Do not weaken existing Stripe, ingestion, claim-request, or outbox branches.

`financial_admin_command_status` and each read-audit routine independently acquire the same global administrator-role lock before reading roles. The TypeScript status wrapper always requires `sales.read`; the routine independently proves current admin role, enforces `actor_user_id = p_actor_user_id`, and returns only the strict safe status columns. Each read-audit routine hard-codes exactly one action and accepts only scalar actor/resource/correlation/method/route fields; the export routine additionally accepts only filter fingerprint and row/byte/currency-pair counts. No routine accepts caller-selected action text or JSON. The issue/admin-grant routines independently verify worker membership and preserve the handler prefix rather than creating an alternative lock order. After the reentrant role lock, an unlocked lookup may read only `job_id` to address the already-held shared lease key; the routine then acquires/reenters that shared lease lock, locks the bounded command identity/status row, takes the actor identity from that row, reloads the actor's current roles and requires the kind's authority, invokes `plan6bii_assert_financial_admin_job_lease(job_id)`, and only then reads/revalidates private input and target linkage. They accept only a still-pending matching command. Actor, correlation, target, desired transition, and audit identity are derived from the revalidated command and cannot be supplied by callers.

For recovery activation, the routine and executor must both bind the command to the exact refund, finalization effect, order item, current correction-set ID/version, current source fingerprint, and active projection implementation. Under the canonical projection/purchase locks they re-read all six relationships and recompute the preview fingerprint; correction-tip, fingerprint, projection-head/implementation, or finalization-provenance drift is `conflict/stale_state`, while a current but causally ineligible relationship is `conflict/not_eligible`. Deactivation binds the exact recovery grant, immutable recovery reference, and expected state-change timestamp. Neither routine may accept a caller-supplied user/title/grant source.

- [ ] **Step 6: Add lease, transition, audit, grant, and exhausted-job guards**

Create and attach these exact trigger functions/triggers:

```text
plan6bii_guard_financial_admin_command_update
financial_admin_commands_plan6bii_update_guard
plan6bii_guard_financial_admin_command_delete
financial_admin_commands_plan6bii_delete_guard
plan6bii_assert_financial_admin_job_lease(uuid)
plan6bii_guard_financial_admin_job_lease
jobs_plan6bii_financial_admin_lease_guard
plan6bii_guard_administrative_grant_transition
entitlement_grants_plan6bii_administrative_guard
plan6bii_sync_failed_financial_admin_command
jobs_plan6bii_financial_admin_terminal_sync
```

The command update guard permits only `pending -> terminal` with immutable identity/private input/job and exact NULL-safe safe-result shape; terminal rows cannot change. An ordinary worker transition also requires the transaction-local clear capability to pass `plan6bii_assert_financial_admin_job_lease(job_id)` for the exact linked `running` command job with matching `{commandId}` payload/dedupe/generation/attempt. `running` plus non-null `locked_at` is never sufficient authority. Direct worker UPDATE before claim, with a missing/forged/cross-job/expired/prior-generation token, after lease loss, for another command, or after terminal completion raises `55000`. Delete always raises `55000`. The entitlement trigger is `SECURITY INVOKER` and rejects every INSERT, UPDATE, or DELETE involving an OLD or NEW row with `source='administrative'` unless `current_user` is the transition-routine owner, the current lease assertion has passed, and the transaction-local command identity set by that exact routine matches the row linkage. A direct worker with a valid token and spoofed custom settings still fails.

Centralize `denied|conflict|failed` audit insertion in the command transition trigger: every valid pending-to-failure transition appends exactly one minimized fixed action from NEW status/code, actor, command ID/kind, and correlation, never private input or job error. Handler code updates the command but does not insert a second terminal audit. When a linked job becomes terminal failed while its command is still pending, the lease guard first validates and invalidates the current claim under the exclusive per-job lock; the following terminal-sync trigger may store `failed/command_failed` only while that exact owner-private claim is already invalidated for the current attempt and the persisted linked job remains the exact running/locked row with exact payload/dedupe inside the same outer update. The command transition trigger supplies its audit. Call-stack text, depth, or a GUC alone is not provenance. Preflight pins the exact enabled `jobs` `BEFORE UPDATE` trigger graph/order and proves neither worker nor `PUBLIC` has `TRIGGER`, preventing an injected trigger from retaining the temporal window. An already-terminal command produces neither duplicate. A linked job may become `succeeded` only when its command is already `succeeded`; denied/conflict/failed commands can end only with a failed job.

Extend `plan6b_guard_audit_insert()` with exact owner-routine provenance for the three detail actions and export action only. General runtime `financial.*` insertion remains rejected. Worker-authored mutation/terminal actions remain allowed through the existing worker branch.

Implement the repository/runner side in the same RED/GREEN tranche. One `claimNext` invocation opens one transaction, selects and locks at most one candidate through `FOR UPDATE SKIP LOCKED LIMIT 1`, and processes only that row. The candidate ordering includes normally pending jobs, expired running retry/takeover jobs, and expired running final-attempt cleanup jobs, but there is no bulk exhausted-job update CTE. After the one locked candidate is revalidated and only if it is a financial-admin job requiring a generation rotation, generate exactly once:

```ts
const financialAdminLeaseCapability = randomBytes(32).toString('base64url');
```

The transaction sets that one value with `set_config('pale_orbit.plan6bii_financial_admin_job_capability', value, true)` and the canonical decimal lease duration with `set_config('pale_orbit.plan6bii_financial_admin_job_lease_duration_ms', value, true)`, acquires the locked job's exclusive advisory transaction lock, and performs exactly one guarded claim/takeover rotation. Return the clear value only as `JobRecord.financialAdminLeaseCapability` for a nonterminal claimed command; discard the short-lived value after an exhausted cleanup. A no-row or nonfinancial outcome generates no financial-admin capability. Never reuse one value for a second job, loop over multiple exhausted rows inside the transaction, or calculate/compare expiry with injected `now()`; SQL and the guard use `clock_timestamp()`.

An expired running job already at `max_attempts` follows one exact cleanup path: under its locked job row and exclusive lease lock, rotate to the fresh token and `generation + 1` while retaining the maximal positive attempt, then immediately transition the job to failed and the claim to irreversible invalidated in that same transaction. The terminal-sync trigger stores `failed/command_failed` when the command is still pending. Do not validate this cleanup with the expired prior token, increment attempts beyond `max_attempts`, or return the short-lived adoption token to a handler.

`renewLease` requires the supplied value for a financial-admin job, sets it transaction-locally, locks/revalidates the job row, acquires the shared advisory lock, and performs the guarded same-attempt renewal; it returns `false` after expiry and never revives a claim. `complete` and `fail` set the supplied value transaction-locally, lock/revalidate the job row, take the exclusive advisory lock, and let the lease guard invalidate a terminal claim or expire a requeued one atomically. `complete` with `rerun_requested_at` returns the job to pending and expires rather than invalidates the claim. `fail(retryable=true)` expires/requeues before exhaustion and invalidates on exhaustion; nonretryable failure invalidates immediately. Every missing, stale, forged, or cross-job capability returns false or raises the one bounded internal authority error without echoing the value. The generic runner forwards the optional value on every heartbeat/complete/fail path and never logs, serializes, clones into a payload, or places it in an error.

- [ ] **Step 7: Add exact ACLs and provisioner parity**

Update the provisioner allowlists so final authority is exactly:

```text
runtime: no table/column privilege on financial_admin_commands
runtime EXECUTE: submit, status, four fixed-action financial read audits
worker SELECT: financial_admin_commands
worker UPDATE columns: status, safe_result_code, safe_result, updated_at, completed_at
worker EXECUTE: admin issue resolution, administrative recovery transition
financial_admin_job_claims: owner-only; no table/column privilege for either application group/login, storage cleanup, or PUBLIC
private lease helper/trigger functions: owner-only; no direct EXECUTE for either application group/login, storage cleanup, or PUBLIC
PUBLIC: none
storage-cleanup: none
```

Add both new tables and `jobs` to `RUNTIME_TABLE_SELECT_EXCLUSIONS`; add both new tables to `PROTECTED_RUNTIME_WRITE_TABLES` and sensitive-column scans. Add the private claim table to the worker SELECT/write exclusions as well: the worker interacts with it only through the owner trigger. Runtime receives at most the narrow job reference columns required by the refactored enqueue seam and never `jobs.payload`, status internals, attempts, lease data, or errors. Worker retains full jobs SELECT. For the Task 3/5 migration-0012 commit, add only its eight callable signatures to `RUNTIME_EXECUTE_FUNCTIONS` and `WORKER_EXECUTE_FUNCTIONS`; the two private lease functions must be explicitly absent. Task 13 later extends only the worker list with the ninth correction-specific resolver. Provisioner/static tests prove the database-owner default ACL and final direct ACL state cannot make a future or current claim/helper object application-executable.

Implement the tested safe enqueue seam and move every runtime-capable call site named in Step 1 before applying the `jobs.payload` revoke. Unit and PostgreSQL role tests must prove runtime enqueue/idempotent replay still succeeds through the reference seam after the revoke. This refactor is part of the same authority/catalog commit; do not leave an intermediate commit in which current web paths call a full-row `INSERT ... RETURNING *` without SELECT authority.

Grant the worker the exact domain DML the six executors require: INSERT on `refund_allocation_drafts`, `refund_allocation_draft_items`, and `refund_allocation_finalization_effects`; UPDATE only `state`, `version`, `updated_by_admin_id`, `updated_correlation_id`, `updated_at`, `finalized_at`, and `discarded_at` on drafts; and UPDATE only `proposed_total_presentment_minor` and `updated_at` on draft items. Grant no DELETE. Preserve the exact fixed-group `CONNECT` contracts.

- [ ] **Step 8: Run service-free GREEN and inspect the migration**

```powershell
npx vitest run src/lib/server/db/schema/financial-admin.test.ts src/lib/server/db/database-role-provision.test.ts src/lib/server/db/migrate.test.ts scripts/database-role-deployment.test.ts scripts/financial-schema-preservation.test.ts scripts/process-secret-scope.test.ts scripts/test-environment.test.ts scripts/with-test-database.test.ts src/lib/server/jobs/repository.test.ts src/lib/server/jobs/runner.test.ts src/lib/server/commerce/claims.test.ts src/lib/server/outbox/repository.test.ts src/lib/server/commerce/email/enqueue.test.ts src/lib/server/ingestion/job.test.ts src/lib/server/commerce/webhooks.test.ts
npm run db:check
npm run check
npm run lint
git diff --check
git diff -- drizzle/0012_plan6bii_admin_command_authority.sql drizzle/meta/0012_snapshot.json drizzle/meta/_journal.json
```

Expected: all commands exit zero; the diff contains only the new 0012 entry and intended schema/authority changes.

- [ ] **Step 9: Run the bounded PostgreSQL migration and role witnesses**

Run serially:

```powershell
npm run test:integration -- tests/integration/financial-schema.test.ts tests/integration/database-role-boundaries.test.ts
node --import tsx scripts/with-plan6b-upgrade-database.ts --phase-command tsx tests/integration/financial-migration.test.ts --fixture plan6bii-admin-command-authority
```

Expected: fresh schema, collision rollback/repair, 0011-to-0012 upgrade, all eight exact safe attested-login subsets, and swapped/edge/attribute/setting/unexpected-member rollback pass alongside direct web denial, bounded runtime routine success, runtime enqueue/replay through the safe reference seam, worker-only status/transition authority, capability-aware job-terminal synchronization, and exact ACLs. Prove nonempty `PGOPTIONS` and pre-existing session or owner/database-default attestation values fail before migration. Prove the three migration settings have no usable value after commit or rollback (allowing only PostgreSQL's empty custom-parameter placeholder), never retain a login name, and never persist in `pg_db_role_setting`. Prove positive current-token claim, heartbeat, pending-to-success/failure command transition, command-bound issue/grant routine, retry requeue, and terminal invalidation—not only rejection paths. Seed two normal financial-admin jobs plus two expired final-attempt jobs and call `claimNext` four times: each transaction changes exactly one target, invokes the cryptographic token source exactly once for that target, produces one correct per-job generation and four distinct capabilities/stored digests overall, and leaves the other three rows unchanged until their own invocation. No bulk exhausted CTE or shared-GUC token may exist; using any captured normal-job token against another job is rejected. Then prove database-clock expiry; takeover/retry generation rotation; old-session resumption; and missing, forged, cross-job, expired, prior-attempt, prior-generation, renewed-after-expiry, and terminal tokens each raise `55000` or return false with job/claim/command/domain/audit state unchanged. Direct worker invocation after actor demotion fails under the routine's own role lock. Named concurrent witnesses show handler/heartbeat shared locks coexist, takeover/terminal exclusive locks wait without deadlock, and no command-holding transaction waits for a job row or lease lock. Each harness self-cleans its owned project.

- [ ] **Step 10: Freeze the authority diff without committing it yet**

```powershell
git diff --check -- src/lib/server/db/schema/financial-admin.ts src/lib/server/db/schema/financial-admin.test.ts src/lib/server/db/schema/index.ts drizzle/0012_plan6bii_admin_command_authority.sql drizzle/meta/0012_snapshot.json drizzle/meta/_journal.json src/lib/server/db/database-role-provision.ts src/lib/server/db/database-role-provision.test.ts src/lib/server/db/migrate.ts src/lib/server/db/migrate.test.ts src/migrate.ts compose.prod.yaml compose.dev.yaml scripts/database-role-deployment.test.ts scripts/financial-schema-preservation.test.ts scripts/process-secret-scope.test.ts scripts/test-environment.ts scripts/test-environment.test.ts scripts/with-test-database.ts scripts/with-test-database.test.ts tests/integration/financial-schema.test.ts tests/integration/financial-migration.test.ts tests/integration/database-role-boundaries.test.ts src/lib/server/jobs/types.ts src/lib/server/jobs/runner.ts src/lib/server/jobs/runner.test.ts src/lib/server/jobs/repository.ts src/lib/server/jobs/repository.test.ts src/lib/server/commerce/claims.ts src/lib/server/commerce/claims.test.ts src/lib/server/outbox/repository.ts src/lib/server/outbox/repository.test.ts src/lib/server/commerce/email/enqueue.ts src/lib/server/commerce/email/enqueue.test.ts src/lib/server/ingestion/job.ts src/lib/server/ingestion/job.test.ts src/lib/server/commerce/webhooks.ts src/lib/server/commerce/webhooks.test.ts
```

Expected: the diff is clean. Do not stage or commit it until Task 5 has advanced and calibrated the exact restore/catalog contract.

### Task 4 (execute after Task 5): Build command submission, status polling, worker execution, and audit clients

**Files:**
- Create: `src/lib/server/commerce/financial/admin-commands/contracts.ts`
- Create: `src/lib/server/commerce/financial/admin-commands/contracts.test.ts`
- Create: `src/lib/server/commerce/financial/admin-commands/repository.ts`
- Create: `src/lib/server/commerce/financial/admin-commands/repository.test.ts`
- Create: `src/lib/server/commerce/financial/admin-commands/handler.ts`
- Create: `src/lib/server/commerce/financial/admin-commands/handler.test.ts`
- Create: `src/lib/server/commerce/financial/admin-commands/executors.ts`
- Create: `src/lib/server/commerce/reporting/audit.ts`
- Create: `src/lib/server/commerce/reporting/audit.test.ts`
- Create: `src/routes/admin/sales/commands/[commandId]/+server.ts`
- Modify: `src/routes/admin/sales/route-support.test.ts`
- Modify: `src/lib/server/jobs/repository.test.ts`
- Create: `tests/integration/financial-admin-commands.test.ts`

- [ ] **Step 1: Write failing strict private-command parser tests**

Export one `z.discriminatedUnion('kind', ...)` parser whose six variants have exactly these payloads:

```ts
export type FinancialAdminPrivateCommand =
  | {
      readonly kind: 'refund_draft_save';
      readonly refundId: string;
      readonly expectedVersion: number | null;
      readonly items: readonly {
        readonly orderItemId: string;
        readonly totalPresentmentMinor: number;
      }[];
    }
  | {
      readonly kind: 'refund_draft_discard';
      readonly refundId: string;
      readonly expectedActiveDraftVersion: number;
    }
  | {
      readonly kind: 'refund_allocation_finalize';
      readonly refundId: string;
      readonly expectedActiveDraftVersion: number;
      readonly previewFingerprint: string;
      readonly confirmation: 'finalize_refund_allocation';
    }
  | {
      readonly kind: 'refund_reporting_correction_create';
      readonly refundId: string;
      readonly reason: 'allocation_attribution_correction';
      readonly expectedNextCorrectionVersion: number;
      readonly expectedBaseAllocationSetId: string;
      readonly expectedSourceFingerprint: string;
      readonly items: readonly {
        readonly orderItemId: string;
        readonly totalPresentmentMinor: number;
      }[];
      readonly previewFingerprint: string;
      readonly confirmation: 'create_reporting_correction';
    }
  | {
      readonly kind: 'administrative_recovery_activate';
      readonly refundId: string;
      readonly finalizationEffectId: string;
      readonly orderItemId: string;
      readonly expectedCorrectionSetId: string;
      readonly expectedCorrectionVersion: number;
      readonly expectedSourceFingerprint: string;
      readonly previewFingerprint: string;
      readonly confirmation: 'activate_persistent_recovery';
    }
  | {
      readonly kind: 'administrative_recovery_deactivate';
      readonly recoveryGrantId: string;
      readonly recoveryReferenceId: string;
      readonly expectedStateChangedAt: string;
      readonly confirmation: 'deactivate_persistent_recovery';
    };
```

UUIDs are canonical lowercase. Fingerprints are lowercase SHA-256. Versions are safe positive integers bounded to the PostgreSQL integer maximum `2147483647`. Draft/correction rows contain 1–25 unique items with nonnegative safe totals. Timestamps are canonical UTC ISO strings. Reject unknown keys, sparse/accessor/proxy objects, duplicates, unsafe numbers, customer/user/title/provider fields, arbitrary capability/audit/result/job fields, free-form reason/evidence, and noncanonical JSON.

- [ ] **Step 2: Write failing repository and audited-read client tests**

Require:

```ts
export interface SubmitFinancialAdminCommandInput {
  readonly actor: AdministratorActor;
  readonly idempotencyKey: string; // canonical lowercase UUID, parsed before hashing
  readonly command: FinancialAdminPrivateCommand;
  readonly context: FinancialRequestContext;
}

export async function submitFinancialAdminCommand(
  database: Database,
  input: SubmitFinancialAdminCommandInput,
  dependencies?: FinancialAuthorizationDependencies
): Promise<FinancialAdminCommandReferenceDto>;

export async function getFinancialAdminCommandStatus(
  database: Database,
  actor: Actor,
  commandId: string,
  dependencies?: FinancialAuthorizationDependencies
): Promise<FinancialAdminCommandStatusDto | null>;

export function auditFinancialIssueDetailRead(
  tx: DatabaseTransaction,
  input: FinancialIssueReadAuditInput
): Promise<void>;
export function auditFinancialRefundDetailRead(
  tx: DatabaseTransaction,
  input: FinancialRefundReadAuditInput
): Promise<void>;
export function auditFinancialPayoutDetailRead(
  tx: DatabaseTransaction,
  input: FinancialPayoutReadAuditInput
): Promise<void>;
export function auditFinancialExportCompleted(
  tx: DatabaseTransaction,
  input: FinancialExportAuditInput
): Promise<void>;
```

Submission parses the idempotency key as a canonical lowercase UUID, looks up the kind in the shared `FINANCIAL_ADMIN_COMMAND_CAPABILITIES` map, authorizes those fixed capabilities before canonicalizing/hashing input, acquires `pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`, reloads roles, reauthorizes through the injected-or-default resolver, and calls only the submit routine. Status always requires `sales.read`—it cannot safely know the private kind before the protected call—uses the same resolver and role lock/reload sequence, calls only the status routine, and returns `null` for absent/other-actor commands. Each audit client calls only its one fixed-action scalar routine; no TypeScript or SQL audit seam accepts an action or JSON argument.

- [ ] **Step 3: Write failing job-parser and handler state-machine tests**

Require:

```ts
export const FINANCIAL_ADMIN_COMMAND_JOB =
  'commerce.financial-admin-command' as const;

export interface FinancialAdminCommandExecutorContext {
  readonly transaction: DatabaseTransaction;
  readonly commandId: string;
  readonly actor: AdministratorActor;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}

export type FinancialAdminCommandExecutor = (
  context: FinancialAdminCommandExecutorContext,
  command: FinancialAdminPrivateCommand
) => Promise<FinancialAdminCommandSafeResultDto>;

export function createFinancialAdminCommandHandler(input: {
  readonly database: Database;
  readonly executors: ReadonlyMap<FinancialAdminCommandKind, FinancialAdminCommandExecutor>;
  readonly capabilityResolver?: CapabilityResolver;
}): JobHandler;

export function createFinancialAdminCommandExecutors(input: {
  readonly refundDraftSave: FinancialAdminCommandExecutor;
  readonly refundDraftDiscard: FinancialAdminCommandExecutor;
  readonly refundAllocationFinalize: FinancialAdminCommandExecutor;
  readonly refundReportingCorrectionCreate: FinancialAdminCommandExecutor;
  readonly administrativeRecoveryActivate: FinancialAdminCommandExecutor;
  readonly administrativeRecoveryDeactivate: FinancialAdminCommandExecutor;
}): ReadonlyMap<FinancialAdminCommandKind, FinancialAdminCommandExecutor>;
```

The handler must prove exact `{commandId}` payload and job dedupe and require the internal `job.financialAdminLeaseCapability` to match the exact 43-character unpadded base64url grammar without copying or logging it. Each main or follow-up handler transaction sets it only with transaction-local `set_config('pale_orbit.plan6bii_financial_admin_job_capability', token, true)`, then:

1. acquire the global administrator-role lock before the command row;
2. acquire `pg_advisory_xact_lock_shared(hashtextextended('pale-orbit:plan6bii-financial-admin-job-lease:' || job.id, 0))` before any command row lock;
3. lock and re-read only the command identity/status/idempotency fields, require its linked job identity to match the `JobRecord`, and do not select private input yet;
4. on terminal replay, return only for `succeeded`; for `denied`, `conflict`, or `failed`, throw `PermanentJobError` without another mutation/audit so the generic runner records job failure;
5. for a pending command, take the actor identity from that bounded locked row, load the actor's current roles, use the injected-or-default resolver plus the shared kind map, require `sales.read` plus `reconciliation.manage`, and only then select/parse private input and invoke exactly one mapped executor in the same transaction;
6. store `succeeded` plus the kind's exact result code/data in the same commit as domain/audit/outbox effects; the command guard performs the database-clock capability assertion at this final transition; and
7. respect an aborted lease signal before domain work and before the terminal command update/commit; every command-bound owner routine asserts the current token before its effect, and the final command-update guard asserts it again so any intervening expiry rolls back the entire transaction.

Define exact typed failures:

```ts
export class FinancialAdminDeniedError extends Error {
  readonly terminalStatus = 'denied' as const;
  constructor(readonly safeCode: 'capability_revoked');
}

export class FinancialAdminConflictError extends Error {
  readonly terminalStatus = 'conflict' as const;
  constructor(readonly safeCode: 'stale_state' | 'not_eligible');
}

export class FinancialAdminPermanentError extends Error {
  readonly terminalStatus = 'failed' as const;
  constructor(readonly safeCode: 'invalid_command' | 'command_failed');
}
```

Capability revocation stores `denied/capability_revoked` with no domain write. Stale locked facts store `conflict/stale_state`; a currently ineligible domain relationship stores `conflict/not_eligible`. Malformed stored data stores `failed/invalid_command`; a safe permanent or exhausted operational error stores `failed/command_failed`. Idempotency mismatch is a submission-time 409 and is never a worker terminal code. A denied/conflict/permanent error rolls back the domain transaction first, then uses a new transaction with the same current opaque token and exact `role advisory -> shared lease advisory -> command row` order to update the terminal result; the command transition trigger atomically appends exactly one fixed `financial.admin_command.denied|conflict|failed` audit attributed to the submitting administrator. The audit contains command ID/kind, safe code, and correlation only—never private input, token, digest, or an internal error. A transient error before the last attempt leaves the command pending and rethrows so the capability-aware runner atomically expires/requeues the job. On the last attempt the runner's guarded terminal failure invalidates the claim and the terminal-sync trigger stores `failed/command_failed`; the command trigger supplies the audit. A process crash after a terminal command commit leaves the job/claim nonterminal until database-clock expiry; takeover rotates generation/token, replays without another audit or domain change, and produces the corresponding terminal job outcome. The old token cannot perform the follow-up transition after expiry or rotation.

- [ ] **Step 4: Write failing route, claim-policy, and PostgreSQL lifecycle tests**

The status endpoint is same-origin `GET`, authorizes before parsing, returns `Cache-Control: no-store`, parses the safe DTO, and maps malformed/foreign/missing IDs to 404. It exposes no job ID, payload, attempts, `last_error`, private input, actor ID, or internal error.

Extend `jobs/repository.test.ts` to prove the new job remains claimable in `local-only` mode and is not gated on Stripe/projection-provider readiness. In `financial-admin-commands.test.ts`, prove:

- submit + command + job are one transaction;
- identical idempotent replay returns one row/job;
- same key with different fingerprint conflicts;
- web cannot read the command table or job payload;
- worker can read/lock and update only terminal columns;
- a current claimed generation with its opaque token can execute, renew, store a terminal command, and complete/fail the linked job through the real runner;
- every handler and follow-up terminal transaction sets only the current token transaction-locally and takes `role -> shared lease -> command`, while heartbeat takes `job -> shared lease` and terminal runner work takes `job -> exclusive lease -> command sync`;
- demotion before execution produces denied with no domain executor call;
- demotion concurrent with execution serializes on the role lock;
- succeeded terminal replay is a no-op and completes the job; denied/conflict/failed terminal replay adds no domain/audit change and permanently fails the job;
- transient retry and final exhaustion synchronize a safe failed status; and
- crash-after-terminal-commit replay preserves the correct job outcome for succeeded, denied, conflict, and failed commands; and
- expiry/takeover rotates generation and rejects the old token; missing, forged, cross-job, prior-attempt, prior-generation, renewed-after-expiry, and invalidated tokens leave every effect unchanged; and
- outside the transient transaction-local setting, a high-entropy secret sentinel appears only in the test process's in-memory `JobRecord`, never in jobs/commands/claims/audit/logs/status/API data; and
- two normal and two exhausted jobs require four separate `claimNext` transactions and four distinct capabilities/digests, with one-row mutation deltas and cross-job rejection; and
- no owner credential is used by web/worker application code.

The safe `EnqueuedJobReference` seam and every runtime-capable caller were already committed atomically with the Task 3/5 authority boundary. This task must preserve that boundary. Extend `jobs/repository.test.ts` only as needed to prove the new command job remains claimable in local-only mode; do not restore full-row runtime reads.

- [ ] **Step 5: Run focused tests and confirm RED**

```powershell
npx vitest run src/lib/server/commerce/financial/admin-commands/contracts.test.ts src/lib/server/commerce/financial/admin-commands/repository.test.ts src/lib/server/commerce/financial/admin-commands/handler.test.ts src/lib/server/commerce/reporting/audit.test.ts src/lib/server/jobs/repository.test.ts src/routes/admin/sales/route-support.test.ts
npm run test:integration -- tests/integration/financial-admin-commands.test.ts
```

Expected: FAIL because the TypeScript transport, handler, status route, and local-only claim behavior do not exist.

- [ ] **Step 6: Implement the command transport and fail-closed handler factory**

`executors.ts` exports only the pure six-dependency builder shown above. It constructs the fixed keys internally and rejects a missing, duplicate, or unknown kind; it does not accept a caller-supplied iterable and must not expose incomplete executors. Task 4 tests it with six local stubs. Do not register the job in `worker.ts` in this task because no production executor exists yet. Do not add a dynamic module loader or caller-selected executor name. Tasks 11–14 implement the six concrete executor functions without mutating a shared registry; Task 14 performs the sole complete production composition after all six exist.

At the Task 4 transport boundary, keep raw SQL limited to migration 0012's eight callable routine calls, role/shared-lease advisory locks, transaction-local token setting, and command identity/`FOR UPDATE` queries. The private lease helper remains non-executable and is reached only through owner routines/triggers; do not prematurely add a ninth grant or any lease route/endpoint. Task 13 later adds the explicitly designed correction-only ninth routine and no lease endpoint. Parse every database JSON/result value through the strict schemas before using or returning it.

- [ ] **Step 7: Run focused GREEN verification**

```powershell
npx vitest run src/lib/server/commerce/financial/admin-commands/contracts.test.ts src/lib/server/commerce/financial/admin-commands/repository.test.ts src/lib/server/commerce/financial/admin-commands/handler.test.ts src/lib/server/commerce/reporting/audit.test.ts src/lib/server/jobs/repository.test.ts src/routes/admin/sales/route-support.test.ts
npm run test:integration -- tests/integration/financial-admin-commands.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; the handler uses the worker client and status/submission use the web client.

- [ ] **Step 8: Commit the command transport**

```powershell
git add src/lib/server/commerce/financial/admin-commands src/lib/server/commerce/reporting/audit.ts src/lib/server/commerce/reporting/audit.test.ts src/routes/admin/sales/commands src/routes/admin/sales/route-support.test.ts src/lib/server/jobs/repository.test.ts tests/integration/financial-admin-commands.test.ts
git diff --cached --check
git commit -m "feat: add financial administrator command transport"
```

Expected: Task 5's authority/catalog commit is already HEAD, the transport commit succeeds, and no authority/catalog file remains dirty.

### Task 5 (execute immediately after Task 3): Extend exact restore, upgrade, and checkpoint contracts through 0012

**Files:**
- Modify: `scripts/verify-financial-restore.sql`
- Modify: `scripts/execute-financial-restore-verifier.ts`
- Modify: `scripts/commerce-operations.test.ts`
- Modify: `docs/stripe-financial-reconciliation.md`
- Modify: `docs/storage-ingestion-and-publication.md`
- Modify: `scripts/deployment-checkpoint.test.ts`
- Modify: `scripts/deployment-checkpoint-runtime.test.ts`
- Modify: `scripts/deployment-backup-bundle.test.ts`
- Modify: `scripts/with-plan6b-upgrade-database.test.ts`
- Modify: `tests/integration/financial-migration.test.ts`
- Modify: `tests/integration/database-role-boundaries.test.ts`

- [ ] **Step 1: Write failing exact-catalog and corruption-witness tests**

Advance the contract version from `plan6b-financial-catalog-v1` to `plan6b-financial-catalog-v2`. Require the manifest to include:

- both new enum label inventories;
- the full `financial_admin_commands` table descriptor, including relation state, owner/ACL, columns, every constraint, inbound FK, non-constraint index, noninternal trigger, rule, inheritance edge, and internal constraint-trigger mode;
- the full owner-only `financial_admin_job_claims` descriptor with the same exhaustive relation inventory, its restrictive job FK, positive generation/attempt, lowercase digest, bounded duration, exact timestamp/state lifecycle checks, and zero application/PUBLIC/storage-cleanup table or column ACL;
- all eight new callable boundary-routine definitions, kinds, security, volatility, search paths, owners, and direct ACLs;
- all six new trigger/private-helper definitions—including `plan6bii_assert_financial_admin_job_lease(uuid)` and `plan6bii_guard_financial_admin_job_lease()`—the changed audit/job guard definitions, and every new/replaced trigger definition including `jobs_plan6bii_financial_admin_lease_guard` before terminal sync;
- exact runtime/worker command-table privileges and the changed `jobs` table/column SELECT boundary;
- exact runtime and worker function EXECUTE sets; and
- the normalized canonical database-owner default-ACL tuple inventory from Task 3, including runtime future-table/sequence grants, owner grants, grantors/grantability, and absent `PUBLIC` routine execute; and
- no direct privilege for the configured application logins, storage-cleanup role/login, or PUBLIC, plus exact absence of application EXECUTE on both private lease functions.

Add reversible witness labels for wrong command enum order, either table's shape/owner/RLS/persistence, unexpected constraint/index/trigger/rule/inheritance, runtime private-input SELECT, runtime `jobs.payload` SELECT, any application claim-table privilege, worker private-input UPDATE, PUBLIC routine EXECUTE, application EXECUTE on a private helper, wrong routine/helper owner/security/search path, disabled or reordered lease/terminal trigger, claim capability-hash constraint drift, expiry/lifecycle constraint drift, generation/attempt constraint drift, job-guard drift, audit-guard drift, direct login ACL, and missing/excess worker/runtime EXECUTE. Default-ACL witnesses must separately cover missing runtime future-table SELECT; missing runtime future-sequence USAGE/SELECT/UPDATE; excess worker/storage/login/default grantee; reintroduced PUBLIC routine EXECUTE; namespace/object-type, owner, grantor, or grant-option drift; inherited runtime SELECT left on either new protected table; and inherited PUBLIC/runtime/worker execute left on either private helper. Add an unexpected `capability_token text` column witness so the exact descriptor rejects any schema capable of persisting the clear token.

The behavioral verifier uses the real one-row claim path for two normal and two expired final-attempt financial-admin jobs. Across four separate `claimNext` transactions it proves exactly one row changes per invocation, exactly four distinct capabilities and four distinct stored digests exist, every row has its correct independent generation/attempt, no digest is shared across jobs, and a token from one normal job fails against the other. A process-owned secret sentinel witness proves the database contains only its computed lowercase SHA-256 digest and exercises current renewal plus terminal invalidation. Owner-only corruption pairs alter the digest to invalid/uppercase form, expiry/lifecycle, generation/attempt relationship, trigger enabled mode, helper owner/security/search path, and a synthetic plaintext-token column/value; each must produce its exact single rejection key/count, repair to the source definition, and pass. Never print a clear capability or include it in calibration JSON, failure details, SQL comments, or the embedded manifest.

- [ ] **Step 2: Run the static catalog test and confirm RED**

```powershell
npx vitest run scripts/commerce-operations.test.ts -t "pins one versioned exact catalog contract" --reporter=verbose
npx vitest run scripts/database-role-deployment.test.ts scripts/with-plan6b-upgrade-database.test.ts scripts/deployment-checkpoint.test.ts scripts/deployment-checkpoint-runtime.test.ts scripts/deployment-backup-bundle.test.ts
```

Expected: FAIL on the stale v1 object/count/witness contract and missing 0012 upgrade/checkpoint assertions.

- [ ] **Step 3: Implement v2 actual-catalog branches with temporary invalid fingerprints**

For the historical Task 5 v2 contract through migration 0012, reuse the current normalized descriptor builders. Do not weaken table inventory, ACL grantor normalization, current-database CONNECT checks, forbidden retired objects, or cleanup-login authority. Add v2 rows for both tables, all eight callable routines, both private helpers, and all triggers with deliberately invalid zero/empty fingerprints only long enough for the static test to prove `invalid_contract_fingerprints > 0`; replace every invalid fingerprint before commit. Task 13 later advances this preserved inventory to v3 and adds only migration 0013's ninth correction-specific routine.

Keep the SQL marker block byte-identical in `scripts/verify-financial-restore.sql` and `docs/stripe-financial-reconciliation.md`.

- [ ] **Step 4: Calibrate exactly one disposable restored catalog**

From the worktree root, run the existing owner-role calibration path once:

```powershell
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$npmCli = Join-Path (Split-Path -Parent $nodePath) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw "Validated npm CLI not found: $npmCli" }
$hadNpmExecpath = Test-Path Env:npm_execpath
$previousNpmExecpath = $env:npm_execpath
$launcher = @'
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const provisionerUrl = pathToFileURL(
  resolve('src/lib/server/db/database-role-provision.ts')
).href;
const { databaseEnvironmentForRole } = await import(provisionerUrl);
const [verifierPath, ...args] = process.argv.slice(1);
const result = spawnSync(process.execPath, ['--import', 'tsx', verifierPath, ...args], {
  env: databaseEnvironmentForRole(process.env, 'owner'), stdio: 'inherit'
});
process.exit(result.status ?? 1);
'@
$calibrationLog = Join-Path ([IO.Path]::GetTempPath()) (
  "pale-orbit-plan6bii-catalog-v2-$([Guid]::NewGuid().ToString('N')).log"
)
$beginMarker = '[restore-verifier] BEGIN exact financial catalog calibration JSON'
$endMarker = '[restore-verifier] END exact financial catalog calibration JSON'
$calibrationPayload = $null
try {
  $env:npm_execpath = (Resolve-Path -LiteralPath $npmCli).Path
  & $nodePath --import tsx scripts/with-test-database.ts $nodePath --import tsx --input-type=module --eval $launcher scripts/execute-financial-restore-verifier.ts --print-financial-catalog-contract *> $calibrationLog
  $calibrationStatus = $LASTEXITCODE
  if ($calibrationStatus -ne 0) { throw "Catalog calibration failed with $calibrationStatus" }

  [string[]] $calibrationLines = Get-Content -LiteralPath $calibrationLog
  $beginMatches = @($calibrationLines | Where-Object { $_ -ceq $beginMarker })
  $endMatches = @($calibrationLines | Where-Object { $_ -ceq $endMarker })
  if ($beginMatches.Count -ne 1 -or $endMatches.Count -ne 1) {
    throw 'Catalog calibration must contain exactly one BEGIN and one END marker'
  }
  $beginIndex = [Array]::IndexOf($calibrationLines, $beginMarker)
  $endIndex = [Array]::IndexOf($calibrationLines, $endMarker)
  if ($endIndex -le ($beginIndex + 1)) { throw 'Catalog calibration payload is empty or misordered' }
  $calibrationPayload = $calibrationLines[($beginIndex + 1)..($endIndex - 1)] -join [Environment]::NewLine
} finally {
  if ($hadNpmExecpath) {
    $env:npm_execpath = $previousNpmExecpath
  } else {
    Remove-Item Env:npm_execpath -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $calibrationLog -Force -ErrorAction SilentlyContinue
}
```

Expected: one isolated project writes one bounded BEGIN/END catalog block containing unique non-null v2 descriptors and then self-cleans. The command retains only `$calibrationPayload`, restores the caller's exact `npm_execpath` state, removes its unique temporary log in `finally`, and leaves a zero temp-directory delta. Parse only that retained payload. Recompute every SHA-256 from its JSON and reject duplicate keys, sentinels, or truncation text; do not splice terminal output or another calibration into the manifest.

- [ ] **Step 5: Embed v2 fingerprints and add reversible witnesses**

Update both exact marker copies from the one retained `$calibrationPayload`. Extend the executor with corrupt -> expect exact rejection count/key -> repair -> expect pass pairs for every witness from Step 1. For 0012 table/check/function/trigger repair and source-parity checks, load and uniquely extract the reviewed definitions from `drizzle/0012_plan6bii_admin_command_authority.sql`; do not duplicate their bodies in TypeScript or reuse 0009-only extraction. Include the private table, helper definitions, trigger order/mode, and exact no-ACL state. Do not change an exact count to a prefix-only or positive-count assertion, and do not persist or print the clear capability while building any witness.

Update upgrade tests to apply 0000–0012, preserve rollback at each historical fixture, and verify a second pass is a no-op. Update checkpoint/bundle tests to require the copied v2 verifier and journal entry. `capture-restore-row-counts.sql` already inventories every base table; assert that property instead of adding a hand-maintained command-table row count.

- [ ] **Step 6: Run service-free proof and one bounded corruption harness**

```powershell
npx vitest run scripts/commerce-operations.test.ts -t "pins one versioned exact catalog contract|confines the executable verifier witness|times and scopes every verifier expectation|refuses ambiguous financial witness timeout cleanup targets|bounds financial witness process-tree termination|allows only inert fail-closed" --reporter=verbose
npx vitest run scripts/database-role-deployment.test.ts scripts/with-plan6b-upgrade-database.test.ts scripts/deployment-checkpoint.test.ts scripts/deployment-checkpoint-runtime.test.ts scripts/deployment-backup-bundle.test.ts
npm run check
npm run lint
npm run db:check
git diff --check
```

Then, under the serialized PostgreSQL slot:

```powershell
npx vitest run scripts/commerce-operations.test.ts -t "executes schema-object, source-parity, deterministic-allocation, audit, payout, and chronology verifier witnesses in PostgreSQL" --reporter=verbose
```

Expected: static suites pass; every command/claim/helper/trigger/ACL corruption is rejected under its exact key/count and repaired; the secret sentinel is never printed or persisted clear; the final verifier succeeds; the disposable project and temp delta are zero after cleanup.

- [ ] **Step 7: Commit the atomic authority/catalog boundary**

```powershell
git add src/lib/server/db/schema/financial-admin.ts src/lib/server/db/schema/financial-admin.test.ts src/lib/server/db/schema/index.ts drizzle/0012_plan6bii_admin_command_authority.sql drizzle/meta/0012_snapshot.json drizzle/meta/_journal.json src/lib/server/db/database-role-provision.ts src/lib/server/db/database-role-provision.test.ts src/lib/server/db/migrate.ts src/lib/server/db/migrate.test.ts src/migrate.ts compose.prod.yaml compose.dev.yaml scripts/database-role-deployment.test.ts scripts/financial-schema-preservation.test.ts scripts/process-secret-scope.test.ts scripts/test-environment.ts scripts/test-environment.test.ts scripts/with-test-database.ts scripts/with-test-database.test.ts tests/integration/financial-schema.test.ts tests/integration/financial-migration.test.ts tests/integration/database-role-boundaries.test.ts src/lib/server/jobs/types.ts src/lib/server/jobs/runner.ts src/lib/server/jobs/runner.test.ts src/lib/server/jobs/repository.ts src/lib/server/jobs/repository.test.ts src/lib/server/commerce/claims.ts src/lib/server/commerce/claims.test.ts src/lib/server/outbox/repository.ts src/lib/server/outbox/repository.test.ts src/lib/server/commerce/email/enqueue.ts src/lib/server/commerce/email/enqueue.test.ts src/lib/server/ingestion/job.ts src/lib/server/ingestion/job.test.ts src/lib/server/commerce/webhooks.ts src/lib/server/commerce/webhooks.test.ts scripts/verify-financial-restore.sql scripts/execute-financial-restore-verifier.ts scripts/commerce-operations.test.ts docs/stripe-financial-reconciliation.md docs/storage-ingestion-and-publication.md scripts/deployment-checkpoint.test.ts scripts/deployment-checkpoint-runtime.test.ts scripts/deployment-backup-bundle.test.ts scripts/with-plan6b-upgrade-database.test.ts
git diff --cached --check
git commit -m "feat: add financial administrator database authority"
```

Expected: migration 0012, provisioner parity, upgrade fixtures, and exact restore/catalog v2 are one commit. Now return to Task 4 and build/commit the transport against this landed authority before continuing to Task 6.

## Milestone B — read-only reporting

### Task 6: Build signed metrics and the Sales overview read model

**Files:**
- Create: `src/lib/server/commerce/reporting/metrics.ts`
- Create: `src/lib/server/commerce/reporting/metrics.test.ts`
- Create: `src/lib/server/commerce/reporting/review-authority.ts`
- Create: `src/lib/server/commerce/reporting/review-authority.test.ts`
- Create: `src/lib/server/commerce/reporting/overview.ts`
- Create: `src/lib/server/commerce/reporting/overview.test.ts`
- Create: `tests/integration/financial-reporting.test.ts`

**Approved implementation amendment discovered by the tax-exclusion RED:** allocation algorithm version 1 combines dispute-reinstatement subtotal and customer tax in one settlement item, so the exact Task 6 formula cannot be recovered in the read model. Before completing the reporting files, introduce allocation algorithm version 2 as a separate prerequisite commit. Preserve v1 replay behavior; in v2 allocate reinstatement settlement from the persisted withdrawal plan, map `dispute_subtotal` to positive `dispute_reinstatement`, keep positive `dispute_tax` separate, align same-currency component rounding across domains, reject unsupported/cross-version/malformed predecessors, target `c1-a2` through the existing replay activation flow, keep migration seed `c1-a1`, update exact restore/determinism evidence, and make reporting fail closed for legacy combined reinstatements. No schema migration is required.

- [ ] **Step 1: Write failing pure metric truth-table tests**

Require:

```ts
export function toSalesTitleMetricDto(
  input: SalesTitleMetricInput
): SalesTitleMetricDto;

export function summarizeCurrencyPairs(
  rows: readonly SalesTitleMetricDto[]
): readonly SalesCurrencySummaryDto[];
```

Cover sale subtotal, partial/full refund, processing/refund/dispute fees, dispute withdrawal, fee credit, partial/full reinstatement, and a negative payout estimate. DTO/storage signs remain canonical signed effects; display-only components may show reductions as magnitudes. State severity is `exception -> pending -> fee_reconciled -> payout_reconciled`; payout-reconciled requires every contributor.

When complete, assert the exact formula:

```text
estimated_payout_minor = settlement_sale_subtotal_effect_minor
  + refund_impact_minor
  + dispute_impact_minor
  + processing_fee_impact_minor
  + refund_fee_impact_minor
  + dispute_fee_impact_minor
  + other_fee_impact_minor
```

Customer sales tax is excluded; provider fee tax remains in the applicable fee impact. Each balance transaction's gross and fee sets contribute exactly once. Account-level adjustments never enter a title estimate.

If any money source is missing, conflicting, unresolved, or incompatible, every settlement component and estimate is `null`, `settlementMetricsComplete=false`, and `missingSourceCount` is exact. One incomplete contributing row nulls settlement totals for its whole currency-pair summary while presentment gross/refund/copy totals remain available.

- [ ] **Step 2: Write failing overview service and PostgreSQL tests**

Require:

```ts
export async function listSalesOverview(
  database: Database,
  actor: Actor,
  filters: SalesOverviewFilters,
  dependencies?: SalesOverviewDependencies
): Promise<SalesOverviewDto>;
```

`SalesOverviewDependencies` extends `FinancialAuthorizationDependencies`; production defaults to `capabilitiesForRoles`, while tests can remove only the capability under test.

Test authorization before query, paid-at UTC cohorts, title/sold-as format filters, stable `(titleId, presentmentCurrency, settlementCurrency)` grain, current display metadata plus immutable sold-as variants, sold/refunded/net copy rules, current base plus compatible correction tip, current payout state, FX separation, account-scope exclusion, equal-gross keyset pages without gaps, `pageSize + 1`, full-cohort summaries, and incomplete Charge/refund attribution nulling.

First create one composable `currentOperationalFinancialIssuePredicate()` SQL builder in `review-authority.ts`. It captures the active-classifier/current-source-fingerprint, raw active-pair allocation-tip, and current payout/source-generation authority described in Task 8. The global Overview Needs Review count uses that shared predicate; Task 8 must import the same builder rather than reimplementing it. The count does not imply the paid-at filters constrain issue history.

- [ ] **Step 3: Run focused tests and confirm RED**

```powershell
npx vitest run src/lib/server/commerce/reporting/metrics.test.ts src/lib/server/commerce/reporting/review-authority.test.ts src/lib/server/commerce/reporting/overview.test.ts
npm run test:integration -- tests/integration/financial-reporting.test.ts
```

Expected: FAIL because the metric and overview services do not exist.

- [ ] **Step 4: Implement bounded SQL composition**

Build page, summary, and later CSV queries directly over immutable order/item snapshots plus `currentFinancialProjectionHeads` and `currentFinancialProjectionItems`. Drive completeness from heads and left-join items; a missing item projection is unavailable, never zero and never a dropped row. Build the global review count from the new shared authority predicate in a separate bounded query. Do not loop through `loadCurrentEffectiveAllocationProjection`, materialize an unbounded balance-transaction ID array, duplicate current projection selection, or call Stripe.

`dataThroughAt` is the minimum completion time across the latest successful source, payout, and current composite classifier+allocation replay phases. It is `null` if any required phase has never completed. Return only explicit DTO construction; no database row crosses the service boundary.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx vitest run src/lib/server/commerce/reporting/metrics.test.ts src/lib/server/commerce/reporting/review-authority.test.ts src/lib/server/commerce/reporting/overview.test.ts
npm run test:integration -- tests/integration/financial-reporting.test.ts
npm run check
npm run lint
git diff --check
git add src/lib/server/commerce/reporting/metrics.ts src/lib/server/commerce/reporting/metrics.test.ts src/lib/server/commerce/reporting/review-authority.ts src/lib/server/commerce/reporting/review-authority.test.ts src/lib/server/commerce/reporting/overview.ts src/lib/server/commerce/reporting/overview.test.ts tests/integration/financial-reporting.test.ts
git diff --cached --check
git commit -m "feat: add signed sales reporting"
```

Expected: all commands exit zero; summary and page formulas agree and privacy key tests pass.

### Task 7: Add the Sales route shell and accessible overview UI without enabling navigation

**Files:**
- Create: `src/routes/admin/sales/+layout.svelte`
- Create: `src/routes/admin/sales/+layout.server.ts`
- Create: `src/routes/admin/sales/sales.css`
- Create: `src/routes/admin/sales/+page.server.ts`
- Create: `src/routes/admin/sales/+page.svelte`
- Create: `src/lib/components/admin/SalesFilters.svelte`
- Create: `src/lib/components/admin/SalesSummaryCards.svelte`
- Create: `src/lib/components/admin/SalesTable.svelte`
- Create: `src/lib/components/admin/FinancialAmount.svelte`
- Create: `src/routes/admin/sales/sales-routes.test.ts`
- Create: `src/lib/components/admin/SalesOverview.test.ts`
- Modify: `src/lib/server/commerce/reporting/filters.ts`
- Modify: `src/lib/server/commerce/reporting/filters.test.ts`
- Modify: `src/app.css`

- [ ] **Step 1: Write failing route tests**

Prove the Sales layout and Overview loader require `sales.read` before reading params/query or calling the service. Cover anonymous/customer denial, a mocked administrator missing `sales.read`, malformed filters/cursors as 400, blank optional controls from an unhydrated native GET form as omitted, safe unavailable states, normalized filters, stable next/back/filter URLs without duplicate parameters, and the exact `SalesOverviewDto` return shape. Blank required/default controls, duplicates, unknowns, and malformed nonblank values remain invalid. Overview is an unaudited list read, carries no request-correlation context, and has no action.

- [ ] **Step 2: Write failing component and accessibility tests**

Render and assert:

- one `<h1>` and a semantic filter `<form>` with native labeled controls;
- local Sales navigation for Overview, Needs Review, and Payouts with current-page state;
- currency-pair summary groups with no converted/mixed grand total;
- a captioned table with scoped headers and text state labels;
- title/creator/format, sold/refunded/net copies, presentment gross/refund/dispute values, nullable signed settlement components, estimated payout, both currencies, state, missing count, and freshness;
- a named keyboard-focusable overflow region and semantic narrow-screen fallback;
- empty/no-results/pending/Stripe-disabled/incomplete/exception/fee-reconciled/payout-reconciled states, plus the exact data-through timestamp without inventing a stale threshold or the manual/instant payout-mode evidence reserved for Task 9;
- exact copy `Settlement estimate unavailable`, `Estimated payout`, `Fee reconciled`, `Payout reconciled`, and `Needs review`; and
- live result status, alert semantics, visible focus, reduced motion, long-title/large-negative resilience, and no color-only meaning.

- [ ] **Step 3: Run focused tests and confirm RED**

```powershell
npx vitest run src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts
```

Expected: FAIL because the route shell and components do not exist.

- [ ] **Step 4: Implement thin loaders and presentation components**

The loader must be equivalent to:

```ts
requireCapability(event.locals.actor, 'sales.read');
const filters = parseSalesOverviewFilters(event.url, new Date());
return listSalesOverview(getDatabaseClient().db, event.locals.actor, filters);
```

Use the existing admin shell. Keep the top-level `Sales — Upcoming` item disabled in `src/routes/admin/+layout.svelte`; direct test navigation is allowed, but enabling the product navigation is reserved for Task 17 after final clearance.

Show settlement totals only when the entire currency-pair cohort is complete. Use `FinancialAmount.svelte` for every signed/unavailable value and display the ISO code adjacent to locale formatting. Do not add charts.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx vitest run src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts src/routes/admin/audit/audit-routes.test.ts src/routes/admin/catalog/catalog-routes.test.ts
npm run check
npm run lint
git diff --check
git add src/routes/admin/sales/+layout.svelte src/routes/admin/sales/+layout.server.ts src/routes/admin/sales/sales.css src/routes/admin/sales/+page.server.ts src/routes/admin/sales/+page.svelte src/lib/components/admin/SalesFilters.svelte src/lib/components/admin/SalesSummaryCards.svelte src/lib/components/admin/SalesTable.svelte src/lib/components/admin/FinancialAmount.svelte src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts src/lib/server/commerce/reporting/filters.ts src/lib/server/commerce/reporting/filters.test.ts src/app.css
git diff --cached --check
git commit -m "feat: add admin sales overview"
```

Expected: all commands exit zero and existing admin/catalog/audit navigation remains green.

### Task 8: Add operational Needs Review and audited safe issue detail

**Files:**
- Create: `src/lib/server/commerce/reporting/review.ts`
- Create: `src/lib/server/commerce/reporting/review.test.ts`
- Create: `tests/integration/financial-review.test.ts`
- Create: `src/routes/admin/sales/review/+page.server.ts`
- Create: `src/routes/admin/sales/review/+page.svelte`
- Create: `src/routes/admin/sales/review/[issueId]/+page.server.ts`
- Create: `src/routes/admin/sales/review/[issueId]/+page.svelte`
- Create: `src/lib/components/admin/ReviewQueue.svelte`
- Modify: `src/routes/admin/sales/sales-routes.test.ts`
- Modify: `src/lib/components/admin/SalesOverview.test.ts`
- Modify: `src/routes/admin/sales/sales.css`

- [ ] **Step 1: Write failing operational-queue tests**

Require:

```ts
export async function listFinancialIssues(
  database: Database,
  actor: Actor,
  input: FinancialIssueListInput,
  dependencies?: FinancialAuthorizationDependencies
): Promise<FinancialIssueListDto>;

export async function getFinancialIssueDetail(
  database: Database,
  actor: Actor,
  issueId: string,
  context: FinancialRequestContext,
  dependencies?: FinancialAuthorizationDependencies
): Promise<FinancialIssueDetailDto | null>;
```

The queue is not `where state = 'open'`. It imports the already-tested `currentOperationalFinancialIssuePredicate()` from Task 6 and includes:

1. classification issues only for the active classifier version and current source fingerprint;
2. allocation-set issues only for current raw active-pair tips, without trusting a projection-head base pointer that an issue may null;
3. current payout/source issues with the existing active-generation authority; and
4. actionable ambiguous refunds ordered before safe read-only issues.

Retired-classifier `unsupported_category` remains open immutable history but is absent from the current operational queue. Task 8 accepts only an optional strict `cursor`; the normalized filter set is therefore fixed and empty. Use stable ascending keyset order `actionabilityRank -> impactRank -> firstObservedAt -> issueId`, where actionability ranks `refund_allocation_review = 0`, `wait_for_recovery = 1`, `read_only = 2` and impact ranks `exception = 0`, `pending = 1`, `informational = 2`. The opaque cursor carries a separately validated exact six-digit UTC PostgreSQL `firstObservedAt` order key and binds it back as `timestamptz`; the browser DTO may retain its ordinary millisecond ISO display timestamp. Use page size 50 and bind the cursor to that fixed normalized filter contract. The PostgreSQL witness must use non-millisecond timestamps and cross an actionability/impact page boundary so truncation cannot duplicate or loop a page.

- [ ] **Step 2: Write failing audited-detail route/component tests**

Detail begins a web transaction, acquires the global administrator-role lock, reloads current roles, reauthorizes `sales.read`, builds the complete safe DTO, then calls `auditFinancialIssueDetailRead` inside the same transaction before returning. Audit failure returns no successful detail. DTO fields are internal issue/resource IDs, safe code/impact/state, timestamps/count, actionability, and a named internal workflow link only; request correlation remains audit-only and is not returned in the browser DTO. The existing audit client intentionally validates the browser route and translates it to migration 0012's legacy `/admin/sales/issues/{id}` routine argument; Task 8 uses that client unchanged rather than inventing new database authority.

Test authorization before query/path parsing, malformed/inaccessible/missing IDs as safe 404, preserved bounded return context, semantic queue/detail labels, empty state, and no generic Resolve/provider Retry control. Only an actionable ambiguous-refund issue links to its refund workflow. Force an invalid fixed audit context after DTO construction in the PostgreSQL witness and prove rejection returns no detail and appends no audit.

- [ ] **Step 3: Run focused tests and confirm RED**

```powershell
npx vitest run src/lib/server/commerce/reporting/review.test.ts src/routes/admin/sales/sales-routes.test.ts
npm run test:integration -- tests/integration/financial-review.test.ts
```

Expected: FAIL because the operational predicate, safe detail, routes, and audit call do not exist.

- [ ] **Step 4: Implement local-only list/detail queries**

Use only current PostgreSQL financial state. Do not call Stripe, expose provider identifiers/messages/evidence, mutate issue state, or infer actionability from a generic open flag. List/filter is unaudited. Detail audit metadata is fixed by the typed routine and contains no arbitrary JSON.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx vitest run src/lib/server/commerce/reporting/review.test.ts src/routes/admin/sales/sales-routes.test.ts
npm run test:integration -- tests/integration/financial-review.test.ts
npm run check
npm run lint
git diff --check
git add src/lib/server/commerce/reporting/review.ts src/lib/server/commerce/reporting/review.test.ts tests/integration/financial-review.test.ts src/routes/admin/sales/review src/lib/components/admin/ReviewQueue.svelte src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts src/routes/admin/sales/sales.css
git diff --cached --check
git commit -m "feat: add operational financial review"
```

### Task 9: Add local-only payout list and audited detail

**Files:**
- Create: `src/lib/server/commerce/reporting/payouts.ts`
- Create: `src/lib/server/commerce/reporting/payouts.test.ts`
- Create: `tests/integration/financial-payout-reporting.test.ts`
- Create: `src/routes/admin/sales/payouts/+page.server.ts`
- Create: `src/routes/admin/sales/payouts/+page.svelte`
- Create: `src/routes/admin/sales/payouts/[payoutId]/+page.server.ts`
- Create: `src/routes/admin/sales/payouts/[payoutId]/+page.svelte`
- Create: `src/lib/components/admin/PayoutTable.svelte`
- Modify: `src/routes/admin/sales/sales-routes.test.ts`
- Modify: `src/lib/components/admin/SalesOverview.test.ts`

- [ ] **Step 1: Write failing payout service tests**

Require:

```ts
export async function listPayouts(
  database: Database,
  actor: Actor,
  input: PayoutListInput,
  dependencies?: FinancialAuthorizationDependencies
): Promise<PayoutListDto>;

export async function getPayoutDetail(
  database: Database,
  actor: Actor,
  payoutId: string,
  context: FinancialRequestContext,
  dependencies?: FinancialAuthorizationDependencies
): Promise<PayoutDetailDto | null>;
```

Use fixed page size 50 and keyset order `providerCreatedAt desc -> internal payoutId desc`. Return internal ID, automatic/manual, standard/instant/unknown, current/reconciliation status, signed amount/currency, created/arrival/settlement labels, associated count, bookstore-linked subtotal, account-level adjustment count/amount when complete, safe failure code, current freshness/generation, and historical-membership notice. Never return provider payout/balance-transaction/source IDs.

Cover automatic completed paid, pending, manual, instant, failed/canceled/reversed with retained history, unrelated member and nonmember activity, an automatic-standard incomplete import run, and current generation change. PostgreSQL witnesses must include signed refund, refund-failure, dispute-withdrawal, and dispute-reinstatement components; algorithm-v2 reinstatement with its tax excluded from the linked subtotal; algorithm-v1 reinstatement, a missing current head, and an incomplete current head failing closed; and both valid and mismatched failure/reciprocal reversal evidence. Never claim that the bookstore-linked subtotal equals the full payout.

The payout cursor is a bounded canonical unpadded-base64url envelope containing the exact six-digit UTC `providerCreatedAt` SQL value plus the internal payout UUID; the display timestamp remains millisecond ISO. Select the target cohort first: fetch at most 51 `stripe_payouts` rows using descending order and tuple predicate `(provider_created_at, id) < (cursor timestamp, cursor UUID)`, then constrain all run, membership, current-head/item, issue, and reversal CTE work to that cohort. Detail uses the same shape with a one-payout target cohort. Do not compute unbounded evidence and apply the page limit afterward. Prove non-millisecond equal-timestamp boundaries have no gaps or duplicates. A published run's certified generation is `run.generation + 1` for the original immutable membership publication (including a zero-candidate first published run) and `run.generation` for a later exact recertification; membership is current only when that value equals the payout financial generation and the paid/completed/non-reversed facts remain current.

Fail closed to the unavailable DTO branch unless every immutable member has exactly one complete current gross head and one complete current fee head in payout currency with compatible current projection evidence. Sum title-scoped non-tax gross sale/refund/dispute components plus algorithm-v2 tax-safe dispute reinstatement as the bookstore-linked subtotal; sum title-scoped fee components as fee impact and derive linked net only from those two values. Count an account-scoped adjustment once per member balance transaction and sum its signed gross-plus-fee head effects, never a payout-total delta. Manual, instant, unknown-method, unpublished, and incomplete membership remains unavailable.

`reversalState` is `incomplete` when a failed/canceled payout lacks exact linked failure evidence or a `reversed_by` reference lacks an exact reciprocal local reversal payout; it is `reversed` when the declared evidence is exact, otherwise `none`. Exact failure evidence must match the referenced internal balance-transaction ID, `live_mode`, payout currency, `source_family='payout'`, `source_id=payout.provider_id`, and canonical `raw_type='payout_failure'`, `reporting_category='payout'`, and `balance_type='payments'`. Exact reciprocal evidence must match both provider references (`reversed_by` and reciprocal `original`) plus `live_mode` and currency. A mismatched declared link is incomplete and contributes neither amount nor freshness. For failed/canceled payouts, `reversalAmountMinor` is the signed exact failure balance-transaction amount; otherwise it is the exact reciprocal reversal payout amount. The strict detail DTO requires `reversalState === 'reversed'` if and only if `reversalAmountMinor` is non-null. `freshnessAt` is the maximum of payout retrieval, certified run/membership publication, member import, and current allocation/correction evidence actually used; unavailable modes use payout retrieval unless later exact reversal evidence exists. Detail back links preserve only a validated payout cursor.

- [ ] **Step 2: Write failing route/component and audit tests**

List requires `sales.read` before cursor parsing and is not audited. Detail begins a web transaction, acquires the global administrator-role lock, reloads current roles, reauthorizes `sales.read`, builds its complete safe DTO, then calls `auditFinancialPayoutDetailRead` before commit. Require exact copy `Fee reconciled — exact payout membership unavailable` for manual/instant cases, text-only states, signed/currency-explicit values, semantic table/detail lists, bounded filter-aware back links, and no sync/retry button.

- [ ] **Step 3: Run RED, implement, then run GREEN**

```powershell
npx vitest run src/lib/server/commerce/reporting/payouts.test.ts src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts
npm run test:integration -- tests/integration/financial-payout-reporting.test.ts
```

Expected before implementation: FAIL because payout reporting does not exist.

Query only local payout/run/membership/ledger/allocation state. Missing/inaccessible IDs return safe 404 without leaking provider existence. Then run:

```powershell
npx vitest run src/lib/server/commerce/reporting/payouts.test.ts src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts
npm run test:integration -- tests/integration/financial-payout-reporting.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 4: Commit payout reporting**

```powershell
git add src/lib/server/commerce/reporting/payouts.ts src/lib/server/commerce/reporting/payouts.test.ts tests/integration/financial-payout-reporting.test.ts src/routes/admin/sales/payouts src/lib/components/admin/PayoutTable.svelte src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts
git diff --cached --check
git commit -m "feat: add financial payout reporting"
```

### Task 10: Export the full filtered aggregate as bounded audited CSV

**Files:**
- Create: `src/lib/server/commerce/reporting/csv.ts`
- Create: `src/lib/server/commerce/reporting/csv.test.ts`
- Modify: `src/lib/server/commerce/reporting/overview.ts`
- Modify: `src/lib/server/commerce/reporting/overview.test.ts`
- Create: `tests/integration/financial-audit-export.test.ts`
- Create: `src/routes/admin/sales/export.csv/+server.ts`
- Modify: `src/routes/admin/sales/+page.server.ts`
- Modify: `src/routes/admin/sales/+page.svelte`
- Modify: `src/lib/components/admin/SalesFilters.svelte`
- Modify: `src/lib/components/admin/SalesOverview.test.ts`
- Modify: `src/routes/admin/sales/sales-routes.test.ts`

- [ ] **Step 1: Write failing cell-security and serialization tests**

Require:

```ts
export const SALES_CSV_MAX_ROWS = 10_000;
export const SALES_CSV_MAX_BYTES = 10 * 1024 * 1024;
export const SALES_CSV_DEADLINE_MS = 25_000;

export function neutralizeCsvText(value: string): string;
export function serializeSalesCsv(rows: readonly SalesCsvRow[]): Uint8Array;
```

Neutralization is exact: prefix one apostrophe when character zero is tab/CR/LF; otherwise skip ASCII spaces only and prefix when the next character is `=`, `+`, `-`, `@`, tab, CR, or LF. Then apply RFC 4180 quoting and quote doubling. Use CRLF rows, one final CRLF, and no BOM. Apply neutralization only to text-origin cells; validated signed integer cells remain numeric.

- [ ] **Step 2: Write failing service/route/audit tests**

Require:

```ts
export async function exportSalesCsv(
  database: Database,
  actor: Actor,
  filters: SalesOverviewFilters,
  context: FinancialRequestContext,
  dependencies?: FinancialAuthorizationDependencies
): Promise<{ readonly bytes: Uint8Array; readonly filename: string; readonly rowCount: number }>;
```

Both route and service require `sales.read` plus `sales.export` before parsing/querying. Inside the bounded web transaction, acquire the global administrator-role lock, reload roles, and reauthorize both capabilities before querying. Remove the Overview cursor and export the complete normalized filter cohort in the same deterministic order/formulas. The SQL itself requests at most `SALES_CSV_MAX_ROWS + 1`; the sentinel row rejects an oversized cohort before serialization. Set a transaction-local `statement_timeout` from the remaining deadline and recheck the monotonic deadline between phases. Build all bytes inside the authorized transaction, then call `auditFinancialExportCompleted` with only filter fingerprint, row/byte/currency-pair counts, and correlation/request metadata. A row, byte, deadline, query, serialization, or audit failure returns no partial bytes and no successful audit.

The Overview loader returns an explicit `canExport` derived through the same injectable capability resolver. `SalesFilters.svelte` renders a keyboard-focusable, plainly named `Export filtered CSV` link only when `canExport` is true. Its URL preserves every normalized noncursor Overview filter, omits the cursor and unknown/duplicate keys, and targets the GET export endpoint; the endpoint and service still reauthorize independently, so hiding the control is not the security boundary.

Keep the fixed columns from the August 11 design: internal title ID; current display/archive state; sold-as variants; format; presentment/settlement currencies; sold/refunded/net copies; presentment gross/refund/dispute values; nullable signed settlement components; estimate; completeness/missing count/state; UTC range; data-through timestamp. Incomplete settlement cells are blank, never zero.

Require headers:

```text
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="pale-orbit-sales-<from>-<to>.csv"
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

All-time filename is `pale-orbit-sales-all-time.csv`.

- [ ] **Step 3: Run focused tests and confirm RED**

```powershell
npx vitest run src/lib/server/commerce/reporting/csv.test.ts src/lib/server/commerce/reporting/overview.test.ts src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts
npm run test:integration -- tests/integration/financial-audit-export.test.ts tests/integration/financial-reporting.test.ts
```

Expected: FAIL because CSV service/route do not exist.

- [ ] **Step 4: Implement a bounded byte accumulator over the shared aggregate query**

Factor the unpaginated aggregate from `overview.ts`; do not concatenate page results or accept cursor as a data boundary. Add the capability-aware export control without putting CSV bytes in the page loader. Check the byte cap before every append and the deadline before every database/serialization phase. Exclude identity, provider IDs, issue evidence, raw objects, audit metadata, command data, and operational links.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx vitest run src/lib/server/commerce/reporting/csv.test.ts src/lib/server/commerce/reporting/overview.test.ts src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts
npm run test:integration -- tests/integration/financial-audit-export.test.ts tests/integration/financial-reporting.test.ts
npm run check
npm run lint
git diff --check
git add src/lib/server/commerce/reporting/csv.ts src/lib/server/commerce/reporting/csv.test.ts src/lib/server/commerce/reporting/overview.ts src/lib/server/commerce/reporting/overview.test.ts tests/integration/financial-audit-export.test.ts src/routes/admin/sales/export.csv/+server.ts src/routes/admin/sales/+page.server.ts src/routes/admin/sales/+page.svelte src/lib/components/admin/SalesFilters.svelte src/lib/components/admin/SalesOverview.test.ts src/routes/admin/sales/sales-routes.test.ts
git diff --cached --check
git commit -m "feat: export audited sales reports"
```

Expected: CSV and Overview match for rows/totals/order, negative numeric cells remain numeric, and all commands pass.

## Milestone C — resolution and release

### Task 11: Add audited refund detail and worker-executed shared draft commands

**Files:**
- Create: `src/lib/server/commerce/financial/refund-review/inputs.ts`
- Create: `src/lib/server/commerce/financial/refund-review/inputs.test.ts`
- Create: `src/lib/server/commerce/financial/refund-review/query.ts`
- Create: `src/lib/server/commerce/financial/refund-review/query.test.ts`
- Create: `src/lib/server/commerce/financial/refund-review/drafts.ts`
- Create: `src/lib/server/commerce/financial/refund-review/drafts.test.ts`
- Modify: `src/lib/server/commerce/financial/admin-commands/handler.test.ts`
- Modify: `src/lib/server/commerce/financial/admin-commands/repository.ts`
- Modify: `src/lib/server/commerce/financial/admin-commands/repository.test.ts`
- Create: `tests/integration/financial-refund-review.test.ts`
- Modify: `src/routes/admin/sales/route-support.ts`
- Modify: `src/routes/admin/sales/route-support.test.ts`
- Create: `src/routes/admin/sales/refunds/[refundId]/+page.server.ts`
- Create: `src/routes/admin/sales/refunds/[refundId]/+page.svelte`
- Create: `src/routes/admin/sales/refunds/refund-routes.test.ts`
- Create: `src/lib/components/admin/RefundAllocationEditor.svelte`
- Create: `src/lib/components/admin/FinancialCommandStatus.svelte`
- Create: `src/lib/components/admin/financial-command-status.ts`
- Create: `src/lib/components/admin/financial-command-status.test.ts`
- Create: `src/lib/components/admin/FinancialActionOutcome.svelte`
- Create: `src/lib/components/admin/RefundReview.test.ts`

- [ ] **Step 1: Write failing safe-detail and domain-input tests**

Require:

```ts
export async function getRefundReviewDetail(
  database: Database,
  actor: Actor,
  refundId: string,
  context: FinancialRequestContext,
  dependencies?: FinancialAuthorizationDependencies
): Promise<RefundReviewDetailDto | null>;

export async function executeRefundDraftSave(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, { kind: 'refund_draft_save' }>
): Promise<FinancialAdminCommandSafeResultByCode['draft_saved']>;

export async function executeRefundDraftDiscard(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, { kind: 'refund_draft_discard' }>
): Promise<FinancialAdminCommandSafeResultByCode['draft_discarded']>;
```

Detail begins a web transaction, acquires the global administrator-role lock, reloads current roles, and reauthorizes `sales.read` before any domain query. It returns refund total/currency, sold-as item facts, paid subtotal/tax/total, finalized allocations/components, remaining capacities, shared draft/version, safe last-editor display label/timestamps, financial completeness, and preview inputs. It exposes no customer/user/email/provider ID, raw administrator ID, or request correlation ID. Complete DTO generation precedes `auditFinancialRefundDetailRead` and commit in that same transaction.

- [ ] **Step 2: Write failing draft transaction and authority tests**

The worker executor receives the already authorized/locked command context. It must:

1. discover the refund's payment/order without locks;
2. acquire order advisory -> order -> payment;
3. call `lockPaymentPurchaseFacts` for the complete purchase graph;
4. re-read the target refund, active draft, and draft items;
5. compare `expectedVersion`/`expectedActiveDraftVersion`;
6. validate 1–25 submitted items belong to the order and exact totals/capacities;
7. upsert one complete snapshot and set omitted existing order-item rows to zero—never delete;
8. increment an active draft version exactly once for a changed save/discard;
9. append `financial.refund_draft.created|updated|discarded` as the submitting user; and
10. return an allowlisted `{ refundId, draftVersion, changed }` result.

An identical save is a terminal succeeded no-op with `changed=false`, no draft version change, and no domain mutation audit. Draft work never acquires projection authority, changes financial evidence/projection, resolves an issue, changes grants/entitlement, or queues email.

Test same-refund shared visibility, create/edit/no-op/discard, two-admin conflict, graph change, command replay, execution-time demotion, forced audit rollback, and direct web DML denial.

- [ ] **Step 3: Write failing async route/component tests**

Routes authorize `sales.read` plus `reconciliation.manage` before parsing. `saveDraft` and `discardDraft` generate/reuse a canonical idempotency UUID for the explicit submission, call only `submitFinancialAdminCommand`, return its safe actual-status reference, and never call worker/domain functions.

`FinancialCommandStatus.svelte` polls `/admin/sales/commands/[commandId]` with bounded backoff only when the receipt is pending, aborts on navigation/unmount, stops on a terminal state, announces progress/result through a live region, and reloads current facts after success/conflict. A terminal replay receipt performs one protected status read and never resubmits. Non-JavaScript submission renders the safe reference/status and a reload link.

Test same-origin native forms, safe 400/404/409 mapping, bounded return context, field-linked total/item errors, keyboard editing, shared conflict reload, pending/terminal announcements, and absence of `window.confirm`.

- [ ] **Step 4: Run focused tests and confirm RED**

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/query.test.ts src/lib/server/commerce/financial/refund-review/drafts.test.ts src/lib/server/commerce/financial/admin-commands/handler.test.ts src/lib/server/commerce/financial/admin-commands/repository.test.ts src/routes/admin/sales/route-support.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/financial-command-status.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-refund-review.test.ts tests/integration/database-role-boundaries.test.ts
```

Expected: FAIL because the safe detail, draft executors, routes, and progress UI do not exist.

- [ ] **Step 5: Implement only the two draft executor functions**

Do not mutate or export a partial registry. Handler tests call the Task 4 six-dependency builder with these two real functions and four test-local throwing stubs. Do not give routes the worker database or import these executors from route modules. The production job remains unregistered until Task 14 can bind all six concrete functions in `worker.ts`.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/query.test.ts src/lib/server/commerce/financial/refund-review/drafts.test.ts src/lib/server/commerce/financial/admin-commands/handler.test.ts src/lib/server/commerce/financial/admin-commands/repository.test.ts src/routes/admin/sales/route-support.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/financial-command-status.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-refund-review.test.ts tests/integration/database-role-boundaries.test.ts
npm run check
npm run lint
git diff --check
git add src/lib/server/commerce/financial/refund-review/inputs.ts src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/query.ts src/lib/server/commerce/financial/refund-review/query.test.ts src/lib/server/commerce/financial/refund-review/drafts.ts src/lib/server/commerce/financial/refund-review/drafts.test.ts src/lib/server/commerce/financial/admin-commands/handler.test.ts src/lib/server/commerce/financial/admin-commands/repository.ts src/lib/server/commerce/financial/admin-commands/repository.test.ts tests/integration/financial-refund-review.test.ts src/routes/admin/sales/route-support.ts src/routes/admin/sales/route-support.test.ts src/routes/admin/sales/refunds src/lib/components/admin/RefundAllocationEditor.svelte src/lib/components/admin/FinancialCommandStatus.svelte src/lib/components/admin/financial-command-status.ts src/lib/components/admin/financial-command-status.test.ts src/lib/components/admin/FinancialActionOutcome.svelte src/lib/components/admin/RefundReview.test.ts
git diff --cached --check
git commit -m "feat: add shared refund draft commands"
```

Expected: all commands pass; web submission and worker mutation authority remain separated.

### Task 12: Finalize ambiguous refunds with canonical projection and access effects

**Files:**
- Create: `src/lib/server/commerce/refund-access.ts`
- Create: `src/lib/server/commerce/refund-access.test.ts`
- Create: `src/lib/server/commerce/refund-allocation-components.ts`
- Create: `src/lib/server/commerce/refund-allocation-components.test.ts`
- Create: `src/lib/server/commerce/financial/refund-review/finalize.ts`
- Create: `src/lib/server/commerce/financial/refund-review/finalize.test.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/inputs.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/inputs.test.ts`
- Modify: `src/lib/server/commerce/financial/admin-commands/handler.ts`
- Modify: `src/lib/server/commerce/financial/admin-commands/handler.test.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/drafts.test.ts`
- Modify: `src/lib/server/commerce/refunds.ts`
- Modify: `src/lib/server/commerce/refunds.test.ts`
- Modify: `src/lib/server/commerce/reconciliation.ts`
- Modify: `src/lib/server/commerce/financial/sources/refund.ts`
- Modify: `src/lib/server/commerce/financial/sources/refund.test.ts`
- Modify: `src/lib/server/commerce/financial/issues.ts`
- Modify: `src/lib/server/commerce/financial/issues.test.ts`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.server.ts`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.svelte`
- Modify: `src/routes/admin/sales/refunds/refund-routes.test.ts`
- Modify: `src/lib/components/admin/RefundAllocationEditor.svelte`
- Create: `src/lib/components/admin/FinancialActionConfirmation.svelte`
- Modify: `src/lib/components/admin/RefundReview.test.ts`
- Modify: `tests/integration/financial-admin-commands.test.ts`
- Modify: `tests/integration/financial-refund-review.test.ts`
- Modify: `tests/integration/commerce-lock-order.test.ts`
- Modify: `tests/integration/financial-lock-order.test.ts`

- [ ] **Step 1: Write failing preview/fingerprint tests**

Require:

```ts
export async function previewRefundFinalization(
  database: Database,
  actor: Actor,
  input: { readonly refundId: string; readonly expectedActiveDraftVersion: number },
  context: FinancialRequestContext,
  dependencies?: FinancialAuthorizationDependencies
): Promise<RefundFinalizationPreviewDto>;

export async function executeRefundAllocationFinalize(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, { kind: 'refund_allocation_finalize' }>
): Promise<FinancialAdminCommandSafeResultByCode['allocation_finalized']>;
```

Add one required, transaction-bound access-message capability to the executor context. `createFinancialAdminCommandHandler` receives an `accessMessages` dependency beside `database` and `executors`, exposes only `enqueueAccessChange(input)` to executors, and binds the current command transaction internally. Do not inject the full commerce message enqueuer, make the dependency optional, add a seventh executor-builder function, create an enqueuer in the domain module, or open a second transaction. Task 12 uses the existing refund access-change message; Task 14 extends the same narrow input union for recovery and supplies the existing production enqueuer when it registers all six executors.

Preview reports each safe item proposal, derived subtotal/tax split, full-refund outcome, purchase-grant transition, other-grant access preservation, and expected access email without user/email identity. Its fingerprint covers refund/payment/order/items, current allocations/components, active draft ID/version/items, active projection implementation, current source/correction tips, and current grant states.

- [ ] **Step 2: Extract existing access and allocation planners under characterization tests**

Move provider-neutral purchase-grant recomputation from `refunds.ts` into `refund-access.ts` without changing ordinary refund behavior. Preserve the current payment/refund/dispute/claim/preserved transition checks byte-for-byte. Do not add an `administrative-recovery` origin or modify `grants.ts` here; Task 14 owns the one complete origin-matrix change together with its protected transition routine and tests.

Split entitlement locking from `lockPaymentAccessFacts` without changing that existing wrapper. Add a late helper that accepts already locked `PaymentPurchaseFacts`, discovers and validates the exact purchase grants, acquires every affected user/title scope advisory in canonical order, locks the global union of purchase and other affected-scope grants by grant ID, and revalidates purchase provenance after locking. Finalization calls `lockPaymentPurchaseFacts` before projection enrollment and financial closure, then calls the late entitlement helper; it never calls `lockPaymentAccessFacts`, locks a purchase grant before its scope, locks scopes piecemeal, or locks the purchase graph twice.

Also move the private `planRefundAllocationComponents` algorithm from `refunds.ts` into `refund-allocation-components.ts` and make both ordinary refund handling and administrator finalization call the same pure planner. Characterize largest-remainder tie-breaking, subtotal/tax capacity, currency handling, and signed component totals before extraction; do not copy the formula into `finalize.ts`.

Refactor the current refund financial recompute implementation behind two explicit wrappers over one shared locked core:

```ts
recomputeLockedRefundFinancialProjection(/* existing ordinary signature */);
recomputeLockedRefundFinancialProjectionForAdminCommand(
  transaction,
  lockedInput,
  lockedAndRevalidatedOrdinarySelectedSetIds,
  commandId
);
```

The existing wrapper keeps its exact system-resolution behavior. The administrator wrapper does not call the system resolver; after recomputation it calls the command-bound resolver once for every exact allowlisted satisfied refund or selected-set issue linked to the locked command scope, in canonical issue-ID order, so administrator attribution is not lost. It leaves retired `unsupported_category` history open.

- [ ] **Step 3: Verify and commit the pure planner/access extraction**

Before creating either new module test, add the extraction characterization cases to the existing `refunds.test.ts` and run that pre-existing file GREEN. Then create the two focused module tests while performing only the extraction, and run all three:

```powershell
npx vitest run src/lib/server/commerce/refunds.test.ts
# After the extraction and new module tests exist:
npx vitest run src/lib/server/commerce/refund-access.test.ts src/lib/server/commerce/refund-allocation-components.test.ts src/lib/server/commerce/refunds.test.ts
git diff --check
git add src/lib/server/commerce/refund-access.ts src/lib/server/commerce/refund-access.test.ts src/lib/server/commerce/refund-allocation-components.ts src/lib/server/commerce/refund-allocation-components.test.ts src/lib/server/commerce/refunds.ts src/lib/server/commerce/refunds.test.ts
git diff --cached --check
git commit -m "refactor: share refund access and component planning"
```

Expected: characterization remains green before and after the move; ordinary refund behavior has no semantic diff.

- [ ] **Step 4: Add the administrator recompute seam under RED -> GREEN**

First add failing tests for multiple satisfied issues, canonical issue order, administrator attribution, retired history, and unchanged ordinary system attribution:

```powershell
npx vitest run src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/issues.test.ts
```

Expected: RED because the administrator wrapper does not exist. Implement only the shared-core/two-wrapper seam described above, then rerun and commit:

```powershell
npx vitest run src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/issues.test.ts
git diff --check
git add src/lib/server/commerce/financial/sources/refund.ts src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/issues.ts src/lib/server/commerce/financial/issues.test.ts
git diff --cached --check
git commit -m "feat: preserve financial administrator issue attribution"
```

- [ ] **Step 5: Write failing finalization/issue-resolution integration tests**

Under the handler's role lock and command row, finalization must acquire:

```text
active projection implementation
-> order advisory -> order -> payment
-> complete purchase graph
-> projection enrollment fence
-> sorted payout generation / balance-transaction membership / fee detail /
   classification / allocation / correction / issue closure
-> sorted entitlement scopes and grants
```

Then it must revalidate a succeeded ambiguous refund, exact current draft/version/fingerprint, exact sum, remaining subtotal/tax capacities, active projection authority, and every selected-set issue key. Use the extracted canonical component planner to derive components. Insert immutable administrative allocations/components, change the draft to `finalized` at `expectedActiveDraftVersion + 1`, and recompute financial projection/issues before changing any grant or entitlement. Only after the command-bound issue transition is complete may it update/project purchase grants, insert finalization effects after each purchase grant is in the recorded after-state, and enqueue the existing access-change email only when effective access changes. Call:

```ts
recomputeLockedRefundFinancialProjectionForAdminCommand(
  transaction,
  lockedInputWithNewAllocations,
  lockedAndRevalidatedOrdinarySelectedSetIds,
  commandId
);
```

Use the `resolveFinancialIssueAfterAdminCommand` strict TypeScript proof validator introduced by the administrator recompute seam; it calls only `resolve_financial_issue_after_admin_command(commandId, issueId)`. The routine re-derives actor/correlation/linkage from the running command. It may resolve each exact allowlisted linked refund/selected-set issue after recomputation proves that issue satisfied; it never resolves retired `unsupported_category` or exposes a generic resolver. Test one recompute that satisfies multiple issues, exact administrator attribution on each, canonical order, and unchanged ordinary system-resolution behavior.

Test two-admin race, provider/refund change after preview, exact replay, over-capacity, another active grant, unclaimed guest item, selected-set issue reopen/resolve, pending projection replay rejection, and forced audit/outbox/projection failure. Every forced failure rolls back allocation/components/draft/provenance/grant/entitlement/issue/audit/outbox/result together.

- [ ] **Step 6: Write failing prepare/confirm UI tests**

Use native `prepareFinalize` to produce the server preview and native `confirmFinalize` to submit the exact fingerprint/confirmation as a command. Confirmation copy states that allocation is immutable, may revoke purchase access, and a later reporting correction does not automatically restore access. No `window.confirm`; stale preview is 409 and reloads facts.

- [ ] **Step 7: Run focused tests and confirm RED**

```powershell
npx vitest run src/lib/server/commerce/refund-access.test.ts src/lib/server/commerce/refund-allocation-components.test.ts src/lib/server/commerce/financial/refund-review/finalize.test.ts src/lib/server/commerce/refunds.test.ts src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/issues.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-refund-review.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-lock-order.test.ts tests/integration/financial-lock-order.test.ts
npm run test:integration -- tests/integration/financial-admin-commands.test.ts
```

Expected: FAIL because the finalization executor, routes, and confirmation UI do not exist yet.

- [ ] **Step 8: Implement the finalization executor function and run GREEN**

Do not mutate a shared registry. Unit/integration tests pass the function directly or compose it with test-local stubs through the Task 4 builder. Then run:

```powershell
npx vitest run src/lib/server/commerce/refund-access.test.ts src/lib/server/commerce/refund-allocation-components.test.ts src/lib/server/commerce/financial/refund-review/finalize.test.ts src/lib/server/commerce/refunds.test.ts src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/issues.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-refund-review.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-lock-order.test.ts tests/integration/financial-lock-order.test.ts
npm run test:integration -- tests/integration/financial-admin-commands.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands pass; finalization/result/audit/access/email are atomic and exact replay creates nothing.

- [ ] **Step 9: Commit finalization**

```powershell
git add src/lib/server/commerce/financial/admin-commands/handler.ts src/lib/server/commerce/financial/admin-commands/handler.test.ts src/lib/server/commerce/financial/refund-review/drafts.test.ts src/lib/server/commerce/financial/refund-review/finalize.ts src/lib/server/commerce/financial/refund-review/finalize.test.ts src/lib/server/commerce/financial/refund-review/inputs.ts src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/reconciliation.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundAllocationEditor.svelte src/lib/components/admin/FinancialActionConfirmation.svelte src/lib/components/admin/RefundReview.test.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-refund-review.test.ts tests/integration/commerce-lock-order.test.ts tests/integration/financial-lock-order.test.ts
git add -- ':(literal)src/routes/admin/sales/refunds/[refundId]/+page.server.ts' ':(literal)src/routes/admin/sales/refunds/[refundId]/+page.svelte'
git diff --cached --check
git commit -m "feat: finalize ambiguous refund allocations"
```

### Task 13: Add append-only reporting corrections and classifier-rebase safety

**Files:**
- Create: `drizzle/0013_plan6bii_reporting_correction_authority.sql`
- Create: `drizzle/meta/0013_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/server/db/database-role-provision.ts`
- Modify: `src/lib/server/db/database-role-provision.test.ts`
- Modify: `src/lib/server/commerce/financial/issues.ts`
- Modify: `src/lib/server/commerce/financial/issues.test.ts`
- Modify: `scripts/database-role-deployment.test.ts`
- Modify: `scripts/financial-schema-preservation.test.ts`
- Modify: `scripts/commerce-operations.test.ts`
- Modify: `scripts/verify-financial-restore.sql`
- Modify: `scripts/execute-financial-restore-verifier.ts`
- Modify: `scripts/deployment-checkpoint.test.ts`
- Modify: `scripts/deployment-checkpoint-runtime.test.ts`
- Modify: `scripts/deployment-backup-bundle.test.ts`
- Modify: `scripts/with-plan6b-upgrade-database.test.ts`
- Modify: `docs/stripe-financial-reconciliation.md`
- Modify: `docs/storage-ingestion-and-publication.md`
- Modify: `tests/integration/financial-migration.test.ts`
- Modify: `tests/integration/database-role-boundaries.test.ts`
- Modify: `tests/integration/financial-admin-commands.test.ts`
- Modify: `src/lib/types/financial-reporting.ts`
- Modify: `src/lib/types/financial-reporting.test.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/inputs.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/inputs.test.ts`
- Create: `src/lib/server/commerce/financial/refund-review/correction-plan.ts`
- Create: `src/lib/server/commerce/financial/refund-review/correction-plan.test.ts`
- Create: `src/lib/server/commerce/financial/refund-review/corrections.ts`
- Create: `src/lib/server/commerce/financial/refund-review/corrections.test.ts`
- Modify: `src/lib/server/commerce/financial/sources/refund.ts`
- Modify: `src/lib/server/commerce/financial/sources/refund.test.ts`
- Create: `tests/integration/financial-corrections.test.ts`
- Modify: `tests/integration/financial-reclassification.test.ts`
- Modify: `tests/integration/financial-lock-order.test.ts`
- Create: `src/lib/components/admin/ReportingCorrectionEditor.svelte`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.server.ts`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.svelte`
- Modify: `src/routes/admin/sales/refunds/refund-routes.test.ts`
- Modify: `src/lib/components/admin/RefundReview.test.ts`

- [ ] **Step 1: Write failing 0013 authority, ACL, migration, and restore-contract tests**

Migration 0012 and Task 3 historically create exactly eight public callable boundaries: submit, status, four read-audit routines, the finalization-bound issue resolver, and the administrative-recovery transition. Do not edit 0012, its snapshot, or its finalization-only routine. Task 13 adds exactly one ninth boundary in append-only migration 0013:

```sql
public.resolve_financial_issue_after_reporting_correction_command(uuid,uuid)
```

Write RED tests for a clean `through(12) -> 0013` upgrade, collision/owner/prerequisite/ACL rollback before any 0013 effect, idempotent second migration, and exact final routine authority. The new routine is database-owner owned, `SECURITY DEFINER`, `SET search_path = pg_catalog`, fully qualified, explicitly revoked from `PUBLIC`, runtime, worker, and storage-cleanup principals before granting `EXECUTE` only to `pale_orbit_financial_worker`; configured login roles receive no direct grant. Its preflight preserves 0012's exact eight-routine surface and proves the current database owner, origin replication mode, exact attested login/group topology, exact 0012 resolver/lease-helper/issue-trigger prerequisites, and absence of the new signature before the first persistent statement. Never use `CREATE OR REPLACE` on the 0012 resolver or issue trigger.

The routine independently requires worker membership, canonical non-null arguments, the administrator-role lock, linked job shared lease lock, a still-pending `refund_reporting_correction_create` command, current administrator role, and `plan6bii_assert_financial_admin_job_lease(job_id)`. It parses exactly the correction command's private keys and item shapes, then proves one appended `allocation_attribution_correction` row matches the command's refund, expected next version, current immutable base, source fingerprint, submitting administrator as approver/creator, correlation, and exact raw-predecessor topology. It directly re-proves item arithmetic, complete base coverage, grouped conservation, representable fee basis, and effective sibling capacity from the locked current immutable base/fingerprint and correction rows. It must not require an issue-dependent current-head view to expose the row while the linked issue is still open. Add a positive witness where the open issue suppresses head exposure but these direct facts allow resolution, plus one rejection witness for each direct-proof dimension with issue/audit unchanged. After this issue-independent compatibility proof, it accepts only the same nine issue codes as the finalization resolver and only a linked refund or current selected-set lineage, sets the existing three `pale_orbit.plan6bii_financial_admin_issue_resolution_*` settings, resolves in stable issue order with the submitter as resolver, and appends the fixed issue audit. TypeScript then reads current heads and requires the repaired row to be the exposed compatible raw tip with all relevant heads complete. Both resolvers have the same database owner, so the existing issue-transition trigger remains unchanged and recognizes the guarded owner call; this is not a generic issue resolver.

Advance the exact restore contract to `plan6b-financial-catalog-v3`. Add only the 0013 routine definition/owner/security/search-path/ACL and protected journal head to the exhaustive v2 inventory; preserve every v2 descriptor and witness. Load the reviewed function definition uniquely from 0013 for source-parity repair, update both exact marker copies, update upgrade/checkpoint/bundle expectations through 0013, and add reversible missing/excess/wrong-owner/wrong-security/wrong-search-path/wrong-definition/PUBLIC/runtime/direct-login/wrong-worker-ACL witnesses.

Run RED:

```powershell
npx vitest run src/lib/server/commerce/financial/issues.test.ts src/lib/server/db/database-role-provision.test.ts scripts/database-role-deployment.test.ts scripts/financial-schema-preservation.test.ts scripts/deployment-checkpoint.test.ts scripts/deployment-checkpoint-runtime.test.ts scripts/deployment-backup-bundle.test.ts scripts/with-plan6b-upgrade-database.test.ts
npx vitest run scripts/commerce-operations.test.ts -t "pins one versioned exact catalog contract|confines the executable verifier witness|times and scopes every verifier expectation|refuses ambiguous financial witness timeout cleanup targets|bounds financial witness process-tree termination|allows only inert fail-closed" --reporter=verbose
npm run test:integration -- tests/integration/financial-migration.test.ts tests/integration/database-role-boundaries.test.ts tests/integration/financial-admin-commands.test.ts
```

Expected before implementation: FAIL on missing migration 0013, ninth worker routine, v3 catalog/head, provisioner parity, and correction-only command proof.

- [ ] **Step 2: Generate 0013 and implement the correction-only authority boundary**

```powershell
npm run db:generate -- --custom --name plan6bii_reporting_correction_authority
```

Expected: Drizzle creates index `13`, `drizzle/0013_plan6bii_reporting_correction_authority.sql`, `drizzle/meta/0013_snapshot.json`, and the matching journal entry. Rename only the generated SQL suffix if needed; do not edit 0012 or any prior migration/snapshot. Implement the absolute-first preflight, routine, explicit revoke/grant, and exact postflight in 0013. Add only the new signature to the worker execute allowlist and exact role/static tests.

In `issues.ts`, keep `resolveFinancialIssueAfterAdminCommand` unchanged and add:

```ts
export async function resolveFinancialIssueAfterReportingCorrectionCommand(
  tx: DatabaseTransaction,
  input: ResolveFinancialIssueAfterAdminCommandInput
): Promise<FinancialIssueRow | null>;
```

The wrapper calls only `resolve_financial_issue_after_reporting_correction_command(uuid,uuid)` and applies the same strict zero-or-one-row parser. No caller-selectable routine name crosses this wrapper.

- [ ] **Step 3: Run authority/catalog GREEN and commit it independently**

Run serially:

```powershell
npx vitest run src/lib/server/commerce/financial/issues.test.ts src/lib/server/db/database-role-provision.test.ts scripts/database-role-deployment.test.ts scripts/financial-schema-preservation.test.ts scripts/deployment-checkpoint.test.ts scripts/deployment-checkpoint-runtime.test.ts scripts/deployment-backup-bundle.test.ts scripts/with-plan6b-upgrade-database.test.ts
npx vitest run scripts/commerce-operations.test.ts -t "pins one versioned exact catalog contract|confines the executable verifier witness|times and scopes every verifier expectation|refuses ambiguous financial witness timeout cleanup targets|bounds financial witness process-tree termination|allows only inert fail-closed" --reporter=verbose
npm run test:integration -- tests/integration/financial-migration.test.ts tests/integration/database-role-boundaries.test.ts tests/integration/financial-admin-commands.test.ts
npx vitest run scripts/commerce-operations.test.ts -t "executes schema-object, source-parity, deterministic-allocation, audit, payout, and chronology verifier witnesses in PostgreSQL" --reporter=verbose
npm run db:check
npm run check
npm run lint
git diff --check
```

Expected: 0012 remains byte-identical with eight historical routines; 0013, provisioner, upgrade path, checkpoint/bundle assertions, and exact restored catalog agree on nine final callable routines; the new resolver rejects every non-correction, stale-lease, demoted-actor, wrong-row/topology, out-of-scope-issue, and nonworker invocation without domain or audit change.

```powershell
git add drizzle/0013_plan6bii_reporting_correction_authority.sql drizzle/meta/0013_snapshot.json drizzle/meta/_journal.json src/lib/server/db/database-role-provision.ts src/lib/server/db/database-role-provision.test.ts src/lib/server/commerce/financial/issues.ts src/lib/server/commerce/financial/issues.test.ts scripts/database-role-deployment.test.ts scripts/financial-schema-preservation.test.ts scripts/commerce-operations.test.ts scripts/verify-financial-restore.sql scripts/execute-financial-restore-verifier.ts scripts/deployment-checkpoint.test.ts scripts/deployment-checkpoint-runtime.test.ts scripts/deployment-backup-bundle.test.ts scripts/with-plan6b-upgrade-database.test.ts docs/stripe-financial-reconciliation.md docs/storage-ingestion-and-publication.md tests/integration/financial-migration.test.ts tests/integration/database-role-boundaries.test.ts tests/integration/financial-admin-commands.test.ts
git diff --cached --check
git commit -m "feat: add reporting correction issue authority"
```

- [ ] **Step 4: Write failing seed DTO, strict form-input, and pure planner tests**

Add a separately keyed and parsed seed DTO; do not turn `RefundDetailDto.correctionPreview` into a page-load no-op. Its exact safe shape is:

```ts
export interface RefundReportingCorrectionSeedItemDto {
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly baselineTotalMinor: number;
  readonly baselineSubtotalMinor: number;
  readonly baselineTaxMinor: number;
  readonly baselineSettlementGrossMinor: number | null;
  readonly baselineRefundFeeImpactMinor: number | null;
}

export interface RefundReportingCorrectionSeedDto {
  readonly refundId: string;
  readonly reason: 'allocation_attribution_correction';
  readonly expectedNextCorrectionVersion: number | null;
  readonly expectedBaseAllocationSetId: string | null;
  readonly expectedSourceFingerprint: string | null;
  readonly rawPredecessorCorrectionSetId: string | null;
  readonly compatibleCorrectionSetId: string | null;
  readonly baselineKind: 'immutable_base' | 'compatible_correction' | null;
  readonly currentReportingComplete: boolean;
  readonly currency: string | null;
  readonly settlementCurrency: string | null;
  readonly baselineTotalMinor: number | null;
  readonly eligible: boolean;
  readonly ineligibleReason:
    | 'provider_evidence_pending'
    | 'immutable_conflict'
    | 'not_finalized'
    | null;
  readonly items: readonly RefundReportingCorrectionSeedItemDto[];
}

export const REFUND_CORRECTION_ITEM_PREVIEW_DTO_KEYS = [
  'orderItemId', 'titleId', 'soldAsTitle',
  'baselineTotalMinor', 'baselineSubtotalMinor', 'baselineTaxMinor',
  'proposedTotalMinor', 'proposedSubtotalMinor', 'proposedTaxMinor',
  'subtotalDisplayDeltaMinor', 'taxDisplayDeltaMinor',
  'baselineSettlementGrossMinor', 'proposedSettlementGrossMinor',
  'settlementGrossDisplayDeltaMinor',
  'baselineRefundFeeImpactMinor', 'proposedRefundFeeImpactMinor',
  'refundFeeImpactDisplayDeltaMinor'
] as const;

export interface RefundCorrectionItemPreviewDto {
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly baselineTotalMinor: number;
  readonly baselineSubtotalMinor: number;
  readonly baselineTaxMinor: number;
  readonly proposedTotalMinor: number;
  readonly proposedSubtotalMinor: number;
  readonly proposedTaxMinor: number;
  readonly subtotalDisplayDeltaMinor: number;
  readonly taxDisplayDeltaMinor: number;
  readonly baselineSettlementGrossMinor: number | null;
  readonly proposedSettlementGrossMinor: number | null;
  readonly settlementGrossDisplayDeltaMinor: number | null;
  readonly baselineRefundFeeImpactMinor: number | null;
  readonly proposedRefundFeeImpactMinor: number | null;
  readonly refundFeeImpactDisplayDeltaMinor: number | null;
}

export const REFUND_REPORTING_CORRECTION_PREVIEW_DTO_KEYS = [
  'refundId', 'expectedBaseAllocationSetId',
  'rawPredecessorCorrectionSetId', 'compatibleCorrectionSetId',
  'expectedNextCorrectionVersion', 'expectedSourceFingerprint',
  'previewFingerprint', 'baselineKind', 'currentReportingComplete',
  'proposedReportingComplete', 'compatibilityRepair', 'currency',
  'settlementCurrency', 'baselineTotalMinor', 'proposedTotalMinor',
  'eligible', 'ineligibleReason', 'items'
] as const;

export interface RefundReportingCorrectionPreviewDto {
  readonly refundId: string;
  readonly expectedBaseAllocationSetId: string;
  readonly rawPredecessorCorrectionSetId: string | null;
  readonly compatibleCorrectionSetId: string | null;
  readonly expectedNextCorrectionVersion: number;
  readonly expectedSourceFingerprint: string;
  readonly previewFingerprint: string | null;
  readonly baselineKind: 'immutable_base' | 'compatible_correction';
  readonly currentReportingComplete: boolean;
  readonly proposedReportingComplete: boolean;
  readonly compatibilityRepair: boolean;
  readonly currency: string;
  readonly settlementCurrency: string | null;
  readonly baselineTotalMinor: number;
  readonly proposedTotalMinor: number;
  readonly eligible: boolean;
  readonly ineligibleReason:
    | 'provider_evidence_pending'
    | 'immutable_conflict'
    | 'not_finalized'
    | 'no_change'
    | null;
  readonly items: readonly RefundCorrectionItemPreviewDto[];
}

export async function getReportingCorrectionSeed(
  database: Database,
  actor: Actor,
  refundId: string,
  context: FinancialRequestContext,
  dependencies?: FinancialAuthorizationDependencies
): Promise<RefundReportingCorrectionSeedDto | null>;

export type ReportingCorrectionPrepareInput = Omit<
  Extract<FinancialAdminPrivateCommand, {
    kind: 'refund_reporting_correction_create'
  }>,
  'kind' | 'previewFingerprint' | 'confirmation'
>;

export async function previewReportingCorrection(
  database: Database,
  actor: Actor,
  input: ReportingCorrectionPrepareInput,
  context: FinancialRequestContext,
  dependencies?: FinancialAuthorizationDependencies
): Promise<RefundReportingCorrectionPreviewDto>;

export async function executeReportingCorrectionCreate(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, {
    kind: 'refund_reporting_correction_create'
  }>
): Promise<FinancialAdminCommandSafeResultByCode['correction_created']>;
```

The planner contract is exact and database-free:

```ts
export interface RefundReportingCorrectionPlanItemFacts {
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly paidSubtotalMinor: number;
  readonly paidTaxMinor: number;
  readonly paidTotalMinor: number;
  readonly effectiveSiblingSubtotalMinor: number;
  readonly effectiveSiblingTaxMinor: number;
  readonly immutablePresentmentSubtotalMinor: number;
  readonly immutablePresentmentTaxMinor: number;
  readonly immutableSettlementSubtotalMinor: number | null;
  readonly immutableSettlementTaxMinor: number | null;
  readonly immutableRefundFeeImpactMinor: number | null;
  readonly compatiblePresentmentSubtotalMinor: number | null;
  readonly compatiblePresentmentTaxMinor: number | null;
  readonly compatibleSettlementSubtotalMinor: number | null;
  readonly compatibleSettlementTaxMinor: number | null;
  readonly compatibleRefundFeeImpactMinor: number | null;
}

export interface RefundReportingCorrectionPlanInput {
  readonly request: ReportingCorrectionPrepareInput;
  readonly activeProjection: {
    readonly classifierVersion: number;
    readonly allocationAlgorithmVersion: number;
    readonly replayId: string;
  };
  readonly currentReportingComplete: boolean;
  readonly rawTip: {
    readonly id: string;
    readonly correctionVersion: number;
    readonly baseAllocationSetId: string;
    readonly sourceFingerprint: string;
  } | null;
  readonly compatibleTip: {
    readonly id: string;
    readonly correctionVersion: number;
  } | null;
  readonly immutableBase: {
    readonly grossAllocationSetId: string;
    readonly feeAllocationSetId: string | null;
    readonly sourceFingerprint: string;
    readonly currency: string;
    readonly settlementCurrency: string | null;
    readonly totalPresentmentMinor: number;
  };
  readonly activeFeeComponents: readonly {
    readonly component: FinancialComponent;
    readonly amountMinor: number;
    readonly currency: string;
  }[];
  readonly items: readonly RefundReportingCorrectionPlanItemFacts[];
}

export interface RefundReportingCorrectionPersistableItem {
  readonly domain: 'presentment' | 'settlement';
  readonly sourceAllocationSetId: string | null;
  readonly orderItemId: string;
  readonly component: 'refund_subtotal' | 'refund_tax' | 'refund_fee';
  readonly currency: string;
  readonly approvedAbsoluteMinor: number;
  readonly deltaMinor: number;
  readonly stableTieBreakKey: string;
}

export interface RefundReportingCorrectionFingerprintDocument {
  readonly version: 'refund-reporting-correction-preview-v1';
  readonly refundId: string;
  readonly reason: 'allocation_attribution_correction';
  readonly activeProjection: {
    readonly classifierVersion: number;
    readonly allocationAlgorithmVersion: number;
    readonly replayId: string;
  };
  readonly expectedBaseAllocationSetId: string;
  readonly rawPredecessorCorrectionSetId: string | null;
  readonly compatibleCorrectionSetId: string | null;
  readonly expectedNextCorrectionVersion: number;
  readonly expectedSourceFingerprint: string;
  readonly baselineKind: 'immutable_base' | 'compatible_correction';
  readonly currentReportingComplete: boolean;
  readonly proposedReportingComplete: boolean;
  readonly compatibilityRepair: boolean;
  readonly requestedItems: readonly {
    readonly orderItemId: string;
    readonly totalPresentmentMinor: number;
  }[];
  readonly previewItems: readonly RefundCorrectionItemPreviewDto[];
  readonly persistableItems: readonly RefundReportingCorrectionPersistableItem[];
}

export type RefundReportingCorrectionPlanResult =
  | {
      readonly kind: 'ineligible';
      readonly preview: RefundReportingCorrectionPreviewDto;
      readonly fingerprintDocument: null;
      readonly persistableItems: readonly [];
    }
  | {
      readonly kind: 'ready';
      readonly preview: RefundReportingCorrectionPreviewDto;
      readonly fingerprintDocument: RefundReportingCorrectionFingerprintDocument;
      readonly persistableItems: readonly RefundReportingCorrectionPersistableItem[];
    };

export function planRefundReportingCorrection(
  input: RefundReportingCorrectionPlanInput
): RefundReportingCorrectionPlanResult;
```

The exact DTO definitions above replace `current*` with `baseline*`, name every UI-only delta `*DisplayDeltaMinor`, replace ambiguous correction ID/version fields, and add explicit `compatibilityRepair`. Define `compatibilityRepair = !currentReportingComplete && proposedReportingComplete`, `distributionChanged` as any effective component difference, and ready eligibility as `distributionChanged || compatibilityRepair`. A ready preview has `eligible: true`, null reason, the lowercase SHA-256 of canonical JSON for the exact fingerprint document, `proposedReportingComplete: true`, a non-null fingerprint document, and full sorted persistable items. An unchanged already-complete distribution returns the ineligible `no_change` preview, null fingerprint/document, and no persistable items. An incomplete-chain repair is ready even when every numeric display and stored delta is zero: `compatibilityRepair` is true and the new successor itself restores completeness.

Add `parseRefundReportingCorrectionPrepareRequest(request, refundId)` and `parseRefundReportingCorrectionConfirmRequest(request, refundId)`. Prepare accepts exactly scalar `reason`, `expectedNextCorrectionVersion`, `expectedBaseAllocationSetId`, and `expectedSourceFingerprint` plus paired repeated `orderItemId`/`totalPresentmentMinor`; confirm adds exactly `idempotencyKey`, `previewFingerprint`, and `confirmation`. Both use the existing 16 KiB URL-encoded reader and enforce only canonical lowercase UUID/SHA grammar, positive int32 version, safe totals, 1–25 syntactically unique items, exact keys/multiplicity/paired-array length, fixed literals, and sorted output. They perform no database/current-membership check. After both capabilities are proven, the shared planner requires the sorted IDs to equal the exact current order-item set and requires explicit zero totals for unchanged members. The route path is the only refund-ID source.

The pure planner loads no database state. Test first correction as raw predecessor/compatible tip null, version 1, and immutable baseline; a normal successor as raw tip equal to compatible tip, raw version plus one, and compatible absolute baseline; and repair as an incompatible raw predecessor, no compatible tip, raw version plus one, current immutable base/fingerprint anchor and baseline, current completeness false, and proposed completeness true. Include a repair whose proposed absolute distribution equals the immutable baseline and whose persistable deltas are all zero; it remains ready because it changes compatibility from incomplete to complete. The browser never supplies either tip ID. The preview fingerprint binds both derived tips, baseline/completeness/repair state, active projection implementation, immutable anchor/fingerprint, next version, sorted totals, exact preview rows, and every persistable component/source/currency/tie-key value.

Derive presentment subtotal/tax, settlement gross, and representable refund-fee values with `allocateSignedLargestRemainder`/`allocateFeeDetails` semantics and stable semantic tie keys that exclude allocation/correction-set IDs. Capacity uses all succeeded sibling refunds' effective distributions, including compatible corrections, not raw allocation components. Persisted deltas are proposed absolute minus current immutable base; UI deltas are baseline-to-proposed. Include every nonzero immutable settlement component for a corrected source and, when any presentment component changes, every nonzero immutable presentment component.

Display subtotal and tax independently, but assert zero-sum over their coalesced presentment source-allocation set per `(domain, sourceAllocationSetId, currency)`: a subtotal increase may offset a tax decrease. Settlement gross and fee are independently zero-sum because their source-set IDs differ. Add a valid subtotal/tax offset test and failures for nonzero combined presentment, gross, and fee groups. A nonzero fee source containing `provider_fee_tax`, `other`, or another unrepresentable component is `immutable_conflict`; never drop or relabel it. `no_change` requires both current completeness and effective distribution equivalence. If locked execution reaches that already-complete/equivalent state after preparation, store `conflict/not_eligible` with no correction effect; never classify an incomplete-to-complete zero-delta repair as a no-op.

Run RED:

```powershell
npx vitest run src/lib/types/financial-reporting.test.ts src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/correction-plan.test.ts src/lib/server/commerce/financial/refund-review/corrections.test.ts
```

Expected before implementation: FAIL on the missing seed/parser/planner/API and changed strict DTO keys.

- [ ] **Step 5: Implement seed, parsers, and the pure correction plan; run focused GREEN**

`getReportingCorrectionSeed` and `previewReportingCorrection` each independently require both `sales.read` and `reconciliation.manage` before inspecting the refund ID/request or making any database call; the route applies the same dual check before parsing. Add four negative service tests—seed and preview each missing `sales.read` with manage present, and each missing `reconciliation.manage` with read present—and route tests proving denial precedes body/identifier parsing. The seed returns `null` for a missing safe target and discovers the unique raw tip from successor topology independently from the compatible tip in current projection; a null compatible tip never means no correction history. For ineligible state, unavailable bindings/baseline fields are null and no confirmable fingerprint is issued. Keep `getRefundReviewDetail` and `query.ts` unchanged; the page server loads the separately authorized seed.

Implement both parsers and one deterministic `planRefundReportingCorrection(...)` seam in `correction-plan.ts`; prepare and locked execution must use that same planner. Run:

```powershell
npx vitest run src/lib/types/financial-reporting.test.ts src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/correction-plan.test.ts src/lib/server/commerce/financial/refund-review/corrections.test.ts
```

Expected: focused DTO, form, seed, raw/compatible-chain, repair, capacity, fee, conservation, coverage, delta, no-op, and fingerprint tests pass.

- [ ] **Step 6: Write failing mutation, resolver, rebase, atomicity, and lock-order tests**

After the handler's existing `role advisory -> shared current-job lease advisory -> command row -> execution-time reauthorization` prefix, require this exact correction suffix:

1. discover refund -> payment -> order routing without taking a row or advisory lock;
2. discover and lock active projection authority; reject pending authority;
3. take order advisory -> order row -> payment row;
4. call `lockPaymentPurchaseFacts` for the complete refund/draft/allocation/correction/dispute/item graph;
5. take `lockFinancialProjectionEnrollment`;
6. discover the bounded payout/balance-transaction/classification/allocation/issue closure;
7. call `lockFinancialProjectionRows` with every multi-row identity set sorted, then re-read exact equality for finalization state, raw tip, compatible tip, immutable base/fingerprint, fee evidence, effective sibling capacity, and current projection; and
8. re-plan and insert one set plus sorted items; recompute through correction authority, whose resolver proves compatibility directly without current-head exposure; resolve eligible issues; then read current heads and require the new compatible raw tip and complete projection before audit/result.

Require a finalized succeeded refund, complete canonical balance transactions/current allocation authority, exact current immutable base/source fingerprint, a unique raw chain, and bounded representable component capacity. Prove:

- first correction and successor form one append-only predecessor chain;
- an incompatible raw chain is repaired only by succeeding its raw tip at `raw.version + 1` while using the current immutable base as the absolute baseline;
- an incomplete-chain repair whose proposed distribution equals that immutable baseline remains eligible and appends a successor even when every numeric delta is zero;
- repair restores current completeness and resolves `correction_rebase_required` without editing, deleting, or silently reattaching history;
- stale/concurrent proposals cannot fork;
- stored deltas remain immutable-base-relative on successors while displayed deltas remain compatible-baseline-relative;
- coalesced presentment subtotal/tax, settlement gross, and settlement fee conservation obey the exact grouping above;
- full base-component coverage, stable rebase-safe tie keys, effective paid capacities, and representable fee-basis conservation hold;
- unsupported fee components fail closed, and prepare-to-execute equivalence is a no-op only when reporting is already complete; an incomplete-to-complete zero-delta repair is not a no-op;
- report changes while allocations, copies, grants, entitlement, access, and email do not;
- classifier replay calls `rebaseApprovedCorrectionDistributionLocked` and preserves a compatible approved absolute distribution;
- incompatible replay opens `correction_rebase_required`, nulls current metrics, and disables recovery; and
- correction set/items, projection, correction-specific issue transition/audit, correction audit, completeness check, and command result are atomic, with forced failures at each seam rolling back all domain effects.

Add a source regression proving `recomputeLockedRefundFinancialProjectionForAdminCommand` remains finalization-only. Add this separate exported entry point, backed by an internal correction resolver mode rather than a caller-selected SQL name:

```ts
export async function recomputeLockedRefundFinancialProjectionForReportingCorrectionCommand(
  transaction: DatabaseTransaction,
  input: LockedRefundProjectionInput,
  lockedAndRevalidatedOrdinarySelectedSetIds: readonly string[],
  commandId: string
): Promise<RefundFinancialRecomputeResult>;
```

It uses only `resolveFinancialIssueAfterReportingCorrectionCommand`; ordinary recompute and classifier replay retain their existing resolvers. The executor never calls `enqueueAccessChange` and never locks or writes purchase grants, administrative grants, entitlement, copies, email, or outbox.

Every PostgreSQL lock witness in `financial-lock-order.test.ts` must invoke the production `executeReportingCorrectionCreate` executor with a real pending correction command/lease context; it may not reproduce the executor with test SQL or call lock helpers as a substitute. From a second backend, hold each asserted blocker in turn—active projection authority, order advisory, order row, payment row, a descendant purchase-fact row, projection enrollment, and a sorted payout/balance-transaction/classification/allocation/issue row—then identify the executor backend and assert its exact `pg_locks`/`pg_stat_activity` wait target. While blocked, require pending command status and an exact no-mutation snapshot across correction sets/items, projection rows, issues/audits, and command result. Release only that blocker, require the expected succeeded or safe terminal outcome, and compare the final snapshot. Forced-error witnesses take the same production path and prove full rollback; time-based “still pending” alone is not lock evidence.

Run RED:

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/corrections.test.ts src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/issues.test.ts
npm run test:integration -- tests/integration/financial-corrections.test.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-reclassification.test.ts tests/integration/financial-lock-order.test.ts
```

Expected before implementation: FAIL on missing executor/recompute mode and correction-chain, resolver, repair, atomicity, and lock witnesses.

- [ ] **Step 7: Implement the locked executor and correction-specific recompute path**

Prepare may read and plan without row locks but never inserts or submits. Execution reloads every fact under the exact locks, calls the same pure planner, compares the canonical fingerprint, and maps stale base/fingerprint/version/tip/projection/capacity to `conflict/stale_state`; an ineligible or already-complete/equivalent state to `conflict/not_eligible`; and malformed stored input to `failed/invalid_command`. An incomplete-to-complete repair remains executable even when all numeric deltas are zero. Insert the correction set before its sorted full-coverage items, use raw predecessor topology even in repair, and call correction recompute only after insertion. Its SQL resolver proves compatibility directly from locked immutable/topology/item/capacity facts and resolves the blocking issue without consulting issue-suppressed current heads; only afterward does TypeScript load current heads and require the new tip exposed/complete before correction audit/result. Exact terminal replay returns the committed safe result without another row or audit.

Rerun Step 6's commands. Expected: mutation, source, resolver, rebase, repair, authority, atomicity, no-access-effect, and lock-order tests pass.

- [ ] **Step 8: Write RED UI/route tests, then implement prepare and confirm**

The loader, seed service, preview service, prepare action, and confirm action each require both `sales.read` and `reconciliation.manage` before identifier/body inspection or database work. Tests deny each missing capability independently at route and service seams. Existing safe refund detail itself remains a `sales.read` query. Prepare uses the exact syntax-only parser, then lets the authorized planner validate current membership; it returns a strict action preview without submission. Confirm submits the approved command, displays its actual pending/terminal safe reference, and uses the shared bounded/cancelable poller.

The editor shows baseline kind, current/proposed completeness, raw-history repair state, old/new attribution by item/currency, and separate subtotal, tax, settlement gross, and fee display deltas. It uses field-linked validation, explicit native confirmation, accessible live status, and the exact copy `Reporting only — this does not restore or revoke access.` It offers no generic issue control and never implies that repair rewrites history.

On an ambiguous confirm `503`, freeze the complete confirmed payload: idempotency key, reason, expected next version/base/fingerprint, both sorted repeated item arrays including zeros, preview fingerprint, and confirmation. Do not automatically resubmit on retry timers, polling, refresh, navigation, or remount. Show an explicit Retry control; only that click posts the exact frozen payload with the same idempotency key, so the server recovers the same command if the first submit committed. Editing or preparing again discards the frozen payload and generates a new key. Route/component tests simulate response loss/503, prove zero automatic POSTs, compare every retried field and array byte-for-byte, recover pending and terminal existing commands, and prove same-key payload drift is a conflict rather than a second command.

Run RED, implement, then rerun:

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/corrections.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
```

Expected before implementation: FAIL on missing seed load/actions/editor. Expected after implementation: PASS with dual-capability denials, normal successor, numeric-zero raw-tip repair, already-complete `no_change`, stale preview, explicit exact-payload 503 retry with no auto-resubmit, async terminal, abort-on-navigation, keyboard, focus, error-linking, and responsive display coverage.

- [ ] **Step 9: Run complete Task 13 GREEN**

Keep the correction executor standalone; focused tests pass it directly or compose it with test-local stubs through the Task 4 builder. Do not mutate a shared registry. Run service-free tests first, then database-backed suites serially:

```powershell
npx vitest run src/lib/types/financial-reporting.test.ts src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/correction-plan.test.ts src/lib/server/commerce/financial/refund-review/corrections.test.ts src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/issues.test.ts src/lib/server/db/database-role-provision.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts scripts/database-role-deployment.test.ts scripts/financial-schema-preservation.test.ts scripts/deployment-checkpoint.test.ts scripts/deployment-checkpoint-runtime.test.ts scripts/deployment-backup-bundle.test.ts scripts/with-plan6b-upgrade-database.test.ts
npx vitest run scripts/commerce-operations.test.ts -t "pins one versioned exact catalog contract|confines the executable verifier witness|times and scopes every verifier expectation|refuses ambiguous financial witness timeout cleanup targets|bounds financial witness process-tree termination|allows only inert fail-closed" --reporter=verbose
npm run test:integration -- tests/integration/financial-migration.test.ts tests/integration/database-role-boundaries.test.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-corrections.test.ts tests/integration/financial-reclassification.test.ts tests/integration/financial-lock-order.test.ts
npx vitest run scripts/commerce-operations.test.ts -t "executes schema-object, source-parity, deterministic-allocation, audit, payout, and chronology verifier witnesses in PostgreSQL" --reporter=verbose
npm run db:check
npm run check
npm run lint
git diff --check
```

Expected: every command passes; migration/catalog head is 0013/v3 with exactly nine callable routines; first, successor, and incompatible-raw-tip repair paths are deterministic; issue resolution uses only correction authority; grouped conservation and immutable-base deltas hold; and access history remains unchanged.

- [ ] **Step 10: Commit correction behavior separately**

The authority/catalog commit from Step 3 must already be HEAD. This behavior commit contains no migration, role, restore, or provisioner file.

```powershell
git add src/lib/types/financial-reporting.ts src/lib/types/financial-reporting.test.ts src/lib/server/commerce/financial/refund-review/inputs.ts src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/correction-plan.ts src/lib/server/commerce/financial/refund-review/correction-plan.test.ts src/lib/server/commerce/financial/refund-review/corrections.ts src/lib/server/commerce/financial/refund-review/corrections.test.ts src/lib/server/commerce/financial/sources/refund.ts src/lib/server/commerce/financial/sources/refund.test.ts tests/integration/financial-corrections.test.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-reclassification.test.ts tests/integration/financial-lock-order.test.ts src/lib/components/admin/ReportingCorrectionEditor.svelte src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
git add -- ':(literal)src/routes/admin/sales/refunds/[refundId]/+page.server.ts' ':(literal)src/routes/admin/sales/refunds/[refundId]/+page.svelte'
git diff --cached --check
git commit -m "feat: add refund reporting corrections"
```

Expected: Task 13 ends with two reviewable commits, no uncommitted authority/behavior file, and no edit to migration 0012 or its finalization-only resolver.

### Task 14: Add causally proven persistent administrative recovery

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-plan-6b-ii-implementation-refresh-design.md`
- Modify: `docs/superpowers/plans/2026-08-20-backend-plan-6b-ii-admin-resolution-reporting-refresh.md`
- Modify: `src/lib/types/financial-reporting.ts`
- Modify: `src/lib/types/financial-reporting.test.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/inputs.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/inputs.test.ts`
- Create: `src/lib/server/commerce/financial/refund-review/recovery.ts`
- Create: `src/lib/server/commerce/financial/refund-review/recovery.test.ts`
- Modify: `src/lib/server/commerce/financial/admin-commands/handler.test.ts`
- Create: `tests/integration/financial-administrative-recovery.test.ts`
- Modify: `tests/integration/commerce-claims.test.ts`
- Modify: `tests/integration/commerce-refunds.test.ts`
- Modify: `tests/integration/commerce-disputes.test.ts`
- Modify: `tests/integration/commerce-lock-order.test.ts`
- Modify: `tests/integration/financial-lock-order.test.ts`
- Create: `src/lib/components/admin/AdministrativeRecoveryActions.svelte`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.server.ts`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.svelte`
- Modify: `src/routes/admin/sales/refunds/refund-routes.test.ts`
- Modify: `src/lib/components/admin/RefundReview.test.ts`
- Modify: `src/lib/server/commerce/grants.ts`
- Modify: `src/lib/server/commerce/grants.test.ts`
- Modify: `src/lib/server/commerce/email/payload.ts`
- Modify: `src/lib/server/commerce/email/payload.test.ts`
- Modify: `src/lib/server/commerce/email/enqueue.ts`
- Modify: `src/lib/server/commerce/email/enqueue.test.ts`
- Modify: `src/lib/server/commerce/email/render.ts`
- Modify: `src/lib/server/commerce/email/render.test.ts`
- Modify: `drizzle/0012_plan6bii_admin_command_authority.sql`
- Modify: `scripts/verify-financial-restore.sql`
- Modify: `docs/stripe-financial-reconciliation.md`
- Modify: `src/worker.ts`
- Modify: `scripts/storage-process-isolation.test.ts`

- [ ] **Step 0: Define and commit the recovery discovery and form-input contract spine**

Recovery discovery is separate from `RefundDetailDto`. Add an independently authorized
`AdministrativeRecoverySeedDto` with exact activation and deactivation candidate arrays:

```ts
export interface AdministrativeRecoveryActivationCandidateDto {
  readonly finalizationEffectId: string;
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly expectedCorrectionSetId: string;
  readonly expectedCorrectionVersion: number;
  readonly expectedSourceFingerprint: string;
}

export interface AdministrativeRecoveryDeactivationCandidateDto {
  readonly recoveryGrantId: string;
  readonly recoveryReferenceId: string;
  readonly expectedStateChangedAt: string;
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
}

export interface AdministrativeRecoverySeedDto {
  readonly refundId: string;
  readonly activationCandidates:
    readonly AdministrativeRecoveryActivationCandidateDto[];
  readonly deactivationCandidates:
    readonly AdministrativeRecoveryDeactivationCandidateDto[];
}
```

Extend `AdministrativeRecoveryPreviewDto` with `finalizationEffectId`,
`expectedCorrectionSetId`, `expectedCorrectionVersion`,
`expectedSourceFingerprint`, and `previewFingerprint: string | null`. Add a separate
deactivation preview with this exact safe shape:

```ts
export interface AdministrativeRecoveryDeactivationPreviewDto {
  readonly refundId: string;
  readonly recoveryGrantId: string;
  readonly recoveryReferenceId: string;
  readonly expectedStateChangedAt: string;
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly eligible: boolean;
  readonly ineligibleReason: 'already_in_requested_state' | null;
  readonly effectiveAccessBefore: boolean;
  readonly effectiveAccessAfter: boolean;
  readonly accessChanged: boolean;
  readonly emailQueued: boolean;
}
```

The deactivation preview has no fingerprint: its canonical millisecond-UTC
`expectedStateChangedAt` is the concurrency token. Enumerate and test every exact DTO key;
return every candidate and preview array in stable identifier order.

Activation and deactivation discovery are independent. A persistent administrative grant
remains discoverable for deactivation after later correction, refund, dispute, or rebase
makes the original activation relationship ineligible. `recoveryReferenceId` is the linked
refund-allocation ID; `expectedStateChangedAt` is the administrative grant's canonical
millisecond-UTC `updated_at`. The page server loads this seed separately; do not modify
`query.ts` or populate the legacy `RefundDetailDto.recoveryPreviews` field from page-load
side effects.

Add four strict URL-encoded parsers using the existing 16 KiB reader and exact
key/multiplicity rules:

- activation prepare accepts exactly `finalizationEffectId`, `orderItemId`,
  `expectedCorrectionSetId`, `expectedCorrectionVersion`, and
  `expectedSourceFingerprint`;
- activation confirm adds exactly `idempotencyKey`, `previewFingerprint`, and
  `confirmation=activate_persistent_recovery`;
- deactivation prepare accepts exactly `recoveryGrantId`, `recoveryReferenceId`, and
  `expectedStateChangedAt`; and
- deactivation confirm adds exactly `idempotencyKey` and
  `confirmation=deactivate_persistent_recovery`.

The route path is the only `refundId` source for both prepare service inputs. The established
deactivation private command intentionally contains no `refundId`. Require canonical
lowercase UUID/SHA-256 values, positive int32 versions, and an exact real millisecond-UTC
timestamp whose `Date#toISOString()` round-trip is identical. Confirm parsers construct the
complete value through `parseFinancialAdminPrivateCommand`; neither prepare parser performs
database or current-membership work.

Capture RED before implementing, then run GREEN and commit only this contract spine:

```powershell
npx vitest run src/lib/types/financial-reporting.test.ts src/lib/server/commerce/financial/refund-review/inputs.test.ts
# Expected first run: FAIL on missing seed/deactivation DTOs and four parsers.
npx vitest run src/lib/types/financial-reporting.test.ts src/lib/server/commerce/financial/refund-review/inputs.test.ts
npm run check
git diff --check
git add docs/superpowers/plans/2026-08-20-backend-plan-6b-ii-admin-resolution-reporting-refresh.md src/lib/types/financial-reporting.ts src/lib/types/financial-reporting.test.ts src/lib/server/commerce/financial/refund-review/inputs.ts src/lib/server/commerce/financial/refund-review/inputs.test.ts
git diff --cached --check
git commit -m "feat: define administrative recovery inputs"
```

Expected: the discovery/confirmation contract is fixed before domain, email, route, and UI
lanes begin, and no database, executor, entitlement, email, route, or worker code changes in
this commit.

- [ ] **Step 1: Write failing grant-origin and recovery-preview tests**

Make `assertGrantTransitionAllowed` an exact source/origin/state matrix. Payment/refund/dispute/claim reducers may change only purchase grants as currently permitted; preserved maintenance changes only preserved grants; only `administrative-recovery` may request an administrative transition, and it must use the protected SQL routine rather than direct Drizzle insert/update.

Require:

```ts
export type AdministrativeRecoveryPrepareInput = Omit<
  Extract<FinancialAdminPrivateCommand, {
    kind: 'administrative_recovery_activate'
  }>,
  'kind' | 'previewFingerprint' | 'confirmation'
>;

export type AdministrativeRecoveryDeactivationPrepareInput = {
  readonly refundId: string;
} & Omit<
  Extract<FinancialAdminPrivateCommand, {
    kind: 'administrative_recovery_deactivate'
  }>,
  'kind' | 'confirmation'
>;

export async function getAdministrativeRecoverySeed(
  database: Database,
  actor: Actor,
  refundId: string,
  context: FinancialRequestContext,
  dependencies?: FinancialAuthorizationDependencies
): Promise<AdministrativeRecoverySeedDto | null>;

export async function previewAdministrativeRecovery(
  database: Database,
  actor: Actor,
  input: AdministrativeRecoveryPrepareInput,
  context: FinancialRequestContext,
  dependencies?: FinancialAuthorizationDependencies
): Promise<AdministrativeRecoveryPreviewDto>;

export async function previewAdministrativeRecoveryDeactivation(
  database: Database,
  actor: Actor,
  input: AdministrativeRecoveryDeactivationPrepareInput,
  context: FinancialRequestContext,
  dependencies?: FinancialAuthorizationDependencies
): Promise<AdministrativeRecoveryDeactivationPreviewDto>;

export async function executeAdministrativeRecoveryActivate(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, {
    kind: 'administrative_recovery_activate'
  }>
): Promise<FinancialAdminCommandSafeResultByCode['recovery_activated']>;

export async function executeAdministrativeRecoveryDeactivate(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, {
    kind: 'administrative_recovery_deactivate'
  }>
): Promise<FinancialAdminCommandSafeResultByCode['recovery_deactivated']>;
```

The prepare input never contains `previewFingerprint` or confirmation. The server returns the fingerprint only after deriving and locking the safe eligibility preview; confirm adds that exact fingerprint and the fixed `activate_persistent_recovery` literal to form the private command.
The deactivation prepare input includes the route-derived `refundId` only for service-level
refund/allocation membership validation; the confirm parser removes it and submits the
established grant/reference/timestamp private command. Graph, reference, or timestamp drift
is `conflict/stale_state`, not a new public preview reason.

- [ ] **Step 2: Write failing eligibility and protected-transition tests**

Activation requires all of:

- immutable finalization effect `revoked_by_finalization`;
- the same administrative allocation/refund/order item/exact purchase grant;
- purchase grant not already revoked before finalization;
- the command's exact `expectedCorrectionSetId`, `expectedCorrectionVersion`, and `expectedSourceFingerprint` still match the current compatible correction tip and current projection source below the full-refund threshold;
- the active projection implementation, current projection head/items, correction base/tip, and finalization provenance are mutually linked with no `correction_rebase_required` or incomplete projection; and
- a claimed purchase grant whose non-null user/title is derived from the locked grant.

It never reads `commerce_claim_issuances`, credential authority, email identity, or claim proof; never manufactures/claims a user; and never accepts user/title from the caller. Test ineligibility before claim, then run the real protected register -> authorize -> claim lifecycle and prove a fresh preview becomes eligible.

The preview fingerprint covers the exact refund, finalization effect, order item, correction-set ID/version, source fingerprint, active projection implementation, projected eligibility, and predicted access/email consequence. The executor re-reads and recomputes all of them under the canonical locks. Any changed correction ID/version, source fingerprint, projection head/implementation, provenance link, or preview is `conflict/stale_state`; only a current but causally ineligible relationship is `conflict/not_eligible`.

The worker calls only `transition_administrative_recovery_grant_after_admin_command(commandId)`. Direct worker/admin-row DML must fail the trigger. The routine requires the command's linked job to hold the current unexpired capability; job status and legacy lease columns alone are never authority. It re-parses the fixed command kind/input, independently rechecks the correction/source/projection/provenance linkage, derives the activation/deactivation target and expected state, creates/reactivates one unique linked administrative grant or explicitly revokes it, and returns only the derived grant/user/title transition needed for entitlement projection.

Pre-release authority correction: migrations 0012 and 0013 remain unmerged and undeployed
while this plan executes. Task 14 therefore corrects 0012's recovery routine in place before
the branch first reaches `main`, rather than preserving a known defect behind a redundant
0014 migration. The corrected routine must compare the recomputed fingerprint before
classifying a now-cumulative-full-refund relationship as ineligible, so post-prepare drift is
`stale_state`, while a fingerprint matching the current intrinsically ineligible state remains
`not_eligible`. Every existing-row transition timestamp must also be strictly greater than the
prior millisecond timestamp, preventing ABA concurrency tokens and email-dedupe reuse. Re-run
and recalibrate the exact catalog-v3 routine descriptor after this pre-release edit; no journal,
snapshot, signature, owner, ACL, security mode, or search path changes.
The routine and preview must also share the exact bounded closure of at most 100 succeeded
refunds; neither side may accept a causal graph that the other cannot represent and fingerprint.

- [ ] **Step 3: Implement and commit the pure eligibility/grant-origin boundary**

Run the two focused unit files to capture RED, implement only the preview eligibility and exact grant-origin matrix from Steps 1–2, then rerun and commit:

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/recovery.test.ts src/lib/server/commerce/grants.test.ts
# Expected first run: FAIL on missing preview/matrix behavior.
npx vitest run src/lib/server/commerce/financial/refund-review/recovery.test.ts src/lib/server/commerce/grants.test.ts
npm run check
git diff --check
git add src/lib/server/commerce/financial/refund-review/recovery.ts src/lib/server/commerce/financial/refund-review/recovery.test.ts src/lib/server/commerce/grants.ts src/lib/server/commerce/grants.test.ts
git diff --cached --check
git commit -m "feat: define administrative recovery eligibility"
```

Expected after implementation: both unit files pass; no worker registration, grant transition, entitlement, outbox, or email code is included in this commit.

- [ ] **Step 4: Write failing lock, persistence, email, and atomicity tests**

Activation uses role advisory -> shared financial-admin lease advisory -> command -> active projection -> order/payment/full purchase/financial closure -> provenance -> current correction -> sorted entitlement scopes/grants. It never starts at entitlement/provenance and never acquires guest-identity/claim/user locks after an order.

After activation, run a later correction, refund, dispute, and classifier rebase; the administrative grant remains active. Only confirmed deactivation changes it. Both operations project effective entitlement, enqueue email only on effective access change, audit as the original administrator, and store command result in one transaction.

Add the minimized template `commerce.administrative-recovery-access-changed` with no administrator identity, internal/provider ID, amount, recipient in logs, or action link. Use dedupe `commerce:recovery-access:<grant-id>:<active|revoked>:<transition-epoch-ms>` from the actual row transition; replay does not change time or enqueue.

Test concurrent correction/finalization/recovery barriers; correction ID/version drift; source-fingerprint drift; projection-head/implementation drift; cumulative full refund making activation stale; two activations; another active grant; exact replay; deactivation replay; stale/forged/expired capability; and forced routine/projection/audit/outbox failures with full rollback.

Also force an existing recovery row's millisecond timestamp ahead of the database clock, then
execute active -> revoked -> active. Assert each returned concurrency token is strictly
monotonic and all three access-change dedupe keys remain distinct.

- [ ] **Step 5: Write failing confirmation UI tests**

Preview states the exact title/access transition and that the override persists through future refund/correction/dispute processing until separate deactivation. Use native prepare/confirm plus shared async status; no `window.confirm`.

- [ ] **Step 6: Run focused tests and confirm RED**

```powershell
npx vitest run src/lib/types/financial-reporting.test.ts src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/recovery.test.ts src/lib/server/commerce/financial/admin-commands/handler.test.ts src/lib/server/commerce/grants.test.ts src/lib/server/commerce/email/payload.test.ts src/lib/server/commerce/email/enqueue.test.ts src/lib/server/commerce/email/render.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts scripts/storage-process-isolation.test.ts
npm run test:integration -- tests/integration/financial-administrative-recovery.test.ts tests/integration/commerce-claims.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-disputes.test.ts tests/integration/commerce-lock-order.test.ts tests/integration/financial-lock-order.test.ts
```

Expected: FAIL because protected recovery behavior and UI do not exist.

- [ ] **Step 7: Implement both recovery executor functions and prove complete composition in tests**

Do not mutate a shared registry. Handler tests now pass all six real executor functions to `createFinancialAdminCommandExecutors(...)` and require exactly six fixed entries. No shared incomplete executor is exported and no partial production handler is registered. Do not alter purchase-grant provenance, reporting allocations, copy counts, or claim authority.

- [ ] **Step 8: Run domain GREEN and commit recovery behavior**

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/recovery.test.ts src/lib/server/commerce/financial/admin-commands/handler.test.ts src/lib/server/commerce/grants.test.ts src/lib/server/commerce/email/payload.test.ts src/lib/server/commerce/email/enqueue.test.ts src/lib/server/commerce/email/render.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
npx vitest run scripts/financial-schema-preservation.test.ts scripts/commerce-operations.test.ts
npm run test:integration -- tests/integration/financial-administrative-recovery.test.ts tests/integration/commerce-claims.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-disputes.test.ts tests/integration/commerce-lock-order.test.ts tests/integration/financial-lock-order.test.ts
npm run check
npm run lint
git diff --check
git add docs/superpowers/specs/2026-08-20-plan-6b-ii-implementation-refresh-design.md docs/superpowers/plans/2026-08-20-backend-plan-6b-ii-admin-resolution-reporting-refresh.md drizzle/0012_plan6bii_admin_command_authority.sql scripts/verify-financial-restore.sql docs/stripe-financial-reconciliation.md src/lib/server/commerce/financial/refund-review/recovery.ts src/lib/server/commerce/financial/refund-review/recovery.test.ts src/lib/server/commerce/financial/admin-commands/handler.test.ts tests/integration/financial-administrative-recovery.test.ts tests/integration/commerce-claims.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-disputes.test.ts tests/integration/commerce-lock-order.test.ts tests/integration/financial-lock-order.test.ts src/lib/components/admin/AdministrativeRecoveryActions.svelte src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts src/lib/server/commerce/email/payload.ts src/lib/server/commerce/email/payload.test.ts src/lib/server/commerce/email/enqueue.ts src/lib/server/commerce/email/enqueue.test.ts src/lib/server/commerce/email/render.ts src/lib/server/commerce/email/render.test.ts
git add -- ':(literal)src/routes/admin/sales/refunds/[refundId]/+page.server.ts' ':(literal)src/routes/admin/sales/refunds/[refundId]/+page.svelte'
git diff --cached --check
git commit -m "feat: add administrative access recovery"
```

Expected: all domain commands pass; the existing `tests/integration/financial-recovery.test.ts` durable-job suite remains untouched and green.

- [ ] **Step 9: Register the complete production handler under a separate RED -> GREEN commit**

First require `scripts/storage-process-isolation.test.ts` and the handler test to fail because no production registration exists. Then modify `src/worker.ts` to call `createFinancialAdminCommandExecutors` once with the six explicitly named concrete functions, bind that returned complete map to `createFinancialAdminCommandHandler` using the worker database, and register exactly `FINANCIAL_ADMIN_COMMAND_JOB`. This is the only production composition site. Prove the web composition root never imports the executor/handler or worker credential.

```powershell
npx vitest run src/lib/server/commerce/financial/admin-commands/handler.test.ts scripts/storage-process-isolation.test.ts
npm run check
npm run lint
git diff --check
git add src/worker.ts src/lib/server/commerce/financial/admin-commands/handler.test.ts scripts/storage-process-isolation.test.ts
git diff --cached --check
git commit -m "feat: register financial administrator commands"
```

Expected after implementation: both tests pass, all six and only six kinds are registered, and only the worker composition root owns execution.

### Task 15: Harden authorization, audit atomicity, privacy, and lock ordering across every surface

**Files:**
- Modify: `docs/superpowers/plans/2026-08-20-backend-plan-6b-ii-admin-resolution-reporting-refresh.md`
- Create: `tests/integration/financial-authorization-audit.test.ts`
- Create: `tests/integration/financial-admin-command-races.test.ts`
- Create: `src/lib/server/commerce/financial/admin-commands/errors.ts`
- Modify: `src/lib/server/commerce/financial/admin-commands/handler.ts`
- Modify: `src/lib/server/commerce/financial/admin-commands/repository.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/finalize.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/corrections.ts`
- Modify: `src/lib/server/commerce/financial/refund-review/recovery.ts`
- Modify: `tests/integration/audit-query.test.ts`
- Modify: `tests/integration/financial-admin-commands.test.ts`
- Modify: `tests/integration/financial-lock-order.test.ts`
- Modify: `tests/integration/financial-reclassification.test.ts`
- Modify: `src/routes/admin/sales/sales-routes.test.ts`
- Modify: `src/routes/admin/sales/refunds/refund-routes.test.ts`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.server.ts`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.svelte`
- Modify: `src/lib/components/admin/SalesOverview.test.ts`
- Modify: `src/lib/components/admin/RefundReview.test.ts`
- Modify: `scripts/commerce-privacy.test.ts`
- Modify: `tests/e2e/commerce-privacy.ts`
- Modify: `scripts/process-secret-scope.test.ts`
- Modify: `scripts/storage-process-isolation.test.ts`
- Modify: `vitest.integration.config.ts`

- [ ] **Step 1: Write the complete route/service/command capability matrix**

For every loader, endpoint, and action added in Tasks 7–14, test anonymous, customer, administrator missing the required capability, and fully authorized administrator. Assert authorization occurs before parsing path IDs, query strings, form bodies, command payloads, or CSV filters. The expected policy is:

| Surface | Required capability |
|---|---|
| Sales overview, issue/refund/payout list and detail, command status | `sales.read` |
| CSV export | `sales.read` + `sales.export` |
| Draft, finalization, correction, recovery submit/preview | `sales.read` + `reconciliation.manage` |

Use the injectable capability resolver from Task 2 to exercise a real administrator missing one capability. Do not weaken this to an `admin`-role-only assertion.

- [ ] **Step 2: Write audit visibility and atomicity regressions**

Prove:

- list/filter/pagination operations do not create detail/export audit rows;
- each successfully returned issue/refund/payout detail creates exactly one fixed-action audit row with actor, resource, request correlation, and no provider/customer secret;
- each successful complete CSV creates exactly one `financial.sales_export` audit row with only fingerprint/count metadata;
- a DTO/serialization/size/deadline/audit failure returns no detail/download and commits no audit;
- every state-changing successful command writes one fixed administrator action attributed to the submitting administrator in the same transaction as the domain transition and safe terminal result; exact terminal replay and a freshly evaluated semantic no-op create no new mutation audit;
- denied/conflict/failed commands use their fixed safe audit actions and contain no private input or internal error; and
- audit queries expose the new minimized metadata without exposing command payloads, email, provider object IDs, tokens, or arbitrary JSON.

- [ ] **Step 3: Add deterministic named PostgreSQL race witnesses**

Use unique transaction-local `application_name` values and an owner observer that requires the exact blocked PID, exact blocker PID in `pg_blocking_pids`, `wait_event_type = 'Lock'`, and the expected advisory/row lock query. Cover:

1. administrator demotion versus submit;
2. administrator demotion versus worker execution;
3. idempotent replay versus the same pending command;
4. draft save versus finalization;
5. finalization versus correction;
6. correction versus classifier rebase; and
7. recovery versus correction/refund/dispute;
8. handler shared lease versus heartbeat shared lease;
9. expired-claim takeover exclusive lease versus the old handler shared lease; and
10. terminal job exclusive lease/command synchronization versus command execution.

Assert the canonical prefix everywhere:

```text
administrator-role advisory lock
  -> per-job shared financial-admin lease advisory lock
  -> command/idempotency row
  -> active projection implementation (projection-dependent finalization, correction, and recovery kinds only)
  -> order/payment/full purchase graph
  -> replay enrollment and full financial closure (projection-dependent finalization, correction, and recovery kinds only)
  -> provenance/current correction
  -> sorted entitlement scopes and grants
```

Draft save/discard stops after the purchase graph and never takes projection/financial/entitlement locks. Finalization, correction, and recovery all depend on current projection authority and therefore take the projection prefix even when recovery does not rewrite projection rows. Replace the existing synthetic finalization-style reclassification witness with the real administrator command handler plus finalization executor so the test cannot encode purchase-before-projection order that production forbids.

Pin the complementary repository orders exactly: claim/takeover/complete/fail lock and revalidate the job row before the per-job exclusive lease advisory lock; heartbeat locks/revalidates the job row before the shared lease advisory lock and never locks a command. A command-holding transaction never waits for a job row or lease lock. Prove shared handler/heartbeat coexistence, exclusive takeover/terminal blocking on the exact shared-lock PID, release without deadlock, database-clock expiry, strictly increasing generation on retry/takeover, and rejection of a resumed old session using the former token. Exercise missing, forged, cross-job, prior-attempt, prior-generation, renewed-after-expiry, and invalidated tokens with unchanged job/claim/command/domain/audit state. Establish expiry with an owner fixture update or bounded database-clock barrier, never an elapsed-time assumption or fixed sleep.

Every blocker/probe transaction, connection, pool, and injected pause must be inside bounded `try/finally` cleanup. Never infer blocking from elapsed time alone.

- [ ] **Step 4: Extend static and runtime privacy scans**

Reject these strings or values from HTML, JSON, CSV, logs, audit metadata, status responses, command safe results, email payloads, and browser artifacts unless a specific DTO field explicitly permits them:

- private command JSON and idempotency keys;
- job ID, attempts, clear financial-admin lease capability, capability digest, generation, expiry, and `last_error`;
- Stripe secrets, provider request/response bodies, and every charge/refund/dispute/payout provider ID; new Plan 6B-II browser DTOs, CSV, status, audit metadata, email, and logs may contain only the explicitly named internal UUIDs, while canonical provider columns remain server-only;
- claim proof, auth token, password/reset/magic-link token, raw email, IP address, and user-agent;
- internal SQL errors, stack traces, database role names, and filesystem paths.

Keep the tests structural and value-based. Do not add broad source-string exclusions that could hide a leak.

Use one fresh 256-bit base64url secret sentinel in the real claim/handler/heartbeat/terminal path. Assert that, outside the deliberately transient transaction-local setting, it is present only in the in-memory internal `JobRecord` handed to the runner and is absent from all queryable text/JSON columns in jobs, commands, claims, audit, outbox/email, every captured log/error, status/API/HTML/CSV/browser artifact, and restore-verifier output. The claim table must contain only the sentinel's lowercase SHA-256 digest; even that digest remains absent from public DTOs, logs, audit, and browser surfaces.

- [ ] **Step 5: Run focused tests and confirm RED**

```powershell
npx vitest run src/routes/admin/sales/sales-routes.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/SalesOverview.test.ts src/lib/components/admin/RefundReview.test.ts scripts/commerce-privacy.test.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts
npm run test:integration -- tests/integration/financial-authorization-audit.test.ts tests/integration/financial-admin-command-races.test.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-lock-order.test.ts tests/integration/financial-reclassification.test.ts tests/integration/audit-query.test.ts
```

Expected: the new matrix, audit, race, or privacy assertions fail until every cross-surface boundary is wired.

- [ ] **Step 6: Make only proven bounded corrections**

Fix the exact route/service/lock/audit/privacy defect demonstrated by each RED. The Files and commit list for this hardening task intentionally begin with test surfaces only. If a RED proves that a production file must change, stop before editing, amend this task through review to add that exact production path to both **Files** and Step 7's literal `git add` command, then make the minimal fix. Do not leave a production correction unstaged or hide it behind a directory/wildcard add. Do not grant web table DML, give routes a worker/owner client, weaken exact failure counts, replace PID witnesses with sleeps, or add generic redaction after serialization.

Reviewed RED amendment (2026-08-22): the complete capability matrix proved that refund
detail requires only `sales.read`, while mutation seed generation and every form require
`reconciliation.manage`; the loader currently requires both and the page has no
read-only presentation gate. The process-isolation scan also proved that the refund web
route imports the worker handler module solely for its conflict error. The bounded
correction therefore adds a neutral command-error module, updates the handler to consume
and re-export those identities, imports the neutral error from the web route, returns an
explicit `canManageReconciliation` flag with no mutation seeds or idempotency identities
for a read-only administrator, and gates every mutation form on that flag. Only the four
production paths added above are authorized by this amendment.

Reviewed RED amendment (2026-08-22): the all-six command capability matrix proved
that `submitFinancialAdminCommand` parses a malformed idempotency key before checking
the submitting administrator's command capabilities. The bounded correction moves only
that canonical UUID parse behind the existing pre-transaction capability check in
`admin-commands/repository.ts`; command-kind selection remains the minimum input needed
to select the fixed capability policy, and private-command parsing/hashing remains after
authorization. No database routine, route, handler, executor, or DTO contract changes.

Reviewed RED amendment (2026-08-22): independent pre-commit dependency review proved
that the refund route's preview modules still value-import the three command error
classes from `admin-commands/handler`, so the web graph transitively loads the worker
handler despite the direct route import having moved to the neutral error module. The
bounded correction updates only `refund-review/finalize.ts`, `corrections.ts`, and
`recovery.ts` to value-import those errors from `admin-commands/errors.ts` while retaining
`FinancialAdminCommandExecutorContext` as a type-only handler import. Extend the existing
process-isolation test with an explicit route-reachable dependency assertion so a future
value import cannot recreate this web-to-worker edge. No executor composition, runtime
behavior, database authority, or DTO changes.

Reviewed RED amendment (2026-08-22): independent privacy review proved that the fresh
lease sentinel's real claim/handler/heartbeat/terminal witness covered persisted rows,
captured errors, and the repository status DTO, while the HTML, CSV, browser, and
restore-output assertions used unrelated fabricated canaries. Extend that same
integration witness to invoke the real command-status `GET` endpoint with the real actor
and command, decode and scan its response body and headers, server-render the production
command-status component, load that rendered HTML into a headless browser, and scan both
`page.content()` and visible body text. Produce and decode bytes through the real bounded
Sales CSV export. Run the executable restore-verifier mode against that same disposable
database and capture and scan both stdout and stderr. Scan every decoded artifact for
the one in-memory capability and its digest. Browser/context/page closure belongs in
`finally`; the verifier subprocess must have a bounded timeout and termination. Add the
SvelteKit transform to `vitest.integration.config.ts` solely so the Node integration
suite can import and server-render the production component; do not add a capability
injection, environment variable, file, log field, or other clear-secret transport. This
is evidence-only and does not alter application runtime behavior.

- [ ] **Step 7: Run GREEN and commit**

```powershell
npx vitest run src/routes/admin/sales/sales-routes.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/SalesOverview.test.ts src/lib/components/admin/RefundReview.test.ts scripts/commerce-privacy.test.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts
npm run test:integration -- tests/integration/financial-authorization-audit.test.ts tests/integration/financial-admin-command-races.test.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-lock-order.test.ts tests/integration/financial-reclassification.test.ts tests/integration/audit-query.test.ts
npm run check
npm run lint
git diff --check
git add docs/superpowers/plans/2026-08-20-backend-plan-6b-ii-admin-resolution-reporting-refresh.md tests/integration/financial-authorization-audit.test.ts tests/integration/financial-admin-command-races.test.ts tests/integration/audit-query.test.ts tests/integration/financial-admin-commands.test.ts tests/integration/financial-lock-order.test.ts tests/integration/financial-reclassification.test.ts src/lib/server/commerce/financial/admin-commands/errors.ts src/lib/server/commerce/financial/admin-commands/handler.ts src/lib/server/commerce/financial/admin-commands/repository.ts src/lib/server/commerce/financial/refund-review/finalize.ts src/lib/server/commerce/financial/refund-review/corrections.ts src/lib/server/commerce/financial/refund-review/recovery.ts src/routes/admin/sales/sales-routes.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/SalesOverview.test.ts src/lib/components/admin/RefundReview.test.ts scripts/commerce-privacy.test.ts tests/e2e/commerce-privacy.ts scripts/process-secret-scope.test.ts scripts/storage-process-isolation.test.ts vitest.integration.config.ts
git add -- ':(literal)src/routes/admin/sales/refunds/[refundId]/+page.server.ts' ':(literal)src/routes/admin/sales/refunds/[refundId]/+page.svelte'
# Run every additional literal git add command introduced by a reviewed Step 6 plan amendment.
git diff --cached --check
git commit -m "test: harden financial administrator boundaries"
```

Expected: all focused tests pass and the commit contains tests plus only the narrowly proven corrections.

### Task 16: Prove the administrator journeys in a provider-neutral browser harness

**Files:**
- Create: `tests/e2e/financial-harness.ts`
- Create: `tests/e2e/sales-reporting.spec.ts`
- Create: `tests/e2e/refund-review.spec.ts`
- Create: `src/lib/server/jobs/test-worker-control.ts`
- Create: `src/lib/server/jobs/test-worker-control.test.ts`
- Modify: `tests/e2e/database.ts`
- Modify: `tests/e2e/commerce-harness.ts`
- Modify: `tests/e2e/admin.spec.ts`
- Modify: `tests/e2e/commerce-privacy.ts`
- Modify: `src/worker.ts`
- Modify: `playwright.config.ts`
- Modify: `scripts/playwright-commerce-config.test.ts`
- Modify: `scripts/storage-process-isolation.test.ts`

- [ ] **Step 1: Write failing harness-fidelity tests**

Create an import-safe financial E2E harness that:

- uses the existing web `db` only for browser-equivalent reads/submissions;
- uses `workerDb` only for fixture publication/setup that mirrors worker-owned background facts;
- executes every administrator command exclusively in the spawned `src/worker.ts` process through its production-registered handler; `financial-harness.ts` must not import the handler, executor builder, or any concrete executor;
- uses the owner role only to create or corrupt explicit fixtures before the tested application path;
- never adds a fixture HTTP route, fake completion endpoint, direct command-table mutation, or provider network request; and
- records unique fixture IDs without printing tokens, emails, or private command inputs.

Implement the protocol in the import-safe `test-worker-control.ts`, not in the side-effectful top level of `src/worker.ts`. Its nonce is exactly 32 lowercase hexadecimal characters generated from 16 random bytes. It may activate only when a worker-scoped isolation predicate proves all of: `APP_ENV=test`; an exact generated `pale-orbit-test-<16 lowercase hex>` project; loopback host and the non-default `pale_orbit_test` database; `DATABASE_WORKER_USER=pale_orbit_test_worker`; no generic web or owner user/password direct or `_FILE` setting; concurrency one; and an absolute `worker.ready` path beneath the owned `pale-orbit-test-storage-*` temporary root. An inactive controller must not read, stat, write, or unlink any control sibling. Do not add another caller-selected path or production setting.

Use this exact two-phase, one-logical-request state machine:

1. the harness atomically creates `{ version: 1, nonce, phase: 'pause' }` at the fixed control sibling;
2. before claim, the worker validates it and atomically writes `{ version: 1, nonce, phase: 'paused' }` at the fixed acknowledgement sibling;
3. after observing that exact acknowledgement, the harness submits the browser command, receives its `commandId`, and performs any demotion;
4. the harness atomically replaces the request with the same nonce and `{ version: 1, nonce, phase: 'release', failCommandId? }`;
5. the worker re-reads and validates that exact same-nonce revision immediately before claim, writes the matching released acknowledgement, and only then returns from the pre-poll hook; and
6. an optional canonical `failCommandId` remains armed across unrelated jobs, decorates only that ID's real registered executor with `FinancialAdminPermanentError('command_failed')`, and is consumed exactly once on the matching invocation.

Reject a different concurrent nonce, a reused completed nonce, a release before its paused acknowledgement, duplicate/multiple/invalid IDs, malformed or noncanonical JSON (including duplicate/unknown/out-of-order keys), symlink or lexical path escape, or a missing/stale/mismatched acknowledgement. Sequential requests are allowed only after the prior targeted command is terminal and nonce-owned cleanup is complete; the harness must arm and receive the next paused acknowledgement before submitting the next target command. Cleanup compares the current nonce before unlinking, so an older `finally` cannot remove a newer request or acknowledgement.

Every control-file wait is condition-polled with an explicit five-second deadline and the appropriate `AbortSignal`: the worker controller signal inside the spawned worker and a harness-owned test signal while awaiting acknowledgements. No fixed sleep establishes correctness. Export one import-safe orchestration seam that performs: fail-closed control preflight -> the injected bounded purge/scheduling callback -> a final same-nonce control re-read/barrier and released acknowledgement as the last action before hook return. A preflight failure records the error, aborts the worker, and skips maintenance. The final barrier observes a pause created during maintenance and holds the hook until its exact release. Any final-barrier failure records the error and aborts. `prepareWorkerPoll` delegates that whole sequence; the existing worker loop observes an aborted signal before `claimNext`. After `runWorker` returns, `src/worker.ts` calls the controller's `throwIfFailed()` so the process exits nonzero.

The table-driven unit suite must:

- vary each activation conjunct above one at a time and use filesystem spies to prove zero read/stat/write/unlink calls whenever any conjunct fails;
- use the real `runWorker` with a fake repository to prove malformed control yields zero `claimNext` calls and a pause arriving during injected maintenance also yields zero claims until exact release;
- prove the exact canonical pause/release/ack JSON and nonce grammar, both handshake phases, different concurrent and reused-completed nonce rejection, release-before-paused rejection, duplicate/multiple/invalid IDs, malformed/noncanonical/unknown-key JSON, lexical and symlink escape, missing/stale/mismatched acknowledgements, abort/deadline behavior, matching-ID exact-once failure, unrelated-job preservation, and nonce-owned cleanup; and
- prove one completed request can be followed by a fresh nonce only after its target is terminal and cleanup has completed.

`scripts/storage-process-isolation.test.ts` additionally proves no non-test/production composition can activate the controller. After the harness exists in Step 6, `scripts/playwright-commerce-config.test.ts` separately proves that `financial-harness.ts` cannot import the handler, executor builder, or concrete executors.

If `playwright.config.ts` changes, keep its import-time test guard safe: the static test must use controlled environment stubs/dynamic import and must not start a database or web server.

- [ ] **Step 2: Write a failing Sales reporting journey**

In `sales-reporting.spec.ts`, prove the complete reporting acceptance matrix rather than one happy path:

1. empty and populated Overview states from the direct URL while global navigation is still intentionally disabled;
2. date, title, format, currency, and operational-state filters, stable pagination, and exact per-title signed metrics;
3. multi-currency and FX data, known zero versus unavailable settlement values, and whole-pair unavailability when any required settlement component is incomplete;
4. renamed and archived title history plus sold-as title/format detail;
5. Needs Review membership based only on the shared operational predicate, followed by one audited issue-detail read;
6. pending, completed-automatic, failed-after-paid, and manual/instant payout list/detail states—including the exact manual/instant limitation copy—without provider calls;
7. the discoverable Overview export control and direct endpoint both download the full filtered CSV beyond the current page, preserve negative numeric parity, reject the 10,001st-row/byte/deadline bounds without a partial file, and append exactly one audit only on success; and
8. keyboard-only navigation at 320 CSS pixels and 200% zoom with visible focus, usable reflow, meaningful labels, and live announcements.

Also prove an anonymous user and a customer each receive the same safe denial for malformed and well-formed URLs, and no private/audit-only values appear in DOM, responses, downloads, traces, or console output.

- [ ] **Step 3: Write a failing refund command journey**

In `refund-review.spec.ts`, use two promoted administrators, the real worker, and the deterministic control barrier to prove:

- ambiguous-refund draft save/discard, two-administrator optimistic conflict, prepare/confirm finalization, terminal polling, access-effect display, conditional email, fixed audit attribution, and no resubmission;
- preserved access when another active grant exists;
- append-only correction changes refund principal and the linked refund-fee title metrics while provider totals, historical refunded copy, and already-decided access remain unchanged;
- recovery is ineligible before the real claim lifecycle, becomes eligible afterward, persists through later correction/refund/dispute processing, preserves the explicit override copy, and can be deactivated without changing financial metrics;
- demotion after submit but before claim is acknowledged by the barrier and produces `denied` when the actual worker is released;
- a one-shot `failCommandId` request produces a genuine worker/handler `failed/command_failed` terminal state without the harness directly mutating the command/job or faking an HTTP response; and
- navigation abort stops further polling requests.

Use locator assertions and `expect.poll`; never use fixed sleeps. Assert `denied`, `conflict`, and `failed` render distinct live-region guidance without an automatic retry button. Keep the failure control explicitly diagnostic: domain correctness remains covered by the real executor integration suites, while this one-shot path proves the browser, real job runner, safe terminal transition, and retry policy without exposing an internal error.

- [ ] **Step 4: Run the worker/harness contracts and capture RED before implementation**

First run the service-free contracts:

```powershell
npx vitest run src/lib/server/jobs/test-worker-control.test.ts scripts/playwright-commerce-config.test.ts scripts/storage-process-isolation.test.ts
```

Expected: FAIL on the absent import-safe control state machine, spawned-worker-only source contract, or isolated activation proof.

Then claim the serialized service slot, record the resource/temp baseline, and run each newly written journey once before implementing the protocol/harness:

```powershell
npm run test:e2e -- tests/e2e/sales-reporting.spec.ts tests/e2e/admin.spec.ts
npm run test:e2e -- tests/e2e/refund-review.spec.ts tests/e2e/admin.spec.ts
```

Expected: both pre-implementation invocations record their first intended missing-harness/control or browser-contract assertion and then prove exact teardown. Do not start the second command until the first has exited and its baseline is restored; do not weaken an assertion merely because earlier unit/integration work already satisfies another part of the journey.

- [ ] **Step 5: Implement and commit the fail-closed worker control**

```powershell
npx vitest run src/lib/server/jobs/test-worker-control.test.ts scripts/storage-process-isolation.test.ts
npm run check
npm run lint
git diff --check
```

Expected: the control/isolation checks pass; the behavioral controller test proves fatal no-claim behavior, the maintenance-arrival race, and the full negative matrix without starting Docker/PostgreSQL.

Commit only the reviewed control boundary before browser acceptance:

```powershell
git add src/lib/server/jobs/test-worker-control.ts src/lib/server/jobs/test-worker-control.test.ts src/worker.ts scripts/storage-process-isolation.test.ts
git diff --cached --check
git commit -m "test: add deterministic financial worker control"
```

- [ ] **Step 6: Implement the reusable harness and run its static and browser GREEN gates**

Implement the harness/config support against the committed control protocol. Run its service-free contract first:

```powershell
npx vitest run src/lib/server/jobs/test-worker-control.test.ts scripts/playwright-commerce-config.test.ts scripts/storage-process-isolation.test.ts
npm run check
npm run lint
git diff --check
git diff --exit-code -- src/lib/server/jobs/test-worker-control.ts src/lib/server/jobs/test-worker-control.test.ts src/worker.ts scripts/storage-process-isolation.test.ts
```

Then record the resource/temp baseline before each browser command and prove exact teardown afterward:

```powershell
npm run test:e2e -- tests/e2e/sales-reporting.spec.ts tests/e2e/admin.spec.ts
npm run test:e2e -- tests/e2e/refund-review.spec.ts tests/e2e/admin.spec.ts
```

Expected: both commands exit zero with one owned disposable harness at a time; the real web and worker processes exercise the same command/status path used in production, and each harness self-cleans.

The control module, its test, `src/worker.ts`, and `scripts/storage-process-isolation.test.ts` must remain byte-unchanged from the Step 5 commit throughout this browser tranche. If browser GREEN instead proves a control defect, stop: capture a focused controller RED, apply the minimal correction, rerun the full Step 5 controller/isolation gate, make a separate reviewed controller commit, then restart Step 6. If either browser RED proves any other product defect outside the listed Task 16 files, amend this task through review with that exact path, focused RED/GREEN command, and literal staging command. Do not hide product or controller changes in the browser-evidence commit.

- [ ] **Step 7: Commit browser evidence**

```powershell
git add tests/e2e/financial-harness.ts tests/e2e/sales-reporting.spec.ts tests/e2e/refund-review.spec.ts tests/e2e/database.ts tests/e2e/commerce-harness.ts tests/e2e/admin.spec.ts tests/e2e/commerce-privacy.ts playwright.config.ts scripts/playwright-commerce-config.test.ts
# Run every additional literal git add command introduced by a reviewed Task 16 amendment.
git diff --cached --check
git commit -m "test: cover financial administrator journeys"
```

### Task 17: Generalize Plan 6B operations, enable Sales, and close the release evidence

**Files:**
- Modify: `package.json`
- Modify: `scripts/plan6b-production-smoke.ts`
- Modify: `scripts/plan6b-production-smoke.test.ts`
- Modify: `scripts/plan6b-fixture-runtime-probe.ts`
- Modify: `scripts/plan6b-fixture-runtime-probe.test.ts`
- Modify: `scripts/guest-claim-authority.test.ts`
- Modify: `scripts/database-role-deployment.test.ts`
- Modify: `scripts/financial-schema-preservation.test.ts`
- Modify: `scripts/commerce-operations.test.ts`
- Modify: `scripts/commerce-privacy.test.ts`
- Modify: `scripts/with-plan6b-upgrade-database.test.ts`
- Modify: `scripts/deployment-backup-bundle.test.ts`
- Modify: `scripts/deployment-checkpoint.test.ts`
- Modify: `scripts/deployment-checkpoint-runtime.test.ts`
- Modify: `src/routes/admin/sales/sales-routes.test.ts`
- Modify: `src/routes/admin/+layout.svelte`
- Create: `docs/financial-reconciliation-and-reporting.md`
- Modify: `README.md`
- Modify: `docs/stripe-financial-reconciliation.md`
- Modify: `docs/commerce-and-guest-claims.md`
- Modify: `docs/database-and-workers.md`
- Modify: `docs/runtime-environments.md`
- Modify: `docs/storage-ingestion-and-publication.md`
- Modify: `docs/dependency-decisions.md`
- Modify: `docs/authentication-and-email.md`
- Modify: `docs/customer-library-and-reader.md`
- Modify: `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md`
- Modify: `docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md`
- Modify: `docs/superpowers/specs/2026-08-20-plan-6b-ii-implementation-refresh-design.md`

- [ ] **Step 1: Write failing smoke-stage and release-status contracts**

Replace the checkpoint-specific public command/tag contract with one strict stage-aware Plan 6B contract:

```text
npm run smoke:plan6b -- --stage 6b-ii
npm run smoke:plan6b-fixture -- --stage 6b-ii
```

The manifest, image tag, lease, collision checks, fixture lookup, and cleanup proof must all include the exact stage. The fixture consumes the production image lease; it does not rebuild. Reject absent/unknown/duplicate stages and stale `plan6b-i` artifacts.

Make the public command transition exact: remove the legacy `smoke:plan6b-i` package entry, add only `smoke:plan6b`, and require `--stage 6b-ii`. The static contract must prove the old command key is absent and the generalized launcher rejects old `plan6b-i` tags, manifests, and leases rather than silently translating them.

Require fixture evidence for one canonical administrator command submitted through the web routine, claimed/executed by the worker, safely polled to terminal success, and reflected in Sales/audit data. Prove web denial of private command input, worker-only mutation, and zero external Stripe requests.

Add static assertions that production remains maintenance-mode and Stripe-disabled, the 14-artifact checkpoint bundle stays unchanged, and the current checkpoint capture/rehearse gates cover the new migration/table through their exhaustive journal, row-count, catalog, and DB-to-storage evidence. Every generated smoke, fixture, and checkpoint migration service must carry the exact three dedicated migration identity names but no application password; every generated non-migration service must omit them.

- [ ] **Step 2: Run the focused operational contracts and confirm RED**

```powershell
npx vitest run scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.test.ts scripts/guest-claim-authority.test.ts scripts/database-role-deployment.test.ts scripts/financial-schema-preservation.test.ts scripts/commerce-operations.test.ts scripts/commerce-privacy.test.ts scripts/with-plan6b-upgrade-database.test.ts scripts/deployment-backup-bundle.test.ts scripts/deployment-checkpoint.test.ts scripts/deployment-checkpoint-runtime.test.ts
```

Expected: FAIL on the stale `smoke:plan6b-i`/stage/evidence/status contracts.

- [ ] **Step 3: Implement the generalized smoke and fixture evidence**

Remove `smoke:plan6b-i`, add `smoke:plan6b`, and require the exact `6b-ii` stage contract established in RED. Preserve all existing four-principal secret scrubbing, preflight, owner migration/provisioning, migration-only identity-name transport, image digest, lease, exact-label ownership, collision refusal, bounded polling, and teardown behavior. Extend rather than fork the existing fixture poller; do not retain a compatibility alias that could accept stale checkpoint-I evidence.

- [ ] **Step 4: Lock the disabled candidate navigation and prove every Sales surface is green**

First add a candidate-stage assertion to `sales-routes.test.ts` that the global item remains `Sales — Upcoming` and has no live Sales link. Direct test navigation is the only pre-clearance entry. Then run:

```powershell
npx vitest run src/routes/admin/sales/sales-routes.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/SalesOverview.test.ts src/lib/components/admin/RefundReview.test.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.test.ts
npm run check
npm run lint
```

The commands must pass with the new assertion and the disabled `Sales — Upcoming` item still present. Do not edit `src/routes/admin/+layout.svelte` yet.

- [ ] **Step 5: Write the operator guide and candidate status**

Create `docs/financial-reconciliation-and-reporting.md` with the signed metric formulas, nullability/freshness rules, operational-review semantics, payout locality, CSV bounds, command status meanings, finalization/correction/recovery consequences, audit/privacy contract, and troubleshooting that never tells an operator to mutate protected rows or retry jobs directly.

Update all listed status/runbook documents to describe:

- Plan 6B-I and 6B-II as one candidate phase;
- migrations through 0013, the historical 0012 eight-routine boundary, the final nine-routine boundary, and the exact four database principals;
- web submit/status/audit routines versus worker mutation authority;
- migrate -> provision -> checkpoint capture -> distinct-engine rehearsal -> smoke ordering;
- the unchanged maintenance/Stripe-disabled production boundary; and
- Plan 7 as the remaining production-activation/operability phase.

Keep the status text exactly `Plan 6B candidate — independent review pending` until the final review loop succeeds.

- [ ] **Step 6: Commit the candidate operations/documentation changes**

```powershell
git add package.json scripts/plan6b-production-smoke.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.ts scripts/plan6b-fixture-runtime-probe.test.ts scripts/guest-claim-authority.test.ts scripts/database-role-deployment.test.ts scripts/financial-schema-preservation.test.ts scripts/commerce-operations.test.ts scripts/commerce-privacy.test.ts scripts/with-plan6b-upgrade-database.test.ts scripts/deployment-backup-bundle.test.ts scripts/deployment-checkpoint.test.ts scripts/deployment-checkpoint-runtime.test.ts src/routes/admin/sales/sales-routes.test.ts docs/financial-reconciliation-and-reporting.md README.md docs/stripe-financial-reconciliation.md docs/commerce-and-guest-claims.md docs/database-and-workers.md docs/runtime-environments.md docs/storage-ingestion-and-publication.md docs/dependency-decisions.md docs/authentication-and-email.md docs/customer-library-and-reader.md docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md docs/superpowers/specs/2026-08-20-plan-6b-ii-implementation-refresh-design.md
git diff --cached --check
git commit -m "docs: prepare Plan 6B reporting candidate"
```

- [ ] **Step 7: Run the complete service-free gate**

Run serially and record exit codes/output:

```powershell
npm ci
npm run auth:schema
git diff --exit-code -- src/lib/server/db/schema/auth.ts
npm run db:check
npm outdated --json
npm ls --depth=0
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
npm run check
npm run lint
npm run build
git diff --check
git status --short
```

`npm outdated --json` may return nonzero when it reports valid outdated dependencies; capture and review the JSON rather than misreporting it as a test failure. Any audit exception requires an explicit bounded rationale in the evidence, not a silent override.

- [ ] **Step 8: Run the complete service-backed gate one command at a time**

Claim the serialized Docker/PostgreSQL/Mailpit/Playwright slot for each command, record its owned resource/temp baseline, wait for its final exit code, release the slot, and prove exact teardown before starting the next:

```powershell
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:plan6b-upgrade
npx vitest run scripts/commerce-operations.test.ts -t "executes schema-object, source-parity, deterministic-allocation, audit, payout, and chronology verifier witnesses in PostgreSQL" --reporter=verbose
npm run smoke:plan6b -- --stage 6b-ii
npm run smoke:plan6b-fixture -- --stage 6b-ii
```

Expected: every command exits zero; exact catalog/ACL corruption witnesses repair cleanly; all upgrade fixtures reach 0013 and the v3 contract; browser journeys use the real worker; smoke and fixture share the validated production image lease; and no owned or foreign resource is mutated after cleanup.

`npm run test:unit` is deliberately in the serialized service-backed tranche because the current Vitest file set contains the supervised PostgreSQL restore witness. Do not assume its name makes it service-free and do not launch it concurrently with any other harness.

The real checkpoint acceptance remains an operator gate and requires two genuinely distinct approved Docker engines. Do not fake it with two contexts pointing at one engine and do not run it without those coordinates:

```powershell
npm run deployment:checkpoint -- capture --project <exact-source-project> --root <absolute-restricted-root> --backup-id <32-lowercase-hex> --context <approved-source-context> --engine-id <source-engine-id>
npm run deployment:checkpoint -- rehearse --root <absolute-restricted-root> --backup-id <same-id> --context <approved-restore-context> --engine-id <distinct-restore-engine-id>
```

- [ ] **Step 9: Request three independent bounded reviews of the exact candidate commit**

Review the same immutable commit in parallel lanes:

1. financial correctness, lock order, idempotency, projection, and access effects;
2. capability, database authority, audit, privacy, command replay, and restore catalog; and
3. Sales/refund UX, accessibility, E2E fidelity, smoke, checkpoint, docs, and release evidence.

Require ranked Critical/Important/Minor findings with exact files/lines and a GO/no-GO. Reviewers remain read-only and service-free.

If any finding is accepted, do not edit immediately. First amend this task through review to add every exact affected production/test/doc path to **Files**, its focused RED/GREEN command, and a literal `git add` command. Then, for each bounded finding set:

1. capture the focused RED;
2. make the minimal correction;
3. rerun focused GREEN plus `npm run check`, `npm run lint`, and `git diff --check`;
4. stage only the amendment's literal paths, run `git diff --cached --check`, inspect the staged diff, and commit with `fix: address Plan 6B candidate review`; and
5. rerun Steps 7–8 in full against that new commit.

After every accepted-finding commit, repeat all three review lanes against the new exact immutable HEAD. Continue the fix -> commit -> full-gate -> three-review loop until all three report GO with no unresolved Critical/Important/Minor findings. Only that re-reviewed candidate may proceed to Step 10; no review fix may remain dirty, merely staged, or outside a reviewed commit.

- [ ] **Step 10: Enable Sales, freeze final evidence, rerun everything, and rereview exact HEAD**

Only after the candidate gates and all three reviews are clear for the current exact HEAD, replace `Sales — Upcoming` in `src/routes/admin/+layout.svelte` with the live Sales link and change the route assertion from disabled to enabled. Make only the evidence/status changes that record exact commands, counts, current commit, and completed Plan 6B-II acceptance. Keep production maintenance mode and Stripe-disabled settings unchanged. Commit them:

```powershell
git add src/routes/admin/+layout.svelte src/routes/admin/sales/sales-routes.test.ts README.md docs/financial-reconciliation-and-reporting.md docs/stripe-financial-reconciliation.md docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md docs/superpowers/specs/2026-08-20-plan-6b-ii-implementation-refresh-design.md
git diff --cached --check
git commit -m "feat: complete Plan 6B reporting"
```

Rerun Steps 7 and 8 in full against the navigation-enabled commit. Then have the three reviewers inspect that exact final HEAD again, including the navigation/status commit and final evidence. Do not edit after final clearance. Record:

```powershell
git rev-parse HEAD
git status --short
git log -1 --oneline
```

Expected: all reviewers report no unresolved Critical/Important/Minor findings, the worktree is clean, and Plan 7 remains explicitly pending.

## Acceptance traceability

| Approved behavior | Implemented/proven in |
|---|---|
| Independent capabilities and authorize-before-parse | Tasks 2, 7–16 |
| Strict safe DTO/filter/cursor/money contracts | Tasks 2, 6–10 |
| Durable private command with web/worker authority split | Tasks 3–5, 11–15 |
| Stale-generation financial-admin lease capability, takeover, and secret isolation | Tasks 3–5, 14–15 |
| Execution-time role reauthorization and replay safety | Tasks 4, 15–16 |
| Exact migration/ACL/restore/upgrade/checkpoint parity | Tasks 3, 5, 13, 17 |
| Signed per-title reporting and aggregate CSV | Tasks 6–7, 10, 16 |
| Operational Needs Review and local payout detail | Tasks 8–9, 16 |
| Audited detail/export before response | Tasks 4, 8–10, 15 |
| Shared draft, one-way finalization, append-only correction | Tasks 11–13, 15–16 |
| Causally proven persistent recovery and explicit deactivation | Tasks 14–16 |
| Accessibility, responsive layout, polling cancellation, privacy | Tasks 7–16 |
| Stage-aware smoke, final navigation, docs, independent review | Task 17 |
| Production activation remains out of scope | Scope boundary and Task 17 |

## Executor handoff

- Start from the exact approved base named above and keep one task commit per boundary unless a task explicitly names multiple commits.
- Use `superpowers:subagent-driven-development` for same-session execution or `superpowers:executing-plans` for a separate execution session.
- Preserve the six command kinds, five statuses, audit vocabulary, job type, private claim-table/helper/trigger names, transaction-local setting names, and advisory lock prefix exactly. Migration 0012's historical surface remains eight callable routine signatures; after Task 13, migration 0013 adds only `resolve_financial_issue_after_reporting_correction_command(uuid,uuid)` for an exact final surface of nine. Any other signature change is a design change, not a convenient implementation detail.
- Preserve `role advisory -> shared lease advisory -> command row` for command work, `job row -> exclusive lease advisory -> claim/optional command sync` for claim/takeover/terminal work, and `job row -> shared lease advisory -> claim` for heartbeat. Never add a command-to-job/lease edge.
- Keep Task 3 and Task 5 as one atomic authority/catalog commit, including `types.ts`, `runner.ts`, and `runner.test.ts`; do not commit migration 0012 before the v2 manifest includes the private claim authority.
- Task 4 builds the handler and fixed registry interface but must not make an incomplete executor map reachable in production. Register the production job handler only when the first complete six-kind composition exists; until then, keep the factory test-only and fail closed on any unknown/missing executor.
- Run database-backed commands only under the serialized resource protocol. Never launch a duplicate command because output is quiet; poll the same process/session to its final exit.
- If any requirement is ambiguous, stop at the nearest task boundary and compare both approved design documents before changing code or authority.
