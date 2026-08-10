import { timingSafeEqual } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { Actor } from '$lib/server/auth/admin-policy';
import { normalizeEmailAddress } from '$lib/server/auth/identity';
import { appendAuditEvent as defaultAppendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import {
  orderItems,
  orders,
  user,
  type AuditEventRow,
  type OrderItemRow,
  type OrderRow
} from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { checkoutRequestSchema } from '$lib/types/commerce';
import {
  CartChangedError,
  CommerceConflictError,
  CommerceRateLimitError,
  InvalidCartError,
  PermanentCommerceError
} from './errors';
import { lockCheckoutAttempt } from './lock';
import { lockOrder } from './lock';
import { lockAndQuoteCart } from './quote';
import { consumeRateLimit, rateLimitScopeDigest } from './rate-limit';
import { deriveOrderStatusCredential } from './status-cookie';
import type {
  CreateCheckoutSessionInput,
  CreatedCheckoutSession
} from './stripe/types';

export interface CreateAcceptedOrderInput {
  actor: Actor;
  titleIds: readonly string[];
  quoteFingerprint: string;
  checkoutAttemptId: string;
  correlationId: string;
  requestIp: string;
  applicationSecret: string;
  rateLimit: {
    windowSeconds: number;
    maxAttempts: number;
  };
  now?: Date;
}

export interface AcceptedOrder {
  order: OrderRow;
  items: OrderItemRow[];
  statusToken: string | null;
  reused: boolean;
}

export interface AcceptedOrderDependencies {
  appendAuditEvent(
    database: DatabaseExecutor,
    input: Parameters<typeof defaultAppendAuditEvent>[1]
  ): Promise<AuditEventRow>;
}

const defaultDependencies: AcceptedOrderDependencies = {
  appendAuditEvent: defaultAppendAuditEvent
};

function rawCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equalStringLists(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function equalSha256(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function validateInput(input: CreateAcceptedOrderInput) {
  const parsed = checkoutRequestSchema.safeParse({
    titleIds: [...input.titleIds],
    quoteFingerprint: input.quoteFingerprint,
    checkoutAttemptId: input.checkoutAttemptId
  });
  if (!parsed.success || new Set(parsed.data.titleIds).size !== parsed.data.titleIds.length) {
    throw new InvalidCartError();
  }
  if (input.actor.type !== 'anonymous' && input.actor.type !== 'user') {
    throw new PermanentCommerceError();
  }
  return {
    titleIds: [...parsed.data.titleIds].sort(rawCompare),
    quoteFingerprint: parsed.data.quoteFingerprint,
    checkoutAttemptId: parsed.data.checkoutAttemptId
  };
}

async function accountEmail(
  database: DatabaseExecutor,
  actor: Extract<Actor, { type: 'user' }>
): Promise<string> {
  const [account] = await database
    .select({ email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, actor.id))
    .limit(1);
  if (!account?.emailVerified) throw new PermanentCommerceError();
  try {
    return normalizeEmailAddress(account.email);
  } catch (error) {
    throw new PermanentCommerceError({ cause: error });
  }
}

function exactActor(existing: OrderRow, actor: Actor): boolean {
  if (actor.type === 'user') {
    return existing.initiatingUserId === actor.id && existing.guestIdentityId === null;
  }
  return actor.type === 'anonymous' &&
    existing.initiatingUserId === null &&
    existing.guestIdentityId === null;
}

async function reuseAcceptedOrder(
  database: Parameters<Parameters<Database['transaction']>[0]>[0],
  existing: OrderRow,
  input: CreateAcceptedOrderInput,
  validated: ReturnType<typeof validateInput>
): Promise<AcceptedOrder> {
  const items = await database
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, existing.id))
    .orderBy(asc(orderItems.titleId));
  if (
    !exactActor(existing, input.actor) ||
    !equalSha256(existing.quoteFingerprintSha256, validated.quoteFingerprint) ||
    !equalStringLists(items.map((item) => item.titleId), validated.titleIds) ||
    !['checkout_pending', 'checkout_open', 'payment_pending'].includes(existing.status)
  ) throw new CommerceConflictError('CHECKOUT_ATTEMPT_CONFLICT');

  if (
    input.actor.type === 'anonymous' &&
    (existing.status === 'checkout_pending' || existing.status === 'checkout_open')
  ) {
    const credential = deriveOrderStatusCredential(
      input.applicationSecret,
      validated.checkoutAttemptId
    );
    if (!equalSha256(existing.statusTokenSha256, credential.digestSha256)) {
      throw new CommerceConflictError('CHECKOUT_ATTEMPT_CONFLICT');
    }
    return { order: existing, items, statusToken: credential.token, reused: true };
  }
  return { order: existing, items, statusToken: null, reused: true };
}

export async function createAcceptedOrder(
  database: Database,
  input: CreateAcceptedOrderInput,
  dependencies: AcceptedOrderDependencies = defaultDependencies
): Promise<AcceptedOrder> {
  const validated = validateInput(input);
  const now = input.now ?? new Date();
  const outcome = await database.transaction(async (transaction) => {
    try {
      const scopeSha256 = rateLimitScopeDigest({
        actor: input.actor,
        requestIp: input.requestIp,
        applicationSecret: input.applicationSecret
      });
      const rateLimit = await consumeRateLimit(transaction, {
        namespace: 'commerce.checkout',
        scopeSha256,
        windowSeconds: input.rateLimit.windowSeconds,
        maxAttempts: input.rateLimit.maxAttempts,
        now
      });
      if (!rateLimit.allowed) throw new CommerceRateLimitError(rateLimit.retryAfterSeconds);

      await lockCheckoutAttempt(transaction, validated.checkoutAttemptId);
      const [existing] = await transaction
        .select()
        .from(orders)
        .where(eq(orders.clientCheckoutAttemptId, validated.checkoutAttemptId))
        .limit(1)
        .for('update');
      if (existing) {
        return { accepted: await reuseAcceptedOrder(
          transaction,
          existing,
          input,
          validated
        ) } as const;
      }

      const quote = await lockAndQuoteCart(transaction, input.actor, validated.titleIds);
      if (!equalSha256(quote.fingerprint, validated.quoteFingerprint) || !quote.canCheckout) {
        throw new CartChangedError(quote);
      }
      if (!quote.currency || quote.items.length === 0) throw new CartChangedError(quote);

      const purchaseEmail = input.actor.type === 'user'
        ? await accountEmail(transaction, input.actor)
        : null;
      const credential = deriveOrderStatusCredential(
        input.applicationSecret,
        validated.checkoutAttemptId
      );
      const [order] = await transaction
        .insert(orders)
        .values({
          status: 'checkout_pending',
          initiatingUserId: input.actor.type === 'user' ? input.actor.id : null,
          guestIdentityId: null,
          purchaseEmail,
          currency: quote.currency.toUpperCase(),
          subtotalMinor: quote.subtotalMinor,
          taxMinor: null,
          totalMinor: null,
          clientCheckoutAttemptId: validated.checkoutAttemptId,
          quoteFingerprintSha256: quote.fingerprint,
          stripeCheckoutSessionId: null,
          statusTokenSha256: credential.digestSha256,
          checkoutExpiresAt: null,
          paidAt: null,
          createdAt: now,
          updatedAt: now
        })
        .returning();
      if (!order) throw new PermanentCommerceError();
      const items = await transaction
        .insert(orderItems)
        .values(quote.items.map((item) => ({
          orderId: order.id,
          titleId: item.titleId,
          titleSnapshot: item.title,
          creatorNameSnapshot: item.creatorName,
          format: item.format,
          currency: item.currency.toUpperCase(),
          unitSubtotalMinor: item.unitSubtotalMinor,
          taxMinor: null,
          totalMinor: null,
          stripeLineItemId: null,
          createdAt: now
        })))
        .returning();
      if (items.length !== quote.items.length) throw new PermanentCommerceError();

      await dependencies.appendAuditEvent(transaction, {
        actor: input.actor,
        action: 'commerce.checkout_created',
        outcome: 'succeeded',
        resourceType: 'order',
        resourceId: order.id,
        correlationId: input.correlationId,
        after: {
          orderId: order.id,
          itemCount: items.length,
          currency: order.currency,
          subtotalMinor: order.subtotalMinor,
          titleIds: items.map((item) => item.titleId)
        }
      });
      return { accepted: {
        order,
        items: [...items].sort((left, right) => rawCompare(left.titleId, right.titleId)),
        statusToken: input.actor.type === 'anonymous' ? credential.token : null,
        reused: false
      } } as const;
    } catch (error) {
      if (
        error instanceof CartChangedError ||
        error instanceof CommerceRateLimitError ||
        error instanceof CommerceConflictError ||
        error instanceof InvalidCartError
      ) return { expectedError: error } as const;
      throw error;
    }
  });
  if ('expectedError' in outcome) throw outcome.expectedError;
  return outcome.accepted;
}

export interface AttachCheckoutSessionInput {
  orderId: string;
  providerSessionId: string;
  checkoutExpiresAt: Date;
  actor: Actor;
  correlationId: string;
  now?: Date;
}

export interface CheckoutOrchestrationOptions {
  origin: string;
  automaticTaxEnabled: boolean;
  proseTaxCode?: string;
  comicTaxCode?: string;
  checkoutDurationSeconds: number;
}

export interface CheckoutOrchestrationResult {
  orderId: string;
  checkoutUrl: string;
  checkoutExpiresAt: Date;
  statusToken: string | null;
}

export interface CheckoutOrchestrationDependencies {
  createAcceptedOrder(
    database: Database,
    input: CreateAcceptedOrderInput
  ): Promise<AcceptedOrder>;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CreatedCheckoutSession>;
  attachCheckoutSession(
    database: Database,
    input: AttachCheckoutSessionInput
  ): Promise<void>;
  currentTime(): Date;
}

export interface AttachCheckoutSessionDependencies {
  appendAuditEvent: AcceptedOrderDependencies['appendAuditEvent'];
}

const attachDependencies: AttachCheckoutSessionDependencies = {
  appendAuditEvent: defaultAppendAuditEvent
};

function validProviderId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,255}$/u.test(value);
}

export async function attachCheckoutSession(
  database: Database,
  input: AttachCheckoutSessionInput,
  dependencies: AttachCheckoutSessionDependencies = attachDependencies
): Promise<void> {
  if (
    !/^[0-9a-f-]{36}$/iu.test(input.orderId) ||
    !validProviderId(input.providerSessionId) ||
    !Number.isFinite(input.checkoutExpiresAt.getTime())
  ) throw new PermanentCommerceError();
  const now = input.now ?? new Date();
  const result = await database.transaction(async (transaction) => {
    await lockOrder(transaction, input.orderId);
    const [order] = await transaction
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1)
      .for('update');
    if (!order) throw new PermanentCommerceError();

    const sameSession = order.stripeCheckoutSessionId === input.providerSessionId;
    const sameExpiry = order.checkoutExpiresAt?.getTime() === input.checkoutExpiresAt.getTime();
    if (sameSession && sameExpiry) {
      if (order.status === 'checkout_pending') {
        await transaction.update(orders).set({
          status: 'checkout_open',
          updatedAt: now
        }).where(eq(orders.id, order.id));
      }
      return { conflict: false };
    }

    if (order.stripeCheckoutSessionId === null && order.status === 'checkout_pending') {
      await transaction.update(orders).set({
        status: 'checkout_open',
        stripeCheckoutSessionId: input.providerSessionId,
        checkoutExpiresAt: input.checkoutExpiresAt,
        updatedAt: now
      }).where(eq(orders.id, order.id));
      return { conflict: false };
    }

    await transaction.update(orders).set({
      status: 'exception',
      updatedAt: now
    }).where(eq(orders.id, order.id));
    await dependencies.appendAuditEvent(transaction, {
      actor: input.actor,
      action: 'commerce.checkout_session_conflict',
      outcome: 'failed',
      resourceType: 'order',
      resourceId: order.id,
      correlationId: input.correlationId,
      after: {
        orderId: order.id,
        category: 'provider_session_conflict',
        hadAttachedSession: order.stripeCheckoutSessionId !== null
      }
    });
    return { conflict: true };
  });
  if (result.conflict) throw new PermanentCommerceError();
}

const defaultCheckoutDependencies: CheckoutOrchestrationDependencies = {
  createAcceptedOrder,
  createCheckoutSession: async (input) => {
    const { getStripeCommerceGateway } = await import('./stripe/runtime');
    return getStripeCommerceGateway().createCheckoutSession(input);
  },
  attachCheckoutSession,
  currentTime: () => new Date()
};

const CHECKOUT_PROVIDER_CREATION_ALLOWANCE_SECONDS = 60;
const CHECKOUT_PROVIDER_CALL_SAFETY_SECONDS = 30;

function checkoutExpiry(order: OrderRow, durationSeconds: number): Date {
  if (!Number.isInteger(durationSeconds) || durationSeconds !== 1800) {
    throw new PermanentCommerceError();
  }
  const createdAtMilliseconds = order.createdAt.getTime();
  if (!Number.isFinite(createdAtMilliseconds)) throw new PermanentCommerceError();
  const createdAtEpochSeconds = Math.floor(createdAtMilliseconds / 1000);
  return new Date(
    (createdAtEpochSeconds + durationSeconds + CHECKOUT_PROVIDER_CREATION_ALLOWANCE_SECONDS) * 1000
  );
}

function assertCheckoutCanReachProvider(
  expiresAt: Date,
  durationSeconds: number,
  providerRequestTime: Date
): void {
  const minimumRemainingMilliseconds =
    (durationSeconds + CHECKOUT_PROVIDER_CALL_SAFETY_SECONDS) * 1000;
  if (expiresAt.getTime() - providerRequestTime.getTime() < minimumRemainingMilliseconds) {
    throw new CommerceConflictError('CHECKOUT_ATTEMPT_CONFLICT');
  }
}

function checkoutUrls(origin: string, orderId: string): { successUrl: string; cancelUrl: string } {
  const expectedOrigin = new URL(origin).origin;
  const success = new URL('/checkout/success', expectedOrigin);
  success.searchParams.set('order', orderId);
  return {
    successUrl: success.toString(),
    cancelUrl: new URL('/checkout/cancel', expectedOrigin).toString()
  };
}

export async function orchestrateCheckout(
  database: Database,
  input: CreateAcceptedOrderInput,
  options: CheckoutOrchestrationOptions,
  dependencies: CheckoutOrchestrationDependencies = defaultCheckoutDependencies
): Promise<CheckoutOrchestrationResult> {
  const accepted = await dependencies.createAcceptedOrder(database, input);
  const expiresAt = checkoutExpiry(accepted.order, options.checkoutDurationSeconds);
  assertCheckoutCanReachProvider(
    expiresAt,
    options.checkoutDurationSeconds,
    dependencies.currentTime()
  );
  const urls = checkoutUrls(options.origin, accepted.order.id);
  const created = await dependencies.createCheckoutSession({
    orderId: accepted.order.id,
    accountEmail: accepted.order.initiatingUserId === null
      ? null
      : accepted.order.purchaseEmail,
    currency: accepted.order.currency.toLowerCase(),
    automaticTaxEnabled: options.automaticTaxEnabled,
    expiresAt,
    ...urls,
    items: accepted.items.map((item) => ({
      orderItemId: item.id,
      title: item.titleSnapshot,
      format: item.format,
      unitSubtotalMinor: item.unitSubtotalMinor,
      taxCode: options.automaticTaxEnabled
        ? item.format === 'prose'
          ? options.proseTaxCode ?? null
          : options.comicTaxCode ?? null
        : null
    }))
  });
  await dependencies.attachCheckoutSession(database, {
    orderId: accepted.order.id,
    providerSessionId: created.providerSessionId,
    checkoutExpiresAt: created.expiresAt,
    actor: input.actor,
    correlationId: input.correlationId,
    ...(input.now === undefined ? {} : { now: input.now })
  });
  return {
    orderId: accepted.order.id,
    checkoutUrl: created.checkoutUrl,
    checkoutExpiresAt: created.expiresAt,
    statusToken: accepted.statusToken
  };
}
