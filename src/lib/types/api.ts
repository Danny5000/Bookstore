import { isRecord } from '$lib/utils/persistence';

export interface CheckoutRequest {
  titleId: string;
  email: string;
  emailCopy: boolean;
}

export type CheckoutResponse = { url: string } | { message: string };
export type DeliveryChannel = 'email' | 'download';

export interface DeliveryRequest {
  titleId: string;
  channel: DeliveryChannel;
}

export function parseCheckoutRequest(value: unknown): CheckoutRequest | null {
  if (
    !isRecord(value) ||
    typeof value.titleId !== 'string' ||
    typeof value.email !== 'string' ||
    typeof value.emailCopy !== 'boolean'
  ) {
    return null;
  }
  return { titleId: value.titleId, email: value.email, emailCopy: value.emailCopy };
}

export function parseDeliveryRequest(value: unknown): DeliveryRequest | null {
  if (
    !isRecord(value) ||
    typeof value.titleId !== 'string' ||
    (value.channel !== 'email' && value.channel !== 'download')
  ) {
    return null;
  }
  return { titleId: value.titleId, channel: value.channel };
}

export function isCheckoutResponse(value: unknown): value is CheckoutResponse {
  return isRecord(value) && (typeof value.url === 'string' || typeof value.message === 'string');
}
