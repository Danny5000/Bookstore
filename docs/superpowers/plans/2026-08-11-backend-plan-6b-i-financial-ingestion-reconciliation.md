# Backend Plan 6B-I: Financial Ingestion and Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import minimized canonical Stripe balance transactions and payouts into an immutable local ledger, allocate all settlement effects exactly, derive current reconciliation state, and recover missed work through durable PostgreSQL jobs without exposing the administrator Sales UI yet.

**Architecture:** PostgreSQL remains the source of local financial truth, queue, scheduler checkpoint, lock authority, and audit store. Stripe retrieval and pagination finish before short transactions; immutable provider facts are staged independently; purchase-linked projection then enters the published order graph and uses signed `BigInt` allocation. Payout state is joined at read time rather than cached on purchase sources, and hourly/version-keyed jobs converge through permanent generation-specific deduplication keys.

**Tech Stack:** Node.js 26.7.0, npm 11.19.0, SvelteKit 2.70.2, Svelte 5.56.8, TypeScript 6.0.3, PostgreSQL 18.4, Drizzle ORM 0.45.2 and Drizzle Kit 0.31.10, Stripe Node 22.5.0 pinned to API version `2026-07-29.dahlia`, Zod 4.4.3, Vitest 4.1.10, and Playwright 1.62.1.

---

## Source of truth and checkpoint boundary

Implement checkpoint **6B-I** from `docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md`. Preserve the Plan 6A contracts in `docs/superpowers/specs/2026-08-10-stripe-commerce-guest-claims-design.md` and the roadmap boundary in `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md`.

This checkpoint owns:

- The single forward Plan 6B migration, including provider ledger tables and the empty draft/correction/recovery tables consumed by 6B-II.
- Canonical Charge, Refund, Dispute, Balance Transaction, and Payout provider DTOs.
- Signed allocation, classification, issue, state, lock, source-import, payout-import, scheduler, scan, and backfill services.
- Atomic Plan 6A reducer-to-financial-job handoff and payout webhook routing.
- Focused migration, replay, concurrency, privacy, Compose, and production-image verification.

This checkpoint does **not** enable the Sales navigation item, add administrator report routes, finalize ambiguous refunds, create reporting corrections or recovery grants, export CSV, mark full Plan 6B complete, or open production commerce. Those actions belong to 6B-II. Production stays `APPLICATION_MODE=maintenance`, base production Compose stays Stripe-disabled and credential-free, and Plan 7 still owns launch, general job retry UI, monitoring alerts, backup automation, and deployment hardening.

No real Stripe credential is needed. All automated tests use the existing fixture gateway and signed local events. If any automated command asks for `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET`, stop and repair the fixture/disabled boundary instead of asking the user for credentials.

## Non-negotiable invariants

- Unlike currencies are never added. Presentment and settlement domains remain explicit even when their ISO code matches.
- All money uses safe integer minor units. Allocation uses `BigInt` intermediates and conserves every signed source exactly.
- A Balance Transaction satisfies `netMinor = amountMinor - feeMinor`; fee allocation targets `-feeMinor`.
- Raw Stripe objects, webhook bodies, descriptions, destinations, metadata, customer/card/billing data, receipt URLs, secrets, and provider messages are never stored, audited, returned, or logged.
- Provider calls and pagination never run inside a database transaction or while a row/advisory lock is held.
- Plan 6A event terminal status remains reducer-derived `processed | exception`; an ambiguous multi-title refund still queues financial work after its local refund exists.
- Payout import-run entries are provisional. Only one complete atomic publication transaction creates authoritative payout membership.
- Purchase-linked work follows `event -> order advisory -> order -> payment -> refunds -> drafts/items -> finalized allocations/components -> corrections/items -> disputes/item rows -> order items -> payouts -> balance transactions -> classification versions -> allocation sets/items -> issues -> entitlement scopes -> grants`.
- Payout-only work follows `payout -> import run -> run entries -> sorted balance transactions -> membership -> issues` and never enters a purchase graph.
- `payout_reconciled` is derived from current payout/membership rows and is never cached on payments, refunds, or disputes.
- New classifier versions append evidence and superseding allocation sets. They never edit provider facts, old classifications, old allocations, or approved correction history.
- The migration performs no network access and maps every legacy `pending` or `reconciled` financial seam to `pending` until canonical evidence proves completeness.

## Target module map

Keep new files focused. Do not add substantial implementations to the existing large `commerce.ts`, `sdk-gateway.ts`, `fulfillment.ts`, `refunds.ts`, `commerce-lock-order.test.ts`, `commerce-operations.test.ts`, or browser commerce harness.

### Persistence

- `src/lib/server/db/schema/financial-provider.ts`: balance transactions, raw fee details, append-only classifications, payouts, import runs/entries, authoritative membership, and scan runs.
- `src/lib/server/db/schema/financial-allocation.ts`: allocation sets/items, issues, refund/dispute components, drafts/items, corrections/items, and finalization-effect provenance.
- `src/lib/server/db/schema/commerce.ts`: only enum/column changes for evidence/allocation state and administrative grant references.
- `drizzle/0007_plan6b_financial_reconciliation.sql` and `drizzle/meta/0007_snapshot.json`: generated schema plus reviewed custom immutable triggers/backfill.

### Financial kernel and services

- `src/lib/server/commerce/financial/constants.ts`, `errors.ts`, and `types.ts`: bounded vocabulary and safe worker failures.
- `src/lib/server/commerce/financial/allocations/`: signed largest remainder, charge/refund/dispute plans, current projection, and rebase.
- `src/lib/server/commerce/financial/classification.ts`, `ledger.ts`, `issues.ts`, and `state.ts`: append-only evidence and derived state.
- `src/lib/server/commerce/financial/locks.ts`: the shared order/payout lock contract.
- `src/lib/server/commerce/financial/sources/`: payment, refund, and dispute reducers.
- `src/lib/server/commerce/financial/payouts/`: payout refresh, page collection, publication, and impact projection.
- `src/lib/server/commerce/financial/scans/`: hourly/version-keyed scheduling, bounded recovery, and backfill.
- `src/lib/server/commerce/financial/handlers/`, `jobs.ts`, and `event-handoff.ts`: worker/job adapters and atomic Plan 6A handoff.

### Stable 6B-I exports consumed by 6B-II

```ts
export type FinancialSourceKind = 'payment' | 'refund' | 'dispute';
export type FinancialEvidenceStatus = 'pending' | 'fee_reconciled' | 'exception';
export type PublicFinancialState = FinancialEvidenceStatus | 'payout_reconciled';
export type AllocationBasis = 'gross_amount' | 'fee';
export type AllocationScope = 'title' | 'account' | 'unresolved';

export function derivePublicFinancialState(input: PublicFinancialStateInput): PublicFinancialState;

export async function loadCurrentEffectiveAllocationProjection(
  database: DatabaseExecutor,
  input: { balanceTransactionIds: readonly string[] }
): Promise<readonly CurrentEffectiveAllocationProjection[]>;

export const currentFinancialProjectionHeads: CurrentFinancialProjectionHeadsView;
export const currentFinancialProjectionItems: CurrentFinancialProjectionItemsView;

export async function recomputeLockedRefundFinancialProjection(
  transaction: DatabaseTransaction,
  input: LockedRefundProjectionInput
): Promise<RefundFinancialRecomputeResult>;

export async function rebaseApprovedCorrectionDistributionLocked(
  transaction: DatabaseTransaction,
  input: CorrectionRebaseInput
): Promise<{ status: 'rebased'; correctionSetId: string } | { status: 'exception'; issueId: string }>;
```

## Task 1: Freeze dependency evidence and define bounded financial contracts

**Files:**
- Create: `src/lib/server/commerce/financial/constants.ts`
- Create: `src/lib/server/commerce/financial/constants.test.ts`
- Create: `src/lib/server/commerce/financial/errors.ts`
- Create: `src/lib/server/commerce/financial/errors.test.ts`
- Create: `src/lib/server/commerce/financial/types.ts`
- Modify: `docs/dependency-decisions.md`

- [ ] **Step 1: Capture current registry, runtime, peer-range, and audit evidence**

Run each command separately so nonzero `npm outdated --json` can be recorded without hiding later checks:

```powershell
node --version
npm --version
npm outdated --json
npm view stripe version engines --json
npm view typescript version
npm view typescript-eslint peerDependencies --json
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
npm ls --depth=0
```

Expected: Node/npm satisfy `package.json`; Stripe and peer data are recorded with the current date; no unexplained high/critical advisory; no new runtime package is required. Do not update a package merely because it is newer: inspect its changelog/API/peer compatibility first.

- [ ] **Step 2: Write the failing constants and safe-error tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  FINANCIAL_CLASSIFIER_VERSION,
  FINANCIAL_INITIAL_PAYOUT_LOOKBACK_MS,
  FINANCIAL_PAGE_SIZE,
  FINANCIAL_PAYOUT_OVERLAP_MS,
  FINANCIAL_SCAN_BUCKET_MS,
  FINANCIAL_SCAN_RESOURCE_LIMIT
} from './constants';
import { PermanentFinancialError, RetryableFinancialError } from './errors';

describe('financial constants and errors', () => {
  it('pins bounded deterministic scan and classifier settings', () => {
    expect(FINANCIAL_CLASSIFIER_VERSION).toBe(1);
    expect(FINANCIAL_PAGE_SIZE).toBe(100);
    expect(FINANCIAL_SCAN_RESOURCE_LIMIT).toBe(100);
    expect(FINANCIAL_SCAN_BUCKET_MS).toBe(60 * 60 * 1000);
    expect(FINANCIAL_PAYOUT_OVERLAP_MS).toBe(72 * 60 * 60 * 1000);
    expect(FINANCIAL_INITIAL_PAYOUT_LOOKBACK_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('keeps worker failures generic and bounded', () => {
    expect(new PermanentFinancialError('immutable_mismatch').safeCode).toBe('immutable_mismatch');
    expect(new RetryableFinancialError('provider_unavailable').safeCode).toBe('provider_unavailable');
  });
});
```

- [ ] **Step 3: Run the focused test and verify the RED state**

```powershell
npx vitest run src/lib/server/commerce/financial/constants.test.ts src/lib/server/commerce/financial/errors.test.ts
```

Expected: FAIL because the new modules do not exist.

- [ ] **Step 4: Implement the exact constants, type vocabulary, and safe errors**

```ts
export const FINANCIAL_CLASSIFIER_VERSION = 1;
export const FINANCIAL_ALLOCATION_ALGORITHM_VERSION = 1;
export const FINANCIAL_PAGE_SIZE = 100;
export const FINANCIAL_SCAN_RESOURCE_LIMIT = 100;
export const FINANCIAL_SCAN_BUCKET_MS = 60 * 60 * 1000;
export const FINANCIAL_PAYOUT_OVERLAP_MS = 72 * 60 * 60 * 1000;
export const FINANCIAL_INITIAL_PAYOUT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const FINANCIAL_SOURCE_JOB_MAX_ATTEMPTS = 12;
export const FINANCIAL_PAYOUT_JOB_MAX_ATTEMPTS = 12;
export const FINANCIAL_SCAN_JOB_MAX_ATTEMPTS = 8;
export const FINANCIAL_CLASSIFICATION_JOB_MAX_ATTEMPTS = 5;
export const FINANCIAL_RAW_TYPE_MAX_LENGTH = 100;
export const FINANCIAL_PROVIDER_ID_MAX_LENGTH = 255;
export const FINANCIAL_GENERATION_MAX = 2_147_483_647;
```

`types.ts` defines the stable contracts above plus `FinancialComponent`, `FinancialIssueCode`, `FinancialIssueImpact`, `FinancialAllocationPlan`, `PersistFinancialAllocationPlanInput`, `CurrentEffectiveAllocationProjection`, `PublicFinancialStateInput`, `FinancialSourceResult`, `CurrentPayoutEvidence`, `LockedRefundProjectionInput`, `RefundFinancialRecomputeResult`, `CorrectionRebaseInput`, classification inputs/decisions, and payout/import result unions. Every result union uses bounded `status`/`safeCode` values and internal IDs; no type carries a provider SDK object or arbitrary error message. `errors.ts` exposes only bounded safe-code unions; it must not retain a provider error object or message. Define `FINANCIAL_REPLAY_ID` canonically from both classifier and allocation-algorithm versions (for example `c1-a1`); no replay key may use only one version.

- [ ] **Step 5: Run focused and static verification**

```powershell
npx vitest run src/lib/server/commerce/financial/constants.test.ts src/lib/server/commerce/financial/errors.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; the only dependency-file change is an explicitly reviewed compatible update, if one was justified in Step 1.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/lib/server/commerce/financial docs/dependency-decisions.md
git commit -m "chore: define financial reconciliation boundary"
```

If and only if Step 1 justified and implemented a compatible dependency update, stage `package.json` and `package-lock.json` in a separate `git add package.json package-lock.json` command before committing.

## Task 2: Declare the complete Plan 6B persistence model

**Files:**
- Create: `src/lib/server/db/schema/financial-provider.ts`
- Create: `src/lib/server/db/schema/financial-provider.test.ts`
- Create: `src/lib/server/db/schema/financial-allocation.ts`
- Create: `src/lib/server/db/schema/financial-allocation.test.ts`
- Modify: `src/lib/server/db/schema/commerce.ts`
- Modify: `src/lib/server/db/schema/commerce.test.ts`
- Modify: `src/lib/server/db/schema/index.ts`
- Modify: `tests/integration/setup.ts`
- Create: `tests/integration/financial-schema.test.ts`
- Create: `scripts/financial-schema-preservation.test.ts`
- Create: `drizzle/0007_plan6b_financial_reconciliation.sql`
- Create: `drizzle/meta/0007_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

- [ ] **Step 1: Write RED schema-contract tests before changing production schema**

Test all names, enum values, foreign-key actions, unique/index identities, and check constraints through Drizzle metadata plus real PostgreSQL. The schema tests must assert this exact table ownership:

| File | Tables |
| --- | --- |
| `financial-provider.ts` | `stripe_balance_transactions`, `stripe_balance_transaction_fee_details`, `financial_classification_versions`, `stripe_payouts`, `payout_import_runs`, `payout_import_run_entries`, `stripe_payout_balance_transactions`, `financial_scan_runs` |
| `financial-allocation.ts` | `financial_allocation_sets`, `financial_item_allocations`, `financial_reconciliation_issues`, `refund_allocation_components`, `dispute_item_allocations`, `refund_allocation_drafts`, `refund_allocation_draft_items`, `refund_reporting_correction_sets`, `refund_reporting_correction_items`, `refund_allocation_finalization_effects` |

The commerce schema tests must require:

```ts
export const financialEvidenceStatusEnum = pgEnum('financial_evidence_status', [
  'pending',
  'fee_reconciled',
  'exception'
]);

export const refundAllocationStatusEnum = pgEnum('refund_allocation_status', [
  'not_applicable',
  'needs_review',
  'draft',
  'finalized',
  'exception'
]);
```

They must also require `administrative` in the entitlement-grant source enum, bounded reason `refund_allocation_recovery`, and nullable `recoveryRefundAllocationId`. Constraints must make the three grant shapes mutually exclusive:

- `purchase`: exact order-item source, no preservation reason, no recovery reference.
- `preserved`: no order-item or recovery source and one existing bounded preservation reason.
- `administrative`: user/title present, no order item, reason exactly `refund_allocation_recovery`, and one unique recovery refund-allocation reference.

Add every new table to `tests/integration/setup.ts` in child-before-parent truncation order. The integration schema test must prove restrictive history foreign keys rather than cascading deletion.

- [ ] **Step 2: Run the schema tests and verify the RED state**

```powershell
npx vitest run src/lib/server/db/schema/commerce.test.ts src/lib/server/db/schema/financial-provider.test.ts src/lib/server/db/schema/financial-allocation.test.ts scripts/financial-schema-preservation.test.ts
npm run test:integration -- tests/integration/financial-schema.test.ts
```

Expected: FAIL because the modules, enums, columns, tables, and migration do not exist.

- [ ] **Step 3: Implement provider-ledger tables with exact invariants**

Use UUID primary keys for internal relations and bounded unique provider IDs. Define the following required columns and constraints; every persisted instant uses Drizzle `timestamp(columnName, { withTimezone: true })`, currencies use uppercase three-letter checks, and money uses the existing JavaScript-safe bounds.

`stripe_balance_transactions`:

- provider ID, livemode, nullable source family/ID, bounded raw type/reporting category;
- signed `amountMinor` and `netMinor`, nonnegative `feeMinor`, settlement currency;
- `pending | available` provider status, balance type, provider-created/available timestamps;
- nullable positive `numeric(38,18)` exchange-rate string evidence with explicit source/target currencies;
- immutable fingerprint and first/last import timestamps;
- database check `net_minor = amount_minor - fee_minor` and indexes by source, status/availability, currency/date.

`stripe_balance_transaction_fee_details` stores only parent transaction, stable ordinal, bounded raw type, nonnegative amount, currency, and immutable fingerprint. Do not add description, Connect application, provider object, or free-form text.

`financial_classification_versions` stores subject type/ID, classifier version, normalized classification, source fingerprint, and decided timestamp. Require unique `(subject_type, subject_id, classifier_version, source_fingerprint)`.

`stripe_payouts` stores minimized canonical lifecycle fields, safe failure code, retrieval time, and `financialGeneration` with default zero and range `0..2_147_483_647`. Keep provider failure message, destination, descriptor, metadata, and raw response structurally impossible.

`payout_import_runs` stores payout, generation, state, cursor, bounded counts, start/completion timestamps, and safe outcome. `payout_import_run_entries` stores candidate balance-transaction identity scoped to a run. `stripe_payout_balance_transactions` is the published immutable association and must enforce at most one supported payout for each balance transaction.

`financial_scan_runs` stores unique root key, kind/phase, bounded cursor digest/checkpoint, counts, safe outcome, and start/completion timestamps. No column may contain a provider cursor without a configured maximum length.

- [ ] **Step 4: Implement allocation, issue, draft, correction, and provenance tables**

`financial_allocation_sets` must persist balance transaction, basis `gross_amount | fee`, scope `title | account | unresolved`, expected signed effect, currency, algorithm/classifier versions, source fingerprint, stable identity, nullable predecessor set, and nullable `reversalOfSetId`. The self-reference identifies the exact original principal/fee allocation set reversed by a failed-refund reversal or dispute reinstatement; constraints and service validation require matching basis/currency/source family and forbid ambiguous or chained reversal references. Its identity and predecessor constraints must prevent two current tips for the same unchanged source/basis.

Declare two read-only Drizzle/PostgreSQL views as the single composable current-chain contract. `current_financial_projection_heads` has exactly one row per `(balance_transaction_id, basis)` with current base set, compatible correction tip, scope, currency, expected effect, completeness, missing-source count, and bounded proposed issue code. `current_financial_projection_items` has the effective signed item/component rows for that selected head. Both views select the unique supported classifier+algorithm/base+correction chain, surface forks/incompatibility as incomplete rather than double-counting, and contain no identity/provider message. Export them as `currentFinancialProjectionHeads` and `currentFinancialProjectionItems`; checkpoint-II aggregate SQL joins these views so it never loads an unbounded ID list or reimplements tip selection.

`financial_item_allocations` stores set, order item, normalized component, signed effect, currency, stable tie-break key, and creation time. It may not exist for account/unresolved scope. Conservation remains a service check repeated in real integration tests because it spans rows.

`financial_reconciliation_issues` stores resource type/internal ID, bounded safe code, `open | resolved`, impact `pending | exception | informational`, first/last observation, bounded occurrence count, correlation ID, and optional resolver/time. Unique open identity is resource scope plus code; there is no provider-message column.

`refund_allocation_components` and `dispute_item_allocations` store immutable presentment-domain subtotal/tax effects tied to their exact refund/dispute and order item. Currency and sum/capacity checks must be explicit.

`refund_allocation_drafts` stores internal ID, refund, state `active | finalized | discarded`, optimistic integer version, creator/updater administrator IDs, correlation IDs, and created/updated/finalized/discarded timestamps. A partial unique index permits at most one active draft per refund. Draft-item rows are unique by `(draft_id, order_item_id)` and store proposed total-presentment minor units. Correction tables store base allocation-set tip, predecessor correction, source fingerprint, approved absolute distribution, separate zero-sum signed component deltas, administrator IDs, correlation IDs, and timestamps. Rows are empty until 6B-II but their constraints are part of this checkpoint.

`refund_allocation_finalization_effects` must contain restrictive links to:

- the refund and exact administrative `refund_allocations` row;
- the finalized `draftId` and exact `draftVersion` that produced the allocation;
- the order item and exact purchase entitlement grant;
- before/after purchase-grant state and before/after effective-access booleans;
- transition `unchanged | revoked_by_finalization`;
- correlation ID and occurrence time.

Require a unique causal identity so replay cannot manufacture a second provenance row. This table is immutable and is the only admissible causal evidence for 6B-II recovery; audit JSON and current grant state are not substitutes.

- [ ] **Step 5: Export both schema modules and complete static preservation checks**

Update `src/lib/server/db/schema/index.ts` to export both modules and both current-projection views. Export `$inferSelect` and `$inferInsert` aliases for every new table, using stable names such as `PayoutImportRunRow`, `RefundAllocationDraftRow`, `RefundAllocationComponentRow`, `RefundReportingCorrectionSetRow`, `DisputeItemAllocationRow`, `FinancialAllocationSetRow`, `FinancialIssueRow`, and their `New...Row` counterparts; later service signatures import these aliases rather than recreating structural types. In this schema phase, `scripts/financial-schema-preservation.test.ts` parses source/migration text and fails on forbidden sensitive columns, missing table/type/view exports, missing enum values, or missing declared guard-target tables. Task 3 deliberately extends it to require the actual trigger functions/attachments after those guards exist. It supplements but does not replace the real PostgreSQL test.

- [ ] **Step 6: Generate the single forward migration**

```powershell
npm run db:generate -- --name plan6b_financial_reconciliation
```

Expected: Drizzle creates exactly `drizzle/0007_plan6b_financial_reconciliation.sql`, `drizzle/meta/0007_snapshot.json`, and one journal entry. If the next available number is not `0007`, stop and reconcile migration history before proceeding; do not rename a generated migration blindly.

- [ ] **Step 7: Run focused verification**

```powershell
npx vitest run src/lib/server/db/schema/commerce.test.ts src/lib/server/db/schema/financial-provider.test.ts src/lib/server/db/schema/financial-allocation.test.ts scripts/financial-schema-preservation.test.ts
npm run test:integration -- tests/integration/financial-schema.test.ts
npm run db:check
git diff --check
```

Expected: focused commands exit zero, the snapshot parses, all schema objects are exported, and integration cleanup succeeds with the new tables. The full type check waits for Task 4's caller migration.

- [ ] **Step 8: Inspect the generated boundary and continue directly to Task 3**

```powershell
git status --short
git diff -- src/lib/server/db/schema tests/integration/setup.ts tests/integration/financial-schema.test.ts scripts/financial-schema-preservation.test.ts drizzle/0007_plan6b_financial_reconciliation.sql drizzle/meta/0007_snapshot.json drizzle/meta/_journal.json
```

Expected: only the declared schema/migration/test files changed. Do **not** commit yet: generated `0007` is not safe for an existing 0006 database until Task 3 adds its exact backfill and history guards. The same implementation subagent continues directly through Task 3 so no checkout can contain a deployable-looking partial migration.

## Task 3: Add exact migration backfill and database history guards

**Files:**
- Modify: `drizzle/0007_plan6b_financial_reconciliation.sql`
- Modify: `scripts/financial-schema-preservation.test.ts`
- Create: `scripts/with-plan6b-upgrade-database.ts`
- Create: `scripts/with-plan6b-upgrade-database.test.ts`
- Create: `tests/integration/financial-migration.test.ts`
- Modify: `tests/integration/financial-schema.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add RED actual-upgrade and direct-SQL guard tests**

The upgrade harness must create its own isolated, uniquely named Compose PostgreSQL service with a cryptographically random project/database/user/password and loopback-only ephemeral port, apply migrations `0000` through `0006`, seed valid legacy commerce history, run `0007`, execute the assertions, and destroy only that validated owned project/database in `finally`. It never accepts an ambient `DATABASE_URL` or nonloopback server for destructive setup. Before any `DROP DATABASE` or Compose cleanup it validates the project, container ID/labels, loopback endpoint, generated database/user identity, and owned-run manifest together; a database-name prefix alone is insufficient. Do not use a temporary schema: project migrations address `public` explicitly.

The harness unit test must fail RED for a prefixed database on an unrelated server/container, a nonloopback endpoint, mismatched container label/project/user, missing owned-run manifest, and a broad cleanup target. It proves cleanup runs on every failure and removes only the exact generated Compose project/volume/network/temp manifest.

Seed these fixtures:

- a paid single-item order with payment and automatic full refund allocation;
- a paid multi-item order with a succeeded ambiguous unallocated refund;
- a failed refund with no access allocation;
- a dispute and purchase grant;
- one row in each legacy `pending`, `reconciled`, and `exception` seam, including paired payment/dispute exception fixtures whose complete local graph either does or does not prove a durable conflict, plus separate canonically valid ambiguous-refund and corrupt-refund exception fixtures;
- related Stripe event, job, audit, and email/outbox history.

Assert after migration:

- legacy `pending` and `reconciled` both become `financial_evidence_status='pending'`;
- no legacy `exception` is copied mechanically: a payment/dispute/refund exception remains `exception` only when complete local rows prove a durable amount/currency/linkage/capacity conflict; an exception that needs provider Balance Transaction/classification evidence to decide becomes `pending` for canonical backfill;
- a canonically valid succeeded multi-item refund whose only legacy exception is incomplete attribution becomes `allocation_status='needs_review'` plus `financial_evidence_status='pending'` rather than retaining the conflated Plan 6A exception;
- complete succeeded allocations become `allocation_status='finalized'`;
- an ambiguous succeeded refund becomes `needs_review`;
- non-succeeded refunds become `not_applicable`;
- automatic allocation totals are split deterministically into subtotal/tax components without exceeding cumulative item capacity;
- all legacy IDs and history counts remain unchanged;
- running the migration runner again is a no-op.

Add invalid legacy cases for over-allocation, conflicting item currency, and partial facts. Each must abort the migration transaction without advancing the journal or leaving any Plan 6B table behind.

- [ ] **Step 2: Run the migration tests and verify the RED state**

```powershell
npx vitest run scripts/with-plan6b-upgrade-database.test.ts scripts/financial-schema-preservation.test.ts
npm run test:integration -- tests/integration/financial-migration.test.ts tests/integration/financial-schema.test.ts
```

Expected: FAIL because `0007` has neither the exact backfill nor history triggers and the upgrade harness script is missing.

- [ ] **Step 3: Implement deterministic local-only backfill inside `0007`**

The SQL must perform no network access and must lock/reject inconsistent legacy graphs rather than guess. Map legacy state with explicit fact-derived `CASE` expressions; never map `reconciled` to `fee_reconciled` and never inherit `exception` solely because the legacy enum says so. For payments and disputes, retain exception only when the complete local order/payment/dispute graph proves an immutable amount, currency, or linkage conflict; otherwise map to pending for canonical provider backfill. For refunds, convert only the provable expected-ambiguity shape to `needs_review + pending`, retain exception only for a locally proven conflict, and abort on a corrupt/over-capacity/cross-currency graph that cannot be migrated safely. Upgrade tests must include valid/pending and locally conflicting exception cases for all three source families.

For each finalized legacy refund allocation, derive component rows in provider-created/refund-ID order. Within an order item, split total including tax over the remaining subtotal/tax capacity using integer largest remainder with the unique stable tie keys `<orderItemId>:subtotal` and `<orderItemId>:tax` (never the duplicated bare item ID). Verify per-refund totals and cumulative per-item capacity before inserting. Leave ambiguous succeeded refunds unallocated and open the local `allocation_incomplete` pending issue only after the issue table exists.

- [ ] **Step 4: Add database-enforced immutable-history guards**

Use explicit trigger functions comparable to the existing append-only audit protection. Reject update/delete for:

- balance-transaction immutable fields and fee-detail rows;
- every classification version;
- published payout membership;
- allocation sets/items;
- finalized refund/dispute components;
- reporting corrections and finalization effects;
- existing `refund_allocations`.

Permit only these narrow transitions:

- balance transaction `pending -> available` plus import timestamp advancement;
- validated payout lifecycle/reconciliation/linkage/retrieval fields and bounded generation increase;
- active draft edits before finalization;
- issue occurrence and resolution fields.

Reject payout-generation wrap, correction/classification fork, draft mutation after finalization, and deleting any durable history.

- [ ] **Step 5: Expose a dedicated upgrade-test script**

Add an npm script named `test:plan6b-upgrade` that invokes the isolated disposable-Compose harness. It must perform the full owned-run identity validation from Step 1 before destructive cleanup and use native PowerShell/Node/PostgreSQL operations end-to-end.

- [ ] **Step 6: Run GREEN migration and guard verification**

```powershell
npm run test:plan6b-upgrade
npx vitest run scripts/with-plan6b-upgrade-database.test.ts scripts/financial-schema-preservation.test.ts
npm run test:integration -- tests/integration/financial-migration.test.ts tests/integration/financial-schema.test.ts
npm run db:check
git diff --check
```

Expected: migration/schema commands exit zero; both valid upgrade and rollback fixtures use real migration SQL; every direct forbidden mutation fails with a PostgreSQL constraint/trigger error; allowed transitions remain green. The full application type/lint gate is deferred until Task 4 migrates every production caller from the legacy property/state names.

- [ ] **Step 7: Inspect the safe migration and continue directly to Task 4**

```powershell
git status --short
git diff -- drizzle/0007_plan6b_financial_reconciliation.sql src/lib/server/db/schema tests/integration/financial-migration.test.ts scripts/with-plan6b-upgrade-database.ts
```

Expected: the migration is upgrade-safe but the application refactor is still pending. Do **not** commit the new schema while legacy callers would fail the full type gate; the same subagent continues through Task 4.

## Task 4: Publish the purchase-graph lock and refund-state seams

**Files:**
- Modify: `src/lib/server/commerce/reconciliation.ts`
- Modify: `src/lib/server/commerce/refunds.ts`
- Modify: `src/lib/server/commerce/refunds.test.ts`
- Modify: `src/lib/server/commerce/disputes.ts`
- Modify: `src/lib/server/commerce/disputes.test.ts`
- Modify: `src/lib/server/commerce/fulfillment.ts`
- Modify: `src/lib/server/commerce/fulfillment.test.ts`
- Modify: `tests/integration/commerce-refunds.test.ts`
- Modify: `tests/integration/commerce-disputes.test.ts`
- Modify: `tests/integration/commerce-fulfillment.test.ts`
- Modify: `tests/integration/commerce-lock-order.test.ts`
- Modify: `tests/integration/commerce-reconciliation-readiness.test.ts`
- Modify: `tests/e2e/commerce-lifecycle.spec.ts`

- [ ] **Step 1: Add RED seam and state-transition tests**

Require these exact exports:

```ts
export interface PaymentPurchaseFacts {
  payment: PaymentRow;
  order: OrderRow;
  refunds: readonly RefundRow[];
  refundDrafts: readonly RefundAllocationDraftRow[];
  refundDraftItems: readonly RefundAllocationDraftItemRow[];
  refundAllocations: readonly RefundAllocationRow[];
  refundComponents: readonly RefundAllocationComponentRow[];
  correctionSets: readonly RefundReportingCorrectionSetRow[];
  correctionItems: readonly RefundReportingCorrectionItemRow[];
  disputes: readonly DisputeRow[];
  disputeItemAllocations: readonly DisputeItemAllocationRow[];
  orderItems: readonly OrderItemRow[];
}

export async function lockPaymentPurchaseFacts(
  transaction: DatabaseTransaction,
  payment: PaymentRow,
  order: OrderRow
): Promise<PaymentPurchaseFacts>;
```

`lockPaymentAccessFacts` remains as a composition that calls the purchase-fact seam, then locks sorted entitlement scopes and grants. Tests must prove the exact row order and stable-ID ordering for every multi-row family.

Add reducer cases proving:

- expected multi-title ambiguity writes `allocation_status='needs_review'` while keeping its Plan 6A Stripe event terminal `exception`;
- corrupt allocation facts use `allocation_status='exception'`;
- succeeded automatic allocation uses `finalized`;
- failed/canceled refund uses `not_applicable`;
- payment/refund/dispute financial evidence starts `pending` and no Plan 6A reducer can write `fee_reconciled`.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/refunds.test.ts src/lib/server/commerce/disputes.test.ts src/lib/server/commerce/fulfillment.test.ts
npm run test:integration -- tests/integration/commerce-refunds.test.ts tests/integration/commerce-disputes.test.ts tests/integration/commerce-fulfillment.test.ts tests/integration/commerce-lock-order.test.ts tests/integration/commerce-reconciliation-readiness.test.ts
npm run test:e2e -- tests/e2e/commerce-lifecycle.spec.ts
```

Expected: FAIL on the missing seam and legacy reconciliation-state assumptions.

- [ ] **Step 3: Implement the thin lock seam and state renames**

Keep provider calls out of these functions. Use the existing order advisory lock and row-lock helpers. Move only the reusable purchase-fact acquisition into `lockPaymentPurchaseFacts`; do not duplicate the access projection/reducer. Update payment/refund/dispute writes to the new evidence column and allocation-state truth table.

Do not enqueue financial work yet. The handler registration and event handoff land together in Task 16 so no intermediate commit can create an orphan job type.

- [ ] **Step 4: Add deterministic deadlock probes**

Extend the real PostgreSQL lock-order suite with barriers for:

- refund finalization-shaped purchase graph versus refund/dispute ingestion;
- correction-shaped graph versus entitlement projection;
- purchase financial projection versus payout row/transaction acquisition.

The probe must use explicit barriers, bounded `lock_timeout`, `Promise.allSettled`, rollback/release in `finally`, and exact rejection diagnostics. A timing-only sleep assertion is not sufficient.

- [ ] **Step 5: Run GREEN regression gates**

```powershell
npx vitest run src/lib/server/commerce/refunds.test.ts src/lib/server/commerce/disputes.test.ts src/lib/server/commerce/fulfillment.test.ts
npm run test:integration -- tests/integration/commerce-refunds.test.ts tests/integration/commerce-disputes.test.ts tests/integration/commerce-fulfillment.test.ts tests/integration/commerce-lock-order.test.ts tests/integration/commerce-reconciliation-readiness.test.ts
npm run test:e2e -- tests/e2e/commerce-lifecycle.spec.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero, existing access outcomes are unchanged, and the lock probes complete without PostgreSQL `40P01`.

- [ ] **Step 6: Commit Task 4**

```powershell
git add src/lib/server/db/schema src/lib/server/commerce/reconciliation.ts src/lib/server/commerce/refunds.ts src/lib/server/commerce/refunds.test.ts src/lib/server/commerce/disputes.ts src/lib/server/commerce/disputes.test.ts src/lib/server/commerce/fulfillment.ts src/lib/server/commerce/fulfillment.test.ts tests/integration/setup.ts tests/integration/financial-schema.test.ts tests/integration/financial-migration.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-disputes.test.ts tests/integration/commerce-fulfillment.test.ts tests/integration/commerce-lock-order.test.ts tests/integration/commerce-reconciliation-readiness.test.ts tests/e2e/commerce-lifecycle.spec.ts scripts/financial-schema-preservation.test.ts scripts/with-plan6b-upgrade-database.ts scripts/with-plan6b-upgrade-database.test.ts drizzle/0007_plan6b_financial_reconciliation.sql drizzle/meta/0007_snapshot.json drizzle/meta/_journal.json package.json
git diff --cached --check
git commit -m "feat: add financial persistence and purchase seams"
```

## Task 5: Define canonical financial provider snapshots and fixture behavior

**Files:**
- Create: `src/lib/server/commerce/stripe/financial-types.ts`
- Create: `src/lib/server/commerce/stripe/financial-schemas.ts`
- Create: `src/lib/server/commerce/stripe/financial-schemas.test.ts`
- Create: `src/lib/server/commerce/stripe/fixture-financial.ts`
- Create: `src/lib/server/commerce/stripe/fixture-financial.test.ts`
- Modify: `src/lib/server/commerce/stripe/types.ts`
- Modify: `src/lib/server/commerce/stripe/schemas.ts`
- Modify: `src/lib/server/commerce/stripe/schemas.test.ts`
- Modify: `src/lib/server/commerce/stripe/fixture-gateway.ts`
- Modify: `src/lib/server/commerce/stripe/fixture-gateway.test.ts`
- Modify: `src/lib/server/commerce/stripe/runtime-core.ts`
- Modify: `src/lib/server/commerce/stripe/runtime.test.ts`
- Modify: `src/routes/api/webhooks/stripe/route.test.ts`
- Create: `tests/fixtures/stripe/charge.ts`
- Create: `tests/fixtures/stripe/balance-transaction.ts`
- Create: `tests/fixtures/stripe/payout.ts`
- Modify: `tests/fixtures/stripe/refund.ts`
- Modify: `tests/fixtures/stripe/dispute.ts`

- [ ] **Step 1: Write RED parser, gateway-interface, and clone-isolation tests**

The tests must require these provider-neutral snapshots:

```ts
export interface ChargeSnapshot {
  id: string;
  paymentIntentId: string;
  livemode: boolean;
  amountMinor: number;
  amountRefundedMinor: number;
  currency: string;
  status: 'succeeded' | 'pending' | 'failed';
  balanceTransactionId: string | null;
  createdAt: Date;
}

export interface BalanceTransactionFeeDetailSnapshot {
  ordinal: number;
  rawType: string;
  amountMinor: number;
  currency: string;
}

export interface BalanceTransactionSnapshot {
  id: string;
  livemode: boolean;
  sourceId: string | null;
  sourceFamily: 'charge' | 'refund' | 'dispute' | 'payout' | 'adjustment' | 'unknown';
  rawType: string;
  reportingCategory: string;
  amountMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: string;
  status: 'pending' | 'available';
  balanceType: string;
  createdAt: Date;
  availableAt: Date;
  exchangeRate: string | null;
  exchangeSourceCurrency: string | null;
  exchangeTargetCurrency: string | null;
  feeDetails: readonly BalanceTransactionFeeDetailSnapshot[];
}

export interface PayoutSnapshot {
  id: string;
  livemode: boolean;
  amountMinor: number;
  currency: string;
  automatic: boolean;
  method: 'standard' | 'instant' | 'unknown';
  status: 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';
  reconciliationStatus: 'in_progress' | 'completed' | 'not_applicable';
  createdAt: Date;
  arrivalAt: Date;
  balanceTransactionId: string | null;
  failureBalanceTransactionId: string | null;
  originalPayoutId: string | null;
  reversedByPayoutId: string | null;
  safeFailureCode: string | null;
}
```

Extend `RefundSnapshot` with primary and failure balance-transaction IDs. Extend `DisputeSnapshot` with a stable ordered array of zero, one, or two balance-transaction IDs; parsing a third reference is a permanent canonical-evidence error rather than an invitation to widen the approved model. Exact Stripe page contracts are:

```ts
export interface StripePageRequest {
  limit: number;
  startingAfter?: string;
  createdGte?: number;
  createdLt?: number;
}

export interface StripeListPage<T> {
  data: readonly T[];
  hasMore: boolean;
  nextStartingAfter: string | null;
}
```

Require gateway methods `retrieveCharge`, `retrieveBalanceTransaction`, `retrievePayout`, `listBalanceTransactionsForSource`, `listBalanceTransactionsForPayout`, and `listPayouts`. Tests must reject malformed IDs, livemode mismatch, unknown currency, unsafe money, `net !== amount - fee`, duplicate fee ordinals, a third Dispute balance-transaction reference, bad timestamps, zero/noncanonical exchange rate, invalid FX currency pair, oversized cursor, and a page whose `hasMore` result lacks a next ID.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/stripe/financial-schemas.test.ts src/lib/server/commerce/stripe/fixture-financial.test.ts src/lib/server/commerce/stripe/schemas.test.ts src/lib/server/commerce/stripe/fixture-gateway.test.ts src/lib/server/commerce/stripe/runtime.test.ts src/routes/api/webhooks/stripe/route.test.ts
```

Expected: FAIL because the snapshots, parsers, fixture controls, and gateway methods do not exist.

- [ ] **Step 3: Implement strict provider-neutral parsers**

Export `parseChargeSnapshot`, `parseBalanceTransactionSnapshot`, and `parsePayoutSnapshot` from `financial-schemas.ts`. Reuse canonical currency/ID/date helpers from existing Stripe schemas. Parse exact-decimal FX as a validated canonical string; never convert it to a JavaScript float.

No financial snapshot may include `description`, `destination`, metadata, customer, payment method, card/billing, receipt, provider failure message, or raw object. Add negative structural tests that enumerate allowed DTO keys.

- [ ] **Step 4: Extend the fixture gateway deterministically**

Keep fixture mode limited to `APP_ENV=test`, `STRIPE_TEST_FIXTURE_MODE=true`, and `STRIPE_ENABLED=false`. Add setter/reset APIs in `fixture-financial.ts`, clone every input/output, use stable cursor ordering, and support deterministic one-page and multi-page sequences plus injected retryable/permanent failures. Unconfigured list methods return a validated empty terminal page so the real worker can complete a test fixture scan; point retrieval still fails safely when its ID was not registered. Do not create an impossible Stripe-enabled fixture configuration.

The disabled gateway must implement every new method by throwing the existing safe unavailable error without inspecting credentials.

- [ ] **Step 5: Run GREEN provider-contract verification**

```powershell
npx vitest run src/lib/server/commerce/stripe/financial-schemas.test.ts src/lib/server/commerce/stripe/fixture-financial.test.ts src/lib/server/commerce/stripe/schemas.test.ts src/lib/server/commerce/stripe/fixture-gateway.test.ts src/lib/server/commerce/stripe/runtime.test.ts src/routes/api/webhooks/stripe/route.test.ts
git diff --check
```

Expected: focused behavior passes; fixture snapshots cannot be mutated by callers; the disabled runtime remains credential-free. A full TypeScript check is intentionally deferred until Task 6 implements the newly required SDK methods.

- [ ] **Step 6: Inspect the adapter boundary and continue directly to Task 6**

```powershell
git status --short
git diff -- src/lib/server/commerce/stripe tests/fixtures/stripe
```

Expected: only the declared adapter/fixture files changed. Do **not** commit an interface that the SDK runtime does not yet implement; the same subagent continues through Task 6.

## Task 6: Retrieve and paginate Stripe financial evidence

**Files:**
- Modify: `src/lib/server/commerce/stripe/sdk-gateway.ts`
- Modify: `src/lib/server/commerce/stripe/sdk-gateway.test.ts`

- [ ] **Step 1: Write RED SDK-mapping and pagination tests**

Mock the installed Stripe 22.5.0 SDK at the network boundary and assert:

- Charge retrieval maps payment-intent linkage, balance-transaction ID, money, state, livemode, and created time only.
- Refund retrieval maps both balance-transaction references.
- Dispute retrieval maps its complete ordered balance-transaction array.
- Balance-transaction retrieval maps fee details, exact FX evidence, status, category, source, and `amount - fee = net`.
- Payout retrieval maps current canonical lifecycle and linkage fields without failure messages.
- Each list method performs exactly one SDK page call with bounded `limit`, opaque `starting_after`, and the requested source/payout/date filters.
- `has_more=true` derives `nextStartingAfter` from the last validated row and an empty/invalid continuation fails permanently.
- Stripe timeout, connection, and rate-limit failures map retryably; malformed canonical evidence maps permanently with safe codes.

- [ ] **Step 2: Run the SDK tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/stripe/sdk-gateway.test.ts
```

Expected: FAIL because the methods and mappings do not exist.

- [ ] **Step 3: Implement thin mappings in the existing SDK gateway**

Keep the sole `stripe` package import in `sdk-gateway.ts`. Pass mapped literals through the strict parsers before returning. Establish source family from the retrieved canonical object relationship; never infer authority from an ID prefix. Preserve the explicit API-version pin `2026-07-29.dahlia`.

One list call returns one page. Higher layers own continuation jobs; this adapter must not loop, open transactions, log response bodies, or retain SDK objects.

- [ ] **Step 4: Run GREEN SDK verification**

```powershell
npx vitest run src/lib/server/commerce/stripe/sdk-gateway.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero and no new source file imports the Stripe SDK.

- [ ] **Step 5: Commit Task 6**

```powershell
git add src/lib/server/commerce/stripe tests/fixtures/stripe src/routes/api/webhooks/stripe/route.test.ts
git diff --cached --check
git commit -m "feat: add canonical stripe financial evidence"
```

## Task 7: Define durable financial job identities and payloads

**Files:**
- Create: `src/lib/server/commerce/financial/jobs.ts`
- Create: `src/lib/server/commerce/financial/jobs.test.ts`

- [ ] **Step 1: Write RED job parser and deduplication-key tests**

Require exactly four job families:

```ts
export const FINANCIAL_SOURCE_JOB = 'commerce.financial-source' as const;
export const FINANCIAL_PAYOUT_JOB = 'commerce.financial-payout' as const;
export const FINANCIAL_SCAN_JOB = 'commerce.financial-scan' as const;
export const FINANCIAL_CLASSIFICATION_JOB = 'commerce.financial-classification' as const;
```

Test strict discriminated payloads for:

- event-triggered and scan-triggered payment/refund/dispute source refresh;
- payout event refresh, scan-triggered payout refresh, and canonically linked original/reversal payout refresh;
- initial backfill, UTC-hour root, source page, payout discovery page, incomplete-run recovery, payout-impact page, and composite classifier+allocation replay scan;
- classification subject plus composite replay-version replay.

Every payment/refund/dispute payload carries the committed local source UUID, not an unverified provider object ID. Its strict `trigger` union is exactly `{ kind: 'event'; providerEventId } | { kind: 'scan'; scanRunId; scanGenerationHour } | { kind: 'payout_impact'; payoutId; payoutGeneration }`. The event key uses the already-minimized provider event ID, the ordinary scan key uses source kind/internal ID plus UTC hour, and the payout-impact key uses payout ID/generation plus source identity so neither terminal form suppresses another required generation. Payout payloads likewise distinguish event, hourly scan, and canonical related-payout triggers and carry the bounded canonical `po_` ID because the first payout event may precede a local payout row. Scan continuations use internal IDs or bounded opaque cursors/digests only.

Permanent deduplication keys must include the immutable generation/version that makes recurrence safe:

```text
stripe:financial-source:event:<provider-event-id>
stripe:financial-payout:event:<provider-event-id>
stripe:financial-payout:link:<payout-id>:<related-payout-id>:<source-fingerprint>
financial:source:scan:<source-kind>:<source-id>:<UTC-hour>
financial:payout:scan:<payout-id>:<UTC-hour>
commerce.financial-scan:initial:v1
commerce.financial-scan:<UTC-hour>
commerce.financial-classification:scan:<classifier-version>:<allocation-algorithm-version>
commerce.financial-scan:<run-id>:<phase>:<cursor-digest>
financial:payout-impact:<payout-id>:<generation>
financial:source:payout-impact:<payout-id>:<generation>:<source-kind>:<source-id>
financial:classification:<classifier-version>:<allocation-algorithm-version>:<subject-type>:<subject-id>:<fingerprint>
```

Every classification root/subject payload carries both `classifierVersion` and `allocationAlgorithmVersion`; creators derive the canonical `FINANCIAL_REPLAY_ID` and reject a key/payload mismatch. A payout-impact source payload uses `{ kind: 'payout_impact'; payoutId; payoutGeneration }` and its generation-specific key above, never the ordinary UTC-hour source key. Reject unknown fields, malformed UUID/provider IDs, out-of-range limits/generations/versions, unsafe cursors, and mismatched key/payload identity.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/jobs.test.ts
```

Expected: FAIL because `jobs.ts` does not exist.

- [ ] **Step 3: Implement Zod payload parsers and key creators**

Export one creator and one parser for each payload variant. Cursor payloads may retain only bounded provider cursors or SHA-256 digests, never raw provider responses. All job data must be JSON-serializable and contain no email, user identity, provider messages, or secret.

- [ ] **Step 4: Run GREEN job-contract verification**

```powershell
npx vitest run src/lib/server/commerce/financial/jobs.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit Task 7**

```powershell
git add src/lib/server/commerce/financial/jobs.ts src/lib/server/commerce/financial/jobs.test.ts
git commit -m "feat: define financial reconciliation jobs"
```

## Task 8: Implement exact signed allocation engines

**Files:**
- Create: `src/lib/server/commerce/financial/allocations/types.ts`
- Create: `src/lib/server/commerce/financial/allocations/largest-remainder.ts`
- Create: `src/lib/server/commerce/financial/allocations/largest-remainder.test.ts`
- Create: `src/lib/server/commerce/financial/allocations/charge.ts`
- Create: `src/lib/server/commerce/financial/allocations/charge.test.ts`
- Create: `src/lib/server/commerce/financial/allocations/refund.ts`
- Create: `src/lib/server/commerce/financial/allocations/refund.test.ts`
- Create: `src/lib/server/commerce/financial/allocations/dispute.ts`
- Create: `src/lib/server/commerce/financial/allocations/dispute.test.ts`

- [ ] **Step 1: Write table-driven RED tests for signed largest remainder**

Require this public kernel:

```ts
export function allocateSignedLargestRemainder(input: {
  amountMinor: number;
  weights: readonly { tieKey: string; weightMinor: number }[];
}): readonly { tieKey: string; amountMinor: number }[];
```

Test positive, negative, zero, one-item, stable equal-remainder UUID ordering, zero-weight exclusion, nonzero/no-weight rejection, unsafe input rejection, and `Number.MIN_SAFE_INTEGER`/`MAX_SAFE_INTEGER` boundaries. Every intermediate multiplication/division uses `BigInt`; conversion back occurs only after a safe-range check. The output sum must equal the input exactly.

- [ ] **Step 2: Write RED source-plan tests**

Require:

```ts
export function buildChargeAllocationPlan(input: ChargeAllocationInput): FinancialAllocationPlan;
export function buildRefundAllocationPlan(input: RefundAllocationInput): FinancialAllocationPlan;
export function buildFailedRefundAllocationPlan(input: FailedRefundAllocationInput): FinancialAllocationPlan;
export function buildDisputeAllocationPlan(input: DisputeAllocationInput): FinancialAllocationPlan;
```

Cover:

- charge gross allocation over item subtotal+tax and fee allocation weighted only by subtotal;
- exact `gross effect + fee effect = provider net`;
- zero-subtotal/single-item fallback without dropping fee cents;
- refund subtotal/tax capacity after earlier refunds in provider-created/refund-ID order;
- a succeeded ambiguous refund keeping its principal and refund-fee sets `unresolved`/pending until finalization, with no title or account attribution guess;
- a failed-refund reversal mirroring an exact finalized original settlement plan; or, when no title allocation ever existed and principal plus reversal cancel exactly in the same settlement currency, recording both **gross** sets as account-scoped while allocating any provider fee set to titles by immutable payment-item subtotal; residual principal or FX mismatch remains exception;
- multiple disputes in provider-created/ID order, cumulative remaining exposure, explicit withdrawal-set reference for reinstatement, fee and fee-credit effects;
- zero- and three-decimal presentment/settlement currencies and FX kept as separate integer domains.

- [ ] **Step 3: Run all allocator tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/allocations/largest-remainder.test.ts src/lib/server/commerce/financial/allocations/charge.test.ts src/lib/server/commerce/financial/allocations/refund.test.ts src/lib/server/commerce/financial/allocations/dispute.test.ts
```

Expected: FAIL because the allocator modules do not exist.

- [ ] **Step 4: Implement the pure allocation kernel**

All functions are deterministic, side-effect free, provider-neutral, and return the shared `FinancialAllocationPlan` from `../types.ts` with explicit basis/scope/currency/expected effect/component rows. `allocations/types.ts` defines only algorithm-specific charge/refund/dispute input and weighted-target shapes; it imports and does not redeclare the shared component/plan/result unions. Reject duplicate tie keys, cross-currency inputs, capacity overrun, ambiguous withdrawal reference, and any nonconserving result. Do not round through floating point and do not interpret FX rates as money.

Fee-detail classifications may change component labels, but the complete fee basis still conserves `-feeMinor`. Every fee detail on a canonically Charge-linked Balance Transaction—including a novel detail classified as `other`—is allocated to titles with the approved charge fee weights. Only a Balance Transaction with no proven bookstore source may remain account-scoped; no novel/other fee cent may disappear or be moved out of an otherwise title-linked fee set.

- [ ] **Step 5: Run GREEN allocator verification**

```powershell
npx vitest run src/lib/server/commerce/financial/allocations/largest-remainder.test.ts src/lib/server/commerce/financial/allocations/charge.test.ts src/lib/server/commerce/financial/allocations/refund.test.ts src/lib/server/commerce/financial/allocations/dispute.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all tests pass and every test vector proves exact conservation.

- [ ] **Step 6: Commit Task 8**

```powershell
git add src/lib/server/commerce/financial/allocations
git commit -m "feat: add signed financial allocation engine"
```

## Task 9: Persist immutable ledger evidence, classifications, and issue lifecycle

**Files:**
- Create: `src/lib/server/commerce/financial/ledger.ts`
- Create: `src/lib/server/commerce/financial/ledger.test.ts`
- Create: `src/lib/server/commerce/financial/classification.ts`
- Create: `src/lib/server/commerce/financial/classification.test.ts`
- Create: `src/lib/server/commerce/financial/issues.ts`
- Create: `src/lib/server/commerce/financial/issues.test.ts`
- Create: `tests/integration/financial-ledger.test.ts`

- [ ] **Step 1: Write RED unit contracts for fingerprints, classification, and issues**

Require these service boundaries:

```ts
export async function stageBalanceTransaction(
  database: Database,
  snapshot: BalanceTransactionSnapshot,
  context: { correlationId: string }
): Promise<{ balanceTransactionId: string; disposition: 'inserted' | 'unchanged' | 'advanced' }>;

export function classifyBalanceTransaction(input: BalanceTransactionClassificationInput): ClassificationDecision;
export function classifyFeeDetail(input: FeeDetailClassificationInput): ClassificationDecision;

export async function appendClassificationDecisionLocked(
  transaction: DatabaseTransaction,
  input: AppendClassificationDecisionInput
): Promise<ClassificationVersionRow>;

export async function observeFinancialIssue(
  transaction: DatabaseTransaction,
  input: ObserveFinancialIssueInput
): Promise<FinancialIssueRow>;

export async function resolveFinancialIssueAfterRecompute(
  transaction: DatabaseTransaction,
  input: ResolveFinancialIssueInput
): Promise<FinancialIssueRow | null>;
```

Fingerprint tests must be deterministic under property-order changes and must include every immutable canonical field while excluding retrieval timestamps. Classification tests cover known charge/refund/dispute/payout/adjustment categories, every fee cent, and a novel category. Novel raw data returns normalized `unknown`; it does not throw away the provider fact or invent a known class.

Issue tests require bounded codes and scopes, repeat observation increment/clamp behavior, resolution only after a caller supplies a successful recomputation proof, and reopen-on-new-evidence. Inputs cannot contain message/evidence blobs.

- [ ] **Step 2: Write RED real-PostgreSQL ledger tests**

Prove:

- insert, exact replay, and `pending -> available` advancement converge;
- immutable amount/currency/source/fingerprint collision opens `immutable_mismatch` and fails closed;
- concurrent identical staging returns one row without unique-violation leakage;
- fee-detail rows are complete and immutable;
- same-version classifier jobs converge on one decision;
- higher-version supported classification appends while retaining the old row;
- direct update/delete fails;
- safe audit rows contain aggregate IDs/status/amount/currency/count only and use the exact actions `financial.balance_transaction.imported`, `financial.classification.appended`, `financial.issue.opened`, and `financial.issue.resolved` for the applicable committed transitions.

- [ ] **Step 3: Run unit and integration tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/ledger.test.ts src/lib/server/commerce/financial/classification.test.ts src/lib/server/commerce/financial/issues.test.ts
npm run test:integration -- tests/integration/financial-ledger.test.ts
```

Expected: FAIL because the services do not exist.

- [ ] **Step 4: Implement independent immutable staging**

`stageBalanceTransaction` owns a short transaction independent of any purchase/order transaction. It verifies the canonical fingerprint, writes all fee-detail rows, appends current classifier decisions, and records only safe aggregate audit evidence. A committed insert or mutable-status advance audits `financial.balance_transaction.imported`; an exact no-op replay does not append a duplicate outcome. Exact replay is idempotent. A mutable-status advance revalidates all immutable fields before update.

Never pass a Drizzle transaction from a purchase reducer into provider staging; this separation is what lets provider calls and immutable writes complete before the order graph locks.

- [ ] **Step 5: Implement append-only classification and issue services**

Lock classifications by subject stable ID before reading/appending. Unique identity is `(subject type, subject ID, classifier version, source fingerprint)`. A current supported version may supersede `unknown` without editing it. Classification decisions and any allocation replay enqueue/audit are atomic at the service layer.

Issue resolution checks resource/code identity, current open row, and an explicit caller recomputation result. Opening and canonical resolution audit `financial.issue.opened` and `financial.issue.resolved` atomically with their transitions; repeat observation without a lifecycle transition does not manufacture another audit outcome. There is no generic resolve function that accepts an administrator acknowledgment.

- [ ] **Step 6: Run GREEN ledger verification**

```powershell
npx vitest run src/lib/server/commerce/financial/ledger.test.ts src/lib/server/commerce/financial/classification.test.ts src/lib/server/commerce/financial/issues.test.ts
npm run test:integration -- tests/integration/financial-ledger.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero and no test fixture, job, audit row, or captured log contains a raw provider object/message.

- [ ] **Step 7: Commit Task 9**

```powershell
git add src/lib/server/commerce/financial/ledger.ts src/lib/server/commerce/financial/ledger.test.ts src/lib/server/commerce/financial/classification.ts src/lib/server/commerce/financial/classification.test.ts src/lib/server/commerce/financial/issues.ts src/lib/server/commerce/financial/issues.test.ts tests/integration/financial-ledger.test.ts
git commit -m "feat: persist immutable stripe financial ledger"
```

## Task 10: Enforce the financial lock order and current projection/state truth table

**Files:**
- Create: `src/lib/server/commerce/financial/locks.ts`
- Create: `src/lib/server/commerce/financial/locks.test.ts`
- Create: `src/lib/server/commerce/financial/state.ts`
- Create: `src/lib/server/commerce/financial/state.test.ts`
- Create: `src/lib/server/commerce/financial/allocations/repository.ts`
- Create: `src/lib/server/commerce/financial/allocations/repository.test.ts`
- Create: `tests/integration/financial-lock-order.test.ts`
- Create: `tests/integration/financial-allocation-repository.test.ts`

- [ ] **Step 1: Write RED state-table tests**

Test every row in design §6.4 through `derivePublicFinancialState`. The function may return `payout_reconciled` only when:

- persisted evidence is `fee_reconciled`;
- every relevant balance transaction has one authoritative membership;
- each payout is automatic, standard, reconciliation-completed, and currently paid;
- no current exception-impact issue or missing reversal exists.

Manual/instant payouts remain `fee_reconciled`. Failed/canceled/reversed payouts reopen current public state without deleting historical membership. Expected ambiguous refund is `needs_review + pending`, not a financial exception.

- [ ] **Step 2: Write RED allocation repository tests**

Require:

```ts
export async function persistFinancialAllocationPlanLocked(
  transaction: DatabaseTransaction,
  input: PersistFinancialAllocationPlanInput
): Promise<{ setId: string; disposition: 'inserted' | 'unchanged' }>;

export async function loadCurrentEffectiveAllocationProjection(
  executor: DatabaseExecutor,
  input: { balanceTransactionIds: readonly string[] }
): Promise<readonly CurrentEffectiveAllocationProjection[]>;
```

The repository must verify source/basis/currency/expected total, stable row sum, exact predecessor tip, reversal reference, and correction compatibility. It returns exactly one current base-plus-compatible-correction projection **for each requested `(balanceTransactionId, basis)`**, in deterministic transaction/basis order; a single Balance Transaction normally yields separate gross and fee projections. Implement it by querying the exported `currentFinancialProjectionHeads`/`currentFinancialProjectionItems` views—the exact same chain-selection relation used by checkpoint-II aggregates. The loader is strictly read-only: a fork, stale predecessor, missing classification, nonconserving rows, ambiguous reversal reference, or incompatible correction returns an explicit incomplete/exception entry with a bounded proposed issue code for that key; it never writes, collapses multiple transactions/bases, or double-counts both tips. Reconciliation/rebase callers that already hold the published mutation locks pass those results to `observeFinancialIssue` in their transaction. Reporting and 6B-II detail/query callers surface incomplete entries without causing a GET-side write.

- [ ] **Step 3: Write RED deterministic lock-order probes**

Require helpers that acquire sorted payout, balance-transaction, classification, allocation-set/item, and issue locks after the purchase graph and before entitlement scopes. Payout-only helpers acquire payout/run/entries/transactions/membership/issues and never accept an order transaction callback.

Use real PostgreSQL barriers to construct the historical reverse edges and prove they would deadlock if lock order changed. Include simultaneous:

- payment source projection versus payout-impact projection;
- classifier replay versus source replay;
- payout publication versus two sorted balance transactions;
- refund projection versus entitlement mutation.

- [ ] **Step 4: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/state.test.ts src/lib/server/commerce/financial/locks.test.ts src/lib/server/commerce/financial/allocations/repository.test.ts
npm run test:integration -- tests/integration/financial-lock-order.test.ts tests/integration/financial-allocation-repository.test.ts
```

Expected: FAIL because the state, repository, and lock helpers do not exist.

- [ ] **Step 5: Implement the lock and projection contracts**

Sort every multi-row lock by canonical UUID/provider stable ID. Source transactions may lock a current payout generation before their balance transactions, but payout import never waits for an order. Re-read generation, membership, classifier fingerprint, and predecessor tips under lock immediately before writes.

`financialEvidenceStatus` is payout-independent. Never persist `payout_reconciled` into a payment/refund/dispute row. The read model calls `derivePublicFinancialState` with current joined evidence.

- [ ] **Step 6: Run GREEN lock/state verification**

```powershell
npx vitest run src/lib/server/commerce/financial/state.test.ts src/lib/server/commerce/financial/locks.test.ts src/lib/server/commerce/financial/allocations/repository.test.ts
npm run test:integration -- tests/integration/financial-lock-order.test.ts tests/integration/financial-allocation-repository.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; repeated probes produce no PostgreSQL `40P01`, and payout failure is visible from current joins without waiting for a source-row update.

- [ ] **Step 7: Commit Task 10**

```powershell
git add src/lib/server/commerce/financial/locks.ts src/lib/server/commerce/financial/locks.test.ts src/lib/server/commerce/financial/state.ts src/lib/server/commerce/financial/state.test.ts src/lib/server/commerce/financial/allocations/repository.ts src/lib/server/commerce/financial/allocations/repository.test.ts tests/integration/financial-lock-order.test.ts tests/integration/financial-allocation-repository.test.ts
git commit -m "feat: project financial allocation evidence"
```

## Task 11: Reconcile payment and Charge financial sources

**Files:**
- Create: `src/lib/server/commerce/financial/sources/payment.ts`
- Create: `src/lib/server/commerce/financial/sources/payment.test.ts`
- Create: `tests/integration/financial-sources.test.ts`

- [ ] **Step 1: Write RED service tests around a call/transaction trace**

Require:

```ts
export async function reconcilePaymentFinancialSource(
  database: Database,
  gateway: StripeCommerceGateway,
  input: { paymentId: string; correlationId: string },
  signal: AbortSignal
): Promise<FinancialSourceResult>;
```

Assert the trace is exactly:

1. Read minimal local routing facts without locks.
2. Retrieve canonical PaymentIntent, then Charge, then Balance Transaction outside a transaction.
3. Stage Balance Transaction independently.
4. Enter order advisory/order/payment/purchase-financial locks.
5. Re-read and validate live mode, PaymentIntent/order metadata, succeeded state, charge, amount, currency, and paid timestamp.
6. Build/persist gross and fee sets, recompute issues/evidence status, append safe audit, and commit.

Test retryable missing charge/BT, provider outage, abort signal, foreign/mutated metadata, wrong amount/currency/livemode, immutable collision, exact replay, later `pending -> available`, and order changing between provider retrieval and lock acquisition.

- [ ] **Step 2: Run payment source tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/sources/payment.test.ts
npm run test:integration -- tests/integration/financial-sources.test.ts
```

Expected: FAIL because the source service does not exist.

- [ ] **Step 3: Implement canonical payment reconciliation**

Reuse the Plan 6A canonical linkage checks rather than creating a weaker financial version. A retryable provider gap leaves the local source `pending` and open `missing_source` issue for hourly recovery. A permanent mismatch opens an exception-impact issue and sets evidence `exception`. Do not alter order/payment lifecycle, grants, entitlements, or email.

Audit action `financial.payment_reconciled` contains internal payment/order IDs, safe status, settlement currency, signed amount/fee/net, allocation counts, and correlation ID only.

- [ ] **Step 4: Run GREEN payment reconciliation verification**

```powershell
npx vitest run src/lib/server/commerce/financial/sources/payment.test.ts
npm run test:integration -- tests/integration/financial-sources.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; no Stripe method appears between transaction begin/commit in the call trace.

- [ ] **Step 5: Commit Task 11**

```powershell
git add src/lib/server/commerce/financial/sources/payment.ts src/lib/server/commerce/financial/sources/payment.test.ts tests/integration/financial-sources.test.ts
git commit -m "feat: reconcile charge financial evidence"
```

## Task 12: Reconcile refund and dispute financial sources

**Files:**
- Create: `src/lib/server/commerce/financial/sources/refund.ts`
- Create: `src/lib/server/commerce/financial/sources/refund.test.ts`
- Create: `src/lib/server/commerce/financial/sources/dispute.ts`
- Create: `src/lib/server/commerce/financial/sources/dispute.test.ts`
- Create: `src/lib/server/commerce/financial/handlers/source.ts`
- Create: `src/lib/server/commerce/financial/handlers/source.test.ts`
- Modify: `tests/integration/financial-sources.test.ts`

- [ ] **Step 1: Write RED refund, dispute, and handler tests**

Require:

```ts
export async function reconcileRefundFinancialSource(
  database: Database,
  gateway: StripeCommerceGateway,
  input: { refundId: string; correlationId: string },
  signal: AbortSignal
): Promise<FinancialSourceResult>;

export async function reconcileDisputeFinancialSource(
  database: Database,
  gateway: StripeCommerceGateway,
  input: { disputeId: string; correlationId: string },
  signal: AbortSignal
): Promise<FinancialSourceResult>;

export async function recomputeLockedRefundFinancialProjection(
  transaction: DatabaseTransaction,
  input: LockedRefundProjectionInput
): Promise<RefundFinancialRecomputeResult>;

export function createFinancialSourceHandler(dependencies: FinancialSourceHandlerDependencies): JobHandler;
```

Refund tests cover succeeded principal BT, failed/canceled failure BT, primary plus reversal, presentment subtotal/tax components, settlement fee allocation, and expected ambiguity. A succeeded ambiguous refund remains `needs_review + pending`: principal and refund-fee allocation sets are `unresolved`, with no title/account guess. If that unallocated refund later fails and the original principal plus failure reversal cancel exactly in the same settlement currency, persist both gross sets as account-scoped, allocate any provider fee set to titles by immutable payment-item subtotal, and never change access. A residual principal or FX mismatch is exception; it is not coerced to zero or attributed to titles.

Dispute tests cover zero, one, and two transactions plus rejection of a third; stable provider-created/ID chronology; more than one dispute on a payment; cumulative remaining exposure; withdrawal and exact referenced reinstatement; dispute fee/credit; and overexposure conflict. Financial import never invokes entitlement projection.

Handler tests parse strict job payloads, dispatch only payment/refund/dispute, honor abort/lease loss, retry safe gaps, and convert permanent evidence conflicts to durable exception outcomes without provider text.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/sources/dispute.test.ts src/lib/server/commerce/financial/handlers/source.test.ts
npm run test:integration -- tests/integration/financial-sources.test.ts
```

Expected: FAIL because the services and handler do not exist.

- [ ] **Step 3: Implement refund recomputation as the shared 6B-II seam**

Provider retrieval and independent ledger staging complete first. Under the published purchase lock order, recompute from the complete refund graph, finalized allocations/components, current classification, and current correction tip. The provider-free `recomputeLockedRefundFinancialProjection` is the only function 6B-II finalization calls after it writes an administrative allocation; it must not fetch Stripe data or acquire an outer order lock itself.

Expected ambiguity observes `allocation_incomplete` with impact `pending`; corrupt totals/currency/capacity use impact `exception`. Only canonical recomputation resolves the issue.

- [ ] **Step 4: Implement dispute reconciliation and the source handler**

Stage every canonical dispute balance transaction independently before entering the order graph. Allocate all observed transactions in stable chronology against cumulative remaining exposure. A reinstatement identifies the exact withdrawal set it reverses. Unknown/missing evidence stays pending or exception; it is never guessed from webhook deltas.

- [ ] **Step 5: Run GREEN source verification**

```powershell
npx vitest run src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/sources/dispute.test.ts src/lib/server/commerce/financial/handlers/source.test.ts
npm run test:integration -- tests/integration/financial-sources.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; provider calls are transaction-free, replays converge, and access/grants/outbox are byte-for-byte unchanged by financial imports.

- [ ] **Step 6: Commit Task 12**

```powershell
git add src/lib/server/commerce/financial/sources/refund.ts src/lib/server/commerce/financial/sources/refund.test.ts src/lib/server/commerce/financial/sources/dispute.ts src/lib/server/commerce/financial/sources/dispute.test.ts src/lib/server/commerce/financial/handlers/source.ts src/lib/server/commerce/financial/handlers/source.test.ts tests/integration/financial-sources.test.ts
git commit -m "feat: reconcile refund and dispute finances"
```

## Task 13: Stage payouts and atomically publish authoritative membership

**Files:**
- Create: `src/lib/server/commerce/financial/payouts/repository.ts`
- Create: `src/lib/server/commerce/financial/payouts/repository.test.ts`
- Create: `src/lib/server/commerce/financial/payouts/service.ts`
- Create: `src/lib/server/commerce/financial/payouts/service.test.ts`
- Create: `src/lib/server/commerce/financial/handlers/payout.ts`
- Create: `src/lib/server/commerce/financial/handlers/payout.test.ts`
- Create: `tests/integration/financial-payouts.test.ts`

- [ ] **Step 1: Write RED payout lifecycle and import-run tests**

Require:

```ts
export async function stagePayoutSnapshot(
  database: Database,
  snapshot: PayoutSnapshot,
  context: { correlationId: string }
): Promise<{ payoutId: string; generation: number; changed: boolean }>;

export async function startOrResumePayoutImport(
  database: Database,
  input: StartPayoutImportInput
): Promise<PayoutImportRunRow>;

export async function persistPayoutImportPage(
  database: Database,
  input: PersistPayoutImportPageInput
): Promise<PayoutImportRunRow>;

export async function publishPayoutMembership(
  database: Database,
  input: PublishPayoutMembershipInput
): Promise<{ generation: number; membershipCount: number }>;

export async function loadCurrentPayoutEvidence(
  executor: DatabaseExecutor,
  balanceTransactionIds: readonly string[]
): Promise<CurrentPayoutEvidence>;

export function createFinancialPayoutHandler(dependencies: FinancialPayoutHandlerDependencies): JobHandler;
```

Cover canonical insert/replay/change, paid-to-failed and canceled/reversal history, generation increment exactly once per reporting-affecting transaction, overflow fail-closed, manual/instant `not_applicable`, and safe failure codes.

Import-run tests cover multiple pages, crash after a page, replay, changed payout generation abandoning the old run, duplicate candidates, source collision, final empty page, and two concurrent publishers. Before publication, candidate entries must be invisible to `loadCurrentPayoutEvidence`.

- [ ] **Step 2: Write RED provider-call/transaction and atomic-handoff tests**

Assert every provider call finishes before its corresponding database transaction. The handler flow is:

1. Retrieve canonical payout, then retrieve every nonnull payout/failure Balance Transaction reference outside a transaction and validate canonical source linkage. Any original/reversal payout ID becomes a separate bounded payout-refresh job rather than being followed recursively in this handler.
2. Stage each linked Balance Transaction independently, then stage/refresh the payout in a short transaction.
3. If automatic+standard+reconciliation-completed, retrieve exactly one membership Balance Transaction page outside a transaction.
4. Stage each returned transaction independently.
5. Persist that page/run checkpoint in one short transaction.
6. Enqueue a continuation or publish only after complete-page evidence exists.

Publication must lock `payout -> run -> sorted run entries -> sorted balance transactions -> membership -> payout issues`, publish the complete set, mark the run published, increment generation once, enqueue `financial:payout-impact:<payout-id>:<generation>`, and audit `financial.payout.membership_published` in that same transaction. Exact replay emits neither another generation nor another publication audit.

Immediately before membership insertion, the locked publication transaction must re-read and require the payout is still automatic, standard, `reconciliationStatus='completed'`, currently `paid`, and at the exact generation captured by the run. If any predicate changed after the final provider page, mark/leave the run abandoned or stale and publish nothing. A deterministic barrier test changes paid to failed/canceled (and separately advances generation) between final-page persistence and publication; no membership, generation increment, impact job, or publication audit may commit from the stale run.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/payouts/repository.test.ts src/lib/server/commerce/financial/payouts/service.test.ts src/lib/server/commerce/financial/handlers/payout.test.ts
npm run test:integration -- tests/integration/financial-payouts.test.ts
```

Expected: FAIL because payout services and handler do not exist.

- [ ] **Step 4: Implement payout staging, collection, and publication**

Lifecycle validation permits canonical late change while keeping identity/original facts immutable. Historical published membership is never deleted when a payout fails. Current report state uses payout status/reconciliation and any reversal evidence, so failure reopens immediately.

Manual/instant payouts stage their canonical row and direct payout/failure Balance Transaction references but do not publish an exact membership claim. A complete automatic standard payout may contain unrelated Stripe activity; retain every minimized returned transaction, allocate only canonically linked bookstore sources, and never assert linked subtotal equals payout amount.

`enqueuePayoutImpactLocked` is an internal repository function called only inside the payout mutation/publication transaction. It pages memberships later and enqueues independent source-refresh jobs; it never enters a purchase graph while holding payout locks.

- [ ] **Step 5: Run GREEN payout verification**

```powershell
npx vitest run src/lib/server/commerce/financial/payouts/repository.test.ts src/lib/server/commerce/financial/payouts/service.test.ts src/lib/server/commerce/financial/handlers/payout.test.ts
npm run test:integration -- tests/integration/financial-payouts.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; incomplete pages never become authoritative; a crash cannot occur between generation change and the durable impact job.

- [ ] **Step 6: Commit Task 13**

```powershell
git add src/lib/server/commerce/financial/payouts src/lib/server/commerce/financial/handlers/payout.ts src/lib/server/commerce/financial/handlers/payout.test.ts tests/integration/financial-payouts.test.ts
git commit -m "feat: import stripe payout membership"
```

## Task 14: Add recurring scheduling, bounded scans, and initial backfill

**Files:**
- Modify: `src/lib/server/jobs/runner.ts`
- Modify: `src/lib/server/jobs/runner.test.ts`
- Create: `src/lib/server/commerce/financial/scans/scheduler.ts`
- Create: `src/lib/server/commerce/financial/scans/scheduler.test.ts`
- Create: `src/lib/server/commerce/financial/scans/service.ts`
- Create: `src/lib/server/commerce/financial/scans/service.test.ts`
- Create: `src/lib/server/commerce/financial/handlers/scan.ts`
- Create: `src/lib/server/commerce/financial/handlers/scan.test.ts`
- Create: `tests/integration/financial-scheduler.test.ts`

- [ ] **Step 1: Write RED generic worker-hook tests**

Add this backward-compatible runner seam:

```ts
export type WorkerPollHook = (input: {
  now: Date;
  signal: AbortSignal;
}) => Promise<void>;

export interface RunWorkerOptions {
  beforePoll?: WorkerPollHook;
}
```

Tests must prove `beforePoll` runs before each claim cycle, respects abort, cannot overlap itself within one runner, maps failure to a bounded worker log without killing later polls, and leaves existing lease heartbeat/lost-lease behavior unchanged. The hook only ensures local jobs; it performs no Stripe call or scan body.

- [ ] **Step 2: Write RED scheduler and scan tests**

Require:

```ts
export async function ensureHourlyFinancialScan(
  database: Database,
  input: {
    now: Date;
    classifierVersion: number;
    allocationAlgorithmVersion: number;
  }
): Promise<{ enqueued: readonly string[] }>;

export function createFinancialScheduleEnsurer(dependencies: FinancialScheduleDependencies): WorkerPollHook;
export function createFinancialScanHandler(dependencies: FinancialScanHandlerDependencies): JobHandler;
```

The scheduler ensures:

- one permanent `commerce.financial-scan:initial:v1` root;
- one UTC-hour root key;
- one composite classifier+allocation-algorithm replay root key;
- when Stripe runtime is disabled, no initial/hourly provider-discovery, source, or payout job and no provider call—but still exactly one local composite replay-ID root so already persisted ledger facts can converge after a deployment;
- fixture scheduling only under the existing test-only fixture contract.

A process-local current-hour/replay-ID cache reduces inserts but is never the correctness authority. Concurrent workers must converge through the permanent database key. An allocation-algorithm bump without a classifier bump still produces a new root and new subject keys; tests explicitly hold classifier version constant, bump only algorithm version, and prove replay occurs once.

Scan tests cover at most 100 local pending/retryable payment/refund/dispute sources, incomplete payout runs, payout-impact memberships, and one provider payout-discovery page. For each local source page, the scan enqueues the scan-triggered `commerce.financial-source` payload/key defined in Task 7; for each known/incomplete payout it enqueues the scan-triggered `commerce.financial-payout` payload/key. These hour-generation keys are distinct from terminal event keys. A payout-impact page enqueues the payout/generation-specific child source key—not the ordinary hourly key—so a source already reconciled earlier in the same hour is refreshed after payout publication/failure. Test that exact ordering and idempotent replay. Continuations contain run/phase/cursor digest. Discovery uses a 72-hour overlap; initial lower bound is earliest paid order minus seven days. Exhausted transient source jobs remain durable for the next hourly scan.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/jobs/runner.test.ts src/lib/server/commerce/financial/scans/scheduler.test.ts src/lib/server/commerce/financial/scans/service.test.ts src/lib/server/commerce/financial/handlers/scan.test.ts
npm run test:integration -- tests/integration/financial-scheduler.test.ts
```

Expected: FAIL because the hook, scheduler, scans, and handler do not exist.

- [ ] **Step 4: Implement the scheduler without fixed-key self-rescheduling**

Use UTC-hour/composite-replay/generation keys; never enqueue the same fixed terminal key as its own continuation. Each scan job processes one bounded local page or one provider page, commits checkpoint/count/outcome, then inserts a generation-specific continuation. Database state—not process memory—is recovery authority.

Provider payout discovery happens in the handler outside transactions. It stages results, then commits the bounded cursor/checkpoint and continuation. No transaction or worker lease spans an unbounded loop.

- [ ] **Step 5: Add real concurrent-worker and crash recovery tests**

Use two worker loops against the same PostgreSQL database. Prove one initial/hour/composite-replay root, hour rollover, continuation resume after simulated crash, disabled runtime creates only the composite replay-ID local classification root/work and makes no provider call, incomplete payout-run recovery, permanent-job retry exhaustion followed by next-hour rediscovery, and no connection/lease leak.

- [ ] **Step 6: Run GREEN scheduler verification**

```powershell
npx vitest run src/lib/server/jobs/runner.test.ts src/lib/server/commerce/financial/scans/scheduler.test.ts src/lib/server/commerce/financial/scans/service.test.ts src/lib/server/commerce/financial/handlers/scan.test.ts
npm run test:integration -- tests/integration/financial-scheduler.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; disabled Stripe creates no provider/source/payout scan work or provider call, while the one local composite replay-ID root safely converges existing ledger evidence.

- [ ] **Step 7: Commit Task 14**

```powershell
git add src/lib/server/jobs/runner.ts src/lib/server/jobs/runner.test.ts src/lib/server/commerce/financial/scans src/lib/server/commerce/financial/handlers/scan.ts src/lib/server/commerce/financial/handlers/scan.test.ts tests/integration/financial-scheduler.test.ts
git commit -m "feat: schedule financial reconciliation recovery"
```

## Task 15: Replay new classifier or allocation-algorithm versions and rebase approved corrections safely

**Files:**
- Create: `src/lib/server/commerce/financial/rebase.ts`
- Create: `src/lib/server/commerce/financial/rebase.test.ts`
- Create: `src/lib/server/commerce/financial/handlers/classification.ts`
- Create: `src/lib/server/commerce/financial/handlers/classification.test.ts`
- Modify: `src/lib/server/commerce/financial/allocations/repository.ts`
- Modify: `src/lib/server/commerce/financial/issues.ts`
- Create: `tests/integration/financial-reclassification.test.ts`

- [ ] **Step 1: Write RED classifier replay and rebase tests**

Require:

```ts
export async function rebaseApprovedCorrectionDistributionLocked(
  transaction: DatabaseTransaction,
  input: CorrectionRebaseInput
): Promise<
  | { status: 'rebased'; correctionSetId: string }
  | { status: 'exception'; issueId: string }
>;

export function createFinancialClassificationHandler(
  dependencies: FinancialClassificationHandlerDependencies
): JobHandler;
```

Cover:

- same version/fingerprint replay is idempotent;
- `unknown -> supported` appends a decision and successor allocation set;
- supported classification/algorithm change appends rather than edits;
- changing only `FINANCIAL_ALLOCATION_ALGORITHM_VERSION` while classifier version stays fixed creates one new composite root/subject identity and replays exactly once;
- two concurrent classifier jobs converge on one successor;
- stale/forked predecessor opens an exception and nulls current projection;
- an existing correction is rebased from its approved absolute distribution onto the new base tip;
- subtotal/tax/settlement/refund-fee zero sums and capacities remain exact after rebase;
- an incompatible capacity/currency/source change opens `correction_rebase_required`, leaves old history intact, yields incomplete metrics, and disables recovery-grant eligibility.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/rebase.test.ts src/lib/server/commerce/financial/handlers/classification.test.ts
npm run test:integration -- tests/integration/financial-reclassification.test.ts
```

Expected: FAIL because rebase/handler services do not exist.

- [ ] **Step 3: Implement append-only replay in the published lock order**

Perform a nonlocking discovery read, then acquire the **exact published order**: order advisory -> order -> payment -> refunds -> drafts/items -> finalized refund allocations/components -> correction sets/items -> disputes/item rows -> order items -> applicable payouts -> balance transactions -> classification versions -> financial allocation sets/items -> issues. Re-read every discovered correction/base/classification ID and fingerprint under those locks before deriving the old approved absolute distribution. Never lock an allocation set and then reach backward to a correction row, never copy the old delta blindly, and never select an old correction against a new incompatible base. Add a deterministic real-PostgreSQL correction/finalization-versus-rebase barrier that would produce `40P01` under the old allocation-before-correction order and proves convergence under the published order.

Audit safe classifier-decision and allocation-supersession outcomes even when a supported-to-supported change resolves no issue. Use exact actions `financial.classification.appended` and `financial.allocation.superseded`; a compatible correction rebase also emits `financial.correction.rebased`, while a failed rebase that opens `correction_rebase_required` emits `financial.correction.rebase_failed`. Audit, issue, allocation, correction, and history writes commit atomically.

- [ ] **Step 4: Run GREEN replay verification**

```powershell
npx vitest run src/lib/server/commerce/financial/rebase.test.ts src/lib/server/commerce/financial/handlers/classification.test.ts
npm run test:integration -- tests/integration/financial-reclassification.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; no update/delete touches old provider, classification, allocation, or correction rows.

- [ ] **Step 5: Commit Task 15**

```powershell
git add src/lib/server/commerce/financial/rebase.ts src/lib/server/commerce/financial/rebase.test.ts src/lib/server/commerce/financial/handlers/classification.ts src/lib/server/commerce/financial/handlers/classification.test.ts src/lib/server/commerce/financial/allocations/repository.ts src/lib/server/commerce/financial/issues.ts tests/integration/financial-reclassification.test.ts
git commit -m "feat: replay financial classifications safely"
```

## Task 16: Wire payout webhooks, reducer handoff, handlers, and scheduling into the worker

**Files:**
- Create: `src/lib/server/commerce/financial/event-handoff.ts`
- Create: `src/lib/server/commerce/financial/event-handoff.test.ts`
- Modify: `src/lib/server/commerce/webhooks.ts`
- Modify: `src/lib/server/commerce/webhooks.test.ts`
- Modify: `src/lib/server/commerce/handler.ts`
- Modify: `src/lib/server/commerce/handler.test.ts`
- Modify: `src/lib/server/commerce/fulfillment.ts`
- Modify: `src/lib/server/commerce/fulfillment.test.ts`
- Modify: `src/lib/server/commerce/refunds.ts`
- Modify: `src/lib/server/commerce/refunds.test.ts`
- Modify: `src/lib/server/commerce/disputes.ts`
- Modify: `src/lib/server/commerce/disputes.test.ts`
- Modify: `src/lib/server/jobs/repository.ts`
- Create: `src/lib/server/jobs/repository.test.ts`
- Modify: `src/worker.ts`
- Modify: `tests/integration/commerce-webhooks.test.ts`
- Modify: `tests/integration/commerce-fulfillment.test.ts`
- Modify: `tests/integration/commerce-refunds.test.ts`
- Modify: `tests/integration/commerce-disputes.test.ts`

- [ ] **Step 1: Write RED webhook allowlist and dispatch tests**

Add exactly these events, never a wildcard:

```text
payout.created
payout.updated
payout.paid
payout.failed
payout.canceled
payout.reconciliation_completed
```

Webhook acceptance still verifies raw signature/API/livemode, minimizes the descriptor, collision-checks digest, and inserts only the existing `commerce.stripe-event` job atomically. The webhook request performs no Payout/Balance Transaction API call.

Handler tests require a payout family with bounded `po_` ID and provider-event ID. It atomically completes the Stripe event and enqueues `FINANCIAL_PAYOUT_JOB`; canonical retrieval occurs later in the payout job.

- [ ] **Step 2: Write RED Plan 6A reducer-handoff tests**

Require:

```ts
export async function queueFinancialSourceFromEvent(
  transaction: DatabaseTransaction,
  input: FinancialSourceEventHandoff
): Promise<void>;

export async function queueFinancialPayoutFromEvent(
  transaction: DatabaseTransaction,
  input: FinancialPayoutEventHandoff
): Promise<void>;
```

Checkout/refund/dispute reducers must commit local canonical fact, their existing reducer-derived Stripe-event terminal status, and the financial source job in one transaction. Test:

- normal event becomes `processed` plus one financial job;
- ambiguous refund remains Stripe-event `exception` plus one financial job after the refund row exists;
- reducer rollback leaves neither terminal status nor financial job;
- duplicate event/reducer replay returns the same event-keyed job without rearming an already running/completed handler;
- a locally committed source fact whose prior event job exhausted retry attempts can be safely rearmed by a later hourly scan's distinct generation key without creating a parallel active source job;
- financial handler cannot run before the local fact is committed.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/event-handoff.test.ts src/lib/server/commerce/webhooks.test.ts src/lib/server/commerce/handler.test.ts src/lib/server/commerce/fulfillment.test.ts src/lib/server/commerce/refunds.test.ts src/lib/server/commerce/disputes.test.ts
npm run test:integration -- tests/integration/commerce-webhooks.test.ts tests/integration/commerce-fulfillment.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-disputes.test.ts
```

Expected: FAIL because payout routing and atomic handoff do not exist.

- [ ] **Step 4: Implement atomic handoff without changing reducer semantics**

Call the handoff helper inside the same reducer transaction after durable local facts are known but before commit. Preserve exact Plan 6A exception/status behavior. Use distinct financial job namespaces so the existing `commerce.stripe-event` permanent dedupe key cannot suppress a financial job.

Add the smallest repository-level active-entity guard needed for financial source/payout jobs: transactional enqueue/rearm locks the local resource's advisory/entity key, returns an existing queued/running job for the same resource instead of inserting parallel work, and permits a new event/hour/generation dedupe row only after the prior job is terminal. Do not weaken global permanent deduplication for other job families. Unit and real PostgreSQL tests cover event-versus-hour boundary races, exhausted-to-hourly recovery, exact replay, and two workers; handler logic still re-reads canonical complete facts, so a later trigger converges rather than applies a delta twice.

- [ ] **Step 5: Register the complete checkpoint atomically in `src/worker.ts`**

Create the source, payout, scan, and classification handlers with explicit dependencies; register all four names in the handler map; pass the result of `createFinancialScheduleEnsurer(dependencies)` as `beforePoll`. Register only now, after every handler exists. Disabled Stripe runtime creates no provider-backed initial/hourly/source/payout roots or calls; it still ensures the composite classifier+algorithm replay root and may process bounded local reclassification work.

- [ ] **Step 6: Run GREEN handoff/worker verification**

```powershell
npx vitest run src/lib/server/commerce/financial/event-handoff.test.ts src/lib/server/commerce/webhooks.test.ts src/lib/server/commerce/handler.test.ts src/lib/server/commerce/fulfillment.test.ts src/lib/server/commerce/refunds.test.ts src/lib/server/commerce/disputes.test.ts src/lib/server/jobs/repository.test.ts src/lib/server/jobs/runner.test.ts
npm run test:integration -- tests/integration/commerce-webhooks.test.ts tests/integration/commerce-fulfillment.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-disputes.test.ts tests/integration/financial-scheduler.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; the exact six payout events are accepted, all other event names remain rejected, and no intermediate orphan job type exists.

- [ ] **Step 7: Commit Task 16**

```powershell
git add src/lib/server/commerce/financial/event-handoff.ts src/lib/server/commerce/financial/event-handoff.test.ts src/lib/server/commerce/webhooks.ts src/lib/server/commerce/webhooks.test.ts src/lib/server/commerce/handler.ts src/lib/server/commerce/handler.test.ts src/lib/server/commerce/fulfillment.ts src/lib/server/commerce/fulfillment.test.ts src/lib/server/commerce/refunds.ts src/lib/server/commerce/refunds.test.ts src/lib/server/commerce/disputes.ts src/lib/server/commerce/disputes.test.ts src/lib/server/jobs/repository.ts src/lib/server/jobs/repository.test.ts src/worker.ts tests/integration/commerce-webhooks.test.ts tests/integration/commerce-fulfillment.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-disputes.test.ts
git commit -m "feat: hand off stripe events to financial reconciliation"
```

## Task 17: Prove replay, privacy, lock safety, and production-image preservation

**Files:**
- Create: `tests/integration/financial-reconciliation.test.ts`
- Create: `tests/integration/financial-privacy.test.ts`
- Modify: `tests/integration/financial-migration.test.ts`
- Modify: `tests/integration/financial-lock-order.test.ts`
- Modify: `tests/integration/financial-sources.test.ts`
- Modify: `tests/integration/financial-payouts.test.ts`
- Modify: `scripts/commerce-privacy.test.ts`
- Modify: `scripts/commerce-operations.test.ts`
- Create: `scripts/plan6b-production-smoke.ts`
- Create: `scripts/plan6b-production-smoke.test.ts`
- Create: `scripts/plan6b-fixture-runtime-probe.ts`
- Create: `scripts/plan6b-fixture-runtime-probe.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add RED end-to-end PostgreSQL convergence tests**

Use the fixture gateway and real worker/job repository to exercise complete local flows:

- paid order -> Charge/Balance Transaction -> gross/fee allocations -> `fee_reconciled`;
- same-currency and FX orders without cross-currency addition;
- automatic completed paid payout publication -> derived `payout_reconciled`;
- current payout failure -> immediate derived reopening while membership remains;
- manual/instant payout -> fee reconciled only;
- partial/full/cumulative/failed refunds, ambiguous multi-title pending review, and reversal;
- open/won/lost dispute with withdrawal, fee, partial/full reinstatement;
- duplicate/out-of-order webhook and scan delivery;
- immutable collision and unknown classifier -> exception, then supported classifier replay -> resolved/new tip;
- crash after provider stage, scan page, payout page, and payout publication handoff;
- audit-write failure rolls back the financial mutation that requires that audit;
- exact conservation for every allocation set and provider net equation.

Run the lock probes repeatedly with deterministic barriers. Tests must inspect exact state/row identities rather than merely assert that no exception was thrown.

- [ ] **Step 2: Add RED privacy and forbidden-shape tests**

Inspect schema columns, job payload JSON, audit before/after, issue rows, captured logs, fixture snapshots, and worker errors. Reject:

```text
email customer card payment_method billing_details address receipt_url
description destination metadata client_secret raw_object provider_message
sk_test sk_live rk_test rk_live whsec_ BEGIN PRIVATE KEY
```

Provider object IDs may exist only in the existing minimized server-only Plan 6A commerce source/event linkage rows (`orders`, `payments`, `refunds`, `disputes`, and `stripe_events`), new minimized provider-ledger rows, internal job routing, and the server-only canonical gateway fixtures/snapshot DTOs that prove those boundaries. Fixture/snapshot tests allow only their explicit minimized ID/linkage keys and still reject raw objects or forbidden fields. Provider IDs must not appear in browser/route output, email, CSV, general application logs, audit detail, or identity joins. Safe issue/audit rows use internal IDs and bounded codes.

- [ ] **Step 3: Extend Compose/static operational tests**

Assert base production remains `APPLICATION_MODE=maintenance`, `STRIPE_ENABLED=false`, fixture mode false, and neither app nor worker receives Stripe secret environment variables/files. The Stripe overlay may provide secrets only to app/worker, and `stripe:preflight` must occur before container-creating commands. Adding the scheduler must not change migrate/bootstrap/Caddy secret scope.

- [ ] **Step 4: Write a safe isolated production smoke driver**

`scripts/plan6b-production-smoke.ts` must:

1. Generate a cryptographically random run suffix and unique `pale-orbit-plan6b-smoke-<suffix>` Compose project, temp secret directory, and image tag `pale-orbit:plan6b-i-smoke-<suffix>`; record/validate all three as one owned-run manifest.
2. Reserve generated loopback-only ephemeral TCP ports and render a per-run Compose override with `HTTP_BIND_ADDRESS=127.0.0.1`, `HTTPS_BIND_ADDRESS=127.0.0.1`, unique HTTP/HTTPS ports (including UDP), and the unique image tag. Revalidate port availability immediately before `up`; never accept the production defaults `0.0.0.0:80/443`. Build only that unique tag from the current tree.
3. Create only nonproduction random local database/auth/SMTP secret fixtures; never read or print Stripe credentials.
4. Start base production Compose only, wait for health, run migrations twice, and verify the migration journal and seeded history counts do not change on the second run.
5. Verify storefront and commerce endpoints stay in maintenance, app/worker have `STRIPE_ENABLED=false`, no Stripe secret env/file exists, PostgreSQL is not host-published, and the worker ready file is healthy. Assert no initial/hourly provider-discovery, source, payout, or provider-call work was created while disabled; allow exactly one local composite classifier+algorithm replay root and prove it either completes with zero ledger subjects or processes only bounded existing local evidence.
6. Inspect image size/digest and report nonsecret aggregate evidence.
7. In `finally`, resolve and validate the exact project/temp paths/tag/ports against the owned-run manifest, then remove only that project, volumes, network, exact unique image tag, override, and temp directory. Never delete a fixed/shared tag.

The companion unit test mocks process execution and proves target/tag/loopback-port validation, collision refusal, cleanup on every failure point, no secret-value output, and refusal to operate on an unprefixed/broad project/path, shared tag, nonloopback bind, or default port. Add npm script `smoke:plan6b-i` for the driver.

`scripts/plan6b-fixture-runtime-probe.ts` then uses the same freshly built image in a second isolated `pale-orbit-plan6b-fixture-<pid>` project on an internal no-egress Docker network. It starts PostgreSQL, Mailpit, the actual built web process, and the actual built worker with `APP_ENV=test`, `STRIPE_ENABLED=false`, and `STRIPE_TEST_FIXTURE_MODE=true`. This is the project's fixture-backed enabled runtime; the configuration deliberately forbids setting both Stripe flags true. The probe supplies no Stripe key or webhook secret, seeds a minimal published multi-item title/customer through the existing test helpers, exercises the real HTTP quote/checkout path (the fixture gateway can create a hosted-session snapshot without preloaded state), and waits for the worker scheduler plus empty bounded fixture payout scan to complete. Assert app/worker health, runtime mode `fixture`, one accepted local order/session, one completed financial scan checkpoint, no attempted/possible external Stripe request, and no Stripe secret env/file. Provider-object fulfillment remains covered by the focused fixture/integration suites where the harness and handler share a process. The probe's mocked unit test proves bounded waits, safe output, internal-network/no-egress configuration, exact project/path validation, and cleanup on web, worker, HTTP, or database assertion failure. Add npm script `smoke:plan6b-fixture` for this probe.

- [ ] **Step 5: Run RED cross-cutting tests**

```powershell
npx vitest run scripts/commerce-privacy.test.ts scripts/commerce-operations.test.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.test.ts
npm run test:integration -- tests/integration/financial-reconciliation.test.ts tests/integration/financial-privacy.test.ts tests/integration/financial-migration.test.ts tests/integration/financial-lock-order.test.ts tests/integration/financial-sources.test.ts tests/integration/financial-payouts.test.ts
```

Expected: new assertions fail before final privacy/operations/smoke implementation is complete.

- [ ] **Step 6: Close only the proven gaps and rerun focused suites**

```powershell
npx vitest run scripts/commerce-privacy.test.ts scripts/commerce-operations.test.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.test.ts
npm run test:integration -- tests/integration/financial-reconciliation.test.ts tests/integration/financial-privacy.test.ts tests/integration/financial-migration.test.ts tests/integration/financial-lock-order.test.ts tests/integration/financial-sources.test.ts tests/integration/financial-payouts.test.ts
npm run db:check
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 7: Run the isolated production-image smoke**

```powershell
npm run smoke:plan6b-i
npm run smoke:plan6b-fixture
```

Expected: image build, base production smoke, and fixture-runtime web/worker probe pass; both migrations are idempotent; maintenance and Stripe-disabled production boundaries hold; the fixture phase processes financial work without credentials or external Stripe traffic; cleanup leaves no `pale-orbit-plan6b-smoke-*` or `pale-orbit-plan6b-fixture-*` container, volume, network, image tag, temp file, or process.

- [ ] **Step 8: Commit Task 17**

```powershell
git add tests/integration/financial-reconciliation.test.ts tests/integration/financial-privacy.test.ts tests/integration/financial-migration.test.ts tests/integration/financial-lock-order.test.ts tests/integration/financial-sources.test.ts tests/integration/financial-payouts.test.ts scripts/commerce-privacy.test.ts scripts/commerce-operations.test.ts scripts/plan6b-production-smoke.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.ts scripts/plan6b-fixture-runtime-probe.test.ts package.json
git commit -m "test: prove financial reconciliation recovery"
```

## Task 18: Document checkpoint I, run the full gate, and obtain independent review

**Files:**
- Create: `docs/stripe-financial-reconciliation.md`
- Modify: `README.md`
- Modify: `docs/commerce-and-guest-claims.md`
- Modify: `docs/database-and-workers.md`
- Modify: `docs/runtime-environments.md`
- Modify: `docs/dependency-decisions.md`
- Modify: `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md`
- Modify: `docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md`

- [ ] **Step 1: Write the checkpoint-I operations guide**

Document:

- the exact six payout webhook events and API version `2026-07-29.dahlia`;
- provider/source/payout flows, automatic-standard exact association, and manual/instant limitation;
- hourly root, classifier root, initial seven-day lookback, 72-hour overlap, batch/page 100, safe freshness meaning, and recovery after retry exhaustion;
- signed amount/fee/net and presentment/settlement currency semantics;
- issue codes and safe operator inspection; no generic resolve/direct database repair;
- backup/restore of every Plan 6B table, dependency order, and post-restore orphan/conservation/classifier-tip/payout-generation/scan-checkpoint queries;
- no raw provider/identity logging and no real credential requirement for tests;
- base/overlay secret boundary, maintenance mode, and Plan 7 launch ownership.

Keep the roadmap/design status at **6B-I candidate — independent review pending; 6B-II pending** through the first gate and candidate commit. Sales navigation remains disabled and full Plan 6B remains incomplete. The status advances to **6B-I complete; 6B-II pending** only in the final reviewed candidate described below.

- [ ] **Step 2: Run a clean dependency and generated-schema gate**

```powershell
npm ci
npm run auth:schema
git diff --exit-code -- src/lib/server/db/schema/auth.ts
npm run db:check
npm outdated --json
npm ls --depth=0
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
```

Expected: install/schema commands succeed; generated auth schema has no diff; dependency tree is valid; any nonzero outdated/audit output is recorded and dispositioned from primary advisories/changelogs rather than hidden.

- [ ] **Step 3: Run the complete application gate without parallel wrappers**

Run each wrapper serially so they cannot race over Docker or `.svelte-kit`:

```powershell
npm run check
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
npm run test:plan6b-upgrade
npx vitest run scripts/commerce-operations.test.ts scripts/commerce-privacy.test.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.test.ts
npm run smoke:plan6b-i
npm run smoke:plan6b-fixture
git diff --check
git status --short
```

Expected: every applicable command exits zero; record actual file/test counts, audit dispositions, image digest/size, migration results, and smoke cleanup. Do not copy counts from Plan 6A.

- [ ] **Step 4: Record truthful candidate evidence and commit the reviewable checkpoint**

Update the operations/dependency docs with the actual Step 2–3 results, including test/file counts, advisory dispositions, image digest/size, migration evidence, fixture-runtime evidence, and cleanup. Do not mark the checkpoint complete yet. Inspect and commit the bounded candidate so reviewers can examine the exact runtime, migration, scripts, docs, and evidence rather than an uncommitted worktree:

```powershell
git status --short
git add docs/stripe-financial-reconciliation.md README.md docs/commerce-and-guest-claims.md docs/database-and-workers.md docs/runtime-environments.md docs/dependency-decisions.md docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md
git diff --cached --check
git diff --cached
git commit -m "docs: prepare financial reconciliation checkpoint review"
git status --short
```

Expected: the implementation, smoke scripts, candidate documentation, and exact evidence are all committed; the worktree is clean; status still says independent review pending.

- [ ] **Step 5: Request five independent read-only reviews of the committed candidate**

Ask reviewers to inspect the entire Plan 6B-I base-to-head diff, not only the last task:

1. Requirements/spec traceability and phase-boundary review.
2. Security/privacy/secret and minimized-data review.
3. PostgreSQL lock-order, replay, scheduler, and payout-publication review.
4. Financial math, currency/FX, classification, and migration-integrity review.
5. Release evidence, docs, Compose, and production-image review.

Each reviewer must report ordered Critical/Important/Minor findings with exact file/line evidence or explicitly clear the diff. Give every reviewer the same implementation base commit and current candidate HEAD, and require inspection of that committed `BASE..HEAD` range. No reviewer edits files during this pass.

- [ ] **Step 6: Apply review feedback, rerun the full gate, and commit final evidence**

Use the receiving-code-review workflow. Reproduce every accepted behavior issue with a RED test before changing production behavior. Preserve unrelated work and reject suggestions that contradict the approved design with concrete evidence. For each bounded review-fix batch, inspect `git status --short`, stage only the literal file paths recorded in the review ledger (never `git add .`), run `git diff --cached --check`, inspect `git diff --cached`, and commit with `fix: harden financial reconciliation review findings` (or a more specific bounded message).

After all fixes, rerun the affected focused tests and **all of Steps 2 and 3** because review changes can affect runtime, migrations, dependencies, docs, or the image. Refresh every recorded count/digest/advisory/smoke result from that final tree, change status to **6B-I complete; 6B-II pending**, and commit the exact reviewed evidence/status paths:

```powershell
git add docs/stripe-financial-reconciliation.md README.md docs/commerce-and-guest-claims.md docs/database-and-workers.md docs/runtime-environments.md docs/dependency-decisions.md docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md
git diff --cached --check
git commit -m "docs: complete financial reconciliation checkpoint"
```

Expected: review fixes are committed in bounded fix commits; the final docs commit contains only truthful Plan 6B-I evidence/status and no Sales route/UI, CSV, administrator mutation, or production-enablement leak.

- [ ] **Step 7: Obtain final read-only clearance of the post-review tree**

Give the five reviewers the same original implementation base and the new final HEAD. Ask them to reread the complete committed range, with special focus on the review-fix commits and refreshed evidence/status. Every reviewer must explicitly clear the final tree or report a finding. If any finding is accepted, return to Step 6, add a RED regression when behavior changes, rerun the full gates/smokes, refresh evidence, commit, and repeat this final rereview. Do not edit code, scripts, migration, or evidence after the last clearance.

- [ ] **Step 8: Verify the checkpoint handoff is clean**

```powershell
git status --short
git log --oneline --decorate -12
git diff --check HEAD
```

Expected: clean worktree, no post-review delta, checkpoint status `6B-I complete; 6B-II pending`, production still closed, and every final reviewer cleared the exact current HEAD.

## Checkpoint-I acceptance traceability

| Approved design requirement | Implemented and proved by |
| --- | --- |
| Split allocation, provider lifecycle, financial evidence, and current payout state | Tasks 2–4, 10–13 |
| Immutable minimized Balance Transactions, Payouts, classifications, memberships, and issues | Tasks 2–3, 5–6, 9, 13 |
| Exact presentment/settlement separation and signed conservation | Tasks 2, 8, 10–12, 17 |
| Multiple dispute/refund/reversal and unknown-category convergence | Tasks 8–12, 15, 17 |
| Complete-page authoritative payout publication and late failure reopening | Tasks 10, 13, 17 |
| Durable hourly/version/generation scans despite permanent job dedupe | Tasks 7, 13–16 |
| One published global lock order and no provider calls under locks | Tasks 4, 10–17 |
| Real 0006-to-0007 upgrade/backfill and database history guards | Tasks 2–3, 17–18 |
| Plan 6A reducer/event semantics preserved with atomic financial handoff | Tasks 4, 16–17 |
| 6B-II draft/correction/recovery persistence and stable service seams | Tasks 2–3, 10, 12, 15 |
| Privacy, disabled-mode, maintenance, Compose, and production-image boundary | Tasks 5–7, 16–18 |

## Executor notes

- Complete tasks in order unless the dependency is explicitly independent; never merge half of Task 16.
- Mark each checkbox only after the named evidence has run and been inspected.
- Use strict TDD for behavior changes: RED test, minimal implementation, GREEN focused suite, then regression gate.
- Use a fresh subagent for each implementation task and a separate reviewer, except that Tasks 2–4 are one atomic schema/migration/application-state batch and Tasks 5–6 are one atomic adapter batch; each group stays with one subagent and is reviewed only after its final task commits. Do not let any implementer approve their own work.
- Commit at each task boundary. Do not squash away migration/replay evidence during implementation.
- Stop at checkpoint I after Task 18. Re-read the actual exported signatures and migrated schema before executing the separate 6B-II plan.
