# Pale Orbit Press — SvelteKit

Bookstore + in-browser reader for novels and comics. Ported from the HTML design
prototype: same layout, tokens, typography and page-turn engine, restructured as
a SvelteKit app.

## Development

Requirements: Node.js 26.7.x, npm 11.19.x, Docker, and Docker Compose 2.30 or newer.

```powershell
.\scripts\start-dev.ps1
```

The launcher creates `.env` from `.env.example` when needed, installs the locked dependencies, applies committed migrations, and starts the app, worker, PostgreSQL, and Mailpit. It waits for healthy services and then returns to PowerShell. The storefront runs at `http://localhost:5173`; Mailpit runs at `http://localhost:8025`; the PostgreSQL-backed worker is private to Compose.

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

See [authentication and email operations](docs/authentication-and-email.md), [runtime environments](docs/runtime-environments.md), and [database and workers](docs/database-and-workers.md) for migrations, process secrets, health checks, tests, logs, shutdown, and cleanup commands.

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

Development retains the clickable frontend prototype around durable authentication and administration. The production Compose baseline is deliberately locked to maintenance mode until later backend plans replace the prototype catalog, local purchase grants, in-memory entitlements, and fake file-delivery seams.

## Routes

| Route | What it is |
| --- | --- |
| `/` | Storefront: hero, recent releases, three-up feature strip |
| `/catalog` | All titles, filter by novel / comic |
| `/book/[id]` | Detail: cover, summary, excerpt, contents, buy / free chapter |
| `/read/[id]` | The reader. `?sample=1` opens the free-chapter mode |
| `/library` | The shelf: spines, progress, resume, email / download |
| `/studio` | Admin: publish a title by pasting a manuscript |
| `/checkout/[id]` | Order summary → Stripe Checkout |
| `/checkout/success` | Post-payment landing |
| `/api/checkout` | Creates the Stripe Checkout Session |
| `/api/stripe-webhook` | Fulfillment: grants entitlement, sends the file |
| `/api/deliver` | Re-send / re-download a purchased file |

## The reader

`src/lib/components/BookReader.svelte` is the whole experience:

- **Spread** — two pages on desktop, one on mobile (`vw < 900`).
- **Page turn** — each sheet is a `preserve-3d` element rotating on its left
  edge. `.face.front` / `.face.back` are `backface-visibility: hidden`, and at
  rest the off-side face is also `visibility: hidden` so nothing bleeds through.
  A gradient overlay per face tracks `sin(angle)` for the spine shadow and the
  highlight along the curling edge.
- **Drag** — pointer events on `.book`; the drag ratio is `dx / half-width`,
  released past 0.28 to commit the turn. Also arrow keys and the left/right
  edge hit zones.
- **Pagination** — `src/lib/paginate.ts` derives a character budget from the
  *measured* page box (`pageBox()`), so text reflows on resize and type-size
  change instead of clipping.
- **Comics** — page view uses the same sheets with a panel grid; guided view
  walks panel-by-panel with an absolute page index and frames each panel to its
  own aspect ratio.
- **Free sample** — `freeSheets()` finds the last sheet of chapter one; past it
  the paywall covers the stage.

Reader prefs (type size, typeface, paper), progress and bookmarks live in
`src/lib/stores/library.svelte.ts` (localStorage; move to the account when auth
is real).

## Styling

Plain CSS. Global tokens and primitives in `src/app.css`; everything else is
scoped component CSS. Themes are attribute-based: `:root[data-theme="vellum"]`
overrides the token block, `theme.set()` writes `document.documentElement`.

Two themes ship: **Nocturne** (default) and **Vellum**. Add a third by appending
to `THEMES` in `src/lib/stores/theme.svelte.ts` and a matching token block.

## Data

`src/lib/data/catalog.ts` holds the seed titles; `src/lib/stores/titles.svelte.ts`
merges them with anything published in Studio. Swap both for `load()` functions
against your DB — components only use `titles.all` / `titles.get(id)`, and the
`Title` union is defined in `src/lib/types/catalog.ts`.

The prototype schema sketch is in `src/lib/server/db.ts`; the approved PostgreSQL
model is in the full-stack design specification.

## Payments

1. `/checkout/[id]` POSTs to `/api/checkout`.
2. The server creates a Stripe Checkout Session with `metadata.titleId` and
   redirects the browser to Stripe — no card data touches this app.
3. `/api/stripe-webhook` verifies the signature and grants the purchase. This is
   the only place fulfillment happens; the success page is just UI.

```bash
stripe listen --forward-to localhost:5173/api/stripe-webhook
```

## Auth

Better Auth provides verified email/password accounts, password reset, magic
links, and PostgreSQL-backed sessions and rate limits. `src/hooks.server.ts`
resolves the session and project roles into `locals`; every `/admin` route and
action enforces authorization on the server. Administrators can manage audited
admin grants at `/admin/users`, with transactional protection against removing
the last administrator. Third-party OAuth is intentionally out of scope.

## Delivery

Versioned authentication messages are queued through the PostgreSQL outbox and
sent by the worker through a provider-neutral SMTP adapter. Development SMTP is
captured by Mailpit; production credentials come from the deployment process as
Compose secrets. The later storage plan retains EPUB and CBZ/ZIP originals on
local disk behind an adapter, with an S3-compatible stub for future use.

## Not yet wired

- Real cover art and comic page images (placeholders are CSS gradients / hatch
  patterns — see `CoverArt.svelte` and `PageFace.svelte`).
- Server-side entitlement checks on `/read/[id]` (currently client-side).
- Search, series grouping, pre-orders, reviews.
