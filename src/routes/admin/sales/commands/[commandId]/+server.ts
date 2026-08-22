import { assertSameOrigin, privateJson } from '$lib/server/http/strict-json';
import { AuthorizationError } from '$lib/server/auth/admin-policy';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { getFinancialAdminCommandStatus } from '$lib/server/commerce/financial/admin-commands/repository';
import { parseFinancialAdminCommandStatus } from '$lib/types/financial-reporting';
import {
  FinancialRouteError,
  financialActionFailure,
  requireFinancialRouteUuid,
  withFinancialRouteAuthorization
} from '../../route-support';
import type { RequestHandler } from './$types';

function requireSameOriginRead(request: Request): void {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new AuthorizationError('forbidden', 403);
  }

  const suppliedOrigin = request.headers.get('origin');
  if (suppliedOrigin === null) return;
  try {
    assertSameOrigin(request);
  } catch {
    throw new AuthorizationError('forbidden', 403);
  }
}

export const GET: RequestHandler = async ({ locals, params, request }) => {
  try {
    return await withFinancialRouteAuthorization(
      locals.actor,
      'sales.read',
      async (actor) => {
        requireSameOriginRead(request);
        const commandId = requireFinancialRouteUuid(params.commandId);
        const status = await getFinancialAdminCommandStatus(
          getDatabaseClient().db,
          actor,
          commandId
        );
        if (status === null) throw new FinancialRouteError('not_found');
        return privateJson(parseFinancialAdminCommandStatus(status));
      }
    );
  } catch (cause: unknown) {
    const failure = financialActionFailure(cause);
    return privateJson(failure, failure.status);
  }
};
