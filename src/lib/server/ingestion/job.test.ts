import { describe, expect, it, vi } from 'vitest';
import type { DatabaseExecutor } from '$lib/server/db/transaction';

const { enqueueJob } = vi.hoisted(() => ({ enqueueJob: vi.fn() }));

vi.mock('$lib/server/jobs/repository', () => ({ enqueueJob }));

import {
  enqueueRevisionIngestion,
  INGEST_REVISION_JOB,
  parseRevisionIngestionPayload
} from './job';

const revisionId = '018f0000-0000-7000-8000-000000000001';

describe('revision ingestion jobs', () => {
  it('strictly parses the minimal versioned payload', () => {
    expect(parseRevisionIngestionPayload({ revisionId, generation: 0 })).toEqual({
      revisionId,
      generation: 0
    });
    expect(() =>
      parseRevisionIngestionPayload({ revisionId, generation: 0, storageKey: 'private/value' })
    ).toThrow();
    expect(() => parseRevisionIngestionPayload({ revisionId, generation: -1 })).toThrow();
  });

  it('enqueues a deterministic, deduplicated job', async () => {
    const database = {} as DatabaseExecutor;
    enqueueJob.mockResolvedValueOnce({ id: 'job-id' });

    await expect(enqueueRevisionIngestion(database, revisionId, 3)).resolves.toEqual({
      id: 'job-id'
    });
    expect(enqueueJob).toHaveBeenCalledWith(database, {
      type: INGEST_REVISION_JOB,
      payload: { revisionId, generation: 3 },
      deduplicationKey: `catalog.ingest:${revisionId}:3`,
      maxAttempts: 5
    });
  });
});
