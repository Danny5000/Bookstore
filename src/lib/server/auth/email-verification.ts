import { createHash } from 'node:crypto';
import { and, eq, like, lte } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import { user, verification } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { normalizeEmailAddress } from './identity';

const IDENTIFIER_PREFIX = 'pale-orbit:email-verification:';

function identifierForToken(token: string): string {
  const digest = createHash('sha256').update(token).digest('base64url');
  return `${IDENTIFIER_PREFIX}${digest}`;
}

export async function registerEmailVerificationToken(
  database: Database,
  input: { token: string; email: string; expiresInSeconds: number }
): Promise<void> {
  const now = new Date();
  await withTransaction(database, async (transaction) => {
    await transaction
      .delete(verification)
      .where(
        and(
          like(verification.identifier, `${IDENTIFIER_PREFIX}%`),
          lte(verification.expiresAt, now)
        )
      );
    await transaction.insert(verification).values({
      identifier: identifierForToken(input.token),
      value: normalizeEmailAddress(input.email),
      expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000)
    });
  });
}

export async function consumeEmailVerificationToken(
  database: Database,
  token: string
): Promise<boolean> {
  return withTransaction(database, async (transaction) => {
    const [pending] = await transaction
      .delete(verification)
      .where(eq(verification.identifier, identifierForToken(token)))
      .returning({ email: verification.value, expiresAt: verification.expiresAt });
    if (!pending || pending.expiresAt.getTime() <= Date.now()) return false;

    const [target] = await transaction
      .select({ emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, pending.email))
      .limit(1);
    return target?.emailVerified === false;
  });
}
