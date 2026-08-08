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
