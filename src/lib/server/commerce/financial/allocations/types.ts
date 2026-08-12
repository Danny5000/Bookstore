import type {
  FinancialAllocationPlan,
  FinancialAllocationSourceKind,
  FinancialComponent
} from '../types';

export interface FinancialAllocationPlanBundle {
  readonly plans: readonly [FinancialAllocationPlan, FinancialAllocationPlan];
}

export interface FinancialAllocationMetadata {
  readonly sourceKind: FinancialAllocationSourceKind;
  readonly sourceId: string;
  readonly balanceTransactionId: string;
  readonly allocationIdentityPrefix: string;
  readonly settlementCurrency: string;
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly netMinor: number;
  readonly sourceFingerprint: string;
  readonly algorithmVersion: number;
  readonly supersedesGrossSetId: string | null;
  readonly supersedesFeeSetId: string | null;
}

export interface ChargeAllocationItem {
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly presentmentCurrency: string;
}

export interface ClassifiedFeeDetail {
  readonly amountMinor: number;
  readonly component: Extract<
    FinancialComponent,
    'processing_fee' | 'refund_fee' | 'dispute_fee' | 'provider_fee_tax' | 'fee_credit' | 'other'
  >;
}

export interface ChargeAllocationInput extends FinancialAllocationMetadata {
  readonly sourceKind: 'payment';
  readonly items: readonly ChargeAllocationItem[];
  readonly feeDetails: readonly ClassifiedFeeDetail[];
}

export interface RefundAllocationComponent {
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly remainingSubtotalCapacityMinor: number;
  readonly remainingTaxCapacityMinor: number;
  readonly presentmentCurrency: string;
}

export interface RefundFeeWeight {
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly currency: string;
}

/** Immutable paid capacity used to replay refund chronology safely. */
export interface RefundPaymentCapacity {
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly presentmentCurrency: string;
}

export interface EarlierFinalizedRefundComponent {
  readonly refundId: string;
  readonly providerCreatedAt: string;
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly presentmentCurrency: string;
}

export interface RefundAllocationInput extends FinancialAllocationMetadata {
  readonly sourceKind: 'refund';
  /** Provider identity/time make earlier finalized facts a strict, replayable order. */
  readonly refundId?: string;
  readonly providerCreatedAt?: string;
  readonly presentmentAmountMinor: number;
  readonly presentmentCurrency: string;
  readonly attribution:
    | { readonly kind: 'finalized'; readonly components: readonly RefundAllocationComponent[] }
    | { readonly kind: 'unresolved' };
  readonly paymentItems: readonly RefundFeeWeight[];
  /** Optional while historical callers migrate; when supplied it supersedes caller remaining capacity. */
  readonly paymentItemCapacities?: readonly RefundPaymentCapacity[];
  readonly earlierFinalized?: readonly EarlierFinalizedRefundComponent[];
  readonly feeDetails: readonly ClassifiedFeeDetail[];
}

export interface FailedRefundAllocationInput extends FinancialAllocationMetadata {
  readonly sourceKind: 'refund';
  readonly originalGrossSetId: string;
  readonly originalGrossPlan: FinancialAllocationPlan;
  readonly originalFeeSetId: string | null;
  readonly originalFeePlan: FinancialAllocationPlan | null;
  readonly paymentItems: readonly RefundFeeWeight[];
  readonly feeDetails: readonly ClassifiedFeeDetail[];
}

export interface DisputeExposureItem {
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly currency: string;
}

export interface DisputePaymentItem {
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly presentmentCurrency: string;
}

export interface FinalizedDisputeRefund {
  readonly refundId: string;
  readonly providerCreatedAt: string;
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly presentmentCurrency: string;
}

/**
 * The bounded provider-neutral evidence persisted with a dispute withdrawal.
 * A reinstatement names the exact withdrawal allocation it restores.
 */
export interface DisputePresentmentEffect {
  readonly allocationId: string;
  readonly withdrawalSetId: string;
  readonly disputeId: string;
  readonly providerCreatedAt: string;
  readonly providerTransactionId: string;
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly presentmentCurrency: string;
  readonly effect: 'withdrawal' | 'reinstatement';
  readonly reversalOfAllocationId: string | null;
}

export interface DisputeAllocationPlanBundle extends FinancialAllocationPlanBundle {
  readonly presentmentEffects: readonly DisputePresentmentEffect[];
}

export interface DisputeAllocationInput extends FinancialAllocationMetadata {
  readonly sourceKind: 'dispute';
  readonly effect: 'withdrawal' | 'reinstatement' | 'fee_credit';
  readonly disputeId: string;
  readonly providerCreatedAt: string;
  readonly providerTransactionId: string;
  readonly presentmentAmountMinor: number;
  readonly presentmentCurrency: string;
  /** Immutable original payment components; caller-computed exposure is never accepted. */
  readonly paymentItems: readonly DisputePaymentItem[];
  readonly finalizedRefunds: readonly FinalizedDisputeRefund[];
  readonly priorPresentmentEffects: readonly DisputePresentmentEffect[];
  /** Required for a withdrawal and persisted alongside its returned effects. */
  readonly withdrawalSetId: string | null;
  readonly reversesSetId: string | null;
  readonly reversesFeeSetId: string | null;
  readonly withdrawalGrossPlan: FinancialAllocationPlan | null;
  readonly withdrawalFeePlan: FinancialAllocationPlan | null;
  readonly feeDetails: readonly ClassifiedFeeDetail[];
}
