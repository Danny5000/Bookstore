<script>
  import { PAPERS, TYPEFACES } from '$lib/paginate';

  /** One printed side of a sheet: a text page or a comic page. */
  let { page = null, box, paper = 'white', typeface = 'serif', side = 'front' } = $props();

  const ink = $derived(PAPERS[paper].ink);
  const font = $derived(TYPEFACES[typeface].css);
  const inset = $derived(
    side === 'front'
      ? `${box.pad}px ${box.pad}px ${Math.round(box.pad * 1.2)}px ${Math.round(box.pad * 1.25)}px`
      : `${box.pad}px ${Math.round(box.pad * 1.25)}px ${Math.round(box.pad * 1.2)}px ${box.pad}px`
  );
</script>

<div class="inner" style:inset>
  {#if page && page.type === 'scan'}
    <!-- fixed-page novel: the publisher's own PDF page, rendered as-is -->
    <div class="scan">
      <div class="art"></div>
      <div class="cap">{page.label}</div>
    </div>
  {:else if page && page.type === 'comic'}
    <div class="grid">
      {#each page.layout as cell}
        <div class="panel" style:grid-column="span {cell.c}" style:grid-row="span {cell.r}">
          <div class="art"></div>
          <div class="cap">{cell.cap}</div>
        </div>
      {/each}
    </div>
  {:else if page}
    <div class="body" style:font-family={font} style:font-size="{box.fs}px" style:color={ink}>
      {#if page.heading}
        <h2 style:font-size="{Math.round(box.fs * 1.6)}px" style:margin-bottom="{Math.round(box.fs * 1.3)}px">
          {page.heading}
        </h2>
      {/if}
      {#each page.paras as para, i}
        <p style:text-indent={i === 0 && page.heading ? '0' : '1.4em'}>{para}</p>
      {/each}
    </div>
  {/if}

  {#if page}
    <div class="folio">{page.folio}</div>
  {/if}
</div>

<style>
  .inner {
    position: absolute;
  }

  .body {
    line-height: 1.72;
    text-align: justify;
    hyphens: auto;
  }

  .body h2 {
    font-family: var(--font-display);
    font-weight: 300;
    line-height: 1.15;
    letter-spacing: -0.01em;
    margin: 0 0 20px;
  }

  .body p {
    margin: 0;
  }

  .folio {
    position: absolute;
    bottom: -4px;
    left: 0;
    right: 0;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 10px;
    color: rgba(0, 0, 0, 0.35);
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-auto-rows: 1fr;
    gap: 10px;
    height: 100%;
  }

  .panel {
    position: relative;
    border: 2px solid #16130f;
    background: #fff;
    overflow: hidden;
  }

  /* Placeholder art: replace .art with <img src={cell.src} /> when pages exist. */
  .art {
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      135deg,
      rgba(20, 18, 15, 0.09) 0 8px,
      rgba(20, 18, 15, 0.02) 8px 16px
    );
  }

  .cap {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 10px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: rgba(0, 0, 0, 0.6);
  }

  .scan {
    position: relative;
    height: 100%;
    background: #fff;
    border: 1px solid rgba(20, 18, 15, 0.18);
    overflow: hidden;
  }

  .scan .art {
    background: repeating-linear-gradient(
      135deg,
      rgba(20, 18, 15, 0.07) 0 9px,
      rgba(20, 18, 15, 0.015) 9px 18px
    );
  }
</style>
