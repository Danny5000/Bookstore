import { z } from 'zod';
import { permanentStripeFailure } from './stripe/errors';

export const STRIPE_EVENT_JOB = 'commerce.stripe-event' as const;
// With the production 1s base and 5m cap, 12 attempts cover about 18.5 minutes.
export const STRIPE_EVENT_JOB_MAX_ATTEMPTS = 12;

const stripeEventJobPayloadSchema = z.strictObject({
  stripeEventId: z.uuid()
});

export type StripeEventJobPayload = z.output<typeof stripeEventJobPayloadSchema>;

export function createStripeEventJobPayload(stripeEventId: string): StripeEventJobPayload {
  return parseStripeEventJobPayload({ stripeEventId });
}

export function parseStripeEventJobPayload(value: unknown): StripeEventJobPayload {
  const parsed = stripeEventJobPayloadSchema.safeParse(value);
  if (!parsed.success) throw permanentStripeFailure(parsed.error);
  return parsed.data;
}
