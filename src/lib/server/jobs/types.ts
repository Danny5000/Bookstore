import type { JsonObject } from '$lib/server/db/schema';

export interface JobRecord {
  id: string;
  type: string;
  payload: JsonObject;
  deduplicationKey: string | null;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
}

export type JobHandler = (job: JobRecord, signal: AbortSignal) => Promise<void>;

export interface JobRepository {
  claimNext(workerId: string): Promise<JobRecord | null>;
  renewLease(jobId: string, workerId: string): Promise<boolean>;
  complete(jobId: string, workerId: string): Promise<boolean>;
  fail(
    jobId: string,
    workerId: string,
    safeError: string,
    retryable: boolean
  ): Promise<boolean>;
}
