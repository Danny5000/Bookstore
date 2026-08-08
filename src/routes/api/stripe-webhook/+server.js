import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { grantPurchase } from '$lib/server/db.js';
import { sendBookEmail } from '$lib/server/mail.js';

/**
 * Stripe webhook. THIS is where a purchase becomes real — never trust the
 * browser's success redirect.
 *
 * Local testing:
 *   stripe listen --forward-to localhost:5173/api/stripe-webhook
 */
export async function POST({ request }) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    throw error(503, 'Stripe is not configured');
  }

  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  const signature = request.headers.get('stripe-signature');
  const body = await request.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    throw error(400, `Signature verification failed: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const titleId = s.metadata?.titleId;
    const email = s.customer_details?.email || s.customer_email;

    // 1. entitlement
    await grantPurchase({
      email,
      titleId,
      amount: s.amount_total,
      stripeSessionId: s.id
    });

    // 2. delivery
    if (s.metadata?.emailCopy === '1') {
      await sendBookEmail({ email, titleId });
    }
  }

  return json({ received: true });
}
