import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs } from '$lib/server/db/schema';
import { enqueueJob, createPostgresJobRepository } from '$lib/server/jobs/repository';
import { applicationConfig, databaseClient } from './database';

describe('PostgreSQL jobs', () => {
  it('deduplicates enqueue by key', async () => {
    const first = await enqueueJob(databaseClient.db, {
      type: 'test.one',
      payload: { value: 1 },
      deduplicationKey: 'same-key'
    });
    const second = await enqueueJob(databaseClient.db, {
      type: 'test.one',
      payload: { value: 2 },
      deduplicationKey: 'same-key'
    });
    expect(second.id).toBe(first.id);
  });

  it('uses skip locked so two workers claim different jobs', async () => {
    await enqueueJob(databaseClient.db, { type: 'test.one', payload: { order: 1 } });
    await enqueueJob(databaseClient.db, { type: 'test.two', payload: { order: 2 } });
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs
    );

    const [first, second] = await Promise.all([
      repository.claimNext('worker-a'),
      repository.claimNext('worker-b')
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
  });

  it('reschedules a retry and eventually marks an exhausted job failed', async () => {
    let currentTime = new Date('2026-08-08T12:00:00.000Z');
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => currentTime
    );
    const queued = await enqueueJob(databaseClient.db, {
      type: 'test.retry',
      payload: {},
      runAt: currentTime,
      maxAttempts: 2
    });

    const first = await repository.claimNext('worker-a');
    expect(first?.attempts).toBe(1);
    await repository.fail(queued.id, 'worker-a', 'safe transient failure', true);

    const [pending] = await databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id));
    expect(pending).toMatchObject({ status: 'pending', attempts: 1 });

    currentTime = new Date('2026-08-08T12:00:01.000Z');
    const second = await repository.claimNext('worker-b');
    expect(second?.attempts).toBe(2);
    await repository.fail(queued.id, 'worker-b', 'safe transient failure', true);

    const [failed] = await databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id));
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'safe transient failure'
    });
  });

  it('reclaims an expired lease and fails it after the final crashed attempt', async () => {
    let currentTime = new Date('2026-08-08T12:00:00.000Z');
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => currentTime
    );
    const queued = await enqueueJob(databaseClient.db, {
      type: 'test.crash',
      payload: {},
      runAt: currentTime,
      maxAttempts: 2
    });

    expect((await repository.claimNext('worker-a'))?.attempts).toBe(1);
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);
    expect((await repository.claimNext('worker-b'))?.attempts).toBe(2);
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);
    await expect(repository.claimNext('worker-c')).resolves.toBeNull();

    const [failed] = await databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id));
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'Job lease expired after final attempt'
    });
  });
});
