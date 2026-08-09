import { eq, sql } from 'drizzle-orm';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import { user, userRoles } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import type { createAuthServer } from './options';
import { normalizeEmailAddress } from './identity';

export class UnverifiedBootstrapAccountError extends Error {
  readonly code = 'bootstrap_account_unverified';

  constructor() {
    super('Verify the existing account before granting administrator access');
    this.name = 'UnverifiedBootstrapAccountError';
  }
}

export interface BootstrapFirstAdministratorInput {
  auth: ReturnType<typeof createAuthServer>;
  database: Database;
  email: string;
  name: string;
  password: string;
  correlationId: string;
}

export interface BootstrapFirstAdministratorResult {
  userId: string;
  createdUser: boolean;
  grantedAdmin: boolean;
}

export async function bootstrapFirstAdministrator(
  input: BootstrapFirstAdministratorInput
): Promise<BootstrapFirstAdministratorResult> {
  const email = normalizeEmailAddress(input.email);
  let [target] = await input.database
    .select()
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  let createdUser = false;

  if (!target) {
    const registration = await input.auth.api.signUpEmail({
      body: { email, name: input.name.trim(), password: input.password }
    });
    [target] = await input.database
      .select()
      .from(user)
      .where(eq(user.id, registration.user.id))
      .limit(1);
    if (!target) throw new Error('Bootstrap registration did not create a durable user');
    createdUser = true;
  } else if (!target.emailVerified) {
    throw new UnverifiedBootstrapAccountError();
  }

  const userId = target.id;
  const grantedAdmin = await withTransaction(input.database, async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
    );

    const existingRoles = await transaction
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    const before = existingRoles
      .map((row) => row.role)
      .sort((left, right) => (left === 'customer' ? -1 : right === 'customer' ? 1 : 0));

    if (createdUser) {
      await transaction.update(user).set({ emailVerified: true }).where(eq(user.id, userId));
    }
    await transaction
      .insert(userRoles)
      .values({ userId, role: 'customer' })
      .onConflictDoNothing({ target: [userRoles.userId, userRoles.role] });
    const insertedAdmin = await transaction
      .insert(userRoles)
      .values({ userId, role: 'admin' })
      .onConflictDoNothing({ target: [userRoles.userId, userRoles.role] })
      .returning({ role: userRoles.role });
    const changed = insertedAdmin.length === 1;

    if (changed) {
      await appendAuditEvent(transaction, {
        actor: { type: 'system', id: 'bootstrap-admin' },
        action: 'auth.admin.bootstrapped',
        outcome: 'succeeded',
        resourceType: 'user',
        resourceId: userId,
        correlationId: input.correlationId,
        before,
        after: ['customer', 'admin']
      });
    }
    return changed;
  });

  return { userId, createdUser, grantedAdmin };
}
