# Authentication and email operations

## Architecture and ownership

Better Auth owns credential hashing, signed email-verification/reset/magic-link tokens, database sessions, cookies, trusted-origin checks, and endpoint rate limits. Pale Orbit Press owns the one-use verification-token markers, `customer` and `admin` roles, guest identities, authorization policy, append-only audit events, versioned email payloads, and PostgreSQL outbox delivery. Every authenticated user has the durable `customer` role; an `admin` role adds access to the protected `/admin` routes. Guest identities remain separate until the later commerce plan adds order claiming.

PostgreSQL is the only database, rate-limit store, job queue, and outbox store. Redis is not required. Nodemailer implements the provider-neutral SMTP boundary. Development routes mail to Mailpit; production supplies standard SMTP settings without changing application code.

## Development setup

Copy the example environment once and replace the bootstrap password before using it:

```powershell
Copy-Item .env.example .env
# Edit .env and replace BOOTSTRAP_ADMIN_PASSWORD.
npm ci
```

For host-run development, start the supporting containers, then use separate terminals for the web process and worker:

```powershell
docker compose --env-file .env --file compose.dev.yaml up postgres mailpit --detach --wait
npm run db:migrate
npm run admin:bootstrap
npm run dev
```

```powershell
npm run worker:watch
```

For fully containerized development:

```powershell
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm bootstrap-admin
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

The storefront is at `http://localhost:5173`; Mailpit is at `http://localhost:8025`. Register a new address, open the verification message in Mailpit, and follow its link. The same inbox shows reset and magic-link messages. A password registration must be verified before that account can receive a magic link; this prevents an unverified Better Auth magic-link flow from replacing the pending password identity. Use **Resend verification** in the sign-in dialog when the original message is unavailable.

Stop the stack without deleting developer data:

```powershell
docker compose --env-file .env --file compose.dev.yaml down
```

## Administrator bootstrap and role changes

`npm run admin:bootstrap` and the Compose `bootstrap-admin` service are explicit, one-shot tools. The command is idempotent: it creates and verifies the configured account when absent, grants `customer` and `admin`, and records the grant in the audit trail. If the email already belongs to a verified credential account, its existing password is not changed. An existing unverified account is rejected so the operator must resolve it deliberately.

After signing in as an administrator, use `/admin/users` to grant or revoke `admin`. Every change is authorized on the server and audited. The `customer` role cannot be removed. An administrator may demote themself only when another administrator remains; the UI disables the action and the database transaction refuses it when it would remove the final administrator.

## Production secrets and deployment order

Generate a unique authentication secret and keep it out of Git and shell history where practical:

```powershell
openssl rand -base64 32
```

Production does not use an `.env` file. The deployment process exports `APP_IMAGE`, `ORIGIN`, `SITE_ADDRESS`, database settings, `AUTH_SECRET`, SMTP settings, and the three bootstrap values. Compose converts the database, auth, SMTP, and bootstrap passwords from that process environment into mounted secrets. The bootstrap password is mounted only into the one-shot bootstrap service.

For example, a deployment shell can receive values from its secret manager and place them only in that process environment:

```powershell
$env:APP_IMAGE = 'registry.example.com/pale-orbit@sha256:<immutable-digest>'
$env:ORIGIN = 'https://books.example.com'
$env:SITE_ADDRESS = 'books.example.com'
$env:DATABASE_NAME = 'pale_orbit'
$env:DATABASE_USER = 'pale_orbit'
$env:DATABASE_PASSWORD = '<from-secret-manager>'
$env:AUTH_SECRET = '<generated-auth-secret>'
$env:SMTP_HOST = 'smtp.example.com'
$env:SMTP_PORT = '587'
$env:SMTP_USER = 'mailer'
$env:SMTP_PASSWORD = '<from-secret-manager>'
$env:SMTP_FROM = 'Pale Orbit Press <books@example.com>'
$env:SMTP_SECURE = 'false'
$env:SMTP_REQUIRE_TLS = 'true'
$env:BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com'
$env:BOOTSTRAP_ADMIN_NAME = 'Administrator'
$env:BOOTSTRAP_ADMIN_PASSWORD = '<from-secret-manager>'
```

The bracketed strings are placeholders, not values to copy into a deployment. CI/CD should source them from protected secret storage and clear the deployment process environment when it finishes.

Validate the exported values, migrate, bootstrap once, and then start the long-running services:

```powershell
docker compose --file compose.prod.yaml config --quiet
docker compose --file compose.prod.yaml --profile tools run --rm migrate
docker compose --file compose.prod.yaml --profile tools run --rm bootstrap-admin
docker compose --file compose.prod.yaml up --detach --wait
```

Use `SMTP_SECURE=true` with `SMTP_REQUIRE_TLS=false` for implicit TLS, normally on port 465. For submission using STARTTLS, set `SMTP_SECURE=false` and `SMTP_REQUIRE_TLS=true`, normally on port 587. Production requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`; connection, greeting, and socket timeouts have documented Compose defaults.

The public `ORIGIN` must be the exact HTTPS origin served by Caddy. Better Auth accepts only trusted-origin requests, uses HTTP-only database-backed session cookies, and enables secure cookies in production. Session and verification lifetimes and PostgreSQL-backed endpoint rate limits are controlled by the `AUTH_*_SECONDS` and `AUTH_*_RATE_LIMIT_*` settings. Changing the auth secret invalidates signed state and should be treated as a coordinated credential rotation.

Production remains in maintenance mode until the remaining backend plans replace the prototype catalog, storage, and commerce paths.

## Delivery guarantees and transaction boundary

Each project email enqueue inserts its versioned outbox message and dispatch job in one application transaction. The worker validates the payload, renders it, and sends it with a stable RFC Message-ID. Delivery is at least once: SMTP cannot commit atomically with PostgreSQL, so a crash after SMTP accepts a message but before `deliveredAt` is recorded can produce a duplicate. Verification, reset, and magic-link templates must therefore remain safe to receive twice.

Better Auth creates a signed verification token and then awaits the configured mail callback. The callback first stores only a SHA-256 token digest as a one-use marker, then creates the project outbox transaction. Better Auth 1.6 does not expose a transaction that can include these application writes, so the marker and outbox row cannot share one transaction without replacing the supported email flow. The endpoint reports success only after durable outbox enqueue. If enqueue fails, an unused marker can remain until it expires, but the application does not claim that mail was sent. Verification atomically consumes the marker before Better Auth validates and applies the signed token, so a previously used link is rejected rather than silently succeeding.

## Safe troubleshooting

Start with process health and bounded logs:

```powershell
docker compose --file compose.prod.yaml ps
docker compose --file compose.prod.yaml logs --tail 100 app worker
```

When database inspection is necessary, examine only outbox/job identifiers, topics or types, status, attempt counts, and timestamps. Do not select or print outbox payloads, email bodies, action URLs, passwords, auth secrets, cookies, or verification tokens. A pending record indicates that the worker has not completed it; a failed record retains safe failure metadata for diagnosis; a delivered outbox record suppresses ordinary replay.

Do not manually reset failed email rows or jobs. Controlled authorization, validation, and audit logging for retries arrives with Plan 7's admin retry tooling. Until then, correct the underlying SMTP/configuration problem and preserve the failed records for review.
