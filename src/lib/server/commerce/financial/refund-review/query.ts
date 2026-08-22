import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  requireCapability,
  type Actor,
  type FinancialAuthorizationDependencies
} from '$lib/server/auth/admin-policy';
import { listRolesForUser } from '$lib/server/auth/identity';
import { loadCurrentPayoutEvidence } from '$lib/server/commerce/financial/payouts/repository';
import { derivePublicFinancialState } from '$lib/server/commerce/financial/state';
import { auditFinancialRefundDetailRead } from '$lib/server/commerce/reporting/audit';
import type { FinancialRequestContext } from '$lib/server/commerce/reporting/context';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { RefundDetailDto } from '$lib/types/financial-reporting';

const SAFE_MONEY_MAX = 99_999_999;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const canonicalUuidSchema = z.uuid().refine((value) => value === value.toLowerCase());
const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const moneySchema = z.number().int().min(0).max(SAFE_MONEY_MAX);
const countSchema = z.number().int().min(0).max(POSTGRES_INTEGER_MAX);
const postgresTimestampPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/u;

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
  .transform((value) => timestampDate(value).toISOString());

const itemSchema = z.strictObject({
  orderItemId: canonicalUuidSchema,
  titleId: canonicalUuidSchema,
  soldAsTitle: z.string().min(1).max(500),
  soldAsCreatorName: z.string().min(1).max(500),
  format: z.enum(['prose', 'comic']),
  paidSubtotalMinor: moneySchema,
  paidTaxMinor: moneySchema,
  paidTotalMinor: moneySchema,
  currency: currencySchema,
  finalizedRefundTotalMinor: moneySchema,
  remainingRefundCapacityMinor: moneySchema
});
const allocationSchema = z.strictObject({
  orderItemId: canonicalUuidSchema,
  totalMinor: moneySchema,
  subtotalMinor: moneySchema,
  taxMinor: moneySchema,
  remainingSubtotalCapacityMinor: moneySchema,
  remainingTaxCapacityMinor: moneySchema,
  source: z.enum(['automatic', 'administrative'])
});
const draftItemSchema = z.strictObject({
  orderItemId: canonicalUuidSchema,
  proposedTotalMinor: moneySchema
});
const rowSchema = z.strictObject({
  refundId: canonicalUuidSchema,
  orderId: canonicalUuidSchema,
  status: z.enum(['pending', 'succeeded', 'failed', 'canceled']),
  allocationStatus: z.enum([
    'not_applicable', 'needs_review', 'draft', 'finalized', 'exception'
  ]),
  amountMinor: moneySchema.min(1),
  currency: currencySchema,
  orderSubtotalMinor: moneySchema,
  orderTaxMinor: moneySchema,
  orderTotalMinor: moneySchema,
  financialEvidenceStatus: z.enum(['pending', 'fee_reconciled', 'exception']),
  balanceTransactionIds: z.array(canonicalUuidSchema).max(100),
  items: z.array(itemSchema).min(1).max(25),
  finalizedAllocations: z.array(allocationSchema).max(25),
  allAllocationCount: countSchema,
  allComponentCount: countSchema,
  targetAllocationCount: countSchema,
  draftId: canonicalUuidSchema.nullable(),
  draftVersion: z.number().int().min(1).max(POSTGRES_INTEGER_MAX).nullable(),
  draftState: z.enum(['active', 'finalized', 'discarded']).nullable(),
  draftEditedByCurrentAdministrator: z.boolean().nullable(),
  draftUpdatedAt: timestampSchema.nullable(),
  draftItems: z.array(draftItemSchema).max(25),
  openIssueCount: countSchema,
  dataThroughAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

type QueryResult = { readonly rows?: readonly unknown[] };

export class RefundReviewRepositoryError extends Error {
  constructor() {
    super('Refund review data is temporarily unavailable.');
    this.name = 'RefundReviewRepositoryError';
  }
}

function invalidData(): never {
  throw new RefundReviewRepositoryError();
}

function queryRows(value: unknown): readonly unknown[] {
  if (!value || typeof value !== 'object') return invalidData();
  const rows = (value as QueryResult).rows;
  if (!Array.isArray(rows)) return invalidData();
  return rows;
}

function safeTotal(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total) || total > SAFE_MONEY_MAX) return invalidData();
  }
  return total;
}

function refundDetailQuery(refundId: string, actorId: string): SQL {
  return sql`
    with target as (
      select refund.id as refund_id, refund.payment_id, refund.stripe_refund_id,
        refund.status, refund.allocation_status, refund.amount_minor, refund.currency,
        refund.financial_evidence_status, refund.created_at, refund.updated_at,
        payment.order_id, payment.updated_at as payment_updated_at,
        purchase.subtotal_minor as order_subtotal_minor,
        purchase.tax_minor as order_tax_minor,
        purchase.total_minor as order_total_minor,
        purchase.updated_at as order_updated_at
      from refunds refund
      join payments payment on payment.id = refund.payment_id
      join orders purchase on purchase.id = payment.order_id
      where refund.id = ${refundId}::uuid
    ), successful_allocations as (
      select allocation.id, allocation.refund_id, allocation.order_item_id,
        allocation.amount_minor, allocation.source,
        component.subtotal_minor, component.tax_minor, component.total_minor,
        component.currency
      from target
      join refunds sibling on sibling.payment_id = target.payment_id
        and sibling.status = 'succeeded'
      join refund_allocations allocation on allocation.refund_id = sibling.id
      left join refund_allocation_components component
        on component.refund_allocation_id = allocation.id
        and component.refund_id = allocation.refund_id
        and component.order_item_id = allocation.order_item_id
    ), allocation_rollup as (
      select order_item_id,
        coalesce(sum(amount_minor), 0)::int as refunded_total_minor,
        coalesce(sum(subtotal_minor), 0)::int as refunded_subtotal_minor,
        coalesce(sum(tax_minor), 0)::int as refunded_tax_minor
      from successful_allocations group by order_item_id
    ), active_draft as (
      select draft.* from target
      join refund_allocation_drafts draft on draft.refund_id = target.refund_id
        and draft.state = 'active'
    )
    select
      target.refund_id as "refundId",
      target.order_id as "orderId",
      target.status,
      target.allocation_status as "allocationStatus",
      target.amount_minor as "amountMinor",
      target.currency,
      target.order_subtotal_minor as "orderSubtotalMinor",
      target.order_tax_minor as "orderTaxMinor",
      target.order_total_minor as "orderTotalMinor",
      target.financial_evidence_status as "financialEvidenceStatus",
      coalesce((
        select jsonb_agg(balance.id order by balance.id)
        from stripe_balance_transactions balance
        where balance.source_family = 'refund'
          and balance.source_id = target.stripe_refund_id
      ), '[]'::jsonb) as "balanceTransactionIds",
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'orderItemId', item.id,
          'titleId', item.title_id,
          'soldAsTitle', item.title_snapshot,
          'soldAsCreatorName', item.creator_name_snapshot,
          'format', item.format,
          'paidSubtotalMinor', item.unit_subtotal_minor,
          'paidTaxMinor', item.tax_minor,
          'paidTotalMinor', item.total_minor,
          'currency', item.currency,
          'finalizedRefundTotalMinor', coalesce(rollup.refunded_total_minor, 0),
          'remainingRefundCapacityMinor',
            item.total_minor - coalesce(rollup.refunded_total_minor, 0)
        ) order by item.id)
        from order_items item
        left join allocation_rollup rollup on rollup.order_item_id = item.id
        where item.order_id = target.order_id
      ), '[]'::jsonb) as items,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'orderItemId', allocation.order_item_id,
          'totalMinor', allocation.amount_minor,
          'subtotalMinor', allocation.subtotal_minor,
          'taxMinor', allocation.tax_minor,
          'remainingSubtotalCapacityMinor',
            item.unit_subtotal_minor - rollup.refunded_subtotal_minor,
          'remainingTaxCapacityMinor', item.tax_minor - rollup.refunded_tax_minor,
          'source', allocation.source
        ) order by allocation.order_item_id)
        from successful_allocations allocation
        join order_items item on item.id = allocation.order_item_id
        join allocation_rollup rollup on rollup.order_item_id = allocation.order_item_id
        where allocation.refund_id = target.refund_id
      ), '[]'::jsonb) as "finalizedAllocations",
      (select count(*)::int from successful_allocations) as "allAllocationCount",
      (select count(*)::int from successful_allocations
        where subtotal_minor is not null and tax_minor is not null
          and total_minor is not null and currency is not null) as "allComponentCount",
      (select count(*)::int from successful_allocations
        where refund_id = target.refund_id) as "targetAllocationCount",
      (select id from active_draft) as "draftId",
      (select version from active_draft) as "draftVersion",
      (select state from active_draft) as "draftState",
      (select updated_by_admin_id = ${actorId}::uuid from active_draft)
        as "draftEditedByCurrentAdministrator",
      (select updated_at from active_draft) as "draftUpdatedAt",
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'orderItemId', draft_item.order_item_id,
          'proposedTotalMinor', draft_item.proposed_total_presentment_minor
        ) order by draft_item.order_item_id)
        from active_draft
        join refund_allocation_draft_items draft_item on draft_item.draft_id = active_draft.id
      ), '[]'::jsonb) as "draftItems",
      (select count(*)::int from financial_reconciliation_issues issue
        where issue.resource_type = 'refund' and issue.resource_id = target.refund_id
          and issue.state = 'open') as "openIssueCount",
      greatest(
        target.updated_at, target.payment_updated_at, target.order_updated_at,
        coalesce((select max(updated_at) from active_draft), target.updated_at),
        coalesce((select max(balance.last_imported_at)
          from stripe_balance_transactions balance
          where balance.source_family = 'refund'
            and balance.source_id = target.stripe_refund_id), target.updated_at)
      ) as "dataThroughAt",
      target.created_at as "createdAt",
      target.updated_at as "updatedAt"
    from target
  `;
}

function parseDetailRow(value: unknown): {
  readonly row: z.infer<typeof rowSchema>;
  readonly dtoWithoutFinancialState: Omit<RefundDetailDto, 'financialState'>;
} {
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success) return invalidData();
  const row = parsed.data;
  if (
    row.orderTotalMinor !== row.orderSubtotalMinor + row.orderTaxMinor ||
    row.allAllocationCount !== row.allComponentCount ||
    row.targetAllocationCount !== row.finalizedAllocations.length ||
    row.createdAt > row.updatedAt ||
    row.updatedAt > row.dataThroughAt
  ) {
    return invalidData();
  }

  const itemIds = new Set<string>();
  for (const item of row.items) {
    if (
      itemIds.has(item.orderItemId) ||
      item.currency !== row.currency ||
      item.paidTotalMinor !== item.paidSubtotalMinor + item.paidTaxMinor ||
      item.finalizedRefundTotalMinor + item.remainingRefundCapacityMinor !==
        item.paidTotalMinor
    ) {
      return invalidData();
    }
    itemIds.add(item.orderItemId);
  }
  if (
    safeTotal(row.items.map((item) => item.paidSubtotalMinor)) !== row.orderSubtotalMinor ||
    safeTotal(row.items.map((item) => item.paidTaxMinor)) !== row.orderTaxMinor ||
    safeTotal(row.items.map((item) => item.paidTotalMinor)) !== row.orderTotalMinor
  ) {
    return invalidData();
  }
  for (const allocation of row.finalizedAllocations) {
    if (
      !itemIds.has(allocation.orderItemId) ||
      allocation.totalMinor !== allocation.subtotalMinor + allocation.taxMinor
    ) {
      return invalidData();
    }
  }
  const targetAllocationTotal = safeTotal(
    row.finalizedAllocations.map((allocation) => allocation.totalMinor)
  );
  if (
    (row.allocationStatus === 'finalized' && targetAllocationTotal !== row.amountMinor) ||
    (['needs_review', 'draft'].includes(row.allocationStatus) && targetAllocationTotal !== 0)
  ) {
    return invalidData();
  }

  const draftParts = [
    row.draftId,
    row.draftVersion,
    row.draftState,
    row.draftEditedByCurrentAdministrator,
    row.draftUpdatedAt
  ];
  const noDraft = draftParts.every((part) => part === null);
  const completeDraft = draftParts.every((part) => part !== null);
  if ((!noDraft && !completeDraft) || (noDraft && row.draftItems.length !== 0)) {
    return invalidData();
  }

  let draft: RefundDetailDto['draft'] = null;
  if (completeDraft) {
    if (
      row.draftState !== 'active' ||
      row.draftItems.length !== row.items.length ||
      row.allocationStatus !== 'draft'
    ) {
      return invalidData();
    }
    const itemById = new Map(row.items.map((item) => [item.orderItemId, item]));
    const draftIds = new Set<string>();
    for (const item of row.draftItems) {
      const current = itemById.get(item.orderItemId);
      if (
        current === undefined ||
        draftIds.has(item.orderItemId)
      ) {
        return invalidData();
      }
      draftIds.add(item.orderItemId);
    }
    const proposedTotalMinor = safeTotal(
      row.draftItems.map((item) => item.proposedTotalMinor)
    );
    if (proposedTotalMinor !== row.amountMinor) return invalidData();
    draft = {
      draftId: row.draftId!,
      version: row.draftVersion!,
      state: row.draftState,
      lastEditedBy: row.draftEditedByCurrentAdministrator!
        ? 'current_administrator'
        : 'another_administrator',
      updatedAt: row.draftUpdatedAt!,
      proposedTotalMinor,
      remainderMinor: row.amountMinor - proposedTotalMinor,
      items: row.draftItems
    };
  } else if (row.allocationStatus === 'draft') {
    return invalidData();
  }

  return {
    row,
    dtoWithoutFinancialState: {
      refundId: row.refundId,
      orderId: row.orderId,
      status: row.status,
      allocationStatus: row.allocationStatus,
      amountMinor: row.amountMinor,
      currency: row.currency,
      orderSubtotalMinor: row.orderSubtotalMinor,
      orderTaxMinor: row.orderTaxMinor,
      orderTotalMinor: row.orderTotalMinor,
      items: row.items,
      finalizedAllocations: row.finalizedAllocations,
      draft,
      finalizationPreview: null,
      correctionPreview: null,
      recoveryPreviews: [],
      openIssueCount: row.openIssueCount,
      dataThroughAt: row.dataThroughAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  };
}

export async function getRefundReviewDetail(
  database: Database,
  actor: Actor,
  refundId: string,
  context: FinancialRequestContext,
  dependencies: FinancialAuthorizationDependencies = {}
): Promise<RefundDetailDto | null> {
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  const parsedRefundId = canonicalUuidSchema.safeParse(refundId);
  if (!parsedRefundId.success) return null;

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
    const rows = queryRows(await transaction.execute(
      refundDetailQuery(parsedRefundId.data, refreshedActor.id)
    ));
    if (rows.length === 0) return null;
    if (rows.length !== 1) return invalidData();
    const parsed = parseDetailRow(rows[0]);
    const payoutEvidence = await loadCurrentPayoutEvidence(
      transaction,
      parsed.row.balanceTransactionIds
    );
    const detail: RefundDetailDto = {
      ...parsed.dtoWithoutFinancialState,
      financialState: derivePublicFinancialState({
        financialEvidenceStatus: parsed.row.financialEvidenceStatus,
        payoutEvidence
      })
    };
    await auditFinancialRefundDetailRead(transaction, {
      actor: refreshedActor,
      refundId: parsedRefundId.data,
      context
    });
    return detail;
  });
}
