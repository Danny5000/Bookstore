import { expect, test } from '@playwright/test';

test('Previous moves from panel three to panel two on the first comic page', async ({ page }) => {
  await page.goto('/read/vector');
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: 'Open the comic' }).click();
  await expect(
    page.getByRole('application', { name: /Interactive pages for Vector & Vine/ })
  ).toBeVisible({ timeout: 3_000 });

  await page.getByRole('button', { name: 'Page view' }).click();
  await expect(
    page.getByRole('button', { name: /PANEL - establishing shot/ })
  ).toBeVisible();
  await expect(page.getByText(/Page 1\s*·\s*panel 1 of 3/)).toBeVisible();

  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText(/Page 1\s*·\s*panel 3 of 3/)).toBeVisible();

  await page.getByRole('button', { name: 'Previous', exact: true }).click();

  await expect(page.getByText(/Page 1\s*·\s*panel 2 of 3/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open the comic' })).toBeHidden();
});
