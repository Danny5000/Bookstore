import { CheckoutUnavailableError } from '$lib/server/commerce/errors';
import type { ApplicationConfig } from '$lib/server/config/schema';
import { permanentStripeFailure } from './errors';
import { createFixtureStripeGateway } from './fixture-gateway';
import {
  createStripeSdkGateway,
  createStripeSdkWorkerGateway,
  type StripeSdkGatewayOptions,
  type StripeSdkWorkerGatewayOptions
} from './sdk-gateway';
import type { StripeCommerceGateway } from './types';

export type StripeRuntimeConfig = Pick<ApplicationConfig, 'environment' | 'origin' | 'stripe'>;
export type StripeWorkerRuntimeConfig = {
  environment: ApplicationConfig['environment'];
  stripe: Pick<
    ApplicationConfig['stripe'],
    'enabled' | 'testFixtureMode' | 'liveMode' | 'secretKey'
  >;
};

export type StripeCommerceRuntime = {
  mode: 'disabled' | 'fixture' | 'stripe';
  webhooksConfigured: boolean;
  gateway: StripeCommerceGateway;
};

export interface StripeRuntimeFactories {
  sdkFactory(options: StripeSdkGatewayOptions): StripeCommerceGateway;
  fixtureFactory(): StripeCommerceGateway;
}

export interface StripeWorkerRuntimeFactories {
  sdkFactory(options: StripeSdkWorkerGatewayOptions): StripeCommerceGateway;
  fixtureFactory(): StripeCommerceGateway;
}

const defaultFactories: StripeRuntimeFactories = {
  sdkFactory: createStripeSdkGateway,
  fixtureFactory: () => createFixtureStripeGateway().gateway
};

function checkoutUnavailable(): CheckoutUnavailableError {
  return new CheckoutUnavailableError();
}

const disabledGateway: StripeCommerceGateway = {
  async createCheckoutSession() { throw checkoutUnavailable(); },
  async retrieveCheckoutSession() { throw checkoutUnavailable(); },
  async retrievePayment() { throw checkoutUnavailable(); },
  async retrieveRefund() { throw checkoutUnavailable(); },
  async retrieveDispute() { throw checkoutUnavailable(); },
  async retrieveCharge() { throw checkoutUnavailable(); },
  async retrieveBalanceTransaction() { throw checkoutUnavailable(); },
  async retrievePayout() { throw checkoutUnavailable(); },
  async listBalanceTransactionsForSource() { throw checkoutUnavailable(); },
  async listBalanceTransactionsForPayout() { throw checkoutUnavailable(); },
  async listPayouts() { throw checkoutUnavailable(); },
  verifyWebhook() { throw checkoutUnavailable(); }
};

function validOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return origin.origin === value || origin.href === `${value}/`;
  } catch {
    return false;
  }
}

export function createStripeCommerceRuntime(
  config: StripeRuntimeConfig,
  factories: StripeRuntimeFactories = defaultFactories
): StripeCommerceRuntime {
  const { stripe } = config;
  if (
    !stripe ||
    typeof stripe.enabled !== 'boolean' ||
    typeof stripe.testFixtureMode !== 'boolean' ||
    typeof stripe.liveMode !== 'boolean' ||
    !Number.isInteger(stripe.webhookToleranceSeconds) ||
    stripe.webhookToleranceSeconds < 1 ||
    stripe.webhookToleranceSeconds > 900 ||
    !validOrigin(config.origin)
  ) throw permanentStripeFailure();

  if (stripe.testFixtureMode) {
    if (stripe.enabled || config.environment !== 'test') throw permanentStripeFailure();
    return {
      mode: 'fixture',
      webhooksConfigured: true,
      gateway: factories.fixtureFactory()
    };
  }

  if (!stripe.enabled) {
    return { mode: 'disabled', webhooksConfigured: false, gateway: disabledGateway };
  }

  const requiredSecretPrefix = stripe.liveMode ? 'sk_live_' : 'sk_test_';
  if (
    typeof stripe.secretKey !== 'string' ||
    !stripe.secretKey.startsWith(requiredSecretPrefix) ||
    typeof stripe.webhookSecret !== 'string' ||
    !stripe.webhookSecret.startsWith('whsec_')
  ) throw permanentStripeFailure();

  return {
    mode: 'stripe',
    webhooksConfigured: true,
    gateway: factories.sdkFactory({
      secretKey: stripe.secretKey,
      webhookSecret: stripe.webhookSecret,
      origin: config.origin,
      expectedLiveMode: stripe.liveMode,
      webhookToleranceSeconds: stripe.webhookToleranceSeconds
    })
  };
}

export function createStripeWorkerRuntime(
  config: StripeWorkerRuntimeConfig,
  factories: StripeWorkerRuntimeFactories = {
    sdkFactory: createStripeSdkWorkerGateway,
    fixtureFactory: () => createFixtureStripeGateway().gateway
  }
): StripeCommerceRuntime {
  const { stripe } = config;
  if (
    !stripe ||
    typeof stripe.enabled !== 'boolean' ||
    typeof stripe.testFixtureMode !== 'boolean' ||
    typeof stripe.liveMode !== 'boolean'
  ) throw permanentStripeFailure();

  if (stripe.testFixtureMode) {
    if (stripe.enabled || config.environment !== 'test') throw permanentStripeFailure();
    return {
      mode: 'fixture',
      webhooksConfigured: false,
      gateway: factories.fixtureFactory()
    };
  }

  if (!stripe.enabled) {
    return { mode: 'disabled', webhooksConfigured: false, gateway: disabledGateway };
  }

  const requiredSecretPrefix = stripe.liveMode ? 'sk_live_' : 'sk_test_';
  if (
    typeof stripe.secretKey !== 'string' ||
    !stripe.secretKey.startsWith(requiredSecretPrefix)
  ) throw permanentStripeFailure();

  return {
    mode: 'stripe',
    webhooksConfigured: false,
    gateway: factories.sdkFactory({
      secretKey: stripe.secretKey,
      expectedLiveMode: stripe.liveMode
    })
  };
}
