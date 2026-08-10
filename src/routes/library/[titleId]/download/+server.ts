import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthorizationError } from '$lib/server/auth/admin-policy';
import { safeAuditRequestMetadata } from '$lib/server/audit/request-metadata';
import {
  MediaNotFoundError,
  resolveCustomerOriginalDownload
} from '$lib/server/catalog/media';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { streamMediaResponse } from '$lib/server/http/media-response';
import { getObjectStorage } from '$lib/server/storage/runtime';
import type { RequestHandler } from './$types';

const parametersSchema = z.strictObject({ titleId: z.uuid() });
const requestIdSchema = z.string().trim().min(1).max(200);

const respond: RequestHandler = async ({ locals, params, request, route }) => {
  const parsed = parametersSchema.safeParse(params);
  if (!parsed.success) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (locals.actor.type === 'anonymous') {
    return new Response('Sign in required', { status: 401, headers: { 'cache-control': 'no-store' } });
  }
  if (locals.actor.type !== 'user') {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const storage = getObjectStorage();
  const incoming = requestIdSchema.safeParse(request.headers.get('x-request-id'));
  try {
    const resolved = await resolveCustomerOriginalDownload(
      getDatabaseClient().db,
      storage,
      locals.actor,
      {
        titleId: parsed.data.titleId,
        correlationId: incoming.success ? incoming.data : randomUUID(),
        rangeRequested: request.headers.has('range'),
        requestMetadata: safeAuditRequestMetadata(request, route.id)
      }
    );
    return streamMediaResponse(
      storage,
      resolved.access,
      request.method === 'HEAD' ? 'HEAD' : 'GET',
      request.headers.get('range')
    );
  } catch (cause: unknown) {
    if (cause instanceof MediaNotFoundError || cause instanceof AuthorizationError) {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    throw cause;
  }
};

export const GET = respond;
export const HEAD = respond;
