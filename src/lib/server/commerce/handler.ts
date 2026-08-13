import { and, eq } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import { stripeEvents, type StripeEventRow } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { PermanentJobError } from '$lib/server/jobs/runner';
import type { JobHandler } from '$lib/server/jobs/types';
import { PermanentCommerceError, RetryableProviderError } from './errors';
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
import { queueFinancialPayoutFromEvent } from './financial/event-handoff';

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
  payment: PaymentSnapshot;
}

export interface PayoutFulfillmentInput {
  stripeEventId: string;
  providerPayoutId: string;
  providerEventId: string;
}

export interface PayoutFulfillmentDependencies {
  queueFinancialPayout(
    transaction: DatabaseTransaction,
    input: { providerPayoutId: string; providerEventId: string }
  ): Promise<void>;
  now(): Date;
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
  fulfillPayout(database: Database, input: PayoutFulfillmentInput): Promise<void>;
  recordException(database: Database, input: FulfillmentExceptionInput): Promise<void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function exactPayoutInput(value: unknown): value is PayoutFulfillmentInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = ['providerEventId', 'providerPayoutId', 'stripeEventId'];
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)) ||
    !own.every((key) => typeof key === 'string' && keys.includes(key))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => descriptors[key] !== undefined &&
    Object.hasOwn(descriptors[key]!, 'value'));
}

function invalidPayout(): never {
  throw new PermanentCommerceError();
}

export async function fulfillPayoutEvent(
  database: Database,
  input: PayoutFulfillmentInput,
  dependencyOverrides: Partial<PayoutFulfillmentDependencies> = {}
): Promise<void> {
  let canonical: PayoutFulfillmentInput;
  try {
    if (!exactPayoutInput(input) || typeof input.stripeEventId !== 'string' ||
      !UUID_PATTERN.test(input.stripeEventId.toLowerCase()) ||
      typeof input.providerPayoutId !== 'string' ||
      !/^po_[A-Za-z0-9_-]{1,252}$/u.test(input.providerPayoutId) ||
      typeof input.providerEventId !== 'string' ||
      input.providerEventId.length < 4 || input.providerEventId.length > 255 ||
      !/^evt_[A-Za-z0-9_-]+$/u.test(input.providerEventId)) invalidPayout();
    canonical = {
      stripeEventId: input.stripeEventId.toLowerCase(),
      providerPayoutId: input.providerPayoutId,
      providerEventId: input.providerEventId
    };
  } catch {
    return invalidPayout();
  }
  const dependencies: PayoutFulfillmentDependencies = {
    queueFinancialPayout: dependencyOverrides.queueFinancialPayout ??
      queueFinancialPayoutFromEvent,
    now: dependencyOverrides.now ?? (() => new Date())
  };
  await database.transaction(async (transaction) => {
    const [event] = await transaction
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, canonical.stripeEventId))
      .limit(1)
      .for('update');
    if (!event) invalidPayout();
    if (event.status !== 'pending') return;
    const descriptor = describeSupportedStripeEvent(verifiedEvent(event));
    if (!descriptor || descriptor.objectFamily !== 'payout' ||
      event.objectId !== canonical.providerPayoutId ||
      event.providerEventId !== canonical.providerEventId) invalidPayout();
    const now = dependencies.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invalidPayout();
    await dependencies.queueFinancialPayout(transaction, {
      providerPayoutId: canonical.providerPayoutId,
      providerEventId: canonical.providerEventId
    });
    const [completed] = await transaction
      .update(stripeEvents)
      .set({ status: 'processed', processedAt: now, updatedAt: now })
      .where(and(
        eq(stripeEvents.id, event.id),
        eq(stripeEvents.status, 'pending')
      ))
      .returning({ id: stripeEvents.id });
    if (!completed) invalidPayout();
  });
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
        if (
          payment &&
          payment.paymentIntentId === session.paymentIntentId &&
          (
            payment.latestChargeId !== session.latestChargeId ||
            (session.paymentStatus === 'unpaid' && payment.state === 'succeeded') ||
            (session.paymentStatus === 'paid' && payment.state !== 'succeeded')
          )
        ) {
          throw new RetryableProviderError();
        }
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
      if (descriptor.objectFamily === 'payout') {
        await dependencies.fulfillPayout(database, {
          stripeEventId,
          providerPayoutId: row.objectId,
          providerEventId: row.providerEventId
        });
        return;
      }
      const dispute = await gateway.retrieveDispute(row.objectId);
      throwIfAborted(signal);
      const payment = await gateway.retrievePayment(dispute.paymentIntentId);
      throwIfAborted(signal);
      await dependencies.fulfillDispute(database, { stripeEventId, dispute, payment });
    } catch (error) {
      if (!(error instanceof PermanentCommerceError)) throw error;
      await dependencies.recordException(database, { stripeEventId, orderId });
    }
  };
}

export const defaultLoadStripeEvent = loadStripeEvent;
