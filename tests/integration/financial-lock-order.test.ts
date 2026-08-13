import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { appendClassificationDecisionLocked } from '$lib/server/commerce/financial/classification';
import { FINANCIAL_CLASSIFIER_VERSION } from '$lib/server/commerce/financial/constants';
import { stageBalanceTransaction } from '$lib/server/commerce/financial/ledger';
import {
  lockFinancialProjectionRows,
  lockPayoutImportRows,
  type FinancialProjectionLockInput
} from '$lib/server/commerce/financial/locks';
import { setPreservedGrantState } from '$lib/server/commerce/grants';
import { lockEntitlementScopes, lockOrder } from '$lib/server/commerce/lock';
import { lockPaymentPurchaseFacts } from '$lib/server/commerce/reconciliation';
import {
  entitlementGrants,
  orderItems,
  orders,
  payments,
  payoutImportRunEntries,
  payoutImportRuns,
  refunds,
  stripeBalanceTransactions,
  stripePayoutBalanceTransactions,
  stripePayouts,
  titles,
  user
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { databaseClient } from './database';

const fixtureTime = new Date('2026-08-01T00:00:00.000Z');
const LOCK_PROBE_REPETITIONS = [1, 2, 3] as const;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface PurchaseFixture {
  readonly grantId: string;
  readonly orderId: string;
  readonly paymentId: string;
  readonly refundId: string;
  readonly stripeRefundId: string;
  readonly titleId: string;
  readonly userId: string;
}

interface PayoutFixture {
  readonly payoutId: string;
  readonly runId: string;
  readonly generation: number;
}

interface Blocker {
  readonly client: PoolClient;
  readonly pid: number;
  released: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function probeName(prefix: string, id: string): string {
  return `${prefix}-${id.slice(0, 12)}`;
}

function snapshot(input: {
  sourceFamily?: 'charge' | 'refund';
  sourceId?: string;
  amountMinor?: number;
  feeMinor?: number;
}) {
  const suffix = randomUUID();
  const sourceFamily = input.sourceFamily ?? 'charge';
  const amountMinor = input.amountMinor ?? 100;
  const feeMinor = input.feeMinor ?? 10;
  return {
    id: `txn_lock_${suffix}`,
    livemode: false,
    sourceId: input.sourceId ?? `${sourceFamily}_lock_${suffix}`,
    sourceFamily,
    rawType: sourceFamily,
    reportingCategory: sourceFamily,
    amountMinor,
    feeMinor,
    netMinor: amountMinor - feeMinor,
    currency: 'USD',
    status: 'available' as const,
    balanceType: 'payments',
    createdAt: fixtureTime,
    availableAt: new Date('2026-08-02T00:00:00.000Z'),
    exchangeRate: null,
    exchangeSourceCurrency: null,
    exchangeTargetCurrency: null,
    feeDetails: feeMinor === 0
      ? []
      : [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: feeMinor, currency: 'USD' }]
  };
}

async function configureProbe(
  tx: DatabaseTransaction,
  applicationName: string,
  entered?: Deferred<number>
): Promise<number> {
  await tx.execute(sql`select set_config('application_name', ${applicationName}, true)`);
  await tx.execute(sql`select set_config('lock_timeout', '5s', true)`);
  const result = await tx.execute(sql`select pg_backend_pid() as pid`);
  const pid = (result as { rows?: Array<{ pid?: number }> }).rows?.[0]?.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) throw new Error('missing backend pid');
  entered?.resolve(pid);
  return pid;
}

function observe(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

function rejectionCode(reason: unknown): string | undefined {
  let current = reason;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string') return record.code;
    current = record.cause;
  }
  return undefined;
}

function assertFulfilled(
  labels: readonly string[],
  results: readonly PromiseSettledResult<unknown>[]
): void {
  const rejected = results.flatMap((result, index) => result.status === 'rejected'
    ? [{
        label: labels[index] ?? `operation-${index}`,
        code: rejectionCode(result.reason),
        message: result.reason instanceof Error ? result.reason.message : String(result.reason)
      }]
    : []);
  expect(rejected.map((item) => item.code)).not.toContain('40P01');
  expect(rejected).toEqual([]);
}

async function waitForBlockedQuery(
  pid: number,
  applicationName: string,
  queryFragment: string
): Promise<readonly number[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await databaseClient.pool.query<{
      blockers: number[];
      query: string;
      waitEventType: string | null;
    }>(`
      select pg_blocking_pids(pid) as blockers, query, wait_event_type as "waitEventType"
      from pg_stat_activity
      where pid = $1 and application_name = $2
    `, [pid, applicationName]);
    const row = result.rows[0];
    if (row?.waitEventType === 'Lock') {
      const normalized = row.query.replace(/\s+/gu, ' ').toLowerCase();
      expect(normalized).toContain(queryFragment.toLowerCase());
      return row.blockers;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${applicationName} to block in ${queryFragment}`);
}

async function waitForBlockedOperation(
  operation: Promise<unknown>,
  pid: number,
  applicationName: string,
  queryFragment: string
): Promise<readonly number[]> {
  return Promise.race([
    waitForBlockedQuery(pid, applicationName, queryFragment),
    operation.then(
      () => { throw new Error(`${applicationName} completed before reaching ${queryFragment}`); },
      (error: unknown) => { throw error; }
    )
  ]);
}

async function beginBlocker(
  applicationName: string,
  query: string,
  parameters: readonly unknown[]
): Promise<Blocker> {
  const client = await databaseClient.pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('application_name', $1, true)", [applicationName]);
    await client.query("select set_config('lock_timeout', '5s', true)");
    const pidResult = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    const pid = pidResult.rows[0]?.pid;
    if (typeof pid !== 'number') throw new Error('missing blocker pid');
    await client.query(query, [...parameters]);
    return { client, pid, released: false };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    client.release();
    throw error;
  }
}

async function releaseBlocker(blocker: Blocker): Promise<void> {
  if (blocker.released) return;
  blocker.released = true;
  try {
    await blocker.client.query('rollback');
  } finally {
    blocker.client.release();
  }
}

async function createPurchaseFixture(sourceId: string): Promise<PurchaseFixture> {
  const userId = randomUUID();
  const titleId = randomUUID();
  const orderId = randomUUID();
  const itemId = randomUUID();
  const email = `financial-lock-${orderId}@example.com`;
  const stripeRefundId = `re_lock_${randomUUID()}`;
  await databaseClient.db.insert(user).values({
    id: userId,
    name: 'Financial lock reader',
    email,
    emailVerified: true
  });
  await databaseClient.db.insert(titles).values({
    id: titleId,
    slug: `financial-lock-${titleId}`,
    title: 'Financial lock title',
    description: 'Financial lock topology fixture',
    creatorName: 'Financial lock creator',
    format: 'prose',
    priceMinor: 100,
    currency: 'USD',
    visibility: 'private'
  });
  await databaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    initiatingUserId: userId,
    purchaseEmail: email,
    currency: 'USD',
    subtotalMinor: 100,
    taxMinor: 0,
    totalMinor: 100,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: `cs_lock_${randomUUID()}`,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-01T00:30:00.000Z'),
    paidAt: fixtureTime
  });
  await databaseClient.db.insert(orderItems).values({
    id: itemId,
    orderId,
    titleId,
    titleSnapshot: 'Financial lock title',
    creatorNameSnapshot: 'Financial lock creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 100,
    taxMinor: 0,
    totalMinor: 100,
    stripeLineItemId: `li_lock_${randomUUID()}`
  });
  const [payment] = await databaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: `pi_lock_${randomUUID()}`,
    stripeLatestChargeId: sourceId,
    status: 'succeeded',
    amountMinor: 100,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt: fixtureTime
  }).returning();
  if (!payment) throw new Error('Expected payment fixture');
  const [refund] = await databaseClient.db.insert(refunds).values({
    paymentId: payment.id,
    stripeRefundId,
    status: 'pending',
    amountMinor: 100,
    currency: 'USD',
    reason: 'requested_by_customer',
    providerCreatedAt: fixtureTime
  }).returning();
  if (!refund) throw new Error('Expected refund fixture');
  const [grant] = await databaseClient.db.insert(entitlementGrants).values({
    titleId,
    userId,
    source: 'purchase',
    orderItemId: itemId,
    state: 'active',
    stateReason: 'payment_succeeded',
    grantedAt: fixtureTime
  }).returning();
  if (!grant) throw new Error('Expected entitlement fixture');
  return {
    grantId: grant.id,
    orderId,
    paymentId: payment.id,
    refundId: refund.id,
    stripeRefundId,
    titleId,
    userId
  };
}

async function createPayoutFixture(
  balanceTransactionIds: readonly string[],
  publishMemberships: boolean,
  runState: 'publishable' | 'published' = 'published'
): Promise<PayoutFixture> {
  const generation = 1;
  const [payout] = await databaseClient.db.insert(stripePayouts).values({
    providerId: `po_lock_${randomUUID()}`,
    liveMode: false,
    amountMinor: Math.max(90, balanceTransactionIds.length * 90),
    currency: 'USD',
    automatic: true,
    method: 'standard',
    status: 'paid',
    reconciliationStatus: 'completed',
    providerCreatedAt: fixtureTime,
    arrivalAt: fixtureTime,
    retrievedAt: fixtureTime,
    financialGeneration: generation,
    fingerprintSha256: 'd'.repeat(64)
  }).returning();
  if (!payout) throw new Error('Expected payout fixture');
  const [run] = await databaseClient.db.insert(payoutImportRuns).values({
    payoutId: payout.id,
    generation,
    state: runState,
    candidateCount: balanceTransactionIds.length,
    pageCount: 1,
    safeOutcome: runState === 'published' ? 'published' : null,
    startedAt: fixtureTime,
    updatedAt: fixtureTime,
    completedAt: runState === 'published' ? fixtureTime : null
  }).returning();
  if (!run) throw new Error('Expected payout run fixture');
  if (balanceTransactionIds.length > 0) {
    await databaseClient.db.insert(payoutImportRunEntries).values(
      balanceTransactionIds.map((balanceTransactionId) => ({
        runId: run.id,
        balanceTransactionId
      }))
    );
  }
  if (publishMemberships && balanceTransactionIds.length > 0) {
    await databaseClient.db.insert(stripePayoutBalanceTransactions).values(
      balanceTransactionIds.map((balanceTransactionId) => ({
        payoutId: payout.id,
        balanceTransactionId,
        publishedFromRunId: run.id,
        publishedAt: fixtureTime
      }))
    );
  }
  return { payoutId: payout.id, runId: run.id, generation };
}

async function lockPurchaseFinancialProjection(
  applicationName: string,
  purchase: PurchaseFixture,
  input: FinancialProjectionLockInput,
  entered?: Deferred<number>,
  lockEntitlement = false
): Promise<void> {
  await databaseClient.db.transaction(async (tx) => {
    await configureProbe(tx, applicationName, entered);
    await lockOrder(tx, purchase.orderId);
    const [order] = await tx.select().from(orders).where(eq(orders.id, purchase.orderId)).for('update');
    const [payment] = await tx.select().from(payments).where(eq(payments.id, purchase.paymentId)).for('update');
    if (!order || !payment) throw new Error('Expected purchase graph roots');
    await lockPaymentPurchaseFacts(tx, payment, order);
    await lockFinancialProjectionRows(tx, input);
    if (lockEntitlement) {
      await lockEntitlementScopes(tx, [{ userId: purchase.userId, titleId: purchase.titleId }]);
      await tx.select({ id: entitlementGrants.id })
        .from(entitlementGrants)
        .where(and(
          eq(entitlementGrants.userId, purchase.userId),
          eq(entitlementGrants.titleId, purchase.titleId)
        ))
        .orderBy(asc(entitlementGrants.id))
        .for('update');
    }
  });
}

async function lockPayoutImpactProjection(
  applicationName: string,
  purchase: PurchaseFixture,
  payout: PayoutFixture,
  entered: Deferred<number>
): Promise<void> {
  const memberships = await databaseClient.db.select({
    balanceTransactionId: stripePayoutBalanceTransactions.balanceTransactionId
  }).from(stripePayoutBalanceTransactions)
    .where(eq(stripePayoutBalanceTransactions.payoutId, payout.payoutId));
  if (memberships.length === 0) throw new Error('Expected payout-impact membership discovery');
  await lockPurchaseFinancialProjection(applicationName, purchase, {
    payoutGenerations: [{ payoutId: payout.payoutId, expectedGeneration: payout.generation }],
    balanceTransactionIds: memberships.map((row) => row.balanceTransactionId),
    classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
    issueKeys: []
  }, entered);
}

async function replayClassification(
  applicationName: string,
  balanceTransactionId: string,
  fingerprint: string,
  entered: Deferred<number>
): Promise<void> {
  await databaseClient.db.transaction(async (tx) => {
    await configureProbe(tx, applicationName, entered);
    await appendClassificationDecisionLocked(tx, {
      subjectType: 'balance_transaction',
      subjectId: balanceTransactionId,
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      sourceFingerprint: fingerprint,
      decision: { status: 'classified', classification: 'charge', impact: 'informational' },
      correlationId: 'financial-lock-classifier-replay'
    });
  });
}

async function publishPayout(
  applicationName: string,
  payout: PayoutFixture,
  entered: Deferred<number>
): Promise<void> {
  await databaseClient.db.transaction(async (tx) => {
    await configureProbe(tx, applicationName, entered);
    await lockPayoutImportRows(tx, {
      payoutId: payout.payoutId,
      runId: payout.runId,
      expectedGeneration: payout.generation
    });
  });
}

async function mutateEntitlement(
  applicationName: string,
  purchase: PurchaseFixture,
  entered: Deferred<number>
): Promise<void> {
  await databaseClient.db.transaction(async (tx) => {
    await configureProbe(tx, applicationName, entered);
    await setPreservedGrantState(tx, {
      userId: purchase.userId,
      titleId: purchase.titleId,
      active: true,
      stateReason: 'financial_lock_probe',
      now: fixtureTime
    });
  });
}

describe('financial lock repetition contract', () => {
  it('runs each deterministic topology repeatedly within a small fixed bound', () => {
    expect(LOCK_PROBE_REPETITIONS.length).toBeGreaterThan(1);
    expect(LOCK_PROBE_REPETITIONS.length).toBeLessThanOrEqual(3);
  });
});

describe.each(LOCK_PROBE_REPETITIONS)('financial lock ordering (repetition %i)', () => {
  it('keeps payout-impact source work behind the payment purchase graph before payout locks', async () => {
    const source = snapshot({});
    const purchase = await createPurchaseFixture(source.sourceId);
    const staged = await stageBalanceTransaction(databaseClient.db, source, { correlationId: 'locks-source-payout' });
    const payout = await createPayoutFixture([staged.balanceTransactionId], true);
    const blocker = await beginBlocker(
      probeName('source-payout-blocker', purchase.orderId),
      'select id from stripe_payouts where id = $1 for update',
      [payout.payoutId]
    );
    const sourceName = probeName('payment-source', purchase.orderId);
    const impactName = probeName('payout-impact', purchase.orderId);
    const sourceEntered = deferred<number>();
    const impactEntered = deferred<number>();
    let sourceProjection: Promise<void> | undefined;
    let impactProjection: Promise<void> | undefined;
    try {
      sourceProjection = lockPurchaseFinancialProjection(sourceName, purchase, {
        payoutGenerations: [{ payoutId: payout.payoutId, expectedGeneration: payout.generation }],
        balanceTransactionIds: [staged.balanceTransactionId],
        classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
        issueKeys: []
      }, sourceEntered);
      observe(sourceProjection);
      const sourcePid = await sourceEntered.promise;
      expect(await waitForBlockedQuery(sourcePid, sourceName, 'from stripe_payouts')).toContain(blocker.pid);

      impactProjection = lockPayoutImpactProjection(impactName, purchase, payout, impactEntered);
      observe(impactProjection);
      const impactPid = await impactEntered.promise;
      expect(await waitForBlockedQuery(impactPid, impactName, 'pg_advisory_xact_lock')).toContain(sourcePid);

      await releaseBlocker(blocker);
      assertFulfilled(
        ['payment source projection', 'payout-impact projection'],
        await Promise.allSettled([sourceProjection, impactProjection])
      );
    } finally {
      await releaseBlocker(blocker).catch(() => undefined);
      await Promise.allSettled([
        ...(sourceProjection ? [sourceProjection] : []),
        ...(impactProjection ? [impactProjection] : [])
      ]);
    }
  }, 15_000);

  it('keeps classifier replay at balance-transaction then classification while source replay waits at the balance transaction', async () => {
    const source = snapshot({});
    const purchase = await createPurchaseFixture(source.sourceId);
    const staged = await stageBalanceTransaction(databaseClient.db, source, { correlationId: 'locks-classifier-source' });
    const [balanceTransaction] = await databaseClient.db.select({
      fingerprint: stripeBalanceTransactions.fingerprintSha256
    }).from(stripeBalanceTransactions).where(eq(stripeBalanceTransactions.id, staged.balanceTransactionId));
    if (!balanceTransaction) throw new Error('Expected staged balance transaction');
    const blocker = await beginBlocker(
      probeName('classification-blocker', purchase.orderId),
      `select id from financial_classification_versions
       where subject_type = 'balance_transaction' and subject_id = $1 for update`,
      [staged.balanceTransactionId]
    );
    const classifierName = probeName('classifier-replay', purchase.orderId);
    const sourceName = probeName('source-replay', purchase.orderId);
    const classifierEntered = deferred<number>();
    const sourceEntered = deferred<number>();
    let classifierReplay: Promise<void> | undefined;
    let sourceReplay: Promise<void> | undefined;
    try {
      classifierReplay = replayClassification(
        classifierName,
        staged.balanceTransactionId,
        balanceTransaction.fingerprint,
        classifierEntered
      );
      observe(classifierReplay);
      const classifierPid = await classifierEntered.promise;
      expect(await waitForBlockedOperation(classifierReplay,
        classifierPid,
        classifierName,
        'from financial_classification_versions'
      )).toContain(blocker.pid);

      sourceReplay = lockPurchaseFinancialProjection(sourceName, purchase, {
        payoutGenerations: [],
        balanceTransactionIds: [staged.balanceTransactionId],
        classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
        issueKeys: []
      }, sourceEntered);
      observe(sourceReplay);
      const sourcePid = await sourceEntered.promise;
      expect(await waitForBlockedOperation(sourceReplay,
        sourcePid,
        sourceName,
        'from stripe_balance_transactions'
      )).toContain(classifierPid);

      await releaseBlocker(blocker);
      assertFulfilled(
        ['classifier replay', 'source replay'],
        await Promise.allSettled([classifierReplay, sourceReplay])
      );
    } finally {
      await releaseBlocker(blocker).catch(() => undefined);
      await Promise.allSettled([
        ...(classifierReplay ? [classifierReplay] : []),
        ...(sourceReplay ? [sourceReplay] : [])
      ]);
    }
  }, 15_000);

  it('serializes payout publication and reverse-input projection by sorted balance-transaction advisory locks', async () => {
    const staged = await Promise.all([
      stageBalanceTransaction(databaseClient.db, snapshot({}), { correlationId: 'locks-publisher-first' }),
      stageBalanceTransaction(databaseClient.db, snapshot({}), { correlationId: 'locks-publisher-second' })
    ]);
    const [lowId, highId] = staged.map((row) => row.balanceTransactionId).sort();
    if (!lowId || !highId) throw new Error('Expected two staged balance transactions');
    const publicationPayout = await createPayoutFixture([highId, lowId], false, 'publishable');
    const projectionPayout = await createPayoutFixture([], false);
    const purchase = await createPurchaseFixture('ch_reverse_input');
    const blocker = await beginBlocker(
      probeName('reverse-bt-blocker', publicationPayout.payoutId),
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`pale-orbit:financial:balance-transaction:${highId}`]
    );
    const publisherName = probeName('payout-publisher', publicationPayout.payoutId);
    const projectionName = probeName('reverse-input', projectionPayout.payoutId);
    const publisherEntered = deferred<number>();
    const projectionEntered = deferred<number>();
    let publication: Promise<void> | undefined;
    let reverseProjection: Promise<void> | undefined;
    try {
      publication = publishPayout(publisherName, publicationPayout, publisherEntered);
      observe(publication);
      const publisherPid = await publisherEntered.promise;
      expect(await waitForBlockedQuery(
        publisherPid,
        publisherName,
        'pg_advisory_xact_lock'
      )).toContain(blocker.pid);

      reverseProjection = lockPurchaseFinancialProjection(projectionName, purchase, {
        payoutGenerations: [{
          payoutId: projectionPayout.payoutId,
          expectedGeneration: projectionPayout.generation
        }],
        balanceTransactionIds: [highId, lowId],
        classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
        issueKeys: []
      }, projectionEntered);
      observe(reverseProjection);
      const projectionPid = await projectionEntered.promise;
      expect(await waitForBlockedQuery(
        projectionPid,
        projectionName,
        'pg_advisory_xact_lock'
      )).toContain(publisherPid);

      await releaseBlocker(blocker);
      assertFulfilled(
        ['payout publication', 'reverse-input projection'],
        await Promise.allSettled([publication, reverseProjection])
      );
    } finally {
      await releaseBlocker(blocker).catch(() => undefined);
      await Promise.allSettled([
        ...(publication ? [publication] : []),
        ...(reverseProjection ? [reverseProjection] : [])
      ]);
    }
  }, 15_000);

  it('lets entitlement mutation complete while refund projection is still waiting on its financial rows', async () => {
    const purchase = await createPurchaseFixture(`ch_refund_${randomUUID()}`);
    const refundSource = snapshot({
      sourceFamily: 'refund',
      sourceId: purchase.stripeRefundId,
      amountMinor: -100,
      feeMinor: 0
    });
    const staged = await stageBalanceTransaction(databaseClient.db, refundSource, { correlationId: 'locks-refund-entitlement' });
    const blocker = await beginBlocker(
      probeName('refund-bt-blocker', purchase.refundId),
      'select id from stripe_balance_transactions where id = $1 for update',
      [staged.balanceTransactionId]
    );
    const refundName = probeName('refund-projection', purchase.refundId);
    const entitlementName = probeName('entitlement-mutation', purchase.grantId);
    const refundEntered = deferred<number>();
    const entitlementEntered = deferred<number>();
    let refundProjection: Promise<void> | undefined;
    let entitlementMutation: Promise<void> | undefined;
    try {
      refundProjection = lockPurchaseFinancialProjection(refundName, purchase, {
        payoutGenerations: [],
        balanceTransactionIds: [staged.balanceTransactionId],
        classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
        issueKeys: []
      }, refundEntered, true);
      observe(refundProjection);
      const refundPid = await refundEntered.promise;
      expect(await waitForBlockedOperation(refundProjection,
        refundPid,
        refundName,
        'from stripe_balance_transactions'
      )).toContain(blocker.pid);

      entitlementMutation = mutateEntitlement(entitlementName, purchase, entitlementEntered);
      observe(entitlementMutation);
      await entitlementEntered.promise;
      await expect(entitlementMutation).resolves.toBeUndefined();

      await releaseBlocker(blocker);
      assertFulfilled(
        ['refund projection', 'entitlement mutation'],
        await Promise.allSettled([refundProjection, entitlementMutation])
      );
    } finally {
      await releaseBlocker(blocker).catch(() => undefined);
      await Promise.allSettled([
        ...(refundProjection ? [refundProjection] : []),
        ...(entitlementMutation ? [entitlementMutation] : [])
      ]);
    }
  }, 15_000);
});
