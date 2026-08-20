import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { and, asc, eq, inArray, like, ne } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import {
  account,
  credentialAuthority,
  session,
  user,
  verification
} from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { withTransaction } from '$lib/server/db/transaction';
import { normalizeEmailAddress } from './identity';

const MAGIC_LINK_PREFIX = 'pale-orbit:auth-magic:';
const RESET_TOKEN_PREFIX = 'pale-orbit:auth-password-reset:';
const EMAIL_VERIFICATION_PREFIX = 'pale-orbit:email-verification:';
const BETTER_AUTH_RESET_PREFIX = 'reset-password:';

export type AuthMagicLinkPurpose = 'account' | 'commerce-claim';
export type PasswordResetPurpose = 'account' | 'commerce-claim';

interface PasswordResetMarkerV3 {
  version: 3;
  email: string;
  userId: string;
  purpose: PasswordResetPurpose;
  appliedPasswordHashSha256: string | null;
}

interface MagicLinkMarkerV2 {
  version: 2;
  email: string;
  purpose: AuthMagicLinkPurpose;
  credentialDigest: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function credentialDigest(password: string | null | undefined, exists: boolean): string {
  return sha256Hex(exists ? `credential\0${password ?? ''}` : 'no-credential');
}

function identifier(prefix: string, token: string): string {
  return `${prefix}${digest(token)}`;
}

function resetIdentifierForEpoch(epochSha256: string): string | null {
  if (!/^[a-f0-9]{64}$/u.test(epochSha256)) return null;
  return `${RESET_TOKEN_PREFIX}${Buffer.from(epochSha256, 'hex').toString('base64url')}`;
}

function markerEmail(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as { email?: unknown };
    return typeof parsed.email === 'string' ? normalizeEmailAddress(parsed.email) : null;
  } catch {
    try {
      return normalizeEmailAddress(value);
    } catch {
      return null;
    }
  }
}

function passwordResetMarker(
  email: string,
  userId: string,
  purpose: PasswordResetPurpose,
  appliedPasswordHashSha256: string | null = null
): string {
  return JSON.stringify({
    version: 3,
    email: normalizeEmailAddress(email),
    userId: userId.toLowerCase(),
    purpose,
    appliedPasswordHashSha256
  } satisfies PasswordResetMarkerV3);
}

function parsePasswordResetMarker(value: string): PasswordResetMarkerV3 | null {
  try {
    const parsed = JSON.parse(value) as Partial<PasswordResetMarkerV3>;
    if (
      parsed.version !== 3 ||
      typeof parsed.email !== 'string' ||
      typeof parsed.userId !== 'string' ||
      (parsed.purpose !== 'account' && parsed.purpose !== 'commerce-claim') ||
      !(
        parsed.appliedPasswordHashSha256 === null ||
        typeof parsed.appliedPasswordHashSha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(parsed.appliedPasswordHashSha256)
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(parsed.userId)
    ) return null;
    return {
      version: 3,
      email: normalizeEmailAddress(parsed.email),
      userId: parsed.userId.toLowerCase(),
      purpose: parsed.purpose,
      appliedPasswordHashSha256: parsed.appliedPasswordHashSha256
    };
  } catch {
    return null;
  }
}

function magicLinkMarker(
  email: string,
  purpose: AuthMagicLinkPurpose,
  credentialDigest: string
): string {
  return JSON.stringify({
    version: 2,
    email: normalizeEmailAddress(email),
    purpose,
    credentialDigest
  } satisfies MagicLinkMarkerV2);
}

function parseMagicLinkMarker(value: string): MagicLinkMarkerV2 | null {
  try {
    const parsed = JSON.parse(value) as Partial<MagicLinkMarkerV2>;
    if (
      parsed.version !== 2 ||
      typeof parsed.email !== 'string' ||
      (parsed.purpose !== 'account' && parsed.purpose !== 'commerce-claim') ||
      typeof parsed.credentialDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(parsed.credentialDigest)
    ) return null;
    return {
      version: 2,
      email: normalizeEmailAddress(parsed.email),
      purpose: parsed.purpose,
      credentialDigest: parsed.credentialDigest
    };
  } catch {
    return null;
  }
}

async function removeExpiredProjectMarkers(
  database: DatabaseExecutor,
  now: Date
): Promise<void> {
  const expired = await database
    .select({ identifier: verification.identifier, expiresAt: verification.expiresAt })
    .from(verification)
    .where(like(verification.identifier, 'pale-orbit:%'));
  const identifiers = expired
    .filter((row) => row.expiresAt.getTime() <= now.getTime())
    .map((row) => row.identifier);
  if (identifiers.length > 0) {
    await database.delete(verification).where(inArray(verification.identifier, identifiers));
  }
}

async function deleteEmailMarkers(
  database: DatabaseExecutor,
  prefix: string,
  email: string
): Promise<void> {
  const rows = await database
    .select({ identifier: verification.identifier, value: verification.value })
    .from(verification)
    .where(like(verification.identifier, `${prefix}%`));
  const identifiers = rows
    .filter((row) => markerEmail(row.value) === email)
    .map((row) => row.identifier);
  if (identifiers.length > 0) {
    await database.delete(verification).where(inArray(verification.identifier, identifiers));
  }
}

/** Establishes authority only for a newly persisted ordinary credential. */
export async function establishCredentialAuthority(
  database: Database,
  input: { userId: string; now?: Date }
): Promise<void> {
  const userId = input.userId.toLowerCase();
  const now = input.now ?? new Date();
  return withTransaction(database, async (transaction) => {
    const [lockedUser] = await transaction
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
      .for('update');
    if (!lockedUser) throw new Error('Credential user does not exist');
    const credentials = await transaction
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
      .orderBy(asc(account.id))
      .limit(2)
      .for('update');
    if (credentials.length !== 1 || !credentials[0]?.password) {
      throw new Error('Credential authority requires exactly one password credential');
    }
    const [authority] = await transaction
      .select()
      .from(credentialAuthority)
      .where(eq(credentialAuthority.userId, userId))
      .limit(1)
      .for('update');
    if (!authority) {
      await transaction.insert(credentialAuthority).values({
        userId,
        authorizedPasswordHash: credentials[0].password,
        resetEpochSha256: null,
        createdAt: now,
        updatedAt: now
      });
      return;
    }
    if (
      authority.resetEpochSha256 !== null ||
      authority.authorizedPasswordHash !== credentials[0].password
    ) {
      throw new Error('Credential authority already exists with a different generation');
    }
  });
}

export async function registerPasswordResetToken(
  database: Database,
  input: {
    token: string;
    email: string;
    userId: string;
    purpose: PasswordResetPurpose;
    expiresInSeconds: number;
    now?: Date;
  }
): Promise<boolean> {
  const now = input.now ?? new Date();
  const email = normalizeEmailAddress(input.email);
  const userId = input.userId.toLowerCase();
  const epoch = sha256Hex(input.token);
  const nativeIdentifier = `${BETTER_AUTH_RESET_PREFIX}${input.token}`;
  await withTransaction(database, (transaction) =>
    removeExpiredProjectMarkers(transaction, now)
  );
  return withTransaction(database, async (transaction) => {
    const [lockedUser] = await transaction
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
      .for('update');
    if (!lockedUser || normalizeEmailAddress(lockedUser.email) !== email) {
      return false;
    }
    const [nativeToken] = await transaction
      .select({ value: verification.value, expiresAt: verification.expiresAt })
      .from(verification)
      .where(eq(verification.identifier, nativeIdentifier))
      .limit(1)
      .for('update');
    if (
      !nativeToken ||
      nativeToken.value !== userId ||
      nativeToken.expiresAt.getTime() <= now.getTime()
    ) return false;
    const credentials = await transaction
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
      .orderBy(asc(account.id))
      .limit(2)
      .for('update');
    if (credentials.length > 1) throw new Error('Ambiguous credential state');
    const [authority] = await transaction
      .select()
      .from(credentialAuthority)
      .where(eq(credentialAuthority.userId, userId))
      .limit(1)
      .for('update');
    if (authority) {
      await transaction
        .update(credentialAuthority)
        .set({ resetEpochSha256: epoch, updatedAt: now })
        .where(eq(credentialAuthority.userId, userId));
    } else {
      await transaction.insert(credentialAuthority).values({
        userId,
        // Missing authority is never repaired by trusting the live account hash.
        // A successful mailbox reset establishes a fresh authorized generation.
        authorizedPasswordHash: null,
        resetEpochSha256: epoch,
        createdAt: now,
        updatedAt: now
      });
    }
    await transaction.delete(verification).where(and(
      like(verification.identifier, `${BETTER_AUTH_RESET_PREFIX}%`),
      eq(verification.value, userId),
      ne(verification.identifier, `${BETTER_AUTH_RESET_PREFIX}${input.token}`)
    ));
    await transaction.insert(verification).values({
      identifier: identifier(RESET_TOKEN_PREFIX, input.token),
      value: passwordResetMarker(email, userId, input.purpose),
      expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000)
    });
    return true;
  });
}

export async function applyCurrentPasswordResetCredential(
  database: Database,
  input: { token: string; passwordHash: string; now?: Date }
): Promise<boolean> {
  if (!input.token || input.token.length > 256 || !input.passwordHash) return false;
  const now = input.now ?? new Date();
  const resetIdentifier = identifier(RESET_TOKEN_PREFIX, input.token);
  const [candidate] = await database
    .select({ value: verification.value })
    .from(verification)
    .where(eq(verification.identifier, resetIdentifier))
    .limit(1);
  const parsedCandidate = candidate ? parsePasswordResetMarker(candidate.value) : null;
  if (!parsedCandidate) return false;

  return withTransaction(database, async (transaction) => {
    const [lockedUser] = await transaction
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(eq(user.id, parsedCandidate.userId))
      .limit(1)
      .for('update');
    const [authority] = await transaction
      .select()
      .from(credentialAuthority)
      .where(eq(credentialAuthority.userId, parsedCandidate.userId))
      .limit(1)
      .for('update');
    const [pending] = await transaction
      .select({ value: verification.value, expiresAt: verification.expiresAt })
      .from(verification)
      .where(eq(verification.identifier, resetIdentifier))
      .limit(1)
      .for('update');
    const parsed = pending ? parsePasswordResetMarker(pending.value) : null;
    if (
      !lockedUser ||
      !authority ||
      !pending ||
      !parsed ||
      pending.expiresAt.getTime() <= now.getTime() ||
      parsed.userId !== parsedCandidate.userId ||
      parsed.email !== normalizeEmailAddress(lockedUser.email) ||
      authority.resetEpochSha256 !== sha256Hex(input.token)
    ) return false;

    const credentials = await transaction
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, parsed.userId), eq(account.providerId, 'credential')))
      .orderBy(asc(account.id))
      .limit(2)
      .for('update');
    if (credentials.length > 1) return false;
    if (credentials[0]) {
      await transaction
        .update(account)
        .set({ password: input.passwordHash, updatedAt: now })
        .where(eq(account.id, credentials[0].id));
    } else {
      await transaction.insert(account).values({
        accountId: parsed.userId,
        providerId: 'credential',
        userId: parsed.userId,
        password: input.passwordHash,
        createdAt: now,
        updatedAt: now
      });
    }
    await transaction
      .update(verification)
      .set({
        value: passwordResetMarker(
          parsed.email,
          parsed.userId,
          parsed.purpose,
          sha256Hex(input.passwordHash)
        ),
        updatedAt: now
      })
      .where(eq(verification.identifier, resetIdentifier));
    return true;
  });
}

export interface PasswordResetSecurityCompletion {
  completed: boolean;
  purpose: PasswordResetPurpose | null;
}

export async function completePasswordResetSecurity(
  database: Database,
  input: { token: string; userId: string; email: string; now?: Date }
): Promise<PasswordResetSecurityCompletion> {
  const now = input.now ?? new Date();
  const email = normalizeEmailAddress(input.email);
  const userId = input.userId.toLowerCase();
  const resetIdentifier = identifier(RESET_TOKEN_PREFIX, input.token);
  return withTransaction(database, async (transaction) => {
    const [lockedUser] = await transaction
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
      .for('update');
    const [authority] = await transaction
      .select()
      .from(credentialAuthority)
      .where(eq(credentialAuthority.userId, userId))
      .limit(1)
      .for('update');
    const [pending] = await transaction
      .select({ value: verification.value, expiresAt: verification.expiresAt })
      .from(verification)
      .where(eq(verification.identifier, resetIdentifier))
      .limit(1)
      .for('update');
    const parsed = pending ? parsePasswordResetMarker(pending.value) : null;
    const markerIsCurrent = Boolean(
      lockedUser &&
      authority &&
      pending &&
      parsed &&
      pending.expiresAt.getTime() > now.getTime() &&
      parsed.userId === userId &&
      parsed.email === email &&
      normalizeEmailAddress(lockedUser.email) === email &&
      authority.resetEpochSha256 === sha256Hex(input.token) &&
      parsed.appliedPasswordHashSha256
    );
    const credentials = await transaction
      .select({ id: account.id, password: account.password })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
      .orderBy(asc(account.id))
      .limit(2)
      .for('update');

    const currentCredential = credentials[0];
    const currentMatchesApplied = Boolean(
      currentCredential?.password &&
      parsed?.appliedPasswordHashSha256 &&
      sha256Hex(currentCredential.password) === parsed.appliedPasswordHashSha256
    );
    if (!markerIsCurrent || credentials.length !== 1 || !currentMatchesApplied) {
      // Roll back only the exact credential generation written by this reset.
      // A newer reset may already have replaced it while this request was paused.
      if (authority && credentials.length === 1 && currentCredential && currentMatchesApplied) {
        if (authority.authorizedPasswordHash) {
          await transaction
            .update(account)
            .set({ password: authority.authorizedPasswordHash, updatedAt: now })
            .where(eq(account.id, currentCredential.id));
        } else {
          await transaction.delete(account).where(eq(account.id, currentCredential.id));
        }
      }
      await transaction.delete(session).where(eq(session.userId, userId));
      await transaction.delete(verification).where(eq(verification.identifier, resetIdentifier));
      return { completed: false, purpose: null };
    }

    const purpose = parsed?.purpose ?? 'account';
    const authorizedPasswordHash = currentCredential?.password;
    if (!authorizedPasswordHash) {
      throw new Error('Validated password reset lost its applied credential');
    }
    await transaction
      .update(credentialAuthority)
      .set({
        authorizedPasswordHash,
        resetEpochSha256: null,
        updatedAt: now
      })
      .where(eq(credentialAuthority.userId, userId));
    await deleteEmailMarkers(transaction, RESET_TOKEN_PREFIX, email);
    await deleteEmailMarkers(transaction, MAGIC_LINK_PREFIX, email);
    await transaction.delete(verification).where(and(
      like(verification.identifier, `${BETTER_AUTH_RESET_PREFIX}%`),
      eq(verification.value, userId)
    ));
    if (purpose === 'commerce-claim') {
      await deleteEmailMarkers(transaction, EMAIL_VERIFICATION_PREFIX, email);
      await transaction
        .update(user)
        .set({ emailVerified: true, updatedAt: now })
        .where(eq(user.id, userId));
    }
    return { completed: true, purpose };
  });
}

export async function registerAuthMagicLinkToken(
  database: Database,
  input: {
    token: string;
    email: string;
    purpose: AuthMagicLinkPurpose;
    expiresInSeconds: number;
    now?: Date;
  }
): Promise<boolean> {
  const now = input.now ?? new Date();
  const email = normalizeEmailAddress(input.email);
  await withTransaction(database, (transaction) =>
    removeExpiredProjectMarkers(transaction, now)
  );
  return withTransaction(database, async (transaction) => {
    const [matchingUser] = await transaction
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1)
      .for('update');
    let generation = credentialDigest(undefined, false);
    if (matchingUser) {
      const [authority] = await transaction
        .select({ authorizedPasswordHash: credentialAuthority.authorizedPasswordHash })
        .from(credentialAuthority)
        .where(eq(credentialAuthority.userId, matchingUser.id))
        .limit(1)
        .for('update');
      const credentials = await transaction
        .select({ password: account.password })
        .from(account)
        .where(and(
          eq(account.userId, matchingUser.id),
          eq(account.providerId, 'credential')
        ))
        .orderBy(asc(account.id))
        .limit(2)
        .for('update');
      const currentCredential = credentials[0];
      const authorityConsistent = authority
        ? authority.authorizedPasswordHash === (currentCredential?.password ?? null)
        : currentCredential === undefined;
      if (credentials.length > 1 || !authorityConsistent) {
        await deleteEmailMarkers(transaction, MAGIC_LINK_PREFIX, email);
        return false;
      }
      generation = credentialDigest(currentCredential?.password, currentCredential !== undefined);
    }
    await deleteEmailMarkers(transaction, MAGIC_LINK_PREFIX, email);
    await transaction.insert(verification).values({
      identifier: identifier(MAGIC_LINK_PREFIX, input.token),
      value: magicLinkMarker(email, input.purpose, generation),
      expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000)
    });
    return true;
  });
}

export interface AuthMagicLinkConsumption {
  purpose: AuthMagicLinkPurpose;
}

async function passwordlessAuthorityCanBeCancelledByMagic(
  database: DatabaseExecutor,
  input: {
    authority: typeof credentialAuthority.$inferSelect;
    userId: string;
    email: string;
    now: Date;
  }
): Promise<boolean> {
  if (input.authority.resetEpochSha256 === null) {
    return input.authority.authorizedPasswordHash !== null;
  }
  const resetIdentifier = resetIdentifierForEpoch(input.authority.resetEpochSha256);
  if (!resetIdentifier) return false;
  const resetRows = await database
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, resetIdentifier))
    .limit(2)
    .for('update');
  if (resetRows.length !== 1) return false;
  const pending = resetRows[0];
  const parsed = pending ? parsePasswordResetMarker(pending.value) : null;
  return Boolean(
    pending &&
    parsed &&
    pending.expiresAt.getTime() > input.now.getTime() &&
    parsed.userId === input.userId &&
    parsed.email === input.email &&
    parsed.appliedPasswordHashSha256 === null
  );
}

export async function consumeAuthMagicLinkToken(
  database: Database,
  input: { token: string; userId: string; now?: Date }
): Promise<AuthMagicLinkConsumption | null> {
  const now = input.now ?? new Date();
  const magicIdentifier = identifier(MAGIC_LINK_PREFIX, input.token);
  return withTransaction(database, async (transaction) => {
    const [lockedUser] = await transaction
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(eq(user.id, input.userId))
      .limit(1)
      .for('update');
    const [pending] = await transaction
      .select({ value: verification.value, expiresAt: verification.expiresAt })
      .from(verification)
      .where(eq(verification.identifier, magicIdentifier))
      .limit(1)
      .for('update');
    const parsed = pending ? parseMagicLinkMarker(pending.value) : null;
    await transaction.delete(verification).where(eq(verification.identifier, magicIdentifier));
    if (
      !lockedUser ||
      !pending ||
      !parsed ||
      pending.expiresAt.getTime() <= now.getTime() ||
      normalizeEmailAddress(lockedUser.email) !== parsed.email
    ) return null;

    const [authority] = await transaction
      .select()
      .from(credentialAuthority)
      .where(eq(credentialAuthority.userId, lockedUser.id))
      .limit(1)
      .for('update');
    const credentials = await transaction
      .select({ password: account.password })
      .from(account)
      .where(and(
        eq(account.userId, lockedUser.id),
        eq(account.providerId, 'credential')
      ))
      .orderBy(asc(account.id))
      .limit(2)
      .for('update');
    if (credentials.length > 1) return null;
    const currentCredential = credentials[0];
    const issuedWithoutCredential = parsed.credentialDigest ===
      credentialDigest(undefined, false);
    const authorityConsistent = authority
      ? currentCredential
        ? authority.authorizedPasswordHash === currentCredential.password
        : issuedWithoutCredential && await passwordlessAuthorityCanBeCancelledByMagic(
            transaction,
            {
              authority,
              userId: lockedUser.id,
              email: parsed.email,
              now
            }
          )
      : currentCredential === undefined;
    if (!authorityConsistent) return null;
    const generation = credentialDigest(currentCredential?.password, currentCredential !== undefined);
    if (generation !== parsed.credentialDigest) return null;
    if (parsed.purpose === 'commerce-claim' && currentCredential) return null;

    // A successful mailbox-proving magic link becomes the newest account
    // recovery authority. Cancel every outstanding password reset while the
    // canonical user row is locked so a stale reset cannot take over the new
    // session later. Better Auth may also have just stripped an intervening
    // unverified credential; in that passwordless state its authority row is
    // now orphaned and must be removed rather than wedging future magic links.
    await deleteEmailMarkers(transaction, RESET_TOKEN_PREFIX, parsed.email);
    await transaction.delete(verification).where(and(
      like(verification.identifier, `${BETTER_AUTH_RESET_PREFIX}%`),
      eq(verification.value, lockedUser.id)
    ));
    if (authority) {
      if (currentCredential) {
        await transaction
          .update(credentialAuthority)
          .set({ resetEpochSha256: null, updatedAt: now })
          .where(eq(credentialAuthority.userId, lockedUser.id));
      } else {
        await transaction
          .delete(credentialAuthority)
          .where(eq(credentialAuthority.userId, lockedUser.id));
      }
    }

    return { purpose: parsed.purpose };
  });
}

export async function credentialAuthorityAcceptsPassword(
  database: Database,
  input: { userId: string; passwordHash: string }
): Promise<boolean> {
  const [authority] = await database
    .select({ authorizedPasswordHash: credentialAuthority.authorizedPasswordHash })
    .from(credentialAuthority)
    .where(eq(credentialAuthority.userId, input.userId))
    .limit(1);
  return Boolean(
    authority && authority.authorizedPasswordHash === input.passwordHash
  );
}
