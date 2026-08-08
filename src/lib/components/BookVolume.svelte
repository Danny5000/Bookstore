<script>
  import { money, SWATCHES, coverBackground } from '$lib/data/catalog';

  /**
   * A closed book as an object: boards, spine, page block, cast shadow. The
   * reader opens this one; the home and detail heroes show it standing still.
   *
   * Comics are stapled issues, not bound volumes — thin, square-spined, and
   * with no stacked page block to show.
   */
  let {
    title,
    width = 260,
    height = 360,
    depth = null,
    pageCount = null,
    flipped = false,
    flipping = false,
    tilt = -14,
    interactive = false,
    onclick = null,
    label = null
  } = $props();

  let hover = $state(false);

  const stapled = $derived(title.kind === 'comic');
  // Character count is a good enough stand-in for a page count here, and it
  // avoids paginating a book just to decide how thick to draw it.
  const leaves = $derived(
    pageCount ??
      title.pages ??
      Math.max(
        24,
        Math.round(
          (title.chapters || []).reduce((n, c) => n + c.paras.reduce((m, p) => m + p.length, 0), 0) / 1800
        )
      )
  );
  const d = $derived(
    depth ??
      (stapled
        ? Math.max(5, Math.min(11, Math.round(leaves * 0.5)))
        : Math.max(16, Math.min(58, Math.round(leaves * 0.9) + 10)))
  );

  const pair = $derived(SWATCHES[title.cover % SWATCHES.length]);
  const art = $derived(coverBackground(title.cover, title.coverUrl));
  const frontRadius = $derived(stapled ? '1px 2px 2px 1px' : '3px 6px 6px 3px');
  const backRadius = $derived(stapled ? '2px 1px 1px 2px' : '6px 3px 3px 6px');
  const lean = $derived(interactive && hover ? tilt * 0.4 : tilt);
  const lift = $derived(interactive && hover ? -10 : 0);
</script>

<svelte:element
  this={onclick ? 'button' : 'div'}
  class="volume"
  class:hand={!!onclick}
  style:width="{width}px"
  style:height="{height}px"
  style:transform="translateY({lift}px) rotateY({flipped ? 180 : 0}deg) rotateX(4deg) rotateY({lean}deg)"
  style:transition="transform {flipping ? '0.9s cubic-bezier(0.45, 0, 0.55, 1)' : '0.5s cubic-bezier(0.2, 0.8, 0.3, 1)'}"
  onclick={onclick}
  onpointerenter={() => (hover = true)}
  onpointerleave={() => (hover = false)}
  aria-label={label}
>
  <!-- Solid core: without it the volume is a hollow shell and you see straight
       through it as it passes edge-on. -->
  <span class="core" style:background={pair[1]} style:transform="translateZ({d / 2 - 1}px)"></span>
  <span class="core back" style:background={pair[1]} style:transform="translateZ({-d / 2 + 1}px)"></span>

  <span
    class="board front"
    style:background={art}
    style:border-radius={frontRadius}
    style:transform="translateZ({d / 2}px)"
    style:visibility={flipped ? 'hidden' : 'visible'}
    style:transition="visibility 0s linear {flipping ? (flipped ? '0.47s' : '0.43s') : '0s'}"
  ></span>

  <span
    class="board back"
    style:background={art}
    style:border-radius={backRadius}
    style:transform="rotateY(180deg) translateZ({d / 2}px)"
    style:visibility={flipped ? 'visible' : 'hidden'}
    style:transition="visibility 0s linear {flipping ? (flipped ? '0.43s' : '0.47s') : '0s'}"
  >
    <!-- darken with an overlay, never a filter: a filter flattens the layer and
         defeats backface-visibility, bleeding this text through the front -->
    <span class="tint"></span>
    <span class="blurb">
      <span class="mono light">{title.author}</span>
      <span class="blurb-text">{title.summary}</span>
      <span class="blurb-foot mono light">
        <span>{leaves} pages</span>
        <span>{money(title.price)}</span>
      </span>
    </span>
  </span>

  <span
    class="spine-face"
    style:width="{d}px"
    style:height="{height}px"
    style:transform="translateX({-d / 2}px) rotateY(-90deg)"
    style:background="linear-gradient(90deg, rgba(0,0,0,0.5), {pair[1]} 35%, {pair[1]} 65%, rgba(0,0,0,0.5))"
  >
    {#if d > 9}
      <span class="spine-text" style:font-size="{Math.min(15, d - 6)}px" style:max-height="{height - 40}px">
        {title.title}
      </span>
    {/if}
  </span>

  {#if !stapled}
    <span
      class="fore-edge"
      style:width="{d - 4}px"
      style:height="{height - 6}px"
      style:transform="translateX({width - 4 - (d - 4) / 2}px) rotateY(90deg)"
    ></span>

    <span
      class="head-edge"
      style:width="{width - 4}px"
      style:height="{d - 4}px"
      style:transform="translateY({-(d - 4) / 2 + 3}px) rotateX(90deg)"
    ></span>

    <span
      class="tail-edge"
      style:width="{width - 4}px"
      style:height="{d - 4}px"
      style:transform="translateY({height - (d - 4) / 2 - 3}px) rotateX(-90deg)"
    ></span>
  {/if}

  <span class="cast" style:width="{width * 0.86}px"></span>
</svelte:element>

<style>
  .volume {
    position: relative;
    padding: 0;
    border: 0;
    background: none;
    transform-style: preserve-3d;
  }

  .hand {
    cursor: pointer;
  }

  .board {
    position: absolute;
    inset: 0;
    overflow: hidden;
    backface-visibility: hidden;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.07),
      inset 14px 0 30px -22px rgba(0, 0, 0, 0.95);
  }

  .tint {
    position: absolute;
    inset: 0;
    background: rgba(6, 8, 14, 0.42);
    pointer-events: none;
  }

  .blurb {
    position: absolute;
    inset: 12% 11%;
    display: flex;
    flex-direction: column;
    gap: 14px;
    text-align: left;
    color: rgba(255, 255, 255, 0.92);
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
  }

  .light {
    color: rgba(255, 255, 255, 0.8);
  }

  .blurb-text {
    font-family: var(--font-display);
    font-size: 21px;
    line-height: 1.45;
  }

  .blurb-foot {
    display: flex;
    justify-content: space-between;
    margin-top: auto;
    letter-spacing: 0.14em;
  }

  .spine-face {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .spine-text {
    writing-mode: vertical-rl;
    font-family: var(--font-display);
    letter-spacing: 0.05em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: rgba(255, 255, 255, 0.9);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  }

  /* stacked paper: the fore-edge and head of the page block */
  .fore-edge {
    position: absolute;
    top: 3px;
    left: 0;
    border-radius: 1px;
    background: repeating-linear-gradient(90deg, #efeae0 0 1.5px, #d8d2c6 1.5px 3px);
    box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.28);
  }

  .head-edge {
    position: absolute;
    top: 0;
    left: 2px;
    border-radius: 1px;
    background: repeating-linear-gradient(0deg, #efeae0 0 1.5px, #dcd6ca 1.5px 3px);
  }

  .tail-edge {
    position: absolute;
    top: 0;
    left: 2px;
    border-radius: 1px;
    background: repeating-linear-gradient(0deg, #e6e0d4 0 1.5px, #cfc9bd 1.5px 3px);
  }

  .core {
    position: absolute;
    top: 1px;
    left: 1px;
    right: 1px;
    bottom: 1px;
    border-radius: 3px 5px 5px 3px;
  }

  .core.back {
    border-radius: 5px 3px 3px 5px;
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
</style>
