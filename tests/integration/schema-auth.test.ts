import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  account,
  guestIdentities,
  rateLimit,
  session,
  user,
  userRoles,
  verification
} from '$lib/server/db/schema';
import { databaseClient, ownerDatabaseClient } from './database';

async function createUser(email = `${randomUUID()}@example.com`) {
  const [created] = await databaseClient.db
    .insert(user)
    .values({ name: 'Reader', email })
    .returning();
  if (!created) throw new Error('user insert returned no row');
  return created;
}

describe('authentication and identity schema', () => {
  it('stores UUID-backed Better Auth and application identity records', async () => {
    const createdUser = await createUser();
    const [createdSession] = await databaseClient.db
      .insert(session)
      .values({
        expiresAt: new Date(Date.now() + 60_000),
        token: randomUUID(),
        userId: createdUser.id
      })
      .returning();
    const [createdAccount] = await databaseClient.db
      .insert(account)
      .values({
        accountId: createdUser.id,
        providerId: 'credential',
        userId: createdUser.id,
        password: 'test-hash'
      })
      .returning();
    const [createdVerification] = await databaseClient.db
      .insert(verification)
      .values({
        identifier: `verify-email:${createdUser.email}`,
        value: 'opaque',
        expiresAt: new Date(Date.now() + 60_000)
      })
      .returning();
    const [createdRateLimit] = await databaseClient.db
      .insert(rateLimit)
      .values({ key: `test:${randomUUID()}`, count: 1, lastRequest: Date.now() })
      .returning();
    await databaseClient.db.insert(userRoles).values({
      userId: createdUser.id,
      role: 'customer'
    });

    for (const id of [
      createdUser.id,
      createdSession?.id,
      createdAccount?.id,
      createdVerification?.id,
      createdRateLimit?.id
    ]) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('enforces normalized guest email, unique roles, and consistent claim state', async () => {
    const createdUser = await createUser();
    await databaseClient.db.insert(userRoles).values({ userId: createdUser.id, role: 'customer' });

    await expect(
      databaseClient.db.insert(userRoles).values({ userId: createdUser.id, role: 'customer' })
    ).rejects.toThrow();
    await expect(
      ownerDatabaseClient.db.insert(guestIdentities).values({ email: ' Reader@Example.COM ' })
    ).rejects.toThrow();
    await ownerDatabaseClient.db.insert(guestIdentities).values({ email: 'reader@example.com' });
    await expect(
      ownerDatabaseClient.db.insert(guestIdentities).values({ email: 'reader@example.com' })
    ).rejects.toThrow();
    await expect(
      ownerDatabaseClient.db.insert(guestIdentities).values({
        email: 'claimed@example.com',
        claimedByUserId: createdUser.id
      })
    ).rejects.toThrow();
  });

  it('cascades roles but restricts deletion for a claimed guest identity', async () => {
    const roleOnlyUser = await createUser();
    await databaseClient.db.insert(userRoles).values({
      userId: roleOnlyUser.id,
      role: 'customer'
    });
    await databaseClient.db.delete(user).where(eq(user.id, roleOnlyUser.id));
    expect(
      await databaseClient.db.select().from(userRoles).where(eq(userRoles.userId, roleOnlyUser.id))
    ).toHaveLength(0);

    const claimedUser = await createUser();
    await ownerDatabaseClient.db.insert(guestIdentities).values({
      email: 'claimed@example.com',
      claimedByUserId: claimedUser.id,
      claimedAt: new Date()
    });
    await expect(
      databaseClient.db.delete(user).where(eq(user.id, claimedUser.id))
    ).rejects.toThrow();
  });
});
