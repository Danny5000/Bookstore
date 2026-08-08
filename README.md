# Pale Orbit Press — SvelteKit

Bookstore + in-browser reader for novels and comics. Ported from the HTML design
prototype: same layout, tokens, typography and page-turn engine, restructured as
a SvelteKit app.

```bash
npm install
cp .env.example .env      # add Stripe + mail keys when you have them
npm run dev
```

Runs with no keys configured — checkout falls back to a local grant so the whole
flow stays clickable.

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
- **Pagination** — `src/lib/paginate.js` derives a character budget from the
  *measured* page box (`pageBox()`), so text reflows on resize and type-size
  change instead of clipping.
- **Comics** — page view uses the same sheets with a panel grid; guided view
  walks panel-by-panel with an absolute page index and frames each panel to its
  own aspect ratio.
- **Free sample** — `freeSheets()` finds the last sheet of chapter one; past it
  the paywall covers the stage.

Reader prefs (type size, typeface, paper), progress and bookmarks live in
`src/lib/stores/library.svelte.js` (localStorage; move to the account when auth
is real).

## Styling

Plain CSS. Global tokens and primitives in `src/app.css`; everything else is
scoped component CSS. Themes are attribute-based: `:root[data-theme="vellum"]`
overrides the token block, `theme.set()` writes `document.documentElement`.

Two themes ship: **Nocturne** (default) and **Vellum**. Add a third by appending
to `THEMES` in `src/lib/stores/theme.svelte.js` and a matching token block.

## Data

`src/lib/data/catalog.js` holds the seed titles; `src/lib/stores/titles.svelte.js`
merges them with anything published in Studio. Swap both for `load()` functions
against your DB — components only use `titles.all` / `titles.get(id)`, and the
`Title` shape is documented in `catalog.js`.

Suggested schema is in `src/lib/server/db.js`.

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

`src/hooks.server.js` puts `locals.user` in place; `session.svelte.js` is a
localStorage placeholder for the UI. Pick one real implementation:

- **Lucia** — full control, own your tables.
- **Auth.js (@auth/sveltekit)** — Google / Apple providers and magic links out
  of the box.
- **Supabase / Clerk** — hosted, fastest to ship.

The UI already covers: password sign-in, magic link, Google, Apple, and guest
checkout (account created from the receipt email).

## Delivery

`src/lib/server/mail.js` is the seam. EPUB is a zip of XHTML + OPF + NCX
(`epub-gen-memory` works server-side); PDF can be a Playwright print of the same
chapter HTML. Store built files in object storage and email a link or an
attachment; `/api/deliver` re-issues both for owners.

## Not yet wired

- Real cover art and comic page images (placeholders are CSS gradients / hatch
  patterns — see `CoverArt.svelte` and `PageFace.svelte`).
- Server-side entitlement checks on `/read/[id]` (currently client-side).
- Search, series grouping, pre-orders, reviews.
