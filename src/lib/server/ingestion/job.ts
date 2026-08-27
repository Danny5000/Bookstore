import { z } from 'zod';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import {
  INGEST_REVISION_JOB,
  INGEST_REVISION_JOB_MAX_ATTEMPTS
} from '$lib/server/jobs/catalog';
import { enqueueJobReference } from '$lib/server/jobs/repository';

export { INGEST_REVISION_JOB } from '$lib/server/jobs/catalog';

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
  return enqueueJobReference(database, {
    type: INGEST_REVISION_JOB,
    payload,
    deduplicationKey: `catalog.ingest:${revisionId}:${generation}`,
    maxAttempts: INGEST_REVISION_JOB_MAX_ATTEMPTS
  });
}
