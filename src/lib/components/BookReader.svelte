<script>
  import { untrack } from 'svelte';
  import PageFace from './PageFace.svelte';
  import BookVolume from './BookVolume.svelte';
  import { pageBox, paginate, pageForAnchor, freeSheets, PAPERS, TYPEFACES } from '$lib/paginate';
  import { library } from '$lib/stores/library.svelte.js';
  import { money, coverBackground } from '$lib/data/catalog';

  /**
   * The reader. Handles: two-page spread on desktop / single page on mobile,
   * 3D page turns with drag + swipe + keys, contents drawer, bookmarks,
   * type controls, comic page-vs-panel view, and the free-sample paywall.
   *
   * @type {{ title: any, sample?: boolean, onclose?: () => void, onbuy?: () => void }}
   */
  let { title, sample = false, onclose, onbuy } = $props();

  let vw = $state(1440);
  let vh = $state(900);

  let sheet = $state(library.progress[title.id] || 0);
  let phase = $state((library.progress[title.id] || 0) > 0 ? 'reading' : 'closed');
  let flipped = $state(false);
  let flipping = $state(false);
  let flipTimer;
  let openTimer;

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

  // Face visibility is driven from state, not backface culling (which does not
  // reliably cull here) — swap at the midpoint of the 0.9s turn.
  function flipCover() {
    flipped = !flipped;
    flipping = true;
    clearTimeout(flipTimer);
    flipTimer = setTimeout(() => (flipping = false), 900);
  }
  let drag = $state(null); // { dir: 1 | -1, t: 0..1 }
  // A turn in flight, advanced frame by frame from JS. A CSS transition moves
  // the rotation but leaves curl, lift and shading frozen at their resting
  // values, so a clicked turn arrived with none of the lighting a dragged one
  // has. One driver, one set of numbers, both paths.
  let turning = $state(null); // { dir, t: 0..1 }
  let tocOpen = $state(false);
  let controlsOpen = $state(false);

  // comic guided view
  let comicMode = $state('page'); // 'page' | 'panel'
  let pageIdx = $state(null);
  let panelIdx = $state(0);

  let startX = 0;
  let fromSide = 1;
  let halfWidth = 1;
  let raf = 0;

  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** The CSS cubic-bezier curve, solved in JS (Newton, 5 passes is plenty). */
  function bezier(x1, y1, x2, y2) {
    const A = (a, b) => 1 - 3 * b + 3 * a;
    const B = (a, b) => 3 * b - 6 * a;
    const at = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + 3 * a) * t;
    const slope = (t, a, b) => (3 * A(a, b) * t + 2 * B(a, b)) * t + 3 * a;
    return (x) => {
      let t = x;
      for (let i = 0; i < 5; i++) {
        const d = slope(t, x1, x2);
        if (!d) break;
        t -= (at(t, x1, x2) - x) / d;
      }
      return at(t, y1, y2);
    };
  }

  // A page under a hand: slow to break off the stack, quick through the arc,
  // settles onto the other side.
  const easeTurn = bezier(0.22, 0.61, 0.28, 1);
  // Let go mid-drag and the page already carries speed — it only decelerates.
  const easeDrop = bezier(0.16, 0.78, 0.32, 1);
  // A page that did not make it falls back against the stack.
  const easeBack = bezier(0.3, 0.86, 0.45, 1);

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
  const depth = $derived(
    isComic
      ? Math.max(5, Math.min(11, Math.round(pages.length * 0.5)))
      : Math.max(16, Math.min(58, Math.round(pages.length * 0.9) + 10))
  );
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

  /** Sheets, with their live rotation + shading. */
  const sheets = $derived.by(() => {
    const list = [];
    const g = drag || turning;
    for (let k = 0; k < totalSheets; k++) {
      const flipped = k < sheet;
      let angle = flipped ? -180 : 0;
      if (g) {
        if (g.dir === 1 && k === sheet) angle = -180 * g.t;
        if (g.dir === -1 && k === sheet - 1) angle = -180 * (1 - g.t);
      }
      const active = !!g && (k === sheet || k === sheet - 1);
      const curl = Math.sin((Math.abs(angle) / 180) * Math.PI);
      const settled = !g;
      list.push({
        k,
        angle,
        curl,
        active,
        // While it swings, the moving sheet clears both stacks: past halfway it
        // is over pages whose resting z is higher than its own.
        z: active ? totalSheets + 3 : flipped ? k + 1 : totalSheets - k + 1,
        showFront: settled ? angle > -90 : true,
        showBack: settled ? angle <= -90 : true,
        front: pages[k * per] || null,
        back: per === 2 ? pages[k * per + 1] || null : null
      });
    }
    return list;
  });

  function commit(n) {
    const next = Math.max(0, Math.min(Math.min(totalSheets, limit), n));
    sheet = next;
    recordAnchor();
    library.setProgress(title.id, next, anchor);
  }

  // Reflow renumbers the whole book: at a narrower size a 30-page novel becomes
  // 52 pages, and the stored sheet index then points somewhere else entirely.
  // The reader's position in the text is what gets kept.
  let anchor = library.anchorFor(title.id);

  function recordAnchor() {
    const p = pages[Math.min(pages.length - 1, sheet * per)];
    if (p) anchor = { chapter: p.chapter, at: p.at || 0 };
  }

  $effect(() => {
    pages;
    per;
    untrack(() => {
      if (!anchor) {
        recordAnchor();
        return;
      }
      const next = Math.max(
        0,
        Math.min(Math.min(totalSheets, limit), Math.floor(pageForAnchor(pages, anchor) / per))
      );
      if (next !== sheet) {
        sheet = next;
        library.setProgress(title.id, next, anchor);
      }
    });
  });

  /** A jump (contents, bookmark) lands flat — it is not one page turning. */
  function go(n) {
    cancelAnimationFrame(raf);
    turning = null;
    drag = null;
    commit(n);
  }

  /** Land a turn already in flight so the next input is never dropped. */
  function settleTurn() {
    if (!turning) return;
    const d = turning.dir;
    cancelAnimationFrame(raf);
    turning = null;
    commit(sheet + d);
  }

  function runTurn(dir, from, to, ease, ms, land) {
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
    const step = () => {
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

  function turn(dir) {
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
    if (Math.max(0, Math.min(Math.min(totalSheets, limit), sheet + dir)) === sheet) return;
    runTurn(dir, 0, 1, easeTurn, 720, true);
  }

  function turnPanel(dir) {
    let p = currentPage;
    let i = panelIdx + dir;
    const count = (n) => pages[n]?.layout?.length || 1;
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

  function onPointerDown(e) {
    if (guided || phase !== 'reading' || turning) return;
    const rect = e.currentTarget.getBoundingClientRect();
    halfWidth = rect.width / per;
    startX = e.clientX;
    fromSide = e.clientX > rect.left + rect.width / 2 ? 1 : -1;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag = { dir: fromSide, t: 0 };
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dx = e.clientX - startX;
    const t = Math.max(0, Math.min(1, (fromSide === 1 ? -dx : dx) / halfWidth));
    drag = { dir: fromSide, t };
  }

  function onPointerUp() {
    if (!drag) return;
    const { dir, t } = drag;
    drag = null;
    const fallBack = () => (t > 0.01 ? runTurn(dir, t, 0, easeBack, 420, false) : undefined);
    if (t <= 0.28) return fallBack();
    // Dragging off either end of the book closes it rather than turning.
    if ((dir < 0 && sheet === 0) || (dir > 0 && !sampling && sheet >= totalSheets)) {
      turn(dir);
      return;
    }
    if (Math.max(0, Math.min(Math.min(totalSheets, limit), sheet + dir)) === sheet) return fallBack();
    runTurn(dir, t, 1, easeDrop, 620, true);
  }

  function onKeydown(e) {
    if (e.key === 'ArrowRight') turn(1);
    if (e.key === 'ArrowLeft') turn(-1);
    if (e.key === 'Escape') onclose?.();
  }

  $effect(() => () => {
    cancelAnimationFrame(raf);
    clearTimeout(flipTimer);
    clearTimeout(openTimer);
  });

  function jumpToChapter(ci) {
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
        {#each title.chapters || [] as ch, ci}
          <button class="toc-row" onclick={() => jumpToChapter(ci)}>
            <span>{ch.title}</span>
            <span class="mono plain">ch {ci + 1}</span>
          </button>
        {/each}
        <div class="mono" style="margin-top: 26px">Bookmarks</div>
        {#each bookmarks as b}
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
          {#each Object.entries(TYPEFACES) as [key, tf]}
            <button
              class="mini"
              class:on={prefs.typeface === key}
              style:font-family={tf.css}
              onclick={() => library.setPref('typeface', key)}
            >
              {tf.label}
            </button>
          {/each}
        </div>

        <div class="mono">Paper</div>
        <div class="row">
          {#each Object.entries(PAPERS) as [key, p]}
            <button
              class="mini paper"
              class:on={prefs.paper === key}
              style:background={p.bg}
              style:color={p.ink}
              onclick={() => library.setPref('paper', key)}
            >
              {p.label}
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
      {@const atEnd = phase === 'closingEnd' || phase === 'openingEnd'}
      <!-- Opening / closing: the board swings on the spine. At the END of the
           book it is the back board, lying open on the right, so the rig
           mirrors: last page on the left, endpaper facing up. -->
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
          <!-- Right half only: the left half is bare table until the cover
               lands on it, so a full-width slab reads as an extra blank page.
               Carries the same drop shadow the settled spread uses. -->
          <div
            class="rig-slab"
            class:at-end={atEnd}
            style:left="{atEnd ? 0 : box.pw}px"
            style:width="{box.pw}px"
            style:height="{box.ph}px"
            style:background={paper.bg}
          ></div>

          <div
            class="first-page"
            class:at-end={atEnd}
            style:left="{atEnd ? 0 : box.pw}px"
            style:width="{box.pw}px"
            style:height="{box.ph}px"
            style:background={paper.bg}
          >
            <PageFace
              page={atEnd ? pages[pages.length - 1] : pages[sheet * per] || pages[0]}
              {box}
              paper={prefs.paper}
              typeface={prefs.typeface}
              side={atEnd ? 'back' : 'front'}
            />
            <div class="page-shade" class:at-end={atEnd}></div>
            <!-- the cover's shadow sweeping off the page as it lifts -->
            <div class="sweep" class:closing={phase === 'closing' || phase === 'closingEnd'}></div>
          </div>

          {#if !narrow}
            <!-- The settled spread draws a gutter strip here. Without the same
                 strip on the rig it pops in at the hand-off, which reads as a
                 flicker down the middle of the book. -->
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
            onanimationend={() =>
              phase === 'closing'
                ? settleClose()
                : phase === 'closingEnd'
                  ? settleCloseEnd()
                  : phase === 'openingEnd'
                    ? settleOpenEnd()
                    : settleOpen()}
          >
            <span class="swing-face outer" style:background={atEnd ? paper.bg : boardArt}></span>
            <span class="swing-face inner" style:background={atEnd ? boardArt : paper.bg}></span>
          </div>

          <div
            class="cast opening"
            class:closing={phase === 'closing' || phase === 'closingEnd'}
            style:--w0="{box.pw * 0.9}px"
            style:--w1="{box.pw * 1.7}px"
          ></div>
        </div>
      </div>
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
      <div
        class="book"
        style:width="{bookW}px"
        style:height="{box.ph}px"
        style:padding-left={narrow ? '0' : `${box.pw}px`}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      >
        <div class="slab" style:background={paper.bg} style:width="{bookW}px" style:height="{box.ph}px"></div>

        {#each sheets as sh (sh.k)}
          <div
            class="sheet"
            style:width="{box.pw}px"
            style:height="{box.ph}px"
            style:z-index={sh.z}
            style:transform="rotateY({sh.angle}deg) translateZ({(sh.curl * 6).toFixed(2)}px)"
            style:will-change={sh.active ? 'transform' : 'auto'}
          >
            <div class="face front" style:background={paper.bg} style:visibility={sh.showFront ? 'visible' : 'hidden'}>
              <PageFace page={sh.front} {box} paper={prefs.paper} typeface={prefs.typeface} side="front" />
              <div
                class="shade"
                style:background="linear-gradient(90deg, rgba(0,0,0,{(0.3 + sh.curl * 0.28).toFixed(3)}) 0%, rgba(0,0,0,0.04) 14%, rgba(0,0,0,0) 42%, rgba(255,255,255,{(sh.curl * 0.22).toFixed(3)}) 78%, rgba(0,0,0,{(sh.curl * 0.3).toFixed(3)}) 100%)"
              ></div>
            </div>

            <div class="face back" style:background={paper.bg} style:visibility={sh.showBack ? 'visible' : 'hidden'}>
              <PageFace page={sh.back} {box} paper={prefs.paper} typeface={prefs.typeface} side="back" />
              <div
                class="shade"
                style:background="linear-gradient(270deg, rgba(0,0,0,{(0.3 + sh.curl * 0.28).toFixed(3)}) 0%, rgba(0,0,0,0.04) 14%, rgba(0,0,0,0) 42%, rgba(255,255,255,{(sh.curl * 0.2).toFixed(3)}) 78%, rgba(0,0,0,{(sh.curl * 0.28).toFixed(3)}) 100%)"
              ></div>
            </div>
          </div>
        {/each}

        {#if !narrow}
          <div class="spine" style:left="{box.pw - 3}px" style:height="{box.ph}px" style:z-index={totalSheets + 5}></div>
        {/if}
      </div>
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

  /* the book ---------------------------------------------------------- */
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

  /* closed book ------------------------------------------------------- */
  .case {
    display: flex;
    align-items: center;
    justify-content: center;
    perspective: 2200px;
    perspective-origin: 50% 45%;
  }

  .cast {
    position: absolute;
    left: 50%;
    bottom: -38px;
    height: 34px;
    transform: translateX(-50%);
    background: radial-gradient(ellipse at center, rgba(0, 0, 0, 0.55), transparent 70%);
    filter: blur(9px);
  }

  .cast.opening {
    bottom: -34px;
    height: 30px;
    animation: open-cast 0.9s ease-out both;
  }

  /* opening ----------------------------------------------------------- */
  /* Keyframes, not transitions: the motion must start on mount without
     waiting for a state flip and a second paint. */
  @keyframes open-rig {
    from {
      transform: translateX(var(--dx)) rotateX(4deg) rotateY(-14deg);
    }
    to {
      transform: translateX(0) rotateX(0deg) rotateY(0deg);
    }
  }

  @keyframes open-cover {
    from {
      transform: rotateY(0deg) translateZ(var(--dz));
    }
    to {
      transform: rotateY(-180deg) translateZ(0px);
    }
  }

  @keyframes open-sweep {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }

  @keyframes open-edge {
    from {
      opacity: 1;
    }
    to {
      opacity: 0.25;
    }
  }

  @keyframes open-cast {
    from {
      width: var(--w0);
    }
    to {
      width: var(--w1);
    }
  }

  /* closing: the same motion, run the other way */
  @keyframes close-rig {
    from {
      transform: translateX(0) rotateX(0deg) rotateY(0deg);
    }
    to {
      transform: translateX(var(--dx)) rotateX(4deg) rotateY(-14deg);
    }
  }

  @keyframes close-cover {
    from {
      transform: rotateY(-180deg) translateZ(0px);
    }
    to {
      transform: rotateY(0deg) translateZ(var(--dz));
    }
  }

  @keyframes close-sweep {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes close-edge {
    from {
      opacity: 0.25;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes close-cast {
    from {
      width: var(--w1);
    }
    to {
      width: var(--w0);
    }
  }

  /* closing at the END: the back board swings left over the last page */
  @keyframes closeend-rig {
    from {
      transform: translateX(0) rotateX(0deg) rotateY(0deg);
    }
    to {
      transform: translateX(var(--dx2)) rotateX(4deg) rotateY(-14deg);
    }
  }

  @keyframes closeend-cover {
    /* Past 90deg the board's local +Z points away from the viewer, so the lift
       must be NEGATIVE to land in front of the page it just covered. */
    from {
      transform: rotateY(0deg) translateZ(0px);
    }
    to {
      transform: rotateY(-180deg) translateZ(var(--dzn));
    }
  }

  /* opening from the back cover: the same board swings the other way, off the
     last page, so a reader resuming at the end never sees page one */
  @keyframes openend-rig {
    from {
      transform: translateX(var(--dx2)) rotateX(4deg) rotateY(-14deg);
    }
    to {
      transform: translateX(0) rotateX(0deg) rotateY(0deg);
    }
  }

  @keyframes openend-cover {
    from {
      transform: rotateY(-180deg) translateZ(var(--dzn));
    }
    to {
      transform: rotateY(0deg) translateZ(0px);
    }
  }

  .rig.opening-end {
    animation-name: openend-rig;
  }

  .swing.opening-end {
    animation-name: openend-cover;
  }

  .rig.closing-end {
    animation-name: closeend-rig;
  }

  .swing.closing-end {
    animation-name: closeend-cover;
  }

  .rig-slab.at-end {
    border-radius: 4px 0 0 4px;
  }

  .first-page.at-end {
    border-radius: 4px 0 0 4px;
    box-shadow:
      inset -14px 0 26px -22px rgba(0, 0, 0, 0.85),
      0 0 0 1px rgba(0, 0, 0, 0.06);
  }

  .page-shade.at-end {
    background: linear-gradient(
      270deg,
      rgba(0, 0, 0, 0.3) 0%,
      rgba(0, 0, 0, 0.04) 14%,
      rgba(0, 0, 0, 0) 42%
    );
  }

  .rig-slab {
    position: absolute;
    top: 0;
    border-radius: 0 4px 4px 0;
    box-shadow: 0 40px 80px -40px rgba(0, 0, 0, 0.9);
  }

  .page-shade {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(
      90deg,
      rgba(0, 0, 0, 0.3) 0%,
      rgba(0, 0, 0, 0.04) 14%,
      rgba(0, 0, 0, 0) 42%
    );
  }

  /* identical to .spine, so the middle does not change at the hand-off */
  .rig-spine {
    position: absolute;
    top: 0;
    width: 6px;
    pointer-events: none;
    background: linear-gradient(90deg, rgba(0, 0, 0, 0.22), rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0.22));
  }

  .rig.closing {
    animation-name: close-rig;
  }

  .swing.closing {
    animation-name: close-cover;
  }

  .sweep.closing {
    animation-name: close-sweep;
  }

  .rig-edge.closing {
    animation-name: close-edge;
  }

  .cast.closing {
    animation-name: close-cast;
  }

  .rig {
    position: relative;
    transform-style: preserve-3d;
    animation: open-rig 0.62s cubic-bezier(0.33, 0, 0.2, 1) both;
  }

  .first-page {
    position: absolute;
    top: 0;
    border-radius: 0 4px 4px 0;
    overflow: hidden;
    box-shadow:
      inset 14px 0 26px -22px rgba(0, 0, 0, 0.85),
      0 0 0 1px rgba(0, 0, 0, 0.06);
  }

  .sweep {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(
      90deg,
      rgba(0, 0, 0, 0.42) 0%,
      rgba(0, 0, 0, 0.16) 30%,
      rgba(0, 0, 0, 0) 66%
    );
    animation: open-sweep 0.8s ease-out both;
  }

  .rig-edge {
    position: absolute;
    top: 3px;
    transform: rotateY(90deg);
    transform-origin: left center;
    background: repeating-linear-gradient(90deg, #efeae0 0 1.5px, #d8d2c6 1.5px 3px);
    animation: open-edge 0.7s ease-out both;
  }

  .swing {
    position: absolute;
    top: 0;
    transform-style: preserve-3d;
    transform-origin: left center;
    animation: open-cover 0.92s cubic-bezier(0.42, 0.02, 0.24, 1) both;
  }

  .swing-face {
    position: absolute;
    inset: 0;
    backface-visibility: hidden;
  }

  .swing-face.outer {
    border-radius: 0 5px 5px 0;
    box-shadow: inset 14px 0 30px -22px rgba(0, 0, 0, 0.95);
  }

  .swing-face.inner {
    transform: rotateY(180deg);
    border-radius: 5px 0 0 5px;
    box-shadow: inset -16px 0 26px -22px rgba(0, 0, 0, 0.6);
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
