<script lang="ts">
  import StorefrontTitleCard from '$lib/components/StorefrontTitleCard.svelte';
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
      <StorefrontTitleCard
        titleId={title.id}
        slug={title.slug}
        title={title.title}
        creatorName={title.creatorName}
        subtitle={title.subtitle}
        format={title.format}
        coverUrl={title.cover?.url ?? null}
        priceMinor={title.priceMinor}
        currency={title.currency}
        coverHeight="320px"
      />
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
  .empty { margin: 8px 0 0; font-size: 13px; line-height: 1.55; color: var(--muted); }
</style>
