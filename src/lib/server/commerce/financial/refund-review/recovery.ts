import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  requireCapability,
  type Actor,
  type FinancialAuthorizationDependencies
} from '$lib/server/auth/admin-policy';
import { listRolesForUser } from '$lib/server/auth/identity';
import { parseFinancialAdminPrivateCommand, type FinancialAdminPrivateCommand } from
  '$lib/server/commerce/financial/admin-commands/contracts';
import {
  FinancialAdminConflictError,
  FinancialAdminDeniedError,
  FinancialAdminPermanentError,
  type FinancialAdminCommandExecutorContext
} from '$lib/server/commerce/financial/admin-commands/handler';
import {
  assertGrantTransitionAllowed,
  projectEffectiveEntitlement
} from '$lib/server/commerce/grants';
import type { FinancialRequestContext } from '$lib/server/commerce/reporting/context';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type {
  AdministrativeRecoveryDeactivationPreviewDto,
  AdministrativeRecoveryPreviewDto,
  AdministrativeRecoverySeedDto,
  FinancialAdminCommandSafeResultByCode
} from '$lib/types/financial-reporting';
import type {
  AdministrativeRecoveryDeactivationPrepareInput,
  AdministrativeRecoveryPrepareInput
} from './inputs';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const SAFE_MONEY_MAX = 99_999_999;
const MAX_REFUND_CLOSURE = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const UTC_MILLISECOND_TIMESTAMP =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$/u;

const canonicalUuidSchema = z.string().regex(UUID_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const positiveVersionSchema = z.number().int().min(1).max(POSTGRES_INTEGER_MAX);
const moneySchema = z.number().int().min(0).max(SAFE_MONEY_MAX);
const boundedAggregateSchema = z.number().int().min(0)
  .max(SAFE_MONEY_MAX * MAX_REFUND_CLOSURE);
const canonicalTimestampSchema = z.string().regex(UTC_MILLISECOND_TIMESTAMP).refine((value) => {
  if (value.startsWith('0000-')) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
});
function isAscii(value: string): boolean {
  return Array.from(value).every((character) => character.codePointAt(0)! <= 0x7f);
}

const asciiLineSchema = z.string().min(1).max(4_096).refine(isAscii);

export interface AdministrativeRecoveryActivationFacts {
  readonly refundId: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly finalizationEffectId: string;
  readonly recoveryReferenceId: string;
  readonly finalizationDraftId: string;
  readonly finalizationDraftVersion: number;
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly purchaseGrantId: string;
  readonly purchaseUserId: string | null;
  readonly purchaseGrantState: 'unclaimed' | 'active' | 'suspended' | 'revoked';
  readonly effectTransition: 'unchanged' | 'revoked_by_finalization';
  readonly effectBeforePurchaseGrantState: 'unclaimed' | 'active' | 'suspended' | 'revoked';
  readonly effectAfterPurchaseGrantState: 'unclaimed' | 'active' | 'suspended' | 'revoked';
  readonly allocationSource: 'automatic' | 'administrative';
  readonly allocationTotalMinor: number;
  readonly allocationSubtotalMinor: number;
  readonly allocationTaxMinor: number;
  readonly itemSubtotalMinor: number;
  readonly itemTaxMinor: number;
  readonly itemTotalMinor: number;
  readonly itemCurrency: string;
  readonly existingRecoveryGrantId: string | null;
  readonly existingRecoveryGrantState: 'active' | 'revoked' | null;
  readonly existingRecoveryStateChangedAt: string | null;
  readonly correctionSetId: string;
  readonly correctionVersion: number;
  readonly correctionKind: 'allocation_attribution_correction' | 'classifier_rebase';
  readonly correctionBaseSetId: string;
  readonly correctionPredecessorSetId: string | null;
  readonly correctionSourceFingerprint: string;
  readonly projectionClassifierVersion: number;
  readonly projectionAllocationAlgorithmVersion: number;
  readonly projectionPending: boolean;
  readonly sourceBalanceTransactionId: string;
  readonly sourceFingerprint: string;
  readonly projectionHeadLines: readonly string[];
  readonly projectionItemLines: readonly string[];
  readonly presentmentEvidenceLines: readonly string[];
  readonly cumulativeRefundSubtotalMinor: number;
  readonly cumulativeRefundTaxMinor: number;
  readonly effectiveAccessBefore: boolean;
  readonly projectionComplete: boolean;
  readonly bindingLinksValid: boolean;
  readonly causalLinksValid: boolean;
}

export interface AdministrativeRecoveryDeactivationFacts {
  readonly refundId: string;
  readonly recoveryGrantId: string;
  readonly recoveryReferenceId: string;
  readonly stateChangedAt: string;
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly state: 'active' | 'revoked';
  readonly effectiveAccessBefore: boolean;
  readonly anotherActiveGrantExists: boolean;
  readonly linkageValid: boolean;
}

export interface AdministrativeRecoveryTransition {
  readonly recoveryGrantId: string;
  readonly recoveryUserId: string;
  readonly recoveryTitleId: string;
  readonly previousState: 'active' | 'revoked' | null;
  readonly nextState: 'active' | 'revoked';
  readonly stateChangedAt: Date;
}

const activationFactsSchema: z.ZodType<AdministrativeRecoveryActivationFacts> =
  z.strictObject({
    refundId: canonicalUuidSchema,
    paymentId: canonicalUuidSchema,
    orderId: canonicalUuidSchema,
    finalizationEffectId: canonicalUuidSchema,
    recoveryReferenceId: canonicalUuidSchema,
    finalizationDraftId: canonicalUuidSchema,
    finalizationDraftVersion: positiveVersionSchema,
    orderItemId: canonicalUuidSchema,
    titleId: canonicalUuidSchema,
    soldAsTitle: z.string().min(1).max(500),
    purchaseGrantId: canonicalUuidSchema,
    purchaseUserId: canonicalUuidSchema.nullable(),
    purchaseGrantState: z.enum(['unclaimed', 'active', 'suspended', 'revoked']),
    effectTransition: z.enum(['unchanged', 'revoked_by_finalization']),
    effectBeforePurchaseGrantState: z.enum(['unclaimed', 'active', 'suspended', 'revoked']),
    effectAfterPurchaseGrantState: z.enum(['unclaimed', 'active', 'suspended', 'revoked']),
    allocationSource: z.enum(['automatic', 'administrative']),
    allocationTotalMinor: moneySchema,
    allocationSubtotalMinor: moneySchema,
    allocationTaxMinor: moneySchema,
    itemSubtotalMinor: moneySchema,
    itemTaxMinor: moneySchema,
    itemTotalMinor: moneySchema,
    itemCurrency: z.string().regex(CURRENCY_PATTERN),
    existingRecoveryGrantId: canonicalUuidSchema.nullable(),
    existingRecoveryGrantState: z.enum(['active', 'revoked']).nullable(),
    existingRecoveryStateChangedAt: canonicalTimestampSchema.nullable(),
    correctionSetId: canonicalUuidSchema,
    correctionVersion: positiveVersionSchema,
    correctionKind: z.enum(['allocation_attribution_correction', 'classifier_rebase']),
    correctionBaseSetId: canonicalUuidSchema,
    correctionPredecessorSetId: canonicalUuidSchema.nullable(),
    correctionSourceFingerprint: sha256Schema,
    projectionClassifierVersion: positiveVersionSchema,
    projectionAllocationAlgorithmVersion: positiveVersionSchema,
    projectionPending: z.boolean(),
    sourceBalanceTransactionId: canonicalUuidSchema,
    sourceFingerprint: sha256Schema,
    projectionHeadLines: z.array(asciiLineSchema).max(2),
    projectionItemLines: z.array(asciiLineSchema).max(300),
    presentmentEvidenceLines: z.array(asciiLineSchema)
      .max(MAX_REFUND_CLOSURE * 2),
    cumulativeRefundSubtotalMinor: boundedAggregateSchema,
    cumulativeRefundTaxMinor: boundedAggregateSchema,
    effectiveAccessBefore: z.boolean(),
    projectionComplete: z.boolean(),
    bindingLinksValid: z.boolean(),
    causalLinksValid: z.boolean()
  });

const deactivationFactsSchema: z.ZodType<AdministrativeRecoveryDeactivationFacts> =
  z.strictObject({
    refundId: canonicalUuidSchema,
    recoveryGrantId: canonicalUuidSchema,
    recoveryReferenceId: canonicalUuidSchema,
    stateChangedAt: canonicalTimestampSchema,
    orderItemId: canonicalUuidSchema,
    titleId: canonicalUuidSchema,
    soldAsTitle: z.string().min(1).max(500),
    state: z.enum(['active', 'revoked']),
    effectiveAccessBefore: z.boolean(),
    anotherActiveGrantExists: z.boolean(),
    linkageValid: z.boolean()
  });

const activationPrepareSchema = z.strictObject({
  refundId: canonicalUuidSchema,
  finalizationEffectId: canonicalUuidSchema,
  orderItemId: canonicalUuidSchema,
  expectedCorrectionSetId: canonicalUuidSchema,
  expectedCorrectionVersion: positiveVersionSchema,
  expectedSourceFingerprint: sha256Schema
});

const deactivationPrepareSchema = z.strictObject({
  refundId: canonicalUuidSchema,
  recoveryGrantId: canonicalUuidSchema,
  recoveryReferenceId: canonicalUuidSchema,
  expectedStateChangedAt: canonicalTimestampSchema
});

const activationCandidateSchema = z.strictObject({
  finalizationEffectId: canonicalUuidSchema,
  orderItemId: canonicalUuidSchema,
  titleId: canonicalUuidSchema,
  soldAsTitle: z.string().min(1).max(500),
  expectedCorrectionSetId: canonicalUuidSchema,
  expectedCorrectionVersion: positiveVersionSchema,
  expectedSourceFingerprint: sha256Schema
});

const deactivationCandidateSchema = z.strictObject({
  recoveryGrantId: canonicalUuidSchema,
  recoveryReferenceId: canonicalUuidSchema,
  expectedStateChangedAt: canonicalTimestampSchema,
  orderItemId: canonicalUuidSchema,
  titleId: canonicalUuidSchema,
  soldAsTitle: z.string().min(1).max(500)
});

const seedSchema = z.strictObject({
  refundId: canonicalUuidSchema,
  activationCandidates: z.array(activationCandidateSchema),
  deactivationCandidates: z.array(deactivationCandidateSchema)
});

const transitionSchema = z.strictObject({
  recoveryGrantId: canonicalUuidSchema,
  recoveryUserId: canonicalUuidSchema,
  recoveryTitleId: canonicalUuidSchema,
  previousState: z.enum(['active', 'revoked']).nullable(),
  nextState: z.enum(['active', 'revoked']),
  stateChangedAt: z.union([z.date(), canonicalTimestampSchema.transform((value) => new Date(value))])
}).transform((value) => ({ ...value, stateChangedAt: new Date(value.stateChangedAt) }));

const notificationSchema = z.strictObject({
  to: z.string().min(1).max(320),
  soldAsTitle: z.string().min(1).max(500)
});

type QueryResult = { readonly rows?: readonly unknown[] };

function staleState(): never {
  throw new FinancialAdminConflictError('stale_state');
}

function notEligible(): never {
  throw new FinancialAdminConflictError('not_eligible');
}

function invalidCommand(): never {
  throw new FinancialAdminPermanentError('invalid_command');
}

function commandFailed(): never {
  throw new FinancialAdminPermanentError('command_failed');
}

function queryRows(value: unknown): readonly unknown[] {
  if (!value || typeof value !== 'object') return commandFailed();
  const rows = (value as QueryResult).rows;
  if (!Array.isArray(rows)) return commandFailed();
  return rows;
}

async function executeRows(
  transaction: DatabaseTransaction,
  statement: SQL
): Promise<readonly unknown[]> {
  return queryRows(await transaction.execute(statement));
}

function parseOne<T>(schema: z.ZodType<T>, rows: readonly unknown[]): T {
  if (rows.length !== 1) return commandFailed();
  const parsed = schema.safeParse(rows[0]);
  if (!parsed.success) return commandFailed();
  return parsed.data;
}

function compareC(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Administrative recovery execution was aborted.', 'AbortError');
  }
}

function canonicalTransitionTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) return commandFailed();
  const canonical = value.toISOString();
  if (!UTC_MILLISECOND_TIMESTAMP.test(canonical)) return commandFailed();
  return canonical;
}

export function buildAdministrativeRecoveryActivationPreimage(
  unparsedFacts: AdministrativeRecoveryActivationFacts
): string {
  const facts = activationFactsSchema.parse(unparsedFacts);
  const correctedTotal = facts.cumulativeRefundSubtotalMinor +
    facts.cumulativeRefundTaxMinor;
  if (!Number.isSafeInteger(correctedTotal)) return commandFailed();
  const remaining = facts.itemTotalMinor - correctedTotal;
  if (!Number.isSafeInteger(remaining)) return commandFailed();
  const accessAfter = true;
  const accessChanged = facts.effectiveAccessBefore !== accessAfter;
  const existingGrantId = facts.existingRecoveryGrantId ?? '-';
  const existingGrantState = facts.existingRecoveryGrantId === null
    ? 'absent'
    : facts.existingRecoveryGrantState;
  const existingStateChangedAt = facts.existingRecoveryGrantId === null
    ? '-'
    : facts.existingRecoveryStateChangedAt;
  if (existingGrantState === null || existingStateChangedAt === null) {
    return commandFailed();
  }
  const lines = [
    'pale-orbit.admin-recovery-preview.v1',
    `refund_id=${facts.refundId}`,
    `payment_id=${facts.paymentId}`,
    `order_id=${facts.orderId}`,
    `finalization_effect_id=${facts.finalizationEffectId}`,
    `recovery_reference_id=${facts.recoveryReferenceId}`,
    `finalization_draft_id=${facts.finalizationDraftId}`,
    `finalization_draft_version=${facts.finalizationDraftVersion}`,
    `order_item_id=${facts.orderItemId}`,
    `title_id=${facts.titleId}`,
    `purchase_grant_id=${facts.purchaseGrantId}`,
    `allocation_total_minor=${facts.allocationTotalMinor}`,
    `allocation_subtotal_minor=${facts.allocationSubtotalMinor}`,
    `allocation_tax_minor=${facts.allocationTaxMinor}`,
    `item_subtotal_minor=${facts.itemSubtotalMinor}`,
    `item_tax_minor=${facts.itemTaxMinor}`,
    `item_total_minor=${facts.itemTotalMinor}`,
    `item_currency=${facts.itemCurrency}`,
    `existing_recovery_grant_id=${existingGrantId}`,
    `existing_recovery_grant_state=${existingGrantState}`,
    `existing_recovery_grant_state_changed_at=${existingStateChangedAt}`,
    `correction_set_id=${facts.correctionSetId}`,
    `correction_version=${facts.correctionVersion}`,
    `correction_kind=${facts.correctionKind}`,
    `correction_base_set_id=${facts.correctionBaseSetId}`,
    `correction_predecessor_correction_set_id=${facts.correctionPredecessorSetId ?? '-'}`,
    `correction_source_fingerprint_sha256=${facts.correctionSourceFingerprint}`,
    `projection_classifier_version=${facts.projectionClassifierVersion}`,
    `projection_allocation_algorithm_version=${facts.projectionAllocationAlgorithmVersion}`,
    `source_balance_transaction_id=${facts.sourceBalanceTransactionId}`,
    `source_fingerprint_sha256=${facts.sourceFingerprint}`,
    `projection_head_count=${facts.projectionHeadLines.length}`,
    ...facts.projectionHeadLines,
    `projection_item_count=${facts.projectionItemLines.length}`,
    ...facts.projectionItemLines,
    `presentment_evidence_count=${facts.presentmentEvidenceLines.length}`,
    ...facts.presentmentEvidenceLines,
    `cumulative_refund_subtotal_minor=${facts.cumulativeRefundSubtotalMinor}`,
    `cumulative_refund_tax_minor=${facts.cumulativeRefundTaxMinor}`,
    `cumulative_refund_total_minor=${correctedTotal}`,
    `remaining_unrefunded_minor=${remaining}`,
    `effective_access_before=${facts.effectiveAccessBefore ? 1 : 0}`,
    'effective_access_after=1',
    `access_changed=${accessChanged ? 1 : 0}`,
    `email_queued=${accessChanged ? 1 : 0}`,
    ''
  ];
  const preimage = lines.join('\n');
  if (!isAscii(preimage)) return commandFailed();
  return preimage;
}

export function fingerprintAdministrativeRecoveryActivation(
  facts: AdministrativeRecoveryActivationFacts
): string {
  return createHash('sha256')
    .update(buildAdministrativeRecoveryActivationPreimage(facts), 'utf8')
    .digest('hex');
}

function activationBindingIsCurrent(
  input: AdministrativeRecoveryPrepareInput,
  facts: AdministrativeRecoveryActivationFacts
): boolean {
  return input.refundId === facts.refundId &&
    input.finalizationEffectId === facts.finalizationEffectId &&
    input.orderItemId === facts.orderItemId &&
    input.expectedCorrectionSetId === facts.correctionSetId &&
    input.expectedCorrectionVersion === facts.correctionVersion &&
    input.expectedSourceFingerprint === facts.correctionSourceFingerprint &&
    input.expectedSourceFingerprint === facts.sourceFingerprint;
}

export function planAdministrativeRecoveryActivation(
  unparsedInput: AdministrativeRecoveryPrepareInput,
  unparsedFacts: AdministrativeRecoveryActivationFacts
): AdministrativeRecoveryPreviewDto {
  const parsedInput = activationPrepareSchema.safeParse(unparsedInput);
  const parsedFacts = activationFactsSchema.safeParse(unparsedFacts);
  if (!parsedInput.success || !parsedFacts.success) return staleState();
  const input = parsedInput.data;
  const facts = parsedFacts.data;
  if (!activationBindingIsCurrent(input, facts) || !facts.bindingLinksValid) {
    return staleState();
  }

  const correctedTotal = facts.cumulativeRefundSubtotalMinor +
    facts.cumulativeRefundTaxMinor;
  if (!Number.isSafeInteger(correctedTotal)) return commandFailed();
  const causal = facts.causalLinksValid &&
    facts.effectTransition === 'revoked_by_finalization' &&
    facts.effectBeforePurchaseGrantState !== 'revoked' &&
    facts.effectAfterPurchaseGrantState === 'revoked' &&
    facts.allocationSource === 'administrative' &&
    facts.purchaseGrantState === 'revoked' &&
    facts.allocationSubtotalMinor + facts.allocationTaxMinor ===
      facts.allocationTotalMinor &&
    facts.itemSubtotalMinor + facts.itemTaxMinor === facts.itemTotalMinor;
  const reason: AdministrativeRecoveryPreviewDto['ineligibleReason'] =
    !causal ? 'not_causally_revoked'
      : facts.projectionPending || !facts.projectionComplete ||
          facts.projectionHeadLines.length !== 2 ||
          facts.cumulativeRefundSubtotalMinor > facts.itemSubtotalMinor ||
          facts.cumulativeRefundTaxMinor > facts.itemTaxMinor
        ? 'correction_rebase_required'
        : correctedTotal >= facts.itemTotalMinor
          ? 'still_fully_refunded'
          : facts.purchaseUserId === null
            ? 'unclaimed_purchase'
            : facts.existingRecoveryGrantState === 'active'
              ? 'already_in_requested_state'
              : null;
  const eligible = reason === null;
  const effectiveAccessAfter = eligible ? true : facts.effectiveAccessBefore;
  const accessChanged = eligible &&
    facts.effectiveAccessBefore !== effectiveAccessAfter;
  return {
    refundId: facts.refundId,
    finalizationEffectId: facts.finalizationEffectId,
    orderItemId: facts.orderItemId,
    titleId: facts.titleId,
    soldAsTitle: facts.soldAsTitle,
    expectedCorrectionSetId: facts.correctionSetId,
    expectedCorrectionVersion: facts.correctionVersion,
    expectedSourceFingerprint: facts.sourceFingerprint,
    previewFingerprint: eligible
      ? fingerprintAdministrativeRecoveryActivation(facts)
      : null,
    recoveryGrantId: facts.existingRecoveryGrantId,
    eligible,
    ineligibleReason: reason,
    effectiveAccessBefore: facts.effectiveAccessBefore,
    effectiveAccessAfter,
    accessChanged,
    emailQueued: accessChanged,
    persistsUntilDeactivated: true
  };
}

export function planAdministrativeRecoveryDeactivation(
  unparsedInput: AdministrativeRecoveryDeactivationPrepareInput,
  unparsedFacts: AdministrativeRecoveryDeactivationFacts
): AdministrativeRecoveryDeactivationPreviewDto {
  const parsedInput = deactivationPrepareSchema.safeParse(unparsedInput);
  const parsedFacts = deactivationFactsSchema.safeParse(unparsedFacts);
  if (!parsedInput.success || !parsedFacts.success) return staleState();
  const input = parsedInput.data;
  const facts = parsedFacts.data;
  if (!facts.linkageValid || input.refundId !== facts.refundId ||
    input.recoveryGrantId !== facts.recoveryGrantId ||
    input.recoveryReferenceId !== facts.recoveryReferenceId ||
    input.expectedStateChangedAt !== facts.stateChangedAt) return staleState();
  const eligible = facts.state === 'active';
  const effectiveAccessAfter = eligible
    ? facts.anotherActiveGrantExists
    : facts.effectiveAccessBefore;
  const accessChanged = eligible &&
    facts.effectiveAccessBefore !== effectiveAccessAfter;
  return {
    refundId: facts.refundId,
    recoveryGrantId: facts.recoveryGrantId,
    recoveryReferenceId: facts.recoveryReferenceId,
    expectedStateChangedAt: facts.stateChangedAt,
    orderItemId: facts.orderItemId,
    titleId: facts.titleId,
    soldAsTitle: facts.soldAsTitle,
    eligible,
    ineligibleReason: eligible ? null : 'already_in_requested_state',
    effectiveAccessBefore: facts.effectiveAccessBefore,
    effectiveAccessAfter,
    accessChanged,
    emailQueued: accessChanged
  };
}

async function loadSeedDefault(
  transaction: DatabaseTransaction,
  refundId: string
): Promise<AdministrativeRecoverySeedDto | null> {
  const rows = await executeRows(transaction, sql`
    /* administrative-recovery:seed */
    with current_tip as (
      select max(head.compatible_correction_tip_id::text)::uuid as correction_set_id
      from financial_allocation_sets allocation_set
      join current_financial_projection_heads head
        on head.base_set_id = allocation_set.id
      where allocation_set.source_kind = 'refund'
        and allocation_set.source_internal_id = ${refundId}::uuid
      having count(*) = 2 and count(distinct head.basis) = 2
        and count(head.compatible_correction_tip_id) = 2
        and count(distinct head.compatible_correction_tip_id) = 1
        and bool_and(head.is_complete and head.missing_source_count = 0
          and head.proposed_issue_code is null)
    ), activation_candidates as (
      select effect.id as "finalizationEffectId", effect.order_item_id as "orderItemId",
        item.title_id as "titleId", item.title_snapshot as "soldAsTitle",
        correction.id as "expectedCorrectionSetId",
        correction.correction_version as "expectedCorrectionVersion",
        correction.source_fingerprint_sha256 as "expectedSourceFingerprint"
      from refund_allocation_finalization_effects effect
      join refund_allocations allocation on allocation.id = effect.refund_allocation_id
      join order_items item on item.id = effect.order_item_id
      join entitlement_grants purchase on purchase.id = effect.purchase_grant_id
        and purchase.order_item_id = effect.order_item_id and purchase.source = 'purchase'
      join refund_allocation_drafts draft on draft.id = effect.draft_id
       and draft.refund_id = effect.refund_id and draft.version = effect.draft_version
       and draft.state = 'finalized'
      join current_tip on true
      join refund_reporting_correction_sets correction
        on correction.id = current_tip.correction_set_id
       and correction.refund_id = effect.refund_id
      left join entitlement_grants recovery on recovery.source = 'administrative'
       and recovery.recovery_refund_allocation_id = allocation.id
      where effect.refund_id = ${refundId}::uuid
        and effect.transition = 'revoked_by_finalization'
        and effect.before_purchase_grant_state <> 'revoked'
        and effect.after_purchase_grant_state = 'revoked'
        and allocation.source = 'administrative'
        and allocation.refund_id = effect.refund_id
        and allocation.order_item_id = effect.order_item_id
        and purchase.state = 'revoked' and purchase.title_id = item.title_id
        and (recovery.id is null or recovery.state = 'revoked')
    ), deactivation_candidates as (
      select recovery.id as "recoveryGrantId",
        recovery.recovery_refund_allocation_id as "recoveryReferenceId",
        to_char(timezone('UTC', recovery.updated_at),
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expectedStateChangedAt",
        effect.order_item_id as "orderItemId", item.title_id as "titleId",
        item.title_snapshot as "soldAsTitle"
      from entitlement_grants recovery
      join refund_allocations allocation
        on allocation.id = recovery.recovery_refund_allocation_id
      join refund_allocation_finalization_effects effect
        on effect.refund_allocation_id = allocation.id
       and effect.transition = 'revoked_by_finalization'
      join order_items item on item.id = effect.order_item_id
      join entitlement_grants purchase on purchase.id = effect.purchase_grant_id
       and purchase.source = 'purchase' and purchase.order_item_id = effect.order_item_id
      where allocation.refund_id = ${refundId}::uuid
        and allocation.source = 'administrative'
        and allocation.refund_id = effect.refund_id
        and allocation.order_item_id = effect.order_item_id
        and effect.before_purchase_grant_state <> 'revoked'
        and effect.after_purchase_grant_state = 'revoked'
        and purchase.user_id = recovery.user_id
        and purchase.title_id = recovery.title_id
        and item.title_id = recovery.title_id
        and recovery.source = 'administrative' and recovery.state = 'active'
    )
    select refund.id as "refundId",
      coalesce((select jsonb_agg(to_jsonb(candidate)
        order by candidate."finalizationEffectId") from activation_candidates candidate),
        '[]'::jsonb) as "activationCandidates",
      coalesce((select jsonb_agg(to_jsonb(candidate)
        order by candidate."recoveryGrantId") from deactivation_candidates candidate),
        '[]'::jsonb) as "deactivationCandidates"
    from refunds refund where refund.id = ${refundId}::uuid
  `);
  if (rows.length === 0) return null;
  return parseOne(seedSchema, rows);
}

async function loadActivationFactsDefault(
  transaction: DatabaseTransaction,
  input: AdministrativeRecoveryPrepareInput
): Promise<AdministrativeRecoveryActivationFacts | null> {
  const rows = await executeRows(transaction, sql`
    /* administrative-recovery:activation-facts */
    with root as materialized (
      select refund.id as refund_id, refund.payment_id, payment.order_id,
        effect.id as effect_id, effect.refund_allocation_id,
        effect.draft_id, effect.draft_version, effect.order_item_id,
        effect.purchase_grant_id, effect.transition,
        effect.before_purchase_grant_state, effect.after_purchase_grant_state,
        allocation.source as allocation_source,
        allocation.amount_minor as allocation_total_minor,
        component.subtotal_minor as allocation_subtotal_minor,
        component.tax_minor as allocation_tax_minor,
        item.title_id, item.title_snapshot, item.unit_subtotal_minor,
        item.tax_minor as item_tax_minor, item.total_minor as item_total_minor,
        item.currency as item_currency,
        purchase.user_id as purchase_user_id, purchase.state as purchase_state,
        recovery.id as recovery_id, recovery.state as recovery_state,
        case when recovery.id is null then null else
          to_char(timezone('UTC', recovery.updated_at),
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end as recovery_updated_at,
        correction.id as correction_id, correction.correction_version,
        correction.kind as correction_kind,
        correction.base_allocation_set_id,
        correction.predecessor_correction_set_id,
        correction.source_fingerprint_sha256 as correction_fingerprint,
        projection.classifier_version, projection.allocation_algorithm_version,
        (projection.pending_classifier_version is not null or
          projection.pending_allocation_algorithm_version is not null or
          projection.pending_replay_id is not null or
          projection.pending_scan_run_id is not null) as projection_pending,
        base_set.balance_transaction_id,
        source_balance.fingerprint_sha256 as source_fingerprint,
        (effect.refund_id = refund.id
          and effect.order_item_id = ${input.orderItemId}::uuid
          and allocation.id = effect.refund_allocation_id
          and allocation.refund_id = effect.refund_id
          and allocation.order_item_id = effect.order_item_id
          and component.refund_allocation_id = allocation.id
          and component.refund_id = allocation.refund_id
          and component.order_item_id = allocation.order_item_id
          and component.total_minor = allocation.amount_minor
          and component.subtotal_minor + component.tax_minor = component.total_minor
          and component.currency = item.currency
          and item.id = effect.order_item_id and item.order_id = payment.order_id
          and item.tax_minor is not null and item.total_minor is not null
          and item.total_minor = item.unit_subtotal_minor + item.tax_minor
          and purchase.id = effect.purchase_grant_id
          and purchase.source = 'purchase'
          and purchase.order_item_id = effect.order_item_id
          and purchase.title_id = item.title_id
          and correction.refund_id = refund.id
          and correction.correction_version = ${input.expectedCorrectionVersion}
          and correction.source_fingerprint_sha256 = ${input.expectedSourceFingerprint}
          and base_set.source_kind = 'refund'
          and base_set.source_internal_id = refund.id
          and base_set.source_fingerprint_sha256 = correction.source_fingerprint_sha256
          and base_set.classifier_version = projection.classifier_version
          and base_set.algorithm_version = projection.allocation_algorithm_version
          and source_balance.source_family = 'refund'
          and source_balance.source_id = refund.stripe_refund_id
          and source_balance.fingerprint_sha256 = correction.source_fingerprint_sha256
          and purchase_order.status = 'paid' and payment.status = 'succeeded'
          and payment.order_id = purchase_order.id
          and payment.amount_minor = purchase_order.total_minor
          and payment.currency = purchase_order.currency
          and (select count(*) from order_items graph_item
            where graph_item.order_id = purchase_order.id) between 1 and 2147483647
          and (select coalesce(sum(graph_item.total_minor::bigint), 0)
            from order_items graph_item where graph_item.order_id = purchase_order.id)
              = payment.amount_minor::bigint
          and not exists(select 1 from order_items graph_item
            where graph_item.order_id = purchase_order.id and (
              graph_item.currency <> purchase_order.currency
              or graph_item.currency <> payment.currency
              or graph_item.tax_minor is null or graph_item.total_minor is null
              or graph_item.unit_subtotal_minor not between 0 and 99999999
              or graph_item.tax_minor not between 0 and 99999999
              or graph_item.total_minor not between 0 and 99999999
              or graph_item.total_minor <> graph_item.unit_subtotal_minor + graph_item.tax_minor))
          and refund.status = 'succeeded' and refund.allocation_status = 'finalized'
          and draft.id = effect.draft_id and draft.refund_id = effect.refund_id
          and draft.version = effect.draft_version and draft.state = 'finalized'
          and not exists(select 1 from refund_reporting_correction_sets successor
            where successor.predecessor_correction_set_id = correction.id)
          and not exists(select 1 from financial_allocation_sets successor
            where successor.supersedes_set_id = base_set.id)) as binding_links_valid,
        (effect.transition = 'revoked_by_finalization'
          and effect.before_purchase_grant_state <> 'revoked'
          and effect.after_purchase_grant_state = 'revoked'
          and allocation.source = 'administrative'
          and purchase.state = 'revoked'
          and (recovery.id is null or (recovery.state in ('active','revoked')
            and recovery.state_reason = 'refund_allocation_recovery'
            and recovery.order_item_id is null
            and recovery.user_id is not distinct from purchase.user_id
            and recovery.title_id = purchase.title_id
            and recovery.recovery_refund_allocation_id = allocation.id
            and recovery.updated_at = date_trunc('milliseconds', recovery.updated_at))))
          as causal_links_valid
      from refunds refund
      join payments payment on payment.id = refund.payment_id
      join orders purchase_order on purchase_order.id = payment.order_id
      join refund_allocation_finalization_effects effect
        on effect.id = ${input.finalizationEffectId}::uuid
      join refund_allocations allocation on allocation.id = effect.refund_allocation_id
      join refund_allocation_components component
        on component.refund_allocation_id = allocation.id
       and component.refund_id = allocation.refund_id
       and component.order_item_id = allocation.order_item_id
      join order_items item on item.id = effect.order_item_id
      join entitlement_grants purchase on purchase.id = effect.purchase_grant_id
      join refund_allocation_drafts draft on draft.id = effect.draft_id
      left join entitlement_grants recovery on recovery.source = 'administrative'
       and recovery.recovery_refund_allocation_id = allocation.id
      join refund_reporting_correction_sets correction
        on correction.id = ${input.expectedCorrectionSetId}::uuid
      join financial_allocation_sets base_set
        on base_set.id = correction.base_allocation_set_id
      join stripe_balance_transactions source_balance
        on source_balance.id = base_set.balance_transaction_id
      join financial_projection_versions projection on projection.singleton = true
      where refund.id = ${input.refundId}::uuid
    ), relevant_balance_transactions as materialized (
      select root.balance_transaction_id from root
      union
      select allocation_set.balance_transaction_id
      from root
      join refunds candidate on candidate.payment_id = root.payment_id
        and candidate.status = 'succeeded'
      join financial_allocation_sets allocation_set
        on allocation_set.source_kind = 'refund'
       and allocation_set.source_internal_id = candidate.id
       and allocation_set.classifier_version = root.classifier_version
       and allocation_set.algorithm_version = root.allocation_algorithm_version
       and not exists(select 1 from financial_allocation_sets successor
         where successor.supersedes_set_id = allocation_set.id)
    ), projection_heads as materialized (
      select head.* from current_financial_projection_heads head
      join relevant_balance_transactions relevant
        on relevant.balance_transaction_id = head.balance_transaction_id
    ), projection_items as materialized (
      /* Keep these two branches in exact semantic parity with
         the projection-item view while reusing the bounded head snapshot. */
      select head.balance_transaction_id, head.basis, head.base_set_id,
        head.compatible_correction_tip_id, base.order_item_id, base.component,
        base.effect_minor, base.currency
      from projection_heads head
      join financial_item_allocations base on base.allocation_set_id = head.base_set_id
      where head.is_complete and head.scope = 'title'
        and not exists(
          select 1 from refund_reporting_correction_items correction
          where correction.correction_set_id = head.compatible_correction_tip_id
            and correction.source_allocation_set_id = head.base_set_id
            and correction.domain = 'settlement')
      union all
      select head.balance_transaction_id, head.basis, head.base_set_id,
        head.compatible_correction_tip_id, correction.order_item_id,
        correction.component, correction.approved_absolute_minor as effect_minor,
        correction.currency
      from projection_heads head
      join refund_reporting_correction_items correction
        on correction.correction_set_id = head.compatible_correction_tip_id
       and correction.source_allocation_set_id = head.base_set_id
       and correction.domain = 'settlement'
      where head.is_complete and head.scope = 'title'
    ), head_lines as (
      select count(head.balance_transaction_id)::integer as row_count,
        count(distinct head.basis)::integer as distinct_basis_count,
        count(head.balance_transaction_id) filter (where
          head.basis in ('gross_amount','fee')
          and head.base_set_id is not null
          and head.compatible_correction_tip_id = root.correction_id
          and head.scope in ('title','account')
          and head.currency ~ '^[A-Z]{3}$'
          and head.expected_effect_minor between -99999999 and 99999999
          and head.is_complete and head.missing_source_count = 0
          and head.proposed_issue_code is null
          and allocation_set.source_kind = 'refund'
          and allocation_set.source_internal_id = root.refund_id
          and allocation_set.classifier_version = root.classifier_version
          and allocation_set.algorithm_version = root.allocation_algorithm_version
          and allocation_set.source_fingerprint_sha256 = root.correction_fingerprint
        )::integer as valid_count,
        coalesce(array_agg(
          'projection_head=' || head.basis::text || '|' || head.base_set_id::text ||
          '|' || head.compatible_correction_tip_id::text || '|' || head.scope::text ||
          '|' || head.currency || '|' || head.expected_effect_minor::text || '|1|0|-'
          order by case head.basis when 'gross_amount' then 1 when 'fee' then 2 else 3 end
        ) filter (where head.balance_transaction_id is not null
          and head.basis in ('gross_amount','fee')
          and head.base_set_id is not null
          and head.compatible_correction_tip_id = root.correction_id
          and head.scope in ('title','account')
          and head.currency ~ '^[A-Z]{3}$'
          and head.expected_effect_minor between -99999999 and 99999999
          and head.is_complete and head.missing_source_count = 0
          and head.proposed_issue_code is null
          and allocation_set.source_kind = 'refund'
          and allocation_set.source_internal_id = root.refund_id
          and allocation_set.classifier_version = root.classifier_version
          and allocation_set.algorithm_version = root.allocation_algorithm_version
          and allocation_set.source_fingerprint_sha256 = root.correction_fingerprint),
          array[]::text[]) as lines
      from root
      left join projection_heads head
        on head.balance_transaction_id = root.balance_transaction_id
      left join financial_allocation_sets allocation_set on allocation_set.id = head.base_set_id
      group by root.correction_id, root.refund_id, root.classifier_version,
        root.allocation_algorithm_version
    ), item_lines as (
      select count(item.balance_transaction_id)::integer as row_count,
        (count(distinct row(item.basis, item.base_set_id,
          item.compatible_correction_tip_id, item.order_item_id,
          item.component, item.effect_minor, item.currency))
          filter (where item.balance_transaction_id is not null))::integer
          as distinct_row_count,
        count(item.balance_transaction_id) filter (where
          item.basis in ('gross_amount','fee')
          and item.base_set_id is not null
          and item.compatible_correction_tip_id = root.correction_id
          and item.order_item_id is not null
          and item.component in ('refund_subtotal','refund_tax','refund_fee')
          and item.effect_minor between -99999999 and 99999999
          and item.currency ~ '^[A-Z]{3}$'
          and allocation_set.source_kind = 'refund'
          and allocation_set.source_internal_id = root.refund_id
          and allocation_set.classifier_version = root.classifier_version
          and allocation_set.algorithm_version = root.allocation_algorithm_version
          and allocation_set.source_fingerprint_sha256 = root.correction_fingerprint
        )::integer as valid_count,
        coalesce(array_agg(
          'projection_item=' || item.basis::text || '|' || item.base_set_id::text ||
          '|' || item.compatible_correction_tip_id::text || '|' ||
          item.order_item_id::text || '|' || item.component::text || '|' ||
          item.effect_minor::text || '|' || item.currency
          order by case item.basis when 'gross_amount' then 1 when 'fee' then 2 else 3 end,
            item.order_item_id::text collate "C",
            case item.component when 'refund_subtotal' then 1 when 'refund_tax' then 2
              when 'refund_fee' then 3 else 4 end, item.currency collate "C",
            item.effect_minor
        ) filter (where item.balance_transaction_id is not null
          and item.basis in ('gross_amount','fee')
          and item.base_set_id is not null
          and item.compatible_correction_tip_id = root.correction_id
          and item.order_item_id is not null
          and item.component in ('refund_subtotal','refund_tax','refund_fee')
          and item.effect_minor between -99999999 and 99999999
          and item.currency ~ '^[A-Z]{3}$'
          and allocation_set.source_kind = 'refund'
          and allocation_set.source_internal_id = root.refund_id
          and allocation_set.classifier_version = root.classifier_version
          and allocation_set.algorithm_version = root.allocation_algorithm_version
          and allocation_set.source_fingerprint_sha256 = root.correction_fingerprint),
          array[]::text[]) as lines
      from root
      left join projection_items item
        on item.balance_transaction_id = root.balance_transaction_id
      left join financial_allocation_sets allocation_set on allocation_set.id = item.base_set_id
      group by root.correction_id, root.refund_id, root.classifier_version,
        root.allocation_algorithm_version
    ), succeeded_refunds as materialized (
      select candidate.id, candidate.currency
      from root join refunds candidate on candidate.payment_id = root.payment_id
      where candidate.status = 'succeeded'
    ), active_head_rows as materialized (
      select succeeded.id as refund_id, head.balance_transaction_id, head.basis,
        head.base_set_id, head.compatible_correction_tip_id, head.is_complete,
        head.missing_source_count, head.proposed_issue_code,
        allocation_set.source_fingerprint_sha256
      from root cross join succeeded_refunds succeeded
      join financial_allocation_sets allocation_set
        on allocation_set.source_kind = 'refund'
       and allocation_set.source_internal_id = succeeded.id
       and allocation_set.classifier_version = root.classifier_version
       and allocation_set.algorithm_version = root.allocation_algorithm_version
       and not exists(select 1 from financial_allocation_sets successor
         where successor.supersedes_set_id = allocation_set.id)
      join projection_heads head
        on head.balance_transaction_id = allocation_set.balance_transaction_id
       and head.basis = allocation_set.basis and head.base_set_id = allocation_set.id
    ), evidence_head_rollup as materialized (
      select succeeded.id as refund_id,
        count(head.refund_id)::integer as head_count,
        count(distinct head.basis)::integer as basis_count,
        count(distinct head.balance_transaction_id)::integer as balance_count,
        count(distinct head.base_set_id)::integer as base_set_count,
        count(distinct head.source_fingerprint_sha256)::integer as fingerprint_count,
        max(head.source_fingerprint_sha256) as source_fingerprint,
        count(head.compatible_correction_tip_id)::integer as tip_count,
        count(distinct head.compatible_correction_tip_id)::integer as distinct_tip_count,
        case when count(head.compatible_correction_tip_id) = 2
          and count(distinct head.compatible_correction_tip_id) = 1
          then max(head.compatible_correction_tip_id::text)::uuid else null end as tip_id,
        coalesce(bool_and(head.is_complete and head.missing_source_count = 0
          and head.proposed_issue_code is null), false) as heads_complete
      from succeeded_refunds succeeded
      left join active_head_rows head on head.refund_id = succeeded.id
      group by succeeded.id
    ), evidence_context as materialized (
      select succeeded.id as refund_id, component_kind.component,
        component_kind.rank, succeeded.currency as refund_currency,
        rollup.head_count, rollup.basis_count, rollup.balance_count,
        rollup.base_set_count, rollup.fingerprint_count,
        rollup.source_fingerprint, rollup.tip_count, rollup.distinct_tip_count,
        rollup.tip_id, rollup.heads_complete, tip.correction_version,
        (rollup.tip_id is not null and exists(
          select 1 from refund_reporting_correction_items presentment_item
          where presentment_item.correction_set_id = rollup.tip_id
            and presentment_item.domain = 'presentment')) as uses_correction,
        allocation.id as base_allocation_id,
        component.refund_allocation_id as base_component_id,
        case component_kind.component when 'refund_subtotal' then component.subtotal_minor
          when 'refund_tax' then component.tax_minor else null end as base_amount_minor,
        component.currency as base_currency,
        correction_candidate.candidate_count,
        correction_candidate.amount_minor as correction_amount_minor,
        correction_candidate.currency_valid
      from root cross join succeeded_refunds succeeded
      join evidence_head_rollup rollup on rollup.refund_id = succeeded.id
      cross join (values ('refund_subtotal'::text, 1), ('refund_tax'::text, 2))
        component_kind(component, rank)
      left join refund_reporting_correction_sets tip
        on tip.id = rollup.tip_id and tip.refund_id = succeeded.id
      left join refund_allocations allocation on allocation.refund_id = succeeded.id
        and allocation.order_item_id = root.order_item_id
      left join refund_allocation_components component
        on component.refund_allocation_id = allocation.id
       and component.refund_id = allocation.refund_id
       and component.order_item_id = allocation.order_item_id
      left join lateral (
        select count(*)::integer as candidate_count,
          coalesce(max(correction_item.approved_absolute_minor), 0)::integer
            as amount_minor,
          coalesce(bool_and(correction_item.currency = root.item_currency), true)
            as currency_valid
        from refund_reporting_correction_items correction_item
        where correction_item.correction_set_id = rollup.tip_id
          and correction_item.domain = 'presentment'
          and correction_item.order_item_id = root.order_item_id
          and correction_item.component::text = component_kind.component
      ) correction_candidate on true
    ), resolved_evidence as materialized (
      select evidence.*,
        case when evidence.uses_correction then evidence.correction_amount_minor
          else coalesce(evidence.base_amount_minor, 0) end::integer as amount_minor,
        (evidence.refund_id is not null
          and evidence.component in ('refund_subtotal','refund_tax')
          and evidence.refund_currency = root.item_currency
          and evidence.head_count = 2 and evidence.basis_count = 2
          and evidence.balance_count = 1 and evidence.base_set_count = 2
          and evidence.fingerprint_count = 1 and evidence.heads_complete
          and evidence.source_fingerprint ~ '^[a-f0-9]{64}$'
          and ((evidence.tip_count = 2 and evidence.distinct_tip_count = 1
            and evidence.tip_id is not null
            and evidence.correction_version between 1 and 2147483647
            and evidence.source_fingerprint = (
              select current_tip.source_fingerprint_sha256
              from refund_reporting_correction_sets current_tip
              where current_tip.id = evidence.tip_id
                and current_tip.refund_id = evidence.refund_id)
            and (evidence.refund_id <> root.refund_id
              or evidence.tip_id = root.correction_id))
            or (evidence.refund_id <> root.refund_id and evidence.tip_count = 0
              and evidence.distinct_tip_count = 0 and evidence.tip_id is null
              and evidence.correction_version is null))
          and ((evidence.uses_correction and evidence.tip_id is not null
            and evidence.correction_version between 1 and 2147483647
            and evidence.candidate_count between 0 and 1 and evidence.currency_valid
            and evidence.correction_amount_minor between 0 and 99999999)
            or (not evidence.uses_correction and
              ((evidence.base_allocation_id is null
                and evidence.base_component_id is null
                and evidence.base_amount_minor is null)
               or (evidence.base_allocation_id is not null
                and evidence.base_component_id = evidence.base_allocation_id
                and evidence.base_currency = evidence.refund_currency
                and evidence.base_amount_minor between 0 and 99999999))))) as resolved
      from root cross join evidence_context evidence
    ), serialized_evidence as (
      select resolved_evidence.*,
        case when resolved then
          'presentment_evidence=' || refund_id::text || '|' ||
          case when uses_correction then 'correction' else 'base' end || '|' ||
          case when uses_correction then '-' else coalesce(base_allocation_id::text, '-') end ||
          '|' || case when uses_correction then tip_id::text else '-' end || '|' ||
          case when uses_correction then correction_version::text else '-' end || '|' ||
          component || '|' || amount_minor::text else null end as serialized_line
      from resolved_evidence
    ), evidence_rollup as (
      select (select count(*)::integer from succeeded_refunds) as refund_count,
        count(*)::integer as row_count,
        count(*) filter (where resolved)::integer as resolved_count,
        count(serialized_line)::integer as serialized_count,
        coalesce(bool_and(resolved), false) as all_valid,
        coalesce(array_agg(serialized_line order by refund_id::text collate "C", rank)
          filter (where serialized_line is not null), array[]::text[]) as lines,
        coalesce(sum(amount_minor) filter (where component = 'refund_subtotal'), 0)::float8
          as subtotal_minor,
        coalesce(sum(amount_minor) filter (where component = 'refund_tax'), 0)::float8
          as tax_minor
      from serialized_evidence
    )
    select root.refund_id as "refundId", root.payment_id as "paymentId",
      root.order_id as "orderId", root.effect_id as "finalizationEffectId",
      root.refund_allocation_id as "recoveryReferenceId",
      root.draft_id as "finalizationDraftId",
      root.draft_version as "finalizationDraftVersion",
      root.order_item_id as "orderItemId", root.title_id as "titleId",
      root.title_snapshot as "soldAsTitle",
      root.purchase_grant_id as "purchaseGrantId",
      root.purchase_user_id as "purchaseUserId", root.purchase_state as "purchaseGrantState",
      root.transition as "effectTransition",
      root.before_purchase_grant_state as "effectBeforePurchaseGrantState",
      root.after_purchase_grant_state as "effectAfterPurchaseGrantState",
      root.allocation_source as "allocationSource",
      root.allocation_total_minor as "allocationTotalMinor",
      root.allocation_subtotal_minor as "allocationSubtotalMinor",
      root.allocation_tax_minor as "allocationTaxMinor",
      root.unit_subtotal_minor as "itemSubtotalMinor",
      root.item_tax_minor as "itemTaxMinor", root.item_total_minor as "itemTotalMinor",
      root.item_currency as "itemCurrency", root.recovery_id as "existingRecoveryGrantId",
      root.recovery_state as "existingRecoveryGrantState",
      root.recovery_updated_at as "existingRecoveryStateChangedAt",
      root.correction_id as "correctionSetId",
      root.correction_version as "correctionVersion",
      root.correction_kind as "correctionKind",
      root.base_allocation_set_id as "correctionBaseSetId",
      root.predecessor_correction_set_id as "correctionPredecessorSetId",
      root.correction_fingerprint as "correctionSourceFingerprint",
      root.classifier_version as "projectionClassifierVersion",
      root.allocation_algorithm_version as "projectionAllocationAlgorithmVersion",
      root.projection_pending as "projectionPending",
      root.balance_transaction_id as "sourceBalanceTransactionId",
      root.source_fingerprint as "sourceFingerprint",
      head_lines.lines as "projectionHeadLines", item_lines.lines as "projectionItemLines",
      evidence_rollup.lines as "presentmentEvidenceLines",
      evidence_rollup.subtotal_minor as "cumulativeRefundSubtotalMinor",
      evidence_rollup.tax_minor as "cumulativeRefundTaxMinor",
      exists(select 1 from entitlement_grants effective
        where effective.user_id = root.purchase_user_id
          and effective.title_id = root.title_id and effective.state = 'active')
        as "effectiveAccessBefore",
      (head_lines.row_count = 2 and head_lines.distinct_basis_count = 2
        and head_lines.valid_count = 2
        and item_lines.row_count = item_lines.distinct_row_count
        and item_lines.row_count = item_lines.valid_count
        and evidence_rollup.refund_count between 1 and ${MAX_REFUND_CLOSURE}
        and evidence_rollup.row_count = 2 * evidence_rollup.refund_count
        and evidence_rollup.resolved_count = evidence_rollup.row_count
        and evidence_rollup.serialized_count = evidence_rollup.row_count
        and evidence_rollup.all_valid
        and evidence_rollup.subtotal_minor between 0 and root.unit_subtotal_minor
        and evidence_rollup.tax_minor between 0 and root.item_tax_minor
        and not exists(
          select 1 from refunds candidate
          where candidate.payment_id = root.payment_id
            and candidate.status = 'succeeded' and (
              candidate.allocation_status <> 'finalized'
              or candidate.financial_evidence_status = 'exception'
              or exists(select 1 from refund_allocation_drafts active_draft
                where active_draft.refund_id = candidate.id
                  and active_draft.state = 'active')
              or (select coalesce(sum(allocation.amount_minor::bigint), 0)
                from refund_allocations allocation
                where allocation.refund_id = candidate.id) <> candidate.amount_minor::bigint
              or exists(
                select 1 from refund_allocations allocation
                left join order_items allocated_item
                  on allocated_item.id = allocation.order_item_id
                left join refund_allocation_components allocated_component
                  on allocated_component.refund_allocation_id = allocation.id
                 and allocated_component.refund_id = allocation.refund_id
                 and allocated_component.order_item_id = allocation.order_item_id
                where allocation.refund_id = candidate.id and (
                  allocated_item.order_id is distinct from root.order_id
                  or allocation.amount_minor not between 0 and 99999999
                  or allocated_component.refund_allocation_id is null
                  or allocated_component.total_minor is distinct from allocation.amount_minor
                  or allocated_component.total_minor is distinct from
                    allocated_component.subtotal_minor + allocated_component.tax_minor
                  or allocated_component.currency is distinct from candidate.currency
                  or allocated_component.currency is distinct from allocated_item.currency
                  or allocated_component.subtotal_minor not between 0 and
                    allocated_item.unit_subtotal_minor
                  or allocated_component.tax_minor not between 0 and allocated_item.tax_minor
                  or allocated_component.total_minor not between 0 and allocated_item.total_minor
                  or (select count(*) from refund_allocation_components exact_component
                    where exact_component.refund_allocation_id = allocation.id
                      and exact_component.refund_id = allocation.refund_id
                      and exact_component.order_item_id = allocation.order_item_id
                      and exact_component.total_minor = allocation.amount_minor
                      and exact_component.currency = candidate.currency) <> 1)))))
        as "projectionComplete",
      root.binding_links_valid as "bindingLinksValid",
      root.causal_links_valid as "causalLinksValid"
    from root cross join head_lines cross join item_lines cross join evidence_rollup
  `);
  if (rows.length === 0) return null;
  return parseOne(activationFactsSchema, rows);
}

async function loadDeactivationFactsDefault(
  transaction: DatabaseTransaction,
  input: AdministrativeRecoveryDeactivationPrepareInput
): Promise<AdministrativeRecoveryDeactivationFacts | null> {
  const rows = await executeRows(transaction, sql`
    /* administrative-recovery:deactivation-facts */
    select allocation.refund_id as "refundId", recovery.id as "recoveryGrantId",
      recovery.recovery_refund_allocation_id as "recoveryReferenceId",
      to_char(timezone('UTC', recovery.updated_at),
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "stateChangedAt",
      effect.order_item_id as "orderItemId", item.title_id as "titleId",
      item.title_snapshot as "soldAsTitle", recovery.state,
      exists(select 1 from entitlement_grants effective
        where effective.user_id = recovery.user_id
          and effective.title_id = recovery.title_id and effective.state = 'active')
        as "effectiveAccessBefore",
      exists(select 1 from entitlement_grants other
        where other.user_id = recovery.user_id and other.title_id = recovery.title_id
          and other.state = 'active' and other.id <> recovery.id)
        as "anotherActiveGrantExists",
      (recovery.source = 'administrative'
        and recovery.state_reason = 'refund_allocation_recovery'
        and recovery.order_item_id is null
        and allocation.source = 'administrative'
        and allocation.refund_id = effect.refund_id
        and allocation.order_item_id = effect.order_item_id
        and effect.transition = 'revoked_by_finalization'
        and effect.before_purchase_grant_state <> 'revoked'
        and effect.after_purchase_grant_state = 'revoked'
        and effect.refund_allocation_id = recovery.recovery_refund_allocation_id
        and effect.order_item_id = item.id
        and purchase.id = effect.purchase_grant_id
        and purchase.source = 'purchase'
        and purchase.order_item_id = effect.order_item_id
        and purchase.user_id = recovery.user_id
        and purchase.title_id = recovery.title_id
        and recovery.title_id = item.title_id) as "linkageValid"
    from entitlement_grants recovery
    join refund_allocations allocation
      on allocation.id = recovery.recovery_refund_allocation_id
    join refund_allocation_finalization_effects effect
      on effect.refund_allocation_id = allocation.id
     and effect.transition = 'revoked_by_finalization'
    join order_items item on item.id = effect.order_item_id
    join entitlement_grants purchase on purchase.id = effect.purchase_grant_id
      and purchase.order_item_id = effect.order_item_id
    where recovery.id = ${input.recoveryGrantId}::uuid
      and recovery.recovery_refund_allocation_id = ${input.recoveryReferenceId}::uuid
  `);
  if (rows.length === 0) return null;
  return parseOne(deactivationFactsSchema, rows);
}

export interface AdministrativeRecoveryServiceDependencies extends
  FinancialAuthorizationDependencies {
  readonly listRoles?: typeof listRolesForUser;
  readonly loadSeed?: typeof loadSeedDefault;
  readonly loadActivationFacts?: typeof loadActivationFactsDefault;
  readonly loadDeactivationFacts?: typeof loadDeactivationFactsDefault;
}

async function authorizeInTransaction(
  transaction: DatabaseTransaction,
  actor: Extract<Actor, { type: 'user' }>,
  dependencies: AdministrativeRecoveryServiceDependencies
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
  );
  const roles = await (dependencies.listRoles ?? listRolesForUser)(transaction, actor.id);
  const refreshedActor = { type: 'user' as const, id: actor.id, roles };
  requireCapability(refreshedActor, 'sales.read', dependencies.capabilityResolver);
  requireCapability(refreshedActor, 'reconciliation.manage', dependencies.capabilityResolver);
}

function requireRecoveryCapabilities(
  actor: Actor,
  dependencies: FinancialAuthorizationDependencies
): asserts actor is Extract<Actor, { type: 'user' }> {
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  requireCapability(actor, 'reconciliation.manage', dependencies.capabilityResolver);
}

export async function getAdministrativeRecoverySeed(
  database: Database,
  actor: Actor,
  refundId: string,
  _context: FinancialRequestContext,
  dependencies: AdministrativeRecoveryServiceDependencies = {}
): Promise<AdministrativeRecoverySeedDto | null> {
  requireRecoveryCapabilities(actor, dependencies);
  const parsedRefundId = canonicalUuidSchema.safeParse(refundId);
  if (!parsedRefundId.success) return null;
  return database.transaction(async (transaction) => {
    await authorizeInTransaction(transaction, actor, dependencies);
    const loaded = await (dependencies.loadSeed ?? loadSeedDefault)(
      transaction, parsedRefundId.data
    );
    if (loaded === null) return null;
    const parsed = seedSchema.safeParse(loaded);
    if (!parsed.success || parsed.data.refundId !== parsedRefundId.data) {
      return commandFailed();
    }
    return {
      refundId: parsed.data.refundId,
      activationCandidates: [...parsed.data.activationCandidates].sort((left, right) =>
        compareC(left.finalizationEffectId, right.finalizationEffectId)),
      deactivationCandidates: [...parsed.data.deactivationCandidates].sort((left, right) =>
        compareC(left.recoveryGrantId, right.recoveryGrantId))
    };
  });
}

export async function previewAdministrativeRecovery(
  database: Database,
  actor: Actor,
  input: AdministrativeRecoveryPrepareInput,
  _context: FinancialRequestContext,
  dependencies: AdministrativeRecoveryServiceDependencies = {}
): Promise<AdministrativeRecoveryPreviewDto> {
  requireRecoveryCapabilities(actor, dependencies);
  const parsed = activationPrepareSchema.safeParse(input);
  if (!parsed.success) return staleState();
  return database.transaction(async (transaction) => {
    await authorizeInTransaction(transaction, actor, dependencies);
    const facts = await (dependencies.loadActivationFacts ?? loadActivationFactsDefault)(
      transaction, parsed.data
    );
    if (facts === null) return staleState();
    return planAdministrativeRecoveryActivation(parsed.data, facts);
  });
}

export async function previewAdministrativeRecoveryDeactivation(
  database: Database,
  actor: Actor,
  input: AdministrativeRecoveryDeactivationPrepareInput,
  _context: FinancialRequestContext,
  dependencies: AdministrativeRecoveryServiceDependencies = {}
): Promise<AdministrativeRecoveryDeactivationPreviewDto> {
  requireRecoveryCapabilities(actor, dependencies);
  const parsed = deactivationPrepareSchema.safeParse(input);
  if (!parsed.success) return staleState();
  return database.transaction(async (transaction) => {
    await authorizeInTransaction(transaction, actor, dependencies);
    const facts = await (dependencies.loadDeactivationFacts ?? loadDeactivationFactsDefault)(
      transaction, parsed.data
    );
    if (facts === null) return staleState();
    return planAdministrativeRecoveryDeactivation(parsed.data, facts);
  });
}

export async function transitionAdministrativeRecoveryGrant(
  transaction: DatabaseTransaction,
  commandId: string
): Promise<AdministrativeRecoveryTransition> {
  if (!UUID_PATTERN.test(commandId)) return invalidCommand();
  const rows = await executeRows(transaction, sql`
    /* administrative-recovery:protected-transition */
    select recovery_grant_id as "recoveryGrantId",
      recovery_user_id as "recoveryUserId",
      recovery_title_id as "recoveryTitleId",
      previous_state as "previousState", next_state as "nextState",
      to_char(timezone('UTC', state_changed_at),
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "stateChangedAt"
    from transition_administrative_recovery_grant_after_admin_command(${commandId}::uuid)
  `);
  const transition = parseOne(transitionSchema, rows);
  canonicalTransitionTimestamp(transition.stateChangedAt);
  return transition;
}

export async function loadAdministrativeRecoveryNotification(
  transaction: DatabaseTransaction,
  transition: AdministrativeRecoveryTransition
): Promise<{ readonly to: string; readonly soldAsTitle: string }> {
  return parseOne(notificationSchema, await executeRows(transaction, sql`
    /* administrative-recovery:notification */
    select account.email as "to", item.title_snapshot as "soldAsTitle"
    from entitlement_grants recovery
    join "user" account on account.id = recovery.user_id
    join refund_allocations allocation
      on allocation.id = recovery.recovery_refund_allocation_id
    join refund_allocation_finalization_effects effect
      on effect.refund_allocation_id = allocation.id
     and effect.transition = 'revoked_by_finalization'
    join order_items item on item.id = effect.order_item_id
    where recovery.id = ${transition.recoveryGrantId}::uuid
      and recovery.user_id = ${transition.recoveryUserId}::uuid
      and recovery.title_id = ${transition.recoveryTitleId}::uuid
      and recovery.state = ${transition.nextState}
      and account.email_verified = true
  `));
}

export interface AdministrativeRecoveryExecutorDependencies {
  readonly transitionGrant?: typeof transitionAdministrativeRecoveryGrant;
  readonly projectEntitlement?: typeof projectEffectiveEntitlement;
  readonly loadNotification?: typeof loadAdministrativeRecoveryNotification;
}

function findDatabaseError(error: unknown): { code?: string; message?: string } | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') {
    return typeof candidate.message === 'string'
      ? { code: candidate.code, message: candidate.message }
      : { code: candidate.code };
  }
  return candidate.cause !== error ? findDatabaseError(candidate.cause) : null;
}

function mapProtectedRoutineError(error: unknown): never {
  const databaseError = findDatabaseError(error);
  if (databaseError?.code === '40001' && (
    databaseError.message === 'administrative recovery state is stale' ||
    databaseError.message === 'administrative recovery projection_incomplete'
  )) return staleState();
  if (databaseError?.code === '42501' && (
    databaseError.message === 'financial administrator capability is not current' ||
    databaseError.message === 'administrative recovery transition is not permitted'
  )) {
    throw new FinancialAdminDeniedError('capability_revoked');
  }
  if (databaseError?.code === '55000') {
    if (databaseError.message === 'administrative recovery is not eligible') {
      return notEligible();
    }
    if (databaseError.message === 'invalid administrative recovery command') {
      return invalidCommand();
    }
    if (databaseError.message === 'administrative recovery purchase graph is invalid') {
      return commandFailed();
    }
  }
  throw error;
}

function parseCommand<K extends FinancialAdminPrivateCommand['kind']>(
  value: unknown,
  kind: K
): Extract<FinancialAdminPrivateCommand, { kind: K }> {
  try {
    const parsed = parseFinancialAdminPrivateCommand(value);
    if (parsed.kind !== kind) return invalidCommand();
    return parsed as Extract<FinancialAdminPrivateCommand, { kind: K }>;
  } catch {
    return invalidCommand();
  }
}

async function executeTransition(
  context: FinancialAdminCommandExecutorContext,
  expectedState: 'active' | 'revoked',
  dependencies: Required<AdministrativeRecoveryExecutorDependencies>
): Promise<{ readonly recoveryGrantId: string; readonly accessChanged: boolean;
  readonly emailQueued: boolean }> {
  throwIfAborted(context.signal);
  let transition: AdministrativeRecoveryTransition;
  try {
    transition = await dependencies.transitionGrant(context.transaction, context.commandId);
  } catch (error) {
    return mapProtectedRoutineError(error);
  }
  if (transition.nextState !== expectedState ||
    (expectedState === 'active' && transition.previousState !== null &&
      transition.previousState !== 'revoked') ||
    (expectedState === 'revoked' && transition.previousState !== 'active')) {
    return commandFailed();
  }
  if (transition.previousState !== null) {
    assertGrantTransitionAllowed(
      { source: 'administrative', state: transition.previousState },
      transition.nextState,
      'administrative-recovery'
    );
  }
  const stateChangedAt = new Date(transition.stateChangedAt);
  const canonicalStateChangedAt = canonicalTransitionTimestamp(stateChangedAt);
  throwIfAborted(context.signal);
  const projected = await dependencies.projectEntitlement(
    context.transaction,
    transition.recoveryUserId,
    transition.recoveryTitleId,
    stateChangedAt
  );
  if (typeof projected.beforeActive !== 'boolean' ||
    typeof projected.afterActive !== 'boolean' ||
    (expectedState === 'active' && !projected.afterActive)) return commandFailed();
  const accessChanged = projected.beforeActive !== projected.afterActive;
  let emailQueued = false;
  if (accessChanged) {
    const notification = notificationSchema.safeParse(await dependencies.loadNotification(
      context.transaction, transition
    ));
    if (!notification.success) return commandFailed();
    await context.enqueueAccessChange({
      template: 'commerce.administrative-recovery-access-changed',
      eventId: context.commandId,
      to: notification.data.to,
      soldAsTitle: notification.data.soldAsTitle,
      accessState: expectedState,
      recoveryGrantId: transition.recoveryGrantId,
      stateChangedAt: canonicalStateChangedAt
    });
    emailQueued = true;
  }
  throwIfAborted(context.signal);
  return { recoveryGrantId: transition.recoveryGrantId, accessChanged, emailQueued };
}

export function createAdministrativeRecoveryExecutors(
  overrides: AdministrativeRecoveryExecutorDependencies = {}
) {
  const dependencies: Required<AdministrativeRecoveryExecutorDependencies> = {
    transitionGrant: overrides.transitionGrant ?? transitionAdministrativeRecoveryGrant,
    projectEntitlement: overrides.projectEntitlement ?? projectEffectiveEntitlement,
    loadNotification: overrides.loadNotification ?? loadAdministrativeRecoveryNotification
  };
  return {
    async executeActivate(
      context: FinancialAdminCommandExecutorContext,
      command: Extract<FinancialAdminPrivateCommand, {
        kind: 'administrative_recovery_activate'
      }>
    ): Promise<FinancialAdminCommandSafeResultByCode['recovery_activated']> {
      parseCommand(command, 'administrative_recovery_activate');
      return executeTransition(context, 'active', dependencies);
    },
    async executeDeactivate(
      context: FinancialAdminCommandExecutorContext,
      command: Extract<FinancialAdminPrivateCommand, {
        kind: 'administrative_recovery_deactivate'
      }>
    ): Promise<FinancialAdminCommandSafeResultByCode['recovery_deactivated']> {
      parseCommand(command, 'administrative_recovery_deactivate');
      return executeTransition(context, 'revoked', dependencies);
    }
  };
}

const defaultExecutors = createAdministrativeRecoveryExecutors();

export async function executeAdministrativeRecoveryActivate(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, {
    kind: 'administrative_recovery_activate'
  }>
): Promise<FinancialAdminCommandSafeResultByCode['recovery_activated']> {
  return defaultExecutors.executeActivate(context, command);
}

export async function executeAdministrativeRecoveryDeactivate(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, {
    kind: 'administrative_recovery_deactivate'
  }>
): Promise<FinancialAdminCommandSafeResultByCode['recovery_deactivated']> {
  return defaultExecutors.executeDeactivate(context, command);
}
