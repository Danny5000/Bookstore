import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { firstHttpLink, waitForLatestTextEmail } from './mailpit';

const baseURL = 'http://127.0.0.1:4173';
const customerPassword = 'customer-admin-password-2026';

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
  await expect(page.locator('header').getByText(email)).toBeVisible();
}

async function registerAndVerifyCustomer(context: BrowserContext, email: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/');
  await openSignIn(page);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Display name').fill('Role Test Customer');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(customerPassword);
  await page.getByLabel('Confirm password').fill(customerPassword);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your email to finish registration.')).toBeVisible();
  const verificationLink = firstHttpLink(
    await waitForLatestTextEmail(email, 10_000, 'verify your email address')
  );
  await page.goto(verificationLink);
  await expect(page.locator('header').getByText(email)).toBeVisible();
  return page;
}

test('anonymous users are redirected away from administration', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/?auth=required$/);
});

test('server authorization and audited role controls govern admin access', async ({ browser }) => {
  test.setTimeout(120_000);
  const customerEmail = `${randomUUID()}@example.com`;
  const customerContext = await browser.newContext({ baseURL });
  const customerPage = await registerAndVerifyCustomer(customerContext, customerEmail);

  const forbidden = await customerPage.goto('/admin');
  expect(forbidden?.status()).toBe(403);
  const forged = await customerContext.request.post('/admin/users?/setAdmin', {
    form: { userId: randomUUID(), enabled: 'true' },
    maxRedirects: 0
  });
  expect((await forged.json()) as object).toMatchObject({ type: 'failure', status: 403 });

  const administratorContext = await browser.newContext({ baseURL });
  const administratorPage = await administratorContext.newPage();
  await administratorPage.goto('/');
  await signIn(administratorPage, 'admin@paleorbit.test', 'test-admin-password-2026');
  await administratorPage.goto('/admin');
  await expect(administratorPage.getByRole('heading', { name: 'Publication control room' })).toBeVisible();
  await administratorPage.getByRole('link', { name: 'Users', exact: true }).click();

  const customerRow = administratorPage.getByRole('row').filter({ hasText: customerEmail });
  const customerId = await customerRow.locator('input[name="userId"]').inputValue();
  await customerRow.getByRole('button', { name: 'Grant admin' }).click();
  await expect(customerRow.getByText(/customer · admin/)).toBeVisible();

  const bootstrapRow = administratorPage
    .getByRole('row')
    .filter({ hasText: 'admin@paleorbit.test' });
  const bootstrapId = await bootstrapRow.locator('input[name="userId"]').inputValue();
  await bootstrapRow.getByRole('button', { name: 'Revoke admin' }).click();

  try {
    await customerPage.goto('/');
    await signOut(customerPage);
    await signIn(customerPage, customerEmail, customerPassword);
    await customerPage.goto('/admin/users');
    await expect(customerPage.getByRole('heading', { name: 'Users' })).toBeVisible();
    const ownRow = customerPage.getByRole('row').filter({ hasText: customerEmail });
    await expect(ownRow.getByRole('button', { name: 'Revoke admin' })).toBeDisabled();
    const lastAdminAttempt = await customerContext.request.post('/admin/users?/setAdmin', {
      form: { userId: customerId, enabled: 'false' },
      maxRedirects: 0
    });
    expect((await lastAdminAttempt.json()) as object).toMatchObject({
      type: 'failure',
      status: 409
    });
  } finally {
    await customerContext.request.post('/admin/users?/setAdmin', {
      form: { userId: bootstrapId, enabled: 'true' },
      maxRedirects: 0
    });
  }

  await administratorContext.close();
  await customerContext.close();
});
