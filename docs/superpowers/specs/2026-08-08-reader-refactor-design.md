# Reader Refactor Design

**Status:** Approved design
**Date:** 2026-08-08
**Related design:** `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md`

## 1. Purpose

Refactor the durable reader code before backend integration so it is easier to understand, test, and connect to server data. The refactor will also bound the amount of page markup rendered during reading, preventing long EPUBs from creating a page-face DOM node for every page.

This is a behavior-preserving refactor from the user's perspective. The reader's appearance, controls, animations, sample behavior, saved progress, bookmarks, preferences, and public component API remain consistent.

## 2. Review findings

The review found that a broad repository refactor is not warranted. One targeted refactor is warranted:

| Area | Finding | Decision |
| --- | --- | --- |
| `BookReader.svelte` | About 1,475 lines combine cover and page-turn state machines, pagination state, pointer and keyboard input, guided comics, progress, bookmarks, drawers, markup, and component-specific CSS. | Split along stable responsibility boundaries. |
| Reader sheet rendering | The component derives a view model for every sheet and mounts every front and back page face. Turn animation updates can therefore perform work proportional to the length of the book. | Render a bounded window of sheets and retain absolute stacking calculations. |
| `studio/+page.svelte` | About 770 lines, but its prototype upload and publication workflow will be replaced by the storage, ingestion, revision, and publication work in backend Plan 4. | Do not substantially refactor before Plan 4. |
| Browser-backed stores and endpoint stubs | Some repeated persistence and request-handling shapes exist, but Plans 2 through 5 will replace their prototype responsibilities. Persistence parsing is already partly consolidated. | Do not introduce premature abstractions. |
| Book geometry | The same comic/prose book-depth formula appears in `BookReader.svelte` and `BookVolume.svelte`. | Extract one tested helper. |
| Sheet bounds | The reader repeats the same nested sheet-clamping expression in commit, turn, drag release, and reflow paths. | Extract one tested helper. |
| Cover palette lookup | The same safe swatch-selection expression appears in catalog, volume, and library views. | Add one catalog-level `coverPalette` helper and use it at all three call sites. |
| `paginate.ts` | The module is focused and already caches pagination by title and page-box dimensions. | Keep intact except for import changes required by the refactor. |

## 3. Goals

- Make `BookReader.svelte` an orchestration-focused component with one source of reader state.
- Move stable visual regions into focused Svelte components with typed value and callback props.
- Extract pure geometry, navigation, and sheet-window calculations that can be tested without a browser.
- Replace the all-sheets animation path with a bounded sheet window.
- Consolidate only duplication proven by the review.
- Preserve the reader's existing public props and user-visible behavior.
- Prepare a clean boundary for backend Plan 5 to replace prototype data sources with server data.

## 4. Non-goals

- Redesigning the reader UI or page-turn animation.
- Rewriting reader state as a controller class or general state-machine framework.
- Changing pagination algorithms, page content formats, or stable reading-anchor semantics.
- Implementing server-backed progress, bookmarks, entitlements, previews, or downloads.
- Substantially refactoring Studio, browser-backed stores, checkout stubs, webhook stubs, or delivery stubs.
- Adding a generalized utilities layer for superficial similarities.
- Enforcing an arbitrary maximum line count. Responsibility boundaries are the acceptance criterion.

## 5. Chosen approach

Use a staged extraction with bounded sheet rendering.

Pure calculations are extracted and characterized first. Stable presentation regions are then moved into components while `BookReader.svelte` continues to own all reader state and actions. Sheet windowing is introduced behind a pure helper so its edge cases can be tested before the rendering loop changes.

This approach is preferred over a controller-first rewrite because it preserves the current state topology and reduces the number of simultaneous behavioral changes. It is preferred over structural splitting alone because structural splitting would leave the long-book rendering cost unresolved immediately before real EPUB integration.

## 6. Architecture

### 6.1 State ownership

`BookReader.svelte` remains the public entry point and the sole owner of:

- cover/opening/closing phase;
- current sheet and stable reading anchor;
- drag and animated-turn progress;
- viewport and pagination-derived state;
- guided comic page and panel position;
- table-of-contents and preference-drawer visibility;
- persistence calls for progress, bookmarks, and reader preferences;
- timer and animation-frame lifecycle.

Extracted components receive typed values and callbacks. They do not read the library store, paginate titles, update progress, or independently enforce navigation rules. This avoids competing sources of truth and keeps later server integration localized to the orchestration boundary.

### 6.2 Pure reader modules

The refactor introduces these focused modules under `src/lib/reader/`:

- `geometry.ts` owns the shared book-depth calculation. Both `BookReader.svelte` and `BookVolume.svelte` consume it.
- `navigation.ts` owns sheet-bound clamping and other small pure navigation calculations proven to be duplicated.
- `sheet-window.ts` selects visible sheet indices and builds their presentation values, including rotation, curl, active state, face visibility, absolute stack depth, and page references.

The existing `easing.ts` remains unchanged. `paginate.ts` remains the source of page models, paper choices, typefaces, page-box sizing, anchor lookup, and free-preview calculations.

### 6.3 Presentation components

Create focused reader components under `src/lib/components/reader/`:

- `ReaderToolbar.svelte` presents progress, bookmark state, contents, preferences, and close controls.
- `ReaderOpeningRig.svelte` presents the cover-opening and cover-closing rig and reports animation completion.
- `ReaderSpread.svelte` presents the slab, bounded page sheets, page faces, shading, spine, and pointer surface.
- `ReaderGuidedPanel.svelte` presents the focused comic panel.
- `ReaderFooter.svelte` presents previous/next controls and folio or panel status.
- `ReaderPaywall.svelte` presents the free-preview boundary and purchase action.

Styles move with the markup they govern so Svelte's style scoping remains useful. Shared stage-level layout tokens may remain in `BookReader.svelte`; component-specific selectors must not remain in the parent after their markup moves.

## 7. Sheet-window behavior

The full pagination result remains available in memory because navigation, contents, anchors, preview calculations, and folio counts need it. The optimization targets per-frame sheet-view calculation and mounted page markup.

During ordinary reading, the sheet window contains indices from `currentSheet - 2` through `currentSheet + 2`, inclusive, clamped to valid sheet indices. It therefore contains at most five sheets and ten page faces. For short books, it contains every valid sheet.

The window must satisfy these invariants:

- At every readable position, the currently visible sheet and the previous sheet are present whenever they exist. The paywall sentinel has no current page face to mount.
- The sheet used by a forward or backward turn remains mounted for the entire animation.
- Rotation and `z-index` use the sheet's absolute index and the book's total sheet count, not its position within the window.
- A direct contents or bookmark jump replaces the window immediately and does not animate through intervening sheets.
- A resize or preference-driven reflow maps the stable reading anchor before deriving the new window.
- Sample mode does not mount page faces beyond the readable preview boundary. The server remains the eventual authorization boundary; this client rule is defense in depth.
- An empty book produces an empty window without invalid page access.
- A current position at the end of the book selects the valid trailing window even though the current sheet index may equal the total sheet count.

The existing slab continues to represent the physical mass of pages outside the window. No placeholder page content is required.

## 8. Interaction and lifecycle behavior

Pointer, keyboard, toolbar, footer, and guided-panel events call actions owned by `BookReader.svelte`. A completed turn updates the sheet, stable anchor, persisted progress, and window as one parent-controlled transition.

Existing input guards remain in force: input during incompatible opening, closing, or in-flight animation states is ignored or settles the current turn according to current behavior. Invalid navigation attempts become bounded no-ops through the shared clamp helper.

Animation-completion callbacks are idempotent. CSS animation events remain the primary completion signal and parent-owned timers remain backstops, so both firing cannot advance the phase twice. The parent continues cancelling its animation frame and clearing timers on unmount. Reduced-motion behavior remains unchanged.

No asynchronous service calls are added, so this refactor does not add a new user-facing error system. Empty page data and invalid internal navigation values are handled by bounded pure helpers and existing empty/null page rendering.

## 9. Duplicate consolidation

The implementation will consolidate:

1. The prose/comic depth formula shared by the reader and volume components.
2. Repeated reader sheet-clamping expressions.
3. Safe cover-palette selection through a small catalog-level `coverPalette` helper consumed by the three existing call sites.

The implementation will not consolidate generic local-storage access, endpoint request parsing, form-field patterns, or visual CSS declarations merely because their syntax resembles one another. Those areas either already have a suitable boundary or are scheduled for replacement.

## 10. Testing and verification

### 10.1 Unit tests

Add Vitest coverage for:

- prose and comic book-depth calculations, including minimum and maximum caps;
- sheet clamping at negative, interior, preview-limited, and end positions;
- sheet-window selection at the beginning, middle, and end of books;
- books shorter than the window and empty books;
- forward and backward active-turn presentation;
- direct jumps and end-position windows;
- preview windows that exclude restricted page content;
- a large synthetic book whose window never exceeds five sheet models;
- absolute sheet keys and stack depth remaining stable across window movement.

Existing pagination and easing tests remain in the verification suite.

### 10.2 Static and build verification

Run `npm run verify`, which includes Svelte type checking, ESLint, Vitest, and the production build.

### 10.3 Manual reader smoke test

Verify both prose and comic titles on desktop and narrow layouts:

- front and back cover presentation;
- open, close-from-start, and close-from-end animations;
- click, drag, keyboard, and footer navigation;
- rapid or interrupted input;
- contents and bookmark jumps;
- preference changes and anchor-preserving reflow;
- saved progress and resume-at-end behavior;
- guided comic panels;
- free-preview paywall and purchase action;
- reduced-motion behavior where available.

Inspect a long synthetic title in the browser and confirm that no more than five `.sheet` elements are mounted during normal reading.

## 11. Implementation sequence

The detailed implementation plan will be written after this design is approved. It will follow this sequence:

1. Add failing characterization tests for geometry, navigation, and sheet-window behavior.
2. Extract pure helpers and update the existing consumers.
3. Replace the all-sheets derived loop with the tested bounded window while the markup remains in `BookReader.svelte`.
4. Verify reader behavior and long-book DOM bounds before splitting presentation components.
5. Extract presentation regions one at a time, moving their scoped styles and verifying after each extraction.
6. Add the small catalog palette helper and migrate its three existing call sites.
7. Run full automated verification and complete the manual reader smoke matrix.

This order separates the performance behavior change from the component moves, making regressions easier to identify.

## 12. Acceptance criteria

- `BookReader.svelte` retains its current public props and owns reader orchestration without component-specific presentation sections.
- Extracted components have focused typed contracts and do not directly access the library store or pagination service.
- The page-turn animation path constructs at most five sheet models rather than iterating over every sheet.
- A normal long-book spread mounts no more than five `.sheet` elements.
- Absolute stack order, page-turn appearance, navigation, anchors, bookmarks, preferences, guided comics, and sample behavior remain consistent.
- Sample rendering does not mount page faces beyond the configured readable boundary.
- The identified book-depth, sheet-clamping, and cover-palette duplication is removed.
- Studio and other soon-to-be-replaced prototype subsystems receive no unrelated refactor.
- `npm run verify` succeeds and the manual reader smoke matrix passes.

## 13. Relationship to the backend roadmap

This refactor should run before backend Plan 5, which connects the storefront and reader to server data. It may run before or alongside earlier backend foundation plans because it does not change persistence or API contracts.

Studio remains scheduled for replacement in backend Plan 4. Deferring its structural cleanup prevents throwaway work. Once this reader refactor is complete, Plan 5 can focus on server-backed catalog data, previews, entitlements, progress, bookmarks, downloads, and revision transitions rather than first untangling the reader presentation layer.
