import { createHash, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { VerifiedStripeEvent } from './stripe/types';
import { permanentStripeFailure } from './stripe/errors';
import { parseVerifiedStripeEvent } from './stripe/schemas';
import type { Database } from '$lib/server/db/client';
import { stripeEvents, type StripeEventRow } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import {
  enqueueJob as defaultEnqueueJob,
  rearmExhaustedJob
} from '$lib/server/jobs/repository';
import {
  STRIPE_EVENT_JOB,
  STRIPE_EVENT_JOB_MAX_ATTEMPTS,
  createStripeEventJobPayload
} from './job';

export const SUPPORTED_STRIPE_EVENT_TYPES = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
  'payout.created',
  'payout.updated',
  'payout.paid',
  'payout.failed',
  'payout.canceled',
  'payout.reconciliation_completed'
] as const);

export type SupportedStripeEventType = typeof SUPPORTED_STRIPE_EVENT_TYPES[number];
export type StripeObjectFamily = 'checkout_session' | 'refund' | 'dispute' | 'payout';
export type StripeRetrievalMethod =
  | 'retrieveCheckoutSession'
  | 'retrieveRefund'
  | 'retrieveDispute'
  | 'retrievePayout';

export interface SupportedStripeEventDescriptor {
  event: VerifiedStripeEvent;
  objectFamily: StripeObjectFamily;
  retrievalMethod: StripeRetrievalMethod;
}

const supportedTypes = new Set<string>(SUPPORTED_STRIPE_EVENT_TYPES);

function familyForType(type: SupportedStripeEventType): {
  objectFamily: StripeObjectFamily;
  retrievalMethod: StripeRetrievalMethod;
  objectPrefix: string;
} {
  if (type.startsWith('checkout.')) {
    return {
      objectFamily: 'checkout_session',
      retrievalMethod: 'retrieveCheckoutSession',
      objectPrefix: 'cs_'
    };
  }
  if (type.startsWith('refund.')) {
    return { objectFamily: 'refund', retrievalMethod: 'retrieveRefund', objectPrefix: 're_' };
  }
  if (type.startsWith('charge.dispute.')) {
    return { objectFamily: 'dispute', retrievalMethod: 'retrieveDispute', objectPrefix: 'dp_' };
  }
  return { objectFamily: 'payout', retrievalMethod: 'retrievePayout', objectPrefix: 'po_' };
}

function isSupportedType(type: string): type is SupportedStripeEventType {
  return supportedTypes.has(type);
}

export function describeSupportedStripeEvent(
  value: VerifiedStripeEvent
): SupportedStripeEventDescriptor | null {
  const event = parseVerifiedStripeEvent({
    providerEventId: value.providerEventId,
    type: value.type,
    objectId: value.objectId,
    liveMode: value.liveMode,
    apiVersion: value.apiVersion,
    providerCreatedAt: value.providerCreatedAt,
    rawBodySha256: value.rawBodySha256
  });
  if (!isSupportedType(event.type)) return null;
  const mapping = familyForType(event.type);
  if (!event.objectId.startsWith(mapping.objectPrefix)) throw permanentStripeFailure();
  return {
    event,
    objectFamily: mapping.objectFamily,
    retrievalMethod: mapping.retrievalMethod
  };
}

export type AcceptStripeEventResult =
  | { status: 'accepted' | 'duplicate'; stripeEventId: string }
  | { status: 'conflict'; stripeEventId: string };

export interface AcceptStripeEventDependencies {
  enqueueJob: typeof defaultEnqueueJob;
}

const defaultDependencies: AcceptStripeEventDependencies = {
  enqueueJob: defaultEnqueueJob
};

function immutableDigest(value: {
  providerEventId: string;
  type: string;
  objectId: string;
  liveMode: boolean;
  apiVersion: string | null;
  providerCreatedAt: Date;
  rawBodySha256: string;
}): Buffer {
  return createHash('sha256').update(JSON.stringify([
    value.providerEventId,
    value.type,
    value.objectId,
    value.liveMode,
    value.apiVersion,
    value.providerCreatedAt.toISOString(),
    value.rawBodySha256
  ])).digest();
}

function rowDigest(value: StripeEventRow): Buffer {
  return immutableDigest({
    providerEventId: value.providerEventId,
    type: value.eventType,
    objectId: value.objectId,
    liveMode: value.liveMode,
    apiVersion: value.apiVersion,
    providerCreatedAt: value.providerCreatedAt,
    rawBodySha256: value.rawBodySha256
  });
}

async function enqueueStripeEventJob(
  database: DatabaseExecutor,
  stripeEventId: string,
  providerEventId: string,
  dependencies: AcceptStripeEventDependencies
): Promise<void> {
  await dependencies.enqueueJob(database, {
    type: STRIPE_EVENT_JOB,
    payload: createStripeEventJobPayload(stripeEventId),
    deduplicationKey: `stripe:event:${providerEventId}`,
    maxAttempts: STRIPE_EVENT_JOB_MAX_ATTEMPTS
  });
}

async function rearmStripeEventJob(
  database: DatabaseExecutor,
  stripeEventId: string,
  providerEventId: string
): Promise<void> {
  await rearmExhaustedJob(database, {
    type: STRIPE_EVENT_JOB,
    payload: createStripeEventJobPayload(stripeEventId),
    deduplicationKey: `stripe:event:${providerEventId}`,
    maxAttempts: STRIPE_EVENT_JOB_MAX_ATTEMPTS
  });
}

export async function acceptStripeEvent(
  database: Database,
  value: VerifiedStripeEvent,
  dependencies: AcceptStripeEventDependencies = defaultDependencies
): Promise<AcceptStripeEventResult> {
  const descriptor = describeSupportedStripeEvent(value);
  if (!descriptor) throw permanentStripeFailure();
  const event = descriptor.event;
  return database.transaction(async (transaction) => {
    const [inserted] = await transaction
      .insert(stripeEvents)
      .values({
        providerEventId: event.providerEventId,
        eventType: event.type,
        objectId: event.objectId,
        liveMode: event.liveMode,
        apiVersion: event.apiVersion,
        providerCreatedAt: event.providerCreatedAt,
        rawBodySha256: event.rawBodySha256,
        status: 'pending',
        processedAt: null
      })
      .onConflictDoNothing({ target: stripeEvents.providerEventId })
      .returning();
    if (inserted) {
      await enqueueStripeEventJob(
        transaction,
        inserted.id,
        inserted.providerEventId,
        dependencies
      );
      return { status: 'accepted', stripeEventId: inserted.id };
    }

    const [existing] = await transaction
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.providerEventId, event.providerEventId))
      .limit(1)
      .for('update');
    if (!existing) throw permanentStripeFailure();
    const exact = timingSafeEqual(rowDigest(existing), immutableDigest(event));
    if (!exact) return { status: 'conflict', stripeEventId: existing.id };
    if (existing.status === 'pending') {
      await rearmStripeEventJob(transaction, existing.id, existing.providerEventId);
    }
    return { status: 'duplicate', stripeEventId: existing.id };
  });
}
