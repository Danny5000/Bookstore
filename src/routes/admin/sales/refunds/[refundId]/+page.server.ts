import { randomUUID } from 'node:crypto';
import { error, fail } from '@sveltejs/kit';
import {
  requireCapability,
  type Actor,
  type AdministratorActor
} from '$lib/server/auth/admin-policy';
import { submitFinancialAdminCommand } from '$lib/server/commerce/financial/admin-commands/repository';
import {
  parseRefundDraftDiscardRequest,
  parseRefundDraftSaveRequest,
  parseRefundReviewReturnContext,
  RefundReviewInputError
} from '$lib/server/commerce/financial/refund-review/inputs';
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

function actionReturnContext(url: URL, action: 'saveDraft' | 'discardDraft') {
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
    const detail = await getRefundReviewDetail(
      getDatabaseClient().db,
      actor,
      refundId,
      context
    );
    if (detail === null) throw new FinancialRouteError('not_found');
    return {
      detail,
      reviewCursor: returnContext.reviewCursor,
      saveDraftIdempotencyKey: randomUUID(),
      discardDraftIdempotencyKey: randomUUID()
    };
  } catch (cause: unknown) {
    failLoadSafely(cause);
  }
};

async function submitDraft(
  event: Parameters<Actions['saveDraft']>[0],
  action: 'saveDraft' | 'discardDraft'
) {
  let retrySubmission:
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
    | null = null;
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

export const actions: Actions = {
  saveDraft: (event) => submitDraft(event, 'saveDraft'),
  discardDraft: (event) => submitDraft(event, 'discardDraft')
};
