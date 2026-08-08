# Bookstore core

- Pale Orbit Press: SvelteKit storefront + in-browser reader for novels/comics; full-stack monolith.
- Source map:
  - `src/routes/**`: pages and SvelteKit API handlers; dynamic title routes use `[id]`.
  - `src/lib/components/**`: UI; `BookReader.svelte` owns page-turn, drag/keyboard navigation, pagination, comic guided mode, sample paywall.
  - `src/lib/stores/**.svelte.js`: client singleton state for titles, library/progress/preferences, theme, and placeholder session.
  - `src/lib/data/catalog.js`: seed title records and documented Title shape.
  - `src/lib/server/{db,mail}.js`: replaceable persistence/delivery seams; current DB is in-memory.
  - `src/hooks.server.js`: server request user placeholder via `locals.user`.
- Purchase invariant: entitlement fulfillment belongs only in `/api/stripe-webhook`; checkout success is presentation, never authority.
- Reader invariant: durable text anchors survive repagination; sheet/page positions are derived from current measured layout.
- App intentionally works without external keys: checkout falls back to a local grant for the clickable prototype.
- Auth, durable DB/object storage, entitlement enforcement on reader routes, and real mail/file delivery are not production-wired.
- Stack/version/build details: `mem:tech_stack`.
- Code and UI patterns: `mem:conventions`.
- Local workflows: `mem:suggested_commands`.
- Required completion evidence: `mem:task_completion`.