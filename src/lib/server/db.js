/**
 * Persistence seam. Swap the in-memory maps for your real database
 * (Postgres + Drizzle/Prisma, Turso, Supabase...). Every server route in this
 * project talks to the store through these four functions only.
 *
 * Suggested schema
 * ----------------
 * users      (id, email unique, created_at)
 * titles     (id, kind, title, author, price_cents, summary, released, cover, published)
 * chapters   (id, title_id, idx, heading, body)          -- novels
 * pages      (id, title_id, idx, image_url, panels_json) -- comics
 * purchases  (id, user_id, title_id, stripe_session_id unique, amount_cents, created_at)
 * progress   (user_id, title_id, sheet, updated_at, primary key (user_id, title_id))
 * bookmarks  (user_id, title_id, sheet)
 */

const purchases = new Map(); // email -> Set(titleId)

export async function grantPurchase({ email, titleId, amount, stripeSessionId }) {
  if (!email || !titleId) return;
  const set = purchases.get(email) ?? new Set();
  set.add(titleId);
  purchases.set(email, set);
  console.log('[db] granted', { email, titleId, amount, stripeSessionId });
}

export async function entitlementsFor(email) {
  return [...(purchases.get(email) ?? [])];
}

export async function saveProgress({ email, titleId, sheet }) {
  console.log('[db] progress', { email, titleId, sheet });
}

export async function progressFor(email) {
  return {};
}
