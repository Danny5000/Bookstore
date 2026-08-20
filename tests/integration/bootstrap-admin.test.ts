import { randomUUID } from 'node:crypto';
import { verifyPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  UnverifiedBootstrapAccountError,
  bootstrapFirstAdministrator
} from '$lib/server/auth/bootstrap-admin';
import { createAuthServer } from '$lib/server/auth/options';
import {
  account,
  auditEvents,
  credentialAuthority,
  outboxMessages,
  user,
  userRoles
} from '$lib/server/db/schema';
import { applicationConfig, databaseClient, ownerDatabaseClient } from './database';

async function createExistingUser(emailVerified: boolean) {
  const [created] = await databaseClient.db
    .insert(user)
    .values({ name: 'Existing Owner', email: `${randomUUID()}@example.com`, emailVerified })
    .returning();
  if (!created) throw new Error('user insert returned no row');
  await databaseClient.db.insert(account).values({
    accountId: created.id,
    providerId: 'credential',
    userId: created.id,
    password: 'existing-password-hash'
  });
  await databaseClient.db.insert(credentialAuthority).values({
    userId: created.id,
    authorizedPasswordHash: 'existing-password-hash'
  });
  return created;
}

describe('bootstrapFirstAdministrator', () => {
  it('creates one verified credential administrator without sending mail', async () => {
    const result = await bootstrapFirstAdministrator({
      database: databaseClient.db,
      email: '  OWNER@Example.COM ',
      name: 'First Owner',
      password: 'A-secure-bootstrap-password',
      correlationId: 'bootstrap-first'
    });

    expect(result).toEqual({
      userId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      createdUser: true,
      grantedAdmin: true
    });
    expect(await databaseClient.db.select().from(user)).toEqual([
      expect.objectContaining({ id: result.userId, email: 'owner@example.com', emailVerified: true })
    ]);
    const [credentialAccount] = await databaseClient.db.select().from(account);
    expect(credentialAccount).toEqual(
      expect.objectContaining({ userId: result.userId, providerId: 'credential' })
    );
    expect(
      await verifyPassword({
        hash: credentialAccount?.password ?? '',
        password: 'A-secure-bootstrap-password'
      })
    ).toBe(true);
    expect(
      await databaseClient.db
        .select({ userId: credentialAuthority.userId })
        .from(credentialAuthority)
    ).toEqual([{ userId: result.userId }]);
    const auth = createAuthServer({
      database: databaseClient.db,
      config: applicationConfig,
      queueVerificationEmail: async () => undefined,
      queueResetEmail: async () => undefined,
      queueMagicEmail: async () => undefined,
      queueCommerceClaimEmail: async () => undefined,
      canSendMagicLink: async () => true,
      canSendCommerceMagicLink: async () => true,
      onUserCreated: async () => undefined
    });
    const signedIn = await auth.handler(new Request(
      `${applicationConfig.origin}/api/auth/sign-in/email`,
      {
        method: 'POST',
        headers: {
          origin: applicationConfig.origin,
          'content-type': 'application/json',
          'x-forwarded-for': '192.0.2.150'
        },
        body: JSON.stringify({
          email: 'owner@example.com',
          password: 'A-secure-bootstrap-password'
        })
      }
    ));
    expect(signedIn.status).toBe(200);
    expect(
      await databaseClient.db.select().from(userRoles).where(eq(userRoles.userId, result.userId))
    ).toEqual([
      expect.objectContaining({ role: 'customer' }),
      expect.objectContaining({ role: 'admin' })
    ]);
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(0);

    const [event] = await databaseClient.db.select().from(auditEvents);
    expect(event).toMatchObject({
      actorType: 'system',
      actorId: 'bootstrap-admin',
      action: 'auth.admin.bootstrapped',
      resourceType: 'user',
      resourceId: result.userId,
      correlationId: 'bootstrap-first',
      before: [],
      after: ['customer', 'admin']
    });
    expect(JSON.stringify({ before: event?.before, after: event?.after })).not.toMatch(
      /email|password|token/i
    );
  });

  it('adds missing roles to a verified account without changing its password', async () => {
    const existing = await createExistingUser(true);
    const [beforeAccount] = await databaseClient.db
      .select()
      .from(account)
      .where(eq(account.userId, existing.id));
    const result = await bootstrapFirstAdministrator({
      database: databaseClient.db,
      email: existing.email,
      name: 'Ignored Name',
      password: 'A-different-bootstrap-password',
      correlationId: 'bootstrap-existing'
    });
    const [afterAccount] = await databaseClient.db
      .select()
      .from(account)
      .where(eq(account.userId, existing.id));
    expect(result).toEqual({ userId: existing.id, createdUser: false, grantedAdmin: true });
    expect(afterAccount?.password === beforeAccount?.password).toBe(true);
    expect(
      await databaseClient.db.select().from(userRoles).where(eq(userRoles.userId, existing.id))
    ).toHaveLength(2);
  });

  it('refuses a pre-existing unverified account without granting roles', async () => {
    const existing = await createExistingUser(false);
    await expect(
      bootstrapFirstAdministrator({
        database: databaseClient.db,
        email: existing.email,
        name: existing.name,
        password: 'A-secure-bootstrap-password',
        correlationId: randomUUID()
      })
    ).rejects.toEqual(new UnverifiedBootstrapAccountError());
    expect(
      await databaseClient.db.select().from(userRoles).where(eq(userRoles.userId, existing.id))
    ).toHaveLength(0);
  });

  it('is idempotent and does not append a duplicate success event', async () => {
    const input = {
      database: databaseClient.db,
      email: 'idempotent@example.com',
      name: 'Idempotent Owner',
      password: 'A-secure-bootstrap-password',
      correlationId: 'bootstrap-idempotent'
    };
    const first = await bootstrapFirstAdministrator(input);
    const second = await bootstrapFirstAdministrator(input);
    expect(second).toEqual({ userId: first.userId, createdUser: false, grantedAdmin: false });
    expect(
      await databaseClient.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'auth.admin.bootstrapped'))
    ).toHaveLength(1);
  });

  it('rolls back account creation when audit fails and allows a clean retry', async () => {
    const input = {
      database: databaseClient.db,
      email: 'rollback@example.com',
      name: 'Rollback Owner',
      password: 'A-secure-bootstrap-password'
    };
    await expect(
      bootstrapFirstAdministrator({
        ...input,
        correlationId: null as unknown as string
      })
    ).rejects.toThrow();
    expect(
      await databaseClient.db.select().from(user).where(eq(user.email, 'rollback@example.com'))
    ).toHaveLength(0);
    expect(await databaseClient.db.select().from(account)).toHaveLength(0);
    expect(await databaseClient.db.select().from(userRoles)).toHaveLength(0);
    expect(await databaseClient.db.select().from(auditEvents)).toHaveLength(0);

    await expect(
      bootstrapFirstAdministrator({ ...input, correlationId: 'bootstrap-retry' })
    ).resolves.toMatchObject({ createdUser: true, grantedAdmin: true });
  });
});
