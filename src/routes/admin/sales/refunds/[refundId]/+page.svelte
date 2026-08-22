<script lang="ts">
  import { resolve } from '$app/paths';
  import FinancialAmount from '$lib/components/admin/FinancialAmount.svelte';
  import FinancialActionOutcome from '$lib/components/admin/FinancialActionOutcome.svelte';
  import RefundAllocationEditor from '$lib/components/admin/RefundAllocationEditor.svelte';
  import type { FinancialAdminCommandReferenceDto } from '$lib/types/financial-reporting';
  import type { ActionData, PageData } from './$types';

  interface Props {
    data: PageData;
    form?: ActionData;
  }

  interface ActionFailurePresentation {
    message: string;
    reloadRequired: boolean;
  }

  type RetrySubmission =
    | {
        readonly action: 'saveDraft';
        readonly idempotencyKey: string;
        readonly expectedVersion: number | null;
        readonly items: readonly {
          readonly orderItemId: string;
          readonly totalPresentmentMinor: number;
        }[];
      }
    | {
        readonly action: 'discardDraft';
        readonly idempotencyKey: string;
        readonly expectedActiveDraftVersion: number;
      };

  let { data, form }: Props = $props();
  const reviewRoot = resolve('/admin/sales/review');

  function withReviewCursor(path: string): string {
    if (data.reviewCursor === null) return path;
    return `${path}?cursor=${encodeURIComponent(data.reviewCursor)}`;
  }

  function reloadHref(): string {
    const root = resolve('/admin/sales/refunds/[refundId]', {
      refundId: data.detail.refundId
    });
    return data.reviewCursor === null
      ? root
      : `${root}?reviewCursor=${encodeURIComponent(data.reviewCursor)}`;
  }

  function actionFailurePresentation(code: unknown): ActionFailurePresentation | null {
    switch (code) {
      case 'unauthenticated':
        return {
          message: 'Your session no longer permits this refund action. Sign in again before trying again.',
          reloadRequired: false
        };
      case 'forbidden':
        return {
          message: 'Your permissions no longer allow this refund action. Ask an administrator to restore access before trying again.',
          reloadRequired: false
        };
      case 'not_found':
        return {
          message: 'This refund is no longer available for review. Reload current refund facts before continuing.',
          reloadRequired: true
        };
      case 'stale_state':
        return {
          message: 'The refund facts changed before this request could be submitted. Reload current refund facts and review the allocation before trying again.',
          reloadRequired: true
        };
      case 'temporarily_unavailable':
        return {
          message: 'We could not confirm whether the refund request was submitted. Retry the exact request below before editing again.',
          reloadRequired: false
        };
      default:
        return null;
    }
  }

  function retryActionHref(action: RetrySubmission['action']): string {
    const marker = `?/${action}`;
    return data.reviewCursor === null
      ? marker
      : `${marker}&reviewCursor=${encodeURIComponent(data.reviewCursor)}`;
  }

  const submittedCommand = $derived(
    form && 'command' in form
      ? form.command as FinancialAdminCommandReferenceDto | undefined
      : undefined
  );
  const fieldErrors = $derived(
    form && 'fieldErrors' in form
      ? form.fieldErrors as Readonly<Record<string, string>>
      : {}
  );
  const actionFailure = $derived(actionFailurePresentation(
    form && 'code' in form ? form.code : undefined
  ));
  const retrySubmission = $derived(
    form && 'retrySubmission' in form
      ? form.retrySubmission as RetrySubmission | null
      : null
  );
</script>

<svelte:head><title>Refund allocation review · Pale Orbit Admin</title></svelte:head>

<article class="sales-overview refund-review" aria-labelledby="refund-review-heading">
  <header class="sales-page-heading">
    <div>
      <p class="mono">Audited local financial detail</p>
      <h1 id="refund-review-heading" class="display">Refund allocation review</h1>
    </div>
    <!-- Generated only from the resolved review route and strict cursor. -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a href={withReviewCursor(reviewRoot)}>Back to Needs review</a>
  </header>

  <dl class="review-detail-grid">
    <div><dt>Refund ID</dt><dd class="review-identifier">{data.detail.refundId}</dd></div>
    <div><dt>Order ID</dt><dd class="review-identifier">{data.detail.orderId}</dd></div>
    <div><dt>Status</dt><dd>{data.detail.status}</dd></div>
    <div><dt>Allocation status</dt><dd>{data.detail.allocationStatus}</dd></div>
    <div><dt>Financial state</dt><dd>{data.detail.financialState}</dd></div>
    <div>
      <dt>Refund total</dt>
      <dd><FinancialAmount amountMinor={data.detail.amountMinor} currency={data.detail.currency} /></dd>
    </div>
    <div>
      <dt>Order total</dt>
      <dd><FinancialAmount amountMinor={data.detail.orderTotalMinor} currency={data.detail.currency} /></dd>
    </div>
    <div><dt>Open issues</dt><dd>{data.detail.openIssueCount}</dd></div>
    <div>
      <dt>Local data through</dt>
      <dd><time datetime={data.detail.dataThroughAt}>{data.detail.dataThroughAt}</time></dd>
    </div>
  </dl>

  <section aria-labelledby="refund-items-heading">
    <h2 id="refund-items-heading">Purchased items</h2>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="sales-table-region" role="region" aria-label="Refund purchase items" tabindex="0">
      <table>
        <caption>Sold-as purchase facts and remaining refund capacity</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Paid</th>
            <th scope="col">Already refunded</th>
            <th scope="col">Available</th>
          </tr>
        </thead>
        <tbody>
          {#each data.detail.items as item (item.orderItemId)}
            <tr>
              <th scope="row">{item.soldAsTitle}<br /><small>{item.soldAsCreatorName}</small></th>
              <td><FinancialAmount amountMinor={item.paidTotalMinor} currency={item.currency} /></td>
              <td><FinancialAmount amountMinor={item.finalizedRefundTotalMinor} currency={item.currency} /></td>
              <td><FinancialAmount amountMinor={item.remainingRefundCapacityMinor} currency={item.currency} /></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  {#if actionFailure !== null}
    <div class="sales-notice" role="alert" aria-live="assertive">
      <p>{actionFailure.message}</p>
      {#if actionFailure.reloadRequired}
        <!-- Generated only from the resolved refund route and strict cursor. -->
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
        <a href={reloadHref()}>Reload current refund facts</a>
      {/if}
    </div>
  {/if}

  {#if retrySubmission !== null}
    <section class="sales-notice" aria-labelledby="refund-retry-heading">
      <h2 id="refund-retry-heading">Resolve the uncertain submission</h2>
      <p>Editing is paused so this retry keeps the original idempotency identity and values.</p>
      <form method="POST" action={retryActionHref(retrySubmission.action)}>
        <input
          type="hidden"
          name="idempotencyKey"
          value={retrySubmission.idempotencyKey}
        />
        {#if retrySubmission.action === 'saveDraft'}
          <input
            type="hidden"
            name="expectedVersion"
            value={retrySubmission.expectedVersion ?? ''}
          />
          {#each retrySubmission.items as item (item.orderItemId)}
            <input type="hidden" name="orderItemId" value={item.orderItemId} />
            <input
              type="hidden"
              name="totalPresentmentMinor"
              value={item.totalPresentmentMinor}
            />
          {/each}
        {:else}
          <input
            type="hidden"
            name="expectedActiveDraftVersion"
            value={retrySubmission.expectedActiveDraftVersion}
          />
        {/if}
        <button type="submit">Retry this exact request</button>
      </form>
    </section>
  {/if}

  {#if submittedCommand !== undefined}
    <FinancialActionOutcome command={submittedCommand} reloadHref={reloadHref()} />
  {/if}

  {#if retrySubmission === null}
    {#key data.detail}
      <RefundAllocationEditor
        detail={data.detail}
        saveIdempotencyKey={data.saveDraftIdempotencyKey}
        discardIdempotencyKey={data.discardDraftIdempotencyKey}
        reviewCursor={data.reviewCursor}
        {fieldErrors}
      />
    {/key}
  {/if}
</article>
