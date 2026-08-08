# Dependency decisions

Checked against the npm registry on 2026-08-08.

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

TypeScript 6.0.3 remains intentional: as checked on 2026-08-08,
`typescript-eslint` 8.66.0 accepts TypeScript `>=4.8.4 <6.1.0` and
`svelte-check` 4.7.5 accepts TypeScript 5 or 6. Remove this pin when both stable
packages support TypeScript 7.

Run `npm outdated`, `npm audit`, `npm ls`, and `npm run verify` before completing each implementation plan.
Any remaining direct-package lag requires a dated compatibility reason and a removal condition in this file.

## Accepted audit finding

`npm audit` currently reports one transitive advisory as three low-severity dependency-path findings: `cookie` below 0.7.0 through SvelteKit and adapter-node. The prototype only reads its fixed-name session cookie and does not construct cookie names, paths, or domains from untrusted input, so the affected validation behavior is not exposed by current application code. There is no compatible stable SvelteKit upgrade that removes the finding; npm's suggested forced resolution is an invalid downgrade. Remove this exception when a stable SvelteKit release depends on `cookie` 0.7.0 or newer.
