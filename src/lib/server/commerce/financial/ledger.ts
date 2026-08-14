import { createHash } from 'node:crypto';
import type { BalanceTransactionFeeDetailSnapshot, BalanceTransactionSnapshot } from '$lib/server/commerce/stripe/financial-types';
import { parseBalanceTransactionSnapshot } from '$lib/server/commerce/stripe/financial-schemas';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { PermanentFinancialError } from './errors';
import { sql, type SQL } from 'drizzle-orm';
import { appendClassificationDecisionLocked, classifyBalanceTransaction, classifyFeeDetail } from './classification';
import { observeFinancialIssue } from './issues';
import { FINANCIAL_CLASSIFIER_VERSION } from './constants';
import { enqueueJob } from '$lib/server/jobs/repository';
import { createFinancialClassificationSubjectJob } from './jobs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_MONEY_MAX = 99_999_999;
const MAX_FEE_ORDINAL = 2_147_483_647;

interface FeeDetailFingerprintInput {
  readonly balanceTransactionFingerprint: string;
  readonly ordinal: number;
  readonly rawType: string;
  readonly amountMinor: number;
  readonly currency: string;
}

function unsupportedEvidence(): never {
  throw new PermanentFinancialError('unsupported_provider_evidence');
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function normalizeExactDecimal(value: string | null): string | null {
  if (value === null) return null;
  const [integer, fraction = ''] = value.split('.');
  if (integer === undefined) unsupportedEvidence();
  const normalizedFraction = fraction.replace(/0+$/u, '');
  return normalizedFraction.length === 0 ? integer : `${integer}.${normalizedFraction}`;
}

function canonicalSnapshot(snapshot: BalanceTransactionSnapshot): BalanceTransactionSnapshot {
  let parsed: BalanceTransactionSnapshot;
  try {
    parsed = parseBalanceTransactionSnapshot(snapshot, snapshot.livemode);
  } catch {
    unsupportedEvidence();
  }

  const details = [...parsed.feeDetails].sort((left, right) => left.ordinal - right.ordinal);
  let feeDetailTotal = 0n;
  for (const [index, detail] of details.entries()) {
    if (detail.ordinal !== index || detail.currency !== parsed.currency) unsupportedEvidence();
    feeDetailTotal += BigInt(detail.amountMinor);
  }
  if (feeDetailTotal !== BigInt(parsed.feeMinor)) unsupportedEvidence();

  return {
    ...parsed,
    exchangeRate: normalizeExactDecimal(parsed.exchangeRate),
    feeDetails: details
  };
}

export function fingerprintBalanceTransaction(snapshot: BalanceTransactionSnapshot): string {
  const canonical = canonicalSnapshot(snapshot);
  return sha256([
    'plan6b-bt-v1',
    canonical.id,
    canonical.livemode,
    canonical.sourceFamily,
    canonical.sourceId,
    canonical.rawType,
    canonical.reportingCategory,
    canonical.balanceType,
    canonical.amountMinor,
    canonical.feeMinor,
    canonical.netMinor,
    canonical.currency,
    canonical.createdAt.toISOString(),
    canonical.availableAt.toISOString(),
    canonical.exchangeRate,
    canonical.exchangeSourceCurrency,
    canonical.exchangeTargetCurrency,
    canonical.feeDetails.map((detail) => [
      detail.ordinal,
      detail.rawType,
      detail.amountMinor,
      detail.currency
    ])
  ]);
}

export function fingerprintBalanceTransactionFeeDetail(input: FeeDetailFingerprintInput): string;
export function fingerprintBalanceTransactionFeeDetail(
  parentFingerprint: string,
  detail: BalanceTransactionFeeDetailSnapshot
): string;
export function fingerprintBalanceTransactionFeeDetail(
  parentFingerprintOrInput: string | FeeDetailFingerprintInput,
  positionalDetail?: BalanceTransactionFeeDetailSnapshot
): string {
  let input: FeeDetailFingerprintInput;
  if (typeof parentFingerprintOrInput === 'string') {
    if (!hasExactKeys(positionalDetail, ['ordinal', 'rawType', 'amountMinor', 'currency'])) unsupportedEvidence();
    input = {
      balanceTransactionFingerprint: parentFingerprintOrInput,
      ordinal: positionalDetail.ordinal as number,
      rawType: positionalDetail.rawType as string,
      amountMinor: positionalDetail.amountMinor as number,
      currency: positionalDetail.currency as string
    };
  } else {
    if (positionalDetail !== undefined || !hasExactKeys(parentFingerprintOrInput, [
      'balanceTransactionFingerprint', 'ordinal', 'rawType', 'amountMinor', 'currency'
    ])) unsupportedEvidence();
    input = parentFingerprintOrInput;
  }
  const { balanceTransactionFingerprint, ordinal, rawType, amountMinor, currency } = input;
  if (
    !SHA256_PATTERN.test(balanceTransactionFingerprint) ||
    !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > MAX_FEE_ORDINAL ||
    typeof rawType !== 'string' || rawType.length < 1 || rawType.length > 100 ||
    !Number.isSafeInteger(amountMinor) || amountMinor < 0 || amountMinor > SAFE_MONEY_MAX ||
    typeof currency !== 'string' || !/^[A-Z]{3}$/u.test(currency)
  ) unsupportedEvidence();

  return sha256([
    'plan6b-fee-detail-v1',
    balanceTransactionFingerprint, ordinal, rawType, amountMinor, currency
  ]);
}

interface CanonicalEvidence {
  readonly snapshot: BalanceTransactionSnapshot;
  readonly fingerprint: string;
  readonly detailFingerprints: readonly string[];
  readonly parentDecision: ReturnType<typeof classifyBalanceTransaction>;
  readonly detailDecisions: readonly ReturnType<typeof classifyFeeDetail>[];
}

type SqlResult = { rows?: unknown[] };

interface StoredParent {
  readonly id: string;
  readonly providerId: string;
  readonly liveMode: boolean;
  readonly sourceFamily: string | null;
  readonly sourceId: string | null;
  readonly rawType: string;
  readonly reportingCategory: string;
  readonly balanceType: string;
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly netMinor: number;
  readonly currency: string;
  readonly status: 'pending' | 'available';
  readonly providerCreatedAt: Date | string;
  readonly availableAt: Date | string;
  readonly exchangeRate: string | null;
  readonly exchangeSourceCurrency: string | null;
  readonly exchangeTargetCurrency: string | null;
  readonly fingerprintSha256: string;
}

interface StoredDetail {
  readonly id?: string;
  readonly ordinal: number;
  readonly rawType: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly fingerprintSha256: string;
}

async function rows(tx: DatabaseTransaction, query: SQL): Promise<unknown[]> {
  return ((await tx.execute(query)) as SqlResult).rows ?? [];
}

function canonicalEvidence(untrusted: BalanceTransactionSnapshot): CanonicalEvidence {
  const snapshot = canonicalSnapshot(untrusted);
  const fingerprint = fingerprintBalanceTransaction(snapshot);
  const detailFingerprints = snapshot.feeDetails.map((detail) =>
    fingerprintBalanceTransactionFeeDetail({ balanceTransactionFingerprint: fingerprint, ...detail })
  );
  const parentDecision = classifyBalanceTransaction({
    sourceFamily: snapshot.sourceFamily,
    rawType: snapshot.rawType,
    reportingCategory: snapshot.reportingCategory,
    amountMinor: snapshot.amountMinor
  });
  const detailDecisions = snapshot.feeDetails.map((detail) => classifyFeeDetail({
    parentClassification: parentDecision.classification,
    rawType: detail.rawType,
    amountMinor: detail.amountMinor
  }));
  return { snapshot, fingerprint, detailFingerprints, parentDecision, detailDecisions };
}

function sameDate(left: Date | string, right: Date): boolean {
  return new Date(left).getTime() === right.getTime();
}

function sameEvidence(parent: StoredParent, evidence: CanonicalEvidence): boolean {
  const snapshot = evidence.snapshot;
  return parent.fingerprintSha256 === evidence.fingerprint &&
    parent.providerId === snapshot.id && parent.liveMode === snapshot.livemode &&
    parent.sourceFamily === snapshot.sourceFamily && parent.sourceId === snapshot.sourceId &&
    parent.rawType === snapshot.rawType && parent.reportingCategory === snapshot.reportingCategory &&
    parent.balanceType === snapshot.balanceType && parent.amountMinor === snapshot.amountMinor &&
    parent.feeMinor === snapshot.feeMinor && parent.netMinor === snapshot.netMinor &&
    parent.currency === snapshot.currency && sameDate(parent.providerCreatedAt, snapshot.createdAt) &&
    sameDate(parent.availableAt, snapshot.availableAt) &&
    normalizeExactDecimal(parent.exchangeRate) === snapshot.exchangeRate &&
    parent.exchangeSourceCurrency === snapshot.exchangeSourceCurrency &&
    parent.exchangeTargetCurrency === snapshot.exchangeTargetCurrency;
}

function sameDetails(stored: readonly StoredDetail[], evidence: CanonicalEvidence): boolean {
  return stored.length === evidence.snapshot.feeDetails.length && stored.every((detail, index) => {
    const current = evidence.snapshot.feeDetails[index]!;
    return detail.ordinal === current.ordinal && detail.rawType === current.rawType &&
      detail.amountMinor === current.amountMinor && detail.currency === current.currency &&
      detail.fingerprintSha256 === evidence.detailFingerprints[index];
  });
}

function parentRow(value: unknown): { id: string } {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
    throw new Error('Balance transaction insert returned no row');
  }
  return value as { id: string };
}

async function appendImportAudit(
  tx: DatabaseTransaction,
  balanceTransactionId: string,
  disposition: 'inserted' | 'advanced',
  snapshot: BalanceTransactionSnapshot,
  correlationId: string
): Promise<void> {
  await rows(tx, sql`
    insert into audit_events (actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id, after)
    values ('system', 'financial-worker', 'financial.balance_transaction.imported', 'succeeded',
      'financial_balance_transaction', ${balanceTransactionId}, ${correlationId},
      ${JSON.stringify({ disposition, status: snapshot.status, amountMinor: snapshot.amountMinor, feeMinor: snapshot.feeMinor, netMinor: snapshot.netMinor, currency: snapshot.currency, feeDetailCount: snapshot.feeDetails.length })}::jsonb)
  `);
}

async function ensureClassifications(
  tx: DatabaseTransaction,
  balanceTransactionId: string,
  detailIds: readonly string[],
  evidence: CanonicalEvidence,
  correlationId: string
): Promise<void> {
  await appendClassificationDecisionLocked(tx, {
    subjectType: 'balance_transaction', subjectId: balanceTransactionId, classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
    sourceFingerprint: evidence.fingerprint, decision: evidence.parentDecision, correlationId
  });
  if (evidence.parentDecision.status === 'unknown') {
    await observeFinancialIssue(tx, {
      resourceType: 'balance_transaction', resourceId: balanceTransactionId, safeCode: 'unsupported_category',
      impact: 'exception', actor: { type: 'system', id: 'financial-worker' }, correlationId
    });
  }
  for (const [index, detailId] of detailIds.entries()) {
    const decision = evidence.detailDecisions[index]!;
    await appendClassificationDecisionLocked(tx, {
      subjectType: 'fee_detail', subjectId: detailId, classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      sourceFingerprint: evidence.detailFingerprints[index]!, decision, correlationId
    });
    if (decision.status === 'unknown') {
      await observeFinancialIssue(tx, {
        resourceType: 'fee_detail', resourceId: detailId, safeCode: 'unsupported_category',
        impact: 'exception', actor: { type: 'system', id: 'financial-worker' }, correlationId
      });
    }
  }
}

async function activeProjectionVersion(
  tx: DatabaseTransaction
): Promise<{ classifierVersion: number; allocationAlgorithmVersion: number }> {
  const active = await rows(tx, sql`
    select classifier_version as "classifierVersion",
      allocation_algorithm_version as "allocationAlgorithmVersion"
    from financial_projection_versions where singleton = true
  `) as Array<{ classifierVersion: number; allocationAlgorithmVersion: number }>;
  const version = active[0];
  if (!version || active.length !== 1 || !Number.isSafeInteger(version.classifierVersion) ||
    version.classifierVersion < 1 || !Number.isSafeInteger(version.allocationAlgorithmVersion) ||
    version.allocationAlgorithmVersion < 1) unsupportedEvidence();
  return version;
}

async function enqueueAccountProjection(
  tx: DatabaseTransaction,
  subject: { id: string; fingerprintSha256: string }
): Promise<void> {
  const version = await activeProjectionVersion(tx);
  const spec = createFinancialClassificationSubjectJob({
    subjectType: 'balance_transaction',
    subjectId: subject.id,
    sourceFingerprintSha256: subject.fingerprintSha256,
    classifierVersion: version.classifierVersion,
    allocationAlgorithmVersion: version.allocationAlgorithmVersion
  });
  await enqueueJob(tx, {
    type: spec.type,
    payload: spec.payload,
    deduplicationKey: spec.deduplicationKey,
    maxAttempts: spec.maxAttempts
  });
}

async function enqueueAccountProjectionIfReady(
  tx: DatabaseTransaction,
  balanceTransactionId: string
): Promise<void> {
  const candidates = await rows(tx, sql`
    select balance.id, balance.fingerprint_sha256 as "fingerprintSha256"
    from stripe_balance_transactions balance
    where balance.id = ${balanceTransactionId}
      and (
        balance.source_family in ('adjustment', 'unknown')
        or balance.source_family is null
        or (
          balance.source_family = 'payout'
          and exists (
            select 1 from stripe_payouts payout where payout.provider_id = balance.source_id
          )
        )
      )
  `) as Array<{ id: string; fingerprintSha256: string }>;
  if (candidates[0]) await enqueueAccountProjection(tx, candidates[0]);
}

export async function enqueueCurrentAccountProjectionsForPayout(
  tx: DatabaseTransaction,
  providerPayoutId: string
): Promise<void> {
  const candidates = await rows(tx, sql`
    select id, fingerprint_sha256 as "fingerprintSha256"
    from stripe_balance_transactions
    where source_family = 'payout' and source_id = ${providerPayoutId}
    order by id
  `) as Array<{ id: string; fingerprintSha256: string }>;
  for (const candidate of candidates) await enqueueAccountProjection(tx, candidate);
}

export async function stageBalanceTransaction(
  database: Database,
  untrustedSnapshot: BalanceTransactionSnapshot,
  context: { readonly correlationId: string }
): Promise<{ balanceTransactionId: string; disposition: 'inserted' | 'unchanged' | 'advanced' }> {
  if (!context || typeof context !== 'object' || Object.keys(context).length !== 1 ||
    typeof context.correlationId !== 'string' || context.correlationId.length < 1 || context.correlationId.length > 100) unsupportedEvidence();
  const evidence = canonicalEvidence(untrustedSnapshot);
  const result = await database.transaction(async (tx) => {
    const snapshot = evidence.snapshot;
    await rows(tx, sql`select pg_advisory_xact_lock(hashtextextended(${`pale-orbit:financial:balance-transaction:${snapshot.id}`}, 0))`);
    const existingRows = await rows(tx, sql`
      select id, provider_id as "providerId", live_mode as "liveMode", source_family as "sourceFamily",
        source_id as "sourceId", raw_type as "rawType", reporting_category as "reportingCategory",
        balance_type as "balanceType", amount_minor as "amountMinor", fee_minor as "feeMinor",
        net_minor as "netMinor", currency, status, provider_created_at as "providerCreatedAt",
        available_at as "availableAt", exchange_rate as "exchangeRate",
        exchange_source_currency as "exchangeSourceCurrency", exchange_target_currency as "exchangeTargetCurrency",
        fingerprint_sha256 as "fingerprintSha256"
      from stripe_balance_transactions where provider_id = ${snapshot.id} for update
    `);
    const existing = existingRows[0] as StoredParent | undefined;
    if (!existing) {
      const insertedRows = await rows(tx, sql`
        insert into stripe_balance_transactions (
          provider_id, live_mode, source_family, source_id, raw_type, reporting_category, balance_type,
          amount_minor, fee_minor, net_minor, currency, status, provider_created_at, available_at,
          exchange_rate, exchange_source_currency, exchange_target_currency, fingerprint_sha256
        ) values (
          ${snapshot.id}, ${snapshot.livemode}, ${snapshot.sourceFamily}, ${snapshot.sourceId}, ${snapshot.rawType},
          ${snapshot.reportingCategory}, ${snapshot.balanceType}, ${snapshot.amountMinor}, ${snapshot.feeMinor},
          ${snapshot.netMinor}, ${snapshot.currency}, ${snapshot.status}, ${snapshot.createdAt}, ${snapshot.availableAt},
          ${snapshot.exchangeRate}, ${snapshot.exchangeSourceCurrency}, ${snapshot.exchangeTargetCurrency}, ${evidence.fingerprint}
        ) returning id
      `);
      const inserted = parentRow(insertedRows[0]);
      const detailIds: string[] = [];
      for (const [index, detail] of snapshot.feeDetails.entries()) {
        const detailRows = await rows(tx, sql`
          insert into stripe_balance_transaction_fee_details
            (balance_transaction_id, ordinal, raw_type, amount_minor, currency, fingerprint_sha256)
          values (${inserted.id}, ${detail.ordinal}, ${detail.rawType}, ${detail.amountMinor}, ${detail.currency}, ${evidence.detailFingerprints[index]!})
          returning id
        `);
        detailIds.push(parentRow(detailRows[0]).id);
      }
      await ensureClassifications(tx, inserted.id, detailIds, evidence, context.correlationId);
      await appendImportAudit(tx, inserted.id, 'inserted', snapshot, context.correlationId);
      await enqueueAccountProjectionIfReady(tx, inserted.id);
      return { balanceTransactionId: inserted.id, disposition: 'inserted' as const };
    }

    const storedDetails = (await rows(tx, sql`
      select id, ordinal, raw_type as "rawType", amount_minor as "amountMinor", currency,
        fingerprint_sha256 as "fingerprintSha256"
      from stripe_balance_transaction_fee_details where balance_transaction_id = ${existing.id} order by ordinal for update
    `)) as StoredDetail[];
    if (!sameEvidence(existing, evidence) || !sameDetails(storedDetails, evidence)) {
      await observeFinancialIssue(tx, {
        resourceType: 'balance_transaction', resourceId: existing.id, safeCode: 'immutable_mismatch',
        impact: 'exception', actor: { type: 'system', id: 'financial-worker' }, correlationId: context.correlationId
      });
      return { collision: true as const };
    }
    const detailIds = storedDetails.map((detail) => detail.id).filter((id): id is string => typeof id === 'string');
    await ensureClassifications(tx, existing.id, detailIds, evidence, context.correlationId);
    if (existing.status === 'pending' && snapshot.status === 'available') {
      await rows(tx, sql`update stripe_balance_transactions set status = 'available', last_imported_at = now() where id = ${existing.id}`);
      await appendImportAudit(tx, existing.id, 'advanced', snapshot, context.correlationId);
      await enqueueAccountProjectionIfReady(tx, existing.id);
      return { balanceTransactionId: existing.id, disposition: 'advanced' as const };
    }
    if (existing.status === 'pending' && snapshot.status === 'pending') {
      await rows(tx, sql`update stripe_balance_transactions set last_imported_at = now() where id = ${existing.id}`);
    }
    await enqueueAccountProjectionIfReady(tx, existing.id);
    return { balanceTransactionId: existing.id, disposition: 'unchanged' as const };
  });
  if ('collision' in result) throw new PermanentFinancialError('immutable_mismatch');
  return result;
}
