# Runtime environments

## Scope

Plan 1 supplies a development environment and a production infrastructure baseline. The production application intentionally remains in maintenance mode until durable authentication, authorization, catalog, storage, and commerce replace the frontend prototype behavior in later plans.

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
npm run dev
```

```powershell
npm run worker:watch
```

The storefront is at `http://localhost:5173` and Mailpit is at `http://localhost:8025`. The host-run app and worker use `DATABASE_HOST=localhost` from `.env`.

Stop the service containers without deleting PostgreSQL data:

```powershell
docker compose --env-file .env --file compose.dev.yaml down
```

## Fully containerized development

After creating `.env`, run the explicit migration profile, then start the source-mounted app and worker with PostgreSQL and Mailpit:

```powershell
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

The development topology contains the app, worker, PostgreSQL, and Mailpit. The Compose app and worker override `DATABASE_HOST` to the internal service name `postgres`. Source changes are served by Vite from the bind mount. Dependencies remain in the named `app_node_modules` volume. The worker is private to Compose and publishes no port.

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

Every required application value also supports a mutually exclusive `<NAME>_FILE` form. Production uses `DATABASE_PASSWORD_FILE=/run/secrets/database_password`. Startup fails when a value is missing, empty, invalid, or supplied both directly and through `_FILE`.

## Production baseline

Production does not use an environment file. The deployment process exports `APP_IMAGE`, `ORIGIN`, `SITE_ADDRESS`, `DATABASE_NAME`, `DATABASE_USER`, and `DATABASE_PASSWORD`, then runs:

```powershell
docker compose --file compose.prod.yaml config --quiet
docker compose --file compose.prod.yaml --profile tools run --rm migrate
docker compose --file compose.prod.yaml up --detach --wait
```

The production topology contains the app, worker, PostgreSQL, and Caddy. `APP_IMAGE` must identify the already-built immutable application image. The explicit migration command must succeed before the app and worker start. Caddy is the only service with published ports. PostgreSQL persists in `postgres_data` and is reachable only on the Compose network. The database password becomes `/run/secrets/database_password` in the app, worker, migration, and PostgreSQL containers; it is not stored in a production `.env` file.

Caddy's internal port 2015 health endpoint is container-only and avoids coupling container health to the configured public hostname or TLS redirect behavior.

The application and worker containers run as the unprivileged `node` user with `no-new-privileges`. Their root filesystems remain writable because Docker Compose cannot materialize an environment-backed secret into a read-only container root filesystem; Plan 7 must revisit that control alongside the production secret provider.

Check the baseline:

```powershell
docker compose --file compose.prod.yaml ps
docker compose --file compose.prod.yaml logs --tail 100 app worker postgres caddy
```

`/health/live` proves that the Node process responds. `/health/ready` performs a bounded `select 1` through the web process's PostgreSQL pool. Worker health proves the worker completed its initial database probe and entered the polling loop. All other production paths return 503 while `APPLICATION_MODE=maintenance`.

## Ownership of later work

- Plan 2 supplies the database adapter, committed migrations, worker, durable jobs/outbox, append-only audit events, and database readiness.
- Plan 3 adds the provider-neutral SMTP adapter and connects it to Mailpit in development.
- Plan 4 adds the private uploads volume and storage adapters.
- Plan 7 adds the Hetzner deployment runbook, backup/restore procedures, monitoring, final capacity tuning, and the read-only-rootfs review.
