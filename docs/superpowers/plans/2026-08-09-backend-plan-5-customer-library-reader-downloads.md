# Backend Plan 5: Customer Library, Entitled Reader, and Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser-owned purchase and reading authority with PostgreSQL-backed effective entitlements, a server-backed customer library, complete entitled reading, cross-device reader state, exact-only revision migration, and authenticated original downloads while retaining safe anonymous previews.

**Architecture:** A single server-side access decision resolves administrator, effective-entitlement, public-preview, or denied access for every reader and media request. PostgreSQL owns entitlements, semantic locations, optimistic reader state, preferences, and migration outcomes; SvelteKit loaders provide initial data and same-origin mutation routes persist changes. `BookReader` consumes explicit server, preview-local, or memory persistence adapters instead of the prototype ownership store, and customer downloads stream the current active retained original through the existing provider-neutral storage layer.

**Tech Stack:** Node.js 26.7.0, npm 11.19.0, SvelteKit 2.70.2, Svelte 5.56.8, TypeScript 6.0.3, PostgreSQL 18.4, Drizzle ORM 0.45.2 and Drizzle Kit 0.31.10, Better Auth 1.6.26, Sharp 0.35.3, Zod 4.4.3, Vitest 4.1.10, and Playwright 1.62.1.

---

## Source of truth and boundaries

This plan implements `docs/superpowers/specs/2026-08-09-customer-library-reader-entitlements-design.md` and the Plan 5 handoff in `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md`. It consumes the completed Plan 4 publication, storage, reader-manifest, audit, and administrator contracts.

Preserve these boundaries throughout execution:

- Plan 5 stores and evaluates effective entitlements, but exposes no customer, administrator, CLI, test, or development grant/revoke route. Plan 6 grants and revokes entitlements from payment, guest-claim, refund, and dispute workflows.
- Customers read and download only the title's current active revision. Candidate, retired, and arbitrary historical revisions remain administrator-only.
- A public preview remains independently available to anonymous and non-entitled visitors only when the title is public and has an active revision with a published presentation.
- An active entitlement survives title withdrawal and archival. The purchased title remains on the shelf and its current active edition remains readable/downloadable. Missing active content is shown as temporarily unavailable rather than hidden.
- Preview state is device-local and scoped to a published presentation. Entitled progress, bookmarks, and preferences are server-canonical and must not trust local ownership or local progress as authority.
- Revision migration is exact-only. Match one versioned semantic fingerprint to exactly one target item; never infer by page number, ordinal, percentage, or nearest position. Retain unmatched historical bookmarks and show a reset/migration notice.
- The latest confirmed write wins. Every mutable singleton has an optimistic version, stale requests receive the authoritative current value, and a stale writer never silently overwrites newer state.
- Original delivery is a direct authenticated application download. Do not email files, expose storage keys, mount storage through Caddy, mint public URLs, or add an S3 SDK in this phase.
- Keep PostgreSQL as the only coordination store. Do not add Redis, a new worker topic, or a cache invalidation system.
- Keep production `APPLICATION_MODE=maintenance` until Plan 6 provides a legitimate purchase path.
- Preserve Plan 4's per-title advisory lock as the first lock for any active-revision-sensitive transaction. Acquire the reader user/title lock second and re-read authorization after both serialization points.
- All authorization comes from `locals.actor` and server-side data. Error responses, DTOs, audit details, and logs never disclose private metadata, email addresses, storage keys, object-provider details, local paths, or reader content.

## Dependency disposition

Do not add a runtime dependency for Plan 5. The existing PostgreSQL, Drizzle, Sharp, SvelteKit, Zod, storage, range-response, audit, and test infrastructure covers the feature.

Preflight on 2026-08-09 established:

- `npm outdated --json` reports only TypeScript: installed/wanted `6.0.3`, registry latest `7.0.2`.
- `typescript-eslint@8.66.0` declares TypeScript `>=4.8.4 <6.1.0`; `svelte-check@4.7.5` declares `^5 || ^6`. Keep TypeScript at `6.0.3` until the complete lint/check toolchain supports 7.x.
- The production audit contains no high or critical advisory. Low cookie advisories and the Drizzle Kit development-only esbuild path are already dispositioned in `docs/dependency-decisions.md`; do not accept npm's invalid Drizzle downgrade suggestion.
- Do not remove the existing Stripe package: Plan 6 will use it. Make prototype checkout routes unavailable without inventing a replacement commerce implementation.

Re-run the dependency evidence in Task 1 and update the documentation only if registry state or peer ranges changed.

## Domain invariants

- An effective entitlement is the unique `(user_id, title_id)` row whose `revoked_at` is null. It points to a stable title, never to a revision.
- Access precedence is `admin` over `entitled` over `preview` over denied. A revoked entitlement may still fall back to a qualifying public preview.
- Reader locations are discriminated semantic values: prose uses `(block_id, offset)` and comics use `(page_id, panel_ordinal | null)`. A viewport sheet number is never persisted.
- A prose offset is relative to the canonical reader-visible text of one semantic block. It must be within that block's inclusive end boundary.
- New prose blocks and comic pages carry a paired fingerprint digest and fingerprint version. Historical Plan 4 rows may have both values null; a check constraint forbids only-one-null rows. Null-fingerprint legacy state is safely non-migratable.
- An image semantic fingerprint is derived from orientation-normalized decoded pixels plus dimensions and an explicit fingerprint-format marker, not WebP output bytes, filenames, object keys, or revision IDs.
- A prose fingerprint hashes versioned canonical sanitized block content. Image blocks substitute the referenced decoded-image fingerprint for the revision-specific image ID.
- Duplicate fingerprints are legal. Migration succeeds only when the source fingerprint has exactly one target match of the same version.
- Reader-state mutation validates the location belongs to the requested title's current active revision and visible presentation before writing.
- Progress is one versioned row per `(user, title, revision)`. Account preferences are one versioned row per user. Comic mode is one versioned row per `(user, title)`.
- Bookmarks are immutable location records. Exact migration creates new target-revision bookmarks with lineage and leaves old-revision bookmarks intact.
- A `(user, title, source revision, target revision)` migration result is recorded once. Repeated loads are idempotent and never overwrite target-revision state that already exists.
- If the active revision changes during a write or migration, the transaction retries or rejects safely; it never commits state against a revision that is no longer active.
- Customer media and download requests re-evaluate entitlement and the active revision on every request, including every HTTP range request.
- `HEAD` returns the same authorized metadata headers as `GET` without opening the storage object body.

## Target data shapes

Create the shared contract in `src/lib/types/library.ts` and keep it free of server imports:

```ts
export type ProseReaderLocation = {
  format: 'prose';
  blockId: string;
  offset: number;
};

export type ComicReaderLocation = {
  format: 'comic';
  pageId: string;
  panelOrdinal: number | null;
};

export type ReaderLocation = ProseReaderLocation | ComicReaderLocation;

export interface ReaderProgressDto {
  revisionId: string;
  location: ReaderLocation;
  version: number;
  updatedAt: string;
}

export interface ReaderBookmarkDto {
  id: string;
  revisionId: string;
  location: ReaderLocation;
  createdAt: string;
}

export interface ReaderPreferencesDto {
  fontSize: number;
  typeface: 'serif' | 'sans' | 'georgia';
  paper: 'white' | 'sepia' | 'dim';
  version: number;
}

export interface ReaderTitlePreferencesDto {
  titleId: string;
  comicMode: 'page' | 'guided';
  version: number;
}

export interface ReaderMigrationNoticeDto {
  targetRevisionId: string;
  progress: 'migrated' | 'reset' | 'absent';
  panelPositionSimplified: boolean;
  migratedBookmarkCount: number;
  unmatchedBookmarkCount: number;
  acknowledged: boolean;
}
```

`LibraryEntryDto` must contain only safe customer-facing title metadata, cover URL, availability (`available | temporarily_unavailable`), current revision ID when available, progress summary, and application-owned read/resume/download URLs. Do not include an entitlement row ID, user ID, storage metadata, draft presentation, retired revision, or object key.

## Target persistence model

Add `src/lib/server/db/schema/library.ts` and export it from `src/lib/server/db/schema/index.ts`:

| Table | Required columns and constraints |
| --- | --- |
| `entitlements` | UUID PK; user/title FKs; granted, revoked, created, updated timestamps; unique user/title; index active rows by user; no revision FK |
| `reader_progress` | UUID PK; user/title/revision FKs; discriminated prose/comic columns; `version >= 1`; created/updated; unique user/title/revision; composite FKs prove the block/page belongs to the same title and revision |
| `reader_bookmarks` | UUID PK; user/title/revision FKs; discriminated location; optional self-FK `migrated_from_bookmark_id`; created timestamp; composite FKs; partial semantic uniqueness for prose and comic locations |
| `reader_preferences` | user PK/FK; font size `14..24`; constrained typeface and paper values; `version >= 1`; created/updated |
| `reader_title_preferences` | user/title composite PK; constrained comic mode; `version >= 1`; created/updated |
| `reader_revision_migrations` | UUID PK; user/title/source/target revision FKs; progress outcome; panel-position-simplified boolean; migrated/unmatched counts; completed/acknowledged timestamps; unique user/title/source/target plus unique user/title/target for one-time target migration |

Extend `prose_blocks` and `comic_pages` with nullable `semantic_fingerprint_sha256` and `semantic_fingerprint_version`. Add paired-null checks, digest-shape checks, and `(revision_id, fingerprint_version, fingerprint_sha256)` indexes. Add the composite unique keys required by reader-state foreign keys without weakening existing Plan 4 constraints.

Generate `drizzle/0004_plan5_reader_library.sql` and matching `drizzle/meta` state with Drizzle Kit. Never hand-number or manually replace the generated snapshot. Review the SQL for foreign-key order, check constraints, partial indexes, and non-destructive changes before applying it.

## Target module and route map

### Shared contracts, fingerprints, and schema

- `src/lib/types/library.ts` — browser-safe library, location, state, conflict, and migration-notice DTOs.
- `src/lib/server/reader-state/fingerprint.ts` — versioned pixel/prose fingerprint construction and canonicalization.
- `src/lib/server/ingestion/image.ts`, `epub.ts`, `comic.ts`, `handler.ts` — compute and persist semantic fingerprints during bounded ingestion.
- `src/lib/server/db/schema/library.ts`, `catalog.ts`, `index.ts`, `drizzle/0004_plan5_reader_library.sql`, `drizzle/meta/**` — Plan 5 persistence.

### Server domain

- `src/lib/server/library/access.ts` — effective-entitlement lookup and the one reader/media access decision.
- `src/lib/server/library/query.ts` — safe server-backed customer shelf and progress summaries.
- `src/lib/server/reader-state/errors.ts` — not-found, stale-version, invalid-location, and active-revision-change errors.
- `src/lib/server/reader-state/anchors.ts` — semantic location validation and visible-text limits.
- `src/lib/server/reader-state/service.ts` — progress, bookmark, preference, title-mode, and notice operations.
- `src/lib/server/reader-state/migration.ts` — serialized exact-only lazy revision migration.
- `src/lib/server/reader-state/lock.ts` — deterministic user/title advisory lock acquired after the title lock.
- `src/lib/server/catalog/reader.ts`, `media.ts` — entitled full-document/media resolution through the shared access decision.
- `src/lib/server/http/media-response.ts` — authorized `HEAD`, complete `GET`, and single-range `GET` behavior.

### SvelteKit routes and client

- `src/routes/+page.server.ts`, `src/routes/+page.svelte` — database-backed storefront home and direct-download wording.
- `src/routes/library/+page.server.ts`, `+page.svelte` — authenticated shelf with availability and progress.
- `src/routes/read/[id]/+page.server.ts`, `+page.svelte` — preview or entitled reader plus initial state.
- `src/routes/library/[titleId]/download/+server.ts` — authenticated current-original stream.
- `src/routes/api/reader-state/route-support.ts` — strict JSON, same-origin, authentication, correlation, and domain-error mapping.
- `src/routes/api/reader-state/[titleId]/progress/+server.ts` — progress PUT.
- `src/routes/api/reader-state/[titleId]/bookmarks/+server.ts` and `[bookmarkId]/+server.ts` — bookmark POST/DELETE.
- `src/routes/api/reader-state/preferences/+server.ts` — account display-preference PUT.
- `src/routes/api/reader-state/[titleId]/preferences/+server.ts` — per-title comic-mode PUT.
- `src/routes/api/reader-state/[titleId]/migration-notice/+server.ts` — notice acknowledgement PATCH.
- `src/lib/reader/locations.ts`, `persistence.ts`, `progress-sync.ts` — viewport/semantic mapping, adapters, and debounce/conflict state machine.
- `src/lib/components/BookReader.svelte`, `BookVolume.svelte`, reader drawers — explicit persistence and publication-shaped inputs.

### Retirement, tests, and operations

- Remove browser ownership and prototype commerce/delivery modules/routes after all consumers are migrated: `src/lib/stores/library.svelte.ts`, `src/lib/stores/titles.svelte.ts`, `src/lib/server/prototype-db.ts`, `src/lib/server/mail.ts`, `src/lib/types/api.ts`, `/api/checkout`, `/api/stripe-webhook`, `/api/deliver`, `/checkout/**`, plus now-unused prototype catalog/type/pagination files.
- Preserve the Stripe dependency for Plan 6 and preserve visual components that accept narrowed server DTOs.
- Add focused unit tests beside each module; extend PostgreSQL integration and route suites; add `tests/e2e/library-reader.spec.ts` and direct database test helpers.
- Create `docs/customer-library-and-reader.md`; update `README.md`, `docs/runtime-environments.md`, `docs/database-and-workers.md`, `docs/storage-ingestion-and-publication.md`, `docs/authentication-and-email.md`, and `docs/dependency-decisions.md` where ownership, delivery, backup, or dependency statements change.

## Task 1: Freeze dependency disposition and add shared library contracts

**Files:**
- Create: `src/lib/types/library.ts`
- Create: `src/lib/types/library.test.ts`
- Modify: `docs/dependency-decisions.md`

- [x] **Step 1: Reconfirm current, wanted, and supported dependency versions**

Run:

```powershell
npm outdated --json
npm view typescript version --json
npm view typescript-eslint@8.66.0 peerDependencies --json
npm view svelte-check@4.7.5 peerDependencies --json
npm audit --omit=dev --json
```

Expected: TypeScript is the only outdated direct dependency; the installed/wanted version is `6.0.3`, registry latest is `7.0.2`, `typescript-eslint` rejects 7.x, `svelte-check` accepts only 5.x/6.x, and the runtime audit has zero high/critical advisories. If those facts changed, use official package metadata/release notes to update this plan and `docs/dependency-decisions.md` before installing anything. Do not run `npm audit fix --force`.

- [x] **Step 2: Write failing runtime-contract tests**

Create `src/lib/types/library.test.ts`. Exercise strict Zod schemas exported beside the TypeScript DTOs so route code and tests share one definition:

```ts
import { describe, expect, it } from 'vitest';
import {
  readerLocationSchema,
  readerPreferencesInputSchema,
  readerTitlePreferencesInputSchema
} from './library';

describe('reader location contracts', () => {
  it('accepts one discriminated semantic location', () => {
    expect(readerLocationSchema.parse({ format: 'prose', blockId: crypto.randomUUID(), offset: 8 }))
      .toEqual(expect.objectContaining({ format: 'prose', offset: 8 }));
    expect(readerLocationSchema.parse({
      format: 'comic', pageId: crypto.randomUUID(), panelOrdinal: null
    })).toEqual(expect.objectContaining({ format: 'comic', panelOrdinal: null }));
  });

  it.each([
    { format: 'prose', blockId: crypto.randomUUID(), offset: -1 },
    { format: 'comic', pageId: crypto.randomUUID(), panelOrdinal: -1 },
    { format: 'prose', blockId: crypto.randomUUID(), offset: 0, sheet: 12 }
  ])('rejects invalid or extra location fields', (value) => {
    expect(() => readerLocationSchema.parse(value)).toThrow();
  });
});
```

Also assert font size bounds `14..24`, the existing `serif | sans | georgia` typeface IDs, the existing `white | sepia | dim` paper IDs, the exact comic-mode enum, nonnegative expected versions, UUID IDs, and rejection of unknown keys.

- [x] **Step 3: Prove the contract tests fail**

Run:

```powershell
npx vitest run src/lib/types/library.test.ts
```

Expected: FAIL because `src/lib/types/library.ts` does not exist.

- [x] **Step 4: Implement the browser-safe DTOs and strict schemas**

Create `src/lib/types/library.ts` with the target location/state shapes above plus:

```ts
export interface LibraryEntryDto {
  titleId: string;
  slug: string;
  title: string;
  creatorName: string;
  format: 'prose' | 'comic';
  coverUrl: string | null;
  availability: 'available' | 'temporarily_unavailable';
  activeRevisionId: string | null;
  downloadFormat: 'epub' | 'cbz' | 'zip' | null;
  progressPercent: number | null;
  readUrl: string | null;
  resumeUrl: string | null;
  downloadUrl: string | null;
}

export interface ReaderInitialStateDto {
  progress: ReaderProgressDto | null;
  bookmarks: ReaderBookmarkDto[];
  preferences: ReaderPreferencesDto;
  titlePreferences: ReaderTitlePreferencesDto | null;
  migrationNotice: ReaderMigrationNoticeDto | null;
}

export interface StaleReaderStateDto<T> {
  code: 'STALE_VERSION';
  current: T;
}
```

Export strict request schemas for progress PUT, bookmark POST, preferences PUT, title-preferences PUT, and migration-notice PATCH. Name the inferred types `ProgressMutationInput`, `BookmarkMutationInput`, `PreferencesMutationInput`, `TitlePreferencesMutationInput`, and `MigrationNoticeMutationInput`. Versioned mutation inputs carry `expectedVersion`; create-on-first-write uses `expectedVersion: 0`. The bookmark create schema does not carry a client-created ID. Keep response DTO dates as ISO strings.

Also export strict response schemas for progress, bookmarks, preferences, title preferences, migration notice, initial state, and stale-state envelopes. The browser persistence adapter parses server responses with these schemas instead of casting JSON.

- [x] **Step 5: Run focused and static tests**

Run:

```powershell
npx vitest run src/lib/types/library.test.ts
npm run check
npm run lint
```

Expected: contract tests pass; Svelte/TypeScript check reports zero errors and warnings; lint exits zero.

- [x] **Step 6: Commit the contracts**

```powershell
git add src/lib/types/library.ts src/lib/types/library.test.ts docs/dependency-decisions.md
git commit -m "feat: define customer library contracts"
```

Expected: one narrow commit; `docs/dependency-decisions.md` is staged only if Step 1 found a real change.

## Task 2: Compute versioned semantic fingerprints during bounded ingestion

**Files:**
- Create: `src/lib/server/reader-state/fingerprint.ts`
- Create: `src/lib/server/reader-state/fingerprint.test.ts`
- Modify: `src/lib/server/ingestion/image.ts`
- Modify: `src/lib/server/ingestion/image.test.ts`
- Modify: `src/lib/server/ingestion/epub.ts`
- Modify: `src/lib/server/ingestion/comic.ts`
- Modify: `src/lib/server/ingestion/epub.test.ts`
- Modify: `src/lib/server/ingestion/comic.test.ts`

- [x] **Step 1: Write failing semantic-fingerprint tests**

Test these behaviors before changing implementation:

- two encodings of the same oriented pixels produce the same version-1 image fingerprint;
- a pixel change, dimension change, or orientation-normalized visual change produces a different fingerprint;
- two equivalent sanitized paragraph blocks produce the same prose fingerprint despite object key insertion order;
- changing visible text, semantic formatting, block kind, or referenced image pixels changes the prose fingerprint;
- an image block fingerprint contains the referenced image semantic digest, never its revision-specific image ID;
- every digest is lowercase 64-character SHA-256 and every record carries `fingerprintVersion: 1`.

Use small generated buffers already supported by Sharp; do not add binary fixtures or a hashing package.

- [x] **Step 2: Prove the tests fail**

Run:

```powershell
npx vitest run src/lib/server/reader-state/fingerprint.test.ts src/lib/server/ingestion/image.test.ts src/lib/server/ingestion/epub.test.ts src/lib/server/ingestion/comic.test.ts
```

Expected: FAIL because the fingerprint module and result fields do not exist.

- [x] **Step 3: Implement deterministic fingerprint primitives**

In `fingerprint.ts`, expose explicit versioned functions:

```ts
export const SEMANTIC_FINGERPRINT_VERSION = 1;

export function fingerprintDecodedImage(input: {
  width: number;
  height: number;
  pixelDigestSha256: string;
}): string;

export function fingerprintProseBlock(input: {
  block: ProseBlockData;
  imageFingerprintSha256?: string;
}): string;
```

Use a domain-separated UTF-8 prefix such as `pale-orbit:image:v1\0` or `pale-orbit:prose-block:v1\0`, fixed-width dimension encoding, and canonical JSON with recursively sorted object keys. Arrays retain order. Include only sanitized reader-visible semantic content. Reject missing image fingerprints for image blocks and unexpected image fingerprints for non-image blocks.

- [x] **Step 4: Hash decoded pixels without buffering the complete image twice**

Extend `NormalizedImage` with:

```ts
semanticFingerprintSha256: string;
semanticFingerprintVersion: typeof SEMANTIC_FINGERPRINT_VERSION;
```

From the validated Sharp input, use separate clones:

1. the existing orientation-normalized WebP output stream;
2. `.rotate().ensureAlpha().raw()` piped through a SHA-256 hash to obtain the normalized RGBA pixel digest.

Read dimensions from the normalized raw pipeline metadata, then call `fingerprintDecodedImage`. Preserve existing decoder limits, single-image worker concurrency, abort/time budgets, and output checksum behavior. The semantic fingerprint must not hash WebP output bytes.

- [x] **Step 5: Attach prose and comic fingerprints to ingestion results**

Extend `EpubBlockRow` and `ComicPageRow` so every newly accepted block/page carries the paired digest/version. For EPUB image blocks, resolve the normalized image fingerprint before hashing the block. Throw the existing controlled ingestion failure type if an internal image reference has no normalized fingerprint; never write a partial manifest.

- [x] **Step 6: Run focused ingestion tests**

Run:

```powershell
npx vitest run src/lib/server/reader-state/fingerprint.test.ts src/lib/server/ingestion/image.test.ts src/lib/server/ingestion/epub.test.ts src/lib/server/ingestion/comic.test.ts
npm run check
```

Expected: all focused tests pass and check reports zero errors/warnings. Inspect tests to confirm at least one visually identical PNG/JPEG or PNG/WebP pair proves encoding independence.

- [x] **Step 7: Commit fingerprint calculation**

```powershell
git add src/lib/server/reader-state/fingerprint.ts src/lib/server/reader-state/fingerprint.test.ts src/lib/server/ingestion/image.ts src/lib/server/ingestion/image.test.ts src/lib/server/ingestion/epub.ts src/lib/server/ingestion/comic.ts src/lib/server/ingestion/epub.test.ts src/lib/server/ingestion/comic.test.ts
git commit -m "feat: fingerprint semantic publication content"
```

## Task 3: Add Plan 5 schema and generated migration

**Files:**
- Create: `src/lib/server/db/schema/library.ts`
- Modify: `src/lib/server/db/schema/catalog.ts`
- Modify: `src/lib/server/db/schema/index.ts`
- Modify: `tests/integration/schema.test.ts`
- Modify: `tests/integration/setup.ts`
- Create: `drizzle/0004_plan5_reader_library.sql`
- Modify/Create: `drizzle/meta/**`

- [x] **Step 1: Add failing schema assertions first**

Extend `tests/integration/schema.test.ts` to assert:

- all six Plan 5 tables exist with expected primary, unique, check, foreign-key, and partial-index contracts;
- `prose_blocks` and `comic_pages` expose paired nullable fingerprint columns with lowercase SHA-256 shape and positive version checks;
- progress/bookmark discriminators permit exactly one valid prose or comic location shape;
- composite foreign keys reject a location whose block/page belongs to another title or revision;
- the same user/title entitlement cannot be duplicated, but revoke/reactivate is represented by updating the one row;
- counters and versions cannot be negative/zero outside their defined ranges.

Add the six tables to integration truncation in child-to-parent order, before catalog/auth tables.

- [x] **Step 2: Prove the schema suite fails**

Run:

```powershell
npm run test:integration -- tests/integration/schema.test.ts
```

Expected: FAIL because the Plan 5 schema and migration do not exist.

- [x] **Step 3: Define the Drizzle schema with database-enforced location integrity**

Create `library.ts` using the existing UUID/timestamp conventions. Use explicit enums/checks consistent with the repository's schema style. Add composite keys on catalog rows needed to prove title/revision ownership. For bookmark uniqueness use separate partial unique indexes:

- prose: `(user_id, title_id, revision_id, block_id, offset)` where format is prose;
- comic: `(user_id, title_id, revision_id, page_id, coalesce(panel_ordinal, -1))` where format is comic.

Ensure `migrated_from_bookmark_id` is nullable, references the same table without cascade deletion of historical lineage, and is not client-settable through route schemas.

- [x] **Step 4: Generate and review the migration**

Run:

```powershell
npm run db:generate -- --name plan5_reader_library
git diff -- drizzle src/lib/server/db/schema
```

Expected: Drizzle creates `drizzle/0004_plan5_reader_library.sql` and metadata. Review that it only adds Plan 5 tables, keys, indexes, and nullable catalog columns. It must not drop/recreate Plan 4 content tables, backfill decoded-pixel fingerprints in SQL, or make historical fingerprint columns non-null.

- [x] **Step 5: Apply the migration through the isolated integration harness and run schema tests**

Run:

```powershell
npm run test:integration -- tests/integration/schema.test.ts
```

Expected: `scripts/with-test-database.ts` starts a disposable project database, applies every migration through `src/migrate.ts`, and all schema assertions pass. Never apply this migration to or reset the development database merely to satisfy the test.

- [x] **Step 6: Run static and schema-regression gates**

```powershell
npm run check
npm run lint
npm run test:integration -- tests/integration/schema.test.ts tests/integration/schema-auth.test.ts
```

Expected: zero check/lint errors and both old/new schema suites pass.

- [x] **Step 7: Commit schema and migration**

```powershell
git add src/lib/server/db/schema/catalog.ts src/lib/server/db/schema/library.ts src/lib/server/db/schema/index.ts tests/integration/schema.test.ts tests/integration/setup.ts drizzle
git commit -m "feat: add reader library persistence schema"
```

## Task 4: Persist semantic fingerprints in accepted manifests

**Files:**
- Modify: `src/lib/server/ingestion/handler.ts`
- Create: `src/lib/server/ingestion/handler.test.ts`
- Modify: `tests/integration/storage-ingestion.test.ts`

- [ ] **Step 1: Write failing persistence and rollback tests**

Add integration cases that ingest one EPUB and one CBZ, then query PostgreSQL and assert every newly inserted block/page has version `1` and a 64-character digest matching the ingestion result. Add a failure fixture in which prose image fingerprint resolution fails and assert the transaction leaves no manifest rows or presentation behind while preserving the existing candidate failure semantics.

- [ ] **Step 2: Prove the tests fail**

Run:

```powershell
npm run test:integration -- tests/integration/storage-ingestion.test.ts
```

Expected: FAIL because `handler.ts` does not insert fingerprint fields.

- [ ] **Step 3: Insert the paired fields transactionally**

Map `semanticFingerprintSha256` and `semanticFingerprintVersion` into every `prose_blocks` and `comic_pages` insert. Keep the existing single manifest-promotion transaction, idempotent retry behavior, ingestion-generation check, and candidate-only publication rule. Do not derive or re-hash fingerprints in the handler.

- [ ] **Step 4: Run ingestion and publication regressions**

Run:

```powershell
npx vitest run src/lib/server/ingestion/handler.test.ts
npm run test:integration -- tests/integration/storage-ingestion.test.ts tests/integration/publication.test.ts
```

Expected: focused unit/integration tests pass; Plan 4 activation, replacement, rollback, and preview behavior is unchanged.

- [ ] **Step 5: Commit manifest persistence**

```powershell
git add src/lib/server/ingestion/handler.ts src/lib/server/ingestion/handler.test.ts tests/integration/storage-ingestion.test.ts
git commit -m "feat: persist publication fingerprints"
```

## Task 5: Centralize effective-entitlement and reader access decisions

**Files:**
- Create: `src/lib/server/library/access.ts`
- Create: `src/lib/server/library/access.test.ts`
- Modify: `src/lib/types/publication.ts`
- Modify: `src/lib/server/catalog/reader.ts`
- Modify: `src/lib/server/catalog/reader.test.ts`
- Create: `tests/integration/library-access.test.ts`

- [ ] **Step 1: Write the access matrix as failing tests**

Cover each row explicitly:

| Actor/resource state | Expected decision |
| --- | --- |
| anonymous + public active published title | `preview` |
| customer without entitlement + public active published title | `preview` |
| customer without entitlement + private/archived/nonexistent title | denied/not found |
| customer + active entitlement + public/private/archived title + active published revision | `entitled` |
| customer + revoked entitlement + public title | `preview` |
| customer + revoked entitlement + private/archived title | denied/not found |
| customer + entitlement + no active revision/published presentation | unavailable, not preview/full document |
| administrator + active or candidate review request | `admin` under existing capability policy |

Also assert an entitlement for title A never unlocks title B, the public resolver derives the user ID only from its `Actor`, and denied private/nonexistent resources expose the same public error.

- [ ] **Step 2: Prove the focused tests fail**

Run:

```powershell
npx vitest run src/lib/server/library/access.test.ts src/lib/server/catalog/reader.test.ts
npm run test:integration -- tests/integration/library-access.test.ts
```

Expected: FAIL because the shared access service and `entitled` reader variant do not exist.

- [ ] **Step 3: Implement one typed access decision**

Expose narrow functions whose actor comes from the authenticated server context:

```ts
export type PublicationAccessDecision =
  | { level: 'admin'; titleId: string; revisionId: string; presentationId: string }
  | { level: 'entitled'; titleId: string; revisionId: string; presentationId: string }
  | { level: 'preview'; titleId: string; revisionId: string; presentationId: string }
  | { level: 'unavailable'; titleId: string }
  | { level: 'denied' };

export async function hasActiveEntitlement(db: Database, userId: string, titleId: string): Promise<boolean>;
export async function resolvePublicationAccess(input: {
  db: Database;
  actor: Actor;
  titleId: string;
  requestedRevisionId?: string;
  purpose: 'reader' | 'cover' | 'derived-media' | 'original-download' | 'admin-review';
}): Promise<PublicationAccessDecision>;
```

The implementation may split internal queries, but routes and catalog modules consume this decision rather than reproducing visibility/entitlement joins. Resolve only current active customer content; preserve the existing explicit candidate selection only for an authorized admin-review purpose. Keep grant/revoke behavior absent.

- [ ] **Step 4: Add entitled full reader construction**

Change `ReaderAccess` to `'preview' | 'entitled' | 'admin'`. Refactor `catalog/reader.ts` so:

- preview documents remain server-truncated to the published boundary;
- entitled documents include every block/page of the current active revision and only published presentation settings;
- admin review remains able to use the selected revision/draft as Plan 4 requires;
- the DTO never includes storage keys or unreleased revision metadata.

Avoid a second entitlement query after resolving the access decision; pass the resolved root into the document builder.

- [ ] **Step 5: Run access and publication regressions**

Run:

```powershell
npx vitest run src/lib/server/library/access.test.ts src/lib/server/catalog/reader.test.ts
npm run test:integration -- tests/integration/library-access.test.ts tests/integration/publication.test.ts
npm run check
```

Expected: full matrix and existing publication tests pass; check has zero errors/warnings.

- [ ] **Step 6: Commit centralized access**

```powershell
git add src/lib/server/library/access.ts src/lib/server/library/access.test.ts src/lib/types/publication.ts src/lib/server/catalog/reader.ts src/lib/server/catalog/reader.test.ts tests/integration/library-access.test.ts
git commit -m "feat: resolve effective publication access"
```

## Task 6: Query the server-backed customer library and entitled initial reader

**Files:**
- Create: `src/lib/server/library/query.ts`
- Create: `src/lib/server/library/query.test.ts`
- Modify: `src/lib/server/catalog/reader.ts`
- Modify: `tests/integration/library-access.test.ts`

- [ ] **Step 1: Write failing library-query tests**

Test deterministic title ordering and safe DTOs for:

- active entitlements to available public, private, and archived titles;
- active entitlement with no current active/published content, returned as `temporarily_unavailable` with null reader/download URLs;
- revoked entitlements omitted from the customer shelf;
- progress summary for current revision only, clamped to `0..100` and null when absent/unavailable;
- no user ID, entitlement ID, storage key, candidate/retired revision ID, or private publication setting in serialized results.

Use explicit directly seeded entitlement rows only inside test setup. Do not create an application grant helper.

- [ ] **Step 2: Prove the tests fail**

Run:

```powershell
npx vitest run src/lib/server/library/query.test.ts
npm run test:integration -- tests/integration/library-access.test.ts
```

Expected: FAIL because `listCustomerLibrary` is absent.

- [ ] **Step 3: Implement the shelf query and progress summary**

Expose:

```ts
export async function listCustomerLibrary(
  db: Database,
  userId: string
): Promise<LibraryEntryDto[]>;
```

Use one bounded relational query (or a constant number of queries), not one query per title. Build application-owned URLs from stable title IDs. Compute prose completion from semantic block order and offset, and comic completion from page/panel position; this percentage is display-only and is never used for migration or authorization. Treat a missing/unpublished active presentation as unavailable.

- [ ] **Step 4: Add an entitled initial-reader query contract**

Add a server function that receives the already-resolved entitled root and returns the complete `ReaderDocument` plus a placeholder-free initial-state envelope whose reader-state fields are populated in Tasks 8–9. Keep the public preview function unchanged so callers cannot accidentally request `access: 'entitled'` without an entitlement decision.

- [ ] **Step 5: Run focused tests and query-count assertions**

Run:

```powershell
npx vitest run src/lib/server/library/query.test.ts src/lib/server/catalog/reader.test.ts
npm run test:integration -- tests/integration/library-access.test.ts
```

Expected: all cases pass; the test with multiple titles confirms query count does not grow per shelf entry.

- [ ] **Step 6: Commit library queries**

```powershell
git add src/lib/server/library/query.ts src/lib/server/library/query.test.ts src/lib/server/catalog/reader.ts src/lib/server/catalog/reader.test.ts tests/integration/library-access.test.ts
git commit -m "feat: query customer library and full reader"
```

## Task 7: Map semantic locations to responsive reader pages

**Files:**
- Create: `src/lib/reader/locations.ts`
- Create: `src/lib/reader/locations.test.ts`
- Modify: `src/lib/reader/publication-pagination.ts`
- Modify: `src/lib/reader/publication-pagination.test.ts`
- Modify: `src/lib/components/PageFace.svelte`
- Create: `src/lib/components/PageFace.test.ts`

- [ ] **Step 1: Write failing pure mapping tests**

Test prose and comic directions independently:

- semantic prose `(blockId, offsetWithinBlock)` maps to the viewport sheet containing that source character;
- the visible viewport page maps back to a stable block ID and block-relative offset;
- a viewport width/font/paper change repaginates but the same semantic location resolves to the corresponding content;
- exact start/end offsets, empty presentational fragments, chapter boundaries, and missing block IDs have deterministic results;
- comic `(pageId, null)` maps to whole-page mode and `(pageId, panelOrdinal)` maps only to an existing ordered published panel;
- a missing item returns a typed unresolved result, never a guessed ordinal/percentage location.

- [ ] **Step 2: Prove the tests fail**

Run:

```powershell
npx vitest run src/lib/reader/locations.test.ts src/lib/reader/publication-pagination.test.ts
```

Expected: FAIL because pagination currently exposes section-relative/source-sheet anchors rather than authoritative block-relative locations.

- [ ] **Step 3: Preserve source provenance through pagination**

Change rendered prose fragments to carry `sourceBlockId`, `sourceStartOffset`, and `sourceEndOffset` relative to the canonical reader-visible text of that one block. Splitting a block must partition those ranges without overlap or loss. Decorative layout items do not generate persistable anchors.

Export pure functions:

```ts
export function pageIndexForLocation(
  document: ReaderDocument,
  pages: PublicationPage[],
  location: ReaderLocation
): number | null;

export function locationForPage(
  document: ReaderDocument,
  pages: PublicationPage[],
  pageIndex: number,
  comicMode: 'page' | 'guided'
): ReaderLocation | null;
```

Clamp only within a known matching block's valid endpoint. A missing block/page/panel returns null.

- [ ] **Step 4: Adapt PageFace to the richer fragment metadata**

Keep the metadata internal; do not render IDs or offsets into visible text. Preserve HTML sanitization and current visual output.

- [ ] **Step 5: Run mapping and component regressions**

Run:

```powershell
npx vitest run src/lib/reader/locations.test.ts src/lib/reader/publication-pagination.test.ts src/lib/components/PageFace.test.ts
npm run check
```

Expected: pure round-trip tests pass across at least two pagination configurations, component tests pass, and check reports no errors/warnings.

- [ ] **Step 6: Commit semantic viewport mapping**

```powershell
git add src/lib/reader/locations.ts src/lib/reader/locations.test.ts src/lib/reader/publication-pagination.ts src/lib/reader/publication-pagination.test.ts src/lib/components/PageFace.svelte src/lib/components/PageFace.test.ts
git commit -m "feat: map reader semantic locations"
```

## Task 8: Implement optimistic reader-state services

**Files:**
- Create: `src/lib/server/reader-state/errors.ts`
- Create: `src/lib/server/reader-state/lock.ts`
- Create: `src/lib/server/reader-state/anchors.ts`
- Create: `src/lib/server/reader-state/anchors.test.ts`
- Create: `src/lib/server/reader-state/service.ts`
- Create: `src/lib/server/reader-state/service.test.ts`
- Create: `tests/integration/reader-state.test.ts`

- [ ] **Step 1: Write failing anchor-validation tests**

Assert prose offsets accept `0..visibleLength` for the exact active block and reject negative, past-end, wrong-revision, wrong-title, or comic-shaped locations. Assert comic anchors accept an existing page and null panel, accept a real published panel only when guided mode is available, and reject missing/draft-only panels. Assert every failure uses one non-disclosing domain error.

- [ ] **Step 2: Write failing state/concurrency tests**

Cover:

- first progress/preferences/title-preferences write with expected version `0` creates version `1`;
- confirmed update `N` produces `N+1`;
- two concurrent updates with the same expected version yield exactly one success and one `StaleReaderStateError` containing the committed safe DTO;
- bookmark create/delete is idempotent at the service boundary and cannot delete another user's bookmark;
- progress/bookmarks require an active entitlement and current active revision on every call;
- revoked entitlement, replacement during a wait, and a stale active-revision snapshot leave no write;
- account preferences work only for an authenticated user and are independent of entitlement;
- comic mode is per user/title while font/typeface/paper is account-wide.

- [ ] **Step 3: Prove the tests fail**

Run:

```powershell
npx vitest run src/lib/server/reader-state/anchors.test.ts src/lib/server/reader-state/service.test.ts
npm run test:integration -- tests/integration/reader-state.test.ts
```

Expected: FAIL because the reader-state modules do not exist.

- [ ] **Step 4: Implement deterministic locking and post-lock authorization**

Reuse Plan 4's title advisory lock first. Then acquire a transaction-scoped advisory lock keyed by an explicit domain prefix plus user/title IDs. After both locks, re-read:

1. the actor/session user still exists;
2. the effective entitlement is still active for title-scoped state;
3. the title's active revision and published presentation still match the target.

Do not accept a caller-provided user ID. Keep all checks and writes in the same transaction.

- [ ] **Step 5: Implement semantic validation and compare-and-swap writes**

Expose focused service functions:

```ts
type AccountStateContext = {
  database: Database;
  actor: Actor;
  correlationId: string;
};
type ReaderStateContext = AccountStateContext & { titleId: string };

getReaderInitialState(input: ReaderStateContext): Promise<ReaderInitialStateDto>;
saveProgress(input: ReaderStateContext & ProgressMutationInput): Promise<ReaderProgressDto>;
createBookmark(input: ReaderStateContext & BookmarkMutationInput): Promise<ReaderBookmarkDto>;
deleteBookmark(input: ReaderStateContext & { bookmarkId: string }): Promise<void>;
saveReaderPreferences(input: AccountStateContext & PreferencesMutationInput): Promise<ReaderPreferencesDto>;
saveReaderTitlePreferences(input: ReaderStateContext & TitlePreferencesMutationInput): Promise<ReaderTitlePreferencesDto>;
```

Use an `UPDATE ... WHERE version = expectedVersion RETURNING`/insert-on-version-zero pattern under the lock. On mismatch, query and throw the authoritative safe DTO. Normalize database timestamps to ISO strings at the service boundary. Never expose raw constraint messages.

Account preferences use a user-scoped advisory lock because no title or active revision participates. Title-scoped operations keep the title-then-user/title lock order above.

- [ ] **Step 6: Run concurrency repeatedly and run regressions**

Run:

```powershell
npx vitest run src/lib/server/reader-state/anchors.test.ts src/lib/server/reader-state/service.test.ts
1..5 | ForEach-Object { npm run test:integration -- tests/integration/reader-state.test.ts }
npm run test:integration -- tests/integration/library-access.test.ts tests/integration/publication.test.ts
npm run check
```

Expected: every repeated run has one winner/one stale result with no flake; access/publication regressions and check pass.

- [ ] **Step 7: Commit reader-state services**

```powershell
git add src/lib/server/reader-state tests/integration/reader-state.test.ts
git commit -m "feat: persist optimistic reader state"
```

## Task 9: Migrate reader state across revisions by exact fingerprints only

**Files:**
- Create: `src/lib/server/reader-state/migration.ts`
- Create: `src/lib/server/reader-state/migration.test.ts`
- Modify: `src/lib/server/reader-state/service.ts`
- Modify: `tests/integration/reader-state.test.ts`
- Modify: `tests/integration/publication.test.ts`

- [ ] **Step 1: Write the migration matrix as failing tests**

Cover prose and comic cases:

- one source fingerprint/version and exactly one target match migrates progress/bookmark;
- zero target matches creates a validated beginning location with outcome `reset` and retains old bookmarks as unmatched history;
- two target matches are ambiguous and therefore do not migrate;
- null legacy fingerprints never migrate;
- a prose exact match preserves its block-relative offset;
- a comic exact page match preserves panel ordinal only when the target panel list has exactly matching normalized geometry/order; otherwise it falls back to the matching whole page;
- existing target progress/bookmarks win and are never overwritten;
- repeated and concurrent initial-reader loads create one migration record/result;
- activation/replacement during migration produces no mixed-revision state;
- notice counts, `migrated | reset | absent` progress outcome, and panel-simplified flag are correct and acknowledgement is idempotent.

Include a transaction-failure injection and assert no partial target progress, bookmark, or migration record commits.

- [ ] **Step 2: Prove migration tests fail**

Run:

```powershell
npx vitest run src/lib/server/reader-state/migration.test.ts
npm run test:integration -- tests/integration/reader-state.test.ts tests/integration/publication.test.ts
```

Expected: FAIL because lazy migration is absent.

- [ ] **Step 3: Implement the exact-only migration transaction**

When entitled initial state has no current-revision migration result:

1. acquire title lock, then reader user/title lock;
2. re-read entitlement, active target revision, and published presentation;
3. choose the most recent prior revision state for this user/title as source;
4. stop if target progress/bookmarks already exist, recording a non-overwriting result under the unique user/title/target rule;
5. match only equal non-null `(fingerprint_version, fingerprint_sha256)` pairs with target match count exactly one;
6. validate the mapped target location through `anchors.ts`;
7. insert migrated target state/bookmarks with bookmark lineage, or insert the target document's validated first semantic location when progress resets;
8. retain source/unmatched bookmarks, store result counts, and return the notice;
9. commit everything atomically.

Do not query or sort by approximate ordinal to choose a match. A prose offset may be preserved only because the versioned canonical block is identical; validate its endpoint before insert.

- [ ] **Step 4: Integrate lazy migration and notice acknowledgement**

Call migration from entitled `getReaderInitialState` before reading target state. Expose a service acknowledgement requiring entitlement and the matching current target revision; set `notice_acknowledged_at` only when null. A later reload omits acknowledged notices without deleting migration history.

- [ ] **Step 5: Run migration and publication race tests repeatedly**

Run:

```powershell
npx vitest run src/lib/server/reader-state/migration.test.ts
1..5 | ForEach-Object { npm run test:integration -- tests/integration/reader-state.test.ts tests/integration/publication.test.ts }
npm run check
```

Expected: exact/ambiguous/null/idempotent/rollback cases pass on every run; publication remains gap-free and no migration race flakes.

- [ ] **Step 6: Commit exact migration**

```powershell
git add src/lib/server/reader-state/migration.ts src/lib/server/reader-state/migration.test.ts src/lib/server/reader-state/service.ts tests/integration/reader-state.test.ts tests/integration/publication.test.ts
git commit -m "feat: migrate reader state by exact content"
```

## Task 10: Expose strict same-origin reader-state mutations

**Files:**
- Create: `src/routes/api/reader-state/route-support.ts`
- Create: `src/routes/api/reader-state/route-support.test.ts`
- Create: `src/routes/api/reader-state/[titleId]/progress/+server.ts`
- Create: `src/routes/api/reader-state/[titleId]/progress/route.test.ts`
- Create: `src/routes/api/reader-state/[titleId]/bookmarks/+server.ts`
- Create: `src/routes/api/reader-state/[titleId]/bookmarks/route.test.ts`
- Create: `src/routes/api/reader-state/[titleId]/bookmarks/[bookmarkId]/+server.ts`
- Create: `src/routes/api/reader-state/[titleId]/bookmarks/[bookmarkId]/route.test.ts`
- Create: `src/routes/api/reader-state/preferences/+server.ts`
- Create: `src/routes/api/reader-state/preferences/route.test.ts`
- Create: `src/routes/api/reader-state/[titleId]/preferences/+server.ts`
- Create: `src/routes/api/reader-state/[titleId]/preferences/route.test.ts`
- Create: `src/routes/api/reader-state/[titleId]/migration-notice/+server.ts`
- Create: `src/routes/api/reader-state/[titleId]/migration-notice/route.test.ts`

- [ ] **Step 1: Write failing route-support security tests**

Test the shared route boundary directly:

- no actor returns `401` before reading a body;
- absent/mismatched `Origin` for mutation methods returns `403`; use the configured public origin as authority, never `Host`/`X-Forwarded-Host` from the request;
- only `application/json` with an optional charset is accepted;
- body bytes are bounded before parsing and malformed JSON is `400`;
- strict Zod failures/unknown fields are stable `422` responses without input echo;
- domain not-found/authorization becomes uniform `404`, stale version becomes `409` with only `code` and safe current DTO, temporary database/storage failure becomes `503`;
- responses use `Cache-Control: no-store` and preserve/generate the existing correlation ID policy.

- [ ] **Step 2: Write failing handler tests for every mutation**

Mock the service boundary and assert each route:

- derives actor/user from `locals`, never body/query;
- validates UUID path parameters;
- invokes exactly one matching service function;
- returns `200` for progress/preferences/notice, `201` for bookmark create, and `204` for bookmark delete;
- maps stale/invalid/not-found errors correctly;
- never serializes a database row or Error object directly.

- [ ] **Step 3: Prove route tests fail**

Run:

```powershell
npx vitest run src/routes/api/reader-state
```

Expected: FAIL because the routes and support module do not exist.

- [ ] **Step 4: Implement the route support boundary**

Use one bounded strict-JSON parser and one domain-error mapper. The handler pattern should remain narrow:

```ts
export const PUT: RequestHandler = async (event) => {
  const actor = requireMutationActor(event);
  assertSameOrigin(event.request);
  const input = await readStrictJson(event.request, progressInputSchema);
  const value = await saveProgress({
    db: getDatabaseClient().db,
    actor,
    titleId: parseUuid(event.params.titleId),
    ...input
  });
  return privateJson(value);
};
```

Adapt the database source to the repository's established `locals`/runtime pattern rather than opening a new pool. Set the request size limit to `16 KiB`, sufficient for these scalar payloads. Keep CSRF validation independent of CORS response headers.

- [ ] **Step 5: Implement all six mutation resources**

Use the methods and schemas specified in the file map. `PATCH migration-notice` carries only `targetRevisionId`; the service derives user/title and verifies it is still the current target. Bookmark delete derives bookmark ownership from the actor and path title. Do not add GET endpoints; initial state comes from the reader loader.

- [ ] **Step 6: Run route, service, and static gates**

Run:

```powershell
npx vitest run src/routes/api/reader-state src/lib/server/reader-state
npm run test:integration -- tests/integration/reader-state.test.ts
npm run check
npm run lint
```

Expected: all route/service tests pass, integration state behavior remains transactional, and static gates are clean.

- [ ] **Step 7: Commit reader-state routes**

```powershell
git add src/routes/api/reader-state
git commit -m "feat: expose reader state mutations"
```

## Task 11: Authorize entitled media and stream customer originals

**Files:**
- Modify: `src/lib/server/catalog/media.ts`
- Modify: `src/lib/server/catalog/media.test.ts`
- Modify: `src/lib/server/http/media-response.ts`
- Create: `src/lib/server/http/media-response.test.ts`
- Modify: `src/routes/media/covers/[titleId]/[checksum]/+server.ts`
- Modify: `src/routes/media/revisions/[revisionId]/images/[imageId]/[checksum]/+server.ts`
- Create: `src/routes/library/[titleId]/download/+server.ts`
- Create: `src/routes/library/[titleId]/download/route.test.ts`
- Modify: `src/routes/media/media-routes.test.ts`
- Create: `tests/integration/media-routes.test.ts`
- Modify: `tests/integration/audit-query.test.ts`

- [ ] **Step 1: Write failing media access tests**

Extend the access matrix to prove:

- public cover/derived media remains limited to the active published preview boundary and publicly cacheable;
- an entitled customer can receive the complete current active revision's derived images, including withdrawn/archived titles, with private no-store caching;
- the same customer cannot select a candidate, retired, or other title's revision/image;
- revoked entitlement loses private assets immediately but may independently receive qualifying public preview assets;
- administrators retain Plan 4 review access;
- inaccessible private and nonexistent objects are indistinguishable.

- [ ] **Step 2: Write failing HEAD/download/range tests**

At unit and integration levels assert:

- `HEAD` returns authorized status and the same `Content-Length`, type, disposition, ETag, ranges, cache, and nosniff headers as a corresponding full `GET`, with no call to `storage.read`;
- `GET` streams without buffering and inclusive single ranges return `206`/correct `Content-Range`;
- invalid/multiple/unsatisfiable ranges return `416` with safe headers;
- prose uses EPUB type/extension; comics preserve accepted CBZ versus ZIP extension with a sanitized title-based filename;
- the URL contains only title ID and cannot select a revision;
- missing active publication/object/checksum fails closed and never falls back to another revision;
- every new full/range request rechecks entitlement;
- accepted customer download appends exactly one `library.original.download` event containing actor ID, title ID, active revision ID, outcome, correlation ID, and range boolean—never email, filename, key, content, cookies, token, or headers.

- [ ] **Step 3: Prove focused tests fail**

Run:

```powershell
npx vitest run src/lib/server/catalog/media.test.ts src/lib/server/http/media-response.test.ts src/routes/library/[titleId]/download/route.test.ts
npm run test:integration -- tests/integration/media-routes.test.ts tests/integration/audit-query.test.ts
```

Expected: FAIL because entitled access, customer download, and body-free HEAD support are absent. Quote the bracketed path if the active shell expands it.

- [ ] **Step 4: Extend media resolution through the shared decision**

Refactor `resolveCoverAccess` and `resolveReaderImageAccess` to consume `resolvePublicationAccess`. Return an internal resolved object containing the authorized storage reference and response policy, not a public DTO. For entitled images, prove the image/page belongs to the current active revision; for previews, retain the Plan 4 semantic-boundary query. Emit `private, no-store` for entitled/admin assets and existing immutable public caching only for public preview assets.

- [ ] **Step 5: Make the streaming helper method-aware**

Add `method: 'GET' | 'HEAD'` to `streamMediaResponse`. Parse/validate Range for both methods so metadata/status is consistent. For `HEAD`, obtain authorized stored metadata already resolved by the caller and construct a response with `body: null`; do not call `storage.read`, create a stream, or record streamed bytes. Preserve current abort/error handling for GET.

- [ ] **Step 6: Implement the customer original route and redacted audit event**

The route accepts only GET/HEAD, requires `locals.actor`, resolves an effective entitlement and current active retained original, builds a format-appropriate sanitized attachment filename, and passes the method/range into the streaming helper. Append the accepted audit event through the existing audit service with the minimal detail contract. Do not accept a revision ID, original filename, storage key, or user ID from the request.

- [ ] **Step 7: Run media/download regressions**

Run:

```powershell
npx vitest run src/lib/server/catalog/media.test.ts src/lib/server/http/media-response.test.ts src/routes/library/[titleId]/download/route.test.ts
npm run test:integration -- tests/integration/media-routes.test.ts tests/integration/audit-query.test.ts tests/integration/library-access.test.ts
npm run check
```

Expected: access matrix, HEAD no-read assertion, ranges, redacted audit details, and Plan 4 public/admin media cases all pass.

- [ ] **Step 8: Commit entitled media and downloads**

```powershell
git add src/lib/server/catalog/media.ts src/lib/server/catalog/media.test.ts src/lib/server/http/media-response.ts src/lib/server/http/media-response.test.ts src/routes/media src/routes/library/[titleId]/download tests/integration/media-routes.test.ts tests/integration/audit-query.test.ts
git commit -m "feat: stream entitled media and downloads"
```

## Task 12: Refactor BookReader onto explicit persistence adapters

**Files:**
- Create: `src/lib/reader/persistence.ts`
- Create: `src/lib/reader/persistence.test.ts`
- Create: `src/lib/reader/progress-sync.ts`
- Create: `src/lib/reader/progress-sync.test.ts`
- Modify: `src/lib/components/BookReader.svelte`
- Create: `src/lib/components/BookReader.test.ts`
- Modify: `src/lib/components/reader/ReaderDrawers.svelte`
- Modify: `src/routes/read/[id]/+page.server.ts`
- Modify: `src/routes/read/[id]/+page.svelte`
- Create: `src/routes/read/[id]/route.test.ts`

- [ ] **Step 1: Write failing adapter contract tests**

Define one interface used by `BookReader`:

```ts
export interface ReaderPersistence {
  readonly kind: 'server' | 'preview-local' | 'memory';
  getInitialState(): ReaderInitialStateDto;
  saveProgress(input: ProgressMutationInput): Promise<ReaderProgressDto>;
  createBookmark(location: ReaderLocation): Promise<ReaderBookmarkDto>;
  deleteBookmark(bookmarkId: string): Promise<void>;
  savePreferences(input: PreferencesMutationInput): Promise<ReaderPreferencesDto>;
  saveTitlePreferences(input: TitlePreferencesMutationInput): Promise<ReaderTitlePreferencesDto>;
  acknowledgeMigration(targetRevisionId: string): Promise<void>;
}
```

Test:

- server adapter calls only same-origin application routes with credentials and strict JSON;
- preview adapter uses a versioned key containing title ID, revision ID, and published presentation ID, never calls fetch, clamps state to the preview document, and ignores old-presentation state;
- memory adapter mutates only its instance and performs no I/O, suitable for admin review;
- no adapter has a grant/ownership method or accepts a user/access-level field.

- [ ] **Step 2: Write failing synchronization-state tests**

Use fake timers and a fake adapter to prove:

- ordinary navigation debounces progress by `750 ms` and coalesces to the latest intentional location;
- explicit bookmark/navigation flushes pending progress before or alongside the action without reordering confirmed versions;
- UI states are `idle | pending | synced | retrying | failed | conflict` and failed writes never display synced;
- one transient network/`503` failure retries at `1 s`, then `2 s`, then `4 s` while active, capped at three attempts;
- a `409` adopts the server's authoritative state/version, enters visible conflict state, and does not automatically re-send the stale location;
- dispose/pagehide performs only a best-effort keepalive flush and does not claim success without a response.

- [ ] **Step 3: Prove the tests fail**

Run:

```powershell
npx vitest run src/lib/reader/persistence.test.ts src/lib/reader/progress-sync.test.ts src/lib/components/BookReader.test.ts
```

Expected: FAIL because adapters/state machine are absent and `BookReader` imports the global library store.

- [ ] **Step 4: Implement adapters and the pure synchronization state machine**

Keep fetch, localStorage, and lifecycle operations behind injectable functions so unit tests do not need a browser. Parse every server response with shared Zod response schemas before adopting it. Treat `400/401/403/404/422` as non-retryable; retry only network errors and `503`. Expose status through callbacks/state rather than global stores.

The preview adapter may retain device-local progress/bookmarks/display preferences, but account state from an entitled load always replaces preview defaults and preview state is never posted to the server automatically.

- [ ] **Step 5: Refactor BookReader and drawers**

Replace the `$lib/stores/library.svelte` import with props containing the authorized document, initial state, and persistence adapter/factory. Use Task 7's semantic mapping for restore/save. Keep preview boundary/paywall visuals for `access: 'preview'`; remove the paywall for `entitled` and `admin`. Render accessible live-region notices for pending/failure/conflict/edition-change states. Keep current-revision bookmark navigation only.

- [ ] **Step 6: Resolve route access and cache policy server-side**

In `/read/[id]/+page.server.ts`:

1. resolve access using `locals.actor`;
2. for entitled access, run lazy migration and return full document/initial state with `Cache-Control: private, no-store`;
3. for preview access, return the truncated document plus presentation-scoped preview configuration;
4. for admin active-edition access, use memory persistence unless the existing admin review route already provides the document;
5. return uniform not-found for denied private resources.

The Svelte page constructs only the adapter named by the safe loader response. It cannot upgrade preview to entitled in the browser.

- [ ] **Step 7: Run reader unit and route tests**

Run:

```powershell
npx vitest run src/lib/reader src/lib/components/BookReader.test.ts src/routes/read/[id]/route.test.ts
npm run test:integration -- tests/integration/reader-state.test.ts tests/integration/library-access.test.ts
npm run check
```

Expected: adapter, debounce/retry/conflict, semantic restore, loader access, and integration tests pass; no component imports the prototype library store.

- [ ] **Step 8: Commit the reader refactor**

```powershell
git add src/lib/reader src/lib/components/BookReader.svelte src/lib/components/BookReader.test.ts src/lib/components/reader/ReaderDrawers.svelte src/routes/read/[id]
git commit -m "feat: connect reader persistence adapters"
```

## Task 13: Replace prototype storefront/library authority and retire fake commerce

**Files:**
- Create: `src/routes/+page.server.ts`
- Modify: `src/routes/+page.svelte`
- Modify: `src/routes/public-routes.test.ts`
- Create: `src/routes/library/+page.server.ts`
- Modify: `src/routes/library/+page.svelte`
- Create: `src/routes/library/route.test.ts`
- Modify: `src/lib/components/BookVolume.svelte`
- Create: `src/lib/components/BookVolume.test.ts`
- Remove: `src/lib/stores/library.svelte.ts`
- Remove: `src/lib/stores/titles.svelte.ts`
- Remove: `src/lib/server/prototype-db.ts`
- Remove: `src/lib/server/mail.ts`
- Remove: `src/lib/server/mail.test.ts`
- Remove: `src/lib/types/api.ts`
- Remove matching tests after consumer migration: `src/lib/types/api.test.ts`
- Remove: `src/routes/api/checkout/**`
- Remove: `src/routes/api/stripe-webhook/**`
- Remove: `src/routes/api/deliver/**`
- Remove: `src/routes/checkout/**`
- Remove if `rg` proves unused: `src/lib/data/catalog.ts`, `src/lib/data/prose.ts`, `src/lib/data/manuscript/**`, `src/lib/types/catalog.ts`, legacy-only pagination helpers/tests

- [ ] **Step 1: Write failing storefront and shelf route tests**

Assert:

- home loader uses `listPublicCatalog`, serializes only public active titles, and has no prototype-store fallback;
- signed-out `/library` shows the established sign-in action without leaking entries;
- signed-in `/library` uses the actor-derived server shelf and renders empty/available/unavailable/progress/resume states;
- prose download label says EPUB; comic label says CBZ or ZIP from safe retained-format metadata;
- withdrawn/archived entitled titles remain visible and private covers render only through authorized media URLs;
- checkout controls state that checkout is not yet available and cannot grant access;
- direct requests to removed checkout/webhook/delivery routes return route-level `404` and cannot mutate any entitlement.

- [ ] **Step 2: Prove tests fail against the prototype**

Run:

```powershell
npx vitest run src/routes/public-routes.test.ts src/routes/library/route.test.ts src/lib/components/BookVolume.test.ts
```

Expected: FAIL because home/library still consume prototype stores and fake commerce routes exist.

- [ ] **Step 3: Make home and library server-backed**

Load the home catalog through the Plan 4 public query and the library through `listCustomerLibrary`. Preserve current visual language and responsive behavior. Render direct application read/download links from the safe DTO. Replace “Email me the file” and fake checkout language with honest availability copy; do not display a successful purchase path before Plan 6.

- [ ] **Step 4: Narrow reusable component inputs**

Refactor `BookVolume` and any shared cover helpers to accept publication primitives rather than legacy prototype `Title`. Move genuinely shared visual-only cover derivation to `src/lib/cover-art.ts` with a focused unit test. Keep monetary display helpers presentation-only; price never implies entitlement.

- [ ] **Step 5: Remove every browser/local fake-ownership path**

Before deleting, run:

```powershell
rg -n "library\.grant|prototype-db|stores/library|stores/titles|api/checkout|api/stripe-webhook|api/deliver|Email me the file|types/api" src tests
```

Expected before removal: matches identify only the listed prototype consumers/tests. Migrate visual consumers, then delete the modules/routes/tests listed above. Keep `stripe` in `package.json` for Plan 6. Do not replace removed endpoints with no-op success handlers; filesystem route absence supplies `404`.

- [ ] **Step 6: Prove no prototype authority remains**

Run:

```powershell
rg -n "library\.grant|prototype-db|stores/library|stores/titles|api/checkout|api/stripe-webhook|api/deliver|Email me the file" src tests
rg -n "localStorage|sessionStorage" src
npx vitest run src/routes/public-routes.test.ts src/routes/library/route.test.ts src/lib/components/BookVolume.test.ts
npm run check
npm run lint
```

Expected: first command has no matches; storage matches are limited to the explicitly presentation-scoped preview adapter and unrelated documented UI preferences; route/component/static tests pass.

- [ ] **Step 7: Run all unit tests before committing deletion**

Run:

```powershell
npm run test:unit
```

Expected: all unit tests pass with no imports of removed modules.

- [ ] **Step 8: Commit server-backed surfaces and retirement**

```powershell
git add -A src
git commit -m "feat: replace prototype library and commerce"
```

Review `git show --stat --oneline HEAD` and confirm the deletion set contains only migrated prototype authority and now-unused prototype data/types.

## Task 14: Complete browser journeys, operational documentation, and release gates

**Files:**
- Create: `tests/e2e/library-reader.spec.ts`
- Create: `tests/e2e/database.ts`
- Modify: `tests/e2e/catalog-publication.spec.ts`
- Modify as needed for reusable fixture helpers: `tests/fixtures/publications.ts`
- Create: `docs/customer-library-and-reader.md`
- Modify: `README.md`
- Modify: `docs/runtime-environments.md`
- Modify: `docs/database-and-workers.md`
- Modify: `docs/storage-ingestion-and-publication.md`
- Modify: `docs/authentication-and-email.md`
- Modify: `docs/dependency-decisions.md`

- [ ] **Step 1: Add a test-only direct database seeding helper**

Create a Playwright-side helper that opens the configured E2E PostgreSQL database, looks up the normalized verified test user, and inserts/updates the effective entitlement row directly. It must:

- live under `tests/e2e`, never under `src` or an application route;
- reject non-test database names/hosts using the existing safety convention;
- expose only test setup/cleanup operations;
- never become a production grant service.

Extract reusable admin upload/review/activate helpers from `catalog-publication.spec.ts` without weakening its assertions.

- [ ] **Step 2: Write the failing customer browser journey**

Add one serial spec with isolated users/contexts that proves:

1. admin publishes a prose EPUB and a comic CBZ with free previews;
2. anonymous/non-entitled users can read only the approved preview and cannot use the customer download;
3. a verified user with a directly seeded test entitlement sees both titles on `/library` and reads the complete active edition;
4. progress, bookmark, account display preferences, and comic mode survive reload and a second browser context;
5. two contexts write from the same version: one succeeds, the other visibly adopts the `409` authoritative location instead of overwriting it;
6. direct EPUB and CBZ/ZIP downloads have correct filename/type, bytes/checksum, range behavior, and an admin-visible redacted audit event;
7. admin activates a corrected revision containing exact and changed content; exact state migrates, changed state resets/remains unmatched, and the accessible notice can be acknowledged;
8. admin withdraws/archives the entitled title; it remains on the shelf/readable/downloadable;
9. test revokes the entitlement directly; private full reader/media/download access disappears while an independent public preview still obeys publication visibility;
10. removed prototype checkout/delivery URLs return `404` and never change the shelf.

- [ ] **Step 3: Prove the new browser spec fails before final wiring/docs**

Run:

```powershell
npm run test:e2e -- tests/e2e/library-reader.spec.ts
```

Expected: at least one Plan 5 assertion fails until all route/UI wiring and fixture extraction are complete. Do not weaken timeouts or assertions to make the test green.

- [ ] **Step 4: Complete browser wiring and accessibility details**

Fix only observed Plan 5 gaps. Ensure status/edition notices use an appropriate live region, controls have accessible names, keyboard focus is retained after conflict/acknowledgement, unavailable items do not render dead links, and format-specific download labels are visible. Keep screenshots/traces free of secrets through existing Playwright configuration.

- [ ] **Step 5: Write the operator/customer-reader runbook**

Create `docs/customer-library-and-reader.md` covering:

- effective-entitlement semantics and the explicit Plan 6 grant/revoke boundary;
- access precedence and withdrawn/archived behavior;
- server versus preview-local state and optimistic conflict behavior;
- semantic fingerprints, nullable legacy rows, exact-only migration, notice behavior, and lock order;
- customer media/download authorization, HEAD/range behavior, redacted audit event, and storage failure behavior;
- no email attachments/public storage URLs and no S3 SDK yet;
- database backup/restore inclusion of all six Plan 5 tables and catalog fingerprint columns;
- recovery diagnostics for unavailable publications, migration failures, stale conflicts, missing objects, and revocation;
- production maintenance mode through Plan 5 and Plan 6 handoff.

Update the existing docs so none still claim browser-owned purchases, fake email delivery, or a live checkout. Record the unchanged TypeScript 7 peer blocker and current audit disposition without duplicating credentials or environment values.

- [ ] **Step 6: Run documentation and placeholder audits**

Run:

```powershell
rg -n "Email me the file|library\.grant|prototype-db|fake purchase|prototype checkout" README.md docs src tests
rg -n "FIXME|XXX|placeholder implementation" docs/customer-library-and-reader.md src tests
git diff --check
```

Expected: no stale prototype-authority copy; no placeholder instructions in new code/runbook; diff check is clean. Legitimate historical design statements must be clearly marked as superseded rather than silently contradicted.

- [ ] **Step 7: Run focused browser and full automated gates**

Run in this order:

```powershell
npm run check
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e -- tests/e2e/library-reader.spec.ts
npm run test:e2e
npm run build:web
npm run build:services
npm audit --omit=dev --audit-level=high
docker compose --env-file .env.example --file compose.dev.yaml config --quiet
docker compose --env-file .env.example --file compose.dev.yaml --profile tools config --quiet
git diff --check
```

Then validate production Compose with disposable process values:

```powershell
$plan5ComposeValues = @{
  APP_IMAGE = 'pale-orbit:plan5'; ORIGIN = 'https://books.example.com'; SITE_ADDRESS = 'books.example.com';
  DATABASE_NAME = 'pale_orbit'; DATABASE_USER = 'pale_orbit'; DATABASE_PASSWORD = 'validation-db-password';
  AUTH_SECRET = 'validation-auth-secret-at-least-thirty-two-bytes'; SMTP_HOST = 'smtp.example.com';
  SMTP_PORT = '587'; SMTP_USER = 'mailer'; SMTP_PASSWORD = 'validation-smtp-password';
  SMTP_FROM = 'Pale Orbit <books@example.com>'; SMTP_SECURE = 'false'; SMTP_REQUIRE_TLS = 'true';
  BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com'; BOOTSTRAP_ADMIN_NAME = 'Administrator';
  BOOTSTRAP_ADMIN_PASSWORD = 'validation-admin-password'
}
$plan5ComposeValues.GetEnumerator() | ForEach-Object { Set-Item "Env:$($_.Key)" $_.Value }
try {
  docker compose --file compose.prod.yaml config --quiet
  docker compose --file compose.prod.yaml --profile tools config --quiet
} finally {
  $plan5ComposeValues.Keys | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
}
```

Expected:

- check: zero errors and warnings;
- lint: exit zero;
- unit/integration/E2E: all tests pass with no skips introduced for Plan 5;
- both builds complete;
- runtime audit: zero high/critical advisories, with already documented lower-severity findings only;
- both development and production Compose variants validate, and production still sets `APPLICATION_MODE=maintenance`;
- diff check: no whitespace errors.

- [ ] **Step 8: Validate the production image and runtime boundary**

Run:

```powershell
docker build --target production -t pale-orbit:plan5 .
docker run --rm --entrypoint node pale-orbit:plan5 --version
docker run --rm --entrypoint npm pale-orbit:plan5 ls --omit=dev --all
```

Expected: image builds, Node reports `v26.7.0`, required production dependencies (including Sharp optional native packages and Stripe for Plan 6) are present, and no development-only test server is started. Do not publish or deploy the image in this task.

- [ ] **Step 9: Inspect privacy, authority, and scope one final time**

Run:

```powershell
rg -n "storageKey|objectKey|originalFilename|password|token|cookie|authorization" src/lib/server/library src/lib/server/reader-state src/routes/library src/routes/api/reader-state
rg -n "grant|revoke|checkout|webhook" src/routes src/lib/server
rg -n "ReaderAccess|access: 'entitled'|access: \"entitled\"" src
git status --short
```

Expected: sensitive identifiers occur only in private internal resolution where required and never in response/audit payload builders; no application entitlement mutation or fake checkout path exists; every entitled reader construction is downstream of the centralized server decision; status shows only intended Plan 5/doc changes.

- [ ] **Step 10: Commit browser coverage and documentation**

```powershell
git add tests/e2e tests/fixtures docs README.md
git commit -m "test: verify customer library journeys"
```

If Step 4 required small route/component fixes, stage those exact files in this commit and state them in the commit body; do not sweep unrelated worktree changes into it.

- [ ] **Step 11: Request code review and resolve findings rigorously**

Use `superpowers:requesting-code-review` against the complete Plan 5 branch. Give the reviewer the approved design, this implementation plan, base commit, head commit, and verification evidence. For each finding, use `superpowers:receiving-code-review`: reproduce the issue, add or tighten a failing regression test, implement the narrow fix, rerun the affected and full gates, and request a final re-review. Do not integrate with unresolved Critical or Important findings.

- [ ] **Step 12: Create the corrective commit only if review changed code**

Stage only the regression test and implementation/documentation files actually changed to resolve accepted findings. Inspect `git diff --cached --stat` and `git diff --cached --check`, then run:

```powershell
git commit -m "fix: address plan 5 review findings"
```

Expected: omit this commit when review required no changes; the cached diff contains no unrelated workspace file.

- [ ] **Step 13: Re-run final verification from a clean worktree**

Use `superpowers:verification-before-completion`, then run:

```powershell
npm run check
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build:web
npm run build:services
npm audit --omit=dev --audit-level=high
docker compose --env-file .env.example --file compose.dev.yaml config --quiet
docker compose --env-file .env.example --file compose.dev.yaml --profile tools config --quiet
git diff --check
git status --short --branch
```

Repeat production Compose validation with fresh disposable values:

```powershell
$plan5ComposeValues = @{
  APP_IMAGE = 'pale-orbit:plan5'; ORIGIN = 'https://books.example.com'; SITE_ADDRESS = 'books.example.com';
  DATABASE_NAME = 'pale_orbit'; DATABASE_USER = 'pale_orbit'; DATABASE_PASSWORD = 'validation-db-password';
  AUTH_SECRET = 'validation-auth-secret-at-least-thirty-two-bytes'; SMTP_HOST = 'smtp.example.com';
  SMTP_PORT = '587'; SMTP_USER = 'mailer'; SMTP_PASSWORD = 'validation-smtp-password';
  SMTP_FROM = 'Pale Orbit <books@example.com>'; SMTP_SECURE = 'false'; SMTP_REQUIRE_TLS = 'true';
  BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com'; BOOTSTRAP_ADMIN_NAME = 'Administrator';
  BOOTSTRAP_ADMIN_PASSWORD = 'validation-admin-password'
}
$plan5ComposeValues.GetEnumerator() | ForEach-Object { Set-Item "Env:$($_.Key)" $_.Value }
try {
  docker compose --file compose.prod.yaml config --quiet
  docker compose --file compose.prod.yaml --profile tools config --quiet
} finally {
  $plan5ComposeValues.Keys | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
}
```

Expected: every gate passes with fresh output; no high/critical runtime advisory; worktree is clean; branch is ahead of its Plan 4 base only by intentional Plan 5 commits. Record actual test counts and image/build evidence in the handoff.

- [ ] **Step 14: Offer integration choices**

Use `superpowers:finishing-a-development-branch`. Present the verified branch/base/head and offer the skill's structured local merge, push/PR, keep, or discard choices. Do not merge, push, deploy, or change production mode without the user's explicit selection.

## Acceptance traceability

| Approved design requirement | Implemented and verified in |
| --- | --- |
| effective title entitlement and access precedence | Tasks 3, 5, 8, 11, 14 |
| server-backed shelf preserving withdrawn/archived/unavailable titles | Tasks 6, 13, 14 |
| complete current active entitled reader, preview still truncated | Tasks 5, 6, 12, 14 |
| server-canonical progress/bookmarks/preferences | Tasks 3, 7, 8, 10, 12 |
| account display preferences and per-title comic mode | Tasks 1, 3, 8, 10, 12, 14 |
| optimistic latest-confirmed concurrency and visible stale refresh | Tasks 8, 10, 12, 14 |
| device-local presentation-scoped previews | Tasks 1, 12, 13, 14 |
| decoded-pixel/prose fingerprints and nullable Plan 4 compatibility | Tasks 2, 3, 4, 9 |
| exact-only lazy revision migration and retained unmatched history | Tasks 3, 8, 9, 10, 12, 14 |
| entitled cover/derived assets and direct authenticated originals | Tasks 5, 11, 13, 14 |
| HEAD/range/no-store/nosniff/attachment behavior | Tasks 11 and 14 |
| redacted admin-visible customer download audit | Tasks 11 and 14 |
| removal of browser grants/fake checkout/email delivery | Tasks 12, 13, 14 |
| no Redis/new worker/S3 SDK and production maintenance remains | Tasks 1 and 14 |
| Plan 6 grant/claim/payment handoff preserved | Source boundaries, Tasks 13 and 14 |

## Executor notes

- Check off each step in this file as it is completed and keep the command evidence in the execution handoff.
- Follow red-green-refactor: observe the specified failure before implementation, make the narrowest passing change, then clean up with tests green.
- Never use a percentage, ordinal, title slug, filename, checksum URL, or client claim as authorization or migration authority.
- Do not weaken Plan 4's publication/media tests to fit Plan 5. Extend the centralized decision while preserving public/admin behavior.
- Stop and update the approved design before implementing any discovered requirement that adds commerce, grant/revoke APIs, historical-edition delivery, a new infrastructure service, public object URLs, or approximate migration.
