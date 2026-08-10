import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PermanentCommerceError } from './errors';
import {
  STRIPE_EVENT_JOB,
  createStripeEventJobPayload,
  parseStripeEventJobPayload
} from './job';

describe('Stripe event job contract', () => {
  it('uses one immutable job name and a strict internal event UUID payload', () => {
    const stripeEventId = randomUUID();
    expect(STRIPE_EVENT_JOB).toBe('commerce.stripe-event');
    expect(createStripeEventJobPayload(stripeEventId)).toEqual({ stripeEventId });
    expect(parseStripeEventJobPayload({ stripeEventId })).toEqual({ stripeEventId });
  });

  it.each([
    {},
    { stripeEventId: 'not-a-uuid' },
    { stripeEventId: randomUUID(), providerEventId: 'evt_private' },
    { stripeEventId: randomUUID(), rawBody: '{}' }
  ])('rejects unsafe or expanded payloads', (payload) => {
    expect(() => parseStripeEventJobPayload(payload)).toThrow(PermanentCommerceError);
  });
});
