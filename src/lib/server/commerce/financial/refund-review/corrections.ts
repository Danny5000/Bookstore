import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  requireCapability,
  type Actor,
  type FinancialAuthorizationDependencies
} from '$lib/server/auth/admin-policy';
import { listRolesForUser } from '$lib/server/auth/identity';
import { appendAuditEvent } from '$lib/server/audit/service';
import { CommerceConflictError, PermanentCommerceError } from '$lib/server/commerce/errors';
import type { FinancialAdminPrivateCommand } from
  '$lib/server/commerce/financial/admin-commands/contracts';
import {
  FinancialAdminConflictError,
  FinancialAdminPermanentError
} from '$lib/server/commerce/financial/admin-commands/errors';
import type { FinancialAdminCommandExecutorContext } from
  '$lib/server/commerce/financial/admin-commands/handler';
import {
  FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  FINANCIAL_CLASSIFIER_VERSION
} from '$lib/server/commerce/financial/constants';
import { PermanentFinancialError, RetryableFinancialError } from
  '$lib/server/commerce/financial/errors';
import { lockFinancialProjectionRows } from '$lib/server/commerce/financial/locks';
import {
  loadFinancialProjectionAuthority,
  lockFinancialProjectionAuthority,
  lockFinancialProjectionEnrollment,
  type FinancialProjectionAuthority
} from '$lib/server/commerce/financial/projection-authority';
import * as refundFinancialProjection from '$lib/server/commerce/financial/sources/refund';
import type {
  FinancialComponent,
  FinancialIssueCode,
  LockedRefundProjectionInput
} from '$lib/server/commerce/financial/types';
import { lockOrder } from '$lib/server/commerce/lock';
import {
  lockPaymentPurchaseFacts,
  type PaymentPurchaseFacts
} from '$lib/server/commerce/reconciliation';
import type { FinancialRequestContext } from '$lib/server/commerce/reporting/context';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type {
  FinancialAdminCommandSafeResultByCode,
  RefundReportingCorrectionPreviewDto,
  RefundReportingCorrectionSeedDto
} from '$lib/types/financial-reporting';
import {
  planRefundReportingCorrection,
  type RefundReportingCorrectionPlanInput,
  type RefundReportingCorrectionPersistableItem
} from './correction-plan';
import type { ReportingCorrectionPrepareInput } from './inputs';

const SAFE_MONEY_MAX = 99_999_999;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_ITEMS = 25;
const MAX_REFUND_CLOSURE = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const postgresTimestampPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/u;

const ISSUE_CODES = [
  'allocation_fork',
  'allocation_incomplete',
  'allocation_mismatch',
  'classification_fork',
  'correction_rebase_required',
  'currency_mismatch',
  'immutable_mismatch',
  'missing_source',
  'source_linkage_mismatch'
] as const satisfies readonly FinancialIssueCode[];

const canonicalUuidSchema = z.string().regex(UUID_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const currencySchema = z.string().regex(CURRENCY_PATTERN);
const moneySchema = z.number().int().min(0).max(SAFE_MONEY_MAX);
const signedMoneySchema = z.number().int().min(-SAFE_MONEY_MAX).max(SAFE_MONEY_MAX);
const positiveVersionSchema = z.number().int().min(1).max(POSTGRES_INTEGER_MAX);
const countSchema = z.number().int().min(0).max(POSTGRES_INTEGER_MAX);

function timestampDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  let normalized = value.replace(' ', 'T');
  normalized = normalized.replace(/([+-][0-9]{2})$/u, '$1:00');
  normalized = normalized.replace(/([+-][0-9]{2})([0-9]{2})$/u, '$1:$2');
  return new Date(normalized);
}

const timestampSchema = z.union([
  z.date(),
  z.string().regex(postgresTimestampPattern)
]).refine((value) => Number.isFinite(timestampDate(value).getTime()))
  .transform((value) => timestampDate(value));

const routingSchema = z.strictObject({
  paymentId: canonicalUuidSchema,
  orderId: canonicalUuidSchema
});

const lockedOrderSchema = z.strictObject({
  id: canonicalUuidSchema,
  status: z.enum([
    'checkout_pending', 'checkout_open', 'payment_pending', 'paid', 'expired',
    'failed', 'exception'
  ]),
  currency: currencySchema,
  totalMinor: moneySchema.nullable(),
  paidAt: timestampSchema.nullable()
});

const lockedPaymentSchema = z.strictObject({
  id: canonicalUuidSchema,
  orderId: canonicalUuidSchema,
  status: z.enum(['pending', 'succeeded', 'failed']),
  amountMinor: moneySchema,
  currency: currencySchema,
  paidAt: timestampSchema.nullable()
});

const planningRootSchema = z.strictObject({
  refundId: canonicalUuidSchema,
  paymentId: canonicalUuidSchema,
  orderId: canonicalUuidSchema,
  stripeRefundId: z.string().min(1).max(255),
  refundStatus: z.enum(['pending', 'succeeded', 'failed', 'canceled']),
  allocationStatus: z.enum([
    'not_applicable', 'needs_review', 'draft', 'finalized', 'exception'
  ]),
  financialEvidenceStatus: z.enum(['pending', 'fee_reconciled', 'exception']),
  amountMinor: moneySchema.min(1),
  currency: currencySchema,
  targetBalanceCount: countSchema,
  targetBalanceTransactionId: canonicalUuidSchema.nullable(),
  grossBaseCount: countSchema,
  grossAllocationSetId: canonicalUuidSchema.nullable(),
  feeBaseCount: countSchema,
  feeAllocationSetId: canonicalUuidSchema.nullable(),
  sourceFingerprint: sha256Schema.nullable(),
  settlementCurrency: currencySchema.nullable(),
  currentHeadCount: countSchema,
  currentReportingComplete: z.boolean(),
  currentHeadIssueCodes: z.array(z.string().min(1).max(100)).max(20),
  rawTipCount: countSchema,
  rawTipId: canonicalUuidSchema.nullable(),
  rawTipCorrectionVersion: positiveVersionSchema.nullable(),
  rawTipBaseAllocationSetId: canonicalUuidSchema.nullable(),
  rawTipSourceFingerprint: sha256Schema.nullable(),
  compatibleTipCount: countSchema,
  compatibleTipHeadCount: countSchema,
  compatibleTipId: canonicalUuidSchema.nullable(),
  compatibleTipCorrectionVersion: positiveVersionSchema.nullable()
});

const planningItemSchema = z.strictObject({
  orderItemId: canonicalUuidSchema,
  titleId: canonicalUuidSchema,
  soldAsTitle: z.string().min(1).max(500),
  paidSubtotalMinor: moneySchema,
  paidTaxMinor: moneySchema,
  paidTotalMinor: moneySchema,
  effectiveSiblingSubtotalMinor: moneySchema,
  effectiveSiblingTaxMinor: moneySchema,
  immutablePresentmentSubtotalMinor: moneySchema,
  immutablePresentmentTaxMinor: moneySchema,
  immutableSettlementSubtotalMinor: signedMoneySchema.nullable(),
  immutableSettlementTaxMinor: signedMoneySchema.nullable(),
  immutableRefundFeeImpactMinor: signedMoneySchema.nullable(),
  compatiblePresentmentSubtotalMinor: moneySchema.nullable(),
  compatiblePresentmentTaxMinor: moneySchema.nullable(),
  compatibleSettlementSubtotalMinor: signedMoneySchema.nullable(),
  compatibleSettlementTaxMinor: signedMoneySchema.nullable(),
  compatibleRefundFeeImpactMinor: signedMoneySchema.nullable()
});

const financialComponentSchema = z.enum([
  'sale_subtotal', 'sale_tax', 'processing_fee', 'refund_subtotal', 'refund_tax',
  'refund_fee', 'refund_failure_reversal', 'dispute_subtotal', 'dispute_tax',
  'dispute_fee', 'dispute_reinstatement', 'provider_fee_tax', 'fee_credit', 'other'
] satisfies readonly FinancialComponent[]);

const feeComponentSchema = z.strictObject({
  component: financialComponentSchema,
  amountMinor: signedMoneySchema,
  currency: currencySchema
});

const balanceRowSchema = z.strictObject({
  id: canonicalUuidSchema,
  fingerprintSha256: sha256Schema
});

const payoutMembershipSchema = z.strictObject({
  payoutId: canonicalUuidSchema,
  expectedGeneration: z.number().int().min(0).max(POSTGRES_INTEGER_MAX),
  balanceTransactionId: canonicalUuidSchema
});

const selectedTipSchema = z.strictObject({
  id: canonicalUuidSchema,
  balanceTransactionId: canonicalUuidSchema,
  basis: z.enum(['gross_amount', 'fee']),
  sourceFingerprintSha256: sha256Schema
});

const projectionHeadSchema = z.strictObject({
  balanceTransactionId: canonicalUuidSchema,
  basis: z.enum(['gross_amount', 'fee']),
  baseSetId: canonicalUuidSchema.nullable(),
  compatibleCorrectionTipId: canonicalUuidSchema.nullable(),
  isComplete: z.boolean(),
  proposedIssueCode: z.string().min(1).max(100).nullable()
});

const writeIdSchema = z.strictObject({ id: canonicalUuidSchema });
const postHeadSchema = z.strictObject({
  basis: z.enum(['gross_amount', 'fee']),
  rawTipCount: countSchema,
  rawTipId: canonicalUuidSchema.nullable(),
  baseSetId: canonicalUuidSchema.nullable(),
  compatibleCorrectionTipId: canonicalUuidSchema.nullable(),
  isComplete: z.boolean()
});

type PlanningRoot = z.output<typeof planningRootSchema>;
type PlanningItem = z.output<typeof planningItemSchema>;
type ActiveFeeComponent = z.output<typeof feeComponentSchema>;
type SelectedTip = z.output<typeof selectedTipSchema>;
type ProjectionHead = z.output<typeof projectionHeadSchema>;

interface QueryResult {
  readonly rows?: readonly unknown[];
}

interface PlanningSnapshot {
  readonly root: PlanningRoot;
  readonly items: readonly PlanningItem[];
  readonly activeFeeComponents: readonly ActiveFeeComponent[];
}

interface FinancialDiscovery {
  readonly sourceBalances: readonly z.output<typeof balanceRowSchema>[];
  readonly payoutMemberships: readonly z.output<typeof payoutMembershipSchema>[];
  readonly payoutGenerations: readonly {
    readonly payoutId: string;
    readonly expectedGeneration: number;
  }[];
  readonly closureBalanceTransactionIds: readonly string[];
  readonly selectedTips: readonly SelectedTip[];
  readonly projectionHeads: readonly ProjectionHead[];
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Reporting correction execution was aborted.', 'AbortError');
  }
}

function staleState(): never {
  throw new FinancialAdminConflictError('stale_state');
}

function notEligible(): never {
  throw new FinancialAdminConflictError('not_eligible');
}

function permanentFailure(): never {
  throw new FinancialAdminPermanentError('command_failed');
}

function queryRows(value: unknown): readonly unknown[] {
  if (!value || typeof value !== 'object') return permanentFailure();
  const resultRows = (value as QueryResult).rows;
  if (!Array.isArray(resultRows)) return permanentFailure();
  return resultRows;
}

async function executeRows(
  transaction: DatabaseTransaction,
  statement: SQL
): Promise<readonly unknown[]> {
  return queryRows(await transaction.execute(statement));
}

function parseOne<T>(schema: z.ZodType<T>, values: readonly unknown[]): T {
  if (values.length !== 1) return permanentFailure();
  const parsed = schema.safeParse(values[0]);
  if (!parsed.success) return permanentFailure();
  return parsed.data;
}

function parseMany<T>(schema: z.ZodType<T>, values: readonly unknown[]): readonly T[] {
  const parsed = z.array(schema).safeParse(values);
  if (!parsed.success) return permanentFailure();
  return parsed.data;
}

function compareC(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}

function safeSum(values: readonly number[], signed = false): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || Math.abs(value) > SAFE_MONEY_MAX ||
      (!signed && value < 0)) return permanentFailure();
    total += value;
    if (!Number.isSafeInteger(total) || Math.abs(total) > SAFE_MONEY_MAX ||
      (!signed && total < 0)) return permanentFailure();
  }
  return total;
}

function canonicalAuthority(authority: FinancialProjectionAuthority): FinancialProjectionAuthority {
  if (
    authority.classifierVersion !== FINANCIAL_CLASSIFIER_VERSION ||
    authority.allocationAlgorithmVersion !== FINANCIAL_ALLOCATION_ALGORITHM_VERSION ||
    authority.pendingClassifierVersion !== null ||
    authority.pendingAllocationAlgorithmVersion !== null ||
    authority.pendingReplayId !== null ||
    authority.pendingScanRunId !== null
  ) return staleState();
  return authority;
}

function uuidList(values: readonly string[]): SQL {
  return sql.join(values.map((id) => sql`${id}::uuid`), sql`, `);
}

function textList(values: readonly string[]): SQL {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

async function discoverRouting(
  transaction: DatabaseTransaction,
  refundId: string
): Promise<z.output<typeof routingSchema> | null> {
  const values = await executeRows(transaction, sql`
    /* reporting-correction:routing */
    select refund.payment_id as "paymentId", payment.order_id as "orderId"
    from refunds refund
    join payments payment on payment.id = refund.payment_id
    where refund.id = ${refundId}::uuid
  `);
  if (values.length === 0) return null;
  return parseOne(routingSchema, values);
}

function planningRootQuery(
  refundId: string,
  authority: FinancialProjectionAuthority
): SQL {
  return sql`
    /* reporting-correction:planning-root */
    with target as (
      select refund.id, refund.payment_id, refund.stripe_refund_id, refund.status,
        refund.allocation_status, refund.financial_evidence_status, refund.amount_minor,
        refund.currency, payment.order_id
      from refunds refund
      join payments payment on payment.id = refund.payment_id
      where refund.id = ${refundId}::uuid
    ), target_balances as (
      select balance.id, balance.currency, balance.fingerprint_sha256
      from target
      join stripe_balance_transactions balance
        on balance.source_family = 'refund'
        and balance.source_id = target.stripe_refund_id
      join financial_classification_versions decision
        on decision.subject_type = 'balance_transaction'
        and decision.subject_id = balance.id
        and decision.classifier_version = ${authority.classifierVersion}
        and decision.source_fingerprint_sha256 = balance.fingerprint_sha256
        and decision.classification = 'refund'
    ), active_sets as (
      select allocation.*
      from target_balances balance
      join financial_allocation_sets allocation
        on allocation.balance_transaction_id = balance.id
      join target on true
      where allocation.classifier_version = ${authority.classifierVersion}
        and allocation.algorithm_version = ${authority.allocationAlgorithmVersion}
        and allocation.source_kind = 'refund'
        and allocation.source_internal_id = target.id
        and allocation.source_fingerprint_sha256 = balance.fingerprint_sha256
        and allocation.scope = 'title'
        and not exists (
          select 1 from financial_allocation_sets successor
          where successor.supersedes_set_id = allocation.id
            and successor.classifier_version = allocation.classifier_version
            and successor.algorithm_version = allocation.algorithm_version
        )
    ), raw_tips as (
      select correction.*
      from target
      join refund_reporting_correction_sets correction on correction.refund_id = target.id
      where not exists (
        select 1 from refund_reporting_correction_sets successor
        where successor.predecessor_correction_set_id = correction.id
      )
    ), current_heads as (
      select head.*
      from target_balances balance
      join current_financial_projection_heads head
        on head.balance_transaction_id = balance.id
    ), compatible_tips as (
      select distinct correction.id, correction.correction_version
      from target
      join current_heads head on true
      join refund_reporting_correction_sets correction
        on correction.id = head.compatible_correction_tip_id
        and correction.refund_id = target.id
    )
    select target.id as "refundId", target.payment_id as "paymentId",
      target.order_id as "orderId", target.stripe_refund_id as "stripeRefundId",
      target.status as "refundStatus", target.allocation_status as "allocationStatus",
      target.financial_evidence_status as "financialEvidenceStatus",
      target.amount_minor as "amountMinor", target.currency,
      (select count(*)::integer from target_balances) as "targetBalanceCount",
      (select id from target_balances order by id limit 1) as "targetBalanceTransactionId",
      (select count(*)::integer from active_sets where basis = 'gross_amount')
        as "grossBaseCount",
      (select id from active_sets where basis = 'gross_amount' order by id limit 1)
        as "grossAllocationSetId",
      (select count(*)::integer from active_sets where basis = 'fee') as "feeBaseCount",
      (select id from active_sets where basis = 'fee' order by id limit 1)
        as "feeAllocationSetId",
      (select fingerprint_sha256 from target_balances order by id limit 1)
        as "sourceFingerprint",
      (select currency from target_balances order by id limit 1) as "settlementCurrency",
      (select count(*)::integer from current_heads) as "currentHeadCount",
      coalesce((select count(*) = 2 and bool_and(head.is_complete)
        and count(*) filter (
          where head.basis = 'gross_amount'
            and head.base_set_id = (
              select id from active_sets where basis = 'gross_amount' order by id limit 1
            )
        ) = 1
        and count(*) filter (
          where head.basis = 'fee'
            and head.base_set_id is not distinct from (
              select id from active_sets where basis = 'fee' order by id limit 1
            )
        ) = 1
        from current_heads head), false)
        as "currentReportingComplete",
      coalesce(array(
        select distinct head.proposed_issue_code::text collate "C"
        from current_heads head where head.proposed_issue_code is not null
        order by head.proposed_issue_code::text collate "C"
      ), array[]::text[]) as "currentHeadIssueCodes",
      (select count(*)::integer from raw_tips) as "rawTipCount",
      (select id from raw_tips order by id limit 1) as "rawTipId",
      (select correction_version from raw_tips order by id limit 1)
        as "rawTipCorrectionVersion",
      (select base_allocation_set_id from raw_tips order by id limit 1)
        as "rawTipBaseAllocationSetId",
      (select source_fingerprint_sha256 from raw_tips order by id limit 1)
        as "rawTipSourceFingerprint",
      (select count(*)::integer from compatible_tips) as "compatibleTipCount",
      (select count(*)::integer from current_heads
        where compatible_correction_tip_id is not null) as "compatibleTipHeadCount",
      (select id from compatible_tips order by id limit 1) as "compatibleTipId",
      (select correction_version from compatible_tips order by id limit 1)
        as "compatibleTipCorrectionVersion"
    from target
  `;
}

function planningItemsQuery(
  root: PlanningRoot
): SQL {
  return sql`
    /* reporting-correction:planning-items */
    with target as (
      select refund.id, refund.payment_id, payment.order_id
      from refunds refund
      join payments payment on payment.id = refund.payment_id
      where refund.id = ${root.refundId}::uuid
    ), compatible_sibling_tips as (
      select distinct sibling.id as refund_id, correction.id as correction_set_id
      from target
      join refunds sibling on sibling.payment_id = target.payment_id
        and sibling.id <> target.id and sibling.status = 'succeeded'
      join refund_reporting_correction_sets correction on correction.refund_id = sibling.id
      where exists (
        select 1
        from current_financial_projection_heads head
        join financial_allocation_sets base on base.id = head.base_set_id
        where head.compatible_correction_tip_id = correction.id
          and base.source_kind = 'refund' and base.source_internal_id = sibling.id
      )
    ), sibling_presentment_effects as (
      select component.order_item_id, value.component, component.currency,
        value.amount_minor::bigint as amount_minor
      from target
      join refunds sibling on sibling.payment_id = target.payment_id
        and sibling.id <> target.id and sibling.status = 'succeeded'
      join refund_allocation_components component on component.refund_id = sibling.id
      cross join lateral (values
        ('refund_subtotal'::financial_component, component.subtotal_minor),
        ('refund_tax'::financial_component, component.tax_minor)
      ) value(component, amount_minor)
      where not exists (
        select 1 from compatible_sibling_tips tip
        where tip.refund_id = sibling.id and exists (
          select 1 from refund_reporting_correction_items correction_item
          where correction_item.correction_set_id = tip.correction_set_id
            and correction_item.domain = 'presentment'
        )
      )
      union all
      select correction_item.order_item_id, correction_item.component,
        correction_item.currency, correction_item.approved_absolute_minor::bigint
      from compatible_sibling_tips tip
      join refund_reporting_correction_items correction_item
        on correction_item.correction_set_id = tip.correction_set_id
        and correction_item.domain = 'presentment'
    ), sibling_rollup as (
      select effect.order_item_id,
        coalesce(sum(effect.amount_minor) filter (
          where effect.component = 'refund_subtotal'), 0)::integer as subtotal_minor,
        coalesce(sum(effect.amount_minor) filter (
          where effect.component = 'refund_tax'), 0)::integer as tax_minor
      from sibling_presentment_effects effect
      group by effect.order_item_id
    ), immutable_presentment as (
      select component.order_item_id,
        coalesce(sum(component.subtotal_minor), 0)::integer as subtotal_minor,
        coalesce(sum(component.tax_minor), 0)::integer as tax_minor
      from refund_allocation_components component
      where component.refund_id = ${root.refundId}::uuid
      group by component.order_item_id
    ), immutable_gross as (
      select item.order_item_id,
        coalesce(sum(item.effect_minor) filter (
          where item.component = 'refund_subtotal'), 0)::integer as subtotal_minor,
        coalesce(sum(item.effect_minor) filter (
          where item.component = 'refund_tax'), 0)::integer as tax_minor
      from financial_item_allocations item
      where item.allocation_set_id = ${root.grossAllocationSetId}::uuid
      group by item.order_item_id
    ), immutable_fee as (
      select item.order_item_id,
        coalesce(sum(item.effect_minor) filter (
          where item.component = 'refund_fee'), 0)::integer as fee_minor
      from financial_item_allocations item
      where ${root.feeAllocationSetId === null
        ? sql`false`
        : sql`item.allocation_set_id = ${root.feeAllocationSetId}::uuid`}
      group by item.order_item_id
    ), compatible_presentment as (
      select item.order_item_id,
        coalesce(sum(item.approved_absolute_minor) filter (
          where item.component = 'refund_subtotal'), 0)::integer as subtotal_minor,
        coalesce(sum(item.approved_absolute_minor) filter (
          where item.component = 'refund_tax'), 0)::integer as tax_minor
      from refund_reporting_correction_items item
      where ${root.compatibleTipId === null
        ? sql`false`
        : sql`item.correction_set_id = ${root.compatibleTipId}::uuid`}
        and item.domain = 'presentment'
      group by item.order_item_id
    ), compatible_gross as (
      select item.order_item_id,
        coalesce(sum(item.approved_absolute_minor) filter (
          where item.component = 'refund_subtotal'), 0)::integer as subtotal_minor,
        coalesce(sum(item.approved_absolute_minor) filter (
          where item.component = 'refund_tax'), 0)::integer as tax_minor
      from refund_reporting_correction_items item
      where ${root.compatibleTipId === null
        ? sql`false`
        : sql`item.correction_set_id = ${root.compatibleTipId}::uuid`}
        and item.domain = 'settlement'
        and item.source_allocation_set_id = ${root.grossAllocationSetId}::uuid
      group by item.order_item_id
    ), compatible_fee as (
      select item.order_item_id,
        coalesce(sum(item.approved_absolute_minor) filter (
          where item.component = 'refund_fee'), 0)::integer as fee_minor
      from refund_reporting_correction_items item
      where ${root.compatibleTipId === null || root.feeAllocationSetId === null
        ? sql`false`
        : sql`item.correction_set_id = ${root.compatibleTipId}::uuid
          and item.source_allocation_set_id = ${root.feeAllocationSetId}::uuid`}
        and item.domain = 'settlement'
      group by item.order_item_id
    )
    select item.id as "orderItemId", item.title_id as "titleId",
      item.title_snapshot as "soldAsTitle",
      item.unit_subtotal_minor as "paidSubtotalMinor",
      coalesce(item.tax_minor, 0) as "paidTaxMinor",
      item.total_minor as "paidTotalMinor",
      coalesce(sibling.subtotal_minor, 0) as "effectiveSiblingSubtotalMinor",
      coalesce(sibling.tax_minor, 0) as "effectiveSiblingTaxMinor",
      coalesce(presentment.subtotal_minor, 0) as "immutablePresentmentSubtotalMinor",
      coalesce(presentment.tax_minor, 0) as "immutablePresentmentTaxMinor",
      coalesce(gross.subtotal_minor, 0) as "immutableSettlementSubtotalMinor",
      coalesce(gross.tax_minor, 0) as "immutableSettlementTaxMinor",
      case when ${root.feeAllocationSetId}::uuid is null then null
        else coalesce(fee.fee_minor, 0) end as "immutableRefundFeeImpactMinor",
      case when ${root.compatibleTipId}::uuid is null then null
        else coalesce(compatible_presentment.subtotal_minor,
          presentment.subtotal_minor, 0) end as "compatiblePresentmentSubtotalMinor",
      case when ${root.compatibleTipId}::uuid is null then null
        else coalesce(compatible_presentment.tax_minor,
          presentment.tax_minor, 0) end as "compatiblePresentmentTaxMinor",
      case when ${root.compatibleTipId}::uuid is null then null
        else coalesce(compatible_gross.subtotal_minor, gross.subtotal_minor, 0)
        end as "compatibleSettlementSubtotalMinor",
      case when ${root.compatibleTipId}::uuid is null then null
        else coalesce(compatible_gross.tax_minor, gross.tax_minor, 0)
        end as "compatibleSettlementTaxMinor",
      case when ${root.compatibleTipId}::uuid is null or
        ${root.feeAllocationSetId}::uuid is null then null
        else coalesce(compatible_fee.fee_minor, fee.fee_minor, 0)
        end as "compatibleRefundFeeImpactMinor"
    from target
    join order_items item on item.order_id = target.order_id
    left join sibling_rollup sibling on sibling.order_item_id = item.id
    left join immutable_presentment presentment on presentment.order_item_id = item.id
    left join immutable_gross gross on gross.order_item_id = item.id
    left join immutable_fee fee on fee.order_item_id = item.id
    left join compatible_presentment on compatible_presentment.order_item_id = item.id
    left join compatible_gross on compatible_gross.order_item_id = item.id
    left join compatible_fee on compatible_fee.order_item_id = item.id
    order by item.id
  `;
}

function feeComponentsQuery(root: PlanningRoot, authority: FinancialProjectionAuthority): SQL {
  return sql`
    /* reporting-correction:fee-components */
    select decision.classification as component,
      (-sum(detail.amount_minor))::integer as "amountMinor", detail.currency
    from stripe_balance_transaction_fee_details detail
    join financial_classification_versions decision
      on decision.subject_type = 'fee_detail'
      and decision.subject_id = detail.id
      and decision.classifier_version = ${authority.classifierVersion}
      and decision.source_fingerprint_sha256 = detail.fingerprint_sha256
    where detail.balance_transaction_id = ${root.targetBalanceTransactionId}::uuid
    group by decision.classification, detail.currency
    order by decision.classification::text collate "C", detail.currency
  `;
}

async function loadPlanningSnapshot(
  transaction: DatabaseTransaction,
  refundId: string,
  authority: FinancialProjectionAuthority
): Promise<PlanningSnapshot | null> {
  const rootValues = await executeRows(transaction, planningRootQuery(refundId, authority));
  if (rootValues.length === 0) return null;
  const root = parseOne(planningRootSchema, rootValues);
  const canLoadItems = root.grossAllocationSetId !== null &&
    root.targetBalanceTransactionId !== null;
  if (!canLoadItems) return { root, items: [], activeFeeComponents: [] };
  const items = parseMany(
    planningItemSchema,
    await executeRows(transaction, planningItemsQuery(root))
  );
  const activeFeeComponents = parseMany(
    feeComponentSchema,
    await executeRows(transaction, feeComponentsQuery(root, authority))
  );
  if (!uniqueBy(items, (item) => item.orderItemId) || items.length > MAX_ITEMS) {
    return permanentFailure();
  }
  return { root, items, activeFeeComponents };
}

async function loadFinancialDiscovery(
  transaction: DatabaseTransaction,
  providerRefundIds: readonly string[],
  authority: FinancialProjectionAuthority
): Promise<FinancialDiscovery> {
  const canonicalProviderIds = [...new Set(providerRefundIds)].sort(compareC);
  const sourceBalances = parseMany(balanceRowSchema, await executeRows(transaction, sql`
    /* reporting-correction:source-balances */
    select id, fingerprint_sha256 as "fingerprintSha256"
    from stripe_balance_transactions
    where source_family = 'refund' and ${canonicalProviderIds.length === 0
      ? sql`false`
      : sql`source_id in (${textList(canonicalProviderIds)})`}
    order by id
  `));
  if (!uniqueBy(sourceBalances, (row) => row.id)) return permanentFailure();
  const sourceIds = sourceBalances.map((row) => row.id);
  const payoutMemberships = parseMany(
    payoutMembershipSchema,
    await executeRows(transaction, sql`
      /* reporting-correction:payout-memberships */
      with target_payouts as (
        select distinct membership.payout_id
        from stripe_payout_balance_transactions membership
        where ${sourceIds.length === 0
          ? sql`false`
          : sql`membership.balance_transaction_id in (${uuidList(sourceIds)})`}
      )
      select payout.id as "payoutId", payout.financial_generation as "expectedGeneration",
        membership.balance_transaction_id as "balanceTransactionId"
      from target_payouts target
      join stripe_payouts payout on payout.id = target.payout_id
      join stripe_payout_balance_transactions membership on membership.payout_id = payout.id
      order by payout.id, membership.balance_transaction_id
    `)
  );
  const generationByPayout = new Map<string, number>();
  for (const membership of payoutMemberships) {
    const prior = generationByPayout.get(membership.payoutId);
    if (prior !== undefined && prior !== membership.expectedGeneration) return permanentFailure();
    generationByPayout.set(membership.payoutId, membership.expectedGeneration);
  }
  const payoutGenerations = [...generationByPayout]
    .map(([payoutId, expectedGeneration]) => ({ payoutId, expectedGeneration }))
    .sort((left, right) => compareC(left.payoutId, right.payoutId));
  const closureBalanceTransactionIds = [...new Set([
    ...sourceIds,
    ...payoutMemberships.map((row) => row.balanceTransactionId)
  ])].sort(compareC);
  const selectedTips = parseMany(selectedTipSchema, await executeRows(transaction, sql`
    /* reporting-correction:selected-tips */
    select target.id, target.balance_transaction_id as "balanceTransactionId", target.basis,
      target.source_fingerprint_sha256 as "sourceFingerprintSha256"
    from financial_allocation_sets target
    where ${sourceIds.length === 0
      ? sql`false`
      : sql`target.balance_transaction_id in (${uuidList(sourceIds)})`}
      and target.classifier_version = ${authority.classifierVersion}
      and target.algorithm_version = ${authority.allocationAlgorithmVersion}
      and not exists (
        select 1 from financial_allocation_sets successor
        where successor.supersedes_set_id = target.id
          and successor.classifier_version = target.classifier_version
          and successor.algorithm_version = target.algorithm_version
      )
    order by target.balance_transaction_id, target.basis, target.id
  `));
  const projectionHeads = parseMany(projectionHeadSchema, await executeRows(transaction, sql`
    /* reporting-correction:projection-heads */
    select balance_transaction_id as "balanceTransactionId", basis,
      base_set_id as "baseSetId", compatible_correction_tip_id as "compatibleCorrectionTipId",
      is_complete as "isComplete", proposed_issue_code as "proposedIssueCode"
    from current_financial_projection_heads
    where ${sourceIds.length === 0
      ? sql`false`
      : sql`balance_transaction_id in (${uuidList(sourceIds)})`}
    order by balance_transaction_id, basis
  `));
  if (
    !uniqueBy(selectedTips, (tip) => tip.id) ||
    selectedTips.some((tip) => !sourceIds.includes(tip.balanceTransactionId)) ||
    !uniqueBy(projectionHeads, (head) => `${head.balanceTransactionId}\0${head.basis}`) ||
    projectionHeads.some((head) => !sourceIds.includes(head.balanceTransactionId))
  ) return permanentFailure();
  return {
    sourceBalances,
    payoutMemberships,
    payoutGenerations,
    closureBalanceTransactionIds,
    selectedTips,
    projectionHeads
  };
}

function sameFinancialDiscovery(left: FinancialDiscovery, right: FinancialDiscovery): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateFinancialSnapshot(
  snapshot: PlanningSnapshot,
  discovery: FinancialDiscovery
): void {
  const root = snapshot.root;
  if (root.targetBalanceTransactionId === null || root.sourceFingerprint === null) {
    return staleState();
  }
  const targetBalances = discovery.sourceBalances.filter((balance) =>
    balance.id === root.targetBalanceTransactionId
  );
  if (targetBalances.length !== 1 ||
    targetBalances[0]!.fingerprintSha256 !== root.sourceFingerprint) return staleState();
  const expectedBases = new Map<'gross_amount' | 'fee', string | null>([
    ['gross_amount', root.grossAllocationSetId],
    ['fee', root.feeAllocationSetId]
  ]);
  const expectedTargetTips = [...expectedBases]
    .flatMap(([basis, id]) => id === null ? [] : [{ basis, id }]);
  const targetTips = discovery.selectedTips.filter((tip) =>
    tip.balanceTransactionId === root.targetBalanceTransactionId
  );
  if (
    targetTips.length !== expectedTargetTips.length ||
    expectedTargetTips.some((expected) => !targetTips.some((tip) =>
      tip.basis === expected.basis && tip.id === expected.id &&
      tip.sourceFingerprintSha256 === root.sourceFingerprint
    ))
  ) return staleState();
  const targetHeads = discovery.projectionHeads.filter((head) =>
    head.balanceTransactionId === root.targetBalanceTransactionId
  );
  const headIssueCodes = [...new Set(targetHeads.flatMap((head) =>
    head.proposedIssueCode === null ? [] : [head.proposedIssueCode]
  ))].sort(compareC);
  const compatibleIds = [...new Set(targetHeads.flatMap((head) =>
    head.compatibleCorrectionTipId === null ? [] : [head.compatibleCorrectionTipId]
  ))].sort(compareC);
  const reportingComplete = targetHeads.length === 2 &&
    targetHeads.every((head) => head.isComplete &&
      head.baseSetId === expectedBases.get(head.basis));
  if (
    targetHeads.length !== root.currentHeadCount ||
    targetHeads.some((head) => head.baseSetId !== expectedBases.get(head.basis)) ||
    reportingComplete !== root.currentReportingComplete ||
    JSON.stringify(headIssueCodes) !== JSON.stringify(root.currentHeadIssueCodes) ||
    compatibleIds.length !== root.compatibleTipCount ||
    (compatibleIds[0] ?? null) !== root.compatibleTipId ||
    targetHeads.filter((head) => head.compatibleCorrectionTipId !== null).length !==
      root.compatibleTipHeadCount
  ) return staleState();
}

type Readiness = 'ready' | 'provider_evidence_pending' | 'immutable_conflict' |
  'not_finalized';

function readiness(snapshot: PlanningSnapshot): Readiness {
  const root = snapshot.root;
  if (root.refundStatus !== 'succeeded' || root.allocationStatus !== 'finalized') {
    return 'not_finalized';
  }
  if (root.financialEvidenceStatus !== 'fee_reconciled') {
    return root.financialEvidenceStatus === 'pending'
      ? 'provider_evidence_pending'
      : 'immutable_conflict';
  }
  const pendingCodes = new Set(['allocation_incomplete', 'missing_source']);
  if (root.currentHeadIssueCodes.some((code) => pendingCodes.has(code))) {
    return 'provider_evidence_pending';
  }
  if (root.currentHeadIssueCodes.some((code) => code !== 'correction_rebase_required')) {
    return 'immutable_conflict';
  }
  if (
    root.targetBalanceCount !== 1 || root.targetBalanceTransactionId === null ||
    root.grossBaseCount !== 1 || root.grossAllocationSetId === null ||
    root.feeBaseCount > 1 || root.sourceFingerprint === null ||
    root.settlementCurrency === null || root.currentHeadCount !== 2
  ) return 'provider_evidence_pending';
  if (
    root.rawTipCount > 1 || root.compatibleTipCount > 1 ||
    (root.rawTipCount === 0 && (
      root.rawTipId !== null || root.rawTipCorrectionVersion !== null ||
      root.rawTipBaseAllocationSetId !== null || root.rawTipSourceFingerprint !== null
    )) ||
    (root.rawTipCount === 1 && (
      root.rawTipId === null || root.rawTipCorrectionVersion === null ||
      root.rawTipBaseAllocationSetId === null || root.rawTipSourceFingerprint === null ||
      root.rawTipCorrectionVersion >= POSTGRES_INTEGER_MAX
    )) ||
    (root.compatibleTipCount === 0 && (
      root.compatibleTipId !== null || root.compatibleTipCorrectionVersion !== null
    )) ||
    (root.compatibleTipCount === 1 && (
      root.compatibleTipId === null || root.compatibleTipCorrectionVersion === null
    )) ||
    (root.compatibleTipCount === 0 && root.compatibleTipHeadCount !== 0) ||
    (root.compatibleTipCount === 1 && root.compatibleTipHeadCount !== 2)
  ) return 'immutable_conflict';
  if (root.currentReportingComplete) {
    if (root.currentHeadIssueCodes.length > 0 ||
      (root.compatibleTipId !== null && root.compatibleTipId !== root.rawTipId) ||
      (root.rawTipId !== null && root.compatibleTipId === null)) {
      return 'immutable_conflict';
    }
  } else {
    if (
      root.currentHeadIssueCodes.length !== 1 ||
      root.currentHeadIssueCodes[0] !== 'correction_rebase_required' ||
      root.rawTipId === null || root.compatibleTipId !== null
    ) return 'immutable_conflict';
  }
  if (snapshot.items.length < 1 || snapshot.items.length > MAX_ITEMS) {
    return 'immutable_conflict';
  }
  if (snapshot.activeFeeComponents.some((component) =>
    component.amountMinor !== 0 && component.component !== 'refund_fee'
  )) return 'immutable_conflict';
  const immutablePresentmentTotal = safeSum(snapshot.items.flatMap((item) => [
    item.immutablePresentmentSubtotalMinor,
    item.immutablePresentmentTaxMinor
  ]));
  if (immutablePresentmentTotal !== root.amountMinor) return 'immutable_conflict';
  if (root.compatibleTipId !== null) {
    if (snapshot.items.some((item) => item.compatiblePresentmentSubtotalMinor === null ||
      item.compatiblePresentmentTaxMinor === null)) return 'immutable_conflict';
    const compatiblePresentmentTotal = safeSum(snapshot.items.flatMap((item) => [
      item.compatiblePresentmentSubtotalMinor!,
      item.compatiblePresentmentTaxMinor!
    ]));
    if (compatiblePresentmentTotal !== root.amountMinor) return 'immutable_conflict';
  }
  return 'ready';
}

function rawTip(root: PlanningRoot): RefundReportingCorrectionPlanInput['rawTip'] {
  if (root.rawTipId === null) return null;
  if (
    root.rawTipCorrectionVersion === null || root.rawTipBaseAllocationSetId === null ||
    root.rawTipSourceFingerprint === null
  ) return permanentFailure();
  return {
    id: root.rawTipId,
    correctionVersion: root.rawTipCorrectionVersion,
    baseAllocationSetId: root.rawTipBaseAllocationSetId,
    sourceFingerprint: root.rawTipSourceFingerprint
  };
}

function compatibleTip(
  root: PlanningRoot
): RefundReportingCorrectionPlanInput['compatibleTip'] {
  if (root.compatibleTipId === null) return null;
  if (root.compatibleTipCorrectionVersion === null) return permanentFailure();
  return { id: root.compatibleTipId, correctionVersion: root.compatibleTipCorrectionVersion };
}

function plannerInput(
  snapshot: PlanningSnapshot,
  authority: FinancialProjectionAuthority,
  request: ReportingCorrectionPrepareInput
): RefundReportingCorrectionPlanInput {
  const root = snapshot.root;
  if (
    root.grossAllocationSetId === null || root.sourceFingerprint === null ||
    root.settlementCurrency === null
  ) return permanentFailure();
  return {
    request,
    activeProjection: {
      classifierVersion: authority.classifierVersion,
      allocationAlgorithmVersion: authority.allocationAlgorithmVersion,
      replayId: `c${authority.classifierVersion}-a${authority.allocationAlgorithmVersion}`
    },
    currentReportingComplete: root.currentReportingComplete,
    rawTip: rawTip(root),
    compatibleTip: compatibleTip(root),
    immutableBase: {
      grossAllocationSetId: root.grossAllocationSetId,
      feeAllocationSetId: root.feeAllocationSetId,
      sourceFingerprint: root.sourceFingerprint,
      currency: root.currency,
      settlementCurrency: root.settlementCurrency,
      totalPresentmentMinor: root.amountMinor
    },
    activeFeeComponents: snapshot.activeFeeComponents,
    items: snapshot.items
  };
}

function requireCurrentBindings(
  request: ReportingCorrectionPrepareInput,
  snapshot: PlanningSnapshot
): void {
  const root = snapshot.root;
  const expectedNextCorrectionVersion = root.rawTipCorrectionVersion === null
    ? 1 : root.rawTipCorrectionVersion + 1;
  if (
    root.grossAllocationSetId === null || root.sourceFingerprint === null ||
    request.refundId !== root.refundId ||
    request.expectedNextCorrectionVersion !== expectedNextCorrectionVersion ||
    request.expectedBaseAllocationSetId !== root.grossAllocationSetId ||
    request.expectedSourceFingerprint !== root.sourceFingerprint
  ) return staleState();
}

function requireCurrentItemMembership(
  request: ReportingCorrectionPrepareInput,
  snapshot: PlanningSnapshot
): void {
  const requestedIds = request.items.map((item) => item.orderItemId).sort(compareC);
  const currentIds = snapshot.items.map((item) => item.orderItemId).sort(compareC);
  if (
    new Set(currentIds).size !== currentIds.length ||
    JSON.stringify(requestedIds) !== JSON.stringify(currentIds)
  ) return staleState();
}

function seedFromSnapshot(snapshot: PlanningSnapshot): RefundReportingCorrectionSeedDto {
  const root = snapshot.root;
  const state = readiness(snapshot);
  if (state !== 'ready') {
    return {
      refundId: root.refundId,
      reason: 'allocation_attribution_correction',
      expectedNextCorrectionVersion: null,
      expectedBaseAllocationSetId: null,
      expectedSourceFingerprint: null,
      rawPredecessorCorrectionSetId: root.rawTipId,
      compatibleCorrectionSetId: root.compatibleTipId,
      baselineKind: null,
      currentReportingComplete: root.currentReportingComplete,
      currency: null,
      settlementCurrency: null,
      baselineTotalMinor: null,
      eligible: false,
      ineligibleReason: state,
      items: []
    };
  }
  const nextVersion = root.rawTipCorrectionVersion === null
    ? 1 : root.rawTipCorrectionVersion + 1;
  const useCompatible = root.compatibleTipId !== null;
  const items = snapshot.items.map((item) => {
    const baselineSubtotalMinor = useCompatible
      ? item.compatiblePresentmentSubtotalMinor
      : item.immutablePresentmentSubtotalMinor;
    const baselineTaxMinor = useCompatible
      ? item.compatiblePresentmentTaxMinor
      : item.immutablePresentmentTaxMinor;
    if (baselineSubtotalMinor === null || baselineTaxMinor === null) return permanentFailure();
    return {
      orderItemId: item.orderItemId,
      titleId: item.titleId,
      soldAsTitle: item.soldAsTitle,
      baselineTotalMinor: safeSum([baselineSubtotalMinor, baselineTaxMinor]),
      baselineSubtotalMinor,
      baselineTaxMinor,
      baselineSettlementGrossMinor: useCompatible
        ? safeNullableSum([
            item.compatibleSettlementSubtotalMinor,
            item.compatibleSettlementTaxMinor
          ])
        : safeNullableSum([
            item.immutableSettlementSubtotalMinor,
            item.immutableSettlementTaxMinor
          ]),
      baselineRefundFeeImpactMinor: useCompatible
        ? item.compatibleRefundFeeImpactMinor
        : item.immutableRefundFeeImpactMinor
    };
  }).sort((left, right) => compareC(left.orderItemId, right.orderItemId));
  return {
    refundId: root.refundId,
    reason: 'allocation_attribution_correction',
    expectedNextCorrectionVersion: nextVersion,
    expectedBaseAllocationSetId: root.grossAllocationSetId!,
    expectedSourceFingerprint: root.sourceFingerprint!,
    rawPredecessorCorrectionSetId: root.rawTipId,
    compatibleCorrectionSetId: root.compatibleTipId,
    baselineKind: useCompatible ? 'compatible_correction' : 'immutable_base',
    currentReportingComplete: root.currentReportingComplete,
    currency: root.currency,
    settlementCurrency: root.settlementCurrency,
    baselineTotalMinor: safeSum(items.map((item) => item.baselineTotalMinor)),
    eligible: true,
    ineligibleReason: null,
    items
  };
}

function safeNullableSum(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return safeSum(values as readonly number[], true);
}

function ineligiblePreview(
  request: ReportingCorrectionPrepareInput,
  snapshot: PlanningSnapshot,
  reason: Exclude<Readiness, 'ready'>
): RefundReportingCorrectionPreviewDto {
  return {
    refundId: request.refundId,
    expectedBaseAllocationSetId: request.expectedBaseAllocationSetId,
    rawPredecessorCorrectionSetId: snapshot.root.rawTipId,
    compatibleCorrectionSetId: snapshot.root.compatibleTipId,
    expectedNextCorrectionVersion: request.expectedNextCorrectionVersion,
    expectedSourceFingerprint: request.expectedSourceFingerprint,
    previewFingerprint: null,
    baselineKind: snapshot.root.compatibleTipId === null
      ? 'immutable_base' : 'compatible_correction',
    currentReportingComplete: snapshot.root.currentReportingComplete,
    proposedReportingComplete: false,
    compatibilityRepair: false,
    currency: snapshot.root.currency,
    settlementCurrency: snapshot.root.settlementCurrency,
    baselineTotalMinor: 0,
    proposedTotalMinor: safeSum(request.items.map((item) => item.totalPresentmentMinor)),
    eligible: false,
    ineligibleReason: reason,
    items: []
  };
}

const prepareInputSchema = z.strictObject({
  refundId: canonicalUuidSchema,
  reason: z.literal('allocation_attribution_correction'),
  expectedNextCorrectionVersion: positiveVersionSchema,
  expectedBaseAllocationSetId: canonicalUuidSchema,
  expectedSourceFingerprint: sha256Schema,
  items: z.array(z.strictObject({
    orderItemId: canonicalUuidSchema,
    totalPresentmentMinor: moneySchema
  })).min(1).max(MAX_ITEMS).superRefine((items, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < items.length; index += 1) {
      const id = items[index]!.orderItemId;
      if (seen.has(id)) context.addIssue({
        code: 'custom', path: [index, 'orderItemId'], message: 'duplicate order item'
      });
      seen.add(id);
    }
  })
});

function parsePrepareInput(value: unknown): ReportingCorrectionPrepareInput {
  const parsed = prepareInputSchema.safeParse(value);
  if (!parsed.success) return staleState();
  return {
    ...parsed.data,
    items: [...parsed.data.items].sort((left, right) =>
      compareC(left.orderItemId, right.orderItemId))
  };
}

function parseCommand(
  value: unknown
): Extract<FinancialAdminPrivateCommand, { kind: 'refund_reporting_correction_create' }> {
  const parsed = prepareInputSchema.extend({
    kind: z.literal('refund_reporting_correction_create'),
    previewFingerprint: sha256Schema,
    confirmation: z.literal('create_reporting_correction')
  }).safeParse(value);
  if (!parsed.success) throw new FinancialAdminPermanentError('invalid_command');
  return {
    ...parsed.data,
    items: [...parsed.data.items].sort((left, right) =>
      compareC(left.orderItemId, right.orderItemId))
  };
}

async function authorizeInTransaction(
  transaction: DatabaseTransaction,
  actor: Extract<Actor, { type: 'user' }>,
  dependencies: FinancialAuthorizationDependencies
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
  );
  const refreshedActor = {
    type: 'user' as const,
    id: actor.id,
    roles: await listRolesForUser(transaction, actor.id)
  };
  requireCapability(refreshedActor, 'sales.read', dependencies.capabilityResolver);
  requireCapability(refreshedActor, 'reconciliation.manage', dependencies.capabilityResolver);
}

export async function getReportingCorrectionSeed(
  database: Database,
  actor: Actor,
  refundId: string,
  _context: FinancialRequestContext,
  dependencies: FinancialAuthorizationDependencies = {}
): Promise<RefundReportingCorrectionSeedDto | null> {
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  requireCapability(actor, 'reconciliation.manage', dependencies.capabilityResolver);
  const parsedRefundId = canonicalUuidSchema.safeParse(refundId);
  if (!parsedRefundId.success) return null;
  try {
    return await database.transaction(async (transaction: DatabaseTransaction) => {
      await authorizeInTransaction(transaction, actor, dependencies);
      const authority = canonicalAuthority(await loadFinancialProjectionAuthority(transaction));
      const snapshot = await loadPlanningSnapshot(transaction, parsedRefundId.data, authority);
      return snapshot === null ? null : seedFromSnapshot(snapshot);
    });
  } catch (error) {
    if (
      error instanceof FinancialAdminConflictError ||
      error instanceof FinancialAdminPermanentError ||
      error instanceof DOMException
    ) throw error;
    if (error instanceof RetryableFinancialError) return staleState();
    if (
      error instanceof PermanentFinancialError ||
      error instanceof PermanentCommerceError ||
      error instanceof CommerceConflictError
    ) return permanentFailure();
    throw error;
  }
}

export async function previewReportingCorrection(
  database: Database,
  actor: Actor,
  input: ReportingCorrectionPrepareInput,
  _context: FinancialRequestContext,
  dependencies: FinancialAuthorizationDependencies = {}
): Promise<RefundReportingCorrectionPreviewDto> {
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  requireCapability(actor, 'reconciliation.manage', dependencies.capabilityResolver);
  const request = parsePrepareInput(input);
  try {
    return await database.transaction(async (transaction: DatabaseTransaction) => {
      await authorizeInTransaction(transaction, actor, dependencies);
      const authority = canonicalAuthority(await loadFinancialProjectionAuthority(transaction));
      const snapshot = await loadPlanningSnapshot(transaction, request.refundId, authority);
      if (snapshot === null) return notEligible();
      requireCurrentBindings(request, snapshot);
      requireCurrentItemMembership(request, snapshot);
      const state = readiness(snapshot);
      if (state !== 'ready') return ineligiblePreview(request, snapshot, state);
      return planRefundReportingCorrection(plannerInput(snapshot, authority, request)).preview;
    });
  } catch (error) {
    if (
      error instanceof FinancialAdminConflictError ||
      error instanceof FinancialAdminPermanentError ||
      error instanceof DOMException
    ) throw error;
    if (error instanceof RetryableFinancialError) return staleState();
    if (
      error instanceof PermanentFinancialError ||
      error instanceof PermanentCommerceError ||
      error instanceof CommerceConflictError
    ) return permanentFailure();
    throw error;
  }
}

async function lockOrderRow(
  transaction: DatabaseTransaction,
  orderId: string
): Promise<z.output<typeof lockedOrderSchema>> {
  return parseOne(lockedOrderSchema, await executeRows(transaction, sql`
    /* reporting-correction:locked-order */
    select id, status, currency, total_minor as "totalMinor", paid_at as "paidAt"
    from orders where id = ${orderId}::uuid for update
  `));
}

async function lockPaymentRow(
  transaction: DatabaseTransaction,
  paymentId: string,
  orderId: string
): Promise<z.output<typeof lockedPaymentSchema>> {
  return parseOne(lockedPaymentSchema, await executeRows(transaction, sql`
    /* reporting-correction:locked-payment */
    select id, order_id as "orderId", status, amount_minor as "amountMinor",
      currency, paid_at as "paidAt"
    from payments where id = ${paymentId}::uuid and order_id = ${orderId}::uuid
    for update
  `));
}

function validateLockedPurchaseFacts(
  facts: PaymentPurchaseFacts,
  routing: z.output<typeof routingSchema>,
  snapshot: PlanningSnapshot
): void {
  const root = snapshot.root;
  if (
    facts.order.id !== routing.orderId || facts.payment.id !== routing.paymentId ||
    facts.payment.orderId !== routing.orderId || root.orderId !== routing.orderId ||
    root.paymentId !== routing.paymentId || facts.order.status !== 'paid' ||
    facts.payment.status !== 'succeeded' || facts.order.totalMinor === null ||
    facts.payment.amountMinor !== facts.order.totalMinor ||
    facts.payment.currency !== facts.order.currency || facts.orderItems.length < 1 ||
    facts.orderItems.length > MAX_ITEMS || facts.orderItems.length !== snapshot.items.length
  ) return permanentFailure();
  const targetRefunds = facts.refunds.filter((refund) => refund.id === root.refundId);
  if (targetRefunds.length !== 1) return permanentFailure();
  const targetRefund = targetRefunds[0]!;
  if (
    targetRefund.paymentId !== root.paymentId ||
    targetRefund.stripeRefundId !== root.stripeRefundId ||
    targetRefund.status !== root.refundStatus ||
    targetRefund.allocationStatus !== root.allocationStatus ||
    targetRefund.financialEvidenceStatus !== root.financialEvidenceStatus ||
    targetRefund.amountMinor !== root.amountMinor || targetRefund.currency !== root.currency
  ) return staleState();
  const itemById = new Map(snapshot.items.map((item) => [item.orderItemId, item]));
  if (!uniqueBy(facts.orderItems, (item) => item.id)) return permanentFailure();
  for (const item of facts.orderItems) {
    const planned = itemById.get(item.id);
    if (
      !planned || item.orderId !== root.orderId || item.titleId !== planned.titleId ||
      item.titleSnapshot !== planned.soldAsTitle || item.unitSubtotalMinor !== planned.paidSubtotalMinor ||
      item.taxMinor !== planned.paidTaxMinor || item.totalMinor !== planned.paidTotalMinor ||
      item.currency !== root.currency
    ) return staleState();
  }
  const targetComponents = facts.refundComponents.filter((component) =>
    component.refundId === root.refundId
  );
  const componentByItem = new Map(targetComponents.map((component) => [
    component.orderItemId,
    component
  ]));
  if (!uniqueBy(targetComponents, (component) => component.orderItemId)) {
    return permanentFailure();
  }
  for (const item of snapshot.items) {
    const component = componentByItem.get(item.orderItemId);
    if (
      (component?.subtotalMinor ?? 0) !== item.immutablePresentmentSubtotalMinor ||
      (component?.taxMinor ?? 0) !== item.immutablePresentmentTaxMinor
    ) return staleState();
  }
  const targetCorrections = facts.correctionSets.filter((correction) =>
    correction.refundId === root.refundId
  );
  const targetIds = new Set(targetCorrections.map((correction) => correction.id));
  const raw = targetCorrections.filter((candidate) => !targetCorrections.some((successor) =>
    successor.predecessorCorrectionSetId === candidate.id
  ));
  if (raw.length !== root.rawTipCount || (raw[0]?.id ?? null) !== root.rawTipId ||
    targetCorrections.some((correction) => correction.predecessorCorrectionSetId !== null &&
      !targetIds.has(correction.predecessorCorrectionSetId))) return staleState();
  const rawRow = raw[0];
  if (rawRow && (
    rawRow.correctionVersion !== root.rawTipCorrectionVersion ||
    rawRow.baseAllocationSetId !== root.rawTipBaseAllocationSetId ||
    rawRow.sourceFingerprintSha256 !== root.rawTipSourceFingerprint
  )) return staleState();
  if (root.compatibleTipId !== null) {
    const compatible = targetCorrections.find((correction) =>
      correction.id === root.compatibleTipId
    );
    if (!compatible || compatible.correctionVersion !==
      root.compatibleTipCorrectionVersion) return staleState();
  }
}

function providerRefundIds(facts: PaymentPurchaseFacts): readonly string[] {
  const ids = facts.refunds.flatMap((refund) =>
    refund.status === 'succeeded' ? [refund.stripeRefundId] : []
  ).sort(compareC);
  if (ids.length > MAX_REFUND_CLOSURE || new Set(ids).size !== ids.length) {
    return permanentFailure();
  }
  return ids;
}

function targetSelectedSetIds(snapshot: PlanningSnapshot): readonly string[] {
  const ids = [
    snapshot.root.grossAllocationSetId,
    snapshot.root.feeAllocationSetId
  ].flatMap((id) => id === null ? [] : [id]).sort(compareC);
  if (ids.length < 1 || new Set(ids).size !== ids.length) return permanentFailure();
  return ids;
}

function isBoundedCorrectionCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (candidate.code === '23505' && (
    candidate.constraint === 'refund_reporting_correction_sets_identity_unique' ||
    candidate.constraint === 'refund_reporting_correction_sets_successor_unique' ||
    candidate.constraint === 'refund_reporting_correction_sets_root_unique'
  )) return true;
  return candidate.cause !== error && isBoundedCorrectionCollision(candidate.cause);
}

async function insertCorrectionSet(
  context: FinancialAdminCommandExecutorContext,
  snapshot: PlanningSnapshot,
  correctionVersion: number
): Promise<string> {
  try {
    const inserted = parseOne(writeIdSchema, await executeRows(context.transaction, sql`
      /* reporting-correction:insert-set */
      insert into refund_reporting_correction_sets (
        refund_id, correction_version, kind, base_allocation_set_id,
        predecessor_correction_set_id, source_fingerprint_sha256,
        approved_by_admin_id, created_by_admin_id, correlation_id
      ) values (
        ${snapshot.root.refundId}::uuid, ${correctionVersion},
        'allocation_attribution_correction',
        ${snapshot.root.grossAllocationSetId}::uuid,
        ${snapshot.root.rawTipId}::uuid,
        ${snapshot.root.sourceFingerprint}, ${context.actor.id}::uuid,
        ${context.actor.id}::uuid, ${context.correlationId}
      ) returning id
    `));
    return inserted.id;
  } catch (error) {
    if (isBoundedCorrectionCollision(error)) return staleState();
    throw error;
  }
}

async function insertCorrectionItems(
  transaction: DatabaseTransaction,
  correctionSetId: string,
  items: readonly RefundReportingCorrectionPersistableItem[]
): Promise<void> {
  const sorted = [...items].sort((left, right) =>
    compareC(left.stableTieBreakKey, right.stableTieBreakKey));
  if (
    sorted.length === 0 ||
    !uniqueBy(sorted, (item) => item.stableTieBreakKey)
  ) return permanentFailure();
  for (const item of sorted) {
    parseOne(writeIdSchema, await executeRows(transaction, sql`
      /* reporting-correction:insert-item */
      insert into refund_reporting_correction_items (
        correction_set_id, domain, source_allocation_set_id, order_item_id,
        component, currency, approved_absolute_minor, delta_minor, stable_tie_break_key
      ) values (
        ${correctionSetId}::uuid, ${item.domain}, ${item.sourceAllocationSetId}::uuid,
        ${item.orderItemId}::uuid, ${item.component}, ${item.currency},
        ${item.approvedAbsoluteMinor}, ${item.deltaMinor}, ${item.stableTieBreakKey}
      ) returning id
    `));
  }
}

function recomputeInput(
  context: FinancialAdminCommandExecutorContext,
  snapshot: PlanningSnapshot,
  facts: PaymentPurchaseFacts
): LockedRefundProjectionInput {
  const root = snapshot.root;
  const targetAllocations = facts.refundAllocations.filter((allocation) =>
    allocation.refundId === root.refundId
  ).sort((left, right) => compareC(left.id, right.id));
  const targetComponents = facts.refundComponents.filter((component) =>
    component.refundId === root.refundId
  ).sort((left, right) => compareC(left.refundAllocationId, right.refundAllocationId));
  return {
    orderId: root.orderId,
    paymentId: root.paymentId,
    refundId: root.refundId,
    providerStatus: 'succeeded',
    allocationStatus: 'finalized',
    amountMinor: root.amountMinor,
    currency: root.currency,
    balanceTransactionIds: [root.targetBalanceTransactionId!],
    orderItems: facts.orderItems.map((item) => ({
      id: item.id,
      subtotalMinor: item.unitSubtotalMinor,
      taxMinor: item.taxMinor!,
      totalMinor: item.totalMinor!,
      currency: item.currency
    })),
    finalizedAllocations: targetAllocations.map((allocation) => ({
      id: allocation.id,
      orderItemId: allocation.orderItemId,
      amountMinor: allocation.amountMinor
    })),
    refundComponents: targetComponents.map((component) => ({
      refundAllocationId: component.refundAllocationId,
      orderItemId: component.orderItemId,
      subtotalMinor: component.subtotalMinor,
      taxMinor: component.taxMinor,
      currency: component.currency
    })),
    correlationId: context.correlationId
  };
}

async function verifyPostResolutionHeads(
  transaction: DatabaseTransaction,
  snapshot: PlanningSnapshot,
  correctionSetId: string
): Promise<void> {
  const heads = parseMany(postHeadSchema, await executeRows(transaction, sql`
    /* reporting-correction:post-heads */
    with raw_tips as (
      select correction.id
      from refund_reporting_correction_sets correction
      where correction.refund_id = ${snapshot.root.refundId}::uuid
        and not exists (
          select 1 from refund_reporting_correction_sets successor
          where successor.predecessor_correction_set_id = correction.id
        )
    )
    select head.basis, (select count(*)::integer from raw_tips) as "rawTipCount",
      (select id from raw_tips order by id limit 1) as "rawTipId",
      head.base_set_id as "baseSetId",
      head.compatible_correction_tip_id as "compatibleCorrectionTipId",
      head.is_complete as "isComplete"
    from current_financial_projection_heads head
    where head.balance_transaction_id = ${snapshot.root.targetBalanceTransactionId}::uuid
    order by head.basis
  `));
  const expectedBases = new Map([
    ['gross_amount', snapshot.root.grossAllocationSetId],
    ['fee', snapshot.root.feeAllocationSetId]
  ]);
  if (
    heads.length !== 2 || !uniqueBy(heads, (head) => head.basis) ||
    heads.some((head) => head.rawTipCount !== 1 || !head.isComplete ||
      head.rawTipId !== correctionSetId ||
      head.compatibleCorrectionTipId !== correctionSetId ||
      head.baseSetId !== expectedBases.get(head.basis))
  ) return permanentFailure();
}

type CorrectionRecompute = typeof refundFinancialProjection
  .recomputeLockedRefundFinancialProjectionForReportingCorrectionCommand;

function correctionRecompute(): CorrectionRecompute {
  const recompute = refundFinancialProjection
    .recomputeLockedRefundFinancialProjectionForReportingCorrectionCommand;
  if (typeof recompute !== 'function') return permanentFailure();
  return recompute;
}

async function executeLocked(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, {
    kind: 'refund_reporting_correction_create'
  }>
): Promise<FinancialAdminCommandSafeResultByCode['correction_created']> {
  throwIfAborted(context.signal);
  const routing = await discoverRouting(context.transaction, command.refundId);
  if (routing === null) return notEligible();
  const authority = canonicalAuthority(await lockFinancialProjectionAuthority(
    context.transaction
  ));
  throwIfAborted(context.signal);
  await lockOrder(context.transaction, routing.orderId);
  const order = await lockOrderRow(context.transaction, routing.orderId);
  const payment = await lockPaymentRow(
    context.transaction, routing.paymentId, routing.orderId
  );
  if (
    order.id !== routing.orderId || payment.id !== routing.paymentId ||
    payment.orderId !== routing.orderId
  ) return permanentFailure();
  const facts = await lockPaymentPurchaseFacts(
    context.transaction, payment as never, order
  );
  throwIfAborted(context.signal);
  await lockFinancialProjectionEnrollment(context.transaction);
  const discovered = await loadFinancialDiscovery(
    context.transaction, providerRefundIds(facts), authority
  );
  const issueKeys = [
    ...ISSUE_CODES.map((safeCode) => ({
      resourceType: 'refund' as const,
      resourceId: command.refundId,
      safeCode
    })),
    ...discovered.selectedTips.flatMap((tip) => ISSUE_CODES.map((safeCode) => ({
      resourceType: 'allocation_set' as const,
      resourceId: tip.id,
      safeCode
    })))
  ];
  await lockFinancialProjectionRows(context.transaction, {
    payoutGenerations: discovered.payoutGenerations,
    balanceTransactionIds: discovered.closureBalanceTransactionIds,
    classifierVersion: authority.classifierVersion,
    issueKeys
  });
  const lockedDiscovery = await loadFinancialDiscovery(
    context.transaction, providerRefundIds(facts), authority
  );
  if (!sameFinancialDiscovery(discovered, lockedDiscovery)) return staleState();
  const snapshot = await loadPlanningSnapshot(context.transaction, command.refundId, authority);
  if (snapshot === null) return staleState();
  validateLockedPurchaseFacts(facts, routing, snapshot);
  validateFinancialSnapshot(snapshot, lockedDiscovery);
  const request: ReportingCorrectionPrepareInput = {
    refundId: command.refundId,
    reason: command.reason,
    expectedNextCorrectionVersion: command.expectedNextCorrectionVersion,
    expectedBaseAllocationSetId: command.expectedBaseAllocationSetId,
    expectedSourceFingerprint: command.expectedSourceFingerprint,
    items: command.items
  };
  requireCurrentBindings(request, snapshot);
  requireCurrentItemMembership(request, snapshot);
  const state = readiness(snapshot);
  if (state !== 'ready') {
    return state === 'not_finalized' ? notEligible() : staleState();
  }
  const plan = planRefundReportingCorrection(plannerInput(snapshot, authority, request));
  if (plan.kind !== 'ready') {
    return plan.preview.ineligibleReason === 'no_change' ? notEligible() : staleState();
  }
  if (plan.preview.previewFingerprint !== command.previewFingerprint) return staleState();
  const correctionVersion = snapshot.root.rawTipCorrectionVersion === null
    ? 1 : snapshot.root.rawTipCorrectionVersion + 1;
  if (correctionVersion !== command.expectedNextCorrectionVersion) return staleState();
  throwIfAborted(context.signal);
  const correctionSetId = await insertCorrectionSet(context, snapshot, correctionVersion);
  await insertCorrectionItems(context.transaction, correctionSetId, plan.persistableItems);
  throwIfAborted(context.signal);
  const recomputed = await correctionRecompute()(
    context.transaction,
    recomputeInput(context, snapshot, facts),
    targetSelectedSetIds(snapshot),
    context.commandId
  );
  if (
    recomputed.refundId !== command.refundId ||
    (recomputed.status !== 'reconciled' && recomputed.status !== 'unchanged') ||
    recomputed.financialEvidenceStatus !== 'fee_reconciled'
  ) return staleState();
  await verifyPostResolutionHeads(context.transaction, snapshot, correctionSetId);
  throwIfAborted(context.signal);
  await appendAuditEvent(context.transaction, {
    actor: context.actor,
    action: 'financial.refund_correction.created',
    outcome: 'succeeded',
    resourceType: 'refund_reporting_correction_set',
    resourceId: correctionSetId,
    correlationId: context.correlationId,
    before: {
      refundId: command.refundId,
      baseAllocationSetId: snapshot.root.grossAllocationSetId,
      rawPredecessorCorrectionSetId: snapshot.root.rawTipId,
      compatibleCorrectionSetId: snapshot.root.compatibleTipId,
      currentReportingComplete: snapshot.root.currentReportingComplete
    },
    after: {
      refundId: command.refundId,
      correctionSetId,
      correctionVersion,
      baseAllocationSetId: snapshot.root.grossAllocationSetId,
      sourceFingerprint: snapshot.root.sourceFingerprint,
      correctionItemCount: plan.persistableItems.length,
      reportingComplete: true
    }
  });
  return { refundId: command.refundId, correctionSetId, correctionVersion };
}

export async function executeReportingCorrectionCreate(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, {
    kind: 'refund_reporting_correction_create'
  }>
): Promise<FinancialAdminCommandSafeResultByCode['correction_created']> {
  const parsedCommand = parseCommand(command);
  try {
    return await executeLocked(context, parsedCommand);
  } catch (error) {
    if (
      error instanceof FinancialAdminConflictError ||
      error instanceof FinancialAdminPermanentError ||
      error instanceof DOMException
    ) throw error;
    if (error instanceof RetryableFinancialError) return staleState();
    if (
      error instanceof PermanentFinancialError ||
      error instanceof PermanentCommerceError ||
      error instanceof CommerceConflictError
    ) return permanentFailure();
    throw error;
  }
}
