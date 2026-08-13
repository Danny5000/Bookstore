import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import type { JobHandler } from '$lib/server/jobs/types';
import { PermanentJobError } from '$lib/server/jobs/runner';
import { PermanentFinancialError } from '../errors';
import { reconcilePaymentFinancialSource } from '../sources/payment';
import { reconcileRefundFinancialSource } from '../sources/refund';
import { reconcileDisputeFinancialSource } from '../sources/dispute';
import {
  FINANCIAL_SOURCE_JOB,
  parseFinancialJobIdentity
} from '../jobs';

export interface FinancialSourceHandlerDependencies {
  readonly database: Database;
  readonly gateway: StripeCommerceGateway;
}

export function createFinancialSourceHandler(
  dependencies: FinancialSourceHandlerDependencies
): JobHandler {
  return async (job, signal) => {
    if (signal.aborted) {
      throw new DOMException('Financial source reconciliation was aborted.', 'AbortError');
    }
    let payload;
    try {
      const identity = parseFinancialJobIdentity({
        type: job.type,
        payload: job.payload,
        deduplicationKey: job.deduplicationKey,
        maxAttempts: job.maxAttempts
      });
      if (identity.type !== FINANCIAL_SOURCE_JOB) throw new Error('wrong family');
      payload = identity.payload;
    } catch {
      throw new PermanentJobError('Invalid financial source job identity.');
    }
    const input = { correlationId: `financial-source-${job.id}` };
    try {
      if (payload.sourceKind === 'payment') {
        await reconcilePaymentFinancialSource(dependencies.database, dependencies.gateway, {
          ...input, paymentId: payload.sourceId
        }, signal);
      } else if (payload.sourceKind === 'refund') {
        await reconcileRefundFinancialSource(dependencies.database, dependencies.gateway, {
          ...input, refundId: payload.sourceId
        }, signal);
      } else {
        await reconcileDisputeFinancialSource(dependencies.database, dependencies.gateway, {
          ...input, disputeId: payload.sourceId
        }, signal);
      }
    } catch (error) {
      if (error instanceof PermanentFinancialError) {
        throw new PermanentJobError('Financial source evidence is invalid.');
      }
      throw error;
    }
  };
}
