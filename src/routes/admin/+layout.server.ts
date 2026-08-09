import { error, redirect } from '@sveltejs/kit';
import { AuthorizationError, requireCapability } from '$lib/server/auth/admin-policy';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
  try {
    requireCapability(locals.actor, 'admin.access');
  } catch (cause: unknown) {
    if (cause instanceof AuthorizationError && cause.status === 401) {
      redirect(303, '/?auth=required');
    }
    error(403, 'Forbidden');
  }
  return { user: locals.user };
};
