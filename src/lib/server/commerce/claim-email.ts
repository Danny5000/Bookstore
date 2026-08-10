import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import {
  account,
  guestIdentities,
  orders,
  user
} from '$lib/server/db/schema';
import { normalizeEmailAddress } from '$lib/server/auth/identity';
import type { createAuthServer } from '$lib/server/auth/options';
import { PermanentJobError } from '$lib/server/jobs/runner';
import type { JobHandler } from '$lib/server/jobs/types';
import {
  findOutboxMessageByDeduplicationKey
} from '$lib/server/outbox/repository';
import type { CommerceMessageEnqueuer } from './email/enqueue';

export const COMMERCE_CLAIM_EMAIL_JOB = 'commerce.claim-email' as const;
export const COMMERCE_CLAIM_REQUEST_JOB = 'commerce.claim-email-request' as const;

export const claimEmailJobPayloadSchema = z.strictObject({
  orderId: z.uuid()
});

export type ClaimEmailJobPayload = z.output<typeof claimEmailJobPayloadSchema>;

export interface QueueCommerceClaimEmailInput {
  orderId: string;
  email: string;
  claimUrl: string;
}

export function createClaimEmailJobPayload(orderId: string): ClaimEmailJobPayload {
  return claimEmailJobPayloadSchema.parse({ orderId });
}

export function commerceReceiptDeduplicationKey(orderId: string): string {
  return `commerce:receipt:order:${claimEmailJobPayloadSchema.shape.orderId.parse(orderId)}:v1`;
}

export async function queueCommerceClaimEmail(
  database: Database,
  messages: CommerceMessageEnqueuer,
  input: QueueCommerceClaimEmailInput
): Promise<void> {
  const parsed = z.strictObject({
    orderId: z.uuid(),
    email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
    claimUrl: z.url().max(2048)
  }).parse(input);
  await database.transaction(async (transaction) => {
    const [order] = await transaction
      .select()
      .from(orders)
      .where(eq(orders.id, parsed.orderId))
      .limit(1)
      .for('update');
    if (
      !order ||
      order.status !== 'paid' ||
      order.initiatingUserId !== null ||
      order.guestIdentityId === null ||
      order.purchaseEmail !== parsed.email
    ) return;
    const [identity] = await transaction
      .select()
      .from(guestIdentities)
      .where(eq(guestIdentities.id, order.guestIdentityId))
      .limit(1)
      .for('update');
    if (!identity || identity.email !== parsed.email) return;
    const receiptExists = (await findOutboxMessageByDeduplicationKey(
      transaction,
      commerceReceiptDeduplicationKey(order.id)
    )) !== null;
    if (receiptExists) {
      await messages.enqueueGuestClaimReissue(transaction, order.id, parsed.claimUrl);
    } else {
      await messages.enqueueGuestReceiptClaim(transaction, order.id, parsed.claimUrl);
    }
  });
}

export type ClaimEmailAccountState = 'magic-link' | 'unverified-password';

export interface ClaimEmailEligibility {
  orderId: string;
  email: string;
  accountState: ClaimEmailAccountState;
}

export async function loadClaimEmailEligibility(
  database: Database,
  orderId: string
): Promise<ClaimEmailEligibility | null> {
  const parsedOrderId = claimEmailJobPayloadSchema.shape.orderId.parse(orderId);
  const [order] = await database
    .select()
    .from(orders)
    .where(eq(orders.id, parsedOrderId))
    .limit(1);
  if (
    !order ||
    order.status !== 'paid' ||
    order.initiatingUserId !== null ||
    order.guestIdentityId === null ||
    !order.purchaseEmail
  ) return null;
  const email = normalizeEmailAddress(order.purchaseEmail);
  const [identity] = await database
    .select()
    .from(guestIdentities)
    .where(eq(guestIdentities.id, order.guestIdentityId))
    .limit(1);
  if (!identity || identity.email !== email) return null;

  const [matchingUser] = await database
    .select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!matchingUser || matchingUser.emailVerified) {
    return { orderId: order.id, email, accountState: 'magic-link' };
  }
  const [credential] = await database
    .select({ id: account.id })
    .from(account)
    .where(and(
      eq(account.userId, matchingUser.id),
      eq(account.providerId, 'credential')
    ))
    .limit(1);
  return {
    orderId: order.id,
    email,
    accountState: credential ? 'unverified-password' : 'magic-link'
  };
}

export interface ClaimEmailOperations {
  receiptExists(orderId: string): Promise<boolean>;
  loadEligibility(orderId: string): Promise<ClaimEmailEligibility | null>;
  requestMagicLink(input: { orderId: string; email: string }): Promise<void>;
  requestVerification(input: { orderId: string; email: string }): Promise<void>;
  enqueueReceiptWithoutClaim(orderId: string): Promise<void>;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Claim email handling was aborted.', 'AbortError');
}

export function createClaimEmailHandler(
  operations: ClaimEmailOperations,
  options: { allowExistingReceipt?: boolean } = {}
): JobHandler {
  return async (job, signal) => {
    const parsed = claimEmailJobPayloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError('Invalid commerce claim-email payload');
    const { orderId } = parsed.data;
    throwIfAborted(signal);
    if ((await operations.receiptExists(orderId)) && !options.allowExistingReceipt) return;
    const eligibility = await operations.loadEligibility(orderId);
    if (!eligibility || eligibility.orderId !== orderId) {
      throw new PermanentJobError('Commerce claim-email order is not eligible');
    }
    throwIfAborted(signal);
    if (eligibility.accountState === 'unverified-password') {
      await operations.requestVerification(eligibility);
      throwIfAborted(signal);
      await operations.enqueueReceiptWithoutClaim(orderId);
      return;
    }
    await operations.requestMagicLink(eligibility);
  };
}

type AuthServer = ReturnType<typeof createAuthServer>;

export function createClaimEmailOperations(
  database: Database,
  auth: AuthServer,
  messages: CommerceMessageEnqueuer,
  applicationOrigin: string
): ClaimEmailOperations {
  const origin = new URL(applicationOrigin).origin;
  const headers = new Headers({ origin });
  return {
    async receiptExists(orderId) {
      return (await findOutboxMessageByDeduplicationKey(
        database,
        commerceReceiptDeduplicationKey(orderId)
      )) !== null;
    },
    loadEligibility: (orderId) => loadClaimEmailEligibility(database, orderId),
    async requestMagicLink(input) {
      await auth.api.signInMagicLink({
        body: {
          email: input.email,
          callbackURL: '/claim/complete',
          newUserCallbackURL: '/claim/complete',
          errorCallbackURL: '/claim/complete?error=magic-link',
          metadata: { purpose: 'commerce-claim', orderId: input.orderId }
        },
        headers
      });
    },
    async requestVerification(input) {
      await auth.api.sendVerificationEmail({
        body: {
          email: input.email,
          callbackURL: '/claim/complete'
        },
        headers
      });
    },
    enqueueReceiptWithoutClaim: (orderId) =>
      database.transaction((transaction) =>
        messages.enqueueGuestReceiptWithoutClaim(transaction, orderId)
      )
  };
}
