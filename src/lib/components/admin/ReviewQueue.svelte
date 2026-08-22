<script lang="ts">
  import { resolve } from '$app/paths';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import type { FinancialIssueDto } from '$lib/types/financial-reporting';

  interface Props {
    issues: readonly FinancialIssueDto[];
    currentCursor: string | null;
  }

  let { issues, currentCursor }: Props = $props();

  function actionabilityLabel(value: FinancialIssueDto['actionability']): string {
    if (value === 'refund_allocation_review') return 'Refund allocation review';
    if (value === 'wait_for_recovery') return 'Wait for recovery';
    return 'Read-only';
  }

  function impactLabel(value: FinancialIssueDto['impact']): string {
    if (value === 'exception') return 'Exception';
    if (value === 'informational') return 'Informational';
    return 'Pending';
  }

  function utcTimestamp(value: string): string {
    return `${new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC'
    }).format(new Date(value))} UTC`;
  }

  function detailHref(issueId: string): string {
    const path = resolve('/admin/sales/review/[issueId]', { issueId });
    if (currentCursor === null) return path;
    const search = new SvelteURLSearchParams();
    search.set('cursor', currentCursor);
    return `${path}?${search.toString()}`;
  }
</script>

{#if issues.length > 0}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (the named table overflow region must be keyboard-focusable) -->
  <div
    class="sales-table-region review-table-region"
    role="region"
    aria-label="Financial issues needing review"
    tabindex="0"
  >
    <table class="sales-table review-table">
      <caption>Current operational financial issues</caption>
      <thead>
        <tr>
          <th scope="col">Issue</th>
          <th scope="col">Reason</th>
          <th scope="col">Impact</th>
          <th scope="col">Actionability</th>
          <th scope="col">Observed</th>
          <th scope="col">Details</th>
        </tr>
      </thead>
      <tbody>
        {#each issues as issue (issue.issueId)}
          <tr>
            <th scope="row" class="review-identifier">
              <span class="mobile-cell-label">Issue</span>
              <strong>{issue.safeCode}</strong>
              <span>{issue.resourceType}</span>
              <span>{issue.issueId}</span>
            </th>
            <td>
              <span class="mobile-cell-label">Reason</span>
              {issue.safeReason}
            </td>
            <td>
              <span class="mobile-cell-label">Impact</span>
              <span class={`financial-state state-${issue.impact}`}>
                {impactLabel(issue.impact)}
              </span>
            </td>
            <td>
              <span class="mobile-cell-label">Actionability</span>
              <span class={`review-actionability action-${issue.actionability}`}>
                {actionabilityLabel(issue.actionability)}
              </span>
            </td>
            <td>
              <span class="mobile-cell-label">Observed</span>
              <dl class="review-observed-list">
                <div>
                  <dt>First observed</dt>
                  <dd><time datetime={issue.firstObservedAt}>{utcTimestamp(issue.firstObservedAt)}</time></dd>
                </div>
                <div>
                  <dt>Last observed</dt>
                  <dd><time datetime={issue.lastObservedAt}>{utcTimestamp(issue.lastObservedAt)}</time></dd>
                </div>
              </dl>
              <span>{issue.occurrenceCount} {issue.occurrenceCount === 1 ? 'occurrence' : 'occurrences'}</span>
            </td>
            <td>
              <span class="mobile-cell-label">Details</span>
              <!-- Generated from a typed resolved route plus the strict service cursor. -->
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
              <a href={detailHref(issue.issueId)}>View issue</a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
