import type { RequestHandler } from './$types';
import Stripe from 'stripe';
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import { CATALOG } from '$lib/data/catalog';
import { parseCheckoutRequest } from '$lib/types/api';

export const POST: RequestHandler = async ({ request, url }) => {
  const raw: unknown = await request.json();
  const body = parseCheckoutRequest(raw);
  if (!body) throw error(400, 'Invalid checkout request');

  const title = CATALOG.find((candidate) => candidate.id === body.titleId);
  if (!title) throw error(404, 'Unknown title');
  if (!env.STRIPE_SECRET_KEY) {
    return json({ message: 'Stripe is not configured' }, { status: 503 });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: body.email,
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
    metadata: {
      titleId: title.id,
      emailCopy: body.emailCopy ? '1' : '0'
    },
    automatic_tax: { enabled: false },
    success_url: `${url.origin}/checkout/success?title=${title.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/book/${title.id}`
  });

  if (!session.url) throw error(502, 'Stripe did not return a checkout URL');
  return json({ url: session.url });
};
