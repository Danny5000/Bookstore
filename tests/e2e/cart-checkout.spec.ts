import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { auditEvents, orders, payments, stripeEvents, titles } from '$lib/server/db/schema';
import { validEpubFixture } from '../fixtures/publications';
import { registerAndVerifyCustomer } from './customer-session';
import { createCommerceHarness } from './commerce-harness';
import { assertCommercePrivacy } from './commerce-privacy';
import { openE2EDatabase } from './database';
import { publishCommerceProse } from './commerce-publication';
import {
  administrator,
  baseURL,
  openReader,
  waitForHydratedHandler
} from './publication-admin';

test.describe.configure({ mode: 'serial' });

test('signed-in multi-title checkout keeps quotes, fulfillment, and access server-owned', async ({
  browser
}) => {
  test.setTimeout(360_000);
  const suffix = randomUUID();
  const customerEmail = `${suffix}@example.com`;
  const customerPassword = 'plan-six-customer-password-2026';
  const firstBytes = validEpubFixture();
  const secondBytes = validEpubFixture();
  const database = await openE2EDatabase();
  const commerce = createCommerceHarness(database, baseURL);
  const { context: adminContext, page: adminPage } = await administrator(browser);
  const customerContext = await browser.newContext({ baseURL });
  const anonymousContext = await browser.newContext({ baseURL });
  const customerPage = await registerAndVerifyCustomer(customerContext, {
    email: customerEmail,
    password: customerPassword,
    displayName: 'Plan Six Customer'
  });
  const browserLogs: string[] = [];
  customerPage.on('console', (message) => browserLogs.push(message.text()));

  try {
    const first = await publishCommerceProse(adminPage, {
      slug: `commerce-first-${suffix}`,
      title: 'Commerce First Book',
      bytes: firstBytes
    });
    const second = await publishCommerceProse(adminPage, {
      slug: `commerce-second-${suffix}`,
      title: 'Commerce Second Book',
      bytes: secondBytes
    });

    await customerContext.route('https://checkout.stripe.test/**', (route) => route.abort());
    let checkoutPosts = 0;
    customerPage.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/commerce/checkout' && request.method() === 'POST') {
        checkoutPosts += 1;
      }
    });
    await customerPage.goto('/catalog');
    const addFirst = customerPage.getByRole('button', { name: 'Add Commerce First Book to cart' });
    await waitForHydratedHandler(addFirst);
    await addFirst.click();
    await expect(customerPage.getByRole('link', { name: 'Cart, 1 items' })).toBeVisible();
    await customerPage.goto(`/book/${second.slug}`);
    await expect(customerPage.getByRole('link', { name: 'Cart, 1 items' })).toBeVisible();
    const addSecond = customerPage.getByRole('button', { name: 'Add Commerce Second Book to cart' });
    await waitForHydratedHandler(addSecond);
    await addSecond.click();
    await customerPage.getByRole('link', { name: 'Cart, 2 items' }).click();
    await expect(customerPage.getByText('Commerce First Book')).toBeVisible();
    await expect(customerPage.getByText('Commerce Second Book')).toBeVisible();
    await expect(customerPage.getByText('$25.98')).toBeVisible();

    await database.db
      .update(titles)
      .set({ priceMinor: 1499, updatedAt: new Date() })
      .where(eq(titles.id, second.titleId));
    const continueToCheckout = customerPage.getByRole('button', { name: 'Continue to checkout' });
    await waitForHydratedHandler(continueToCheckout);
    await continueToCheckout.click();
    await expect(customerPage.getByRole('alert')).toContainText('Your cart changed');
    await expect(customerPage.getByText('$27.98')).toBeVisible();

    const laterTitleId = randomUUID();
    await customerContext.addInitScript(({ titleId, origin }) => {
      if (location.origin !== origin || sessionStorage.getItem('e2e-later-cart-title')) return;
      const key = 'paleorbit.cart.v1';
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as {
        version: number;
        titleIds: string[];
        checkoutAttemptId: string;
      };
      localStorage.setItem(key, JSON.stringify({
        ...stored,
        titleIds: [...stored.titleIds, titleId]
      }));
      sessionStorage.setItem('e2e-later-cart-title', '1');
    }, { titleId: laterTitleId, origin: baseURL });
    const hostedRequest = customerPage.waitForRequest('https://checkout.stripe.test/**');
    const confirmUpdated = customerPage.getByRole('button', { name: 'Confirm updated cart' });
    await waitForHydratedHandler(confirmUpdated);
    await confirmUpdated.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    const hostedUrl = new URL((await hostedRequest).url());
    await expect.poll(() => checkoutPosts).toBe(2);
    const orderId = hostedUrl.pathname.split('/').at(-1);
    if (!orderId) throw new Error('Fixture checkout URL did not contain an order ID');

    await customerPage.goto(`/checkout/success?order=${orderId}`);
    await expect(customerPage.getByRole('status')).toContainText('Confirming your purchase');

    const paidEventId = `evt_test_${randomUUID().replaceAll('-', '')}`;
    await commerce.fulfillCheckout(orderId, {
      state: 'paid',
      email: customerEmail,
      eventId: paidEventId
    });
    await commerce.fulfillCheckout(orderId, {
      state: 'paid',
      email: customerEmail,
      eventId: paidEventId
    });
    await expect(customerPage.getByRole('status')).toContainText('Purchase complete', {
      timeout: 10_000
    });
    await expect(customerPage.getByRole('link', { name: 'Cart, 1 items' })).toBeVisible();
    await customerPage.getByRole('link', { name: 'Open your library' }).click();
    await expect(customerPage.getByRole('heading', { name: 'Commerce First Book' })).toBeVisible();
    await expect(customerPage.getByRole('heading', { name: 'Commerce Second Book' })).toBeVisible();

    await customerPage.goto(`/read/${first.titleId}`);
    await openReader(customerPage, 'book');
    await expect(customerPage.getByText('Second.', { exact: true })).toBeAttached();
    const download = await customerContext.request.get(`/library/${first.titleId}/download`);
    expect(download.status()).toBe(200);
    expect(await download.body()).toEqual(firstBytes);

    const paidSnapshot = await commerce.orderSnapshot(orderId);
    await database.db
      .update(titles)
      .set({ title: 'Edited After Purchase', priceMinor: 9999, updatedAt: new Date() })
      .where(eq(titles.id, first.titleId));
    expect(await commerce.orderSnapshot(orderId)).toEqual(paidSnapshot);
    expect(paidSnapshot.items.map((item) => item.titleSnapshot).sort()).toEqual([
      'Commerce First Book',
      'Commerce Second Book'
    ]);
    expect(paidSnapshot.items.map((item) => item.unitSubtotalMinor).sort()).toEqual([1299, 1499]);

    const unauthorizedStatus = await anonymousContext.request.get(
      `/api/commerce/orders/${orderId}/status`
    );
    expect(unauthorizedStatus.status()).toBe(404);
    assertCommercePrivacy('account response', await unauthorizedStatus.json());

    const invalidWebhook = await customerContext.request.post('/api/webhooks/stripe', {
      headers: { 'stripe-signature': 'invalid-fixture-signature' },
      data: { id: `evt_test_${randomUUID().replaceAll('-', '')}` }
    });
    expect(invalidWebhook.status()).toBe(400);
    assertCommercePrivacy('account response', await invalidWebhook.json());

    const oversizedCart = await customerContext.request.post('/api/commerce/quote', {
      headers: { origin: baseURL },
      data: { titleIds: Array.from({ length: 26 }, () => randomUUID()) }
    });
    expect(oversizedCart.status()).toBe(422);
    expect(await oversizedCart.json()).toEqual({ code: 'INVALID_INPUT' });

    for (const retiredPath of ['/api/checkout', '/api/stripe-webhook', '/api/deliver']) {
      expect((await customerContext.request.get(retiredPath)).status()).toBe(404);
    }

    const unavailableTitleId = randomUUID();
    await customerPage.evaluate(({ ownedId, unavailableId, attemptId }) => {
      localStorage.setItem('paleorbit.cart.v1', JSON.stringify({
        version: 1,
        titleIds: [ownedId, unavailableId],
        checkoutAttemptId: attemptId
      }));
    }, {
      ownedId: first.titleId,
      unavailableId: unavailableTitleId,
      attemptId: randomUUID()
    });
    await customerPage.goto('/cart');
    await expect(customerPage.getByRole('heading', { name: 'Already owned' })).toBeVisible();
    await expect(customerPage.getByRole('heading', { name: 'Unavailable' })).toBeVisible();
    await expect(customerPage.locator('body')).not.toContainText(unavailableTitleId);

    await database.db
      .update(titles)
      .set({ currency: 'CAD', updatedAt: new Date() })
      .where(eq(titles.id, second.titleId));
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto('/');
    await anonymousPage.evaluate(({ titleIds, attemptId }) => {
      localStorage.setItem('paleorbit.cart.v1', JSON.stringify({
        version: 1,
        titleIds,
        checkoutAttemptId: attemptId
      }));
    }, { titleIds: [first.titleId, second.titleId], attemptId: randomUUID() });
    await anonymousPage.goto('/cart');
    await expect(anonymousPage.getByRole('alert')).toContainText(
      'Items in different currencies must be checked out separately.'
    );
    await expect(anonymousPage.locator('body')).not.toContainText(first.titleId);
    await expect(anonymousPage.locator('body')).not.toContainText(second.titleId);

    const [storedOrder] = await database.db
      .select({ stripeCheckoutSessionId: orders.stripeCheckoutSessionId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!storedOrder?.stripeCheckoutSessionId) throw new Error('Paid order lost its session ID');
    const persistedEvents = await database.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.objectId, storedOrder.stripeCheckoutSessionId));
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]?.providerEventId).toBe(paidEventId);
    const persistedPayment = await database.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId));
    const orderAudits = await database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, orderId));
    expect(orderAudits.length).toBeGreaterThan(0);
    assertCommercePrivacy(
      'account database',
      { persistedEvents, persistedPayment, orderAudits }
    );
    assertCommercePrivacy(
      'account browser',
      [
        await customerPage.locator('main, section').first().innerText(),
        await anonymousPage.locator('main, section').first().innerText()
      ]
    );
    assertCommercePrivacy('account console', browserLogs, [customerEmail]);
  } finally {
    await database.close();
    await anonymousContext.close();
    await customerContext.close();
    await adminContext.close();
  }
});
