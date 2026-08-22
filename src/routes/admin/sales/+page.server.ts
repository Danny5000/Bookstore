import { error } from '@sveltejs/kit';
import { requireCapability } from '$lib/server/auth/admin-policy';
import { listSalesOverview } from '$lib/server/commerce/reporting/overview';
import { parseSalesOverviewFilters } from '$lib/server/commerce/reporting/filters';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { financialActionFailure } from './route-support';
import type { PageServerLoad } from './$types';

function failSafely(cause: unknown): never {
  const failure = financialActionFailure(cause);
  error(failure.status, failure.code);
}

export const load: PageServerLoad = async (event) => {
  try {
    requireCapability(event.locals.actor, 'sales.read');
    const filters = parseSalesOverviewFilters(event.url, new Date());
    return await listSalesOverview(getDatabaseClient().db, event.locals.actor, filters);
  } catch (cause: unknown) {
    failSafely(cause);
  }
};
