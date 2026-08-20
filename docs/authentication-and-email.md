# Authentication and email operations

## Architecture and ownership

Better Auth owns credential hashing; token creation and validation for email verification, password reset, and magic links; database sessions; cookies; trusted-origin checks; and endpoint rate limits. Pale Orbit Press owns the one-use email-verification markers, `customer` and `admin` roles, guest identities, authorization policy, append-only audit events, versioned email payloads, and PostgreSQL outbox delivery. Every authenticated user has the durable `customer` role; an `admin` role adds access to the protected `/admin` routes. A paid guest identity remains separate and has no account access until a verified same-email account completes the commerce claim flow.

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

The storefront is at `http://localhost:5173`; Mailpit is at `http://localhost:8025`. Register a new address, open the verification message in Mailpit, follow its link, and then sign in explicitly; ordinary verification never creates a session. The same inbox shows reset and magic-link messages. A password registration must be verified before that account can receive an ordinary magic link; this prevents an unverified Better Auth magic-link flow from replacing the pending password identity. Use **Resend verification** in the sign-in dialog when the original message is unavailable. If a verification message was not requested by the mailbox owner, it is not an account-recovery mechanism; use password recovery instead.

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
$env:DATABASE_OWNER_USER = 'pale_orbit_owner'
$env:DATABASE_OWNER_PASSWORD = '<from-secret-manager>'
$env:DATABASE_USER = 'pale_orbit_web'
$env:DATABASE_PASSWORD = '<from-secret-manager>'
$env:DATABASE_WORKER_USER = 'pale_orbit_worker'
$env:DATABASE_WORKER_PASSWORD = '<from-secret-manager>'
$env:DATABASE_STORAGE_CLEANUP_USER = 'pale_orbit_storage_cleanup_login'
$env:DATABASE_STORAGE_CLEANUP_PASSWORD = '<from-secret-manager>'
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
docker compose --file compose.prod.yaml --profile tools stop app worker storage-cleanup
docker compose --file compose.prod.yaml --profile tools run --rm migrate
docker compose --file compose.prod.yaml --profile tools run --rm database-role-provision
docker compose --file compose.prod.yaml --profile tools run --rm storage-cleanup
docker compose --file compose.prod.yaml --profile tools run --rm bootstrap-admin
docker compose --file compose.prod.yaml up --detach --wait
```

The migration must install the cleanup capability before role provisioning binds its dedicated login. When upgrading a release whose cleanup command used the web credential, supply a fresh `DATABASE_PASSWORD` to the provisioning run, keep all old cleanup processes stopped, and deploy that rotated web secret only after provisioning and the dedicated cleanup dry-run succeed. This invalidates the web credential held by any retired cleanup process.

Use `SMTP_SECURE=true` with `SMTP_REQUIRE_TLS=false` for implicit TLS, normally on port 465. For submission using STARTTLS, set `SMTP_SECURE=false` and `SMTP_REQUIRE_TLS=true`, normally on port 587. Production requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`; connection, greeting, and socket timeouts have documented Compose defaults. Only the worker loads `SMTP_USER` and `SMTP_PASSWORD` or mounts the SMTP password secret, because only the worker sends messages. The web process retains non-secret delivery policy needed by shared request validation but cannot authenticate to SMTP; migration and bootstrap receive no SMTP or auth secret.

The public `ORIGIN` must be the exact HTTPS origin served by Caddy. Better Auth accepts only trusted-origin requests, uses HTTP-only database-backed session cookies, and enables secure cookies in production. Session and verification lifetimes and PostgreSQL-backed endpoint rate limits are controlled by the `AUTH_*_SECONDS` and `AUTH_*_RATE_LIMIT_*` settings. Changing the auth secret invalidates signed state and should be treated as a coordinated credential rotation.

Native verification, reset, and magic-link action URLs carry one-use bearer tokens in their request targets: reset places its token in the URL path, while verification and magic-link actions use query strings. Caddy's default runtime logger filters `request>uri` by deleting it, and Caddy access logging remains disabled so the edge does not retain those URLs. Access logs must not be enabled without an equivalent URI filter that deletes `request>uri` or replaces it with `REDACTED`; application-side no-secret logging rules remain required as defense in depth.

Production remains in maintenance mode after Plan 6A. Catalog, storage, commerce, guest claims, customer libraries, full entitled reading, and original downloads are durable; Plan 6B financial reporting and the Plan 7 launch gate remain prerequisites before storefront activation is considered.

Authentication email contains text/HTML only. EPUB and CBZ/ZIP originals are never attached to email; entitled delivery is re-authorized and streamed by the application as documented in [customer library, reader state, and original downloads](customer-library-and-reader.md).

## Commerce receipts and guest claims

Canonical paid fulfillment enqueues versioned `email.commerce.v1` messages through the same PostgreSQL outbox/SMTP adapter. An account order receives a receipt at the verified account email. A paid guest purchase receives a combined receipt and one-use claim action at the normalized email returned by canonical Stripe Checkout; a browser-submitted email is never ownership authority.

A verified same-email account claims all eligible guest purchases in one locked transaction only when it also presents a project-owned one-use commerce authorization. The public request form returns the same success copy for present, absent, and already-claimed addresses. A passwordless address may receive commerce magic; account state is rechecked when the link is consumed. Any existing password account, verified or unverified, instead receives the exact commerce recovery flow: reset the password, revoke all sessions, mark only the reset-token-bound account verified, mint reset-derived claim authorization, and sign in explicitly with the new password. There is no follow-up verification email. Ordinary verification/reset/magic links and a direct `/claim/complete` visit cannot authorize a claim. Claim authorization is consumed atomically with purchase attachment, so exact replay is rejected without duplicating grants. Use Mailpit locally and follow [commerce and guest-claim operations](commerce-and-guest-claims.md); never print action URLs, outbox payloads, claim cookies, or recipient addresses during diagnosis.

`credential_authority` is project-owned, security-critical authentication state. Its authorized password hash is the only credential generation allowed to create a password or credential-bound magic session; a missing or mismatched row fails closed. Migration `0006` backfills the exact hash for every existing credential account and deliberately fails on duplicate or null legacy credential rows; integration tests execute that migration SQL against all three legacy shapes and prove rollback on either invalid shape. First-admin bootstrap writes the credential and matching authority in one transaction. Ordinary credential registration establishes authority in Better Auth's post-create hook before signup returns, but that hook uses a separate application transaction: a persistence failure may leave a credential without authority, which remains sign-in fail-closed and mailbox-reset recoverable. The table lives outside generated `schema/auth.ts`, so `npm run auth:schema` cannot erase it.

## Delivery guarantees and transaction boundary

Each project email enqueue inserts its versioned outbox message and dispatch job in one application transaction. The worker validates the payload, renders it, and sends it with a stable RFC Message-ID. Delivery is at least once: SMTP cannot commit atomically with PostgreSQL, so a crash after SMTP accepts a message but before `deliveredAt` is recorded can produce a duplicate. Verification, reset, and magic-link templates must therefore remain safe to receive twice.

Better Auth creates a signed email-verification token and then awaits the configured mail callback. The current callback first stores only a SHA-256 token digest as a one-use marker, then creates the project outbox transaction. Those application writes use separate transactions, and the endpoint reports success only after both complete and the outbox enqueue is durable. If enqueue fails, an unused marker can remain expired in the table, but the application does not claim that mail was sent. The verification request performs a non-consuming project-marker precheck; native token validation and atomic project-marker consumption must both succeed before the account is updated. A previously used or commerce-recovery-invalidated link is rejected rather than silently succeeding, and verification never auto-signs in.

Every ordinary or commerce magic action also has a project marker bound to the authorized credential generation at issuance. Successful verification must atomically consume that marker and recheck the generation after Better Auth creates its session; a stale, missing, mismatched, or faulting guard deletes that session, scrubs the valid cookie before any fallible cleanup, clears redirect state, and returns a generic invalid-link response. The same fail-closed cleanup protects password sessions when authority revalidation faults. If exact session deletion itself fails, no usable token is delivered and the safe internal error signal contains no email, token, or credential material. A verified credential that appears after passwordless issuance survives Better Auth cleanup and therefore rejects the link. If only an unverified credential appeared, Better Auth strips it after mailbox proof; the project deletes its orphan authority and may continue passwordless only when there is no reset epoch or the exact live epoch-bound reset marker is still unapplied. A reset token that has already applied a hash is newer mailbox-proven authority, so the older magic link is rejected even if Better Auth subsequently removed that credential. A fresh claim request routes any surviving authority row to password recovery rather than issuing another doomed magic link. Every successful magic action invalidates outstanding native and project password-reset tokens under the same user lock. It preserves the current authorized hash while clearing a pending unapplied epoch for a credential user, or removes passwordless authority state, so a stale reset cannot take over after the magic session is created.

Password-reset issuance promotes only an exact live Better Auth token bound to that user, so concurrent requests cannot email a token another request already invalidated. Requesting a reset does not disable the still-authorized password or an unchanged magic generation. The latest reset epoch serializes credential writers, while each in-flight request records a digest of the exact hash it applied. Completion authorizes only that same applied hash; a stale request restores the previous authority only with an exact compare-and-swap and can never overwrite a newer applied reset. Sibling native reset tokens are invalidated. Failure after password mutation leaves sessions revoked and password/magic sign-in fail-closed until a fresh mailbox reset succeeds.

In-session `/change-password` is intentionally disabled; password changes use the reset flow so credential rotation and session revocation stay ordered. A successful password sign-in revalidates the exact credential hash after its session is created. If a concurrent reset changed the credential, the late session is deleted, its cookie is expired, and the request receives the same generic invalid-credentials response as an ordinary wrong password.

Known follow-up: ordinary registration currently accepts a password before mailbox ownership is proven, and the later verification action activates that pending credential. Plan 6A prevents that state from claiming guest purchases by requiring every password-bearing account to complete mailbox-bound password recovery and session revocation first, but the broader account-registration flow should receive a separate design that establishes or replaces the credential only with mailbox-bound proof. Keep verification auto-sign-in disabled until that flow has equivalent credential-generation and post-revocation session guards.

## Safe troubleshooting

Start with process health and bounded logs:

```powershell
docker compose --file compose.prod.yaml ps
docker compose --file compose.prod.yaml logs --tail 100 app worker
```

When database inspection is necessary, examine only outbox/job identifiers, topics or types, status, attempt counts, and timestamps. Do not select or print outbox payloads, email bodies, action URLs, passwords, auth secrets, cookies, verification tokens, `credential_authority.authorized_password_hash`, or `credential_authority.reset_epoch_sha256`. A safe restore check may return only aggregate counts proving both directions: each credential has exactly one matching non-null authority hash, and no non-null authority lacks exactly one matching credential. It must never project either hash. A null authority hash is valid only with a non-null reset epoch for pending passwordless recovery; null/null is invalid. A mismatch is not repaired by copying the current account hash into authority: keep the app in maintenance and require a fresh mailbox reset. A pending record indicates that the worker has not completed it; a failed record retains safe failure metadata for diagnosis; a delivered outbox record suppresses ordinary replay.

Do not manually reset failed email rows or jobs. Controlled authorization, validation, and audit logging for retries arrives with Plan 7's admin retry tooling. Until then, correct the underlying SMTP/configuration problem and preserve the failed records for review.
