# Backend Plan 6B-II: Admin Resolution and Reporting Implementation Plan

> **Superseded on 2026-08-20:** Do not execute this historical plan. Use [Backend Plan 6B-II: Admin Resolution and Reporting Refresh](2026-08-20-backend-plan-6b-ii-admin-resolution-reporting-refresh.md), which preserves the approved product behavior while rebasing implementation onto the hardened web/worker database-authority split.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an administrator-only Sales experience backed entirely by the checkpoint-I local financial ledger, including exact per-title reporting, safe ambiguous-refund finalization, append-only reporting corrections, narrowly proven access recovery, payout views, and audited privacy-minimized CSV export.

**Architecture:** Route loaders/actions authorize before parsing and call independently authorized server services. Reporting queries operate on immutable order snapshots plus the unique current financial base/correction projection; any incomplete money-affecting evidence nulls settlement metrics instead of becoming zero. Administrator mutations enter the published purchase/financial lock order, revalidate optimistic fingerprints, and atomically commit mutation, audit, outbox, and entitlement projection where authorized.

**Tech Stack:** Node.js 26.7.0, npm 11.19.0, SvelteKit 2.70.2, Svelte 5.56.8, TypeScript 6.0.3, PostgreSQL 18.4, Drizzle ORM 0.45.2 and Drizzle Kit 0.31.10, Stripe Node 22.5.0 pinned to API version `2026-07-29.dahlia`, Zod 4.4.3, Vitest 4.1.10, and Playwright 1.62.1.

---

## Source of truth and checkpoint boundary

Implement checkpoint **6B-II** from `docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md` only after `docs/superpowers/plans/2026-08-11-backend-plan-6b-i-financial-ingestion-reconciliation.md` is merged and green.

Checkpoint I already owns the single forward Plan 6B migration. This plan must not create a second speculative migration. It consumes the migrated draft, correction, finalization-effect, administrative-grant, payout, allocation, issue, and scan tables plus these exact server seams:

```ts
derivePublicFinancialState
loadCurrentEffectiveAllocationProjection
recomputeLockedRefundFinancialProjection
rebaseApprovedCorrectionDistributionLocked
lockPaymentPurchaseFacts
currentFinancialProjectionHeads
currentFinancialProjectionItems
```

If the actual checkpoint-I names/signatures differ, update this plan's call sites and browser-safe contracts in Task 1 before writing behavior. Do not add compatibility wrappers that preserve an obsolete draft signature.

This checkpoint owns `/admin/sales`, Needs Review, shared drafts, one-way finalization, reporting-only correction, explicit persistent recovery grants, payout views, full filtered CSV, administrator browser journeys, operations documentation, and full Plan 6B completion evidence.

This checkpoint does **not** enable live production commerce, add a generic issue Resolve button, add provider retry/sync controls, export raw orders/provider IDs/customer identity, reactivate purchase grants, or implement Plan 7 launch/monitoring/backup automation. Production remains maintenance and base production remains Stripe-disabled.

## Non-negotiable reporting and mutation invariants

- Reporting cohort time is `orders.paidAt` in UTC half-open intervals. Payout/settlement dates remain separate.
- Rows group by stable title ID, presentment currency, and nullable settlement currency. Unlike currencies are never added or converted.
- Sold copies count paid order items. A refunded copy counts only when finalized succeeded allocations equal that item's total. Partial refunds affect money, not copy count.
- Settlement algebra uses signed effects: sale subtotal + refund + dispute + processing/refund/dispute/other fee effects. Display may show reductions as magnitudes, but DTO/storage signs remain canonical.
- If any contributing money source is missing, conflicting, unresolved, or incompatible, every settlement component and estimate for that row is `null`; `missingSourceCount > 0`. A currency-pair summary also nulls settlement totals if any contributing row is incomplete.
- Drafts are shared, non-expiring, versioned proposals with no report/access/email effect.
- Finalization is one-way, validates exact total/capacity/fingerprint under locks, and may revoke only through the existing purchase-grant reducer.
- Reporting corrections are append-only, zero-sum attribution only. They never alter provider totals, `refund_allocations`, copy counts, purchase grants, entitlements, or access.
- Recovery activation requires immutable `refund_allocation_finalization_effects.transition='revoked_by_finalization'` plus a compatible corrected attribution below full-refund threshold. It creates/reactivates only the exact linked administrative grant.
- An active recovery grant is a persistent override until a separate authorized deactivation. Later provider/refund/correction/rebase operations do not deactivate it implicitly.
- Every mutation authorizes before parsing, reauthorizes in its service, uses same-origin native forms, locks/revalidates, and commits its mutation plus audit atomically. Access-changing mutations also commit projection/outbox atomically.
- Browser DTOs/HTML/CSV/audit/logs never contain customer email, raw Stripe objects, provider IDs/messages, card/billing/receipt data, secrets, or action URLs.

## Capability and route matrix

| Surface | Route authorization | Service authorization | Audit behavior |
| --- | --- | --- | --- |
| Overview and review/payout lists | `sales.read` | `sales.read` | list/filter not audited |
| Issue, refund, and payout detail | `sales.read` | `sales.read` | successful safe detail view audited |
| CSV | `sales.read` + `sales.export` | both | completed byte generation and export audited |
| Draft save/discard and finalization preview/action | `sales.read` + `reconciliation.manage` | both | every draft mutation/finalization audited atomically |
| Reporting correction preview/action | `sales.read` + `reconciliation.manage` | both | correction/rebase outcome audited atomically |
| Recovery preview/activation/deactivation | `sales.read` + `reconciliation.manage` | both | grant/projection/outbox/audit atomic |

Initially all three capabilities map to the administrator role, but keep them distinct in types, route guards, service guards, tests, and audit actions.

## Target route and module map

- `/admin/sales`: currency-pair summaries, strict filters, per-title table, and Needs Review summary.
- `/admin/sales/review`: paginated safe issue queue; `/review/[issueId]` audited read-only issue detail with named workflow link.
- `/admin/sales/refunds/[refundId]`: audited refund detail, shared draft, finalization, reporting correction, and eligible recovery actions.
- `/admin/sales/payouts`: payout list; `/payouts/[payoutId]` audited safe detail.
- `/admin/sales/export.csv`: full filtered aggregate export, not current cursor tail.
- `src/lib/server/commerce/reporting/`: filters, metrics, overview, review, payouts, and CSV read services.
- `src/lib/server/commerce/financial/refund-review/`: inputs, query, drafts, finalization, corrections, and recovery mutation services.
- `src/lib/types/financial-reporting.ts`: explicit browser-safe DTOs only; no Drizzle or Stripe types.

## Task 1: Verify the checkpoint-I handoff before touching admin behavior

**Files:** None.

- [ ] **Step 1: Confirm the branch/worktree and checkpoint state**

```powershell
git status --short
git log -5 --oneline
```

Expected: clean worktree on the intended checkpoint-II branch; checkpoint-I implementation, final evidence commit, and reviewer clearance for that exact HEAD are present (whether or not review findings required a separate fix commit).

- [ ] **Step 2: Verify schema, stable exports, and focused checkpoint-I evidence**

```powershell
npm run db:check
rg -n "export (async )?function (derivePublicFinancialState|loadCurrentEffectiveAllocationProjection|recomputeLockedRefundFinancialProjection|rebaseApprovedCorrectionDistributionLocked|lockPaymentPurchaseFacts)" src/lib/server/commerce
rg -n "refundAllocationFinalizationEffects|refundAllocationDrafts|refundReportingCorrectionSets|currentFinancialProjectionHeads|currentFinancialProjectionItems|administrative" src/lib/server/db/schema
npx vitest run src/lib/server/commerce/financial
npm run test:integration -- tests/integration/financial-schema.test.ts tests/integration/financial-migration.test.ts tests/integration/financial-reconciliation.test.ts tests/integration/financial-lock-order.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; every exact seam/table exists; the migration, projection, replay, lock, currency, and privacy checkpoint remains green. If any seam is missing or an invariant test fails, stop and repair checkpoint I before proceeding.

- [ ] **Step 3: Record the exact handoff signatures in the task notes**

Record parameter and result types actually exported by checkpoint I. Use those names consistently in Tasks 3, 6–9; do not duplicate financial projection logic in reporting/admin modules.

## Task 2: Add capabilities, browser-safe contracts, strict filters, and signed display helpers

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

- [ ] **Step 1: Write RED capability and authorization tests**

Add `sales.read`, `sales.export`, and `reconciliation.manage` to the capability union and an explicit `CAPABILITIES_BY_ROLE: Readonly<Record<ApplicationRole, ReadonlySet<AdminCapability>>>`. Export pure `capabilitiesForRoles(roles)` and make `requireCapability` consult the requested capability instead of ignoring it. Initially the administrator set contains every capability and the customer set contains none. Test each capability independently and test the pure map with a role set that lacks one capability so no route/service may assume `admin.access` implies it.

- [ ] **Step 2: Write RED filter/cursor tests**

Require:

```ts
export function parseSalesOverviewFilters(url: URL, now: Date): SalesOverviewFilters;
export function encodeSalesCursor(cursor: SalesCursor): string;
export function decodeSalesCursor(value: string, expectedFilterFingerprint: string): SalesCursor;
export function fingerprintSalesFilters(filters: SalesOverviewFilters): string;
```

Allow only single-valued:

```text
range=7|30|90|all|custom
from=YYYY-MM-DD
to=YYYY-MM-DD
titleId=<canonical UUID>
format=prose|comic
presentmentCurrency=<supported ISO>
settlementCurrency=<supported ISO>|pending
state=pending|fee_reconciled|payout_reconciled|exception
sort=gross_desc|title_asc
cursor=<canonical base64url cursor, at most 512 characters>
```

Unknown/duplicate/incompatible parameters are safe 400s. Default is 30 complete UTC days ending at today's `00:00Z`; 7/90 use the same complete-day rule. `custom` requires valid inclusive date inputs converted to half-open `[from 00:00Z, to+1 day 00:00Z)` with `from <= to`; `all` omits date predicates and has no artificial range error. Overview page size is fixed at 50 and is not caller-controlled. Cursor encoding is canonical base64url JSON, at most 512 characters, with strict version and key allowlist; order is `sort primary -> titleId -> presentmentCurrency -> settlementCurrency-or-empty`, and the payload embeds the normalized-filter fingerprint. Noncanonical encoding, wrong fingerprint, unsafe number/currency/UUID, or extra key is a 400.

- [ ] **Step 3: Write RED browser-contract and signed-money tests**

Define explicit DTOs for title rows, currency summaries, issue summaries/details, refund/draft/finalization/correction/recovery previews, payouts, action outcomes, and CSV inputs. Tests enumerate exact keys and fail on email, customer/user ID, Stripe/provider ID, raw row, evidence, free-form message, card/billing, secret, or URL fields. A shared draft DTO may expose only a safe last-editor display label plus updated timestamp—not a raw administrator ID—so two administrators can coordinate without widening identity data.

Add a signed formatter that preserves ISO code, zero-/three-decimal exponents, negative sign, safe integer validation, and explicit unavailable state. It formats for display only and never parses back into server money.

- [ ] **Step 4: Run RED focused tests**

```powershell
npx vitest run src/lib/server/auth/admin-policy.test.ts src/lib/types/financial-reporting.test.ts src/lib/server/commerce/reporting/filters.test.ts src/lib/server/commerce/reporting/context.test.ts src/routes/admin/sales/route-support.test.ts src/lib/commerce/money.test.ts
```

Expected: FAIL because new capabilities/contracts/helpers do not exist.

- [ ] **Step 5: Implement contracts and route support**

`route-support.ts` must expose route/server helpers for correlation context, safe error mapping, and capability checks. It authorizes before URL/body parsing and returns only generic 400/401/403/404/409/503 outcomes. It cannot import Stripe types or call provider services.

`context.ts` exports `FinancialRequestContext` with `correlationId: string` and optional existing `AuditRequestMetadata`; it has no Request, cookie, session, response, or identity field. `route-support.ts` converts a SvelteKit request into this bounded context after authorization. Action schemas accept IDs, expected version/fingerprint, fixed enum reason, and bounded integer proposal rows only. They reject unknown fields and canonicalize UUID case.

- [ ] **Step 6: Run GREEN contract verification**

```powershell
npx vitest run src/lib/server/auth/admin-policy.test.ts src/lib/types/financial-reporting.test.ts src/lib/server/commerce/reporting/filters.test.ts src/lib/server/commerce/reporting/context.test.ts src/routes/admin/sales/route-support.test.ts src/lib/commerce/money.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 7: Commit Task 2**

```powershell
git add src/lib/server/auth/admin-policy.ts src/lib/server/auth/admin-policy.test.ts src/lib/types/financial-reporting.ts src/lib/types/financial-reporting.test.ts src/lib/server/commerce/reporting/filters.ts src/lib/server/commerce/reporting/filters.test.ts src/lib/server/commerce/reporting/context.ts src/lib/server/commerce/reporting/context.test.ts src/routes/admin/sales/route-support.ts src/routes/admin/sales/route-support.test.ts src/lib/commerce/money.ts src/lib/commerce/money.test.ts
git commit -m "feat: add financial reporting contracts and capabilities"
```

## Task 3: Build signed metrics and the Overview read model

**Files:**
- Create: `src/lib/server/commerce/reporting/metrics.ts`
- Create: `src/lib/server/commerce/reporting/metrics.test.ts`
- Create: `src/lib/server/commerce/reporting/overview.ts`
- Create: `src/lib/server/commerce/reporting/overview.test.ts`
- Create: `tests/integration/financial-reporting.test.ts`

- [ ] **Step 1: Write RED pure metric truth-table tests**

Require:

```ts
export function toSalesTitleMetricDto(input: SalesTitleMetricInput): SalesTitleMetricDto;
export function summarizeCurrencyPairs(rows: readonly SalesTitleMetricDto[]): readonly SalesCurrencySummaryDto[];
```

Test exact signed algebra for sale subtotal, partial/full refund, processing fee, refund fee, dispute withdrawal, dispute fee, fee credit, partial/full reinstatement, and negative estimate. DTO sign is canonical signed effect; component display transforms reductions separately. Aggregate state follows `exception -> pending -> fee_reconciled -> payout_reconciled` from least to most complete; a row reaches payout-reconciled only when every contributor does.

If any money-affecting source is incomplete/conflicting/unattributable, set all settlement components and `estimatedPayoutMinor` to `null`, set `settlementMetricsComplete=false`, and retain exact `missingSourceCount`. Do not coerce unknown to zero. At summary level, one incomplete contributing row nulls all settlement totals for that currency pair while presentment gross/refund/copy totals remain available; sum the complete cohort, not only the current page.

- [ ] **Step 2: Write RED PostgreSQL read-model tests**

Require:

```ts
export async function listSalesOverview(
  actor: Actor,
  filters: SalesOverviewFilters,
  dependencies?: SalesOverviewDependencies
): Promise<SalesOverviewDto>;
```

Test:

- service-level `sales.read` authorization before query;
- paid-at half-open cohort and each preset/custom/all-time boundary;
- stable title filter and immutable sold-as order-item format filter semantics;
- stable `(titleId, presentmentCurrency, settlementCurrency)` row grain;
- current title/archive display plus deterministic immutable sold-as variants;
- sold/refunded/net copy rules and partial refund money-only behavior;
- current base plus compatible correction tip only;
- current payout join and manual/instant/failed labels;
- same-currency and FX groups without cross-sum;
- account-scoped adjustments excluded from every title value and from title/currency-pair completeness or null propagation; they may appear only in separately labeled safe payout/account diagnostics and counts;
- equal gross, same title, multiple currency-pair keyset pages with no duplicate/gap;
- `pageSize + 1` bounded query and summaries over the full filtered cohort;
- missing Charge evidence and ambiguous refund attribution null row and summary settlement metrics.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/reporting/metrics.test.ts src/lib/server/commerce/reporting/overview.test.ts
npm run test:integration -- tests/integration/financial-reporting.test.ts
```

Expected: FAIL because the metric and read services do not exist.

- [ ] **Step 4: Implement SQL/read composition from local state only**

Use immutable order/item snapshots for financial facts and current catalog data only as display metadata. Build the page, full-filter currency summaries, and later CSV from bounded SQL joins to checkpoint-I's exported read-only `currentFinancialProjectionHeads` and `currentFinancialProjectionItems` views; never reimplement classifier/allocation-chain selection, materialize an unbounded Balance Transaction ID array in application memory, or query Stripe. The page query applies keyset order plus `pageSize + 1`; the summary query aggregates the same normalized cohort/filter predicates directly over the composable views; both run under the service's bounded statement timeout. Task 11 reuses that same aggregate relation with its explicit row/byte/deadline caps.

Return summaries, page rows, bounded next cursor, normalized filters, data-through timestamp, Stripe-enabled/disabled display state, aggregate missing-source counts, and global current open Needs Review counts by impact/actionability through explicit DTO construction. `dataThroughAt` is the minimum completion time across the latest successful source, payout, and **current composite classifier+allocation replay ID** scan phases required for this view; a classifier-only stale scan does not satisfy a newer allocation algorithm. If any required phase has never completed it is `null` and the UI says freshness unavailable. Label queue counts as global rather than implying the paid-at filters constrain operational issues. Database rows do not cross the service boundary.

- [ ] **Step 5: Run GREEN reporting verification**

```powershell
npx vitest run src/lib/server/commerce/reporting/metrics.test.ts src/lib/server/commerce/reporting/overview.test.ts
npm run test:integration -- tests/integration/financial-reporting.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero and the aggregate privacy key allowlist passes.

- [ ] **Step 6: Commit Task 3**

```powershell
git add src/lib/server/commerce/reporting/metrics.ts src/lib/server/commerce/reporting/metrics.test.ts src/lib/server/commerce/reporting/overview.ts src/lib/server/commerce/reporting/overview.test.ts tests/integration/financial-reporting.test.ts
git commit -m "feat: add per-title financial reporting"
```

## Task 4: Add the Sales Overview route, navigation, and accessible responsive UI

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
- Modify: `src/routes/admin/+layout.svelte`
- Modify: `src/app.css`

- [ ] **Step 1: Write RED route tests**

Prove the Sales layout loader requires `sales.read` before rendering any child route. Prove the Overview loader:

- requires `sales.read` before reading URL parameters or invoking the reporting service;
- maps anonymous/customer/forged actors to safe denial;
- maps malformed filters/cursors to 400 and provider-disabled/read failures to bounded safe states;
- passes normalized filters and correlation context to the service;
- constructs stable next/back/filter URLs without duplicate parameters;
- returns only the exact `SalesOverviewDto` contract.

No action exists on the Overview route.

- [ ] **Step 2: Write RED component/accessibility tests**

Render and assert:

- one `<h1>`, semantic filter `<form>`, explicitly associated labels/help/errors, and native buttons/selects/inputs;
- one local Sales navigation landmark with current-page indication for Overview, Needs Review, and Payouts;
- per-currency summary groups with ISO code and no converted grand total;
- a real table with caption, scoped headers, tabular right-aligned numbers, and text reconciliation labels. Columns are current Title/creator/format, sold/refunded/net copies, presentment gross excluding tax, finalized refund subtotal, dispute withdrawal/reinstatement subtotal, settlement sale/refund/dispute effects, processing/refund/dispute/other fee effects, estimated payout, both currency domains, state, missing-source count, and freshness;
- a named, keyboard-focusable overflow region at narrow widths and semantic row context in the mobile fallback;
- empty, no-results, pending-only, stale-data, Stripe-disabled, incomplete-estimate, exception, manual/instant, and payout-reconciled states;
- exact copy `Settlement estimate unavailable`, `Estimated payout`, `Fee reconciled`, `Payout reconciled`, and `Needs review` as applicable;
- live result-status text and error alert without unexpected focus movement;
- visible `:focus-visible`, reduced-motion compatibility, long title/large negative number resilience, and no color-only status.

- [ ] **Step 3: Run route/component tests and verify RED**

```powershell
npx vitest run src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts
```

Expected: FAIL because the route and components do not exist.

- [ ] **Step 4: Implement the thin loader and admin navigation**

The loader authorizes first, parses via `parseSalesOverviewFilters`, calls `listSalesOverview`, and returns the DTO. Replace the disabled `Sales Upcoming` nav item only now, linking one top-level `Sales` entry to `/admin/sales`. The Sales layout provides local Overview, Needs Review, and Payouts links with semantic current-page state. Use the existing admin shell; do not add a competing top-level Reconciliation dashboard.

- [ ] **Step 5: Implement the accessible Overview components**

Hierarchy is currency-pair summary cards, filters, per-title table, then prominent Needs Review summary/link. Each currency-pair summary shows sold/refunded/net copies and presentment gross/refund/dispute totals; it shows settlement sale/refund/dispute/fee/estimate totals only when the entire group is complete, otherwise one unavailable label plus summed missing-source count. Use `FinancialAmount.svelte` for signed/unavailable values and show currency code adjacent to locale formatting. There is no chart; a table is the primary data surface.

Add a shared high-contrast `:focus-visible` outline in `src/app.css` that does not remove native focus from other pages. Keep Sales-specific layout rules in `sales.css`.

- [ ] **Step 6: Run GREEN UI verification**

```powershell
npx vitest run src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero and the existing admin/catalog/audit navigation tests remain green.

- [ ] **Step 7: Commit Task 4**

```powershell
git add src/routes/admin/sales src/lib/components/admin/SalesFilters.svelte src/lib/components/admin/SalesSummaryCards.svelte src/lib/components/admin/SalesTable.svelte src/lib/components/admin/FinancialAmount.svelte src/lib/components/admin/SalesOverview.test.ts src/routes/admin/+layout.svelte src/app.css
git commit -m "feat: add admin sales overview"
```

## Task 5: Add the Needs Review queue and audited safe issue detail

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

- [ ] **Step 1: Write RED service tests**

Require:

```ts
export async function listFinancialIssues(
  actor: Actor,
  input: FinancialIssueListInput
): Promise<FinancialIssueListDto>;

export async function getFinancialIssueDetail(
  actor: Actor,
  issueId: string,
  context: FinancialRequestContext
): Promise<FinancialIssueDetailDto | null>;
```

The list uses stable keyset order `actionability -> impact -> firstObservedAt -> issueId`, fixed page size 50, and current open issues. It prioritizes ambiguous refunds but includes other safe read-only issues. DTO fields are internal issue/resource IDs, safe code/impact/state, timestamps/count, correlation ID, actionability, and a named internal workflow link only.

Detail authorization and full DTO generation occur before `financial.issue.view` audit commits. If DTO generation or audit fails, no successful detail response is returned. The service never exposes provider object ID/message/evidence or identity.

- [ ] **Step 2: Write RED route/component tests**

Test authorization before params/query, malformed ID 400, inaccessible/missing 404, filter/cursor preservation in breadcrumbs, accessible table/list labels, empty state, and safe detail. Generic issues have no Resolve or provider Retry button. An actionable ambiguous-refund issue links to its refund workflow.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/reporting/review.test.ts src/routes/admin/sales/sales-routes.test.ts
npm run test:integration -- tests/integration/financial-review.test.ts
```

Expected: FAIL because the review service/routes do not exist.

- [ ] **Step 4: Implement safe list/detail and audit behavior**

List filtering is not audited. Detail audit uses the existing append-only audit service with action `financial.issue.view`, internal resource ID, safe code/impact/count, and correlation ID. Preserve return context as a signed/bounded query context; do not accept arbitrary external return URLs.

- [ ] **Step 5: Run GREEN review verification**

```powershell
npx vitest run src/lib/server/commerce/reporting/review.test.ts src/routes/admin/sales/sales-routes.test.ts
npm run test:integration -- tests/integration/financial-review.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 6: Commit Task 5**

```powershell
git add src/lib/server/commerce/reporting/review.ts src/lib/server/commerce/reporting/review.test.ts tests/integration/financial-review.test.ts src/routes/admin/sales/review src/lib/components/admin/ReviewQueue.svelte src/routes/admin/sales/sales-routes.test.ts
git commit -m "feat: add financial review queue"
```

## Task 6: Add audited refund detail and shared draft save/discard

**Files:**
- Create: `src/lib/server/commerce/financial/refund-review/inputs.ts`
- Create: `src/lib/server/commerce/financial/refund-review/inputs.test.ts`
- Create: `src/lib/server/commerce/financial/refund-review/query.ts`
- Create: `src/lib/server/commerce/financial/refund-review/query.test.ts`
- Create: `src/lib/server/commerce/financial/refund-review/drafts.ts`
- Create: `src/lib/server/commerce/financial/refund-review/drafts.test.ts`
- Create: `tests/integration/financial-refund-review.test.ts`
- Create: `src/routes/admin/sales/refunds/[refundId]/+page.server.ts`
- Create: `src/routes/admin/sales/refunds/[refundId]/+page.svelte`
- Create: `src/routes/admin/sales/refunds/refund-routes.test.ts`
- Create: `src/lib/components/admin/RefundAllocationEditor.svelte`
- Create: `src/lib/components/admin/FinancialActionOutcome.svelte`
- Create: `src/lib/components/admin/RefundReview.test.ts`

- [ ] **Step 1: Write RED input and safe-detail tests**

Strict draft input is:

```ts
export interface SaveRefundDraftInput {
  refundId: string;
  expectedVersion: number | null;
  items: readonly {
    orderItemId: string;
    totalPresentmentMinor: number;
  }[];
}
```

Allow one to 25 unique canonical order-item IDs and safe nonnegative totals; reject unknown/free-form/customer/provider fields. Detail DTO contains immutable refund total/currency, sold-as item facts, paid subtotal/tax/total, existing finalized allocations/components, remaining capacities, shared draft/version, safe last-editor label and editor timestamps, current financial completeness, and consequence-preview inputs. It contains no customer/user/email/provider ID or raw administrator ID.

- [ ] **Step 2: Write RED service/transaction tests**

Require:

```ts
export async function getRefundReviewDetail(
  actor: Actor,
  refundId: string,
  context: FinancialRequestContext
): Promise<RefundReviewDetailDto | null>;

export async function saveRefundAllocationDraft(
  actor: Actor,
  input: SaveRefundDraftInput,
  context: FinancialRequestContext
): Promise<RefundDraftActionResult>;

export async function discardRefundAllocationDraft(
  actor: Actor,
  input: { refundId: string; expectedVersion: number },
  context: FinancialRequestContext
): Promise<RefundDraftActionResult>;
```

Test both capabilities at the service, same-refund shared visibility, create/edit/no-op/discard, two-admin optimistic conflict, provider/refund graph change making a draft non-finalizable without deletion, and forced audit failure rolling back every draft mutation. Assert no change to finalized allocation, report projection, grant, entitlement, or email/outbox.

- [ ] **Step 3: Write RED route/component tests**

Test route authorization before body parsing, CSRF/same-origin native action behavior, safe 400/404/409 mapping, bounded Overview/Needs Review return-context preservation, reloading the current shared draft after conflict, exact-total and per-item errors associated with fields, keyboard editing, live saved/error status, and absence of `window.confirm`.

- [ ] **Step 4: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/query.test.ts src/lib/server/commerce/financial/refund-review/drafts.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-refund-review.test.ts
```

Expected: FAIL because the refund review services/routes do not exist.

- [ ] **Step 5: Implement audited query and draft transactions**

The detail service completes the DTO before committing `financial.refund_review.view`. Save/discard lock the refund then current draft/items in the published order, compare expected version, write the complete proposed snapshot, and append `financial.refund_draft.created|updated|discarded` in the same transaction. Draft state changes `needs_review <-> draft` only; it never advances financial evidence or resolves the issue.

- [ ] **Step 6: Run GREEN draft verification**

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/query.test.ts src/lib/server/commerce/financial/refund-review/drafts.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-refund-review.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; draft audit and mutation are atomic and access/report state is unchanged.

- [ ] **Step 7: Commit Task 6**

```powershell
git add src/lib/server/commerce/financial/refund-review/inputs.ts src/lib/server/commerce/financial/refund-review/inputs.test.ts src/lib/server/commerce/financial/refund-review/query.ts src/lib/server/commerce/financial/refund-review/query.test.ts src/lib/server/commerce/financial/refund-review/drafts.ts src/lib/server/commerce/financial/refund-review/drafts.test.ts tests/integration/financial-refund-review.test.ts src/routes/admin/sales/refunds src/lib/components/admin/RefundAllocationEditor.svelte src/lib/components/admin/FinancialActionOutcome.svelte src/lib/components/admin/RefundReview.test.ts
git commit -m "feat: add shared refund allocation drafts"
```

## Task 7: Finalize an ambiguous refund with explicit consequence confirmation

**Files:**
- Create: `src/lib/server/commerce/refund-access.ts`
- Create: `src/lib/server/commerce/refund-access.test.ts`
- Create: `src/lib/server/commerce/financial/refund-review/finalize.ts`
- Create: `src/lib/server/commerce/financial/refund-review/finalize.test.ts`
- Modify: `src/lib/server/commerce/refunds.ts`
- Modify: `src/lib/server/commerce/refunds.test.ts`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.server.ts`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.svelte`
- Modify: `src/routes/admin/sales/refunds/refund-routes.test.ts`
- Modify: `src/lib/components/admin/RefundAllocationEditor.svelte`
- Create: `src/lib/components/admin/FinancialActionConfirmation.svelte`
- Modify: `src/lib/components/admin/RefundReview.test.ts`
- Modify: `tests/integration/financial-refund-review.test.ts`

- [ ] **Step 1: Write RED consequence-preview tests**

Require:

```ts
export interface FinalizeRefundAllocationInput {
  refundId: string;
  draftVersion: number;
  previewFingerprint: string;
  confirmation: 'finalize_refund_allocation';
}

export async function previewRefundFinalization(
  actor: Actor,
  input: { refundId: string; draftVersion: number },
  context: FinancialRequestContext
): Promise<RefundFinalizationPreviewDto>;

export async function finalizeRefundAllocation(
  actor: Actor,
  input: FinalizeRefundAllocationInput,
  context: FinancialRequestContext
): Promise<RefundFinalizationResult>;
```

The finalization input is a strict allowlist and contains no item proposal rows, customer/provider fields, free-form reason/evidence, or access/grant fields: it finalizes the already locked/versioned shared draft. Reject a noncanonical UUID, nonpositive/out-of-range version, malformed fingerprint, wrong confirmation literal, or any unknown field before database work. Exact replay of an already committed matching finalization returns the existing safe result; a reused input against changed/unfinalized state is 409 and never creates a second allocation/provenance chain.

Preview reports for each safe item: proposed total, subtotal/tax split, whether it becomes fully refunded, whether its exact purchase grant would be revoked, whether another active grant preserves effective access, and whether an access-change email is expected. It exposes title/sold-as labels, never user/email identity. Preview fingerprint includes refund/payment/order/items/current allocations/draft version and current grant-state version.

- [ ] **Step 2: Extract the existing locked access reducer under RED tests**

Move the provider-neutral purchase-grant recomputation from the large refund reducer into `refund-access.ts` without changing Plan 6A behavior. Unit and existing integration tests must prove automatic refunds still yield identical grant/entitlement/outbox results.

- [ ] **Step 3: Write RED finalization integration tests**

Finalization must:

- require succeeded ambiguous refund, current draft/version/fingerprint, exact sum to refund amount, and per-item cumulative subtotal/tax capacity;
- enter order advisory -> order -> payment -> refunds -> drafts/items -> existing allocations/components -> corrections/items -> disputes/items -> order items -> financial rows -> entitlement scopes/grants;
- split proposed item totals over remaining subtotal/tax capacity with the checkpoint-I signed largest-remainder helper;
- insert immutable admin `refund_allocations` and `refund_allocation_components`;
- write one immutable `refund_allocation_finalization_effects` row per exact purchase grant, including `unchanged | revoked_by_finalization` and before/after effective access;
- call `recomputeLockedRefundFinancialProjection` inside the same transaction;
- invoke the extracted access reducer, queue existing refund-access email only on effective change, resolve only the linked issue after recomputation, freeze the draft, and audit atomically.

Test two-admin finalization race, provider/refund change after preview, idempotent exact replay, over-capacity, another active grant, unclaimed guest item, forced audit failure, forced outbox failure, and forced financial projection failure. Every forced failure rolls back allocation/components/provenance/grant/entitlement/issue/audit/outbox together.

- [ ] **Step 4: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/refund-access.test.ts src/lib/server/commerce/financial/refund-review/finalize.test.ts src/lib/server/commerce/refunds.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-refund-review.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-lock-order.test.ts
```

Expected: FAIL before extraction/finalization is implemented.

- [ ] **Step 5: Implement server-backed prepare then confirm**

Use two native form actions: `prepareFinalize` computes/stores the bounded preview token/fingerprint in returned page state; `confirmFinalize` submits that exact fingerprint and explicit confirmation. Do not rely on `window.confirm`. Confirmation text states allocation is immutable, can revoke purchase access, and a later report correction does not automatically restore access.

On a stale preview, return 409 with actionable copy and reload current facts; never apply a partially stale proposal.

- [ ] **Step 6: Run GREEN finalization verification**

```powershell
npx vitest run src/lib/server/commerce/refund-access.test.ts src/lib/server/commerce/financial/refund-review/finalize.test.ts src/lib/server/commerce/refunds.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-refund-review.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-lock-order.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero, exact replay has one outcome, and access/email/audit effects are atomic.

- [ ] **Step 7: Commit Task 7**

```powershell
git add src/lib/server/commerce/refund-access.ts src/lib/server/commerce/refund-access.test.ts src/lib/server/commerce/financial/refund-review/finalize.ts src/lib/server/commerce/financial/refund-review/finalize.test.ts src/lib/server/commerce/refunds.ts src/lib/server/commerce/refunds.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundAllocationEditor.svelte src/lib/components/admin/FinancialActionConfirmation.svelte src/lib/components/admin/RefundReview.test.ts tests/integration/financial-refund-review.test.ts
git add -- 'src/routes/admin/sales/refunds/[refundId]/+page.server.ts' 'src/routes/admin/sales/refunds/[refundId]/+page.svelte'
git commit -m "feat: finalize ambiguous refund allocations"
```

## Task 8: Add append-only reporting corrections and classifier-rebase behavior

**Files:**
- Create: `src/lib/server/commerce/financial/refund-review/corrections.ts`
- Create: `src/lib/server/commerce/financial/refund-review/corrections.test.ts`
- Create: `tests/integration/financial-corrections.test.ts`
- Create: `src/lib/components/admin/ReportingCorrectionEditor.svelte`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.server.ts`
- Modify: `src/routes/admin/sales/refunds/[refundId]/+page.svelte`
- Modify: `src/routes/admin/sales/refunds/refund-routes.test.ts`
- Modify: `src/lib/components/admin/RefundReview.test.ts`

- [ ] **Step 1: Write RED correction input and preview tests**

Require:

```ts
export interface ReportingCorrectionInput {
  refundId: string;
  reason: 'allocation_attribution_correction';
  expectedCorrectionVersion: number;
  expectedBaseAllocationSetId: string;
  expectedSourceFingerprint: string;
  items: readonly {
    orderItemId: string;
    totalPresentmentMinor: number;
  }[];
}

export async function previewReportingCorrection(
  actor: Actor,
  input: ReportingCorrectionInput,
  context: FinancialRequestContext
): Promise<ReportingCorrectionPreviewDto>;

export async function createReportingCorrection(
  actor: Actor,
  input: ReportingCorrectionInput & { previewFingerprint: string },
  context: FinancialRequestContext
): Promise<ReportingCorrectionResult>;
```

Input uses only the fields above: refund ID, fixed reason, expected correction-chain version, exact base tip/source fingerprint, and one to 25 approved absolute per-item total-presentment amounts. The browser never submits subtotal, tax, settlement, fee, delta, currency, capacity, copy, grant, or access fields. Reject free-form reason/evidence, provider/customer fields, unsafe or negative totals, duplicates, unknown fields, and more than 25 rows. The server re-reads currency/capacity facts and derives every subtotal/tax/settlement/refund-fee component and signed delta under locks.

Preview must calculate old/new effective absolute distributions and zero-sum deltas independently for:

- presentment refund subtotal;
- presentment refund tax;
- settlement refund gross attribution;
- refund-specific fee attribution whose deterministic weight changes.

It must not move original charge-processing fees, unrelated/account fee effects, provider totals, copy counts, or access.

- [ ] **Step 2: Write RED correction transaction/rebase tests**

Require finalized succeeded refund, complete canonical BT/current allocation, exact compatible base/correction tip, and component capacities. Lock the complete purchase/financial chain before deciding. Test:

- first correction and a later successor use one append-only predecessor chain;
- stale/concurrent proposals return 409 and do not fork;
- each domain/source/currency delta sum is zero;
- effective component values stay within paid capacities;
- refund-specific fee attribution follows corrected refunded-subtotal weights and still conserves the original provider fee basis;
- report changes while `refund_allocations`, copy counts, grants, entitlements, access, and emails do not;
- classifier replay calls checkpoint-I `rebaseApprovedCorrectionDistributionLocked` and preserves the approved absolute distribution;
- incompatible rebase opens `correction_rebase_required`, yields null metrics, and disables recovery eligibility;
- correction mutation, issue transition, and `financial.refund_correction.created` audit are atomic, including forced-audit rollback.

- [ ] **Step 3: Write RED route/component confirmation tests**

The component shows old/new attribution by item/currency, all component deltas, completeness effect, and exact copy: `Reporting only — this does not restore or revoke access.` Use server-backed prepare/confirm, native controls, field-linked validation, and status/alert announcements. No generic issue resolve control is added.

- [ ] **Step 4: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/corrections.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-corrections.test.ts tests/integration/financial-reclassification.test.ts tests/integration/financial-lock-order.test.ts
```

Expected: FAIL because correction services/UI do not exist.

- [ ] **Step 5: Implement append-only correction creation**

Load effective base/correction projection through checkpoint I. Store the administrator-approved absolute distribution as well as signed deltas. Insert one successor set/items, recompute current projection, resolve only canonically satisfied issue(s), and audit in one transaction. Never update an earlier correction or silently attach an old correction to a new base.

- [ ] **Step 6: Run GREEN correction verification**

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/corrections.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-corrections.test.ts tests/integration/financial-reclassification.test.ts tests/integration/financial-lock-order.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; effective report distribution changes exactly once and access history is unchanged.

- [ ] **Step 7: Commit Task 8**

```powershell
git add src/lib/server/commerce/financial/refund-review/corrections.ts src/lib/server/commerce/financial/refund-review/corrections.test.ts tests/integration/financial-corrections.test.ts src/lib/components/admin/ReportingCorrectionEditor.svelte src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
git add -- 'src/routes/admin/sales/refunds/[refundId]/+page.server.ts' 'src/routes/admin/sales/refunds/[refundId]/+page.svelte'
git commit -m "feat: add refund reporting corrections"
```

## Task 9: Add the narrowly proven persistent administrative recovery grant

**Files:**
- Create: `src/lib/server/commerce/financial/refund-review/recovery.ts`
- Create: `src/lib/server/commerce/financial/refund-review/recovery.test.ts`
- Create: `tests/integration/financial-recovery.test.ts`
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

- [ ] **Step 1: Write RED grant-isolation and eligibility tests**

First prove Plan 6A refund/dispute reducers never create, update, deactivate, or delete an `administrative` grant. Their projections consider it when deriving effective access but mutation targets remain purchase grants only.

Require:

```ts
export interface AdministrativeRecoveryInput {
  refundId: string;
  finalizationEffectId: string;
  orderItemId: string;
  expectedCorrectionSetId: string;
  expectedCorrectionVersion: number;
  expectedSourceFingerprint: string;
  confirmation: 'activate_persistent_recovery';
}

export interface AdministrativeRecoveryDeactivationInput {
  recoveryGrantId: string;
  recoveryReferenceId: string;
  expectedStateChangedAt: string;
  confirmation: 'deactivate_persistent_recovery';
}

export async function previewAdministrativeRecovery(
  actor: Actor,
  input: AdministrativeRecoveryInput,
  context: FinancialRequestContext
): Promise<AdministrativeRecoveryPreviewDto>;

export async function activateAdministrativeRecoveryGrant(
  actor: Actor,
  input: AdministrativeRecoveryInput & { previewFingerprint: string },
  context: FinancialRequestContext
): Promise<AdministrativeRecoveryResult>;

export async function deactivateAdministrativeRecoveryGrant(
  actor: Actor,
  input: AdministrativeRecoveryDeactivationInput,
  context: FinancialRequestContext
): Promise<AdministrativeRecoveryResult>;
```

Activation includes only the exact refund/finalization-effect/order-item/correction-tip identifiers and optimistic source/version evidence above. Deactivation includes only the internal administrative grant, its immutable recovery reference, the expected canonical UTC state-transition timestamp, and the fixed confirmation literal. Both schemas are strict, canonicalize UUIDs, bound fingerprint/timestamp/version lengths, and reject unknown, customer/user/title/provider, money, free-form reason/evidence, or arbitrary grant-source fields before database work. Under locks, re-read every identifier/version/fingerprint/state; stale activation or deactivation returns safe 409, exact replay returns the existing safe result without another email/audit transition, and a forged cross-link is 404/409 without leaking identity.

Activation eligibility requires all of:

- exact immutable finalization effect is `revoked_by_finalization`;
- effect links the same administrative finalized allocation, refund, order item, and exact claimed purchase grant;
- purchase grant was not already revoked before that finalization;
- current compatible finalized correction tip/fingerprint attributes less than the full-refund threshold to that item;
- no `correction_rebase_required`/incomplete projection;
- exact user/title is taken from the purchase grant;
- claimed user exists; an unclaimed guest is ineligible.

Automatic/legitimate full refund, unchanged finalization, unrelated correction, forged IDs, stale versions, and arbitrary user/title must fail safely.

- [ ] **Step 2: Write RED lock, persistence, and atomicity tests**

Activation enters through `lockPaymentPurchaseFacts`: order advisory -> order -> payment -> every refund/draft/finalized allocation/component/correction -> every dispute/item row -> order items. It then locks/revalidates the exact finalization provenance, current compatible correction tip/fingerprint, and cumulative full-refund eligibility before entitlement scope/grants. It never starts at the provenance/item or entitlement scope. Deterministic concurrent correction-versus-activation **and unrelated-refund/finalization-versus-activation** barriers must serialize, then revalidate eligibility; a newly legitimate cumulative full refund makes activation return 409/ineligible.

Create/reactivate one uniquely linked `administrative` grant with reason `refund_allocation_recovery`; never mutate the purchase grant. Project effective access, queue an email only if effective access changes, and audit `financial.recovery_grant.activated` atomically.

After activation, apply a later correction, automatic refund, dispute, and classifier rebase: the administrative grant remains active even if the item becomes fully refunded again. Only explicit confirmed deactivation may deactivate that exact grant. Deactivation locks the entitlement scope/grant, projects access, conditionally emails, and audits atomically without changing financial rows.

Force audit/outbox/projection errors and prove full rollback. Test exact replay, concurrent activations, another active grant, and deactivation replay.

- [ ] **Step 3: Write RED bounded email and confirmation tests**

Add a safe admin-recovery access-change template using existing customer-facing title data and action outcome only. Use deduplication key `commerce:recovery-access:<grant-id>:<active|revoked>:<state-change-epoch-ms>` derived from the locked grant's actual transition timestamp; an idempotent no-op does not change the timestamp or enqueue again. Do not include administrator identity, internal/provider IDs, financial amounts, email address in logs, or action links.

UI preview states the exact title/effective-access transition and explicit persistence warning: the override remains active through future refunds/corrections/disputes until a separate deactivation. Use server-backed confirmation, not `window.confirm`.

- [ ] **Step 4: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/recovery.test.ts src/lib/server/commerce/grants.test.ts src/lib/server/commerce/email/payload.test.ts src/lib/server/commerce/email/enqueue.test.ts src/lib/server/commerce/email/render.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-recovery.test.ts tests/integration/financial-corrections.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-disputes.test.ts tests/integration/commerce-lock-order.test.ts
```

Expected: FAIL because recovery services/template/UI do not exist and reducers do not yet explicitly isolate administrative grants.

- [ ] **Step 5: Implement activation/deactivation with exact causal proof**

Read causal provenance from `refund_allocation_finalization_effects`; do not infer it from audit JSON or current grant state. Record the administrative grant's unique recovery reference and use existing entitlement projection helpers. Reporting/projection services treat the grant as access-only and never as a financial/copy fact.

- [ ] **Step 6: Run GREEN recovery verification**

```powershell
npx vitest run src/lib/server/commerce/financial/refund-review/recovery.test.ts src/lib/server/commerce/grants.test.ts src/lib/server/commerce/email/payload.test.ts src/lib/server/commerce/email/enqueue.test.ts src/lib/server/commerce/email/render.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts
npm run test:integration -- tests/integration/financial-recovery.test.ts tests/integration/financial-corrections.test.ts tests/integration/commerce-refunds.test.ts tests/integration/commerce-disputes.test.ts tests/integration/commerce-lock-order.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; persistent override and explicit deactivation behavior are proven in combined sequences.

- [ ] **Step 7: Commit Task 9**

```powershell
git add src/lib/server/commerce/financial/refund-review/recovery.ts src/lib/server/commerce/financial/refund-review/recovery.test.ts tests/integration/financial-recovery.test.ts src/lib/components/admin/AdministrativeRecoveryActions.svelte src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/RefundReview.test.ts src/lib/server/commerce/grants.ts src/lib/server/commerce/grants.test.ts src/lib/server/commerce/email/payload.ts src/lib/server/commerce/email/payload.test.ts src/lib/server/commerce/email/enqueue.ts src/lib/server/commerce/email/enqueue.test.ts src/lib/server/commerce/email/render.ts src/lib/server/commerce/email/render.test.ts
git add -- 'src/routes/admin/sales/refunds/[refundId]/+page.server.ts' 'src/routes/admin/sales/refunds/[refundId]/+page.svelte'
git commit -m "feat: add administrative access recovery"
```

## Task 10: Add safe payout list and audited detail views

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

- [ ] **Step 1: Write RED payout reporting service tests**

Require:

```ts
export async function listPayouts(
  actor: Actor,
  input: PayoutListInput
): Promise<PayoutListDto>;

export async function getPayoutDetail(
  actor: Actor,
  payoutId: string,
  context: FinancialRequestContext
): Promise<PayoutDetailDto | null>;
```

Use fixed page size 50 and keyset order `providerCreatedAt desc -> internal payoutId desc`. DTO fields are internal ID, automatic/manual, standard/instant/unknown, current/reconciliation status, signed amount/currency, created/arrival/settlement labels, associated count, bookstore-linked subtotal, account-level adjustment count/amount when complete, safe failure code, current freshness/generation, and historical-membership notice. Never return provider payout/BT/source IDs.

Test automatic completed paid, pending, manual, instant, failed/canceled/reversed with retained history, unrelated account activity, incomplete run, and current generation changes. Do not imply bookstore-linked subtotal equals the full payout.

- [ ] **Step 2: Write RED route/component tests**

List authorizes before cursor parsing and is not audited. Detail authorizes, builds the complete safe DTO, then commits `financial.payout.view`. Assert copy `Fee reconciled — exact payout membership unavailable` for manual/instant, text-only status, signed/currency-explicit values, semantic table/detail lists, bounded filter/cursor-aware back links, and no sync/retry button.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/reporting/payouts.test.ts src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts
npm run test:integration -- tests/integration/financial-payout-reporting.test.ts
```

Expected: FAIL because payout reporting routes/services do not exist.

- [ ] **Step 4: Implement local-only payout read services**

Query only checkpoint-I payout/run/membership/ledger/allocation state. Detail audit occurs after DTO generation and before response. Missing or inaccessible internal ID returns 404 without leaking provider existence.

- [ ] **Step 5: Run GREEN payout-view verification**

```powershell
npx vitest run src/lib/server/commerce/reporting/payouts.test.ts src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts
npm run test:integration -- tests/integration/financial-payout-reporting.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 6: Commit Task 10**

```powershell
git add src/lib/server/commerce/reporting/payouts.ts src/lib/server/commerce/reporting/payouts.test.ts tests/integration/financial-payout-reporting.test.ts src/routes/admin/sales/payouts src/lib/components/admin/PayoutTable.svelte src/routes/admin/sales/sales-routes.test.ts src/lib/components/admin/SalesOverview.test.ts
git commit -m "feat: add financial payout views"
```

## Task 11: Export the full filtered aggregate as bounded audited CSV

**Files:**
- Create: `src/lib/server/commerce/reporting/csv.ts`
- Create: `src/lib/server/commerce/reporting/csv.test.ts`
- Create: `tests/integration/financial-audit-export.test.ts`
- Create: `src/routes/admin/sales/export.csv/+server.ts`
- Modify: `src/routes/admin/sales/sales-routes.test.ts`

- [ ] **Step 1: Write RED CSV cell-security tests**

Require:

```ts
export function neutralizeCsvText(value: string): string;
export function serializeSalesCsv(rows: readonly SalesCsvRow[]): Uint8Array;
export async function exportSalesCsv(
  actor: Actor,
  filters: SalesOverviewFilters,
  context: FinancialRequestContext
): Promise<{ bytes: Uint8Array; filename: string; rowCount: number }>;
```

Text-origin neutralization is exact:

1. If character zero is tab, CR, or LF, prefix one apostrophe.
2. Otherwise skip only ASCII space characters; if the next character is `=`, `+`, `-`, `@`, tab, CR, or LF, prefix one apostrophe.
3. Then apply RFC 4180 quoting/double-quote escaping. Serialize rows with CRLF separators and one final CRLF, without a UTF-8 BOM.

Test `"\tcmd"`, `"\r=SUM(A1:A2)"`, `"\n=SUM(A1:A2)"`, ordinary spaces followed by `=SUM(A1:A2)`, Unicode, quotes, comma, CRLF, empty text, and long bounded text. Apply neutralization only to text-origin cells. Canonical validated integer cells—including negative estimates/effects—serialize as base-10 numbers without apostrophe.

- [ ] **Step 2: Write RED service/route/export tests**

CSV intentionally removes the Overview cursor and exports the complete filtered aggregate in the same deterministic row order. It reuses every noncursor filter and formula. The bounds are 10,000 aggregate rows, 10 MiB encoded bytes, and 25 seconds. Export them as `SALES_CSV_MAX_ROWS=10_000`, `SALES_CSV_MAX_BYTES=10 * 1024 * 1024`, and `SALES_CSV_DEADLINE_MS=25_000` from `csv.ts`; the deadline finishes before the production 30-second statement timeout. Exceeding any bound returns a safe request-to-narrow-filters error and no partial file/audit.

Columns are stable and explicit: stable internal title ID, current display title/archive state, deterministic sold-as variants JSON containing immutable sold-as title, creator, and format, current format filter value, presentment currency, nullable settlement currency, sold/refunded/net copies, presentment gross, refund subtotal/tax, dispute withdrawal subtotal/tax, dispute reinstatement subtotal/tax, every nullable signed settlement component, estimated payout, completeness flag, missing-source count, public state, UTC range, and data-through timestamp. Incomplete settlement cells are blank, never zero. Presentment dispute columns are independent of the settlement-domain columns and must match the Overview DTO exactly.

Route/service both require `sales.read` and `sales.export` before parsing/querying. Generate all bytes inside the authorized database transaction, then append `financial.sales_export` with filters fingerprint/row count/byte count/currency-pair count and correlation ID before commit. Audit failure prevents the response.

Require headers:

```text
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="pale-orbit-sales-<from>-<to>.csv"
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

Use an ASCII date-derived filename. All-time uses `pale-orbit-sales-all-time.csv`.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npx vitest run src/lib/server/commerce/reporting/csv.test.ts src/routes/admin/sales/sales-routes.test.ts
npm run test:integration -- tests/integration/financial-audit-export.test.ts tests/integration/financial-reporting.test.ts
```

Expected: FAIL because CSV service/route do not exist.

- [ ] **Step 4: Implement bounded full-result export**

Factor the unpaginated bounded aggregate from the Overview service so HTML and CSV share SQL/formulas/order. Do not concatenate current page results or accept cursor as a data boundary. Build bytes with an explicit byte accumulator that checks the cap before each append; never return a truncated CSV.

Exclude identity, provider IDs, issues/evidence, raw objects, audit metadata, and operational links. DTO/key privacy tests apply to both row objects and encoded text.

- [ ] **Step 5: Run GREEN export verification**

```powershell
npx vitest run src/lib/server/commerce/reporting/csv.test.ts src/routes/admin/sales/sales-routes.test.ts
npm run test:integration -- tests/integration/financial-audit-export.test.ts tests/integration/financial-reporting.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero; CSV rows/totals/order match the unpaginated Overview service and negative numeric cells remain numeric.

- [ ] **Step 6: Commit Task 11**

```powershell
git add src/lib/server/commerce/reporting/csv.ts src/lib/server/commerce/reporting/csv.test.ts tests/integration/financial-audit-export.test.ts src/routes/admin/sales/export.csv/+server.ts src/routes/admin/sales/sales-routes.test.ts
git commit -m "feat: export audited sales reports"
```

## Task 12: Harden cross-surface authorization, audit, and privacy boundaries

**Files:**
- Create: `tests/integration/financial-authorization-audit.test.ts`
- Modify: `tests/integration/audit-query.test.ts`
- Modify: `src/routes/admin/sales/sales-routes.test.ts`
- Modify: `src/routes/admin/sales/refunds/refund-routes.test.ts`
- Modify: `src/lib/components/admin/SalesOverview.test.ts`
- Modify: `src/lib/components/admin/RefundReview.test.ts`
- Modify: `tests/e2e/commerce-privacy.ts`
- Modify: `scripts/commerce-privacy.test.ts`

- [ ] **Step 1: Add a RED route/service capability matrix**

For every loader, detail, action, and export, test anonymous, customer, administrator missing each individual capability, and fully authorized administrator. Use injected spies to prove denial occurs before URL params, query, body, database, audit, email, or provider work. Direct service invocation must enforce the same matrix; hidden UI is not authorization.

Test same-origin/CSRF rejection for every mutation and strict unknown-field rejection before any write. Missing/inaccessible resources return safe 404; malformed inputs return safe 400; stale fingerprints return 409; internal failures never expose SQL/provider errors.

- [ ] **Step 2: Add RED audit atomicity and visibility tests**

Enumerate these actions in existing audit filters/details—do not build a second audit dashboard:

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
financial.balance_transaction.imported
financial.payment_reconciled
financial.payout.membership_published
financial.issue.opened
financial.issue.resolved
financial.classification.appended
financial.allocation.superseded
financial.correction.rebased
financial.correction.rebase_failed
```

List filtering is unaudited. Detail/export audit occurs only after successful authorization and safe DTO/bytes generation. Every mutation audit is in the same transaction. Inject audit failure into each mutation and assert complete rollback.

- [ ] **Step 3: Expand privacy scans with exact safe DTO allowlists**

Scan admin HTML, serialized loader/action data, CSV bytes, browser console, captured service logs, newly added financial/reporting DB rows, rendered email content, and financial audit before/after. Reject customer identity, provider messages/URLs/raw shapes, card/billing/receipt data, secrets, action tokens/URLs, SQL errors, and unsafe CSV formulas on every admin/output/log/audit surface. Bounded provider IDs are allowed only in the existing minimized server-only Plan 6A commerce source/event linkage rows, checkpoint-I minimized provider-ledger, internal job-routing columns, and server-only canonical fixture/DTO boundaries; they are never allowed in HTML/JSON/CSV/email/log/audit. Core identity tables and the outbox's delivery-address column are outside this financial-row scan. Draft/correction/provenance records and append-only audits may contain the bounded administrator actor ID in their explicit attribution column, as required for accountability; it may not be copied into customer-facing output, CSV, email, logs, or arbitrary evidence JSON. Tests prove no **customer** identity is copied into any Plan 6B table/audit/DTO, only the approved administrator-attribution fields contain an actor ID, safe DTOs use the last-editor label rather than the raw ID, and no delivery address enters rendered body or logs. Internal aggregate IDs and bounded codes are allowed only in their documented DTO/audit positions.

Extend `tests/e2e/commerce-privacy.ts` as reusable scanners rather than making the existing commerce harness substantially larger.

- [ ] **Step 4: Run the new tests and verify RED**

```powershell
npx vitest run src/routes/admin/sales/sales-routes.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/SalesOverview.test.ts src/lib/components/admin/RefundReview.test.ts scripts/commerce-privacy.test.ts
npm run test:integration -- tests/integration/financial-authorization-audit.test.ts tests/integration/audit-query.test.ts tests/integration/financial-audit-export.test.ts
```

Expected: at least the newly asserted matrix/audit/privacy cases fail until all surfaces are wired consistently.

- [ ] **Step 5: Fix only demonstrated boundary gaps**

Use shared route support and service guards; do not weaken tests or add broad administrator bypasses. Redact recursively through the existing audit service. Preserve provider-neutral/local-only reporting.

- [ ] **Step 6: Run GREEN hardening verification**

```powershell
npx vitest run src/routes/admin/sales/sales-routes.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/SalesOverview.test.ts src/lib/components/admin/RefundReview.test.ts scripts/commerce-privacy.test.ts
npm run test:integration -- tests/integration/financial-authorization-audit.test.ts tests/integration/audit-query.test.ts tests/integration/financial-audit-export.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all commands exit zero and forced-audit failures leave no partial mutation/outbox/grant/allocation/correction.

- [ ] **Step 7: Commit Task 12**

```powershell
git add tests/integration/financial-authorization-audit.test.ts tests/integration/audit-query.test.ts src/routes/admin/sales/sales-routes.test.ts src/routes/admin/sales/refunds/refund-routes.test.ts src/lib/components/admin/SalesOverview.test.ts src/lib/components/admin/RefundReview.test.ts tests/e2e/commerce-privacy.ts scripts/commerce-privacy.test.ts
git commit -m "test: harden financial admin boundaries"
```

## Task 13: Cover administrator journeys, accessibility, responsiveness, and privacy in a real browser

**Files:**
- Create: `tests/e2e/financial-harness.ts`
- Create: `tests/e2e/sales-reporting.spec.ts`
- Create: `tests/e2e/refund-review.spec.ts`
- Modify: `tests/e2e/database.ts`
- Modify: `tests/e2e/admin.spec.ts`
- Modify: `tests/e2e/commerce-harness.ts`
- Modify: `tests/e2e/commerce-privacy.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Build a provider-neutral browser fixture seam under unit/static tests**

The E2E harness may call checkpoint-I canonical services and fixture gateway from test setup; it may not expose an ad-hoc public mutation route, call Stripe, insert contradictory rows directly, or carry customer/provider secrets into page data. Keep additions to the existing commerce harness small and move financial setup into `financial-harness.ts`.

- [ ] **Step 2: Add the RED Sales reporting journey**

Cover:

- administrator sign-in and Sales nav;
- empty and populated Overview;
- 7/30/90/custom/all-time, title, format, presentment/settlement currency, state, sort, clear, and keyset pagination;
- equal-gross same-title multi-currency-pair paging;
- multiple and FX currencies with no combined total;
- renamed/archived title with sold-as evidence;
- partial/full/cumulative refunds and copy counts;
- pending evidence and ambiguous attribution nulling row and currency summary settlement metrics;
- automatic paid, manual, instant, failed payout labels/details;
- full filtered CSV download, negative numeric parity, formula-safe text, no cursor truncation, headers, export audit, and bound failure without partial file;
- existing audit dashboard links/actions.

- [ ] **Step 3: Add the RED refund resolution journey**

Cover:

- Needs Review -> audited refund detail;
- shared draft create/edit and second-admin stale conflict recovery;
- keyboard-only prepare/confirmation with exact access consequences;
- finalize -> immutable allocation/components/provenance -> purchase grant/effective access/email/audit;
- another active grant preserving access and suppressing email;
- reporting-only correction changes report but not access/copies/email;
- eligible administrative recovery activates the exact grant, survives later correction/refund/dispute, then explicit deactivation;
- automatic/full-refund, unclaimed guest, forged, stale, and incompatible-rebase recovery denial.

- [ ] **Step 4: Add accessibility/responsive and privacy assertions**

Use semantic role/name assertions, keyboard Tab/Enter/Space only for all actions, computed visible focus styles, status/alert announcements, non-color labels, reduced motion, 320 CSS-pixel viewport, 200% zoom equivalent, long titles, large negative amounts, and focusable table regions. Confirmation must be a named native form/dialog-like region with explicit buttons; no `window.confirm`.

Run the expanded privacy scanner across HTML/loader/action/CSV/console/new-financial-tables/audit/rendered-email, with the explicit minimized-ledger and outbox-delivery exceptions from Task 12. Test anonymous and customer denial for all new URLs/actions.

- [ ] **Step 5: Run focused browser tests and verify RED**

```powershell
npm run test:e2e -- tests/e2e/sales-reporting.spec.ts tests/e2e/refund-review.spec.ts tests/e2e/admin.spec.ts
```

Expected: new journeys fail before the harness/surfaces are complete; capture the exact first failures, not screenshots containing secrets.

- [ ] **Step 6: Implement only test/harness and proven UI fixes, then rerun**

```powershell
npm run test:e2e -- tests/e2e/sales-reporting.spec.ts tests/e2e/refund-review.spec.ts tests/e2e/admin.spec.ts
npm run check
npm run lint
git diff --check
```

Expected: all focused journeys pass in the isolated test database/worker with fixture Stripe and no real credentials.

- [ ] **Step 7: Commit Task 13**

```powershell
git add tests/e2e/financial-harness.ts tests/e2e/sales-reporting.spec.ts tests/e2e/refund-review.spec.ts tests/e2e/database.ts tests/e2e/admin.spec.ts tests/e2e/commerce-harness.ts tests/e2e/commerce-privacy.ts playwright.config.ts
git commit -m "test: cover financial reporting journeys"
```

## Task 14: Publish the operations guide, pass the full release gate, and close Plan 6B

**Files:**
- Create: `docs/financial-reconciliation-and-reporting.md`
- Modify: `README.md`
- Modify: `docs/stripe-financial-reconciliation.md`
- Modify: `docs/commerce-and-guest-claims.md`
- Modify: `docs/database-and-workers.md`
- Modify: `docs/runtime-environments.md`
- Modify: `docs/storage-ingestion-and-publication.md`
- Modify: `docs/dependency-decisions.md`
- Modify: `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md`
- Modify: `docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md`
- Modify: `scripts/plan6b-production-smoke.ts`
- Modify: `scripts/plan6b-production-smoke.test.ts`
- Modify: `scripts/plan6b-fixture-runtime-probe.ts`
- Modify: `scripts/plan6b-fixture-runtime-probe.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the complete administrator and operator guide**

Document:

- Overview fields/formulas/signs, copy semantics, incomplete/null propagation, currency-pair summaries, UTC presets/custom/all-time, keyset behavior, and current-title versus sold-as evidence;
- exact reconciliation labels/freshness and automatic-standard versus manual/instant/failed payout meaning;
- Needs Review, safe issue details, shared draft lifecycle, one-way finalization, per-item access/email consequences, reporting-only corrections/rebase failure, and persistent recovery override/deactivation;
- CSV full-filter scope, limits, columns, formula neutralization, privacy, headers, and audit;
- capability matrix, audit actions, safe support procedure, no direct DB/provider repair or generic resolution;
- backup/restore dependencies and validation queries for drafts, corrections, finalization effects, administrative grants, allocations, payouts, scan runs, issue chains, and outbox/audit atomicity;
- exact webhook allowlist/API pin and checkpoint-I scan behavior;
- production remains maintenance/Stripe-disabled in base; Plan 7 owns launch.

Keep the roadmap/design status at **Plan 6B candidate — independent review pending** through the first full gate and candidate commit. Do not mark Plan 6B complete until the final reviewed candidate below.

- [ ] **Step 2: Generalize the isolated smoke label for the final tree**

Keep the validated collision-safe cleanup behavior from checkpoint I. Add `--stage 6b-ii` and npm script `smoke:plan6b`; the driver still generates a cryptographically unique per-run tag such as `pale-orbit:plan6b-smoke-<suffix>`, project/manifest, and validated `127.0.0.1` ephemeral HTTP/HTTPS/UDP bindings—there is no fixed default tag and no `0.0.0.0:80/443` test bind. Update tests to prove stage/tag/project/port ownership, collision refusal, and exact-tag cleanup. The production phase starts only base Stripe-disabled maintenance mode through the per-run override. Retain the second isolated fixture-runtime web/worker probe with `APP_ENV=test`, `STRIPE_ENABLED=false`, and `STRIPE_TEST_FIXTURE_MODE=true`; it must exercise the final image's Sales-supporting financial worker path without accepting/printing real Stripe credentials or making an external Stripe request.

- [ ] **Step 3: Run clean dependency, generation, schema, and audit gates**

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

Expected: install/generated/schema/dependency checks are understood and recorded; no unexplained high/critical advisory. A nonzero `npm outdated --json` is evidence to review, not permission to skip subsequent commands.

- [ ] **Step 4: Run the full application gate serially**

Do not run database or Svelte wrappers concurrently:

```powershell
npm run check
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
npm run test:plan6b-upgrade
npx vitest run scripts/commerce-operations.test.ts scripts/commerce-privacy.test.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.test.ts
npm run smoke:plan6b
npm run smoke:plan6b-fixture
git diff --check
git status --short
```

Expected: every applicable command exits zero; record actual test/file counts, audit disposition, image digest/size, two-pass migration result, maintenance/Stripe-disabled assertions, and cleanup. Do not reuse checkpoint-I or Plan 6A counts.

- [ ] **Step 5: Record truthful candidate evidence and commit the reviewable release**

Update the operations/dependency docs with the actual Steps 3–4 results, including test/file counts, advisory dispositions, image digest/size, two-pass migration and fixture-runtime evidence, and cleanup. Keep the status at independent review pending. Commit all bounded Task 14 docs/script/package changes so reviewers inspect the exact candidate and not uncommitted evidence:

```powershell
git status --short
git add docs/financial-reconciliation-and-reporting.md README.md docs/stripe-financial-reconciliation.md docs/commerce-and-guest-claims.md docs/database-and-workers.md docs/runtime-environments.md docs/storage-ingestion-and-publication.md docs/dependency-decisions.md docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md scripts/plan6b-production-smoke.ts scripts/plan6b-production-smoke.test.ts scripts/plan6b-fixture-runtime-probe.ts scripts/plan6b-fixture-runtime-probe.test.ts package.json package-lock.json
git diff --cached --check
git diff --cached
git commit -m "docs: prepare financial reporting release review"
git status --short
```

Expected: candidate code, scripts, docs, and evidence are committed; worktree is clean; Plan 6B still says review pending.

- [ ] **Step 6: Request five independent read-only reviews of the committed candidate**

1. Requirements and full §13–20 acceptance traceability.
2. Security/privacy/authorization/CSV/secret review.
3. PostgreSQL lock order, finalization/correction/recovery concurrency, replay, and audit atomicity.
4. Financial math, currency/FX, incomplete-summary propagation, payout, and migration/data integrity.
5. Admin UX, accessibility/responsiveness, docs, Compose/image, and release-evidence truthfulness.

Each reviewer receives the checkpoint-I base commit and current candidate HEAD, inspects that committed `BASE..HEAD` range, and returns ordered Critical/Important/Minor findings with exact evidence or explicitly clears the diff. Reviewers do not edit files during this pass.

- [ ] **Step 7: Apply accepted review feedback under strict TDD**

Use the receiving-code-review workflow. Reproduce each accepted behavior finding RED; apply the smallest conforming change; rerun focused tests. For each bounded review-fix batch, inspect `git status --short`, stage only the literal file paths recorded in the review ledger (never `git add .`), run `git diff --cached --check`, inspect `git diff --cached`, and commit with `fix: harden financial reporting review findings` (or a more specific bounded message). After all fixes, rerun **all of Steps 3 and 4** because runtime, docs, migration, dependencies, and image evidence must describe the final tree.

- [ ] **Step 8: Mark Plan 6B complete and commit final evidence only after GREEN**

Refresh all counts, advisory dispositions, image digest/size, migration, smoke, and cleanup evidence from the post-fix run. Update the roadmap and design status to completed with links to both implementation-plan checkpoints and truthful final evidence. State that production remains intentionally closed and Plan 7 is next. Keep any accepted audit/dependency limitations dated and sourced. Then commit only those refreshed documentation/evidence paths:

```powershell
git add docs/financial-reconciliation-and-reporting.md README.md docs/stripe-financial-reconciliation.md docs/commerce-and-guest-claims.md docs/database-and-workers.md docs/runtime-environments.md docs/storage-ingestion-and-publication.md docs/dependency-decisions.md docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md docs/superpowers/specs/2026-08-11-stripe-financial-reconciliation-reporting-design.md
git diff --cached --check
git commit -m "docs: add financial reconciliation operations guide"
```

Expected: final evidence/status matches the post-fix tree and contains no Plan 7 launch/configuration leakage.

- [ ] **Step 9: Obtain final read-only clearance of the post-review tree**

Give all five reviewers the same checkpoint-I base and the new final HEAD. Ask them to reread the entire committed range, focusing on review-fix commits and refreshed release evidence. Every reviewer must explicitly clear the final tree or report a finding. If any accepted finding remains, return to Step 7, add a RED regression for behavior changes, rerun Steps 3–4, refresh/commit evidence in Step 8, and repeat this rereview. Do not modify code, scripts, docs, status, or evidence after the last clearance.

- [ ] **Step 10: Verify the release handoff is clean**

```powershell
git status --short
git log --oneline --decorate -16
git diff --check HEAD
```

Expected: clean worktree, no post-review delta, Plan 6B complete, production still closed, Plan 7 next, and all reviewers cleared the exact current HEAD.

## Checkpoint-II acceptance traceability

| Approved design requirement | Implemented and proved by |
| --- | --- |
| Paid-at UTC cohorts, strict filters/cursors, stable per-title/currency rows | Tasks 2–4, 11, 13 |
| Signed formulas, copy semantics, FX separation, and incomplete row/summary nulling | Tasks 3–4, 11, 13 |
| Sales Overview states and accessible responsive table/filter experience | Tasks 4, 12–13 |
| Needs Review safe queue/detail with no generic resolution | Tasks 5, 12–13 |
| Shared non-effective drafts and stale conflict behavior | Tasks 6, 12–13 |
| One-way finalization, causal provenance, access projection, email, and audit atomicity | Task 7, Tasks 12–13 |
| Append-only zero-sum reporting correction and compatible/incompatible rebase | Task 8, Tasks 12–13 |
| Exact causal administrative recovery, persistent override, explicit deactivation | Task 9, Tasks 12–13 |
| Safe payout list/detail and current/manual/failed semantics | Task 10, Tasks 12–13 |
| Full filtered bounded numeric-safe privacy-minimized CSV and export audit | Task 11, Tasks 12–13 |
| Route and service capability matrix, privacy DTOs, audit visibility/rollback | Tasks 2, 5–12 |
| Browser/a11y/mobile/zoom/privacy coverage and release/operations boundary | Tasks 4, 12–14 |

## Executor notes

- Do not begin this plan until Task 1 proves checkpoint I is merged and green.
- Complete tasks in order; finalization precedes correction, and correction precedes recovery eligibility.
- Use strict TDD for every behavior change: RED, minimal implementation, focused GREEN, regression gate.
- Keep routes thin, server services independently authorized, DTOs explicit, and Stripe/provider types out of route/component modules.
- Use a fresh implementation subagent and separate reviewer per task; preserve the shared worktree and do not let reviewers edit during final review.
- Quote Git pathspecs containing `[refundId]` when staging in PowerShell, for example `git add -- 'src/routes/admin/sales/refunds/[refundId]/+page.server.ts'`.
- Mark checkboxes only after inspecting the named evidence. Commit at each task boundary.
- Stop after Task 14. Do not enable production commerce or begin Plan 7 without a separately approved spec/plan.
