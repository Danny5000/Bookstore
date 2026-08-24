<script lang="ts">
  import { SvelteDate, SvelteURLSearchParams } from 'svelte/reactivity';
  import { resolve } from '$app/paths';
  import type { SalesOverviewFilterDto } from '$lib/server/commerce/reporting/overview';

  interface Props {
    filters: SalesOverviewFilterDto;
    canExport: boolean;
  }

  let { filters, canExport }: Props = $props();

  function utcDate(value: string | null): string {
    return value?.slice(0, 10) ?? '';
  }

  function inclusiveUtcDate(exclusiveValue: string | null): string {
    if (exclusiveValue === null) return '';
    const value = new SvelteDate(exclusiveValue);
    value.setUTCDate(value.getUTCDate() - 1);
    return value.toISOString().slice(0, 10);
  }

  function exportUrl(filters: SalesOverviewFilterDto): string {
    const search = new SvelteURLSearchParams();
    search.set('range', filters.range);
    if (filters.range === 'custom' && filters.from !== null && filters.to !== null) {
      search.set('from', utcDate(filters.from));
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
    return `${resolve('/admin/sales/export.csv')}?${search.toString()}`;
  }

  const exportHref = $derived(exportUrl(filters));

  function normalizeFilterFormData(event: FormDataEvent): void {
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const submittedRange = event.formData.get('range');
    if (submittedRange !== 'custom') {
      event.formData.delete('from');
      event.formData.delete('to');
    }
    for (const element of form.elements) {
      if (
        (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) &&
        element.dataset.optional === 'true' &&
        element.value === ''
      ) {
        event.formData.delete(element.name);
      }
    }
  }
</script>

<form
  method="GET"
  action={resolve('/admin/sales')}
  class="sales-filters"
  onformdata={normalizeFilterFormData}
>
  <label>
    <span>Range</span>
    <select name="range" value={filters.range}>
      <option value="7">Prior 7 complete UTC days</option>
      <option value="30">Prior 30 complete UTC days</option>
      <option value="90">Prior 90 complete UTC days</option>
      <option value="all">All time</option>
      <option value="custom">Custom UTC dates</option>
    </select>
  </label>
  <label>
    <span>From date</span>
    <input
      name="from"
      type="date"
      value={filters.range === 'custom' ? utcDate(filters.from) : ''}
      data-optional="true"
    />
  </label>
  <label>
    <span>To date</span>
    <input
      name="to"
      type="date"
      value={filters.range === 'custom' ? inclusiveUtcDate(filters.to) : ''}
      data-optional="true"
    />
  </label>
  <label>
    <span>Title ID</span>
    <input
      name="titleId"
      value={filters.titleId ?? ''}
      maxlength="36"
      autocomplete="off"
      data-optional="true"
    />
  </label>
  <label>
    <span>Format</span>
    <select name="format" value={filters.format ?? ''} data-optional="true">
      <option value="">Any format</option>
      <option value="prose">Book</option>
      <option value="comic">Comic</option>
    </select>
  </label>
  <label>
    <span>Presentment currency</span>
    <input
      name="presentmentCurrency"
      value={filters.presentmentCurrency ?? ''}
      maxlength="3"
      pattern={'[A-Z]{3}'}
      placeholder="USD"
      autocomplete="off"
      data-optional="true"
    />
  </label>
  <label>
    <span>Settlement currency</span>
    <input
      name="settlementCurrency"
      value={filters.settlementCurrency ?? ''}
      maxlength="7"
      list="sales-settlement-currencies"
      placeholder="EUR or pending"
      autocomplete="off"
      data-optional="true"
    />
    <datalist id="sales-settlement-currencies"><option value="pending"></option></datalist>
  </label>
  <label>
    <span>Financial state</span>
    <select name="state" value={filters.state ?? ''} data-optional="true">
      <option value="">Any state</option>
      <option value="pending">Pending</option>
      <option value="fee_reconciled">Fee reconciled</option>
      <option value="payout_reconciled">Payout reconciled</option>
      <option value="exception">Exception</option>
    </select>
  </label>
  <label>
    <span>Sort</span>
    <select name="sort" value={filters.sort}>
      <option value="gross_desc">Presentment gross · high to low</option>
      <option value="title_asc">Title · A to Z</option>
    </select>
  </label>
  <div class="sales-filter-actions">
    <button type="submit">Apply filters</button>
    <a href={resolve('/admin/sales')}>Clear</a>
    {#if canExport}
      <!-- Generated only from the strict normalized noncursor DTO. -->
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
      <a href={exportHref} data-sveltekit-reload>Export filtered CSV</a>
    {/if}
  </div>
</form>
