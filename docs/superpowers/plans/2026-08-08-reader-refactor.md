# Reader Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the interactive reader into focused, typed units and cap normal reading at five mounted sheet models without changing its public API or user-visible behavior.

**Architecture:** `BookReader.svelte` remains the single state owner and orchestration boundary. Pure helpers own geometry, sheet bounds, and bounded sheet-view construction; presentation components receive values and callbacks and do not access stores or pagination directly. The full pagination model remains in memory, while only sheets from `currentSheet - 2` through `currentSheet + 2` are derived and mounted.

**Tech Stack:** SvelteKit 2, Svelte 5 runes, TypeScript 6, Vitest 4, ESLint 10, Vite 8, npm 11, Node.js 26.

---

## Source documents and execution constraints

- Design: `docs/superpowers/specs/2026-08-08-reader-refactor-design.md`
- Backend roadmap: `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md`
- Stable pre-refactor source snapshot: commit `6f885ec`
- Run implementation in an isolated feature worktree created from `main`.
- Do not add dependencies. The current Vitest, Svelte check, ESLint, build, and manual browser workflow are sufficient.
- Preserve `BookReader`'s `title`, `sample`, `onclose`, and `onbuy` props.
- Preserve current markup and CSS verbatim during each mechanical extraction except for the explicit prop/callback substitutions in this plan.
- Do not refactor Studio, browser-backed stores, API stubs, pagination, or unrelated CSS.
- Keep `BookReader.svelte` as the only reader component that imports `library` or calls `paginate`.

## File structure

### New pure modules

- `src/lib/reader/geometry.ts` — calculate a physical book's depth from title kind and page count.
- `src/lib/reader/geometry.test.ts` — characterize comic and prose depth limits.
- `src/lib/reader/navigation.ts` — clamp sheet positions against book and preview limits.
- `src/lib/reader/navigation.test.ts` — characterize lower, upper, and preview bounds.
- `src/lib/reader/sheet-window.ts` — select the bounded set of absolute sheet indices and build their animated `SheetView` values.
- `src/lib/reader/sheet-window.test.ts` — characterize window bounds, animation values, preview exclusion, and large-book behavior.

### New presentation components

- `src/lib/components/reader/ReaderToolbar.svelte` — toolbar and progress rail.
- `src/lib/components/reader/ReaderDrawers.svelte` — contents, bookmarks, and preference drawers positioned inside the stage.
- `src/lib/components/reader/ReaderOpeningRig.svelte` — transitional opening/closing cover rig.
- `src/lib/components/reader/ReaderSpread.svelte` — bounded sheets, page faces, shading, slab, spine, and pointer surface.
- `src/lib/components/reader/ReaderGuidedPanel.svelte` — guided comic panel.
- `src/lib/components/reader/ReaderFooter.svelte` — closed-book and reading navigation footer.
- `src/lib/components/reader/ReaderPaywall.svelte` — preview-boundary overlay.

`ReaderDrawers.svelte` is a positioning-preserving refinement of the approved toolbar boundary. The drawers must remain descendants of `.stage` for their current absolute positioning, whereas the toolbar remains above `.stage`. Both components are stateless views controlled by `BookReader`.

### Existing files modified

- `src/lib/components/BookReader.svelte` — consume pure helpers, render the bounded window, orchestrate extracted presentation components, and retain only shell/stage/closed-volume styles.
- `src/lib/components/BookVolume.svelte` — consume shared depth and palette helpers.
- `src/lib/data/catalog.ts` — expose one safe `coverPalette` helper and reuse it in `coverBackground`.
- `src/lib/data/catalog.test.ts` — characterize palette wrapping and fallback.
- `src/routes/library/+page.svelte` — consume `coverPalette` instead of repeating swatch lookup.

## Task 1: Extract book geometry and sheet-bound navigation

**Files:**
- Create: `src/lib/reader/geometry.ts`
- Create: `src/lib/reader/geometry.test.ts`
- Create: `src/lib/reader/navigation.ts`
- Create: `src/lib/reader/navigation.test.ts`
- Modify: `src/lib/components/BookVolume.svelte`
- Modify: `src/lib/components/BookReader.svelte`

- [ ] **Step 1: Verify the pre-refactor baseline**

Run:

```powershell
npm run verify
```

Expected: `svelte-check`, ESLint, all existing Vitest tests, and the Vite production build exit successfully. Stop and diagnose any baseline failure before changing files.

- [ ] **Step 2: Write failing geometry tests**

Create `src/lib/reader/geometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TitleKind } from '$lib/types/catalog';
import { bookDepth } from './geometry';

describe('bookDepth', () => {
  it.each<[TitleKind, number, number]>([
    ['comic', 0, 5],
    ['comic', 12, 6],
    ['comic', 100, 11],
    ['novel', 0, 16],
    ['novel', 20, 28],
    ['novel', 100, 58]
  ])('returns the expected %s depth for %i pages', (kind, pageCount, expected) => {
    expect(bookDepth(kind, pageCount)).toBe(expected);
  });

  it('treats a negative page count as an empty book', () => {
    expect(bookDepth('novel', -4)).toBe(16);
    expect(bookDepth('comic', -4)).toBe(5);
  });
});
```

- [ ] **Step 3: Write failing navigation tests**

Create `src/lib/reader/navigation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { clampSheet } from './navigation';

describe('clampSheet', () => {
  it('clamps positions below the first sheet', () => {
    expect(clampSheet(-1, 10, 10)).toBe(0);
  });

  it('preserves an interior position', () => {
    expect(clampSheet(4, 10, 10)).toBe(4);
  });

  it('uses the preview limit when it is lower than the book limit', () => {
    expect(clampSheet(9, 10, 6)).toBe(6);
  });

  it('never exceeds the physical end of the book', () => {
    expect(clampSheet(11, 10, 20)).toBe(10);
  });

  it('normalizes negative bounds to an empty range', () => {
    expect(clampSheet(3, -1, -1)).toBe(0);
  });
});
```

- [ ] **Step 4: Run the new tests and confirm the missing-module failure**

Run:

```powershell
npm test -- src/lib/reader/geometry.test.ts src/lib/reader/navigation.test.ts
```

Expected: FAIL because `./geometry` and `./navigation` do not exist.

- [ ] **Step 5: Implement the shared depth helper**

Create `src/lib/reader/geometry.ts`:

```ts
import type { TitleKind } from '$lib/types/catalog';

export function bookDepth(kind: TitleKind, pageCount: number): number {
  const pages = Math.max(0, pageCount);
  return kind === 'comic'
    ? Math.max(5, Math.min(11, Math.round(pages * 0.5)))
    : Math.max(16, Math.min(58, Math.round(pages * 0.9) + 10));
}
```

- [ ] **Step 6: Implement the shared sheet clamp**

Create `src/lib/reader/navigation.ts`:

```ts
export function clampSheet(index: number, totalSheets: number, limit = totalSheets): number {
  const upper = Math.max(0, Math.min(totalSheets, limit));
  return Math.max(0, Math.min(upper, index));
}
```

- [ ] **Step 7: Run the pure helper tests**

Run:

```powershell
npm test -- src/lib/reader/geometry.test.ts src/lib/reader/navigation.test.ts
```

Expected: 12 tests pass.

- [ ] **Step 8: Replace duplicated depth calculations**

In `src/lib/components/BookVolume.svelte`, add:

```ts
import { bookDepth } from '$lib/reader/geometry';
```

Replace the `d` derived value with:

```ts
const d = $derived(depth ?? bookDepth(title.kind, leaves));
```

In `src/lib/components/BookReader.svelte`, add:

```ts
import { bookDepth } from '$lib/reader/geometry';
```

Replace the existing multiline `depth` derived value with:

```ts
const depth = $derived(bookDepth(title.kind, pages.length));
```

- [ ] **Step 9: Replace every duplicated sheet clamp**

Add to `BookReader.svelte`:

```ts
import { clampSheet } from '$lib/reader/navigation';
```

Change `commit` to:

```ts
function commit(n: number): void {
  const next = clampSheet(n, totalSheets, limit);
  sheet = next;
  recordAnchor();
  library.setProgress(title.id, next, anchor);
}
```

In the anchor-remapping effect, replace the nested `Math.max`/`Math.min` expression with:

```ts
const next = clampSheet(
  Math.floor(pageForAnchor(currentPages, anchor) / currentPer),
  totalSheets,
  limit
);
```

In `turn`, replace the bound check with:

```ts
if (clampSheet(sheet + dir, totalSheets, limit) === sheet) return;
```

In `onPointerUp`, replace the bound check with:

```ts
if (clampSheet(sheet + dir, totalSheets, limit) === sheet) return fallBack();
```

- [ ] **Step 10: Verify the helper integration**

Run:

```powershell
npm test -- src/lib/reader/geometry.test.ts src/lib/reader/navigation.test.ts
npm run check
npx eslint src/lib/reader/geometry.ts src/lib/reader/geometry.test.ts src/lib/reader/navigation.ts src/lib/reader/navigation.test.ts src/lib/components/BookVolume.svelte src/lib/components/BookReader.svelte
```

Expected: all targeted tests pass, Svelte reports no errors or warnings, and ESLint exits 0.

- [ ] **Step 11: Commit the pure helper extraction**

```powershell
git add src/lib/reader/geometry.ts src/lib/reader/geometry.test.ts src/lib/reader/navigation.ts src/lib/reader/navigation.test.ts src/lib/components/BookVolume.svelte src/lib/components/BookReader.svelte
git commit -m "refactor: extract reader geometry and bounds"
```

## Task 2: Consolidate cover-palette lookup

**Files:**
- Modify: `src/lib/data/catalog.ts`
- Modify: `src/lib/data/catalog.test.ts`
- Modify: `src/lib/components/BookVolume.svelte`
- Modify: `src/routes/library/+page.svelte`

- [ ] **Step 1: Add failing catalog-helper tests**

Change the import in `src/lib/data/catalog.test.ts` to:

```ts
import { byId, coverBackground, coverPalette, money, SWATCHES } from './catalog';
```

Add inside `describe('catalog helpers', ...)`:

```ts
it('selects and safely wraps cover palettes', () => {
  expect(coverPalette(0)).toBe(SWATCHES[0]);
  expect(coverPalette(SWATCHES.length + 1)).toBe(SWATCHES[1]);
  expect(coverPalette(-1)).toBe(SWATCHES[0]);
});
```

- [ ] **Step 2: Run the catalog tests and confirm failure**

Run:

```powershell
npm test -- src/lib/data/catalog.test.ts
```

Expected: FAIL because `coverPalette` is not exported.

- [ ] **Step 3: Add and reuse `coverPalette`**

In `src/lib/data/catalog.ts`, insert after `SWATCHES`:

```ts
export function coverPalette(index = 0): (typeof SWATCHES)[number] {
  return SWATCHES[index % SWATCHES.length] ?? SWATCHES[0];
}
```

Change `coverBackground` to:

```ts
export function coverBackground(index = 0, url: string | null | undefined = null): string {
  if (url) return `center / cover url(${url})`;
  const [accent, ground] = coverPalette(index);
  return `linear-gradient(150deg, ${ground} 0%, ${ground} 46%, ${accent} 47%, ${accent} 53%, ${ground} 54%)`;
}
```

- [ ] **Step 4: Migrate the two direct lookup consumers**

In `BookVolume.svelte`, replace the catalog import with:

```ts
import { money, coverBackground, coverPalette } from '$lib/data/catalog';
```

Replace its `pair` derived value with:

```ts
const pair = $derived(coverPalette(title.cover));
```

In `src/routes/library/+page.svelte`, replace the catalog import with:

```ts
import { coverBackground, coverPalette } from '$lib/data/catalog';
```

Replace the shelf-loop declaration with:

```svelte
{@const pair = coverPalette(t.cover)}
```

- [ ] **Step 5: Verify the catalog consolidation**

Run:

```powershell
npm test -- src/lib/data/catalog.test.ts
npm run check
npx eslint src/lib/data/catalog.ts src/lib/data/catalog.test.ts src/lib/components/BookVolume.svelte src/routes/library/+page.svelte
rg -n "SWATCHES\[.*%.*SWATCHES\.length" src/lib/components src/routes
```

Expected: catalog tests pass, type checking and linting succeed, and the final `rg` command returns no direct palette lookup in components or routes. The centralized expression remains only inside `coverPalette`; `SWATCHES` may remain imported by Studio for its palette picker.

- [ ] **Step 6: Commit the palette helper**

```powershell
git add src/lib/data/catalog.ts src/lib/data/catalog.test.ts src/lib/components/BookVolume.svelte src/routes/library/+page.svelte
git commit -m "refactor: centralize cover palette lookup"
```

## Task 3: Build the bounded sheet-window model

**Files:**
- Create: `src/lib/reader/sheet-window.ts`
- Create: `src/lib/reader/sheet-window.test.ts`

- [ ] **Step 1: Write failing window-selection and presentation tests**

Create `src/lib/reader/sheet-window.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ReaderPage } from '$lib/types/reader';
import { buildSheetWindow, visibleSheetIndices } from './sheet-window';

function pages(count: number): ReaderPage[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'scan' as const,
    chapter: 0,
    at: index,
    folio: String(index + 1),
    label: `Page ${index + 1}`
  }));
}

describe('visibleSheetIndices', () => {
  it('selects a partial window at the beginning', () => {
    expect(visibleSheetIndices(0, 100, 99)).toEqual([0, 1, 2]);
  });

  it('selects five absolute indices in the middle', () => {
    expect(visibleSheetIndices(50, 100, 99)).toEqual([48, 49, 50, 51, 52]);
  });

  it('selects the valid trailing window at the end sentinel', () => {
    expect(visibleSheetIndices(100, 100, 99)).toEqual([98, 99]);
  });

  it('returns every sheet in a short book', () => {
    expect(visibleSheetIndices(1, 3, 2)).toEqual([0, 1, 2]);
  });

  it('returns an empty window for an empty book', () => {
    expect(visibleSheetIndices(0, 0, -1)).toEqual([]);
  });

  it('does not select content beyond a preview boundary', () => {
    expect(visibleSheetIndices(4, 100, 3)).toEqual([2, 3]);
  });
});

describe('buildSheetWindow', () => {
  it('builds the same forward-turn values as the full-sheet implementation', () => {
    const result = buildSheetWindow({
      pages: pages(20),
      per: 2,
      currentSheet: 3,
      totalSheets: 10,
      maxReadableSheet: 9,
      turn: { dir: 1, t: 0.5 }
    });

    expect(result.map((sheet) => sheet.k)).toEqual([1, 2, 3, 4, 5]);
    expect(result.find((sheet) => sheet.k === 3)).toMatchObject({
      angle: -90,
      curl: 1,
      active: true,
      z: 13,
      showFront: true,
      showBack: true,
      front: { label: 'Page 7' },
      back: { label: 'Page 8' }
    });
  });

  it('builds the same backward-turn angle', () => {
    const result = buildSheetWindow({
      pages: pages(20),
      per: 2,
      currentSheet: 3,
      totalSheets: 10,
      maxReadableSheet: 9,
      turn: { dir: -1, t: 0.25 }
    });

    expect(result.find((sheet) => sheet.k === 2)).toMatchObject({
      angle: -135,
      active: true,
      showFront: true,
      showBack: true
    });
  });

  it('preserves settled face visibility and absolute stack depth', () => {
    const result = buildSheetWindow({
      pages: pages(20),
      per: 2,
      currentSheet: 3,
      totalSheets: 10,
      maxReadableSheet: 9,
      turn: null
    });

    expect(result.find((sheet) => sheet.k === 2)).toMatchObject({
      angle: -180,
      z: 3,
      showFront: false,
      showBack: true
    });
    expect(result.find((sheet) => sheet.k === 3)).toMatchObject({
      angle: 0,
      z: 8,
      showFront: true,
      showBack: false
    });
  });

  it('keeps an unflipped sheet key and depth stable as the window moves', () => {
    const input = {
      pages: pages(20),
      per: 2,
      totalSheets: 10,
      maxReadableSheet: 9,
      turn: null
    } as const;
    const first = buildSheetWindow({ ...input, currentSheet: 1 });
    const second = buildSheetWindow({ ...input, currentSheet: 2 });

    expect(first.find((sheet) => sheet.k === 3)?.z).toBe(8);
    expect(second.find((sheet) => sheet.k === 3)?.z).toBe(8);
  });

  it('never constructs more than five models for a large book', () => {
    const result = buildSheetWindow({
      pages: pages(2_000),
      per: 2,
      currentSheet: 500,
      totalSheets: 1_000,
      maxReadableSheet: 999,
      turn: null
    });

    expect(result).toHaveLength(5);
  });

  it('does not attach page content beyond the preview boundary', () => {
    const result = buildSheetWindow({
      pages: pages(20),
      per: 2,
      currentSheet: 4,
      totalSheets: 10,
      maxReadableSheet: 3,
      turn: null
    });

    expect(result.map((sheet) => sheet.k)).toEqual([2, 3]);
    expect(result.flatMap((sheet) => [sheet.front, sheet.back]).filter(Boolean)).toHaveLength(4);
    expect(result.every((sheet) => sheet.k <= 3)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the sheet-window tests and confirm failure**

Run:

```powershell
npm test -- src/lib/reader/sheet-window.test.ts
```

Expected: FAIL because `./sheet-window` does not exist.

- [ ] **Step 3: Implement bounded index selection and sheet presentation**

Create `src/lib/reader/sheet-window.ts`:

```ts
import type { ReaderPage, SheetView, TurnProgress } from '$lib/types/reader';

const WINDOW_RADIUS = 2;

export interface SheetWindowInput {
  pages: readonly ReaderPage[];
  per: number;
  currentSheet: number;
  totalSheets: number;
  maxReadableSheet: number;
  turn: TurnProgress | null;
}

export function visibleSheetIndices(
  currentSheet: number,
  totalSheets: number,
  maxReadableSheet: number,
  radius = WINDOW_RADIUS
): number[] {
  const lastSheet = Math.min(totalSheets - 1, maxReadableSheet);
  if (lastSheet < 0) return [];

  const start = Math.max(0, currentSheet - radius);
  const end = Math.min(lastSheet, currentSheet + radius);
  if (start > end) return [];

  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

export function buildSheetWindow({
  pages,
  per,
  currentSheet,
  totalSheets,
  maxReadableSheet,
  turn
}: SheetWindowInput): SheetView[] {
  const settled = turn === null;

  return visibleSheetIndices(currentSheet, totalSheets, maxReadableSheet).map((index) => {
    const isFlipped = index < currentSheet;
    let angle = isFlipped ? -180 : 0;
    if (turn?.dir === 1 && index === currentSheet) angle = -180 * turn.t;
    if (turn?.dir === -1 && index === currentSheet - 1) {
      angle = -180 * (1 - turn.t);
    }
    const active = turn !== null && (index === currentSheet || index === currentSheet - 1);
    const curl = Math.sin((Math.abs(angle) / 180) * Math.PI);

    return {
      k: index,
      angle,
      curl,
      active,
      z: active
        ? totalSheets + 3
        : isFlipped
          ? index + 1
          : totalSheets - index + 1,
      showFront: settled ? angle > -90 : true,
      showBack: settled ? angle <= -90 : true,
      front: pages[index * per] ?? null,
      back: per === 2 ? (pages[index * per + 1] ?? null) : null
    };
  });
}
```

- [ ] **Step 4: Run the sheet-window tests**

Run:

```powershell
npm test -- src/lib/reader/sheet-window.test.ts
npx eslint src/lib/reader/sheet-window.ts src/lib/reader/sheet-window.test.ts
```

Expected: all 12 sheet-window tests pass and ESLint exits 0.

- [ ] **Step 5: Commit the independently tested window model**

```powershell
git add src/lib/reader/sheet-window.ts src/lib/reader/sheet-window.test.ts
git commit -m "feat: add bounded reader sheet window"
```

## Task 4: Integrate bounded rendering into `BookReader`

**Files:**
- Modify: `src/lib/components/BookReader.svelte`

- [ ] **Step 1: Re-run the sheet-window characterization before integration**

Run:

```powershell
npm test -- src/lib/reader/sheet-window.test.ts
```

Expected: all sheet-window tests pass.

- [ ] **Step 2: Import the bounded window builder**

Add to `BookReader.svelte`:

```ts
import { buildSheetWindow } from '$lib/reader/sheet-window';
```

Remove `SheetView` from the type-only import because `BookReader` no longer constructs the type directly.

- [ ] **Step 3: Replace the full-sheet derived loop**

Delete the complete `$derived.by<SheetView[]>` block that loops from zero to `totalSheets`.

Insert in the same location:

```ts
const maxRenderedSheet = $derived(
  sampling ? Math.min(totalSheets - 1, readable) : totalSheets - 1
);

const sheets = $derived(
  buildSheetWindow({
    pages,
    per,
    currentSheet: sheet,
    totalSheets,
    maxReadableSheet: maxRenderedSheet,
    turn: drag ?? turning
  })
);
```

This deliberately excludes the paywall sentinel from page content while retaining the final readable sheets beneath the overlay.

- [ ] **Step 4: Verify bounded integration statically and with tests**

Run:

```powershell
npm test -- src/lib/reader/sheet-window.test.ts src/lib/reader/navigation.test.ts src/lib/reader/geometry.test.ts
npm run check
npx eslint src/lib/components/BookReader.svelte src/lib/reader/sheet-window.ts
rg -n "for \(let index = 0; index < totalSheets" src/lib/components/BookReader.svelte
```

Expected: tests, checking, and linting pass. The final `rg` command returns no matches, proving the all-sheets derived loop is gone.

- [ ] **Step 5: Run a production build**

Run:

```powershell
npm run build
```

Expected: Vite builds the application successfully.

- [ ] **Step 6: Commit the performance change before component moves**

```powershell
git add src/lib/components/BookReader.svelte
git commit -m "perf: window reader sheet rendering"
```

## Task 5: Extract the page spread

**Files:**
- Create: `src/lib/components/reader/ReaderSpread.svelte`
- Modify: `src/lib/components/BookReader.svelte`

- [ ] **Step 1: Create `ReaderSpread.svelte` with a typed, stateless contract**

Create `src/lib/components/reader/ReaderSpread.svelte`:

```svelte
<script lang="ts">
  import PageFace from '../PageFace.svelte';
  import type { PageBox, PaperId, SheetView, TypefaceId } from '$lib/types/reader';

  interface Props {
    title: string;
    bookWidth: number;
    box: PageBox;
    narrow: boolean;
    totalSheets: number;
    sheets: readonly SheetView[];
    paper: PaperId;
    paperBackground: string;
    typeface: TypefaceId;
    onpointerdown: (event: PointerEvent) => void;
    onpointermove: (event: PointerEvent) => void;
    onpointerup: (event: PointerEvent) => void;
  }

  let {
    title,
    bookWidth,
    box,
    narrow,
    totalSheets,
    sheets,
    paper,
    paperBackground,
    typeface,
    onpointerdown,
    onpointermove,
    onpointerup
  }: Props = $props();
</script>

<div
  class="book"
  role="application"
  aria-label="Interactive pages for {title}; use arrow keys to turn pages"
  style:width="{bookWidth}px"
  style:height="{box.ph}px"
  style:padding-left={narrow ? '0' : `${box.pw}px`}
  onpointerdown={onpointerdown}
  onpointermove={onpointermove}
  onpointerup={onpointerup}
  onpointercancel={onpointerup}
>
  <div
    class="slab"
    style:background={paperBackground}
    style:width="{bookWidth}px"
    style:height="{box.ph}px"
  ></div>

  {#each sheets as sheet (sheet.k)}
    <div
      class="sheet"
      style:width="{box.pw}px"
      style:height="{box.ph}px"
      style:z-index={sheet.z}
      style:transform="rotateY({sheet.angle}deg) translateZ({(sheet.curl * 6).toFixed(2)}px)"
      style:will-change={sheet.active ? 'transform' : 'auto'}
    >
      <div
        class="face front"
        style:background={paperBackground}
        style:visibility={sheet.showFront ? 'visible' : 'hidden'}
      >
        <PageFace page={sheet.front} {box} {paper} {typeface} side="front" />
        <div
          class="shade"
          style:background="linear-gradient(90deg, rgba(0,0,0,{(0.3 + sheet.curl * 0.28).toFixed(3)}) 0%, rgba(0,0,0,0.04) 14%, rgba(0,0,0,0) 42%, rgba(255,255,255,{(sheet.curl * 0.22).toFixed(3)}) 78%, rgba(0,0,0,{(sheet.curl * 0.3).toFixed(3)}) 100%)"
        ></div>
      </div>

      <div
        class="face back"
        style:background={paperBackground}
        style:visibility={sheet.showBack ? 'visible' : 'hidden'}
      >
        <PageFace page={sheet.back} {box} {paper} {typeface} side="back" />
        <div
          class="shade"
          style:background="linear-gradient(270deg, rgba(0,0,0,{(0.3 + sheet.curl * 0.28).toFixed(3)}) 0%, rgba(0,0,0,0.04) 14%, rgba(0,0,0,0) 42%, rgba(255,255,255,{(sheet.curl * 0.2).toFixed(3)}) 78%, rgba(0,0,0,{(sheet.curl * 0.28).toFixed(3)}) 100%)"
        ></div>
      </div>
    </div>
  {/each}

  {#if !narrow}
    <div
      class="spine"
      style:left="{box.pw - 3}px"
      style:height="{box.ph}px"
      style:z-index={totalSheets + 5}
    ></div>
  {/if}
</div>

<style>
  .book {
    position: relative;
    perspective: 2400px;
    perspective-origin: 50% 50%;
    touch-action: none;
    cursor: grab;
  }

  .slab {
    position: absolute;
    inset: 0;
    border-radius: 4px;
    box-shadow: 0 40px 80px -40px rgba(0, 0, 0, 0.9);
    z-index: 0;
  }

  .sheet {
    position: absolute;
    top: 0;
    right: 0;
    transform-origin: left center;
    transform-style: preserve-3d;
    pointer-events: none;
  }

  .face {
    position: absolute;
    inset: 0;
    backface-visibility: hidden;
    overflow: hidden;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.06);
  }

  .face.front {
    border-radius: 0 4px 4px 0;
    box-shadow:
      inset 14px 0 26px -22px rgba(0, 0, 0, 0.85),
      0 0 0 1px rgba(0, 0, 0, 0.06);
  }

  .face.back {
    transform: rotateY(180deg);
    border-radius: 4px 0 0 4px;
    box-shadow:
      inset -14px 0 26px -22px rgba(0, 0, 0, 0.85),
      0 0 0 1px rgba(0, 0, 0, 0.06);
  }

  .shade {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .spine {
    position: absolute;
    top: 0;
    width: 6px;
    pointer-events: none;
    background: linear-gradient(90deg, rgba(0, 0, 0, 0.22), rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0.22));
  }
</style>
```

- [ ] **Step 2: Replace the inlined spread in `BookReader`**

Import:

```ts
import ReaderSpread from './reader/ReaderSpread.svelte';
```

Replace the full `<div class="book" ...>` block in the reading branch with:

```svelte
<ReaderSpread
  title={title.title}
  bookWidth={bookW}
  {box}
  {narrow}
  {totalSheets}
  {sheets}
  paper={prefs.paper}
  paperBackground={paper.bg}
  typeface={prefs.typeface}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
/>
```

Delete the parent style block from the `/* the book */` marker through the `.spine` rule. Do not remove `PageFace` from the parent yet because the opening rig still uses it.

- [ ] **Step 3: Verify the spread extraction**

Run:

```powershell
npm run check
npx eslint src/lib/components/BookReader.svelte src/lib/components/reader/ReaderSpread.svelte
npm run build
```

Expected: all three commands succeed with no Svelte warnings.

- [ ] **Step 4: Commit the spread component**

```powershell
git add src/lib/components/reader/ReaderSpread.svelte src/lib/components/BookReader.svelte
git commit -m "refactor: extract reader page spread"
```

## Task 6: Extract the opening and closing rig

**Files:**
- Create: `src/lib/components/reader/ReaderOpeningRig.svelte`
- Modify: `src/lib/components/BookReader.svelte`

- [ ] **Step 1: Create the opening-rig contract and markup**

Create `src/lib/components/reader/ReaderOpeningRig.svelte` with this script and markup:

```svelte
<script lang="ts">
  import PageFace from '../PageFace.svelte';
  import type {
    PageBox,
    PaperId,
    ReaderPage,
    ReaderPhase,
    TypefaceId
  } from '$lib/types/reader';

  interface Props {
    phase: ReaderPhase;
    box: PageBox;
    pages: readonly ReaderPage[];
    sheet: number;
    per: number;
    narrow: boolean;
    depth: number;
    paper: PaperId;
    paperBackground: string;
    typeface: TypefaceId;
    boardArt: string;
    oncomplete: () => void;
  }

  let {
    phase,
    box,
    pages,
    sheet,
    per,
    narrow,
    depth,
    paper,
    paperBackground,
    typeface,
    boardArt,
    oncomplete
  }: Props = $props();

  const atEnd = $derived(phase === 'closingEnd' || phase === 'openingEnd');
  const visiblePage = $derived(
    atEnd ? (pages[pages.length - 1] ?? null) : (pages[sheet * per] ?? pages[0] ?? null)
  );
</script>

<div class="case">
  <div
    class="rig"
    class:closing={phase === 'closing'}
    class:closing-end={phase === 'closingEnd'}
    class:opening-end={phase === 'openingEnd'}
    style:width="{box.pw * 2}px"
    style:height="{box.ph}px"
    style:--dx="{-box.pw / 2}px"
    style:--dx2="{box.pw / 2}px"
  >
    <div
      class="rig-slab"
      class:at-end={atEnd}
      style:left="{atEnd ? 0 : box.pw}px"
      style:width="{box.pw}px"
      style:height="{box.ph}px"
      style:background={paperBackground}
    ></div>

    <div
      class="first-page"
      class:at-end={atEnd}
      style:left="{atEnd ? 0 : box.pw}px"
      style:width="{box.pw}px"
      style:height="{box.ph}px"
      style:background={paperBackground}
    >
      <PageFace page={visiblePage} {box} {paper} {typeface} side={atEnd ? 'back' : 'front'} />
      <div class="page-shade" class:at-end={atEnd}></div>
      <div class="sweep" class:closing={phase === 'closing' || phase === 'closingEnd'}></div>
    </div>

    {#if !narrow}
      <div class="rig-spine" style:left="{box.pw - 3}px" style:height="{box.ph}px"></div>
    {/if}

    <div
      class="rig-edge"
      class:closing={phase === 'closing'}
      style:display={atEnd ? 'none' : 'block'}
      style:left="{box.pw * 2 - 3}px"
      style:width="{Math.max(6, depth - 6)}px"
      style:height="{box.ph - 6}px"
    ></div>

    <div
      class="swing"
      class:closing={phase === 'closing'}
      class:closing-end={phase === 'closingEnd'}
      class:opening-end={phase === 'openingEnd'}
      style:left="{box.pw}px"
      style:width="{box.pw}px"
      style:height="{box.ph}px"
      style:--dz="{depth / 2}px"
      style:--dzn="{-depth / 2}px"
      onanimationend={oncomplete}
    >
      <span class="swing-face outer" style:background={atEnd ? paperBackground : boardArt}></span>
      <span class="swing-face inner" style:background={atEnd ? boardArt : paperBackground}></span>
    </div>

    <div
      class="cast opening"
      class:closing={phase === 'closing' || phase === 'closingEnd'}
      style:--w0="{box.pw * 0.9}px"
      style:--w1="{box.pw * 1.7}px"
    ></div>
  </div>
</div>
```

- [ ] **Step 2: Move the opening-rig CSS exactly**

Use the stable source snapshot to avoid copying CSS after line numbers have shifted:

```powershell
git show 6f885ec:src/lib/components/BookReader.svelte
```

Append a `<style>` block to `ReaderOpeningRig.svelte` containing:

- a local copy of the `.case` declarations from snapshot lines 962-968;
- `.cast`, `.cast.opening`, and every opening/closing keyframe and rig rule from snapshot lines 970-1266.

Do not rename selectors, animations, timing functions, CSS variables, transforms, shadows, or gradients. In `BookReader.svelte`, retain `.case` for the closed `BookVolume`, but delete `.cast` through `.swing-face.inner` after the component is wired.

- [ ] **Step 3: Add one parent transition-settling callback**

Add to `BookReader.svelte`:

```ts
function settleTransition(): void {
  if (phase === 'closing') {
    settleClose();
  } else if (phase === 'closingEnd') {
    settleCloseEnd();
  } else if (phase === 'openingEnd') {
    settleOpenEnd();
  } else {
    settleOpen();
  }
}
```

This preserves the current idempotent phase guards in the four settle functions.

- [ ] **Step 4: Replace the inlined rig**

Import:

```ts
import ReaderOpeningRig from './reader/ReaderOpeningRig.svelte';
```

Replace the complete `{:else if phase !== 'reading'}` rig contents with:

```svelte
{:else if phase !== 'reading'}
  <ReaderOpeningRig
    {phase}
    {box}
    {pages}
    {sheet}
    {per}
    {narrow}
    {depth}
    paper={prefs.paper}
    paperBackground={paper.bg}
    typeface={prefs.typeface}
    {boardArt}
    oncomplete={settleTransition}
  />
```

Remove the now-unused `PageFace` import from `BookReader.svelte`. Remove the parent opening-rig CSS described in Step 2, leaving the parent `.case` rule for the closed volume.

- [ ] **Step 5: Verify the opening-rig extraction**

Run:

```powershell
npm run check
npx eslint src/lib/components/BookReader.svelte src/lib/components/reader/ReaderOpeningRig.svelte
npm run build
```

Expected: all commands succeed. Svelte must not report an unused selector in either file; an unused selector indicates CSS was moved to the wrong component.

- [ ] **Step 6: Commit the opening rig**

```powershell
git add src/lib/components/reader/ReaderOpeningRig.svelte src/lib/components/BookReader.svelte
git commit -m "refactor: extract reader opening rig"
```

## Task 7: Extract guided-panel and paywall presentation

**Files:**
- Create: `src/lib/components/reader/ReaderGuidedPanel.svelte`
- Create: `src/lib/components/reader/ReaderPaywall.svelte`
- Modify: `src/lib/components/BookReader.svelte`

- [ ] **Step 1: Create the guided-panel component**

Create `src/lib/components/reader/ReaderGuidedPanel.svelte`:

```svelte
<script lang="ts">
  import type { PanelCell } from '$lib/types/reader';

  interface Props {
    height: number;
    panel: PanelCell | null;
    onnext: () => void;
  }

  let { height, panel, onnext }: Props = $props();
  const width = $derived(
    Math.round(height * (panel ? (panel.c / panel.r) * 1.15 : 1.4))
  );
</script>

<button
  class="single-panel"
  type="button"
  style:height="{height}px"
  style:width="min(80vw, {width}px)"
  onclick={onnext}
>
  <span class="art"></span>
  <span class="cap">{panel?.cap}</span>
</button>

<style>
  .single-panel {
    position: relative;
    padding: 0;
    background: #fff;
    border: 3px solid #16130f;
    box-shadow: 0 40px 80px -40px rgba(0, 0, 0, 0.9);
    cursor: pointer;
    animation: fade-up 0.28s ease both;
  }

  .single-panel .art {
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      135deg,
      rgba(20, 18, 15, 0.09) 0 12px,
      rgba(20, 18, 15, 0.02) 12px 24px
    );
  }

  .single-panel .cap {
    position: absolute;
    left: 18px;
    right: 18px;
    bottom: 18px;
    text-align: left;
    font-family: var(--font-mono);
    font-size: 12px;
    color: rgba(0, 0, 0, 0.62);
  }
</style>
```

- [ ] **Step 2: Create the paywall component**

Create `src/lib/components/reader/ReaderPaywall.svelte`:

```svelte
<script lang="ts">
  interface Props {
    isComic: boolean;
    title: string;
    price: string;
    onbuy: () => void;
    onclose: () => void;
  }

  let { isComic, title, price, onbuy, onclose }: Props = $props();
</script>

<div class="paywall">
  <div class="card">
    <div class="mono accent">End of the free {isComic ? 'preview' : 'chapter'}</div>
    <h3 class="display">{title}</h3>
    <p>Keep going for {price}. Yours forever, in the browser or as a file.</p>
    <button class="btn" type="button" onclick={onbuy}>Buy the whole {isComic ? 'issue' : 'book'}</button>
    <button class="link" type="button" onclick={onclose}>Not now</button>
  </div>
</div>

<style>
  .paywall {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in oklab, var(--bg) 78%, transparent);
    backdrop-filter: blur(6px);
  }

  .card {
    width: 420px;
    max-width: 90vw;
    padding: 34px;
    text-align: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
  }

  .card h3 {
    font-size: 30px;
    margin: 12px 0;
  }

  .card p {
    font-size: 14.5px;
    line-height: 1.6;
    color: var(--muted);
    margin: 0 0 24px;
  }

  .card .btn {
    width: 100%;
  }

  .accent {
    color: var(--accent);
  }

  .link {
    margin-top: 12px;
    border: 0;
    background: none;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
  }
</style>
```

- [ ] **Step 3: Wire both components from the parent**

Import:

```ts
import ReaderGuidedPanel from './reader/ReaderGuidedPanel.svelte';
import ReaderPaywall from './reader/ReaderPaywall.svelte';
```

Replace the guided button with:

```svelte
<ReaderGuidedPanel height={panelH} panel={panelCell} onnext={() => turn(1)} />
```

Replace the paywall block with:

```svelte
{#if paywalled}
  <ReaderPaywall
    {isComic}
    title={title.title}
    price={money(title.price)}
    onbuy={() => onbuy?.()}
    onclose={() => onclose?.()}
  />
{/if}
```

Delete the parent styles under `/* guided comic view */` and `/* paywall */` through the end of their respective selector groups.

- [ ] **Step 4: Verify and commit the presentation extraction**

Run:

```powershell
npm run check
npx eslint src/lib/components/BookReader.svelte src/lib/components/reader/ReaderGuidedPanel.svelte src/lib/components/reader/ReaderPaywall.svelte
npm run build
```

Expected: all commands succeed with no unused selectors.

Commit:

```powershell
git add src/lib/components/reader/ReaderGuidedPanel.svelte src/lib/components/reader/ReaderPaywall.svelte src/lib/components/BookReader.svelte
git commit -m "refactor: extract guided reader and paywall views"
```

## Task 8: Extract the toolbar and stage drawers

**Files:**
- Create: `src/lib/components/reader/ReaderToolbar.svelte`
- Create: `src/lib/components/reader/ReaderDrawers.svelte`
- Modify: `src/lib/components/BookReader.svelte`

- [ ] **Step 1: Create the toolbar component**

Create `src/lib/components/reader/ReaderToolbar.svelte`:

```svelte
<script lang="ts">
  interface Props {
    title: string;
    isComic: boolean;
    isFixed: boolean;
    narrow: boolean;
    bookmarked: boolean;
    guided: boolean;
    progress: number;
    onclose: () => void;
    oncontents: () => void;
    onbookmark: () => void;
    onguided: () => void;
    oncontrols: () => void;
  }

  let {
    title,
    isComic,
    isFixed,
    narrow,
    bookmarked,
    guided,
    progress,
    onclose,
    oncontents,
    onbookmark,
    onguided,
    oncontrols
  }: Props = $props();
</script>

<div class="toolbar">
  <button class="tool" type="button" onclick={onclose}>&larr; Close</button>
  <button class="tool" type="button" onclick={oncontents}>Contents</button>
  <button class="tool" class:on={bookmarked} type="button" onclick={onbookmark}>
    {bookmarked ? '\u25C6' : '\u25C7'}{narrow ? '' : bookmarked ? ' Bookmarked' : ' Bookmark'}
  </button>

  <div class="title">{title}</div>

  {#if isComic}
    <button class="pill" type="button" onclick={onguided}>
      {guided ? 'Guided view' : 'Page view'}
    </button>
  {:else if !isFixed}
    <button class="tool" type="button" onclick={oncontrols}>Aa</button>
  {/if}

  <span class="pct">{Math.round(progress * 100)}%</span>
</div>

<div class="rail"><div class="fill" style:width="{progress * 100}%"></div></div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 14px 22px;
    border-bottom: 1px solid var(--line);
  }

  .tool,
  .pill {
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    cursor: pointer;
    white-space: nowrap;
  }

  .tool:hover,
  .pill:hover {
    color: var(--ink);
  }

  .tool.on {
    color: var(--accent);
  }

  .pill {
    padding: 6px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--ink);
  }

  .title {
    flex: 1;
    min-width: 0;
    text-align: center;
    font-family: var(--font-display);
    font-size: 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pct {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
  }

  .rail {
    height: 2px;
    background: var(--line);
  }

  .fill {
    height: 2px;
    background: var(--accent);
    transition: width 0.4s ease;
  }

  @media (max-width: 700px) {
    .toolbar {
      gap: 12px;
      padding: 12px 14px;
    }

    .tool,
    .pill {
      font-size: 10px;
      letter-spacing: 0.1em;
    }

    .pill {
      padding: 5px 9px;
    }

    .title {
      font-size: 14px;
    }
  }
</style>
```

- [ ] **Step 2: Create the stage-drawers component**

Create `src/lib/components/reader/ReaderDrawers.svelte`:

```svelte
<script lang="ts">
  import type { Chapter } from '$lib/types/catalog';
  import type { PaperId, ReaderPreferences, TypefaceId } from '$lib/types/reader';

  interface TypefaceOption {
    id: TypefaceId;
    label: string;
    css: string;
  }

  interface PaperOption {
    id: PaperId;
    label: string;
    bg: string;
    ink: string;
  }

  interface Props {
    contentsOpen: boolean;
    controlsOpen: boolean;
    chapters: readonly Chapter[];
    bookmarks: readonly number[];
    per: number;
    prefs: ReaderPreferences;
    typefaces: readonly TypefaceOption[];
    papers: readonly PaperOption[];
    onchapter: (index: number) => void;
    onbookmark: (sheet: number) => void;
    onfontsize: (size: number) => void;
    ontypeface: (typeface: TypefaceId) => void;
    onpaper: (paper: PaperId) => void;
  }

  let {
    contentsOpen,
    controlsOpen,
    chapters,
    bookmarks,
    per,
    prefs,
    typefaces,
    papers,
    onchapter,
    onbookmark,
    onfontsize,
    ontypeface,
    onpaper
  }: Props = $props();
</script>

{#if contentsOpen}
  <aside class="drawer">
    <div class="mono">Contents</div>
    {#each chapters as chapter, index (chapter.title)}
      <button class="toc-row" type="button" onclick={() => onchapter(index)}>
        <span>{chapter.title}</span>
        <span class="mono plain">ch {index + 1}</span>
      </button>
    {/each}
    <div class="mono bookmarks-heading">Bookmarks</div>
    {#each bookmarks as bookmark (bookmark)}
      <button class="toc-row" type="button" onclick={() => onbookmark(bookmark)}>
        <span>Page {bookmark * per + 1}</span>
        <span class="bookmark-mark">&#9670;</span>
      </button>
    {:else}
      <p class="empty">No bookmarks yet.</p>
    {/each}
  </aside>
{/if}

{#if controlsOpen}
  <aside class="panel-controls">
    <div class="mono">Type size</div>
    <div class="row">
      <button
        class="mini"
        type="button"
        onclick={() => onfontsize(Math.max(14, prefs.fontSize - 1))}
      >A&minus;</button>
      <button
        class="mini big"
        type="button"
        onclick={() => onfontsize(Math.min(24, prefs.fontSize + 1))}
      >A+</button>
    </div>

    <div class="mono">Typeface</div>
    <div class="stack">
      {#each typefaces as option (option.id)}
        <button
          class="mini"
          class:on={prefs.typeface === option.id}
          type="button"
          style:font-family={option.css}
          onclick={() => ontypeface(option.id)}
        >
          {option.label}
        </button>
      {/each}
    </div>

    <div class="mono">Paper</div>
    <div class="row">
      {#each papers as option (option.id)}
        <button
          class="mini paper"
          class:on={prefs.paper === option.id}
          type="button"
          style:background={option.bg}
          style:color={option.ink}
          onclick={() => onpaper(option.id)}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </aside>
{/if}

<style>
  .drawer {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 300px;
    z-index: 30;
    padding: 24px;
    overflow-y: auto;
    background: var(--surface);
    border-right: 1px solid var(--line);
    animation: fade-up 0.25s ease both;
  }

  .toc-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 11px 0;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: none;
    color: var(--ink);
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }

  .toc-row:hover,
  .bookmark-mark {
    color: var(--accent);
  }

  .bookmarks-heading {
    margin-top: 26px;
  }

  .empty {
    font-size: 13px;
    color: var(--muted);
  }

  .plain {
    letter-spacing: 0.1em;
    text-transform: none;
  }

  .panel-controls {
    position: absolute;
    right: 20px;
    top: 16px;
    width: 268px;
    z-index: 30;
    padding: 18px;
    display: grid;
    gap: 10px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
    animation: fade-up 0.2s ease both;
  }

  .row {
    display: flex;
    gap: 8px;
  }

  .stack {
    display: grid;
    gap: 6px;
  }

  .mini {
    flex: 1;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 3px;
    background: none;
    color: var(--ink);
    font-size: 14px;
    cursor: pointer;
  }

  .mini.big {
    font-size: 18px;
  }

  .mini.on {
    border-color: var(--accent);
  }

  .mini.paper.on {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
```

- [ ] **Step 3: Add parent option data and callbacks**

Keep `PAPERS`, `TYPEFACES`, `paperIds`, and `typefaceIds` in `BookReader.svelte`. Add after the ID arrays:

```ts
const typefaceOptions = typefaceIds.map((id) => ({ id, ...TYPEFACES[id] }));
const paperOptions = paperIds.map((id) => ({ id, ...PAPERS[id] }));
```

Add these parent-owned actions:

```ts
function toggleGuided(): void {
  comicMode = guided ? 'page' : 'panel';
  panelIdx = 0;
  pageIdx = sheet * per;
}

function goToBookmark(bookmark: number): void {
  go(bookmark);
  tocOpen = false;
}
```

- [ ] **Step 4: Replace toolbar and drawer markup**

Import:

```ts
import ReaderToolbar from './reader/ReaderToolbar.svelte';
import ReaderDrawers from './reader/ReaderDrawers.svelte';
```

Replace the toolbar and rail above `.stage` with:

```svelte
<ReaderToolbar
  title={title.title}
  {isComic}
  isFixed={title.kind === 'novel' && !!title.fixed}
  {narrow}
  bookmarked={bookmarks.includes(sheet)}
  {guided}
  {progress}
  onclose={() => onclose?.()}
  oncontents={() => (tocOpen = !tocOpen)}
  onbookmark={() => library.toggleBookmark(title.id, sheet)}
  onguided={toggleGuided}
  oncontrols={() => (controlsOpen = !controlsOpen)}
/>
```

Inside `.stage`, after the edge hit-zone buttons and before the phase branches, replace both inlined drawers with:

```svelte
<ReaderDrawers
  contentsOpen={tocOpen}
  {controlsOpen}
  chapters={title.kind === 'novel' ? (title.chapters ?? []) : []}
  {bookmarks}
  {per}
  {prefs}
  typefaces={typefaceOptions}
  papers={paperOptions}
  onchapter={jumpToChapter}
  onbookmark={goToBookmark}
  onfontsize={(fontSize) => library.setPref('fontSize', fontSize)}
  ontypeface={(typeface) => library.setPref('typeface', typeface)}
  onpaper={(nextPaper) => library.setPref('paper', nextPaper)}
/>
```

Delete the parent toolbar, rail, responsive toolbar, drawer, and panel-control selectors. In the stable snapshot these are lines 777-865 and 1300-1386.

- [ ] **Step 5: Verify the stateless toolbar boundary**

Run:

```powershell
npm run check
npx eslint src/lib/components/BookReader.svelte src/lib/components/reader/ReaderToolbar.svelte src/lib/components/reader/ReaderDrawers.svelte
npm run build
rg -n "library|paginate" src/lib/components/reader
```

Expected: checking, linting, and build pass. The final search may find neither term in the extracted components; if it finds either, remove that dependency and pass a value or callback instead.

- [ ] **Step 6: Commit the toolbar and drawers**

```powershell
git add src/lib/components/reader/ReaderToolbar.svelte src/lib/components/reader/ReaderDrawers.svelte src/lib/components/BookReader.svelte
git commit -m "refactor: extract reader toolbar and drawers"
```

## Task 9: Extract the footer navigation

**Files:**
- Create: `src/lib/components/reader/ReaderFooter.svelte`
- Modify: `src/lib/components/BookReader.svelte`

- [ ] **Step 1: Create the footer component**

Create `src/lib/components/reader/ReaderFooter.svelte`:

```svelte
<script lang="ts">
  import type { ReaderPhase } from '$lib/types/reader';

  interface Props {
    phase: ReaderPhase;
    isComic: boolean;
    flipped: boolean;
    guided: boolean;
    currentPage: number;
    panelIndex: number;
    panelCount: number;
    leftFolio: number;
    rightFolio: number;
    pageCount: number;
    onopen: () => void;
    onflip: () => void;
    onprevious: () => void;
    onnext: () => void;
  }

  let {
    phase,
    isComic,
    flipped,
    guided,
    currentPage,
    panelIndex,
    panelCount,
    leftFolio,
    rightFolio,
    pageCount,
    onopen,
    onflip,
    onprevious,
    onnext
  }: Props = $props();
</script>

{#if phase === 'closed'}
  <div class="nav">
    <button class="btn nowrap" type="button" onclick={onopen}>Open the {isComic ? 'comic' : 'book'}</button>
    <button class="btn ghost nowrap" type="button" onclick={onflip}>
      {flipped ? 'Front cover' : 'Back cover'}
    </button>
  </div>
{:else}
  <div class="nav">
    <button class="round" type="button" aria-label="Previous" onclick={onprevious}>&lsaquo;</button>
    <span class="folio mono plain">
      {#if guided}
        Page {currentPage + 1} &middot; panel {panelIndex + 1} of {panelCount}
      {:else if leftFolio && rightFolio}
        Pages {leftFolio}&ndash;{rightFolio} of {pageCount}
      {:else}
        Page {leftFolio || rightFolio || pageCount} of {pageCount}
      {/if}
    </span>
    <button class="round" type="button" aria-label="Next" onclick={onnext}>&rsaquo;</button>
  </div>
{/if}

<style>
  .nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 22px;
    padding: 12px 0 18px;
  }

  .round {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: none;
    color: var(--ink);
    cursor: pointer;
  }

  .round:hover {
    border-color: var(--accent);
  }

  .nowrap {
    white-space: nowrap;
    padding: 12px 24px;
  }

  .folio {
    font-size: 11px;
  }

  .plain {
    letter-spacing: 0.1em;
    text-transform: none;
  }
</style>
```

- [ ] **Step 2: Replace the parent footer**

Import:

```ts
import ReaderFooter from './reader/ReaderFooter.svelte';
```

Replace the complete final `{#if phase === 'closed'}` navigation block with:

```svelte
<ReaderFooter
  {phase}
  {isComic}
  {flipped}
  {guided}
  {currentPage}
  panelIndex={panelIdx}
  {panelCount}
  {leftFolio}
  {rightFolio}
  pageCount={pages.length}
  onopen={openBook}
  onflip={flipCover}
  onprevious={() => turn(-1)}
  onnext={() => turn(1)}
/>
```

Delete the parent `/* nav */` style group. The parent style block should now contain only shell theming, stage layout, edge hit zones, and the closed-volume `.case` rule.

- [ ] **Step 3: Verify component boundaries and parent focus**

Run:

```powershell
npm run check
npx eslint src/lib/components/BookReader.svelte src/lib/components/reader
npm run build
rg -n "library|paginate" src/lib/components/reader
```

Expected: all validation succeeds and extracted components contain no store or pagination dependency.

Inspect the parent diff:

```powershell
git diff --stat 6f885ec -- src/lib/components/BookReader.svelte src/lib/components/reader
git diff --check
```

Expected: `BookReader.svelte` is materially smaller, the new files contain the moved presentation code, and there are no whitespace errors.

- [ ] **Step 4: Commit the footer and orchestration-focused parent**

```powershell
git add src/lib/components/reader/ReaderFooter.svelte src/lib/components/BookReader.svelte
git commit -m "refactor: extract reader footer navigation"
```

## Task 10: Complete automated and browser verification

**Files:**
- Modify only if verification exposes a defect; add or update the narrowest relevant test before fixing it.

- [ ] **Step 1: Run the complete automated verification suite**

Run:

```powershell
npm run verify
```

Expected: Svelte type checking, ESLint, every Vitest test, and the production build exit 0.

- [ ] **Step 2: Confirm the intended source-level boundaries**

Run:

```powershell
rg -n "for \(let index = 0; index < totalSheets" src/lib/components/BookReader.svelte src/lib/reader
rg -n "SWATCHES\[.*%.*SWATCHES\.length" src/lib/components src/routes
rg -n "library|paginate" src/lib/components/reader
git diff --check main...HEAD
```

Expected: the first and second searches return no matches, the third returns no extracted-component dependencies, and the diff check reports no whitespace errors.

- [ ] **Step 3: Start the local application**

Run in a separate terminal:

```powershell
npm run dev -- --host 127.0.0.1
```

Expected: Vite reports a local URL, normally `http://127.0.0.1:5173`.

- [ ] **Step 4: Run the prose-reader smoke matrix**

Open `http://127.0.0.1:5173/read/salt` and verify:

1. The front and back covers flip and the book opens from the front.
2. Arrow buttons, edge hit zones, keyboard arrows, click turns, and drag turns work.
3. Rapid input settles or ignores turns exactly as before without leaving a sheet half-turned.
4. Contents jumps land without animating through intermediate sheets.
5. Bookmark add/remove and bookmark jumps work.
6. Font size, typeface, and paper controls update the reader.
7. Font-size changes keep the same chapter/location rather than the same numeric sheet.
8. Closing at the first and last positions uses the correct cover animation.
9. Closing and reopening resumes at the saved position, including the end position.
10. At desktop and a viewport narrower than 900px, layout and folios remain correct.

- [ ] **Step 5: Run the comic and preview smoke matrix**

Open `http://127.0.0.1:5173/read/vector` and verify page turns, page/panel mode switching, panel navigation, and footer status.

Open `http://127.0.0.1:5173/read/salt?sample=1`, advance to the preview boundary, and verify that the paywall appears, purchase and close actions navigate correctly, and no post-preview page face becomes visible.

If the operating system exposes reduced-motion emulation, enable it and confirm click turns settle immediately without leaving `turning` state active.

- [ ] **Step 6: Create a long synthetic title without overwriting existing prototype data**

In the browser developer console on the local application, run:

```js
const titleKey = 'paleorbit.titles';
const existingTitles = JSON.parse(localStorage.getItem(titleKey) ?? '[]');
const longTitle = {
  id: 'reader-window-smoke',
  kind: 'novel',
  title: 'Reader Window Smoke',
  author: 'Local verification',
  price: 0,
  released: 'Aug 2026',
  cover: 0,
  summary: 'Synthetic long title used to verify bounded reader rendering.',
  chapters: [
    {
      title: 'Long Chapter',
      paras: Array.from(
        { length: 600 },
        (_, index) =>
          `Paragraph ${index + 1}. This synthetic paragraph is deliberately long enough to create many reflowed pages while keeping verification deterministic.`
      )
    }
  ]
};
localStorage.setItem(
  titleKey,
  JSON.stringify([longTitle, ...existingTitles.filter((title) => title.id !== longTitle.id)])
);
location.href = '/read/reader-window-smoke';
```

Open the book, navigate near the middle, and run:

```js
document.querySelectorAll('.sheet').length;
```

Expected: the result is at most `5` at the beginning, middle, and end, including while a drag or click turn is visibly in progress.

- [ ] **Step 7: Remove only the synthetic title**

In the browser developer console, run:

```js
const titleKey = 'paleorbit.titles';
const existingTitles = JSON.parse(localStorage.getItem(titleKey) ?? '[]');
localStorage.setItem(
  titleKey,
  JSON.stringify(existingTitles.filter((title) => title.id !== 'reader-window-smoke'))
);
```

This preserves every other locally published prototype title.

- [ ] **Step 8: Fix verification defects test-first**

If any automated or manual check fails:

1. Add the smallest failing Vitest case to the relevant helper test when the defect is pure logic.
2. Reproduce presentation defects on the same route and viewport before editing CSS or component props.
3. Apply the smallest correction.
4. Re-run the targeted test or smoke step.
5. Re-run `npm run verify`.
6. Commit the correction with a message naming the behavior, for example:

```powershell
git add src/lib/reader/sheet-window.ts src/lib/reader/sheet-window.test.ts
git commit -m "fix: preserve reader end-position window"
```

- [ ] **Step 9: Confirm final repository state**

Run:

```powershell
git status --short --branch
git log --oneline --decorate -10
```

Expected: the feature worktree is clean and the history contains small commits for helpers, palette consolidation, windowing, each component boundary, and any verification fix.

## Completion checklist

- [ ] `BookReader` public props are unchanged.
- [ ] `BookReader` remains the only reader component that owns state, accesses `library`, or calls `paginate`.
- [ ] No animation-frame update loops over every sheet.
- [ ] Normal reading mounts at most five `.sheet` elements.
- [ ] Sample mode does not construct or mount post-preview page faces.
- [ ] Depth, sheet clamp, and palette lookup duplication is removed.
- [ ] Opening, closing, drag, keyboard, guided comic, drawer, bookmark, reflow, resume, and paywall behavior passes smoke testing.
- [ ] Studio and other backend-bound prototype code remains untouched.
- [ ] `npm run verify` passes.
- [ ] The feature worktree is clean.
