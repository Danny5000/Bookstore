import type { PageServerLoad } from './$types';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { listCustomerLibrary } from '$lib/server/library/query';

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.actor.type !== 'user') return { signedIn: false as const, entries: [] };
  return {
    signedIn: true as const,
    entries: await listCustomerLibrary(getDatabaseClient().db, locals.actor.id)
  };
};
