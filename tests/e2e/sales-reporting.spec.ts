import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
} from "@playwright/test";
import { registerAndVerifyCustomer } from "./customer-session";
import {
  assertCommercePrivacy,
  type CommercePrivacySurface,
} from "./commerce-privacy";
import { openE2EDatabase } from "./database";
import {
  createFinancialHarness,
  FINANCIAL_CAPTURE_CONSOLE_WITNESS,
  FINANCIAL_CAPTURE_STRUCTURED_CONSOLE_WITNESS,
  normalizeFinancialConsoleEvidenceForPrivacy,
} from "./financial-harness";
import {
  baseURL,
  signInAdministrator,
} from "./publication-admin";

const SALES_EXPORT_ACTION = "financial.sales_export";
const ISSUE_VIEW_ACTION = "financial.issue.view";
const PAYOUT_VIEW_ACTION = "financial.payout.view";
const SALES_DENIAL_PRIVATE_CANARY = "private-denial-sentinel";

type SalesPrivacySurface = Extract<CommercePrivacySurface, `sales ${string}`>;

type SalesDenialProjection = Readonly<{
  status: number;
  location: string | null;
  contentType: string | null;
  disposition: string | null;
  body: string;
}>;

async function waitForSalesFilterHydration(page: Page): Promise<void> {
  const form = page.locator("form.sales-filters");
  await expect
    .poll(() =>
      form.evaluate((element) => {
        if (!(element instanceof HTMLFormElement)) return false;
        const formData = new FormData();
        formData.set("range", "all");
        formData.set("from", "2026-08-01");
        formData.set("to", "2026-08-10");
        element.dispatchEvent(new FormDataEvent("formdata", { formData }));
        return !formData.has("from") && !formData.has("to");
      }),
    )
    .toBe(true);
}

function assertSalesPrivacy(
  surface: SalesPrivacySurface,
  evidence: unknown,
  privateValues: readonly string[],
): void {
  try {
    assertCommercePrivacy(surface, evidence, privateValues);
  } catch (error: unknown) {
    try {
      assertCommercePrivacy(surface, evidence, []);
    } catch {
      if (surface === "sales console" && Array.isArray(evidence)) {
        const violationIndex = evidence.findIndex((entry) => {
          try {
            assertCommercePrivacy(surface, entry, []);
            return false;
          } catch {
            return true;
          }
        });
        throw new Error(
          `Sensitive commerce data detected on ${surface} (generic detector at console index ${violationIndex})`,
          { cause: error },
        );
      }
      throw new Error(
        `Sensitive commerce data detected on ${surface} (generic detector)`,
        { cause: error },
      );
    }
    const privateValueIndex = privateValues.findIndex((privateValue) => {
      try {
        assertCommercePrivacy(surface, evidence, [privateValue]);
        return false;
      } catch {
        return true;
      }
    });
    throw new Error(
      `Sensitive commerce data detected on ${surface} (private value index ${privateValueIndex})`,
      { cause: error },
    );
  }
}

function projectSalesDenial(input: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}): SalesDenialProjection {
  return {
    status: input.status,
    location: input.headers.location ?? null,
    contentType: input.headers["content-type"] ?? null,
    disposition: input.headers["content-disposition"] ?? null,
    body: input.body,
  };
}

function requireCapturedSalesWitness(
  surface: SalesPrivacySurface,
  evidenceKind: string,
  evidence: unknown,
  witness: string,
): void {
  const serialized = JSON.stringify(evidence);
  if (
    witness.length === 0 ||
    serialized === undefined ||
    !serialized.toLowerCase().includes(witness.toLowerCase())
  ) {
    throw new Error(
      `Sales ${evidenceKind} evidence lacked its capture-resident witness`,
    );
  }
  expect(() => assertCommercePrivacy(surface, evidence, [witness])).toThrow(
    `Sensitive commerce data detected on ${surface}`,
  );
}

type FilterValues = Readonly<{
  range?: "7" | "30" | "90" | "all" | "custom";
  from?: string;
  to?: string;
  titleId?: string;
  format?: "prose" | "comic";
  presentmentCurrency?: string;
  settlementCurrency?: string;
  state?: "pending" | "fee_reconciled" | "payout_reconciled" | "exception";
  sort?: "gross_desc" | "title_asc";
}>;

const MAX_REPORTING_PAGE_COUNT = 20;

function salesRegion(page: Page): Locator {
  return page.getByRole("region", { name: "Sales results by title" });
}

async function waitForSettledLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

function salesRow(page: Page, title: string): Locator {
  return salesRegion(page)
    .getByRole("row")
    .filter({
      has: page.getByRole("rowheader").filter({ hasText: title }),
    });
}

function payoutRow(page: Page, payoutId: string): Locator {
  return page
    .getByRole("region", { name: "Local payout reporting" })
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader").filter({ hasText: payoutId }) });
}

function summaryCard(page: Page, heading: string): Locator {
  return page
    .getByRole("heading", { name: heading, exact: true })
    .locator("..")
    .locator("..");
}

async function expectMetric(
  row: Locator,
  label: string,
  value: string | RegExp,
): Promise<void> {
  const metric = row.getByText(label, { exact: true }).locator("..");
  await expect(metric).toContainText(value);
}

function payoutDetailValue(page: Page, label: string): Locator {
  return page
    .locator(".payout-detail-grid")
    .getByText(label, { exact: true })
    .locator("..")
    .locator("dd");
}

async function applyFilters(page: Page, values: FilterValues): Promise<void> {
  await page.getByLabel("Range").selectOption(values.range ?? "30");
  await page.getByLabel("From date").fill(values.from ?? "");
  await page.getByLabel("To date").fill(values.to ?? "");
  await page.getByLabel("Title ID").fill(values.titleId ?? "");
  await page.getByLabel("Format").selectOption(values.format ?? "");
  await page
    .getByLabel("Presentment currency")
    .fill(values.presentmentCurrency ?? "");
  await page
    .getByLabel("Settlement currency")
    .fill(values.settlementCurrency ?? "");
  await page.getByLabel("Financial state").selectOption(values.state ?? "");
  await page.getByLabel("Sort").selectOption(values.sort ?? "gross_desc");

  const previousResults = await salesRegion(page).innerHTML();
  const previousUrl = page.url();
  const [navigationResponse] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.origin === new URL(baseURL).origin &&
        (url.pathname === "/admin/sales" ||
          url.pathname === "/admin/sales/__data.json") &&
        ["document", "fetch"].includes(response.request().resourceType())
      );
    }),
    page.waitForURL((url) => url.href !== previousUrl),
    page.getByRole("button", { name: "Apply filters" }).click(),
  ]);
  expect(navigationResponse.status()).toBe(200);
  await page.waitForLoadState("networkidle");
  const filterNavigation = `filter navigation ${page.url()}`;
  const url = new URL(page.url());
  expect(Object.fromEntries(url.searchParams), filterNavigation).toEqual({
    range: values.range ?? "30",
    ...(values.from === undefined ? {} : { from: values.from }),
    ...(values.to === undefined ? {} : { to: values.to }),
    ...(values.titleId === undefined ? {} : { titleId: values.titleId }),
    ...(values.format === undefined ? {} : { format: values.format }),
    ...(values.presentmentCurrency === undefined
      ? {}
      : { presentmentCurrency: values.presentmentCurrency }),
    ...(values.settlementCurrency === undefined
      ? {}
      : { settlementCurrency: values.settlementCurrency }),
    ...(values.state === undefined ? {} : { state: values.state }),
    sort: values.sort ?? "gross_desc",
  });
  await expect
    .poll(() => salesRegion(page).innerHTML(), { message: filterNavigation })
    .not.toBe(previousResults);
  await expect(
    page.getByRole("heading", { name: "Sales overview" }),
    filterNavigation,
  ).toBeVisible();
  await expect(page.getByRole("status"), filterNavigation).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await expect(page.getByRole("status"), filterNavigation).toHaveAttribute(
    "aria-atomic",
    "true",
  );
}

async function visibleSalesTitles(page: Page): Promise<readonly string[]> {
  return salesRegion(page)
    .locator('tbody th[scope="row"] > strong')
    .allTextContents();
}

type SalesTitlePageCollection = Readonly<{
  pages: readonly (readonly string[])[];
  titles: readonly string[];
}>;

async function collectSalesTitlePages(
  page: Page,
): Promise<SalesTitlePageCollection> {
  const pages: string[][] = [];
  const seenUrls = new Set<string>();
  for (
    let pageIndex = 0;
    pageIndex < MAX_REPORTING_PAGE_COUNT;
    pageIndex += 1
  ) {
    await expect(
      page.getByRole("heading", { name: "Sales overview" }),
    ).toBeVisible();
    const currentUrl = page.url();
    if (seenUrls.has(currentUrl)) {
      throw new Error(`Sales pagination repeated ${currentUrl}`);
    }
    seenUrls.add(currentUrl);
    pages.push([...(await visibleSalesTitles(page))]);
    const nextPage = page.getByRole("link", { name: "Next page →" });
    if ((await nextPage.count()) === 0) {
      return { pages, titles: pages.flat() };
    }
    const nextHref = await nextPage.getAttribute("href");
    if (nextHref === null) throw new Error("Sales next-page link had no URL");
    const expectedUrl = new URL(nextHref, currentUrl).href;
    await Promise.all([
      page.waitForURL((url) => url.href === expectedUrl),
      nextPage.click(),
    ]);
  }
  throw new Error(
    `Sales pagination exceeded ${MAX_REPORTING_PAGE_COUNT} pages`,
  );
}

function projectPublicCohort(
  titles: readonly string[],
  publicCohortTitles: readonly string[],
): readonly string[] {
  const publicCohort = new Set(publicCohortTitles);
  return titles.filter((title) => publicCohort.has(title));
}

async function expectPublicCohortTitles(
  page: Page,
  publicCohortTitles: readonly string[],
  expectedTitles: readonly string[],
): Promise<void> {
  const collection = await collectSalesTitlePages(page);
  expect(projectPublicCohort(collection.titles, publicCohortTitles)).toEqual(
    expectedTitles,
  );
}

async function readNeedsReviewCount(page: Page): Promise<number> {
  const link = page.getByRole("link", { name: /items? needs? review/u });
  if ((await link.count()) === 0) return 0;
  const rawCount = (await link.locator("strong").innerText()).trim();
  if (!/^\d+$/u.test(rawCount)) {
    throw new Error(`Needs-review count was not canonical: ${rawCount}`);
  }
  return Number.parseInt(rawCount, 10);
}

type ReviewQueueCollection = Readonly<{
  issueIds: readonly string[];
  pageByIssueId: ReadonlyMap<string, string>;
}>;

async function collectReviewQueuePages(
  page: Page,
): Promise<ReviewQueueCollection> {
  const issueIds: string[] = [];
  const pageByIssueId = new Map<string, string>();
  const seenUrls = new Set<string>();
  for (
    let pageIndex = 0;
    pageIndex < MAX_REPORTING_PAGE_COUNT;
    pageIndex += 1
  ) {
    await expect(
      page.getByRole("heading", { name: "Needs review" }),
    ).toBeVisible();
    const currentUrl = page.url();
    if (seenUrls.has(currentUrl)) {
      throw new Error(`Needs-review pagination repeated ${currentUrl}`);
    }
    seenUrls.add(currentUrl);
    const pageIssueIds = await page
      .getByRole("region", { name: "Financial issues needing review" })
      .locator('tbody th[scope="row"] > span:last-child')
      .allTextContents();
    for (const rawIssueId of pageIssueIds) {
      const issueId = rawIssueId.trim();
      issueIds.push(issueId);
      pageByIssueId.set(issueId, currentUrl);
    }
    const nextPage = page.getByRole("link", { name: "Next page →" });
    if ((await nextPage.count()) === 0) return { issueIds, pageByIssueId };
    const nextHref = await nextPage.getAttribute("href");
    if (nextHref === null) {
      throw new Error("Needs-review next-page link had no URL");
    }
    const expectedUrl = new URL(nextHref, currentUrl).href;
    await Promise.all([
      page.waitForURL((url) => url.href === expectedUrl),
      nextPage.click(),
    ]);
  }
  throw new Error(
    `Needs-review pagination exceeded ${MAX_REPORTING_PAGE_COUNT} pages`,
  );
}

async function readDownload(download: Download): Promise<string> {
  const path = await download.path();
  if (path === null)
    throw new Error("Sales CSV download did not produce a local file");
  return readFile(path, "utf8");
}

async function expectSafeExportFailure(
  request: APIRequestContext,
  path: string,
  expected: Readonly<{ status: number; code: string }>,
  privateValues: readonly string[],
): Promise<void> {
  const response = await request.get(path, { timeout: 40_000 });
  const body = await response.text();
  assertSalesPrivacy(
    "sales response",
    {
      status: response.status(),
      contentType: response.headers()["content-type"],
      disposition: response.headers()["content-disposition"],
      body,
    },
    privateValues,
  );
  expect(response.status()).toBe(expected.status);
  expect(response.headers()["content-type"]).toBe(
    "application/json; charset=utf-8",
  );
  expect(response.headers()["content-disposition"]).toBeUndefined();
  expect(JSON.parse(body)).toEqual({
    status: expected.status,
    code: expected.code,
  });
}

async function expectSameAuthorizationDenial(
  context: BrowserContext,
  expected: Readonly<{
    pageStatus: 303 | 403;
    apiStatus: 401 | 403;
    code: "unauthenticated" | "forbidden";
  }>,
  privateValues: readonly string[],
): Promise<void> {
  const denialPrivateValues = [...privateValues, SALES_DENIAL_PRIVATE_CANARY];
  const pagePaths = [
    "/admin/sales",
    `/admin/sales?unknown=${SALES_DENIAL_PRIVATE_CANARY}`,
  ] as const;
  const pageResponses = [];
  for (const path of pagePaths) {
    const response = await context.request.get(path, { maxRedirects: 0 });
    const body = await response.text();
    const evidence = projectSalesDenial({
      status: response.status(),
      headers: response.headers(),
      body,
    });
    assertSalesPrivacy("sales response", evidence, denialPrivateValues);
    pageResponses.push(evidence);
  }
  expect(pageResponses[0]?.status).toBe(expected.pageStatus);
  expect(pageResponses[1]?.status).toBe(expected.pageStatus);
  expect(pageResponses[1]).toEqual(pageResponses[0]);
  expect(pageResponses[1]?.body).toBe(pageResponses[0]?.body);
  for (const response of pageResponses) {
    expect(response.body).not.toContain(SALES_DENIAL_PRIVATE_CANARY);
    for (const privateValue of privateValues)
      expect(response.body).not.toContain(privateValue);
  }
  assertSalesPrivacy("sales response", pageResponses, denialPrivateValues);

  const exportPaths = [
    "/admin/sales/export.csv?range=all&sort=title_asc",
    `/admin/sales/export.csv?unknown=${SALES_DENIAL_PRIVATE_CANARY}`,
  ] as const;
  const exportResponses = [];
  for (const path of exportPaths) {
    const response = await context.request.get(path);
    const body = await response.text();
    const evidence = projectSalesDenial({
      status: response.status(),
      headers: response.headers(),
      body,
    });
    assertSalesPrivacy("sales response", evidence, denialPrivateValues);
    exportResponses.push(evidence);
  }
  expect(exportResponses).toEqual([
    {
      status: expected.apiStatus,
      location: null,
      contentType: "application/json; charset=utf-8",
      disposition: null,
      body: JSON.stringify({
        status: expected.apiStatus,
        code: expected.code,
      }),
    },
    {
      status: expected.apiStatus,
      location: null,
      contentType: "application/json; charset=utf-8",
      disposition: null,
      body: JSON.stringify({
        status: expected.apiStatus,
        code: expected.code,
      }),
    },
  ]);
  assertSalesPrivacy("sales response", exportResponses, denialPrivateValues);
}

test("bodyless 303 Sales denial scans a private Location header", async () => {
  const jsonBody = JSON.stringify({ status: 401, code: "unauthenticated" });
  const responses = [
    {
      status: () => 303,
      headers: () => ({ location: "/?auth=required" }),
      text: async () => "",
    },
    {
      status: () => 303,
      headers: () => ({
        location: `/?auth=required&private=${SALES_DENIAL_PRIVATE_CANARY}`,
      }),
      text: async () => "",
    },
    {
      status: () => 401,
      headers: () => ({ "content-type": "application/json; charset=utf-8" }),
      text: async () => jsonBody,
    },
    {
      status: () => 401,
      headers: () => ({ "content-type": "application/json; charset=utf-8" }),
      text: async () => jsonBody,
    },
  ];
  const context = {
    request: {
      get: async () => {
        const response = responses.shift();
        if (response === undefined)
          throw new Error("Sales denial witness exhausted its responses");
        return response;
      },
    },
  } as unknown as BrowserContext;

  await expect(
    expectSameAuthorizationDenial(
      context,
      { pageStatus: 303, apiStatus: 401, code: "unauthenticated" },
      [],
    ),
  ).rejects.toThrow("Sensitive commerce data detected on sales response");
});

async function expectPrivateValuesAbsent(
  page: Page,
  privateValues: readonly string[],
  captureWitness: string,
): Promise<void> {
  const main = page.locator("main");
  if ((await main.count()) !== 1) {
    throw new Error("Sales final browser main evidence was missing");
  }
  const html = await main.innerHTML();
  const text = await main.innerText();
  if (html.trim().length === 0 || text.trim().length === 0) {
    throw new Error("Sales final browser main evidence was empty");
  }
  requireCapturedSalesWitness(
    "sales browser",
    "browser HTML",
    html,
    captureWitness,
  );
  requireCapturedSalesWitness(
    "sales browser",
    "browser text",
    text,
    captureWitness,
  );
  assertSalesPrivacy("sales browser", html, privateValues);
  assertSalesPrivacy("sales browser", text, privateValues);
}

async function focusNamedLinkWithKeyboard(
  page: Page,
  name: string,
): Promise<Locator> {
  const link = page.getByRole("link", { name, exact: true });
  const focusableCount = await page
    .locator(
      'a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
    )
    .count();
  if (focusableCount === 0 || focusableCount > 200) {
    throw new Error("Sales page focusable-control bound was invalid");
  }
  for (let attempt = 0; attempt <= focusableCount; attempt += 1) {
    await page.keyboard.press("Tab");
    const reachedLink = await page.evaluate((expectedName) => {
      const activeElement = document.activeElement;
      return (
        activeElement instanceof HTMLAnchorElement &&
        activeElement.textContent?.trim() === expectedName
      );
    }, name);
    if (reachedLink) {
      await expect(link).toBeFocused();
      return link;
    }
  }
  throw new Error(`Keyboard focus did not reach the ${name} link`);
}

async function closeInOrder(
  cleanups: readonly (() => Promise<void>)[],
  primaryError: unknown,
): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (cause: unknown) {
      failures.push(cause);
    }
  }
  if (failures.length === 0) return;
  if (primaryError !== undefined) {
    throw new AggregateError(
      [primaryError, ...failures],
      "Sales journey and cleanup failed",
      { cause: primaryError },
    );
  }
  throw new AggregateError(failures, "Sales journey cleanup failed");
}

test.describe("provider-neutral Sales reporting journey", () => {
  test("covers reporting, operational review, payouts, bounded CSV, privacy, and reflow", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(720_000);
    const cleanups: Array<() => Promise<void>> = [];
    let primaryError: unknown;
    try {
      const database = await openE2EDatabase();
      cleanups.unshift(() => database.close());
      const financial = createFinancialHarness(database, baseURL);
      cleanups.unshift(() => financial.close());
      const adminContext = await browser.newContext({
        baseURL,
        serviceWorkers: "block",
      });
      cleanups.unshift(() => adminContext.close());
      const adminPage = await adminContext.newPage();
      await signInAdministrator(adminPage);
      const anonymousContext = await browser.newContext({ baseURL });
      cleanups.unshift(() => anonymousContext.close());
      const customerContext = await browser.newContext({ baseURL });
      cleanups.unshift(() => customerContext.close());
      const customerEmail = `sales-customer-${randomUUID()}@example.test`;
      const customerPage = await registerAndVerifyCustomer(customerContext, {
        email: customerEmail,
        password: "sales-reporting-customer-password-2026",
        displayName: "Sales Reporting Customer",
      });
      cleanups.unshift(() => customerPage.close());
      const privacy = await financial.capturePrivacy(adminPage);
      cleanups.unshift(() => privacy.close());

      const deniedExportAuditBefore =
        await financial.auditCount(SALES_EXPORT_ACTION);
      await expectSameAuthorizationDenial(
        anonymousContext,
        { pageStatus: 303, apiStatus: 401, code: "unauthenticated" },
        [customerEmail],
      );
      await expectSameAuthorizationDenial(
        customerContext,
        { pageStatus: 403, apiStatus: 403, code: "forbidden" },
        [customerEmail],
      );
      await expect
        .poll(() => financial.auditCount(SALES_EXPORT_ACTION))
        .toBe(deniedExportAuditBefore);

      await financial.withIsolatedEmptyDefaultSalesCohort(async () => {
        const emptyResponse = await adminPage.goto("/admin/sales");
        expect(emptyResponse?.status()).toBe(200);
        await expect(adminPage).toHaveURL(`${baseURL}/admin/sales`);
        await waitForSalesFilterHydration(adminPage);
        await expect(
          adminPage.getByRole("heading", { name: "No sales data yet" }),
        ).toBeVisible();
        await expect(
          adminPage.getByRole("heading", {
            name: "No sales match these filters",
          }),
        ).toHaveCount(0);
        const emptyStatus = adminPage.getByRole("status");
        await expect(emptyStatus).toHaveAttribute("aria-live", "polite");
        await expect(emptyStatus).toHaveAttribute("aria-atomic", "true");
        await expect(emptyStatus).toHaveText("0 matching sales rows.");
      });

      const emptyTitleId = randomUUID();
      await adminPage.goto(
        `/admin/sales?range=all&titleId=${emptyTitleId}&sort=gross_desc`,
      );
      await expect(
        adminPage.getByRole("heading", { name: "Sales overview" }),
      ).toBeVisible();
      const globalNavigation = adminPage.getByRole("navigation", {
        name: "Admin sections",
      });
      const salesLink = globalNavigation.getByRole("link", {
        name: "Sales",
        exact: true,
      });
      await expect(salesLink).toBeVisible();
      await expect(salesLink).toHaveAttribute("href", "/admin/sales");
      await expect(salesLink).toHaveClass(/\bactive\b/u);
      await expect(globalNavigation.getByText("Upcoming")).toHaveCount(0);
      await expect(
        adminPage.getByRole("heading", {
          name: "No sales match these filters",
        }),
      ).toBeVisible();
      await expect(adminPage.getByRole("status")).toHaveText(
        "0 matching sales rows.",
      );
      await expect(
        adminPage.getByRole("alert").filter({ hasText: "Stripe is disabled." }),
      ).toContainText("Stripe is disabled.");

      for (const kind of ["rows", "bytes", "deadline"] as const) {
        const bound = await financial.seedSalesExportBound(kind);
        try {
          const auditBeforeBound =
            await financial.auditCount(SALES_EXPORT_ACTION);
          await expectSafeExportFailure(
            adminContext.request,
            bound.exportPath,
            kind === "deadline"
              ? { status: 503, code: "temporarily_unavailable" }
              : { status: 400, code: "invalid_request" },
            [customerEmail, ...bound.privateValues],
          );
          await expect
            .poll(() => financial.auditCount(SALES_EXPORT_ACTION))
            .toBe(auditBeforeBound);
        } finally {
          await bound.close();
        }
      }

      await adminPage.goto("/admin/sales?range=all&sort=title_asc");
      await expect(
        adminPage.getByRole("heading", { name: "Sales overview" }),
      ).toBeVisible();
      const baselineNeedsReviewCount = await readNeedsReviewCount(adminPage);
      const baselineSales = await collectSalesTitlePages(adminPage);
      const baselineRowCount = baselineSales.titles.length;
      await adminPage.goto("/admin/sales/review");
      const baselineReviewQueue = await collectReviewQueuePages(adminPage);
      expect(baselineNeedsReviewCount).toBe(
        baselineReviewQueue.issueIds.length,
      );

      const fixture = await financial.seedSalesReportingMatrix();
      expect(fixture.publicCohort.titles).toHaveLength(
        fixture.overviewRowCount,
      );
      expect(new Set(fixture.publicCohort.titles).size).toBe(
        fixture.overviewRowCount,
      );
      await adminPage.goto("/admin/sales?range=all&sort=gross_desc");
      await expect(
        adminPage.getByRole("heading", { name: "Sales overview" }),
      ).toBeVisible();
      await expect(adminPage.getByRole("status")).toHaveText(
        `${fixture.firstPageRowCount} matching sales rows.`,
      );
      await expect(adminPage.getByText("Financial data through")).toBeVisible();
      expect(await readNeedsReviewCount(adminPage)).toBe(
        baselineNeedsReviewCount + 1,
      );

      await adminPage.goto(
        `/admin/sales?range=all&titleId=${fixture.titles.archived.id}&sort=gross_desc`,
      );
      const archived = salesRow(
        adminPage,
        fixture.titles.archived.currentTitle,
      );
      await expect(archived).toBeVisible();
      await expect(archived).toContainText("Book · Archived");
      await expectMetric(archived, "Sold copies", "3");
      await expectMetric(archived, "Fully refunded copies", "1");
      await expectMetric(archived, "Net copies", "2");
      await expectMetric(archived, "Gross presentment", /\+USD\s+25\.00/u);
      await expectMetric(archived, "Finalized refunds", /\+USD\s+5\.00/u);
      await expectMetric(archived, "Dispute withdrawals", /\+USD\s+2\.00/u);
      await expectMetric(archived, "Dispute reinstatements", /\+USD\s+0\.50/u);
      await expectMetric(archived, "Gross settlement", /\+USD\s+23\.00/u);
      await expectMetric(archived, "Refund impact", /-USD\s+4\.60/u);
      await expectMetric(archived, "Dispute impact", /-USD\s+1\.38/u);
      await expectMetric(archived, "Processing fee impact", /-USD\s+0\.90/u);
      await expectMetric(archived, "Refund fee impact", /\+USD\s+0\.10/u);
      await expectMetric(archived, "Dispute fee impact", /-USD\s+0\.15/u);
      await expectMetric(archived, "Other fee impact", /\+USD\s+0\.03/u);
      await expectMetric(archived, "Estimated payout", /\+USD\s+16\.10/u);
      await archived.getByText("Sold-as details").click();
      await expect(archived).toContainText(fixture.titles.archived.soldAsTitle);
      await expect(archived).toContainText(
        fixture.titles.archived.soldAsCreator,
      );
      await expect(archived).toContainText("Comic");
      const archivedSummary = summaryCard(adminPage, "USD → USD");
      await expect(archivedSummary).toContainText("Fee reconciled");
      await expectMetric(
        archivedSummary,
        "Gross presentment",
        /\+USD\s+25\.00/u,
      );
      await expectMetric(archivedSummary, "Refund impact", /-USD\s+4\.60/u);
      await expectMetric(
        archivedSummary,
        "Estimated payout",
        /\+USD\s+16\.10/u,
      );

      // BEGIN manual Sales range transition witness.
      const customToPresetWitness =
        `/admin/sales?range=custom&from=${fixture.filterWindow.from}` +
        `&to=${fixture.filterWindow.to}&sort=gross_desc`;
      await adminPage.goto(customToPresetWitness);
      await waitForSalesFilterHydration(adminPage);
      await expect(adminPage.getByLabel("From date")).toHaveValue(
        fixture.filterWindow.from,
      );
      await expect(adminPage.getByLabel("To date")).toHaveValue(
        fixture.filterWindow.to,
      );
      await adminPage.getByLabel("Range").selectOption("all");
      await expect(adminPage.getByLabel("From date")).toHaveValue(
        fixture.filterWindow.from,
      );
      await expect(adminPage.getByLabel("To date")).toHaveValue(
        fixture.filterWindow.to,
      );
      const customUrl = adminPage.url();
      const [presetResponse] = await Promise.all([
        adminPage.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.origin === new URL(baseURL).origin &&
            (url.pathname === "/admin/sales" ||
              url.pathname === "/admin/sales/__data.json") &&
            ["document", "fetch"].includes(response.request().resourceType())
          );
        }),
        adminPage.waitForURL((url) => url.href !== customUrl),
        adminPage
          .getByRole("button", { name: "Apply filters" })
          .click(),
      ]);
      expect(presetResponse.status()).toBe(200);
      await adminPage.waitForLoadState("networkidle");
      expect(Object.fromEntries(new URL(adminPage.url()).searchParams)).toEqual({
        range: "all",
        sort: "gross_desc",
      });
      await expect(adminPage.getByLabel("From date")).toHaveValue("");
      await expect(adminPage.getByLabel("To date")).toHaveValue("");

      await adminPage.getByLabel("Range").selectOption("custom");
      await adminPage
        .getByLabel("From date")
        .fill(fixture.filterWindow.from);
      await adminPage.getByLabel("To date").fill(fixture.filterWindow.to);
      const presetUrl = adminPage.url();
      const [customResponse] = await Promise.all([
        adminPage.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.origin === new URL(baseURL).origin &&
            (url.pathname === "/admin/sales" ||
              url.pathname === "/admin/sales/__data.json") &&
            ["document", "fetch"].includes(response.request().resourceType())
          );
        }),
        adminPage.waitForURL((url) => url.href !== presetUrl),
        adminPage
          .getByRole("button", { name: "Apply filters" })
          .click(),
      ]);
      expect(customResponse.status()).toBe(200);
      await adminPage.waitForLoadState("networkidle");
      expect(Object.fromEntries(new URL(adminPage.url()).searchParams)).toEqual({
        range: "custom",
        from: fixture.filterWindow.from,
        to: fixture.filterWindow.to,
        sort: "gross_desc",
      });
      await expect(adminPage.getByLabel("From date")).toHaveValue(
        fixture.filterWindow.from,
      );
      await expect(adminPage.getByLabel("To date")).toHaveValue(
        fixture.filterWindow.to,
      );
      // END manual Sales range transition witness.
      await expectPublicCohortTitles(
        adminPage,
        fixture.publicCohort.titles,
        fixture.filterWindow.expectedTitles,
      );

      await applyFilters(adminPage, { range: "all", format: "comic" });
      await expectPublicCohortTitles(
        adminPage,
        fixture.publicCohort.titles,
        fixture.expectedFilterTitles.comic,
      );

      await applyFilters(adminPage, {
        range: "all",
        presentmentCurrency: "EUR",
        settlementCurrency: "USD",
      });
      await expectPublicCohortTitles(adminPage, fixture.publicCohort.titles, [
        fixture.titles.fx.currentTitle,
      ]);
      const fx = salesRow(adminPage, fixture.titles.fx.currentTitle);
      await expectMetric(fx, "Gross presentment", /\+EUR\s+15\.00/u);
      await expectMetric(fx, "Gross settlement", /\+USD\s+16\.50/u);
      await expectMetric(fx, "Estimated payout", /\+USD\s+15\.90/u);
      await adminPage.goto(
        `/admin/sales?range=all&titleId=${fixture.titles.fx.id}&sort=gross_desc`,
      );
      const fxSummary = summaryCard(adminPage, "EUR → USD");
      await expectMetric(fxSummary, "Gross presentment", /\+EUR\s+15\.00/u);
      await expectMetric(fxSummary, "Gross settlement", /\+USD\s+16\.50/u);

      for (const [state, expectedTitles] of [
        ["pending", fixture.expectedFilterTitles.pending],
        ["fee_reconciled", fixture.expectedFilterTitles.feeReconciled],
        ["payout_reconciled", fixture.expectedFilterTitles.payoutReconciled],
        ["exception", fixture.expectedFilterTitles.exception],
      ] as const) {
        await applyFilters(adminPage, { range: "all", state });
        await expectPublicCohortTitles(
          adminPage,
          fixture.publicCohort.titles,
          expectedTitles,
        );
      }

      await applyFilters(adminPage, {
        range: "all",
        settlementCurrency: "pending",
      });
      await expectPublicCohortTitles(
        adminPage,
        fixture.publicCohort.titles,
        fixture.expectedFilterTitles.settlementPending,
      );

      await applyFilters(adminPage, {
        range: "all",
        titleId: fixture.titles.knownZero.id,
      });
      const knownZero = salesRow(
        adminPage,
        fixture.titles.knownZero.currentTitle,
      );
      await expectMetric(knownZero, "Gross settlement", /USD\s+0\.00/u);
      await expectMetric(knownZero, "Refund impact", /USD\s+0\.00/u);
      await expectMetric(knownZero, "Estimated payout", /USD\s+0\.00/u);
      await expect(
        knownZero.getByText("Settlement estimate unavailable"),
      ).toHaveCount(0);
      const knownZeroSummary = summaryCard(adminPage, "USD → USD");
      await expectMetric(knownZeroSummary, "Gross settlement", /USD\s+0\.00/u);
      await expectMetric(knownZeroSummary, "Estimated payout", /USD\s+0\.00/u);

      await applyFilters(adminPage, {
        range: "all",
        titleId: fixture.titles.incomplete.id,
      });
      const incomplete = salesRow(
        adminPage,
        fixture.titles.incomplete.currentTitle,
      );
      await expect(
        incomplete.getByText("Settlement estimate unavailable"),
      ).toBeVisible();
      await expect(incomplete).toContainText("2 missing sources");
      await expect(
        incomplete.getByText("Gross settlement", { exact: true }),
      ).toHaveCount(0);
      for (const label of [
        "Refund impact",
        "Dispute impact",
        "Processing fee impact",
        "Refund fee impact",
        "Dispute fee impact",
        "Other fee impact",
        "Estimated payout",
        "Payout reconciled",
      ]) {
        await expect(incomplete.getByText(label, { exact: true })).toHaveCount(
          0,
        );
      }
      const incompleteSummary = summaryCard(adminPage, "USD → USD");
      await expect(
        incompleteSummary.getByText("Settlement estimate unavailable"),
      ).toBeVisible();
      await expect(incompleteSummary).toContainText("2 missing sources");
      await expect(
        incompleteSummary.getByText("Gross settlement", { exact: true }),
      ).toHaveCount(0);
      for (const label of [
        "Refund impact",
        "Dispute impact",
        "Processing fee impact",
        "Refund fee impact",
        "Dispute fee impact",
        "Other fee impact",
        "Estimated payout",
        "Payout reconciled",
      ]) {
        await expect(
          incompleteSummary.getByText(label, { exact: true }),
        ).toHaveCount(0);
      }

      await applyFilters(adminPage, { range: "all", sort: "title_asc" });
      const allTimeSales = await collectSalesTitlePages(adminPage);
      const firstPageTitles = allTimeSales.pages[0] ?? [];
      expect(firstPageTitles).toHaveLength(50);
      expect(allTimeSales.pages.length).toBeGreaterThanOrEqual(2);
      expect(allTimeSales.titles).toHaveLength(
        baselineRowCount + fixture.overviewRowCount,
      );
      const currentCohortTitles = projectPublicCohort(
        allTimeSales.titles,
        fixture.publicCohort.titles,
      );
      expect(currentCohortTitles).toHaveLength(fixture.overviewRowCount);
      expect(new Set(currentCohortTitles)).toEqual(
        new Set(fixture.publicCohort.titles),
      );
      expect(firstPageTitles).not.toContain(
        fixture.pagination.secondPageMarker,
      );
      expect(allTimeSales.pages.slice(1).flat()).toContain(
        fixture.pagination.secondPageMarker,
      );
      await expect(
        adminPage.getByRole("link", { name: "First page" }),
      ).toBeVisible();
      await adminPage.getByRole("link", { name: "First page" }).click();
      await expect
        .poll(() => visibleSalesTitles(adminPage))
        .toEqual(firstPageTitles);

      await adminPage.goto("/admin/sales");
      expect(await readNeedsReviewCount(adminPage)).toBe(
        baselineNeedsReviewCount + 1,
      );
      await adminPage.goto("/admin/sales/review");
      const reviewQueue = await collectReviewQueuePages(adminPage);
      expect(reviewQueue.issueIds).toHaveLength(baselineNeedsReviewCount + 1);
      expect([...reviewQueue.issueIds].sort()).toEqual(
        [...baselineReviewQueue.issueIds, fixture.issue.id].sort(),
      );
      expect(
        reviewQueue.issueIds.filter((issueId) => issueId === fixture.issue.id),
      ).toHaveLength(1);
      for (const excludedIssueId of fixture.issue.excludedIssueIds) {
        expect(reviewQueue.issueIds).not.toContain(excludedIssueId);
      }
      const fixtureIssuePage = reviewQueue.pageByIssueId.get(fixture.issue.id);
      if (fixtureIssuePage === undefined) {
        throw new Error("Seeded Sales issue was absent from the review queue");
      }
      await adminPage.goto(fixtureIssuePage);
      await expect(adminPage.getByRole("status")).toHaveText(
        /^\d+ current issues? on this page\.$/u,
      );
      const reviewRegion = adminPage.getByRole("region", {
        name: "Financial issues needing review",
      });
      const issueRow = reviewRegion
        .getByRole("row")
        .filter({ hasText: fixture.issue.id });
      await expect(issueRow).toHaveCount(1);
      await expect(issueRow).toContainText(fixture.issue.safeCode);
      const issueAuditBefore = await financial.auditCount(
        ISSUE_VIEW_ACTION,
        fixture.issue.id,
      );
      await issueRow.getByRole("link", { name: "View issue" }).click();
      await expect(
        adminPage.getByRole("heading", { name: "Financial issue" }),
      ).toBeVisible();
      await expect(adminPage.locator("main")).toContainText(fixture.issue.id);
      await expect(adminPage.locator("main")).toContainText(
        fixture.issue.resourceId,
      );
      await expect(adminPage.locator("main")).toContainText(
        fixture.issue.safeReason,
      );
      await expect
        .poll(() => financial.auditCount(ISSUE_VIEW_ACTION, fixture.issue.id))
        .toBe(issueAuditBefore + 1);
      await expectPrivateValuesAbsent(
        adminPage,
        fixture.privateValues.filter(
          (value) => value !== fixture.issue.resourceId,
        ),
        fixture.issue.safeReason,
      );

      await adminPage.goto("/admin/sales/payouts");
      await expect(
        adminPage.getByRole("heading", { name: "Payouts" }),
      ).toBeVisible();
      const pending = payoutRow(adminPage, fixture.payouts.pending.id);
      await expect(pending).toContainText("Pending");
      await expect(pending).toContainText("In progress");

      const completed = payoutRow(
        adminPage,
        fixture.payouts.completedAutomatic.id,
      );
      await expect(completed).toContainText("Paid");
      await expect(completed).toContainText("Completed");
      await expect(completed).toContainText("Automatic");
      await expect(completed).toContainText("Standard");
      await expect(completed).toContainText("Financial generation 1");
      await expect(completed).toContainText("Membership generation 1");
      await expect(completed).toContainText("Associated transactions");
      await expect(completed).not.toContainText(
        "Historical payout membership retained",
      );

      const failed = payoutRow(adminPage, fixture.payouts.failedAfterPaid.id);
      await expect(failed).toContainText("Failed");
      await expect(failed).toContainText(
        "Historical payout membership retained",
      );
      await expect(failed).toContainText(
        fixture.payouts.failedAfterPaid.safeFailureCode,
      );

      const manual = payoutRow(adminPage, fixture.payouts.manual.id);
      const instant = payoutRow(adminPage, fixture.payouts.instant.id);
      for (const limited of [manual, instant]) {
        await expect(limited).toContainText(
          "Fee reconciled — exact payout membership unavailable",
        );
      }
      await expect(manual).toContainText("Manual");
      await expect(instant).toContainText("Instant");

      const payoutDetails = [
        {
          payout: fixture.payouts.pending,
          status: "Pending",
          reconciliation: "In progress",
          mode: "Automatic · Standard",
          financialGeneration: "0",
          membershipGeneration: "Unavailable",
          membership: "Membership unavailable",
          failureCode: "None",
          notice: "Membership unavailable",
          historicalMembership: false,
        },
        {
          payout: fixture.payouts.completedAutomatic,
          status: "Paid",
          reconciliation: "Completed",
          mode: "Automatic · Standard",
          financialGeneration: "1",
          membershipGeneration: "1",
          membership: "Current and complete",
          failureCode: "None",
          notice: null,
          historicalMembership: false,
        },
        {
          payout: fixture.payouts.failedAfterPaid,
          status: "Failed",
          reconciliation: "Completed",
          mode: "Automatic · Standard",
          financialGeneration: "2",
          membershipGeneration: "1",
          membership: "Historical payout membership retained",
          failureCode: fixture.payouts.failedAfterPaid.safeFailureCode,
          notice: "Historical payout membership retained",
          historicalMembership: true,
        },
        {
          payout: fixture.payouts.manual,
          status: "Paid",
          reconciliation: "Not applicable",
          mode: "Manual · Standard",
          financialGeneration: "0",
          membershipGeneration: "Unavailable",
          membership: "Membership unavailable",
          failureCode: "None",
          notice: "Fee reconciled — exact payout membership unavailable",
          historicalMembership: false,
        },
        {
          payout: fixture.payouts.instant,
          status: "Paid",
          reconciliation: "Not applicable",
          mode: "Automatic · Instant",
          financialGeneration: "0",
          membershipGeneration: "Unavailable",
          membership: "Membership unavailable",
          failureCode: "None",
          notice: "Fee reconciled — exact payout membership unavailable",
          historicalMembership: false,
        },
      ] as const;

      for (const expectedPayout of payoutDetails) {
        const { payout } = expectedPayout;
        const before = await financial.auditCount(
          PAYOUT_VIEW_ACTION,
          payout.id,
        );
        await adminPage.goto(`/admin/sales/payouts/${payout.id}`);
        await expect(
          adminPage.getByRole("heading", { name: "Payout detail" }),
        ).toBeVisible();
        const payoutDetail = adminPage.locator("main");
        await expect(payoutDetail).toContainText(payout.id);
        await expect(payoutDetailValue(adminPage, "Status")).toHaveText(
          expectedPayout.status,
        );
        await expect(payoutDetailValue(adminPage, "Reconciliation")).toHaveText(
          expectedPayout.reconciliation,
        );
        await expect(payoutDetailValue(adminPage, "Mode")).toHaveText(
          expectedPayout.mode,
        );
        await expect(
          payoutDetailValue(adminPage, "Financial generation"),
        ).toHaveText(expectedPayout.financialGeneration);
        await expect(
          payoutDetailValue(adminPage, "Membership generation"),
        ).toHaveText(expectedPayout.membershipGeneration);
        await expect(payoutDetailValue(adminPage, "Membership")).toHaveText(
          expectedPayout.membership,
        );
        await expect(payoutDetailValue(adminPage, "Failure code")).toHaveText(
          expectedPayout.failureCode,
        );
        const notices = payoutDetail.locator("p.sales-notice");
        if (expectedPayout.notice === null) {
          await expect(
            notices.filter({
              hasText:
                /Membership unavailable|Historical payout membership retained|exact payout membership unavailable/u,
            }),
          ).toHaveCount(0);
        } else {
          await expect(
            notices.filter({ hasText: expectedPayout.notice }),
          ).toHaveCount(1);
        }
        await expect(
          notices.filter({ hasText: "Historical payout membership retained" }),
        ).toHaveCount(expectedPayout.historicalMembership ? 1 : 0);
        await expect
          .poll(() => financial.auditCount(PAYOUT_VIEW_ACTION, payout.id))
          .toBe(before + 1);
        await expectPrivateValuesAbsent(
          adminPage,
          fixture.privateValues,
          payout.id,
        );
      }

      await adminPage.goto("/admin/sales?range=all&sort=title_asc");
      const exportLink = adminPage.getByRole("link", {
        name: "Export filtered CSV",
      });
      await expect(exportLink).toBeVisible();
      const exportPath = await exportLink.getAttribute("href");
      if (exportPath === null)
        throw new Error("Discoverable Sales export had no URL");
      expect(exportPath).not.toContain("cursor=");

      const exportAuditBefore = await financial.auditCount(SALES_EXPORT_ACTION);
      const stableExports = await financial.withWorkerClaimBarrier(async () => {
        const stableAllTimeSales = await collectSalesTitlePages(adminPage);
        const downloadPromise = adminPage.waitForEvent("download");
        await exportLink.click();
        const download = await downloadPromise;
        const csv = await readDownload(download);
        const directResponse = await adminContext.request.get(exportPath);
        const directCsv = await directResponse.text();
        expect(directCsv).toBe(csv);
        return {
          rowCount: stableAllTimeSales.titles.length,
          browser: {
            suggestedFilename: download.suggestedFilename(),
            body: csv,
          },
          direct: {
            status: directResponse.status(),
            contentType: directResponse.headers()["content-type"],
            disposition: directResponse.headers()["content-disposition"],
            body: directCsv,
          },
        };
      });
      assertSalesPrivacy(
        "sales csv",
        stableExports.browser,
        fixture.privateValues,
      );
      expect(stableExports.browser.suggestedFilename).toBe(
        "pale-orbit-sales-all-time.csv",
      );
      const csvLines = stableExports.browser.body.trimEnd().split("\r\n");
      expect(csvLines).toHaveLength(stableExports.rowCount + 1);
      expect(stableExports.browser.body).toContain(
        fixture.pagination.secondPageMarker,
      );
      expect(stableExports.browser.body).toContain(fixture.publicCohort.suffix);
      expect(stableExports.browser.body).toContain(",-460,");
      expect(stableExports.browser.body).toContain(
        ",1610,true,0,fee_reconciled,",
      );
      assertSalesPrivacy(
        "sales csv",
        stableExports.direct,
        fixture.privateValues,
      );
      expect(stableExports.direct.status).toBe(200);
      expect(stableExports.direct.contentType).toBe("text/csv; charset=utf-8");
      expect(stableExports.direct.disposition).toContain(
        "pale-orbit-sales-all-time.csv",
      );
      expect(stableExports.direct.body).toBe(stableExports.browser.body);
      await expect
        .poll(() => financial.auditCount(SALES_EXPORT_ACTION))
        .toBe(exportAuditBefore + 2);

      await adminPage.setViewportSize({ width: 320, height: 900 });
      await waitForSettledLayout(adminPage);
      for (const name of [
        "Range",
        "Format",
        "Settlement currency",
        "Financial state",
        "Sort",
      ]) {
        await expect(
          adminPage.getByRole("combobox", { name, exact: true }),
        ).toBeVisible();
      }
      for (const name of [
        "From date",
        "To date",
        "Title ID",
        "Presentment currency",
      ]) {
        await expect(
          adminPage.getByRole("textbox", { name, exact: true }),
        ).toBeVisible();
      }
      await expect
        .poll(() =>
          adminPage.evaluate(() => {
            const root = document.documentElement;
            const clientWidth = root.clientWidth;
            const isContainedBySalesScroller = (element: Element): boolean => {
              for (
                let ancestor = element.parentElement;
                ancestor !== null && ancestor !== document.body;
                ancestor = ancestor.parentElement
              ) {
                const overflowX = getComputedStyle(ancestor).overflowX;
                if (
                  (overflowX === "auto" || overflowX === "scroll") &&
                  ancestor.scrollWidth > ancestor.clientWidth &&
                  ancestor.getAttribute("role") === "region" &&
                  ancestor.getAttribute("aria-label") ===
                    "Sales results by title" &&
                  ancestor.getAttribute("tabindex") === "0"
                ) {
                  return true;
                }
              }
              return false;
            };

            return {
              clientWidth,
              scrollWidth: root.scrollWidth,
              rootFits: root.scrollWidth <= clientWidth + 1,
              uncontainedOverflow: Array.from(
                document.querySelectorAll("body *"),
              )
                .filter(
                  (element) =>
                    element.getBoundingClientRect().right > clientWidth + 1 &&
                    !isContainedBySalesScroller(element),
                )
                .slice(0, 12)
                .map((element) => {
                  const rect = element.getBoundingClientRect();
                  const style = getComputedStyle(element);
                  return {
                    tag: element.tagName.toLowerCase(),
                    className:
                      typeof element.className === "string"
                        ? element.className
                        : "",
                    left: Math.round(rect.left),
                    right: Math.round(rect.right),
                    width: Math.round(rect.width),
                    clientWidth: element.clientWidth,
                    scrollWidth: element.scrollWidth,
                    display: style.display,
                    overflowX: style.overflowX,
                    minWidth: style.minWidth,
                    whiteSpace: style.whiteSpace,
                  };
                }),
            };
          }),
        )
        .toMatchObject({
          clientWidth: 320,
          rootFits: true,
          uncontainedOverflow: [],
        });
      const tableRegion = salesRegion(adminPage);
      await expect(tableRegion).toHaveAttribute("tabindex", "0");
      await expect
        .poll(() =>
          tableRegion.evaluate((element) => {
            const overflow = getComputedStyle(element).overflowX;
            const rect = element.getBoundingClientRect();
            const rootWidth = document.documentElement.clientWidth;
            return {
              overflowX: overflow,
              contentFits: element.scrollWidth <= element.clientWidth + 1,
              positiveDimensions:
                element.clientWidth > 0 && element.scrollWidth > 0,
              regionContained:
                rect.left >= -1 && rect.right <= rootWidth + 1,
            };
          }),
        )
        .toEqual({
          overflowX: "auto",
          contentFits: true,
          positiveDimensions: true,
          regionContained: true,
        });

      const keyboardLink = await focusNamedLinkWithKeyboard(
        adminPage,
        "Needs Review",
      );
      await expect(keyboardLink).toBeVisible();
      const focusStyle = await keyboardLink.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        };
      });
      expect(
        focusStyle.outlineStyle !== "none" &&
          Number.parseFloat(focusStyle.outlineWidth) > 0,
      ).toBe(true);
      await adminPage.keyboard.press("Enter");
      await expect(
        adminPage.getByRole("heading", { name: "Needs review" }),
      ).toBeVisible();
      await expect(adminPage.getByRole("status")).toHaveAttribute(
        "aria-live",
        "polite",
      );

      expect(testInfo.project.use).toMatchObject({ trace: "off" });
      const privacyEvidence = await privacy.snapshot();
      const normalizedConsole = normalizeFinancialConsoleEvidenceForPrivacy(
        privacyEvidence.console,
        baseURL,
        "https://books.example.test",
      );
      expect(
        privacyEvidence.externalRequests.filter(
          (request) => request !== "blocked-approved-font-css",
        ),
      ).toEqual([]);
      const requiredResponseWitnesses = [
        ["document", "sales response", fixture.titles.archived.currentTitle],
        [
          "initial-page-data",
          "sales response",
          fixture.titles.archived.currentTitle,
        ],
        ["svelte-data", "sales response", fixture.titles.archived.currentTitle],
        ["download", "sales csv", fixture.pagination.secondPageMarker],
      ] as const;
      const requiredKinds = new Set<
        (typeof privacyEvidence.responses)[number]["kind"]
      >(requiredResponseWitnesses.map(([kind]) => kind));
      for (const [kind, surface, witness] of requiredResponseWitnesses) {
        const entries = privacyEvidence.responses.filter(
          (response) => response.kind === kind,
        );
        if (
          entries.length === 0 ||
          entries.some((entry) => entry.body.trim().length === 0)
        ) {
          throw new Error(`Sales ${kind} evidence was missing or empty`);
        }
        requireCapturedSalesWitness(surface, kind, entries, witness);
        for (const entry of entries) {
          const containsPublicIssueResource =
            kind !== "download" &&
            entry.body.includes(fixture.issue.id) &&
            entry.body.includes(fixture.issue.safeCode) &&
            entry.body.includes(fixture.issue.resourceId);
          assertSalesPrivacy(
            surface,
            entry,
            containsPublicIssueResource
              ? fixture.privateValues.filter(
                  (value) => value !== fixture.issue.resourceId,
                )
              : fixture.privateValues,
          );
        }
      }
      for (const consoleWitness of [
        FINANCIAL_CAPTURE_CONSOLE_WITNESS,
        FINANCIAL_CAPTURE_STRUCTURED_CONSOLE_WITNESS,
      ]) {
        requireCapturedSalesWitness(
          "sales console",
          "console",
          normalizedConsole,
          consoleWitness,
        );
      }
      assertSalesPrivacy(
        "sales browser",
        privacyEvidence.externalRequests,
        fixture.privateValues,
      );
      for (const response of privacyEvidence.responses) {
        if (!requiredKinds.has(response.kind)) {
          assertSalesPrivacy("sales response", response, fixture.privateValues);
        }
      }
      assertSalesPrivacy(
        "sales console",
        normalizedConsole,
        fixture.privateValues,
      );
      await expectPrivateValuesAbsent(
        adminPage,
        fixture.privateValues,
        fixture.issue.safeCode,
      );
    } catch (error: unknown) {
      primaryError = error;
      throw error;
    } finally {
      await closeInOrder(cleanups, primaryError);
    }
  });
});
