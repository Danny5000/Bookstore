import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { refunds } from '$lib/server/db/schema';
import { validEpubFixture } from '../fixtures/publications';
import { registerAndVerifyCustomer } from './customer-session';
import { createCommerceHarness } from './commerce-harness';
import { assertCommercePrivacy } from './commerce-privacy';
import { publishCommerceProse } from './commerce-publication';
import { openE2EDatabase } from './database';
import {
  administrator,
  baseURL,
  waitForHydratedHandler
} from './publication-admin';

async function startAccountCheckout(
  page: Page,
  context: BrowserContext,
  slugsToAdd: readonly string[]
): Promise<string> {
  for (const slug of slugsToAdd) {
    await page.goto(`/book/${slug}`);
    const add = page.getByRole('button', { name: /Add .* to cart/u });
    await waitForHydratedHandler(add);
    await add.click();
  }
  await page.goto('/cart');
  const checkout = page.getByRole('button', { name: 'Continue to checkout' });
  await waitForHydratedHandler(checkout);
  const hostedRequest = page.waitForRequest('https://checkout.stripe.test/**');
  await checkout.click();
  const orderId = new URL((await hostedRequest).url()).pathname.split('/').at(-1);
  if (!orderId) throw new Error('Fixture checkout URL did not contain an order ID');
  await page.goto(`/checkout/success?order=${orderId}`);
  await expect(page.getByRole('status')).toContainText('Confirming your purchase');
  return orderId;
}

async function cartAttempt(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('paleorbit.cart.v1') ?? '{}') as {
      checkoutAttemptId?: string;
    };
    return state.checkoutAttemptId ?? '';
  });
}

test('delayed payments, refunds, preserved grants, and disputes converge on effective access', async ({
  browser
}) => {
  test.setTimeout(360_000);
  const suffix = randomUUID();
  const email = `${suffix}@example.com`;
  const database = await openE2EDatabase();
  const commerce = createCommerceHarness(database, baseURL);
  const { context: adminContext, page: adminPage } = await administrator(browser);
  const customerContext = await browser.newContext({ baseURL });
  await customerContext.route('https://checkout.stripe.test/**', (route) => route.abort());
  const customerPage = await registerAndVerifyCustomer(customerContext, {
    email,
    password: 'plan-six-lifecycle-password-2026',
    displayName: 'Lifecycle Customer'
  });
  const browserLogs: string[] = [];
  const orderIds: string[] = [];
  customerPage.on('console', (message) => browserLogs.push(message.text()));

  try {
    const first = await publishCommerceProse(adminPage, {
      slug: `lifecycle-first-${suffix}`,
      title: 'Lifecycle First Book',
      bytes: validEpubFixture()
    });
    const second = await publishCommerceProse(adminPage, {
      slug: `lifecycle-second-${suffix}`,
      title: 'Lifecycle Second Book',
      bytes: validEpubFixture()
    });

    const delayedOrder = await startAccountCheckout(customerPage, customerContext, [first.slug]);
    orderIds.push(delayedOrder);
    await commerce.fulfillCheckout(delayedOrder, { state: 'pending', email });
    await expect(customerPage.getByRole('status')).toContainText('Confirming your purchase');
    expect((await customerContext.request.get(`/library/${first.titleId}/download`)).status())
      .toBe(404);
    await commerce.fulfillCheckout(delayedOrder, { state: 'paid', email });
    await expect(customerPage.getByRole('status')).toContainText('Purchase complete', {
      timeout: 10_000
    });
    expect((await customerContext.request.get(`/library/${first.titleId}/download`)).status())
      .toBe(200);
    await commerce.fulfillRefund(delayedOrder);
    expect((await customerContext.request.get(`/library/${first.titleId}/download`)).status())
      .toBe(404);

    const failedOrder = await startAccountCheckout(customerPage, customerContext, [second.slug]);
    orderIds.push(failedOrder);
    const failedAttempt = await cartAttempt(customerPage);
    await commerce.fulfillCheckout(failedOrder, { state: 'pending', email });
    await commerce.fulfillCheckout(failedOrder, { state: 'failed', email });
    await expect(customerPage.getByRole('alert')).toContainText('Payment was not completed', {
      timeout: 10_000
    });
    await expect.poll(() => cartAttempt(customerPage)).not.toBe(failedAttempt);
    expect((await customerContext.request.get(`/library/${second.titleId}/download`)).status())
      .toBe(404);

    const multiOrder = await startAccountCheckout(customerPage, customerContext, [first.slug]);
    orderIds.push(multiOrder);
    await commerce.fulfillCheckout(multiOrder, { state: 'paid', email });
    await expect(customerPage.getByRole('status')).toContainText('Purchase complete', {
      timeout: 10_000
    });
    const multiSnapshot = await commerce.orderSnapshot(multiOrder);
    expect(multiSnapshot.items).toHaveLength(2);

    const partialRefundId = await commerce.fulfillRefund(multiOrder, { amountMinor: 100 });
    const [partialRefund] = await database.db
      .select({ reconciliationStatus: refunds.reconciliationStatus })
      .from(refunds)
      .where(eq(refunds.stripeRefundId, partialRefundId))
      .limit(1);
    expect(partialRefund?.reconciliationStatus).toBe('exception');
    expect((await customerContext.request.get(`/library/${first.titleId}/download`)).status())
      .toBe(200);
    expect((await customerContext.request.get(`/library/${second.titleId}/download`)).status())
      .toBe(200);

    await database.grantEntitlement(email, first.titleId);
    await commerce.fulfillRefund(multiOrder, {
      amountMinor: multiSnapshot.subtotalMinor - 100
    });
    expect((await customerContext.request.get(`/library/${first.titleId}/download`)).status())
      .toBe(200);
    expect((await customerContext.request.get(`/library/${second.titleId}/download`)).status())
      .toBe(404);

    const disputedOrder = await startAccountCheckout(customerPage, customerContext, [second.slug]);
    orderIds.push(disputedOrder);
    await commerce.fulfillCheckout(disputedOrder, { state: 'paid', email });
    await expect(customerPage.getByRole('status')).toContainText('Purchase complete', {
      timeout: 10_000
    });
    const opened = await commerce.fulfillDispute(disputedOrder, { state: 'open' });
    expect((await customerContext.request.get(`/library/${second.titleId}/download`)).status())
      .toBe(404);
    await commerce.fulfillDispute(disputedOrder, {
      state: 'won',
      providerDisputeId: opened.providerDisputeId,
      providerCreatedAt: opened.providerCreatedAt
    });
    expect((await customerContext.request.get(`/library/${second.titleId}/download`)).status())
      .toBe(200);

    const lost = await commerce.fulfillDispute(disputedOrder, { state: 'open' });
    await commerce.fulfillDispute(disputedOrder, {
      state: 'lost',
      providerDisputeId: lost.providerDisputeId,
      providerCreatedAt: lost.providerCreatedAt
    });
    expect((await customerContext.request.get(`/library/${second.titleId}/download`)).status())
      .toBe(404);
    expect((await customerContext.request.get(`/library/${first.titleId}/download`)).status())
      .toBe(200);
    assertCommercePrivacy('lifecycle browser', await customerPage.locator('body').innerText());
    assertCommercePrivacy('lifecycle console', browserLogs, [email]);
    assertCommercePrivacy('lifecycle database', await commerce.privacySnapshot(orderIds));
  } finally {
    await database.close();
    await customerContext.close();
    await adminContext.close();
  }
});
