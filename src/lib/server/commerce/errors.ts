export class PermanentCommerceError extends Error {
  readonly code = 'PERMANENT_COMMERCE_FAILURE' as const;

  constructor(options?: ErrorOptions) {
    super('The commerce operation cannot be completed.', options);
    this.name = 'PermanentCommerceError';
  }
}

export class RetryableProviderError extends Error {
  readonly code = 'PROVIDER_RETRYABLE' as const;

  constructor(options?: ErrorOptions) {
    super('The commerce provider operation can be retried.', options);
    this.name = 'RetryableProviderError';
  }
}

export type CommerceConflictCode =
  | 'GRANT_PERMANENTLY_REVOKED'
  | 'PRESERVED_GRANT_IMMUTABLE'
  | 'CHECKOUT_ATTEMPT_CONFLICT'
  | 'IDENTITY_ALREADY_CLAIMED'
  | 'STALE_COMMERCE_STATE';

const CONFLICT_MESSAGES: Readonly<Record<CommerceConflictCode, string>> = {
  GRANT_PERMANENTLY_REVOKED: 'A permanently revoked grant cannot be reactivated.',
  PRESERVED_GRANT_IMMUTABLE: 'Provider state cannot mutate a preserved grant.',
  CHECKOUT_ATTEMPT_CONFLICT: 'The checkout attempt conflicts with existing state.',
  IDENTITY_ALREADY_CLAIMED: 'The guest identity is already claimed.',
  STALE_COMMERCE_STATE: 'The commerce state changed during the operation.'
};

export class CommerceConflictError extends Error {
  constructor(
    readonly code: CommerceConflictCode,
    options?: ErrorOptions
  ) {
    super(CONFLICT_MESSAGES[code], options);
    this.name = 'CommerceConflictError';
  }
}

export type CustomerSafeCommerceCode =
  | 'INVALID_CART'
  | 'CART_CHANGED'
  | 'CHECKOUT_UNAVAILABLE'
  | 'ORDER_NOT_FOUND';

export abstract class CustomerSafeCommerceError extends Error {
  protected constructor(
    readonly code: CustomerSafeCommerceCode,
    message: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCartError extends CustomerSafeCommerceError {
  constructor() {
    super('INVALID_CART', 'The cart is invalid.');
  }
}

export class CartChangedError extends CustomerSafeCommerceError {
  constructor() {
    super('CART_CHANGED', 'The cart changed. Review it before checking out.');
  }
}

export class CheckoutUnavailableError extends CustomerSafeCommerceError {
  constructor() {
    super('CHECKOUT_UNAVAILABLE', 'Checkout is temporarily unavailable.');
  }
}

export class OrderNotFoundError extends CustomerSafeCommerceError {
  constructor() {
    super('ORDER_NOT_FOUND', 'The order could not be found.');
  }
}
