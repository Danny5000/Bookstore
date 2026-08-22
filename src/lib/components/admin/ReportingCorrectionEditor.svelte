<script lang="ts">
  import { untrack } from 'svelte';
  import type {
    RefundReportingCorrectionPreviewDto,
    RefundReportingCorrectionSeedDto
  } from '$lib/types/financial-reporting';
  import FinancialActionConfirmation from './FinancialActionConfirmation.svelte';
  import FinancialAmount from './FinancialAmount.svelte';

  interface Props {
    seed: RefundReportingCorrectionSeedDto | null;
    preview: RefundReportingCorrectionPreviewDto | undefined;
    confirmIdempotencyKey: string;
    reviewCursor: string | null;
    fieldErrors?: Readonly<Record<string, string>>;
  }

  let {
    seed,
    preview,
    confirmIdempotencyKey,
    reviewCursor,
    fieldErrors = {}
  }: Props = $props();

  const initialAmounts = untrack(() => Object.fromEntries(
    (seed?.items ?? []).map((item) => [item.orderItemId, item.baselineTotalMinor])
  ));
  let amounts = $state<Record<string, number>>(initialAmounts);
  const firstInvalidItemId = $derived(
    seed?.items.find((item) => fieldErrors[item.orderItemId] !== undefined)?.orderItemId ?? null
  );

  function actionHref(action: 'prepareCorrection' | 'confirmCorrection'): string {
    const marker = `?/${action}`;
    return reviewCursor === null
      ? marker
      : `${marker}&reviewCursor=${encodeURIComponent(reviewCursor)}`;
  }

  function baselineLabel(kind: 'immutable_base' | 'compatible_correction' | null): string {
    if (kind === 'immutable_base') return 'Immutable base';
    if (kind === 'compatible_correction') return 'Compatible correction';
    return 'Unavailable';
  }

  function completenessLabel(complete: boolean): string {
    return complete ? 'Complete' : 'Incomplete';
  }

  function ineligibleGuidance(reason: string | null): string {
    switch (reason) {
      case 'provider_evidence_pending':
        return 'Provider evidence is still pending.';
      case 'immutable_conflict':
        return 'The immutable reporting evidence is inconsistent.';
      case 'not_finalized':
        return 'Finalize this refund allocation before correcting reporting.';
      case 'no_change':
        return 'The proposed attribution already matches complete reporting.';
      default:
        return 'Reporting correction is not available for the current facts.';
    }
  }

  function helpId(orderItemId: string): string {
    return `reporting-correction-${orderItemId}-help`;
  }

  function errorId(orderItemId: string): string {
    return `reporting-correction-${orderItemId}-error`;
  }
</script>

{#if seed !== null}
  <section class="reporting-correction-editor" aria-labelledby="reporting-correction-heading">
    <header>
      <h2 id="reporting-correction-heading">Reporting attribution correction</h2>
      <p><strong>Reporting only — this does not restore or revoke access.</strong></p>
    </header>

    {#if preview !== undefined}
      <div class="reporting-state" aria-live="polite">
        <p><strong>Baseline:</strong> {baselineLabel(preview.baselineKind)}</p>
        <p><strong>Current reporting:</strong> {completenessLabel(preview.currentReportingComplete)}</p>
        <p><strong>Proposed reporting:</strong> {completenessLabel(preview.proposedReportingComplete)}</p>
        {#if preview.compatibilityRepair}
          <p><strong>Raw-history compatibility repair</strong></p>
          <p>This appends a compatible successor; it does not rewrite correction history.</p>
        {/if}
      </div>

      {#if preview.eligible && preview.previewFingerprint !== null}
        <FinancialActionConfirmation
          headingId="reporting-correction-confirmation-heading"
          heading="Review reporting correction"
          action={actionHref('confirmCorrection')}
          submitLabel="Append this reporting correction"
          warnings={preview.compatibilityRepair
            ? [
                'Reporting only — this does not restore or revoke access.',
                'This appends a compatible successor; it does not rewrite correction history.'
              ]
            : [
                'Reporting only — this does not restore or revoke access.',
                'This appends reporting history; it does not rewrite prior corrections.'
              ]}
          hiddenFields={[
            { name: 'idempotencyKey', value: confirmIdempotencyKey },
            { name: 'reason', value: 'allocation_attribution_correction' },
            {
              name: 'expectedNextCorrectionVersion',
              value: preview.expectedNextCorrectionVersion
            },
            {
              name: 'expectedBaseAllocationSetId',
              value: preview.expectedBaseAllocationSetId
            },
            {
              name: 'expectedSourceFingerprint',
              value: preview.expectedSourceFingerprint
            },
            ...preview.items.flatMap((item) => [
              { name: 'orderItemId', value: item.orderItemId },
              { name: 'totalPresentmentMinor', value: item.proposedTotalMinor }
            ]),
            { name: 'previewFingerprint', value: preview.previewFingerprint },
            { name: 'confirmation', value: 'create_reporting_correction' }
          ]}
        >
          <dl class="correction-totals">
            <div>
              <dt>Baseline total</dt>
              <dd>
                <FinancialAmount
                  amountMinor={preview.baselineTotalMinor}
                  currency={preview.currency}
                />
              </dd>
            </div>
            <div>
              <dt>Proposed total</dt>
              <dd>
                <FinancialAmount
                  amountMinor={preview.proposedTotalMinor}
                  currency={preview.currency}
                />
              </dd>
            </div>
          </dl>

          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div
            class="correction-table-region"
            role="region"
            aria-label="Reporting correction attribution comparison"
            tabindex="0"
          >
            <table>
              <caption>Baseline, proposed attribution, and reporting display changes</caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Baseline subtotal</th>
                  <th scope="col">Proposed subtotal</th>
                  <th scope="col">Subtotal change</th>
                  <th scope="col">Baseline tax</th>
                  <th scope="col">Proposed tax</th>
                  <th scope="col">Tax change</th>
                  <th scope="col">Baseline settlement gross</th>
                  <th scope="col">Proposed settlement gross</th>
                  <th scope="col">Settlement gross change</th>
                  <th scope="col">Baseline refund fee impact</th>
                  <th scope="col">Proposed refund fee impact</th>
                  <th scope="col">Refund fee impact change</th>
                </tr>
              </thead>
              <tbody>
                {#each preview.items as item (item.orderItemId)}
                  <tr>
                    <th scope="row">{item.soldAsTitle}</th>
                    <td><FinancialAmount amountMinor={item.baselineSubtotalMinor} currency={preview.currency} /></td>
                    <td><FinancialAmount amountMinor={item.proposedSubtotalMinor} currency={preview.currency} /></td>
                    <td><FinancialAmount amountMinor={item.subtotalDisplayDeltaMinor} currency={preview.currency} /></td>
                    <td><FinancialAmount amountMinor={item.baselineTaxMinor} currency={preview.currency} /></td>
                    <td><FinancialAmount amountMinor={item.proposedTaxMinor} currency={preview.currency} /></td>
                    <td><FinancialAmount amountMinor={item.taxDisplayDeltaMinor} currency={preview.currency} /></td>
                    <td><FinancialAmount amountMinor={item.baselineSettlementGrossMinor} currency={preview.settlementCurrency} /></td>
                    <td><FinancialAmount amountMinor={item.proposedSettlementGrossMinor} currency={preview.settlementCurrency} /></td>
                    <td><FinancialAmount amountMinor={item.settlementGrossDisplayDeltaMinor} currency={preview.settlementCurrency} /></td>
                    <td><FinancialAmount amountMinor={item.baselineRefundFeeImpactMinor} currency={preview.settlementCurrency} /></td>
                    <td><FinancialAmount amountMinor={item.proposedRefundFeeImpactMinor} currency={preview.settlementCurrency} /></td>
                    <td><FinancialAmount amountMinor={item.refundFeeImpactDisplayDeltaMinor} currency={preview.settlementCurrency} /></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </FinancialActionConfirmation>
      {:else}
        <p class="sales-notice" role="status">{ineligibleGuidance(preview.ineligibleReason)}</p>
      {/if}
    {:else}
      <div class="reporting-state">
        <p><strong>Baseline:</strong> {baselineLabel(seed.baselineKind)}</p>
        <p><strong>Current reporting:</strong> {completenessLabel(seed.currentReportingComplete)}</p>
        {#if seed.rawPredecessorCorrectionSetId !== null && seed.compatibleCorrectionSetId === null}
          <p><strong>Raw-history state:</strong> A compatible successor is required.</p>
        {/if}
      </div>

      {#if fieldErrors.form}
        <p class="sales-notice" role="alert">{fieldErrors.form}</p>
      {/if}

      {#if seed.eligible &&
        seed.expectedNextCorrectionVersion !== null &&
        seed.expectedBaseAllocationSetId !== null &&
        seed.expectedSourceFingerprint !== null &&
        seed.currency !== null}
        <form method="POST" action={actionHref('prepareCorrection')}>
          <input type="hidden" name="reason" value="allocation_attribution_correction" />
          <input
            type="hidden"
            name="expectedNextCorrectionVersion"
            value={seed.expectedNextCorrectionVersion}
          />
          <input
            type="hidden"
            name="expectedBaseAllocationSetId"
            value={seed.expectedBaseAllocationSetId}
          />
          <input
            type="hidden"
            name="expectedSourceFingerprint"
            value={seed.expectedSourceFingerprint}
          />

          <div class="correction-inputs">
            {#each seed.items as item (item.orderItemId)}
              <fieldset>
                <legend>{item.soldAsTitle}</legend>
                <p id={helpId(item.orderItemId)}>
                  Baseline attribution:
                  <FinancialAmount amountMinor={item.baselineTotalMinor} currency={seed.currency} />
                </p>
                <input type="hidden" name="orderItemId" value={item.orderItemId} />
                <label for={`reporting-correction-${item.orderItemId}`}>
                  Proposed attribution in minor units
                </label>
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  id={`reporting-correction-${item.orderItemId}`}
                  name="totalPresentmentMinor"
                  type="number"
                  inputmode="numeric"
                  min="0"
                  max="99999999"
                  step="1"
                  required
                  autofocus={item.orderItemId === firstInvalidItemId}
                  bind:value={amounts[item.orderItemId]}
                  aria-invalid={fieldErrors[item.orderItemId] ? 'true' : undefined}
                  aria-describedby={`${helpId(item.orderItemId)}${fieldErrors[item.orderItemId]
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

          <button type="submit">Review reporting correction</button>
        </form>
      {:else}
        <p class="sales-notice" role="status">{ineligibleGuidance(seed.ineligibleReason)}</p>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .reporting-correction-editor {
    display: grid;
    gap: 1rem;
    margin-top: 1.5rem;
  }

  .reporting-state,
  .correction-totals {
    display: grid;
    gap: 0.5rem;
    margin: 0;
  }

  .reporting-state p {
    margin: 0;
  }

  .correction-totals div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .correction-inputs {
    display: grid;
    gap: 1rem;
    margin-block: 1rem;
  }

  .correction-inputs fieldset {
    min-width: 0;
    border: 1px solid var(--border-color, #bbb);
    border-radius: 0.5rem;
    padding: 1rem;
  }

  .correction-inputs input[type='number'] {
    display: block;
    width: min(100%, 16rem);
  }

  .correction-table-region {
    max-width: 100%;
    overflow-x: auto;
  }

  .correction-table-region table {
    min-width: 88rem;
  }
</style>
