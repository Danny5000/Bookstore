# Dependency decisions

Checked against the npm registry on 2026-08-13.

| Package | Selected line | Decision |
| --- | --- | --- |
| Node.js | 26.7.x | Local tooling and the future production image use the same Node 26 runtime line. |
| TypeScript | 6.0.x | TypeScript 7 is deferred until stable svelte-check and typescript-eslint releases both publish compatible peer ranges. |
| @types/node | 26.x | Matches the selected Node 26 runtime; the registry currently publishes 26.2.0 for TypeScript 6. |
| SvelteKit / Svelte | 2.70.2 / 5.56.8 | Keep both on their mutually supported stable releases. Svelte 5.56.9 is a compatible patch, but it is deferred to a dependency-maintenance change with the full compiler/runtime regression gate rather than mixed into Plan 6B-I's financial boundary. |
| svelte-check | 4.7.5 | Version 4.7.6 is deferred with the Svelte patch so the type/compiler toolchain is updated and verified together. |
| Vite / Svelte Vite plugin | 8.2.1 / 7.3.0 | Upgrade together because their peer ranges are coupled. |
| adapter-node | 5.5.7 | Replaces adapter-auto for the Docker/Node deployment target. |
| npm | 11.19.x | Matches the npm release bundled in the exact Node 26.7.0 development and production image; reconsider npm 12 when the selected Node image ships it. |
| Playwright | 1.62.x | Current stable browser-test runner; Chromium is the initial cross-browser contract and more projects can be added when browser-specific defects justify them. |
| Zod | 4.4.x | Current stable runtime schema validator; restricted to trusted configuration and later request-boundary schemas. |
| PostgreSQL image | 18.4 Alpine | Exact production/development database tag; mount `/var/lib/postgresql` for the PostgreSQL 18 image layout. |
| Mailpit image | 1.30.0 | Exact development-only SMTP capture service. |
| Caddy image | 2.11.4 Alpine | Exact production reverse-proxy baseline. |
| Stripe SDK | 22.5.0 | Current stable provider adapter dependency for Plan 6A. Application calls pin API version `2026-07-29.dahlia`; Stripe remains disabled unless validated configuration explicitly enables it. |
| Drizzle ORM | 0.45.2 | Current stable typed PostgreSQL ORM; schema files are the source of truth and runtime code uses the node-postgres adapter. |
| Drizzle Kit | 0.31.10 | Current stable development-only migration generator/checker; generated SQL and snapshots are committed. |
| node-postgres (`pg`) | 8.23.0 | Current stable pooled PostgreSQL driver supported by Drizzle; web, worker, and migration processes own separate bounded pools. |
| `@types/pg` | 8.21.0 | Current node-postgres type declarations required by the strict TypeScript build. |
| tsx | 4.23.12 | Current stable development-only TypeScript runner for worker, migration, and test orchestration entry points. Updated from 4.23.11 as a compatible patch. |
| Better Auth | 1.6.26 exact | Authentication runtime pinned with its matching CLI. [Version 1.6.28](https://github.com/better-auth/better-auth/releases/tag/v1.6.28) prevents duplicate session requests during React Suspense retries and restores client-plugin declaration compatibility; adopt it only in a dedicated auth maintenance change that upgrades the runtime and CLI together and runs the schema and adversarial auth gates described below. |
| Better Auth CLI | 1.6.26 exact, on demand | Schema generation must match the runtime exactly; keep it outside the installed tree until its unfixed tool-only advisory is removed. |
| Nodemailer | 9.0.5 | Current stable SMTP implementation behind the provider-neutral email adapter. |
| `@types/nodemailer` | 8.0.1 | Current published declarations; remove when Nodemailer ships compatible declarations directly. |
| `@fastify/busboy` | 3.2.1 exact | Security-patched streaming multipart parser. The application also applies explicit part-count and byte limits without buffering publication uploads. |
| yauzl | 3.4.0 | Current stable lazy, random-access ZIP reader; ingestion validates archive metadata and observed streams before accepting entries. |
| `@types/yauzl` | 3.4.0 | Current published strict TypeScript declarations for yauzl. |
| sharp | 0.35.3 | Current stable image decoder/normalizer; its platform-specific optional packages must survive production dependency pruning. |
| `file-type` | 22.0.1 | Current stable signature detector used only as a format hint; successful decoding and domain validation remain authoritative. |
| `fast-xml-parser` | 5.10.1 | Current stable bounded XML parser; ingestion rejects document types and entities before parsing untrusted EPUB or ComicInfo metadata. |
| fflate | 0.8.3 | Current stable test-only archive writer used to generate deterministic valid and hostile fixtures; it is not part of production ingestion. |
| eslint-plugin-svelte | 3.22.0 | Version 3.23.0 is deferred to the next dependency-maintenance gate so Plan 6B-I does not mix financial work with lint-rule drift; remove the defer after lint and the full release gate pass on the updated plugin. |
| globals | 17.9.0 | Direct lint-data dependency. Version 17.11.0 is deferred to the next dependency-maintenance gate so Plan 6B-I's financial boundary does not mix in unrelated lint-environment data drift; remove the defer after lint and the full release gate pass with the revised data. |

TypeScript 6.0.3 remains intentional while the registry latest is 7.0.2: as checked on 2026-08-13,
`typescript-eslint` 8.67.0 accepts TypeScript `>=4.8.4 <6.1.0` and
`svelte-check` 4.7.5 accepts TypeScript 5 or 6. Remove this pin when both stable
packages support TypeScript 7.

Run `npm outdated`, `npm audit`, `npm ls`, and `npm run verify` before completing each implementation plan.
Any remaining direct-package lag requires a dated compatibility reason and a removal condition in this file.

Plan 6A adds no S3 client, Redis client, queue service, tax library, or payment-form dependency. It uses the existing Stripe SDK only behind a narrow adapter; PostgreSQL remains authoritative for orders, events, grants, jobs, outbox messages, and audit data.

The Better Auth schema generator is invoked as exact `auth@1.6.26` by the
`auth:schema` and `auth:info` scripts instead of being committed to the application
dependency tree. An isolated 2026-08-13 audit of that CLI graph reported one high
and five moderate dependency paths. Its Prisma parser resolves Lodash 4.17.21,
which remains affected by the high-severity
[GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc);
the advisory covers Lodash through 4.17.23 and is fixed in 4.18.0, which the CLI
does not yet resolve. Schema generation is a manual/CI tool run only against this
trusted repository, never a production runtime or network service. Keep the
version exact, do not run it against untrusted config, and restore it as a locked
development dependency when its dependency graph no longer contains the advisory.

The 2026-08-13 primary-source review found that `@fastify/busboy` 3.2.0 was
affected by two HIGH-severity advisories published on 2026-08-12: an unauthenticated
CPU denial of service from an exactly 252-byte multipart boundary
([GHSA-xjh9-v7x6-24jw](https://github.com/fastify/busboy/security/advisories/GHSA-xjh9-v7x6-24jw))
and a denial of service from a prototype-named multipart part header
([GHSA-x8mw-p69m-v3mx](https://github.com/fastify/busboy/security/advisories/GHSA-x8mw-p69m-v3mx)).
Both advisories identify 3.2.1 as patched, and the upstream
[3.2.1 security release](https://github.com/fastify/busboy/releases/tag/v3.2.1)
directs users to upgrade. At discovery time both repository audit modes still
reported zero high or critical findings because the npm audit feed had not yet
surfaced these new advisories. The manifest and lockfile are now pinned to exact
3.2.1. The upload boundary rejects RFC-oversized boundary parameters before body
consumption, the test suite verifies the manifest/lock/runtime version together,
and isolated subprocess regressions cover the patched 256-byte boundary-search path
and prototype-named part headers. A clean
audit feed is not treated as a substitute for reviewing primary security releases.

## Accepted audit findings

`npm audit` currently reports the `cookie` advisory as three low-severity production dependency paths and four low-severity full-tree paths through SvelteKit, adapter-node, and Better Auth. The application and authentication library use fixed, trusted cookie configuration; request data cannot choose cookie names, paths, or domains, so the affected validation behavior is not exposed by current application code. There is no compatible stable SvelteKit upgrade that removes the finding; npm's suggested forced resolution is an invalid downgrade. Remove this exception when a stable SvelteKit release depends on `cookie` 0.7.0 or newer.

Drizzle Kit 0.31.10 also reports four moderate dependency-path findings through its deprecated `@esbuild-kit/esm-loader` dependency and esbuild 0.18.20. npm retains Drizzle Kit in the pruned dependency tree to satisfy Better Auth's optional peer, so these paths also appear in `npm audit --omit=dev`; the application nevertheless invokes Drizzle Kit only as a local/CI migration generator and checker and never imports or exposes its development server in a production process. The advisory concerns an exposed esbuild development server. Drizzle Kit 0.31.10 is the current stable release, while npm's suggested `0.18.1` resolution is an incompatible downgrade. Do not expose Drizzle Kit's development server to untrusted networks. Remove this exception when a stable Drizzle Kit release removes the deprecated loader path or upgrades its affected esbuild dependency.

The 2026-08-10 Plan 6A preflight used `npm outdated --json`, `npm view`, both audit modes, and `npm ls --depth=0`. It found no high or critical advisory, confirmed Stripe 22.5.0 and tsx 4.23.12 as current, and reconfirmed `typescript-eslint@8.67.0` requires TypeScript `<6.1.0`.

The 2026-08-11 Plan 6B-I preflight ran on Node 26.7.0 with npm 11.19.0. Stripe 22.5.0 remained current and supported Node 18 or newer; TypeScript 7.0.2 remained incompatible with the selected `typescript-eslint@8.67.0` peer range of `>=4.8.4 <6.1.0`. At that dated snapshot, `npm outdated --json` reported only Better Auth 1.6.27, `globals` 17.10.0, and the intentional TypeScript 7 line. Better Auth 1.6.27 changes endpoint-context typing and session response-header behavior, deduplicates in-flight React session requests, and changes the CLI to align installed packages with its running version. It was therefore deferred until a dedicated maintenance change updates the runtime and exact CLI together, regenerates and compares the auth schema, and reruns the full stale-bearer, credential-authority, reset-race, sign-in, and browser gates. The `globals` update remains deferred until a dependency-maintenance change passes lint and the full release gate with the revised environment data.

At that 2026-08-11 preflight, both audit modes remained free of high and critical findings. The production-tree audit reported three low and four moderate paths; the full-tree audit reported four low and four moderate paths. All were the already accepted `cookie` and Drizzle Kit/esbuild findings above. `npm ls --depth=0` completed without missing or invalid direct dependencies. No Plan 6B runtime dependency was added.

The 2026-08-13 Plan 6B-I candidate-gate rerun used the same Node 26.7.0 and npm 11.19.0 lines after pinning `@fastify/busboy` 3.2.1. `npm outdated --json` reported Better Auth 1.6.28, `eslint-plugin-svelte` 3.23.0, `globals` 17.11.0, Svelte 5.56.9, `svelte-check` 4.7.6, and the intentionally blocked TypeScript 7.0.2 line; the dated removal conditions for each defer are recorded above. Better Auth 1.6.28 was published during this gate, and its primary release notes describe React Suspense session-request and downstream client-plugin declaration fixes; the same dedicated runtime-plus-CLI auth gate remains the removal condition. The post-remediation production-tree audit reported three low and four moderate paths, while the full-tree audit reported four low and four moderate paths, with zero high or critical findings in either npm feed. These are only the accepted `cookie` and Drizzle Kit/esbuild paths above. `npm ls --depth=0` completed without missing or invalid direct dependencies and confirmed `@fastify/busboy@3.2.1` in the installed direct-dependency tree.

Stripe 22.5.0 emits one fixed, nonsecret plugin-hint line on SDK import when either `CLAUDECODE` or `CLAUDE_CODE_CHILD_SESSION` is nonempty. The installed SDK exposes no suppression setting. Production Compose explicitly enumerates container environment and forwards neither variable, so production app/worker logs are unaffected. A host-run development process launched inside Claude may emit the marker; unset both detection variables before process start when clean local stderr is required. Do not patch the installed package or pin an older SDK solely to suppress this development-only hint.

The 2026-08-10 Plan 6A final release gate passed database drift checks, type and Svelte checks, lint, production web and service builds, 955 unit tests across 139 files, 285 PostgreSQL integration tests across 35 files, and all 12 Playwright journeys. Development, production, and production-plus-Stripe Compose configurations validated with nonprinting dummy process values. `npm audit --omit=dev` reported three low and four moderate findings, the full-tree audit added one low finding, and neither audit reported a high or critical finding; every reported path remains covered by the accepted exceptions above. A freshly rebuilt, isolated 138,211,186-byte production image completed all seven migrations twice without changing the journal or preserved-grant count, brought PostgreSQL, the app, worker, and Caddy to healthy state, enforced maintenance responses across storefront and commerce paths, kept PostgreSQL private, and confirmed that the Stripe-disabled base deployment receives neither Stripe environment credentials nor Stripe secret files. The exact smoke project, volumes, network, and image were removed afterward without touching the development stack.
