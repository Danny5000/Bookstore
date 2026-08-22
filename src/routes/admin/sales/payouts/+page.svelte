<script lang="ts">
  import { resolve } from '$app/paths';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import PayoutTable from '$lib/components/admin/PayoutTable.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const payoutsRoot = resolve('/admin/sales/payouts');

  function payoutsUrl(cursor: string): string {
    const search = new SvelteURLSearchParams();
    search.set('cursor', cursor);
    return `${payoutsRoot}?${search.toString()}`;
  }

  const nextUrl = $derived(data.nextCursor === null ? null : payoutsUrl(data.nextCursor));
</script>

<svelte:head><title>Payouts · Pale Orbit Admin</title></svelte:head>

<section class="sales-overview" aria-labelledby="payouts-heading">
  <header class="sales-page-heading">
    <div>
      <p class="mono">Provider-neutral local financial records</p>
      <h1 id="payouts-heading" class="display">Payouts</h1>
    </div>
  </header>

  <p class="sales-results-status" role="status" aria-live="polite" aria-atomic="true">
    {data.payouts.length} {data.payouts.length === 1 ? 'payout' : 'payouts'} on this page.
  </p>

  {#if data.payouts.length === 0}
    <section class="sales-empty" aria-labelledby="payouts-empty-heading">
      <h2 id="payouts-empty-heading">No payouts yet</h2>
      <p>No local payout record is available.</p>
    </section>
  {:else}
    <PayoutTable payouts={data.payouts} currentCursor={data.currentCursor} />
  {/if}

  {#if data.currentCursor !== null || nextUrl !== null}
    <nav class="sales-pagination" aria-label="Payout pages">
      {#if data.currentCursor !== null}
        <a href={payoutsRoot}>First page</a>
      {/if}
      {#if nextUrl !== null}
        <!-- Generated only from the resolved payout route and strict service cursor. -->
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
        <a href={nextUrl}>Next page →</a>
      {/if}
    </nav>
  {/if}
</section>
