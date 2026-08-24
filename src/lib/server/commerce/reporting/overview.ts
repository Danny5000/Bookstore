import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  capabilitiesForRoles,
  requireCapability,
  type Actor,
  type FinancialAuthorizationDependencies
} from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { financialReconciliationIssues } from '$lib/server/db/schema';
import type {
  PublicFinancialState,
  SalesCurrencySummaryDto,
  SalesRange,
  SalesSort,
  SoldAsTitleVariantDto,
  TitleFormat,
  TitleSalesRowDto
} from '$lib/types/financial-reporting';
import {
  encodeSalesCursor,
  fingerprintSalesFilters,
  type SalesOverviewFilters
} from './filters';
import { payoutMembershipCertificationCtes } from './payout-membership-authority';
import { currentOperationalFinancialIssuePredicate } from './review-authority';

export interface SalesOverviewDependencies extends FinancialAuthorizationDependencies {
  readonly stripeEnabled?: boolean;
}

export interface SalesAggregateRowsOptions {
  readonly applyCursor: boolean;
  readonly limit: number;
}

export const SALES_OVERVIEW_FILTER_DTO_KEYS = [
  'range',
  'from',
  'to',
  'titleId',
  'format',
  'presentmentCurrency',
  'settlementCurrency',
  'state',
  'sort'
] as const;

export interface SalesOverviewFilterDto {
  readonly range: SalesRange;
  readonly from: string | null;
  readonly to: string | null;
  readonly titleId: string | null;
  readonly format: TitleFormat | null;
  readonly presentmentCurrency: string | null;
  readonly settlementCurrency: string | 'pending' | null;
  readonly state: PublicFinancialState | null;
  readonly sort: SalesSort;
}

export const SALES_OVERVIEW_DTO_KEYS = [
  'filters',
  'rows',
  'summaries',
  'nextCursor',
  'dataThroughAt',
  'stripeEnabled',
  'missingSourceCount',
  'needsReviewCount'
] as const;

export interface SalesOverviewDto {
  readonly filters: SalesOverviewFilterDto;
  readonly rows: readonly TitleSalesRowDto[];
  readonly summaries: readonly SalesCurrencySummaryDto[];
  readonly nextCursor: string | null;
  readonly dataThroughAt: string | null;
  readonly stripeEnabled: boolean;
  readonly missingSourceCount: number;
  readonly needsReviewCount: number;
}

class SalesOverviewRepositoryError extends Error {
  constructor() {
    super('Sales overview data is temporarily unavailable.');
    this.name = 'SalesOverviewRepositoryError';
  }
}

function invalidData(): never {
  throw new SalesOverviewRepositoryError();
}

const canonicalUuidSchema = z.uuid().refine((value) => value === value.toLowerCase());
const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const canonicalIntegerTextSchema = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u);
const safeIntegerTextSchema = canonicalIntegerTextSchema
  .refine((value) => {
    const parsed = BigInt(value);
    return parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER);
  })
  .transform((value) => Number(value));
const safeCountTextSchema = canonicalIntegerTextSchema
  .refine((value) => {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER);
  })
  .transform((value) => Number(value));
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
const soldAsVariantSchema = z.strictObject({
  title: z.string().min(1).max(300),
  creatorName: z.string().min(1).max(300),
  format: z.enum(['prose', 'comic'])
});
const stateSchema = z.enum(['pending', 'fee_reconciled', 'payout_reconciled', 'exception']);

const rowSchema = z.strictObject({
  titleId: canonicalUuidSchema,
  currentTitle: z.string().min(1).max(300),
  format: z.enum(['prose', 'comic']),
  archived: z.boolean(),
  soldAsVariants: z.array(soldAsVariantSchema),
  presentmentCurrency: currencySchema,
  settlementCurrency: currencySchema.nullable(),
  soldCopies: safeCountTextSchema,
  fullyRefundedCopies: safeCountTextSchema,
  netCopies: safeCountTextSchema,
  grossPresentmentMinor: safeCountTextSchema,
  finalizedRefundPresentmentMinor: safeCountTextSchema,
  disputeWithdrawalPresentmentMinor: safeCountTextSchema,
  disputeReinstatementPresentmentMinor: safeCountTextSchema,
  grossSettlementMinor: safeIntegerTextSchema.nullable(),
  refundImpactMinor: safeIntegerTextSchema.nullable(),
  disputeImpactMinor: safeIntegerTextSchema.nullable(),
  processingFeeImpactMinor: safeIntegerTextSchema.nullable(),
  refundFeeImpactMinor: safeIntegerTextSchema.nullable(),
  disputeFeeImpactMinor: safeIntegerTextSchema.nullable(),
  otherFeeImpactMinor: safeIntegerTextSchema.nullable(),
  estimatedPayoutMinor: safeIntegerTextSchema.nullable(),
  settlementMetricsComplete: z.boolean(),
  missingSourceCount: safeCountTextSchema,
  state: stateSchema,
  freshnessAt: databaseTimestampSchema
});

const summarySchema = z.strictObject({
  presentmentCurrency: currencySchema,
  settlementCurrency: currencySchema.nullable(),
  titleCount: safeCountTextSchema,
  soldCopies: safeCountTextSchema,
  fullyRefundedCopies: safeCountTextSchema,
  netCopies: safeCountTextSchema,
  grossPresentmentMinor: safeCountTextSchema,
  finalizedRefundPresentmentMinor: safeCountTextSchema,
  disputeWithdrawalPresentmentMinor: safeCountTextSchema,
  disputeReinstatementPresentmentMinor: safeCountTextSchema,
  grossSettlementMinor: safeIntegerTextSchema.nullable(),
  refundImpactMinor: safeIntegerTextSchema.nullable(),
  disputeImpactMinor: safeIntegerTextSchema.nullable(),
  processingFeeImpactMinor: safeIntegerTextSchema.nullable(),
  refundFeeImpactMinor: safeIntegerTextSchema.nullable(),
  disputeFeeImpactMinor: safeIntegerTextSchema.nullable(),
  otherFeeImpactMinor: safeIntegerTextSchema.nullable(),
  estimatedPayoutMinor: safeIntegerTextSchema.nullable(),
  settlementMetricsComplete: z.boolean(),
  missingSourceCount: safeCountTextSchema,
  state: stateSchema
});
const reviewCountSchema = z.strictObject({ needsReviewCount: safeCountTextSchema });
const freshnessSchema = z.strictObject({
  sourceCompletedAt: databaseTimestampSchema.nullable(),
  payoutCompletedAt: databaseTimestampSchema.nullable(),
  projectionCompletedAt: databaseTimestampSchema.nullable()
});

type QueryResult = { readonly rows?: readonly unknown[] };

function queryRows(result: unknown): readonly unknown[] {
  if (!result || typeof result !== 'object') return invalidData();
  const rows = (result as QueryResult).rows;
  if (!Array.isArray(rows)) return invalidData();
  return rows;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) return invalidData();
  return total;
}

function estimate(value: {
  grossSettlementMinor: number | null;
  refundImpactMinor: number | null;
  disputeImpactMinor: number | null;
  processingFeeImpactMinor: number | null;
  refundFeeImpactMinor: number | null;
  disputeFeeImpactMinor: number | null;
  otherFeeImpactMinor: number | null;
}): number | null {
  const components = [
    value.grossSettlementMinor,
    value.refundImpactMinor,
    value.disputeImpactMinor,
    value.processingFeeImpactMinor,
    value.refundFeeImpactMinor,
    value.disputeFeeImpactMinor,
    value.otherFeeImpactMinor
  ];
  let total = 0;
  for (const component of components) {
    if (component === null) return null;
    total = safeAdd(total, component);
  }
  return total;
}

function cloneVariants(value: readonly SoldAsTitleVariantDto[]): readonly SoldAsTitleVariantDto[] {
  return value.map((variant) => ({
    title: variant.title,
    creatorName: variant.creatorName,
    format: variant.format
  }));
}

function settlementValuesAreNull(value: {
  grossSettlementMinor: number | null;
  refundImpactMinor: number | null;
  disputeImpactMinor: number | null;
  processingFeeImpactMinor: number | null;
  refundFeeImpactMinor: number | null;
  disputeFeeImpactMinor: number | null;
  otherFeeImpactMinor: number | null;
  estimatedPayoutMinor: number | null;
}): boolean {
  return value.grossSettlementMinor === null &&
    value.refundImpactMinor === null &&
    value.disputeImpactMinor === null &&
    value.processingFeeImpactMinor === null &&
    value.refundFeeImpactMinor === null &&
    value.disputeFeeImpactMinor === null &&
    value.otherFeeImpactMinor === null &&
    value.estimatedPayoutMinor === null;
}

function parseRow(value: unknown): TitleSalesRowDto {
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success) return invalidData();
  const row = parsed.data;
  if (
    row.fullyRefundedCopies > row.soldCopies ||
    row.netCopies !== row.soldCopies - row.fullyRefundedCopies
  ) return invalidData();

  const base = {
    titleId: row.titleId,
    currentTitle: row.currentTitle,
    format: row.format,
    archived: row.archived,
    soldAsVariants: cloneVariants(row.soldAsVariants),
    presentmentCurrency: row.presentmentCurrency,
    settlementCurrency: row.settlementCurrency,
    soldCopies: row.soldCopies,
    fullyRefundedCopies: row.fullyRefundedCopies,
    netCopies: row.netCopies,
    grossPresentmentMinor: row.grossPresentmentMinor,
    finalizedRefundPresentmentMinor: row.finalizedRefundPresentmentMinor,
    disputeWithdrawalPresentmentMinor: row.disputeWithdrawalPresentmentMinor,
    disputeReinstatementPresentmentMinor: row.disputeReinstatementPresentmentMinor
  };
  if (!row.settlementMetricsComplete) {
    if (
      row.missingSourceCount < 1 ||
      (row.state !== 'pending' && row.state !== 'exception') ||
      !settlementValuesAreNull(row)
    ) return invalidData();
    return {
      ...base,
      grossSettlementMinor: null,
      refundImpactMinor: null,
      disputeImpactMinor: null,
      processingFeeImpactMinor: null,
      refundFeeImpactMinor: null,
      disputeFeeImpactMinor: null,
      otherFeeImpactMinor: null,
      estimatedPayoutMinor: null,
      settlementMetricsComplete: false,
      missingSourceCount: row.missingSourceCount,
      state: row.state,
      freshnessAt: row.freshnessAt
    };
  }
  if (
    row.settlementCurrency === null || row.missingSourceCount !== 0 ||
    (row.state !== 'fee_reconciled' && row.state !== 'payout_reconciled') ||
    row.grossSettlementMinor === null || row.refundImpactMinor === null ||
    row.disputeImpactMinor === null || row.processingFeeImpactMinor === null ||
    row.refundFeeImpactMinor === null || row.disputeFeeImpactMinor === null ||
    row.otherFeeImpactMinor === null || row.estimatedPayoutMinor === null
  ) return invalidData();
  if (estimate(row) !== row.estimatedPayoutMinor) return invalidData();
  return {
    ...base,
    settlementCurrency: row.settlementCurrency,
    grossSettlementMinor: row.grossSettlementMinor,
    refundImpactMinor: row.refundImpactMinor,
    disputeImpactMinor: row.disputeImpactMinor,
    processingFeeImpactMinor: row.processingFeeImpactMinor,
    refundFeeImpactMinor: row.refundFeeImpactMinor,
    disputeFeeImpactMinor: row.disputeFeeImpactMinor,
    otherFeeImpactMinor: row.otherFeeImpactMinor,
    estimatedPayoutMinor: row.estimatedPayoutMinor,
    settlementMetricsComplete: true,
    missingSourceCount: 0,
    state: row.state,
    freshnessAt: row.freshnessAt
  };
}

function parseSummary(value: unknown): SalesCurrencySummaryDto {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success) return invalidData();
  const row = parsed.data;
  if (
    row.fullyRefundedCopies > row.soldCopies ||
    row.netCopies !== row.soldCopies - row.fullyRefundedCopies
  ) return invalidData();
  const base = {
    presentmentCurrency: row.presentmentCurrency,
    settlementCurrency: row.settlementCurrency,
    titleCount: row.titleCount,
    soldCopies: row.soldCopies,
    fullyRefundedCopies: row.fullyRefundedCopies,
    netCopies: row.netCopies,
    grossPresentmentMinor: row.grossPresentmentMinor,
    finalizedRefundPresentmentMinor: row.finalizedRefundPresentmentMinor,
    disputeWithdrawalPresentmentMinor: row.disputeWithdrawalPresentmentMinor,
    disputeReinstatementPresentmentMinor: row.disputeReinstatementPresentmentMinor
  };
  if (!row.settlementMetricsComplete) {
    if (
      row.missingSourceCount < 1 ||
      (row.state !== 'pending' && row.state !== 'exception') ||
      !settlementValuesAreNull(row)
    ) return invalidData();
    return {
      ...base,
      grossSettlementMinor: null,
      refundImpactMinor: null,
      disputeImpactMinor: null,
      processingFeeImpactMinor: null,
      refundFeeImpactMinor: null,
      disputeFeeImpactMinor: null,
      otherFeeImpactMinor: null,
      estimatedPayoutMinor: null,
      settlementMetricsComplete: false,
      missingSourceCount: row.missingSourceCount,
      state: row.state
    };
  }
  if (
    row.settlementCurrency === null || row.missingSourceCount !== 0 ||
    (row.state !== 'fee_reconciled' && row.state !== 'payout_reconciled') ||
    row.grossSettlementMinor === null || row.refundImpactMinor === null ||
    row.disputeImpactMinor === null || row.processingFeeImpactMinor === null ||
    row.refundFeeImpactMinor === null || row.disputeFeeImpactMinor === null ||
    row.otherFeeImpactMinor === null || row.estimatedPayoutMinor === null
  ) return invalidData();
  if (estimate(row) !== row.estimatedPayoutMinor) return invalidData();
  return {
    ...base,
    settlementCurrency: row.settlementCurrency,
    grossSettlementMinor: row.grossSettlementMinor,
    refundImpactMinor: row.refundImpactMinor,
    disputeImpactMinor: row.disputeImpactMinor,
    processingFeeImpactMinor: row.processingFeeImpactMinor,
    refundFeeImpactMinor: row.refundFeeImpactMinor,
    disputeFeeImpactMinor: row.disputeFeeImpactMinor,
    otherFeeImpactMinor: row.otherFeeImpactMinor,
    estimatedPayoutMinor: row.estimatedPayoutMinor,
    settlementMetricsComplete: true,
    missingSourceCount: 0,
    state: row.state
  };
}

function normalizedFilters(filters: SalesOverviewFilters): SalesOverviewFilterDto {
  return {
    range: filters.range,
    from: filters.from?.toISOString() ?? null,
    to: filters.to?.toISOString() ?? null,
    titleId: filters.titleId ?? null,
    format: filters.format ?? null,
    presentmentCurrency: filters.presentmentCurrency ?? null,
    settlementCurrency: filters.settlementCurrency ?? null,
    state: filters.state ?? null,
    sort: filters.sort
  };
}

function cohortConditions(filters: SalesOverviewFilters): SQL {
  const conditions: SQL[] = [sql`orders.status = 'paid'`, sql`orders.paid_at is not null`];
  if (filters.from !== undefined) conditions.push(sql`orders.paid_at >= ${filters.from}`);
  if (filters.to !== undefined) conditions.push(sql`orders.paid_at < ${filters.to}`);
  if (filters.titleId !== undefined) conditions.push(sql`order_items.title_id = ${filters.titleId}`);
  if (filters.format !== undefined) conditions.push(sql`order_items.format = ${filters.format}`);
  if (filters.presentmentCurrency !== undefined) {
    conditions.push(sql`order_items.currency = ${filters.presentmentCurrency}`);
  }
  return sql.join(conditions, sql` and `);
}

function salesRowsRelation(filters: SalesOverviewFilters): SQL {
  return sql`
    cohort_items as materialized (
      select order_items.id as order_item_id, order_items.order_id,
        order_items.title_id, titles.title as current_title,
        titles.format as current_format, (titles.visibility = 'archived') as archived,
        order_items.title_snapshot, order_items.creator_name_snapshot,
        order_items.format as sold_format, order_items.currency as presentment_currency,
        order_items.unit_subtotal_minor, order_items.total_minor,
        orders.updated_at as order_updated_at, payments.id as payment_id,
        payments.stripe_latest_charge_id, payments.financial_evidence_status
      from orders
      join order_items on order_items.order_id = orders.id
      join titles on titles.id = order_items.title_id
      join payments on payments.order_id = orders.id and payments.status = 'succeeded'
      where ${cohortConditions(filters)}
    ), compatible_refund_tips as (
      select distinct allocation.source_internal_id as refund_id,
        head.compatible_correction_tip_id
      from current_financial_projection_heads head
      join financial_allocation_sets allocation on allocation.id = head.base_set_id
      where allocation.source_kind = 'refund' and head.basis = 'gross_amount'
        and head.compatible_correction_tip_id is not null
    ), effective_refund_presentment as (
      select component.refund_id, component.order_item_id,
        component.subtotal_minor::bigint as subtotal_minor
      from refund_allocation_components component
      join refunds on refunds.id = component.refund_id
        and refunds.status = 'succeeded' and refunds.allocation_status = 'finalized'
      left join compatible_refund_tips tip on tip.refund_id = component.refund_id
      where tip.compatible_correction_tip_id is null or not exists (
        select 1 from refund_reporting_correction_items correction
        where correction.correction_set_id = tip.compatible_correction_tip_id
          and correction.domain = 'presentment'
      )
      union all
      select refund.id, correction.order_item_id,
        correction.approved_absolute_minor::bigint
      from compatible_refund_tips tip
      join refunds refund on refund.id = tip.refund_id
        and refund.status = 'succeeded' and refund.allocation_status = 'finalized'
      join refund_reporting_correction_items correction
        on correction.correction_set_id = tip.compatible_correction_tip_id
        and correction.domain = 'presentment'
        and correction.component = 'refund_subtotal'
    ), refund_presentment_rollup as (
      select order_item_id, sum(subtotal_minor)::bigint as subtotal_minor
      from effective_refund_presentment group by order_item_id
    ), refunded_copy_rollup as (
      select allocation.order_item_id, sum(allocation.amount_minor)::bigint as refunded_total_minor
      from refund_allocations allocation
      join refunds on refunds.id = allocation.refund_id
        and refunds.status = 'succeeded' and refunds.allocation_status = 'finalized'
      group by allocation.order_item_id
    ), dispute_gross_tip_candidates as (
      select allocation.id,
        count(*) over (partition by allocation.balance_transaction_id) as tip_count
      from financial_allocation_sets allocation
      join financial_projection_versions active on active.singleton = true
        and allocation.classifier_version = active.classifier_version
        and allocation.algorithm_version = active.allocation_algorithm_version
      where allocation.source_kind = 'dispute' and allocation.basis = 'gross_amount'
        and not exists (
          select 1 from financial_allocation_sets successor
          where successor.supersedes_set_id = allocation.id
            and successor.classifier_version = allocation.classifier_version
            and successor.algorithm_version = allocation.algorithm_version
        )
    ), dispute_presentment_rollup as (
      select dispute_item_allocations.order_item_id,
        sum(case when dispute_item_allocations.effect = 'withdrawal'
          then -dispute_item_allocations.subtotal_effect_minor else 0 end)::bigint
          as withdrawal_minor,
        sum(case when dispute_item_allocations.effect = 'reinstatement'
          then dispute_item_allocations.subtotal_effect_minor else 0 end)::bigint
          as reinstatement_minor
      from dispute_item_allocations
      join dispute_gross_tip_candidates dispute_tip
        on dispute_tip.id = dispute_item_allocations.gross_allocation_set_id
        and dispute_tip.tip_count = 1
      group by dispute_item_allocations.order_item_id
    ), source_transactions as (
      select distinct 'payment'::text as source_kind, payment.id as source_internal_id,
        payment.order_id, payment.financial_evidence_status,
        balance.id as balance_transaction_id, balance.currency,
        balance.last_imported_at
      from (select distinct payment_id from cohort_items) cohort
      join payments payment on payment.id = cohort.payment_id
      left join stripe_balance_transactions balance
        on balance.source_family = 'charge'
        and balance.source_id = payment.stripe_latest_charge_id
      union all
      select 'refund', refund.id, payment.order_id, refund.financial_evidence_status,
        balance.id, balance.currency, balance.last_imported_at
      from refunds refund
      join payments payment on payment.id = refund.payment_id
      join (select distinct order_id from cohort_items) cohort on cohort.order_id = payment.order_id
      left join stripe_balance_transactions balance
        on balance.source_family = 'refund' and balance.source_id = refund.stripe_refund_id
      union all
      select 'dispute', dispute.id, payment.order_id, dispute.financial_evidence_status,
        balance.id, balance.currency, balance.last_imported_at
      from disputes dispute
      join payments payment on payment.id = dispute.payment_id
      join (select distinct order_id from cohort_items) cohort on cohort.order_id = payment.order_id
      left join stripe_balance_transactions balance
        on balance.source_family = 'dispute' and balance.source_id = dispute.stripe_dispute_id
    ), target_payouts as (
      select distinct membership.payout_id as id
      from source_transactions source
      join stripe_payout_balance_transactions membership
        on membership.balance_transaction_id = source.balance_transaction_id
    ), ${payoutMembershipCertificationCtes()}, source_payout_authority as (
      select source.source_kind, source.source_internal_id, source.balance_transaction_id,
        coalesce(bool_or(
          payout.id is not null and payout.automatic and payout.method = 'standard'
            and payout.status = 'paid' and payout.reconciliation_status = 'completed'
            and payout.reversed_by_provider_payout_id is null
            and certification.certified_generation = payout.financial_generation
        ), false) as is_payout_reconciled,
        coalesce(bool_or(
          payout.id is not null and (
            exists (
              select 1 from financial_reconciliation_issues issue
              where issue.resource_type = 'payout' and issue.resource_id = payout.id
                and issue.state = 'open' and issue.impact = 'exception'
            )
            or (payout.status in ('failed', 'canceled')
              and payout.failure_balance_transaction_id is null
              and payout.reversed_by_provider_payout_id is null)
            or (payout.reversed_by_provider_payout_id is not null and not exists (
              select 1 from stripe_payouts reversal
              where reversal.provider_id = payout.reversed_by_provider_payout_id
                and reversal.original_provider_payout_id = payout.provider_id
            ))
          )
        ), false) as has_payout_exception
      from source_transactions source
      left join stripe_payout_balance_transactions membership
        on membership.balance_transaction_id = source.balance_transaction_id
      left join stripe_payouts payout on payout.id = membership.payout_id
      left join certified_membership certification on certification.payout_id = payout.id
      group by source.source_kind, source.source_internal_id, source.balance_transaction_id
    ), source_health as (
      select source.source_kind, source.source_internal_id, source.order_id,
        source.balance_transaction_id, source.last_imported_at,
        count(head.balance_transaction_id) filter (
          where head.scope is distinct from 'account'
        ) > 0 as has_title_relevance,
        count(head.balance_transaction_id) = 2 and
          count(head.balance_transaction_id) filter (
            where head.scope is distinct from 'account'
          ) = 0 as is_proven_account_only,
        case when source.balance_transaction_id is not null
          and source.financial_evidence_status = 'fee_reconciled'
          and count(head.balance_transaction_id) = 2
          and count(head.balance_transaction_id) filter (
            where head.scope is distinct from 'account'
          ) > 0
          and coalesce(bool_and(head.is_complete) filter (
            where head.scope is distinct from 'account'
          ), false)
          and coalesce(bool_and(head.currency = source.currency) filter (
            where head.scope is distinct from 'account'
          ), false)
        then true else false end as attribution_is_complete,
        case when source.balance_transaction_id is not null
          and source.financial_evidence_status = 'fee_reconciled'
          and count(head.balance_transaction_id) = 2
          and count(head.balance_transaction_id) filter (
            where head.scope is distinct from 'account'
          ) > 0
          and coalesce(bool_and(head.is_complete) filter (
            where head.scope is distinct from 'account'
          ), false)
          and coalesce(bool_and(head.currency = source.currency) filter (
            where head.scope is distinct from 'account'
          ), false)
          and not payout_authority.has_payout_exception
          and not (source.source_kind = 'payment'
            and coalesce(bool_or(head.scope = 'account'), false))
        then true else false end as is_complete,
        bool_or(
          head.basis = 'fee' and head.scope = 'title'
            and head.expected_effect_minor <> 0
        ) as requires_payment_fee_item,
        case when source.balance_transaction_id is not null
          and count(head.balance_transaction_id) filter (
            where head.scope is distinct from 'account'
          ) > 0
          and count(*) filter (
            where head.scope is distinct from 'account'
              and head.currency is not null and head.currency <> source.currency
          ) = 0 then source.currency else null end as settlement_currency,
        case when source.balance_transaction_id is null then 1
          else greatest(
            coalesce(sum(head.missing_source_count) filter (
              where head.scope is distinct from 'account'
            ), 0)::integer,
            case when source.financial_evidence_status = 'fee_reconciled' then 0 else 1 end,
            case when source.source_kind = 'payment'
              and count(head.balance_transaction_id) filter (
                where head.scope is distinct from 'account'
              ) = 0 then 1 else 0 end,
            case when source.source_kind = 'payment'
              and coalesce(bool_or(head.scope = 'account'), false) then 1 else 0 end
          ) + case when payout_authority.has_payout_exception then 1 else 0 end
        end as missing_source_count,
        case
          when source.financial_evidence_status = 'exception'
            or payout_authority.has_payout_exception
            or (source.source_kind = 'payment'
              and source.balance_transaction_id is not null
              and count(head.balance_transaction_id) filter (
                where head.scope is distinct from 'account'
              ) = 0)
            or (source.source_kind = 'payment'
              and coalesce(bool_or(head.scope = 'account'), false))
            or coalesce(bool_or(coalesce(head.proposed_issue_code not in (
              'missing_source', 'allocation_incomplete'
            ), false)) filter (
              where head.scope is distinct from 'account'
            ), false) then 3
          when source.balance_transaction_id is null
            or source.financial_evidence_status = 'pending'
            or count(head.balance_transaction_id) <> 2
            or not coalesce(bool_and(head.is_complete) filter (
              where head.scope is distinct from 'account'
            ), false) then 2
          when payout_authority.is_payout_reconciled then 0
          else 1
        end as state_rank
      from source_transactions source
      join source_payout_authority payout_authority
        on payout_authority.source_kind = source.source_kind
        and payout_authority.source_internal_id = source.source_internal_id
        and payout_authority.balance_transaction_id is not distinct from
          source.balance_transaction_id
      left join current_financial_projection_heads head
        on head.balance_transaction_id = source.balance_transaction_id
      group by source.source_kind, source.source_internal_id, source.order_id,
        source.balance_transaction_id, source.last_imported_at,
        source.financial_evidence_status, source.currency,
        payout_authority.is_payout_reconciled, payout_authority.has_payout_exception
    ), source_item_effects as (
      select source.source_internal_id, source.source_kind,
        source.balance_transaction_id, item.order_item_id,
        coalesce(sum(projection.effect_minor) filter (
          where projection.component = 'sale_subtotal'
        ), 0)::bigint as gross_settlement_minor,
        coalesce(sum(projection.effect_minor) filter (
          where projection.component in ('refund_subtotal', 'refund_failure_reversal')
        ), 0)::bigint as refund_impact_minor,
        coalesce(sum(projection.effect_minor) filter (
          where projection.component in ('dispute_subtotal', 'dispute_reinstatement')
        ), 0)::bigint as dispute_impact_minor,
        coalesce(sum(projection.effect_minor) filter (
          where projection.component = 'processing_fee'
            or (source.source_kind = 'payment'
              and projection.component in ('provider_fee_tax', 'fee_credit'))
        ), 0)::bigint as processing_fee_impact_minor,
        coalesce(sum(projection.effect_minor) filter (
          where projection.component = 'refund_fee'
            or (source.source_kind = 'refund'
              and projection.component in ('provider_fee_tax', 'fee_credit'))
        ), 0)::bigint as refund_fee_impact_minor,
        coalesce(sum(projection.effect_minor) filter (
          where projection.component = 'dispute_fee'
            or (source.source_kind = 'dispute'
              and projection.component in ('provider_fee_tax', 'fee_credit'))
        ), 0)::bigint as dispute_fee_impact_minor,
        coalesce(sum(projection.effect_minor) filter (
          where projection.component = 'other'
        ), 0)::bigint as other_fee_impact_minor,
        count(projection.order_item_id)::integer as effect_count,
        count(*) filter (
          where projection.component = 'sale_subtotal'
        )::integer as sale_subtotal_effect_count,
        count(*) filter (
          where projection.basis = 'fee'
        )::integer as fee_basis_effect_count,
        count(distinct projection.basis) filter (
          where projection.order_item_id is not null and (
            (projection.component = 'dispute_reinstatement'
              and projection_set.algorithm_version is distinct from 2)
            or not (
              (projection.basis = 'gross_amount' and projection.component in (
                'sale_subtotal', 'sale_tax', 'refund_subtotal', 'refund_tax',
                'refund_failure_reversal', 'dispute_subtotal', 'dispute_tax',
                'dispute_reinstatement', 'fee_credit'
              ))
              or (projection.basis = 'fee' and projection.component in (
                'processing_fee', 'refund_fee', 'dispute_fee',
                'provider_fee_tax', 'fee_credit', 'other'
              ))
            )
            or not (
              (source.source_kind = 'payment' and projection.component in (
                'sale_subtotal', 'sale_tax', 'processing_fee',
                'provider_fee_tax', 'fee_credit', 'other'
              ))
              or (source.source_kind = 'refund' and projection.component in (
                'refund_subtotal', 'refund_tax', 'refund_fee',
                'refund_failure_reversal', 'provider_fee_tax', 'fee_credit', 'other'
              ))
              or (source.source_kind = 'dispute' and projection.component in (
                'dispute_subtotal', 'dispute_tax', 'dispute_fee',
                'dispute_reinstatement', 'provider_fee_tax', 'fee_credit', 'other'
              ))
            )
          )
        )::integer as incompatible_effect_source_count
      from source_health source
      join cohort_items item on item.order_id = source.order_id
      left join current_financial_projection_items projection
        on projection.balance_transaction_id = source.balance_transaction_id
        and projection.order_item_id = item.order_item_id
      left join financial_allocation_sets projection_set
        on projection_set.id = projection.base_set_id
      where source.source_kind = 'payment' or (
        not source.is_proven_account_only and (
          not source.attribution_is_complete or projection.order_item_id is not null
        )
      )
      group by source.source_internal_id, source.source_kind,
        source.balance_transaction_id, item.order_item_id
    ), item_financial as (
      select item.order_item_id,
        case when count(*) filter (where health.settlement_currency is null) = 0
          and min(health.settlement_currency) is not distinct from max(health.settlement_currency)
          then min(health.settlement_currency) else null end as settlement_currency,
        bool_and(health.is_complete and (
          health.source_kind <> 'payment' or (
            effect.sale_subtotal_effect_count > 0 and (
              not health.requires_payment_fee_item or effect.fee_basis_effect_count > 0
            )
          )
        ) and effect.incompatible_effect_source_count = 0)
          and count(*) filter (where health.settlement_currency is null) = 0
          and min(health.settlement_currency) is not distinct from max(health.settlement_currency)
          as settlement_metrics_complete,
        sum(health.missing_source_count)::bigint +
          count(*) filter (
            where health.is_complete and health.source_kind = 'payment'
              and effect.sale_subtotal_effect_count = 0
          )::bigint +
          count(*) filter (
            where health.is_complete and health.source_kind = 'payment'
              and health.requires_payment_fee_item and effect.fee_basis_effect_count = 0
          )::bigint +
          sum(effect.incompatible_effect_source_count)::bigint +
          case when min(health.settlement_currency) is distinct from max(health.settlement_currency)
            then 1 else 0 end as missing_source_count,
        greatest(max(health.state_rank),
          case when bool_or(
            health.is_complete and health.source_kind = 'payment'
              and (effect.sale_subtotal_effect_count = 0 or (
                health.requires_payment_fee_item and effect.fee_basis_effect_count = 0
              ))
          ) then 2 else 0 end,
          case when bool_or(effect.incompatible_effect_source_count > 0)
            then 3 else 0 end,
          case when min(health.settlement_currency) is distinct from max(health.settlement_currency)
            then 3 else 0 end) as state_rank,
        sum(effect.gross_settlement_minor)::bigint as gross_settlement_minor,
        sum(effect.refund_impact_minor)::bigint as refund_impact_minor,
        sum(effect.dispute_impact_minor)::bigint as dispute_impact_minor,
        sum(effect.processing_fee_impact_minor)::bigint as processing_fee_impact_minor,
        sum(effect.refund_fee_impact_minor)::bigint as refund_fee_impact_minor,
        sum(effect.dispute_fee_impact_minor)::bigint as dispute_fee_impact_minor,
        sum(effect.other_fee_impact_minor)::bigint as other_fee_impact_minor,
        max(coalesce(health.last_imported_at, item.order_updated_at)) as freshness_at
      from cohort_items item
      join source_health health on health.order_id = item.order_id
      join source_item_effects effect
        on effect.source_internal_id = health.source_internal_id
        and effect.source_kind = health.source_kind
        and effect.balance_transaction_id is not distinct from health.balance_transaction_id
        and effect.order_item_id = item.order_item_id
      group by item.order_item_id
    ), item_rows as (
      select item.title_id, item.current_title, item.current_format, item.archived,
        item.presentment_currency, financial.settlement_currency,
        item.title_snapshot, item.creator_name_snapshot, item.sold_format,
        item.order_item_id, item.unit_subtotal_minor, item.total_minor,
        coalesce(copy.refunded_total_minor, 0) as refunded_total_minor,
        coalesce(refund.subtotal_minor, 0) as refund_subtotal_minor,
        coalesce(dispute.withdrawal_minor, 0) as dispute_withdrawal_minor,
        coalesce(dispute.reinstatement_minor, 0) as dispute_reinstatement_minor,
        financial.settlement_metrics_complete, financial.missing_source_count,
        financial.state_rank, financial.gross_settlement_minor,
        financial.refund_impact_minor, financial.dispute_impact_minor,
        financial.processing_fee_impact_minor, financial.refund_fee_impact_minor,
        financial.dispute_fee_impact_minor, financial.other_fee_impact_minor,
        financial.freshness_at
      from cohort_items item
      join item_financial financial on financial.order_item_id = item.order_item_id
      left join refunded_copy_rollup copy on copy.order_item_id = item.order_item_id
      left join refund_presentment_rollup refund on refund.order_item_id = item.order_item_id
      left join dispute_presentment_rollup dispute on dispute.order_item_id = item.order_item_id
    ), sold_variants as (
      select variant.title_id, variant.presentment_currency, variant.settlement_currency,
        jsonb_agg(jsonb_build_object(
          'title', variant.title_snapshot,
          'creatorName', variant.creator_name_snapshot,
          'format', variant.sold_format
        ) order by variant.title_snapshot collate "C",
          variant.creator_name_snapshot collate "C", variant.sold_format) as variants
      from (
        select distinct title_id, presentment_currency, settlement_currency,
          title_snapshot, creator_name_snapshot, sold_format
        from item_rows
      ) variant
      group by variant.title_id, variant.presentment_currency, variant.settlement_currency
    ), sales_rows as (
      select item.title_id, max(item.current_title) as current_title,
        max(item.current_format::text) as format, bool_or(item.archived) as archived,
        variant.variants as sold_as_variants, item.presentment_currency,
        item.settlement_currency, count(*)::bigint as sold_copies,
        count(*) filter (where item.refunded_total_minor = item.total_minor)::bigint
          as fully_refunded_copies,
        (count(*) - count(*) filter (
          where item.refunded_total_minor = item.total_minor
        ))::bigint as net_copies,
        sum(item.unit_subtotal_minor)::bigint as gross_presentment_minor,
        sum(item.refund_subtotal_minor)::bigint as finalized_refund_presentment_minor,
        sum(item.dispute_withdrawal_minor)::bigint as dispute_withdrawal_presentment_minor,
        sum(item.dispute_reinstatement_minor)::bigint as dispute_reinstatement_presentment_minor,
        bool_and(item.settlement_metrics_complete)
          and not bool_or(item.refunded_total_minor > item.total_minor)
          as settlement_metrics_complete,
        sum(item.missing_source_count)::bigint + count(*) filter (
          where item.refunded_total_minor > item.total_minor
        )::bigint as missing_source_count,
        greatest(max(item.state_rank), case when bool_or(
          item.refunded_total_minor > item.total_minor
        ) then 3 else 0 end) as state_rank,
        sum(item.gross_settlement_minor)::bigint as gross_settlement_minor,
        sum(item.refund_impact_minor)::bigint as refund_impact_minor,
        sum(item.dispute_impact_minor)::bigint as dispute_impact_minor,
        sum(item.processing_fee_impact_minor)::bigint as processing_fee_impact_minor,
        sum(item.refund_fee_impact_minor)::bigint as refund_fee_impact_minor,
        sum(item.dispute_fee_impact_minor)::bigint as dispute_fee_impact_minor,
        sum(item.other_fee_impact_minor)::bigint as other_fee_impact_minor,
        max(item.freshness_at) as freshness_at
      from item_rows item
      join sold_variants variant on variant.title_id = item.title_id
        and variant.presentment_currency = item.presentment_currency
        and variant.settlement_currency is not distinct from item.settlement_currency
      group by item.title_id, variant.variants, item.presentment_currency,
        item.settlement_currency
    )
  `;
}

function outputFilters(filters: SalesOverviewFilters): SQL {
  const conditions: SQL[] = [];
  if (filters.settlementCurrency === 'pending') {
    conditions.push(sql`sales_rows.settlement_currency is null`);
  } else if (filters.settlementCurrency !== undefined) {
    conditions.push(sql`sales_rows.settlement_currency = ${filters.settlementCurrency}`);
  }
  if (filters.state !== undefined) {
    const rank = { payout_reconciled: 0, fee_reconciled: 1, pending: 2, exception: 3 }[
      filters.state
    ];
    conditions.push(sql`sales_rows.state_rank = ${rank}`);
  }
  return conditions.length === 0 ? sql`true` : sql.join(conditions, sql` and `);
}

function cursorCondition(filters: SalesOverviewFilters): SQL {
  const cursor = filters.cursor;
  if (cursor === undefined) return sql`true`;
  const tail = sql`(
    sales_rows.title_id, sales_rows.presentment_currency,
    coalesce(sales_rows.settlement_currency, '')
  ) > (${cursor.titleId}::uuid, ${cursor.presentmentCurrency}, ${cursor.settlementCurrency})`;
  if (filters.sort === 'gross_desc') {
    return sql`(
      sales_rows.gross_presentment_minor < ${cursor.primary as number}
      or (sales_rows.gross_presentment_minor = ${cursor.primary as number} and ${tail})
    )`;
  }
  return sql`(
    sales_rows.current_title collate "C" > ${cursor.primary as string}
    or (sales_rows.current_title collate "C" = ${cursor.primary as string} and ${tail})
  )`;
}

function rowColumns(): SQL {
  return sql`
    sales_rows.title_id as "titleId", sales_rows.current_title as "currentTitle",
    sales_rows.format, sales_rows.archived, sales_rows.sold_as_variants as "soldAsVariants",
    sales_rows.presentment_currency as "presentmentCurrency",
    sales_rows.settlement_currency as "settlementCurrency",
    sales_rows.sold_copies::text as "soldCopies",
    sales_rows.fully_refunded_copies::text as "fullyRefundedCopies",
    sales_rows.net_copies::text as "netCopies",
    sales_rows.gross_presentment_minor::text as "grossPresentmentMinor",
    sales_rows.finalized_refund_presentment_minor::text as "finalizedRefundPresentmentMinor",
    sales_rows.dispute_withdrawal_presentment_minor::text as "disputeWithdrawalPresentmentMinor",
    sales_rows.dispute_reinstatement_presentment_minor::text as "disputeReinstatementPresentmentMinor",
    case when sales_rows.settlement_metrics_complete
      then sales_rows.gross_settlement_minor::text else null end as "grossSettlementMinor",
    case when sales_rows.settlement_metrics_complete
      then sales_rows.refund_impact_minor::text else null end as "refundImpactMinor",
    case when sales_rows.settlement_metrics_complete
      then sales_rows.dispute_impact_minor::text else null end as "disputeImpactMinor",
    case when sales_rows.settlement_metrics_complete
      then sales_rows.processing_fee_impact_minor::text else null end as "processingFeeImpactMinor",
    case when sales_rows.settlement_metrics_complete
      then sales_rows.refund_fee_impact_minor::text else null end as "refundFeeImpactMinor",
    case when sales_rows.settlement_metrics_complete
      then sales_rows.dispute_fee_impact_minor::text else null end as "disputeFeeImpactMinor",
    case when sales_rows.settlement_metrics_complete
      then sales_rows.other_fee_impact_minor::text else null end as "otherFeeImpactMinor",
    case when sales_rows.settlement_metrics_complete then (
      sales_rows.gross_settlement_minor + sales_rows.refund_impact_minor +
      sales_rows.dispute_impact_minor + sales_rows.processing_fee_impact_minor +
      sales_rows.refund_fee_impact_minor + sales_rows.dispute_fee_impact_minor +
      sales_rows.other_fee_impact_minor
    )::text else null end as "estimatedPayoutMinor",
    sales_rows.settlement_metrics_complete as "settlementMetricsComplete",
    sales_rows.missing_source_count::text as "missingSourceCount",
    case sales_rows.state_rank when 3 then 'exception' when 2 then 'pending'
      when 1 then 'fee_reconciled' else 'payout_reconciled' end as state,
    sales_rows.freshness_at as "freshnessAt"
  `;
}

function rowOrder(filters: SalesOverviewFilters): SQL {
  return filters.sort === 'gross_desc'
    ? sql`sales_rows.gross_presentment_minor desc, sales_rows.title_id asc,
        sales_rows.presentment_currency asc, coalesce(sales_rows.settlement_currency, '') asc`
    : sql`sales_rows.current_title collate "C" asc, sales_rows.title_id asc,
        sales_rows.presentment_currency asc, coalesce(sales_rows.settlement_currency, '') asc`;
}

function aggregateRowsQuery(
  filters: SalesOverviewFilters,
  options: SalesAggregateRowsOptions
): SQL {
  return sql`
    with ${salesRowsRelation(filters)}
    select ${rowColumns()}
    from sales_rows
    where ${outputFilters(filters)} and ${options.applyCursor ? cursorCondition(filters) : sql`true`}
    order by ${rowOrder(filters)}
    limit ${options.limit}
  `;
}

export async function loadSalesAggregateRows(
  transaction: DatabaseTransaction,
  filters: SalesOverviewFilters,
  options: SalesAggregateRowsOptions
): Promise<readonly TitleSalesRowDto[]> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 10_001) {
    return invalidData();
  }
  const rawRows = queryRows(await transaction.execute(aggregateRowsQuery(filters, options)));
  if (rawRows.length > options.limit) return invalidData();
  return rawRows.map(parseRow);
}

function summaryQuery(filters: SalesOverviewFilters): SQL {
  return sql`
    with ${salesRowsRelation(filters)}, filtered_sales_rows as (
      select * from sales_rows where ${outputFilters(filters)}
    )
    select presentment_currency as "presentmentCurrency",
      settlement_currency as "settlementCurrency",
      count(distinct title_id)::text as "titleCount",
      sum(sold_copies)::text as "soldCopies",
      sum(fully_refunded_copies)::text as "fullyRefundedCopies",
      sum(net_copies)::text as "netCopies",
      sum(gross_presentment_minor)::text as "grossPresentmentMinor",
      sum(finalized_refund_presentment_minor)::text as "finalizedRefundPresentmentMinor",
      sum(dispute_withdrawal_presentment_minor)::text as "disputeWithdrawalPresentmentMinor",
      sum(dispute_reinstatement_presentment_minor)::text as "disputeReinstatementPresentmentMinor",
      case when bool_and(settlement_metrics_complete)
        then sum(gross_settlement_minor)::text else null end as "grossSettlementMinor",
      case when bool_and(settlement_metrics_complete)
        then sum(refund_impact_minor)::text else null end as "refundImpactMinor",
      case when bool_and(settlement_metrics_complete)
        then sum(dispute_impact_minor)::text else null end as "disputeImpactMinor",
      case when bool_and(settlement_metrics_complete)
        then sum(processing_fee_impact_minor)::text else null end as "processingFeeImpactMinor",
      case when bool_and(settlement_metrics_complete)
        then sum(refund_fee_impact_minor)::text else null end as "refundFeeImpactMinor",
      case when bool_and(settlement_metrics_complete)
        then sum(dispute_fee_impact_minor)::text else null end as "disputeFeeImpactMinor",
      case when bool_and(settlement_metrics_complete)
        then sum(other_fee_impact_minor)::text else null end as "otherFeeImpactMinor",
      case when bool_and(settlement_metrics_complete) then (
        sum(gross_settlement_minor) + sum(refund_impact_minor) +
        sum(dispute_impact_minor) + sum(processing_fee_impact_minor) +
        sum(refund_fee_impact_minor) + sum(dispute_fee_impact_minor) +
        sum(other_fee_impact_minor)
      )::text else null end as "estimatedPayoutMinor",
      bool_and(settlement_metrics_complete) as "settlementMetricsComplete",
      sum(missing_source_count)::text as "missingSourceCount",
      case max(state_rank) when 3 then 'exception' when 2 then 'pending'
        when 1 then 'fee_reconciled' else 'payout_reconciled' end as state
    from filtered_sales_rows
    group by presentment_currency, settlement_currency
    order by presentment_currency collate "C", coalesce(settlement_currency, '') collate "C"
  `;
}

function reviewCountQuery(): SQL {
  return sql`
    select count(*)::text as "needsReviewCount"
    from ${financialReconciliationIssues}
    where ${currentOperationalFinancialIssuePredicate()}
  `;
}

function freshnessQuery(): SQL {
  return sql`
    select (
      select max(scan.completed_at) from financial_scan_runs scan
      where scan.state = 'completed'
        and scan.kind in ('initial_backfill', 'hourly')
        and scan.phase = 'incomplete_payout_run_page'
    ) as "sourceCompletedAt", (
      select case when discovery.covered_through is null then null else discovery.updated_at end
      from financial_payout_discovery_state discovery where discovery.singleton = true
    ) as "payoutCompletedAt", (
      select max(scan.completed_at)
      from financial_scan_runs scan
      join financial_projection_versions active on active.singleton = true
      where scan.state = 'completed' and scan.kind = 'classification_replay'
        and scan.phase = 'classification_replay_finalize'
        and scan.classifier_version = active.classifier_version
        and scan.allocation_algorithm_version = active.allocation_algorithm_version
        and scan.replay_id = 'c' || active.classifier_version::text ||
          '-a' || active.allocation_algorithm_version::text
    ) as "projectionCompletedAt"
  `;
}

function dataThroughAt(value: unknown): string | null {
  const parsed = freshnessSchema.safeParse(value);
  if (!parsed.success) return invalidData();
  const timestamps = [
    parsed.data.sourceCompletedAt,
    parsed.data.payoutCompletedAt,
    parsed.data.projectionCompletedAt
  ];
  if (timestamps.some((timestamp) => timestamp === null)) return null;
  return timestamps.reduce((earliest, timestamp) =>
    timestamp! < earliest! ? timestamp : earliest
  )!;
}

export async function loadSalesDataThroughAt(
  transaction: DatabaseTransaction
): Promise<string | null> {
  const rawFreshness = queryRows(await transaction.execute(freshnessQuery()));
  if (rawFreshness.length !== 1) return invalidData();
  return dataThroughAt(rawFreshness[0]);
}

export function canExportSalesOverview(
  actor: Actor,
  dependencies: FinancialAuthorizationDependencies = {}
): boolean {
  if (actor.type !== 'user') return false;
  const resolveCapabilities = dependencies.capabilityResolver ?? capabilitiesForRoles;
  const capabilities = resolveCapabilities(actor.roles);
  return capabilities.has('sales.read') && capabilities.has('sales.export');
}

function sumMissingSources(summaries: readonly SalesCurrencySummaryDto[]): number {
  return summaries.reduce((total, summary) => safeAdd(total, summary.missingSourceCount), 0);
}

export async function listSalesOverview(
  database: Database,
  actor: Actor,
  filters: SalesOverviewFilters,
  dependencies: SalesOverviewDependencies = {}
): Promise<SalesOverviewDto> {
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  const stripeEnabled = dependencies.stripeEnabled ??
    (await import('$lib/server/config')).getApplicationConfig().stripe.enabled;
  const result = await database.transaction(async (transaction) => {
    const parsedPage = await loadSalesAggregateRows(transaction, filters, {
      applyCursor: true,
      limit: filters.pageSize + 1
    });
    const rows = parsedPage.slice(0, filters.pageSize);
    const summaryRows = queryRows(await transaction.execute(summaryQuery(filters))).map(parseSummary);
    const rawReview = queryRows(await transaction.execute(reviewCountQuery()));
    if (rawReview.length !== 1) return invalidData();
    const review = reviewCountSchema.safeParse(rawReview[0]);
    if (!review.success) return invalidData();
    const freshness = await loadSalesDataThroughAt(transaction);

    const nextCursor = parsedPage.length > filters.pageSize
      ? encodeSalesCursor({
          filterFingerprint: fingerprintSalesFilters(filters),
          primary: filters.sort === 'gross_desc'
            ? rows.at(-1)!.grossPresentmentMinor
            : rows.at(-1)!.currentTitle,
          titleId: rows.at(-1)!.titleId,
          presentmentCurrency: rows.at(-1)!.presentmentCurrency,
          settlementCurrency: rows.at(-1)!.settlementCurrency ?? ''
        })
      : null;
    return {
      rows,
      summaries: summaryRows,
      nextCursor,
      dataThroughAt: freshness,
      missingSourceCount: sumMissingSources(summaryRows),
      needsReviewCount: review.data.needsReviewCount
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });

  return {
    filters: normalizedFilters(filters),
    rows: result.rows,
    summaries: result.summaries,
    nextCursor: result.nextCursor,
    dataThroughAt: result.dataThroughAt,
    stripeEnabled,
    missingSourceCount: result.missingSourceCount,
    needsReviewCount: result.needsReviewCount
  };
}
