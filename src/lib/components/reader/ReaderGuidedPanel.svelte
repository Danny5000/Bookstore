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
