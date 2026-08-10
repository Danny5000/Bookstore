<script lang="ts">
  import type { ReaderLocation } from '$lib/types/library';
  import type { PaperId, ReaderPreferences, TypefaceId } from '$lib/types/reader';

  interface ChapterView {
    title: string;
  }

  interface TypefaceOption {
    id: TypefaceId;
    label: string;
    css: string;
  }

  interface PaperOption {
    id: PaperId;
    label: string;
    bg: string;
    ink: string;
  }

  interface BookmarkView {
    id: string;
    sheet: number;
    location: ReaderLocation;
  }

  interface Props {
    contentsOpen: boolean;
    controlsOpen: boolean;
    chapters: readonly ChapterView[];
    bookmarks: readonly BookmarkView[];
    per: number;
    prefs: ReaderPreferences;
    typefaces: readonly TypefaceOption[];
    papers: readonly PaperOption[];
    onchapter: (index: number) => void;
    onbookmark: (bookmark: BookmarkView) => void;
    onfontsize: (size: number) => void;
    ontypeface: (typeface: TypefaceId) => void;
    onpaper: (paper: PaperId) => void;
  }

  let {
    contentsOpen,
    controlsOpen,
    chapters,
    bookmarks,
    per,
    prefs,
    typefaces,
    papers,
    onchapter,
    onbookmark,
    onfontsize,
    ontypeface,
    onpaper
  }: Props = $props();
</script>

{#if contentsOpen}
  <aside class="drawer">
    <div class="mono">Contents</div>
    {#each chapters as chapter, index (chapter.title)}
      <button class="toc-row" type="button" onclick={() => onchapter(index)}>
        <span>{chapter.title}</span>
        <span class="mono plain">ch {index + 1}</span>
      </button>
    {/each}
    <div class="mono bookmarks-heading">Bookmarks</div>
    {#each bookmarks as bookmark (bookmark.id)}
      <button class="toc-row" type="button" onclick={() => onbookmark(bookmark)}>
        <span>Page {bookmark.sheet * per + 1}</span>
        <span class="bookmark-mark">&#9670;</span>
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
      <button
        class="mini"
        type="button"
        aria-label="Decrease type size"
        onclick={() => onfontsize(Math.max(14, prefs.fontSize - 1))}
      >A&minus;</button>
      <button
        class="mini big"
        type="button"
        aria-label="Increase type size"
        onclick={() => onfontsize(Math.min(24, prefs.fontSize + 1))}
      >A+</button>
    </div>

    <div class="mono">Typeface</div>
    <div class="stack">
      {#each typefaces as option (option.id)}
        <button
          class="mini"
          class:on={prefs.typeface === option.id}
          type="button"
          style:font-family={option.css}
          onclick={() => ontypeface(option.id)}
        >
          {option.label}
        </button>
      {/each}
    </div>

    <div class="mono">Paper</div>
    <div class="row">
      {#each papers as option (option.id)}
        <button
          class="mini paper"
          class:on={prefs.paper === option.id}
          type="button"
          style:background={option.bg}
          style:color={option.ink}
          onclick={() => onpaper(option.id)}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </aside>
{/if}

<style>
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

  .toc-row:hover,
  .bookmark-mark {
    color: var(--accent);
  }

  .bookmarks-heading {
    margin-top: 26px;
  }

  .empty {
    font-size: 13px;
    color: var(--muted);
  }

  .plain {
    letter-spacing: 0.1em;
    text-transform: none;
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
</style>
