import { z } from 'zod';

export type TitleFormat = 'prose' | 'comic';
export type PublicFinancialState = 'pending' | 'fee_reconciled' | 'payout_reconciled' | 'exception';
export type SalesRange = '7' | '30' | '90' | 'all' | 'custom';
export type SalesSort = 'gross_desc' | 'title_asc';

export const SOLD_AS_TITLE_VARIANT_DTO_KEYS = ['title', 'creatorName', 'format'] as const;

export interface SoldAsTitleVariantDto {
  readonly title: string;
  readonly creatorName: string;
  readonly format: TitleFormat;
}

export const TITLE_SALES_ROW_DTO_KEYS = [
  'titleId',
  'currentTitle',
  'format',
  'archived',
  'soldAsVariants',
  'presentmentCurrency',
  'settlementCurrency',
  'soldCopies',
  'fullyRefundedCopies',
  'netCopies',
  'grossPresentmentMinor',
  'finalizedRefundPresentmentMinor',
  'disputeWithdrawalPresentmentMinor',
  'disputeReinstatementPresentmentMinor',
  'grossSettlementMinor',
  'refundImpactMinor',
  'disputeImpactMinor',
  'processingFeeImpactMinor',
  'refundFeeImpactMinor',
  'disputeFeeImpactMinor',
  'otherFeeImpactMinor',
  'estimatedPayoutMinor',
  'settlementMetricsComplete',
  'missingSourceCount',
  'state',
  'freshnessAt'
] as const;

interface CompleteSettlementMetricsDto {
  readonly grossSettlementMinor: number;
  readonly refundImpactMinor: number;
  readonly disputeImpactMinor: number;
  readonly processingFeeImpactMinor: number;
  readonly refundFeeImpactMinor: number;
  readonly disputeFeeImpactMinor: number;
  readonly otherFeeImpactMinor: number;
  readonly estimatedPayoutMinor: number;
  readonly settlementMetricsComplete: true;
  readonly missingSourceCount: 0;
  readonly state: 'fee_reconciled' | 'payout_reconciled';
}

interface IncompleteSettlementMetricsDto {
  readonly grossSettlementMinor: null;
  readonly refundImpactMinor: null;
  readonly disputeImpactMinor: null;
  readonly processingFeeImpactMinor: null;
  readonly refundFeeImpactMinor: null;
  readonly disputeFeeImpactMinor: null;
  readonly otherFeeImpactMinor: null;
  readonly estimatedPayoutMinor: null;
  readonly settlementMetricsComplete: false;
  readonly missingSourceCount: number;
  readonly state: 'pending' | 'exception';
}

interface TitleSalesRowBaseDto {
  readonly titleId: string;
  readonly currentTitle: string;
  readonly format: TitleFormat;
  readonly archived: boolean;
  readonly soldAsVariants: readonly SoldAsTitleVariantDto[];
  readonly presentmentCurrency: string;
  readonly soldCopies: number;
  readonly fullyRefundedCopies: number;
  readonly netCopies: number;
  readonly grossPresentmentMinor: number;
  readonly finalizedRefundPresentmentMinor: number;
  readonly disputeWithdrawalPresentmentMinor: number;
  readonly disputeReinstatementPresentmentMinor: number;
  readonly freshnessAt: string;
}

export type TitleSalesRowDto = TitleSalesRowBaseDto &
  (
    | ({ readonly settlementCurrency: string } & CompleteSettlementMetricsDto)
    | ({ readonly settlementCurrency: string | null } & IncompleteSettlementMetricsDto)
  );

export const SALES_CURRENCY_SUMMARY_DTO_KEYS = [
  'presentmentCurrency',
  'settlementCurrency',
  'titleCount',
  'soldCopies',
  'fullyRefundedCopies',
  'netCopies',
  'grossPresentmentMinor',
  'finalizedRefundPresentmentMinor',
  'disputeWithdrawalPresentmentMinor',
  'disputeReinstatementPresentmentMinor',
  'grossSettlementMinor',
  'refundImpactMinor',
  'disputeImpactMinor',
  'processingFeeImpactMinor',
  'refundFeeImpactMinor',
  'disputeFeeImpactMinor',
  'otherFeeImpactMinor',
  'estimatedPayoutMinor',
  'settlementMetricsComplete',
  'missingSourceCount',
  'state'
] as const;

interface SalesCurrencySummaryBaseDto {
  readonly presentmentCurrency: string;
  readonly titleCount: number;
  readonly soldCopies: number;
  readonly fullyRefundedCopies: number;
  readonly netCopies: number;
  readonly grossPresentmentMinor: number;
  readonly finalizedRefundPresentmentMinor: number;
  readonly disputeWithdrawalPresentmentMinor: number;
  readonly disputeReinstatementPresentmentMinor: number;
}

export type SalesCurrencySummaryDto = SalesCurrencySummaryBaseDto &
  (
    | ({ readonly settlementCurrency: string } & CompleteSettlementMetricsDto)
    | ({ readonly settlementCurrency: string | null } & IncompleteSettlementMetricsDto)
  );

export type FinancialIssueResourceType =
  | 'payment'
  | 'refund'
  | 'dispute'
  | 'payout'
  | 'payout_import_run'
  | 'balance_transaction'
  | 'fee_detail'
  | 'allocation_set'
  | 'correction_set'
  | 'financial_classification'
  | 'financial_scan_run';

export type FinancialIssueCode =
  | 'allocation_fork'
  | 'allocation_incomplete'
  | 'allocation_mismatch'
  | 'classification_fork'
  | 'correction_rebase_required'
  | 'currency_mismatch'
  | 'generation_exhausted'
  | 'immutable_mismatch'
  | 'missing_source'
  | 'payout_incomplete'
  | 'payout_membership_conflict'
  | 'payout_reversal_incomplete'
  | 'source_linkage_mismatch'
  | 'unsupported_category';

export const FINANCIAL_ISSUE_DTO_KEYS = [
  'issueId',
  'resourceType',
  'resourceId',
  'safeCode',
  'state',
  'impact',
  'actionability',
  'operationallyCurrent',
  'safeReason',
  'firstObservedAt',
  'lastObservedAt',
  'occurrenceCount',
  'refundId'
] as const;

export interface FinancialIssueDto {
  readonly issueId: string;
  readonly resourceType: FinancialIssueResourceType;
  readonly resourceId: string;
  readonly safeCode: FinancialIssueCode;
  readonly state: 'open' | 'resolved';
  readonly impact: 'pending' | 'exception' | 'informational';
  readonly actionability: 'refund_allocation_review' | 'wait_for_recovery' | 'read_only';
  readonly operationallyCurrent: boolean;
  readonly safeReason: string;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly occurrenceCount: number;
  readonly refundId: string | null;
}

export const REFUND_ITEM_DTO_KEYS = [
  'orderItemId',
  'titleId',
  'soldAsTitle',
  'soldAsCreatorName',
  'format',
  'paidSubtotalMinor',
  'paidTaxMinor',
  'paidTotalMinor',
  'currency',
  'finalizedRefundTotalMinor',
  'remainingRefundCapacityMinor'
] as const;

export interface RefundItemDto {
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly soldAsCreatorName: string;
  readonly format: TitleFormat;
  readonly paidSubtotalMinor: number;
  readonly paidTaxMinor: number;
  readonly paidTotalMinor: number;
  readonly currency: string;
  readonly finalizedRefundTotalMinor: number;
  readonly remainingRefundCapacityMinor: number;
}

export const REFUND_ALLOCATION_DTO_KEYS = [
  'orderItemId',
  'totalMinor',
  'subtotalMinor',
  'taxMinor',
  'remainingSubtotalCapacityMinor',
  'remainingTaxCapacityMinor',
  'source'
] as const;

export interface RefundAllocationDto {
  readonly orderItemId: string;
  readonly totalMinor: number;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly remainingSubtotalCapacityMinor: number;
  readonly remainingTaxCapacityMinor: number;
  readonly source: 'automatic' | 'administrative';
}

export const REFUND_DRAFT_ITEM_DTO_KEYS = ['orderItemId', 'proposedTotalMinor'] as const;

export interface RefundDraftItemDto {
  readonly orderItemId: string;
  readonly proposedTotalMinor: number;
}

export const REFUND_DRAFT_DTO_KEYS = [
  'draftId',
  'version',
  'state',
  'lastEditedBy',
  'updatedAt',
  'proposedTotalMinor',
  'remainderMinor',
  'items'
] as const;

export interface RefundDraftDto {
  readonly draftId: string;
  readonly version: number;
  readonly state: 'active' | 'finalized' | 'discarded';
  readonly lastEditedBy: 'current_administrator' | 'another_administrator';
  readonly updatedAt: string;
  readonly proposedTotalMinor: number;
  readonly remainderMinor: number;
  readonly items: readonly RefundDraftItemDto[];
}

export const REFUND_FINALIZATION_ITEM_PREVIEW_DTO_KEYS = [
  'orderItemId',
  'titleId',
  'soldAsTitle',
  'proposedTotalMinor',
  'proposedSubtotalMinor',
  'proposedTaxMinor',
  'wouldBeFullyRefunded',
  'purchaseGrantWouldBeRevoked',
  'otherActiveGrantPreservesAccess',
  'effectiveAccessWouldChange',
  'emailQueued'
] as const;

export interface RefundFinalizationItemPreviewDto {
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly proposedTotalMinor: number;
  readonly proposedSubtotalMinor: number;
  readonly proposedTaxMinor: number;
  readonly wouldBeFullyRefunded: boolean;
  readonly purchaseGrantWouldBeRevoked: boolean;
  readonly otherActiveGrantPreservesAccess: boolean;
  readonly effectiveAccessWouldChange: boolean;
  readonly emailQueued: boolean;
}

export const REFUND_FINALIZATION_PREVIEW_DTO_KEYS = [
  'refundId',
  'expectedActiveDraftVersion',
  'previewFingerprint',
  'currency',
  'proposedTotalMinor',
  'remainderMinor',
  'items'
] as const;

export interface RefundFinalizationPreviewDto {
  readonly refundId: string;
  readonly expectedActiveDraftVersion: number;
  readonly previewFingerprint: string;
  readonly currency: string;
  readonly proposedTotalMinor: number;
  readonly remainderMinor: number;
  readonly items: readonly RefundFinalizationItemPreviewDto[];
}

export const REFUND_REPORTING_CORRECTION_SEED_ITEM_DTO_KEYS = [
  'orderItemId',
  'titleId',
  'soldAsTitle',
  'baselineTotalMinor',
  'baselineSubtotalMinor',
  'baselineTaxMinor',
  'baselineSettlementGrossMinor',
  'baselineRefundFeeImpactMinor'
] as const;

export interface RefundReportingCorrectionSeedItemDto {
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly baselineTotalMinor: number;
  readonly baselineSubtotalMinor: number;
  readonly baselineTaxMinor: number;
  readonly baselineSettlementGrossMinor: number | null;
  readonly baselineRefundFeeImpactMinor: number | null;
}

export const REFUND_REPORTING_CORRECTION_SEED_DTO_KEYS = [
  'refundId',
  'reason',
  'expectedNextCorrectionVersion',
  'expectedBaseAllocationSetId',
  'expectedSourceFingerprint',
  'rawPredecessorCorrectionSetId',
  'compatibleCorrectionSetId',
  'baselineKind',
  'currentReportingComplete',
  'currency',
  'settlementCurrency',
  'baselineTotalMinor',
  'eligible',
  'ineligibleReason',
  'items'
] as const;

export interface RefundReportingCorrectionSeedDto {
  readonly refundId: string;
  readonly reason: 'allocation_attribution_correction';
  readonly expectedNextCorrectionVersion: number | null;
  readonly expectedBaseAllocationSetId: string | null;
  readonly expectedSourceFingerprint: string | null;
  readonly rawPredecessorCorrectionSetId: string | null;
  readonly compatibleCorrectionSetId: string | null;
  readonly baselineKind: 'immutable_base' | 'compatible_correction' | null;
  readonly currentReportingComplete: boolean;
  readonly currency: string | null;
  readonly settlementCurrency: string | null;
  readonly baselineTotalMinor: number | null;
  readonly eligible: boolean;
  readonly ineligibleReason:
    | 'provider_evidence_pending'
    | 'immutable_conflict'
    | 'not_finalized'
    | null;
  readonly items: readonly RefundReportingCorrectionSeedItemDto[];
}

export const REFUND_CORRECTION_ITEM_PREVIEW_DTO_KEYS = [
  'orderItemId',
  'titleId',
  'soldAsTitle',
  'baselineTotalMinor',
  'baselineSubtotalMinor',
  'baselineTaxMinor',
  'proposedTotalMinor',
  'proposedSubtotalMinor',
  'proposedTaxMinor',
  'subtotalDisplayDeltaMinor',
  'taxDisplayDeltaMinor',
  'baselineSettlementGrossMinor',
  'proposedSettlementGrossMinor',
  'settlementGrossDisplayDeltaMinor',
  'baselineRefundFeeImpactMinor',
  'proposedRefundFeeImpactMinor',
  'refundFeeImpactDisplayDeltaMinor'
] as const;

export interface RefundCorrectionItemPreviewDto {
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly baselineTotalMinor: number;
  readonly baselineSubtotalMinor: number;
  readonly baselineTaxMinor: number;
  readonly proposedTotalMinor: number;
  readonly proposedSubtotalMinor: number;
  readonly proposedTaxMinor: number;
  readonly subtotalDisplayDeltaMinor: number;
  readonly taxDisplayDeltaMinor: number;
  readonly baselineSettlementGrossMinor: number | null;
  readonly proposedSettlementGrossMinor: number | null;
  readonly settlementGrossDisplayDeltaMinor: number | null;
  readonly baselineRefundFeeImpactMinor: number | null;
  readonly proposedRefundFeeImpactMinor: number | null;
  readonly refundFeeImpactDisplayDeltaMinor: number | null;
}

export const REFUND_REPORTING_CORRECTION_PREVIEW_DTO_KEYS = [
  'refundId',
  'expectedBaseAllocationSetId',
  'rawPredecessorCorrectionSetId',
  'compatibleCorrectionSetId',
  'expectedNextCorrectionVersion',
  'expectedSourceFingerprint',
  'previewFingerprint',
  'baselineKind',
  'currentReportingComplete',
  'proposedReportingComplete',
  'compatibilityRepair',
  'currency',
  'settlementCurrency',
  'baselineTotalMinor',
  'proposedTotalMinor',
  'eligible',
  'ineligibleReason',
  'items'
] as const;

export interface RefundReportingCorrectionPreviewDto {
  readonly refundId: string;
  readonly expectedBaseAllocationSetId: string;
  readonly rawPredecessorCorrectionSetId: string | null;
  readonly compatibleCorrectionSetId: string | null;
  readonly expectedNextCorrectionVersion: number;
  readonly expectedSourceFingerprint: string;
  readonly previewFingerprint: string | null;
  readonly baselineKind: 'immutable_base' | 'compatible_correction';
  readonly currentReportingComplete: boolean;
  readonly proposedReportingComplete: boolean;
  readonly compatibilityRepair: boolean;
  readonly currency: string;
  readonly settlementCurrency: string | null;
  readonly baselineTotalMinor: number;
  readonly proposedTotalMinor: number;
  readonly eligible: boolean;
  readonly ineligibleReason:
    | 'provider_evidence_pending'
    | 'immutable_conflict'
    | 'not_finalized'
    | 'no_change'
    | null;
  readonly items: readonly RefundCorrectionItemPreviewDto[];
}

export const ADMINISTRATIVE_RECOVERY_PREVIEW_DTO_KEYS = [
  'refundId',
  'orderItemId',
  'titleId',
  'soldAsTitle',
  'recoveryGrantId',
  'eligible',
  'ineligibleReason',
  'effectiveAccessBefore',
  'effectiveAccessAfter',
  'accessChanged',
  'emailQueued',
  'persistsUntilDeactivated'
] as const;

export interface AdministrativeRecoveryPreviewDto {
  readonly refundId: string;
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly recoveryGrantId: string | null;
  readonly eligible: boolean;
  readonly ineligibleReason:
    | 'not_causally_revoked'
    | 'still_fully_refunded'
    | 'unclaimed_purchase'
    | 'already_in_requested_state'
    | 'correction_rebase_required'
    | null;
  readonly effectiveAccessBefore: boolean;
  readonly effectiveAccessAfter: boolean;
  readonly accessChanged: boolean;
  readonly emailQueued: boolean;
  readonly persistsUntilDeactivated: true;
}

export const REFUND_DETAIL_DTO_KEYS = [
  'refundId',
  'orderId',
  'status',
  'allocationStatus',
  'financialState',
  'amountMinor',
  'currency',
  'orderSubtotalMinor',
  'orderTaxMinor',
  'orderTotalMinor',
  'items',
  'finalizedAllocations',
  'draft',
  'finalizationPreview',
  'correctionPreview',
  'recoveryPreviews',
  'openIssueCount',
  'dataThroughAt',
  'createdAt',
  'updatedAt'
] as const;

export interface RefundDetailDto {
  readonly refundId: string;
  readonly orderId: string;
  readonly status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  readonly allocationStatus: 'not_applicable' | 'needs_review' | 'draft' | 'finalized' | 'exception';
  readonly financialState: PublicFinancialState;
  readonly amountMinor: number;
  readonly currency: string;
  readonly orderSubtotalMinor: number;
  readonly orderTaxMinor: number;
  readonly orderTotalMinor: number;
  readonly items: readonly RefundItemDto[];
  readonly finalizedAllocations: readonly RefundAllocationDto[];
  readonly draft: RefundDraftDto | null;
  readonly finalizationPreview: RefundFinalizationPreviewDto | null;
  readonly correctionPreview: RefundReportingCorrectionPreviewDto | null;
  readonly recoveryPreviews: readonly AdministrativeRecoveryPreviewDto[];
  readonly openIssueCount: number;
  readonly dataThroughAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PayoutMethod = 'standard' | 'instant' | 'unknown';
export type PayoutStatus = 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';
export type PayoutReconciliationStatus = 'completed' | 'in_progress' | 'not_applicable';

export const PAYOUT_SUMMARY_DTO_KEYS = [
  'payoutId',
  'automatic',
  'method',
  'status',
  'reconciliationStatus',
  'settlementCurrency',
  'amountMinor',
  'createdAt',
  'arrivalAt',
  'associatedTransactionCount',
  'bookstoreLinkedTransactionCount',
  'membershipComplete',
  'bookstoreLinkedSubtotalMinor',
  'accountLevelAdjustmentCount',
  'accountLevelAdjustmentMinor',
  'safeFailureCode',
  'financialGeneration',
  'membershipGeneration',
  'historicalMembershipRetained',
  'reversalState',
  'openIssueCount',
  'freshnessAt'
] as const;

interface PayoutSummaryBaseDto {
  readonly payoutId: string;
  readonly automatic: boolean;
  readonly method: PayoutMethod;
  readonly status: PayoutStatus;
  readonly reconciliationStatus: PayoutReconciliationStatus;
  readonly settlementCurrency: string;
  readonly amountMinor: number;
  readonly createdAt: string;
  readonly arrivalAt: string;
  readonly safeFailureCode: string | null;
  readonly financialGeneration: number;
  readonly reversalState: 'none' | 'reversed' | 'incomplete';
  readonly openIssueCount: number;
  readonly freshnessAt: string;
}

interface AvailablePayoutMembershipDto {
  readonly associatedTransactionCount: number;
  readonly bookstoreLinkedTransactionCount: number;
  readonly bookstoreLinkedSubtotalMinor: number;
  readonly accountLevelAdjustmentCount: number;
  readonly accountLevelAdjustmentMinor: number;
  readonly membershipGeneration: number;
}

type CurrentPayoutMembershipDto = AvailablePayoutMembershipDto & {
  readonly membershipComplete: true;
  readonly historicalMembershipRetained: false;
};

type HistoricalPayoutMembershipDto = AvailablePayoutMembershipDto & {
  readonly membershipComplete: false;
  readonly historicalMembershipRetained: true;
};

interface UnavailablePayoutMembershipDto {
  readonly associatedTransactionCount: null;
  readonly bookstoreLinkedTransactionCount: null;
  readonly bookstoreLinkedSubtotalMinor: null;
  readonly accountLevelAdjustmentCount: null;
  readonly accountLevelAdjustmentMinor: null;
  readonly membershipComplete: false;
  readonly membershipGeneration: null;
  readonly historicalMembershipRetained: false;
}

type PayoutMembershipDto =
  | CurrentPayoutMembershipDto
  | HistoricalPayoutMembershipDto
  | UnavailablePayoutMembershipDto;

export type PayoutSummaryDto = PayoutSummaryBaseDto & PayoutMembershipDto;

export const PAYOUT_DETAIL_DTO_KEYS = [
  ...PAYOUT_SUMMARY_DTO_KEYS,
  'bookstoreLinkedFeeImpactMinor',
  'bookstoreLinkedNetMinor',
  'reversalAmountMinor'
] as const;

interface AvailablePayoutDetailAmountsDto {
  readonly bookstoreLinkedFeeImpactMinor: number;
  readonly bookstoreLinkedNetMinor: number;
  readonly reversalAmountMinor: number | null;
}

interface UnavailablePayoutDetailAmountsDto {
  readonly bookstoreLinkedFeeImpactMinor: null;
  readonly bookstoreLinkedNetMinor: null;
  readonly reversalAmountMinor: number | null;
}

export type PayoutDetailDto =
  | (PayoutSummaryBaseDto & CurrentPayoutMembershipDto & AvailablePayoutDetailAmountsDto)
  | (PayoutSummaryBaseDto & HistoricalPayoutMembershipDto & AvailablePayoutDetailAmountsDto)
  | (PayoutSummaryBaseDto & UnavailablePayoutMembershipDto & UnavailablePayoutDetailAmountsDto);

export const SALES_CSV_ROW_DTO_KEYS = [
  'currentTitle',
  'titleId',
  'format',
  'archived',
  'presentmentCurrency',
  'settlementCurrency',
  'soldCopies',
  'fullyRefundedCopies',
  'netCopies',
  'grossPresentmentMinor',
  'finalizedRefundPresentmentMinor',
  'disputeWithdrawalPresentmentMinor',
  'disputeReinstatementPresentmentMinor',
  'grossSettlementMinor',
  'refundImpactMinor',
  'disputeImpactMinor',
  'processingFeeImpactMinor',
  'refundFeeImpactMinor',
  'disputeFeeImpactMinor',
  'otherFeeImpactMinor',
  'estimatedPayoutMinor',
  'settlementMetricsComplete',
  'missingSourceCount',
  'state',
  'range',
  'dataThroughAt',
  'soldAsVariantsJson'
] as const;

interface SalesCsvRowBaseDto {
  readonly currentTitle: string;
  readonly titleId: string;
  readonly format: TitleFormat;
  readonly archived: boolean;
  readonly presentmentCurrency: string;
  readonly soldCopies: number;
  readonly fullyRefundedCopies: number;
  readonly netCopies: number;
  readonly grossPresentmentMinor: number;
  readonly finalizedRefundPresentmentMinor: number;
  readonly disputeWithdrawalPresentmentMinor: number;
  readonly disputeReinstatementPresentmentMinor: number;
  readonly range: SalesRange;
  readonly dataThroughAt: string | null;
  readonly soldAsVariantsJson: string;
}

export type SalesCsvRowDto = SalesCsvRowBaseDto &
  (
    | ({ readonly settlementCurrency: string } & CompleteSettlementMetricsDto)
    | ({ readonly settlementCurrency: string } & IncompleteSettlementMetricsDto)
  );

export const FINANCIAL_REPORTING_DTO_KEYSETS = {
  soldAsTitleVariant: SOLD_AS_TITLE_VARIANT_DTO_KEYS,
  titleSalesRow: TITLE_SALES_ROW_DTO_KEYS,
  salesCurrencySummary: SALES_CURRENCY_SUMMARY_DTO_KEYS,
  financialIssue: FINANCIAL_ISSUE_DTO_KEYS,
  refundItem: REFUND_ITEM_DTO_KEYS,
  refundAllocation: REFUND_ALLOCATION_DTO_KEYS,
  refundDraftItem: REFUND_DRAFT_ITEM_DTO_KEYS,
  refundDraft: REFUND_DRAFT_DTO_KEYS,
  refundFinalizationItemPreview: REFUND_FINALIZATION_ITEM_PREVIEW_DTO_KEYS,
  refundFinalizationPreview: REFUND_FINALIZATION_PREVIEW_DTO_KEYS,
  refundReportingCorrectionSeedItem: REFUND_REPORTING_CORRECTION_SEED_ITEM_DTO_KEYS,
  refundReportingCorrectionSeed: REFUND_REPORTING_CORRECTION_SEED_DTO_KEYS,
  refundCorrectionItemPreview: REFUND_CORRECTION_ITEM_PREVIEW_DTO_KEYS,
  refundReportingCorrectionPreview: REFUND_REPORTING_CORRECTION_PREVIEW_DTO_KEYS,
  administrativeRecoveryPreview: ADMINISTRATIVE_RECOVERY_PREVIEW_DTO_KEYS,
  refundDetail: REFUND_DETAIL_DTO_KEYS,
  payoutSummary: PAYOUT_SUMMARY_DTO_KEYS,
  payoutDetail: PAYOUT_DETAIL_DTO_KEYS,
  salesCsvRow: SALES_CSV_ROW_DTO_KEYS
} as const;

export const FINANCIAL_ADMIN_COMMAND_KINDS = [
  'refund_draft_save',
  'refund_draft_discard',
  'refund_allocation_finalize',
  'refund_reporting_correction_create',
  'administrative_recovery_activate',
  'administrative_recovery_deactivate'
] as const;

export type FinancialAdminCommandKind = (typeof FINANCIAL_ADMIN_COMMAND_KINDS)[number];

export const FINANCIAL_ADMIN_COMMAND_STATUSES = [
  'pending',
  'succeeded',
  'denied',
  'conflict',
  'failed'
] as const;

export type FinancialAdminCommandStatus = (typeof FINANCIAL_ADMIN_COMMAND_STATUSES)[number];

export const RESULT_CODES = [
  'draft_saved',
  'draft_discarded',
  'allocation_finalized',
  'correction_created',
  'recovery_activated',
  'recovery_deactivated',
  'capability_revoked',
  'not_eligible',
  'stale_state',
  'invalid_command',
  'command_failed'
] as const;

export type FinancialAdminCommandResultCode = (typeof RESULT_CODES)[number];

export interface FinancialAdminCommandSafeResultByCode {
  readonly draft_saved: {
    readonly refundId: string;
    readonly draftVersion: number;
    readonly changed: boolean;
  };
  readonly draft_discarded: {
    readonly refundId: string;
    readonly draftVersion: number;
    readonly changed: boolean;
  };
  readonly allocation_finalized: {
    readonly refundId: string;
    readonly finalizedDraftVersion: number;
    readonly accessChanged: boolean;
    readonly emailQueued: boolean;
  };
  readonly correction_created: {
    readonly refundId: string;
    readonly correctionSetId: string;
    readonly correctionVersion: number;
  };
  readonly recovery_activated: {
    readonly recoveryGrantId: string;
    readonly accessChanged: boolean;
    readonly emailQueued: boolean;
  };
  readonly recovery_deactivated: {
    readonly recoveryGrantId: string;
    readonly accessChanged: boolean;
    readonly emailQueued: boolean;
  };
  readonly capability_revoked: null;
  readonly not_eligible: null;
  readonly stale_state: null;
  readonly invalid_command: null;
  readonly command_failed: null;
}

export type FinancialAdminCommandSafeResultDto = Exclude<
  FinancialAdminCommandSafeResultByCode[FinancialAdminCommandResultCode],
  null
>;

export interface FinancialAdminSuccessCodeByKind {
  readonly refund_draft_save: 'draft_saved';
  readonly refund_draft_discard: 'draft_discarded';
  readonly refund_allocation_finalize: 'allocation_finalized';
  readonly refund_reporting_correction_create: 'correction_created';
  readonly administrative_recovery_activate: 'recovery_activated';
  readonly administrative_recovery_deactivate: 'recovery_deactivated';
}

export const FINANCIAL_ADMIN_SUCCESS_CODE_BY_KIND = {
  refund_draft_save: 'draft_saved',
  refund_draft_discard: 'draft_discarded',
  refund_allocation_finalize: 'allocation_finalized',
  refund_reporting_correction_create: 'correction_created',
  administrative_recovery_activate: 'recovery_activated',
  administrative_recovery_deactivate: 'recovery_deactivated'
} as const satisfies FinancialAdminSuccessCodeByKind;

export const REFERENCE_DTO_KEYS = ['commandId', 'kind', 'status', 'createdAt'] as const;

export interface FinancialAdminCommandReferenceDto {
  readonly commandId: string;
  readonly kind: FinancialAdminCommandKind;
  readonly status: FinancialAdminCommandStatus;
  readonly createdAt: string;
}

interface StatusBase {
  readonly commandId: string;
  readonly kind: FinancialAdminCommandKind;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type SuccessCodeFor<K extends FinancialAdminCommandKind> =
  FinancialAdminSuccessCodeByKind[K] & FinancialAdminCommandResultCode;

type DeniedResultCode = Extract<
  FinancialAdminCommandResultCode,
  'capability_revoked'
>;
type ConflictResultCode = Extract<
  FinancialAdminCommandResultCode,
  'stale_state' | 'not_eligible'
>;
type FailedResultCode = Extract<
  FinancialAdminCommandResultCode,
  'invalid_command' | 'command_failed'
>;

type SucceededStatusDto = {
  [K in FinancialAdminCommandKind]: StatusBase & {
    readonly kind: K;
    readonly status: 'succeeded';
    readonly resultCode: SuccessCodeFor<K>;
    readonly result: Exclude<
      FinancialAdminCommandSafeResultByCode[SuccessCodeFor<K>],
      null
    >;
    readonly completedAt: string;
  };
}[FinancialAdminCommandKind];

export type FinancialAdminCommandStatusDto =
  | (StatusBase & {
      readonly status: 'pending';
      readonly resultCode: null;
      readonly result: null;
      readonly completedAt: null;
    })
  | SucceededStatusDto
  | (StatusBase & {
      readonly status: 'denied';
      readonly resultCode: DeniedResultCode;
      readonly result: null;
      readonly completedAt: string;
    })
  | (StatusBase & {
      readonly status: 'conflict';
      readonly resultCode: ConflictResultCode;
      readonly result: null;
      readonly completedAt: string;
    })
  | (StatusBase & {
      readonly status: 'failed';
      readonly resultCode: FailedResultCode;
      readonly result: null;
      readonly completedAt: string;
    });

export const STATUS_DTO_KEYS = [
  'commandId',
  'createdAt',
  'updatedAt',
  'kind',
  'status',
  'resultCode',
  'result',
  'completedAt'
] as const;

const canonicalUuidSchema = z.uuid().refine((value) => value === value.toLowerCase());
const timestampSchema = z.string().regex(/Z$/u).pipe(z.iso.datetime());
const versionSchema = z.number().int().min(1).max(2_147_483_647);
const commandKindSchema = z.enum(FINANCIAL_ADMIN_COMMAND_KINDS);

const draftResultSchema = z.strictObject({
  refundId: canonicalUuidSchema,
  draftVersion: versionSchema,
  changed: z.boolean()
});
const finalizationResultSchema = z.strictObject({
  refundId: canonicalUuidSchema,
  finalizedDraftVersion: versionSchema,
  accessChanged: z.boolean(),
  emailQueued: z.boolean()
});
const correctionResultSchema = z.strictObject({
  refundId: canonicalUuidSchema,
  correctionSetId: canonicalUuidSchema,
  correctionVersion: versionSchema
});
const recoveryResultSchema = z.strictObject({
  recoveryGrantId: canonicalUuidSchema,
  accessChanged: z.boolean(),
  emailQueued: z.boolean()
});

const statusBaseShape = {
  commandId: canonicalUuidSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
} as const;

const pendingStatusSchema = z.strictObject({
  ...statusBaseShape,
  kind: commandKindSchema,
  status: z.literal('pending'),
  resultCode: z.null(),
  result: z.null(),
  completedAt: z.null()
});

const succeededStatusSchema = z.union([
  z.strictObject({
    ...statusBaseShape,
    kind: z.literal('refund_draft_save'),
    status: z.literal('succeeded'),
    resultCode: z.literal('draft_saved'),
    result: draftResultSchema,
    completedAt: timestampSchema
  }),
  z.strictObject({
    ...statusBaseShape,
    kind: z.literal('refund_draft_discard'),
    status: z.literal('succeeded'),
    resultCode: z.literal('draft_discarded'),
    result: draftResultSchema,
    completedAt: timestampSchema
  }),
  z.strictObject({
    ...statusBaseShape,
    kind: z.literal('refund_allocation_finalize'),
    status: z.literal('succeeded'),
    resultCode: z.literal('allocation_finalized'),
    result: finalizationResultSchema,
    completedAt: timestampSchema
  }),
  z.strictObject({
    ...statusBaseShape,
    kind: z.literal('refund_reporting_correction_create'),
    status: z.literal('succeeded'),
    resultCode: z.literal('correction_created'),
    result: correctionResultSchema,
    completedAt: timestampSchema
  }),
  z.strictObject({
    ...statusBaseShape,
    kind: z.literal('administrative_recovery_activate'),
    status: z.literal('succeeded'),
    resultCode: z.literal('recovery_activated'),
    result: recoveryResultSchema,
    completedAt: timestampSchema
  }),
  z.strictObject({
    ...statusBaseShape,
    kind: z.literal('administrative_recovery_deactivate'),
    status: z.literal('succeeded'),
    resultCode: z.literal('recovery_deactivated'),
    result: recoveryResultSchema,
    completedAt: timestampSchema
  })
]);

const deniedStatusSchema = z.strictObject({
  ...statusBaseShape,
  kind: commandKindSchema,
  status: z.literal('denied'),
  resultCode: z.literal('capability_revoked'),
  result: z.null(),
  completedAt: timestampSchema
});

const conflictStatusSchema = z.strictObject({
  ...statusBaseShape,
  kind: commandKindSchema,
  status: z.literal('conflict'),
  resultCode: z.enum(['stale_state', 'not_eligible']),
  result: z.null(),
  completedAt: timestampSchema
});

const failedStatusSchema = z.strictObject({
  ...statusBaseShape,
  kind: commandKindSchema,
  status: z.literal('failed'),
  resultCode: z.enum(['invalid_command', 'command_failed']),
  result: z.null(),
  completedAt: timestampSchema
});

const financialAdminCommandStatusSchema = z.union([
  pendingStatusSchema,
  succeededStatusSchema,
  deniedStatusSchema,
  conflictStatusSchema,
  failedStatusSchema
]);

export function parseFinancialAdminCommandStatus(
  value: unknown
): FinancialAdminCommandStatusDto {
  return financialAdminCommandStatusSchema.parse(value) as FinancialAdminCommandStatusDto;
}
