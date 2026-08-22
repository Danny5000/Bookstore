<script lang="ts">
  import type {
    AdministrativeRecoveryDeactivationPreviewDto,
    AdministrativeRecoveryPreviewDto,
    AdministrativeRecoverySeedDto
  } from '$lib/types/financial-reporting';
  import FinancialActionConfirmation from './FinancialActionConfirmation.svelte';

  interface Props {
    seed: AdministrativeRecoverySeedDto | null | undefined;
    activationPreview: AdministrativeRecoveryPreviewDto | undefined;
    deactivationPreview: AdministrativeRecoveryDeactivationPreviewDto | undefined;
    activationIdempotencyKey: string;
    deactivationIdempotencyKey: string;
    reviewCursor: string | null;
    fieldErrors?: Readonly<Record<string, string>>;
  }

  let {
    seed,
    activationPreview,
    deactivationPreview,
    activationIdempotencyKey,
    deactivationIdempotencyKey,
    reviewCursor,
    fieldErrors = {}
  }: Props = $props();

  type RecoveryAction =
    | 'prepareRecoveryActivation'
    | 'confirmRecoveryActivation'
    | 'prepareRecoveryDeactivation'
    | 'confirmRecoveryDeactivation';

  function actionHref(action: RecoveryAction): string {
    const marker = `?/${action}`;
    return reviewCursor === null
      ? marker
      : `${marker}&reviewCursor=${encodeURIComponent(reviewCursor)}`;
  }

  function accessConsequence(before: boolean, after: boolean): string {
    if (!before && after) {
      return 'Effective access is currently unavailable and will become available.';
    }
    if (before && !after) {
      return 'Effective access is currently available and will become unavailable.';
    }
    if (before) {
      return 'Effective access is currently available and will remain available.';
    }
    return 'Effective access is currently unavailable and will remain unavailable.';
  }

  function emailConsequence(emailQueued: boolean): string {
    return emailQueued
      ? 'An access-change email will be queued.'
      : 'No access-change email will be queued.';
  }

  function activationIneligibleGuidance(
    reason: AdministrativeRecoveryPreviewDto['ineligibleReason']
  ): string {
    switch (reason) {
      case 'not_causally_revoked':
        return 'The purchase grant was not revoked by this refund finalization.';
      case 'still_fully_refunded':
        return 'The item is still fully refunded, so access cannot be restored.';
      case 'unclaimed_purchase':
        return 'The purchase has not been claimed, so administrative recovery cannot be activated.';
      case 'already_in_requested_state':
        return 'A persistent administrative recovery grant is already active.';
      case 'correction_rebase_required':
        return 'Reporting must be rebased before administrative recovery can be activated.';
      default:
        return 'Administrative recovery is not available for the current facts.';
    }
  }
</script>

{#if seed !== null && seed !== undefined}
  <section class="administrative-recovery-actions" aria-labelledby="administrative-recovery-heading">
    <header>
      <h2 id="administrative-recovery-heading">Administrative access recovery</h2>
      <p>
        Recovery changes access only. It does not change refund or reporting amounts.
      </p>
    </header>

    {#if fieldErrors.form}
      <p class="sales-notice" role="alert">{fieldErrors.form}</p>
    {/if}

    {#if activationPreview !== undefined}
      {#if activationPreview.eligible && activationPreview.previewFingerprint !== null}
        <FinancialActionConfirmation
          headingId="administrative-recovery-activation-confirmation-heading"
          heading="Review persistent access activation"
          action={actionHref('confirmRecoveryActivation')}
          submitLabel="Activate persistent access recovery"
          warnings={[
            'This administrative access override persists through future refund, reporting correction, dispute, and classifier rebase processing until it is separately deactivated.',
            'Activation changes access only. It does not change refund or reporting amounts.'
          ]}
          hiddenFields={[
            { name: 'idempotencyKey', value: activationIdempotencyKey },
            { name: 'finalizationEffectId', value: activationPreview.finalizationEffectId },
            { name: 'orderItemId', value: activationPreview.orderItemId },
            {
              name: 'expectedCorrectionSetId',
              value: activationPreview.expectedCorrectionSetId
            },
            {
              name: 'expectedCorrectionVersion',
              value: activationPreview.expectedCorrectionVersion
            },
            {
              name: 'expectedSourceFingerprint',
              value: activationPreview.expectedSourceFingerprint
            },
            { name: 'previewFingerprint', value: activationPreview.previewFingerprint },
            { name: 'confirmation', value: 'activate_persistent_recovery' }
          ]}
        >
          <dl class="recovery-consequences">
            <div><dt>Title</dt><dd>{activationPreview.soldAsTitle}</dd></div>
            <div>
              <dt>Access consequence</dt>
              <dd>
                {accessConsequence(
                  activationPreview.effectiveAccessBefore,
                  activationPreview.effectiveAccessAfter
                )}
              </dd>
            </div>
            <div>
              <dt>Email consequence</dt>
              <dd>{emailConsequence(activationPreview.emailQueued)}</dd>
            </div>
          </dl>
        </FinancialActionConfirmation>
      {:else}
        <div class="sales-notice" role="status">
          <p><strong>{activationPreview.soldAsTitle}</strong></p>
          <p>{activationIneligibleGuidance(activationPreview.ineligibleReason)}</p>
          <p>
            {accessConsequence(
              activationPreview.effectiveAccessBefore,
              activationPreview.effectiveAccessAfter
            )}
          </p>
          <p>{emailConsequence(activationPreview.emailQueued)}</p>
        </div>
      {/if}
    {:else if deactivationPreview !== undefined}
      {#if deactivationPreview.eligible}
        <FinancialActionConfirmation
          headingId="administrative-recovery-deactivation-confirmation-heading"
          heading="Review persistent access deactivation"
          action={actionHref('confirmRecoveryDeactivation')}
          submitLabel="Deactivate persistent access recovery"
          warnings={[
            'Deactivation ends this persistent administrative override. It does not change refund or reporting amounts.',
            'Access is restored later only through a separately eligible grant.'
          ]}
          hiddenFields={[
            { name: 'idempotencyKey', value: deactivationIdempotencyKey },
            { name: 'recoveryGrantId', value: deactivationPreview.recoveryGrantId },
            { name: 'recoveryReferenceId', value: deactivationPreview.recoveryReferenceId },
            { name: 'expectedStateChangedAt', value: deactivationPreview.expectedStateChangedAt },
            { name: 'confirmation', value: 'deactivate_persistent_recovery' }
          ]}
        >
          <dl class="recovery-consequences">
            <div><dt>Title</dt><dd>{deactivationPreview.soldAsTitle}</dd></div>
            <div>
              <dt>Access consequence</dt>
              <dd>
                {accessConsequence(
                  deactivationPreview.effectiveAccessBefore,
                  deactivationPreview.effectiveAccessAfter
                )}
              </dd>
            </div>
            <div>
              <dt>Email consequence</dt>
              <dd>{emailConsequence(deactivationPreview.emailQueued)}</dd>
            </div>
          </dl>
        </FinancialActionConfirmation>
      {:else}
        <div class="sales-notice" role="status">
          <p><strong>{deactivationPreview.soldAsTitle}</strong></p>
          <p>This administrative recovery grant is already inactive.</p>
          <p>
            {accessConsequence(
              deactivationPreview.effectiveAccessBefore,
              deactivationPreview.effectiveAccessAfter
            )}
          </p>
          <p>{emailConsequence(deactivationPreview.emailQueued)}</p>
        </div>
      {/if}
    {:else}
      <div class="recovery-action-groups">
        <section aria-labelledby="administrative-recovery-activation-heading">
          <h3 id="administrative-recovery-activation-heading">Persistent access activation</h3>
          <p>
            This administrative override persists until a separate deactivation, including
            through later refund, reporting correction, dispute, and classifier rebase processing.
          </p>
          {#if seed.activationCandidates.length === 0}
            <p class="sales-notice" role="status">
              No causally eligible activation is available for this refund.
            </p>
          {:else}
            <div class="recovery-candidates">
              {#each seed.activationCandidates as candidate (candidate.finalizationEffectId)}
                <form method="POST" action={actionHref('prepareRecoveryActivation')}>
                  <input
                    type="hidden"
                    name="finalizationEffectId"
                    value={candidate.finalizationEffectId}
                  />
                  <input type="hidden" name="orderItemId" value={candidate.orderItemId} />
                  <input
                    type="hidden"
                    name="expectedCorrectionSetId"
                    value={candidate.expectedCorrectionSetId}
                  />
                  <input
                    type="hidden"
                    name="expectedCorrectionVersion"
                    value={candidate.expectedCorrectionVersion}
                  />
                  <input
                    type="hidden"
                    name="expectedSourceFingerprint"
                    value={candidate.expectedSourceFingerprint}
                  />
                  <p><strong>{candidate.soldAsTitle}</strong></p>
                  <button
                    type="submit"
                    aria-label={`Review persistent access activation for ${candidate.soldAsTitle}`}
                  >Review persistent access activation</button>
                </form>
              {/each}
            </div>
          {/if}
        </section>

        <section aria-labelledby="administrative-recovery-deactivation-heading">
          <h3 id="administrative-recovery-deactivation-heading">Persistent access deactivation</h3>
          {#if seed.deactivationCandidates.length === 0}
            <p class="sales-notice" role="status">
              No active administrative recovery grant is linked to this refund.
            </p>
          {:else}
            <div class="recovery-candidates">
              {#each seed.deactivationCandidates as candidate (candidate.recoveryGrantId)}
                <form method="POST" action={actionHref('prepareRecoveryDeactivation')}>
                  <input
                    type="hidden"
                    name="recoveryGrantId"
                    value={candidate.recoveryGrantId}
                  />
                  <input
                    type="hidden"
                    name="recoveryReferenceId"
                    value={candidate.recoveryReferenceId}
                  />
                  <input
                    type="hidden"
                    name="expectedStateChangedAt"
                    value={candidate.expectedStateChangedAt}
                  />
                  <p><strong>{candidate.soldAsTitle}</strong></p>
                  <button
                    type="submit"
                    aria-label={`Review persistent access deactivation for ${candidate.soldAsTitle}`}
                  >Review persistent access deactivation</button>
                </form>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {/if}
  </section>
{/if}

<style>
  .administrative-recovery-actions,
  .recovery-action-groups,
  .recovery-candidates,
  .recovery-consequences {
    display: grid;
    gap: 1rem;
  }

  .administrative-recovery-actions {
    margin-top: 1.5rem;
  }

  .administrative-recovery-actions header p,
  .recovery-action-groups p,
  .recovery-candidates p,
  .recovery-consequences {
    margin: 0;
  }

  .recovery-action-groups {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
  }

  .recovery-action-groups > section,
  .recovery-candidates form {
    display: grid;
    gap: 0.75rem;
    align-content: start;
  }

  .recovery-candidates form {
    border: 1px solid var(--border-color, #bbb);
    border-radius: 0.5rem;
    padding: 1rem;
  }

  .recovery-consequences div {
    display: grid;
    gap: 0.25rem;
  }

  .recovery-consequences dt {
    font-weight: 700;
  }
</style>
