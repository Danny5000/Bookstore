import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

describe('commerce operations contract', () => {
  it('keeps the production baseline disabled and maintenance-only', async () => {
    const compose = await source('compose.prod.yaml');
    expect(compose).toMatch(/APPLICATION_MODE:\s*maintenance/u);
    expect(compose).toMatch(/STRIPE_ENABLED:\s*"false"/u);
    expect(compose).toMatch(/STRIPE_TEST_FIXTURE_MODE:\s*"false"/u);
    expect(compose).toMatch(/STRIPE_LIVE_MODE:\s*"false"/u);
    expect(compose).toMatch(/STRIPE_CHECKOUT_DURATION_SECONDS:\s*\$\{STRIPE_CHECKOUT_DURATION_SECONDS:-1800\}/u);
    expect(compose).toMatch(/STRIPE_WEBHOOK_TOLERANCE_SECONDS:\s*\$\{STRIPE_WEBHOOK_TOLERANCE_SECONDS:-300\}/u);
    expect(compose).toMatch(/COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS:\s*\$\{COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS:-60\}/u);
    expect(compose).toMatch(/COMMERCE_CHECKOUT_RATE_LIMIT_MAX:\s*\$\{COMMERCE_CHECKOUT_RATE_LIMIT_MAX:-5\}/u);
    expect(compose).not.toMatch(/STRIPE_(?:SECRET_KEY|WEBHOOK_SECRET)(?!_FILE)\s*:/u);
  });

  it('enables only app and worker through environment-backed Stripe secrets', async () => {
    const overlay = await source('compose.stripe.yaml');
    expect(overlay).toMatch(/services:\s*[\s\S]*?app:\s*[\s\S]*?STRIPE_ENABLED:\s*"true"/u);
    expect(overlay).toMatch(/worker:\s*[\s\S]*?STRIPE_ENABLED:\s*"true"/u);
    expect(overlay).toMatch(/STRIPE_SECRET_KEY_FILE:\s*\/run\/secrets\/stripe_secret_key/u);
    expect(overlay).toMatch(/STRIPE_WEBHOOK_SECRET_FILE:\s*\/run\/secrets\/stripe_webhook_secret/u);
    expect(overlay).toMatch(/stripe_secret_key:\s*\n\s*environment:\s*STRIPE_SECRET_KEY/u);
    expect(overlay).toMatch(/stripe_webhook_secret:\s*\n\s*environment:\s*STRIPE_WEBHOOK_SECRET/u);
    expect(overlay).not.toMatch(/APPLICATION_MODE/u);
  });

  it('documents safe commerce, claim, reconciliation, and manual-checkpoint operations', async () => {
    const [runbook, readme, runtime, database, authentication, library] = await Promise.all([
      source('docs/commerce-and-guest-claims.md'),
      source('README.md'),
      source('docs/runtime-environments.md'),
      source('docs/database-and-workers.md'),
      source('docs/authentication-and-email.md'),
      source('docs/customer-library-and-reader.md')
    ]);
    for (const expected of [
      '2026-07-29.dahlia',
      'Tax calculated at checkout',
      'Mailpit',
      'Stripe Dashboard',
      'partial multi-title',
      'Plan 6B',
      'APPLICATION_MODE=maintenance',
      'Never paste Stripe credentials into chat'
    ]) expect(runbook).toContain(expected);
    expect(runbook).toMatch(/STRIPE_CHECKOUT_DURATION_SECONDS=1800/u);
    expect(runbook).toMatch(/STRIPE_WEBHOOK_TOLERANCE_SECONDS=300/u);
    expect(runbook).toMatch(/STRIPE_TEST_FIXTURE_MODE=false/u);
    expect(readme).toContain('docs/commerce-and-guest-claims.md');
    expect(readme).not.toContain('Checkout is not live in Plan 5');
    expect(runtime).toContain('compose.stripe.yaml');
    expect(database).toContain('stripe_events');
    expect(authentication).toContain('guest purchase');
    expect(library).toContain('entitlement_grants');
  });

  it('keeps example credentials empty and non-secret', async () => {
    const example = await source('.env.example');
    expect(example).toMatch(/^STRIPE_SECRET_KEY=\s*$/mu);
    expect(example).toMatch(/^STRIPE_WEBHOOK_SECRET=\s*$/mu);
    expect(example).not.toMatch(/^STRIPE_SECRET_KEY=sk_(?:test|live)_[^\s]+/mu);
    expect(example).not.toMatch(/^STRIPE_WEBHOOK_SECRET=whsec_[^\s]+/mu);
  });
});
