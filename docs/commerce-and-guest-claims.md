# Commerce and guest-claim operations

## Release state and authority

Plan 6A implements the multi-title cart, Stripe-hosted Checkout, signed asynchronous fulfillment, guest purchase claiming, purchase-backed entitlement grants, and refund/dispute access changes. Development and production remain credential-free and disabled by default. Production is still fixed to `APPLICATION_MODE=maintenance`; completing Plan 6A does not publish the Hetzner storefront.

PostgreSQL is authoritative. Browser cart data contains title IDs and a client attempt UUID only. The server re-quotes current public titles, ownership, currency, and prices before creating immutable `orders` and `order_items`. A successful browser redirect never grants access. Only a signature-verified Stripe event followed by canonical Checkout Session and Payment retrieval can make an order paid and create an `entitlement_grants` row. The `entitlements` table is the effective user/title projection used by the library, reader, and download routes.

Stripe Checkout is the only payment UI. Eligible payment methods are managed in the Stripe Dashboard; the application does not collect or persist card or billing fields. Stripe Dashboard also remains the refund and dispute-response UI.

## Configuration contract

The application pins Stripe API version `2026-07-29.dahlia`. Prices are tax-exclusive and the storefront says **Tax calculated at checkout**. Checkout Sessions last exactly 30 minutes. Delayed payment methods can leave a completed Checkout pending until a later signed asynchronous success or failure event.

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

`STRIPE_CHECKOUT_DURATION_SECONDS` is deliberately fixed at `1800`. Webhook signatures accept the configured tolerance, up to the validated 900-second bound; the default is 300 seconds. Currency is snapshotted per item and order, never converted, and mixed-currency carts are rejected.

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

The action link is one-use. A signed-in verified account may claim every eligible purchase for the same normalized email in one locked transaction. Replaying the action is safe and grants nothing twice. The `/claim` request form always returns the same generic response for present, absent, and already-claimed email addresses.

If a guest email already belongs to an unverified password account, the receipt directs the customer through normal email verification first. After verification, request a fresh claim link at `/claim`; the claim never treats an unverified account or browser-submitted email as ownership proof. Magic-link and password-reset behavior remains documented in [authentication and email operations](authentication-and-email.md).

Use Mailpit to inspect local receipt, claim, and verification messages. Do not print outbox payloads or action URLs into terminal diagnostics.

## Webhook and worker lifecycle

`POST /api/webhooks/stripe` reads bounded untouched bytes, verifies the `Stripe-Signature`, rejects live/test-mode mismatch, minimizes the supported event, and transactionally inserts one `stripe_events` row plus one deduplicated `commerce.stripe-event` job. Duplicate deliveries converge on the same row/job; a conflicting reuse of a provider event ID cannot overwrite accepted evidence.

The worker retrieves canonical provider state outside a database transaction. It then enters short ordered transactions to reduce payment, refund, or dispute state; update purchase grants and the effective entitlement projection; enqueue deduplicated `email.commerce.v1` messages; append a minimized audit event; and mark the event processed. Provider/SMTP calls are never held inside database transactions.

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

Logs must contain only safe categories and correlation/record IDs. Do not enable provider request/response logging. Never select or print `purchase_email`, guest email digests, outbox payloads, email bodies, cookies, tokens, Checkout URLs, Stripe signatures, or any secret/card/address data.

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
where type in ('commerce.stripe-event', 'commerce.claim-email', 'commerce.claim-email-request')
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

A pending Stripe event with a pending/retryable job should be allowed to retry. A failed or exception event must be preserved for investigation; Plan 7 owns an authorized job-retry UI, so do not hand-edit attempts or status. Verify network/configuration, canonical Stripe object state, live mode, currency, order amount, and worker health. Stripe will retry non-2xx webhook delivery; application job retries use the configured bounded backoff.

For receipt/claim delivery, inspect only outbox topic/status/deduplication key and job status—not the payload. Confirm Mailpit/SMTP reachability and worker health. A delivered outbox row suppresses ordinary replay, though an SMTP crash window can still produce a harmless duplicate message.

## Refund and dispute reconciliation

Initiate refunds and respond to disputes in Stripe Dashboard. Signed events cause the application to retrieve canonical Refund, Dispute, and Payment state before changing access.

A full refund that maps exactly to one item permanently revokes that purchase grant. Complete cumulative refunds can revoke all funded grants. For a partial multi-title refund with no stored provider allocation, the application records `reconciliation_status=exception` and keeps access rather than guessing which title to revoke. Plan 6B will add administrative allocation and financial reconciliation for these exceptions.

An open dispute suspends otherwise-active purchase grants funded by the payment. A won dispute restores only grants that are not fully refunded or permanently revoked. A lost dispute permanently revokes them. Another active purchase grant or preserved administrative grant keeps effective access, because `entitlements` is recomputed from all grants rather than toggled from one event.

## Production Compose overlay

The base production file is intentionally Stripe-disabled and validates without Stripe credentials:

```powershell
docker compose --file compose.prod.yaml config --quiet
```

`compose.stripe.yaml` is an explicit test-mode/future launch overlay. The deployment process must source `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` from protected memory/CI secret storage. Compose mounts them as `/run/secrets` files only into app and worker:

```powershell
docker compose --file compose.prod.yaml --file compose.stripe.yaml config --quiet
docker compose --file compose.prod.yaml --file compose.stripe.yaml up --detach --wait
```

The overlay does not alter `APPLICATION_MODE=maintenance`, `STRIPE_LIVE_MODE=false`, database/auth/SMTP secrets, or the migration/bootstrap tools. Do not use it as a production-launch switch. Plan 7 owns the deployment launch gate and Hetzner hardening.

## Deferred Plan 6B work

Plan 6B remains pending. It will import Stripe balance transactions and payouts, reconcile processing/refund/dispute fees, allocate ambiguous refunds, expose per-title copies/gross/fees/estimated payout reporting, and distinguish estimates from settled payout revenue. Plan 6A does not claim fee-accurate revenue, payout reconciliation, or an administrator sales dashboard. Production launch also remains incomplete while maintenance mode is fixed.
