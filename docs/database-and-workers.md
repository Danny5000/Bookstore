# Database and workers

## Ownership

Drizzle schema files under `src/lib/server/db/schema/` are the database model source of truth. Generated SQL and snapshots under `drizzle/` are committed and reviewed. Never use `drizzle-kit push` against shared or production databases.

The web process, migration command, and worker each own a bounded node-postgres pool. The web process uses PostgreSQL for readiness. The worker claims durable jobs from PostgreSQL and dispatches transactional outbox messages. Redis is not part of the current topology.

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

`npm run verify` runs integration and browser suites in separate disposable Compose projects. Browser tests additionally start the real worker and bootstrap a test administrator so email delivery and role authorization use production-shaped paths.

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

`/health/live` proves only the web process responds. `/health/ready` performs a bounded PostgreSQL query. Worker health proves the worker completed its initial database probe and entered the polling loop. Production storefront and API paths remain in maintenance mode until later plans replace prototype identity and commerce seams.

## Job behavior

Workers claim one job at a time with `FOR UPDATE SKIP LOCKED`. A lease timestamp makes work recoverable after a process crash. Each claim increments attempts. Transient failures return to `pending` with bounded exponential delay; permanent or exhausted work moves to `failed` for the future admin operations view.

Handlers persist only deliberately safe error text. The outbox pairs a message and dispatch job in the caller's transaction and delivers at least once. A message already recorded as delivered is not sent again on ordinary job replay, while topic handlers remain responsible for the crash window between an external side effect and the `deliveredAt` update.

Authentication email uses the versioned `email.auth.v1` topic and a stable Message-ID. Better Auth's verification row is committed in the adapter before its awaited callback creates the project outbox transaction; those two library boundaries are deliberately not represented as one atomic transaction. See the authentication runbook for delivery and safe-troubleshooting details.

## Scope of later plans

- Plan 3 registered authentication email outbox topics, integrated Better Auth, and mapped sessions/roles to the actor policy.
- Plan 4 adds storage/ingestion jobs and revision lifecycle transitions.
- Plan 6 adds Stripe reconciliation job topics.
- Plan 7 adds failed-job administration, structured logging, queue-age monitoring, backup/restore, and final pool/capacity tuning.
