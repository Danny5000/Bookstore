# Financial Reconciliation and Reporting

**Status:** Plan 6B implementation complete — protected Sales navigation live; Plan 7A Checkpoint C backend authority implemented

This is the operator guide for the completed Plan 6B financial-ingestion, reconciliation, administrator-review, reporting, payout, and CSV implementation. The global administrator navigation now exposes the protected live `Sales` link to `/admin/sales`; the route and service capability checks described below still govern access. Production remains closed in `APPLICATION_MODE=maintenance`, and the base production defaults remain Stripe-disabled.

Plan 6B reads the durable commerce facts established by Plan 6A. It does not replace checkout, refund, dispute, claim, or entitlement authority, and its reporting corrections never rewrite those facts.

Plan 7A Checkpoint C adds a backend-only retry-command boundary over exactly eleven production job kinds; it adds no operations route, page, navigation, polling, or button. Only pending Stripe-event rearm and exact financial-classification rearm are enabled, and no provider call occurs in either retry adapter. The operations capability is per-claim, memory/transaction-local only, and digest-persisted rather than an environment secret. It cannot authorize financial-administrator or revision-ingestion work, whose authorities remain separate.

## Money, copies, and currency domains

Keep customer-presentment and Stripe-settlement money separate. Presentment facts use the order, item, refund-allocation, and dispute currency. Settlement facts use the canonical Stripe balance-transaction currency. Never add or convert unlike currencies, and never include customer sales tax in revenue.

Copy counts use these exact rules:

- `sold copies = paid order items in the selected cohort`
- `fully refunded copies = items whose cumulative finalized, access-effective, succeeded-refund allocation equals the paid item total`
- `net copies = sold copies - fully refunded copies`

A partial refund changes money only. A reporting correction changes attribution only. Neither changes the copy count.

Every settlement amount is a signed effect on title revenue:

- sale subtotal, refund reversals, dispute reinstatements, and fee credits are positive;
- refunds, dispute withdrawals, and provider fees are negative; and
- the gross allocation effect plus the fee allocation effect equals the provider net exactly.

When all required settlement evidence is complete:

`estimated payout = sale subtotal effect + refund impact + dispute impact + processing fee impact + refund fee impact + dispute fee impact + other fee impact`

The UI and CSV preserve those signs. A negative estimate is a numeric negative value, not text. Account-level adjustments may appear on payout detail but never enter a title estimate.

## Nullability, state, and freshness

Presentment metrics remain available when they are safe. Settlement currency is nullable when its domain is not yet known; it may already be known even while the amounts remain incomplete. The settlement component effects and estimated payout are one nullable completeness unit. If any title-affecting settlement source is missing, conflicting, unsupported, or otherwise unsafe, all settlement amounts for that row or summary group are `null`, never zero and never a partial current-looking total. The UI says **Settlement estimate unavailable**, and the CSV leaves those numeric cells empty.

Aggregate state uses the least-complete contributing source in this order:

1. `exception` when an open exception-impact issue exists;
2. `pending` when any source is incomplete;
3. `fee_reconciled` when evidence is complete but qualifying payout membership is unavailable; and
4. `payout_reconciled` only when every source belongs to a supported automatic standard payout whose reconciliation is complete and whose current status is paid.

`Financial data through <timestamp>` is the last successful relevant local scan. If no such timestamp exists, the page reports **Financial freshness unavailable** rather than inventing one. Neither state is a live-Stripe or all-complete guarantee. A late payout failure, reversal, immutable conflict, or new provider movement can reopen a previously complete state.

## Access and normal review flow

The read surfaces require `sales.read`; CSV additionally requires `sales.export`; draft, finalization, correction, and recovery operations additionally require `reconciliation.manage`. Routes authorize before parsing sensitive identifiers, and services repeat authorization. Sales, Needs Review, payout, and CSV surfaces use local durable PostgreSQL facts only and never call Stripe.

Use the Sales overview to filter the stable title/currency rows. Summary groups never collapse unlike currency pairs. Use **Needs Review** for ambiguous refunds, immutable conflicts, unsupported classifications, and incomplete payout imports. A read-only issue is evidence to wait for canonical ingestion or a newer supported classifier, not permission to edit protected rows. There is no generic resolve or provider-retry control.

Within the closed retry policy, `commerce.financial-classification` can rearm only the exact failed target whose active versions, identity, enrollment, and expected state still match. Financial source, payout, and scan retries remain disabled fixed results, while financial-administrator command retry remains an excluded fixed result. This boundary is not a generic reset or permission to edit a protected job.

## Refund draft and finalization

An ambiguous succeeded refund may have one shared administrative allocation draft. Saving or discarding the draft changes no report, grant, entitlement, or customer email. Before finalization, verify:

- the immutable refund/order currency and total;
- every item’s paid subtotal, tax, total, and remaining refundable capacity;
- the proposed per-item totals sum exactly to the refund total;
- the displayed optimistic draft version is current; and
- the access-consequence preview is understood.

Finalization is explicit, confirmed, and one-way. It creates immutable allocation and component rows, recomputes purchase grants and effective access atomically, closes only the specifically linked issue after canonical recomputation, and queues an access-change email only when effective access actually changes. A stale or changed graph returns a conflict and retains the draft for review.

## Reporting corrections

A correction is append-only and reporting-only. It may redistribute refund principal attribution and the refund-specific fee basis, but it must be zero-sum independently for every domain, source allocation set, and currency. It cannot change the provider total or classification, original processing-fee allocation, immutable refund allocation, purchase grants, access, or copy counts.

Only use the named `allocation_attribution_correction` workflow for a finalized succeeded refund with complete compatible evidence. Review the current chain tip, fingerprint, capacities, currencies, and absolute proposed distribution. If evidence changed, stop on the conflict and prepare a new proposal; never edit or delete the old chain. A classifier rebase either appends a compatible successor or opens `correction_rebase_required` and makes affected settlement metrics unavailable.

## Administrative recovery access

Recovery is not a way to undo a refund or correction. It can activate an explicit persistent `administrative` grant only for the exact claimed user/title whose purchase grant was causally revoked by the referenced administrative finalization and whose current compatible correction now places the item below the fully-refunded threshold. Unclaimed guest items, unrelated users/titles, automatic allocations, and already-ineligible purchase grants cannot use it.

Activation and deactivation are separate confirmed actions. Activation does not change financial reporting or purchase history and remains active until an authorized deactivation, even if later financial evidence changes. Deactivation may affect only that linked administrative grant. Each action queues email only when effective access changes and commits the grant, entitlement projection, outbox record, and audit event atomically.

## Payout review

Payout detail separates the total provider payout from the bookstore-linked subset and account-level adjustments; those values need not be equal. Exact title-source membership is available only for an automatic, standard payout after Stripe marks reconciliation complete and the current canonical payout status is paid.

Manual and instant payouts remain `fee_reconciled` and display **exact payout membership unavailable**. Never assign membership manually. Failed or reversed payouts retain historical membership as evidence while current reporting reopens to the appropriate state.

## CSV export

CSV uses the validated active Overview filters and stable ordering, ignores the page cursor, and emits one row per stable title and presentment/nullable-settlement currency pair. Incomplete settlement numeric cells are blank. The export is bounded to 10,000 aggregate rows, 10 MiB, and a generation deadline; a bound failure returns no partial file.

Signed numeric columns remain canonical base-10 integers. Text-origin cells are formula-neutralized and then RFC 4180 quoted. The file excludes customer identity, provider IDs, raw provider objects, private audit metadata, and internal issue evidence. A valid response is UTF-8 `text/csv`, uses the bounded ASCII attachment name, and carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## Command status

Financial mutations are submitted by the web process and executed by the financial worker. Poll only the returned owner-scoped command-status route; do not inspect or retry jobs directly.

That financial command/status authority is distinct from the operations retry authority. A financial-administrator command job is excluded from retry, and neither authority's capability can authorize the other.

| Status | Operator meaning |
| --- | --- |
| `pending` | The command is durably accepted or in progress; continue bounded polling. |
| `succeeded` | The command reached a safe terminal outcome. Refresh the canonical detail; a semantic no-op or replay succeeds without creating a new mutation audit. |
| `denied` | Worker-side authorization or ownership revalidation rejected the command. Do not resubmit unchanged. |
| `conflict` | The locked facts, version, fingerprint, or eligibility changed. Refresh and review before a new command. |
| `failed` | The command reached a safe terminal failure. Preserve its correlation ID and investigate; do not reset the job. |

Each command has one terminal outcome. A browser timeout is not proof that the command failed; return later through the authorized detail and status surfaces.

## Audit and privacy boundary

Overview browsing and filtering are not audited. Issue, refund, and payout detail, CSV export, effective draft changes, finalization, corrections, recovery changes, and aggregate worker outcomes are audited. A detail DTO or complete bounded CSV is produced before its audit event commits; an audit failure prevents the response. Every effective mutation and its successful audit record commit in one transaction; a semantic no-op or replay creates no duplicate mutation audit.

Safe audit evidence is limited to internal resource IDs, normalized action/reason codes, currencies, aggregate minor amounts, counts, safe before/after state, actor, outcome, and correlation ID. It must not contain email, customer or payment identity, provider IDs, raw Stripe data, descriptions, messages, URLs, card or billing data, dispute evidence, cookies, credentials, secrets, tokens, or CSV contents.

Apply the same boundary to diagnostics. Use internal IDs, state, counts, timestamps, currencies, action codes, and correlation IDs only. Never print response bodies, provider payloads, draft contents, audit metadata blobs, emails, or exported CSV data.

## Safe troubleshooting

1. Confirm the application is still in maintenance mode and Stripe is disabled.
2. Record the route, safe state label, internal resource ID, and correlation ID without copying private fields.
3. Check readiness and the documented worker/service state. Do not start an extra worker against production data.
4. Determine whether the row is `pending`, `exception`, `fee_reconciled`, or `payout_reconciled`, and compare the displayed freshness timestamp with the last successful bounded scan.
5. For a pending command, use its owner-scoped status endpoint. For a conflict, refresh and review current canonical facts. For a terminal failure, preserve the row and escalate with the bounded evidence above; the Checkpoint C backend policy has no operator caller, so do not alter attempts or status.
6. For an issue, use only its named workflow. Never update protected ledger, allocation, membership, command, grant, job, or audit rows directly; never delete immutable evidence; never call Stripe from a report route; and never use ad hoc SQL to “resolve” state.

If safe inspection cannot explain the state, stop. Keep maintenance mode enabled and escalate with only the bounded evidence above.

## Migration, principals, and deployment order

The current migration chain ends at `0015_plan7a_operations_authority`, and the executable verifier is `plan7a-database-catalog-v1`. Historically, Plan 6B ended at `0014`: migration `0012` retained its eight callable public boundary routines; `0013` added only `resolve_financial_issue_after_reporting_correction_command(uuid, uuid)`, producing nine; and `0014` changed no callable surface while replacing the nullable issue-transition trigger guard with a fail-closed definition. Missing or partial transaction-local resolution context therefore rejects the protected transition instead of being accepted through SQL `NULL` semantics. Migration `0015` adds the separate operations command/claim authority without weakening that financial boundary; command, audit, and restore authority remains exact and command history is retained.

The four pairwise-distinct login principals are exactly `DATABASE_OWNER_USER`, `DATABASE_USER` (web), `DATABASE_WORKER_USER` (financial worker), and `DATABASE_STORAGE_CLEANUP_USER` (storage cleanup). The web principal may submit commands, read its owner-scoped status, and append the route-authorized audit boundary; it cannot mutate protected financial state. Only the worker principal executes the allowlisted mutation routines. Storage cleanup retains only its narrow storage capability, and the owner is used only for ownership and migrations.

For a Plan 6B release rehearsal, preserve this order:

1. migrate through `0015_plan7a_operations_authority` as the owner;
2. provision and attest the four-role boundary;
3. capture the versioned checkpoint artifacts;
4. rehearse restore on a distinct database engine with app and general worker stopped; and
5. run the production-image smoke gate.

Do not reorder these steps or treat a same-engine check as the restore rehearsal. Production remains closed in `APPLICATION_MODE=maintenance`, and the base production defaults remain Stripe-disabled after Plan 6B implementation completion. The live protected Sales navigation and the Checkpoint C backend do not activate production. Monitoring/alerts, generalized stage evidence, production-live activation, Stripe enablement, fresh release-candidate capture, Checkpoint D, automated off-host backup scheduling, deployment hardening, capacity/pool tuning, and the final production launch remain deferred.
