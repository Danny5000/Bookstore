import { error } from '@sveltejs/kit';
import { requireCapability } from '$lib/server/auth/admin-policy';
import {
  encodePayoutCursor,
  getPayoutDetail,
  parsePayoutListInput
} from '$lib/server/commerce/reporting/payouts';
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
    const payoutId = requireFinancialRouteUuid(event.params.payoutId);
    const returnInput = parsePayoutListInput(event.url);
    const context = createFinancialRequestContext(event.request, event.route.id);
    const payout = await getPayoutDetail(
      getDatabaseClient().db,
      event.locals.actor,
      payoutId,
      context
    );
    if (payout === null) throw new FinancialRouteError('not_found');
    return {
      payout,
      currentCursor: returnInput.cursor === undefined
        ? null
        : encodePayoutCursor(returnInput.cursor)
    };
  } catch (cause: unknown) {
    failSafely(cause);
  }
};
