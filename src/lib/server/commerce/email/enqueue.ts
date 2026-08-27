import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  orderItems,
  orders,
  type JsonObject
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  enqueueJobReference as defaultEnqueueJobReference
} from '$lib/server/jobs/repository';
import {
  enqueueOutboxMessage as defaultEnqueueOutboxMessage
} from '$lib/server/outbox/repository';
import { PermanentCommerceError } from '../errors';
import type { PurchaseMessageEnqueuer } from '../fulfillment';
import {
  COMMERCE_CLAIM_EMAIL_JOB,
  COMMERCE_CLAIM_EMAIL_JOB_MAX_ATTEMPTS,
  createClaimEmailJobPayload
} from '../claim-email';
import {
  COMMERCE_EMAIL_TOPIC,
  parseCommerceEmailPayload,
  type CommerceEmailPayload
} from './payload';

const idSchema = z.uuid();
const canonicalIdSchema = z.string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
  .pipe(z.uuid());
const utcMillisecondTimestampSchema = z.string()
  .regex(
    /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$/u
  )
  .refine((value) => {
    if (value.startsWith('0000-')) return false;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  });

export interface ReceiptSnapshot {
  orderId: string;
  purchaseEmail: string;
  paidAt: Date;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  ownerType: 'account' | 'guest';
  items: Array<{
    title: string;
    creatorName: string;
    format: 'prose' | 'comic';
  }>;
}

export type AccessChangeInput =
  | {
      template: 'commerce.refund-access-changed';
      eventId: string;
      to: string;
      reasonCategory: 'refund_completed';
      affectedTitleCount: number;
    }
  | {
      template: 'commerce.dispute-access-changed';
      eventId: string;
      to: string;
      reasonCategory: 'dispute_opened' | 'dispute_resolved';
      affectedTitleCount: number;
    }
  | {
      template: 'commerce.administrative-recovery-access-changed';
      eventId: string;
      to: string;
      soldAsTitle: string;
      accessState: 'active' | 'revoked';
      recoveryGrantId: string;
      stateChangedAt: string;
    };

const administrativeRecoveryAccessInputSchema = z.strictObject({
  template: z.literal('commerce.administrative-recovery-access-changed'),
  eventId: canonicalIdSchema,
  to: z.string(),
  soldAsTitle: z.string(),
  accessState: z.enum(['active', 'revoked']),
  recoveryGrantId: canonicalIdSchema,
  stateChangedAt: utcMillisecondTimestampSchema
});

export interface CommerceMessageEnqueuer extends PurchaseMessageEnqueuer {
  enqueueGuestReceiptClaim(
    transaction: DatabaseTransaction,
    orderId: string,
    claimUrl: string
  ): Promise<void>;
  enqueueGuestReceiptWithoutClaim(
    transaction: DatabaseTransaction,
    orderId: string
  ): Promise<void>;
  enqueueGuestClaimReissue(
    transaction: DatabaseTransaction,
    orderId: string,
    claimUrl: string
  ): Promise<void>;
  enqueueAccessChange(
    transaction: DatabaseTransaction,
    input: AccessChangeInput
  ): Promise<void>;
}

export interface CommerceMessageEnqueuerDependencies {
  loadReceiptSnapshot: typeof loadReceiptSnapshot;
  enqueueOutboxMessage: typeof defaultEnqueueOutboxMessage;
  enqueueJob: typeof defaultEnqueueJobReference;
}

const defaultDependencies: CommerceMessageEnqueuerDependencies = {
  loadReceiptSnapshot,
  enqueueOutboxMessage: defaultEnqueueOutboxMessage,
  enqueueJob: defaultEnqueueJobReference
};

function permanent(): never {
  throw new PermanentCommerceError();
}

export async function loadReceiptSnapshot(
  transaction: DatabaseTransaction,
  orderId: string
): Promise<ReceiptSnapshot> {
  const [order] = await transaction
    .select()
    .from(orders)
    .where(eq(orders.id, idSchema.parse(orderId)))
    .limit(1);
  if (
    !order ||
    order.status !== 'paid' ||
    !order.purchaseEmail ||
    !order.paidAt ||
    order.taxMinor === null ||
    order.totalMinor === null ||
    (order.initiatingUserId === null) === (order.guestIdentityId === null)
  ) permanent();
  const items = await transaction
    .select({
      title: orderItems.titleSnapshot,
      creatorName: orderItems.creatorNameSnapshot,
      format: orderItems.format
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.id));
  if (items.length === 0) permanent();
  return {
    orderId: order.id,
    purchaseEmail: order.purchaseEmail,
    paidAt: order.paidAt,
    currency: order.currency,
    subtotalMinor: order.subtotalMinor,
    taxMinor: order.taxMinor,
    totalMinor: order.totalMinor,
    ownerType: order.initiatingUserId === null ? 'guest' : 'account',
    items
  };
}

function asJson(payload: CommerceEmailPayload): JsonObject {
  return payload as unknown as JsonObject;
}

function receiptPayload(
  snapshot: ReceiptSnapshot,
  template: 'commerce.account-receipt' | 'commerce.guest-receipt-claim',
  origin: string,
  claimUrl?: string
): CommerceEmailPayload {
  return parseCommerceEmailPayload({
    version: 1,
    template,
    to: snapshot.purchaseEmail,
    messageId: snapshot.orderId,
    orderNumber: snapshot.orderId,
    orderDate: snapshot.paidAt.toISOString(),
    currency: snapshot.currency,
    subtotalMinor: snapshot.subtotalMinor,
    taxMinor: snapshot.taxMinor,
    totalMinor: snapshot.totalMinor,
    items: snapshot.items,
    ...(template === 'commerce.guest-receipt-claim' ? { claimUrl } : {})
  }, origin);
}

export function createCommerceMessageEnqueuer(
  applicationOrigin: string,
  dependencyOverrides: Partial<CommerceMessageEnqueuerDependencies> = {}
): CommerceMessageEnqueuer {
  const origin = new URL(applicationOrigin).origin;
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  async function enqueueReceipt(
    transaction: DatabaseTransaction,
    orderId: string,
    template: 'commerce.account-receipt' | 'commerce.guest-receipt-claim',
    expectedOwner: 'account' | 'guest',
    claimUrl?: string,
    deduplicationKey?: string
  ): Promise<void> {
    const canonicalOrderId = idSchema.parse(orderId);
    const snapshot = await dependencies.loadReceiptSnapshot(transaction, canonicalOrderId);
    if (snapshot.orderId !== canonicalOrderId || snapshot.ownerType !== expectedOwner) permanent();
    const payload = receiptPayload(snapshot, template, origin, claimUrl);
    await dependencies.enqueueOutboxMessage(transaction, {
      topic: COMMERCE_EMAIL_TOPIC,
      payload: asJson(payload),
      deduplicationKey:
        deduplicationKey ?? `commerce:receipt:order:${canonicalOrderId}:v1`
    });
  }

  return {
    enqueueAccountReceipt: (transaction, orderId) =>
      enqueueReceipt(transaction, orderId, 'commerce.account-receipt', 'account'),

    async enqueueGuestClaimPreparation(transaction, orderId) {
      const canonicalOrderId = idSchema.parse(orderId);
      await dependencies.enqueueJob(transaction, {
        type: COMMERCE_CLAIM_EMAIL_JOB,
        payload: createClaimEmailJobPayload(canonicalOrderId),
        deduplicationKey: `commerce:claim-email:order:${canonicalOrderId}:v1`,
        maxAttempts: COMMERCE_CLAIM_EMAIL_JOB_MAX_ATTEMPTS
      });
    },

    enqueueGuestReceiptClaim: (transaction, orderId, claimUrl) =>
      enqueueReceipt(
        transaction,
        orderId,
        'commerce.guest-receipt-claim',
        'guest',
        claimUrl
      ),

    enqueueGuestReceiptWithoutClaim: (transaction, orderId) =>
      enqueueReceipt(transaction, orderId, 'commerce.account-receipt', 'guest'),

    enqueueGuestClaimReissue(transaction, orderId, claimUrl) {
      const canonicalOrderId = idSchema.parse(orderId);
      const actionDigest = createHash('sha256').update(claimUrl, 'utf8').digest('hex');
      return enqueueReceipt(
        transaction,
        canonicalOrderId,
        'commerce.guest-receipt-claim',
        'guest',
        claimUrl,
        `commerce:claim-reissue:order:${canonicalOrderId}:action:${actionDigest}:v1`
      );
    },

    async enqueueAccessChange(transaction, input) {
      if (input.template === 'commerce.administrative-recovery-access-changed') {
        const recovery = administrativeRecoveryAccessInputSchema.parse(input);
        const payload = parseCommerceEmailPayload({
          version: 1,
          template: recovery.template,
          to: recovery.to,
          messageId: recovery.eventId,
          soldAsTitle: recovery.soldAsTitle,
          accessState: recovery.accessState
        }, origin);
        await dependencies.enqueueOutboxMessage(transaction, {
          topic: COMMERCE_EMAIL_TOPIC,
          payload: asJson(payload),
          deduplicationKey:
            `commerce:recovery-access:${recovery.recoveryGrantId}:` +
            `${recovery.accessState}:${Date.parse(recovery.stateChangedAt)}`
        });
        return;
      }
      const eventId = idSchema.parse(input.eventId);
      const payload = parseCommerceEmailPayload({
        version: 1,
        template: input.template,
        to: input.to,
        messageId: eventId,
        reasonCategory: input.reasonCategory,
        affectedTitleCount: input.affectedTitleCount,
        libraryUrl: `${origin}/library`,
        helpUrl: `${origin}/help`
      }, origin);
      await dependencies.enqueueOutboxMessage(transaction, {
        topic: COMMERCE_EMAIL_TOPIC,
        payload: asJson(payload),
        deduplicationKey: `commerce:access-change:event:${eventId}:v1`
      });
    }
  };
}
