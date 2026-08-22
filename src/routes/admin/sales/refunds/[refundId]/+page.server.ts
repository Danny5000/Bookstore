import { randomUUID } from 'node:crypto';
import { error, fail } from '@sveltejs/kit';
import {
  requireCapability,
  type Actor,
  type AdministratorActor
} from '$lib/server/auth/admin-policy';
import { submitFinancialAdminCommand } from '$lib/server/commerce/financial/admin-commands/repository';
import { FinancialAdminConflictError } from '$lib/server/commerce/financial/admin-commands/handler';
import {
  parseRefundDraftDiscardRequest,
  parseRefundDraftSaveRequest,
  parseAdministrativeRecoveryActivateConfirmRequest,
  parseAdministrativeRecoveryActivatePrepareRequest,
  parseAdministrativeRecoveryDeactivateConfirmRequest,
  parseAdministrativeRecoveryDeactivatePrepareRequest,
  parseRefundFinalizationConfirmRequest,
  parseRefundFinalizationPrepareRequest,
  parseRefundReportingCorrectionConfirmRequest,
  parseRefundReportingCorrectionPrepareRequest,
  parseRefundReviewReturnContext,
  RefundReviewInputError
} from '$lib/server/commerce/financial/refund-review/inputs';
import { previewRefundFinalization } from '$lib/server/commerce/financial/refund-review/finalize';
import {
  getReportingCorrectionSeed,
  previewReportingCorrection
} from '$lib/server/commerce/financial/refund-review/corrections';
import {
  getAdministrativeRecoverySeed,
  previewAdministrativeRecovery,
  previewAdministrativeRecoveryDeactivation
} from '$lib/server/commerce/financial/refund-review/recovery';
import { getRefundReviewDetail } from '$lib/server/commerce/financial/refund-review/query';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { assertSameOrigin } from '$lib/server/http/strict-json';
import {
  createFinancialRequestContext,
  financialActionFailure,
  FinancialRouteError,
  FinancialRouteInputError,
  requireFinancialRouteUuid
} from '../../route-support';
import type { Actions, PageServerLoad } from './$types';

function requireRefundManagement(actor: Actor): AdministratorActor {
  requireCapability(actor, 'sales.read');
  requireCapability(actor, 'reconciliation.manage');
  return actor;
}

function failLoadSafely(cause: unknown): never {
  const failure = financialActionFailure(cause);
  error(failure.status, failure.code);
}

type RefundAction =
  | 'saveDraft'
  | 'discardDraft'
  | 'prepareFinalize'
  | 'confirmFinalize'
  | 'prepareCorrection'
  | 'confirmCorrection'
  | 'prepareRecoveryActivation'
  | 'confirmRecoveryActivation'
  | 'prepareRecoveryDeactivation'
  | 'confirmRecoveryDeactivation';

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
    }
  | {
      readonly action: 'confirmCorrection';
      readonly idempotencyKey: string;
      readonly reason: 'allocation_attribution_correction';
      readonly expectedNextCorrectionVersion: number;
      readonly expectedBaseAllocationSetId: string;
      readonly expectedSourceFingerprint: string;
      readonly items: readonly {
        readonly orderItemId: string;
        readonly totalPresentmentMinor: number;
      }[];
      readonly previewFingerprint: string;
      readonly confirmation: 'create_reporting_correction';
    }
  | {
      readonly action: 'confirmRecoveryActivation';
      readonly idempotencyKey: string;
      readonly finalizationEffectId: string;
      readonly orderItemId: string;
      readonly expectedCorrectionSetId: string;
      readonly expectedCorrectionVersion: number;
      readonly expectedSourceFingerprint: string;
      readonly previewFingerprint: string;
      readonly confirmation: 'activate_persistent_recovery';
    }
  | {
      readonly action: 'confirmRecoveryDeactivation';
      readonly idempotencyKey: string;
      readonly recoveryGrantId: string;
      readonly recoveryReferenceId: string;
      readonly expectedStateChangedAt: string;
      readonly confirmation: 'deactivate_persistent_recovery';
    };

function actionReturnContext(url: URL, action: RefundAction) {
  const normalized = new URL(url);
  const marker = `/${action}`;
  const markerValues = normalized.searchParams.getAll(marker);
  if (
    markerValues.length > 1 ||
    (markerValues.length === 1 && markerValues[0] !== '')
  ) {
    throw new FinancialRouteInputError();
  }
  normalized.searchParams.delete(marker);
  return parseRefundReviewReturnContext(normalized);
}

export const load: PageServerLoad = async (event) => {
  try {
    const actor = requireRefundManagement(event.locals.actor);
    const refundId = requireFinancialRouteUuid(event.params.refundId);
    const returnContext = parseRefundReviewReturnContext(event.url);
    const context = createFinancialRequestContext(event.request, event.route.id);
    const database = getDatabaseClient().db;
    const detail = await getRefundReviewDetail(
      database,
      actor,
      refundId,
      context
    );
    if (detail === null) throw new FinancialRouteError('not_found');
    const reportingCorrectionSeed = await getReportingCorrectionSeed(
      database,
      actor,
      refundId,
      context
    );
    const administrativeRecoverySeed = await getAdministrativeRecoverySeed(
      database,
      actor,
      refundId,
      context
    );
    return {
      detail,
      reportingCorrectionSeed,
      administrativeRecoverySeed,
      reviewCursor: returnContext.reviewCursor,
      saveDraftIdempotencyKey: randomUUID(),
      discardDraftIdempotencyKey: randomUUID(),
      finalizeIdempotencyKey: randomUUID(),
      correctionIdempotencyKey: randomUUID(),
      recoveryActivationIdempotencyKey: randomUUID(),
      recoveryDeactivationIdempotencyKey: randomUUID()
    };
  } catch (cause: unknown) {
    failLoadSafely(cause);
  }
};

async function submitDraft(
  event: Parameters<Actions['saveDraft']>[0],
  action: 'saveDraft' | 'discardDraft'
) {
  let retrySubmission: RetrySubmission | null = null;
  try {
    const actor = requireRefundManagement(event.locals.actor);
    assertSameOrigin(event.request);
    const refundId = requireFinancialRouteUuid(event.params.refundId);
    const returnContext = actionReturnContext(event.url, action);
    const submission = action === 'saveDraft'
      ? await parseRefundDraftSaveRequest(event.request, refundId)
      : await parseRefundDraftDiscardRequest(event.request, refundId);
    retrySubmission = submission.command.kind === 'refund_draft_save'
      ? {
          action: 'saveDraft',
          idempotencyKey: submission.idempotencyKey,
          expectedVersion: submission.command.expectedVersion,
          items: submission.command.items
        }
      : {
          action: 'discardDraft',
          idempotencyKey: submission.idempotencyKey,
          expectedActiveDraftVersion: submission.command.expectedActiveDraftVersion
        };
    const command = await submitFinancialAdminCommand(getDatabaseClient().db, {
      actor,
      idempotencyKey: submission.idempotencyKey,
      command: submission.command,
      context: createFinancialRequestContext(event.request, event.route.id)
    });
    return { command, reviewCursor: returnContext.reviewCursor };
  } catch (cause: unknown) {
    const failure = financialActionFailure(cause);
    const itemField = cause instanceof RefundReviewInputError
      ? cause.fieldKey
      : null;
    return fail(failure.status, {
      code: failure.code,
      fieldErrors: failure.code === 'invalid_request'
        ? itemField === null
          ? { form: 'Check each refund amount and try again.' }
          : {
              form: 'Check the highlighted refund amount and try again.',
              [itemField]: 'Enter a whole amount from 0 through 99,999,999.'
            }
        : {},
      retrySubmission: failure.code === 'temporarily_unavailable'
        ? retrySubmission
        : null
    });
  }
}

async function prepareFinalization(
  event: Parameters<Actions['saveDraft']>[0]
) {
  try {
    const actor = requireRefundManagement(event.locals.actor);
    assertSameOrigin(event.request);
    const refundId = requireFinancialRouteUuid(event.params.refundId);
    const returnContext = actionReturnContext(event.url, 'prepareFinalize');
    const input = await parseRefundFinalizationPrepareRequest(event.request, refundId);
    const finalizationPreview = await previewRefundFinalization(
      getDatabaseClient().db,
      actor,
      input,
      createFinancialRequestContext(event.request, event.route.id)
    );
    return { finalizationPreview, reviewCursor: returnContext.reviewCursor };
  } catch (cause: unknown) {
    const failure = financialActionFailure(
      cause instanceof FinancialAdminConflictError
        ? new FinancialRouteError('stale_state')
        : cause
    );
    return fail(failure.status, {
      code: failure.code,
      fieldErrors: failure.code === 'invalid_request'
        ? { form: 'Reload current refund facts and prepare finalization again.' }
        : {},
      retrySubmission: null
    });
  }
}

async function confirmFinalization(
  event: Parameters<Actions['saveDraft']>[0]
) {
  let retrySubmission: Extract<RetrySubmission, { action: 'confirmFinalize' }> | null = null;
  try {
    const actor = requireRefundManagement(event.locals.actor);
    assertSameOrigin(event.request);
    const refundId = requireFinancialRouteUuid(event.params.refundId);
    const returnContext = actionReturnContext(event.url, 'confirmFinalize');
    const submission = await parseRefundFinalizationConfirmRequest(event.request, refundId);
    retrySubmission = {
      action: 'confirmFinalize',
      idempotencyKey: submission.idempotencyKey,
      expectedActiveDraftVersion: submission.command.expectedActiveDraftVersion,
      previewFingerprint: submission.command.previewFingerprint,
      confirmation: submission.command.confirmation
    };
    const command = await submitFinancialAdminCommand(getDatabaseClient().db, {
      actor,
      idempotencyKey: submission.idempotencyKey,
      command: submission.command,
      context: createFinancialRequestContext(event.request, event.route.id)
    });
    return { command, reviewCursor: returnContext.reviewCursor };
  } catch (cause: unknown) {
    const failure = financialActionFailure(cause);
    return fail(failure.status, {
      code: failure.code,
      fieldErrors: failure.code === 'invalid_request'
        ? { form: 'Reload current refund facts and prepare finalization again.' }
        : {},
      retrySubmission: failure.code === 'temporarily_unavailable'
        ? retrySubmission
        : null
    });
  }
}

async function prepareCorrection(
  event: Parameters<Actions['saveDraft']>[0]
) {
  try {
    const actor = requireRefundManagement(event.locals.actor);
    assertSameOrigin(event.request);
    const refundId = requireFinancialRouteUuid(event.params.refundId);
    const returnContext = actionReturnContext(event.url, 'prepareCorrection');
    const input = await parseRefundReportingCorrectionPrepareRequest(
      event.request,
      refundId
    );
    const reportingCorrectionPreview = await previewReportingCorrection(
      getDatabaseClient().db,
      actor,
      input,
      createFinancialRequestContext(event.request, event.route.id)
    );
    return {
      reportingCorrectionPreview,
      reviewCursor: returnContext.reviewCursor
    };
  } catch (cause: unknown) {
    const failure = financialActionFailure(
      cause instanceof FinancialAdminConflictError
        ? new FinancialRouteError('stale_state')
        : cause
    );
    const itemField = cause instanceof RefundReviewInputError
      ? cause.fieldKey
      : null;
    return fail(failure.status, {
      code: failure.code,
      fieldErrors: failure.code === 'invalid_request'
        ? itemField === null
          ? { form: 'Check each reporting attribution and prepare again.' }
          : {
              form: 'Check the highlighted reporting attribution and prepare again.',
              [itemField]: 'Enter a whole amount from 0 through 99,999,999.'
            }
        : {},
      retrySubmission: null
    });
  }
}

async function confirmCorrection(
  event: Parameters<Actions['saveDraft']>[0]
) {
  let retrySubmission: Extract<RetrySubmission, { action: 'confirmCorrection' }> | null = null;
  try {
    const actor = requireRefundManagement(event.locals.actor);
    assertSameOrigin(event.request);
    const refundId = requireFinancialRouteUuid(event.params.refundId);
    const returnContext = actionReturnContext(event.url, 'confirmCorrection');
    const submission = await parseRefundReportingCorrectionConfirmRequest(
      event.request,
      refundId
    );
    retrySubmission = {
      action: 'confirmCorrection',
      idempotencyKey: submission.idempotencyKey,
      reason: submission.command.reason,
      expectedNextCorrectionVersion: submission.command.expectedNextCorrectionVersion,
      expectedBaseAllocationSetId: submission.command.expectedBaseAllocationSetId,
      expectedSourceFingerprint: submission.command.expectedSourceFingerprint,
      items: submission.command.items,
      previewFingerprint: submission.command.previewFingerprint,
      confirmation: submission.command.confirmation
    };
    const command = await submitFinancialAdminCommand(getDatabaseClient().db, {
      actor,
      idempotencyKey: submission.idempotencyKey,
      command: submission.command,
      context: createFinancialRequestContext(event.request, event.route.id)
    });
    return { command, reviewCursor: returnContext.reviewCursor };
  } catch (cause: unknown) {
    const failure = financialActionFailure(cause);
    const itemField = cause instanceof RefundReviewInputError
      ? cause.fieldKey
      : null;
    return fail(failure.status, {
      code: failure.code,
      fieldErrors: failure.code === 'invalid_request'
        ? itemField === null
          ? { form: 'Reload current reporting facts and prepare the correction again.' }
          : {
              form: 'Check the highlighted reporting attribution and prepare again.',
              [itemField]: 'Enter a whole amount from 0 through 99,999,999.'
            }
        : {},
      retrySubmission: failure.code === 'temporarily_unavailable'
        ? retrySubmission
        : null
    });
  }
}

async function prepareRecoveryActivation(
  event: Parameters<Actions['saveDraft']>[0]
) {
  try {
    const actor = requireRefundManagement(event.locals.actor);
    assertSameOrigin(event.request);
    const refundId = requireFinancialRouteUuid(event.params.refundId);
    const returnContext = actionReturnContext(event.url, 'prepareRecoveryActivation');
    const input = await parseAdministrativeRecoveryActivatePrepareRequest(
      event.request,
      refundId
    );
    const administrativeRecoveryActivationPreview = await previewAdministrativeRecovery(
      getDatabaseClient().db,
      actor,
      input,
      createFinancialRequestContext(event.request, event.route.id)
    );
    return {
      administrativeRecoveryActivationPreview,
      reviewCursor: returnContext.reviewCursor
    };
  } catch (cause: unknown) {
    const failure = financialActionFailure(
      cause instanceof FinancialAdminConflictError
        ? new FinancialRouteError('stale_state')
        : cause
    );
    return fail(failure.status, {
      code: failure.code,
      fieldErrors: failure.code === 'invalid_request'
        ? { form: 'Reload current recovery facts and prepare activation again.' }
        : {},
      retrySubmission: null
    });
  }
}

async function confirmRecoveryActivation(
  event: Parameters<Actions['saveDraft']>[0]
) {
  let retrySubmission: Extract<
    RetrySubmission,
    { action: 'confirmRecoveryActivation' }
  > | null = null;
  try {
    const actor = requireRefundManagement(event.locals.actor);
    assertSameOrigin(event.request);
    const refundId = requireFinancialRouteUuid(event.params.refundId);
    const returnContext = actionReturnContext(event.url, 'confirmRecoveryActivation');
    const submission = await parseAdministrativeRecoveryActivateConfirmRequest(
      event.request,
      refundId
    );
    retrySubmission = {
      action: 'confirmRecoveryActivation',
      idempotencyKey: submission.idempotencyKey,
      finalizationEffectId: submission.command.finalizationEffectId,
      orderItemId: submission.command.orderItemId,
      expectedCorrectionSetId: submission.command.expectedCorrectionSetId,
      expectedCorrectionVersion: submission.command.expectedCorrectionVersion,
      expectedSourceFingerprint: submission.command.expectedSourceFingerprint,
      previewFingerprint: submission.command.previewFingerprint,
      confirmation: submission.command.confirmation
    };
    const command = await submitFinancialAdminCommand(getDatabaseClient().db, {
      actor,
      idempotencyKey: submission.idempotencyKey,
      command: submission.command,
      context: createFinancialRequestContext(event.request, event.route.id)
    });
    return { command, reviewCursor: returnContext.reviewCursor };
  } catch (cause: unknown) {
    const failure = financialActionFailure(cause);
    return fail(failure.status, {
      code: failure.code,
      fieldErrors: failure.code === 'invalid_request'
        ? { form: 'Reload current recovery facts and prepare activation again.' }
        : {},
      retrySubmission: failure.code === 'temporarily_unavailable'
        ? retrySubmission
        : null
    });
  }
}

async function prepareRecoveryDeactivation(
  event: Parameters<Actions['saveDraft']>[0]
) {
  try {
    const actor = requireRefundManagement(event.locals.actor);
    assertSameOrigin(event.request);
    const refundId = requireFinancialRouteUuid(event.params.refundId);
    const returnContext = actionReturnContext(event.url, 'prepareRecoveryDeactivation');
    const input = await parseAdministrativeRecoveryDeactivatePrepareRequest(
      event.request,
      refundId
    );
    const administrativeRecoveryDeactivationPreview =
      await previewAdministrativeRecoveryDeactivation(
        getDatabaseClient().db,
        actor,
        input,
        createFinancialRequestContext(event.request, event.route.id)
      );
    return {
      administrativeRecoveryDeactivationPreview,
      reviewCursor: returnContext.reviewCursor
    };
  } catch (cause: unknown) {
    const failure = financialActionFailure(
      cause instanceof FinancialAdminConflictError
        ? new FinancialRouteError('stale_state')
        : cause
    );
    return fail(failure.status, {
      code: failure.code,
      fieldErrors: failure.code === 'invalid_request'
        ? { form: 'Reload current recovery facts and prepare deactivation again.' }
        : {},
      retrySubmission: null
    });
  }
}

async function confirmRecoveryDeactivation(
  event: Parameters<Actions['saveDraft']>[0]
) {
  let retrySubmission: Extract<
    RetrySubmission,
    { action: 'confirmRecoveryDeactivation' }
  > | null = null;
  try {
    const actor = requireRefundManagement(event.locals.actor);
    assertSameOrigin(event.request);
    requireFinancialRouteUuid(event.params.refundId);
    const returnContext = actionReturnContext(event.url, 'confirmRecoveryDeactivation');
    const submission = await parseAdministrativeRecoveryDeactivateConfirmRequest(
      event.request
    );
    retrySubmission = {
      action: 'confirmRecoveryDeactivation',
      idempotencyKey: submission.idempotencyKey,
      recoveryGrantId: submission.command.recoveryGrantId,
      recoveryReferenceId: submission.command.recoveryReferenceId,
      expectedStateChangedAt: submission.command.expectedStateChangedAt,
      confirmation: submission.command.confirmation
    };
    const command = await submitFinancialAdminCommand(getDatabaseClient().db, {
      actor,
      idempotencyKey: submission.idempotencyKey,
      command: submission.command,
      context: createFinancialRequestContext(event.request, event.route.id)
    });
    return { command, reviewCursor: returnContext.reviewCursor };
  } catch (cause: unknown) {
    const failure = financialActionFailure(cause);
    return fail(failure.status, {
      code: failure.code,
      fieldErrors: failure.code === 'invalid_request'
        ? { form: 'Reload current recovery facts and prepare deactivation again.' }
        : {},
      retrySubmission: failure.code === 'temporarily_unavailable'
        ? retrySubmission
        : null
    });
  }
}

export const actions: Actions = {
  saveDraft: (event) => submitDraft(event, 'saveDraft'),
  discardDraft: (event) => submitDraft(event, 'discardDraft'),
  prepareFinalize: prepareFinalization,
  confirmFinalize: confirmFinalization,
  prepareCorrection,
  confirmCorrection,
  prepareRecoveryActivation,
  confirmRecoveryActivation,
  prepareRecoveryDeactivation,
  confirmRecoveryDeactivation
};
