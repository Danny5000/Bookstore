import type { JobHandler } from '$lib/server/jobs/types';
import type { FinancialScanServiceDependencies } from '../scans/service';
import { processFinancialScanJob } from '../scans/service';
import { PermanentJobError } from '$lib/server/jobs/runner';
import { PermanentFinancialError } from '../errors';
import {
  FINANCIAL_SCAN_JOB,
  parseFinancialJobIdentity
} from '../jobs';

export type FinancialScanHandlerDependencies = FinancialScanServiceDependencies;

export function createFinancialScanHandler(
  dependencies: FinancialScanHandlerDependencies
): JobHandler {
  return async (job, signal) => {
    if (signal.aborted) throw new DOMException('Financial scan job was aborted.', 'AbortError');
    let payload;
    try {
      const identity = parseFinancialJobIdentity({
        type: job.type,
        payload: job.payload,
        deduplicationKey: job.deduplicationKey,
        maxAttempts: job.maxAttempts
      });
      if (identity.type !== FINANCIAL_SCAN_JOB) throw new Error('wrong family');
      payload = identity.payload;
    } catch {
      throw new PermanentJobError('Invalid financial scan job identity.');
    }
    try {
      await processFinancialScanJob(dependencies, {
        payload,
        correlationId: `financial-scan-${job.id}`,
        signal
      });
    } catch (error) {
      if (error instanceof PermanentFinancialError) {
        throw new PermanentJobError('Financial scan evidence is invalid.');
      }
      throw error;
    }
  };
}
