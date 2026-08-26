import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import { createCommerceMessageEnqueuer } from '$lib/server/commerce/email/enqueue';
import { appendClassificationDecisionLocked } from '$lib/server/commerce/financial/classification';
import {
  createFinancialAdminCommandExecutors
} from '$lib/server/commerce/financial/admin-commands/executors';
import {
  FINANCIAL_ADMIN_COMMAND_JOB,
  FinancialAdminConflictError,
  createFinancialAdminCommandHandler,
  type FinancialAdminCommandExecutor
} from '$lib/server/commerce/financial/admin-commands/handler';
import {
  submitFinancialAdminCommand
} from '$lib/server/commerce/financial/admin-commands/repository';
import type { FinancialAdminPrivateCommand } from
  '$lib/server/commerce/financial/admin-commands/contracts';
import {
  persistFinancialAllocationPlanLocked
} from '$lib/server/commerce/financial/allocations/repository';
import {
  FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  FINANCIAL_CLASSIFIER_VERSION
} from '$lib/server/commerce/financial/constants';
import { observeFinancialIssue } from '$lib/server/commerce/financial/issues';
import { stageBalanceTransaction } from '$lib/server/commerce/financial/ledger';
import {
  lockFinancialProjectionRows,
  lockPayoutImportRows,
  type FinancialProjectionLockInput
} from '$lib/server/commerce/financial/locks';
import {
  replayFinancialClassification
} from '$lib/server/commerce/financial/rebase';
import { lockFinancialProjectionAuthority } from
  '$lib/server/commerce/financial/projection-authority';
import { executeReportingCorrectionCreate } from
  '$lib/server/commerce/financial/refund-review/corrections';
import {
  executeRefundDraftDiscard,
  executeRefundDraftSave
} from '$lib/server/commerce/financial/refund-review/drafts';
import { executeRefundAllocationFinalize } from '$lib/server/commerce/financial/refund-review/finalize';
import { executeAdministrativeRecoveryActivate } from
  '$lib/server/commerce/financial/refund-review/recovery';
import { lockOrder } from '$lib/server/commerce/lock';
import { lockPaymentPurchaseFacts } from '$lib/server/commerce/reconciliation';
import {
  disputes,
  entitlementGrants,
  orderItems,
  orders,
  payments,
  payoutImportRunEntries,
  payoutImportRuns,
  refundAllocationComponents,
  refundAllocations,
  refunds,
  stripeBalanceTransactions,
  stripePayoutBalanceTransactions,
  stripePayouts,
  titles,
  user
} from '$lib/server/db/schema';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { PermanentJobError, runWorker } from '$lib/server/jobs/runner';
import {
  applicationConfig,
  databaseClient as runtimeDatabaseClient,
  ownerDatabaseClient,
  workerDatabaseClient as databaseClient
} from './database';

const fixtureTime = new Date('2026-08-01T00:00:00.000Z');
const LOCK_PROBE_REPETITIONS = [1, 2, 3] as const;
const correctionAccessMessages = createCommerceMessageEnqueuer(applicationConfig.origin);

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface PurchaseFixture {
  readonly grantId: string;
  readonly itemId: string;
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

interface DraftTailLockSet {
  readonly balanceTransactionId: string;
  readonly payoutId: string;
  readonly classificationId: string;
  readonly allocationSets: readonly {
    readonly id: string;
    readonly basis: 'gross_amount' | 'fee';
  }[];
  readonly issueId: string;
  readonly issueResourceId: string;
  readonly currentCorrectionSetId: string;
}

type CorrectionBarrierStageId =
  | 'administrator-role-advisory'
  | 'financial-admin-job-lease'
  | 'command-row'
  | 'projection-authority'
  | 'order-advisory'
  | 'order-row'
  | 'payment-row'
  | 'refund-row'
  | `refund-allocation-row-${number}`
  | `refund-component-row-${number}`
  | 'current-correction-row'
  | 'order-item-row'
  | 'projection-enrollment'
  | `payout-advisory-${number}`
  | `payout-row-${number}`
  | `balance-transaction-advisory-${number}`
  | `balance-transaction-row-${number}`
  | `classification-advisory-${number}`
  | `classification-row-${number}`
  | `allocation-advisory-${number}`
  | `allocation-row-${number}`
  | `issue-advisory-${number}`
  | `issue-row-${number}`;

type CorrectionBarrierBlockerSlot = 0 | 1;

interface CorrectionBarrierStage {
  readonly id: CorrectionBarrierStageId;
  readonly blockerSlot: CorrectionBarrierBlockerSlot;
  readonly query: string;
  readonly parameters: readonly unknown[];
  readonly expectedQueryFragment: string;
  readonly expectedLock:
    | { readonly kind: 'advisory' }
    | { readonly kind: 'relation'; readonly relation: string };
}

interface CorrectionBarrierBlocker {
  readonly client: PoolClient;
  readonly pid: number;
  released: boolean;
}

interface CorrectionBarrier {
  readonly blockers: readonly [CorrectionBarrierBlocker, CorrectionBarrierBlocker];
  readonly stages: readonly CorrectionBarrierStage[];
  nextRelease: number;
  closed: boolean;
}

interface ObservedPostgresLock {
  readonly locktype: string;
  readonly database: number | null;
  readonly relation: string | null;
  readonly page: number | null;
  readonly tuple: number | null;
  readonly classid: number | null;
  readonly objid: number | null;
  readonly objsubid: number | null;
  readonly virtualxid: string | null;
  readonly transactionid: string | null;
  readonly mode: string;
  readonly granted: boolean;
}

const correctionMutationRelations = new Set([
  'audit_events',
  'financial_admin_commands',
  'financial_allocation_sets',
  'financial_item_allocations',
  'financial_projection_versions',
  'financial_reconciliation_issues',
  'refund_reporting_correction_items',
  'refund_reporting_correction_sets',
  'refunds'
]);

const mutationRelationLockModes = new Set([
  'RowExclusiveLock',
  'ShareUpdateExclusiveLock',
  'ShareLock',
  'ShareRowExclusiveLock',
  'ExclusiveLock',
  'AccessExclusiveLock'
]);

interface CorrectionLockFixture {
  readonly purchase: PurchaseFixture;
  readonly actor: AdministratorActor;
  readonly commandId: string;
  readonly refundIds: readonly string[];
  readonly refundAllocationIds: readonly string[];
  readonly refundComponentIds: readonly string[];
  readonly currentCorrectionSetId: string;
  readonly payoutIds: readonly string[];
  readonly balanceTransactions: readonly {
    readonly id: string;
    readonly fingerprint: string;
  }[];
  readonly classifications: readonly {
    readonly id: string;
    readonly subjectId: string;
  }[];
  readonly allocationSets: readonly {
    readonly id: string;
    readonly balanceTransactionId: string;
    readonly basis: 'gross_amount' | 'fee';
  }[];
  readonly issues: readonly {
    readonly id: string;
    readonly resourceId: string;
  }[];
}

interface CorrectionProjectionFixture {
  readonly balanceTransactionId: string;
  readonly classificationId: string;
  readonly fingerprint: string;
  readonly grossAllocationSetId: string;
  readonly feeAllocationSetId: string;
}

interface CorrectionWorkerProbe {
  readonly operation: Promise<void>;
  abort(): void;
}

interface PreparedCorrectionWorkerProbe {
  readonly jobId: string;
  start(): CorrectionWorkerProbe;
  dispose(): Promise<void>;
}

interface RecoveryWorkerProbe extends CorrectionWorkerProbe {
  readonly commandId: string;
}

interface RefundCommandWorkerProbe extends CorrectionWorkerProbe {
  readonly commandId: string;
}

interface PreparedRefundCommandWorkerProbe {
  readonly commandId: string;
  start(): RefundCommandWorkerProbe;
  dispose(): Promise<void>;
}

interface CorrectionDomainSnapshot {
  readonly refunds: string;
  readonly refund_allocations: string;
  readonly refund_components: string;
  readonly correction_sets: string;
  readonly correction_items: string;
  readonly payouts: string;
  readonly payout_memberships: string;
  readonly balance_transactions: string;
  readonly fee_details: string;
  readonly classifications: string;
  readonly allocation_sets: string;
  readonly allocation_items: string;
  readonly projection_heads: string;
  readonly issues: string;
  readonly grants: string;
  readonly entitlements: string;
  readonly outbox: string;
  readonly correction_audits: string;
  readonly issue_resolution_audits: string;
}

interface CorrectionCommandLifecycle {
  readonly command_status: string;
  readonly safe_result_code: string | null;
  readonly safe_result: unknown;
  readonly job_status: string;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly command_audit_count: number;
}

interface AdminCommandTerminalLifecycle {
  readonly commandKind: string;
  readonly commandStatus: string;
  readonly safeResultCode: string | null;
  readonly safeResult: unknown;
  readonly jobStatus: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly auditActions: string[];
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

function namedTransactionDatabase(
  database: Database,
  applicationName: string,
  entered: Deferred<number>
): Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'transaction') {
        return (work: (transaction: DatabaseTransaction) => Promise<unknown>) =>
          database.transaction(async (transaction) => {
            await configureProbe(transaction, applicationName, entered);
            return work(transaction);
          });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function observe(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

async function within<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
    const result = await ownerDatabaseClient.pool.query<{
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
    try {
      await within(
        client.query('rollback'),
        5_000,
        `Timed out rolling back failed blocker ${applicationName}`
      );
      client.release();
    } catch {
      client.release(true);
    }
    throw error;
  }
}

async function releaseBlocker(blocker: Blocker): Promise<void> {
  if (blocker.released) return;
  blocker.released = true;
  try {
    await within(
      blocker.client.query('rollback'),
      5_000,
      `Timed out releasing blocker PID ${blocker.pid}`
    );
    blocker.client.release();
  } catch (error) {
    blocker.client.release(true);
    throw error;
  }
}

async function beginDraftTailBlocker(
  applicationName: string,
  purchase: PurchaseFixture,
  tail: DraftTailLockSet
): Promise<Blocker> {
  const blocker = await beginBlocker(
    applicationName,
    `select singleton from financial_projection_versions
      where singleton = true for update`,
    []
  );
  try {
    await blocker.client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['pale-orbit:financial:replay-enrollment']
    );
    await blocker.client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`pale-orbit:financial:payout:${tail.payoutId}`]
    );
    await blocker.client.query(
      'select id from stripe_payouts where id = $1 for update',
      [tail.payoutId]
    );
    await blocker.client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`pale-orbit:financial:balance-transaction:${tail.balanceTransactionId}`]
    );
    await blocker.client.query(
      'select id from stripe_balance_transactions where id = $1 for update',
      [tail.balanceTransactionId]
    );
    await blocker.client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [
        `pale-orbit:financial:classification:balance_transaction:` +
          tail.balanceTransactionId
      ]
    );
    await blocker.client.query(
      'select id from financial_classification_versions where id = $1 for update',
      [tail.classificationId]
    );
    for (const allocation of [...tail.allocationSets].sort((left, right) =>
      left.basis === right.basis ? 0 : left.basis === 'gross_amount' ? -1 : 1
    )) {
      await blocker.client.query(
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `pale-orbit:financial:allocation:${tail.balanceTransactionId}:` +
            allocation.basis
        ]
      );
    }
    await blocker.client.query(
      `select id from financial_allocation_sets
       where id = any($1::uuid[]) order by id for update`,
      [tail.allocationSets.map((allocation) => allocation.id).sort()]
    );
    await blocker.client.query(
      'select pg_advisory_xact_lock(hashtext($1))',
      [
        `pale-orbit:financial:issue:allocation_set:${tail.issueResourceId}:` +
          'correction_rebase_required'
      ]
    );
    await blocker.client.query(
      'select id from financial_reconciliation_issues where id = $1 for update',
      [tail.issueId]
    );
    await blocker.client.query(
      'select id from refund_reporting_correction_sets where id = $1 for update',
      [tail.currentCorrectionSetId]
    );
    await blocker.client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`pale-orbit:commerce:entitlement:${purchase.userId}:${purchase.titleId}`]
    );
    await blocker.client.query(
      'select id from entitlement_grants where id = $1 for update',
      [purchase.grantId]
    );
    return blocker;
  } catch (error) {
    await releaseBlocker(blocker).catch(() => undefined);
    throw error;
  }
}

function correctionSavepoint(id: CorrectionBarrierStageId): string {
  return `correction_${id.replaceAll('-', '_')}`;
}

async function beginCorrectionBarrier(
  applicationName: string,
  stages: readonly CorrectionBarrierStage[]
): Promise<CorrectionBarrier> {
  const blockers: CorrectionBarrierBlocker[] = [];
  try {
    for (const slot of [0, 1] as const) {
      const client = await databaseClient.pool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('application_name', $1, true)", [
          `${applicationName}-${slot}`
        ]);
        await client.query("select set_config('lock_timeout', '5s', true)");
        const pidResult = await client.query<{ pid: number }>(
          'select pg_backend_pid() as pid'
        );
        const pid = pidResult.rows[0]?.pid;
        if (typeof pid !== 'number') throw new Error('missing correction barrier pid');
        blockers.push({ client, pid, released: false });
      } catch (error) {
        client.release(true);
        throw error;
      }
    }
    for (const slot of [0, 1] as const) {
      const blocker = blockers[slot];
      if (!blocker) throw new Error(`missing correction blocker ${slot}`);
      const assigned = stages.filter((stage) => stage.blockerSlot === slot);
      for (const stage of [...assigned].reverse()) {
        await blocker.client.query(`savepoint ${correctionSavepoint(stage.id)}`);
        await blocker.client.query(stage.query, [...stage.parameters]);
      }
    }
    if (blockers.length !== 2) throw new Error('missing correction barrier blockers');
    return {
      blockers: blockers as [CorrectionBarrierBlocker, CorrectionBarrierBlocker],
      stages,
      nextRelease: 0,
      closed: false
    };
  } catch (error) {
    await within(Promise.allSettled(blockers.map(async (blocker) => {
      if (blocker.released) return;
      blocker.released = true;
      try {
        await within(
          blocker.client.query('rollback'),
          5_000,
          `Timed out rolling back correction blocker PID ${blocker.pid}`
        );
        blocker.client.release();
      } catch {
        blocker.client.release(true);
      }
    })), 7_500, 'Timed out cleaning up failed correction-barrier setup');
    throw error;
  }
}

async function releaseCorrectionBarrierStage(
  barrier: CorrectionBarrier,
  stage: CorrectionBarrierStage
): Promise<void> {
  if (barrier.closed || barrier.stages[barrier.nextRelease]?.id !== stage.id) {
    throw new Error(`Correction barrier release is out of order at ${stage.id}`);
  }
  const blocker = barrier.blockers[stage.blockerSlot];
  const savepoint = correctionSavepoint(stage.id);
  await within((async () => {
    await blocker.client.query(`rollback to savepoint ${savepoint}`);
    await blocker.client.query(`release savepoint ${savepoint}`);
  })(), 5_000, `Timed out releasing correction barrier stage ${stage.id}`);
  barrier.nextRelease += 1;
}

async function releaseCorrectionBarrier(barrier: CorrectionBarrier): Promise<void> {
  if (barrier.closed) return;
  barrier.closed = true;
  const results = await Promise.allSettled(barrier.blockers.map(async (blocker, slot) => {
    if (blocker.released) return;
    blocker.released = true;
    try {
      await within(
        blocker.client.query('rollback'),
        5_000,
        `Timed out releasing correction barrier blocker ${slot}`
      );
      blocker.client.release();
    } catch (error) {
      blocker.client.release(true);
      throw error;
    }
  }));
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
}

async function readPostgresLocks(pid: number): Promise<readonly ObservedPostgresLock[]> {
  const result = await ownerDatabaseClient.pool.query<ObservedPostgresLock>(`
    select locktype, database, relation::regclass::text as relation, page, tuple,
      classid, objid, objsubid, virtualxid, transactionid::text as transactionid,
      mode, granted
    from pg_locks where pid = $1
    order by locktype, database, relation, page, tuple, classid, objid, objsubid,
      virtualxid, transactionid, mode, granted
  `, [pid]);
  return result.rows;
}

function sameAdvisoryIdentity(
  left: ObservedPostgresLock,
  right: ObservedPostgresLock
): boolean {
  return left.locktype === 'advisory' && right.locktype === 'advisory' &&
    left.database === right.database && left.classid === right.classid &&
    left.objid === right.objid && left.objsubid === right.objsubid;
}

function sameTransactionIdentity(
  left: ObservedPostgresLock,
  right: ObservedPostgresLock
): boolean {
  return left.locktype === 'transactionid' && right.locktype === 'transactionid' &&
    left.transactionid !== null && left.transactionid === right.transactionid;
}

function sameTupleIdentity(
  left: ObservedPostgresLock,
  right: ObservedPostgresLock
): boolean {
  return left.locktype === 'tuple' && right.locktype === 'tuple' &&
    left.database === right.database && left.relation === right.relation &&
    left.page === right.page && left.tuple === right.tuple;
}

function expectNoGrantedCorrectionMutationLocks(
  locks: readonly ObservedPostgresLock[],
  stage: CorrectionBarrierStage
): void {
  const prematureMutationLocks = locks.flatMap((lock) => {
    const relation = lock.relation?.replace(/^public[.]/u, '') ?? null;
    return lock.locktype === 'relation' && lock.granted && relation !== null &&
      correctionMutationRelations.has(relation) && mutationRelationLockModes.has(lock.mode)
      ? [`${relation}:${lock.mode}`]
      : [];
  }).sort();
  expect(
    prematureMutationLocks,
    `executor acquired mutation locks before completing ${stage.id}`
  ).toEqual([]);
}

async function waitForCorrectionBarrierStage(
  operation: Promise<unknown>,
  pid: number,
  applicationName: string,
  barrier: CorrectionBarrier,
  stage: CorrectionBarrierStage
): Promise<void> {
  const blocker = barrier.blockers[stage.blockerSlot];
  const wait = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await ownerDatabaseClient.pool.query<{
        blockers: number[];
        query: string;
        waitEvent: string | null;
        waitEventType: string | null;
      }>(`
        select pg_blocking_pids(pid) as blockers, query,
          wait_event as "waitEvent", wait_event_type as "waitEventType"
        from pg_stat_activity
        where pid = $1 and application_name = $2
      `, [pid, applicationName]);
      const row = result.rows[0];
      if (row?.waitEventType === 'Lock') {
        expect(row.blockers).toEqual([blocker.pid]);
        const normalized = row.query.replace(/\s+/gu, ' ').toLowerCase();
        expect(normalized).toContain(stage.expectedQueryFragment.toLowerCase());
        const [waitingLocks, blockingLocks] = await Promise.all([
          readPostgresLocks(pid),
          readPostgresLocks(blocker.pid)
        ]);
        expect(waitingLocks.some((lock) => !lock.granted)).toBe(true);
        expectNoGrantedCorrectionMutationLocks(waitingLocks, stage);
        if (stage.expectedLock.kind === 'advisory') {
          expect(row.waitEvent).toBe('advisory');
          const waiting = waitingLocks.find((lock) =>
            lock.locktype === 'advisory' && !lock.granted
          );
          expect(waiting).toBeDefined();
          expect(blockingLocks.some((lock) =>
            lock.granted && waiting !== undefined && sameAdvisoryIdentity(waiting, lock)
          )).toBe(true);
        } else {
          const expectedRelation = stage.expectedLock.relation;
          expect(['transactionid', 'tuple']).toContain(row.waitEvent);
          expect(waitingLocks.some((lock) =>
            lock.relation === expectedRelation
          )).toBe(true);
          expect(blockingLocks.some((lock) =>
            lock.granted && lock.relation === expectedRelation
          )).toBe(true);
          const waiting = waitingLocks.find((lock) =>
            lock.locktype === row.waitEvent && !lock.granted
          );
          expect(waiting).toBeDefined();
          expect(blockingLocks.some((lock) => lock.granted && waiting !== undefined &&
            (row.waitEvent === 'transactionid'
              ? sameTransactionIdentity(waiting, lock)
              : sameTupleIdentity(waiting, lock))
          )).toBe(true);
        }
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected ${applicationName} at correction barrier ${stage.id}`);
  };
  await Promise.race([
    wait(),
    operation.then(
      () => { throw new Error(`${applicationName} completed before ${stage.id}`); },
      (error: unknown) => { throw error; }
    )
  ]);
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
    itemId,
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

async function createCorrectionProjectionFixture(input: {
  readonly label: string;
  readonly refundId: string;
  readonly stripeRefundId: string;
  readonly orderItemId: string;
  readonly totalMinor: number;
}): Promise<CorrectionProjectionFixture> {
  const source = snapshot({
    sourceFamily: 'refund',
    sourceId: input.stripeRefundId,
    amountMinor: -input.totalMinor,
    feeMinor: 0
  });
  const staged = await stageBalanceTransaction(databaseClient.db, source, {
    correlationId: `${input.label}-stage`
  });
  const [balance] = await databaseClient.db.select({
    fingerprint: stripeBalanceTransactions.fingerprintSha256
  }).from(stripeBalanceTransactions)
    .where(eq(stripeBalanceTransactions.id, staged.balanceTransactionId));
  if (!balance) throw new Error('Expected correction balance transaction');

  const projection = await databaseClient.db.transaction(async (transaction) => {
    const classification = await appendClassificationDecisionLocked(transaction, {
      subjectType: 'balance_transaction',
      subjectId: staged.balanceTransactionId,
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      sourceFingerprint: balance.fingerprint,
      decision: {
        status: 'classified',
        classification: 'refund',
        impact: 'informational'
      },
      correlationId: `${input.label}-classification`
    });
    const commonPlan = {
      balanceTransactionId: staged.balanceTransactionId,
      scope: 'title' as const,
      currency: 'USD',
      algorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      sourceFingerprint: balance.fingerprint,
      supersedesSetId: null,
      reversalOfSetId: null
    };
    const gross = await persistFinancialAllocationPlanLocked(transaction, {
      sourceKind: 'refund',
      sourceId: input.refundId,
      classificationVersion: FINANCIAL_CLASSIFIER_VERSION,
      correlationId: `${input.label}-gross`,
      plan: {
        ...commonPlan,
        allocationIdentity: `${input.label}:gross:${input.refundId}`,
        basis: 'gross_amount',
        expectedEffectMinor: -input.totalMinor,
        items: [{
          orderItemId: input.orderItemId,
          component: 'refund_subtotal',
          effectMinor: -input.totalMinor,
          currency: 'USD',
          tieBreakKey: `correction-lock:${input.refundId}:refund_subtotal`
        }]
      }
    });
    const fee = await persistFinancialAllocationPlanLocked(transaction, {
      sourceKind: 'refund',
      sourceId: input.refundId,
      classificationVersion: FINANCIAL_CLASSIFIER_VERSION,
      correlationId: `${input.label}-fee`,
      plan: {
        ...commonPlan,
        allocationIdentity: `${input.label}:fee:${input.refundId}`,
        basis: 'fee',
        expectedEffectMinor: 0,
        items: []
      }
    });
    return { classificationId: classification.id, grossSetId: gross.setId,
      feeSetId: fee.setId };
  });
  return {
    balanceTransactionId: staged.balanceTransactionId,
    classificationId: projection.classificationId,
    fingerprint: balance.fingerprint,
    grossAllocationSetId: projection.grossSetId,
    feeAllocationSetId: projection.feeSetId
  };
}

async function createCurrentCorrectionSentinel(
  approvedByAdminId: string,
  label: string
): Promise<string> {
  const purchase = await createPurchaseFixture(`ch_${label}_${randomUUID()}`);
  const projection = await createCorrectionProjectionFixture({
    label,
    refundId: purchase.refundId,
    stripeRefundId: purchase.stripeRefundId,
    orderItemId: purchase.itemId,
    totalMinor: 100
  });
  const result = await databaseClient.pool.query<{ id: string }>(`
    insert into refund_reporting_correction_sets (
      refund_id, correction_version, kind, base_allocation_set_id,
      source_fingerprint_sha256, approved_by_admin_id, created_by_admin_id,
      correlation_id
    ) values ($1, 1, 'allocation_attribution_correction', $2, $3, $4, $4, $5)
    returning id
  `, [
    purchase.refundId,
    projection.grossAllocationSetId,
    projection.fingerprint,
    approvedByAdminId,
    `${label}-current-correction`
  ]);
  const id = result.rows[0]?.id;
  if (typeof id !== 'string') throw new Error('Expected current-correction sentinel');
  return id;
}

async function createCorrectionLockFixture(label: string): Promise<CorrectionLockFixture> {
  const purchase = await createPurchaseFixture(`ch_correction_${randomUUID()}`);
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [purchase.userId]
  );
  const totalMinor = 50;
  await ownerDatabaseClient.db.update(refunds).set({
    status: 'succeeded',
    amountMinor: totalMinor,
    allocationStatus: 'finalized',
    financialEvidenceStatus: 'fee_reconciled'
  }).where(eq(refunds.id, purchase.refundId));
  const siblingStripeRefundId = `re_correction_sibling_${randomUUID()}`;
  const [siblingRefund] = await ownerDatabaseClient.db.insert(refunds).values({
    paymentId: purchase.paymentId,
    stripeRefundId: siblingStripeRefundId,
    status: 'succeeded',
    amountMinor: totalMinor,
    currency: 'USD',
    reason: 'requested_by_customer',
    providerCreatedAt: new Date(fixtureTime.getTime() + 1_000),
    allocationStatus: 'finalized',
    financialEvidenceStatus: 'fee_reconciled'
  }).returning();
  if (!siblingRefund) throw new Error('Expected sibling correction refund');
  const allocationRows = await ownerDatabaseClient.db.insert(refundAllocations).values([
    {
      refundId: purchase.refundId,
      orderItemId: purchase.itemId,
      amountMinor: totalMinor,
      source: 'administrative' as const
    },
    {
      refundId: siblingRefund.id,
      orderItemId: purchase.itemId,
      amountMinor: totalMinor,
      source: 'administrative' as const
    }
  ]).returning({ id: refundAllocations.id, refundId: refundAllocations.refundId });
  const targetAllocation = allocationRows.find((row) => row.refundId === purchase.refundId);
  const siblingAllocation = allocationRows.find((row) => row.refundId === siblingRefund.id);
  if (!targetAllocation || !siblingAllocation) {
    throw new Error('Expected both correction refund allocations');
  }
  const componentRows = await ownerDatabaseClient.db.insert(refundAllocationComponents).values([
    {
      refundAllocationId: targetAllocation.id,
      refundId: purchase.refundId,
      orderItemId: purchase.itemId,
      subtotalMinor: totalMinor,
      taxMinor: 0,
      totalMinor,
      currency: 'USD'
    },
    {
      refundAllocationId: siblingAllocation.id,
      refundId: siblingRefund.id,
      orderItemId: purchase.itemId,
      subtotalMinor: totalMinor,
      taxMinor: 0,
      totalMinor,
      currency: 'USD'
    }
  ]).returning({ id: refundAllocationComponents.id });

  const targetProjection = await createCorrectionProjectionFixture({
    label: `${label}-target`,
    refundId: purchase.refundId,
    stripeRefundId: purchase.stripeRefundId,
    orderItemId: purchase.itemId,
    totalMinor
  });
  const siblingProjection = await createCorrectionProjectionFixture({
    label: `${label}-sibling`,
    refundId: siblingRefund.id,
    stripeRefundId: siblingStripeRefundId,
    orderItemId: purchase.itemId,
    totalMinor
  });
  const projections = [targetProjection, siblingProjection] as const;
  const currentCorrection = await databaseClient.pool.query<{ id: string }>(`
    insert into refund_reporting_correction_sets (
      refund_id, correction_version, kind, base_allocation_set_id,
      source_fingerprint_sha256, approved_by_admin_id, created_by_admin_id,
      correlation_id
    ) values ($1, 1, 'allocation_attribution_correction', $2, $3, $4, $4, $5)
    returning id
  `, [
    purchase.refundId,
    targetProjection.grossAllocationSetId,
    targetProjection.fingerprint,
    purchase.userId,
    `${label}-current-correction`
  ]);
  const currentCorrectionSetId = currentCorrection.rows[0]?.id;
  if (typeof currentCorrectionSetId !== 'string') {
    throw new Error('Expected current reporting-correction fixture');
  }
  const issues = [];
  for (const [index, projection] of projections.entries()) {
    const issue = await databaseClient.db.transaction((transaction) =>
      observeFinancialIssue(transaction, {
        resourceType: 'allocation_set',
        resourceId: projection.grossAllocationSetId,
        safeCode: 'correction_rebase_required',
        impact: 'exception',
        actor: { type: 'system', id: 'financial-worker' },
        correlationId: `${label}-issue-${index + 1}`
      })
    );
    issues.push({ id: issue.id, resourceId: projection.grossAllocationSetId });
  }
  const payouts = [];
  for (const projection of projections) {
    payouts.push(await createPayoutFixture([projection.balanceTransactionId], true));
  }
  const actor: AdministratorActor = {
    type: 'user', id: purchase.userId, roles: ['admin']
  };
  const submitted = await submitFinancialAdminCommand(runtimeDatabaseClient.db, {
    actor,
    idempotencyKey: randomUUID(),
    command: {
      kind: 'refund_reporting_correction_create',
      refundId: purchase.refundId,
      reason: 'allocation_attribution_correction',
      expectedNextCorrectionVersion: 2,
      expectedBaseAllocationSetId: targetProjection.grossAllocationSetId,
      expectedSourceFingerprint: 'f'.repeat(64),
      items: [{ orderItemId: purchase.itemId, totalPresentmentMinor: totalMinor }],
      previewFingerprint: 'e'.repeat(64),
      confirmation: 'create_reporting_correction'
    },
    context: { correlationId: `${label}-command` }
  });
  if (submitted.status !== 'pending') throw new Error('Expected pending correction command');
  return {
    purchase,
    actor,
    commandId: submitted.commandId,
    refundIds: [purchase.refundId, siblingRefund.id],
    refundAllocationIds: allocationRows.map((row) => row.id),
    refundComponentIds: componentRows.map((row) => row.id),
    currentCorrectionSetId,
    payoutIds: payouts.map((payout) => payout.payoutId),
    balanceTransactions: projections.map((projection) => ({
      id: projection.balanceTransactionId,
      fingerprint: projection.fingerprint
    })),
    classifications: projections.map((projection) => ({
      id: projection.classificationId,
      subjectId: projection.balanceTransactionId
    })),
    allocationSets: projections.flatMap((projection) => [
      { id: projection.grossAllocationSetId,
        balanceTransactionId: projection.balanceTransactionId,
        basis: 'gross_amount' as const },
      { id: projection.feeAllocationSetId,
        balanceTransactionId: projection.balanceTransactionId,
        basis: 'fee' as const }
    ]),
    issues
  };
}

async function readCorrectionDomainSnapshot(
  fixture: CorrectionLockFixture
): Promise<CorrectionDomainSnapshot> {
  const result = await ownerDatabaseClient.pool.query<CorrectionDomainSnapshot>(`
    select
      coalesce((select jsonb_agg(to_jsonb(refund) order by refund.id)::text
        from refunds refund where refund.id = any($1::uuid[])), '[]') as refunds,
      coalesce((select jsonb_agg(to_jsonb(allocation) order by allocation.id)::text
        from refund_allocations allocation
        where allocation.refund_id = any($1::uuid[])), '[]')
        as refund_allocations,
      coalesce((select jsonb_agg(to_jsonb(component) order by component.id)::text
        from refund_allocation_components component
        where component.refund_id = any($1::uuid[])), '[]')
        as refund_components,
      coalesce((select jsonb_agg(to_jsonb(correction) order by correction.id)::text
        from refund_reporting_correction_sets correction
        where correction.refund_id = any($1::uuid[])), '[]')
        as correction_sets,
      coalesce((select jsonb_agg(to_jsonb(item) order by item.id)::text
        from refund_reporting_correction_items item
        join refund_reporting_correction_sets correction on correction.id = item.correction_set_id
        where correction.refund_id = any($1::uuid[])), '[]') as correction_items,
      coalesce((select jsonb_agg(to_jsonb(payout) order by payout.id)::text
        from stripe_payouts payout where payout.id = any($8::uuid[])), '[]') as payouts,
      coalesce((select jsonb_agg(to_jsonb(membership)
          order by membership.payout_id, membership.balance_transaction_id)::text
        from stripe_payout_balance_transactions membership
        where membership.payout_id = any($8::uuid[])
          and membership.balance_transaction_id = any($2::uuid[])), '[]')
        as payout_memberships,
      coalesce((select jsonb_agg(to_jsonb(balance) order by balance.id)::text
        from stripe_balance_transactions balance
        where balance.id = any($2::uuid[])), '[]')
        as balance_transactions,
      coalesce((select jsonb_agg(to_jsonb(detail) order by detail.id)::text
        from stripe_balance_transaction_fee_details detail
        where detail.balance_transaction_id = any($2::uuid[])), '[]') as fee_details,
      coalesce((select jsonb_agg(to_jsonb(classification) order by classification.id)::text
        from financial_classification_versions classification
        where (classification.subject_type = 'balance_transaction'
            and classification.subject_id = any($2::uuid[]))
          or (classification.subject_type = 'fee_detail' and classification.subject_id in (
            select detail.id from stripe_balance_transaction_fee_details detail
            where detail.balance_transaction_id = any($2::uuid[])
          ))), '[]') as classifications,
      coalesce((select jsonb_agg(to_jsonb(allocation) order by allocation.id)::text
        from financial_allocation_sets allocation
        where allocation.balance_transaction_id = any($2::uuid[])),
        '[]') as allocation_sets,
      coalesce((select jsonb_agg(to_jsonb(item) order by item.id)::text
        from financial_item_allocations item
        join financial_allocation_sets allocation on allocation.id = item.allocation_set_id
        where allocation.balance_transaction_id = any($2::uuid[])), '[]')
        as allocation_items,
      coalesce((select jsonb_agg(to_jsonb(head)
          order by head.balance_transaction_id, head.basis)::text
        from current_financial_projection_heads head
        where head.balance_transaction_id = any($2::uuid[])), '[]') as projection_heads,
      coalesce((select jsonb_agg(to_jsonb(issue) order by issue.id)::text
        from financial_reconciliation_issues issue
        where issue.id = any($3::uuid[])), '[]') as issues,
      coalesce((select jsonb_agg(to_jsonb(grant_row) order by grant_row.id)::text
        from entitlement_grants grant_row where grant_row.id = $4), '[]') as grants,
      coalesce((select jsonb_agg(to_jsonb(entitlement) order by entitlement.id)::text
        from entitlements entitlement
        where entitlement.user_id = $5 and entitlement.title_id = $6), '[]') as entitlements,
      coalesce((select jsonb_agg(to_jsonb(message) order by message.id)::text
        from outbox_messages message
        where message.deduplication_key = $7), '[]') as outbox,
      coalesce((select jsonb_agg(to_jsonb(audit) order by audit.id)::text
        from audit_events audit where audit.action = 'financial.refund_correction.created'
          and ((audit.before ->> 'refundId') in (
              select id::text from unnest($1::uuid[]) as refund_id(id)
            ) or (audit.after ->> 'refundId') in (
              select id::text from unnest($1::uuid[]) as refund_id(id)
            ))), '[]')
        as correction_audits,
      coalesce((select jsonb_agg(to_jsonb(audit) order by audit.id)::text
        from audit_events audit where audit.action = 'financial.issue.resolved'
          and audit.resource_type = 'financial_issue' and audit.resource_id in (
            select id::text from unnest($3::uuid[]) as issue_id(id)
          )), '[]')
        as issue_resolution_audits
  `, [
    fixture.refundIds,
    fixture.balanceTransactions.map((balance) => balance.id),
    fixture.issues.map((issue) => issue.id),
    fixture.purchase.grantId,
    fixture.purchase.userId,
    fixture.purchase.titleId,
    `commerce:access-change:event:${fixture.commandId}:v1`,
    fixture.payoutIds
  ]);
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error('Expected one reporting-correction domain snapshot');
  }
  return row;
}

async function readCorrectionCommandLifecycle(
  commandId: string
): Promise<CorrectionCommandLifecycle> {
  const result = await ownerDatabaseClient.pool.query<CorrectionCommandLifecycle>(`
    select command.status::text as command_status,
      command.safe_result_code, command.safe_result,
      job.status::text as job_status, job.attempts, job.last_error,
      (select count(*)::integer from audit_events audit
        where audit.action = 'financial.admin_command.conflict'
          and audit.resource_id = command.id::text) as command_audit_count
    from financial_admin_commands command
    join jobs job on job.id = command.job_id
    where command.id = $1
  `, [commandId]);
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error('Expected one reporting-correction command lifecycle');
  }
  return row;
}

async function readAdminCommandTerminalLifecycle(
  commandId: string
): Promise<AdminCommandTerminalLifecycle> {
  const result = await ownerDatabaseClient.pool.query<AdminCommandTerminalLifecycle>(`
    select command.kind::text as "commandKind",
      command.status::text as "commandStatus",
      command.safe_result_code as "safeResultCode",
      command.safe_result as "safeResult",
      job.status::text as "jobStatus", job.attempts,
      job.last_error as "lastError",
      coalesce((
        select array_agg(audit.action order by audit.id)
        from audit_events audit
        where audit.resource_type = 'financial_admin_command'
          and audit.resource_id = command.id::text
          and audit.action like 'financial.admin_command.%'
      ), array[]::text[]) as "auditActions"
    from financial_admin_commands command
    join jobs job on job.id = command.job_id
    where command.id = $1
  `, [commandId]);
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error('Expected one financial administrator command lifecycle');
  }
  return row;
}

function expectConflictLifecycle(
  lifecycle: AdminCommandTerminalLifecycle,
  commandKind: string,
  safeResultCode: 'not_eligible' | 'stale_state'
): void {
  expect(lifecycle).toEqual({
    commandKind,
    commandStatus: 'conflict',
    safeResultCode,
    safeResult: null,
    jobStatus: 'failed',
    attempts: 1,
    lastError: 'Financial administrator command conflicted with current state.',
    auditActions: ['financial.admin_command.conflict']
  });
}

function unexpectedFinancialAdminExecutor(label: string): FinancialAdminCommandExecutor {
  return async () => {
    throw new Error(`Unexpected ${label} executor in reporting-correction lock probe`);
  };
}

async function prepareCorrectionWorkerProbe(
  applicationName: string,
  fixture: CorrectionLockFixture,
  entered: Deferred<number>
): Promise<PreparedCorrectionWorkerProbe> {
  const reportingCorrection: FinancialAdminCommandExecutor = async (context, command) => {
    if (command.kind !== 'refund_reporting_correction_create') {
      throw new Error('Reporting-correction probe received another command kind');
    }
    return executeReportingCorrectionCreate(context, command);
  };
  const handler = createFinancialAdminCommandHandler({
    database: namedTransactionDatabase(databaseClient.db, applicationName, entered),
    executors: createFinancialAdminCommandExecutors({
      refundDraftSave: unexpectedFinancialAdminExecutor('draft-save'),
      refundDraftDiscard: unexpectedFinancialAdminExecutor('draft-discard'),
      refundAllocationFinalize: unexpectedFinancialAdminExecutor('refund-finalization'),
      refundReportingCorrectionCreate: reportingCorrection,
      administrativeRecoveryActivate: unexpectedFinancialAdminExecutor('recovery-activate'),
      administrativeRecoveryDeactivate: unexpectedFinancialAdminExecutor('recovery-deactivate')
    }),
    accessMessages: correctionAccessMessages
  });
  const leaseCapability = createHash('sha256')
    .update(`reporting-correction-lock:${fixture.commandId}`)
    .digest('base64url');
  const repository = createPostgresJobRepository(
    databaseClient.db,
    { ...applicationConfig.jobs, leaseMs: 60_000 },
    undefined,
    'local-only',
    {
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    },
    () => leaseCapability
  );
  const workerId = `correction-lock-${fixture.commandId}`;
  const job = await repository.claimNext(workerId);
  expect(job).not.toBeNull();
  expect(job?.payload).toEqual({ commandId: fixture.commandId });
  if (!job?.financialAdminLeaseCapability) {
    throw new Error('Expected reporting-correction lease capability');
  }
  let started = false;
  return {
    jobId: job.id,
    start: () => {
      if (started) throw new Error('Reporting-correction probe already started');
      started = true;
      const controller = new AbortController();
      const operation = (async () => {
        try {
          await handler(job, controller.signal);
          if (!await repository.complete(
            job.id,
            workerId,
            job.financialAdminLeaseCapability
          )) {
            throw new Error('Reporting-correction job completion lost its lease');
          }
        } catch (error: unknown) {
          const failed = await repository.fail(
            job.id,
            workerId,
            error instanceof PermanentJobError
              ? error.safeMessage
              : 'Transient reporting-correction lock probe failure',
            !(error instanceof PermanentJobError),
            job.financialAdminLeaseCapability
          );
          if (!failed) throw error;
        }
      })();
      observe(operation);
      return { operation, abort: () => controller.abort() };
    },
    dispose: async () => {
      if (started) return;
      started = true;
      if (!await repository.fail(
        job.id,
        workerId,
        'Reporting-correction lock probe setup was abandoned.',
        false,
        job.financialAdminLeaseCapability
      )) {
        throw new Error('Unable to dispose reporting-correction lock probe');
      }
    }
  };
}

async function prepareRefundCommandWorkerProbe(
  applicationName: string,
  purchase: PurchaseFixture,
  command: Extract<FinancialAdminPrivateCommand, {
    kind: 'refund_draft_save' | 'refund_draft_discard' | 'refund_allocation_finalize';
  }>,
  entered: Deferred<number>
): Promise<PreparedRefundCommandWorkerProbe> {
  const submitted = await submitFinancialAdminCommand(runtimeDatabaseClient.db, {
    actor: { type: 'user', id: purchase.userId, roles: ['admin'] },
    idempotencyKey: randomUUID(),
    command,
    context: { correlationId: `${applicationName}-${purchase.refundId}` }
  });
  expect(submitted.status).toBe('pending');
  const named = (
    expectedKind: typeof command.kind,
    executor: FinancialAdminCommandExecutor
  ): FinancialAdminCommandExecutor => async (context, privateCommand) => {
    if (privateCommand.kind !== expectedKind) {
      throw new Error(`${applicationName} received another command kind`);
    }
    return executor(context, privateCommand);
  };
  const handler = createFinancialAdminCommandHandler({
    database: namedTransactionDatabase(databaseClient.db, applicationName, entered),
    executors: createFinancialAdminCommandExecutors({
      refundDraftSave: named(
        'refund_draft_save',
        executeRefundDraftSave as FinancialAdminCommandExecutor
      ),
      refundDraftDiscard: named(
        'refund_draft_discard',
        executeRefundDraftDiscard as FinancialAdminCommandExecutor
      ),
      refundAllocationFinalize: named(
        'refund_allocation_finalize',
        executeRefundAllocationFinalize as FinancialAdminCommandExecutor
      ),
      refundReportingCorrectionCreate: unexpectedFinancialAdminExecutor('correction'),
      administrativeRecoveryActivate: unexpectedFinancialAdminExecutor('recovery-activate'),
      administrativeRecoveryDeactivate: unexpectedFinancialAdminExecutor('recovery-deactivate')
    }),
    accessMessages: correctionAccessMessages
  });
  const repository = createPostgresJobRepository(
    databaseClient.db,
    { ...applicationConfig.jobs, leaseMs: 60_000 },
    undefined,
    'local-only',
    {
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    },
    () => createHash('sha256')
      .update(`${applicationName}:${submitted.commandId}`)
      .digest('base64url')
  );
  const workerId = `${applicationName}-${submitted.commandId}`;
  const job = await repository.claimNext(workerId);
  expect(job).not.toBeNull();
  expect(job?.payload).toEqual({ commandId: submitted.commandId });
  if (!job?.financialAdminLeaseCapability) {
    throw new Error('Expected refund-command lease capability');
  }
  let started = false;
  return {
    commandId: submitted.commandId,
    start: () => {
      if (started) throw new Error(`${applicationName} probe already started`);
      started = true;
      const controller = new AbortController();
      const operation = (async () => {
        try {
          await handler(job, controller.signal);
          if (!await repository.complete(
            job.id,
            workerId,
            job.financialAdminLeaseCapability
          )) {
            throw new Error('Refund-command job completion lost its lease');
          }
        } catch (error: unknown) {
          const failed = await repository.fail(
            job.id,
            workerId,
            error instanceof PermanentJobError
              ? error.safeMessage
              : 'Transient refund-command lock probe failure',
            !(error instanceof PermanentJobError),
            job.financialAdminLeaseCapability
          );
          if (!failed) throw error;
        }
      })();
      observe(operation);
      return {
        commandId: submitted.commandId,
        operation,
        abort: () => controller.abort()
      };
    },
    dispose: async () => {
      if (started) return;
      started = true;
      if (!await repository.fail(
        job.id,
        workerId,
        'Refund-command lock probe setup was abandoned.',
        false,
        job.financialAdminLeaseCapability
      )) {
        throw new Error('Unable to dispose refund-command lock probe');
      }
    }
  };
}

async function runRefundCommandWorkerProbe(
  applicationName: string,
  purchase: PurchaseFixture,
  command: Extract<FinancialAdminPrivateCommand, {
    kind: 'refund_draft_save' | 'refund_draft_discard' | 'refund_allocation_finalize';
  }>,
  entered: Deferred<number>
): Promise<RefundCommandWorkerProbe> {
  return (await prepareRefundCommandWorkerProbe(
    applicationName,
    purchase,
    command,
    entered
  )).start();
}

async function runRecoveryWorkerProbe(
  applicationName: string,
  purchase: PurchaseFixture,
  entered: Deferred<number>
): Promise<RecoveryWorkerProbe> {
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [purchase.userId]
  );
  const submitted = await submitFinancialAdminCommand(runtimeDatabaseClient.db, {
    actor: { type: 'user', id: purchase.userId, roles: ['admin'] },
    idempotencyKey: randomUUID(),
    command: {
      kind: 'administrative_recovery_activate',
      refundId: purchase.refundId,
      finalizationEffectId: randomUUID(),
      orderItemId: purchase.itemId,
      expectedCorrectionSetId: randomUUID(),
      expectedCorrectionVersion: 1,
      expectedSourceFingerprint: 'f'.repeat(64),
      previewFingerprint: 'e'.repeat(64),
      confirmation: 'activate_persistent_recovery'
    },
    context: { correlationId: `financial-lock-recovery-${purchase.refundId}` }
  });
  const recoveryActivate: FinancialAdminCommandExecutor = async (context, command) => {
    if (command.kind !== 'administrative_recovery_activate') {
      throw new Error('Recovery probe received another command kind');
    }
    await configureProbe(context.transaction, applicationName, entered);
    return executeAdministrativeRecoveryActivate(context, command);
  };
  const handler = createFinancialAdminCommandHandler({
    database: databaseClient.db,
    executors: createFinancialAdminCommandExecutors({
      refundDraftSave: unexpectedFinancialAdminExecutor('draft-save'),
      refundDraftDiscard: unexpectedFinancialAdminExecutor('draft-discard'),
      refundAllocationFinalize: unexpectedFinancialAdminExecutor('refund-finalization'),
      refundReportingCorrectionCreate: unexpectedFinancialAdminExecutor('correction'),
      administrativeRecoveryActivate: recoveryActivate,
      administrativeRecoveryDeactivate: unexpectedFinancialAdminExecutor('recovery-deactivate')
    }),
    accessMessages: correctionAccessMessages
  });
  const repository = createPostgresJobRepository(
    databaseClient.db,
    { ...applicationConfig.jobs, leaseMs: 60_000 },
    undefined,
    'local-only',
    {
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    },
    () => createHash('sha256')
      .update(`recovery-lock:${submitted.commandId}`)
      .digest('base64url')
  );
  const controller = new AbortController();
  let polls = 0;
  const operation = runWorker({
    repository,
    handlers: new Map([[FINANCIAL_ADMIN_COMMAND_JOB, handler]]),
    workerId: `recovery-lock-${submitted.commandId}`,
    concurrency: 1,
    pollIntervalMs: 1,
    leaseRenewalIntervalMs: 250,
    signal: controller.signal,
    beforePoll: async () => {
      polls += 1;
      if (polls === 2) controller.abort();
    }
  });
  return {
    commandId: submitted.commandId,
    operation,
    abort: () => controller.abort()
  };
}

async function waitForCorrectionExecutorEntry(
  entered: Deferred<number>,
  probe: CorrectionWorkerProbe
): Promise<number> {
  return within(
    Promise.race([
      entered.promise,
      probe.operation.then(
        () => { throw new Error('Correction worker completed before executor entry'); },
        (error: unknown) => { throw error; }
      )
    ]),
    5_000,
    'Timed out waiting for reporting-correction executor entry'
  );
}

function correctionBarrierStages(
  fixture: CorrectionLockFixture,
  jobId: string
): readonly CorrectionBarrierStage[] {
  const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const blockerSlot = (index: number): CorrectionBarrierBlockerSlot =>
    index % 2 === 0 ? 0 : 1;
  const payoutIds = [...fixture.payoutIds].sort(compareText);
  const balanceTransactionIds = fixture.balanceTransactions.map((row) => row.id)
    .sort(compareText);
  const classifications = [...fixture.classifications].sort((left, right) =>
    compareText(left.subjectId, right.subjectId)
  );
  const allocationAdvisories = [...fixture.allocationSets].sort((left, right) => {
    const byBalance = compareText(left.balanceTransactionId, right.balanceTransactionId);
    if (byBalance !== 0) return byBalance;
    return left.basis === right.basis ? 0 : left.basis === 'gross_amount' ? -1 : 1;
  });
  const allocationRows = [...fixture.allocationSets].sort((left, right) => {
    const byBalance = compareText(left.balanceTransactionId, right.balanceTransactionId);
    return byBalance === 0 ? compareText(left.id, right.id) : byBalance;
  });
  const issues = [...fixture.issues].sort((left, right) =>
    compareText(left.resourceId, right.resourceId)
  );
  const refundAllocationIds = [...fixture.refundAllocationIds].sort(compareText);
  const refundComponentIds = [...fixture.refundComponentIds].sort(compareText);
  return [
    {
      id: 'administrator-role-advisory',
      blockerSlot: 0,
      query: `select pg_advisory_xact_lock(
        hashtext('pale-orbit:user-roles:admin'))`,
      parameters: [],
      expectedQueryFragment: 'pg_advisory_xact_lock',
      expectedLock: { kind: 'advisory' }
    },
    {
      id: 'financial-admin-job-lease',
      blockerSlot: 0,
      query: `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      parameters: [`pale-orbit:plan6bii-financial-admin-job-lease:${jobId}`],
      expectedQueryFragment: 'pg_advisory_xact_lock_shared',
      expectedLock: { kind: 'advisory' }
    },
    {
      id: 'command-row',
      blockerSlot: 0,
      query: 'select id from financial_admin_commands where id = $1 for update',
      parameters: [fixture.commandId],
      expectedQueryFragment: 'from "public"."financial_admin_commands"',
      expectedLock: { kind: 'relation', relation: 'financial_admin_commands' }
    },
    {
      id: 'projection-authority',
      blockerSlot: 0,
      query: `select singleton from financial_projection_versions
        where singleton = true for update`,
      parameters: [],
      expectedQueryFragment: 'from financial_projection_versions',
      expectedLock: { kind: 'relation', relation: 'financial_projection_versions' }
    },
    {
      id: 'order-advisory',
      blockerSlot: 0,
      query: 'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      parameters: [`pale-orbit:commerce:order:${fixture.purchase.orderId}`],
      expectedQueryFragment: 'pg_advisory_xact_lock',
      expectedLock: { kind: 'advisory' }
    },
    {
      id: 'order-row',
      blockerSlot: 0,
      query: 'select id from orders where id = $1 for update',
      parameters: [fixture.purchase.orderId],
      expectedQueryFragment: 'from orders',
      expectedLock: { kind: 'relation', relation: 'orders' }
    },
    {
      id: 'payment-row',
      blockerSlot: 0,
      query: 'select id from payments where id = $1 for update',
      parameters: [fixture.purchase.paymentId],
      expectedQueryFragment: 'from payments',
      expectedLock: { kind: 'relation', relation: 'payments' }
    },
    {
      id: 'refund-row',
      blockerSlot: 0,
      query: 'select id from refunds where id = $1 for update',
      parameters: [fixture.purchase.refundId],
      expectedQueryFragment: 'from "refunds"',
      expectedLock: { kind: 'relation', relation: 'refunds' }
    },
    ...refundAllocationIds.map((id, index): CorrectionBarrierStage => ({
      id: `refund-allocation-row-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select id from refund_allocations where id = $1 for update',
      parameters: [id],
      expectedQueryFragment: 'from "refund_allocations"',
      expectedLock: { kind: 'relation', relation: 'refund_allocations' }
    })),
    ...refundComponentIds.map((id, index): CorrectionBarrierStage => ({
      id: `refund-component-row-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select id from refund_allocation_components where id = $1 for update',
      parameters: [id],
      expectedQueryFragment: 'from "refund_allocation_components"',
      expectedLock: { kind: 'relation', relation: 'refund_allocation_components' }
    })),
    {
      id: 'current-correction-row',
      blockerSlot: 0,
      query: 'select id from refund_reporting_correction_sets where id = $1 for update',
      parameters: [fixture.currentCorrectionSetId],
      expectedQueryFragment: 'from "refund_reporting_correction_sets"',
      expectedLock: { kind: 'relation', relation: 'refund_reporting_correction_sets' }
    },
    {
      id: 'order-item-row',
      blockerSlot: 1,
      query: 'select id from order_items where id = $1 for update',
      parameters: [fixture.purchase.itemId],
      expectedQueryFragment: 'from "order_items"',
      expectedLock: { kind: 'relation', relation: 'order_items' }
    },
    {
      id: 'projection-enrollment',
      blockerSlot: 0,
      query: 'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      parameters: ['pale-orbit:financial:replay-enrollment'],
      expectedQueryFragment: 'pg_advisory_xact_lock',
      expectedLock: { kind: 'advisory' }
    },
    ...payoutIds.map((payoutId, index): CorrectionBarrierStage => ({
      id: `payout-advisory-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      parameters: [`pale-orbit:financial:payout:${payoutId}`],
      expectedQueryFragment: 'pg_advisory_xact_lock',
      expectedLock: { kind: 'advisory' }
    })),
    ...payoutIds.map((payoutId, index): CorrectionBarrierStage => ({
      id: `payout-row-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select id from stripe_payouts where id = $1 for update',
      parameters: [payoutId],
      expectedQueryFragment: 'order by id for update',
      expectedLock: { kind: 'relation', relation: 'stripe_payouts' }
    })),
    ...balanceTransactionIds.map((id, index): CorrectionBarrierStage => ({
      id: `balance-transaction-advisory-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      parameters: [`pale-orbit:financial:balance-transaction:${id}`],
      expectedQueryFragment: 'pg_advisory_xact_lock',
      expectedLock: { kind: 'advisory' }
    })),
    ...balanceTransactionIds.map((id, index): CorrectionBarrierStage => ({
      id: `balance-transaction-row-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select id from stripe_balance_transactions where id = $1 for update',
      parameters: [id],
      expectedQueryFragment: 'order by id for update',
      expectedLock: { kind: 'relation', relation: 'stripe_balance_transactions' }
    })),
    ...classifications.map((classification, index): CorrectionBarrierStage => ({
      id: `classification-advisory-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      parameters: [
        `pale-orbit:financial:classification:balance_transaction:${classification.subjectId}`
      ],
      expectedQueryFragment: 'pg_advisory_xact_lock',
      expectedLock: { kind: 'advisory' }
    })),
    ...classifications.map((classification, index): CorrectionBarrierStage => ({
      id: `classification-row-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select id from financial_classification_versions where id = $1 for update',
      parameters: [classification.id],
      expectedQueryFragment: 'order by subject_type, subject_id, classifier_version for update',
      expectedLock: { kind: 'relation', relation: 'financial_classification_versions' }
    })),
    ...allocationAdvisories.map((allocation, index): CorrectionBarrierStage => ({
      id: `allocation-advisory-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      parameters: [
        `pale-orbit:financial:allocation:${allocation.balanceTransactionId}:${allocation.basis}`
      ],
      expectedQueryFragment: 'pg_advisory_xact_lock',
      expectedLock: { kind: 'advisory' }
    })),
    ...allocationRows.map((allocation, index): CorrectionBarrierStage => ({
      id: `allocation-row-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select id from financial_allocation_sets where id = $1 for update',
      parameters: [allocation.id],
      expectedQueryFragment: 'order by balance_transaction_id, id for update',
      expectedLock: { kind: 'relation', relation: 'financial_allocation_sets' }
    })),
    ...issues.map((issue, index): CorrectionBarrierStage => ({
      id: `issue-advisory-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select pg_advisory_xact_lock(hashtext($1))',
      parameters: [
        `pale-orbit:financial:issue:allocation_set:${issue.resourceId}:correction_rebase_required`
      ],
      expectedQueryFragment: 'pg_advisory_xact_lock',
      expectedLock: { kind: 'advisory' }
    })),
    ...issues.map((issue, index): CorrectionBarrierStage => ({
      id: `issue-row-${index + 1}`,
      blockerSlot: blockerSlot(index),
      query: 'select id from financial_reconciliation_issues where id = $1 for update',
      parameters: [issue.id],
      expectedQueryFragment: 'select id from financial_reconciliation_issues',
      expectedLock: { kind: 'relation', relation: 'financial_reconciliation_issues' }
    }))
  ];
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

async function replayClassifierRebase(
  applicationName: string,
  balanceTransactionId: string,
  fingerprint: string,
  entered: Deferred<number>
): Promise<void> {
  await replayFinancialClassification({
    database: namedTransactionDatabase(databaseClient.db, applicationName, entered),
    targetClassifierVersion: FINANCIAL_CLASSIFIER_VERSION,
    targetAllocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
  }, {
    payload: {
      subjectType: 'balance_transaction',
      subjectId: balanceTransactionId,
      sourceFingerprintSha256: fingerprint,
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
      replayId: `c${FINANCIAL_CLASSIFIER_VERSION}-a${FINANCIAL_ALLOCATION_ALGORITHM_VERSION}`
    },
    correlationId: `financial-lock-classifier-rebase-${balanceTransactionId}`,
    signal: new AbortController().signal
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
      const sourcePid = await within(
        sourceEntered.promise,
        5_000,
        'Timed out waiting for payout-source projection entry'
      );
      expect(await waitForBlockedQuery(sourcePid, sourceName, 'from stripe_payouts'))
        .toEqual([blocker.pid]);

      impactProjection = lockPayoutImpactProjection(impactName, purchase, payout, impactEntered);
      observe(impactProjection);
      const impactPid = await within(
        impactEntered.promise,
        5_000,
        'Timed out waiting for payout-impact projection entry'
      );
      expect(await waitForBlockedQuery(impactPid, impactName, 'pg_advisory_xact_lock'))
        .toEqual([sourcePid]);

      await releaseBlocker(blocker);
      assertFulfilled(
        ['payment source projection', 'payout-impact projection'],
        await within(
          Promise.allSettled([sourceProjection, impactProjection]),
          7_500,
          'Timed out completing payout-impact/source projections'
        )
      );
    } finally {
      await within(Promise.allSettled([
        releaseBlocker(blocker),
        ...(sourceProjection ? [sourceProjection] : []),
        ...(impactProjection ? [impactProjection] : [])
      ]), 7_500, 'Timed out cleaning up payout-impact/source probes');
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
      const classifierPid = await within(
        classifierEntered.promise,
        5_000,
        'Timed out waiting for classifier-rebase entry'
      );
      expect(await waitForBlockedOperation(classifierReplay,
        classifierPid,
        classifierName,
        'from financial_classification_versions'
      )).toEqual([blocker.pid]);

      sourceReplay = lockPurchaseFinancialProjection(sourceName, purchase, {
        payoutGenerations: [],
        balanceTransactionIds: [staged.balanceTransactionId],
        classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
        issueKeys: []
      }, sourceEntered);
      observe(sourceReplay);
      const sourcePid = await within(
        sourceEntered.promise,
        5_000,
        'Timed out waiting for source-projection entry'
      );
      expect(await waitForBlockedOperation(sourceReplay,
        sourcePid,
        sourceName,
        'from stripe_balance_transactions'
      )).toEqual([classifierPid]);

      await releaseBlocker(blocker);
      assertFulfilled(
        ['classifier replay', 'source replay'],
        await within(
          Promise.allSettled([classifierReplay, sourceReplay]),
          7_500,
          'Timed out completing classifier/source replay probes'
        )
      );
    } finally {
      await within(Promise.allSettled([
        releaseBlocker(blocker),
        ...(classifierReplay ? [classifierReplay] : []),
        ...(sourceReplay ? [sourceReplay] : [])
      ]), 7_500, 'Timed out cleaning up classifier/source replay probes');
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
      const publisherPid = await within(
        publisherEntered.promise,
        5_000,
        'Timed out waiting for payout-publication entry'
      );
      expect(await waitForBlockedQuery(
        publisherPid,
        publisherName,
        'pg_advisory_xact_lock'
      )).toEqual([blocker.pid]);

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
      const projectionPid = await within(
        projectionEntered.promise,
        5_000,
        'Timed out waiting for reverse-order projection entry'
      );
      expect(await waitForBlockedQuery(
        projectionPid,
        projectionName,
        'pg_advisory_xact_lock'
      )).toEqual([publisherPid]);

      await releaseBlocker(blocker);
      assertFulfilled(
        ['payout publication', 'reverse-input projection'],
        await within(
          Promise.allSettled([publication, reverseProjection]),
          7_500,
          'Timed out completing payout-publication/reverse-projection probes'
        )
      );
    } finally {
      await within(Promise.allSettled([
        releaseBlocker(blocker),
        ...(publication ? [publication] : []),
        ...(reverseProjection ? [reverseProjection] : [])
      ]), 7_500, 'Timed out cleaning up payout-publication/reverse-projection probes');
    }
  }, 15_000);

  it('holds the real reporting-correction executor at every canonical lock without domain mutation', async () => {
    expect(lockFinancialProjectionRows.toString().replace(/\s+/gu, ' ').toLowerCase())
      .toContain('order by resource_type, resource_id, safe_code for update');
    const fixture = await createCorrectionLockFixture(
      `correction-lock-${randomUUID()}`
    );
    expect({
      payouts: new Set(fixture.payoutIds).size,
      balanceTransactions: new Set(
        fixture.balanceTransactions.map((row) => row.id)
      ).size,
      classifications: new Set(
        fixture.classifications.map((row) => row.subjectId)
      ).size,
      allocations: new Set(fixture.allocationSets.map((row) => row.id)).size,
      issues: new Set(fixture.issues.map((row) => row.resourceId)).size
    }).toEqual({
      payouts: 2,
      balanceTransactions: 2,
      classifications: 2,
      allocations: 4,
      issues: 2
    });
    const applicationName = probeName('correction-executor', fixture.commandId);
    const entered = deferred<number>();
    const preparedProbe = await prepareCorrectionWorkerProbe(
      applicationName,
      fixture,
      entered
    );
    const stages = correctionBarrierStages(fixture, preparedProbe.jobId);
    let barrier: CorrectionBarrier;
    try {
      barrier = await beginCorrectionBarrier(
        probeName('correction-blocker', fixture.commandId),
        stages
      );
    } catch (error) {
      await within(
        preparedProbe.dispose(),
        5_000,
        'Timed out disposing correction probe after barrier setup failure'
      ).catch(() => undefined);
      throw error;
    }
    let probe: CorrectionWorkerProbe | undefined;
    let testError: unknown;
    let barrierCleanupError: unknown;
    try {
      const before = await readCorrectionDomainSnapshot(fixture);
      probe = preparedProbe.start();
      const executorPid = await waitForCorrectionExecutorEntry(entered, probe);
      for (const stage of stages) {
        await waitForCorrectionBarrierStage(
          probe.operation, executorPid, applicationName, barrier, stage
        );
        expect(await readCorrectionCommandLifecycle(fixture.commandId)).toMatchObject({
          command_status: 'pending',
          safe_result_code: null,
          safe_result: null,
          job_status: 'running',
          attempts: 1,
          last_error: null,
          command_audit_count: 0
        });
        expect(await readCorrectionDomainSnapshot(fixture)).toEqual(before);
        await releaseCorrectionBarrierStage(barrier, stage);
      }
      await expect(within(
        probe.operation,
        10_000,
        'Timed out waiting for reporting-correction worker completion'
      )).resolves.toBeUndefined();
      expect(await readCorrectionDomainSnapshot(fixture)).toEqual(before);
      expect(await readCorrectionCommandLifecycle(fixture.commandId)).toEqual({
        command_status: 'conflict',
        safe_result_code: 'stale_state',
        safe_result: null,
        job_status: 'failed',
        attempts: 1,
        last_error: 'Financial administrator command conflicted with current state.',
        command_audit_count: 1
      });
    } catch (error) {
      testError = error;
    } finally {
      probe?.abort();
      try {
        const cleanup = await within(
          Promise.allSettled([
            releaseCorrectionBarrier(barrier),
            preparedProbe.dispose(),
            ...(probe ? [probe.operation] : [])
          ]),
          7_500,
          'Timed out cleaning up reporting-correction lock probe'
        );
        const barrierCleanup = cleanup[0];
        if (barrierCleanup?.status === 'rejected') {
          barrierCleanupError = barrierCleanup.reason;
        }
      } catch (error) {
        barrierCleanupError = error;
      }
    }
    if (testError !== undefined) throw testError;
    if (barrierCleanupError !== undefined) throw barrierCleanupError;
  }, 45_000);

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
      const finalizationPid = await within(
        finalizationEntered.promise,
        5_000,
        'Timed out waiting for refund-finalization entry'
      );
      expect(await waitForBlockedOperation(
        finalization,
        finalizationPid,
        finalizationName,
        'pg_advisory_xact_lock'
      )).toEqual([blocker.pid]);

      competingAuthority = lockProjectionAuthority(
        competingAuthorityName,
        authorityEntered
      );
      observe(competingAuthority);
      const competingAuthorityPid = await within(
        authorityEntered.promise,
        5_000,
        'Timed out waiting for competing projection-authority entry'
      );
      expect(await waitForBlockedOperation(
        competingAuthority,
        competingAuthorityPid,
        competingAuthorityName,
        'from financial_projection_versions'
      )).toEqual([finalizationPid]);

      await releaseBlocker(blocker);
      const outcomes = await within(
        Promise.allSettled([finalization, competingAuthority]),
        7_500,
        'Timed out completing finalization/projection-authority probes'
      );
      assertFulfilled(
        ['refund finalization', 'competing projection authority'],
        outcomes
      );
      expect(outcomes[0]).toEqual({ status: 'fulfilled', value: 'not_eligible' });
      expect(await readRefundFinalizationProbeSnapshot(purchase, commandId)).toEqual(before);
    } finally {
      await within(Promise.allSettled([
        releaseBlocker(blocker),
        ...(finalization ? [finalization] : []),
        ...(competingAuthority ? [competingAuthority] : [])
      ]), 7_500, 'Timed out cleaning up finalization/projection-authority probes');
    }
  }, 15_000);

  it('lets recovery hold projection authority while waiting on the order graph without mutation', async () => {
    const purchase = await createPurchaseFixture(`ch_recovery_authority_${randomUUID()}`);
    const before = await readRefundFinalizationProbeSnapshot(purchase, randomUUID());
    const blocker = await beginBlocker(
      probeName('recovery-order-blocker', purchase.orderId),
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`pale-orbit:commerce:order:${purchase.orderId}`]
    );
    const recoveryName = probeName('recovery-authority', purchase.refundId);
    const authorityName = probeName('recovery-competing-authority', purchase.paymentId);
    const recoveryEntered = deferred<number>();
    const authorityEntered = deferred<number>();
    let recovery: RecoveryWorkerProbe | undefined;
    let competingAuthority: Promise<void> | undefined;
    try {
      recovery = await runRecoveryWorkerProbe(recoveryName, purchase, recoveryEntered);
      observe(recovery.operation);
      const recoveryPid = await within(
        recoveryEntered.promise,
        5_000,
        'Timed out waiting for recovery entry'
      );
      expect(await waitForBlockedOperation(
        recovery.operation,
        recoveryPid,
        recoveryName,
        'transition_administrative_recovery_grant_after_admin_command'
      )).toEqual([blocker.pid]);
      expect(await readRefundFinalizationProbeSnapshot(
        purchase, recovery.commandId
      )).toEqual(before);

      competingAuthority = lockProjectionAuthority(authorityName, authorityEntered);
      observe(competingAuthority);
      const authorityPid = await within(
        authorityEntered.promise,
        5_000,
        'Timed out waiting for recovery projection-authority competitor'
      );
      expect(await waitForBlockedOperation(
        competingAuthority,
        authorityPid,
        authorityName,
        'from financial_projection_versions'
      )).toEqual([recoveryPid]);
      expect(await readRefundFinalizationProbeSnapshot(
        purchase, recovery.commandId
      )).toEqual(before);

      await releaseBlocker(blocker);
      assertFulfilled(
        ['administrative recovery', 'competing projection authority'],
        await within(
          Promise.allSettled([recovery.operation, competingAuthority]),
          7_500,
          'Timed out completing recovery/projection-authority probes'
        )
      );
      expect(await readRefundFinalizationProbeSnapshot(
        purchase, recovery.commandId
      )).toEqual(before);
      await expect(ownerDatabaseClient.pool.query(
        `select status, safe_result_code from financial_admin_commands where id = $1`,
        [recovery.commandId]
      )).resolves.toMatchObject({
        rows: [{ status: 'conflict', safe_result_code: 'stale_state' }]
      });
    } finally {
      recovery?.abort();
      await within(Promise.allSettled([
        releaseBlocker(blocker),
        ...(recovery ? [recovery.operation] : []),
        ...(competingAuthority ? [competingAuthority] : [])
      ]), 7_500, 'Timed out cleaning up recovery/projection-authority probes');
    }
  }, 20_000);

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
      const refundPid = await within(
        refundEntered.promise,
        5_000,
        'Timed out waiting for refund-finalization projection entry'
      );
      expect(await waitForBlockedOperation(refundFinalization,
        refundPid,
        refundName,
        'from stripe_balance_transactions'
      )).toEqual([financialBlocker.pid]);

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
      )).toEqual([scopeBlocker.pid]);

      await releaseBlocker(scopeBlocker);
      expect(await waitForBlockedOperation(
        refundFinalization,
        refundPid,
        refundName,
        'from "entitlement_grants"'
      )).toEqual([grantBlocker.pid]);

      await releaseBlocker(grantBlocker);
      await expect(within(
        refundFinalization,
        7_500,
        'Timed out completing finalization/entitlement probe'
      )).resolves.toBe('not_eligible');
      expect(await readRefundFinalizationProbeSnapshot(purchase, commandId)).toEqual(before);
    } finally {
      await within(Promise.allSettled([
        releaseBlocker(financialBlocker),
        ...(scopeBlocker ? [releaseBlocker(scopeBlocker)] : []),
        ...(grantBlocker ? [releaseBlocker(grantBlocker)] : []),
        ...(refundFinalization ? [refundFinalization] : [])
      ]), 7_500, 'Timed out cleaning up finalization/entitlement probes');
    }
  }, 15_000);

  it('pins recovery financial closure ahead of entitlement mutation in the protected routine', async () => {
    const definition = (await ownerDatabaseClient.pool.query<{ definition: string }>(`
      select pg_get_functiondef(
        'public.transition_administrative_recovery_grant_after_admin_command(uuid)'
          ::regprocedure
      ) as definition
    `)).rows[0]!.definition.replace(/\s+/gu, ' ').toLowerCase();
    const activationStart = definition.indexOf(
      "if locked_command_kind = 'administrative_recovery_activate'"
    );
    const activation = definition.slice(activationStart);
    const orderedFragments = [
      'from "public"."financial_projection_versions"',
      "'pale-orbit:financial:replay-enrollment'",
      "'pale-orbit:financial:payout:'",
      "'pale-orbit:financial:balance-transaction:'",
      "'pale-orbit:financial:classification:balance_transaction:'",
      "'pale-orbit:financial:allocation:'",
      "'pale-orbit:financial:issue:'",
      'from "public"."refund_allocation_finalization_effects"',
      'from "public"."refund_allocations"',
      'from "public"."refund_reporting_correction_sets"',
      'from "public"."financial_allocation_sets"',
      "'pale-orbit:commerce:entitlement:'",
      'from "public"."current_financial_projection_heads"',
      'target_head.compatible_correction_tip_id = correction_row.id',
      'insert into "public"."entitlement_grants"'
    ] as const;
    let cursor = -1;
    for (const fragment of orderedFragments) {
      const position = activation.indexOf(fragment, cursor + 1);
      expect(position, `missing/out-of-order recovery fragment: ${fragment}`)
        .toBeGreaterThan(cursor);
      cursor = position;
    }
  });
});

describe('financial administrator command race topology', () => {
  it('lets real draft save and discard stop after the purchase graph', async () => {
    const purchase = await createPurchaseFixture(`ch_draft_tail_${randomUUID()}`);
    await ownerDatabaseClient.pool.query(
      `insert into user_roles (user_id, role) values ($1, 'admin')`,
      [purchase.userId]
    );
    await ownerDatabaseClient.db.update(refunds).set({
      status: 'succeeded',
      allocationStatus: 'needs_review'
    }).where(eq(refunds.id, purchase.refundId));
    const projection = await createCorrectionProjectionFixture({
      label: `draft-tail-${purchase.refundId}`,
      refundId: purchase.refundId,
      stripeRefundId: purchase.stripeRefundId,
      orderItemId: purchase.itemId,
      totalMinor: 100
    });
    const payout = await createPayoutFixture(
      [projection.balanceTransactionId],
      true
    );
    const issue = await databaseClient.db.transaction((transaction) =>
      observeFinancialIssue(transaction, {
        resourceType: 'allocation_set',
        resourceId: projection.grossAllocationSetId,
        safeCode: 'correction_rebase_required',
        impact: 'exception',
        actor: { type: 'system', id: 'financial-worker' },
        correlationId: `draft-tail-issue-${purchase.refundId}`
      })
    );
    // A correction on this payment is part of the purchase graph that drafts intentionally lock.
    // Hold a different current-tip row to prove draft execution has no unscoped tail query.
    const currentCorrectionSetId = await createCurrentCorrectionSentinel(
      purchase.userId,
      `draft-tail-${purchase.refundId}`
    );
    const blockerName = probeName('draft-tail-blocker', purchase.refundId);
    const blocker = await beginDraftTailBlocker(
      blockerName,
      purchase,
      {
        balanceTransactionId: projection.balanceTransactionId,
        payoutId: payout.payoutId,
        classificationId: projection.classificationId,
        allocationSets: [
          { id: projection.grossAllocationSetId, basis: 'gross_amount' },
          { id: projection.feeAllocationSetId, basis: 'fee' }
        ],
        issueId: issue.id,
        issueResourceId: projection.grossAllocationSetId,
        currentCorrectionSetId
      }
    );
    let save: RefundCommandWorkerProbe | undefined;
    let discard: RefundCommandWorkerProbe | undefined;
    try {
      const blockerActivity = await ownerDatabaseClient.pool.query<{
        applicationName: string;
        state: string;
      }>(`
        select application_name as "applicationName", state
        from pg_stat_activity where pid = $1
      `, [blocker.pid]);
      expect(blockerActivity.rows).toEqual([{
        applicationName: blockerName,
        state: 'idle in transaction'
      }]);

      const saveName = probeName('draft-save-tail', purchase.refundId);
      const saveEntered = deferred<number>();
      save = await runRefundCommandWorkerProbe(saveName, purchase, {
        kind: 'refund_draft_save',
        refundId: purchase.refundId,
        expectedVersion: null,
        items: [{ orderItemId: purchase.itemId, totalPresentmentMinor: 100 }]
      }, saveEntered);
      await within(
        saveEntered.promise,
        5_000,
        'Timed out waiting for draft-save handler entry'
      );
      await within(
        save.operation,
        10_000,
        'Draft save attempted a projection, financial, or entitlement tail lock'
      );
      await expect(ownerDatabaseClient.pool.query(
        `select status::text, safe_result_code from financial_admin_commands where id = $1`,
        [save.commandId]
      )).resolves.toMatchObject({
        rows: [{ status: 'succeeded', safe_result_code: 'draft_saved' }]
      });

      const discardName = probeName('draft-discard-tail', purchase.refundId);
      const discardEntered = deferred<number>();
      discard = await runRefundCommandWorkerProbe(discardName, purchase, {
        kind: 'refund_draft_discard',
        refundId: purchase.refundId,
        expectedActiveDraftVersion: 1
      }, discardEntered);
      await within(
        discardEntered.promise,
        5_000,
        'Timed out waiting for draft-discard handler entry'
      );
      await within(
        discard.operation,
        10_000,
        'Draft discard attempted a projection, financial, or entitlement tail lock'
      );
      await expect(ownerDatabaseClient.pool.query(
        `select status::text, safe_result_code from financial_admin_commands where id = $1`,
        [discard.commandId]
      )).resolves.toMatchObject({
        rows: [{ status: 'succeeded', safe_result_code: 'draft_discarded' }]
      });
    } finally {
      save?.abort();
      discard?.abort();
      await within(Promise.allSettled([
        releaseBlocker(blocker),
        ...(save ? [save.operation] : []),
        ...(discard ? [discard.operation] : [])
      ]), 7_500, 'Timed out cleaning up draft stopping-point probe');
    }
  }, 25_000);

  it('serializes draft save before finalization at the administrator prefix (race 4)', async () => {
    const purchase = await createPurchaseFixture(`ch_draft_finalize_${randomUUID()}`);
    await ownerDatabaseClient.pool.query(
      `insert into user_roles (user_id, role) values ($1, 'admin')`,
      [purchase.userId]
    );
    await ownerDatabaseClient.db.update(refunds).set({
      status: 'succeeded',
      allocationStatus: 'needs_review'
    }).where(eq(refunds.id, purchase.refundId));
    const blocker = await beginBlocker(
      probeName('draft-finalize-order-blocker', purchase.orderId),
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`pale-orbit:commerce:order:${purchase.orderId}`]
    );
    const draftName = probeName('race4-draft-save', purchase.refundId);
    const finalizationName = probeName('race4-finalization', purchase.refundId);
    const draftEntered = deferred<number>();
    const finalizationEntered = deferred<number>();
    let draft: RefundCommandWorkerProbe | undefined;
    let finalization: RefundCommandWorkerProbe | undefined;
    let preparedDraft: PreparedRefundCommandWorkerProbe | undefined;
    let preparedFinalization: PreparedRefundCommandWorkerProbe | undefined;
    try {
      preparedDraft = await prepareRefundCommandWorkerProbe(draftName, purchase, {
        kind: 'refund_draft_save',
        refundId: purchase.refundId,
        expectedVersion: null,
        items: [{ orderItemId: purchase.itemId, totalPresentmentMinor: 100 }]
      }, draftEntered);
      preparedFinalization = await prepareRefundCommandWorkerProbe(
        finalizationName,
        purchase,
        {
          kind: 'refund_allocation_finalize',
          refundId: purchase.refundId,
          expectedActiveDraftVersion: 1,
          previewFingerprint: 'e'.repeat(64),
          confirmation: 'finalize_refund_allocation'
        },
        finalizationEntered
      );
      draft = preparedDraft.start();
      const draftPid = await within(
        draftEntered.promise,
        5_000,
        'Timed out waiting for race-4 draft handler'
      );
      expect(await waitForBlockedOperation(
        draft.operation,
        draftPid,
        draftName,
        'pg_advisory_xact_lock'
      )).toEqual([blocker.pid]);

      finalization = preparedFinalization.start();
      const finalizationPid = await within(
        finalizationEntered.promise,
        5_000,
        'Timed out waiting for race-4 finalization handler'
      );
      expect(await waitForBlockedOperation(
        finalization.operation,
        finalizationPid,
        finalizationName,
        'pg_advisory_xact_lock'
      )).toEqual([draftPid]);

      await releaseBlocker(blocker);
      assertFulfilled(
        ['draft save command', 'finalization command'],
        await within(
          Promise.allSettled([draft.operation, finalization.operation]),
          7_500,
          'Timed out completing race-4 command probes'
        )
      );
      const lifecycle = await ownerDatabaseClient.pool.query<{
        id: string;
        status: string;
        safeResultCode: string | null;
        lastError: string | null;
      }>(`
        select command.id, command.status::text as status,
          command.safe_result_code as "safeResultCode", job.last_error as "lastError"
        from financial_admin_commands command
        join jobs job on job.id = command.job_id
        where command.id = any($1::uuid[]) order by command.id
      `, [[draft.commandId, finalization.commandId]]);
      expect(lifecycle.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: draft.commandId,
          status: 'succeeded',
          safeResultCode: 'draft_saved',
          lastError: null
        }),
        expect.objectContaining({
          id: finalization.commandId,
          status: 'conflict',
          lastError: expect.not.stringContaining('deadlock')
        })
      ]));
    } finally {
      draft?.abort();
      finalization?.abort();
      await within(Promise.allSettled([
        releaseBlocker(blocker),
        ...(preparedDraft ? [preparedDraft.dispose()] : []),
        ...(preparedFinalization ? [preparedFinalization.dispose()] : []),
        ...(draft ? [draft.operation] : []),
        ...(finalization ? [finalization.operation] : [])
      ]), 7_500, 'Timed out cleaning up race-4 probes');
    }
  }, 25_000);

  it('serializes finalization before correction at the administrator prefix (race 5)', async () => {
    const correctionFixture = await createCorrectionLockFixture(
      `race5-correction-${randomUUID()}`
    );
    const correctionName = probeName('race5-correction', correctionFixture.commandId);
    const correctionEntered = deferred<number>();
    const preparedCorrection = await prepareCorrectionWorkerProbe(
      correctionName,
      correctionFixture,
      correctionEntered
    );
    let purchase: PurchaseFixture;
    let blocker: Blocker;
    try {
      purchase = await createPurchaseFixture(`ch_race5_finalize_${randomUUID()}`);
      await ownerDatabaseClient.pool.query(
        `insert into user_roles (user_id, role) values ($1, 'admin')`,
        [purchase.userId]
      );
      blocker = await beginBlocker(
        probeName('race5-order-blocker', purchase.orderId),
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`pale-orbit:commerce:order:${purchase.orderId}`]
      );
    } catch (error) {
      await within(
        preparedCorrection.dispose(),
        5_000,
        'Timed out disposing race-5 correction setup'
      ).catch(() => undefined);
      throw error;
    }
    const finalizationName = probeName('race5-finalization', purchase.refundId);
    const finalizationEntered = deferred<number>();
    let finalization: RefundCommandWorkerProbe | undefined;
    let correction: CorrectionWorkerProbe | undefined;
    try {
      finalization = await runRefundCommandWorkerProbe(finalizationName, purchase, {
        kind: 'refund_allocation_finalize',
        refundId: purchase.refundId,
        expectedActiveDraftVersion: 1,
        previewFingerprint: 'e'.repeat(64),
        confirmation: 'finalize_refund_allocation'
      }, finalizationEntered);
      const finalizationPid = await within(
        finalizationEntered.promise,
        5_000,
        'Timed out waiting for race-5 finalization handler'
      );
      expect(await waitForBlockedOperation(
        finalization.operation,
        finalizationPid,
        finalizationName,
        'pg_advisory_xact_lock'
      )).toEqual([blocker.pid]);

      correction = preparedCorrection.start();
      const correctionPid = await within(
        correctionEntered.promise,
        5_000,
        'Timed out waiting for race-5 correction handler'
      );
      expect(await waitForBlockedOperation(
        correction.operation,
        correctionPid,
        correctionName,
        'pg_advisory_xact_lock'
      )).toEqual([finalizationPid]);

      await releaseBlocker(blocker);
      assertFulfilled(
        ['finalization command', 'correction command'],
        await within(
          Promise.allSettled([finalization.operation, correction.operation]),
          7_500,
          'Timed out completing race-5 command probes'
        )
      );
      expectConflictLifecycle(
        await readAdminCommandTerminalLifecycle(finalization.commandId),
        'refund_allocation_finalize',
        'not_eligible'
      );
      expectConflictLifecycle(
        await readAdminCommandTerminalLifecycle(correctionFixture.commandId),
        'refund_reporting_correction_create',
        'stale_state'
      );
    } finally {
      finalization?.abort();
      correction?.abort();
      await within(Promise.allSettled([
        releaseBlocker(blocker),
        preparedCorrection.dispose(),
        ...(finalization ? [finalization.operation] : []),
        ...(correction ? [correction.operation] : [])
      ]), 7_500, 'Timed out cleaning up race-5 probes');
    }
  }, 30_000);

  it('keeps classifier rebase behind correction projection authority (race 6)', async () => {
    const fixture = await createCorrectionLockFixture(`race6-${randomUUID()}`);
    const correctionName = probeName('race6-correction', fixture.commandId);
    const correctionEntered = deferred<number>();
    const prepared = await prepareCorrectionWorkerProbe(
      correctionName,
      fixture,
      correctionEntered
    );
    let blocker: Blocker;
    try {
      blocker = await beginBlocker(
        probeName('race6-order-blocker', fixture.purchase.orderId),
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`pale-orbit:commerce:order:${fixture.purchase.orderId}`]
      );
    } catch (error) {
      await within(
        prepared.dispose(),
        5_000,
        'Timed out disposing race-6 correction setup'
      ).catch(() => undefined);
      throw error;
    }
    const replayName = probeName(
      'race6-classifier-rebase',
      fixture.balanceTransactions[0]!.id
    );
    const replayEntered = deferred<number>();
    let correction: CorrectionWorkerProbe | undefined;
    let replay: Promise<void> | undefined;
    try {
      correction = prepared.start();
      const correctionPid = await within(
        correctionEntered.promise,
        5_000,
        'Timed out waiting for race-6 correction handler'
      );
      expect(await waitForBlockedOperation(
        correction.operation,
        correctionPid,
        correctionName,
        'pg_advisory_xact_lock'
      )).toEqual([blocker.pid]);

      const target = fixture.balanceTransactions[0]!;
      replay = replayClassifierRebase(
        replayName,
        target.id,
        target.fingerprint,
        replayEntered
      );
      observe(replay);
      const replayPid = await within(
        replayEntered.promise,
        5_000,
        'Timed out waiting for race-6 classifier rebase'
      );
      expect(await waitForBlockedOperation(
        replay,
        replayPid,
        replayName,
        'from financial_projection_versions'
      )).toEqual([correctionPid]);

      await releaseBlocker(blocker);
      assertFulfilled(
        ['correction command', 'classifier rebase'],
        await within(
          Promise.allSettled([correction.operation, replay]),
          7_500,
          'Timed out completing race-6 command probes'
        )
      );
      expectConflictLifecycle(
        await readAdminCommandTerminalLifecycle(fixture.commandId),
        'refund_reporting_correction_create',
        'stale_state'
      );
    } finally {
      correction?.abort();
      await within(Promise.allSettled([
        releaseBlocker(blocker),
        prepared.dispose(),
        ...(correction ? [correction.operation] : []),
        ...(replay ? [replay] : [])
      ]), 7_500, 'Timed out cleaning up race-6 probes');
    }
  }, 30_000);

  it('orders recovery against correction and refund/dispute rows (race 7)', async () => {
    const correctionFixture = await createCorrectionLockFixture(
      `race7-correction-${randomUUID()}`
    );
    const correctionName = probeName('race7-correction', correctionFixture.commandId);
    const correctionEntered = deferred<number>();
    const preparedCorrection = await prepareCorrectionWorkerProbe(
      correctionName,
      correctionFixture,
      correctionEntered
    );
    let purchase: PurchaseFixture;
    let refundBlocker: Blocker | undefined;
    let disputeBlocker: Blocker | undefined;
    try {
      purchase = await createPurchaseFixture(`ch_race7_recovery_${randomUUID()}`);
      const [dispute] = await ownerDatabaseClient.db.insert(disputes).values({
        paymentId: purchase.paymentId,
        stripeDisputeId: `dp_race7_${randomUUID()}`,
        status: 'open',
        amountMinor: 100,
        currency: 'USD',
        reason: 'fraudulent',
        providerCreatedAt: fixtureTime,
        providerUpdatedAt: fixtureTime
      }).returning();
      if (!dispute) throw new Error('Expected race-7 dispute fixture');
      refundBlocker = await beginBlocker(
        probeName('race7-refund-reconcile', purchase.refundId),
        'select id from refunds where id = $1 for update',
        [purchase.refundId]
      );
      disputeBlocker = await beginBlocker(
        probeName('race7-dispute-reconcile', dispute.id),
        'select id from disputes where id = $1 for update',
        [dispute.id]
      );
    } catch (error) {
      if (refundBlocker) await releaseBlocker(refundBlocker).catch(() => undefined);
      if (disputeBlocker) await releaseBlocker(disputeBlocker).catch(() => undefined);
      await within(
        preparedCorrection.dispose(),
        5_000,
        'Timed out disposing race-7 correction setup'
      ).catch(() => undefined);
      throw error;
    }
    const recoveryName = probeName('race7-recovery', purchase.refundId);
    const recoveryEntered = deferred<number>();
    let recovery: RecoveryWorkerProbe | undefined;
    let correction: CorrectionWorkerProbe | undefined;
    try {
      recovery = await runRecoveryWorkerProbe(recoveryName, purchase, recoveryEntered);
      const recoveryPid = await within(
        recoveryEntered.promise,
        5_000,
        'Timed out waiting for race-7 recovery executor'
      );
      expect(await waitForBlockedOperation(
        recovery.operation,
        recoveryPid,
        recoveryName,
        'transition_administrative_recovery_grant_after_admin_command'
      )).toEqual([refundBlocker.pid]);

      correction = preparedCorrection.start();
      const correctionPid = await within(
        correctionEntered.promise,
        5_000,
        'Timed out waiting for race-7 correction handler'
      );
      expect(await waitForBlockedOperation(
        correction.operation,
        correctionPid,
        correctionName,
        'pg_advisory_xact_lock'
      )).toEqual([recoveryPid]);

      await releaseBlocker(refundBlocker);
      expect(await waitForBlockedOperation(
        recovery.operation,
        recoveryPid,
        recoveryName,
        'transition_administrative_recovery_grant_after_admin_command'
      )).toEqual([disputeBlocker.pid]);

      await releaseBlocker(disputeBlocker);
      assertFulfilled(
        ['administrative recovery', 'correction command'],
        await within(
          Promise.allSettled([recovery.operation, correction.operation]),
          7_500,
          'Timed out completing race-7 command probes'
        )
      );
      expectConflictLifecycle(
        await readAdminCommandTerminalLifecycle(recovery.commandId),
        'administrative_recovery_activate',
        'stale_state'
      );
      expectConflictLifecycle(
        await readAdminCommandTerminalLifecycle(correctionFixture.commandId),
        'refund_reporting_correction_create',
        'stale_state'
      );
    } finally {
      recovery?.abort();
      correction?.abort();
      await within(Promise.allSettled([
        releaseBlocker(refundBlocker),
        releaseBlocker(disputeBlocker),
        preparedCorrection.dispose(),
        ...(recovery ? [recovery.operation] : []),
        ...(correction ? [correction.operation] : [])
      ]), 7_500, 'Timed out cleaning up race-7 probes');
    }
  }, 30_000);
});
