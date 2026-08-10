export const STRIPE_API_VERSION = '2026-07-29.dahlia' as const;

export interface CheckoutLineSnapshot {
  providerLineItemId: string;
  orderItemId: string;
  quantity: 1;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface CheckoutSnapshot {
  providerSessionId: string;
  clientReferenceId: string;
  metadataVersion: '1';
  metadataOrderId: string;
  liveMode: boolean;
  mode: 'payment';
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'unpaid' | 'paid' | 'no_payment_required';
  paymentIntentId: string | null;
  latestChargeId: string | null;
  customerEmail: string | null;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  expiresAt: Date;
  lineItems: CheckoutLineSnapshot[];
}

export interface PaymentSnapshot {
  paymentIntentId: string;
  latestChargeId: string | null;
  liveMode: boolean;
  state: 'pending' | 'succeeded' | 'failed';
  amountMinor: number;
  currency: string;
  paidAt: Date | null;
  paymentMethodCategory: string | null;
}

export interface RefundSnapshot {
  providerRefundId: string;
  paymentIntentId: string;
  liveMode: boolean;
  state: 'pending' | 'succeeded' | 'failed' | 'canceled';
  amountMinor: number;
  currency: string;
  reason: 'duplicate' | 'fraudulent' | 'requested_by_customer' | 'other' | null;
  providerCreatedAt: Date;
}

export interface DisputeSnapshot {
  providerDisputeId: string;
  paymentIntentId: string;
  chargeId: string;
  liveMode: boolean;
  state: 'open' | 'won' | 'lost';
  amountMinor: number;
  currency: string;
  reason: string | null;
  providerCreatedAt: Date;
  providerUpdatedAt: Date;
}

export interface VerifiedStripeEvent {
  providerEventId: string;
  type: string;
  objectId: string;
  liveMode: boolean;
  apiVersion: string | null;
  providerCreatedAt: Date;
  rawBodySha256: string;
}

export interface CreateCheckoutSessionInput {
  orderId: string;
  accountEmail: string | null;
  currency: string;
  automaticTaxEnabled: boolean;
  expiresAt: Date;
  successUrl: string;
  cancelUrl: string;
  items: Array<{
    orderItemId: string;
    title: string;
    format: 'prose' | 'comic';
    unitSubtotalMinor: number;
    taxCode: string | null;
  }>;
}

export interface CreatedCheckoutSession {
  providerSessionId: string;
  checkoutUrl: string;
  expiresAt: Date;
}

export interface StripeCommerceGateway {
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CreatedCheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSnapshot>;
  retrievePayment(id: string): Promise<PaymentSnapshot>;
  retrieveRefund(id: string): Promise<RefundSnapshot>;
  retrieveDispute(id: string): Promise<DisputeSnapshot>;
  verifyWebhook(rawBody: Uint8Array, signature: string): VerifiedStripeEvent;
}
