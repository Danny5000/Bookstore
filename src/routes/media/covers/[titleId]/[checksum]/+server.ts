import { z } from 'zod';
import { AuthorizationError } from '$lib/server/auth/admin-policy';
import { MediaNotFoundError, resolveCoverAccess } from '$lib/server/catalog/media';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { streamMediaResponse } from '$lib/server/http/media-response';
import { getObjectStorage } from '$lib/server/storage/runtime';
import type { RequestHandler } from './$types';

const parametersSchema = z.strictObject({
  titleId: z.uuid(),
  checksum: z.string().regex(/^[0-9a-f]{64}$/)
});

const respond: RequestHandler = async ({ locals, params, request }) => {
  const parsed = parametersSchema.safeParse(params);
  if (!parsed.success) return new Response('Not found', { status: 404 });
  const storage = getObjectStorage();
  try {
    const access = await resolveCoverAccess(
      getDatabaseClient().db,
      storage,
      locals.actor,
      parsed.data
    );
    return streamMediaResponse(
      storage,
      access,
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
