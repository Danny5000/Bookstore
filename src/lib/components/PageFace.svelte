<script lang="ts">
  import { PAPERS, TYPEFACES } from '$lib/paginate';
  import type { InlineFragment } from '$lib/types/publication';
  import type { PageBox, PaperId, ReaderPage, TypefaceId } from '$lib/types/reader';

  /** One printed side of a sheet: a text page or a comic page. */
  interface Props {
    page?: ReaderPage | null | undefined;
    box: PageBox;
    paper?: PaperId;
    typeface?: TypefaceId;
    side?: 'front' | 'back';
  }

  let {
    page = null,
    box,
    paper = 'white',
    typeface = 'serif',
    side = 'front'
  }: Props = $props();

  const ink = $derived(PAPERS[paper].ink);
  const font = $derived(TYPEFACES[typeface].css);
  const inset = $derived(
    side === 'front'
      ? `${box.pad}px ${box.pad}px ${Math.round(box.pad * 1.2)}px ${Math.round(box.pad * 1.25)}px`
      : `${box.pad}px ${Math.round(box.pad * 1.25)}px ${Math.round(box.pad * 1.2)}px ${box.pad}px`
  );
</script>

{#snippet fragmentText(fragment: InlineFragment, markIndex = 0)}
  {#if markIndex >= fragment.marks.length}
    {fragment.text}
  {:else if fragment.marks[markIndex] === 'strong'}
    <strong>{@render fragmentText(fragment, markIndex + 1)}</strong>
  {:else if fragment.marks[markIndex] === 'emphasis'}
    <em>{@render fragmentText(fragment, markIndex + 1)}</em>
  {:else if fragment.marks[markIndex] === 'code'}
    <code>{@render fragmentText(fragment, markIndex + 1)}</code>
  {:else if fragment.marks[markIndex] === 'subscript'}
    <sub>{@render fragmentText(fragment, markIndex + 1)}</sub>
  {:else if fragment.marks[markIndex] === 'superscript'}
    <sup>{@render fragmentText(fragment, markIndex + 1)}</sup>
  {:else}
    {@render fragmentText(fragment, markIndex + 1)}
  {/if}
{/snippet}

{#snippet inline(fragments: readonly InlineFragment[])}
  {#each fragments as fragment (fragment)}
    {#if fragment.href}
      <!-- EPUB links are sanitized and normalized by the ingestion boundary. -->
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
      <a href={fragment.href} target="_blank" rel="noopener noreferrer">{@render fragmentText(fragment)}</a>
    {:else}
      {@render fragmentText(fragment)}
    {/if}
  {/each}
{/snippet}

<div class="inner" style:inset>
  {#if page && page.type === 'scan'}
    <!-- fixed-page novel: the publisher's own PDF page, rendered as-is -->
    <div class="scan">
      <div class="art"></div>
      <div class="cap">{page.label}</div>
    </div>
  {:else if page && page.type === 'comic'}
    {#if page.imageUrl}
      <img class="comic-page" src={page.imageUrl} alt="Comic page {page.folio}" />
    {:else}
      <div class="grid">
        {#each page.layout as cell (cell.cap)}
          <div class="panel" style:grid-column="span {cell.c}" style:grid-row="span {cell.r}">
            <div class="art"></div>
            <div class="cap">{cell.cap}</div>
          </div>
        {/each}
      </div>
    {/if}
  {:else if page}
    <div class="body" style:font-family={font} style:font-size="{box.fs}px" style:color={ink}>
      {#if page.blocks}
        {#each page.blocks as block (`${block.sourceBlockId}:${block.sourceStartOffset}:${block.sourceEndOffset}`)}
          {#if block.content.kind === 'heading'}
            <svelte:element this={`h${block.content.level}`} class="prose-heading">
              {@render inline(block.content.fragments)}
            </svelte:element>
          {:else if block.content.kind === 'paragraph'}
            <p>{@render inline(block.content.fragments)}</p>
          {:else if block.content.kind === 'quote'}
            <blockquote>{@render inline(block.content.fragments)}</blockquote>
          {:else if block.content.kind === 'list'}
            {#if block.content.ordered}
              <ol>
                {#each block.content.items as item (item)}<li>{@render inline(item)}</li>{/each}
              </ol>
            {:else}
              <ul>
                {#each block.content.items as item (item)}<li>{@render inline(item)}</li>{/each}
              </ul>
            {/if}
          {:else if block.content.kind === 'image' && block.imageUrl}
            <figure>
              <img src={block.imageUrl} alt={block.content.alt} />
            </figure>
          {:else if block.content.kind === 'break'}
            <hr />
          {/if}
        {/each}
      {:else}
        {#if page.heading}
        <h2 style:font-size="{Math.round(box.fs * 1.6)}px" style:margin-bottom="{Math.round(box.fs * 1.3)}px">
          {page.heading}
        </h2>
        {/if}
        {#each page.paras as para, i (i)}
          <p style:text-indent={i === 0 && page.heading ? '0' : '1.4em'}>{para}</p>
        {/each}
      {/if}
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
    margin: 0 0 0.72em;
  }

  .body :global(.prose-heading) {
    font-family: var(--font-display);
    font-weight: 400;
    line-height: 1.18;
    margin: 0 0 0.8em;
  }

  .body blockquote {
    margin: 0.8em 0;
    padding-left: 1em;
    border-left: 2px solid currentColor;
    opacity: 0.86;
  }

  .body ol,
  .body ul {
    margin: 0.7em 0;
    padding-left: 1.5em;
  }

  .body figure {
    height: min(48%, 280px);
    margin: 0.8em 0;
  }

  .body figure img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .body hr {
    width: 30%;
    margin: 1.5em auto;
    border: 0;
    border-top: 1px solid currentColor;
    opacity: 0.35;
  }

  .body a {
    color: inherit;
    text-decoration-thickness: 1px;
    text-underline-offset: 0.12em;
  }

  .body code {
    font-family: var(--font-mono);
    font-size: 0.86em;
  }

  .comic-page {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #fff;
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
