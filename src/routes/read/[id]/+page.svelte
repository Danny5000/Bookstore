<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import BookReader from '$lib/components/BookReader.svelte';
  import { titles } from '$lib/stores/titles.svelte';

  const title = $derived($page.params.id ? titles.get($page.params.id) : undefined);
  const sample = $derived($page.url.searchParams.get('sample') === '1');
</script>

<svelte:head><title>Reading {title?.title ?? ''}</title></svelte:head>

{#if title}
  <BookReader
    {title}
    {sample}
    onclose={() => void goto(resolve('/book/[id]', { id: title.id }))}
    onbuy={() => void goto(resolve('/checkout/[id]', { id: title.id }))}
  />
{:else}
  <p style="padding: 80px 48px">No such title. <a href={resolve('/catalog')}>Back to the catalog</a></p>
{/if}
