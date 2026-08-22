<script lang="ts">
  import { SvelteDate } from 'svelte/reactivity';
  import { resolve } from '$app/paths';
  import type { SalesOverviewFilterDto } from '$lib/server/commerce/reporting/overview';

  interface Props {
    filters: SalesOverviewFilterDto;
  }

  let { filters }: Props = $props();

  function utcDate(value: string | null): string {
    return value?.slice(0, 10) ?? '';
  }

  function inclusiveUtcDate(exclusiveValue: string | null): string {
    if (exclusiveValue === null) return '';
    const value = new SvelteDate(exclusiveValue);
    value.setUTCDate(value.getUTCDate() - 1);
    return value.toISOString().slice(0, 10);
  }

  function omitEmptyOptionalFields(event: SubmitEvent): void {
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    for (const element of form.elements) {
      if (
        (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) &&
        element.dataset.optional === 'true' &&
        element.value === ''
      ) {
        element.disabled = true;
      }
    }
  }
</script>

<form
  method="GET"
  action={resolve('/admin/sales')}
  class="sales-filters"
  onsubmit={omitEmptyOptionalFields}
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
  </div>
</form>
