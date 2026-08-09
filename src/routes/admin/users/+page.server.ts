import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { AuthorizationError, requireCapability } from '$lib/server/auth/admin-policy';
import {
  LastAdministratorError,
  RoleTargetNotFoundError,
  listUsersWithRoles,
  setAdminRole
} from '$lib/server/auth/roles';
import { getDatabaseClient } from '$lib/server/db/runtime';
import type { Actions, PageServerLoad } from './$types';

const roleInputSchema = z.strictObject({
  userId: z.uuid(),
  enabled: z.enum(['true', 'false'])
});
const requestIdSchema = z.string().trim().min(1).max(200);

export const load: PageServerLoad = async ({ locals }) => {
  requireCapability(locals.actor, 'roles.manage');
  return { users: await listUsersWithRoles(getDatabaseClient().db) };
};

export const actions: Actions = {
  setAdmin: async ({ locals, request }) => {
    try {
      requireCapability(locals.actor, 'roles.manage');
    } catch (cause: unknown) {
      if (cause instanceof AuthorizationError) {
        return fail(cause.status, { message: cause.status === 401 ? 'Sign in required' : 'Forbidden' });
      }
      throw cause;
    }

    const values = Object.fromEntries(await request.formData());
    const parsed = roleInputSchema.safeParse(values);
    if (!parsed.success) return fail(400, { message: 'Invalid role change request' });
    const incomingRequestId = requestIdSchema.safeParse(request.headers.get('x-request-id'));
    const correlationId = incomingRequestId.success ? incomingRequestId.data : randomUUID();
    const database = getDatabaseClient().db;

    try {
      await setAdminRole(database, {
        actor: locals.actor,
        targetUserId: parsed.data.userId,
        enabled: parsed.data.enabled === 'true',
        correlationId
      });
      return { users: await listUsersWithRoles(database) };
    } catch (cause: unknown) {
      if (cause instanceof AuthorizationError) {
        return fail(cause.status, { message: cause.status === 401 ? 'Sign in required' : 'Forbidden' });
      }
      if (cause instanceof RoleTargetNotFoundError) {
        return fail(404, { message: 'User not found' });
      }
      if (cause instanceof LastAdministratorError) {
        return fail(409, { message: 'The final administrator cannot be removed' });
      }
      throw cause;
    }
  }
};
