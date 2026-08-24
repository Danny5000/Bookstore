# Pale Orbit Press — SvelteKit

Bookstore and in-browser reader for prose EPUBs and CBZ/ZIP comics. The original visual prototype has been migrated to a strict TypeScript SvelteKit application with PostgreSQL-backed authentication, catalog, publication workflows, multi-title Stripe commerce, guest purchase claiming, customer libraries, and reader state.

## Development

Requirements: Node.js 26.7.x, npm 11.19.x, Docker, and Docker Compose 2.30 or newer.

```powershell
.\scripts\start-dev.ps1
```

The launcher creates `.env` from `.env.example` when needed, installs locked dependencies, applies committed migrations, provisions distinct owner/web/financial-worker/storage-cleanup database roles, and starts the app, worker, PostgreSQL, and Mailpit. Configure pairwise-distinct `DATABASE_OWNER_USER`/`DATABASE_OWNER_PASSWORD`, `DATABASE_USER`/`DATABASE_PASSWORD`, `DATABASE_WORKER_USER`/`DATABASE_WORKER_PASSWORD`, and `DATABASE_STORAGE_CLEANUP_USER`/`DATABASE_STORAGE_CLEANUP_PASSWORD` pairs. The storefront runs at `http://localhost:5173`; Mailpit runs at `http://localhost:8025`. Local storage is split across the ignored `.data/storage-staging`, `.data/storage-publication`, and `.data/storage-covers` directories; the web process treats publication as read-only while the worker owns publication writes.

For an existing pre-split development volume, move the current `DATABASE_USER` and `DATABASE_PASSWORD` values to `DATABASE_OWNER_USER` and `DATABASE_OWNER_PASSWORD`, then choose distinct new web, worker, and storage-cleanup credentials. An environment that already has the three owner/web/worker pairs needs only the new cleanup pair. Stop any host-run web, worker, and storage-cleanup processes before the commands below; the launcher and containerized sequence stop existing Compose app/worker/storage-cleanup containers before migration.

Manual host-run commands:

```powershell
npm run db:migrate
npm run db:provision-roles
npm run admin:bootstrap
npm run dev
npm run worker:watch
```

Fully containerized development:

```powershell
docker compose --env-file .env --file compose.dev.yaml stop app worker storage-cleanup
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm database-role-provision
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm bootstrap-admin
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

Operational references:

- [Commerce and guest claims](docs/commerce-and-guest-claims.md)
- [Financial reconciliation and reporting](docs/financial-reconciliation-and-reporting.md)
- [Stripe financial reconciliation](docs/stripe-financial-reconciliation.md)
- [Authentication and email](docs/authentication-and-email.md)
- [Customer library, reader state, and downloads](docs/customer-library-and-reader.md)
- [Runtime environments](docs/runtime-environments.md)
- [Database and workers](docs/database-and-workers.md)
- [Storage, ingestion, publication, and recovery](docs/storage-ingestion-and-publication.md)

Quality gates:

```powershell
npm run check
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
npm run verify
```

Development uses the PostgreSQL catalog, private EPUB/CBZ storage, background ingestion, revision review/publication, public previews, server-owned commerce and entitlement grants, customer libraries and reader state, authenticated original downloads, and an audited admin dashboard. Stripe is disabled by default and production Compose remains fixed to maintenance mode.

**Status:** Plan 6B candidate — independent review pending

The unified candidate includes financial ingestion and reconciliation plus direct administrator review, refund finalization, reporting correction, recovery, payout, Sales reporting, and CSV routes. The global item remains `Sales — Upcoming` with no live link until review accepts the candidate. The migration chain ends at `0014`: `0012` retains its historical eight callable public boundary routines, `0013` adds the ninth, and `0014` changes no callable surface while replacing the nullable issue-transition trigger guard with a fail-closed definition. The four pairwise-distinct login principals are `DATABASE_OWNER_USER`, `DATABASE_USER`, `DATABASE_WORKER_USER`, and `DATABASE_STORAGE_CLEANUP_USER`; the web principal submits commands, reads owner-scoped status, and completes route-authorized detail/export audits while only the financial-worker principal executes protected financial mutations. Candidate deployment order is migrate, role provision, checkpoint capture, distinct-engine rehearsal, then production-image smoke. Plan 7 retains the production launch and operability gate.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Storefront backed by public catalog data |
| `/catalog` | Public active titles and format filter |
| `/book/[id]` | Public detail and reviewed free-preview entry point |
| `/cart` | Server-requoted multi-title cart and Stripe Checkout entry point |
| `/checkout/success` | Private polling view for asynchronous order status |
| `/claim` | Enumeration-resistant guest-purchase claim request |
| `/read/[id]` | Public preview by slug or entitled full reader by title ID |
| `/library` | Server-owned entitled shelf, resume state, and downloads |
| `/library/[titleId]/download` | Re-authorized EPUB/CBZ/ZIP original stream |
| `/admin` | Protected publication, user, and audit dashboard; direct Sales candidate routes remain unlinked pending review |
| `/studio` | Redirect to the database-backed admin catalog |

## Reader

`src/lib/components/BookReader.svelte` provides:

- responsive one- or two-page prose spreads and page turns;
- keyboard, pointer, and edge-zone navigation;
- deterministic pagination derived from the measured page box;
- comic page and administrator-reviewed guided-panel modes;
- server-truncated public previews that cannot reveal omitted full content;
- semantic progress and bookmarks, display preferences, conflict notices, and exact revision migration.

Entitled progress, bookmarks, account display preferences, and comic mode are versioned in PostgreSQL. Preview state is local and scoped to one published presentation; it never grants access. See the customer reader runbook for conflict and migration behavior.

## Styling

Global tokens and primitives live in `src/app.css`; component styles are scoped. Nocturne and Vellum themes are attribute-based and the theme preference remains local UI state.

## Catalog and publication

Public catalog, detail, and preview loaders read only active public revisions with published reader settings. Administrators create titles, stream EPUB/CBZ uploads, review derived content, edit metadata and preview settings, and explicitly activate, replace, roll back, publish, or withdraw immutable revisions under `/admin/catalog`.

## Commerce boundary

Plan 6A provides a bounded quantity-one multi-title cart, server-owned quotes, immutable order snapshots, Stripe-hosted Checkout, signed idempotent webhook processing, account and guest fulfillment, one-use guest claims, and refund/dispute-driven purchase grants. A redirect never creates access: canonical asynchronous Stripe processing is the only purchase fulfillment authority. Prices are tax-exclusive, mixed currencies are rejected, and Stripe remains disabled unless explicit validated test-mode configuration enables it.

Plan 6B's unified candidate adds local canonical balance-transaction and payout ingestion, signed fee/net allocation, reconciliation issues, bounded recovery scans, versioned classification replay, and the direct administrator resolution/reporting surfaces described in the [financial reconciliation and reporting operator guide](docs/financial-reconciliation-and-reporting.md). Exact automatic-standard payout association requires complete membership plus current paid status; manual and instant payouts remain fee-reconciled without invented membership. See also the [commerce operations runbook](docs/commerce-and-guest-claims.md) and the detailed [Stripe financial reconciliation guide](docs/stripe-financial-reconciliation.md).

Production is still `APPLICATION_MODE=maintenance`. Stripe remains disabled in the base stack, the Sales navigation remains unavailable, and Plan 7—not the Stripe overlay—owns storefront launch.

## Authentication and delivery

Better Auth provides verified email/password accounts, password reset, magic links, and PostgreSQL-backed sessions and rate limits. Every protected route enforces authorization on the server. Administrators manage audited roles at `/admin/users`, including transactional final-admin protection. Third-party OAuth remains out of scope.

Versioned authentication and commerce messages use the PostgreSQL outbox and provider-neutral SMTP adapter; development mail is captured by Mailpit. Paid guests receive a receipt and one-use claim action. Any existing password account uses exact-purpose commerce recovery: the mailbox owner resets the credential, all prior sessions are revoked, and only reset-derived one-use authorization can attach purchases. Publication files are never email attachments. Entitled customers download retained originals through the authenticated application route, which supports HEAD and single byte ranges and records a redacted audit event. Local disk is implemented; the S3 provider remains a fail-at-startup interface stub with no AWS SDK installed.

## Deferred work

- Plan 6B independent review and Plan 7 production launch, deployment automation, monitoring, general retry administration, and off-host backup scheduling.
- Search, series grouping, pre-orders, and reviews.
