# Database and workers

**Status:** Plan 6B candidate — independent review pending

The unified Plan 6B candidate is migrated through `0013`. Migration `0012` retains its historical eight callable public boundary routines; `0013` adds only the correction-resolution routine, for a final surface of nine. Production remains in maintenance mode with Stripe disabled. The direct Sales candidate routes remain unlinked until independent review. See [financial reconciliation and reporting](financial-reconciliation-and-reporting.md) for the operator boundary; Plan 7 owns production activation and operability.

## Ownership

Drizzle schema files under `src/lib/server/db/schema/` are the database model source of truth. Generated SQL and snapshots under `drizzle/` are committed and reviewed. Never use `drizzle-kit push` against shared or production databases.

The web process, migration command, worker, and storage-cleanup command each own a bounded node-postgres pool. The web process uses PostgreSQL for readiness. The worker claims durable jobs from PostgreSQL, dispatches transactional outbox messages, ingests revision sources from private object storage, reduces accepted `stripe_events`, prepares guest-claim email, and runs bounded financial source, payout, scan, and classification work. PostgreSQL owns the queue, durable cursors, version checkpoint, locks, financial issues, and immutable ledger history; Redis is not part of the current topology.

Plan 6B financial relations are read-only to the web. The web principal can submit allowlisted administrator commands, read only its owner-scoped status, and append the route-authorized audit boundary through the exact public routines; it cannot execute their protected mutations. The financial worker alone receives the exact routine and `INSERT`/`UPDATE` authority used by source, payout, scan, classification, allocation, correction, and issue publication; neither runtime role receives `DELETE`. The same boundary covers canonical `payments`, `refunds`, `refund_allocations`, and `disputes`. Webhook intake can append only the immutable provider-identity columns of `stripe_events`; database defaults create pending/unprocessed state and only the worker can update completion. New public tables receive SELECT-only default privileges for the web role, so adding a financial table requires an explicit reviewed worker grant rather than silently inheriting web writes.

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

The environment carries four pairwise-distinct credential pairs: `DATABASE_OWNER_USER`/`DATABASE_OWNER_PASSWORD` for PostgreSQL ownership and migrations, `DATABASE_USER`/`DATABASE_PASSWORD` for the web runtime and ordinary tools, `DATABASE_WORKER_USER`/`DATABASE_WORKER_PASSWORD` for the financial worker, and `DATABASE_STORAGE_CLEANUP_USER`/`DATABASE_STORAGE_CLEANUP_PASSWORD` for storage cleanup. Host-run development loads one developer-owned `.env` into each launched process, so it is a convenience workflow rather than a credential-isolation boundary; use development-only secrets. Production and fully containerized development provide the process boundary described below.

For an existing pre-split development volume, move the current `DATABASE_USER` and `DATABASE_PASSWORD` values to `DATABASE_OWNER_USER` and `DATABASE_OWNER_PASSWORD`, then choose distinct new web, worker, and storage-cleanup credentials. If owner, web, and worker are already split, preserve them and add only the cleanup pair. Stop any host-run web, worker, and storage-cleanup processes before migration or role provisioning. Old cleanup code still uses the web login and must not race installation of its dedicated database capability.

Start PostgreSQL and Mailpit, apply migrations, then run web and worker in separate terminals:

```powershell
docker compose --env-file .env --file compose.dev.yaml up postgres mailpit --detach --wait
npm run db:migrate
npm run db:provision-roles
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
docker compose --env-file .env --file compose.dev.yaml stop app worker storage-cleanup
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm database-role-provision
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm bootstrap-admin
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

The web service is at `http://localhost:5173`; Mailpit is at `http://localhost:8025`. The worker has no published port. Its Compose health check requires a non-empty `/tmp/worker-ready` file written only after the initial database probe succeeds.

The long-running app and worker receive only their own database credentials. Compose also mounts the deliberately empty [`deploy/container.env`](../deploy/container.env) over `/app/.env`, so the source-tree bind mount cannot expose the host `.env` to either process. Migration, role provisioning, bootstrap, and cleanup remain bounded one-shot services with only the credentials each command requires.

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
npm run test:plan6b-upgrade
```

`npm run verify` runs integration and browser suites in separate disposable Compose projects. Browser tests additionally start the real worker and bootstrap a test administrator so email delivery, ingestion, role authorization, commerce fulfillment/claims, customer downloads, and revision migration use production-shaped paths. The commerce harness uses a provider-neutral fixture only in `APP_ENV=test`, with provider secrets stripped from child environments; it exposes no application route that marks an order paid. Financial fixture tests exercise the same source, payout, scheduler, and classifier handlers without real Stripe credentials or network access. The harness creates a unique temporary local-storage root and removes only that verified path. Direct preserved-access fixtures reject non-loopback or non-test databases and exist only under `tests/e2e`; they are not production grant controls. The Plan 6B upgrade command uses its own uniquely identified disposable PostgreSQL Compose project to execute every supported prior-schema fixture through the committed migration.

## Production deployment order

The Plan 6B release-evidence order is exact: migrate through `0013`, provision and attest the four principals, capture the versioned checkpoint, rehearse it on a distinct database engine, then run the production-image smoke. A later step cannot substitute for or precede an earlier one.

Production configuration comes from the invoking process environment; no production `.env` file is used. When upgrading an existing PostgreSQL data volume created by the former single-login topology, set `DATABASE_OWNER_USER` to the existing database owner (and use its existing secret); you must not reuse that owner name for `DATABASE_USER`, `DATABASE_WORKER_USER`, or `DATABASE_STORAGE_CLEANUP_USER`. Choose three new login names and secrets for web, worker, and cleanup. An already-split owner/web/worker deployment preserves those pairs and adds the fourth cleanup pair. Role provisioning deliberately rejects a proposed runtime login that owns the database or public application objects, or that inherits unexpected roles, instead of silently weakening the boundary.

With the new immutable `APP_IMAGE` available, first quiesce the old app, worker, and every host-run or containerized storage-cleanup process. This is mandatory for a persistent volume created by the former single-login topology: those processes can retain an old privileged credential or the web cleanup path and race migration or role provisioning.

```powershell
docker compose --file compose.prod.yaml --profile tools stop app worker storage-cleanup
docker compose --file compose.prod.yaml --profile tools run --rm migrate
docker compose --file compose.prod.yaml --profile tools run --rm database-role-provision
```

Before cleanup, bootstrap, or startup, resolve the storage-layout gate. On the first rollout from the legacy `book_storage` volume, complete the [split-volume upgrade](storage-ingestion-and-publication.md#split-volume-upgrade) and retain its verified report:

```powershell
docker compose --file compose.prod.yaml --profile tools rm --force app worker storage-cleanup
$env:STORAGE_MIGRATION_HELPER_IMAGE = 'registry.example.invalid/approved-storage-helper@sha256:<audited-digest>'
npm run storage:migrate-volumes -- --project <exact-project> --report <restricted-absolute-report-path>
```

Skip that migration command for an already-split deployment only when its current three-volume layout and prior migration report were verified. A brand-new installation may also skip only after the exact legacy `book_storage` volume is verified absent and the freshly initialized database is verified to contain no storage-referencing application data; establish this before bootstrap, uploads, or publication. An empty new volume or a readiness sentinel is not migration evidence. You must not run `storage-cleanup`, bootstrap, or either long-running process until the legacy migration report succeeds or one of those two verified exceptions is established.

Then provision/verify the sentinel through the cleanup dry-run and create the required current-v3 atomic checkpoint before bootstrap or startup. Use the exact [deployment checkpoint procedure](storage-ingestion-and-publication.md#current-atomic-split-volume-backup-and-restore); a failed capture keeps production stopped:

```powershell
docker compose --file compose.prod.yaml --profile tools run --rm storage-cleanup
$env:STORAGE_BACKUP_HELPER_IMAGE = 'registry.example.invalid/pale-orbit@sha256:<audited-digest>'
npm run deployment:checkpoint -- capture --project <exact-project> --root <empty-restricted-absolute-backup-directory> --context <approved-context> --engine-id <expected-engine-id> --backup-id <32-lowercase-hex-id>
npm run deployment:checkpoint -- rehearse --root <exact-restricted-absolute-backup-directory> --context <approved-distinct-restore-context> --engine-id <expected-distinct-restore-engine-id> --backup-id <same-32-lowercase-hex-id>
docker compose --file compose.prod.yaml --profile tools run --rm bootstrap-admin
docker compose --file compose.prod.yaml up --detach --wait
```

For a rollout from the former web-backed cleanup command, give this provisioning run a fresh `DATABASE_PASSWORD`; successful provisioning rotates the web login and invalidates the credential retained by any retired cleanup process. After provisioning and the dedicated cleanup dry-run succeed, rotate the formerly shared owner password through the managed PostgreSQL control plane and update `database_owner_password` in the secret manager before starting the new containers. Keep the web, worker, and cleanup passwords pairwise distinct from it and from each other; each rotation is deployed through only its scoped secret.

Do not start the new web or worker containers if migration exits nonzero. The resolver lockdown is committed before the remaining migrations, so a later migration failure is intentionally **forward-fix-only**: do not restart the old worker, inspect the migration/preflight diagnostic, correct the database condition, and rerun the same immutable image. Re-running the same committed migration set is safe because Drizzle records applied migrations in `drizzle.__drizzle_migrations`. The administrator bootstrap is also idempotent and must use the bootstrap-only process secret documented in [authentication and email operations](authentication-and-email.md).

Check the deployment:

```powershell
docker compose --file compose.prod.yaml ps
docker compose --file compose.prod.yaml logs --tail 100 app worker postgres caddy
```

`/health/live` proves only the web process responds. `/health/ready` performs bounded PostgreSQL and storage probes. Worker health proves the worker completed its initial dependency probes and entered the polling loop. The unified financial and reporting implementation is a review candidate only. Production storefront and API paths remain in maintenance mode, the global Sales link remains disabled, and Plan 7 owns launch. The base production stack keeps Stripe disabled and requires no Stripe credential.

## Job behavior

Workers claim one job at a time with `FOR UPDATE SKIP LOCKED`. A lease timestamp makes work recoverable after a process crash. Each claim increments attempts. Transient failures return to `pending` with bounded exponential delay; permanent or exhausted work moves to `failed` for the future admin operations view.

Handlers persist only deliberately safe error text. The outbox pairs a message and dispatch job in the caller's transaction and delivers at least once. A message already recorded as delivered is not sent again on ordinary job replay, while topic handlers remain responsible for the crash window between an external side effect and the `deliveredAt` update.

Revision-ingestion jobs copy accepted sources to immutable original keys, produce deterministic derived assets, and commit a generation only while it is still current. Transient storage/database/timeout failures retry automatically; permanent archive/content failures require an administrator retry only when the staged source is still intact, or a new immutable upload. See [storage, ingestion, publication, and recovery](storage-ingestion-and-publication.md) for cleanup, capacity, backup, and restore operations.

Authentication email uses the versioned `email.auth.v1` topic and a stable Message-ID. Better Auth creates a signed email-verification token before its awaited callback stores a one-use SHA-256 digest marker and then creates the project outbox transaction. Those callback writes are separate transaction boundaries; the endpoint succeeds only after the outbox write is durable. See the authentication runbook for delivery and safe-troubleshooting details.

Commerce webhook acceptance inserts a minimized `stripe_events` row and a deduplicated `commerce.stripe-event` job in one transaction. The handler retrieves canonical Stripe state without holding a PostgreSQL connection, then uses ordered short transactions for payment/refund/dispute reduction, `entitlement_grants` and effective `entitlements`, `email.commerce.v1` outbox messages, minimized audit events, and final event status. Duplicate/out-of-order jobs converge on canonical state. Guest claim preparation uses `commerce.claim-email` and enumeration-resistant requests use `commerce.claim-email-request`.

The Plan 6B worker registers four strict job families: `commerce.financial-source` for payment/refund/dispute evidence, `commerce.financial-payout` for canonical payout lifecycle and membership import, `commerce.financial-scan` for bounded roots/continuations/impact work, and `commerce.financial-classification` for one durable subject under the active classifier/allocation versions. Administrator mutations enter as owner-scoped web-submitted commands and execute only under worker authority. Event reducers enqueue source or payout work in the transaction that commits the corresponding local fact. Every provider retrieval or listing call runs outside an active database transaction; short staging, import-run, checkpoint, and reconciliation transactions may occur between provider calls.

In fixture or Stripe mode, the poll hook converges concurrent workers on an initial root plus one permanent UTC-hour root. Initial payout discovery starts seven days before the earliest local paid order; hourly discovery overlaps 72 hours. Each root processes at most 100 local resources or one provider page before it persists a checkpoint and hands off a continuation. A distinct composite classifier/allocation-version root also runs against local evidence and is allowed while Stripe is disabled; provider roots are not. While a newer classifier/allocation target is pending, Stripe events, financial source/payout work, and provider scan roots or continuations remain unclaimed; only the exact pending implementation may claim its local replay children and finalizer, while unrelated local jobs continue normally. A non-succeeded exact-active parent classification job is a version-scoped invalidation marker that makes the selected active heads incomplete; pending replay rechecks graph freshness under projection enrollment, does not execute or wait on the old implementation, and may build a root when the active pair is already missing. After activation, the deployed worker may claim strictly componentwise-superseded classification markers and authority-no-op them before any decision or allocation write. An open non-informational issue on the exact selected allocation set overrides the marker code and also makes that projection head incomplete. Replay classification/correction failures are scoped to those exact target sets; the Balance Transaction `classification_fork` signal is reserved for multiple global allocation tips. An unknown classifier result opens a permanent historical `unsupported_category` issue on that immutable classification-row ID, so current diagnostics must filter to the singleton active classifier and current subject fingerprint. Matching provider workers resume the retained work after activation. Source/payout jobs allow 12 attempts, scan jobs 8, and classification jobs 5. Exhausted transient resources stay pending for a later hour, payout generation, or classifier version; permanent evidence conflicts remain open issues. Do not repair jobs, checkpoints, classifications, ledger rows, allocations, memberships, or issues with direct SQL.

Exact payout membership is published only after complete filtered pagination for a currently paid automatic standard payout with reconciliation completed. Manual and instant payouts keep complete fee evidence but no invented membership. Payout publication/failure increments a generation and enqueues bounded source-impact work, so derived state is not a stale cached flag. See [Stripe financial reconciliation](stripe-financial-reconciliation.md) for safe diagnosis, backup/restore order, and invariant checks.

Safe operations may inspect IDs, types/topics, status, attempts, reconciliation state, and timestamps. Do not select job/outbox payloads, purchase emails, action URLs, webhook signatures, raw provider bodies, credential-authority hashes/reset epochs, secrets, or card/address data. Credential-authority integrity diagnostics return aggregate mismatch counts only and never repair state by copying the live account hash. Preserve failed jobs and event exceptions for review; Plan 7 owns an authorized retry control. See [commerce and guest-claim operations](commerce-and-guest-claims.md).

## Scope of later plans

- Plan 3 registered authentication email outbox topics, integrated Better Auth, and mapped sessions/roles to the actor policy.
- Plan 4 added storage/ingestion jobs, revision lifecycle transitions, and bounded storage cleanup.
- Plan 5 added the six entitlement/reader-state tables and semantic fingerprint columns. Reader migration is synchronous under ordered transaction locks; it is not a worker job.
- Plan 6A added Stripe reconciliation, commerce email/claim jobs, purchase grants, and refund/dispute access reduction.
- The Plan 6B candidate combines financial ingestion/reconciliation with administrator resolution and reporting while its global navigation remains disabled pending independent review.
- Plan 7 adds production activation, failed-job administration, structured logging, queue-age monitoring, scheduled off-host backups, and final pool/capacity tuning.
