# Dependency Modernization and Strict TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize the prototype's existing dependencies and convert every application source module and Svelte component to strict, explicitly typed TypeScript without changing the product's intended behavior.

**Architecture:** Keep the existing SvelteKit monolith and Svelte 5 runes. Establish one compatible Node/Svelte/Vite/TypeScript toolchain first, then migrate from the lowest-level domain and pagination modules upward through stores, server routes, components, and pages. Pure behavior receives Vitest characterization tests; Svelte and route contracts are enforced by `svelte-check`, ESLint, and the production build.

**Tech Stack:** Node.js 24, npm, SvelteKit 2, Svelte 5, Vite 8, TypeScript 6, Vitest 4, ESLint 10, eslint-plugin-svelte, Stripe Node SDK 22, adapter-node

---

## Scope and constraints

This is Implementation Plan 0 from the approved [full-stack design](../specs/2026-08-08-bookstore-full-stack-design.md). It does not add PostgreSQL, Better Auth, Docker, ingestion, or other backend functionality. It leaves the prototype operational while making it a strict, current, testable base for those later plans.

Execution precondition: create a dedicated Git worktree with the `superpowers:using-git-worktrees` skill before Task 1. Do not execute Plan 0 directly in the planning workspace or on an unrelated dirty branch.

The registry versions in this plan were verified on 2026-08-08. Task 1 repeats that check before installation. If a newer stable release exists, use it only when its Node and peer ranges are mutually compatible; update `docs/dependency-decisions.md` with the selected version and evidence. Do not use prereleases, `--force`, or `npm audit fix --force`.

The current baseline is Node 24.15.0, npm 11.12.1, and a passing Vite 5 production build with these known warnings:

- adapter-auto cannot identify a production platform.
- `jsconfig.json` does not extend SvelteKit's generated configuration.
- `BookVolume.svelte` and `BookReader.svelte` have two accessibility warnings.
- `BookReader.svelte` has three initial-state capture warnings.

Plan 0 must remove all of those warnings rather than suppress them.

## File responsibility map

### Toolchain and documentation

- Create `.nvmrc`: local Node version pin.
- Modify `package.json` and `package-lock.json`: compatible current dependency set and quality scripts.
- Modify `svelte.config.js`: replace adapter-auto with adapter-node.
- Replace `jsconfig.json` with `tsconfig.json`: strict application compiler contract.
- Rename `vite.config.js` to `vite.config.ts`: typed Vite configuration.
- Create `vitest.config.ts`: Node-based pure-module tests.
- Create `eslint.config.js`: flat ESLint configuration for TypeScript and Svelte.
- Create `docs/dependency-decisions.md`: dated compatibility decisions and intentional pins.
- Modify `README.md`: TypeScript paths, commands, and current architecture references.

### Shared contracts and pure logic

- Create `src/app.d.ts`: typed SvelteKit locals.
- Create `src/lib/types/auth.ts`: prototype session identity.
- Create `src/lib/types/catalog.ts`: title, chapter, and format contracts.
- Create `src/lib/types/reader.ts`: page, pagination, preference, and animation contracts.
- Create `src/lib/types/api.ts`: prototype API request/response contracts and runtime guards.
- Create `src/lib/utils/persistence.ts`: safe unknown JSON and local-storage decoders.
- Create `src/lib/utils/errors.ts`: unknown-error normalization.
- Create `src/lib/data/manuscript.ts`: pure pasted-manuscript parsing.
- Create `src/lib/reader/easing.ts`: pure cubic-bezier implementation extracted from the reader.

### Files converted in place

- Rename all 13 `src/**/*.js` and `src/**/*.svelte.js` modules to `.ts` or `.svelte.ts`.
- Add `lang="ts"` and explicit prop/state/event types to all 15 `src/**/*.svelte` files.
- Keep `svelte.config.js` and `eslint.config.js` as JavaScript configuration files; they are not production application source.

### Characterization tests

- Create `src/lib/data/catalog.test.ts`.
- Create `src/lib/data/manuscript.test.ts`.
- Create `src/lib/paginate.test.ts`.
- Create `src/lib/utils/persistence.test.ts`.
- Create `src/lib/utils/errors.test.ts`.
- Create `src/lib/types/api.test.ts`.
- Create `src/lib/reader/easing.test.ts`.

## Task 1: Pin the runtime and modernize dependencies

**Files:**

- Create: `.nvmrc`
- Create: `docs/dependency-decisions.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `svelte.config.js`

- [ ] **Step 1: Reproduce the dependency and build baseline**

Run:

~~~powershell
node --version
npm --version
npm outdated
npm audit
npm ls --depth=0
npm run build
~~~

Expected: Node reports `v24.15.0`, npm reports `11.12.1`, the existing build exits 0, and outdated/audit report the issues captured in the design spec. `npm outdated` and `npm audit` may exit 1 at this baseline.

- [ ] **Step 2: Recheck current compatibility before editing the manifest**

Run:

~~~powershell
$packages = @(
  '@sveltejs/kit',
  'svelte',
  '@sveltejs/adapter-node',
  '@sveltejs/vite-plugin-svelte',
  'vite',
  'stripe',
  'svelte-check',
  'vitest',
  'eslint',
  'eslint-plugin-svelte',
  'typescript-eslint'
)
foreach ($package in $packages) {
  npm view "$package@latest" version engines peerDependencies --json
}
npm view typescript@6 version engines peerDependencies --json
npm view @types/node@24 version engines peerDependencies --json
~~~

Expected: the Svelte/Vite packages accept one another, Vite and the plugin accept Node 24, and both `svelte-check` and `typescript-eslint` accept TypeScript 6. Select the last stable 6.0.x entry returned for TypeScript and the last stable 24.x entry returned for Node types.

- [ ] **Step 3: Replace `package.json` with the verified toolchain**

Use this manifest, changing a version only when Step 2 found a newer mutually compatible stable release:

~~~json
{
  "name": "pale-orbit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "npm@11.12.1",
  "engines": {
    "node": ">=24.15.0 <25",
    "npm": ">=11.12.1 <12"
  },
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "verify": "npm run check && npm run lint && npm run test && npm run build"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@sveltejs/adapter-node": "^5.5.7",
    "@sveltejs/kit": "^2.70.2",
    "@sveltejs/vite-plugin-svelte": "^7.3.0",
    "@types/node": "^24.13.3",
    "eslint": "^10.8.1",
    "eslint-plugin-svelte": "^3.22.0",
    "globals": "^17.9.0",
    "svelte": "^5.56.8",
    "svelte-check": "^4.7.5",
    "typescript": "~6.0.3",
    "typescript-eslint": "^8.66.0",
    "vite": "^8.2.1",
    "vitest": "^4.1.10"
  },
  "dependencies": {
    "stripe": "^22.4.0"
  }
}
~~~

TypeScript stays on 6.0.x because the verified `svelte-check` and `typescript-eslint` peer ranges do not yet accept TypeScript 7.

- [ ] **Step 4: Switch the SvelteKit production adapter**

Replace `svelte.config.js` with:

~~~javascript
import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter()
  }
};

export default config;
~~~

- [ ] **Step 5: Record the runtime and compatibility decisions**

Create `.nvmrc`:

~~~text
24.15.0
~~~

Create `docs/dependency-decisions.md`:

~~~markdown
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

Run npm outdated, npm audit, npm ls, npm run verify before completing Plan 0.
Any remaining direct-package lag requires a dated compatibility reason and a removal condition in this file.
~~~

- [ ] **Step 6: Regenerate the lockfile without forcing peer resolution**

Run:

~~~powershell
npm install
npm ls --depth=0
~~~

Expected: install exits 0, `package-lock.json` changes, adapter-auto is absent, adapter-node is present, and `npm ls` reports no invalid or unmet peer dependency.

- [ ] **Step 7: Verify the upgraded runtime baseline**

Run:

~~~powershell
npm audit --audit-level=high
npm run build
~~~

Expected: no high or critical advisory remains and the Vite 8 adapter-node build exits 0. Lower-severity findings must be recorded in `docs/dependency-decisions.md` with package, exposure, and removal condition.

- [ ] **Step 8: Commit the dependency modernization separately**

Run:

~~~powershell
git add .nvmrc package.json package-lock.json svelte.config.js docs/dependency-decisions.md
git commit -m "build: modernize the Svelte toolchain"
~~~

Expected: one commit containing only runtime, package, adapter, and dependency-decision files.

## Task 2: Establish strict TypeScript, lint, and test configuration

**Files:**

- Delete: `jsconfig.json`
- Rename: `vite.config.js` to `vite.config.ts`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `src/app.d.ts`
- Create: `src/lib/types/auth.ts`

- [ ] **Step 1: Replace the JavaScript compiler configuration**

Delete `jsconfig.json` and create `tsconfig.json`:

~~~json
{
  "extends": "./.svelte-kit/tsconfig.json",
  "compilerOptions": {
    "allowJs": false,
    "checkJs": false,
    "esModuleInterop": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "strict": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true
  }
}
~~~

- [ ] **Step 2: Convert the Vite configuration**

Rename `vite.config.js` to `vite.config.ts` and use:

~~~typescript
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()]
});
~~~

- [ ] **Step 3: Add the Vitest configuration**

Create `vitest.config.ts`:

~~~typescript
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true
  }
});
~~~

- [ ] **Step 4: Add strict flat ESLint configuration**

Create `eslint.config.js`:

~~~javascript
import eslint from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['.svelte-kit/**', 'build/**', 'node_modules/**']
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser
      }
    }
  }
);
~~~

- [ ] **Step 5: Define the prototype session contract and SvelteKit locals**

Create `src/lib/types/auth.ts`:

~~~typescript
export interface SessionUser {
  email: string;
}
~~~

Create `src/app.d.ts`:

~~~typescript
import type { SessionUser } from '$lib/types/auth';

declare global {
  namespace App {
    interface Locals {
      user: SessionUser | null;
    }
  }
}

export {};
~~~

- [ ] **Step 6: Generate SvelteKit types and verify configuration discovery**

Run:

~~~powershell
npx svelte-kit sync
npx tsc --showConfig | Select-String '"strict": true', '"allowJs": false'
npm run build
~~~

Expected: the generated configuration includes strict mode and excludes JavaScript application source; the build exits 0 without the old `jsconfig.json` warning. Component warnings remain until Tasks 7 and 8.

- [ ] **Step 7: Commit the strict toolchain configuration**

Run:

~~~powershell
git add tsconfig.json vite.config.ts vitest.config.ts eslint.config.js src/app.d.ts src/lib/types/auth.ts
git add -u jsconfig.json vite.config.js
git commit -m "build: add strict TypeScript quality gates"
~~~

## Task 3: Introduce catalog/reader contracts and convert seed data

**Files:**

- Create: `src/lib/types/catalog.ts`
- Create: `src/lib/types/reader.ts`
- Rename: `src/lib/data/catalog.js` to `src/lib/data/catalog.ts`
- Rename: `src/lib/data/prose.js` to `src/lib/data/prose.ts`
- Create: `src/lib/data/catalog.test.ts`
- Modify import specifiers in all files currently importing `$lib/data/catalog.js`

- [ ] **Step 1: Write failing catalog characterization tests**

Create `src/lib/data/catalog.test.ts`:

~~~typescript
import { describe, expect, it } from 'vitest';
import type { Title } from '$lib/types/catalog';
import { byId, coverBackground, money } from './catalog';
import { chapters } from './prose';

describe('catalog helpers', () => {
  it('formats prototype prices without changing display behavior', () => {
    expect(money(9.99)).toBe('$9.99');
  });

  it('returns seed titles by stable id', () => {
    const title: Title | undefined = byId('salt');
    expect(title?.title).toBe('The Salt Harvest');
    expect(byId('missing')).toBeUndefined();
  });

  it('prefers an uploaded cover URL over the palette', () => {
    expect(coverBackground(0, '/cover.webp')).toBe('center / cover url(/cover.webp)');
    expect(coverBackground(0, null)).toContain('linear-gradient');
  });

  it('builds the same chapter paragraph counts as the prototype', () => {
    expect(chapters(0, ['One'])[0]).toMatchObject({
      title: 'One',
      paras: expect.any(Array)
    });
    expect(chapters(0, ['One'])[0]?.paras).toHaveLength(9);
  });
});
~~~

- [ ] **Step 2: Run the test to verify the TypeScript modules do not exist yet**

Run:

~~~powershell
npm test -- src/lib/data/catalog.test.ts
npx tsc --noEmit
~~~

Expected: the four runtime characterization tests pass against the JavaScript baseline, then TypeScript compilation fails because the strict catalog contracts/modules do not exist yet.

- [ ] **Step 3: Define the catalog domain types**

Create `src/lib/types/catalog.ts`:

~~~typescript
export type TitleKind = 'novel' | 'comic';
export type ReadingDirection = 'ltr' | 'rtl';
export type PanelMode = 'auto' | 'manual' | 'off';

export interface Chapter {
  title: string;
  paras: string[];
}

export interface TitleBase {
  id: string;
  title: string;
  author: string;
  price: number;
  released: string;
  cover: number;
  coverUrl?: string | null;
  summary: string;
}

export interface NovelTitle extends TitleBase {
  kind: 'novel';
  chapters?: Chapter[];
  fixed?: boolean;
  pages?: number;
  sourceFile?: string | null;
  samplePages?: number;
  pageNames?: never;
  direction?: never;
  panelMode?: never;
}

export interface ComicTitle extends TitleBase {
  kind: 'comic';
  pages: number;
  pageNames?: string[];
  direction?: ReadingDirection;
  panelMode?: PanelMode;
  chapters?: never;
  fixed?: never;
  sourceFile?: never;
  samplePages?: never;
}

export type Title = NovelTitle | ComicTitle;
~~~

- [ ] **Step 4: Define reader and pagination types**

Create `src/lib/types/reader.ts`:

~~~typescript
import type { Title } from './catalog';

export interface PageBoxInput {
  vw: number;
  vh: number;
  narrow: boolean;
  fontSize: number;
  chrome?: number;
}

export interface PageBox {
  pw: number;
  ph: number;
  pad: number;
  fs: number;
}

export interface ReadingAnchor {
  chapter: number;
  at: number;
}

export interface PanelCell {
  c: number;
  r: number;
  cap: string;
}

interface ReaderPageBase {
  chapter: number;
  at: number;
  folio: string;
}

export interface TextReaderPage extends ReaderPageBase {
  type: 'text';
  heading: string | null;
  paras: string[];
  layout?: never;
  label?: never;
}

export interface ComicReaderPage extends ReaderPageBase {
  type: 'comic';
  layout: PanelCell[];
  heading?: never;
  paras?: never;
  label?: never;
}

export interface ScanReaderPage extends ReaderPageBase {
  type: 'scan';
  label: string;
  heading?: never;
  paras?: never;
  layout?: never;
}

export type ReaderPage = TextReaderPage | ComicReaderPage | ScanReaderPage;
export type PaperId = 'white' | 'sepia' | 'dim';
export type TypefaceId = 'serif' | 'sans' | 'georgia';

export interface ReaderPreferences {
  fontSize: number;
  typeface: TypefaceId;
  paper: PaperId;
}

export type ReaderPhase = 'closed' | 'opening' | 'openingEnd' | 'reading' | 'closing' | 'closingEnd';
export type TurnDirection = -1 | 1;

export interface TurnProgress {
  dir: TurnDirection;
  t: number;
}

export interface SheetView {
  k: number;
  angle: number;
  curl: number;
  active: boolean;
  z: number;
  showFront: boolean;
  showBack: boolean;
  front: ReaderPage | null;
  back: ReaderPage | null;
}

export type EasingFunction = (position: number) => number;

export interface ReaderProps {
  title: Title;
  sample?: boolean;
  onclose?: () => void;
  onbuy?: () => void;
}
~~~

- [ ] **Step 5: Convert the seed modules with explicit signatures**

Rename the two data files. In `prose.ts`, type the exported data and functions:

~~~typescript
import type { Chapter } from '$lib/types/catalog';

export const BANK: readonly string[] = [
  'The tide came in grey that season, and with it the salt that would pay for everything we did next. We worked the flats at low water, three of us and a borrowed rake, while the station lights burned overhead like a town that had forgotten to come down.',
  'Ceren said the orbital was drifting again. She said it the way you mention weather, or a debt. I kept my eyes on the shallow water and counted the crystals forming along the rope, small and patient and entirely indifferent to whether we lived.',
  'There is a particular arithmetic to being poor on a company world. You learn the price of everything twice: once in credit, once in the hours it costs to earn the credit. By the second winter I could do the second sum faster than the first.',
  'The freighter came down at dusk with its heat shields still ticking. Nobody went out to meet it. That was how you could tell the place had changed - a ship used to be an event, and now it was only a schedule.',
  'I have tried to write this part honestly. What happened at the harvest was not heroic and it was not clean, and the version they tell in the corridors has a shape that real things never have.',
  'Later, when the inquiry asked me to describe the moment the ring failed, I said it looked like a sentence being erased. They wanted metaphors. I had spent four years learning to see machines as machines, and they wanted metaphors.',
  'We slept in shifts under the conveyor, where the noise was worst and the wind was least. Ceren dreamed out loud. Once she said a name I did not know and then apologized for it in the morning, which told me more than the name would have.',
  'The salt kept coming. That was the thing about the flats - they did not care about the inquiry, or the ring, or the men who arrived in clean coats to measure our grief in units. Every twelve hours the water went out and left its wages behind.',
  'My contract said eighteen months and a berth home. It also said, in a clause I did not read until the second spring, that the berth was subject to availability, and that availability was a determination made by the company.',
  'Ostergaard ran the flats for the company and had the particular gentleness of a man who has never once had to say no in person. He signed things. Somewhere above us a machine turned his signature into weather.',
  'There were nights the ring was so bright you could read by it. We did, sometimes - the three of us passing a reader between us, arguing about a book none of us had finished, while the pumps knocked and the water crept.',
  'You could see the fault from the ground if you knew where to look: a seam of dark against the lit arc, widening by a hair a month. For two years the official position was that the seam was a shadow.',
  'The first time I said the word sabotage out loud, Ceren put her hand flat on the table, the way you steady a glass on a ship. Not here, she said. Not with that word. Say it the way an engineer would say it, or do not say it.',
  'What an engineer would say is: the tolerance had been exceeded, and the party responsible for the tolerance had been reassigned. That is the whole story, told properly. Everything else is just the part where people live in it.'
];

export function prose(seed: number, count: number): string[] {
  const output: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const paragraph = BANK[(seed + index) % BANK.length];
    if (paragraph !== undefined) output.push(paragraph);
  }
  return output;
}

export function chapters(seed: number, names: readonly string[]): Chapter[] {
  return names.map((title, index) => ({
    title,
    paras: prose(seed + index * 5, 9 + (index % 3))
  }));
}
~~~

Do not replace the paragraph array with the comment shown above; retain the complete existing `BANK` array verbatim.

Replace `catalog.ts` with the typed equivalent below:

~~~typescript
import type { Title } from '$lib/types/catalog';
import type { PanelCell } from '$lib/types/reader';
import { chapters } from './prose';

export const SWATCHES = [
  ['oklch(0.72 0.14 200)', 'oklch(0.28 0.06 260)'],
  ['oklch(0.78 0.15 60)', 'oklch(0.30 0.05 30)'],
  ['oklch(0.70 0.16 340)', 'oklch(0.26 0.05 300)'],
  ['oklch(0.80 0.13 130)', 'oklch(0.27 0.05 160)'],
  ['oklch(0.86 0.05 90)', 'oklch(0.24 0.02 260)']
] as const satisfies readonly (readonly [string, string])[];

export function coverBackground(index = 0, url: string | null | undefined = null): string {
  if (url) return `center / cover url(${url})`;
  const pair = SWATCHES[index % SWATCHES.length] ?? SWATCHES[0];
  const [accent, ground] = pair;
  return `linear-gradient(150deg, ${ground} 0%, ${ground} 46%, ${accent} 47%, ${accent} 53%, ${ground} 54%)`;
}

export const COMIC_LAYOUTS = [
  [
    { c: 2, r: 1, cap: 'PANEL - establishing shot, the salt flats at dawn' },
    { c: 1, r: 1, cap: 'PANEL - Ceren, close' },
    { c: 1, r: 1, cap: 'PANEL - the rake in the water' }
  ],
  [
    { c: 1, r: 2, cap: 'PANEL - vertical: the tower' },
    { c: 1, r: 1, cap: 'PANEL - hands' },
    { c: 1, r: 1, cap: 'PANEL - the ring, breaking' }
  ],
  [{ c: 2, r: 2, cap: 'SPLASH - the freighter descending through cloud' }],
  [
    { c: 1, r: 1, cap: 'PANEL - corridor' },
    { c: 1, r: 1, cap: 'PANEL - the inquiry room' },
    { c: 2, r: 1, cap: 'PANEL - wide: everyone leaving at once' }
  ]
] as const satisfies readonly (readonly PanelCell[])[];

export const CATALOG = [
  {
    id: 'salt',
    kind: 'novel',
    title: 'The Salt Harvest',
    author: 'R. Vale Okonjo',
    price: 9.99,
    released: 'Mar 2026',
    cover: 0,
    summary:
      'Three seasons on a company world, one failing orbital ring, and the arithmetic of getting out.',
    chapters: chapters(0, [
      'One - Low Water',
      'Two - The Rake',
      'Three - Company Time',
      'Four - The Ring',
      'Five - Inquiry'
    ])
  },
  {
    id: 'ninety',
    kind: 'novel',
    title: 'Ninety Days of Vacuum',
    author: 'R. Vale Okonjo',
    price: 12.99,
    released: 'Nov 2025',
    cover: 1,
    summary: 'A salvage crew signs a contract nobody reads. The vacuum reads it for them.',
    chapters: chapters(3, ['One - Signing', 'Two - Drift', 'Three - Quiet Hours', 'Four - Return'])
  },
  {
    id: 'quiet',
    kind: 'novel',
    title: 'Quiet Machines',
    author: 'R. Vale Okonjo',
    price: 7.99,
    released: 'Jun 2025',
    cover: 4,
    summary:
      'Essays on growing up around engines, and what my father meant when he said a thing was running right.',
    chapters: chapters(5, ['The Garage', 'Running Right', 'My Mothers Radio', 'Afterward'])
  },
  {
    id: 'under',
    kind: 'novel',
    title: 'Understory',
    author: 'R. Vale Okonjo',
    price: 11.99,
    released: 'Jan 2026',
    cover: 3,
    summary: 'Terraforming is slow. Grief is slower. A botanist stays behind on a world that is not finished.',
    chapters: chapters(2, ['One - Seedbank', 'Two - Canopy', 'Three - Rot', 'Four - Understory'])
  },
  {
    id: 'vector',
    kind: 'comic',
    title: 'Vector & Vine',
    author: 'Okonjo - art by A. Reyes',
    price: 4.99,
    released: 'Apr 2026',
    cover: 2,
    pages: 8,
    summary: 'Issue #1. Two couriers, one cargo that is technically alive.'
  },
  {
    id: 'deep',
    kind: 'comic',
    title: 'Deep Field',
    author: 'Okonjo - art by A. Reyes',
    price: 5.99,
    released: 'Feb 2026',
    cover: 0,
    pages: 8,
    summary: 'Issue #1. What the long-exposure survey found looking away from everything.'
  }
] satisfies Title[];

export function money(value: number): string {
  return '$' + Number(value).toFixed(2);
}

export function byId(id: string): Title | undefined {
  return CATALOG.find((title) => title.id === id);
}
~~~

- [ ] **Step 6: Update catalog import specifiers**

Change imports ending in `data/catalog.js` or `data/prose.js` to extensionless imports in these exact files:

~~~text
src/lib/paginate.js
src/lib/components/BookReader.svelte
src/lib/components/BookVolume.svelte
src/lib/components/CoverArt.svelte
src/routes/+page.svelte
src/routes/book/[id]/+page.svelte
src/routes/catalog/+page.svelte
src/routes/checkout/[id]/+page.svelte
src/routes/library/+page.svelte
src/routes/studio/+page.svelte
src/routes/api/checkout/+server.js
~~~

Example:

~~~typescript
import { money, coverBackground } from '$lib/data/catalog';
~~~

- [ ] **Step 7: Run characterization and compiler checks**

Run:

~~~powershell
npm test -- src/lib/data/catalog.test.ts
npx tsc --noEmit
npm run build
~~~

Expected: catalog tests pass, the converted data modules type-check, and the application still builds.

- [ ] **Step 8: Commit the domain contracts and seed conversion**

Run:

~~~powershell
git add src/lib/types/catalog.ts src/lib/types/reader.ts src/lib/data src/lib/paginate.js src/lib/components src/routes
git commit -m "refactor: type catalog and reader contracts"
~~~

## Task 4: Convert and characterize pagination

**Files:**

- Rename: `src/lib/paginate.js` to `src/lib/paginate.ts`
- Create: `src/lib/paginate.test.ts`
- Modify: `src/lib/components/BookReader.svelte`
- Modify: `src/lib/components/PageFace.svelte`
- Modify: `src/routes/library/+page.svelte`

- [ ] **Step 1: Write failing pagination tests**

Create `src/lib/paginate.test.ts`:

~~~typescript
import { describe, expect, it } from 'vitest';
import { byId } from '$lib/data/catalog';
import { freeSheets, pageBox, pageForAnchor, paginate } from './paginate';

describe('pageBox', () => {
  it('fits a two-page spread within the viewport', () => {
    const box = pageBox({ vw: 1440, vh: 900, narrow: false, fontSize: 18 });
    expect(box).toEqual({ pw: 453, ph: 620, pad: 48, fs: 18 });
  });
});

describe('paginate', () => {
  it('memoizes the same title and geometry', () => {
    const title = byId('salt');
    expect(title).toBeDefined();
    const box = pageBox({ vw: 1440, vh: 900, narrow: false, fontSize: 18 });
    expect(paginate(title, box)).toBe(paginate(title, box));
  });

  it('creates deterministic comic pages', () => {
    const title = byId('vector');
    const box = pageBox({ vw: 800, vh: 900, narrow: true, fontSize: 18 });
    const pages = paginate(title, box);
    expect(pages).toHaveLength(8);
    expect(pages[0]).toMatchObject({ type: 'comic', chapter: 0, at: 0, folio: '1' });
  });

  it('restores the last page starting before a text anchor', () => {
    const title = byId('salt');
    const box = pageBox({ vw: 760, vh: 820, narrow: true, fontSize: 20 });
    const pages = paginate(title, box);
    const index = pageForAnchor(pages, { chapter: 1, at: 0 });
    expect(pages[index]?.chapter).toBe(1);
  });

  it('keeps the prose sample within the first chapter', () => {
    const title = byId('salt');
    const box = pageBox({ vw: 760, vh: 820, narrow: true, fontSize: 18 });
    const pages = paginate(title, box);
    const lastSampleSheet = freeSheets(title, pages, 1);
    expect(lastSampleSheet).toBeGreaterThan(0);
    expect(lastSampleSheet).toBeLessThan(pages.length);
  });
});
~~~

- [ ] **Step 2: Run the tests to verify the TypeScript module is absent**

Run:

~~~powershell
npm test -- src/lib/paginate.test.ts
npx tsc --noEmit
~~~

Expected: the four runtime characterization tests pass against the JavaScript pagination baseline, then TypeScript compilation fails because `paginate.ts` and its explicit contracts do not exist yet.

- [ ] **Step 3: Rename pagination and add explicit public signatures**

Rename `paginate.js` to `paginate.ts` and use:

~~~typescript
import type { Title } from '$lib/types/catalog';
import type {
  ComicReaderPage,
  PageBox,
  PageBoxInput,
  PanelCell,
  PaperId,
  ReaderPage,
  ReadingAnchor,
  ScanReaderPage,
  TypefaceId
} from '$lib/types/reader';
import { COMIC_LAYOUTS } from './data/catalog';

export function pageBox({
  vw,
  vh,
  narrow,
  fontSize,
  chrome = 244
}: PageBoxInput): PageBox {
  let ph = Math.max(200, Math.min(620, vh - chrome));
  let pw = Math.round(ph * 0.73);
  const maxWidth = narrow ? vw - 44 : (vw - 96) / 2;
  if (pw > maxWidth) {
    pw = Math.max(220, maxWidth);
    ph = Math.round(pw / 0.73);
  }
  return {
    pw,
    ph,
    pad: Math.max(16, Math.round(pw * 0.105)),
    fs: Math.max(12, Math.min(fontSize, Math.round(pw / 19)))
  };
}

const cache = new WeakMap<Title, Map<string, ReaderPage[]>>();

export function paginate(title: Title | undefined, box: PageBox): ReaderPage[] {
  if (!title) return [];
  const key = `${box.pw}:${box.ph}:${box.pad}:${box.fs}:${title.chapters?.length ?? 0}:${title.pages ?? 0}`;
  let sizes = cache.get(title);
  if (!sizes) {
    sizes = new Map<string, ReaderPage[]>();
    cache.set(title, sizes);
  }
  const cached = sizes.get(key);
  if (cached) return cached;
  if (sizes.size > 8) sizes.clear();
  const pages = build(title, box);
  sizes.set(key, pages);
  return pages;
}

function build(title: Title, box: PageBox): ReaderPage[] {
  if (title.kind === 'comic') {
    const count = title.pages || 8;
    const names = title.pageNames ?? null;
    const wholePage = title.panelMode === 'off' || title.panelMode === 'manual';
    return Array.from({ length: count }, (_, index): ComicReaderPage => {
      const seedLayout = COMIC_LAYOUTS[index % COMIC_LAYOUTS.length] ?? COMIC_LAYOUTS[0];
      let layout: PanelCell[] = seedLayout.map((cell) => ({ ...cell }));
      if (names) {
        const name = names[index] ?? `page ${index + 1}`;
        layout = wholePage
          ? [{ c: 2, r: 2, cap: name }]
          : layout.map((cell, panelIndex) => ({
              c: cell.c,
              r: cell.r,
              cap: `${name} · panel ${panelIndex + 1}`
            }));
      }
      return {
        type: 'comic',
        chapter: 0,
        at: index,
        layout,
        folio: String(index + 1)
      };
    });
  }

  if (title.fixed) {
    const count = title.pages || 24;
    return Array.from({ length: count }, (_, index): ScanReaderPage => ({
      type: 'scan',
      chapter: 0,
      at: index,
      folio: String(index + 1),
      label: `${title.sourceFile ?? 'manuscript.pdf'} · page ${index + 1}`
    }));
  }

  const columns = Math.max(16, Math.floor((box.pw - box.pad * 2 - 6) / (box.fs * 0.505)));
  const rows = Math.max(6, Math.floor((box.ph - box.pad * 2 - 26) / (box.fs * 1.72)));
  const budget = columns * rows;
  const headingCost = columns * 3;
  const output: ReaderPage[] = [];

  (title.chapters ?? []).forEach((chapter, chapterIndex) => {
    let buffer: string[] = [];
    let length = 0;
    let first = true;
    let at = 0;
    const push = (): void => {
      output.push({
        type: 'text',
        chapter: chapterIndex,
        at,
        heading: first ? chapter.title : null,
        paras: buffer,
        folio: String(output.length + 1)
      });
      at += buffer.reduce((total, paragraph) => total + paragraph.length, 0);
      buffer = [];
      length = 0;
      first = false;
    };

    chapter.paras.forEach((paragraph) => {
      const cost =
        paragraph.length +
        columns * 0.5 +
        (first && buffer.length === 0 ? headingCost : 0);
      if (length + cost > budget && buffer.length > 0) push();
      buffer.push(paragraph);
      length += cost;
    });
    if (buffer.length > 0) push();
    if (output.length % 2 === 1) {
      output.push({
        type: 'text',
        chapter: chapterIndex,
        at,
        heading: null,
        paras: [],
        folio: String(output.length + 1)
      });
    }
  });

  while (output.length > 0) {
    const last = output[output.length - 1];
    if (last?.type === 'text' && !last.heading && last.paras.length === 0) output.pop();
    else break;
  }
  return output;
}

export function pageForAnchor(
  pages: readonly ReaderPage[],
  anchor: ReadingAnchor | null
): number {
  if (!anchor) return 0;
  let index = 0;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    if (!page) continue;
    if (
      page.chapter < anchor.chapter ||
      (page.chapter === anchor.chapter && page.at <= anchor.at)
    ) {
      index = pageIndex;
    } else {
      break;
    }
  }
  return index;
}

export function freeSheets(
  title: Title | undefined,
  pages: readonly ReaderPage[],
  per: number
): number {
  if (!title || title.kind === 'comic') {
    return Math.min(2, Math.ceil(pages.length / per));
  }
  if (title.fixed) {
    const previewPages =
      title.samplePages ?? Math.max(6, Math.round((title.pages ?? 24) * 0.1));
    return Math.max(
      1,
      Math.min(Math.ceil(pages.length / per), Math.ceil(previewPages / per))
    );
  }

  let last = 0;
  pages.forEach((page, index) => {
    if (page.chapter === 0) last = index;
  });
  if (per === 1) return last + 1;
  return last % 2 === 0 ? last / 2 : (last + 1) / 2;
}

interface PaperTheme {
  label: string;
  bg: string;
  ink: string;
}

interface Typeface {
  label: string;
  css: string;
}

export const PAPERS: Record<PaperId, PaperTheme> = {
  white: { label: 'White', bg: '#f7f5f1', ink: '#25211c' },
  sepia: { label: 'Sepia', bg: '#efe2c8', ink: '#3a2f21' },
  dim: { label: 'Dim', bg: '#2a2926', ink: '#cfc9be' }
};

export const TYPEFACES: Record<TypefaceId, Typeface> = {
  serif: { label: 'Newsreader', css: "'Newsreader', Georgia, serif" },
  sans: { label: 'Plex Sans', css: "'IBM Plex Sans', system-ui, sans-serif" },
  georgia: { label: 'Georgia', css: "Georgia, 'Times New Roman', serif" }
};
~~~

Do not use a non-null assertion for array access; the implementation above supplies or checks every fallback required by `noUncheckedIndexedAccess`.

- [ ] **Step 4: Update pagination import specifiers**

Change `$lib/paginate.js` to `$lib/paginate` in exactly:

~~~text
src/lib/components/BookReader.svelte
src/lib/components/PageFace.svelte
src/routes/library/+page.svelte
~~~

- [ ] **Step 5: Run pagination tests and the production build**

Run:

~~~powershell
npm test -- src/lib/paginate.test.ts
npx tsc --noEmit
npm run build
~~~

Expected: all four pagination tests pass and the build exits 0 with the same UI warnings still isolated to unconverted Svelte components.

- [ ] **Step 6: Commit pagination independently**

Run:

~~~powershell
git add src/lib/paginate.ts src/lib/paginate.test.ts src/lib/components/BookReader.svelte src/lib/components/PageFace.svelte src/routes/library/+page.svelte
git add -u src/lib/paginate.js
git commit -m "refactor: migrate pagination to TypeScript"
~~~

## Task 5: Extract manuscript parsing and migrate client stores

**Files:**

- Create: `src/lib/data/manuscript.ts`
- Create: `src/lib/data/manuscript.test.ts`
- Create: `src/lib/utils/persistence.ts`
- Create: `src/lib/utils/persistence.test.ts`
- Rename: `src/lib/stores/library.svelte.js` to `src/lib/stores/library.svelte.ts`
- Rename: `src/lib/stores/session.svelte.js` to `src/lib/stores/session.svelte.ts`
- Rename: `src/lib/stores/theme.svelte.js` to `src/lib/stores/theme.svelte.ts`
- Rename: `src/lib/stores/titles.svelte.js` to `src/lib/stores/titles.svelte.ts`
- Modify all component and route imports of those four stores

- [ ] **Step 1: Write failing tests for manuscript and persisted JSON behavior**

Create `src/lib/data/manuscript.test.ts`:

~~~typescript
import { describe, expect, it } from 'vitest';
import { parseManuscript } from './manuscript';

describe('parseManuscript', () => {
  it('uses markdown chapter headings as titles', () => {
    expect(parseManuscript('## One\nFirst paragraph\n## Two\nSecond paragraph')).toEqual([
      { title: 'One', paras: ['First paragraph'] },
      { title: 'Two', paras: ['Second paragraph'] }
    ]);
  });

  it('supplies a chapter name when no heading is present', () => {
    expect(parseManuscript('Opening paragraph')).toEqual([
      { title: 'Chapter 1', paras: ['Opening paragraph'] }
    ]);
  });
});
~~~

Create `src/lib/utils/persistence.test.ts`:

~~~typescript
import { describe, expect, it } from 'vitest';
import { isRecord, parseStoredJson, readNumberRecord, readStringArray } from './persistence';

describe('persistence decoders', () => {
  it('returns undefined instead of leaking malformed JSON', () => {
    expect(parseStoredJson('{broken')).toBeUndefined();
  });

  it('narrows records and arrays without trusting JSON.parse', () => {
    expect(isRecord({ id: 'salt' })).toBe(true);
    expect(readStringArray(['salt', 1])).toEqual([]);
    expect(readNumberRecord({ salt: 2, bad: '2' })).toEqual({});
  });
});
~~~

- [ ] **Step 2: Run both tests to verify the modules are missing**

Run:

~~~powershell
npm test -- src/lib/data/manuscript.test.ts src/lib/utils/persistence.test.ts
~~~

Expected: FAIL because both implementation modules are absent.

- [ ] **Step 3: Extract manuscript parsing**

Create `src/lib/data/manuscript.ts`:

~~~typescript
import type { Chapter } from '$lib/types/catalog';

export function parseManuscript(text: string): Chapter[] {
  const parsed: Chapter[] = [];
  text.split(/\n(?=##\s)/).forEach((block) => {
    const lines = block.split('\n').filter((line) => line.trim());
    if (lines.length === 0) return;

    const first = lines[0];
    let title = 'Chapter ' + (parsed.length + 1);
    let body = lines;
    if (first !== undefined && /^##\s/.test(first)) {
      title = first.replace(/^##\s*/, '');
      body = lines.slice(1);
    }
    parsed.push({ title, paras: body });
  });
  return parsed;
}
~~~

Remove `parseManuscript` from the title store and import it from `$lib/data/manuscript` in `src/routes/studio/+page.svelte`.

- [ ] **Step 4: Implement safe persistence decoders**

Create `src/lib/utils/persistence.ts`:

~~~typescript
import type { ReadingAnchor } from '$lib/types/reader';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStoredJson(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

export function readNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.values(value).every((item) => typeof item === 'number')
    ? (value as Record<string, number>)
    : {};
}

export function readNumberArrayRecord(value: unknown): Record<string, number[]> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => Array.isArray(item) && item.every((part) => typeof part === 'number'))) {
    return {};
  }
  return Object.fromEntries(entries) as Record<string, number[]>;
}

export function readAnchorRecord(value: unknown): Record<string, ReadingAnchor> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value);
  if (
    !entries.every(
      ([, item]) =>
        isRecord(item) && typeof item.chapter === 'number' && typeof item.at === 'number'
    )
  ) {
    return {};
  }
  return Object.fromEntries(entries) as Record<string, ReadingAnchor>;
}
~~~

The assertions occur only after complete runtime validation of every entry; no unvalidated parsed value is cast.

- [ ] **Step 5: Rename and type the session and theme stores**

In `session.svelte.ts`, use:

~~~typescript
import { browser } from '$app/environment';
import type { SessionUser } from '$lib/types/auth';
import { isRecord, parseStoredJson } from '$lib/utils/persistence';

const KEY = 'paleorbit.session';

class SessionStore {
  user = $state<SessionUser | null>(null);

  constructor() {
    if (!browser) return;
    const value = parseStoredJson(localStorage.getItem(KEY));
    if (isRecord(value) && typeof value.email === 'string') {
      this.user = { email: value.email };
    }
  }

  signIn(email: string): void {
    this.user = { email };
    if (browser) localStorage.setItem(KEY, JSON.stringify(this.user));
  }

  signOut(): void {
    this.user = null;
    if (browser) localStorage.removeItem(KEY);
  }
}

export const session = new SessionStore();
~~~

Create `theme.svelte.ts`:

~~~typescript
import { browser } from '$app/environment';

const KEY = 'paleorbit.theme';
export type ThemeId = 'nocturne' | 'vellum';

export const THEMES = [
  { id: 'nocturne', label: 'Nocturne', chip: 'oklch(0.18 0.018 262)' },
  { id: 'vellum', label: 'Vellum', chip: 'oklch(0.955 0.012 88)' }
] as const satisfies readonly { id: ThemeId; label: string; chip: string }[];

function isThemeId(value: string | null): value is ThemeId {
  return value === 'nocturne' || value === 'vellum';
}

class ThemeStore {
  current = $state<ThemeId>('nocturne');

  constructor() {
    if (!browser) return;
    const saved = localStorage.getItem(KEY);
    if (isThemeId(saved)) this.current = saved;
    this.apply();
  }

  set(id: ThemeId): void {
    this.current = id;
    if (!browser) return;
    localStorage.setItem(KEY, id);
    this.apply();
  }

  apply(): void {
    document.documentElement.dataset.theme = this.current;
  }
}

export const theme = new ThemeStore();
~~~

- [ ] **Step 6: Rename and type the title store**

Create `titles.svelte.ts`:

~~~typescript
import { browser } from '$app/environment';
import { CATALOG } from '$lib/data/catalog';
import type { Title } from '$lib/types/catalog';
import {
  isRecord,
  parseStoredJson,
  readStringArray
} from '$lib/utils/persistence';

const KEY = 'paleorbit.titles';
const HIDDEN_KEY = 'paleorbit.titles.hidden';

function isTitle(value: unknown): value is Title {
  if (!isRecord(value)) return false;
  const optionalString =
    (candidate: unknown): boolean => candidate === undefined || candidate === null || typeof candidate === 'string';
  const optionalNumber =
    (candidate: unknown): boolean => candidate === undefined || typeof candidate === 'number';
  const baseIsValid =
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.author === 'string' &&
    typeof value.price === 'number' &&
    typeof value.released === 'string' &&
    typeof value.cover === 'number' &&
    typeof value.summary === 'string' &&
    optionalString(value.coverUrl);
  if (!baseIsValid) return false;
  if (value.kind === 'comic') {
    return (
      typeof value.pages === 'number' &&
      (value.pageNames === undefined ||
        (Array.isArray(value.pageNames) &&
          value.pageNames.every((name) => typeof name === 'string'))) &&
      (value.direction === undefined || value.direction === 'ltr' || value.direction === 'rtl') &&
      (value.panelMode === undefined ||
        value.panelMode === 'auto' ||
        value.panelMode === 'manual' ||
        value.panelMode === 'off')
    );
  }
  if (value.kind !== 'novel') return false;
  return (
    (value.chapters === undefined ||
      (Array.isArray(value.chapters) &&
        value.chapters.every(
          (chapter) =>
            isRecord(chapter) &&
            typeof chapter.title === 'string' &&
            Array.isArray(chapter.paras) &&
            chapter.paras.every((paragraph) => typeof paragraph === 'string')
        ))) &&
    (value.fixed === undefined || typeof value.fixed === 'boolean') &&
    optionalNumber(value.pages) &&
    optionalString(value.sourceFile) &&
    optionalNumber(value.samplePages)
  );
}

class TitleStore {
  added = $state<Title[]>([]);
  hidden = $state<string[]>([]);

  constructor() {
    if (!browser) return;
    const added = parseStoredJson(localStorage.getItem(KEY));
    this.added = Array.isArray(added) ? added.filter(isTitle) : [];
    this.hidden = readStringArray(parseStoredJson(localStorage.getItem(HIDDEN_KEY)));
  }

  get all(): Title[] {
    return [...this.added, ...CATALOG].filter((title) => !this.hidden.includes(title.id));
  }

  get(id: string): Title | undefined {
    return this.all.find((title) => title.id === id);
  }

  publish(title: Title): void {
    this.added = [title, ...this.added];
    this.#persist();
  }

  remove(id: string): void {
    if (this.added.some((title) => title.id === id)) {
      this.added = this.added.filter((title) => title.id !== id);
    } else if (!this.hidden.includes(id)) {
      this.hidden = [...this.hidden, id];
    }
    this.#persist();
  }

  restoreAll(): void {
    this.hidden = [];
    this.#persist();
  }

  #persist(): void {
    if (!browser) return;
    localStorage.setItem(KEY, JSON.stringify(this.added));
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(this.hidden));
  }
}

export const titles = new TitleStore();
~~~

- [ ] **Step 7: Rename and type the library store**

Create `library.svelte.ts` with the existing key and this typed implementation:

~~~typescript
import { browser } from '$app/environment';
import type {
  PaperId,
  ReaderPreferences,
  ReadingAnchor,
  TypefaceId
} from '$lib/types/reader';
import {
  isRecord,
  parseStoredJson,
  readAnchorRecord,
  readNumberArrayRecord,
  readNumberRecord,
  readStringArray
} from '$lib/utils/persistence';

const KEY = 'paleorbit.library';

function isPaper(value: unknown): value is PaperId {
  return value === 'white' || value === 'sepia' || value === 'dim';
}

function isTypeface(value: unknown): value is TypefaceId {
  return value === 'serif' || value === 'sans' || value === 'georgia';
}

class LibraryStore {
  owned = $state<string[]>([]);
  progress = $state<Record<string, number>>({});
  anchors = $state<Record<string, ReadingAnchor>>({});
  bookmarks = $state<Record<string, number[]>>({});
  prefs = $state<ReaderPreferences>({
    fontSize: 18,
    typeface: 'serif',
    paper: 'white'
  });

  constructor() {
    if (!browser) return;
    const value = parseStoredJson(localStorage.getItem(KEY));
    if (!isRecord(value)) return;
    this.owned = readStringArray(value.owned);
    this.progress = readNumberRecord(value.progress);
    this.anchors = readAnchorRecord(value.anchors);
    this.bookmarks = readNumberArrayRecord(value.bookmarks);
    if (isRecord(value.prefs)) {
      this.prefs = {
        fontSize: typeof value.prefs.fontSize === 'number' ? value.prefs.fontSize : this.prefs.fontSize,
        typeface: isTypeface(value.prefs.typeface) ? value.prefs.typeface : this.prefs.typeface,
        paper: isPaper(value.prefs.paper) ? value.prefs.paper : this.prefs.paper
      };
    }
  }

  save(): void {
    if (!browser) return;
    localStorage.setItem(
      KEY,
      JSON.stringify({
        owned: this.owned,
        progress: this.progress,
        anchors: this.anchors,
        bookmarks: this.bookmarks,
        prefs: this.prefs
      })
    );
  }

  owns(id: string): boolean {
    return this.owned.includes(id);
  }

  grant(id: string): void {
    if (!this.owns(id)) this.owned = [...this.owned, id];
    this.save();
  }

  setProgress(id: string, sheet: number, anchor: ReadingAnchor | null): void {
    this.progress = { ...this.progress, [id]: sheet };
    if (anchor) this.anchors = { ...this.anchors, [id]: anchor };
    this.save();
  }

  anchorFor(id: string): ReadingAnchor | null {
    return this.anchors[id] ?? null;
  }

  bookmarksFor(id: string): number[] {
    return this.bookmarks[id] ?? [];
  }

  toggleBookmark(id: string, sheet: number): void {
    const list = this.bookmarksFor(id);
    const next = list.includes(sheet)
      ? list.filter((value) => value !== sheet)
      : [...list, sheet].sort((left, right) => left - right);
    this.bookmarks = { ...this.bookmarks, [id]: next };
    this.save();
  }

  setPref<Key extends keyof ReaderPreferences>(
    key: Key,
    value: ReaderPreferences[Key]
  ): void {
    this.prefs = { ...this.prefs, [key]: value };
    this.save();
  }
}

export const library = new LibraryStore();
~~~

- [ ] **Step 8: Update all store import specifiers**

Remove the `.js` suffix from store imports in:

~~~text
src/lib/components/AuthModal.svelte
src/lib/components/BookReader.svelte
src/lib/components/Header.svelte
src/routes/+page.svelte
src/routes/book/[id]/+page.svelte
src/routes/catalog/+page.svelte
src/routes/checkout/[id]/+page.svelte
src/routes/checkout/success/+page.svelte
src/routes/library/+page.svelte
src/routes/read/[id]/+page.svelte
src/routes/studio/+page.svelte
~~~

- [ ] **Step 9: Verify pure behavior, types, and build**

Run:

~~~powershell
npm test -- src/lib/data/manuscript.test.ts src/lib/utils/persistence.test.ts
npx tsc --noEmit
npm run build
~~~

Expected: four tests pass, all four stores compile as `.svelte.ts`, and the application builds.

- [ ] **Step 10: Commit client-state migration**

Run:

~~~powershell
git add src/lib/data/manuscript.ts src/lib/data/manuscript.test.ts src/lib/utils src/lib/stores src/lib/components src/routes
git commit -m "refactor: migrate client stores to TypeScript"
~~~

## Task 6: Type server seams and API routes

**Files:**

- Create: `src/lib/types/api.ts`
- Create: `src/lib/types/api.test.ts`
- Create: `src/lib/utils/errors.ts`
- Create: `src/lib/utils/errors.test.ts`
- Rename: `src/hooks.server.js` to `src/hooks.server.ts`
- Rename: `src/lib/server/db.js` to `src/lib/server/db.ts`
- Rename: `src/lib/server/mail.js` to `src/lib/server/mail.ts`
- Rename: `src/routes/api/checkout/+server.js` to `src/routes/api/checkout/+server.ts`
- Rename: `src/routes/api/deliver/+server.js` to `src/routes/api/deliver/+server.ts`
- Rename: `src/routes/api/stripe-webhook/+server.js` to `src/routes/api/stripe-webhook/+server.ts`

- [ ] **Step 1: Write failing request-guard and unknown-error tests**

Create `src/lib/types/api.test.ts`:

~~~typescript
import { describe, expect, it } from 'vitest';
import { parseCheckoutRequest, parseDeliveryRequest } from './api';

describe('API request guards', () => {
  it('accepts a complete checkout request', () => {
    expect(parseCheckoutRequest({ titleId: 'salt', email: 'reader@example.com', emailCopy: true })).toEqual({
      titleId: 'salt',
      email: 'reader@example.com',
      emailCopy: true
    });
  });

  it('rejects malformed checkout and delivery payloads', () => {
    expect(parseCheckoutRequest({ titleId: 1 })).toBeNull();
    expect(parseDeliveryRequest({ titleId: 'salt', channel: 'fax' })).toBeNull();
  });
});
~~~

Create `src/lib/utils/errors.test.ts`:

~~~typescript
import { describe, expect, it } from 'vitest';
import { messageFromUnknown } from './errors';

describe('messageFromUnknown', () => {
  it('uses Error messages and hides non-Error values', () => {
    expect(messageFromUnknown(new Error('offline'))).toBe('offline');
    expect(messageFromUnknown('secret value')).toBe('Unexpected error');
  });
});
~~~

- [ ] **Step 2: Run tests to verify the implementations are absent**

Run:

~~~powershell
npm test -- src/lib/types/api.test.ts src/lib/utils/errors.test.ts
~~~

Expected: FAIL because `api.ts` and `errors.ts` do not exist.

- [ ] **Step 3: Implement API contracts and runtime guards**

Create `src/lib/types/api.ts`:

~~~typescript
import { isRecord } from '$lib/utils/persistence';

export interface CheckoutRequest {
  titleId: string;
  email: string;
  emailCopy: boolean;
}

export type CheckoutResponse = { url: string } | { message: string };
export type DeliveryChannel = 'email' | 'download';

export interface DeliveryRequest {
  titleId: string;
  channel: DeliveryChannel;
}

export function parseCheckoutRequest(value: unknown): CheckoutRequest | null {
  if (
    !isRecord(value) ||
    typeof value.titleId !== 'string' ||
    typeof value.email !== 'string' ||
    typeof value.emailCopy !== 'boolean'
  ) {
    return null;
  }
  return { titleId: value.titleId, email: value.email, emailCopy: value.emailCopy };
}

export function parseDeliveryRequest(value: unknown): DeliveryRequest | null {
  if (
    !isRecord(value) ||
    typeof value.titleId !== 'string' ||
    (value.channel !== 'email' && value.channel !== 'download')
  ) {
    return null;
  }
  return { titleId: value.titleId, channel: value.channel };
}

export function isCheckoutResponse(value: unknown): value is CheckoutResponse {
  return (
    isRecord(value) &&
    (typeof value.url === 'string' || typeof value.message === 'string')
  );
}
~~~

Create `src/lib/utils/errors.ts`:

~~~typescript
export function messageFromUnknown(value: unknown): string {
  return value instanceof Error ? value.message : 'Unexpected error';
}
~~~

- [ ] **Step 4: Convert the hook and server seams**

Create `src/hooks.server.ts`:

~~~typescript
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
  const email = event.cookies.get('po_session') ?? null;
  event.locals.user = email ? { email } : null;
  return resolve(event);
};
~~~

Create `src/lib/server/db.ts`:

~~~typescript
interface GrantPurchaseInput {
  email: string;
  titleId: string;
  amount: number | null;
  stripeSessionId: string;
}

interface SaveProgressInput {
  email: string;
  titleId: string;
  sheet: number;
}

const purchases = new Map<string, Set<string>>();

export async function grantPurchase({
  email,
  titleId,
  amount,
  stripeSessionId
}: GrantPurchaseInput): Promise<void> {
  if (!email || !titleId) return;
  const owned = purchases.get(email) ?? new Set<string>();
  owned.add(titleId);
  purchases.set(email, owned);
  console.log('[db] granted', { email, titleId, amount, stripeSessionId });
}

export async function entitlementsFor(email: string): Promise<string[]> {
  return [...(purchases.get(email) ?? [])];
}

export async function saveProgress({
  email,
  titleId,
  sheet
}: SaveProgressInput): Promise<void> {
  console.log('[db] progress', { email, titleId, sheet });
}

export async function progressFor(_email: string): Promise<Record<string, number>> {
  return {};
}
~~~

Create `src/lib/server/mail.ts`:

~~~typescript
import { env } from '$env/dynamic/private';

interface BuiltEpub {
  filename: string;
  buffer: Buffer;
}

interface SendBookEmailInput {
  email: string;
  titleId: string;
}

export async function buildEpub(_titleId: string): Promise<BuiltEpub> {
  throw new Error('buildEpub not implemented — see the approved full-stack design');
}

export async function sendBookEmail({
  email,
  titleId
}: SendBookEmailInput): Promise<void> {
  if (!env.MAIL_API_KEY) {
    console.log('[mail] MAIL_API_KEY unset — would send', titleId, 'to', email);
    return;
  }

  console.log('[mail] provider adapter not wired — would send', titleId, 'to', email);
}
~~~

- [ ] **Step 5: Convert checkout and delivery endpoints**

Create `src/routes/api/checkout/+server.ts`:

~~~typescript
import type { RequestHandler } from './$types';
import Stripe from 'stripe';
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import { CATALOG } from '$lib/data/catalog';
import { parseCheckoutRequest } from '$lib/types/api';

export const POST: RequestHandler = async ({ request, url }) => {
  const raw: unknown = await request.json();
  const body = parseCheckoutRequest(raw);
  if (!body) throw error(400, 'Invalid checkout request');

  const title = CATALOG.find((candidate) => candidate.id === body.titleId);
  if (!title) throw error(404, 'Unknown title');
  if (!env.STRIPE_SECRET_KEY) {
    return json({ message: 'Stripe is not configured' }, { status: 503 });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: body.email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(title.price * 100),
          product_data: {
            name: title.title,
            description: title.summary
          }
        }
      }
    ],
    metadata: {
      titleId: title.id,
      emailCopy: body.emailCopy ? '1' : '0'
    },
    automatic_tax: { enabled: false },
    success_url: `${url.origin}/checkout/success?title=${title.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/book/${title.id}`
  });

  if (!session.url) throw error(502, 'Stripe did not return a checkout URL');
  return json({ url: session.url });
};
~~~

Create `src/routes/api/deliver/+server.ts`:

~~~typescript
import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { entitlementsFor } from '$lib/server/db';
import { sendBookEmail } from '$lib/server/mail';
import { parseDeliveryRequest } from '$lib/types/api';

export const POST: RequestHandler = async ({ request, locals }) => {
  const raw: unknown = await request.json();
  const body = parseDeliveryRequest(raw);
  if (!body) throw error(400, 'Invalid delivery request');

  const email = locals.user?.email;
  if (!email) throw error(401, 'Sign in first');

  const owned = await entitlementsFor(email);
  if (!owned.includes(body.titleId)) throw error(403, 'Not in your library');

  if (body.channel === 'email') {
    await sendBookEmail({ email, titleId: body.titleId });
    return json({ ok: true, sent: true });
  }

  return json({
    ok: true,
    url: `/files/${body.titleId}.epub?token=…`
  });
};
~~~

- [ ] **Step 6: Convert the Stripe webhook endpoint safely**

Create `src/routes/api/stripe-webhook/+server.ts`:

~~~typescript
import type { RequestHandler } from './$types';
import Stripe from 'stripe';
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import { grantPurchase } from '$lib/server/db';
import { sendBookEmail } from '$lib/server/mail';
import { messageFromUnknown } from '$lib/utils/errors';

export const POST: RequestHandler = async ({ request }) => {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    throw error(503, 'Stripe is not configured');
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const signature = request.headers.get('stripe-signature');
  if (!signature) throw error(400, 'Missing Stripe signature');
  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (cause: unknown) {
    throw error(400, `Signature verification failed: ${messageFromUnknown(cause)}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const titleId = session.metadata?.titleId;
    const email = session.customer_details?.email ?? session.customer_email;
    if (!titleId || !email) {
      console.error('[stripe] completed checkout missing title or email', { sessionId: session.id });
      return json({ received: true });
    }

    await grantPurchase({
      email,
      titleId,
      amount: session.amount_total,
      stripeSessionId: session.id
    });

    if (session.metadata?.emailCopy === '1') {
      await sendBookEmail({ email, titleId });
    }
  }

  return json({ received: true });
};
~~~

- [ ] **Step 7: Update renamed server imports**

Remove `.js` from imports of `$lib/server/db` and `$lib/server/mail` in the three endpoint files.

- [ ] **Step 8: Run server-focused tests and strict checks**

Run:

~~~powershell
npm test -- src/lib/types/api.test.ts src/lib/utils/errors.test.ts
npx tsc --noEmit
npm run check
npm run build
~~~

Expected: three new tests pass; hooks, server seams, and all three endpoints type-check; the production build exits 0.

- [ ] **Step 9: Commit server migration separately**

Run:

~~~powershell
git add src/hooks.server.ts src/lib/server src/lib/types/api.ts src/lib/types/api.test.ts src/lib/utils/errors.ts src/lib/utils/errors.test.ts src/routes/api
git add -u src/hooks.server.js
git commit -m "refactor: type prototype server routes"
~~~

## Task 7: Type shared Svelte components and remove their warnings

**Files:**

- Modify: `src/lib/components/AuthModal.svelte`
- Modify: `src/lib/components/BookVolume.svelte`
- Modify: `src/lib/components/CoverArt.svelte`
- Modify: `src/lib/components/Header.svelte`
- Modify: `src/lib/components/PageFace.svelte`
- Modify: `src/routes/+layout.svelte`

- [ ] **Step 1: Enable TypeScript in the six component scripts**

Change each opening script tag to:

~~~svelte
<script lang="ts">
~~~

- [ ] **Step 2: Type AuthModal, CoverArt, and Header props**

Use these contracts:

~~~typescript
// AuthModal.svelte
type AuthMode = 'signin' | 'magic';
interface Props {
  open?: boolean;
  onclose?: () => void;
}
let { open = false, onclose }: Props = $props();
let mode = $state<AuthMode>('signin');
function oauth(_provider: 'google' | 'apple'): void;

// CoverArt.svelte
interface Props {
  index?: number;
  src?: string | null | undefined;
  alt?: string;
  width?: string;
  height?: string;
  radius?: string;
}

// Header.svelte
interface Props {
  onsignin: () => void;
}
~~~

Retain the current default prop values and callback operations. The underscore on `_provider` documents that the prototype callback currently ignores which provider was clicked.

- [ ] **Step 3: Type PageFace props and indexed theme access**

Use:

~~~typescript
import type { PageBox, PaperId, ReaderPage, TypefaceId } from '$lib/types/reader';

interface Props {
  page?: ReaderPage | null | undefined;
  box: PageBox;
  paper?: PaperId;
  typeface?: TypefaceId;
  side?: 'front' | 'back';
}

let {
  page = null,
  box,
  paper = 'white',
  typeface = 'serif',
  side = 'front'
}: Props = $props();
~~~

Because `PAPERS` and `TYPEFACES` are keyed records, `PAPERS[paper]` and `TYPEFACES[typeface]` must type-check without assertions.

- [ ] **Step 4: Type BookVolume props and derived values**

Use:

~~~typescript
import type { Title } from '$lib/types/catalog';

interface Props {
  title: Title;
  width?: number;
  height?: number;
  depth?: number | null;
  pageCount?: number | null;
  flipped?: boolean;
  flipping?: boolean;
  tilt?: number;
  interactive?: boolean;
  onclick?: (() => void) | null;
  label?: string | null;
}
~~~

Type reducer accumulators as numbers. Replace possibly missing swatch access with:

~~~typescript
const pair = $derived(SWATCHES[title.cover % SWATCHES.length] ?? SWATCHES[0]);
~~~

Resolve the existing accessibility warning by adding a semantic role and reliable label to the non-button form:

~~~svelte
role={onclick ? 'button' : 'img'}
type={onclick ? 'button' : undefined}
aria-label={label ?? title.title}
~~~

Do not add a Svelte warning suppression.

- [ ] **Step 5: Type layout children as a Svelte snippet**

Use:

~~~typescript
import type { Snippet } from 'svelte';

interface Props {
  children: Snippet;
}

let { children }: Props = $props();
~~~

- [ ] **Step 6: Check only the converted component boundary**

Run:

~~~powershell
npx eslint src/lib/components/AuthModal.svelte src/lib/components/BookVolume.svelte src/lib/components/CoverArt.svelte src/lib/components/Header.svelte src/lib/components/PageFace.svelte src/routes/+layout.svelte
npm run check
npm run build
~~~

Expected: no errors in the converted components, the BookVolume accessibility warning is gone, and only the BookReader warnings remain.

- [ ] **Step 7: Commit the shared component conversion**

Run:

~~~powershell
git add src/lib/components/AuthModal.svelte src/lib/components/BookVolume.svelte src/lib/components/CoverArt.svelte src/lib/components/Header.svelte src/lib/components/PageFace.svelte src/routes/+layout.svelte
git commit -m "refactor: type shared Svelte components"
~~~

## Task 8: Type the reader and extract its pure easing function

**Files:**

- Create: `src/lib/reader/easing.ts`
- Create: `src/lib/reader/easing.test.ts`
- Modify: `src/lib/components/BookReader.svelte`

- [ ] **Step 1: Write failing easing characterization tests**

Create `src/lib/reader/easing.test.ts`:

~~~typescript
import { describe, expect, it } from 'vitest';
import { cubicBezier } from './easing';

describe('cubicBezier', () => {
  it('keeps the endpoints fixed', () => {
    const easing = cubicBezier(0.22, 0.61, 0.28, 1);
    expect(easing(0)).toBeCloseTo(0);
    expect(easing(1)).toBeCloseTo(1);
  });

  it('matches the prototype turn curve at the midpoint', () => {
    const easing = cubicBezier(0.22, 0.61, 0.28, 1);
    expect(easing(0.5)).toBeCloseTo(0.895, 2);
  });

  it('is monotonic across a page turn', () => {
    const easing = cubicBezier(0.16, 0.78, 0.32, 1);
    const samples = [0, 0.25, 0.5, 0.75, 1].map(easing);
    expect(samples).toEqual([...samples].sort((left, right) => left - right));
  });
});
~~~

- [ ] **Step 2: Run the easing test to verify it fails**

Run:

~~~powershell
npm test -- src/lib/reader/easing.test.ts
~~~

Expected: FAIL because `easing.ts` does not exist.

- [ ] **Step 3: Extract the existing cubic-bezier implementation**

Create `src/lib/reader/easing.ts`:

~~~typescript
import type { EasingFunction } from '$lib/types/reader';

export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): EasingFunction {
  const coefficientA = (start: number, end: number): number => 1 - 3 * end + 3 * start;
  const coefficientB = (start: number, end: number): number => 3 * end - 6 * start;
  const at = (time: number, start: number, end: number): number =>
    ((coefficientA(start, end) * time + coefficientB(start, end)) * time + 3 * start) * time;
  const slope = (time: number, start: number, end: number): number =>
    (3 * coefficientA(start, end) * time + 2 * coefficientB(start, end)) * time + 3 * start;

  return (position: number): number => {
    let time = position;
    for (let pass = 0; pass < 5; pass += 1) {
      const currentSlope = slope(time, x1, x2);
      if (currentSlope === 0) break;
      time -= (at(time, x1, x2) - position) / currentSlope;
    }
    return at(time, y1, y2);
  };
}
~~~

Replace the local `bezier` function in `BookReader.svelte` with:

~~~typescript
import { cubicBezier } from '$lib/reader/easing';

const easeTurn = cubicBezier(0.22, 0.61, 0.28, 1);
const easeDrop = cubicBezier(0.16, 0.78, 0.32, 1);
const easeBack = cubicBezier(0.3, 0.86, 0.45, 1);
~~~

- [ ] **Step 4: Enable TypeScript and type the reader boundary**

Change the script tag to `<script lang="ts">` and replace the JSDoc/`any` prop declaration with:

~~~typescript
import type {
  EasingFunction,
  ReaderPhase,
  ReaderProps,
  ReadingAnchor,
  SheetView,
  TurnDirection,
  TurnProgress
} from '$lib/types/reader';

let { title, sample = false, onclose, onbuy }: ReaderProps = $props();
~~~

- [ ] **Step 5: Type state, timers, and initial values**

Use:

~~~typescript
const initialSheet = untrack(() => library.progress[title.id] ?? 0);
let sheet = $state(initialSheet);
let phase = $state<ReaderPhase>(initialSheet > 0 ? 'reading' : 'closed');
let flipped = $state(false);
let flipping = $state(false);
let flipTimer: ReturnType<typeof setTimeout> | undefined;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let drag = $state<TurnProgress | null>(null);
let turning = $state<TurnProgress | null>(null);
let comicMode = $state<'page' | 'panel'>('page');
let pageIdx = $state<number | null>(null);
let panelIdx = $state(0);
let anchor: ReadingAnchor | null = untrack(() => library.anchorFor(title.id));
~~~

Wrapping the initial title-dependent reads in `untrack` documents that they intentionally initialize once and removes the Svelte capture warnings without suppressing them.

- [ ] **Step 6: Type the reader's collections and functions**

Apply these signatures:

~~~typescript
const sheets = $derived.by<SheetView[]>(() => {
  const list: SheetView[] = [];
  const turnProgress = drag ?? turning;
  for (let index = 0; index < totalSheets; index += 1) {
    const isFlipped = index < sheet;
    let angle = isFlipped ? -180 : 0;
    if (turnProgress?.dir === 1 && index === sheet) angle = -180 * turnProgress.t;
    if (turnProgress?.dir === -1 && index === sheet - 1) angle = -180 * (1 - turnProgress.t);
    const active = turnProgress !== null && (index === sheet || index === sheet - 1);
    const curl = Math.sin((Math.abs(angle) / 180) * Math.PI);
    const settled = turnProgress === null;
    list.push({
      k: index,
      angle,
      curl,
      active,
      z: active ? totalSheets + 3 : isFlipped ? index + 1 : totalSheets - index + 1,
      showFront: settled ? angle > -90 : true,
      showBack: settled ? angle <= -90 : true,
      front: pages[index * per] ?? null,
      back: per === 2 ? (pages[index * per + 1] ?? null) : null
    });
  }
  return list;
});

function commit(n: number): void;
function recordAnchor(): void;
function go(n: number): void;
function settleTurn(): void;
function runTurn(
  dir: TurnDirection,
  from: number,
  to: number,
  ease: EasingFunction,
  ms: number,
  land: boolean
): void;
function turn(dir: TurnDirection): void;
function turnPanel(dir: TurnDirection): void;
function jumpToChapter(ci: number): void;
~~~

Add the shown signatures to the existing function bodies without changing their state transitions or formulas. Type the local panel counter as `(pageNumber: number): number`.

- [ ] **Step 7: Type pointer and keyboard events without casting**

Use runtime narrowing for `currentTarget`:

~~~typescript
let fromSide: TurnDirection = 1;

function onPointerDown(event: PointerEvent): void {
  if (guided || phase !== 'reading' || turning) return;
  const target = event.currentTarget;
  if (!(target instanceof HTMLDivElement)) return;
  const rect = target.getBoundingClientRect();
  halfWidth = rect.width / per;
  startX = event.clientX;
  fromSide = event.clientX > rect.left + rect.width / 2 ? 1 : -1;
  target.setPointerCapture?.(event.pointerId);
  drag = { dir: fromSide, t: 0 };
}

function onPointerMove(event: PointerEvent): void;
function onPointerUp(): void;
function onKeydown(event: KeyboardEvent): void;
~~~

Add those signatures to the existing pointer-move, pointer-up, and keydown bodies.

- [ ] **Step 8: Resolve the interactive page accessibility warning**

Add a semantic role and label to the pointer-driven page region:

~~~svelte
<div
  class="book"
  role="application"
  tabindex="0"
  aria-label="Interactive pages for {title.title}; use arrow keys to turn pages"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
>
~~~

Keep the existing width, height, and padding style directives between those attributes.

- [ ] **Step 9: Run easing tests and reader checks**

Run:

~~~powershell
npm test -- src/lib/reader/easing.test.ts
npx eslint src/lib/components/BookReader.svelte src/lib/reader/easing.ts src/lib/reader/easing.test.ts
npm run check
npm run build
~~~

Expected: three easing tests pass, Svelte reports no BookReader capture or accessibility warnings, and the build exits 0.

- [ ] **Step 10: Commit the reader conversion**

Run:

~~~powershell
git add src/lib/reader src/lib/components/BookReader.svelte
git commit -m "refactor: migrate the book reader to TypeScript"
~~~

## Task 9: Type every route page and the Studio form

**Files:**

- Modify: `src/routes/+page.svelte`
- Modify: `src/routes/book/[id]/+page.svelte`
- Modify: `src/routes/catalog/+page.svelte`
- Modify: `src/routes/checkout/[id]/+page.svelte`
- Modify: `src/routes/checkout/success/+page.svelte`
- Modify: `src/routes/library/+page.svelte`
- Modify: `src/routes/read/[id]/+page.svelte`
- Modify: `src/routes/studio/+page.svelte`

- [ ] **Step 1: Enable TypeScript in all eight route scripts**

Change every opening script tag in the files above to:

~~~svelte
<script lang="ts">
~~~

- [ ] **Step 2: Narrow optional titles on home, detail, and reader routes**

On the home page, wrap the existing hero section in `{#if featured}` so an empty catalog does not dereference `undefined`. Do not change the contents of the hero.

In `book/[id]/+page.svelte`:

~~~typescript
function buy(): void {
  if (!title) return;
  if (owned) {
    void goto(`/read/${title.id}`);
    return;
  }
  void goto(`/checkout/${title.id}`);
}
~~~

The existing `{#if title}` blocks on the detail and read pages provide the remaining template narrowing. Prefix intentionally unawaited `goto` calls with `void`.

- [ ] **Step 3: Type catalog filtering**

In `catalog/+page.svelte`:

~~~typescript
import type { TitleKind } from '$lib/types/catalog';

type CatalogFilter = 'all' | TitleKind;
interface FilterOption {
  id: CatalogFilter;
  label: string;
}

let filter = $state<CatalogFilter>('all');
const filters: FilterOption[] = [
  { id: 'all', label: 'Everything' },
  { id: 'novel', label: 'Novels' },
  { id: 'comic', label: 'Comics' }
];
~~~

- [ ] **Step 4: Type checkout state and unknown network responses**

In `checkout/[id]/+page.svelte`, import `isCheckoutResponse` and `messageFromUnknown`. Narrow both the title and response:

~~~typescript
async function payWithStripe(): Promise<void> {
  if (!title) {
    error = 'This title is unavailable.';
    return;
  }
  if (!email) {
    error = 'Add an email for the receipt and delivery.';
    return;
  }

  busy = true;
  error = '';
  try {
    const response = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ titleId: title.id, email, emailCopy })
    });
    const data: unknown = await response.json();
    if (isCheckoutResponse(data) && 'url' in data) {
      window.location.assign(data.url);
      return;
    }
    const message = isCheckoutResponse(data) && 'message' in data
      ? data.message
      : 'Checkout unavailable';
    throw new Error(message);
  } catch (cause: unknown) {
    error = messageFromUnknown(cause) + ' — granting locally for development.';
    grantLocally();
  } finally {
    busy = false;
  }
}

function grantLocally(): void {
  if (!title) return;
  library.grant(title.id);
  if (!session.user) session.signIn(email);
  void goto(`/checkout/success?title=${title.id}`);
}
~~~

- [ ] **Step 5: Type library callbacks and delivery channels**

In `library/+page.svelte`:

~~~typescript
import type { Title } from '$lib/types/catalog';
import type { DeliveryChannel } from '$lib/types/api';

let toast = $state('');
let pullingId = $state<string | null>(null);
let pulled = false;

function pull(title: Title): void {
  if (pullingId) return;
  pullingId = title.id;
  pulled = false;
  setTimeout(() => open(title), 940);
}

function open(title: Title): void {
  if (pulled) return;
  pulled = true;
  void goto(`/read/${title.id}`);
}

function pct(title: Title): number {
  const pages = paginate(title, box);
  const total = Math.max(1, Math.ceil(pages.length / 2));
  return Math.min(
    100,
    Math.round(((library.progress[title.id] ?? 0) / total) * 100)
  );
}

function flash(message: string): void {
  toast = message;
  setTimeout(() => {
    toast = '';
  }, 2600);
}

async function deliver(title: Title, channel: DeliveryChannel): Promise<void> {
  flash(
    channel === 'email'
      ? `Sent — check your inbox for ${title.title}`
      : `${title.title}.epub — download started`
  );
}
~~~

This keeps the current 940 ms shelf animation, 2600 ms toast duration, and prototype delivery messages.

- [ ] **Step 6: Define the complete Studio form types**

At the top of `studio/+page.svelte` add:

~~~typescript
import type {
  PanelMode,
  ReadingDirection,
  Title,
  TitleKind
} from '$lib/types/catalog';

type NovelSource = 'paste' | 'file';
type NovelRenderMode = 'reflow' | 'fixed';

interface StudioForm {
  kind: TitleKind;
  title: string;
  price: string;
  summary: string;
  cover: number;
  source: NovelSource;
  body: string;
  file: string;
  render: NovelRenderMode;
  samplePages: string;
  pages: string[];
  direction: ReadingDirection;
  panelMode: PanelMode;
  coverUrl: string;
  coverName: string;
}

interface Choice<Value extends string> {
  id: Value;
  label: string;
  note: string;
}

let form = $state<StudioForm>({
  kind: 'novel',
  title: '',
  price: '',
  summary: '',
  cover: 0,
  source: 'paste',
  body: '',
  file: '',
  render: 'reflow',
  samplePages: '10',
  pages: [],
  direction: 'ltr',
  panelMode: 'auto',
  coverUrl: '',
  coverName: ''
});
~~~

Type `KINDS` as `Choice<TitleKind>[]`, `RENDER_MODES` as `Choice<NovelRenderMode>[]`, and `PANEL_HINTS` as `Record<PanelMode, string>`.

- [ ] **Step 7: Type Studio file events through DOM narrowing**

Each file callback accepts `Event` and narrows `currentTarget`:

~~~typescript
function inputFrom(event: Event): HTMLInputElement | null {
  return event.currentTarget instanceof HTMLInputElement ? event.currentTarget : null;
}

function onManuscriptFile(event: Event): void {
  const input = inputFrom(event);
  const file = input?.files?.[0];
  if (!file) return;
  form.file = file.name;
  if (!/\.pdf$/i.test(file.name)) form.render = 'reflow';
}

function onCoverFile(event: Event): void {
  const input = inputFrom(event);
  const file = input?.files?.[0];
  if (!file) return;
  form.coverUrl = URL.createObjectURL(file);
  form.coverName = file.name;
}

function onComicFiles(event: Event): void {
  const input = inputFrom(event);
  const names = Array.from(input?.files ?? []).map((file) => file.name);
  if (names.length > 0) form.pages = [...form.pages, ...names];
}
~~~

- [ ] **Step 8: Construct a discriminated Title in Studio**

Replace the current object containing explicit `undefined` values with:

~~~typescript
function publish(): void {
  if (!form.title) {
    note = 'A title is required.';
    return;
  }
  if (form.kind === 'comic' && form.pages.length === 0) {
    note = 'Upload at least one page of art.';
    return;
  }
  if (form.kind === 'novel' && form.source === 'file' && !form.file) {
    note = 'Choose a manuscript file, or paste the text instead.';
    return;
  }

  const fixed =
    form.kind === 'novel' &&
    form.source === 'file' &&
    form.render === 'fixed';
  const common = {
    id: 'u' + Date.now(),
    title: form.title,
    author: 'R. Vale Okonjo',
    price: Number.parseFloat(form.price) || 0,
    released: new Date().toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric'
    }),
    cover: form.cover,
    coverUrl: form.coverUrl || null,
    summary: form.summary || '—'
  };

  const nextTitle: Title =
    form.kind === 'comic'
      ? {
          ...common,
          kind: 'comic',
          pages: form.pages.length,
          pageNames: [...form.pages],
          direction: form.direction,
          panelMode: form.panelMode
        }
      : {
          ...common,
          kind: 'novel',
          fixed,
          ...(form.source === 'file' ? { sourceFile: form.file } : {}),
          ...(fixed
            ? {
                pages: 24,
                samplePages: Math.max(1, Number.parseInt(form.samplePages, 10) || 10)
              }
            : { chapters: parseManuscript(form.body) })
        };

  titles.publish(nextTitle);
  note =
    form.kind === 'comic'
      ? `Published — ${form.pages.length} pages${form.panelMode === 'auto' ? ', panels detected.' : '.'}`
      : fixed
        ? `Published — fixed-page edition from ${form.file}.`
        : "Published — it's live in the catalog.";
  form = {
    ...form,
    title: '',
    price: '',
    summary: '',
    body: '',
    file: '',
    pages: [],
    cover: 0,
    coverUrl: '',
    coverName: ''
  };
}
~~~

The conditional spreads satisfy `exactOptionalPropertyTypes` without setting optional fields to `undefined`.

- [ ] **Step 9: Type the success page effect and confirm inferred route collections**

In `checkout/success/+page.svelte`, keep `id` as `string | null` and use:

~~~typescript
$effect(() => {
  if (id !== null) library.grant(id);
});
~~~

The catalog `shown` and library `shelf` must infer as `Title[]` from `titles.all`. Hover or inspect both expressions in the editor; if either is not `Title[]`, correct the store getter rather than casting at the route.

- [ ] **Step 10: Run the full route check**

Run:

~~~powershell
npx eslint src/routes
npm run check
npm run test
npm run build
~~~

Expected: all tests pass, all 15 Svelte files have typed scripts, Svelte reports 0 errors and 0 warnings, and the production build exits 0.

- [ ] **Step 11: Commit all typed routes**

Run:

~~~powershell
git add src/routes
git commit -m "refactor: migrate Svelte routes to TypeScript"
~~~

## Task 10: Update documentation and enforce the Plan 0 quality gate

**Files:**

- Modify: `README.md`
- Modify: `docs/dependency-decisions.md` only if final registry/audit evidence changed
- Modify: a Plan 0 source file only to correct a failure exposed by the commands below

- [ ] **Step 1: Update README paths and commands**

Change every source reference from `.js`/`.svelte.js` to `.ts`/`.svelte.ts`, document Node 24 and these commands:

~~~markdown
## Development

Requirements: Node.js 24.15.x and npm 11.12.x.

```bash
npm install
npm run dev
```

Quality gates:

```bash
npm run check
npm run lint
npm run test
npm run build
npm run verify
```

The current frontend still uses prototype local state. Backend architecture and
delivery sequencing are defined in
`docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md`.
~~~

Remove the nonexistent `cp .env.example .env` instruction. Update the auth section to name Better Auth as the approved future adapter and state that third-party OAuth is outside the first backend release.

- [ ] **Step 2: Prove all application JavaScript was converted**

Run:

~~~powershell
$javascript = @(rg --files src -g '*.js')
if ($javascript.Count -gt 0) {
  $javascript
  throw 'JavaScript application source remains'
}

$untypedSvelte = @(rg -n '<script(?! lang="ts")' --pcre2 src -g '*.svelte')
if ($untypedSvelte.Count -gt 0) {
  $untypedSvelte
  throw 'Untyped Svelte scripts remain'
}
~~~

Expected: both arrays are empty. `svelte.config.js` and `eslint.config.js` are outside `src` and intentionally remain JavaScript configuration.

- [ ] **Step 3: Prove no broad TypeScript escape hatch remains**

Run:

~~~powershell
$escapes = @(rg -n '\bany\b|@ts-ignore|@ts-expect-error' src -g '*.ts' -g '*.svelte')
if ($escapes.Count -gt 0) {
  $escapes
  throw 'TypeScript escape hatch found'
}
~~~

Expected: no matches. Validated, narrow assertions in `persistence.ts` are allowed because the guards prove their shapes first; `any` and compiler suppressions are not.

- [ ] **Step 4: Run the complete automated verification**

Run:

~~~powershell
npm run verify
~~~

Expected:

- `svelte-check`: 0 errors and 0 warnings.
- ESLint: exit 0 with no errors.
- Vitest: 7 test files and 18 tests pass.
- adapter-node production build: exit 0 with no adapter-auto or configuration warning.

- [ ] **Step 5: Recheck dependency health**

Run:

~~~powershell
npm ls --depth=0
npm outdated
npm audit --audit-level=high
~~~

Expected: `npm ls` has no invalid/unmet peer dependency; audit has no high or critical issue. `npm outdated` may identify TypeScript 7 and a newer `@types/node` major because the documented compatibility/runtime pins are intentional. Every other direct lag must be upgraded or added to `docs/dependency-decisions.md` with evidence and a removal condition.

- [ ] **Step 6: Smoke-test preserved prototype behavior**

Run:

~~~powershell
npm run dev -- --host 127.0.0.1
~~~

Using the in-app browser, verify:

1. `/` renders the featured title and recent releases.
2. `/catalog` filters novels and comics.
3. `/book/salt` opens the free sample and checkout route.
4. `/read/salt?sample=1` opens, turns pages, changes reader preferences, and stops at the paywall.
5. `/read/vector?sample=1` switches between page and guided comic modes.
6. `/studio` accepts pasted prose and comic filenames and publishes a prototype title.
7. `/checkout/salt` reaches the local development grant when Stripe is not configured.
8. `/library` shows the granted title, progress, bookmarks, and delivery feedback.
9. Theme and prototype session state survive a reload.

Expected: no browser console error and no intended visual or interaction regression from the pre-migration prototype.

- [ ] **Step 7: Review the final diff for scope**

Run:

~~~powershell
git status --short
git diff --stat
git diff --check
~~~

Expected: only Plan 0 toolchain, TypeScript conversion, characterization tests, and documentation changes remain. No PostgreSQL, authentication provider, Docker, storage, or commerce redesign code appears.

- [ ] **Step 8: Commit final documentation or verification fixes**

Run:

~~~powershell
git add README.md docs/dependency-decisions.md src
git commit -m "docs: document the TypeScript development workflow"
~~~

If `git status --short` was already empty after Step 7 except for `README.md`, stage only `README.md`. Do not create an empty commit.

## Plan 0 completion evidence

Before claiming completion, capture and report:

- The final direct dependency versions from `npm ls --depth=0`.
- The intentional pins from `docs/dependency-decisions.md`.
- The exact `svelte-check` error/warning counts.
- The Vitest file/test counts.
- The ESLint and production-build exit codes.
- The npm audit high/critical counts.
- The JavaScript-source and untyped-Svelte scans.
- The nine manual smoke-test results.
- `git status --short` and the Plan 0 commit list.
