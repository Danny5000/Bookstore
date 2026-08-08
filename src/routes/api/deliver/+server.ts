import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { entitlementsFor } from '$lib/server/prototype-db';
import { sendBookEmail } from '$lib/server/mail';
import { parseDeliveryRequest } from '$lib/types/api';

export const POST: RequestHandler = async ({ request, locals }) => {
  const raw: unknown = await request.json();
  const body = parseDeliveryRequest(raw);
  if (!body) throw error(400, 'Invalid delivery request');

  const email = locals.user?.email;
  if (!email) throw error(401, 'Sign in first');

  const owned = await entitlementsFor(email);
  if (!owned.includes(body.titleId)) throw error(403, 'Not in your library');

  if (body.channel === 'email') {
    await sendBookEmail({ email, titleId: body.titleId });
    return json({ ok: true, sent: true });
  }

  return json({
    ok: true,
    url: `/files/${body.titleId}.epub?token=…`
  });
};
