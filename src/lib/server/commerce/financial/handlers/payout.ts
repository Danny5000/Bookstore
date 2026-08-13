import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import type { JobHandler } from '$lib/server/jobs/types';
import { PermanentJobError } from '$lib/server/jobs/runner';
import { PermanentFinancialError } from '../errors';
import { FINANCIAL_PAYOUT_JOB, parseFinancialJobIdentity } from '../jobs';
import { reconcileFinancialPayout } from '../payouts/service';

export interface FinancialPayoutHandlerDependencies {
  readonly database: Database;
  readonly gateway: StripeCommerceGateway;
}

export function createFinancialPayoutHandler(
  dependencies: FinancialPayoutHandlerDependencies
): JobHandler {
  return async (job, signal) => {
    if (signal.aborted) throw new DOMException('Financial payout job was aborted.', 'AbortError');
    let payload;
    try {
      const identity = parseFinancialJobIdentity({
        type: job.type,
        payload: job.payload,
        deduplicationKey: job.deduplicationKey,
        maxAttempts: job.maxAttempts
      });
      if (identity.type !== FINANCIAL_PAYOUT_JOB) throw new Error('wrong family');
      payload = identity.payload;
    } catch {
      throw new PermanentJobError('Invalid financial payout job identity.');
    }
    try {
      await reconcileFinancialPayout(dependencies, {
        payload,
        correlationId: `financial-payout-${job.id}`,
        signal
      });
    } catch (error) {
      if (error instanceof PermanentFinancialError) {
        throw new PermanentJobError('Financial payout evidence is invalid.');
      }
      throw error;
    }
  };
}
