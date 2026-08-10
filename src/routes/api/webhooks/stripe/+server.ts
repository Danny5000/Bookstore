import type { RequestHandler } from './$types';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import { getStripeCommerceRuntime } from '$lib/server/commerce/stripe/runtime';
import {
  acceptStripeEvent,
  describeSupportedStripeEvent
} from '$lib/server/commerce/webhooks';
import { getApplicationConfig } from '$lib/server/config';
import { getDatabaseClient } from '$lib/server/db/runtime';
import {
  StrictHttpError,
  privateJson,
  readBoundedBody
} from '$lib/server/http/strict-json';

const MAX_STRIPE_WEBHOOK_BYTES = 64 * 1024;

export const POST: RequestHandler = async (event) => {
  const runtime = getStripeCommerceRuntime();
  if (!runtime.webhooksConfigured || runtime.mode === 'disabled') {
    return privateJson({ code: 'NOT_FOUND' }, 404);
  }
  const signature = event.request.headers.get('stripe-signature');
  if (!signature) return privateJson({ received: false }, 400);

  try {
    const rawBody = await readBoundedBody(event.request, {
      maxBytes: MAX_STRIPE_WEBHOOK_BYTES
    });
    const verified = runtime.gateway.verifyWebhook(rawBody, signature);
    if (verified.liveMode !== getApplicationConfig().stripe.liveMode) {
      return privateJson({ received: false }, 400);
    }
    const descriptor = describeSupportedStripeEvent(verified);
    if (descriptor === null) return privateJson({ received: true });
    await acceptStripeEvent(getDatabaseClient().db, descriptor.event);
    return privateJson({ received: true });
  } catch (error) {
    if (error instanceof StrictHttpError) {
      return privateJson({ code: error.code }, error.status);
    }
    if (error instanceof PermanentCommerceError) {
      return privateJson({ received: false }, 400);
    }
    return privateJson({ received: false }, 500);
  }
};
