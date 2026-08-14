import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import type { FinancialScanRunRow, JsonObject } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { enqueueActiveEntityJob, enqueueJob } from '$lib/server/jobs/repository';
import { PermanentFinancialError, RetryableFinancialError } from '../errors';
import {
  FINANCIAL_INITIAL_PAYOUT_LOOKBACK_MS,
  FINANCIAL_PAYOUT_OVERLAP_MS
} from '../constants';
import { activateFinancialProjectionVersionLocked } from '../rebase';
import {
  createFinancialCompositeReplayScanJob,
  createFinancialHourlyScanJob,
  createFinancialInitialScanJob,
  createFinancialPayoutImpactScanJob,
  createFinancialScanContinuationJob,
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_SOURCE_JOB,
  parseFinancialJobIdentity,
  parseFinancialScanContinuationJobPayload,
  type FinancialJobSpec,
  type FinancialJobIdentity,
  type FinancialScanJobPayload
} from '../jobs';

export type FinancialScanRootPayload = Exclude<
  FinancialScanJobPayload,
  { readonly kind: 'continuation' }
>;

export interface FinancialSourceScanCandidate {
  readonly sourceKind: 'payment' | 'refund' | 'dispute';
  readonly sourceId: string;
}

export interface FinancialPayoutScanCandidate {
  readonly providerPayoutId: string;
}

export interface FinancialClassificationScanCandidate {
  readonly subjectType: 'balance_transaction' | 'fee_detail';
  readonly subjectId: string;
  readonly sourceFingerprintSha256: string;
}

export interface FinancialScanPage<Value> {
  readonly data: readonly Value[];
  readonly hasMore: boolean;
  readonly checkpoint: string | null;
}

export interface CommitFinancialScanPageInput {
  readonly runId: string;
  readonly expectedPhase: (typeof PHASES)[number];
  readonly expectedCheckpoint: string | null;
  readonly expectedPageCount: number;
  readonly nextPhase: (typeof PHASES)[number];
  readonly nextCheckpoint: string | null;
  readonly processedCount: number;
  readonly children: readonly FinancialJobSpec<string, unknown>[];
  readonly complete: boolean;
}

export interface CompleteEmptyFinancialReplayInput {
  readonly runId: string;
  readonly expectedCheckpoint: string | null;
  readonly expectedPageCount: number;
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
  readonly correlationId: string;
}

type QueryResult = { rows?: unknown[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PHASES = [
  'source_page', 'payout_discovery_page', 'incomplete_payout_run_page',
  'payout_impact_page', 'classification_replay_page'
] as const;

function invalid(): never {
  throw new PermanentFinancialError('invalid_job_payload');
}

function stateChanged(): never {
  throw new RetryableFinancialError('state_changed');
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
}

function phase(value: unknown): value is (typeof PHASES)[number] {
  return typeof value === 'string' && PHASES.includes(value as (typeof PHASES)[number]);
}

function checkpoint(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 255);
}

function instant(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function rows(executor: DatabaseExecutor, query: SQL): Promise<unknown[]> {
  return ((await executor.execute(query)) as QueryResult).rows ?? [];
}

function canonicalRun(value: unknown): FinancialScanRunRow {
  if (!value || typeof value !== 'object') invalid();
  const row = value as Record<string, unknown>;
  if (!uuid(row.id) || typeof row.rootKey !== 'string' || typeof row.kind !== 'string' ||
    !phase(row.phase) || !['running', 'completed', 'exception'].includes(String(row.state)) ||
    !checkpoint(row.checkpoint) ||
    (row.cursorDigestSha256 !== null &&
      (typeof row.cursorDigestSha256 !== 'string' || !SHA256.test(row.cursorDigestSha256))) ||
    !count(row.processedCount) || !count(row.enqueuedCount) || !count(row.pageCount)) invalid();
  return {
    id: row.id,
    rootKey: row.rootKey,
    kind: row.kind,
    phase: row.phase,
    state: row.state as FinancialScanRunRow['state'],
    classifierVersion: row.classifierVersion as number | null,
    allocationAlgorithmVersion: row.allocationAlgorithmVersion as number | null,
    replayId: row.replayId as string | null,
    payoutDiscoveryCreatedGte: row.payoutDiscoveryCreatedGte === null
      ? null
      : new Date(row.payoutDiscoveryCreatedGte as Date | string),
    payoutDiscoveryCreatedLt: row.payoutDiscoveryCreatedLt === null
      ? null
      : new Date(row.payoutDiscoveryCreatedLt as Date | string),
    checkpoint: row.checkpoint,
    cursorDigestSha256: row.cursorDigestSha256 as string | null,
    processedCount: row.processedCount,
    enqueuedCount: row.enqueuedCount,
    pageCount: row.pageCount,
    safeOutcome: row.safeOutcome as string | null,
    startedAt: new Date(row.startedAt as Date | string),
    updatedAt: new Date(row.updatedAt as Date | string),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt as Date | string)
  };
}

const RUN_COLUMNS = sql`
  id, root_key as "rootKey", kind, phase, state,
  classifier_version as "classifierVersion",
  allocation_algorithm_version as "allocationAlgorithmVersion", replay_id as "replayId",
  payout_discovery_created_gte as "payoutDiscoveryCreatedGte",
  payout_discovery_created_lt as "payoutDiscoveryCreatedLt",
  checkpoint, cursor_digest_sha256 as "cursorDigestSha256",
  processed_count as "processedCount", enqueued_count as "enqueuedCount",
  page_count as "pageCount", safe_outcome as "safeOutcome",
  started_at as "startedAt", updated_at as "updatedAt", completed_at as "completedAt"
`;

async function selectRun(executor: DatabaseExecutor, id: string, lock = false): Promise<FinancialScanRunRow | null> {
  const result = await rows(executor, sql`
    select ${RUN_COLUMNS} from financial_scan_runs where id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return result[0] ? canonicalRun(result[0]) : null;
}

function epochSeconds(value: Date): number {
  const seconds = Math.floor(value.getTime() / 1000);
  if (!Number.isSafeInteger(seconds)) invalid();
  return seconds;
}

function frozenPayoutWindow(run: FinancialScanRunRow): {
  createdGte: number;
  createdLt: number;
} | null {
  const lower = run.payoutDiscoveryCreatedGte;
  const upper = run.payoutDiscoveryCreatedLt;
  if (lower === null && upper === null) return null;
  if (!instant(lower) || !instant(upper) || lower.getTime() >= upper.getTime()) invalid();
  return { createdGte: epochSeconds(lower), createdLt: epochSeconds(upper) };
}

export async function freezePayoutDiscoveryWindow(
  database: Database,
  run: FinancialScanRunRow,
  hour: string
): Promise<{ createdGte: number; createdLt: number }> {
  const existing = frozenPayoutWindow(run);
  if (existing) return existing;
  const hourStart = new Date(hour);
  if (!instant(hourStart) || hourStart.toISOString() !== hour ||
    run.phase !== 'payout_discovery_page' ||
    !['initial_backfill', 'hourly'].includes(run.kind)) invalid();
  const requestedUpper = new Date(hourStart.getTime() + 3_600_000);
  return database.transaction(async (transaction) => {
    await rows(transaction, sql`
      select pg_advisory_xact_lock(hashtextextended(
        ${`pale-orbit:financial:scan-run:${run.id}`}, 0
      ))
    `);
    const current = await selectRun(transaction, run.id, true);
    if (!current || current.state !== 'running' ||
      current.phase !== 'payout_discovery_page') stateChanged();
    const frozen = frozenPayoutWindow(current);
    if (frozen) return frozen;
    const states = await rows(transaction, sql`
      select covered_through as "coveredThrough"
      from financial_payout_discovery_state where singleton = true for update
    `) as Array<{ coveredThrough: Date | string | null }>;
    if (states.length !== 1) invalid();
    const coveredThrough = states[0]!.coveredThrough === null
      ? null
      : new Date(states[0]!.coveredThrough);
    if (coveredThrough !== null && !instant(coveredThrough)) invalid();
    let requestedLower: Date;
    if (coveredThrough !== null) {
      requestedLower = new Date(Math.min(
        hourStart.getTime() - FINANCIAL_PAYOUT_OVERLAP_MS,
        coveredThrough.getTime() - FINANCIAL_PAYOUT_OVERLAP_MS
      ));
    } else {
      const paid = await rows(transaction, sql`
        select min(paid_at) as "earliestPaidAt"
        from orders where status = 'paid' and paid_at is not null
      `) as Array<{ earliestPaidAt: Date | string | null }>;
      const earliest = paid[0]?.earliestPaidAt === null || paid[0]?.earliestPaidAt === undefined
        ? hourStart
        : new Date(paid[0].earliestPaidAt);
      if (!instant(earliest)) invalid();
      requestedLower = new Date(earliest.getTime() - FINANCIAL_INITIAL_PAYOUT_LOOKBACK_MS);
    }
    if (!instant(requestedLower) || requestedLower.getTime() >= requestedUpper.getTime()) invalid();
    const updated = await rows(transaction, sql`
      update financial_scan_runs set
        payout_discovery_created_gte = ${requestedLower},
        payout_discovery_created_lt = ${requestedUpper}, updated_at = now()
      where id = ${run.id} and payout_discovery_created_gte is null
        and payout_discovery_created_lt is null
      returning ${RUN_COLUMNS}
    `);
    const frozenRun = canonicalRun(updated[0]);
    const result = frozenPayoutWindow(frozenRun);
    if (!result) invalid();
    return result;
  });
}

function rootSpec(payload: FinancialScanRootPayload): {
  rootKey: string;
  kind: string;
  phase: (typeof PHASES)[number];
  classifierVersion: number | null;
  allocationAlgorithmVersion: number | null;
  replayId: string | null;
} {
  if (payload.kind === 'initial') {
    const spec = createFinancialInitialScanJob();
    return { rootKey: spec.deduplicationKey, kind: 'initial_backfill', phase: 'source_page',
      classifierVersion: null, allocationAlgorithmVersion: null, replayId: null };
  }
  if (payload.kind === 'hourly') {
    const spec = createFinancialHourlyScanJob(payload);
    return { rootKey: spec.deduplicationKey, kind: 'hourly', phase: 'source_page',
      classifierVersion: null, allocationAlgorithmVersion: null, replayId: null };
  }
  if (payload.kind === 'payout_impact') {
    const spec = createFinancialPayoutImpactScanJob(payload);
    return { rootKey: spec.deduplicationKey, kind: 'payout_impact', phase: 'payout_impact_page',
      classifierVersion: null, allocationAlgorithmVersion: null, replayId: null };
  }
  const spec = createFinancialCompositeReplayScanJob(payload);
  return { rootKey: spec.deduplicationKey, kind: 'classification_replay',
    phase: 'classification_replay_page', classifierVersion: payload.classifierVersion,
    allocationAlgorithmVersion: payload.allocationAlgorithmVersion, replayId: payload.replayId };
}

export async function startOrResumeFinancialScan(
  database: Database,
  payload: FinancialScanRootPayload
): Promise<FinancialScanRunRow> {
  const definition = rootSpec(payload);
  return database.transaction(async (transaction) => {
    await rows(transaction, sql`
      select pg_advisory_xact_lock(hashtextextended(${`pale-orbit:financial:scan:${definition.rootKey}`}, 0))
    `);
    const existing = await rows(transaction, sql`
      select ${RUN_COLUMNS} from financial_scan_runs where root_key = ${definition.rootKey} for update
    `);
    if (existing[0]) {
      const current = canonicalRun(existing[0]);
      if (current.kind !== definition.kind || current.classifierVersion !== definition.classifierVersion ||
        current.allocationAlgorithmVersion !== definition.allocationAlgorithmVersion ||
        current.replayId !== definition.replayId) {
        throw new PermanentFinancialError('source_linkage_mismatch');
      }
      return current;
    }
    const inserted = await rows(transaction, sql`
      insert into financial_scan_runs (
        root_key, kind, phase, classifier_version, allocation_algorithm_version, replay_id
      ) values (
        ${definition.rootKey}, ${definition.kind}, ${definition.phase},
        ${definition.classifierVersion}, ${definition.allocationAlgorithmVersion}, ${definition.replayId}
      ) returning ${RUN_COLUMNS}
    `);
    return canonicalRun(inserted[0]);
  });
}

function cursorDigest(phaseValue: string, checkpointValue: string | null): string {
  return createHash('sha256').update(phaseValue).update('\0').update(checkpointValue ?? '').digest('hex');
}

function activeEntityKey(identity: FinancialJobIdentity): string | null {
  if (identity.type === FINANCIAL_SOURCE_JOB) {
    return `${identity.type}:${JSON.stringify({
      sourceId: identity.payload.sourceId,
      sourceKind: identity.payload.sourceKind
    })}`;
  }
  if (identity.type === FINANCIAL_PAYOUT_JOB &&
    identity.payload.trigger.kind !== 'continuation') {
    return `${identity.type}:${JSON.stringify({
      providerPayoutId: identity.payload.providerPayoutId
    })}`;
  }
  return null;
}

async function enqueueActiveScanChild(
  transaction: Parameters<typeof enqueueActiveEntityJob>[0],
  identity: FinancialJobIdentity
): Promise<boolean> {
  if (identity.type === FINANCIAL_SOURCE_JOB) {
    await enqueueActiveEntityJob(transaction, {
      ...identity,
      activeEntity: {
        sourceKind: identity.payload.sourceKind,
        sourceId: identity.payload.sourceId
      }
    });
    return true;
  }
  if (identity.type === FINANCIAL_PAYOUT_JOB &&
    identity.payload.trigger.kind !== 'continuation') {
    await enqueueActiveEntityJob(transaction, {
      ...identity,
      activeEntity: { providerPayoutId: identity.payload.providerPayoutId }
    });
    return true;
  }
  return false;
}

export async function resumeFinancialScanContinuation(
  database: Database,
  untrustedPayload: Extract<FinancialScanJobPayload, { readonly kind: 'continuation' }>
): Promise<FinancialScanRunRow | null> {
  const payload = parseFinancialScanContinuationJobPayload(untrustedPayload);
  const current = await database.transaction(async (transaction) => {
    await rows(transaction, sql`
      select pg_advisory_xact_lock(hashtextextended(${`pale-orbit:financial:scan-run:${payload.scanRunId}`}, 0))
    `);
    return selectRun(transaction, payload.scanRunId, true);
  });
  if (current === null || current.state !== 'running') return null;
  if (current.phase !== payload.phase ||
    current.cursorDigestSha256 !== payload.cursorDigestSha256 ||
    cursorDigest(current.phase, current.checkpoint) !== payload.cursorDigestSha256) return null;
  return current;
}

function parseSourceCheckpoint(value: string | null): { kind: string; id: string } | null {
  if (value === null) return null;
  const separator = value.indexOf(':');
  if (separator <= 0) invalid();
  const kindValue = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!['payment', 'refund', 'dispute'].includes(kindValue) || !uuid(id)) invalid();
  return { kind: kindValue, id };
}

function boundedPage<Value>(data: readonly Value[], limit: number, key: (value: Value) => string): FinancialScanPage<Value> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
  const hasMore = data.length > limit;
  const selected = hasMore ? data.slice(0, limit) : data;
  return { data: selected, hasMore, checkpoint: hasMore ? key(selected[selected.length - 1]!) : null };
}

export async function loadFinancialSourceScanPage(
  database: Database,
  run: FinancialScanRunRow,
  limit: number
): Promise<FinancialScanPage<FinancialSourceScanCandidate>> {
  const cursor = parseSourceCheckpoint(run.checkpoint);
  const result = await rows(database, sql`
    with sources as (
      select 'payment'::text as kind, id from payments where financial_evidence_status in ('pending', 'exception')
      union all
      select 'refund'::text, id from refunds where financial_evidence_status in ('pending', 'exception')
      union all
      select 'dispute'::text, id from disputes where financial_evidence_status in ('pending', 'exception')
    )
    select kind as "sourceKind", id as "sourceId" from sources
    where not exists (
      select 1 from financial_reconciliation_issues issue
      where issue.resource_type = sources.kind and issue.resource_id = sources.id
        and issue.state = 'open' and issue.impact = 'exception'
    )
      and (${cursor?.kind ?? null}::text is null or (kind, id) > (${cursor?.kind ?? null}, ${cursor?.id ?? null}::uuid))
    order by kind, id limit ${limit + 1}
  `) as FinancialSourceScanCandidate[];
  return boundedPage(result, limit, (source) => `${source.sourceKind}:${source.sourceId}`);
}

export async function loadIncompletePayoutRunPage(
  database: Database,
  run: FinancialScanRunRow,
  limit: number
): Promise<FinancialScanPage<FinancialPayoutScanCandidate>> {
  if (run.checkpoint !== null && !uuid(run.checkpoint)) invalid();
  const result = await rows(database, sql`
    with incomplete as (
      select import.id, payout.provider_id
      from payout_import_runs import join stripe_payouts payout on payout.id = import.payout_id
      where import.state in ('collecting', 'publishable')
      union
      select issue.id,
        case
          when payout.reversed_by_provider_payout_id is not null
            and not exists (
              select 1 from stripe_payouts reversal
              where reversal.provider_id = payout.reversed_by_provider_payout_id
                and reversal.original_provider_payout_id = payout.provider_id
            )
          then payout.reversed_by_provider_payout_id
          else payout.provider_id
        end as provider_id
      from financial_reconciliation_issues issue
      join stripe_payouts payout on payout.id = issue.resource_id
      where issue.resource_type = 'payout'
        and issue.safe_code = 'payout_reversal_incomplete'
        and issue.state = 'open'
    )
    select provider_id as "providerPayoutId", id as "runId" from incomplete
    where (${run.checkpoint}::uuid is null or id > ${run.checkpoint}::uuid)
    order by id limit ${limit + 1}
  `) as Array<FinancialPayoutScanCandidate & { runId: string }>;
  return boundedPage(result, limit, (payout) => payout.runId);
}

function impactPayoutId(run: FinancialScanRunRow): string {
  const match = /^financial:payout-impact:([0-9a-f-]{36}):[1-9]\d*$/u.exec(run.rootKey);
  if (!match || !uuid(match[1])) invalid();
  return match[1];
}

export async function loadPayoutImpactSourcePage(
  database: Database,
  run: FinancialScanRunRow,
  limit: number
): Promise<FinancialScanPage<FinancialSourceScanCandidate>> {
  const payoutId = impactPayoutId(run);
  const cursor = parseSourceCheckpoint(run.checkpoint);
  const result = await rows(database, sql`
    with sources as (
      select distinct 'payment'::text as kind, payment.id
      from stripe_payout_balance_transactions membership
      join stripe_balance_transactions balance on balance.id = membership.balance_transaction_id
      join payments payment on balance.source_family = 'charge'
        and payment.stripe_latest_charge_id = balance.source_id
      where membership.payout_id = ${payoutId}
      union
      select distinct 'refund'::text, refund.id
      from stripe_payout_balance_transactions membership
      join stripe_balance_transactions balance on balance.id = membership.balance_transaction_id
      join refunds refund on balance.source_family = 'refund' and refund.stripe_refund_id = balance.source_id
      where membership.payout_id = ${payoutId}
      union
      select distinct 'dispute'::text, dispute.id
      from stripe_payout_balance_transactions membership
      join stripe_balance_transactions balance on balance.id = membership.balance_transaction_id
      join disputes dispute on balance.source_family = 'dispute' and dispute.stripe_dispute_id = balance.source_id
      where membership.payout_id = ${payoutId}
    )
    select kind as "sourceKind", id as "sourceId" from sources
    where (${cursor?.kind ?? null}::text is null or (kind, id) > (${cursor?.kind ?? null}, ${cursor?.id ?? null}::uuid))
    order by kind, id limit ${limit + 1}
  `) as FinancialSourceScanCandidate[];
  return boundedPage(result, limit, (source) => `${source.sourceKind}:${source.sourceId}`);
}

function parseClassificationCheckpoint(value: string | null): { type: string; id: string } | null {
  if (value === null) return null;
  const separator = value.indexOf(':');
  if (separator <= 0) invalid();
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!['balance_transaction', 'fee_detail'].includes(type) || !uuid(id)) invalid();
  return { type, id };
}

export async function loadClassificationReplayPage(
  database: Database,
  run: FinancialScanRunRow,
  limit: number
): Promise<FinancialScanPage<FinancialClassificationScanCandidate>> {
  const cursor = parseClassificationCheckpoint(run.checkpoint);
  const result = await rows(database, sql`
    with subjects as (
      select 'balance_transaction'::text as type, id, fingerprint_sha256 as fingerprint
      from stripe_balance_transactions
      union all
      select 'fee_detail'::text, id, fingerprint_sha256 from stripe_balance_transaction_fee_details
    )
    select type as "subjectType", id as "subjectId", fingerprint as "sourceFingerprintSha256"
    from subjects
    where (${cursor?.type ?? null}::text is null or (type, id) > (${cursor?.type ?? null}, ${cursor?.id ?? null}::uuid))
    order by type, id limit ${limit + 1}
  `) as FinancialClassificationScanCandidate[];
  return boundedPage(result, limit, (subject) => `${subject.subjectType}:${subject.subjectId}`);
}

function assertCompleteEmptyReplay(
  value: unknown
): asserts value is CompleteEmptyFinancialReplayInput {
  if (!exact(value, [
    'runId', 'expectedCheckpoint', 'expectedPageCount', 'classifierVersion',
    'allocationAlgorithmVersion', 'correlationId'
  ]) || !uuid(value.runId) || !checkpoint(value.expectedCheckpoint) ||
    !count(value.expectedPageCount) || !count(value.classifierVersion) ||
    value.classifierVersion === 0 || !count(value.allocationAlgorithmVersion) ||
    value.allocationAlgorithmVersion === 0 || typeof value.correlationId !== 'string' ||
    value.correlationId.length < 1 || value.correlationId.length > 100) invalid();
}

/**
 * Version activation must be the first database statement in this transaction. This preserves
 * the global replay order: projection version -> scan run -> local financial graph.
 */
export async function completeEmptyFinancialReplay(
  database: Database,
  input: CompleteEmptyFinancialReplayInput
): Promise<FinancialScanRunRow> {
  assertCompleteEmptyReplay(input);
  return database.transaction(async (transaction) => {
    await activateFinancialProjectionVersionLocked(transaction, {
      classifierVersion: input.classifierVersion,
      allocationAlgorithmVersion: input.allocationAlgorithmVersion,
      correlationId: input.correlationId
    });
    await rows(transaction, sql`
      select pg_advisory_xact_lock(hashtextextended(
        ${`pale-orbit:financial:scan-run:${input.runId}`}, 0
      ))
    `);
    const current = await selectRun(transaction, input.runId, true);
    if (!current || current.state !== 'running' || current.kind !== 'classification_replay' ||
      current.phase !== 'classification_replay_page' ||
      current.checkpoint !== input.expectedCheckpoint ||
      current.pageCount !== input.expectedPageCount || current.processedCount !== 0 ||
      current.classifierVersion !== input.classifierVersion ||
      current.allocationAlgorithmVersion !== input.allocationAlgorithmVersion ||
      current.replayId !== `c${input.classifierVersion}-a${input.allocationAlgorithmVersion}`) {
      stateChanged();
    }
    const updated = await rows(transaction, sql`
      update financial_scan_runs set state = 'completed', checkpoint = null,
        cursor_digest_sha256 = null, page_count = page_count + 1,
        safe_outcome = 'completed', completed_at = now(), updated_at = now()
      where id = ${input.runId} returning ${RUN_COLUMNS}
    `);
    return canonicalRun(updated[0]);
  });
}

function assertCommit(value: unknown): asserts value is CommitFinancialScanPageInput {
  if (!exact(value, ['runId', 'expectedPhase', 'expectedCheckpoint', 'expectedPageCount',
    'nextPhase', 'nextCheckpoint', 'processedCount', 'children', 'complete']) ||
    !uuid(value.runId) || !phase(value.expectedPhase) || !checkpoint(value.expectedCheckpoint) ||
    !count(value.expectedPageCount) || !phase(value.nextPhase) || !checkpoint(value.nextCheckpoint) ||
    !count(value.processedCount) || !Array.isArray(value.children) || value.children.length > 100 ||
    typeof value.complete !== 'boolean') invalid();
}

export async function commitFinancialScanPage(
  database: Database,
  input: CommitFinancialScanPageInput
): Promise<FinancialScanRunRow> {
  assertCommit(input);
  const identities = input.children.map((child) => parseFinancialJobIdentity(child));
  const activeIdentities = identities
    .map((identity) => ({ identity, key: activeEntityKey(identity) }))
    .filter((entry): entry is { identity: FinancialJobIdentity; key: string } => entry.key !== null)
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const genericIdentities = identities.filter((identity) => activeEntityKey(identity) === null);
  return database.transaction(async (transaction) => {
    await rows(transaction, sql`
      select pg_advisory_xact_lock(hashtextextended(${`pale-orbit:financial:scan-run:${input.runId}`}, 0))
    `);
    const current = await selectRun(transaction, input.runId, true);
    if (!current || current.state !== 'running' || current.phase !== input.expectedPhase ||
      current.checkpoint !== input.expectedCheckpoint || current.pageCount !== input.expectedPageCount) {
      stateChanged();
    }
    if (current.processedCount + input.processedCount > 2_147_483_647 ||
      current.enqueuedCount + identities.length > 2_147_483_647 ||
      current.pageCount === 2_147_483_647) invalid();
    const finishesPayoutDiscovery = current.phase === 'payout_discovery_page' &&
      input.nextPhase !== 'payout_discovery_page';
    if (finishesPayoutDiscovery) {
      const lower = current.payoutDiscoveryCreatedGte;
      const upper = current.payoutDiscoveryCreatedLt;
      if (!instant(lower) || !instant(upper) || lower.getTime() >= upper.getTime()) invalid();
      const coverageRows = await rows(transaction, sql`
        select covered_through as "coveredThrough"
        from financial_payout_discovery_state where singleton = true for update
      `) as Array<{ coveredThrough: Date | string | null }>;
      if (coverageRows.length !== 1) invalid();
      const coveredThrough = coverageRows[0]!.coveredThrough === null
        ? null
        : new Date(coverageRows[0]!.coveredThrough);
      if (coveredThrough !== null &&
        (!instant(coveredThrough) || lower.getTime() > coveredThrough.getTime())) stateChanged();
      await rows(transaction, sql`
        update financial_payout_discovery_state set
          covered_through = case
            when covered_through is null or covered_through < ${upper} then ${upper}
            else covered_through
          end,
          updated_at = now()
        where singleton = true
        returning covered_through as "coveredThrough"
      `);
    }
    for (const { identity } of activeIdentities) {
      await enqueueActiveScanChild(transaction, identity);
    }
    for (const identity of genericIdentities) {
      await enqueueJob(transaction, {
        type: identity.type,
        payload: identity.payload as JsonObject,
        deduplicationKey: identity.deduplicationKey,
        maxAttempts: identity.maxAttempts
      });
    }
    const digest = input.complete ? null : cursorDigest(input.nextPhase, input.nextCheckpoint);
    if (!input.complete) {
      const continuation = createFinancialScanContinuationJob({
        scanRunId: input.runId,
        phase: input.nextPhase,
        cursorDigestSha256: digest!,
        limit: 100
      });
      await enqueueJob(transaction, {
        type: continuation.type,
        payload: continuation.payload,
        deduplicationKey: continuation.deduplicationKey,
        maxAttempts: continuation.maxAttempts
      });
    }
    const updated = await rows(transaction, sql`
      update financial_scan_runs set
        phase = ${input.nextPhase}, state = ${input.complete ? 'completed' : 'running'},
        checkpoint = ${input.complete ? null : input.nextCheckpoint},
        cursor_digest_sha256 = ${digest},
        processed_count = processed_count + ${input.processedCount},
        enqueued_count = enqueued_count + ${identities.length},
        page_count = page_count + 1,
        safe_outcome = ${input.complete ? 'completed' : null},
        completed_at = ${input.complete ? new Date() : null}, updated_at = now()
      where id = ${input.runId} returning ${RUN_COLUMNS}
    `);
    return canonicalRun(updated[0]);
  });
}
