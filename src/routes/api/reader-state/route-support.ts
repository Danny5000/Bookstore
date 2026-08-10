import { randomUUID } from 'node:crypto';
import { z, ZodError, type ZodType } from 'zod';
import { AuthorizationError, type Actor } from '$lib/server/auth/admin-policy';
import { getApplicationConfig } from '$lib/server/config';
import {
  ActiveRevisionChangedError,
  InvalidReaderLocationError,
  ReaderStateNotFoundError,
  StaleReaderStateError
} from '$lib/server/reader-state/errors';

const MAX_JSON_BYTES = 16 * 1024;
const requestIdSchema = z.string().trim().min(1).max(200);
const uuidSchema = z.uuid();
const jsonContentType = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;

class ReaderStateRouteError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 413 | 415 | 422,
    readonly code: string
  ) {
    super(code);
    this.name = 'ReaderStateRouteError';
  }
}

type UserActor = Extract<Actor, { type: 'user' }>;

export function requireMutationActor(actor: Actor): UserActor {
  if (actor.type === 'anonymous') throw new ReaderStateRouteError(401, 'unauthenticated');
  if (actor.type !== 'user') throw new ReaderStateRouteError(403, 'forbidden');
  return actor;
}

export function assertSameOrigin(request: Request): void {
  const expected = new URL(getApplicationConfig().origin).origin;
  const supplied = request.headers.get('origin');
  if (!supplied) throw new ReaderStateRouteError(403, 'forbidden');
  try {
    if (new URL(supplied).origin !== expected) {
      throw new ReaderStateRouteError(403, 'forbidden');
    }
  } catch (error) {
    if (error instanceof ReaderStateRouteError) throw error;
    throw new ReaderStateRouteError(403, 'forbidden');
  }
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new ReaderStateRouteError(413, 'PAYLOAD_TOO_LARGE');
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new ReaderStateRouteError(413, 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readStrictJson<Schema extends ZodType>(
  request: Request,
  schema: Schema
): Promise<z.infer<Schema>> {
  const contentType = request.headers.get('content-type')?.trim() ?? '';
  if (!jsonContentType.test(contentType)) {
    throw new ReaderStateRouteError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  let parsed: unknown;
  try {
    const bytes = await boundedBody(request);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof ReaderStateRouteError) throw error;
    throw new ReaderStateRouteError(400, 'INVALID_JSON');
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) throw new ReaderStateRouteError(422, 'INVALID_INPUT');
    throw error;
  }
}

export function parseRouteUuid(value: string | undefined): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new ReaderStateRouteError(404, 'NOT_FOUND');
  return parsed.data;
}

export function correlationIdForRequest(request: Request): string {
  const parsed = requestIdSchema.safeParse(request.headers.get('x-request-id'));
  return parsed.success ? parsed.data : randomUUID();
}

export function privateJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

export function privateEmpty(status = 204): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

export function readerStateErrorResponse(cause: unknown): Response {
  if (cause instanceof ReaderStateRouteError) {
    return privateJson({ code: cause.code }, cause.status);
  }
  if (cause instanceof InvalidReaderLocationError) {
    return privateJson({ code: 'INVALID_INPUT' }, 422);
  }
  if (
    cause instanceof ReaderStateNotFoundError ||
    cause instanceof ActiveRevisionChangedError ||
    cause instanceof AuthorizationError
  ) return privateJson({ code: 'NOT_FOUND' }, 404);
  if (cause instanceof StaleReaderStateError) {
    return privateJson({ code: cause.code, current: cause.current }, 409);
  }
  return privateJson({ code: 'TEMPORARILY_UNAVAILABLE' }, 503);
}

export async function handleReaderStateMutation(
  work: () => Promise<Response>
): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    return readerStateErrorResponse(error);
  }
}
