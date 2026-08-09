<script lang="ts">
  import CatalogTitleForm from '$lib/components/admin/CatalogTitleForm.svelte';
  import type { ActionData } from './$types';
  interface Props { form: ActionData; }
  let { form }: Props = $props();
</script>

<svelte:head><title>New title · Pale Orbit Admin</title></svelte:head>
<header><p class="mono">Catalog</p><h2 class="display">Create a private title</h2><p>Metadata stays private until a reviewed revision is activated and explicitly published.</p></header>
<CatalogTitleForm message={form?.message} />

<style>
  header { max-width: 700px; margin-bottom: 30px; }
  h2 { margin: 5px 0 10px; font-size: 46px; }
  header p:last-child { color: var(--muted); line-height: 1.6; }
</style>
