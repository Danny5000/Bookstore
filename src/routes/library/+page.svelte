<script>
  import { goto } from '$app/navigation';
  import { titles } from '$lib/stores/titles.svelte';
  import { library } from '$lib/stores/library.svelte';
  import { SWATCHES, coverBackground } from '$lib/data/catalog';
  import { pageBox, paginate } from '$lib/paginate';

  let toast = $state('');
  let pullingId = $state(null);
  let pulled = false;

  // Pull the book off the shelf first, then hand over to the reader.
  function pull(t) {
    if (pullingId) return;
    pullingId = t.id;
    pulled = false;
    // animationend is the real trigger, so the hand-off tracks the animation
    // rather than a guessed duration. The timer is a backstop for a throttled
    // tab; under reduced motion the animation ends at once and so does this.
    setTimeout(() => open(t), 940);
  }

  function open(t) {
    if (pulled) return;
    pulled = true;
    goto(`/read/${t.id}`);
  }

  const shelf = $derived(titles.all.filter((t) => library.owns(t.id)));
  const box = pageBox({ vw: 1440, vh: 900, narrow: false, fontSize: 18 });

  function pct(t) {
    const pages = paginate(t, box);
    const total = Math.max(1, Math.ceil(pages.length / 2));
    return Math.min(100, Math.round(((library.progress[t.id] || 0) / total) * 100));
  }

  function flash(msg) {
    toast = msg;
    setTimeout(() => (toast = ''), 2600);
  }

  async function deliver(t, channel) {
    // POST to /api/deliver in production; the endpoint signs a download URL
    // or hands the file to your mail provider.
    flash(channel === 'email' ? `Sent — check your inbox for ${t.title}` : `${t.title}.epub — download started`);
  }
</script>

<svelte:head><title>My Shelf · Pale Orbit Press</title></svelte:head>

<section class="wrap">
  <h1 class="display">My Shelf</h1>
  <p class="note">
    {shelf.length
      ? `${shelf.length} title${shelf.length === 1 ? '' : 's'} · your place is kept automatically`
      : 'Purchases land here. Files stay available forever.'}
  </p>

  <!-- The scroller is the wrapper; the 3D layer inside it must not clip, and
       needs headroom for the pulled book's lift and perspective scale. -->
  <div class="case-scroll">
    <div class="bookcase">
    {#each shelf as t}
      {@const shelfH = 200 + (t.title.length % 5) * 9}
      {@const shelfW = Math.round(shelfH * 0.66)}
      <!-- Spine width is the thickness of the object: a bound volume stands
           square on the shelf, a stapled issue is barely more than card. -->
      {@const spineW = t.kind === 'comic' ? 18 : 52}
      <!-- A real box: spine facing out, front cover receding into the shelf,
           paper edge on top. A single plane just narrows as it rotates. -->
      <a
        class="book"
        class:pulling={pullingId === t.id}
        href="/read/{t.id}"
        onclick={(e) => {
          e.preventDefault();
          pull(t);
        }}
        onanimationend={() => pullingId === t.id && open(t)}
        style:height="{shelfH}px"
        style:--sw="{spineW}px"
      >
        <span
          class="cover-face"
          style:width="{shelfW}px"
          style:height="{shelfH}px"
          style:background={coverBackground(t.cover, t.coverUrl)}
        ></span>

        <span class="top-face" style:height="{shelfW}px"></span>

        <span
          class="spine-plate"
          style:background="linear-gradient(90deg, {SWATCHES[t.cover % SWATCHES.length][1]}, {SWATCHES[t.cover % SWATCHES.length][0]} 70%, {SWATCHES[t.cover % SWATCHES.length][1]})"
        >
          <span class="shelf-title" style:font-size={t.kind === 'comic' ? '10px' : '15px'}>{t.title}</span>
        </span>
      </a>
    {:else}
      <p class="empty mono">Nothing here yet — buy a title and it lands on this shelf.</p>
    {/each}
    </div>
  </div>

  <div class="rows">
    {#each shelf as t}
      <div class="row">
        <div class="head">
          <span class="name">{t.title}</span>
          <span class="mono plain">{pct(t)}% read</span>
        </div>
        <div class="bar"><div class="fill" style:width="{pct(t)}%"></div></div>
        <div class="acts">
          <a class="btn small" href="/read/{t.id}">{pct(t) > 0 ? 'Resume' : 'Read'}</a>
          <button class="btn ghost small" onclick={() => deliver(t, 'email')}>Email me the file</button>
          <button class="btn ghost small" onclick={() => deliver(t, 'download')}>Download EPUB</button>
        </div>
      </div>
    {/each}
  </div>
</section>

{#if toast}
  <div class="toast">{toast}</div>
{/if}

<style>
  section {
    padding-top: 52px;
    padding-bottom: 110px;
    max-width: 1240px;
  }

  h1 {
    font-size: 44px;
    margin: 0 0 6px;
  }

  .note {
    color: var(--muted);
    font-size: 15px;
    margin: 0 0 40px;
  }

  .case-scroll {
    overflow-x: auto;
    overflow-y: visible;
    border-bottom: 14px solid var(--raised);
    box-shadow: 0 22px 40px -26px rgba(0, 0, 0, 0.7);
  }

  .bookcase {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    min-height: 318px;
    padding: 68px 26px 20px;
    perspective: 1400px;
    perspective-origin: 50% 74%;
  }

  /* Pulling a book off the shelf: it hinges out on its spine edge, the way it
     does when you hook a finger over the top and lean it towards you. */
  @keyframes pull-out {
    /* two beats: clear the shelf first, then turn to face the reader */
    0% {
      transform: translateY(0) translateZ(0) rotateY(0deg);
      animation-timing-function: cubic-bezier(0.24, 0, 0.28, 1);
    }
    44% {
      transform: translateY(-7px) translateZ(64px) rotateY(0deg);
      animation-timing-function: cubic-bezier(0.36, 0, 0.26, 1);
    }
    100% {
      transform: translateY(-16px) translateZ(38px) rotateY(-64deg);
    }
  }

  .book {
    position: relative;
    width: var(--sw);
    flex: 0 0 var(--sw);
    transform-origin: left center;
    transform-style: preserve-3d;
    transition: transform 0.26s cubic-bezier(0.2, 0.82, 0.34, 1.1);
  }

  .book:hover {
    transform: translateY(-14px);
  }

  .book.pulling {
    z-index: 5;
    animation: pull-out 0.86s linear both;
  }

  .book.pulling:hover {
    transform: none;
  }

  .spine-plate {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px 3px 3px 2px;
    box-shadow: 0 14px 24px -14px rgba(0, 0, 0, 0.8);
  }

  .cover-face {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: left center;
    transform: translateX(var(--sw)) rotateY(90deg);
    border-radius: 0 3px 3px 0;
    box-shadow: inset 16px 0 34px -26px rgba(0, 0, 0, 0.95);
  }

  .top-face {
    position: absolute;
    top: 0;
    left: 0;
    width: var(--sw);
    transform-origin: center top;
    transform: rotateX(-90deg);
    background: repeating-linear-gradient(90deg, #efeae0 0 1.5px, #d8d2c6 1.5px 3px);
  }

  .shelf-title {
    writing-mode: vertical-rl;
    padding: 12px 0;
    font-family: var(--font-display);
    font-size: 15px;
    color: rgba(255, 255, 255, 0.92);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  }

  .empty {
    padding-bottom: 20px;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: none;
  }

  .rows {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 18px;
    margin-top: 44px;
  }

  .row {
    display: grid;
    gap: 14px;
    padding: 18px;
    border: 1px solid var(--line);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  .name {
    font-family: var(--font-display);
    font-size: 20px;
  }

  .plain {
    letter-spacing: 0.1em;
    text-transform: none;
  }

  .bar {
    height: 3px;
    background: var(--line);
  }

  .fill {
    height: 3px;
    background: var(--accent);
  }

  .acts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .small {
    padding: 9px 16px;
    font-size: 13px;
    border-radius: 3px;
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: 30px;
    transform: translateX(-50%);
    z-index: 120;
    padding: 13px 22px;
    border-radius: 999px;
    background: var(--raised);
    border: 1px solid var(--line);
    font-size: 14px;
    animation: fade-up 0.2s ease both;
  }
</style>
