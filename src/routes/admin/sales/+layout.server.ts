import { error } from '@sveltejs/kit';
import { requireCapability } from '$lib/server/auth/admin-policy';
import { financialActionFailure } from './route-support';
import type { LayoutServerLoad } from './$types';

function failSafely(cause: unknown): never {
  const failure = financialActionFailure(cause);
  error(failure.status, failure.code);
}

export const load: LayoutServerLoad = (event) => {
  try {
    requireCapability(event.locals.actor, 'sales.read');
    return {};
  } catch (cause: unknown) {
    failSafely(cause);
  }
};
