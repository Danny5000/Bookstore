import { createHmac } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  claimGuestPurchasesAfterAuthorization,
  type ClaimGuestPurchasesAfterAuthorizationResult
} from '$lib/server/auth/commerce-claim-capability';
import { normalizeEmailAddress } from '$lib/server/auth/identity';
import type { appendAuditEvent as defaultAppendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import {
  entitlementGrants,
  guestIdentities,
  orderItems,
  orders
} from '$lib/server/db/schema';
import { enqueueJob as defaultEnqueueJob } from '$lib/server/jobs/repository';
import {
  COMMERCE_CLAIM_REQUEST_JOB,
  createClaimEmailJobPayload
} from './claim-email';
import { PermanentCommerceError } from './errors';
import type { projectEffectiveEntitlement as defaultProjectEffectiveEntitlement } from './grants';
import { consumeRateLimit as defaultConsumeRateLimit } from './rate-limit';

export interface ClaimedPurchaseGrantFacts {
  permanentlyRevoked: boolean;
  paymentStatus: 'pending' | 'succeeded' | 'failed';
  itemTotalMinor: number;
  succeededRefundAllocatedMinor: number;
  disputeStates: ReadonlyArray<'open' | 'won' | 'lost'>;
}

export type ClaimedPurchaseGrantState = 'unclaimed' | 'active' | 'suspended' | 'revoked';

export function deriveClaimedPurchaseGrantState(
  facts: ClaimedPurchaseGrantFacts
): ClaimedPurchaseGrantState {
  if (
    typeof facts.permanentlyRevoked !== 'boolean' ||
    !['pending', 'succeeded', 'failed'].includes(facts.paymentStatus) ||
    !Number.isSafeInteger(facts.itemTotalMinor) ||
    facts.itemTotalMinor < 1 ||
    !Number.isSafeInteger(facts.succeededRefundAllocatedMinor) ||
    facts.succeededRefundAllocatedMinor < 0 ||
    facts.succeededRefundAllocatedMinor > facts.itemTotalMinor ||
    !Array.isArray(facts.disputeStates) ||
    facts.disputeStates.some((state) => !['open', 'won', 'lost'].includes(state))
  ) throw new PermanentCommerceError();

  if (
    facts.permanentlyRevoked ||
    facts.succeededRefundAllocatedMinor === facts.itemTotalMinor
  ) return 'revoked';
  if (facts.disputeStates.includes('lost')) return 'revoked';
  if (facts.disputeStates.includes('open')) return 'suspended';
  return facts.paymentStatus === 'succeeded' ? 'active' : 'unclaimed';
}

/**
 * Backward-compatible input shape. The database routine deliberately ignores
 * caller-supplied identity: the protected issuance derives it instead.
 */
export interface ClaimGuestPurchasesInput {
  userId: string;
  correlationId: string;
  authorizationToken: string;
  now?: Date;
}

export type ClaimGuestPurchasesResult = ClaimGuestPurchasesAfterAuthorizationResult;

export interface ClaimGuestPurchasesDependencies {
  projectEntitlement?: typeof defaultProjectEffectiveEntitlement;
  appendAuditEvent?: typeof defaultAppendAuditEvent;
}

export { claimGuestPurchasesAfterAuthorization };

export async function claimGuestPurchases(
  database: Database,
  input: ClaimGuestPurchasesInput,
  _dependencyOverrides: ClaimGuestPurchasesDependencies = {}
): Promise<ClaimGuestPurchasesResult> {
  return claimGuestPurchasesAfterAuthorization(database, {
    claimProof: input.authorizationToken,
    correlationId: input.correlationId
  });
}

function permanent(cause?: unknown): never {
  throw new PermanentCommerceError(cause === undefined ? undefined : { cause });
}

export interface ClaimRequestScopeInput {
  email: string;
  requestIp: string;
  applicationSecret: string;
}

export function claimRequestScopeDigest(input: ClaimRequestScopeInput): string {
  let email: string;
  try {
    email = normalizeEmailAddress(input.email);
  } catch (error) {
    return permanent(error);
  }
  const requestIp = input.requestIp.trim();
  if (!requestIp || !input.applicationSecret) permanent();
  return createHmac('sha256', input.applicationSecret)
    .update('commerce.claim-request.v1\0', 'utf8')
    .update(email, 'utf8')
    .update('\0', 'utf8')
    .update(requestIp, 'utf8')
    .digest('hex');
}

export interface RequestGuestClaimEmailsInput extends ClaimRequestScopeInput {
  windowSeconds: number;
  maxAttempts: number;
  now?: Date;
}

export interface RequestGuestClaimEmailsDependencies {
  consumeRateLimit?: typeof defaultConsumeRateLimit;
  enqueueJob?: typeof defaultEnqueueJob;
}

export async function requestGuestClaimEmails(
  database: Database,
  input: RequestGuestClaimEmailsInput,
  dependencyOverrides: RequestGuestClaimEmailsDependencies = {}
): Promise<void> {
  let email: string;
  try {
    email = normalizeEmailAddress(input.email);
  } catch (error) {
    return permanent(error);
  }
  const scopeSha256 = claimRequestScopeDigest({
    email,
    requestIp: input.requestIp,
    applicationSecret: input.applicationSecret
  });
  const consumeRateLimit = dependencyOverrides.consumeRateLimit ?? defaultConsumeRateLimit;
  const enqueueJob = dependencyOverrides.enqueueJob ?? defaultEnqueueJob;
  if (
    !Number.isSafeInteger(input.windowSeconds) ||
    input.windowSeconds < 1 ||
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1
  ) permanent();
  const now = input.now ?? new Date();
  const windowNumber = Math.floor(now.getTime() / (input.windowSeconds * 1000));

  await database.transaction(async (transaction) => {
    const decision = await consumeRateLimit(transaction, {
      namespace: 'commerce.claim-request',
      scopeSha256,
      windowSeconds: input.windowSeconds,
      maxAttempts: input.maxAttempts,
      now
    });
    if (!decision.allowed) return;

    const [identity] = await transaction
      .select()
      .from(guestIdentities)
      .where(eq(guestIdentities.email, email))
      .limit(1)
      .for('update');
    if (!identity) return;
    const eligibleOrders = await transaction
      .selectDistinct({ id: orders.id })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .innerJoin(entitlementGrants, and(
        eq(entitlementGrants.orderItemId, orderItems.id),
        eq(entitlementGrants.source, 'purchase'),
        isNull(entitlementGrants.userId)
      ))
      .where(and(
        eq(orders.guestIdentityId, identity.id),
        eq(orders.status, 'paid'),
        isNull(orders.initiatingUserId)
      ))
      .orderBy(asc(orders.id));
    for (const order of eligibleOrders) {
      await enqueueJob(transaction, {
        type: COMMERCE_CLAIM_REQUEST_JOB,
        payload: createClaimEmailJobPayload(order.id),
        deduplicationKey:
          `commerce:claim-request:order:${order.id}:window:${windowNumber}:v1`,
        maxAttempts: 8
      });
    }
  });
}
