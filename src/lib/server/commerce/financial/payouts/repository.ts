import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { PayoutSnapshot } from '$lib/server/commerce/stripe/types';
import { parsePayoutSnapshot } from '$lib/server/commerce/stripe/financial-schemas';
import type { Database } from '$lib/server/db/client';
import type { PayoutImportRunRow } from '$lib/server/db/schema';
import type { DatabaseExecutor, DatabaseTransaction } from '$lib/server/db/transaction';
import { enqueueActiveEntityJob, enqueueJob } from '$lib/server/jobs/repository';
import { FINANCIAL_GENERATION_MAX } from '../constants';
import { PermanentFinancialError, RetryableFinancialError } from '../errors';
import {
  createFinancialPayoutContinuationJob,
  createFinancialPayoutImpactScanJob,
  createFinancialPayoutRelatedJob
} from '../jobs';
import { lockPayoutImportRows } from '../locks';
import { observeFinancialIssue } from '../issues';
import type { CurrentPayoutEvidence } from '../types';

export interface StartPayoutImportInput {
  readonly payoutId: string;
  readonly expectedGeneration: number;
  readonly correlationId: string;
}

export interface PersistPayoutImportPageInput {
  readonly payoutId: string;
  readonly runId: string;
  readonly expectedGeneration: number;
  readonly expectedPageCount: number;
  readonly expectedStartingAfter: string | null;
  readonly balanceTransactionIds: readonly string[];
  readonly hasMore: boolean;
  readonly nextStartingAfter: string | null;
  readonly correlationId: string;
}

export interface PublishPayoutMembershipInput {
  readonly payoutId: string;
  readonly runId: string;
  readonly expectedGeneration: number;
  readonly correlationId: string;
}

type SqlResult = { rows?: unknown[] };
type StageOutcome =
  | { payoutId: string; generation: number; changed: boolean }
  | { error: 'generation_exhausted' | 'immutable_mismatch' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function invalid(): never {
  throw new PermanentFinancialError('unsupported_provider_evidence');
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown, maximum = 100): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}

function generation(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= FINANCIAL_GENERATION_MAX;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

async function rows(executor: DatabaseExecutor, query: SQL): Promise<unknown[]> {
  return ((await executor.execute(query)) as SqlResult).rows ?? [];
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function payoutFingerprint(snapshot: PayoutSnapshot): string {
  return hash([
    'plan6b-payout-v1', snapshot.id, snapshot.livemode, snapshot.amountMinor,
    snapshot.currency, snapshot.automatic, snapshot.method,
    snapshot.createdAt.toISOString()
  ]);
}

function validStatusTransition(current: string, next: PayoutSnapshot['status']): boolean {
  return current === next ||
    (current === 'pending' && ['in_transit', 'paid', 'failed', 'canceled'].includes(next)) ||
    (current === 'in_transit' && ['paid', 'failed', 'canceled'].includes(next)) ||
    (current === 'paid' && ['failed', 'canceled'].includes(next));
}

function validReconciliationTransition(
  current: string,
  next: PayoutSnapshot['reconciliationStatus']
): boolean {
  return current === next ||
    (current === 'in_progress' && ['completed', 'not_applicable'].includes(next));
}

function runRow(value: unknown): PayoutImportRunRow {
  if (!value || typeof value !== 'object' || !uuid((value as { id?: unknown }).id)) {
    throw new Error('Payout import run query returned no row');
  }
  return value as PayoutImportRunRow;
}

async function selectRun(tx: DatabaseExecutor, runId: string): Promise<PayoutImportRunRow> {
  const found = await rows(tx, sql`
    select id, payout_id as "payoutId", generation, state,
      next_starting_after as "nextStartingAfter", candidate_count as "candidateCount",
      page_count as "pageCount", safe_outcome as "safeOutcome", started_at as "startedAt",
      updated_at as "updatedAt", completed_at as "completedAt"
    from payout_import_runs where id = ${runId}
  `);
  return runRow(found[0]);
}

async function linkedBalanceTransactionId(
  tx: DatabaseTransaction,
  providerId: string | null
): Promise<string | null> {
  if (providerId === null) return null;
  const found = await rows(tx, sql`
    select id from stripe_balance_transactions where provider_id = ${providerId}
  `) as Array<{ id: string }>;
  if (found.length !== 1 || !uuid(found[0]?.id)) invalid();
  return found[0]!.id;
}

async function enqueueSpec(
  tx: DatabaseTransaction,
  spec: { type: string; payload: object; deduplicationKey: string; maxAttempts: number }
): Promise<void> {
  await enqueueJob(tx, {
    type: spec.type,
    payload: spec.payload as never,
    deduplicationKey: spec.deduplicationKey,
    maxAttempts: spec.maxAttempts
  });
}

async function enqueueRelatedPayoutRoot(
  tx: DatabaseTransaction,
  spec: ReturnType<typeof createFinancialPayoutRelatedJob>
): Promise<void> {
  await enqueueActiveEntityJob(tx, {
    ...spec,
    activeEntity: { providerPayoutId: spec.payload.providerPayoutId }
  });
}

function sortedRelatedPayoutIds(values: Iterable<string | null>): string[] {
  return [...new Set([...values].filter((value): value is string => value !== null))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

async function payoutAudit(
  tx: DatabaseTransaction,
  payoutId: string,
  action: string,
  correlationId: string,
  after: Record<string, unknown>
): Promise<void> {
  await rows(tx, sql`
    insert into audit_events (
      actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id, after
    ) values (
      'system', 'financial-worker', ${action}, 'succeeded', 'financial_payout', ${payoutId},
      ${correlationId}, ${JSON.stringify(after)}::jsonb
    )
  `);
}

export async function stagePayoutSnapshot(
  database: Database,
  untrustedSnapshot: PayoutSnapshot,
  context: { readonly correlationId: string }
): Promise<{ payoutId: string; generation: number; changed: boolean }> {
  if (!exact(context, ['correlationId']) || !text(context.correlationId)) invalid();
  let snapshot: PayoutSnapshot;
  try {
    snapshot = parsePayoutSnapshot(untrustedSnapshot, untrustedSnapshot?.livemode);
  } catch {
    invalid();
  }
  const fingerprint = payoutFingerprint(snapshot);
  const outcome: StageOutcome = await database.transaction(async (tx) => {
    await rows(tx, sql`select pg_advisory_xact_lock(hashtextextended(${`pale-orbit:financial:payout:${snapshot.id}`}, 0))`);
    const currentRows = await rows(tx, sql`
      select id, provider_id as "providerId", live_mode as "liveMode", amount_minor as "amountMinor",
        currency, automatic, method, status, reconciliation_status as "reconciliationStatus",
        provider_created_at as "providerCreatedAt", arrival_at as "arrivalAt",
        balance_transaction_id as "balanceTransactionId",
        failure_balance_transaction_id as "failureBalanceTransactionId",
        original_provider_payout_id as "originalProviderPayoutId",
        reversed_by_provider_payout_id as "reversedByProviderPayoutId",
        safe_failure_code as "safeFailureCode", financial_generation as "financialGeneration",
        fingerprint_sha256 as "fingerprintSha256"
      from stripe_payouts where provider_id = ${snapshot.id} for update
    `) as Array<Record<string, unknown>>;
    const balanceTransactionId = await linkedBalanceTransactionId(tx, snapshot.balanceTransactionId);
    const failureBalanceTransactionId = await linkedBalanceTransactionId(tx, snapshot.failureBalanceTransactionId);
    const current = currentRows[0];
    if (!current) {
      const inserted = await rows(tx, sql`
        insert into stripe_payouts (
          provider_id, live_mode, amount_minor, currency, automatic, method, status,
          reconciliation_status, provider_created_at, arrival_at, retrieved_at,
          balance_transaction_id, failure_balance_transaction_id, original_provider_payout_id,
          reversed_by_provider_payout_id, safe_failure_code, financial_generation, fingerprint_sha256
        ) values (
          ${snapshot.id}, ${snapshot.livemode}, ${snapshot.amountMinor}, ${snapshot.currency},
          ${snapshot.automatic}, ${snapshot.method}, ${snapshot.status}, ${snapshot.reconciliationStatus},
          ${snapshot.createdAt}, ${snapshot.arrivalAt}, now(), ${balanceTransactionId},
          ${failureBalanceTransactionId}, ${snapshot.originalPayoutId}, ${snapshot.reversedByPayoutId},
          ${snapshot.safeFailureCode}, 0, ${fingerprint}
        ) returning id
      `) as Array<{ id: string }>;
      if (!uuid(inserted[0]?.id)) throw new Error('Payout insert returned no row');
      await payoutAudit(tx, inserted[0]!.id, 'financial.payout.imported', context.correlationId, {
        generation: 0, status: snapshot.status, reconciliationStatus: snapshot.reconciliationStatus
      });
      for (const relatedId of sortedRelatedPayoutIds([
        snapshot.originalPayoutId,
        snapshot.reversedByPayoutId
      ])) {
        await enqueueRelatedPayoutRoot(tx, createFinancialPayoutRelatedJob({
          providerPayoutId: relatedId,
          sourcePayoutId: snapshot.id,
          sourceFingerprintSha256: fingerprint
        }));
      }
      return { payoutId: inserted[0]!.id, generation: 0, changed: true };
    }
    const payoutId = current.id;
    if (!uuid(payoutId) || !generation(current.financialGeneration) ||
      typeof current.fingerprintSha256 !== 'string') invalid();
    const immutableMatches = current.providerId === snapshot.id &&
      current.liveMode === snapshot.livemode && current.amountMinor === snapshot.amountMinor &&
      current.currency === snapshot.currency && current.automatic === snapshot.automatic &&
      current.method === snapshot.method &&
      new Date(current.providerCreatedAt as Date | string).getTime() === snapshot.createdAt.getTime();
    if (current.fingerprintSha256 !== fingerprint || !immutableMatches) {
      await observeFinancialIssue(tx, {
        resourceType: 'payout', resourceId: payoutId, safeCode: 'immutable_mismatch',
        impact: 'exception', actor: { type: 'system', id: 'financial-worker' },
        correlationId: context.correlationId
      });
      return { error: 'immutable_mismatch' };
    }
    const reportingMatches = current.status === snapshot.status &&
      current.reconciliationStatus === snapshot.reconciliationStatus &&
      new Date(current.arrivalAt as Date | string).getTime() === snapshot.arrivalAt.getTime() &&
      current.balanceTransactionId === balanceTransactionId &&
      current.failureBalanceTransactionId === failureBalanceTransactionId &&
      current.originalProviderPayoutId === snapshot.originalPayoutId &&
      current.reversedByProviderPayoutId === snapshot.reversedByPayoutId &&
      current.safeFailureCode === snapshot.safeFailureCode;
    if (reportingMatches) {
      await rows(tx, sql`update stripe_payouts set retrieved_at = now() where id = ${payoutId}`);
      return { payoutId, generation: current.financialGeneration, changed: false };
    }
    if (!validStatusTransition(String(current.status), snapshot.status) ||
      !validReconciliationTransition(String(current.reconciliationStatus), snapshot.reconciliationStatus)) {
      await observeFinancialIssue(tx, {
        resourceType: 'payout', resourceId: payoutId, safeCode: 'immutable_mismatch',
        impact: 'exception', actor: { type: 'system', id: 'financial-worker' },
        correlationId: context.correlationId
      });
      return { error: 'immutable_mismatch' };
    }
    if (current.financialGeneration === FINANCIAL_GENERATION_MAX) {
      await observeFinancialIssue(tx, {
        resourceType: 'payout', resourceId: payoutId, safeCode: 'generation_exhausted',
        impact: 'exception', actor: { type: 'system', id: 'financial-worker' },
        correlationId: context.correlationId
      });
      return { error: 'generation_exhausted' };
    }
    const nextGeneration = current.financialGeneration + 1;
    await rows(tx, sql`
      update payout_import_runs set state = 'abandoned', safe_outcome = 'payout_changed',
        completed_at = now(), updated_at = now()
      where payout_id = ${payoutId} and state in ('collecting', 'publishable')
    `);
    await rows(tx, sql`
      update stripe_payouts set status = ${snapshot.status},
        reconciliation_status = ${snapshot.reconciliationStatus}, arrival_at = ${snapshot.arrivalAt},
        retrieved_at = now(), balance_transaction_id = ${balanceTransactionId},
        failure_balance_transaction_id = ${failureBalanceTransactionId},
        original_provider_payout_id = ${snapshot.originalPayoutId},
        reversed_by_provider_payout_id = ${snapshot.reversedByPayoutId},
        safe_failure_code = ${snapshot.safeFailureCode}, financial_generation = ${nextGeneration},
        fingerprint_sha256 = ${fingerprint} where id = ${payoutId}
    `);
    await enqueueSpec(tx, createFinancialPayoutImpactScanJob({
      payoutId, payoutGeneration: nextGeneration
    }));
    await payoutAudit(tx, payoutId, 'financial.payout.updated', context.correlationId, {
      generation: nextGeneration, status: snapshot.status,
      reconciliationStatus: snapshot.reconciliationStatus
    });
    const newlyObservedRelatedIds = new Set<string>();
    if (snapshot.originalPayoutId !== null &&
      snapshot.originalPayoutId !== current.originalProviderPayoutId) {
      newlyObservedRelatedIds.add(snapshot.originalPayoutId);
    }
    if (snapshot.reversedByPayoutId !== null &&
      snapshot.reversedByPayoutId !== current.reversedByProviderPayoutId) {
      newlyObservedRelatedIds.add(snapshot.reversedByPayoutId);
    }
    for (const relatedId of sortedRelatedPayoutIds(newlyObservedRelatedIds)) {
      await enqueueRelatedPayoutRoot(tx, createFinancialPayoutRelatedJob({
        providerPayoutId: relatedId,
        sourcePayoutId: snapshot.id,
        sourceFingerprintSha256: fingerprint
      }));
    }
    return { payoutId, generation: nextGeneration, changed: true };
  });
  if ('error' in outcome) throw new PermanentFinancialError(outcome.error);
  return outcome;
}

function assertStart(value: unknown): asserts value is StartPayoutImportInput {
  if (!exact(value, ['payoutId', 'expectedGeneration', 'correlationId']) ||
    !uuid(value.payoutId) || !generation(value.expectedGeneration) || !text(value.correlationId)) invalid();
}

export async function startOrResumePayoutImport(
  database: Database,
  input: StartPayoutImportInput
): Promise<PayoutImportRunRow> {
  assertStart(input);
  return database.transaction(async (tx) => {
    await rows(tx, sql`select pg_advisory_xact_lock(hashtextextended(${`pale-orbit:financial:payout:${input.payoutId}`}, 0))`);
    const payouts = await rows(tx, sql`
      select financial_generation as generation from stripe_payouts
      where id = ${input.payoutId} for update
    `) as Array<{ generation: number }>;
    if (payouts.length !== 1 || payouts[0]!.generation !== input.expectedGeneration) {
      throw new RetryableFinancialError('state_changed');
    }
    const published = await rows(tx, sql`
      select id, payout_id as "payoutId", generation, state,
        next_starting_after as "nextStartingAfter", candidate_count as "candidateCount",
        page_count as "pageCount", safe_outcome as "safeOutcome", started_at as "startedAt",
        updated_at as "updatedAt", completed_at as "completedAt"
      from payout_import_runs where payout_id = ${input.payoutId} and state = 'published'
      order by generation desc, id desc limit 1 for update
    `) as Array<{ generation: number }>;
    if (published[0] && published[0].generation + 1 === input.expectedGeneration) {
      return runRow(published[0]);
    }
    const existing = await rows(tx, sql`
      select id, payout_id as "payoutId", generation, state,
        next_starting_after as "nextStartingAfter", candidate_count as "candidateCount",
        page_count as "pageCount", safe_outcome as "safeOutcome", started_at as "startedAt",
        updated_at as "updatedAt", completed_at as "completedAt"
      from payout_import_runs where payout_id = ${input.payoutId}
        and generation = ${input.expectedGeneration} for update
    `);
    if (existing[0]) return runRow(existing[0]);
    await rows(tx, sql`
      update payout_import_runs set state = 'abandoned', safe_outcome = 'generation_changed',
        completed_at = now(), updated_at = now()
      where payout_id = ${input.payoutId} and state in ('collecting', 'publishable')
    `);
    const inserted = await rows(tx, sql`
      insert into payout_import_runs (payout_id, generation, state)
      values (${input.payoutId}, ${input.expectedGeneration}, 'collecting')
      returning id, payout_id as "payoutId", generation, state,
        next_starting_after as "nextStartingAfter", candidate_count as "candidateCount",
        page_count as "pageCount", safe_outcome as "safeOutcome", started_at as "startedAt",
        updated_at as "updatedAt", completed_at as "completedAt"
    `);
    return runRow(inserted[0]);
  });
}

function assertPage(value: unknown): asserts value is PersistPayoutImportPageInput {
  if (!exact(value, [
    'payoutId', 'runId', 'expectedGeneration', 'expectedPageCount', 'expectedStartingAfter',
    'balanceTransactionIds', 'hasMore', 'nextStartingAfter', 'correlationId'
  ]) || !uuid(value.payoutId) || !uuid(value.runId) || !generation(value.expectedGeneration) ||
    !generation(value.expectedPageCount) ||
    (value.expectedStartingAfter !== null && !text(value.expectedStartingAfter, 255)) ||
    !Array.isArray(value.balanceTransactionIds) || value.balanceTransactionIds.length > 100 ||
    value.balanceTransactionIds.some((id) => !uuid(id)) ||
    typeof value.hasMore !== 'boolean' ||
    (value.nextStartingAfter !== null && !text(value.nextStartingAfter, 255)) ||
    value.hasMore !== (value.nextStartingAfter !== null) || !text(value.correlationId)) invalid();
}

export async function persistPayoutImportPage(
  database: Database,
  input: PersistPayoutImportPageInput
): Promise<PayoutImportRunRow> {
  assertPage(input);
  const ids = [...new Set(input.balanceTransactionIds)].sort();
  return database.transaction(async (tx) => {
    const locked = await lockPayoutImportRows(tx, {
      payoutId: input.payoutId,
      runId: input.runId,
      expectedGeneration: input.expectedGeneration
    });
    if (locked.disposition !== 'fresh') throw new RetryableFinancialError('state_changed');
    const run = await selectRun(tx, input.runId);
    const replay = run.pageCount === input.expectedPageCount + 1 &&
      run.nextStartingAfter === input.nextStartingAfter &&
      run.state === (input.hasMore ? 'collecting' : 'publishable');
    if (replay) return run;
    if (run.state !== 'collecting' || run.pageCount !== input.expectedPageCount ||
      run.nextStartingAfter !== input.expectedStartingAfter) {
      throw new RetryableFinancialError('state_changed');
    }
    for (const id of ids) {
      await rows(tx, sql`
        insert into payout_import_run_entries (run_id, balance_transaction_id)
        values (${input.runId}, ${id}) on conflict do nothing
      `);
    }
    const counts = await rows(tx, sql`
      select count(*)::int as count from payout_import_run_entries where run_id = ${input.runId}
    `) as Array<{ count: number }>;
    const nextState = input.hasMore ? 'collecting' : 'publishable';
    await rows(tx, sql`
      update payout_import_runs set state = ${nextState}, next_starting_after = ${input.nextStartingAfter},
        candidate_count = ${counts[0]?.count ?? 0}, page_count = page_count + 1,
        updated_at = now() where id = ${input.runId}
    `);
    if (input.hasMore) {
      const payoutRows = await rows(tx, sql`
        select provider_id as "providerId" from stripe_payouts where id = ${input.payoutId}
      `) as Array<{ providerId: string }>;
      if (!text(payoutRows[0]?.providerId, 255)) invalid();
      await enqueueSpec(tx, createFinancialPayoutContinuationJob({
        providerPayoutId: payoutRows[0]!.providerId,
        payoutId: input.payoutId,
        runId: input.runId,
        payoutGeneration: input.expectedGeneration,
        cursorDigestSha256: hash(input.nextStartingAfter)
      }));
    }
    return selectRun(tx, input.runId);
  });
}

function assertPublish(value: unknown): asserts value is PublishPayoutMembershipInput {
  if (!exact(value, ['payoutId', 'runId', 'expectedGeneration', 'correlationId']) ||
    !uuid(value.payoutId) || !uuid(value.runId) || !generation(value.expectedGeneration) ||
    !text(value.correlationId)) invalid();
}

export async function publishPayoutMembership(
  database: Database,
  input: PublishPayoutMembershipInput
): Promise<{ generation: number; membershipCount: number }> {
  assertPublish(input);
  const outcome = await database.transaction(async (tx) => {
    const locked = await lockPayoutImportRows(tx, {
      payoutId: input.payoutId,
      runId: input.runId,
      expectedGeneration: input.expectedGeneration
    });
    if (locked.disposition === 'published_replay') {
      const count = await rows(tx, sql`
        select count(*)::int as count from stripe_payout_balance_transactions
        where payout_id = ${input.payoutId}
      `) as Array<{ count: number }>;
      return { generation: locked.payoutFinancialGeneration, membershipCount: count[0]?.count ?? 0 };
    }
    if (locked.disposition === 'stale') throw new RetryableFinancialError('state_changed');
    if (locked.runState !== 'publishable') throw new RetryableFinancialError('state_changed');
    const runCounts = await rows(tx, sql`
      select candidate_count as "candidateCount" from payout_import_runs where id = ${input.runId}
    `) as Array<{ candidateCount: number }>;
    if (runCounts.length !== 1 || runCounts[0]!.candidateCount !== locked.balanceTransactionIds.length) {
      throw new RetryableFinancialError('state_changed');
    }
    const payoutRows = await rows(tx, sql`
      select automatic, method, status, reconciliation_status as "reconciliationStatus",
        financial_generation as "financialGeneration"
      from stripe_payouts where id = ${input.payoutId}
    `) as Array<{ automatic: boolean; method: string; status: string; reconciliationStatus: string; financialGeneration: number }>;
    const payout = payoutRows[0];
    if (!payout || payout.financialGeneration !== input.expectedGeneration || !payout.automatic ||
      payout.method !== 'standard' || payout.status !== 'paid' ||
      payout.reconciliationStatus !== 'completed') {
      await rows(tx, sql`
        update payout_import_runs set state = 'abandoned', safe_outcome = 'payout_changed',
          completed_at = now(), updated_at = now() where id = ${input.runId}
      `);
      return { retry: true as const };
    }
    if (payout.financialGeneration === FINANCIAL_GENERATION_MAX) {
      const issue = await observeFinancialIssue(tx, {
        resourceType: 'payout', resourceId: input.payoutId, safeCode: 'generation_exhausted',
        impact: 'exception', actor: { type: 'system', id: 'financial-worker' },
        correlationId: input.correlationId
      });
      await rows(tx, sql`
        update payout_import_runs set state = 'exception', safe_outcome = 'generation_exhausted',
          completed_at = now(), updated_at = now() where id = ${input.runId}
      `);
      return { error: 'generation_exhausted' as const, issueId: issue.id };
    }
    const ids = [...locked.balanceTransactionIds].sort();
    const conflicts = ids.length === 0 ? [] : await rows(tx, sql`
      select balance_transaction_id as "balanceTransactionId" from stripe_payout_balance_transactions
      where balance_transaction_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
        and payout_id <> ${input.payoutId}
    `);
    if (conflicts.length > 0) {
      const issue = await observeFinancialIssue(tx, {
        resourceType: 'payout', resourceId: input.payoutId, safeCode: 'payout_membership_conflict',
        impact: 'exception', actor: { type: 'system', id: 'financial-worker' },
        correlationId: input.correlationId
      });
      await rows(tx, sql`
        update payout_import_runs set state = 'exception', safe_outcome = 'payout_membership_conflict',
          completed_at = now(), updated_at = now() where id = ${input.runId}
      `);
      return { error: 'payout_membership_conflict' as const, issueId: issue.id };
    }
    for (const id of ids) {
      await rows(tx, sql`
        insert into stripe_payout_balance_transactions
          (payout_id, balance_transaction_id, published_from_run_id)
        values (${input.payoutId}, ${id}, ${input.runId}) on conflict do nothing
      `);
    }
    const nextGeneration = payout.financialGeneration + 1;
    await rows(tx, sql`
      update payout_import_runs set state = 'published', safe_outcome = 'published',
        completed_at = now(), updated_at = now() where id = ${input.runId}
    `);
    await rows(tx, sql`
      update stripe_payouts set financial_generation = ${nextGeneration}
      where id = ${input.payoutId}
    `);
    await enqueueSpec(tx, createFinancialPayoutImpactScanJob({
      payoutId: input.payoutId, payoutGeneration: nextGeneration
    }));
    await payoutAudit(tx, input.payoutId, 'financial.payout.membership_published', input.correlationId, {
      generation: nextGeneration, membershipCount: ids.length, runId: input.runId
    });
    return { generation: nextGeneration, membershipCount: ids.length };
  });
  if ('retry' in outcome) throw new RetryableFinancialError('state_changed');
  if ('error' in outcome) throw new PermanentFinancialError(outcome.error);
  return outcome;
}

export async function loadCurrentPayoutEvidence(
  executor: DatabaseExecutor,
  balanceTransactionIds: readonly string[]
): Promise<CurrentPayoutEvidence> {
  if (!Array.isArray(balanceTransactionIds) || balanceTransactionIds.length > 100 ||
    balanceTransactionIds.some((id) => !uuid(id))) invalid();
  const ids = [...new Set(balanceTransactionIds)].sort();
  if (ids.length === 0) {
    return {
      relevantBalanceTransactionCount: 0,
      authoritativeMembershipCount: 0,
      paidAutomaticStandardCompletedCount: 0,
      conflictingMembershipCount: 0,
      hasOpenExceptionIssue: false,
      hasMissingPayoutReversal: false
    };
  }
  const evidence = await rows(executor, sql`
    with requested(id) as (values ${sql.join(ids.map((id) => sql`(${id}::uuid)`), sql`, `)}),
    membership as (
      select m.balance_transaction_id, m.payout_id
      from stripe_payout_balance_transactions m join requested r on r.id = m.balance_transaction_id
    ), payout_counts as (
      select balance_transaction_id, count(*)::int as count from membership group by balance_transaction_id
    )
    select
      (select count(*)::int from requested) as "relevantBalanceTransactionCount",
      (select count(distinct balance_transaction_id)::int from membership) as "authoritativeMembershipCount",
      (select count(distinct m.balance_transaction_id)::int from membership m join stripe_payouts p on p.id = m.payout_id
        where p.automatic and p.method = 'standard' and p.status = 'paid'
          and p.reconciliation_status = 'completed') as "paidAutomaticStandardCompletedCount",
      (select count(*)::int from payout_counts where count > 1) as "conflictingMembershipCount",
      exists(select 1 from membership m join financial_reconciliation_issues i
        on i.resource_type = 'payout' and i.resource_id = m.payout_id
        where i.state = 'open' and i.impact = 'exception') as "hasOpenExceptionIssue",
      exists(select 1 from membership m join stripe_payouts p on p.id = m.payout_id
        where p.status in ('failed', 'canceled')
          and p.failure_balance_transaction_id is null
          and (p.reversed_by_provider_payout_id is null or not exists (
            select 1 from stripe_payouts reversal
            where reversal.provider_id = p.reversed_by_provider_payout_id
          ))) as "hasMissingPayoutReversal"
  `);
  const result = evidence[0] as CurrentPayoutEvidence | undefined;
  if (!result) throw new Error('Payout evidence query returned no row');
  return result;
}
