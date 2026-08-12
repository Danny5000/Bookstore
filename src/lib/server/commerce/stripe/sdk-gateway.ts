import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { z } from 'zod';
import {
  PermanentCommerceError,
  RetryableProviderError
} from '$lib/server/commerce/errors';
import { permanentStripeFailure, retryableStripeFailure } from './errors';
import {
  parseFinancialProviderId,
  parseStripePageRequest
} from './financial-schemas';
import {
  balanceTransactionListPath,
  balanceTransactionRetrievePath,
  mapSdkBalanceTransaction,
  mapSdkBalanceTransactionPage,
  mapSdkCharge,
  mapSdkDispute,
  mapSdkPayout,
  mapSdkPayoutPage,
  mapSdkRefund
} from './sdk-financial-evidence';
import { parseExactFinancialResponse } from './sdk-financial-json';
import {
  createCheckoutSessionInputSchema,
  normalizePaymentMethodCategory,
  normalizePaymentState,
  parseCheckoutSnapshot,
  parseCreatedCheckoutSession,
  parsePaymentSnapshot,
  parseVerifiedStripeEvent
} from './schemas';
import {
  STRIPE_API_VERSION,
  type CheckoutLineSnapshot,
  type StripeCommerceGateway
} from './types';

export interface StripeSdkGatewayOptions {
  secretKey: string;
  webhookSecret: string;
  origin: string;
  expectedLiveMode: boolean;
  webhookToleranceSeconds: number;
}

const providerIdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/u);
const providerMetadataSchema = z.record(z.string(), z.string());
const idObjectSchema = z.object({ id: providerIdSchema });
const idReferenceSchema = z.union([providerIdSchema, idObjectSchema]);
const nullableIdReferenceSchema = idReferenceSchema.nullable();
const unixSecondsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const rawCreatedSessionSchema = z.object({
  id: providerIdSchema,
  url: z.string().nullable(),
  expires_at: unixSecondsSchema
});
const rawCheckoutSessionSchema = z.object({
  id: providerIdSchema,
  client_reference_id: z.string().nullable(),
  metadata: providerMetadataSchema,
  livemode: z.boolean(),
  mode: z.string().nullable(),
  status: z.string().nullable(),
  payment_status: z.string(),
  payment_intent: z.union([
    providerIdSchema,
    z.object({ id: providerIdSchema, latest_charge: nullableIdReferenceSchema })
  ]).nullable(),
  customer_details: z.object({ email: z.string().nullable() }).nullable(),
  customer_email: z.string().nullable(),
  currency: z.string().nullable(),
  amount_subtotal: z.number().nullable(),
  amount_total: z.number().nullable(),
  total_details: z.object({ amount_tax: z.number() }).nullable(),
  expires_at: unixSecondsSchema
});
const rawLineItemSchema = z.object({
  id: providerIdSchema,
  quantity: z.number().nullable(),
  currency: z.string(),
  amount_subtotal: z.number(),
  amount_tax: z.number(),
  amount_total: z.number(),
  price: z.object({
    product: z.object({
      id: providerIdSchema,
      metadata: providerMetadataSchema
    })
  })
});
const rawLinePageSchema = z.object({
  data: z.array(rawLineItemSchema),
  has_more: z.boolean()
});
const rawPaymentSchema = z.object({
  id: providerIdSchema,
  metadata: providerMetadataSchema,
  latest_charge: z.union([
    providerIdSchema,
    z.object({ id: providerIdSchema, created: unixSecondsSchema })
  ]).nullable(),
  livemode: z.boolean(),
  status: z.string(),
  amount: z.number(),
  currency: z.string(),
  payment_method: z.union([
    providerIdSchema,
    z.object({ id: providerIdSchema, type: z.string() })
  ]).nullable()
});
const rawEventSchema = z.object({
  id: providerIdSchema,
  type: z.string(),
  livemode: z.boolean(),
  api_version: z.string().nullable(),
  created: unixSecondsSchema,
  data: z.object({ object: z.object({ id: providerIdSchema }) })
});
const providerErrorShape = z.object({
  type: z.string().optional(),
  statusCode: z.number().int().optional()
});
const emailSchema = z.string().trim().toLowerCase().max(320).pipe(z.email());

function unixDate(value: number): Date {
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) throw permanentStripeFailure();
  return date;
}

function parseProvider<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw permanentStripeFailure(parsed.error);
  return parsed.data;
}

function providerId(value: string): string {
  return parseProvider(providerIdSchema, value);
}

function referencedId(value: z.output<typeof idReferenceSchema> | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : value.id;
}

function assertOnlyKeys(value: Record<string, string>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw permanentStripeFailure();
  }
}

function normalizedEmail(value: string | null): string | null {
  if (value === null) return null;
  return parseProvider(emailSchema, value);
}

function assertLiveMode(actual: boolean, expected: boolean): void {
  if (actual !== expected) throw permanentStripeFailure();
}

function mapProviderFailure(cause: unknown): PermanentCommerceError | RetryableProviderError {
  if (cause instanceof PermanentCommerceError) return permanentStripeFailure();
  if (cause instanceof RetryableProviderError) return retryableStripeFailure();
  const parsed = providerErrorShape.safeParse(cause);
  if (parsed.success) {
    const { type, statusCode } = parsed.data;
    if (
      type === 'StripeConnectionError' ||
      type === 'StripeRateLimitError' ||
      statusCode === 429 ||
      (statusCode !== undefined && statusCode >= 500)
    ) return retryableStripeFailure();
  }
  return permanentStripeFailure();
}

async function providerCall<Output>(work: () => Promise<Output>): Promise<Output> {
  try {
    return await work();
  } catch (error) {
    throw mapProviderFailure(error);
  }
}

async function rawFinancialRequest(client: Stripe, path: string): Promise<unknown> {
  const stream = await providerCall(() =>
    client.rawRequest('GET', path, undefined, { streaming: true })
  );
  return parseExactFinancialResponse(stream);
}

function assertReturnUrl(value: string, origin: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== origin) throw permanentStripeFailure();
  } catch (error) {
    if (error instanceof PermanentCommerceError) throw error;
    throw permanentStripeFailure(error);
  }
}

function createSdkClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    telemetry: false
  });
}

export function createStripeSdkGateway(options: StripeSdkGatewayOptions): StripeCommerceGateway {
  const origin = new URL(options.origin).origin;
  const client = createSdkClient(options.secretKey);

  return {
    async createCheckoutSession(untrustedInput) {
      const input = parseProvider(createCheckoutSessionInputSchema, untrustedInput);
      assertReturnUrl(input.successUrl, origin);
      assertReturnUrl(input.cancelUrl, origin);
      const params: Stripe.Checkout.SessionCreateParams = {
        mode: 'payment',
        client_reference_id: input.orderId,
        metadata: {
          pale_orbit_metadata_version: '1',
          pale_orbit_order_id: input.orderId
        },
        payment_intent_data: {
          metadata: {
            pale_orbit_metadata_version: '1',
            pale_orbit_order_id: input.orderId
          }
        },
        ...(input.accountEmail === null ? {} : { customer_email: input.accountEmail }),
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        automatic_tax: { enabled: input.automaticTaxEnabled },
        adaptive_pricing: { enabled: false },
        line_items: input.items.map((item) => ({
          quantity: 1,
          price_data: {
            currency: input.currency,
            unit_amount: item.unitSubtotalMinor,
            tax_behavior: 'exclusive',
            product_data: {
              name: item.title,
              ...(item.taxCode === null ? {} : { tax_code: item.taxCode }),
              metadata: { pale_orbit_order_item_id: item.orderItemId }
            }
          }
        }))
      };
      const raw = await providerCall(() =>
        client.checkout.sessions.create(params, { idempotencyKey: input.orderId })
      );
      const session = parseProvider(rawCreatedSessionSchema, raw);
      if (!session.url) throw permanentStripeFailure();
      const expiresAt = unixDate(session.expires_at);
      if (expiresAt.getTime() !== input.expiresAt.getTime()) throw permanentStripeFailure();
      return parseCreatedCheckoutSession({
        providerSessionId: session.id,
        checkoutUrl: session.url,
        expiresAt
      });
    },

    async retrieveCheckoutSession(untrustedId) {
      const id = providerId(untrustedId);
      const raw = await providerCall(() => client.checkout.sessions.retrieve(id, {
        expand: ['payment_intent.latest_charge']
      }));
      const session = parseProvider(rawCheckoutSessionSchema, raw);
      assertLiveMode(session.livemode, options.expectedLiveMode);
      assertOnlyKeys(session.metadata, ['pale_orbit_metadata_version', 'pale_orbit_order_id']);

      const lines: CheckoutLineSnapshot[] = [];
      const seenProviderLineIds = new Set<string>();
      const seenOrderItemIds = new Set<string>();
      let cursor: string | undefined;
      while (true) {
        const params: Stripe.Checkout.SessionListLineItemsParams = {
          limit: 25,
          expand: ['data.price.product'],
          ...(cursor === undefined ? {} : { starting_after: cursor })
        };
        const rawPage = await providerCall(() => client.checkout.sessions.listLineItems(id, params));
        const page = parseProvider(rawLinePageSchema, rawPage);
        if (page.has_more && page.data.length === 0) throw permanentStripeFailure();
        for (const line of page.data) {
          assertOnlyKeys(line.price.product.metadata, ['pale_orbit_order_item_id']);
          const orderItemId = line.price.product.metadata.pale_orbit_order_item_id;
          if (!orderItemId || seenProviderLineIds.has(line.id) || seenOrderItemIds.has(orderItemId)) {
            throw permanentStripeFailure();
          }
          if (line.quantity !== 1) throw permanentStripeFailure();
          if (lines.length >= 25) throw permanentStripeFailure();
          seenProviderLineIds.add(line.id);
          seenOrderItemIds.add(orderItemId);
          lines.push({
            providerLineItemId: line.id,
            orderItemId,
            quantity: 1,
            currency: line.currency,
            subtotalMinor: line.amount_subtotal,
            taxMinor: line.amount_tax,
            totalMinor: line.amount_total
          });
        }
        if (!page.has_more) break;
        const nextCursor = page.data.at(-1)?.id;
        if (!nextCursor || nextCursor === cursor) throw permanentStripeFailure();
        cursor = nextCursor;
      }

      const detailsEmail = normalizedEmail(session.customer_details?.email ?? null);
      const legacyEmail = normalizedEmail(session.customer_email);
      if (detailsEmail && legacyEmail && detailsEmail !== legacyEmail) throw permanentStripeFailure();
      const paymentIntentId = referencedId(session.payment_intent);
      const latestChargeId =
        session.payment_intent && typeof session.payment_intent !== 'string'
          ? referencedId(session.payment_intent.latest_charge)
          : null;
      return parseCheckoutSnapshot({
        providerSessionId: session.id,
        clientReferenceId: session.client_reference_id,
        metadataVersion: session.metadata.pale_orbit_metadata_version,
        metadataOrderId: session.metadata.pale_orbit_order_id,
        liveMode: session.livemode,
        mode: session.mode,
        status: session.status,
        paymentStatus: session.payment_status,
        paymentIntentId,
        latestChargeId,
        customerEmail: detailsEmail ?? legacyEmail,
        currency: session.currency,
        subtotalMinor: session.amount_subtotal,
        taxMinor: session.total_details?.amount_tax ?? null,
        totalMinor: session.amount_total,
        expiresAt: unixDate(session.expires_at),
        lineItems: lines
      });
    },

    async retrievePayment(untrustedId) {
      const id = providerId(untrustedId);
      const raw = await providerCall(() => client.paymentIntents.retrieve(id, {
        expand: ['latest_charge', 'payment_method']
      }));
      const payment = parseProvider(rawPaymentSchema, raw);
      assertLiveMode(payment.livemode, options.expectedLiveMode);
      assertOnlyKeys(payment.metadata, [
        'pale_orbit_metadata_version',
        'pale_orbit_order_id'
      ]);
      const latestChargeId = referencedId(payment.latest_charge);
      const paidAt =
        payment.status === 'succeeded' && payment.latest_charge && typeof payment.latest_charge !== 'string'
          ? unixDate(payment.latest_charge.created)
          : null;
      const methodType =
        payment.payment_method && typeof payment.payment_method !== 'string'
          ? payment.payment_method.type
          : null;
      return parsePaymentSnapshot({
        paymentIntentId: payment.id,
        metadataVersion: payment.metadata.pale_orbit_metadata_version,
        metadataOrderId: payment.metadata.pale_orbit_order_id,
        latestChargeId,
        liveMode: payment.livemode,
        state: normalizePaymentState(payment.status),
        amountMinor: payment.amount,
        currency: payment.currency,
        paidAt,
        paymentMethodCategory: normalizePaymentMethodCategory(methodType)
      });
    },

    async retrieveRefund(untrustedId) {
      const id = providerId(untrustedId);
      const raw = await providerCall(() => client.refunds.retrieve(id));
      return mapSdkRefund(raw, options.expectedLiveMode);
    },

    async retrieveDispute(untrustedId) {
      const id = providerId(untrustedId);
      const raw = await providerCall(() => client.disputes.retrieve(id));
      return mapSdkDispute(raw, options.expectedLiveMode);
    },

    async retrieveCharge(untrustedId) {
      const id = parseFinancialProviderId(untrustedId);
      const raw = await providerCall(() => client.charges.retrieve(id));
      return mapSdkCharge(raw, options.expectedLiveMode);
    },

    async retrieveBalanceTransaction(untrustedId) {
      const id = parseFinancialProviderId(untrustedId);
      const raw = await rawFinancialRequest(
        client,
        balanceTransactionRetrievePath(id)
      );
      return mapSdkBalanceTransaction(raw, options.expectedLiveMode);
    },

    async retrievePayout(untrustedId) {
      const id = parseFinancialProviderId(untrustedId);
      const raw = await providerCall(() => client.payouts.retrieve(id));
      return mapSdkPayout(raw, options.expectedLiveMode);
    },

    async listBalanceTransactionsForSource(untrustedSourceId, untrustedRequest) {
      const source = parseFinancialProviderId(untrustedSourceId);
      const request = parseStripePageRequest(untrustedRequest);
      const rawPage = await rawFinancialRequest(
        client,
        balanceTransactionListPath(request, { source })
      );
      return mapSdkBalanceTransactionPage(rawPage, request, options.expectedLiveMode);
    },

    async listBalanceTransactionsForPayout(untrustedPayoutId, untrustedRequest) {
      const payout = parseFinancialProviderId(untrustedPayoutId);
      const request = parseStripePageRequest(untrustedRequest);
      const rawPage = await rawFinancialRequest(
        client,
        balanceTransactionListPath(request, { payout })
      );
      return mapSdkBalanceTransactionPage(rawPage, request, options.expectedLiveMode);
    },

    async listPayouts(untrustedRequest) {
      const request = parseStripePageRequest(untrustedRequest);
      const created = {
        ...(request.createdGte === undefined ? {} : { gte: request.createdGte }),
        ...(request.createdLt === undefined ? {} : { lt: request.createdLt })
      };
      const rawPage = await providerCall(() => client.payouts.list({
        limit: request.limit,
        ...(request.startingAfter === undefined ? {} : { starting_after: request.startingAfter }),
        ...(Object.keys(created).length === 0 ? {} : { created })
      }));
      return mapSdkPayoutPage(rawPage, request, options.expectedLiveMode);
    },

    verifyWebhook(rawBody, signature) {
      const rawBodySha256 = createHash('sha256').update(rawBody).digest('hex');
      try {
        const event = parseProvider(
          rawEventSchema,
          client.webhooks.constructEvent(
            Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength),
            signature,
            options.webhookSecret,
            options.webhookToleranceSeconds
          )
        );
        if (event.api_version !== null && event.api_version !== STRIPE_API_VERSION) {
          throw permanentStripeFailure();
        }
        return parseVerifiedStripeEvent({
          providerEventId: event.id,
          type: event.type,
          objectId: event.data.object.id,
          liveMode: event.livemode,
          apiVersion: event.api_version,
          providerCreatedAt: unixDate(event.created),
          rawBodySha256
        });
      } catch (error) {
        throw mapProviderFailure(error);
      }
    }
  };
}
