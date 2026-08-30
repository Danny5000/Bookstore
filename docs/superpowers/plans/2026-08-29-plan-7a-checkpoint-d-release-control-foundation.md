# Plan 7A Checkpoint D: Release-Control Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Plan 7A Checkpoint D and Plan 7A by extracting one exact owned-Compose lifecycle, adapting both Plan 6B smoke consumers, adding deterministic source/configuration/image/stage evidence and a distinct-engine release-candidate coordinator, and reserving a still-unusable production-live activation contract while production remains maintenance-only and Stripe-disabled.

**Architecture:** Dependency-light release-control modules freeze a committed or workspace source snapshot, encode a deterministic Docker context, bind the resulting local content-addressed `imageId` and canonical Compose configuration, and drive a fixed stage machine over a shared owned-resource lifecycle. Existing production and fixture smokes become separate `maintenance_fixture` consumers; the new `plan7a-release-candidate` consumer alone inserts coordinated checkpoint capture and a distinct-engine rehearsal. Evidence is strict, privacy-minimized, expiring, expectation-matched, and published without clobber only after exact cleanup; it is candidate evidence and cannot authorize production.

**Tech Stack:** Node.js 26.7.x built-ins, npm 11.19.x, TypeScript 6.0.x, SvelteKit 2.70.x, Vitest 4.1.x, Docker Engine/Compose, PostgreSQL 18.4, Git plumbing commands, and the existing Plan 7A structured logger. No package dependency, migration, route, UI, monitor, alert transport, provider call, registry push, deployment, or production activation is added.

---

## Source of truth, approved base, and checkpoint boundary

The authoritative design is `docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md`, especially Sections 5.1, 7.4, 10, 12-17. The approved Plan 7A design commit is `1c330693b67a1aa34c413bd8d2ec23ff8628236e`. The required implementation base is `6406c02cf463f1f0a389488e587ac688078d2cf8`, where Checkpoints A-C are complete, migration `0015_plan7a_operations_authority` and verifier `plan7a-database-catalog-v1` are current, Checkpoint D is unstarted, and production remains maintenance-only with Stripe disabled.

Before implementation, create or reuse an isolated worktree whose history contains both fixed commits. Task 0 approval-gates and commits exactly this reviewed Checkpoint D plan plus the approved build-context clarification in the authoritative design before implementation begins; the implementation handoff records that planning commit and both reviewed file hashes. If `main` advances, prove both fixed commits remain ancestors, review every intervening change for overlap, and do not silently reinterpret this checkpoint from a newer document.

Checkpoint D owns exactly:

1. canonical JSON, source-snapshot, Dockerignore, build-context, image-label, Compose-configuration, stage, evidence, command-supervision, and owned-Compose foundations;
2. separate `maintenance_fixture` adoption by `plan6b-production-smoke` and `plan6b-fixture-runtime-probe`, preserving all existing behavioral assertions;
3. one `release_candidate` coordinator with exact checkpoint capture, distinct-engine restore rehearsal, production-image maintenance smoke, and safe machine evidence;
4. a narrow local-candidate extension to the current checkpoint API plus authenticated image save/load between two explicitly identified Docker engines;
5. typed reservation and unconditional rejection of `APPLICATION_MODE=live`, plus the future activation prerequisite shape with no evaluator or authorized state;
6. exact failure, timeout, interruption, ownership, cleanup, expiry, expectation-matching, privacy, and production-closure witnesses; and
7. current operator documentation and the final Plan 7A status only after exact-SHA release evidence and independent review.

Checkpoint D does **not** add monitoring, metrics, dashboards, SLOs, alert rules or delivery, scheduled/off-host/encrypted backup transport, a periodic restore scheduler, registry push/login, image signing, GitHub Actions, SSH/VPS deployment, production hardening, capacity tuning, a usable `live` mode, an activation overlay, a public route, an operations UI, a provider call, Stripe enablement, or a production launch. It does not edit migrations, database schema/roles/routines, routes, commerce/entitlement semantics, `compose.prod.yaml`, `compose.stripe.yaml`, `Dockerfile`, `.dockerignore`, or `package-lock.json`.

## Resolved implementation decisions

These decisions close the approved design's implementation gaps without expanding its scope.

1. **One checkpoint, five milestones:** contracts and frozen inputs, owned lifecycle, maintenance consumers, recovery coordinator, and activation/evidence completion land as ordered reviewable commits. Plan 7A is not marked complete until all five are green on one immutable SHA.
2. **File organization:** new reusable code lives under `scripts/release-control/`. It may import Node built-ins and `src/lib/server/observability`; it may not import a smoke consumer, route, worker entrypoint, financial orchestrator, provider gateway, or browser harness. Consumer scripts depend inward on release control, never the reverse.
3. **Exact profiles and stages:** `maintenance_fixture` always owns exactly `preflight`, `build`, `compose-config`, `migrate`, `provision`, `runtime-start`, `runtime-health`, `inspect`, `behavior`, `shutdown`, `cleanup`. `release_candidate` inserts exactly `checkpoint-capture` and `restore-rehearsal` after `provision`. Callers cannot supply, omit, reorder, or rename stages.
4. **Separate fixture run:** `smoke:plan6b-fixture` stops nesting a full production smoke. It independently freezes/builds the same production target and executes its own exact maintenance stage sequence against `compose.test.yaml`. The final gate still runs `smoke:plan6b` first, so both supported consumers remain independent evidence witnesses without a dishonest synthetic `build` stage or two records from one CLI.
5. **Candidate and run ownership:** every CLI receives one explicit canonical lowercase UUID `--candidate-id` and one absolute, non-existing `--evidence-root`; the runner atomically creates that root with the shared platform-private path policy. It generates one 16-lowercase-hex run ID and one 32-lowercase-hex ownership token. A candidate ID or evidence root is never reused.
6. **Durable versus temporary roots:** the evidence root is the only durable output. IID, Compose, secret, image-transfer, checkpoint-bundle, and rehearsal roots are separate platform-private, run-owned roots and must be absent before success evidence is published. The Compose root materializes the frozen base file and, for production topology, frozen `deploy/Caddyfile` at the same relative path; every Compose command uses that root as its explicit project directory and never resolves a worktree-relative bind. The run-local checkpoint bundle is candidate rehearsal material, not a scheduled/off-host backup; evidence retains only its authenticated identity, never its path.
7. **Source modes:** `workspace_fixture` reads the exact worktree, may be dirty, records the starting `HEAD` and actual cleanliness, and includes tracked modifications plus untracked nonignored regular files. `committed_revision` requires an entirely clean worktree, reads blobs and modes from exact `HEAD`, and never reads a worktree build input after the preflight fence. Both reject submodules, symlinks, special files, path escapes, unsupported Git modes, missing controls, and state change while freezing.
8. **Windows and file modes:** tracked entries use Git modes `100644` or `100755`; every untracked regular file is normalized to logical `100644` on every host, and only Git may supply `100755`. The approved design's “restricted empty build root” is implemented as a private, initially empty logical frozen context whose only contents are the selected entries encoded into one in-memory/streamed tar; no host build directory is materialized. Docker never consumes host-directory modes: a deterministic POSIX ustar stream maps logical `100644`/`100755` to header `0644`/`0755`, uses sorted paths, directory mode `0755`, uid/gid/mtime zero, empty owner names, fixed checksum/padding, and two terminal zero blocks. `docker build --file Dockerfile -` consumes that stream. Host-sensitive roots use one separate `restricted-path` primitive: POSIX atomically creates owner-only directories/files and verifies `0700`/`0600`, while Windows atomically creates a protected DACL granting inheritable FullControl only to the current user SID and `SYSTEM`, rejects inherited/unknown/deny ACEs and reparse points, and verifies every file remains beneath that root. A Docker-truncated IID/archive path is atomically pre-created private and adopted only after the producing process closes with the same stable identity; a trusted helper-created path is instead registered while absent, then opened without following links, made and verified private, identity-checked, synchronized, and only then read. Exact-entry enumeration and hashing are lease operations, not raw-path fallbacks. All canonical paths use `/`, Unicode is preserved, comparison is raw UTF-8 byte order, and duplicate or case-colliding materialized/tar paths fail closed.
9. **Dockerignore:** an in-repository matcher implements ordered Docker semantics for comments, root normalization, directory descendants, `*`, `?`, `**`, character classes, and `!` re-inclusion. It is exhaustively tested against the committed `.dockerignore`; unsupported escaping or malformed patterns fail closed. `Dockerfile` and `.dockerignore` are encoded exactly once as build controls even though `Dockerfile*` is ignored for `COPY`, and their digests are bound separately from the COPY-visible entry inventory.
10. **Snapshot fence:** record `HEAD`, porcelain-v2 status bytes, tracked/untracked inventory, selected control bytes, modes, sizes, and content hashes before encoding; repeat the complete observation after the tar and frozen registry are built. Any difference rejects the run before Docker. Release mode additionally requires both observations to be clean and the same 40-lowercase-hex commit.
11. **Canonical build-context digest:** SHA-256 covers canonical UTF-8 JSON with keys `version`, `sourceMode`, `sourceClean`, `dockerignoreSha256`, `dockerfileSha256`, and `entries`; entry keys are `path`, `mode`, and `sha256`. Object keys are recursively raw-byte sorted, arrays retain defined order, output has no insignificant whitespace and one final LF. Control files are not duplicated in `entries`.
12. **Local image identity:** Docker builds the frozen ustar context's `production` target with a reserved-then-adopted IID file beneath a platform-private lease and the four required labels. The runner accepts only `sha256:<64 lowercase hex>`, inspects that ID, and requires the exact label values. There is no Plan 7A field or variable named `imageDigest`. Compose receives the raw `imageId` with `pull_policy: never`; a tag or external image cannot satisfy release evidence.
13. **Image lifetime:** no mutable candidate tag is created or imported. Before build, the outer Task 6 owner observes the complete `image ls --all --no-trunc --quiet` baseline and seals it with the exact engine/four labels in one immutable manifest. Only Task 6's exact runtime-branded identity/preparation/journal/IID registration can authorize Task 6A build; only the registered restore journal can authorize Task 12 load. After build/load the journal binds the exact IID in memory, while its persisted baseline/labels still permit exact interrupted-mutation discovery without guessing. Candidate inspection requires `RepoTags` exactly empty before save and after load, so transport cannot introduce an unowned reference mutation. Candidate finalization is two-phase: maintenance prepares by removing an introduced image, whereas release prepares by revalidating it while failure removal remains armed. Any stage, cleanup, or pre-commit publication failure removes an introduced image and reattests absence; at the evidence commit point, one synchronous no-throw in-memory commit disarms removal and leaves the release image addressable by local `imageId`. A pre-existing or label-mismatched image is never deleted. Images are not counted as Compose cleanup resources.
14. **Canonical origin:** release input must equal `new URL(input).origin` byte-for-byte, use `https:`, contain no username, password, query, fragment, trailing-dot host, or path beyond the URL parser's implicit `/`, and survive URL parsing without host canonicalization drift. Canonical nondefault ports, IP literals, single-label hosts, punycode, and special-use names are not rejected merely for lacking public reachability; Checkpoint D produces candidate evidence and does not prove DNS/TLS deployment. A spelled default port, Unicode-to-punycode rewrite, case fold, alternate IP spelling, or other parser normalization fails the byte equality. Production maintenance retains `https://plan6b-smoke.invalid`; fixture maintenance retains its dynamically allocated `http://127.0.0.1:<port>` origin, but their maintenance profile still cannot satisfy release evidence.
15. **Compose configuration fingerprint:** Compose-file order is the frozen base file followed by the generated owned override; the production runtime-input list additionally binds frozen `deploy/Caddyfile`. Override bytes are deterministic templates containing only Task 6-derived public run/candidate/project label literals, an exact allowlist of fixed variable placeholders, reviewed fixed nonsecret literals, and fixed container paths; no candidate image ID, origin, PostgreSQL reference, private owner token, credential, or host path is interpolated into the raw override. The exact role-scoped Compose environment supplies every placeholder. It is created only after the registered role image and every generated credential/port/path exist, is authenticated once by the configuration binder, and is then reused unchanged by the attested lifecycle. Every raw candidate-ID application/tool service receives `pull_policy: never`: exactly six for production maintenance, six for fixture maintenance (including `stripe_api_canary`), and—with reviewed PostgreSQL/Caddy replacements—all eight for release production. Maintenance preserves base references/pull behavior only for its noncandidate PostgreSQL/Caddy or PostgreSQL/Mailpit services. The runner parses `docker compose --project-directory <frozen-compose-root> config --format json`, requires the exact profile-specific service/image/pull-policy/network/volume/secret topology and scope plus all ownership labels, and canonicalizes only an in-memory redacted model. Each approved secret-bearing value/path and the private owner token becomes a fixed presence token, while the nonsecret run/candidate/project identities, image ID, canonical origin, and release PostgreSQL RepoDigest remain bound. The fingerprint hashes version `1`, the exact ordered safe Compose-file hashes, the ordered external runtime-input hashes, and canonical redacted configuration, and is invariant when only secret values, owner tokens, or owned host secret-root paths change. Raw values, their direct/indirect hashes, environment dumps, host paths, and resolved configuration are never stored or logged.
16. **Exact evidence record:** success schema version `1` has only `version`, `producer`, `profile`, `runId`, `candidateId`, `issuedAt`, `expiresAt`, `requiredStages`, `imageId`, `sourceMode`, `sourceClean`, `sourceRevision`, `buildContextSha256`, `imageLabels`, `composeProject`, `configurationFingerprint`, `origin`, `migrationTip`, `databaseRoleAttestation`, optional profile-discriminated `checkpoint`, `stageOutcomes`, `startedAt`, `completedAt`, and `cleanup`. Maintenance records have no `checkpoint` key; release records require it.
17. **Evidence timing:** `issuedAt` equals `startedAt`, all timestamps are canonical UTC millisecond text, each stage has exact start/completion/duration, and `expiresAt` is exactly `completedAt + 86_400_000ms`. The clock may not regress; total or stage duration above 86,400,000ms fails.
18. **Migration and role evidence:** `migrationTip` binds index `15`, tag `0015_plan7a_operations_authority`, journal timestamp `1787812813508`, and the lowercase SHA-256 that matches both the frozen migration bytes and live migration journal. `databaseRoleAttestation` is exactly `{ result: "verified", principalCount: 4, pairwiseDistinct: true, catalogContract: "plan7a-database-catalog-v1", verifierSha256 }`; it is emitted only after provision plus the frozen canonical verifier and exact login-membership checks succeed.
19. **Release-only checkpoint evidence:** `checkpoint` contains only `backupId`, canonical `backupManifestSha256`, `captureDockerEngineId`, `restoreDockerEngineId`, `sourceCatalogResult`, `restoreCatalogResult`, `replacementDisposition`, and `rehearsalCleanup`. Engine context names and paths remain operator inputs but are not evidence. The two attested engine IDs must match observations and differ. Standalone capture/rehearsal may faithfully report `blocked`, but a successful `release_candidate` requires the source and restored canonical five-row diagnostics to match and both derive `replacementDisposition: "clear"`; blocked state fails the stage and publishes no release success.
20. **Bundle fingerprint and image artifact:** the current version-2 backup-manifest schema and exact 14-artifact inventory do not change. The legacy `application-image.json` object remains accepted unchanged for standalone registry-digest capture. Coordinated capture adds one exact capability-gated `kind: "plan7a-local-image-id-v1"` object in that existing artifact, binding `APP_IMAGE_ID`, the four `APP_IMAGE_LABELS`, identical `BACKUP_HELPER_IMAGE_ID`, and digest-pinned `POSTGRES_IMAGE`; no fifteenth artifact or bundle-manifest version is added. `backupManifestSha256` hashes canonical semantic JSON of the strictly parsed manifest, so formatting does not matter and a coherent same-ID artifact replacement changes the fingerprint.
21. **Frozen checkpoint inputs:** coordinator capture/rehearsal receives exactly eight frozen inputs: `compose.prod.yaml`, `deploy/Caddyfile`, row-count SQL, storage-inventory SQL, storage-sample SQL, the canonical financial verifier, `drizzle/meta/_journal.json`, and migration `0015_plan7a_operations_authority.sql`. It does not reread mutable current-working-directory files. Standalone `deployment:checkpoint` keeps its existing CLI grammar and behavior.
22. **Local candidate and shared-path engine envelope:** a release-only capability-gated checkpoint record accepts the exact local candidate `imageId` and labels while the existing registry-digest record remains supported. The candidate image is also the storage backup helper, as its reviewed production target contains `build/services/storage-volume-backup-helper.js` and defaults to `node`; the coordinated path requires `BACKUP_HELPER_IMAGE_ID === APP_IMAGE_ID` and adds no mutable helper tag/reference. Docker context identity alone never implies that a coordinator-local path exists on the daemon host. The immutable manifest/engine/baseline registration precedes every Docker mutation. The registered source build and restore archive load are the only mutations allowed before the candidate exists on their engine; immediately afterward, and before the first bind-using Compose/checkpoint/resource mutation on that engine, a no-network/cap-dropped/read-only candidate container must perform a nonce read/write/fsync round trip through every exact bind-mounted Compose/secret/bundle/rehearsal root that engine will use. The originating lease adopts/verifies/removes the output and reasserts the same root identity. Image inspection requires `Config.User === "node"` and obtains its actual nonzero UID/GID. On POSIX that pair must exactly equal the lease owner UID/GID and becomes the explicit `--user uid:gid`; on Windows the audited default user and protected current-SID/SYSTEM DACL are used. Before each storage capture/restore, that same user must pass a no-network exact access witness on all three named volumes; a bind-root probe alone is insufficient. A remote/distinct daemon or host/user/filesystem combination without these authenticated shared-path and volume semantics fails before artifact/resource mutation and is outside this checkpoint's execution envelope; two differing observed engine IDs are still mandatory. PostgreSQL remains an operator-supplied, locally present `name@sha256:<64 lowercase hex>` whose `RepoDigests` match on both engines. After source build reveals the raw ID, transfer preflight requires that ID absent from the sealed restore baseline; a pre-existing restore candidate fails before save and is never mutated. The coordinator saves the untagged source ID to a reserved-then-adopted restricted temporary archive, loads it on the attested distinct engine, revalidates the same ID/empty tag set/labels/helper invariants, removes the archive, and always removes/proves absence of the introduced restore image after rehearsal.
23. **Coordinator-known rehearsal ownership:** the source and rehearsal Compose projects, separate capture/rehearsal raw-helper identities, owner token, backup ID, transfer root, rehearsal root, raw helper container names, and expected resources are generated and registered before manifest sealing and before the first Docker/resource mutation they authorize. Evidence-root acquisition remains the run's first owned external-resource mutation; transfer/rehearsal root leases are acquired later through the authenticated preparation only after complete source freezing, Docker-context attestation, and port allocation. Raw helpers own no Compose project/network/volume: their Plan 7A project label identifies the helper role while their Docker Compose project label identifies the source/rehearsal volume project. The checkpoint API returns a typed attestation only after its helper containers, rehearsal Compose project, and temporary roots have exact zero-residual cleanup receipts. An interruption can therefore resume cleanup from the outer owner manifest.
24. **Stage boundaries:** `migrate` runs the migration service twice and proves stable journal/state. `provision` runs role provisioning first, then the existing storage-cleanup dry-run for the production topology, then source attestation; the exact fixture topology has no storage-cleanup service, so its `provision` runs its role provisioner and proceeds directly to source attestation. `runtime-health` checks app/worker/Caddy health; `inspect` proves topology, mounts, roles, secrets, and disabled/provider-free state; `behavior` owns existing maintenance or fixture assertions; `shutdown` gracefully stops the exact project; `cleanup` removes volumes/orphans, transfer artifacts, checkpoint/rehearsal roots, and verifies four exact zero residual counts.
25. **Failure model:** one failing required stage, timeout, SIGINT/SIGTERM, spawn error, ownership/config mismatch, cleanup failure, or residual resource produces nonzero exit and no success record. After cleanup has been attempted, a best-effort bounded failure record may be published once as `<candidateId>-<runId>-failure.json` using the same canonical no-clobber primitive; it contains exactly `version`, `producer`, `profile`, `runId`, `candidateId`, `stage`, `code`, `startedAt`, `completedAt`, and `cleanup`. A successful failure publication commits retention of exactly that one-file private evidence root; skipped/failed publication rolls the provisional root back through same-identity cleanup, and any forced cleanup residue remains structurally uncommitted. Failure-record publication failure never replaces the domain/cleanup result. Raw cause, stdout, stderr, command, path, environment, SQL, URL credentials, payload, and secret material are forbidden.
26. **Atomic publication:** hash canonical success bytes without an embedded fingerprint, write/sync/close and strictly parse/expectation-match a unique partial file, then create `<candidateId>-<fingerprint>.json` by no-clobber hard link only after owned cleanup. While the partial link exists, consumers treat the root as uncommitted and reject it. Remove the partial; if that fails, remove the same-inode provisional target and fail, while either leftover keeps the root unconsumable. Successful partial removal is the publication commit point; inside that same owner call, synchronous no-throw state flips commit evidence-root retention and the authenticated cleanup/candidate disposition. No fallible reread, async gap, or domain step occurs afterward. Emit `smoke.run.succeeded` with that fingerprint best-effort. There is no `latest`, reusable success path, overwrite, symlink traversal, or fallback record.
27. **Expectation-based acceptance and structural inspection:** the sole authoritative evidence acceptance occurs in-process before the publication link, while independently accumulated values still exist. It supplies exact profile, producer, run ID, candidate ID, image ID and four labels, source mode/cleanliness/revision/context hash, Compose project, configuration fingerprint, origin, migration tip, database-role attestation, required stages, and current time. Release acceptance additionally supplies the exact checkpoint object and requires `committed_revision`, `sourceClean=true`, release stages, distinct engine IDs, and nonexpiry. No expected value comes from parsed evidence. The later read-only CLI is explicitly a non-authorizing structural-integrity inspector with only operator-known partial expectations and a safe normalized summary; it cannot replace complete pre-link acceptance or authorize activation.
28. **Structured events:** the existing Checkpoint B event registry remains the sole logger contract and canonical owner of `SMOKE_PRODUCERS`, `SMOKE_STAGES`, `SmokeProfile`, and `SmokeStage`. Checkpoint D exports/narrows those existing values for type reuse, while release-control owns only the two ordered required-stage sequences. It does not add an event or code. All smoke producers emit the fixed stage, cleanup, and run schemas; logging failure cannot alter stage/domain outcome.
29. **Async command supervision:** each consumer creates exactly one Task 5 command supervisor from one low-level process adapter. That opaque run-scoped owner installs the sole SIGINT/SIGTERM listener pair, latches the first signal across command gaps and filesystem work, owns every new no-shell child—including Task 3 Git plumbing—plus timeouts, bounded stdout/stderr capture, caller abort, child termination, and close acknowledgement, and supplies a separate bounded cleanup-command path that process signals cannot cancel. The same supervisor is privately bound into the supervised Git adapter, restricted-path operations, and the lifecycle; no consumer injects a preassembled command runtime or restricted-path dependency. Its listeners remain installed through the success-publication commit and are disposed idempotently without replacing the terminal result. It maps internal detail to the existing seven safe smoke codes and never carries raw subprocess output into events/evidence.
30. **Reserved live mode:** raw configuration vocabulary includes `live`, but a dedicated refinement rejects it in every environment before producing application configuration. `isRequestAvailable` also fails closed for `live`. `src/lib/server/activation/contracts.ts` defines only the future prerequisite input type and an `activation_not_enabled` throwing guard; it contains no evaluator, overlay, decision record, or `authorized` property.
31. **Production closure:** base Compose stays byte-identical with `APPLICATION_MODE=maintenance`, `STRIPE_ENABLED=false`, and `STRIPE_LIVE_MODE=false`. Candidate evidence is not read by runtime configuration, Compose, a route, or deployment tooling.
32. **Checkout-neutral source witnesses:** the two pre-existing exact-source tests that fail only after Git's Windows CRLF checkout are normalized at their comparison boundary before Checkpoint D work. This is a test-only prerequisite; no migration or production source bytes change, and timeouts remain unchanged.

## Target dependency and lifecycle topology

~~~text
smoke CLI / release coordinator
  -> release-control/contracts + canonical-json
  -> release-control/build-context
       -> injected Git + filesystem readers
          (real defaults: Task 5 supervised Git + confined Node reader)
       -> release-control/dockerignore
  -> release-control/lifecycle
       -> existing structured logger
       -> release-control/owned-compose
            -> release-control/command-runtime + restricted-path
            -> release-control/compose-config
                 -> frozen Compose inputs + redacted parsed config
       -> release-control/candidate-image
            -> registered source journal + exact IID/labels + image lease
       -> release-control/database-attestation
            -> frozen migration/journal/verifier + injected live SQL/role checks
       -> release-control/evidence
       -> consumer-owned migrate/provision/health/inspect/behavior callbacks

plan6b-production-smoke  ---- maintenance_fixture callbacks
plan6b-fixture-runtime-probe ---- maintenance_fixture callbacks (separate build/run)
plan7a-release-candidate ---- release_candidate callbacks
       -> deployment-checkpoint-evidence
       -> deployment-checkpoint programmatic API
       -> candidate-image-transfer
            source imageId -> restricted archive -> distinct engine imageId

future activation contracts (types + rejection only)
  -X-> runtime activation, Compose overlay, route, deployment, evidence consumer
~~~

Forbidden reverse dependencies are `release-control -> Plan 6B consumer|route|worker entrypoint|financial orchestrator|provider`, `deployment-checkpoint -> release coordinator`, `observability -> release-control`, and `activation/contracts -> evidence reader|Compose|route|deployment`. No evidence/log/diagnostic record may contain raw configuration, an environment dump, stdout/stderr, commands, paths, secret values or hashes, credentials, personal data, provider bodies, job/outbox payloads, storage keys, deduplication keys, `imageDigest`, or an activation result.

## File ownership map

### Deterministic contracts and inputs

- `scripts/release-control/canonical-json.ts` owns recursively sorted plain-data serialization, LF termination, SHA-256 helpers, raw UTF-8 ordering, and prototype/accessor rejection.
- `src/lib/server/observability/contracts.ts` remains the canonical owner of exact smoke producers, profiles, stage vocabulary, event schemas, and safe codes.
- `scripts/release-control/contracts.ts` imports those canonical types/constants and owns only the two ordered required-stage sequences plus source/image/configuration/migration/role/checkpoint/outcome/cleanup/success/failure types, strict parsers, origin validation, and expectation matching.
- `scripts/release-control/dockerignore.ts` owns the reviewed Docker-compatible pattern parser/matcher and no filesystem access.
- `scripts/release-control/docker-context-tar.ts` owns the deterministic ustar encoder and exact logical-Git-mode to POSIX-header-mode mapping used on every platform.
- `scripts/release-control/build-context.ts` owns Git/workspace observation, the sole real confined read-only Node build-context filesystem adapter, clean-tree enforcement, frozen blob reads, mode/path validation, selected inventory, stability fences, context digest, and deterministic tar construction.
- `scripts/release-control/candidate-image.ts` owns registered-journal-gated production-target build invocation, IID parsing, exact label/tag/runtime inspection, a single typed image lease plus its owner-side resolver, and two-phase introduced-image cleanup/retention; Task 6 owns the pre-mutation inventory and run/journal association.
- `scripts/release-control/compose-config.ts` owns exact build-label construction, ordered Compose hashes, parsed profile/topology/image/pull-policy/secret-scope validation, presence-token redaction, configuration fingerprint, immutable application/PostgreSQL override requirements, and no raw-config retention.
- `scripts/release-control/database-attestation.ts` owns frozen migration-tip parsing/hashing, live journal equality, the four-principal login/membership checks, canonical verifier identity/result parsing, and the safe migration/role evidence used by every consumer.

### Runtime, ownership, and evidence

- `scripts/release-control/command-runtime.ts` owns the one factory-created run supervisor, its sticky interruption state and publication-boundary guards, bounded domain versus cleanup subprocess execution, the sole real supervised Git snapshot adapter, explicit environments, coordinator-local Docker-context attestation, shared TCP/UDP loopback allocation/probing, termination, listener disposal, and safe result classification.
- `scripts/release-control/restricted-path.ts` owns the opaque exact-supervisor/host-environment association, atomic platform-private root/file leases, POSIX mode verification, protected Windows DACL creation/inspection through that supervisor, containment checks, and signal-resistant owned cleanup.
- `scripts/release-control/owned-compose.ts` owns the sole real identity/secret entropy adapter and the two exact entropy-byte-to-text secret-set mappings; pure run preparation; derived run/project/owner identities and public labels; checkpoint-identity and run/journal owner assertions; complete image-baseline journals; role-keyed database scopes; immutable manifest validation; post-build role-branded Compose-configuration leases; closed Compose/raw-helper/probe descriptors; raw-bind and storage-volume capability resolution; attested lifecycle typestate; exact label/name discovery; foreign-resource refusal; pre-bind/interrupted image cleanup; rehearsal/restore-image cleanup; final noncandidate cleanup receipts; and absence checks.
- `scripts/release-control/evidence.ts` owns success/failure construction, privacy scan, canonical fingerprint, authenticated cleanup/publication transactions, and no-clobber publication.
- `scripts/release-control/evidence-inspect.ts` is the thin non-authorizing structural inspector of one committed evidence root and optional safe summary; it adds no schema or complete expectation authority.
- `scripts/release-control/lifecycle.ts` owns the non-selectable stage state machine, structured smoke events, callback ordering, failure mapping, cleanup-finally semantics, and success publication after absence.
- `scripts/release-control/candidate-image-transfer.ts` owns exact source/restore engine checks, source/restore application-image capability brands, save/load and registration of one untagged local image ID, label/runtime revalidation, archive cleanup, and failure-before-handoff restore-image rollback; after successful handoff Task 6 is the sole restore-image cleanup owner.

### Consumers, checkpoint evidence, and activation closure

- `scripts/plan6b-production-smoke.ts` retains only production maintenance behavior and its consumer-specific Compose operations; common ownership/build/stages/evidence move inward.
- `scripts/plan6b-fixture-runtime-probe.ts` retains fixture seed, HTTP/admin/commerce, provider-canary, and aggregate assertions; it no longer imports or nests `runProductionSmoke`.
- `scripts/deployment-backup-bundle.ts` owns strict version-2 manifest verification and its canonical semantic fingerprint.
- `scripts/deployment-checkpoint-evidence.ts` reuses that verified fingerprint and shared database attestation, and owns safe capture/rehearsal attestations plus frozen checkpoint-input equality.
- `scripts/deployment-checkpoint.ts` accepts frozen source inputs and coordinator-owned rehearsal identity programmatically, preserves the standalone CLI, ACL-preserving restore, exact bundle, and current manual registry-digest workflow.
- `scripts/plan7a-release-candidate.ts` is the only release-profile composition root and package entrypoint.
- `src/lib/server/activation/contracts.ts` owns only the future input type and unconditional Plan 7A rejection; `src/lib/server/config/schema.ts` reserves but rejects `live`.
- `scripts/release-control-boundaries.test.ts` freezes dependency direction, privacy, package/Compose closure, absence of routes/providers/deployment, and single owners.

### Current documentation

- `README.md`, `docs/runtime-environments.md`, `docs/database-and-workers.md`, `docs/storage-ingestion-and-publication.md`, `docs/authentication-and-email.md`, `docs/commerce-and-guest-claims.md`, `docs/customer-library-and-reader.md`, `docs/financial-reconciliation-and-reporting.md`, `docs/stripe-financial-reconciliation.md`, and `docs/dependency-decisions.md` describe the implemented foundation and continued later-work boundary.
- Historical Plan 6 designs/plans remain unchanged. The Plan 7A design status changes only in the final status commit.

## Non-negotiable preserved behavior

- Migrations `0001` through `0015`, all snapshots/journal metadata, database schema, four principals, role provisioner, routine/trigger/ACL contracts, and `plan7a-database-catalog-v1` verifier remain exact.
- The backup bundle stays version `2` with the same 14 artifacts. Restore retains ACLs: `pg_restore` continues using `--clean --if-exists --no-owner` and never adds `--no-acl`.
- The five allowed financial operational diagnostic counts may be nonzero; every other verifier violation remains fatal.
- Existing smoke assertions remain: migration idempotence, four-role isolation, storage topology, maintenance 503s, worker live/stale/missing-slot health, Stripe-disabled/fixture separation, provider-network closure, financial replay, fixture quote/checkout/refund/admin paths, exact cleanup, and bounded aggregate output.
- Unit/watch tests remain hermetic. Service, integration, upgrade, browser, checkpoint, distinct-engine, and smoke commands remain explicit serialized release witnesses; no timeout is increased.
- Production `compose.prod.yaml` and `compose.stripe.yaml` remain unchanged; no production `.env` is introduced; Caddy remains the only published production edge; PostgreSQL and storage remain private.
- No evidence, log, audit, DTO, or diagnostic broadens authorization or becomes an idempotency input.

## Execution and evidence discipline

- Use RED -> verify the expected failure -> smallest GREEN -> refactor while green -> literal-path commit for every behavior-owning implementation task. No production code precedes its focused failing test. Tasks explicitly labeled verification-only, documentation-only, immutable-SHA integration, or review/status closure add no production behavior and aggregate already-RED/GREEN contracts instead of manufacturing a synthetic failure.
- Every multi-command fence in this plan is a checklist, not a pasteable script. Run exactly one top-level native command at a time, immediately inspect `$LASTEXITCODE`, and enter the next command only after the prior gate has the required result. Every GREEN/check/lint/build/git gate requires exit `0`; every RED requires nonzero exit for the stated missing behavior, never a syntax, path, tool, or environment error. A shell mode that continues after failure is prohibited.
- Only one implementation subagent edits at a time. After each task, a fresh spec-compliance reviewer runs before a fresh code-quality reviewer; all findings are fixed and re-reviewed before the next task.
- Hermetic tests may run freely. Serialize all Docker, PostgreSQL, service, integration, upgrade, Playwright, checkpoint, rehearsal, smoke, build, and broad verify commands. Review subagents must not start service-backed commands.
- Every external low-level boundary beneath the directly imported owners is injected in unit tests: Git, filesystem, clock, UUID/random source, structured logger, child process, loopback-port reservation/probe, Docker, Compose, HTTP, checkpoint, and publication. Tests use fixed privacy canaries but never print secret values.
- In every smoke consumer, lifecycle-owned evidence-root acquisition is the first run-owned external-resource mutation; the next operation fully awaits and stores Task 3's complete frozen source, stability fence, later-input registry, and `buildContextSha256`. Here, external-resource mutation means filesystem, Docker, socket, database, or service state: Task 5's required synchronous process-listener installation is pre-root control-plane setup and performs none of those mutations. Only after freezing succeeds may any Docker argv or loopback-runtime call occur. A dirty release source or any consumer's source-shape/change/freeze failure therefore produces zero Docker and zero socket calls across the complete failed run, including cleanup; then the shared order is publishing-context attestation, port allocation, subordinate leases, primary lifecycle construction, manifest seal, and build.
- A consumer may allocate or probe coordinator loopback only after Task 5 authenticates its publishing Docker context as a local `unix://` (POSIX) or `npipe://` (Windows) endpoint and observes the exact engine ID. SSH/TCP/HTTP contexts fail before sockets. The capability is reattested immediately before each first host-port bind; shared-path success alone never implies host-network locality.
- Before each service-backed command, snapshot Compose-labeled containers/networks/volumes, exact-name resources, relevant image IDs on every declared Docker context, and `pale-orbit-*` temporary/storage roots. Afterward require the exact baseline except the deliberately retained source release-candidate image and explicit evidence root. Never remove pre-existing or foreign state.
- Use `apply_patch` for hand edits. Preserve user changes. Stage literal paths only, run `git diff --cached --check`, inspect the cached diff, and never use `git add .`.
- A changed commit invalidates all candidate evidence. Every accepted review fix triggers the complete exact-SHA matrix, a new candidate ID/root, and another independent review.

## Planning integration checkpoint

### Task 0: Commit the two frozen planning artifacts before implementation

**Files:**
- Add: `docs/superpowers/plans/2026-08-29-plan-7a-checkpoint-d-release-control-foundation.md`
- Modify: `docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md`

- [ ] **Step 1: Verify approval, the external reviewed hashes, base, and exact unstaged path set**

This task is performed once by the plan author after the final two read-only reviews and explicit user approval. It grants no implementation authority. `PLAN7A_REVIEWED_PLAN_SHA256` and `PLAN7A_REVIEWED_DESIGN_SHA256` come from the final review handoff; they are deliberately external because a plan cannot contain its own whole-file hash without changing it.

```powershell
$ErrorActionPreference = 'Stop'
$CheckpointDBase = '6406c02cf463f1f0a389488e587ac688078d2cf8'
$PlanPath = 'docs/superpowers/plans/2026-08-29-plan-7a-checkpoint-d-release-control-foundation.md'
$DesignPath = 'docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md'
$ExpectedPlanSha256 = $env:PLAN7A_REVIEWED_PLAN_SHA256
$ExpectedDesignSha256 = $env:PLAN7A_REVIEWED_DESIGN_SHA256
if ($ExpectedPlanSha256 -cnotmatch '^[A-F0-9]{64}$' -or
    $ExpectedDesignSha256 -cnotmatch '^[A-F0-9]{64}$') {
  throw 'The exact uppercase reviewed plan and design SHA-256 values are required'
}
$ActualPlanSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PlanPath).Hash
$ActualDesignSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $DesignPath).Hash
if ($ActualPlanSha256 -cne $ExpectedPlanSha256 -or
    $ActualDesignSha256 -cne $ExpectedDesignSha256) {
  throw 'A frozen planning artifact differs from the reviewed bytes'
}
$HeadBeforePlanning = (git rev-parse --verify 'HEAD^{commit}').Trim()
if ($LASTEXITCODE -ne 0 -or $HeadBeforePlanning -cne $CheckpointDBase) {
  throw 'Planning integration must start at the fixed Checkpoint D base'
}
function Assert-Task0ExactOrdinalSet(
  [string] $Description,
  [string[]] $Expected,
  [string[]] $Actual
) {
  $ExpectedSorted = @($Expected | Sort-Object -CaseSensitive)
  $ActualSorted = @($Actual | Sort-Object -CaseSensitive)
  if ($ExpectedSorted.Count -ne $ActualSorted.Count) {
    throw "$Description count mismatch"
  }
  for ($Index = 0; $Index -lt $ExpectedSorted.Count; $Index += 1) {
    if ($ExpectedSorted[$Index] -cne $ActualSorted[$Index]) {
      throw "$Description mismatch at index $Index"
    }
  }
}
$UnstagedTracked = @(git diff --name-status --no-renames --)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect unstaged tracked planning paths' }
Assert-Task0ExactOrdinalSet 'unstaged tracked planning paths' `
  @("M`t$DesignPath") $UnstagedTracked
$Untracked = @(git ls-files --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect untracked planning paths' }
Assert-Task0ExactOrdinalSet 'untracked planning paths' @($PlanPath) $Untracked
$PrematureCached = @(git diff --cached --name-status --no-renames)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect premature cached paths' }
Assert-Task0ExactOrdinalSet 'premature cached planning paths' @() $PrematureCached
```

- [ ] **Step 2: Stage, inspect, commit, and prove exactly the reviewed pair**

Continue in the same PowerShell session. Inspect the displayed cached diff and confirm it contains only the reviewed plan and the one approved design-paragraph clarification before committing.

```powershell
git --literal-pathspecs add -- $PlanPath $DesignPath
if ($LASTEXITCODE -ne 0) { throw 'Could not stage the exact planning artifacts' }
$ExpectedPlanningRows = @("A`t$PlanPath", "M`t$DesignPath")
$CachedPlanningRows = @(git diff --cached --name-status --no-renames)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect cached planning paths' }
Assert-Task0ExactOrdinalSet 'cached planning paths' `
  $ExpectedPlanningRows $CachedPlanningRows
$RemainingUnstaged = @(git diff --name-only --)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect remaining unstaged paths' }
Assert-Task0ExactOrdinalSet 'remaining unstaged paths' @() $RemainingUnstaged
$RemainingUntracked = @(git ls-files --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect remaining untracked paths' }
Assert-Task0ExactOrdinalSet 'remaining untracked paths' @() $RemainingUntracked
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Planning staged diff check failed' }
git diff --cached -- $PlanPath $DesignPath
if ($LASTEXITCODE -ne 0) { throw 'Could not display the exact planning diff' }
$ExpectedPlanningTree = (git write-tree).Trim()
if ($LASTEXITCODE -ne 0 -or $ExpectedPlanningTree -cnotmatch '^[a-f0-9]{40}$') {
  throw 'Cannot bind the exact planning tree'
}
git commit -m "docs: plan Plan 7A Checkpoint D implementation"
if ($LASTEXITCODE -ne 0) { throw 'Planning commit failed' }
$PlanningCommit = (git rev-parse --verify 'HEAD^{commit}').Trim()
$PlanningCommitLine = (git rev-list --parents -n 1 $PlanningCommit).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect planning commit parent' }
$PlanningCommitParts = @($PlanningCommitLine -split ' ')
if ($PlanningCommitParts.Count -ne 2 -or
    $PlanningCommitParts[0] -cne $PlanningCommit -or
    $PlanningCommitParts[1] -cne $CheckpointDBase) {
  throw 'Planning commit is not the exact child of the fixed base'
}
$PlanningTreeSpec = $PlanningCommit + '^{tree}'
$ActualPlanningTree = (git rev-parse --verify $PlanningTreeSpec).Trim()
if ($LASTEXITCODE -ne 0 -or $ActualPlanningTree -cne $ExpectedPlanningTree) {
  throw 'Planning commit tree differs from the exact staged tree'
}
$PlanningCommitRows = @(git diff-tree --no-commit-id --name-status `
  --no-renames -r $PlanningCommit)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect planning commit paths' }
Assert-Task0ExactOrdinalSet 'planning commit paths' `
  $ExpectedPlanningRows $PlanningCommitRows
$PlanBlobSpec = $PlanningCommit + ':' + $PlanPath
$DesignBlobSpec = $PlanningCommit + ':' + $DesignPath
$PlanningPlanBlob = (git rev-parse --verify $PlanBlobSpec).Trim()
if ($LASTEXITCODE -ne 0 -or $PlanningPlanBlob -cnotmatch '^[a-f0-9]{40}$') {
  throw 'Cannot bind the committed plan blob identity'
}
$PlanningDesignBlob = (git rev-parse --verify $DesignBlobSpec).Trim()
if ($LASTEXITCODE -ne 0 -or $PlanningDesignBlob -cnotmatch '^[a-f0-9]{40}$') {
  throw 'Cannot bind the committed design blob identity'
}
$FinalPlanningStatus = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $FinalPlanningStatus.Count -ne 0) {
  throw 'Planning commit did not leave an exactly clean tree'
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $PlanPath).Hash -cne
      $ExpectedPlanSha256 -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $DesignPath).Hash -cne
      $ExpectedDesignSha256) {
  throw 'Committed planning bytes differ from the reviewed bytes'
}
$env:PLAN7A_PLANNING_COMMIT = $PlanningCommit
$env:PLAN7A_PLANNING_TREE = $ActualPlanningTree
$env:PLAN7A_PLANNING_PLAN_BLOB = $PlanningPlanBlob
$env:PLAN7A_PLANNING_DESIGN_BLOB = $PlanningDesignBlob
```

Record `$PlanningCommit`, `$ActualPlanningTree`, `$PlanningPlanBlob`, `$PlanningDesignBlob`, `$ExpectedPlanSha256`, and `$ExpectedDesignSha256` in the implementation handoff. Raw `Get-FileHash` replay is required only in the unchanged planning worktree because checkout line-ending conversion can change worktree bytes; a different clean worktree proves the recorded Git commit/tree/blob identities instead.

- [ ] **Step 3: Reload and prove the committed planning handoff read-only**

Task 1 begins only in a fresh implementation session that loads the four Git identities recorded by Step 2. Run this block instead of creating a second planning commit:

```powershell
$ErrorActionPreference = 'Stop'
$CheckpointDBase = '6406c02cf463f1f0a389488e587ac688078d2cf8'
$PlanPath = 'docs/superpowers/plans/2026-08-29-plan-7a-checkpoint-d-release-control-foundation.md'
$DesignPath = 'docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md'
$PlanningCommit = $env:PLAN7A_PLANNING_COMMIT
$PlanningTree = $env:PLAN7A_PLANNING_TREE
$PlanningPlanBlob = $env:PLAN7A_PLANNING_PLAN_BLOB
$PlanningDesignBlob = $env:PLAN7A_PLANNING_DESIGN_BLOB
foreach ($Value in @(
  $PlanningCommit, $PlanningTree, $PlanningPlanBlob, $PlanningDesignBlob
)) {
  if ($Value -cnotmatch '^[a-f0-9]{40}$') {
    throw 'Exact recorded planning Git identities are required'
  }
}
$ActualHead = (git rev-parse --verify 'HEAD^{commit}').Trim()
if ($LASTEXITCODE -ne 0 -or $ActualHead -cne $PlanningCommit) {
  throw 'Fresh implementation HEAD is not the planning commit'
}
$PlanningCommitLine = (git rev-list --parents -n 1 $PlanningCommit).Trim()
if ($LASTEXITCODE -ne 0 -or
    $PlanningCommitLine -cne "$PlanningCommit $CheckpointDBase") {
  throw 'Recorded planning commit parent differs from the fixed base'
}
$PlanningTreeSpec = $PlanningCommit + '^{tree}'
$ActualPlanningTree = (git rev-parse --verify $PlanningTreeSpec).Trim()
if ($LASTEXITCODE -ne 0 -or $ActualPlanningTree -cne $PlanningTree) {
  throw 'Recorded planning tree differs from the commit tree'
}
$PlanBlobSpec = $PlanningCommit + ':' + $PlanPath
$ActualPlanBlob = (git rev-parse --verify $PlanBlobSpec).Trim()
if ($LASTEXITCODE -ne 0 -or $ActualPlanBlob -cne $PlanningPlanBlob) {
  throw 'Recorded plan blob differs from the commit'
}
$DesignBlobSpec = $PlanningCommit + ':' + $DesignPath
$ActualDesignBlob = (git rev-parse --verify $DesignBlobSpec).Trim()
if ($LASTEXITCODE -ne 0 -or $ActualDesignBlob -cne $PlanningDesignBlob) {
  throw 'Recorded design blob differs from the commit'
}
$ExpectedPlanningRows = @("A`t$PlanPath", "M`t$DesignPath")
$PlanningRows = @(git diff-tree --no-commit-id --name-status `
  --no-renames -r $PlanningCommit)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect recorded planning paths' }
$ExpectedSorted = @($ExpectedPlanningRows | Sort-Object -CaseSensitive)
$ActualSorted = @($PlanningRows | Sort-Object -CaseSensitive)
if ($ExpectedSorted.Count -ne $ActualSorted.Count) {
  throw 'Recorded planning path count mismatch'
}
for ($Index = 0; $Index -lt $ExpectedSorted.Count; $Index += 1) {
  if ($ExpectedSorted[$Index] -cne $ActualSorted[$Index]) {
    throw "Recorded planning path mismatch at index $Index"
  }
}
$Status = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $Status.Count -ne 0) {
  throw 'Implementation must start from the exactly clean planning commit'
}
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'Planning handoff diff check failed' }
```

## Milestone A - deterministic contracts and frozen inputs

### Task 1: Verify the Checkpoint C handoff and make source-shape tests checkout-neutral

**Files:**
- Modify: `scripts/with-plan6b-upgrade-database.test.ts`
- Modify: `scripts/commerce-operations.test.ts`

- [ ] **Step 1: Prove the fixed ancestry, status, scope, and fresh-checkout RED**

```powershell
$ErrorActionPreference = 'Stop'
$CheckpointDBase = '6406c02cf463f1f0a389488e587ac688078d2cf8'
$Plan7ADesign = '1c330693b67a1aa34c413bd8d2ec23ff8628236e'
git status --short --branch
if (git status --porcelain) { throw 'Checkpoint D implementation worktree is not clean.' }
git merge-base --is-ancestor $CheckpointDBase HEAD
if ($LASTEXITCODE -ne 0) { throw 'Checkpoint C completion is not an ancestor.' }
git merge-base --is-ancestor $Plan7ADesign HEAD
if ($LASTEXITCODE -ne 0) { throw 'Approved Plan 7A design is not an ancestor.' }
if (-not (Select-String -Quiet `
  -LiteralPath docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md `
  -Pattern '^\*\*Implementation status:\*\* Checkpoints A-C complete; Checkpoint D not started$')) {
  throw 'Checkpoint D design status is not at the approved handoff.'
}
git diff --check
npx vitest run --config vitest.config.ts `
  scripts/with-plan6b-upgrade-database.test.ts `
  scripts/commerce-operations.test.ts `
  --maxWorkers=1 `
  -t 'keeps historical rollback proofs while repaired and valid flows reach 0015 once|pins one versioned exact catalog contract for every protected financial object kind'
```

Expected: ancestry/status/diff checks pass. On a CRLF checkout, the two named tests fail only because LF literals are compared with CRLF source bodies; on an already LF-normalized checkout, demonstrate the RED with fixed CRLF copies in the tests before editing production code.

- [ ] **Step 2: Normalize only comparison inputs and prove focused GREEN**

Add one local helper to each test boundary:

```ts
function normalizedSource(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}
```

Use `normalizedSource(fixture)` before extracting the migration harness block and normalize the complete SQL/catalog statement before locating its dollar-body delimiter. Do not edit migration SQL, generated snapshots, expected routine bodies, or timeouts.

```powershell
npx vitest run --config vitest.config.ts `
  scripts/with-plan6b-upgrade-database.test.ts `
  scripts/commerce-operations.test.ts `
  --maxWorkers=1 `
  -t 'keeps historical rollback proofs while repaired and valid flows reach 0015 once|pins one versioned exact catalog contract for every protected financial object kind'
```

Expected: both tests pass with LF and CRLF fixture bytes and still reject a real source mismatch.

- [ ] **Step 3: Run the complete owning files and commit the prerequisite**

```powershell
npx vitest run --config vitest.config.ts `
  scripts/with-plan6b-upgrade-database.test.ts `
  scripts/commerce-operations.test.ts `
  --maxWorkers=1 --reporter=verbose
git --literal-pathspecs add -- `
  scripts/with-plan6b-upgrade-database.test.ts `
  scripts/commerce-operations.test.ts
git diff --cached --check
git diff --cached -- `
  scripts/with-plan6b-upgrade-database.test.ts `
  scripts/commerce-operations.test.ts
git commit -m "fix: make source-shape witnesses checkout-neutral"
```

Expected: both owning files pass serially; the commit changes tests only and leaves all tracked production/migration bytes untouched.

### Task 2: Define canonical JSON and the exact evidence contract

**Files:**
- Create: `scripts/release-control/canonical-json.ts`
- Create: `scripts/release-control/canonical-json.test.ts`
- Create: `scripts/release-control/contracts.ts`
- Create: `scripts/release-control/contracts.test.ts`
- Modify: `src/lib/server/observability/contracts.ts`
- Modify: `src/lib/server/observability/contracts.test.ts`

- [ ] **Step 1: Write canonicalization and contract REDs**

Write canonical-value tests that require recursively raw-byte-sorted plain-object keys, preserved array order, LF-only UTF-8, one terminal LF, stable SHA-256, and rejection of `undefined`, `null` where disallowed, floats, bigint, symbols, accessors, nonplain prototypes, and nonfinite numbers. Separately test a strict raw UTF-8 JSON tokenizer/parser that rejects BOM/invalid UTF-8, trailing bytes, unsafe/unsupported numbers, accessors/prototypes, and duplicate decoded member names before object construction—including escape-equivalent names such as `"a"` and `"\u0061"`. Pin these exact public constants and discriminants. `SMOKE_PRODUCERS`, `SMOKE_STAGES`, `SmokeProducer`, `SmokeProfile`, and `SmokeStage` are exported by `src/lib/server/observability/contracts.ts`; the two ordered required-stage sequences are exported by `scripts/release-control/contracts.ts`:

```ts
export const SMOKE_PRODUCERS = [
  'plan6b-production-smoke',
  'plan6b-fixture-runtime-probe',
  'plan7a-release-candidate'
] as const;

export const SMOKE_STAGES = [
  'preflight', 'build', 'compose-config', 'migrate', 'provision',
  'checkpoint-capture', 'restore-rehearsal', 'runtime-start', 'runtime-health',
  'inspect', 'behavior', 'shutdown', 'cleanup'
] as const;

export const MAINTENANCE_STAGES = [
  'preflight', 'build', 'compose-config', 'migrate', 'provision',
  'runtime-start', 'runtime-health', 'inspect', 'behavior', 'shutdown', 'cleanup'
] as const;

export const RELEASE_STAGES = [
  'preflight', 'build', 'compose-config', 'migrate', 'provision',
  'checkpoint-capture', 'restore-rehearsal', 'runtime-start', 'runtime-health',
  'inspect', 'behavior', 'shutdown', 'cleanup'
] as const;
```

Freeze every nested evidence shape in the contract test:

```ts
export type SourceMode = 'workspace_fixture' | 'committed_revision';

declare const dockerEngineIdBrand: unique symbol;
export type DockerEngineId = string & {
  readonly [dockerEngineIdBrand]: 'plan7a-docker-engine-id-v1';
};

export function parseDockerEngineId(value: unknown): DockerEngineId;

export interface Plan7aImageLabels {
  readonly 'org.opencontainers.image.revision': string;
  readonly 'com.paleorbit.plan7a.source-mode': SourceMode;
  readonly 'com.paleorbit.plan7a.source-clean': 'true' | 'false';
  readonly 'com.paleorbit.plan7a.build-context-sha256': string;
}

export interface Plan7aOwnedResourceLabels {
  readonly 'com.paleorbit.plan7a.owner': string;
  readonly 'com.paleorbit.plan7a.run-id': string;
  readonly 'com.paleorbit.plan7a.candidate-id': string;
  readonly 'com.paleorbit.plan7a.project': string;
}

export interface MigrationTipEvidence {
  readonly index: 15;
  readonly tag: '0015_plan7a_operations_authority';
  readonly when: 1787812813508;
  readonly sha256: string;
}

export interface DatabaseRoleAttestation {
  readonly result: 'verified';
  readonly principalCount: 4;
  readonly pairwiseDistinct: true;
  readonly catalogContract: 'plan7a-database-catalog-v1';
  readonly verifierSha256: string;
}

export interface SmokeStageOutcome {
  readonly stage: SmokeStage;
  readonly result: 'succeeded';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface CleanupEvidence {
  readonly containers: number;
  readonly networks: number;
  readonly volumes: number;
  readonly temporaryRoots: number;
}

export interface ZeroCleanupEvidence {
  readonly containers: 0;
  readonly networks: 0;
  readonly volumes: 0;
  readonly temporaryRoots: 0;
}

export interface ReleaseCheckpointEvidence {
  readonly backupId: string;
  readonly backupManifestSha256: string;
  readonly captureDockerEngineId: DockerEngineId;
  readonly restoreDockerEngineId: DockerEngineId;
  readonly sourceCatalogResult: 'verified';
  readonly restoreCatalogResult: 'verified';
  readonly replacementDisposition: 'clear';
  readonly rehearsalCleanup: ZeroCleanupEvidence;
}

interface SmokeSuccessCommonV1 {
  readonly version: 1;
  readonly producer: SmokeProducer;
  readonly profile: SmokeProfile;
  readonly runId: string;
  readonly candidateId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly requiredStages: readonly SmokeStage[];
  readonly imageId: string;
  readonly sourceMode: SourceMode;
  readonly sourceClean: boolean;
  readonly sourceRevision: string;
  readonly buildContextSha256: string;
  readonly imageLabels: Plan7aImageLabels;
  readonly composeProject: string;
  readonly configurationFingerprint: string;
  readonly origin: string;
  readonly migrationTip: MigrationTipEvidence;
  readonly databaseRoleAttestation: DatabaseRoleAttestation;
  readonly stageOutcomes: readonly SmokeStageOutcome[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly cleanup: ZeroCleanupEvidence;
}

export type SmokeSuccessEvidenceV1 =
  | (SmokeSuccessCommonV1 & {
      readonly producer: 'plan6b-production-smoke' | 'plan6b-fixture-runtime-probe';
      readonly profile: 'maintenance_fixture';
      readonly sourceMode: 'workspace_fixture';
      readonly requiredStages: typeof MAINTENANCE_STAGES;
    })
  | (SmokeSuccessCommonV1 & {
      readonly producer: 'plan7a-release-candidate';
      readonly profile: 'release_candidate';
      readonly sourceMode: 'committed_revision';
      readonly sourceClean: true;
      readonly requiredStages: typeof RELEASE_STAGES;
      readonly checkpoint: ReleaseCheckpointEvidence;
    });

interface SmokeFailureEvidenceCommonV1 {
  readonly version: 1;
  readonly runId: string;
  readonly candidateId: string;
  readonly stage: SmokeStage;
  readonly code: SmokeFailedCode;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly cleanup: CleanupEvidence;
}

export type SmokeFailureEvidenceV1 = SmokeFailureEvidenceCommonV1 & (
  | {
      readonly producer: 'plan6b-production-smoke' | 'plan6b-fixture-runtime-probe';
      readonly profile: 'maintenance_fixture';
    }
  | {
      readonly producer: 'plan7a-release-candidate';
      readonly profile: 'release_candidate';
    }
);

interface EvidenceExpectationCommon {
  readonly producer: SmokeProducer;
  readonly profile: SmokeProfile;
  readonly runId: string;
  readonly candidateId: string;
  readonly imageId: string;
  readonly imageLabels: Plan7aImageLabels;
  readonly sourceMode: SourceMode;
  readonly sourceClean: boolean;
  readonly sourceRevision: string;
  readonly buildContextSha256: string;
  readonly composeProject: string;
  readonly configurationFingerprint: string;
  readonly origin: string;
  readonly migrationTip: MigrationTipEvidence;
  readonly databaseRoleAttestation: DatabaseRoleAttestation;
  readonly requiredStages: readonly SmokeStage[];
  readonly now: string;
}

export type EvidenceExpectation =
  | (EvidenceExpectationCommon & {
      readonly producer: 'plan6b-production-smoke' | 'plan6b-fixture-runtime-probe';
      readonly profile: 'maintenance_fixture';
      readonly sourceMode: 'workspace_fixture';
      readonly requiredStages: typeof MAINTENANCE_STAGES;
    })
  | (EvidenceExpectationCommon & {
      readonly producer: 'plan7a-release-candidate';
      readonly profile: 'release_candidate';
      readonly sourceMode: 'committed_revision';
      readonly sourceClean: true;
      readonly requiredStages: typeof RELEASE_STAGES;
      readonly checkpoint: ReleaseCheckpointEvidence;
    });

export function assertSmokeSuccessCrossFieldInvariants(
  evidence: SmokeSuccessEvidenceV1
): void;
```

Maintenance parsing rejects an own `checkpoint` key. Every success parser requires exact literal zero for all four final cleanup counts and, for release, all four rehearsal cleanup counts; numeric `CleanupEvidence` remains only for failure records, residual attempts, and diagnostics. `assertSmokeSuccessCrossFieldInvariants` requires the four image labels to equal `sourceRevision`, `sourceMode`, `String(sourceClean)`, and `buildContextSha256` respectively. Invoke that one invariant from strict success parsing, `assertEvidenceMatches`, pre-link construction, and inspector-summary construction. Failure parsing requires exactly the ten keys above, a registered producer/profile pairing, one stage allowed by that profile, one of the seven existing safe codes, canonical IDs/timestamps, nonregressing bounded duration, and four nonnegative safe-integer conservative cleanup counts. Exact-key parsers also reject accessors, symbols, inherited data, unsafe integers, noncanonical timestamps/hashes/IDs, and any outcome whose stage, order, timestamps, result, or duration disagrees with the containing record.

Tests must require exact evidence keys from Resolved Decisions 16-19, reject a `checkpoint` key or `committed_revision` source mode for maintenance, require checkpoint plus `committed_revision` for release, reject `imageDigest`, `latest`, extra keys, wrong producer/profile pairings, invalid origin, wrong stage order, timestamp regression, expiry not exactly 24 hours, noncanonical UUID/run/image/hash values, and any mismatch in an `EvidenceExpectation`. Independently mutate each top-level source field and each corresponding image label while recomputing canonical bytes/fingerprint; strict parsing, publication, and inspection must still reject. Set each success or rehearsal cleanup member to `1` and require the same rejection, while proving failure evidence may retain nonzero conservative counts.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run `
  scripts/release-control/canonical-json.test.ts `
  scripts/release-control/contracts.test.ts `
  src/lib/server/observability/contracts.test.ts `
  --reporter=verbose
```

Expected: FAIL because the modules and exported shared stage/profile constants do not exist.

- [ ] **Step 3: Implement canonical primitives and strict discriminated evidence types**

Implement these public seams without I/O:

```ts
export type CanonicalValue =
  | string
  | boolean
  | number
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function canonicalJson(value: CanonicalValue): string;
export function canonicalSha256(value: CanonicalValue): string;
export function sha256Bytes(value: Uint8Array): string;
export function decodeStrictUtf8(value: Uint8Array): string;
export function parseStrictJsonBytes(value: Uint8Array): unknown;
export function requiredStages(profile: SmokeProfile): readonly SmokeStage[];
export function parseCanonicalReleaseOrigin(value: unknown): string;
export function parseSmokeSuccessEvidence(value: unknown): SmokeSuccessEvidenceV1;
export function parseSmokeFailureEvidence(value: unknown): SmokeFailureEvidenceV1;
export function assertEvidenceMatches(
  evidence: SmokeSuccessEvidenceV1,
  expected: EvidenceExpectation
): void;
```

`parseDockerEngineId` accepts only a nonempty 1..128-character printable ASCII identifier matching `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`. Docker command adapters decode strict UTF-8, require exactly one output line (allowing only the command's terminal LF/CRLF), and pass that line through this parser. CLI expected IDs, manifest IDs, runtime observations, and evidence all use the branded result and exact case-sensitive equality; whitespace trimming, controls, embedded newlines, and every unparsed string are rejected.

Refactor the existing inline producer/profile literals and private `STAGES` set into the exported observability leaf constants/types, and build validation from those constants. Import them into release-control and define the two ordered sequences there. Type `SmokeEventInput.stage` as `SmokeStage`; keep the exact Checkpoint B events, codes, fields, sinks, and runtime validation unchanged. Observability must not import release-control.

Every new evidence, manifest, Docker/Compose inspection, ACL-adapter, and bundle reader must pass raw bytes through `parseStrictJsonBytes` before its exact shape parser. `canonicalJson` accepts only already-constructed canonical values and makes no impossible claim about detecting overwritten duplicate keys.

- [ ] **Step 4: Prove GREEN, type consistency, and commit**

```powershell
npx vitest run `
  scripts/release-control/canonical-json.test.ts `
  scripts/release-control/contracts.test.ts `
  src/lib/server/observability/contracts.test.ts `
  src/lib/server/observability/logger.test.ts `
  --reporter=verbose
npm run check
git --literal-pathspecs add -- `
  scripts/release-control/canonical-json.ts `
  scripts/release-control/canonical-json.test.ts `
  scripts/release-control/contracts.ts `
  scripts/release-control/contracts.test.ts `
  src/lib/server/observability/contracts.ts `
  src/lib/server/observability/contracts.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: define deterministic smoke evidence contracts"
```

Expected: exact contract and logger tests pass; `check` reports no type drift; no producer emits yet.

### Task 3: Freeze Docker-compatible committed and workspace build contexts

**Files:**
- Create: `scripts/release-control/dockerignore.ts`
- Create: `scripts/release-control/dockerignore.test.ts`
- Create: `scripts/release-control/docker-context-tar.ts`
- Create: `scripts/release-control/docker-context-tar.test.ts`
- Create: `scripts/release-control/build-context.ts`
- Create: `scripts/release-control/build-context.test.ts`

- [ ] **Step 1: Write Dockerignore semantics REDs**

Pin ordered match behavior for comments, blanks, `/` normalization, basename patterns, directory descendants, `*`, `?`, `**`, character classes, escaped leading `#`/`!`, negation re-inclusion, last-match-wins, and the repository's exact committed patterns. Include cases proving `.env`, `.env.production`, `compose.prod.yaml`, `Dockerfile.dev`, `.worktrees/x`, and `docs/x.md` are excluded while `.dockerignore`, the selected `Dockerfile`, `package.json`, source, migration, and build configuration are handled exactly as controls/COPY entries require.

```ts
const matcher = parseDockerignore([
  'node_modules',
  '**/*.secret',
  '!fixtures/allowed.secret'
].join('\n'));

expect(matcher.includes('src/index.ts', false)).toBe(true);
expect(matcher.includes('nested/key.secret', false)).toBe(false);
expect(matcher.includes('fixtures/allowed.secret', false)).toBe(true);
```

Pin the parser seam used by both inventory modes:

```ts
export interface DockerignoreMatcher {
  includes(path: string, isDirectory: boolean): boolean;
}

export function parseDockerignore(source: string): DockerignoreMatcher;
```

Reject absolute/drive/UNC patterns, NUL, `..` escape, malformed character classes, ambiguous trailing escapes, and any materialized path collision.

- [ ] **Step 2: Write source inventory, stability, and digest REDs**

Use injected Git/filesystem fakes to require:

- release mode rejects dirty tracked/untracked state and reads only exact `HEAD` blobs/modes;
- workspace mode includes modified and untracked nonignored bytes, excludes ignored/deleted bytes, and records actual cleanliness;
- every untracked regular file receives logical mode `100644` on every host; only a tracked Git index/tree entry may supply `100755`, and host executable/DOS attributes never influence the tar mode;
- both modes reject symlink/submodule/special/mode/path/case collisions;
- strict Dockerfile analysis records the exact syntax frontend and every external base image after resolving only constant pre-`FROM` `ARG` defaults, ignores named prior stages, and rejects unresolved/dynamic/external-copy references;
- a HEAD, status, inventory, mode, size, mtime, or digest change between observations fails;
- every retained byte array is a defensive copy and a later caller mutation cannot alter the digest, tar, or frozen-input registry; and
- the canonical version-1 digest matches an independently calculated fixture.

Add byte-level ustar fixtures that independently verify sorted UTF-8 paths, logical `100644`/`100755` to header `0644`/`0755`, directory `0755`, zero uid/gid/mtime, empty owner names, exact octal fields/checksums, 512-byte padding, and exactly two terminal zero blocks. Require identical tar bytes on simulated Windows and POSIX hosts, and reject long/non-ustar paths, duplicate or case-colliding paths, unsupported modes, links, devices, sockets, and source bytes that differ from the frozen entry digest.

Define the wished-for API in tests:

```ts
const snapshot = await freezeBuildContext({
  sourceMode: 'committed_revision',
  repositoryRoot,
  dockerfile: 'Dockerfile',
  git,
  fileSystem
});

expect(snapshot).toEqual(expect.objectContaining({
  sourceMode: 'committed_revision',
  sourceClean: true,
  sourceRevision: 'a'.repeat(40),
  buildContextSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
}));
```

- [ ] **Step 3: Run RED**

```powershell
npx vitest run `
  scripts/release-control/dockerignore.test.ts `
  scripts/release-control/docker-context-tar.test.ts `
  scripts/release-control/build-context.test.ts `
  --reporter=verbose
```

Expected: FAIL because the matcher, deterministic tar encoder, and snapshot engine do not exist.

- [ ] **Step 4: Implement the pure matcher and injected snapshot engine**

Implement a closed parser rather than importing a transitive package. Use Git plumbing (`rev-parse`, porcelain-v2 status, `ls-tree -rz`, `ls-files -z`, `cat-file blob`) only behind this injected interface:

```ts
export type FrozenRepositoryInput =
  | 'compose.prod.yaml'
  | 'compose.test.yaml'
  | 'deploy/Caddyfile'
  | 'scripts/capture-restore-row-counts.sql'
  | 'scripts/capture-storage-reference-inventory.sql'
  | 'scripts/capture-storage-samples.sql'
  | 'scripts/verify-financial-restore.sql'
  | 'drizzle/meta/_journal.json'
  | 'drizzle/0015_plan7a_operations_authority.sql';

export interface BuildContextStat {
  readonly kind: 'file' | 'directory' | 'symbolic-link' | 'other';
  readonly logicalMode: '100644' | '100755' | 'unsupported';
  readonly byteLength: number;
  readonly identity: string;
  readonly modifiedNanoseconds: string;
}

export interface BuildContextEntry {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly byteLength: number;
  readonly sha256: string;
}

export interface GitSnapshotRuntime {
  captureText(args: readonly string[]): Promise<string>;
  captureBytes(args: readonly string[]): Promise<Uint8Array>;
}

export interface BuildContextFileSystem {
  lstat(path: string): Promise<BuildContextStat>;
  readFile(path: string): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
}

export function createNodeBuildContextFileSystem(
  repositoryRoot: string
): BuildContextFileSystem;

export interface FreezeBuildContextInput {
  readonly sourceMode: SourceMode;
  readonly repositoryRoot: string;
  readonly dockerfile: 'Dockerfile';
  readonly git: GitSnapshotRuntime;
  readonly fileSystem: BuildContextFileSystem;
}

export interface FrozenBuildContext {
  readonly sourceMode: SourceMode;
  readonly sourceClean: boolean;
  readonly sourceRevision: string;
  readonly dockerfileSha256: string;
  readonly dockerignoreSha256: string;
  readonly dockerfileRequirements: {
    readonly syntaxFrontend?: string;
    readonly baseImages: readonly string[];
  };
  readonly entries: readonly BuildContextEntry[];
  readonly buildContextSha256: string;
  readonly dockerContextTar: Uint8Array;
  readFrozenInput(path: FrozenRepositoryInput): Uint8Array;
}

export async function freezeBuildContext(
  input: FreezeBuildContextInput
): Promise<FrozenBuildContext>;
```

`readFrozenInput` may expose only a closed registry needed later: `compose.prod.yaml`, `compose.test.yaml`, `deploy/Caddyfile`, `scripts/capture-restore-row-counts.sql`, `scripts/capture-storage-reference-inventory.sql`, `scripts/capture-storage-samples.sql`, `scripts/verify-financial-restore.sql`, `drizzle/meta/_journal.json`, and `drizzle/0015_plan7a_operations_authority.sql`. Task 3 owns only the injected Git interface and imports no process or Task 5 implementation; Task 5 later supplies the sole real supervised Git adapter. Task 3 itself owns the sole real `BuildContextFileSystem`: `createNodeBuildContextFileSystem` accepts one canonical absolute repository root, performs no I/O at construction, and confines every later read/stat/realpath to that root. Focused unit tests inject in-memory fakes for both boundaries.

Strictly parse Dockerfile directives and stages from the selected control bytes. For the current file, require syntax frontend `docker/dockerfile:1.7` and one resolved external base `node:26.7.0-bookworm-slim`; tests mutate the directive, ARG default, stage aliases, and `COPY --from` cases so the list cannot silently stale. Build `dockerContextTar` directly from the fenced logical inventory with the Task 3 encoder. Include the selected `Dockerfile` and `.dockerignore` controls exactly once, use tracked Git modes for tracked entries, and assign every untracked regular file `100644`; never infer an untracked executable bit from POSIX mode bits, NTFS metadata, or DOS attributes. The Node filesystem adapter uses no-follow handle reads where supported, captures stable device/file identity, byte length, kind, and nanosecond modification identity before and after the defensive-copy read, repeats canonical-root containment, and rejects symlink/reparse replacement or an unavailable exact identity/nanosecond observation. Tests exercise an actual temporary filesystem on the current platform, including link/reparse/path replacement and outside-root denial, without touching the real repository. Add an identical Windows/POSIX tar fixture for the same untracked file. Return defensive byte copies from the requirements, tar, and closed frozen-input registry. The logical inventory is the design's restricted, initially empty build root: it starts with no entries, admits only the fenced allowlisted entries, and is encoded directly to the deterministic stream. Task 3 intentionally creates no host output directory; later owners materialize only the non-build inputs they need beneath Task 5A's platform-private leases. Docker must never receive an NTFS/POSIX host directory as its build context.

- [ ] **Step 5: Prove GREEN and mutation safety**

```powershell
npx vitest run `
  scripts/release-control/dockerignore.test.ts `
  scripts/release-control/docker-context-tar.test.ts `
  scripts/release-control/build-context.test.ts `
  scripts/release-control/contracts.test.ts `
  --reporter=verbose
npm run check
npm run lint -- --no-warn-ignored `
  scripts/release-control/dockerignore.ts `
  scripts/release-control/docker-context-tar.ts `
  scripts/release-control/build-context.ts
```

Expected: every exact selection, digest, rejection, stability, and defensive-copy test passes without touching Docker, a host output root, or the real repository.

- [ ] **Step 6: Commit frozen-input ownership**

```powershell
git --literal-pathspecs add -- `
  scripts/release-control/dockerignore.ts `
  scripts/release-control/dockerignore.test.ts `
  scripts/release-control/docker-context-tar.ts `
  scripts/release-control/docker-context-tar.test.ts `
  scripts/release-control/build-context.ts `
  scripts/release-control/build-context.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: freeze exact smoke build inputs"
```

### Task 4: Bind image labels, origin, and canonical Compose configuration

**Files:**
- Create: `scripts/release-control/compose-config.ts`
- Create: `scripts/release-control/compose-config.test.ts`
- Modify: `scripts/release-control/contracts.ts`
- Modify: `scripts/release-control/contracts.test.ts`

- [ ] **Step 1: Write exact origin, image-label, override, and configuration REDs**

For `release_candidate`, pin acceptance of exact canonical `https://books.example.com`, `https://books.example.com:8443`, `https://127.0.0.1`, `https://localhost`, and an already canonical ASCII/punycode or special-use host. Reject trailing slash, uppercase/canonicalization drift, spelled default `:443`, credentials, query, fragment, path, trailing-dot host, raw Unicode that the parser rewrites, alternate/noncanonical IP spelling, and every non-HTTPS scheme. These checks define exact unambiguous release-origin syntax, not public DNS or certificate reachability. Keep a separate maintenance-origin parser: production maintenance accepts only its fixed canonical `https://plan6b-smoke.invalid`, while fixture maintenance accepts only exact canonical `http://127.0.0.1:<allocated-port>` with a decimal port in `1..65535`; neither maintenance form is accepted for release evidence.

Require this exact label record and profile-discriminated raw-ID override behavior:

```ts
const imageLabels = {
  'org.opencontainers.image.revision': sourceRevision,
  'com.paleorbit.plan7a.source-mode': sourceMode,
  'com.paleorbit.plan7a.source-clean': String(sourceClean),
  'com.paleorbit.plan7a.build-context-sha256': buildContextSha256
} as const;

const imageId = `sha256:${'a'.repeat(64)}`;
const pinnedPostgresImage = `postgres@sha256:${'b'.repeat(64)}`;
const privateOwnerToken = 'c'.repeat(32);
const publicOwnershipLabels: Plan7aPublicResourceLabels = {
  'com.paleorbit.plan7a.run-id': 'd'.repeat(16),
  'com.paleorbit.plan7a.candidate-id':
    '22222222-2222-4222-8222-222222222222',
  'com.paleorbit.plan7a.project': 'pale-orbit-plan7a-source-' + 'd'.repeat(16)
};
const releaseOverrideBytes = renderImmutableImageOverride({
  profile: 'release_candidate',
  topology: 'production',
  publicOwnershipLabels
});
const releaseOverride = new TextDecoder('utf-8', { fatal: true })
  .decode(releaseOverrideBytes);
expect(releaseOverride).toContain('image: ${APP_IMAGE:?required}');
expect(releaseOverride).toContain('image: ${POSTGRES_IMAGE:?required}');
expect(releaseOverride).not.toContain(imageId);
expect(releaseOverride).not.toContain(pinnedPostgresImage);
expect(releaseOverride).not.toContain(privateOwnerToken);
expect(releaseOverride.match(/pull_policy: never/gu)).toHaveLength(8);
```

Tests for `docker compose config --format json` parsing must cover all three allowed profile/topology combinations. `production` requires exactly `app`, `worker`, `migrate`, `database-role-provision`, `bootstrap-admin`, `storage-cleanup`, `postgres`, and `caddy`; Caddy-only host publication; private PostgreSQL; six exact volumes; the default network; seven exact Compose secret slots; exact app/worker/tool secret scope; the same app image ID for all application/tool services; and fixed maintenance/Stripe-false values. `release_candidate` plus `production` additionally requires the exact digest-pinned PostgreSQL reference and `pull_policy: never` on all eight production services, including Caddy. `maintenance_fixture` plus `production` requires `pull_policy: never` on exactly the six raw-ID application/tool services while preserving the base PostgreSQL/Caddy references and their existing pull behavior. `maintenance_fixture` plus `fixture` requires exactly `postgres`, `mailpit`, `stripe_api_canary`, `app`, `worker`, `bootstrap-admin`, `migrate`, and `database-role-provision`; the exact candidate image and `pull_policy: never` on exactly its six raw-ID services (`stripe_api_canary`, `app`, `worker`, `bootstrap-admin`, `migrate`, and `database-role-provision`) while preserving base behavior only for PostgreSQL and Mailpit; only loopback fixture publication; four exact volumes; the default internal network; `bootstrap_admin_password` as its only Compose secret; the exact direct fixture credential environment slots; prototype/test-provider mode; and no Caddy or storage-cleanup service. Reject release+fixture, a release override without the pinned PostgreSQL reference, a maintenance override with one, a tag/nonlocal digest, a missing/extra `never` policy on any raw-ID service, any pull-capable release service, and every unknown service/network/volume/secret or production/fixture cross-use.

Pin the renderer's complete interpolation vocabulary and reject every missing, duplicate, unknown, defaulted, or unreferenced private slot. Both production templates replace the base `secrets.*.environment` sources with exact file sources using `PLAN7A_DATABASE_OWNER_PASSWORD_FILE`, `PLAN7A_DATABASE_PASSWORD_FILE`, `PLAN7A_DATABASE_WORKER_PASSWORD_FILE`, `PLAN7A_DATABASE_STORAGE_CLEANUP_PASSWORD_FILE`, `PLAN7A_AUTH_SECRET_FILE`, `PLAN7A_SMTP_PASSWORD_FILE`, and `PLAN7A_BOOTSTRAP_ADMIN_PASSWORD_FILE`; their only other private slot is `PLAN7A_OWNERSHIP_TOKEN`. They retain the reviewed base nonsecret variables, including `APP_IMAGE`, `POSTGRES_IMAGE`, the HTTP/HTTPS bind and port variables, and all existing bounded configuration defaults. Fixture maintenance uses exactly `APP_IMAGE`, `AUTH_SECRET`, `DATABASE_OWNER_PASSWORD`, `DATABASE_PASSWORD`, `DATABASE_STORAGE_CLEANUP_PASSWORD`, `DATABASE_WORKER_PASSWORD`, `ORIGIN`, `PLAN7A_BOOTSTRAP_ADMIN_PASSWORD_FILE`, `PLAN7A_FIXTURE_DATABASE_PORT`, `PLAN7A_FIXTURE_WEB_PORT`, `PLAN7A_OWNERSHIP_TOKEN`, `POSTGRES_DB`, and `POSTGRES_USER`. Fixture PostgreSQL takes its password from `DATABASE_OWNER_PASSWORD`; the four role passwords plus `AUTH_SECRET` remain direct scoped-environment slots; both fixture publications bind fixed `127.0.0.1` and take only their port from the two exact Plan 7A port slots. Every required placeholder uses the exact `${NAME:?required}` form and has no default.

Require generated override bytes to contain only public run/candidate/project label literals, that topology's exact fixed placeholders, reviewed fixed nonsecret literals, and fixed container paths—never the candidate image ID, origin, PostgreSQL reference, fixture credential, private owner token, host secret-root path, or any direct/indirect hash of one. Supply resolved values only through the exact complete role-scoped `ReleaseControlCommandEnvironment` used by the single `docker compose config` invocation and later lifecycle commands. Inject two different canary sets into every topology-specific secret-bearing Compose slot, direct fixture credential environment slot, private owner token, and owned host root; require identical raw override bytes, raw override SHA-256, and configuration fingerprints. Require the configuration fingerprint to differ when image ID, origin, pinned PostgreSQL reference, run, candidate, or project changes. Prove neither canonical model nor fingerprint input/output contains a canary, its SHA-256, a host path, environment dump, or raw resolved configuration. Classify the committed `compose.test.yaml` password as a public test-only fixture constant: the override replaces it with entropy for execution, and it can appear only in the already-public frozen base-file bytes/hash. Preserve the current fixture canary's reviewed maintenance-only `user: "0:0"` exception; all other candidate services retain the audited `node` runtime user, and neither exception can satisfy release evidence.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run `
  scripts/release-control/compose-config.test.ts `
  scripts/release-control/contracts.test.ts `
  --reporter=verbose
```

Expected: FAIL because configuration normalization and strict release-origin handling are absent.

- [ ] **Step 3: Implement exact validation and canonical fingerprinting**

Expose only safe results:

```ts
export interface SourceIdentity {
  readonly sourceMode: SourceMode;
  readonly sourceClean: boolean;
  readonly sourceRevision: string;
  readonly buildContextSha256: string;
}

export type FrozenComposeFile =
  | {
      readonly role: 'base';
      readonly relativePath: 'compose.prod.yaml' | 'compose.test.yaml';
      readonly sha256: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly role: 'override';
      readonly relativePath: 'plan7a-image.override.yaml';
      readonly sha256: string;
      readonly bytes: Uint8Array;
    };

export interface FrozenRuntimeInput {
  readonly relativePath: 'deploy/Caddyfile';
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export type ExactSecretPresence =
  | {
      readonly topology: 'production';
      readonly names: readonly [
        'database_owner_password', 'database_password',
        'database_worker_password', 'database_storage_cleanup_password',
        'auth_secret', 'smtp_password', 'bootstrap_admin_password'
      ];
    }
  | {
      readonly topology: 'fixture';
      readonly names: readonly ['bootstrap_admin_password'];
    };

export interface ComposeConfigurationEvidence {
  readonly configurationFingerprint: string;
  readonly imageId: string;
  readonly composeProject: string;
  readonly origin: string;
}

export function exactPlan7aImageLabels(source: SourceIdentity): Plan7aImageLabels;
export function exactPlan7aOwnershipLabels(input: {
  readonly runId: string;
  readonly candidateId: string;
  readonly ownershipToken: string;
  readonly composeProject: string;
}): Plan7aOwnedResourceLabels;
export type Plan7aPublicResourceLabels = Pick<
  Plan7aOwnedResourceLabels,
  | 'com.paleorbit.plan7a.run-id'
  | 'com.paleorbit.plan7a.candidate-id'
  | 'com.paleorbit.plan7a.project'
>;
export function validateInspectedCandidateImage(
  inspection: unknown,
  expected: { readonly imageId: string; readonly labels: Plan7aImageLabels }
): void;
export type ComposeTopologyExpectation =
  | {
      readonly profile: 'maintenance_fixture';
      readonly topology: 'production' | 'fixture';
    }
  | {
      readonly profile: 'release_candidate';
      readonly topology: 'production';
      readonly expectedPostgresImage: string;
    };

export type ComposeOverrideTemplate =
  | { readonly profile: 'maintenance_fixture'; readonly topology: 'production' }
  | { readonly profile: 'maintenance_fixture'; readonly topology: 'fixture' }
  | { readonly profile: 'release_candidate'; readonly topology: 'production' };

export function renderImmutableImageOverride(
  input: ComposeOverrideTemplate & {
    readonly publicOwnershipLabels: Plan7aPublicResourceLabels;
  }
): Uint8Array;

export function canonicalizeComposeConfiguration(input: ComposeTopologyExpectation & {
  readonly rawConfigJson: Uint8Array;
  readonly orderedFiles: readonly FrozenComposeFile[];
  readonly orderedRuntimeInputs: readonly FrozenRuntimeInput[];
  readonly projectDirectory: string;
  readonly expectedDockerContext: string;
  readonly expectedProject: string;
  readonly expectedImageId: string;
  readonly expectedOwnershipLabels: Plan7aOwnedResourceLabels;
  readonly expectedOrigin: string;
  readonly secretPresence: ExactSecretPresence;
}): ComposeConfigurationEvidence;
```

Parse into prototype-free bags, validate before redaction, replace each exact secret slot with `{ present: true }`, discard raw input after hashing, and never return the canonical redacted object. Require the four exact ownership labels on every service plus the topology's default network and every named volume; reject a missing/extra/mutated label or a resource carrying labels from another run. After validation, replace the private owner token with a fixed presence token before fingerprinting; the already-evidenced run/candidate/project values remain safe. Parse every resolved service `ORIGIN`: production `app`/`worker`, and fixture `app`, `worker`, `bootstrap-admin`, `migrate`, and `database-role-provision`, must agree byte-for-byte. Validate that value with the profile-specific Task 4 origin parser, require byte equality with `expectedOrigin`, and for fixture require its port to equal the app publication port. Return that authenticated origin. No later lifecycle callback may read the CLI/fixture origin separately: the Task 6 configuration attestation's `evidence.origin` is the sole value used for HTTP behavior and success evidence. `production` requires exactly one runtime input named `deploy/Caddyfile`, materialized below `projectDirectory`; `fixture` requires an empty runtime-input list. Preserve the release PostgreSQL RepoDigest in the safe canonical model and require it to equal `expectedPostgresImage`; never accept the mutable base tag in the release profile. Every generated Compose command includes the explicit frozen project directory. Task 4 remains a pure parser/renderer and imports no Task 6 or candidate-image type; Task 6 supplies runtime authentication in its post-build configuration lease.

- [ ] **Step 4: Prove GREEN and commit**

```powershell
npx vitest run `
  scripts/release-control/canonical-json.test.ts `
  scripts/release-control/contracts.test.ts `
  scripts/release-control/compose-config.test.ts `
  scripts/process-secret-scope.test.ts `
  scripts/storage-process-isolation.test.ts `
  --reporter=verbose
npm run check
git --literal-pathspecs add -- `
  scripts/release-control/compose-config.ts `
  scripts/release-control/compose-config.test.ts `
  scripts/release-control/contracts.ts `
  scripts/release-control/contracts.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: bind immutable smoke configuration"
```

Expected: exact topology/privacy tests pass; existing process/storage boundaries remain green; no Compose file changes.

### Task 4A: Authenticate migration-tip and four-principal database state for every consumer

**Files:**
- Create: `scripts/release-control/database-attestation.ts`
- Create: `scripts/release-control/database-attestation.test.ts`

- [ ] **Step 1: Write frozen-input, live-journal, role, and catalog REDs**

Use fixed frozen bytes and an injected live runtime. The live Drizzle table does not store repository tags or journal indexes: its exact columns are `id`, `hash`, and `created_at`. Strictly parse the complete frozen `_journal.json`, require root `version === "7"`, `dialect === "postgresql"`, indexes `0..15` in order with unique tags/timestamps, and derive the evidence tip from its final entry, whose `breakpoints` must be `true`: index `15`, tag `0015_plan7a_operations_authority`, and `when` `1787812813508`. Require the live row count to equal the frozen journal entry count; row `n` must have integer `id === n + 1`, lowercase 64-hex `hash`, and safe-integer `createdAt` equal to the corresponding frozen journal entry's `when`. Only migration `0015` bytes are in the closed frozen-input registry, so cryptographically correlate the final live row's `hash` to lowercase SHA-256 of those exact bytes and use that digest in evidence; do not pretend to re-hash earlier mutable/unavailable SQL files. Reject a missing, extra, reordered, gapped, stale, uppercase, malformed, wrong-final-hash, or wrong-time row, and reject a journal whose final tag does not select exactly the supplied `0015` bytes.

Require exactly four named purposes (`owner`, `web`, `worker`, `storageCleanup`), four nonempty configured login names, four pairwise-distinct `current_user` results equal to those names, and the exact approved membership/NOINHERIT relationships. Parse the frozen verifier, require exactly one `plan7a-database-catalog-v1` marker and 323 descriptor tuples, hash those exact bytes, and accept live verifier output only when every enforcing violation is zero; preserve the five documented operational diagnostic counts as non-enforcing.

```ts
export interface DatabasePrincipalExpectation {
  readonly owner: string;
  readonly web: string;
  readonly worker: string;
  readonly storageCleanup: string;
}

export interface LiveMigrationJournalRow {
  readonly id: number;
  readonly hash: string;
  readonly createdAt: number;
}

export const DRIZZLE_MIGRATION_JOURNAL_COPY_SQL =
  'copy (select id, hash, created_at from drizzle.__drizzle_migrations ' +
  'order by id) to stdout with (format csv, header true)';

export interface LivePrincipalObservation {
  readonly purpose: keyof DatabasePrincipalExpectation;
  readonly currentUser: string;
  readonly canLogin: boolean;
  readonly inheritsPrivileges: boolean;
  readonly memberships: readonly string[];
}

export type DatabaseObservationRole = 'maintenance' | 'source' | 'rehearsal';

export interface DatabaseAttestationScope<Role extends DatabaseObservationRole> {
  readonly capability: 'plan7a-database-attestation-scope-v1';
  readonly role: Role;
  // A module-private unique-symbol field plus runtime registry binds identity.
}

export function createDatabaseAttestationScope<Role extends DatabaseObservationRole>(
  role: Role
): DatabaseAttestationScope<Role>;

export interface DatabaseAttestationRuntime {
  readMigrationJournal(): Promise<Uint8Array>;
  inspectPrincipals(
    expected: DatabasePrincipalExpectation
  ): Promise<readonly LivePrincipalObservation[]>;
  runCatalogVerifier(verifierSql: Uint8Array): Promise<unknown>;
}

export interface AuthenticatedDatabaseState<Role extends DatabaseObservationRole> {
  readonly capability: 'plan7a-authenticated-database-state-v1';
  readonly role: Role;
  readonly scope: DatabaseAttestationScope<Role>;
  readonly migrationTip: MigrationTipEvidence;
  readonly databaseRoleAttestation: DatabaseRoleAttestation;
  readonly catalogResult: 'verified';
  readonly replacementDisposition: 'clear' | 'blocked';
  // A module-private unique-symbol field plus runtime registry binds the safe
  // fields to the exact live observation.
}

export async function authenticateDatabaseState<Role extends DatabaseObservationRole>(input: {
  readonly scope: DatabaseAttestationScope<Role>;
  readonly drizzleJournal: Uint8Array;
  readonly migrationTipSql: Uint8Array;
  readonly financialRestoreVerifierSql: Uint8Array;
  readonly principals: DatabasePrincipalExpectation;
  readonly runtime: DatabaseAttestationRuntime;
}): Promise<AuthenticatedDatabaseState<Role>>;

export interface ResolvedAuthenticatedDatabaseState<
  Role extends DatabaseObservationRole
> {
  readonly role: Role;
  readonly scope: DatabaseAttestationScope<Role>;
  readonly migrationTip: MigrationTipEvidence;
  readonly databaseRoleAttestation: DatabaseRoleAttestation;
  readonly catalogResult: 'verified';
  readonly replacementDisposition: 'clear' | 'blocked';
}

export function resolveAuthenticatedDatabaseState<
  Role extends DatabaseObservationRole
>(
  state: AuthenticatedDatabaseState<Role>
): ResolvedAuthenticatedDatabaseState<Role>;
```

The runtime returns raw boundary data only to this module; the returned object exposes only the capability discriminator, safe role discriminator, opaque scope, two safe evidence records, `catalogResult`, and derived replacement disposition—no login names, SQL, rows, diagnostic counts, paths, or credentials. Its adapter executes only `DRIZZLE_MIGRATION_JOURNAL_COPY_SQL`; this module strict-parses exact UTF-8 CSV header `id,hash,created_at` into the camel-case boundary type and never fabricates repository-only `index`, `tag`, `when`, or `sha256` columns. Tasks 10/11 replace both current `select * from drizzle.__drizzle_migrations` strings with this shared explicit-column constant, and a static RED forbids the `select *` form. Parse the canonical five-row operational-diagnostics result here, require each documented row exactly once with a nonnegative safe integer, and derive `clear` only when all five are zero; otherwise derive `blocked`. A caller cannot submit either result as a literal. Every role-keyed scope is single-use: `authenticateDatabaseState` atomically consumes it before the first live query, permanently rejects a second call even after failure, and binds the sole successful complete observation by object identity. `resolveAuthenticatedDatabaseState` is the only owner-side authenticity check; it rejects structural/spread/proxy/serialized values before returning a frozen safe view. Task 6 creates a fresh scope only as part of a new immutable manifest. Every downstream constructor directly imports and calls the resolver before reading a field, comparing scope identity, invoking a dependency, or issuing a command; wrong scope/observation and same-run source/rehearsal swaps fail closed. Tests cover concurrent double-consumption and failure-after-consumption, structural/cross-observation resolver rejection, wrong journal version/dialect/final breakpoint, invalid UTF-8, and exact real 16-row CSV shape.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run scripts/release-control/database-attestation.test.ts --reporter=verbose
```

Expected: FAIL because the shared attestation owner does not exist.

- [ ] **Step 3: Implement strict pure parsers plus the injected live adapter boundary**

Use `sha256Bytes` for exact frozen file bytes only after independently validating the migration/journal/verifier shapes; never serialize a `Uint8Array` as canonical JSON. Keep Docker/Compose/SQL execution outside the module; consumers adapt their already authenticated Compose executor to the three narrow runtime methods. Do not import a smoke consumer or deployment checkpoint. Static dependency tests permit `createDatabaseAttestationScope` to be called only by `owned-compose.ts`; Task 6 stores the exact returned scope in the immutable manifest capability, so every consumer authenticates its live database observation against an owner-minted run scope rather than a caller-created token.

- [ ] **Step 4: Prove GREEN and commit**

```powershell
npx vitest run `
  scripts/release-control/database-attestation.test.ts `
  scripts/commerce-operations.test.ts `
  scripts/financial-schema-preservation.test.ts `
  scripts/database-role-deployment.test.ts `
  --maxWorkers=1 --reporter=verbose
npm run check
git --literal-pathspecs add -- `
  scripts/release-control/database-attestation.ts `
  scripts/release-control/database-attestation.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: authenticate smoke database state"
```

## Milestone B - bounded commands and exact owned lifecycle

### Task 5: Add bounded command, environment, and published-loopback runtimes

**Files:**
- Create: `scripts/release-control/command-runtime.ts`
- Create: `scripts/release-control/command-runtime.test.ts`
- Reference: `scripts/financial-restore-witness-harness.ts`
- Reference: `scripts/plan6b-production-smoke.ts`

- [ ] **Step 1: Write command lifecycle REDs**

With an injected child-process adapter beneath the real Task 5 factory, require no shell, exact argv/environment/cwd, bounded input/output, one timeout, caller abort, graceful termination followed by forced termination after a bounded grace, close acknowledgement, and per-child listener removal. The factory synchronously installs exactly one process-level SIGINT listener and one SIGTERM listener for the whole run. The first signal wins, latches an opaque `AbortSignal` until disposal, terminates every active domain child, rejects a future domain/publication command before spawn, and remains observable between commands and during filesystem work. Its separate cleanup path ignores the latched or later SIGINT/SIGTERM and caller abort so authoritative cleanup cannot be suppressed, while retaining the same timeout, output, termination-grace, spawn-error, and close bounds. Cover signal-before-spawn, signal-during-child, signals between commands, repeated signals during cleanup, nonzero status, timeout, interrupted close, output overflow, abort-versus-timeout races, a child that exits during termination, and an interrupted Windows creation followed by cleanup through that exact owner. Signal-specific detail stays private; the public code is only `interrupted`.

In the same tests, require `createSupervisedGitSnapshotRuntime` to authenticate the supervisor and the exact environment-source/`host-tools` pair, pin executable `git`, `shell: false`, exact canonical repository-root `cwd`, empty stdin, a 60-second timeout, 5-second termination grace, 16 MiB text-output or 64 MiB blob-output limit, and 64 KiB stderr limit. It passes only the Task 3-supplied argv, decodes `captureText` with strict UTF-8, returns defensive raw bytes from `captureBytes`, and never exposes stderr. Signal-before-Git opens no child; signal-during-Git follows the same acknowledged termination path; timeout/output/nonzero/spawn failure maps safely. A structural supervisor or structural/genuine-cross-source environment pair fails before spawn; the factory privately closes over and later uses that exact source/environment/supervisor/root tuple, with no caller-supplied command owner at capture time. Task 3 tests continue injecting only an in-memory `GitSnapshotRuntime`; every smoke consumer's no-dependency path must use this real factory.

Also test the sole command-environment source/builder pair: the source snapshots an injected host environment and platform exactly once, copies only a closed platform base set into an opaque immutable capability, and never rereads ambient state. The builder later overlays only a complete closed scope-specific slot type when those values exist. Reject missing discovery keys, Windows case-colliding keys, NULs, nonstrings, unknown overlay keys, structural or cross-source capabilities, and cross-scope environments, and never format or log values. Ambient Compose/service/secret variables are ignored unless explicitly present in the selected typed overlay. `assertReleaseControlHostToolsEnvironmentAssociation` authenticates an exact source/`host-tools` pair for Task 5A; `assertReleaseControlCommandEnvironmentAssociation` authenticates a scoped/`host-tools` pair. Both are owner-side WeakMap checks, expose no values, and reject spread/proxy/serialized or genuine cross-source pairs.

In the same inward leaf, move the existing production smoke TCP/UDP loopback lease algorithm behind an injected `ReleaseControlPortRuntime`. REDs require `attestCoordinatorPublishedLoopbackContext` to run exact bounded `docker --context <context> context inspect --format '{{json .Endpoints.docker.Host}}' <context>` and `docker --context <context> info --format '{{json .ID}}'` requests through the authentic supplied command supervisor/`host-tools` environment, accept only one strict JSON string containing a canonical local `unix://` endpoint on POSIX or `npipe://` endpoint on Windows, and bind the exact context, endpoint, platform, and observed engine ID in the returned operations-owned capability. Reject SSH/TCP/HTTP, empty/multiple/malformed output, platform/scheme mismatch, an unsafe context/engine, expected-engine mismatch, structural/cross-factory capabilities, and endpoint or engine drift. Rejection happens before any socket lease. Allocation tests pin one TCP allocation for HTTP, one same-port TCP+UDP allocation for HTTPS, exclusion handling, exactly 32 bounded attempts, lease closure on every branch, no 33rd attempt, and a fixed safe exhaustion error. Probe tests re-attest the exact context/endpoint/engine before leasing the exact requested TCP or TCP+UDP port. All owner tests use a real supervisor over a fake process adapter plus fake socket runtime and open no child, socket, or network connection.

Contract-test both public Node adapter factories in this same RED/GREEN task rather than deferring their behavior to Task 17. Each focused test calls `vi.resetModules()`, installs `vi.doMock(...)` replacements for the applicable Node built-ins, and dynamically imports `command-runtime.ts`, so it invokes the actual no-argument public factory while opening no real child or socket. For `createNodeCommandProcessAdapter`, drive a mocked child with fake stdin/stdout/stderr and process events and require exact `spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })`, defensive argv/environment handling, input write/backpressure/drain/end acknowledgement, byte-event forwarding and listener removal, one graceful termination request, forced termination when requested, and one close-or-spawn-error settlement. For `createNodeReleaseControlPortRuntime`, mock `node:crypto.randomInt`, `node:net`, and `node:dgram` and require exact inclusive-minimum/exclusive-maximum forwarding, TCP and UDP4 binds only to `127.0.0.1` at the supplied port with exclusive ownership, rejection on bind error, resolution only after listening, idempotent close acknowledgement, and listener removal on every success/failure branch. Static tests additionally pin those imports and prohibit a second Node process/socket adapter.

```ts
await expect(runtime.run({
  executable: 'docker',
  args: ['compose', 'config', '--format', 'json'],
  environment: safeEnvironment,
  timeoutMs: 30_000,
  terminationGraceMs: 5_000,
  stdoutLimitBytes: 16 * 1024 * 1024,
  stderrLimitBytes: 64 * 1024
})).resolves.toEqual({
  status: 0,
  stdout: new TextEncoder().encode('{}\n'),
  stderr: new Uint8Array()
});
```

Require errors to expose only one of `required_stage_failed`, `timeout`, `interrupted`, `ownership_mismatch`, `configuration_mismatch`, `cleanup_failed`, or `unexpected_failure`; raw captured data and child errors remain private.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run scripts/release-control/command-runtime.test.ts --reporter=verbose
```

Expected: FAIL because the command/environment runtime and shared authenticated port owner are missing.

- [ ] **Step 3: Implement from the proven restore-harness termination pattern**

Use `spawn`, explicit stream byte counters, one private `AbortController` for the run latch, one close promise per child, and platform-specific termination only behind an injected adapter. Do not copy the restore harness's domain-specific Docker ownership or output text. The supervisor is factory-created and WeakMap-authenticated; tests inject only `CommandProcessAdapter`, never a structural command supervisor. Process listeners live from factory return through the success commit or completed failure handling. `dispose()` removes them once, is idempotent, returns the same completion on repeated calls, and never rejects or changes an already selected terminal result.

```ts
export interface BoundedCommandRequest<
  Scope extends ReleaseControlCommandScope = ReleaseControlCommandScope
> {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment: ReleaseControlCommandEnvironment<Scope>;
  readonly input?: Uint8Array;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
}

export type ReleaseControlCommandScope =
  | 'host-tools'
  | 'production-compose'
  | 'fixture-compose'
  | 'checkpoint-compose';

export const PRODUCTION_COMPOSE_SLOT_NAMES = [
  'APP_IMAGE', 'AUTH_EMAIL_RATE_LIMIT_MAX', 'AUTH_LOGIN_RATE_LIMIT_MAX',
  'AUTH_MAGIC_EXPIRES_SECONDS', 'AUTH_RATE_LIMIT_MAX',
  'AUTH_RATE_LIMIT_WINDOW_SECONDS', 'AUTH_RESET_EXPIRES_SECONDS',
  'AUTH_SESSION_EXPIRES_SECONDS', 'AUTH_VERIFICATION_EXPIRES_SECONDS',
  'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_NAME', 'CADDY_CPU_LIMIT',
  'CADDY_MEMORY_LIMIT', 'COMMERCE_CHECKOUT_RATE_LIMIT_MAX',
  'COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS',
  'COMPOSE_DEFAULT_NETWORK_INTERNAL', 'DATABASE_NAME', 'DATABASE_OWNER_USER',
  'DATABASE_STORAGE_CLEANUP_USER', 'DATABASE_USER', 'DATABASE_WORKER_USER',
  'HTTP_BIND_ADDRESS', 'HTTP_PORT', 'HTTPS_BIND_ADDRESS', 'HTTPS_PORT',
  'INGEST_MAX_COMPRESSION_RATIO', 'INGEST_MAX_ENTRIES',
  'INGEST_MAX_EXPANDED_BYTES', 'INGEST_MAX_IMAGE_PIXELS',
  'INGEST_MAX_XML_BYTES', 'INGEST_TIMEOUT_MS', 'ORIGIN',
  'POSTGRES_CPU_LIMIT', 'POSTGRES_DB', 'POSTGRES_IMAGE',
  'POSTGRES_MEMORY_LIMIT', 'POSTGRES_USER', 'SITE_ADDRESS',
  'SMTP_CONNECTION_TIMEOUT_MS', 'SMTP_FROM', 'SMTP_GREETING_TIMEOUT_MS',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_REQUIRE_TLS', 'SMTP_SECURE',
  'SMTP_SOCKET_TIMEOUT_MS', 'SMTP_USER', 'STORAGE_ORPHAN_RETENTION_HOURS',
  'STORAGE_PROVIDER', 'STORAGE_STAGING_RETENTION_HOURS',
  'STRIPE_AUTOMATIC_TAX_ENABLED', 'STRIPE_CHECKOUT_DURATION_SECONDS',
  'STRIPE_TAX_CODE_COMIC', 'STRIPE_TAX_CODE_PROSE',
  'STRIPE_WEBHOOK_TOLERANCE_SECONDS', 'UPLOAD_MAX_BYTES', 'WEB_CPU_LIMIT',
  'WEB_MEMORY_LIMIT', 'WORKER_CONCURRENCY', 'WORKER_CPU_LIMIT',
  'WORKER_HEARTBEAT_INTERVAL_MS', 'WORKER_HEARTBEAT_MAX_AGE_MS',
  'WORKER_MEMORY_LIMIT', 'PLAN7A_DATABASE_OWNER_PASSWORD_FILE',
  'PLAN7A_DATABASE_PASSWORD_FILE', 'PLAN7A_DATABASE_WORKER_PASSWORD_FILE',
  'PLAN7A_DATABASE_STORAGE_CLEANUP_PASSWORD_FILE',
  'PLAN7A_AUTH_SECRET_FILE', 'PLAN7A_SMTP_PASSWORD_FILE',
  'PLAN7A_BOOTSTRAP_ADMIN_PASSWORD_FILE', 'PLAN7A_OWNERSHIP_TOKEN'
] as const;

export const FIXTURE_COMPOSE_SLOT_NAMES = [
  'APP_IMAGE', 'AUTH_SECRET', 'DATABASE_OWNER_PASSWORD', 'DATABASE_PASSWORD',
  'DATABASE_STORAGE_CLEANUP_PASSWORD', 'DATABASE_WORKER_PASSWORD', 'ORIGIN',
  'PLAN7A_BOOTSTRAP_ADMIN_PASSWORD_FILE', 'PLAN7A_FIXTURE_DATABASE_PORT',
  'PLAN7A_FIXTURE_WEB_PORT', 'PLAN7A_OWNERSHIP_TOKEN', 'POSTGRES_DB',
  'POSTGRES_USER'
] as const;

type ProductionComposeSlotName = typeof PRODUCTION_COMPOSE_SLOT_NAMES[number];
type FixtureComposeSlotName = typeof FIXTURE_COMPOSE_SLOT_NAMES[number];

export interface ReleaseControlCommandSlotsByScope {
  readonly 'host-tools': Readonly<Record<string, never>>;
  readonly 'production-compose': Readonly<Record<ProductionComposeSlotName, string>>;
  readonly 'fixture-compose': Readonly<Record<FixtureComposeSlotName, string>>;
  readonly 'checkpoint-compose': Readonly<Record<ProductionComposeSlotName, string>>;
}

export class ReleaseControlCommandEnvironment<
  Scope extends ReleaseControlCommandScope
> {
  private constructor();
  private readonly scopeBrand: Scope;
  readonly scope: Scope;
  // The real private field makes different scopes non-assignable.
  // Opaque immutable allowlisted mapping; only this module unwraps it for spawn.
}

export class ReleaseControlCommandEnvironmentSource {
  private constructor();
  private readonly sourceBrand: unknown;
  readonly platform: 'posix' | 'win32';
  // Opaque immutable platform/discovery snapshot; no public mapping getter.
}

export interface ReleaseControlCommandEnvironmentSourceInput {
  readonly platform: 'posix' | 'win32';
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
}

export function createReleaseControlCommandEnvironmentSource(
  input: ReleaseControlCommandEnvironmentSourceInput
): ReleaseControlCommandEnvironmentSource;

export function createReleaseControlCommandEnvironment<
  Scope extends ReleaseControlCommandScope
>(input: {
  readonly source: ReleaseControlCommandEnvironmentSource;
  readonly scope: Scope;
  readonly slots: ReleaseControlCommandSlotsByScope[Scope];
}): ReleaseControlCommandEnvironment<Scope>;

export function assertReleaseControlCommandEnvironmentAssociation<
  Scope extends Exclude<ReleaseControlCommandScope, 'host-tools'>
>(input: {
  readonly hostTools: ReleaseControlCommandEnvironment<'host-tools'>;
  readonly scoped: ReleaseControlCommandEnvironment<Scope>;
}): void;

export function assertReleaseControlHostToolsEnvironmentAssociation(input: {
  readonly source: ReleaseControlCommandEnvironmentSource;
  readonly hostTools: ReleaseControlCommandEnvironment<'host-tools'>;
}): void;

export interface ReleaseControlPortLease {
  readonly port: number;
  close(): Promise<void>;
}

export interface ReleaseControlPortRuntime {
  readonly randomInteger: (minimum: number, maximumExclusive: number) => number;
  readonly leaseTcpLoopback: (port: number) => Promise<ReleaseControlPortLease>;
  readonly leaseUdpLoopback: (port: number) => Promise<ReleaseControlPortLease>;
}

export interface CoordinatorPublishedLoopbackContext {
  readonly dockerContext: string;
  readonly dockerEngineId: DockerEngineId;
}

export interface ReleaseControlPortOperations {
  attestCoordinatorPublishedLoopbackContext(input: {
    readonly dockerContext: string;
    readonly expectedEngineId?: DockerEngineId;
    readonly platform: 'posix' | 'win32';
    readonly commands: ReleaseControlCommandSupervisor;
    readonly hostToolsEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
  }): Promise<CoordinatorPublishedLoopbackContext>;
  allocateLoopbackPort(
    context: CoordinatorPublishedLoopbackContext,
    requireUdp?: boolean,
    excludedPort?: number
  ): Promise<number>;
  probeLoopbackPort(
    context: CoordinatorPublishedLoopbackContext,
    host: '127.0.0.1',
    port: number,
    requireUdp?: boolean
  ): Promise<void>;
}

export function createReleaseControlPortOperations(
  runtime: ReleaseControlPortRuntime
): ReleaseControlPortOperations;

export function createNodeReleaseControlPortRuntime(): ReleaseControlPortRuntime;

export function selectMaintenanceDockerContext(
  hostEnvironment: Readonly<Record<string, string | undefined>>
): string;

export interface BoundedCommandResult {
  readonly status: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface SpawnedCommand {
  writeInput(bytes: Uint8Array): Promise<void>;
  closeInput(): Promise<void>;
  onStdout(listener: (bytes: Uint8Array) => void): () => void;
  onStderr(listener: (bytes: Uint8Array) => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
  onClose(listener: (status: number | null, signal: string | null) => void): () => void;
}

export interface CommandProcessAdapter {
  spawn<Scope extends ReleaseControlCommandScope>(
    request: BoundedCommandRequest<Scope>
  ): SpawnedCommand;
  terminate(child: SpawnedCommand, force: boolean): Promise<void>;
  onSignal(signal: 'SIGINT' | 'SIGTERM', listener: () => void): () => void;
}

export interface ReleaseControlInterruption {
  readonly signal: AbortSignal;
  // Opaque Task 5 brand; the signal is informational, not independently mintable.
}

export interface ReleaseControlCommandSupervisor {
  readonly interruption: ReleaseControlInterruption;
  run<Scope extends ReleaseControlCommandScope>(
    request: BoundedCommandRequest<Scope>,
    callerSignal?: AbortSignal
  ): Promise<BoundedCommandResult>;
  runCleanup<Scope extends ReleaseControlCommandScope>(
    request: BoundedCommandRequest<Scope>
  ): Promise<BoundedCommandResult>;
  assertUninterrupted(): void;
  awaitPublicationBoundary<T>(operation: () => Promise<T>): Promise<T>;
  commitSuccessAfterPublicationBoundary<T>(
    finalBoundary: () => Promise<void>,
    commit: () => T
  ): Promise<T>;
  dispose(): Promise<void>;
}

export function createReleaseControlCommandSupervisor(
  adapter: CommandProcessAdapter
): ReleaseControlCommandSupervisor;

export function createNodeCommandProcessAdapter(): CommandProcessAdapter;

export function createSupervisedGitSnapshotRuntime(input: {
  readonly repositoryRoot: string;
  readonly environmentSource: ReleaseControlCommandEnvironmentSource;
  readonly commands: ReleaseControlCommandSupervisor;
  readonly hostToolsEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
}): GitSnapshotRuntime;

export function assertReleaseControlCommandSupervisor(
  supervisor: ReleaseControlCommandSupervisor
): void;

export class SmokeCommandError extends Error {
  readonly code: SmokeFailedCode;
}
```

The real command adapter uses `windowsHide: true`, `shell: false`, and no inherited stdio or ambient environment. The exact POSIX base keys are `PATH`, `HOME`, `DOCKER_CONFIG`, `DOCKER_HOST`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, and `XDG_RUNTIME_DIR`; the exact Windows keys after case-insensitive normalization are `Path`, `SystemRoot`, `PATHEXT`, `USERPROFILE`, `DOCKER_CONFIG`, `DOCKER_HOST`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, `TEMP`, and `TMP`. `PATH` is required on POSIX; `Path` and `SystemRoot` are required on Windows. Optional base keys are copied only when nonempty. The constructor stores a private phantom scope brand as well as the read-only discriminator, and tests prove that a forged object and every cross-scope environment are rejected at runtime in addition to being non-assignable in TypeScript. Maintenance composition roots call `selectMaintenanceDockerContext` once: it accepts an absent value as exact `default` or a nonempty canonical context name, then every child argv carries that explicit context. `DOCKER_CONTEXT` is consumed only at that outer selection seam and is always omitted from every child environment. The three non-host scopes accept only their explicit constant tuple of variable names already consumed by the corresponding frozen Compose/checkpoint topology; tests pin those tuples against `compose.prod.yaml`, `compose.test.yaml`, and the checkpoint environment builder, and reject any extra or cross-topology slot. Values remain private in the opaque object. The supervisor returns defensive byte copies; JSON consumers use `parseStrictJsonBytes`, and bounded text consumers use `decodeStrictUtf8`, so invalid UTF-8 is never silently replaced before validation.

`createReleaseControlCommandSupervisor` is the only injected process-construction seam; `createNodeCommandProcessAdapter` is the real default adapter. The supervisor WeakMap owns the exact adapter, interruption capability, listener removers, active domain children, cleanup/publication phase, and disposal completion. `run()` checks the sticky latch before spawn and after close, combines only that domain command with an optional caller signal, and rejects safely on interruption. `runCleanup()` never accepts a caller signal and is not terminated by process signals; it is reserved for shutdown, cleanup, rollback, and absence reattestation. `awaitPublicationBoundary()` authenticates the supervisor and checks the latch immediately before and after the supplied async operation without abandoning it in flight. `commitSuccessAfterPublicationBoundary()` performs the same precheck, awaits the final partial-file removal, checks the latch in its promise continuation, calls the fixed module-private synchronous/no-throw commit closure in that same continuation with no intervening await/allocation/logger/validation, records `successCommitted`, and only then resolves. Signals observed after that linearization point do not retroactively change success. `createSupervisedGitSnapshotRuntime` is the sole real `GitSnapshotRuntime`; it authenticates the exact source/`host-tools` pair and supervisor, closes over that tuple plus the canonical root, and translates Task 3's two narrow capture methods into the fixed bounded requests above without a second listener or child-process implementation. Only `evidence.ts` may call the two publication helpers, and only cleanup/rollback owners may call `runCleanup()`; static tests enforce all restrictions.

The port owner uses those same strict byte parsers for the two inspection commands, calls Task 2's `parseDockerEngineId` exactly once on each observation, and holds a private WeakMap entry for every `CoordinatorPublishedLoopbackContext`; its safe public fields are informational, not independently authorizing. The returned `dockerEngineId` is that exact branded parse result, so Task 6 consumes it without a cast or reparse. The accepted endpoint grammar is an absolute local `unix:///...` socket on POSIX or canonical local `npipe:////./pipe/<safe-name>` on Windows. Context names, engine IDs, endpoint strings, and socket errors never enter public evidence or logs. `allocateLoopbackPort` and `probeLoopbackPort` first resolve the exact same-factory capability. Allocation uses the moved existing 32-attempt TCP/TCP+UDP algorithm; probe repeats both context observations, parses the new engine observation once, and requires exact private endpoint/engine equality before touching coordinator loopback. `createNodeReleaseControlPortRuntime` wires only the existing Node TCP/UDP/random primitives and performs no I/O until a lease method is called. Each composition root directly calls `createReleaseControlPortOperations(dependencies.portRuntime)` once before lifecycle entry and stores that exact owner; only the low-level runtime is injectable. A structural high-level operations object or caller-minted context can therefore never replace Task 5's parser/WeakMap/re-attestation owner. A remote daemon may satisfy shared-path attestation while having a different published-port namespace, so every consumer that publishes a host loopback port must obtain this local-context capability before allocation; no consumer infers locality from a context name, engine ID, or successful bind-root probe. The preserved rehearsal starts only PostgreSQL and `app`, never Caddy, and therefore consumes the configured port values but does not claim or probe a published-port bind.

- [ ] **Step 4: Prove GREEN and commit**

```powershell
npx vitest run scripts/release-control/command-runtime.test.ts --reporter=verbose
npm run check
git --literal-pathspecs add -- `
  scripts/release-control/command-runtime.ts `
  scripts/release-control/command-runtime.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: supervise bounded smoke commands"
```

### Task 5A: Create one platform-private root and file lease

**Files:**
- Create: `scripts/release-control/restricted-path.ts`
- Create: `scripts/release-control/restricted-path.test.ts`

- [ ] **Step 1: Write POSIX mode, Windows DACL, containment, and ownership REDs**

Use an injected low-level filesystem/current-identity host runtime and an authentic Task 5 supervisor created over a fake process adapter. Require an absolute caller-selected non-existing target or an unpredictable child of an exact canonical parent; reject repository-contained targets, parent/root symlinks or Windows reparse points, `..`, drive/UNC aliasing, case-colliding relative paths, pre-existing entries, path replacement, and a root whose device/inode or Windows file identity changes. Reject a structural dependency object, a host-tools environment from another source, a supervisor from another dependency capability, or a genuine dependency/supervisor cross-pair before filesystem or command work.

On POSIX, atomically create directories owner-only, files with `wx`, and verify current uid plus exact `0700`/`0600` after every creation and before read/link/remove. On Windows, require one fixed noninteractive PowerShell/.NET ACL adapter invoked through the exact `ReleaseControlCommandSupervisor`: create the root with a protected DACL, current-user SID as owner, and exactly two explicit inheritable FullControl allow ACEs in canonical SID order—for that SID and `S-1-5-18` (`SYSTEM`). Every child directory and file is immediately converted, before acknowledgement or use, to a protected DACL with exactly the same two explicit allow ACEs; directory ACEs are container/object inheritable, while file ACEs have no inheritance flags. Reject every inherited, deny, unknown-principal, non-FullControl, wrong-flag, duplicate, or reordered semantic ACE set and any reparse point. This deliberately avoids treating ordinary inherited child ACEs as a valid final state. A failed ACL command, localized/free-form output, path echo, timeout, or unverifiable identity fails closed and is never logged/evidenced.

Require lifecycle tests for exclusive open/write/file-sync/close as one operation, bounded reads, nested directory creation, exact stable entry enumeration, stable streaming hashing, reservation of a Docker-truncated IID/archive, expectation then adoption of a helper-created artifact, no-clobber hard linking within one root/filesystem, directory sync, same-identity rollback, two-phase retain versus remove finalization, idempotent matching finalization, conflicting finalization, partial creation, and cleanup after every injected failure. At every creation/publication boundary, inject a signal through the authentic supervisor's fake adapter, let the in-flight operation settle, and prove the same supervisor can still remove/reattest all owned entries through its cleanup path; a structural or cross-supervisor dependency fails before the operation. Reservation creates the regular file with `wx` and the final private ACL/mode before Docker runs; adoption accepts only in-place truncate/write of that exact identity. Expectation records a still-absent path beneath the already private root; after the trusted helper closes, adoption opens it without following links and makes/verifies it private before any read. Tests replace the path, inode/file ID, owner, mode/DACL, link count, size, and modification identity at every boundary and require rejection. POSIX directory sync uses an opened directory descriptor. Windows uses a second fixed PowerShell/.NET adapter whose exact native call is `CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_WRITE_THROUGH, null)`, followed by `FlushFileBuffers` and `CloseHandle`. It returns one strict numeric result/error-code schema. Unsupported access, filesystem, or flush behavior fails publication rather than pretending durability. A real-filesystem platform witness creates one private temporary root and file, rejects a link/reparse substitution, flushes the file and directory, removes both, and proves absence before any expensive Task 17 Docker gate.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run `
  scripts/release-control/command-runtime.test.ts `
  scripts/release-control/restricted-path.test.ts `
  --reporter=verbose
```

Expected: FAIL because the shared private-path lease does not exist.

- [ ] **Step 3: Implement the one reusable lease**

```ts
export interface RestrictedPathLease {
  readonly root: string;
  readonly ownershipToken: string;
  readonly containerWritePolicy:
    | { readonly platform: 'posix'; readonly uid: number; readonly gid: number }
    | { readonly platform: 'win32' };
  createDirectory(relativePath: string): Promise<void>;
  writeExclusiveSynced(relativePath: string, bytes: Uint8Array): Promise<void>;
  reserveExternalFile(relativePath: string): Promise<ExternalFileReservation>;
  expectExternalFile(relativePath: string): Promise<ExternalFileReservation>;
  adoptExternalFile(
    reservation: ExternalFileReservation,
    maxBytes: number
  ): Promise<OwnedFileSnapshot>;
  listStableFiles(): Promise<readonly OwnedDirectoryEntry[]>;
  hashOwnedFile(relativePath: string, maxBytes: number): Promise<OwnedFileSnapshot>;
  readOwnedFile(relativePath: string, maxBytes: number): Promise<Uint8Array>;
  assertOwnedRegularFile(relativePath: string, maxBytes: number): Promise<void>;
  linkNoClobber(sourceRelativePath: string, targetRelativePath: string): Promise<void>;
  syncRoot(): Promise<void>;
  removeOwnedFile(relativePath: string): Promise<void>;
  prepareRetention(): Promise<PreparedRestrictedPathRetention>;
  remove(): Promise<void>;
}

export interface PreparedRestrictedPathRetention {
  commit(): void;
  rollback(): Promise<void>;
}

export interface RestrictedBindProbeInvocation {
  readonly capability: 'plan7a-restricted-bind-invocation-v1';
  readonly phase: 'read-challenge' | 'write-reply';
  readonly dockerRunArgsAfterOwnership: readonly string[];
  readonly timeoutMs: number;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
  // Runtime-branded, non-authorizing argv suffix: no context, name, or labels.
}

export interface VerifiedRestrictedBindObservation {
  readonly capability: 'plan7a-verified-bind-observation-v1';
  // Non-authorizing Task 5A result; Task 6 privately binds it to its own launch.
}

export interface PreparedRestrictedDockerBindProbe {
  readonly capability: 'plan7a-prepared-docker-bind-probe-v1';
  readonly lease: RestrictedPathLease;
  readonly dockerContext: string;
  readonly dockerEngineId: DockerEngineId;
  readonly imageId: string;
  readonly access: 'read-only' | 'read-write';
  readonly dockerUserArgs: readonly [] | readonly ['--user', `${number}:${number}`];
  readonly readOnlyInvocation: RestrictedBindProbeInvocation;
  readonly readWriteInvocation?: RestrictedBindProbeInvocation;
  rollback(): Promise<void>;
  // Contains mount/nonce commands but no container name or ownership labels.
}

export async function verifyRestrictedDockerBindObservations(input: {
  readonly prepared: PreparedRestrictedDockerBindProbe;
  readonly observations: readonly BoundedCommandResult[];
}): Promise<VerifiedRestrictedBindObservation>;

export interface RestrictedPathReader {
  readonly root: string;
  listStableFiles(): Promise<readonly OwnedDirectoryEntry[]>;
  hashOwnedFile(relativePath: string, maxBytes: number): Promise<OwnedFileSnapshot>;
  readOwnedFile(relativePath: string, maxBytes: number): Promise<Uint8Array>;
}

export interface ExternalFileReservation {
  readonly path: string;
  readonly relativePath: string;
  // Accepted only when returned by this live lease; a structural lookalike fails.
}

export interface OwnedDirectoryEntry {
  readonly name: string;
  readonly kind: 'file';
  readonly byteLength: number;
}

export interface OwnedFileSnapshot {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface RestrictedPathIdentity {
  readonly platform: 'posix' | 'win32';
  readonly canonicalPath: string;
  readonly entryKind: 'directory' | 'regular-file';
  readonly fileSystemIdentity: string;
  readonly ownerIdentity: string;
  readonly policyFingerprint: string;
  readonly linkCount: number;
}

export type RestrictedHostIdentity =
  | { readonly platform: 'posix'; readonly uid: number; readonly gid: number }
  | { readonly platform: 'win32'; readonly sid: string };

export interface RestrictedPathFileSystem {
  canonicalize(path: string): Promise<string>;
  inspectNoFollow(path: string): Promise<RestrictedPathIdentity | undefined>;
  createRootExclusive(path: string): Promise<RestrictedPathIdentity>;
  createDirectoryExclusive(
    root: RestrictedPathIdentity,
    relativePath: string
  ): Promise<RestrictedPathIdentity>;
  writeFileExclusiveSynced(
    root: RestrictedPathIdentity,
    relativePath: string,
    bytes: Uint8Array
  ): Promise<RestrictedPathIdentity>;
  reserveFileExclusive(
    root: RestrictedPathIdentity,
    relativePath: string
  ): Promise<RestrictedPathIdentity>;
  hardenExpectedFile(
    root: RestrictedPathIdentity,
    relativePath: string
  ): Promise<RestrictedPathIdentity>;
  inspectStableFiles(root: RestrictedPathIdentity): Promise<readonly OwnedDirectoryEntry[]>;
  readFileStable(
    root: RestrictedPathIdentity,
    relativePath: string,
    maxBytes: number
  ): Promise<Uint8Array>;
  hashFileStable(
    root: RestrictedPathIdentity,
    relativePath: string,
    maxBytes: number
  ): Promise<OwnedFileSnapshot>;
  linkNoClobber(
    root: RestrictedPathIdentity,
    sourceRelativePath: string,
    targetRelativePath: string
  ): Promise<void>;
  syncDirectory(root: RestrictedPathIdentity): Promise<void>;
  removeEntry(root: RestrictedPathIdentity, relativePath: string): Promise<void>;
  removeRoot(root: RestrictedPathIdentity): Promise<void>;
}

export interface RestrictedPathHostRuntime {
  readonly fileSystem: RestrictedPathFileSystem;
  readonly currentIdentity: () => Promise<RestrictedHostIdentity>;
}

export function createNodeRestrictedPathHostRuntime(input: {
  readonly environmentSource: ReleaseControlCommandEnvironmentSource;
  readonly hostToolsEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
  readonly commands: ReleaseControlCommandSupervisor;
}): RestrictedPathHostRuntime;

export interface RestrictedPathDependencies {
  readonly capability: 'plan7a-restricted-path-dependencies-v1';
  // Opaque Task 5A brand; no public runtime/environment/filesystem getters.
}

export function createRestrictedPathDependencies(input: {
  readonly environmentSource: ReleaseControlCommandEnvironmentSource;
  readonly hostToolsEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
  readonly commands: ReleaseControlCommandSupervisor;
  readonly hostRuntime: RestrictedPathHostRuntime;
}): RestrictedPathDependencies;

export function assertRestrictedPathSupervisorAssociation(input: {
  readonly dependencies: RestrictedPathDependencies;
  readonly commands: ReleaseControlCommandSupervisor;
}): void;

export function assertRestrictedPathLeaseSupervisorAssociation(input: {
  readonly lease: RestrictedPathLease;
  readonly commands: ReleaseControlCommandSupervisor;
}): void;

export interface RestrictedPathLeaseInput {
  readonly target?: string;
  readonly parent?: string;
  readonly prefix?: string;
  readonly repositoryRoot: string;
  readonly ownershipToken: string;
}

export async function createRestrictedPathLease(
  input: RestrictedPathLeaseInput,
  dependencies: RestrictedPathDependencies
): Promise<RestrictedPathLease>;

export async function openRestrictedPathReader(
  root: string,
  dependencies: RestrictedPathDependencies
): Promise<RestrictedPathReader>;

export async function prepareRestrictedDockerBindProbe(input: {
  readonly lease: RestrictedPathLease;
  readonly dockerContext: string;
  readonly expectedDockerEngineId: DockerEngineId;
  readonly imageId: string;
  readonly auditedNodeIdentity:
    | { readonly platform: 'posix'; readonly uid: number; readonly gid: number }
    | { readonly platform: 'win32'; readonly user: 'node' };
  readonly access: 'read-only' | 'read-write';
}, dependencies: RestrictedPathDependencies): Promise<PreparedRestrictedDockerBindProbe>;
```

`createNodeRestrictedPathHostRuntime` is the sole real host-filesystem/current-identity adapter. It first authenticates the exact environment-source/`host-tools` pair and supervisor, privately binds that trio, and performs no I/O until a later lease/reader operation invokes its Node primitives or its bounded Windows identity adapter through that same supervisor. `createRestrictedPathDependencies` authenticates the environment-source/`host-tools` pair, derives the platform from that source, authenticates the exact supervisor, rejects a Node host runtime bound to a different trio, defensively closes over the low-level host-runtime fields, and binds all four objects in one private WeakMap record. No consumer can inject or read a second command runtime/environment through this capability. `assertRestrictedPathSupervisorAssociation` is Task 7's pre-mutation dependency check; `assertRestrictedPathLeaseSupervisorAssociation` resolves an authentic lease to its originating dependency/supervisor and is required before success-evidence publication or another owner combines that lease with commands. The Windows adapter uses a fixed encoded script constant and strict JSON result schema; paths are positional arguments, never interpolated script or shell text. The POSIX adapter uses Node filesystem primitives and requires a finite nonnegative effective UID/GID; Docker-bind preparation rejects effective UID `0`. Both implementations keep raw paths and ACL command output private, retain no mutable byte views, and register cleanup intent before creation. For an ordinary create/read operation—including the optional failure-record writer—the Windows command-backed branch uses `run()`, while the POSIX Node-filesystem branch calls the same supervisor's synchronous latch check immediately before and after each awaited boundary; success publication additionally remains wrapped only by `evidence.ts`'s publication guards. Root/file removal, prepared-retention rollback, absence reattestation, and all failure cleanup ignore the latch: Windows child work uses `runCleanup()`, while POSIX performs same-identity Node cleanup without an interruption check. Thus a signal is observed after an in-flight domain filesystem operation settles but cannot suppress authoritative cleanup, and Task 5A never fabricates a child command merely to supervise Node filesystem I/O. Reservations, prepared probes, verified low-level observations, and prepared-retention values are runtime-branded by their originating owner. Task 5A never launches a Docker container, returns an authorizing bind lease, or claims to authenticate an image runtime. It accepts the already audited image ID/node identity only at its internal Task 6 seam, verifies POSIX UID/GID exactly equals the lease owner (or Windows uses the audited default `node` user), and prepares the nonce/mount/command envelope. Static dependency tests forbid importing any low-level Docker probe type/function outside `owned-compose.ts`. Task 6 is the sole audit, launch, and final bind-capability owner: it supplies the pre-registered exact probe container name and Plan 7A/Compose labels, records the mutation before invocation, privately verifies the Task 5A observation against the exact results of that launch, and only then mints its own runtime-branded `RestrictedDockerBindLease`. No Task 5A public method accepts results and returns an authorizing capability; a fabricated result, direct verification call, structural low-level witness, raw direct launch, or unregistered name/label set cannot authorize a bind.

The proof uses a fixed no-network/read-only/cap-drop/no-new-privileges envelope and is deliberately two-stage: first the lease writes/syncs a private challenge and a read-only bind container must return its exact digest without changing any entry; only after that proves the daemon sees the same bytes may a read-write container create/fsync/close the expected reply. The lease adopts/verifies/removes that reply, removes the challenge, synchronizes the root, and proves the starting entry set is restored. Thus a remapped/unreachable remote path is detected before a container can leave an unreachable sentinel. A copied rather than shared file, inaccessible UID/DACL, node/lease identity mismatch, replaced file, or engine drift also fails before the capability is returned. Task 11 additionally uses the same audited user arguments for an exact read/write access witness against each source/rehearsal named storage volume before the corresponding capture/restore helper may mutate it; bind-root success alone is not accepted as volume compatibility. Tests permit only the registered image build/load needed to make the probe image present; every other bind-using command before the exact capability is rejected. They interrupt after probe-container creation but before acknowledgement and prove Task 6 discovers/removes the exact registered container. `prepareRetention()` performs every fallible identity/ACL/entry check while `rollback()` remains able to remove the exact lease; `commit()` is a synchronous state flip with no I/O, allocation, injection, or throw path. Stable enumeration performs raw UTF-8-byte sorting and repeats root identity plus directory entry identity before returning. Stable hashing uses one no-follow open handle, streams without buffering a large artifact, and compares path/root identity, byte length, and modification/file identity before and after; replacement or growth fails closed.

- [ ] **Step 4: Prove GREEN and commit**

```powershell
npx vitest run `
  scripts/release-control/command-runtime.test.ts `
  scripts/release-control/restricted-path.test.ts `
  --reporter=verbose
npm run check
npm run lint -- --no-warn-ignored scripts/release-control/restricted-path.ts
git --literal-pathspecs add -- `
  scripts/release-control/restricted-path.ts `
  scripts/release-control/restricted-path.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: enforce platform-private smoke paths"
```

### Task 6: Extract closed owned-Compose identity, discovery, shutdown, and cleanup

**Files:**
- Create: `scripts/release-control/owned-compose.ts`
- Create: `scripts/release-control/owned-compose.test.ts`

- [ ] **Step 1: Write manifest, collision, partial-creation, and cleanup REDs**

Define three closed topology descriptors and one deterministic identity factory, not caller-supplied names:

```ts
export const OWNED_TOPOLOGIES = {
  productionMaintenance: {
    services: ['app', 'worker', 'migrate', 'database-role-provision',
      'bootstrap-admin', 'storage-cleanup', 'postgres', 'caddy'],
    networks: ['default'],
    volumes: ['postgres_data', 'book_staging', 'book_publication',
      'book_covers', 'caddy_data', 'caddy_config']
  },
  fixtureMaintenance: {
    services: ['postgres', 'mailpit', 'stripe_api_canary', 'app', 'worker',
      'bootstrap-admin', 'migrate', 'database-role-provision'],
    networks: ['default'],
    volumes: ['stripe_attempts', 'book_staging', 'book_publication',
      'book_covers']
  },
  releaseCandidate: {
    services: ['app', 'worker', 'migrate', 'database-role-provision',
      'bootstrap-admin', 'storage-cleanup', 'postgres', 'caddy'],
    networks: ['default'],
    volumes: ['postgres_data', 'book_staging', 'book_publication',
      'book_covers', 'caddy_data', 'caddy_config']
  }
} as const;

export const OWNED_PROJECT_PREFIX = {
  'plan6b-production-smoke': 'po7a-prod-',
  'plan6b-fixture-runtime-probe': 'po7a-fixture-',
  'plan7a-release-candidate': 'po7a-release-'
} as const;

export const OWNED_TEMP_PREFIX = {
  'plan6b-production-smoke': 'pale-orbit-prod-',
  'plan6b-fixture-runtime-probe': 'pale-orbit-fixture-',
  'plan7a-release-candidate': 'pale-orbit-release-'
} as const;
```

The identity factory consumes injected entropy, requires exactly 16 lowercase hex characters for `runId` and 32 for `ownershipToken`, and derives the maintenance `composeProject` capability as the producer prefix plus `runId`. A release identity additionally generates a distinct 32-lowercase-hex `backupId`, derives `composeProjects.source` and `.rehearsal` as the only two Compose-project capabilities, and derives separate `helperNamespaces.capture` and `.rehearsal` values for hardened raw containers. Each branded Compose-project capability contains the exact Task 6-derived public/private ownership labels; no registration API accepts them. The raw helper namespaces are not Compose projects. Each maps to a different `volumeProject`: capture uses `composeProjects.source`; restore/verify uses `composeProjects.rehearsal`. From the closed role/operation/storage-class set, the factory derives every exact raw helper container name, including bind-read, bind-write, `access-capture-{staging,publication,covers}`, `capture-{staging,publication,covers}`, `access-restore-{staging,publication,covers}`, `restore-{staging,publication,covers}`, and `verify-restore-{staging,publication,covers}` as applicable. Its temporary child prefix is the exact producer temp prefix plus `runId` plus `-`. The returned object has a real module-private unique-symbol field and runtime-registry entry. Pin every result against the applicable Docker project/container-name grammar and reject any caller override, spread copy, or cast-only lookalike.

`createNodeReleaseControlEntropy` is Task 6's sole real identity/secret entropy adapter. It performs no draw at construction, uses `node:crypto` only on method invocation, returns exact lowercase hex for the two closed identity lengths and defensive fresh bytes only for the closed secret lengths `24 | 32`, and retains no generated material. The two Task 6 secret-set factories below are the sole byte-to-text mapping owners. Each consumes the rows in displayed order with exactly one entropy call per row, validates an actual `Uint8Array` of the requested length, copies it into a temporary `Buffer`, creates the exact text, and zeroes both byte buffers in `finally`. It returns one frozen null-prototype record and retains neither bytes nor text in an identity/registry. Hex is lowercase with no prefix; base64url is RFC 4648 URL-safe, unpadded Node `base64url`. Every result is nonempty ASCII with no NUL, whitespace, BOM, or newline. Consumer tests inject deterministic entropy and pin every call/output/destination; the focused real-adapter test proves shape, both accepted lengths, copy isolation, rejection of every other integer/noninteger value, buffer zeroing, and that consumer modules no longer import `node:crypto` or implement a second identity/secret generator. Task 5's separately owned random-port selection may continue using its moved nonsecret random-integer primitive.

| Secret set and field, in draw order | Entropy call | Exact text and destination |
|---|---:|---|
| production `databaseOwnerPassword` | `randomSecretBytes(24)` | 48 lowercase hex; `database_owner_password` file |
| production `databasePassword` | `randomSecretBytes(24)` | 48 lowercase hex; `database_password` file |
| production `databaseWorkerPassword` | `randomSecretBytes(24)` | 48 lowercase hex; `database_worker_password` file |
| production `databaseStorageCleanupPassword` | `randomSecretBytes(24)` | 48 lowercase hex; `database_storage_cleanup_password` file |
| production `authSecret` | `randomSecretBytes(32)` | 64 lowercase hex; `auth_secret` file |
| production `smtpPassword` | `randomSecretBytes(24)` | 48 lowercase hex; `smtp_password` file |
| production `bootstrapAdminPassword` | `randomSecretBytes(24)` | 48 lowercase hex; `bootstrap_admin_password` file |
| fixture `databaseOwnerPassword` | `randomSecretBytes(24)` | 48 lowercase hex; direct `DATABASE_OWNER_PASSWORD` slot |
| fixture `databasePassword` | `randomSecretBytes(24)` | 48 lowercase hex; direct `DATABASE_PASSWORD` slot |
| fixture `databaseWorkerPassword` | `randomSecretBytes(24)` | 48 lowercase hex; direct `DATABASE_WORKER_PASSWORD` slot |
| fixture `databaseStorageCleanupPassword` | `randomSecretBytes(24)` | 48 lowercase hex; direct `DATABASE_STORAGE_CLEANUP_PASSWORD` slot |
| fixture `authSecret` | `randomSecretBytes(32)` | 64 lowercase hex; direct `AUTH_SECRET` slot |
| fixture `bootstrapAdminPassword` | `randomSecretBytes(32)` | exact `P6b!<43-character-base64url>Aa1`; `bootstrap_admin_password` file |

Production maintenance and release each call `createProductionReleaseControlSecretSet` once. Production maintenance writes the seven values and releases the transient set reference before leaving `preflight`; release writes the same seven returned strings, as UTF-8 without BOM or terminal newline, into separate source and rehearsal private secret-root leases and likewise releases the transient set before leaving `preflight`, so restored role/application configuration remains identical across engines while paths/file identities differ. Neither production-scoped command environment ever contains a raw secret value; it carries only the seven role-correct file paths. Fixture calls `createFixtureReleaseControlSecretSet` once, places only the administrator string in its private file, and supplies the other five strings only through the one immutable `fixture-compose` environment; it clears the extra state reference immediately after that environment is bound and again idempotently during cleanup. No raw entropy, encoded secret, secret record, or direct/indirect digest may enter an override, argv, manifest, registry, event, evidence, error, or diagnostic. Tests use fixed increasing byte vectors to pin all 13 outputs, assert 32 zero bytes become exactly 43 `A` characters inside the fixture wrapper, reject a wrong-length/non-`Uint8Array` fake, prove production/rehearsal byte equality with path inequality, and prove those exact reference-lifetime rules on every failure boundary.

Tests require exact run/candidate/project/owner labels, Task 5A leases for every temp/manifest/override/secret root, exact names and labels before any Docker mutation, mutation-attempt registration before invocation, discovery after partial failure, foreign exact-name refusal, manifest reread/equality before cleanup, graceful `stop` during shutdown, `down --volumes --remove-orphans` during cleanup, and exact post-cleanup counts for containers/networks/volumes/temp roots. A resource inferred only from a name or an untrusted manifest is never removed. For Compose-managed resources, all four Task 4 Plan 7A labels and `com.docker.compose.project` equal that Compose project. For raw helpers, all four Plan 7A labels identify the helper namespace/role, while `com.docker.compose.project` intentionally equals the separate source/rehearsal `volumeProject` and `com.docker.compose.service` is the exact fixed helper service. Raw helpers own no network or volume; they mount the already registered Compose volumes. Discovery intersects all exact labels, the role capability, and the closed expected-name set. A name-only, Compose-project-only, owner-label-only, missing-label, wrong-volume-project, or cross-run match is foreign and is never removed.

For every profile, compute the runtime-branded identity first, then acquire every private lease only through its preparation ledger, and supply only the discriminated source-build registration—not a caller-observed baseline—to `sealMutationManifest`. Both source-build and restore-load registrations carry the same exact safe `SourceIdentity` derived from the frozen Task 3 context; source-build additionally carries its ordered frozen base-image references, while restore-load has no base-image field. The release checkpoint separately supplies the one operator-provided digest-pinned PostgreSQL reference. No registration accepts an image-label record, project, helper namespace, backup ID, owner token, or project/helper label record: Task 6 calls Task 4's `exactPlan7aImageLabels(sourceIdentity)` and derives every other label once from the exact registered run identity. The factory also derives one exact image-probe container identity for each source/restore journal, including its name, engine, all Plan 7A labels, Compose project label, and fixed service label; maintenance profiles therefore have the same interruption-safe inspection ownership as release. The seal operation re-observes the exact engine, executes the complete inventory `docker --context <context> image ls --all --no-trunc --quiet`, and strict-parses, case-sensitively sorts, and deduplicates its exact image IDs. Before manifest publication it also inspects every ordered source base reference, requires a local exact raw ID, rejects duplicates/reference drift, and persists the ordered `{ reference, imageId }` set. For `releaseCandidate`, it repeats complete inventory on the distinct restore engine before any source build, strictly validates the registered PostgreSQL reference, and on both engines requires its `RepoDigests` to contain that exact reference while recording each exact local raw ID. It creates one Task 4A `maintenance` database scope for a maintenance manifest or distinct role-keyed `source` and `rehearsal` scopes for a release manifest, then writes one immutable outer manifest with those private associations, both complete baselines, the exact source identity, source base-image set, registered PostgreSQL reference/engine observations, exact derived labels, every lease, image-probe identities, source/restore contexts and parsed engine IDs, backup ID, both Compose projects, raw-helper identities/names, and closed expected resources using one `writeExclusiveSynced` call; the file is never appended to or replaced. Only after a strict same-identity reread does it return runtime-branded registered source/restore journals and PostgreSQL identity. The source journal alone exposes the branded base set; the restore journal cannot be passed to the builder. Each journal may later bind an eventual IID in memory, while its persisted baseline plus labels remains sufficient for interrupted build/load discovery. Inject interruption before/after each inventory, base/PostgreSQL inspection, scope association, and manifest boundary, immediately after restore load, and at every later mutation/reread boundary; prove the outer lifecycle can discover and clean exact introduced images/probe containers/projects/resources/roots on both engines without guessing names or deleting either baseline.

Add preparation-order REDs proving `Object.is(identity, preparation.identity)`, structural/cross-run preparation rejection before evidence-root acquisition, cleanup after each partial root acquisition, manifest-seal failure cleanup, failed-build journal discovery, and a residual `cleanup_failed` result when image absence is unproved. Add post-build typestate REDs for configuration before image registration; caller-supplied labels/project; wrong journal/image/PostgreSQL/origin; an incomplete/eager/structural/cross-scope scoped environment; and two genuine identical-value environments from different Task 5 sources. Every environment-association or scope rejection occurs before materialization or any Compose command and leaves exact host-tools cleanup available. Also cover byte, line-ending, key-order, or materialized-file replacement; source/rehearsal swap; structural/cross-run configuration leases; rebinding/rebuilding an environment after a successful bind; mutation before configuration plus binds; and source/rehearsal templates that fail to differ. Add resolver REDs for spread/serialize/reparse/prototype copies, identical safe fields from another owner, forged checkpoint identities, a genuine journal from the wrong identity/preparation, wrong role/root/access/runtime/context/engine, and repeated storage-volume consumption. Include timeout/interruption at each mutation boundary and cleanup aggregation where the primary failure is retained privately but the public error is fixed.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run scripts/release-control/owned-compose.test.ts --reporter=verbose
```

Expected: FAIL because shared ownership does not exist and both smoke scripts still duplicate it.

- [ ] **Step 3: Implement exact identity and cleanup operations**

Expose narrow injected operations:

```ts
interface OwnedComposeRunCommon {
  readonly version: 1;
  readonly dockerContext: string;
  readonly composeRoot: RestrictedPathLease;
  readonly baseComposeFile: FrozenComposeFile & { readonly role: 'base' };
  readonly runtimeInputs: readonly FrozenRuntimeInput[];
  readonly manifestRoot: RestrictedPathLease;
  readonly secretRoot: RestrictedPathLease;
}

export type OwnedComposeRun =
  | (OwnedComposeRunCommon & {
      readonly identity: OwnedProductionMaintenanceRunIdentity;
      readonly topology: 'productionMaintenance';
      readonly composeScope: 'production-compose';
    })
  | (OwnedComposeRunCommon & {
      readonly identity: OwnedFixtureMaintenanceRunIdentity;
      readonly topology: 'fixtureMaintenance';
      readonly composeScope: 'fixture-compose';
    })
  | (OwnedComposeRunCommon & {
      readonly identity: OwnedReleaseRunIdentity;
      readonly topology: 'releaseCandidate';
      readonly composeScope: 'production-compose';
      readonly role: 'source';
    });

export interface ReleaseControlEntropy {
  randomHex(byteLength: 8 | 16): string;
  randomSecretBytes(byteLength: 24 | 32): Uint8Array;
}

export function createNodeReleaseControlEntropy(): ReleaseControlEntropy;

export interface ProductionReleaseControlSecretSet {
  readonly databaseOwnerPassword: string;
  readonly databasePassword: string;
  readonly databaseWorkerPassword: string;
  readonly databaseStorageCleanupPassword: string;
  readonly authSecret: string;
  readonly smtpPassword: string;
  readonly bootstrapAdminPassword: string;
}

export interface FixtureReleaseControlSecretSet {
  readonly databaseOwnerPassword: string;
  readonly databasePassword: string;
  readonly databaseWorkerPassword: string;
  readonly databaseStorageCleanupPassword: string;
  readonly authSecret: string;
  readonly bootstrapAdminPassword: string;
}

export function createProductionReleaseControlSecretSet(
  entropy: ReleaseControlEntropy
): ProductionReleaseControlSecretSet;

export function createFixtureReleaseControlSecretSet(
  entropy: ReleaseControlEntropy
): FixtureReleaseControlSecretSet;

interface OwnedRunIdentityCommon {
  readonly capability: 'plan7a-owned-run-identity-v1';
  readonly runId: string;
  readonly candidateId: string;
  readonly ownershipToken: string;
  readonly temporaryChildPrefix: string;
  // A module-private unique-symbol field plus runtime registry prevents a
  // caller from constructing or relabeling an identity.
}

export type OwnedComposeProjectRole =
  | 'production-maintenance'
  | 'fixture-maintenance'
  | 'source'
  | 'rehearsal';

export interface OwnedComposeProjectIdentity<
  Role extends OwnedComposeProjectRole
> {
  readonly capability: 'plan7a-owned-compose-project-v1';
  readonly role: Role;
  readonly project: string;
  readonly ownershipLabels: Plan7aOwnedResourceLabels;
  // Opaque Task 6 runtime brand; labels are derived, never caller-supplied.
}

export interface OwnedProductionMaintenanceRunIdentity extends OwnedRunIdentityCommon {
  readonly producer: 'plan6b-production-smoke';
  readonly profile: 'maintenance_fixture';
  readonly composeProject: OwnedComposeProjectIdentity<'production-maintenance'>;
}

export interface OwnedFixtureMaintenanceRunIdentity extends OwnedRunIdentityCommon {
  readonly producer: 'plan6b-fixture-runtime-probe';
  readonly profile: 'maintenance_fixture';
  readonly composeProject: OwnedComposeProjectIdentity<'fixture-maintenance'>;
}

export type OwnedMaintenanceRunIdentity =
  | OwnedProductionMaintenanceRunIdentity
  | OwnedFixtureMaintenanceRunIdentity;

export interface OwnedReleaseRunIdentity extends OwnedRunIdentityCommon {
  readonly producer: 'plan7a-release-candidate';
  readonly profile: 'release_candidate';
  readonly backupId: string;
  readonly composeProjects: {
    readonly source: OwnedComposeProjectIdentity<'source'>;
    readonly rehearsal: OwnedComposeProjectIdentity<'rehearsal'>;
  };
  readonly helperNamespaces: {
    readonly capture: string;
    readonly rehearsal: string;
  };
}

export type OwnedRunIdentity = OwnedMaintenanceRunIdentity | OwnedReleaseRunIdentity;

export function createOwnedRunIdentity(input: {
  readonly producer: 'plan6b-production-smoke';
  readonly profile: 'maintenance_fixture';
  readonly candidateId: string;
}, entropy: ReleaseControlEntropy): OwnedProductionMaintenanceRunIdentity;

export function createOwnedRunIdentity(input: {
  readonly producer: 'plan6b-fixture-runtime-probe';
  readonly profile: 'maintenance_fixture';
  readonly candidateId: string;
}, entropy: ReleaseControlEntropy): OwnedFixtureMaintenanceRunIdentity;

export function createOwnedRunIdentity(input: {
  readonly producer: 'plan7a-release-candidate';
  readonly profile: 'release_candidate';
  readonly candidateId: string;
}, entropy: ReleaseControlEntropy): OwnedReleaseRunIdentity;

export function resolveOwnedComposeProject<Role extends OwnedComposeProjectRole>(
  input: {
    readonly run: OwnedRunIdentity;
    readonly project: OwnedComposeProjectIdentity<Role>;
  }
): Readonly<{
  readonly role: Role;
  readonly project: string;
  readonly ownershipLabels: Plan7aOwnedResourceLabels;
}>;

export interface OwnedComposeDependencies {
  readonly commands: ReleaseControlCommandSupervisor;
  readonly hostToolsEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
}

interface CandidateImageMutationRegistrationCommon {
  readonly dockerContext: string;
  readonly expectedDockerEngineId: DockerEngineId;
  readonly sourceIdentity: SourceIdentity;
}

export type CandidateImageMutationRegistration =
  | (CandidateImageMutationRegistrationCommon & {
      readonly role: 'source-build';
      readonly baseImageReferences: readonly string[];
    })
  | (CandidateImageMutationRegistrationCommon & {
      readonly role: 'restore-load';
    });

export interface RegisteredBaseImageSet {
  readonly capability: 'plan7a-registered-base-images-v1';
  readonly images: readonly {
    readonly reference: string;
    readonly imageId: string;
  }[];
  // Opaque runtime brand binds this ordered set to the sealed source journal.
}

export interface RegisteredPostgresImageSet {
  readonly capability: 'plan7a-registered-postgres-image-v1';
  readonly reference: string;
  readonly source: {
    readonly dockerContext: string;
    readonly dockerEngineId: DockerEngineId;
    readonly imageId: string;
  };
  readonly restore: {
    readonly dockerContext: string;
    readonly dockerEngineId: DockerEngineId;
    readonly imageId: string;
  };
  // Opaque runtime brand binds both RepoDigest observations to the sealed manifest.
}

export interface AuditedDockerRuntimeIdentity {
  readonly capability: 'plan7a-audited-docker-runtime-v1';
  readonly dockerContext: string;
  readonly dockerEngineId: DockerEngineId;
  readonly imageId: string;
  readonly defaultUser: 'node';
  readonly uid: number;
  readonly gid: number;
  readonly storageHelperPresent: true;
  // Opaque Task 6 runtime brand bound to an exact owned probe execution.
}

interface RegisteredCandidateImageMutationJournalCommon {
  readonly capability: 'plan7a-registered-image-mutation-v1';
  readonly dockerContext: string;
  readonly expectedDockerEngineId: DockerEngineId;
  readonly labels: Plan7aImageLabels;
  readonly baselineImageIds: readonly string[];
  readonly imageProbe: OwnedImageProbeIdentityLease;
  bindRuntimeImage(input: {
    readonly imageId: string;
    readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
  }): Promise<RegisteredRuntimeImage>;
  discoverOwnedImageIds(): Promise<readonly string[]>;
  // Opaque runtime brand binds this journal to the strict-reread manifest.
}

export type RegisteredCandidateImageMutationJournal =
  | (RegisteredCandidateImageMutationJournalCommon & {
      readonly role: 'source-build';
      readonly baseImages: RegisteredBaseImageSet;
    })
  | (RegisteredCandidateImageMutationJournalCommon & {
      readonly role: 'restore-load';
    });

export type RegisteredSourceImageMutationJournal = Extract<
  RegisteredCandidateImageMutationJournal,
  { readonly role: 'source-build' }
>;

export type RegisteredRestoreImageMutationJournal = Extract<
  RegisteredCandidateImageMutationJournal,
  { readonly role: 'restore-load' }
>;

export interface RegisteredRuntimeImage {
  readonly capability: 'plan7a-registered-runtime-image-v1';
  readonly imageId: string;
  readonly labels: Plan7aImageLabels;
  readonly dockerContext: string;
  readonly dockerEngineId: DockerEngineId;
  readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
  // Runtime-bound to the journal and strict-reread manifest.
}

export interface OwnedImageProbeIdentityLease {
  readonly capability: 'plan7a-owned-image-probe-v1';
  readonly exactContainerName: string;
  readonly dockerContext: string;
  readonly dockerEngineId: DockerEngineId;
  readonly ownershipLabels: Plan7aOwnedResourceLabels;
  readonly composeProjectLabel: string;
  readonly serviceLabel: 'release-control-image-probe';
  // Opaque runtime brand generated for every maintenance/release image journal.
}

export type OwnedRawHelperRole = 'captureHelper' | 'rehearsalHelper';

export type CaptureRawHelperOperation =
  | 'bind-read' | 'bind-write'
  | 'access-capture-staging' | 'access-capture-publication'
  | 'access-capture-covers'
  | 'capture-staging' | 'capture-publication' | 'capture-covers';

export type RehearsalRawHelperOperation =
  | 'bind-read' | 'bind-write'
  | 'access-restore-staging' | 'access-restore-publication'
  | 'access-restore-covers'
  | 'restore-staging' | 'restore-publication' | 'restore-covers'
  | 'verify-restore-staging' | 'verify-restore-publication'
  | 'verify-restore-covers';

interface OwnedRawHelperIdentityCommon {
  readonly capability: 'plan7a-owned-raw-helper-v1';
  readonly helperNamespace: string;
  readonly volumeProject: string;
  readonly dockerContext: string;
  readonly dockerEngineId: DockerEngineId;
  readonly ownershipLabels: Plan7aOwnedResourceLabels;
  readonly composeProjectLabel: string;
  readonly serviceLabel: 'deployment-checkpoint-storage';
  // Opaque runtime brand binds role, names, labels, engine, and volume project.
}

export type OwnedRawHelperIdentityLease =
  | (OwnedRawHelperIdentityCommon & {
      readonly role: 'captureHelper';
      readonly exactContainerNames: Readonly<Record<CaptureRawHelperOperation, string>>;
    })
  | (OwnedRawHelperIdentityCommon & {
      readonly role: 'rehearsalHelper';
      readonly exactContainerNames: Readonly<Record<RehearsalRawHelperOperation, string>>;
    });

export interface OwnedCheckpointRegistration {
  readonly sourceContext: string;
  readonly sourceDockerEngineId: DockerEngineId;
  readonly restoreContext: string;
  readonly restoreDockerEngineId: DockerEngineId;
  readonly postgresImageReference: string;
  readonly transferRoot: RestrictedPathLease;
  readonly bundleRoot: RestrictedPathLease;
  readonly rehearsalRoot: RestrictedPathLease;
  readonly materializationRoots: {
    readonly source: {
      readonly compose: RestrictedPathLease;
      readonly secrets: RestrictedPathLease;
    };
    readonly rehearsal: {
      readonly compose: RestrictedPathLease;
      readonly secrets: RestrictedPathLease;
    };
  };
  readonly restoreImageMutation: Extract<
    CandidateImageMutationRegistration,
    { readonly role: 'restore-load' }
  >;
}

export type OwnedTemporaryRootKind =
  | 'manifest'
  | 'candidate-iid'
  | 'compose-materialization'
  | 'secret-materialization'
  | 'image-transfer'
  | 'checkpoint-bundle'
  | 'rehearsal';

export interface OwnedRunPreparationDependencies {
  readonly restrictedPathDependencies: RestrictedPathDependencies;
}

export interface OwnedRunPreparation<I extends OwnedRunIdentity> {
  readonly capability: 'plan7a-owned-run-preparation-v1';
  readonly identity: I;
  acquireTemporaryRoot(
    input: Omit<RestrictedPathLeaseInput, 'ownershipToken'> & {
      readonly kind: OwnedTemporaryRootKind;
    }
  ): Promise<RestrictedPathLease>;
  cleanupBeforeCandidateHandoff(): Promise<
    OwnedFailureCleanupReceipt<I['profile']>
  >;
  // Opaque Task 6 brand. Construction is pure: no path, Docker, database, or
  // service mutation occurs until a lifecycle preflight calls acquire.
}

export function createOwnedRunPreparation<I extends OwnedRunIdentity>(
  identity: I,
  dependencies: OwnedRunPreparationDependencies
): OwnedRunPreparation<I>;

interface OwnedMutationManifestRegistrationCommon {
  readonly temporaryRoots: readonly {
    readonly kind: OwnedTemporaryRootKind;
    readonly lease: RestrictedPathLease;
  }[];
  readonly candidateImage: Extract<
    CandidateImageMutationRegistration,
    { readonly role: 'source-build' }
  >;
}

export type OwnedMutationManifestRegistration =
  | (OwnedMutationManifestRegistrationCommon & {
      readonly profile: 'maintenance_fixture';
      readonly checkpoint?: never;
    })
  | (OwnedMutationManifestRegistrationCommon & {
      readonly profile: 'release_candidate';
      readonly checkpoint: OwnedCheckpointRegistration;
    });

export type OwnedMutationManifestLease =
  | {
      readonly capability: 'plan7a-owned-mutation-manifest-v1';
      readonly profile: 'maintenance_fixture';
      readonly databaseScopes: {
        readonly maintenance: DatabaseAttestationScope<'maintenance'>;
      };
      readonly candidateImage: RegisteredSourceImageMutationJournal;
      readonly checkpoint?: never;
    }
  | {
      readonly capability: 'plan7a-owned-mutation-manifest-v1';
      readonly profile: 'release_candidate';
      readonly databaseScopes: {
        readonly source: DatabaseAttestationScope<'source'>;
        readonly rehearsal: DatabaseAttestationScope<'rehearsal'>;
      };
      readonly candidateImage: RegisteredSourceImageMutationJournal;
      readonly checkpoint: OwnedCheckpointIdentityLease;
    };

type OwnedMutationManifestRegistrationForRole<
  Role extends 'maintenance' | 'source'
> = Role extends 'maintenance'
  ? Extract<OwnedMutationManifestRegistration, { readonly profile: 'maintenance_fixture' }>
  : Extract<OwnedMutationManifestRegistration, { readonly profile: 'release_candidate' }>;

type OwnedMutationManifestLeaseForRole<
  Role extends 'maintenance' | 'source'
> = Role extends 'maintenance'
  ? Extract<OwnedMutationManifestLease, { readonly profile: 'maintenance_fixture' }>
  : Extract<OwnedMutationManifestLease, { readonly profile: 'release_candidate' }>;

export interface OwnedCheckpointIdentityLease {
  readonly capability: 'plan7a-owned-checkpoint-identity-v1';
  readonly run: OwnedReleaseRunIdentity;
  readonly databaseScopes: {
    readonly source: DatabaseAttestationScope<'source'>;
    readonly rehearsal: DatabaseAttestationScope<'rehearsal'>;
  };
  readonly sourceContext: string;
  readonly sourceDockerEngineId: DockerEngineId;
  readonly restoreContext: string;
  readonly restoreDockerEngineId: DockerEngineId;
  readonly postgresImage: RegisteredPostgresImageSet;
  readonly transferRoot: RestrictedPathLease;
  readonly bundleRoot: RestrictedPathLease;
  readonly rehearsalRoot: RestrictedPathLease;
  readonly materializationRoots: OwnedCheckpointRegistration['materializationRoots'];
  readonly sourceImageMutation: RegisteredSourceImageMutationJournal;
  readonly restoreImageMutation: RegisteredRestoreImageMutationJournal;
  readonly rawHelpers: {
    readonly capture: Extract<
      OwnedRawHelperIdentityLease,
      { readonly role: 'captureHelper' }
    >;
    readonly rehearsal: Extract<
      OwnedRawHelperIdentityLease,
      { readonly role: 'rehearsalHelper' }
    >;
  };
  // Task 6 derives every label, helper namespace, project, owner token, and
  // backup ID from run. Registration accepts none of those values.
}

export function assertOwnedRunPreparation<I extends OwnedRunIdentity>(input: {
  readonly identity: I;
  readonly preparation: OwnedRunPreparation<I>;
  readonly restrictedPathDependencies: RestrictedPathDependencies;
}): void;

export function assertOwnedCheckpointIdentityLease(
  identity: OwnedCheckpointIdentityLease
): void;

export function assertOwnedCandidateJournalAssociation<
  I extends OwnedRunIdentity
>(input: {
  readonly identity: I;
  readonly preparation: OwnedRunPreparation<I>;
  readonly journal: RegisteredSourceImageMutationJournal;
}): void;

export function assertOwnedCandidateBuildRegistration<
  I extends OwnedRunIdentity
>(input: {
  readonly identity: I;
  readonly preparation: OwnedRunPreparation<I>;
  readonly journal: RegisteredSourceImageMutationJournal;
  readonly iidRoot: RestrictedPathLease;
  readonly sourceIdentity: SourceIdentity;
}): void;

export interface RestrictedDockerBindLease {
  readonly capability: 'plan7a-restricted-docker-bind-v1';
  readonly lease: RestrictedPathLease;
  readonly dockerContext: string;
  readonly dockerEngineId: DockerEngineId;
  readonly imageId: string;
  readonly access: 'read-only' | 'read-write';
  readonly dockerUserArgs: readonly [] | readonly ['--user', `${number}:${number}`];
  readonly auditedNodeIdentity:
    | { readonly platform: 'posix'; readonly uid: number; readonly gid: number }
    | { readonly platform: 'win32'; readonly user: 'node' };
  // Opaque Task 6 brand binds the exact registered launch and Task 5A witness.
}

export interface ResolvedRestrictedDockerBindLease<
  Role extends OwnedRawHelperRole
> {
  readonly helper: Extract<OwnedRawHelperIdentityLease, { readonly role: Role }>;
  readonly lease: RestrictedPathLease;
  readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
  readonly access: 'read-only' | 'read-write';
  readonly dockerUserArgs: readonly [] | readonly ['--user', `${number}:${number}`];
}

export function resolveRestrictedDockerBindLease<
  Role extends OwnedRawHelperRole
>(input: {
  readonly helper: Extract<OwnedRawHelperIdentityLease, { readonly role: Role }>;
  readonly bind: RestrictedDockerBindLease;
  readonly lease: RestrictedPathLease;
  readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
  readonly access: 'read-only' | 'read-write';
}): ResolvedRestrictedDockerBindLease<Role>;

export type CoordinatedStorageClass = 'staging' | 'publication' | 'covers';

export interface CoordinatedStorageVolumeAccessLease<
  Role extends OwnedRawHelperRole,
  StorageClass extends CoordinatedStorageClass
> {
  readonly capability: 'plan7a-coordinated-storage-volume-access-v1';
  readonly role: Role;
  readonly storageClass: StorageClass;
  readonly access: Role extends 'captureHelper'
    ? 'source-read-traverse'
    : 'restore-read-write';
  readonly helper: Extract<OwnedRawHelperIdentityLease, { readonly role: Role }>;
  // Opaque Task 6 brand binds the exact volume, engine, user, and witness.
}

export interface CoordinatedStorageVolumeAccessSet<
  Role extends OwnedRawHelperRole
> {
  readonly capability: 'plan7a-coordinated-storage-volume-set-v1';
  readonly role: Role;
  readonly ordered: readonly [
    CoordinatedStorageVolumeAccessLease<Role, 'staging'>,
    CoordinatedStorageVolumeAccessLease<Role, 'publication'>,
    CoordinatedStorageVolumeAccessLease<Role, 'covers'>
  ];
}

export interface ResolvedCoordinatedStorageVolumeAccessSet<
  Role extends OwnedRawHelperRole
> {
  readonly role: Role;
  readonly orderedStorageClasses: readonly ['staging', 'publication', 'covers'];
  readonly helper: Extract<OwnedRawHelperIdentityLease, { readonly role: Role }>;
  readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
  readonly bundleBind: RestrictedDockerBindLease;
}

export type OwnedComposeRole = 'maintenance' | 'source' | 'rehearsal';
export type OwnedComposeCommandScope =
  | 'production-compose'
  | 'fixture-compose'
  | 'checkpoint-compose';

export interface OwnedComposeBindSet<
  Role extends OwnedComposeRole,
  Scope extends OwnedComposeCommandScope
> {
  readonly capability: 'plan7a-owned-compose-bind-set-v1';
  readonly role: Role;
  readonly composeScope: Scope;
  readonly compose: RestrictedDockerBindLease;
  readonly secrets: RestrictedDockerBindLease;
  // Runtime-bound to one lifecycle, project, image, context, and manifest.
}

export interface OwnedComposeConfigurationLease<
  Role extends OwnedComposeRole,
  Scope extends OwnedComposeCommandScope
> {
  readonly capability: 'plan7a-owned-compose-configuration-v1';
  readonly role: Role;
  readonly composeScope: Scope;
  readonly project: string;
  readonly imageId: string;
  readonly overrideSha256: string;
  readonly evidence: ComposeConfigurationEvidence;
  // Opaque Task 6 brand binds lifecycle, manifest, exact materialized bytes,
  // project/labels, registered image, PostgreSQL expectation, origin, and the
  // exact late-bound immutable command environment used for config/runtime.
}

export type CleanupAttempt =
  | { readonly result: 'clean'; readonly evidence: ZeroCleanupEvidence }
  | {
      readonly result: 'residual';
      readonly code: 'cleanup_failed';
      readonly evidence: CleanupEvidence;
    };

type ResidualCleanupAttempt = Extract<
  CleanupAttempt,
  { readonly result: 'residual' }
>;

interface OwnedFailureCleanupReceiptCommon<
  Profile extends OwnedRunIdentity['profile']
> {
  readonly capability: 'plan7a-owned-failure-cleanup-receipt-v1';
  readonly scope: 'final';
  readonly profile: Profile;
  readonly candidateHandoff: 'not-bound';
  reattestAbsence(): Promise<OwnedFailureCleanupReceipt<Profile>>;
  // Opaque Task 6 brand binds the exact identity, preparation, registered
  // roots/lifecycle/manifest/journals, and cleanup observations.
}

export type OwnedFailureCleanupReceipt<
  Profile extends OwnedRunIdentity['profile']
> = OwnedFailureCleanupReceiptCommon<Profile> & (
  | {
      readonly candidateAbsence: 'proved';
      readonly attempt: CleanupAttempt;
    }
  | {
      readonly candidateAbsence: 'unproved';
      readonly attempt: ResidualCleanupAttempt;
    }
);

export interface OwnedCleanupReceipt<Scope extends 'rehearsal' | 'final'> {
  readonly capability: 'plan7a-owned-cleanup-receipt-v1';
  readonly scope: Scope;
  readonly attempt: CleanupAttempt;
  reattestAbsence(): Promise<OwnedCleanupReceipt<Scope>>;
  // Opaque runtime brand: structural lookalikes are rejected.
}

export function assertOwnedFailureCleanupReceipt<I extends OwnedRunIdentity>(
  input: {
    readonly identity: I;
    readonly preparation: OwnedRunPreparation<I>;
    readonly receipt: OwnedFailureCleanupReceipt<I['profile']>;
  }
): void;

export function assertOwnedFinalCleanupReceipt<I extends OwnedRunIdentity>(
  input: {
    readonly identity: I;
    readonly preparation: OwnedRunPreparation<I>;
    readonly receipt: OwnedCleanupReceipt<'final'>;
  }
): void;

export function assertOwnedRehearsalCleanupReceipt(input: {
  readonly identity: OwnedCheckpointIdentityLease;
  readonly receipt: OwnedCleanupReceipt<'rehearsal'>;
}): void;

interface OwnedComposeLifecycleBase<
  Role extends OwnedComposeRole,
  Scope extends OwnedComposeCommandScope
> {
  readonly role: Role;
  readonly composeScope: Scope;
  assertCollisionFree(): Promise<void>;
  attestRequiredBinds(input: {
    readonly configuration: OwnedComposeConfigurationLease<Role, Scope>;
    readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
  }): Promise<AttestedOwnedComposeLifecycle<Role, Scope>>;
  shutdown(): Promise<void>;
}

export interface OwnedPrimaryComposeLifecycle<
  Role extends 'maintenance' | 'source',
  Scope extends 'production-compose' | 'fixture-compose'
> extends OwnedComposeLifecycleBase<Role, Scope> {
  sealMutationManifest(
    registration: OwnedMutationManifestRegistrationForRole<Role>
  ): Promise<OwnedMutationManifestLeaseForRole<Role>>;
  cleanup(): Promise<OwnedCleanupReceipt<'final'>>;
  assertAbsent(): Promise<OwnedCleanupReceipt<'final'>>;
}

export interface OwnedReleaseSourceComposeLifecycle
  extends OwnedPrimaryComposeLifecycle<'source', 'production-compose'> {
  cleanupRehearsalResources(
    rehearsal: AttestedOwnedComposeLifecycle<'rehearsal', 'checkpoint-compose'>
  ): Promise<OwnedCleanupReceipt<'rehearsal'>>;
}

export interface OwnedRehearsalComposeLifecycle
  extends OwnedComposeLifecycleBase<'rehearsal', 'checkpoint-compose'> {}

export type OwnedComposeLifecycle =
  | OwnedPrimaryComposeLifecycle<'maintenance', 'production-compose'>
  | OwnedPrimaryComposeLifecycle<'maintenance', 'fixture-compose'>
  | OwnedReleaseSourceComposeLifecycle
  | OwnedRehearsalComposeLifecycle;

type OwnedComposeLifecycleForRole<Role extends OwnedComposeRole> =
  Role extends 'maintenance'
    ? | OwnedPrimaryComposeLifecycle<'maintenance', 'production-compose'>
      | OwnedPrimaryComposeLifecycle<'maintenance', 'fixture-compose'>
    : Role extends 'source'
      ? OwnedReleaseSourceComposeLifecycle
      : OwnedRehearsalComposeLifecycle;

export async function bindOwnedComposeConfiguration<
  Role extends OwnedComposeRole,
  Scope extends OwnedComposeCommandScope
>(input: {
  readonly lifecycle: OwnedComposeLifecycleForRole<Role> & {
    readonly composeScope: Scope;
  };
  readonly registeredImage: RegisteredRuntimeImage;
  readonly overrideBytes: Uint8Array;
  readonly expectedOrigin: string;
  readonly commandEnvironment: ReleaseControlCommandEnvironment<Scope>;
}): Promise<OwnedComposeConfigurationLease<Role, Scope>>;

export function resolveOwnedComposeConfiguration<
  Role extends OwnedComposeRole,
  Scope extends OwnedComposeCommandScope
>(input: {
  readonly lifecycle: OwnedComposeLifecycleForRole<Role> & {
    readonly composeScope: Scope;
  };
  readonly configuration: OwnedComposeConfigurationLease<Role, Scope>;
}): Readonly<{
  readonly overrideBytes: Uint8Array;
  readonly evidence: ComposeConfigurationEvidence;
}>;

export type AttestedOwnedComposeLifecycle<
  Role extends OwnedComposeRole,
  Scope extends OwnedComposeCommandScope
> =
  OwnedComposeLifecycleForRole<Role> & {
  readonly composeScope: Scope;
  readonly bindSet: OwnedComposeBindSet<Role, Scope>;
  run(args: readonly string[], options?: {
    readonly input?: Uint8Array;
    readonly timeoutMs?: number;
    }): Promise<BoundedCommandResult>;
  };

export function assertOwnedCheckpointComposeLifecycle(input:
  | {
      readonly identity: OwnedCheckpointIdentityLease;
      readonly role: 'source';
      readonly lifecycle: AttestedOwnedComposeLifecycle<'source', 'production-compose'>;
    }
  | {
      readonly identity: OwnedCheckpointIdentityLease;
      readonly role: 'rehearsal';
      readonly lifecycle: AttestedOwnedComposeLifecycle<'rehearsal', 'checkpoint-compose'>;
    }
): void;

export interface OwnedDockerProbeDependencies {
  readonly commands: ReleaseControlCommandSupervisor;
  readonly commandEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
}

export async function attestOwnedRawHelperBind(input: {
  readonly helper: OwnedRawHelperIdentityLease;
  readonly lease: RestrictedPathLease;
  readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
  readonly access: 'read-only' | 'read-write';
}, dependencies: OwnedDockerProbeDependencies): Promise<RestrictedDockerBindLease>;

export async function attestOwnedStorageVolumes<
  Role extends OwnedRawHelperRole
>(input: {
  readonly helper: Extract<OwnedRawHelperIdentityLease, { readonly role: Role }>;
  readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
  readonly bundleBind: RestrictedDockerBindLease;
}, dependencies: OwnedDockerProbeDependencies): Promise<
  CoordinatedStorageVolumeAccessSet<Role>
>;

export function consumeOwnedStorageVolumeAccess<
  Role extends OwnedRawHelperRole
>(input: {
  readonly helper: Extract<OwnedRawHelperIdentityLease, { readonly role: Role }>;
  readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
  readonly bundleBind: RestrictedDockerBindLease;
  readonly access: CoordinatedStorageVolumeAccessSet<Role>;
}): ResolvedCoordinatedStorageVolumeAccessSet<Role>;

export async function executeOwnedDockerRuntimeAudit(input: {
  readonly probe: OwnedImageProbeIdentityLease;
  readonly imageId: string;
}, dependencies: OwnedDockerProbeDependencies): Promise<AuditedDockerRuntimeIdentity>;

export function createOwnedComposeLifecycle(
  run: Extract<OwnedComposeRun, { readonly topology: 'productionMaintenance' }>,
  preparation: OwnedRunPreparation<OwnedProductionMaintenanceRunIdentity>,
  dependencies: OwnedComposeDependencies
): OwnedPrimaryComposeLifecycle<'maintenance', 'production-compose'>;

export function createOwnedComposeLifecycle(
  run: Extract<OwnedComposeRun, { readonly topology: 'releaseCandidate' }>,
  preparation: OwnedRunPreparation<OwnedReleaseRunIdentity>,
  dependencies: OwnedComposeDependencies
): OwnedReleaseSourceComposeLifecycle;

export function createOwnedComposeLifecycle(
  run: Extract<OwnedComposeRun, { readonly composeScope: 'fixture-compose' }>,
  preparation: OwnedRunPreparation<OwnedFixtureMaintenanceRunIdentity>,
  dependencies: OwnedComposeDependencies
): OwnedPrimaryComposeLifecycle<'maintenance', 'fixture-compose'>;

export function createOwnedRehearsalComposeLifecycle(
  identity: OwnedCheckpointIdentityLease,
  dependencies: OwnedComposeDependencies
): OwnedRehearsalComposeLifecycle;
```

`createOwnedRunPreparation` is pure and runs before lifecycle entry. It privately stores the exact opaque Task 5A dependency object; `assertOwnedRunPreparation` is the sole direct owner-side identity/preparation/dependency check and must run before lifecycle evidence-root acquisition, while all more-specific journal/receipt assertions reuse it internally. Every Task 6 temporary root is acquired through that exact preparation; `acquireTemporaryRoot` directly calls Task 5A's `createRestrictedPathLease` with only the stored `restrictedPathDependencies`, registers the returned authentic lease before resolving, and never accepts an injected lease factory. Lifecycle construction privately attaches itself to that same preparation before returning. Manifest sealing and both journals remain associated through the lifecycle. Before candidate handoff, `cleanupBeforeCandidateHandoff` removes every registered root/resource and uses an armed source journal to discover/remove an image created by a failed build. All shutdown, discovery/removal, rollback, and absence commands use the supervisor already bound into that dependency's `runCleanup()` path, so a sticky signal cannot block cleanup. It always returns an authenticated receipt: if candidate absence cannot be proved, `candidateAbsence: 'unproved'` necessarily carries a residual `cleanup_failed` attempt. Candidate construction performs its final disposition handoff from Task 6 to Task 6A and returns the `CandidateImageLease` in one synchronous no-throw step; no fallible or awaited work follows that handoff. Therefore evidence-root failure, partial lease acquisition, manifest-seal failure, and build rejection before a candidate is returned all have an authenticated cleanup path, while post-handoff cleanup must use the exact candidate.

Keep resource inventory formats exact (`ID` for containers/networks, `Name` for volumes), verify both Compose labels and Plan 7A owner labels, and return cleanup counters even when zero. A cleanup/inspection command failure must still return `result: 'residual'`: each registered resource whose absence was not positively proved counts as one conservative residual, so a zero is possible only after exact absence was observed. Retain raw causes privately. The returned `OwnedCleanupReceipt` is runtime-branded by this lifecycle and owns its exact absence reattestation; no caller-supplied repeat callback can manufacture a clean receipt. This gives `smoke.cleanup.failed` and optional failure evidence truthful four-field counts even when discovery itself fails. Temporary-root cleanup uses only manifest-registered canonical roots beneath the factory-owned per-producer prefix.

`cleanupRehearsalResources(rehearsal)` is a distinct release-only transition. It accepts only the exact attested rehearsal lifecycle privately associated with this source identity, thereby using the immutable `checkpoint-compose` command environment already authenticated and stored by that lifecycle's configuration bind while the source owner retains the complete manifest/journal authority. In order, it shuts down/removes only the rehearsal Compose containers/network/volumes, capture/rehearsal raw-helper remnants, the introduced restore image, the rehearsal Compose and secret materialization roots, and the transfer, checkpoint-bundle, and rehearsal-scratch roots; it then positively proves each absent and returns the rehearsal-scoped receipt consumed by Task 11. It must not stop or remove the source Compose project, source candidate, source Compose/secret materialization, evidence root, IID/manifest root, or other source runtime state needed by the later `runtime-*`, `inspect`, and `behavior` stages. The final `cleanup()` owns the surviving source Compose/resources, source Compose/secret materialization, IID, manifest, and other registered final temporary roots after shutdown, but explicitly excludes a successfully bound source candidate. Before configuration bind, no Compose mutation is possible: cleanup uses only the constructor's host-tools environment, exact labels, and registered manifest discovery. After a successful bind, shutdown/cleanup uses the exact stored role-scoped environment and never rebuilds or rereads it. Before candidate binding, Task 6 owns interrupted-journal image discovery/removal; binding atomically hands source-image disposition to the exact `CandidateImageLease`. Task 7's `evidence.ts` cleanup transaction then becomes the sole post-handoff disposition owner: it invokes Task 6A's `removeForFailure()` for domain failure, `prepareMaintenanceRemoval()` for maintenance success, or `prepareReleaseRetention()` for release success, and commits a success preparation only at publication. The final cleanup receipt proves only its closed non-image resource set absent and records that the bound source image is excluded after handoff; it cannot inspect Task 6A's private disposition state. Before trusting any receipt field or invoking its reattestation, Task 7 directly calls `assertOwnedFailureCleanupReceipt` or `assertOwnedFinalCleanupReceipt` with the exact identity/preparation. Task 11 directly calls `assertOwnedRehearsalCleanupReceipt` with the exact checkpoint identity before accepting rehearsal cleanup. `prepareSmokeCleanupTransaction` separately authenticates the exact `CandidateImageLease`, prepares the profile-fixed disposition, and combines it with that receipt. Tests pin the lifecycle association/dependency handoff, late environment bind, image handoff, both disjoint cleanup sets, order, idempotent reattestation, and cast/spread/cross-run rejection when a receipt, environment, or disposition from either scope is crossed.

`createOwnedRehearsalComposeLifecycle` is the only rehearsal constructor and derives its project, labels, restore context/engine, materialization roots, expected topology, and `checkpoint-compose` scope from the live checkpoint identity. Like every lifecycle constructor, it accepts only the authentic command supervisor plus the already-built `host-tools` environment; it accepts no Compose environment, caller scope override, or structural identity.

Preflight seals only identities, roots, expected resources, Task 6-derived labels, engine observations, and mutation journals; it neither records nor claims a resolved configuration fingerprint, candidate-dependent override, expected origin, or Compose environment. After build/load yields an exact `RegisteredRuntimeImage` and the consumer has generated every credential, port, private path, image, origin, and PostgreSQL slot, it directly calls Task 5's builder from the one captured environment source and supplies that complete immutable role-scoped environment plus the role's expected origin to `bindOwnedComposeConfiguration`. Before reading any supplied environment field or issuing a command, the binder directly calls Task 5's non-injected `assertReleaseControlCommandEnvironmentAssociation({ hostTools: lifecycleHostTools, scoped: commandEnvironment })`, then requires the exact scope to equal the lifecycle's constructor-derived `composeScope`. It derives the role's project/labels/topology/base/runtime inputs/PostgreSQL expectation, validates the supplied expected origin with Task 4's profile-specific parser, rerenders the Task 4 template, requires byte equality with the supplied defensive bytes, materializes the base/template pair, runs the one allowed read-only Compose-config command with that environment, requires its resolved origin to equal the validated expectation, canonicalizes it, and atomically stores the exact environment/origin association before minting a role-and-scope-branded lease. A failed association/config command stores nothing and leaves only host-tools cleanup available; an environment cannot be replaced after a successful bind. Source and rehearsal templates have the same image/PostgreSQL IDs but distinct public project labels, so their bytes and hashes must differ. Raw bytes, digests, an early/partial/structural/cross-source/cross-scope environment, a structural lease, pre-build configuration, wrong-journal image, replaced materialized file, or source/rehearsal swap is non-authorizing. The immutable manifest is never updated or appended. Task 4 stays pure; only Task 6 calls `exactPlan7aImageLabels` and `exactPlan7aOwnershipLabels`, resolves branded project/configuration objects, and holds the relevant WeakMaps. `assertOwnedCheckpointIdentityLease` is the sole owner-side authenticity check for that lease. `assertOwnedCheckpointComposeLifecycle` similarly proves the exact checkpoint identity, role, scope, base lifecycle, stored environment, configuration, bind set, and attested typestate before any outer checkpoint/evidence owner trusts it. `assertOwnedCandidateJournalAssociation` first authenticates the exact identity/preparation pair, then proves the source journal is the one sealed by their lifecycle; structural, cross-run, and cross-preparation inputs fail without relying on a public discriminator. `assertOwnedCandidateBuildRegistration` additionally requires `iidRoot` to be the exact manifest-registered `candidate-iid` lease from that preparation and requires the four safe context fields supplied by Task 6A as `sourceIdentity` to equal the manifest registration exactly, closing both writable-path and label-identity substitution before build.

The configuration binder's sole nonmutating Compose-config command always prepends `docker --context <dockerContext> compose --project-directory <composeRoot.root> --project-name <role-derived branded project> -f <base> -f <override>`; the role selects maintenance `identity.composeProject`, release `identity.composeProjects.source`, or checkpoint `identity.run.composeProjects.rehearsal`, and callers cannot replace it. The lifecycle's factory-produced `composeScope` must equal the runtime-branded environment scope, so a union or cross-profile environment is rejected. Every other Compose command, including mutating or bind-using `up`, `run`, `create`, `start`, `exec`, `stop`, `down`, volume, and later read-only inspection, exists only on `AttestedOwnedComposeLifecycle`, returned after the exact post-build `OwnedComposeConfigurationLease` plus both role-correct Compose-materialization and secret-root bind attestations. Those methods reuse the exact stored environment and accept no environment argument. The bind set is runtime-bound to the lifecycle, scope, project, configuration, environment, image, context, engine, and manifest; omitted, reconstructed, maintenance/source/rehearsal-crossed, or cross-run sets fail before Docker. Internal shutdown/cleanup remains available to the owner even if attestation failed: before configuration bind it uses host-tools discovery only, and afterward it uses the stored environment when a Compose command is required. The manifest is opened `wx` once, contains the complete precomputed mutation envelope, parsed engine IDs, source base-image set, registered PostgreSQL reference and both exact RepoDigest-backed local IDs, and both complete image baselines, and is strict-reread before any deletion; no update/append/raw-writer API exists. Only the source-build registered journal is accepted by Task 6A and only the restore-load journal by Task 12; a wrong-role journal, registration object, structural copy, or journal from another manifest fails. `executeOwnedDockerRuntimeAudit`, `attestRequiredBinds`, `attestOwnedRawHelperBind`, and `attestOwnedStorageVolumes` are the only high-level Docker probe launchers. `owned-compose.ts` alone imports Task 5A's `prepareRestrictedDockerBindProbe` and `verifyRestrictedDockerBindObservations`; they are implementation details, not dependency-injection fields. Task 6 derives the exact pre-registered container names, both label families, engine, and project/volume-project association from live capabilities; only its bind/volume launchers consume and privately verify Task 5A's non-authorizing prepared nonce envelope. The runtime audit itself inspects `Config.User`, launches the fixed hardened UID/GID/helper witness, and returns the Task 6 brand for either a locally inspected registry image or the eventual candidate raw ID without giving Task 5A naming authority. Every launcher registers the mutation before invoking Docker and cleans up an exact interrupted probe. `resolveRestrictedDockerBindLease`, `resolveOwnedComposeConfiguration`, and `consumeOwnedStorageVolumeAccess` validate exact WeakMap entries; storage access is single-use. A public Task 5A verifier result or structural copy never reaches an authorizing API. Callers cannot supply a container name, label, context, engine, user argument, or raw project.

- [ ] **Step 4: Prove GREEN and commit**

```powershell
npx vitest run `
  scripts/release-control/command-runtime.test.ts `
  scripts/release-control/owned-compose.test.ts `
  --reporter=verbose
npm run check
git --literal-pathspecs add -- `
  scripts/release-control/owned-compose.ts `
  scripts/release-control/owned-compose.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: extract owned Compose lifecycle"
```

### Task 6A: Build, inspect, retain, and remove one exact local candidate image

**Files:**
- Create: `scripts/release-control/candidate-image.ts`
- Create: `scripts/release-control/candidate-image.test.ts`

- [ ] **Step 1: Write registered-journal, exact-build, and two-phase lifetime REDs**

Accept only the exact runtime-branded `RegisteredSourceImageMutationJournal` returned by Task 6 together with the exact identity, preparation, and manifest-registered candidate-IID lease. Reject a restore-load journal, raw registration, structural lookalike, journal or IID lease from another manifest/context/engine/run/preparation, a mismatch in any of the context's four `SourceIdentity` fields, label mismatch, incomplete/noncanonical baseline/base set, or any build attempted before immutable manifest sealing. Require `context.dockerfileRequirements.baseImages` to equal the journal's ordered registered references exactly. Immediately before and after the build, reobserve the registered engine and inspect every registered `{ reference, imageId }`; each reference must still resolve locally to that exact ID. A missing/drifted base rejects without invoking build, or triggers registered cleanup if build already ran. (`--pull=false` prevents base refresh; it is not accepted as proof that a missing base cannot be fetched.) Against the injected authentic supervisor, then require one deterministic Task 3 ustar stream and this mutation shape: reserve the IID with Task 5A `wx`/private identity; run `docker --context <context> build --pull=false --target production --iidfile <same-reserved-file> --label <each of four Task-6-derived exact labels> --file Dockerfile -`; stream the context as bounded stdin; adopt only an in-place truncate/write of the same IID identity; strict-read one `sha256:<64 lowercase hex>` ID; inspect that raw ID; complete the owned runtime audit; and only then bind the ID/runtime identity through the journal to obtain `RegisteredRuntimeImage`.

Inspection must prove exact `.Id`, exactly the four expected Plan 7A label values, `Config.User === "node"`, and `RepoTags` exactly `[]`. Proving the actual node UID/GID and the presence of `build/services/storage-volume-backup-helper.js` requires one hardened no-network/cap-dropped/read-only container. Task 6A passes `journal.imageProbe` and the exact raw ID to Task 6's `executeOwnedDockerRuntimeAudit`, which registers the mutation and derives `--name`, all Plan 7A labels, the Compose project label, and the fixed service label before launch; anonymous or caller-named probes are forbidden. It removes and proves absence of that exact container after the command. Interrupt after create but before acknowledgement and prove Task 6 discovery removes it. The build/probe creates no mutable tag. A pre-existing identical raw ID is allowed only when it already has no tags and exact labels. Any extra/missing tag, ambiguous IID output, foreign label, image-ID drift, helper/user mismatch, probe residue, build acknowledgement failure, timeout, or interruption triggers registered-journal discovery; only an image absent from the baseline and matching every exact label may be removed.

Add owner-resolver REDs for the returned candidate itself: the exact object resolves; a spread, cast-only literal, proxy, serialized/reparsed copy, prototype clone, or safe-field-identical candidate from a different owner does not. No downstream test may pretend that checking `capability` or public-field equality authenticates a candidate.

Pin this runtime-branded API:

```ts
export interface CandidateImageLease {
  readonly capability: 'plan7a-candidate-image-v1';
  readonly imageId: string;
  readonly labels: Plan7aImageLabels;
  readonly frozenContext: FrozenBuildContext;
  readonly introducedByRun: boolean;
  readonly journal: RegisteredSourceImageMutationJournal;
  readonly registeredImage: RegisteredRuntimeImage;
  readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
  removeForFailure(): Promise<OwnedImageAbsenceReceipt>;
  prepareMaintenanceRemoval(): Promise<PreparedCandidateDisposition>;
  prepareReleaseRetention(): Promise<PreparedCandidateDisposition>;
  // Opaque runtime brand binds the inspected ID to the registered journal.
}

export interface ResolvedCandidateImageLease {
  readonly imageId: string;
  readonly labels: Plan7aImageLabels;
  readonly frozenContext: FrozenBuildContext;
  readonly introducedByRun: boolean;
  readonly journal: RegisteredSourceImageMutationJournal;
  readonly registeredImage: RegisteredRuntimeImage;
  readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
}

export function resolveCandidateImageLease(
  candidate: CandidateImageLease
): ResolvedCandidateImageLease;

export interface OwnedImageAbsenceReceipt {
  readonly capability: 'plan7a-owned-image-absence-v1';
  readonly imageId: string;
  readonly absentOrBaseline: true;
}

export interface PreparedCandidateDisposition {
  readonly capability: 'plan7a-prepared-candidate-disposition-v1';
  commit(): void;
  rollback(): Promise<OwnedImageAbsenceReceipt>;
}

export async function buildCandidateImage<I extends OwnedRunIdentity>(input: {
  readonly identity: I;
  readonly preparation: OwnedRunPreparation<I>;
  readonly context: FrozenBuildContext;
  readonly iidRoot: RestrictedPathLease;
  readonly journal: RegisteredSourceImageMutationJournal;
}, dependencies: {
  readonly commands: ReleaseControlCommandSupervisor;
  readonly commandEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
}): Promise<CandidateImageLease>;
```

Before inspecting a base, touching the IID lease, or invoking Docker, `buildCandidateImage` derives one plain `SourceIdentity` from the exact `context.sourceMode`, `.sourceClean`, `.sourceRevision`, and `.buildContextSha256`, then calls Task 6's non-injected `assertOwnedCandidateBuildRegistration` with that value plus its exact `identity`, `preparation`, `journal`, and `iidRoot`. It receives the labels only from the authenticated journal; it never constructs or accepts a separate label record. It directly calls Task 6's `executeOwnedDockerRuntimeAudit` with only the authentic supervisor and associated `host-tools` environment, then requires the journal owner to bind that exact authentic runtime identity; no caller supplies either owner operation. The candidate privately retains the exact `FrozenBuildContext` object whose defensive tar bytes were streamed; `frozenContext` returns that authentic object, not a digest-based reconstruction, and its byte getters continue returning copies. `resolveCandidateImageLease` is the only owner-side authenticity check and returns a frozen nonmutating view of the exact WeakMap entry; spread/cast/serialized objects and a candidate from another module instance fail. Every non-Task-6A consumer must call it before trusting even a public candidate field. `prepareMaintenanceRemoval` removes an introduced image and proves exact absence, or proves a baseline image remains unchanged. `prepareReleaseRetention` reobserves the exact engine/image/empty tag set/labels and leaves failure removal armed. Both return a module-branded prepared disposition whose `commit()` is a synchronous no-throw state transition and whose `rollback()` removes only an introduced exact image and proves absence. Repeated matching calls are idempotent; conflicting preparation, structural copies, post-commit removal, or deletion of a baseline/foreign image fails. Inject failure before and after every Docker/file/journal boundary, including a build that creates the image before IID acknowledgement.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run `
  scripts/release-control/owned-compose.test.ts `
  scripts/release-control/candidate-image.test.ts `
  --reporter=verbose
```

Expected: FAIL because the exact candidate-image owner does not exist.

- [ ] **Step 3: Implement the capability-gated image owner**

Keep Docker commands explicit-context and no-shell. Use Task 5's bounded byte runtime and Task 5A's same-identity IID reservation; never use a raw writer or path reread. Inventory/discovery always uses `image ls --all --no-trunc --quiet`, and removal always reinspects ID, empty `RepoTags`, and all four labels immediately before `docker image rm <raw-id>`. A command failure makes absence unproved and therefore cannot produce a success disposition.

- [ ] **Step 4: Prove GREEN and commit**

```powershell
npx vitest run `
  scripts/release-control/command-runtime.test.ts `
  scripts/release-control/restricted-path.test.ts `
  scripts/release-control/owned-compose.test.ts `
  scripts/release-control/candidate-image.test.ts `
  --reporter=verbose
npm run check
npm run lint -- --no-warn-ignored scripts/release-control/candidate-image.ts
git --literal-pathspecs add -- `
  scripts/release-control/candidate-image.ts `
  scripts/release-control/candidate-image.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: own exact local candidate images"
```

### Task 7: Make stage execution and evidence publication one fail-closed transaction

**Files:**
- Create: `scripts/release-control/evidence.ts`
- Create: `scripts/release-control/evidence.test.ts`
- Create: `scripts/release-control/evidence-inspect.ts`
- Create: `scripts/release-control/lifecycle.ts`
- Create: `scripts/release-control/lifecycle.test.ts`
- Modify: `scripts/observability-boundaries.test.ts`

- [ ] **Step 1: Write strict evidence construction, privacy, and consumption REDs**

Use fixed clocks and byte-level filesystem fakes to prove that a success record:

- has exactly the profile-discriminated keys from Task 2, with no unknown key at any depth;
- contains the profile's immutable `requiredStages` and one ordered successful outcome per stage;
- uses canonical UTC millisecond timestamps, sets `issuedAt === startedAt`, and derives `expiresAt` as exactly `completedAt + 86_400_000`;
- rejects clock regression, a stage/total duration above 86,400,000ms, a missing/duplicate/reordered stage, and any unsuccessful outcome;
- recursively rejects forbidden key names and privacy canaries, including inside arrays;
- omits `checkpoint` for `maintenance_fixture` and requires its exact safe fields for `release_candidate`;
- hashes the canonical record bytes without a fingerprint field;
- publishes only `<candidateId>-<64-lowercase-hex>.json` beneath its exclusively acquired evidence-root lease; and
- can be consumed only with the complete profile-discriminated `EvidenceExpectation` from Task 2 and a non-expired current time.

Exercise no-clobber publication through an authentic Task 5A lease bound to the exact Task 5 supervisor. Record this exact sequence: atomically acquire and verify the caller-selected non-existing platform-private root; open the unique partial with `wx`; write, synchronize, close, reread the same owned file identity, strict-parse, expectation-match, and verify canonical bytes; create the final hard link without replacement; synchronize the directory; and prepare lease retention. Each async operation except the last is invoked through `commands.awaitPublicationBoundary`, which checks the sticky signal immediately before and after without abandoning the in-flight filesystem mutation. The publisher then calls `commands.commitSuccessAfterPublicationBoundary(() => lease.privatePath.removeOwnedFile(partialName), commit)`. The fixed module-private `commit` closure synchronously and without throw commits the prepared path retention and exact cleanup/candidate transaction and returns the already-constructed published value. There is no await, logger call, allocation, validation, directory sync, or other fallible operation between the supervisor's post-removal signal check and those state flips. Until that linearization succeeds the root is provisional to this publisher; interruption/failure runs the existing same-identity rollback/removal and keeps any residue unconsumable. Reject a symlink/reparse point, caller-pre-existing or nonprivate root, unowned or cross-supervisor lease, filename/fingerprint mismatch, root reuse, overwrite, rename-overwrite fallback, multiple entries, and deletion of a committed record.

Give the best-effort failure publisher its own exact provisional-root closure. It is called only after authoritative domain cleanup and only when evidence-root acquisition returned a lease; acquisition failure therefore attempts no failure record. Construct/privacy-check the fixed failure record, then use ordinary interruptible Task 5A operations to open one unique partial with `wx`, write/file-sync/close, reread the same identity, strict-parse and verify canonical bytes, hard-link without replacement to `<candidateId>-<runId>-failure.json`, synchronize the root, and prepare retention. Finally remove the partial through the same ordinary lease path and, in that promise continuation with no intervening await, allocation, logging, or validation, call the prepared retention's synchronous no-throw `commit()`. A latched signal may stop any pre-commit step and make the optional record absent; no cleanup-command bypass or success-publication helper is used. On every pre-commit failure, roll back prepared retention when present, otherwise remove the exact owned partial/final/root, and reattest absence through the lease's signal-resistant same-identity cleanup path. Successful publication retains exactly one private root containing exactly one committed failure file. When rollback succeeds, failed/skipped publication leaves no owned root; an injected rollback/removal failure may leave only a provisional partial/final/root that the structural inspector must reject, and it still cannot replace the already selected primary/cleanup result or terminal event. REDs cover every boundary, signal before/after each boundary, root-acquisition failure, retention failure, rollback success, forced rollback failure, collision, and repeated publication.

The public API uses the complete Task 2 expectation rather than redefining it:

```ts
export interface EvidenceRootLease {
  readonly root: string;
  readonly ownershipToken: string;
  readonly privatePath: RestrictedPathLease;
}

export async function createEvidenceRootLease(
  target: string,
  ownershipToken: string,
  repositoryRoot: string,
  dependencies: RestrictedPathDependencies
): Promise<EvidenceRootLease>;

export type SmokeSuccessEvidenceDraft =
  | Omit<
      Extract<SmokeSuccessEvidenceV1, { readonly profile: 'maintenance_fixture' }>,
      'version' | 'issuedAt' | 'expiresAt' | 'requiredStages'
    >
  | Omit<
      Extract<SmokeSuccessEvidenceV1, { readonly profile: 'release_candidate' }>,
      'version' | 'issuedAt' | 'expiresAt' | 'requiredStages'
    >;

export type SmokeFailureEvidenceDraft =
  | Omit<
      Extract<SmokeFailureEvidenceV1, { readonly profile: 'maintenance_fixture' }>,
      'version'
    >
  | Omit<
      Extract<SmokeFailureEvidenceV1, { readonly profile: 'release_candidate' }>,
      'version'
    >;

export async function publishSmokeSuccessEvidence(
  lease: EvidenceRootLease,
  draft: Extract<
    SmokeSuccessEvidenceDraft,
    { readonly profile: 'maintenance_fixture' }
  >,
  expectation: Extract<
    EvidenceExpectation,
    { readonly profile: 'maintenance_fixture' }
  >,
  transaction: SmokeCleanupTransactionFor<
    'maintenance_fixture',
    'success-pending'
  >,
  commands: ReleaseControlCommandSupervisor
): Promise<PublishedSmokeEvidenceFor<'maintenance_fixture'>>;

export async function publishSmokeSuccessEvidence(
  lease: EvidenceRootLease,
  draft: Extract<
    SmokeSuccessEvidenceDraft,
    { readonly profile: 'release_candidate' }
  >,
  expectation: Extract<
    EvidenceExpectation,
    { readonly profile: 'release_candidate' }
  >,
  transaction: SmokeCleanupTransactionFor<
    'release_candidate',
    'success-pending'
  >,
  commands: ReleaseControlCommandSupervisor
): Promise<PublishedSmokeEvidenceFor<'release_candidate'>>;

export async function publishSmokeFailureEvidence(
  lease: EvidenceRootLease,
  draft: SmokeFailureEvidenceDraft
): Promise<void>;

export async function readExpectedSmokeSuccessEvidence(
  path: string,
  expectation: EvidenceExpectation,
  reader: RestrictedPathReader
): Promise<SmokeSuccessEvidenceV1>;

export interface PublishedSmokeEvidenceFor<Profile extends SmokeProfile> {
  readonly evidence: Extract<
    SmokeSuccessEvidenceV1,
    { readonly profile: Profile }
  >;
  readonly fingerprint: string;
  readonly fileName: string;
}

export type PublishedSmokeEvidence =
  | PublishedSmokeEvidenceFor<'maintenance_fixture'>
  | PublishedSmokeEvidenceFor<'release_candidate'>;
```

`lifecycle.ts` accumulates only the draft fields and ordered stage observations. `evidence.ts` alone derives `version`, immutable required stages, issued/expiry timestamps, canonical bytes, and the returned full success value inside `publishSmokeSuccessEvidence`; it likewise owns failure-record construction inside `publishSmokeFailureEvidence`. Tests reject a full preconstructed record, wrong-profile draft, caller-supplied derived field, structural cleanup transaction, omitted candidate, and maintenance/release disposition crossover.

`scripts/release-control/evidence-inspect.ts` accepts only `--evidence-root`, `--candidate-id`, `--producer`, `--profile`, `--now`, optional `--expected-origin`, and optional `--emit-safe-summary`. `--expected-origin` is required for `release_candidate`, may be the fixed production-maintenance origin, and is omitted only for the dynamically allocated fixture origin, whose exact loopback grammar is still validated. After pure argument validation, its thin composition root maps `process.platform` once to `posix`/`win32`, snapshots the ambient host environment into one Task 5 source and `host-tools` environment, creates one supervisor with `createNodeCommandProcessAdapter`, creates the Node host runtime from that exact source/environment/supervisor, creates one opaque Task 5A dependency from the same four objects, and disposes the never-rejecting supervisor in `finally`; tests inject only those low-level inputs/adapters and reject a second/preassembled supervisor, host runtime, or dependency. It first opens a read-only Task 5A reader and verifies retained POSIX permissions or Windows DACL/file identities. Through one stable owned-file snapshot it then requires exactly one committed success file and no partial/failure/extra entry, verifies strict schema, canonical bytes, filename fingerprint, producer/profile/candidate/origin expectations, and nonexpiry, and exits nonzero on disagreement. With `--emit-safe-summary`, it writes one bounded canonical JSON line containing only `fingerprint`, `imageId`, `buildContextSha256`, `sourceRevision`, `sourceMode`, `sourceClean`, `origin`, safe image labels, required stage/outcome codes, safe checkpoint/cleanup fields, `completedAt`, and `expiresAt`; it never emits raw file bytes or paths. Full generated-field expectation matching remains an in-process pre-link requirement, where independent values are still available.

- [ ] **Step 2: Write lifecycle ordering, failure, and structured-event REDs**

Provide injected callbacks that append their stage name. Require the exact immutable sequence for both profiles, matching `smoke.stage.started`/`smoke.stage.succeeded` pairs beginning with `preflight`, exactly one authoritative `smoke.cleanup.succeeded` or `smoke.cleanup.failed`, and then `smoke.run.succeeded` only after cleanup and evidence publication. Every terminal failure path must attempt exactly one `smoke.run.failed` after the cleanup event, with the original failed stage unless cleanup/publication is the first failure, the final fixed public code, total bounded duration, and exact profile/run/candidate fields. Verify all payloads pass the existing logger schemas; do not invent `smoke.run.started` or any other event.

For every stage boundary, use a real Task 5 supervisor over a fake process adapter and inject callback rejection, timeout, caller abort, SIGINT, SIGTERM, shutdown rejection, residual-resource detection, cleanup inspection failure, and failure at every publication step. Trigger each signal both before and after every domain callback, between two commands inside one callback, during shutdown, during domain-failure cleanup, during success-pending cleanup, during rollback, and before/during/after evidence-root acquisition, write, file sync, reread, hard link, directory sync, retention preparation, and final partial removal. Prove the first signal is sticky, no later domain command spawns, shutdown/cleanup still use bounded `runCleanup()` and finish their one authoritative attempt, listeners remain installed inside the synchronous success commit closure, a post-commit signal cannot change success, and disposal twice removes the listener pair once and never rejects. A signal observed during success-pending cleanup rolls back that already prepared transaction and reattests absence; it does not invoke the cleanup callback a second time. The optional failure-record writer uses ordinary interruptible lease operations, so a latched signal may make that best-effort record absent without changing the primary result, cleanup, or terminal event. Explicitly cover evidence-root acquisition failure with an empty authenticated preparation, partial preflight before lifecycle creation, manifest failure, build failure before candidate handoff, and failure after candidate handoff; require the first four to use the pre-handoff receipt and the last to require the exact candidate/final receipt. Prove `Object.is` identity equality across lifecycle input, preparation, exact restricted-path dependency/supervisor, callbacks, labels/events, and evidence, and reject structural/cross-run/cross-supervisor preparation before evidence-root acquisition. Add compile-time fixtures proving that cleanup callbacks preserve both profile and intent, callers cannot supply a separate profile, domain-failure transactions cannot enter either success publisher, and each publisher accepts only its same-profile clean `success-pending` transaction plus the authentic supervisor. Separately inject rejection of every structured-log attempt and prove logging alone never changes callback progression, evidence, cleanup, or the returned domain result. For a release success path, prepare candidate retention only after every other resource is absent. A publication failure or pre-commit interruption must roll that preparation back, remove an introduced source image, repeat the exact absence attempt, and publish no success; a committed success retains it. The terminal-failure assertions are:

1. no later domain stage runs after the primary failure;
2. `shutdown` is attempted when runtime resources may be running;
3. `cleanup` is always attempted exactly once;
4. cleanup cannot replace the private primary cause, but cleanup failure forces the fixed public code `cleanup_failed`;
5. no success evidence exists on any failure;
6. the optional failure record has only `version`, `producer`, `profile`, `runId`, `candidateId`, `stage`, `code`, `startedAt`, `completedAt`, and `cleanup`, is published at most once as `<candidateId>-<runId>-failure.json` after cleanup was attempted, and cannot replace the primary result if its best-effort publication fails; and
7. `smoke.run.failed` is invoked exactly once after the authoritative cleanup event on callback, timeout, signal, shutdown, cleanup, residual, and publication failure, even when that best-effort terminal event attempt itself rejects; and
8. logger failure never changes callback, cleanup, or returned-domain behavior.

Define the callback and accumulated evidence surfaces explicitly:

```ts
export interface BuildStageEvidence {
  readonly imageId: string;
  readonly imageLabels: Plan7aImageLabels;
  readonly sourceMode: SourceMode;
  readonly sourceClean: boolean;
  readonly sourceRevision: string;
  readonly buildContextSha256: string;
}

export type ComposeStageEvidence = ComposeConfigurationEvidence;

export interface CaptureStageEvidence {
  readonly backupId: string;
  readonly backupManifestSha256: string;
  readonly captureDockerEngineId: DockerEngineId;
  readonly sourceCatalogResult: 'verified';
  readonly replacementDisposition: 'clear' | 'blocked';
}

export interface RestoreStageEvidence {
  readonly backupId: string;
  readonly restoreDockerEngineId: DockerEngineId;
  readonly restoreCatalogResult: 'verified';
  readonly replacementDisposition: 'clear' | 'blocked';
  readonly rehearsalCleanup: ZeroCleanupEvidence;
}

interface SmokeStageCallbacksCommon<Profile extends SmokeProfile> {
  readonly preflight: () => Promise<void>;
  readonly build: () => Promise<BuildStageEvidence>;
  readonly composeConfig: (build: BuildStageEvidence) => Promise<ComposeStageEvidence>;
  readonly migrate: () => Promise<void>;
  readonly provision: () => Promise<{
    readonly migrationTip: MigrationTipEvidence;
    readonly databaseRoleAttestation: DatabaseRoleAttestation;
  }>;
  readonly runtimeStart: () => Promise<void>;
  readonly runtimeHealth: () => Promise<void>;
  readonly inspect: () => Promise<void>;
  readonly behavior: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly cleanup: SmokeCleanupCallback<Profile>;
}

export interface SmokeCleanupCallback<Profile extends SmokeProfile> {
  (intent: 'domain-failure'): Promise<
    SmokeCleanupTransactionFor<Profile, 'domain-failure'>
  >;
  (intent: 'success-pending'): Promise<
    SmokeCleanupTransactionFor<Profile, 'success-pending'>
  >;
}

export type SmokeStageCallbacks =
  | (SmokeStageCallbacksCommon<'maintenance_fixture'> & {
      readonly profile: 'maintenance_fixture';
      readonly checkpointCapture?: never;
      readonly restoreRehearsal?: never;
    })
  | (SmokeStageCallbacksCommon<'release_candidate'> & {
      readonly profile: 'release_candidate';
      readonly checkpointCapture: () => Promise<CaptureStageEvidence>;
      readonly restoreRehearsal: (
        capture: CaptureStageEvidence
      ) => Promise<RestoreStageEvidence>;
    });

export type MaintenanceSmokeStageCallbacks = Extract<
  SmokeStageCallbacks,
  { readonly profile: 'maintenance_fixture' }
>;

export type ReleaseSmokeStageCallbacks = Extract<
  SmokeStageCallbacks,
  { readonly profile: 'release_candidate' }
>;

interface SmokeCleanupTransactionCommon {
  readonly capability: 'plan7a-smoke-cleanup-transaction-v1';
  readonly attempt: CleanupAttempt;
  // Opaque runtime brand binds the final receipt and candidate disposition.
}

type CleanCleanupAttempt = Extract<CleanupAttempt, { readonly result: 'clean' }>;

export type SmokeCleanupTransaction = SmokeCleanupTransactionCommon & (
  | {
      readonly profile: 'maintenance_fixture';
      readonly intent: 'domain-failure';
      readonly candidateDisposition: 'remove';
    }
  | {
      readonly profile: 'maintenance_fixture';
      readonly intent: 'success-pending';
      readonly candidateDisposition: 'remove';
      readonly attempt: CleanCleanupAttempt;
    }
  | {
      readonly profile: 'release_candidate';
      readonly intent: 'domain-failure';
      readonly candidateDisposition: 'remove';
    }
  | {
      readonly profile: 'release_candidate';
      readonly intent: 'success-pending';
      readonly candidateDisposition: 'retain';
      readonly attempt: CleanCleanupAttempt;
    }
);

export type SmokeCleanupTransactionFor<
  Profile extends SmokeProfile,
  Intent extends 'domain-failure' | 'success-pending'
> = Extract<
  SmokeCleanupTransaction,
  { readonly profile: Profile; readonly intent: Intent }
>;

type DomainFailureCleanupInputFor<I extends OwnedRunIdentity> =
  | {
      readonly identity: I;
      readonly preparation: OwnedRunPreparation<I>;
      readonly intent: 'domain-failure';
      readonly receipt: OwnedFailureCleanupReceipt<I['profile']>;
      readonly candidateImage?: never;
    }
  | {
      readonly identity: I;
      readonly preparation: OwnedRunPreparation<I>;
      readonly intent: 'domain-failure';
      readonly receipt: OwnedCleanupReceipt<'final'>;
      readonly candidateImage: CandidateImageLease;
    };

type SuccessPendingCleanupInputFor<I extends OwnedRunIdentity> = {
  readonly identity: I;
  readonly preparation: OwnedRunPreparation<I>;
  readonly intent: 'success-pending';
  readonly receipt: OwnedCleanupReceipt<'final'>;
  readonly candidateImage: CandidateImageLease;
};

type SmokeCleanupTransactionInputFor<I extends OwnedRunIdentity> =
  | DomainFailureCleanupInputFor<I>
  | SuccessPendingCleanupInputFor<I>;

export type SmokeCleanupTransactionInput =
  SmokeCleanupTransactionInputFor<OwnedRunIdentity>;

export async function prepareSmokeCleanupTransaction<I extends OwnedRunIdentity>(
  input: DomainFailureCleanupInputFor<I>
): Promise<SmokeCleanupTransactionFor<I['profile'], 'domain-failure'>>;

export async function prepareSmokeCleanupTransaction<I extends OwnedRunIdentity>(
  input: SuccessPendingCleanupInputFor<I>
): Promise<SmokeCleanupTransactionFor<I['profile'], 'success-pending'>>;

export function authenticateSmokeCleanupTransaction<
  I extends OwnedRunIdentity
>(
  transaction: SmokeCleanupTransaction,
  expectation: {
    readonly identity: I;
    readonly preparation: OwnedRunPreparation<I>;
    readonly intent: 'domain-failure' | 'success-pending';
  }
): CleanupAttempt;

type SmokeLifecycleInputFor<I extends OwnedRunIdentity> =
  I extends OwnedRunIdentity
    ? {
        readonly identity: I;
        readonly preparation: OwnedRunPreparation<I>;
        readonly evidenceRootTarget: string;
      }
    : never;

export type MaintenanceSmokeLifecycleInput =
  SmokeLifecycleInputFor<OwnedMaintenanceRunIdentity>;
export type ReleaseSmokeLifecycleInput =
  SmokeLifecycleInputFor<OwnedReleaseRunIdentity>;
export type SmokeLifecycleInput =
  | MaintenanceSmokeLifecycleInput
  | ReleaseSmokeLifecycleInput;

export function createStructuredSmokeEventEmitter(input: {
  readonly producer: SmokeProducer;
  readonly now: () => Date;
}): (event: SmokeEventInput) => void;

export interface SmokeLifecycleDependencies {
  readonly now: () => Date;
  readonly emit: (event: SmokeEventInput) => void;
  readonly repositoryRoot: string;
  readonly commands: ReleaseControlCommandSupervisor;
  readonly restrictedPathDependencies: RestrictedPathDependencies;
}

export async function runSmokeLifecycle(
  input: MaintenanceSmokeLifecycleInput,
  callbacks: MaintenanceSmokeStageCallbacks,
  dependencies: SmokeLifecycleDependencies
): Promise<PublishedSmokeEvidenceFor<'maintenance_fixture'>>;

export async function runSmokeLifecycle(
  input: ReleaseSmokeLifecycleInput,
  callbacks: ReleaseSmokeStageCallbacks,
  dependencies: SmokeLifecycleDependencies
): Promise<PublishedSmokeEvidenceFor<'release_candidate'>>;
```

`createStructuredSmokeEventEmitter` is Task 7's sole default smoke-event adapter. It directly calls the existing `createStructuredLogger({ service: input.producer, environment: 'production', now: input.now })` once, returns only its typed `emit` closure, adds no event registry or sink, and performs no emission at construction. The production logger's fixed failure record remains its only fallback; `runSmokeLifecycle` additionally treats every injected/default emitter call as best effort so even a structurally valid injected emitter that throws cannot alter stage, cleanup, evidence, or the returned domain result. Focused tests pin the exact producer and identical clock-function object, default stdout/stderr ownership, one logger construction per consumer invocation, no console fallback, and rejection-safe progression for every event location.

Before emitting or acquiring anything, the lifecycle directly calls Task 5's `assertReleaseControlCommandSupervisor(dependencies.commands)`, Task 5A's `assertRestrictedPathSupervisorAssociation({ dependencies: dependencies.restrictedPathDependencies, commands: dependencies.commands })`, and Task 6's non-injected `assertOwnedRunPreparation({ identity: input.identity, preparation: input.preparation, restrictedPathDependencies: dependencies.restrictedPathDependencies })`. It also requires the preparation's privately stored dependency to be that exact same object, then calls `dependencies.commands.assertUninterrupted()`. Only then does it derive producer, profile, run ID, candidate ID, and ownership token from the authenticated identity. It directly calls `createEvidenceRootLease` with the exact restricted-path dependency and wraps that await with the supervisor's before/after interruption checks; `evidenceRootTarget` acquisition remains the first run-owned external-resource mutation in `preflight`, so the CLI never mutates it outside the stage machine. Even acquisition failure invokes cleanup exactly once against the still-empty authenticated preparation. CLI parsing or identity-factory rejection happens before a run exists and therefore creates no run-scoped event/evidence or external-resource mutation. `maintenance_fixture` rejects checkpoint callbacks. `release_candidate` requires both checkpoint callbacks, identical capture/restore backup IDs, distinct engine IDs, matching source/restore disposition, and `clear` before success. A caller cannot provide a stage array.

- [ ] **Step 3: Run the REDs**

```powershell
npx vitest run `
  scripts/release-control/evidence.test.ts `
  scripts/release-control/lifecycle.test.ts `
  scripts/observability-boundaries.test.ts `
  --reporter=verbose
```

Expected: FAIL because neither evidence nor lifecycle ownership exists.

- [ ] **Step 4: Implement canonical publication and the fixed stage machine**

Reuse Task 2 strict parsers and Task 5 supervisor classifications. Keep raw exceptions private. Map public failures only to the seven registered safe smoke codes. For every domain stage through `behavior`, the lifecycle authenticates/checks the supervisor, emits the best-effort started event, awaits the callback, checks the sticky latch immediately after settlement, and only then accepts the stage result/emits success. Task 5's `run()` independently rejects a signal between two commands inside one callback before the later spawn. On a domain failure or interruption, no later domain callback runs. `shutdown` and the one cleanup callback are still attempted when applicable, and every command in shutdown, cleanup, rollback, and absence reattestation uses the same supervisor's `runCleanup()` path so a process signal cannot cancel authoritative cleanup. A signal during nominal shutdown or success-pending cleanup is checked after that operation settles, becomes the primary `interrupted` result if no earlier failure exists, and rolls back the already prepared success transaction; cleanup is never called twice. Timeout/output/spawn/close bounds still apply to cleanup commands. Failure-record publication remains optional and uses the ordinary interruptible Task 5A lease operations: after a latched signal its Windows ACL work may reject before spawn, which is an allowed best-effort publication failure and never changes cleanup, the selected safe code, or terminal-event order.

A pre-handoff domain failure consumes only Task 6's runtime-branded `OwnedFailureCleanupReceipt`; a post-handoff domain failure or every success-pending path consumes the exact `OwnedCleanupReceipt<'final'>` plus `CandidateImageLease`. Before any candidate method or public field is trusted, `evidence.ts` calls Task 6A's `resolveCandidateImageLease`, then calls Task 6's `assertOwnedCandidateJournalAssociation` with the exact lifecycle identity/preparation and resolved journal. This makes structural candidates and genuine candidates from another run fail before disposition. An unproved resource/image counts as residual, all four counts always exist, and only a clean exact-zero final attempt permits success construction. The preparation API accepts no caller-provided attempt or repeat callback; any required repeat goes through the bound receipt's `reattestAbsence()` method. Candidate-free `success-pending`, candidate-free post-handoff cleanup, structural/cross-run/wrong-preparation receipts, and wrong-profile disposition are rejected.

Every consumer cleanup callback follows this exact split (with its own typed state):

```ts
if (state.image === undefined) {
  if (intent !== 'domain-failure') {
    throw new Error('success-pending requires a candidate image');
  }
  const receipt = await state.preparation.cleanupBeforeCandidateHandoff();
  return prepareSmokeCleanupTransaction({
    identity: state.identity,
    preparation: state.preparation,
    intent,
    receipt
  });
}

const receipt = await requirePrimaryLifecycle(state).cleanup();
if (intent === 'success-pending') {
  return prepareSmokeCleanupTransaction({
    identity: state.identity,
    preparation: state.preparation,
    intent: 'success-pending',
    receipt,
    candidateImage: state.image
  });
}
return prepareSmokeCleanupTransaction({
  identity: state.identity,
  preparation: state.preparation,
  intent: 'domain-failure',
  receipt,
  candidateImage: state.image
});
```

Structured emission must call the existing safe logger behind a best-effort adapter. Do not add a second event registry, duplicate payload validator, or console fallback containing raw data. On failure, emit/attempt `smoke.stage.failed`, then the single cleanup event, then exactly one terminal `smoke.run.failed`; failure-record construction/writing is best effort and uses only ordinary interruptible lease operations, while a failed publication's same-identity rollback alone uses the cleanup path. Neither alters that event order or the selected safe code.

Owned-resource absence plus the candidate disposition completes and timestamps the provisional `cleanup` outcome. `evidence.ts` is the single owner of `prepareSmokeCleanupTransaction`, `authenticateSmokeCleanupTransaction`, the transaction WeakMap/private brand, its private success-only commit/rollback operations, and both publication functions; `lifecycle.ts` directly imports and calls those owner functions and exposes no injectable success/failure publisher. Tests inject only the low-level restricted-path/file failure points beneath the authentic evidence-root lease and exact supervisor association. Candidate-free domain failure authenticates the exact identity/preparation/pre-handoff receipt and records that candidate absence was proved without a handoff. Candidate-backed domain failure authenticates the exact final receipt and candidate, calls the profile-independent Task 6A `removeForFailure()` operation immediately, proves absence, and returns a `domain-failure` transaction with no prepared disposition, commit operation, or rollback operation; it can never enter success publication. Only `success-pending` authenticates an exact clean-zero final receipt and candidate and prepares a rollback-capable, profile-fixed Task 6A disposition: `prepareMaintenanceRemoval()` for maintenance or `prepareReleaseRetention()` for release. Reject a structural/lookalike, cross-run, cross-supervisor, nonclean, or wrong-intent transaction before writing evidence.

Construct the full record and strict-parse/cross-field/expectation-match the partial bytes against independently accumulated callback results before linking. Before using `commands`, `evidence.ts` directly calls `assertRestrictedPathLeaseSupervisorAssociation({ lease: lease.privatePath, commands })`; a structural/cross-supervisor pair fails before a write or commit. Every awaited success-publication boundary then uses that authentic supervisor guard. After the hard link, directory sync, and prepared retention exist, `evidence.ts` passes the final partial removal plus its fixed private commit closure to `commitSuccessAfterPublicationBoundary`; the supervisor performs the post-await interruption check and both no-throw state flips in one continuation before resolving. There is no circular hook, post-commit async domain operation, caller-supplied commit closure, or caller-forge gap. Only afterward does the lifecycle emit `smoke.stage.succeeded` for `cleanup`, `smoke.cleanup.succeeded`, and best-effort `smoke.run.succeeded`; it does not reread or run another required operation. The outer composition root keeps the process listeners installed until this lifecycle promise resolves/rejects, then awaits the same supervisor's never-rejecting idempotent `dispose()` in `finally`. Any pre-commit interruption or publication failure invokes the success transaction's private prepared-disposition rollback followed by its owned cleanup reattestation, uses the authoritative follow-up attempt's conservative counts, yields `stage: 'cleanup'` and fixed safe code `interrupted` for a latched signal or `unexpected_failure` unless rollback itself forces `cleanup_failed`, leaves an unconsumable or removed provisional target, emits/attempts `smoke.stage.failed`, `smoke.cleanup.failed`, and exactly one `smoke.run.failed`, and creates no duplicate outcome.

- [ ] **Step 5: Prove GREEN and commit**

```powershell
npx vitest run `
  scripts/release-control/contracts.test.ts `
  scripts/release-control/evidence.test.ts `
  scripts/release-control/command-runtime.test.ts `
  scripts/release-control/owned-compose.test.ts `
  scripts/release-control/lifecycle.test.ts `
  src/lib/server/observability/contracts.test.ts `
  scripts/observability-boundaries.test.ts `
  --reporter=verbose
npm run check
npm run lint -- --no-warn-ignored `
  scripts/release-control/evidence.ts `
  scripts/release-control/evidence-inspect.ts `
  scripts/release-control/lifecycle.ts
git --literal-pathspecs add -- `
  scripts/release-control/evidence.ts `
  scripts/release-control/evidence.test.ts `
  scripts/release-control/evidence-inspect.ts `
  scripts/release-control/lifecycle.ts `
  scripts/release-control/lifecycle.test.ts `
  scripts/observability-boundaries.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: orchestrate fixed smoke stages and evidence"
```

## Milestone C - separate maintenance consumers

### Task 8: Move production maintenance smoke onto the shared foundation

**Files:**
- Modify: `scripts/plan6b-production-smoke.ts`
- Modify: `scripts/plan6b-production-smoke.test.ts`
- Modify: `scripts/worker-heartbeat-deployment.test.ts`
- Modify: `scripts/observability-boundaries.test.ts`
- Modify: `scripts/commerce-operations.test.ts`

- [ ] **Step 1: Freeze all existing behavior before changing ownership**

Add characterization tests for the existing Plan 6B production behaviors: two idempotent migration runs, four distinct role logins and denials, storage mounts/ownership, cleanup dry-run, maintenance 503 responses, worker live/stale/missing-slot states, Stripe-disabled state, no provider network, financial replay/diagnostics, Caddy-only publication, graceful stop, exact cleanup, and bounded aggregate output.

Then add REDs for the new CLI contract:

```powershell
npm run smoke:plan6b -- --candidate-id 11111111-1111-4111-8111-111111111111 `
  --evidence-root C:\temp\pale-orbit-plan6b-evidence
```

Tests must reject missing/duplicate/unknown flags, a reused or relative evidence root, a noncanonical UUID, any source mode other than `workspace_fixture`, and any externally supplied image/tag/project/owner/stage. Pin producer `plan6b-production-smoke`, profile `maintenance_fixture`, the fixed `.invalid` canonical origin, and absence of `checkpoint`. Characterize the one legacy-compatible context seam: injected host `DOCKER_CONTEXT` selects a canonical explicit context or absence selects `default`; preflight observes/binds that engine ID, every Docker argv carries `--context`, and no child environment contains `DOCKER_CONTEXT`.

- [ ] **Step 2: Write shared-build and lifecycle-adoption REDs**

Inject only the low-level Git/filesystem/command/environment/clock/entropy/failure boundaries beneath the real directly imported Task 3-7 owners, including Task 5's `ReleaseControlPortRuntime` beneath the directly imported shared port-owner factory, and require the consumer to:

- immediately after lifecycle-owned evidence-root acquisition, freeze and store one defensive-copy workspace snapshot, its stability fence, later-input registry, and `buildContextSha256` before any Docker argv or port-runtime call, then release its retained references after cleanup;
- build target `production` from only its deterministic tar, using a private IID lease and exactly the four labels;
- accept only the inspected raw `imageId`, pass it through the generated override, and set `pull_policy: never`;
- call the immutable maintenance stages once in order;
- register owned resources before mutations and delegate shutdown/cleanup to `OwnedComposeLifecycle`;
- create every IID/Compose/secret/evidence root through the shared platform-private lease and never pass a raw root to a mutating helper;
- only after that frozen snapshot succeeds, attest the selected maintenance context as coordinator-local before socket allocation, allocate HTTP with `allocateLoopbackPort(context)` and HTTPS with `allocateLoopbackPort(context, true, httpPort)` exactly once during preflight, reject an unsafe or equal result, store those exact ports, and probe the same HTTP/TCP and HTTPS/TCP+UDP ports through that exact context capability immediately before the first command that can bind them;
- retain its existing maintenance-specific stage assertions; and
- remove an introduced maintenance image only when pre-build absence and post-build label identity both prove ownership.

The production unit tests inject a fake `CommandProcessAdapter` beneath the authentic one-run Task 5 supervisor, in-memory Git/build-context filesystem fakes, a fake `RestrictedPathHostRuntime` beneath Task 5A, and a deterministic fake `ReleaseControlPortRuntime` beneath the directly imported port-owner factory. Assert the exact trace `evidence-root -> frozen-source/digest -> context-attestation -> HTTP allocation -> HTTPS allocation -> subordinate roots -> lifecycle -> manifest seal`; every freezer/source-shape failure yields zero Docker argv and zero port calls across cleanup, while a remote or engine-drifting context fails after freeze but before a socket or Compose command. Prove that the unit run opens no real socket/network/process, that the same supervisor is bound into the supervised Git adapter, Task 5A, and Task 7, and that it is disposed only after terminal handling. With the owner modules mocked before a dynamic import of the consumer, the no-dependency construction RED pins the canonical module-derived root, one ambient environment/platform snapshot, a `DOCKER_CONTEXT` reader closed over that snapshot, the exact shared `now` closure, producer-specific structured emitter, Task 6 entropy adapter, Task 5 process/port adapters, and the post-supervisor Git/build-filesystem/restricted-host factories plus their exact source/environment/supervisor/root associations. Mutating `process.env` or substituting ambient platform after construction cannot change the captured context or command-environment input; each clock call constructs a fresh current `Date`, while the lifecycle and logger receive the identical clock-function object. The entropy adapter draws nothing and the emitter emits nothing during construction. Remove the local `ProductionSmokePortLease`, `ProductionSmokePortRuntime`, `ProductionSmokePortOperations`, and `createProductionSmokePortOperations` declarations/implementation and update their repository-internal test imports to Task 5's shared types/factories; do not leave a compatibility alias or a second algorithm.

Expected RED: the current script owns Git/Docker/Compose/resource lifecycle itself, accepts a stage argument, and returns no Plan 7A evidence.

- [ ] **Step 3: Run the production-adoption REDs**

```powershell
npx vitest run `
  scripts/plan6b-production-smoke.test.ts `
  scripts/commerce-operations.test.ts `
  scripts/worker-heartbeat-deployment.test.ts `
  scripts/observability-boundaries.test.ts `
  --maxWorkers=1 --reporter=verbose
```

Expected: FAIL on the new flag grammar, shared owners, local-context/port boundary, exact maintenance stages/evidence, and removal of the legacy `Plan6bSmokeStage` contract; existing behavior characterizations pass.

- [ ] **Step 4: Refactor with consumer-specific callback factories**

Keep the script as the production maintenance composition root. Replace legacy image lease and duplicated ownership types with:

```ts
export interface ProductionMaintenanceSmokeInput {
  readonly candidateId: string;
  readonly evidenceRoot: string;
}

interface ProductionMaintenanceState {
  readonly identity: OwnedProductionMaintenanceRunIdentity;
  readonly preparation: OwnedRunPreparation<OwnedProductionMaintenanceRunIdentity>;
  readonly commandEnvironmentSource: ReleaseControlCommandEnvironmentSource;
  readonly hostToolsEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
  readonly commands: ReleaseControlCommandSupervisor;
  readonly restrictedPathDependencies: RestrictedPathDependencies;
  readonly portOperations: ReleaseControlPortOperations;
  snapshot?: FrozenBuildContext;
  publishedLoopbackContext?: CoordinatorPublishedLoopbackContext;
  ports?: Readonly<{ readonly http: number; readonly https: number }>;
  candidateIidRoot?: RestrictedPathLease;
  secretRoot?: RestrictedPathLease;
  image?: CandidateImageLease;
  compose?: OwnedPrimaryComposeLifecycle<'maintenance', 'production-compose'>;
  attestedCompose?: AttestedOwnedComposeLifecycle<
    'maintenance',
    'production-compose'
  >;
  configuration?: OwnedComposeConfigurationLease<
    'maintenance',
    'production-compose'
  >;
  mutationManifest?: Extract<
    OwnedMutationManifestLease,
    { readonly profile: 'maintenance_fixture' }
  >;
  database?: AuthenticatedDatabaseState<'maintenance'>;
}

export interface ProductionMaintenanceDependencies {
  readonly repositoryRoot: string;
  readonly restrictedPathHostRuntime?: RestrictedPathHostRuntime;
  readonly git?: GitSnapshotRuntime;
  readonly fileSystem?: BuildContextFileSystem;
  readonly readHostDockerContext: () => string | undefined;
  readonly portRuntime: ReleaseControlPortRuntime;
  readonly commandProcessAdapter: CommandProcessAdapter;
  readonly commandEnvironmentInput: ReleaseControlCommandEnvironmentSourceInput;
  readonly now: () => Date;
  readonly emit: (event: SmokeEventInput) => void;
  readonly entropy: ReleaseControlEntropy;
}

type ResolvedProductionMaintenanceDependencies =
  Omit<
    ProductionMaintenanceDependencies,
    'restrictedPathHostRuntime' | 'git' | 'fileSystem'
  > & Required<Pick<
    ProductionMaintenanceDependencies,
    'restrictedPathHostRuntime' | 'git' | 'fileSystem'
  >>;

function createDefaultProductionMaintenanceDependencies():
  ProductionMaintenanceDependencies {
  const repositoryRoot = realpathSync.native(
    fileURLToPath(new URL('../', import.meta.url))
  );
  const hostEnvironment = Object.freeze({ ...process.env });
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  const now = () => new Date();
  return Object.freeze({
    repositoryRoot,
    readHostDockerContext: () => hostEnvironment.DOCKER_CONTEXT,
    portRuntime: createNodeReleaseControlPortRuntime(),
    commandProcessAdapter: createNodeCommandProcessAdapter(),
    commandEnvironmentInput: { platform, hostEnvironment },
    now,
    emit: createStructuredSmokeEventEmitter({
      producer: 'plan6b-production-smoke',
      now
    }),
    entropy: createNodeReleaseControlEntropy()
  });
}

function createProductionMaintenanceCallbacks(
  state: ProductionMaintenanceState,
  dependencies: ResolvedProductionMaintenanceDependencies
): MaintenanceSmokeStageCallbacks;

export async function runProductionSmoke(
  input: ProductionMaintenanceSmokeInput,
  dependencies?: ProductionMaintenanceDependencies
): Promise<PublishedSmokeEvidenceFor<'maintenance_fixture'>>;
```

After validating the input, the entrypoint ordering and supervisor lifetime are literal:

```ts
const unresolvedDependencies = dependencies ??
  createDefaultProductionMaintenanceDependencies();
const commandEnvironmentSource = createReleaseControlCommandEnvironmentSource(
  unresolvedDependencies.commandEnvironmentInput
);
const hostToolsEnvironment = createReleaseControlCommandEnvironment({
  source: commandEnvironmentSource,
  scope: 'host-tools',
  slots: {}
});
const commands = createReleaseControlCommandSupervisor(
  unresolvedDependencies.commandProcessAdapter
);
try {
  const git = unresolvedDependencies.git ?? createSupervisedGitSnapshotRuntime({
    repositoryRoot: unresolvedDependencies.repositoryRoot,
    environmentSource: commandEnvironmentSource,
    commands,
    hostToolsEnvironment
  });
  const fileSystem = unresolvedDependencies.fileSystem ??
    createNodeBuildContextFileSystem(unresolvedDependencies.repositoryRoot);
  const restrictedPathHostRuntime =
    unresolvedDependencies.restrictedPathHostRuntime ??
      createNodeRestrictedPathHostRuntime({
        environmentSource: commandEnvironmentSource,
        hostToolsEnvironment,
        commands
      });
  const resolvedDependencies: ResolvedProductionMaintenanceDependencies = {
    ...unresolvedDependencies,
    git,
    fileSystem,
    restrictedPathHostRuntime
  };
  const restrictedPathDependencies = createRestrictedPathDependencies({
    environmentSource: commandEnvironmentSource,
    hostToolsEnvironment,
    commands,
    hostRuntime: resolvedDependencies.restrictedPathHostRuntime
  });
  const identity = createOwnedRunIdentity({
    producer: 'plan6b-production-smoke',
    profile: 'maintenance_fixture',
    candidateId: input.candidateId
  }, resolvedDependencies.entropy);
  const preparation = createOwnedRunPreparation(
    identity,
    { restrictedPathDependencies }
  );
  const portOperations = createReleaseControlPortOperations(
    resolvedDependencies.portRuntime
  );
  const state: ProductionMaintenanceState = {
    identity,
    preparation,
    commandEnvironmentSource,
    hostToolsEnvironment,
    commands,
    restrictedPathDependencies,
    portOperations
  };
  return await runSmokeLifecycle(
    { identity, preparation, evidenceRootTarget: input.evidenceRoot },
    createProductionMaintenanceCallbacks(state, resolvedDependencies),
    {
      now: resolvedDependencies.now,
      emit: resolvedDependencies.emit,
      repositoryRoot: resolvedDependencies.repositoryRoot,
      commands,
      restrictedPathDependencies
    }
  );
} finally {
  await commands.dispose();
}
```

Pure command-environment-source/`host-tools` creation occurs after input validation, then the entrypoint creates exactly one authentic Task 5 supervisor from the injected low-level process adapter. Inside its `try/finally`, it selects an injected Git/filesystem pair or creates the supervised Git and Node build-context adapters from that exact source/supervisor/environment/root, creates the exact Task 5A dependency from the same supervisor/environment and the injected-or-default Node restricted-path host runtime, creates identity and in-memory run preparation from that exact dependency, creates the Task 5 port owner over only the injected low-level port runtime, and stores all of those same objects in module-private state. Those steps acquire no path, Docker, database, socket, or service resource. The default factory performs exactly one read-only canonicalization of `new URL('../', import.meta.url)`, snapshots `process.env` and the normalized platform once, and closes the maintenance context reader over that frozen snapshot. It constructs only Task 5's process/port adapters, Task 6's no-draw entropy adapter, Task 7's no-emit logger adapter, and primitive clock/environment inputs before the supervisor exists; Git, build-context filesystem, and restricted-path host creation remains in the shown late-binding block. The same exact root feeds both freezer adapters and the lifecycle evidence-root owner. Tests inject only a canonical fixture root plus fake process, Git, build-context filesystem, restricted-path host, port, clock, event, and entropy boundaries. No later ambient read may replace the captured environment/platform/context or shared clock. No dependency contains a supervisor, preassembled restricted-path dependency, port operations, authority owner, or production Compose environment. The same supervisor, Git adapter, and Task 5A dependency reach every callback and `runSmokeLifecycle`; `finally` awaits its never-rejecting `dispose()` only after terminal lifecycle handling.

`runSmokeLifecycle` authenticates the exact identity/preparation/supervisor/dependency association and acquires the evidence root as the first run-owned external-resource mutation. The `preflight` callback immediately calls the Task 3 freezer, fully awaits the stability fence, and stores the complete workspace `FrozenBuildContext` and `buildContextSha256` in `state.snapshot` before reading/selecting a Docker context or invoking the port runtime. A freezer/source-shape/change rejection enters filesystem-only pre-handoff cleanup and produces zero Docker argv and zero socket calls across the complete failed run; an ordinarily dirty maintenance workspace remains allowed and records its actual cleanliness. Only after freeze succeeds does preflight select the one maintenance context, call `state.portOperations.attestCoordinatorPublishedLoopbackContext` with that exact context, the source platform, `state.commands`, and `state.hostToolsEnvironment`, and store the returned capability. Remote endpoints fail before a socket or Compose command. It then calls `state.portOperations.allocateLoopbackPort(state.publishedLoopbackContext)` followed by `state.portOperations.allocateLoopbackPort(state.publishedLoopbackContext, true, httpPort)`, rejects an unsafe or equal result, and stores the distinct exact values. It next creates one lexical mutable `secretSet` with `createProductionReleaseControlSecretSet(dependencies.entropy)`. One `try/finally` encloses every following lease acquisition/write: acquire/register both the candidate-IID lease and the private production secret-root lease through the exact preparation, store them in `state.candidateIidRoot`/`state.secretRoot`, and only then materialize and identity-verify the seven exact no-newline files through `state.secretRoot`; the `finally` assigns the local secret-set reference `undefined` on success or any acquisition/write failure. No state field retains it. Preflight then acquires every other subordinate temporary root through the same preparation, constructs the owned primary lifecycle with only `state.commands` and `state.hostToolsEnvironment`, and passes one `source-build` registration carrying the frozen `SourceIdentity`, ordered base-image references, and exact context/branded engine to the immutable Task 6 seal. No callback generates or replaces identity, snapshot, environment source, supervisor, restricted-path dependency, port owner, or registered root. Task 6 independently reobserves the engine, derives labels, observes/persists the complete baseline and base-image IDs, strict-rereads the manifest, and returns the only registered source journal before build.

`build` passes the same identity/preparation, `state.candidateIidRoot`, exact registered journal, and `state.snapshot` to Task 6A. Immediately after the await, the callback calls the directly imported `resolveCandidateImageLease` before storing the result or constructing `BuildStageEvidence`. Only in `compose-config`, after the exact image ID, origin, and every other slot exist, require `state.secretRoot.listStableFiles()` to equal raw UTF-8 filename order `auth_secret:64`, `bootstrap_admin_password:48`, `database_owner_password:48`, `database_password:48`, `database_storage_cleanup_password:48`, `database_worker_password:48`, `smtp_password:48`, with every kind `file`, and call `assertOwnedRegularFile` for each. Then call Task 5's builder with `state.commandEnvironmentSource`, the exact complete `production-compose` slots—including only those seven paths, `127.0.0.1` bind addresses, and the stored HTTP/HTTPS ports—and no ambient or raw secret values. Directly render the template, call Task 6's binder with that environment, registered image, bytes, and expected origin, immediately resolve/store the configuration lease, then obtain/store the attested production lifecycle before any other Compose or bind-using command. Tests require zero Compose-environment construction before the image exists and reject missing/extra/replaced files, structural, rebuilt, cross-source, raw-secret-bearing, or port-mismatched environments.

`migrate` runs the existing migration twice. `provision` first runs role provisioning, then the existing storage-cleanup dry-run, then directly authenticates the resulting database state; it immediately owner-resolves that returned state before storing it or constructing evidence. Immediately before the first Compose command capable of binding published ports, `runtime-start` calls `state.portOperations.probeLoopbackPort(state.publishedLoopbackContext, '127.0.0.1', state.ports.http)` and `state.portOperations.probeLoopbackPort(state.publishedLoopbackContext, '127.0.0.1', state.ports.https, true)`; the owner first reattests the local endpoint/engine, then the stage uses those exact configured ports. `runtime-health`, `inspect`, and `behavior` retain current assertions and use only the authenticated configuration origin. `shutdown` and cleanup operations use the same supervisor's bounded signal-resistant cleanup path, and cleanup follows Task 7's exact pre/post-candidate split. Private secret-root cleanup removes the only retained encoded values; no later callback has the transient set. All credential/secret text comes only from Task 6's exact mapping over injected entropy. Unit/watch tests exercise the authentic supervisor over a fake adapter and the real port owner over fake sockets, assert freeze-before-Docker, exact context/two-allocation/two-probe order, open no process/socket/network, and prove a latched signal cannot prevent final cleanup.

Do not weaken current timeouts or collapse assertion failures into one opaque command.

- [ ] **Step 5: Run focused GREEN plus static ownership witnesses**

```powershell
npx vitest run `
  scripts/plan6b-production-smoke.test.ts `
  scripts/release-control/build-context.test.ts `
  scripts/release-control/compose-config.test.ts `
  scripts/release-control/restricted-path.test.ts `
  scripts/release-control/candidate-image.test.ts `
  scripts/release-control/database-attestation.test.ts `
  scripts/release-control/lifecycle.test.ts `
  scripts/worker-heartbeat-deployment.test.ts `
  scripts/observability-boundaries.test.ts `
  scripts/commerce-operations.test.ts `
  --maxWorkers=1 `
  --reporter=verbose
npm run check
npm run lint -- --no-warn-ignored scripts/plan6b-production-smoke.ts
```

Require static tests to prove the production consumer imports shared ownership/lifecycle and no longer declares a second command supervisor, evidence publisher, source freezer, image lease, or generic cleanup scanner.

- [ ] **Step 6: Commit the production consumer adaptation**

```powershell
git --literal-pathspecs add -- `
  scripts/plan6b-production-smoke.ts `
  scripts/plan6b-production-smoke.test.ts `
  scripts/worker-heartbeat-deployment.test.ts `
  scripts/observability-boundaries.test.ts `
  scripts/commerce-operations.test.ts
git diff --cached --check
git diff --cached
git commit -m "refactor: adopt shared production maintenance smoke"
```

### Task 9: Make the fixture probe an independent shared-lifecycle consumer

**Files:**
- Modify: `scripts/plan6b-fixture-runtime-probe.ts`
- Modify: `scripts/plan6b-fixture-runtime-probe.test.ts`
- Modify: `scripts/test-profile-boundaries.test.ts`
- Modify: `scripts/observability-boundaries.test.ts`
- Modify: `scripts/commerce-operations.test.ts`

- [ ] **Step 1: Add REDs that prohibit nested production smoke**

Pin that `smoke:plan6b-fixture` accepts only the same explicit candidate/evidence flags as Task 8, uses producer `plan6b-fixture-runtime-probe`, profile `maintenance_fixture`, source mode `workspace_fixture`, its dynamically allocated `http://127.0.0.1:<port>` origin, and emits exactly one evidence record. It uses the same one-time host `DOCKER_CONTEXT` selector, coordinator-local endpoint attestation, observed engine binding, explicit `--context` argv, and child-environment omission as production maintenance. The complete frozen workspace snapshot/digest exists before that selector can cause any Docker argv; a selected SSH/TCP/HTTP context is then rejected before port allocation or any Compose command.

Add static/runtime witnesses that it neither imports nor calls `runProductionSmoke`, accepts a production image lease, invents a preverified digest, or skips `build`. Require its injected operation trace to be exactly:

```ts
expect(trace).toEqual([
  'preflight', 'build', 'compose-config', 'migrate', 'provision',
  'runtime-start', 'runtime-health', 'inspect', 'behavior',
  'shutdown', 'cleanup'
]);
```

- [ ] **Step 2: Preserve every fixture-specific behavior as characterization tests**

Retain exact assertions for fixture seed/import, loopback-only HTTP access, admin authorization, quote/checkout/claim/refund paths, provider canary, aggregate endpoint behavior, test-only service topology, storage isolation, role isolation, disabled production Stripe path, and cleanup. Prove `compose.test.yaml` is used only by this consumer and never accepted by the production or release consumers.

Inject a fake process adapter beneath one authentic Task 5 supervisor and a deterministic fake `ReleaseControlPortRuntime` beneath the directly imported port-owner factory. Require preflight to finish/store the frozen workspace context and digest first, then attest/store the selected local context, call `allocateLoopbackPort(context)` for `web`, then `allocateLoopbackPort(context, false, web)` for `database`, and store those exact distinct ports plus `http://127.0.0.1:<web>` in state. Immediately before `migrate` issues its dependency-start/first command capable of binding the published PostgreSQL port, call `probeLoopbackPort(context, '127.0.0.1', database)`; immediately before `runtime-start` issues the first command capable of binding the published application port, call `probeLoopbackPort(context, '127.0.0.1', web)`. Assert `evidence-root -> frozen-source/digest -> context -> web allocation -> database allocation -> subordinate roots -> lifecycle -> manifest seal`, plus the two stage-local probes; every source-shape/change/freezer failure has zero Docker and port calls through final cleanup. Reject remote/structural/drifted context capabilities before sockets/Compose, prove the unit run opens no process/socket/network, and prove one supervisor is bound through Task 5A/Task 7 and disposed after terminal handling. With owner modules mocked before dynamically importing this consumer, mirror Task 8's no-dependency construction RED: exact canonical module root, one frozen environment/platform snapshot and closed `DOCKER_CONTEXT` reader, one shared `now` function, the fixture producer's Task 7 emitter, Task 6 entropy, Task 5 process/port defaults, and exact late-bound Git/build-filesystem/restricted-host associations; later ambient mutation is unobservable and construction performs no entropy draw, event emission, child, or socket work. Task 5's earlier factory REDs—not this consumer task—own the shared 32-attempt socket algorithm and real-adapter behavior.

Add introduced-image tests symmetrical with Task 8: remove on maintenance success/failure only when this run introduced the image and labels still match; preserve pre-existing or label-mismatched images.

Require independent Task 5A leases for its IID, fixture Compose materialization, direct-credential secret root, and evidence target; a production consumer lease or raw path is never accepted.

- [ ] **Step 3: Run the independent-fixture REDs**

```powershell
npx vitest run `
  scripts/plan6b-fixture-runtime-probe.test.ts `
  scripts/test-profile-boundaries.test.ts `
  scripts/observability-boundaries.test.ts `
  scripts/commerce-operations.test.ts `
  scripts/commerce-privacy.test.ts `
  --maxWorkers=1 --reporter=verbose
```

Expected: FAIL on nested production smoke, absent independent build/stage evidence, missing shared local-context/port use, and the legacy `FIXTURE_STAGE` source contract; all preserved fixture behavior/privacy characterizations pass.

- [ ] **Step 4: Refactor to a separate build and callback composition root**

Expose only the input, low-level dependencies, and run entrypoint; keep the mutable state and callback factory module-private:

```ts
export interface FixtureMaintenanceSmokeInput {
  readonly candidateId: string;
  readonly evidenceRoot: string;
}

interface FixtureMaintenanceState {
  readonly identity: OwnedFixtureMaintenanceRunIdentity;
  readonly preparation: OwnedRunPreparation<OwnedFixtureMaintenanceRunIdentity>;
  readonly commandEnvironmentSource: ReleaseControlCommandEnvironmentSource;
  readonly hostToolsEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
  readonly commands: ReleaseControlCommandSupervisor;
  readonly restrictedPathDependencies: RestrictedPathDependencies;
  readonly portOperations: ReleaseControlPortOperations;
  snapshot?: FrozenBuildContext;
  publishedLoopbackContext?: CoordinatorPublishedLoopbackContext;
  ports?: Readonly<{ readonly web: number; readonly database: number }>;
  expectedOrigin?: string;
  secretSet?: FixtureReleaseControlSecretSet;
  candidateIidRoot?: RestrictedPathLease;
  secretRoot?: RestrictedPathLease;
  image?: CandidateImageLease;
  compose?: OwnedPrimaryComposeLifecycle<'maintenance', 'fixture-compose'>;
  attestedCompose?: AttestedOwnedComposeLifecycle<
    'maintenance',
    'fixture-compose'
  >;
  configuration?: OwnedComposeConfigurationLease<
    'maintenance',
    'fixture-compose'
  >;
  mutationManifest?: Extract<
    OwnedMutationManifestLease,
    { readonly profile: 'maintenance_fixture' }
  >;
  database?: AuthenticatedDatabaseState<'maintenance'>;
}

export interface FixtureMaintenanceDependencies {
  readonly repositoryRoot: string;
  readonly restrictedPathHostRuntime?: RestrictedPathHostRuntime;
  readonly git?: GitSnapshotRuntime;
  readonly fileSystem?: BuildContextFileSystem;
  readonly readHostDockerContext: () => string | undefined;
  readonly portRuntime: ReleaseControlPortRuntime;
  readonly commandProcessAdapter: CommandProcessAdapter;
  readonly commandEnvironmentInput: ReleaseControlCommandEnvironmentSourceInput;
  readonly now: () => Date;
  readonly emit: (event: SmokeEventInput) => void;
  readonly entropy: ReleaseControlEntropy;
}

type ResolvedFixtureMaintenanceDependencies =
  Omit<
    FixtureMaintenanceDependencies,
    'restrictedPathHostRuntime' | 'git' | 'fileSystem'
  > & Required<Pick<
    FixtureMaintenanceDependencies,
    'restrictedPathHostRuntime' | 'git' | 'fileSystem'
  >>;

function createDefaultFixtureMaintenanceDependencies():
  FixtureMaintenanceDependencies {
  const repositoryRoot = realpathSync.native(
    fileURLToPath(new URL('../', import.meta.url))
  );
  const hostEnvironment = Object.freeze({ ...process.env });
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  const now = () => new Date();
  return Object.freeze({
    repositoryRoot,
    readHostDockerContext: () => hostEnvironment.DOCKER_CONTEXT,
    portRuntime: createNodeReleaseControlPortRuntime(),
    commandProcessAdapter: createNodeCommandProcessAdapter(),
    commandEnvironmentInput: { platform, hostEnvironment },
    now,
    emit: createStructuredSmokeEventEmitter({
      producer: 'plan6b-fixture-runtime-probe',
      now
    }),
    entropy: createNodeReleaseControlEntropy()
  });
}

function createFixtureMaintenanceCallbacks(
  state: FixtureMaintenanceState,
  dependencies: ResolvedFixtureMaintenanceDependencies
): MaintenanceSmokeStageCallbacks;

export async function runFixtureRuntimeProbe(
  input: FixtureMaintenanceSmokeInput,
  dependencies?: FixtureMaintenanceDependencies
): Promise<PublishedSmokeEvidenceFor<'maintenance_fixture'>>;
```

The fixture uses the same exact normalization shape rather than dereferencing an optional dependency object:

```ts
const unresolvedDependencies = dependencies ??
  createDefaultFixtureMaintenanceDependencies();
const commandEnvironmentSource = createReleaseControlCommandEnvironmentSource(
  unresolvedDependencies.commandEnvironmentInput
);
const hostToolsEnvironment = createReleaseControlCommandEnvironment({
  source: commandEnvironmentSource,
  scope: 'host-tools',
  slots: {}
});
const commands = createReleaseControlCommandSupervisor(
  unresolvedDependencies.commandProcessAdapter
);
try {
  const git = unresolvedDependencies.git ?? createSupervisedGitSnapshotRuntime({
    repositoryRoot: unresolvedDependencies.repositoryRoot,
    environmentSource: commandEnvironmentSource,
    commands,
    hostToolsEnvironment
  });
  const fileSystem = unresolvedDependencies.fileSystem ??
    createNodeBuildContextFileSystem(unresolvedDependencies.repositoryRoot);
  const restrictedPathHostRuntime =
    unresolvedDependencies.restrictedPathHostRuntime ??
      createNodeRestrictedPathHostRuntime({
        environmentSource: commandEnvironmentSource,
        hostToolsEnvironment,
        commands
      });
  const resolvedDependencies: ResolvedFixtureMaintenanceDependencies = {
    ...unresolvedDependencies,
    git,
    fileSystem,
    restrictedPathHostRuntime
  };
  const restrictedPathDependencies = createRestrictedPathDependencies({
    environmentSource: commandEnvironmentSource,
    hostToolsEnvironment,
    commands,
    hostRuntime: resolvedDependencies.restrictedPathHostRuntime
  });
  const identity = createOwnedRunIdentity({
    producer: 'plan6b-fixture-runtime-probe',
    profile: 'maintenance_fixture',
    candidateId: input.candidateId
  }, resolvedDependencies.entropy);
  const preparation = createOwnedRunPreparation(
    identity,
    { restrictedPathDependencies }
  );
  const portOperations = createReleaseControlPortOperations(
    resolvedDependencies.portRuntime
  );
  const state: FixtureMaintenanceState = {
    identity,
    preparation,
    commandEnvironmentSource,
    hostToolsEnvironment,
    commands,
    restrictedPathDependencies,
    portOperations
  };
  return await runSmokeLifecycle(
    { identity, preparation, evidenceRootTarget: input.evidenceRoot },
    createFixtureMaintenanceCallbacks(state, resolvedDependencies),
    {
      now: resolvedDependencies.now,
      emit: resolvedDependencies.emit,
      repositoryRoot: resolvedDependencies.repositoryRoot,
      commands,
      restrictedPathDependencies
    }
  );
} finally {
  await commands.dispose();
}
```

This preserves Task 8's literal direct-owner lifetime with exact canonical `repositoryRoot` reuse, producer `plan6b-fixture-runtime-probe`, `FixtureMaintenanceState`, and `createFixtureMaintenanceCallbacks`. The default factory performs exactly one read-only canonicalization of `new URL('../', import.meta.url)`, snapshots ambient environment/platform once, and closes its context reader over that frozen snapshot. It constructs Task 5's process/port defaults, Task 6's no-draw entropy adapter, Task 7's no-emit fixture logger adapter, and the shared clock before supervisor creation; afterward the shown block creates the exact supervised Git, Node build-context filesystem, and Node restricted-path host adapters from that source/root/supervisor tuple. Tests pin every factory call and `Object.is` association. No supervisor, preassembled restricted-path dependency, authority owner, port operations object, environment builder, final Compose environment, or high-level success operation is injectable.

Build the production target independently through the directly imported freezer from a newly frozen workspace context. Keep fixture-specific seed/HTTP/provider-canary code local; move only generic build, supervision, identity, ownership, stage, and evidence behavior inward. After lifecycle-owned evidence-root acquisition, preflight's first callback operation fully awaits and stores the Task 3 `FrozenBuildContext`, stability fence, later-input registry, and digest before selecting a Docker context or touching the port runtime. A source-shape/change/freezer failure performs filesystem-only pre-handoff cleanup with zero Docker/port calls; an ordinary dirty maintenance workspace remains permitted. Only after freeze succeeds does preflight select the context once, call `state.portOperations.attestCoordinatorPublishedLoopbackContext` with that context, platform, `state.commands`, and `state.hostToolsEnvironment`, store the returned capability, allocate `web` then distinct `database`, and derive/store the exact `http://127.0.0.1:<web>` origin. Remote context rejection precedes socket allocation.

Only after the port pair, call `createFixtureReleaseControlSecretSet(dependencies.entropy)` exactly once and store its six-field result in `state.secretSet`. Before writing anything, acquire/register both the candidate-IID lease and the private direct-credential secret-root lease through the exact preparation and store them in `state.candidateIidRoot`/`state.secretRoot`. Then materialize only the exact wrapped administrator password, as UTF-8 without BOM/newline, through that exact root lease; its four role passwords plus auth secret remain direct environment values and are never written to a second location. Acquire every other subordinate root through the same preparation, construct the owned primary fixture lifecycle with `state.commands` and `state.hostToolsEnvironment`, and pass one registration carrying the frozen source identity/base references and attested context/branded engine to the Task 6 seal. Require Task 6's independent observation and strict manifest reread before accepting its journal. Pass the same identity/preparation, exact journal, IID lease, and `state.snapshot` to the build owner, then directly resolve the returned candidate before storing/reading it. Only then require `state.secretRoot.listStableFiles()` to equal exactly `[{ name: 'bootstrap_admin_password', kind: 'file', byteLength: 50 }]` and call `assertOwnedRegularFile('bootstrap_admin_password', 50)`. Build the complete immutable `fixture-compose` environment from `state.commandEnvironmentSource`, exact candidate, the five direct values in `state.secretSet`, that administrator path, other private paths, `state.ports`, and `state.expectedOrigin`; bind it once, immediately resolve/store the configuration lease, and transition to the attested fixture lifecycle before another Compose/bind command. In a `finally` around environment creation/binding, clear `state.secretSet`; final cleanup clears it again idempotently for failures that never reached `compose-config`. Tests prove no fixture environment exists before build, all five direct values and the one file exactly match Task 6's table, and rebuilding, swapping a role value, or a port/origin mismatch is rejected.

Immediately before `migrate` issues its first Compose command capable of binding PostgreSQL, call `state.portOperations.probeLoopbackPort(state.publishedLoopbackContext, '127.0.0.1', state.ports.database)`; immediately before `runtime-start` first binds the application port, separately probe `state.ports.web`. The owner reattests endpoint/engine before each probe and both stages use those exact configured ports. Delete the fixture's private port loop and use Task 5's shared Node port runtime. Consumer tests use one authentic supervisor over a fake adapter plus the real port owner over fake sockets; they open no process/socket/network and prove signal-resistant final cleanup. Within `provision`, run the fixture role provisioner first, then directly authenticate and immediately owner-resolve the resulting database state before storing it or constructing evidence; the exact fixture topology has no storage-cleanup service or dry-run. HTTP behavior takes origin only from authenticated configuration evidence, and cleanup follows Task 7's exact pre/post-candidate split. The only long-lived raw values are inside the opaque bound fixture environment until lifecycle cleanup; the extra state record is already cleared. No raw baseline, bind, origin, environment, secret set, or repeat-absence callback is accepted.

- [ ] **Step 5: Prove both maintenance consumers are separate and green**

```powershell
npx vitest run `
  scripts/plan6b-production-smoke.test.ts `
  scripts/plan6b-fixture-runtime-probe.test.ts `
  scripts/test-profile-boundaries.test.ts `
  scripts/observability-boundaries.test.ts `
  scripts/commerce-operations.test.ts `
  scripts/commerce-privacy.test.ts `
  --maxWorkers=1 `
  --reporter=verbose
npm run check
npm run lint -- --no-warn-ignored scripts/plan6b-fixture-runtime-probe.ts
```

Expected: no service starts in unit tests, each consumer builds exactly once in its own fake run, and neither can emit release-candidate evidence.

- [ ] **Step 6: Commit the fixture consumer adaptation**

```powershell
git --literal-pathspecs add -- `
  scripts/plan6b-fixture-runtime-probe.ts `
  scripts/plan6b-fixture-runtime-probe.test.ts `
  scripts/test-profile-boundaries.test.ts `
  scripts/observability-boundaries.test.ts `
  scripts/commerce-operations.test.ts
git diff --cached --check
git diff --cached
git commit -m "refactor: adopt shared fixture maintenance smoke"
```

## Milestone D - authenticated checkpoint and distinct-engine release candidate

### Task 10: Fingerprint bundle v2 and define safe checkpoint evidence primitives

**Files:**
- Create: `scripts/deployment-checkpoint-evidence.ts`
- Create: `scripts/deployment-checkpoint-evidence.test.ts`
- Modify: `scripts/deployment-backup-bundle.ts`
- Modify: `scripts/deployment-backup-bundle.test.ts`

- [ ] **Step 1: Write semantic manifest-fingerprint REDs**

Use two differently formatted but semantically identical valid manifests and require the same fingerprint. Change each safe manifest field and each artifact size/hash one at a time and require a different fingerprint. Reject unknown/missing/duplicate artifacts, invalid backup ID, unsafe path/name, uppercase or malformed hashes, non-integer size, wrong bundle version, symlinks, and a manifest whose on-disk artifact verification fails. Preserve the existing raw-string standalone seal/verify APIs. Add disjoint coordinated overloads that accept only the exact runtime-branded Task 5A lease capability, use its stable enumeration/read/hash methods, require exactly the 14 artifact names before sealing and those 14 plus `backup-bundle.json` afterward, and never call raw `readdir`, `lstat`, `open`, `link`, or hash-by-path in the coordinated branch.

Do not add a manifest field or artifact. The wished-for extension is:

```ts
export function fingerprintDeploymentBackupManifest(
  manifest: DeploymentBackupBundleManifest
): string;

export interface CoordinatedBundleAccess {
  readonly capability: 'plan7a-coordinated-bundle-access-v1';
  readonly lease: RestrictedPathLease;
  readonly databaseScope: DatabaseAttestationScope<'source'>;
  // Runtime-bound to the exact checkpoint identity.
}

export function createCoordinatedBundleAccess(
  identity: OwnedCheckpointIdentityLease
): CoordinatedBundleAccess;

export interface VerifiedCoordinatedBundleLease {
  readonly capability: 'plan7a-verified-backup-bundle-v1';
  readonly databaseScope: DatabaseAttestationScope<'source'>;
  readonly backupId: string;
  readonly backupManifestSha256: string;
  // Runtime-bound to the same live RestrictedPathLease; no manifest/path escapes.
}

export interface ResolvedVerifiedCoordinatedBundleLease {
  readonly databaseScope: DatabaseAttestationScope<'source'>;
  readonly backupId: string;
  readonly backupManifestSha256: string;
}

export function resolveVerifiedCoordinatedBundleLease(
  bundle: VerifiedCoordinatedBundleLease
): ResolvedVerifiedCoordinatedBundleLease;

// Existing standalone overload remains source-compatible.
export async function sealDeploymentBackupBundle(
  bundleRoot: string,
  backupId: string
): Promise<DeploymentBackupBundleManifest>;

export async function sealDeploymentBackupBundle(
  access: CoordinatedBundleAccess,
  backupId: string
): Promise<VerifiedCoordinatedBundleLease>;

export async function verifyAndFingerprintDeploymentBackupBundle(
  bundleRoot: string,
  backupId: string
): Promise<{
  readonly manifest: DeploymentBackupBundleManifest;
  readonly backupManifestSha256: string;
}>;

export async function verifyAndFingerprintDeploymentBackupBundle(
  access: CoordinatedBundleAccess,
  backupId: string
): Promise<VerifiedCoordinatedBundleLease>;
```

The fingerprint is SHA-256 of canonical semantic version-1 JSON built from the strictly parsed version-2 manifest. It is not the hash of formatting bytes. `createCoordinatedBundleAccess` first calls Task 6's `assertOwnedCheckpointIdentityLease`, then privately binds that exact live identity's bundle lease plus source database scope; callers cannot assemble the object. The coordinated seal opens every expected file through one stable lease handle, streams its hash under an explicit safe-integer maximum, constructs/writes the manifest with `writeExclusiveSynced`, then verifies the exact 15-entry set. The returned capability retains only backup ID/fingerprint plus private associations with that access/lease/scope; the full manifest remains internal. Tests forge structural lookalikes, replace files during enumeration/hash, change device/inode or Windows file ID/mtime/size/link count, and use oversized streams; every case fails before a verified capability exists.

- [ ] **Step 2: Write frozen-input and scoped-attestation REDs**

Require one runtime-branded closed frozen checkpoint input object built directly from Task 3's frozen registry; reconstructed byte bags and mutable aliases fail. Reuse Task 4A's already branded migration/role/catalog/operational-diagnostics authentication and derived replacement disposition; do not create a second parser or accept a caller literal for either result. Add cross-scope, cross-observation, structural-frozen-input, and forged-clear REDs.

```ts
export interface FrozenCheckpointInputs {
  readonly capability: 'plan7a-frozen-checkpoint-inputs-v1';
  readonly buildContextSha256: string;
  readonly composeProduction: Uint8Array;
  readonly caddyfile: Uint8Array;
  readonly rowCountSql: Uint8Array;
  readonly storageInventorySql: Uint8Array;
  readonly storageSampleSql: Uint8Array;
  readonly financialRestoreVerifierSql: Uint8Array;
  readonly drizzleJournal: Uint8Array;
  readonly migrationTipSql: Uint8Array;
}

export function createFrozenCheckpointInputs(input: {
  readonly identity: OwnedCheckpointIdentityLease;
  readonly candidate: CandidateImageLease;
}): FrozenCheckpointInputs;

export interface ResolvedFrozenCheckpointInputs {
  readonly identity: OwnedCheckpointIdentityLease;
  readonly registeredImage: RegisteredRuntimeImage;
  readonly buildContextSha256: string;
  readonly composeProduction: Uint8Array;
  readonly caddyfile: Uint8Array;
  readonly rowCountSql: Uint8Array;
  readonly storageInventorySql: Uint8Array;
  readonly storageSampleSql: Uint8Array;
  readonly financialRestoreVerifierSql: Uint8Array;
  readonly drizzleJournal: Uint8Array;
  readonly migrationTipSql: Uint8Array;
}

export function resolveFrozenCheckpointInputs(input: {
  readonly identity: OwnedCheckpointIdentityLease;
  readonly frozenInputs: FrozenCheckpointInputs;
}): ResolvedFrozenCheckpointInputs;
```

Test safe attestation assembly separately from checkpoint execution: it accepts only the Task 4A result, runtime-branded verified bundle capability, and parsed exact engine ID; it derives catalog/disposition from the authenticated observation and returns no manifest, diagnostics, role names, paths, contexts, SQL, or raw output. Export these exact constructors and output types from `deployment-checkpoint-evidence.ts` so Task 11 consumes rather than reinvents them:

```ts
export interface CoordinatedCaptureAttestation {
  readonly capability: 'plan7a-coordinated-capture-attestation-v1';
  readonly backupId: string;
  readonly backupManifestSha256: string;
  readonly captureDockerEngineId: DockerEngineId;
  readonly sourceCatalogResult: 'verified';
  readonly replacementDisposition: 'clear' | 'blocked';
  // Opaque runtime brand; capability discriminator is not release evidence.
}

export function resolveCoordinatedCaptureAttestation(input: {
  readonly verifiedBundle: VerifiedCoordinatedBundleLease;
  readonly attestation: CoordinatedCaptureAttestation;
}): Readonly<{
  readonly database: AuthenticatedDatabaseState<'source'>;
  readonly verifiedBundle: VerifiedCoordinatedBundleLease;
  readonly backupId: string;
  readonly backupManifestSha256: string;
  readonly captureDockerEngineId: DockerEngineId;
  readonly sourceCatalogResult: 'verified';
  readonly replacementDisposition: 'clear' | 'blocked';
}>;

export function createCoordinatedCaptureAttestation(input: {
  readonly database: AuthenticatedDatabaseState<'source'>;
  readonly verifiedBundle: VerifiedCoordinatedBundleLease;
  readonly captureDockerEngineId: DockerEngineId;
}): CoordinatedCaptureAttestation;
```

`resolveVerifiedCoordinatedBundleLease` and `resolveFrozenCheckpointInputs` are the sole owner-side checks for their respective private WeakMap entries; both reject structural/spread/proxy/serialized values. The frozen resolver requires the exact checkpoint identity before returning defensive bytes plus the exact registered source-image association. `createCoordinatedCaptureAttestation` directly calls Task 4A's `resolveAuthenticatedDatabaseState` and the bundle resolver before reading a field, invoking a dependency, or doing any work, requires `Object.is(resolvedDatabase.scope, resolvedBundle.databaseScope)`, and derives catalog/disposition fields from the authenticated database rather than caller input. Its WeakMap stores the exact database and verified-bundle objects. `resolveCoordinatedCaptureAttestation` therefore requires the expected live `verifiedBundle`, resolves that bundle through its owner, rejects unless `Object.is` matches the stored association, and only then returns the exact database/bundle associations plus safe fields. The verified bundle supplies the backup ID/fingerprint; the shared manifest scope proves both observations belong to the same owned run. A structural lookalike, genuine attestation from another bundle/run, cross-observation, cross-scope/run capability, registered-image mismatch, or forged clear/verified literal fails before use. Task 10 deliberately does not reference a future Task 11 brand.

- [ ] **Step 3: Run RED**

```powershell
npx vitest run `
  scripts/deployment-backup-bundle.test.ts `
  scripts/deployment-checkpoint-evidence.test.ts `
  --reporter=verbose
```

Expected: FAIL because bundle verification returns no semantic identity and the safe checkpoint-evidence module does not exist.

- [ ] **Step 4: Implement the safe attestation module**

Expose only parsed safe values; never expose SQL output, connection strings, secret hashes, filesystem paths, storage keys, or a full manifest through release evidence. Keep the full parsed manifest internal to verification.

`createFrozenCheckpointInputs` first calls Task 6's `assertOwnedCheckpointIdentityLease` and Task 6A's `resolveCandidateImageLease`, then requires the resolved journal to be `identity.sourceImageMutation` by object identity and derives the only allowed context from the resolved authentic candidate view; no caller context is accepted. Task 6A's private registry binds that exact object to the bytes actually streamed into the successful build, while every byte-returning getter remains defensive. The factory reads exactly the eight named keys from that registry, validates each value, stores defensive copies plus the exact identity/candidate/context/registered-image association in a private WeakMap, and returns defensive copies on access. No raw object or same-digest context overload exists. Task 11 directly calls `resolveFrozenCheckpointInputs` with the same live identity before reading bytes, invoking a dependency, or issuing a command, then compares its resolved registered-image association with the independently resolved coordinated application image. It rejects a structural lookalike or inputs from another run/candidate/context even when a reconstructed context has the same digest.

- [ ] **Step 5: Prove GREEN and commit**

```powershell
npx vitest run `
  scripts/deployment-backup-bundle.test.ts `
  scripts/deployment-checkpoint-evidence.test.ts `
  scripts/commerce-operations.test.ts `
  scripts/release-control/database-attestation.test.ts `
  --maxWorkers=1 `
  --reporter=verbose
npm run check
git --literal-pathspecs add -- `
  scripts/deployment-checkpoint-evidence.ts `
  scripts/deployment-checkpoint-evidence.test.ts `
  scripts/deployment-backup-bundle.ts `
  scripts/deployment-backup-bundle.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: authenticate checkpoint candidate evidence"
```

### Task 11: Accept frozen inputs and coordinator-owned rehearsal identity in the checkpoint API

**Files:**
- Modify: `scripts/release-control/contracts.ts`
- Modify: `scripts/release-control/contracts.test.ts`
- Modify: `scripts/deployment-checkpoint.ts`
- Modify: `scripts/deployment-checkpoint.test.ts`
- Modify: `scripts/deployment-checkpoint-runtime.test.ts`
- Modify: `scripts/deployment-checkpoint-evidence.ts`
- Modify: `scripts/deployment-checkpoint-evidence.test.ts`
- Modify: `scripts/deployment-backup-bundle.ts`
- Modify: `scripts/deployment-backup-bundle.test.ts`
- Modify: `scripts/split-storage-backup.ts`
- Modify: `scripts/split-storage-backup.test.ts`

- [ ] **Step 1: Add programmatic API compatibility REDs**

Keep `parseDeploymentCheckpointArguments` and the standalone `npm run deployment:checkpoint -- capture|rehearse ...` grammar byte-for-byte compatible. Add a separate capability-gated programmatic input whose caller supplies frozen bytes and pre-registered identity:

```ts
// scripts/release-control/contracts.ts
export interface RegistryDigestApplicationImage {
  readonly kind: 'registry-digest';
  readonly reference: string;
}

// scripts/deployment-checkpoint.ts
export type DeploymentRegistryApplicationImage = RegistryDigestApplicationImage;
export type DeploymentApplicationImage = DeploymentRegistryApplicationImage;

interface CoordinatedCheckpointCommon {
  readonly capability: 'plan7a-release-candidate-v1';
  readonly identity: OwnedCheckpointIdentityLease;
  readonly frozenInputs: FrozenCheckpointInputs;
  readonly sourceConfiguration:
    OwnedComposeConfigurationLease<'source', 'production-compose'>;
  readonly applicationImage: DeploymentApplicationImage;
  readonly principals: DatabasePrincipalExpectation;
}

export type CoordinatedCheckpointOptions =
  | (CoordinatedCheckpointCommon & {
      readonly mode: 'capture';
      readonly sourceDatabase: AuthenticatedDatabaseState<'source'>;
      readonly sourceCompose:
        AttestedOwnedComposeLifecycle<'source', 'production-compose'>;
      readonly sourceBundleBind: RestrictedDockerBindLease;
    })
  | (CoordinatedCheckpointCommon & {
      readonly mode: 'rehearse';
      readonly capturedBundle: AuthenticatedCheckpointBundleLease;
      readonly sourceCompose:
        AttestedOwnedComposeLifecycle<'source', 'production-compose'>;
      readonly rehearsalCompose:
        AttestedOwnedComposeLifecycle<'rehearsal', 'checkpoint-compose'>;
      readonly rehearsalConfiguration:
        OwnedComposeConfigurationLease<'rehearsal', 'checkpoint-compose'>;
      readonly restoreBundleBind: RestrictedDockerBindLease;
      readonly restoreRehearsalBind: RestrictedDockerBindLease;
    });

// scripts/split-storage-backup.ts; this task accepts only the registry helper.
export type CoordinatedSplitStorageBackupCommon<Helper> = Omit<
  SplitStorageBackupOptions,
  | 'project' | 'helperImage' | 'dockerContext' | 'expectedDockerEngineId'
  | 'bundleRoot' | 'checkpointOwnerToken'
> & {
  readonly capability: 'plan7a-release-candidate-v1';
  readonly identity: OwnedCheckpointIdentityLease;
  readonly helperImage: Helper;
  readonly bundleBind: RestrictedDockerBindLease;
};

export type CoordinatedSplitStorageBackupOptionsFor<Helper> =
  | (CoordinatedSplitStorageBackupCommon<Helper> & {
      readonly mode: 'capture';
      readonly helperIdentity: Extract<
        OwnedRawHelperIdentityLease,
        { readonly role: 'captureHelper' }
      >;
      readonly volumeAccess:
        CoordinatedStorageVolumeAccessSet<'captureHelper'>;
    })
  | (CoordinatedSplitStorageBackupCommon<Helper> & {
      readonly mode: 'restore';
      readonly helperIdentity: Extract<
        OwnedRawHelperIdentityLease,
        { readonly role: 'rehearsalHelper' }
      >;
      readonly volumeAccess:
        CoordinatedStorageVolumeAccessSet<'rehearsalHelper'>;
    });

export type CoordinatedRegistrySplitStorageBackupOptions =
  CoordinatedSplitStorageBackupOptionsFor<RegistryDigestApplicationImage> & {
    readonly helperRuntimeIdentity: AuditedDockerRuntimeIdentity;
  };

export interface CoordinatedSplitStorageBackupDependencies {
  readonly commands: ReleaseControlCommandSupervisor;
  readonly commandEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
}

// Existing standalone overload remains source-compatible.
export function executeSplitStorageBackup(
  options: SplitStorageBackupOptions,
  runtime: SplitStorageBackupRuntime
): Promise<SplitStorageBackupResult[]>;

export function executeSplitStorageBackup(
  options: CoordinatedRegistrySplitStorageBackupOptions,
  dependencies: CoordinatedSplitStorageBackupDependencies
): Promise<SplitStorageBackupResult[]>;
```

The coordinated path always uses the authenticated application image itself as the storage helper; the standalone CLI alone preserves its existing independently supplied helper variable. It accepts only the exact lease object returned by Task 6's sealed manifest, strictly rereads that immutable manifest, derives the PostgreSQL reference and source/restore local IDs only from `identity.postgresImage`, and derives projects, tokens, backup ID, and labels only from `identity.run` plus its Task 6 project/helper capabilities. It rejects any caller project, token, backup ID, context/engine, database scope, root path/token/file identity, application image, PostgreSQL image, configuration, label, or bind-capability mismatch. The source and rehearsal projects are the only Compose projects. Capture consumes the exact post-build `sourceConfiguration` lease and Task 4A source observation scoped to `identity.databaseScopes.source`, plus the exact attested source lifecycle whose bind set covers that configuration and the registered source materialization/secret roots. Rehearsal consumes the exact `rehearsalConfiguration` lease and attested rehearsal lifecycle for its distinct registered roots. Raw override bytes, reconstructed configuration evidence, omitted/unattested values, and cross-role lifecycles/databases fail before any Compose command. Capture/rehearsal storage helpers remain hardened raw `docker run` containers and consume the exact runtime-branded `captureHelper`/`rehearsalHelper` identity plus labels from the sealed manifest. Capture requires empty registered bundle and rehearsal leases plus a read-write bundle attestation for the source engine. Before each Docker-created artifact it records an absent expected path; after the producer closes it adopts the file before any read. It calls only Task 10's coordinated seal/verify overload with `identity.databaseScopes.source` and leaves one authenticated sealed-bundle capability. After restore and before attestation, Task 11 adapts the attested rehearsal executor to `DatabaseAttestationRuntime` and calls Task 4A itself with `identity.databaseScopes.rehearsal`, frozen journal/migration/verifier bytes, and exact principals; no caller-supplied restore result is accepted. Rehearse requires the exact captured capability plus read-only/read-write attestations for the same bundle/rehearsal leases on the restore engine, requires the rehearsal lease still empty, and removes both leases before returning. A raw path, standalone bundle/configuration overload, or reconstructed lookalike is never accepted.

The source context observation must match `identity.sourceDockerEngineId`; rehearsal must match `identity.restoreDockerEngineId`, and those IDs must differ. Before capture, reobserve `identity.postgresImage.reference`, require its exact RepoDigest and raw ID still equal `identity.postgresImage.source`, resolve the exact `identity.run.composeProjects.source` capability, then inspect `${sourceProject.project}-postgres-1` and require `Config.Image === identity.postgresImage.reference` plus `.Image === identity.postgresImage.source.imageId`. Before restore, make the equivalent exact reference/RepoDigest/raw-ID comparison against `identity.postgresImage.restore`; also require the same audited non-root application/helper image.

Pin the coordinated rehearsal Compose service-selection trace: start only `postgres`, run the exact migration/provision/restore/tool operations, then start only `app` for verification. It never selects `caddy`, `worker`, or any service with a published host port. Static and runtime REDs reject `up`, `run`, `create`, or `start` argv that names Caddy or otherwise selects the full project. This makes the rehearsal environment's shared HTTP/HTTPS literals configuration-only and preserves support for a remote restore context that passes all bind/volume attestations. Any future rehearsal Caddy/publication change requires a separately approved restore-context locality capability and first-bind port probe.

- [ ] **Step 2: Add hard-interruption and cleanup REDs**

At every capture/rehearsal mutation boundary, abort after the mutation was registered but before it acknowledged. From the outer identity alone, require discovery and cleanup of the exact raw helper containers, rehearsal Compose project/volumes/network, restricted bundle/rehearsal/materialization roots, and remote temporary dump. Refuse foreign label/name collisions.

Task 11 owns the authenticated captured-bundle transition and rehearsal attestation because this is the first task that can bind capture execution to the Task 6 identity. Task 10 remains lower-level and owns only verified bundle plus capture attestation:

```ts
export interface AuthenticatedCheckpointBundleLease {
  readonly capability: 'plan7a-authenticated-checkpoint-bundle-v1';
  readonly identity: OwnedCheckpointIdentityLease;
  readonly sourceCompose:
    AttestedOwnedComposeLifecycle<'source', 'production-compose'>;
  readonly attestation: CoordinatedCaptureAttestation;
  readonly verifiedBundle: VerifiedCoordinatedBundleLease;
  // Opaque runtime brand binds all three live capabilities.
}

export interface ResolvedAuthenticatedCheckpointBundleLease {
  readonly identity: OwnedCheckpointIdentityLease;
  readonly sourceCompose:
    AttestedOwnedComposeLifecycle<'source', 'production-compose'>;
  readonly attestation: CoordinatedCaptureAttestation;
  readonly verifiedBundle: VerifiedCoordinatedBundleLease;
}

export function resolveAuthenticatedCheckpointBundleLease(input: {
  readonly identity: OwnedCheckpointIdentityLease;
  readonly bundle: AuthenticatedCheckpointBundleLease;
}): ResolvedAuthenticatedCheckpointBundleLease;

export interface CoordinatedRehearsalAttestation {
  readonly capability: 'plan7a-coordinated-rehearsal-attestation-v1';
  readonly backupId: string;
  readonly restoreDockerEngineId: DockerEngineId;
  readonly restoreCatalogResult: 'verified';
  readonly replacementDisposition: 'clear' | 'blocked';
  readonly rehearsalCleanup: ZeroCleanupEvidence;
  // Opaque runtime brand; capability discriminator is not release evidence.
}

export function resolveCoordinatedRehearsalAttestation(input: {
  readonly identity: OwnedCheckpointIdentityLease;
  readonly capturedBundle: AuthenticatedCheckpointBundleLease;
  readonly attestation: CoordinatedRehearsalAttestation;
}): Readonly<{
  readonly database: AuthenticatedDatabaseState<'rehearsal'>;
  readonly capturedBundle: AuthenticatedCheckpointBundleLease;
  readonly backupId: string;
  readonly restoreDockerEngineId: DockerEngineId;
  readonly restoreCatalogResult: 'verified';
  readonly replacementDisposition: 'clear' | 'blocked';
  readonly rehearsalCleanup: ZeroCleanupEvidence;
}>;

export interface CoordinatedCaptureResult {
  readonly attestation: CoordinatedCaptureAttestation;
  readonly capturedBundle: AuthenticatedCheckpointBundleLease;
}

export function authenticateCheckpointBundle(input: {
  readonly identity: OwnedCheckpointIdentityLease;
  readonly sourceCompose:
    AttestedOwnedComposeLifecycle<'source', 'production-compose'>;
  readonly verifiedBundle: VerifiedCoordinatedBundleLease;
  readonly captureAttestation: CoordinatedCaptureAttestation;
}): AuthenticatedCheckpointBundleLease;

export function createCoordinatedRehearsalAttestation(input: {
  readonly database: AuthenticatedDatabaseState<'rehearsal'>;
  readonly capturedBundle: AuthenticatedCheckpointBundleLease;
  readonly restoreDockerEngineId: DockerEngineId;
  readonly rehearsalCleanup: OwnedCleanupReceipt<'rehearsal'>;
}): CoordinatedRehearsalAttestation;

export interface CoordinatedCheckpointDependencies {
  readonly commands: ReleaseControlCommandSupervisor;
  readonly hostToolsEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
}

export function executeDeploymentCheckpoint(
  options: DeploymentCheckpointOptions,
  runtime?: CheckpointCommandRuntime,
  environment?: NodeJS.ProcessEnv,
  dependencies?: DeploymentCheckpointDependencies
): Promise<{ readonly project: string; readonly backupId: string }>;

export function executeDeploymentCheckpoint(
  options: Extract<CoordinatedCheckpointOptions, { readonly mode: 'capture' }>,
  dependencies: CoordinatedCheckpointDependencies
): Promise<CoordinatedCaptureResult>;

export function executeDeploymentCheckpoint(
  options: Extract<CoordinatedCheckpointOptions, { readonly mode: 'rehearse' }>,
  dependencies: CoordinatedCheckpointDependencies
): Promise<CoordinatedRehearsalAttestation>;
```

Preserve all one-, two-, three-, and four-argument legacy calls at compile time and runtime, plus both coordinated result narrows. The implementation union is private and is not an exported catch-all overload. The unchanged parser/CLI can never accept a local capability.

Every coordinated overload calls Task 6's directly imported, non-injected `assertOwnedCheckpointIdentityLease(options.identity)` and Task 10's directly imported `resolveFrozenCheckpointInputs({ identity: options.identity, frozenInputs: options.frozenInputs })` before reading any capability field, invoking a supplied dependency, or issuing a command. Capture then directly resolves its Task 4A source database and asserts its Task 6 source attested lifecycle; rehearsal directly resolves its Task 10 authenticated bundle and asserts both source/rehearsal attested lifecycles. `CoordinatedCheckpointDependencies` contains only the authentic run-scoped supervisor and one associated `host-tools` environment for raw Docker/helper operations. It accepts no Compose environment: source and rehearsal Compose commands use only the exact immutable role-scoped environments already authenticated and stored by their attested lifecycle capabilities. The module directly imports every owner operation, including database authentication, bundle-access creation, project/configuration/bind resolution, runtime audit, storage-volume attestation, and split-storage execution, and passes only those exact capabilities beneath them. In this task's registry form, the checkpoint audits the locally inspected registry reference and requires its exact image ID, four labels, source context, and source engine to equal the frozen resolver's registered-image view before continuing. The coordinated checkpoint owns point-of-use storage attestation rather than accepting volume sets from Task 13. Registry capture order is exactly `audit-source-image -> resolve-capture-bind -> attest-capture-volumes -> split-capture`; rehearsal is exactly `audit-restore-image -> resolve-rehearsal-bind -> attest-rehearsal-volumes -> split-restore`. The checkpoint passes the exact audit result unchanged as `helperRuntimeIdentity` alongside the exact bind and unchanged access set. Task 12 adds a direct, non-injected local-image resolver as the first branch-specific check and requires `Object.is(resolvedLocalImage.registeredImage, resolvedFrozen.registeredImage)` before any command. Add a separate `executeSplitStorageBackup` overload accepting only `CoordinatedRegistrySplitStorageBackupOptions`; its existing standalone overload and CLI stay exact. That registry overload supplies the exact `helperRuntimeIdentity` to Task 6's `consumeOwnedStorageVolumeAccess` before its first helper command and never mints, reconstructs, or re-audits either capability. Resolver or attestation rejection produces zero helper commands; the exact set is passed unchanged to split storage, consumed once there, and fails on reuse or cross-role substitution. Add zero-command REDs for structural frozen/database/lifecycle/image capabilities, omitted or structural runtime identity, and wrong-scope, wrong-role, wrong-image, wrong-context, or wrong-engine associations.

`authenticateCheckpointBundle` first directly authenticates the checkpoint identity and source attested lifecycle, resolves the verified bundle, and calls `resolveCoordinatedCaptureAttestation({ verifiedBundle, attestation: captureAttestation })`; that owner requires the attestation's exact stored bundle object rather than merely equal public ID/hash fields. It then binds those exact resolved associations in its own WeakMap. `resolveAuthenticatedCheckpointBundleLease` is its sole outer authenticity check and requires the same live identity before exposing those exact inward capabilities. Rehearse calls that resolver before any field/dependency/command and must receive the same live source lifecycle. Immediately after restore database authentication—and before cleanup—it directly calls `resolveAuthenticatedDatabaseState(rehearsalDatabase)` and requires `Object.is(resolvedDatabase.scope, resolvedBundle.identity.databaseScopes.rehearsal)`; wrong-role, structural, cross-observation, or cross-scope state produces zero cleanup commands. Only after this pre-cleanup gate does it call the source owner's `cleanupRehearsalResources(rehearsalCompose)`, so the source manifest authority and rehearsal `checkpoint-compose` executor participate in one Task 6 transition. `createCoordinatedRehearsalAttestation` independently resolves the authenticated bundle and Task 4A rehearsal database again after cleanup, repeats the exact scope check, then calls Task 6's `assertOwnedRehearsalCleanupReceipt` with the resolved checkpoint identity before inspecting the attempt; its WeakMap stores the exact database, captured bundle, and receipt associations. `resolveCoordinatedRehearsalAttestation({ identity, capturedBundle, attestation })` authenticates all three exact objects, including `Object.is` on the captured bundle, before returning safe fields. Both constructors reject structural copies, a genuine capability from another bundle/run, a different source/rehearsal lifecycle, cross-run identities/scopes, mismatched backup IDs/fingerprints, a Task 4A database brand from the wrong live observation, a forged catalog/disposition literal, or a cleanup attempt not backed by Task 6's exact zero-residual rehearsal receipt. They derive catalog/disposition fields from the exact authenticated database object. The capture call returns `CoordinatedCaptureResult`; no serialized bundle capability is exposed. The rehearsal attestation is returned only after the rehearsal Compose project, raw helpers, restore image, and private bundle/rehearsal leases are absent while the source project/materialization remains available for the later runtime stages. Task 13 first resolves `result.capturedBundle` against its current checkpoint identity, requires `Object.is(resolvedBundle.attestation, result.attestation)`, then resolves that capture attestation against `resolvedBundle.verifiedBundle`; it resolves rehearsal evidence only against the same exact identity and captured bundle. Preserve ACL restore: the exact `pg_restore` arguments remain `--clean --if-exists --no-owner`; add a negative source assertion forbidding `--no-acl`.

The exact role check is `Object.is(resolvedDatabase.scope, resolvedBundle.identity.databaseScopes.rehearsal)` both before cleanup and again inside the post-cleanup constructor; neither site reads an unresolved state or compares the restored observation to the source bundle scope. A same-run source-state substitution therefore fails before cleanup and cannot mint an attestation.

- [ ] **Step 3: Run the coordinated-API REDs**

```powershell
npx vitest run `
  scripts/release-control/contracts.test.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/deployment-checkpoint-runtime.test.ts `
  scripts/deployment-checkpoint-evidence.test.ts `
  scripts/split-storage-backup.test.ts `
  --reporter=verbose
```

Expected: FAIL on the missing coordinated overload, frozen-input use, expected-engine binding, caller-owned identities, typed attestations, and post-cleanup result.

- [ ] **Step 4: Implement the overload without reversing dependencies**

`deployment-checkpoint.ts` may import the safe evidence/bundle module and Task 5A/6 lease/configuration types, but it must not import `plan7a-release-candidate`, `release-control/lifecycle`, or either Plan 6B smoke. The exact source/rehearsal configuration leases already authenticate their materialized frozen `compose.prod.yaml`, `deploy/Caddyfile`, and role-specific template; Task 11 invokes the directly imported, non-injected Task 6 configuration and project resolvers at each use and never accepts or writes caller override bytes. Every coordinated rehearsal Compose command selects only the resolved rehearsal project/labels/configuration, uses that lease root as `--project-directory` with base then override order, and never rereads the repository working directory. Raw helper containers use only their role capability and exact labels, never a Compose override. Every coordinated bundle enumeration, bounded manifest read, large-file hash, seal, and verify goes through Task 10's lease overload. Preserve the raw-path implementations solely behind the unchanged standalone grammar.

Keep the standalone path's current registry-digest application/helper images and operator-created bundle behavior. In the coordinated registry form, `reference` supplies both `APP_IMAGE` and the helper image and must satisfy the existing non-root/helper inspection; audit its inspected local image ID through Task 6's exact registered image-probe owner before any raw-helper bind. Route both paths through the same low-level capture/rehearsal mechanics only after their different inputs are authenticated. `source` is the already owned production Compose project; `rehearsal` is the only other Compose project. The capture/rehearsal raw-helper namespaces, container names, labels, and separate volume-project mappings are pre-registered capabilities and cannot be regenerated internally. Final static dependency REDs require `restricted-path -> owned-compose -> candidate-image -> candidate-image-transfer -> split-storage-backup -> deployment-checkpoint -> plan7a-release-candidate`; `compose-config` stays a pure inward dependency of `owned-compose`. In particular, `split-storage-backup.ts` imports neither `deployment-checkpoint.ts` nor `CoordinatedCheckpointDependencies`, and Task 11 does not forward-reference the Task 12 local-image resolver.

- [ ] **Step 5: Prove GREEN and commit**

```powershell
npx vitest run `
  scripts/release-control/contracts.test.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/deployment-checkpoint-runtime.test.ts `
  scripts/deployment-checkpoint-evidence.test.ts `
  scripts/deployment-backup-bundle.test.ts `
  scripts/split-storage-backup.test.ts `
  --reporter=verbose
npm run check
npm run lint -- --no-warn-ignored `
  scripts/deployment-checkpoint.ts `
  scripts/deployment-checkpoint-evidence.ts
git --literal-pathspecs add -- `
  scripts/release-control/contracts.ts `
  scripts/release-control/contracts.test.ts `
  scripts/deployment-checkpoint.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/deployment-checkpoint-runtime.test.ts `
  scripts/deployment-checkpoint-evidence.ts `
  scripts/deployment-checkpoint-evidence.test.ts `
  scripts/deployment-backup-bundle.ts `
  scripts/deployment-backup-bundle.test.ts `
  scripts/split-storage-backup.ts `
  scripts/split-storage-backup.test.ts
git diff --cached --check
git diff --cached
git commit -m "refactor: expose owned checkpoint attestations"
```

### Task 12: Transfer the exact local candidate image to a distinct Docker engine

**Files:**
- Create: `scripts/release-control/candidate-image-transfer.ts`
- Create: `scripts/release-control/candidate-image-transfer.test.ts`
- Modify: `scripts/release-control/contracts.ts`
- Modify: `scripts/release-control/contracts.test.ts`
- Modify: `scripts/deployment-checkpoint.ts`
- Modify: `scripts/deployment-checkpoint.test.ts`
- Modify: `scripts/deployment-checkpoint-runtime.test.ts`
- Modify: `scripts/split-storage-backup.ts`
- Modify: `scripts/split-storage-backup.test.ts`

- [ ] **Step 1: Write source/restore engine and application-image REDs**

Add the local candidate type to the inward release-control contract, then extend the checkpoint application-image union without weakening the existing registry form:

```ts
// scripts/release-control/contracts.ts
export interface Plan7aLocalApplicationImage {
  readonly kind: 'plan7a-local-image-id-v1';
  readonly capability: 'plan7a-release-candidate-v1';
  readonly imageId: string;
  readonly labels: Plan7aImageLabels;
  // Opaque runtime brand minted only from the exact candidate/manifest pair.
}

// scripts/release-control/candidate-image-transfer.ts owns the factory/WeakMap.
export function createPlan7aLocalApplicationImage(input: {
  readonly identity: OwnedCheckpointIdentityLease;
  readonly candidate: CandidateImageLease;
}): Plan7aLocalApplicationImage;

export type Plan7aLocalImageRole = 'source' | 'restore';

export interface ResolvedPlan7aLocalApplicationImage<
  Role extends Plan7aLocalImageRole
> {
  readonly role: Role;
  readonly identity: OwnedCheckpointIdentityLease;
  readonly registeredImage: RegisteredRuntimeImage;
  readonly runtimeIdentity: AuditedDockerRuntimeIdentity;
}

export function resolvePlan7aLocalApplicationImage<
  Role extends Plan7aLocalImageRole
>(input: {
  readonly identity: OwnedCheckpointIdentityLease;
  readonly image: Plan7aLocalApplicationImage;
  readonly role: Role;
}): ResolvedPlan7aLocalApplicationImage<Role>;

// scripts/deployment-checkpoint.ts imports the lower-level type.
export type DeploymentApplicationImage =
  | DeploymentRegistryApplicationImage
  | Plan7aLocalApplicationImage;
```

`contracts.ts` declares only the safe leaf interface and imports no Task 6/6A type. `candidate-image-transfer.ts` owns the shown factory, resolver, and private WeakMap entry `{ identity, role, registeredImage, runtimeIdentity }`; source creation records `role: 'source'`, and transfer records `role: 'restore'`. Every external consumer resolves the original capability at its use boundary; no API accepts a caller-created `ResolvedPlan7aLocalApplicationImage`. Identical safe public source/restore fields still fail when crossed by role. `deployment-checkpoint.ts` imports the safe interface. Only the coordinated capability accepts `plan7a-local-image-id-v1`. The standalone parser and registry validation remain unchanged. Pin the exact coordinated `application-image.json` object:

```ts
export interface CoordinatedLocalApplicationImageRecordV1 {
  readonly kind: 'plan7a-local-image-id-v1';
  readonly APP_IMAGE_ID: string;
  readonly APP_IMAGE_LABELS: Plan7aImageLabels;
  readonly BACKUP_HELPER_IMAGE_ID: string;
  readonly POSTGRES_IMAGE: string;
}
```

Its keys are exact; both ID fields must be the same `sha256:<64 lowercase hex>`, the four labels must match inspection, `POSTGRES_IMAGE` must be `name@sha256:<64 lowercase hex>` and locally expose that exact RepoDigest, and the candidate inspection must prove `Config.User === "node"` plus the expected storage-helper program in the built target. Legacy `application-image.json` remains the disjoint exact four-key `{ APP_IMAGE, BACKUP_HELPER_IMAGE, POSTGRES_IMAGE, RepoDigests }` object. Reject a legacy/local hybrid, unknown/versionless record, tag or image name in an ID field, local ID in the PostgreSQL field, uppercase IDs, unequal helper/app IDs, mismatched labels, missing images, equal engine IDs, omitted/noncanonical context flags, implicit context selection, context/engine drift, or restore substitution. Docker's literal context name `default` remains valid when it is explicitly supplied; the two explicit context names and two observed engine IDs must still differ.

Extend `split-storage-backup.ts` with a programmatic-only disjoint helper union: the existing standalone CLI still supplies and validates exactly one registry `name@sha256` string and matching RepoDigest; the coordinated capability alone supplies `Plan7aLocalApplicationImage`. The local path passes the raw `imageId` to `docker run`, requires inspected `.Id`, all four labels, `Config.User === "node"`, and successful execution of `build/services/storage-volume-backup-helper.js`, and never applies the registry RepoDigest parser. It also requires the exact runtime-branded `RestrictedDockerBindLease` for the bundle root/context/engine/image and reuses its already-proven `dockerUserArgs`; no raw coordinated bundle path is accepted. Reject a raw ID passed through the standalone environment, a registry/local hybrid, missing capability, forged bind capability, root/context/engine/image mismatch, any bind command before attestation, or any label/user/program substitution.

```ts
export type CoordinatedSplitStorageBackupOptions =
  | CoordinatedRegistrySplitStorageBackupOptions
  | CoordinatedSplitStorageBackupOptionsFor<Plan7aLocalApplicationImage>;

// Task 12 modifies scripts/deployment-checkpoint.ts to directly import this
// owner-side resolver; it is never a caller-injected dependency.

// Replace only Task 11's coordinated overload with this widened overload;
// keep the legacy (SplitStorageBackupOptions, SplitStorageBackupRuntime) form.
export function executeSplitStorageBackup(
  options: CoordinatedSplitStorageBackupOptions,
  dependencies: CoordinatedSplitStorageBackupDependencies
): Promise<SplitStorageBackupResult[]>;
```

Keep the existing `SplitStorageBackupOptions.helperImage: string`, string `bundleRoot`, argument parser, environment variable, standalone execution path, and Task 11 coordinated registry overload source-compatible. Extend only the coordinated overload to accept the disjoint `CoordinatedSplitStorageBackupOptions` union; normalize forms internally only after their different capability checks. In the local branch, `mode: 'capture'` requires a runtime-authentic `captureHelper` plus a capture access set; `mode: 'restore'` requires `rehearsalHelper` plus a restore access set. It resolves the original local-image capability for the exact identity/role, then calls Task 6's `consumeOwnedStorageVolumeAccess` with that resolved runtime, exact helper, bundle bind, and unchanged access set before its first command. It derives the separate `volumeProject`, helper namespace, exact per-operation container name, Docker context/engine, owner token, four Plan 7A labels, Compose project/service labels, and user arguments solely from those capabilities. The caller cannot supply any of them. The overload reserves/expects every exact artifact through the bind capability's originating lease, runs the helper under its exact pre-registered container identity, adopts each output before use, and never accepts a raw path.

Task 12 makes `candidate-image-transfer` an inward dependency directly imported by `deployment-checkpoint` only after the local capability exists; Task 11 therefore had no forward reference while its commit was built. The resolver is direct and non-injected. For the local branch, checkpoint capture order is exactly `resolve-source-image -> compare-frozen-registration -> resolve-capture-bind -> attest-capture-volumes -> split-capture`, and rehearsal order is exactly `resolve-restore-image -> compare-frozen-registration -> resolve-rehearsal-bind -> attest-rehearsal-volumes -> split-restore`. The checkpoint requires the resolved source or restore `registeredImage` to be the exact manifest association expected for that role and, for source, `Object.is` the registered image returned by `resolveFrozenCheckpointInputs`; then it passes the original image capability and unchanged access set. Split storage performs the one authenticated consumption immediately before its first helper command. The Plan 7A composition root injects no split owner or owner resolver; checkpoint directly imports the extended split implementation and passes only its low-level runtime.

Task 6's `attestOwnedStorageVolumes` derives the exact three volume names and access-probe container identities from the live raw-helper capability. For capture, a fixed no-network probe performs a bounded complete directory traversal and proves every existing entry can be opened for read without mutation; an empty source volume is valid. For rehearsal, each newly created exact volume must be empty, then the probe creates, writes, file-syncs, closes, rereads, removes, and directory-syncs one nonce sentinel. It returns exactly one role-branded ordered lease per `staging`, `publication`, and `covers`. The function accepts the exact `RestrictedDockerBindLease`, not caller-supplied user arguments, and privately derives/verifies the same audited runtime identity, image, context, engine, and user arguments. UID/GID mismatch, unreadable nested entries, nonempty/unwritable restore roots, foreign volume labels/names, context drift, create-before-ack interruption, structural/wrong-role bind, or helper cleanup residue fails. The coordinated split-storage helper consumes all three same-role leases once; it cannot reconstruct, repeat, cross, mint, or bypass the witness.

- [ ] **Step 2: Write save/load/cleanup REDs**

Against one authentic Task 5 supervisor over an injected fake process adapter, require this order:

1. inspect source and restore engine IDs;
2. require the source candidate ID absent from the sealed restore-engine baseline and current exact inventory;
3. inspect source `imageId` and four labels;
4. accept the exact empty pre-registered Task 6 transfer lease and reserve `candidate-image.tar` with `wx`/private mode;
5. `docker --context <source> image save --output <same-reserved-inode> <imageId>`;
6. verify the archive is one regular non-symlink file under that root;
7. `docker --context <restore> image load --input <owned-archive>`;
8. re-inspect the same raw ID, exactly empty `RepoTags`, four labels, and runtime identity on restore;
9. remove the archive/root before rehearsal; and
10. after successful registration, transfer exposes no cleanup method; Task 6's single `sourceLifecycle.cleanupRehearsalResources(rehearsalLifecycle)` authority removes the introduced restore image after rehearsal and proves exact absence.

Before transfer, derive the digest-pinned PostgreSQL reference and both raw IDs solely from `input.identity.postgresImage`, reobserve its exact RepoDigest/raw-ID equality on both engines, and accept no caller-supplied PostgreSQL string. The coordinator does not pull it, and its image inventory must be unchanged after the run. Timeout, abort, source/save/load/inspect failure, archive replacement, and cleanup failure must all leave no archive/root. A pre-existing restore candidate causes a pre-mutation failure and is never removed. Never use a registry, tag, login, push, pull, or `docker context use` for candidate transport.

- [ ] **Step 3: Run the local-record and transfer REDs**

```powershell
npx vitest run `
  scripts/release-control/contracts.test.ts `
  scripts/release-control/candidate-image-transfer.test.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/deployment-checkpoint-runtime.test.ts `
  scripts/split-storage-backup.test.ts `
  --reporter=verbose
```

Expected: FAIL because the checkpoint parser accepts only the legacy registry object and no exact-ID transfer exists.

- [ ] **Step 4: Implement one owned transfer session**

```ts
export interface CandidateImageTransferInput {
  readonly identity: OwnedCheckpointIdentityLease;
  readonly sourceApplicationImage: Plan7aLocalApplicationImage;
}

export interface CandidateImageTransferSession {
  readonly restoreApplicationImage: Plan7aLocalApplicationImage;
}

export interface CandidateImageTransferDependencies {
  readonly commands: ReleaseControlCommandSupervisor;
  readonly commandEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
}

export async function transferCandidateImage(
  input: CandidateImageTransferInput,
  dependencies: CandidateImageTransferDependencies
): Promise<CandidateImageTransferSession>;
```

The Task 12 module owns a private WeakMap for every `Plan7aLocalApplicationImage`, with exact entry `{ identity, role, registeredImage, runtimeIdentity }`. `resolvePlan7aLocalApplicationImage` authenticates all four associations and returns a frozen inward-only view. Structural copies, serialized/reparsed values, same-safe-field lookalikes, wrong identity/role, and cross-context capabilities fail before a command.

`createPlan7aLocalApplicationImage` first calls Task 6's checkpoint-identity assertion and Task 6A's candidate resolver, then accepts only the exact resolved candidate whose journal is `identity.sourceImageMutation`; it gives source capture and transfer one shared source application-image capability without serializing the private handle. `transferCandidateImage` repeats the checkpoint-identity assertion, then calls its module-owned `resolvePlan7aLocalApplicationImage({ identity: input.identity, image: input.sourceApplicationImage, role: 'source' })` before any command and accepts only that exact `OwnedCheckpointIdentityLease`/source-image pair. A raw image ID/label reconstruction or candidate/identity from another manifest is rejected. Derive both contexts/engine IDs, the registered PostgreSQL reference/observations, the transfer root, and the pre-registered restore image-mutation journal from the authenticated identity. Reserve `candidate-image.tar` before `docker image save`, then adopt only an in-place truncate/write of that identity after the command closes. Immediately before save, re-inspect the source candidate and require `RepoTags` exactly `[]`; after load, require the same raw ID, empty tag set, labels, runtime identity, and helper invariants on restore. Directly call Task 6's `executeOwnedDockerRuntimeAudit` with only the authentic supervisor and associated `host-tools` environment, bind that exact authentic result through `identity.restoreImageMutation`, and mint the session's distinct restore-context `restoreApplicationImage`; source and restore capabilities are never crossed. Verify the archive's POSIX `0600` or protected Windows DACL, stable streaming hash/size bound, identity, and containment before load. Pin a real-Docker Task 17 witness for the installed CLI's same-inode `--output` behavior and that raw-ID save/load of an untagged image creates no tag/reference. Immediately after load can create an image, bind/reinspect the raw ID through the restore journal. Any failure before the session is handed off—including load acknowledgement, tag creation, inspect, ID/label/user/program validation, archive cleanup, or session construction—must internally remove an introduced restore image and prove absence before rejecting. After a successful handoff, Task 6's registered journal is the sole removal authority; the session exposes no cleanup function or redundant runtime-identity field; consumers recover that identity only by resolving the exact image capability at each use. The outer manifest can make the same baseline-plus-label discovery after interruption. Remove the archive, synchronize, and call the registered transfer root's `remove()` before `restore-rehearsal` begins. Treat it as sensitive operational material and never log/evidence it.

- [ ] **Step 5: Prove GREEN and commit**

```powershell
npx vitest run `
  scripts/release-control/contracts.test.ts `
  scripts/release-control/candidate-image-transfer.test.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/deployment-checkpoint-runtime.test.ts `
  scripts/split-storage-backup.test.ts `
  --reporter=verbose
npm run check
npm run lint -- --no-warn-ignored `
  scripts/release-control/candidate-image-transfer.ts `
  scripts/split-storage-backup.ts
git --literal-pathspecs add -- `
  scripts/release-control/contracts.ts `
  scripts/release-control/contracts.test.ts `
  scripts/release-control/candidate-image-transfer.ts `
  scripts/release-control/candidate-image-transfer.test.ts `
  scripts/deployment-checkpoint.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/deployment-checkpoint-runtime.test.ts `
  scripts/split-storage-backup.ts `
  scripts/split-storage-backup.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: bind local release images to rehearsal"
```

### Task 13: Add the only release-candidate composition root

**Files:**
- Create: `scripts/plan7a-release-candidate.ts`
- Create: `scripts/plan7a-release-candidate.test.ts`
- Modify: `package.json`
- Modify: `scripts/worker-heartbeat-deployment.test.ts`
- Modify: `scripts/observability-boundaries.test.ts`

- [ ] **Step 1: Write exact CLI and preflight REDs**

Add exactly this package script:

```json
"smoke:plan7a-release-candidate": "node --import tsx scripts/plan7a-release-candidate.ts"
```

Its explicit grammar is:

```powershell
$PinnedPostgresImage = $env:PLAN7A_POSTGRES_IMAGE
$PinnedPostgresPattern = '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$'
if ($PinnedPostgresImage -cnotmatch $PinnedPostgresPattern) {
  throw 'PLAN7A_POSTGRES_IMAGE must be one reviewed digest-pinned reference'
}
npm run smoke:plan7a-release-candidate -- `
  --candidate-id 22222222-2222-4222-8222-222222222222 `
  --evidence-root C:\temp\pale-orbit-plan7a-release-evidence `
  --origin https://candidate.example.com `
  --source-context source-engine `
  --source-engine-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa `
  --restore-context restore-engine `
  --restore-engine-id bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb `
  --postgres-image $PinnedPostgresImage
```

Reject omitted, duplicated, empty, or unknown flags; noncanonical candidate/evidence/origin values; an origin failing Task 4; equal context names or engine IDs; dirty source or non-`committed_revision`; observed engine mismatch; a source context whose inspected Docker endpoint is not coordinator-local; a mutable/nonlocal PostgreSQL reference; PostgreSQL RepoDigest absence on either engine; failure to render that exact reference plus `pull_policy: never` into the release-production override; mutable application/helper image input; a tag for the built application; and any caller-supplied HTTP/HTTPS port, project, token, backup ID, transfer/rehearsal root, profile, producer, or stages. Pin that dirty/source-shape/source-change/freeze rejection occurs immediately after evidence-root acquisition and produces zero Docker argv and zero socket calls across the complete failed run, including cleanup; only a successful complete committed snapshot permits engine/context checks. Pin producer `plan7a-release-candidate` and profile `release_candidate`. The restore context may be remote only when all Task 5A/6 shared-path, runtime-user, and volume-access attestations succeed; preserved rehearsal never starts Caddy or publishes a host port.

The one PostgreSQL input remains explicit because it is a checkpoint prerequisite, not release application identity. It has no standalone success-evidence field, but it is bound by the configuration fingerprint and coordinated `application-image.json`. There is no helper CLI input: the exact candidate `imageId` is the helper on both engines.

- [ ] **Step 2: Write complete stage-composition REDs**

Inject only the low-level Git/filesystem/command/environment/port/clock/entropy/failure boundaries beneath the real owner modules and require exactly:

```ts
expect(trace).toEqual([
  'preflight',
  'build',
  'compose-config',
  'migrate',
  'provision',
  'checkpoint-capture',
  'restore-rehearsal',
  'runtime-start',
  'runtime-health',
  'inspect',
  'behavior',
  'shutdown',
  'cleanup'
]);
```

Add REDs for a pure, non-injected `createPlan7aReleaseParameters` validator that accepts only a closed own-data-property record with a plain or null prototype, rejects accessors and unexpected fields, runtime-validates every field once, and defensively copies the values into one frozen prototype-free object. Prove that mutation of the accepted input after the call cannot change any callback-visible value; a proxy or accessor-bearing/nonplain input is outside the accepted grammar and fails closed rather than being retained. Require that exact copied object to be the sole callback source for candidate/evidence/origin, both context/engine pairs, and PostgreSQL reference; the callback factory receives no raw input or parallel closure.

Using one authentic Task 5 supervisor over a fake process adapter and its fake port runtime, require preflight first to store the complete clean committed snapshot/digest, then attest the exact source context with its expected engine ID, then allocate one HTTP/TCP port and one distinct HTTPS/TCP+UDP port and store the exact capability/pair. Reject remote endpoint, expected-engine mismatch, unsafe/equal ports, a structural/cross-factory capability, or later endpoint/engine drift before Caddy. Assert `evidence-root -> frozen-source/digest -> source-context attestation -> HTTP allocation -> HTTPS allocation -> subordinate roots -> source lifecycle -> manifest seal -> rehearsal lifecycle`; source failure has zero Docker/port calls, remote failure occurs after freeze but before sockets, every manifest root exists before seal, and rehearsal construction occurs only after the returned checkpoint identity. The same pair and `127.0.0.1` bind addresses populate both complete role environments because rehearsal cleanup precedes source runtime start. Preserved rehearsal starts only PostgreSQL and `app`, never Caddy, so it performs no published-port probe. Immediately before source `runtime-start` first starts Caddy, reattest/probe exact HTTP/TCP and HTTPS/TCP+UDP ports. Unit/watch tests open no process/socket/network and prove the one supervisor remains bound through cleanup/publication.

With every owner module mocked before dynamically importing the coordinator, add a no-dependency construction RED that pins exactly one canonical `new URL('../', import.meta.url)` repository root, one ambient environment/platform snapshot, one shared `now` closure, producer `plan7a-release-candidate` in Task 7's emitter, Task 6's entropy adapter, Task 5's process/port defaults, and the late-bound supervised Git/build-filesystem/restricted-host factories with exact source/environment/supervisor/root identity. Later ambient environment/platform mutation is unobservable; each clock call returns a fresh current `Date`, and the lifecycle/logger receive the identical function object. Default construction draws no entropy, emits no event, and opens no child, socket, Docker, or service resource.

Require one clean committed `FrozenBuildContext` to feed build, Compose, Caddy, migration/journal, all checkpoint SQL, and verifier bytes. The exact release parameters, environment source/`host-tools` environment, one authentic supervisor, one supervisor-bound Task 5A dependency, release identity/preparation, and port owner exist before lifecycle entry without acquiring or mutating any run-owned external resource; the supervisor's listener installation is control-plane setup. After lifecycle-owned evidence-root acquisition, `preflight` immediately awaits/stores the complete committed snapshot, stability fence, later-input registry, and `buildContextSha256` before any Docker argv or port-runtime call. Dirty/source-shape/source-change failure therefore performs only filesystem cleanup. After freeze, attest the source published-loopback context against `state.releaseParameters.sourceContext`/`.sourceEngineId`, allocate HTTP then distinct HTTPS, and reject nonlocal transport before a socket. Only then create one lexical mutable `secretSet` with `createProductionReleaseControlSecretSet(dependencies.entropy)`. One `try/finally` encloses all subsequent root acquisitions and writes: acquire/register the private IID, role-keyed source/rehearsal Compose and secret, transfer, bundle, rehearsal-scratch, and immutable-manifest leases through that preparation; store the IID plus the two exact secret-root leases in state; and, only after both roots exist, write all seven returned strings as UTF-8 without BOM/newline to the matching filenames through each exact lease. The `finally` assigns the local secret-set reference `undefined` on success or any acquisition/write failure, before source lifecycle construction. Tests pin exactly 14 file writes, source/rehearsal byte equality per field, distinct roots/file identities, no cross-field swap, and no raw value outside those private files and the transient lexical record; each scoped environment contains only its seven `_FILE` paths. Then construct only the source base lifecycle with `state.commands` plus `state.hostToolsEnvironment`.

Supply Task 6 one `source-build` registration carrying `state.snapshot`'s four-field `SourceIdentity`, ordered base references, and exact source context/engine, plus one `restore-load` registration carrying that same source identity with no base field and the stored restore context/engine. Supply `postgresImageReference: state.releaseParameters.postgresImage` and all registered roots/identities. Registration supplies no labels, projects, helper namespaces, owner token, backup ID, expected origin, or Compose environment. Task 6 derives every label, independently reobserves both engines, observes both complete image baselines/exact base IDs/the PostgreSQL reference's RepoDigest-backed local ID on each engine, creates role-keyed one-shot database scopes, writes/rereads the single manifest, and returns the only source/restore journals, PostgreSQL identity, and `checkpointIdentity`. Store that exact identity and only then construct `createOwnedRehearsalComposeLifecycle(checkpointIdentity, { commands: state.commands, hostToolsEnvironment: state.hostToolsEnvironment })`; no rehearsal lifecycle exists earlier. Every later callback receives capabilities, never reconstructed projects/tokens/paths/image references. Build/load remain the only registered mutations before the candidate exists on each engine.

The source build receives the exact run identity/preparation, `state.candidateIidRoot`, source journal, and `state.snapshot`; immediately owner-resolve the result before storing it or constructing `BuildStageEvidence`. Then call `createFrozenCheckpointInputs({ identity: checkpointIdentity, candidate })` and `createPlan7aLocalApplicationImage({ identity: checkpointIdentity, candidate })`. Construct the source `production-compose` environment only now from the exact source and complete slots, including loopback addresses, stored ports, and `state.releaseParameters.origin`; bind once, store/resolve configuration, and attest source Compose/secret and capture-bundle binds before first use. `provision` runs role provisioning and the storage-cleanup dry-run first, then consumes the source database scope once, immediately owner-resolves the resulting state, and passes that exact state to capture. After capture, resolve the captured bundle against `checkpointIdentity`, require its result attestation object to match, and resolve that attestation against the exact verified bundle before `CaptureStageEvidence`. Direct image transfer is immediately followed by resolving/storing the restore image against the same identity.

Only then construct `checkpoint-compose` from the same environment source and complete rehearsal slots, reusing stored bind-address/port literals but taking `ORIGIN` and the binder expectation only from authenticated source-configuration evidence; never reread CLI origin after source configuration resolves. Bind once with the restore-registered image, store/resolve it, then attest restore bundle/rehearsal and rehearsal Compose/secret binds before restore mutation. Direct rehearsal evidence is accepted only after `resolveCoordinatedRehearsalAttestation({ identity: checkpointIdentity, capturedBundle: state.capturedBundle, attestation })`. Its sequence is exactly `postgres` then migration/provision/restore then `app`; it never selects Caddy, publishes a host port, or invokes the port prober. Checkpoint execution resolves the correct role-local image at each helper use, obtains all three role-keyed volume-access leases, and passes the unchanged set once to split storage. Render distinct immutable source/rehearsal templates from their public-label capabilities; both resolve the same candidate ID/PostgreSQL reference, cross-role substitution fails, and hashes differ. Pass the exact capture/rehearsal raw-helper identities to their owner. Fingerprint only source configuration for evidence while checkpoint identity binds rehearsal configuration/helper labels. Before capture and restore, inspect each PostgreSQL container and require its reference/raw ID to equal the corresponding checkpoint identity observation; require the exact untagged candidate on both engines, source capture before transfer/rehearsal, and distinct-engine restore success/cleanup. Finally reattest/probe both stored source ports immediately before source `runtime-start` starts Caddy and run production-image maintenance checks on that still-running source project.

The final checkpoint object must be exactly:

```ts
const expectedCheckpoint = {
  backupId,
  backupManifestSha256,
  captureDockerEngineId: sourceEngineId,
  restoreDockerEngineId: restoreEngineId,
  sourceCatalogResult: 'verified',
  restoreCatalogResult: 'verified',
  replacementDisposition: 'clear',
  rehearsalCleanup: {
    containers: 0,
    networks: 0,
    volumes: 0,
    temporaryRoots: 0
  }
} as const;
```

Add one failure test at every dependency boundary. No failure may publish success; all must attempt coordinator-known checkpoint/transfer/rehearsal/Compose/root cleanup. On success the source candidate image remains by raw ID, the introduced restore image is absent, and all other owned resources and temporary roots are absent.

- [ ] **Step 3: Run the coordinator REDs**

```powershell
npx vitest run `
  scripts/plan7a-release-candidate.test.ts `
  scripts/release-control/lifecycle.test.ts `
  scripts/release-control/candidate-image.test.ts `
  scripts/release-control/candidate-image-transfer.test.ts `
  scripts/deployment-checkpoint.test.ts `
  --reporter=verbose
```

Expected: FAIL because the coordinator/package entrypoint, frozen release-parameter store, and authenticated source port composition are absent and release-only composition cannot yet occur.

- [ ] **Step 4: Implement the release callback factory and CLI**

```ts
export interface Plan7aReleaseCandidateInput {
  readonly candidateId: string;
  readonly evidenceRoot: string;
  readonly origin: string;
  readonly sourceContext: string;
  readonly sourceEngineId: DockerEngineId;
  readonly restoreContext: string;
  readonly restoreEngineId: DockerEngineId;
  readonly postgresImage: string;
}

interface Plan7aReleaseParameters {
  readonly candidateId: string;
  readonly evidenceRoot: string;
  readonly origin: string;
  readonly sourceContext: string;
  readonly sourceEngineId: DockerEngineId;
  readonly restoreContext: string;
  readonly restoreEngineId: DockerEngineId;
  readonly postgresImage: string;
}

function createPlan7aReleaseParameters(
  input: Plan7aReleaseCandidateInput
): Plan7aReleaseParameters;

interface Plan7aReleaseCandidateState {
  readonly releaseParameters: Plan7aReleaseParameters;
  readonly identity: OwnedReleaseRunIdentity;
  readonly preparation: OwnedRunPreparation<OwnedReleaseRunIdentity>;
  readonly commandEnvironmentSource: ReleaseControlCommandEnvironmentSource;
  readonly hostToolsEnvironment: ReleaseControlCommandEnvironment<'host-tools'>;
  readonly commands: ReleaseControlCommandSupervisor;
  readonly restrictedPathDependencies: RestrictedPathDependencies;
  readonly portOperations: ReleaseControlPortOperations;
  snapshot?: FrozenBuildContext;
  publishedLoopbackContext?: CoordinatorPublishedLoopbackContext;
  ports?: Readonly<{ readonly http: number; readonly https: number }>;
  candidateIidRoot?: RestrictedPathLease;
  sourceSecretRoot?: RestrictedPathLease;
  rehearsalSecretRoot?: RestrictedPathLease;
  checkpointIdentity?: OwnedCheckpointIdentityLease;
  image?: CandidateImageLease;
  frozenCheckpointInputs?: FrozenCheckpointInputs;
  sourceApplicationImage?: Plan7aLocalApplicationImage;
  restoreApplicationImage?: Plan7aLocalApplicationImage;
  sourceDatabase?: AuthenticatedDatabaseState<'source'>;
  capturedBundle?: AuthenticatedCheckpointBundleLease;
  sourceCompose?: OwnedReleaseSourceComposeLifecycle;
  rehearsalCompose?: OwnedRehearsalComposeLifecycle;
  attestedSourceCompose?:
    AttestedOwnedComposeLifecycle<'source', 'production-compose'>;
  attestedRehearsalCompose?:
    AttestedOwnedComposeLifecycle<'rehearsal', 'checkpoint-compose'>;
  sourceConfiguration?:
    OwnedComposeConfigurationLease<'source', 'production-compose'>;
  rehearsalConfiguration?:
    OwnedComposeConfigurationLease<'rehearsal', 'checkpoint-compose'>;
}

export interface Plan7aReleaseCandidateDependencies {
  readonly repositoryRoot: string;
  readonly restrictedPathHostRuntime?: RestrictedPathHostRuntime;
  readonly git?: GitSnapshotRuntime;
  readonly fileSystem?: BuildContextFileSystem;
  readonly portRuntime: ReleaseControlPortRuntime;
  readonly commandProcessAdapter: CommandProcessAdapter;
  readonly commandEnvironmentInput: ReleaseControlCommandEnvironmentSourceInput;
  readonly now: () => Date;
  readonly emit: (event: SmokeEventInput) => void;
  readonly entropy: ReleaseControlEntropy;
}

type ResolvedPlan7aReleaseCandidateDependencies =
  Omit<
    Plan7aReleaseCandidateDependencies,
    'restrictedPathHostRuntime' | 'git' | 'fileSystem'
  > & Required<Pick<
    Plan7aReleaseCandidateDependencies,
    'restrictedPathHostRuntime' | 'git' | 'fileSystem'
  >>;

function createDefaultPlan7aReleaseCandidateDependencies():
  Plan7aReleaseCandidateDependencies {
  const repositoryRoot = realpathSync.native(
    fileURLToPath(new URL('../', import.meta.url))
  );
  const hostEnvironment = Object.freeze({ ...process.env });
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  const now = () => new Date();
  return Object.freeze({
    repositoryRoot,
    portRuntime: createNodeReleaseControlPortRuntime(),
    commandProcessAdapter: createNodeCommandProcessAdapter(),
    commandEnvironmentInput: { platform, hostEnvironment },
    now,
    emit: createStructuredSmokeEventEmitter({
      producer: 'plan7a-release-candidate',
      now
    }),
    entropy: createNodeReleaseControlEntropy()
  });
}

function createPlan7aReleaseCandidateCallbacks(
  state: Plan7aReleaseCandidateState,
  dependencies: ResolvedPlan7aReleaseCandidateDependencies
): ReleaseSmokeStageCallbacks;

export async function runPlan7aReleaseCandidate(
  input: Plan7aReleaseCandidateInput,
  dependencies?: Plan7aReleaseCandidateDependencies
): Promise<PublishedSmokeEvidenceFor<'release_candidate'>>;
```

The release entrypoint uses the same literal pre-lifecycle ordering as Task 8:

```ts
const releaseParameters = createPlan7aReleaseParameters(input);
const unresolvedDependencies = dependencies ??
  createDefaultPlan7aReleaseCandidateDependencies();
const commandEnvironmentSource = createReleaseControlCommandEnvironmentSource(
  unresolvedDependencies.commandEnvironmentInput
);
const hostToolsEnvironment = createReleaseControlCommandEnvironment({
  source: commandEnvironmentSource,
  scope: 'host-tools',
  slots: {}
});
const commands = createReleaseControlCommandSupervisor(
  unresolvedDependencies.commandProcessAdapter
);
try {
  const git = unresolvedDependencies.git ?? createSupervisedGitSnapshotRuntime({
    repositoryRoot: unresolvedDependencies.repositoryRoot,
    environmentSource: commandEnvironmentSource,
    commands,
    hostToolsEnvironment
  });
  const fileSystem = unresolvedDependencies.fileSystem ??
    createNodeBuildContextFileSystem(unresolvedDependencies.repositoryRoot);
  const restrictedPathHostRuntime =
    unresolvedDependencies.restrictedPathHostRuntime ??
      createNodeRestrictedPathHostRuntime({
        environmentSource: commandEnvironmentSource,
        hostToolsEnvironment,
        commands
      });
  const resolvedDependencies: ResolvedPlan7aReleaseCandidateDependencies = {
    ...unresolvedDependencies,
    git,
    fileSystem,
    restrictedPathHostRuntime
  };
  const restrictedPathDependencies = createRestrictedPathDependencies({
    environmentSource: commandEnvironmentSource,
    hostToolsEnvironment,
    commands,
    hostRuntime: resolvedDependencies.restrictedPathHostRuntime
  });
  const identity = createOwnedRunIdentity({
    producer: 'plan7a-release-candidate',
    profile: 'release_candidate',
    candidateId: releaseParameters.candidateId
  }, resolvedDependencies.entropy);
  const preparation = createOwnedRunPreparation(
    identity,
    { restrictedPathDependencies }
  );
  const portOperations = createReleaseControlPortOperations(
    resolvedDependencies.portRuntime
  );
  const state: Plan7aReleaseCandidateState = {
    releaseParameters,
    identity,
    preparation,
    commandEnvironmentSource,
    hostToolsEnvironment,
    commands,
    restrictedPathDependencies,
    portOperations
  };
  return await runSmokeLifecycle(
    { identity, preparation, evidenceRootTarget: releaseParameters.evidenceRoot },
    createPlan7aReleaseCandidateCallbacks(state, resolvedDependencies),
    {
      now: resolvedDependencies.now,
      emit: resolvedDependencies.emit,
      repositoryRoot: resolvedDependencies.repositoryRoot,
      commands,
      restrictedPathDependencies
    }
  );
} finally {
  await commands.dispose();
}
```

Create the frozen validated `releaseParameters` before any default dependency or supervisor exists. The default factory then performs exactly one read-only canonicalization of `new URL('../', import.meta.url)`, snapshots ambient environment/platform once, creates one shared clock, Task 5's process/port defaults, Task 6's no-draw entropy adapter, and Task 7's no-emit release logger adapter. It does not construct a supervisor-dependent adapter. Next create one Task 5 environment source/`host-tools` environment and one supervisor from the selected low-level process adapter. Inside the shown `try`, normalize an injected or supervised Git adapter, injected or Node build-context filesystem, and injected or Node restricted-path host runtime from that exact source/root/supervisor tuple before creating the one Task 5A dependency, runtime-branded identity/preparation, and Task 5 port owner. Construct module-private state from those resolved objects and pass the same identity/preparation/supervisor/dependency to `runSmokeLifecycle`; no callback replaces them. The entrypoint's `finally` awaits the supervisor's never-rejecting idempotent disposal after success commit or complete failure handling. Tests inject only low-level Git/filesystem/process/port/clock/event/entropy boundaries and assert every real default's exact root/source/environment/supervisor association plus absence of later ambient rereads. No dependency contains a supervisor, preassembled restricted-path dependency, port operations, authority owner, or final Compose environment. Every authority factory/assert/resolve remains a direct import.

State is the single cross-stage store for immutable release parameters, environment/host-tools, supervisor-bound path dependency, port owner, frozen snapshot, source published-loopback capability/pair, source/rehearsal secret-root leases, IID lease, checkpoint identity, frozen inputs, source database, captured bundle, local-image capabilities, base/attested lifecycles, and configuration leases. The raw production secret set is deliberately not cross-stage state: preflight releases that transient reference after writing/verifying both roots. Base handles remain available for cleanup when attestation fails; only attested handles enter coordinated checkpoint options. The first run-owned external-resource mutation is evidence-root acquisition. Preflight then immediately freezes/stores the clean committed source and digest before Docker or ports. Only afterward does it use `state.releaseParameters` to attest the source context, allocate HTTP then distinct HTTPS, generate the one exact production secret set, acquire/materialize all subordinate leases, construct the source lifecycle with `state.commands`, seal the manifest from `state.snapshot` plus registered roots/contexts/base/PostgreSQL prerequisite, and construct rehearsal only from the returned `checkpointIdentity`. Dirty/source-change/freeze failures have zero Docker/socket calls through cleanup; remote context failure occurs after freeze but before sockets. Use only `committed_revision`; no workspace override.

After the registered source image exists, require each secret lease's `listStableFiles()` to equal raw UTF-8 filename order `auth_secret:64`, `bootstrap_admin_password:48`, `database_owner_password:48`, `database_password:48`, `database_storage_cleanup_password:48`, `database_worker_password:48`, `smtp_password:48`, with every kind `file`, and call `assertOwnedRegularFile` on every entry. Build the complete `production-compose` environment once from `state.commandEnvironmentSource`, exact image, the seven exact file paths derived from `state.sourceSecretRoot`, stored ports, validated origin, and the other closed nonsecret/private-presence slots; no raw secret value is an environment slot. After transfer/load returns and is owner-resolved, repeat the identical list/identity check on `state.rehearsalSecretRoot`, then separately build `checkpoint-compose` from the same source, those seven rehearsal paths, and the role-correct image/ports, taking origin only from authenticated source configuration. Neither check returns file text or a content digest to the builder. Each binder authenticates/stores its environment; no later module reconstructs one. Render/bind distinct source/rehearsal templates and require each running project/capture/transfer/rehearsal operation to reobserve its configuration capability. Construct rehearsal only through its checkpoint identity and require exact configuration plus role binds before mutating Compose. Every Docker/Compose/image/checkpoint command uses stored explicit context/engine and never changes process default or pulls. Checkpoint execution resolves the helper at point of use, attests all three role-keyed volumes, and passes their one-shot sets to split storage; it consumes `state.commands`/`state.hostToolsEnvironment`, while coordinated Compose uses environments stored in attested lifecycles. Evidence success/failure and terminal logging can reach only path-presence tokens, never the released secret set or file contents.

Compose remains maintenance with Stripe disabled. Rehearsal starts only `postgres` and `app`, never Caddy or another published-port service; a future service-set change must add restore-context locality/probing. Source `runtime-start` reattests/probes HTTP/TCP and HTTPS/TCP+UDP immediately before Caddy. HTTP behavior/evidence use only authenticated source origin; CLI origin is initial expectation only, and release evidence is output only. Unit/watch tests use one authentic supervisor over a fake adapter and the real port owner over fake sockets; require zero role environment before each role image, zero commands for partial/rebuilt/structural/cross-source/cross-scope environments, zero process/socket/network calls, freeze-before-Docker, exact disposal, and signal-resistant cleanup/publication.

- [ ] **Step 5: Prove GREEN without Docker**

```powershell
npx vitest run `
  scripts/plan7a-release-candidate.test.ts `
  scripts/release-control/candidate-image-transfer.test.ts `
  scripts/deployment-checkpoint-evidence.test.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/worker-heartbeat-deployment.test.ts `
  scripts/observability-boundaries.test.ts `
  --reporter=verbose
npm run check
npm run lint -- --no-warn-ignored scripts/plan7a-release-candidate.ts
```

- [ ] **Step 6: Commit the coordinator**

```powershell
git --literal-pathspecs add -- `
  scripts/plan7a-release-candidate.ts `
  scripts/plan7a-release-candidate.test.ts `
  package.json `
  scripts/worker-heartbeat-deployment.test.ts `
  scripts/observability-boundaries.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: coordinate Plan 7A release candidates"
```

## Milestone E - reserved activation, closure proofs, documentation, and exact-SHA gate

### Task 14: Reserve the live vocabulary while making activation impossible

**Files:**
- Create: `src/lib/server/activation/contracts.ts`
- Create: `src/lib/server/activation/contracts.test.ts`
- Modify: `src/lib/server/config/schema.ts`
- Create: `src/lib/server/config/schema.test.ts`
- Modify: `src/lib/server/config/index.test.ts`
- Modify: `src/lib/server/application-mode.ts`
- Modify: `src/lib/server/application-mode.test.ts`

- [ ] **Step 1: Write raw-vocabulary and unconditional-rejection REDs**

Require the raw schema vocabulary to recognize exactly `prototype`, `maintenance`, and `live`, then reject `live` in development, test, preview-like inputs, and production before a configuration object exists. Pin one safe issue/code and prove no environment variable, evidence path, token, or hidden flag bypasses it.

Require `isRequestAvailable('live', path)` to return false for every path and any exhaustive mode switch to fail closed. Existing prototype and maintenance semantics stay exact; fixture smoke continues using `APPLICATION_MODE=prototype` and does not add a `fixture` application mode.

- [ ] **Step 2: Define only the future prerequisite input shape**

Write type/source-shape tests for this closed contract:

```ts
export interface FutureActivationMigrationTipV1 {
  readonly index: 15;
  readonly tag: '0015_plan7a_operations_authority';
  readonly when: 1787812813508;
  readonly sha256: string;
}

export interface FutureActivationRoleAttestationV1 {
  readonly result: 'verified';
  readonly principalCount: 4;
  readonly pairwiseDistinct: true;
  readonly catalogContract: 'plan7a-database-catalog-v1';
  readonly verifierSha256: string;
}

export interface FutureActivationCheckpointV1 {
  readonly backupId: string;
  readonly backupManifestSha256: string;
  readonly captureDockerEngineId: string;
  readonly restoreDockerEngineId: string;
  readonly sourceCatalogResult: 'verified';
  readonly restoreCatalogResult: 'verified';
  readonly replacementDisposition: 'clear';
  readonly completedAt: string;
  readonly evidenceFingerprint: string;
}

export interface FutureProductionActivationInputV1 {
  readonly version: 1;
  readonly imageId: string;
  readonly sourceRevision: string;
  readonly buildContextSha256: string;
  readonly configurationFingerprint: string;
  readonly origin: string;
  readonly migrationTip: FutureActivationMigrationTipV1;
  readonly databaseRoleAttestation: FutureActivationRoleAttestationV1;
  readonly checkpoint: FutureActivationCheckpointV1;
  readonly releaseCandidate: {
    readonly candidateId: string;
    readonly evidenceFingerprint: string;
    readonly completedAt: string;
    readonly expiresAt: string;
  };
  readonly webHealth: {
    readonly result: 'verified';
    readonly observedAt: string;
    readonly evidenceFingerprint: string;
  };
  readonly workerHealth: {
    readonly result: 'verified';
    readonly observedAt: string;
    readonly evidenceFingerprint: string;
  };
  readonly alertDelivery: {
    readonly result: 'verified';
    readonly deliveredAt: string;
    readonly channelClass: 'operator-critical';
    readonly evidenceFingerprint: string;
  };
  readonly backupFreshness: {
    readonly result: 'verified';
    readonly backupId: string;
    readonly capturedAt: string;
    readonly evidenceFingerprint: string;
  };
  readonly operatorApproval: {
    readonly result: 'verified';
    readonly approvalRecordId: string;
    readonly approvedAt: string;
    readonly approverRole: 'release_operator';
    readonly reversibleMode: 'maintenance';
  };
}

export function rejectPlan7aActivationAttempt(_input: unknown): never {
  throw new Error('activation_not_enabled');
}
```

Static tests must reject any `authorized`, `activate`, `decision`, overlay, evaluator, evidence reader, filesystem, route, Compose, deployment, provider, or process-environment dependency in this module.

These engine fields are inert future wire-shape strings, not Plan 7A parsing authority. The activation module imports no release-control/evidence type; a later approved activation design must authenticate and parse every input before it can replace the unconditional rejection.

- [ ] **Step 3: Run RED, implement the minimum, and prove GREEN**

```powershell
npx vitest run `
  src/lib/server/activation/contracts.test.ts `
  src/lib/server/config/schema.test.ts `
  src/lib/server/config/index.test.ts `
  src/lib/server/application-mode.test.ts `
  --reporter=verbose
```

Expected RED: `live` is not reserved and the activation module does not exist.

Implement only the type, throwing guard, raw enum entry plus unconditional schema refinement, and request rejection. Then run:

```powershell
npx vitest run `
  src/lib/server/activation/contracts.test.ts `
  src/lib/server/config/schema.test.ts `
  src/lib/server/config/index.test.ts `
  src/lib/server/application-mode.test.ts `
  --reporter=verbose
npm run check
npm run lint -- --no-warn-ignored `
  src/lib/server/activation/contracts.ts `
  src/lib/server/config/schema.ts `
  src/lib/server/application-mode.ts
```

- [ ] **Step 4: Commit the unusable reservation**

```powershell
git --literal-pathspecs add -- `
  src/lib/server/activation/contracts.ts `
  src/lib/server/activation/contracts.test.ts `
  src/lib/server/config/schema.ts `
  src/lib/server/config/schema.test.ts `
  src/lib/server/config/index.test.ts `
  src/lib/server/application-mode.ts `
  src/lib/server/application-mode.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: reserve production activation contract"
```

### Task 15: Aggregate negative-boundary, cleanup, privacy, and production-closure verification

**Files:**
- Create: `scripts/release-control-boundaries.test.ts`
- Modify: `scripts/test-profile-boundaries.test.ts`
- Modify: `scripts/worker-heartbeat-deployment.test.ts`
- Modify: `scripts/job-operations-boundaries.test.ts`
- Modify: `scripts/process-secret-scope.test.ts`
- Modify: `scripts/storage-process-isolation.test.ts`
- Modify: `scripts/database-role-deployment.test.ts`
- Modify: `scripts/observability-boundaries.test.ts`

This is an explicitly verification-only closure task. Each behavior/failure/privacy assertion was first written RED and made GREEN in its owning Task 1-14 test file. Task 15 adds no production API or behavior and does not manufacture a missing-file RED; it centralizes static dependency/source-scope checks and runs the already-proved tables as one closure gate.

- [ ] **Step 1: Add one exhaustive dependency/ownership source-scan aggregator**

Pin exact owners and forbidden reverse imports. Require:

- reusable release-control code imports no route, worker entrypoint, provider gateway, financial orchestrator, browser harness, or smoke consumer;
- only `plan7a-release-candidate.ts` selects `release_candidate` or invokes coordinated checkpoint/image transfer;
- only the two Plan 6B scripts select `maintenance_fixture`, and neither emits a checkpoint;
- no second producer/profile/stage vocabulary exists outside observability, no second ordered required-stage sequence exists outside release-control contracts, and no second canonical serializer, evidence publisher, signal supervisor, ownership token/project factory, generic Compose cleanup, or image-transfer implementation exists; consumers contain no `process.on`, public `interrupt`, injected/preassembled supervisor, or independently assembled restricted-path command environment;
- `restricted-path.ts` is the only new platform-private root/file/ACL implementation; every Plan 7A coordinated IID, Compose, secret, evidence, transfer, bundle, and rehearsal mutation consumes its lease/reader rather than a raw path. The unchanged standalone checkpoint grammar may retain only the two exact pre-Checkpoint-D `chmod` call sites in `scripts/deployment-checkpoint.ts` (their source hashes/AST locations are pinned to the base); no coordinated branch can reach them, and no additional `chmod`, DACL, or PowerShell ACL program may appear;
- `compose-config.ts` alone defines the pure four-label constructor, only `owned-compose.ts` calls it, every project/helper label is Task 6-derived, and owned Compose validates those labels on every service/container, network, and volume before discovery or deletion;
- only `owned-compose.ts` imports the low-level restricted-path probe preparation/verification functions or mints raw-bind, Compose-configuration, and storage-volume capabilities; `split-storage-backup.ts` imports no deployment-checkpoint type and consumes but never mints volume access; `compose-config.ts` imports no owned-compose/candidate type;
- `command-runtime.ts` is the only supervisor/process-signal implementation, the sole real Git subprocess adapter, and the only release-control implementation of Docker-context endpoint inspection and TCP/UDP loopback lease allocation/probing; its public Node process/port factories are contract-tested over mocked Node primitives in Task 5. `build-context.ts` alone exports the real read-only Node build-context filesystem, and `restricted-path.ts` alone exports the real Node restricted-path host runtime. All three smoke consumers accept only low-level process/Git/filesystem/port/clock/event/entropy boundaries, create exactly one authentic supervisor, bind it through the supervised Git adapter, Task 5A, and Task 7, and dispose it after terminal handling; the read-only evidence inspector independently creates/disposes one supervisor and one Task 5A dependency around its single CLI invocation. Each no-dependency consumer factory performs the one allowed module-root `realpathSync.native`, snapshots ambient environment/platform once, creates Task 5 process/port defaults, Task 6 identity/secret entropy, Task 7's producer-specific structured emitter, and one shared clock, then late-binds the exact Git/build-filesystem/restricted-host trio only after supervisor construction. Tests pin the three producer literals and prohibit ambient rereads or duplicate default factories. No other new module imports child-process primitives, and none imports `node:net`, `node:dgram`, or a second random-port/filesystem-identity algorithm. `owned-compose.ts` is the sole `node:crypto` identity/secret-byte owner and sole textual secret-set mapper; `command-runtime.ts` may import only the moved nonsecret random-integer primitive for port choice, while all three consumers import neither and may only call the topology-correct Task 6 mapping once. Static/runtime tests pin all 13 destinations and prohibit a second encoder/wrapper; production/release keep no post-materialization secret-set state, while fixture clears its extra record after binding and on cleanup. Only `evidence.ts` calls success-publication boundary helpers, and only shutdown/cleanup/rollback/absence owners—including failure-publication rollback—call `runCleanup()`;
- run ID/token/backup/project/helper names have exactly one canonical storage location in the runtime-branded Task 6 identity graph; no registration API accepts labels and no checkpoint/image/bind consumer authorizes a structural capability without calling its owner-side resolver;
- unit/watch commands cannot reach Docker, Compose, PostgreSQL, network, checkpoint, or the release coordinator;
- no route, hook, worker runtime, config loader, Compose file, or deployment script reads success evidence or activation contracts; and
- package scripts add only `smoke:plan7a-release-candidate`; dependencies and lockfile remain unchanged.

- [ ] **Step 2: Aggregate the owning tasks' exhaustive failure and privacy tables**

Require the aggregator to enumerate or import the table-driven injected failures already introduced RED-first in Tasks 1-13 for every stage and mutation boundary across all three consumers. The union must include dirty release source, source changing mid-freeze, ignored/reincluded path mistakes, context digest mismatch, invalid image ID/labels, Compose topology/secret/config mismatch, POSIX mode or Windows DACL/reparse/identity/directory-flush failure, origin mismatch, migration/journal mismatch, role/catalog failure, backup replacement, equal/drifting engines, save/load substitution, timeout, caller abort, signal before/during/between commands, signal during shutdown/cleanup/rollback/every publication await/final removal, shutdown failure, cleanup failure, residual resource, expired evidence, expectation mismatch, and publication collision. Require the full failed-run trace for every dirty/source-shape/change/freezer case to contain zero Docker argv and zero port-runtime calls, including cleanup; require signal cases to show exactly one cleanup callback, signal-resistant bounded cleanup commands, no success commit, and listener disposal. A source-shape assertion proves every required case ID is owned exactly once; Task 15 does not introduce a new behavior case after its owner is implemented.

For every case require nonzero/fixed safe failure, no success evidence, cleanup attempt, and preservation of foreign/pre-existing state. Recursively scan every captured event, success/failure object, thrown public error, and published byte sequence for fixed canaries representing:

```ts
const forbiddenCanaries = [
  'secret-value-canary',
  'postgres://credential-canary',
  'stripe-payload-canary',
  'customer@example.invalid',
  'storage/key/canary',
  'dedupe-canary',
  'C:\\private\\checkpoint-canary',
  '--password=command-canary',
  'stderr-canary',
  'stdout-canary'
] as const;
```

Also aggregate the already-green rejection of forbidden key fragments case-insensitively: `secret`, `password`, `credential`, `connection`, `environment`, `stdout`, `stderr`, `command`, `payload`, `storageKey`, `deduplication`, `path`, and `imageDigest`, except the approved boolean presence tokens inside the in-memory redacted configuration that never enter evidence.

- [ ] **Step 3: Freeze the unchanged production surface**

Hash or exact-source assert that `compose.prod.yaml`, `compose.stripe.yaml`, `Dockerfile`, `.dockerignore`, migrations/snapshots/journal, routes, database schema, and `package-lock.json` have not changed from `6406c02cf463f1f0a389488e587ac688078d2cf8`. Require production Compose still contains maintenance mode and both Stripe flags false, no production `.env`, no public PostgreSQL/storage port, and only Caddy at the edge.

Assert repository-wide absence of a registry push/login, signing, deployment, SSH, scheduler, monitoring/metrics/dashboard/SLO/alert transport, usable live overlay, activation evaluator, provider call, new route, or operations UI introduced by the Checkpoint D diff.

- [ ] **Step 4: Run the broad hermetic boundary gate**

```powershell
npx vitest run `
  scripts/release-control/restricted-path.test.ts `
  scripts/release-control-boundaries.test.ts `
  scripts/test-profile-boundaries.test.ts `
  scripts/worker-heartbeat-deployment.test.ts `
  scripts/job-operations-boundaries.test.ts `
  scripts/process-secret-scope.test.ts `
  scripts/storage-process-isolation.test.ts `
  scripts/database-role-deployment.test.ts `
  scripts/observability-boundaries.test.ts `
  --reporter=verbose
npm run check
npm run lint
```

- [ ] **Step 5: Commit the closure witnesses**

```powershell
git --literal-pathspecs add -- `
  scripts/release-control-boundaries.test.ts `
  scripts/test-profile-boundaries.test.ts `
  scripts/worker-heartbeat-deployment.test.ts `
  scripts/job-operations-boundaries.test.ts `
  scripts/process-secret-scope.test.ts `
  scripts/storage-process-isolation.test.ts `
  scripts/database-role-deployment.test.ts `
  scripts/observability-boundaries.test.ts
git diff --cached --check
git diff --cached
git commit -m "test: prove release control failure boundaries"
```

### Task 16: Document the implemented foundation and the still-closed production boundary

**Files:**
- Modify: `scripts/release-control-boundaries.test.ts`
- Modify: `README.md`
- Modify: `docs/runtime-environments.md`
- Modify: `docs/database-and-workers.md`
- Modify: `docs/storage-ingestion-and-publication.md`
- Modify: `docs/authentication-and-email.md`
- Modify: `docs/commerce-and-guest-claims.md`
- Modify: `docs/customer-library-and-reader.md`
- Modify: `docs/financial-reconciliation-and-reporting.md`
- Modify: `docs/stripe-financial-reconciliation.md`
- Modify: `docs/dependency-decisions.md`

- [ ] **Step 1: Add documentation source-shape REDs**

Extend the closest existing documentation tests, or add assertions to `scripts/release-control-boundaries.test.ts`, requiring the current-document set collectively to distinguish the following corpus-wide facts; the per-file matrix below is authoritative for which document owns each subset:

- the two independent workspace maintenance smoke commands;
- the committed, clean, distinct-engine release-candidate command;
- candidate/evidence root non-reuse, 24-hour expiry, exact expectation matching, and immutable-SHA invalidation;
- the deliberately retained local source `imageId` and operator responsibility for later removal;
- explicit source/restore Docker context and origin inputs, distinct observed engine IDs, coordinator-local `unix://`/`npipe://` source-context publication, and the required authenticated shared-path/node-UID/volume-access envelope (remote source publication and unsupported remote filesystems fail preflight; a remote restore remains eligible only because rehearsal starts no published-port service);
- the version-2 checkpoint bundle remaining local/rehearsal material, not off-host backup coverage;
- production remaining maintenance-only with Stripe disabled; and
- monitoring, alert delivery, scheduled/off-host backup, registry/signing/deployment, hardening, and activation remaining later work.

Require docs to use `imageId`, never `imageDigest`, and to avoid generated SQL, secret values, raw evidence examples, or claims that Checkpoint D deploys or authorizes production.

Pin one table-driven test titled `documents the exact Checkpoint D command and boundary matrix` with this exact per-file ownership:

- `README.md`: replace the deferred-Checkpoint-D summary with the three command names, release-candidate purpose, 24-hour evidence/immutable-SHA rule, retained-local-image responsibility, and the still-closed production/later-work sentence.
- `docs/runtime-environments.md`: add the complete release CLI block using `<source-context>`, `<source-engine-id>`, `<restore-context>`, `<restore-engine-id>`, `<canonical-origin>`, `<postgres-name@sha256>`, fresh candidate ID, and fresh evidence root; define the canonical context/engine/origin constraints, require a coordinator-local source Docker endpoint for Caddy publication, explain that preserved rehearsal starts no published-port service, and define the supported shared-path/node-UID/volume-access preflight.
- `docs/database-and-workers.md`: document the one-shot role-keyed source/rehearsal migration-tip, four-principal, catalog, and five-diagnostic authentication in the exact migrate → provision → capture → distinct-engine rehearsal → production-image-smoke order.
- `docs/storage-ingestion-and-publication.md`: distinguish the existing standalone registry-digest checkpoint workflow from coordinated local raw-ID transfer; state that the version-2 bundle and restore engine are local rehearsal material, every storage class is access-probed, and this is not scheduled/off-host backup.
- `docs/authentication-and-email.md`: state that the release gate validates scoped auth/SMTP secret presence without exposing values and does not enable live email/storefront operation.
- `docs/commerce-and-guest-claims.md`: state that maintenance behavior validates local commerce/guest-claim boundaries with Stripe disabled and makes no provider call or activation decision.
- `docs/customer-library-and-reader.md`: state that source/rehearsal catalog and storage behavior checks cover library/reader preservation but do not launch public access.
- `docs/financial-reconciliation-and-reporting.md`: document source/restored `plan7a-database-catalog-v1` verification, exact five-row `clear` requirement, and the fact that no monitor, scheduler, or deployment is added.
- `docs/stripe-financial-reconciliation.md`: state that both base production and the release candidate keep Stripe disabled/false and that registry/deployment/Stripe-live work remains later.
- `docs/dependency-decisions.md`: record the no-new-package decision, local untagged save/load transport, no registry/signing/deployment, and operator cleanup of the retained source raw ID.

Every matrix row must link both the Plan 7A design and this implementation plan, directly or through the README's canonical links, and must preserve that document's existing domain-specific procedures rather than restating unrelated rows.

Run the changed source-shape test before editing any document and require the intended RED:

```powershell
$DocsRedOutput = @(npx vitest run `
  scripts/release-control-boundaries.test.ts --reporter=verbose 2>&1)
$DocsRedExit = $LASTEXITCODE
$DocsRedText = $DocsRedOutput -join "`n"
if ($DocsRedExit -ne 1 -or
    $DocsRedText -cnotmatch 'documents the exact Checkpoint D command and boundary matrix' -or
    $DocsRedText -match 'SyntaxError|Failed to load|No test files found') {
  throw 'Documentation RED was not the intended exact source-shape assertion failure'
}
```

Expected: FAIL only on the newly required current-document statements.

- [ ] **Step 2: Update current docs only**

Apply exactly the per-file matrix above. Use explicit placeholders described in prose, not fabricated credentials or engine identifiers. Add no unrelated tutorial or duplicate command block. Do not rewrite historical Plan 6 specs/plans or mark Checkpoint D complete yet; each current document says the Checkpoint D implementation is pending final immutable-SHA verification/review until Task 18.

- [ ] **Step 3: Run docs/boundary tests and commit**

```powershell
npx vitest run `
  scripts/release-control-boundaries.test.ts `
  scripts/test-profile-boundaries.test.ts `
  scripts/worker-heartbeat-deployment.test.ts `
  --reporter=verbose
npm run check
git --literal-pathspecs add -- `
  scripts/release-control-boundaries.test.ts `
  README.md `
  docs/runtime-environments.md `
  docs/database-and-workers.md `
  docs/storage-ingestion-and-publication.md `
  docs/authentication-and-email.md `
  docs/commerce-and-guest-claims.md `
  docs/customer-library-and-reader.md `
  docs/financial-reconciliation-and-reporting.md `
  docs/stripe-financial-reconciliation.md `
  docs/dependency-decisions.md
git diff --cached --check
git diff --cached
git commit -m "docs: document Plan 7A release control"
```

### Task 17: Run the complete immutable-SHA release gate

**Files:**
- Verify only; do not edit or commit in this task.

**PowerShell session contract:** Steps 1-6 are one transaction in one fresh persistent PowerShell 7 process started at the repository root. `PLAN7A_EXPECTED_HEAD`, `PLAN7A_SOURCE_DOCKER_CONTEXT`, `PLAN7A_RESTORE_DOCKER_CONTEXT`, `PLAN7A_RELEASE_ORIGIN`, and `PLAN7A_POSTGRES_IMAGE` must be present before Step 1. Every later fence continues that same process and intentionally consumes its functions and variables; do not run the fences as independent `pwsh -Command` invocations. If the process exits, loses state, or any gate fails, Task 17 is incomplete: apply the authenticated obsolete-image rule if necessary, choose fresh candidate IDs and evidence roots, and restart at Step 1. Step 6 persists the safe literal results in the verification note; in-memory variables are never a handoff.

- [ ] **Step 1: Prove ancestry, cleanliness, and the intended diff**

```powershell
$ErrorActionPreference = 'Stop'
$CheckpointDBase = '6406c02cf463f1f0a389488e587ac688078d2cf8'
git merge-base --is-ancestor $CheckpointDBase HEAD
if ($LASTEXITCODE -ne 0) { throw 'Checkpoint D base is not an ancestor' }
$ExpectedHead = $env:PLAN7A_EXPECTED_HEAD
if ($ExpectedHead -cnotmatch '^[a-f0-9]{40}$') {
  throw 'PLAN7A_EXPECTED_HEAD must be the operator-approved exact candidate SHA'
}
function Assert-ExpectedGitState([string] $Expected) {
  $Actual = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $Actual -cne $Expected) {
    throw "HEAD is not the expected immutable candidate: $Expected"
  }
  $Status = @(git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $Status.Count -ne 0) {
    throw 'Immutable-SHA gate requires an exactly clean tree'
  }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'Working-tree diff check failed' }
}
function Assert-ExactOrdinalPathSet(
  [string] $Description,
  [string[]] $Expected,
  [string[]] $Actual
) {
  $ExpectedSorted = @($Expected | Sort-Object -CaseSensitive)
  $ActualSorted = @($Actual | Sort-Object -CaseSensitive)
  if ($ExpectedSorted.Count -ne $ActualSorted.Count) {
    throw "$Description count mismatch"
  }
  for ($Index = 0; $Index -lt $ExpectedSorted.Count; $Index += 1) {
    if ($ExpectedSorted[$Index] -cne $ActualSorted[$Index]) {
      throw "$Description mismatch at index $Index"
    }
  }
}
Assert-ExpectedGitState $ExpectedHead
git diff --check "${CheckpointDBase}...${ExpectedHead}"
if ($LASTEXITCODE -ne 0) { throw 'Checkpoint D diff check failed' }
$ExpectedAddedCheckpointDFiles = @'
docs/superpowers/plans/2026-08-29-plan-7a-checkpoint-d-release-control-foundation.md
scripts/deployment-checkpoint-evidence.test.ts
scripts/deployment-checkpoint-evidence.ts
scripts/plan7a-release-candidate.test.ts
scripts/plan7a-release-candidate.ts
scripts/release-control-boundaries.test.ts
scripts/release-control/build-context.test.ts
scripts/release-control/build-context.ts
scripts/release-control/candidate-image-transfer.test.ts
scripts/release-control/candidate-image-transfer.ts
scripts/release-control/candidate-image.test.ts
scripts/release-control/candidate-image.ts
scripts/release-control/canonical-json.test.ts
scripts/release-control/canonical-json.ts
scripts/release-control/command-runtime.test.ts
scripts/release-control/command-runtime.ts
scripts/release-control/compose-config.test.ts
scripts/release-control/compose-config.ts
scripts/release-control/contracts.test.ts
scripts/release-control/contracts.ts
scripts/release-control/database-attestation.test.ts
scripts/release-control/database-attestation.ts
scripts/release-control/docker-context-tar.test.ts
scripts/release-control/docker-context-tar.ts
scripts/release-control/dockerignore.test.ts
scripts/release-control/dockerignore.ts
scripts/release-control/evidence-inspect.ts
scripts/release-control/evidence.test.ts
scripts/release-control/evidence.ts
scripts/release-control/lifecycle.test.ts
scripts/release-control/lifecycle.ts
scripts/release-control/owned-compose.test.ts
scripts/release-control/owned-compose.ts
scripts/release-control/restricted-path.test.ts
scripts/release-control/restricted-path.ts
src/lib/server/activation/contracts.test.ts
src/lib/server/activation/contracts.ts
src/lib/server/config/schema.test.ts
'@ -split "`n" | ForEach-Object Trim | Where-Object { $_ }
$ExpectedModifiedCheckpointDFiles = @'
README.md
docs/authentication-and-email.md
docs/commerce-and-guest-claims.md
docs/customer-library-and-reader.md
docs/database-and-workers.md
docs/dependency-decisions.md
docs/financial-reconciliation-and-reporting.md
docs/runtime-environments.md
docs/storage-ingestion-and-publication.md
docs/stripe-financial-reconciliation.md
docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md
package.json
scripts/commerce-operations.test.ts
scripts/database-role-deployment.test.ts
scripts/deployment-backup-bundle.test.ts
scripts/deployment-backup-bundle.ts
scripts/deployment-checkpoint-runtime.test.ts
scripts/deployment-checkpoint.test.ts
scripts/deployment-checkpoint.ts
scripts/job-operations-boundaries.test.ts
scripts/observability-boundaries.test.ts
scripts/plan6b-fixture-runtime-probe.test.ts
scripts/plan6b-fixture-runtime-probe.ts
scripts/plan6b-production-smoke.test.ts
scripts/plan6b-production-smoke.ts
scripts/process-secret-scope.test.ts
scripts/split-storage-backup.test.ts
scripts/split-storage-backup.ts
scripts/storage-process-isolation.test.ts
scripts/test-profile-boundaries.test.ts
scripts/with-plan6b-upgrade-database.test.ts
scripts/worker-heartbeat-deployment.test.ts
src/lib/server/application-mode.test.ts
src/lib/server/application-mode.ts
src/lib/server/config/index.test.ts
src/lib/server/config/schema.ts
src/lib/server/observability/contracts.test.ts
src/lib/server/observability/contracts.ts
'@ -split "`n" | ForEach-Object Trim | Where-Object { $_ }
if ($ExpectedAddedCheckpointDFiles.Count -ne 38 -or
    $ExpectedModifiedCheckpointDFiles.Count -ne 38) {
  throw 'Checkpoint D expected status partition is not 38 added plus 38 modified'
}
$NameStatusLines = @(git diff --name-status --no-renames `
  "${CheckpointDBase}...${ExpectedHead}")
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate Checkpoint D status rows' }
$SeenStatusPaths = [Collections.Generic.HashSet[string]]::new(
  [StringComparer]::Ordinal
)
$ActualAddedCheckpointDFiles = [Collections.Generic.List[string]]::new()
$ActualModifiedCheckpointDFiles = [Collections.Generic.List[string]]::new()
foreach ($Line in $NameStatusLines) {
  if ($Line -cnotmatch '^(A|M)\t([^\t]+)$') {
    throw "Forbidden or malformed Checkpoint D status row: $Line"
  }
  $StatusCode = $Matches[1]
  $StatusPath = $Matches[2]
  if (-not $SeenStatusPaths.Add($StatusPath)) {
    throw "Duplicate Checkpoint D status path: $StatusPath"
  }
  if ($StatusCode -ceq 'A') {
    $ActualAddedCheckpointDFiles.Add($StatusPath)
  } else {
    $ActualModifiedCheckpointDFiles.Add($StatusPath)
  }
}
Assert-ExactOrdinalPathSet 'added Checkpoint D paths' `
  $ExpectedAddedCheckpointDFiles $ActualAddedCheckpointDFiles.ToArray()
Assert-ExactOrdinalPathSet 'modified Checkpoint D paths' `
  $ExpectedModifiedCheckpointDFiles $ActualModifiedCheckpointDFiles.ToArray()
git diff --stat "${CheckpointDBase}...${ExpectedHead}"
if ($LASTEXITCODE -ne 0) { throw 'Cannot summarize Checkpoint D diff' }
```

Expected: exact operator-approved HEAD, clean tree, exactly 38 added plus 38 modified planned paths, no deleted/renamed/copied/type-changed/unmerged path, and no forbidden production surface change. Unit fixtures separately prove rejection when one expected path is omitted, one unplanned path is added, A/M is swapped, a row is duplicated, or a D/R/C/T/U status appears.

- [ ] **Step 2: Run the focused deterministic gate serially**

```powershell
npx vitest run `
  scripts/release-control/canonical-json.test.ts `
  scripts/release-control/contracts.test.ts `
  scripts/release-control/dockerignore.test.ts `
  scripts/release-control/docker-context-tar.test.ts `
  scripts/release-control/build-context.test.ts `
  scripts/release-control/compose-config.test.ts `
  scripts/release-control/database-attestation.test.ts `
  scripts/release-control/command-runtime.test.ts `
  scripts/release-control/restricted-path.test.ts `
  scripts/release-control/candidate-image.test.ts `
  scripts/release-control/owned-compose.test.ts `
  scripts/release-control/evidence.test.ts `
  scripts/release-control/lifecycle.test.ts `
  scripts/release-control/candidate-image-transfer.test.ts `
  scripts/deployment-backup-bundle.test.ts `
  scripts/deployment-checkpoint-evidence.test.ts `
  scripts/deployment-checkpoint.test.ts `
  scripts/deployment-checkpoint-runtime.test.ts `
  scripts/split-storage-backup.test.ts `
  scripts/commerce-operations.test.ts `
  scripts/commerce-privacy.test.ts `
  scripts/plan6b-production-smoke.test.ts `
  scripts/plan6b-fixture-runtime-probe.test.ts `
  scripts/plan7a-release-candidate.test.ts `
  src/lib/server/activation/contracts.test.ts `
  src/lib/server/config/schema.test.ts `
  src/lib/server/config/index.test.ts `
  src/lib/server/application-mode.test.ts `
  scripts/release-control-boundaries.test.ts `
  --maxWorkers=1 --reporter=verbose
if ($LASTEXITCODE -ne 0) { throw 'Focused Checkpoint D tests failed' }
npm run check
if ($LASTEXITCODE -ne 0) { throw 'Type/Svelte check failed' }
npm run lint
if ($LASTEXITCODE -ne 0) { throw 'Lint failed' }
npm run test:unit
if ($LASTEXITCODE -ne 0) { throw 'Hermetic unit gate failed' }
npm run db:check
if ($LASTEXITCODE -ne 0) { throw 'Database contract check failed' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Production build failed' }
Assert-ExpectedGitState $ExpectedHead
```

Do not parallelize these commands or increase a timeout to hide contention.

- [ ] **Step 3: Snapshot external state before service-backed verification**

Use fixed operator-selected Docker contexts and new restricted roots outside the repository:

```powershell
$SourceContext = $env:PLAN7A_SOURCE_DOCKER_CONTEXT
$RestoreContext = $env:PLAN7A_RESTORE_DOCKER_CONTEXT
$ReleaseOrigin = $env:PLAN7A_RELEASE_ORIGIN
$ContextPattern = '^[A-Za-z0-9_.-]{1,128}$'
$EngineIdPattern = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
if ($SourceContext -cnotmatch $ContextPattern -or
    $RestoreContext -cnotmatch $ContextPattern -or
    $SourceContext -ceq $RestoreContext) {
  throw 'Two distinct explicit canonical Docker context names are required'
}
if ([string]::IsNullOrWhiteSpace($ReleaseOrigin)) {
  throw 'PLAN7A_RELEASE_ORIGIN is required'
}
$NodeBuildImage = 'node:26.7.0-bookworm-slim'
$PinnedPostgresImage = $env:PLAN7A_POSTGRES_IMAGE
$PinnedPostgresPattern = '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$'
if ($PinnedPostgresImage -cnotmatch $PinnedPostgresPattern) {
  throw 'PLAN7A_POSTGRES_IMAGE must be an exact lowercase name@sha256 reference'
}

$SourceEngineLines = @(docker --context $SourceContext info --format '{{.ID}}')
if ($LASTEXITCODE -ne 0 -or $SourceEngineLines.Count -ne 1 -or
    ([string]$SourceEngineLines[0]) -cnotmatch $EngineIdPattern) {
  throw 'Cannot inspect canonical source Docker engine ID'
}
$SourceEngineId = [string]$SourceEngineLines[0]
$RestoreEngineLines = @(docker --context $RestoreContext info --format '{{.ID}}')
if ($LASTEXITCODE -ne 0 -or $RestoreEngineLines.Count -ne 1 -or
    ([string]$RestoreEngineLines[0]) -cnotmatch $EngineIdPattern) {
  throw 'Cannot inspect canonical restore Docker engine ID'
}
$RestoreEngineId = [string]$RestoreEngineLines[0]
if ($SourceEngineId -ceq $RestoreEngineId) {
  throw 'Two distinct identified Docker engines are required'
}
$script:ReleaseGateAddedSourceImages = @()
$script:ReleaseGateAfterSource = $null
$script:ReleaseGateAfterRestore = $null
$script:ReleaseGateAfterRoots = $null

function Assert-EngineIdentity {
  param([string]$Context, [string]$ExpectedId)
  $ActualLines = @(docker --context $Context info --format '{{.ID}}')
  if ($LASTEXITCODE -ne 0 -or $ActualLines.Count -ne 1 -or
      ([string]$ActualLines[0]) -cnotmatch $EngineIdPattern -or
      ([string]$ActualLines[0]) -cne $ExpectedId) {
    throw "Docker engine identity drifted for $Context"
  }
}

function Assert-LocalImageReference {
  param([string]$Context, [string]$Reference, [switch]$RequireRepoDigest)
  $InspectId = ([string](docker --context $Context image inspect --format '{{.Id}}' $Reference)).Trim()
  if ($LASTEXITCODE -ne 0 -or $InspectId -cnotmatch '^sha256:[a-f0-9]{64}$') {
    throw "Required local image is unavailable on $Context"
  }
  if ($RequireRepoDigest) {
    $RepoDigestJson = docker --context $Context image inspect --format '{{json .RepoDigests}}' $Reference
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect RepoDigests on $Context" }
    $RepoDigests = @($RepoDigestJson | ConvertFrom-Json)
    if ($RepoDigests -cnotcontains $Reference) {
      throw "Pinned RepoDigest does not match on $Context"
    }
  }
}

# Task 6A builds with --pull=false. These runtime/base references must exist before the baseline.
Assert-LocalImageReference -Context $SourceContext -Reference $NodeBuildImage
foreach ($Reference in @(
  'postgres:18.4-alpine3.24',
  'caddy:2.11.4-alpine',
  'axllent/mailpit:v1.30.0'
)) {
  Assert-LocalImageReference -Context $SourceContext -Reference $Reference
}
Assert-LocalImageReference -Context $SourceContext -Reference $PinnedPostgresImage -RequireRepoDigest
Assert-LocalImageReference -Context $RestoreContext -Reference $PinnedPostgresImage -RequireRepoDigest

$TempParent = [IO.Path]::GetTempPath()

function Get-EngineInventory {
  param([string]$Context)
  $Containers = @(docker --context $Context ps -aq)
  if ($LASTEXITCODE -ne 0) { throw "Cannot inventory containers on $Context" }
  $Networks = @(docker --context $Context network ls -q)
  if ($LASTEXITCODE -ne 0) { throw "Cannot inventory networks on $Context" }
  $Volumes = @(docker --context $Context volume ls -q)
  if ($LASTEXITCODE -ne 0) { throw "Cannot inventory volumes on $Context" }
  $Images = @(docker --context $Context image ls --all --no-trunc --quiet)
  if ($LASTEXITCODE -ne 0) { throw "Cannot inventory images on $Context" }
  [pscustomobject]@{
    Containers = @($Containers | ForEach-Object Trim | Where-Object { $_ } |
      Sort-Object -CaseSensitive -Unique)
    Networks = @($Networks | ForEach-Object Trim | Where-Object { $_ } |
      Sort-Object -CaseSensitive -Unique)
    Volumes = @($Volumes | ForEach-Object Trim | Where-Object { $_ } |
      Sort-Object -CaseSensitive -Unique)
    Images = @($Images | ForEach-Object Trim | Where-Object { $_ } |
      Sort-Object -CaseSensitive -Unique)
  }
}

function ConvertTo-TemporaryRootRecord {
  param([IO.FileSystemInfo]$Item)
  $Kind = if ($Item.LinkType) {
    'link'
  } elseif ($Item.PSIsContainer) {
    'directory'
  } else {
    'file'
  }
  [ordered]@{
    path = [IO.Path]::GetFullPath($Item.FullName)
    kind = $Kind
    linkType = [string]$Item.LinkType
  } | ConvertTo-Json -Compress
}

function Get-PaleOrbitTemporaryRoots {
  @(Get-ChildItem -Force -LiteralPath $TempParent -Filter 'pale-orbit-*' |
    ForEach-Object { ConvertTo-TemporaryRootRecord $_ } |
    Sort-Object -CaseSensitive -Unique)
}

function Assert-ExactInventorySet {
  param([string]$Name, [string[]]$Before, [string[]]$After)
  if (Compare-Object @($Before) @($After) -CaseSensitive -SyncWindow 0) {
    throw "$Name changed"
  }
}

function Invoke-IsolatedServiceGate {
  param(
    [string]$Name,
    [scriptblock]$Command,
    [string]$EvidenceRoot = '',
    [switch]$UseSourceContextEnvironment,
    [switch]$AllowRetainedSourceImage
  )
  Assert-ExpectedGitState $ExpectedHead
  Assert-EngineIdentity $SourceContext $SourceEngineId
  Assert-EngineIdentity $RestoreContext $RestoreEngineId
  $BeforeSource = Get-EngineInventory $SourceContext
  $BeforeRestore = Get-EngineInventory $RestoreContext
  $BeforeRoots = @(Get-PaleOrbitTemporaryRoots)
  $PreviousDockerContext = $env:DOCKER_CONTEXT
  $CommandFailure = $null
  try {
    if ($UseSourceContextEnvironment) { $env:DOCKER_CONTEXT = $SourceContext }
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Name failed" }
  } catch {
    $CommandFailure = $_
  } finally {
    if ($UseSourceContextEnvironment) {
      if ($null -eq $PreviousDockerContext) {
        Remove-Item Env:DOCKER_CONTEXT -ErrorAction SilentlyContinue
      } else {
        $env:DOCKER_CONTEXT = $PreviousDockerContext
      }
    }
  }

  Assert-ExpectedGitState $ExpectedHead
  Assert-EngineIdentity $SourceContext $SourceEngineId
  Assert-EngineIdentity $RestoreContext $RestoreEngineId
  $AfterSource = Get-EngineInventory $SourceContext
  $AfterRestore = Get-EngineInventory $RestoreContext
  $AfterRoots = @(Get-PaleOrbitTemporaryRoots)
  foreach ($Kind in @('Containers', 'Networks', 'Volumes')) {
    Assert-ExactInventorySet "source $Kind after $Name" $BeforeSource.$Kind $AfterSource.$Kind
    Assert-ExactInventorySet "restore $Kind after $Name" $BeforeRestore.$Kind $AfterRestore.$Kind
  }
  Assert-ExactInventorySet "restore images after $Name" $BeforeRestore.Images $AfterRestore.Images

  if ($AllowRetainedSourceImage -and $null -eq $CommandFailure) {
    $ImageDelta = @(Compare-Object $BeforeSource.Images $AfterSource.Images -CaseSensitive)
    $RemovedImages = @($ImageDelta | Where-Object SideIndicator -eq '<=')
    $AddedImages = @($ImageDelta | Where-Object SideIndicator -eq '=>')
    if ($RemovedImages.Count -ne 0 -or $AddedImages.Count -gt 1) {
      throw "unexpected source image delta after $Name"
    }
    $script:ReleaseGateAddedSourceImages = @(
      $AddedImages | ForEach-Object InputObject
    )
  } else {
    Assert-ExactInventorySet "source images after $Name" $BeforeSource.Images $AfterSource.Images
  }

  $ExpectedRoots = @($BeforeRoots)
  if ($EvidenceRoot) {
    if ($null -eq $CommandFailure -and -not (Test-Path -LiteralPath $EvidenceRoot -PathType Container)) {
      throw "$Name did not create its evidence root"
    }
    if (Test-Path -LiteralPath $EvidenceRoot -PathType Container) {
      $EvidenceRootItem = Get-Item -Force -LiteralPath $EvidenceRoot
      if (-not $EvidenceRootItem.PSIsContainer -or $EvidenceRootItem.LinkType) {
        throw "$Name evidence root is not an ordinary directory"
      }
      $ExpectedRootRecord = ConvertTo-TemporaryRootRecord $EvidenceRootItem
      $ExpectedRoots = @($ExpectedRoots + $ExpectedRootRecord |
        Sort-Object -CaseSensitive -Unique)
    }
  }
  Assert-ExactInventorySet "temporary roots after $Name" $ExpectedRoots $AfterRoots
  if ($null -ne $CommandFailure) { throw $CommandFailure }

  if ($AllowRetainedSourceImage) {
    $script:ReleaseGateAfterSource = $AfterSource
    $script:ReleaseGateAfterRestore = $AfterRestore
    $script:ReleaseGateAfterRoots = $AfterRoots
  }
  Assert-ExpectedGitState $ExpectedHead
}
```

The wrapper snapshots all container, network, volume, and visible image IDs on both engines plus every `pale-orbit-*` root immediately around each service-backed command. This includes Compose resources and non-Compose checkpoint helpers without needing unknowable internally generated names. Each command still performs its own exact pre-mutation collision check and refuses foreign state. Current runtime/base images are preloaded, candidate builds use `--pull=false`, candidate transport never pulls, and release Compose sets `pull_policy: never` on every service. This is not an offline-build claim: the Dockerfile syntax frontend is separately bound by the frozen Dockerfile requirement/hash and may be resolved from the engine's BuildKit cache/content store, which the ordinary image inventory cannot attest. Only release success may retain at most one new visible source image.

- [ ] **Step 4: Run every service-backed witness serially**

Create a fresh candidate UUID and a never-before-existing evidence root for each command. The following is the required order:

```powershell
$Plan6bCandidateId = [guid]::NewGuid().ToString().ToLowerInvariant()
$Plan6bEvidenceRoot = Join-Path $TempParent ('pale-orbit-plan6b-' + [guid]::NewGuid().ToString('N'))
$FixtureCandidateId = [guid]::NewGuid().ToString().ToLowerInvariant()
$FixtureEvidenceRoot = Join-Path $TempParent ('pale-orbit-fixture-' + [guid]::NewGuid().ToString('N'))
$ReleaseCandidateId = [guid]::NewGuid().ToString().ToLowerInvariant()
$ReleaseEvidenceRoot = Join-Path $TempParent ('pale-orbit-release-' + [guid]::NewGuid().ToString('N'))
$ExpectedEvidenceRoots = @($Plan6bEvidenceRoot, $FixtureEvidenceRoot, $ReleaseEvidenceRoot)
foreach ($Root in $ExpectedEvidenceRoots) {
  if (Test-Path -LiteralPath $Root) { throw "Evidence root already exists: $Root" }
}

Invoke-IsolatedServiceGate -Name 'verify' -UseSourceContextEnvironment `
  -Command { npm run verify }
Invoke-IsolatedServiceGate -Name 'Plan 6B upgrade' -UseSourceContextEnvironment `
  -Command { npm run test:plan6b-upgrade }
Invoke-IsolatedServiceGate -Name 'Plan 6B maintenance smoke' `
  -EvidenceRoot $Plan6bEvidenceRoot -UseSourceContextEnvironment -Command {
    npm run smoke:plan6b -- --candidate-id $Plan6bCandidateId `
      --evidence-root $Plan6bEvidenceRoot
  }
Invoke-IsolatedServiceGate -Name 'Plan 6B fixture smoke' `
  -EvidenceRoot $FixtureEvidenceRoot -UseSourceContextEnvironment -Command {
    npm run smoke:plan6b-fixture -- --candidate-id $FixtureCandidateId `
      --evidence-root $FixtureEvidenceRoot
  }
```

Run the release candidate separately so its evidence path can be retained and inspected:

```powershell
Invoke-IsolatedServiceGate -Name 'Plan 7A release candidate' `
  -EvidenceRoot $ReleaseEvidenceRoot -AllowRetainedSourceImage -Command {
    npm run smoke:plan7a-release-candidate -- `
      --candidate-id $ReleaseCandidateId `
      --evidence-root $ReleaseEvidenceRoot `
      --origin $ReleaseOrigin `
      --source-context $SourceContext `
      --source-engine-id $SourceEngineId `
      --restore-context $RestoreContext `
      --restore-engine-id $RestoreEngineId `
      --postgres-image $PinnedPostgresImage
  }
```

The candidate production image is the coordinated storage helper; the release grammar has no helper-image argument. Record the exact already-present PostgreSQL RepoDigest in the verification note without changing evidence.

- [ ] **Step 5: Inspect structural evidence and prove post-run state**

Before the no-clobber link, each lifecycle must have strict-parsed canonical bytes and matched every generated field against independently accumulated in-memory callback results; no post-link reread or undefined receipt is part of success. After all CLIs return, independently run the Task 7 strict schema/canonical/fingerprint/nonexpiry inspector with only operator-known arguments:

```powershell
Assert-ExpectedGitState $ExpectedHead
$Now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
node --import tsx scripts/release-control/evidence-inspect.ts `
  --evidence-root $Plan6bEvidenceRoot --candidate-id $Plan6bCandidateId `
  --producer plan6b-production-smoke --profile maintenance_fixture --now $Now `
  --expected-origin https://plan6b-smoke.invalid
if ($LASTEXITCODE -ne 0) { throw 'Plan 6B evidence inspection failed' }
node --import tsx scripts/release-control/evidence-inspect.ts `
  --evidence-root $FixtureEvidenceRoot --candidate-id $FixtureCandidateId `
  --producer plan6b-fixture-runtime-probe --profile maintenance_fixture --now $Now
if ($LASTEXITCODE -ne 0) { throw 'Fixture evidence inspection failed' }
$ReleaseSummaryLines = @(node --import tsx scripts/release-control/evidence-inspect.ts `
  --evidence-root $ReleaseEvidenceRoot --candidate-id $ReleaseCandidateId `
  --producer plan7a-release-candidate --profile release_candidate --now $Now `
  --expected-origin $ReleaseOrigin --emit-safe-summary)
if ($LASTEXITCODE -ne 0 -or $ReleaseSummaryLines.Count -ne 1) {
  throw 'Release evidence inspection failed'
}
$ReleaseReceipt = $ReleaseSummaryLines[0] | ConvertFrom-Json
Assert-ExpectedGitState $ExpectedHead
```

The strict profile parser itself requires workspace mode and no checkpoint for both maintenance records. Require exactly one committed file under each evidence root. The release inspector emits one bounded safe canonical summary from the same stable file snapshot it structurally verified; cross-check only that summary against gate inputs and observed external state. Never reopen or parse raw evidence in this shell:

```powershell
foreach ($Root in $ExpectedEvidenceRoots) {
  $Entries = @(Get-ChildItem -Force -LiteralPath $Root)
  if ($Entries.Count -ne 1 -or $Entries[0].PSIsContainer) {
    throw "Evidence root does not contain exactly one file: $Root"
  }
}
$ExpectedReleaseStages = @(
  'preflight', 'build', 'compose-config', 'migrate', 'provision',
  'checkpoint-capture', 'restore-rehearsal', 'runtime-start', 'runtime-health',
  'inspect', 'behavior', 'shutdown', 'cleanup'
)
if ($ReleaseReceipt.sourceRevision -cne $ExpectedHead -or
    $ReleaseReceipt.sourceMode -cne 'committed_revision' -or
    $ReleaseReceipt.sourceClean -ne $true -or
    $ReleaseReceipt.origin -cne $ReleaseOrigin) { throw 'Release source/origin binding mismatch' }
if ($ReleaseReceipt.checkpoint.captureDockerEngineId -cne $SourceEngineId -or
    $ReleaseReceipt.checkpoint.restoreDockerEngineId -cne $RestoreEngineId) {
  throw 'Release engine binding mismatch'
}
if ($ReleaseReceipt.checkpoint.replacementDisposition -cne 'clear') {
  throw 'Release replacement disposition is not clear'
}
if (Compare-Object $ExpectedReleaseStages @($ReleaseReceipt.requiredStages) `
    -CaseSensitive -SyncWindow 0) {
  throw 'Release required-stage order mismatch'
}
if (Compare-Object $ExpectedReleaseStages @($ReleaseReceipt.stageOutcomes.stage) `
    -CaseSensitive -SyncWindow 0) {
  throw 'Release outcome-stage order mismatch'
}
if (@($ReleaseReceipt.stageOutcomes | Where-Object { $_.result -cne 'succeeded' }).Count -ne 0) {
  throw 'Release contains a nonsuccess outcome'
}
if ($ReleaseReceipt.cleanup.containers -ne 0 -or
    $ReleaseReceipt.cleanup.networks -ne 0 -or
    $ReleaseReceipt.cleanup.volumes -ne 0 -or
    $ReleaseReceipt.cleanup.temporaryRoots -ne 0 -or
    $ReleaseReceipt.checkpoint.rehearsalCleanup.containers -ne 0 -or
    $ReleaseReceipt.checkpoint.rehearsalCleanup.networks -ne 0 -or
    $ReleaseReceipt.checkpoint.rehearsalCleanup.volumes -ne 0 -or
    $ReleaseReceipt.checkpoint.rehearsalCleanup.temporaryRoots -ne 0) {
  throw 'Release cleanup evidence is not zero'
}
$CompletedAt = [DateTimeOffset]::Parse($ReleaseReceipt.completedAt)
$ExpiresAt = [DateTimeOffset]::Parse($ReleaseReceipt.expiresAt)
if (($ExpiresAt - $CompletedAt).TotalMilliseconds -ne 86400000) {
  throw 'Release evidence expiry is not exactly 24 hours'
}
```

The preceding cross-checks use current Git state, CLI inputs, fixed stage constants, and independently observed engine IDs. Cross-record consistency (for example, the build-context label value) is additional defense; it does not replace the lifecycle's independent pre-link expectation match.

Then compare state:

```powershell
$PostInspectionSource = Get-EngineInventory $SourceContext
$PostInspectionRestore = Get-EngineInventory $RestoreContext
$PostInspectionRoots = @(Get-PaleOrbitTemporaryRoots)
foreach ($Kind in @('Containers', 'Networks', 'Volumes', 'Images')) {
  Assert-ExactInventorySet "source $Kind after evidence inspection" `
    $script:ReleaseGateAfterSource.$Kind $PostInspectionSource.$Kind
  Assert-ExactInventorySet "restore $Kind after evidence inspection" `
    $script:ReleaseGateAfterRestore.$Kind $PostInspectionRestore.$Kind
}
Assert-ExactInventorySet 'temporary roots after evidence inspection' `
  $script:ReleaseGateAfterRoots $PostInspectionRoots
if ($script:ReleaseGateAddedSourceImages.Count -eq 1 -and
    $script:ReleaseGateAddedSourceImages[0] -cne $ReleaseReceipt.imageId) {
  throw 'Retained source image does not match the release record'
}

$ReleaseImageJson = docker --context $SourceContext image inspect `
  --format '{{json .}}' $ReleaseReceipt.imageId
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect retained release image' }
$ReleaseImage = $ReleaseImageJson | ConvertFrom-Json
if ($ReleaseImage.Id -cne $ReleaseReceipt.imageId) { throw 'Retained release image ID mismatch' }
if (@($ReleaseImage.RepoTags | Where-Object { $null -ne $_ }).Count -ne 0) {
  throw 'Retained release image unexpectedly has a tag'
}
$ExpectedLabels = [ordered]@{
  'org.opencontainers.image.revision' = $ExpectedHead
  'com.paleorbit.plan7a.source-mode' = 'committed_revision'
  'com.paleorbit.plan7a.source-clean' = 'true'
  'com.paleorbit.plan7a.build-context-sha256' = $ReleaseReceipt.buildContextSha256
}
foreach ($LabelName in $ExpectedLabels.Keys) {
  $ExpectedValue = $ExpectedLabels[$LabelName]
  $EvidenceValue = $ReleaseReceipt.imageLabels.PSObject.Properties[$LabelName].Value
  $ImageValue = $ReleaseImage.Config.Labels.PSObject.Properties[$LabelName].Value
  if ($EvidenceValue -cne $ExpectedValue -or $ImageValue -cne $ExpectedValue) {
    throw "Release image-label mismatch: $LabelName"
  }
}
Assert-LocalImageReference -Context $SourceContext -Reference $PinnedPostgresImage -RequireRepoDigest
Assert-LocalImageReference -Context $RestoreContext -Reference $PinnedPostgresImage -RequireRepoDigest
Assert-EngineIdentity $SourceContext $SourceEngineId
Assert-EngineIdentity $RestoreContext $RestoreEngineId
Assert-ExpectedGitState $ExpectedHead
```

Do not remove the retained release image during this gate. The three evidence roots are expected durable outputs; all other new `pale-orbit-*` roots are prohibited.

- [ ] **Step 6: Record the exact-SHA verification note without changing the commit**

Capture the current `git rev-parse HEAD`, command exit statuses, evidence fingerprint/path, source/restore engine IDs, retained image ID, and baseline comparisons in the implementation handoff. Do not commit generated evidence or local engine identifiers.

### Task 18: Independently review, mark Plan 7A complete, and re-verify the status commit

**Files:**
- Modify: `scripts/release-control-boundaries.test.ts`
- Modify: `docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md`
- Modify: `README.md`
- Modify: `docs/runtime-environments.md`
- Modify: `docs/database-and-workers.md`
- Modify: `docs/storage-ingestion-and-publication.md`
- Modify: `docs/authentication-and-email.md`
- Modify: `docs/commerce-and-guest-claims.md`
- Modify: `docs/customer-library-and-reader.md`
- Modify: `docs/financial-reconciliation-and-reporting.md`
- Modify: `docs/stripe-financial-reconciliation.md`
- Modify: `docs/dependency-decisions.md`

- [ ] **Step 1: Review the exact pre-status implementation SHA**

Load the same exact implementation SHA that passed Task 17, and refuse a moved or dirty checkout before dispatching either review:

```powershell
$ErrorActionPreference = 'Stop'
$ImplementationHead = $env:PLAN7A_EXPECTED_HEAD
if ($ImplementationHead -cnotmatch '^[a-f0-9]{40}$') {
  throw 'PLAN7A_EXPECTED_HEAD must still name the verified implementation SHA'
}
function Assert-Task18ExpectedHead([string] $Expected) {
  $Actual = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $Actual -cne $Expected) {
    throw "HEAD is not the expected Task 18 candidate: $Expected"
  }
}
function Assert-Task18ExpectedHeadAndClean([string] $Expected) {
  Assert-Task18ExpectedHead $Expected
  $Status = @(git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $Status.Count -ne 0) {
    throw 'Task 18 requires an exactly clean tree at this boundary'
  }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'Task 18 working-tree diff check failed' }
}
function Assert-Task18ExactOrdinalSet(
  [string] $Description,
  [string[]] $Expected,
  [string[]] $Actual
) {
  $ExpectedSorted = @($Expected | Sort-Object -CaseSensitive)
  $ActualSorted = @($Actual | Sort-Object -CaseSensitive)
  if ($ExpectedSorted.Count -ne $ActualSorted.Count) {
    throw "$Description count mismatch"
  }
  for ($Index = 0; $Index -lt $ExpectedSorted.Count; $Index += 1) {
    if ($ExpectedSorted[$Index] -cne $ActualSorted[$Index]) {
      throw "$Description mismatch at index $Index"
    }
  }
}
Assert-Task18ExpectedHeadAndClean $ImplementationHead
$ImplementationTreeSpec = $ImplementationHead + '^{tree}'
$ImplementationTree = (git rev-parse --verify $ImplementationTreeSpec).Trim()
if ($LASTEXITCODE -ne 0 -or $ImplementationTree -cnotmatch '^[a-f0-9]{40}$') {
  throw 'Cannot bind the reviewed implementation tree'
}
$env:PLAN7A_PRE_STATUS_HEAD = $ImplementationHead
```

The `$env:PLAN7A_PRE_STATUS_HEAD` assignment is process-local convenience, not persistence. Record the literal `$ImplementationHead` in the review/verification handoff; before any fresh Step 2 process, the launcher must set `PLAN7A_PRE_STATUS_HEAD` from that exact note.

Run two fresh read-only reviews against `$ImplementationHead`:

1. a spec-compliance reviewer checks every Checkpoint D requirement, non-goal, stage, evidence field, failure boundary, cleanup rule, consumer behavior, checkpoint/rehearsal identity, activation closure, and final gate result;
2. a code-quality reviewer checks duplication, parser strictness, TOCTOU/path/symlink/ownership safety, async termination, cleanup correctness, privacy, test hermeticity, and maintainability.

Across the two reviews, explicitly cover the complete Section 15.4 list: scope containment, dependency direction, structured-log privacy, job-policy completeness, database authority, lock ordering, command replay, worker-health semantics, Docker ownership, cleanup, evidence binding, restore coverage, and continued production closure. A Checkpoint D-focused review does not waive the unchanged Plan 7A authorities.

Give both reviewers the Plan 7A design, this plan, base SHA, implementation SHA, and verification note. Both reports and the verification note must state `$ImplementationHead` literally. They must not edit files or start service-backed commands. Fix every confirmed finding with TDD and its own literal-path commit, rerun Tasks 15 and 17 on the new SHA, then repeat both reviews until both explicitly report no blocking finding.

- [ ] **Step 2: Add a status RED, then change only the final status after evidence and reviews are green**

First change `scripts/release-control-boundaries.test.ts` to require the exact completed status and continuing closure statements. Before running it, prove that this is the only checkout mutation and that `HEAD` is still `$ImplementationHead`; then run it before changing docs. Steps 2 and 3 are one transaction in the same fresh persistent PowerShell 7 process. Its launching environment must populate `PLAN7A_PRE_STATUS_HEAD` from the literal review/verification note; Step 1's in-process assignment is not a cross-session handoff. The following prefix deliberately reloads every helper and immutable commit/tree binding needed after the RED edit:

```powershell
$ErrorActionPreference = 'Stop'
$ImplementationHead = $env:PLAN7A_PRE_STATUS_HEAD
if ($ImplementationHead -cnotmatch '^[a-f0-9]{40}$') {
  throw 'Reload PLAN7A_PRE_STATUS_HEAD from the exact review/verification note'
}
function Assert-Task18ExpectedHead([string] $Expected) {
  $Actual = (git rev-parse --verify 'HEAD^{commit}').Trim()
  if ($LASTEXITCODE -ne 0 -or $Actual -cne $Expected) {
    throw "HEAD is not the expected Task 18 candidate: $Expected"
  }
}
function Assert-Task18ExpectedHeadAndClean([string] $Expected) {
  Assert-Task18ExpectedHead $Expected
  $Status = @(git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $Status.Count -ne 0) {
    throw 'Task 18 requires an exactly clean tree at this boundary'
  }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'Task 18 working-tree diff check failed' }
}
function Assert-Task18ExactOrdinalSet(
  [string] $Description,
  [string[]] $Expected,
  [string[]] $Actual
) {
  $ExpectedSorted = @($Expected | Sort-Object -CaseSensitive)
  $ActualSorted = @($Actual | Sort-Object -CaseSensitive)
  if ($ExpectedSorted.Count -ne $ActualSorted.Count) {
    throw "$Description count mismatch"
  }
  for ($Index = 0; $Index -lt $ExpectedSorted.Count; $Index += 1) {
    if ($ExpectedSorted[$Index] -cne $ActualSorted[$Index]) {
      throw "$Description mismatch at index $Index"
    }
  }
}
$ImplementationTreeSpec = $ImplementationHead + '^{tree}'
$ImplementationTree = (git rev-parse --verify $ImplementationTreeSpec).Trim()
if ($LASTEXITCODE -ne 0 -or $ImplementationTree -cnotmatch '^[a-f0-9]{40}$') {
  throw 'Cannot reload the reviewed implementation tree'
}
Assert-Task18ExpectedHead $ImplementationHead
$StatusRedTree = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect status RED tree' }
Assert-Task18ExactOrdinalSet 'status RED checkout rows' `
  @(' M scripts/release-control-boundaries.test.ts') $StatusRedTree
$StatusRedOutput = @(npx vitest run `
  scripts/release-control-boundaries.test.ts --reporter=verbose 2>&1)
$StatusRedExit = $LASTEXITCODE
$StatusRedText = $StatusRedOutput -join "`n"
if ($StatusRedExit -ne 1 -or
    $StatusRedText -cnotmatch 'requires exact Checkpoints A-D complete status' -or
    $StatusRedText -match 'SyntaxError|Failed to load|No test files found') {
  throw 'Status RED was not the intended exact source-shape assertion failure'
}
```

Expected: FAIL only because the implementation status and current-document completion statements have not changed yet.

Update the design's status line to exactly:

```md
**Implementation status:** Checkpoints A-D complete
```

In each of the ten Task 16 current documents, change only its Plan 7A status/deferred-Checkpoint-D text and add this exact shared closure sentence once near the status paragraph:

```md
Plan 7A is complete. Production remains maintenance-only and Stripe-disabled; `live` activation always rejects, and monitoring/alerts, scheduled off-host backup, registry/signing/deployment, hardening, activation, and launch remain later plans.
```

Preserve every per-file command/domain statement from Task 16. In the Plan 7A design, change only the exact implementation-status line shown above and any same-paragraph “Checkpoint D pending” wording that would directly contradict it; do not rewrite requirements/history. The static test enumerates all eleven docs, requires the exact design status and one exact closure sentence in each current doc, and rejects any lingering `Checkpoint D deferred|Checkpoint D remains|Plan 7A remains incomplete` phrase in those current docs.

Add/adjust a static test that requires the exact status and those caveats before committing.

- [ ] **Step 3: Commit only status/doc assertions**

```powershell
$StatusFiles = @'
README.md
docs/authentication-and-email.md
docs/commerce-and-guest-claims.md
docs/customer-library-and-reader.md
docs/database-and-workers.md
docs/dependency-decisions.md
docs/financial-reconciliation-and-reporting.md
docs/runtime-environments.md
docs/storage-ingestion-and-publication.md
docs/stripe-financial-reconciliation.md
docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md
scripts/release-control-boundaries.test.ts
'@ -split "`n" | ForEach-Object Trim | Where-Object { $_ }
if ($StatusFiles.Count -ne 12) { throw 'Expected exactly twelve status files' }
Assert-Task18ExpectedHead $ImplementationHead
$ExpectedUnstagedStatus = @($StatusFiles | ForEach-Object { " M $_" })
$UnstagedStatus = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect unstaged status files' }
Assert-Task18ExactOrdinalSet 'unstaged status rows' `
  $ExpectedUnstagedStatus $UnstagedStatus
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'Status working-tree diff check failed' }
npx vitest run scripts/release-control-boundaries.test.ts --reporter=verbose
if ($LASTEXITCODE -ne 0) { throw 'Status boundary GREEN failed' }
git --literal-pathspecs add -- `
  docs/superpowers/specs/2026-08-24-production-operability-foundations-design.md `
  README.md `
  docs/runtime-environments.md `
  docs/database-and-workers.md `
  docs/storage-ingestion-and-publication.md `
  docs/authentication-and-email.md `
  docs/commerce-and-guest-claims.md `
  docs/customer-library-and-reader.md `
  docs/financial-reconciliation-and-reporting.md `
  docs/stripe-financial-reconciliation.md `
  docs/dependency-decisions.md `
  scripts/release-control-boundaries.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Could not stage exact status files' }
$ExpectedStagedStatus = @($StatusFiles | ForEach-Object { "M  $_" })
$StagedStatus = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect staged status files' }
Assert-Task18ExactOrdinalSet 'staged status rows' `
  $ExpectedStagedStatus $StagedStatus
$ExpectedCachedNameStatus = @($StatusFiles | ForEach-Object { "M`t$_" })
$CachedNameStatus = @(git diff --cached --name-status --no-renames)
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate cached status files' }
Assert-Task18ExactOrdinalSet 'cached status rows' `
  $ExpectedCachedNameStatus $CachedNameStatus
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Status staged diff check failed' }
git diff --cached
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect staged status diff' }
$HeadBeforeStatusCommit = (git rev-parse --verify 'HEAD^{commit}').Trim()
if ($LASTEXITCODE -ne 0 -or $HeadBeforeStatusCommit -cne $ImplementationHead) {
  throw 'Pre-status implementation HEAD drifted'
}
$ExpectedStatusTree = (git write-tree).Trim()
if ($LASTEXITCODE -ne 0 -or $ExpectedStatusTree -cnotmatch '^[a-f0-9]{40}$') {
  throw 'Cannot bind the exact staged status tree'
}
git commit -m "docs: record Plan 7A completion"
if ($LASTEXITCODE -ne 0) { throw 'Status commit failed' }
$StatusHead = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $StatusHead -cnotmatch '^[a-f0-9]{40}$') {
  throw 'Cannot resolve exact status SHA'
}
$StatusCommitLine = (git rev-list --parents -n 1 $StatusHead).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect status commit parents' }
$StatusCommitParts = @($StatusCommitLine -split ' ')
if ($StatusCommitParts.Count -ne 2 -or
    $StatusCommitParts[0] -cne $StatusHead -or
    $StatusCommitParts[1] -cne $ImplementationHead) {
  throw 'Status commit is not a single-parent child of the reviewed implementation'
}
$StatusTreeSpec = $StatusHead + '^{tree}'
$ActualStatusTree = (git rev-parse --verify $StatusTreeSpec).Trim()
if ($LASTEXITCODE -ne 0 -or $ActualStatusTree -cne $ExpectedStatusTree) {
  throw 'Status commit tree differs from the exact staged tree'
}
$StatusParentTreeSpec = $StatusHead + '^1^{tree}'
$ActualStatusParentTree = (git rev-parse --verify $StatusParentTreeSpec).Trim()
if ($LASTEXITCODE -ne 0 -or $ActualStatusParentTree -cne $ImplementationTree) {
  throw 'Status commit parent tree differs from the reviewed implementation tree'
}
$StatusCommitRows = @(git diff-tree --no-commit-id --name-status -r `
  --no-renames $StatusHead)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect exact status commit tree' }
Assert-Task18ExactOrdinalSet 'status commit rows' `
  $ExpectedCachedNameStatus $StatusCommitRows
Assert-Task18ExpectedHeadAndClean $StatusHead
$env:PLAN7A_STATUS_COMMIT = $StatusHead
$env:PLAN7A_EXPECTED_HEAD = $StatusHead
```

Record the literal `$StatusHead` in the verification handoff immediately. Both `$env:` assignments are process-local conveniences; the launcher of every fresh Step 4 candidate-verification process must set `PLAN7A_STATUS_COMMIT` from that recorded value.

- [ ] **Step 4: Treat the status commit as a new release candidate**

Because the SHA changed, discard the prior candidate evidence as a completion witness. A successful Task 17 gate intentionally retains at most one introduced source image, so clean an obsolete successful candidate only as a separate operator step between immutable-SHA gates—not inside either successful gate. If the verification note says the previous run introduced an image, load its exact ID, source SHA, source context, and observed source engine ID into `PLAN7A_OBSOLETE_SOURCE_IMAGE_ID`, `PLAN7A_OBSOLETE_SOURCE_REVISION`, `PLAN7A_OBSOLETE_SOURCE_CONTEXT`, and `PLAN7A_OBSOLETE_SOURCE_ENGINE_ID`, then run this self-contained block in any fresh PowerShell session:

```powershell
$ErrorActionPreference = 'Stop'
$ObsoleteImageId = $env:PLAN7A_OBSOLETE_SOURCE_IMAGE_ID
$ObsoleteRevision = $env:PLAN7A_OBSOLETE_SOURCE_REVISION
$ObsoleteSourceContext = $env:PLAN7A_OBSOLETE_SOURCE_CONTEXT
$ObsoleteSourceEngineId = $env:PLAN7A_OBSOLETE_SOURCE_ENGINE_ID
$ContextPattern = '^[A-Za-z0-9_.-]{1,128}$'
$EngineIdPattern = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
if ($ObsoleteImageId -cnotmatch '^sha256:[a-f0-9]{64}$' -or
    $ObsoleteRevision -cnotmatch '^[a-f0-9]{40}$' -or
    $ObsoleteSourceContext -cnotmatch $ContextPattern -or
    $ObsoleteSourceEngineId -cnotmatch $EngineIdPattern) {
  throw 'Exact obsolete candidate identity is required'
}

function Assert-ObsoleteEngineIdentity {
  $ActualLines = @(docker --context $ObsoleteSourceContext info --format '{{.ID}}')
  if ($LASTEXITCODE -ne 0 -or $ActualLines.Count -ne 1 -or
      ([string]$ActualLines[0]) -cne $ObsoleteSourceEngineId) {
    throw 'Obsolete-candidate Docker engine identity drifted'
  }
}

Assert-ObsoleteEngineIdentity
$ObsoleteJson = docker --context $ObsoleteSourceContext image inspect `
  --format '{{json .}}' $ObsoleteImageId
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect obsolete candidate' }
$ObsoleteImage = $ObsoleteJson | ConvertFrom-Json
$ObsoleteLabels = $ObsoleteImage.Config.Labels
if ($ObsoleteImage.Id -cne $ObsoleteImageId -or
    @($ObsoleteImage.RepoTags | Where-Object { $null -ne $_ }).Count -ne 0 -or
    $ObsoleteLabels.'org.opencontainers.image.revision' -cne $ObsoleteRevision -or
    $ObsoleteLabels.'com.paleorbit.plan7a.source-mode' -cne 'committed_revision' -or
    $ObsoleteLabels.'com.paleorbit.plan7a.source-clean' -cne 'true' -or
    $ObsoleteLabels.'com.paleorbit.plan7a.build-context-sha256' `
      -cnotmatch '^[a-f0-9]{64}$') {
  throw 'Refusing to remove an unauthenticated obsolete candidate'
}
$ObsoleteUsers = @(docker --context $ObsoleteSourceContext ps -aq `
  --filter "ancestor=$ObsoleteImageId")
if ($LASTEXITCODE -ne 0 -or $ObsoleteUsers.Count -ne 0) {
  throw 'Obsolete candidate still has a container consumer'
}
docker --context $ObsoleteSourceContext image rm $ObsoleteImageId
if ($LASTEXITCODE -ne 0) { throw 'Could not remove obsolete candidate' }
$RemainingImages = @(docker --context $ObsoleteSourceContext image ls `
  --all --no-trunc --quiet | ForEach-Object Trim | Where-Object { $_ } |
  Sort-Object -CaseSensitive -Unique)
if ($LASTEXITCODE -ne 0 -or $RemainingImages -ccontains $ObsoleteImageId) {
  throw 'Obsolete candidate removal was not proved'
}
Assert-ObsoleteEngineIdentity
```

If the prior candidate was baseline/pre-existing rather than introduced, do not remove it. Apply this same recorded-ID/label policy before every Task 17 rerun caused by a review fix. Treat the status commit as a new candidate explicitly, then repeat the complete Tasks 15 and 17 matrix with fresh IDs/roots:

```powershell
$ErrorActionPreference = 'Stop'
$StatusHead = $env:PLAN7A_STATUS_COMMIT
if ($StatusHead -cnotmatch '^[a-f0-9]{40}$') {
  throw 'Reload PLAN7A_STATUS_COMMIT from the proved status commit'
}
function Assert-Task18CandidateHeadAndClean([string] $Expected) {
  if ($Expected -cnotmatch '^[a-f0-9]{40}$') {
    throw 'An exact candidate SHA is required'
  }
  $ActualLines = @(git rev-parse --verify 'HEAD^{commit}')
  if ($LASTEXITCODE -ne 0 -or $ActualLines.Count -ne 1) {
    throw 'Cannot resolve the candidate HEAD'
  }
  $Actual = ([string]$ActualLines[0]).Trim()
  if ($Actual -cne $Expected) {
    throw "HEAD is not the expected Task 18 candidate: $Expected"
  }
  $Status = @(git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $Status.Count -ne 0) {
    throw 'Task 18 requires an exactly clean tree'
  }
  git diff --check
  if ($LASTEXITCODE -ne 0) {
    throw 'Task 18 working-tree diff check failed'
  }
}
$ExpectedCandidateHead = $StatusHead
$env:PLAN7A_EXPECTED_HEAD = $ExpectedCandidateHead
Assert-Task18CandidateHeadAndClean $ExpectedCandidateHead
# In this same persistent process, run Task 15, then assert again.
Assert-Task18CandidateHeadAndClean $ExpectedCandidateHead
# Still in this process, run every Task 17 fence from Step 1 through Step 6.
# Its own checks compare sourceRevision and all four image labels with
# PLAN7A_EXPECTED_HEAD at every relevant boundary and create $ReleaseReceipt.
Assert-Task18CandidateHeadAndClean $ExpectedCandidateHead
if ($ReleaseReceipt.sourceRevision -cne $ExpectedCandidateHead) {
  throw 'Fresh release evidence is not bound to the status candidate SHA'
}
```

The candidate transition, Task 15, every Task 17 fence, and the `$ReleaseReceipt` assertion above are one persistent PowerShell transaction. `$ReleaseReceipt` must be regenerated by that exact Task 17 run; never load or inherit it from an earlier process.

Inspect the new evidence and repeat the two independent read-only reviews against `$ExpectedCandidateHead`. If a confirmed review finding requires a commit, the old evidence is immediately invalid. After that narrow commit, bind the exact clean descendant and use this transition before any rerun:

```powershell
$ErrorActionPreference = 'Stop'
$StatusHead = $env:PLAN7A_STATUS_COMMIT
if ($StatusHead -cnotmatch '^[a-f0-9]{40}$') {
  throw 'Reload PLAN7A_STATUS_COMMIT from the proved status commit'
}
function Assert-Task18CandidateHeadAndClean([string] $Expected) {
  if ($Expected -cnotmatch '^[a-f0-9]{40}$') {
    throw 'An exact candidate SHA is required'
  }
  $ActualLines = @(git rev-parse --verify 'HEAD^{commit}')
  if ($LASTEXITCODE -ne 0 -or $ActualLines.Count -ne 1) {
    throw 'Cannot resolve the candidate HEAD'
  }
  $Actual = ([string]$ActualLines[0]).Trim()
  if ($Actual -cne $Expected) {
    throw "HEAD is not the expected Task 18 candidate: $Expected"
  }
  $Status = @(git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $Status.Count -ne 0) {
    throw 'Task 18 requires an exactly clean tree'
  }
  git diff --check
  if ($LASTEXITCODE -ne 0) {
    throw 'Task 18 working-tree diff check failed'
  }
}
$ExpectedCandidateHead = (git rev-parse --verify 'HEAD^{commit}').Trim()
if ($LASTEXITCODE -ne 0 -or
    $ExpectedCandidateHead -cnotmatch '^[a-f0-9]{40}$' -or
    $ExpectedCandidateHead -ceq $StatusHead) {
  throw 'Cannot bind the exact new review-fix candidate SHA'
}
git merge-base --is-ancestor $StatusHead $ExpectedCandidateHead
if ($LASTEXITCODE -ne 0) { throw 'Review-fix candidate does not descend from status commit' }
Assert-Task18CandidateHeadAndClean $ExpectedCandidateHead
$env:PLAN7A_EXPECTED_HEAD = $ExpectedCandidateHead
# In this same persistent process, discard all prior evidence, use fresh
# IDs/roots, run Task 15, and run every Task 17 fence through Step 6.
Assert-Task18CandidateHeadAndClean $ExpectedCandidateHead
if ($ReleaseReceipt.sourceRevision -cne $ExpectedCandidateHead) {
  throw 'Review-fix evidence is not bound to the new candidate SHA'
}
```

Any fix restarts this step in one fresh persistent candidate-verification process and uses the same separate obsolete-image cleanup rule. Never present `$StatusHead` as the final verified SHA after a later review-fix commit. Only after the complete gate and both reviews report no blocker, set `$FinalVerifiedHead = $ExpectedCandidateHead`, record that literal value externally, and use that name in the handoff.

- [ ] **Step 5: Finish the branch only after final proof**

Use `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. In any fresh finishing session, reload `FinalVerifiedHead` from the literal handoff rather than relying on an old PowerShell variable. Confirm the branch is clean, `HEAD` equals `$FinalVerifiedHead`, and the approved base remains an ancestor. Present that verified exact SHA, evidence fingerprint/path, retained source image ID, two distinct engine IDs, test/service results, and both no-blocker reviews. Merge or push only according to the user's current integration instruction.

## Expected planning and implementation commit sequence

0. `docs: plan Plan 7A Checkpoint D implementation` (Task 0, approval-gated planning integration)
1. `fix: make source-shape witnesses checkout-neutral`
2. `feat: define deterministic smoke evidence contracts`
3. `feat: freeze exact smoke build inputs`
4. `feat: bind immutable smoke configuration`
5. `feat: authenticate smoke database state`
6. `feat: supervise bounded smoke commands`
7. `feat: enforce platform-private smoke paths`
8. `feat: extract owned Compose lifecycle`
9. `feat: own exact local candidate images`
10. `feat: orchestrate fixed smoke stages and evidence`
11. `refactor: adopt shared production maintenance smoke`
12. `refactor: adopt shared fixture maintenance smoke`
13. `feat: authenticate checkpoint candidate evidence`
14. `refactor: expose owned checkpoint attestations`
15. `feat: bind local release images to rehearsal`
16. `feat: coordinate Plan 7A release candidates`
17. `feat: reserve production activation contract`
18. `test: prove release control failure boundaries`
19. `docs: document Plan 7A release control`
20. verification only; no commit
21. `docs: record Plan 7A completion`, followed by a fresh full gate and review

If a review fix is needed, add a narrowly named commit where discovered; do not squash away the review trail before the exact-SHA gate.

## Acceptance checklist

- [ ] Base `6406c02cf463f1f0a389488e587ac688078d2cf8` and design `1c330693b67a1aa34c413bd8d2ec23ff8628236e` remain ancestors.
- [ ] All new behavior was test-first and every task passed fresh spec and quality review.
- [ ] Both maintenance consumers independently build and run the fixed 11-stage profile and preserve all prior assertions.
- [ ] Only the release coordinator runs the fixed 13-stage profile with checkpoint capture and distinct-engine restore rehearsal.
- [ ] A clean committed snapshot alone can produce release evidence; workspace maintenance evidence records actual cleanliness.
- [ ] Docker receives a byte-deterministic ustar context with logical POSIX modes on every host; it never infers release build modes from NTFS metadata.
- [ ] Build context, four image labels, raw local `imageId`, canonical origin, Compose configuration, migration tip, role/catalog result, and backup identity are cryptographically bound.
- [ ] Release Compose uses the exact locally present digest-pinned PostgreSQL reference with pulling disabled, and that same reference is bound through checkpoint capture/rehearsal.
- [ ] No field, variable, event, document, or code path calls the local image identity `imageDigest`.
- [ ] Evidence is strict, privacy-minimized, expectation-matched, non-clobbering, issued only after cleanup, and expires exactly after 24 hours.
- [ ] The source release image is deliberately retained by exact ID; maintenance/restore images are removed only when introduced and owned.
- [ ] Capture and restore use two observed, explicit, distinct Docker engine IDs and the same revalidated local candidate image.
- [ ] Checkpoint bundle v2 and all 14 artifacts remain exact; restore keeps ACLs and the canonical 323-descriptor verifier contract.
- [ ] Every timeout, signal, stage failure, partial mutation, cleanup failure, evidence collision, and mismatch fails closed without success evidence or foreign-state deletion.
- [ ] Every failed run attempts exactly one schema-valid terminal `smoke.run.failed` after its authoritative cleanup event.
- [ ] Unit/watch tests remain hermetic; all external gates are explicit and serialized.
- [ ] `live` is reserved but unconditionally rejected, and activation contracts contain no evaluator or authorized result.
- [ ] Compose, Stripe flags, routes, database schema/migrations, package dependencies/lockfile, provider behavior, and deployment surface remain unchanged.
- [ ] The exact final SHA passes focused tests, check, lint, unit, database check, build, verify, upgrade, both maintenance smokes, checkpoint/rehearsal release smoke, state-baseline comparisons, strict evidence consumption, and two independent reviews.
- [ ] Plan 7A status changes only after the bound pre-status implementation SHA passes its gate and reviews; afterward, the latest exact descendant SHA containing the proved status commit passes the complete gate and both no-blocker reviews.

## Execution handoff

This plan is ready for **subagent-driven execution in the current session**, one editing task at a time, with fresh spec-compliance and code-quality agents after each implementation task. Use separate agents for independent read-only audits that do not touch shared service state; keep all Docker/PostgreSQL/build/upgrade/smoke commands serialized under the primary agent. Do not begin implementation merely because this plan exists: begin only after the user approves this reviewed plan.
