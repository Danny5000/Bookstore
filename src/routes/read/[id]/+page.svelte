<script>
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import BookReader from '$lib/components/BookReader.svelte';
  import { titles } from '$lib/stores/titles.svelte.js';

  const title = $derived(titles.get($page.params.id));
  const sample = $derived($page.url.searchParams.get('sample') === '1');
</script>

<svelte:head><title>Reading {title?.title ?? ''}</title></svelte:head>

{#if title}
  <BookReader
    {title}
    {sample}
    onclose={() => goto(`/book/${title.id}`)}
    onbuy={() => goto(`/checkout/${title.id}`)}
  />
{:else}
  <p style="padding: 80px 48px">No such title. <a href="/catalog">Back to the catalog</a></p>
{/if}
