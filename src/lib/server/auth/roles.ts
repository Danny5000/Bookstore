import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { ApplicationRole } from '$lib/types/auth';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import { user, userRoles } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { requireCapability, type Actor } from './admin-policy';
import { listRolesForUser } from './identity';

export class LastAdministratorError extends Error {
  readonly code = 'last_administrator';

  constructor() {
    super('The final administrator cannot be demoted');
    this.name = 'LastAdministratorError';
  }
}

export class RoleTargetNotFoundError extends Error {
  readonly code = 'role_target_not_found';

  constructor() {
    super('User not found');
    this.name = 'RoleTargetNotFoundError';
  }
}

export interface SetAdminRoleInput {
  actor: Actor;
  targetUserId: string;
  enabled: boolean;
  correlationId: string;
}

export interface UserWithRoles {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  roles: readonly ApplicationRole[];
}

export async function setAdminRole(
  database: Database,
  input: SetAdminRoleInput
): Promise<readonly ApplicationRole[]> {
  const actor = input.actor;
  requireCapability(actor, 'roles.manage');

  return withTransaction(database, async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
    );
    const authorizedActor = {
      type: 'user' as const,
      id: actor.id,
      roles: await listRolesForUser(transaction, actor.id)
    };
    requireCapability(authorizedActor, 'roles.manage');

    const [target] = await transaction
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, input.targetUserId))
      .limit(1);
    if (!target) throw new RoleTargetNotFoundError();

    const before = await listRolesForUser(transaction, target.id);
    let changed = false;

    if (input.enabled) {
      const inserted = await transaction
        .insert(userRoles)
        .values({ userId: target.id, role: 'admin', grantedByUserId: authorizedActor.id })
        .onConflictDoNothing({ target: [userRoles.userId, userRoles.role] })
        .returning({ userId: userRoles.userId });
      changed = inserted.length === 1;
    } else if (before.includes('admin')) {
      const [administratorCount] = await transaction
        .select({ value: count() })
        .from(userRoles)
        .where(eq(userRoles.role, 'admin'));
      if ((administratorCount?.value ?? 0) <= 1) throw new LastAdministratorError();
      const deleted = await transaction
        .delete(userRoles)
        .where(and(eq(userRoles.userId, target.id), eq(userRoles.role, 'admin')))
        .returning({ role: userRoles.role });
      changed = deleted.some((row) => row.role === 'admin');
    }

    const after = await listRolesForUser(transaction, target.id);
    if (changed) {
      await appendAuditEvent(transaction, {
        actor: authorizedActor,
        action: input.enabled ? 'auth.role.granted' : 'auth.role.revoked',
        outcome: 'succeeded',
        resourceType: 'user',
        resourceId: target.id,
        correlationId: input.correlationId,
        before: [...before],
        after: [...after]
      });
    }
    return after;
  });
}

export async function listUsersWithRoles(database: Database): Promise<UserWithRoles[]> {
  const users = await database
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt
    })
    .from(user)
    .orderBy(asc(user.createdAt), asc(user.id));
  const roleRows = await database.select().from(userRoles);
  const rolesByUser = new Map<string, Set<ApplicationRole>>();
  for (const row of roleRows) {
    const roles = rolesByUser.get(row.userId) ?? new Set<ApplicationRole>();
    roles.add(row.role);
    rolesByUser.set(row.userId, roles);
  }
  return users.map((entry) => ({
    ...entry,
    roles: rolesByUser.get(entry.id)?.has('admin') ? ['customer', 'admin'] : ['customer']
  }));
}
