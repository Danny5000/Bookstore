import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  UnverifiedBootstrapAccountError,
  bootstrapFirstAdministrator
} from '$lib/server/auth/bootstrap-admin';
import { createAuthServer } from '$lib/server/auth/options';
import { loadApplicationConfig } from '$lib/server/config/load';
import { account, auditEvents, outboxMessages, user, userRoles } from '$lib/server/db/schema';
import { databaseClient } from './database';

const config = loadApplicationConfig(process.env);

function createBootstrapAuth() {
  return createAuthServer({
    database: databaseClient.db,
    config,
    queueVerificationEmail: async () => undefined,
    queueResetEmail: async () => undefined,
    queueMagicEmail: async () => undefined,
    canSendMagicLink: async () => true,
    onUserCreated: async () => undefined
  });
}

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
  return created;
}

describe('bootstrapFirstAdministrator', () => {
  it('creates one verified credential administrator without sending mail', async () => {
    const auth = createBootstrapAuth();
    const result = await bootstrapFirstAdministrator({
      auth,
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
    expect(await databaseClient.db.select().from(account)).toEqual([
      expect.objectContaining({ userId: result.userId, providerId: 'credential' })
    ]);
    expect(
      await databaseClient.db.select().from(userRoles).where(eq(userRoles.userId, result.userId))
    ).toEqual([
      expect.objectContaining({ role: 'customer' }),
      expect.objectContaining({ role: 'admin' })
    ]);
    expect(await databaseClient.db.select().from(outboxMessages)).toHaveLength(0);

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
      auth: createBootstrapAuth(),
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
        auth: createBootstrapAuth(),
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
      auth: createBootstrapAuth(),
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

  it('keeps a separately created user but rolls back role grants when audit fails', async () => {
    await expect(
      bootstrapFirstAdministrator({
        auth: createBootstrapAuth(),
        database: databaseClient.db,
        email: 'rollback@example.com',
        name: 'Rollback Owner',
        password: 'A-secure-bootstrap-password',
        correlationId: null as unknown as string
      })
    ).rejects.toThrow();
    const [created] = await databaseClient.db
      .select()
      .from(user)
      .where(eq(user.email, 'rollback@example.com'));
    expect(created).toBeDefined();
    expect(created?.emailVerified).toBe(false);
    expect(
      await databaseClient.db
        .select()
        .from(userRoles)
        .where(
          and(
            eq(userRoles.userId, created?.id ?? '00000000-0000-0000-0000-000000000000'),
            eq(userRoles.role, 'admin')
          )
        )
    ).toHaveLength(0);
    expect(await databaseClient.db.select().from(auditEvents)).toHaveLength(0);
  });
});
