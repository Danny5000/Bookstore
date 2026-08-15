# Stripe financial reconciliation operations

Status: **6B-I complete; 6B-II pending**

This guide covers the minimized Stripe ledger, deterministic financial allocations, payout association, recovery scans, and restore checks delivered by checkpoint 6B-I. The administrator Sales navigation, report routes, refund-review mutations, reporting corrections, CSV export, and recovery-grant controls remain disabled until 6B-II. Production remains closed in `APPLICATION_MODE=maintenance`.

## Provider boundary and webhook configuration

The Stripe SDK and the Dashboard webhook endpoint are pinned to API version `2026-07-29.dahlia`. Keep the existing Plan 6A event allowlist and add exactly these six payout events:

- `payout.created`
- `payout.updated`
- `payout.paid`
- `payout.failed`
- `payout.canceled`
- `payout.reconciliation_completed`

Never subscribe the endpoint to `*`. `payout.reconciliation_completed`, not `payout.paid` by itself, is the signal that exact automatic-payout membership can be queried. Webhook acceptance verifies the signature and API version, persists a minimized event, and atomically enqueues the existing Stripe-event job. It does not retrieve a Payout or Balance Transaction in the request.

The worker uses four durable job families:

- `commerce.financial-source` reconciles one local payment, refund, or dispute from complete canonical provider state.
- `commerce.financial-payout` refreshes one payout and imports supported membership one page at a time.
- `commerce.financial-scan` discovers bounded recovery work, resumes checkpoints, and fans out payout-generation impacts.
- `commerce.financial-classification` appends a decision for one immutable local ledger subject. It never calls Stripe.

Every provider retrieve or list call runs outside an active database transaction. Short staging, import-run, and checkpoint transactions may occur between calls; provider facts are staged independently before purchase-linked projection enters the ordered local purchase graph. Reports read only PostgreSQL; they never make a live provider call.

### Source flow

1. A payment job retrieves the PaymentIntent, latest Charge, and Charge Balance Transaction; a refund job retrieves the complete Refund plus its principal and failure Balance Transactions; a dispute job retrieves the complete Dispute plus every observed withdrawal or reinstatement transaction.
2. The adapter rejects unexpected livemode, amount, currency, source linkage, timestamp, and money relationships and returns only canonical minimized snapshots.
3. Each Balance Transaction and fee-detail set is inserted once or checked byte-for-byte against immutable local evidence. Novel classifications remain durable as `unsupported_category` instead of being guessed.
4. A short ordered transaction re-reads local purchase facts, appends deterministic gross and fee allocation sets, recomputes issues, and advances payout-independent evidence to `fee_reconciled` only when complete.
5. Current `payout_reconciled` is derived at read time from authoritative membership and the payout's current canonical state. It is never stored on a payment, refund, or dispute.

Out-of-order and duplicate events converge because workers reduce complete canonical objects, not event deltas. An ambiguous succeeded multi-title refund remains `needs_review + pending` with `allocation_incomplete`; 6B-I never invents title attribution or enables its administrative finalization UI.

### Payout flow and exact association

A payout event or scan first retrieves and stages the canonical payout and any payout/failure Balance Transaction. Exact membership is published only when all of these conditions hold under the final lock:

- the payout is automatic;
- its method is `standard`;
- its reconciliation status is `completed`;
- its current canonical status is `paid`;
- payout-filtered pagination reached a complete final page; and
- every candidate passed parsing, immutable-collision, and one-payout-per-transaction checks.

Page entries in `payout_import_run_entries` are provisional and are not settlement authority. One atomic publication transaction locks the payout, run, sorted entries, sorted Balance Transactions, membership rows, and payout issues; inserts `stripe_payout_balance_transactions`; marks the run published; increments the payout generation; enqueues its generation-specific impact scan; and appends the minimized audit event. A crash before this transaction leaves no partial authoritative membership. A replay emits neither another generation nor another publication audit.

A later failed, canceled, or reversed payout preserves historical membership but immediately reopens current derived state because reads join the current payout. Its failure/reversal evidence is imported separately. Do not delete the original rows.

Manual payouts and instant payouts have no Stripe-determined exact transaction membership in this model. Once their source Balance Transactions and fees are complete they remain `fee_reconciled`, meaning **not payout reconciled**. Never assign their transactions to a payout manually or infer membership from timing or amount.

## Recurrence, freshness, and recovery

When Stripe runtime is enabled, every worker polling loop safely ensures one provider-recovery root for the current UTC hour. Its permanent key includes the hour, so multiple workers converge on one row while the next hour can recover work that an earlier terminal key cannot suppress. Each scan transaction handles at most 100 local resources or one provider page of at most 100 records, commits its phase/checkpoint, and enqueues a distinct continuation.

The initial payout discovery lower bound is seven days before the earliest local paid order, or seven days before the current scan hour when no paid order exists. It is not an unrestricted Stripe-account backfill and not merely "the last seven days." Each run freezes its provider time window before the first request. The singleton durable coverage high-water advances only with the terminal discovery page; subsequent hourly discovery starts with a 72-hour overlap from the older of that high-water and the scan hour, so delayed evidence and outages longer than 72 hours cannot create an unscanned gap. Local source scans also cover pending/retryable payments, refunds, and disputes plus incomplete payout import runs and open payout-reversal issues.

Each deployed classifier/allocation pair has a separate composite replay root such as `commerce.financial-classification:scan:1:1`. It processes local immutable evidence only. Unsupported classifications are not retried every hour; deploying a newer supported classifier or allocation-algorithm version creates a new version-keyed replay that appends decisions and successor allocation tips without editing history.

Job attempt ceilings are 12 for source jobs, 12 for payout jobs, 8 for scan jobs, and 5 for classification jobs. Retryable provider or state failures use bounded backoff. If attempts are exhausted, the failed job remains durable:

- the next UTC-hour root can rediscover a still-pending source using a new hour-specific key;
- incomplete payout runs are rediscovered and resumed from their committed page;
- a payout lifecycle or publication change uses a new payout-generation key; and
- an unsupported classification waits for a new deployed classifier/allocation version rather than looping hourly.

An active-entity guard prevents parallel event/hour/generation jobs from mutating the same source. Permanent evidence conflicts remain exceptions until changed canonical evidence or a specifically authorized 6B-II workflow proves the invariant. There is no manual sync, arbitrary retry, or SQL status-reset procedure in 6B-I; Plan 7 owns general failed-job controls.

"Financial data through" means the completion time of the last successful relevant local discovery scan. It does not mean live Stripe state, guarantee that every child job succeeded, or erase open/pending issues. Interpret it together with source state, incomplete import runs, open issues, and failed financial jobs. Safe aggregate inspection is:

```sql
select
  kind,
  max(completed_at) filter (where state = 'completed') as last_completed_at,
  count(*) filter (where state = 'running') as running_count,
  count(*) filter (where state = 'exception') as exception_count
from financial_scan_runs
group by kind
order by kind;
```

## Signed money and currency domains

All money is a JavaScript-safe integer in the currency's minor unit; code uses `BigInt` intermediates for allocation and stable largest-remainder rounding. No code assumes two decimal places.

For every Stripe Balance Transaction:

```text
net_minor = amount_minor - fee_minor
```

- `amount_minor` is the signed gross Stripe-balance movement.
- `fee_minor` is nonnegative provider fee evidence.
- `net_minor` is the signed net Stripe-balance movement.
- A gross allocation set targets `amount_minor`; a fee allocation set targets `-fee_minor` so fees reduce estimated revenue.
- Sales and fee credits are positive effects. Refund principal, dispute withdrawals, and charged fees are negative effects. Failed-refund reversals and dispute reinstatements are positive effects when the provider movement is positive.

Presentment and settlement are separate domains even when both currency codes happen to match:

- **Presentment** is what the customer paid and comes from immutable orders, order items, refund allocations, and dispute facts.
- **Settlement** is what moved through the Stripe balance and comes from Balance Transactions, fees, adjustments, and payouts.

Never add unlike currencies or treat one domain as a converted equivalent of the other. An exchange rate is retained only as bounded exact decimal evidence; actual provider settlement amounts are allocated without JavaScript floating-point conversion. Customer sales tax stays separate from title revenue. Account-level adjustments can affect payout/account totals but are never attributed to a title.

## Reconciliation issues and safe inspection

`financial_reconciliation_issues` contains internal resource IDs, bounded codes, `open | resolved` state, `pending | exception | informational` impact, timestamps, occurrence count, and a correlation ID. The complete 6B-I issue vocabulary is:

| Code | Meaning and operator disposition |
| --- | --- |
| `allocation_fork` | More than one allocation-chain tip is visible. Keep read-only and investigate replay/version history. |
| `allocation_incomplete` | Expected attribution is not finalized, commonly an ambiguous refund. Wait for the named 6B-II refund workflow. |
| `allocation_mismatch` | Signed totals, capacities, or persisted allocation shape do not conserve. Treat as an exception. |
| `classification_fork` | Multiple global allocation tips exist for a Balance Transaction, or an exact replay target contradicts immutable classification evidence on its selected allocation set. Treat as an exception. |
| `correction_rebase_required` | A preserved reporting correction is incompatible with an exact replacement allocation set. Wait for the named correction workflow. |
| `currency_mismatch` | Currency domains or linked rows disagree. Do not convert or rewrite values. |
| `generation_exhausted` | A payout reached the bounded generation ceiling. Keep closed and escalate as a software/data incident. |
| `immutable_mismatch` | Canonical evidence collides with an existing immutable fact. Compare minimized lineage; never overwrite it. |
| `missing_source` | Required local or canonical evidence is not yet present. Check worker/provider recovery and freshness. |
| `payout_incomplete` | A payout import has not obtained a complete publishable page set. Let checkpoint recovery resume it. |
| `payout_membership_conflict` | One Balance Transaction was claimed by competing supported payouts. Treat as an exception. |
| `payout_reversal_incomplete` | A failed/canceled payout lacks complete reversal evidence. Wait for canonical recovery. |
| `source_linkage_mismatch` | Canonical provider evidence cannot be proven to belong to the expected local source. Treat as an exception. |
| `unsupported_category` | One immutable classification-version row records evidence that its classifier could not safely classify. The row-specific diagnostic remains historical and open; use the active-only query below to decide whether it is a current blocker. |

Inspect only minimized operational fields:

```sql
select id, resource_type, resource_id, safe_code, state, impact,
  first_observed_at, last_observed_at, occurrence_count, correlation_id, resolved_at
from financial_reconciliation_issues
where state = 'open'
order by last_observed_at desc, id
limit 100;

with active as (
  select classifier_version, allocation_algorithm_version
  from financial_projection_versions
  where singleton = true
), active_classifications as (
  select classification.id
  from financial_classification_versions classification
  cross join active
  left join stripe_balance_transactions balance
    on classification.subject_type = 'balance_transaction'
   and balance.id = classification.subject_id
   and balance.fingerprint_sha256 = classification.source_fingerprint_sha256
  left join stripe_balance_transaction_fee_details detail
    on classification.subject_type = 'fee_detail'
   and detail.id = classification.subject_id
   and detail.fingerprint_sha256 = classification.source_fingerprint_sha256
  where classification.classifier_version = active.classifier_version
    and (balance.id is not null or detail.id is not null)
), active_allocation_tips as (
  select allocation.id
  from financial_allocation_sets allocation
  cross join active
  where allocation.classifier_version = active.classifier_version
    and allocation.algorithm_version = active.allocation_algorithm_version
    and not exists (
      select 1
      from financial_allocation_sets successor
      where successor.supersedes_set_id = allocation.id
        and successor.classifier_version = allocation.classifier_version
        and successor.algorithm_version = allocation.algorithm_version
    )
)
select issue.id, issue.resource_type, issue.resource_id, issue.safe_code,
  issue.state, issue.impact, issue.first_observed_at, issue.last_observed_at,
  issue.occurrence_count, issue.correlation_id, issue.resolved_at
from financial_reconciliation_issues issue
where issue.state = 'open'
  and (
    issue.resource_type not in ('financial_classification', 'allocation_set')
    or (issue.resource_type = 'financial_classification' and exists (
      select 1 from active_classifications active where active.id = issue.resource_id
    ))
    or (issue.resource_type = 'allocation_set' and exists (
      select 1 from active_allocation_tips active where active.id = issue.resource_id
    ))
  )
order by issue.last_observed_at desc, issue.id
limit 100;

select id, type, status, attempts, max_attempts, run_at, completed_at, updated_at
from jobs
where type in (
  'commerce.financial-source',
  'commerce.financial-payout',
  'commerce.financial-scan',
  'commerce.financial-classification'
)
order by updated_at desc, id
limit 100;
```

The first query is a historical inventory: a retired classifier's immutable `unsupported_category` fact remains open and is not a current blocker merely because a newer classifier is active. The second query is the current operational queue. It retains non-versioned issue resources, but includes a classification-row issue only when that row belongs to the active classifier and the subject's current raw fingerprint, and includes an allocation-set issue only when that exact set is a raw tip under the active classifier/allocation pair. It deliberately derives raw tips rather than trusting `current_financial_projection_heads.base_set_id`, because an issue on the selected set makes that view hide the ID. The orphan check below proves every historical unknown row owns its exact permanent issue; the active decision diagnostic independently proves current unknown-to-issue cardinality.

Do not select job payloads, provider IDs for support output, raw events, provider messages, descriptions, metadata, customer identity, emails, card/billing/address data, receipt URLs, action URLs, secrets, or request/response bodies. Do not enable Stripe SDK HTTP logging.

There is no generic Resolve action. An issue resolves only in the same transaction where canonical recomputation proves its exact invariant after new provider evidence, a reviewed classifier replay, refund finalization, or a validated reporting correction. An `unsupported_category` issue on a `financial_classification` resource is different: it is the immutable truth about that exact historical row and never resolves; a later classifier writes a different row and only the active row participates in current triage. Acknowledgment alone cannot advance state. Direct database edits, deleting history, editing issue state, blessing a classifier row, assigning payout membership, or resetting a failed job are unsupported repair paths.

## Coordinated backup and restore

Use the full logical database backup and private-storage procedure in [storage, ingestion, publication, and recovery](storage-ingestion-and-publication.md). Stop app and worker in a maintenance window, create both the backup and verification plaintext workspaces through the documented collision-safe Windows or GNU/Linux helper, use PostgreSQL `pg_dump --format=custom`, retain the migration journal and application-image digest, and reject every missing or empty required file before hashing it. Every material native command must pass the reusable fail-closed exit assertion. Encrypt and authenticate the complete backup set, retrieve the exact destination ciphertext, prove its SHA-256 equals the source ciphertext hash, test-decrypt that destination copy into the fresh restricted workspace, and restore only from that verified plaintext. Then securely delete its dumps, archives, manifests, and verification plaintext or put every plaintext artifact under documented access-controlled retention. Never copy a live PostgreSQL data directory.

A Plan 6B-only table dump is not a valid bookstore backup. The checkpoint also adds state to `payments`, `refunds`, `disputes`, and `entitlement_grants`, and its rows depend on users, orders/items, refund allocations, jobs, and audit history. The full custom archive must retain schemas, enums, functions, views, restrictive foreign keys, immutable triggers, `drizzle.__drizzle_migrations`, and all application tables.

The archive contains these 20 Plan 6B tables. This is their parent-first logical data order after pre-existing users, commerce/order, refund-allocation, entitlement-grant, job, and audit tables. `pg_restore` manages archive object order and installs constraints appropriately; do not reproduce this list with ad hoc `INSERT`, disable triggers, or restore child tables separately.

| Order | Plan 6B table | Dependency |
| ---: | --- | --- |
| 1 | `financial_projection_versions` | Singleton active classifier/allocation version. |
| 2 | `financial_payout_discovery_state` | Singleton provider-discovery coverage high-water. |
| 3 | `stripe_balance_transactions` | Parent ledger facts. |
| 4 | `stripe_balance_transaction_fee_details` | Balance Transaction. |
| 5 | `financial_classification_versions` | Semantic subject is a Balance Transaction or fee detail. |
| 6 | `stripe_payouts` | Optional payout/failure Balance Transactions. |
| 7 | `payout_import_runs` | Payout. |
| 8 | `payout_import_run_entries` | Import run and Balance Transaction. |
| 9 | `stripe_payout_balance_transactions` | Payout, published import run, and Balance Transaction. |
| 10 | `financial_scan_runs` | Independent durable checkpoints. |
| 11 | `financial_allocation_sets` | Balance Transaction plus self-referenced predecessor/reversal chains. |
| 12 | `financial_item_allocations` | Allocation set and existing order item. |
| 13 | `refund_allocation_components` | Existing refund allocation/refund/order-item graph. |
| 14 | `dispute_item_allocations` | Existing dispute/order item, allocation set, and optional earlier dispute allocation. |
| 15 | `refund_allocation_drafts` | Existing refund and administrator users. |
| 16 | `refund_allocation_draft_items` | Draft and existing order item. |
| 17 | `refund_reporting_correction_sets` | Existing refund, allocation set, administrators, and optional predecessor correction. |
| 18 | `refund_reporting_correction_items` | Correction set, optional source allocation set, and order item. |
| 19 | `financial_reconciliation_issues` | Optional existing administrator plus a semantic internal resource restored above. |
| 20 | `refund_allocation_finalization_effects` | Existing refund allocation, draft/version/item, order item, and purchase grant. |

Restore first into a collision-resistant isolated Compose project only after a fail-closed preflight proves that no container, network, database volume, or storage volume matches its generated identity; expose no public application ports. Restore the full database and storage archive from the verified test-decryption of the exact destination ciphertext, run committed migrations, compare the complete required-file manifest, migration journal, and aggregate row counts, and execute every read-only check below while app and worker remain stopped. A structural count other than zero blocks acceptance. Missing/pending classification rows and incomplete projection rows are operational evidence rather than permission to edit; reconcile them with durable jobs/issues as described with each query. Check worker absence around each service start. Start only the isolated maintenance-mode app after the checks pass. Maintenance mode admits only `/health/live` and `/health/ready`; do not claim UI authentication, administrator pages, or reader rendering as rehearsal evidence. Keep the general worker stopped for the entire isolated restore rehearsal. Inventory the generated project immediately before teardown, fail closed on `down --volumes`, prove all generated resources absent afterward, and apply the plaintext disposition policy to every verified or tool-created plaintext artifact before following a separately approved production replacement/rollback procedure.

### Post-restore orphan check

This query checks both declared relationships and the bounded polymorphic subject/resource links. Because a cross-table constraint cannot require a companion issue row, `financial_unknown_classification_issue` also proves that every immutable `unknown` classification row has its exact open exception-impact `unsupported_category` issue, including rows from retired classifiers. It returns only failed check names and counts; an empty result is required.

```sql
with orphan_counts as (
  select 'fee_detail_balance_transaction' as check_name, count(*)::bigint as violation_count
  from stripe_balance_transaction_fee_details d
  left join stripe_balance_transactions bt on bt.id = d.balance_transaction_id
  where bt.id is null

  union all
  select 'classification_subject', count(*)::bigint
  from financial_classification_versions c
  left join stripe_balance_transactions bt
    on c.subject_type = 'balance_transaction' and bt.id = c.subject_id
  left join stripe_balance_transaction_fee_details fd
    on c.subject_type = 'fee_detail' and fd.id = c.subject_id
  where (c.subject_type = 'balance_transaction' and bt.id is null)
     or (c.subject_type = 'fee_detail' and fd.id is null)

  union all
  select 'payout_linked_balance_transaction', count(*)::bigint
  from stripe_payouts p
  left join stripe_balance_transactions bt on bt.id = p.balance_transaction_id
  left join stripe_balance_transactions failure_bt on failure_bt.id = p.failure_balance_transaction_id
  where (p.balance_transaction_id is not null and bt.id is null)
     or (p.failure_balance_transaction_id is not null and failure_bt.id is null)

  union all
  select 'payout_import_run_payout', count(*)::bigint
  from payout_import_runs r
  left join stripe_payouts p on p.id = r.payout_id
  where p.id is null

  union all
  select 'payout_import_entry_parent', count(*)::bigint
  from payout_import_run_entries e
  left join payout_import_runs r on r.id = e.run_id
  left join stripe_balance_transactions bt on bt.id = e.balance_transaction_id
  where r.id is null or bt.id is null

  union all
  select 'published_payout_membership_parent', count(*)::bigint
  from stripe_payout_balance_transactions m
  left join stripe_payouts p on p.id = m.payout_id
  left join stripe_balance_transactions bt on bt.id = m.balance_transaction_id
  left join payout_import_runs r
    on r.id = m.published_from_run_id and r.payout_id = m.payout_id
  where p.id is null or bt.id is null or r.id is null

  union all
  select 'allocation_set_parent_or_chain', count(*)::bigint
  from financial_allocation_sets s
  left join stripe_balance_transactions bt on bt.id = s.balance_transaction_id
  left join financial_allocation_sets predecessor on predecessor.id = s.supersedes_set_id
  left join financial_allocation_sets reversal on reversal.id = s.reversal_of_set_id
  left join financial_classification_versions parent_classification
    on parent_classification.subject_type = 'balance_transaction'
    and parent_classification.subject_id = s.balance_transaction_id
    and parent_classification.classifier_version = s.classifier_version
    and parent_classification.source_fingerprint_sha256 = s.source_fingerprint_sha256
  where bt.id is null
     or (s.supersedes_set_id is not null and predecessor.id is null)
     or (s.reversal_of_set_id is not null and reversal.id is null)
     or (s.reversal_of_set_id is not null and (
       reversal.source_kind <> s.source_kind
       or reversal.source_internal_id <> s.source_internal_id
       or reversal.basis <> s.basis
       or reversal.currency <> s.currency
       or reversal.reversal_of_set_id is not null
       or reversal.classifier_version <> s.classifier_version
       or reversal.algorithm_version <> s.algorithm_version
     ))
     or (s.supersedes_set_id is not null and (
       predecessor.balance_transaction_id <> s.balance_transaction_id
       or predecessor.basis <> s.basis
       or predecessor.currency <> s.currency
       or predecessor.expected_effect_minor <> s.expected_effect_minor
       or predecessor.source_fingerprint_sha256 <> s.source_fingerprint_sha256
       or predecessor.classifier_version > s.classifier_version
       or predecessor.algorithm_version > s.algorithm_version
       or not coalesce((
         (
           predecessor.source_kind = s.source_kind
           and predecessor.source_internal_id = s.source_internal_id
           and (
             predecessor.reversal_of_set_id is not distinct from s.reversal_of_set_id
             or (
               predecessor.reversal_of_set_id is not null
               and s.reversal_of_set_id is not null
               and reversal.supersedes_set_id = predecessor.reversal_of_set_id
             )
           )
         )
         or (
           predecessor.source_kind = 'adjustment'
           and predecessor.source_internal_id = s.balance_transaction_id
           and predecessor.scope = 'account'
           and predecessor.reversal_of_set_id is null
           and s.source_kind in ('payment', 'refund', 'dispute')
           and parent_classification.id is not null
           and (
             (s.reversal_of_set_id is null and (
               (s.source_kind = 'payment'
                 and parent_classification.classification = 'charge'
                 and bt.amount_minor > 0)
               or (s.source_kind = 'refund' and (
                 (parent_classification.classification = 'refund' and bt.amount_minor < 0)
                 or (parent_classification.classification = 'refund_failure'
                   and bt.amount_minor > 0)
               ))
               or (s.source_kind = 'dispute' and (
                 (parent_classification.classification = 'dispute_withdrawal'
                   and bt.amount_minor < 0)
                 or (parent_classification.classification in (
                   'dispute_reinstatement', 'fee_credit'
                 ) and bt.amount_minor > 0)
               ))
             ))
             or (s.reversal_of_set_id is not null
               and s.basis = 'gross_amount'
               and s.expected_effect_minor > 0
               and bt.amount_minor > 0
               and (
                 (s.source_kind = 'refund'
                   and parent_classification.classification = 'refund_failure')
                 or (s.source_kind = 'dispute'
                   and parent_classification.classification = 'dispute_reinstatement')
               ))
           )
         )
       ), false)
     ))

  union all
  select 'allocation_set_semantic_source', count(*)::bigint
  from financial_allocation_sets s
  left join payments p on s.source_kind = 'payment' and p.id = s.source_internal_id
  left join refunds r on s.source_kind = 'refund' and r.id = s.source_internal_id
  left join disputes d on s.source_kind = 'dispute' and d.id = s.source_internal_id
  left join stripe_payouts po on s.source_kind = 'payout' and po.id = s.source_internal_id
  left join stripe_balance_transactions bt
    on s.source_kind = 'adjustment' and bt.id = s.source_internal_id
  where (s.source_kind = 'payment' and p.id is null)
     or (s.source_kind = 'refund' and r.id is null)
     or (s.source_kind = 'dispute' and d.id is null)
     or (s.source_kind = 'payout' and po.id is null)
     or (s.source_kind = 'adjustment' and bt.id is null)

  union all
  select 'financial_item_allocation_parent', count(*)::bigint
  from financial_item_allocations i
  left join financial_allocation_sets s on s.id = i.allocation_set_id
  left join order_items oi on oi.id = i.order_item_id
  where s.id is null or oi.id is null

  union all
  select 'financial_issue_vocabulary', count(*)::bigint
  from financial_reconciliation_issues i
  where i.resource_type not in (
    'payment', 'refund', 'dispute', 'payout', 'payout_import_run',
    'balance_transaction', 'fee_detail', 'allocation_set', 'correction_set',
    'financial_classification', 'financial_scan_run'
  ) or i.safe_code not in (
    'allocation_fork', 'allocation_incomplete', 'allocation_mismatch',
    'classification_fork', 'correction_rebase_required', 'currency_mismatch',
    'generation_exhausted', 'immutable_mismatch', 'missing_source',
    'payout_incomplete', 'payout_membership_conflict', 'payout_reversal_incomplete',
    'source_linkage_mismatch', 'unsupported_category'
  )

  union all
  select 'financial_issue_semantic_resource', count(*)::bigint
  from financial_reconciliation_issues i
  left join payments p on i.resource_type = 'payment' and p.id = i.resource_id
  left join refunds r on i.resource_type = 'refund' and r.id = i.resource_id
  left join disputes d on i.resource_type = 'dispute' and d.id = i.resource_id
  left join stripe_payouts po on i.resource_type = 'payout' and po.id = i.resource_id
  left join payout_import_runs pr
    on i.resource_type = 'payout_import_run' and pr.id = i.resource_id
  left join stripe_balance_transactions bt
    on i.resource_type = 'balance_transaction' and bt.id = i.resource_id
  left join stripe_balance_transaction_fee_details fd
    on i.resource_type = 'fee_detail' and fd.id = i.resource_id
  left join financial_allocation_sets fas
    on i.resource_type = 'allocation_set' and fas.id = i.resource_id
  left join refund_reporting_correction_sets cs
    on i.resource_type = 'correction_set' and cs.id = i.resource_id
  left join financial_classification_versions fc
    on i.resource_type = 'financial_classification' and fc.id = i.resource_id
  left join financial_scan_runs sr
    on i.resource_type = 'financial_scan_run' and sr.id = i.resource_id
  left join "user" resolver on resolver.id = i.resolved_by_admin_id
  where (i.resource_type = 'payment' and p.id is null)
     or (i.resource_type = 'refund' and r.id is null)
     or (i.resource_type = 'dispute' and d.id is null)
     or (i.resource_type = 'payout' and po.id is null)
     or (i.resource_type = 'payout_import_run' and pr.id is null)
     or (i.resource_type = 'balance_transaction' and bt.id is null)
     or (i.resource_type = 'fee_detail' and fd.id is null)
     or (i.resource_type = 'allocation_set' and fas.id is null)
     or (i.resource_type = 'correction_set' and cs.id is null)
     or (i.resource_type = 'financial_classification' and (
       fc.id is null
       or i.safe_code <> 'unsupported_category'
       or fc.classification <> 'unknown'
       or i.impact <> 'exception'
       or i.state <> 'open'
     ))
     or (i.resource_type in ('balance_transaction', 'fee_detail')
       and i.safe_code = 'unsupported_category')
     or (i.resource_type = 'financial_scan_run' and sr.id is null)
     or (i.resolved_by_admin_id is not null and resolver.id is null)

  union all
  select 'financial_unknown_classification_issue', count(*)::bigint
  from financial_classification_versions classification
  left join financial_reconciliation_issues issue
    on issue.resource_type = 'financial_classification'
   and issue.resource_id = classification.id
   and issue.safe_code = 'unsupported_category'
   and issue.state = 'open'
   and issue.impact = 'exception'
  where classification.classification = 'unknown'
    and issue.id is null

  union all
  select 'refund_allocation_component_graph', count(*)::bigint
  from refund_allocation_components c
  left join refund_allocations ra
    on ra.id = c.refund_allocation_id
   and ra.refund_id = c.refund_id
   and ra.order_item_id = c.order_item_id
  where ra.id is null

  union all
  select 'dispute_item_allocation_graph', count(*)::bigint
  from dispute_item_allocations a
  left join disputes d on d.id = a.dispute_id
  left join financial_allocation_sets s
    on s.id = a.gross_allocation_set_id and s.source_internal_id = a.dispute_id
  left join order_items oi on oi.id = a.order_item_id
  left join dispute_item_allocations reversal on reversal.id = a.reverses_allocation_id
  where d.id is null or s.id is null or oi.id is null
     or (a.reverses_allocation_id is not null and reversal.id is null)

  union all
  select 'refund_allocation_draft_graph', count(*)::bigint
  from refund_allocation_drafts d
  left join refunds r on r.id = d.refund_id
  left join "user" creator on creator.id = d.created_by_admin_id
  left join "user" updater on updater.id = d.updated_by_admin_id
  where r.id is null or creator.id is null or updater.id is null

  union all
  select 'refund_allocation_draft_item_graph', count(*)::bigint
  from refund_allocation_draft_items i
  left join refund_allocation_drafts d on d.id = i.draft_id
  left join order_items oi on oi.id = i.order_item_id
  where d.id is null or oi.id is null

  union all
  select 'refund_reporting_correction_set_graph', count(*)::bigint
  from refund_reporting_correction_sets c
  left join refunds r on r.id = c.refund_id
  left join financial_allocation_sets base on base.id = c.base_allocation_set_id
  left join refund_reporting_correction_sets predecessor
    on predecessor.id = c.predecessor_correction_set_id
   and predecessor.refund_id = c.refund_id
  left join "user" approver on approver.id = c.approved_by_admin_id
  left join "user" creator on creator.id = c.created_by_admin_id
  where r.id is null or base.id is null or approver.id is null
     or (c.predecessor_correction_set_id is not null and predecessor.id is null)
     or (c.created_by_admin_id is not null and creator.id is null)

  union all
  select 'refund_reporting_correction_item_graph', count(*)::bigint
  from refund_reporting_correction_items i
  left join refund_reporting_correction_sets c on c.id = i.correction_set_id
  left join financial_allocation_sets s on s.id = i.source_allocation_set_id
  left join order_items oi on oi.id = i.order_item_id
  where c.id is null or oi.id is null
     or (i.source_allocation_set_id is not null and s.id is null)

  union all
  select 'refund_finalization_effect_graph', count(*)::bigint
  from refund_allocation_finalization_effects e
  left join refund_allocations ra
    on ra.id = e.refund_allocation_id
   and ra.refund_id = e.refund_id
   and ra.order_item_id = e.order_item_id
  left join refund_allocation_drafts d
    on d.id = e.draft_id
   and d.refund_id = e.refund_id
   and d.version = e.draft_version
  left join refund_allocation_draft_items di
    on di.draft_id = e.draft_id and di.order_item_id = e.order_item_id
  left join entitlement_grants g
    on g.id = e.purchase_grant_id and g.order_item_id = e.order_item_id
  where ra.id is null or d.id is null or di.id is null or g.id is null
)
select check_name, violation_count
from orphan_counts
where violation_count <> 0
order by check_name;
```

### Post-restore signed-conservation check

Every result must be zero. These are cross-row service invariants in addition to database checks. The combined refund/dispute chronology check replays each payment item and presentment currency from its immutable subtotal/tax capacity, using only active version-local dispute tips; any malformed reversal, duplicate total ordering key, or prefix outside either original bucket blocks restore acceptance.

```sql
with fee_sums as (
  select bt.id, bt.fee_minor, coalesce(sum(fd.amount_minor), 0)::bigint as detail_minor,
    count(fd.id) filter (where fd.currency <> bt.currency)::bigint as currency_mismatch_count
  from stripe_balance_transactions bt
  left join stripe_balance_transaction_fee_details fd
    on fd.balance_transaction_id = bt.id
  group by bt.id, bt.fee_minor
), allocation_sums as (
  select s.id, s.scope, s.expected_effect_minor, s.currency,
    count(i.id)::bigint as item_count,
    coalesce(sum(i.effect_minor), 0)::bigint as item_minor,
    count(i.id) filter (where i.currency <> s.currency)::bigint as currency_mismatch_count
  from financial_allocation_sets s
  left join financial_item_allocations i on i.allocation_set_id = s.id
  group by s.id, s.scope, s.expected_effect_minor, s.currency
), correction_sums as (
  select correction_set_id, domain, source_allocation_set_id, currency,
    sum(delta_minor)::bigint as delta_minor
  from refund_reporting_correction_items
  group by correction_set_id, domain, source_allocation_set_id, currency
), refund_component_sequence as (
  select c.id as component_id, ra.id as allocation_id,
    ra.amount_minor::bigint as allocation_minor,
    r.id as refund_id, r.status as refund_status,
    r.allocation_status as refund_allocation_status, r.currency as refund_currency,
    r.provider_created_at, r.stripe_refund_id, p.order_id as payment_order_id,
    oi.id as order_item_id, oi.order_id as item_order_id,
    oi.unit_subtotal_minor::bigint as item_subtotal_minor,
    oi.tax_minor::bigint as item_tax_minor, oi.total_minor::bigint as item_total_minor,
    oi.currency as item_currency, c.subtotal_minor::bigint as stored_subtotal_minor,
    c.tax_minor::bigint as stored_tax_minor, c.total_minor::bigint as stored_total_minor,
    c.currency as component_currency,
    coalesce(sum(c.subtotal_minor::bigint) over (
      partition by ra.order_item_id
      order by r.provider_created_at, r.stripe_refund_id collate "C", r.id, ra.id
      rows between unbounded preceding and 1 preceding
    ), 0::bigint) as prior_subtotal_minor,
    coalesce(sum(c.tax_minor::bigint) over (
      partition by ra.order_item_id
      order by r.provider_created_at, r.stripe_refund_id collate "C", r.id, ra.id
      rows between unbounded preceding and 1 preceding
    ), 0::bigint) as prior_tax_minor
  from refund_allocation_components c
  join refund_allocations ra on ra.id = c.refund_allocation_id
  join refunds r on r.id = ra.refund_id
  join payments p on p.id = r.payment_id
  join order_items oi on oi.id = ra.order_item_id
), refund_component_capacity as (
  select *, item_subtotal_minor - prior_subtotal_minor as remaining_subtotal_minor,
    item_tax_minor - prior_tax_minor as remaining_tax_minor
  from refund_component_sequence
), refund_component_ratios as (
  select *, remaining_subtotal_minor + remaining_tax_minor as remaining_total_minor,
    (allocation_minor >= 0 and remaining_subtotal_minor >= 0 and remaining_tax_minor >= 0
      and allocation_minor <= remaining_subtotal_minor + remaining_tax_minor
      and (allocation_minor = 0 or remaining_subtotal_minor + remaining_tax_minor > 0)
    ) as capacity_valid
  from refund_component_capacity
), refund_component_bases as (
  select *,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then div(
        allocation_minor * remaining_subtotal_minor, remaining_total_minor
      )::bigint
    end as base_subtotal_minor,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then div(
        allocation_minor * remaining_tax_minor, remaining_total_minor
      )::bigint
    end as base_tax_minor,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then mod(
        allocation_minor * remaining_subtotal_minor, remaining_total_minor
      )
    end as subtotal_remainder,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then mod(
        allocation_minor * remaining_tax_minor, remaining_total_minor
      )
    end as tax_remainder
  from refund_component_ratios
), refund_component_expected as (
  select *, allocation_minor - base_subtotal_minor - base_tax_minor as leftover_minor,
    base_subtotal_minor + case
      when allocation_minor - base_subtotal_minor - base_tax_minor = 1 and (
        subtotal_remainder > tax_remainder or (
          subtotal_remainder = tax_remainder and
          (order_item_id::text || ':subtotal') collate "C" <
            (order_item_id::text || ':tax') collate "C"
        )
      ) then 1 else 0 end as expected_subtotal_minor,
    base_tax_minor + case
      when allocation_minor - base_subtotal_minor - base_tax_minor = 1 and not (
        subtotal_remainder > tax_remainder or (
          subtotal_remainder = tax_remainder and
          (order_item_id::text || ':subtotal') collate "C" <
            (order_item_id::text || ':tax') collate "C"
        )
      ) then 1 else 0 end as expected_tax_minor
  from refund_component_bases
  where capacity_valid
), combined_active_projection as (
  select classifier_version, allocation_algorithm_version
  from financial_projection_versions
  where singleton = true
), combined_capacity_seeds as (
  select p.id as payment_id, oi.id as order_item_id, oi.currency as presentment_currency,
    oi.unit_subtotal_minor::bigint as original_subtotal_minor,
    oi.tax_minor::bigint as original_tax_minor
  from payments p
  join order_items oi on oi.order_id = p.order_id
), combined_refund_events as (
  select r.payment_id, c.order_item_id, c.currency as presentment_currency,
    r.provider_created_at, r.stripe_refund_id as provider_id,
    r.id as source_internal_id, ra.id as local_event_id,
    -c.subtotal_minor::bigint as subtotal_delta_minor,
    -c.tax_minor::bigint as tax_delta_minor
  from refund_allocation_components c
  join refund_allocations ra
    on ra.id = c.refund_allocation_id
   and ra.refund_id = c.refund_id
   and ra.order_item_id = c.order_item_id
  join refunds r on r.id = c.refund_id
  where r.status = 'succeeded'
    and r.allocation_status in ('finalized', 'exception')
), combined_current_dispute_events as (
  select d.payment_id, a.order_item_id, a.currency as presentment_currency,
    bt.provider_created_at, bt.provider_id, d.id as source_internal_id,
    a.id as local_event_id, a.effect, a.reverses_allocation_id,
    a.subtotal_effect_minor::bigint as subtotal_delta_minor,
    a.tax_effect_minor::bigint as tax_delta_minor,
    a.total_effect_minor::bigint as total_delta_minor,
    s.id as allocation_set_id, s.reversal_of_set_id, s.scope,
    d.currency as dispute_currency, p.currency as payment_currency,
    p.order_id as payment_order_id, oi.order_id as item_order_id,
    oi.currency as item_currency,
    oi.unit_subtotal_minor::bigint as item_subtotal_minor,
    oi.tax_minor::bigint as item_tax_minor, oi.total_minor::bigint as item_total_minor
  from combined_active_projection active
  join financial_allocation_sets s
    on s.classifier_version = active.classifier_version
   and s.algorithm_version = active.allocation_algorithm_version
   and s.source_kind = 'dispute'
   and s.basis = 'gross_amount'
  join stripe_balance_transactions bt on bt.id = s.balance_transaction_id
  join disputes d on d.id = s.source_internal_id
  join dispute_item_allocations a
    on a.gross_allocation_set_id = s.id
   and a.dispute_id = d.id
  left join payments p on p.id = d.payment_id
  left join order_items oi on oi.id = a.order_item_id
  where not exists (
    select 1
    from financial_allocation_sets successor
    where successor.supersedes_set_id = s.id
      and successor.classifier_version = s.classifier_version
      and successor.algorithm_version = s.algorithm_version
  )
), combined_dispute_events as (
  select *, count(*) filter (where effect = 'reinstatement') over (
    partition by reverses_allocation_id
  )::bigint as current_reversal_count
  from combined_current_dispute_events
), combined_events as (
  select payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id,
    subtotal_delta_minor, tax_delta_minor
  from combined_refund_events
  union all
  select payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id,
    subtotal_delta_minor, tax_delta_minor
  from combined_dispute_events
), combined_duplicate_chronology as (
  select payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id
  from combined_events
  group by payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id
  having count(*) > 1
), combined_ordered_events as (
  select event.*, seed.original_subtotal_minor, seed.original_tax_minor,
    seed.original_subtotal_minor + sum(event.subtotal_delta_minor) over (
      partition by event.payment_id, event.order_item_id, event.presentment_currency
      order by event.provider_created_at, event.provider_id collate "C",
        event.source_internal_id, event.local_event_id
      rows between unbounded preceding and current row
    ) as remaining_subtotal_minor,
    seed.original_tax_minor + sum(event.tax_delta_minor) over (
      partition by event.payment_id, event.order_item_id, event.presentment_currency
      order by event.provider_created_at, event.provider_id collate "C",
        event.source_internal_id, event.local_event_id
      rows between unbounded preceding and current row
    ) as remaining_tax_minor
  from combined_events event
  join combined_capacity_seeds seed
    on seed.payment_id = event.payment_id
   and seed.order_item_id = event.order_item_id
   and seed.presentment_currency = event.presentment_currency
), combined_refund_dispute_violations as (
  select 1 as violation
  from combined_dispute_events event
  where event.scope <> 'title'
     or event.payment_order_id is distinct from event.item_order_id
     or event.presentment_currency is distinct from event.item_currency
     or event.presentment_currency is distinct from event.dispute_currency
     or event.presentment_currency is distinct from event.payment_currency
     or event.item_tax_minor is null or event.item_total_minor is null
     or event.item_total_minor <> event.item_subtotal_minor + event.item_tax_minor
     or event.total_delta_minor <> event.subtotal_delta_minor + event.tax_delta_minor
     or (event.effect = 'withdrawal' and (
       event.reverses_allocation_id is not null
       or event.reversal_of_set_id is not null
       or event.subtotal_delta_minor > 0 or event.tax_delta_minor > 0
       or event.total_delta_minor >= 0
     ))
     or (event.effect = 'reinstatement' and (
       event.reverses_allocation_id is null
       or event.reversal_of_set_id is null
       or event.subtotal_delta_minor < 0 or event.tax_delta_minor < 0
       or event.total_delta_minor <= 0
     ))

  union all
  select 1
  from combined_dispute_events reinstatement
  left join combined_dispute_events withdrawal
    on withdrawal.local_event_id = reinstatement.reverses_allocation_id
  where reinstatement.effect = 'reinstatement'
    and (
      withdrawal.local_event_id is null
      or withdrawal.effect <> 'withdrawal'
      or withdrawal.reverses_allocation_id is not null
      or withdrawal.reversal_of_set_id is not null
      or reinstatement.source_internal_id <> withdrawal.source_internal_id
      or reinstatement.reversal_of_set_id <> withdrawal.allocation_set_id
      or reinstatement.order_item_id <> withdrawal.order_item_id
      or reinstatement.presentment_currency <> withdrawal.presentment_currency
      or reinstatement.subtotal_delta_minor > -withdrawal.subtotal_delta_minor
      or reinstatement.tax_delta_minor > -withdrawal.tax_delta_minor
      or reinstatement.current_reversal_count <> 1
      or row(
        withdrawal.provider_created_at,
        withdrawal.provider_id collate "C",
        withdrawal.source_internal_id,
        withdrawal.local_event_id
      ) >= row(
        reinstatement.provider_created_at,
        reinstatement.provider_id collate "C",
        reinstatement.source_internal_id,
        reinstatement.local_event_id
      )
    )

  union all
  select 1
  from combined_duplicate_chronology

  union all
  select 1
  from combined_ordered_events
  where remaining_subtotal_minor not between 0 and original_subtotal_minor
     or remaining_tax_minor not between 0 and original_tax_minor
), conservation_counts as (
  select 'balance_transaction_net_equation' as check_name, count(*)::bigint as violation_count
  from stripe_balance_transactions
  where net_minor <> amount_minor - fee_minor

  union all
  select 'fee_detail_sum', count(*)::bigint
  from fee_sums
  where detail_minor <> fee_minor or currency_mismatch_count <> 0

  union all
  select 'allocation_set_provider_target', count(*)::bigint
  from financial_allocation_sets s
  join stripe_balance_transactions bt on bt.id = s.balance_transaction_id
  where s.currency <> bt.currency
     or s.expected_effect_minor <>
       case s.basis when 'gross_amount' then bt.amount_minor else -bt.fee_minor end

  union all
  select 'allocation_item_conservation', count(*)::bigint
  from allocation_sums
  where currency_mismatch_count <> 0
     or (scope = 'title' and item_minor <> expected_effect_minor)
     or (scope = 'title' and expected_effect_minor <> 0 and item_count = 0)
     or (scope in ('account', 'unresolved') and item_count <> 0)

  union all
  select 'refund_component_equation', count(*)::bigint
  from refund_allocation_components c
  join refund_allocations ra on ra.id = c.refund_allocation_id
  join refunds r on r.id = c.refund_id
  where c.total_minor <> c.subtotal_minor + c.tax_minor
     or c.total_minor <> ra.amount_minor
     or c.currency <> r.currency

  union all
  select 'refund_component_chronology_capacity', count(*)::bigint
  from refund_component_ratios
  where refund_status <> 'succeeded'
     or refund_allocation_status not in ('finalized', 'exception')
     or item_tax_minor is null or item_total_minor is null
     or item_total_minor <> item_subtotal_minor + item_tax_minor
     or payment_order_id <> item_order_id
     or refund_currency <> item_currency
     or refund_currency <> component_currency
     or stored_subtotal_minor > remaining_subtotal_minor
     or stored_tax_minor > remaining_tax_minor
     or capacity_valid is distinct from true

  union all
  select 'refund_component_deterministic_split', count(*)::bigint
  from refund_component_expected
  where leftover_minor not between 0 and 1
     or stored_subtotal_minor is distinct from expected_subtotal_minor
     or stored_tax_minor is distinct from expected_tax_minor

  union all
  select 'combined_refund_dispute_chronology_capacity', count(*)::bigint
  from combined_refund_dispute_violations

  union all
  select 'finalized_refund_allocation_shape', count(*)::bigint
  from refunds r
  left join lateral (
    select count(ra.id)::bigint as allocation_count,
      count(c.id)::bigint as component_count,
      coalesce(sum(ra.amount_minor), 0)::bigint as allocation_minor,
      coalesce(sum(c.total_minor), 0)::bigint as component_minor
    from refund_allocations ra
    left join refund_allocation_components c on c.refund_allocation_id = ra.id
    where ra.refund_id = r.id
  ) totals on true
  where r.allocation_status = 'finalized'
    and (totals.allocation_count = 0
      or totals.component_count <> totals.allocation_count
      or totals.allocation_minor <> r.amount_minor
      or totals.component_minor <> r.amount_minor)

  union all
  select 'dispute_component_equation', count(*)::bigint
  from dispute_item_allocations
  where total_effect_minor <> subtotal_effect_minor + tax_effect_minor

  union all
  select 'reporting_correction_zero_sum', count(*)::bigint
  from correction_sums
  where delta_minor <> 0
)
select check_name, violation_count
from conservation_counts
order by check_name;
```

### Post-restore classifier and projection-tip check

The projection singleton query must return `active_row_count = 1`, and the payout-discovery singleton structural query must return `violation_count = 0`. A missing payout-discovery singleton loses the durable provider-coverage high-water and blocks restore acceptance; do not recreate it by hand. The following decision query lists missing, ambiguous, or still-unknown active decisions using only internal IDs. Missing decisions can be legitimate staged/pending work. Every active unknown decision must have exactly one open exception-impact `unsupported_category` issue keyed to that exact classification-row ID; historical unknown rows for retired classifiers are intentionally excluded. Multiple decisions are never legitimate. Do not insert a decision or issue by hand.

```sql
select count(*)::bigint as active_row_count,
  min(classifier_version) as classifier_version,
  min(allocation_algorithm_version) as allocation_algorithm_version
from financial_projection_versions
where singleton = true;

select 'financial_payout_discovery_singleton' as check_name,
  (abs(count(*) filter (where singleton is true) - 1)
    + count(*) filter (where singleton is distinct from true))::bigint as violation_count
from financial_payout_discovery_state;

with active as (
  select classifier_version
  from financial_projection_versions
  where singleton = true
), subjects as (
  select 'balance_transaction'::text as subject_type, id as subject_id,
    fingerprint_sha256 as source_fingerprint_sha256
  from stripe_balance_transactions
  union all
  select 'fee_detail'::text, id, fingerprint_sha256
  from stripe_balance_transaction_fee_details
), decision_counts as (
  select s.subject_type, s.subject_id,
    count(c.id)::bigint as decision_count,
    count(c.id) filter (where c.classification = 'unknown')::bigint as unknown_count,
    count(i.id) filter (where c.classification = 'unknown')::bigint
      as unsupported_issue_count
  from subjects s
  cross join active a
  left join financial_classification_versions c
    on c.subject_type::text = s.subject_type
   and c.subject_id = s.subject_id
   and c.source_fingerprint_sha256 = s.source_fingerprint_sha256
   and c.classifier_version = a.classifier_version
  left join financial_reconciliation_issues i
    on i.resource_type = 'financial_classification'
   and i.resource_id = c.id
   and i.safe_code = 'unsupported_category'
   and i.state = 'open'
   and i.impact = 'exception'
  group by s.subject_type, s.subject_id
)
select subject_type, subject_id, decision_count, unknown_count, unsupported_issue_count
from decision_counts
where decision_count <> 1
   or unknown_count <> 0
   or (unknown_count = 1 and unsupported_issue_count <> 1)
order by subject_type, subject_id;

select balance_transaction_id, basis, base_set_id,
  compatible_correction_tip_id, missing_source_count, proposed_issue_code
from current_financial_projection_heads
where not is_complete
order by balance_transaction_id, basis;

with active as (
  select classifier_version, allocation_algorithm_version
  from financial_projection_versions
  where singleton = true
), active_sets as (
  select s.*
  from financial_allocation_sets s
  cross join active a
  where s.classifier_version = a.classifier_version
    and s.algorithm_version = a.allocation_algorithm_version
), tips as (
  select s.balance_transaction_id, s.basis, count(*)::bigint as tip_count
  from active_sets s
  where not exists (
    select 1 from active_sets successor where successor.supersedes_set_id = s.id
  )
  group by s.balance_transaction_id, s.basis
)
select balance_transaction_id, basis, tip_count
from tips
where tip_count > 1
order by balance_transaction_id, basis;
```

The incomplete projection query may legitimately show `missing_source`, `allocation_incomplete`, or a bounded exception while recovery is pending. Each row must agree with durable source state/issues. The final tip query must be empty.

### Post-restore payout-generation check

Every result must be zero. This proves page counts, publication authority, generation ordering, supported membership shape, and the atomic current-generation impact handoff without printing provider IDs.

```sql
with entry_counts as (
  select r.id, r.payout_id, r.generation, r.state, r.candidate_count,
    count(e.id)::bigint as entry_count
  from payout_import_runs r
  left join payout_import_run_entries e on e.run_id = r.id
  group by r.id, r.payout_id, r.generation, r.state, r.candidate_count
), payout_membership_counts as (
  select r.id, count(m.id)::bigint as membership_count
  from payout_import_runs r
  left join stripe_payout_balance_transactions m on m.payout_id = r.payout_id
  group by r.id
), payout_checks as (
  select 'run_candidate_count' as check_name, count(*)::bigint as violation_count
  from entry_counts
  where entry_count <> candidate_count

  union all
  select 'run_generation_order', count(*)::bigint
  from payout_import_runs r
  join stripe_payouts p on p.id = r.payout_id
  where r.generation > p.financial_generation
     or (r.state in ('collecting', 'publishable') and r.generation <> p.financial_generation)
     or (r.state = 'published' and r.generation = p.financial_generation and not exists (
       select 1
       from payout_import_runs history
       where history.payout_id = r.payout_id
         and history.id <> r.id
         and history.state = 'published'
         and history.generation::bigint + 1 < r.generation::bigint
     ))

  union all
  select 'published_membership_count', count(*)::bigint
  from entry_counts e
  join payout_membership_counts m on m.id = e.id
  where e.state = 'published' and e.entry_count <> m.membership_count

  union all
  select 'membership_nonpublished_run', count(*)::bigint
  from stripe_payout_balance_transactions m
  join payout_import_runs r on r.id = m.published_from_run_id
  where r.state <> 'published'

  union all
  select 'published_entry_missing_membership', count(*)::bigint
  from payout_import_run_entries e
  join payout_import_runs r on r.id = e.run_id and r.state = 'published'
  where not exists (
    select 1
    from stripe_payout_balance_transactions m
    where m.payout_id = r.payout_id
      and m.balance_transaction_id = e.balance_transaction_id
  )

  union all
  select 'published_membership_missing_entry', count(*)::bigint
  from stripe_payout_balance_transactions m
  join payout_import_runs r on r.id = m.published_from_run_id
  where r.state = 'published'
    and not exists (
      select 1
      from payout_import_run_entries e
      where e.run_id = m.published_from_run_id
        and e.balance_transaction_id = m.balance_transaction_id
    )

  union all
  select 'unsupported_authoritative_membership', count(*)::bigint
  from stripe_payout_balance_transactions m
  join stripe_payouts p on p.id = m.payout_id
  where not p.automatic or p.method <> 'standard' or p.reconciliation_status <> 'completed'

  union all
  select 'missing_current_generation_impact_job', count(*)::bigint
  from stripe_payouts p
  where p.financial_generation > 0
    and not exists (
      select 1
      from jobs j
      where j.deduplication_key =
        'financial:payout-impact:' || p.id::text || ':' || p.financial_generation::text
        and j.type = 'commerce.financial-scan'
        and j.max_attempts = 8
        and j.payload = jsonb_build_object(
          'kind', 'payout_impact',
          'payoutId', p.id,
          'payoutGeneration', p.financial_generation
        )
    )
)
select check_name, violation_count
from payout_checks
order by check_name;
```

### Post-restore scan-checkpoint check

Every structural result must be zero. The `failed_running_scan_*`, `pending_replay_child_incomplete`, `pending_replay_child_retry_exhausted`, and `pending_replay_child_permanent` rows are separate operational evidence: non-succeeded replay children preserve a faithful resumable restore, but they block production replacement until the approved worker converges them or Plan 7 resolves the failed work. `pending_replay_child_retry_exhausted` identifies an exhausted child, while `pending_replay_child_permanent` identifies a failed child before its attempt ceiling. Child-count underflow and replay-version mismatch remain structural failures; surplus children are valid late enrollment. The general failed-job procedure remains Plan 7 work and 6B-I provides no SQL reset or arbitrary retry. A `succeeded` current identity for a running scan is structural failure because the permanent key can no longer resume it.

```sql
with pending_replay_children as (
  select version.pending_scan_run_id, version.pending_classifier_version,
    version.pending_allocation_algorithm_version, version.pending_replay_id,
    replay.id as replay_run_id, replay.enqueued_count,
    children.child_count, children.invalid_count, children.incomplete_count,
    children.exhausted_count, children.permanent_count
  from financial_projection_versions version
  left join financial_scan_runs replay on replay.id = version.pending_scan_run_id
  left join lateral (
    select count(*)::bigint as child_count,
      count(*) filter (where
        child.payload ->> 'classifierVersion' is distinct from
          version.pending_classifier_version::text
        or child.payload ->> 'allocationAlgorithmVersion' is distinct from
          version.pending_allocation_algorithm_version::text
        or child.payload ->> 'replayId' is distinct from version.pending_replay_id
      )::bigint as invalid_count,
      count(*) filter (where child.status <> 'succeeded')::bigint as incomplete_count,
      count(*) filter (where
        child.status = 'failed' and child.attempts >= child.max_attempts
      )::bigint as exhausted_count,
      count(*) filter (where
        child.status = 'failed' and child.attempts < child.max_attempts
      )::bigint as permanent_count
    from jobs child
    where child.type = 'commerce.financial-classification'
      and child.payload ->> 'scanRunId' = version.pending_scan_run_id::text
  ) children on true
  where version.singleton = true and version.pending_scan_run_id is not null
), scan_checks as (
  select 'scan_root_job_missing' as check_name, count(*)::bigint as violation_count
  from financial_scan_runs r
  where not exists (
    select 1 from jobs j
    where j.deduplication_key = r.root_key
      and j.type = 'commerce.financial-scan'
      and j.max_attempts = 8
      and case r.kind
        when 'initial_backfill' then r.root_key = 'commerce.financial-scan:initial:v1'
          and j.payload = '{"kind":"initial","version":1}'::jsonb
        when 'hourly' then r.root_key ~ '^commerce\.financial-scan:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):00:00\.000Z$'
          and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4) <> '0000'
          and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 10) =
            to_char(
              make_date(
                substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4)::int,
                substring(r.root_key from char_length('commerce.financial-scan:') + 6 for 2)::int,
                1
              ) + (
                substring(r.root_key from char_length('commerce.financial-scan:') + 9 for 2)::int - 1
              ),
              'YYYY-MM-DD'
            )
          and j.payload = jsonb_build_object(
          'kind', 'hourly', 'scanGenerationHour',
          substring(r.root_key from char_length('commerce.financial-scan:') + 1)
        )
        when 'payout_impact' then r.root_key =
          'financial:payout-impact:' || (j.payload ->> 'payoutId') || ':' ||
          (j.payload ->> 'payoutGeneration')
          and (j.payload ->> 'payoutId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          and jsonb_typeof(j.payload -> 'payoutGeneration') = 'number'
          and (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
          and case when (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
            then (j.payload ->> 'payoutGeneration')::bigint <= 2147483647 else false end
          and j.payload = jsonb_build_object(
          'kind', 'payout_impact',
          'payoutId', j.payload ->> 'payoutId',
          'payoutGeneration', j.payload -> 'payoutGeneration'
        )
        when 'classification_replay' then r.root_key =
          'commerce.financial-classification:scan:' || r.classifier_version::text || ':' ||
          r.allocation_algorithm_version::text
          and j.payload = jsonb_build_object(
          'kind', 'composite_replay',
          'classifierVersion', r.classifier_version,
          'allocationAlgorithmVersion', r.allocation_algorithm_version,
          'replayId', r.replay_id
        )
        else false
      end
  )

  union all
  select 'running_scan_resume_job_missing', count(*)::bigint
  from financial_scan_runs r
  where r.state = 'running'
    and not exists (
      select 1
      from jobs j
      where j.deduplication_key = (case
        when r.cursor_digest_sha256 is null then r.root_key
        else 'commerce.financial-scan:' || r.id::text || ':' || r.phase || ':' || r.cursor_digest_sha256
      end)
        and j.type = 'commerce.financial-scan'
        and j.max_attempts = 8
        and j.status in ('pending', 'running', 'failed')
        and case
          when r.cursor_digest_sha256 is not null then j.payload = jsonb_build_object(
            'kind', 'continuation',
            'scanRunId', r.id,
            'phase', r.phase,
            'cursorDigestSha256', r.cursor_digest_sha256,
            'limit', 100
          )
          when r.kind = 'initial_backfill' then
            r.root_key = 'commerce.financial-scan:initial:v1'
            and j.payload = '{"kind":"initial","version":1}'::jsonb
          when r.kind = 'hourly' then
            r.root_key ~ '^commerce\.financial-scan:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):00:00\.000Z$'
            and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4) <> '0000'
            and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 10) =
              to_char(
                make_date(
                  substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4)::int,
                  substring(r.root_key from char_length('commerce.financial-scan:') + 6 for 2)::int,
                  1
                ) + (
                  substring(r.root_key from char_length('commerce.financial-scan:') + 9 for 2)::int - 1
                ),
                'YYYY-MM-DD'
              )
            and j.payload = jsonb_build_object(
            'kind', 'hourly', 'scanGenerationHour',
            substring(r.root_key from char_length('commerce.financial-scan:') + 1)
          )
          when r.kind = 'payout_impact' then
            r.root_key = 'financial:payout-impact:' || (j.payload ->> 'payoutId') || ':' ||
              (j.payload ->> 'payoutGeneration')
            and (j.payload ->> 'payoutId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            and jsonb_typeof(j.payload -> 'payoutGeneration') = 'number'
            and (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
            and case when (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
              then (j.payload ->> 'payoutGeneration')::bigint <= 2147483647 else false end
            and j.payload = jsonb_build_object(
            'kind', 'payout_impact',
            'payoutId', j.payload ->> 'payoutId',
            'payoutGeneration', j.payload -> 'payoutGeneration'
          )
          when r.kind = 'classification_replay' then
            r.root_key = 'commerce.financial-classification:scan:' ||
              r.classifier_version::text || ':' || r.allocation_algorithm_version::text
            and j.payload = jsonb_build_object(
            'kind', 'composite_replay',
            'classifierVersion', r.classifier_version,
            'allocationAlgorithmVersion', r.allocation_algorithm_version,
            'replayId', r.replay_id
          )
          else false
        end
    )

  union all
  select 'running_scan_cursor_integrity', count(*)::bigint
  from financial_scan_runs r
  where r.state = 'running'
    and r.checkpoint is not null and r.cursor_digest_sha256 is null
    or (r.state = 'running' and r.cursor_digest_sha256 is not null and
      r.cursor_digest_sha256 <> encode(sha256(
        convert_to(r.phase, 'UTF8') || decode('00', 'hex') ||
        convert_to(coalesce(r.checkpoint, ''), 'UTF8')
      ), 'hex'))

  union all
  select 'scan_phase_checkpoint_shape', count(*)::bigint
  from financial_scan_runs r
  where r.phase not in (
      'source_page', 'payout_discovery_page', 'incomplete_payout_run_page',
      'payout_impact_page', 'classification_replay_page',
      'classification_replay_finalize'
    )
    or (r.kind = 'classification_replay' and
      r.phase not in ('classification_replay_page', 'classification_replay_finalize'))
    or (r.kind = 'classification_replay' and r.state = 'completed' and
      r.phase <> 'classification_replay_finalize')
    or (r.kind = 'payout_impact' and r.phase <> 'payout_impact_page')
    or (r.kind in ('initial_backfill', 'hourly') and
      r.phase not in ('source_page', 'payout_discovery_page', 'incomplete_payout_run_page'))
    or (r.phase in ('source_page', 'payout_impact_page') and r.checkpoint is not null and
      r.checkpoint !~ '^(payment|refund|dispute):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or (r.phase = 'incomplete_payout_run_page' and r.checkpoint is not null and
      r.checkpoint !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or (r.phase = 'classification_replay_page' and r.checkpoint is not null and
      r.checkpoint !~ '^(balance_transaction|fee_detail):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or (r.phase = 'classification_replay_finalize' and r.checkpoint is not null)

  union all
  select 'scan_lifecycle_shape', count(*)::bigint
  from financial_scan_runs
  where ((state in ('completed', 'exception')) <> (completed_at is not null))
     or processed_count < 0 or enqueued_count < 0 or page_count < 0

  union all
  select 'completed_scan_retains_cursor', count(*)::bigint
  from financial_scan_runs
  where state = 'completed'
    and (checkpoint is not null or cursor_digest_sha256 is not null
      or safe_outcome is distinct from 'completed')

  union all
  select 'replay_identity_mismatch', count(*)::bigint
  from financial_scan_runs
  where (classifier_version is null) <> (allocation_algorithm_version is null)
     or (classifier_version is null) <> (replay_id is null)
     or ((kind = 'classification_replay') <> (classifier_version is not null))
     or (replay_id is not null and replay_id <>
       'c' || classifier_version::text || '-a' || allocation_algorithm_version::text)

  union all
  select 'pending_replay_authority_mismatch', count(*)::bigint
  from financial_projection_versions version
  left join financial_scan_runs replay on replay.id = version.pending_scan_run_id
  where version.singleton = true and version.pending_scan_run_id is not null
    and (replay.id is null
      or replay.kind is distinct from 'classification_replay'
      or replay.state is distinct from 'running'
      or replay.phase not in ('classification_replay_page', 'classification_replay_finalize')
      or replay.classifier_version is distinct from version.pending_classifier_version
      or replay.allocation_algorithm_version is distinct from
        version.pending_allocation_algorithm_version
      or replay.replay_id is distinct from version.pending_replay_id)

  union all
  select 'pending_replay_child_count_mismatch', count(*)::bigint
  from pending_replay_children pending
  where pending.replay_run_id is not null
    and pending.child_count < pending.enqueued_count

  union all
  select 'pending_replay_child_version_mismatch',
    coalesce(sum(invalid_count), 0)::bigint
  from pending_replay_children

  union all
  select 'pending_replay_child_incomplete',
    coalesce(sum(incomplete_count), 0)::bigint
  from pending_replay_children

  union all
  select 'pending_replay_child_retry_exhausted',
    coalesce(sum(exhausted_count), 0)::bigint
  from pending_replay_children

  union all
  select 'pending_replay_child_permanent',
    coalesce(sum(permanent_count), 0)::bigint
  from pending_replay_children

  union all
  select 'failed_running_scan_retry_exhausted', count(*)::bigint
  from financial_scan_runs r
  join jobs j on j.deduplication_key = (case
    when r.cursor_digest_sha256 is null then r.root_key
    else 'commerce.financial-scan:' || r.id::text || ':' || r.phase || ':' || r.cursor_digest_sha256
  end)
  where r.state = 'running' and j.status = 'failed' and j.attempts >= j.max_attempts

  union all
  select 'failed_running_scan_permanent', count(*)::bigint
  from financial_scan_runs r
  join jobs j on j.deduplication_key = (case
    when r.cursor_digest_sha256 is null then r.root_key
    else 'commerce.financial-scan:' || r.id::text || ':' || r.phase || ':' || r.cursor_digest_sha256
  end)
  where r.state = 'running' and j.status = 'failed' and j.attempts < j.max_attempts
)
select check_name, violation_count
from scan_checks
order by check_name;
```

During rehearsal, start only the maintenance-mode app while the base deployment is Stripe-disabled. Keep the general worker stopped for the entire isolated restore rehearsal. Provider absence is not sufficient isolation: in addition to provider-backed financial jobs, the general worker can claim local-only claim-email and SMTP outbox jobs, including `commerce.claim-email` and `commerce.claim-email-request`. Therefore neither disabled Stripe nor an empty provider-backed queue makes a rehearsal worker safe.

Starting a worker belongs only to a separately approved production replacement after the rehearsal is accepted, with the required Stripe and SMTP runtime, preflight, maintenance, and rollback controls. A future rehearsal could include one only after an explicit no-egress rehearsal runtime, synthetic SMTP, and job-family allowlist are implemented and approved; this repository does not currently supply that runtime. Local classifier replay must wait for that approved production-replacement worker rather than running inside the rehearsal. Teardown follows the storage runbook and must cover the named restore project and every plaintext dump, archive, manifest, test-decryption directory, and verification plaintext artifact through secure deletion or access-controlled retention under policy.

## Final gate evidence (2026-08-14)

This is evidence from the post-review implementation tree. Every accepted candidate-review finding was resolved in bounded commits, and the complete dependency, schema, automated-test, upgrade, build, and smoke gate was rerun before recording **6B-I complete; 6B-II pending**. Five final read-only reviewers inspect this exact evidence commit before handoff.

- The clean dependency and generated-schema gate ran on Node 26.7.0 with npm 11.19.0. `npm ci` installed 284 packages from the lockfile; exact Better Auth schema generation left `src/lib/server/db/schema/auth.ts` content-identical; `npm run db:check` reported no schema drift; and `npm ls --depth=0` reported no missing or invalid direct dependency. The production-tree audit reported three low and four moderate paths, the full-tree audit reported four low and four moderate paths, and neither reported a high or critical finding. The accepted paths and every dated `npm outdated` defer are recorded in [Dependency decisions](dependency-decisions.md).
- `npm run check`, `npm run lint`, and both production builds passed. The unit gate passed 1,632 tests across 175 files; the PostgreSQL integration gate passed 513 tests across 50 files; and all 12 Chromium journeys passed. The four release-contract suites passed 139 tests across four files, including production-smoke ownership, privacy, operations, and fixture-runtime contracts.
- The isolated 0006-to-0007 upgrade command passed all seven owned valid/adversarial fixture outcomes: valid, over-allocation, currency-conflict, partial-facts, pending-refund-allocation, failed-refund-allocation, and canceled-refund-allocation. The valid path advanced the migration journal from seven entries to eight exactly once and proved a second migration run is a no-op; rejected histories rolled back without advancing the journal. Every owned PostgreSQL container, network, and volume was removed afterward.
- The standalone production smoke built and verified a 138,619,426-byte image with digest `sha256:2dfd3285a7fac8737404ae5bf292e58b0af58293f86cb7721a18cb8893dca611`. It ran migrations twice without drift, verified the exact classifier/allocation projection seed and disabled replay root plus its terminal finalizer, brought the maintenance-mode topology healthy, proved Stripe credentials and mounts absent, and removed its owned Compose resources and image. The fresh post-remediation command passed on its first attempt.
- The fixture-runtime smoke independently built a same-source 138,619,426-byte image with digest `sha256:2e54e630547b17bc4dcb140668241f6ad1745b9afddff463fb83051b0f00f600`. Without external Stripe access or real credentials, it accepted one order and one checkout session through the actual web path and observed one completed financial scan in the worker. It then removed the fixture alias, image, containers, network, volumes, secrets, and temporary manifests. A fresh post-gate Docker inventory contained no owned smoke or upgrade containers, networks, volumes, or images. Seven older `%TEMP%\pale-orbit-plan6b-upgrade-*` directories that predated this final gate were observed and deliberately left untouched; no current gate-owned temporary artifact remained.
- `git diff --check` passed. No Sales route or UI, CSV, administrator mutation, Stripe enablement, production launch, or raw provider/identity logging was added by the checkpoint.

## Privacy, secrets, and deployment ownership

Automated tests use signed local fixture events and the test-only fixture gateway. They require neither `STRIPE_SECRET_KEY` nor `STRIPE_WEBHOOK_SECRET` and must not make an external Stripe request. If a test or smoke command asks for real Stripe credentials, stop and repair the disabled/fixture boundary rather than supplying them.

The base `compose.prod.yaml` fixes `APPLICATION_MODE=maintenance`, `STRIPE_ENABLED=false`, `STRIPE_TEST_FIXTURE_MODE=false`, and `STRIPE_LIVE_MODE=false`. It contains no Stripe secret environment setting, `_FILE` setting, or secret mount for any service. It is the production baseline for this checkpoint.

The explicit `compose.stripe.yaml` overlay is opt-in test-mode/future-launch infrastructure. Only app and worker receive `STRIPE_SECRET_KEY_FILE` and `STRIPE_WEBHOOK_SECRET_FILE` under `/run/secrets`; migrate, bootstrap, cleanup, Caddy, and PostgreSQL do not. Export protected values from the deployment secret system, render Compose, then run `npm run stripe:preflight` before any overlay command that can create a container. Preflight reports presence only and must never print a value. The overlay does not change maintenance mode and is not authorization to launch.

Logs, audits, support output, issue rows, job errors, and future route/CSV DTOs must never contain raw Stripe objects or webhook bodies, provider descriptions/messages/metadata, customer identity, email, card/payment-method/billing/address data, receipt/action URLs, or secrets. A full logical backup necessarily retains application PII and minimized provider linkage, so treat its encrypted archive, checksums, manifests, and restore workspace as sensitive access-controlled artifacts; never copy their contents into logs or support output. Provider object IDs remain confined to minimized server-only linkage/ledger rows, bounded internal job routing, canonical test fixtures, and protected backups; operational output should prefer internal UUIDs and aggregates.

Plan 7 owns production launch, monitoring and alerts, general retry administration, automated off-host backup scheduling, deployment hardening, final capacity/pool tuning, and the read-only-root-filesystem review. Checkpoint 6B-I does not open commerce; full Plan 6B remains incomplete until 6B-II and its independent review are complete.
