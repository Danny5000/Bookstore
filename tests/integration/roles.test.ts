import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { AuthorizationError, type Actor } from '$lib/server/auth/admin-policy';
import {
  LastAdministratorError,
  listUsersWithRoles,
  setAdminRole
} from '$lib/server/auth/roles';
import { auditEvents, user, userRoles } from '$lib/server/db/schema';
import { databaseClient } from './database';

async function createUser(role: 'customer' | 'admin' = 'customer') {
  const [created] = await databaseClient.db
    .insert(user)
    .values({ name: `Reader ${role}`, email: `${randomUUID()}@example.com` })
    .returning();
  if (!created) throw new Error('user insert returned no row');
  await databaseClient.db.insert(userRoles).values({ userId: created.id, role: 'customer' });
  if (role === 'admin') {
    await databaseClient.db.insert(userRoles).values({ userId: created.id, role: 'admin' });
  }
  return created;
}

function adminActor(id: string): Actor {
  return { type: 'user', id, roles: ['customer', 'admin'] };
}

describe('administrator role service', () => {
  it('denies anonymous and customer actors before changing roles', async () => {
    const target = await createUser();
    await expect(
      setAdminRole(databaseClient.db, {
        actor: { type: 'anonymous' },
        targetUserId: target.id,
        enabled: true,
        correlationId: randomUUID()
      })
    ).rejects.toEqual(new AuthorizationError('unauthenticated', 401));
    await expect(
      setAdminRole(databaseClient.db, {
        actor: { type: 'user', id: randomUUID(), roles: ['customer'] },
        targetUserId: target.id,
        enabled: true,
        correlationId: randomUUID()
      })
    ).rejects.toEqual(new AuthorizationError('forbidden', 403));
    expect(
      await databaseClient.db
        .select()
        .from(userRoles)
        .where(and(eq(userRoles.userId, target.id), eq(userRoles.role, 'admin')))
    ).toHaveLength(0);
  });

  it('grants and revokes admin exactly once with audit events', async () => {
    const administrator = await createUser('admin');
    const target = await createUser();
    const actor = adminActor(administrator.id);

    await expect(
      setAdminRole(databaseClient.db, {
        actor,
        targetUserId: target.id,
        enabled: true,
        correlationId: 'grant-admin'
      })
    ).resolves.toEqual(['customer', 'admin']);
    await setAdminRole(databaseClient.db, {
      actor,
      targetUserId: target.id,
      enabled: true,
      correlationId: 'grant-admin-again'
    });
    await expect(
      setAdminRole(databaseClient.db, {
        actor,
        targetUserId: target.id,
        enabled: false,
        correlationId: 'revoke-admin'
      })
    ).resolves.toEqual(['customer']);

    const events = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, target.id));
    expect(events).toHaveLength(2);
    expect(events.map(({ action, before, after }) => ({ action, before, after }))).toEqual([
      {
        action: 'auth.role.granted',
        before: ['customer'],
        after: ['customer', 'admin']
      },
      {
        action: 'auth.role.revoked',
        before: ['customer', 'admin'],
        after: ['customer']
      }
    ]);
  });

  it('rolls back the role mutation when its audit insert fails', async () => {
    const administrator = await createUser('admin');
    const target = await createUser();
    await expect(
      setAdminRole(databaseClient.db, {
        actor: adminActor(administrator.id),
        targetUserId: target.id,
        enabled: true,
        correlationId: null as unknown as string
      })
    ).rejects.toThrow();
    expect(
      await databaseClient.db
        .select()
        .from(userRoles)
        .where(and(eq(userRoles.userId, target.id), eq(userRoles.role, 'admin')))
    ).toHaveLength(0);
    expect(await databaseClient.db.select().from(auditEvents)).toHaveLength(0);
  });

  it('rejects a stale administrator actor after its durable role is revoked', async () => {
    const formerAdministrator = await createUser('admin');
    await createUser('admin');
    const target = await createUser();
    const staleActor = adminActor(formerAdministrator.id);
    await databaseClient.db
      .delete(userRoles)
      .where(
        and(
          eq(userRoles.userId, formerAdministrator.id),
          eq(userRoles.role, 'admin')
        )
      );

    await expect(
      setAdminRole(databaseClient.db, {
        actor: staleActor,
        targetUserId: target.id,
        enabled: true,
        correlationId: 'stale-actor'
      })
    ).rejects.toEqual(new AuthorizationError('forbidden', 403));
    expect(
      await databaseClient.db
        .select()
        .from(userRoles)
        .where(and(eq(userRoles.userId, target.id), eq(userRoles.role, 'admin')))
    ).toHaveLength(0);
  });

  it('protects the final administrator under concurrent demotions', async () => {
    const first = await createUser('admin');
    await expect(
      setAdminRole(databaseClient.db, {
        actor: adminActor(first.id),
        targetUserId: first.id,
        enabled: false,
        correlationId: randomUUID()
      })
    ).rejects.toBeInstanceOf(LastAdministratorError);

    const second = await createUser('admin');
    const results = await Promise.allSettled([
      setAdminRole(databaseClient.db, {
        actor: adminActor(first.id),
        targetUserId: first.id,
        enabled: false,
        correlationId: 'demote-first'
      }),
      setAdminRole(databaseClient.db, {
        actor: adminActor(second.id),
        targetUserId: second.id,
        enabled: false,
        correlationId: 'demote-second'
      })
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await databaseClient.db.select().from(userRoles).where(eq(userRoles.role, 'admin'))
    ).toHaveLength(1);
  });

  it('keeps customer permanent and lists users without N+1 role lookups', async () => {
    const administrator = await createUser('admin');
    const customer = await createUser();
    await expect(
      setAdminRole(databaseClient.db, {
        actor: adminActor(administrator.id),
        targetUserId: customer.id,
        enabled: false,
        correlationId: randomUUID()
      })
    ).resolves.toEqual(['customer']);
    const rows = await listUsersWithRoles(databaseClient.db);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: administrator.id, roles: ['customer', 'admin'] }),
        expect.objectContaining({ id: customer.id, roles: ['customer'] })
      ])
    );
  });
});
