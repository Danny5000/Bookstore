# Runtime environments

## Scope

The repository supplies a development environment and a production infrastructure baseline. Authentication, administration, PostgreSQL catalog data, private publication storage, ingestion, Stripe commerce, guest claims, entitlement grants, customer libraries, reader state, entitled original downloads, and local financial reconciliation are durable. Stripe is disabled by default.

**Status:** Plan 6B candidate — independent review pending

The unified candidate includes ingestion/reconciliation and the direct administrator Sales, review, payout, correction, recovery, and CSV surfaces. The global navigation remains `Sales — Upcoming` without a live link. Production intentionally remains in maintenance mode and Plan 7 owns activation and operability. The migration chain ends at `0014`: `0012` retains the historical eight callable public boundary routines, `0013` adds the final ninth, and `0014` changes no callable surface while replacing the nullable issue-transition trigger guard with a fail-closed definition. See [financial reconciliation and reporting](financial-reconciliation-and-reporting.md).

## Required toolchain

- Node.js 26.7.x
- npm 11.19.x
- Docker Engine 27 or newer
- Docker Compose 2.30 or newer

The application image and local tooling use the same Node 26.7/npm 11.19 line.

## Host-run development

Copy `.env.example` to the ignored `.env`, install dependencies, start PostgreSQL and Mailpit, apply migrations, then run Vite and the worker on the host in separate terminals:

```powershell
Copy-Item .env.example .env
npm ci
docker compose --env-file .env --file compose.dev.yaml up postgres mailpit --detach --wait
npm run db:migrate
npm run admin:bootstrap
npm run dev
```

```powershell
npm run worker:watch
```

The storefront is at `http://localhost:5173` and Mailpit is at `http://localhost:8025`. The host-run app and worker use `DATABASE_HOST=localhost` and the ignored `.data/storage-staging`, `.data/storage-publication`, and `.data/storage-covers` roots from `.env`. Verified-read scratch uses a newly owned per-process directory under the operating-system temporary directory unless an absolute `STORAGE_SCRATCH_ROOT` is explicitly configured.

Stop the service containers without deleting PostgreSQL data:

```powershell
docker compose --env-file .env --file compose.dev.yaml down
```

## Fully containerized development

After creating `.env`, run the explicit migration profile, then start the source-mounted app and worker with PostgreSQL and Mailpit:

```powershell
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm database-role-provision
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm bootstrap-admin
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

The development topology contains the app, worker, PostgreSQL, and Mailpit. The Compose application processes override `DATABASE_HOST` and `SMTP_HOST` to the internal service names `postgres` and `mailpit`. They mount the staging and covers directories read-write; the app mounts publication read-only while the worker and cleanup tool mount it read-write. Each process uses ephemeral `/tmp` verified-read scratch. Source changes are served by Vite from the bind mount. Dependencies remain in the named `app_node_modules` volume. The worker is private to Compose and publishes no port. `bootstrap-admin`, migrations, and storage cleanup are one-shot tools and do not start with the ordinary stack.

The loopback bindings default to app `5173`, PostgreSQL `5432`, SMTP `1025`, and Mailpit HTTP `8025`. A parallel worktree can set `DEV_APP_PORT`, `DEV_DATABASE_PORT`, `DEV_SMTP_PORT`, and `DEV_MAILPIT_HTTP_PORT` in its ignored `.env`; set `ORIGIN` to the matching app URL.

Stop the stack while retaining PostgreSQL data:

```powershell
docker compose --env-file .env --file compose.dev.yaml down
```

Delete the local PostgreSQL and container-node_modules volumes only when a clean development reset is intentional:

```powershell
docker compose --env-file .env --file compose.dev.yaml down --volumes
```

## Configuration contract

| Setting | Development | Production baseline | Sensitive |
| --- | --- | --- | --- |
| `APP_ENV` | `development` | Compose fixes `production` | No |
| `APPLICATION_MODE` | `prototype` | Compose fixes `maintenance` | No |
| `ORIGIN` | `http://localhost:5173` | Public HTTPS origin | No |
| `DATABASE_HOST` | `localhost` or Compose `postgres` | Compose fixes `postgres` | No |
| `DATABASE_PORT` | `5432` | Compose fixes `5432` | No |
| `DATABASE_NAME` | `.env` | Deployment-process environment | No |
| `DATABASE_OWNER_USER`, `DATABASE_OWNER_PASSWORD` | `.env`; migration and role provisioning only | Deployment-process environment; password converted to an owner-only Compose secret | Password only |
| `DATABASE_USER`, `DATABASE_PASSWORD` | `.env`; app and ordinary tools | Deployment-process environment; password converted to the web-runtime Compose secret | Password only |
| `DATABASE_WORKER_USER`, `DATABASE_WORKER_PASSWORD` | `.env`; financial worker only | Deployment-process environment; password converted to the worker-only Compose secret | Password only |
| `DATABASE_STORAGE_CLEANUP_USER`, `DATABASE_STORAGE_CLEANUP_PASSWORD` | `.env`; storage cleanup only | Deployment-process environment; password converted to the cleanup-only Compose secret | Password only |
| `AUTH_SECRET` | `.env` development value | Deployment-process environment converted to a Compose secret | Yes |
| Auth lifetimes/rate limits | `.env` | Deployment-process environment or documented Compose defaults | No |
| SMTP host, port, TLS mode, user, from | Mailpit/local values in `.env`; credentials are loaded only by the worker | Required deployment-process environment; only the worker receives the user | User may identify a provider account |
| `SMTP_PASSWORD` | Omitted for Mailpit | Deployment-process environment converted to a worker-only Compose secret | Yes |
| `STORAGE_PROVIDER` | `local` | `local` until the future adapter is implemented | No |
| `STORAGE_STAGING_ROOT` | `.data/storage-staging` or Compose private mount | Compose fixes `/var/lib/pale-orbit/staging` | No |
| `STORAGE_PUBLICATION_ROOT` | `.data/storage-publication`; read-only in the web container | Compose fixes `/var/lib/pale-orbit/publication`; read-only in web | No |
| `STORAGE_COVERS_ROOT` | `.data/storage-covers` or Compose private mount | Compose fixes `/var/lib/pale-orbit/covers` | No |
| `STORAGE_SCRATCH_ROOT` | Optional absolute parent; otherwise OS temporary storage | Compose fixes an ephemeral `/tmp` path | No |
| Upload/ingestion bounds | `.env` | Deployment-process environment or documented Compose defaults | No |
| Storage retention hours | `.env` | Deployment-process environment or documented Compose defaults | No |
| `WORKER_CONCURRENCY` | `.env` | Deployment-process environment or documented Compose default | No |
| Stripe enabled/fixture/live flags | Disabled/false/false in `.env` | Base Compose fixes disabled/false/false | No |
| Stripe API version | Application pin `2026-07-29.dahlia` | Same immutable application pin | No |
| Checkout duration/webhook tolerance | `1800` / `300` seconds | Deployment-process environment or documented Compose defaults | No |
| Automatic tax and format tax codes | Off; optional local values | Deployment-process environment; both codes required when enabled | No |
| Checkout rate-limit window/max | `.env` | Deployment-process environment or documented Compose defaults | No |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Omitted/empty while disabled; ignored `.env` only for manual test mode | Deployment-process environment converted by the opt-in overlay to Compose secrets | Yes |
| Bootstrap email/name | `.env`, explicit tool only | Deployment-process environment, explicit tool only | No |
| `BOOTSTRAP_ADMIN_PASSWORD` | `.env`, explicit tool only | Deployment-process environment converted to a bootstrap-only secret | Yes |

Every required value also supports a mutually exclusive `<NAME>_FILE` form. Production uses `DATABASE_OWNER_PASSWORD_FILE`, `DATABASE_PASSWORD_FILE`, `DATABASE_WORKER_PASSWORD_FILE`, `DATABASE_STORAGE_CLEANUP_PASSWORD_FILE`, `AUTH_SECRET_FILE`, and `SMTP_PASSWORD_FILE` under `/run/secrets`; the bootstrap tool also uses `BOOTSTRAP_ADMIN_PASSWORD_FILE`. The owner secret reaches only PostgreSQL, migration, and role provisioning. Migration loads database settings only. Bootstrap receives the web database login and bootstrap identity inputs only. The app uses the web login, the worker alone uses the worker login and SMTP credentials, and storage cleanup receives only its dedicated login. Role provisioning is the sole application service that receives all four database credentials. The Stripe overlay gives the app its webhook-verification secret and gives both app and worker the API secret; the worker never receives the webhook secret. Each scoped loader fails when one of its own values is missing, empty, invalid, or supplied both directly and through `_FILE`, without reading secrets assigned to another process.

## Production baseline

Keep the Plan 6B evidence order exact: migrate through `0014`, provision and attest the four pairwise-distinct owner/web/financial-worker/storage-cleanup principals, capture the checkpoint, rehearse it on a distinct database engine, then run the production-image smoke. The web principal submits commands, reads its owner-scoped status, and records route-authorized audit evidence; only the financial-worker principal executes protected financial mutations.

Production does not use an environment file. The deployment process exports the image/origin/database values, a generated `AUTH_SECRET`, provider SMTP values, and the first-administrator values. See [authentication and email operations](authentication-and-email.md) for that contract, [commerce and guest-claim operations](commerce-and-guest-claims.md) for Stripe Checkout/webhooks, and [Stripe financial reconciliation](stripe-financial-reconciliation.md) for ledger and worker recovery. Base production requires no Stripe credentials and keeps `STRIPE_ENABLED=false`. Then run:

```powershell
docker compose --file compose.prod.yaml config --quiet
docker compose --file compose.prod.yaml --profile tools stop app worker storage-cleanup
docker compose --file compose.prod.yaml --profile tools run --rm migrate
docker compose --file compose.prod.yaml --profile tools run --rm database-role-provision
```

Before cleanup, bootstrap, or startup, resolve the storage-layout gate. A first rollout from the legacy `book_storage` volume must complete the [split-volume upgrade](storage-ingestion-and-publication.md#split-volume-upgrade) and retain its verified report:

```powershell
docker compose --file compose.prod.yaml --profile tools rm --force app worker storage-cleanup
$env:STORAGE_MIGRATION_HELPER_IMAGE = 'registry.example.invalid/approved-storage-helper@sha256:<audited-digest>'
npm run storage:migrate-volumes -- --project <exact-project> --report <restricted-absolute-report-path>
```

Skip that migration command for an already-split deployment only when its current three-volume layout and prior migration report were verified. A brand-new installation may also skip only after the exact legacy `book_storage` volume is verified absent and the freshly initialized database is verified to contain no storage-referencing application data; establish this before bootstrap, uploads, or publication. An empty new volume or a readiness sentinel is not migration evidence. You must not run `storage-cleanup`, bootstrap, or either long-running process until the legacy migration report succeeds or one of those two verified exceptions is established.

After that gate, provision/verify the sentinel through the cleanup dry-run and create the required current-v3 atomic checkpoint before bootstrap or startup. Follow the exact [deployment checkpoint procedure](storage-ingestion-and-publication.md#current-atomic-split-volume-backup-and-restore); a failed capture keeps production stopped:

```powershell
docker compose --file compose.prod.yaml --profile tools run --rm storage-cleanup
$env:STORAGE_BACKUP_HELPER_IMAGE = 'registry.example.invalid/pale-orbit@sha256:<audited-digest>'
npm run deployment:checkpoint -- capture --project <exact-project> --root <empty-restricted-absolute-backup-directory> --context <approved-context> --engine-id <expected-engine-id> --backup-id <32-lowercase-hex-id>
npm run deployment:checkpoint -- rehearse --root <exact-restricted-absolute-backup-directory> --context <approved-distinct-restore-context> --engine-id <expected-distinct-restore-engine-id> --backup-id <same-32-lowercase-hex-id>
docker compose --file compose.prod.yaml --profile tools run --rm bootstrap-admin
docker compose --file compose.prod.yaml up --detach --wait
```

The production topology contains the app, worker, PostgreSQL, and Caddy. `APP_IMAGE` must identify the already-built immutable application image. Quiesce any old cleanup process first. Migration must succeed before role provisioning creates or rotates the constrained web, worker, and cleanup logins; exercise cleanup in dry-run mode before bootstrap or either long-running process starts. The first dedicated-cleanup rollout must supply a fresh web password to role provisioning because the retired cleanup command held the previous web credential. Caddy is the only service with published ports. PostgreSQL persists in `postgres_data`; private books persist in `book_staging`, `book_publication`, and `book_covers`. Publication is read-only in the app and read-write in the worker and cleanup tool; staging and covers are read-write in all three. Caddy, migration, and bootstrap receive no storage mount. Database, auth, SMTP, bootstrap, and Stripe secrets are mounted only into the processes that need them. None is stored in a production `.env` file. Follow the split-volume upgrade and atomic backup/restore procedures in [storage, ingestion, publication, and recovery](storage-ingestion-and-publication.md); legacy `book_storage` is never an implicit current-runtime fallback.

Plan 6B financial relations are read-only to the web. Exact public routines allow the web role to submit an authorized command, read only its owner-scoped status, and append the route audit boundary without gaining mutation authority. The worker role has only the routine and relation-specific `INSERT` and `UPDATE` actions used by financial processing, while both roles lack financial `DELETE`. Stripe webhook intake is a column-limited append, and only the worker updates event completion. SELECT-only default privileges apply to future public tables; every new worker mutation therefore requires an explicit migration and provisioner allowlist update.

For a deliberate future test-mode checkpoint, supply both Stripe values from protected process memory and add the explicit overlay:

```powershell
docker compose --file compose.prod.yaml --file compose.stripe.yaml config --quiet
npm run stripe:preflight
docker compose --file compose.prod.yaml --file compose.stripe.yaml up --detach --wait
```

`docker compose config` verifies the merged structure, but it does not verify that environment-backed secret values are present. The Node.js-based `npm run stripe:preflight` command exits nonzero when either Stripe variable is missing or empty and never prints either value. Run it before any Stripe-overlay container-creation command. A Docker-only Linux VPS without host Node.js can use the nonprinting POSIX-shell equivalent in [commerce and guest-claim operations](commerce-and-guest-claims.md).

`compose.stripe.yaml` mounts the API secret into app and worker, but mounts the webhook-verification secret only into app, against the pinned `2026-07-29.dahlia` API version. The app owns Checkout and webhook acceptance; the worker owns canonical source/payout retrieval and hourly recovery and cannot verify inbound webhooks. The overlay adds no service, port, Redis dependency, or credential to migration/bootstrap/storage-cleanup/Caddy/PostgreSQL. Provider calls finish outside financial database transactions. It does not alter `APPLICATION_MODE=maintenance`, live mode, or the existing database/auth/SMTP secret mounts, and it is not a storefront launch switch.

With the base runtime disabled, provider scan roots are not scheduled and the disabled gateway cannot perform source or payout retrieval. The worker may still ensure the version-keyed classifier/allocation replay root because that work uses durable local evidence only. In fixture or Stripe mode it additionally ensures an initial recovery root and one root per UTC hour; each local batch or provider page is capped at 100, initial payout discovery looks back seven days before the earliest local paid order, and hourly discovery overlaps 72 hours. These are convergence boundaries, not a promise that an administrator report is fresh. Direct Sales candidate routes are available only to controlled review; global navigation remains disabled until acceptance.

Caddy's internal port 2015 health endpoint is container-only and avoids coupling container health to the configured public hostname or TLS redirect behavior.

Caddy access logging is intentionally disabled: neither site block enables the `log` directive. Its default runtime logger filters the nested `request>uri` field by deleting it before encoding, removing request paths and query strings from Caddy runtime events. Keep `log_credentials` unset so Caddy's built-in Cookie and Authorization redaction remains active. Do not enable access logging unless it receives an equivalent `request>uri` delete or `REDACTED` filter.

The application and worker containers run as the unprivileged `node` user with `no-new-privileges`. Their root filesystems remain writable because Docker Compose cannot materialize an environment-backed secret into a read-only container root filesystem; Plan 7 must revisit that control alongside the production secret provider.

Check the baseline:

```powershell
docker compose --file compose.prod.yaml ps
docker compose --file compose.prod.yaml logs --tail 100 app worker postgres caddy
```

`/health/live` proves that the Node process responds. `/health/ready` performs a bounded `select 1` through the web process's PostgreSQL pool, round-trips staging and covers with canonical disposable keys, and reads and byte-compares the fixed publication sentinel without writing to the read-only publication mount. Worker health proves the worker completed its initial database probe, atomically provisioned and verified that sentinel, used canonical disposable keys to round-trip all three roots, and entered the polling loop; the bounded cleanup process performs the same writer probe before scanning. Transient probe writes are deleted immediately, while a crash remnant remains an ordinary health, derived, or cover orphan that existing retention cleanup can remove. The sentinel is outside cleanup grammar and the current publication backup/restore contract requires and preserves it. All other production paths return 503 while `APPLICATION_MODE=maintenance`.

Run storage cleanup dry-run before apply and follow the coordinated writer-quiescence and backup/restore procedures in [storage, ingestion, publication, and recovery](storage-ingestion-and-publication.md). Production cleanup uses process configuration and only `database_storage_cleanup_password`; it never receives the web, worker, or owner database secret. Apply is accepted only with the exact `--apply --writers-quiesced` attestation after app, worker, old cleanup, and all other volume consumers have been checked:

```powershell
docker compose --file compose.prod.yaml --profile tools run --rm storage-cleanup
docker compose --file compose.prod.yaml --profile tools stop app worker storage-cleanup
docker compose --file compose.prod.yaml --profile tools ps --all app worker storage-cleanup
docker ps --all --filter volume=<project>_book_staging
docker ps --all --filter volume=<project>_book_publication
docker ps --all --filter volume=<project>_book_covers
docker compose --file compose.prod.yaml --profile tools run --rm storage-cleanup node build/services/cleanup-storage.js --apply --writers-quiesced
```

Replace `<project>` with the exact Compose project name supplied by `--project-name`/`COMPOSE_PROJECT_NAME`, or with Compose's normalized directory default after confirming it with `docker compose ls --all`. Each all-state volume query must show no running or restarting consumer before apply.

After the attested apply succeeds, start the app and worker with the ordinary production `up --detach --wait` command and recheck readiness.

## Ownership of later work

- Plan 2 supplies the database adapter, committed migrations, worker, durable jobs/outbox, append-only audit events, and database readiness.
- Plan 3 supplies verified email/password and magic-link authentication, audited roles, the provider-neutral SMTP adapter, and Mailpit development delivery.
- Plan 4 supplies private storage, bounded ingestion, revision publication, cleanup, and the current backup/restore procedure.
- Plan 5 supplies server-owned customer libraries, full entitled reading, optimistic reader state, exact revision migration, and authenticated original downloads. See [customer library, reader state, and original downloads](customer-library-and-reader.md).
- Plan 6A supplies Stripe Checkout/event reconciliation, guest claiming, purchase grants, and refund/dispute access changes.
- The Plan 6B candidate combines processing-fee, balance-transaction, payout, allocation, issue, scheduler, and replay boundaries with administrator resolution and sales/estimated-payout reporting while independent review remains pending.
- Plan 7 adds production activation, deployment automation, off-host backup scheduling, monitoring/alert delivery, general retry administration, final capacity tuning, and the read-only-rootfs review.
