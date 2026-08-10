# Backend Plan 6A: Stripe Commerce, Guest Claims, and Entitlement Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a legitimate multi-title purchase path using server-authoritative quotes, Stripe-hosted Checkout, signature-verified asynchronous fulfillment, durable purchase grants, guest magic-link claiming, and refund/dispute-driven access changes without opening production commerce or implementing Plan 6B financial reporting.

**Architecture:** The browser persists only versioned title IDs and a checkout-attempt UUID. PostgreSQL owns accepted price snapshots, orders, payments, provider events, purchase grants, refunds, disputes, and effective entitlement projection. Thin SvelteKit routes validate same-origin bounded requests; a narrow Stripe adapter performs every provider call outside database transactions; durable PostgreSQL jobs retrieve canonical provider state and apply monotonic transitions atomically with outbox email and append-only audit records.

**Tech Stack:** Node.js 26.7.0, npm 11.19.0, SvelteKit 2.70.2, Svelte 5.56.8, TypeScript 6.0.3, PostgreSQL 18.4, Drizzle ORM 0.45.2 and Drizzle Kit 0.31.10, Better Auth 1.6.26, Stripe Node 22.4.0 pinned to API version `2026-07-29.dahlia`, Zod 4.4.3, Nodemailer 9.0.5, Vitest 4.1.10, and Playwright 1.62.1.

---

## Source of truth and phase boundary

Implement the approved design in `docs/superpowers/specs/2026-08-10-stripe-commerce-guest-claims-design.md` and the Plan 6A handoff in `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md`. Plans 1-5 are complete and their authentication, PostgreSQL jobs/outbox/audit, published catalog, immutable revisions, effective entitlements, library, reader, and original-download contracts are inputs to this work.

Preserve these boundaries in every task:

- Plan 6A owns carts, authoritative quotes, orders, Checkout Sessions, payments, guest claims, grants, refunds, disputes, and effective access changes.
- Plan 6B owns balance transactions, Stripe fees, payouts, deterministic administrative allocation of ambiguous refunds, reconciliation exceptions, and the administrator sales dashboard.
- Production remains `APPLICATION_MODE=maintenance`. Do not turn on public commerce, add a Caddy exception, or relax the production-mode configuration gate.
- Use Stripe-hosted Checkout. Do not add a custom card form, Elements, saved payment methods, application-managed Stripe Customers, promotion codes, subscriptions, quantities above one, or a customer billing portal.
- Store all money as integer minor units plus uppercase ISO currency. Never use floating point for price, tax, refund, or dispute arithmetic.
- Treat browser cart state, quote presentation, success redirects, Stripe event order, and Stripe event payload contents as untrusted.
- Only a signature-verified event that is later canonically retrieved by the worker may fulfill an order. A browser route, success page, database fixture, Checkout redirect, or unsigned event must never grant access in a production runtime.
- Perform Stripe network calls outside database transactions and advisory/row locks. Make local intent durable before provider calls, then use Stripe idempotency and canonical reconciliation to recover ambiguous responses.
- Never retain complete Stripe events, Checkout/PaymentIntent/Charge/Refund/Dispute objects, billing addresses, card details, card fingerprints, signatures, secret keys, receipt URLs, Checkout URLs after expiration, or email/claim links in logs or audit metadata.
- An unclaimed guest purchase does not authorize the library, reader, media, or download routes. Access continues to flow only through the existing effective `entitlements` projection.
- Preserve every active pre-commerce entitlement by backfilling a durable `preserved` grant. Never infer that an existing entitlement was purchased.
- Keep Redis out of this plan. PostgreSQL jobs, outbox records, row locks, and advisory locks remain the coordination layer.
- Automated tests use injected provider fixtures and locally signed event fixtures. They do not contact Stripe and do not need real credentials.

## Dependency disposition and credential checkpoint

Task 1 must repeat the registry, peer-range, and audit checks before changing dependencies. The 2026-08-10 preflight found:

- `stripe@22.4.0` is the current installed/wanted/latest Stripe SDK and supports Node 26. Pin its application API version to `2026-07-29.dahlia`; never rely on the SDK's implicit default.
- `tsx` has a safe patch from `4.23.11` to `4.23.12`; take that patch and update the lockfile.
- TypeScript `7.0.2` is newer than the installed `6.0.3`, but `typescript-eslint@8.66.0` supports `<6.1.0`. Retain TypeScript `6.0.3` and record the peer-range reason.
- The existing low/moderate cookie and Drizzle Kit development-path advisories have no safe in-range fix and are already dispositioned. Do not accept npm's invalid framework or Drizzle downgrade suggestions.

No Stripe credential is needed to write this plan or complete its automated implementation and test suites. Stop only at Task 15's optional manual Stripe checkpoint and ask the user to add these values to the ignored local `.env`:

```dotenv
STRIPE_ENABLED=true
STRIPE_TEST_FIXTURE_MODE=false
STRIPE_LIVE_MODE=false
STRIPE_SECRET_KEY=sk_test_REPLACE_LOCALLY
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_WITH_STRIPE_CLI_OUTPUT
```

The user must obtain `STRIPE_WEBHOOK_SECRET` from the local `stripe listen --forward-to ...` process. Never ask them to paste either credential into chat, a test, a command transcript, a commit, `.env.example`, or Compose YAML.

## Domain invariants

- A cart contains version `1`, at most 25 distinct title UUIDs, and one client checkout-attempt UUID. Quantity is structurally one.
- A quote is authoritative only for the exact ordered title set, current public/active/published availability, immutable current price/currency snapshots, and current account ownership used to compute its SHA-256 fingerprint.
- A checkout accepts one currency. Mixed-currency input is rejected; currencies are never converted or summed.
- Signed-in checkout identity is permanently the authenticated verified user and that user's normalized account email. A payer-edited Checkout contact email cannot redirect ownership or application email.
- Guest purchase identity is created only from a canonically paid Checkout Session email. Browser-submitted email is never purchase authority.
- A local order and its item snapshots commit before Checkout Session creation. Stripe uses the order UUID as its idempotency key.
- Because Plan 6A enables neither discounts nor adjustable quantities, finalized item/order tax and total are paired and satisfy `totalMinor = subtotalMinor + taxMinor`; a succeeded payment amount equals the finalized order total.
- The 30-minute open Checkout Session honors its accepted stored price even if catalog price or visibility changes before a valid payment completes.
- Local state transitions are monotonic: `paid` never regresses, a permanently revoked purchase grant never becomes active, and an older event cannot override newer canonical provider state.
- Every Stripe event row contains only allowlisted identifiers and metadata plus a raw-body SHA-256 digest. Duplicate event IDs create neither a second event nor a second job.
- Payment fulfillment verifies the entire canonical order boundary: mode/live flag, metadata schema, order/session/payment linkage, complete paginated line items, quantities, membership, currency, subtotal, tax, total, and guest email when required.
- One durable grant explains each independent access source. `preserved` grants explain pre-commerce access; `purchase` grants point to exactly one order item.
- The effective entitlement for `(user, title)` is active if and only if at least one grant in that scope is active. Projection always locks the user/title scope before re-reading every grant.
- Unclaimed guest grants have no user and no access. Claiming attaches all eligible grants for the verified normalized email in one idempotent transaction.
- Succeeded refund allocations can only accumulate. Automatic allocation is limited to single-title refunds and complete remaining-order refunds; partial multi-title refunds enter `exception` and do not guess access.
- A purchase grant is refund-revoked only when cumulative succeeded allocations reach the item's complete paid total.
- An open dispute suspends the affected payment's otherwise-valid purchase grants; a won/reinstated dispute restores otherwise-valid grants; a lost dispute permanently revokes them. Another active grant preserves effective access.
- Emails and audit events are transactionally enqueued/appended with the state transition they describe. Customer access-change email is sent only when effective access actually changes.

## Shared browser-safe contracts

Create `src/lib/types/commerce.ts` with strict Zod input schemas and output-only TypeScript DTOs. It must not import server modules or Stripe SDK types.

```ts
import { z } from 'zod';

export const MAX_CART_TITLES = 25;
export const cartTitleIdSchema = z.uuid();

export const cartStateV1Schema = z.strictObject({
  version: z.literal(1),
  titleIds: z.array(cartTitleIdSchema).max(MAX_CART_TITLES),
  checkoutAttemptId: z.uuid()
});
export type CartStateV1 = z.output<typeof cartStateV1Schema>;

export const quoteRequestSchema = z.strictObject({
  titleIds: z.array(cartTitleIdSchema).min(1).max(MAX_CART_TITLES)
});

export interface CommerceQuoteItemDto {
  titleId: string;
  slug: string;
  title: string;
  creatorName: string;
  format: 'prose' | 'comic';
  coverUrl: string | null;
  unitSubtotalMinor: number;
  currency: string;
}

export interface CommerceQuoteDto {
  fingerprint: string;
  currency: string | null;
  subtotalMinor: number;
  items: CommerceQuoteItemDto[];
  alreadyOwnedTitleIds: string[];
  unavailableTitleIds: string[];
  taxNotice: 'calculated_at_checkout';
  canCheckout: boolean;
}

export const checkoutRequestSchema = z.strictObject({
  titleIds: z.array(cartTitleIdSchema).min(1).max(MAX_CART_TITLES),
  quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  checkoutAttemptId: z.uuid()
});

export type CheckoutResultDto =
  | { status: 'redirect'; checkoutUrl: string }
  | { status: 'cart_changed'; quote: CommerceQuoteDto };

export type OrderStatusDto =
  | { status: 'pending' }
  | { status: 'paid'; libraryUrl: '/library' }
  | { status: 'paid_guest'; claimMessage: string }
  | { status: 'failed' | 'expired' | 'exception'; message: string };

export const claimRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email())
});
```

`CartStateV1` validation is not sufficient by itself: `src/lib/commerce/cart-state.ts` must also reject duplicate IDs, empty state when submitting, unsupported versions, malformed JSON, and oversized serialized state. A failed migration returns a fresh empty cart and a new attempt UUID rather than partially accepting untrusted state.

## Provider-neutral Stripe boundary

Put the only SDK import in `src/lib/server/commerce/stripe/sdk-gateway.ts`. Domain, worker, route, and test code consume `src/lib/server/commerce/stripe/types.ts`:

```ts
export const STRIPE_API_VERSION = '2026-07-29.dahlia' as const;

export interface CheckoutLineSnapshot {
  providerLineItemId: string;
  orderItemId: string;
  quantity: 1;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface CheckoutSnapshot {
  providerSessionId: string;
  clientReferenceId: string;
  metadataVersion: '1';
  metadataOrderId: string;
  liveMode: boolean;
  mode: 'payment';
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'unpaid' | 'paid' | 'no_payment_required';
  paymentIntentId: string | null;
  latestChargeId: string | null;
  customerEmail: string | null;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  expiresAt: Date;
  lineItems: CheckoutLineSnapshot[];
}

export interface PaymentSnapshot {
  paymentIntentId: string;
  latestChargeId: string | null;
  liveMode: boolean;
  state: 'pending' | 'succeeded' | 'failed';
  amountMinor: number;
  currency: string;
  paidAt: Date | null;
  paymentMethodCategory: string | null;
}

export interface RefundSnapshot {
  providerRefundId: string;
  paymentIntentId: string;
  liveMode: boolean;
  state: 'pending' | 'succeeded' | 'failed' | 'canceled';
  amountMinor: number;
  currency: string;
  reason: 'duplicate' | 'fraudulent' | 'requested_by_customer' | 'other' | null;
  providerCreatedAt: Date;
}

export interface DisputeSnapshot {
  providerDisputeId: string;
  paymentIntentId: string;
  chargeId: string;
  liveMode: boolean;
  state: 'open' | 'won' | 'lost';
  amountMinor: number;
  currency: string;
  reason: string | null;
  providerCreatedAt: Date;
  providerUpdatedAt: Date;
}

export interface VerifiedStripeEvent {
  providerEventId: string;
  type: string;
  objectId: string;
  liveMode: boolean;
  apiVersion: string | null;
  providerCreatedAt: Date;
  rawBodySha256: string;
}

export interface CreateCheckoutSessionInput {
  orderId: string;
  accountEmail: string | null;
  currency: string;
  automaticTaxEnabled: boolean;
  expiresAt: Date;
  successUrl: string;
  cancelUrl: string;
  items: Array<{
    orderItemId: string;
    title: string;
    format: 'prose' | 'comic';
    unitSubtotalMinor: number;
    taxCode: string | null;
  }>;
}

export interface CreatedCheckoutSession {
  providerSessionId: string;
  checkoutUrl: string;
  expiresAt: Date;
}

export interface StripeCommerceGateway {
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CreatedCheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSnapshot>;
  retrievePayment(id: string): Promise<PaymentSnapshot>;
  retrieveRefund(id: string): Promise<RefundSnapshot>;
  retrieveDispute(id: string): Promise<DisputeSnapshot>;
  verifyWebhook(rawBody: Uint8Array, signature: string): VerifiedStripeEvent;
}
```

Add exhaustive Zod validation at the SDK boundary. Paginate Checkout line items until exhausted and reject more than 25, duplicate order-item metadata, a quantity other than one, missing expandable IDs, unsafe/unknown money, and unknown states. Map transient Stripe connection, rate-limit, and `5xx` failures to `RetryableProviderError`; map invalid canonical data and state mismatches to `PermanentCommerceError`. Never expose Stripe errors or request IDs to the browser.

## Target persistence model

Create `src/lib/server/db/schema/commerce.ts`, export it from `src/lib/server/db/schema/index.ts`, and generate `drizzle/0005_public_firelord.sql` plus the matching Drizzle metadata. Do not hand-edit the generated snapshot or journal.

Freeze these PostgreSQL enum values; adding a new provider state requires an explicit normalized mapping and migration, not storing arbitrary Stripe text:

```ts
export const commerceOrderStatusValues = [
  'checkout_pending', 'checkout_open', 'payment_pending',
  'paid', 'expired', 'failed', 'exception'
] as const;
export const commercePaymentStatusValues = ['pending', 'succeeded', 'failed'] as const;
export const commerceRefundStatusValues = ['pending', 'succeeded', 'failed', 'canceled'] as const;
export const commerceDisputeStatusValues = ['open', 'won', 'lost'] as const;
export const entitlementGrantSourceValues = ['purchase', 'preserved'] as const;
export const entitlementGrantStatusValues = ['unclaimed', 'active', 'suspended', 'revoked'] as const;
export const refundAllocationSourceValues = ['automatic', 'administrative'] as const;
export const stripeEventStatusValues = ['pending', 'processed', 'exception'] as const;
export const financialReconciliationStatusValues = ['pending', 'reconciled', 'exception'] as const;
```

Plan 6A initializes financial reconciliation to `pending`, except an ambiguous/mismatched record may be `exception`. Only Plan 6B may advance it to `reconciled` or supply an administrative refund allocation.

| Table/change | Required shape and constraints |
| --- | --- |
| `orders` | UUID PK; state enum; nullable initiating-user and guest-identity FKs; normalized purchase-email snapshot; uppercase currency; nonnegative subtotal; nullable nonnegative tax/total; unique client-attempt UUID; unique nullable Checkout Session ID; 64-character status-token digest; checkout expiry/payment/create/update timestamps; checks prevent both account and guest ownership and require paid identity/amount fields |
| `order_items` | UUID PK; order/title FKs; immutable safe title/creator/format/currency snapshots; nonnegative subtotal; nullable nonnegative tax/total; nullable unique provider line-item ID; unique order/title; check quantity is structurally omitted/one |
| `payments` | UUID PK; unique order FK; unique PaymentIntent ID; nullable unique latest Charge ID; normalized state; exact amount/currency; safe bounded payment-method category; paid timestamp; Plan 6B reconciliation state initialized `pending`; create/update timestamps |
| `refunds` | UUID PK; payment FK; unique provider Refund ID; normalized state; amount/currency/reason/provider-created timestamps; Plan 6B reconciliation state; create/update timestamps |
| `refund_allocations` | UUID PK; refund/order-item FKs; nonnegative amount; source `automatic | administrative`; create timestamp; unique refund/item; database checks plus locked service validation keep refund and item cumulative sums in bounds |
| `disputes` | UUID PK; payment FK; unique provider Dispute ID; normalized `open | won | lost`; amount/currency/safe reason/provider timestamps; Plan 6B reconciliation state; create/update timestamps |
| `entitlement_grants` | UUID PK; title FK; nullable user FK; source `purchase | preserved`; unique nullable order-item FK; state `unclaimed | active | suspended | revoked`; bounded reason; granted/suspended/revoked/create/update timestamps; checks tie purchase source to an order item and unclaimed state to a null user; partial unique preserved grant per user/title |
| `stripe_events` | UUID PK; unique bounded provider event ID; allowlisted event type; bounded object ID; live flag; nullable API version; provider-created timestamp; 64-character raw-body digest; processing state `pending | processed | exception`; processed/create/update timestamps |
| `application_rate_limits` | namespace, 64-character scope digest, fixed window start, count, expiry, create/update timestamps; composite PK; positive count; expiration after window start; claim/update indexes |
| `outbox_messages` | Add nullable stable deduplication key and a unique partial index. Preserve existing random outbox IDs and dispatch-job relationship. |

Migration SQL must backfill one active `preserved` grant for every `entitlements` row whose `revoked_at is null`. Revoked entitlements receive no active grant. The migration must be safe on both a fresh database and a populated Plan 5 database, and its integration test must prove running migrations twice is harmless.

## Target module and route map

### Contracts, schema, configuration, and platform seams

- `src/lib/types/commerce.ts` — browser-safe cart, quote, checkout, status, and claim contracts.
- `src/lib/server/db/schema/commerce.ts`, `index.ts`, `operations.ts`, `drizzle/0005_public_firelord.sql`, `drizzle/meta/**` — commerce persistence, preserved-grant backfill, and outbox deduplication.
- `src/lib/server/config/schema.ts`, `load.ts`, config tests, `.env.example` — validated disabled/test/Stripe runtime, tax, webhook, duration, and throttle settings.
- `src/lib/server/http/strict-json.ts` — extracted bounded strict JSON and same-origin helpers shared by reader and commerce mutation routes.
- `src/lib/server/outbox/repository.ts` — optional stable outbox deduplication key.

### Commerce domain

- `src/lib/server/commerce/errors.ts` — stable domain errors and retry classification.
- `src/lib/server/commerce/quote.ts` — authoritative public/active/published/owned quote and fingerprint.
- `src/lib/server/commerce/lock.ts` — deterministic title, order, payment, guest-identity, and user/title projection locking.
- `src/lib/server/commerce/rate-limit.ts` — application-owned fixed-window throttle.
- `src/lib/server/commerce/orders.ts` — locked re-quote, order/item snapshot, status credential, and session attachment.
- `src/lib/server/commerce/status.ts` — minimal authorized order status.
- `src/lib/server/commerce/grants.ts` — durable grant transitions and exact effective-entitlement projection.
- `src/lib/server/commerce/stripe/types.ts`, `sdk-gateway.ts`, `runtime.ts` — provider-neutral types, the only Stripe SDK adapter, and disabled/test/Stripe runtime selection.
- `src/lib/server/commerce/webhooks.ts`, `job.ts`, `handler.ts` — signature verification, minimized event acceptance, canonical dispatch, and event completion.
- `src/lib/server/commerce/fulfillment.ts` — canonical session/payment validation and atomic paid transition.
- `src/lib/server/commerce/refunds.ts` — canonical import, deterministic allocation, grant revocation, access-change email, and audit.
- `src/lib/server/commerce/disputes.ts` — canonical import, suspend/restore/revoke, projection, email, and audit.
- `src/lib/server/commerce/claims.ts`, `claim-email.ts` — generic claim request, Better Auth action selection, and atomic all-purchase claim.
- `src/lib/server/commerce/email/payload.ts`, `enqueue.ts`, `handler.ts`, `render.ts` — versioned receipt/claim/access-change outbox messages.

### SvelteKit and browser

- `src/lib/commerce/cart-state.ts`, `cart.svelte.ts` — version migration and browser-local reactive cart.
- `src/lib/components/Header.svelte`, catalog/title cards — accessible cart count and add/remove controls.
- `src/routes/cart/+page.server.ts`, `+page.svelte` — safe quote-backed cart review.
- `src/routes/api/commerce/quote/+server.ts` — bounded same-origin quote POST.
- `src/routes/api/commerce/checkout/+server.ts` — locked accepted quote, durable order, Stripe Session creation, status cookie, redirect result.
- `src/routes/api/commerce/orders/[orderId]/status/+server.ts` — account-or-cookie-authorized minimal status.
- `src/routes/api/webhooks/stripe/+server.ts` — untouched bounded body, signature/live-mode verification, minimal event/job transaction.
- `src/routes/checkout/success/+page.server.ts`, `+page.svelte` — bounded status polling and safe terminal guidance.
- `src/routes/checkout/cancel/+server.ts` — return to intact cart.
- `src/routes/claim/+page.server.ts`, `+page.svelte` — enumeration-resistant claim re-request.
- `src/routes/claim/complete/+page.server.ts`, `+page.svelte` — verified-session claim completion and library guidance.

### Worker, tests, and operations

- `src/worker.ts` — register Stripe event and commerce email handlers without creating a provider when disabled.
- `tests/fixtures/stripe/**` — minimal signed webhook and canonical adapter fixtures containing no real secrets or personal data.
- `tests/integration/commerce-*.test.ts` — PostgreSQL constraints, concurrency, jobs, email, claims, refunds, and disputes.
- `tests/e2e/cart-checkout.spec.ts`, `guest-claim.spec.ts`, `commerce-lifecycle.spec.ts` — browser journeys through the test-only injected provider adapter.
- `docs/commerce-and-guest-claims.md`, README/environment/database/auth/library docs — local Stripe test-mode runbook and Plan 6B launch boundary.

## Task 1: Freeze dependency disposition and add commerce contracts/configuration

**Files:**

- Modify: `package.json`, `package-lock.json`, `docs/dependency-decisions.md`, `.env.example`, `playwright.config.ts`
- Create: `src/lib/types/commerce.ts`, `src/lib/types/commerce.test.ts`
- Modify: `src/lib/server/config/schema.ts`, `load.ts`, `index.ts`, `index.test.ts`
- Modify: `scripts/with-test-database.ts` only if its explicit environment fixture requires the new settings

- [x] **Step 1: Capture dependency and security evidence before editing**

Run:

```powershell
node --version
npm --version
npm outdated --json
npm view stripe version engines --json
npm view tsx version engines --json
npm view typescript-eslint@8.66.0 peerDependencies --json
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
npm ls --depth=0
```

Expected: Node `v26.7.0`, npm `11.19.0`; Stripe remains `22.4.0`; `tsx` reports the `4.23.12` patch; TypeScript 7 remains outside the linter peer range; no unexplained high/critical production advisory; dependency tree exits cleanly. If registry evidence differs, review official migration notes before changing the disposition.

- [x] **Step 2: Write failing shared-contract tests**

In `src/lib/types/commerce.test.ts`, cover a valid version-1 cart, invalid versions, malformed title/attempt UUIDs, more than 25 IDs, strict rejection of unknown keys, and checkout fingerprints requiring 64 lowercase hexadecimal characters.

```ts
it('accepts one versioned cart', () => {
  expect(cartStateV1Schema.parse({
    version: 1,
    titleIds: [TITLE_A],
    checkoutAttemptId: ATTEMPT_ID
  })).toEqual({ version: 1, titleIds: [TITLE_A], checkoutAttemptId: ATTEMPT_ID });
});
```

Run:

```powershell
npx vitest run src/lib/types/commerce.test.ts
```

Expected: FAIL because the commerce contract does not exist.

- [x] **Step 3: Implement browser-safe contracts**

Create the exact `CartStateV1`, request schemas, quote DTO, checkout result, and order-status discriminated union from this plan's “Shared browser-safe contracts” section. Keep duplicate detection in the cart-state migration added in Task 4 so stored-state repair has one owner.

Run the focused test again. Expected: PASS.

- [x] **Step 4: Write failing configuration tests**

Add explicit test values for:

```dotenv
STRIPE_ENABLED=false
STRIPE_TEST_FIXTURE_MODE=false
STRIPE_LIVE_MODE=false
STRIPE_AUTOMATIC_TAX_ENABLED=false
STRIPE_CHECKOUT_DURATION_SECONDS=1800
STRIPE_WEBHOOK_TOLERANCE_SECONDS=300
COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS=60
COMMERCE_CHECKOUT_RATE_LIMIT_MAX=5
```

Test that disabled development/test starts without secrets; enabled mode requires a mode-matching `sk_test_` or `sk_live_` key plus `whsec_`; test-fixture mode is allowed only in `APP_ENV=test`, requires Stripe disabled, and ignores real secrets; automatic tax requires both bounded format tax codes; checkout duration is exactly 1800; webhook tolerance is `1..900`; rate limits are positive; production still requires maintenance/HTTPS; and `_FILE` loading works for both secrets without disclosing them in errors.

Run:

```powershell
npx vitest run src/lib/server/config/index.test.ts
```

Expected: FAIL because the settings are absent.

- [x] **Step 5: Implement fail-closed commerce configuration**

Add this output shape:

```ts
stripe: {
  enabled: boolean;
  testFixtureMode: boolean;
  liveMode: boolean;
  secretKey?: string;
  webhookSecret?: string;
  automaticTaxEnabled: boolean;
  proseTaxCode?: string;
  comicTaxCode?: string;
  checkoutDurationSeconds: 1800;
  webhookToleranceSeconds: number;
};
commerce: {
  checkoutRateLimitWindowSeconds: number;
  checkoutRateLimitMax: number;
};
```

Put nonsecret settings in `REQUIRED_SETTINGS`; put keys, webhook secret, and tax codes in `OPTIONAL_SETTINGS` so the existing direct-or-`_FILE` reader applies. Empty strings are absent, never configured secrets. Update `.env.example` with disabled placeholders and replace its obsolete prototype Stripe block. Update every explicit test environment map, including Playwright.

Run:

```powershell
npx vitest run src/lib/server/config/index.test.ts src/lib/types/commerce.test.ts
npm run check
```

Expected: PASS with zero check warnings/errors.

- [x] **Step 6: Apply only the approved safe dependency patch**

Run:

```powershell
npm install --save-dev --save-exact tsx@4.23.12
npm ls --depth=0
```

Expected: a clean dependency tree. Keep Stripe `22.4.0` and TypeScript `6.0.3` unchanged. Update `docs/dependency-decisions.md` with the date, commands, explicit Stripe API version, `tsx` patch, TypeScript peer-range hold, and audit disposition without pasting full audit output.

- [x] **Step 7: Verify and commit Task 1**

Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/types/commerce.test.ts src/lib/server/config/index.test.ts
git diff --check
git status --short
```

Expected: all commands exit zero and the diff contains only Task 1 files.

Commit:

```powershell
git add package.json package-lock.json docs/dependency-decisions.md .env.example playwright.config.ts src/lib/types/commerce.ts src/lib/types/commerce.test.ts src/lib/server/config/schema.ts src/lib/server/config/load.ts src/lib/server/config/index.ts src/lib/server/config/index.test.ts
git add scripts/with-test-database.ts # only if changed
git commit -m "feat: add commerce contracts and configuration"
```

## Task 2: Add commerce persistence, preserved grants, and outbox idempotency

**Files:**

- Create: `src/lib/server/db/schema/commerce.ts`, `src/lib/server/db/schema/commerce.test.ts`
- Modify: `src/lib/server/db/schema/operations.ts`, `src/lib/server/db/schema/index.ts`
- Modify: `src/lib/server/outbox/repository.ts`, `src/lib/server/outbox/repository.test.ts`
- Create: `tests/integration/commerce-schema.test.ts`
- Modify: `tests/integration/setup.ts`
- Generate: `drizzle/0005_public_firelord.sql`, `drizzle/meta/_journal.json`, matching snapshot

- [x] **Step 1: Write failing schema declaration tests**

Inspect Drizzle metadata and assert all commerce tables/enums exist; unique provider/order/source indexes exist; money, ISO currency, digest, and grant-consistency checks exist; and no column stores raw provider JSON, Checkout/receipt/action URLs, billing/card data, or secrets.

Run:

```powershell
npx vitest run src/lib/server/db/schema/commerce.test.ts
```

Expected: FAIL because the schema is missing.

- [x] **Step 2: Declare the schema without generating SQL yet**

Use the exact persistence table in this plan. Export select/insert types. Include checks such as:

```ts
check('orders_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`),
check('orders_status_digest_sha256', sql`${table.statusTokenSha256} ~ '^[a-f0-9]{64}$'`),
check('grants_unclaimed_has_no_user', sql`${table.state} <> 'unclaimed' or ${table.userId} is null`),
check('grants_active_has_user', sql`${table.state} <> 'active' or ${table.userId} is not null`),
check(
  'grants_source_consistent',
  sql`(${table.source} = 'purchase') = (${table.orderItemId} is not null)`
)
```

Use `onDelete: 'restrict'` for historical order/payment/provider/title/user/guest-identity sources. Paid account orders must retain their initiating user; claimed grants and guest identities must retain their claimant. Never cascade-delete financial history, events, grants, or audit evidence.

Run the focused schema test and `npm run check`. Expected: PASS.

- [x] **Step 3: Write failing outbox deduplication tests**

Extend the input contract with `deduplicationKey?: string | null`. Prove two retries with the same stable key return one logical outbox row/job, different keys remain distinct, and reusing a key with a different topic or payload throws an invariant error.

Run:

```powershell
npx vitest run src/lib/server/outbox/repository.test.ts
```

Expected: FAIL.

- [x] **Step 4: Implement stable outbox deduplication**

When a key is supplied, derive the dispatch job key `outbox-key:<sha256(key)>`, insert conflict-safely, and load the existing outbox row by its unique key. Preserve UUID behavior when omitted. Compare existing JSONB by canonical database value, not property-order-sensitive `JSON.stringify`. Commerce keys contain internal IDs only, for example `commerce:receipt:order:<orderId>:v1`; never email addresses.

Run the focused outbox test. Expected: PASS.

- [x] **Step 5: Generate and inspect migration 0005**

Run:

```powershell
npm run db:generate
npm run db:check
```

Expected: Drizzle generates migration 0005 and matching metadata. If it chooses another descriptive suffix, keep the generated name and update references.

Add the idempotent populated-database backfill after grant-table creation:

```sql
insert into entitlement_grants (
  title_id, user_id, source, state, state_reason, granted_at, created_at, updated_at
)
select e.title_id, e.user_id, 'preserved', 'active', 'pre_commerce_entitlement',
       e.granted_at, e.created_at, e.updated_at
from entitlements e
where e.revoked_at is null
on conflict do nothing;
```

Review enum order, non-destructive ALTERs, FKs, partial unique indexes, checks, and backfill. Never hand-rewrite the generated snapshot/journal.

- [x] **Step 6: Write failing PostgreSQL migration/constraint tests**

Prove one active and one revoked pre-commerce entitlement backfill to one and zero preserved grants respectively; a second migration run does not duplicate; invalid source/item/user/state combinations fail; unique order/title, PaymentIntent, event, and provider IDs fail; negative money, invalid currency/digest, and impossible paid identity fail; multiple independent grants for one user/title remain legal; no-user purchase grants may be unclaimed/suspended/revoked but never active; and deletion of referenced users/titles/orders is restricted rather than erasing historical commerce facts.

Run:

```powershell
npm run test:integration -- tests/integration/commerce-schema.test.ts
```

Expected: row-local/unique constraints pass. Keep cumulative refund-sum validation for Task 12 because it requires locked multi-row service logic.

- [x] **Step 7: Update integration reset order and make schema tests green**

Add commerce tables to `tests/integration/setup.ts` in dependent-first order before entitlements, outbox/jobs, catalog, identity, and auth tables.

Run:

```powershell
npm run test:integration -- tests/integration/commerce-schema.test.ts tests/integration/schema.test.ts
npm run db:check
npm run check
```

Expected: PASS.

- [x] **Step 8: Verify and commit Task 2**

Run:

```powershell
npm run lint
npx vitest run src/lib/server/db/schema/commerce.test.ts src/lib/server/outbox/repository.test.ts
npm run test:integration -- tests/integration/commerce-schema.test.ts
git diff --check
git status --short
```

Expected: PASS and no generated file is missing.

Commit:

```powershell
git add src/lib/server/db/schema src/lib/server/outbox tests/integration drizzle
git commit -m "feat: add commerce persistence model"
```

## Task 3: Project durable grants into effective entitlements

**Files:**

- Create: `src/lib/server/commerce/errors.ts`, `lock.ts`, `grants.ts`, `grants.test.ts`
- Create: `tests/integration/commerce-grants.test.ts`
- Modify: existing library/E2E entitlement fixture helpers

- [ ] **Step 1: Write failing pure projection tests**

Specify and cover no grants, one active, active plus suspended/revoked, only suspended, only unclaimed, and only revoked:

```ts
export function effectiveEntitlementState(
  grants: readonly Pick<EntitlementGrantRow, 'state'>[]
): 'active' | 'revoked' {
  return grants.some((grant) => grant.state === 'active') ? 'active' : 'revoked';
}
```

Run `npx vitest run src/lib/server/commerce/grants.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement the pure reducer and error taxonomy**

Add `PermanentCommerceError`, `RetryableProviderError`, `CommerceConflictError`, and customer-safe cart/order errors without provider messages or email. Permanently revoked purchase grants reject reactivation; refund/dispute code cannot mutate preserved grants. Run the focused test. Expected: PASS.

- [ ] **Step 3: Write failing concurrent projection integration tests**

Prove first activation creates/reactivates an entitlement; losing the last active grant revokes it; another purchase/preserved grant preserves it; won-dispute restoration reactivates only an otherwise-valid grant; unclaimed grants never project; concurrent same-scope operations cannot commit stale access; and different scopes proceed independently.

Run `npm run test:integration -- tests/integration/commerce-grants.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement deterministic locking and projection**

Lock in this order: relevant order/payment row; guest identity when claiming; sorted `(userId,titleId)` advisory locks; scope grants; effective entitlement. After locking, re-read all grants.

```ts
export async function projectEffectiveEntitlement(
  transaction: DatabaseTransaction,
  userId: string,
  titleId: string,
  now = new Date()
): Promise<{ beforeActive: boolean; afterActive: boolean }>;
```

Upsert one entitlement, retain its first `grantedAt`, clear `revokedAt` on reactivation, and set it only when no active grant remains. Never authorize from a pre-lock snapshot. Run integration tests. Expected: PASS without deadlock.

- [ ] **Step 5: Replace direct test entitlements with preserved grants**

Update test helpers so “grant/revoke existing access” creates or changes a preserved grant and invokes production projection. Keep direct malformed inserts only in constraint tests.

Run:

```powershell
npx vitest run
npm run test:integration -- tests/integration/library-access.test.ts tests/integration/commerce-grants.test.ts
```

Expected: Plan 5 access behavior remains green.

- [ ] **Step 6: Verify and commit Task 3**

Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/server/commerce/grants.test.ts
npm run test:integration -- tests/integration/commerce-grants.test.ts tests/integration/library-access.test.ts
git diff --check
```

Commit:

```powershell
git add src/lib/server/commerce tests/helpers tests/e2e/helpers tests/integration/commerce-grants.test.ts
git commit -m "feat: project durable entitlement grants"
```

## Task 4: Implement browser cart state, authoritative quotes, and application throttling

**Files:**

- Create: `src/lib/commerce/cart-state.ts`, `cart-state.test.ts`, `cart.svelte.ts`, `cart.svelte.test.ts`
- Create: `src/lib/server/commerce/quote.ts`, `quote.test.ts`, `rate-limit.ts`, `rate-limit.test.ts`
- Create: `tests/integration/commerce-quote.test.ts`, `commerce-rate-limit.test.ts`
- Create: `src/lib/server/http/strict-json.ts`, `strict-json.test.ts`
- Modify: `src/routes/api/reader-state/route-support.ts`
- Create: `src/routes/api/commerce/quote/+server.ts`, `route.test.ts`

- [ ] **Step 1: Write failing cart migration/store tests**

Cover invalid/oversized JSON, unsupported version, unknown fields, duplicates, malformed or 26 title IDs, add/remove/clear, uniqueness, stable attempt ID while editing, and new attempt ID only after a successful paid cleanup or explicit reset. Every invalid stored value becomes a fresh empty state.

Run `npx vitest run src/lib/commerce/cart-state.test.ts src/lib/commerce/cart.svelte.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement browser-only cart state**

Follow the Svelte 5 theme-store local-storage pattern and guard browser APIs. Persist only version, title IDs, and attempt UUID—never presentation, price, ownership, email, order/provider IDs, URLs, or paid state. Cap serialized input at 8 KiB. Run focused tests. Expected: PASS.

- [ ] **Step 3: Write failing quote/fingerprint unit tests**

Canonical fingerprint input is versioned and sorted by raw UUID:

```ts
type QuoteFingerprintInputV1 = {
  version: 1;
  actorUserId: string | null;
  items: Array<{
    titleId: string;
    priceMinor: number;
    currency: string;
    activeRevisionId: string;
    presentationPublishedAt: string;
  }>;
  alreadyOwnedTitleIds: string[];
  unavailableTitleIds: string[];
};
```

Prove membership, price, currency, revision, publication, and ownership changes alter SHA-256 while input ordering does not. Never locale-sort. Run focused test. Expected: FAIL then PASS after pure implementation.

- [ ] **Step 4: Write failing PostgreSQL quote tests**

Cover public/published/active/positive-price titles; private, draft, inactive, zero-price, and missing-presentation titles; mixed currencies; active/revoked ownership; duplicates; unknown IDs; and 25/26 boundaries. Unknown/private IDs return only requested IDs in the unavailable list. Promise-barrier tests must prove locked re-quote observes concurrent catalog and entitlement changes.

Run `npm run test:integration -- tests/integration/commerce-quote.test.ts`. Expected: FAIL.

- [ ] **Step 5: Implement quote and locked re-quote**

Return only safe published DTOs. For checkout, acquire sorted Plan 4 title locks, then authenticated user/title locks, and re-read. Do not hold these locks across Stripe calls.

```ts
export async function lockAndQuoteCart(
  transaction: DatabaseTransaction,
  actor: Actor,
  titleIds: readonly string[]
): Promise<CommerceQuote>;
```

Reject duplicate/oversized/mixed-currency input as `INVALID_CART`; `canCheckout=false` when nothing remains. Run quote tests. Expected: PASS.

- [ ] **Step 6: Write failing atomic rate-limit tests**

Prove first N attempts pass, N+1 gets bounded retry-after, a new window resets, cleanup is idempotent, and 20 concurrent calls cannot exceed N. Store only namespaced SHA-256/HMAC scope digests—not IP, token, email, or user agent. Auth scope starts from `user:<uuid>`; anonymous scope is an application-secret HMAC over the request IP.

Run `npm run test:integration -- tests/integration/commerce-rate-limit.test.ts`. Expected: FAIL.

- [ ] **Step 7: Implement rate limiting and shared strict HTTP helpers**

Use one atomic upsert for count and a bounded namespace/expiry cleanup. Extract current bounded strict JSON, same-origin, correlation, private JSON, and private empty helpers from reader route support with characterization tests. Preserve reader response codes and allow an explicit commerce body limit.

Run:

```powershell
npx vitest run src/lib/server/http/strict-json.test.ts src/routes/api/reader-state/route-support.test.ts
npm run test:integration -- tests/integration/commerce-rate-limit.test.ts
```

Expected: PASS.

- [ ] **Step 8: Add the thin quote endpoint**

`POST /api/commerce/quote` requires same origin, quote throttle, strict schema, `locals.actor`, and private JSON. It never creates orders, calls Stripe, or audits routine cart activity. Map invalid JSON 400, forbidden 403, too large 413, media type 415, invalid cart 422, throttled 429 with bounded `Retry-After`, and unexpected dependency failure 503.

Run the route, quote, and rate-limit suites. Expected: PASS.

- [ ] **Step 9: Verify and commit Task 4**

Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/commerce src/lib/server/commerce/quote.test.ts src/lib/server/http/strict-json.test.ts src/routes/api/commerce/quote/route.test.ts
npm run test:integration -- tests/integration/commerce-quote.test.ts tests/integration/commerce-rate-limit.test.ts
git diff --check
```

Commit:

```powershell
git add src/lib/commerce src/lib/server/commerce src/lib/server/http src/routes/api/commerce/quote src/routes/api/reader-state/route-support.ts tests/integration/commerce-quote.test.ts tests/integration/commerce-rate-limit.test.ts
git commit -m "feat: add authoritative commerce quotes"
```

## Task 5: Implement the narrow Stripe adapter and test-only provider injection

**Files:**

- Create: `src/lib/server/commerce/stripe/types.ts`, `errors.ts`, `schemas.ts`
- Create: `src/lib/server/commerce/stripe/sdk-gateway.ts`, `sdk-gateway.test.ts`
- Create: `src/lib/server/commerce/stripe/fixture-gateway.ts`, `fixture-gateway.test.ts`
- Create: `src/lib/server/commerce/stripe/runtime.ts`, `runtime.test.ts`
- Create: `tests/fixtures/stripe/checkout.ts`, `payment.ts`, `refund.ts`, `dispute.ts`, `events.ts`

- [ ] **Step 1: Write failing provider-contract validation tests**

Use the exact neutral interfaces above. Test complete paginated line-item mapping and rejection of more than 25 lines, duplicate/missing order-item metadata, quantity other than one, floats/unsafe money, unknown currency/status, missing IDs, mismatched page cursors, unsupported API version, and prohibited detail leakage.

Run `npx vitest run src/lib/server/commerce/stripe`. Expected: FAIL.

- [ ] **Step 2: Implement pure canonical schemas and mapping**

Zod-validate every normalized result. Normalize PaymentIntent processing/requires-action states to pending and canceled/terminal payment failure to failed. Normalize Stripe Refund `requires_action` to pending (never allocatable), and only exact succeeded to succeeded. Normalize every nonfinal Dispute status to open and only exact won/lost to terminal values. Safe payment-method category is an allowlisted bounded category such as `card`, `link`, `cashapp`, `amazon_pay`, or `other`; do not map brand, last four, wallet details, or fingerprints. Refund/dispute reasons map to a safe allowlist or `other`/null. Run pure tests. Expected: PASS.

- [ ] **Step 3: Write failing SDK gateway tests against a mocked Stripe client**

Assert the SDK is constructed with:

```ts
new Stripe(secretKey, {
  apiVersion: STRIPE_API_VERSION,
  maxNetworkRetries: 2,
  telemetry: false
});
```

Assert Checkout creation sends `mode: 'payment'`, dashboard-managed payment methods by omitting a hard-coded list, inline exclusive `price_data`, quantity one, format tax codes, optional `automatic_tax`, order UUID metadata/client reference, 30-minute expiry, safe same-origin success/cancel URLs, and the order UUID as Stripe's idempotency key. Each inline product uses the immutable safe title snapshot for Checkout display and only `pale_orbit_order_item_id` in product metadata so paginated retrieval can prove membership. Signed-in checkout sets only the verified stored account email as `customer_email`; guest checkout omits it so Checkout collects canonical contact email. On retrieval, `customer_details.email` is authoritative and any nonnull legacy/session email must normalize identically. Assert no other email/name/token/storage metadata is supplied.

Also test pagination/retrieval and error mapping: network/rate limit/`5xx` are retryable; invalid requests and canonical mismatches are permanent; no raw Stripe message reaches a domain error.

Run focused SDK tests. Expected: FAIL.

- [ ] **Step 4: Implement the sole Stripe SDK adapter**

Only `sdk-gateway.ts` imports `stripe`. Inject the SDK client or factory in tests. Do not use `any`, unchecked casts, or provider objects outside this file. Compare webhook event API version to `STRIPE_API_VERSION` when supplied. Hash raw body bytes before allowing event minimization.

Run focused tests. Expected: PASS.

- [ ] **Step 5: Implement fail-closed runtime selection**

Runtime rules are exact:

- `STRIPE_ENABLED=false` and fixture false returns a disabled gateway whose checkout/retrieval throws `CHECKOUT_UNAVAILABLE`; webhook route behaves as not configured.
- Enabled creates the real SDK gateway only after validated secrets exist.
- Test fixture mode creates an in-memory/deterministic adapter only when parsed config says `environment === 'test'`.
- Production and development can never select the fixture gateway, even through a cast or raw environment value.

The fixture adapter is a dependency injection seam, not an HTTP “mark paid” route. Its canonical snapshots are set by test harness code only.

Run `npx vitest run src/lib/server/commerce/stripe`. Expected: PASS.

- [ ] **Step 6: Verify and commit Task 5**

Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/server/commerce/stripe
npm audit --omit=dev --audit-level=high
git diff --check
```

Commit:

```powershell
git add src/lib/server/commerce/stripe tests/fixtures/stripe
git commit -m "feat: add stripe commerce gateway"
```

## Task 6: Create durable orders, Checkout Sessions, and private order status

**Files:**

- Create: `src/lib/server/commerce/orders.ts`, `orders.test.ts`
- Create: `src/lib/server/commerce/status.ts`, `status.test.ts`
- Create: `tests/integration/commerce-orders.test.ts`
- Create: `src/routes/api/commerce/checkout/+server.ts`, `route.test.ts`
- Create: `src/routes/api/commerce/orders/[orderId]/status/+server.ts`, `route.test.ts`
- Create: `src/lib/server/commerce/status-cookie.ts`, `status-cookie.test.ts`

- [ ] **Step 1: Write failing status-token/cookie tests**

Generate 32 random bytes, base64url-encode plaintext, persist only SHA-256, and compare with timing-safe equality. Cookie is HttpOnly, SameSite Lax, Secure only in production, bounded to order lifetime plus processing grace, and narrowly path-scoped where browser polling still works. Prove token never appears in DTO, URL, logs, or database plaintext.

Run focused tests. Expected: FAIL then PASS after implementation.

- [ ] **Step 2: Write failing durable-order integration tests**

Cover account and guest order creation, immutable item snapshots, one currency, status hash only, unique attempt idempotency, no order for `CART_CHANGED`, no order for zero accepted items, concurrent same attempt yielding one order, and rollback of order/items/audit together.

For signed-in orders, snapshot only the verified account email and user. Guest orders begin with both purchase email and guest identity null. Assert audit details contain counts/currency/amounts/internal IDs but no title text, email, token, or request headers.

Run `npm run test:integration -- tests/integration/commerce-orders.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement locked accepted-order creation**

Inside one transaction: apply checkout throttle, call `lockAndQuoteCart`, constant-time compare the submitted fingerprint, create `checkout_pending` order/items/status digest, and append `commerce.checkout_created`. Return the plaintext status token only to the route call stack.

For a retry with the same attempt UUID, lock/load the existing order and verify exact actor, quote membership/fingerprint, and nonterminal state. Reuse the order. If a guest lost the status cookie before receiving the first response, rotate the status digest only while the same attempt and exact quote remain `checkout_pending`/`checkout_open`; rotation invalidates the older cookie and is audit-free. Never rotate paid/failed/expired/exception status credentials.

Run integration tests. Expected: PASS.

- [ ] **Step 4: Write failing Checkout orchestration tests**

Assert ordering with deferred promises:

1. Database order transaction commits.
2. All locks/connections release.
3. Gateway call begins.
4. Session attachment uses a new short transaction.

Test successful attach, same-ID retry, conflicting Session ID to `exception`, retryable provider failure leaving recoverable `checkout_pending`, lost response followed by same idempotency-key retry, local attachment failure followed by webhook recovery, and no Session creation after cart change.

Expected RED until orchestration exists.

- [ ] **Step 5: Implement Checkout orchestration and attachment**

Map stored items—not browser DTOs—to `CreateCheckoutSessionInput`. Use order UUID for metadata and idempotency. Attach only Session ID, expiry, and state; do not persist the Checkout URL. Return the URL to the route. Reissuing the same idempotent create request recovers a lost URL/response. A conflicting provider ID becomes a permanent exception with a minimized audit event and no grants.

Run focused/unit/integration tests. Expected: PASS.

- [ ] **Step 6: Add checkout route**

`POST /api/commerce/checkout` requires same-origin strict JSON and the checkout throttle. It returns private JSON with either redirect URL or `cart_changed` quote; it also sets/rotates the status cookie. Do not issue an HTTP 3xx from the mutation endpoint—client code navigates only after parsing a successful result.

Map `CART_CHANGED` to 409 with the safe quote, invalid cart 422, throttle 429, disabled/transient provider 503, and permanent local exception 500-safe `CHECKOUT_UNAVAILABLE`. Never expose provider request IDs or messages.

- [ ] **Step 7: Implement minimal authorized status**

Authorize by exact initiating user or status-cookie digest. Admin role alone does not authorize customer order status. Return only the `OrderStatusDto` mapping; never email, amounts, title list, guest identity, provider IDs, or tokens. Missing, mismatched, expired credential and other user's order all return the same 404.

Route tests cover account, guest cookie, bad/expired/rotated cookie, other user, anonymous account order, and cache-control no-store.

- [ ] **Step 8: Verify and commit Task 6**

Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/server/commerce/orders.test.ts src/lib/server/commerce/status.test.ts src/lib/server/commerce/status-cookie.test.ts src/routes/api/commerce/checkout/route.test.ts src/routes/api/commerce/orders/[orderId]/status/route.test.ts
npm run test:integration -- tests/integration/commerce-orders.test.ts
git diff --check
```

Commit:

```powershell
git add src/lib/server/commerce src/routes/api/commerce/checkout src/routes/api/commerce/orders tests/integration/commerce-orders.test.ts
git commit -m "feat: create durable stripe checkout orders"
```

## Task 7: Accept only signed, minimized, idempotent Stripe events

**Files:**

- Create: `src/lib/server/commerce/webhooks.ts`, `webhooks.test.ts`
- Create: `src/lib/server/commerce/job.ts`, `job.test.ts`
- Create: `tests/integration/commerce-webhooks.test.ts`
- Create: `src/routes/api/webhooks/stripe/+server.ts`, `route.test.ts`
- Modify: `src/lib/server/http/strict-json.ts` only to share a bounded raw-body reader

- [ ] **Step 1: Write failing allowlist/minimization tests**

Define immutable supported event sets for Checkout completion/async success/async failure/expiry, current Refund create/update/failure lifecycle, and Dispute create/update/close/funds-withdrawn/funds-reinstated lifecycle. Each supported type maps to its expected object family and retrieval method. Unsupported valid types are acknowledged but not persisted.

Assert the minimized value contains only event ID/type, object ID, live mode, API version, provider creation time, and raw-body digest. Run focused tests. Expected: FAIL.

- [ ] **Step 2: Write failing raw webhook route tests**

Cover missing signature, invalid signature, oversized body before buffering (64 KiB maximum), disabled provider, live/test mismatch, unsupported valid event, supported event, and signature verification over exact untouched bytes containing whitespace/non-ASCII. Mock only the neutral gateway.

Expected behavior:

```text
disabled endpoint       -> 404
missing/invalid signature -> 400
oversized body          -> 413
live-mode mismatch      -> 400
valid unsupported       -> 200, no write
valid supported         -> 200 after durable insert/job
```

Run route tests. Expected: FAIL.

- [ ] **Step 3: Implement bounded verification and allowlist**

Read bytes once; do not call `request.json()` or decode before `verifyWebhook`. Compare verified live mode with config. Validate allowlisted type/object pairing and bounded identifiers after verification. Never log signature/body/email/provider object.

Run unit/route tests. Expected: the persistence cases remain RED.

- [ ] **Step 4: Write failing transactional acceptance tests**

With real PostgreSQL, prove one transaction inserts `stripe_events` and `commerce.stripe-event` job with dedup key `stripe:event:<providerEventId>`. Duplicate delivery creates one event/job. Force job insert failure and prove event rollback so Stripe retry can recover. Concurrent duplicates converge. A duplicate with conflicting minimized immutable fields does not overwrite the accepted event and emits no sensitive data.

Run `npm run test:integration -- tests/integration/commerce-webhooks.test.ts`. Expected: FAIL.

- [ ] **Step 5: Implement atomic event/job acceptance**

Use `enqueueJob(transaction, { type: STRIPE_EVENT_JOB, payload: { stripeEventId }, deduplicationKey })`. On conflict, load and constant-compare immutable fields/digest; acknowledge exact duplicate. Treat conflict as a safe permanent invariant, leave original intact, and avoid infinite webhook retry. Receiver performs no canonical retrieval, order transition, email, grant, entitlement, or audit for routine duplicate delivery.

Run integration and route tests. Expected: PASS.

- [ ] **Step 6: Verify and commit Task 7**

Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/server/commerce/webhooks.test.ts src/lib/server/commerce/job.test.ts src/routes/api/webhooks/stripe/route.test.ts
npm run test:integration -- tests/integration/commerce-webhooks.test.ts
git diff --check
```

Commit:

```powershell
git add src/lib/server/commerce src/lib/server/http/strict-json.ts src/routes/api/webhooks/stripe tests/integration/commerce-webhooks.test.ts
git commit -m "feat: accept signed stripe events"
```

## Task 8: Canonically fulfill immediate and delayed payments

**Files:**

- Create: `src/lib/server/commerce/fulfillment.ts`, `fulfillment.test.ts`
- Create: `src/lib/server/commerce/handler.ts`, `handler.test.ts`
- Create: `tests/integration/commerce-fulfillment.test.ts`
- Modify: `src/worker.ts` after all handler dependencies are injectable

- [ ] **Step 1: Write failing canonical comparison tests**

Given stored order/items and neutral snapshots, require exact match for live flag, order/client reference, metadata version, session identity, mode/payment status, PaymentIntent link, currency, item membership, item IDs, quantity one, subtotal/tax/total, aggregate totals, and guest email. Reject duplicate/extra/missing lines, float/overflow amounts, `no_payment_required`, mismatched charge/payment, and changed account email identity.

Run `npx vitest run src/lib/server/commerce/fulfillment.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement the pure canonical validator**

Return a normalized fulfillment command only after every comparison succeeds:

```ts
type FulfillmentCommand =
  | { state: 'pending'; orderId: string; session: CheckoutSnapshot; payment: PaymentSnapshot }
  | { state: 'paid'; orderId: string; session: CheckoutSnapshot; payment: PaymentSnapshot; purchaseEmail: string }
  | { state: 'failed' | 'expired'; orderId: string; session: CheckoutSnapshot };
```

Account purchase email always comes from the stored verified snapshot. Guest email comes from canonical Checkout and is normalized with the existing identity helper. Run focused tests. Expected: PASS.

- [ ] **Step 3: Write failing provider-call ordering tests**

Use deferred mocks to prove handler loads only the event descriptor, releases the query, retrieves Session and Payment outside a transaction, then starts the mutation transaction. Stripe latency must not occupy a transaction, row lock, or pooled connection. Abort signals stop before new provider calls but do not interrupt an already-committing local transaction.

Expected: FAIL until handler exists.

- [ ] **Step 4: Write failing atomic fulfillment integration tests**

Cover:

- Completed unpaid Session -> `payment_pending`, no grant/email/entitlement.
- Async success -> one succeeded payment, paid order, finalized item tax/total, one purchase grant/item, account active vs guest unclaimed.
- Async failure changes only an unpaid order; paid never regresses.
- Expiry changes only an unpaid open order.
- Guest fulfillment creates/finds exactly one normalized `guest_identities` row from canonical email.
- Duplicate and out-of-order event jobs remain idempotent/monotonic.
- Concurrent success jobs serialize to one payment/grant/item/event outcome.
- Forced grant, projection, email-callback, audit, or event-completion failure rolls back the entire paid transition.
- Canonical mismatch marks order/event `exception`, writes minimized system audit, grants nothing, and completes as permanent.
- A local session-attachment failure is recovered from canonical session metadata.

Inject a transactional `enqueuePurchaseMessage` dependency for now; Task 9 supplies production email behavior.

Run `npm run test:integration -- tests/integration/commerce-fulfillment.test.ts`. Expected: FAIL.

- [ ] **Step 5: Implement monotonic fulfillment transaction**

Lock event, order, payment, then sorted grant projection scopes. Re-read every local state after locks. For paid:

1. Upsert the one PaymentIntent/payment.
2. Finalize tax/total once and reject later mismatch.
3. Set paid timestamps/state once.
4. Create one purchase grant per item.
5. Make account grants active or guest grants unclaimed.
6. Project account entitlements.
7. Invoke the transactional purchase-message enqueue dependency.
8. Append one minimized system audit.
9. Mark event processed.

For permanent mismatch, atomically store safe exception state/audit/event completion. For transient provider/database errors, leave event pending and throw retryable. Never mark an event processed before its state transition commits.

Run integration tests. Expected: PASS.

- [ ] **Step 6: Register the event handler without premature email wiring**

`createStripeEventHandler` parses only `{ stripeEventId }`, loads the minimized event, dispatches by object family, and maps permanent domain exception to job completion while retryable failures throw for job retry. Unknown job payload is permanent. Register in `src/worker.ts` only after constructing an explicit purchase-message dependency; if Task 9 immediately follows in the same execution batch, defer the final worker edit to Task 9 rather than adding a nonfunctional stub.

- [ ] **Step 7: Verify and commit Task 8**

Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/server/commerce/fulfillment.test.ts src/lib/server/commerce/handler.test.ts
npm run test:integration -- tests/integration/commerce-fulfillment.test.ts
git diff --check
```

Commit:

```powershell
git add src/lib/server/commerce src/worker.ts tests/integration/commerce-fulfillment.test.ts
git commit -m "feat: fulfill canonical stripe payments"
```

Omit `src/worker.ts` from this commit if registration is correctly deferred to Task 9.

## Task 9: Send idempotent purchase, claim, and access-change email

**Files:**

- Create: `src/lib/server/commerce/email/payload.ts`, `payload.test.ts`
- Create: `src/lib/server/commerce/email/enqueue.ts`, `enqueue.test.ts`
- Create: `src/lib/server/commerce/email/render.ts`, `render.test.ts`
- Create: `src/lib/server/commerce/email/handler.ts`, `handler.test.ts`
- Create: `src/lib/server/commerce/claim-email.ts`, `claim-email.test.ts`
- Modify: `src/lib/server/auth/options.ts`, `options.test.ts`, `runtime.ts`, `schema-config.ts`
- Modify: `src/lib/server/outbox/repository.ts` only if a safe existing-key lookup is needed
- Modify: `src/worker.ts`
- Create: `tests/integration/commerce-email.test.ts`

- [ ] **Step 1: Write failing strict payload/render tests**

Define `COMMERCE_EMAIL_TOPIC = 'email.commerce.v1'` and strict version-1 payloads:

```ts
type CommerceEmailTemplate =
  | 'commerce.account-receipt'
  | 'commerce.guest-receipt-claim'
  | 'commerce.refund-access-changed'
  | 'commerce.dispute-access-changed';
```

Account receipt contains normalized recipient, safe order number/date, currency/subtotal/tax/total, and immutable safe item title/creator/format snapshots. Guest receipt adds only a validated same-origin HTTPS/loopback claim URL. Access-change mail contains reason category, affected count, and library/help URL, not payment evidence or card/provider details.

Reject unknown fields, raw provider object, signature/secret, billing/address/card fields, receipt/Checkout URL, storage/media URL, private catalog metadata, unsafe external action URL, and unbounded item arrays. Render escaped text/HTML with direct-download wording; never attach books/comics.

Run focused tests. Expected: FAIL then PASS after payload/render implementation.

- [ ] **Step 2: Write failing transactional enqueue tests**

Prove account receipt and access-change messages use stable keys and that retries return one outbox/job. Reconstructing the same key with changed payload is an invariant failure. Use internal UUIDs for deterministic message IDs (order/event UUID), never email-derived keys.

Guest paid transition enqueues a deduplicated `commerce.claim-email` job rather than minting a token in the payment transaction. Job payload is only `{ orderId }` and dedup key `commerce:claim-email:order:<orderId>:v1`.

Run unit/integration email tests. Expected: FAIL.

- [ ] **Step 3: Implement transactional purchase-message dependencies**

Implement the interface injected into Task 8:

```ts
export interface PurchaseMessageEnqueuer {
  enqueueAccountReceipt(transaction: DatabaseTransaction, orderId: string): Promise<void>;
  enqueueGuestClaimPreparation(transaction: DatabaseTransaction, orderId: string): Promise<void>;
}
```

Load safe immutable snapshots inside the transition transaction, validate the payload, and call stable outbox/job enqueue. Run fulfillment rollback tests again and expect PASS.

- [ ] **Step 4: Write failing Better Auth metadata-routing tests**

Set magic-link token storage to `hashed`. Extend `sendMagicLink` to receive strict optional metadata. Only this exact shape selects commerce mail:

```ts
const commerceClaimMetadataSchema = z.strictObject({
  purpose: z.literal('commerce-claim'),
  orderId: z.uuid()
});
```

Prove absent metadata sends generic auth magic email; valid metadata plus matching canonically paid guest order enqueues the commerce claim receipt; invalid/mismatched metadata reveals nothing and cannot retrieve another order; token/action URL is never logged; and token verification remains atomic one-use.

Run auth/claim-email tests. Expected: FAIL.

- [ ] **Step 5: Implement safe claim-email preparation and fallback**

The claim-email job first checks the stable outbox key. If already present, complete without minting another token. Otherwise load the paid guest order and current identity eligibility.

- Normal/no account: call a worker-safe Better Auth server's `signInMagicLink` API with same-origin `/claim/complete`, `/claim/complete?error=...`, and strict metadata. Its callback re-loads and matches order/email before enqueuing the combined receipt/claim outbox message.
- Matching verified account: magic link may sign it in, then claim.
- Matching unverified password account: preserve Plan 3's protection; enqueue a receipt without a claim action and request the existing one-use verification email with `/claim/complete` callback. Do not allow magic link to replace the pending credential proof.

`createAuthServer` must remain constructible in the worker without `getRequestEvent` or SvelteKit cookie plugin. Route runtime still adds `sveltekitCookies`; worker runtime does not.

If Better Auth token creation succeeds but the process fails before mail enqueue, retry may mint a new token; the stable outbox key ensures only one logical commerce message is accepted. An already-enqueued message causes retry to finish before another token is minted.

- [ ] **Step 6: Register production handlers**

Register `email.commerce.v1`, `commerce.claim-email`, and `commerce.stripe-event` in `src/worker.ts`. Disabled Stripe mode must still dispatch already-enqueued email but must not construct a real SDK client. Stripe event jobs fail safely as unavailable while disabled. Close only transports/resources actually constructed.

- [ ] **Step 7: Verify and commit Task 9**

Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/server/commerce/email src/lib/server/commerce/claim-email.test.ts src/lib/server/auth/options.test.ts
npm run test:integration -- tests/integration/commerce-email.test.ts tests/integration/commerce-fulfillment.test.ts
npm run build:services
git diff --check
```

Commit:

```powershell
git add src/lib/server/commerce src/lib/server/auth src/lib/server/outbox/repository.ts src/worker.ts tests/integration/commerce-email.test.ts
git commit -m "feat: send purchase and claim email"
```

## Task 10: Claim all eligible guest purchases through verified identity

**Files:**

- Create: `src/lib/server/commerce/claims.ts`, `claims.test.ts`
- Create: `tests/integration/commerce-claims.test.ts`
- Create: `src/routes/claim/+page.server.ts`, `+page.svelte`, `page.server.test.ts`
- Create: `src/routes/claim/complete/+page.server.ts`, `+page.svelte`, `page.server.test.ts`
- Modify: auth email callback tests as needed

- [ ] **Step 1: Write failing purchase-grant derivation tests**

Purely derive a claimed purchase grant from complete local facts with precedence:

```text
permanently revoked grant or fully allocated succeeded refund -> revoked
lost dispute                                            -> revoked
any open dispute                                        -> suspended
succeeded paid item with no above condition             -> active
otherwise                                               -> unclaimed/error
```

Won disputes do not override a full refund or permanent revocation. Multiple dispute rows reduce by precedence, not event timestamp. Run focused tests. Expected: FAIL then PASS after pure reducer.

- [ ] **Step 2: Write failing claim integration tests**

Cover a verified session claiming every paid unclaimed purchase for normalized email; several orders/titles; same-user replay; a matching verified preexisting account; unverified-session denial; different email; identity already claimed by another user; concurrent claim attempts; current refund/dispute-derived active/suspended/revoked states; one projection per affected scope; and aggregate audit with no order contents/email.

Force a mid-claim failure and prove guest identity, grants, entitlements, and audit all roll back. Unclaimed grants must remain unable to read/download before commit.

Run `npm run test:integration -- tests/integration/commerce-claims.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the atomic claim transaction**

Require a current user whose `emailVerified` is true and normalize its email. Lock matching guest identity, then all paid guest orders/items/grants, then sorted user/title scopes. If `claimedByUserId` is null set it once; if it is the same user continue idempotently; if different, throw a generic permanent conflict.

Attach every eligible no-user purchase grant, derive its current state from locked payment/refund/allocation/dispute data, project entitlements, and append one `commerce.guest_claimed` audit with claimed-order/title counts. Never include email/title snapshots/provider IDs in audit.

Run integration tests. Expected: PASS.

- [ ] **Step 4: Write failing claim-page tests**

`/claim` accepts a same-origin form email and always returns the same status text whether no identity, already claimed, unverified credential, or eligible purchases exist. A server service normalizes the email, applies the application-owned `commerce.claim-request` fixed-window limit using an HMAC scope over normalized email plus request IP and the existing auth email-limit settings, queries eligible guest orders without returning the result to the page, and enqueues deduplicated `{ orderId }` claim-email jobs. No job payload or key contains the submitted email. No match is a successful no-op.

`/claim/complete` requires a verified current session, calls claim service, maps expired/invalid auth-link query to safe retry guidance, maps every identity conflict/no-purchase condition to the same generic result, and links to `/library` only after successful/idempotent claim. It never renders email or order details.

Expected: FAIL until routes exist.

- [ ] **Step 5: Implement accessible enumeration-resistant pages**

Use native labeled email input/button, focusable error summary only for invalid local input, `role=status` for the generic sent message, and no partial email mask. Re-request calls the same safe claim-email job path and inherits Better Auth/application rate limiting. Do not put email or tokens in query strings.

Run route tests and claim integration. Expected: PASS.

- [ ] **Step 6: Verify and commit Task 10**

Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/server/commerce/claims.test.ts src/routes/claim
npm run test:integration -- tests/integration/commerce-claims.test.ts tests/integration/auth.test.ts
git diff --check
```

Commit:

```powershell
git add src/lib/server/commerce/claims.ts src/lib/server/commerce/claims.test.ts src/routes/claim tests/integration/commerce-claims.test.ts
git commit -m "feat: claim guest purchases"
```

## Task 11: Import refunds, allocate only deterministically, and revoke fully refunded grants

**Files:**

- Create: `src/lib/server/commerce/refunds.ts`, `refunds.test.ts`
- Modify: `src/lib/server/commerce/handler.ts`, `handler.test.ts`
- Create: `tests/integration/commerce-refunds.test.ts`
- Modify: commerce access-change email tests

- [ ] **Step 1: Write failing pure allocation tests**

Cover a single-item partial/full/cumulative refund; one full multi-item refund; several refunds whose succeeded cumulative total exactly reaches the order total; partial multi-item refund; over-refund; failed/canceled/pending refund; duplicate event; and amounts in wrong currency.

The allocator may produce rows only when attribution is unambiguous:

- Every succeeded single-title refund allocates to that item up to remaining paid total.
- A multi-title set whose succeeded refunds exactly equals the full order total may allocate all still-unallocated succeeded refund amounts deterministically by provider-created/refund ID and order-item ID because every item is conclusively fully refunded.
- A single succeeded refund that itself equals every item's complete remaining total may allocate across those items.
- Every other partial multi-title state returns `exception` and no guessed new allocation.

Assert per-refund allocation sum never exceeds its amount and per-item succeeded allocation never exceeds item total. Run focused tests. Expected: FAIL then PASS after pure algorithm.

- [ ] **Step 2: Write failing refund retrieval/ordering tests**

Handler loads event descriptor, calls `retrieveRefund(objectId)` and `retrievePayment(refund.paymentIntentId)` outside transactions, then begins local mutation. It never trusts event amount/state and never holds payment/order/grant locks during provider calls. Transient provider errors retry; invalid currency/link/state is permanent exception.

Run handler tests. Expected: FAIL.

- [ ] **Step 3: Write failing refund integration tests**

Prove canonical upsert by Refund ID, succeeded-only allocation, cumulative single-title behavior, complete multi-title behavior, ambiguous partial exception/no access change, row-lock sum enforcement under concurrent refund jobs, fully allocated item revocation, another active grant preserving entitlement, unclaimed guest grant revocation without an entitlement, event processing atomicity, and monotonic succeeded state.

Force allocation/projection/email/audit/event failure and prove rollback. Prove access-change mail appears once only when `beforeActive !== afterActive`, and contains no email/provider/refund amount in audit.

Run `npm run test:integration -- tests/integration/commerce-refunds.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement locked refund import/allocation**

Lock event, payment, order, all order refunds/allocations/items, affected purchase grants, then sorted user/title scopes. Recompute allocation from complete canonical local refund state; never increment from event deltas. Persist refund state and Plan 6B reconciliation `pending`/`exception`. Once a grant is fully refund-revoked, never reactivate it.

Project only claimed-user scopes. Enqueue one versioned refund access-change message per effective user access change, append aggregate minimized audit, and mark the Stripe event processed in the same transaction. Ambiguous partial multi-title refund completes as an inspectable permanent exception and does not fail/retry forever.

Run integration tests. Expected: PASS.

- [ ] **Step 5: Extend event dispatch and verify**

Route Refund-family event jobs to refund handler; unknown/mismatched object family is permanent. Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/server/commerce/refunds.test.ts src/lib/server/commerce/handler.test.ts
npm run test:integration -- tests/integration/commerce-refunds.test.ts tests/integration/commerce-grants.test.ts
git diff --check
```

Commit:

```powershell
git add src/lib/server/commerce tests/integration/commerce-refunds.test.ts
git commit -m "feat: reconcile refund access changes"
```

## Task 12: Suspend, restore, and revoke access from canonical disputes

**Files:**

- Create: `src/lib/server/commerce/disputes.ts`, `disputes.test.ts`
- Modify: `src/lib/server/commerce/handler.ts`, `handler.test.ts`
- Create: `tests/integration/commerce-disputes.test.ts`
- Modify: commerce access-change email tests

- [ ] **Step 1: Write failing dispute reduction tests**

Reduce all canonical dispute rows for one payment with precedence `lost -> revoked`, else any `open -> suspended`, else all `won -> otherwise-valid grant state`. Won restoration must re-evaluate full succeeded refund allocations and permanent grant revocation; it cannot blindly activate. Preserved grants are outside dispute mutation.

Cover event-order permutations, duplicate rows, open->won, open->lost, won followed by out-of-order open event with canonical won retrieval, multiple disputes, and safe reason normalization. Run focused tests. Expected: FAIL then PASS after pure reducer.

- [ ] **Step 2: Write failing provider-call ordering tests**

Retrieve canonical Dispute then linked Payment outside a transaction. Canonical state—not triggering event name—drives the reduction. Provider mismatch/live/currency/payment errors become inspectable permanent exceptions; transient calls retry. Expected: FAIL until dispatch is implemented.

- [ ] **Step 3: Write failing dispute integration tests**

Cover:

- Open suspends all otherwise-active purchase grants funded by the payment.
- Won restores only grants not fully refunded/permanently revoked.
- Lost permanently revokes payment grants.
- Another active purchase/preserved grant keeps entitlement active.
- Unclaimed grants change state without granting access or sending an access-change email.
- Duplicate/out-of-order/concurrent jobs converge on canonical state.
- One access-change email is enqueued only when effective access changes.
- Payment/order/item facts remain immutable.
- Any grant/projection/email/audit/event failure rolls the transition back.

Run `npm run test:integration -- tests/integration/commerce-disputes.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement locked dispute lifecycle**

Lock event, payment, order, all payment disputes/refunds/allocations/grants, then sorted user/title scopes. Upsert canonical dispute by provider ID and recompute every affected purchase grant from complete payment facts. Store Plan 6B reconciliation state, project claimed grants, enqueue deduplicated access-change mail, append minimized aggregate audit, and mark event processed atomically.

Never store evidence, narratives, card/billing details, provider response, or full reason text. Clamp/map safe reason values.

Run integration tests. Expected: PASS.

- [ ] **Step 5: Extend dispatch, verify, and commit**

Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/server/commerce/disputes.test.ts src/lib/server/commerce/handler.test.ts
npm run test:integration -- tests/integration/commerce-disputes.test.ts tests/integration/commerce-refunds.test.ts
git diff --check
```

Commit:

```powershell
git add src/lib/server/commerce tests/integration/commerce-disputes.test.ts
git commit -m "feat: reconcile dispute access changes"
```

## Task 13: Wire the storefront cart, Checkout redirect, and success experience

**Files:**

- Modify: `src/lib/components/Header.svelte` and its tests
- Modify: catalog/title card components and tests
- Modify: `src/routes/+page.svelte`, `src/routes/catalog/+page.svelte`, `src/routes/book/[id]/+page.svelte`
- Create: `src/routes/cart/+page.server.ts`, `+page.svelte`, page tests
- Create: `src/routes/checkout/success/+page.server.ts`, `+page.svelte`, page tests
- Create: `src/routes/checkout/cancel/+server.ts`, route test
- Modify: `src/routes/library/+page.svelte` copy only where purchase guidance changes
- Create: `src/lib/commerce/checkout-client.ts`, `checkout-client.test.ts`

- [ ] **Step 1: Write failing component/store interaction tests**

Cover accessible Add/Remove button names, disabled states for owned/unavailable titles, cart count announcement without focus theft, header link/count, duplicate add, 25-title cap, and keyboard operation. Existing catalog/title loaders remain server-authoritative; components receive safe title IDs and state only.

Run focused component tests. Expected: FAIL.

- [ ] **Step 2: Implement catalog/title/header cart controls**

Use native buttons/links and visible focus. Keep card navigation separate from cart button activation. Header renders “Cart, N items” accessibly and an `aria-live=polite` count message. Remove every “checkout not connected/unavailable” prototype statement from development storefront pages, but do not claim production is live.

Run component tests. Expected: PASS.

- [ ] **Step 3: Write failing cart-page behavior tests**

Cover empty, loading, current quote, owned, unavailable, mixed-currency, price-changed, disabled-provider, transient failure, canceled-return, and retry states. Currency uses `Intl.NumberFormat` only for display. Show “Tax calculated at checkout” beside tax-exclusive prices. Never parse formatted currency.

Checkout behavior must require explicit re-confirmation after `CART_CHANGED`: first response updates quote and presents alert; only another deliberate click submits the new fingerprint. Prevent double-submit while a request is pending.

Expected: FAIL.

- [ ] **Step 4: Implement quote-backed cart review**

On mount and cart change, POST only IDs to quote. Abort stale requests and ignore out-of-order responses. Render rejected requested IDs generically without private metadata. Offer remove-owned/unavailable controls. Checkout POST sends IDs/fingerprint/attempt UUID and navigates with `window.location.assign` only for a gateway-validated `https://checkout.stripe.com` URL (or the injected test adapter's exact test URL). Reject arbitrary external schemes/hosts.

Before navigation, put only the accepted title IDs and attempt UUID in bounded `sessionStorage` pending-checkout state. This permits paid cleanup after the hosted redirect without adding price/order/email/provider data to persistent cart storage.

Run cart page/client tests. Expected: PASS.

- [ ] **Step 5: Write failing success/cancel polling tests**

Success loader accepts only an order UUID query value and exposes no status itself. Browser polls private status every two seconds with immediate first request, stops on terminal state/navigation/abort or after 60 seconds, and never calls Stripe/fulfillment. It renders delayed-payment pending guidance, account library action, guest check-email guidance without displaying email, safe failed/expired/exception recovery, and a timeout refresh action.

On paid/paid_guest, remove only pending accepted title IDs from the current cart and create a fresh attempt UUID; titles added afterward remain. On failed/expired keep cart contents. Cancel clears pending session state but keeps the cart, then redirects 303 to `/cart?canceled=1`.

Expected: FAIL.

- [ ] **Step 6: Implement accessible success/cancel experience**

Use `role=status` for pending/paid and `role=alert` only for actionable failure. Do not automatically navigate to library or claim. Clean intervals/abort controllers on destroy. Status URL contains only order UUID; status credential stays in HttpOnly cookie.

Run page/route/polling tests. Expected: PASS.

- [ ] **Step 7: Verify and commit Task 13**

Run:

```powershell
npm run check
npm run lint
npx vitest run src/lib/commerce src/lib/components src/routes/cart src/routes/checkout src/routes/catalog src/routes/book
git diff --check
```

Commit:

```powershell
git add src/lib/components src/lib/commerce src/routes/+page.svelte src/routes/catalog src/routes/book src/routes/cart src/routes/checkout src/routes/library/+page.svelte
git commit -m "feat: connect storefront checkout experience"
```

## Task 14: Complete PostgreSQL, route, and browser commerce journeys

**Files:**

- Create/modify: `tests/fixtures/stripe/**`
- Create: `tests/e2e/cart-checkout.spec.ts`
- Create: `tests/e2e/guest-claim.spec.ts`
- Create: `tests/e2e/commerce-lifecycle.spec.ts`
- Modify: E2E database/Mailpit/auth helpers
- Modify: `playwright.config.ts`
- Modify: `scripts/with-test-database.ts` if worker fixture injection needs explicit test settings
- Modify: removed-prototype-route assertions

- [ ] **Step 1: Build a non-production provider test harness**

Configure `STRIPE_TEST_FIXTURE_MODE=true`, `STRIPE_ENABLED=false`, and no real keys only in Playwright's `APP_ENV=test` processes. The fixture gateway returns deterministic provider-neutral snapshots and a nonsecret mock hosted URL but exposes no HTTP route that marks an order paid.

Playwright-side helpers may import server test utilities to submit locally signed minimal events and run the production handler against the fixture gateway/database. This seam must be unreachable when `APP_ENV` is development/production and must not exist in route manifests as `/test`, `/fake-payment`, or `/mark-paid`.

Run a security test that every non-test configuration rejects fixture mode.

- [ ] **Step 2: Add the signed-in multi-title journey**

Publish at least two positive-price same-currency fixtures. Test add/remove/persist across navigation, server quote, changed price requiring explicit confirmation, fixture Checkout creation, signed event/canonical fulfillment, success polling, paid cart cleanup, library/reader/download access, and immutable paid snapshots after later catalog edit.

- [ ] **Step 3: Add the guest claim journey**

Test guest Checkout, unclaimed no-access boundary, signed fulfillment, Mailpit combined receipt/claim, one-use magic link, account creation/sign-in, claim of all same-email purchases, replay idempotency, and library access. Add the matching unverified password-account path: receipt plus verification callback, then claim after verification.

Never assert/render raw email outside Mailpit test inspection or log an action URL.

- [ ] **Step 4: Add delayed/refund/dispute journeys**

Test completed-unpaid pending UI, later async success, async failure without access, full item refund revocation, partial multi-title exception/no guessed revocation, another preserved/purchase grant preserving access, open-dispute suspension, won restoration, and lost revocation. Use fixture canonical state, not event-name shortcuts.

- [ ] **Step 5: Add abuse/error/privacy journeys**

Cover mixed currency, already-owned item, unavailable title, 26 items, duplicate checkout submit, invalid signature, duplicate webhook, live-mode mismatch, unauthorized/expired/rotated order status, generic claim request enumeration resistance, disabled Stripe 503, and removed prototype commerce paths remaining 404.

Search captured page content, response DTOs, logs, audits, and database fixtures for forbidden secret/card/address/raw-event fields.

- [ ] **Step 6: Run focused and full browser/database tests**

Run:

```powershell
npm run test:integration
npm run test:e2e -- tests/e2e/cart-checkout.spec.ts tests/e2e/guest-claim.spec.ts tests/e2e/commerce-lifecycle.spec.ts
npm run test:e2e
```

Expected: all integration suites and all browser journeys pass without a real network request to Stripe.

- [ ] **Step 7: Verify and commit Task 14**

Run:

```powershell
npm run check
npm run lint
npm run test:unit
npm run test:database
git diff --check
```

Commit:

```powershell
git add tests playwright.config.ts scripts/with-test-database.ts
git commit -m "test: cover stripe commerce lifecycle"
```

Stage `scripts/with-test-database.ts` only if changed.

## Task 15: Document operations, validate Compose, and run release gates

**Files:**

- Create: `docs/commerce-and-guest-claims.md`
- Modify: `README.md`
- Modify: `docs/runtime-environments.md`
- Modify: `docs/database-and-workers.md`
- Modify: `docs/authentication-and-email.md`
- Modify: `docs/customer-library-and-reader.md`
- Modify: `docs/dependency-decisions.md`
- Modify: `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md` only to record Plan 6A completion status after verification
- Modify: `compose.prod.yaml`
- Create: `compose.stripe.yaml`
- Modify: `compose.dev.yaml` only if explicit disabled defaults are needed beyond `.env`
- Modify: deployment/runbook validation tests

- [ ] **Step 1: Write the commerce/claim runbook**

Document:

- Disabled-by-default development and production behavior.
- Exact nonsecret settings, API version `2026-07-29.dahlia`, 30-minute sessions, webhook tolerance, tax-exclusive prices, format tax codes, Dashboard-managed payment methods, and delayed-payment behavior.
- Local Mailpit receipt, guest claim, unverified-password fallback, refund, dispute, job retry, event/order/payment/grant/audit diagnosis.
- Stripe Dashboard remains the refund/dispute-response UI.
- Partial multi-title refund exceptions await Plan 6B allocation.
- Plan 6B fee/balance/payout/reconciliation/dashboard work and production launch gate remain incomplete.
- Secrets are never pasted into chat, committed, logged, included in diagnostics, or stored in `.env.example` as real values.

- [ ] **Step 2: Add disabled production baseline and opt-in secret overlay**

Put nonsecret Stripe/commerce defaults in the shared production environment with `STRIPE_ENABLED=false`, fixture false, and maintenance unchanged. Base `compose.prod.yaml` must validate/start without Stripe credentials.

Create `compose.stripe.yaml` as an explicit future/manual overlay that sets enabled mode for app/worker and mounts environment-backed Compose secrets:

```yaml
services:
  app:
    environment:
      STRIPE_ENABLED: "true"
      STRIPE_SECRET_KEY_FILE: /run/secrets/stripe_secret_key
      STRIPE_WEBHOOK_SECRET_FILE: /run/secrets/stripe_webhook_secret
    secrets: [stripe_secret_key, stripe_webhook_secret]
  worker:
    environment:
      STRIPE_ENABLED: "true"
      STRIPE_SECRET_KEY_FILE: /run/secrets/stripe_secret_key
      STRIPE_WEBHOOK_SECRET_FILE: /run/secrets/stripe_webhook_secret
    secrets: [stripe_secret_key, stripe_webhook_secret]
secrets:
  stripe_secret_key:
    environment: STRIPE_SECRET_KEY
  stripe_webhook_secret:
    environment: STRIPE_WEBHOOK_SECRET
```

Review Compose merge output to ensure existing database/auth/SMTP secrets remain mounted. Do not use this overlay to leave maintenance mode in Plan 6A.

- [ ] **Step 3: Validate documentation and Compose with dummy process values**

Use only clearly fake validation values in the shell environment. Run base dev, base prod, and prod-plus-Stripe overlay `docker compose ... config --quiet`; verify rendered config does not print actual local secrets because none are supplied. Then clear the dummy shell variables.

Expected: base production validates without Stripe secrets; overlay requires both environment-backed secrets; all services retain intended settings; production remains maintenance.

- [ ] **Step 4: Run the complete automated release gate**

Run from a clean service/test state:

```powershell
npm run db:check
npm run check
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
npm audit --omit=dev --audit-level=high
git diff --check
git status --short
```

Expected: every command exits zero; no unexplained high/critical production advisory; all commerce tests use fixtures; working tree contains only intended Task 15 docs/Compose edits.

- [ ] **Step 5: Build and smoke the production image with Stripe disabled**

Build the production image, apply migration in an isolated disposable Compose project, and start the maintenance baseline. Assert `/health/live` and `/health/ready` succeed; storefront/commerce/webhook paths remain maintenance/disabled as designed; worker becomes ready; migration backfill is idempotent; and no Stripe credential is required.

Tear down only the explicitly named disposable project and its disposable volumes after resolving and checking its exact project name. Do not remove the user's ordinary development volumes.

- [ ] **Step 6: Pause for the optional manual Stripe test-mode checkpoint**

At this point—and not earlier—tell the user automated implementation is green and ask them to place their own test credentials in the ignored local `.env`:

```dotenv
STRIPE_ENABLED=true
STRIPE_TEST_FIXTURE_MODE=false
STRIPE_LIVE_MODE=false
STRIPE_SECRET_KEY=sk_test_REPLACE_LOCALLY
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_WITH_STRIPE_CLI_OUTPUT
```

They should start Stripe CLI forwarding without sharing its secret:

```powershell
stripe listen --forward-to http://localhost:5173/api/webhooks/stripe
```

After they update `.env`, restart app and worker. Perform one hosted test Checkout for account and guest, delayed method if enabled, signed webhook fulfillment, Mailpit claim, test Dashboard refund, and test dispute fixture where supported. Inspect minimized rows/audit/logs and confirm no raw/provider secrets. Restore `STRIPE_ENABLED=false` after the manual test unless the user explicitly wants it left enabled locally.

If the user declines or has not supplied local credentials, skip only this optional manual step; automated completion remains valid. Never fabricate credentials or ask them to paste values into chat.

- [ ] **Step 7: Update roadmap completion only after gates pass**

Mark Plan 6A implemented in the full-stack roadmap, leave Plan 6B pending, and retain the production maintenance warning. Record actual final dependency/test counts and any accepted advisory disposition in docs.

- [ ] **Step 8: Commit Task 15**

Run `git diff --check` and inspect `git status --short`, then commit:

```powershell
git add README.md docs compose.dev.yaml compose.prod.yaml compose.stripe.yaml
git commit -m "docs: add commerce operations runbook"
```

Stage `compose.dev.yaml` only if changed.

- [ ] **Step 9: Request final code review and address findings**

Use `superpowers:requesting-code-review` against the full Plan 6A branch diff. Review for authorization, amount/currency correctness, lock order, transaction/provider boundaries, event idempotency, monotonic state, outbox deduplication, PII/secret minimization, claim identity, refund allocation, dispute restoration, fixture isolation, accessibility, and Plan 6B scope leakage.

Apply accepted findings with `superpowers:receiving-code-review` and `superpowers:test-driven-development`. Re-run the smallest proving test first, then the full gate in Step 4. Commit review fixes separately with a precise message.

- [ ] **Step 10: Offer integration choices**

After the final reviewed branch is clean and green, use `superpowers:finishing-a-development-branch` and offer the user its structured merge/PR/keep/discard options. Do not merge, push, or delete the worktree without the user's explicit choice.

## Acceptance traceability

| Approved acceptance criterion | Proving tasks |
| --- | --- |
| Bounded multi-title, quantity-one browser cart | 1, 4, 13, 14 |
| Server refuses silent price/availability/ownership changes | 4, 6, 14 |
| Immutable accepted order/item snapshots and 30-minute price hold | 2, 6, 8, 14 |
| Stripe-hosted Checkout with eligible Dashboard methods | 5, 6, 14, 15 |
| Tax-exclusive prices and optional Stripe Tax | 1, 5, 8, 13, 15 |
| Only signed asynchronous processing can fulfill | 5, 7, 8, 14 |
| Duplicate/delayed/out-of-order events cannot duplicate or regress | 7, 8, 11, 12, 14 |
| Paid account order atomically creates active access | 2, 3, 8, 9, 14 |
| Paid guest order remains unclaimed/no-access | 2, 3, 8, 9, 10, 14 |
| Verified normalized email claims all eligible purchases | 9, 10, 14 |
| Unverified password account uses verification fallback | 9, 10, 14 |
| Full item refunds revoke only their grant; ambiguous partial multi-title stays exception | 11, 14 |
| Open/won/lost disputes suspend/restore/revoke purchase grants | 12, 14 |
| Another active purchase/preserved grant preserves effective access | 2, 3, 11, 12, 14 |
| Existing active Plan 5 entitlements survive migration | 2, 3 |
| No prohibited provider/identity/secret data is persisted or exposed | 2, 5-12, 14, 15 |
| Full quality gates pass with Stripe disabled and production stays maintenance | 14, 15 |
| Fee/balance/payout/reporting work remains a stable Plan 6B seam | 2, 8, 11, 12, 15 |

## Executor notes

- Work only in the dedicated Plan 6A worktree/branch created for this plan. Do not edit or commit from local `main` during implementation.
- At the start of each task, read the named files and the approved design section it implements. Repository state may have shifted during earlier tasks; preserve unrelated user changes.
- Follow strict red/green/refactor: run the specified failing test before implementation, make the smallest coherent implementation, then run focused and regression gates.
- Check off each completed step in this plan as execution evidence. Do not pre-check future steps.
- Use `apply_patch` for hand edits and Drizzle Kit only for generated migrations/metadata. Inspect generated SQL before applying it.
- Never solve a failing concurrency test by adding sleeps. Use deferred promises, explicit barriers, lock timeouts, and post-lock re-reads.
- Never hold a database transaction or pooled connection across Stripe/SMTP calls. The Better Auth magic-link preparation is a durable worker step for the same reason.
- Do not broaden DTOs, logs, audits, fixtures, or emails to make tests easier. Extend test helpers at the provider-neutral/domain boundary.
- No automated command requires a real Stripe account. If a command unexpectedly asks for credentials before Task 15 Step 6, stop and fix the disabled/fixture seam instead of requesting secrets.
- If official Stripe event names/API behavior or installed dependency versions differ at implementation time, consult current official documentation, update the adapter/tests/design record explicitly, and do not silently improvise.
- Before every task commit, inspect `git diff --check`, `git status --short`, and the staged diff. Never stage `.env`, local storage, worker-ready files, test artifacts, Stripe CLI files, or real secrets.
