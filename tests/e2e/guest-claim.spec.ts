import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { entitlementGrants, user } from '$lib/server/db/schema';
import { validEpubFixture } from '../fixtures/publications';
import { firstHttpLink, waitForLatestTextEmail } from './mailpit';
import { createCommerceHarness } from './commerce-harness';
import { publishCommerceProse } from './commerce-publication';
import { openE2EDatabase, type E2EDatabase } from './database';
import {
  administrator,
  baseURL,
  waitForHydratedHandler
} from './publication-admin';

test.describe.configure({ mode: 'serial' });

let publishedTitle: { titleId: string; slug: string } | undefined;

async function startGuestCheckout(
  page: Page,
  context: BrowserContext,
  title: { titleId: string; slug: string }
): Promise<string> {
  await context.route('https://checkout.stripe.test/**', (route) => route.abort());
  await page.goto(`/book/${title.slug}`);
  const add = page.getByRole('button', { name: /Add .* to cart/u });
  await waitForHydratedHandler(add);
  await add.click();
  await page.getByRole('link', { name: 'Cart, 1 items' }).click();
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
  try {
    publishedTitle = await publishCommerceProse(adminPage, {
      slug: `guest-claim-${suffix}`,
      title: 'Guest Claim Book',
      bytes: validEpubFixture()
    });

    for (let purchase = 0; purchase < 2; purchase += 1) {
      const orderId = await startGuestCheckout(guestPage, guestContext, publishedTitle);
      expect((await guestContext.request.get(`/library/${publishedTitle.titleId}/download`)).status())
        .toBe(401);
      await commerce.fulfillCheckout(orderId, { state: 'paid', email: guestEmail });
      await expect(guestPage.getByRole('status')).toContainText('Purchase complete', {
        timeout: 10_000
      });
      await expect(guestPage.getByRole('status')).toContainText('Check your email');
      await expect(guestPage.locator('main, section').first()).not.toContainText(guestEmail);
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
    await replayPage.goto('/claim');
    const absentEmail = `${randomUUID()}@example.com`;
    await replayPage.getByLabel('Checkout email').fill(absentEmail);
    await replayPage.getByRole('button', { name: 'Send claim link' }).click();
    await expect(replayPage.getByRole('status')).toContainText('If eligible purchases exist');
    await expect(replayPage.locator('main')).not.toContainText(absentEmail);
    await replayPage.goto(claimLink);
    await expect(replayPage.getByRole('heading', { name: 'Link unavailable' })).toBeVisible();
  } finally {
    await database.close();
    await replayContext.close();
    await guestContext.close();
    await adminContext.close();
  }
});

test('an unverified password account verifies before claiming its guest purchase', async ({ browser }) => {
  test.setTimeout(240_000);
  if (!publishedTitle) throw new Error('The serial guest title fixture was not created');
  const email = `${randomUUID()}@example.com`;
  const password = 'plan-six-unverified-password-2026';
  const database = await openE2EDatabase();
  const commerce = createCommerceHarness(database, baseURL);
  const guestContext = await browser.newContext({ baseURL });
  const guestPage = await guestContext.newPage();
  const accountContext = await browser.newContext({ baseURL });
  const accountPage = await accountContext.newPage();
  try {
    const orderId = await startGuestCheckout(guestPage, guestContext, publishedTitle);

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
  } finally {
    await database.close();
    await accountContext.close();
    await guestContext.close();
  }
});
