<script lang="ts">
  import { untrack } from 'svelte';
  import BookVolume from './BookVolume.svelte';
  import ReaderDrawers from './reader/ReaderDrawers.svelte';
  import ReaderFooter from './reader/ReaderFooter.svelte';
  import ReaderGuidedPanel from './reader/ReaderGuidedPanel.svelte';
  import ReaderOpeningRig from './reader/ReaderOpeningRig.svelte';
  import ReaderPaywall from './reader/ReaderPaywall.svelte';
  import ReaderSpread from './reader/ReaderSpread.svelte';
  import ReaderToolbar from './reader/ReaderToolbar.svelte';
  import { pageBox, PAPERS, TYPEFACES } from '$lib/paginate';
  import { coverBackground } from '$lib/cover-art';
  import { cubicBezier } from '$lib/reader/easing';
  import { bookDepth } from '$lib/reader/geometry';
  import { locationForPage, pageIndexForLocation } from '$lib/reader/locations';
  import { clampSheet } from '$lib/reader/navigation';
  import {
    progressKeepaliveFor,
    type ReaderPersistence
  } from '$lib/reader/persistence';
  import {
    createProgressSynchronizer,
    type ProgressSyncState
  } from '$lib/reader/progress-sync';
  import { paginatePublication } from '$lib/reader/publication-pagination';
  import { buildSheetWindow } from '$lib/reader/sheet-window';
  import type { ReaderInitialStateDto, ReaderLocation } from '$lib/types/library';
  import type { ReaderDocument } from '$lib/types/publication';
  import type {
    EasingFunction,
    PaperId,
    ReaderPhase,
    TurnDirection,
    TurnProgress,
    TypefaceId
  } from '$lib/types/reader';

  interface Props {
    document: ReaderDocument;
    persistence: ReaderPersistence;
    onclose?: () => void;
    onbuy?: () => void;
  }

  let { document, persistence, onclose, onbuy }: Props = $props();
  const persistenceAdapter = untrack(() => persistence);

  const initialState: ReaderInitialStateDto = persistenceAdapter.getInitialState();
  let readerState = $state(initialState);
  let syncState = $state<ProgressSyncState>({
    status: 'idle',
    progress: initialState.progress,
    error: null
  });
  let currentLocation = $state<ReaderLocation | null>(initialState.progress?.location ?? null);
  const progressKeepalive = progressKeepaliveFor(persistenceAdapter);
  const progressSync = createProgressSynchronizer({
    persistence: persistenceAdapter,
    initialProgress: initialState.progress,
    onState: (next) => {
      syncState = next;
      if (next.status === 'conflict' && next.progress) {
        currentLocation = next.progress.location;
      }
    },
    ...(progressKeepalive ? { keepalive: progressKeepalive } : {})
  });
  const chapters = $derived(
    document.format === 'prose'
      ? document.sections.map((section) => ({
          title: section.label ?? `Section ${section.ordinal + 1}`
        }))
      : []
  );

  let vw = $state(1440);
  let vh = $state(900);

  let sheet = $state(0);
  let phase = $state<ReaderPhase>(initialState.progress ? 'reading' : 'closed');
  let flipped = $state(false);
  let flipping = $state(false);
  let flipTimer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;

  // Opening: settle the volume square, then swing the front board off the
  // spine onto the table, revealing page one underneath.
  function openBook() {
    if (phase !== 'closed') return;
    // Resuming at the end? Open the BACK board onto the last page instead of
    // playing the front-cover opening and then snapping.
    if (sheet >= totalSheets && totalSheets > 0) {
      startOpeningEnd();
      return;
    }
    if (flipped) {
      // On the back cover: turn to the front first, then open from there.
      flipped = false;
      flipping = true;
      clearTimeout(flipTimer);
      flipTimer = setTimeout(() => {
        flipping = false;
        startOpening();
      }, 940);
      return;
    }
    startOpening();
  }

  function startOpening() {
    phase = 'opening';
    clearTimeout(openTimer);
    // Backstop only: the animation settles itself via onanimationend.
    openTimer = setTimeout(settleOpen, 1400);
  }

  function startOpeningEnd() {
    phase = 'openingEnd';
    flipped = false;
    flipping = false;
    clearTimeout(openTimer);
    openTimer = setTimeout(settleOpenEnd, 1400);
  }

  function settleOpenEnd() {
    if (phase === 'openingEnd') phase = 'reading';
  }

  function startClosingEnd() {
    // At the end the back board is lying open on the right, so it swings left
    // over the last page and lands as the back cover.
    phase = 'closingEnd';
    flipping = false;
    drag = null;
    clearTimeout(openTimer);
    openTimer = setTimeout(settleCloseEnd, 1400);
  }

  function settleCloseEnd() {
    if (phase !== 'closingEnd') return;
    phase = 'closed';
    flipped = true;
  }

  function startClosing() {
    phase = 'closing';
    flipped = false;
    flipping = false;
    drag = null;
    clearTimeout(openTimer);
    openTimer = setTimeout(settleClose, 1400);
  }

  function settleClose() {
    if (phase === 'closing') phase = 'closed';
  }

  // animationend is the primary trigger so a throttled timer can never leave
  // the book stuck half-open.
  function settleOpen() {
    if (phase !== 'opening') return;
    phase = 'reading';
  }

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

  // Face visibility is driven from state, not backface culling (which does not
  // reliably cull here) — swap at the midpoint of the 0.9s turn.
  function flipCover() {
    flipped = !flipped;
    flipping = true;
    clearTimeout(flipTimer);
    flipTimer = setTimeout(() => (flipping = false), 900);
  }
  let drag = $state<TurnProgress | null>(null);
  // A turn in flight, advanced frame by frame from JS. A CSS transition moves
  // the rotation but leaves curl, lift and shading frozen at their resting
  // values, so a clicked turn arrived with none of the lighting a dragged one
  // has. One driver, one set of numbers, both paths.
  let turning = $state<TurnProgress | null>(null);
  let tocOpen = $state(false);
  let controlsOpen = $state(false);

  // comic guided view
  let comicMode = $state<'page' | 'panel'>(
    initialState.titlePreferences?.comicMode === 'guided' ? 'panel' : 'page'
  );
  let pageIdx = $state<number | null>(null);
  let panelIdx = $state(0);

  let startX = 0;
  let fromSide: TurnDirection = 1;
  let halfWidth = 1;
  let raf = 0;

  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // A page under a hand: slow to break off the stack, quick through the arc,
  // settles onto the other side.
  const easeTurn = cubicBezier(0.22, 0.61, 0.28, 1);
  // Let go mid-drag and the page already carries speed — it only decelerates.
  const easeDrop = cubicBezier(0.16, 0.78, 0.32, 1);
  // A page that did not make it falls back against the stack.
  const easeBack = cubicBezier(0.3, 0.86, 0.45, 1);

  const typefaceIds: readonly TypefaceId[] = ['serif', 'sans', 'georgia'];
  const paperIds: readonly PaperId[] = ['white', 'sepia', 'dim'];
  const typefaceOptions = typefaceIds.map((id) => ({ id, ...TYPEFACES[id] }));
  const paperOptions = paperIds.map((id) => ({ id, ...PAPERS[id] }));

  const narrow = $derived(vw < 900);
  const per = $derived(narrow ? 1 : 2);
  const prefs = $derived(readerState.preferences);
  // Pagination is derived from this box, so it must NOT vary with reader phase
  // — a different box when the book closes would renumber the whole book.
  const box = $derived(pageBox({ vw, vh, narrow, fontSize: prefs.fontSize }));
  const pages = $derived(paginatePublication(document, box));
  const totalSheets = $derived(Math.ceil(pages.length / per));
  const sampling = $derived(document.access === 'preview');
  // The server has already truncated the document to its reviewed preview
  // boundary. One step beyond the final returned sheet opens the paywall.
  const readable = $derived(sampling ? Math.max(0, totalSheets - 1) : totalSheets);
  const limit = $derived(totalSheets);
  const paywalled = $derived(sampling && totalSheets > 0 && sheet > readable);
  const paper = $derived(PAPERS[prefs.paper]);
  const isComic = $derived(document.format === 'comic');
  const hasGuidedView = $derived(document.format === 'comic' && document.guidedViewEnabled);
  const guided = $derived(hasGuidedView && comicMode === 'panel');

  const bookW = $derived(narrow ? box.pw : box.pw * 2);
  const progress = $derived(
    phase === 'closed' && flipped ? 1 : totalSheets ? Math.min(1, sheet / totalSheets) : 0
  );
  const bookmarkViews = $derived(
    readerState.bookmarks.flatMap((bookmark) => {
      const pageIndex = pageIndexForLocation(document, pages, bookmark.location);
      return pageIndex === null ? [] : [{ id: bookmark.id, sheet: Math.floor(pageIndex / per) }];
    })
  );
  const currentBookmark = $derived(
    currentLocation
      ? readerState.bookmarks.find(
          (bookmark) => JSON.stringify(bookmark.location) === JSON.stringify(currentLocation)
        )
      : undefined
  );

  // Closed book: thickness scales with the page count, capped so a long novel
  // still reads as a book rather than a brick. A comic is a stapled issue, not
  // a bound volume, so it stays thin however many pages it runs to.
  const depth = $derived(bookDepth(isComic ? 'comic' : 'novel', pages.length));
  // The closed footer is taller than the reading one, so the volume is sized
  // down here rather than shrinking the page box (which would repaginate).
  const coverBase = $derived(box.ph - 42);
  const coverW = $derived(Math.round(coverBase * 0.73 * 1.04));
  const coverH = $derived(Math.round(coverBase * 1.02));
  const boardArt = $derived(coverBackground(document.titleId));

  // Visible folios: left is the back of the previous sheet, right the front of
  // this one. Sheet 0 shows page 1 alone on the right, like an opened book.
  const leftFolio = $derived(per === 2 && sheet > 0 && sheet * per <= pages.length ? sheet * per : 0);
  const rightFolio = $derived(
    per === 1
      ? Math.min(pages.length, sheet + 1)
      : sheet * per + 1 <= pages.length
        ? sheet * per + 1
        : 0
  );

  const currentPage = $derived(
    Math.min(Math.max(0, pages.length - 1), pageIdx === null ? sheet * per : pageIdx)
  );
  const comicPage = $derived(
    pages[currentPage]?.type === 'comic' ? pages[currentPage] : null
  );
  const panelCount = $derived(comicPage?.panels?.length || 1);
  const panelRegion = $derived(comicPage?.panels?.[panelIdx % panelCount] ?? null);
  const panelH = $derived(Math.max(260, Math.min(600, vh - 250)));

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

  function locationAt(pageIndex: number): ReaderLocation | null {
    if (document.format === 'comic' && guided) {
      const source = document.pages[pageIndex];
      const panel = source?.panels[panelIdx % Math.max(1, source.panels.length)];
      if (source && panel) {
        return { format: 'comic', pageId: source.id, panelOrdinal: panel.ordinal };
      }
    }
    return locationForPage(document, pages, pageIndex, guided ? 'guided' : 'page');
  }

  function recordLocation(pageIndex = Math.min(pages.length - 1, sheet * per)): void {
    const next = locationAt(pageIndex);
    if (!next) return;
    currentLocation = next;
    progressSync.navigate(next);
  }

  function commit(n: number): void {
    const next = clampSheet(n, totalSheets, limit);
    sheet = next;
    pageIdx = null;
    recordLocation(Math.min(pages.length - 1, next * per));
  }

  $effect(() => {
    const currentPages = pages;
    const currentPer = per;
    const location = currentLocation;
    untrack(() => {
      if (!location) return;
      const pageIndex = pageIndexForLocation(document, currentPages, location);
      if (pageIndex === null) return;
      sheet = clampSheet(Math.floor(pageIndex / currentPer), totalSheets, limit);
      if (location.format === 'comic') {
        pageIdx = pageIndex;
        const source = document.format === 'comic'
          ? document.pages.find((page) => page.id === location.pageId)
          : undefined;
        panelIdx = location.panelOrdinal === null
          ? 0
          : Math.max(0, source?.panels.findIndex((panel) => panel.ordinal === location.panelOrdinal) ?? 0);
      }
    });
  });

  /** A jump (contents, bookmark) lands flat — it is not one page turning. */
  function go(n: number): void {
    cancelAnimationFrame(raf);
    turning = null;
    drag = null;
    commit(n);
    void progressSync.flush();
  }

  function goToBookmark(bookmark: { id: string; sheet: number }): void {
    go(bookmark.sheet);
    tocOpen = false;
  }

  /** Land a turn already in flight so the next input is never dropped. */
  function settleTurn(): void {
    if (!turning) return;
    const d = turning.dir;
    cancelAnimationFrame(raf);
    turning = null;
    commit(sheet + d);
  }

  function runTurn(
    dir: TurnDirection,
    from: number,
    to: number,
    ease: EasingFunction,
    ms: number,
    land: boolean
  ): void {
    cancelAnimationFrame(raf);
    drag = null;
    if (reduced) {
      turning = null;
      if (land) commit(sheet + dir);
      return;
    }
    const span = to - from;
    // Released three-quarters of the way over, a page has a quarter of the
    // arc left — and should take a quarter of the time, not the full turn.
    const dur = Math.max(120, ms * Math.abs(span));
    const t0 = performance.now();
    turning = { dir, t: from };
    // Read the clock here rather than trusting the frame timestamp: a patched
    // requestAnimationFrame can hand back a different time base, which lands
    // the whole turn on the first frame.
    const step = (): void => {
      const p = Math.min(1, (performance.now() - t0) / dur);
      turning = { dir, t: from + span * ease(p) };
      if (p < 1) {
        raf = requestAnimationFrame(step);
        return;
      }
      turning = null;
      if (land) commit(sheet + dir);
    };
    raf = requestAnimationFrame(step);
  }

  function turn(dir: TurnDirection): void {
    if (phase === 'closed') {
      if (dir > 0) openBook();
      return;
    }
    if (phase !== 'reading') return;
    settleTurn();
    if (guided) return turnPanel(dir);
    // Turning back past the first spread closes the book again.
    if (dir < 0 && sheet === 0) {
      startClosing();
      return;
    }
    // At sheet k the visible spread is [back of k-1 | front of k], so the last
    // page only shows once every sheet is turned: sheet === totalSheets.
    if (dir > 0 && !sampling && sheet >= totalSheets) {
      startClosingEnd();
      return;
    }
    if (clampSheet(sheet + dir, totalSheets, limit) === sheet) return;
    runTurn(dir, 0, 1, easeTurn, 720, true);
  }

  function turnPanel(dir: TurnDirection): void {
    let p = currentPage;
    let i = panelIdx + dir;
    const count = (pageNumber: number): number => {
      const page = pages[pageNumber];
      return page?.type === 'comic' ? page.panels?.length || 1 : 1;
    };
    if (i >= count(p)) {
      if (p + 1 >= pages.length) {
        if (sampling) {
          sheet = totalSheets;
        } else {
          phase = 'closed';
          flipped = true;
          flipping = false;
        }
        return;
      }
      p += 1;
      i = 0;
    } else if (i < 0) {
      if (p === 0) {
        phase = 'closed';
        flipped = false;
        flipping = false;
        return;
      }
      p -= 1;
      i = count(p) - 1;
    }
    const nextSheet = Math.floor(p / per);
    if (nextSheet > readable) {
      sheet = Math.min(totalSheets, readable + 1);
      return;
    }
    pageIdx = p;
    panelIdx = i;
    sheet = nextSheet;
    recordLocation(p);
  }

  function toggleGuided(): void {
    comicMode = guided ? 'page' : 'panel';
    panelIdx = 0;
    pageIdx = sheet * per;
    const nextMode = comicMode === 'panel' ? 'guided' : 'page';
    void persistenceAdapter
      .saveTitlePreferences({
        comicMode: nextMode,
        expectedVersion: readerState.titlePreferences?.version ?? 0
      })
      .then((value) => {
        readerState.titlePreferences = value;
      })
      .catch(() => {});
    recordLocation(pageIdx);
  }

  async function toggleBookmark(): Promise<void> {
    await progressSync.flush();
    const location = currentLocation ?? locationAt(currentPage);
    if (!location) return;
    if (currentBookmark) {
      await persistenceAdapter.deleteBookmark(currentBookmark.id);
      readerState.bookmarks = readerState.bookmarks.filter(
        (bookmark) => bookmark.id !== currentBookmark.id
      );
      return;
    }
    const bookmark = await persistenceAdapter.createBookmark(location);
    if (!readerState.bookmarks.some((candidate) => candidate.id === bookmark.id)) {
      readerState.bookmarks = [...readerState.bookmarks, bookmark];
    }
  }

  async function updatePreferences(
    values: Partial<Pick<ReaderInitialStateDto['preferences'], 'fontSize' | 'typeface' | 'paper'>>
  ): Promise<void> {
    const value = await persistenceAdapter.savePreferences({
      fontSize: values.fontSize ?? prefs.fontSize,
      typeface: values.typeface ?? prefs.typeface,
      paper: values.paper ?? prefs.paper,
      expectedVersion: prefs.version
    });
    readerState.preferences = value;
  }

  async function acknowledgeMigration(): Promise<void> {
    const notice = readerState.migrationNotice;
    if (!notice) return;
    await persistenceAdapter.acknowledgeMigration(notice.targetRevisionId);
    readerState.migrationNotice = { ...notice, acknowledged: true };
  }

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

  function onPointerMove(event: PointerEvent): void {
    if (!drag) return;
    const dx = event.clientX - startX;
    const t = Math.max(0, Math.min(1, (fromSide === 1 ? -dx : dx) / halfWidth));
    drag = { dir: fromSide, t };
  }

  function onPointerUp(): void {
    if (!drag) return;
    const { dir, t } = drag;
    drag = null;
    const fallBack = (): void => {
      if (t > 0.01) runTurn(dir, t, 0, easeBack, 420, false);
    };
    if (t <= 0.28) return fallBack();
    // Dragging off either end of the book closes it rather than turning.
    if ((dir < 0 && sheet === 0) || (dir > 0 && !sampling && sheet >= totalSheets)) {
      turn(dir);
      return;
    }
    if (clampSheet(sheet + dir, totalSheets, limit) === sheet) return fallBack();
    runTurn(dir, t, 1, easeDrop, 620, true);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowRight') turn(1);
    if (event.key === 'ArrowLeft') turn(-1);
    if (event.key === 'Escape') onclose?.();
  }

  const syncMessage = $derived(
    syncState.status === 'pending'
      ? 'Saving reading position'
      : syncState.status === 'retrying'
        ? 'Retrying reading position save'
        : syncState.status === 'failed'
          ? 'Reading position was not saved'
          : syncState.status === 'conflict'
            ? 'Reading position changed on another device; the latest saved position is shown'
            : syncState.status === 'synced'
              ? 'Reading position saved'
              : ''
  );

  $effect(() => () => {
    cancelAnimationFrame(raf);
    clearTimeout(flipTimer);
    clearTimeout(openTimer);
    progressSync.dispose();
  });

  function jumpToChapter(ci: number): void {
    const idx = Math.max(0, pages.findIndex((p) => p.chapter === ci));
    go(Math.floor(idx / per));
    tocOpen = false;
  }
</script>

<svelte:window
  bind:innerWidth={vw}
  bind:innerHeight={vh}
  onkeydown={onKeydown}
  onpagehide={() => progressSync.dispose()}
/>

<div
  class="shell"
  class:dim={prefs.paper === 'dim'}
  style:background={prefs.paper === 'dim' ? 'oklch(0.16 0.01 262)' : 'var(--bg)'}
>
  <ReaderToolbar
    title={document.title}
    isComic={hasGuidedView}
    isFixed={false}
    {narrow}
    bookmarked={Boolean(currentBookmark)}
    {guided}
    {progress}
    onclose={() => onclose?.()}
    oncontents={() => (tocOpen = !tocOpen)}
    onbookmark={() => void toggleBookmark()}
    onguided={toggleGuided}
    oncontrols={() => (controlsOpen = !controlsOpen)}
  />

  <div class="stage">
    <!-- edge hit zones: tap left / right like a real page -->
    <button class="edge left" aria-label="Previous page" onclick={() => turn(-1)}></button>
    <button class="edge right" aria-label="Next page" onclick={() => turn(1)}></button>

    <ReaderDrawers
      contentsOpen={tocOpen}
      {controlsOpen}
      {chapters}
      bookmarks={bookmarkViews}
      {per}
      {prefs}
      typefaces={typefaceOptions}
      papers={paperOptions}
      onchapter={jumpToChapter}
      onbookmark={goToBookmark}
      onfontsize={(fontSize) => void updatePreferences({ fontSize })}
      ontypeface={(typeface) => void updatePreferences({ typeface })}
      onpaper={(nextPaper) => void updatePreferences({ paper: nextPaper })}
    />

    {#if phase === 'closed'}
      <!-- Closed book: front board, spine, page block, flip to the back cover -->
      <div class="case">
        <BookVolume
          title={document.title}
          format={document.format}
          coverSeed={document.titleId}
          width={coverW}
          height={coverH}
          {depth}
          pageCount={pages.length}
          {flipped}
          {flipping}
          onclick={openBook}
          label="Open {document.title}"
        />
      </div>
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
    {:else if guided}
      <ReaderGuidedPanel
        height={panelH}
        imageUrl={comicPage?.imageUrl ?? ''}
        pageWidth={comicPage?.imageWidth ?? 1}
        pageHeight={comicPage?.imageHeight ?? 1}
        panel={panelRegion}
        onnext={() => turn(1)}
      />
    {:else}
      <ReaderSpread
        title={document.title}
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
    {/if}

    {#if paywalled}
      <ReaderPaywall
        {isComic}
        title={document.title}
        onbuy={() => onbuy?.()}
        onclose={() => onclose?.()}
      />
    {/if}
  </div>

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

  <p class="reader-status" aria-live="polite">{syncMessage}</p>
  {#if readerState.migrationNotice && !readerState.migrationNotice.acknowledged}
    <aside class="edition-notice" aria-live="polite">
      <span>
        Your saved position was checked against this edition
        {readerState.migrationNotice.progress === 'reset' ? ' and reset to the beginning' : ''}.
      </span>
      <button type="button" onclick={() => void acknowledgeMigration()}>Dismiss</button>
    </aside>
  {/if}
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    min-height: calc(100vh - 68px);
  }

  /* Dim paper darkens the whole reading room, so re-scope the neutral tokens
     too — otherwise light-theme ink sits on a dark stage. */
  .shell.dim {
    --bg: oklch(0.16 0.01 262);
    --surface: oklch(0.205 0.012 262);
    --raised: oklch(0.245 0.014 262);
    --ink: oklch(0.93 0.008 262);
    --muted: oklch(0.66 0.012 262);
    --line: oklch(0.31 0.014 262);
    color: var(--ink);
  }

  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: 26px 16px 34px;
  }

  .edge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 8%;
    z-index: 12;
    border: 0;
    background: transparent;
  }

  .edge.left {
    left: 0;
    cursor: w-resize;
  }

  .edge.right {
    right: 0;
    cursor: e-resize;
  }

  /* closed book ------------------------------------------------------- */
  .case {
    display: flex;
    align-items: center;
    justify-content: center;
    perspective: 2200px;
    perspective-origin: 50% 45%;
  }

  .reader-status {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .edition-notice {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 10px 18px;
    border-top: 1px solid var(--line);
    background: var(--surface);
    color: var(--muted);
    font-size: 13px;
  }

  .edition-notice button {
    border: 0;
    background: none;
    color: var(--accent);
    cursor: pointer;
  }

</style>
