<script lang="ts">
  import { resolve } from '$app/paths';
  import type { PageData } from './$types';
  interface Props { data: PageData; }
  let { data }: Props = $props();
</script>

<svelte:head><title>Admin · Pale Orbit Press</title></svelte:head>
<section class="overview">
  <p class="mono">Catalog operations</p>
  <h2 class="display">Publication control room</h2>
  <p>
    Create private titles, review immutable EPUB and comic revisions, approve reader settings,
    and deliberately control what reaches the storefront.
  </p>
  <div class="counts">
    <div><strong>{data.catalog.total}</strong><span>Total titles</span></div>
    <div><strong>{data.catalog.private}</strong><span>Private</span></div>
    <div><strong>{data.catalog.public}</strong><span>Public</span></div>
  </div>
  <div class="links"><a class="btn" href={resolve('/admin/catalog')}>Open catalog</a><a href={resolve('/admin/users')}>Manage users</a></div>
</section>

<style>
  .overview { max-width: 700px; }
  h2 { margin: 5px 0 12px; font-size: clamp(38px, 6vw, 58px); }
  p:not(.mono) { max-width: 620px; margin: 0 0 28px; color: var(--muted); line-height: 1.7; }
  .links { display: flex; align-items: center; gap: 18px; }
  .counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0 0 28px; }
  .counts div { display: grid; gap: 4px; padding: 16px; border: 1px solid var(--line); }
  .counts strong { font: 28px var(--font-display); }
  .counts span { color: var(--muted); font: 10px var(--font-mono); text-transform: uppercase; letter-spacing: 0.1em; }
</style>
