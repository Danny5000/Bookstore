import type { JsonObject } from '$lib/server/db/schema';

export interface JobRecord {
  id: string;
  type: string;
  payload: JsonObject;
  deduplicationKey: string | null;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
  financialAdminLeaseCapability?: string;
  operationsJobLeaseCapability?: string;
  operationsJobLeaseGeneration?: number;
}

export type JobHandler = (job: JobRecord, signal: AbortSignal) => Promise<void>;

export type JobFailureTransition =
  | { readonly applied: false }
  | {
      readonly applied: true;
      readonly retryScheduled: boolean;
    };

export interface OperationsJobLeaseAuthority {
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly generation: number;
  readonly capability: string;
}

export type OperationsJobSafeError =
  | 'Invalid operations job retry command identity.'
  | 'Operations job retry command permanently failed.'
  | 'Permanent job handler failure'
  | 'Transient job handler failure'
  | 'Transient job completion failure';

export interface JobRepository {
  claimNext(workerId: string): Promise<JobRecord | null>;
  renewLease(
    jobId: string,
    workerId: string,
    financialAdminLeaseCapability?: string
  ): Promise<boolean>;
  complete(
    jobId: string,
    workerId: string,
    financialAdminLeaseCapability?: string
  ): Promise<boolean>;
  fail(
    jobId: string,
    workerId: string,
    safeError: string,
    retryable: boolean,
    financialAdminLeaseCapability?: string
  ): Promise<boolean>;
  failWithDisposition(
    jobId: string,
    workerId: string,
    safeError: string,
    retryable: boolean,
    financialAdminLeaseCapability?: string
  ): Promise<JobFailureTransition>;
  renewOperationsJobLease(
    authority: OperationsJobLeaseAuthority
  ): Promise<boolean>;
  completeOperationsJob(
    authority: OperationsJobLeaseAuthority
  ): Promise<boolean>;
  failOperationsJob(
    authority: OperationsJobLeaseAuthority,
    safeError: OperationsJobSafeError,
    retryable: boolean
  ): Promise<JobFailureTransition>;
}
