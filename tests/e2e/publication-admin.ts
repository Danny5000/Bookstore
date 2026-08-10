import {
  expect,
  type Browser,
  type BrowserContext,
  type Dialog,
  type Locator,
  type Page
} from '@playwright/test';

export const baseURL = 'http://127.0.0.1:4173';
export const administratorEmail = 'admin@paleorbit.test';
export const administratorPassword = 'test-admin-password-2026';

export async function waitForHydratedHandler(locator: Locator): Promise<void> {
  await expect
    .poll(() =>
      locator.evaluate((element) =>
        Object.getOwnPropertySymbols(element).some((symbol) => symbol.description === 'events')
      )
    )
    .toBe(true);
}

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  const open = page.locator('header').getByRole('button', { name: 'Sign in' });
  await waitForHydratedHandler(open);
  await open.click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.locator('header').getByText(email)).toBeVisible();
}

export async function signInAdministrator(page: Page): Promise<void> {
  await page.goto('/');
  await signIn(page, administratorEmail, administratorPassword);
}

export async function administrator(
  browser: Browser
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signInAdministrator(page);
  return { context, page };
}

export async function createTitle(
  page: Page,
  input: { slug: string; title: string; format: 'prose' | 'comic'; description: string }
): Promise<string> {
  await page.goto('/admin/catalog/new');
  await waitForHydratedHandler(page.getByRole('button', { name: 'Use Nocturne theme' }));
  await page.getByLabel('Title', { exact: true }).fill(input.title);
  await page.getByLabel('Slug').fill(input.slug);
  await page.getByLabel('Description').fill(input.description);
  await page.getByLabel('Creator').fill('Pale Orbit Test Press');
  await page.getByLabel('Format').selectOption(input.format);
  await page.getByLabel('Price').fill('1299');
  await page.getByLabel('Currency').fill('USD');
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(input.title);
  await expect(page.getByLabel('Slug')).toHaveValue(input.slug);
  const invalidControls = await page.locator('form.title-form').evaluate((form) =>
    Array.from((form as HTMLFormElement).elements)
      .filter(
        (control): control is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
          control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement ||
          control instanceof HTMLSelectElement
      )
      .filter((control) => !control.checkValidity())
      .map((control) => ({
        name: control.name,
        value: control.value,
        pattern: control instanceof HTMLInputElement ? control.pattern : '',
        message: control.validationMessage
      }))
  );
  expect(invalidControls).toEqual([]);
  await page.getByRole('button', { name: 'Create private title' }).click();
  await expect(page).toHaveURL(/\/admin\/catalog\/[0-9a-f-]{36}$/u);
  const titleId = page.url().split('/').at(-1);
  if (!titleId) throw new Error('Title ID was not present after creation');
  return titleId;
}

export async function uploadRevision(
  page: Page,
  input: { filename: string; mimeType: string; bytes: Buffer; summary: string }
): Promise<{ revisionId: string; reviewUrl: string }> {
  const uploadButton = page.getByRole('button', { name: 'Upload immutable revision' });
  await expect(uploadButton).toBeEnabled();
  await page.getByLabel('Corrected original').setInputFiles({
    name: input.filename,
    mimeType: input.mimeType,
    buffer: input.bytes
  });
  await page.getByLabel('Change summary').fill(input.summary);
  await uploadButton.click();
  await expect(page).toHaveURL(/\/revisions\/[0-9a-f-]{36}$/u, { timeout: 30_000 });
  const revisionId = page.url().split('/').at(-1);
  if (!revisionId) throw new Error('Revision ID was not present after upload');
  return { revisionId, reviewUrl: page.url() };
}

export async function waitUntilReady(page: Page): Promise<void> {
  const status = page.locator('section.status strong');
  await expect(status).toHaveText(/uploaded|processing|ready for review/u);
  await expect(status).toHaveText('ready for review', { timeout: 60_000 });
}

export async function selectBoundary(page: Page, text: string): Promise<void> {
  const select = page.getByLabel('Free preview ends after');
  const option = select.locator('option').filter({ hasText: text }).first();
  const value = await option.getAttribute('value');
  if (!value) throw new Error(`No preview option contained ${text}`);
  await select.selectOption(value);
}

export async function saveDraft(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save private draft' }).click();
  await expect(page.getByRole('heading', { name: 'Draft reader settings' })).toBeVisible();
}

export async function clickConfirmed(button: Locator): Promise<void> {
  const page = button.page();
  const acceptDialog = (dialog: Dialog) => {
    void dialog.accept();
  };
  page.on('dialog', acceptDialog);
  try {
    await button.click();
  } finally {
    page.off('dialog', acceptDialog);
  }
}

export async function publishSettings(page: Page): Promise<void> {
  await clickConfirmed(page.getByRole('button', { name: 'Publish reader settings' }));
  await expect(page.getByRole('heading', { name: 'Draft reader settings' })).toBeVisible();
}

export async function activateAndPublish(page: Page): Promise<void> {
  await clickConfirmed(page.getByRole('button', { name: 'Activate privately' }));
  await expect(page.locator('section.status strong')).toHaveText('active');
  await page.getByRole('link', { name: /Title$/u }).click();
  await clickConfirmed(page.getByRole('button', { name: 'Publish storefront' }));
}

export async function openReader(page: Page, kind: 'book' | 'comic'): Promise<void> {
  const open = page.getByRole('button', { name: `Open the ${kind}` });
  await waitForHydratedHandler(open);
  await open.click();
  await expect(open).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible({ timeout: 5_000 });
}
