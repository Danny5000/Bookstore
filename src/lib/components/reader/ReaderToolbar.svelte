<script lang="ts">
  interface Props {
    title: string;
    isComic: boolean;
    isFixed: boolean;
    narrow: boolean;
    bookmarked: boolean;
    guided: boolean;
    progress: number;
    onclose: () => void;
    oncontents: () => void;
    onbookmark: () => void;
    onguided: () => void;
    oncontrols: () => void;
  }

  let {
    title,
    isComic,
    isFixed,
    narrow,
    bookmarked,
    guided,
    progress,
    onclose,
    oncontents,
    onbookmark,
    onguided,
    oncontrols
  }: Props = $props();
</script>

<div class="toolbar">
  <button class="tool" type="button" onclick={onclose}>&larr; Close</button>
  <button class="tool" type="button" onclick={oncontents}>Contents</button>
  <button class="tool" class:on={bookmarked} type="button" onclick={onbookmark}>
    {bookmarked ? '\u25C6' : '\u25C7'}{narrow ? '' : bookmarked ? ' Bookmarked' : ' Bookmark'}
  </button>

  <div class="title">{title}</div>

  {#if isComic}
    <button class="pill" type="button" onclick={onguided}>
      {guided ? 'Guided view' : 'Page view'}
    </button>
  {:else if !isFixed}
    <button class="tool" type="button" onclick={oncontrols}>Aa</button>
  {/if}

  <span class="pct">{Math.round(progress * 100)}%</span>
</div>

<div class="rail"><div class="fill" style:width="{progress * 100}%"></div></div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 14px 22px;
    border-bottom: 1px solid var(--line);
  }

  .tool,
  .pill {
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    cursor: pointer;
    white-space: nowrap;
  }

  .tool:hover,
  .pill:hover {
    color: var(--ink);
  }

  .tool.on {
    color: var(--accent);
  }

  .pill {
    padding: 6px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--ink);
  }

  .title {
    flex: 1;
    min-width: 0;
    text-align: center;
    font-family: var(--font-display);
    font-size: 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pct {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
  }

  .rail {
    height: 2px;
    background: var(--line);
  }

  .fill {
    height: 2px;
    background: var(--accent);
    transition: width 0.4s ease;
  }

  @media (max-width: 700px) {
    .toolbar {
      gap: 12px;
      padding: 12px 14px;
    }

    .tool,
    .pill {
      font-size: 10px;
      letter-spacing: 0.1em;
    }

    .pill {
      padding: 5px 9px;
    }

    .title {
      font-size: 14px;
    }
  }
</style>
