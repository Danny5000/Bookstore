# Dependency decisions

Checked against the npm registry on 2026-08-09.

| Package | Selected line | Decision |
| --- | --- | --- |
| Node.js | 26.7.x | Local tooling and the future production image use the same Node 26 runtime line. |
| TypeScript | 6.0.x | TypeScript 7 is deferred until stable svelte-check and typescript-eslint releases both publish compatible peer ranges. |
| @types/node | 26.x | Matches the selected Node 26 runtime; the registry currently publishes 26.2.0 for TypeScript 6. |
| SvelteKit / Svelte | Current stable | Keep both on their mutually supported stable releases. |
| Vite / Svelte Vite plugin | Current compatible stable pair | Upgrade together because their peer ranges are coupled. |
| adapter-node | Current SvelteKit-compatible stable | Replaces adapter-auto for the Docker/Node deployment target. |
| npm | 11.19.x | Matches the npm release bundled in the exact Node 26.7.0 development and production image; reconsider npm 12 when the selected Node image ships it. |
| Playwright | 1.62.x | Current stable browser-test runner; Chromium is the initial cross-browser contract and more projects can be added when browser-specific defects justify them. |
| Zod | 4.4.x | Current stable runtime schema validator; restricted to trusted configuration and later request-boundary schemas. |
| PostgreSQL image | 18.4 Alpine | Exact production/development database tag; mount `/var/lib/postgresql` for the PostgreSQL 18 image layout. |
| Mailpit image | 1.30.0 | Exact development-only SMTP capture service. |
| Caddy image | 2.11.4 Alpine | Exact production reverse-proxy baseline. |
| Stripe SDK | Current stable | Upgrade in isolation and verify checkout/webhook types and runtime behavior. |
| Drizzle ORM | 0.45.2 | Current stable typed PostgreSQL ORM; schema files are the source of truth and runtime code uses the node-postgres adapter. |
| Drizzle Kit | 0.31.10 | Current stable development-only migration generator/checker; generated SQL and snapshots are committed. |
| node-postgres (`pg`) | 8.23.0 | Current stable pooled PostgreSQL driver supported by Drizzle; web, worker, and migration processes own separate bounded pools. |
| `@types/pg` | 8.21.0 | Current node-postgres type declarations required by the strict TypeScript build. |
| tsx | 4.23.11 | Current stable development-only TypeScript runner for worker, migration, and test orchestration entry points. |
| Better Auth | 1.6.26 | Current stable authentication runtime; its peer ranges accept the selected SvelteKit, Svelte, Drizzle, PostgreSQL, and Vitest versions. |
| Better Auth CLI | 1.6.26 exact, on demand | Schema generation must match the runtime exactly; keep it outside the installed tree until its unfixed tool-only advisory is removed. |
| Nodemailer | 9.0.5 | Current stable SMTP implementation behind the provider-neutral email adapter. |
| `@types/nodemailer` | 8.0.1 | Current published declarations; remove when Nodemailer ships compatible declarations directly. |
| `@fastify/busboy` | 3.2.0 | Current stable streaming multipart parser; request handlers apply explicit part-count and byte limits without buffering publication uploads. |
| yauzl | 3.4.0 | Current stable lazy, random-access ZIP reader; ingestion validates archive metadata and observed streams before accepting entries. |
| `@types/yauzl` | 3.4.0 | Current published strict TypeScript declarations for yauzl. |
| sharp | 0.35.3 | Current stable image decoder/normalizer; its platform-specific optional packages must survive production dependency pruning. |
| `file-type` | 22.0.1 | Current stable signature detector used only as a format hint; successful decoding and domain validation remain authoritative. |
| `fast-xml-parser` | 5.10.1 | Current stable bounded XML parser; ingestion rejects document types and entities before parsing untrusted EPUB or ComicInfo metadata. |
| fflate | 0.8.3 | Current stable test-only archive writer used to generate deterministic valid and hostile fixtures; it is not part of production ingestion. |

TypeScript 6.0.3 remains intentional while the registry latest is 7.0.2: as checked on 2026-08-09,
`typescript-eslint` 8.66.0 accepts TypeScript `>=4.8.4 <6.1.0` and
`svelte-check` 4.7.5 accepts TypeScript 5 or 6. Remove this pin when both stable
packages support TypeScript 7.

Run `npm outdated`, `npm audit`, `npm ls`, and `npm run verify` before completing each implementation plan.
Any remaining direct-package lag requires a dated compatibility reason and a removal condition in this file.

The Better Auth schema generator is invoked as exact `auth@1.6.26` by the
`auth:schema` and `auth:info` scripts instead of being committed to the application
dependency tree. On 2026-08-08 that CLI's Prisma parser pulled Lodash 4.17.23,
which npm reports with an unfixed high-severity advisory. Schema generation is a
manual/CI tool run only against this trusted repository, never a production runtime
or network service. Keep the version exact, do not run it against untrusted config,
and restore it as a locked development dependency when its dependency graph no
longer contains the advisory.

## Accepted audit findings

`npm audit` currently reports one transitive advisory as four low-severity dependency-path findings: `cookie` below 0.7.0 through SvelteKit, adapter-node, and Better Auth. The application and authentication library use fixed, trusted cookie configuration; request data cannot choose cookie names, paths, or domains, so the affected validation behavior is not exposed by current application code. There is no compatible stable SvelteKit upgrade that removes the finding; npm's suggested forced resolution is an invalid downgrade. Remove this exception when a stable SvelteKit release depends on `cookie` 0.7.0 or newer.

Drizzle Kit 0.31.10 also reports four moderate development-only dependency-path findings through its deprecated `@esbuild-kit/esm-loader` dependency and esbuild 0.18.20. The advisory concerns an exposed esbuild development server; this project uses Drizzle Kit only as a local/CI migration generator and checker, never as a production server or runtime dependency. Drizzle Kit 0.31.10 is the current stable release, while npm's suggested `0.18.1` resolution is an incompatible downgrade. Do not expose Drizzle Kit's development server to untrusted networks. Remove this exception when a stable Drizzle Kit release removes the deprecated loader path or upgrades its affected esbuild dependency.
