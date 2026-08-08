import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { CATALOG } from '$lib/data/catalog.js';

/**
 * Creates a Stripe Checkout Session for one title and returns its URL.
 * The client redirects to it; fulfillment happens in /api/stripe-webhook.
 *
 * Returns 503 when STRIPE_SECRET_KEY is unset so the UI can fall back to its
 * local development grant.
 */
export async function POST({ request, url }) {
  const { titleId, email, emailCopy } = await request.json();

  const title = CATALOG.find((t) => t.id === titleId);
  if (!title) throw error(404, 'Unknown title');

  if (!env.STRIPE_SECRET_KEY) {
    return json({ message: 'Stripe is not configured' }, { status: 503 });
  }

  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(title.price * 100),
          product_data: {
            name: title.title,
            description: title.summary
          }
        }
      }
    ],
    // Everything the webhook needs to fulfill without trusting the client.
    metadata: { titleId: title.id, emailCopy: emailCopy ? '1' : '0' },
    automatic_tax: { enabled: false },
    success_url: `${url.origin}/checkout/success?title=${title.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/book/${title.id}`
  });

  return json({ url: session.url });
}
