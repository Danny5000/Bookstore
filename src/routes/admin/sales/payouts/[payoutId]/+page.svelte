<script lang="ts">
  import { resolve } from '$app/paths';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import FinancialAmount from '$lib/components/admin/FinancialAmount.svelte';
  import type {
    PayoutMethod,
    PayoutReconciliationStatus,
    PayoutStatus
  } from '$lib/types/financial-reporting';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const payoutsRoot = resolve('/admin/sales/payouts');

  function withCursor(path: string): string {
    if (data.currentCursor === null) return path;
    const search = new SvelteURLSearchParams();
    search.set('cursor', data.currentCursor);
    return `${path}?${search.toString()}`;
  }

  function methodLabel(value: PayoutMethod): string {
    if (value === 'standard') return 'Standard';
    if (value === 'instant') return 'Instant';
    return 'Unknown method';
  }

  function statusLabel(value: PayoutStatus): string {
    if (value === 'in_transit') return 'In transit';
    return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
  }

  function reconciliationLabel(value: PayoutReconciliationStatus): string {
    if (value === 'in_progress') return 'In progress';
    if (value === 'not_applicable') return 'Not applicable';
    return 'Completed';
  }

  function reversalLabel(value: PageData['payout']['reversalState']): string {
    if (value === 'reversed') return 'Reversed';
    if (value === 'incomplete') return 'Reversal evidence incomplete';
    return 'None';
  }

  function utcTimestamp(value: string): string {
    return `${new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC'
    }).format(new Date(value))} UTC`;
  }

  const backHref = $derived(withCursor(payoutsRoot));
  const exactMembershipUnavailable = $derived(
    !data.payout.automatic || data.payout.method !== 'standard'
  );
</script>

<svelte:head><title>Payout detail · Pale Orbit Admin</title></svelte:head>

<article class="sales-overview payout-detail" aria-labelledby="payout-detail-heading">
  <header class="sales-page-heading">
    <div>
      <p class="mono">Audited local financial detail</p>
      <h1 id="payout-detail-heading" class="display">Payout detail</h1>
    </div>
    <!-- Generated only from the resolved payout route and strict service cursor. -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a href={backHref}>Back to Payouts</a>
  </header>

  {#if exactMembershipUnavailable}
    <p class="sales-notice">Fee reconciled — exact payout membership unavailable</p>
  {:else if data.payout.historicalMembershipRetained}
    <p class="sales-notice">Historical payout membership retained</p>
  {:else if !data.payout.membershipComplete}
    <p class="sales-notice">Membership unavailable</p>
  {/if}

  <p class="sales-notice">Bookstore-linked amounts are not the full payout total.</p>

  <dl class="payout-detail-grid">
    <div><dt>Payout ID</dt><dd class="payout-identifier">{data.payout.payoutId}</dd></div>
    <div><dt>Status</dt><dd>{statusLabel(data.payout.status)}</dd></div>
    <div><dt>Reconciliation</dt><dd>{reconciliationLabel(data.payout.reconciliationStatus)}</dd></div>
    <div><dt>Mode</dt><dd>{data.payout.automatic ? 'Automatic' : 'Manual'} · {methodLabel(data.payout.method)}</dd></div>
    <div><dt>Settlement currency</dt><dd>{data.payout.settlementCurrency}</dd></div>
    <div><dt>Payout amount</dt><dd><FinancialAmount amountMinor={data.payout.amountMinor} currency={data.payout.settlementCurrency} /></dd></div>
    <div><dt>Financial generation</dt><dd>{data.payout.financialGeneration}</dd></div>
    <div><dt>Membership generation</dt><dd>{data.payout.membershipGeneration ?? 'Unavailable'}</dd></div>
    <div><dt>Membership</dt><dd>{data.payout.membershipComplete ? 'Current and complete' : data.payout.historicalMembershipRetained ? 'Historical payout membership retained' : 'Membership unavailable'}</dd></div>
    <div><dt>Associated transactions</dt><dd>{data.payout.associatedTransactionCount ?? 'Unavailable'}</dd></div>
    <div><dt>Bookstore-linked transactions</dt><dd>{data.payout.bookstoreLinkedTransactionCount ?? 'Unavailable'}</dd></div>
    <div><dt>Bookstore-linked subtotal</dt><dd><FinancialAmount amountMinor={data.payout.bookstoreLinkedSubtotalMinor} currency={data.payout.settlementCurrency} /></dd></div>
    <div><dt>Bookstore-linked fee impact</dt><dd><FinancialAmount amountMinor={data.payout.bookstoreLinkedFeeImpactMinor} currency={data.payout.settlementCurrency} /></dd></div>
    <div><dt>Bookstore-linked net</dt><dd><FinancialAmount amountMinor={data.payout.bookstoreLinkedNetMinor} currency={data.payout.settlementCurrency} /></dd></div>
    <div><dt>Account-level adjustments</dt><dd>{data.payout.accountLevelAdjustmentCount ?? 'Unavailable'}</dd></div>
    <div><dt>Account-level adjustment amount</dt><dd><FinancialAmount amountMinor={data.payout.accountLevelAdjustmentMinor} currency={data.payout.settlementCurrency} /></dd></div>
    <div><dt>Reversal state</dt><dd>{reversalLabel(data.payout.reversalState)}</dd></div>
    {#if data.payout.reversalAmountMinor !== null}
      <div><dt>Reversal amount</dt><dd><FinancialAmount amountMinor={data.payout.reversalAmountMinor} currency={data.payout.settlementCurrency} /></dd></div>
    {/if}
    <div><dt>Open issues</dt><dd>{data.payout.openIssueCount}</dd></div>
    <div><dt>Failure code</dt><dd class="mono">{data.payout.safeFailureCode ?? 'None'}</dd></div>
    <div><dt>Created</dt><dd><time datetime={data.payout.createdAt}>{utcTimestamp(data.payout.createdAt)}</time></dd></div>
    <div><dt>Expected arrival</dt><dd><time datetime={data.payout.arrivalAt}>{utcTimestamp(data.payout.arrivalAt)}</time></dd></div>
    <div><dt>Local data through</dt><dd><time datetime={data.payout.freshnessAt}>{utcTimestamp(data.payout.freshnessAt)}</time></dd></div>
  </dl>
</article>
