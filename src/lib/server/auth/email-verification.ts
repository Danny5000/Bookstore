import { createHash } from 'node:crypto';
import { eq, inArray, like } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import { user, verification } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { normalizeEmailAddress } from './identity';

const IDENTIFIER_PREFIX = 'pale-orbit:email-verification:';

interface VerificationMarkerV2 {
  version: 2;
  email: string;
}

export interface ConsumedEmailVerification {
  email: string;
}

export function isCommerceClaimVerificationCallback(
  callbackURL: string | undefined,
  trustedOrigin: string
): boolean {
  if (!callbackURL) return false;
  try {
    const destination = new URL(callbackURL, trustedOrigin);
    return destination.origin === trustedOrigin &&
      destination.pathname === '/claim/complete' &&
      destination.search === '' &&
      destination.hash === '';
  } catch {
    return false;
  }
}

function markerValue(marker: VerificationMarkerV2): string {
  return JSON.stringify(marker);
}

function parseMarker(value: string): VerificationMarkerV2 | null {
  try {
    const parsed = JSON.parse(value) as {
      version?: unknown;
      email?: unknown;
      purpose?: unknown;
    };
    if (
      typeof parsed.email === 'string' &&
      (
        parsed.version === 2 ||
        parsed.version === 1 && parsed.purpose === 'account'
      )
    ) {
      return {
        version: 2,
        email: normalizeEmailAddress(parsed.email)
      };
    }
  } catch {
    try {
      return { version: 2, email: normalizeEmailAddress(value) };
    } catch {
      return null;
    }
  }
  return null;
}

function identifierForToken(token: string): string {
  const digest = createHash('sha256').update(token).digest('base64url');
  return `${IDENTIFIER_PREFIX}${digest}`;
}

export async function registerEmailVerificationToken(
  database: Database,
  input: {
    token: string;
    email: string;
    expiresInSeconds: number;
  }
): Promise<boolean> {
  const now = new Date();
  const email = normalizeEmailAddress(input.email);
  return withTransaction(database, async (transaction) => {
    await transaction
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1)
      .for('update');
    const existing = await transaction
      .select({
        identifier: verification.identifier,
        value: verification.value,
        expiresAt: verification.expiresAt
      })
      .from(verification)
      .where(like(verification.identifier, `${IDENTIFIER_PREFIX}%`));
    const newIdentifier = identifierForToken(input.token);
    const replacedIdentifiers = existing
      .filter((row) => {
        if (row.expiresAt.getTime() <= now.getTime()) return true;
        const marker = parseMarker(row.value);
        return marker?.email === email;
      })
      .map((row) => row.identifier);
    if (replacedIdentifiers.length > 0) {
      await transaction
        .delete(verification)
        .where(inArray(verification.identifier, replacedIdentifiers));
    }
    await transaction.insert(verification).values({
      identifier: newIdentifier,
      value: markerValue({ version: 2, email }),
      expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000)
    });
    return true;
  });
}

export async function validateEmailVerificationToken(
  database: Database,
  token: string
): Promise<ConsumedEmailVerification | null> {
  const [pending] = await database
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, identifierForToken(token)))
    .limit(1);
  if (!pending) return null;
  const marker = parseMarker(pending.value);
  if (
    !marker || pending.expiresAt.getTime() <= Date.now()
  ) return null;
  const [target] = await database
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, marker.email))
    .limit(1);
  return target?.emailVerified === false ? marker : null;
}

export async function consumeEmailVerificationToken(
  database: Database,
  token: string
): Promise<ConsumedEmailVerification | null> {
  return withTransaction(database, async (transaction) => {
    const [pending] = await transaction
      .select({ value: verification.value, expiresAt: verification.expiresAt })
      .from(verification)
      .where(eq(verification.identifier, identifierForToken(token)))
      .limit(1)
      .for('update');
    if (!pending) return null;
    const marker = parseMarker(pending.value);
    if (!marker || pending.expiresAt.getTime() <= Date.now()) {
      await transaction
        .delete(verification)
        .where(eq(verification.identifier, identifierForToken(token)));
      return null;
    }
    const [target] = await transaction
      .select({ emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, marker.email))
      .limit(1);
    if (target?.emailVerified !== false) return null;
    await transaction
      .delete(verification)
      .where(eq(verification.identifier, identifierForToken(token)));
    return marker;
  });
}
