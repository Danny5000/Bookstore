import type { RequestHandler } from './$types';
import { OrderNotFoundError } from '$lib/server/commerce/errors';
import { getAuthorizedOrderStatus } from '$lib/server/commerce/status';
import { orderStatusCookieName } from '$lib/server/commerce/status-cookie';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { privateJson } from '$lib/server/http/strict-json';

export const GET: RequestHandler = async (event) => {
  let cookieName: string;
  try {
    cookieName = orderStatusCookieName(event.params.orderId);
  } catch {
    return privateJson({ code: 'NOT_FOUND' }, 404);
  }
  try {
    const orderId = event.params.orderId;
    const statusToken = event.cookies.get(cookieName) ?? null;
    const status = await getAuthorizedOrderStatus(getDatabaseClient().db, {
      orderId,
      actor: event.locals.actor,
      statusToken
    });
    return privateJson(status);
  } catch (error) {
    if (error instanceof OrderNotFoundError) {
      return privateJson({ code: 'NOT_FOUND' }, 404);
    }
    return privateJson({ code: 'TEMPORARILY_UNAVAILABLE' }, 503);
  }
};
