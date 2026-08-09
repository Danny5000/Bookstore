import { eq, sql } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import { account, user, userRoles } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { normalizeEmailAddress } from './identity';

export class UnverifiedBootstrapAccountError extends Error {
  readonly code = 'bootstrap_account_unverified';

  constructor() {
    super('Verify the existing account before granting administrator access');
    this.name = 'UnverifiedBootstrapAccountError';
  }
}

export interface BootstrapFirstAdministratorInput {
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
  const passwordHash = await hashPassword(input.password);

  return withTransaction(input.database, async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
    );

    let [target] = await transaction
      .select()
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    let createdUser = false;
    if (!target) {
      [target] = await transaction
        .insert(user)
        .values({ email, name: input.name.trim(), emailVerified: true })
        .returning();
      if (!target) throw new Error('Bootstrap registration did not create a durable user');
      await transaction.insert(account).values({
        accountId: target.id,
        providerId: 'credential',
        userId: target.id,
        password: passwordHash
      });
      createdUser = true;
    } else if (!target.emailVerified) {
      throw new UnverifiedBootstrapAccountError();
    }

    const userId = target.id;
    const existingRoles = await transaction
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    const before = existingRoles
      .map((row) => row.role)
      .sort((left, right) => (left === 'customer' ? -1 : right === 'customer' ? 1 : 0));

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
    return { userId, createdUser, grantedAdmin: changed };
  });
}
