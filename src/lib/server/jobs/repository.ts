import { and, eq, gte, sql } from 'drizzle-orm';
import type { JobConfig } from '$lib/server/config/schema';
import type { Database } from '$lib/server/db/client';
import { jobs, type JsonObject, type JobRow } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { withTransaction } from '$lib/server/db/transaction';
import { computeRetryDelayMs } from './backoff';
import type { JobRecord, JobRepository } from './types';

export interface EnqueueJobInput {
  type: string;
  payload: JsonObject;
  deduplicationKey?: string | null;
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueueJob(
  database: DatabaseExecutor,
  input: EnqueueJobInput
): Promise<JobRow> {
  const [inserted] = await database
    .insert(jobs)
    .values({
      type: input.type,
      payload: input.payload,
      deduplicationKey: input.deduplicationKey ?? null,
      runAt: input.runAt,
      maxAttempts: input.maxAttempts ?? 5
    })
    .onConflictDoNothing({ target: jobs.deduplicationKey })
    .returning();

  if (inserted) return inserted;
  if (!input.deduplicationKey) throw new Error('Job insert returned no row');

  const [existing] = await database
    .select()
    .from(jobs)
    .where(eq(jobs.deduplicationKey, input.deduplicationKey))
    .limit(1);
  if (!existing) throw new Error('Deduplicated job could not be loaded');
  return existing;
}

export interface RearmExhaustedJobInput {
  type: string;
  payload: JsonObject;
  deduplicationKey: string;
  maxAttempts: number;
}

export async function rearmExhaustedJob(
  database: DatabaseExecutor,
  input: RearmExhaustedJobInput
): Promise<JobRow | null> {
  const [rearmed] = await database
    .update(jobs)
    .set({
      status: 'pending',
      attempts: 0,
      maxAttempts: input.maxAttempts,
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(jobs.type, input.type),
        eq(jobs.payload, input.payload),
        eq(jobs.deduplicationKey, input.deduplicationKey),
        eq(jobs.status, 'failed'),
        gte(jobs.attempts, jobs.maxAttempts)
      )
    )
    .returning();
  return rearmed ?? null;
}

interface ClaimedJobRow extends Record<string, unknown> {
  id: string;
  type: string;
  payload: JsonObject;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
}

export function createPostgresJobRepository(
  database: Database,
  config: JobConfig,
  now: () => Date = () => new Date()
): JobRepository {
  return {
    async claimNext(workerId): Promise<JobRecord | null> {
      const claimedAt = now();
      const expiredBefore = new Date(claimedAt.getTime() - config.leaseMs);
      const result = await database.execute<ClaimedJobRow>(sql`
        with exhausted as (
          update jobs
          set status = 'failed',
              locked_at = null,
              locked_by = null,
              last_error = coalesce(last_error, 'Job lease expired after final attempt'),
              completed_at = ${claimedAt},
              updated_at = ${claimedAt}
          where status = 'running'
            and locked_at <= ${expiredBefore}
            and attempts >= max_attempts
          returning id
        ), candidate as (
          select id
          from jobs
          where (
              status = 'pending'
              and run_at <= ${claimedAt}
              and attempts < max_attempts
            ) or (
              status = 'running'
              and locked_at <= ${expiredBefore}
              and attempts < max_attempts
            )
          order by run_at asc, created_at asc
          for update skip locked
          limit 1
        )
        update jobs
        set status = 'running',
            attempts = jobs.attempts + 1,
            locked_at = ${claimedAt},
            locked_by = ${workerId},
            updated_at = ${claimedAt}
        from candidate
        where jobs.id = candidate.id
        returning jobs.id,
                  jobs.type,
                  jobs.payload,
                  jobs.attempts,
                  jobs.max_attempts as "maxAttempts",
                  jobs.locked_by as "lockedBy"
      `);
      return result.rows[0] ?? null;
    },

    async renewLease(jobId, workerId): Promise<boolean> {
      const renewedAt = now();
      const [renewed] = await database
        .update(jobs)
        .set({ lockedAt: renewedAt, updatedAt: renewedAt })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, 'running'),
            eq(jobs.lockedBy, workerId)
          )
        )
        .returning({ id: jobs.id });
      return renewed !== undefined;
    },

    async complete(jobId, workerId): Promise<boolean> {
      const completedAt = now();
      const [completed] = await database
        .update(jobs)
        .set({
          status: 'succeeded',
          completedAt,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          updatedAt: completedAt
        })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, 'running'),
            eq(jobs.lockedBy, workerId)
          )
        )
        .returning({ id: jobs.id });
      return completed !== undefined;
    },

    async fail(jobId, workerId, safeError, retryable): Promise<boolean> {
      return withTransaction(database, async (transaction) => {
        const [job] = await transaction
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.id, jobId),
              eq(jobs.status, 'running'),
              eq(jobs.lockedBy, workerId)
            )
          )
          .for('update')
          .limit(1);
        if (!job) return false;

        const failedAt = now();
        const exhausted = !retryable || job.attempts >= job.maxAttempts;
        const retryDelay = computeRetryDelayMs(
          job.attempts,
          config.retryBaseMs,
          config.retryMaxMs
        );

        await transaction
          .update(jobs)
          .set({
            status: exhausted ? 'failed' : 'pending',
            runAt: exhausted ? job.runAt : new Date(failedAt.getTime() + retryDelay),
            lockedAt: null,
            lockedBy: null,
            lastError: safeError.slice(0, 1000),
            completedAt: exhausted ? failedAt : null,
            updatedAt: failedAt
          })
          .where(eq(jobs.id, job.id));
        return true;
      });
    }
  };
}
