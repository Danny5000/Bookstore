import type { JsonObject } from '$lib/server/db/schema';

export interface JobRecord {
  id: string;
  type: string;
  payload: JsonObject;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
}

export type JobHandler = (job: JobRecord, signal: AbortSignal) => Promise<void>;

export interface JobRepository {
  claimNext(workerId: string): Promise<JobRecord | null>;
  complete(jobId: string, workerId: string): Promise<void>;
  fail(
    jobId: string,
    workerId: string,
    safeError: string,
    retryable: boolean
  ): Promise<void>;
}
