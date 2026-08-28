# Database and workers

**Status:** Plan 6B complete; Plan 7A Checkpoints A-C implemented

The current migration chain ends at `0015_plan7a_operations_authority`, and the executable verifier is `plan7a-database-catalog-v1`. Historically, the completed unified Plan 6B implementation ended at `0014`: migration `0012` retained its eight callable public boundary routines, `0013` added only the correction-resolution routine, and `0014` changed no callable surface while replacing the nullable issue-transition trigger guard with a fail-closed definition. Plan 7A Checkpoint C is now implemented, but Checkpoint D is not. The protected global Sales link and direct routes are live for authorized administrators, while production remains maintenance-only and Stripe-disabled. See [financial reconciliation and reporting](financial-reconciliation-and-reporting.md) for the financial operator boundary.

## Ownership

Drizzle schema files under `src/lib/server/db/schema/` are the database model source of truth. Generated SQL and snapshots under `drizzle/` are committed and reviewed. Never use `drizzle-kit push` against shared or production databases.

The web process, migration command, worker, and storage-cleanup command each own a bounded node-postgres pool. The web process uses PostgreSQL for readiness. The worker claims durable jobs from PostgreSQL, dispatches transactional outbox messages, ingests revision sources from private object storage, reduces accepted `stripe_events`, prepares guest-claim email, and runs bounded financial source, payout, scan, and classification work. PostgreSQL owns the queue, durable cursors, version checkpoint, locks, financial issues, and immutable ledger history; Redis is not part of the current topology.

Plan 6B financial relations are read-only to the web. The web principal can submit allowlisted administrator commands, read only its owner-scoped status, and append the route-authorized audit boundary through the exact public routines; it cannot execute their protected mutations. The financial worker alone receives the exact routine and `INSERT`/`UPDATE` authority used by source, payout, scan, classification, allocation, correction, and issue publication; neither runtime role receives `DELETE`. The same boundary covers canonical `payments`, `refunds`, `refund_allocations`, and `disputes`. Webhook intake can append only the immutable provider-identity columns of `stripe_events`; database defaults create pending/unprocessed state and only the worker can update completion. New public tables receive SELECT-only default privileges for the web role, so adding a financial table requires an explicit reviewed worker grant rather than silently inheriting web writes.

Plan 7A Checkpoint C adds a backend-only list/submit/status surface protected by `jobs.retry` and current-role reauthorization. Operations capabilities are per-claim, memory/transaction-local only, and digest-persisted; they are not environment secrets. Financial-admin and revision-ingestion authorities remain separate from that operations authority. Command, audit, and restore authority is exact, and command history is retained rather than deleted or rewritten.

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

The web service is at `http://localhost:5173`; Mailpit is at `http://localhost:8025`. The worker has no published port. Its Compose health check runs the stateless source validator against `/tmp/worker-ready`; the file is the version-1 freshness record described below, not an opaque startup marker.

The long-running app and worker receive only their own database credentials. Compose also mounts the deliberately empty [`deploy/container.env`](../deploy/container.env) over `/app/.env`, so the source-tree bind mount cannot expose the host `.env` to either process. Migration, role provisioning, bootstrap, and cleanup remain bounded one-shot services with only the credentials each command requires.

## Structured diagnostics and worker freshness

Checkpoint B application logs use schema version `1` and newline-delimited JSON (NDJSON) written only to local standard output or standard error. The web producer emits `http.request.completed`, `http.request.rejected`, and `http.request.failed`. The worker producer emits `worker.started`, `worker.ready`, `worker.stopping`, `worker.stopped`, `worker.failed`, and `worker.heartbeat_failed`; claimed attempts emit `job.claimed`, `job.succeeded`, `job.failed`, and `job.lease_lost`. Those web, worker, and job events are the fixed Checkpoint B adoption boundary. The shared smoke schemas are defined and tested, but smoke emission and generalized release evidence remain deferred to Checkpoint D. No remote log transport, monitor store, metrics endpoint, dashboard, alert rule, or alert delivery is implemented.

At web ingress, only the `x-request-id` header is considered. A value matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$` remains the diagnostic correlation identifier; a missing or invalid value is replaced with a generated lowercase UUID and is not echoed in a response header. Correlation is never an authorization or idempotency input. The HTTP lifecycle record uses a static or normalized SvelteKit route identifier and never logs a URL, query string, request or response body, raw header, or raw error or stack.

`WORKER_READY_FILE` retains its configuration name and path ownership, but its contents are no longer an opaque nonempty marker. The canonical version-1 JSON record contains only `version`, `workerId`, `processStartedAt`, `publishedAt`, `sequence`, `configuredSlots`, and `slots`. Each slot contains only `slotId`, `state`, `lastSuccessfulPollAt`, and `lastProgressAt`. Slots are zero-based, and every configured slot appears exactly once. `polling` means the slot is preparing or attempting its next queue claim, including waiting to enter or executing the serialized before-poll hook; `idle` means it owns no claimed job after an empty poll, terminal settlement, or lease loss; and `handling` means it owns a claimed job.

A successful poll, including an empty poll, advances both timestamps. While a job is in `handling`, a successful lease renewal advances `lastProgressAt` without changing `lastSuccessfulPollAt`; successful terminal settlement advances `lastProgressAt` and returns the slot to `idle`. Lease loss returns the slot to `idle` without advancing progress. Merely awaiting a handler is not progress; a long-running handler remains fresh only while successful lease renewals continue.

Before resource assembly, the supervisor removes only the configured target and its `.tmp` sibling. No heartbeat exists and `worker.ready` is not emitted until dependency probes succeed, every configured slot completes its first successful poll, and the first atomic publication succeeds. Each serialized publication writes and syncs a mode-`0600` sibling, closes it, and renames it over the target. It uses a same-directory temporary sibling formed as `${WORKER_READY_FILE}.tmp`, so failed partial writes never replace the accepted record. For transient Windows replacement contention, the sole retry exception repeats only that same final rename of the already-written, synced, and closed sibling when safe inspection finds an own data `code` of exactly `EPERM`, `EACCES`, or `EBUSY`. One monotonic deadline, set before the first rename and limited to the smaller of the heartbeat interval and 1,000 milliseconds, permits abort-aware waits of at most 10 milliseconds capped to the remaining time. The retry never reopens or rewrites the sibling, changes the record, sequence, timestamp, or path, or deletes or truncates the target; the previous accepted target remains coherent throughout.

Encoding, opening, writing, syncing, closing, nontransient rename, exhausted transient-rename retry, invalid retry-clock handling, active retry-wait, or continued-publication failure emits one `worker.heartbeat_failed`, aborts worker activity, and exits nonzero. A signal abort or supervisor seal during the bounded rename retry is normal publisher settlement with best-effort temporary removal; final ordered evidence removal remains authoritative. Fatal shutdown waits for the runner and publisher, seals further progress, removes the target and temporary evidence, and then closes email and database clients in reverse registration order. The whole fatal settlement and cleanup attempt lasts at most 10 seconds; if it wedges, the process force-exits with status `1`. That deadline is fatal-path-only; normal `SIGINT` or `SIGTERM` retains the Compose 30-second stop grace and performs the same ordered evidence removal before clients close.

The validator treats missing, malformed, stale, too-far-future, wrong-slot-count, missing-slot, or stale-slot evidence as unhealthy. It rejects nonregular, empty, size-changed-during-read, or oversized files, with a 65,536-byte maximum and a fixed 5,000-millisecond future tolerance. The stateless health executable does not read or require database credentials and has no network endpoint or public response; application `/health/ready` remains web-only and does not disclose worker state.

For a host-run or development environment, run `npm run worker:health`. Development Compose invokes `node --import tsx src/worker-health.ts`; the production image invokes `node build/services/worker-health.js`. Compose does not restart a container merely because it is unhealthy. In production, fatal publisher failure exits nonzero under `restart: unless-stopped`, allowing Docker to replace the failed worker.

Plan 7A Checkpoint C adds the closed operations catalog and backend authority without adding an operations UI or activation input. Monitoring and alert transport, generalized release evidence, production-live mode, and Stripe enablement remain later-checkpoint work.

## Tests

`npm test`, `npm run test:unit`, and `npm run test:watch` are hermetic. They do not start Docker, PostgreSQL, browsers, network services, or the financial restore witness:

```powershell
npm run test:unit
```

`npm run test:service` runs the single Docker/PostgreSQL financial restore/commerce witness. That lane preserves the bounded supervisor, unique Compose-project and temporary-storage ownership, exact Compose-path and label checks, process-tree termination, and teardown absence proof. On Windows, invoke the service lane through npm because the direct Node supervisor requires the inherited `npm_execpath`.

Integration and Playwright commands start a uniquely named PostgreSQL 18.4 Compose project, ask Docker for a random loopback port, apply committed migrations, run the requested tests, and remove the test containers, network, and tmpfs data:

```powershell
npm run test:integration
npm run test:e2e
npm run test:database
npm run test:plan6b-upgrade
```

`npm run test:database` does not include `npm run test:service`; integration and E2E keep their existing, uniquely disposable environments. The release gate remains `check -> lint -> unit -> service -> integration/E2E -> build`.

`npm run verify` runs integration and browser suites in separate disposable Compose projects. Browser tests additionally start the real worker and bootstrap a test administrator so email delivery, ingestion, role authorization, commerce fulfillment/claims, customer downloads, and revision migration use production-shaped paths. The commerce harness uses a provider-neutral fixture only in `APP_ENV=test`, with provider secrets stripped from child environments; it exposes no application route that marks an order paid. Financial fixture tests exercise the same source, payout, scheduler, and classifier handlers without real Stripe credentials or network access. The harness creates a unique temporary local-storage root and removes only that verified path. Direct preserved-access fixtures reject non-loopback or non-test databases and exist only under `tests/e2e`; they are not production grant controls. The Plan 6B upgrade command uses its own uniquely identified disposable PostgreSQL Compose project to execute every supported prior-schema fixture through the committed migration.

## Production deployment order

The current release-evidence order is exact: migrate through `0015_plan7a_operations_authority`, provision and attest the four principals, run the `plan7a-database-catalog-v1` executable verifier as part of checkpoint capture, rehearse on a distinct database engine, then run the production-image smoke. A later step cannot substitute for or precede an earlier one.

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

`/health/live` proves only the web process responds. `/health/ready` performs bounded PostgreSQL and storage probes. `node build/services/worker-health.js` validates the worker's private heartbeat record: the first healthy record implies the initial dependency probes and every slot's first successful poll completed, while subsequent checks require publication and every slot's progress to remain fresh. The unified financial and reporting implementation is complete, and the protected global Sales link is live for authorized administrators. Production storefront and API paths must remain in `APPLICATION_MODE=maintenance`; the base production stack keeps Stripe disabled and requires no Stripe credential.

## Job behavior

Workers claim one job at a time with `FOR UPDATE SKIP LOCKED`. A lease timestamp makes work recoverable after a process crash. Each claim increments attempts. Transient failures return to `pending` with bounded exponential delay; permanent or exhausted work moves to `failed` for the future admin operations view.

The closed catalog contains exactly eleven production job kinds. Only pending Stripe-event rearm and exact financial-classification rearm are enabled; all other initial policies return disabled/excluded fixed results. No generic job reset, no delivered-outbox redelivery, no recursive command retry, and no general ingestion retry exists. No provider call occurs during operations retry.

Handlers persist only deliberately safe error text. The outbox pairs a message and dispatch job in the caller's transaction and delivers at least once. A message already recorded as delivered is not sent again on ordinary job replay, while topic handlers remain responsible for the crash window between an external side effect and the `deliveredAt` update.

Revision-ingestion jobs copy accepted sources to immutable original keys, produce deterministic derived assets, and commit a generation only while it is still current. Transient storage/database/timeout failures retry automatically; permanent archive/content failures require an administrator retry only when the staged source is still intact, or a new immutable upload. See [storage, ingestion, publication, and recovery](storage-ingestion-and-publication.md) for cleanup, capacity, backup, and restore operations.

Authentication email uses the versioned `email.auth.v1` topic and a stable Message-ID. Better Auth creates a signed email-verification token before its awaited callback stores a one-use SHA-256 digest marker and then creates the project outbox transaction. Those callback writes are separate transaction boundaries; the endpoint succeeds only after the outbox write is durable. See the authentication runbook for delivery and safe-troubleshooting details.

Commerce webhook acceptance inserts a minimized `stripe_events` row and a deduplicated `commerce.stripe-event` job in one transaction. The handler retrieves canonical Stripe state without holding a PostgreSQL connection, then uses ordered short transactions for payment/refund/dispute reduction, `entitlement_grants` and effective `entitlements`, `email.commerce.v1` outbox messages, minimized audit events, and final event status. Duplicate/out-of-order jobs converge on canonical state. Guest claim preparation uses `commerce.claim-email` and enumeration-resistant requests use `commerce.claim-email-request`.

The Plan 6B worker registers four strict job families: `commerce.financial-source` for payment/refund/dispute evidence, `commerce.financial-payout` for canonical payout lifecycle and membership import, `commerce.financial-scan` for bounded roots/continuations/impact work, and `commerce.financial-classification` for one durable subject under the active classifier/allocation versions. Administrator mutations enter as owner-scoped web-submitted commands and execute only under worker authority. Event reducers enqueue source or payout work in the transaction that commits the corresponding local fact. Every provider retrieval or listing call runs outside an active database transaction; short staging, import-run, checkpoint, and reconciliation transactions may occur between provider calls.

In fixture or Stripe mode, the poll hook converges concurrent workers on an initial root plus one permanent UTC-hour root. Initial payout discovery starts seven days before the earliest local paid order; hourly discovery overlaps 72 hours. Each root processes at most 100 local resources or one provider page before it persists a checkpoint and hands off a continuation. A distinct composite classifier/allocation-version root also runs against local evidence and is allowed while Stripe is disabled; provider roots are not. While a newer classifier/allocation target is pending, Stripe events, financial source/payout work, and provider scan roots or continuations remain unclaimed; only the exact pending implementation may claim its local replay children and finalizer, while unrelated local jobs continue normally. A non-succeeded exact-active parent classification job is a version-scoped invalidation marker that makes the selected active heads incomplete; pending replay rechecks graph freshness under projection enrollment, does not execute or wait on the old implementation, and may build a root when the active pair is already missing. After activation, the deployed worker may claim strictly componentwise-superseded classification markers and authority-no-op them before any decision or allocation write. An open non-informational issue on the exact selected allocation set overrides the marker code and also makes that projection head incomplete. Replay classification/correction failures are scoped to those exact target sets; the Balance Transaction `classification_fork` signal is reserved for multiple global allocation tips. An unknown classifier result opens a permanent historical `unsupported_category` issue on that immutable classification-row ID, so current diagnostics must filter to the singleton active classifier and current subject fingerprint. Matching provider workers resume the retained work after activation. Source/payout jobs allow 12 attempts, scan jobs 8, and classification jobs 5. Exhausted transient resources stay pending for a later hour, payout generation, or classifier version; permanent evidence conflicts remain open issues. Do not repair jobs, checkpoints, classifications, ledger rows, allocations, memberships, or issues with direct SQL.

Exact payout membership is published only after complete filtered pagination for a currently paid automatic standard payout with reconciliation completed. Manual and instant payouts keep complete fee evidence but no invented membership. Payout publication/failure increments a generation and enqueues bounded source-impact work, so derived state is not a stale cached flag. See [Stripe financial reconciliation](stripe-financial-reconciliation.md) for safe diagnosis, backup/restore order, and invariant checks.

Safe operations may inspect IDs, types/topics, status, attempts, reconciliation state, and timestamps. Do not select job/outbox payloads, purchase emails, action URLs, webhook signatures, raw provider bodies, credential-authority hashes/reset epochs, secrets, or card/address data. Credential-authority integrity diagnostics return aggregate mismatch counts only and never repair state by copying the live account hash. Preserve failed jobs and event exceptions for review and escalation; the bounded backend retry policy has no operator caller, so never alter job attempts or status directly. See [commerce and guest-claim operations](commerce-and-guest-claims.md).

## Scope of later plans

- Plan 3 registered authentication email outbox topics, integrated Better Auth, and mapped sessions/roles to the actor policy.
- Plan 4 added storage/ingestion jobs, revision lifecycle transitions, and bounded storage cleanup.
- Plan 5 added the six entitlement/reader-state tables and semantic fingerprint columns. Reader migration is synchronous under ordered transaction locks; it is not a worker job.
- Plan 6A added Stripe reconciliation, commerce email/claim jobs, purchase grants, and refund/dispute access reduction.
- Plan 6B combines completed financial ingestion/reconciliation with administrator resolution and reporting, and its protected global Sales link is live.
- Plan 7A Checkpoints A-C added dependency/test boundaries, structured logging, diagnostic correlation, worker freshness, and the bounded backend operations authority. No operations route, page, navigation, polling, or button exists. Monitoring/alerts, generalized stage evidence, production-live activation, Stripe enablement, fresh release-candidate capture, and Checkpoint D remain deferred.
