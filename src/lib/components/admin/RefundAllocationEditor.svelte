<script lang="ts">
  import { untrack } from 'svelte';
  import FinancialAmount from './FinancialAmount.svelte';
  import type { RefundDetailDto } from '$lib/types/financial-reporting';

  interface Props {
    detail: RefundDetailDto;
    saveIdempotencyKey: string;
    discardIdempotencyKey: string;
    reviewCursor: string | null;
    fieldErrors?: Readonly<Record<string, string>>;
  }

  let {
    detail,
    saveIdempotencyKey,
    discardIdempotencyKey,
    reviewCursor,
    fieldErrors = {}
  }: Props = $props();

  const initialAmounts = untrack(() => {
    const draftAmounts = new Map(
      detail.draft?.items.map((item) => [item.orderItemId, item.proposedTotalMinor]) ?? []
    );
    return Object.fromEntries(
      detail.items.map((item) => [item.orderItemId, draftAmounts.get(item.orderItemId) ?? 0])
    );
  });
  let amounts = $state<Record<string, number>>(initialAmounts);
  const totalErrorId = 'refund-allocation-total-error';
  const proposedTotalMinor = $derived(detail.items.reduce(
    (total, item) => total + (Number.isSafeInteger(amounts[item.orderItemId])
      ? amounts[item.orderItemId]!
      : 0),
    0
  ));
  const remainderMinor = $derived(detail.amountMinor - proposedTotalMinor);

  function actionHref(
    action: 'saveDraft' | 'discardDraft' | 'prepareFinalize'
  ): string {
    const marker = `?/${action}`;
    return reviewCursor === null
      ? marker
      : `${marker}&reviewCursor=${encodeURIComponent(reviewCursor)}`;
  }

  function helpId(orderItemId: string): string {
    return `refund-item-${orderItemId}-help`;
  }

  function errorId(orderItemId: string): string {
    return `refund-item-${orderItemId}-error`;
  }
</script>

<section class="refund-allocation-editor" aria-labelledby="refund-allocation-heading">
  <header>
    <h2 id="refund-allocation-heading">Shared allocation draft</h2>
    {#if detail.draft !== null}
      <p class="draft-editor-note">
        Version {detail.draft.version} ·
        {detail.draft.lastEditedBy === 'current_administrator'
          ? 'Edited by you'
          : 'Edited by another administrator'} ·
        Updated <time datetime={detail.draft.updatedAt}>{detail.draft.updatedAt}</time>
      </p>
    {:else}
      <p class="draft-editor-note">No shared draft exists yet.</p>
    {/if}
  </header>

  {#if fieldErrors.form}
    <p class="sales-notice" role="alert">{fieldErrors.form}</p>
  {/if}

  <form method="POST" action={actionHref('saveDraft')}>
    <input type="hidden" name="idempotencyKey" value={saveIdempotencyKey} />
    <input type="hidden" name="expectedVersion" value={detail.draft?.version ?? ''} />

    <div class="refund-editor-items">
      {#each detail.items as item (item.orderItemId)}
        <fieldset class="refund-editor-item">
          <legend>{item.soldAsTitle}</legend>
          <p>{item.soldAsCreatorName} · {item.format}</p>
          <p id={helpId(item.orderItemId)}>
            Available capacity:
            <FinancialAmount
              amountMinor={item.remainingRefundCapacityMinor}
              currency={item.currency}
            />
          </p>
          <input type="hidden" name="orderItemId" value={item.orderItemId} />
          <label for={`refund-item-${item.orderItemId}`}>
            Refund amount in minor units
          </label>
          <input
            id={`refund-item-${item.orderItemId}`}
            name="totalPresentmentMinor"
            type="number"
            inputmode="numeric"
            min="0"
            max={item.remainingRefundCapacityMinor}
            step="1"
            required
            bind:value={amounts[item.orderItemId]}
            aria-invalid={fieldErrors[item.orderItemId] || remainderMinor !== 0
              ? 'true'
              : undefined}
            aria-describedby={`${helpId(item.orderItemId)}${remainderMinor !== 0
              ? ` ${totalErrorId}`
              : ''}${fieldErrors[item.orderItemId]
              ? ` ${errorId(item.orderItemId)}`
              : ''}`}
          />
          {#if fieldErrors[item.orderItemId]}
            <p id={errorId(item.orderItemId)} role="alert">
              {fieldErrors[item.orderItemId]}
            </p>
          {/if}
        </fieldset>
      {/each}
    </div>

    <dl class="refund-editor-totals" aria-live="polite">
      <div>
        <dt>Draft total</dt>
        <dd><FinancialAmount amountMinor={proposedTotalMinor} currency={detail.currency} /></dd>
      </div>
      <div>
        <dt>Remaining to allocate</dt>
        <dd><FinancialAmount amountMinor={remainderMinor} currency={detail.currency} /></dd>
      </div>
    </dl>

    {#if remainderMinor !== 0}
      <p id={totalErrorId} role="alert">
        Draft total must equal the refund total before it can be saved.
      </p>
    {/if}

    <button type="submit">Save shared draft</button>
  </form>

  {#if detail.draft !== null}
    <form method="POST" action={actionHref('discardDraft')}>
      <input type="hidden" name="idempotencyKey" value={discardIdempotencyKey} />
      <input
        type="hidden"
        name="expectedActiveDraftVersion"
        value={detail.draft.version}
      />
      <button type="submit" class="secondary-action">Discard shared draft</button>
    </form>

    <form method="POST" action={actionHref('prepareFinalize')}>
      <input
        type="hidden"
        name="expectedActiveDraftVersion"
        value={detail.draft.version}
      />
      <p>Save any changes first. The preview uses the last saved shared draft.</p>
      <button type="submit">Review finalization consequences</button>
    </form>
  {/if}
</section>

<style>
  .refund-editor-items {
    display: grid;
    gap: 1rem;
  }

  .refund-editor-item {
    min-width: 0;
    border: 1px solid var(--border-color, #bbb);
    border-radius: 0.5rem;
    padding: 1rem;
  }

  .refund-editor-item input[type='number'] {
    display: block;
    width: min(100%, 16rem);
  }

  .refund-editor-totals {
    display: grid;
    gap: 0.5rem;
    margin-block: 1rem;
  }

  .refund-editor-totals div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .secondary-action {
    margin-top: 0.75rem;
  }
</style>
