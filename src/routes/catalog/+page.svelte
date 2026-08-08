<script lang="ts">
  import { resolve } from '$app/paths';
  import CoverArt from '$lib/components/CoverArt.svelte';
  import { titles } from '$lib/stores/titles.svelte';
  import { money } from '$lib/data/catalog';
  import type { TitleKind } from '$lib/types/catalog';

  type CatalogFilter = 'all' | TitleKind;

  interface FilterOption {
    id: CatalogFilter;
    label: string;
  }

  let filter = $state<CatalogFilter>('all');

  const shown = $derived(titles.all.filter((t) => filter === 'all' || t.kind === filter));
  const filters: FilterOption[] = [
    { id: 'all', label: 'Everything' },
    { id: 'novel', label: 'Novels' },
    { id: 'comic', label: 'Comics' }
  ];
</script>

<svelte:head><title>Catalog · Pale Orbit Press</title></svelte:head>

<section class="wrap">
  <h1 class="display">Catalog</h1>

  <div class="filters">
    {#each filters as f (f.id)}
      <button class="chip" class:on={filter === f.id} onclick={() => (filter = f.id)}>{f.label}</button>
    {/each}
  </div>

  <div class="grid">
    {#each shown as t (t.id)}
      <a class="card" href={resolve('/book/[id]', { id: t.id })}>
        <CoverArt index={t.cover} src={t.coverUrl} alt={t.title} height="320px" />
        <div class="line">
          <span class="name">{t.title}</span>
          <span class="price">{money(t.price)}</span>
        </div>
        <p>{t.summary}</p>
      </a>
    {/each}
  </div>
</section>

<style>
  section {
    padding-top: 52px;
    padding-bottom: 96px;
  }

  h1 {
    font-size: 44px;
    margin: 0;
  }

  .filters {
    display: flex;
    gap: 10px;
    margin: 24px 0 34px;
  }

  .chip {
    padding: 9px 18px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    color: var(--muted);
    font-size: 13px;
    cursor: pointer;
  }

  .chip.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 36px 28px;
  }

  .card {
    color: var(--ink);
  }

  .line {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-top: 14px;
  }

  .name {
    font-family: var(--font-display);
    font-size: 19px;
  }

  .price {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
  }

  .card p {
    margin: 8px 0 0;
    font-size: 13px;
    line-height: 1.55;
    color: var(--muted);
  }
</style>
