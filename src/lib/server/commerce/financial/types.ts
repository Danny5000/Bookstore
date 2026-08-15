export type FinancialSourceKind = 'payment' | 'refund' | 'dispute';
export type FinancialAllocationSourceKind =
  | FinancialSourceKind
  | 'payout'
  | 'adjustment';
export type FinancialEvidenceStatus = 'pending' | 'fee_reconciled' | 'exception';
export type PublicFinancialState = FinancialEvidenceStatus | 'payout_reconciled';
export type AllocationBasis = 'gross_amount' | 'fee';
export type AllocationScope = 'title' | 'account' | 'unresolved';

export type FinancialComponent =
  | 'sale_subtotal'
  | 'sale_tax'
  | 'processing_fee'
  | 'refund_subtotal'
  | 'refund_tax'
  | 'refund_fee'
  | 'refund_failure_reversal'
  | 'dispute_subtotal'
  | 'dispute_tax'
  | 'dispute_fee'
  | 'dispute_reinstatement'
  | 'provider_fee_tax'
  | 'fee_credit'
  | 'other';

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

export type FinancialIssueImpact = 'pending' | 'exception' | 'informational';
export type FinancialIssueState = 'open' | 'resolved';

export interface FinancialAllocationItem {
  readonly orderItemId: string;
  readonly component: FinancialComponent;
  readonly effectMinor: number;
  readonly currency: string;
  readonly tieBreakKey: string;
}

export interface FinancialAllocationPlan {
  readonly allocationIdentity: string;
  readonly balanceTransactionId: string;
  readonly basis: AllocationBasis;
  readonly scope: AllocationScope;
  readonly currency: string;
  readonly expectedEffectMinor: number;
  readonly algorithmVersion: number;
  readonly sourceFingerprint: string;
  readonly supersedesSetId: string | null;
  readonly reversalOfSetId: string | null;
  readonly items: readonly FinancialAllocationItem[];
}

export interface PersistFinancialAllocationPlanInput {
  readonly plan: FinancialAllocationPlan;
  readonly sourceKind: FinancialAllocationSourceKind;
  readonly sourceId: string;
  readonly classificationVersion: number;
  readonly correlationId: string;
}

export interface CurrentEffectiveAllocationItem {
  readonly orderItemId: string;
  readonly component: FinancialComponent;
  readonly effectMinor: number;
  readonly currency: string;
}

export type CurrentEffectiveAllocationProjection =
  | {
      readonly status: 'complete';
      readonly balanceTransactionId: string;
      readonly basis: AllocationBasis;
      readonly baseSetId: string;
      readonly compatibleCorrectionTipId: string | null;
      readonly scope: AllocationScope;
      readonly currency: string;
      readonly expectedEffectMinor: number;
      readonly items: readonly CurrentEffectiveAllocationItem[];
    }
  | {
      readonly status: 'missing';
      readonly balanceTransactionId: string;
      readonly basis: AllocationBasis;
      readonly safeCode: 'missing_source' | 'allocation_incomplete';
    }
  | {
      readonly status: 'exception';
      readonly balanceTransactionId: string;
      readonly basis: AllocationBasis;
      readonly safeCode:
        | 'allocation_fork'
        | 'allocation_mismatch'
        | 'classification_fork'
        | 'correction_rebase_required'
        | 'currency_mismatch'
        | 'immutable_mismatch'
        | 'source_linkage_mismatch'
        | 'unsupported_category';
    };

export interface CurrentPayoutEvidence {
  readonly relevantBalanceTransactionCount: number;
  readonly authoritativeMembershipCount: number;
  readonly paidAutomaticStandardCompletedCount: number;
  readonly conflictingMembershipCount: number;
  readonly hasOpenExceptionIssue: boolean;
  readonly hasMissingPayoutReversal: boolean;
}

export interface PublicFinancialStateInput {
  readonly financialEvidenceStatus: FinancialEvidenceStatus;
  readonly payoutEvidence: CurrentPayoutEvidence;
}

export type FinancialSourceResult =
  | {
      readonly status: 'reconciled';
      readonly sourceKind: FinancialSourceKind;
      readonly sourceId: string;
      readonly financialEvidenceStatus: 'fee_reconciled';
      readonly allocationSetIds: readonly string[];
      readonly issueIds: readonly string[];
    }
  | {
      readonly status: 'unchanged';
      readonly sourceKind: FinancialSourceKind;
      readonly sourceId: string;
      readonly financialEvidenceStatus: FinancialEvidenceStatus;
    }
  | {
      readonly status: 'pending';
      readonly sourceKind: FinancialSourceKind;
      readonly sourceId: string;
      readonly financialEvidenceStatus: 'pending';
      readonly safeCode: 'allocation_incomplete' | 'missing_source' | 'provider_not_ready';
      readonly issueId: string | null;
    }
  | {
      readonly status: 'exception';
      readonly sourceKind: FinancialSourceKind;
      readonly sourceId: string;
      readonly financialEvidenceStatus: 'exception';
      readonly safeCode: FinancialIssueCode;
      readonly issueId: string;
    };

export type RefundProviderStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';
export type RefundAllocationStatus =
  | 'not_applicable'
  | 'needs_review'
  | 'draft'
  | 'finalized'
  | 'exception';

export interface LockedRefundOrderItemFact {
  readonly id: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly currency: string;
}

export interface LockedRefundAllocationFact {
  readonly id: string;
  readonly orderItemId: string;
  readonly amountMinor: number;
}

export interface LockedRefundComponentFact {
  readonly refundAllocationId: string;
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly currency: string;
}

export interface LockedRefundProjectionInput {
  readonly orderId: string;
  readonly paymentId: string;
  readonly refundId: string;
  readonly providerStatus: RefundProviderStatus;
  readonly allocationStatus: RefundAllocationStatus;
  readonly amountMinor: number;
  readonly currency: string;
  readonly balanceTransactionIds: readonly string[];
  readonly orderItems: readonly LockedRefundOrderItemFact[];
  readonly finalizedAllocations: readonly LockedRefundAllocationFact[];
  readonly refundComponents: readonly LockedRefundComponentFact[];
  readonly correlationId: string;
}

export type RefundFinancialRecomputeResult =
  | {
      readonly status: 'reconciled';
      readonly refundId: string;
      readonly financialEvidenceStatus: 'fee_reconciled';
      readonly allocationSetIds: readonly string[];
      readonly resolvedIssueIds: readonly string[];
    }
  | {
      readonly status: 'unchanged';
      readonly refundId: string;
      readonly financialEvidenceStatus: 'fee_reconciled';
    }
  | {
      readonly status: 'pending';
      readonly refundId: string;
      readonly financialEvidenceStatus: 'pending';
      readonly safeCode: 'allocation_incomplete' | 'missing_source';
      readonly issueId: string;
    }
  | {
      readonly status: 'exception';
      readonly refundId: string;
      readonly financialEvidenceStatus: 'exception';
      readonly safeCode: FinancialIssueCode;
      readonly issueId: string;
    };

export interface CorrectionRebaseInput {
  readonly balanceTransactionId: string;
  readonly basis: AllocationBasis;
  readonly previousAllocationSetId: string;
  readonly replacementAllocationSetId: string;
  readonly approvedCorrectionSetId: string;
  readonly expectedSourceFingerprint: string;
  readonly correlationId: string;
}

export type FinancialClassificationSubjectType = 'balance_transaction' | 'fee_detail';

export type FinancialClassification =
  | 'charge'
  | 'refund'
  | 'refund_failure'
  | 'dispute_withdrawal'
  | 'dispute_reinstatement'
  | 'payout'
  | 'processing_fee'
  | 'refund_fee'
  | 'dispute_fee'
  | 'provider_fee_tax'
  | 'fee_credit'
  | 'other'
  | 'unknown';

export interface FinancialClassificationInput {
  readonly subjectType: FinancialClassificationSubjectType;
  readonly subjectId: string;
  readonly rawType: string;
  readonly reportingCategory: string | null;
  readonly sourceFingerprint: string;
  readonly classifierVersion: number;
}

export type FinancialClassificationDecision =
  | {
      readonly status: 'classified';
      readonly classification: Exclude<FinancialClassification, 'unknown'>;
      readonly impact: 'informational';
    }
  | {
      readonly status: 'unknown';
      readonly classification: 'unknown';
      readonly impact: 'exception';
      readonly safeCode: 'unsupported_category';
    };

export type PayoutImportRunState =
  | 'collecting'
  | 'publishable'
  | 'published'
  | 'abandoned'
  | 'exception';

export type PayoutStageResult =
  | { readonly status: 'inserted'; readonly payoutId: string; readonly generation: number }
  | { readonly status: 'unchanged'; readonly payoutId: string; readonly generation: number }
  | { readonly status: 'updated'; readonly payoutId: string; readonly generation: number }
  | {
      readonly status: 'exception';
      readonly payoutId: string;
      readonly safeCode: 'generation_exhausted' | 'immutable_mismatch';
    };

export type PayoutImportResult =
  | {
      readonly status: 'collecting' | 'publishable';
      readonly payoutId: string;
      readonly runId: string;
      readonly generation: number;
      readonly candidateCount: number;
      readonly nextCursor: string | null;
    }
  | {
      readonly status: 'published';
      readonly payoutId: string;
      readonly runId: string;
      readonly generation: number;
      readonly membershipCount: number;
    }
  | {
      readonly status: 'not_applicable' | 'abandoned';
      readonly payoutId: string;
      readonly generation: number;
    }
  | {
      readonly status: 'exception';
      readonly payoutId: string;
      readonly generation: number;
      readonly safeCode: 'immutable_mismatch' | 'payout_incomplete' | 'payout_membership_conflict';
      readonly issueId: string;
    };

export type ClassificationReplayResult =
  | { readonly status: 'unchanged'; readonly subjectId: string }
  | { readonly status: 'replayed'; readonly subjectId: string; readonly allocationSetIds: readonly string[] }
  | {
      readonly status: 'blocking_exception';
      readonly subjectId: string;
      readonly safeCode: FinancialIssueCode;
      readonly impact: 'pending' | 'exception';
      readonly issueId: string | null;
    }
  | {
      readonly status: 'exception';
      readonly subjectId: string;
      readonly safeCode: 'classification_fork' | 'correction_rebase_required';
      readonly issueId: string | null;
    };
