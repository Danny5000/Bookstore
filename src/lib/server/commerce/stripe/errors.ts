import {
  PermanentCommerceError,
  RetryableProviderError
} from '$lib/server/commerce/errors';

export function permanentStripeFailure(cause?: unknown): PermanentCommerceError {
  return new PermanentCommerceError(cause === undefined ? undefined : { cause });
}

export function retryableStripeFailure(cause?: unknown): RetryableProviderError {
  return new RetryableProviderError(cause === undefined ? undefined : { cause });
}
