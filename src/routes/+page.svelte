<script lang="ts">
  import { resolve } from '$app/paths';
  import BookVolume from '$lib/components/BookVolume.svelte';
  import CoverArt from '$lib/components/CoverArt.svelte';
  import type { PageData } from './$types';

  interface Props { data: PageData; }
  let { data }: Props = $props();
  const featured = $derived(data.titles[0]);

  function money(priceMinor: number, currency: string): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
      priceMinor / 100
    );
  }
</script>

<svelte:head><title>Pale Orbit Press</title></svelte:head>

{#if featured}
  <section class="hero wrap">
    <div class="copy">
      <div class="mono accent">Science fiction &amp; true stories</div>
      <h1 class="display">Books that still<br />turn like books.</h1>
      <p>
        Every title opens in a real reader—paper that bends under your thumb, spreads that breathe,
        and comics that read like a stapled issue. Free reviewed previews are available now;
        checkout is not yet available.
      </p>
      <div class="actions">
        <a class="btn" href={resolve('/read/[id]', { id: featured.id })}>
          {featured.format === 'comic' ? 'Preview first pages' : 'Read the free preview'}
        </a>
        <a class="btn ghost" href={resolve('/catalog')}>Browse the catalog</a>
      </div>
    </div>

    <a class="art" href={resolve('/book/[id]', { id: featured.slug })}>
      <BookVolume
        title={featured.title}
        format={featured.format}
        creatorName={featured.creatorName}
        priceLabel={money(featured.priceMinor, featured.currency)}
        coverSeed={featured.id}
        coverUrl={featured.cover?.url ?? null}
        width={296}
        height={430}
        interactive
        tilt={-16}
      />
    </a>
  </section>
{:else}
  <section class="empty-hero wrap">
    <div class="mono accent">Pale Orbit Press</div>
    <h1 class="display">The next publication is being prepared.</h1>
    <p>No public titles are available yet.</p>
  </section>
{/if}

<section class="wrap">
  <div class="section-head">
    <h2 class="display">Recent releases</h2>
    <a class="mono" href={resolve('/catalog')}>All titles &rarr;</a>
  </div>

  <div class="grid">
    {#each data.titles as title (title.id)}
      <a class="card" href={resolve('/book/[id]', { id: title.slug })}>
        <CoverArt src={title.cover?.url} alt={title.title} height="300px" />
        <div class="line">
          <span class="name">{title.title}</span>
          <span class="price">{money(title.priceMinor, title.currency)}</span>
        </div>
        <div class="mono">{title.format === 'comic' ? 'Comic' : 'Book'} · {title.creatorName}</div>
      </a>
    {/each}
  </div>
</section>

<section class="wrap features">
  <div><div class="mono accent">01 / Reader</div><p>Turn responsive pages with touch, pointer, or arrow keys.</p></div>
  <div><div class="mono accent">02 / Comics</div><p>Read a full issue page or use the reviewed guided-panel view.</p></div>
  <div><div class="mono accent">03 / Library</div><p>Your library keeps entitled titles, progress, bookmarks, and retained original downloads together.</p></div>
</section>

<style>
  .hero { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 40px; align-items: center; padding-top: 84px; padding-bottom: 72px; }
  .empty-hero { padding-top: 100px; padding-bottom: 100px; }
  .copy { animation: fade-up 0.7s ease both; }
  h1 { font-size: clamp(44px, 6vw, 82px); line-height: 0.98; margin: 24px 0; }
  .copy p, .empty-hero p { max-width: 48ch; font-size: 17px; line-height: 1.65; color: var(--muted); margin: 0 0 36px; text-wrap: pretty; }
  .actions { display: flex; gap: 12px; flex-wrap: wrap; }
  .accent { color: var(--accent); }
  .art { display: flex; justify-content: center; align-items: center; perspective: 2200px; perspective-origin: 50% 45%; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; border-top: 1px solid var(--line); padding-top: 22px; margin-bottom: 26px; }
  .section-head h2 { font-size: 26px; font-weight: 400; margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 30px 26px; }
  .card { color: var(--ink); }
  .line { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-top: 14px; }
  .name { font-family: var(--font-display); font-size: 18px; line-height: 1.2; }
  .price { font-family: var(--font-mono); font-size: 12px; color: var(--muted); }
  .card .mono { margin-top: 7px; color: var(--muted); }
  .features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 64px auto 96px; }
  .features > div { background: var(--bg); padding: 30px; }
  .features p { margin: 12px 0 0; font-size: 15px; line-height: 1.6; color: var(--muted); }
  @media (max-width: 900px) { .hero, .features { grid-template-columns: 1fr; } }
</style>
