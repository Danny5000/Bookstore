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

<style>
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

  /* identical to the settled spread's spine, so the hand-off does not flicker */
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
</style>
