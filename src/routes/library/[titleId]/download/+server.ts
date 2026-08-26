import { z } from 'zod';
import { AuthorizationError } from '$lib/server/auth/admin-policy';
import {
  MediaNotFoundError,
  streamCustomerOriginalDownload
} from '$lib/server/catalog/media';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { correlationIdForRequest } from '$lib/server/observability/context';
import { getObjectStorage } from '$lib/server/storage/runtime';
import type { RequestHandler } from './$types';

const parametersSchema = z.strictObject({ titleId: z.uuid() });

const respond: RequestHandler = async ({ locals, params, request }) => {
  const parsed = parametersSchema.safeParse(params);
  if (!parsed.success) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (locals.actor.type === 'anonymous') {
    return new Response('Sign in required', { status: 401, headers: { 'cache-control': 'no-store' } });
  }
  if (locals.actor.type !== 'user') {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const storage = getObjectStorage();
  try {
    return await streamCustomerOriginalDownload(
      getDatabaseClient().db,
      storage,
      locals.actor,
      {
        titleId: parsed.data.titleId,
        correlationId: correlationIdForRequest(request),
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        rangeHeader: request.headers.get('range')
      }
    );
  } catch (cause: unknown) {
    if (cause instanceof MediaNotFoundError || cause instanceof AuthorizationError) {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    return new Response('Download temporarily unavailable', {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        'retry-after': '5'
      }
    });
  }
};

export const GET = respond;
export const HEAD = respond;
