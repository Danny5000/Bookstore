import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { AuthorizationError, requireCapability } from '$lib/server/auth/admin-policy';
import { listAuditEvents, parseAuditFilters } from '$lib/server/audit/query';
import { getDatabaseClient } from '$lib/server/db/runtime';

export const load: PageServerLoad = async ({ locals, url }) => {
  try {
    requireCapability(locals.actor, 'audit.read');
  } catch (cause: unknown) {
    if (cause instanceof AuthorizationError) error(cause.status, cause.status === 401 ? 'Sign in required' : 'Forbidden');
    throw cause;
  }
  let filters;
  try {
    filters = parseAuditFilters(url.searchParams);
  } catch {
    error(400, 'Invalid audit filters');
  }
  const page = await listAuditEvents(getDatabaseClient().db, locals.actor, filters);
  const nextSearch = new URLSearchParams(url.searchParams);
  if (page.nextCursor) nextSearch.set('cursor', page.nextCursor);
  else nextSearch.delete('cursor');
  return {
    page,
    values: {
      actorId: filters.actorId ?? '',
      action: filters.action ?? '',
      resourceType: filters.resourceType ?? '',
      resourceId: filters.resourceId ?? '',
      outcome: filters.outcome ?? '',
      from: filters.from?.toISOString() ?? '',
      to: filters.to?.toISOString() ?? '',
      pageSize: filters.pageSize
    },
    nextUrl: page.nextCursor ? `/admin/audit?${nextSearch.toString()}` : null
  };
};
