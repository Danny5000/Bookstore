<script lang="ts">
  import { SvelteDate, SvelteURLSearchParams } from 'svelte/reactivity';
  import { page } from '$app/stores';
  import { resolve } from '$app/paths';
  import SalesFilters from '$lib/components/admin/SalesFilters.svelte';
  import SalesSummaryCards from '$lib/components/admin/SalesSummaryCards.svelte';
  import SalesTable from '$lib/components/admin/SalesTable.svelte';
  import type { SalesOverviewFilterDto } from '$lib/server/commerce/reporting/overview';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const salesRoot = resolve('/admin/sales');
  const reviewHref = `${salesRoot}/review`;

  function inclusiveUtcDate(exclusiveValue: string): string {
    const value = new SvelteDate(exclusiveValue);
    value.setUTCDate(value.getUTCDate() - 1);
    return value.toISOString().slice(0, 10);
  }

  function overviewUrl(filters: SalesOverviewFilterDto, cursor: string | null = null): string {
    const search = new SvelteURLSearchParams();
    search.set('range', filters.range);
    if (filters.range === 'custom' && filters.from !== null && filters.to !== null) {
      search.set('from', filters.from.slice(0, 10));
      search.set('to', inclusiveUtcDate(filters.to));
    }
    if (filters.titleId !== null) search.set('titleId', filters.titleId);
    if (filters.format !== null) search.set('format', filters.format);
    if (filters.presentmentCurrency !== null) {
      search.set('presentmentCurrency', filters.presentmentCurrency);
    }
    if (filters.settlementCurrency !== null) {
      search.set('settlementCurrency', filters.settlementCurrency);
    }
    if (filters.state !== null) search.set('state', filters.state);
    search.set('sort', filters.sort);
    if (cursor !== null) search.set('cursor', cursor);
    return `${salesRoot}?${search.toString()}`;
  }

  function hasActiveFilters(filters: SalesOverviewFilterDto): boolean {
    return filters.range !== '30' ||
      filters.titleId !== null ||
      filters.format !== null ||
      filters.presentmentCurrency !== null ||
      filters.settlementCurrency !== null ||
      filters.state !== null ||
      filters.sort !== 'gross_desc';
  }

  function utcTimestamp(value: string): string {
    return `${new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC'
    }).format(new Date(value))} UTC`;
  }

  const nextUrl = $derived(data.nextCursor === null ? null : overviewUrl(data.filters, data.nextCursor));
  const firstPageUrl = $derived(overviewUrl(data.filters));
  const pendingOnly = $derived(data.rows.length > 0 && data.rows.every((row) => row.state === 'pending'));
</script>

<svelte:head><title>Sales overview · Pale Orbit Admin</title></svelte:head>

<section class="sales-overview" aria-labelledby="sales-overview-heading">
  <header class="sales-page-heading">
    <div>
      <p class="mono">Signed bookstore reporting</p>
      <h1 id="sales-overview-heading" class="display">Sales overview</h1>
    </div>
    {#if data.needsReviewCount > 0}
      <!-- Derived from the resolved Sales root until Task 8 creates the typed route. -->
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
      <a class="needs-review-count" href={reviewHref}>
        <strong>{data.needsReviewCount}</strong>
        <span>{data.needsReviewCount === 1 ? 'item needs review' : 'items need review'}</span>
      </a>
    {/if}
  </header>

  {#if !data.stripeEnabled}
    <p class="sales-alert" role="alert">
      <strong>Stripe is disabled.</strong> Settlement data will not refresh until Stripe is enabled.
    </p>
  {/if}
  {#if data.dataThroughAt === null}
    <p class="sales-alert" role="alert">Financial freshness unavailable. The page does not represent live provider state.</p>
  {:else}
    <p class="sales-freshness">
      Financial data through
      <time datetime={data.dataThroughAt}>{utcTimestamp(data.dataThroughAt)}</time>.
      This is not live provider state.
    </p>
  {/if}
  {#if pendingOnly}
    <p class="sales-notice">All matching sales are settlement pending.</p>
  {/if}

  <SalesSummaryCards summaries={data.summaries} />
  <SalesFilters filters={data.filters} canExport={data.canExport} />

  <p class="sales-results-status" role="status" aria-live="polite" aria-atomic="true">
    {data.rows.length} matching {data.rows.length === 1 ? 'sales row' : 'sales rows'}.
  </p>

  {#if data.rows.length === 0}
    <section class="sales-empty" aria-labelledby="sales-empty-heading">
      <h2 id="sales-empty-heading">
        {hasActiveFilters(data.filters) ? 'No sales match these filters' : 'No sales data yet'}
      </h2>
      <p>
        {hasActiveFilters(data.filters)
          ? 'Clear or change the filters to broaden the reporting cohort.'
          : 'Paid title sales will appear here after local financial evidence is available.'}
      </p>
    </section>
  {:else}
    <SalesTable rows={data.rows} />
  {/if}

  {#if nextUrl !== null || $page.url.searchParams.has('cursor')}
    <nav class="sales-pagination" aria-label="Sales result pages">
      {#if $page.url.searchParams.has('cursor')}
        <!-- Generated only from the strict normalized DTO. -->
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
        <a href={firstPageUrl}>First page</a>
      {/if}
      {#if nextUrl !== null}
        <!-- Generated only from the strict normalized DTO and service cursor. -->
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
        <a href={nextUrl}>Next page →</a>
      {/if}
    </nav>
  {/if}

  {#if data.needsReviewCount > 0}
    <aside class="sales-review-callout" aria-labelledby="sales-review-heading">
      <div>
        <h2 id="sales-review-heading">Needs review</h2>
        <p>{data.needsReviewCount} current financial {data.needsReviewCount === 1 ? 'issue needs' : 'issues need'} attention.</p>
      </div>
      <!-- Derived from the resolved Sales root until Task 8 creates the typed route. -->
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
      <a href={reviewHref}>Needs review</a>
    </aside>
  {/if}
</section>
