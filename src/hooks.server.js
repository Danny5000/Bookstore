/**
 * Session hook. Replace the cookie read with your auth library's session
 * lookup (Lucia, Auth.js, Supabase). Everything downstream expects
 * `locals.user = { email } | null`.
 */
export async function handle({ event, resolve }) {
  const email = event.cookies.get('po_session') || null;
  event.locals.user = email ? { email } : null;
  return resolve(event);
}
