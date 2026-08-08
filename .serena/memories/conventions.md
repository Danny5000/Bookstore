# Project conventions

- Use Svelte 5 runes (`$state`, `$derived`, `$effect`); rune-backed reusable client stores live in `*.svelte.js`.
- Stores are small classes exported as singleton instances. Guard browser-only initialization and `localStorage` access with SvelteKit's `browser` check.
- Client state boundaries:
  - `titles` merges seed catalog with Studio-published titles.
  - `library` owns entitlements, progress, reflow-stable anchors, bookmarks, and reader preferences.
  - `session` is UI-only placeholder auth; do not treat it as server authorization.
  - `theme` writes `document.documentElement.dataset.theme`.
- Prefer `$lib/...` aliases for source imports. Server-only modules and secrets stay under `src/lib/server` or server route handlers; private configuration uses `$env/dynamic/private`.
- SvelteKit API endpoints export named HTTP functions (currently async `POST` handlers). Preserve webhook signature verification and keep fulfillment idempotency concerns at that boundary.
- Catalog-driven components depend on the stable Title shape and `titles.all` / `titles.get(id)`; replace persistence behind those seams rather than coupling components to a database.
- Global visual tokens live in `src/app.css`; component-specific styling remains scoped. Themes are `data-theme` token overrides. Add a theme in both the theme store's list and a matching token block.
- Existing JS style: two-space indentation, semicolons, single-quoted strings; keep source as JS unless the project deliberately migrates.
- Reader layout behavior is measurement-driven. Avoid hard-coded pagination that bypasses `pageBox()` / `paginate()`, and preserve desktop two-page vs mobile single-page behavior.