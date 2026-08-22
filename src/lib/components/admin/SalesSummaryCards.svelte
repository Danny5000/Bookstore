<script lang="ts">
  import type { SalesCurrencySummaryDto } from '$lib/types/financial-reporting';
  import FinancialAmount from './FinancialAmount.svelte';

  interface Props {
    summaries: readonly SalesCurrencySummaryDto[];
  }

  let { summaries }: Props = $props();

  function stateLabel(state: SalesCurrencySummaryDto['state']): string {
    if (state === 'fee_reconciled') return 'Fee reconciled';
    if (state === 'payout_reconciled') return 'Payout reconciled';
    if (state === 'exception') return 'Exception';
    return 'Pending';
  }
</script>

{#if summaries.length > 0}
  <section class="sales-summaries" aria-labelledby="sales-summary-heading">
    <h2 id="sales-summary-heading">Currency-pair summaries</h2>
    <div class="sales-summary-grid">
      {#each summaries as summary (`${summary.presentmentCurrency}:${summary.settlementCurrency ?? ''}`)}
        <article class="sales-summary-card">
          <header>
            <h3>{summary.presentmentCurrency} → {summary.settlementCurrency ?? 'Settlement pending'}</h3>
            <span class={`financial-state state-${summary.state}`}>{stateLabel(summary.state)}</span>
          </header>
          <dl class="sales-copy-counts">
            <div><dt>Titles</dt><dd>{summary.titleCount}</dd></div>
            <div><dt>Sold copies</dt><dd>{summary.soldCopies}</dd></div>
            <div><dt>Fully refunded copies</dt><dd>{summary.fullyRefundedCopies}</dd></div>
            <div><dt>Net copies</dt><dd>{summary.netCopies}</dd></div>
          </dl>
          <dl class="sales-money-list">
            <div><dt>Gross presentment</dt><dd><FinancialAmount amountMinor={summary.grossPresentmentMinor} currency={summary.presentmentCurrency} /></dd></div>
            <div><dt>Finalized refunds</dt><dd><FinancialAmount amountMinor={summary.finalizedRefundPresentmentMinor} currency={summary.presentmentCurrency} /></dd></div>
            <div><dt>Dispute withdrawals</dt><dd><FinancialAmount amountMinor={summary.disputeWithdrawalPresentmentMinor} currency={summary.presentmentCurrency} /></dd></div>
            <div><dt>Dispute reinstatements</dt><dd><FinancialAmount amountMinor={summary.disputeReinstatementPresentmentMinor} currency={summary.presentmentCurrency} /></dd></div>
          </dl>
          {#if summary.settlementMetricsComplete}
            <dl class="sales-money-list settlement-values">
              <div><dt>Gross settlement</dt><dd><FinancialAmount amountMinor={summary.grossSettlementMinor} currency={summary.settlementCurrency} /></dd></div>
              <div><dt>Refund impact</dt><dd><FinancialAmount amountMinor={summary.refundImpactMinor} currency={summary.settlementCurrency} /></dd></div>
              <div><dt>Dispute impact</dt><dd><FinancialAmount amountMinor={summary.disputeImpactMinor} currency={summary.settlementCurrency} /></dd></div>
              <div><dt>Processing fee impact</dt><dd><FinancialAmount amountMinor={summary.processingFeeImpactMinor} currency={summary.settlementCurrency} /></dd></div>
              <div><dt>Refund fee impact</dt><dd><FinancialAmount amountMinor={summary.refundFeeImpactMinor} currency={summary.settlementCurrency} /></dd></div>
              <div><dt>Dispute fee impact</dt><dd><FinancialAmount amountMinor={summary.disputeFeeImpactMinor} currency={summary.settlementCurrency} /></dd></div>
              <div><dt>Other fee impact</dt><dd><FinancialAmount amountMinor={summary.otherFeeImpactMinor} currency={summary.settlementCurrency} /></dd></div>
              <div class="sales-estimate"><dt>{summary.state === 'payout_reconciled' ? 'Payout reconciled' : 'Estimated payout'}</dt><dd><FinancialAmount amountMinor={summary.estimatedPayoutMinor} currency={summary.settlementCurrency} /></dd></div>
            </dl>
          {:else}
            <div class="sales-unavailable">
              <FinancialAmount
                amountMinor={null}
                currency={summary.settlementCurrency}
                unavailableLabel="Settlement estimate unavailable"
              />
              <span>{summary.missingSourceCount} missing {summary.missingSourceCount === 1 ? 'source' : 'sources'}</span>
            </div>
          {/if}
        </article>
      {/each}
    </div>
  </section>
{/if}
