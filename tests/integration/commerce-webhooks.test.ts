import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { STRIPE_EVENT_JOB } from '$lib/server/commerce/job';
import { acceptStripeEvent } from '$lib/server/commerce/webhooks';
import type { VerifiedStripeEvent } from '$lib/server/commerce/stripe/types';
import { auditEvents, jobs, stripeEvents } from '$lib/server/db/schema';
import { createPostgresJobRepository, enqueueJob } from '$lib/server/jobs/repository';
import { applicationConfig, databaseClient } from './database';

function event(overrides: Partial<VerifiedStripeEvent> = {}): VerifiedStripeEvent {
  const suffix = randomUUID().replaceAll('-', '');
  return {
    providerEventId: `evt_test_${suffix}`,
    type: 'checkout.session.completed',
    objectId: `cs_test_${suffix}`,
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: new Date('2026-08-10T12:00:00.000Z'),
    rawBodySha256: 'a'.repeat(64),
    ...overrides
  };
}

async function eventJob(providerEventId: string) {
  const [job] = await databaseClient.db.select().from(jobs)
    .where(eq(jobs.deduplicationKey, `stripe:event:${providerEventId}`));
  if (!job) throw new Error('Expected Stripe event job');
  return job;
}

async function exhaustEventJob(providerEventId: string) {
  const queued = await eventJob(providerEventId);
  await databaseClient.db.update(jobs)
    .set({ maxAttempts: 2 })
    .where(eq(jobs.id, queued.id));

  let currentTime = new Date('2099-01-01T00:00:00.000Z');
  const repository = createPostgresJobRepository(
    databaseClient.db,
    applicationConfig.jobs,
    () => currentTime
  );
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const claimed = await repository.claimNext(`stripe-test-worker-${attempt}`);
    expect(claimed).toMatchObject({ id: queued.id, attempts: attempt, maxAttempts: 2 });
    await repository.fail(
      queued.id,
      `stripe-test-worker-${attempt}`,
      'forced transient Stripe outage',
      true
    );
    currentTime = (await eventJob(providerEventId)).runAt;
  }
  const failed = await eventJob(providerEventId);
  expect(failed).toMatchObject({
    id: queued.id,
    status: 'failed',
    attempts: 2,
    maxAttempts: 2,
    lastError: 'forced transient Stripe outage'
  });
  return failed;
}

describe('atomic Stripe event acceptance', () => {
  it('persists one minimized event and one deduplicated job in one transaction', async () => {
    const source = event();
    const result = await acceptStripeEvent(databaseClient.db, source);
    expect(result).toMatchObject({ status: 'accepted', stripeEventId: expect.any(String) });

    const [stored] = await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.providerEventId, source.providerEventId));
    expect(stored).toMatchObject({
      providerEventId: source.providerEventId,
      eventType: source.type,
      objectId: source.objectId,
      liveMode: false,
      apiVersion: source.apiVersion,
      rawBodySha256: source.rawBodySha256,
      status: 'pending'
    });
    const queued = await databaseClient.db.select().from(jobs)
      .where(eq(jobs.deduplicationKey, `stripe:event:${source.providerEventId}`));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: STRIPE_EVENT_JOB,
      payload: { stripeEventId: stored!.id },
      status: 'pending',
      maxAttempts: 12
    });
    const serialized = JSON.stringify({ stored, queued });
    expect(serialized).not.toMatch(/customer_email|4242|signature|"rawBody"|@example/iu);
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.resourceId, stored!.id))).toHaveLength(0);
  });

  it('acknowledges exact duplicate deliveries without a second row or job', async () => {
    const source = event();
    const first = await acceptStripeEvent(databaseClient.db, source);
    const duplicate = await acceptStripeEvent(databaseClient.db, source);
    expect(duplicate).toEqual({ status: 'duplicate', stripeEventId: first.stripeEventId });
    expect(await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.providerEventId, source.providerEventId))).toHaveLength(1);
    expect(await databaseClient.db.select().from(jobs)
      .where(eq(jobs.deduplicationKey, `stripe:event:${source.providerEventId}`))).toHaveLength(1);
  });

  it('rearms one exhausted matching job when Stripe redelivers the exact pending event', async () => {
    const source = event();
    const accepted = await acceptStripeEvent(databaseClient.db, source);
    const failed = await exhaustEventJob(source.providerEventId);
    const [evidenceBefore] = await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, accepted.stripeEventId));

    await expect(acceptStripeEvent(databaseClient.db, source)).resolves.toEqual({
      status: 'duplicate',
      stripeEventId: accepted.stripeEventId
    });

    expect(await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, accepted.stripeEventId))).toEqual([evidenceBefore]);
    expect(await eventJob(source.providerEventId)).toMatchObject({
      id: failed.id,
      type: STRIPE_EVENT_JOB,
      payload: { stripeEventId: accepted.stripeEventId },
      deduplicationKey: `stripe:event:${source.providerEventId}`,
      status: 'pending',
      attempts: 0,
      maxAttempts: 12,
      lastError: 'forced transient Stripe outage',
      completedAt: null
    });
    expect(await databaseClient.db.select().from(jobs)
      .where(eq(jobs.deduplicationKey, `stripe:event:${source.providerEventId}`))).toHaveLength(1);
  });

  it.each(['processed', 'exception'] as const)(
    'does not rearm an exhausted job for an exact %s event',
    async (status) => {
      const source = event();
      const accepted = await acceptStripeEvent(databaseClient.db, source);
      const failed = await exhaustEventJob(source.providerEventId);
      await databaseClient.db.update(stripeEvents)
        .set({ status, processedAt: new Date('2099-01-02T00:00:00.000Z') })
        .where(eq(stripeEvents.id, accepted.stripeEventId));

      await expect(acceptStripeEvent(databaseClient.db, source)).resolves.toEqual({
        status: 'duplicate',
        stripeEventId: accepted.stripeEventId
      });
      expect(await eventJob(source.providerEventId)).toEqual(failed);
    }
  );

  it('does not rearm an exhausted job whose identity does not match the event', async () => {
    const source = event();
    await acceptStripeEvent(databaseClient.db, source);
    const failed = await exhaustEventJob(source.providerEventId);
    await databaseClient.db.update(jobs)
      .set({ type: 'test.not-a-stripe-event' })
      .where(eq(jobs.id, failed.id));
    const mismatched = await eventJob(source.providerEventId);

    await expect(acceptStripeEvent(databaseClient.db, source)).resolves.toMatchObject({
      status: 'duplicate'
    });
    expect(await eventJob(source.providerEventId)).toEqual(mismatched);
  });

  it('rolls the event back when job insertion fails so a Stripe retry can recover', async () => {
    const source = event();
    await expect(acceptStripeEvent(databaseClient.db, source, {
      enqueueJob: async (database, input) => {
        await enqueueJob(database, input);
        throw new Error('forced job failure');
      }
    })).rejects.toThrow('forced job failure');
    expect(await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.providerEventId, source.providerEventId))).toHaveLength(0);
    expect(await databaseClient.db.select().from(jobs)
      .where(eq(jobs.deduplicationKey, `stripe:event:${source.providerEventId}`))).toHaveLength(0);

    await expect(acceptStripeEvent(databaseClient.db, source)).resolves.toMatchObject({
      status: 'accepted'
    });
  });

  it('converges concurrent duplicate deliveries to one event and one job', async () => {
    const source = event();
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => acceptStripeEvent(databaseClient.db, source))
    );
    expect(outcomes.filter((outcome) => outcome.status === 'accepted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'duplicate')).toHaveLength(9);
    expect(new Set(outcomes.map((outcome) => outcome.stripeEventId)).size).toBe(1);
    expect(await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.providerEventId, source.providerEventId))).toHaveLength(1);
    expect(await databaseClient.db.select().from(jobs)
      .where(and(
        eq(jobs.type, STRIPE_EVENT_JOB),
        eq(jobs.deduplicationKey, `stripe:event:${source.providerEventId}`)
      ))).toHaveLength(1);
  });

  it('acknowledges conflicting duplicate IDs without overwriting accepted evidence', async () => {
    const source = event();
    const accepted = await acceptStripeEvent(databaseClient.db, source);
    const failed = await exhaustEventJob(source.providerEventId);
    const conflict = await acceptStripeEvent(databaseClient.db, {
      ...source,
      objectId: `cs_test_${randomUUID().replaceAll('-', '')}`,
      rawBodySha256: 'b'.repeat(64)
    });
    expect(conflict).toEqual({ status: 'conflict', stripeEventId: accepted.stripeEventId });
    const [stored] = await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.providerEventId, source.providerEventId));
    expect(stored).toMatchObject({
      objectId: source.objectId,
      rawBodySha256: source.rawBodySha256
    });
    expect(await databaseClient.db.select().from(jobs)
      .where(eq(jobs.deduplicationKey, `stripe:event:${source.providerEventId}`))).toEqual([failed]);
  });
});
