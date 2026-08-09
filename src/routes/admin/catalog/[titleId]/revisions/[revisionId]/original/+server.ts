import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthorizationError } from '$lib/server/auth/admin-policy';
import { safeAuditRequestMetadata } from '$lib/server/audit/request-metadata';
import { MediaNotFoundError, resolveOriginalDownload } from '$lib/server/catalog/media';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { streamMediaResponse } from '$lib/server/http/media-response';
import { getObjectStorage } from '$lib/server/storage/runtime';
import type { RequestHandler } from './$types';

const parametersSchema = z.strictObject({ titleId: z.uuid(), revisionId: z.uuid() });
const requestIdSchema = z.string().trim().min(1).max(200);

export const GET: RequestHandler = async ({ locals, params, request, route }) => {
  const parsed = parametersSchema.safeParse(params);
  if (!parsed.success) return new Response('Not found', { status: 404 });
  const storage = getObjectStorage();
  const incomingRequestId = requestIdSchema.safeParse(request.headers.get('x-request-id'));
  try {
    const access = await resolveOriginalDownload(databaseClient().db, storage, locals.actor, {
      ...parsed.data,
      correlationId: incomingRequestId.success ? incomingRequestId.data : randomUUID(),
      requestMetadata: safeAuditRequestMetadata(request, route.id)
    });
    return streamMediaResponse(storage, access, request.headers.get('range'));
  } catch (cause: unknown) {
    if (cause instanceof AuthorizationError) {
      return new Response(cause.status === 401 ? 'Sign in required' : 'Forbidden', {
        status: cause.status,
        headers: { 'cache-control': 'no-store' }
      });
    }
    if (cause instanceof MediaNotFoundError) {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    throw cause;
  }
};

function databaseClient() {
  return getDatabaseClient();
}
