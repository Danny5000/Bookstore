import { z } from 'zod';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { enqueueJob } from '$lib/server/jobs/repository';

export const INGEST_REVISION_JOB = 'catalog.ingest_revision';

const revisionIngestionPayloadSchema = z.strictObject({
  revisionId: z.uuid(),
  generation: z.number().int().min(0)
});

export type RevisionIngestionPayload = z.infer<typeof revisionIngestionPayloadSchema>;

export function parseRevisionIngestionPayload(value: unknown): RevisionIngestionPayload {
  return revisionIngestionPayloadSchema.parse(value);
}

export function enqueueRevisionIngestion(
  database: DatabaseExecutor,
  revisionId: string,
  generation: number
) {
  const payload = parseRevisionIngestionPayload({ revisionId, generation });
  return enqueueJob(database, {
    type: INGEST_REVISION_JOB,
    payload,
    deduplicationKey: `catalog.ingest:${revisionId}:${generation}`,
    maxAttempts: 5
  });
}
