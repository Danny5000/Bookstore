import { building } from '$app/environment';
import type { Handle, ServerInit } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { isRequestAvailable } from '$lib/server/application-mode';
import { actorForUser } from '$lib/server/auth/identity';
import { getAuthServer } from '$lib/server/auth/runtime';
import { getApplicationConfig } from '$lib/server/config';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { getObjectStorage } from '$lib/server/storage/runtime';

export const init: ServerInit = () => {
  if (building) return;
  getApplicationConfig();
  getDatabaseClient();
  getObjectStorage();
};

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = null;
  event.locals.session = null;
  event.locals.actor = { type: 'anonymous' };

  if (building) return resolve(event);

  const config = getApplicationConfig();

  if (!isRequestAvailable(config.applicationMode, event.url.pathname)) {
    return new Response('Service temporarily unavailable while the backend is being prepared.', {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': '60'
      }
    });
  }

  const auth = getAuthServer();
  const resolved = await auth.api.getSession({ headers: event.request.headers });
  if (resolved) {
    const actor = await actorForUser(getDatabaseClient().db, resolved.user.id);
    event.locals.user = {
      id: resolved.user.id,
      name: resolved.user.name,
      email: resolved.user.email,
      emailVerified: resolved.user.emailVerified,
      roles: actor.roles
    };
    event.locals.session = {
      id: resolved.session.id,
      userId: resolved.session.userId,
      expiresAt: resolved.session.expiresAt
    };
    event.locals.actor = actor;
  }

  return svelteKitHandler({ event, resolve, auth, building });
};
