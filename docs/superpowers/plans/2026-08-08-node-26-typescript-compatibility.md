# Node 26 and TypeScript Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the project with Node.js 26.7.0 and `@types/node` 26 while retaining the newest TypeScript version supported by the validation toolchain.

**Architecture:** This is a toolchain-only change: runtime metadata and Node declarations move together, while TypeScript remains pinned at 6.0.3 because the installed stable `svelte-check` and `typescript-eslint` releases do not support TypeScript 7. The lockfile and dependency policy remain the authoritative records, and no application source changes are permitted.

**Tech Stack:** Node.js 26.7.0, npm 11, TypeScript 6.0.3, Svelte 5, SvelteKit 2, ESLint 10, Vitest 4

---

### Task 1: Align runtime metadata and Node declarations

**Files:**

- Modify: `.nvmrc`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Confirm the active runtime and clean dependency baseline**

Run:

```powershell
node --version
npm --version
npm ls --depth=0
git status --short
```

Expected: Node reports `v26.7.0`, npm reports an 11.x release, `npm ls` has no invalid or unmet peer dependency, and the worktree is clean.

- [ ] **Step 2: Update the declared Node runtime**

Replace `.nvmrc` with:

```text
26.7.0
```

Change the `engines` block in `package.json` to:

```json
"engines": {
  "node": ">=26.7.0 <27",
  "npm": ">=11.12.1 <12"
}
```

Expected: the project accepts Node 26.7.x and later Node 26 patch releases, but not a future Node major that has not been verified.

- [ ] **Step 3: Upgrade only the Node declaration package**

Run:

```powershell
npm install --save-dev '@types/node@^26.2.0'
```

Expected: `package.json` contains `"@types/node": "^26.2.0"`, `package-lock.json` resolves `@types/node` 26.2.0, and TypeScript remains `~6.0.3`.

- [ ] **Step 4: Verify the supported dependency pair**

Run:

```powershell
npm ls @types/node typescript svelte-check typescript-eslint
npm outdated
```

Expected: the dependency tree is valid; `@types/node` is 26.2.0; TypeScript is 6.0.3; and `npm outdated` lists TypeScript 7.0.2 only. A nonzero `npm outdated` exit code is expected while that documented compatibility pin exists.

- [ ] **Step 5: Commit the runtime and lockfile update**

Run:

```powershell
git add .nvmrc package.json package-lock.json
git commit -m "build: align project with Node 26"
```

Expected: one focused toolchain commit with no application source changes.

### Task 2: Update developer and dependency documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/dependency-decisions.md`

- [ ] **Step 1: Update the README runtime requirement**

Replace the Development requirement with:

```markdown
Requirements: Node.js 26.7.x and npm 11.12.1 or newer within the npm 11 line.
```

Expected: onboarding instructions match the checked-in Node runtime while continuing to accept the supported npm 11 line.

- [ ] **Step 2: Record the compatibility decision**

Replace the Node.js, TypeScript, and `@types/node` rows in `docs/dependency-decisions.md` with:

```markdown
| Node.js | 26.7.x | Local tooling and the future production image use the same Node 26 runtime line. |
| TypeScript | 6.0.x | TypeScript 7 is deferred until stable svelte-check and typescript-eslint releases both publish compatible peer ranges. |
| @types/node | 26.x | Matches the selected Node 26 runtime; the registry currently publishes 26.2.0 for TypeScript 6. |
```

After the table, add this compatibility evidence:

```markdown
TypeScript 6.0.3 remains intentional: as checked on 2026-08-08,
`typescript-eslint` 8.66.0 accepts TypeScript `>=4.8.4 <6.1.0` and
`svelte-check` 4.7.5 accepts TypeScript 5 or 6. Remove this pin when both stable
packages support TypeScript 7.
```

Expected: the reason, evidence, and removal condition for the remaining outdated result are explicit.

- [ ] **Step 3: Check documentation scope and formatting**

Run:

```powershell
git diff --check
git diff -- README.md docs/dependency-decisions.md
```

Expected: no whitespace errors and no unrelated documentation edits.

- [ ] **Step 4: Commit the documentation update**

Run:

```powershell
git add README.md docs/dependency-decisions.md
git commit -m "docs: document Node 26 dependency policy"
```

Expected: one documentation-only commit.

### Task 3: Enforce the compatibility quality gate

**Files:**

- Modify: dependency or documentation files from Tasks 1–2 only if verification exposes a defect

- [ ] **Step 1: Verify the installed direct dependency graph**

Run:

```powershell
npm ls --depth=0
```

Expected: `@types/node@26.2.0` and `typescript@6.0.3` appear with no invalid, extraneous, or unmet direct dependency.

- [ ] **Step 2: Confirm only the intentional pin remains outdated**

Run:

```powershell
$outdatedJson = npm outdated --json
$outdated = $outdatedJson | ConvertFrom-Json -AsHashtable
$outdatedKeys = @($outdated.Keys)
if ($outdatedKeys.Count -ne 1 -or $outdatedKeys[0] -ne 'typescript') {
  $outdatedJson
  throw 'Unexpected direct dependency lag remains'
}
$outdated.typescript | Format-List
```

Expected: the only key is `typescript`, with current and wanted 6.0.3 and latest 7.0.2. PowerShell may preserve npm's nonzero status from `npm outdated`; the explicit key check is the acceptance criterion.

- [ ] **Step 3: Confirm no high or critical audit finding**

Run:

```powershell
$auditJson = npm audit --audit-level=high --json
$audit = $auditJson | ConvertFrom-Json
$audit.metadata.vulnerabilities | Format-List
if ($audit.metadata.vulnerabilities.high -gt 0 -or $audit.metadata.vulnerabilities.critical -gt 0) {
  throw 'High or critical npm vulnerability found'
}
```

Expected: high and critical counts are both zero. The documented transitive `cookie` finding may remain low severity.

- [ ] **Step 4: Run the complete application verification**

Run:

```powershell
npm run verify
```

Expected: `svelte-check` reports 0 errors and 0 warnings, ESLint exits 0, Vitest reports 7 passed files and 19 passed tests, and the adapter-node production build exits 0.

- [ ] **Step 5: Prove the final diff is dependency-only**

Run:

```powershell
git status --short
git diff main...HEAD --stat
git diff main...HEAD --name-only
git diff --check main...HEAD
```

Expected: only `.nvmrc`, `package.json`, `package-lock.json`, `README.md`, `docs/dependency-decisions.md`, and this plan appear. The approved design spec is already part of the merge base. No file under `src` changes.

- [ ] **Step 6: Commit verification fixes only if necessary**

If verification required a correction within the approved files, run:

```powershell
git add .nvmrc package.json package-lock.json README.md docs/dependency-decisions.md
git commit -m "build: finalize Node 26 compatibility"
```

Expected: no empty commit. If no verification correction was needed, leave the branch at the two focused implementation commits plus the plan commit.
