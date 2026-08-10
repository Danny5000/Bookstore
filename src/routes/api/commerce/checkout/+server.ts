import type { RequestHandler } from './$types';
import {
  CartChangedError,
  CheckoutUnavailableError,
  CommerceConflictError,
  CommerceRateLimitError,
  InvalidCartError,
  RetryableProviderError
} from '$lib/server/commerce/errors';
import { orchestrateCheckout } from '$lib/server/commerce/orders';
import { setOrderStatusCookie } from '$lib/server/commerce/status-cookie';
import { getApplicationConfig } from '$lib/server/config';
import { getDatabaseClient } from '$lib/server/db/runtime';
import {
  StrictHttpError,
  assertSameOrigin,
  correlationIdForRequest,
  privateJson,
  readStrictJson
} from '$lib/server/http/strict-json';
import { checkoutRequestSchema } from '$lib/types/commerce';

const MAX_CHECKOUT_JSON_BYTES = 8 * 1024;

export const POST: RequestHandler = async (event) => {
  try {
    assertSameOrigin(event.request);
    const config = getApplicationConfig();
    const input = await readStrictJson(event.request, checkoutRequestSchema, {
      maxBytes: MAX_CHECKOUT_JSON_BYTES
    });
    const result = await orchestrateCheckout(
      getDatabaseClient().db,
      {
        actor: event.locals.actor,
        ...input,
        correlationId: correlationIdForRequest(event.request),
        requestIp: event.getClientAddress(),
        applicationSecret: config.auth.secret,
        rateLimit: {
          windowSeconds: config.commerce.checkoutRateLimitWindowSeconds,
          maxAttempts: config.commerce.checkoutRateLimitMax
        }
      },
      {
        origin: config.origin,
        automaticTaxEnabled: config.stripe.automaticTaxEnabled,
        ...(config.stripe.proseTaxCode === undefined
          ? {}
          : { proseTaxCode: config.stripe.proseTaxCode }),
        ...(config.stripe.comicTaxCode === undefined
          ? {}
          : { comicTaxCode: config.stripe.comicTaxCode }),
        checkoutDurationSeconds: config.stripe.checkoutDurationSeconds
      }
    );
    if (result.statusToken !== null) {
      setOrderStatusCookie(event.cookies, {
        environment: config.environment,
        orderId: result.orderId,
        token: result.statusToken,
        checkoutExpiresAt: result.checkoutExpiresAt
      });
    }
    return privateJson({ status: 'redirect', checkoutUrl: result.checkoutUrl });
  } catch (error) {
    if (error instanceof StrictHttpError) {
      return privateJson({ code: error.code }, error.status);
    }
    if (error instanceof CartChangedError && error.quote) {
      return privateJson({ status: 'cart_changed', quote: error.quote }, 409);
    }
    if (error instanceof InvalidCartError) {
      return privateJson({ code: error.code }, 422);
    }
    if (
      error instanceof CommerceConflictError &&
      error.code === 'CHECKOUT_ATTEMPT_CONFLICT'
    ) {
      return privateJson({ code: error.code }, 409);
    }
    if (error instanceof CommerceRateLimitError) {
      const config = getApplicationConfig();
      const response = privateJson({ code: error.code }, 429);
      response.headers.set('retry-after', String(Math.max(
        1,
        Math.min(config.commerce.checkoutRateLimitWindowSeconds, error.retryAfterSeconds)
      )));
      return response;
    }
    if (error instanceof CheckoutUnavailableError || error instanceof RetryableProviderError) {
      return privateJson({ code: 'CHECKOUT_UNAVAILABLE' }, 503);
    }
    return privateJson({ code: 'CHECKOUT_UNAVAILABLE' }, 500);
  }
};
