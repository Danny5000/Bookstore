import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  STRIPE_EVENT_JOB,
  STRIPE_EVENT_JOB_MAX_ATTEMPTS
} from '$lib/server/commerce/job';
import { fulfillPayoutEvent } from '$lib/server/commerce/handler';
import { queueFinancialPayoutFromEvent } from '$lib/server/commerce/financial/event-handoff';
import { FINANCIAL_PAYOUT_JOB } from '$lib/server/commerce/financial/jobs';
import { acceptStripeEvent } from '$lib/server/commerce/webhooks';
import type { VerifiedStripeEvent } from '$lib/server/commerce/stripe/types';
import { auditEvents, jobs, stripeEvents } from '$lib/server/db/schema';
import { createPostgresJobRepository, enqueueJob } from '$lib/server/jobs/repository';
import { applicationConfig, databaseClient, workerDatabaseClient } from './database';

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
  let currentTime = new Date('2099-01-01T00:00:00.000Z');
  const repository = createPostgresJobRepository(
    workerDatabaseClient.db,
    applicationConfig.jobs,
    () => currentTime
  );
  for (let attempt = 1; attempt <= STRIPE_EVENT_JOB_MAX_ATTEMPTS; attempt += 1) {
    const claimed = await repository.claimNext(`stripe-test-worker-${attempt}`);
    expect(claimed).toMatchObject({
      id: queued.id,
      attempts: attempt,
      maxAttempts: STRIPE_EVENT_JOB_MAX_ATTEMPTS
    });
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
    attempts: STRIPE_EVENT_JOB_MAX_ATTEMPTS,
    maxAttempts: STRIPE_EVENT_JOB_MAX_ATTEMPTS,
    lastError: 'forced transient Stripe outage'
  });
  return failed;
}

describe('atomic Stripe event acceptance', () => {
  it('completes a payout event and enqueues its financial root atomically without retrieval', async () => {
    const source = event({
      type: 'payout.reconciliation_completed',
      objectId: `po_test_${randomUUID().replaceAll('-', '')}`
    });
    const accepted = await acceptStripeEvent(databaseClient.db, source);

    await fulfillPayoutEvent(workerDatabaseClient.db, {
      stripeEventId: accepted.stripeEventId,
      providerPayoutId: source.objectId,
      providerEventId: source.providerEventId
    });

    const [stored] = await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, accepted.stripeEventId));
    expect(stored).toMatchObject({ status: 'processed', processedAt: expect.any(Date) });
    const financial = await databaseClient.db.select().from(jobs)
      .where(eq(jobs.deduplicationKey,
        `stripe:financial-payout:event:${source.providerEventId}`));
    expect(financial).toHaveLength(1);
    expect(financial[0]).toMatchObject({
      type: FINANCIAL_PAYOUT_JOB,
      payload: {
        providerPayoutId: source.objectId,
        trigger: { kind: 'event', providerEventId: source.providerEventId }
      },
      status: 'pending'
    });
  });

  it('rolls payout completion and its financial job back when queueing fails', async () => {
    const source = event({
      type: 'payout.updated',
      objectId: `po_test_${randomUUID().replaceAll('-', '')}`
    });
    const accepted = await acceptStripeEvent(databaseClient.db, source);

    await expect(fulfillPayoutEvent(workerDatabaseClient.db, {
      stripeEventId: accepted.stripeEventId,
      providerPayoutId: source.objectId,
      providerEventId: source.providerEventId
    }, {
      queueFinancialPayout: async (transaction, input) => {
        await queueFinancialPayoutFromEvent(transaction, input);
        throw new Error('forced payout handoff rollback');
      }
    })).rejects.toThrow('forced payout handoff rollback');

    const [stored] = await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, accepted.stripeEventId));
    expect(stored).toMatchObject({ status: 'pending', processedAt: null });
    expect(await databaseClient.db.select().from(jobs)
      .where(eq(jobs.deduplicationKey,
        `stripe:financial-payout:event:${source.providerEventId}`))).toHaveLength(0);
  });

  it('keeps the same terminal financial root on payout event replay', async () => {
    const source = event({
      type: 'payout.paid',
      objectId: `po_test_${randomUUID().replaceAll('-', '')}`
    });
    const accepted = await acceptStripeEvent(databaseClient.db, source);
    const input = {
      stripeEventId: accepted.stripeEventId,
      providerPayoutId: source.objectId,
      providerEventId: source.providerEventId
    };
    await fulfillPayoutEvent(workerDatabaseClient.db, input);
    const key = `stripe:financial-payout:event:${source.providerEventId}`;
    const [financial] = await databaseClient.db.select().from(jobs)
      .where(eq(jobs.deduplicationKey, key));
    if (!financial) throw new Error('Expected financial payout job');
    const completedAt = new Date('2099-01-02T00:00:00.000Z');
    await workerDatabaseClient.db.update(jobs)
      .set({ status: 'succeeded', completedAt })
      .where(eq(jobs.id, financial.id));

    await fulfillPayoutEvent(workerDatabaseClient.db, input);
    await expect(acceptStripeEvent(databaseClient.db, source)).resolves.toEqual({
      status: 'duplicate', stripeEventId: accepted.stripeEventId
    });

    expect(await databaseClient.db.select().from(jobs)
      .where(eq(jobs.deduplicationKey, key))).toEqual([{
        ...financial,
        status: 'succeeded',
        completedAt
      }]);
  });

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
      lastError: null,
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
      await workerDatabaseClient.db.update(stripeEvents)
        .set({ status, processedAt: new Date('2099-01-02T00:00:00.000Z') })
        .where(eq(stripeEvents.id, accepted.stripeEventId));

      await expect(acceptStripeEvent(databaseClient.db, source)).resolves.toEqual({
        status: 'duplicate',
        stripeEventId: accepted.stripeEventId
      });
      expect(await eventJob(source.providerEventId)).toEqual(failed);
    }
  );

  it('rejects an exhausted job whose identity does not match the event', async () => {
    const source = event();
    await acceptStripeEvent(databaseClient.db, source);
    const failed = await exhaustEventJob(source.providerEventId);
    await workerDatabaseClient.db.update(jobs)
      .set({ type: 'test.not-a-stripe-event' })
      .where(eq(jobs.id, failed.id));
    const mismatched = await eventJob(source.providerEventId);

    await expect(acceptStripeEvent(databaseClient.db, source))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: '55000' }) });
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
