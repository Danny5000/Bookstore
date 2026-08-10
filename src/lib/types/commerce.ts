import { z } from 'zod';

export const MAX_CART_TITLES = 25;
export const cartTitleIdSchema = z.uuid();

export const cartStateV1Schema = z.strictObject({
  version: z.literal(1),
  titleIds: z.array(cartTitleIdSchema).max(MAX_CART_TITLES),
  checkoutAttemptId: z.uuid()
});

export const quoteRequestSchema = z.strictObject({
  titleIds: z.array(cartTitleIdSchema).min(1).max(MAX_CART_TITLES)
});

export const checkoutRequestSchema = z.strictObject({
  titleIds: z.array(cartTitleIdSchema).min(1).max(MAX_CART_TITLES),
  quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  checkoutAttemptId: z.uuid()
});

export const claimRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email())
});

export type CartStateV1 = z.output<typeof cartStateV1Schema>;
export type QuoteRequest = z.output<typeof quoteRequestSchema>;
export type CheckoutRequest = z.output<typeof checkoutRequestSchema>;
export type ClaimRequest = z.output<typeof claimRequestSchema>;

export interface CommerceQuoteItemDto {
  titleId: string;
  slug: string;
  title: string;
  creatorName: string;
  format: 'prose' | 'comic';
  coverUrl: string | null;
  unitSubtotalMinor: number;
  currency: string;
}

export interface CommerceQuoteDto {
  fingerprint: string;
  currency: string | null;
  subtotalMinor: number;
  items: CommerceQuoteItemDto[];
  alreadyOwnedTitleIds: string[];
  unavailableTitleIds: string[];
  taxNotice: 'calculated_at_checkout';
  canCheckout: boolean;
}

export type CheckoutResultDto =
  | { status: 'redirect'; checkoutUrl: string }
  | { status: 'cart_changed'; quote: CommerceQuoteDto };

export type OrderStatusDto =
  | { status: 'pending' }
  | { status: 'paid'; libraryUrl: '/library' }
  | { status: 'paid_guest'; claimMessage: string }
  | { status: 'failed' | 'expired' | 'exception'; message: string };
