<script lang="ts">
  import { resolve } from '$app/paths';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import ReviewQueue from '$lib/components/admin/ReviewQueue.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const reviewRoot = resolve('/admin/sales/review');

  function reviewUrl(cursor: string): string {
    const search = new SvelteURLSearchParams();
    search.set('cursor', cursor);
    return `${reviewRoot}?${search.toString()}`;
  }

  const nextUrl = $derived(data.nextCursor === null ? null : reviewUrl(data.nextCursor));
</script>

<svelte:head><title>Needs review · Pale Orbit Admin</title></svelte:head>

<section class="sales-overview" aria-labelledby="needs-review-heading">
  <header class="sales-page-heading">
    <div>
      <p class="mono">Current operational financial issues</p>
      <h1 id="needs-review-heading" class="display">Needs review</h1>
    </div>
  </header>

  <p class="sales-results-status" role="status" aria-live="polite" aria-atomic="true">
    {data.issues.length} current {data.issues.length === 1 ? 'issue' : 'issues'} on this page.
  </p>

  {#if data.issues.length === 0}
    <section class="sales-empty" aria-labelledby="review-empty-heading">
      <h2 id="review-empty-heading">No current financial issues</h2>
      <p>No operational financial issue needs attention right now.</p>
    </section>
  {:else}
    <ReviewQueue issues={data.issues} currentCursor={data.currentCursor} />
  {/if}

  {#if data.currentCursor !== null || nextUrl !== null}
    <nav class="sales-pagination" aria-label="Needs review pages">
      {#if data.currentCursor !== null}
        <a href={reviewRoot}>First page</a>
      {/if}
      {#if nextUrl !== null}
        <!-- Generated only from the resolved review route and strict service cursor. -->
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
        <a href={nextUrl}>Next page →</a>
      {/if}
    </nav>
  {/if}
</section>
