<script lang="ts">
  import { resolve } from '$app/paths';
  import CoverArt from '$lib/components/CoverArt.svelte';
  import type { PublicationFormat } from '$lib/types/publication';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  type CatalogFilter = 'all' | PublicationFormat;
  let { data }: Props = $props();
  let filter = $state<CatalogFilter>('all');
  const shown = $derived(data.titles.filter((title) => filter === 'all' || title.format === filter));
  const filters: readonly { id: CatalogFilter; label: string }[] = [
    { id: 'all', label: 'Everything' },
    { id: 'prose', label: 'Books' },
    { id: 'comic', label: 'Comics' }
  ];

  function money(priceMinor: number, currency: string): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(priceMinor / 100);
  }
</script>

<svelte:head><title>Catalog · Pale Orbit Press</title></svelte:head>

<section class="wrap">
  <h1 class="display">Catalog</h1>

  <div class="filters" aria-label="Catalog filters">
    {#each filters as option (option.id)}
      <button
        class="chip"
        class:on={filter === option.id}
        type="button"
        aria-pressed={filter === option.id}
        onclick={() => (filter = option.id)}
      >{option.label}</button>
    {/each}
  </div>

  <div class="grid">
    {#each shown as title (title.id)}
      <a class="card" href={resolve('/book/[id]', { id: title.slug })}>
        <CoverArt src={title.cover?.url} alt={title.title} height="320px" />
        <div class="line">
          <span class="name">{title.title}</span>
          <span class="price">{money(title.priceMinor, title.currency)}</span>
        </div>
        <p>{title.subtitle ?? title.creatorName}</p>
      </a>
    {:else}
      <p class="empty">No titles are public yet.</p>
    {/each}
  </div>
</section>

<style>
  section { padding-top: 52px; padding-bottom: 96px; }
  h1 { font-size: 44px; margin: 0; }
  .filters { display: flex; gap: 10px; margin: 24px 0 34px; }
  .chip { padding: 9px 18px; border: 1px solid var(--line); border-radius: 999px; background: none; color: var(--muted); font-size: 13px; cursor: pointer; }
  .chip.on { border-color: var(--accent); color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 36px 28px; }
  .card { color: var(--ink); }
  .line { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-top: 14px; }
  .name { font-family: var(--font-display); font-size: 19px; }
  .price { font-family: var(--font-mono); font-size: 12px; color: var(--muted); }
  .card p, .empty { margin: 8px 0 0; font-size: 13px; line-height: 1.55; color: var(--muted); }
</style>
