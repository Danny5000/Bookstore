import { createHmac, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { normalizeEmailAddress } from '$lib/server/auth/identity';
import { consumeCommerceClaimAuthorizationInTransaction } from '$lib/server/auth/commerce-claim-authorization';
import { appendAuditEvent as defaultAppendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import {
  disputes,
  account,
  entitlementGrants,
  guestIdentities,
  orderItems,
  orders,
  payments,
  refundAllocations,
  refunds,
  user,
  type DisputeRow,
  type EntitlementGrantRow,
  type OrderItemRow,
  type PaymentRow,
  type RefundAllocationRow,
  type RefundRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { enqueueJob as defaultEnqueueJob } from '$lib/server/jobs/repository';
import {
  COMMERCE_CLAIM_REQUEST_JOB,
  createClaimEmailJobPayload
} from './claim-email';
import { CommerceConflictError, PermanentCommerceError } from './errors';
import { projectEffectiveEntitlement as defaultProjectEffectiveEntitlement } from './grants';
import { lockEntitlementScopes } from './lock';
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

export interface ClaimGuestPurchasesInput {
  userId: string;
  correlationId: string;
  authorizationToken: string;
  now?: Date;
}

export interface ClaimGuestPurchasesResult {
  claimed: boolean;
  changed: boolean;
  claimedOrderCount: number;
  claimedTitleCount: number;
}

type ProjectEntitlement = typeof defaultProjectEffectiveEntitlement;
type AppendAuditEvent = typeof defaultAppendAuditEvent;

export interface ClaimGuestPurchasesDependencies {
  projectEntitlement?: ProjectEntitlement;
  appendAuditEvent?: AppendAuditEvent;
}

interface LockedClaimFacts {
  items: readonly OrderItemRow[];
  paymentsByOrderId: ReadonlyMap<string, PaymentRow>;
  grantsByItemId: ReadonlyMap<string, EntitlementGrantRow>;
  refundsById: ReadonlyMap<string, RefundRow>;
  allocationsByItemId: ReadonlyMap<string, readonly RefundAllocationRow[]>;
  disputesByPaymentId: ReadonlyMap<string, readonly DisputeRow[]>;
}

const EMPTY_RESULT: ClaimGuestPurchasesResult = {
  claimed: false,
  changed: false,
  claimedOrderCount: 0,
  claimedTitleCount: 0
};

function permanent(cause?: unknown): never {
  throw new PermanentCommerceError(cause === undefined ? undefined : { cause });
}

function assertClaimInput(input: ClaimGuestPurchasesInput): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(input.userId) ||
    typeof input.correlationId !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(input.authorizationToken) ||
    (input.now !== undefined && Number.isNaN(input.now.getTime()))
  ) permanent();
}

async function lockClaimant(
  transaction: DatabaseTransaction,
  claimant: { userId: string; verifiedEmail: string }
): Promise<void> {
  const [lockedClaimant] = await transaction
    .select()
    .from(user)
    .where(eq(user.id, claimant.userId))
    .limit(1)
    .for('update');
  if (
    !lockedClaimant ||
    normalizedVerifiedEmail(lockedClaimant) !== claimant.verifiedEmail
  ) permanent();
}

async function authorizeLockedClaimant(
  transaction: DatabaseTransaction,
  input: { userId: string; email: string; token: string; now: Date }
): Promise<void> {
  const [credential] = await transaction
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, input.userId), eq(account.providerId, 'credential')))
    .limit(1)
    .for('update');
  const kind = await consumeCommerceClaimAuthorizationInTransaction(transaction, {
    token: input.token,
    email: input.email,
    now: input.now
  });
  if (!kind || (credential && kind !== 'password-reset')) {
    throw new CommerceConflictError('CLAIM_AUTHORIZATION_REQUIRED');
  }
}

function safeAuditCorrelationId(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value) ? value : randomUUID();
}

function normalizedVerifiedEmail(account: typeof user.$inferSelect): string {
  if (!account.emailVerified) return permanent();
  try {
    const normalized = normalizeEmailAddress(account.email);
    if (normalized !== account.email) return permanent();
    return normalized;
  } catch (error) {
    return permanent(error);
  }
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const itemKey = key(value);
    const existing = grouped.get(itemKey);
    if (existing) existing.push(value);
    else grouped.set(itemKey, [value]);
  }
  return grouped;
}

async function lockClaimFacts(
  transaction: DatabaseTransaction,
  paidOrders: readonly (typeof orders.$inferSelect)[],
  claimant: { userId: string; verifiedEmail: string }
): Promise<LockedClaimFacts> {
  const orderIds = paidOrders.map((order) => order.id);
  const lockedPayments = await transaction
    .select()
    .from(payments)
    .where(inArray(payments.orderId, orderIds))
    .orderBy(asc(payments.id))
    .for('update');
  const paymentsByOrderId = new Map(lockedPayments.map((payment) => [payment.orderId, payment]));
  if (
    paymentsByOrderId.size !== paidOrders.length ||
    lockedPayments.some((payment) => payment.status !== 'succeeded')
  ) permanent();

  const paymentIds = lockedPayments.map((payment) => payment.id);
  const lockedRefunds = await transaction
    .select()
    .from(refunds)
    .where(inArray(refunds.paymentId, paymentIds))
    .orderBy(asc(refunds.id))
    .for('update');
  const refundsById = new Map(lockedRefunds.map((refund) => [refund.id, refund]));
  const refundIds = lockedRefunds.map((refund) => refund.id);
  const lockedAllocations = refundIds.length === 0
    ? []
    : await transaction
        .select()
        .from(refundAllocations)
        .where(inArray(refundAllocations.refundId, refundIds))
        .orderBy(asc(refundAllocations.id))
        .for('update');
  const lockedDisputes = await transaction
    .select()
    .from(disputes)
    .where(inArray(disputes.paymentId, paymentIds))
    .orderBy(asc(disputes.id))
    .for('update');

  const items = await transaction
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(asc(orderItems.id))
    .for('update');
  if (items.length === 0 || items.some((item) => item.totalMinor === null)) permanent();

  await lockEntitlementScopes(
    transaction,
    items.map((item) => ({ userId: claimant.userId, titleId: item.titleId }))
  );

  // Preserved-grant creation takes this scope before its user FK lock. Re-locking the claimant
  // only here keeps that order consistent; the discovery read is revalidated before grant writes.
  const [lockedClaimant] = await transaction
    .select()
    .from(user)
    .where(eq(user.id, claimant.userId))
    .limit(1)
    .for('update');
  if (
    !lockedClaimant ||
    normalizedVerifiedEmail(lockedClaimant) !== claimant.verifiedEmail
  ) permanent();

  const itemIds = items.map((item) => item.id);
  const lockedGrants = await transaction
    .select()
    .from(entitlementGrants)
    .where(inArray(entitlementGrants.orderItemId, itemIds))
    .orderBy(asc(entitlementGrants.id))
    .for('update');
  const grantsByItemId = new Map(
    lockedGrants.map((grant) => [grant.orderItemId ?? permanent(), grant])
  );
  if (
    grantsByItemId.size !== items.length ||
    lockedGrants.length !== items.length ||
    lockedGrants.some((grant) => grant.source !== 'purchase')
  ) permanent();

  return {
    items,
    paymentsByOrderId,
    grantsByItemId,
    refundsById,
    allocationsByItemId: groupBy(lockedAllocations, (allocation) => allocation.orderItemId),
    disputesByPaymentId: groupBy(lockedDisputes, (dispute) => dispute.paymentId)
  };
}

function succeededAllocationMinor(
  itemId: string,
  facts: LockedClaimFacts
): number {
  let total = 0;
  for (const allocation of facts.allocationsByItemId.get(itemId) ?? []) {
    if (facts.refundsById.get(allocation.refundId)?.status !== 'succeeded') continue;
    total += allocation.amountMinor;
    if (!Number.isSafeInteger(total)) permanent();
  }
  return total;
}

function stateReason(
  grant: EntitlementGrantRow,
  state: ClaimedPurchaseGrantState,
  allocatedMinor: number,
  itemTotalMinor: number,
  disputeStates: readonly DisputeRow['status'][]
): string {
  if (grant.state === 'revoked') return grant.stateReason;
  if (state === 'revoked' && allocatedMinor === itemTotalMinor) {
    return 'refund_fully_allocated';
  }
  if (state === 'revoked' && disputeStates.includes('lost')) return 'dispute_lost';
  if (state === 'suspended') return 'dispute_open';
  if (state === 'active') return 'payment_succeeded';
  return permanent();
}

function transitionTime(now: Date, grantedAt: Date): Date {
  return now.getTime() < grantedAt.getTime() ? grantedAt : now;
}

export async function claimGuestPurchases(
  database: Database,
  input: ClaimGuestPurchasesInput,
  dependencyOverrides: ClaimGuestPurchasesDependencies = {}
): Promise<ClaimGuestPurchasesResult> {
  assertClaimInput(input);
  const now = input.now ?? new Date();
  const correlationId = safeAuditCorrelationId(input.correlationId);
  const projectEntitlement =
    dependencyOverrides.projectEntitlement ?? defaultProjectEffectiveEntitlement;
  const appendAuditEvent = dependencyOverrides.appendAuditEvent ?? defaultAppendAuditEvent;

  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select()
      .from(user)
      .where(eq(user.id, input.userId))
      .limit(1);
    if (!account) permanent();
    const email = normalizedVerifiedEmail(account);
    const claimant = { userId: account.id, verifiedEmail: email };

    const [identity] = await transaction
      .select()
      .from(guestIdentities)
      .where(eq(guestIdentities.email, email))
      .limit(1)
      .for('update');
    if (!identity) {
      await lockClaimant(transaction, claimant);
      await authorizeLockedClaimant(transaction, {
        userId: account.id,
        email,
        token: input.authorizationToken,
        now
      });
      return EMPTY_RESULT;
    }
    if (identity.claimedByUserId && identity.claimedByUserId !== account.id) {
      await lockClaimant(transaction, claimant);
      await authorizeLockedClaimant(transaction, {
        userId: account.id,
        email,
        token: input.authorizationToken,
        now
      });
      throw new CommerceConflictError('IDENTITY_ALREADY_CLAIMED');
    }

    const paidOrders = await transaction
      .select()
      .from(orders)
      .where(and(
        eq(orders.guestIdentityId, identity.id),
        eq(orders.status, 'paid'),
        isNull(orders.initiatingUserId)
      ))
      .orderBy(asc(orders.id))
      .for('update');
    if (paidOrders.length === 0) {
      await lockClaimant(transaction, claimant);
      await authorizeLockedClaimant(transaction, {
        userId: account.id,
        email,
        token: input.authorizationToken,
        now
      });
      return EMPTY_RESULT;
    }

    const facts = await lockClaimFacts(transaction, paidOrders, {
      userId: account.id,
      verifiedEmail: email
    });
    await authorizeLockedClaimant(transaction, {
      userId: account.id,
      email,
      token: input.authorizationToken,
      now
    });
    const orderById = new Map(paidOrders.map((order) => [order.id, order]));
    const uniqueTitleIds = [...new Set(facts.items.map((item) => item.titleId))]
      .sort((left, right) => left.localeCompare(right));

    const changedTitleIds = new Set<string>();
    for (const item of facts.items) {
      const order = orderById.get(item.orderId) ?? permanent();
      const payment = facts.paymentsByOrderId.get(order.id) ?? permanent();
      const grant = facts.grantsByItemId.get(item.id) ?? permanent();
      if (grant.titleId !== item.titleId) permanent();
      if (grant.userId !== null && grant.userId !== account.id) {
        throw new CommerceConflictError('IDENTITY_ALREADY_CLAIMED');
      }
      if (grant.userId === account.id) continue;

      const allocatedMinor = succeededAllocationMinor(item.id, facts);
      const itemTotalMinor = item.totalMinor ?? permanent();
      const grantDisputes = facts.disputesByPaymentId.get(payment.id) ?? [];
      const disputeStates = grantDisputes.map((dispute) => dispute.status);
      const nextState = deriveClaimedPurchaseGrantState({
        permanentlyRevoked: grant.state === 'revoked',
        paymentStatus: payment.status,
        itemTotalMinor,
        succeededRefundAllocatedMinor: allocatedMinor,
        disputeStates
      });
      if (nextState === 'unclaimed') permanent();
      const changedAt = transitionTime(now, grant.grantedAt);
      await transaction
        .update(entitlementGrants)
        .set({
          userId: account.id,
          state: nextState,
          stateReason: stateReason(
            grant,
            nextState,
            allocatedMinor,
            itemTotalMinor,
            disputeStates
          ),
          suspendedAt: nextState === 'suspended'
            ? (grant.suspendedAt ?? changedAt)
            : null,
          revokedAt: nextState === 'revoked'
            ? (grant.revokedAt ?? changedAt)
            : null,
          updatedAt: now
        })
        .where(eq(entitlementGrants.id, grant.id));
      changedTitleIds.add(item.titleId);
    }

    const identityChanged = identity.claimedByUserId === null;
    if (identityChanged) {
      await transaction
        .update(guestIdentities)
        .set({ claimedByUserId: account.id, claimedAt: now, updatedAt: now })
        .where(eq(guestIdentities.id, identity.id));
    }
    for (const titleId of [...changedTitleIds].sort((left, right) => left.localeCompare(right))) {
      await projectEntitlement(transaction, account.id, titleId, now);
    }

    const changed = identityChanged || changedTitleIds.size > 0;
    const result: ClaimGuestPurchasesResult = {
      claimed: true,
      changed,
      claimedOrderCount: paidOrders.length,
      claimedTitleCount: uniqueTitleIds.length
    };
    if (changed) {
      await appendAuditEvent(transaction, {
        actor: { type: 'user', id: account.id, roles: ['customer'] },
        action: 'commerce.guest_claimed',
        outcome: 'succeeded',
        resourceType: 'guest_identity',
        resourceId: identity.id,
        correlationId,
        after: {
          claimedOrderCount: result.claimedOrderCount,
          claimedTitleCount: result.claimedTitleCount
        }
      });
    }
    return result;
  });
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
