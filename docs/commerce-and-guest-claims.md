# Commerce and guest-claim operations

## Release state and authority

Plan 6A implements the multi-title cart, Stripe-hosted Checkout, signed asynchronous fulfillment, guest purchase claiming, purchase-backed entitlement grants, and refund/dispute access changes.

**Status:** Plan 6B candidate — independent review pending

The unified Plan 6B candidate adds local financial ingestion/reconciliation and direct administrator review, finalization, correction, recovery, payout, reporting, and CSV routes. The global navigation still shows `Sales — Upcoming` without a live link until review accepts the candidate. Development and production remain credential-free and Stripe-disabled by default, and production remains fixed to `APPLICATION_MODE=maintenance`. See the [financial reconciliation and reporting operator guide](financial-reconciliation-and-reporting.md).

The committed migration chain ends at `0013`; `0012` retains its historical eight callable public boundary routines and `0013` adds the final ninth routine. The four pairwise-distinct principals are `DATABASE_OWNER_USER`, `DATABASE_USER`, `DATABASE_WORKER_USER`, and `DATABASE_STORAGE_CLEANUP_USER`. The web principal submits and reads owner-scoped financial command status and records the route audit boundary; only the worker executes protected mutations. Deployment preserves migrate → role provision → checkpoint capture → distinct-engine rehearsal → smoke. Plan 7 still owns launch and production operability.

PostgreSQL is authoritative. Browser cart data contains title IDs and a client attempt UUID only. The server re-quotes current public titles, ownership, currency, and prices before creating immutable `orders` and `order_items`. A successful browser redirect never grants access. Only a signature-verified Stripe event followed by canonical Checkout Session and Payment retrieval can make an order paid and create an `entitlement_grants` row. The `entitlements` table is the effective user/title projection used by the library, reader, and download routes.

Guest order status uses a domain-separated HMAC credential scoped to the random checkout-attempt UUID; PostgreSQL stores only its SHA-256 digest. Exact concurrent retries return the same credential, so reversed HTTP response order cannot install an obsolete cookie. A terminal, changed, or provider-stale attempt returns a safe conflict and the cart rotates its attempt before retrying.

Stripe Checkout is the only payment UI. Eligible payment methods are managed in the Stripe Dashboard; adaptive pricing is explicitly disabled so Stripe cannot change the accepted order currency or amount. The application does not collect or persist card or billing fields. Stripe Dashboard also remains the refund and dispute-response UI.

## Configuration contract

The application pins Stripe API version `2026-07-29.dahlia`. Prices are tax-exclusive and the storefront says **Tax calculated at checkout**. The configured Checkout hold is 30 minutes; the deterministic whole-second provider deadline reserves no more than one additional minute for safe Session creation and a 30-second outbound-call margin. Delayed payment methods can leave a completed Checkout pending until a later signed asynchronous success or failure event.

The nonsecret baseline is:

```dotenv
STRIPE_ENABLED=false
STRIPE_TEST_FIXTURE_MODE=false
STRIPE_LIVE_MODE=false
STRIPE_AUTOMATIC_TAX_ENABLED=false
STRIPE_CHECKOUT_DURATION_SECONDS=1800
STRIPE_WEBHOOK_TOLERANCE_SECONDS=300
COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS=60
COMMERCE_CHECKOUT_RATE_LIMIT_MAX=5
STRIPE_TAX_CODE_PROSE=
STRIPE_TAX_CODE_COMIC=
```

`STRIPE_CHECKOUT_DURATION_SECONDS` is deliberately fixed at `1800`. Webhook signatures accept the configured tolerance, up to the validated 900-second bound; the default is 300 seconds. Currency is snapshotted per item and order, never converted, and mixed-currency carts are rejected. The accepted set is pinned to Stripe's [supported presentment currencies](https://docs.stripe.com/currencies) as reviewed on 2026-08-10, intersected with runtime `Intl.NumberFormat` support; Stripe's exceptional ISK/UGX charge-unit semantics remain deliberately excluded. Catalog prices are positive and at most `49,999,999` minor units, and a complete Checkout subtotal has the same ceiling. Canonical provider amounts are capped at `99,999,999` minor units, leaving explicit headroom for automatic tax while rejecting oversized provider snapshots.

When `STRIPE_AUTOMATIC_TAX_ENABLED=true`, both `STRIPE_TAX_CODE_PROSE` and `STRIPE_TAX_CODE_COMIC` are required Stripe `txcd_...` codes selected for the operator's products and jurisdictions. Automatic tax remains off until those codes and the Stripe account's tax configuration have been reviewed. The application still stores canonical Stripe-calculated subtotal, tax, and total values after payment.

Never enable `STRIPE_TEST_FIXTURE_MODE` outside `APP_ENV=test`. Production configuration rejects it. The Playwright fixture is provider-neutral, has no public “mark paid” route, uses no Stripe network request, and strips inherited provider secrets from test child processes.

## Local development and Mailpit

Ordinary local development uses the disabled values already present in `.env.example`. Start the app, worker, PostgreSQL, and Mailpit with:

```powershell
.\scripts\start-dev.ps1
```

The storefront is at `http://localhost:5173` and Mailpit is at `http://localhost:8025`. With Stripe disabled, catalog/cart review still works, but Checkout returns the safe temporary-unavailable state and no order can be fulfilled.

Automated commerce coverage uses disposable PostgreSQL/Mailpit projects and the test-only gateway:

```powershell
npm run test:integration
npm run test:e2e
```

The browser suite covers account and guest purchases, price re-confirmation, delayed payment, duplicate events, claims, refunds, disputes, reader/download access, and privacy boundaries without credentials.

## Optional local Stripe test-mode checkpoint

Run this only after the automated release gate is green. Put your own test values into the ignored local `.env`; do not commit them and do not send them to anyone:

```dotenv
STRIPE_ENABLED=true
STRIPE_TEST_FIXTURE_MODE=false
STRIPE_LIVE_MODE=false
STRIPE_SECRET_KEY=sk_test_REPLACE_LOCALLY
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_WITH_STRIPE_CLI_OUTPUT
```

Start Stripe CLI forwarding in a separate terminal without copying its signing secret into logs or chat:

```powershell
stripe listen --forward-to http://localhost:5173/api/webhooks/stripe
```

Restart both app and worker after changing `.env`. Exercise one account Checkout and one guest Checkout. If a delayed method is enabled in the Dashboard, verify its pending and later-success path. Confirm the account order opens the library, the guest receives a Mailpit receipt/claim link, the one-use claim grants access, a Dashboard refund changes only the funded grant, and a supported test dispute suspends then resolves access.

Restore `STRIPE_ENABLED=false` after the checkpoint unless local test-mode use is intentionally continuing. Never paste Stripe credentials into chat. Never put them in screenshots, issue reports, diagnostic SQL, application logs, committed files, or `.env.example`.

## Guest receipt and claim lifecycle

A canonically paid guest Checkout must contain a normalized Checkout email. Fulfillment creates or reuses a `guest_identities` record, attaches the paid order and unclaimed purchase grants, and enqueues a combined receipt/claim message on `email.commerce.v1`. Until claim, the guest has no library, reader, or download authority.

The emailed action combines the native one-use magic/reset action with an independent 256-bit claim proof. Both bearers exist only in the fragment of the exact same-origin `/claim/authorize` bridge URL; URL fragments are not sent in the HTTP request target and therefore never reach Caddy or application request logs. The no-store/no-referrer bridge serves a nonce-bound, restrictive-CSP page that immediately clears the fragment and moves it into a same-origin, nonce-checked POST body. The POST validates the complete action shape, copies the proof into the path-scoped HttpOnly cookie, and returns a 303 to the native action without the proof. After the native magic/reset succeeds, the auth hook checks both the proof and exact native token and promotes the protected issuance from `issued` to `authorized` in one database stage. `/claim/complete` is a later stage: its locked claim transaction consumes the authorized issuance while attaching every eligible purchase for the same normalized email. A direct visit, ordinary verification link, ordinary password reset, or ordinary magic link therefore cannot claim, and an exact successful replay returns the same safe result without granting anything twice. The `/claim` request form always returns the same generic response for present, absent, and already-claimed email addresses.

When no password credential exists, the commerce email may use a one-use magic link. Every ordinary and commerce magic link also has a project marker bound to the authorized credential generation at issuance. After Better Auth creates a session, the hook atomically consumes the marker and rechecks that generation; stale or in-flight links crossing a password reset have their session deleted and cookie expired. A verified credential that appeared after issuance remains present and rejects the magic action. If only an unverified credential appeared, Better Auth removes it after mailbox proof and the application may remove orphan authority and continue passwordless when no reset is active or the exact live reset marker remains unapplied. Once a reset has applied its new hash, that newer mailbox-proven generation wins: the older magic action is rejected even if Better Auth cleanup removed the credential. Any surviving authority row makes the next claim request route to exact-purpose password recovery rather than another magic link. A successful magic action also invalidates every pending native/project reset and clears passwordless reset authority while holding the user lock, so an older unapplied reset cannot take over the claimed account later. A magic-derived authorization is rejected if a password credential exists when the claim transaction runs.

When any password credential already exists, whether verified or unverified, commerce claiming requires the exact-purpose password-recovery email. Successful reset changes the password first, revokes every prior session, marks only the reset-token-bound account verified, and then mints reset-derived commerce authorization. Project-owned credential authority serializes sibling and in-flight resets: only a live native token may be mailed, completion must match the exact hash applied by that token, and stale rollback is compare-and-swap. Requesting recovery alone does not disable the current authorized password. The reset page signs in explicitly with the newly chosen password before offering `/claim/complete`; no follow-up verification message is used. Ordinary email verification never auto-signs in, and the in-session change-password endpoint is disabled so password changes use the serialized recovery boundary. If post-reset authorization creation or sign-in fails, the consumed form is replaced with generic recovery guidance and never claims; a fresh mailbox reset is the only recovery.

Use Mailpit to inspect local receipt, claim, and recovery messages. Do not print outbox payloads or action URLs into terminal diagnostics. Passwords, reset tokens, magic tokens, claim proofs, and cookies must never enter logs, audits, support screenshots, or unrelated URLs. The independent proof and nested native action are permitted only in the emailed bridge fragment described above; the bridge clears that fragment before its nonce-bound POST, so proxy-visible bridge URIs contain no bearer. The native token is subsequently permitted only in Better Auth's required one-use action URL.

## Signed-account duplicate-purchase holds

Signed-in quotes expose four disjoint partitions: purchasable items, `alreadyOwnedTitleIds`, `claimableTitleIds`, and `reservedTitleIds`. Claimable means a paid, unclaimed guest purchase matches the verified account email. Reserved means another purchase may still resolve, including an account or same-email guest grant suspended by an open dispute. These are duplicate-charge safety holds, not finite-inventory reservations; anonymous cross-device deduplication remains out of scope until a canonical paid email exists.

For the same user/title, `checkout_pending`, `checkout_open`, `payment_pending`, `failed`, and `exception` orders remain reserved. A same-attempt pending/open request is resumable only within the shared 30-second provider-call safety window; after that it fails closed, but elapsed local time alone never releases the title. Canonical paid ownership supersedes a hold. Only a signature-verified, canonically reduced Checkout Session `expired` state releases it; an expired order cannot later become paid or exception.

Signed asynchronous `failed` remains unresolved because a later canonical success is supported. The browser continues polling, preserves its checkout attempt and cart, and tells the customer not to start another checkout. Ambiguous pending, failed, or exception holds require provider-verified operational recovery in Plan 7. Never release one with a manual status edit or an elapsed-time SQL update.

## Webhook and worker lifecycle

`POST /api/webhooks/stripe` reads bounded untouched bytes, verifies the `Stripe-Signature`, rejects live/test-mode mismatch, minimizes the supported event, and transactionally inserts one `stripe_events` row plus one deduplicated `commerce.stripe-event` job. Duplicate deliveries converge on the same row/job; a conflicting reuse of a provider event ID cannot overwrite accepted evidence.

Configure the Stripe Dashboard endpoint with API version `2026-07-29.dahlia` and only this exact allowlist: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `refund.created`, `refund.updated`, `refund.failed`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`, `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`, `payout.canceled`, and `payout.reconciliation_completed`. The last six are the complete payout-event extension. Do not subscribe this endpoint to broad `*` delivery; `payout.paid` alone never proves exact membership.

The worker retrieves canonical provider state outside a database transaction. It then enters short ordered transactions to reduce payment, refund, or dispute state; update purchase grants and the effective entitlement projection; enqueue deduplicated `email.commerce.v1` messages; append a minimized audit event; and mark the event processed. The same commit hands payment/refund/dispute facts to a deduplicated `commerce.financial-source` job. A payout event is marked processed while atomically handing its canonical provider ID to `commerce.financial-payout`; the later job performs retrieval. After an operation-local event or identity lock, purchase facts are always locked as order, payment, refunds, allocations, disputes, items, sorted entitlement scopes, then grants. Provider/SMTP calls are never held inside database transactions.

Relevant audit actions are:

- `commerce.checkout_created`
- `commerce.checkout_session_conflict`
- `commerce.fulfillment_paid`
- `commerce.fulfillment_exception`
- `commerce.guest_claimed`
- `commerce.refund_reconciled`
- `commerce.dispute_reconciled`

Receipt, claim, and access-change email use deterministic deduplication keys. SMTP delivery remains at least once because PostgreSQL cannot atomically commit with the SMTP server.

## Safe diagnosis

Start with bounded service status and logs:

```powershell
docker compose --file compose.prod.yaml ps
docker compose --file compose.prod.yaml logs --tail 100 app worker
```

Logs must contain only safe categories and correlation/record IDs. Do not enable provider request/response logging. Never select or print guest identity email plaintext (`orders.purchase_email` or `guest_identities.email`), outbox payloads, email bodies, cookies, tokens, Checkout URLs, Stripe signatures, credential-authority hashes/reset epochs, or any secret/card/address data.

Safe database inspection can use identifiers, statuses, counts, timestamps, and minimized reconciliation state:

```sql
select id, status, currency, created_at, updated_at
from orders
where id = '<order-uuid>';

select id, status, amount_minor, currency, reconciliation_status, paid_at, updated_at
from payments
where order_id = '<order-uuid>';

select id, event_type, status, provider_created_at, processed_at, updated_at
from stripe_events
where id = '<event-uuid>';

select id, type, status, attempts, max_attempts, run_at, updated_at
from jobs
where type in (
  'commerce.stripe-event', 'commerce.claim-email', 'commerce.claim-email-request',
  'commerce.financial-source', 'commerce.financial-payout',
  'commerce.financial-scan', 'commerce.financial-classification'
)
order by created_at desc
limit 50;

select id, source, state, state_reason, updated_at
from entitlement_grants
where order_item_id = '<order-item-uuid>';

select id, action, outcome, resource_type, resource_id, correlation_id, occurred_at
from audit_events
where resource_id = '<order-or-event-uuid>'
order by occurred_at;
```

A Stripe event job gets 12 attempts, covering about 18.5 minutes with the production 1-second base and 5-minute backoff cap. If Stripe redelivers an exact event after those attempts are exhausted, acceptance atomically re-arms the same deduplicated job only while the event remains pending; processed, exception, and conflicting events are never re-armed. Otherwise preserve failed jobs and exception events for investigation. Financial source/payout jobs get 12 attempts, scan jobs get 8, and classification jobs get 5. Exhausted transient financial work remains durable; a later hourly generation, payout-generation impact scan, or classifier-version replay can enqueue a new permanent key. Plan 7 owns the authorized job-retry UI, so do not hand-edit attempts or status. Verify network/configuration, canonical Stripe object state, live mode, currency, order amount, and worker health. Stripe retries non-2xx webhook delivery; application job retries use the configured bounded backoff. Ordinary quote, checkout, and claim-request throttle consumption also removes a bounded batch of expired rows from its own namespace, so no separate rate-limit cleanup command is required.

For receipt/claim delivery, inspect only outbox topic/status/deduplication key and job status—not the payload. Confirm Mailpit/SMTP reachability and worker health. A delivered outbox row suppresses ordinary replay, though an SMTP crash window can still produce a harmless duplicate message.

## Refund and dispute reconciliation

Initiate refunds and respond to disputes in Stripe Dashboard. Signed events cause the application to retrieve canonical Refund, Dispute, and Payment state before changing access.

A full refund that maps exactly to one item permanently revokes that purchase grant. Complete cumulative refunds can revoke all funded grants. For a partial multi-title refund with no stored provider allocation, the Plan 6A event remains an access-safe exception and keeps access rather than guessing. The Plan 6B financial projection records the orthogonal state as `needs_review` plus `pending` and opens an `allocation_incomplete` issue. The candidate’s authorized draft/finalization route is the only administrative allocation path; direct SQL allocation remains unsupported.

An open dispute suspends otherwise-active purchase grants funded by the payment. A won dispute restores only grants that are not fully refunded or permanently revoked. A lost dispute permanently revokes them. Another active purchase grant or preserved administrative grant keeps effective access, because `entitlements` is recomputed from all grants rather than toggled from one event.

## Financial ingestion and recovery boundary

Plan 6B keeps financial consumers and operational inspection on local durable facts; it never makes a live Stripe call from a report. `commerce.financial-source` imports canonical payment, refund, and dispute balance transactions and fee details, verifies provider linkage, appends versioned classifications, and writes exactly conserving allocation sets. Amount and net values are signed minor-unit integers, fees are nonnegative, and every balance transaction satisfies `net = amount - fee`. Customer-presentment currency and Stripe-settlement currency remain separate; the application performs no conversion and never invents a mixed-currency total.

When runtime mode is fixture or Stripe, each worker polling loop ensures an initial provider root and one UTC-hour-keyed recovery root. The initial payout range begins seven days before the earliest local paid order, or seven days before the current hour when none exists. Hourly payout discovery overlaps the prior 72 hours. Every local batch or provider page is limited to 100 resources, commits its cursor/checkpoint, and enqueues a bounded continuation. A completed scan means only that its bounded local/provider pages committed; it does not prove that Stripe has no newer activity or that every source is report-complete.

A separate classifier/allocation-version root is ensured when its composite version changes, including while Stripe is disabled. It reads only durable local evidence, appends decisions and superseding allocation sets, and recomputes issues; it never rewrites provider history. Provider roots do not run in disabled mode. There is no manual synchronization endpoint.

`commerce.financial-payout` may publish exact membership only for an automatic standard payout whose canonical status is currently `paid`, whose `reconciliation_status` is `completed`, and whose filtered balance-transaction pagination completed without linkage, collision, currency, or membership conflict. Publication increments a payout generation and queues bounded impact work. Manual and instant payouts remain `fee_reconciled` with no application-assigned membership; a later failure, cancellation, or reversal preserves history and reopens derived state.

Safe financial states are `pending`, `fee_reconciled`, `payout_reconciled`, and `exception`. Open issues use bounded codes such as `missing_source`, `unsupported_category`, `immutable_mismatch`, `currency_mismatch`, `allocation_incomplete`, `payout_incomplete`, or `payout_membership_conflict`. Inspect internal IDs, codes, state, impact, counts, currencies, and timestamps only. There is no generic Resolve action: an issue closes only when canonical recomputation proves its invariant after new evidence or an authorized append-only workflow. Never update ledger, allocation, membership, checkpoint, classification, or issue rows directly. See [Stripe financial reconciliation](stripe-financial-reconciliation.md) for the complete operating and recovery procedure.

## Production Compose overlay

The base production file is intentionally Stripe-disabled and validates without Stripe credentials:

```powershell
docker compose --file compose.prod.yaml config --quiet
```

`compose.stripe.yaml` is an explicit test-mode/future launch overlay. The deployment process must source `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` from protected memory/CI secret storage. Compose mounts the API secret into app and worker, but mounts the webhook-verification secret only into app:

```powershell
docker compose --file compose.prod.yaml --file compose.stripe.yaml config --quiet
npm run stripe:preflight
docker compose --file compose.prod.yaml --file compose.stripe.yaml up --detach --wait
```

`docker compose config` verifies the merged structure, but it does not verify that environment-backed secret values are present. `npm run stripe:preflight` requires the repository's documented Node.js/npm toolchain, exits nonzero when either variable is missing or empty, and reports only presence without printing either value. Run it after exporting the deployment secrets and before every Stripe-overlay command that can create a container.

On a Docker-only Linux VPS without host Node.js, use this dependency-free POSIX-shell equivalent and continue only when it exits zero:

```sh
stripe_credential_present() {
  case "${1-}" in
    *[![:space:]]*) return 0 ;;
    *) return 1 ;;
  esac
}

if ! stripe_credential_present "${STRIPE_SECRET_KEY-}" ||
   ! stripe_credential_present "${STRIPE_WEBHOOK_SECRET-}"; then
  printf '%s\n' '[stripe-preflight] required Stripe credentials are missing or empty' >&2
  exit 1
fi
printf '%s\n' '[stripe-preflight] required Stripe credentials are present'
```

Neither preflight prints credential values. Container creation is the first Compose operation that consumes them.

The overlay does not alter `APPLICATION_MODE=maintenance`, `STRIPE_LIVE_MODE=false`, database/auth/SMTP secrets, or the migration/bootstrap tools. Do not use it as a production-launch switch. Plan 7 owns the deployment launch gate and Hetzner hardening.

## Candidate status and remaining launch work

**Status:** Plan 6B candidate — independent review pending

The candidate combines ingestion, allocation, issues, payouts, scheduling, and replay with administrator refund resolution, per-title copies/gross/fees/estimated-payout reporting, payout views, reporting corrections, access recovery, and aggregate CSV. The direct routes remain review-only and the global Sales link remains disabled. Production remains in maintenance mode with Stripe disabled. Plan 7 owns launch, monitoring and alerts, general retry administration, automated off-host backup scheduling, deployment hardening, and final capacity work.
