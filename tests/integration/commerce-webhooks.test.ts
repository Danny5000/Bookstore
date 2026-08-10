import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { STRIPE_EVENT_JOB } from '$lib/server/commerce/job';
import { acceptStripeEvent } from '$lib/server/commerce/webhooks';
import type { VerifiedStripeEvent } from '$lib/server/commerce/stripe/types';
import { auditEvents, jobs, stripeEvents } from '$lib/server/db/schema';
import { databaseClient } from './database';

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
      status: 'pending'
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

  it('rolls the event back when job insertion fails so a Stripe retry can recover', async () => {
    const source = event();
    await expect(acceptStripeEvent(databaseClient.db, source, {
      enqueueJob: async () => {
        throw new Error('forced job failure');
      }
    })).rejects.toThrow('forced job failure');
    expect(await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.providerEventId, source.providerEventId))).toHaveLength(0);

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
      .where(eq(jobs.deduplicationKey, `stripe:event:${source.providerEventId}`))).toHaveLength(1);
  });
});
