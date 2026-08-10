# Database and workers

## Ownership

Drizzle schema files under `src/lib/server/db/schema/` are the database model source of truth. Generated SQL and snapshots under `drizzle/` are committed and reviewed. Never use `drizzle-kit push` against shared or production databases.

The web process, migration command, worker, and storage-cleanup command each own a bounded node-postgres pool. The web process uses PostgreSQL for readiness. The worker claims durable jobs from PostgreSQL, dispatches transactional outbox messages, ingests revision sources from private object storage, reduces accepted `stripe_events`, and prepares guest-claim email. Redis is not part of the current topology.

## Local schema changes

Start from an up-to-date branch and a developer-owned ignored `.env`:

```powershell
Copy-Item .env.example .env
npm ci
```

Edit the TypeScript schema, then generate and review SQL:

```powershell
npm run db:generate -- --name=add_title_language
npm run db:check
git diff -- drizzle src/lib/server/db/schema
```

If Drizzle generated unexpected destructive SQL, fix the TypeScript schema and regenerate before applying it. Do not edit generated schema SQL to hide a mismatch. Custom database objects such as the append-only audit trigger use a named `drizzle-kit generate --custom` migration.

## Host-run development

Start PostgreSQL and Mailpit, apply migrations, then run web and worker in separate terminals:

```powershell
docker compose --env-file .env --file compose.dev.yaml up postgres mailpit --detach --wait
npm run db:migrate
npm run admin:bootstrap
npm run dev
```

```powershell
npm run worker:watch
```

Stop service containers without deleting PostgreSQL data:

```powershell
docker compose --env-file .env --file compose.dev.yaml down
```

## Fully containerized development

Run the explicit migration profile before long-running services:

```powershell
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm bootstrap-admin
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

The web service is at `http://localhost:5173`; Mailpit is at `http://localhost:8025`. The worker has no published port. Its Compose health check requires a non-empty `/tmp/worker-ready` file written only after the initial database probe succeeds.

## Tests

Unit tests do not require Docker:

```powershell
npm run test:unit
```

Integration and Playwright commands start a uniquely named PostgreSQL 18.4 Compose project, ask Docker for a random loopback port, apply committed migrations, run the requested tests, and remove the test containers, network, and tmpfs data:

```powershell
npm run test:integration
npm run test:e2e
npm run test:database
```

`npm run verify` runs integration and browser suites in separate disposable Compose projects. Browser tests additionally start the real worker and bootstrap a test administrator so email delivery, ingestion, role authorization, commerce fulfillment/claims, customer downloads, and revision migration use production-shaped paths. The commerce harness uses a provider-neutral fixture only in `APP_ENV=test`, with Stripe disabled and provider secrets stripped from child environments; it exposes no application route that marks an order paid. The harness creates a unique temporary local-storage root and removes only that verified path. Direct preserved-access fixtures reject non-loopback or non-test databases and exist only under `tests/e2e`; they are not production grant controls.

## Production deployment order

Production configuration comes from the invoking process environment; no production `.env` file is used. With the new immutable `APP_IMAGE` available, run:

```powershell
docker compose --file compose.prod.yaml --profile tools run --rm migrate
docker compose --file compose.prod.yaml --profile tools run --rm bootstrap-admin
docker compose --file compose.prod.yaml up --detach --wait
```

Do not start the new web or worker containers if migration exits nonzero. Re-running the same committed migration set is safe because Drizzle records applied migrations in `drizzle.__drizzle_migrations`. The administrator bootstrap is also idempotent and must use the bootstrap-only process secret documented in [authentication and email operations](authentication-and-email.md).

Check the deployment:

```powershell
docker compose --file compose.prod.yaml ps
docker compose --file compose.prod.yaml logs --tail 100 app worker postgres caddy
```

`/health/live` proves only the web process responds. `/health/ready` performs bounded PostgreSQL and storage probes. Worker health proves the worker completed its initial dependency probes and entered the polling loop. Production storefront and API paths remain in maintenance mode while Plan 6B reporting and the Plan 7 launch gate are incomplete. The base production stack keeps Stripe disabled and requires no Stripe credential.

## Job behavior

Workers claim one job at a time with `FOR UPDATE SKIP LOCKED`. A lease timestamp makes work recoverable after a process crash. Each claim increments attempts. Transient failures return to `pending` with bounded exponential delay; permanent or exhausted work moves to `failed` for the future admin operations view.

Handlers persist only deliberately safe error text. The outbox pairs a message and dispatch job in the caller's transaction and delivers at least once. A message already recorded as delivered is not sent again on ordinary job replay, while topic handlers remain responsible for the crash window between an external side effect and the `deliveredAt` update.

Revision-ingestion jobs copy accepted sources to immutable original keys, produce deterministic derived assets, and commit a generation only while it is still current. Transient storage/database/timeout failures retry automatically; permanent archive/content failures require an administrator retry only when the staged source is still intact, or a new immutable upload. See [storage, ingestion, publication, and recovery](storage-ingestion-and-publication.md) for cleanup, capacity, backup, and restore operations.

Authentication email uses the versioned `email.auth.v1` topic and a stable Message-ID. Better Auth creates a signed email-verification token before its awaited callback stores a one-use SHA-256 digest marker and then creates the project outbox transaction. Those callback writes are separate transaction boundaries; the endpoint succeeds only after the outbox write is durable. See the authentication runbook for delivery and safe-troubleshooting details.

Commerce webhook acceptance inserts a minimized `stripe_events` row and a deduplicated `commerce.stripe-event` job in one transaction. The handler retrieves canonical Stripe state without holding a PostgreSQL connection, then uses ordered short transactions for payment/refund/dispute reduction, `entitlement_grants` and effective `entitlements`, `email.commerce.v1` outbox messages, minimized audit events, and final event status. Duplicate/out-of-order jobs converge on canonical state. Guest claim preparation uses `commerce.claim-email` and enumeration-resistant requests use `commerce.claim-email-request`.

Safe operations may inspect IDs, types/topics, status, attempts, reconciliation state, and timestamps. Do not select job/outbox payloads, purchase emails, action URLs, webhook signatures, raw provider bodies, secrets, or card/address data. Preserve failed jobs and event exceptions for review; Plan 7 owns an authorized retry control. See [commerce and guest-claim operations](commerce-and-guest-claims.md).

## Scope of later plans

- Plan 3 registered authentication email outbox topics, integrated Better Auth, and mapped sessions/roles to the actor policy.
- Plan 4 added storage/ingestion jobs, revision lifecycle transitions, and bounded storage cleanup.
- Plan 5 added the six entitlement/reader-state tables and semantic fingerprint columns. Reader migration is synchronous under ordered transaction locks; it is not a worker job.
- Plan 6A added Stripe reconciliation, commerce email/claim jobs, purchase grants, and refund/dispute access reduction.
- Plan 6B adds balance-transaction/payout import and financial reporting jobs.
- Plan 7 adds failed-job administration, structured logging, queue-age monitoring, scheduled off-host backups, and final pool/capacity tuning.
