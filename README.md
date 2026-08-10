# Pale Orbit Press — SvelteKit

Bookstore and in-browser reader for prose EPUBs and CBZ/ZIP comics. The original visual prototype has been migrated to a strict TypeScript SvelteKit application with PostgreSQL-backed authentication, catalog, publication workflows, customer libraries, and reader state.

## Development

Requirements: Node.js 26.7.x, npm 11.19.x, Docker, and Docker Compose 2.30 or newer.

```powershell
.\scripts\start-dev.ps1
```

The launcher creates `.env` from `.env.example` when needed, installs locked dependencies, applies committed migrations, and starts the app, worker, PostgreSQL, and Mailpit. The storefront runs at `http://localhost:5173`; Mailpit runs at `http://localhost:8025`; uploaded publications live under the ignored `.data/storage` directory.

Manual host-run commands:

```powershell
npm run db:migrate
npm run admin:bootstrap
npm run dev
npm run worker:watch
```

Fully containerized development:

```powershell
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm bootstrap-admin
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

Operational references:

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

Development uses the PostgreSQL catalog, private EPUB/CBZ storage, background ingestion, revision review/publication, public previews, server-owned customer libraries and reader state, authenticated original downloads, and an audited admin dashboard. Production Compose remains fixed to maintenance mode until Plan 6 implements commerce and reconciled entitlement grants.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Storefront backed by public catalog data |
| `/catalog` | Public active titles and format filter |
| `/book/[id]` | Public detail and reviewed free-preview entry point |
| `/read/[id]` | Public preview by slug or entitled full reader by title ID |
| `/library` | Server-owned entitled shelf, resume state, and downloads |
| `/library/[titleId]/download` | Re-authorized EPUB/CBZ/ZIP original stream |
| `/admin` | Protected publication, user, audit, and reporting dashboard |
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

Checkout is not live in Plan 5. Retired commerce, webhook, success, and delivery routes return `404` and cannot change a shelf. The Stripe SDK remains installed for Plan 6, which owns payment reconciliation, guest claiming, sales reporting, and the audited entitlement grant/revoke service.

## Authentication and delivery

Better Auth provides verified email/password accounts, password reset, magic links, and PostgreSQL-backed sessions and rate limits. Every protected route enforces authorization on the server. Administrators manage audited roles at `/admin/users`, including transactional final-admin protection. Third-party OAuth remains out of scope.

Versioned authentication messages use the PostgreSQL outbox and provider-neutral SMTP adapter; development mail is captured by Mailpit. Publication files are never email attachments. Entitled customers download retained originals through the authenticated application route, which supports HEAD and single byte ranges and records a redacted audit event. Local disk is implemented; the S3 provider remains a fail-at-startup interface stub with no AWS SDK installed.

## Not yet wired

- Stripe checkout, reconciled entitlement grants/revocations, guest checkout claiming, and sales reporting (Plan 6).
- Search, series grouping, pre-orders, and reviews.
