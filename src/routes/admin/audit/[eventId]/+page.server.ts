import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { AuthorizationError, requireCapability } from '$lib/server/auth/admin-policy';
import { getAuditEventDetail } from '$lib/server/audit/query';
import { getDatabaseClient } from '$lib/server/db/runtime';

const eventIdSchema = z.uuid();
const requestIdSchema = z.string().trim().min(1).max(200);

export const load: PageServerLoad = async ({ locals, params, request }) => {
  try {
    requireCapability(locals.actor, 'audit.read');
  } catch (cause: unknown) {
    if (cause instanceof AuthorizationError) error(cause.status, cause.status === 401 ? 'Sign in required' : 'Forbidden');
    throw cause;
  }
  const eventId = eventIdSchema.safeParse(params.eventId);
  if (!eventId.success) error(404, 'Audit event not found');
  const incoming = requestIdSchema.safeParse(request.headers.get('x-request-id'));
  const event = await getAuditEventDetail(getDatabaseClient().db, {
    actor: locals.actor,
    eventId: eventId.data,
    correlationId: incoming.success ? incoming.data : randomUUID()
  });
  if (!event) error(404, 'Audit event not found');
  return { event };
};
