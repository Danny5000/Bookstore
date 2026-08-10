import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { strToU8 } from 'fflate';
import { validComicFixture, validEpubFixture } from '../fixtures/publications';
import { registerAndVerifyCustomer, signInCustomer } from './customer-session';
import { openE2EDatabase } from './database';
import {
  activateAndPublish,
  administrator,
  baseURL,
  clickConfirmed,
  createTitle,
  openReader,
  publishSettings,
  saveDraft,
  selectBoundary,
  uploadRevision,
  waitForHydratedHandler,
  waitUntilReady
} from './publication-admin';

const customerPassword = 'plan-five-reader-password-2026';

async function publishProse(page: Page, slug: string, bytes: Buffer) {
  const titleId = await createTitle(page, {
    slug,
    title: 'Plan Five Prose',
    format: 'prose',
    description: 'A prose title used to verify the customer library.'
  });
  const revision = await uploadRevision(page, {
    filename: 'plan-five-prose.epub',
    mimeType: 'application/epub+zip',
    bytes,
    summary: 'Plan 5 prose edition'
  });
  await waitUntilReady(page);
  await selectBoundary(page, 'paragraph');
  await saveDraft(page);
  await publishSettings(page);
  await activateAndPublish(page);
  return { titleId, ...revision };
}

async function drawGuidedPanels(page: Page): Promise<void> {
  const tabs = page.getByLabel('Comic pages');
  const frame = page.getByRole('application', { name: 'Panel region editor' });
  await waitForHydratedHandler(frame);
  for (const label of ['Page 1', 'Page 2', 'Page 3']) {
    const tab = tabs.getByRole('button', { name: label });
    await tab.click();
    await expect(tab).toHaveClass(/on/u);
    const bounds = await frame.boundingBox();
    if (!bounds) throw new Error(`Panel editor was not visible for ${label}`);
    await page.mouse.move(bounds.x + bounds.width * 0.12, bounds.y + bounds.height * 0.12);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.86, bounds.y + bounds.height * 0.86);
    await page.mouse.up();
    await expect(frame.locator('.region')).toHaveCount(1);
  }
  await page.getByLabel(/Enable guided panel view/u).check();
}

async function publishComic(page: Page, slug: string, bytes: Buffer) {
  const titleId = await createTitle(page, {
    slug,
    title: 'Plan Five Comic',
    format: 'comic',
    description: 'A comic used to verify customer reading modes.'
  });
  const revision = await uploadRevision(page, {
    filename: 'plan-five-comic.cbz',
    mimeType: 'application/zip',
    bytes,
    summary: 'Plan 5 comic edition'
  });
  await waitUntilReady(page);
  await selectBoundary(page, 'Page 1');
  await drawGuidedPanels(page);
  await saveDraft(page);
  await publishSettings(page);
  await activateAndPublish(page);
  return { titleId, ...revision };
}

function correctedEpubFixture(): Buffer {
  return validEpubFixture({
    'EPUB/chapter-1.xhtml': strToU8(`<?xml version="1.0"?>
      <html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Corrected Chapter One</h1>
      <p>The changed signal arrived in the corrected edition.</p>
      <img src="images/station.png" alt="A corrected distant station"/>
      </body></html>`)
  });
}

async function chooseChapter(page: Page, chapter: string): Promise<void> {
  const contents = page.getByRole('button', { name: 'Contents' });
  await waitForHydratedHandler(contents);
  await contents.click();
  await page.getByRole('button', { name: new RegExp(chapter, 'u') }).click();
}

async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText('Reading position saved')).toBeVisible({ timeout: 8_000 });
}

test.describe.configure({ mode: 'serial' });

test('customer library, reader state, downloads, revisions, and revocation stay server-owned', async ({
  browser
}) => {
  test.setTimeout(360_000);
  const proseSlug = `plan-five-prose-${randomUUID()}`;
  const comicSlug = `plan-five-comic-${randomUUID()}`;
  const customerEmail = `${randomUUID()}@example.com`;
  const proseBytes = validEpubFixture();
  const comicBytes = validComicFixture();
  const correctedBytes = correctedEpubFixture();
  const database = await openE2EDatabase();
  const { context: adminContext, page: adminPage } = await administrator(browser);
  const anonymousContext = await browser.newContext({ baseURL });
  const anonymousPage = await anonymousContext.newPage();
  const customerContext = await browser.newContext({ baseURL });
  const customerPage = await registerAndVerifyCustomer(customerContext, {
    email: customerEmail,
    password: customerPassword
  });
  let secondContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;

  try {
    const prose = await publishProse(adminPage, proseSlug, proseBytes);
    const comic = await publishComic(adminPage, comicSlug, comicBytes);

    expect((await anonymousContext.request.get(`/library/${prose.titleId}/download`)).status()).toBe(401);
    expect((await customerContext.request.get(`/library/${prose.titleId}/download`)).status()).toBe(404);
    await customerPage.goto(`/read/${prose.titleId}`);
    await openReader(customerPage, 'book');
    await expect(customerPage.getByText(/signal/u).first()).toBeVisible();
    await expect(customerPage.getByText('Second.', { exact: true })).toHaveCount(0);

    await anonymousPage.goto(`/read/${proseSlug}`);
    await openReader(anonymousPage, 'book');
    await expect(anonymousPage.getByText(/signal/u).first()).toBeVisible();
    await expect(anonymousPage.getByText('Second.', { exact: true })).toHaveCount(0);

    await database.grantEntitlement(customerEmail, prose.titleId);
    await database.grantEntitlement(customerEmail, comic.titleId);
    await customerPage.goto('/library');
    await expect(customerPage.getByRole('heading', { name: 'My Library' })).toBeVisible();
    await expect(customerPage.getByRole('heading', { name: 'Plan Five Prose' })).toBeVisible();
    await expect(customerPage.getByRole('heading', { name: 'Plan Five Comic' })).toBeVisible();
    await expect(customerPage.getByRole('link', { name: 'Download EPUB' })).toBeVisible();
    await expect(customerPage.getByRole('link', { name: 'Download CBZ' })).toBeVisible();

    await customerPage.getByRole('link', { name: 'Read Plan Five Prose' }).first().click();
    await openReader(customerPage, 'book');
    await expect(customerPage.getByText('Second.', { exact: true })).toBeAttached();
    await customerPage.getByRole('button', { name: /Bookmark$/u }).click();
    await expect(customerPage.getByRole('button', { name: /Bookmarked$/u })).toBeVisible();
    await customerPage.getByRole('button', { name: 'Reading settings' }).click();
    await customerPage.getByRole('button', { name: 'Increase type size' }).click();
    await customerPage.getByRole('button', { name: 'Sans' }).click();
    await customerPage.getByRole('button', { name: 'Sepia' }).click();
    await chooseChapter(customerPage, 'Chapter Two');
    await expectSaved(customerPage);

    secondContext = await browser.newContext({ baseURL });
    const secondPage = await signInCustomer(secondContext, customerEmail, customerPassword);
    await secondPage.goto(`/read/${prose.titleId}`);
    const secondSettings = secondPage.getByRole('button', { name: 'Reading settings' });
    await waitForHydratedHandler(secondSettings);
    await secondSettings.click();
    await expect(secondPage.getByRole('button', { name: 'Sans' })).toHaveClass(/on/u);
    await expect(secondPage.getByRole('button', { name: 'Sepia' })).toHaveClass(/on/u);
    await secondPage.getByRole('button', { name: 'Contents' }).click();
    await expect(secondPage.getByRole('button', { name: /Page 1/u })).toBeVisible();
    await secondPage.getByRole('button', { name: 'Contents' }).click();

    await customerPage.reload();
    await secondPage.reload();
    await chooseChapter(customerPage, 'Chapter One');
    await expectSaved(customerPage);
    await chooseChapter(secondPage, 'Chapter Two');
    await expect(secondPage.getByText(/changed on another device/u)).toBeVisible({ timeout: 8_000 });
    await expect(secondPage.getByRole('button', { name: /Bookmarked$/u })).toBeVisible();
    await chooseChapter(customerPage, 'Chapter Two');
    await expectSaved(customerPage);

    await customerPage.goto(`/read/${comic.titleId}`);
    const comicModeResponse = customerPage.waitForResponse(
      (response) => response.url().endsWith(`/api/reader-state/${comic.titleId}/preferences`) && response.request().method() === 'PUT'
    );
    const comicMode = customerPage.getByRole('button', { name: 'Page view' });
    await waitForHydratedHandler(comicMode);
    await comicMode.click();
    expect((await comicModeResponse).status()).toBe(200);
    await secondPage.goto(`/read/${comic.titleId}`);
    await expect(secondPage.getByRole('button', { name: 'Guided view' })).toBeVisible();

    for (const expected of [
      { titleId: prose.titleId, title: 'Plan Five Prose', type: 'application/epub+zip', bytes: proseBytes },
      { titleId: comic.titleId, title: 'Plan Five Comic', type: 'application/vnd.comicbook+zip', bytes: comicBytes }
    ]) {
      const url = `/library/${expected.titleId}/download`;
      const download = await customerContext.request.get(url, { headers: { 'x-request-id': `e2e-${expected.titleId}` } });
      expect(download.status()).toBe(200);
      expect(download.headers()['content-type']).toBe(expected.type);
      expect(download.headers()['content-disposition']).toContain(expected.title);
      expect(await download.body()).toEqual(expected.bytes);
      expect(download.headers().etag).toBe(`"${createHash('sha256').update(expected.bytes).digest('hex')}"`);
      const head = await customerContext.request.head(url);
      expect(head.status()).toBe(200);
      expect(await head.body()).toHaveLength(0);
      const range = await customerContext.request.get(url, { headers: { range: 'bytes=0-15' } });
      expect(range.status()).toBe(206);
      expect(range.headers()['content-range']).toBe(`bytes 0-15/${expected.bytes.length}`);
      expect(await range.body()).toEqual(expected.bytes.subarray(0, 16));
    }

    await adminPage.goto('/admin/audit');
    await adminPage.getByLabel('Action').fill('library.original.download');
    await adminPage.getByLabel('Resource ID').fill(prose.revisionId);
    await adminPage.getByRole('button', { name: 'Apply filters' }).click();
    const downloadAudit = adminPage.getByRole('link').filter({ hasText: 'library.original.download' }).first();
    await expect(downloadAudit).toBeVisible();
    await downloadAudit.click();
    const auditText = await adminPage.locator('main').innerText();
    expect(auditText).not.toMatch(/storageKey|objectKey|originalFilename|password|token|cookie|authorization/iu);

    await adminPage.goto(`/admin/catalog/${prose.titleId}`);
    await uploadRevision(adminPage, {
      filename: 'plan-five-prose-corrected.epub',
      mimeType: 'application/epub+zip',
      bytes: correctedBytes,
      summary: 'Plan 5 corrected prose edition'
    });
    await waitUntilReady(adminPage);
    await selectBoundary(adminPage, 'paragraph');
    await saveDraft(adminPage);
    await publishSettings(adminPage);
    await clickConfirmed(adminPage.getByRole('button', { name: 'Publish replacement' }));

    await customerPage.goto(`/read/${prose.titleId}`);
    await expect(customerPage.getByText(/saved position was checked against this edition/u)).toBeVisible();
    await expect(customerPage.getByText('Second.', { exact: true })).toBeAttached();
    const replacementContents = customerPage.getByRole('button', { name: 'Contents' });
    await waitForHydratedHandler(replacementContents);
    await replacementContents.click();
    await expect(customerPage.getByText('No bookmarks yet.')).toBeVisible();
    await replacementContents.click();
    const dismissNotice = customerPage.getByRole('button', { name: 'Dismiss' });
    await waitForHydratedHandler(dismissNotice);
    await dismissNotice.click();
    await expect(customerPage.getByText(/saved position was checked/u)).toHaveCount(0);
    await expect(customerPage.getByLabel('Reader status')).toBeFocused();

    await adminPage.goto(`/admin/catalog/${prose.titleId}`);
    await clickConfirmed(adminPage.getByRole('button', { name: 'Withdraw storefront' }));
    await customerPage.goto('/library');
    await expect(customerPage.getByRole('heading', { name: 'Plan Five Prose' })).toBeVisible();
    expect((await customerContext.request.get(`/read/${prose.titleId}`)).status()).toBe(200);
    const retained = await customerContext.request.get(`/library/${prose.titleId}/download`);
    expect(await retained.body()).toEqual(correctedBytes);
    expect((await anonymousContext.request.get(`/read/${proseSlug}`)).status()).toBe(404);

    const shelfCount = await customerPage.getByRole('article').count();
    for (const removedUrl of ['/api/checkout', '/api/stripe-webhook', '/api/deliver']) {
      expect((await customerContext.request.get(removedUrl)).status()).toBe(404);
    }
    await customerPage.reload();
    expect(await customerPage.getByRole('article').count()).toBe(shelfCount);

    await database.revokeEntitlement(customerEmail, prose.titleId);
    await database.revokeEntitlement(customerEmail, comic.titleId);
    await customerPage.reload();
    await expect(customerPage.getByText('Your library is empty')).toBeVisible();
    expect((await customerContext.request.get(`/read/${prose.titleId}`)).status()).toBe(404);
    expect((await customerContext.request.get(`/library/${prose.titleId}/download`)).status()).toBe(404);
    expect((await anonymousContext.request.get(`/read/${comicSlug}`)).status()).toBe(200);
    expect((await anonymousContext.request.get(`/library/${comic.titleId}/download`)).status()).toBe(401);
  } finally {
    await database.close();
    if (secondContext) await secondContext.close();
    await customerContext.close();
    await anonymousContext.close();
    await adminContext.close();
  }
});
