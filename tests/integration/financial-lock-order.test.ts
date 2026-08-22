import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { appendClassificationDecisionLocked } from '$lib/server/commerce/financial/classification';
import { FINANCIAL_CLASSIFIER_VERSION } from '$lib/server/commerce/financial/constants';
import { FinancialAdminConflictError } from '$lib/server/commerce/financial/admin-commands/handler';
import { stageBalanceTransaction } from '$lib/server/commerce/financial/ledger';
import {
  lockFinancialProjectionRows,
  lockPayoutImportRows,
  type FinancialProjectionLockInput
} from '$lib/server/commerce/financial/locks';
import {
  lockFinancialProjectionAuthority
} from '$lib/server/commerce/financial/rebase';
import { executeRefundAllocationFinalize } from '$lib/server/commerce/financial/refund-review/finalize';
import { lockOrder } from '$lib/server/commerce/lock';
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
import {
  ownerDatabaseClient,
  workerDatabaseClient as databaseClient
} from './database';

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

interface RefundFinalizationProbeSnapshot {
  readonly refund_status: string;
  readonly allocation_status: string;
  readonly financial_evidence_status: string;
  readonly refund_updated_at: string;
  readonly draft_count: number;
  readonly allocation_count: number;
  readonly component_count: number;
  readonly effect_count: number;
  readonly grant_state: string;
  readonly grant_updated_at: string;
  readonly entitlement_states: string;
  readonly issue_states: string;
  readonly audit_count: number;
  readonly outbox_count: number;
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
  await ownerDatabaseClient.db.insert(user).values({
    id: userId,
    name: 'Financial lock reader',
    email,
    emailVerified: true
  });
  await ownerDatabaseClient.db.insert(titles).values({
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
  await ownerDatabaseClient.db.insert(orders).values({
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
  await ownerDatabaseClient.db.insert(orderItems).values({
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
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
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
  const [refund] = await ownerDatabaseClient.db.insert(refunds).values({
    paymentId: payment.id,
    stripeRefundId,
    status: 'pending',
    amountMinor: 100,
    currency: 'USD',
    reason: 'requested_by_customer',
    providerCreatedAt: fixtureTime
  }).returning();
  if (!refund) throw new Error('Expected refund fixture');
  const [grant] = await ownerDatabaseClient.db.insert(entitlementGrants).values({
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

async function readRefundFinalizationProbeSnapshot(
  purchase: PurchaseFixture,
  commandId: string
): Promise<RefundFinalizationProbeSnapshot> {
  const result = await ownerDatabaseClient.pool.query<RefundFinalizationProbeSnapshot>(`
    select refund.status::text as refund_status,
      refund.allocation_status::text as allocation_status,
      refund.financial_evidence_status::text as financial_evidence_status,
      refund.updated_at::text as refund_updated_at,
      (select count(*)::integer from refund_allocation_drafts draft
        where draft.refund_id = refund.id) as draft_count,
      (select count(*)::integer from refund_allocations allocation
        where allocation.refund_id = refund.id) as allocation_count,
      (select count(*)::integer from refund_allocation_components component
        where component.refund_id = refund.id) as component_count,
      (select count(*)::integer from refund_allocation_finalization_effects effect
        where effect.refund_id = refund.id) as effect_count,
      (select grant_row.state::text from entitlement_grants grant_row
        where grant_row.id = $2) as grant_state,
      (select grant_row.updated_at::text from entitlement_grants grant_row
        where grant_row.id = $2) as grant_updated_at,
      coalesce((select string_agg(
        entitlement.id::text || ':' || entitlement.revoked_at::text,
        ',' order by entitlement.id
      ) from entitlements entitlement
        where entitlement.user_id = $3 and entitlement.title_id = $4), '')
        as entitlement_states,
      coalesce((select string_agg(
        issue.id::text || ':' || issue.state::text || ':' || issue.occurrence_count::text,
        ',' order by issue.id
      ) from financial_reconciliation_issues issue
        where issue.resource_type = 'refund' and issue.resource_id = refund.id), '')
        as issue_states,
      (select count(*)::integer from audit_events audit
        where audit.action = 'financial.refund_allocation.finalized'
          and audit.resource_id = refund.id::text) as audit_count,
      (select count(*)::integer from outbox_messages message
        where message.deduplication_key = $5) as outbox_count
    from refunds refund where refund.id = $1
  `, [
    purchase.refundId,
    purchase.grantId,
    purchase.userId,
    purchase.titleId,
    `commerce:access-change:event:${commandId}:v1`
  ]);
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error('Expected one refund finalization probe snapshot');
  }
  return row;
}

async function createPayoutFixture(
  balanceTransactionIds: readonly string[],
  publishMemberships: boolean,
  runState: 'publishable' | 'published' = 'published'
): Promise<PayoutFixture> {
  const generation = 1;
  const [payout] = await ownerDatabaseClient.db.insert(stripePayouts).values({
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
  const [run] = await ownerDatabaseClient.db.insert(payoutImportRuns).values({
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
    await ownerDatabaseClient.db.insert(payoutImportRunEntries).values(
      balanceTransactionIds.map((balanceTransactionId) => ({
        runId: run.id,
        balanceTransactionId
      }))
    );
  }
  if (publishMemberships && balanceTransactionIds.length > 0) {
    await ownerDatabaseClient.db.insert(stripePayoutBalanceTransactions).values(
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
  entered?: Deferred<number>
): Promise<void> {
  await databaseClient.db.transaction(async (tx) => {
    await configureProbe(tx, applicationName, entered);
    await lockOrder(tx, purchase.orderId);
    const [order] = await tx.select().from(orders).where(eq(orders.id, purchase.orderId)).for('update');
    const [payment] = await tx.select().from(payments).where(eq(payments.id, purchase.paymentId)).for('update');
    if (!order || !payment) throw new Error('Expected purchase graph roots');
    await lockPaymentPurchaseFacts(tx, payment, order);
    await lockFinancialProjectionRows(tx, input);
  });
}

async function executeRefundFinalizationProbe(
  applicationName: string,
  purchase: PurchaseFixture,
  commandId: string,
  entered?: Deferred<number>
): Promise<'not_eligible'> {
  try {
    await databaseClient.db.transaction(async (transaction) => {
      await configureProbe(transaction, applicationName, entered);
      await executeRefundAllocationFinalize({
        transaction,
        commandId,
        actor: { type: 'user', id: purchase.userId, roles: ['admin'] },
        correlationId: `financial-lock-finalization-${commandId}`,
        signal: new AbortController().signal,
        enqueueAccessChange: async () => {
          throw new Error('Ineligible finalization lock probe must not enqueue email');
        }
      }, {
        kind: 'refund_allocation_finalize',
        refundId: purchase.refundId,
        expectedActiveDraftVersion: 1,
        previewFingerprint: 'e'.repeat(64),
        confirmation: 'finalize_refund_allocation'
      });
    });
  } catch (error) {
    if (
      error instanceof FinancialAdminConflictError &&
      error.safeCode === 'not_eligible'
    ) return error.safeCode;
    throw error;
  }
  throw new Error('Ineligible finalization lock probe unexpectedly succeeded');
}

async function lockProjectionAuthority(
  applicationName: string,
  entered: Deferred<number>
): Promise<void> {
  await databaseClient.db.transaction(async (tx) => {
    await configureProbe(tx, applicationName, entered);
    await lockFinancialProjectionAuthority(tx);
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

  it('locks active projection authority before the finalization order graph', async () => {
    const purchase = await createPurchaseFixture(`ch_finalize_authority_${randomUUID()}`);
    const refundSource = snapshot({
      sourceFamily: 'refund',
      sourceId: purchase.stripeRefundId,
      amountMinor: -100,
      feeMinor: 0
    });
    await stageBalanceTransaction(databaseClient.db, refundSource, {
      correlationId: 'locks-finalization-authority'
    });
    const commandId = randomUUID();
    const before = await readRefundFinalizationProbeSnapshot(purchase, commandId);
    const blocker = await beginBlocker(
      probeName('finalize-order-blocker', purchase.orderId),
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`pale-orbit:commerce:order:${purchase.orderId}`]
    );
    const finalizationName = probeName('finalize-authority', purchase.refundId);
    const competingAuthorityName = probeName('projection-authority', purchase.paymentId);
    const finalizationEntered = deferred<number>();
    const authorityEntered = deferred<number>();
    let finalization: Promise<'not_eligible'> | undefined;
    let competingAuthority: Promise<void> | undefined;
    try {
      finalization = executeRefundFinalizationProbe(
        finalizationName,
        purchase,
        commandId,
        finalizationEntered
      );
      observe(finalization);
      const finalizationPid = await finalizationEntered.promise;
      expect(await waitForBlockedOperation(
        finalization,
        finalizationPid,
        finalizationName,
        'pg_advisory_xact_lock'
      )).toContain(blocker.pid);

      competingAuthority = lockProjectionAuthority(
        competingAuthorityName,
        authorityEntered
      );
      observe(competingAuthority);
      const competingAuthorityPid = await authorityEntered.promise;
      expect(await waitForBlockedOperation(
        competingAuthority,
        competingAuthorityPid,
        competingAuthorityName,
        'from financial_projection_versions'
      )).toContain(finalizationPid);

      await releaseBlocker(blocker);
      const outcomes = await Promise.allSettled([finalization, competingAuthority]);
      assertFulfilled(
        ['refund finalization', 'competing projection authority'],
        outcomes
      );
      expect(outcomes[0]).toEqual({ status: 'fulfilled', value: 'not_eligible' });
      expect(await readRefundFinalizationProbeSnapshot(purchase, commandId)).toEqual(before);
    } finally {
      await releaseBlocker(blocker).catch(() => undefined);
      await Promise.allSettled([
        ...(finalization ? [finalization] : []),
        ...(competingAuthority ? [competingAuthority] : [])
      ]);
    }
  }, 15_000);

  it('keeps finalization financial closure ahead of its late entitlement lock', async () => {
    const purchase = await createPurchaseFixture(`ch_refund_${randomUUID()}`);
    const refundSource = snapshot({
      sourceFamily: 'refund',
      sourceId: purchase.stripeRefundId,
      amountMinor: -100,
      feeMinor: 0
    });
    const staged = await stageBalanceTransaction(databaseClient.db, refundSource, { correlationId: 'locks-refund-entitlement' });
    const commandId = randomUUID();
    const before = await readRefundFinalizationProbeSnapshot(purchase, commandId);
    const financialBlocker = await beginBlocker(
      probeName('refund-bt-blocker', purchase.refundId),
      'select id from stripe_balance_transactions where id = $1 for update',
      [staged.balanceTransactionId]
    );
    const refundName = probeName('refund-finalization', purchase.refundId);
    const refundEntered = deferred<number>();
    let refundFinalization: Promise<'not_eligible'> | undefined;
    let scopeBlocker: Blocker | undefined;
    let grantBlocker: Blocker | undefined;
    try {
      refundFinalization = executeRefundFinalizationProbe(
        refundName,
        purchase,
        commandId,
        refundEntered
      );
      observe(refundFinalization);
      const refundPid = await refundEntered.promise;
      expect(await waitForBlockedOperation(refundFinalization,
        refundPid,
        refundName,
        'from stripe_balance_transactions'
      )).toContain(financialBlocker.pid);

      scopeBlocker = await beginBlocker(
        probeName('refund-scope-blocker', purchase.grantId),
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`pale-orbit:commerce:entitlement:${purchase.userId}:${purchase.titleId}`]
      );
      grantBlocker = await beginBlocker(
        probeName('refund-grant-blocker', purchase.grantId),
        'select id from entitlement_grants where id = $1 for update',
        [purchase.grantId]
      );

      await releaseBlocker(financialBlocker);
      expect(await waitForBlockedOperation(
        refundFinalization,
        refundPid,
        refundName,
        'pg_advisory_xact_lock'
      )).toContain(scopeBlocker.pid);

      await releaseBlocker(scopeBlocker);
      expect(await waitForBlockedOperation(
        refundFinalization,
        refundPid,
        refundName,
        'from "entitlement_grants"'
      )).toContain(grantBlocker.pid);

      await releaseBlocker(grantBlocker);
      await expect(refundFinalization).resolves.toBe('not_eligible');
      expect(await readRefundFinalizationProbeSnapshot(purchase, commandId)).toEqual(before);
    } finally {
      await releaseBlocker(financialBlocker).catch(() => undefined);
      if (scopeBlocker) await releaseBlocker(scopeBlocker).catch(() => undefined);
      if (grantBlocker) await releaseBlocker(grantBlocker).catch(() => undefined);
      await Promise.allSettled([
        ...(refundFinalization ? [refundFinalization] : [])
      ]);
    }
  }, 15_000);
});
