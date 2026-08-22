import { randomUUID } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ADMINISTRATIVE_RECOVERY_ACTIVATION_CANDIDATE_DTO_KEYS,
  ADMINISTRATIVE_RECOVERY_DEACTIVATION_CANDIDATE_DTO_KEYS,
  ADMINISTRATIVE_RECOVERY_DEACTIVATION_PREVIEW_DTO_KEYS,
  ADMINISTRATIVE_RECOVERY_PREVIEW_DTO_KEYS,
  ADMINISTRATIVE_RECOVERY_SEED_DTO_KEYS,
  FINANCIAL_ADMIN_COMMAND_KINDS,
  FINANCIAL_ADMIN_COMMAND_STATUSES,
  FINANCIAL_ADMIN_SUCCESS_CODE_BY_KIND,
  FINANCIAL_ISSUE_DTO_KEYS,
  FINANCIAL_REPORTING_DTO_KEYSETS,
  PAYOUT_DETAIL_DTO_KEYS,
  PAYOUT_SUMMARY_DTO_KEYS,
  REFERENCE_DTO_KEYS,
  REFUND_ALLOCATION_DTO_KEYS,
  REFUND_CORRECTION_ITEM_PREVIEW_DTO_KEYS,
  REFUND_DETAIL_DTO_KEYS,
  REFUND_DRAFT_DTO_KEYS,
  REFUND_DRAFT_ITEM_DTO_KEYS,
  REFUND_FINALIZATION_ITEM_PREVIEW_DTO_KEYS,
  REFUND_FINALIZATION_PREVIEW_DTO_KEYS,
  REFUND_ITEM_DTO_KEYS,
  REFUND_REPORTING_CORRECTION_SEED_DTO_KEYS,
  REFUND_REPORTING_CORRECTION_SEED_ITEM_DTO_KEYS,
  REFUND_REPORTING_CORRECTION_PREVIEW_DTO_KEYS,
  RESULT_CODES,
  SALES_CSV_ROW_DTO_KEYS,
  SALES_CURRENCY_SUMMARY_DTO_KEYS,
  STATUS_DTO_KEYS,
  TITLE_SALES_ROW_DTO_KEYS,
  parseFinancialAdminCommandStatus,
  type AdministrativeRecoveryActivationCandidateDto,
  type AdministrativeRecoveryDeactivationCandidateDto,
  type AdministrativeRecoveryDeactivationPreviewDto,
  type AdministrativeRecoveryPreviewDto,
  type AdministrativeRecoverySeedDto,
  type FinancialAdminCommandReferenceDto,
  type FinancialAdminCommandResultCode,
  type FinancialAdminCommandSafeResultByCode,
  type FinancialAdminCommandSafeResultDto,
  type FinancialAdminCommandStatusDto,
  type FinancialAdminSuccessCodeByKind,
  type FinancialIssueDto,
  type PayoutDetailDto,
  type PayoutSummaryDto,
  type RefundAllocationDto,
  type RefundCorrectionItemPreviewDto,
  type RefundDetailDto,
  type RefundDraftDto,
  type RefundDraftItemDto,
  type RefundFinalizationItemPreviewDto,
  type RefundFinalizationPreviewDto,
  type RefundItemDto,
  type RefundReportingCorrectionSeedDto,
  type RefundReportingCorrectionSeedItemDto,
  type RefundReportingCorrectionPreviewDto,
  type SalesCsvRowDto,
  type SalesCurrencySummaryDto,
  type SoldAsTitleVariantDto,
  type TitleSalesRowDto
} from './financial-reporting';

const id = () => randomUUID();
const occurredAt = '2026-08-20T12:00:00.000Z';

function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value)).toEqual(keys);
}

const EXPECTED_FINANCIAL_REPORTING_DTO_KEYSETS = {
  soldAsTitleVariant: ['title', 'creatorName', 'format'],
  titleSalesRow: [
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
  ],
  salesCurrencySummary: [
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
  ],
  financialIssue: [
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
  ],
  refundItem: [
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
  ],
  refundAllocation: [
    'orderItemId',
    'totalMinor',
    'subtotalMinor',
    'taxMinor',
    'remainingSubtotalCapacityMinor',
    'remainingTaxCapacityMinor',
    'source'
  ],
  refundDraftItem: ['orderItemId', 'proposedTotalMinor'],
  refundDraft: [
    'draftId',
    'version',
    'state',
    'lastEditedBy',
    'updatedAt',
    'proposedTotalMinor',
    'remainderMinor',
    'items'
  ],
  refundFinalizationItemPreview: [
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
  ],
  refundFinalizationPreview: [
    'refundId',
    'expectedActiveDraftVersion',
    'previewFingerprint',
    'currency',
    'proposedTotalMinor',
    'remainderMinor',
    'items'
  ],
  refundReportingCorrectionSeedItem: [
    'orderItemId',
    'titleId',
    'soldAsTitle',
    'baselineTotalMinor',
    'baselineSubtotalMinor',
    'baselineTaxMinor',
    'baselineSettlementGrossMinor',
    'baselineRefundFeeImpactMinor'
  ],
  refundReportingCorrectionSeed: [
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
  ],
  refundCorrectionItemPreview: [
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
  ],
  refundReportingCorrectionPreview: [
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
  ],
  administrativeRecoveryActivationCandidate: [
    'finalizationEffectId',
    'orderItemId',
    'titleId',
    'soldAsTitle',
    'expectedCorrectionSetId',
    'expectedCorrectionVersion',
    'expectedSourceFingerprint'
  ],
  administrativeRecoveryDeactivationCandidate: [
    'recoveryGrantId',
    'recoveryReferenceId',
    'expectedStateChangedAt',
    'orderItemId',
    'titleId',
    'soldAsTitle'
  ],
  administrativeRecoverySeed: [
    'refundId',
    'activationCandidates',
    'deactivationCandidates'
  ],
  administrativeRecoveryPreview: [
    'refundId',
    'finalizationEffectId',
    'orderItemId',
    'titleId',
    'soldAsTitle',
    'expectedCorrectionSetId',
    'expectedCorrectionVersion',
    'expectedSourceFingerprint',
    'previewFingerprint',
    'recoveryGrantId',
    'eligible',
    'ineligibleReason',
    'effectiveAccessBefore',
    'effectiveAccessAfter',
    'accessChanged',
    'emailQueued',
    'persistsUntilDeactivated'
  ],
  administrativeRecoveryDeactivationPreview: [
    'refundId',
    'recoveryGrantId',
    'recoveryReferenceId',
    'expectedStateChangedAt',
    'orderItemId',
    'titleId',
    'soldAsTitle',
    'eligible',
    'ineligibleReason',
    'effectiveAccessBefore',
    'effectiveAccessAfter',
    'accessChanged',
    'emailQueued'
  ],
  refundDetail: [
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
  ],
  payoutSummary: [
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
  ],
  payoutDetail: [
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
    'freshnessAt',
    'bookstoreLinkedFeeImpactMinor',
    'bookstoreLinkedNetMinor',
    'reversalAmountMinor'
  ],
  salesCsvRow: [
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
  ]
} as const;

describe('browser-safe financial reporting DTOs', () => {
  const soldAsVariant: SoldAsTitleVariantDto = {
    title: 'Pale Orbit',
    creatorName: 'A. Writer',
    format: 'prose'
  };
  const refundItem: RefundItemDto = {
    orderItemId: id(),
    titleId: id(),
    soldAsTitle: 'Pale Orbit',
    soldAsCreatorName: 'A. Writer',
    format: 'prose',
    paidSubtotalMinor: 1_200,
    paidTaxMinor: 96,
    paidTotalMinor: 1_296,
    currency: 'USD',
    finalizedRefundTotalMinor: 500,
    remainingRefundCapacityMinor: 796
  };
  const draftItem: RefundDraftItemDto = {
    orderItemId: refundItem.orderItemId,
    proposedTotalMinor: 600
  };
  const finalizedAllocation: RefundAllocationDto = {
    orderItemId: refundItem.orderItemId,
    totalMinor: 500,
    subtotalMinor: 463,
    taxMinor: 37,
    remainingSubtotalCapacityMinor: 737,
    remainingTaxCapacityMinor: 59,
    source: 'administrative'
  };
  const draft: RefundDraftDto = {
    draftId: id(),
    version: 3,
    state: 'active',
    lastEditedBy: 'another_administrator',
    updatedAt: occurredAt,
    proposedTotalMinor: 600,
    remainderMinor: 0,
    items: [draftItem]
  };
  const finalizationItem: RefundFinalizationItemPreviewDto = {
    orderItemId: refundItem.orderItemId,
    titleId: refundItem.titleId,
    soldAsTitle: refundItem.soldAsTitle,
    proposedTotalMinor: 600,
    proposedSubtotalMinor: 556,
    proposedTaxMinor: 44,
    wouldBeFullyRefunded: false,
    purchaseGrantWouldBeRevoked: true,
    otherActiveGrantPreservesAccess: false,
    effectiveAccessWouldChange: true,
    emailQueued: true
  };
  const finalization: RefundFinalizationPreviewDto = {
    refundId: id(),
    expectedActiveDraftVersion: 3,
    previewFingerprint: 'a'.repeat(64),
    currency: 'USD',
    proposedTotalMinor: 600,
    remainderMinor: 0,
    items: [finalizationItem]
  };
  const correctionItem: RefundCorrectionItemPreviewDto = {
    orderItemId: refundItem.orderItemId,
    titleId: refundItem.titleId,
    soldAsTitle: refundItem.soldAsTitle,
    baselineTotalMinor: 600,
    baselineSubtotalMinor: 556,
    baselineTaxMinor: 44,
    proposedTotalMinor: 500,
    proposedSubtotalMinor: 463,
    proposedTaxMinor: 37,
    subtotalDisplayDeltaMinor: -93,
    taxDisplayDeltaMinor: -7,
    baselineSettlementGrossMinor: -486,
    proposedSettlementGrossMinor: -405,
    settlementGrossDisplayDeltaMinor: 81,
    baselineRefundFeeImpactMinor: -18,
    proposedRefundFeeImpactMinor: -15,
    refundFeeImpactDisplayDeltaMinor: 3
  };
  const correctionSeedItem: RefundReportingCorrectionSeedItemDto = {
    orderItemId: refundItem.orderItemId,
    titleId: refundItem.titleId,
    soldAsTitle: refundItem.soldAsTitle,
    baselineTotalMinor: 600,
    baselineSubtotalMinor: 556,
    baselineTaxMinor: 44,
    baselineSettlementGrossMinor: -486,
    baselineRefundFeeImpactMinor: -18
  };
  const correctionSeed: RefundReportingCorrectionSeedDto = {
    refundId: finalization.refundId,
    reason: 'allocation_attribution_correction',
    expectedNextCorrectionVersion: 2,
    expectedBaseAllocationSetId: id(),
    expectedSourceFingerprint: 'b'.repeat(64),
    rawPredecessorCorrectionSetId: id(),
    compatibleCorrectionSetId: id(),
    baselineKind: 'compatible_correction',
    currentReportingComplete: true,
    currency: 'USD',
    settlementCurrency: 'EUR',
    baselineTotalMinor: 600,
    eligible: true,
    ineligibleReason: null,
    items: [correctionSeedItem]
  };
  const correction: RefundReportingCorrectionPreviewDto = {
    refundId: finalization.refundId,
    expectedBaseAllocationSetId: correctionSeed.expectedBaseAllocationSetId!,
    rawPredecessorCorrectionSetId: correctionSeed.rawPredecessorCorrectionSetId,
    compatibleCorrectionSetId: correctionSeed.compatibleCorrectionSetId,
    expectedNextCorrectionVersion: 2,
    expectedSourceFingerprint: correctionSeed.expectedSourceFingerprint!,
    previewFingerprint: 'c'.repeat(64),
    baselineKind: 'compatible_correction',
    currentReportingComplete: true,
    proposedReportingComplete: true,
    compatibilityRepair: false,
    currency: 'USD',
    settlementCurrency: 'EUR',
    baselineTotalMinor: 600,
    proposedTotalMinor: 600,
    eligible: true,
    ineligibleReason: null,
    items: [correctionItem]
  };
  const recoveryActivationCandidate: AdministrativeRecoveryActivationCandidateDto = {
    finalizationEffectId: id(),
    orderItemId: refundItem.orderItemId,
    titleId: refundItem.titleId,
    soldAsTitle: refundItem.soldAsTitle,
    expectedCorrectionSetId: id(),
    expectedCorrectionVersion: 2,
    expectedSourceFingerprint: 'd'.repeat(64)
  };
  const recoveryDeactivationCandidate: AdministrativeRecoveryDeactivationCandidateDto = {
    recoveryGrantId: id(),
    recoveryReferenceId: id(),
    expectedStateChangedAt: occurredAt,
    orderItemId: refundItem.orderItemId,
    titleId: refundItem.titleId,
    soldAsTitle: refundItem.soldAsTitle
  };
  const recoverySeed: AdministrativeRecoverySeedDto = {
    refundId: finalization.refundId,
    activationCandidates: [recoveryActivationCandidate],
    deactivationCandidates: [recoveryDeactivationCandidate]
  };
  const recovery: AdministrativeRecoveryPreviewDto = {
    refundId: finalization.refundId,
    finalizationEffectId: recoveryActivationCandidate.finalizationEffectId,
    orderItemId: refundItem.orderItemId,
    titleId: refundItem.titleId,
    soldAsTitle: refundItem.soldAsTitle,
    expectedCorrectionSetId: recoveryActivationCandidate.expectedCorrectionSetId,
    expectedCorrectionVersion: recoveryActivationCandidate.expectedCorrectionVersion,
    expectedSourceFingerprint: recoveryActivationCandidate.expectedSourceFingerprint,
    previewFingerprint: 'e'.repeat(64),
    recoveryGrantId: null,
    eligible: true,
    ineligibleReason: null,
    effectiveAccessBefore: false,
    effectiveAccessAfter: true,
    accessChanged: true,
    emailQueued: true,
    persistsUntilDeactivated: true
  };
  const recoveryDeactivation: AdministrativeRecoveryDeactivationPreviewDto = {
    refundId: recoverySeed.refundId,
    recoveryGrantId: recoveryDeactivationCandidate.recoveryGrantId,
    recoveryReferenceId: recoveryDeactivationCandidate.recoveryReferenceId,
    expectedStateChangedAt: recoveryDeactivationCandidate.expectedStateChangedAt,
    orderItemId: recoveryDeactivationCandidate.orderItemId,
    titleId: recoveryDeactivationCandidate.titleId,
    soldAsTitle: recoveryDeactivationCandidate.soldAsTitle,
    eligible: true,
    ineligibleReason: null,
    effectiveAccessBefore: true,
    effectiveAccessAfter: false,
    accessChanged: true,
    emailQueued: true
  };

  const fixtures: readonly [object, readonly string[]][] = [
    [soldAsVariant, ['title', 'creatorName', 'format']],
    [{
      titleId: id(),
      currentTitle: 'Pale Orbit',
      format: 'prose',
      archived: false,
      soldAsVariants: [soldAsVariant],
      presentmentCurrency: 'USD',
      settlementCurrency: 'EUR',
      soldCopies: 4,
      fullyRefundedCopies: 1,
      netCopies: 3,
      grossPresentmentMinor: 4_800,
      finalizedRefundPresentmentMinor: 1_200,
      disputeWithdrawalPresentmentMinor: 0,
      disputeReinstatementPresentmentMinor: 0,
      grossSettlementMinor: 4_300,
      refundImpactMinor: -1_075,
      disputeImpactMinor: 0,
      processingFeeImpactMinor: -180,
      refundFeeImpactMinor: 15,
      disputeFeeImpactMinor: 0,
      otherFeeImpactMinor: 0,
      estimatedPayoutMinor: 3_060,
      settlementMetricsComplete: true,
      missingSourceCount: 0,
      state: 'fee_reconciled',
      freshnessAt: occurredAt
    } satisfies TitleSalesRowDto, TITLE_SALES_ROW_DTO_KEYS],
    [{
      presentmentCurrency: 'USD',
      settlementCurrency: null,
      titleCount: 2,
      soldCopies: 4,
      fullyRefundedCopies: 1,
      netCopies: 3,
      grossPresentmentMinor: 4_800,
      finalizedRefundPresentmentMinor: 1_200,
      disputeWithdrawalPresentmentMinor: 0,
      disputeReinstatementPresentmentMinor: 0,
      grossSettlementMinor: null,
      refundImpactMinor: null,
      disputeImpactMinor: null,
      processingFeeImpactMinor: null,
      refundFeeImpactMinor: null,
      disputeFeeImpactMinor: null,
      otherFeeImpactMinor: null,
      estimatedPayoutMinor: null,
      settlementMetricsComplete: false,
      missingSourceCount: 2,
      state: 'pending'
    } satisfies SalesCurrencySummaryDto, SALES_CURRENCY_SUMMARY_DTO_KEYS],
    [{
      issueId: id(),
      resourceType: 'refund',
      resourceId: finalization.refundId,
      safeCode: 'allocation_incomplete',
      state: 'open',
      impact: 'pending',
      actionability: 'refund_allocation_review',
      operationallyCurrent: true,
      safeReason: 'A refund allocation needs review.',
      firstObservedAt: occurredAt,
      lastObservedAt: occurredAt,
      occurrenceCount: 1,
      refundId: finalization.refundId
    } satisfies FinancialIssueDto, FINANCIAL_ISSUE_DTO_KEYS],
    [refundItem, REFUND_ITEM_DTO_KEYS],
    [finalizedAllocation, REFUND_ALLOCATION_DTO_KEYS],
    [draftItem, REFUND_DRAFT_ITEM_DTO_KEYS],
    [draft, REFUND_DRAFT_DTO_KEYS],
    [finalizationItem, REFUND_FINALIZATION_ITEM_PREVIEW_DTO_KEYS],
    [finalization, REFUND_FINALIZATION_PREVIEW_DTO_KEYS],
    [correctionSeedItem, REFUND_REPORTING_CORRECTION_SEED_ITEM_DTO_KEYS],
    [correctionSeed, REFUND_REPORTING_CORRECTION_SEED_DTO_KEYS],
    [correctionItem, REFUND_CORRECTION_ITEM_PREVIEW_DTO_KEYS],
    [correction, REFUND_REPORTING_CORRECTION_PREVIEW_DTO_KEYS],
    [
      recoveryActivationCandidate,
      ADMINISTRATIVE_RECOVERY_ACTIVATION_CANDIDATE_DTO_KEYS
    ],
    [
      recoveryDeactivationCandidate,
      ADMINISTRATIVE_RECOVERY_DEACTIVATION_CANDIDATE_DTO_KEYS
    ],
    [recoverySeed, ADMINISTRATIVE_RECOVERY_SEED_DTO_KEYS],
    [recovery, ADMINISTRATIVE_RECOVERY_PREVIEW_DTO_KEYS],
    [
      recoveryDeactivation,
      ADMINISTRATIVE_RECOVERY_DEACTIVATION_PREVIEW_DTO_KEYS
    ],
    [{
      refundId: finalization.refundId,
      orderId: id(),
      status: 'succeeded',
      allocationStatus: 'draft',
      financialState: 'pending',
      amountMinor: 600,
      currency: 'USD',
      orderSubtotalMinor: 1_200,
      orderTaxMinor: 96,
      orderTotalMinor: 1_296,
      items: [refundItem],
      finalizedAllocations: [finalizedAllocation],
      draft,
      finalizationPreview: finalization,
      correctionPreview: correction,
      recoveryPreviews: [recovery],
      openIssueCount: 1,
      dataThroughAt: occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt
    } satisfies RefundDetailDto, REFUND_DETAIL_DTO_KEYS],
    [{
      payoutId: id(),
      automatic: true,
      method: 'standard',
      status: 'failed',
      reconciliationStatus: 'completed',
      settlementCurrency: 'USD',
      amountMinor: 12_000,
      createdAt: occurredAt,
      arrivalAt: occurredAt,
      associatedTransactionCount: 4,
      bookstoreLinkedTransactionCount: 3,
      membershipComplete: false,
      bookstoreLinkedSubtotalMinor: 11_500,
      accountLevelAdjustmentCount: 2,
      accountLevelAdjustmentMinor: 500,
      safeFailureCode: 'account_closed',
      financialGeneration: 3,
      membershipGeneration: 2,
      historicalMembershipRetained: true,
      reversalState: 'incomplete',
      openIssueCount: 1,
      freshnessAt: occurredAt
    } satisfies PayoutSummaryDto, PAYOUT_SUMMARY_DTO_KEYS],
    [{
      payoutId: id(),
      automatic: true,
      method: 'standard',
      status: 'failed',
      reconciliationStatus: 'completed',
      settlementCurrency: 'USD',
      amountMinor: 12_000,
      createdAt: occurredAt,
      arrivalAt: occurredAt,
      associatedTransactionCount: 4,
      bookstoreLinkedTransactionCount: 3,
      membershipComplete: false,
      bookstoreLinkedSubtotalMinor: 11_500,
      accountLevelAdjustmentCount: 2,
      accountLevelAdjustmentMinor: 500,
      safeFailureCode: 'account_closed',
      financialGeneration: 3,
      membershipGeneration: 2,
      historicalMembershipRetained: true,
      reversalState: 'incomplete',
      openIssueCount: 1,
      freshnessAt: occurredAt,
      bookstoreLinkedFeeImpactMinor: -350,
      bookstoreLinkedNetMinor: 11_150,
      reversalAmountMinor: 0
    } satisfies PayoutDetailDto, PAYOUT_DETAIL_DTO_KEYS],
    [{
      currentTitle: 'Pale Orbit',
      titleId: id(),
      format: 'prose',
      archived: false,
      presentmentCurrency: 'USD',
      settlementCurrency: '',
      soldCopies: 4,
      fullyRefundedCopies: 1,
      netCopies: 3,
      grossPresentmentMinor: 4_800,
      finalizedRefundPresentmentMinor: 1_200,
      disputeWithdrawalPresentmentMinor: 0,
      disputeReinstatementPresentmentMinor: 0,
      grossSettlementMinor: null,
      refundImpactMinor: null,
      disputeImpactMinor: null,
      processingFeeImpactMinor: null,
      refundFeeImpactMinor: null,
      disputeFeeImpactMinor: null,
      otherFeeImpactMinor: null,
      estimatedPayoutMinor: null,
      settlementMetricsComplete: false,
      missingSourceCount: 2,
      state: 'pending',
      range: '30',
      dataThroughAt: null,
      soldAsVariantsJson: '[{"title":"Pale Orbit","creatorName":"A. Writer","format":"prose"}]'
    } satisfies SalesCsvRowDto, SALES_CSV_ROW_DTO_KEYS]
  ];

  it.each(Object.entries(EXPECTED_FINANCIAL_REPORTING_DTO_KEYSETS))(
    'exports the independently enumerated %s keyset',
    (name, expectedKeys) => {
      expect(
        FINANCIAL_REPORTING_DTO_KEYSETS[
          name as keyof typeof FINANCIAL_REPORTING_DTO_KEYSETS
        ]
      ).toEqual(expectedKeys);
    }
  );

  it('enumerates every approved DTO key exactly', () => {
    for (const [fixture, keys] of fixtures) expectExactKeys(fixture, keys);
    expect(FINANCIAL_REPORTING_DTO_KEYSETS).toEqual(
      EXPECTED_FINANCIAL_REPORTING_DTO_KEYSETS
    );
    expect(Object.values(FINANCIAL_REPORTING_DTO_KEYSETS)).toEqual(
      fixtures.map(([, keys]) => keys)
    );
  });

  it('binds settlement metric availability to completeness in every aggregate DTO', () => {
    type CompleteTitleRow = Extract<TitleSalesRowDto, { settlementMetricsComplete: true }>;
    type IncompleteTitleRow = Extract<TitleSalesRowDto, { settlementMetricsComplete: false }>;
    type CompleteSummary = Extract<
      SalesCurrencySummaryDto,
      { settlementMetricsComplete: true }
    >;
    type IncompleteSummary = Extract<
      SalesCurrencySummaryDto,
      { settlementMetricsComplete: false }
    >;
    type CompleteCsvRow = Extract<SalesCsvRowDto, { settlementMetricsComplete: true }>;
    type IncompleteCsvRow = Extract<SalesCsvRowDto, { settlementMetricsComplete: false }>;

    expectTypeOf<CompleteTitleRow['estimatedPayoutMinor']>().toEqualTypeOf<number>();
    expectTypeOf<CompleteTitleRow['missingSourceCount']>().toEqualTypeOf<0>();
    expectTypeOf<CompleteTitleRow['state']>()
      .toEqualTypeOf<'fee_reconciled' | 'payout_reconciled'>();
    expectTypeOf<IncompleteTitleRow['estimatedPayoutMinor']>().toEqualTypeOf<null>();
    expectTypeOf<IncompleteTitleRow['state']>().toEqualTypeOf<'pending' | 'exception'>();
    expectTypeOf<CompleteSummary['grossSettlementMinor']>().toEqualTypeOf<number>();
    expectTypeOf<IncompleteSummary['grossSettlementMinor']>().toEqualTypeOf<null>();
    expectTypeOf<CompleteCsvRow['estimatedPayoutMinor']>().toEqualTypeOf<number>();
    expectTypeOf<IncompleteCsvRow['estimatedPayoutMinor']>().toEqualTypeOf<null>();
  });

  it('distinguishes current, unavailable, and retained historical payout membership', () => {
    type CurrentMembership = Extract<PayoutSummaryDto, { membershipComplete: true }>;
    type HistoricalMembership = Extract<
      PayoutSummaryDto,
      { historicalMembershipRetained: true }
    >;
    type UnavailableMembership = Extract<
      PayoutSummaryDto,
      { membershipComplete: false; historicalMembershipRetained: false }
    >;

    expectTypeOf<CurrentMembership['associatedTransactionCount']>().toEqualTypeOf<number>();
    expectTypeOf<CurrentMembership['bookstoreLinkedSubtotalMinor']>().toEqualTypeOf<number>();
    expectTypeOf<CurrentMembership['accountLevelAdjustmentCount']>().toEqualTypeOf<number>();
    expectTypeOf<CurrentMembership['accountLevelAdjustmentMinor']>().toEqualTypeOf<number>();
    expectTypeOf<CurrentMembership['membershipGeneration']>().toEqualTypeOf<number>();
    expectTypeOf<CurrentMembership['historicalMembershipRetained']>().toEqualTypeOf<false>();
    expectTypeOf<HistoricalMembership['membershipComplete']>().toEqualTypeOf<false>();
    expectTypeOf<HistoricalMembership['bookstoreLinkedSubtotalMinor']>().toEqualTypeOf<number>();
    expectTypeOf<HistoricalMembership['accountLevelAdjustmentCount']>().toEqualTypeOf<number>();
    expectTypeOf<HistoricalMembership['accountLevelAdjustmentMinor']>().toEqualTypeOf<number>();
    expectTypeOf<HistoricalMembership['membershipGeneration']>().toEqualTypeOf<number>();
    expectTypeOf<UnavailableMembership['associatedTransactionCount']>().toEqualTypeOf<null>();
    expectTypeOf<UnavailableMembership['bookstoreLinkedSubtotalMinor']>().toEqualTypeOf<null>();
    expectTypeOf<UnavailableMembership['accountLevelAdjustmentCount']>().toEqualTypeOf<null>();
    expectTypeOf<UnavailableMembership['accountLevelAdjustmentMinor']>().toEqualTypeOf<null>();
    expectTypeOf<UnavailableMembership['membershipGeneration']>().toEqualTypeOf<null>();

    type AvailableDetail = Extract<PayoutDetailDto, { membershipComplete: true }>;
    type HistoricalDetail = Extract<PayoutDetailDto, { historicalMembershipRetained: true }>;
    type UnavailableDetail = Extract<
      PayoutDetailDto,
      { membershipComplete: false; historicalMembershipRetained: false }
    >;
    expectTypeOf<AvailableDetail['bookstoreLinkedFeeImpactMinor']>().toEqualTypeOf<number>();
    expectTypeOf<AvailableDetail['bookstoreLinkedNetMinor']>().toEqualTypeOf<number>();
    expectTypeOf<HistoricalDetail['bookstoreLinkedFeeImpactMinor']>().toEqualTypeOf<number>();
    expectTypeOf<HistoricalDetail['bookstoreLinkedNetMinor']>().toEqualTypeOf<number>();
    expectTypeOf<UnavailableDetail['bookstoreLinkedFeeImpactMinor']>().toEqualTypeOf<null>();
    expectTypeOf<UnavailableDetail['bookstoreLinkedNetMinor']>().toEqualTypeOf<null>();
  });

  it('allows CSV freshness to be unavailable before any successful scan completes', () => {
    type CsvFreshness = SalesCsvRowDto['dataThroughAt'];
    expectTypeOf<CsvFreshness>().toEqualTypeOf<string | null>();
  });

  it('represents recovery disabled by a correction rebase requirement', () => {
    const rebaseRequired = {
      ...recovery,
      eligible: false,
      ineligibleReason: 'correction_rebase_required'
    } satisfies AdministrativeRecoveryPreviewDto;

    expect(rebaseRequired.ineligibleReason).toBe('correction_rebase_required');
  });

  it('keeps activation fingerprinting separate from timestamp-bound deactivation', () => {
    expectTypeOf<AdministrativeRecoveryPreviewDto['previewFingerprint']>()
      .toEqualTypeOf<string | null>();
    expectTypeOf<AdministrativeRecoveryDeactivationPreviewDto['expectedStateChangedAt']>()
      .toEqualTypeOf<string>();
    expectTypeOf<AdministrativeRecoveryDeactivationPreviewDto['ineligibleReason']>()
      .toEqualTypeOf<'already_in_requested_state' | null>();
    expect(ADMINISTRATIVE_RECOVERY_DEACTIVATION_PREVIEW_DTO_KEYS)
      .not.toContain('previewFingerprint');
  });

  it('does not expose forbidden identity, provider, job, evidence, audit, credential, claim, or URL keys', () => {
    const forbidden = new Set([
      'input', 'rawInput', 'actor', 'actorId', 'user', 'userId', 'customer', 'customerId',
      'email', 'providerId', 'stripeId', 'evidence', 'jobId', 'payload', 'error',
      'audit', 'auditBody', 'credential', 'claim', 'claimProof', 'url', 'actionUrl'
    ]);
    const keys = Object.values(FINANCIAL_REPORTING_DTO_KEYSETS).flat();
    expect(keys.filter((key) => forbidden.has(key))).toEqual([]);
  });
});

describe('financial administrator command contracts', () => {
  it('uses the exact six command kinds, five statuses, and eleven result codes', () => {
    expect(FINANCIAL_ADMIN_COMMAND_KINDS).toEqual([
      'refund_draft_save',
      'refund_draft_discard',
      'refund_allocation_finalize',
      'refund_reporting_correction_create',
      'administrative_recovery_activate',
      'administrative_recovery_deactivate'
    ]);
    expect(FINANCIAL_ADMIN_COMMAND_STATUSES).toEqual([
      'pending', 'succeeded', 'denied', 'conflict', 'failed'
    ]);
    expect(RESULT_CODES).toEqual([
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
    ]);
    expectTypeOf<FinancialAdminCommandResultCode>().toEqualTypeOf<
      keyof FinancialAdminCommandSafeResultByCode
    >();
    expectTypeOf<FinancialAdminCommandStatusDto['resultCode']>()
      .toEqualTypeOf<FinancialAdminCommandResultCode | null>();
  });

  it('binds each command kind to exactly one success code', () => {
    expectTypeOf(FINANCIAL_ADMIN_SUCCESS_CODE_BY_KIND)
      .toEqualTypeOf<FinancialAdminSuccessCodeByKind>();
    expect(FINANCIAL_ADMIN_SUCCESS_CODE_BY_KIND).toEqual({
      refund_draft_save: 'draft_saved',
      refund_draft_discard: 'draft_discarded',
      refund_allocation_finalize: 'allocation_finalized',
      refund_reporting_correction_create: 'correction_created',
      administrative_recovery_activate: 'recovery_activated',
      administrative_recovery_deactivate: 'recovery_deactivated'
    });
  });

  it('keeps command references browser-safe and allows actual terminal replay status', () => {
    const reference: FinancialAdminCommandReferenceDto = {
      commandId: id(),
      kind: 'refund_draft_save',
      status: 'succeeded',
      createdAt: occurredAt
    };
    expectExactKeys(reference, REFERENCE_DTO_KEYS);
  });

  it('defines only non-null safe terminal result payloads', () => {
    const refundId = id();
    const safeResults: readonly FinancialAdminCommandSafeResultDto[] = [
      { refundId, draftVersion: 2, changed: true },
      { refundId, finalizedDraftVersion: 3, accessChanged: true, emailQueued: true },
      { refundId, correctionSetId: id(), correctionVersion: 1 },
      { recoveryGrantId: id(), accessChanged: false, emailQueued: false }
    ];
    expect(safeResults).not.toContain(null);
    expectTypeOf<FinancialAdminCommandSafeResultByCode['capability_revoked']>()
      .toEqualTypeOf<null>();
    expectTypeOf<FinancialAdminCommandSafeResultByCode['not_eligible']>()
      .toEqualTypeOf<null>();
    expectTypeOf<FinancialAdminCommandSafeResultByCode['stale_state']>()
      .toEqualTypeOf<null>();
    expectTypeOf<FinancialAdminCommandSafeResultByCode['invalid_command']>()
      .toEqualTypeOf<null>();
    expectTypeOf<FinancialAdminCommandSafeResultByCode['command_failed']>()
      .toEqualTypeOf<null>();
  });

  it.each([
    ['refund_draft_save', 'draft_saved', { refundId: id(), draftVersion: 2, changed: true }],
    ['refund_draft_discard', 'draft_discarded', { refundId: id(), draftVersion: 2, changed: false }],
    ['refund_allocation_finalize', 'allocation_finalized', {
      refundId: id(), finalizedDraftVersion: 3, accessChanged: true, emailQueued: true
    }],
    ['refund_reporting_correction_create', 'correction_created', {
      refundId: id(), correctionSetId: id(), correctionVersion: 1
    }],
    ['administrative_recovery_activate', 'recovery_activated', {
      recoveryGrantId: id(), accessChanged: true, emailQueued: true
    }],
    ['administrative_recovery_deactivate', 'recovery_deactivated', {
      recoveryGrantId: id(), accessChanged: true, emailQueued: true
    }]
  ] as const)('parses the exact %s success mapping', (kind, resultCode, result) => {
    const value = {
      commandId: id(),
      kind,
      status: 'succeeded',
      createdAt: occurredAt,
      updatedAt: occurredAt,
      resultCode,
      result,
      completedAt: occurredAt
    };
    const parsed = parseFinancialAdminCommandStatus(value);
    expect(parsed).toEqual(value);
    expectExactKeys(parsed satisfies FinancialAdminCommandStatusDto, STATUS_DTO_KEYS);
  });

  it.each([
    { status: 'pending', resultCode: null, result: null, completedAt: null },
    { status: 'denied', resultCode: 'capability_revoked', result: null, completedAt: occurredAt },
    { status: 'conflict', resultCode: 'stale_state', result: null, completedAt: occurredAt },
    { status: 'conflict', resultCode: 'not_eligible', result: null, completedAt: occurredAt },
    { status: 'failed', resultCode: 'invalid_command', result: null, completedAt: occurredAt },
    { status: 'failed', resultCode: 'command_failed', result: null, completedAt: occurredAt }
  ] as const)('parses the strict $status terminal contract', (variant) => {
    const value = {
      commandId: id(),
      kind: 'refund_draft_save' as const,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      ...variant
    };
    expect(parseFinancialAdminCommandStatus(value)).toEqual(value);
  });

  it.each([
    ['wrong success code', { status: 'succeeded', resultCode: 'correction_created', result: {
      refundId: id(), correctionSetId: id(), correctionVersion: 1
    }, completedAt: occurredAt }],
    ['wrong success payload', { status: 'succeeded', resultCode: 'draft_saved', result: {
      refundId: id(), finalizedDraftVersion: 2, accessChanged: false, emailQueued: false
    }, completedAt: occurredAt }],
    ['pending completion', { status: 'pending', resultCode: null, result: null, completedAt: occurredAt }],
    ['denied non-null result', { status: 'denied', resultCode: 'capability_revoked', result: {
      refundId: id(), draftVersion: 1, changed: false
    }, completedAt: occurredAt }],
    ['conflict failure code', { status: 'conflict', resultCode: 'command_failed', result: null,
      completedAt: occurredAt }],
    ['failed conflict code', { status: 'failed', resultCode: 'stale_state', result: null,
      completedAt: occurredAt }]
  ])('rejects %s', (_label, variant) => {
    expect(() => parseFinancialAdminCommandStatus({
      commandId: id(),
      kind: 'refund_draft_save',
      createdAt: occurredAt,
      updatedAt: occurredAt,
      ...variant
    })).toThrow();
  });

  it('uses resultCode on the wire and rejects the legacy code field', () => {
    expect(STATUS_DTO_KEYS).toContain('resultCode');
    expect(STATUS_DTO_KEYS).not.toContain('code');
    expect(() => parseFinancialAdminCommandStatus({
      commandId: id(),
      kind: 'refund_draft_save',
      status: 'pending',
      createdAt: occurredAt,
      updatedAt: occurredAt,
      resultCode: null,
      result: null,
      completedAt: null,
      code: null
    })).toThrow();
  });

  it.each([
    'input', 'rawInput', 'actor', 'userId', 'customerId', 'email', 'jobId', 'payload',
    'error', 'providerId', 'evidence', 'auditBody', 'credential', 'claimProof', 'url'
  ])('rejects the forbidden %s field', (field) => {
    expect(() => parseFinancialAdminCommandStatus({
      commandId: id(),
      kind: 'refund_draft_save',
      status: 'pending',
      createdAt: occurredAt,
      updatedAt: occurredAt,
      resultCode: null,
      result: null,
      completedAt: null,
      [field]: 'private'
    })).toThrow();
  });

  it('rejects forbidden nested result data', () => {
    expect(() => parseFinancialAdminCommandStatus({
      commandId: id(),
      kind: 'refund_draft_save',
      status: 'succeeded',
      createdAt: occurredAt,
      updatedAt: occurredAt,
      resultCode: 'draft_saved',
      result: { refundId: id(), draftVersion: 2, changed: true, providerId: 're_unsafe' },
      completedAt: occurredAt
    })).toThrow();
  });
});
