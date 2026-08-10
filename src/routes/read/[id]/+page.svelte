<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { browser } from '$app/environment';
  import BookReader from '$lib/components/BookReader.svelte';
  import {
    createMemoryReaderPersistence,
    createPreviewReaderPersistence,
    createServerReaderPersistence
  } from '$lib/reader/persistence';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const initialData = untrack(() => data);
  const persistence =
    initialData.persistenceKind === 'server'
      ? createServerReaderPersistence({
          titleId: initialData.document.titleId,
          initialState: initialData.initialState
        })
      : initialData.persistenceKind === 'preview-local' && browser
        ? createPreviewReaderPersistence({
            document: initialData.document,
            initialState: initialData.initialState
          })
        : createMemoryReaderPersistence({
            document: initialData.document,
            initialState: initialData.initialState
          });
</script>

<svelte:head><title>Reading {data.document.title}</title></svelte:head>

<BookReader
  document={data.document}
  {persistence}
  onclose={() => void goto(resolve('/book/[id]', { id: data.slug }))}
  onbuy={() => void goto(resolve('/book/[id]#purchase', { id: data.slug }))}
/>
