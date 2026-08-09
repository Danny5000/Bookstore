import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Dialog, type Locator, type Page } from '@playwright/test';
import { strToU8 } from 'fflate';
import { validComicFixture, validEpubFixture } from '../fixtures/publications';

const baseURL = 'http://127.0.0.1:4173';
const administratorEmail = 'admin@paleorbit.test';
const administratorPassword = 'test-admin-password-2026';

async function waitForHydratedHandler(locator: Locator): Promise<void> {
  await expect.poll(() => locator.evaluate((element) =>
    Object.getOwnPropertySymbols(element).some((symbol) => symbol.description === 'events')
  )).toBe(true);
}

async function signInAdministrator(page: Page): Promise<void> {
  await page.goto('/');
  const open = page.locator('header').getByRole('button', { name: 'Sign in' });
  await waitForHydratedHandler(open);
  await open.click();
  await page.getByLabel('Email').fill(administratorEmail);
  await page.getByLabel('Password', { exact: true }).fill(administratorPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.locator('header').getByText(administratorEmail)).toBeVisible();
}

async function administrator(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signInAdministrator(page);
  return { context, page };
}

async function createTitle(
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
      .filter((control): control is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
        control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement
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

async function uploadRevision(
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

async function waitUntilReady(page: Page): Promise<void> {
  const status = page.locator('section.status strong');
  await expect(status).toHaveText(/uploaded|processing|ready for review/u);
  await expect(status).toHaveText('ready for review', { timeout: 60_000 });
}

async function selectBoundary(page: Page, text: string): Promise<void> {
  const select = page.getByLabel('Free preview ends after');
  const option = select.locator('option').filter({ hasText: text }).first();
  const value = await option.getAttribute('value');
  if (!value) throw new Error(`No preview option contained ${text}`);
  await select.selectOption(value);
}

async function saveDraft(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save private draft' }).click();
  await expect(page.getByRole('heading', { name: 'Draft reader settings' })).toBeVisible();
}

async function clickConfirmed(button: Locator): Promise<void> {
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

async function publishSettings(page: Page): Promise<void> {
  await clickConfirmed(page.getByRole('button', { name: 'Publish reader settings' }));
  await expect(page.getByRole('heading', { name: 'Draft reader settings' })).toBeVisible();
}

async function openReader(page: Page, kind: 'book' | 'comic'): Promise<void> {
  const open = page.getByRole('button', { name: `Open the ${kind}` });
  await waitForHydratedHandler(open);
  await open.click();
  await expect(open).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible({ timeout: 5_000 });
}

function correctedEpubFixture(): Buffer {
  return validEpubFixture({
    'EPUB/chapter-1.xhtml': strToU8(`<?xml version="1.0"?>
      <html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1>
      <p>The <strong>corrected signal</strong> arrived.</p>
      <img src="images/station.png" alt="A corrected station"/>
      </body></html>`)
  });
}

test.describe('catalog publication lifecycle', () => {
  test('publishes, replaces, rolls back, withdraws, and protects an EPUB revision', async ({ browser }) => {
    const slug = `browser-prose-${randomUUID()}`;
    const firstBytes = validEpubFixture();
    const correctedBytes = correctedEpubFixture();
    const { context: adminContext, page: adminPage } = await administrator(browser);
    const publicContext = await browser.newContext({ baseURL });
    const publicPage = await publicContext.newPage();
    try {
      const titleId = await createTitle(adminPage, {
        slug, title: 'Browser Prose Publication', format: 'prose',
        description: 'A private prose candidate.'
      });
      const first = await uploadRevision(adminPage, {
        filename: 'browser-prose.epub', mimeType: 'application/epub+zip',
        bytes: firstBytes, summary: 'Initial reviewed edition'
      });
      await waitUntilReady(adminPage);

      await expect(adminPage.getByRole('link', { name: 'Download browser-prose.epub' })).toBeVisible();
      await expect(adminPage.getByText(/SHA-256 [0-9a-f]{64}/u)).toBeVisible();
      await openReader(adminPage, 'book');
      await adminPage.getByRole('button', { name: 'Contents' }).click();
      await adminPage.getByRole('button', { name: /Chapter Two/u }).click();
      await expect(adminPage.getByText('Second.', { exact: true })).toBeAttached();
      await adminPage.getByRole('button', { name: 'Close' }).click();
      await adminPage.getByRole('button', { name: 'Use as title cover' }).click();
      await expect(adminPage.getByText('Ingested cover suggestion')).toBeVisible();

      await selectBoundary(adminPage, 'paragraph');
      await saveDraft(adminPage);
      await publishSettings(adminPage);
      await clickConfirmed(adminPage.getByRole('button', { name: 'Activate privately' }));
      await expect(adminPage.locator('section.status strong')).toHaveText('active');
      expect((await publicContext.request.get(`/book/${slug}`)).status()).toBe(404);
      expect((await publicContext.request.get(`/read/${slug}`)).status()).toBe(404);

      await adminPage.getByRole('link', { name: /Title$/u }).click();
      await expect(adminPage.locator('aside img[alt="Browser Prose Publication"]')).toBeVisible();
      await clickConfirmed(adminPage.getByRole('button', { name: 'Publish storefront' }));
      await publicPage.goto('/catalog');
      await expect(publicPage.getByRole('link', { name: /Browser Prose Publication/u })).toBeVisible();
      await publicPage.goto(`/book/${slug}`);
      await expect(publicPage.getByRole('heading', { name: 'Browser Prose Publication' })).toBeVisible();
      await publicPage.getByRole('link', { name: 'Read the free preview' }).click();
      await openReader(publicPage, 'book');
      await expect(publicPage.getByText(/signal/u).first()).toBeVisible();
      await expect(publicPage.getByText('Second.', { exact: true })).toHaveCount(0);

      const originalUrl = `/admin/catalog/${titleId}/revisions/${first.revisionId}/original`;
      expect((await publicContext.request.get(originalUrl)).status()).toBe(401);
      const downloaded = await adminContext.request.get(originalUrl);
      expect(downloaded.status()).toBe(200);
      expect(await downloaded.body()).toEqual(firstBytes);

      await adminPage.goto(`/admin/catalog/${titleId}`);
      await waitForHydratedHandler(adminPage.getByRole('button', { name: 'Use Nocturne theme' }));
      await adminPage.getByLabel('Description').fill('Public metadata saved explicitly.');
      await expect(adminPage.getByLabel('Description')).toHaveValue('Public metadata saved explicitly.');
      await adminPage.getByRole('button', { name: 'Save metadata' }).click();
      await expect(adminPage.getByLabel('Description')).toHaveValue('Public metadata saved explicitly.');
      await publicPage.goto(`/book/${slug}`);
      await expect(publicPage.getByText('Public metadata saved explicitly.')).toBeVisible();

      await adminPage.goto(`/admin/catalog/${titleId}`);
      const replacement = await uploadRevision(adminPage, {
        filename: 'browser-prose-corrected.epub', mimeType: 'application/epub+zip',
        bytes: correctedBytes, summary: 'Corrected reviewed edition'
      });
      await publicPage.goto(`/read/${slug}`);
      await openReader(publicPage, 'book');
      await expect(publicPage.getByText(/signal/u).first()).toBeVisible();
      await expect(publicPage.getByText(/corrected signal/u)).toHaveCount(0);
      await waitUntilReady(adminPage);
      await expect(publicPage.getByText(/corrected signal/u)).toHaveCount(0);
      await selectBoundary(adminPage, 'paragraph');
      await saveDraft(adminPage);
      await publishSettings(adminPage);
      await publicPage.reload();
      await openReader(publicPage, 'book');
      await expect(publicPage.getByText(/signal/u).first()).toBeVisible();
      await expect(publicPage.getByText(/corrected signal/u)).toHaveCount(0);

      await clickConfirmed(adminPage.getByRole('button', { name: 'Publish replacement' }));
      await publicPage.reload();
      await openReader(publicPage, 'book');
      await expect(publicPage.getByText(/corrected signal/u).first()).toBeVisible();

      await adminPage.goto(first.reviewUrl);
      await clickConfirmed(adminPage.getByRole('button', { name: 'Roll back to this revision' }));
      await publicPage.reload();
      await openReader(publicPage, 'book');
      await expect(publicPage.getByText(/corrected signal/u)).toHaveCount(0);
      await expect(publicPage.getByText(/signal/u).first()).toBeVisible();

      await adminPage.getByRole('link', { name: /Title$/u }).click();
      await clickConfirmed(adminPage.getByRole('button', { name: 'Withdraw storefront' }));
      expect((await publicContext.request.get(`/book/${slug}`)).status()).toBe(404);
      expect((await publicContext.request.get(`/read/${slug}`)).status()).toBe(404);
      await adminPage.goto(first.reviewUrl);
      await expect(adminPage.getByRole('link', { name: 'Download browser-prose.epub' })).toBeVisible();
      expect((await adminContext.request.get(originalUrl)).status()).toBe(200);
      expect(replacement.revisionId).not.toBe(first.revisionId);
    } finally {
      await publicContext.close();
      await adminContext.close();
    }
  });

  test('publishes comic pages, promotes manual guided panels, and audits detail access', async ({ browser }) => {
    const slug = `browser-comic-${randomUUID()}`;
    const { context: adminContext, page: adminPage } = await administrator(browser);
    const publicContext = await browser.newContext({ baseURL });
    const publicPage = await publicContext.newPage();
    try {
      const titleId = await createTitle(adminPage, {
        slug, title: 'Browser Comic Publication', format: 'comic',
        description: 'A comic with manually reviewed panel regions.'
      });
      await uploadRevision(adminPage, {
        filename: 'browser-comic.cbz', mimeType: 'application/zip',
        bytes: validComicFixture(), summary: 'Initial comic edition'
      });
      await waitUntilReady(adminPage);
      await selectBoundary(adminPage, 'Page 1');
      await saveDraft(adminPage);
      await publishSettings(adminPage);
      await clickConfirmed(adminPage.getByRole('button', { name: 'Activate privately' }));
      await adminPage.getByRole('link', { name: /Title$/u }).click();
      await clickConfirmed(adminPage.getByRole('button', { name: 'Publish storefront' }));

      await publicPage.goto(`/read/${slug}`);
      await openReader(publicPage, 'comic');
      const comicImage = publicPage.locator('img[alt^="Comic page"]').first();
      await expect(comicImage).toBeVisible();
      await expect(comicImage).toHaveAttribute('src', /\/media\/revisions\//u);
      await expect(publicPage.getByRole('button', { name: 'Page view' })).toHaveCount(0);

      await adminPage.goto(`/admin/catalog/${titleId}`);
      await adminPage.getByRole('link', { name: 'Initial comic edition' }).click();
      const tabs = adminPage.getByLabel('Comic pages');
      const frame = adminPage.getByRole('application', { name: 'Panel region editor' });
      const regions = frame.locator('.region');
      const draw = async (fromX: number, fromY: number, toX: number, toY: number): Promise<void> => {
        const bounds = await frame.boundingBox();
        if (!bounds) throw new Error('Panel editor was not visible');
        await adminPage.mouse.move(bounds.x + bounds.width * fromX, bounds.y + bounds.height * fromY);
        await adminPage.mouse.down();
        await adminPage.mouse.move(bounds.x + bounds.width * toX, bounds.y + bounds.height * toY);
        await adminPage.mouse.up();
      };
      const pageOneTab = tabs.getByRole('button', { name: 'Page 1' });
      await waitForHydratedHandler(frame);
      await pageOneTab.click();
      await expect(pageOneTab).toHaveClass(/on/u);
      await draw(0.08, 0.08, 0.42, 0.42);
      await expect(regions).toHaveCount(1);
      await draw(0.56, 0.56, 0.90, 0.90);
      await expect(regions).toHaveCount(2);
      await draw(0.56, 0.08, 0.90, 0.42);
      await expect(regions).toHaveCount(3);
      await adminPage.getByRole('button', { name: 'Earlier' }).click();
      const pageTwoTab = tabs.getByRole('button', { name: 'Page 2' });
      await pageTwoTab.click();
      await expect(pageTwoTab).toHaveClass(/on/u);
      await draw(0.10, 0.10, 0.86, 0.86);
      await expect(regions).toHaveCount(1);
      const pageThreeTab = tabs.getByRole('button', { name: 'Page 3' });
      await pageThreeTab.click();
      await expect(pageThreeTab).toHaveClass(/on/u);
      await draw(0.12, 0.12, 0.84, 0.84);
      await expect(regions).toHaveCount(1);
      await adminPage.getByLabel(/Enable guided panel view/u).check();
      await saveDraft(adminPage);
      await tabs.getByRole('button', { name: 'Page 1' }).click();
      await expect(regions).toHaveCount(3);

      await publicPage.reload();
      await expect(publicPage.getByRole('button', { name: 'Page view' })).toHaveCount(0);
      await publishSettings(adminPage);
      await publicPage.reload();
      await expect(publicPage.getByRole('button', { name: 'Page view' })).toBeVisible();
      await openReader(publicPage, 'comic');
      await publicPage.getByRole('button', { name: 'Page view' }).click();
      await expect(publicPage.getByRole('button', { name: 'Guided view' })).toBeVisible();
      await expect(publicPage.getByText(/Page 1.*panel 1 of 3/u)).toBeVisible();
      await publicPage.locator('button.single-panel').click();
      await publicPage.locator('button.single-panel').click();
      await expect(publicPage.getByText(/Page 1.*panel 3 of 3/u)).toBeVisible();
      await publicPage.getByRole('button', { name: 'Previous', exact: true }).click();
      await expect(publicPage.getByText(/Page 1.*panel 2 of 3/u)).toBeVisible();

      await adminPage.goto('/admin/audit');
      await adminPage.getByLabel('Action').fill('catalog.reader_settings.publish');
      await adminPage.getByLabel('Resource ID').fill(titleId);
      await adminPage.getByRole('button', { name: 'Apply filters' }).click();
      const settingsEvent = adminPage.getByRole('link').filter({
        hasText: 'catalog.reader_settings.publish'
      }).first();
      await expect(settingsEvent).toBeVisible();
      await settingsEvent.click();
      await expect(adminPage.getByRole('heading', { name: 'catalog.reader_settings.publish' })).toBeVisible();
      const detailText = await adminPage.locator('main').innerText();
      expect(detailText).not.toMatch(/password|secret|sourcePath|rawHtml|"token"/iu);

      await adminPage.getByRole('link', { name: /Audit trail/u }).click();
      await adminPage.getByLabel('Action').fill('audit.event.view');
      await adminPage.getByRole('button', { name: 'Apply filters' }).click();
      await expect(adminPage.getByRole('link').filter({ hasText: 'audit.event.view' }).first()).toBeVisible();
    } finally {
      await publicContext.close();
      await adminContext.close();
    }
  });
});
