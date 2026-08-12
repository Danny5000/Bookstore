import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import {
  checkoutInputFixture,
  checkoutSnapshotFixture,
  FIXTURE_ORDER_ID
} from '../../../../../tests/fixtures/stripe/checkout';
import { disputeSnapshotFixture } from '../../../../../tests/fixtures/stripe/dispute';
import {
  FIXTURE_WEBHOOK_BODY,
  FIXTURE_WEBHOOK_SIGNATURE,
  verifiedEventFixture
} from '../../../../../tests/fixtures/stripe/events';
import { paymentSnapshotFixture } from '../../../../../tests/fixtures/stripe/payment';
import { refundSnapshotFixture } from '../../../../../tests/fixtures/stripe/refund';
import { chargeSnapshotFixture } from '../../../../../tests/fixtures/stripe/charge';
import { createFixtureStripeGateway, FIXTURE_CHECKOUT_ORIGIN } from './fixture-gateway';

describe('fixture Stripe gateway', () => {
  it('creates deterministic sessions and exposes inputs only through its test harness', async () => {
    const fixture = createFixtureStripeGateway();
    const input = checkoutInputFixture();

    await expect(fixture.gateway.createCheckoutSession(input)).resolves.toEqual({
      providerSessionId: `cs_test_${FIXTURE_ORDER_ID.replaceAll('-', '')}`,
      checkoutUrl: `${FIXTURE_CHECKOUT_ORIGIN}/session/${FIXTURE_ORDER_ID}`,
      expiresAt: input.expiresAt
    });
    expect(fixture.harness.createdCheckoutInputs()).toEqual([input]);
    expect(fixture.harness.createdCheckoutInputs()[0]).not.toBe(input);
  });

  it('returns only validated canonical snapshots and defensive copies', async () => {
    const fixture = createFixtureStripeGateway();
    const checkout = checkoutSnapshotFixture();
    fixture.harness.setCheckout(checkout);
    fixture.harness.setPayment(paymentSnapshotFixture());
    fixture.harness.setRefund(refundSnapshotFixture());
    fixture.harness.setDispute(disputeSnapshotFixture());
    fixture.harness.setCharge(chargeSnapshotFixture());

    const first = await fixture.gateway.retrieveCheckoutSession(checkout.providerSessionId);
    first.lineItems.splice(0);
    await expect(fixture.gateway.retrieveCheckoutSession(checkout.providerSessionId)).resolves.toEqual(checkout);
    await expect(fixture.gateway.retrievePayment('pi_test_fixture_101')).resolves.toEqual(paymentSnapshotFixture());
    await expect(fixture.gateway.retrieveRefund('re_test_fixture_101')).resolves.toEqual(refundSnapshotFixture());
    await expect(fixture.gateway.retrieveDispute('dp_test_fixture_101')).resolves.toEqual(disputeSnapshotFixture());
    await expect(fixture.gateway.retrieveCharge('ch_test_fixture_101')).resolves.toEqual(chargeSnapshotFixture());

    expect(() => fixture.harness.setPayment({
      ...paymentSnapshotFixture(),
      cardBrand: 'private'
    })).toThrow(PermanentCommerceError);
  });

  it('verifies only an exact harness-registered body and signature', () => {
    const fixture = createFixtureStripeGateway();
    const event = verifiedEventFixture({
      rawBodySha256: createHash('sha256').update(FIXTURE_WEBHOOK_BODY).digest('hex')
    });
    fixture.harness.setWebhook(FIXTURE_WEBHOOK_BODY, FIXTURE_WEBHOOK_SIGNATURE, event);

    expect(fixture.gateway.verifyWebhook(FIXTURE_WEBHOOK_BODY, FIXTURE_WEBHOOK_SIGNATURE)).toEqual(event);
    expect(() => fixture.gateway.verifyWebhook(
      new TextEncoder().encode('different'),
      FIXTURE_WEBHOOK_SIGNATURE
    )).toThrow(PermanentCommerceError);
    expect(() => fixture.gateway.verifyWebhook(FIXTURE_WEBHOOK_BODY, 'wrong')).toThrow(
      PermanentCommerceError
    );
  });

  it('fails safely for missing snapshots and can reset between test scenarios', async () => {
    const fixture = createFixtureStripeGateway();
    fixture.harness.setPayment(paymentSnapshotFixture());
    fixture.harness.reset();

    const error = await fixture.gateway.retrievePayment('pi_test_fixture_101').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PermanentCommerceError);
    expect(error).toMatchObject({ message: 'The commerce operation cannot be completed.' });
    expect(fixture.harness.createdCheckoutInputs()).toEqual([]);
  });
});
