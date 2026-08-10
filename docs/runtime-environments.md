# Runtime environments

## Scope

The repository supplies a development environment and a production infrastructure baseline. Authentication, administration, PostgreSQL catalog data, private publication storage, ingestion, Stripe commerce, guest claims, entitlement grants, customer libraries, reader state, and entitled original downloads are durable. Stripe is disabled by default. Production intentionally remains in maintenance mode while Plan 6B financial reporting and the Plan 7 launch gate are incomplete.

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

The storefront is at `http://localhost:5173` and Mailpit is at `http://localhost:8025`. The host-run app and worker use `DATABASE_HOST=localhost` and the ignored `.data/storage` publication root from `.env`.

Stop the service containers without deleting PostgreSQL data:

```powershell
docker compose --env-file .env --file compose.dev.yaml down
```

## Fully containerized development

After creating `.env`, run the explicit migration profile, then start the source-mounted app and worker with PostgreSQL and Mailpit:

```powershell
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm bootstrap-admin
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

The development topology contains the app, worker, PostgreSQL, and Mailpit. The Compose application processes override `DATABASE_HOST` and `SMTP_HOST` to the internal service names `postgres` and `mailpit`, and mount `./.data/storage` at `/var/lib/pale-orbit/storage`. Source changes are served by Vite from the bind mount. Dependencies remain in the named `app_node_modules` volume. The worker is private to Compose and publishes no port. `bootstrap-admin`, migrations, and storage cleanup are one-shot tools and do not start with the ordinary stack.

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
| `DATABASE_USER` | `.env` | Deployment-process environment | No |
| `DATABASE_PASSWORD` | `.env` | Deployment-process environment converted to a Compose secret | Yes |
| `AUTH_SECRET` | `.env` development value | Deployment-process environment converted to a Compose secret | Yes |
| Auth lifetimes/rate limits | `.env` | Deployment-process environment or documented Compose defaults | No |
| `SMTP_HOST`, port, TLS mode, user, from | Mailpit/local values in `.env` | Required deployment-process environment | User is not secret |
| `SMTP_PASSWORD` | Omitted for Mailpit | Deployment-process environment converted to a Compose secret | Yes |
| `STORAGE_PROVIDER` | `local` | `local` until the future adapter is implemented | No |
| `STORAGE_LOCAL_ROOT` | `.data/storage` or Compose private mount | Compose fixes `/var/lib/pale-orbit/storage` | No |
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

Every required application value also supports a mutually exclusive `<NAME>_FILE` form. Production uses `DATABASE_PASSWORD_FILE`, `AUTH_SECRET_FILE`, and `SMTP_PASSWORD_FILE` under `/run/secrets`; the bootstrap tool also uses `BOOTSTRAP_ADMIN_PASSWORD_FILE`. Startup fails when a value is missing, empty, invalid, or supplied both directly and through `_FILE`.

## Production baseline

Production does not use an environment file. The deployment process exports the image/origin/database values, a generated `AUTH_SECRET`, provider SMTP values, and the first-administrator values. See [authentication and email operations](authentication-and-email.md) for that contract and [commerce and guest-claim operations](commerce-and-guest-claims.md) for Stripe. Base production requires no Stripe credentials and keeps `STRIPE_ENABLED=false`. Then run:

```powershell
docker compose --file compose.prod.yaml config --quiet
docker compose --file compose.prod.yaml --profile tools run --rm migrate
docker compose --file compose.prod.yaml --profile tools run --rm bootstrap-admin
docker compose --file compose.prod.yaml up --detach --wait
```

The production topology contains the app, worker, PostgreSQL, and Caddy. `APP_IMAGE` must identify the already-built immutable application image. The explicit migration command must succeed before the app and worker start. Caddy is the only service with published ports. PostgreSQL persists in `postgres_data`; private books persist in `book_storage`, mounted read/write only by app, worker, and the cleanup tool. Caddy, migration, and bootstrap containers do not receive publication storage. Database, auth, and SMTP secrets are mounted only into processes that need them. The bootstrap password is mounted only into the one-shot bootstrap service. None is stored in a production `.env` file.

For a deliberate future test-mode checkpoint, supply both Stripe values from protected process memory and add the explicit overlay:

```powershell
docker compose --file compose.prod.yaml --file compose.stripe.yaml config --quiet
docker compose --file compose.prod.yaml --file compose.stripe.yaml up --detach --wait
```

`docker compose config` verifies the merged structure, but it does not verify that environment-backed secret values are present. Check that both Stripe variables are non-empty without printing them before any container-creation command.

`compose.stripe.yaml` mounts the two environment-backed secrets only into app and worker. It does not alter `APPLICATION_MODE=maintenance`, live mode, or the existing database/auth/SMTP secret mounts, and it is not a storefront launch switch.

Caddy's internal port 2015 health endpoint is container-only and avoids coupling container health to the configured public hostname or TLS redirect behavior.

The application and worker containers run as the unprivileged `node` user with `no-new-privileges`. Their root filesystems remain writable because Docker Compose cannot materialize an environment-backed secret into a read-only container root filesystem; Plan 7 must revisit that control alongside the production secret provider.

Check the baseline:

```powershell
docker compose --file compose.prod.yaml ps
docker compose --file compose.prod.yaml logs --tail 100 app worker postgres caddy
```

`/health/live` proves that the Node process responds. `/health/ready` performs a bounded `select 1` through the web process's PostgreSQL pool. Worker health proves the worker completed its initial database and storage probes and entered the polling loop. All other production paths return 503 while `APPLICATION_MODE=maintenance`.

Run storage cleanup dry-run before apply and follow the coordinated backup/restore procedure in [storage, ingestion, publication, and recovery](storage-ingestion-and-publication.md). Production cleanup uses process configuration and the database secret only:

```powershell
docker compose --file compose.prod.yaml --profile tools run --rm storage-cleanup
docker compose --file compose.prod.yaml --profile tools run --rm storage-cleanup node build/services/cleanup-storage.js --apply
```

## Ownership of later work

- Plan 2 supplies the database adapter, committed migrations, worker, durable jobs/outbox, append-only audit events, and database readiness.
- Plan 3 supplies verified email/password and magic-link authentication, audited roles, the provider-neutral SMTP adapter, and Mailpit development delivery.
- Plan 4 supplies private storage, bounded ingestion, revision publication, cleanup, and the current backup/restore procedure.
- Plan 5 supplies server-owned customer libraries, full entitled reading, optimistic reader state, exact revision migration, and authenticated original downloads. See [customer library, reader state, and original downloads](customer-library-and-reader.md).
- Plan 6A supplies Stripe Checkout/event reconciliation, guest claiming, purchase grants, and refund/dispute access changes.
- Plan 6B supplies processing-fee, balance-transaction, payout, allocation, and administrator sales/estimated-payout reporting.
- Plan 7 adds deployment automation, off-host backup scheduling, monitoring/alert delivery, final capacity tuning, and the read-only-rootfs review.
