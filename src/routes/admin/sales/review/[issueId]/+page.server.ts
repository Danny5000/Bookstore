import { error } from '@sveltejs/kit';
import { requireCapability } from '$lib/server/auth/admin-policy';
import {
  encodeFinancialIssueCursor,
  getFinancialIssueDetail,
  parseFinancialIssueListInput
} from '$lib/server/commerce/reporting/review';
import { getDatabaseClient } from '$lib/server/db/runtime';
import {
  createFinancialRequestContext,
  financialActionFailure,
  FinancialRouteError,
  requireFinancialRouteUuid
} from '../../route-support';
import type { PageServerLoad } from './$types';

function failSafely(cause: unknown): never {
  const failure = financialActionFailure(cause);
  error(failure.status, failure.code);
}

export const load: PageServerLoad = async (event) => {
  try {
    requireCapability(event.locals.actor, 'sales.read');
    const issueId = requireFinancialRouteUuid(event.params.issueId);
    const returnInput = parseFinancialIssueListInput(event.url);
    const context = createFinancialRequestContext(event.request, event.route.id);
    const issue = await getFinancialIssueDetail(
      getDatabaseClient().db,
      event.locals.actor,
      issueId,
      context
    );
    if (issue === null) throw new FinancialRouteError('not_found');
    return {
      issue,
      currentCursor: returnInput.cursor === undefined
        ? null
        : encodeFinancialIssueCursor(returnInput.cursor)
    };
  } catch (cause: unknown) {
    failSafely(cause);
  }
};
