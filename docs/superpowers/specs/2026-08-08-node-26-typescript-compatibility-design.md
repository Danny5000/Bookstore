# Node 26 and TypeScript compatibility design

**Date:** 2026-08-08

## Objective

Align the project with the developer's Node.js 26.7.0 runtime and matching Node
type declarations without weakening the TypeScript, Svelte, lint, test, or build
quality gates.

## Dependency decision

- Set the project runtime line to Node.js 26.7.x in `.nvmrc`, `package.json`, and
  developer documentation.
- Upgrade `@types/node` from 24.x to the current Node 26 declaration line,
  26.2.0.
- Retain TypeScript 6.0.3 as an intentional compatibility pin. As checked
  against the npm registry on 2026-08-08, `typescript-eslint` 8.66.0 supports
  TypeScript versions from 4.8.4 through versions below 6.1.0, while
  `svelte-check` 4.7.5 supports TypeScript 5 and 6. TypeScript 7.0.2 is outside
  both peer ranges.
- Do not use npm peer overrides, `--force`, or removal of validation tooling to
  install TypeScript 7.
- Revisit the TypeScript 7 upgrade after both validation packages publish
  compatible stable peer ranges.

The existing npm 11 engine range and package-manager pin remain unchanged; they
are compatible with the installed npm 11 release and are not part of this
dependency update.

## Files and behavior

The implementation will update:

- `.nvmrc`
- `package.json` and `package-lock.json`
- `README.md`
- `docs/dependency-decisions.md`

No application source, API contract, runtime behavior, database design, or
deployment architecture changes are included.

## Verification

The completed update must demonstrate:

1. `node --version` reports 26.7.0.
2. `npm ls --depth=0` has no invalid or unmet peer dependency.
3. `npm outdated` lists only the documented TypeScript 7 compatibility pin.
4. `npm audit --audit-level=high` reports no high or critical vulnerability.
5. `npm run verify` completes with zero Svelte diagnostics, no ESLint errors,
   all tests passing, and a successful adapter-node production build.

If any quality gate fails, the dependency update is not complete and the
failure must be resolved without bypassing peer checks.
