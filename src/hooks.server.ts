import { performance } from 'node:perf_hooks';

import { building } from '$app/environment';
import type { Handle, ServerInit } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { isRequestAvailable } from '$lib/server/application-mode';
import { actorForUser } from '$lib/server/auth/identity';
import { getAuthServer } from '$lib/server/auth/runtime';
import { getApplicationConfig } from '$lib/server/config';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { canonicalizeBodylessRedirect } from '$lib/server/http/canonical-redirect';
import {
  correlationIdForRequest,
  runWithDiagnosticContext
} from '$lib/server/observability/context';
import type { CorrelationId } from '$lib/server/observability/contracts';
import { emitHttpLifecycleEvent } from '$lib/server/observability/http-lifecycle';
import {
  createStructuredLogger,
  type StructuredLogger
} from '$lib/server/observability/logger';
import { reduceSafeError } from '$lib/server/observability/safe-error';
import { getObjectStorage } from '$lib/server/storage/runtime';

export const init: ServerInit = () => {
  if (building) return;
  getApplicationConfig();
  getDatabaseClient();
  getObjectStorage();
};

type HandleInput = Parameters<Handle>[0];

async function requestOperation(
  event: HandleInput['event'],
  resolve: HandleInput['resolve'],
  config: ReturnType<typeof getApplicationConfig>
): Promise<{ readonly response: Response; readonly maintenance: boolean }> {
  if (!isRequestAvailable(config.applicationMode, event.url.pathname)) {
    return {
      response: new Response(
        'Service temporarily unavailable while the backend is being prepared.',
        {
          status: 503,
          headers: {
            'cache-control': 'no-store',
            'content-type': 'text/plain; charset=utf-8',
            'retry-after': '60'
          }
        }
      ),
      maintenance: true
    };
  }

  const auth = getAuthServer();
  const resolved = await auth.api.getSession({
    headers: event.request.headers,
  });
  if (resolved) {
    const actor = await actorForUser(getDatabaseClient().db, resolved.user.id);
    event.locals.user = {
      id: resolved.user.id,
      name: resolved.user.name,
      email: resolved.user.email,
      emailVerified: resolved.user.emailVerified,
      roles: actor.roles,
    };
    event.locals.session = {
      id: resolved.session.id,
      userId: resolved.session.userId,
      expiresAt: resolved.session.expiresAt,
    };
    event.locals.actor = actor;
  }

  return {
    response: canonicalizeBodylessRedirect(
      await svelteKitHandler({ event, resolve, auth, building })
    ),
    maintenance: false
  };
}

type CapturedRequestOperation =
  | { readonly ok: true; readonly response: Response; readonly maintenance: boolean }
  | { readonly ok: false; readonly cause: unknown };

async function captureRequestOperation(
  event: HandleInput['event'],
  resolve: HandleInput['resolve'],
  config: ReturnType<typeof getApplicationConfig>
): Promise<CapturedRequestOperation> {
  try {
    return { ok: true, ...await requestOperation(event, resolve, config) };
  } catch (cause) {
    return { ok: false, cause };
  }
}

async function observedRequest(
  event: HandleInput['event'],
  resolve: HandleInput['resolve'],
  config: ReturnType<typeof getApplicationConfig>,
  correlationId: CorrelationId,
  logger: StructuredLogger<'web'>
): Promise<Response> {
  const startedAt = performance.now();
  const captured = await captureRequestOperation(event, resolve, config);
  const endedAt = performance.now();

  if (!captured.ok) {
    const safeError = reduceSafeError(captured.cause, {
      operation: 'http.request',
      correlationId
    });
    emitHttpLifecycleEvent(logger, {
      correlationId,
      method: event.request.method,
      routeId: event.route.id,
      startedAt,
      endedAt,
      escapedException: true,
      code: safeError.code
    });
    throw captured.cause;
  }

  emitHttpLifecycleEvent(logger, {
    correlationId,
    method: event.request.method,
    routeId: event.route.id,
    startedAt,
    endedAt,
    status: captured.response.status,
    maintenance: captured.maintenance
  });
  return captured.response;
}

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = null;
  event.locals.session = null;
  event.locals.actor = { type: 'anonymous' };

  if (building) return canonicalizeBodylessRedirect(await resolve(event));

  const config = getApplicationConfig();
  const logger = createStructuredLogger({
    service: 'web',
    environment: config.environment
  });

  if (event.isSubRequest) {
    return (await requestOperation(event, resolve, config)).response;
  }

  const correlationId = correlationIdForRequest(event.request);
  return runWithDiagnosticContext(
    { kind: 'web', correlationId },
    () => observedRequest(event, resolve, config, correlationId, logger)
  );
};
