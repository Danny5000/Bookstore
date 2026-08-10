<script lang="ts">
  import { resolve } from '$app/paths';
  import CoverArt from '$lib/components/CoverArt.svelte';
  import { coverBackground, coverPalette } from '$lib/cover-art';
  import type { PageData } from './$types';

  interface Props { data: PageData; }
  let { data }: Props = $props();

  function progressLabel(value: number | null): string {
    return `${value ?? 0}% read`;
  }

  function downloadLabel(format: 'epub' | 'cbz' | 'zip' | null): string {
    return format ? `Download ${format.toUpperCase()}` : 'Download unavailable';
  }
</script>

<svelte:head><title>My Library · Pale Orbit Press</title></svelte:head>

<section class="wrap">
  <h1 class="display">My Library</h1>

  {#if !data.signedIn}
    <div class="state-card">
      <h2 class="display">Sign in to view your library</h2>
      <p>Your entitled books, comics, downloads, and saved reading positions appear here.</p>
      <a class="btn" href="{resolve('/library')}?auth=required">Sign in</a>
    </div>
  {:else if data.entries.length === 0}
    <div class="state-card">
      <h2 class="display">Your library is empty</h2>
      <p>Free previews remain available in the catalog; checkout is not yet available.</p>
      <a class="btn ghost" href={resolve('/catalog')}>Browse public titles</a>
    </div>
  {:else}
    <p class="note">
      {data.entries.length} title{data.entries.length === 1 ? '' : 's'} · reading positions are saved automatically
    </p>

    <div class="bookcase" aria-label="Library shelf">
      {#each data.entries as entry (entry.titleId)}
        {@const pair = coverPalette(entry.titleId)}
        {@const shelfHeight = 200 + (entry.title.length % 5) * 9}
        {@const spineWidth = entry.format === 'comic' ? 18 : 52}
        <div class="book-wrap" style:height="{shelfHeight}px" style:width="{spineWidth}px">
          {#if entry.readUrl}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a class="book" href={entry.readUrl} aria-label="Read {entry.title}">
              <span
                class="cover-face"
                style:background={coverBackground(entry.titleId, entry.coverUrl)}
              ></span>
              <span
                class="spine-plate"
                style:background="linear-gradient(90deg, {pair[1]}, {pair[0]} 70%, {pair[1]})"
              ><span>{entry.title}</span></span>
            </a>
          {:else}
            <div class="book unavailable" aria-label="{entry.title}, temporarily unavailable">
              <span class="cover-face" style:background={coverBackground(entry.titleId, entry.coverUrl)}></span>
              <span class="spine-plate"><span>{entry.title}</span></span>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <div class="rows">
      {#each data.entries as entry (entry.titleId)}
        <article class="row">
          <CoverArt src={entry.coverUrl} alt={entry.title} width="72px" height="104px" />
          <div class="details">
            <div class="head">
              <div><h2 class="display">{entry.title}</h2><p>{entry.creatorName}</p></div>
              <span class="mono plain">{progressLabel(entry.progressPercent)}</span>
            </div>
            {#if entry.availability === 'available'}
              <div class="bar"><div class="fill" style:width="{entry.progressPercent ?? 0}%"></div></div>
              <div class="actions">
                {#if entry.readUrl}
                  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                  <a class="btn small" href={entry.progressPercent && entry.resumeUrl ? entry.resumeUrl : entry.readUrl}>
                    {entry.progressPercent ? 'Resume' : 'Read'}
                  </a>
                {/if}
                {#if entry.downloadUrl && entry.downloadFormat}
                  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                  <a class="btn ghost small" href={entry.downloadUrl}>
                    {downloadLabel(entry.downloadFormat)}
                  </a>
                {/if}
              </div>
            {:else}
              <p class="unavailable-copy">Temporarily unavailable while a current edition is prepared.</p>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  section { max-width: 1240px; padding-top: 52px; padding-bottom: 110px; }
  h1 { margin: 0 0 6px; font-size: 44px; }
  .note, .state-card p, .head p, .unavailable-copy { color: var(--muted); }
  .note { margin: 0 0 34px; }
  .state-card { max-width: 620px; margin-top: 34px; padding: 30px; border: 1px solid var(--line); }
  .state-card h2 { margin: 0; font-size: 30px; }
  .state-card p { margin: 12px 0 22px; line-height: 1.6; }
  .bookcase { display: flex; align-items: flex-end; gap: 10px; min-height: 300px; padding: 58px 28px 20px; overflow-x: auto; border-bottom: 14px solid var(--raised); box-shadow: 0 22px 40px -26px rgb(0 0 0 / 70%); }
  .book-wrap { flex: 0 0 auto; }
  .book { position: relative; display: block; width: 100%; height: 100%; transition: transform 0.25s ease; }
  .book[href]:hover { transform: translateY(-12px); }
  .cover-face { position: absolute; inset: 0; transform: translateX(100%) rotateY(90deg); transform-origin: left center; }
  .spine-plate { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border-radius: 2px; box-shadow: 0 14px 24px -14px rgb(0 0 0 / 80%); }
  .spine-plate span { writing-mode: vertical-rl; max-height: calc(100% - 20px); overflow: hidden; color: rgb(255 255 255 / 92%); font-family: var(--font-display); text-overflow: ellipsis; white-space: nowrap; }
  .book.unavailable { opacity: 0.45; }
  .rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 18px; margin-top: 44px; }
  .row { display: grid; grid-template-columns: 72px 1fr; gap: 16px; padding: 18px; border: 1px solid var(--line); }
  .details { min-width: 0; }
  .head { display: flex; justify-content: space-between; gap: 12px; }
  .head h2 { margin: 0; font-size: 21px; }
  .head p { margin: 4px 0 0; font-size: 13px; }
  .plain { color: var(--muted); letter-spacing: 0.08em; text-transform: none; white-space: nowrap; }
  .bar { height: 3px; margin: 16px 0; background: var(--line); }
  .fill { height: 100%; background: var(--accent); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .small { padding: 8px 14px; font-size: 13px; }
  .unavailable-copy { margin: 16px 0 0; font-size: 13px; line-height: 1.5; }
  @media (max-width: 600px) { .rows { grid-template-columns: 1fr; } .row { grid-template-columns: 56px 1fr; } }
</style>
