import type { RequestHandler } from './$types';
import { InvalidCartError } from '$lib/server/commerce/errors';
import { quoteCart } from '$lib/server/commerce/quote';
import { consumeRateLimit, rateLimitScopeDigest } from '$lib/server/commerce/rate-limit';
import { getApplicationConfig } from '$lib/server/config';
import { getDatabaseClient } from '$lib/server/db/runtime';
import {
  StrictHttpError,
  assertSameOrigin,
  privateJson,
  readStrictJson
} from '$lib/server/http/strict-json';
import { quoteRequestSchema } from '$lib/types/commerce';

const MAX_QUOTE_JSON_BYTES = 8 * 1024;

export const POST: RequestHandler = async (event) => {
  try {
    assertSameOrigin(event.request);
    const config = getApplicationConfig();
    const scopeSha256 = rateLimitScopeDigest({
      actor: event.locals.actor,
      requestIp: event.getClientAddress(),
      applicationSecret: config.auth.secret
    });
    const decision = await consumeRateLimit(getDatabaseClient().db, {
      namespace: 'commerce.quote',
      scopeSha256,
      windowSeconds: config.commerce.checkoutRateLimitWindowSeconds,
      maxAttempts: config.commerce.checkoutRateLimitMax
    });
    if (!decision.allowed) {
      const response = privateJson({ code: 'RATE_LIMITED' }, 429);
      response.headers.set(
        'retry-after',
        String(
          Math.max(
            1,
            Math.min(
              config.commerce.checkoutRateLimitWindowSeconds,
              decision.retryAfterSeconds
            )
          )
        )
      );
      return response;
    }
    const input = await readStrictJson(event.request, quoteRequestSchema, {
      maxBytes: MAX_QUOTE_JSON_BYTES
    });
    const quote = await quoteCart(
      getDatabaseClient().db,
      event.locals.actor,
      input.titleIds,
      input.checkoutAttemptId
    );
    return privateJson(quote);
  } catch (error) {
    if (error instanceof StrictHttpError) {
      return privateJson({ code: error.code }, error.status);
    }
    if (error instanceof InvalidCartError) {
      return privateJson({ code: error.code }, 422);
    }
    return privateJson({ code: 'TEMPORARILY_UNAVAILABLE' }, 503);
  }
};
