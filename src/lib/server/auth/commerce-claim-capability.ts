import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '$lib/server/db/client';
import { CommerceConflictError, PermanentCommerceError } from '$lib/server/commerce/errors';
import { normalizeEmailAddress } from './identity';

export const COMMERCE_CLAIM_PROOF_COOKIE = 'pale-orbit-commerce-claim';
export const COMMERCE_CLAIM_PROOF_TTL_SECONDS = 10 * 60;

const proofTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const uuidSchema = z.uuid();
const correlationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);

export type CommerceClaimIssuanceKind = 'password-reset' | 'commerce-magic';

export interface CommerceClaimBridgeRequest {
  claimProofToken: string;
  anchorOrderId: string;
  kind: CommerceClaimIssuanceKind;
  actionUrl: string;
}

export function createCommerceClaimProofToken(): string {
  return randomBytes(32).toString('base64url');
}

export function commerceClaimTokenSha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeCommerceClaimCorrelationId(value: string): string {
  const parsed = correlationIdSchema.safeParse(value);
  return parsed.success ? parsed.data : randomUUID();
}

function exactTrustedOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.hash) {
    throw new PermanentCommerceError();
  }
  return url.origin;
}

function exactCommerceAction(
  actionUrl: string,
  trustedOrigin: string,
  kind: CommerceClaimIssuanceKind,
  anchorOrderId: string
): URL {
  const action = new URL(z.url().max(2048).parse(actionUrl));
  if (
    action.origin !== trustedOrigin ||
    action.username ||
    action.password ||
    action.hash
  ) throw new PermanentCommerceError();

  if (kind === 'commerce-magic') {
    const allowedKeys = ['callbackURL', 'errorCallbackURL', 'newUserCallbackURL', 'token'];
    const keys = [...action.searchParams.keys()].sort();
    if (
      action.pathname !== '/api/auth/magic-link/verify' ||
      keys.length !== allowedKeys.length ||
      keys.some((key, index) => key !== allowedKeys[index]) ||
      !z.string().min(1).max(256).safeParse(action.searchParams.get('token')).success ||
      action.searchParams.get('callbackURL') !== '/claim/complete' ||
      action.searchParams.get('newUserCallbackURL') !== '/claim/complete' ||
      action.searchParams.get('errorCallbackURL') !== '/claim/complete?error=magic-link'
    ) throw new PermanentCommerceError();
    return action;
  }

  const resetPath = action.pathname.match(/^\/api\/auth\/reset-password\/([A-Za-z0-9_-]{1,256})$/u);
  const callback = new URL(action.searchParams.get('callbackURL') ?? '', trustedOrigin);
  if (
    !resetPath ||
    action.searchParams.size !== 1 ||
    callback.origin !== trustedOrigin ||
    callback.username ||
    callback.password ||
    callback.pathname !== '/reset-password' ||
    callback.hash ||
    callback.searchParams.size !== 2 ||
    callback.searchParams.get('purpose') !== 'commerce-claim' ||
    callback.searchParams.get('orderId') !== anchorOrderId
  ) throw new PermanentCommerceError();
  return action;
}

export function wrapCommerceClaimActionUrl(input: {
  actionUrl: string;
  claimProofToken: string;
  anchorOrderId: string;
  kind: CommerceClaimIssuanceKind;
  trustedOrigin: string;
}): string {
  const claimProofToken = proofTokenSchema.parse(input.claimProofToken);
  const anchorOrderId = uuidSchema.parse(input.anchorOrderId);
  const trustedOrigin = exactTrustedOrigin(input.trustedOrigin);
  const action = exactCommerceAction(input.actionUrl, trustedOrigin, input.kind, anchorOrderId);
  const bridge = new URL('/claim/authorize', trustedOrigin);
  const payload = new URLSearchParams();
  payload.set('proof', claimProofToken);
  payload.set('orderId', anchorOrderId);
  payload.set('kind', input.kind);
  payload.set('action', action.toString());
  // URL fragments are not sent in the HTTP request target. The bridge page moves
  // this payload into a same-origin POST body before the server sees either bearer.
  bridge.hash = payload.toString();
  return bridge.toString();
}

export function parseCommerceClaimBridgePayload(
  payload: string,
  configuredOrigin: string
): CommerceClaimBridgeRequest {
  const trustedOrigin = exactTrustedOrigin(configuredOrigin);
  if (!payload || payload.length > 8192 || payload.startsWith('#')) {
    throw new PermanentCommerceError();
  }
  const parameters = new URLSearchParams(payload);
  if (parameters.size !== 4) throw new PermanentCommerceError();
  const claimProofToken = proofTokenSchema.parse(parameters.get('proof'));
  const anchorOrderId = uuidSchema.parse(parameters.get('orderId'));
  const kind = z.enum(['password-reset', 'commerce-magic'])
    .parse(parameters.get('kind'));
  const action = exactCommerceAction(
    parameters.get('action') ?? '',
    trustedOrigin,
    kind,
    anchorOrderId
  );
  return { claimProofToken, anchorOrderId, kind, actionUrl: action.toString() };
}

export interface RegisterCommerceClaimIssuanceInput {
  claimProofSha256: string;
  authTokenSha256: string;
  email: string;
  anchorOrderId: string;
  kind: CommerceClaimIssuanceKind;
  expiresAt: Date;
}

export async function registerCommerceClaimIssuance(
  database: Database,
  input: RegisterCommerceClaimIssuanceInput
): Promise<boolean> {
  const claimProofSha256 = sha256Schema.parse(input.claimProofSha256);
  const authTokenSha256 = sha256Schema.parse(input.authTokenSha256);
  const normalizedEmail = normalizeEmailAddress(input.email);
  const anchorOrderId = uuidSchema.parse(input.anchorOrderId);
  if (
    (input.kind !== 'password-reset' && input.kind !== 'commerce-magic') ||
    Number.isNaN(input.expiresAt.getTime())
  ) throw new PermanentCommerceError();

  const result = await database.execute<{ registered: boolean }>(sql`
    select "public"."register_commerce_claim_issuance"(
      ${claimProofSha256}::text,
      ${authTokenSha256}::text,
      ${normalizedEmail}::text,
      ${anchorOrderId}::uuid,
      ${input.kind}::text,
      ${input.expiresAt}::timestamptz
    ) as "registered"
  `);
  const registered = result.rows[0]?.registered;
  if (typeof registered !== 'boolean') {
    throw new Error('Commerce claim issuance registration returned no result');
  }
  return registered;
}

export async function authorizeCommerceClaimIssuance(
  database: Database,
  input: { claimProof: string; authToken: string }
): Promise<boolean> {
  const parsedClaimProof = proofTokenSchema.safeParse(input.claimProof);
  const parsedAuthToken = z.string().min(1).max(256).safeParse(input.authToken);
  if (!parsedClaimProof.success || !parsedAuthToken.success) return false;
  const claimProof = parsedClaimProof.data;
  const authToken = parsedAuthToken.data;
  const result = await database.execute<{ authorized: boolean }>(sql`
    select "public"."authorize_commerce_claim_issuance"(
      ${claimProof}::text,
      ${authToken}::text
    ) as "authorized"
  `);
  const authorized = result.rows[0]?.authorized;
  if (typeof authorized !== 'boolean') {
    throw new Error('Commerce claim issuance authorization returned no result');
  }
  return authorized;
}

export interface ClaimGuestPurchasesAfterAuthorizationResult {
  claimed: boolean;
  changed: boolean;
  claimedOrderCount: number;
  claimedTitleCount: number;
}

interface ClaimGuestPurchasesRow extends Record<string, unknown> {
  claimed: boolean;
  changed: boolean;
  claimedOrderCount: number;
  claimedTitleCount: number;
  definitiveInvalid: boolean;
  conflictCode: string | null;
}

export async function claimGuestPurchasesAfterAuthorization(
  database: Database,
  input: { claimProof: string; correlationId: string }
): Promise<ClaimGuestPurchasesAfterAuthorizationResult> {
  const parsedClaimProof = proofTokenSchema.safeParse(input.claimProof);
  const parsedCorrelationId = correlationIdSchema.safeParse(input.correlationId);
  if (!parsedClaimProof.success || !parsedCorrelationId.success) {
    throw new CommerceConflictError('CLAIM_AUTHORIZATION_REQUIRED');
  }
  const claimProof = parsedClaimProof.data;
  const correlationId = parsedCorrelationId.data;
  const result = await database.execute<ClaimGuestPurchasesRow>(sql`
    select
      "claimed",
      "changed",
      "claimed_order_count" as "claimedOrderCount",
      "claimed_title_count" as "claimedTitleCount",
      "definitive_invalid" as "definitiveInvalid",
      "conflict_code" as "conflictCode"
    from "public"."claim_guest_purchases_after_authorization"(
      ${claimProof}::text,
      ${correlationId}::text
    )
  `);
  const row = result.rows[0];
  if (
    !row ||
    typeof row.claimed !== 'boolean' ||
    typeof row.changed !== 'boolean' ||
    typeof row.claimedOrderCount !== 'number' ||
    typeof row.claimedTitleCount !== 'number' ||
    typeof row.definitiveInvalid !== 'boolean'
  ) throw new Error('Commerce claim routine returned an invalid result');
  if (row.conflictCode === 'IDENTITY_ALREADY_CLAIMED') {
    throw new CommerceConflictError('IDENTITY_ALREADY_CLAIMED');
  }
  if (row.definitiveInvalid) {
    throw new CommerceConflictError('CLAIM_AUTHORIZATION_REQUIRED');
  }
  if (row.conflictCode !== null) throw new PermanentCommerceError();
  return {
    claimed: row.claimed,
    changed: row.changed,
    claimedOrderCount: row.claimedOrderCount,
    claimedTitleCount: row.claimedTitleCount
  };
}

export async function purgeCommerceClaimIssuances(database: Database): Promise<number> {
  const result = await database.execute<{ deleted: number }>(sql`
    select "public"."purge_commerce_claim_issuances"() as "deleted"
  `);
  const deleted = result.rows[0]?.deleted;
  if (typeof deleted !== 'number' || !Number.isSafeInteger(deleted) || deleted < 0) {
    throw new Error('Commerce claim issuance purge returned an invalid result');
  }
  return deleted;
}
