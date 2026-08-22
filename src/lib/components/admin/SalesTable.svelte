<script lang="ts">
  import type { TitleSalesRowDto } from '$lib/types/financial-reporting';
  import FinancialAmount from './FinancialAmount.svelte';

  interface Props {
    rows: readonly TitleSalesRowDto[];
  }

  let { rows }: Props = $props();

  function formatLabel(format: TitleSalesRowDto['format']): string {
    return format === 'comic' ? 'Comic' : 'Book';
  }

  function stateLabel(state: TitleSalesRowDto['state']): string {
    if (state === 'fee_reconciled') return 'Fee reconciled';
    if (state === 'payout_reconciled') return 'Payout reconciled';
    if (state === 'exception') return 'Exception';
    return 'Pending';
  }

  function utcTimestamp(value: string): string {
    return `${new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC'
    }).format(new Date(value))} UTC`;
  }
</script>

{#if rows.length > 0}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (the named table overflow region must be keyboard-focusable) -->
  <div
    class="sales-table-region"
    role="region"
    aria-label="Sales results by title"
    tabindex="0"
  >
    <table class="sales-table">
      <caption>Sales by title and currency pair</caption>
      <thead>
        <tr>
          <th scope="col">Title</th>
          <th scope="col">Copies</th>
          <th scope="col">Presentment</th>
          <th scope="col">Settlement</th>
          <th scope="col">State and freshness</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (`${row.titleId}:${row.presentmentCurrency}:${row.settlementCurrency ?? ''}`)}
          <tr>
            <th scope="row" class="sales-title-cell">
              <span class="mobile-cell-label">Title</span>
              <strong>{row.currentTitle}</strong>
              <span>{formatLabel(row.format)}{row.archived ? ' · Archived' : ''}</span>
              <details>
                <summary>Sold-as details</summary>
                <ul>
                  {#each row.soldAsVariants as variant (`${variant.title}:${variant.creatorName}:${variant.format}`)}
                    <li>{variant.title} · {variant.creatorName} · {formatLabel(variant.format)}</li>
                  {/each}
                </ul>
              </details>
            </th>
            <td>
              <span class="mobile-cell-label">Copies</span>
              <dl class="sales-metric-list">
                <div><dt>Sold copies</dt><dd>{row.soldCopies}</dd></div>
                <div><dt>Fully refunded copies</dt><dd>{row.fullyRefundedCopies}</dd></div>
                <div><dt>Net copies</dt><dd>{row.netCopies}</dd></div>
              </dl>
            </td>
            <td>
              <span class="mobile-cell-label">Presentment · {row.presentmentCurrency}</span>
              <dl class="sales-metric-list">
                <div><dt>Gross presentment</dt><dd><FinancialAmount amountMinor={row.grossPresentmentMinor} currency={row.presentmentCurrency} /></dd></div>
                <div><dt>Finalized refunds</dt><dd><FinancialAmount amountMinor={row.finalizedRefundPresentmentMinor} currency={row.presentmentCurrency} /></dd></div>
                <div><dt>Dispute withdrawals</dt><dd><FinancialAmount amountMinor={row.disputeWithdrawalPresentmentMinor} currency={row.presentmentCurrency} /></dd></div>
                <div><dt>Dispute reinstatements</dt><dd><FinancialAmount amountMinor={row.disputeReinstatementPresentmentMinor} currency={row.presentmentCurrency} /></dd></div>
              </dl>
            </td>
            <td>
              <span class="mobile-cell-label">Settlement · {row.settlementCurrency ?? 'pending'}</span>
              {#if row.settlementMetricsComplete}
                <dl class="sales-metric-list">
                  <div><dt>Gross settlement</dt><dd><FinancialAmount amountMinor={row.grossSettlementMinor} currency={row.settlementCurrency} /></dd></div>
                  <div><dt>Refund impact</dt><dd><FinancialAmount amountMinor={row.refundImpactMinor} currency={row.settlementCurrency} /></dd></div>
                  <div><dt>Dispute impact</dt><dd><FinancialAmount amountMinor={row.disputeImpactMinor} currency={row.settlementCurrency} /></dd></div>
                  <div><dt>Processing fee impact</dt><dd><FinancialAmount amountMinor={row.processingFeeImpactMinor} currency={row.settlementCurrency} /></dd></div>
                  <div><dt>Refund fee impact</dt><dd><FinancialAmount amountMinor={row.refundFeeImpactMinor} currency={row.settlementCurrency} /></dd></div>
                  <div><dt>Dispute fee impact</dt><dd><FinancialAmount amountMinor={row.disputeFeeImpactMinor} currency={row.settlementCurrency} /></dd></div>
                  <div><dt>Other fee impact</dt><dd><FinancialAmount amountMinor={row.otherFeeImpactMinor} currency={row.settlementCurrency} /></dd></div>
                  <div class="sales-estimate"><dt>{row.state === 'payout_reconciled' ? 'Payout reconciled' : 'Estimated payout'}</dt><dd><FinancialAmount amountMinor={row.estimatedPayoutMinor} currency={row.settlementCurrency} /></dd></div>
                </dl>
              {:else}
                <div class="sales-unavailable">
                  <FinancialAmount
                    amountMinor={null}
                    currency={row.settlementCurrency}
                    unavailableLabel="Settlement estimate unavailable"
                  />
                  <span>{row.missingSourceCount} missing {row.missingSourceCount === 1 ? 'source' : 'sources'}</span>
                </div>
              {/if}
            </td>
            <td>
              <span class="mobile-cell-label">State and freshness</span>
              <span class={`financial-state state-${row.state}`}>{stateLabel(row.state)}</span>
              {#if row.state === 'exception'}<span class="review-label">Needs review</span>{/if}
              <time datetime={row.freshnessAt}>Financial row through {utcTimestamp(row.freshnessAt)}</time>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
