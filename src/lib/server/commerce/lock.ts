import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '$lib/server/db/transaction';

export interface EntitlementScope {
  userId: string;
  titleId: string;
}

function scopeKey(scope: EntitlementScope): string {
  return `pale-orbit:commerce:entitlement:${scope.userId}:${scope.titleId}`;
}

export async function lockEntitlementScopes(
  transaction: DatabaseTransaction,
  scopes: readonly EntitlementScope[]
): Promise<void> {
  const keys = [...new Set(scopes.map(scopeKey))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  for (const key of keys) {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
    );
  }
}
