<script lang="ts">
  import { resolve } from '$app/paths';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import type {
    PayoutMethod,
    PayoutReconciliationStatus,
    PayoutStatus,
    PayoutSummaryDto
  } from '$lib/types/financial-reporting';
  import FinancialAmount from './FinancialAmount.svelte';

  interface Props {
    payouts: readonly PayoutSummaryDto[];
    currentCursor: string | null;
  }

  let { payouts, currentCursor }: Props = $props();

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

  function utcTimestamp(value: string): string {
    return `${new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC'
    }).format(new Date(value))} UTC`;
  }

  function detailHref(payoutId: string): string {
    const path = resolve('/admin/sales/payouts/[payoutId]', { payoutId });
    if (currentCursor === null) return path;
    const search = new SvelteURLSearchParams();
    search.set('cursor', currentCursor);
    return `${path}?${search.toString()}`;
  }
</script>

{#if payouts.length > 0}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (the named table overflow region must be keyboard-focusable) -->
  <div
    class="sales-table-region payout-table-region"
    role="region"
    aria-label="Local payout reporting"
    tabindex="0"
  >
    <table class="sales-table payout-table">
      <caption>Local payout history</caption>
      <thead>
        <tr>
          <th scope="col">Payout</th>
          <th scope="col">Mode</th>
          <th scope="col">Status</th>
          <th scope="col">Amount</th>
          <th scope="col">Membership</th>
          <th scope="col">Account-level adjustments</th>
          <th scope="col">Timeline</th>
          <th scope="col">Details</th>
        </tr>
      </thead>
      <tbody>
        {#each payouts as payout (payout.payoutId)}
          <tr>
            <th scope="row" class="payout-identifier">
              <span class="mobile-cell-label">Payout</span>
              <strong>{payout.payoutId}</strong>
              <span>Financial generation {payout.financialGeneration}</span>
              {#if payout.membershipGeneration !== null}
                <span>Membership generation {payout.membershipGeneration}</span>
              {/if}
            </th>
            <td>
              <span class="mobile-cell-label">Mode</span>
              <strong>{payout.automatic ? 'Automatic' : 'Manual'}</strong>
              <span>{methodLabel(payout.method)}</span>
            </td>
            <td>
              <span class="mobile-cell-label">Status</span>
              <span class={`financial-state state-${payout.status}`}>
                {statusLabel(payout.status)}
              </span>
              <span>{reconciliationLabel(payout.reconciliationStatus)}</span>
              {#if payout.reversalState === 'reversed'}
                <span>Reversed</span>
              {:else if payout.reversalState === 'incomplete'}
                <span>Reversal evidence incomplete</span>
              {/if}
              {#if payout.safeFailureCode !== null}
                <span class="mono">{payout.safeFailureCode}</span>
              {/if}
              {#if payout.openIssueCount > 0}
                <span>{payout.openIssueCount} open {payout.openIssueCount === 1 ? 'issue' : 'issues'}</span>
              {/if}
            </td>
            <td>
              <span class="mobile-cell-label">Amount</span>
              <FinancialAmount
                amountMinor={payout.amountMinor}
                currency={payout.settlementCurrency}
              />
            </td>
            <td>
              <span class="mobile-cell-label">Membership</span>
              {#if !payout.automatic || payout.method !== 'standard'}
                <p class="payout-limitation">
                  Fee reconciled — exact payout membership unavailable
                </p>
              {:else if payout.historicalMembershipRetained}
                <p class="payout-history">Historical payout membership retained</p>
              {:else if !payout.membershipComplete}
                <p class="payout-limitation">Membership unavailable</p>
              {/if}
              {#if payout.associatedTransactionCount !== null}
                <dl class="payout-membership-list">
                  <div>
                    <dt>Associated transactions</dt>
                    <dd>{payout.associatedTransactionCount}</dd>
                  </div>
                  <div>
                    <dt>Bookstore-linked transactions</dt>
                    <dd>{payout.bookstoreLinkedTransactionCount}</dd>
                  </div>
                  <div>
                    <dt>Bookstore-linked subtotal</dt>
                    <dd>
                      <FinancialAmount
                        amountMinor={payout.bookstoreLinkedSubtotalMinor}
                        currency={payout.settlementCurrency}
                      />
                    </dd>
                  </div>
                </dl>
              {/if}
            </td>
            <td>
              <span class="mobile-cell-label">Account-level adjustments</span>
              {#if payout.accountLevelAdjustmentCount === null}
                <span>Unavailable</span>
              {:else}
                <span>{payout.accountLevelAdjustmentCount} {payout.accountLevelAdjustmentCount === 1 ? 'transaction' : 'transactions'}</span>
                <FinancialAmount
                  amountMinor={payout.accountLevelAdjustmentMinor}
                  currency={payout.settlementCurrency}
                />
              {/if}
            </td>
            <td>
              <span class="mobile-cell-label">Timeline</span>
              <dl class="payout-timeline-list">
                <div>
                  <dt>Created</dt>
                  <dd><time datetime={payout.createdAt}>{utcTimestamp(payout.createdAt)}</time></dd>
                </div>
                <div>
                  <dt>Expected arrival</dt>
                  <dd><time datetime={payout.arrivalAt}>{utcTimestamp(payout.arrivalAt)}</time></dd>
                </div>
                <div>
                  <dt>Local data through</dt>
                  <dd><time datetime={payout.freshnessAt}>{utcTimestamp(payout.freshnessAt)}</time></dd>
                </div>
              </dl>
            </td>
            <td>
              <span class="mobile-cell-label">Details</span>
              <!-- Generated from a typed resolved route plus the strict service cursor. -->
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
              <a href={detailHref(payout.payoutId)}>View payout</a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
