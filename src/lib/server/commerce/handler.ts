import { eq } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import { stripeEvents, type StripeEventRow } from '$lib/server/db/schema';
import { PermanentJobError } from '$lib/server/jobs/runner';
import type { JobHandler } from '$lib/server/jobs/types';
import { PermanentCommerceError } from './errors';
import { parseStripeEventJobPayload } from './job';
import type {
  CheckoutSnapshot,
  DisputeSnapshot,
  PaymentSnapshot,
  RefundSnapshot,
  StripeCommerceGateway,
  VerifiedStripeEvent
} from './stripe/types';
import { describeSupportedStripeEvent } from './webhooks';

export interface CheckoutFulfillmentInput {
  stripeEventId: string;
  session: CheckoutSnapshot;
  payment: PaymentSnapshot | null;
}

export interface RefundFulfillmentInput {
  stripeEventId: string;
  refund: RefundSnapshot;
  payment: PaymentSnapshot;
}

export interface DisputeFulfillmentInput {
  stripeEventId: string;
  dispute: DisputeSnapshot;
}

export interface FulfillmentExceptionInput {
  stripeEventId: string;
  orderId: string | null;
}

export interface StripeEventHandlerDependencies {
  loadStripeEvent(database: Database, stripeEventId: string): Promise<StripeEventRow | null>;
  fulfillCheckout(database: Database, input: CheckoutFulfillmentInput): Promise<void>;
  fulfillRefund(database: Database, input: RefundFulfillmentInput): Promise<void>;
  fulfillDispute(database: Database, input: DisputeFulfillmentInput): Promise<void>;
  recordException(database: Database, input: FulfillmentExceptionInput): Promise<void>;
}

async function loadStripeEvent(
  database: Database,
  stripeEventId: string
): Promise<StripeEventRow | null> {
  const [event] = await database
    .select()
    .from(stripeEvents)
    .where(eq(stripeEvents.id, stripeEventId))
    .limit(1);
  return event ?? null;
}

function verifiedEvent(row: StripeEventRow): VerifiedStripeEvent {
  return {
    providerEventId: row.providerEventId,
    type: row.eventType,
    objectId: row.objectId,
    liveMode: row.liveMode,
    apiVersion: row.apiVersion,
    providerCreatedAt: row.providerCreatedAt,
    rawBodySha256: row.rawBodySha256
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Stripe event handling was aborted.', 'AbortError');
}

function parseJob(jobPayload: unknown): { stripeEventId: string } {
  try {
    return parseStripeEventJobPayload(jobPayload);
  } catch {
    throw new PermanentJobError('Invalid Stripe event job payload.');
  }
}

export function createStripeEventHandler(
  database: Database,
  gateway: StripeCommerceGateway,
  dependencies: StripeEventHandlerDependencies
): JobHandler {
  return async (job, signal) => {
    const { stripeEventId } = parseJob(job.payload);
    throwIfAborted(signal);
    const row = await dependencies.loadStripeEvent(database, stripeEventId);
    if (!row) throw new PermanentJobError('Stripe event no longer exists.');
    if (row.status !== 'pending') return;

    let orderId: string | null = null;
    try {
      const descriptor = describeSupportedStripeEvent(verifiedEvent(row));
      if (!descriptor) throw new PermanentCommerceError();
      throwIfAborted(signal);

      if (descriptor.objectFamily === 'checkout_session') {
        const session = await gateway.retrieveCheckoutSession(row.objectId);
        orderId = session.metadataOrderId;
        throwIfAborted(signal);
        const payment = session.paymentIntentId === null
          ? null
          : await gateway.retrievePayment(session.paymentIntentId);
        throwIfAborted(signal);
        await dependencies.fulfillCheckout(database, { stripeEventId, session, payment });
        return;
      }
      if (descriptor.objectFamily === 'refund') {
        const refund = await gateway.retrieveRefund(row.objectId);
        throwIfAborted(signal);
        const payment = await gateway.retrievePayment(refund.paymentIntentId);
        throwIfAborted(signal);
        await dependencies.fulfillRefund(database, { stripeEventId, refund, payment });
        return;
      }
      const dispute = await gateway.retrieveDispute(row.objectId);
      throwIfAborted(signal);
      await dependencies.fulfillDispute(database, { stripeEventId, dispute });
    } catch (error) {
      if (!(error instanceof PermanentCommerceError)) throw error;
      await dependencies.recordException(database, { stripeEventId, orderId });
    }
  };
}

export const defaultLoadStripeEvent = loadStripeEvent;
