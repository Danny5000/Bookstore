import { z } from 'zod';
import { permanentStripeFailure } from './stripe/errors';

export {
  STRIPE_EVENT_JOB,
  STRIPE_EVENT_JOB_MAX_ATTEMPTS
} from '$lib/server/jobs/catalog';

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
