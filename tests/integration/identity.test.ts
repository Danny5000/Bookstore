import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  actorForUser,
  canSendMagicLink,
  ensureCustomerRole,
  findOrCreateGuestIdentity
} from '$lib/server/auth/identity';
import { account, guestIdentities, user, userRoles } from '$lib/server/db/schema';
import { databaseClient, ownerDatabaseClient } from './database';

async function createUser(email: string, emailVerified = false) {
  const [created] = await databaseClient.db
    .insert(user)
    .values({ name: 'Reader', email, emailVerified })
    .returning();
  if (!created) throw new Error('user insert returned no row');
  return created;
}

describe('application identities', () => {
  it('ensures and repairs the customer role idempotently', async () => {
    const created = await createUser(`${randomUUID()}@example.com`);

    await ensureCustomerRole(databaseClient.db, created.id);
    await ensureCustomerRole(databaseClient.db, created.id);
    expect(
      await databaseClient.db.select().from(userRoles).where(eq(userRoles.userId, created.id))
    ).toHaveLength(1);

    await databaseClient.db.delete(userRoles).where(eq(userRoles.userId, created.id));
    expect(await actorForUser(databaseClient.db, created.id)).toEqual({
      type: 'user',
      id: created.id,
      roles: ['customer']
    });
    expect(
      await databaseClient.db.select().from(userRoles).where(eq(userRoles.userId, created.id))
    ).toHaveLength(1);
  });

  it('finds or creates one guest identity without changing claim state', async () => {
    const [first, second] = await Promise.all([
      findOrCreateGuestIdentity(databaseClient.db, ' Guest@Example.COM '),
      findOrCreateGuestIdentity(databaseClient.db, 'guest@example.com')
    ]);
    expect(first.id).toBe(second.id);

    const claimedUser = await createUser(`${randomUUID()}@example.com`, true);
    await ownerDatabaseClient.db
      .update(guestIdentities)
      .set({ claimedByUserId: claimedUser.id, claimedAt: new Date() })
      .where(eq(guestIdentities.id, first.id));
    const found = await findOrCreateGuestIdentity(databaseClient.db, 'guest@example.com');
    expect(found.claimedByUserId).toBe(claimedUser.id);
    expect(found.claimedAt).toBeInstanceOf(Date);
  });

  it('suppresses magic links only for unverified credential users', async () => {
    const unverified = await createUser('unverified@example.com');
    await databaseClient.db.insert(account).values({
      accountId: unverified.id,
      providerId: 'credential',
      userId: unverified.id,
      password: 'hash'
    });
    const verified = await createUser('verified@example.com', true);
    await databaseClient.db.insert(account).values({
      accountId: verified.id,
      providerId: 'credential',
      userId: verified.id,
      password: 'hash'
    });

    await expect(canSendMagicLink(databaseClient.db, unverified.email)).resolves.toBe(false);
    await expect(canSendMagicLink(databaseClient.db, verified.email)).resolves.toBe(true);
    await expect(canSendMagicLink(databaseClient.db, 'unknown@example.com')).resolves.toBe(true);
  });
});
