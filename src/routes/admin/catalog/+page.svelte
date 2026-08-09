<script lang="ts">
  import { resolve } from '$app/paths';
  import CoverArt from '$lib/components/CoverArt.svelte';
  import type { PageData } from './$types';
  interface Props { data: PageData; }
  let { data }: Props = $props();
</script>

<svelte:head><title>Catalog · Pale Orbit Admin</title></svelte:head>
<header class="heading">
  <div><p class="mono">Publication workspace</p><h2 class="display">Catalog</h2></div>
  <a class="btn" href={resolve('/admin/catalog/new')}>New title</a>
</header>
<div class="catalog">
  {#each data.titles as title (title.id)}
    <a class="row" href={resolve('/admin/catalog/[titleId]', { titleId: title.id })}>
      <CoverArt src={title.cover?.url} alt="" width="54px" height="76px" />
      <span><strong>{title.title}</strong><small>{title.creatorName} · {title.format}</small></span>
      <span class:public={title.visibility === 'public'} class="state">{title.visibility}</span>
      <time datetime={title.updatedAt.toISOString()}>{title.updatedAt.toLocaleDateString()}</time>
    </a>
  {:else}<p class="empty">No titles yet. Create a private title to begin.</p>{/each}
</div>

<style>
  .heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 28px; }
  h2 { margin: 4px 0 0; font-size: 46px; }
  .catalog { display: grid; border-top: 1px solid var(--line); }
  .row { display: grid; grid-template-columns: 54px minmax(0, 1fr) auto auto; align-items: center; gap: 18px; padding: 14px 0; border-bottom: 1px solid var(--line); color: var(--ink); }
  .row > span:nth-child(2) { display: grid; gap: 4px; }
  strong { font-family: var(--font-display); font-size: 20px; font-weight: 500; }
  small, time { color: var(--muted); font-size: 12px; }
  .state { padding: 5px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font: 10px var(--font-mono); text-transform: uppercase; }
  .state.public { border-color: var(--accent); color: var(--accent); }
  .empty { color: var(--muted); }
  @media (max-width: 720px) { .row { grid-template-columns: 44px 1fr auto; } .row time { display: none; } }
</style>
