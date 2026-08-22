import { requireCapability } from '$lib/server/auth/admin-policy';
import { exportSalesCsv } from '$lib/server/commerce/reporting/csv';
import { parseSalesOverviewFilters } from '$lib/server/commerce/reporting/filters';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { privateJson } from '$lib/server/http/strict-json';
import { createFinancialRequestContext, financialActionFailure } from '../route-support';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  try {
    requireCapability(event.locals.actor, 'sales.read');
    requireCapability(event.locals.actor, 'sales.export');
    const filters = parseSalesOverviewFilters(event.url, new Date());
    const context = createFinancialRequestContext(event.request, event.route.id);
    const result = await exportSalesCsv(
      getDatabaseClient().db,
      event.locals.actor,
      filters,
      context
    );
    return new Response(result.bytes, {
      headers: {
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${result.filename}"`,
        'content-type': 'text/csv; charset=utf-8',
        'x-content-type-options': 'nosniff'
      }
    });
  } catch (cause: unknown) {
    const failure = financialActionFailure(cause);
    return privateJson(failure, failure.status);
  }
};
