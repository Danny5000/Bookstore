const stripeProviderSecretNames = new Set([
  'STRIPE_SECRET_KEY',
  'STRIPE_SECRET_KEY_FILE',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRET_FILE'
]);

export function withoutStripeProviderSecrets(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined && !stripeProviderSecretNames.has(name.toUpperCase())
    )
  );
}
