import { z } from 'zod';
import { AuthorizationError } from '$lib/server/auth/admin-policy';
import { safeAuditRequestMetadata } from '$lib/server/audit/request-metadata';
import { MediaNotFoundError, resolveOriginalDownload } from '$lib/server/catalog/media';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { streamMediaResponse } from '$lib/server/http/media-response';
import { correlationIdForRequest } from '$lib/server/observability/context';
import { getObjectStorage } from '$lib/server/storage/runtime';
import type { RequestHandler } from './$types';

const parametersSchema = z.strictObject({ titleId: z.uuid(), revisionId: z.uuid() });

const respond: RequestHandler = async ({ locals, params, request, route }) => {
  const parsed = parametersSchema.safeParse(params);
  if (!parsed.success) return new Response('Not found', { status: 404 });
  const storage = getObjectStorage();
  try {
    const access = await resolveOriginalDownload(databaseClient().db, storage, locals.actor, {
      ...parsed.data,
      correlationId: correlationIdForRequest(request),
      requestMetadata: safeAuditRequestMetadata(request, route.id)
    });
    return streamMediaResponse(
      storage,
      access,
      request.method === 'HEAD' ? 'HEAD' : 'GET',
      request.headers.get('range')
    );
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

export const GET = respond;
export const HEAD = respond;

function databaseClient() {
  return getDatabaseClient();
}
