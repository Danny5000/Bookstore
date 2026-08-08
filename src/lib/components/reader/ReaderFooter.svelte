<script lang="ts">
  import type { ReaderPhase } from '$lib/types/reader';

  interface Props {
    phase: ReaderPhase;
    isComic: boolean;
    flipped: boolean;
    guided: boolean;
    currentPage: number;
    panelIndex: number;
    panelCount: number;
    leftFolio: number;
    rightFolio: number;
    pageCount: number;
    onopen: () => void;
    onflip: () => void;
    onprevious: () => void;
    onnext: () => void;
  }

  let {
    phase,
    isComic,
    flipped,
    guided,
    currentPage,
    panelIndex,
    panelCount,
    leftFolio,
    rightFolio,
    pageCount,
    onopen,
    onflip,
    onprevious,
    onnext
  }: Props = $props();
</script>

{#if phase === 'closed'}
  <div class="nav">
    <button class="btn nowrap" type="button" onclick={onopen}>Open the {isComic ? 'comic' : 'book'}</button>
    <button class="btn ghost nowrap" type="button" onclick={onflip}>
      {flipped ? 'Front cover' : 'Back cover'}
    </button>
  </div>
{:else}
  <div class="nav">
    <button class="round" type="button" aria-label="Previous" onclick={onprevious}>&lsaquo;</button>
    <span class="folio mono plain">
      {#if guided}
        Page {currentPage + 1} &middot; panel {panelIndex + 1} of {panelCount}
      {:else if leftFolio && rightFolio}
        Pages {leftFolio}&ndash;{rightFolio} of {pageCount}
      {:else}
        Page {leftFolio || rightFolio || pageCount} of {pageCount}
      {/if}
    </span>
    <button class="round" type="button" aria-label="Next" onclick={onnext}>&rsaquo;</button>
  </div>
{/if}

<style>
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
