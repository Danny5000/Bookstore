<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import BookReader from '$lib/components/BookReader.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<svelte:head><title>Reading {data.document.title}</title></svelte:head>

<BookReader
  document={data.document}
  access="preview"
  onclose={() => void goto(resolve('/book/[id]', { id: data.slug }))}
  onbuy={() => void goto(resolve('/book/[id]#purchase', { id: data.slug }))}
/>
