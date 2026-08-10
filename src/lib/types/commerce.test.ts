import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_CART_TITLES,
  cartStateV1Schema,
  checkoutRequestSchema,
  claimRequestSchema,
  quoteRequestSchema
} from './commerce';

const titleId = randomUUID();
const checkoutAttemptId = randomUUID();

describe('commerce cart contracts', () => {
  it('accepts one versioned cart', () => {
    expect(
      cartStateV1Schema.parse({
        version: 1,
        titleIds: [titleId],
        checkoutAttemptId
      })
    ).toEqual({ version: 1, titleIds: [titleId], checkoutAttemptId });
  });

  it.each([
    { version: 2, titleIds: [titleId], checkoutAttemptId },
    { version: 1, titleIds: ['not-a-uuid'], checkoutAttemptId },
    { version: 1, titleIds: [titleId], checkoutAttemptId: 'not-a-uuid' },
    { version: 1, titleIds: [titleId], checkoutAttemptId, priceMinor: 1_299 }
  ])('rejects invalid or extra cart fields', (candidate) => {
    expect(cartStateV1Schema.safeParse(candidate).success).toBe(false);
  });

  it('caps quote and cart requests at the shared title limit', () => {
    const allowed = Array.from({ length: MAX_CART_TITLES }, () => randomUUID());
    const oversized = [...allowed, randomUUID()];

    expect(quoteRequestSchema.safeParse({ titleIds: allowed }).success).toBe(true);
    expect(quoteRequestSchema.safeParse({ titleIds: oversized }).success).toBe(false);
    expect(
      cartStateV1Schema.safeParse({
        version: 1,
        titleIds: oversized,
        checkoutAttemptId
      }).success
    ).toBe(false);
  });

  it('requires at least one title when requesting a quote', () => {
    expect(quoteRequestSchema.safeParse({ titleIds: [] }).success).toBe(false);
  });
});

describe('commerce mutation contracts', () => {
  it('accepts only lowercase sha-256 quote fingerprints', () => {
    const valid = {
      titleIds: [titleId],
      quoteFingerprint: 'a'.repeat(64),
      checkoutAttemptId
    };

    expect(checkoutRequestSchema.parse(valid)).toEqual(valid);
    expect(
      checkoutRequestSchema.safeParse({ ...valid, quoteFingerprint: 'A'.repeat(64) }).success
    ).toBe(false);
    expect(
      checkoutRequestSchema.safeParse({ ...valid, quoteFingerprint: 'a'.repeat(63) }).success
    ).toBe(false);
    expect(checkoutRequestSchema.safeParse({ ...valid, currency: 'USD' }).success).toBe(false);
  });

  it('normalizes claim email without accepting extra authority', () => {
    expect(claimRequestSchema.parse({ email: '  Reader@Example.COM  ' })).toEqual({
      email: 'reader@example.com'
    });
    expect(
      claimRequestSchema.safeParse({ email: 'reader@example.com', orderId: randomUUID() }).success
    ).toBe(false);
  });
});
