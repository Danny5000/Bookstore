import type { JobHandler } from '$lib/server/jobs/types';
import type { FinancialScanServiceDependencies } from '../scans/service';
import { processFinancialScanJob } from '../scans/service';
import { PermanentJobError } from '$lib/server/jobs/runner';
import { PermanentFinancialError } from '../errors';
import {
  FINANCIAL_SCAN_JOB,
  parseFinancialCompositeReplayScanJobPayload,
  parseFinancialHourlyScanJobPayload,
  parseFinancialInitialScanJobPayload,
  parseFinancialPayoutImpactScanJobPayload,
  parseFinancialScanContinuationJobPayload,
  type FinancialScanJobPayload
} from '../jobs';

export type FinancialScanHandlerDependencies = FinancialScanServiceDependencies;

export function createFinancialScanHandler(
  dependencies: FinancialScanHandlerDependencies
): JobHandler {
  return async (job, signal) => {
    if (signal.aborted) throw new DOMException('Financial scan job was aborted.', 'AbortError');
    if (job.type !== FINANCIAL_SCAN_JOB) {
      throw new PermanentJobError('Invalid financial scan job type.');
    }
    let payload: FinancialScanJobPayload;
    try {
      const kind = (job.payload as { kind?: unknown }).kind;
      if (kind === 'initial') payload = parseFinancialInitialScanJobPayload(job.payload);
      else if (kind === 'hourly') payload = parseFinancialHourlyScanJobPayload(job.payload);
      else if (kind === 'payout_impact') {
        payload = parseFinancialPayoutImpactScanJobPayload(job.payload);
      } else if (kind === 'composite_replay') {
        payload = parseFinancialCompositeReplayScanJobPayload(job.payload);
      } else if (kind === 'continuation') {
        payload = parseFinancialScanContinuationJobPayload(job.payload);
      } else {
        throw new PermanentFinancialError('invalid_job_payload');
      }
    } catch {
      throw new PermanentJobError('Invalid financial scan job payload.');
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
