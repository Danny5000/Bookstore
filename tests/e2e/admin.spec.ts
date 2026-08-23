import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { registerAndVerifyCustomer } from "./customer-session";
import {
  administratorEmail,
  administratorPassword,
  baseURL,
  signIn,
  waitForHydratedHandler,
} from "./publication-admin";

const customerPassword = "customer-admin-password-2026";
const actionRequestHeaders = {
  Accept: "application/json",
  Origin: new URL(baseURL).origin,
} as const;

function expectJsonResponse(
  response: Readonly<{
    headers(): Readonly<Record<string, string>>;
    status(): number;
  }>,
  status: number,
): void {
  expect(response.status()).toBe(status);
  expect(response.headers()["content-type"]).toMatch(
    /^application\/json(?:;|$)/u,
  );
}

async function waitForSettledLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function signOut(page: Page): Promise<void> {
  const button = page
    .locator("header")
    .getByRole("button", { name: "Sign out" });
  await waitForHydratedHandler(button);
  await button.click();
}

async function restoreBootstrapAdministrator(
  context: BrowserContext,
  bootstrapId: string,
): Promise<void> {
  const response = await context.request.post("/admin/users?/setAdmin", {
    form: { userId: bootstrapId, enabled: "true" },
    headers: actionRequestHeaders,
    maxRedirects: 0,
  });
  expectJsonResponse(response, 200);
  const body = (await response.json()) as object;
  expect(body, "bootstrap administrator restoration result").toMatchObject({
    type: "success",
    status: 200,
  });
}

test("anonymous users are redirected away from administration", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/?auth=required$/);
});

test("administrator surfaces reflow at 320 CSS pixels", async ({ page }) => {
  await page.route(
    /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//u,
    (route) => route.abort("blockedbyclient"),
  );
  await page.goto("/");
  await signIn(page, administratorEmail, administratorPassword);
  await page.goto("/admin");
  await page.setViewportSize({ width: 320, height: 900 });
  await waitForSettledLayout(page);
  const reflow = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    return {
      clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowingElements: Array.from(document.querySelectorAll("body *"))
        .filter(
          (element) => element.getBoundingClientRect().right > clientWidth + 1,
        )
        .slice(0, 12)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          className:
            typeof element.className === "string" ? element.className : "",
        })),
    };
  });
  expect(reflow.clientWidth).toBe(320);
  expect(reflow.scrollWidth).toBeLessThanOrEqual(reflow.clientWidth + 1);
  expect(reflow.overflowingElements).toEqual([]);

  await page.goto("/admin/sales?range=all");
  await expect(
    page.getByRole("heading", { name: "Sales overview" }),
  ).toBeVisible();
  await waitForSettledLayout(page);
  const salesReflow = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    return {
      clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowingElements: Array.from(document.querySelectorAll("body *"))
        .filter(
          (element) => element.getBoundingClientRect().right > clientWidth + 1,
        )
        .slice(0, 12)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          className:
            typeof element.className === "string" ? element.className : "",
        })),
    };
  });
  expect(salesReflow.clientWidth).toBe(320);
  expect(salesReflow.scrollWidth).toBeLessThanOrEqual(
    salesReflow.clientWidth + 1,
  );
  expect(salesReflow.overflowingElements).toEqual([]);
});

test("server authorization and audited role controls govern admin access", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const customerEmail = `${randomUUID()}@example.com`;
  let customerContext: BrowserContext | undefined;
  let administratorContext: BrowserContext | undefined;
  let bootstrapId: string | undefined;
  let bootstrapAdminMayNeedRestoration = false;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;

  try {
    customerContext = await browser.newContext({ baseURL });
    const customerPage = await registerAndVerifyCustomer(customerContext, {
      email: customerEmail,
      password: customerPassword,
      displayName: "Role Test Customer",
    });

    const forbidden = await customerPage.goto("/admin");
    expect(forbidden?.status()).toBe(403);
    const crossSite = await customerContext.request.post(
      "/admin/users?/setAdmin",
      {
        form: { userId: randomUUID(), enabled: "true" },
        headers: {
          ...actionRequestHeaders,
          Origin: "https://attacker.example.test",
        },
        maxRedirects: 0,
      },
    );
    expectJsonResponse(crossSite, 403);
    expect(await crossSite.json()).toEqual({
      message: "Cross-site POST form submissions are forbidden",
    });
    const forged = await customerContext.request.post(
      "/admin/users?/setAdmin",
      {
        form: { userId: randomUUID(), enabled: "true" },
        headers: actionRequestHeaders,
        maxRedirects: 0,
      },
    );
    expectJsonResponse(forged, 200);
    expect((await forged.json()) as object).toMatchObject({
      type: "failure",
      status: 403,
    });

    administratorContext = await browser.newContext({ baseURL });
    const administratorPage = await administratorContext.newPage();
    await administratorPage.goto("/");
    await signIn(administratorPage, administratorEmail, administratorPassword);
    await administratorPage.goto("/admin");
    await expect(
      administratorPage.getByRole("heading", {
        name: "Publication control room",
      }),
    ).toBeVisible();
    await administratorPage
      .getByRole("link", { name: "Users", exact: true })
      .click();

    const customerRow = administratorPage
      .getByRole("row")
      .filter({ hasText: customerEmail });
    const customerId = await customerRow
      .locator('input[name="userId"]')
      .inputValue();
    await customerRow.getByRole("button", { name: "Grant admin" }).click();
    await expect(customerRow.getByText(/customer · admin/)).toBeVisible();

    await customerPage.goto("/");
    await signOut(customerPage);
    await signIn(customerPage, customerEmail, customerPassword);
    await customerPage.goto("/admin/users");
    await expect(
      customerPage.getByRole("heading", { name: "Users" }),
    ).toBeVisible();

    const bootstrapRow = administratorPage
      .getByRole("row")
      .filter({ hasText: administratorEmail });
    bootstrapId = await bootstrapRow
      .locator('input[name="userId"]')
      .inputValue();
    bootstrapAdminMayNeedRestoration = true;
    await bootstrapRow.getByRole("button", { name: "Revoke admin" }).click();
    await expect(
      bootstrapRow.getByText("customer", { exact: true }),
    ).toBeVisible();

    await customerPage.reload();
    await expect(
      customerPage.getByRole("heading", { name: "Users" }),
    ).toBeVisible();
    const ownRow = customerPage
      .getByRole("row")
      .filter({ hasText: customerEmail });
    await expect(
      ownRow.getByRole("button", { name: "Revoke admin" }),
    ).toBeDisabled();
    const lastAdminAttempt = await customerContext.request.post(
      "/admin/users?/setAdmin",
      {
        form: { userId: customerId, enabled: "false" },
        headers: actionRequestHeaders,
        maxRedirects: 0,
      },
    );
    expectJsonResponse(lastAdminAttempt, 200);
    expect((await lastAdminAttempt.json()) as object).toMatchObject({
      type: "failure",
      status: 409,
    });
  } catch (cause: unknown) {
    hasPrimaryFailure = true;
    primaryFailure = cause;
  }

  const cleanupFailures: unknown[] = [];
  if (
    bootstrapAdminMayNeedRestoration &&
    bootstrapId !== undefined &&
    customerContext
  ) {
    try {
      await restoreBootstrapAdministrator(customerContext, bootstrapId);
    } catch (cause: unknown) {
      cleanupFailures.push(cause);
    }
  }
  for (const context of [administratorContext, customerContext]) {
    if (!context) continue;
    try {
      await context.close();
    } catch (cause: unknown) {
      cleanupFailures.push(cause);
    }
  }

  if (hasPrimaryFailure) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        "Admin role-control journey failed; cleanup failures follow the primary failure",
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "Admin role-control journey cleanup failed",
    );
  }
});
