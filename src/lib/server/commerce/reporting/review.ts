import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  requireCapability,
  type Actor,
  type FinancialAuthorizationDependencies
} from '$lib/server/auth/admin-policy';
import { listRolesForUser } from '$lib/server/auth/identity';
import type { Database } from '$lib/server/db/client';
import { financialReconciliationIssues, refunds } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type {
  FinancialIssueCode,
  FinancialIssueDto
} from '$lib/types/financial-reporting';
import { auditFinancialIssueDetailRead } from './audit';
import type { FinancialRequestContext } from './context';
import { SalesReportingInputError } from './filters';
import { currentOperationalFinancialIssuePredicate } from './review-authority';

export const FINANCIAL_ISSUE_PAGE_SIZE = 50 as const;
const CURSOR_MAX_ENCODED_LENGTH = 1_024;
const CURSOR_MAX_DECODED_BYTES = 768;
const CURSOR_VERSION = 1 as const;
const CURSOR_FILTER_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify({ version: CURSOR_VERSION, pageSize: FINANCIAL_ISSUE_PAGE_SIZE }), 'utf8')
  .digest('hex');

export interface FinancialIssueCursor {
  readonly actionabilityRank: 0 | 1 | 2;
  readonly impactRank: 0 | 1 | 2;
  readonly firstObservedAt: string;
  readonly issueId: string;
}

export interface FinancialIssueListInput {
  readonly pageSize: typeof FINANCIAL_ISSUE_PAGE_SIZE;
  readonly cursor?: FinancialIssueCursor;
}

export interface FinancialIssueListDto {
  readonly issues: readonly FinancialIssueDto[];
  readonly currentCursor: string | null;
  readonly nextCursor: string | null;
}

export type FinancialIssueDetailDto = FinancialIssueDto;

export class FinancialReviewRepositoryError extends Error {
  constructor() {
    super('Financial review data is temporarily unavailable.');
    this.name = 'FinancialReviewRepositoryError';
  }
}

const canonicalUuidSchema = z.uuid().refine((value) => value === value.toLowerCase());
const canonicalIntegerTextSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const safePositiveIntegerTextSchema = canonicalIntegerTextSchema
  .refine((value) => {
    const parsed = BigInt(value);
    return parsed >= 1n && parsed <= BigInt(Number.MAX_SAFE_INTEGER);
  })
  .transform(Number);
const rankSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const rankTextSchema = z.union([z.literal('0'), z.literal('1'), z.literal('2')])
  .transform((value) => Number(value) as 0 | 1 | 2);
const microsecondTimestampPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$/u;

function millisecondTimestampFromMicroseconds(value: string): string {
  return value.replace(/([.][0-9]{3})[0-9]{3}Z$/u, '$1Z');
}

const canonicalCursorTimestampSchema = z
  .string()
  .regex(microsecondTimestampPattern)
  .refine((value) => {
    const milliseconds = millisecondTimestampFromMicroseconds(value);
    const parsed = new Date(milliseconds);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === milliseconds;
  });
const postgresTimestampPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/u;

function timestampDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  let normalized = value.replace(' ', 'T');
  normalized = normalized.replace(/([+-][0-9]{2})$/u, '$1:00');
  normalized = normalized.replace(/([+-][0-9]{2})([0-9]{2})$/u, '$1:$2');
  return new Date(normalized);
}

const databaseTimestampSchema = z
  .union([z.date(), z.string().regex(postgresTimestampPattern)])
  .refine((value) => Number.isFinite(timestampDate(value).getTime()))
  .transform((value) => timestampDate(value).toISOString());

const resourceTypeSchema = z.enum([
  'payment',
  'refund',
  'dispute',
  'payout',
  'payout_import_run',
  'balance_transaction',
  'fee_detail',
  'allocation_set',
  'correction_set',
  'financial_classification',
  'financial_scan_run'
]);
const issueCodeSchema = z.enum([
  'allocation_fork',
  'allocation_incomplete',
  'allocation_mismatch',
  'classification_fork',
  'correction_rebase_required',
  'currency_mismatch',
  'generation_exhausted',
  'immutable_mismatch',
  'missing_source',
  'payout_incomplete',
  'payout_membership_conflict',
  'payout_reversal_incomplete',
  'source_linkage_mismatch',
  'unsupported_category'
]);
const cursorSchema = z.strictObject({
  actionabilityRank: rankSchema,
  impactRank: rankSchema,
  firstObservedAt: canonicalCursorTimestampSchema,
  issueId: canonicalUuidSchema
});
const cursorEnvelopeSchema = z.strictObject({
  version: z.literal(CURSOR_VERSION),
  filterFingerprint: z.literal(CURSOR_FILTER_FINGERPRINT),
  actionabilityRank: rankSchema,
  impactRank: rankSchema,
  firstObservedAt: canonicalCursorTimestampSchema,
  issueId: canonicalUuidSchema
});
const listInputSchema = z.strictObject({
  pageSize: z.literal(FINANCIAL_ISSUE_PAGE_SIZE),
  cursor: cursorSchema.optional()
});
const rowSchema = z.strictObject({
  issueId: canonicalUuidSchema,
  resourceType: resourceTypeSchema,
  resourceId: canonicalUuidSchema,
  safeCode: issueCodeSchema,
  state: z.literal('open'),
  impact: z.enum(['pending', 'exception', 'informational']),
  firstObservedAt: databaseTimestampSchema,
  firstObservedAtCursor: canonicalCursorTimestampSchema,
  lastObservedAt: databaseTimestampSchema,
  occurrenceCount: safePositiveIntegerTextSchema,
  actionabilityRank: rankTextSchema,
  impactRank: rankTextSchema,
  refundId: canonicalUuidSchema.nullable()
});

const SAFE_REASON_BY_CODE = {
  allocation_fork: 'Financial allocation has conflicting current branches.',
  allocation_incomplete: 'A financial allocation is incomplete.',
  allocation_mismatch: 'Financial allocation totals do not match the expected amount.',
  classification_fork: 'Financial classification has conflicting current branches.',
  correction_rebase_required: 'A reporting correction must be reviewed against newer data.',
  currency_mismatch: 'Financial records use inconsistent currencies.',
  generation_exhausted: 'Financial recovery stopped after its bounded attempts.',
  immutable_mismatch: 'Stored financial evidence conflicts with its immutable record.',
  missing_source: 'Required financial evidence is not available yet.',
  payout_incomplete: 'Payout membership is not complete yet.',
  payout_membership_conflict: 'Payout membership contains conflicting current records.',
  payout_reversal_incomplete: 'Payout reversal evidence is not complete yet.',
  source_linkage_mismatch: 'Financial source linkage is inconsistent.',
  unsupported_category: 'A financial category is not supported by current reporting.'
} as const satisfies Readonly<Record<FinancialIssueCode, string>>;

interface ParsedIssueRow {
  readonly dto: FinancialIssueDto;
  readonly cursor: FinancialIssueCursor;
}

type QueryResult = { readonly rows?: readonly unknown[] };

function invalidInput(): never {
  throw new SalesReportingInputError();
}

function invalidData(): never {
  throw new FinancialReviewRepositoryError();
}

function queryRows(result: unknown): readonly unknown[] {
  if (result === null || typeof result !== 'object') return invalidData();
  const rows = (result as QueryResult).rows;
  if (!Array.isArray(rows)) return invalidData();
  return rows;
}

function expectedImpactRank(impact: FinancialIssueDto['impact']): 0 | 1 | 2 {
  if (impact === 'exception') return 0;
  if (impact === 'pending') return 1;
  return 2;
}

function parseIssueRow(value: unknown): ParsedIssueRow {
  const result = rowSchema.safeParse(value);
  if (!result.success) return invalidData();
  const row = result.data;
  const actionableRefund = row.resourceType === 'refund' &&
    row.safeCode === 'allocation_incomplete' &&
    row.refundId === row.resourceId;
  const actionabilityRank = actionableRefund ? 0 : row.impact === 'pending' ? 1 : 2;
  if (
    row.actionabilityRank !== actionabilityRank ||
    row.impactRank !== expectedImpactRank(row.impact) ||
    (row.refundId !== null && !actionableRefund) ||
    millisecondTimestampFromMicroseconds(row.firstObservedAtCursor) !== row.firstObservedAt ||
    row.firstObservedAt > row.lastObservedAt
  ) {
    return invalidData();
  }
  const actionability = actionabilityRank === 0
    ? 'refund_allocation_review'
    : actionabilityRank === 1
      ? 'wait_for_recovery'
      : 'read_only';
  const safeReason = actionabilityRank === 0
    ? 'A refund allocation needs review.'
    : SAFE_REASON_BY_CODE[row.safeCode];
  return {
    dto: {
      issueId: row.issueId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      safeCode: row.safeCode,
      state: row.state,
      impact: row.impact,
      actionability,
      operationallyCurrent: true,
      safeReason,
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
      occurrenceCount: row.occurrenceCount,
      refundId: row.refundId
    },
    cursor: {
      actionabilityRank: row.actionabilityRank,
      impactRank: row.impactRank,
      firstObservedAt: row.firstObservedAtCursor,
      issueId: row.issueId
    }
  };
}

export function encodeFinancialIssueCursor(cursor: FinancialIssueCursor): string {
  const parsed = cursorSchema.safeParse(cursor);
  if (!parsed.success) return invalidInput();
  const envelope = {
    version: CURSOR_VERSION,
    filterFingerprint: CURSOR_FILTER_FINGERPRINT,
    ...parsed.data
  };
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (bytes.length > CURSOR_MAX_DECODED_BYTES) return invalidInput();
  const encoded = bytes.toString('base64url');
  if (encoded.length > CURSOR_MAX_ENCODED_LENGTH) return invalidInput();
  return encoded;
}

export function decodeFinancialIssueCursor(value: string): FinancialIssueCursor {
  if (
    value.length < 1 ||
    value.length > CURSOR_MAX_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return invalidInput();
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length > CURSOR_MAX_DECODED_BYTES || bytes.toString('base64url') !== value) {
      return invalidInput();
    }
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalidInput();
  }
  const parsed = cursorEnvelopeSchema.safeParse(decoded);
  if (!parsed.success || Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url') !== value) {
    return invalidInput();
  }
  return {
    actionabilityRank: parsed.data.actionabilityRank,
    impactRank: parsed.data.impactRank,
    firstObservedAt: parsed.data.firstObservedAt,
    issueId: parsed.data.issueId
  };
}

export function parseFinancialIssueListInput(url: URL): FinancialIssueListInput {
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    if (key !== 'cursor' || values.length !== 1 || values[0] === '') return invalidInput();
  }
  const encodedCursor = url.searchParams.get('cursor');
  return encodedCursor === null
    ? { pageSize: FINANCIAL_ISSUE_PAGE_SIZE }
    : {
        pageSize: FINANCIAL_ISSUE_PAGE_SIZE,
        cursor: decodeFinancialIssueCursor(encodedCursor)
      };
}

function rankedIssuesQuery(where: SQL): SQL {
  const operational = currentOperationalFinancialIssuePredicate();
  return sql`
    with ranked_financial_issues as (
      select
        ${financialReconciliationIssues.id} as issue_id,
        ${financialReconciliationIssues.resourceType} as resource_type,
        ${financialReconciliationIssues.resourceId} as resource_id,
        ${financialReconciliationIssues.safeCode} as safe_code,
        ${financialReconciliationIssues.state} as state,
        ${financialReconciliationIssues.impact} as impact,
        ${financialReconciliationIssues.firstObservedAt} as first_observed_at,
        ${financialReconciliationIssues.lastObservedAt} as last_observed_at,
        ${financialReconciliationIssues.occurrenceCount} as occurrence_count,
        case
          when ${refunds.id} is not null then 0
          when ${financialReconciliationIssues.impact} = 'pending' then 1
          else 2
        end as actionability_rank,
        case
          when ${financialReconciliationIssues.impact} = 'exception' then 0
          when ${financialReconciliationIssues.impact} = 'pending' then 1
          else 2
        end as impact_rank,
        ${refunds.id} as refund_id
      from ${financialReconciliationIssues}
      left join ${refunds}
        on ${financialReconciliationIssues.resourceType} = 'refund'
       and ${financialReconciliationIssues.safeCode} = 'allocation_incomplete'
       and ${refunds.id} = ${financialReconciliationIssues.resourceId}
       and ${refunds.status} = 'succeeded'
       and ${refunds.allocationStatus} in ('needs_review', 'draft')
      where ${operational}
    )
    select
      issue_id as "issueId",
      resource_type as "resourceType",
      resource_id as "resourceId",
      safe_code as "safeCode",
      state,
      impact,
      first_observed_at as "firstObservedAt",
      to_char(
        first_observed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as "firstObservedAtCursor",
      last_observed_at as "lastObservedAt",
      occurrence_count::text as "occurrenceCount",
      actionability_rank::text as "actionabilityRank",
      impact_rank::text as "impactRank",
      refund_id as "refundId"
    from ranked_financial_issues
    ${where}
  `;
}

function listQuery(input: FinancialIssueListInput): SQL {
  const cursor = input.cursor;
  const keyset = cursor === undefined
    ? sql``
    : sql`where (actionability_rank, impact_rank, first_observed_at, issue_id) >
        (${cursor.actionabilityRank}, ${cursor.impactRank},
         ${cursor.firstObservedAt}::timestamptz, ${cursor.issueId}::uuid)`;
  return sql`
    ${rankedIssuesQuery(keyset)}
    order by actionability_rank asc, impact_rank asc, first_observed_at asc, issue_id asc
    limit ${input.pageSize + 1}
  `;
}

function detailQuery(issueId: string): SQL {
  return rankedIssuesQuery(sql`where issue_id = ${issueId}::uuid`);
}

export async function listFinancialIssues(
  database: Database,
  actor: Actor,
  input: FinancialIssueListInput,
  dependencies: FinancialAuthorizationDependencies = {}
): Promise<FinancialIssueListDto> {
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  const parsedInput = listInputSchema.safeParse(input);
  if (!parsedInput.success) return invalidInput();
  const normalizedInput: FinancialIssueListInput = parsedInput.data.cursor === undefined
    ? { pageSize: FINANCIAL_ISSUE_PAGE_SIZE }
    : { pageSize: FINANCIAL_ISSUE_PAGE_SIZE, cursor: parsedInput.data.cursor };
  return database.transaction(async (transaction) => {
    const rawRows = queryRows(await transaction.execute(listQuery(normalizedInput)));
    if (rawRows.length > normalizedInput.pageSize + 1) return invalidData();
    const parsedRows = rawRows.map(parseIssueRow);
    const page = parsedRows.slice(0, normalizedInput.pageSize);
    return {
      issues: page.map((row) => row.dto),
      currentCursor: normalizedInput.cursor === undefined
        ? null
        : encodeFinancialIssueCursor(normalizedInput.cursor),
      nextCursor: parsedRows.length > normalizedInput.pageSize
        ? encodeFinancialIssueCursor(page.at(-1)!.cursor)
        : null
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export async function getFinancialIssueDetail(
  database: Database,
  actor: Actor,
  issueId: string,
  context: FinancialRequestContext,
  dependencies: FinancialAuthorizationDependencies = {}
): Promise<FinancialIssueDetailDto | null> {
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  const parsedIssueId = canonicalUuidSchema.safeParse(issueId);
  if (!parsedIssueId.success) return null;

  return database.transaction(async (transaction: DatabaseTransaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
    );
    const refreshedActor = {
      type: 'user' as const,
      id: actor.id,
      roles: await listRolesForUser(transaction, actor.id)
    };
    requireCapability(refreshedActor, 'sales.read', dependencies.capabilityResolver);
    const rows = queryRows(await transaction.execute(detailQuery(parsedIssueId.data)));
    if (rows.length === 0) return null;
    if (rows.length !== 1) return invalidData();
    const issue = parseIssueRow(rows[0]).dto;
    await auditFinancialIssueDetailRead(transaction, {
      actor: refreshedActor,
      issueId: parsedIssueId.data,
      context
    });
    return issue;
  });
}
