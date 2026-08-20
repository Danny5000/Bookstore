# Current Deployment Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide one executable current-format command that captures and seals a database-plus-three-volume checkpoint and rehearses its restoration with exhaustive database-reference-to-storage proof.

**Architecture:** A pure storage-reference module strictly parses a complete read-only PostgreSQL JSON inventory and proves every referenced key, byte count, and SHA-256 against the existing authenticated split manifests. An import-safe checkpoint orchestrator composes the existing split-storage and bundle-v2 APIs with database evidence capture and an isolated restore rehearsal; the CLI is a thin main guard. Capture is the mandatory first-split gate and never restarts services. Rehearsal verifies the bundle before its first Docker call, uses a generated project and synthetic environment on a distinct engine, starts no worker or Caddy, and always tears down exact owned resources.

**Tech Stack:** TypeScript 6, Node.js 26, Vitest, PostgreSQL 18 `psql`/`pg_dump`/`pg_restore`, Docker Compose, existing split-storage backup helper, existing deployment bundle v2.

---

### Task 1: Exhaustive database storage-reference contract

**Files:**
- Create: `scripts/capture-storage-references.sql`
- Create: `scripts/storage-reference-integrity.ts`
- Create: `scripts/storage-reference-integrity.test.ts`

- [ ] **Step 1: Write failing parser and comparator tests**

  Test the wished-for `parseStorageReferenceInventory()` and `assertStorageReferencesInManifests()` APIs with all six reference kinds (`staging_upload`, `title_cover`, `revision_original`, `prose_image`, `comic_page`, and `revision_cover_suggestion`). Require exact object keys and types; canonical class/key/kind ordering; safe integers; lowercase SHA-256; canonical key routing; exact bytes and digest in the matching manifest. Prove missing, duplicate, conflicting, null, unknown, malformed, and misrouted rows fail while unreferenced manifest orphans and the publication sentinel remain allowed.

- [ ] **Step 2: Run the test and verify RED**

  Run: `npx vitest run scripts/storage-reference-integrity.test.ts`

  Expected: FAIL because `storage-reference-integrity.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure parser/comparator**

  Export `StorageReference`, `StorageReferenceIntegrityError`, `parseStorageReferenceInventory(text)`, and `assertStorageReferencesInManifests(references, manifests)`. Reuse `classifyLegacyStoragePath()` for routing. Treat manifest entries as the authoritative full object inventory, allow extra entries, and require every database reference to have one exact class/key/bytes/SHA match.

- [ ] **Step 4: Add the complete read-only SQL inventory**

  Use one read-only transaction with `search_path = pg_catalog, public, drizzle`. Union every non-null storage reference with its byte count and checksum, order with `COLLATE "C"`, aggregate to one JSON array, and include no `LIMIT`. The six sources are `title_revisions.staging_*`, `titles.cover_*`, `title_revisions.original_*`, `prose_images`, `comic_pages`, and `revision_cover_suggestions`.

- [ ] **Step 5: Run focused tests and verify GREEN**

  Run: `npx vitest run scripts/storage-reference-integrity.test.ts`

  Expected: all tests pass with no warnings.

### Task 2: Capture an end-to-end current checkpoint

**Files:**
- Create: `scripts/deployment-checkpoint.ts`
- Create: `scripts/deployment-checkpoint.test.ts`
- Modify: `src/storage-volume-backup-helper.ts`

- [ ] **Step 1: Write failing capture-order and safety tests**

  Specify strict `capture --project --root --backup-id --context --engine-id` parsing and an injected command runtime. Assert the root is an absolute empty real directory; context and engine are exact; app, worker, and cleanup are stopped; exact split volumes have no running or stopped consumers; application/helper/PostgreSQL images are digest-pinned and locally bound; and the PostgreSQL container has exact project/service labels and image identity.

- [ ] **Step 2: Verify RED**

  Run: `npx vitest run scripts/deployment-checkpoint.test.ts`

  Expected: FAIL because the checkpoint API is absent.

- [ ] **Step 3: Implement database artifact capture**

  Create a collision-safe dump path in the exact PostgreSQL container, run custom-format `pg_dump`, copy it to the reserved `database.dump`, and remove the container copy in `finally`. Capture canonical `migration-journal.csv`, `restore-row-counts.csv`, existing deterministic `storage-samples.csv`, and strict financial diagnostics. Copy `verify-financial-restore.sql`, execute those exact copied bytes, and write exact-schema `application-image.json` and `source-docker-engine.json`. Never log command output, environment values, or credentials.

- [ ] **Step 4: Compose split capture, exhaustive proof, and bundle seal**

  Call `executeSplitStorageBackup(..., mode: 'capture')`, load the three just-created manifests through an exported strict manifest reader, execute `capture-storage-references.sql`, and prove every reference against the manifests. Only then call `sealDeploymentBackupBundle()` followed by `verifyDeploymentBackupBundle()`. Recheck engine and stopped-writer fences before sealing. A failure leaves no `backup-bundle.json`, never restarts a service, and removes only an owned temporary container dump.

- [ ] **Step 5: Verify capture GREEN**

  Run: `npx vitest run scripts/deployment-checkpoint.test.ts scripts/storage-reference-integrity.test.ts scripts/split-storage-backup.test.ts scripts/deployment-backup-bundle.test.ts`

  Expected: all focused tests pass.

### Task 3: Rehearse the complete restore on an isolated engine

**Files:**
- Modify: `scripts/deployment-checkpoint.ts`
- Modify: `scripts/deployment-checkpoint.test.ts`

- [ ] **Step 1: Write failing rehearsal-order tests**

  Specify strict `rehearse --root --backup-id --context --engine-id` parsing. Require bundle verification to finish before the first Docker call; reject the source engine; validate authenticated pinned image records; generate an absent project; build an allowlisted environment containing random synthetic secrets and `COMPOSE_DEFAULT_NETWORK_INTERNAL=true`; strip Stripe, production credential, `_FILE`, and libpq override variables.

- [ ] **Step 2: Verify RED**

  Run: `npx vitest run scripts/deployment-checkpoint.test.ts -t rehearse`

  Expected: FAIL because rehearsal is not implemented.

- [ ] **Step 3: Implement restore and exact evidence comparison**

  Start only PostgreSQL, pre-migrate to create dump ACL roles, copy and restore `database.dump` without `--no-acl`, restore all three split volumes, post-migrate, provision four synthetic login roles, and compare migration journal, complete row counts, deterministic storage samples, exact authenticated financial diagnostics, and exhaustive restored database references against the authenticated manifests. Run cleanup dry-run, then start only the maintenance app and require `/health/live` and `/health/ready`; never start worker or Caddy.

- [ ] **Step 4: Implement exact finally teardown**

  Revalidate the approved engine before every mutation, remove the owned container dump, run `compose down --volumes` only for the generated project, and prove all project-labeled plus exact-name containers/networks/volumes are absent. Aggregate teardown errors with the primary failure. Preserve and never mutate the verified source bundle.

- [ ] **Step 5: Verify rehearsal GREEN**

  Run: `npx vitest run scripts/deployment-checkpoint.test.ts`

  Expected: all capture, rehearsal, error-path, and teardown tests pass.

### Task 4: Publish the executable current workflow and deployment gate

**Files:**
- Modify: `package.json`
- Modify: `docs/storage-ingestion-and-publication.md`
- Modify: `docs/database-and-workers.md`
- Modify: `docs/runtime-environments.md`
- Modify: `scripts/storage-process-isolation.test.ts`

- [ ] **Step 1: Write failing static publication tests**

  Require a `deployment:checkpoint` package command, documented capture/rehearse invocations, capture before first app startup after split migration, explicit exhaustive DB-reference proof, bundle verification before restore mutation, worker/Caddy exclusion, and exact teardown. Extract only the current section and reject `book_storage`, `storage.tar.gz`, or directions to reuse the legacy coordinated procedure.

- [ ] **Step 2: Verify RED**

  Run: `npx vitest run scripts/storage-process-isolation.test.ts`

  Expected: FAIL because the executable current command is not published.

- [ ] **Step 3: Add package command and replace current runbook hand-wave**

  Publish `deployment:checkpoint` as `node --env-file-if-exists=.env --import tsx scripts/deployment-checkpoint.ts`. Document the two exact CLI shapes and make the first successful current capture/seal/verify the gate between split migration/cleanup dry-run and app startup. Keep the legacy section explicitly rollback-only and do not copy any of its single-volume commands into the current section.

- [ ] **Step 4: Verify static GREEN**

  Run: `npx vitest run scripts/storage-process-isolation.test.ts scripts/deployment-checkpoint.test.ts scripts/storage-reference-integrity.test.ts`

  Expected: all tests pass.

### Task 5: Service-free and service-backed acceptance

**Files:**
- Modify only if a failure requires a TDD-backed correction to files above.

- [ ] **Step 1: Run service-free gates**

  Run: `npm run check`

  Run: `npx eslint scripts/deployment-checkpoint.ts scripts/deployment-checkpoint.test.ts scripts/storage-reference-integrity.ts scripts/storage-reference-integrity.test.ts`

  Run: `npm run db:check`

  Run: `npm run build`

  Expected: every command exits 0.

- [ ] **Step 2: Run PostgreSQL-backed reference acceptance when authorized**

  Run: `npx tsx scripts/with-test-database.ts npx vitest run --config vitest.integration.config.ts tests/integration/storage-recovery-integrity.test.ts`

  Expected: all six database reference families are emitted and a missing or corrupted object is rejected.

- [ ] **Step 3: Run the definitive two-engine checkpoint rehearsal when authorized**

  With an already-quiesced current source project and an empty restricted bundle directory, run:

  `npm run deployment:checkpoint -- capture --project <exact-source-project> --root <absolute-restricted-root> --backup-id <32-lowercase-hex> --context <approved-source-context> --engine-id <expected-source-engine-id>`

  Then, on a separately approved Docker engine whose ID differs from the source record, run:

  `npm run deployment:checkpoint -- rehearse --root <absolute-restricted-root> --backup-id <same-32-lowercase-hex> --context <approved-restore-context> --engine-id <expected-restore-engine-id>`

  Expected: capture reports a verified 14-artifact bundle; rehearsal reports matching journal, counts, financial diagnostics, storage references, and healthy maintenance app; the worker and Caddy never start; the generated restore project has zero containers, networks, and volumes after finally teardown.
