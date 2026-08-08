import type { RequestHandler } from './$types';
import Stripe from 'stripe';
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import { grantPurchase } from '$lib/server/db';
import { sendBookEmail } from '$lib/server/mail';
import { messageFromUnknown } from '$lib/utils/errors';

export const POST: RequestHandler = async ({ request }) => {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    throw error(503, 'Stripe is not configured');
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const signature = request.headers.get('stripe-signature');
  if (!signature) throw error(400, 'Missing Stripe signature');
  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (cause: unknown) {
    throw error(400, `Signature verification failed: ${messageFromUnknown(cause)}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const titleId = session.metadata?.titleId;
    const email = session.customer_details?.email ?? session.customer_email;
    if (!titleId || !email) {
      console.error('[stripe] completed checkout missing title or email', {
        sessionId: session.id
      });
      return json({ received: true });
    }

    await grantPurchase({
      email,
      titleId,
      amount: session.amount_total,
      stripeSessionId: session.id
    });

    if (session.metadata?.emailCopy === '1') {
      await sendBookEmail({ email, titleId });
    }
  }

  return json({ received: true });
};
