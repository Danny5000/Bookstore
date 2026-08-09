import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { firstHttpLink, waitForLatestTextEmail } from './mailpit';

const originalPassword = 'customer-password-2026';
const newPassword = 'customer-new-password-2026';

async function waitForHydratedHandler(locator: Locator): Promise<void> {
  await expect
    .poll(() =>
      locator.evaluate((element) =>
        Object.getOwnPropertySymbols(element).some((symbol) => symbol.description === 'events')
      )
    )
    .toBe(true);
}

async function openSignIn(page: Page): Promise<void> {
  const button = page.locator('header').getByRole('button', { name: 'Sign in' });
  await waitForHydratedHandler(button);
  await button.click();
}

async function signOut(page: Page): Promise<void> {
  const button = page.locator('header').getByRole('button', { name: 'Sign out' });
  await waitForHydratedHandler(button);
  await button.click();
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await openSignIn(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
}

test('customer can complete password, reset, and magic-link journeys', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const email = `${randomUUID()}@example.com`;
  await page.goto('/');
  await openSignIn(page);
  await expect(page.getByRole('button', { name: /Google|Apple/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Display name').fill('Browser Reader');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(originalPassword);
  await page.getByLabel('Confirm password').fill(originalPassword);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your email to finish registration.')).toBeVisible();
  await expect(page.locator('header').getByRole('button', { name: 'Sign in' })).toBeVisible();

  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await page.getByRole('button', { name: 'Resend verification' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send verification link' }).click();
  await expect(page.getByText('If verification is available, a link is on its way.')).toBeVisible();

  const verificationLink = firstHttpLink(
    await waitForLatestTextEmail(email, 10_000, 'verify your email address')
  );
  await page.goto(verificationLink);
  await expect(page.locator('header').getByText(email)).toBeVisible();

  const cleanVerificationContext = await browser.newContext({
    baseURL: 'http://127.0.0.1:4173'
  });
  const cleanVerificationPage = await cleanVerificationContext.newPage();
  await cleanVerificationPage.goto(verificationLink);
  await expect(
    cleanVerificationPage.locator('header').getByRole('button', { name: 'Sign in' })
  ).toBeVisible();
  await cleanVerificationContext.close();

  await signOut(page);
  await expect(page.locator('header').getByRole('button', { name: 'Sign in' })).toBeVisible();
  await signIn(page, email, originalPassword);
  await expect(page.locator('header').getByText(email)).toBeVisible();

  await signOut(page);
  await openSignIn(page);
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(
    page.getByText('If an account exists for that address, a reset link is on its way.')
  ).toBeVisible();

  const resetLink = firstHttpLink(
    await waitForLatestTextEmail(email, 10_000, 'reset your password')
  );
  await page.goto(resetLink);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  const updatePassword = page.getByRole('button', { name: 'Update password' });
  await expect(updatePassword).toBeEnabled();
  await updatePassword.click();
  await expect(page.getByText('Your password has been updated.')).toBeVisible();
  await page.getByRole('link', { name: 'Return to sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(originalPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.locator('header').getByText(email)).toBeVisible();
  await expect(page).not.toHaveURL(/auth=/);
  await expect(page.getByRole('dialog')).not.toBeVisible();

  await signOut(page);
  await openSignIn(page);
  await page.getByRole('button', { name: 'Use a magic link' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByText('If sign-in is available, a link is on its way.')).toBeVisible();
  const magicLink = firstHttpLink(await waitForLatestTextEmail(email, 10_000, 'sign in'));
  await page.goto(magicLink);
  await expect(page.locator('header').getByText(email)).toBeVisible();

  const cleanMagicContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  const cleanMagicPage = await cleanMagicContext.newPage();
  await cleanMagicPage.goto(magicLink);
  await expect(cleanMagicPage).toHaveURL(/error=INVALID_TOKEN/);
  await expect(cleanMagicPage.locator('header').getByRole('button', { name: 'Sign in' })).toBeVisible();
  await cleanMagicContext.close();

  await signOut(page);
  await signIn(page, email, newPassword);
  await expect(page.locator('header').getByText(email)).toBeVisible();
});
