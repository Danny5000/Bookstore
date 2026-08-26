import type {
  CorrelationId,
  JobFailedCode,
  JobLeaseLostCode
} from '../observability/contracts';
import type { StructuredLogger } from '../observability/logger';
import type { JobRecord } from './types';

export type JobFailureLogCode = JobFailedCode;
export type JobLeaseLostLogCode = JobLeaseLostCode;

export type WorkerSlotProgressEvent =
  | { readonly type: 'polling'; readonly slotId: number }
  | {
      readonly type: 'poll_succeeded';
      readonly slotId: number;
      readonly claimed: boolean;
    }
  | { readonly type: 'lease_renewed'; readonly slotId: number }
  | { readonly type: 'terminal_settled'; readonly slotId: number }
  | { readonly type: 'lease_lost'; readonly slotId: number };

export interface JobAttemptIdentity {
  readonly correlationId: CorrelationId;
  readonly jobId: string;
  readonly jobKind: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly workerId: string;
  readonly slotId: number;
  readonly generation?: number;
}

export type JobRunnerObservation =
  | { readonly type: 'job_claimed'; readonly identity: JobAttemptIdentity }
  | {
      readonly type: 'job_succeeded';
      readonly identity: JobAttemptIdentity;
      readonly durationMs: number;
    }
  | {
      readonly type: 'job_failed';
      readonly identity: JobAttemptIdentity;
      readonly code: JobFailureLogCode;
      readonly durationMs: number;
      readonly retryScheduled: boolean;
    }
  | {
      readonly type: 'job_lease_lost';
      readonly identity: JobAttemptIdentity;
      readonly code: JobLeaseLostLogCode;
    };

export type RunnerObservation = WorkerSlotProgressEvent | JobRunnerObservation;
export type RunnerObserver = (event: RunnerObservation) => void;

export interface JobDiagnosticMetadata {
  readonly correlationId?: unknown;
  readonly generation?: unknown;
}

export type JobDiagnosticMetadataParser = (
  job: Readonly<JobRecord>
) => JobDiagnosticMetadata;

export function createRunnerObserver(options: {
  readonly logger: StructuredLogger<'worker'>;
  readonly reportSlotProgress: (event: WorkerSlotProgressEvent) => void;
}): RunnerObserver {
  return (observation) => {
    switch (observation.type) {
      case 'polling':
        options.reportSlotProgress({ type: 'polling', slotId: observation.slotId });
        return;
      case 'poll_succeeded':
        options.reportSlotProgress({
          type: 'poll_succeeded',
          slotId: observation.slotId,
          claimed: observation.claimed
        });
        return;
      case 'lease_renewed':
        options.reportSlotProgress({ type: 'lease_renewed', slotId: observation.slotId });
        return;
      case 'terminal_settled':
        options.reportSlotProgress({ type: 'terminal_settled', slotId: observation.slotId });
        return;
      case 'lease_lost':
        options.reportSlotProgress({ type: 'lease_lost', slotId: observation.slotId });
        return;
      case 'job_claimed': {
        const { identity } = observation;
        if (Object.hasOwn(identity, 'generation')) {
          options.logger.emit({
            event: 'job.claimed',
            correlationId: identity.correlationId,
            jobId: identity.jobId,
            jobKind: identity.jobKind,
            attempt: identity.attempt,
            maxAttempts: identity.maxAttempts,
            workerId: identity.workerId,
            slotId: identity.slotId,
            generation: identity.generation!
          });
          return;
        }
        options.logger.emit({
          event: 'job.claimed',
          correlationId: identity.correlationId,
          jobId: identity.jobId,
          jobKind: identity.jobKind,
          attempt: identity.attempt,
          maxAttempts: identity.maxAttempts,
          workerId: identity.workerId,
          slotId: identity.slotId
        });
        return;
      }
      case 'job_succeeded': {
        const { identity } = observation;
        if (Object.hasOwn(identity, 'generation')) {
          options.logger.emit({
            event: 'job.succeeded',
            correlationId: identity.correlationId,
            jobId: identity.jobId,
            jobKind: identity.jobKind,
            attempt: identity.attempt,
            workerId: identity.workerId,
            slotId: identity.slotId,
            durationMs: observation.durationMs,
            generation: identity.generation!
          });
          return;
        }
        options.logger.emit({
          event: 'job.succeeded',
          correlationId: identity.correlationId,
          jobId: identity.jobId,
          jobKind: identity.jobKind,
          attempt: identity.attempt,
          workerId: identity.workerId,
          slotId: identity.slotId,
          durationMs: observation.durationMs
        });
        return;
      }
      case 'job_failed': {
        const { identity } = observation;
        if (Object.hasOwn(identity, 'generation')) {
          options.logger.emit({
            event: 'job.failed',
            correlationId: identity.correlationId,
            jobId: identity.jobId,
            jobKind: identity.jobKind,
            attempt: identity.attempt,
            maxAttempts: identity.maxAttempts,
            workerId: identity.workerId,
            slotId: identity.slotId,
            code: observation.code,
            durationMs: observation.durationMs,
            retryScheduled: observation.retryScheduled,
            generation: identity.generation!
          });
          return;
        }
        options.logger.emit({
          event: 'job.failed',
          correlationId: identity.correlationId,
          jobId: identity.jobId,
          jobKind: identity.jobKind,
          attempt: identity.attempt,
          maxAttempts: identity.maxAttempts,
          workerId: identity.workerId,
          slotId: identity.slotId,
          code: observation.code,
          durationMs: observation.durationMs,
          retryScheduled: observation.retryScheduled
        });
        return;
      }
      case 'job_lease_lost': {
        const { identity } = observation;
        if (Object.hasOwn(identity, 'generation')) {
          options.logger.emit({
            event: 'job.lease_lost',
            correlationId: identity.correlationId,
            jobId: identity.jobId,
            jobKind: identity.jobKind,
            attempt: identity.attempt,
            workerId: identity.workerId,
            slotId: identity.slotId,
            code: observation.code,
            generation: identity.generation!
          });
          return;
        }
        options.logger.emit({
          event: 'job.lease_lost',
          correlationId: identity.correlationId,
          jobId: identity.jobId,
          jobKind: identity.jobKind,
          attempt: identity.attempt,
          workerId: identity.workerId,
          slotId: identity.slotId,
          code: observation.code
        });
        return;
      }
      default:
        throw new TypeError('invalid runner observation');
    }
  };
}
