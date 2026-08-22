<script lang="ts">
  import { resolve } from '$app/paths';
  import FinancialAmount from '$lib/components/admin/FinancialAmount.svelte';
  import FinancialActionConfirmation from '$lib/components/admin/FinancialActionConfirmation.svelte';
  import FinancialActionOutcome from '$lib/components/admin/FinancialActionOutcome.svelte';
  import RefundAllocationEditor from '$lib/components/admin/RefundAllocationEditor.svelte';
  import type {
    FinancialAdminCommandReferenceDto,
    RefundFinalizationPreviewDto
  } from '$lib/types/financial-reporting';
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
      }
    | {
        readonly action: 'confirmFinalize';
        readonly idempotencyKey: string;
        readonly expectedActiveDraftVersion: number;
        readonly previewFingerprint: string;
        readonly confirmation: 'finalize_refund_allocation';
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

  function actionFailurePresentation(
    code: unknown,
    exactRetryAvailable: boolean
  ): ActionFailurePresentation | null {
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
        return exactRetryAvailable
          ? {
              message: 'We could not confirm whether the refund request was submitted. Retry the exact request below before editing again.',
              reloadRequired: false
            }
          : {
              message: 'The refund action could not be completed. Review the current facts and try again.',
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
  const retrySubmission = $derived(
    form && 'retrySubmission' in form
      ? form.retrySubmission as RetrySubmission | null
      : null
  );
  const finalizationPreview = $derived(
    form && 'finalizationPreview' in form
      ? form.finalizationPreview as RefundFinalizationPreviewDto | undefined
      : undefined
  );
  const actionFailure = $derived(actionFailurePresentation(
    form && 'code' in form ? form.code : undefined,
    retrySubmission !== null
  ));

  function purchaseGrantConsequence(
    item: RefundFinalizationPreviewDto['items'][number]
  ): string {
    return item.purchaseGrantWouldBeRevoked
      ? 'Purchase access grant will be revoked.'
      : 'Purchase access grant will remain unchanged.';
  }

  function effectiveAccessConsequence(
    item: RefundFinalizationPreviewDto['items'][number]
  ): string {
    return item.effectiveAccessWouldChange
      ? 'Effective access will change.'
      : 'Effective access will remain unchanged.';
  }

  function emailConsequence(
    item: RefundFinalizationPreviewDto['items'][number]
  ): string {
    return item.emailQueued
      ? 'An access-change email will be queued.'
      : 'No access-change email will be queued.';
  }
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
        {:else if retrySubmission.action === 'discardDraft'}
          <input
            type="hidden"
            name="expectedActiveDraftVersion"
            value={retrySubmission.expectedActiveDraftVersion}
          />
        {:else}
          <input
            type="hidden"
            name="expectedActiveDraftVersion"
            value={retrySubmission.expectedActiveDraftVersion}
          />
          <input
            type="hidden"
            name="previewFingerprint"
            value={retrySubmission.previewFingerprint}
          />
          <input
            type="hidden"
            name="confirmation"
            value={retrySubmission.confirmation}
          />
        {/if}
        <button type="submit">Retry this exact request</button>
      </form>
    </section>
  {/if}

  {#if submittedCommand !== undefined}
    <FinancialActionOutcome command={submittedCommand} reloadHref={reloadHref()} />
  {/if}

  {#if retrySubmission === null && finalizationPreview !== undefined}
    <FinancialActionConfirmation
      headingId="refund-finalization-confirmation-heading"
      heading="Review finalization consequences"
      action={retryActionHref('confirmFinalize')}
      submitLabel="Finalize this refund allocation"
      warnings={[
        'Finalizing makes this allocation immutable.',
        'Finalization may revoke purchase access.',
        'A later reporting correction does not automatically restore access.'
      ]}
      hiddenFields={[
        { name: 'idempotencyKey', value: data.finalizeIdempotencyKey },
        {
          name: 'expectedActiveDraftVersion',
          value: finalizationPreview.expectedActiveDraftVersion
        },
        { name: 'previewFingerprint', value: finalizationPreview.previewFingerprint },
        { name: 'confirmation', value: 'finalize_refund_allocation' }
      ]}
    >
      <dl class="refund-finalization-totals">
        <div>
          <dt>Proposed allocation total</dt>
          <dd>
            <FinancialAmount
              amountMinor={finalizationPreview.proposedTotalMinor}
              currency={finalizationPreview.currency}
            />
          </dd>
        </div>
        <div>
          <dt>Remaining to allocate</dt>
          <dd>
            <FinancialAmount
              amountMinor={finalizationPreview.remainderMinor}
              currency={finalizationPreview.currency}
            />
          </dd>
        </div>
      </dl>

      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="sales-table-region"
        role="region"
        aria-label="Finalization item consequences"
        tabindex="0"
      >
        <table>
          <caption>Proposed allocation and access consequences</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Proposed subtotal</th>
              <th scope="col">Proposed tax</th>
              <th scope="col">Proposed total</th>
              <th scope="col">Access and email</th>
            </tr>
          </thead>
          <tbody>
            {#each finalizationPreview.items as item (item.orderItemId)}
              <tr>
                <th scope="row">{item.soldAsTitle}</th>
                <td>
                  <FinancialAmount
                    amountMinor={item.proposedSubtotalMinor}
                    currency={finalizationPreview.currency}
                  />
                </td>
                <td>
                  <FinancialAmount
                    amountMinor={item.proposedTaxMinor}
                    currency={finalizationPreview.currency}
                  />
                </td>
                <td>
                  <FinancialAmount
                    amountMinor={item.proposedTotalMinor}
                    currency={finalizationPreview.currency}
                  />
                </td>
                <td>
                  <ul class="refund-consequences">
                    <li>
                      {item.wouldBeFullyRefunded
                        ? 'The item will be fully refunded.'
                        : 'The item will remain partially refunded.'}
                    </li>
                    <li>{purchaseGrantConsequence(item)}</li>
                    {#if item.otherActiveGrantPreservesAccess}
                      <li>Another active grant preserves access.</li>
                    {/if}
                    <li>{effectiveAccessConsequence(item)}</li>
                    <li>{emailConsequence(item)}</li>
                  </ul>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </FinancialActionConfirmation>
  {/if}

  {#if retrySubmission === null && finalizationPreview === undefined}
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

<style>
  .refund-finalization-totals {
    display: grid;
    gap: 0.5rem;
    margin: 0;
  }

  .refund-finalization-totals div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .refund-consequences {
    margin: 0;
    padding-inline-start: 1.25rem;
  }
</style>
