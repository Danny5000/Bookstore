import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { entitlementGrants, orders, user } from '$lib/server/db/schema';
import { validEpubFixture } from '../fixtures/publications';
import { firstHttpLink, waitForLatestTextEmail } from './mailpit';
import { createCommerceHarness } from './commerce-harness';
import { assertCommercePrivacy } from './commerce-privacy';
import { publishCommerceProse } from './commerce-publication';
import { openE2EDatabase, type E2EDatabase } from './database';
import {
  administrator,
  baseURL,
  waitForHydratedHandler
} from './publication-admin';

test.describe.configure({ mode: 'serial' });

async function startGuestCheckout(
  page: Page,
  context: BrowserContext,
  title: { titleId: string; slug: string },
  terminalCheckoutAttemptId?: string
): Promise<{ orderId: string; checkoutAttemptId: string }> {
  await context.route('https://checkout.stripe.test/**', (route) => route.abort());
  await page.goto(`/book/${title.slug}`);
  const add = page.getByRole('button', { name: /Add .* to cart/u });
  await waitForHydratedHandler(add);
  await add.click();
  await page.getByRole('link', { name: 'Cart, 1 items' }).click();
  await expect(page).toHaveURL(/\/cart$/u);
  if (terminalCheckoutAttemptId) {
    await page.evaluate((attemptId) => {
      const key = 'paleorbit.cart.v1';
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as {
        version: number;
        titleIds: string[];
        checkoutAttemptId: string;
      };
      localStorage.setItem(key, JSON.stringify({
        ...stored,
        checkoutAttemptId: attemptId
      }));
    }, terminalCheckoutAttemptId);
    await page.reload();
    const terminalCheckout = page.getByRole('button', { name: 'Continue to checkout' });
    await waitForHydratedHandler(terminalCheckout);
    const conflictResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/commerce/checkout' && response.request().method() === 'POST';
    });
    await terminalCheckout.click();
    const conflictResponse = await conflictResponsePromise;
    if (conflictResponse.status() !== 409) {
      throw new Error(`Expected checkout attempt conflict; received HTTP ${conflictResponse.status()}`);
    }
    const conflictBody = await conflictResponse.json() as { code?: string };
    if (conflictBody.code !== 'CHECKOUT_ATTEMPT_CONFLICT') {
      throw new Error('Checkout attempt conflict returned an unexpected safe error');
    }
    await expect.poll(() => page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('paleorbit.cart.v1') ?? '{}') as {
        checkoutAttemptId?: string;
      };
      return stored.checkoutAttemptId;
    })).not.toBe(terminalCheckoutAttemptId);
  }
  const checkout = page.getByRole('button', { name: 'Continue to checkout' });
  await waitForHydratedHandler(checkout);
  const checkoutAttemptId = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('paleorbit.cart.v1') ?? '{}') as {
      checkoutAttemptId?: string;
    };
    if (!stored.checkoutAttemptId) throw new Error('Fixture cart had no checkout attempt');
    return stored.checkoutAttemptId;
  });
  const hostedRequest = page.waitForRequest('https://checkout.stripe.test/**');
  await checkout.click();
  const orderId = new URL((await hostedRequest).url()).pathname.split('/').at(-1);
  if (!orderId) throw new Error('Fixture checkout URL did not contain an order ID');
  await page.goto(`/checkout/success?order=${orderId}`);
  await expect(page.getByRole('status')).toContainText('Confirming your purchase');
  return { orderId, checkoutAttemptId };
}

async function expectClaimedGrantCount(
  database: E2EDatabase,
  email: string,
  titleId: string,
  count: number
): Promise<void> {
  const [account] = await database.db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!account) throw new Error('Claimed E2E account was not found');
  const grants = await database.db
    .select({ id: entitlementGrants.id })
    .from(entitlementGrants)
    .where(and(
      eq(entitlementGrants.userId, account.id),
      eq(entitlementGrants.titleId, titleId)
    ));
  expect(grants).toHaveLength(count);
}

async function assertTerminalCheckoutAttempt(
  database: E2EDatabase,
  orderId: string,
  checkoutAttemptId: string
): Promise<void> {
  const [order] = await database.db
    .select({
      status: orders.status,
      checkoutAttemptId: orders.clientCheckoutAttemptId
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (order?.status !== 'paid' || order.checkoutAttemptId !== checkoutAttemptId) {
    throw new Error('E2E terminal checkout-attempt setup was invalid');
  }
}

test('guest receipts claim every same-email purchase and reject action replay', async ({ browser }) => {
  test.setTimeout(360_000);
  const suffix = randomUUID();
  const guestEmail = `${suffix}@example.com`;
  const database = await openE2EDatabase();
  const commerce = createCommerceHarness(database, baseURL);
  const { context: adminContext, page: adminPage } = await administrator(browser);
  const guestContext = await browser.newContext({ baseURL });
  const guestPage = await guestContext.newPage();
  const replayContext = await browser.newContext({ baseURL });
  const browserLogs: string[] = [];
  guestPage.on('console', (message) => browserLogs.push(message.text()));
  const orderIds: string[] = [];
  try {
    const publishedTitle = await publishCommerceProse(adminPage, {
      slug: `guest-claim-${suffix}`,
      title: 'Guest Claim Book',
      bytes: validEpubFixture()
    });

    let completedCheckoutAttemptId: string | undefined;
    for (let purchase = 0; purchase < 2; purchase += 1) {
      const { orderId, checkoutAttemptId } = await startGuestCheckout(
        guestPage,
        guestContext,
        publishedTitle,
        completedCheckoutAttemptId
      );
      completedCheckoutAttemptId ??= checkoutAttemptId;
      orderIds.push(orderId);
      expect((await guestContext.request.get(`/library/${publishedTitle.titleId}/download`)).status())
        .toBe(401);
      await commerce.fulfillCheckout(orderId, { state: 'paid', email: guestEmail });
      await expect(guestPage.getByRole('status')).toContainText('Purchase complete', {
        timeout: 10_000
      });
      await expect(guestPage.getByRole('status')).toContainText('Check your email');
      await expect(guestPage.locator('main, section').first()).not.toContainText(guestEmail);
      assertCommercePrivacy(
        'guest browser',
        await guestPage.locator('body').innerText(),
        [guestEmail]
      );
      if (purchase === 0) {
        await assertTerminalCheckoutAttempt(database, orderId, checkoutAttemptId);
      }
    }

    const claimMessage = await waitForLatestTextEmail(
      guestEmail,
      15_000,
      'Claim your purchase'
    );
    const claimLink = firstHttpLink(claimMessage);
    await guestPage.goto(claimLink);
    await expect(guestPage.getByRole('heading', { name: 'Purchases claimed' })).toBeVisible();
    await expectClaimedGrantCount(database, guestEmail, publishedTitle.titleId, 2);
    await guestPage.getByRole('link', { name: 'Open your library' }).click();
    await expect(guestPage.getByRole('heading', { name: 'Guest Claim Book' })).toBeVisible();

    const replayPage = await replayContext.newPage();
    replayPage.on('console', (message) => browserLogs.push(message.text()));
    await replayPage.goto('/claim');
    const absentEmail = `${randomUUID()}@example.com`;
    await replayPage.getByLabel('Checkout email').fill(absentEmail);
    await replayPage.getByRole('button', { name: 'Send claim link' }).click();
    await expect(replayPage.getByRole('status')).toContainText('If eligible purchases exist');
    await expect(replayPage.locator('main')).not.toContainText(absentEmail);
    await replayPage.goto(claimLink);
    await expect(replayPage.getByRole('heading', { name: 'Link unavailable' })).toBeVisible();
    assertCommercePrivacy('guest browser', await guestPage.locator('body').innerText());
    assertCommercePrivacy(
      'guest browser',
      await replayPage.locator('body').innerText(),
      [absentEmail]
    );
    assertCommercePrivacy('guest console', browserLogs, [guestEmail, absentEmail, claimLink]);
    assertCommercePrivacy('guest database', await commerce.privacySnapshot(orderIds));
  } finally {
    await database.close();
    await replayContext.close();
    await guestContext.close();
    await adminContext.close();
  }
});

test('an unverified password account verifies before claiming its guest purchase', async ({ browser }) => {
  test.setTimeout(240_000);
  const suffix = randomUUID();
  const email = `${suffix}@example.com`;
  const password = 'plan-six-unverified-password-2026';
  const database = await openE2EDatabase();
  const commerce = createCommerceHarness(database, baseURL);
  const { context: adminContext, page: adminPage } = await administrator(browser);
  const guestContext = await browser.newContext({ baseURL });
  const guestPage = await guestContext.newPage();
  const accountContext = await browser.newContext({ baseURL });
  const accountPage = await accountContext.newPage();
  const browserLogs: string[] = [];
  guestPage.on('console', (message) => browserLogs.push(message.text()));
  accountPage.on('console', (message) => browserLogs.push(message.text()));
  try {
    const publishedTitle = await publishCommerceProse(adminPage, {
      slug: `unverified-claim-${suffix}`,
      title: 'Unverified Claim Book',
      bytes: validEpubFixture()
    });
    const { orderId } = await startGuestCheckout(guestPage, guestContext, publishedTitle);

    await accountPage.goto('/');
    const signIn = accountPage.locator('header').getByRole('button', { name: 'Sign in' });
    await waitForHydratedHandler(signIn);
    await signIn.click();
    await accountPage.getByRole('button', { name: 'Create an account' }).click();
    await accountPage.getByLabel('Display name').fill('Unverified Claim Customer');
    await accountPage.getByLabel('Email').fill(email);
    await accountPage.getByLabel('Password', { exact: true }).fill(password);
    await accountPage.getByLabel('Confirm password').fill(password);
    await accountPage.getByRole('button', { name: 'Create account' }).click();
    await expect(accountPage.getByText('Check your email to finish registration.')).toBeVisible();
    const initialVerification = firstHttpLink(
      await waitForLatestTextEmail(email, 10_000, 'verify your email address')
    );

    await commerce.fulfillCheckout(orderId, { state: 'paid', email });
    await expect(guestPage.getByRole('status')).toContainText('Purchase complete', {
      timeout: 10_000
    });
    assertCommercePrivacy(
      'guest browser',
      await guestPage.locator('body').innerText(),
      [email]
    );
    await waitForLatestTextEmail(email, 15_000, 'Subtotal:');

    await accountPage.goto(initialVerification);
    await accountPage.goto('/claim');
    await accountPage.getByLabel('Checkout email').fill(email);
    await accountPage.getByRole('button', { name: 'Send claim link' }).click();
    await expect(accountPage.getByRole('status')).toContainText('If eligible purchases exist');
    const claimLink = firstHttpLink(
      await waitForLatestTextEmail(email, 15_000, 'Claim your purchase')
    );
    await accountPage.goto(claimLink);
    await expect(accountPage.getByRole('heading', { name: 'Purchases claimed' })).toBeVisible();
    await expectClaimedGrantCount(database, email, publishedTitle.titleId, 1);
    assertCommercePrivacy('guest browser', await accountPage.locator('body').innerText());
    assertCommercePrivacy(
      'guest console',
      browserLogs,
      [email, initialVerification, claimLink]
    );
    assertCommercePrivacy('guest database', await commerce.privacySnapshot([orderId]));
  } finally {
    await database.close();
    await accountContext.close();
    await guestContext.close();
    await adminContext.close();
  }
});
