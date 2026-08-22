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
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type {
  PayoutDetailDto as FinancialPayoutDetailDto,
  PayoutSummaryDto
} from '$lib/types/financial-reporting';
import { auditFinancialPayoutDetailRead } from './audit';
import type { FinancialRequestContext } from './context';
import { SalesReportingInputError } from './filters';

export const PAYOUT_PAGE_SIZE = 50 as const;
const CURSOR_MAX_ENCODED_LENGTH = 1_024;
const CURSOR_MAX_DECODED_BYTES = 768;
const CURSOR_VERSION = 1 as const;
const CURSOR_FILTER_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify({ version: CURSOR_VERSION, pageSize: PAYOUT_PAGE_SIZE }), 'utf8')
  .digest('hex');

export interface PayoutCursor {
  readonly providerCreatedAt: string;
  readonly payoutId: string;
}

export interface PayoutListInput {
  readonly pageSize: typeof PAYOUT_PAGE_SIZE;
  readonly cursor?: PayoutCursor;
}

export interface PayoutListDto {
  readonly payouts: readonly PayoutSummaryDto[];
  readonly currentCursor: string | null;
  readonly nextCursor: string | null;
}

export type PayoutDetailDto = FinancialPayoutDetailDto;

export class FinancialPayoutReportingRepositoryError extends Error {
  constructor() {
    super('Payout reporting data is temporarily unavailable.');
    this.name = 'FinancialPayoutReportingRepositoryError';
  }
}

const canonicalUuidSchema = z.uuid().refine((value) => value === value.toLowerCase());
const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const safeFailureCodeSchema = z.string().regex(/^[a-z0-9_]{1,100}$/u).nullable();
const canonicalIntegerTextSchema = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u);
const nonnegativeIntegerTextSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);

function safeTextInteger(schema: z.ZodString): z.ZodPipe<z.ZodString, z.ZodTransform<number, string>> {
  return schema.transform((value, context) => {
    const parsed = BigInt(value);
    if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      context.addIssue({ code: 'custom', message: 'Unsafe integer' });
      return z.NEVER;
    }
    return Number(parsed);
  });
}

const safeIntegerTextSchema = safeTextInteger(canonicalIntegerTextSchema);
const safeNonnegativeIntegerTextSchema = safeTextInteger(nonnegativeIntegerTextSchema);
const generationTextSchema = safeNonnegativeIntegerTextSchema.refine(
  (value) => value <= 2_147_483_647
);
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
const cursorSchema = z.strictObject({
  providerCreatedAt: canonicalCursorTimestampSchema,
  payoutId: canonicalUuidSchema
});
const cursorEnvelopeSchema = z.strictObject({
  version: z.literal(CURSOR_VERSION),
  filterFingerprint: z.literal(CURSOR_FILTER_FINGERPRINT),
  providerCreatedAt: canonicalCursorTimestampSchema,
  payoutId: canonicalUuidSchema
});
const listInputSchema = z.strictObject({
  pageSize: z.literal(PAYOUT_PAGE_SIZE),
  cursor: cursorSchema.optional()
});

const summaryRowShape = {
  payoutId: canonicalUuidSchema,
  automatic: z.boolean(),
  method: z.enum(['standard', 'instant', 'unknown']),
  status: z.enum(['pending', 'in_transit', 'paid', 'failed', 'canceled']),
  reconciliationStatus: z.enum(['completed', 'in_progress', 'not_applicable']),
  settlementCurrency: currencySchema,
  amountMinor: safeIntegerTextSchema,
  createdAt: databaseTimestampSchema,
  createdAtCursor: canonicalCursorTimestampSchema,
  arrivalAt: databaseTimestampSchema,
  associatedTransactionCount: safeNonnegativeIntegerTextSchema.nullable(),
  bookstoreLinkedTransactionCount: safeNonnegativeIntegerTextSchema.nullable(),
  membershipComplete: z.boolean(),
  bookstoreLinkedSubtotalMinor: safeIntegerTextSchema.nullable(),
  accountLevelAdjustmentCount: safeNonnegativeIntegerTextSchema.nullable(),
  accountLevelAdjustmentMinor: safeIntegerTextSchema.nullable(),
  safeFailureCode: safeFailureCodeSchema,
  financialGeneration: generationTextSchema,
  membershipGeneration: generationTextSchema.nullable(),
  historicalMembershipRetained: z.boolean(),
  reversalState: z.enum(['none', 'reversed', 'incomplete']),
  openIssueCount: safeNonnegativeIntegerTextSchema,
  freshnessAt: databaseTimestampSchema
} as const;
const summaryRowSchema = z.strictObject(summaryRowShape);
const detailRowSchema = z.strictObject({
  ...summaryRowShape,
  bookstoreLinkedFeeImpactMinor: safeIntegerTextSchema.nullable(),
  bookstoreLinkedNetMinor: safeIntegerTextSchema.nullable(),
  reversalAmountMinor: safeIntegerTextSchema.nullable()
});

type ParsedSummaryRow = z.infer<typeof summaryRowSchema>;
type QueryResult = { readonly rows?: readonly unknown[] };

function invalidInput(): never {
  throw new SalesReportingInputError();
}

function invalidData(): never {
  throw new FinancialPayoutReportingRepositoryError();
}

function queryRows(result: unknown): readonly unknown[] {
  if (result === null || typeof result !== 'object') return invalidData();
  const rows = (result as QueryResult).rows;
  if (!Array.isArray(rows)) return invalidData();
  return rows;
}

function parseMembershipInvariant(row: ParsedSummaryRow): void {
  if (millisecondTimestampFromMicroseconds(row.createdAtCursor) !== row.createdAt) {
    return invalidData();
  }
  const values = [
    row.associatedTransactionCount,
    row.bookstoreLinkedTransactionCount,
    row.bookstoreLinkedSubtotalMinor,
    row.accountLevelAdjustmentCount,
    row.accountLevelAdjustmentMinor,
    row.membershipGeneration
  ];
  const allAvailable = values.every((value) => value !== null);
  const allUnavailable = values.every((value) => value === null);
  if (!allAvailable && !allUnavailable) return invalidData();

  if (allUnavailable) {
    if (row.membershipComplete || row.historicalMembershipRetained) return invalidData();
    return;
  }

  if (
    !row.automatic ||
    row.method !== 'standard' ||
    row.associatedTransactionCount === null ||
    row.bookstoreLinkedTransactionCount === null ||
    row.accountLevelAdjustmentCount === null ||
    row.membershipGeneration === null ||
    row.bookstoreLinkedTransactionCount > row.associatedTransactionCount ||
    row.accountLevelAdjustmentCount > row.associatedTransactionCount
  ) {
    return invalidData();
  }
  const isCurrent =
    row.status === 'paid' &&
    row.reconciliationStatus === 'completed' &&
    row.reversalState === 'none' &&
    row.membershipGeneration === row.financialGeneration;
  if (row.membershipComplete) {
    if (!isCurrent || row.historicalMembershipRetained) return invalidData();
  } else if (!row.historicalMembershipRetained || isCurrent) {
    return invalidData();
  }
}

function summaryDto(row: ParsedSummaryRow): PayoutSummaryDto {
  parseMembershipInvariant(row);
  const base = {
    payoutId: row.payoutId,
    automatic: row.automatic,
    method: row.method,
    status: row.status,
    reconciliationStatus: row.reconciliationStatus,
    settlementCurrency: row.settlementCurrency,
    amountMinor: row.amountMinor,
    createdAt: row.createdAt,
    arrivalAt: row.arrivalAt,
    associatedTransactionCount: row.associatedTransactionCount,
    bookstoreLinkedTransactionCount: row.bookstoreLinkedTransactionCount,
    membershipComplete: row.membershipComplete,
    bookstoreLinkedSubtotalMinor: row.bookstoreLinkedSubtotalMinor,
    accountLevelAdjustmentCount: row.accountLevelAdjustmentCount,
    accountLevelAdjustmentMinor: row.accountLevelAdjustmentMinor,
    safeFailureCode: row.safeFailureCode,
    financialGeneration: row.financialGeneration,
    membershipGeneration: row.membershipGeneration,
    historicalMembershipRetained: row.historicalMembershipRetained,
    reversalState: row.reversalState,
    openIssueCount: row.openIssueCount,
    freshnessAt: row.freshnessAt
  };
  return base as PayoutSummaryDto;
}

function parseSummaryRow(value: unknown): {
  readonly dto: PayoutSummaryDto;
  readonly cursor: PayoutCursor;
} {
  const result = summaryRowSchema.safeParse(value);
  if (!result.success) return invalidData();
  return {
    dto: summaryDto(result.data),
    cursor: {
      providerCreatedAt: result.data.createdAtCursor,
      payoutId: result.data.payoutId
    }
  };
}

function parseDetailRow(value: unknown): PayoutDetailDto {
  const result = detailRowSchema.safeParse(value);
  if (!result.success) return invalidData();
  parseMembershipInvariant(result.data);
  const available = result.data.associatedTransactionCount !== null;
  if (
    (available && (
      result.data.bookstoreLinkedFeeImpactMinor === null ||
      result.data.bookstoreLinkedNetMinor === null ||
      result.data.bookstoreLinkedSubtotalMinor === null ||
      result.data.bookstoreLinkedNetMinor !==
        result.data.bookstoreLinkedSubtotalMinor + result.data.bookstoreLinkedFeeImpactMinor
    )) ||
    (!available && (
      result.data.bookstoreLinkedFeeImpactMinor !== null ||
      result.data.bookstoreLinkedNetMinor !== null
    )) ||
    ((result.data.reversalState === 'reversed') !==
      (result.data.reversalAmountMinor !== null))
  ) {
    return invalidData();
  }
  return {
    ...summaryDto(result.data),
    bookstoreLinkedFeeImpactMinor: result.data.bookstoreLinkedFeeImpactMinor,
    bookstoreLinkedNetMinor: result.data.bookstoreLinkedNetMinor,
    reversalAmountMinor: result.data.reversalAmountMinor
  } as PayoutDetailDto;
}

export function encodePayoutCursor(cursor: PayoutCursor): string {
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

export function decodePayoutCursor(value: string): PayoutCursor {
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
  if (
    !parsed.success ||
    Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url') !== value
  ) {
    return invalidInput();
  }
  return {
    providerCreatedAt: parsed.data.providerCreatedAt,
    payoutId: parsed.data.payoutId
  };
}

export function parsePayoutListInput(url: URL): PayoutListInput {
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    if (key !== 'cursor' || values.length !== 1 || values[0] === '') return invalidInput();
  }
  const encodedCursor = url.searchParams.get('cursor');
  return encodedCursor === null
    ? { pageSize: PAYOUT_PAGE_SIZE }
    : { pageSize: PAYOUT_PAGE_SIZE, cursor: decodePayoutCursor(encodedCursor) };
}

function payoutReportQuery(targetPayoutQuery: SQL, selection: SQL, finalOrder: SQL): SQL {
  return sql`
    with target_payouts as (
      ${targetPayoutQuery}
    ), published_run_candidates as (
      select
        run.id,
        run.payout_id,
        run.generation,
        run.candidate_count,
        run.completed_at,
        case when
          exists (
            select 1
            from stripe_payout_balance_transactions original_membership
            where original_membership.published_from_run_id = run.id
              and original_membership.payout_id = run.payout_id
          ) or (
            run.candidate_count = 0 and not exists (
              select 1
              from payout_import_runs earlier_published
              where earlier_published.payout_id = run.payout_id
                and earlier_published.state = 'published'
                and earlier_published.generation < run.generation
            )
          )
          then run.generation + 1
          else run.generation
        end as certified_generation
      from payout_import_runs run
      join target_payouts target_payout on target_payout.id = run.payout_id
      where run.state = 'published' and run.completed_at is not null
    ), ranked_certifications as (
      select candidate.*,
        row_number() over (
          partition by candidate.payout_id
          order by candidate.certified_generation desc, candidate.completed_at desc, candidate.id desc
        ) as certification_rank
      from published_run_candidates candidate
    ), certified_membership as (
      select * from ranked_certifications where certification_rank = 1
    ), member_head_health as (
      select
        membership.payout_id,
        membership.balance_transaction_id,
        membership.published_at,
        balance_transaction.last_imported_at,
        count(head.balance_transaction_id)::integer as head_count,
        count(*) filter (where head.basis = 'gross_amount')::integer as gross_head_count,
        count(*) filter (where head.basis = 'fee')::integer as fee_head_count,
        coalesce(bool_and(
          head.is_complete
          and head.proposed_issue_code is null
          and head.currency = payout.currency
          and head.scope in ('title', 'account')
        ), false) as heads_complete,
        coalesce(bool_or(head.scope = 'title'), false) as has_title_scope,
        coalesce(bool_or(head.scope = 'account'), false) as has_account_scope,
        coalesce(sum(head.expected_effect_minor) filter (
          where head.scope = 'account'
        ), 0)::bigint as account_effect_minor,
        greatest(
          membership.published_at,
          balance_transaction.last_imported_at,
          max(base_set.created_at),
          max(correction_set.created_at)
        ) as head_freshness_at
      from stripe_payout_balance_transactions membership
      join target_payouts payout on payout.id = membership.payout_id
      join stripe_balance_transactions balance_transaction
        on balance_transaction.id = membership.balance_transaction_id
      left join current_financial_projection_heads head
        on head.balance_transaction_id = membership.balance_transaction_id
      left join financial_allocation_sets base_set on base_set.id = head.base_set_id
      left join refund_reporting_correction_sets correction_set
        on correction_set.id = head.compatible_correction_tip_id
      group by membership.payout_id, membership.balance_transaction_id,
        membership.published_at, balance_transaction.last_imported_at
    ), member_item_effects as (
      select
        membership.payout_id,
        membership.balance_transaction_id,
        coalesce(sum(item.effect_minor) filter (
          where item.component in (
            'sale_subtotal', 'refund_subtotal', 'refund_failure_reversal', 'dispute_subtotal'
          ) or (
            item.component = 'dispute_reinstatement'
            and base_set.algorithm_version = 2
          )
        ), 0)::bigint as bookstore_subtotal_minor,
        coalesce(sum(item.effect_minor) filter (
          where item.component in (
            'processing_fee', 'refund_fee', 'dispute_fee',
            'provider_fee_tax', 'fee_credit', 'other'
          )
        ), 0)::bigint as bookstore_fee_minor,
        count(*) filter (
          where item.balance_transaction_id is not null and (
            item.currency <> payout.currency
            or (item.component = 'dispute_reinstatement' and base_set.algorithm_version <> 2)
            or not (
              (item.basis = 'gross_amount' and item.component in (
                'sale_subtotal', 'sale_tax', 'refund_subtotal', 'refund_tax',
                'refund_failure_reversal', 'dispute_subtotal', 'dispute_tax',
                'dispute_reinstatement', 'fee_credit'
              ))
              or (item.basis = 'fee' and item.component in (
                'processing_fee', 'refund_fee', 'dispute_fee',
                'provider_fee_tax', 'fee_credit', 'other'
              ))
            )
          )
        )::integer as invalid_item_count,
        greatest(max(base_set.created_at), max(correction_set.created_at)) as item_freshness_at
      from stripe_payout_balance_transactions membership
      join target_payouts payout on payout.id = membership.payout_id
      left join current_financial_projection_items item
        on item.balance_transaction_id = membership.balance_transaction_id
      left join financial_allocation_sets base_set on base_set.id = item.base_set_id
      left join refund_reporting_correction_sets correction_set
        on correction_set.id = item.compatible_correction_tip_id
      group by membership.payout_id, membership.balance_transaction_id
    ), member_evidence as (
      select
        health.payout_id,
        health.balance_transaction_id,
        health.has_title_scope,
        health.has_account_scope,
        health.account_effect_minor,
        effects.bookstore_subtotal_minor,
        effects.bookstore_fee_minor,
        health.head_count = 2
          and health.gross_head_count = 1
          and health.fee_head_count = 1
          and health.heads_complete
          and effects.invalid_item_count = 0 as evidence_complete,
        greatest(health.head_freshness_at, effects.item_freshness_at) as evidence_freshness_at
      from member_head_health health
      join member_item_effects effects
        on effects.payout_id = health.payout_id
        and effects.balance_transaction_id = health.balance_transaction_id
    ), membership_aggregates as (
      select
        payout.id as payout_id,
        count(evidence.balance_transaction_id)::integer as associated_transaction_count,
        count(evidence.balance_transaction_id) filter (
          where evidence.has_title_scope
        )::integer as bookstore_linked_transaction_count,
        coalesce(sum(evidence.bookstore_subtotal_minor), 0)::bigint
          as bookstore_linked_subtotal_minor,
        coalesce(sum(evidence.bookstore_fee_minor), 0)::bigint
          as bookstore_linked_fee_impact_minor,
        count(evidence.balance_transaction_id) filter (
          where evidence.has_account_scope
        )::integer as account_level_adjustment_count,
        coalesce(sum(evidence.account_effect_minor), 0)::bigint
          as account_level_adjustment_minor,
        count(evidence.balance_transaction_id) = 0
          or coalesce(bool_and(evidence.evidence_complete), false) as every_member_complete,
        max(evidence.evidence_freshness_at) as member_freshness_at
      from target_payouts payout
      left join member_evidence evidence on evidence.payout_id = payout.id
      group by payout.id
    ), payout_reversal as (
      select
        payout.id as payout_id,
        case
          when payout.reversed_by_provider_payout_id is not null
            and reciprocal.id is null then 'incomplete'
          when payout.status in ('failed', 'canceled')
            and failure_transaction.id is null then 'incomplete'
          when (payout.status in ('failed', 'canceled') and failure_transaction.id is not null)
            or reciprocal.id is not null then 'reversed'
          else 'none'
        end as reversal_state,
        case
          when payout.reversed_by_provider_payout_id is not null and reciprocal.id is null then null
          when payout.status in ('failed', 'canceled') and failure_transaction.id is null then null
          when payout.status in ('failed', 'canceled') and failure_transaction.id is not null
            then failure_transaction.amount_minor
          when reciprocal.id is not null then reciprocal.amount_minor
          else null
        end as reversal_amount_minor,
        greatest(
          case when payout.status in ('failed', 'canceled')
            and failure_transaction.id is not null
            then failure_transaction.last_imported_at end,
          case when reciprocal.id is not null then reciprocal.retrieved_at end
        )
          as reversal_freshness_at
      from target_payouts payout
      left join stripe_balance_transactions failure_transaction
        on failure_transaction.id = payout.failure_balance_transaction_id
        and failure_transaction.live_mode = payout.live_mode
        and failure_transaction.currency = payout.currency
        and failure_transaction.source_family = 'payout'
        and failure_transaction.source_id = payout.provider_id
        and failure_transaction.raw_type = 'payout_failure'
        and failure_transaction.reporting_category = 'payout'
        and failure_transaction.balance_type = 'payments'
      left join stripe_payouts reciprocal
        on reciprocal.provider_id = payout.reversed_by_provider_payout_id
        and reciprocal.original_provider_payout_id = payout.provider_id
        and reciprocal.live_mode = payout.live_mode
        and reciprocal.currency = payout.currency
    ), payout_issue_counts as (
      select issue.resource_id as payout_id, count(*)::integer as open_issue_count
      from financial_reconciliation_issues issue
      join target_payouts target_payout on target_payout.id = issue.resource_id
      where issue.resource_type = 'payout' and issue.state = 'open'
      group by issue.resource_id
    ), payout_report as (
      select
        payout.id as payout_id,
        payout.automatic,
        payout.method,
        payout.status,
        payout.reconciliation_status,
        payout.currency as settlement_currency,
        payout.amount_minor,
        payout.provider_created_at,
        payout.arrival_at,
        payout.safe_failure_code,
        payout.financial_generation,
        reversal.reversal_state,
        reversal.reversal_amount_minor,
        coalesce(issue_count.open_issue_count, 0) as open_issue_count,
        certification.certified_generation as membership_generation,
        certification.id is not null
          and payout.automatic
          and payout.method = 'standard'
          and membership_totals.every_member_complete
          and membership_totals.associated_transaction_count = certification.candidate_count
          as membership_available,
        coalesce(
          payout.automatic
            and payout.method = 'standard'
            and payout.status = 'paid'
            and payout.reconciliation_status = 'completed'
            and reversal.reversal_state = 'none'
            and certification.certified_generation = payout.financial_generation
            and membership_totals.every_member_complete
            and membership_totals.associated_transaction_count = certification.candidate_count,
          false
        ) as membership_complete,
        membership_totals.associated_transaction_count,
        membership_totals.bookstore_linked_transaction_count,
        membership_totals.bookstore_linked_subtotal_minor,
        membership_totals.bookstore_linked_fee_impact_minor,
        membership_totals.bookstore_linked_subtotal_minor
          + membership_totals.bookstore_linked_fee_impact_minor as bookstore_linked_net_minor,
        membership_totals.account_level_adjustment_count,
        membership_totals.account_level_adjustment_minor,
        case when certification.id is not null
          and payout.automatic
          and payout.method = 'standard'
          and membership_totals.every_member_complete
          and membership_totals.associated_transaction_count = certification.candidate_count
          then greatest(
            payout.retrieved_at,
            certification.completed_at,
            membership_totals.member_freshness_at,
            reversal.reversal_freshness_at
          )
          else greatest(payout.retrieved_at, reversal.reversal_freshness_at)
        end as freshness_at
      from target_payouts payout
      left join certified_membership certification on certification.payout_id = payout.id
      join membership_aggregates membership_totals
        on membership_totals.payout_id = payout.id
      join payout_reversal reversal on reversal.payout_id = payout.id
      left join payout_issue_counts issue_count on issue_count.payout_id = payout.id
    )
    select ${selection}
    from payout_report
    ${finalOrder}
  `;
}

const summarySelection = sql`
  payout_id as "payoutId",
  automatic,
  method,
  status,
  reconciliation_status as "reconciliationStatus",
  settlement_currency as "settlementCurrency",
  amount_minor::text as "amountMinor",
  provider_created_at as "createdAt",
  to_char(
    provider_created_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) as "createdAtCursor",
  arrival_at as "arrivalAt",
  case when membership_available then associated_transaction_count::text else null end
    as "associatedTransactionCount",
  case when membership_available then bookstore_linked_transaction_count::text else null end
    as "bookstoreLinkedTransactionCount",
  membership_complete as "membershipComplete",
  case when membership_available then bookstore_linked_subtotal_minor::text else null end
    as "bookstoreLinkedSubtotalMinor",
  case when membership_available then account_level_adjustment_count::text else null end
    as "accountLevelAdjustmentCount",
  case when membership_available then account_level_adjustment_minor::text else null end
    as "accountLevelAdjustmentMinor",
  safe_failure_code as "safeFailureCode",
  financial_generation::text as "financialGeneration",
  case when membership_available then membership_generation::text else null end
    as "membershipGeneration",
  (membership_available and not membership_complete) as "historicalMembershipRetained",
  reversal_state as "reversalState",
  open_issue_count::text as "openIssueCount",
  freshness_at as "freshnessAt"
`;

function listQuery(input: PayoutListInput): SQL {
  const keyset = input.cursor === undefined
    ? sql``
    : sql`where (payout.provider_created_at, payout.id) <
        (${input.cursor.providerCreatedAt}::timestamptz, ${input.cursor.payoutId}::uuid)`;
  return payoutReportQuery(
    sql`
      select payout.*
      from stripe_payouts payout
      ${keyset}
      order by payout.provider_created_at desc, payout.id desc
      limit ${input.pageSize + 1}
    `,
    summarySelection,
    sql`order by provider_created_at desc, payout_id desc`
  );
}

function detailQuery(payoutId: string): SQL {
  return payoutReportQuery(
    sql`
      select payout.*
      from stripe_payouts payout
      where payout.id = ${payoutId}::uuid
    `,
    sql`
      ${summarySelection},
      case when membership_available then bookstore_linked_fee_impact_minor::text else null end
        as "bookstoreLinkedFeeImpactMinor",
      case when membership_available then bookstore_linked_net_minor::text else null end
        as "bookstoreLinkedNetMinor",
      reversal_amount_minor::text as "reversalAmountMinor"
    `,
    sql``
  );
}

export async function listPayouts(
  database: Database,
  actor: Actor,
  input: PayoutListInput,
  dependencies: FinancialAuthorizationDependencies = {}
): Promise<PayoutListDto> {
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  const parsedInput = listInputSchema.safeParse(input);
  if (!parsedInput.success) return invalidInput();
  const normalizedInput: PayoutListInput = parsedInput.data.cursor === undefined
    ? { pageSize: PAYOUT_PAGE_SIZE }
    : { pageSize: PAYOUT_PAGE_SIZE, cursor: parsedInput.data.cursor };
  return database.transaction(async (transaction) => {
    const rawRows = queryRows(await transaction.execute(listQuery(normalizedInput)));
    if (rawRows.length > normalizedInput.pageSize + 1) return invalidData();
    const parsedRows = rawRows.map(parseSummaryRow);
    const page = parsedRows.slice(0, normalizedInput.pageSize);
    return {
      payouts: page.map((row) => row.dto),
      currentCursor: normalizedInput.cursor === undefined
        ? null
        : encodePayoutCursor(normalizedInput.cursor),
      nextCursor: parsedRows.length > normalizedInput.pageSize
        ? encodePayoutCursor(page.at(-1)!.cursor)
        : null
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export async function getPayoutDetail(
  database: Database,
  actor: Actor,
  payoutId: string,
  context: FinancialRequestContext,
  dependencies: FinancialAuthorizationDependencies = {}
): Promise<PayoutDetailDto | null> {
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  const parsedPayoutId = canonicalUuidSchema.safeParse(payoutId);
  if (!parsedPayoutId.success) return null;

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
    const rows = queryRows(await transaction.execute(detailQuery(parsedPayoutId.data)));
    if (rows.length === 0) return null;
    if (rows.length !== 1) return invalidData();
    const payout = parseDetailRow(rows[0]);
    await auditFinancialPayoutDetailRead(transaction, {
      actor: refreshedActor,
      payoutId: parsedPayoutId.data,
      context
    });
    return payout;
  });
}
