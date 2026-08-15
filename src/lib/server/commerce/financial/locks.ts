import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { sql, type SQL } from 'drizzle-orm';
import { PermanentFinancialError, RetryableFinancialError } from './errors';
import type { FinancialIssueCode } from './types';

export interface FinancialIssueLockKey {
  readonly resourceType: 'payment' | 'refund' | 'dispute' | 'payout' | 'payout_import_run' | 'balance_transaction' | 'fee_detail' | 'allocation_set' | 'correction_set' | 'financial_classification' | 'financial_scan_run';
  readonly resourceId: string;
  readonly safeCode: FinancialIssueCode;
}

export interface FinancialProjectionLockInput {
  readonly payoutGenerations: readonly { readonly payoutId: string; readonly expectedGeneration: number }[];
  readonly balanceTransactionIds: readonly string[];
  readonly classifierVersion: number;
  readonly issueKeys: readonly FinancialIssueLockKey[];
}

export interface FinancialProjectionLockRows {
  readonly payouts: readonly { readonly id: string; readonly financialGeneration: number }[];
  readonly balanceTransactions: readonly { readonly id: string; readonly fingerprintSha256: string }[];
  readonly memberships: readonly { readonly payoutId: string; readonly balanceTransactionId: string }[];
  readonly classifications: readonly { readonly id: string; readonly subjectType: 'balance_transaction' | 'fee_detail'; readonly subjectId: string; readonly classifierVersion: number; readonly sourceFingerprintSha256: string; readonly classification: string }[];
  readonly feeDetailIds: readonly string[];
  readonly allocationSetIds: readonly string[];
  readonly issueIds: readonly string[];
}

export interface PayoutImportLockInput {
  readonly payoutId: string;
  readonly runId: string;
  readonly expectedGeneration: number;
}

export interface PayoutImportLockRows {
  readonly payoutId: string;
  readonly runId: string;
  readonly disposition: 'fresh' | 'stale' | 'published_replay';
  readonly payoutFinancialGeneration: number;
  readonly runGeneration: number;
  readonly runState: 'collecting' | 'publishable' | 'published' | 'abandoned' | 'exception';
  readonly balanceTransactionIds: readonly string[];
  readonly existingMembershipIds: readonly string[];
  readonly hasPublishedHistory: boolean;
  readonly issueIds: readonly string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const FINANCIAL_ISSUE_CODES = (Object.keys({
  allocation_fork: true,
  allocation_incomplete: true,
  allocation_mismatch: true,
  classification_fork: true,
  correction_rebase_required: true,
  currency_mismatch: true,
  generation_exhausted: true,
  immutable_mismatch: true,
  missing_source: true,
  payout_incomplete: true,
  payout_membership_conflict: true,
  payout_reversal_incomplete: true,
  source_linkage_mismatch: true,
  unsupported_category: true
} satisfies Record<FinancialIssueCode, true>) as FinancialIssueCode[]).sort();
const SAFE_CODES = new Set<FinancialIssueCode>(FINANCIAL_ISSUE_CODES);
const RESOURCE_TYPES = new Set<FinancialIssueLockKey['resourceType']>([
  'payment', 'refund', 'dispute', 'payout', 'payout_import_run', 'balance_transaction',
  'fee_detail', 'allocation_set', 'correction_set', 'financial_classification',
  'financial_scan_run'
]);

type SqlResult = { rows?: unknown[] };

function invalid(): never {
  throw new PermanentFinancialError('unsupported_provider_evidence');
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' &&
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function positiveInt32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647;
}

function nonnegativeInt32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
}

function sortedUuids(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertProjectionInput(value: unknown): asserts value is FinancialProjectionLockInput {
  if (!exact(value, ['payoutGenerations', 'balanceTransactionIds', 'classifierVersion', 'issueKeys']) ||
    !Array.isArray(value.payoutGenerations) || !Array.isArray(value.balanceTransactionIds) ||
    !Array.isArray(value.issueKeys) || !positiveInt32(value.classifierVersion)) invalid();
  for (const generation of value.payoutGenerations) {
    if (!exact(generation, ['payoutId', 'expectedGeneration']) || !uuid(generation.payoutId) || !nonnegativeInt32(generation.expectedGeneration)) invalid();
  }
  const generations = new Map<string, number>();
  for (const generation of value.payoutGenerations) {
    const prior = generations.get(generation.payoutId);
    if (prior !== undefined && prior !== generation.expectedGeneration) invalid();
    generations.set(generation.payoutId, generation.expectedGeneration);
  }
  if (value.balanceTransactionIds.some((id) => !uuid(id))) invalid();
  for (const key of value.issueKeys) {
    if (!exact(key, ['resourceType', 'resourceId', 'safeCode']) || !RESOURCE_TYPES.has(key.resourceType as FinancialIssueLockKey['resourceType']) ||
      !uuid(key.resourceId) || typeof key.safeCode !== 'string' || !SAFE_CODES.has(key.safeCode as FinancialIssueCode)) invalid();
  }
}

function assertPayoutInput(value: unknown): asserts value is PayoutImportLockInput {
  if (!exact(value, ['payoutId', 'runId', 'expectedGeneration']) || !uuid(value.payoutId) || !uuid(value.runId) || !nonnegativeInt32(value.expectedGeneration)) invalid();
}

async function rows(tx: DatabaseTransaction, query: SQL): Promise<unknown[]> {
  return ((await tx.execute(query)) as SqlResult).rows ?? [];
}

/**
 * Linearizes an ordinary provider projection against replay activation. Callers must take this
 * before purchase, payout, balance-transaction, or issue locks so a retained worker either
 * finishes wholly under its active implementation or retries without publishing stale state.
 */
export async function lockActiveFinancialProjectionImplementation(
  tx: DatabaseTransaction,
  input: {
    readonly classifierVersion: number;
    readonly allocationAlgorithmVersion: number;
  }
): Promise<void> {
  if (!positiveInt32(input.classifierVersion) ||
    !positiveInt32(input.allocationAlgorithmVersion)) invalid();
  const authorityRows = await rows(tx, sql`
    select classifier_version as "classifierVersion",
      allocation_algorithm_version as "allocationAlgorithmVersion",
      pending_classifier_version as "pendingClassifierVersion",
      pending_allocation_algorithm_version as "pendingAllocationAlgorithmVersion",
      pending_replay_id as "pendingReplayId",
      pending_scan_run_id as "pendingScanRunId"
    from financial_projection_versions
    where singleton = true
    for update
  `) as Array<{
    classifierVersion: number;
    allocationAlgorithmVersion: number;
    pendingClassifierVersion: number | null;
    pendingAllocationAlgorithmVersion: number | null;
    pendingReplayId: string | null;
    pendingScanRunId: string | null;
  }>;
  const authority = authorityRows[0];
  if (!authority || authorityRows.length !== 1 ||
    !positiveInt32(authority.classifierVersion) ||
    !positiveInt32(authority.allocationAlgorithmVersion)) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
  if (authority.classifierVersion !== input.classifierVersion ||
    authority.allocationAlgorithmVersion !== input.allocationAlgorithmVersion ||
    authority.pendingClassifierVersion !== null ||
    authority.pendingAllocationAlgorithmVersion !== null ||
    authority.pendingReplayId !== null || authority.pendingScanRunId !== null) {
    throw new RetryableFinancialError('state_changed');
  }
}

async function advisory(tx: DatabaseTransaction, key: string): Promise<void> {
  await rows(tx, sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function issueAdvisory(tx: DatabaseTransaction, key: string): Promise<void> {
  await rows(tx, sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

function stateChanged(): never {
  throw new RetryableFinancialError('state_changed');
}

function uuidIn(values: readonly string[]) {
  return sql.join(values.map((id) => sql`${id}::uuid`), sql`, `);
}

export async function lockFinancialProjectionRows(
  tx: DatabaseTransaction,
  input: FinancialProjectionLockInput
): Promise<FinancialProjectionLockRows> {
  assertProjectionInput(input);
  const payouts = [...new Map(input.payoutGenerations.map((value) => [value.payoutId, value])).values()]
    .sort((left, right) => compareAscii(left.payoutId, right.payoutId));
  const balanceTransactionIds = sortedUuids(input.balanceTransactionIds);
  const issueKeys = [...new Map(input.issueKeys.map((key) => [`${key.resourceType}:${key.resourceId}:${key.safeCode}`, key])).values()]
    .sort((left, right) => compareAscii(
      `${left.resourceType}:${left.resourceId}:${left.safeCode}`,
      `${right.resourceType}:${right.resourceId}:${right.safeCode}`
    ));
  for (const payout of payouts) await advisory(tx, `pale-orbit:financial:payout:${payout.payoutId}`);
  const payoutRows = (payouts.length === 0
    ? await rows(tx, sql`select id, financial_generation as "financialGeneration" from stripe_payouts where false for update`)
    : await rows(tx, sql`
        select id, financial_generation as "financialGeneration" from stripe_payouts
        where id in (${sql.join(payouts.map((value) => sql`${value.payoutId}::uuid`), sql`, `)}) order by id for update
      `)) as FinancialProjectionLockRows['payouts'];
  if (payoutRows.length !== payouts.length || payouts.some((expected) =>
    !payoutRows.some((actual) => actual.id === expected.payoutId && actual.financialGeneration === expected.expectedGeneration)
  )) stateChanged();
  for (const id of balanceTransactionIds) await advisory(tx, `pale-orbit:financial:balance-transaction:${id}`);
  const balanceRows = (balanceTransactionIds.length === 0
    ? await rows(tx, sql`select id, fingerprint_sha256 as "fingerprintSha256" from stripe_balance_transactions where false for update`)
    : await rows(tx, sql`
        select id, fingerprint_sha256 as "fingerprintSha256" from stripe_balance_transactions
        where id in (${uuidIn(balanceTransactionIds)}) order by id for update
      `)) as FinancialProjectionLockRows['balanceTransactions'];
  if (balanceRows.length !== balanceTransactionIds.length) stateChanged();
  const membershipRows = (payouts.length === 0 && balanceTransactionIds.length === 0
    ? await rows(tx, sql`select payout_id as "payoutId", balance_transaction_id as "balanceTransactionId" from stripe_payout_balance_transactions where false for update`)
    : payouts.length === 0
    ? await rows(tx, sql`
        select payout_id as "payoutId", balance_transaction_id as "balanceTransactionId"
        from stripe_payout_balance_transactions where balance_transaction_id in (${uuidIn(balanceTransactionIds)})
        order by payout_id, balance_transaction_id for update
      `)
    : balanceTransactionIds.length === 0
      ? await rows(tx, sql`
          select payout_id as "payoutId", balance_transaction_id as "balanceTransactionId"
          from stripe_payout_balance_transactions where payout_id in (${uuidIn(payouts.map((value) => value.payoutId))})
          order by payout_id, balance_transaction_id for update
        `)
      : await rows(tx, sql`
        select payout_id as "payoutId", balance_transaction_id as "balanceTransactionId"
        from stripe_payout_balance_transactions
        where payout_id in (${uuidIn(payouts.map((value) => value.payoutId))})
           or balance_transaction_id in (${uuidIn(balanceTransactionIds)})
        order by payout_id, balance_transaction_id for update
      `)) as FinancialProjectionLockRows['memberships'];
  const requestedPayoutIds = new Set(payouts.map((payout) => payout.payoutId));
  const requestedBalanceTransactionIds = new Set(balanceTransactionIds);
  if (membershipRows.some((membership) =>
    !requestedPayoutIds.has(membership.payoutId) ||
    !requestedBalanceTransactionIds.has(membership.balanceTransactionId)
  )) stateChanged();
  const feeDetails = (balanceTransactionIds.length === 0
    ? await rows(tx, sql`select id, balance_transaction_id as "balanceTransactionId" from stripe_balance_transaction_fee_details where false for update`)
    : await rows(tx, sql`
        select id, balance_transaction_id as "balanceTransactionId" from stripe_balance_transaction_fee_details
        where balance_transaction_id in (${uuidIn(balanceTransactionIds)}) order by balance_transaction_id, ordinal for update
      `)) as Array<{ id: string; balanceTransactionId: string }>;
  const feeDetailIds = feeDetails.map((row) => row.id);
  for (const id of balanceTransactionIds) await advisory(tx, `pale-orbit:financial:classification:balance_transaction:${id}`);
  for (const id of feeDetailIds) await advisory(tx, `pale-orbit:financial:classification:fee_detail:${id}`);
  const classificationRows = ((balanceTransactionIds.length === 0 && feeDetailIds.length === 0)
    ? await rows(tx, sql`select id, subject_type as "subjectType", subject_id as "subjectId", classifier_version as "classifierVersion", source_fingerprint_sha256 as "sourceFingerprintSha256", classification from financial_classification_versions where false for update`)
    : await rows(tx, sql`
        select id, subject_type as "subjectType", subject_id as "subjectId", classifier_version as "classifierVersion",
          source_fingerprint_sha256 as "sourceFingerprintSha256", classification
        from financial_classification_versions
        where (${balanceTransactionIds.length === 0 ? sql`false` : sql`(subject_type = 'balance_transaction' and subject_id in (${uuidIn(balanceTransactionIds)}))`}
          ${feeDetailIds.length === 0 ? sql`` : sql` or (subject_type = 'fee_detail' and subject_id in (${uuidIn(feeDetailIds)}))`})
          and classifier_version = ${input.classifierVersion}
        order by subject_type, subject_id, classifier_version for update
      `)) as FinancialProjectionLockRows['classifications'];
  for (const id of balanceTransactionIds) {
    await advisory(tx, `pale-orbit:financial:allocation:${id}:gross_amount`);
    await advisory(tx, `pale-orbit:financial:allocation:${id}:fee`);
  }
  const allocationRows = (balanceTransactionIds.length === 0
    ? await rows(tx, sql`select id from financial_allocation_sets where false for update`)
    : await rows(tx, sql`
        select id from financial_allocation_sets where balance_transaction_id in (${uuidIn(balanceTransactionIds)})
        order by balance_transaction_id, id for update
      `)) as Array<{ id: string }>;
  const allocationSetIds = allocationRows.map((row) => row.id);
  if (allocationSetIds.length === 0) {
    await rows(tx, sql`select id from financial_item_allocations where false for update`);
  } else {
    await rows(tx, sql`
      select id from financial_item_allocations where allocation_set_id in (${uuidIn(allocationSetIds)})
      order by allocation_set_id, id for update
    `);
  }
  for (const key of issueKeys) await issueAdvisory(tx, `pale-orbit:financial:issue:${key.resourceType}:${key.resourceId}:${key.safeCode}`);
  const issues = (issueKeys.length === 0
    ? await rows(tx, sql`select id from financial_reconciliation_issues where false for update`)
    : await rows(tx, sql`
        select id from financial_reconciliation_issues
        where (resource_type, resource_id, safe_code) in (${sql.join(issueKeys.map((key) => sql`(${key.resourceType}, ${key.resourceId}::uuid, ${key.safeCode})`), sql`, `)})
        order by resource_type, resource_id, safe_code for update
      `)) as Array<{ id: string }>;
  return { payouts: payoutRows, balanceTransactions: balanceRows, memberships: membershipRows, classifications: classificationRows, feeDetailIds, allocationSetIds, issueIds: issues.map((row) => row.id) };
}

export async function lockPayoutImportRows(
  tx: DatabaseTransaction,
  input: PayoutImportLockInput
): Promise<PayoutImportLockRows> {
  assertPayoutInput(input);
  await advisory(tx, `pale-orbit:financial:payout:${input.payoutId}`);
  const payouts = await rows(tx, sql`
    select id, financial_generation as "financialGeneration" from stripe_payouts
    where id = ${input.payoutId} for update
  `) as Array<{ id: string; financialGeneration: number }>;
  if (payouts.length !== 1) stateChanged();
  await advisory(tx, `pale-orbit:financial:payout-run:${input.runId}`);
  const runs = await rows(tx, sql`
    select id, generation, state from payout_import_runs
    where id = ${input.runId} and payout_id = ${input.payoutId} for update
  `) as Array<{ id: string; generation: number; state: string }>;
  if (runs.length !== 1) stateChanged();
  const payoutFinancialGeneration = payouts[0]!.financialGeneration;
  const runGeneration = runs[0]!.generation;
  const runState = runs[0]!.state;
  if (!nonnegativeInt32(payoutFinancialGeneration) || !nonnegativeInt32(runGeneration) ||
    !['collecting', 'publishable', 'published', 'abandoned', 'exception'].includes(runState)) {
    stateChanged();
  }
  const canonicalRunState = runState as PayoutImportLockRows['runState'];
  const disposition: PayoutImportLockRows['disposition'] =
    canonicalRunState === 'published' && runGeneration === input.expectedGeneration &&
      (payoutFinancialGeneration === runGeneration + 1 ||
        payoutFinancialGeneration === runGeneration)
      ? 'published_replay'
      : (canonicalRunState === 'collecting' || canonicalRunState === 'publishable') &&
          runGeneration === input.expectedGeneration &&
          payoutFinancialGeneration === input.expectedGeneration
        ? 'fresh'
        : 'stale';
  if (disposition !== 'fresh') {
    return {
      payoutId: input.payoutId,
      runId: input.runId,
      disposition,
      payoutFinancialGeneration,
      runGeneration,
      runState: canonicalRunState,
      balanceTransactionIds: [],
      existingMembershipIds: [],
      hasPublishedHistory: false,
      issueIds: []
    };
  }
  const entries = await rows(tx, sql`
    select entry.balance_transaction_id as "balanceTransactionId"
    from payout_import_run_entries entry where entry.run_id = ${input.runId}
    order by entry.balance_transaction_id for update
  `) as Array<{ balanceTransactionId: string }>;
  const balanceTransactionIds = sortedUuids(entries.map((entry) => entry.balanceTransactionId));
  for (const id of balanceTransactionIds) await advisory(tx, `pale-orbit:financial:balance-transaction:${id}`);
  const balanceRows = balanceTransactionIds.length === 0 ? [] : await rows(tx, sql`
    select id from stripe_balance_transactions where id in (${uuidIn(balanceTransactionIds)}) order by id for update
  `) as Array<{ id: string }>;
  if (balanceRows.length !== balanceTransactionIds.length) stateChanged();
  let membershipRows: Array<{ payoutId: string; balanceTransactionId: string }>;
  if (balanceTransactionIds.length === 0) {
    membershipRows = await rows(tx, sql`
      select payout_id as "payoutId", balance_transaction_id as "balanceTransactionId"
      from stripe_payout_balance_transactions where payout_id = ${input.payoutId}
      order by payout_id, balance_transaction_id for update
    `) as Array<{ payoutId: string; balanceTransactionId: string }>;
  } else {
    membershipRows = await rows(tx, sql`
      select payout_id as "payoutId", balance_transaction_id as "balanceTransactionId"
      from stripe_payout_balance_transactions where payout_id = ${input.payoutId}
        or balance_transaction_id in (${uuidIn(balanceTransactionIds)})
      order by payout_id, balance_transaction_id for update
    `) as Array<{ payoutId: string; balanceTransactionId: string }>;
  }
  const existingMembershipIds = sortedUuids(membershipRows
    .filter((row) => row.payoutId === input.payoutId)
    .map((row) => row.balanceTransactionId));
  const publishedHistoryRows = await rows(tx, sql`
    select exists (
      select 1 from payout_import_runs
      where payout_id = ${input.payoutId} and state = 'published' and id <> ${input.runId}
    ) as "exists"
  `) as Array<{ exists: boolean }>;
  if (typeof publishedHistoryRows[0]?.exists !== 'boolean') stateChanged();
  for (const safeCode of FINANCIAL_ISSUE_CODES) await issueAdvisory(tx, `pale-orbit:financial:issue:payout:${input.payoutId}:${safeCode}`);
  const issues = await rows(tx, sql`
    select id from financial_reconciliation_issues
    where resource_type = 'payout' and resource_id = ${input.payoutId}::uuid
    order by resource_type, resource_id, safe_code for update
  `) as Array<{ id: string }>;
  return {
    payoutId: input.payoutId,
    runId: input.runId,
    disposition,
    payoutFinancialGeneration,
    runGeneration,
    runState: canonicalRunState,
    balanceTransactionIds,
    existingMembershipIds,
    hasPublishedHistory: publishedHistoryRows[0]!.exists,
    issueIds: issues.map((row) => row.id)
  };
}
