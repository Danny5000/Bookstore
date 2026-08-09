import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthorizationError, requireCapability } from '$lib/server/auth/admin-policy';
import { safeAuditRequestMetadata } from '$lib/server/audit/request-metadata';
import { CatalogDomainError } from '$lib/server/catalog/errors';
import { acceptRevisionUpload } from '$lib/server/catalog/revisions';
import { getApplicationConfig } from '$lib/server/config';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { stagingUploadKey, type StorageKey } from '$lib/server/storage/keys';
import { getObjectStorage } from '$lib/server/storage/runtime';
import { parsePublicationUpload, UploadError } from '$lib/server/uploads/multipart';
import { streamObjectWithSha256 } from '$lib/server/uploads/stream-object';
import type { RequestHandler } from './$types';

const titleIdSchema = z.uuid();
const requestIdSchema = z.string().trim().min(1).max(200);

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

function authorizationResponse(cause: AuthorizationError): Response {
  return jsonResponse(
    {
      code: cause.code,
      message: cause.status === 401 ? 'Sign in required' : 'Forbidden'
    },
    cause.status
  );
}

function catalogResponse(cause: CatalogDomainError): Response {
  if (cause.code === 'title_not_found') {
    return jsonResponse({ code: cause.code, message: 'Title not found' }, 404);
  }
  if (cause.code === 'invalid_upload_format') {
    return jsonResponse({ code: cause.code, message: 'File format does not match the title' }, 400);
  }
  return jsonResponse({ code: cause.code, message: 'Revision upload conflicts with the title' }, 409);
}

export const POST: RequestHandler = async ({ locals, params, request, route }) => {
  try {
    requireCapability(locals.actor, 'catalog.manage');
  } catch (cause: unknown) {
    if (cause instanceof AuthorizationError) return authorizationResponse(cause);
    throw cause;
  }

  const titleId = titleIdSchema.safeParse(params.titleId);
  if (!titleId.success) return jsonResponse({ code: 'invalid_title_id', message: 'Invalid title ID' }, 400);

  const storage = getObjectStorage();
  let stagingKey: StorageKey | undefined;
  let accepted = false;
  try {
    const parsed = await parsePublicationUpload(
      request,
      getApplicationConfig().ingestion.maxUploadBytes
    );
    stagingKey = stagingUploadKey(randomUUID());
    const staged = await streamObjectWithSha256(
      storage,
      stagingKey,
      parsed.file,
      getApplicationConfig().ingestion.maxUploadBytes,
      request.signal
    );
    await parsed.completion;
    const incomingRequestId = requestIdSchema.safeParse(request.headers.get('x-request-id'));
    const correlationId = incomingRequestId.success ? incomingRequestId.data : randomUUID();
    const revision = await acceptRevisionUpload(getDatabaseClient().db, {
      actor: locals.actor,
      correlationId,
      requestMetadata: safeAuditRequestMetadata(request, route.id),
      input: {
        titleId: titleId.data,
        parentRevisionId: parsed.parentRevisionId,
        changeSummary: parsed.changeSummary,
        stagingStorageKey: stagingKey,
        stagingChecksumSha256: staged.checksumSha256,
        stagingByteSize: staged.byteSize,
        uploadFilename: parsed.filename,
        uploadMimeType: parsed.mediaType
      }
    });
    accepted = true;
    return jsonResponse({ revisionId: revision.id, state: 'uploaded' }, 202);
  } catch (cause: unknown) {
    if (stagingKey && !accepted) await storage.delete(stagingKey).catch(() => undefined);
    if (cause instanceof UploadError) {
      return jsonResponse({ code: cause.code, message: cause.message }, cause.status);
    }
    if (cause instanceof CatalogDomainError) return catalogResponse(cause);
    throw cause;
  }
};
