import { randomUUID } from 'node:crypto';
import { z, ZodError, type ZodType } from 'zod';
import { getApplicationConfig } from '$lib/server/config';

export const DEFAULT_MAX_JSON_BYTES = 16 * 1024;

const requestIdSchema = z.string().trim().min(1).max(200);
const jsonContentType = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;

export class StrictHttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 413 | 415 | 422,
    readonly code: string
  ) {
    super(code);
    this.name = 'StrictHttpError';
  }
}

export function assertSameOrigin(
  request: Request,
  configuredOrigin = getApplicationConfig().origin
): void {
  const expected = new URL(configuredOrigin).origin;
  const supplied = request.headers.get('origin');
  if (!supplied) throw new StrictHttpError(403, 'forbidden');
  try {
    if (new URL(supplied).origin !== expected) {
      throw new StrictHttpError(403, 'forbidden');
    }
  } catch (error) {
    if (error instanceof StrictHttpError) throw error;
    throw new StrictHttpError(403, 'forbidden');
  }
}

export async function readBoundedBody(
  request: Request,
  options: { maxBytes: number }
): Promise<Uint8Array> {
  const { maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new StrictHttpError(413, 'PAYLOAD_TOO_LARGE');
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new StrictHttpError(413, 'PAYLOAD_TOO_LARGE');
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
  schema: Schema,
  options: { maxBytes?: number } = {}
): Promise<z.infer<Schema>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
  const contentType = request.headers.get('content-type')?.trim() ?? '';
  if (!jsonContentType.test(contentType)) {
    throw new StrictHttpError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  let parsed: unknown;
  try {
    const bytes = await readBoundedBody(request, { maxBytes });
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(body);
  } catch (error) {
    if (error instanceof StrictHttpError) throw error;
    throw new StrictHttpError(400, 'INVALID_JSON');
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) throw new StrictHttpError(422, 'INVALID_INPUT');
    throw error;
  }
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
