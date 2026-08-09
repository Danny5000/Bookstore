# Plan 5: Customer Library, Entitled Reader, and Downloads Design

**Date:** 2026-08-09

**Status:** Approved

**Depends on:** Plans 1-4 and `2026-08-08-bookstore-full-stack-design.md`

## 1. Purpose

Plan 5 completes the customer reading experience on top of Plan 4's durable catalog and publication workflow. It replaces browser-owned library state with PostgreSQL-backed entitlements, serves complete active editions only to authorized customers or administrators, persists reader state across devices, and streams the active retained original through the application.

Stripe checkout, payment fulfillment, guest purchase claiming, refunds, and financial reporting remain Plan 6 work. Plan 5 supplies the effective entitlement and access-policy boundary that those workflows will consume.

## 2. Goals

Plan 5 will provide:

- One shared access decision for public previews, entitled customers, and administrators.
- A durable effective entitlement record for each user and title.
- A server-backed customer library that preserves withdrawn and archived purchases.
- Full reading of the current active edition for entitled customers.
- Authorization-aware cover and derived-media delivery.
- Direct authenticated EPUB and CBZ/ZIP downloads of the current active retained original.
- PostgreSQL-backed progress, bookmarks, account-wide display preferences, and per-title comic mode.
- Optimistic cross-device progress concurrency in which stale writes cannot silently replace newer state.
- Exact-only progress and bookmark migration when an administrator activates a corrected revision.
- Device-local, presentation-scoped state for anonymous previews.
- Removal of browser-granted ownership and the in-memory prototype purchase/delivery paths.

## 3. Non-goals

Plan 5 does not implement:

- Stripe Checkout, orders, payments, webhook fulfillment, refunds, disputes, or reconciliation.
- A customer, administrator, CLI, or development route that grants production entitlements.
- Guest purchase access or guest-to-user claiming.
- Email attachments or emailed download links. Plan 6 purchase messages may link customers to the authenticated library.
- Historical-edition customer reading or downloads. Customers receive the current active edition.
- Annotations, highlights, notes, social reading, sharing, lending, or offline-reader support.
- Approximate progress migration by page number, ordinal, or percentage.
- Importing local prototype ownership as trusted server state.
- Redis, a cache service, or a new background worker topic.
- Opening the production storefront. Production remains in maintenance mode until Plan 6 supplies a legitimate acquisition path.

## 4. Chosen architecture

Plan 5 extends the modular SvelteKit monolith with focused server modules:

- `access` resolves `preview`, `entitled`, `admin`, or denied access from the session actor, title, active revision, presentation, entitlement, and requested asset.
- `library` lists effective entitlements and current title availability without hiding purchased titles when content is temporarily unavailable.
- `reader-state` validates semantic locations, handles optimistic writes, migrates state between revisions, and returns reader-facing notices.
- `catalog/reader` builds preview, entitled, and administrator documents after access has been resolved.
- `catalog/media` and the customer download route stream only objects authorized by the shared access decision.

SvelteKit server loaders provide the initial library, reader document, and reader state. Narrow same-origin mutation endpoints persist progress, bookmarks, and preferences. The reader remains progressively enhanced and does not become a client-only API application.

`BookReader` receives an explicit persistence adapter and initial state. An entitled adapter talks to the server; a preview adapter uses presentation-scoped local storage. The component does not import a global ownership store and cannot grant itself access.

No new runtime dependency is expected. Drizzle, PostgreSQL, SvelteKit, the existing storage abstraction, and the existing HTTP range/media helpers cover the required behavior.

## 5. Access model

### 5.1 Access levels

Reader access expands from `preview | admin` to `preview | entitled | admin`.

- An anonymous user or signed-in customer without an active entitlement may access only a public title's approved preview.
- A signed-in customer with an active entitlement may access the complete current active revision and its published presentation.
- An entitled customer retains library, reader, cover, derived-media, and original-download access when the title is withdrawn to `private` or later archived.
- A revoked entitlement no longer grants full access. A public preview may still be available independently.
- An administrator retains the existing full active/candidate review access and original-download access.
- A customer never receives a retired or candidate revision through the customer reader or download route.

The policy resolves active content at request time. The entitlement points to the stable title, not a revision, so a deliberate replacement or rollback changes the edition served on the customer's next request.

### 5.2 Resource disclosure

An inaccessible private reader or media resource returns the same not-found response as a nonexistent one. Storage keys, local paths, object-provider details, and private-title metadata never enter a client DTO or error response.

Library routes may return `401` with a sign-in action because the customer intentionally navigated to an account surface. A signed-in library entry can report that its current edition is temporarily unavailable without exposing storage or ingestion details.

### 5.3 Centralized decisions

Routes do not reproduce authorization predicates. The access service returns a typed decision containing the permitted access level, title, active revision, published presentation, and the minimum safe identifiers needed by the reader or media service.

The same decision rules govern:

- `/read/[slug]` full or preview documents;
- active-revision prose images and comic pages;
- current title covers;
- customer original downloads; and
- administrator review media through the established admin policy.

Every request rechecks current entitlement and publication state. A URL, checksum, title ID, revision ID, asset ID, or previously returned DTO is never proof of authorization.

## 6. Data model

Drizzle schema remains the source of truth. Generated SQL is committed and reviewed. All new timestamps use UTC, user/title/revision relationships use foreign keys, and important anchor shapes and uniqueness rules are enforced in PostgreSQL as well as the domain service.

### 6.1 Effective entitlements

`entitlements` stores:

- UUID primary key;
- user ID and title ID;
- grant timestamp;
- nullable revocation timestamp;
- creation and update timestamps.

A unique constraint covers `(user_id, title_id)`. An entitlement is active only when `revoked_at` is null. Plan 5 exposes lookup and authorization operations but no production grant or revoke command. Tests create records through database fixtures, never a shipping HTTP or CLI backdoor.

Plan 6 will add the commerce grant ledger and connect effective entitlement changes to fulfilled order items, claims, and refunds. Keeping effective access separate from future commerce evidence allows reader authorization to remain stable when payment details expand.

### 6.2 Revision-independent semantic fingerprints

Current ingestion IDs deliberately include the revision ID and therefore cannot migrate reader locations between revisions. Plan 5 adds a 64-character lowercase SHA-256 semantic fingerprint to prose blocks and comic pages.

For prose, the fingerprint is computed from a canonical representation of the sanitized block. It includes the block kind and normalized reader-visible content. An image block uses the referenced image's decoded-content fingerprint rather than its revision-specific image ID. Canonicalization is versioned so a future algorithm change cannot silently claim equality across incompatible versions.

For comics, the fingerprint is computed from normalized decoded pixel content and dimensions before output encoding. It is independent of archive path, revision ID, WebP encoder metadata, and storage key.

Fingerprints are indexed but are not unique: repeated paragraphs or duplicate comic pages are valid. Migration succeeds only when a prior fingerprint has exactly one compatible match in the target revision. Zero or multiple matches are unsafe and do not migrate.

### 6.3 Progress

`reader_progress` stores one row per `(user_id, title_id, revision_id)`:

- UUID primary key;
- format-specific semantic location;
- positive integer version;
- created and updated timestamps.

A prose location contains a same-revision block ID and a character offset within that block's normalized reader-visible content. Image and break blocks use offset zero. A comic location contains a same-revision page ID and an optional published-panel ordinal. A database check requires exactly one format shape.

Same-title and same-revision composite foreign keys prevent a client from constructing an anchor across unrelated records. Domain validation also proves the title format, current revision, published presentation, content bounds, and panel validity before a write.

Previous-revision rows remain as inactive history. The library and current reader select only the active revision's row.

### 6.4 Bookmarks

`reader_bookmarks` stores:

- UUID primary key;
- user, title, and revision IDs;
- the same validated prose or comic location shape used by progress;
- nullable `migrated_from_bookmark_id` lineage;
- creation timestamp.

Location uniqueness prevents duplicate current-revision bookmarks for one user. Deleting a current bookmark does not delete older-revision history. The normal reader returns only bookmarks for the active revision.

### 6.5 Preferences

`reader_preferences` has one row per user and stores bounded font size, allowed typeface, allowed paper theme, an optimistic version, and timestamps. These values are account-wide defaults shared across titles and devices.

`reader_title_preferences` has one row per user and title. Plan 5 uses it for the comic `page | guided` choice plus an optimistic version and timestamps. A guided choice is honored only when the active published presentation supports complete guided data; otherwise the reader safely uses whole-page mode without destroying the preference.

### 6.6 Revision migration records

`reader_revision_migrations` stores one result for a user, title, source revision, and target revision. It records:

- progress result: `migrated`, `reset`, or `absent`;
- whether a comic panel position was simplified to its exact matching whole page;
- migrated and unmatched bookmark counts;
- completion timestamp;
- nullable notice-acknowledgement timestamp.

The target-revision uniqueness rule makes migration one-time and idempotent. The record supplies a deterministic edition-change notice without recalculating or reapplying migration on each load.

## 7. Customer library

`/library` becomes a server-backed account surface. A signed-out visitor receives the established sign-in experience. A signed-in customer receives shelf entries by joining effective entitlements to titles and current publication state.

Each entry contains safe title metadata, cover access, format, current availability, current-revision progress summary, read/resume URL, and download availability. It does not contain an object key, original filename, or revision history.

Withdrawn and archived entitled titles remain on the shelf. If an entitled title lacks a valid active revision and published presentation, it remains visible as temporarily unavailable instead of disappearing. That state does not expose candidate or failure details.

The library displays format-specific direct download controls: EPUB for prose and the retained CBZ/ZIP filename type for comics. The prototype “Email me the file” action is removed.

## 8. Reader flow

The normal reader route resolves access in this order:

1. administrator full access;
2. active customer entitlement and full active edition;
3. public approved preview;
4. uniform not found or forbidden behavior.

The loader returns the authorized `ReaderDocument`, initial account state when applicable, a safe migration notice, and persistence capability. An entitled response uses private no-store caching. A preview response remains truncated by the published semantic boundary before it reaches the browser.

The full reader uses the same active revision and published presentation as the customer download route. Entitled documents contain all prose blocks/images or all comic pages/panels. Preview documents continue to contain only the approved subset.

Viewport page or sheet numbers are never authoritative state. After pagination, the reader maps the semantic prose block/offset or comic page/panel to the current viewport. Font, window, and single/double-page changes can repaginate without changing the stored reading location.

## 9. Reader persistence and concurrency

### 9.1 Entitled adapter

The entitled persistence adapter receives initial state from the server and performs narrow same-origin JSON mutations for:

- progress updates;
- bookmark creation and deletion;
- account preference updates;
- per-title preference updates; and
- migration-notice acknowledgement.

Every mutation derives the user from `locals`, rechecks entitlement and the current active revision, validates the anchor against database content, rejects unknown fields, and applies bounded payload limits. No payload may select another user or claim an access level.

Progress updates are debounced during ordinary navigation and flushed when practical during explicit navigation or page lifecycle changes. Bookmark mutations are immediate. The client shows pending and failed synchronization states and retries transient failures while the page remains active; it never reports a failed write as synchronized.

### 9.2 Optimistic versions

A mutation carries the version it was based on. An update succeeds only when that version still matches, increments the version, and returns the authoritative row.

A stale mutation receives `409` plus the safe current state. The client adopts the authoritative value before it can submit another intentional location. This implements “latest confirmed activity wins” while still allowing a reader to move backward deliberately. Maximum page number or percentage is never used as a conflict rule.

### 9.3 Preview adapter

Anonymous and non-entitled preview state remains device-local and is keyed by the published presentation ID. It may remember preview progress, bookmarks, and display settings for that device, but it cannot call entitlement-only mutations and is never imported as proof of ownership.

When a customer later receives an entitlement, server account progress and bookmarks are canonical. Preview locations and bookmarks are not automatically promoted. Account preferences replace preview defaults after the entitled document loads.

## 10. Exact revision migration

Migration is lazy rather than a publication-time fan-out. It runs when an entitled customer first loads a title whose active revision has no current reader state but has state on an older revision.

The transaction obtains locks in a documented consistent order, resolves the active revision again after the serialization point, and rechecks entitlement. A per-user/title/target-revision uniqueness constraint makes concurrent loads idempotent.

For prose progress, the service finds exactly one target block with a compatible fingerprint and preserves the validated character offset because identical canonical content has the same normalized length. Otherwise it creates a beginning location and records `reset`.

For comic progress, the service requires exactly one matching page fingerprint. It preserves the panel ordinal only when the target published presentation contains the same normalized panel geometry at that ordinal; otherwise it resumes at the matching page in whole-page position.

Each bookmark migrates only when its target is exact and unique. A migrated bookmark is inserted for the target revision with lineage to the old bookmark. Unmatched old bookmarks remain stored against the old revision and are not returned as navigable current links.

The migration record returns a clear notice when the edition changed, progress restarted, a panel position was simplified, or bookmarks could not move. Existing target-revision state is never overwritten by migration.

## 11. Media and original downloads

### 11.1 Derived media and covers

Public preview media authorization proves that the requested asset is reachable within the active published preview boundary. For prose, later-block images are denied even if their IDs are known. For comics, pages after the preview boundary are denied.

Entitled media authorization requires that the asset belong to the title's current active revision. Administrator media retains the existing candidate/full-review policy. Withdrawn or archived covers require an active entitlement or administrator role.

Public and private responses use access-appropriate cache policy. Private/entitled media is never emitted with a shared public cache directive. Checksums remain useful for ETags and URL versioning but are not authorization tokens.

### 11.2 Customer original download

The authenticated customer route resolves the effective entitlement, title, active revision, and retained-original metadata before opening storage. It supports `HEAD`, `GET`, and validated inclusive byte ranges through the existing streaming abstraction and never buffers the complete publication in the web process. `HEAD` returns the same authorized metadata and status that `GET` would return without opening a response body.

Responses provide:

- a sanitized format-appropriate filename;
- correct EPUB or CBZ/ZIP content type;
- `Content-Disposition: attachment`;
- checksum-based ETag;
- `Accept-Ranges` and correct partial-content headers;
- private no-store cache policy; and
- `X-Content-Type-Options: nosniff`.

The customer cannot select a revision ID. Each request resolves the active revision, keeping the downloadable original aligned with the edition served by the full reader. Historical originals remain administrator-only.

Authorization occurs when a stream begins. Revocation does not forcibly truncate an already authorized stream, but every later full or range request rechecks entitlement.

## 12. Prototype retirement

Plan 5 removes or makes explicitly unavailable every path that can create fake ownership:

- the in-memory `prototype-db` purchase map;
- browser `library.grant` ownership;
- success-page local entitlement grants;
- the prototype checkout endpoint and Stripe webhook behavior;
- placeholder direct-delivery URLs; and
- the “Email me the file” simulation.

The public title and preview UI may continue to display price, but purchase controls state clearly that checkout is not yet available. A direct request to a retired prototype checkout or delivery route cannot create access and returns a safe unavailable or not-found response until Plan 6 replaces it.

Local prototype title/library keys are ignored for authorization. They may be removed as a cleanup, but no client-owned value is migrated into PostgreSQL as an entitlement.

## 13. Customer experience

The existing visual language and reader interactions remain the baseline.

- The shelf comes from the server and shows empty, unavailable, read, resume, and download states.
- Pulling a shelf item opens the authorized reader as it does in the prototype.
- Entitled reading has no preview paywall and includes the complete active document.
- Preview reading retains the paywall boundary but cannot invoke unfinished commerce.
- Current-revision bookmarks remain navigable from the existing drawer.
- Edition-change and synchronization notices are accessible status messages and do not rely on color alone.
- Download labels identify EPUB or CBZ/ZIP instead of assuming every work is an EPUB.
- A stale-device response visibly refreshes the location rather than silently moving the reader.

Unmatched historical bookmarks are retained in PostgreSQL but are represented by the edition-change notice rather than broken navigation controls. A historical-edition or bookmark-history UI is outside Plan 5.

## 14. Audit, privacy, and logging

An accepted customer original-download request appends a redacted audit event containing only:

- actor user ID;
- title ID;
- active revision ID;
- outcome;
- correlation ID; and
- whether a range was requested.

The event excludes email, original filename, storage key, content, cookies, tokens, and request headers. Administrators may inspect it through the existing protected audit dashboard.

Routine progress, bookmarks, preference values, and reading locations are not copied into the administrative audit trail or ordinary structured logs. Safe logs may include correlation, user ID, title ID, result class, and conflict/failure code. Unexpected storage or database details remain server-side and are not returned to the browser.

## 15. Failure behavior

Plan 5 uses stable safe failures:

- `401` for an account surface that requires sign-in;
- uniform not found for inaccessible private reader or media resources;
- `409` with safe authoritative state for optimistic conflicts;
- `422` for malformed, out-of-bounds, wrong-format, or wrong-revision state payloads;
- `416` for invalid or unsatisfiable download ranges; and
- `503` for bounded temporary database or storage unavailability.

An entitlement or reader-state write is transactional. A failed preference or bookmark update cannot partially change another state record. Migration either commits its target state, bookmark lineage, and migration result together or changes nothing.

A missing active publication does not remove a title from an entitled library. A missing storage object or checksum mismatch fails closed, emits safe operational context, and never falls back to a candidate or retired original.

## 16. Security properties

- Session user ID, never email supplied by a client, selects entitlements and state.
- Full-reader, derived-media, cover, and download authorization all call the same access policy.
- Same-revision foreign keys and service validation reject cross-title and cross-revision anchors.
- Mutation endpoints require same-origin authenticated requests and strict bounded payloads.
- Reader DTOs do not contain storage keys, local paths, inactive revision details, or entitlement internals.
- Original downloads stream from private storage through the application; Caddy has no storage mount.
- State conflicts fail closed and cannot be bypassed by incrementing a client version arbitrarily.
- Prototype local-storage ownership and success redirects have no server authority.
- No Redis, public object-store bucket, presigned unauthenticated URL, or email attachment is introduced.

## 17. Environment and operations

Plan 5 adds no required environment variable, container, Compose service, job topic, or worker concurrency setting. It uses the existing PostgreSQL and private storage mounts.

The PostgreSQL backup/restore runbook expands to cover entitlements and reader state. Reader state is durable customer data but is not a substitute for orders or payment evidence. Original and derived publication backup rules remain those established in Plan 4.

Production remains in maintenance mode at the end of Plan 5. Development and automated tests may seed entitlements only through isolated database fixtures. No seed endpoint or credential is present in the production image.

## 18. Testing strategy

### 18.1 Unit tests

- Access matrices for anonymous, non-entitled, entitled, revoked, administrator, public, private, archived, active, and unavailable combinations.
- Canonical prose and comic fingerprint stability, versioning, duplicates, and ambiguity.
- Format-specific anchor parsing, bounds, wrong-revision rejection, and viewport-independent mapping.
- Optimistic version updates and stale-result mapping.
- Exact progress/bookmark migration, ambiguous matches, comic panel simplification, and idempotency.
- Preference bounds and safe guided-mode fallback.
- Safe filename, content type, ETag, range, and cache-header construction.

### 18.2 PostgreSQL integration tests

- Migration creation, constraints, same-title/revision foreign keys, and truncate order.
- Effective entitlement lookup and immediate revocation behavior.
- Entitled access to public, withdrawn, and archived titles.
- Unavailable titles remaining visible in the library.
- Progress, bookmarks, preferences, and per-title preference persistence.
- Concurrent progress writes in which one version wins and the stale writer receives current state.
- One-time lazy migration with exact, reset, partial-bookmark, and pre-existing-target-state outcomes.
- Transaction rollback for failed state and migration writes.
- Redacted customer-download audit events.

### 18.3 Route tests

- Signed-out library behavior and safe signed-in empty state.
- Preview truncation versus entitled complete documents.
- Private and archived entitled reading without public disclosure.
- Per-asset preview, entitlement, revision, and administrator authorization.
- Direct EPUB and CBZ/ZIP downloads, `HEAD`, full `GET`, valid ranges, invalid ranges, cancellation, filenames, and headers.
- State mutation authentication, origin handling, payload validation, wrong-revision denial, conflicts, and revocation.
- Prototype checkout, delivery, webhook, and success-page paths cannot grant access.

### 18.4 Browser tests

- A fixture-entitled customer signs in, sees the shelf, opens the complete work, bookmarks a location, resumes it in a new context, and downloads the original.
- Anonymous and non-entitled users receive only the approved preview and cannot fetch later media.
- A withdrawn entitled title remains readable and downloadable but disappears from the public catalog.
- Two authenticated browser contexts prove that a stale device cannot silently replace newer progress.
- Exact and unmatched replacement-revision fixtures prove migration and the edition-change notice.
- EPUB and comic journeys prove format-specific progress, bookmarks, preferences, guided fallback, and download labels.

### 18.5 Verification gates

The phase is complete only when:

- type checking and Svelte checking pass without warnings;
- lint passes;
- unit, PostgreSQL integration, route, and browser tests pass;
- web and service builds pass;
- Drizzle migration checks pass and generated SQL is reviewed;
- the direct-dependency tree remains valid and current-version/audit results are reviewed without forced upgrades;
- runtime dependencies have no unexplained high or critical advisory;
- development and production Compose configurations validate; and
- the final branch contains no fixture entitlement endpoint, prototype ownership path, or production-mode bypass.

## 19. Plan 6 handoff

Plan 6 consumes the effective entitlement lookup and access policy without moving reader authorization into commerce code. It adds:

- durable orders and order items;
- Stripe Checkout Session creation;
- signed idempotent webhook recording and payment fulfillment;
- commerce grant evidence that activates effective entitlements;
- guest purchase identity and later verified claiming;
- refund/dispute-driven entitlement decisions;
- balance-transaction and payout reconciliation; and
- sales, fee, and estimated-payout reporting.

Plan 6 must never grant access from a success redirect or unverified browser claim. Only durable verified fulfillment may change the effective entitlement projection.

## 20. Acceptance criteria

Plan 5 is accepted when:

1. Browser local storage, checkout success redirects, and prototype APIs cannot grant full access.
2. A fixture-entitled user sees every entitled title on a server-backed shelf, including withdrawn or archived titles.
3. The normal reader serves a complete current active edition only to an entitled customer or administrator and continues to serve only the approved preview to everyone else.
4. Covers and derived media enforce the same access decision as the reader document, including the semantic preview boundary.
5. Progress and bookmarks persist by semantic content location rather than viewport sheet number.
6. Account-wide display preferences and per-title comic mode synchronize across sessions.
7. A stale device cannot silently replace a newer confirmed location, while an intentional backward move based on current state remains valid.
8. A corrected edition migrates only exact unique anchors, safely restarts unmatched progress, retains unmatched bookmark history, and shows a deterministic notice.
9. Customer downloads stream only the current active retained original with safe names, ranges, cache policy, headers, and redacted audit context.
10. Revocation blocks the next reader, media, state, and download request without deleting historical state.
11. No customer can request a candidate, retired, unrelated, or historical revision by guessing identifiers.
12. Prototype purchase/delivery behavior is removed or safely unavailable, and production remains in maintenance mode.
13. The complete automated verification and production build/Compose gates pass.
