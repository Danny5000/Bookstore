import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplicationRole } from '$lib/types/auth';
import type { Actor } from './admin-policy';
import {
  account,
  guestIdentities,
  user,
  userRoles,
  type GuestIdentityRow
} from '$lib/server/db/schema';
import type { Database } from '$lib/server/db/client';
import type { DatabaseExecutor } from '$lib/server/db/transaction';

const emailAddressSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.email());

export function normalizeEmailAddress(value: string): string {
  const result = emailAddressSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid email address');
  return result.data;
}

export async function ensureCustomerRole(
  database: DatabaseExecutor,
  userId: string
): Promise<void> {
  await database
    .insert(userRoles)
    .values({ userId, role: 'customer' })
    .onConflictDoNothing({ target: [userRoles.userId, userRoles.role] });
}

export async function listRolesForUser(
  database: DatabaseExecutor,
  userId: string
): Promise<readonly ApplicationRole[]> {
  const rows = await database
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  const assigned = new Set(rows.map((row) => row.role));
  return assigned.has('admin') ? ['customer', 'admin'] : ['customer'];
}

export async function actorForUser(
  database: Database,
  userId: string
): Promise<Extract<Actor, { type: 'user' }>> {
  await ensureCustomerRole(database, userId);
  return { type: 'user', id: userId, roles: await listRolesForUser(database, userId) };
}

export async function findOrCreateGuestIdentity(
  database: DatabaseExecutor,
  email: string
): Promise<GuestIdentityRow> {
  const normalizedEmail = normalizeEmailAddress(email);
  const [identity] = await database
    .insert(guestIdentities)
    .values({ email: normalizedEmail })
    .onConflictDoUpdate({
      target: guestIdentities.email,
      set: { updatedAt: sql`${guestIdentities.updatedAt}` }
    })
    .returning();
  if (!identity) throw new Error('Guest identity upsert returned no row');
  return identity;
}

export async function canSendMagicLink(database: Database, email: string): Promise<boolean> {
  const normalizedEmail = normalizeEmailAddress(email);
  const [existingUser] = await database
    .select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, normalizedEmail))
    .limit(1);

  if (!existingUser || existingUser.emailVerified) return true;

  const [credentialAccount] = await database
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, existingUser.id), eq(account.providerId, 'credential')))
    .limit(1);
  return credentialAccount === undefined;
}
