import { json, error } from '@sveltejs/kit';
import { entitlementsFor } from '$lib/server/db.js';
import { sendBookEmail } from '$lib/server/mail.js';

/**
 * Re-deliver a purchased file: { titleId, channel: 'email' | 'download' }.
 * Guard it with the session — only owners get the file.
 */
export async function POST({ request, locals }) {
  const { titleId, channel } = await request.json();
  const email = locals.user?.email;

  if (!email) throw error(401, 'Sign in first');

  const owned = await entitlementsFor(email);
  if (!owned.includes(titleId)) throw error(403, 'Not in your library');

  if (channel === 'email') {
    await sendBookEmail({ email, titleId });
    return json({ ok: true, sent: true });
  }

  // For downloads, issue a short-lived signed URL to object storage rather
  // than streaming the file from the app server.
  return json({ ok: true, url: `/files/${titleId}.epub?token=…` });
}
