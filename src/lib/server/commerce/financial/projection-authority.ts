import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { sql, type SQL } from 'drizzle-orm';
import { PermanentFinancialError } from './errors';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type QueryResult = { rows?: unknown[] };

async function rows(transaction: DatabaseTransaction, query: SQL): Promise<unknown[]> {
  return ((await transaction.execute(query)) as QueryResult).rows ?? [];
}

function invalid(): never {
  throw new PermanentFinancialError('source_linkage_mismatch');
}

export interface FinancialProjectionAuthority {
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
  readonly pendingClassifierVersion: number | null;
  readonly pendingAllocationAlgorithmVersion: number | null;
  readonly pendingReplayId: string | null;
  readonly pendingScanRunId: string | null;
}

function positiveInt32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 &&
    (value as number) <= 2_147_483_647;
}

function canonicalFinancialProjectionAuthority(
  authorityRows: Array<Record<string, unknown>>
): FinancialProjectionAuthority {
  const raw = authorityRows[0];
  if (!raw || authorityRows.length !== 1 || !positiveInt32(raw.classifierVersion) ||
    !positiveInt32(raw.allocationAlgorithmVersion)) invalid();
  const pendingClassifierVersion = raw.pendingClassifierVersion ?? null;
  const pendingAllocationAlgorithmVersion = raw.pendingAllocationAlgorithmVersion ?? null;
  const pendingReplayId = raw.pendingReplayId ?? null;
  const pendingScanRunId = raw.pendingScanRunId ?? null;
  const pendingValues = [pendingClassifierVersion, pendingAllocationAlgorithmVersion,
    pendingReplayId, pendingScanRunId];
  const hasPending = pendingValues.every((value) => value !== null);
  if (!hasPending && pendingValues.some((value) => value !== null)) invalid();
  if (hasPending && (!positiveInt32(pendingClassifierVersion) ||
    !positiveInt32(pendingAllocationAlgorithmVersion) ||
    typeof pendingReplayId !== 'string' ||
    pendingReplayId !== `c${pendingClassifierVersion}-a${pendingAllocationAlgorithmVersion}` ||
    typeof pendingScanRunId !== 'string' || !UUID_PATTERN.test(pendingScanRunId) ||
    pendingClassifierVersion < raw.classifierVersion ||
    pendingAllocationAlgorithmVersion < raw.allocationAlgorithmVersion ||
    (pendingClassifierVersion === raw.classifierVersion &&
      pendingAllocationAlgorithmVersion === raw.allocationAlgorithmVersion))) invalid();
  return {
    classifierVersion: raw.classifierVersion,
    allocationAlgorithmVersion: raw.allocationAlgorithmVersion,
    pendingClassifierVersion: hasPending ? pendingClassifierVersion as number : null,
    pendingAllocationAlgorithmVersion:
      hasPending ? pendingAllocationAlgorithmVersion as number : null,
    pendingReplayId: hasPending ? pendingReplayId as string : null,
    pendingScanRunId: hasPending ? pendingScanRunId as string : null
  };
}

export async function loadFinancialProjectionAuthority(
  transaction: DatabaseTransaction
): Promise<FinancialProjectionAuthority> {
  return canonicalFinancialProjectionAuthority(await rows(transaction, sql`
    select classifier_version as "classifierVersion",
      allocation_algorithm_version as "allocationAlgorithmVersion",
      pending_classifier_version as "pendingClassifierVersion",
      pending_allocation_algorithm_version as "pendingAllocationAlgorithmVersion",
      pending_replay_id as "pendingReplayId",
      pending_scan_run_id as "pendingScanRunId"
    from financial_projection_versions
    where singleton = true
  `) as Array<Record<string, unknown>>);
}

export async function lockFinancialProjectionAuthority(
  transaction: DatabaseTransaction
): Promise<FinancialProjectionAuthority> {
  return canonicalFinancialProjectionAuthority(await rows(transaction, sql`
    select classifier_version as "classifierVersion",
      allocation_algorithm_version as "allocationAlgorithmVersion",
      pending_classifier_version as "pendingClassifierVersion",
      pending_allocation_algorithm_version as "pendingAllocationAlgorithmVersion",
      pending_replay_id as "pendingReplayId",
      pending_scan_run_id as "pendingScanRunId"
    from financial_projection_versions
    where singleton = true
    for update
  `) as Array<Record<string, unknown>>);
}

/**
 * Serializes every operation that can publish or enroll projection graph evidence. Callers that
 * lock the version authority must do so before this fence; commerce graph publishers take only
 * this fence and read the authority without a row lock.
 */
export async function lockFinancialProjectionEnrollment(
  transaction: DatabaseTransaction
): Promise<void> {
  await rows(transaction, sql`
    select pg_advisory_xact_lock(hashtextextended(
      ${'pale-orbit:financial:replay-enrollment'}, 0
    ))
  `);
}
