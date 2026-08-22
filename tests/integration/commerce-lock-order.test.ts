import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  createCommerceClaimAuthorization,
  createCommerceMagicClaimBridgeFixture
} from './commerce-claim-capability';
import { claimGuestPurchases } from '$lib/server/commerce/claims';
import { queueCommerceClaimEmail } from '$lib/server/commerce/claim-email';
import { fulfillDisputeEvent } from '$lib/server/commerce/disputes';
import { createCommerceMessageEnqueuer } from '$lib/server/commerce/email/enqueue';
import { fulfillCheckoutEvent } from '$lib/server/commerce/fulfillment';
import { setPreservedGrantState } from '$lib/server/commerce/grants';
import { fulfillRefundEvent } from '$lib/server/commerce/refunds';
import {
  lockPaymentAccessFacts,
  lockPaymentEntitlementFacts,
  lockPaymentPurchaseFacts
} from '$lib/server/commerce/reconciliation';
import { lockOrder } from '$lib/server/commerce/lock';
import { loadApplicationConfig } from '$lib/server/config/load';
import type { Database } from '$lib/server/db/client';
import { databaseEnvironmentForRole } from '$lib/server/db/database-role-provision';
import * as commerceSchema from '$lib/server/db/schema';
import {
  auditEvents,
  disputes,
  entitlementGrants,
  entitlements,
  financialAllocationSets,
  guestIdentities,
  orderItems,
  orders,
  payments,
  payoutImportRuns,
  refunds,
  refundAllocationDraftItems,
  refundAllocationDrafts,
  refundReportingCorrectionItems,
  refundReportingCorrectionSets,
  stripeBalanceTransactions,
  stripeEvents,
  stripePayoutBalanceTransactions,
  stripePayouts,
  titles,
  user
} from '$lib/server/db/schema';
import type { CheckoutSnapshot, PaymentSnapshot } from '$lib/server/commerce/stripe/types';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient
} from './database';

const paidAt = new Date('2026-08-10T12:05:00.000Z');
const providerCreatedAt = new Date('2026-08-10T14:00:00.000Z');
const eventCreatedAt = new Date('2026-08-10T14:01:00.000Z');

interface LockFixture {
  claimantId: string;
  claimantEmail: string;
  disputeId: string;
  grantId: string;
  itemId: string;
  orderId: string;
  paymentId: string;
  paymentIntentId: string;
  refundId: string;
  stripeDisputeId: string;
  stripeRefundId: string;
  titleId: string;
}

interface PendingGuestFulfillmentFixture {
  orderId: string;
  orderItemId: string;
  stripeEventId: string;
  titleId: string;
  session: CheckoutSnapshot;
  payment: PaymentSnapshot;
}

function createBoundedProbeDatabase(
  applicationName: string,
  role: 'runtime' | 'worker' = 'runtime'
): {
  database: Database;
  close(): Promise<void>;
} {
  const config = role === 'worker'
    ? loadApplicationConfig(databaseEnvironmentForRole(process.env, 'worker'))
    : applicationConfig;
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    max: 1,
    connectionTimeoutMillis: config.database.connectionTimeoutMs,
    statement_timeout: config.database.statementTimeoutMs,
    application_name: applicationName,
    options: '-c lock_timeout=5000'
  });
  return {
    database: drizzle({ client: pool, schema: commerceSchema }),
    close: () => pool.end()
  };
}

async function createLockFixture(
  options: { assignedPurchase?: boolean } = {}
): Promise<LockFixture> {
  const orderId = randomUUID();
  const itemId = randomUUID();
  const titleId = randomUUID();
  const claimantId = randomUUID();
  const email = `lock-order-${orderId}@example.com`;
  const paymentIntentId = `pi_lock_${orderId}`;
  const stripeDisputeId = `dp_lock_${orderId}`;
  const stripeRefundId = `re_lock_${orderId}`;

  await ownerDatabaseClient.db.insert(user).values({
    id: claimantId,
    name: 'Lock-order reader',
    email,
    emailVerified: true
  });
  const [identity] = await ownerDatabaseClient.db.insert(guestIdentities).values({
    email,
    claimedByUserId: options.assignedPurchase ? claimantId : null,
    claimedAt: options.assignedPurchase ? paidAt : null
  }).returning();
  if (!identity) throw new Error('Expected guest identity');
  await ownerDatabaseClient.db.insert(titles).values({
    id: titleId,
    slug: `lock-order-${titleId}`,
    title: 'Private lock-order title',
    description: 'Private lock-order fixture',
    creatorName: 'Private creator',
    format: 'prose',
    priceMinor: 1403,
    currency: 'USD',
    visibility: 'private'
  });
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    initiatingUserId: null,
    guestIdentityId: identity.id,
    purchaseEmail: email,
    currency: 'USD',
    subtotalMinor: 1403,
    taxMinor: 0,
    totalMinor: 1403,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: `cs_lock_${orderId}`,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt
  });
  await ownerDatabaseClient.db.insert(orderItems).values({
    id: itemId,
    orderId,
    titleId,
    titleSnapshot: 'Private lock-order title',
    creatorNameSnapshot: 'Private creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 1403,
    taxMinor: 0,
    totalMinor: 1403,
    stripeLineItemId: `li_lock_${itemId}`
  });
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: paymentIntentId,
    stripeLatestChargeId: `ch_lock_${orderId}`,
    status: 'succeeded',
    amountMinor: 1403,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt
  }).returning();
  if (!payment) throw new Error('Expected payment');
  const [grant] = await ownerDatabaseClient.db.insert(entitlementGrants).values({
    titleId,
    userId: options.assignedPurchase ? claimantId : null,
    source: 'purchase',
    orderItemId: itemId,
    state: options.assignedPurchase ? 'active' : 'unclaimed',
    stateReason: 'payment_succeeded',
    grantedAt: paidAt
  }).returning();
  if (!grant) throw new Error('Expected purchase grant');
  const [refund] = await ownerDatabaseClient.db.insert(refunds).values({
    paymentId: payment.id,
    stripeRefundId,
    status: 'pending',
    amountMinor: 1403,
    currency: 'USD',
    reason: 'requested_by_customer',
    providerCreatedAt
  }).returning();
  if (!refund) throw new Error('Expected refund');
  const [dispute] = await ownerDatabaseClient.db.insert(disputes).values({
    paymentId: payment.id,
    stripeDisputeId,
    status: 'open',
    amountMinor: 1403,
    currency: 'USD',
    reason: 'fraudulent',
    providerCreatedAt,
    providerUpdatedAt: eventCreatedAt
  }).returning();
  if (!dispute) throw new Error('Expected dispute');

  return {
    claimantId,
    claimantEmail: email,
    disputeId: dispute.id,
    grantId: grant.id,
    itemId,
    orderId,
    paymentId: payment.id,
    paymentIntentId,
    refundId: refund.id,
    stripeDisputeId,
    stripeRefundId,
    titleId
  };
}

async function waitForBlockedRowLock(
  relation:
    | 'entitlement_grants'
    | 'orders'
    | 'refund_allocation_drafts'
    | 'refund_reporting_correction_sets'
    | 'refunds'
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await ownerDatabaseClient.pool.query<{ blocked: boolean }>(`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike $1
      ) as blocked
    `, [`%from "${relation}"%for update%`]);
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected commerce transaction to wait for the held ${relation} row`);
}

async function waitForNamedBlockedQuery(
  applicationName: string,
  expectedQueryFragment: string
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await ownerDatabaseClient.pool.query<{
      query: string;
      wait_event_type: string | null;
    }>(`
      select query, wait_event_type
      from pg_stat_activity
      where datname = current_database()
        and application_name = $1
        and pid <> pg_backend_pid()
    `, [applicationName]);
    const waiting = result.rows.find((row) => row.wait_event_type === 'Lock');
    if (waiting) {
      const normalized = waiting.query.replace(/\s+/gu, ' ').toLowerCase();
      if (!normalized.includes(expectedQueryFragment.toLowerCase())) {
        throw new Error(
          `Expected ${applicationName} to wait in ${expectedQueryFragment}, got ${normalized}`
        );
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Expected ${applicationName} to wait for ${expectedQueryFragment}`
  );
}

async function waitForNamedBlockedQueryWhile<T>(
  operation: Promise<T>,
  applicationName: string,
  expectedQueryFragment: string
): Promise<void> {
  await Promise.race([
    waitForNamedBlockedQuery(applicationName, expectedQueryFragment),
    operation.then(
      () => Promise.reject(new Error(
        `${applicationName} completed before waiting for ${expectedQueryFragment}`
      )),
      (error: unknown) => Promise.reject(error)
    )
  ]);
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
  const pid = result.rows[0]?.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) {
    throw new Error('Expected blocker backend PID');
  }
  return pid;
}

async function waitForNamedBlockedBy(
  applicationName: string,
  blockerPid: number
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await ownerDatabaseClient.pool.query<{
      blocking_pids: number[];
      wait_event_type: string | null;
    }>(`
      select pg_blocking_pids(activity.pid) as blocking_pids, activity.wait_event_type
      from pg_stat_activity activity
      where activity.datname = current_database()
        and activity.application_name = $1
        and activity.pid <> pg_backend_pid()
    `, [applicationName]);
    if (result.rows.some((row) =>
      row.wait_event_type === 'Lock' && row.blocking_pids.includes(blockerPid)
    )) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${applicationName} to wait for blocker PID ${blockerPid}`);
}

function rejectionCode(reason: unknown): string | undefined {
  let current = reason;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string') return record.code;
    current = record.cause;
  }
  return undefined;
}

function assertLockProbeFulfilled(
  labels: readonly string[],
  results: readonly PromiseSettledResult<unknown>[]
): void {
  const rejected = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [{
          label: labels[index] ?? `operation-${index}`,
          code: rejectionCode(result.reason),
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        }]
      : []
  );
  expect(rejected.map((item) => item.code)).not.toContain('40P01');
  if (rejected.length > 0) {
    throw new Error(
      `Lock probe rejected: ${rejected.map((item) =>
        `${item.label}[${item.code ?? 'no-code'}]: ${item.message}`
      ).join('; ')}`
    );
  }
}

async function beginBlocker(refundId: string): Promise<PoolClient> {
  const blocker = await workerDatabaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query('select id from refunds where id = $1 for update', [refundId]);
  return blocker;
}

async function beginOrderBlocker(orderId: string): Promise<PoolClient> {
  const blocker = await ownerDatabaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query('select id from orders where id = $1 for update', [orderId]);
  return blocker;
}

async function beginGrantBlocker(grantId: string): Promise<PoolClient> {
  const blocker = await workerDatabaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query('select id from entitlement_grants where id = $1 for update', [grantId]);
  return blocker;
}

async function beginClaimCreationBlocker(
  refundId: string,
  grantId: string
): Promise<PoolClient> {
  const blocker = await workerDatabaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query('select id from refunds where id = $1 for update', [refundId]);
  await blocker.query('select id from entitlement_grants where id = $1 for update', [grantId]);
  return blocker;
}

async function waitForBlockedLockCount(
  minimum: number,
  applicationNames: readonly string[] = ['pale-orbit']
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await ownerDatabaseClient.pool.query<{ blocked: number }>(`
      select count(*)::int as blocked
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and application_name = any($1::text[])
        and wait_event_type = 'Lock'
    `, [applicationNames]);
    if ((result.rows[0]?.blocked ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected at least ${minimum} blocked commerce transactions`);
}

async function releaseBlocker(blocker: PoolClient): Promise<void> {
  try {
    await blocker.query('rollback');
  } finally {
    blocker.release();
  }
}

async function createDisputeEvent(fixture: LockFixture): Promise<string> {
  const [event] = await ownerDatabaseClient.db.insert(stripeEvents).values({
    providerEventId: `evt_lock_${randomUUID()}`,
    eventType: 'charge.dispute.updated',
    objectId: fixture.stripeDisputeId,
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: eventCreatedAt,
    rawBodySha256: 'c'.repeat(64)
  }).returning();
  if (!event) throw new Error('Expected Stripe event');
  return event.id;
}

function reconcileDispute(
  fixture: LockFixture,
  stripeEventId: string,
  database: Database = workerDatabaseClient.db
): Promise<void> {
  return fulfillDisputeEvent(database, {
    stripeEventId,
    dispute: {
      providerDisputeId: fixture.stripeDisputeId,
      paymentIntentId: fixture.paymentIntentId,
      chargeId: `ch_lock_${fixture.orderId}`,
      liveMode: false,
      state: 'open',
      amountMinor: 1403,
      currency: 'usd',
      reason: 'fraudulent',
      providerCreatedAt,
      balanceTransactionIds: []
    },
    payment: {
      paymentIntentId: fixture.paymentIntentId,
      metadataVersion: '1' as const,
      metadataOrderId: fixture.orderId,
      latestChargeId: `ch_lock_${fixture.orderId}`,
      liveMode: false,
      state: 'succeeded',
      amountMinor: 1403,
      currency: 'usd',
      paidAt,
      paymentMethodCategory: 'card'
    }
  }, {
    messages: { enqueueAccessChange: async () => undefined },
    now: () => new Date('2026-08-10T16:00:00.000Z')
  });
}

async function createRefundEvent(fixture: LockFixture): Promise<string> {
  const [event] = await ownerDatabaseClient.db.insert(stripeEvents).values({
    providerEventId: `evt_lock_refund_${randomUUID()}`,
    eventType: 'refund.updated',
    objectId: fixture.stripeRefundId,
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: eventCreatedAt,
    rawBodySha256: 'd'.repeat(64)
  }).returning();
  if (!event) throw new Error('Expected Stripe refund event');
  return event.id;
}

async function createDraftLockFixture(fixture: LockFixture): Promise<string> {
  const [draft] = await ownerDatabaseClient.db.insert(refundAllocationDrafts).values({
    refundId: fixture.refundId,
    state: 'active',
    version: 1,
    createdByAdminId: fixture.claimantId,
    updatedByAdminId: fixture.claimantId,
    createdCorrelationId: `lock-order-draft-${fixture.refundId}`,
    updatedCorrelationId: `lock-order-draft-${fixture.refundId}`
  }).returning();
  if (!draft) throw new Error('Expected refund-allocation draft');
  await ownerDatabaseClient.db.insert(refundAllocationDraftItems).values({
    draftId: draft.id,
    orderItemId: fixture.itemId,
    proposedTotalPresentmentMinor: 1403
  });
  return draft.id;
}

async function createCorrectionLockFixture(fixture: LockFixture): Promise<string> {
  const sourceFingerprintSha256 = 'e'.repeat(64);
  const [balanceTransaction] = await ownerDatabaseClient.db
    .insert(stripeBalanceTransactions)
    .values({
      providerId: `txn_correction_${fixture.refundId}`,
      liveMode: false,
      sourceFamily: 'refund',
      sourceId: fixture.stripeRefundId,
      rawType: 'refund',
      reportingCategory: 'refund',
      balanceType: 'payments',
      amountMinor: -1403,
      feeMinor: 0,
      netMinor: -1403,
      currency: 'USD',
      status: 'available',
      providerCreatedAt,
      availableAt: providerCreatedAt,
      fingerprintSha256: sourceFingerprintSha256
    })
    .returning();
  if (!balanceTransaction) throw new Error('Expected correction balance transaction');
  const [allocationSet] = await ownerDatabaseClient.db
    .insert(financialAllocationSets)
    .values({
      allocationIdentity: `refund:${fixture.refundId}:gross:1`,
      balanceTransactionId: balanceTransaction.id,
      sourceKind: 'refund',
      sourceInternalId: fixture.refundId,
      basis: 'gross_amount',
      scope: 'title',
      expectedEffectMinor: -1403,
      currency: 'USD',
      algorithmVersion: 1,
      classifierVersion: 1,
      sourceFingerprintSha256
    })
    .returning();
  if (!allocationSet) throw new Error('Expected correction base allocation set');
  const [correctionSet] = await ownerDatabaseClient.db
    .insert(refundReportingCorrectionSets)
    .values({
      refundId: fixture.refundId,
      correctionVersion: 1,
      kind: 'allocation_attribution_correction',
      baseAllocationSetId: allocationSet.id,
      sourceFingerprintSha256,
      approvedByAdminId: fixture.claimantId,
      createdByAdminId: fixture.claimantId,
      correlationId: `lock-order-correction-${fixture.refundId}`
    })
    .returning();
  if (!correctionSet) throw new Error('Expected reporting-correction set');
  await ownerDatabaseClient.db.insert(refundReportingCorrectionItems).values({
    correctionSetId: correctionSet.id,
    domain: 'settlement',
    sourceAllocationSetId: allocationSet.id,
    orderItemId: fixture.itemId,
    component: 'refund_subtotal',
    currency: 'USD',
    approvedAbsoluteMinor: -1403,
    deltaMinor: 0,
    stableTieBreakKey: `${fixture.itemId}:refund_subtotal`
  });
  return correctionSet.id;
}

interface PayoutLockFixture {
  balanceTransactionId: string;
  membershipId: string;
  payoutId: string;
}

async function createPayoutLockFixture(fixture: LockFixture): Promise<PayoutLockFixture> {
  const [balanceTransaction] = await ownerDatabaseClient.db
    .insert(stripeBalanceTransactions)
    .values({
      providerId: `txn_payout_lock_${fixture.paymentId}`,
      liveMode: false,
      sourceFamily: 'charge',
      sourceId: fixture.paymentIntentId,
      rawType: 'charge',
      reportingCategory: 'charge',
      balanceType: 'payments',
      amountMinor: 1403,
      feeMinor: 43,
      netMinor: 1360,
      currency: 'USD',
      status: 'available',
      providerCreatedAt,
      availableAt: providerCreatedAt,
      fingerprintSha256: 'f'.repeat(64)
    })
    .returning();
  if (!balanceTransaction) throw new Error('Expected payout balance transaction');
  const [payout] = await ownerDatabaseClient.db.insert(stripePayouts).values({
    providerId: `po_lock_${fixture.paymentId}`,
    liveMode: false,
    amountMinor: 1360,
    currency: 'USD',
    automatic: true,
    method: 'standard',
    status: 'paid',
    reconciliationStatus: 'completed',
    providerCreatedAt,
    arrivalAt: eventCreatedAt,
    retrievedAt: eventCreatedAt,
    financialGeneration: 1,
    fingerprintSha256: '1'.repeat(64)
  }).returning();
  if (!payout) throw new Error('Expected payout');
  const [run] = await ownerDatabaseClient.db.insert(payoutImportRuns).values({
    payoutId: payout.id,
    generation: 1,
    state: 'published',
    candidateCount: 1,
    pageCount: 1,
    safeOutcome: 'published',
    startedAt: providerCreatedAt,
    updatedAt: eventCreatedAt,
    completedAt: eventCreatedAt
  }).returning();
  if (!run) throw new Error('Expected payout import run');
  const [membership] = await ownerDatabaseClient.db
    .insert(stripePayoutBalanceTransactions)
    .values({
      payoutId: payout.id,
      balanceTransactionId: balanceTransaction.id,
      publishedFromRunId: run.id,
      publishedAt: eventCreatedAt
    })
    .returning();
  if (!membership) throw new Error('Expected payout membership');
  return {
    balanceTransactionId: balanceTransaction.id,
    membershipId: membership.id,
    payoutId: payout.id
  };
}

async function createPendingGuestFulfillmentFixture(
  claimantEmail: string
): Promise<PendingGuestFulfillmentFixture> {
  const suffix = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const titleId = randomUUID();
  const sessionId = `cs_claim_race_${suffix}`;
  const paymentIntentId = `pi_claim_race_${suffix}`;
  const chargeId = `ch_claim_race_${suffix}`;
  const lineItemId = `li_claim_race_${suffix}`;
  const checkoutExpiresAt = new Date('2026-08-10T12:30:00.000Z');

  await ownerDatabaseClient.db.insert(titles).values({
    id: titleId,
    slug: `claim-race-${titleId}`,
    title: 'Claim-race later purchase',
    description: 'Private claim-race fixture',
    creatorName: 'Private creator',
    format: 'prose',
    priceMinor: 1701,
    currency: 'USD',
    visibility: 'private'
  });
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId,
    status: 'checkout_open',
    initiatingUserId: null,
    guestIdentityId: null,
    purchaseEmail: null,
    currency: 'USD',
    subtotalMinor: 1701,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'c'.repeat(64),
    stripeCheckoutSessionId: sessionId,
    statusTokenSha256: 'd'.repeat(64),
    checkoutExpiresAt
  });
  await ownerDatabaseClient.db.insert(orderItems).values({
    id: orderItemId,
    orderId,
    titleId,
    titleSnapshot: 'Claim-race later purchase',
    creatorNameSnapshot: 'Private creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 1701
  });
  const [event] = await ownerDatabaseClient.db.insert(stripeEvents).values({
    providerEventId: `evt_claim_race_${suffix}`,
    eventType: 'checkout.session.async_payment_succeeded',
    objectId: sessionId,
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt,
    rawBodySha256: 'e'.repeat(64),
    status: 'pending'
  }).returning();
  if (!event) throw new Error('Expected claim-race Stripe event');

  return {
    orderId,
    orderItemId,
    stripeEventId: event.id,
    titleId,
    session: {
      providerSessionId: sessionId,
      clientReferenceId: orderId,
      metadataVersion: '1',
      metadataOrderId: orderId,
      liveMode: false,
      mode: 'payment',
      status: 'complete',
      paymentStatus: 'paid',
      paymentIntentId,
      latestChargeId: chargeId,
      customerEmail: claimantEmail,
      currency: 'usd',
      subtotalMinor: 1701,
      taxMinor: 0,
      totalMinor: 1701,
      expiresAt: checkoutExpiresAt,
      lineItems: [{
        providerLineItemId: lineItemId,
        orderItemId,
        quantity: 1,
        currency: 'usd',
        subtotalMinor: 1701,
        taxMinor: 0,
        totalMinor: 1701
      }]
    },
    payment: {
      paymentIntentId,
      metadataVersion: '1',
      metadataOrderId: orderId,
      latestChargeId: chargeId,
      liveMode: false,
      state: 'succeeded',
      amountMinor: 1701,
      currency: 'usd',
      paidAt,
      paymentMethodCategory: 'card'
    }
  };
}

async function beginDraftBlocker(draftId: string): Promise<PoolClient> {
  const blocker = await ownerDatabaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query(
    'select id from refund_allocation_drafts where id = $1 for update',
    [draftId]
  );
  return blocker;
}

async function beginCorrectionBlocker(
  correctionSetId: string,
  grantId: string
): Promise<PoolClient> {
  const blocker = await ownerDatabaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query(
    'select id from refund_reporting_correction_sets where id = $1 for update',
    [correctionSetId]
  );
  await blocker.query(
    'select id from entitlement_grants where id = $1 for update',
    [grantId]
  );
  return blocker;
}

async function beginBalanceTransactionBlocker(
  balanceTransactionId: string
): Promise<PoolClient> {
  const blocker = await workerDatabaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query(
    'select id from stripe_balance_transactions where id = $1 for update',
    [balanceTransactionId]
  );
  return blocker;
}

async function beginEntitlementScopeBlocker(
  userId: string,
  titleId: string
): Promise<PoolClient> {
  const blocker = await ownerDatabaseClient.pool.connect();
  await blocker.query('begin');
  await blocker.query("set local lock_timeout = '5s'");
  await blocker.query(
    'select pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`pale-orbit:commerce:entitlement:${userId}:${titleId}`]
  );
  return blocker;
}

async function lockLatePaymentEntitlements(
  fixture: LockFixture,
  database: Database
): Promise<{
  purchaseGrantIds: readonly string[];
  affectedScopeGrantIds: readonly string[];
}> {
  return database.transaction(async (transaction) => {
    await lockOrder(transaction, fixture.orderId);
    const [order] = await transaction
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.orderId))
      .limit(1)
      .for('update');
    const [payment] = await transaction
      .select()
      .from(payments)
      .where(eq(payments.id, fixture.paymentId))
      .limit(1)
      .for('update');
    if (!order || !payment) throw new Error('Expected locked late-entitlement roots');
    const purchaseFacts = await lockPaymentPurchaseFacts(transaction, payment, order);
    const accessFacts = await lockPaymentEntitlementFacts(transaction, purchaseFacts);
    return {
      purchaseGrantIds: accessFacts.grants.map((grant) => grant.id),
      affectedScopeGrantIds: accessFacts.affectedScopeGrants.map((grant) => grant.id)
    };
  });
}

async function lockPurchaseAccessGraph(
  fixture: LockFixture,
  applicationName: string
): Promise<void> {
  await workerDatabaseClient.db.transaction(async (transaction) => {
    await transaction.execute(sql.raw("set local lock_timeout = '5s'"));
    await transaction.execute(
      sql`select set_config('application_name', ${applicationName}, true)`
    );
    await lockOrder(transaction, fixture.orderId);
    const [order] = await transaction
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.orderId))
      .limit(1)
      .for('update');
    const [payment] = await transaction
      .select()
      .from(payments)
      .where(eq(payments.id, fixture.paymentId))
      .limit(1)
      .for('update');
    if (!order || !payment) throw new Error('Expected locked purchase graph root');
    await lockPaymentAccessFacts(transaction, payment, order);
  });
}

async function lockPayoutAcquisition(
  fixture: PayoutLockFixture,
  applicationName: string
): Promise<void> {
  const client = await workerDatabaseClient.pool.connect();
  let completed = false;
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '5s'");
    await client.query("select set_config('application_name', $1, true)", [applicationName]);
    await client.query('select id from stripe_payouts where id = $1 for update', [
      fixture.payoutId
    ]);
    await client.query(
      'select id from stripe_balance_transactions where id = $1 for update',
      [fixture.balanceTransactionId]
    );
    await client.query(
      'select id from stripe_payout_balance_transactions where id = $1 for update',
      [fixture.membershipId]
    );
    await client.query('commit');
    completed = true;
  } finally {
    if (!completed) await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

async function lockPurchaseFinancialProjection(
  purchase: LockFixture,
  payout: PayoutLockFixture,
  applicationName: string
): Promise<void> {
  await workerDatabaseClient.db.transaction(async (transaction) => {
    await transaction.execute(sql.raw("set local lock_timeout = '5s'"));
    await transaction.execute(
      sql`select set_config('application_name', ${applicationName}, true)`
    );
    await lockOrder(transaction, purchase.orderId);
    const [order] = await transaction
      .select()
      .from(orders)
      .where(eq(orders.id, purchase.orderId))
      .limit(1)
      .for('update');
    const [payment] = await transaction
      .select()
      .from(payments)
      .where(eq(payments.id, purchase.paymentId))
      .limit(1)
      .for('update');
    if (!order || !payment) throw new Error('Expected locked financial purchase graph root');
    await lockPaymentPurchaseFacts(transaction, payment, order);
    await transaction.execute(
      sql`select id from stripe_payouts where id = ${payout.payoutId} for update`
    );
    await transaction.execute(
      sql`select id from stripe_balance_transactions where id = ${payout.balanceTransactionId} for update`
    );
    await transaction.execute(
      sql`select id from stripe_payout_balance_transactions where id = ${payout.membershipId} for update`
    );
  });
}

function reconcileRefund(
  fixture: LockFixture,
  stripeEventId: string,
  database: Database = workerDatabaseClient.db
): Promise<void> {
  return fulfillRefundEvent(database, {
    stripeEventId,
    refund: {
      providerRefundId: fixture.stripeRefundId,
      paymentIntentId: fixture.paymentIntentId,
      liveMode: false,
      state: 'succeeded',
      amountMinor: 1403,
      currency: 'usd',
      reason: 'requested_by_customer',
      providerCreatedAt,
      balanceTransactionId: null,
      failureBalanceTransactionId: null
    },
    payment: {
      paymentIntentId: fixture.paymentIntentId,
      metadataVersion: '1' as const,
      metadataOrderId: fixture.orderId,
      latestChargeId: `ch_lock_${fixture.orderId}`,
      liveMode: false,
      state: 'succeeded',
      amountMinor: 1403,
      currency: 'usd',
      paidAt,
      paymentMethodCategory: 'card'
    }
  }, {
    messages: { enqueueAccessChange: async () => undefined },
    now: () => new Date('2026-08-10T16:00:00.000Z')
  });
}

async function setPreservedGrant(
  fixture: LockFixture,
  database: Database = workerDatabaseClient.db
): Promise<void> {
  await database.transaction(async (transaction) => {
    await setPreservedGrantState(transaction, {
      userId: fixture.claimantId,
      titleId: fixture.titleId,
      active: true,
      stateReason: 'lock_order_regression',
      now: new Date('2026-08-10T15:00:00.000Z')
    });
  });
}

async function expectNoEntitlementDeadlock(
  fixture: LockFixture,
  operation: () => Promise<unknown>,
  claimApplicationName?: string
): Promise<void> {
  await workerDatabaseClient.db.insert(entitlementGrants).values({
    titleId: fixture.titleId,
    userId: fixture.claimantId,
    source: 'preserved',
    state: 'active',
    stateReason: 'lock_order_fixture',
    grantedAt: new Date('2026-08-10T14:30:00.000Z')
  });
  const blocker = await beginGrantBlocker(fixture.grantId);
  let released = false;
  let mutation: Promise<unknown> | undefined;
  let preservation: Promise<void> | undefined;

  try {
    const blockerPid = await backendPid(blocker);
    mutation = operation();
    void mutation.catch(() => undefined);
    if (claimApplicationName) {
      await waitForNamedBlockedBy(claimApplicationName, blockerPid);
    } else {
      await waitForBlockedRowLock('entitlement_grants');
    }
    preservation = setPreservedGrant(fixture);
    void preservation.catch(() => undefined);
    await waitForBlockedLockCount(
      2,
      claimApplicationName ? ['pale-orbit', claimApplicationName] : ['pale-orbit']
    );
    await blocker.query('commit');
    released = true;
    blocker.release();

    const results = await Promise.allSettled([mutation, preservation]);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejected) throw rejected.reason;
  } finally {
    if (!released) await releaseBlocker(blocker).catch(() => undefined);
    await Promise.allSettled(
      mutation === undefined ? [] : preservation ? [mutation, preservation] : [mutation]
    );
  }
}

async function expectNoClaimCreationDeadlock(
  fixture: LockFixture,
  claimDatabase: Database,
  claimApplicationName: string
): Promise<void> {
  const authorizationToken = await createCommerceClaimAuthorization(databaseClient.db, {
    email: fixture.claimantEmail,
    kind: 'password-reset'
  });
  const blocker = await beginClaimCreationBlocker(fixture.refundId, fixture.grantId);
  let released = false;
  let claim: Promise<unknown> | undefined;
  let preservation: Promise<void> | undefined;

  try {
    const blockerPid = await backendPid(blocker);
    claim = claimGuestPurchases(claimDatabase, {
      userId: fixture.claimantId,
      correlationId: `lock-order-new-preserved-claim-${fixture.orderId}`,
      authorizationToken
    });
    void claim.catch(() => undefined);
    await waitForNamedBlockedBy(claimApplicationName, blockerPid);
    preservation = setPreservedGrant(fixture);
    void preservation.catch(() => undefined);
    await preservation;
    await blocker.query('commit');
    released = true;
    blocker.release();

    const results = await Promise.allSettled([claim, preservation]);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejected) throw rejected.reason;
  } finally {
    if (!released) await releaseBlocker(blocker).catch(() => undefined);
    await Promise.allSettled(
      claim === undefined ? [] : preservation ? [claim, preservation] : [claim]
    );
  }
}

describe('commerce transaction lock order', () => {
  it('lets a refund holder lock an item while a guest claim waits on the refund', async () => {
    const fixture = await createLockFixture();
    const authorizationToken = await createCommerceClaimAuthorization(databaseClient.db, {
      email: fixture.claimantEmail,
      kind: 'password-reset'
    });
    const blocker = await beginBlocker(fixture.refundId);
    const claimApplicationName = `plan6b-claim-refund-${fixture.orderId}`;
    const claimDatabase = createBoundedProbeDatabase(claimApplicationName);
    let claim: Promise<unknown> | undefined;

    try {
      const blockerPid = await backendPid(blocker);
      claim = claimGuestPurchases(claimDatabase.database, {
        userId: fixture.claimantId,
        correlationId: `lock-order-claim-${fixture.orderId}`,
        authorizationToken
      });
      void claim.catch(() => undefined);
      await waitForNamedBlockedBy(claimApplicationName, blockerPid);
      await expect(blocker.query(
        'select id from order_items where id = $1 for update',
        [fixture.itemId]
      )).resolves.toBeDefined();
      await blocker.query('commit');
      await expect(claim).resolves.toMatchObject({ claimed: true, changed: true });
      blocker.release();
    } catch (error) {
      await releaseBlocker(blocker).catch(() => undefined);
      await claim?.catch(() => undefined);
      throw error;
    } finally {
      await claimDatabase.close();
    }
  }, 15_000);

  it('lets a refund holder lock a dispute while dispute reconciliation waits on the refund', async () => {
    const fixture = await createLockFixture();
    const stripeEventId = await createDisputeEvent(fixture);
    const blocker = await beginBlocker(fixture.refundId);
    const reconciliation = reconcileDispute(fixture, stripeEventId);
    void reconciliation.catch(() => undefined);

    try {
      await waitForBlockedRowLock('refunds');
      await expect(blocker.query(
        'select id from disputes where id = $1 for update',
        [fixture.disputeId]
      )).resolves.toBeDefined();
      await blocker.query('commit');
      await expect(reconciliation).resolves.toBeUndefined();
      blocker.release();
    } catch (error) {
      await releaseBlocker(blocker).catch(() => undefined);
      await reconciliation.catch(() => undefined);
      throw error;
    }
  }, 15_000);

  it('lets an order holder lock its payment while reconciliation waits on the order', async () => {
    const fixture = await createLockFixture();
    const stripeEventId = await createDisputeEvent(fixture);
    const blocker = await beginOrderBlocker(fixture.orderId);
    const reconciliation = reconcileDispute(fixture, stripeEventId);
    void reconciliation.catch(() => undefined);

    try {
      await waitForBlockedRowLock('orders');
      await expect(blocker.query(
        'select id from payments where id = $1 for update',
        [fixture.paymentId]
      )).resolves.toBeDefined();
      await blocker.query('commit');
      await expect(reconciliation).resolves.toBeUndefined();
      blocker.release();
    } catch (error) {
      await releaseBlocker(blocker).catch(() => undefined);
      await reconciliation.catch(() => undefined);
      throw error;
    }
  }, 15_000);

  it('serializes refund reconciliation with preserved-grant changes without deadlocking', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });
    const stripeEventId = await createRefundEvent(fixture);

    await expectNoEntitlementDeadlock(
      fixture,
      () => reconcileRefund(fixture, stripeEventId)
    );
  }, 15_000);

  it('serializes dispute reconciliation with preserved-grant changes without deadlocking', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });
    const stripeEventId = await createDisputeEvent(fixture);

    await expectNoEntitlementDeadlock(
      fixture,
      () => reconcileDispute(fixture, stripeEventId)
    );
  }, 15_000);

  it('serializes guest claims with preserved-grant changes without deadlocking', async () => {
    const fixture = await createLockFixture();
    const authorizationToken = await createCommerceClaimAuthorization(databaseClient.db, {
      email: fixture.claimantEmail,
      kind: 'password-reset'
    });

    const claimApplicationName = `plan6b-claim-preserved-${fixture.orderId}`;
    const claimDatabase = createBoundedProbeDatabase(claimApplicationName);
    try {
      await expectNoEntitlementDeadlock(
        fixture,
        () => claimGuestPurchases(claimDatabase.database, {
          userId: fixture.claimantId,
          correlationId: `lock-order-preserved-claim-${fixture.orderId}`,
          authorizationToken
        }),
        claimApplicationName
      );
    } finally {
      await claimDatabase.close();
    }
  }, 15_000);

  it('serializes guest claims with preserved-grant creation without deadlocking', async () => {
    const fixture = await createLockFixture();
    const claimApplicationName = `plan6b-claim-creation-${fixture.orderId}`;
    const claimDatabase = createBoundedProbeDatabase(claimApplicationName);
    try {
      await expectNoClaimCreationDeadlock(
        fixture,
        claimDatabase.database,
        claimApplicationName
      );
    } finally {
      await claimDatabase.close();
    }
  }, 15_000);

  it('keeps claim-email delivery ahead of claims on the identity-before-order sequence', async () => {
    const fixture = await createLockFixture();
    const authorizationToken = await createCommerceClaimAuthorization(databaseClient.db, {
      email: fixture.claimantEmail,
      kind: 'password-reset'
    });
    const blocker = await beginOrderBlocker(fixture.orderId);
    let blockerReleased = false;
    const messages = createCommerceMessageEnqueuer(applicationConfig.origin);
    const delivery = queueCommerceClaimEmail(workerDatabaseClient.db, messages, {
      orderId: fixture.orderId,
      email: fixture.claimantEmail,
      claimUrl: createCommerceMagicClaimBridgeFixture(
        fixture.orderId,
        applicationConfig.origin
      )
    });
    let claim: Promise<unknown> | undefined;
    void delivery.catch(() => undefined);

    try {
      await waitForBlockedRowLock('orders');
      claim = claimGuestPurchases(databaseClient.db, {
        userId: fixture.claimantId,
        correlationId: `lock-order-claim-email-${fixture.orderId}`,
        authorizationToken
      });
      void claim.catch(() => undefined);
      await waitForBlockedLockCount(2);
      await blocker.query('commit');
      blocker.release();
      blockerReleased = true;

      assertLockProbeFulfilled(
        ['claim-email delivery', 'guest claim'],
        await Promise.allSettled([delivery, claim])
      );
    } finally {
      if (!blockerReleased) await releaseBlocker(blocker).catch(() => undefined);
      await Promise.allSettled(claim ? [delivery, claim] : [delivery]);
    }
  }, 15_000);

  it('keeps a later guest fulfillment behind claim and assigns it to the committed claimant', async () => {
    const fixture = await createLockFixture();
    const later = await createPendingGuestFulfillmentFixture(fixture.claimantEmail);
    const authorizationToken = await createCommerceClaimAuthorization(databaseClient.db, {
      email: fixture.claimantEmail,
      kind: 'password-reset'
    });
    const blocker = await beginOrderBlocker(fixture.orderId);
    let blockerReleased = false;
    const claimApplicationName = `plan6b-claim-later-${fixture.orderId}`;
    const claimDatabase = createBoundedProbeDatabase(claimApplicationName);
    const applicationName = `plan6b-claim-fulfillment-${later.orderId}`;
    const fulfillmentDatabase = createBoundedProbeDatabase(applicationName, 'worker');
    const messages = {
      accountReceipts: [] as string[],
      guestClaimPreparations: [] as string[],
      guestReceiptsWithoutClaim: [] as string[]
    };
    let claim: Promise<unknown> | undefined;
    let fulfillment: Promise<void> | undefined;

    try {
      const blockerPid = await backendPid(blocker);
      claim = claimGuestPurchases(claimDatabase.database, {
        userId: fixture.claimantId,
        correlationId: `lock-order-claim-fulfillment-${fixture.orderId}`,
        authorizationToken
      });
      void claim.catch(() => undefined);
      await waitForNamedBlockedBy(claimApplicationName, blockerPid);
      fulfillment = fulfillCheckoutEvent(fulfillmentDatabase.database, {
        stripeEventId: later.stripeEventId,
        session: later.session,
        payment: later.payment
      }, {
        purchaseMessages: {
          async enqueueAccountReceipt(_transaction, orderId) {
            messages.accountReceipts.push(orderId);
          },
          async enqueueGuestClaimPreparation(_transaction, orderId) {
            messages.guestClaimPreparations.push(orderId);
          },
          async enqueueGuestReceiptWithoutClaim(_transaction, orderId) {
            messages.guestReceiptsWithoutClaim.push(orderId);
          }
        }
      });
      void fulfillment.catch(() => undefined);
      await waitForNamedBlockedQuery(applicationName, 'from "guest_identities"');

      await expect(blocker.query(
        'select id from orders where id = $1 for update',
        [later.orderId]
      )).resolves.toBeDefined();
      await blocker.query('commit');
      blocker.release();
      blockerReleased = true;

      const [claimResult] = await Promise.all([claim, fulfillment]);
      expect(claimResult).toMatchObject({ claimed: true, changed: true });

      const [storedOrder] = await ownerDatabaseClient.db.select().from(orders)
        .where(eq(orders.id, later.orderId)).limit(1);
      const [storedGrant] = await ownerDatabaseClient.db.select().from(entitlementGrants)
        .where(eq(entitlementGrants.orderItemId, later.orderItemId)).limit(1);
      const [storedEntitlement] = await ownerDatabaseClient.db.select().from(entitlements)
        .where(and(
          eq(entitlements.userId, fixture.claimantId),
          eq(entitlements.titleId, later.titleId)
        )).limit(1);
      const [fulfillmentAudit] = await ownerDatabaseClient.db.select().from(auditEvents)
        .where(and(
          eq(auditEvents.action, 'commerce.fulfillment_paid'),
          eq(auditEvents.resourceId, later.orderId)
        )).limit(1);
      expect(storedOrder).toMatchObject({
        status: 'paid',
        guestIdentityId: expect.any(String),
        purchaseEmail: fixture.claimantEmail
      });
      expect(storedGrant).toMatchObject({
        userId: fixture.claimantId,
        state: 'active',
        stateReason: 'payment_succeeded'
      });
      expect(storedEntitlement).toMatchObject({ revokedAt: null });
      expect(fulfillmentAudit?.after).toMatchObject({ ownerType: 'account' });
      expect(messages).toEqual({
        accountReceipts: [],
        guestClaimPreparations: [],
        guestReceiptsWithoutClaim: [later.orderId]
      });
    } finally {
      if (!blockerReleased) await releaseBlocker(blocker).catch(() => undefined);
      await Promise.allSettled(
        claim === undefined ? [] : fulfillment ? [claim, fulfillment] : [claim]
      );
      await Promise.allSettled([fulfillmentDatabase.close(), claimDatabase.close()]);
    }
  }, 15_000);

  it('keeps refund/dispute ingestion behind a finalization-shaped purchase graph', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });
    const draftId = await createDraftLockFixture(fixture);
    const disputeEventId = await createDisputeEvent(fixture);
    const refundEventId = await createRefundEvent(fixture);
    const blocker = await beginDraftBlocker(draftId);
    let blockerReleased = false;
    const finalizationName = `plan6b-finalization-${fixture.orderId}`;
    const disputeName = `plan6b-dispute-ingest-${fixture.orderId}`;
    const refundName = `plan6b-refund-ingest-${fixture.orderId}`;
    const disputeDatabase = createBoundedProbeDatabase(disputeName, 'worker');
    const refundDatabase = createBoundedProbeDatabase(refundName, 'worker');
    const finalization = lockPurchaseAccessGraph(fixture, finalizationName);
    let disputeIngestion: Promise<void> | undefined;
    let refundIngestion: Promise<void> | undefined;
    void finalization.catch(() => undefined);

    try {
      await waitForNamedBlockedQuery(finalizationName, 'from "refund_allocation_drafts"');
      disputeIngestion = reconcileDispute(
        fixture,
        disputeEventId,
        disputeDatabase.database
      );
      refundIngestion = reconcileRefund(fixture, refundEventId, refundDatabase.database);
      void disputeIngestion.catch(() => undefined);
      void refundIngestion.catch(() => undefined);
      await Promise.all([
        waitForNamedBlockedQuery(disputeName, 'pg_advisory_xact_lock'),
        waitForNamedBlockedQuery(refundName, 'pg_advisory_xact_lock')
      ]);
      await blocker.query('commit');
      blocker.release();
      blockerReleased = true;

      assertLockProbeFulfilled(
        ['refund-finalization-shaped graph', 'dispute ingestion', 'refund ingestion'],
        await Promise.allSettled([finalization, disputeIngestion, refundIngestion])
      );
    } finally {
      if (!blockerReleased) await releaseBlocker(blocker).catch(() => undefined);
      await Promise.allSettled([
        finalization,
        ...(disputeIngestion ? [disputeIngestion] : []),
        ...(refundIngestion ? [refundIngestion] : [])
      ]);
      await Promise.allSettled([disputeDatabase.close(), refundDatabase.close()]);
    }
  }, 15_000);

  it('keeps entitlement projection behind a correction-shaped purchase graph', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });
    const correctionSetId = await createCorrectionLockFixture(fixture);
    const blocker = await beginCorrectionBlocker(correctionSetId, fixture.grantId);
    let blockerReleased = false;
    const correctionName = `plan6b-correction-${fixture.orderId}`;
    const projectionName = `plan6b-entitlement-${fixture.orderId}`;
    const projectionDatabase = createBoundedProbeDatabase(projectionName, 'worker');
    const correction = lockPurchaseAccessGraph(fixture, correctionName);
    let projection: Promise<void> | undefined;
    void correction.catch(() => undefined);

    try {
      await waitForNamedBlockedQuery(
        correctionName,
        'from "refund_reporting_correction_sets"'
      );
      projection = setPreservedGrant(fixture, projectionDatabase.database);
      void projection.catch(() => undefined);
      await waitForNamedBlockedQuery(projectionName, 'from "entitlement_grants"');
      await blocker.query('commit');
      blocker.release();
      blockerReleased = true;

      assertLockProbeFulfilled(
        ['correction-shaped graph', 'entitlement projection'],
        await Promise.allSettled([correction, projection])
      );
    } finally {
      if (!blockerReleased) await releaseBlocker(blocker).catch(() => undefined);
      await Promise.allSettled(projection ? [correction, projection] : [correction]);
      await projectionDatabase.close();
    }
  }, 15_000);

  it('shares payout-before-balance-transaction order with purchase financial projection', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });
    const payoutFixture = await createPayoutLockFixture(fixture);
    const blocker = await beginBalanceTransactionBlocker(payoutFixture.balanceTransactionId);
    let blockerReleased = false;
    const payoutName = `plan6b-payout-acquisition-${fixture.orderId}`;
    const purchaseName = `plan6b-purchase-financial-${fixture.orderId}`;
    const payoutAcquisition = lockPayoutAcquisition(payoutFixture, payoutName);
    let purchaseProjection: Promise<void> | undefined;
    void payoutAcquisition.catch(() => undefined);

    try {
      await waitForNamedBlockedQuery(
        payoutName,
        'from stripe_balance_transactions'
      );
      purchaseProjection = lockPurchaseFinancialProjection(
        fixture,
        payoutFixture,
        purchaseName
      );
      void purchaseProjection.catch(() => undefined);
      await waitForNamedBlockedQuery(purchaseName, 'from stripe_payouts');
      await blocker.query('commit');
      blocker.release();
      blockerReleased = true;

      assertLockProbeFulfilled(
        ['payout/BT acquisition', 'purchase financial projection'],
        await Promise.allSettled([payoutAcquisition, purchaseProjection])
      );
    } finally {
      if (!blockerReleased) await releaseBlocker(blocker).catch(() => undefined);
      await Promise.allSettled(
        purchaseProjection
          ? [payoutAcquisition, purchaseProjection]
          : [payoutAcquisition]
      );
    }
  }, 15_000);

  it('locks the complete affected entitlement-grant union by global grant ID', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });
    const preservedGrantId = '00000000-0000-4000-8000-000000000001';
    await ownerDatabaseClient.db.insert(entitlementGrants).values({
      id: preservedGrantId,
      titleId: fixture.titleId,
      userId: fixture.claimantId,
      source: 'preserved',
      state: 'active',
      stateReason: 'late_lock_union_fixture',
      grantedAt: paidAt
    });
    const blocker = await beginGrantBlocker(preservedGrantId);
    const applicationName = `plan6b-late-union-${fixture.orderId}`;
    const probeDatabase = createBoundedProbeDatabase(applicationName, 'worker');
    let lateLock: ReturnType<typeof lockLatePaymentEntitlements> | undefined;
    let blockerReleased = false;

    try {
      lateLock = lockLatePaymentEntitlements(fixture, probeDatabase.database);
      void lateLock.catch(() => undefined);
      await waitForNamedBlockedQueryWhile(
        lateLock,
        applicationName,
        'from "entitlement_grants"'
      );
      await blocker.query('commit');
      blocker.release();
      blockerReleased = true;

      await expect(lateLock).resolves.toEqual({
        purchaseGrantIds: [fixture.grantId],
        affectedScopeGrantIds: [preservedGrantId, fixture.grantId].sort()
      });
    } finally {
      if (!blockerReleased) await releaseBlocker(blocker).catch(() => undefined);
      await Promise.allSettled(lateLock ? [lateLock] : []);
      await probeDatabase.close();
    }
  }, 15_000);

  it('waits for every claimed entitlement scope before locking any purchase grant', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });
    const scopeBlocker = await beginEntitlementScopeBlocker(
      fixture.claimantId,
      fixture.titleId
    );
    const applicationName = `plan6b-late-scope-${fixture.orderId}`;
    const probeDatabase = createBoundedProbeDatabase(applicationName, 'worker');
    let lateLock: ReturnType<typeof lockLatePaymentEntitlements> | undefined;
    let scopeReleased = false;

    try {
      lateLock = lockLatePaymentEntitlements(fixture, probeDatabase.database);
      void lateLock.catch(() => undefined);
      await waitForNamedBlockedQueryWhile(
        lateLock,
        applicationName,
        'pg_advisory_xact_lock'
      );

      const grantProbe = await ownerDatabaseClient.pool.connect();
      try {
        await grantProbe.query('begin');
        await grantProbe.query("set local lock_timeout = '1s'");
        await grantProbe.query(
          'select id from entitlement_grants where id = $1 for update',
          [fixture.grantId]
        );
        await grantProbe.query('commit');
      } finally {
        await grantProbe.query('rollback').catch(() => undefined);
        grantProbe.release();
      }

      await scopeBlocker.query('commit');
      scopeBlocker.release();
      scopeReleased = true;
      await expect(lateLock).resolves.toMatchObject({
        purchaseGrantIds: [fixture.grantId]
      });
    } finally {
      if (!scopeReleased) await releaseBlocker(scopeBlocker).catch(() => undefined);
      await Promise.allSettled(lateLock ? [lateLock] : []);
      await probeDatabase.close();
    }
  }, 15_000);

  it('revalidates purchase-grant provenance after acquiring entitlement scopes', async () => {
    const fixture = await createLockFixture({ assignedPurchase: true });
    const scopeBlocker = await beginEntitlementScopeBlocker(
      fixture.claimantId,
      fixture.titleId
    );
    const applicationName = `plan6b-late-revalidate-${fixture.orderId}`;
    const probeDatabase = createBoundedProbeDatabase(applicationName, 'worker');
    let lateLock: ReturnType<typeof lockLatePaymentEntitlements> | undefined;
    let scopeReleased = false;

    try {
      lateLock = lockLatePaymentEntitlements(fixture, probeDatabase.database);
      void lateLock.catch(() => undefined);
      await waitForNamedBlockedQueryWhile(
        lateLock,
        applicationName,
        'pg_advisory_xact_lock'
      );
      await ownerDatabaseClient.db
        .update(entitlementGrants)
        .set({ userId: null, state: 'unclaimed' })
        .where(eq(entitlementGrants.id, fixture.grantId));
      await scopeBlocker.query('commit');
      scopeBlocker.release();
      scopeReleased = true;

      await expect(lateLock).rejects.toThrow();
    } finally {
      if (!scopeReleased) await releaseBlocker(scopeBlocker).catch(() => undefined);
      await Promise.allSettled(lateLock ? [lateLock] : []);
      await probeDatabase.close();
    }
  }, 15_000);
});
