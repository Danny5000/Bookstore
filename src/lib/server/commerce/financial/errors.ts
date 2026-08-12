export type PermanentFinancialSafeCode =
  | 'allocation_mismatch'
  | 'classification_fork'
  | 'correction_rebase_required'
  | 'currency_mismatch'
  | 'generation_exhausted'
  | 'immutable_mismatch'
  | 'invalid_job_payload'
  | 'payout_membership_conflict'
  | 'source_linkage_mismatch'
  | 'unsupported_provider_evidence';

export type RetryableFinancialSafeCode =
  | 'local_state_pending'
  | 'provider_not_ready'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'state_changed';

export class PermanentFinancialError extends Error {
  constructor(readonly safeCode: PermanentFinancialSafeCode) {
    super('The financial reconciliation operation cannot be completed.');
    this.name = 'PermanentFinancialError';
  }
}

export class RetryableFinancialError extends Error {
  constructor(readonly safeCode: RetryableFinancialSafeCode) {
    super('The financial reconciliation operation can be retried.');
    this.name = 'RetryableFinancialError';
  }
}
