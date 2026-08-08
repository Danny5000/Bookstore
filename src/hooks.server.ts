import type { Handle, ServerInit } from '@sveltejs/kit';
import { isRequestAvailable } from '$lib/server/application-mode';
import { getApplicationConfig } from '$lib/server/config';

export const init: ServerInit = () => {
  getApplicationConfig();
};

export const handle: Handle = async ({ event, resolve }) => {
  const config = getApplicationConfig();
  event.locals.user = null;

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

  if (config.applicationMode === 'prototype') {
    const email = event.cookies.get('po_session') ?? null;
    event.locals.user = email ? { email } : null;
  }

  return resolve(event);
};
