import { z } from 'zod';
import { AuthorizationError, requireCapability } from '$lib/server/auth/admin-policy';
import { getAdminRevisionStatus } from '$lib/server/catalog/revisions';
import { getDatabaseClient } from '$lib/server/db/runtime';
import type { RequestHandler } from './$types';

const parametersSchema = z.strictObject({ titleId: z.uuid(), revisionId: z.uuid() });

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' }
  });
}

export const GET: RequestHandler = async ({ locals, params }) => {
  try {
    requireCapability(locals.actor, 'catalog.manage');
  } catch (cause: unknown) {
    if (cause instanceof AuthorizationError) {
      return json({ code: cause.code, message: cause.status === 401 ? 'Sign in required' : 'Forbidden' }, cause.status);
    }
    throw cause;
  }
  const parsed = parametersSchema.safeParse(params);
  if (!parsed.success) return json({ code: 'not_found', message: 'Not found' }, 404);
  const status = await getAdminRevisionStatus(
    getDatabaseClient().db,
    parsed.data.titleId,
    parsed.data.revisionId
  );
  return status ? json(status, 200) : json({ code: 'not_found', message: 'Not found' }, 404);
};
