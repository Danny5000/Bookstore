import { expect, test, type Locator, type Page } from "@playwright/test";
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
  type FinancialArtifactEvidence,
  type FinancialCommandRun,
  type FinancialHarness,
  type FinancialRefundFixture,
} from "./financial-harness";
import { baseURL, waitForHydratedHandler } from "./publication-admin";

test.describe.configure({ mode: "serial" });

const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const publicEmailEvidenceOrigin = "https://books.example.test";

function normalizePublicEmailEvidence(body: string): string {
  return body.replaceAll(new URL(baseURL).origin, publicEmailEvidenceOrigin);
}

type FinancialEmailEvidence = Readonly<{
  template: string;
  soldAsTitle: string | null;
  accessState: string | null;
  affectedTitleCount: number | null;
  body: string;
}>;

function assertFinancialEmailPrivacy(
  messages: readonly FinancialEmailEvidence[],
  privateValues: readonly string[],
): void {
  assertCommercePrivacy(
    "financial email",
    messages.map((message) => ({
      template: message.template,
      soldAsTitle: message.soldAsTitle,
      accessState: message.accessState,
      affectedTitleCount: message.affectedTitleCount,
      body: normalizePublicEmailEvidence(message.body),
    })),
    privateValues,
  );
}

function financialEmailSafeProjection(
  messages: readonly FinancialEmailEvidence[],
): readonly Omit<FinancialEmailEvidence, "body">[] {
  return messages.map((message) => ({
    template: message.template,
    soldAsTitle: message.soldAsTitle,
    accessState: message.accessState,
    affectedTitleCount: message.affectedTitleCount,
  }));
}

interface FinancialArtifactWitnesses {
  readonly browserHtml: readonly string[];
  readonly browserText: readonly string[];
  readonly document: readonly string[];
  readonly initialPageData: readonly string[];
  readonly svelteData: readonly string[];
  readonly action: readonly string[];
  readonly commandStatus: readonly string[];
  readonly console: readonly string[];
}

function requireCapturedFinancialWitness(
  surface: CommercePrivacySurface,
  evidenceKind: string,
  evidence: unknown,
  candidates: readonly string[],
): void {
  const serialized = JSON.stringify(evidence);
  if (serialized === undefined) {
    throw new Error(`Financial ${evidenceKind} evidence was not serializable`);
  }
  const normalized = serialized.toLowerCase();
  const witness = candidates.find(
    (candidate) =>
      candidate.length > 0 && normalized.includes(candidate.toLowerCase()),
  );
  if (witness === undefined) {
    throw new Error(
      `Financial ${evidenceKind} evidence lacked its capture-resident witness`,
    );
  }
  expect(() => assertCommercePrivacy(surface, evidence, [witness])).toThrow(
    `Sensitive commerce data detected on ${surface}`,
  );
}

function financialArtifactWitnesses(
  fixture: FinancialRefundFixture,
  runs: readonly FinancialCommandRun[],
  browserWitnesses: readonly string[] = [fixture.items.attribution.soldAsTitle],
): FinancialArtifactWitnesses {
  const commandIds = runs.map((run) => run.commandId);
  return {
    browserHtml: browserWitnesses,
    browserText: browserWitnesses,
    document: [fixture.items.attribution.soldAsTitle],
    initialPageData: [fixture.items.preserved.soldAsTitle],
    svelteData: [fixture.items.recoverable.soldAsTitle],
    action: commandIds,
    commandStatus: commandIds,
    console: [
      FINANCIAL_CAPTURE_CONSOLE_WITNESS,
      FINANCIAL_CAPTURE_STRUCTURED_CONSOLE_WITNESS,
    ],
  };
}

function assertFinancialBrowserArtifacts(
  artifacts: FinancialArtifactEvidence,
  privateValues: readonly string[],
  witnesses: FinancialArtifactWitnesses,
): void {
  if (
    artifacts.browser.length === 0 ||
    artifacts.browser.some(
      (entry) => entry.html.length === 0 || entry.text.length === 0,
    )
  ) {
    throw new Error("Financial final browser evidence was missing");
  }
  const responsesByKind = new Map<
    FinancialArtifactEvidence["responses"][number]["kind"],
    FinancialArtifactEvidence["responses"]
  >();
  for (const response of artifacts.responses) {
    responsesByKind.set(response.kind, [
      ...(responsesByKind.get(response.kind) ?? []),
      response,
    ]);
  }
  for (const required of [
    "document",
    "initial-page-data",
    "svelte-data",
    "action",
    "command-status",
  ] as const) {
    const entries = responsesByKind.get(required) ?? [];
    if (
      entries.length === 0 ||
      entries.some((entry) => entry.body.trim().length === 0)
    ) {
      throw new Error(`Financial ${required} evidence was missing`);
    }
  }
  const responseSurface = (
    kind: FinancialArtifactEvidence["responses"][number]["kind"],
  ): CommercePrivacySurface =>
    kind === "document" || kind === "initial-page-data"
      ? "financial html"
      : kind === "download"
        ? "financial csv"
        : kind === "command-status"
          ? "financial status"
          : "financial json";

  const browserHtml = artifacts.browser.map((entry) => entry.html);
  const browserText = artifacts.browser.map((entry) => entry.text);
  const normalizedConsole = normalizeFinancialConsoleEvidenceForPrivacy(
    artifacts.console,
    baseURL,
    publicEmailEvidenceOrigin,
  );
  for (const consoleWitness of witnesses.console) {
    requireCapturedFinancialWitness(
      "financial log",
      "console",
      normalizedConsole,
      [consoleWitness],
    );
  }
  const requiredBuckets = [
    ["browser-html", "financial html", browserHtml, witnesses.browserHtml],
    ["browser-text", "financial browser", browserText, witnesses.browserText],
    [
      "document",
      "financial html",
      responsesByKind.get("document"),
      witnesses.document,
    ],
    [
      "initial-page-data",
      "financial html",
      responsesByKind.get("initial-page-data"),
      witnesses.initialPageData,
    ],
    [
      "svelte-data",
      "financial json",
      responsesByKind.get("svelte-data"),
      witnesses.svelteData,
    ],
    [
      "action",
      "financial json",
      responsesByKind.get("action"),
      witnesses.action,
    ],
    [
      "command-status",
      "financial status",
      responsesByKind.get("command-status"),
      witnesses.commandStatus,
    ],
  ] as const;
  for (const [evidenceKind, surface, evidence, candidates] of requiredBuckets) {
    requireCapturedFinancialWitness(
      surface,
      evidenceKind,
      evidence,
      candidates,
    );
  }

  const entries: readonly (readonly [
    string,
    CommercePrivacySurface,
    unknown,
  ])[] = [
    ...artifacts.browser.flatMap((entry, index) => [
      [`browser-${index}-html`, "financial html", entry.html] as const,
      [`browser-${index}-text`, "financial browser", entry.text] as const,
    ]),
    ...artifacts.responses.map(
      (entry, index) =>
        [
          `responses-${entry.kind}-${index}`,
          responseSurface(entry.kind),
          entry,
        ] as const,
    ),
    ["console", "financial log", normalizedConsole],
    ["externalRequests", "financial browser", artifacts.externalRequests],
  ];
  for (const [evidenceKind, surface, entry] of entries) {
    try {
      assertCommercePrivacy(surface, entry, []);
    } catch (cause: unknown) {
      throw new Error(
        `Generic sensitive pattern detected in financial browser ${evidenceKind}`,
        { cause },
      );
    }
    try {
      assertCommercePrivacy(surface, entry, privateValues);
    } catch (cause: unknown) {
      const normalized = JSON.stringify(entry).toLowerCase();
      const matchingIndexes = privateValues.flatMap((value, index) =>
        value.length > 0 && normalized.includes(value.toLowerCase())
          ? [index]
          : [],
      );
      throw new Error(
        `Fixture-private value detected in financial browser ${evidenceKind} (indexes ${matchingIndexes.join(", ")})`,
        { cause },
      );
    }
  }
}

type AllocationPlan = FinancialRefundFixture["finalizationAllocations"];
type AfterSubmit = (input: { readonly commandId: string }) => Promise<void>;

function commandStatus(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: "Status:" });
}

async function fillAllocationInputs(
  page: Page,
  allocations: AllocationPlan,
  label: "Refund amount in minor units" | "Proposed attribution in minor units",
): Promise<void> {
  await waitForHydratedHandler(
    page.getByRole("button", { name: "Use Nocturne theme" }),
  );
  for (const allocation of allocations) {
    const item = page.getByRole("group", {
      name: allocation.soldAsTitle,
      exact: true,
    });
    await expect(item).toBeVisible();
    const amount = item.getByLabel(label, { exact: true });
    await amount.fill(String(allocation.amountMinor));
  }
}

async function reloadCurrentRefundFacts(page: Page): Promise<void> {
  const reload = page.getByRole("link", {
    name: "Reload current refund facts",
    exact: true,
  });
  await expect(reload).toBeVisible();
  await reload.click();
  await expect(
    page.getByRole("heading", { name: "Refund allocation review" }),
  ).toBeVisible();
}

async function expectOneBrowserSubmission(
  run: FinancialCommandRun,
): Promise<void> {
  expect(run.commandId).toMatch(canonicalUuid);
  expect(run.submissionCount).toBe(1);
  expect(run.observedStatuses[0]).toBe("pending");
  expect(run.observedStatuses.at(-1)).toBe(run.terminal.status);
  expect(run.protectedStatusReadCount).toBeGreaterThanOrEqual(1);
}

type Cleanup = () => Promise<void>;

async function closeAcquired(
  cleanups: readonly Cleanup[],
  primaryError: unknown,
): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length === 0) return;
  if (primaryError !== undefined) {
    throw new AggregateError(
      [primaryError, ...failures],
      "Financial journey and cleanup failed",
      { cause: primaryError },
    );
  }
  throw new AggregateError(failures, "Financial journey cleanup failed");
}

async function expectTerminalPresentation(
  page: Page,
  label: "Denied" | "Conflict — reload current facts" | "Failed",
  guidance: string,
): Promise<void> {
  const liveRegion = commandStatus(page);
  await expect(liveRegion).toContainText(`Status: ${label}`);
  await expect(liveRegion).toContainText(guidance);
  await expect(
    page.getByRole("button", { name: "Retry this exact request" }),
  ).toHaveCount(0);
}

async function saveDraft(
  financial: FinancialHarness,
  page: Page,
  fixture: FinancialRefundFixture,
  afterSubmit?: AfterSubmit,
): Promise<FinancialCommandRun> {
  await fillAllocationInputs(
    page,
    fixture.finalizationAllocations,
    "Refund amount in minor units",
  );
  return financial.runCommand({
    page,
    submit: () =>
      page.getByRole("button", { name: "Save shared draft" }).click(),
    afterSubmit,
  });
}

async function prepareAndFinalize(
  financial: FinancialHarness,
  page: Page,
  fixture: FinancialRefundFixture,
): Promise<FinancialCommandRun> {
  await page
    .getByRole("button", { name: "Review finalization consequences" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review finalization consequences" }),
  ).toBeVisible();
  await expect(
    page.getByText("Finalizing makes this allocation immutable."),
  ).toBeVisible();
  await expect(
    page.getByText("Finalization may revoke purchase access."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "A later reporting correction does not automatically restore access.",
    ),
  ).toBeVisible();

  const run = await financial.runCommand({
    page,
    submit: () =>
      page
        .getByRole("button", {
          name: "Finalize this refund allocation",
        })
        .click(),
    afterSubmit: async () => {
      await expect(commandStatus(page)).toContainText("Status: Pending");
    },
  });
  await expectOneBrowserSubmission(run);
  expect(run.terminal).toMatchObject({
    kind: "refund_allocation_finalize",
    status: "succeeded",
    resultCode: "allocation_finalized",
    result: { refundId: fixture.refundId },
  });
  await expect(commandStatus(page)).toContainText("Status: Succeeded");
  return run;
}

async function prepareAndCorrectReporting(
  financial: FinancialHarness,
  page: Page,
  fixture: FinancialRefundFixture,
  allocations: AllocationPlan = fixture.correctionAllocations,
): Promise<FinancialCommandRun> {
  await fillAllocationInputs(
    page,
    allocations,
    "Proposed attribution in minor units",
  );
  await page
    .getByRole("button", { name: "Review reporting correction" })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Append this reporting correction",
    }),
  ).toBeVisible();
  await expect(
    page
      .getByText("Reporting only — this does not restore or revoke access.")
      .first(),
  ).toBeVisible();

  const run = await financial.runCommand({
    page,
    submit: () =>
      page
        .getByRole("button", {
          name: "Append this reporting correction",
        })
        .click(),
  });
  await expectOneBrowserSubmission(run);
  expect(run.terminal).toMatchObject({
    kind: "refund_reporting_correction_create",
    status: "succeeded",
    resultCode: "correction_created",
    result: { refundId: fixture.refundId },
  });
  await expect(commandStatus(page)).toContainText("Status: Succeeded");
  return run;
}

test("two administrators resolve an ambiguous refund without changing historical commerce facts", async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const cleanups: Cleanup[] = [];
  let primaryError: unknown;
  try {
    const database = await openE2EDatabase();
    cleanups.push(() => database.close());
    const financial = createFinancialHarness(database, baseURL);
    cleanups.push(() => financial.close());
    const [first, second] = await financial.promoteAdministrators(browser, [
      "refund-primary",
      "refund-secondary",
    ]);
    const fixture = await financial.createRefundFixture({
      purchaseOwner: "claimed-account",
      scenario: "draft-finalization-correction",
      otherActiveGrantFor: "preserved",
    });
    const artifacts = await financial.captureFinancialArtifacts([
      first.page,
      second.page,
    ]);

    await first.page.goto(fixture.reviewPath);
    await second.page.goto(fixture.reviewPath);
    await expect(
      first.page.getByRole("heading", {
        name: "Refund allocation review",
      }),
    ).toBeVisible();
    await expect(
      first.page.getByRole("heading", { name: "Shared allocation draft" }),
    ).toBeVisible();
    await expect(
      first.page.getByText("No shared draft exists yet."),
    ).toBeVisible();

    const purchaseItems = first.page.getByRole("region", {
      name: "Refund purchase items",
    });
    for (const item of Object.values(fixture.items)) {
      await expect(
        purchaseItems.getByRole("row").filter({ hasText: item.soldAsTitle }),
      ).toBeVisible();
    }
    await expect
      .poll(() =>
        financial.readAccess(fixture, fixture.items.attribution.titleId),
      )
      .toBe(true);
    await expect
      .poll(() =>
        financial.readAccess(fixture, fixture.items.preserved.titleId),
      )
      .toBe(true);
    await expect
      .poll(() =>
        financial.readAccess(fixture, fixture.items.recoverable.titleId),
      )
      .toBe(true);

    const created = await saveDraft(
      financial,
      first.page,
      fixture,
      async () => {
        await expect(commandStatus(first.page)).toContainText(
          "Status: Pending",
        );
      },
    );
    await expectOneBrowserSubmission(created);
    expect(created.terminal).toMatchObject({
      kind: "refund_draft_save",
      status: "succeeded",
      resultCode: "draft_saved",
      result: { refundId: fixture.refundId, draftVersion: 1, changed: true },
    });
    await expect(commandStatus(first.page)).toContainText(
      "Shared refund draft saved at version 1.",
    );
    await reloadCurrentRefundFacts(first.page);
    await expect(
      first.page.getByText(/Version 1\s+·\s+Edited by you/u),
    ).toBeVisible();

    // The second page was loaded before version 1 existed, so its native form submits null.
    const conflicted = await saveDraft(financial, second.page, fixture);
    await expectOneBrowserSubmission(conflicted);
    expect(conflicted.terminal).toMatchObject({
      kind: "refund_draft_save",
      status: "conflict",
      resultCode: "stale_state",
      result: null,
    });
    await expectTerminalPresentation(
      second.page,
      "Conflict — reload current facts",
      "The financial facts changed before this command ran. Reload current facts and review them before taking another action.",
    );
    await reloadCurrentRefundFacts(second.page);
    await expect(
      second.page.getByText(/Version 1\s+·\s+Edited by another administrator/u),
    ).toBeVisible();

    const discarded = await financial.runCommand({
      page: first.page,
      submit: () =>
        first.page
          .getByRole("button", { name: "Discard shared draft" })
          .click(),
    });
    await expectOneBrowserSubmission(discarded);
    expect(discarded.terminal).toMatchObject({
      kind: "refund_draft_discard",
      status: "succeeded",
      resultCode: "draft_discarded",
      result: { refundId: fixture.refundId, changed: true },
    });
    await expect(commandStatus(first.page)).toContainText(
      "Shared refund draft version",
    );
    await reloadCurrentRefundFacts(first.page);
    await expect(
      first.page.getByText("No shared draft exists yet."),
    ).toBeVisible();

    const finalDraft = await saveDraft(financial, first.page, fixture);
    await expectOneBrowserSubmission(finalDraft);
    expect(finalDraft.terminal).toMatchObject({
      kind: "refund_draft_save",
      status: "succeeded",
      resultCode: "draft_saved",
      result: { refundId: fixture.refundId, changed: true },
    });
    await reloadCurrentRefundFacts(first.page);

    await first.page
      .getByRole("button", { name: "Review finalization consequences" })
      .click();
    const finalizationItems = first.page.getByRole("region", {
      name: "Finalization item consequences",
    });
    const preservedRow = finalizationItems.getByRole("row").filter({
      hasText: fixture.items.preserved.soldAsTitle,
    });
    await expect(preservedRow).toContainText(
      "Purchase access grant will be revoked.",
    );
    await expect(preservedRow).toContainText(
      "Another active grant preserves access.",
    );
    await expect(preservedRow).toContainText(
      "Effective access will remain unchanged.",
    );
    await expect(preservedRow).toContainText(
      "No access-change email will be queued.",
    );
    const recoverableRow = finalizationItems.getByRole("row").filter({
      hasText: fixture.items.recoverable.soldAsTitle,
    });
    await expect(recoverableRow).toContainText(
      "Purchase access grant will be revoked.",
    );
    await expect(recoverableRow).toContainText("Effective access will change.");
    await expect(recoverableRow).toContainText(
      "An access-change email will be queued.",
    );

    const finalized = await financial.runCommand({
      page: first.page,
      submit: () =>
        first.page
          .getByRole("button", {
            name: "Finalize this refund allocation",
          })
          .click(),
      afterSubmit: async () => {
        await expect(commandStatus(first.page)).toContainText(
          "Status: Pending",
        );
      },
    });
    await expectOneBrowserSubmission(finalized);
    expect(finalized.terminal).toMatchObject({
      kind: "refund_allocation_finalize",
      status: "succeeded",
      resultCode: "allocation_finalized",
      result: {
        refundId: fixture.refundId,
        accessChanged: true,
        emailQueued: true,
      },
    });
    await expect(commandStatus(first.page)).toContainText(
      "Access changed. Customer email queued.",
    );
    await expect
      .poll(() =>
        financial.readAccess(fixture, fixture.items.preserved.titleId),
      )
      .toBe(true);
    await expect
      .poll(() =>
        financial.readAccess(fixture, fixture.items.recoverable.titleId),
      )
      .toBe(false);

    const refundEmails = await financial.readEmailEvidence(fixture);
    assertFinancialEmailPrivacy(refundEmails, fixture.browserPrivateValues);
    expect(financialEmailSafeProjection(refundEmails)).toEqual([
      {
        template: "commerce.refund-access-changed",
        soldAsTitle: null,
        accessState: null,
        affectedTitleCount: 1,
      },
    ]);

    await reloadCurrentRefundFacts(first.page);
    const beforeCorrection = await financial.readRefundState(fixture);
    const corrected = await prepareAndCorrectReporting(
      financial,
      first.page,
      fixture,
    );
    await reloadCurrentRefundFacts(first.page);
    const afterCorrection = await financial.readRefundState(fixture);
    if (corrected.terminal.resultCode !== "correction_created") {
      throw new Error("Expected the reporting correction command to succeed");
    }

    expect(afterCorrection.providerRefundTotalMinor).toBe(
      beforeCorrection.providerRefundTotalMinor,
    );
    expect(afterCorrection.historicalRefundedMinorByTitleId).toEqual(
      beforeCorrection.historicalRefundedMinorByTitleId,
    );
    expect(afterCorrection.effectiveAccessByTitleId).toEqual(
      beforeCorrection.effectiveAccessByTitleId,
    );
    expect(afterCorrection.correctionSetIds).toEqual([
      ...beforeCorrection.correctionSetIds,
      corrected.terminal.result.correctionSetId,
    ]);
    expect(afterCorrection.financialMetricsByTitleId).toEqual(
      fixture.expectedCorrectedFinancialMetricsByTitleId,
    );
    expect(afterCorrection.financialMetricsByTitleId).not.toEqual(
      beforeCorrection.financialMetricsByTitleId,
    );

    const audit = await financial.readAuditEvidence({
      refundId: fixture.refundId,
      privateValues: fixture.privateValues,
      fixtureActions: [
        "financial.classification.appended",
        "financial.classification.appended",
        "financial.balance_transaction.imported",
        "financial.issue.opened",
      ],
      commands: [
        {
          commandId: created.commandId,
          actions: ["financial.refund_draft.created"],
        },
        {
          commandId: conflicted.commandId,
          actions: ["financial.admin_command.conflict"],
        },
        {
          commandId: discarded.commandId,
          actions: ["financial.refund_draft.discarded"],
        },
        {
          commandId: finalDraft.commandId,
          actions: ["financial.refund_draft.created"],
        },
        {
          commandId: finalized.commandId,
          actions: [
            "financial.issue.resolved",
            "financial.refund_reconciled",
            "financial.refund_allocation.finalized",
          ],
        },
        {
          commandId: corrected.commandId,
          actions: ["financial.refund_correction.created"],
        },
      ],
    });
    expect(audit.detailReads).toEqual([
      {
        action: "financial.refund_review.view",
        actorLabel: first.label,
      },
      {
        action: "financial.refund_review.view",
        actorLabel: second.label,
      },
    ]);
    expect(audit.domainActions).toEqual([
      {
        commandId: created.commandId,
        action: "financial.refund_draft.created",
        actorLabel: first.label,
      },
      {
        commandId: discarded.commandId,
        action: "financial.refund_draft.discarded",
        actorLabel: first.label,
      },
      {
        commandId: finalDraft.commandId,
        action: "financial.refund_draft.created",
        actorLabel: first.label,
      },
      {
        commandId: finalized.commandId,
        action: "financial.refund_allocation.finalized",
        actorLabel: first.label,
      },
      {
        commandId: corrected.commandId,
        action: "financial.refund_correction.created",
        actorLabel: first.label,
      },
    ]);
    expect(audit.issueActions).toEqual([
      {
        commandId: null,
        action: "financial.issue.opened",
        actorLabel: "financial-worker",
      },
      {
        commandId: finalized.commandId,
        action: "financial.issue.resolved",
        actorLabel: first.label,
      },
    ]);
    expect(audit.reconciliationActions).toEqual([
      {
        commandId: finalized.commandId,
        action: "financial.refund_reconciled",
        actorLabel: "financial-worker",
      },
    ]);
    expect(audit.terminalCommands).toEqual([
      {
        commandId: conflicted.commandId,
        action: "financial.admin_command.conflict",
        outcome: "failed",
        actorLabel: second.label,
      },
    ]);

    const commandRuns = [
      created,
      conflicted,
      discarded,
      finalDraft,
      finalized,
      corrected,
    ];
    const browserPrivateValues = [
      ...fixture.browserPrivateValues,
      ...commandRuns.flatMap((run) => run.browserPrivateValues),
    ];
    assertFinancialBrowserArtifacts(
      await artifacts.finish(),
      browserPrivateValues,
      financialArtifactWitnesses(fixture, commandRuns),
    );
  } catch (error: unknown) {
    primaryError = error;
    throw error;
  } finally {
    await closeAcquired(cleanups, primaryError);
  }
});

test("persistent recovery requires a real claim and survives later financial processing until deactivation", async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const cleanups: Cleanup[] = [];
  let primaryError: unknown;
  try {
    const database = await openE2EDatabase();
    cleanups.push(() => database.close());
    const claimContext = await browser.newContext({
      baseURL,
      serviceWorkers: "block",
    });
    cleanups.push(() => claimContext.close());
    const financial = createFinancialHarness(database, baseURL);
    cleanups.push(() => financial.close());
    const [administrator] = await financial.promoteAdministrators(browser, [
      "recovery-primary",
    ]);
    const fixture = await financial.createRefundFixture({
      purchaseOwner: "unclaimed-guest",
      scenario: "recovery-persistence",
      otherActiveGrantFor: null,
    });
    const claimPage = await claimContext.newPage();
    const artifacts = await financial.captureFinancialArtifacts([
      administrator.page,
      claimPage,
    ]);

    await administrator.page.goto(fixture.reviewPath);
    const draft = await saveDraft(financial, administrator.page, fixture);
    await expectOneBrowserSubmission(draft);
    await reloadCurrentRefundFacts(administrator.page);
    const finalized = await prepareAndFinalize(
      financial,
      administrator.page,
      fixture,
    );
    expect(finalized.terminal).toMatchObject({
      result: { accessChanged: false, emailQueued: false },
    });
    await reloadCurrentRefundFacts(administrator.page);

    await expect(
      administrator.page.getByRole("heading", {
        name: "Administrative access recovery",
      }),
    ).toBeVisible();
    await expect(
      administrator.page.getByRole("status").filter({
        hasText:
          "No causally eligible activation is available for this refund.",
      }),
    ).toBeVisible();
    await expect(
      administrator.page.getByRole("button", {
        name: /Review persistent access activation/u,
      }),
    ).toHaveCount(0);

    const eligibilityCorrected = await prepareAndCorrectReporting(
      financial,
      administrator.page,
      fixture,
      fixture.recoveryEligibilityAllocations,
    );
    await reloadCurrentRefundFacts(administrator.page);
    const unclaimedReview = administrator.page.getByRole("button", {
      name: `Review persistent access activation for ${fixture.items.recoverable.soldAsTitle}`,
    });
    await expect(unclaimedReview).toBeVisible();
    await unclaimedReview.click();
    await expect(
      administrator.page.getByText(
        "The purchase has not been claimed, so administrative recovery cannot be activated.",
      ),
    ).toBeVisible();
    await expect(
      administrator.page.getByRole("button", {
        name: "Activate persistent access recovery",
      }),
    ).toHaveCount(0);

    await financial.completeGuestClaim({ fixture, page: claimPage });
    await expect.poll(() => financial.readClaimState(fixture)).toBe("claimed");
    await expect
      .poll(() =>
        financial.readAccess(fixture, fixture.items.recoverable.titleId),
      )
      .toBe(false);

    await administrator.page.goto(fixture.reviewPath);
    const reviewActivation = administrator.page.getByRole("button", {
      name: `Review persistent access activation for ${fixture.items.recoverable.soldAsTitle}`,
    });
    await expect(reviewActivation).toBeVisible();
    await reviewActivation.click();
    await expect(
      administrator.page.getByRole("heading", {
        name: "Review persistent access activation",
      }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      administrator.page.getByText(
        "This administrative access override persists through future refund, reporting correction, dispute, and classifier rebase processing until it is separately deactivated.",
      ),
    ).toBeVisible();
    await expect(
      administrator.page.getByText(
        "Effective access is currently unavailable and will become available.",
      ),
    ).toBeVisible();
    await expect(
      administrator.page.getByText("An access-change email will be queued."),
    ).toBeVisible();

    const beforeActivation = await financial.readRefundState(fixture);
    const activated = await financial.runCommand({
      page: administrator.page,
      submit: () =>
        administrator.page
          .getByRole("button", {
            name: "Activate persistent access recovery",
          })
          .click(),
    });
    await expectOneBrowserSubmission(activated);
    expect(activated.terminal).toMatchObject({
      kind: "administrative_recovery_activate",
      status: "succeeded",
      resultCode: "recovery_activated",
      result: { accessChanged: true, emailQueued: true },
    });
    await expect
      .poll(() =>
        financial.readAccess(fixture, fixture.items.recoverable.titleId),
      )
      .toBe(true);
    const afterActivation = await financial.readRefundState(fixture);
    expect(afterActivation.financialMetricsByTitleId).toEqual(
      beforeActivation.financialMetricsByTitleId,
    );
    expect(afterActivation.recoveryState).toBe("active");

    await reloadCurrentRefundFacts(administrator.page);
    const corrected = await prepareAndCorrectReporting(
      financial,
      administrator.page,
      fixture,
    );
    await reloadCurrentRefundFacts(administrator.page);
    await financial.publishLaterRefundAndDispute({ fixture });
    await expect
      .poll(() => financial.readRefundState(fixture))
      .toMatchObject({
        recoveryState: "active",
      });
    await expect
      .poll(() =>
        financial.readAccess(fixture, fixture.items.recoverable.titleId),
      )
      .toBe(true);

    await administrator.page.goto(fixture.reviewPath);
    await expect(
      administrator.page.getByText(
        "This administrative override persists until a separate deactivation, including through later refund, reporting correction, dispute, and classifier rebase processing.",
      ),
    ).toBeVisible();
    const reviewDeactivation = administrator.page.getByRole("button", {
      name: `Review persistent access deactivation for ${fixture.items.recoverable.soldAsTitle}`,
    });
    await expect(reviewDeactivation).toBeVisible();
    await reviewDeactivation.click();
    await expect(
      administrator.page.getByRole("heading", {
        name: "Review persistent access deactivation",
      }),
    ).toBeVisible();
    await expect(
      administrator.page.getByText(
        "Deactivation ends this persistent administrative override. It does not change refund or reporting amounts.",
      ),
    ).toBeVisible();

    const beforeDeactivation = await financial.readRefundState(fixture);
    const deactivated = await financial.runCommand({
      page: administrator.page,
      submit: () =>
        administrator.page
          .getByRole("button", {
            name: "Deactivate persistent access recovery",
          })
          .click(),
    });
    await expectOneBrowserSubmission(deactivated);
    expect(deactivated.terminal).toMatchObject({
      kind: "administrative_recovery_deactivate",
      status: "succeeded",
      resultCode: "recovery_deactivated",
    });
    const afterDeactivation = await financial.readRefundState(fixture);
    expect(afterDeactivation.recoveryState).toBe("revoked");
    await expect
      .poll(() =>
        financial.readAccess(fixture, fixture.items.recoverable.titleId),
      )
      .toBe(false);
    expect(afterDeactivation.financialMetricsByTitleId).toEqual(
      beforeDeactivation.financialMetricsByTitleId,
    );

    const recoveryEmails = await financial.readEmailEvidence(fixture);
    assertFinancialEmailPrivacy(recoveryEmails, fixture.browserPrivateValues);
    expect(financialEmailSafeProjection(recoveryEmails)).toEqual([
      {
        template: "commerce.refund-access-changed",
        soldAsTitle: null,
        accessState: null,
        affectedTitleCount: 1,
      },
      {
        template: "commerce.administrative-recovery-access-changed",
        soldAsTitle: fixture.items.recoverable.soldAsTitle,
        accessState: "active",
        affectedTitleCount: null,
      },
      {
        template: "commerce.administrative-recovery-access-changed",
        soldAsTitle: fixture.items.recoverable.soldAsTitle,
        accessState: "revoked",
        affectedTitleCount: null,
      },
    ]);

    const audit = await financial.readAuditEvidence({
      refundId: fixture.refundId,
      privateValues: fixture.privateValues,
      fixtureActions: [
        "financial.classification.appended",
        "financial.classification.appended",
        "financial.balance_transaction.imported",
        "financial.issue.opened",
      ],
      commands: [
        {
          commandId: draft.commandId,
          actions: ["financial.refund_draft.created"],
        },
        {
          commandId: finalized.commandId,
          actions: [
            "financial.issue.resolved",
            "financial.refund_reconciled",
            "financial.refund_allocation.finalized",
          ],
        },
        {
          commandId: eligibilityCorrected.commandId,
          actions: ["financial.refund_correction.created"],
        },
        {
          commandId: activated.commandId,
          actions: ["financial.recovery_grant.activated"],
        },
        {
          commandId: corrected.commandId,
          actions: ["financial.refund_correction.created"],
        },
        {
          commandId: deactivated.commandId,
          actions: ["financial.recovery_grant.deactivated"],
        },
      ],
    });
    expect(audit.detailReads).toEqual([
      {
        action: "financial.refund_review.view",
        actorLabel: administrator.label,
      },
    ]);
    expect(audit.domainActions).toEqual([
      {
        commandId: draft.commandId,
        action: "financial.refund_draft.created",
        actorLabel: administrator.label,
      },
      {
        commandId: finalized.commandId,
        action: "financial.refund_allocation.finalized",
        actorLabel: administrator.label,
      },
      {
        commandId: eligibilityCorrected.commandId,
        action: "financial.refund_correction.created",
        actorLabel: administrator.label,
      },
      {
        commandId: activated.commandId,
        action: "financial.recovery_grant.activated",
        actorLabel: administrator.label,
      },
      {
        commandId: corrected.commandId,
        action: "financial.refund_correction.created",
        actorLabel: administrator.label,
      },
      {
        commandId: deactivated.commandId,
        action: "financial.recovery_grant.deactivated",
        actorLabel: administrator.label,
      },
    ]);
    expect(audit.issueActions).toEqual([
      {
        commandId: null,
        action: "financial.issue.opened",
        actorLabel: "financial-worker",
      },
      {
        commandId: finalized.commandId,
        action: "financial.issue.resolved",
        actorLabel: administrator.label,
      },
    ]);
    expect(audit.reconciliationActions).toEqual([
      {
        commandId: finalized.commandId,
        action: "financial.refund_reconciled",
        actorLabel: "financial-worker",
      },
    ]);
    expect(audit.terminalCommands).toEqual([]);

    const commandRuns = [
      draft,
      finalized,
      eligibilityCorrected,
      activated,
      corrected,
      deactivated,
    ];
    assertFinancialBrowserArtifacts(
      await artifacts.finish(),
      [
        ...fixture.browserPrivateValues,
        ...commandRuns.flatMap((run) => run.browserPrivateValues),
      ],
      financialArtifactWitnesses(fixture, commandRuns),
    );
  } catch (error: unknown) {
    primaryError = error;
    throw error;
  } finally {
    await closeAcquired(cleanups, primaryError);
  }
});

test("execution-time demotion, real worker failure, and navigation abort stay distinct and safe", async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const cleanups: Cleanup[] = [];
  let primaryError: unknown;
  try {
    const database = await openE2EDatabase();
    cleanups.push(() => database.close());
    const financial = createFinancialHarness(database, baseURL);
    cleanups.push(() => financial.close());
    const [target, authority] = await financial.promoteAdministrators(browser, [
      "terminal-target",
      "terminal-authority",
    ]);
    const deniedFixture = await financial.createRefundFixture({
      purchaseOwner: "claimed-account",
      scenario: "terminal-policy",
      otherActiveGrantFor: null,
    });
    const failedFixture = await financial.createRefundFixture({
      purchaseOwner: "claimed-account",
      scenario: "terminal-policy",
      otherActiveGrantFor: null,
    });
    const navigationFixture = await financial.createRefundFixture({
      purchaseOwner: "claimed-account",
      scenario: "terminal-policy",
      otherActiveGrantFor: null,
    });
    const artifacts = await financial.captureFinancialArtifacts([target.page]);

    await target.page.goto(deniedFixture.reviewPath);
    await fillAllocationInputs(
      target.page,
      deniedFixture.finalizationAllocations,
      "Refund amount in minor units",
    );
    const denied = await financial.runCommand({
      page: target.page,
      submit: () =>
        target.page.getByRole("button", { name: "Save shared draft" }).click(),
      demoteSubmitterBeforeClaim: {
        by: authority,
        expectedCommandKind: "refund_draft_save",
      },
    });
    await expectOneBrowserSubmission(denied);
    expect(denied.terminal).toMatchObject({
      kind: "refund_draft_save",
      status: "denied",
      resultCode: "capability_revoked",
      result: null,
    });
    await expectTerminalPresentation(
      target.page,
      "Denied",
      "Your financial administrator permission changed before this command ran. Reload current facts and contact an authorized administrator if the action is still needed.",
    );
    await reloadCurrentRefundFacts(target.page);
    await target.page.goto(failedFixture.reviewPath);
    await fillAllocationInputs(
      target.page,
      failedFixture.finalizationAllocations,
      "Refund amount in minor units",
    );
    const failed = await financial.runCommand({
      page: target.page,
      submit: () =>
        target.page.getByRole("button", { name: "Save shared draft" }).click(),
      failCommand: true,
    });
    await expectOneBrowserSubmission(failed);
    expect(failed.terminal).toMatchObject({
      kind: "refund_draft_save",
      status: "failed",
      resultCode: "command_failed",
      result: null,
    });
    await expectTerminalPresentation(
      target.page,
      "Failed",
      "The command could not be completed. Reload current facts; if the problem continues, report the command reference to support.",
    );
    await expect(commandStatus(target.page)).not.toContainText(
      /command_failed|SQLSTATE|stack|lease|capability|pale_orbit|filesystem/iu,
    );

    await target.page.goto(navigationFixture.reviewPath);
    await fillAllocationInputs(
      target.page,
      navigationFixture.finalizationAllocations,
      "Refund amount in minor units",
    );
    const navigation = await financial.runCommand({
      page: target.page,
      submit: () =>
        target.page.getByRole("button", { name: "Save shared draft" }).click(),
      afterSubmit: async ({ commandId }) => {
        expect(commandId).toMatch(canonicalUuid);
        await expect(commandStatus(target.page)).toContainText(
          "Status: Pending",
        );
        await target.page.goto("/admin/sales/review");
        await expect(
          target.page.getByRole("heading", { name: "Needs review" }),
        ).toBeVisible();
      },
    });
    await expectOneBrowserSubmission(navigation);
    expect(navigation.terminal).toMatchObject({
      kind: "refund_draft_save",
      status: "succeeded",
      resultCode: "draft_saved",
    });
    await expect
      .poll(() => financial.navigationAbortEvidence(navigation.commandId))
      .toEqual({
        observationComplete: true,
        initialPageStatusRequestCount: 1,
        pageStatusRequestsAfterNavigation: 0,
        pendingRequestAborted: true,
      });

    const deniedAudit = await financial.readAuditEvidence({
      refundId: deniedFixture.refundId,
      privateValues: deniedFixture.privateValues,
      fixtureActions: [
        "financial.classification.appended",
        "financial.classification.appended",
        "financial.balance_transaction.imported",
        "financial.issue.opened",
      ],
      commands: [
        {
          commandId: denied.commandId,
          actions: ["financial.admin_command.denied"],
        },
      ],
    });
    const failedAudit = await financial.readAuditEvidence({
      refundId: failedFixture.refundId,
      privateValues: failedFixture.privateValues,
      fixtureActions: [
        "financial.classification.appended",
        "financial.classification.appended",
        "financial.balance_transaction.imported",
        "financial.issue.opened",
      ],
      commands: [
        {
          commandId: failed.commandId,
          actions: ["financial.admin_command.failed"],
        },
      ],
    });
    const navigationAudit = await financial.readAuditEvidence({
      refundId: navigationFixture.refundId,
      privateValues: navigationFixture.privateValues,
      fixtureActions: [
        "financial.classification.appended",
        "financial.classification.appended",
        "financial.balance_transaction.imported",
        "financial.issue.opened",
      ],
      commands: [
        {
          commandId: navigation.commandId,
          actions: ["financial.refund_draft.created"],
        },
      ],
    });
    expect(deniedAudit.detailReads).toEqual([
      {
        action: "financial.refund_review.view",
        actorLabel: target.label,
      },
    ]);
    expect(deniedAudit.domainActions).toEqual([]);
    expect(deniedAudit.issueActions).toEqual([
      {
        commandId: null,
        action: "financial.issue.opened",
        actorLabel: "financial-worker",
      },
    ]);
    expect(deniedAudit.reconciliationActions).toEqual([]);
    expect(deniedAudit.terminalCommands).toEqual([
      {
        commandId: denied.commandId,
        action: "financial.admin_command.denied",
        outcome: "denied",
        actorLabel: target.label,
      },
    ]);
    expect(failedAudit.detailReads).toEqual([
      {
        action: "financial.refund_review.view",
        actorLabel: target.label,
      },
    ]);
    expect(failedAudit.domainActions).toEqual([]);
    expect(failedAudit.issueActions).toEqual([
      {
        commandId: null,
        action: "financial.issue.opened",
        actorLabel: "financial-worker",
      },
    ]);
    expect(failedAudit.reconciliationActions).toEqual([]);
    expect(failedAudit.terminalCommands).toEqual([
      {
        commandId: failed.commandId,
        action: "financial.admin_command.failed",
        outcome: "failed",
        actorLabel: target.label,
      },
    ]);
    expect(navigationAudit.detailReads).toEqual([
      {
        action: "financial.refund_review.view",
        actorLabel: target.label,
      },
    ]);
    expect(navigationAudit.domainActions).toEqual([
      {
        commandId: navigation.commandId,
        action: "financial.refund_draft.created",
        actorLabel: target.label,
      },
    ]);
    expect(navigationAudit.issueActions).toEqual([
      {
        commandId: null,
        action: "financial.issue.opened",
        actorLabel: "financial-worker",
      },
    ]);
    expect(navigationAudit.reconciliationActions).toEqual([]);
    expect(navigationAudit.terminalCommands).toEqual([]);

    const browserPrivateValues = [
      ...deniedFixture.browserPrivateValues,
      ...failedFixture.browserPrivateValues,
      ...navigationFixture.browserPrivateValues,
      ...[denied, failed, navigation].flatMap(
        (run) => run.browserPrivateValues,
      ),
    ];
    const artifactEvidence = await artifacts.finish();
    expect(
      artifactEvidence.responses.some(
        (response) =>
          response.kind === "command-status" &&
          response.body.includes(navigation.commandId),
      ),
    ).toBe(true);
    const commandRuns = [denied, failed, navigation];
    assertFinancialBrowserArtifacts(
      artifactEvidence,
      browserPrivateValues,
      financialArtifactWitnesses(deniedFixture, commandRuns, ["Needs review"]),
    );
    assertCommercePrivacy(
      "financial status",
      [denied.terminal, failed.terminal],
      [
        ...deniedFixture.privateValues,
        ...failedFixture.privateValues,
        ...navigationFixture.privateValues,
      ],
    );
  } catch (error: unknown) {
    primaryError = error;
    throw error;
  } finally {
    await closeAcquired(cleanups, primaryError);
  }
});
