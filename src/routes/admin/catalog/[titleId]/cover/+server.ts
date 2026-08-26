import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthorizationError, requireCapability } from '$lib/server/auth/admin-policy';
import { safeAuditRequestMetadata } from '$lib/server/audit/request-metadata';
import { replaceTitleCover } from '$lib/server/catalog/covers';
import { CatalogDomainError } from '$lib/server/catalog/errors';
import { getApplicationConfig } from '$lib/server/config';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { IngestionError } from '$lib/server/ingestion/errors';
import { ingestionLimitsFromConfig } from '$lib/server/ingestion/limits';
import { correlationIdForRequest } from '$lib/server/observability/context';
import { stagingUploadKey, type StorageKey } from '$lib/server/storage/keys';
import { getObjectStorage } from '$lib/server/storage/runtime';
import { parseSingleFileMultipart, UploadError } from '$lib/server/uploads/multipart';
import { streamObjectWithSha256 } from '$lib/server/uploads/stream-object';
import type { RequestHandler } from './$types';

const titleIdSchema = z.uuid();
const coverBytes = 25 * 1024 * 1024;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' }
  });
}

export const POST: RequestHandler = async ({ locals, params, request, route }) => {
  try {
    requireCapability(locals.actor, 'catalog.manage');
  } catch (cause: unknown) {
    if (cause instanceof AuthorizationError) return json({ code: cause.code, message: cause.status === 401 ? 'Sign in required' : 'Forbidden' }, cause.status);
    throw cause;
  }
  const titleId = titleIdSchema.safeParse(params.titleId);
  if (!titleId.success) return json({ code: 'invalid_title_id', message: 'Invalid title ID' }, 400);
  const storage = getObjectStorage();
  let stagingKey: StorageKey | undefined;
  try {
    const maximum = Math.min(coverBytes, getApplicationConfig().ingestion.maxUploadBytes);
    const parsed = await parseSingleFileMultipart(request, {
      fileField: 'cover',
      fieldsSchema: z.object({}).strict(),
      limits: {
        maxFileBytes: maximum,
        maxTotalBytes: maximum + 16_384,
        maxFiles: 1,
        maxFields: 0,
        maxParts: 1,
        maxFieldBytes: 1,
        maxFieldNameBytes: 100
      }
    });
    stagingKey = stagingUploadKey(randomUUID());
    await streamObjectWithSha256(storage, stagingKey, parsed.file, maximum, request.signal);
    await parsed.completion;
    const result = await replaceTitleCover(
      getDatabaseClient().db,
      storage,
      ingestionLimitsFromConfig(getApplicationConfig().ingestion),
      {
        actor: locals.actor,
        correlationId: correlationIdForRequest(request),
        requestMetadata: safeAuditRequestMetadata(request, route.id),
        input: { titleId: titleId.data, sourceKey: stagingKey },
        signal: request.signal
      }
    );
    return json(result, 202);
  } catch (cause: unknown) {
    if (cause instanceof UploadError) return json({ code: cause.code, message: cause.message }, cause.status);
    if (cause instanceof IngestionError) return json({ code: cause.code, message: cause.safeMessage }, 400);
    if (cause instanceof CatalogDomainError) {
      return json({ code: cause.code, message: cause.code === 'title_not_found' ? 'Title not found' : 'Cover update conflict' }, cause.code === 'title_not_found' ? 404 : 409);
    }
    throw cause;
  } finally {
    if (stagingKey) await storage.delete(stagingKey).catch(() => undefined);
  }
};
