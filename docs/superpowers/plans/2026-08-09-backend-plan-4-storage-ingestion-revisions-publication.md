# Backend Plan 4: Storage, Ingestion, Revision Review, and Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local-only Studio prototype with secure streamed EPUB/CBZ ingestion, immutable revision storage, database-backed reader manifests, private admin review, explicit publication transitions, public free previews, and an admin audit viewer.

**Architecture:** A provider-neutral storage module owns opaque object keys and streaming bytes; a lazy, defensive ingestion module turns staged ZIP-based originals into deterministic derived objects and normalized database manifests; catalog services own all mutable metadata, reader-setting drafts, and serialized publication transitions. SvelteKit routes authorize every upload, reader asset, preview, cover, and original download, while the existing PostgreSQL worker performs ingestion and production remains in maintenance mode.

**Tech Stack:** Node.js 26.7.0, npm 11.19.0, SvelteKit 2.70.2, Svelte 5.56.8, TypeScript 6.0.3, PostgreSQL 18.4, Drizzle ORM 0.45.2, `@fastify/busboy` 3.2.0, `yauzl` 3.4.0 with `@types/yauzl` 3.4.0, `sharp` 0.35.3, `file-type` 22.0.1, `fast-xml-parser` 5.10.1, `fflate` 0.8.3 for generated test fixtures, Vitest 4.1.10, and Playwright 1.62.1.

---

## Source of truth and boundaries

This plan implements `docs/superpowers/specs/2026-08-09-storage-ingestion-publication-design.md` and the Plan 4 handoff in `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md`. It consumes the completed Plan 3 contracts on `main`.

Preserve these boundaries throughout execution:

- Accept only reflowable EPUB and CBZ/ZIP comic originals. Do not accept PDF, DOCX, pasted prose, loose images, fixed-layout EPUB, DRM, scripted content, SVG spine resources, or automatic panel detection.
- Retain each accepted original byte-for-byte. Derived reader objects are deterministic and regenerable; originals are never overwritten and maintenance never deletes a database-referenced original.
- A background worker may move a candidate through upload, processing, review, or failure. It may not activate a revision, publish settings, change `titles.active_revision_id`, or change title visibility.
- A public replacement keeps the current revision live until one serialized transaction retires it and activates the reviewed candidate. Rollback uses the same no-gap transaction.
- Cover art is title-level mutable metadata. Ingestion only suggests a cover; activation and rollback never change the confirmed cover.
- Title metadata and confirmed-cover saves are immediately visible on a public title. Preview boundaries and comic panels are private drafts until **Publish reader settings** succeeds.
- A public preview is authorized by an immutable semantic boundary: final prose block or final comic page. Client viewport pagination never decides authorization.
- Plan 4 gives administrators full reader/original access and gives the public only approved previews. Customer full reading, checkout, entitlements, download delivery, sales, Stripe fee reconciliation, and payout reporting remain later work.
- Keep PostgreSQL as the queue/outbox store. Do not add Redis, BullMQ, an AWS SDK, a direct Caddy storage mount, or a second publishing model.
- Keep production `APPLICATION_MODE=maintenance` through this phase.
- Every server mutation reuses the authenticated `locals.actor`, capability policy, transaction helper, correlation IDs, append-only audit service, and safe redaction established by Plans 2-3.

## Dependency decisions

Official npm-registry and project-documentation checks on 2026-08-09 selected these current stable releases:

| Package | Selected | Responsibility |
| --- | --- | --- |
| `@fastify/busboy` | 3.2.0 | Backpressure-aware multipart parsing with explicit file/field/part limits |
| `yauzl` | 3.4.0 | Lazy ZIP central-directory validation, async entry iteration, and random-access reads |
| `@types/yauzl` | 3.4.0 | Current declarations for yauzl's public API |
| `sharp` | 0.35.3 | Bounded image decode, metadata validation, orientation normalization, and derived output |
| `file-type` | 22.0.1 | File-signature hinting before structural validation |
| `fast-xml-parser` | 5.10.1 | EPUB container/package/navigation/XHTML parsing with ordered-node output |
| `fflate` | 0.8.3 | Test-only in-memory EPUB and CBZ fixture generation |

`file-type` requires Node 22 or newer and `sharp` requires Node 20.9 or newer, so both accept the repository's locked Node 26 runtime. `@fastify/busboy`, `sharp`, `file-type`, and `fast-xml-parser` ship declarations; add only `@types/yauzl`. Retain optional production dependencies when pruning the image because sharp's platform binary is distributed through optional packages.

## Publication invariants

- Storage keys are branded opaque values created only by the key module. User filenames are display metadata, never path segments.
- Local writes and copies use a temporary sibling plus atomic rename. Readers never observe a partial object.
- A successful upload stream and one database transaction create the candidate, deduplicated ingestion job, and audit event. Database failure leaves only a delayed-cleanup staging orphan.
- Each manual retry increments `ingestion_generation`; job deduplication is `catalog.ingest:{revisionId}:{generation}`. A stale job whose generation no longer matches is a safe no-op.
- ZIP limits are enforced from both declared metadata and observed streams. Size, entry count, compression ratio, path, symlink, encryption, compression method, CRC, XML, image pixel, and processing-time checks fail closed.
- A successful ingestion transaction replaces the candidate manifest, records accepted-original metadata, creates the first draft presentation, sets `ready_for_review`, and audits completion. It never touches an active revision.
- A revision has at most one draft and one published presentation. Publishing settings supersedes the old published row, promotes the draft, and clones a new draft baseline in one transaction.
- Guided comic view is published only when every comic page has at least one ordered, in-bounds panel region. Whole-page view always remains available.
- Public catalog/reader/media queries require public visibility, the active revision, and its published presentation. Admin review queries require `catalog.manage` and may select a candidate plus draft presentation.
- High-impact publication transactions take a per-title PostgreSQL advisory lock and re-read the actor's current admin role after acquiring it.
- Audit details never contain passwords, cookies, tokens, raw file bytes, raw markup, local paths, object-storage credentials, or unsanitized filenames.

## File map

### Dependencies, configuration, and storage

- `package.json`, `package-lock.json`, `docs/dependency-decisions.md` — exact ingestion dependencies and rationale.
- `.env.example`, `src/lib/server/config/schema.ts`, `src/lib/server/config/load.ts`, `src/lib/server/config/index.ts` — validated storage/ingestion/worker settings.
- `src/lib/server/storage/types.ts` — provider-neutral storage contract and metadata types.
- `src/lib/server/storage/keys.ts` — opaque key construction and validation.
- `src/lib/server/storage/local.ts` — traversal-safe atomic local implementation.
- `src/lib/server/storage/factory.ts`, `src/lib/server/storage/runtime.ts` — local construction, explicit S3 failure, and web-process singleton.
- `src/lib/server/storage/health.ts` — non-content write/read/delete readiness probe.

### Persistence and shared publication types

- `src/lib/types/publication.ts` — public/admin catalog DTOs, semantic prose blocks, reader documents, comic pages, and panel regions.
- `src/lib/server/catalog/content.ts` — Zod validation for persisted typed block JSON and presentation input.
- `src/lib/server/db/schema/catalog.ts` — title cover fields, revision upload state, manifests, warnings, suggestions, presentations, and panels.
- `src/lib/server/db/schema/operations.ts`, `src/lib/server/audit/service.ts` — safe request metadata and indexes for audit browsing.
- `src/lib/server/audit/request-metadata.ts` — minimal method/route audit context without headers, addresses, or query values.
- `drizzle/0003_plan4_publications.sql`, `drizzle/meta/` — generated and reviewed Plan 4 migration.

### Upload and ingestion

- `src/lib/server/uploads/multipart.ts` — one-file bounded multipart parser.
- `src/lib/server/uploads/stream-object.ts` — streamed SHA-256 and byte-limit staging write.
- `src/lib/server/ingestion/errors.ts`, `src/lib/server/ingestion/limits.ts` — stable failure taxonomy and runtime limits.
- `src/lib/server/ingestion/archive.ts` — yauzl random-access adapter, safe entry metadata, lazy iteration, and CRC/size enforcement.
- `src/lib/server/ingestion/xml.ts` — bounded no-DOCTYPE/no-entity ordered XML parsing.
- `src/lib/server/ingestion/image.ts` — signature hinting plus sharp decode/normalize helpers.
- `src/lib/server/ingestion/epub.ts`, `src/lib/server/ingestion/prose.ts` — EPUB package resolution and XHTML-to-semantic-block conversion.
- `src/lib/server/ingestion/comic.ts`, `src/lib/server/ingestion/natural-order.ts` — comic image selection and unambiguous natural page ordering.
- `src/lib/server/ingestion/handler.ts` — idempotent worker handler and transactional manifest promotion.
- `src/lib/server/ingestion/job.ts` — payload schema, job type, and enqueue helper.
- `tests/fixtures/publications.ts` — generated valid/hostile EPUB and CBZ buffers.

### Catalog domain and media

- `src/lib/server/catalog/errors.ts` — stable catalog domain errors.
- `src/lib/server/catalog/titles.ts` — create/update/list title metadata.
- `src/lib/server/catalog/revisions.ts` — upload acceptance, status, retry, and private revision queries.
- `src/lib/server/catalog/covers.ts` — suggestion confirmation and standalone cover replacement.
- `src/lib/server/catalog/presentations.ts` — draft preview/panel edits and atomic settings publication.
- `src/lib/server/catalog/publication.ts` — private activation, first publication, public replacement, rollback, and withdrawal.
- `src/lib/server/catalog/reader.ts` — public/admin reader DTO queries and boundary truncation.
- `src/lib/server/catalog/media.ts` — cover/image/original authorization and storage lookup without key disclosure.
- `src/lib/server/catalog/service.ts` — compatibility re-exports only; new behavior lives in focused modules.

### Routes and UI

- `src/routes/admin/catalog/**` — title list/create/edit, streamed upload, revision review, settings, panels, covers, original download, and publication actions.
- `src/lib/components/admin/CatalogTitleForm.svelte`, `RevisionUploadForm.svelte`, `RevisionStatus.svelte`, `PreviewBoundaryEditor.svelte`, `PanelEditor.svelte`, `PublicationActions.svelte` — focused admin controls.
- `src/routes/admin/audit/**`, `src/lib/server/audit/query.ts`, `src/lib/components/admin/AuditFilters.svelte` — filtered audit list and audited detail view.
- `src/routes/media/covers/[titleId]/[checksum]/+server.ts`, `src/routes/media/revisions/[revisionId]/images/[imageId]/[checksum]/+server.ts` — authorized immutable media streaming.
- `src/routes/media/revisions/[revisionId]/cover-suggestion/[suggestionId]/[checksum]/+server.ts` — administrator-only suggestion preview streaming.
- `src/routes/catalog/+page.server.ts`, `src/routes/book/[id]/+page.server.ts`, `src/routes/read/[id]/+page.server.ts` — database-backed public catalog/detail/preview loaders.
- `src/lib/reader/publication-pagination.ts`, `src/lib/components/BookReader.svelte`, `src/lib/components/PageFace.svelte`, `src/lib/components/reader/ReaderGuidedPanel.svelte` — semantic prose, real comic pages, normalized panel crops, and server-authorized preview mode.
- `src/routes/studio/+page.server.ts` — redirect to `/admin/catalog`.

### Maintenance, deployment, documentation, and tests

- `src/lib/server/storage/cleanup.ts`, `src/cleanup-storage.ts`, `vite.services.config.ts` — dry-run/apply cleanup tool and production bundle.
- `compose.dev.yaml`, `compose.prod.yaml`, `Dockerfile`, `.gitignore`, `scripts/with-test-database.ts` — private volumes, temporary test roots, native image runtime, and tools profile.
- `docs/storage-ingestion-and-publication.md`, `docs/runtime-environments.md`, `docs/database-and-workers.md`, `README.md` — upload, recovery, cleanup, backup, restore, and Hetzner operation.
- Focused `*.test.ts`, `tests/integration/storage-ingestion.test.ts`, `tests/integration/publication.test.ts`, `tests/integration/audit-query.test.ts`, `tests/e2e/catalog-publication.spec.ts` — unit, real-PostgreSQL/storage/worker, and browser coverage.

## Task 1: Lock dependencies and validated storage/ingestion configuration

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Modify: `src/lib/server/config/schema.ts`
- Modify: `src/lib/server/config/load.ts`
- Modify: `src/lib/server/config/index.ts`
- Modify: `src/lib/server/config/index.test.ts`
- Modify: `docs/dependency-decisions.md`

- [ ] **Step 1: Reconfirm stable package versions and runtime compatibility**

Run:

```powershell
npm view @fastify/busboy version engines typings --json
npm view yauzl version engines --json
npm view @types/yauzl version --json
npm view sharp version engines --json
npm view file-type version engines --json
npm view fast-xml-parser version engines --json
npm view fflate version engines --json
```

Expected: stable releases remain `3.2.0`, `3.4.0`, `3.4.0`, `0.35.3`, `22.0.1`, `5.10.1`, and `0.8.3`; declared engines accept Node 26. If a stable release changed, read its official release notes and engine/peer declarations, update the dependency table and exact install command in this plan, and do not select a prerelease.

- [ ] **Step 2: Install exact runtime and test-fixture packages**

Run:

```powershell
npm install --save-exact @fastify/busboy@3.2.0 fast-xml-parser@5.10.1 file-type@22.0.1 sharp@0.35.3 yauzl@3.4.0
npm install --save-dev --save-exact @types/yauzl@3.4.0 fflate@0.8.3
npm ls @fastify/busboy fast-xml-parser file-type sharp yauzl @types/yauzl fflate
```

Expected: one valid copy of each exact package and no peer/engine error.

- [ ] **Step 3: Write failing configuration tests**

Extend the valid fixture in `src/lib/server/config/index.test.ts` with:

```ts
STORAGE_PROVIDER: 'local',
STORAGE_LOCAL_ROOT: '.data/storage',
UPLOAD_MAX_BYTES: '536870912',
INGEST_MAX_EXPANDED_BYTES: '2147483648',
INGEST_MAX_ENTRIES: '10000',
INGEST_MAX_XML_BYTES: '8388608',
INGEST_MAX_IMAGE_PIXELS: '100000000',
INGEST_MAX_COMPRESSION_RATIO: '200',
INGEST_TIMEOUT_MS: '900000',
STORAGE_STAGING_RETENTION_HOURS: '24',
STORAGE_ORPHAN_RETENTION_HOURS: '168',
WORKER_CONCURRENCY: '1'
```

Add assertions that:

```ts
expect(config.storage).toMatchObject({
  provider: 'local',
  localRoot: '.data/storage',
  stagingRetentionHours: 24,
  orphanRetentionHours: 168
});
expect(config.ingestion).toMatchObject({
  maxUploadBytes: 536_870_912,
  maxExpandedBytes: 2_147_483_648,
  maxEntries: 10_000,
  maxXmlBytes: 8_388_608,
  maxImagePixels: 100_000_000,
  maxCompressionRatio: 200,
  timeoutMs: 900_000
});
expect(config.jobs.concurrency).toBe(1);
```

Also test rejection of a relative production local root, zero/negative values, expanded bytes below upload bytes, an XML limit above expanded bytes, staging retention above orphan retention, concurrency above 16, and an unknown provider.

Run:

```powershell
npm run test:unit -- src/lib/server/config/index.test.ts
```

Expected: FAIL because the new fields are absent.

- [ ] **Step 4: Implement the transformed configuration contract**

In `src/lib/server/config/schema.ts`, reuse the strict integer-string helper and add the new raw fields. Extend `superRefine` with:

```ts
if (value.INGEST_MAX_EXPANDED_BYTES < value.UPLOAD_MAX_BYTES) {
  context.addIssue({
    code: 'custom',
    path: ['INGEST_MAX_EXPANDED_BYTES'],
    message: 'must be greater than or equal to UPLOAD_MAX_BYTES'
  });
}
if (value.INGEST_MAX_XML_BYTES > value.INGEST_MAX_EXPANDED_BYTES) {
  context.addIssue({
    code: 'custom',
    path: ['INGEST_MAX_XML_BYTES'],
    message: 'must not exceed INGEST_MAX_EXPANDED_BYTES'
  });
}
if (value.STORAGE_STAGING_RETENTION_HOURS > value.STORAGE_ORPHAN_RETENTION_HOURS) {
  context.addIssue({
    code: 'custom',
    path: ['STORAGE_ORPHAN_RETENTION_HOURS'],
    message: 'must be at least STORAGE_STAGING_RETENTION_HOURS'
  });
}
if (value.STORAGE_PROVIDER === 'local' && !value.STORAGE_LOCAL_ROOT) {
  context.addIssue({
    code: 'custom',
    path: ['STORAGE_LOCAL_ROOT'],
    message: 'is required for local storage'
  });
}
if (
  value.APP_ENV === 'production' &&
  value.STORAGE_PROVIDER === 'local' &&
  value.STORAGE_LOCAL_ROOT &&
  !path.isAbsolute(value.STORAGE_LOCAL_ROOT)
) {
  context.addIssue({
    code: 'custom',
    path: ['STORAGE_LOCAL_ROOT'],
    message: 'must be absolute in production'
  });
}
```

Transform to:

```ts
storage: {
  provider: value.STORAGE_PROVIDER,
  localRoot: value.STORAGE_LOCAL_ROOT,
  stagingRetentionHours: value.STORAGE_STAGING_RETENTION_HOURS,
  orphanRetentionHours: value.STORAGE_ORPHAN_RETENTION_HOURS
},
ingestion: {
  maxUploadBytes: value.UPLOAD_MAX_BYTES,
  maxExpandedBytes: value.INGEST_MAX_EXPANDED_BYTES,
  maxEntries: value.INGEST_MAX_ENTRIES,
  maxXmlBytes: value.INGEST_MAX_XML_BYTES,
  maxImagePixels: value.INGEST_MAX_IMAGE_PIXELS,
  maxCompressionRatio: value.INGEST_MAX_COMPRESSION_RATIO,
  timeoutMs: value.INGEST_TIMEOUT_MS
},
jobs: {
  pollIntervalMs: value.JOB_POLL_INTERVAL_MS,
  leaseMs: value.JOB_LEASE_MS,
  retryBaseMs: value.JOB_RETRY_BASE_MS,
  retryMaxMs: value.JOB_RETRY_MAX_MS,
  workerReadyFile: value.WORKER_READY_FILE,
  concurrency: value.WORKER_CONCURRENCY
}
```

Import `node:path` for the production absolute-path check. Export `StorageConfig` and `IngestionConfig`. Add all numeric/provider settings to the required loader list, add `STORAGE_LOCAL_ROOT` to the optional loader list, and re-export the types from `src/lib/server/config/index.ts`. The transformed `StorageConfig.localRoot` remains optional for the explicit S3 failure path; the local factory narrows it after configuration validation.

Run the focused test; expected: PASS.

- [ ] **Step 5: Document safe defaults and exact dependency ownership**

Add the tested settings to `.env.example` under a private-storage section. Add the seven-package table above to `docs/dependency-decisions.md`, including the rule that `file-type` is a hint, yauzl performs lazy random access, fflate is test-only, and sharp optional packages must survive the production prune.

Run:

```powershell
npm run check
npm run lint
npm audit --audit-level=high
git diff --check
```

Expected: all checks pass and no high/critical advisory is introduced.

- [ ] **Step 6: Commit dependencies and configuration**

```powershell
git add package.json package-lock.json .env.example src/lib/server/config docs/dependency-decisions.md
git commit -m "build: add publication ingestion dependencies"
```

## Task 2: Implement opaque storage keys and the atomic local adapter

**Files:**
- Create: `src/lib/server/storage/types.ts`
- Create: `src/lib/server/storage/keys.ts`
- Create: `src/lib/server/storage/keys.test.ts`
- Create: `src/lib/server/storage/local.ts`
- Create: `src/lib/server/storage/local.test.ts`
- Create: `src/lib/server/storage/factory.ts`
- Create: `src/lib/server/storage/factory.test.ts`
- Create: `src/lib/server/storage/runtime.ts`
- Create: `src/lib/server/storage/health.ts`
- Create: `src/lib/server/storage/health.test.ts`
- Modify: `src/hooks.server.ts`
- Modify: `src/routes/health/ready/+server.ts`

- [ ] **Step 1: Write failing key-policy tests**

Create `src/lib/server/storage/keys.test.ts` with positive cases for generated namespaces and negative cases for traversal, absolute/drive paths, backslashes, empty/dot segments, control characters, encoded traversal, and user filenames:

```ts
const titleId = '018f0000-0000-7000-8000-000000000010';
const revisionId = '018f0000-0000-7000-8000-000000000011';
expect(stagingUploadKey('018f0000-0000-7000-8000-000000000001')).toBe(
  'staging/uploads/018f0000-0000-7000-8000-000000000001'
);
expect(revisionOriginalKey(titleId, revisionId)).toBe(
  `titles/${titleId}/revisions/${revisionId}/original`
);
expect(() => parseStorageKey('../secret')).toThrowError(StorageKeyError);
expect(() => parseStorageKey('C:/secret')).toThrowError(StorageKeyError);
expect(() => parseStorageKey('titles\\secret')).toThrowError(StorageKeyError);
expect(() => parseStorageKey('titles/%2e%2e/secret')).toThrowError(StorageKeyError);
```

Run:

```powershell
npm run test:unit -- src/lib/server/storage/keys.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Define the key and storage contracts**

Create `src/lib/server/storage/keys.ts` with a branded key and constructors that accept only validated UUIDs/fixed segments:

```ts
declare const storageKeyBrand: unique symbol;
export type StorageKey = string & { readonly [storageKeyBrand]: true };

export function parseStorageKey(value: string): StorageKey {
  if (
    value.length === 0 ||
    value.length > 500 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /^[a-zA-Z]:/u.test(value)
  ) throw new StorageKeyError();
  const decoded = decodeURIComponent(value);
  const segments = decoded.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new StorageKeyError();
  }
  return value as StorageKey;
}
```

Export constructors for staging, retained original, derived prose image, derived comic page, cover suggestion, title cover, health probe, and their bounded maintenance prefixes.

Create `src/lib/server/storage/types.ts`:

```ts
export interface StoredObjectStat {
  byteSize: number;
  modifiedAt: Date;
}

export interface StorageListPage {
  objects: readonly { key: StorageKey; byteSize: number; modifiedAt: Date }[];
  cursor: string | null;
}

export interface ObjectStorage {
  write(key: StorageKey, body: Readable, options: { maxBytes: number }): Promise<StoredObjectStat>;
  read(key: StorageKey): Promise<Readable>;
  readRange(key: StorageKey, start: number, endInclusive: number): Promise<Readable>;
  stat(key: StorageKey): Promise<StoredObjectStat | null>;
  copy(source: StorageKey, destination: StorageKey): Promise<StoredObjectStat>;
  delete(key: StorageKey): Promise<void>;
  listPrefix(prefix: StorageKey, options: { limit: number; cursor?: string }): Promise<StorageListPage>;
}
```

Run the key test; expected: PASS.

- [ ] **Step 3: Write failing local-adapter tests**

Use `mkdtemp(join(tmpdir(), 'pale-orbit-storage-test-'))` in `local.test.ts` and remove only that returned absolute directory in `afterEach`. Cover:

- atomic write/read/stat;
- byte-limit failure leaves no destination or temporary file;
- inclusive single-range reads and invalid/out-of-range rejection;
- copy then source/destination independence;
- idempotent exact delete;
- deterministic paginated prefix listing with a maximum limit;
- a symlink placed inside the root cannot escape it;
- a simulated stream error leaves no partial object.

Import `Readable` from `node:stream`. Representative assertions:

```ts
async function readText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

await storage.write(key, Readable.from(['abc', 'def']), { maxBytes: 6 });
await expect(readText(await storage.readRange(key, 1, 3))).resolves.toBe('bcd');
await expect(storage.write(largeKey, Readable.from(['12345']), { maxBytes: 4 })).rejects.toThrow(
  StorageLimitError
);
expect(await storage.stat(largeKey)).toBeNull();
```

Run the focused test; expected: FAIL because `createLocalObjectStorage` does not exist.

- [ ] **Step 4: Implement the traversal-safe local adapter**

In `local.ts`, resolve the configured root once, create it, and for every key verify the resolved target begins with `root + sep`. Before opening a target, walk existing path segments with `lstat` and reject symbolic links. Write to a random `.partial-{uuid}` sibling with `wx`, count bytes through a transform, `sync`/close, then rename. Clean the partial file in `catch` without removing any directory.

Implement ranges with `createReadStream(path, { start, end: endInclusive })`, copies through a temporary sibling and rename, and listings by walking only the requested validated prefix while refusing symlinks and stopping at `limit + 1` records. Cursors are base64url-encoded last keys and are accepted only when they remain under the same prefix.

Run:

```powershell
npm run test:unit -- src/lib/server/storage/local.test.ts
```

Expected: PASS on Windows and without Docker.

- [ ] **Step 5: Write and implement provider-factory and health tests**

Test that local configuration returns a working adapter and S3 selection throws this exact safe error:

```ts
expect(() => createObjectStorage({ provider: 's3', localRoot: undefined, stagingRetentionHours: 24,
  orphanRetentionHours: 168 })).toThrowError(
  new UnsupportedStorageProviderError('s3')
);
```

Implement `factory.ts`, a cached `getObjectStorage()` in `runtime.ts`, and `probeStorage()` that writes random non-content bytes under `health/probes/{uuid}`, reads them back, validates equality, and deletes the exact key in `finally`.

Extend `src/hooks.server.ts` initialization to construct storage outside build mode. Extend `/health/ready` to require both database and storage probes and still return only `{ status: 'ready' }` or `{ status: 'not_ready' }`.

Run:

```powershell
npm run test:unit -- src/lib/server/storage src/routes/health
npm run check
npm run lint
```

Expected: storage and health tests pass; S3 configuration fails before serving requests.

- [ ] **Step 6: Commit the storage foundation**

```powershell
git add src/lib/server/storage src/hooks.server.ts src/routes/health/ready/+server.ts
git commit -m "feat: add private object storage foundation"
```

## Task 3: Add publication DTOs, manifest tables, and database constraints

**Files:**
- Create: `src/lib/types/publication.ts`
- Create: `src/lib/server/catalog/content.ts`
- Create: `src/lib/server/catalog/content.test.ts`
- Modify: `src/lib/server/db/schema/catalog.ts`
- Modify: `src/lib/server/db/schema/operations.ts`
- Modify: `src/lib/server/audit/service.ts`
- Create: `src/lib/server/audit/request-metadata.ts`
- Create: `src/lib/server/audit/request-metadata.test.ts`
- Modify: `tests/integration/schema.test.ts`
- Modify: `tests/integration/setup.ts`
- Create: `drizzle/0003_plan4_publications.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `drizzle/meta/0003_snapshot.json`

- [ ] **Step 1: Write failing semantic-content validation tests**

Create `content.test.ts` with valid heading, paragraph, quote, list, image, and break blocks plus invalid empty fragments, unsupported marks, `javascript:` links, bad heading levels, unknown JSON keys, and cross-format presentation input.

Use this canonical paragraph assertion:

```ts
expect(parseProseBlock({
  kind: 'paragraph',
  fragments: [
    { text: 'A safe ', marks: [] },
    { text: 'sentence', marks: ['strong'], href: 'https://example.com/notes' }
  ]
})).toEqual({
  kind: 'paragraph',
  fragments: [
    { text: 'A safe ', marks: [] },
    { text: 'sentence', marks: ['strong'], href: 'https://example.com/notes' }
  ]
});
expect(() => parseProseBlock({
  kind: 'paragraph',
  fragments: [{ text: 'bad', marks: [], href: 'javascript:alert(1)' }]
})).toThrow();
```

Run:

```powershell
npm run test:unit -- src/lib/server/catalog/content.test.ts
```

Expected: FAIL because the content types and parser do not exist.

- [ ] **Step 2: Define shared publication types and strict parsers**

Create `src/lib/types/publication.ts` with:

```ts
export type PublicationFormat = 'prose' | 'comic';
export type ReadingDirection = 'ltr' | 'rtl';
export type InlineMark = 'strong' | 'emphasis' | 'code' | 'subscript' | 'superscript';

export interface InlineFragment {
  text: string;
  marks: readonly InlineMark[];
  href?: string;
}

export type ProseBlockData =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; fragments: readonly InlineFragment[] }
  | { kind: 'paragraph'; fragments: readonly InlineFragment[] }
  | { kind: 'quote'; fragments: readonly InlineFragment[] }
  | { kind: 'list'; ordered: boolean; items: readonly (readonly InlineFragment[])[] }
  | { kind: 'image'; imageId: string; alt: string }
  | { kind: 'break' };

export interface PanelRegionDto {
  id: string;
  ordinal: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
```

Also define `CatalogTitleSummary`, `CatalogTitleDetail`, `ProseReaderDocument`, `ComicReaderDocument`, section/page/image DTOs, `ReaderDocument = ProseReaderDocument | ComicReaderDocument`, and `ReaderAccess = 'preview' | 'admin'`. DTOs expose media URLs and checksums, never storage keys.

In `content.ts`, use strict Zod discriminated unions, trim text without collapsing intentional inline spaces, deduplicate marks, allow only `http:`, `https:`, and `mailto:` links, and validate normalized panel rectangles with `x + width <= 1` and `y + height <= 1`.

Run the focused test; expected: PASS.

- [ ] **Step 3: Write failing migration and constraint tests**

Extend `tests/integration/schema.test.ts` to require these tables in sorted order:

```ts
const PLAN_4_TABLES = [
  'comic_pages',
  'comic_panel_regions',
  'prose_blocks',
  'prose_images',
  'prose_sections',
  'revision_cover_suggestions',
  'revision_ingestion_warnings',
  'revision_presentations'
];
```

Add SQL-backed tests proving:

- only one `active` revision per title;
- `titles.active_revision_id` cannot reference another title's revision;
- section/block/page ordinals are unique per parent;
- one draft and one published presentation are permitted but duplicates are rejected;
- presentation preview fields obey format-shape checks;
- panel dimensions are positive and remain within zero-to-one bounds;
- same-revision composite foreign keys reject cross-revision blocks, images, pages, presentations, and panels;
- title/revision deletion cascades manifests but audit rows remain append-only;
- `audit_events.request_metadata` accepts sanitized JSON and is nullable for historical events.

Run:

```powershell
npm run test:integration -- tests/integration/schema.test.ts
```

Expected: FAIL because the Plan 4 schema is absent.

- [ ] **Step 4: Extend the Drizzle catalog and audit schemas**

In `catalog.ts`, add enums for presentation state, prose block kind, and reading direction. Extend `titles` with nullable confirmed-cover key/type/checksum/size/dimensions and `coverUpdatedAt`. Replace the simple active-revision FK with a composite same-title FK using the existing `(title_id, id)` revision uniqueness.

Extend `title_revisions` with:

```ts
stagingStorageKey: text('staging_storage_key'),
stagingChecksumSha256: varchar('staging_checksum_sha256', { length: 64 }),
stagingByteSize: bigint('staging_byte_size', { mode: 'number' }),
uploadFilename: text('upload_filename'),
uploadMimeType: text('upload_mime_type'),
ingestionGeneration: integer('ingestion_generation').default(0).notNull(),
derivationVersion: integer('derivation_version').default(1).notNull()
```

Keep the two upload-display fields nullable so the migration remains valid for existing Plan 2 skeleton rows; every new upload service sets them, and ingestion rejects a matching-generation candidate that lacks them. Create all eight Plan 4 tables with UUID primary keys, UTC timestamps, ordered uniqueness, same-revision composite FKs, checksum/size/dimension checks, and partial unique indexes for draft/published presentations. `revision_presentations` includes `reading_direction`, `guided_view_enabled`, nullable prose section/block boundary IDs, and a nullable comic page boundary; draft rows may be incomplete, while the publish service enforces one valid format-appropriate partial boundary. Use `jsonb().$type<ProseBlockData>()` for block content but keep `kind` as a constrained column for efficient rendering queries.

Add nullable `requestMetadata` JSON to `auditEvents` and include it in `AppendAuditEventInput`; pass it through `redactAuditDetails` before insert. Create `safeAuditRequestMetadata(request, routeId)` returning only `{ method, routeId }`, with both values length-limited and route ID nullable. Unit tests prove it never copies URL query values, headers, cookies, user agent, or client address. All Plan 4 mutation/detail routes pass this helper result into their domain command.

- [ ] **Step 5: Generate and review the migration**

Run:

```powershell
npm run db:generate -- --name plan4_publications
npm run db:check
```

Expected: Drizzle creates `drizzle/0003_plan4_publications.sql` and its snapshot. Review the SQL and confirm it contains the eight tables, cover/revision/audit alterations, partial unique indexes, same-revision foreign keys, and no drop of authentication, identity, queue, outbox, or audit-trigger objects.

Update `tests/integration/setup.ts` so the truncate list begins with all Plan 4 child tables, then existing revision/title/operations/auth tables, using `restart identity cascade`.

- [ ] **Step 6: Run schema, type, and legacy catalog regression gates**

```powershell
npm run test:unit -- src/lib/server/catalog/content.test.ts src/lib/server/catalog/input.test.ts
npm run test:integration -- tests/integration/schema.test.ts tests/integration/catalog.test.ts tests/integration/audit.test.ts
npm run check
npm run lint
git diff --check
```

Expected: all new constraints and all Plan 2-3 catalog/audit behavior pass.

- [ ] **Step 7: Commit publication persistence**

```powershell
git add src/lib/types/publication.ts src/lib/server/catalog/content.ts src/lib/server/catalog/content.test.ts src/lib/server/db/schema src/lib/server/audit/service.ts src/lib/server/audit/request-metadata.ts src/lib/server/audit/request-metadata.test.ts drizzle tests/integration/schema.test.ts tests/integration/setup.ts
git commit -m "feat: add publication manifest schema"
```

## Task 4: Build bounded archive, XML, and generated-fixture primitives

**Files:**
- Create: `tests/fixtures/publications.ts`
- Create: `src/lib/server/ingestion/errors.ts`
- Create: `src/lib/server/ingestion/limits.ts`
- Create: `src/lib/server/ingestion/archive.ts`
- Create: `src/lib/server/ingestion/archive.test.ts`
- Create: `src/lib/server/ingestion/xml.ts`
- Create: `src/lib/server/ingestion/xml.test.ts`

- [ ] **Step 1: Create portable generated EPUB/CBZ fixture builders**

Use `fflate.zipSync` and `strToU8` in `tests/fixtures/publications.ts`; do not commit opaque binary fixtures. Export `validEpubFixture(overrides?)`, `validComicFixture(entries?)`, and helpers for arbitrary ZIP entries.

The minimal EPUB must put this entry first and uncompressed:

```ts
const entries = {
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8(containerXml),
  'EPUB/package.opf': strToU8(packageXml),
  'EPUB/nav.xhtml': strToU8(navXhtml),
  'EPUB/chapter-1.xhtml': strToU8(chapterXhtml),
  'EPUB/images/cover.png': onePixelPng
} satisfies Zippable;
return Buffer.from(zipSync(entries, { level: 6 }));
```

Comic fixtures use insertion-independent filenames such as `page-10.png`, `page-2.png`, and nested platform metadata so natural ordering and ignored entries are exercised.

- [ ] **Step 2: Write failing archive-security tests**

Create `archive.test.ts` using the local storage adapter. Cover a valid stored/deflated ZIP and reject:

- `../`, absolute, drive-qualified, backslash, control-character, and Unicode/case-colliding names;
- duplicate normalized paths;
- symbolic links through UNIX external attributes;
- encrypted flags and compression methods other than stored/deflate;
- entry count, total expanded size, single-entry size, and compression-ratio excess;
- declared-size mismatch, truncated/corrupt input, and CRC mismatch;
- reads after abort or session close.

Representative assertions:

```ts
const archive = await openArchive(storage, key, limits, AbortSignal.timeout(5_000));
expect(archive.entries.map((entry) => entry.path)).toEqual([
  'mimetype',
  'META-INF/container.xml',
  'EPUB/package.opf'
]);
await archive.close();
await expect(openArchive(storage, traversalKey, limits, signal)).rejects.toMatchObject({
  code: 'archive_unsafe_path',
  retryable: false
});
```

Run:

```powershell
npm run test:unit -- src/lib/server/ingestion/archive.test.ts
```

Expected: FAIL because the archive module is absent.

- [ ] **Step 3: Implement stable ingestion errors and limits**

Create:

```ts
export class IngestionError extends Error {
  constructor(
    readonly code: IngestionFailureCode,
    readonly safeMessage: string,
    readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(safeMessage, options);
    this.name = 'IngestionError';
  }
}
```

Define explicit codes for upload limit, archive structure/path/encryption/compression/count/size/ratio/CRC, XML limit/syntax/entity, EPUB container/package/spine/navigation/content, unsupported format/media/fixed-layout/script/DRM/SVG, image decode/pixels, timeout/abort, missing staged source, and transient storage/database failures. `limits.ts` maps `IngestionConfig` to an immutable `IngestionLimits` object.

- [ ] **Step 4: Implement lazy random-access archive validation**

Subclass yauzl's `RandomAccessReader`; `_readStreamForRange(start, endExclusive)` delegates to `storage.readRange(key, start, endExclusive - 1)`. Open with:

```ts
const zipFile = await fromRandomAccessReaderPromise(reader, stat.byteSize, {
  autoClose: false,
  decodeStrings: true,
  strictFileNames: true,
  validateEntrySizes: true
});
```

Iterate exactly once with `for await (const entry of zipFile.eachEntry())`, validate central-directory metadata before exposing an immutable entry list, and retain the yauzl `Entry` privately for later `openReadStreamPromise`. Normalize names to NFC forward-slash paths, cap total path length at 1,024 code points, each segment at 255, and depth at 32, then use a lowercase NFC collision key. Detect UNIX symlinks from the upper external-attribute mode bits and encryption from the general-purpose flag.

Every entry stream is wrapped in an observed-size/CRC transform using Node's `zlib.crc32`; it errors if observed bytes exceed limits or disagree with the entry metadata. `ArchiveSession.close()` is idempotent and abort destroys active streams before closing the zip file.

Run the archive tests; expected: PASS without reading the complete archive into a buffer.

- [ ] **Step 5: Write failing bounded XML tests**

Test valid namespaced XML, ordered mixed XHTML nodes, malformed XML, `DOCTYPE`, `ENTITY`, over-limit input, and an aborted read:

```ts
expect(parseOrderedXml(Buffer.from('<root><b>safe</b> text</root>'), 1024)).toBeDefined();
expect(() => parseOrderedXml(Buffer.from('<!DOCTYPE root><root/>'), 1024)).toThrowError(
  expect.objectContaining({ code: 'xml_unsafe_declaration' })
);
```

Run the focused test; expected: FAIL.

- [ ] **Step 6: Implement ordered no-entity XML parsing**

Read XML entries through a bounded accumulator that aborts above `maxXmlBytes`. Reject `<!DOCTYPE` and `<!ENTITY` case-insensitively before parsing. Validate with `XMLValidator.validate`, then parse using:

```ts
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  trimValues: false
});
```

Export namespace-local-name, attribute, child, and text helpers so EPUB code never depends on one namespace prefix.

Run:

```powershell
npm run test:unit -- src/lib/server/ingestion/archive.test.ts src/lib/server/ingestion/xml.test.ts
npm run check
npm run lint
```

Expected: all archive/XML tests pass.

- [ ] **Step 7: Commit archive primitives**

```powershell
git add tests/fixtures/publications.ts src/lib/server/ingestion
git commit -m "feat: add safe archive ingestion primitives"
```

## Task 5: Normalize reflowable EPUB into semantic prose manifests

**Files:**
- Create: `src/lib/server/ingestion/image.ts`
- Create: `src/lib/server/ingestion/image.test.ts`
- Create: `src/lib/server/ingestion/prose.ts`
- Create: `src/lib/server/ingestion/prose.test.ts`
- Create: `src/lib/server/ingestion/epub.ts`
- Create: `src/lib/server/ingestion/epub.test.ts`
- Modify: `tests/fixtures/publications.ts`

- [ ] **Step 1: Write failing image-normalization tests**

Generate tiny PNG, JPEG, WebP, animated GIF, oversized-dimension header, corrupt image, and SVG inputs in memory. Prove that normalization:

- accepts only JPEG/PNG/WebP/GIF for EPUB and JPEG/PNG/WebP/GIF/TIFF for comics;
- returns WebP bytes plus media type, SHA-256, byte size, width, height, and animation warning;
- applies EXIF orientation and strips metadata;
- uses the first animated frame;
- rejects corrupt, SVG, and over-pixel input with stable codes.

Run:

```powershell
npm run test:unit -- src/lib/server/ingestion/image.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement streaming image inspection and normalization**

Use a bounded prefix replay helper with `fileTypeFromBuffer` for a signature hint, then pipe the complete replay stream through `sharp({ failOn: 'error', limitInputPixels: limits.maxImagePixels, animated: false })`. Call `rotate()`, constrain decoded dimensions, output `webp({ quality: 90, effort: 4 })`, stream directly to the deterministic storage key, and capture output info without buffering the full source or output.

Return:

```ts
export interface NormalizedImage {
  storageKey: StorageKey;
  mediaType: 'image/webp';
  checksumSha256: string;
  byteSize: number;
  width: number;
  height: number;
  warnings: readonly IngestionWarning[];
}
```

Run image tests; expected: PASS.

- [ ] **Step 3: Write failing XHTML-to-block tests**

Create `prose.test.ts` covering headings, paragraphs, nested emphasis/strong/code/sub/sup, quotes, ordered/unordered lists, thematic breaks, local images/alt text, comments, whitespace, safe external links, and rejected scripts/iframes/forms/remote images. Assert unsafe link schemes retain text but remove the link.

Canonical output:

```ts
expect(convertXhtmlToBlocks(xhtml, resourceContext)).toEqual([
  { kind: 'heading', level: 1, fragments: [{ text: 'Chapter One', marks: [] }] },
  {
    kind: 'paragraph',
    fragments: [
      { text: 'The ', marks: [] },
      { text: 'signal', marks: ['emphasis'] },
      { text: ' arrived.', marks: [] }
    ]
  },
  { kind: 'image', imageId: expectedImageId, alt: 'A distant station' }
]);
```

Run the test; expected: FAIL.

- [ ] **Step 4: Implement the strict semantic converter**

Walk ordered XML nodes with an allowlist. Convert block elements to the six `ProseBlockData` variants and inline elements to marked fragments. Merge adjacent fragments with identical marks/href, cap nesting depth and output text length, normalize whitespace according to block context, and discard style/class/id attributes and all publisher CSS. Throw stable permanent errors for executable/embedded/form nodes or remote resources.

Use deterministic UUID-shaped IDs derived from SHA-256 of `revisionId`, resource path, element kind, and ordinal. This keeps section/block/image anchors stable across an automatic retry of the same generation.

Run prose tests; expected: PASS.

- [ ] **Step 5: Write failing EPUB package tests**

Extend `validEpubFixture` with package metadata, navigation, two spine sections, inline formatting, and one local image. Test:

- valid EPUB 3 returns ordered sections/blocks/images, extracted metadata, navigation labels, warnings, and a cover suggestion;
- the `mimetype` entry must be first, stored, and exact;
- `container.xml` resolves one local package document;
- manifest IDs/hrefs and spine references are unique and local;
- navigation is present and spine order wins over ZIP order;
- fixed-layout metadata, `META-INF/encryption.xml`, scripts, remote resources, SVG spine/image dependencies, missing references, and unsupported media fail permanently;
- CSS is ignored and never appears in output;
- abort/timeout closes the archive and leaves only deterministic disposable derived objects.

Run:

```powershell
npm run test:unit -- src/lib/server/ingestion/epub.test.ts
```

Expected: FAIL because `ingestEpub` does not exist.

- [ ] **Step 6: Implement EPUB resolution and derived output**

`ingestEpub` must:

1. Open the archive and verify the EPUB ZIP/mimetype/container rules, including `mimetype` at local-header offset zero, stored compression, exact `application/epub+zip` bytes, and no data descriptor that could move validation after content.
2. Resolve the package path relative to `container.xml`; reject paths outside the archive.
3. Parse metadata, manifest, spine, navigation, and fixed-layout declarations.
4. Resolve every spine XHTML and referenced image locally.
5. Normalize images to deterministic `derived/v1/prose-images/{stableId}.webp` keys.
6. Convert spine XHTML into ordered sections and typed blocks.
7. Select a valid package cover as a separately normalized cover suggestion.
8. Return an immutable `EpubIngestionResult` containing complete rows ready for one database transaction.
9. Close the archive in `finally` and never write database state itself.

Run:

```powershell
npm run test:unit -- src/lib/server/ingestion/image.test.ts src/lib/server/ingestion/prose.test.ts src/lib/server/ingestion/epub.test.ts
npm run check
npm run lint
```

Expected: all EPUB/image tests pass.

- [ ] **Step 7: Commit EPUB ingestion**

```powershell
git add src/lib/server/ingestion tests/fixtures/publications.ts
git commit -m "feat: ingest reflowable epub revisions"
```

## Task 6: Normalize CBZ/ZIP comics and manual panel geometry

**Files:**
- Create: `src/lib/server/ingestion/natural-order.ts`
- Create: `src/lib/server/ingestion/natural-order.test.ts`
- Create: `src/lib/server/ingestion/comic.ts`
- Create: `src/lib/server/ingestion/comic.test.ts`
- Modify: `src/lib/server/ingestion/image.ts`
- Modify: `tests/fixtures/publications.ts`

- [ ] **Step 1: Write failing unambiguous natural-order tests**

Cover nested paths, numeric runs, leading zeros, Unicode normalization, case variants, and exact ambiguity:

```ts
expect(naturalComicOrder(['10.png', '2.png', '1.png'])).toEqual([
  '1.png', '2.png', '10.png'
]);
expect(() => naturalComicOrder(['Page-01.png', 'page-1.PNG'])).toThrowError(
  expect.objectContaining({ code: 'comic_ambiguous_page_order' })
);
```

Use one `Intl.Collator('en', { numeric: true, sensitivity: 'base' })`, with normalized path segments and an exact raw tie detector. Run the test first; expected: FAIL; implement and rerun; expected: PASS.

- [ ] **Step 2: Write failing comic-ingestion tests**

Use generated archives to prove:

- `__MACOSX/**`, `.DS_Store`, directories, and a bounded safe root `ComicInfo.xml` are ignored;
- JPEG, PNG, WebP, GIF, and TIFF pages normalize to one-based ordered WebP rows;
- ZIP central-directory order does not affect page order;
- empty comics, SVG, corrupt images, ambiguous names, excessive pixels, and unsupported files fail with stable codes;
- an animated image produces one first-frame page plus a warning;
- the first normalized page is copied to a deterministic cover-suggestion key;
- every output row contains stable ID, sanitized source path, checksum, size, width, and height.

Run:

```powershell
npm run test:unit -- src/lib/server/ingestion/comic.test.ts
```

Expected: FAIL because `ingestComic` does not exist.

- [ ] **Step 3: Implement comic selection and deterministic page derivation**

`ingestComic` opens the safe archive, filters recognized metadata, validates any root `ComicInfo.xml` with the bounded no-entity XML helper without using its values, verifies that every remaining regular file has an allowed image extension and decoded type, orders with `naturalComicOrder`, and normalizes entries sequentially to bound memory.

Write each page to:

```ts
comicPageKey(titleId, revisionId, stablePageId)
```

Return `ComicIngestionResult` with complete `comicPages`, warnings, and a separately keyed suggestion copied from page one. Do not invent panels; initial draft presentations contain zero panel rows and guided mode is false.

Always close the archive in `finally` and remove no retained/staged object in the parser.

- [ ] **Step 4: Run the complete pure-ingestion gate**

```powershell
npm run test:unit -- src/lib/server/ingestion tests/fixtures
npm run check
npm run lint
git diff --check
```

Expected: valid EPUB and comic fixtures normalize deterministically; every hostile fixture fails safely; unit tests require neither PostgreSQL nor Docker.

- [ ] **Step 5: Commit comic ingestion**

```powershell
git add src/lib/server/ingestion tests/fixtures/publications.ts
git commit -m "feat: ingest comic archive revisions"
```

## Task 7: Stream revision uploads and run idempotent ingestion jobs

**Files:**
- Create: `src/lib/server/uploads/multipart.ts`
- Create: `src/lib/server/uploads/multipart.test.ts`
- Create: `src/lib/server/uploads/stream-object.ts`
- Create: `src/lib/server/uploads/stream-object.test.ts`
- Create: `src/lib/server/catalog/errors.ts`
- Create: `src/lib/server/catalog/revisions.ts`
- Create: `src/lib/server/ingestion/job.ts`
- Create: `src/lib/server/ingestion/job.test.ts`
- Create: `src/lib/server/ingestion/handler.ts`
- Modify: `src/lib/server/catalog/service.ts`
- Modify: `src/lib/server/jobs/runner.ts`
- Modify: `src/lib/server/jobs/runner.test.ts`
- Modify: `src/worker.ts`
- Create: `src/routes/admin/catalog/[titleId]/revisions/upload/+server.ts`
- Create: `src/routes/admin/catalog/[titleId]/revisions/upload/server.test.ts`
- Modify: `scripts/with-test-database.ts`
- Create: `tests/integration/storage-ingestion.test.ts`

- [ ] **Step 1: Write failing one-file multipart tests**

Construct multipart `Request` objects with `FormData` and cover both the generic `parseSingleFileMultipart` primitive and its publication wrapper:

- exactly one field named `original` plus `changeSummary` and optional `parentRevisionId`;
- field-name, field-value, filename, file, part, and total-byte limits;
- zero files, two files, wrong file field, truncated stream, and client abort;
- filename normalization to a safe display leaf without allowing it into a storage key;
- draining rejected file streams so the parser always terminates.

The result contract is:

```ts
interface ParsedPublicationUpload {
  filename: string;
  mediaType: string;
  changeSummary: string;
  parentRevisionId: string | null;
  file: Readable;
  completion: Promise<void>;
}
```

Run:

```powershell
npm run test:unit -- src/lib/server/uploads/multipart.test.ts
```

Expected: FAIL because `parsePublicationUpload` does not exist.

- [ ] **Step 2: Implement backpressure-aware multipart parsing**

Implement `parseSingleFileMultipart(request, { fileField, fieldsSchema, limits })`; `parsePublicationUpload` is a strict wrapper configuring `original`, two small fields, and the publication schema. Construct `new Busboy({ headers, limits: { files: 1, fields: 2, parts: 3, fileSize: maxUploadBytes, fieldSize: 4_000, fieldNameSize: 100 } })`, convert the request Web stream with `Readable.fromWeb`, and pipe it through an outer counting transform into Busboy. The outer limit is `maxUploadBytes + 65_536` so multipart overhead cannot bypass a total-request bound. Reject limit events with `UploadError` codes. Never call `request.formData()` for a file.

Expose the file stream as soon as Busboy emits it, but resolve `completion` only after the file and all fields finish and strict Zod field validation passes. Normalize the filename with `basename(filename.normalize('NFC'))`, remove controls, and cap it at 255 Unicode code points.

Run multipart tests; expected: PASS.

- [ ] **Step 3: Write and implement staged streaming tests**

Import `createHash` from `node:crypto`. Test that `streamObjectWithSha256` writes a multi-chunk stream, returns exact size/hash, and leaves no object after byte excess, source error, abort, or storage failure:

```ts
const expectedHash = createHash('sha256').update('abcdef').digest('hex');
expect(await streamObjectWithSha256(storage, key, Readable.from(['abc', 'def']), 6, signal))
  .toEqual({ byteSize: 6, checksumSha256: expectedHash });
```

Implement with a counting/hash transform piped into `storage.write`; on failure, attempt exact-key delete and rethrow the safe upload/storage error. Export and test `hashStoredObject(storage, key, maxBytes, signal)` for post-copy verification without buffering. Run the focused test; expected: PASS.

- [ ] **Step 4: Write failing upload-transaction integration tests**

In `storage-ingestion.test.ts`, create an admin, a prose title, and a staged valid EPUB. Assert `acceptRevisionUpload` atomically creates:

- one `uploaded` revision with staging metadata and generation zero;
- one pending `catalog.ingest_revision` job whose payload contains only revision ID and generation;
- deduplication key `catalog.ingest:{revisionId}:0`;
- one safe `catalog.revision.upload` audit event.

Also assert customer rejection writes nothing, parent must belong to the title, prose requires `.epub`, comic requires `.cbz` or `.zip`, and a forced audit/job failure rolls back the revision. Run the test; expected: FAIL.

- [ ] **Step 5: Implement revision acceptance and job payload validation**

Create `job.ts`:

```ts
export const INGEST_REVISION_JOB = 'catalog.ingest_revision';
const payloadSchema = z.strictObject({ revisionId: z.uuid(), generation: z.number().int().min(0) });

export function enqueueRevisionIngestion(
  database: DatabaseExecutor,
  revisionId: string,
  generation: number
) {
  return enqueueJob(database, {
    type: INGEST_REVISION_JOB,
    payload: { revisionId, generation },
    deduplicationKey: `catalog.ingest:${revisionId}:${generation}`,
    maxAttempts: 5
  });
}
```

Implement `acceptRevisionUpload` in `revisions.ts`: authorize first, parse strict input, validate title/format/parent, insert the revision and enqueue/audit inside `withTransaction`. Keep `service.ts` as re-exports for existing imports and move its current functions without duplicating logic.

Run the integration test; expected: upload transaction cases PASS.

- [ ] **Step 6: Write failing ingestion-handler integration tests**

Using real PostgreSQL plus temporary local storage, cover:

- valid EPUB and comic jobs move `uploaded -> processing -> ready_for_review`;
- retained original bytes equal the staged bytes and checksum;
- all manifest/suggestion/warning rows commit together;
- deterministic retry after a simulated pre-commit failure produces no duplicate rows/objects;
- a stale generation is a successful no-op;
- a permanent validation error marks only the candidate `failed`, stores a stable code/safe detail, and audits failure;
- a transient error before max attempts leaves `processing` and rethrows for queue backoff;
- a transient error on the final attempt marks `failed`;
- the current active/public revision and title visibility are unchanged in every candidate path;
- initial draft preview defaults to the end of section one only when later prose remains, or `min(3, pageCount - 1)` for a comic with at least two pages; otherwise it remains unconfigured and cannot be published.

Run the focused integration test; expected: FAIL because the handler is absent.

- [ ] **Step 7: Implement idempotent handler state transitions**

`createRevisionIngestionHandler(database, storage, limits)` must:

1. Parse the payload and load revision/title under a short transaction.
2. Return without work when generation differs or the revision is already ready/active/retired.
3. Permit `uploaded`, `processing`, or retryable `failed` for the matching generation and mark processing timestamps safely.
4. Combine worker shutdown with `AbortSignal.timeout(limits.timeoutMs)`.
5. Dispatch by title format to `ingestEpub` or `ingestComic`.
6. Copy the staged bytes to the deterministic retained-original key, then stream/hash that destination and verify both size and SHA-256 against the staged result before committing a reference.
7. In one transaction, re-check generation/state, delete candidate-only manifest rows, insert the complete manifest/suggestion/warnings/draft, set accepted-original fields, clear staging/failure fields, set `ready_for_review`, and append `catalog.revision.ingest.succeeded` with a system actor.
8. Delete the staging object only after commit; a delete failure is logged as a safe keyless warning and left for maintenance.
9. On terminal failure, transactionally mark the candidate failed and audit the safe code; throw `PermanentJobError` for permanent failures and an ordinary error for retryable queue handling.

Do not include storage keys, raw paths, or parser causes in audit data or `failureDetails`.

- [ ] **Step 8: Add worker concurrency, storage readiness, and handler registration**

First extend `runner.test.ts` to prove `concurrency: 2` can hold two jobs simultaneously, each slot uses a distinct lease owner suffix, abort stops all loops, and `concurrency: 1` preserves existing behavior. Expected: FAIL.

Refactor `runWorker` into one private loop and:

```ts
await Promise.all(
  Array.from({ length: options.concurrency }, (_, slot) =>
    runWorkerLoop({ ...options, workerId: `${options.workerId}:${slot}` })
  )
);
```

In `src/worker.ts`, construct/probe storage before writing the ready file, register `INGEST_REVISION_JOB`, pass `config.jobs.concurrency`, and preserve outbox/email handlers. Run runner tests; expected: PASS.

- [ ] **Step 9: Add the authorized streaming upload endpoint**

The endpoint must authorize `catalog.manage` before reading the body, validate `titleId`, parse/stream the multipart file to `stagingUploadKey(randomUUID())`, await parser completion, then call `acceptRevisionUpload` with `safeAuditRequestMetadata(request, route.id)`. On any pre-transaction error, delete the exact staging key. Return `202` with only `{ revisionId, state: 'uploaded' }` and `cache-control: no-store`.

Route tests mock storage/catalog services and prove anonymous/customer requests do not consume the body, invalid multipart maps to 400/413, missing title to 404, conflict to 409, and success passes only the server actor plus validated/generated correlation ID.

- [ ] **Step 10: Give disposable integration/E2E runs an isolated storage root**

In `scripts/with-test-database.ts`, create `const storageRoot = await mkdtemp(join(tmpdir(), 'pale-orbit-test-storage-'))`, add all Task 1 storage/ingestion settings to `testEnvironment`, and in `finally` resolve/verify that the directory begins with `tmpdir()` plus the fixed prefix before `rm(storageRoot, { recursive: true, force: true })`.

Run:

```powershell
npm run test:unit -- src/lib/server/uploads src/lib/server/jobs/runner.test.ts src/lib/server/ingestion/job.test.ts src/routes/admin/catalog/[titleId]/revisions/upload/server.test.ts
npm run test:integration -- tests/integration/storage-ingestion.test.ts
npm run check
npm run lint
```

Expected: upload, worker, EPUB, comic, failure, retry, and rollback-safety cases pass.

- [ ] **Step 11: Commit upload and worker ingestion**

```powershell
git add src/lib/server/uploads src/lib/server/catalog src/lib/server/ingestion src/lib/server/jobs src/routes/admin/catalog src/worker.ts scripts/with-test-database.ts tests/integration/storage-ingestion.test.ts
git commit -m "feat: process uploaded publication revisions"
```

## Task 8: Implement metadata, covers, reader settings, and publication transactions

**Files:**
- Create: `src/lib/server/catalog/lock.ts`
- Create: `src/lib/server/catalog/titles.ts`
- Create: `src/lib/server/catalog/covers.ts`
- Create: `src/lib/server/catalog/presentations.ts`
- Create: `src/lib/server/catalog/publication.ts`
- Modify: `src/lib/server/catalog/input.ts`
- Modify: `src/lib/server/catalog/input.test.ts`
- Modify: `src/lib/server/catalog/service.ts`
- Create: `tests/integration/publication.test.ts`

- [ ] **Step 1: Expand strict catalog input tests**

Add Zod tests for metadata updates, cover suggestion confirmation, draft preview/panel replacement, expected presentation timestamp, and publication action IDs. Reject unknown keys, format changes after title creation, invalid money/currency/slug, full-work preview boundaries, cross-revision IDs, duplicate panel ordinals, and invalid normalized rectangles.

Use this panel input shape:

```ts
{
  pageId,
  ordinal: 1,
  x: 0.125,
  y: 0.25,
  width: 0.5,
  height: 0.375
}
```

Run `npm run test:unit -- src/lib/server/catalog/input.test.ts`; expected: FAIL; implement parsers by composing `content.ts`; expected: PASS.

- [ ] **Step 2: Write failing metadata and cover integration tests**

Prove that:

- create/update metadata is authorized, audited, strict, and immediately queryable;
- format cannot change after creation;
- confirming a same-revision suggestion copies it to a new title-cover key then updates cover metadata transactionally;
- a standalone JPEG/PNG cover normalizes before the pointer update;
- confirming a suggestion from another title/revision fails;
- changing active revision or rollback never changes the confirmed cover;
- a database failure after object creation leaves an unreferenced cover eligible for delayed cleanup and does not change the title.

Run `npm run test:integration -- tests/integration/publication.test.ts`; expected: FAIL.

- [ ] **Step 3: Implement focused title and cover services**

Move `createPrivateTitle` to `titles.ts`; add `updateTitleMetadata` and list/detail admin queries. Implement cover functions that normalize/copy to `titleCoverKey(titleId, randomUUID())`, then lock the title row, update all cover metadata and `coverUpdatedAt`, and append a redacted audit event in one transaction. Return title IDs/checksums, not keys.

Use safe actions `catalog.title.update`, `catalog.cover.confirm_suggestion`, and `catalog.cover.replace`.

- [ ] **Step 4: Write failing draft/publish settings integration tests**

Cover prose and comic drafts:

- only `ready_for_review`, `active`, or `retired` accepted revisions may edit settings;
- preview IDs/page belong to that revision and stop before the final work unit;
- optimistic `expectedUpdatedAt` rejects stale admin tabs;
- panel replacement is all-or-nothing and same-revision;
- comic settings cannot publish until every page has at least one valid ordered region when guided mode is requested;
- whole-page-only settings may publish with no panels;
- publishing supersedes old published, promotes draft, clones a new draft and all panels, and audits atomically;
- a public reader transaction sees either old or new published settings, never an intermediate state.

Run the focused integration test; expected: FAIL.

- [ ] **Step 5: Implement presentation drafts and atomic publication**

`saveDraftPresentation` locks the draft, compares `updatedAt`, validates the boundary against ordered manifest rows, updates reading direction/guided flag/boundary, replaces panel rows, and audits a draft save without publishing it.

`publishReaderSettings` takes the per-title advisory lock, re-checks the actor's current `admin` row, locks revision/draft/current-published rows, validates complete publishability, supersedes current published, promotes draft, inserts a new draft copy, copies panel rows to the new draft with new UUIDs, and appends `catalog.reader_settings.publish` in one transaction.

- [ ] **Step 6: Write failing lifecycle integration tests**

Test the complete state machine:

- private activation requires `ready_for_review` plus published settings;
- private replacement retires any old active revision and preserves private visibility;
- first storefront publication requires private visibility plus valid active/published settings;
- a public title rejects generic activation and accepts only **Publish replacement**;
- public replacement atomically swaps states/pointer and retains old availability until commit;
- rollback accepts only a same-title retired accepted revision with published settings;
- withdrawal changes public to private without changing active revision/files;
- re-publication is explicit;
- stale actor snapshot cannot publish after concurrent admin demotion;
- concurrent replacement/rollback attempts serialize under the title advisory lock;
- every success emits one safe audit event and every rejected precondition leaves all rows unchanged.

Run the focused integration test; expected: FAIL.

- [ ] **Step 7: Implement serialized publication commands**

Create `withLockedAdminTitle(transaction, actor, titleId, callback)` that acquires `pg_advisory_xact_lock(hashtextextended(titleId, 0))`, re-reads `user_roles` for the actor, locks the title, and then invokes the callback.

Implement commands with exact action names:

```ts
activatePrivateRevision       // catalog.revision.activate_private
publishTitleToStorefront      // catalog.title.publish
publishReplacementRevision    // catalog.revision.publish_replacement
rollbackRevision              // catalog.revision.rollback
withdrawTitle                 // catalog.title.withdraw
```

Each command performs all pointer/state/timestamp/audit changes inside the locked transaction. Background/system actors are not accepted by publication commands.

- [ ] **Step 8: Add safe manual retry**

`retryFailedRevision` requires a failed candidate and an available staging source. Copy it first to a fresh staging key, then in one transaction increment `ingestionGeneration`, point at the fresh staging object, clear safe failure fields/timestamps, set `uploaded`, enqueue the new generation, and audit `catalog.revision.retry`. A transaction failure leaves only a delayed-cleanup staging orphan. If no source remains, return a conflict instructing the admin to upload a new immutable revision.

- [ ] **Step 9: Run the catalog domain gate and commit**

```powershell
npm run test:unit -- src/lib/server/catalog
npm run test:integration -- tests/integration/catalog.test.ts tests/integration/publication.test.ts tests/integration/storage-ingestion.test.ts
npm run check
npm run lint
git diff --check
git add src/lib/server/catalog tests/integration/publication.test.ts
git commit -m "feat: add reviewed publication lifecycle"
```

Expected: metadata, covers, drafts, settings publication, activation, public replacement, rollback, withdrawal, and retry pass without weakening earlier catalog tests.

## Task 9: Add catalog queries and authorize every media/original stream

**Files:**
- Create: `src/lib/server/catalog/reader.ts`
- Create: `src/lib/server/catalog/reader.test.ts`
- Create: `src/lib/server/catalog/media.ts`
- Create: `src/lib/server/catalog/media.test.ts`
- Create: `src/lib/server/http/range.ts`
- Create: `src/lib/server/http/range.test.ts`
- Create: `src/routes/media/covers/[titleId]/[checksum]/+server.ts`
- Create: `src/routes/media/revisions/[revisionId]/images/[imageId]/[checksum]/+server.ts`
- Create: `src/routes/media/revisions/[revisionId]/cover-suggestion/[suggestionId]/[checksum]/+server.ts`
- Create: `src/routes/admin/catalog/[titleId]/revisions/[revisionId]/original/+server.ts`
- Create: `src/routes/media/media-routes.test.ts`

- [ ] **Step 1: Write failing public/admin reader-query tests**

Build prose/comic titles with active and candidate revisions plus draft/published presentations. Assert:

- public list/detail returns only public titles with valid active/published rows;
- prose preview includes ordered blocks through the final published block and excludes every later block/image-only reference;
- comic preview includes pages through the final published page and only published panel data;
- draft changes do not affect public DTOs;
- admin review returns the complete selected revision and requested draft/published presentation;
- DTO JSON contains no field matching `/storage|sourcePath|uploadFilename/i`;
- private/withdrawn/missing titles have the same public not-found result.

Run `npm run test:unit -- src/lib/server/catalog/reader.test.ts`; expected: FAIL.

- [ ] **Step 2: Implement boundary-first reader DTO queries**

Create separate functions:

```ts
listPublicCatalog(database): Promise<readonly CatalogTitleSummary[]>
getPublicTitleDetail(database, slug): Promise<CatalogTitleDetail | null>
getPublicPreview(database, slug): Promise<ReaderDocument | null>
getAdminRevisionReader(database, actor, revisionId, presentationState): Promise<ReaderDocument>
```

Public queries join from `titles.active_revision_id` and the unique published presentation before loading manifest rows. Apply the semantic boundary in SQL/order-aware service logic before mapping media URLs. Admin queries authorize first and load all manifest rows. Never load an object key into a client DTO field.

Run reader tests; expected: PASS.

- [ ] **Step 3: Write and implement strict single-range parsing**

Test absent range, valid open/closed/suffix ranges, malformed/multiple ranges, zero-size objects, and unsatisfiable ranges. Implement:

```ts
export type ByteRange = { start: number; endInclusive: number } | null;
export function parseSingleRange(header: string | null, size: number): ByteRange;
```

Multiple ranges return a typed 416 error rather than multipart output. Run range tests; expected: PASS.

- [ ] **Step 4: Write failing media-authorization tests**

Cover:

- a public current cover with matching checksum;
- private cover denied to anonymous/customer and allowed to admin;
- public prose image allowed only if referenced at/before the preview boundary;
- public comic image allowed only for a preview page;
- candidate, retired non-active, after-boundary, wrong-checksum, and cross-revision IDs denied publicly;
- admin can read accepted candidate/retired assets for review;
- cover suggestions are visible only to an authorized administrator for that same revision and are never public media;
- original download requires admin and accepted-original metadata;
- a requested original download appends `catalog.original.download` without storing filename/key;
- full/range responses include correct length/range, ETag, safe content type/disposition, `nosniff`, and cache policy.

Run `npm run test:unit -- src/lib/server/catalog/media.test.ts`; expected: FAIL.

- [ ] **Step 5: Implement server-side media resolution**

`resolveCoverAccess`, `resolveReaderImageAccess`, `resolveCoverSuggestionAccess`, and `resolveOriginalDownload` query by public IDs/checksum, authorize against the title's current visibility/revision/presentation boundary or `catalog.manage`, and return an internal `{ key, stat, mediaType, filename, cache }` object. Suggestion access always requires `catalog.manage`. The internal key type never crosses the route boundary.

For immutable checksum URLs use `public, max-age=31536000, immutable` only after public authorization; private/admin responses use `private, no-store`. Original downloads use `attachment` with ASCII fallback plus RFC 5987 `filename*`, and audit the authorized initiation before returning the stream.

- [ ] **Step 6: Add thin streaming routes and route tests**

Each route validates UUID/checksum params, delegates authorization, parses one range where supported, opens `storage.read`/`readRange`, converts the Node stream with `Readable.toWeb`, and returns a `Response`. Map missing/unauthorized public media to 404 to avoid existence disclosure; admin authentication errors remain 401/403.

Run:

```powershell
npm run test:unit -- src/lib/server/catalog/reader.test.ts src/lib/server/catalog/media.test.ts src/lib/server/http/range.test.ts src/routes/media/media-routes.test.ts
npm run check
npm run lint
```

Expected: every byte route is authorized and range/header behavior passes.

- [ ] **Step 7: Commit reader queries and media protection**

```powershell
git add src/lib/server/catalog/reader.ts src/lib/server/catalog/reader.test.ts src/lib/server/catalog/media.ts src/lib/server/catalog/media.test.ts src/lib/server/http src/routes/media src/routes/admin/catalog/[titleId]/revisions/[revisionId]/original
git commit -m "feat: authorize publication media access"
```

## Task 10: Render database publications and replace public prototype routes

**Files:**
- Create: `src/lib/reader/publication-pagination.ts`
- Create: `src/lib/reader/publication-pagination.test.ts`
- Modify: `src/lib/types/reader.ts`
- Modify: `src/lib/components/BookReader.svelte`
- Modify: `src/lib/components/PageFace.svelte`
- Modify: `src/lib/components/reader/ReaderGuidedPanel.svelte`
- Modify: `src/lib/components/reader/ReaderOpeningRig.svelte`
- Modify: `src/lib/components/reader/ReaderSpread.svelte`
- Create: `src/routes/catalog/+page.server.ts`
- Modify: `src/routes/catalog/+page.svelte`
- Create: `src/routes/book/[id]/+page.server.ts`
- Modify: `src/routes/book/[id]/+page.svelte`
- Create: `src/routes/read/[id]/+page.server.ts`
- Modify: `src/routes/read/[id]/+page.svelte`
- Create: `src/routes/studio/+page.server.ts`
- Delete: `src/routes/studio/+page.svelte`
- Modify: `src/lib/components/CoverArt.svelte`
- Create: `src/routes/public-routes.test.ts`

- [ ] **Step 1: Write failing semantic pagination tests**

Keep the current prototype `src/lib/paginate.ts` unchanged for the out-of-scope prototype library. Test the new paginator with server DTOs:

- headings, paragraphs, quotes, lists, breaks, inline marks/links, and images preserve order;
- reflow changes visual pages but numeric section/character anchors restore position;
- comic output contains the authorized page URL and normalized panel regions;
- no client preview percentage/chapter heuristic is applied;
- a preview document ends exactly where the server DTO ends.

Representative assertion:

```ts
const pages = paginatePublication(document, box);
expect(pages.flatMap((page) => page.blocks ?? []).map((block) => block.sourceBlockId))
  .toEqual([headingId, paragraphId, imageBlockId]);
```

Run `npm run test:unit -- src/lib/reader/publication-pagination.test.ts`; expected: FAIL.

- [ ] **Step 2: Extend reader page types without breaking the prototype paginator**

Add optional rich fields to existing page variants:

```ts
export interface TextReaderPage extends ReaderPageBase {
  type: 'text';
  heading: string | null;
  paras: string[];
  blocks?: readonly RenderedProseBlock[];
}

export interface ComicReaderPage extends ReaderPageBase {
  type: 'comic';
  layout: PanelCell[];
  imageUrl?: string;
  panels?: readonly PanelRegionDto[];
}
```

Change `ReaderProps` to `{ document: ReaderDocument; access: ReaderAccess; onclose?; onbuy? }`. Existing animation/sheet-window types continue to use the expanded `ReaderPage` union, so old prototype paginator tests remain valid.

- [ ] **Step 3: Implement publication pagination**

Convert semantic blocks into visual page blocks using the existing page-box budget. Never split list items or image blocks; a single oversized paragraph may split only its rendered fragments while retaining `sourceBlockId` and character offset. Comic documents produce one `ComicReaderPage` per authorized page with real image and panel data.

Run:

```powershell
npm run test:unit -- src/lib/reader/publication-pagination.test.ts src/lib/paginate.test.ts src/lib/reader
```

Expected: new and legacy pagination tests pass.

- [ ] **Step 4: Render rich prose, real pages, and normalized panel crops**

Update `PageFace.svelte` to prefer `blocks` and render each discriminated block with Svelte elements, recursively rendering inline fragments through a small focused snippet/component. Safe href values come only from the server DTO; still set `rel="noopener noreferrer"` and an external target. Render comic pages with `<img src={page.imageUrl}>`, not synthetic hatch art.

Update `ReaderGuidedPanel.svelte` to accept `{ imageUrl, pageWidth, pageHeight, panel }` and crop with an overflow-hidden frame plus an absolutely positioned image:

```svelte
<img
  src={imageUrl}
  alt=""
  style:left="{-panel.x / panel.width * 100}%"
  style:top="{-panel.y / panel.height * 100}%"
  style:width="{100 / panel.width}%"
  style:height="{100 / panel.height}%"
/>
```

Preserve aspect ratio and clamp already-validated values defensively.

- [ ] **Step 5: Make BookReader trust server access boundaries**

Replace `paginate(title, box)`, `library.owns`, `sample`, and `freeSheets` with `paginatePublication(document, box)` and `access`. For preview access, all delivered pages are readable and one step beyond the final sheet shows the paywall; for admin access, there is no paywall. Guided mode appears only when `document.format === 'comic' && document.guidedViewAvailable`.

Continue storing preferences/progress/bookmarks locally by document ID, but do not treat `library.owned` as authorization.

- [ ] **Step 6: Write failing public loader tests**

Mock the server query module and assert:

- `/catalog` loads `listPublicCatalog`;
- `/book/[id]` resolves the slug and throws a public 404 for private/missing;
- `/read/[id]` always loads `getPublicPreview` for non-admin users during Plan 4;
- a real admin may pass `?revision={uuid}&presentation=draft|published` only through the admin review route, not the public read URL;
- `/studio` redirects 303 to `/admin/catalog`;
- no loader imports `$lib/data/catalog`, `$lib/stores/titles.svelte`, or local ownership state.

Run `npm run test:unit -- src/routes/public-routes.test.ts`; expected: FAIL.

- [ ] **Step 7: Replace catalog/detail/read pages with server data**

Add the three server loaders and update Svelte pages to consume `data`. Keep the established visual language, map prices from minor units with `Intl.NumberFormat`, use checksum-versioned cover URLs, show semantic contents/page count, and label the reader CTA as a free preview. Purchase UI may show the configured one-time price but remains disabled with a clear “Purchasing opens after checkout is connected” message.

Delete the Studio component and add only the server redirect. Do not create client-side catalog state from database rows.

- [ ] **Step 8: Run public reader regression gates and commit**

```powershell
npm run test:unit -- src/lib/reader src/lib/paginate.test.ts src/routes/public-routes.test.ts
npm run check
npm run lint
git diff --check
git add src/lib/types/reader.ts src/lib/reader/publication-pagination.ts src/lib/reader/publication-pagination.test.ts src/lib/components src/routes/catalog src/routes/book src/routes/read src/routes/studio src/routes/public-routes.test.ts
git commit -m "feat: serve database-backed publication previews"
```

Expected: public catalog/detail/preview pages use only authorized database DTOs, and existing reader animation/navigation tests still pass.

## Task 11: Build the protected catalog and revision-review dashboard

**Files:**
- Modify: `src/routes/admin/+layout.svelte`
- Modify: `src/routes/admin/+page.svelte`
- Create: `src/routes/admin/catalog/+page.server.ts`
- Create: `src/routes/admin/catalog/+page.svelte`
- Create: `src/routes/admin/catalog/new/+page.server.ts`
- Create: `src/routes/admin/catalog/new/+page.svelte`
- Create: `src/routes/admin/catalog/[titleId]/+page.server.ts`
- Create: `src/routes/admin/catalog/[titleId]/+page.svelte`
- Create: `src/routes/admin/catalog/[titleId]/cover/+server.ts`
- Create: `src/routes/admin/catalog/[titleId]/revisions/[revisionId]/+page.server.ts`
- Create: `src/routes/admin/catalog/[titleId]/revisions/[revisionId]/+page.svelte`
- Create: `src/routes/admin/catalog/[titleId]/revisions/[revisionId]/status/+server.ts`
- Create: `src/lib/components/admin/CatalogTitleForm.svelte`
- Create: `src/lib/components/admin/RevisionUploadForm.svelte`
- Create: `src/lib/components/admin/RevisionStatus.svelte`
- Create: `src/lib/components/admin/PreviewBoundaryEditor.svelte`
- Create: `src/lib/components/admin/PanelEditor.svelte`
- Create: `src/lib/components/admin/PublicationActions.svelte`
- Create: `src/routes/admin/catalog/catalog-routes.test.ts`
- Create: `src/lib/components/admin/panel-geometry.ts`
- Create: `src/lib/components/admin/panel-geometry.test.ts`

- [ ] **Step 1: Write failing admin route/action tests**

Mock focused catalog services and cover/storage runtime. Cover:

- every load/action/endpoint rejects anonymous and customer actors before querying or consuming a body;
- catalog list/create/edit maps strict validation and domain errors to safe 400/404/409 responses;
- revision review loads the full admin document plus title/revision/presentation/warnings/suggestion;
- metadata, suggestion confirmation, settings save/publish, private activation, storefront publication, public replacement, rollback, withdrawal, and retry pass only server actor/correlation ID and explicit IDs;
- status polling returns only state, timestamps, warnings, and safe failure information;
- cover upload accepts one JPEG/PNG, streams/normalizes it, and rejects size/type errors safely;
- no response serializes a storage key or local path.

Run:

```powershell
npm run test:unit -- src/routes/admin/catalog/catalog-routes.test.ts
```

Expected: FAIL because admin catalog routes do not exist.

- [ ] **Step 2: Implement catalog list, create, and title editor actions**

Use the existing protected admin layout plus explicit `requireCapability` inside every server load/action. `/admin/catalog` returns compact admin title rows. `/admin/catalog/new` creates a private title and redirects to its editor. The title editor exposes strict small form actions for metadata and lifecycle commands; it never handles file bytes through `request.formData()` except small scalar fields.

Map `AuthorizationError`, `CatalogDomainError`, optimistic conflicts, and validation errors centrally in a route-local helper to avoid inconsistent messages. Every mutation supplies `safeAuditRequestMetadata(request, route.id)`; service tests may omit it, producing a nullable historical-compatible audit field.

- [ ] **Step 3: Implement streamed cover and revision status endpoints**

The cover endpoint reuses the one-file multipart parser with a lower 25 MiB compressed limit and fields disabled, stages the input, verifies JPEG/PNG through the image module, calls `replaceTitleCover`, and deletes staging in `finally`. Return `202`/success metadata without a key.

The status endpoint uses `cache-control: no-store`, validates both title/revision IDs and same-title ownership, and returns:

```ts
{
  state,
  processingStartedAt,
  processedAt,
  failure: failureCode ? { code: failureCode, message: failureDetails } : null,
  warnings
}
```

- [ ] **Step 4: Write and implement normalized panel editor geometry tests**

Test pointer drag in every direction, minimum region size, clamping, resize, and round-trip serialization:

```ts
expect(normalizeDragBox({ x: 180, y: 90 }, { x: 20, y: 10 }, { width: 200, height: 100 }))
  .toEqual({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
```

Implement pure geometry helpers before the Svelte component. Expected precision is six decimal places; zero/near-zero boxes are rejected.

- [ ] **Step 5: Build focused admin components**

- `CatalogTitleForm` owns metadata fields and displays server validation.
- `RevisionUploadForm` accepts `.epub` for prose or `.cbz,.zip` for comics, sends multipart through `fetch`, and navigates to the returned revision.
- `RevisionStatus` polls the no-store endpoint with exponential UI delay capped at five seconds and stops on ready/failed/unmount.
- `PreviewBoundaryEditor` uses section/block labels or comic page thumbnails and submits stable IDs/page number.
- `PanelEditor` overlays draggable normalized boxes on one page image, supports create/select/delete/reorder, keyboard nudging, and emits strict JSON for the small settings action. It does not claim guided readiness locally; the server response decides.
- `PublicationActions` shows only domain-valid actions and requires a confirmation dialog with the exact current/candidate revision effect.

Keep components under roughly 250 lines; move geometry and form mapping into focused modules instead of recreating a monolithic Studio page.

- [ ] **Step 6: Build the revision review page**

The page shows status, safe warnings/failure, immutable original metadata/download link, extracted navigation/pages, cover suggestion, full `BookReader access="admin"`, draft/published settings state, panel editor for comics, and publication actions.

An `uploaded`/`processing` page renders status polling and no publish controls. `failed` renders retry only when the server says a retained staging source exists. `ready_for_review` renders settings/preview controls. A public title labels replacement explicitly and does not render generic activation.

- [ ] **Step 7: Replace admin navigation placeholders**

Change Catalog to a real link, retain Audit until Task 12, and keep Sales visibly unavailable. Update the overview text and add counts from safe catalog queries only; do not fabricate sales/job data.

- [ ] **Step 8: Run admin UI/route gates and commit**

```powershell
npm run test:unit -- src/routes/admin src/lib/components/admin
npm run check
npm run lint
git diff --check
git add src/routes/admin src/lib/components/admin
git commit -m "feat: add catalog revision review dashboard"
```

Expected: all protected catalog workflows render from server state, files use streaming endpoints, and no local Studio publishing state remains.

## Task 12: Add filtered audit browsing with audited detail access

**Files:**
- Create: `src/lib/server/audit/query.ts`
- Create: `src/lib/server/audit/query.test.ts`
- Create: `tests/integration/audit-query.test.ts`
- Create: `src/routes/admin/audit/+page.server.ts`
- Create: `src/routes/admin/audit/+page.svelte`
- Create: `src/routes/admin/audit/[eventId]/+page.server.ts`
- Create: `src/routes/admin/audit/[eventId]/+page.svelte`
- Create: `src/lib/components/admin/AuditFilters.svelte`
- Create: `src/routes/admin/audit/audit-routes.test.ts`
- Modify: `src/routes/admin/+layout.svelte`

- [ ] **Step 1: Write failing audit-filter and cursor tests**

Test strict parsing for actor ID, action, resource type/ID, outcome, UTC from/to dates, cursor, and page size capped at 50. Reject unknown query keys, invalid dates, inverted ranges, malformed cursors, and values over 200 characters.

The cursor encodes exactly:

```ts
interface AuditCursor {
  occurredAt: string;
  id: string;
}
```

Use base64url JSON with strict decode/Zod validation; it is pagination state, not authorization state.

- [ ] **Step 2: Write failing real-PostgreSQL query tests**

Insert tied timestamps and varied actors/actions/resources/outcomes. Assert stable newest-first `(occurred_at DESC, id DESC)` pagination has no duplicates/gaps and every filter combines with AND semantics. Assert the summary projection omits `before`, `after`, and request metadata.

Test `getAuditEventDetail`:

- requires `audit.read`;
- returns sanitized context for one event;
- appends one `audit.event.view` event containing only the viewed event ID;
- list/filter calls append no events;
- missing ID returns not found without an audit row;
- viewing an `audit.event.view` row creates one ordinary new view event and no automatic recursion.

Run:

```powershell
npm run test:integration -- tests/integration/audit-query.test.ts
```

Expected: FAIL because audit queries do not exist.

- [ ] **Step 3: Implement keyset queries and audited detail transaction**

`listAuditEvents(database, actor, filters)` authorizes first, selects only summary columns, applies cursor comparison `(occurredAt, id) < (...)`, requests `pageSize + 1`, and emits a next cursor only when another row exists.

`getAuditEventDetail(database, { actor, eventId, correlationId })` uses one transaction to select the event and append:

```ts
{
  action: 'audit.event.view',
  outcome: 'succeeded',
  resourceType: 'audit_event',
  resourceId: eventId,
  after: { viewedEventId: eventId }
}
```

Pass stored JSON through the existing redactor again before returning it as defense in depth.

- [ ] **Step 4: Add protected audit routes and views**

The list loader parses `url.searchParams`, calls the query, and renders `AuditFilters`, stable summaries, and next-page link. The detail loader validates UUID, calls the audited service with a validated/generated correlation ID, and renders formatted safe JSON using text interpolation, never `{@html}`.

Route tests prove server authorization, strict bad-query mapping, missing detail 404, and correlation handling.

- [ ] **Step 5: Enable Audit navigation and run gates**

```powershell
npm run test:unit -- src/lib/server/audit src/routes/admin/audit
npm run test:integration -- tests/integration/audit.test.ts tests/integration/audit-query.test.ts
npm run check
npm run lint
git diff --check
git add src/lib/server/audit src/routes/admin/audit src/lib/components/admin/AuditFilters.svelte src/routes/admin/+layout.svelte tests/integration/audit-query.test.ts
git commit -m "feat: add protected audit trail viewer"
```

Expected: filtered list and audited detail pass without exposing sensitive context.

## Task 13: Add safe cleanup, private volumes, health, backups, and runbooks

**Files:**
- Create: `src/lib/server/storage/cleanup.ts`
- Create: `src/lib/server/storage/cleanup.test.ts`
- Create: `tests/integration/storage-cleanup.test.ts`
- Create: `src/cleanup-storage.ts`
- Create: `src/lib/server/config/storage-maintenance.ts`
- Create: `src/lib/server/config/storage-maintenance.test.ts`
- Modify: `package.json`
- Modify: `vite.services.config.ts`
- Modify: `.gitignore`
- Modify: `.dockerignore`
- Modify: `compose.dev.yaml`
- Modify: `compose.prod.yaml`
- Modify: `Dockerfile`
- Create: `docs/storage-ingestion-and-publication.md`
- Modify: `docs/runtime-environments.md`
- Modify: `docs/database-and-workers.md`
- Modify: `README.md`

- [ ] **Step 1: Write failing cleanup classification tests**

Test exact object records against database-reference snapshots. The classifier may return a candidate only when:

- a staging object is older than staging retention and is not referenced by an uploaded/processing revision or pending/running ingestion job;
- a derived object is older than orphan retention and is absent from every prose image, comic page, and cover-suggestion row;
- a title-cover object is older than orphan retention and is not the current cover of any title.

Assert every `.../revisions/.../original` key is categorically excluded even if a synthetic snapshot says unreferenced. Test dry-run counts bytes without calling delete, apply deletes only exact candidate keys, pagination remains bounded, and one storage/database error stops the batch.

Run `npm run test:unit -- src/lib/server/storage/cleanup.test.ts`; expected: FAIL.

- [ ] **Step 2: Implement bounded cleanup and real-database proof**

`cleanupStorage({ database, storage, config, mode, now })` iterates validated prefixes in pages of at most 500, loads reference sets in bounded database batches, applies the safety delay, and returns:

```ts
interface CleanupSummary {
  mode: 'dry-run' | 'apply';
  scanned: number;
  candidates: number;
  deleted: number;
  candidateBytes: number;
  deletedBytes: number;
}
```

It logs only the summary, never keys. Integration tests create referenced/unreferenced objects and prove database-referenced originals, active/candidate assets, current covers, and recent objects survive apply mode.

- [ ] **Step 3: Add an explicit dry-run/apply service command**

Create `storage-maintenance.ts` with a strict `loadStorageMaintenanceConfig(process.env)` that reads only `APP_ENV`, database connection settings, storage provider/root, and the two retention settings. Reuse the same bounds as the application schema and require an absolute production local root. Its tests prove auth, SMTP, origin, and job settings are neither required nor retained.

Create `src/cleanup-storage.ts` using that least-privilege loader. It accepts exactly zero args (dry-run) or `--apply`. Any other arg exits nonzero with usage. It probes dependencies first, prints one JSON summary, closes the database, and sets a nonzero exit code on failure without printing object keys.

Add scripts:

```json
"storage:cleanup:raw": "tsx src/cleanup-storage.ts",
"storage:cleanup": "node --env-file-if-exists=.env --import tsx src/cleanup-storage.ts"
```

Add `cleanup-storage` to `vite.services.config.ts` and test `npm run build:services` produces `build/services/cleanup-storage.js`.

- [ ] **Step 4: Wire repository-ignored development storage**

Add `/.data/` to `.gitignore` and `.dockerignore`. In `compose.dev.yaml`, mount:

```yaml
- ./.data/storage:/var/lib/pale-orbit/storage
```

into app and worker, and override `STORAGE_LOCAL_ROOT=/var/lib/pale-orbit/storage`. Add a tools-profile `storage-cleanup` service using `npm run storage:cleanup:raw`, the same bind mount, PostgreSQL health dependency, and `restart: "no"`. It defaults to dry-run; operators pass `-- --apply` explicitly.

- [ ] **Step 5: Wire the production named volume and retain sharp binaries**

In `compose.prod.yaml`, add all validated storage/ingestion/concurrency settings to app, worker, migrate, bootstrap, and cleanup service environments. Mount:

```yaml
book_storage:/var/lib/pale-orbit/storage
```

read/write only in app, worker, and cleanup. Do not mount it in Caddy. Add `book_storage:` to top-level volumes and a tools-profile cleanup service running `node build/services/cleanup-storage.js` with database secret plus storage volume.

Change the Docker build prune to:

```dockerfile
RUN npm prune --omit=dev
```

Do not omit optional packages. Add a build-stage smoke command that imports sharp and creates a one-pixel WebP so a missing native binary fails the image build.

- [ ] **Step 6: Validate both Compose topologies**

Development:

```powershell
docker compose --env-file .env.example --file compose.dev.yaml config --quiet
docker compose --env-file .env.example --file compose.dev.yaml --profile tools config --quiet
```

Production, with disposable process values:

```powershell
$values = @{
  APP_IMAGE = 'pale-orbit:plan4'; ORIGIN = 'https://books.example.com'; SITE_ADDRESS = 'books.example.com';
  DATABASE_NAME = 'pale_orbit'; DATABASE_USER = 'pale_orbit'; DATABASE_PASSWORD = 'validation-db-password';
  AUTH_SECRET = 'validation-auth-secret-at-least-thirty-two-bytes'; SMTP_HOST = 'smtp.example.com';
  SMTP_PORT = '587'; SMTP_USER = 'mailer'; SMTP_PASSWORD = 'validation-smtp-password';
  SMTP_FROM = 'Pale Orbit <books@example.com>'; SMTP_SECURE = 'false'; SMTP_REQUIRE_TLS = 'true';
  BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com'; BOOTSTRAP_ADMIN_NAME = 'Administrator';
  BOOTSTRAP_ADMIN_PASSWORD = 'validation-admin-password'
}
$values.GetEnumerator() | ForEach-Object { Set-Item "Env:$($_.Key)" $_.Value }
try {
  docker compose --file compose.prod.yaml config --quiet
  docker compose --file compose.prod.yaml --profile tools config --quiet
} finally {
  $values.Keys | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
}
```

Expected: both validate, production has no `env_file`, Caddy has no book volume, and production remains maintenance-only.

- [ ] **Step 7: Write the storage/publication operations runbook**

Create `docs/storage-ingestion-and-publication.md` documenting:

- local key ownership and S3 startup failure;
- host and Compose upload/worker/cleanup commands;
- dry-run review before every cleanup apply;
- safe ingestion codes, automatic versus manual retry, and when a new immutable upload is required;
- disk-capacity monitoring and a threshold that stops new uploads before exhaustion;
- candidate review, settings publication, activation, public replacement, rollback, and withdrawal behavior;
- a coordinated backup sequence using supported PostgreSQL logical backup plus storage-volume backup, application version, and migration journal;
- SHA-256 sampling and manifest/cover/pointer checks;
- restore into an isolated Compose project followed by migration/status/integrity checks before production replacement;
- why copying a live PostgreSQL data directory is not an accepted backup;
- future provider migration through the storage interface without adding an AWS SDK now.

Update existing runtime/worker docs and README with exact startup, maintenance, backup, and recovery links. Do not show production credentials or recommend a production `.env` file.

- [ ] **Step 8: Run operations tests and commit**

```powershell
npm run test:unit -- src/lib/server/storage
npm run test:integration -- tests/integration/storage-cleanup.test.ts tests/integration/storage-ingestion.test.ts
npm run build
git diff --check
git add src/lib/server/storage/cleanup.ts src/lib/server/storage/cleanup.test.ts src/lib/server/config/storage-maintenance.ts src/lib/server/config/storage-maintenance.test.ts tests/integration/storage-cleanup.test.ts src/cleanup-storage.ts package.json package-lock.json vite.services.config.ts .gitignore .dockerignore compose.dev.yaml compose.prod.yaml Dockerfile docs README.md
git commit -m "ops: add publication storage maintenance"
```

Expected: cleanup safety, service bundle, Compose configs, documentation, and builds pass.

## Task 14: Cover complete publication journeys and run the release gate

**Files:**
- Create: `tests/e2e/catalog-publication.spec.ts`
- Modify: `tests/e2e/admin.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `docs/dependency-decisions.md` only for verified final dependency status

- [ ] **Step 1: Write the EPUB publication browser journey**

Set the Playwright test timeout to 120 seconds and add explicit `STORAGE_PROVIDER`, `STORAGE_LOCAL_ROOT`, upload/ingestion limits, retention values, and worker concurrency to `webServer.env`, using the inherited disposable test values before `.data/test-e2e-storage` fallbacks. Then use the generated fixture buffer with Playwright `setInputFiles`. As the bootstrapped admin:

1. Create a private prose title.
2. Upload the EPUB and observe uploaded/processing before ready-for-review.
3. Confirm the cover suggestion.
4. Review the full reader and retained original metadata.
5. Choose a semantic preview block and publish reader settings.
6. Activate while private and verify the public URL remains 404.
7. Publish to storefront and verify catalog/detail/preview appear.
8. Verify text after the preview boundary and original download are unavailable in a clean public context.
9. Edit metadata and confirm it appears publicly after explicit save.

Assertions use roles/labels/state, not CSS implementation details.

- [ ] **Step 2: Write replacement, rollback, and withdrawal journeys**

Upload a corrected EPUB candidate to the public title and prove the current preview remains unchanged during processing/review/draft edits. Publish candidate settings, invoke **Publish replacement**, and prove the new preview appears atomically. Roll back to the prior revision and prove it returns. Withdraw and prove catalog/detail/preview disappear while the admin can still review/download the active revision.

- [ ] **Step 3: Write the comic panel and audit journeys**

Create/upload a CBZ, set a page preview, and publish whole-page settings with guided mode off. Verify real page images render. Draw/reorder one normalized region per page, save draft, verify public guided mode is still absent, publish reader settings, then verify guided mode uses the saved order.

Open Audit, filter by the comic title resource ID, open the settings-publication event, and verify a new `audit.event.view` summary appears without sensitive fields.

- [ ] **Step 4: Run focused browser and database suites**

```powershell
npm run test:integration -- tests/integration/storage-ingestion.test.ts tests/integration/publication.test.ts tests/integration/audit-query.test.ts tests/integration/storage-cleanup.test.ts
npm run test:e2e -- tests/e2e/catalog-publication.spec.ts tests/e2e/admin.spec.ts tests/e2e/auth.spec.ts tests/e2e/health.spec.ts
```

Expected: real PostgreSQL, worker, local storage, Mailpit, and Chromium complete all ingestion/publication/auth/admin journeys; the harness removes only its disposable Compose project and temporary storage root.

- [ ] **Step 5: Run the complete clean application gate**

```powershell
npm ci
npm run auth:schema
git diff --exit-code -- src/lib/server/db/schema/auth.ts
npm run db:check
npm run verify
npm ls --depth=0
npm audit --audit-level=high
npm outdated --json
```

Expected:

- auth schema regeneration is unchanged and Drizzle schema/migrations agree;
- all unit, integration, browser, web-build, and service-build gates pass;
- exact ingestion packages have no peer/engine conflict;
- no unaccepted high/critical advisory remains;
- every outdated result is updated within scope or explicitly documented with its compatibility/removal condition.

- [ ] **Step 6: Build and inspect the production image**

```powershell
docker build --tag pale-orbit:plan4 --target runtime .
docker run --rm pale-orbit:plan4 node -e "import('sharp').then(async ({default:s})=>{await s({create:{width:1,height:1,channels:4,background:'#fff'}}).webp().toBuffer()})"
docker run --rm pale-orbit:plan4 test -f build/services/cleanup-storage.js
```

Expected: sharp loads in the slim runtime, creates WebP output, and the worker/migrate/bootstrap/cleanup bundles exist.

- [ ] **Step 7: Run security and scope hygiene scans**

```powershell
rg -n "@aws-sdk|redis|bullmq|ioredis|pdfjs|mammoth|docx|automatic panel|auto-detect" package.json src
rg -n "storageKey|StorageKey|localRoot|STORAGE_LOCAL_ROOT" src/lib/types src/lib/components src/routes --glob "*.svelte" --glob "+page.ts"
rg -n "request\.formData\(\)" src/routes/admin/catalog
rg -n "password|token|secret|cookie|rawHtml|sourcePath" src/lib/server/audit src/lib/server/catalog src/lib/server/ingestion
git diff --check
git status --short
```

Expected:

- no Redis/AWS/PDF/DOCX/automatic-panel runtime implementation;
- storage-key/root matches occur only in server-internal modules, never client DTOs or serialized route data;
- large file endpoints use the streaming parser; any `formData()` match is limited to small scalar actions and identified in review;
- sensitive-term matches are expected validation/redaction/internal fields, never logs or audit payloads;
- no `.env`, `.data`, uploaded book, generated report, worker-ready file, or test artifact is tracked.

- [ ] **Step 8: Commit browser coverage and final dependency notes**

```powershell
git add tests/e2e/catalog-publication.spec.ts tests/e2e/admin.spec.ts playwright.config.ts docs/dependency-decisions.md
git commit -m "test: cover publication lifecycle journeys"
git status --short --branch
```

Expected: final worktree is clean and the branch contains only reviewed Plan 4 commits plus its design/plan documents.

## Plan 4 completion contract

Plan 4 is complete only when all of the following are true:

- [ ] Current stable Node 26-compatible ingestion packages are exact, documented, reproducible, and free of unexplained high/critical advisories.
- [ ] Local storage uses opaque generated keys, atomic streaming writes/copies, safe range reads, bounded listings, traversal/symlink protection, and an explicit unsupported S3 startup path.
- [ ] Web uploads parse one bounded multipart file without `request.formData()` or whole-book buffering and atomically create a candidate/job/audit event after storage succeeds.
- [ ] EPUB and CBZ/ZIP processing is lazy, abortable, size/count/ratio/path/encryption/compression/CRC/XML/image bounded, and proven against hostile generated fixtures.
- [ ] Reflowable EPUB becomes ordered semantic blocks with safe inline formatting and derived images; publisher layout/CSS/script/DRM/fixed-layout/SVG/remote resources are not executed or exposed.
- [ ] Comics become naturally ordered normalized whole-page images; guided view depends only on complete manually authored normalized panel data.
- [ ] Accepted originals are immutable and byte-identical; deterministic derived assets and manifest replacement make retries idempotent.
- [ ] Candidate failure/retry can never alter a live title; stale generations are harmless and permanent errors are safe/audited.
- [ ] Title-level covers change only through explicit confirmed actions and never through revision activation/rollback.
- [ ] Draft preview/panel changes remain private; published presentation promotion/clone is atomic and public authorization uses the semantic boundary.
- [ ] Private activation, first publication, public replacement, rollback, and withdrawal are serialized, freshly authorized, atomic, and audited without an availability gap.
- [ ] Public catalog/detail/reader routes use only public active published database state; public users cannot access private/candidate/after-preview/full/original storage.
- [ ] Administrators can create/edit titles, upload/review/retry revisions, preview full content, manage panels/settings/covers, publish/replace/rollback/withdraw, and download retained originals through protected routes.
- [ ] The local Studio publishing model is gone and `/studio` redirects to the real admin catalog.
- [ ] The audit dashboard provides safe keyset pagination, filters, and audited detail views; sales/fee/payout data remains absent until commerce exists.
- [ ] Cleanup dry-run/apply deletes only proven old staging/orphan derived/cover objects, stops safely on failure, reports aggregate counts/bytes, and categorically excludes retained-original keys.
- [ ] Development uses ignored local storage plus `.env`; production uses process/Compose-secret configuration and a named private volume absent from Caddy.
- [ ] Backup/restore, checksum verification, disk thresholds, retries, cleanup, publication transitions, and Hetzner operations are documented and restore-tested in an isolated environment.
- [ ] Unit, real-PostgreSQL/storage/worker integration, Playwright, schema/migration, Compose, runtime-image, dependency, security, and hygiene gates pass.
- [ ] Production remains intentionally in maintenance mode and customer full access/commerce/sales reporting remain outside Plan 4.

## Authoritative references

- [EPUB 3.3](https://www.w3.org/TR/epub-33/)
- [yauzl README and random-access API](https://github.com/thejoshwolfe/yauzl)
- [sharp documentation](https://sharp.pixelplumbing.com/)
- [file-type documentation](https://github.com/sindresorhus/file-type)
- [fast-xml-parser documentation](https://github.com/NaturalIntelligence/fast-xml-parser)
- [@fastify/busboy repository](https://github.com/fastify/busboy)
- [SvelteKit routing and server endpoints](https://svelte.dev/docs/kit/advanced-routing)
- [PostgreSQL advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS)
- [Docker Compose volumes](https://docs.docker.com/reference/compose-file/volumes/)
- [Docker Compose secrets](https://docs.docker.com/reference/compose-file/secrets/)
