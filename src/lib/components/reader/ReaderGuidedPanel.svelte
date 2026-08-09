<script lang="ts">
  import type { PanelRegionDto } from '$lib/types/publication';

  interface Props {
    height: number;
    imageUrl: string;
    pageWidth: number;
    pageHeight: number;
    panel: PanelRegionDto | null;
    onnext: () => void;
  }

  let { height, imageUrl, pageWidth, pageHeight, panel, onnext }: Props = $props();
  const rawPanel = $derived(panel ?? { id: 'page', ordinal: 0, x: 0, y: 0, width: 1, height: 1 });
  const safeWidth = $derived(Math.max(0.001, Math.min(1, rawPanel.width)));
  const safeHeight = $derived(Math.max(0.001, Math.min(1, rawPanel.height)));
  const safeX = $derived(Math.max(0, Math.min(1 - safeWidth, rawPanel.x)));
  const safeY = $derived(Math.max(0, Math.min(1 - safeHeight, rawPanel.y)));
  const width = $derived(
    Math.round(height * ((safeWidth * Math.max(1, pageWidth)) / (safeHeight * Math.max(1, pageHeight))))
  );
</script>

<button
  class="single-panel"
  type="button"
  style:height="{height}px"
  style:width="min(80vw, {width}px)"
  onclick={onnext}
>
  {#if imageUrl}
    <img
      src={imageUrl}
      alt=""
      style:width="{100 / safeWidth}%"
      style:height="{100 / safeHeight}%"
      style:left="{-safeX / safeWidth * 100}%"
      style:top="{-safeY / safeHeight * 100}%"
    />
  {/if}
</button>

<style>
  .single-panel {
    position: relative;
    overflow: hidden;
    padding: 0;
    background: #fff;
    border: 3px solid #16130f;
    box-shadow: 0 40px 80px -40px rgba(0, 0, 0, 0.9);
    cursor: pointer;
    animation: fade-up 0.28s ease both;
  }

  .single-panel img {
    position: absolute;
    max-width: none;
    object-fit: fill;
  }
</style>
