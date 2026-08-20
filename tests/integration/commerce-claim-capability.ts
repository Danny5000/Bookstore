import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  authorizeCommerceClaimIssuance,
  COMMERCE_CLAIM_PROOF_COOKIE,
  commerceClaimTokenSha256,
  createCommerceClaimProofToken,
  parseCommerceClaimBridgePayload,
  registerCommerceClaimIssuance,
  wrapCommerceClaimActionUrl,
  type CommerceClaimIssuanceKind
} from '$lib/server/auth/commerce-claim-capability';
import { normalizeEmailAddress } from '$lib/server/auth/identity';
import type { Database } from '$lib/server/db/client';
import {
  account,
  credentialAuthority,
  guestIdentities,
  orders,
  user
} from '$lib/server/db/schema';
import { ownerDatabaseClient, workerDatabaseClient } from './database';

export interface TraversedCommerceClaimBridge {
  actionUrl: string;
  proofCookieName: typeof COMMERCE_CLAIM_PROOF_COOKIE;
  proofCookieValue: string;
}

/**
 * Models the security-relevant result of the nonce-bound bridge GET/POST:
 * the independent proof is installed as the HttpOnly cookie and the 303
 * location contains only the exact native Better Auth action.
 */
export function traverseCommerceClaimBridge(
  claimUrl: string,
  expectedOrigin: string
): TraversedCommerceClaimBridge {
  const trustedOrigin = new URL(expectedOrigin).origin;
  const bridge = new URL(claimUrl);
  if (
    bridge.origin !== trustedOrigin || bridge.username || bridge.password ||
    bridge.pathname !== '/claim/authorize' || bridge.search !== '' ||
    !bridge.hash.startsWith('#')
  ) throw new Error('Commerce claim fixture received an invalid bridge URL');
  const parsed = parseCommerceClaimBridgePayload(bridge.hash.slice(1), trustedOrigin);
  return {
    actionUrl: parsed.actionUrl,
    proofCookieName: COMMERCE_CLAIM_PROOF_COOKIE,
    proofCookieValue: parsed.claimProofToken
  };
}

export function createCommerceMagicClaimBridgeFixture(
  anchorOrderId: string,
  trustedOrigin: string
): string {
  const action = new URL('/api/auth/magic-link/verify', trustedOrigin);
  action.searchParams.set('token', createCommerceClaimProofToken());
  action.searchParams.set('callbackURL', '/claim/complete');
  action.searchParams.set('errorCallbackURL', '/claim/complete?error=magic-link');
  action.searchParams.set('newUserCallbackURL', '/claim/complete');
  return wrapCommerceClaimActionUrl({
    actionUrl: action.toString(),
    claimProofToken: createCommerceClaimProofToken(),
    anchorOrderId,
    kind: 'commerce-magic',
    trustedOrigin
  });
}

/**
 * Exercises the real 0010 worker-registration and web-promotion routines while
 * arranging the native-auth state that Better Auth would have committed first.
 */
export async function createCommerceClaimAuthorization(
  webDatabase: Database,
  input: { email: string; kind: CommerceClaimIssuanceKind }
): Promise<string> {
  const normalizedEmail = normalizeEmailAddress(input.email);
  const [identity] = await ownerDatabaseClient.db
    .select({ id: guestIdentities.id })
    .from(guestIdentities)
    .where(eq(guestIdentities.email, normalizedEmail))
    .limit(1);
  if (!identity) throw new Error('Commerce claim fixture requires a guest identity');
  const [anchor] = await ownerDatabaseClient.db
    .select({ id: orders.id })
    .from(orders)
    .where(and(
      eq(orders.guestIdentityId, identity.id),
      eq(orders.status, 'paid'),
      isNull(orders.initiatingUserId)
    ))
    .orderBy(asc(orders.id))
    .limit(1);
  if (!anchor) throw new Error('Commerce claim fixture requires a paid guest order');

  if (input.kind === 'password-reset') {
    const [claimant] = await ownerDatabaseClient.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, normalizedEmail))
      .limit(1);
    if (!claimant) throw new Error('Password-reset claim fixture requires a user');
    const credentials = await ownerDatabaseClient.db
      .select({ id: account.id, password: account.password })
      .from(account)
      .where(and(eq(account.userId, claimant.id), eq(account.providerId, 'credential')))
      .orderBy(asc(account.id))
      .limit(2);
    if (credentials.length > 1) {
      throw new Error('Password-reset claim fixture has ambiguous credentials');
    }
    const password = credentials[0]?.password ?? `test-only-claim-${randomUUID()}`;
    if (!credentials[0]) {
      await ownerDatabaseClient.db.insert(account).values({
        accountId: claimant.id,
        providerId: 'credential',
        userId: claimant.id,
        password
      });
    }
    await ownerDatabaseClient.db
      .insert(credentialAuthority)
      .values({ userId: claimant.id, authorizedPasswordHash: password, resetEpochSha256: null })
      .onConflictDoUpdate({
        target: credentialAuthority.userId,
        set: { authorizedPasswordHash: password, resetEpochSha256: null }
      });
  }

  const claimProof = createCommerceClaimProofToken();
  const authToken = createCommerceClaimProofToken();
  const registered = await registerCommerceClaimIssuance(workerDatabaseClient.db, {
    claimProofSha256: commerceClaimTokenSha256(claimProof),
    authTokenSha256: commerceClaimTokenSha256(authToken),
    email: normalizedEmail,
    anchorOrderId: anchor.id,
    kind: input.kind,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });
  if (!registered) throw new Error('Commerce claim fixture registration was rejected');
  await authorizeCommerceClaimIssuance(webDatabase, { claimProof, authToken });
  return claimProof;
}
