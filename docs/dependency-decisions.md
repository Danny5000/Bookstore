# Dependency decisions

Checked against the npm registry on 2026-08-08.

| Package | Selected line | Decision |
| --- | --- | --- |
| Node.js | 24.15.x | One Node 24 line is used by local tooling and the future production image. |
| TypeScript | 6.0.x | TypeScript 7 is deferred until svelte-check and typescript-eslint both publish compatible peer ranges. |
| @types/node | 24.x | Matches the selected Node runtime instead of the unrelated newest Node major. |
| SvelteKit / Svelte | Current stable | Keep both on their mutually supported stable releases. |
| Vite / Svelte Vite plugin | Current compatible stable pair | Upgrade together because their peer ranges are coupled. |
| adapter-node | Current SvelteKit-compatible stable | Replaces adapter-auto for the Docker/Node deployment target. |
| Stripe SDK | Current stable | Upgrade in isolation and verify checkout/webhook types and runtime behavior. |

Run `npm outdated`, `npm audit`, `npm ls`, and `npm run verify` before completing Plan 0.
Any remaining direct-package lag requires a dated compatibility reason and a removal condition in this file.

## Accepted audit finding

`npm audit` currently reports one transitive advisory as three low-severity dependency-path findings: `cookie` below 0.7.0 through SvelteKit and adapter-node. The prototype only reads its fixed-name session cookie and does not construct cookie names, paths, or domains from untrusted input, so the affected validation behavior is not exposed by current application code. There is no compatible stable SvelteKit upgrade that removes the finding; npm's suggested forced resolution is an invalid downgrade. Remove this exception when a stable SvelteKit release depends on `cookie` 0.7.0 or newer.
