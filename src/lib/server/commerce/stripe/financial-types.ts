export interface ChargeSnapshot {
  id: string;
  paymentIntentId: string;
  livemode: boolean;
  amountMinor: number;
  amountRefundedMinor: number;
  currency: string;
  status: 'succeeded' | 'pending' | 'failed';
  balanceTransactionId: string | null;
  createdAt: Date;
}

export interface BalanceTransactionFeeDetailSnapshot {
  ordinal: number;
  rawType: string;
  amountMinor: number;
  currency: string;
}

export interface BalanceTransactionSnapshot {
  id: string;
  livemode: boolean;
  sourceId: string | null;
  sourceFamily: 'charge' | 'refund' | 'dispute' | 'payout' | 'adjustment' | 'unknown';
  rawType: string;
  reportingCategory: string;
  amountMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: string;
  status: 'pending' | 'available';
  balanceType: string;
  createdAt: Date;
  availableAt: Date;
  exchangeRate: string | null;
  exchangeSourceCurrency: string | null;
  exchangeTargetCurrency: string | null;
  feeDetails: readonly BalanceTransactionFeeDetailSnapshot[];
}

export interface PayoutSnapshot {
  id: string;
  livemode: boolean;
  amountMinor: number;
  currency: string;
  automatic: boolean;
  method: 'standard' | 'instant' | 'unknown';
  status: 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';
  reconciliationStatus: 'in_progress' | 'completed' | 'not_applicable';
  createdAt: Date;
  arrivalAt: Date;
  balanceTransactionId: string | null;
  failureBalanceTransactionId: string | null;
  originalPayoutId: string | null;
  reversedByPayoutId: string | null;
  safeFailureCode: string | null;
}

export interface StripePageRequest {
  limit: number;
  startingAfter?: string;
  createdGte?: number;
  createdLt?: number;
}

export interface StripeListPage<Value> {
  data: readonly Value[];
  hasMore: boolean;
  nextStartingAfter: string | null;
}
