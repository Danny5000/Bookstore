import { getApplicationConfig } from '$lib/server/config';
import {
  createStripeCommerceRuntime,
  type StripeCommerceRuntime
} from './runtime-core';

export * from './runtime-core';

let runtime: StripeCommerceRuntime | undefined;

export function getStripeCommerceRuntime(): StripeCommerceRuntime {
  runtime ??= createStripeCommerceRuntime(getApplicationConfig());
  return runtime;
}

export function getStripeCommerceGateway() {
  return getStripeCommerceRuntime().gateway;
}
