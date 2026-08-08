import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
  const email = event.cookies.get('po_session') ?? null;
  event.locals.user = email ? { email } : null;
  return resolve(event);
};
