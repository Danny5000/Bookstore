import type { JobHandler } from '$lib/server/jobs/types';
import { PermanentJobError } from '$lib/server/jobs/runner';
import {
  FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  FINANCIAL_CLASSIFIER_VERSION
} from '../constants';
import { PermanentFinancialError } from '../errors';
import {
  FINANCIAL_CLASSIFICATION_JOB,
  parseFinancialJobIdentity
} from '../jobs';
import {
  replayFinancialClassification,
  type FinancialClassificationReplayDependencies
} from '../rebase';

export interface FinancialClassificationHandlerDependencies {
  readonly database: FinancialClassificationReplayDependencies['database'];
  readonly targetClassifierVersion?: number;
  readonly targetAllocationAlgorithmVersion?: number;
}

export function createFinancialClassificationHandler(
  dependencies: FinancialClassificationHandlerDependencies
): JobHandler {
  const replayDependencies: FinancialClassificationReplayDependencies = {
    database: dependencies.database,
    targetClassifierVersion:
      dependencies.targetClassifierVersion ?? FINANCIAL_CLASSIFIER_VERSION,
    targetAllocationAlgorithmVersion:
      dependencies.targetAllocationAlgorithmVersion ?? FINANCIAL_ALLOCATION_ALGORITHM_VERSION
  };
  return async (job, signal) => {
    if (signal.aborted) {
      throw new DOMException('Financial classification job was aborted.', 'AbortError');
    }
    let payload;
    try {
      const identity = parseFinancialJobIdentity({
        type: job.type,
        payload: job.payload,
        deduplicationKey: job.deduplicationKey,
        maxAttempts: job.maxAttempts
      });
      if (identity.type !== FINANCIAL_CLASSIFICATION_JOB) {
        throw new PermanentFinancialError('invalid_job_payload');
      }
      payload = identity.payload;
    } catch {
      throw new PermanentJobError('Invalid financial classification job payload.');
    }
    try {
      await replayFinancialClassification(replayDependencies, {
        payload,
        correlationId: `financial-classification-${job.id}`,
        signal
      });
    } catch (error) {
      if (error instanceof PermanentFinancialError) {
        throw new PermanentJobError('Financial classification evidence is invalid.');
      }
      throw error;
    }
  };
}
