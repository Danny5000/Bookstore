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
  parseFinancialSourceEventJobPayload,
  parseFinancialSourcePayoutImpactJobPayload,
  parseFinancialSourceScanJobPayload,
  type FinancialSourceJobPayload
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
    if (job.type !== FINANCIAL_SOURCE_JOB) {
      throw new PermanentJobError('Invalid financial source job type.');
    }
    let payload: FinancialSourceJobPayload;
    try {
      const value = job.payload as { trigger?: { kind?: unknown } };
      if (value.trigger?.kind === 'event') payload = parseFinancialSourceEventJobPayload(job.payload);
      else if (value.trigger?.kind === 'scan') payload = parseFinancialSourceScanJobPayload(job.payload);
      else if (value.trigger?.kind === 'payout_impact') {
        payload = parseFinancialSourcePayoutImpactJobPayload(job.payload);
      } else {
        throw new Error('unknown trigger');
      }
    } catch {
      throw new PermanentJobError('Invalid financial source job payload.');
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
