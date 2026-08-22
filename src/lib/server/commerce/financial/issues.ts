import type { Actor } from '$lib/server/auth/admin-policy';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { FinancialIssueCode, FinancialIssueImpact } from './types';
import { PermanentFinancialError } from './errors';
import { sql, type SQL } from 'drizzle-orm';

export type FinancialIssueResourceType =
  | 'payment' | 'refund' | 'dispute' | 'payout' | 'payout_import_run'
  | 'balance_transaction' | 'fee_detail' | 'allocation_set' | 'correction_set'
  | 'financial_classification' | 'financial_scan_run';

export type FinancialIssueActor = Extract<Actor, { type: 'system' | 'user' }>;

export interface FinancialIssueIdentity {
  readonly resourceType: FinancialIssueResourceType;
  readonly resourceId: string;
  readonly safeCode: FinancialIssueCode;
}

export interface FinancialIssueRow extends FinancialIssueIdentity {
  readonly id: string;
  readonly state: 'open' | 'resolved';
  readonly impact: FinancialIssueImpact;
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
  readonly occurrenceCount: number;
  readonly correlationId: string;
  readonly resolvedByAdminId: string | null;
  readonly resolvedAt: Date | null;
}

export interface ObserveFinancialIssueInput extends FinancialIssueIdentity {
  readonly impact: FinancialIssueImpact;
  readonly actor: FinancialIssueActor;
  readonly correlationId: string;
}

export interface ResolveFinancialIssueInput extends FinancialIssueIdentity {
  readonly proof: { readonly status: 'resolved' | 'still_open' } & FinancialIssueIdentity;
  readonly actor: FinancialIssueActor;
  readonly correlationId: string;
}

export interface ResolveFinancialIssueAfterAdminCommandInput {
  readonly commandId: string;
  readonly issueId: string;
}

const SOURCE_AND_SET_ISSUE_CODES = new Set<FinancialIssueCode>([
  'allocation_fork', 'allocation_incomplete', 'allocation_mismatch', 'classification_fork',
  'correction_rebase_required', 'currency_mismatch', 'immutable_mismatch', 'missing_source',
  'source_linkage_mismatch', 'unsupported_category'
]);
const ISSUE_CODES_BY_RESOURCE: Readonly<Record<
  FinancialIssueResourceType,
  ReadonlySet<FinancialIssueCode>
>> = {
  payment: SOURCE_AND_SET_ISSUE_CODES,
  refund: SOURCE_AND_SET_ISSUE_CODES,
  dispute: SOURCE_AND_SET_ISSUE_CODES,
  allocation_set: SOURCE_AND_SET_ISSUE_CODES,
  payout: new Set([
    'currency_mismatch', 'generation_exhausted', 'immutable_mismatch',
    'payout_membership_conflict', 'payout_reversal_incomplete'
  ]),
  balance_transaction: new Set(['classification_fork', 'immutable_mismatch']),
  financial_classification: new Set(['unsupported_category']),
  payout_import_run: new Set(),
  fee_detail: new Set(),
  correction_set: new Set(),
  financial_scan_run: new Set()
};
const RESOURCE_TYPES = new Set<FinancialIssueResourceType>(
  Object.keys(ISSUE_CODES_BY_RESOURCE) as FinancialIssueResourceType[]
);
const PENDING_ISSUE_CODES = new Set<FinancialIssueCode>([
  'allocation_incomplete',
  'missing_source'
]);
const ADMIN_RESOLVABLE_ISSUE_CODES = new Set<FinancialIssueCode>([
  'allocation_fork', 'allocation_incomplete', 'allocation_mismatch', 'classification_fork',
  'correction_rebase_required', 'currency_mismatch', 'immutable_mismatch', 'missing_source',
  'source_linkage_mismatch'
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_OCCURRENCES = 2_147_483_647;
const POSTGRES_TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/u;

type SqlResult = { rows?: unknown[] };

function unsupportedEvidence(): never {
  throw new PermanentFinancialError('unsupported_provider_evidence');
}

function invalidAdminTransition(): never {
  throw new Error('Financial administrator issue transition returned invalid data.');
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}

function assertIdentity(value: unknown): asserts value is FinancialIssueIdentity {
  if (!hasExactKeys(value, ['resourceType', 'resourceId', 'safeCode']) ||
    !RESOURCE_TYPES.has(value.resourceType as FinancialIssueResourceType) ||
    !UUID_PATTERN.test(value.resourceId as string) ||
    !ISSUE_CODES_BY_RESOURCE[value.resourceType as FinancialIssueResourceType]
      .has(value.safeCode as FinancialIssueCode)) unsupportedEvidence();
}

function assertActor(value: unknown): asserts value is FinancialIssueActor {
  if (!value || typeof value !== 'object') unsupportedEvidence();
  const actor = value as Record<string, unknown>;
  if (actor.type === 'system') {
    if (!hasExactKeys(actor, ['type', 'id']) || !validText(actor.id, 100)) unsupportedEvidence();
    return;
  }
  if (actor.type !== 'user' || !hasExactKeys(actor, ['type', 'id', 'roles']) || !UUID_PATTERN.test(actor.id as string) ||
    !Array.isArray(actor.roles) || actor.roles.length < 1 || actor.roles.length > 2 ||
    actor.roles.some((role) => role !== 'customer' && role !== 'admin') || new Set(actor.roles).size !== actor.roles.length) unsupportedEvidence();
}

function assertObserveInput(value: unknown): asserts value is ObserveFinancialIssueInput {
  if (!hasExactKeys(value, ['resourceType', 'resourceId', 'safeCode', 'impact', 'actor', 'correlationId'])) unsupportedEvidence();
  assertIdentity({ resourceType: value.resourceType, resourceId: value.resourceId, safeCode: value.safeCode });
  const expectedImpact: FinancialIssueImpact = PENDING_ISSUE_CODES.has(value.safeCode as FinancialIssueCode)
    ? 'pending'
    : 'exception';
  if (value.impact !== expectedImpact || !validText(value.correlationId, 100)) unsupportedEvidence();
  assertActor(value.actor);
}

function assertResolveInput(value: unknown): asserts value is ResolveFinancialIssueInput {
  if (!hasExactKeys(value, ['resourceType', 'resourceId', 'safeCode', 'proof', 'actor', 'correlationId'])) unsupportedEvidence();
  assertIdentity({ resourceType: value.resourceType, resourceId: value.resourceId, safeCode: value.safeCode });
  if (!validText(value.correlationId, 100)) unsupportedEvidence();
  assertActor(value.actor);
  if (value.actor.type !== 'system') unsupportedEvidence();
  if (!hasExactKeys(value.proof, ['status', 'resourceType', 'resourceId', 'safeCode']) ||
    (value.proof.status !== 'resolved' && value.proof.status !== 'still_open')) unsupportedEvidence();
  assertIdentity({ resourceType: value.proof.resourceType, resourceId: value.proof.resourceId, safeCode: value.proof.safeCode });
  if (value.proof.resourceType !== value.resourceType || value.proof.resourceId !== value.resourceId || value.proof.safeCode !== value.safeCode) unsupportedEvidence();
}

function assertAdminResolveInput(
  value: unknown
): asserts value is ResolveFinancialIssueAfterAdminCommandInput {
  if (!hasExactKeys(value, ['commandId', 'issueId']) ||
    !CANONICAL_UUID_PATTERN.test(value.commandId as string) ||
    !CANONICAL_UUID_PATTERN.test(value.issueId as string)) unsupportedEvidence();
}

function adminTimestamp(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== 'string' || !POSTGRES_TIMESTAMP_PATTERN.test(value)) {
    return invalidAdminTransition();
  }
  let normalized = value.replace(' ', 'T');
  normalized = normalized.replace(/([+-][0-9]{2})$/u, '$1:00');
  normalized = normalized.replace(/([+-][0-9]{2})([0-9]{2})$/u, '$1:$2');
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) return invalidAdminTransition();
  return parsed;
}

function adminResolvedIssueRow(value: unknown, issueId: string): FinancialIssueRow {
  const keys = [
    'id', 'resourceType', 'resourceId', 'safeCode', 'state', 'impact', 'firstObservedAt',
    'lastObservedAt', 'occurrenceCount', 'correlationId', 'resolvedByAdminId', 'resolvedAt'
  ] as const;
  if (!hasExactKeys(value, keys) || value.id !== issueId ||
    !CANONICAL_UUID_PATTERN.test(value.id as string) ||
    (value.resourceType !== 'refund' && value.resourceType !== 'allocation_set') ||
    !CANONICAL_UUID_PATTERN.test(value.resourceId as string) ||
    !ADMIN_RESOLVABLE_ISSUE_CODES.has(value.safeCode as FinancialIssueCode) ||
    value.state !== 'resolved' ||
    value.impact !== (PENDING_ISSUE_CODES.has(value.safeCode as FinancialIssueCode)
      ? 'pending'
      : 'exception') ||
    !Number.isInteger(value.occurrenceCount) || (value.occurrenceCount as number) < 1 ||
    (value.occurrenceCount as number) > MAX_OCCURRENCES ||
    !validText(value.correlationId, 100) ||
    !CANONICAL_UUID_PATTERN.test(value.resolvedByAdminId as string)) {
    return invalidAdminTransition();
  }
  const firstObservedAt = adminTimestamp(value.firstObservedAt);
  const lastObservedAt = adminTimestamp(value.lastObservedAt);
  const resolvedAt = adminTimestamp(value.resolvedAt);
  if (lastObservedAt < firstObservedAt || resolvedAt < lastObservedAt) {
    return invalidAdminTransition();
  }
  return {
    id: value.id as string,
    resourceType: value.resourceType,
    resourceId: value.resourceId as string,
    safeCode: value.safeCode as FinancialIssueCode,
    state: 'resolved',
    impact: value.impact as FinancialIssueImpact,
    firstObservedAt,
    lastObservedAt,
    occurrenceCount: value.occurrenceCount as number,
    correlationId: value.correlationId as string,
    resolvedByAdminId: value.resolvedByAdminId as string,
    resolvedAt
  };
}

async function rows(tx: DatabaseTransaction, query: SQL): Promise<unknown[]> {
  return ((await tx.execute(query)) as SqlResult).rows ?? [];
}

function issueRow(value: unknown): FinancialIssueRow {
  if (!value || typeof value !== 'object') throw new Error('Financial issue query returned no row');
  return value as FinancialIssueRow;
}

function issueLockKey(identity: FinancialIssueIdentity): string {
  return `pale-orbit:financial:issue:${identity.resourceType}:${identity.resourceId}:${identity.safeCode}`;
}

async function lockCurrentOpen(tx: DatabaseTransaction, identity: FinancialIssueIdentity): Promise<FinancialIssueRow | null> {
  await rows(tx, sql`select pg_advisory_xact_lock(hashtext(${issueLockKey(identity)}))`);
  const current = await rows(tx, sql`
    select id, resource_type as "resourceType", resource_id as "resourceId", safe_code as "safeCode",
      state, impact, first_observed_at as "firstObservedAt", last_observed_at as "lastObservedAt",
      occurrence_count as "occurrenceCount", correlation_id as "correlationId",
      resolved_by_admin_id as "resolvedByAdminId", resolved_at as "resolvedAt"
    from financial_reconciliation_issues
    where resource_type = ${identity.resourceType} and resource_id = ${identity.resourceId}
      and safe_code = ${identity.safeCode} and state = 'open'
    for update
  `);
  return current[0] ? issueRow(current[0]) : null;
}

function auditAfter(row: FinancialIssueRow): Record<string, string | number> {
  return {
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    safeCode: row.safeCode,
    impact: row.impact,
    state: row.state,
    occurrenceCount: row.occurrenceCount
  };
}

async function appendIssueAudit(
  tx: DatabaseTransaction,
  actor: FinancialIssueActor,
  action: 'financial.issue.opened' | 'financial.issue.resolved',
  row: FinancialIssueRow,
  correlationId: string
): Promise<void> {
  await rows(tx, sql`
    insert into audit_events (
      actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id, after
    ) values (
      ${actor.type}, ${actor.id}, ${action}, 'succeeded', 'financial_issue', ${row.id},
      ${correlationId}, ${JSON.stringify(auditAfter(row))}::jsonb
    )
  `);
}

export async function observeFinancialIssue(
  tx: DatabaseTransaction,
  input: ObserveFinancialIssueInput
): Promise<FinancialIssueRow> {
  assertObserveInput(input);
  const current = await lockCurrentOpen(tx, input);
  if (current) {
    if (current.impact !== input.impact) throw new PermanentFinancialError('immutable_mismatch');
    const updated = await rows(tx, sql`
      update financial_reconciliation_issues
      set last_observed_at = now(),
        occurrence_count = least(occurrence_count::bigint + 1, ${sql.raw(String(MAX_OCCURRENCES))})::int
      where id = ${current.id}
      returning id, resource_type as "resourceType", resource_id as "resourceId", safe_code as "safeCode",
        state, impact, first_observed_at as "firstObservedAt", last_observed_at as "lastObservedAt",
        occurrence_count as "occurrenceCount", correlation_id as "correlationId",
        resolved_by_admin_id as "resolvedByAdminId", resolved_at as "resolvedAt"
    `);
    return issueRow(updated[0]);
  }
  const inserted = await rows(tx, sql`
    insert into financial_reconciliation_issues (
      resource_type, resource_id, safe_code, state, impact, occurrence_count, correlation_id
    ) values (
      ${input.resourceType}, ${input.resourceId}, ${input.safeCode}, 'open', ${input.impact}, 1,
      ${input.correlationId}
    ) returning id, resource_type as "resourceType", resource_id as "resourceId", safe_code as "safeCode",
      state, impact, first_observed_at as "firstObservedAt", last_observed_at as "lastObservedAt",
      occurrence_count as "occurrenceCount", correlation_id as "correlationId",
      resolved_by_admin_id as "resolvedByAdminId", resolved_at as "resolvedAt"
  `);
  const row = issueRow(inserted[0]);
  await appendIssueAudit(tx, input.actor, 'financial.issue.opened', row, input.correlationId);
  return row;
}

export async function resolveFinancialIssueAfterRecompute(
  tx: DatabaseTransaction,
  input: ResolveFinancialIssueInput
): Promise<FinancialIssueRow | null> {
  assertResolveInput(input);
  if (input.resourceType === 'financial_classification' &&
    input.safeCode === 'unsupported_category' && input.proof.status === 'resolved') {
    unsupportedEvidence();
  }
  if (input.proof.status === 'still_open') return null;
  const current = await lockCurrentOpen(tx, input);
  if (!current) return null;
  const updated = await rows(tx, sql`
    select id, resource_type as "resourceType", resource_id as "resourceId", safe_code as "safeCode",
      state, impact, first_observed_at as "firstObservedAt", last_observed_at as "lastObservedAt",
      occurrence_count as "occurrenceCount", correlation_id as "correlationId",
      resolved_by_admin_id as "resolvedByAdminId", resolved_at as "resolvedAt"
    from "public"."resolve_financial_issue_after_worker_recompute"(
      ${current.id}, ${input.correlationId}
    )
  `);
  if (!updated[0]) return null;
  return issueRow(updated[0]);
}

export async function resolveFinancialIssueAfterAdminCommand(
  tx: DatabaseTransaction,
  input: ResolveFinancialIssueAfterAdminCommandInput
): Promise<FinancialIssueRow | null> {
  assertAdminResolveInput(input);
  const result = await tx.execute(sql`
    select id, resource_type as "resourceType", resource_id as "resourceId",
      safe_code as "safeCode", state, impact,
      first_observed_at as "firstObservedAt", last_observed_at as "lastObservedAt",
      occurrence_count as "occurrenceCount", correlation_id as "correlationId",
      resolved_by_admin_id as "resolvedByAdminId", resolved_at as "resolvedAt"
    from "public"."resolve_financial_issue_after_admin_command"(
      ${input.commandId}, ${input.issueId}
    )
  `) as unknown;
  if (!result || typeof result !== 'object' ||
    !Array.isArray((result as SqlResult).rows) ||
    ((result as SqlResult).rows?.length ?? 0) > 1) {
    return invalidAdminTransition();
  }
  const resultRows = (result as SqlResult).rows ?? [];
  if (resultRows.length === 0) return null;
  return adminResolvedIssueRow(resultRows[0], input.issueId);
}
