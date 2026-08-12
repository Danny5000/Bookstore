import { describe, expect, it, vi } from 'vitest';
import { CheckoutUnavailableError, PermanentCommerceError } from '$lib/server/commerce/errors';
import { createFixtureStripeGateway } from './fixture-gateway';
import { createStripeCommerceRuntime, type StripeRuntimeConfig } from './runtime';

function config(overrides: Partial<StripeRuntimeConfig['stripe']> = {}): StripeRuntimeConfig {
  return {
    environment: 'test',
    origin: 'https://books.example.com',
    stripe: {
      enabled: false,
      testFixtureMode: false,
      liveMode: false,
      secretKey: undefined,
      webhookSecret: undefined,
      automaticTaxEnabled: false,
      proseTaxCode: undefined,
      comicTaxCode: undefined,
      checkoutDurationSeconds: 1800,
      webhookToleranceSeconds: 300,
      ...overrides
    }
  };
}

describe('Stripe commerce runtime selection', () => {
  it('fails closed when Stripe and fixture mode are disabled', async () => {
    const sdkFactory = vi.fn();
    const fixtureFactory = vi.fn();
    const runtime = createStripeCommerceRuntime(config(), { sdkFactory, fixtureFactory });

    expect(runtime.mode).toBe('disabled');
    expect(runtime.webhooksConfigured).toBe(false);
    await expect(runtime.gateway.retrievePayment('pi_test')).rejects.toBeInstanceOf(
      CheckoutUnavailableError
    );
    for (const operation of [
      () => runtime.gateway.retrieveCharge('ch_test'),
      () => runtime.gateway.retrieveBalanceTransaction('txn_test'),
      () => runtime.gateway.retrievePayout('po_test'),
      () => runtime.gateway.listBalanceTransactionsForSource('ch_test', { limit: 1 }),
      () => runtime.gateway.listBalanceTransactionsForPayout('po_test', { limit: 1 }),
      () => runtime.gateway.listPayouts({ limit: 1 })
    ]) await expect(operation()).rejects.toBeInstanceOf(CheckoutUnavailableError);
    expect(() => runtime.gateway.verifyWebhook(new Uint8Array(), 'signature')).toThrow(
      CheckoutUnavailableError
    );
    expect(sdkFactory).not.toHaveBeenCalled();
    expect(fixtureFactory).not.toHaveBeenCalled();
  });

  it('selects the fixture only for parsed test configuration', () => {
    const fixtureGateway = createFixtureStripeGateway().gateway;
    const fixtureFactory = vi.fn(() => fixtureGateway);
    const runtime = createStripeCommerceRuntime(
      config({ testFixtureMode: true }),
      { sdkFactory: vi.fn(), fixtureFactory }
    );

    expect(runtime).toEqual({
      mode: 'fixture',
      webhooksConfigured: true,
      gateway: fixtureGateway
    });
    expect(fixtureFactory).toHaveBeenCalledOnce();
  });

  it.each(['development', 'production'])('never selects fixtures in %s', (environment) => {
    const unsafe = { ...config({ testFixtureMode: true }), environment };
    expect(() => createStripeCommerceRuntime(unsafe as StripeRuntimeConfig, {
      sdkFactory: vi.fn(),
      fixtureFactory: vi.fn()
    })).toThrow(PermanentCommerceError);
  });

  it('selects the SDK only with complete mode-matching secrets', () => {
    const sdkGateway = createFixtureStripeGateway().gateway;
    const sdkFactory = vi.fn(() => sdkGateway);
    const runtime = createStripeCommerceRuntime(config({
      enabled: true,
      secretKey: 'sk_test_unit_test_only',
      webhookSecret: 'whsec_unit_test_only'
    }), { sdkFactory, fixtureFactory: vi.fn() });

    expect(runtime).toEqual({ mode: 'stripe', webhooksConfigured: true, gateway: sdkGateway });
    expect(sdkFactory).toHaveBeenCalledWith({
      secretKey: 'sk_test_unit_test_only',
      webhookSecret: 'whsec_unit_test_only',
      origin: 'https://books.example.com',
      expectedLiveMode: false,
      webhookToleranceSeconds: 300
    });
  });

  it.each([
    config({ enabled: true }),
    config({ enabled: true, secretKey: 'sk_live_wrong_mode', webhookSecret: 'whsec_test' }),
    config({ enabled: true, secretKey: 'sk_test_ok', webhookSecret: 'wrong' }),
    config({ enabled: true, testFixtureMode: true, secretKey: 'sk_test_ok', webhookSecret: 'whsec_test' })
  ])('rejects impossible or incomplete runtime state', (unsafe) => {
    expect(() => createStripeCommerceRuntime(unsafe, {
      sdkFactory: vi.fn(),
      fixtureFactory: vi.fn()
    })).toThrow(PermanentCommerceError);
  });
});
