import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { BalanceTransactionSnapshot } from '$lib/server/commerce/stripe/financial-types';
import type { FinancialClassification, FinancialClassificationDecision } from './types';
import { PermanentFinancialError } from './errors';
import type { FinancialClassificationVersionRow } from '$lib/server/db/schema/financial-provider';
import { sql, type SQL } from 'drizzle-orm';

export interface BalanceTransactionClassificationInput {
  readonly sourceFamily: BalanceTransactionSnapshot['sourceFamily'] | null;
  readonly rawType: string;
  readonly reportingCategory: string;
  readonly amountMinor: number;
}

export interface FeeDetailClassificationInput {
  readonly parentClassification: FinancialClassification;
  readonly rawType: string;
  readonly amountMinor: number;
}

export interface AppendClassificationDecisionInput {
  readonly subjectType: 'balance_transaction' | 'fee_detail';
  readonly subjectId: string;
  readonly classifierVersion: number;
  readonly sourceFingerprint: string;
  readonly decision: FinancialClassificationDecision;
  readonly correlationId: string;
}

const UNKNOWN_DECISION: FinancialClassificationDecision = Object.freeze({
  status: 'unknown',
  classification: 'unknown',
  impact: 'exception',
  safeCode: 'unsupported_category'
});

const CLASSIFICATIONS = new Set<FinancialClassification>([
  'charge', 'refund', 'refund_failure', 'dispute_withdrawal', 'dispute_reinstatement',
  'payout', 'processing_fee', 'refund_fee', 'dispute_fee', 'provider_fee_tax',
  'fee_credit', 'other', 'unknown'
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_MONEY_MAX = 99_999_999;
const POSTGRES_INT_MAX = 2_147_483_647;

function unsupportedEvidence(): never {
  throw new PermanentFinancialError('unsupported_provider_evidence');
}

function classified(classification: Exclude<FinancialClassification, 'unknown'>): FinancialClassificationDecision {
  return { status: 'classified', classification, impact: 'informational' };
}

function validBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function validMoney(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= SAFE_MONEY_MAX;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function assertBalanceInput(input: BalanceTransactionClassificationInput): void {
  if (
    !input || typeof input !== 'object' ||
    !hasExactKeys(input, ['sourceFamily', 'rawType', 'reportingCategory', 'amountMinor']) ||
    !['charge', 'refund', 'dispute', 'payout', 'adjustment', 'unknown', null].includes(input.sourceFamily) ||
    !validBoundedString(input.rawType, 100) ||
    !validBoundedString(input.reportingCategory, 100) ||
    !validMoney(input.amountMinor, -SAFE_MONEY_MAX)
  ) unsupportedEvidence();
}

function assertFeeInput(input: FeeDetailClassificationInput): void {
  if (
    !input || typeof input !== 'object' ||
    !hasExactKeys(input, ['parentClassification', 'rawType', 'amountMinor']) ||
    !CLASSIFICATIONS.has(input.parentClassification) ||
    !validBoundedString(input.rawType, 100) ||
    !validMoney(input.amountMinor, 0)
  ) unsupportedEvidence();
}

export function classifyBalanceTransaction(
  input: BalanceTransactionClassificationInput
): FinancialClassificationDecision {
  assertBalanceInput(input);
  const { reportingCategory, rawType, sourceFamily, amountMinor } = input;
  if (reportingCategory === 'charge' && sourceFamily === 'charge' && ['charge', 'payment', 'validation'].includes(rawType)) return classified('charge');
  if (reportingCategory === 'refund' && sourceFamily === 'refund' && ['refund', 'payment_refund'].includes(rawType)) return classified('refund');
  if (reportingCategory === 'refund_failure' && sourceFamily === 'refund' && rawType === 'refund_failure') return classified('refund_failure');
  if (reportingCategory === 'dispute' && sourceFamily === 'dispute' && ['adjustment', 'adjusted_for_overdraft_transaction'].includes(rawType)) return classified('dispute_withdrawal');
  if (reportingCategory === 'dispute_reversal' && sourceFamily === 'dispute' && rawType === 'adjustment') return classified('dispute_reinstatement');
  if (reportingCategory === 'payout' && sourceFamily === 'payout' && rawType === 'payout') return classified('payout');
  if (reportingCategory === 'fee' && ['stripe_fee', 'stripe_fx_fee'].includes(rawType)) {
    return classified(amountMinor > 0 ? 'fee_credit' : 'other');
  }
  if (reportingCategory === 'tax' && rawType === 'tax_fee') return classified('provider_fee_tax');
  if (reportingCategory === 'other_adjustment' && rawType === 'adjustment') return classified('other');
  return UNKNOWN_DECISION;
}

export function classifyFeeDetail(input: FeeDetailClassificationInput): FinancialClassificationDecision {
  assertFeeInput(input);
  if (input.parentClassification === 'unknown') return UNKNOWN_DECISION;
  if (input.rawType === 'tax') return classified('provider_fee_tax');
  if (input.rawType === 'application_fee') return classified('other');
  if (!['stripe_fee', 'payment_method_passthrough_fee'].includes(input.rawType)) return UNKNOWN_DECISION;
  if (input.parentClassification === 'charge') return classified('processing_fee');
  if (input.parentClassification === 'refund' || input.parentClassification === 'refund_failure') return classified('refund_fee');
  if (input.parentClassification === 'dispute_withdrawal' || input.parentClassification === 'dispute_reinstatement') return classified('dispute_fee');
  return classified('other');
}

function assertAppendInput(input: AppendClassificationDecisionInput): void {
  const value = input as unknown as Record<string, unknown>;
  const knownKeys = ['subjectType', 'subjectId', 'classifierVersion', 'sourceFingerprint', 'decision', 'correlationId'];
  if (!input || typeof input !== 'object' || Object.keys(value).length !== knownKeys.length ||
    !knownKeys.every((key) => Object.hasOwn(value, key))) unsupportedEvidence();
  if (
    (input.subjectType !== 'balance_transaction' && input.subjectType !== 'fee_detail') ||
    !UUID_PATTERN.test(input.subjectId) ||
    !Number.isSafeInteger(input.classifierVersion) || input.classifierVersion < 1 || input.classifierVersion > POSTGRES_INT_MAX ||
    !FINGERPRINT_PATTERN.test(input.sourceFingerprint) ||
    !validBoundedString(input.correlationId, 100)
  ) unsupportedEvidence();
  const decision = input.decision as unknown as Record<string, unknown>;
  const expectedKeys = decision?.status === 'classified'
    ? ['status', 'classification', 'impact']
    : decision?.status === 'unknown'
      ? ['status', 'classification', 'impact', 'safeCode']
      : [];
  if (
    !decision || typeof decision !== 'object' || Object.keys(decision).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(decision, key)) || !CLASSIFICATIONS.has(decision.classification as FinancialClassification) ||
    (decision.status === 'classified' && (decision.classification === 'unknown' || decision.impact !== 'informational')) ||
    (decision.status === 'unknown' && (decision.classification !== 'unknown' || decision.impact !== 'exception' || decision.safeCode !== 'unsupported_category'))
  ) unsupportedEvidence();
}

type SqlResult = { rows?: unknown[] };

async function rows(transaction: DatabaseTransaction, query: SQL): Promise<unknown[]> {
  return ((await transaction.execute(query)) as SqlResult).rows ?? [];
}

function classificationRow(row: unknown): FinancialClassificationVersionRow {
  if (!row || typeof row !== 'object') throw new Error('Financial classification query returned no row');
  return row as FinancialClassificationVersionRow;
}

export async function appendClassificationDecisionLocked(
  tx: DatabaseTransaction,
  input: AppendClassificationDecisionInput
): Promise<FinancialClassificationVersionRow> {
  assertAppendInput(input);
  let subject: { sourceFingerprint?: unknown } | undefined;
  if (input.subjectType === 'balance_transaction') {
    const subjectRows = await rows(tx, sql`
      select id, fingerprint_sha256 as "sourceFingerprint"
      from stripe_balance_transactions where id = ${input.subjectId} for update
    `);
    subject = subjectRows[0] as { sourceFingerprint?: unknown } | undefined;
  } else {
    const parentRows = await rows(tx, sql`
      select bt.id as "balanceTransactionId"
      from stripe_balance_transaction_fee_details fd
      join stripe_balance_transactions bt on bt.id = fd.balance_transaction_id
      where fd.id = ${input.subjectId}
      for update of bt
    `);
    const parent = parentRows[0] as { balanceTransactionId?: unknown } | undefined;
    if (!parent) unsupportedEvidence();
    const subjectRows = await rows(tx, sql`
      select id, balance_transaction_id as "balanceTransactionId",
        fingerprint_sha256 as "sourceFingerprint"
      from stripe_balance_transaction_fee_details
      where id = ${input.subjectId}
      for update
    `);
    const fee = subjectRows[0] as {
      balanceTransactionId?: unknown;
      sourceFingerprint?: unknown;
    } | undefined;
    if (!fee || fee.balanceTransactionId !== parent.balanceTransactionId) unsupportedEvidence();
    subject = fee;
  }
  if (!subject || subject.sourceFingerprint !== input.sourceFingerprint) unsupportedEvidence();

  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pale-orbit:financial:classification:${input.subjectType}:${input.subjectId}`}, 0))`);
  const identityRows = await rows(tx, sql`
    select id, subject_type as "subjectType", subject_id as "subjectId",
      classifier_version as "classifierVersion", classification,
      source_fingerprint_sha256 as "sourceFingerprintSha256", decided_at as "decidedAt"
    from financial_classification_versions
    where subject_type = ${input.subjectType} and subject_id = ${input.subjectId}
      and classifier_version = ${input.classifierVersion}
      and source_fingerprint_sha256 = ${input.sourceFingerprint}
    for update
  `);
  const existing = identityRows[0] as { classification?: unknown } | undefined;
  if (existing) {
    if (existing.classification !== input.decision.classification) {
      throw new PermanentFinancialError('classification_fork');
    }
    return classificationRow(existing);
  }

  const insertedRows = await rows(tx, sql`
    insert into financial_classification_versions
      (subject_type, subject_id, classifier_version, classification, source_fingerprint_sha256)
    values (${input.subjectType}, ${input.subjectId}, ${input.classifierVersion}, ${input.decision.classification}, ${input.sourceFingerprint})
    returning id, subject_type as "subjectType", subject_id as "subjectId",
      classifier_version as "classifierVersion", classification,
      source_fingerprint_sha256 as "sourceFingerprintSha256", decided_at as "decidedAt"
  `);
  const inserted = classificationRow(insertedRows[0]);
  await tx.execute(sql`
    insert into audit_events
      (actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id, after)
    values ('system', 'financial-worker', 'financial.classification.appended', 'succeeded',
      'financial_classification', ${input.subjectId}, ${input.correlationId},
      ${JSON.stringify({ subjectType: input.subjectType, classification: input.decision.classification, classifierVersion: input.classifierVersion })}::jsonb)
  `);
  return inserted;
}
