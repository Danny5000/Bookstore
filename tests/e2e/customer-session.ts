import { expect, type BrowserContext, type Page } from '@playwright/test';
import { firstHttpLink, waitForLatestTextEmail } from './mailpit';
import { signIn, waitForHydratedHandler } from './publication-admin';

export async function registerAndVerifyCustomer(
  context: BrowserContext,
  input: { email: string; password: string; displayName?: string }
): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/');
  const open = page.locator('header').getByRole('button', { name: 'Sign in' });
  await waitForHydratedHandler(open);
  await open.click();
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Display name').fill(input.displayName ?? 'Plan 5 Reader');
  await page.getByLabel('Email').fill(input.email);
  await page.getByLabel('Password', { exact: true }).fill(input.password);
  await page.getByLabel('Confirm password').fill(input.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your email to finish registration.')).toBeVisible();
  const verificationLink = firstHttpLink(
    await waitForLatestTextEmail(input.email, 10_000, 'verify your email address')
  );
  await page.goto(verificationLink);
  await expect(page.locator('header').getByText(input.email)).toBeVisible();
  return page;
}

export async function signInCustomer(
  context: BrowserContext,
  email: string,
  password: string
): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/');
  await signIn(page, email, password);
  return page;
}
