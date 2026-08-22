import { error } from '@sveltejs/kit';
import { requireCapability } from '$lib/server/auth/admin-policy';
import {
  listPayouts,
  parsePayoutListInput
} from '$lib/server/commerce/reporting/payouts';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { financialActionFailure } from '../route-support';
import type { PageServerLoad } from './$types';

function failSafely(cause: unknown): never {
  const failure = financialActionFailure(cause);
  error(failure.status, failure.code);
}

export const load: PageServerLoad = async (event) => {
  try {
    requireCapability(event.locals.actor, 'sales.read');
    const input = parsePayoutListInput(event.url);
    return await listPayouts(getDatabaseClient().db, event.locals.actor, input);
  } catch (cause: unknown) {
    failSafely(cause);
  }
};
