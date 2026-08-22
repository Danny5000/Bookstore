<script lang="ts">
  import { resolve } from '$app/paths';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import type { FinancialIssueDto } from '$lib/types/financial-reporting';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const salesRoot = resolve('/admin/sales');
  const reviewRoot = resolve('/admin/sales/review');

  function withCursor(path: string, key: 'cursor' | 'reviewCursor'): string {
    if (data.currentCursor === null) return path;
    const search = new SvelteURLSearchParams();
    search.set(key, data.currentCursor);
    return `${path}?${search.toString()}`;
  }

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

  const backHref = $derived(withCursor(reviewRoot, 'cursor'));
  const refundHref = $derived(
    data.issue.actionability === 'refund_allocation_review' && data.issue.refundId !== null
      ? withCursor(`${salesRoot}/refunds/${encodeURIComponent(data.issue.refundId)}`, 'reviewCursor')
      : null
  );
</script>

<svelte:head><title>Financial issue · Pale Orbit Admin</title></svelte:head>

<article class="sales-overview review-detail" aria-labelledby="financial-issue-heading">
  <header class="sales-page-heading">
    <div>
      <p class="mono">Audited local financial detail</p>
      <h1 id="financial-issue-heading" class="display">Financial issue</h1>
    </div>
    <!-- Generated only from the resolved review route and strict service cursor. -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a href={backHref}>Back to Needs review</a>
  </header>

  <p class="sales-notice">{data.issue.safeReason}</p>

  <dl class="review-detail-grid">
    <div><dt>Issue ID</dt><dd class="review-identifier">{data.issue.issueId}</dd></div>
    <div><dt>Resource ID</dt><dd class="review-identifier">{data.issue.resourceId}</dd></div>
    <div><dt>Resource type</dt><dd>{data.issue.resourceType}</dd></div>
    <div><dt>Safe code</dt><dd>{data.issue.safeCode}</dd></div>
    <div><dt>State</dt><dd>{data.issue.state === 'open' ? 'Open' : 'Resolved'}</dd></div>
    <div><dt>Impact</dt><dd><span class={`financial-state state-${data.issue.impact}`}>{impactLabel(data.issue.impact)}</span></dd></div>
    <div><dt>Actionability</dt><dd><span class={`review-actionability action-${data.issue.actionability}`}>{actionabilityLabel(data.issue.actionability)}</span></dd></div>
    <div><dt>Occurrences</dt><dd>{data.issue.occurrenceCount}</dd></div>
    <div><dt>First observed</dt><dd><time datetime={data.issue.firstObservedAt}>{utcTimestamp(data.issue.firstObservedAt)}</time></dd></div>
    <div><dt>Last observed</dt><dd><time datetime={data.issue.lastObservedAt}>{utcTimestamp(data.issue.lastObservedAt)}</time></dd></div>
  </dl>

  <section class="review-workflow" aria-labelledby="review-workflow-heading">
    <h2 id="review-workflow-heading">Available workflow</h2>
    {#if refundHref !== null}
      <!-- This route is introduced by the bounded refund-review task. -->
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
      <a href={refundHref}>Review refund allocation</a>
    {:else}
      <p>No administrator action is available for this issue.</p>
    {/if}
  </section>
</article>
