import { z } from 'zod';
import { AuthorizationError, type Actor } from '$lib/server/auth/admin-policy';
import {
  StrictHttpError,
  assertSameOrigin,
  correlationIdForRequest,
  privateEmpty,
  privateJson,
  readStrictJson
} from '$lib/server/http/strict-json';
import {
  ActiveRevisionChangedError,
  InvalidReaderLocationError,
  ReaderStateNotFoundError,
  StaleReaderStateError
} from '$lib/server/reader-state/errors';

const uuidSchema = z.uuid();

export {
  assertSameOrigin,
  correlationIdForRequest,
  privateEmpty,
  privateJson,
  readStrictJson
};

class ReaderStateRouteError extends Error {
  constructor(
    readonly status: 401 | 403 | 404,
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

export function parseRouteUuid(value: string | undefined): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new ReaderStateRouteError(404, 'NOT_FOUND');
  return parsed.data;
}

export function readerStateErrorResponse(cause: unknown): Response {
  if (cause instanceof ReaderStateRouteError || cause instanceof StrictHttpError) {
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
