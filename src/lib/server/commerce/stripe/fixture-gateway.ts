import { createHash } from 'node:crypto';
import { permanentStripeFailure } from './errors';
import {
  createFixtureStripeFinancialEvidence,
  type StripeFinancialFixtureHarness
} from './fixture-financial';
import {
  createCheckoutSessionInputSchema,
  parseCheckoutSnapshot,
  parseDisputeSnapshot,
  parsePaymentSnapshot,
  parseRefundSnapshot,
  parseVerifiedStripeEvent
} from './schemas';
import type {
  CheckoutSnapshot,
  CreateCheckoutSessionInput,
  DisputeSnapshot,
  PaymentSnapshot,
  RefundSnapshot,
  StripeCommerceGateway,
  VerifiedStripeEvent
} from './types';

export const FIXTURE_CHECKOUT_ORIGIN = 'https://checkout.stripe.test';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function webhookKey(rawBody: Uint8Array, signature: string): string {
  return `${digest(rawBody)}:${digest(signature)}`;
}

export interface StripeFixtureHarness extends StripeFinancialFixtureHarness {
  createdCheckoutInputs(): CreateCheckoutSessionInput[];
  setCheckout(value: unknown): void;
  setPayment(value: unknown): void;
  setRefund(value: unknown): void;
  setDispute(value: unknown): void;
  setWebhook(rawBody: Uint8Array, signature: string, value: unknown): void;
  reset(): void;
}

export interface StripeFixture {
  gateway: StripeCommerceGateway;
  harness: StripeFixtureHarness;
}

export function createFixtureStripeGateway(): StripeFixture {
  const checkoutInputs: CreateCheckoutSessionInput[] = [];
  const checkouts = new Map<string, CheckoutSnapshot>();
  const payments = new Map<string, PaymentSnapshot>();
  const refunds = new Map<string, RefundSnapshot>();
  const disputes = new Map<string, DisputeSnapshot>();
  const webhooks = new Map<string, VerifiedStripeEvent>();
  const financial = createFixtureStripeFinancialEvidence();

  const gateway: StripeCommerceGateway = {
    async createCheckoutSession(value) {
      const parsed = createCheckoutSessionInputSchema.safeParse(value);
      if (!parsed.success) throw permanentStripeFailure(parsed.error);
      const input = clone(parsed.data);
      checkoutInputs.push(input);
      return {
        providerSessionId: `cs_test_${input.orderId.replaceAll('-', '')}`,
        checkoutUrl: `${FIXTURE_CHECKOUT_ORIGIN}/session/${input.orderId}`,
        expiresAt: new Date(input.expiresAt)
      };
    },

    async retrieveCheckoutSession(id) {
      const value = checkouts.get(id);
      if (!value) throw permanentStripeFailure();
      return clone(value);
    },

    async retrievePayment(id) {
      const value = payments.get(id);
      if (!value) throw permanentStripeFailure();
      return clone(value);
    },

    async retrieveRefund(id) {
      const value = refunds.get(id);
      if (!value) throw permanentStripeFailure();
      return clone(value);
    },

    async retrieveDispute(id) {
      const value = disputes.get(id);
      if (!value) throw permanentStripeFailure();
      return clone(value);
    },

    ...financial.gateway,

    verifyWebhook(rawBody, signature) {
      const value = webhooks.get(webhookKey(rawBody, signature));
      if (!value) throw permanentStripeFailure();
      return clone(value);
    }
  };

  const harness: StripeFixtureHarness = {
    ...financial.harness,
    createdCheckoutInputs: () => clone(checkoutInputs),
    setCheckout(value) {
      const parsed = parseCheckoutSnapshot(value);
      checkouts.set(parsed.providerSessionId, clone(parsed));
    },
    setPayment(value) {
      const parsed = parsePaymentSnapshot(value);
      payments.set(parsed.paymentIntentId, clone(parsed));
    },
    setRefund(value) {
      const parsed = parseRefundSnapshot(value);
      refunds.set(parsed.providerRefundId, clone(parsed));
    },
    setDispute(value) {
      const parsed = parseDisputeSnapshot(value);
      disputes.set(parsed.providerDisputeId, clone(parsed));
    },
    setWebhook(rawBody, signature, value) {
      const parsed = parseVerifiedStripeEvent(value);
      if (parsed.rawBodySha256 !== digest(rawBody)) throw permanentStripeFailure();
      webhooks.set(webhookKey(rawBody, signature), clone(parsed));
    },
    reset() {
      checkoutInputs.splice(0);
      checkouts.clear();
      payments.clear();
      refunds.clear();
      disputes.clear();
      webhooks.clear();
      financial.harness.resetFinancial();
    }
  };

  return { gateway, harness };
}
