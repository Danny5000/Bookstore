import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  requireCapability,
  type Actor,
  type FinancialAuthorizationDependencies
} from '$lib/server/auth/admin-policy';
import { listRolesForUser, normalizeEmailAddress } from '$lib/server/auth/identity';
import { appendAuditEvent } from '$lib/server/audit/service';
import { CommerceConflictError, PermanentCommerceError } from '$lib/server/commerce/errors';
import type { FinancialAdminPrivateCommand } from '$lib/server/commerce/financial/admin-commands/contracts';
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
import { PermanentFinancialError, RetryableFinancialError } from '$lib/server/commerce/financial/errors';
import { lockFinancialProjectionRows } from '$lib/server/commerce/financial/locks';
import {
  loadFinancialProjectionAuthority,
  lockFinancialProjectionAuthority,
  lockFinancialProjectionEnrollment,
  type FinancialProjectionAuthority
} from '$lib/server/commerce/financial/rebase';
import * as refundFinancialProjection from '$lib/server/commerce/financial/sources/refund';
import type {
  FinancialIssueCode,
  LockedRefundProjectionInput,
  RefundFinancialRecomputeResult
} from '$lib/server/commerce/financial/types';
import { projectEffectiveEntitlement } from '$lib/server/commerce/grants';
import { lockOrder } from '$lib/server/commerce/lock';
import {
  planRefundAllocationComponents,
  type RefundComponentAllocation
} from '$lib/server/commerce/refund-allocation-components';
import { recomputeRefundPurchaseAccess } from '$lib/server/commerce/refund-access';
import {
  lockPaymentEntitlementFacts,
  lockPaymentPurchaseFacts,
  type PaymentEntitlementFacts,
  type PaymentPurchaseFacts
} from '$lib/server/commerce/reconciliation';
import type {
  EntitlementGrantRow,
  OrderItemRow,
  RefundAllocationComponentRow,
  RefundAllocationRow,
  RefundRow
} from '$lib/server/db/schema';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { FinancialRequestContext } from '$lib/server/commerce/reporting/context';
import type {
  FinancialAdminCommandSafeResultByCode,
  RefundFinalizationItemPreviewDto,
  RefundFinalizationPreviewDto
} from '$lib/types/financial-reporting';

const SAFE_MONEY_MAX = 99_999_999;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_ITEMS = 25;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const postgresTimestampPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/u;
const COMPONENT_PLANNING_TIME = new Date('2000-01-01T00:00:00.000Z');

const ISSUE_CODES = [
  'allocation_fork',
  'allocation_incomplete',
  'allocation_mismatch',
  'classification_fork',
  'correction_rebase_required',
  'currency_mismatch',
  'immutable_mismatch',
  'missing_source',
  'source_linkage_mismatch',
  'unsupported_category'
] as const satisfies readonly FinancialIssueCode[];

function timestampDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  let normalized = value.replace(' ', 'T');
  normalized = normalized.replace(/([+-][0-9]{2})$/u, '$1:00');
  normalized = normalized.replace(/([+-][0-9]{2})([0-9]{2})$/u, '$1:$2');
  return new Date(normalized);
}

const canonicalUuidSchema = z.string().regex(UUID_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const currencySchema = z.string().regex(CURRENCY_PATTERN);
const moneySchema = z.number().int().min(0).max(SAFE_MONEY_MAX);
const positiveMoneySchema = moneySchema.min(1);
const positiveVersionSchema = z.number().int().min(1).max(POSTGRES_INTEGER_MAX);
const timestampSchema = z.union([
  z.date(),
  z.string().regex(postgresTimestampPattern)
]).refine((value) => Number.isFinite(timestampDate(value).getTime()))
  .transform((value) => timestampDate(value));
const nullableTimestampSchema = timestampSchema.nullable();

const routingSchema = z.strictObject({
  paymentId: canonicalUuidSchema,
  orderId: canonicalUuidSchema
});

const previewRootSchema = z.strictObject({
  refundId: canonicalUuidSchema,
  refundPaymentId: canonicalUuidSchema,
  stripeRefundId: z.string().min(1).max(255),
  refundStatus: z.enum(['pending', 'succeeded', 'failed', 'canceled']),
  refundAmountMinor: positiveMoneySchema,
  refundCurrency: currencySchema,
  refundProviderCreatedAt: timestampSchema,
  refundAllocationStatus: z.enum([
    'not_applicable', 'needs_review', 'draft', 'finalized', 'exception'
  ]),
  refundFinancialEvidenceStatus: z.enum(['pending', 'fee_reconciled', 'exception']),
  paymentId: canonicalUuidSchema,
  paymentOrderId: canonicalUuidSchema,
  stripePaymentIntentId: z.string().min(1).max(255),
  paymentStatus: z.enum(['pending', 'succeeded', 'failed']),
  paymentAmountMinor: moneySchema,
  paymentCurrency: currencySchema,
  paymentPaidAt: nullableTimestampSchema,
  paymentFinancialEvidenceStatus: z.enum(['pending', 'fee_reconciled', 'exception']),
  orderId: canonicalUuidSchema,
  orderStatus: z.enum([
    'checkout_pending', 'checkout_open', 'payment_pending', 'paid', 'expired',
    'failed', 'exception'
  ]),
  orderInitiatingUserId: canonicalUuidSchema.nullable(),
  orderGuestIdentityId: canonicalUuidSchema.nullable(),
  orderCurrency: currencySchema,
  orderSubtotalMinor: moneySchema,
  orderTaxMinor: moneySchema.nullable(),
  orderTotalMinor: moneySchema.nullable(),
  orderPaidAt: nullableTimestampSchema
});

const lockedOrderSchema = z.strictObject({
  id: canonicalUuidSchema,
  status: previewRootSchema.shape.orderStatus,
  initiatingUserId: canonicalUuidSchema.nullable(),
  guestIdentityId: canonicalUuidSchema.nullable(),
  currency: currencySchema,
  subtotalMinor: moneySchema,
  taxMinor: moneySchema.nullable(),
  totalMinor: moneySchema.nullable(),
  paidAt: nullableTimestampSchema
});

const lockedPaymentSchema = z.strictObject({
  id: canonicalUuidSchema,
  orderId: canonicalUuidSchema,
  stripePaymentIntentId: z.string().min(1).max(255),
  status: previewRootSchema.shape.paymentStatus,
  amountMinor: moneySchema,
  currency: currencySchema,
  paidAt: nullableTimestampSchema,
  financialEvidenceStatus: previewRootSchema.shape.paymentFinancialEvidenceStatus
});

const orderItemSchema = z.strictObject({
  id: canonicalUuidSchema,
  orderId: canonicalUuidSchema,
  titleId: canonicalUuidSchema,
  titleSnapshot: z.string().min(1).max(500),
  creatorNameSnapshot: z.string().min(1).max(500),
  format: z.enum(['prose', 'comic']),
  currency: currencySchema,
  unitSubtotalMinor: moneySchema,
  taxMinor: moneySchema.nullable(),
  totalMinor: moneySchema.nullable(),
  createdAt: timestampSchema
});

const refundSchema = z.strictObject({
  id: canonicalUuidSchema,
  paymentId: canonicalUuidSchema,
  stripeRefundId: z.string().min(1).max(255),
  status: z.enum(['pending', 'succeeded', 'failed', 'canceled']),
  amountMinor: positiveMoneySchema,
  currency: currencySchema,
  providerCreatedAt: timestampSchema,
  allocationStatus: z.enum([
    'not_applicable', 'needs_review', 'draft', 'finalized', 'exception'
  ]),
  financialEvidenceStatus: z.enum(['pending', 'fee_reconciled', 'exception'])
});

const draftSchema = z.strictObject({
  id: canonicalUuidSchema,
  refundId: canonicalUuidSchema,
  state: z.enum(['active', 'finalized', 'discarded']),
  version: positiveVersionSchema,
  updatedCorrelationId: z.string().min(1).max(100),
  updatedAt: timestampSchema
});

const draftItemSchema = z.strictObject({
  id: canonicalUuidSchema,
  draftId: canonicalUuidSchema,
  orderItemId: canonicalUuidSchema,
  proposedTotalPresentmentMinor: moneySchema,
  updatedAt: timestampSchema
});

const allocationSchema = z.strictObject({
  id: canonicalUuidSchema,
  refundId: canonicalUuidSchema,
  orderItemId: canonicalUuidSchema,
  amountMinor: positiveMoneySchema,
  source: z.enum(['automatic', 'administrative']),
  createdAt: timestampSchema
});

const componentSchema = z.strictObject({
  id: canonicalUuidSchema,
  refundAllocationId: canonicalUuidSchema,
  refundId: canonicalUuidSchema,
  orderItemId: canonicalUuidSchema,
  subtotalMinor: moneySchema,
  taxMinor: moneySchema,
  totalMinor: positiveMoneySchema,
  currency: currencySchema,
  createdAt: timestampSchema
});

const correctionSetSchema = z.strictObject({
  id: canonicalUuidSchema,
  refundId: canonicalUuidSchema,
  correctionVersion: positiveVersionSchema,
  kind: z.enum(['allocation_attribution_correction', 'classifier_rebase']),
  baseAllocationSetId: canonicalUuidSchema,
  predecessorCorrectionSetId: canonicalUuidSchema.nullable(),
  sourceFingerprintSha256: sha256Schema,
  correlationId: z.string().min(1).max(100),
  createdAt: timestampSchema
});

const correctionItemSchema = z.strictObject({
  id: canonicalUuidSchema,
  correctionSetId: canonicalUuidSchema,
  domain: z.enum(['presentment', 'settlement']),
  sourceAllocationSetId: canonicalUuidSchema.nullable(),
  orderItemId: canonicalUuidSchema,
  component: z.enum(['refund_subtotal', 'refund_tax', 'refund_fee']),
  currency: currencySchema,
  approvedAbsoluteMinor: z.number().int().min(-SAFE_MONEY_MAX).max(SAFE_MONEY_MAX),
  deltaMinor: z.number().int().min(-SAFE_MONEY_MAX).max(SAFE_MONEY_MAX),
  stableTieBreakKey: z.string().min(1).max(255)
});

const grantStateSchema = z.enum(['unclaimed', 'active', 'suspended', 'revoked']);
const grantSchema = z.strictObject({
  id: canonicalUuidSchema,
  titleId: canonicalUuidSchema,
  userId: canonicalUuidSchema.nullable(),
  source: z.enum(['purchase', 'preserved', 'administrative']),
  orderItemId: canonicalUuidSchema.nullable(),
  recoveryRefundAllocationId: canonicalUuidSchema.nullable(),
  state: grantStateSchema,
  stateReason: z.string().min(1).max(100),
  grantedAt: timestampSchema,
  suspendedAt: nullableTimestampSchema,
  revokedAt: nullableTimestampSchema,
  updatedAt: timestampSchema
});

const entitlementStateRowSchema = z.strictObject({
  userId: canonicalUuidSchema,
  titleId: canonicalUuidSchema,
  active: z.boolean()
});

const recipientSchema = z.strictObject({
  userId: canonicalUuidSchema,
  email: z.string().min(1).max(320),
  emailVerified: z.boolean()
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
  missingSourceCount: z.number().int().min(0).max(POSTGRES_INTEGER_MAX),
  proposedIssueCode: z.string().min(1).max(100).nullable()
});

const writeIdSchema = z.strictObject({ id: canonicalUuidSchema });
const finalizedDraftWriteSchema = z.strictObject({
  id: canonicalUuidSchema,
  version: positiveVersionSchema
});
const grantAfterStateSchema = z.strictObject({
  id: canonicalUuidSchema,
  state: grantStateSchema
});

type PreviewRootRow = z.output<typeof previewRootSchema>;
type CanonicalOrderItem = z.output<typeof orderItemSchema>;
type CanonicalRefund = z.output<typeof refundSchema>;
type CanonicalDraft = z.output<typeof draftSchema>;
type CanonicalDraftItem = z.output<typeof draftItemSchema>;
type CanonicalAllocation = z.output<typeof allocationSchema>;
type CanonicalComponent = z.output<typeof componentSchema>;
type CanonicalCorrectionSet = z.output<typeof correctionSetSchema>;
type CanonicalCorrectionItem = z.output<typeof correctionItemSchema>;
type CanonicalGrant = z.output<typeof grantSchema>;
type EntitlementStateRow = z.output<typeof entitlementStateRowSchema>;
type RecipientRow = z.output<typeof recipientSchema>;
type SelectedTip = z.output<typeof selectedTipSchema>;
type ProjectionHead = z.output<typeof projectionHeadSchema>;

interface QueryResult {
  readonly rows?: readonly unknown[];
}

interface CanonicalGraph {
  readonly orderItems: readonly CanonicalOrderItem[];
  readonly refunds: readonly CanonicalRefund[];
  readonly refundDrafts: readonly CanonicalDraft[];
  readonly refundDraftItems: readonly CanonicalDraftItem[];
  readonly refundAllocations: readonly CanonicalAllocation[];
  readonly refundComponents: readonly CanonicalComponent[];
  readonly correctionSets: readonly CanonicalCorrectionSet[];
  readonly correctionItems: readonly CanonicalCorrectionItem[];
}

interface EntitlementSnapshot {
  readonly purchaseGrants: readonly CanonicalGrant[];
  readonly affectedScopeGrants: readonly CanonicalGrant[];
  readonly scopeStates: readonly EntitlementStateRow[];
  readonly recipients: readonly RecipientRow[];
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

interface FinalizationEffectPrediction {
  readonly orderItemId: string;
  readonly grantId: string;
  readonly beforeState: CanonicalGrant['state'];
  readonly afterState: CanonicalGrant['state'];
  readonly beforeEffectiveAccess: boolean;
  readonly afterEffectiveAccess: boolean;
  readonly transition: 'unchanged' | 'revoked_by_finalization';
}

interface DerivedFinalization {
  readonly dto: RefundFinalizationPreviewDto;
  readonly activeDraft: CanonicalDraft;
  readonly targetRefund: CanonicalRefund;
  readonly componentPlans: ReturnType<typeof planRefundAllocationComponents>;
  readonly effects: readonly FinalizationEffectPrediction[];
  readonly expectedProjectedScopes: readonly {
    readonly userId: string;
    readonly titleId: string;
    readonly beforeActive: boolean;
    readonly afterActive: boolean;
  }[];
  readonly emailPlan: {
    readonly userId: string;
    readonly to: string;
    readonly affectedTitleCount: number;
  } | null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Refund finalization was aborted.', 'AbortError');
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

function safeTotal(values: readonly number[]): number {
  let result = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > SAFE_MONEY_MAX) {
      return permanentFailure();
    }
    result += value;
    if (!Number.isSafeInteger(result) || result > SAFE_MONEY_MAX) {
      return permanentFailure();
    }
  }
  return result;
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function uniqueById<T extends { readonly id: string }>(values: readonly T[]): boolean {
  return new Set(values.map((value) => value.id)).size === values.length;
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

async function discoverRouting(
  transaction: DatabaseTransaction,
  refundId: string
): Promise<z.output<typeof routingSchema> | null> {
  const values = await executeRows(transaction, sql`
    /* refund-finalization:routing */
    select refund.payment_id as "paymentId", payment.order_id as "orderId"
    from refunds refund
    join payments payment on payment.id = refund.payment_id
    where refund.id = ${refundId}::uuid
  `);
  if (values.length === 0) return null;
  return parseOne(routingSchema, values);
}

async function loadPreviewRoot(
  transaction: DatabaseTransaction,
  refundId: string
): Promise<PreviewRootRow | null> {
  const values = await executeRows(transaction, sql`
    /* refund-finalization:preview-root */
    select refund.id as "refundId", refund.payment_id as "refundPaymentId",
      refund.stripe_refund_id as "stripeRefundId", refund.status as "refundStatus",
      refund.amount_minor as "refundAmountMinor", refund.currency as "refundCurrency",
      refund.provider_created_at as "refundProviderCreatedAt",
      refund.allocation_status as "refundAllocationStatus",
      refund.financial_evidence_status as "refundFinancialEvidenceStatus",
      payment.id as "paymentId", payment.order_id as "paymentOrderId",
      payment.stripe_payment_intent_id as "stripePaymentIntentId",
      payment.status as "paymentStatus", payment.amount_minor as "paymentAmountMinor",
      payment.currency as "paymentCurrency", payment.paid_at as "paymentPaidAt",
      payment.financial_evidence_status as "paymentFinancialEvidenceStatus",
      orders.id as "orderId", orders.status as "orderStatus",
      orders.initiating_user_id as "orderInitiatingUserId",
      orders.guest_identity_id as "orderGuestIdentityId",
      orders.currency as "orderCurrency", orders.subtotal_minor as "orderSubtotalMinor",
      orders.tax_minor as "orderTaxMinor", orders.total_minor as "orderTotalMinor",
      orders.paid_at as "orderPaidAt"
    from refunds refund
    join payments payment on payment.id = refund.payment_id
    join orders on orders.id = payment.order_id
    where refund.id = ${refundId}::uuid
  `);
  if (values.length === 0) return null;
  return parseOne(previewRootSchema, values);
}

async function loadPreviewGraph(
  transaction: DatabaseTransaction,
  root: PreviewRootRow
): Promise<CanonicalGraph> {
  const orderItems = parseMany(orderItemSchema, await executeRows(transaction, sql`
    /* refund-finalization:preview-items */
    select id, order_id as "orderId", title_id as "titleId",
      title_snapshot as "titleSnapshot", creator_name_snapshot as "creatorNameSnapshot",
      format, currency, unit_subtotal_minor as "unitSubtotalMinor",
      tax_minor as "taxMinor", total_minor as "totalMinor", created_at as "createdAt"
    from order_items where order_id = ${root.orderId}::uuid order by id
  `));
  const refunds = parseMany(refundSchema, await executeRows(transaction, sql`
    /* refund-finalization:preview-refunds */
    select id, payment_id as "paymentId", stripe_refund_id as "stripeRefundId", status,
      amount_minor as "amountMinor", currency, provider_created_at as "providerCreatedAt",
      allocation_status as "allocationStatus",
      financial_evidence_status as "financialEvidenceStatus"
    from refunds where payment_id = ${root.paymentId}::uuid order by id
  `));
  const refundDrafts = parseMany(draftSchema, await executeRows(transaction, sql`
    /* refund-finalization:preview-drafts */
    select draft.id, draft.refund_id as "refundId", draft.state, draft.version,
      draft.updated_correlation_id as "updatedCorrelationId", draft.updated_at as "updatedAt"
    from refund_allocation_drafts draft
    join refunds refund on refund.id = draft.refund_id
    where refund.payment_id = ${root.paymentId}::uuid order by draft.id
  `));
  const refundDraftItems = parseMany(draftItemSchema, await executeRows(transaction, sql`
    /* refund-finalization:preview-draft-items */
    select item.id, item.draft_id as "draftId", item.order_item_id as "orderItemId",
      item.proposed_total_presentment_minor as "proposedTotalPresentmentMinor",
      item.updated_at as "updatedAt"
    from refund_allocation_draft_items item
    join refund_allocation_drafts draft on draft.id = item.draft_id
    join refunds refund on refund.id = draft.refund_id
    where refund.payment_id = ${root.paymentId}::uuid order by item.id
  `));
  const refundAllocations = parseMany(allocationSchema, await executeRows(transaction, sql`
    /* refund-finalization:preview-allocations */
    select allocation.id, allocation.refund_id as "refundId",
      allocation.order_item_id as "orderItemId", allocation.amount_minor as "amountMinor",
      allocation.source, allocation.created_at as "createdAt"
    from refund_allocations allocation
    join refunds refund on refund.id = allocation.refund_id
    where refund.payment_id = ${root.paymentId}::uuid order by allocation.id
  `));
  const refundComponents = parseMany(componentSchema, await executeRows(transaction, sql`
    /* refund-finalization:preview-components */
    select component.id, component.refund_allocation_id as "refundAllocationId",
      component.refund_id as "refundId", component.order_item_id as "orderItemId",
      component.subtotal_minor as "subtotalMinor", component.tax_minor as "taxMinor",
      component.total_minor as "totalMinor", component.currency,
      component.created_at as "createdAt"
    from refund_allocation_components component
    join refunds refund on refund.id = component.refund_id
    where refund.payment_id = ${root.paymentId}::uuid order by component.id
  `));
  const correctionSets = parseMany(correctionSetSchema, await executeRows(transaction, sql`
    /* refund-finalization:preview-correction-sets */
    select correction.id, correction.refund_id as "refundId",
      correction.correction_version as "correctionVersion", correction.kind,
      correction.base_allocation_set_id as "baseAllocationSetId",
      correction.predecessor_correction_set_id as "predecessorCorrectionSetId",
      correction.source_fingerprint_sha256 as "sourceFingerprintSha256",
      correction.correlation_id as "correlationId", correction.created_at as "createdAt"
    from refund_reporting_correction_sets correction
    join refunds refund on refund.id = correction.refund_id
    where refund.payment_id = ${root.paymentId}::uuid order by correction.id
  `));
  const correctionItems = parseMany(correctionItemSchema, await executeRows(transaction, sql`
    /* refund-finalization:preview-correction-items */
    select item.id, item.correction_set_id as "correctionSetId", item.domain,
      item.source_allocation_set_id as "sourceAllocationSetId",
      item.order_item_id as "orderItemId", item.component, item.currency,
      item.approved_absolute_minor as "approvedAbsoluteMinor",
      item.delta_minor as "deltaMinor", item.stable_tie_break_key as "stableTieBreakKey"
    from refund_reporting_correction_items item
    join refund_reporting_correction_sets correction on correction.id = item.correction_set_id
    join refunds refund on refund.id = correction.refund_id
    where refund.payment_id = ${root.paymentId}::uuid order by item.id
  `));
  return {
    orderItems,
    refunds,
    refundDrafts,
    refundDraftItems,
    refundAllocations,
    refundComponents,
    correctionSets,
    correctionItems
  };
}

async function loadPreviewPurchaseGrants(
  transaction: DatabaseTransaction,
  orderId: string
): Promise<readonly CanonicalGrant[]> {
  return parseMany(grantSchema, await executeRows(transaction, sql`
    /* refund-finalization:preview-purchase-grants */
    select grant_row.id, grant_row.title_id as "titleId", grant_row.user_id as "userId",
      grant_row.source, grant_row.order_item_id as "orderItemId",
      grant_row.recovery_refund_allocation_id as "recoveryRefundAllocationId",
      grant_row.state, grant_row.state_reason as "stateReason",
      grant_row.granted_at as "grantedAt", grant_row.suspended_at as "suspendedAt",
      grant_row.revoked_at as "revokedAt", grant_row.updated_at as "updatedAt"
    from entitlement_grants grant_row
    join order_items item on item.id = grant_row.order_item_id
    where item.order_id = ${orderId}::uuid and grant_row.source = 'purchase'
    order by grant_row.id
  `));
}

function canonicalScopes(grants: readonly Pick<CanonicalGrant, 'userId' | 'titleId'>[]): readonly {
  readonly userId: string;
  readonly titleId: string;
}[] {
  return [...new Map(grants.flatMap((grant) => grant.userId === null
    ? []
    : [[`${grant.userId}\0${grant.titleId}`, {
        userId: grant.userId,
        titleId: grant.titleId
      }] as const])).values()].sort((left, right) =>
    compareC(left.userId, right.userId) || compareC(left.titleId, right.titleId)
  );
}

function scopePredicate(scopes: readonly { readonly userId: string; readonly titleId: string }[]): SQL {
  if (scopes.length === 0) return sql`false`;
  return sql`(user_id, title_id) in (${sql.join(scopes.map((scope) =>
    sql`(${scope.userId}::uuid, ${scope.titleId}::uuid)`), sql`, `)})`;
}

async function loadAffectedScopeGrants(
  transaction: DatabaseTransaction,
  scopes: readonly { readonly userId: string; readonly titleId: string }[]
): Promise<readonly CanonicalGrant[]> {
  return parseMany(grantSchema, await executeRows(transaction, sql`
    /* refund-finalization:scope-grants */
    select id, title_id as "titleId", user_id as "userId", source,
      order_item_id as "orderItemId",
      recovery_refund_allocation_id as "recoveryRefundAllocationId", state,
      state_reason as "stateReason", granted_at as "grantedAt",
      suspended_at as "suspendedAt", revoked_at as "revokedAt", updated_at as "updatedAt"
    from entitlement_grants where ${scopePredicate(scopes)} order by id
  `));
}

async function loadScopeStates(
  transaction: DatabaseTransaction,
  scopes: readonly { readonly userId: string; readonly titleId: string }[],
  lockRows: boolean
): Promise<readonly EntitlementStateRow[]> {
  const values = parseMany(entitlementStateRowSchema, await executeRows(transaction, sql`
    /* refund-finalization:scope-states */
    select user_id as "userId", title_id as "titleId", (revoked_at is null) as active
    from entitlements where ${scopePredicate(scopes)} order by user_id, title_id
    ${lockRows ? sql`for update` : sql``}
  `));
  const byKey = new Map<string, EntitlementStateRow>();
  for (const value of values) {
    const key = `${value.userId}\0${value.titleId}`;
    if (byKey.has(key) || !scopes.some((scope) =>
      scope.userId === value.userId && scope.titleId === value.titleId
    )) return permanentFailure();
    byKey.set(key, value);
  }
  return scopes.map((scope) => byKey.get(`${scope.userId}\0${scope.titleId}`) ?? {
    ...scope,
    active: false
  });
}

async function loadRecipients(
  transaction: DatabaseTransaction,
  userIds: readonly string[]
): Promise<readonly RecipientRow[]> {
  const ids = [...new Set(userIds)].sort(compareC);
  const values = parseMany(recipientSchema, await executeRows(transaction, sql`
    /* refund-finalization:recipients */
    select id as "userId", email, email_verified as "emailVerified"
    from "user"
    where ${ids.length === 0
      ? sql`false`
      : sql`id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`}
    order by id
  `));
  if (new Set(values.map((value) => value.userId)).size !== values.length ||
    values.some((value) => !ids.includes(value.userId))) return permanentFailure();
  return values;
}

async function loadPreviewEntitlements(
  transaction: DatabaseTransaction,
  orderId: string
): Promise<EntitlementSnapshot> {
  const purchaseGrants = await loadPreviewPurchaseGrants(transaction, orderId);
  const scopes = canonicalScopes(purchaseGrants);
  const scopeGrants = await loadAffectedScopeGrants(transaction, scopes);
  const affectedScopeGrants = [...new Map([
    ...purchaseGrants,
    ...scopeGrants
  ].map((grant) => [grant.id, grant])).values()].sort((left, right) =>
    compareC(left.id, right.id)
  );
  const scopeStates = await loadScopeStates(transaction, scopes, false);
  const recipients = await loadRecipients(
    transaction,
    purchaseGrants.flatMap((grant) => grant.userId === null ? [] : [grant.userId])
  );
  return { purchaseGrants, affectedScopeGrants, scopeStates, recipients };
}

function uuidList(values: readonly string[]): SQL {
  return sql.join(values.map((id) => sql`${id}::uuid`), sql`, `);
}

async function loadFinancialDiscovery(
  transaction: DatabaseTransaction,
  providerRefundId: string,
  authority: FinancialProjectionAuthority
): Promise<FinancialDiscovery> {
  const sourceBalances = parseMany(balanceRowSchema, await executeRows(transaction, sql`
    /* refund-finalization:source-balances */
    select id, fingerprint_sha256 as "fingerprintSha256"
    from stripe_balance_transactions
    where source_family = 'refund' and source_id = ${providerRefundId}
    order by id
  `));
  if (!uniqueById(sourceBalances)) return permanentFailure();
  const sourceIds = sourceBalances.map((row) => row.id);
  const payoutMemberships = parseMany(payoutMembershipSchema, await executeRows(transaction, sql`
    /* refund-finalization:payout-memberships */
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
  `));
  const generationByPayout = new Map<string, number>();
  for (const membership of payoutMemberships) {
    const previous = generationByPayout.get(membership.payoutId);
    if (previous !== undefined && previous !== membership.expectedGeneration) {
      return permanentFailure();
    }
    generationByPayout.set(membership.payoutId, membership.expectedGeneration);
  }
  const payoutGenerations = [...generationByPayout].map(([payoutId, expectedGeneration]) => ({
    payoutId,
    expectedGeneration
  })).sort((left, right) => compareC(left.payoutId, right.payoutId));
  const closureBalanceTransactionIds = [...new Set([
    ...sourceIds,
    ...payoutMemberships.map((row) => row.balanceTransactionId)
  ])].sort(compareC);
  const selectedTips = parseMany(selectedTipSchema, await executeRows(transaction, sql`
    /* refund-finalization:selected-tips */
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
    /* refund-finalization:projection-heads */
    select balance_transaction_id as "balanceTransactionId", basis,
      base_set_id as "baseSetId", compatible_correction_tip_id as "compatibleCorrectionTipId",
      is_complete as "isComplete", missing_source_count as "missingSourceCount",
      proposed_issue_code as "proposedIssueCode"
    from current_financial_projection_heads
    where ${sourceIds.length === 0
      ? sql`false`
      : sql`balance_transaction_id in (${uuidList(sourceIds)})`}
    order by balance_transaction_id, basis
  `));
  if (
    new Set(selectedTips.map((tip) => tip.id)).size !== selectedTips.length ||
    selectedTips.some((tip) => !sourceIds.includes(tip.balanceTransactionId)) ||
    new Set(projectionHeads.map((head) => `${head.balanceTransactionId}\0${head.basis}`)).size !==
      projectionHeads.length ||
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

function canonicalGraphFromPurchaseFacts(facts: PaymentPurchaseFacts): CanonicalGraph {
  const orderItems = parseMany(orderItemSchema, facts.orderItems.map((item) => ({
    id: item.id,
    orderId: item.orderId,
    titleId: item.titleId,
    titleSnapshot: item.titleSnapshot,
    creatorNameSnapshot: item.creatorNameSnapshot,
    format: item.format,
    currency: item.currency,
    unitSubtotalMinor: item.unitSubtotalMinor,
    taxMinor: item.taxMinor,
    totalMinor: item.totalMinor,
    createdAt: item.createdAt
  })));
  const refunds = parseMany(refundSchema, facts.refunds.map((refund) => ({
    id: refund.id,
    paymentId: refund.paymentId,
    stripeRefundId: refund.stripeRefundId,
    status: refund.status,
    amountMinor: refund.amountMinor,
    currency: refund.currency,
    providerCreatedAt: refund.providerCreatedAt,
    allocationStatus: refund.allocationStatus,
    financialEvidenceStatus: refund.financialEvidenceStatus
  })));
  const refundDrafts = parseMany(draftSchema, facts.refundDrafts.map((draft) => ({
    id: draft.id,
    refundId: draft.refundId,
    state: draft.state,
    version: draft.version,
    updatedCorrelationId: draft.updatedCorrelationId,
    updatedAt: draft.updatedAt
  })));
  const refundDraftItems = parseMany(draftItemSchema, facts.refundDraftItems.map((item) => ({
    id: item.id,
    draftId: item.draftId,
    orderItemId: item.orderItemId,
    proposedTotalPresentmentMinor: item.proposedTotalPresentmentMinor,
    updatedAt: item.updatedAt
  })));
  const refundAllocations = parseMany(allocationSchema, facts.refundAllocations.map(
    (allocation) => ({
      id: allocation.id,
      refundId: allocation.refundId,
      orderItemId: allocation.orderItemId,
      amountMinor: allocation.amountMinor,
      source: allocation.source,
      createdAt: allocation.createdAt
    })
  ));
  const refundComponents = parseMany(componentSchema, facts.refundComponents.map(
    (component) => ({
      id: component.id,
      refundAllocationId: component.refundAllocationId,
      refundId: component.refundId,
      orderItemId: component.orderItemId,
      subtotalMinor: component.subtotalMinor,
      taxMinor: component.taxMinor,
      totalMinor: component.totalMinor,
      currency: component.currency,
      createdAt: component.createdAt
    })
  ));
  const correctionSets = parseMany(correctionSetSchema, facts.correctionSets.map(
    (correction) => ({
      id: correction.id,
      refundId: correction.refundId,
      correctionVersion: correction.correctionVersion,
      kind: correction.kind,
      baseAllocationSetId: correction.baseAllocationSetId,
      predecessorCorrectionSetId: correction.predecessorCorrectionSetId,
      sourceFingerprintSha256: correction.sourceFingerprintSha256,
      correlationId: correction.correlationId,
      createdAt: correction.createdAt
    })
  ));
  const correctionItems = parseMany(correctionItemSchema, facts.correctionItems.map((item) => ({
    id: item.id,
    correctionSetId: item.correctionSetId,
    domain: item.domain,
    sourceAllocationSetId: item.sourceAllocationSetId,
    orderItemId: item.orderItemId,
    component: item.component,
    currency: item.currency,
    approvedAbsoluteMinor: item.approvedAbsoluteMinor,
    deltaMinor: item.deltaMinor,
    stableTieBreakKey: item.stableTieBreakKey
  })));
  return {
    orderItems,
    refunds,
    refundDrafts,
    refundDraftItems,
    refundAllocations,
    refundComponents,
    correctionSets,
    correctionItems
  };
}

function canonicalEntitlementSnapshot(
  facts: PaymentEntitlementFacts,
  scopeStates: readonly EntitlementStateRow[],
  recipients: readonly RecipientRow[]
): EntitlementSnapshot {
  const mapGrant = (grant: EntitlementGrantRow): CanonicalGrant => parseOne(grantSchema, [{
    id: grant.id,
    titleId: grant.titleId,
    userId: grant.userId,
    source: grant.source,
    orderItemId: grant.orderItemId,
    recoveryRefundAllocationId: grant.recoveryRefundAllocationId,
    state: grant.state,
    stateReason: grant.stateReason,
    grantedAt: grant.grantedAt,
    suspendedAt: grant.suspendedAt,
    revokedAt: grant.revokedAt,
    updatedAt: grant.updatedAt
  }]);
  return {
    purchaseGrants: facts.grants.map(mapGrant),
    affectedScopeGrants: facts.affectedScopeGrants.map(mapGrant),
    scopeStates,
    recipients
  };
}

function rootFromLockedFacts(
  commandRefundId: string,
  order: z.output<typeof lockedOrderSchema>,
  payment: z.output<typeof lockedPaymentSchema>,
  graph: CanonicalGraph
): PreviewRootRow {
  const matches = graph.refunds.filter((refund) => refund.id === commandRefundId);
  if (matches.length !== 1) return permanentFailure();
  const refund = matches[0]!;
  return parseOne(previewRootSchema, [{
    refundId: refund.id,
    refundPaymentId: refund.paymentId,
    stripeRefundId: refund.stripeRefundId,
    refundStatus: refund.status,
    refundAmountMinor: refund.amountMinor,
    refundCurrency: refund.currency,
    refundProviderCreatedAt: refund.providerCreatedAt,
    refundAllocationStatus: refund.allocationStatus,
    refundFinancialEvidenceStatus: refund.financialEvidenceStatus,
    paymentId: payment.id,
    paymentOrderId: payment.orderId,
    stripePaymentIntentId: payment.stripePaymentIntentId,
    paymentStatus: payment.status,
    paymentAmountMinor: payment.amountMinor,
    paymentCurrency: payment.currency,
    paymentPaidAt: payment.paidAt,
    paymentFinancialEvidenceStatus: payment.financialEvidenceStatus,
    orderId: order.id,
    orderStatus: order.status,
    orderInitiatingUserId: order.initiatingUserId,
    orderGuestIdentityId: order.guestIdentityId,
    orderCurrency: order.currency,
    orderSubtotalMinor: order.subtotalMinor,
    orderTaxMinor: order.taxMinor,
    orderTotalMinor: order.totalMinor,
    orderPaidAt: order.paidAt
  }]);
}

function compareRefundChronology(left: CanonicalRefund, right: CanonicalRefund): number {
  return left.providerCreatedAt.getTime() - right.providerCreatedAt.getTime() ||
    compareC(left.stripeRefundId, right.stripeRefundId) || compareC(left.id, right.id);
}

function hasCompleteFinalizedAttribution(
  refund: CanonicalRefund,
  graph: CanonicalGraph
): boolean {
  if (refund.allocationStatus !== 'finalized') return false;
  const allocations = graph.refundAllocations.filter((allocation) =>
    allocation.refundId === refund.id
  );
  if (safeTotal(allocations.map((allocation) => allocation.amountMinor)) !== refund.amountMinor) {
    return false;
  }
  return allocations.every((allocation) => graph.refundComponents.some((component) =>
    component.refundAllocationId === allocation.id &&
    component.refundId === allocation.refundId &&
    component.orderItemId === allocation.orderItemId &&
    component.totalMinor === allocation.amountMinor
  ));
}

function canonicalDate(value: Date): string {
  return value.toISOString();
}

function activeCorrectionTips(
  correctionSets: readonly CanonicalCorrectionSet[]
): readonly CanonicalCorrectionSet[] {
  const successorIds = new Set(correctionSets.flatMap((correction) =>
    correction.predecessorCorrectionSetId === null ? [] : [correction.predecessorCorrectionSetId]
  ));
  return correctionSets.filter((correction) => !successorIds.has(correction.id))
    .sort((left, right) => compareC(left.id, right.id));
}

function normalizedRecipientBindings(recipients: readonly RecipientRow[]): readonly {
  readonly userId: string;
  readonly emailVerified: boolean;
  readonly emailDigestSha256: string;
}[] {
  return [...recipients].sort((left, right) => compareC(left.userId, right.userId))
    .map((recipient) => {
      let normalized: string;
      try {
        normalized = normalizeEmailAddress(recipient.email);
      } catch {
        return permanentFailure();
      }
      if (normalized !== recipient.email) return permanentFailure();
      return {
        userId: recipient.userId,
        emailVerified: recipient.emailVerified,
        emailDigestSha256: canonicalHash(normalized)
      };
    });
}

function fingerprintDocument(input: {
  readonly root: PreviewRootRow;
  readonly graph: CanonicalGraph;
  readonly entitlement: EntitlementSnapshot;
  readonly authority: FinancialProjectionAuthority;
  readonly financial: FinancialDiscovery;
  readonly draft: CanonicalDraft;
  readonly draftItems: readonly CanonicalDraftItem[];
  readonly componentPlans: ReturnType<typeof planRefundAllocationComponents>;
  readonly previewItems: readonly RefundFinalizationItemPreviewDto[];
}) {
  const { root, graph, entitlement, authority, financial, draft, draftItems,
    componentPlans, previewItems } = input;
  return {
    schema: 'refund-finalization-preview-v1',
    refund: {
      id: root.refundId,
      paymentId: root.refundPaymentId,
      providerIdDigestSha256: canonicalHash(root.stripeRefundId),
      status: root.refundStatus,
      amountMinor: root.refundAmountMinor,
      currency: root.refundCurrency,
      providerCreatedAt: canonicalDate(root.refundProviderCreatedAt),
      allocationStatus: root.refundAllocationStatus,
      financialEvidenceStatus: root.refundFinancialEvidenceStatus
    },
    payment: {
      id: root.paymentId,
      orderId: root.paymentOrderId,
      providerIdDigestSha256: canonicalHash(root.stripePaymentIntentId),
      status: root.paymentStatus,
      amountMinor: root.paymentAmountMinor,
      currency: root.paymentCurrency,
      paidAt: root.paymentPaidAt?.toISOString() ?? null,
      financialEvidenceStatus: root.paymentFinancialEvidenceStatus
    },
    order: {
      id: root.orderId,
      status: root.orderStatus,
      ownerBindingDigestSha256: canonicalHash({
        initiatingUserId: root.orderInitiatingUserId,
        guestIdentityId: root.orderGuestIdentityId
      }),
      currency: root.orderCurrency,
      subtotalMinor: root.orderSubtotalMinor,
      taxMinor: root.orderTaxMinor,
      totalMinor: root.orderTotalMinor,
      paidAt: root.orderPaidAt?.toISOString() ?? null
    },
    orderItems: [...graph.orderItems].sort((left, right) => compareC(left.id, right.id)).map(
      (item) => ({
        id: item.id,
        orderId: item.orderId,
        titleId: item.titleId,
        titleSnapshot: item.titleSnapshot,
        creatorNameSnapshot: item.creatorNameSnapshot,
        format: item.format,
        currency: item.currency,
        subtotalMinor: item.unitSubtotalMinor,
        taxMinor: item.taxMinor,
        totalMinor: item.totalMinor,
        createdAt: canonicalDate(item.createdAt)
      })
    ),
    refunds: [...graph.refunds].sort((left, right) => compareC(left.id, right.id)).map(
      (refund) => ({
        id: refund.id,
        paymentId: refund.paymentId,
        providerIdDigestSha256: canonicalHash(refund.stripeRefundId),
        status: refund.status,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        providerCreatedAt: canonicalDate(refund.providerCreatedAt),
        allocationStatus: refund.allocationStatus,
        financialEvidenceStatus: refund.financialEvidenceStatus
      })
    ),
    allocations: [...graph.refundAllocations].sort((left, right) => compareC(left.id, right.id))
      .map((allocation) => ({
        id: allocation.id,
        refundId: allocation.refundId,
        orderItemId: allocation.orderItemId,
        amountMinor: allocation.amountMinor,
        source: allocation.source,
        createdAt: canonicalDate(allocation.createdAt)
      })),
    components: [...graph.refundComponents].sort((left, right) => compareC(left.id, right.id))
      .map((component) => ({
        id: component.id,
        refundAllocationId: component.refundAllocationId,
        refundId: component.refundId,
        orderItemId: component.orderItemId,
        subtotalMinor: component.subtotalMinor,
        taxMinor: component.taxMinor,
        totalMinor: component.totalMinor,
        currency: component.currency,
        createdAt: canonicalDate(component.createdAt)
      })),
    activeDraft: {
      id: draft.id,
      refundId: draft.refundId,
      state: draft.state,
      version: draft.version,
      updatedCorrelationId: draft.updatedCorrelationId,
      updatedAt: canonicalDate(draft.updatedAt),
      items: [...draftItems].sort((left, right) => compareC(left.orderItemId, right.orderItemId))
        .map((item) => ({
          id: item.id,
          draftId: item.draftId,
          orderItemId: item.orderItemId,
          proposedTotalPresentmentMinor: item.proposedTotalPresentmentMinor,
          updatedAt: canonicalDate(item.updatedAt)
        }))
    },
    corrections: {
      sets: [...graph.correctionSets].sort((left, right) => compareC(left.id, right.id)).map(
        (correction) => ({
          id: correction.id,
          refundId: correction.refundId,
          version: correction.correctionVersion,
          kind: correction.kind,
          baseAllocationSetId: correction.baseAllocationSetId,
          predecessorCorrectionSetId: correction.predecessorCorrectionSetId,
          sourceFingerprintSha256: correction.sourceFingerprintSha256,
          correlationId: correction.correlationId,
          createdAt: canonicalDate(correction.createdAt)
        })
      ),
      items: [...graph.correctionItems].sort((left, right) => compareC(left.id, right.id)),
      tips: activeCorrectionTips(graph.correctionSets).map((correction) => ({
        id: correction.id,
        version: correction.correctionVersion,
        sourceFingerprintSha256: correction.sourceFingerprintSha256
      }))
    },
    projectionImplementation: {
      classifierVersion: authority.classifierVersion,
      allocationAlgorithmVersion: authority.allocationAlgorithmVersion,
      pendingClassifierVersion: authority.pendingClassifierVersion,
      pendingAllocationAlgorithmVersion: authority.pendingAllocationAlgorithmVersion,
      pendingReplayId: authority.pendingReplayId,
      pendingScanRunId: authority.pendingScanRunId
    },
    financialSource: {
      balances: financial.sourceBalances,
      payoutMemberships: financial.payoutMemberships,
      selectedTips: financial.selectedTips,
      projectionHeads: financial.projectionHeads
    },
    grants: {
      purchase: [...entitlement.purchaseGrants].sort((left, right) => compareC(left.id, right.id))
        .map((grant) => ({
          id: grant.id,
          titleId: grant.titleId,
          userId: grant.userId,
          orderItemId: grant.orderItemId,
          state: grant.state,
          stateReason: grant.stateReason,
          grantedAt: canonicalDate(grant.grantedAt),
          suspendedAt: grant.suspendedAt?.toISOString() ?? null,
          revokedAt: grant.revokedAt?.toISOString() ?? null,
          updatedAt: canonicalDate(grant.updatedAt)
        })),
      affectedScopes: [...entitlement.affectedScopeGrants]
        .sort((left, right) => compareC(left.id, right.id)).map((grant) => ({
          id: grant.id,
          titleId: grant.titleId,
          userId: grant.userId,
          source: grant.source,
          orderItemId: grant.orderItemId,
          recoveryRefundAllocationId: grant.recoveryRefundAllocationId,
          state: grant.state,
          stateReason: grant.stateReason,
          grantedAt: canonicalDate(grant.grantedAt),
          suspendedAt: grant.suspendedAt?.toISOString() ?? null,
          revokedAt: grant.revokedAt?.toISOString() ?? null,
          updatedAt: canonicalDate(grant.updatedAt)
        })),
      effectiveScopes: entitlement.scopeStates,
      recipientBindings: normalizedRecipientBindings(entitlement.recipients)
    },
    proposedComponents: componentPlans.map(({ allocation, component }) => ({
      refundId: allocation.refundId,
      orderItemId: allocation.orderItemId,
      totalMinor: allocation.amountMinor,
      subtotalMinor: component.subtotalMinor,
      taxMinor: component.taxMinor,
      currency: component.currency
    })),
    consequences: previewItems
  };
}

function deriveFinalization(input: {
  readonly root: PreviewRootRow;
  readonly graph: CanonicalGraph;
  readonly entitlement: EntitlementSnapshot;
  readonly authority: FinancialProjectionAuthority;
  readonly financial: FinancialDiscovery;
  readonly expectedActiveDraftVersion: number;
}): DerivedFinalization {
  const { root, graph, entitlement, authority, financial } = input;
  if (
    root.refundPaymentId !== root.paymentId ||
    root.paymentOrderId !== root.orderId ||
    root.orderStatus !== 'paid' ||
    root.paymentStatus !== 'succeeded' ||
    root.orderTotalMinor === null ||
    root.orderTaxMinor === null ||
    root.orderPaidAt === null ||
    root.paymentPaidAt === null ||
    root.orderCurrency !== root.paymentCurrency ||
    root.refundCurrency !== root.orderCurrency ||
    root.orderTotalMinor !== root.paymentAmountMinor ||
    root.orderSubtotalMinor + root.orderTaxMinor !== root.orderTotalMinor ||
    (root.orderInitiatingUserId === null) === (root.orderGuestIdentityId === null)
  ) return permanentFailure();
  if (
    root.refundStatus !== 'succeeded' ||
    root.refundAllocationStatus !== 'draft'
  ) return notEligible();
  if (
    graph.orderItems.length < 1 ||
    graph.orderItems.length > MAX_ITEMS ||
    !uniqueById(graph.orderItems) ||
    !uniqueById(graph.refunds) ||
    !uniqueById(graph.refundDrafts) ||
    !uniqueById(graph.refundDraftItems) ||
    !uniqueById(graph.refundAllocations) ||
    !uniqueById(graph.refundComponents) ||
    !uniqueById(graph.correctionSets) ||
    !uniqueById(graph.correctionItems)
  ) return permanentFailure();
  const targetRefunds = graph.refunds.filter((refund) => refund.id === root.refundId);
  if (targetRefunds.length !== 1) return permanentFailure();
  const targetRefund = targetRefunds[0]!;
  if (
    targetRefund.paymentId !== root.paymentId ||
    targetRefund.stripeRefundId !== root.stripeRefundId ||
    targetRefund.status !== root.refundStatus ||
    targetRefund.amountMinor !== root.refundAmountMinor ||
    targetRefund.currency !== root.refundCurrency ||
    targetRefund.providerCreatedAt.getTime() !== root.refundProviderCreatedAt.getTime() ||
    targetRefund.allocationStatus !== root.refundAllocationStatus ||
    targetRefund.financialEvidenceStatus !== root.refundFinancialEvidenceStatus
  ) return permanentFailure();
  if (graph.refunds.some((refund) => refund.paymentId !== root.paymentId)) {
    return permanentFailure();
  }
  const itemById = new Map(graph.orderItems.map((item) => [item.id, item]));
  let itemTotal = 0;
  for (const item of graph.orderItems) {
    if (
      item.orderId !== root.orderId ||
      item.currency !== root.orderCurrency ||
      item.taxMinor === null ||
      item.totalMinor === null ||
      item.totalMinor !== item.unitSubtotalMinor + item.taxMinor
    ) return permanentFailure();
    itemTotal += item.totalMinor;
    if (!Number.isSafeInteger(itemTotal) || itemTotal > SAFE_MONEY_MAX) {
      return permanentFailure();
    }
  }
  if (itemTotal !== root.orderTotalMinor) return permanentFailure();
  if (graph.refundAllocations.some((allocation) => allocation.refundId === targetRefund.id)) {
    return notEligible();
  }
  const activeDrafts = graph.refundDrafts.filter((draft) =>
    draft.refundId === targetRefund.id && draft.state === 'active'
  );
  if (activeDrafts.length !== 1) return staleState();
  const activeDraft = activeDrafts[0]!;
  if (activeDraft.version !== input.expectedActiveDraftVersion) return staleState();
  if (activeDraft.version >= POSTGRES_INTEGER_MAX) return staleState();
  const draftItems = graph.refundDraftItems.filter((item) => item.draftId === activeDraft.id);
  if (draftItems.length !== graph.orderItems.length) return staleState();
  const proposalByItemId = new Map<string, number>();
  for (const item of draftItems) {
    if (
      !itemById.has(item.orderItemId) ||
      proposalByItemId.has(item.orderItemId)
    ) return staleState();
    proposalByItemId.set(item.orderItemId, item.proposedTotalPresentmentMinor);
  }
  const proposedTotalMinor = safeTotal([...proposalByItemId.values()]);
  if (proposedTotalMinor !== targetRefund.amountMinor) return staleState();
  if (graph.refunds.some((refund) =>
    refund.status === 'succeeded' &&
    compareRefundChronology(refund, targetRefund) < 0 &&
    !hasCompleteFinalizedAttribution(refund, graph)
  )) return staleState();

  const existingByItemId = new Map<string, number>();
  for (const allocation of graph.refundAllocations) {
    const item = itemById.get(allocation.orderItemId);
    const refund = graph.refunds.find((candidate) => candidate.id === allocation.refundId);
    if (!item || !refund || refund.status !== 'succeeded') return permanentFailure();
    const total = (existingByItemId.get(item.id) ?? 0) + allocation.amountMinor;
    if (!Number.isSafeInteger(total) || item.totalMinor === null || total > item.totalMinor) {
      return permanentFailure();
    }
    existingByItemId.set(item.id, total);
  }
  for (const item of graph.orderItems) {
    const proposed = proposalByItemId.get(item.id);
    if (proposed === undefined || item.totalMinor === null) return staleState();
    const existing = existingByItemId.get(item.id) ?? 0;
    if (proposed > item.totalMinor - existing) return staleState();
    if (proposed > 0 && graph.refundAllocations.some((allocation) => {
      if (allocation.orderItemId !== item.id) return false;
      const existingRefund = graph.refunds.find((refund) => refund.id === allocation.refundId);
      if (!existingRefund) return permanentFailure();
      return compareRefundChronology(targetRefund, existingRefund) < 0;
    })) return staleState();
  }

  for (const correction of graph.correctionSets) {
    if (!graph.refunds.some((refund) => refund.id === correction.refundId)) {
      return permanentFailure();
    }
  }
  for (const item of graph.correctionItems) {
    const correction = graph.correctionSets.find((candidate) => candidate.id === item.correctionSetId);
    if (!correction || !itemById.has(item.orderItemId)) return permanentFailure();
  }
  const currentCorrectionTips = new Map(activeCorrectionTips(graph.correctionSets).map(
    (correction) => [correction.id, correction]
  ));
  if (financial.projectionHeads.some((head) =>
    head.compatibleCorrectionTipId !== null && (() => {
      const correction = currentCorrectionTips.get(head.compatibleCorrectionTipId);
      return correction === undefined || correction.refundId !== targetRefund.id;
    })()
  )) return permanentFailure();
  if (
    financial.sourceBalances.length === 0 ||
    financial.selectedTips.length === 0 ||
    financial.projectionHeads.length === 0
  ) return staleState();

  const newAllocations: RefundComponentAllocation[] = graph.orderItems
    .map((item) => ({
      refundId: targetRefund.id,
      orderItemId: item.id,
      amountMinor: proposalByItemId.get(item.id)!
    }))
    .filter((allocation) => allocation.amountMinor > 0);
  const componentPlans = planRefundAllocationComponents({
    items: graph.orderItems as unknown as readonly OrderItemRow[],
    refunds: graph.refunds as unknown as readonly RefundRow[],
    existingAllocations: graph.refundAllocations as unknown as readonly RefundAllocationRow[],
    existingComponents: graph.refundComponents as unknown as readonly RefundAllocationComponentRow[],
    newAllocations,
    createdAt: COMPONENT_PLANNING_TIME
  });
  if (componentPlans.length !== newAllocations.length) return permanentFailure();

  if (!uniqueById(entitlement.purchaseGrants) || !uniqueById(entitlement.affectedScopeGrants)) {
    return permanentFailure();
  }
  const purchaseGrantByItemId = new Map<string, CanonicalGrant>();
  for (const grant of entitlement.purchaseGrants) {
    if (
      grant.source !== 'purchase' ||
      grant.orderItemId === null ||
      purchaseGrantByItemId.has(grant.orderItemId)
    ) return permanentFailure();
    const item = itemById.get(grant.orderItemId);
    if (!item || item.titleId !== grant.titleId) return permanentFailure();
    purchaseGrantByItemId.set(grant.orderItemId, grant);
  }
  if (
    purchaseGrantByItemId.size !== graph.orderItems.length ||
    graph.orderItems.some((item) => !purchaseGrantByItemId.has(item.id))
  ) return permanentFailure();
  const scopes = canonicalScopes(entitlement.purchaseGrants);
  const scopeKeys = new Set(scopes.map((scope) => `${scope.userId}\0${scope.titleId}`));
  for (const grant of entitlement.affectedScopeGrants) {
    if (grant.userId === null) {
      if (!entitlement.purchaseGrants.some((purchase) =>
        purchase.id === grant.id && JSON.stringify(purchase) === JSON.stringify(grant)
      )) return permanentFailure();
    } else if (!scopeKeys.has(`${grant.userId}\0${grant.titleId}`)) {
      return permanentFailure();
    }
  }
  for (const purchaseGrant of entitlement.purchaseGrants) {
    if (purchaseGrant.userId === null) continue;
    const locked = entitlement.affectedScopeGrants.find((grant) => grant.id === purchaseGrant.id);
    if (!locked || JSON.stringify(locked) !== JSON.stringify(purchaseGrant)) {
      return permanentFailure();
    }
  }
  if (
    entitlement.scopeStates.length !== scopes.length ||
    new Set(entitlement.scopeStates.map((scope) => `${scope.userId}\0${scope.titleId}`)).size !==
      entitlement.scopeStates.length
  ) return permanentFailure();
  const scopeStateByKey = new Map(entitlement.scopeStates.map((scope) => [
    `${scope.userId}\0${scope.titleId}`,
    scope
  ]));
  for (const scope of scopes) {
    const current = scopeStateByKey.get(`${scope.userId}\0${scope.titleId}`);
    const activeByGrant = entitlement.affectedScopeGrants.some((grant) =>
      grant.userId === scope.userId && grant.titleId === scope.titleId && grant.state === 'active'
    );
    if (!current || current.active !== activeByGrant) return permanentFailure();
  }
  const recipientByUserId = new Map<string, { readonly row: RecipientRow; readonly email: string }>();
  for (const recipient of entitlement.recipients) {
    if (recipientByUserId.has(recipient.userId)) return permanentFailure();
    let email: string;
    try {
      email = normalizeEmailAddress(recipient.email);
    } catch {
      return permanentFailure();
    }
    if (email !== recipient.email) return permanentFailure();
    recipientByUserId.set(recipient.userId, { row: recipient, email });
  }
  for (const grant of entitlement.purchaseGrants) {
    if (grant.userId !== null && !recipientByUserId.has(grant.userId)) {
      return permanentFailure();
    }
  }

  const previewItems: RefundFinalizationItemPreviewDto[] = [];
  const effects: FinalizationEffectPrediction[] = [];
  const expectedProjectedByScope = new Map<string, {
    userId: string;
    titleId: string;
    beforeActive: boolean;
    afterActive: boolean;
  }>();
  const fullyRefundedItemIds = new Set(graph.orderItems.filter((item) =>
    (existingByItemId.get(item.id) ?? 0) + proposalByItemId.get(item.id)! === item.totalMinor
  ).map((item) => item.id));
  const plannedPurchaseGrantStates = new Map(entitlement.purchaseGrants.map((grant) => [
    grant.id,
    grant.orderItemId !== null && fullyRefundedItemIds.has(grant.orderItemId)
      ? 'revoked' as const
      : grant.state
  ]));
  for (const item of [...graph.orderItems].sort((left, right) => compareC(left.id, right.id))) {
    const proposed = proposalByItemId.get(item.id)!;
    const fullyRefunded = fullyRefundedItemIds.has(item.id);
    const grant = purchaseGrantByItemId.get(item.id)!;
    const scopeKey = grant.userId === null ? null : `${grant.userId}\0${grant.titleId}`;
    const beforeEffectiveAccess = scopeKey === null
      ? false
      : scopeStateByKey.get(scopeKey)!.active;
    const otherActiveGrant = grant.userId !== null && entitlement.affectedScopeGrants.some(
      (candidate) => candidate.id !== grant.id && candidate.userId === grant.userId &&
        candidate.titleId === grant.titleId &&
        (plannedPurchaseGrantStates.get(candidate.id) ?? candidate.state) === 'active'
    );
    const afterState = fullyRefunded ? 'revoked' as const : grant.state;
    const afterEffectiveAccess = grant.userId !== null && entitlement.affectedScopeGrants.some(
      (candidate) => candidate.userId === grant.userId && candidate.titleId === grant.titleId &&
        (plannedPurchaseGrantStates.get(candidate.id) ?? candidate.state) === 'active'
    );
    const effectiveAccessWouldChange = beforeEffectiveAccess !== afterEffectiveAccess;
    if (effectiveAccessWouldChange && (!beforeEffectiveAccess || afterEffectiveAccess)) {
      return permanentFailure();
    }
    if (
      fullyRefunded && grant.state !== 'revoked' && grant.userId !== null && scopeKey !== null
    ) {
      expectedProjectedByScope.set(scopeKey, {
        userId: grant.userId,
        titleId: grant.titleId,
        beforeActive: beforeEffectiveAccess,
        afterActive: afterEffectiveAccess
      });
    }
    const split = componentPlans.find((plan) => plan.allocation.orderItemId === item.id);
    if ((proposed > 0) !== (split !== undefined)) return permanentFailure();
    previewItems.push({
      orderItemId: item.id,
      titleId: item.titleId,
      soldAsTitle: item.titleSnapshot,
      proposedTotalMinor: proposed,
      proposedSubtotalMinor: split?.component.subtotalMinor ?? 0,
      proposedTaxMinor: split?.component.taxMinor ?? 0,
      wouldBeFullyRefunded: fullyRefunded,
      purchaseGrantWouldBeRevoked: fullyRefunded && grant.state !== 'revoked',
      otherActiveGrantPreservesAccess: fullyRefunded && otherActiveGrant,
      effectiveAccessWouldChange,
      emailQueued: effectiveAccessWouldChange
    });
    if (proposed > 0) {
      effects.push({
        orderItemId: item.id,
        grantId: grant.id,
        beforeState: grant.state,
        afterState,
        beforeEffectiveAccess,
        afterEffectiveAccess,
        transition: grant.state !== afterState ? 'revoked_by_finalization' : 'unchanged'
      });
    }
  }
  const expectedProjectedScopes = [...expectedProjectedByScope.values()].sort((left, right) =>
    compareC(left.userId, right.userId) || compareC(left.titleId, right.titleId)
  );
  const changedScopes = expectedProjectedScopes.filter((scope) =>
    scope.beforeActive !== scope.afterActive
  );
  const changedUserIds = new Set(changedScopes.map((scope) => scope.userId));
  if (changedUserIds.size > 1) return permanentFailure();
  let emailPlan: DerivedFinalization['emailPlan'] = null;
  if (changedScopes.length > 0) {
    const userId = changedScopes[0]!.userId;
    const recipient = recipientByUserId.get(userId);
    if (!recipient?.row.emailVerified) return permanentFailure();
    emailPlan = {
      userId,
      to: recipient.email,
      affectedTitleCount: changedScopes.length
    };
  }
  const fingerprint = canonicalHash(fingerprintDocument({
    root,
    graph,
    entitlement,
    authority,
    financial,
    draft: activeDraft,
    draftItems,
    componentPlans,
    previewItems
  }));
  return {
    dto: {
      refundId: targetRefund.id,
      expectedActiveDraftVersion: activeDraft.version,
      previewFingerprint: fingerprint,
      currency: targetRefund.currency,
      proposedTotalMinor,
      remainderMinor: targetRefund.amountMinor - proposedTotalMinor,
      items: previewItems
    },
    activeDraft,
    targetRefund,
    componentPlans,
    effects,
    expectedProjectedScopes,
    emailPlan
  };
}

function previewInput(value: unknown): {
  readonly refundId: string;
  readonly expectedActiveDraftVersion: number;
} {
  const parsed = z.strictObject({
    refundId: canonicalUuidSchema,
    expectedActiveDraftVersion: positiveVersionSchema
  }).safeParse(value);
  if (!parsed.success) return staleState();
  return parsed.data;
}

export async function previewRefundFinalization(
  database: Database,
  actor: Actor,
  input: { readonly refundId: string; readonly expectedActiveDraftVersion: number },
  _context: FinancialRequestContext,
  dependencies: FinancialAuthorizationDependencies = {}
): Promise<RefundFinalizationPreviewDto> {
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  requireCapability(actor, 'reconciliation.manage', dependencies.capabilityResolver);
  const parsedInput = previewInput(input);
  try {
    return await database.transaction(async (transaction: DatabaseTransaction) => {
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
      const root = await loadPreviewRoot(transaction, parsedInput.refundId);
      if (root === null) return notEligible();
      const authority = canonicalAuthority(await loadFinancialProjectionAuthority(transaction));
      const graph = await loadPreviewGraph(transaction, root);
      const financial = await loadFinancialDiscovery(transaction, root.stripeRefundId, authority);
      const entitlement = await loadPreviewEntitlements(transaction, root.orderId);
      return deriveFinalization({
        root,
        graph,
        entitlement,
        authority,
        financial,
        expectedActiveDraftVersion: parsedInput.expectedActiveDraftVersion
      }).dto;
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

function parseFinalizeCommand(
  command: Extract<FinancialAdminPrivateCommand, { kind: 'refund_allocation_finalize' }>
): Extract<FinancialAdminPrivateCommand, { kind: 'refund_allocation_finalize' }> {
  const parsed = z.strictObject({
    kind: z.literal('refund_allocation_finalize'),
    refundId: canonicalUuidSchema,
    expectedActiveDraftVersion: positiveVersionSchema,
    previewFingerprint: sha256Schema,
    confirmation: z.literal('finalize_refund_allocation')
  }).safeParse(command);
  if (!parsed.success) throw new FinancialAdminPermanentError('invalid_command');
  return parsed.data;
}

async function lockOrderRow(
  transaction: DatabaseTransaction,
  orderId: string
): Promise<z.output<typeof lockedOrderSchema>> {
  return parseOne(lockedOrderSchema, await executeRows(transaction, sql`
    /* refund-finalization:locked-order */
    select id, status, initiating_user_id as "initiatingUserId",
      guest_identity_id as "guestIdentityId", currency,
      subtotal_minor as "subtotalMinor", tax_minor as "taxMinor",
      total_minor as "totalMinor", paid_at as "paidAt"
    from orders where id = ${orderId}::uuid for update
  `));
}

async function lockPaymentRow(
  transaction: DatabaseTransaction,
  paymentId: string,
  orderId: string
): Promise<z.output<typeof lockedPaymentSchema>> {
  return parseOne(lockedPaymentSchema, await executeRows(transaction, sql`
    /* refund-finalization:locked-payment */
    select id, order_id as "orderId",
      stripe_payment_intent_id as "stripePaymentIntentId", status,
      amount_minor as "amountMinor", currency, paid_at as "paidAt",
      financial_evidence_status as "financialEvidenceStatus"
    from payments where id = ${paymentId}::uuid and order_id = ${orderId}::uuid
    for update
  `));
}

async function insertAdministrativeAllocations(
  transaction: DatabaseTransaction,
  derived: DerivedFinalization
): Promise<readonly {
  readonly id: string;
  readonly refundId: string;
  readonly orderItemId: string;
  readonly amountMinor: number;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly currency: string;
}[]> {
  const inserted: Array<{
    id: string;
    refundId: string;
    orderItemId: string;
    amountMinor: number;
    subtotalMinor: number;
    taxMinor: number;
    currency: string;
  }> = [];
  for (const plan of derived.componentPlans) {
    const allocation = parseOne(writeIdSchema, await executeRows(transaction, sql`
      /* refund-finalization:insert-allocation */
      insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
      values (${plan.allocation.refundId}::uuid, ${plan.allocation.orderItemId}::uuid,
        ${plan.allocation.amountMinor}, 'administrative')
      returning id
    `));
    parseOne(writeIdSchema, await executeRows(transaction, sql`
      /* refund-finalization:insert-component */
      insert into refund_allocation_components (
        refund_allocation_id, refund_id, order_item_id, subtotal_minor,
        tax_minor, total_minor, currency
      ) values (
        ${allocation.id}::uuid, ${plan.component.refundId}::uuid,
        ${plan.component.orderItemId}::uuid, ${plan.component.subtotalMinor},
        ${plan.component.taxMinor}, ${plan.component.totalMinor}, ${plan.component.currency}
      ) returning id
    `));
    inserted.push({
      id: allocation.id,
      refundId: plan.allocation.refundId,
      orderItemId: plan.allocation.orderItemId,
      amountMinor: plan.allocation.amountMinor,
      subtotalMinor: plan.component.subtotalMinor,
      taxMinor: plan.component.taxMinor,
      currency: plan.component.currency
    });
  }
  return inserted;
}

async function freezeDraft(
  transaction: DatabaseTransaction,
  context: FinancialAdminCommandExecutorContext,
  draft: CanonicalDraft
): Promise<number> {
  const finalized = parseOne(finalizedDraftWriteSchema, await executeRows(transaction, sql`
    /* refund-finalization:freeze-draft */
    update refund_allocation_drafts set state = 'finalized', version = version + 1,
      updated_by_admin_id = ${context.actor.id}::uuid,
      updated_correlation_id = ${context.correlationId},
      updated_at = pg_catalog.statement_timestamp(),
      finalized_at = pg_catalog.statement_timestamp()
    where id = ${draft.id}::uuid and state = 'active' and version = ${draft.version}
    returning id, version
  `));
  if (finalized.id !== draft.id || finalized.version !== draft.version + 1) {
    return permanentFailure();
  }
  return finalized.version;
}

async function finalizeRefundState(
  transaction: DatabaseTransaction,
  refundId: string
): Promise<void> {
  const updated = parseOne(writeIdSchema, await executeRows(transaction, sql`
    /* refund-finalization:finalize-refund */
    update refunds set allocation_status = 'finalized',
      updated_at = pg_catalog.statement_timestamp()
    where id = ${refundId}::uuid and status = 'succeeded' and allocation_status = 'draft'
    returning id
  `));
  if (updated.id !== refundId) return permanentFailure();
}

type AdminRefundRecompute = (
  transaction: DatabaseTransaction,
  input: LockedRefundProjectionInput,
  selectedSetIds: readonly string[],
  commandId: string
) => Promise<RefundFinancialRecomputeResult>;

function adminRefundRecompute(): AdminRefundRecompute {
  const candidate = (refundFinancialProjection as unknown as {
    readonly recomputeLockedRefundFinancialProjectionForAdminCommand?: unknown;
  }).recomputeLockedRefundFinancialProjectionForAdminCommand;
  if (typeof candidate !== 'function') return permanentFailure();
  return candidate as AdminRefundRecompute;
}

function exactProjectedScopes(
  actual: readonly {
    readonly userId: string;
    readonly titleId: string;
    readonly beforeActive: boolean;
    readonly afterActive: boolean;
  }[],
  expected: DerivedFinalization['expectedProjectedScopes']
): boolean {
  const normalize = (values: typeof actual) => [...values].sort((left, right) =>
    compareC(left.userId, right.userId) || compareC(left.titleId, right.titleId)
  );
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

function validateAccessResult(
  access: Awaited<ReturnType<typeof recomputeRefundPurchaseAccess>>,
  derived: DerivedFinalization,
  entitlement: EntitlementSnapshot
): void {
  const fullyRefundedItemIds = new Set(derived.dto.items.filter((item) =>
    item.wouldBeFullyRefunded
  ).map((item) => item.orderItemId));
  const expectedTransitions = entitlement.purchaseGrants
    .filter((grant) => grant.orderItemId !== null && fullyRefundedItemIds.has(grant.orderItemId))
    .map((grant) => {
      if (grant.orderItemId === null) return permanentFailure();
      return {
        grantId: grant.id,
        orderItemId: grant.orderItemId,
        userId: grant.userId,
        titleId: grant.titleId,
        beforeState: grant.state,
        afterState: 'revoked' as const
      };
    }).sort((left, right) => compareC(left.grantId, right.grantId));
  const actualTransitions = [...access.grantTransitions]
    .sort((left, right) => compareC(left.grantId, right.grantId));
  if (
    JSON.stringify(actualTransitions) !== JSON.stringify(expectedTransitions) ||
    !exactProjectedScopes(access.projectedScopes, derived.expectedProjectedScopes)
  ) return permanentFailure();
}

async function loadGrantAfterStates(
  transaction: DatabaseTransaction,
  grantIds: readonly string[]
): Promise<ReadonlyMap<string, CanonicalGrant['state']>> {
  const ids = [...new Set(grantIds)].sort(compareC);
  const states = parseMany(grantAfterStateSchema, await executeRows(transaction, sql`
    /* refund-finalization:grant-after-states */
    select id, state from entitlement_grants
    where ${ids.length === 0
      ? sql`false`
      : sql`id in (${uuidList(ids)})`}
    order by id
  `));
  if (states.length !== ids.length || !uniqueById(states)) return permanentFailure();
  return new Map(states.map((row) => [row.id, row.state]));
}

async function insertFinalizationEffects(
  transaction: DatabaseTransaction,
  context: FinancialAdminCommandExecutorContext,
  derived: DerivedFinalization,
  insertedAllocations: readonly { readonly id: string; readonly orderItemId: string }[],
  finalizedDraftVersion: number,
  afterStates: ReadonlyMap<string, CanonicalGrant['state']>
): Promise<void> {
  for (const effect of derived.effects) {
    const allocation = insertedAllocations.find((candidate) =>
      candidate.orderItemId === effect.orderItemId
    );
    if (!allocation || afterStates.get(effect.grantId) !== effect.afterState) {
      return permanentFailure();
    }
    parseOne(writeIdSchema, await executeRows(transaction, sql`
      /* refund-finalization:insert-effect */
      insert into refund_allocation_finalization_effects (
        refund_id, refund_allocation_id, draft_id, draft_version, order_item_id,
        purchase_grant_id, before_purchase_grant_state, after_purchase_grant_state,
        before_effective_access, after_effective_access, transition, correlation_id
      ) values (
        ${derived.targetRefund.id}::uuid, ${allocation.id}::uuid,
        ${derived.activeDraft.id}::uuid, ${finalizedDraftVersion},
        ${effect.orderItemId}::uuid, ${effect.grantId}::uuid,
        ${effect.beforeState}, ${effect.afterState}, ${effect.beforeEffectiveAccess},
        ${effect.afterEffectiveAccess}, ${effect.transition}, ${context.correlationId}
      ) returning id
    `));
  }
}

async function executeRefundAllocationFinalizeLocked(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, { kind: 'refund_allocation_finalize' }>
): Promise<FinancialAdminCommandSafeResultByCode['allocation_finalized']> {
  throwIfAborted(context.signal);
  const routing = await discoverRouting(context.transaction, command.refundId);
  if (routing === null) return notEligible();
  throwIfAborted(context.signal);
  const authority = canonicalAuthority(
    await lockFinancialProjectionAuthority(context.transaction)
  );
  throwIfAborted(context.signal);
  await lockOrder(context.transaction, routing.orderId);
  const order = await lockOrderRow(context.transaction, routing.orderId);
  const payment = await lockPaymentRow(
    context.transaction,
    routing.paymentId,
    routing.orderId
  );
  if (
    order.id !== routing.orderId ||
    payment.id !== routing.paymentId ||
    payment.orderId !== routing.orderId
  ) return permanentFailure();
  throwIfAborted(context.signal);
  const purchaseFacts = await lockPaymentPurchaseFacts(
    context.transaction,
    payment as never,
    order
  );
  const graph = canonicalGraphFromPurchaseFacts(purchaseFacts);
  const root = rootFromLockedFacts(command.refundId, order, payment, graph);
  await lockFinancialProjectionEnrollment(context.transaction);
  const discoveredFinancial = await loadFinancialDiscovery(
    context.transaction,
    root.stripeRefundId,
    authority
  );
  const issueKeys = [
    ...ISSUE_CODES.map((safeCode) => ({
      resourceType: 'refund' as const,
      resourceId: command.refundId,
      safeCode
    })),
    ...discoveredFinancial.selectedTips.flatMap((tip) => ISSUE_CODES.map((safeCode) => ({
      resourceType: 'allocation_set' as const,
      resourceId: tip.id,
      safeCode
    })))
  ];
  await lockFinancialProjectionRows(context.transaction, {
    payoutGenerations: discoveredFinancial.payoutGenerations,
    balanceTransactionIds: discoveredFinancial.closureBalanceTransactionIds,
    classifierVersion: authority.classifierVersion,
    issueKeys
  });
  const lockedFinancial = await loadFinancialDiscovery(
    context.transaction,
    root.stripeRefundId,
    authority
  );
  if (!sameFinancialDiscovery(discoveredFinancial, lockedFinancial)) return staleState();
  throwIfAborted(context.signal);
  const entitlementFacts = await lockPaymentEntitlementFacts(
    context.transaction,
    purchaseFacts
  );
  const canonicalPurchaseGrants = entitlementFacts.grants.map((grant) =>
    parseOne(grantSchema, [{
      id: grant.id,
      titleId: grant.titleId,
      userId: grant.userId,
      source: grant.source,
      orderItemId: grant.orderItemId,
      recoveryRefundAllocationId: grant.recoveryRefundAllocationId,
      state: grant.state,
      stateReason: grant.stateReason,
      grantedAt: grant.grantedAt,
      suspendedAt: grant.suspendedAt,
      revokedAt: grant.revokedAt,
      updatedAt: grant.updatedAt
    }])
  );
  const scopes = canonicalScopes(canonicalPurchaseGrants);
  const scopeStates = await loadScopeStates(context.transaction, scopes, true);
  const recipients = await loadRecipients(
    context.transaction,
    canonicalPurchaseGrants.flatMap((grant) => grant.userId === null ? [] : [grant.userId])
  );
  const entitlement = canonicalEntitlementSnapshot(entitlementFacts, scopeStates, recipients);
  const derived = deriveFinalization({
    root,
    graph,
    entitlement,
    authority,
    financial: lockedFinancial,
    expectedActiveDraftVersion: command.expectedActiveDraftVersion
  });
  if (derived.dto.previewFingerprint !== command.previewFingerprint) return staleState();
  throwIfAborted(context.signal);

  const insertedAllocations = await insertAdministrativeAllocations(
    context.transaction,
    derived
  );
  if (insertedAllocations.length !== derived.componentPlans.length) {
    return permanentFailure();
  }
  const finalizedDraftVersion = await freezeDraft(
    context.transaction,
    context,
    derived.activeDraft
  );
  await finalizeRefundState(context.transaction, command.refundId);
  throwIfAborted(context.signal);

  const recomputeInput: LockedRefundProjectionInput = {
    orderId: root.orderId,
    paymentId: root.paymentId,
    refundId: root.refundId,
    providerStatus: 'succeeded',
    allocationStatus: 'finalized',
    amountMinor: root.refundAmountMinor,
    currency: root.refundCurrency,
    balanceTransactionIds: lockedFinancial.sourceBalances.map((row) => row.id),
    orderItems: graph.orderItems.map((item) => ({
      id: item.id,
      subtotalMinor: item.unitSubtotalMinor,
      taxMinor: item.taxMinor!,
      totalMinor: item.totalMinor!,
      currency: item.currency
    })),
    finalizedAllocations: insertedAllocations.map((allocation) => ({
      id: allocation.id,
      orderItemId: allocation.orderItemId,
      amountMinor: allocation.amountMinor
    })),
    refundComponents: insertedAllocations.map((allocation) => ({
      refundAllocationId: allocation.id,
      orderItemId: allocation.orderItemId,
      subtotalMinor: allocation.subtotalMinor,
      taxMinor: allocation.taxMinor,
      currency: allocation.currency
    })),
    correlationId: context.correlationId
  };
  const recomputed = await adminRefundRecompute()(
    context.transaction,
    recomputeInput,
    lockedFinancial.selectedTips.map((tip) => tip.id).sort(compareC),
    context.commandId
  );
  if (
    recomputed.refundId !== command.refundId ||
    (recomputed.status !== 'reconciled' && recomputed.status !== 'unchanged') ||
    recomputed.financialEvidenceStatus !== 'fee_reconciled'
  ) return staleState();
  throwIfAborted(context.signal);

  const access = await recomputeRefundPurchaseAccess(context.transaction, {
    items: purchaseFacts.orderItems,
    allocations: [
      ...purchaseFacts.refundAllocations,
      ...insertedAllocations.map((allocation) => ({
        orderItemId: allocation.orderItemId,
        amountMinor: allocation.amountMinor
      }))
    ],
    grants: entitlementFacts.grants,
    now: new Date()
  }, projectEffectiveEntitlement);
  validateAccessResult(access, derived, entitlement);
  const afterStates = await loadGrantAfterStates(
    context.transaction,
    derived.effects.map((effect) => effect.grantId)
  );
  await insertFinalizationEffects(
    context.transaction,
    context,
    derived,
    insertedAllocations,
    finalizedDraftVersion,
    afterStates
  );
  const changedScopes = access.projectedScopes.filter((scope) =>
    scope.beforeActive !== scope.afterActive
  );
  const accessChanged = changedScopes.length > 0;
  let emailQueued = false;
  if (accessChanged) {
    if (
      derived.emailPlan === null ||
      derived.emailPlan.affectedTitleCount !== changedScopes.length
    ) return permanentFailure();
    await context.enqueueAccessChange({
      template: 'commerce.refund-access-changed',
      eventId: context.commandId,
      to: derived.emailPlan.to,
      reasonCategory: 'refund_completed',
      affectedTitleCount: derived.emailPlan.affectedTitleCount
    });
    emailQueued = true;
  } else if (derived.emailPlan !== null) {
    return permanentFailure();
  }
  throwIfAborted(context.signal);
  await appendAuditEvent(context.transaction, {
    actor: context.actor,
    action: 'financial.refund_allocation.finalized',
    outcome: 'succeeded',
    resourceType: 'refund',
    resourceId: command.refundId,
    correlationId: context.correlationId,
    before: {
      allocationStatus: 'draft',
      draftVersion: derived.activeDraft.version
    },
    after: {
      allocationStatus: 'finalized',
      finalizedDraftVersion,
      administrativeAllocationCount: insertedAllocations.length,
      accessChanged,
      emailQueued
    }
  });
  return {
    refundId: command.refundId,
    finalizedDraftVersion,
    accessChanged,
    emailQueued
  };
}

export async function executeRefundAllocationFinalize(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, { kind: 'refund_allocation_finalize' }>
): Promise<FinancialAdminCommandSafeResultByCode['allocation_finalized']> {
  const parsedCommand = parseFinalizeCommand(command);
  try {
    return await executeRefundAllocationFinalizeLocked(context, parsedCommand);
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
