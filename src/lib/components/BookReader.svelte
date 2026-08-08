<script lang="ts">
  import { untrack } from 'svelte';
  import BookVolume from './BookVolume.svelte';
  import ReaderOpeningRig from './reader/ReaderOpeningRig.svelte';
  import ReaderSpread from './reader/ReaderSpread.svelte';
  import { pageBox, paginate, pageForAnchor, freeSheets, PAPERS, TYPEFACES } from '$lib/paginate';
  import { library } from '$lib/stores/library.svelte';
  import { money, coverBackground } from '$lib/data/catalog';
  import { cubicBezier } from '$lib/reader/easing';
  import { bookDepth } from '$lib/reader/geometry';
  import { clampSheet } from '$lib/reader/navigation';
  import { buildSheetWindow } from '$lib/reader/sheet-window';
  import type {
    EasingFunction,
    PaperId,
    ReaderPhase,
    ReaderProps,
    ReadingAnchor,
    TurnDirection,
    TurnProgress,
    TypefaceId
  } from '$lib/types/reader';

  let { title, sample = false, onclose, onbuy }: ReaderProps = $props();

  let vw = $state(1440);
  let vh = $state(900);

  const initialSheet = untrack(() => library.progress[title.id] ?? 0);
  let sheet = $state(initialSheet);
  let phase = $state<ReaderPhase>(initialSheet > 0 ? 'reading' : 'closed');
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
  let comicMode = $state<'page' | 'panel'>('page');
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

  const narrow = $derived(vw < 900);
  const per = $derived(narrow ? 1 : 2);
  const prefs = $derived(library.prefs);
  // Pagination is derived from this box, so it must NOT vary with reader phase
  // — a different box when the book closes would renumber the whole book.
  const box = $derived(pageBox({ vw, vh, narrow, fontSize: prefs.fontSize }));
  const pages = $derived(paginate(title, box));
  const totalSheets = $derived(Math.ceil(pages.length / per));
  const owned = $derived(library.owns(title.id));
  const sampling = $derived(sample && !owned);
  // freeSheets() returns the LAST readable sheet; one past it is the paywall.
  const readable = $derived(sampling ? freeSheets(title, pages, per) : totalSheets);
  const limit = $derived(sampling ? Math.min(totalSheets, readable + 1) : totalSheets);
  const paywalled = $derived(sampling && sheet > readable && totalSheets > readable);
  const paper = $derived(PAPERS[prefs.paper]);
  const isComic = $derived(title.kind === 'comic');
  const guided = $derived(isComic && comicMode === 'panel');

  const bookW = $derived(narrow ? box.pw : box.pw * 2);
  const progress = $derived(
    phase === 'closed' && flipped ? 1 : totalSheets ? Math.min(1, sheet / totalSheets) : 0
  );
  const bookmarks = $derived(library.bookmarksFor(title.id));

  // Closed book: thickness scales with the page count, capped so a long novel
  // still reads as a book rather than a brick. A comic is a stapled issue, not
  // a bound volume, so it stays thin however many pages it runs to.
  const depth = $derived(bookDepth(title.kind, pages.length));
  // The closed footer is taller than the reading one, so the volume is sized
  // down here rather than shrinking the page box (which would repaginate).
  const coverBase = $derived(box.ph - 42);
  const coverW = $derived(Math.round(coverBase * 0.73 * 1.04));
  const coverH = $derived(Math.round(coverBase * 1.02));
  const boardArt = $derived(coverBackground(title.cover, title.coverUrl));

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
  const panelCount = $derived(pages[currentPage]?.layout?.length || 1);
  const panelCell = $derived(pages[currentPage]?.layout?.[panelIdx % panelCount] || null);
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

  function commit(n: number): void {
    const next = clampSheet(n, totalSheets, limit);
    sheet = next;
    recordAnchor();
    library.setProgress(title.id, next, anchor);
  }

  // Reflow renumbers the whole book: at a narrower size a 30-page novel becomes
  // 52 pages, and the stored sheet index then points somewhere else entirely.
  // The reader's position in the text is what gets kept.
  let anchor: ReadingAnchor | null = untrack(() => library.anchorFor(title.id));

  function recordAnchor(): void {
    const p = pages[Math.min(pages.length - 1, sheet * per)];
    if (p) anchor = { chapter: p.chapter, at: p.at || 0 };
  }

  $effect(() => {
    const currentPages = pages;
    const currentPer = per;
    untrack(() => {
      if (!anchor) {
        recordAnchor();
        return;
      }
      const next = clampSheet(
        Math.floor(pageForAnchor(currentPages, anchor) / currentPer),
        totalSheets,
        limit
      );
      if (next !== sheet) {
        sheet = next;
        library.setProgress(title.id, next, anchor);
      }
    });
  });

  /** A jump (contents, bookmark) lands flat — it is not one page turning. */
  function go(n: number): void {
    cancelAnimationFrame(raf);
    turning = null;
    drag = null;
    commit(n);
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
    // Turning back past the first spread closes the book again.
    if (dir < 0 && sheet === 0) {
      startClosing();
      return;
    }
    if (guided) return turnPanel(dir);
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
    const count = (pageNumber: number): number => pages[pageNumber]?.layout?.length || 1;
    if (i >= count(p)) {
      if (p + 1 >= pages.length) {
        if (limit >= totalSheets) {
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
    recordAnchor();
    library.setProgress(title.id, nextSheet, anchor);
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

  $effect(() => () => {
    cancelAnimationFrame(raf);
    clearTimeout(flipTimer);
    clearTimeout(openTimer);
  });

  function jumpToChapter(ci: number): void {
    const idx = Math.max(0, pages.findIndex((p) => p.chapter === ci));
    go(Math.floor(idx / per));
    tocOpen = false;
  }
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} onkeydown={onKeydown} />

<div
  class="shell"
  class:dim={prefs.paper === 'dim'}
  style:background={prefs.paper === 'dim' ? 'oklch(0.16 0.01 262)' : 'var(--bg)'}
>
  <div class="toolbar">
    <button class="tool" onclick={() => onclose?.()}>&larr; Close</button>
    <button class="tool" onclick={() => (tocOpen = !tocOpen)}>Contents</button>
    <button
      class="tool"
      class:on={bookmarks.includes(sheet)}
      onclick={() => library.toggleBookmark(title.id, sheet)}
    >
      {bookmarks.includes(sheet) ? '\u25C6' : '\u25C7'}{narrow ? '' : bookmarks.includes(sheet) ? ' Bookmarked' : ' Bookmark'}
    </button>

    <div class="title">{title.title}</div>

    {#if isComic}
      <button class="pill" onclick={() => { comicMode = guided ? 'page' : 'panel'; panelIdx = 0; pageIdx = sheet * per; }}>
        {guided ? 'Guided view' : 'Page view'}
      </button>
    {:else if !title.fixed}
      <button class="tool" onclick={() => (controlsOpen = !controlsOpen)}>Aa</button>
    {/if}

    <span class="pct">{Math.round(progress * 100)}%</span>
  </div>

  <div class="rail"><div class="fill" style:width="{progress * 100}%"></div></div>

  <div class="stage">
    <!-- edge hit zones: tap left / right like a real page -->
    <button class="edge left" aria-label="Previous page" onclick={() => turn(-1)}></button>
    <button class="edge right" aria-label="Next page" onclick={() => turn(1)}></button>

    {#if tocOpen}
      <aside class="drawer">
        <div class="mono">Contents</div>
        {#each title.chapters || [] as ch, ci (ch.title)}
          <button class="toc-row" onclick={() => jumpToChapter(ci)}>
            <span>{ch.title}</span>
            <span class="mono plain">ch {ci + 1}</span>
          </button>
        {/each}
        <div class="mono" style="margin-top: 26px">Bookmarks</div>
        {#each bookmarks as b (b)}
          <button class="toc-row" onclick={() => { go(b); tocOpen = false; }}>
            <span>Page {b * per + 1}</span>
            <span style="color: var(--accent)">&#9670;</span>
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
          <button class="mini" onclick={() => library.setPref('fontSize', Math.max(14, prefs.fontSize - 1))}>A&minus;</button>
          <button class="mini big" onclick={() => library.setPref('fontSize', Math.min(24, prefs.fontSize + 1))}>A+</button>
        </div>

        <div class="mono">Typeface</div>
        <div class="stack">
          {#each typefaceIds as key (key)}
            <button
              class="mini"
              class:on={prefs.typeface === key}
              style:font-family={TYPEFACES[key].css}
              onclick={() => library.setPref('typeface', key)}
            >
              {TYPEFACES[key].label}
            </button>
          {/each}
        </div>

        <div class="mono">Paper</div>
        <div class="row">
          {#each paperIds as key (key)}
            <button
              class="mini paper"
              class:on={prefs.paper === key}
              style:background={PAPERS[key].bg}
              style:color={PAPERS[key].ink}
              onclick={() => library.setPref('paper', key)}
            >
              {PAPERS[key].label}
            </button>
          {/each}
        </div>
      </aside>
    {/if}

    {#if phase === 'closed'}
      <!-- Closed book: front board, spine, page block, flip to the back cover -->
      <div class="case">
        <BookVolume
          {title}
          width={coverW}
          height={coverH}
          {depth}
          pageCount={pages.length}
          {flipped}
          {flipping}
          onclick={openBook}
          label="Open {title.title}"
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
      <!-- Guided view: one panel at a time, framed to the panel's own aspect -->
      <button
        class="single-panel"
        style:height="{panelH}px"
        style:width="min(80vw, {Math.round(panelH * (panelCell ? (panelCell.c / panelCell.r) * 1.15 : 1.4))}px)"
        onclick={() => turn(1)}
      >
        <span class="art"></span>
        <span class="cap">{panelCell?.cap}</span>
      </button>
    {:else}
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
    {/if}

    {#if paywalled}
      <div class="paywall">
        <div class="card">
          <div class="mono accent">End of the free {isComic ? 'preview' : 'chapter'}</div>
          <h3 class="display">{title.title}</h3>
          <p>Keep going for {money(title.price)}. Yours forever, in the browser or as a file.</p>
          <button class="btn" onclick={() => onbuy?.()}>Buy the whole {isComic ? 'issue' : 'book'}</button>
          <button class="link" onclick={() => onclose?.()}>Not now</button>
        </div>
      </div>
    {/if}
  </div>

  {#if phase === 'closed'}
    <div class="nav">
      <button class="btn nowrap" onclick={openBook}>Open the {isComic ? 'comic' : 'book'}</button>
      <button class="btn ghost nowrap" onclick={flipCover}>
        {flipped ? 'Front cover' : 'Back cover'}
      </button>
    </div>
  {:else}
    <div class="nav">
      <button class="round" aria-label="Previous" onclick={() => turn(-1)}>&lsaquo;</button>
      <span class="folio mono plain">
        {#if guided}
          Page {currentPage + 1} &middot; panel {panelIdx + 1} of {panelCount}
        {:else if leftFolio && rightFolio}
          Pages {leftFolio}&ndash;{rightFolio} of {pages.length}
        {:else}
          Page {leftFolio || rightFolio || pages.length} of {pages.length}
        {/if}
      </span>
      <button class="round" aria-label="Next" onclick={() => turn(1)}>&rsaquo;</button>
    </div>
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

  /* The toolbar is one row that must never be wider than the screen: when it
     overflows it drags the whole stage off-centre and the page reads as cut
     off at the edge. */
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

  /* guided comic view -------------------------------------------------- */
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

  /* drawers ------------------------------------------------------------ */
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

  .toc-row:hover {
    color: var(--accent);
  }

  .empty {
    font-size: 13px;
    color: var(--muted);
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

  /* paywall ------------------------------------------------------------ */
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

  /* nav ---------------------------------------------------------------- */
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
