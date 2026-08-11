#!/usr/bin/env node

const requiredCredentials = [
  process.env.STRIPE_SECRET_KEY,
  process.env.STRIPE_WEBHOOK_SECRET
];

if (requiredCredentials.some((value) => typeof value !== 'string' || value.trim() === '')) {
  console.error('[stripe-preflight] required Stripe credentials are missing or empty');
  process.exitCode = 1;
} else {
  console.info('[stripe-preflight] required Stripe credentials are present');
}
