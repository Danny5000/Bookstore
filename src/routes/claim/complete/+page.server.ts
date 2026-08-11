import { claimGuestPurchases } from '$lib/server/commerce/claims';
import { COMMERCE_CLAIM_AUTH_COOKIE } from '$lib/server/auth/commerce-claim-authorization';
import { CommerceConflictError, PermanentCommerceError } from '$lib/server/commerce/errors';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { correlationIdForRequest } from '$lib/server/http/strict-json';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, request, cookies }) => {
  if (url.searchParams.has('error')) return { state: 'retry' as const };
  if (
    locals.actor.type !== 'user' ||
    !locals.user?.emailVerified ||
    !locals.session ||
    locals.user.id !== locals.actor.id ||
    locals.session.userId !== locals.actor.id
  ) return { state: 'sign_in' as const };
  const authorizationToken = cookies.get(COMMERCE_CLAIM_AUTH_COOKIE);
  if (!authorizationToken) return { state: 'not_claimed' as const };

  try {
    const result = await claimGuestPurchases(getDatabaseClient().db, {
      userId: locals.actor.id,
      correlationId: correlationIdForRequest(request),
      authorizationToken
    });
    cookies.delete(COMMERCE_CLAIM_AUTH_COOKIE, { path: '/claim/complete' });
    return { state: result.claimed ? 'claimed' as const : 'not_claimed' as const };
  } catch (error) {
    if (error instanceof CommerceConflictError || error instanceof PermanentCommerceError) {
      cookies.delete(COMMERCE_CLAIM_AUTH_COOKIE, { path: '/claim/complete' });
      return { state: 'not_claimed' as const };
    }
    return { state: 'unavailable' as const };
  }
};
