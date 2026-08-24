import { randomUUID } from "node:crypto";
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  CDPSession,
  ConsoleMessage,
  Download,
  JSHandle,
  Page,
  Request,
  Response,
  Route,
} from "@playwright/test";
import { eq, inArray, sql } from "drizzle-orm";
import {
  auditEvents,
  disputes,
  entitlementGrants,
  entitlements,
  financialClassificationVersions,
  financialReconciliationIssues,
  guestIdentities,
  orderItems,
  orders,
  payments,
  refundAllocationComponents,
  refundAllocationDrafts,
  refundReportingCorrectionSets,
  refunds,
  stripeBalanceTransactionFeeDetails,
  stripeBalanceTransactions,
  titles,
  user,
} from "$lib/server/db/schema";
import { reconcileDisputeFinancialSource } from "$lib/server/commerce/financial/sources/dispute";
import { reconcileRefundFinancialSource } from "$lib/server/commerce/financial/sources/refund";
import { FINANCIAL_CLASSIFIER_VERSION } from "$lib/server/commerce/financial/constants";
import { projectEffectiveEntitlement } from "$lib/server/commerce/grants";
import { createFixtureStripeGateway } from "$lib/server/commerce/stripe/fixture-gateway";
import { createTestWorkerControlHarness } from "$lib/server/jobs/test-worker-control";
import {
  parseFinancialAdminCommandStatus,
  type FinancialAdminCommandStatusDto,
} from "$lib/types/financial-reporting";
import { balanceTransactionSnapshotFixture } from "../fixtures/stripe/balance-transaction";
import { chargeSnapshotFixture } from "../fixtures/stripe/charge";
import { disputeSnapshotFixture } from "../fixtures/stripe/dispute";
import { paymentSnapshotFixture } from "../fixtures/stripe/payment";
import { refundSnapshotFixture } from "../fixtures/stripe/refund";
import { registerAndVerifyCustomer } from "./customer-session";
import { createCommerceHarness } from "./commerce-harness";
import { assertCommercePrivacy } from "./commerce-privacy";
import type { E2EDatabase } from "./database";
import {
  firstHttpLink,
  navigateSensitiveAction,
  waitForLatestTextEmail,
} from "./mailpit";
import {
  administrator,
  signIn,
  waitForHydratedHandler,
} from "./publication-admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMAND_DEADLINE_MS = 45_000;
const FIXTURE_DAY = "2026-08-01";
const MAX_CAPTURED_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_AUDIT_EVIDENCE_ROWS = 512;
const MAX_AUDIT_JSON_BYTES = 64 * 1024;
const MAX_AUDIT_PROJECTION_DEPTH = 16;
const MAX_AUDIT_PROJECTION_NODES = 65_536;
const MAX_AUDIT_COLLECTION_ENTRIES = 4_096;
const MAX_AUDIT_TEXT_CHARACTERS = 16_384;
const MAX_AUDIT_PROJECTION_BYTES = 2 * 1024 * 1024;
const MAX_FINANCIAL_REDIRECT_HEADER_COUNT = 256;
const MAX_FINANCIAL_REDIRECT_HEADER_VALUE_CHARACTERS = 16_384;
const MAX_FINANCIAL_REDIRECT_HEADER_BYTES = 64 * 1024;
const MAX_FINANCIAL_REDIRECT_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_FINANCIAL_DURABLE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FINANCIAL_DURABLE_RESOURCE_BYTES = 2 * 1024 * 1024;
const FINANCIAL_CAPTURE_PROTOCOL_TIMEOUT_MS = 1_000;
const MAX_FINANCIAL_HYDRATION_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FINANCIAL_HYDRATION_EXPRESSION_CHARACTERS = 1024 * 1024;
const MAX_FINANCIAL_HYDRATION_DEPTH = 32;
const MAX_FINANCIAL_HYDRATION_NODES = 64;
const FINANCIAL_AUDIT_SHAPE_FAILURE =
  "Financial audit evidence bound or shape failure";
const FINANCIAL_AUDIT_MULTISET_FAILURE =
  "Financial audit evidence did not match its expected multiset";
export const FINANCIAL_CAPTURE_CONSOLE_WITNESS =
  "pale-orbit-financial-capture-console-witness";
export const FINANCIAL_CAPTURE_STRUCTURED_CONSOLE_WITNESS =
  "pale-orbit-financial-capture-structured-console-witness";
const EXPECTED_GOOGLE_FONT_FAMILIES = [
  "IBM Plex Mono:wght@400;500",
  "IBM Plex Sans:wght@300;400;500;600",
  "Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;1,6..72,300;1,6..72,400",
] as const;

const hasHeaderControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

export function requireBoundedFinancialResponseBody(body: unknown): string {
  if (
    typeof body !== "string" ||
    body.length > MAX_FINANCIAL_DURABLE_RESOURCE_BYTES ||
    Buffer.byteLength(body, "utf8") > MAX_FINANCIAL_DURABLE_RESOURCE_BYTES
  ) {
    throw new Error("Financial response body exceeded its bound");
  }
  return body;
}

type RefundScenario =
  "draft-finalization-correction" | "recovery-persistence" | "terminal-policy";

export interface FinancialAdministrator {
  readonly label: string;
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  readonly context: BrowserContext;
  readonly page: Page;
}

export interface FinancialRefundItem {
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly amountMinor: number;
}

export interface FinancialRefundFixture {
  readonly refundId: string;
  readonly reviewPath: string;
  readonly items: Readonly<{
    attribution: FinancialRefundItem;
    preserved: FinancialRefundItem;
    recoverable: FinancialRefundItem;
  }>;
  readonly finalizationAllocations: readonly FinancialRefundItem[];
  readonly recoveryEligibilityAllocations: readonly FinancialRefundItem[];
  readonly correctionAllocations: readonly FinancialRefundItem[];
  readonly expectedCorrectedFinancialMetricsByTitleId: Readonly<
    Record<
      string,
      Readonly<{ refundPrincipalMinor: number; refundFeeImpactMinor: number }>
    >
  >;
  readonly privateValues: readonly string[];
  /** Values forbidden specifically in browser, response, console, and request evidence. */
  readonly browserPrivateValues: readonly string[];
  readonly purchaseOwner: "claimed-account" | "unclaimed-guest";
  readonly scenario: RefundScenario;
  readonly orderId: string;
  readonly paymentId: string;
  readonly purchaserEmail: string;
  readonly providerPaymentIntentId: string;
  readonly providerChargeId: string;
  readonly providerRefundId: string;
  readonly providerBalanceTransactionId: string;
}

export interface FinancialCommandRun {
  readonly commandId: string;
  readonly browserPrivateValues: readonly string[];
  readonly submissionCount: number;
  readonly observedStatuses: readonly FinancialAdminCommandStatusDto["status"][];
  readonly protectedStatusReadCount: number;
  readonly terminal: FinancialAdminCommandStatusDto;
}

interface FinancialArtifactCapture {
  finish(): Promise<FinancialArtifactEvidence>;
}

export interface FinancialResponseCapture {
  readonly kind:
    | "action"
    | "command-status"
    | "document"
    | "download"
    | "initial-page-data"
    | "metadata"
    | "svelte-data"
    | "xhr";
  readonly body: string;
}

export interface FinancialArtifactEvidence {
  readonly browser: readonly Readonly<{ html: string; text: string }>[];
  readonly responses: readonly FinancialResponseCapture[];
  readonly console: readonly string[];
  readonly externalRequests: readonly string[];
}

interface SalesPrivacyCapture {
  snapshot(): Promise<{
    readonly responses: readonly FinancialResponseCapture[];
    readonly console: readonly string[];
    readonly externalRequests: readonly string[];
  }>;
  close(): Promise<void>;
}

interface SalesExportBound {
  readonly exportPath: string;
  readonly privateValues: readonly string[];
  close(): Promise<void>;
}

type FinancialAuditExpectedAction =
  | "financial.admin_command.conflict"
  | "financial.admin_command.denied"
  | "financial.admin_command.failed"
  | "financial.balance_transaction.imported"
  | "financial.classification.appended"
  | "financial.issue.opened"
  | "financial.issue.resolved"
  | "financial.recovery_grant.activated"
  | "financial.recovery_grant.deactivated"
  | "financial.refund_allocation.finalized"
  | "financial.refund_correction.created"
  | "financial.refund_draft.created"
  | "financial.refund_draft.discarded"
  | "financial.refund_draft.updated"
  | "financial.refund_reconciled";

export interface AuditEvidenceInput {
  readonly refundId: string;
  readonly privateValues: readonly string[];
  readonly fixtureActions: readonly FinancialAuditExpectedAction[];
  readonly commands: readonly Readonly<{
    commandId: string;
    actions: readonly FinancialAuditExpectedAction[];
  }>[];
}

export interface FinancialAuditSignature {
  readonly action: string;
  readonly outcome: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly correlationId: string;
  readonly actorType: string;
  readonly actorId: string | null;
}

export interface FinancialHarness {
  promoteAdministrators<const Labels extends readonly string[]>(
    browser: Browser,
    labels: Labels,
  ): Promise<{ readonly [Key in keyof Labels]: FinancialAdministrator }>;
  createRefundFixture(input: {
    readonly purchaseOwner: "claimed-account" | "unclaimed-guest";
    readonly scenario: RefundScenario;
    readonly otherActiveGrantFor: "preserved" | null;
  }): Promise<FinancialRefundFixture>;
  runCommand(input: {
    readonly page: Page;
    readonly submit: () => Promise<void>;
    readonly afterSubmit?:
      ((input: { readonly commandId: string }) => Promise<void>) | undefined;
    readonly failCommand?: boolean;
    readonly demoteSubmitterBeforeClaim?: Readonly<{
      by: FinancialAdministrator;
      expectedCommandKind: FinancialAdminCommandStatusDto["kind"];
    }>;
  }): Promise<FinancialCommandRun>;
  withWorkerClaimBarrier<Result>(
    action: () => Promise<Result>,
  ): Promise<Result>;
  seedSalesReportingMatrix(): Promise<SalesReportingFixture>;
  seedSalesExportBound(
    kind: "rows" | "bytes" | "deadline",
  ): Promise<SalesExportBound>;
  auditCount(action: string, resourceId?: string): Promise<number>;
  capturePrivacy(page: Page): Promise<SalesPrivacyCapture>;
  captureFinancialArtifacts(
    pages: readonly Page[],
  ): Promise<FinancialArtifactCapture>;
  readAccess(
    fixture: FinancialRefundFixture,
    titleId: string,
  ): Promise<boolean>;
  readClaimState(
    fixture: FinancialRefundFixture,
  ): Promise<"unclaimed" | "claimed">;
  readRefundState(fixture: FinancialRefundFixture): Promise<RefundState>;
  readAuditEvidence(input: AuditEvidenceInput): Promise<AuditEvidence>;
  readEmailEvidence(
    fixture: FinancialRefundFixture,
  ): Promise<readonly EmailEvidence[]>;
  completeGuestClaim(input: {
    readonly fixture: FinancialRefundFixture;
    readonly page: Page;
  }): Promise<void>;
  publishLaterRefundAndDispute(input: {
    readonly fixture: FinancialRefundFixture;
  }): Promise<void>;
  demoteAdministrator(input: {
    readonly target: FinancialAdministrator;
    readonly by: FinancialAdministrator;
  }): Promise<void>;
  restoreAdministrator(input: {
    readonly target: FinancialAdministrator;
    readonly by: FinancialAdministrator;
  }): Promise<void>;
  navigationAbortEvidence(commandId: string): Promise<NavigationAbortEvidence>;
  close(): Promise<void>;
}

interface RefundState {
  readonly providerRefundTotalMinor: number;
  readonly historicalRefundedMinorByTitleId: Readonly<Record<string, number>>;
  readonly effectiveAccessByTitleId: Readonly<Record<string, boolean>>;
  readonly correctionSetIds: readonly string[];
  readonly financialMetricsByTitleId: Readonly<
    Record<
      string,
      Readonly<{ refundPrincipalMinor: number; refundFeeImpactMinor: number }>
    >
  >;
  readonly recoveryState: "active" | "revoked" | null;
}

interface AuditEvidence {
  readonly rowCount: number;
  readonly detailReads: readonly Readonly<{
    action: string;
    actorLabel: string;
  }>[];
  readonly domainActions: readonly Readonly<{
    commandId: string;
    action: string;
    actorLabel: string;
  }>[];
  readonly issueActions: readonly Readonly<{
    commandId: string | null;
    action: string;
    actorLabel: string;
  }>[];
  readonly reconciliationActions: readonly Readonly<{
    commandId: string;
    action: string;
    actorLabel: "financial-worker";
  }>[];
  readonly terminalCommands: readonly Readonly<{
    commandId: string;
    action: string;
    outcome: string;
    actorLabel: string;
  }>[];
}

interface FinancialAuditRawRow extends FinancialAuditSignature {
  readonly requestMetadata: unknown;
  readonly before: unknown;
  readonly after: unknown;
}

interface RetainedFixtureAudit {
  readonly refundId: string;
  readonly orderId: string;
  readonly issueId: string;
  readonly balanceTransactionId: string;
  readonly balanceClassificationId: string;
  readonly feeClassificationId: string;
  readonly setupCorrelationId: string;
  readonly signatures: readonly FinancialAuditSignature[];
}

interface RetainedCommandAudit {
  readonly commandId: string;
  readonly refundId: string;
  readonly correlationId: string;
  readonly actorId: string;
  readonly actorLabel: string;
  readonly kind: FinancialAdminCommandStatusDto["kind"];
  readonly status: Exclude<FinancialAdminCommandStatusDto["status"], "pending">;
  readonly resultCode: Exclude<
    FinancialAdminCommandStatusDto["resultCode"],
    null
  >;
  readonly signatures: readonly FinancialAuditSignature[];
  readonly payloadExpectations: readonly Readonly<{
    action: FinancialAuditExpectedAction;
    before: unknown;
    after: unknown;
  }>[];
}

interface FinancialDraftState {
  readonly id: string;
  readonly state: "active" | "discarded" | "finalized";
  readonly version: number;
  readonly createdByAdminId: string;
  readonly updatedByAdminId: string;
  readonly createdCorrelationId: string;
  readonly updatedCorrelationId: string;
  readonly finalizedAt: Date | null;
  readonly discardedAt: Date | null;
}

export function cloneBoundedFinancialAuditProjection<Value>(
  root: Value,
): Value {
  let nodeCount = 0;
  const active = new WeakSet<object>();

  const fail = (): never => {
    throw new Error(FINANCIAL_AUDIT_SHAPE_FAILURE);
  };

  const clone = (value: unknown, depth: number): unknown => {
    nodeCount += 1;
    if (
      nodeCount > MAX_AUDIT_PROJECTION_NODES ||
      depth > MAX_AUDIT_PROJECTION_DEPTH
    ) {
      return fail();
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.length > MAX_AUDIT_TEXT_CHARACTERS) return fail();
      return value;
    }
    if (typeof value === "number") {
      if (
        !Number.isFinite(value) ||
        Math.abs(value) > Number.MAX_SAFE_INTEGER ||
        Object.is(value, -0)
      ) {
        return fail();
      }
      return value;
    }
    if (typeof value !== "object") return fail();
    if (active.has(value)) return fail();
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          value.length > MAX_AUDIT_COLLECTION_ENTRIES
        ) {
          return fail();
        }
        const keys = Reflect.ownKeys(value);
        if (keys.length !== value.length + 1 || !keys.includes("length")) {
          return fail();
        }
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const key = String(index);
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.enumerable !== true
          ) {
            return fail();
          }
          result.push(clone(descriptor.value, depth + 1));
        }
        return result;
      }

      const prototype = Object.getPrototypeOf(value) as object | null;
      if (prototype !== Object.prototype && prototype !== null) return fail();
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_AUDIT_COLLECTION_ENTRIES) return fail();
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (typeof key !== "string" || key.length > MAX_AUDIT_TEXT_CHARACTERS) {
          return fail();
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          return fail();
        }
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: clone(descriptor.value, depth + 1),
          writable: true,
        });
      }
      return result;
    } finally {
      active.delete(value);
    }
  };

  try {
    const projection = clone(root, 0);
    const serialized = JSON.stringify(projection);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > MAX_AUDIT_PROJECTION_BYTES
    ) {
      return fail();
    }
    return projection as Value;
  } catch {
    return fail();
  }
}

function financialAuditSignatureKey(
  signature: FinancialAuditSignature,
): string {
  const requiredStrings = [
    signature.action,
    signature.outcome,
    signature.resourceType,
    signature.correlationId,
    signature.actorType,
  ];
  if (
    requiredStrings.some(
      (value) => typeof value !== "string" || value.length === 0,
    ) ||
    (signature.resourceId !== null &&
      typeof signature.resourceId !== "string") ||
    (signature.actorId !== null && typeof signature.actorId !== "string")
  ) {
    throw new Error(FINANCIAL_AUDIT_MULTISET_FAILURE);
  }
  return JSON.stringify([
    signature.action,
    signature.outcome,
    signature.resourceType,
    signature.resourceId,
    signature.correlationId,
    signature.actorType,
    signature.actorId,
  ]);
}

export function requireExactFinancialAuditSignatures(
  actual: readonly FinancialAuditSignature[],
  expected: readonly FinancialAuditSignature[],
): void {
  try {
    const counts = new Map<string, number>();
    for (const signature of expected) {
      const key = financialAuditSignatureKey(signature);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const signature of actual) {
      const key = financialAuditSignatureKey(signature);
      const remaining = counts.get(key);
      if (remaining === undefined || remaining === 0) {
        throw new Error(FINANCIAL_AUDIT_MULTISET_FAILURE);
      }
      if (remaining === 1) counts.delete(key);
      else counts.set(key, remaining - 1);
    }
    if (counts.size !== 0) {
      throw new Error(FINANCIAL_AUDIT_MULTISET_FAILURE);
    }
  } catch {
    throw new Error(FINANCIAL_AUDIT_MULTISET_FAILURE);
  }
}

export function requireOptionalFinancialReconciliationAuditCardinality(input: {
  readonly eventCount: number;
  readonly exactCount: number;
}): boolean {
  if (
    !Number.isSafeInteger(input.eventCount) ||
    !Number.isSafeInteger(input.exactCount) ||
    input.eventCount < 0 ||
    input.eventCount > 1 ||
    input.exactCount !== input.eventCount
  ) {
    throw new Error("Financial reconciliation audit cardinality was invalid");
  }
  return input.eventCount === 1;
}

export function assertPrivacyFirstFinancialAuditSignatures(input: {
  readonly boundedRawRows: unknown;
  readonly privateValues: readonly string[];
  readonly expected: readonly FinancialAuditSignature[];
  readonly projectActual: (
    boundedRawRows: unknown,
  ) => readonly FinancialAuditSignature[];
}): void {
  assertCommercePrivacy(
    "financial audit",
    input.boundedRawRows,
    input.privateValues,
  );
  requireExactFinancialAuditSignatures(
    input.projectActual(input.boundedRawRows),
    input.expected,
  );
}

function financialAuditJsonRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function exactFinancialAuditJson(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (
    actual === null ||
    expected === null ||
    typeof actual !== "object" ||
    typeof expected !== "object" ||
    Array.isArray(actual) !== Array.isArray(expected)
  ) {
    return false;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return (
      actual.length === expected.length &&
      actual.every((value, index) =>
        exactFinancialAuditJson(value, expected[index]),
      )
    );
  }
  const actualRecord = financialAuditJsonRecord(actual);
  const expectedRecord = financialAuditJsonRecord(expected);
  if (actualRecord === null || expectedRecord === null) return false;
  const actualKeys = Object.keys(actualRecord).sort();
  const expectedKeys = Object.keys(expectedRecord).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    actualKeys.every((key) =>
      exactFinancialAuditJson(actualRecord[key], expectedRecord[key]),
    )
  );
}

function requireExactFinancialAuditActions(
  actual: readonly string[],
  expected: readonly string[],
): void {
  const counts = new Map<string, number>();
  for (const action of expected) {
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  for (const action of actual) {
    const remaining = counts.get(action);
    if (remaining === undefined || remaining === 0) {
      throw new Error(
        "Financial audit declaration did not match retained evidence",
      );
    }
    if (remaining === 1) counts.delete(action);
    else counts.set(action, remaining - 1);
  }
  if (counts.size !== 0) {
    throw new Error(
      "Financial audit declaration did not match retained evidence",
    );
  }
}

export function requireCompleteFinancialAuditCommandSelection(
  selectedCommandIds: readonly string[],
  retainedCommandIds: readonly string[],
): void {
  try {
    requireExactFinancialAuditActions(selectedCommandIds, retainedCommandIds);
  } catch {
    throw new Error(
      "Financial audit command selection did not cover retained evidence",
    );
  }
}

interface EmailEvidence {
  readonly template: string;
  readonly soldAsTitle: string | null;
  readonly accessState: string | null;
  readonly affectedTitleCount: number | null;
  readonly body: string;
}

interface NavigationAbortEvidence {
  readonly observationComplete: boolean;
  readonly initialPageStatusRequestCount: number;
  readonly pageStatusRequestsAfterNavigation: number;
  readonly pendingRequestAborted: boolean;
}

interface SalesReportingFixture {
  readonly firstPageRowCount: number;
  readonly overviewRowCount: number;
  readonly privateValues: readonly string[];
  readonly publicCohort: Readonly<{
    suffix: string;
    titles: readonly string[];
  }>;
  readonly titles: Readonly<{
    archived: Readonly<{
      id: string;
      currentTitle: string;
      soldAsTitle: string;
      soldAsCreator: string;
    }>;
    fx: Readonly<{ id: string; currentTitle: string }>;
    knownZero: Readonly<{ id: string; currentTitle: string }>;
    incomplete: Readonly<{ id: string; currentTitle: string }>;
  }>;
  readonly filterWindow: Readonly<{
    from: string;
    to: string;
    expectedTitles: readonly string[];
  }>;
  readonly expectedFilterTitles: Readonly<{
    comic: readonly string[];
    pending: readonly string[];
    feeReconciled: readonly string[];
    payoutReconciled: readonly string[];
    exception: readonly string[];
    settlementPending: readonly string[];
  }>;
  readonly pagination: Readonly<{ secondPageMarker: string }>;
  readonly issue: Readonly<{
    id: string;
    resourceId: string;
    safeCode: string;
    safeReason: string;
    excludedIssueIds: readonly string[];
  }>;
  readonly payouts: Readonly<{
    pending: PayoutFixture;
    completedAutomatic: PayoutFixture;
    failedAfterPaid: PayoutFixture & { safeFailureCode: string };
    manual: PayoutFixture;
    instant: PayoutFixture;
  }>;
}

interface PayoutFixture {
  readonly id: string;
}

type SalesTitleFormat = "prose" | "comic";
type SalesTitleVisibility = "private" | "archived";
type SalesFinancialEvidenceStatus = "pending" | "fee_reconciled" | "exception";
type SalesFinancialSourceKind = "payment" | "refund" | "dispute";
type SalesProviderSourceFamily = "charge" | "refund" | "dispute";
type SalesFinancialClassification =
  | "charge"
  | "refund"
  | "dispute_withdrawal"
  | "dispute_reinstatement"
  | "processing_fee"
  | "dispute_fee";
type SalesFinancialComponent =
  | "sale_subtotal"
  | "processing_fee"
  | "refund_subtotal"
  | "refund_tax"
  | "dispute_subtotal"
  | "dispute_fee"
  | "dispute_reinstatement"
  | "fee_credit"
  | "other";

interface SalesTitleSeed {
  readonly id: string;
  readonly currentTitle: string;
  readonly format: SalesTitleFormat;
  readonly visibility: SalesTitleVisibility;
}

interface SalesPurchaseItemInput {
  readonly title: SalesTitleSeed;
  readonly titleSnapshot: string;
  readonly creatorNameSnapshot: string;
  readonly format: SalesTitleFormat;
  readonly subtotalMinor: number;
}

interface SalesPurchaseItemSeed extends SalesPurchaseItemInput {
  readonly id: string;
}

interface SalesPurchaseSeed {
  readonly orderId: string;
  readonly paymentId: string;
  readonly chargeProviderId: string;
  readonly paymentIntentProviderId: string;
  readonly buyerEmail: string;
  readonly items: readonly SalesPurchaseItemSeed[];
  readonly privateValues: readonly string[];
}

interface SalesAllocationItemInput {
  readonly orderItemId: string;
  readonly component: SalesFinancialComponent;
  readonly effectMinor: number;
}

interface SalesFeeDetailInput {
  readonly rawType: string;
  readonly amountMinor: number;
  readonly classification: SalesFinancialClassification;
}

interface SalesBalanceEvidenceInput {
  readonly sourceKind: SalesFinancialSourceKind;
  readonly sourceInternalId: string;
  readonly sourceFamily: SalesProviderSourceFamily;
  readonly providerSourceId: string;
  readonly parentClassification: SalesFinancialClassification;
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly currency: string;
  readonly grossItems: readonly SalesAllocationItemInput[] | null;
  readonly feeItems: readonly SalesAllocationItemInput[] | null;
  readonly feeDetails?: readonly SalesFeeDetailInput[];
  readonly exchangeRate?: string;
  readonly exchangeSourceCurrency?: string;
  readonly grossReversalOfSetId?: string;
}

interface SalesAllocationSetSeed {
  readonly id: string;
  readonly privateValues: readonly string[];
}

interface SalesBalanceEvidenceSeed {
  readonly balanceTransactionId: string;
  readonly grossAllocationSetId: string | null;
  readonly feeAllocationSetId: string | null;
  readonly providerId: string;
  readonly privateValues: readonly string[];
}

interface SalesPayoutSeed {
  readonly id: string;
  readonly privateValues: readonly string[];
}

interface PageCapture {
  readonly page: Page;
  readonly console: string[];
  readonly responses: FinancialResponseCapture[];
  readonly externalRequests: string[];
  readonly failures: string[];
  readonly responseTasks: Set<Promise<void>>;
  readonly inFlightRequests: Set<Request>;
  close(): Promise<void>;
}

function incompleteCaptureError(captures: readonly PageCapture[]): Error {
  const categories = [
    ...new Set(captures.flatMap((capture) => capture.failures)),
  ].sort();
  return new Error(
    `Financial response capture was incomplete (${categories.join(", ")})`,
  );
}

export async function settleFinancialCaptureOperation<Value>(input: {
  readonly operation: Promise<Value>;
  readonly timeoutMs: number;
  readonly disposeLate?: (value: Value) => Promise<void> | void;
}): Promise<
  | Readonly<{ status: "complete"; value: Value }>
  | Readonly<{ status: "failed" | "timeout" }>
> {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > 60_000 ||
    (input.disposeLate !== undefined && typeof input.disposeLate !== "function")
  ) {
    throw new Error("Financial capture operation timeout was invalid");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = input.operation.then(
    (value) => ({ status: "complete", value }) as const,
    () => ({ status: "failed" }) as const,
  );
  const result = await Promise.race([
    settled,
    new Promise<Readonly<{ status: "timeout" }>>((resolve) => {
      timer = setTimeout(() => resolve({ status: "timeout" }), input.timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (result.status === "timeout" && input.disposeLate !== undefined) {
    void input.operation
      .then((value) => input.disposeLate!(value))
      .catch(() => undefined);
  }
  return result;
}

async function disposeDurableResponseSession(
  session: CDPSession,
): Promise<boolean> {
  let operation: Promise<void>;
  try {
    operation = session.detach();
  } catch {
    return false;
  }
  const result = await settleFinancialCaptureOperation({
    operation,
    timeoutMs: FINANCIAL_CAPTURE_PROTOCOL_TIMEOUT_MS,
  });
  return result.status === "complete";
}

export async function waitForFinancialCaptureSettlement(input: {
  readonly signal: AbortSignal;
  readonly pending: () => number;
  readonly barrier: () => Promise<void>;
  readonly pause: () => Promise<void>;
}): Promise<void> {
  const bounded = async (operation: () => Promise<void>): Promise<void> => {
    if (input.signal.aborted) {
      throw new Error("Financial capture settlement timed out");
    }
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          abort = () =>
            reject(new Error("Financial capture settlement timed out"));
          input.signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (abort !== undefined) {
        input.signal.removeEventListener("abort", abort);
      }
    }
  };

  while (true) {
    await bounded(input.barrier);
    if (input.pending() !== 0) {
      await bounded(input.pause);
      continue;
    }
    await bounded(input.barrier);
    if (input.pending() === 0) return;
    await bounded(input.pause);
  }
}

export async function drainFinancialCaptureTasks(
  tasks: ReadonlySet<Promise<void>>,
  timeoutMs = 1_000,
): Promise<"complete" | "failed" | "timeout"> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid financial capture task drain timeout");
  }
  if (tasks.size === 0) return "complete";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    Promise.allSettled([...tasks]),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (result === null) return "timeout";
  return result.some((entry) => entry.status === "rejected")
    ? "failed"
    : "complete";
}

function financialCaptureBarrier(page: Page): Promise<void> {
  if (page.isClosed()) {
    return Promise.reject(new Error("Financial capture page was closed"));
  }
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }, 0);
      }),
  );
}

interface NavigationObservation {
  readonly page: Page;
  statusRequests: number;
  requestsAtNavigation: number | null;
  navigationAt: number | null;
  onRequest: ((request: Request) => void) | null;
}

function compactUuid(): string {
  return randomUUID().replaceAll("-", "");
}

function privateProviderId(prefix: string): string {
  return `${prefix}_e2e_${compactUuid()}`;
}

function deadlineSignal(milliseconds = COMMAND_DEADLINE_MS): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

async function conditionPoll<Value>(input: {
  readonly signal: AbortSignal;
  readonly read: () => Promise<Value>;
  readonly complete: (value: Value) => boolean;
  readonly description: string;
}): Promise<Value> {
  while (!input.signal.aborted) {
    const value = await input.read();
    if (input.complete(value)) return value;
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = (): void => {
        clearTimeout(timer);
        reject(input.signal.reason);
      };
      const timer = setTimeout(finish, 25);
      input.signal.addEventListener("abort", abort, { once: true });
    });
  }
  throw new Error(`Timed out waiting for ${input.description}`);
}

function assertCanonicalUuid(value: string, description: string): string {
  if (!UUID_PATTERN.test(value) || value !== value.toLowerCase()) {
    throw new Error(`${description} was not a canonical UUID`);
  }
  return value;
}

export function financialCommandRefundIdFromPageUrl(
  pageUrl: string,
  applicationOrigin: string,
): string {
  const fail = (): never => {
    throw new Error("Financial command page identity was invalid");
  };
  try {
    const page = new URL(pageUrl);
    const application = new URL(applicationOrigin);
    const refundMatch = /^\/admin\/sales\/refunds\/([0-9a-f-]+)$/u.exec(
      page.pathname,
    );
    if (
      page.origin !== application.origin ||
      page.username ||
      page.password ||
      page.hash !== "" ||
      refundMatch?.[1] === undefined ||
      !UUID_PATTERN.test(refundMatch[1]) ||
      refundMatch[1] !== refundMatch[1].toLowerCase()
    ) {
      return fail();
    }
    if (page.search !== "") {
      const preparation =
        /^\?\/(?:prepareFinalize|prepareCorrection|prepareRecoveryActivation|prepareRecoveryDeactivation)(?:&reviewCursor=([^&]+))?$/u.exec(
          page.search,
        );
      if (preparation === null) return fail();
      const encodedCursor = preparation[1];
      if (encodedCursor !== undefined) {
        const cursor = decodeURIComponent(encodedCursor);
        if (
          cursor.length === 0 ||
          cursor.length > 2_048 ||
          encodeURIComponent(cursor) !== encodedCursor
        ) {
          return fail();
        }
      }
    }
    return refundMatch[1];
  } catch {
    return fail();
  }
}

function financialPageDataBody(body: string): string | null {
  try {
    const envelope = JSON.parse(body) as unknown;
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      (envelope as { type?: unknown }).type !== "data"
    ) {
      return null;
    }
    const nodes = (envelope as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) return null;
    const page = nodes.at(-1);
    if (page === null || page === undefined) return null;
    return JSON.stringify({ type: "data", page });
  } catch {
    return null;
  }
}

function claimAuthorizationDestination(
  location: string | undefined,
  applicationOrigin: string,
): Readonly<{ path: "/api/auth/magic-link/verify"; token: string }> | null {
  try {
    const action = new URL(location ?? "", applicationOrigin);
    const keys = [...action.searchParams.keys()].sort();
    const expectedKeys = [
      "callbackURL",
      "errorCallbackURL",
      "newUserCallbackURL",
      "token",
    ];
    const token = action.searchParams.get("token");
    if (
      action.origin !== new URL(applicationOrigin).origin ||
      action.username ||
      action.password ||
      action.hash ||
      action.pathname !== "/api/auth/magic-link/verify" ||
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index]) ||
      token === null ||
      token.length < 1 ||
      token.length > 256 ||
      action.searchParams.get("callbackURL") !== "/claim/complete" ||
      action.searchParams.get("newUserCallbackURL") !== "/claim/complete" ||
      action.searchParams.get("errorCallbackURL") !==
        "/claim/complete?error=magic-link"
    ) {
      return null;
    }
    return { path: "/api/auth/magic-link/verify", token };
  } catch {
    return null;
  }
}

function exactClaimCompletionRedirect(
  location: string | undefined,
  applicationOrigin: string,
): boolean {
  try {
    const destination = new URL(location ?? "", applicationOrigin);
    return (
      destination.origin === new URL(applicationOrigin).origin &&
      !destination.username &&
      !destination.password &&
      destination.pathname === "/claim/complete" &&
      destination.search === "" &&
      destination.hash === ""
    );
  } catch {
    return false;
  }
}

function expressionBeforeHydrationProperty(
  body: string,
  expressionStart: number,
  property: string,
): Readonly<{ expression: string; nextExpressionStart: number }> | null {
  const stack: string[] = [];
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (let index = expressionStart; index < body.length; index += 1) {
    if (
      index - expressionStart >
      MAX_FINANCIAL_HYDRATION_EXPRESSION_CHARACTERS
    ) {
      return null;
    }
    const character = body[index]!;
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[" || character === "{" || character === "(") {
      stack.push(character);
      if (stack.length > MAX_FINANCIAL_HYDRATION_DEPTH) return null;
      continue;
    }
    if (character === "]" || character === "}" || character === ")") {
      const expectedOpening =
        character === "]" ? "[" : character === "}" ? "{" : "(";
      if (stack.at(-1) !== expectedOpening) return null;
      stack.pop();
      continue;
    }
    if (character !== "," || stack.length !== 0) continue;
    const propertyMarker = new RegExp(`^,\\s*${property}\\s*:`, "u").exec(
      body.slice(index),
    );
    if (propertyMarker === null) return null;
    const expression = body.slice(expressionStart, index).trim();
    return expression.length === 0 ||
      expression.length > MAX_FINANCIAL_HYDRATION_EXPRESSION_CHARACTERS
      ? null
      : {
          expression,
          nextExpressionStart: index + propertyMarker[0].length,
        };
  }
  return null;
}

function expressionBeforeHydrationObjectEnd(
  body: string,
  expressionStart: number,
): string | null {
  const stack: string[] = [];
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (let index = expressionStart; index < body.length; index += 1) {
    if (
      index - expressionStart >
      MAX_FINANCIAL_HYDRATION_EXPRESSION_CHARACTERS
    ) {
      return null;
    }
    const character = body[index]!;
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[" || character === "{" || character === "(") {
      stack.push(character);
      if (stack.length > MAX_FINANCIAL_HYDRATION_DEPTH) return null;
      continue;
    }
    if (character !== "]" && character !== "}" && character !== ")") {
      continue;
    }
    if (character === "}" && stack.length === 0) {
      const expression = body.slice(expressionStart, index).trim();
      return expression.length === 0 ||
        expression.length > MAX_FINANCIAL_HYDRATION_EXPRESSION_CHARACTERS
        ? null
        : expression;
    }
    const expectedOpening =
      character === "]" ? "[" : character === "}" ? "{" : "(";
    if (stack.at(-1) !== expectedOpening) return null;
    stack.pop();
  }
  return null;
}

export function parseInitialFinancialHydration(
  body: string,
): Readonly<{ pageData: string; actionData: string | null }> | null {
  if (
    body.length > MAX_FINANCIAL_HYDRATION_BODY_BYTES ||
    Buffer.byteLength(body, "utf8") > MAX_FINANCIAL_HYDRATION_BODY_BYTES
  ) {
    return null;
  }
  const marker = /node_ids:\s*\[([0-9,\s]*)\]\s*,\s*data:\s*(\[)/giu;
  const candidates: Array<
    Readonly<{ pageData: string; actionData: string | null }>
  > = [];
  let markerCount = 0;
  for (const match of body.matchAll(marker)) {
    markerCount += 1;
    if (markerCount > 1 || (match[1] ?? "").length > 4_096) return null;
    const nodeIds = (match[1] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (
      nodeIds.length === 0 ||
      nodeIds.length > MAX_FINANCIAL_HYDRATION_NODES ||
      nodeIds.some(
        (value) =>
          !/^(?:0|[1-9][0-9]{0,5})$/u.test(value) ||
          Number(value) > Number.MAX_SAFE_INTEGER,
      )
    ) {
      return null;
    }
    const arrayStart = match.index + match[0].lastIndexOf("[");
    const stack: string[] = ["["];
    const elements: string[] = [];
    let elementStart = arrayStart + 1;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;
    let arrayEnd = -1;
    for (let index = arrayStart + 1; index < body.length; index += 1) {
      const character = body[index]!;
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
        continue;
      }
      if (character === "[" || character === "{" || character === "(") {
        stack.push(character);
        if (stack.length > MAX_FINANCIAL_HYDRATION_DEPTH) return null;
        continue;
      }
      if (character === "," && stack.length === 1) {
        if (
          elements.length >= MAX_FINANCIAL_HYDRATION_NODES ||
          index - elementStart > MAX_FINANCIAL_HYDRATION_EXPRESSION_CHARACTERS
        ) {
          return null;
        }
        elements.push(body.slice(elementStart, index).trim());
        elementStart = index + 1;
        continue;
      }
      if (character !== "]" && character !== "}" && character !== ")") {
        continue;
      }
      const expectedOpening =
        character === "]" ? "[" : character === "}" ? "{" : "(";
      if (stack.at(-1) !== expectedOpening) return null;
      stack.pop();
      if (stack.length === 0) {
        if (
          elements.length >= MAX_FINANCIAL_HYDRATION_NODES ||
          index - elementStart > MAX_FINANCIAL_HYDRATION_EXPRESSION_CHARACTERS
        ) {
          return null;
        }
        elements.push(body.slice(elementStart, index).trim());
        arrayEnd = index;
        break;
      }
    }
    if (arrayEnd < 0) continue;
    const formMarker = /^\s*,\s*form\s*:\s*/u.exec(body.slice(arrayEnd + 1));
    if (formMarker === null) continue;
    const formStart = arrayEnd + 1 + formMarker[0].length;
    const form = expressionBeforeHydrationProperty(body, formStart, "error");
    const error =
      form === null
        ? null
        : expressionBeforeHydrationObjectEnd(body, form.nextExpressionStart);
    const leaf = elements.at(-1);
    if (
      elements.length === nodeIds.length &&
      elements.every((element) => element.length > 0) &&
      leaf !== undefined &&
      leaf !== "null" &&
      form !== null &&
      error === "null"
    ) {
      candidates.push({
        pageData: leaf,
        actionData: form.expression === "null" ? null : form.expression,
      });
    }
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

export function financialDocumentHydrationMethodValid(
  requestMethod: string,
  actionData: string | null,
): boolean {
  return requestMethod === "GET"
    ? actionData === null
    : requestMethod === "POST" && actionData !== null;
}

export function serializeFinancialConsoleValue(root: unknown):
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{
      ok: false;
      failure: "accessor" | "bound" | "cycle" | "prototype" | "unknown";
    }> {
  const maxDepth = 8;
  const maxNodes = 512;
  const maxCollectionEntries = 100;
  const maxStringLength = 32_768;
  const seen = new WeakSet<object>();
  let nodes = 0;
  let prototypeWalkNodes = 0;

  try {
    const ownProperties = (
      value: object,
      depth: number,
      excludedStringKeys: ReadonlySet<string> = new Set(),
    ): readonly unknown[] => {
      const keys = Reflect.ownKeys(value);
      if (keys.length > maxCollectionEntries) throw new Error("capture-bound");
      const properties: unknown[] = [];
      for (const key of keys) {
        if (typeof key === "string" && excludedStringKeys.has(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new Error("capture-accessor");
        }
        const encodedKey =
          typeof key === "string"
            ? { kind: "string", value: key }
            : { kind: "symbol", description: key.description ?? null };
        const keyText = typeof key === "string" ? key : (key.description ?? "");
        if (keyText.length > maxStringLength) throw new Error("capture-bound");
        properties.push({
          key: encodedKey,
          value: visit(descriptor.value, depth + 1),
        });
      }
      return properties;
    };

    const errorStandardValue = (
      error: Error,
      key: "cause" | "message" | "name" | "stack",
      fallback: unknown,
    ): unknown => {
      const prototypeSeen = new WeakSet<object>();
      let current: object | null = error;
      let prototypeDepth = 0;
      while (current !== null) {
        prototypeWalkNodes += 1;
        if (prototypeDepth > maxDepth || prototypeWalkNodes > maxNodes) {
          throw new Error("capture-bound");
        }
        if (prototypeSeen.has(current)) throw new Error("capture-cycle");
        prototypeSeen.add(current);
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(current, key);
        } catch {
          throw new Error("capture-prototype");
        }
        if (descriptor !== undefined) {
          if (!("value" in descriptor)) throw new Error("capture-accessor");
          return descriptor.value;
        }
        try {
          current = Object.getPrototypeOf(current) as object | null;
        } catch {
          throw new Error("capture-prototype");
        }
        prototypeDepth += 1;
      }
      return fallback;
    };

    const visit = (value: unknown, depth: number): unknown => {
      nodes += 1;
      if (nodes > maxNodes || depth > maxDepth)
        throw new Error("capture-bound");
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "string") {
        if (value.length > maxStringLength) throw new Error("capture-bound");
        return value;
      }
      if (typeof value === "number") {
        return Number.isFinite(value)
          ? value
          : { type: "number", value: String(value) };
      }
      if (typeof value === "bigint") {
        return { type: "bigint", value: String(value) };
      }
      if (typeof value === "undefined") return { type: "undefined" };
      if (typeof value === "symbol") {
        return { type: "symbol", description: value.description ?? null };
      }

      if (seen.has(value)) throw new Error("capture-cycle");
      seen.add(value);
      if (typeof value === "function") {
        return {
          type: "Function",
          properties: ownProperties(value, depth),
        };
      }
      if (value instanceof Error) {
        const keys = Reflect.ownKeys(value);
        if (keys.length > maxCollectionEntries)
          throw new Error("capture-bound");
        const descriptors = new Map(
          keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]),
        );
        if (
          [...descriptors.values()].some(
            (descriptor) =>
              descriptor === undefined || !("value" in descriptor),
          )
        ) {
          throw new Error("capture-accessor");
        }
        return {
          type: "Error",
          name: visit(
            errorStandardValue(
              value,
              "name",
              value instanceof AggregateError ? "AggregateError" : "Error",
            ),
            depth + 1,
          ),
          message: visit(errorStandardValue(value, "message", ""), depth + 1),
          stack: visit(errorStandardValue(value, "stack", null), depth + 1),
          cause: visit(
            errorStandardValue(value, "cause", undefined),
            depth + 1,
          ),
          properties: ownProperties(
            value,
            depth,
            new Set(["name", "message", "stack", "cause"]),
          ),
        };
      }
      if (Array.isArray(value)) {
        if (value.length > maxCollectionEntries)
          throw new Error("capture-bound");
        return {
          type: "Array",
          length: value.length,
          properties: ownProperties(value, depth, new Set(["length"])),
        };
      }
      if (value instanceof Date) {
        return {
          type: "Date",
          value: Number.isNaN(Date.prototype.valueOf.call(value))
            ? "Invalid Date"
            : Date.prototype.toISOString.call(value),
          properties: ownProperties(value, depth),
        };
      }
      if (value instanceof RegExp) {
        return {
          type: "RegExp",
          value: visit(RegExp.prototype.toString.call(value), depth + 1),
          properties: ownProperties(value, depth),
        };
      }
      if (value instanceof Map) {
        if (value.size > maxCollectionEntries) throw new Error("capture-bound");
        return {
          type: "Map",
          entries: [...Map.prototype.entries.call(value)].map(
            ([key, entry]) => [visit(key, depth + 1), visit(entry, depth + 1)],
          ),
          properties: ownProperties(value, depth),
        };
      }
      if (value instanceof Set) {
        if (value.size > maxCollectionEntries) throw new Error("capture-bound");
        return {
          type: "Set",
          values: [...Set.prototype.values.call(value)].map((entry) =>
            visit(entry, depth + 1),
          ),
          properties: ownProperties(value, depth),
        };
      }
      if (typeof URL !== "undefined" && value instanceof URL) {
        const hrefGetter = Object.getOwnPropertyDescriptor(
          URL.prototype,
          "href",
        )?.get;
        if (hrefGetter === undefined) throw new Error("capture-prototype");
        return {
          type: "URL",
          href: visit(hrefGetter.call(value), depth + 1),
          properties: ownProperties(value, depth),
        };
      }

      const prototype = Object.getPrototypeOf(value) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("capture-prototype");
      }
      return { type: "Object", properties: ownProperties(value, depth) };
    };

    return { ok: true, value: visit(root, 0) };
  } catch (error: unknown) {
    const failure =
      error instanceof Error
        ? ((
            {
              "capture-accessor": "accessor",
              "capture-bound": "bound",
              "capture-cycle": "cycle",
              "capture-prototype": "prototype",
            } as const
          )[error.message] ?? "unknown")
        : "unknown";
    return { ok: false, failure };
  }
}

async function disposeFinancialConsoleHandles(
  handles: readonly JSHandle[],
  failures: string[],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disposal = Promise.allSettled(
    handles.map((handle) => handle.dispose()),
  );
  const result = await Promise.race([
    disposal,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 1_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (result === null) {
    failures.push("console-argument-disposal-timeout");
  } else if (result.some((entry) => entry.status === "rejected")) {
    failures.push("console-argument-disposal-failed");
  }
}

function safeFinancialConsoleMessageType(message: ConsoleMessage): string {
  try {
    const messageType = message.type();
    return ["debug", "error", "info", "log", "trace", "warning"].includes(
      messageType,
    )
      ? messageType
      : "other";
  } catch {
    return "other";
  }
}

export async function captureFinancialConsoleArguments(
  message: ConsoleMessage,
  evidence: string[],
  failures: string[],
): Promise<void> {
  const safeMessageType = safeFinancialConsoleMessageType(message);
  let handles: JSHandle[];
  try {
    handles = message.args();
  } catch {
    failures.push("console-argument-capture-failed");
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (handles.length > 100) {
      failures.push("console-argument-capture-failed");
      return;
    }
    let messageText: string;
    try {
      messageText = message.text();
    } catch {
      failures.push("console-message-capture-failed");
      failures.push("console-message-capture-detail-text");
      return;
    }
    let rawLocation: ReturnType<ConsoleMessage["location"]>;
    try {
      rawLocation = message.location();
    } catch {
      failures.push("console-message-capture-failed");
      failures.push("console-message-capture-detail-location");
      return;
    }
    if (
      messageText.length > 32_768 ||
      typeof rawLocation.url !== "string" ||
      rawLocation.url.length > 32_768 ||
      !Number.isSafeInteger(rawLocation.lineNumber) ||
      rawLocation.lineNumber < 0 ||
      !Number.isSafeInteger(rawLocation.columnNumber) ||
      rawLocation.columnNumber < 0
    ) {
      failures.push("console-message-capture-failed");
      failures.push("console-message-capture-detail-bound");
      return;
    }
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 1_000);
    });
    const captured = await Promise.race([
      Promise.all(
        handles.map(async (handle) => {
          try {
            return await handle.evaluate(serializeFinancialConsoleValue);
          } catch {
            return { ok: false, failure: "handle" } as const;
          }
        }),
      ),
      timeout,
    ]);
    if (captured === null) {
      failures.push("console-argument-capture-timeout");
      return;
    }
    const argumentValues: unknown[] = [];
    for (const entry of captured) {
      if (!entry.ok) {
        failures.push("console-argument-capture-failed");
        failures.push(
          `console-argument-capture-detail-${entry.failure}-${safeMessageType}`,
        );
        return;
      }
      argumentValues.push(entry.value);
    }
    const serialized = JSON.stringify({
      type: safeMessageType,
      text: messageText,
      location: {
        url: rawLocation.url,
        lineNumber: rawLocation.lineNumber,
        columnNumber: rawLocation.columnNumber,
      },
      arguments: argumentValues,
    });
    if (Buffer.byteLength(serialized, "utf8") > 65_536) {
      failures.push("console-message-capture-failed");
      failures.push("console-message-capture-detail-bound");
      return;
    }
    evidence.push(serialized);
  } catch {
    failures.push("console-argument-capture-failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await disposeFinancialConsoleHandles(handles, failures);
  }
}

export function normalizeFinancialConsoleEvidenceForPrivacy(
  serializedEntries: readonly string[],
  applicationOrigin: string,
  publicOrigin: string,
): readonly unknown[] {
  if (serializedEntries.length > MAX_AUDIT_EVIDENCE_ROWS) {
    throw new Error("Financial console evidence exceeded its row bound");
  }
  const application = new URL(applicationOrigin);
  const publicLocation = new URL(publicOrigin);
  if (
    application.username ||
    application.password ||
    publicLocation.username ||
    publicLocation.password ||
    application.origin === "null" ||
    publicLocation.origin === "null"
  ) {
    throw new Error("Financial console origin authority was invalid");
  }
  let totalBytes = 0;
  return serializedEntries.map((serialized) => {
    const entryBytes = Buffer.byteLength(serialized, "utf8");
    totalBytes += entryBytes;
    if (
      entryBytes > 65_536 ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_AUDIT_PROJECTION_BYTES
    ) {
      throw new Error("Financial console evidence exceeded its byte bound");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      throw new Error("Financial console evidence was not valid JSON");
    }
    const record = financialAuditJsonRecord(parsed);
    if (record === null) {
      throw new Error("Financial console evidence shape was invalid");
    }
    const keys = Object.keys(record).sort();
    if (keys.length === 1 && keys[0] === "pageError") return parsed;
    if (
      keys.length !== 4 ||
      keys[0] !== "arguments" ||
      keys[1] !== "location" ||
      keys[2] !== "text" ||
      keys[3] !== "type" ||
      typeof record.type !== "string" ||
      typeof record.text !== "string" ||
      !Array.isArray(record.arguments)
    ) {
      throw new Error("Financial console evidence shape was invalid");
    }
    const location = financialAuditJsonRecord(record.location);
    const locationKeys = location === null ? [] : Object.keys(location).sort();
    if (
      location === null ||
      locationKeys.length !== 3 ||
      locationKeys[0] !== "columnNumber" ||
      locationKeys[1] !== "lineNumber" ||
      locationKeys[2] !== "url" ||
      typeof location.url !== "string" ||
      !Number.isSafeInteger(location.lineNumber) ||
      (location.lineNumber as number) < 0 ||
      !Number.isSafeInteger(location.columnNumber) ||
      (location.columnNumber as number) < 0
    ) {
      throw new Error("Financial console evidence shape was invalid");
    }
    try {
      const source = new URL(location.url);
      if (
        !source.username &&
        !source.password &&
        source.origin === application.origin
      ) {
        (location as Record<string, unknown>).url =
          `${publicLocation.origin}${source.pathname}${source.search}${source.hash}`;
      }
    } catch {
      // Browser console locations may be empty or non-URL labels. They remain
      // unmodified so the privacy scan sees the complete captured value.
    }
    return parsed;
  });
}

function captureFinancialPageError(
  error: Error,
  evidence: string[],
  failures: string[],
): void {
  const captured = serializeFinancialConsoleValue(error);
  if (!captured.ok) {
    failures.push("page-error-capture-failed");
  } else {
    const serialized = JSON.stringify({ pageError: captured.value });
    if (serialized.length > 65_536) {
      failures.push("page-error-capture-failed");
    } else {
      evidence.push(serialized);
    }
  }
  failures.push("page-error-observed");
}

function approvedExternalRequest(
  request: Request,
  applicationOrigin: string,
): string | null {
  const url = new URL(request.url());
  if (
    request.method() !== "GET" ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.origin === applicationOrigin
  ) {
    return null;
  }
  if (url.origin === "https://fonts.googleapis.com") {
    const keys = [...url.searchParams.keys()].sort();
    const families = url.searchParams.getAll("family").sort();
    if (
      url.pathname === "/css2" &&
      keys.join(",") === "display,family,family,family" &&
      url.searchParams.get("display") === "swap" &&
      families.length === EXPECTED_GOOGLE_FONT_FAMILIES.length &&
      families.every(
        (family, index) =>
          family === [...EXPECTED_GOOGLE_FONT_FAMILIES].sort()[index],
      )
    ) {
      return "blocked-approved-font-css";
    }
    return null;
  }
  return null;
}

function relevantFinancialCaptureRequest(
  request: Request,
  applicationOrigin: string,
): boolean {
  const url = new URL(request.url());
  return (
    url.origin === applicationOrigin &&
    ["document", "fetch", "xhr"].includes(request.resourceType()) &&
    (url.pathname === "/api/auth/magic-link/verify" ||
      url.pathname === "/admin/sales" ||
      url.pathname.startsWith("/admin/sales/") ||
      url.pathname === "/claim" ||
      url.pathname.startsWith("/claim/"))
  );
}

function expectedSalesDownloadFilename(filename: string): boolean {
  return /^pale-orbit-sales-(?:all-time|[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}-[0-9]{2}-[0-9]{2})\.csv$/u.test(
    filename,
  );
}

function exactSalesDownloadUrl(
  value: string,
  applicationOrigin: string,
): string | null {
  try {
    const url = new URL(value);
    if (
      url.origin !== applicationOrigin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== "/admin/sales/export.csv" ||
      url.search !== "?range=all&sort=title_asc"
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function salesDownloadDispositionFilename(value: string): string | null {
  const match =
    /^attachment;\s*filename="(pale-orbit-sales-(?:all-time|[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}-[0-9]{2}-[0-9]{2})\.csv)"$/iu.exec(
      value,
    );
  return match?.[1] ?? null;
}

async function cancelDownloadBounded(
  download: Download,
  failures: string[],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = download.cancel().catch(() => {
    failures.push("download-cancel-failed");
  });
  await Promise.race([
    cancellation,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        failures.push("download-cancel-timeout");
        resolve();
      }, 1_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

export function requireFinancialRedirectBodylessFraming(input: unknown): void {
  const fail = (): never => {
    throw new Error("Financial redirect framing evidence was invalid");
  };
  const exactKeys = (value: Record<string, unknown>, expected: string[]) =>
    Object.keys(value).sort().join("\u0000") ===
      expected.sort().join("\u0000") &&
    Reflect.ownKeys(value).length === expected.length;
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  try {
    const evidence = record(input);
    if (
      evidence === null ||
      !exactKeys(evidence, ["headers", "sizes"]) ||
      !Array.isArray(evidence.headers) ||
      evidence.headers.length === 0 ||
      evidence.headers.length > MAX_FINANCIAL_REDIRECT_HEADER_COUNT
    ) {
      return fail();
    }
    let aggregateHeaderBytes = 0;
    let contentLengthCount = 0;
    for (const candidate of evidence.headers) {
      const header = record(candidate);
      if (
        header === null ||
        !exactKeys(header, ["name", "value"]) ||
        typeof header.name !== "string" ||
        typeof header.value !== "string" ||
        header.name.length === 0 ||
        header.name.length > 256 ||
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(header.name) ||
        header.value.length > MAX_FINANCIAL_REDIRECT_HEADER_VALUE_CHARACTERS ||
        hasHeaderControlCharacter(header.value)
      ) {
        return fail();
      }
      aggregateHeaderBytes +=
        Buffer.byteLength(header.name, "utf8") +
        Buffer.byteLength(header.value, "utf8");
      if (aggregateHeaderBytes > MAX_FINANCIAL_REDIRECT_HEADER_BYTES) {
        return fail();
      }
      const name = header.name.toLowerCase();
      if (name === "content-length") {
        contentLengthCount += 1;
        if (header.value !== "0") return fail();
      }
      if (["transfer-encoding", "content-encoding", "trailer"].includes(name)) {
        return fail();
      }
    }
    const sizes = record(evidence.sizes);
    const sizeKeys = [
      "requestBodySize",
      "requestHeadersSize",
      "responseBodySize",
      "responseHeadersSize",
    ];
    if (sizes === null || !exactKeys(sizes, sizeKeys)) return fail();
    for (const key of sizeKeys) {
      const value = sizes[key];
      if (
        !Number.isSafeInteger(value) ||
        (value as number) < 0 ||
        (value as number) > MAX_FINANCIAL_REDIRECT_SIZE_BYTES
      ) {
        return fail();
      }
    }
    if (contentLengthCount !== 1 || sizes.responseBodySize !== 0) return fail();
  } catch {
    return fail();
  }
}

export function projectFinancialNoBodyResponseEvidence(input: {
  readonly applicationOrigin: string;
  readonly requestUrl: string;
  readonly status: number;
  readonly location: string | undefined;
}): Readonly<{
  requestUrl: string;
  status: number;
  location: Readonly<{
    authority: "cross-origin" | "same-origin";
    value: string;
  }> | null;
}> {
  const fail = (): never => {
    throw new Error("Financial no-body response evidence was invalid");
  };
  const bounded = (value: string): string => {
    if (value.length > 32_768 || Buffer.byteLength(value, "utf8") > 65_536) {
      return fail();
    }
    return value;
  };
  try {
    const application = new URL(input.applicationOrigin);
    const request = new URL(bounded(input.requestUrl));
    if (
      application.origin === "null" ||
      application.username ||
      application.password ||
      request.origin !== application.origin ||
      request.username ||
      request.password ||
      !(
        request.pathname === "/admin/sales" ||
        request.pathname.startsWith("/admin/sales/")
      ) ||
      !(
        (input.status >= 300 && input.status < 400) ||
        [204, 205].includes(input.status)
      )
    ) {
      return fail();
    }
    let location: {
      authority: "cross-origin" | "same-origin";
      value: string;
    } | null = null;
    if (input.location !== undefined) {
      const rawLocation = bounded(input.location);
      if (rawLocation.length === 0) return fail();
      const destination = new URL(rawLocation, application.origin);
      if (
        !["http:", "https:"].includes(destination.protocol) ||
        destination.username ||
        destination.password
      ) {
        return fail();
      }
      location =
        destination.origin === application.origin
          ? {
              authority: "same-origin",
              value: bounded(
                `${destination.pathname}${destination.search}${destination.hash}`,
              ),
            }
          : { authority: "cross-origin", value: rawLocation };
    }
    return {
      requestUrl: bounded(
        `${request.pathname}${request.search}${request.hash}`,
      ),
      status: input.status,
      location,
    };
  } catch {
    return fail();
  }
}

async function capturePage(
  page: Page,
  applicationOrigin: string,
): Promise<PageCapture> {
  const console: string[] = [];
  const responses: FinancialResponseCapture[] = [];
  const externalRequests: string[] = [];
  const failures: string[] = [];
  const responseTasks = new Set<Promise<void>>();
  const inFlightRequests = new Set<Request>();
  const origin = new URL(applicationOrigin).origin;
  let closed = false;
  let durableResponseSession: CDPSession | null = null;
  let claimAuthorizationState:
    "idle" | "bridge-read" | "authorization-posted" | "verified" = "idle";
  let pendingClaimAuthorizationToken: string | null = null;
  const pendingDownloadResponses: Array<
    Readonly<{ url: string; filename: string }>
  > = [];
  const captureRedirectNoBody = (response: Response): void => {
    const task = Promise.all([
      response.headersArray(),
      response.request().sizes(),
    ])
      .then(([headers, sizes]) => {
        requireFinancialRedirectBodylessFraming({ headers, sizes });
      })
      .catch(() => {
        failures.push("financial-redirect-framing-capture-failed");
      })
      .finally(() => {
        responseTasks.delete(task);
      });
    responseTasks.add(task);
  };
  const onCaptureRequest = (request: Request): void => {
    if (relevantFinancialCaptureRequest(request, origin)) {
      inFlightRequests.add(request);
    }
  };
  const onCaptureRequestSettled = (request: Request): void => {
    inFlightRequests.delete(request);
  };
  const onConsole = (message: ConsoleMessage): void => {
    const task = captureFinancialConsoleArguments(
      message,
      console,
      failures,
    ).finally(() => {
      responseTasks.delete(task);
    });
    responseTasks.add(task);
  };
  const onPageError = (error: Error): void => {
    captureFinancialPageError(error, console, failures);
  };
  const handleNetworkRoute = async (route: Route): Promise<void> => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.protocol.startsWith("http") || url.origin === origin) {
      await route.fallback();
      return;
    }
    const approved = approvedExternalRequest(request, origin);
    if (approved !== null) {
      externalRequests.push(approved);
      await route.abort("blockedbyclient");
      return;
    }
    failures.push("unexpected-external-request-blocked");
    try {
      await route.abort("blockedbyclient");
    } catch {
      failures.push("unexpected-external-request-block-failed");
    }
  };
  const onNetworkRoute = (route: Route): Promise<void> => {
    const task = handleNetworkRoute(route)
      .catch(() => {
        failures.push("external-request-route-failed");
      })
      .finally(() => {
        responseTasks.delete(task);
      });
    responseTasks.add(task);
    return task;
  };
  const onResponse = (response: Response): void => {
    const url = new URL(response.url());
    const resourceType = response.request().resourceType();
    const headers = response.headers();
    const requestMethod = response.request().method();
    const mainFrameNavigation =
      resourceType === "document" &&
      response.request().isNavigationRequest() &&
      response.request().frame() === page.mainFrame();
    if (
      url.origin === origin &&
      url.pathname === "/api/auth/magic-link/verify"
    ) {
      const destination = claimAuthorizationDestination(
        response.url(),
        applicationOrigin,
      );
      if (
        !mainFrameNavigation ||
        requestMethod !== "GET" ||
        response.status() !== 302 ||
        destination === null ||
        claimAuthorizationState !== "authorization-posted" ||
        pendingClaimAuthorizationToken === null ||
        destination.token !== pendingClaimAuthorizationToken ||
        !exactClaimCompletionRedirect(headers.location, applicationOrigin)
      ) {
        failures.push("magic-link-verification-redirect-capture-failed");
        return;
      }
      pendingClaimAuthorizationToken = null;
      claimAuthorizationState = "verified";
      responses.push({
        kind: "metadata",
        body: JSON.stringify({
          path: "/api/auth/magic-link/verify",
          status: 302,
          locationPath: "/claim/complete",
          transport: "magic-link-verification",
        }),
      });
      captureRedirectNoBody(response);
      return;
    }
    const exactBridgePostTransition =
      url.origin === origin &&
      url.pathname === "/claim/authorize" &&
      url.search === "" &&
      mainFrameNavigation &&
      requestMethod === "POST" &&
      response.status() === 303;
    if (
      mainFrameNavigation &&
      ((claimAuthorizationState === "bridge-read" &&
        !exactBridgePostTransition) ||
        claimAuthorizationState === "authorization-posted")
    ) {
      failures.push("claim-authorization-verification-sequence-failed");
      return;
    }
    if (
      url.origin !== origin ||
      !(
        url.pathname === "/admin/sales" ||
        url.pathname.startsWith("/admin/sales/") ||
        url.pathname === "/claim" ||
        url.pathname.startsWith("/claim/")
      ) ||
      !["document", "fetch", "xhr"].includes(resourceType)
    ) {
      return;
    }
    if (
      url.pathname === "/claim/authorize" &&
      url.search === "" &&
      mainFrameNavigation &&
      requestMethod === "POST" &&
      response.status() === 303
    ) {
      const destination = claimAuthorizationDestination(
        headers.location,
        applicationOrigin,
      );
      if (
        destination === null ||
        claimAuthorizationState !== "bridge-read" ||
        pendingClaimAuthorizationToken !== null
      ) {
        failures.push("claim-authorization-redirect-capture-failed");
        return;
      }
      pendingClaimAuthorizationToken = destination.token;
      claimAuthorizationState = "authorization-posted";
      responses.push({
        kind: "metadata",
        body: JSON.stringify({
          path: "/claim/authorize",
          status: 303,
          locationPath: destination.path,
          transport: "claim-authorization-bridge",
        }),
      });
      captureRedirectNoBody(response);
      return;
    }
    if (
      url.pathname === "/claim/authorize" &&
      url.search === "" &&
      mainFrameNavigation &&
      requestMethod === "GET" &&
      response.status() === 200 &&
      headers["content-type"]?.toLowerCase().startsWith("text/html") === true &&
      claimAuthorizationState === "idle"
    ) {
      claimAuthorizationState = "bridge-read";
      responses.push({
        kind: "metadata",
        body: JSON.stringify({
          path: "/claim/authorize",
          status: 200,
          transport: "claim-authorization-bridge",
        }),
      });
      return;
    }
    if (url.pathname === "/claim/authorize") {
      failures.push("claim-authorization-transport-capture-failed");
      return;
    }
    const attachment =
      headers["content-disposition"]?.toLowerCase().includes("attachment") ===
      true;
    if (attachment) {
      const disposition = headers["content-disposition"] ?? "";
      const downloadUrl = exactSalesDownloadUrl(response.url(), origin);
      const filename = salesDownloadDispositionFilename(disposition);
      if (
        downloadUrl === null ||
        filename === null ||
        requestMethod !== "GET" ||
        response.status() !== 200 ||
        headers["content-type"]?.toLowerCase().startsWith("text/csv") !== true
      ) {
        failures.push("unexpected-download-response");
        return;
      }
      pendingDownloadResponses.push({ url: downloadUrl, filename });
      responses.push({
        kind: "metadata",
        body: JSON.stringify({
          path: "/admin/sales/export.csv",
          status: 200,
          transport: "bounded-download",
        }),
      });
      return;
    }
    const genericRedirect =
      response.status() >= 300 &&
      response.status() < 400 &&
      response.status() !== 304;
    if (genericRedirect || [204, 205, 304].includes(response.status())) {
      try {
        responses.push({
          kind: "metadata",
          body: JSON.stringify(
            projectFinancialNoBodyResponseEvidence({
              applicationOrigin,
              requestUrl: response.url(),
              status: response.status(),
              location: headers.location,
            }),
          ),
        });
      } catch {
        failures.push("financial-no-body-response-capture-failed");
      }
      if (genericRedirect) {
        captureRedirectNoBody(response);
      }
      return;
    }
    const kind: FinancialResponseCapture["kind"] =
      resourceType === "document"
        ? "document"
        : url.pathname.endsWith("/__data.json")
          ? "svelte-data"
          : /^\/admin\/sales\/commands\/[0-9a-f-]+$/u.test(url.pathname)
            ? "command-status"
            : requestMethod === "POST"
              ? "action"
              : "xhr";
    const task = response
      .text()
      .then((rawBody) => {
        let body: string;
        try {
          body = requireBoundedFinancialResponseBody(rawBody);
        } catch {
          failures.push("financial-response-body-bound-exceeded");
          return;
        }
        if (kind === "document") {
          const main = body.match(/<main(?:\s[^>]*)?>[\s\S]*?<\/main>/giu);
          if (main?.length !== 1) {
            failures.push("financial-document-main-capture-failed");
            return;
          }
          const hydration = parseInitialFinancialHydration(body);
          if (hydration === null) {
            failures.push("financial-document-page-data-capture-failed");
            return;
          }
          if (
            !financialDocumentHydrationMethodValid(
              requestMethod,
              hydration.actionData,
            )
          ) {
            failures.push("financial-document-action-data-capture-failed");
            return;
          }
          responses.push({ kind, body: main[0] });
          responses.push({
            kind: "initial-page-data",
            body: hydration.pageData,
          });
          if (requestMethod === "POST") {
            responses.push({ kind: "action", body: hydration.actionData! });
          }
          return;
        }
        if (kind === "svelte-data") {
          const pageData = financialPageDataBody(body);
          if (pageData === null) {
            failures.push("financial-page-data-capture-failed");
            return;
          }
          responses.push({ kind, body: pageData });
          return;
        }
        responses.push({ kind, body });
      })
      .catch(() => {
        failures.push(
          `response-body-read-failed:${kind}:${requestMethod}:${response.status()}`,
        );
      })
      .finally(() => {
        responseTasks.delete(task);
      });
    responseTasks.add(task);
  };
  const onDownload = (download: Download): void => {
    const task = (async () => {
      const filename = download.suggestedFilename();
      const downloadUrl = exactSalesDownloadUrl(download.url(), origin);
      if (downloadUrl === null || !expectedSalesDownloadFilename(filename)) {
        failures.push("unexpected-download");
        await cancelDownloadBounded(download, failures);
        return;
      }
      let responseIndex: number;
      try {
        responseIndex = await conditionPoll({
          signal: deadlineSignal(5_000),
          description: "validated Sales download response",
          read: async () =>
            pendingDownloadResponses.findIndex(
              (response) =>
                response.url === downloadUrl && response.filename === filename,
            ),
          complete: (index) => index >= 0,
        });
      } catch {
        failures.push("download-response-correlation-failed");
        await cancelDownloadBounded(download, failures);
        return;
      }
      pendingDownloadResponses.splice(responseIndex, 1);
      let streamOpenTimedOut = false;
      let streamOpenTimer: ReturnType<typeof setTimeout> | undefined;
      let streamOpenCancellation: Promise<void> | null = null;
      const streamPromise = download.createReadStream();
      void streamPromise
        .then((lateStream) => {
          if (streamOpenTimedOut) lateStream?.destroy();
        })
        .catch(() => undefined);
      const streamTimeout = new Promise<null>((resolve) => {
        streamOpenTimer = setTimeout(() => {
          streamOpenTimedOut = true;
          failures.push("download-stream-open-timeout");
          streamOpenCancellation = cancelDownloadBounded(download, failures);
          resolve(null);
        }, 15_000);
      });
      let stream: Awaited<ReturnType<Download["createReadStream"]>> | null;
      try {
        stream = await Promise.race([streamPromise, streamTimeout]);
      } finally {
        if (streamOpenTimer !== undefined) clearTimeout(streamOpenTimer);
      }
      if (streamOpenTimedOut) {
        if (streamOpenCancellation !== null) await streamOpenCancellation;
        return;
      }
      if (stream === null) {
        failures.push("download-body-read-failed");
        return;
      }
      const chunks: Buffer[] = [];
      let byteLength = 0;
      let readTimedOut = false;
      let timeoutCancellation: Promise<void> | null = null;
      const timer = setTimeout(() => {
        readTimedOut = true;
        failures.push("download-body-read-timeout");
        stream.destroy();
        timeoutCancellation = cancelDownloadBounded(download, failures);
      }, 15_000);
      try {
        for await (const value of stream) {
          const chunk = Buffer.isBuffer(value)
            ? value
            : Buffer.from(value as Uint8Array);
          if (byteLength + chunk.byteLength > MAX_CAPTURED_DOWNLOAD_BYTES) {
            failures.push("download-byte-bound-exceeded");
            stream.destroy();
            await cancelDownloadBounded(download, failures);
            return;
          }
          byteLength += chunk.byteLength;
          chunks.push(chunk);
        }
        if (readTimedOut) return;
        let body: string;
        try {
          body = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks, byteLength),
          );
        } catch {
          failures.push("download-body-utf8-invalid");
          return;
        }
        responses.push({
          kind: "download",
          body,
        });
      } catch {
        if (!readTimedOut) failures.push("download-body-read-failed");
      } finally {
        clearTimeout(timer);
        if (timeoutCancellation !== null) await timeoutCancellation;
      }
    })()
      .catch(() => {
        failures.push("download-capture-failed");
      })
      .finally(() => {
        responseTasks.delete(task);
      });
    responseTasks.add(task);
  };
  try {
    const sessionResult = await settleFinancialCaptureOperation({
      operation: page.context().newCDPSession(page),
      timeoutMs: FINANCIAL_CAPTURE_PROTOCOL_TIMEOUT_MS,
      disposeLate: async (session) => {
        await disposeDurableResponseSession(session);
      },
    });
    if (sessionResult.status !== "complete") {
      throw new Error("Financial durable response session setup failed");
    }
    durableResponseSession = sessionResult.value;
    const enableResult = await settleFinancialCaptureOperation({
      operation: durableResponseSession.send("Network.enable", {
        maxTotalBufferSize: MAX_FINANCIAL_DURABLE_TOTAL_BYTES,
        maxResourceBufferSize: MAX_FINANCIAL_DURABLE_RESOURCE_BYTES,
        enableDurableMessages: true,
      }),
      timeoutMs: FINANCIAL_CAPTURE_PROTOCOL_TIMEOUT_MS,
    });
    if (enableResult.status !== "complete") {
      throw new Error("Financial durable response session setup failed");
    }
    await page.route("**/*", onNetworkRoute);
    page.on("request", onCaptureRequest);
    page.on("requestfinished", onCaptureRequestSettled);
    page.on("requestfailed", onCaptureRequestSettled);
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("response", onResponse);
    page.on("download", onDownload);
    await page.evaluate(
      ({ flatWitness, structuredWitness }) => {
        globalThis.console.info(flatWitness);
        globalThis.console.info({ capture: { witness: structuredWitness } });
      },
      {
        flatWitness: FINANCIAL_CAPTURE_CONSOLE_WITNESS,
        structuredWitness: FINANCIAL_CAPTURE_STRUCTURED_CONSOLE_WITNESS,
      },
    );
  } catch {
    page.off("request", onCaptureRequest);
    page.off("requestfinished", onCaptureRequestSettled);
    page.off("requestfailed", onCaptureRequestSettled);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("response", onResponse);
    page.off("download", onDownload);
    if (!page.isClosed()) {
      try {
        await page.unroute("**/*", onNetworkRoute);
      } catch {
        // Setup failed, so there is no returned capture on which to report teardown.
      }
    }
    const drain = await drainFinancialCaptureTasks(responseTasks);
    if (durableResponseSession !== null) {
      await disposeDurableResponseSession(durableResponseSession);
      durableResponseSession = null;
    }
    throw new Error(
      drain === "complete"
        ? "Financial capture setup failed"
        : `Financial capture setup failed (capture-task-drain-${drain})`,
    );
  }
  return {
    page,
    console,
    responses,
    externalRequests,
    failures,
    responseTasks,
    inFlightRequests,
    async close() {
      if (closed) return;
      closed = true;
      if (page.isClosed()) {
        failures.push("capture-settlement-page-closed");
      } else {
        try {
          await waitForFinancialCaptureSettlement({
            signal: deadlineSignal(5_000),
            pending: () => inFlightRequests.size + responseTasks.size,
            barrier: () => financialCaptureBarrier(page),
            pause: () => new Promise((resolve) => setTimeout(resolve, 25)),
          });
        } catch {
          failures.push("capture-settlement-failed");
        }
      }
      page.off("request", onCaptureRequest);
      page.off("requestfinished", onCaptureRequestSettled);
      page.off("requestfailed", onCaptureRequestSettled);
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("response", onResponse);
      page.off("download", onDownload);
      if (!page.isClosed()) {
        try {
          await page.unroute("**/*", onNetworkRoute);
        } catch {
          failures.push("external-request-route-remove-failed");
        }
      }
      if (responseTasks.size > 0) {
        const drained = await drainFinancialCaptureTasks(responseTasks);
        if (drained === "timeout") {
          failures.push("capture-task-drain-timeout");
        } else if (drained === "failed") {
          failures.push("capture-task-drain-failed");
        }
      }
      if (inFlightRequests.size > 0) {
        failures.push("capture-request-drain-failed");
        inFlightRequests.clear();
      }
      if (durableResponseSession !== null) {
        if (!(await disposeDurableResponseSession(durableResponseSession))) {
          failures.push("durable-response-session-detach-failed");
        }
        durableResponseSession = null;
      }
      if (
        pendingClaimAuthorizationToken !== null ||
        claimAuthorizationState === "bridge-read" ||
        claimAuthorizationState === "authorization-posted"
      ) {
        failures.push("claim-authorization-verification-missing");
      }
      if (pendingDownloadResponses.length > 0) {
        failures.push("download-response-correlation-failed");
      }
    },
  };
}

async function mainEvidence(
  page: Page,
): Promise<Readonly<{ html: string; text: string }>> {
  if (page.isClosed()) return { html: "", text: "" };
  const main = page.locator("main");
  if ((await main.count()) === 0) return { html: "", text: "" };
  return { html: await main.innerHTML(), text: await main.innerText() };
}

async function signOut(page: Page): Promise<void> {
  const button = page
    .locator("header")
    .getByRole("button", { name: "Sign out" });
  await waitForHydratedHandler(button);
  await button.click();
}

function terminalStatus(status: FinancialAdminCommandStatusDto): boolean {
  return status.status !== "pending";
}

function commandIdFromPage(page: Page): Promise<string> {
  return conditionPoll({
    signal: deadlineSignal(3_000),
    description: "submitted financial command reference",
    read: async () => {
      const outcome = page.getByRole("heading", {
        name: "Submitted financial command",
      });
      if ((await outcome.count()) === 0) return "";
      return (
        (
          await outcome.locator("..").locator("code").first().textContent()
        )?.trim() ?? ""
      );
    },
    complete: (value) => UUID_PATTERN.test(value),
  });
}

export function createFinancialHarness(
  database: E2EDatabase,
  applicationOrigin: string,
): FinancialHarness {
  const origin = new URL(applicationOrigin).origin;
  const workerControl = createTestWorkerControlHarness({
    environment: process.env,
  });
  const administrators: FinancialAdministrator[] = [];
  const administratorByPage = new Map<Page, FinancialAdministrator>();
  const fixtureAudits = new Map<string, RetainedFixtureAudit>();
  const commandAudits = new Map<string, RetainedCommandAudit>();
  const captures = new Set<PageCapture>();
  const navigationObservations = new Map<string, NavigationObservation>();
  const refundFixtures = new Map<
    string,
    {
      readonly fixture: FinancialRefundFixture;
      readonly gateway: ReturnType<typeof createFixtureStripeGateway>;
      readonly privateValues: string[];
      readonly browserPrivateValues: string[];
    }
  >();
  const pendingRestorations = new Map<
    string,
    {
      readonly target: FinancialAdministrator;
      readonly by: FinancialAdministrator;
    }
  >();
  let bootstrapContext: BrowserContext | null = null;
  let bootstrapPage: Page | null = null;
  let projectionAuthoritySetup: Promise<void> | null = null;
  let closed = false;

  async function settlePageCaptures(page: Page): Promise<void> {
    const pageCaptures = [...captures].filter(
      (capture) => capture.page === page,
    );
    await waitForFinancialCaptureSettlement({
      signal: deadlineSignal(5_000),
      pending: () =>
        pageCaptures.reduce(
          (count, capture) =>
            count + capture.responseTasks.size + capture.inFlightRequests.size,
          0,
        ),
      barrier: () => financialCaptureBarrier(page),
      pause: () => new Promise((resolve) => setTimeout(resolve, 25)),
    });
    if (pageCaptures.some((capture) => capture.failures.length > 0)) {
      throw incompleteCaptureError(pageCaptures);
    }
  }

  function ensureProjectionAuthority(): Promise<void> {
    projectionAuthoritySetup ??= conditionPoll({
      signal: deadlineSignal(),
      description: "canonical c1-a2 projection activation",
      read: async () => {
        const result = await database.workerDb.execute<{
          classifierVersion: number;
          allocationVersion: number;
          pendingClassifierVersion: number | null;
          pendingAllocationVersion: number | null;
          pendingReplayId: string | null;
          pendingScanRunId: string | null;
          runKind: string | null;
          runPhase: string | null;
          runState: string | null;
          safeOutcome: string | null;
          runClassifierVersion: number | null;
          runAllocationVersion: number | null;
          runReplayId: string | null;
          activationJobSucceeded: boolean;
          activationAudited: boolean;
          targetJobFailed: boolean;
        }>(sql`
          select
             authority.classifier_version as "classifierVersion",
             authority.allocation_algorithm_version as "allocationVersion",
             authority.pending_classifier_version as "pendingClassifierVersion",
             authority.pending_allocation_algorithm_version as "pendingAllocationVersion",
             authority.pending_replay_id as "pendingReplayId",
             authority.pending_scan_run_id as "pendingScanRunId",
             run.kind as "runKind",
             run.phase as "runPhase",
             run.state as "runState",
             run.safe_outcome as "safeOutcome",
             run.classifier_version as "runClassifierVersion",
             run.allocation_algorithm_version as "runAllocationVersion",
             run.replay_id as "runReplayId",
             exists (
               select 1 from jobs job
               where job.type = 'commerce.financial-scan'
                 and authority.activation_correlation_id =
                   'financial-scan-' || job.id::text
                 and job.payload ->> 'scanRunId' = run.id::text
                 and job.status = 'succeeded'
             ) as "activationJobSucceeded",
             exists (
               select 1 from audit_events audit
               where audit.actor_type = 'system'
                 and audit.actor_id = 'financial-worker'
                 and audit.action = 'financial.projection_version.activated'
                 and audit.outcome = 'succeeded'
                 and audit.resource_type = 'financial_projection_version'
                 and audit.correlation_id = authority.activation_correlation_id
                 and audit.after @>
                   '{"classifierVersion":1,"allocationAlgorithmVersion":2}'::jsonb
             ) as "activationAudited",
             exists (
               select 1 from jobs job
               where job.type = 'commerce.financial-scan'
                 and job.payload ->> 'scanRunId' = run.id::text
                 and job.status = 'failed'
             ) as "targetJobFailed"
           from financial_projection_versions authority
           left join financial_scan_runs run
             on run.root_key = 'commerce.financial-classification:scan:1:2'
           where authority.singleton = true
        `);
        const state = result.rows[0];
        if (result.rows.length !== 1 || state === undefined) {
          throw new Error(
            "Financial projection authority singleton is missing",
          );
        }
        if (state.classifierVersion > 1 || state.allocationVersion > 2) {
          throw new Error(
            "Financial projection authority advanced beyond c1-a2",
          );
        }
        if (
          state.pendingReplayId !== null &&
          (state.pendingClassifierVersion !== 1 ||
            state.pendingAllocationVersion !== 2 ||
            state.pendingReplayId !== "c1-a2" ||
            state.pendingScanRunId === null)
        ) {
          throw new Error(
            "Financial projection authority targets another replay",
          );
        }
        if (state.runState === "exception" || state.targetJobFailed) {
          throw new Error("Canonical c1-a2 projection replay failed");
        }
        return state;
      },
      complete: (state) =>
        state.classifierVersion === 1 &&
        state.allocationVersion === 2 &&
        state.pendingClassifierVersion === null &&
        state.pendingAllocationVersion === null &&
        state.pendingReplayId === null &&
        state.pendingScanRunId === null &&
        state.runKind === "classification_replay" &&
        state.runPhase === "classification_replay_finalize" &&
        state.runState === "completed" &&
        state.safeOutcome === "completed" &&
        state.runClassifierVersion === 1 &&
        state.runAllocationVersion === 2 &&
        state.runReplayId === "c1-a2" &&
        state.activationJobSucceeded &&
        state.activationAudited,
    }).then(() => undefined);
    return projectionAuthoritySetup;
  }

  async function readRefundDraftStates(
    refundId: string,
  ): Promise<readonly FinancialDraftState[]> {
    const rows = await database.db
      .select({
        id: refundAllocationDrafts.id,
        state: refundAllocationDrafts.state,
        version: refundAllocationDrafts.version,
        createdByAdminId: refundAllocationDrafts.createdByAdminId,
        updatedByAdminId: refundAllocationDrafts.updatedByAdminId,
        createdCorrelationId: refundAllocationDrafts.createdCorrelationId,
        updatedCorrelationId: refundAllocationDrafts.updatedCorrelationId,
        finalizedAt: refundAllocationDrafts.finalizedAt,
        discardedAt: refundAllocationDrafts.discardedAt,
      })
      .from(refundAllocationDrafts)
      .where(eq(refundAllocationDrafts.refundId, refundId))
      .orderBy(refundAllocationDrafts.createdAt, refundAllocationDrafts.id)
      .limit(9);
    if (rows.length > 8) {
      throw new Error("Financial draft evidence exceeded its row bound");
    }
    const activeCount = rows.filter((row) => row.state === "active").length;
    if (activeCount > 1) {
      throw new Error("Financial draft evidence was inconsistent");
    }
    return rows;
  }

  function activeDraft(
    rows: readonly FinancialDraftState[],
  ): FinancialDraftState | null {
    return rows.find((row) => row.state === "active") ?? null;
  }

  async function readDraftPayloadFacts(draftId: string): Promise<{
    readonly itemCount: number;
    readonly proposedTotalMinor: number;
  }> {
    const result = await database.db.execute<{
      itemCount: number;
      proposedTotalMinor: number;
    }>(sql`
      select count(*)::integer as "itemCount",
        coalesce(sum(item.proposed_total_presentment_minor), 0)::integer
          as "proposedTotalMinor"
      from refund_allocation_draft_items item
      where item.draft_id = ${draftId}::uuid
    `);
    const facts = result.rows[0];
    if (
      result.rows.length !== 1 ||
      facts === undefined ||
      !Number.isSafeInteger(facts.itemCount) ||
      facts.itemCount < 1 ||
      facts.itemCount > MAX_AUDIT_COLLECTION_ENTRIES ||
      !Number.isSafeInteger(facts.proposedTotalMinor) ||
      facts.proposedTotalMinor < 0
    ) {
      throw new Error("Financial draft payload state was invalid");
    }
    return facts;
  }

  async function readFinalizedAllocationCount(
    refundId: string,
  ): Promise<number> {
    const result = await database.db.execute<{ itemCount: number }>(sql`
      select count(*)::integer as "itemCount"
      from refund_allocations allocation
      where allocation.refund_id = ${refundId}::uuid
        and allocation.source = 'administrative'
    `);
    const count = result.rows[0]?.itemCount;
    if (
      result.rows.length !== 1 ||
      !Number.isSafeInteger(count) ||
      count === undefined ||
      count < 1 ||
      count > MAX_AUDIT_COLLECTION_ENTRIES
    ) {
      throw new Error("Financial finalized payload state was invalid");
    }
    return count;
  }

  async function readCorrectionItemCount(
    correctionSetId: string,
  ): Promise<number> {
    const result = await database.db.execute<{ itemCount: number }>(sql`
      select count(*)::integer as "itemCount"
      from refund_reporting_correction_items item
      where item.correction_set_id = ${correctionSetId}::uuid
    `);
    const count = result.rows[0]?.itemCount;
    if (
      result.rows.length !== 1 ||
      !Number.isSafeInteger(count) ||
      count === undefined ||
      count < 1 ||
      count > MAX_AUDIT_COLLECTION_ENTRIES
    ) {
      throw new Error("Financial correction payload state was invalid");
    }
    return count;
  }

  function commandUserSignature(input: {
    readonly action: FinancialAuditExpectedAction;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly commandId: string;
    readonly correlationId: string;
    readonly actorId: string;
  }): FinancialAuditSignature {
    return {
      action: input.action,
      outcome:
        input.action === "financial.admin_command.denied"
          ? "denied"
          : input.action === "financial.admin_command.conflict" ||
              input.action === "financial.admin_command.failed"
            ? "failed"
            : "succeeded",
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      correlationId: input.correlationId,
      actorType: "user",
      actorId: input.actorId,
    };
  }

  function reconciliationSignature(input: {
    readonly refundId: string;
    readonly correlationId: string;
  }): FinancialAuditSignature {
    return {
      action: "financial.refund_reconciled",
      outcome: "succeeded",
      resourceType: "refund",
      resourceId: input.refundId,
      correlationId: input.correlationId,
      actorType: "system",
      actorId: "financial-worker",
    };
  }

  async function optionalReconciliationSignature(input: {
    readonly refundId: string;
    readonly correlationId: string;
  }): Promise<FinancialAuditSignature | null> {
    const result = await database.db.execute<{
      eventCount: number;
      exactCount: number;
    }>(sql`
      select
        count(*)::integer as "eventCount",
        count(*) filter (where
          actor_type = 'system'
          and actor_id = 'financial-worker'
          and outcome = 'succeeded'
          and resource_type = 'refund'
          and resource_id = ${input.refundId}
        )::integer as "exactCount"
      from audit_events
      where correlation_id = ${input.correlationId}
        and action = 'financial.refund_reconciled'
    `);
    const counts = result.rows[0];
    if (result.rows.length !== 1 || counts === undefined) {
      throw new Error("Financial reconciliation audit cardinality was invalid");
    }
    return requireOptionalFinancialReconciliationAuditCardinality(counts)
      ? reconciliationSignature(input)
      : null;
  }

  async function requireResolvedFixtureIssue(input: {
    readonly issueId: string;
    readonly refundId: string;
    readonly actorId: string;
  }): Promise<void> {
    const rows = await database.db
      .select({
        id: financialReconciliationIssues.id,
        resourceType: financialReconciliationIssues.resourceType,
        resourceId: financialReconciliationIssues.resourceId,
        safeCode: financialReconciliationIssues.safeCode,
        state: financialReconciliationIssues.state,
        impact: financialReconciliationIssues.impact,
        occurrenceCount: financialReconciliationIssues.occurrenceCount,
        resolvedByAdminId: financialReconciliationIssues.resolvedByAdminId,
        resolvedAt: financialReconciliationIssues.resolvedAt,
      })
      .from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.id, input.issueId))
      .limit(2);
    const issue = rows[0];
    if (
      rows.length !== 1 ||
      issue === undefined ||
      issue.resourceType !== "refund" ||
      issue.resourceId !== input.refundId ||
      issue.safeCode !== "allocation_incomplete" ||
      issue.state !== "resolved" ||
      issue.impact !== "pending" ||
      issue.occurrenceCount !== 1 ||
      issue.resolvedByAdminId !== input.actorId ||
      !(issue.resolvedAt instanceof Date)
    ) {
      throw new Error("Financial fixture issue state was invalid");
    }
  }

  async function retainFinancialCommandAudit(input: {
    readonly refundId: string;
    readonly administrator: FinancialAdministrator;
    readonly correlationId: string;
    readonly commandId: string;
    readonly terminal: Exclude<
      FinancialAdminCommandStatusDto,
      { readonly status: "pending" }
    >;
    readonly beforeDrafts: readonly FinancialDraftState[];
  }): Promise<void> {
    const fixtureAudit = fixtureAudits.get(input.refundId);
    if (fixtureAudit === undefined || commandAudits.has(input.commandId)) {
      throw new Error("Financial command audit authority was invalid");
    }
    const terminal = input.terminal;
    const afterDrafts = await readRefundDraftStates(input.refundId);
    const beforeActive = activeDraft(input.beforeDrafts);
    const afterActive = activeDraft(afterDrafts);
    const signatures: FinancialAuditSignature[] = [];
    const payloadExpectations: Array<{
      action: FinancialAuditExpectedAction;
      before: unknown;
      after: unknown;
    }> = [];
    const userSignature = (
      action: FinancialAuditExpectedAction,
      resourceType: string,
      resourceId: string,
    ): FinancialAuditSignature =>
      commandUserSignature({
        action,
        resourceType,
        resourceId,
        commandId: input.commandId,
        correlationId: input.correlationId,
        actorId: input.administrator.userId,
      });

    if (terminal.status === "succeeded") {
      if (terminal.kind === "refund_draft_save") {
        if (terminal.result.refundId !== input.refundId) {
          throw new Error("Financial draft result was invalid");
        }
        if (!terminal.result.changed) {
          if (
            beforeActive === null ||
            afterActive === null ||
            beforeActive.id !== afterActive.id ||
            beforeActive.version !== afterActive.version ||
            afterDrafts.some(
              (row) =>
                row.createdCorrelationId === input.correlationId ||
                row.updatedCorrelationId === input.correlationId,
            )
          ) {
            throw new Error("Financial unchanged draft state was invalid");
          }
        } else if (beforeActive === null) {
          if (
            afterActive === null ||
            afterActive.version !== terminal.result.draftVersion ||
            afterActive.createdByAdminId !== input.administrator.userId ||
            afterActive.updatedByAdminId !== input.administrator.userId ||
            afterActive.createdCorrelationId !== input.correlationId ||
            afterActive.updatedCorrelationId !== input.correlationId ||
            afterActive.finalizedAt !== null ||
            afterActive.discardedAt !== null
          ) {
            throw new Error("Financial created draft state was invalid");
          }
          signatures.push(
            userSignature(
              "financial.refund_draft.created",
              "refund_allocation_draft",
              afterActive.id,
            ),
          );
          const payloadFacts = await readDraftPayloadFacts(afterActive.id);
          payloadExpectations.push({
            action: "financial.refund_draft.created",
            before: null,
            after: {
              refundId: input.refundId,
              draftVersion: terminal.result.draftVersion,
              state: "active",
              itemCount: payloadFacts.itemCount,
              proposedTotalMinor: payloadFacts.proposedTotalMinor,
            },
          });
        } else {
          if (
            afterActive === null ||
            afterActive.id !== beforeActive.id ||
            afterActive.version !== terminal.result.draftVersion ||
            afterActive.version !== beforeActive.version + 1 ||
            afterActive.updatedByAdminId !== input.administrator.userId ||
            afterActive.updatedCorrelationId !== input.correlationId ||
            afterActive.finalizedAt !== null ||
            afterActive.discardedAt !== null
          ) {
            throw new Error("Financial updated draft state was invalid");
          }
          signatures.push(
            userSignature(
              "financial.refund_draft.updated",
              "refund_allocation_draft",
              afterActive.id,
            ),
          );
          const payloadFacts = await readDraftPayloadFacts(afterActive.id);
          payloadExpectations.push({
            action: "financial.refund_draft.updated",
            before: {
              refundId: input.refundId,
              draftVersion: beforeActive.version,
              state: "active",
            },
            after: {
              refundId: input.refundId,
              draftVersion: terminal.result.draftVersion,
              state: "active",
              itemCount: payloadFacts.itemCount,
              proposedTotalMinor: payloadFacts.proposedTotalMinor,
            },
          });
        }
      } else if (terminal.kind === "refund_draft_discard") {
        const discarded =
          beforeActive === null
            ? undefined
            : afterDrafts.find((row) => row.id === beforeActive.id);
        if (
          !terminal.result.changed ||
          terminal.result.refundId !== input.refundId ||
          afterActive !== null ||
          discarded === undefined ||
          discarded.state !== "discarded" ||
          discarded.version !== terminal.result.draftVersion ||
          discarded.version !== beforeActive!.version + 1 ||
          discarded.updatedByAdminId !== input.administrator.userId ||
          discarded.updatedCorrelationId !== input.correlationId ||
          !(discarded.discardedAt instanceof Date) ||
          discarded.finalizedAt !== null
        ) {
          throw new Error("Financial discarded draft state was invalid");
        }
        signatures.push(
          userSignature(
            "financial.refund_draft.discarded",
            "refund_allocation_draft",
            discarded.id,
          ),
        );
        payloadExpectations.push({
          action: "financial.refund_draft.discarded",
          before: {
            refundId: input.refundId,
            draftVersion: beforeActive!.version,
            state: "active",
          },
          after: {
            refundId: input.refundId,
            draftVersion: terminal.result.draftVersion,
            state: "discarded",
          },
        });
      } else if (terminal.kind === "refund_allocation_finalize") {
        const finalized =
          beforeActive === null
            ? undefined
            : afterDrafts.find((row) => row.id === beforeActive.id);
        if (
          terminal.result.refundId !== input.refundId ||
          afterActive !== null ||
          finalized === undefined ||
          finalized.state !== "finalized" ||
          finalized.version !== terminal.result.finalizedDraftVersion ||
          finalized.updatedByAdminId !== input.administrator.userId ||
          finalized.updatedCorrelationId !== input.correlationId ||
          !(finalized.finalizedAt instanceof Date) ||
          finalized.discardedAt !== null
        ) {
          throw new Error("Financial finalized draft state was invalid");
        }
        await requireResolvedFixtureIssue({
          issueId: fixtureAudit.issueId,
          refundId: input.refundId,
          actorId: input.administrator.userId,
        });
        signatures.push(
          userSignature(
            "financial.issue.resolved",
            "financial_issue",
            fixtureAudit.issueId,
          ),
          reconciliationSignature(input),
          userSignature(
            "financial.refund_allocation.finalized",
            "refund",
            input.refundId,
          ),
        );
        const administrativeAllocationCount =
          await readFinalizedAllocationCount(input.refundId);
        payloadExpectations.push({
          action: "financial.refund_allocation.finalized",
          before: {
            allocationStatus: "draft",
            draftVersion: beforeActive!.version,
          },
          after: {
            allocationStatus: "finalized",
            finalizedDraftVersion: terminal.result.finalizedDraftVersion,
            administrativeAllocationCount,
            accessChanged: terminal.result.accessChanged,
            emailQueued: terminal.result.emailQueued,
          },
        });
      } else if (terminal.kind === "refund_reporting_correction_create") {
        if (terminal.result.refundId !== input.refundId) {
          throw new Error("Financial correction result was invalid");
        }
        const rows = await database.db
          .select({
            id: refundReportingCorrectionSets.id,
            refundId: refundReportingCorrectionSets.refundId,
            correctionVersion: refundReportingCorrectionSets.correctionVersion,
            kind: refundReportingCorrectionSets.kind,
            approvedByAdminId: refundReportingCorrectionSets.approvedByAdminId,
            createdByAdminId: refundReportingCorrectionSets.createdByAdminId,
            correlationId: refundReportingCorrectionSets.correlationId,
            baseAllocationSetId:
              refundReportingCorrectionSets.baseAllocationSetId,
            predecessorCorrectionSetId:
              refundReportingCorrectionSets.predecessorCorrectionSetId,
            sourceFingerprintSha256:
              refundReportingCorrectionSets.sourceFingerprintSha256,
          })
          .from(refundReportingCorrectionSets)
          .where(
            eq(
              refundReportingCorrectionSets.id,
              terminal.result.correctionSetId,
            ),
          )
          .limit(2);
        const correction = rows[0];
        if (
          rows.length !== 1 ||
          correction === undefined ||
          correction.refundId !== input.refundId ||
          correction.correctionVersion !== terminal.result.correctionVersion ||
          correction.kind !== "allocation_attribution_correction" ||
          correction.approvedByAdminId !== input.administrator.userId ||
          correction.createdByAdminId !== input.administrator.userId ||
          correction.correlationId !== input.correlationId
        ) {
          throw new Error("Financial correction state was invalid");
        }
        const reconciliation = await optionalReconciliationSignature(input);
        if (reconciliation !== null) signatures.push(reconciliation);
        signatures.push(
          userSignature(
            "financial.refund_correction.created",
            "refund_reporting_correction_set",
            correction.id,
          ),
        );
        const correctionItemCount = await readCorrectionItemCount(
          correction.id,
        );
        payloadExpectations.push({
          action: "financial.refund_correction.created",
          before: {
            refundId: input.refundId,
            baseAllocationSetId: correction.baseAllocationSetId,
            rawPredecessorCorrectionSetId:
              correction.predecessorCorrectionSetId,
            compatibleCorrectionSetId: correction.predecessorCorrectionSetId,
            currentReportingComplete: true,
          },
          after: {
            refundId: input.refundId,
            correctionSetId: correction.id,
            correctionVersion: correction.correctionVersion,
            baseAllocationSetId: correction.baseAllocationSetId,
            sourceFingerprint: correction.sourceFingerprintSha256,
            correctionItemCount,
            reportingComplete: true,
          },
        });
      } else {
        const expectedState =
          terminal.kind === "administrative_recovery_activate"
            ? "active"
            : "revoked";
        const result = await database.db.execute<{
          id: string;
          state: string;
          source: string;
          stateReason: string;
          revokedAtPresent: boolean;
        }>(sql`
          select recovery.id, recovery.state, recovery.source,
            recovery.state_reason as "stateReason",
            recovery.revoked_at is not null as "revokedAtPresent"
          from entitlement_grants recovery
          join refund_allocations allocation
            on allocation.id = recovery.recovery_refund_allocation_id
          where recovery.id = ${terminal.result.recoveryGrantId}::uuid
            and allocation.refund_id = ${input.refundId}::uuid
          limit 2
        `);
        const grant = result.rows[0];
        if (
          result.rows.length !== 1 ||
          grant === undefined ||
          grant.state !== expectedState ||
          grant.source !== "administrative" ||
          grant.stateReason !== "refund_allocation_recovery" ||
          grant.revokedAtPresent !== (expectedState === "revoked")
        ) {
          throw new Error("Financial recovery state was invalid");
        }
        signatures.push(
          userSignature(
            terminal.kind === "administrative_recovery_activate"
              ? "financial.recovery_grant.activated"
              : "financial.recovery_grant.deactivated",
            "entitlement_grant",
            terminal.result.recoveryGrantId,
          ),
        );
      }
    } else {
      const mutationUnderCorrelation = afterDrafts.some(
        (row) =>
          row.createdCorrelationId === input.correlationId ||
          row.updatedCorrelationId === input.correlationId,
      );
      if (mutationUnderCorrelation) {
        throw new Error("Financial terminal command mutated draft state");
      }
      signatures.push(
        userSignature(
          terminal.status === "denied"
            ? "financial.admin_command.denied"
            : terminal.status === "conflict"
              ? "financial.admin_command.conflict"
              : "financial.admin_command.failed",
          "financial_admin_command",
          input.commandId,
        ),
      );
    }

    commandAudits.set(input.commandId, {
      commandId: input.commandId,
      refundId: input.refundId,
      correlationId: input.correlationId,
      actorId: input.administrator.userId,
      actorLabel: input.administrator.label,
      kind: terminal.kind,
      status: terminal.status,
      resultCode: terminal.resultCode,
      signatures,
      payloadExpectations,
    });
  }

  async function userRow(page: Page, email: string) {
    await page.goto("/admin/users");
    const row = page.getByRole("row").filter({ hasText: email });
    await conditionPoll({
      signal: deadlineSignal(10_000),
      description: "administrator user row",
      read: () => row.count(),
      complete: (count) => count === 1,
    });
    return row;
  }

  async function setAdministratorRole(input: {
    readonly target: FinancialAdministrator;
    readonly by: FinancialAdministrator;
    readonly enabled: boolean;
  }): Promise<void> {
    const row = await userRow(input.by.page, input.target.email);
    const name = input.enabled ? "Grant admin" : "Revoke admin";
    const button = row.getByRole("button", { name });
    const inverse = row.getByRole("button", {
      name: input.enabled ? "Revoke admin" : "Grant admin",
    });
    const [buttonCount, inverseCount] = await Promise.all([
      button.count(),
      inverse.count(),
    ]);
    if (
      buttonCount > 1 ||
      inverseCount > 1 ||
      buttonCount + inverseCount !== 1
    ) {
      throw new Error("Administrator role control state was invalid");
    }
    if (buttonCount === 0) return;
    await button.click();
    await conditionPoll({
      signal: deadlineSignal(10_000),
      description: input.enabled
        ? "administrator promotion"
        : "administrator demotion",
      read: async () => ({
        desired: await button.count(),
        inverse: await inverse.count(),
      }),
      complete: (counts) => counts.desired === 0 && counts.inverse === 1,
    });
  }

  async function restorePendingAdministrators(): Promise<void> {
    for (const [userId, restoration] of [...pendingRestorations]) {
      await setAdministratorRole({ ...restoration, enabled: true });
      pendingRestorations.delete(userId);
    }
  }

  async function hasCommittedDemotionDenial(input: {
    readonly actorUserId: string;
    readonly commandId: string;
    readonly correlationId: string;
    readonly commandKind: FinancialAdminCommandStatusDto["kind"];
  }): Promise<boolean> {
    const result = await database.db.execute<{ exact: boolean }>(sql`
      select (
        actor_type = 'user'
        and actor_id = ${input.actorUserId}
        and action = 'financial.admin_command.denied'
        and outcome = 'denied'
        and resource_type = 'financial_admin_command'
        and correlation_id = ${input.correlationId}
        and request_metadata is null
        and before is null
        and "after" = ${JSON.stringify({
          commandKind: input.commandKind,
          safeResultCode: "capability_revoked",
        })}::jsonb
      ) as exact
      from audit_events
      where resource_id = ${input.commandId}
        and action like 'financial.admin_command.%'
        and action <> 'financial.admin_command.submitted'
      order by id
      limit 2
    `);
    if (result.rows.length > 1) {
      throw new Error("Financial command denial audit was duplicated");
    }
    const row = result.rows[0];
    if (row !== undefined && row.exact !== true) {
      throw new Error("Financial command denial audit was invalid");
    }
    return row?.exact === true;
  }

  async function readCommandStatus(
    request: APIRequestContext,
    commandId: string,
    signal: AbortSignal,
    count: () => void,
  ): Promise<FinancialAdminCommandStatusDto> {
    count();
    const response = await request.get(`/admin/sales/commands/${commandId}`, {
      headers: { accept: "application/json" },
      timeout: Math.max(1, Math.min(COMMAND_DEADLINE_MS, 45_000)),
    });
    if (signal.aborted) throw signal.reason;
    if (response.status() !== 200) {
      throw new Error("Protected financial command status read failed");
    }
    return parseFinancialAdminCommandStatus(await response.json());
  }

  async function waitForPageTerminal(
    page: Page,
    status: FinancialAdminCommandStatusDto,
  ): Promise<void> {
    const expected =
      status.status === "succeeded"
        ? "Succeeded"
        : status.status === "denied"
          ? "Denied"
          : status.status === "conflict"
            ? "Conflict"
            : "Failed";
    await conditionPoll({
      signal: deadlineSignal(15_000),
      description: "terminal financial command presentation",
      read: async () => {
        if (page.isClosed()) return "";
        const locator = page.getByRole("status").filter({ hasText: "Status:" });
        return (await locator.count()) === 0 ? "" : await locator.innerText();
      },
      complete: (text) => text.includes(expected),
    });
  }

  async function promoteAdministrators<const Labels extends readonly string[]>(
    browser: Browser,
    labels: Labels,
  ): Promise<{ readonly [Key in keyof Labels]: FinancialAdministrator }> {
    if (labels.length === 0) {
      return [] as unknown as {
        readonly [Key in keyof Labels]: FinancialAdministrator;
      };
    }
    if (bootstrapContext === null) {
      const bootstrap = await administrator(browser);
      bootstrapContext = bootstrap.context;
      bootstrapPage = bootstrap.page;
    }
    const created: FinancialAdministrator[] = [];
    for (const label of labels) {
      const email = `${label}-${randomUUID()}@example.test`;
      const password = `financial-${label}-password-2026`;
      const context = await browser.newContext({
        baseURL: origin,
        serviceWorkers: "block",
      });
      let page: Page;
      try {
        page = await registerAndVerifyCustomer(context, {
          email,
          password,
          displayName: `Financial ${label}`,
        });
        const row = await userRow(bootstrapPage!, email);
        const userId = assertCanonicalUuid(
          await row.locator('input[name="userId"]').inputValue(),
          "Promoted administrator ID",
        );
        const grant = row.getByRole("button", { name: "Grant admin" });
        const revoke = row.getByRole("button", { name: "Revoke admin" });
        const initialControls = await Promise.all([
          grant.count(),
          revoke.count(),
        ]);
        if (initialControls[0] !== 1 || initialControls[1] !== 0) {
          throw new Error("Administrator promotion controls were ambiguous");
        }
        await grant.click();
        await conditionPoll({
          signal: deadlineSignal(10_000),
          description: "promoted administrator role",
          read: async () => Promise.all([grant.count(), revoke.count()]),
          complete: ([grantCount, revokeCount]) =>
            grantCount === 0 && revokeCount === 1,
        });
        await page.goto("/");
        await signOut(page);
        await signIn(page, email, password);
        await page.goto("/admin/users");
        await conditionPoll({
          signal: deadlineSignal(10_000),
          description: "promoted administrator access",
          read: () => page.getByRole("heading", { name: "Users" }).count(),
          complete: (count) => count === 1,
        });
        const result = { label, email, password, userId, context, page };
        administrators.push(result);
        administratorByPage.set(page, result);
        created.push(result);
      } catch (error: unknown) {
        await context.close();
        throw error;
      }
    }
    return created as unknown as {
      readonly [Key in keyof Labels]: FinancialAdministrator;
    };
  }

  async function createRefundFixture(input: {
    readonly purchaseOwner: "claimed-account" | "unclaimed-guest";
    readonly scenario: RefundScenario;
    readonly otherActiveGrantFor: "preserved" | null;
  }): Promise<FinancialRefundFixture> {
    await ensureProjectionAuthority();
    const suffix = compactUuid();
    const paidAt = new Date(`${FIXTURE_DAY}T12:00:00.000Z`);
    const refundedAt = new Date(`${FIXTURE_DAY}T13:00:00.000Z`);
    const purchaserEmail = `financial-refund-${suffix}@example.test`;
    const purchaserUserId =
      input.purchaseOwner === "claimed-account" ? randomUUID() : null;
    const guestIdentityId =
      input.purchaseOwner === "unclaimed-guest" ? randomUUID() : null;
    const orderId = randomUUID();
    const paymentId = randomUUID();
    const refundId = randomUUID();
    const providerCheckoutId = privateProviderId("cs");
    const providerPaymentIntentId = privateProviderId("pi");
    const providerChargeId = privateProviderId("ch");
    const providerRefundId = privateProviderId("re");
    const providerBalanceTransactionId = privateProviderId("txn");
    const providerChargeBalanceTransactionId = privateProviderId("txn_charge");
    const clientCheckoutAttemptId = randomUUID();
    const quoteFingerprintSha256 = `${compactUuid()}${compactUuid()}`;
    const statusTokenSha256 = `${compactUuid()}${compactUuid()}`;
    const fixturePrivateValues = [
      purchaserEmail,
      ...(purchaserUserId === null ? [] : [purchaserUserId]),
      ...(guestIdentityId === null ? [] : [guestIdentityId]),
      paymentId,
      providerCheckoutId,
      providerPaymentIntentId,
      providerChargeId,
      providerRefundId,
      providerBalanceTransactionId,
      providerChargeBalanceTransactionId,
      clientCheckoutAttemptId,
      quoteFingerprintSha256,
      statusTokenSha256,
    ];
    const itemDefinitions = [
      { key: "attribution", label: "Attribution" },
      { key: "preserved", label: "Preserved" },
      { key: "recoverable", label: "Recoverable" },
    ] as const;
    const storedItems: Record<
      (typeof itemDefinitions)[number]["key"],
      FinancialRefundItem
    > = {} as Record<
      (typeof itemDefinitions)[number]["key"],
      FinancialRefundItem
    >;

    await database.ownerFixtureDb.transaction(async (transaction) => {
      if (purchaserUserId !== null) {
        await transaction.insert(user).values({
          id: purchaserUserId,
          name: "Financial refund purchaser",
          email: purchaserEmail,
          emailVerified: true,
        });
      } else {
        await transaction.insert(guestIdentities).values({
          id: guestIdentityId!,
          email: purchaserEmail,
        });
      }

      await transaction.insert(orders).values({
        id: orderId,
        status: "paid",
        initiatingUserId: purchaserUserId,
        guestIdentityId,
        purchaseEmail: purchaserEmail,
        currency: "USD",
        subtotalMinor: 1_500,
        taxMinor: 0,
        totalMinor: 1_500,
        clientCheckoutAttemptId,
        quoteFingerprintSha256,
        stripeCheckoutSessionId: providerCheckoutId,
        statusTokenSha256,
        checkoutExpiresAt: new Date(`${FIXTURE_DAY}T12:30:00.000Z`),
        paidAt,
      });

      for (const [index, definition] of itemDefinitions.entries()) {
        const titleId = randomUUID();
        const orderItemId = randomUUID();
        const providerLineItemId = privateProviderId("li");
        fixturePrivateValues.push(providerLineItemId);
        const soldAsTitle = `${definition.label} refund copy ${suffix.slice(0, 8)}`;
        await transaction.insert(titles).values({
          id: titleId,
          slug: `financial-refund-${definition.key}-${suffix}`,
          title: `Current ${definition.label} refund title`,
          description: "Financial refund browser fixture",
          creatorName: "Financial Fixture Creator",
          format: index === 1 ? "comic" : "prose",
          priceMinor: 500,
          currency: "USD",
          visibility: "private",
        });
        await transaction.insert(orderItems).values({
          id: orderItemId,
          orderId,
          titleId,
          titleSnapshot: soldAsTitle,
          creatorNameSnapshot: "Sold-as Financial Creator",
          format: index === 1 ? "comic" : "prose",
          currency: "USD",
          unitSubtotalMinor: 500,
          taxMinor: 0,
          totalMinor: 500,
          stripeLineItemId: providerLineItemId,
        });
        await transaction.insert(entitlementGrants).values({
          titleId,
          userId: purchaserUserId,
          source: "purchase",
          orderItemId,
          state: purchaserUserId === null ? "unclaimed" : "active",
          stateReason: "payment_succeeded",
          grantedAt: paidAt,
        });
        storedItems[definition.key] = {
          orderItemId,
          titleId,
          soldAsTitle,
          amountMinor: 500,
        };
      }

      await transaction.insert(payments).values({
        id: paymentId,
        orderId,
        stripePaymentIntentId: providerPaymentIntentId,
        stripeLatestChargeId: providerChargeId,
        status: "succeeded",
        amountMinor: 1_500,
        currency: "USD",
        paymentMethodCategory: "card",
        paidAt,
      });
      await transaction.insert(refunds).values({
        id: refundId,
        paymentId,
        stripeRefundId: providerRefundId,
        status: "succeeded",
        amountMinor: 1_000,
        currency: "USD",
        reason: "requested_by_customer",
        providerCreatedAt: refundedAt,
        allocationStatus: "needs_review",
        financialEvidenceStatus: "pending",
      });
    });

    if (purchaserUserId !== null) {
      await database.workerDb.transaction(async (transaction) => {
        for (const item of Object.values(storedItems)) {
          await projectEffectiveEntitlement(
            transaction,
            purchaserUserId,
            item.titleId,
            paidAt,
          );
        }
      });
      if (input.otherActiveGrantFor === "preserved") {
        await database.grantEntitlement(
          purchaserEmail,
          storedItems.preserved.titleId,
        );
      }
    }

    const gateway = createFixtureStripeGateway();
    gateway.harness.setPayment(
      paymentSnapshotFixture({
        paymentIntentId: providerPaymentIntentId,
        metadataOrderId: orderId,
        latestChargeId: providerChargeId,
        amountMinor: 1_500,
        currency: "usd",
        paidAt,
      }),
    );
    gateway.harness.setCharge(
      chargeSnapshotFixture({
        id: providerChargeId,
        paymentIntentId: providerPaymentIntentId,
        amountMinor: 1_500,
        amountRefundedMinor: 1_000,
        currency: "USD",
        balanceTransactionId: providerChargeBalanceTransactionId,
        createdAt: paidAt,
      }),
    );
    gateway.harness.setRefund(
      refundSnapshotFixture({
        providerRefundId,
        paymentIntentId: providerPaymentIntentId,
        amountMinor: 1_000,
        currency: "usd",
        providerCreatedAt: refundedAt,
        balanceTransactionId: providerBalanceTransactionId,
      }),
    );
    gateway.harness.setBalanceTransaction(
      balanceTransactionSnapshotFixture({
        id: providerBalanceTransactionId,
        sourceId: providerRefundId,
        sourceFamily: "refund",
        rawType: "refund",
        reportingCategory: "refund",
        amountMinor: -1_000,
        feeMinor: 10,
        netMinor: -1_010,
        currency: "USD",
        createdAt: refundedAt,
        availableAt: new Date(`${FIXTURE_DAY}T14:00:00.000Z`),
        feeDetails: [
          {
            ordinal: 0,
            rawType: "stripe_fee",
            amountMinor: 10,
            currency: "USD",
          },
        ],
      }),
    );
    const setupCorrelationId = `e2e-refund-source-${refundId}`;
    const reconciliation = await reconcileRefundFinancialSource(
      database.workerDb,
      gateway.gateway,
      { refundId, correlationId: setupCorrelationId },
      new AbortController().signal,
    );
    if (
      reconciliation.status !== "pending" ||
      reconciliation.safeCode !== "allocation_incomplete"
    ) {
      throw new Error(
        `Expected an allocation_incomplete refund fixture, received ${reconciliation.status}`,
      );
    }
    if (reconciliation.issueId === null) {
      throw new Error("Financial fixture issue ID was missing");
    }
    const issueId = assertCanonicalUuid(
      reconciliation.issueId,
      "Financial fixture issue ID",
    );
    const issueRows = await database.db
      .select({
        id: financialReconciliationIssues.id,
        resourceType: financialReconciliationIssues.resourceType,
        resourceId: financialReconciliationIssues.resourceId,
        safeCode: financialReconciliationIssues.safeCode,
        state: financialReconciliationIssues.state,
        impact: financialReconciliationIssues.impact,
        occurrenceCount: financialReconciliationIssues.occurrenceCount,
        correlationId: financialReconciliationIssues.correlationId,
        resolvedByAdminId: financialReconciliationIssues.resolvedByAdminId,
        resolvedAt: financialReconciliationIssues.resolvedAt,
      })
      .from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.id, issueId))
      .limit(2);
    const issue = issueRows[0];
    if (
      issueRows.length !== 1 ||
      issue === undefined ||
      issue.resourceType !== "refund" ||
      issue.resourceId !== refundId ||
      issue.safeCode !== "allocation_incomplete" ||
      issue.state !== "open" ||
      issue.impact !== "pending" ||
      issue.occurrenceCount !== 1 ||
      issue.correlationId !== setupCorrelationId ||
      issue.resolvedByAdminId !== null ||
      issue.resolvedAt !== null
    ) {
      throw new Error("Financial fixture issue state was invalid");
    }
    const balanceRows = await database.db
      .select({
        id: stripeBalanceTransactions.id,
        providerId: stripeBalanceTransactions.providerId,
        liveMode: stripeBalanceTransactions.liveMode,
        sourceFamily: stripeBalanceTransactions.sourceFamily,
        sourceId: stripeBalanceTransactions.sourceId,
        rawType: stripeBalanceTransactions.rawType,
        reportingCategory: stripeBalanceTransactions.reportingCategory,
        balanceType: stripeBalanceTransactions.balanceType,
        amountMinor: stripeBalanceTransactions.amountMinor,
        feeMinor: stripeBalanceTransactions.feeMinor,
        netMinor: stripeBalanceTransactions.netMinor,
        currency: stripeBalanceTransactions.currency,
        status: stripeBalanceTransactions.status,
      })
      .from(stripeBalanceTransactions)
      .where(
        eq(stripeBalanceTransactions.providerId, providerBalanceTransactionId),
      )
      .limit(2);
    const balance = balanceRows[0];
    if (
      balanceRows.length !== 1 ||
      balance === undefined ||
      balance.providerId !== providerBalanceTransactionId ||
      balance.liveMode !== false ||
      balance.sourceFamily !== "refund" ||
      balance.sourceId !== providerRefundId ||
      balance.rawType !== "refund" ||
      balance.reportingCategory !== "refund" ||
      balance.balanceType !== "payments" ||
      balance.amountMinor !== -1_000 ||
      balance.feeMinor !== 10 ||
      balance.netMinor !== -1_010 ||
      balance.currency !== "USD" ||
      balance.status !== "available"
    ) {
      throw new Error("Financial fixture balance transaction was invalid");
    }
    const balanceTransactionId = assertCanonicalUuid(
      balance.id,
      "Financial fixture balance transaction ID",
    );
    const feeRows = await database.db
      .select({
        id: stripeBalanceTransactionFeeDetails.id,
        balanceTransactionId:
          stripeBalanceTransactionFeeDetails.balanceTransactionId,
        ordinal: stripeBalanceTransactionFeeDetails.ordinal,
        rawType: stripeBalanceTransactionFeeDetails.rawType,
        amountMinor: stripeBalanceTransactionFeeDetails.amountMinor,
        currency: stripeBalanceTransactionFeeDetails.currency,
      })
      .from(stripeBalanceTransactionFeeDetails)
      .where(
        eq(
          stripeBalanceTransactionFeeDetails.balanceTransactionId,
          balanceTransactionId,
        ),
      )
      .limit(2);
    const fee = feeRows[0];
    if (
      feeRows.length !== 1 ||
      fee === undefined ||
      fee.balanceTransactionId !== balanceTransactionId ||
      fee.ordinal !== 0 ||
      fee.rawType !== "stripe_fee" ||
      fee.amountMinor !== 10 ||
      fee.currency !== "USD"
    ) {
      throw new Error("Financial fixture fee detail was invalid");
    }
    const feeDetailId = assertCanonicalUuid(
      fee.id,
      "Financial fixture fee detail ID",
    );
    const classificationRows = await database.db
      .select({
        id: financialClassificationVersions.id,
        subjectType: financialClassificationVersions.subjectType,
        subjectId: financialClassificationVersions.subjectId,
        classifierVersion: financialClassificationVersions.classifierVersion,
        classification: financialClassificationVersions.classification,
      })
      .from(financialClassificationVersions)
      .where(
        inArray(financialClassificationVersions.subjectId, [
          balanceTransactionId,
          feeDetailId,
        ]),
      )
      .limit(3);
    const balanceClassification = classificationRows.find(
      (row) =>
        row.subjectType === "balance_transaction" &&
        row.subjectId === balanceTransactionId,
    );
    const feeClassification = classificationRows.find(
      (row) =>
        row.subjectType === "fee_detail" && row.subjectId === feeDetailId,
    );
    if (
      classificationRows.length !== 2 ||
      balanceClassification === undefined ||
      balanceClassification.classifierVersion !==
        FINANCIAL_CLASSIFIER_VERSION ||
      balanceClassification.classification !== "refund" ||
      feeClassification === undefined ||
      feeClassification.classifierVersion !== FINANCIAL_CLASSIFIER_VERSION ||
      feeClassification.classification !== "refund_fee"
    ) {
      throw new Error("Financial fixture classifications were invalid");
    }
    const balanceClassificationId = assertCanonicalUuid(
      balanceClassification.id,
      "Financial fixture balance classification ID",
    );
    const feeClassificationId = assertCanonicalUuid(
      feeClassification.id,
      "Financial fixture fee classification ID",
    );
    fixtureAudits.set(refundId, {
      refundId,
      orderId,
      issueId,
      balanceTransactionId,
      balanceClassificationId,
      feeClassificationId,
      setupCorrelationId,
      signatures: [
        {
          action: "financial.classification.appended",
          outcome: "succeeded",
          resourceType: "financial_classification",
          resourceId: balanceClassificationId,
          correlationId: setupCorrelationId,
          actorType: "system",
          actorId: "financial-worker",
        },
        {
          action: "financial.classification.appended",
          outcome: "succeeded",
          resourceType: "financial_classification",
          resourceId: feeClassificationId,
          correlationId: setupCorrelationId,
          actorType: "system",
          actorId: "financial-worker",
        },
        {
          action: "financial.balance_transaction.imported",
          outcome: "succeeded",
          resourceType: "financial_balance_transaction",
          resourceId: balanceTransactionId,
          correlationId: setupCorrelationId,
          actorType: "system",
          actorId: "financial-worker",
        },
        {
          action: "financial.issue.opened",
          outcome: "succeeded",
          resourceType: "financial_issue",
          resourceId: issueId,
          correlationId: setupCorrelationId,
          actorType: "system",
          actorId: "financial-worker",
        },
      ],
    });

    const browserPrivateValues = [...fixturePrivateValues];
    const fixture: FinancialRefundFixture = {
      refundId,
      reviewPath: `/admin/sales/refunds/${refundId}`,
      items: storedItems,
      finalizationAllocations: [
        { ...storedItems.attribution, amountMinor: 0 },
        { ...storedItems.preserved, amountMinor: 500 },
        { ...storedItems.recoverable, amountMinor: 500 },
      ],
      recoveryEligibilityAllocations: [
        { ...storedItems.attribution, amountMinor: 100 },
        { ...storedItems.preserved, amountMinor: 500 },
        { ...storedItems.recoverable, amountMinor: 400 },
      ],
      correctionAllocations: [
        { ...storedItems.attribution, amountMinor: 200 },
        { ...storedItems.preserved, amountMinor: 500 },
        { ...storedItems.recoverable, amountMinor: 300 },
      ],
      expectedCorrectedFinancialMetricsByTitleId: {
        [storedItems.attribution.titleId]: {
          refundPrincipalMinor: -200,
          refundFeeImpactMinor: -2,
        },
        [storedItems.preserved.titleId]: {
          refundPrincipalMinor: -500,
          refundFeeImpactMinor: -5,
        },
        [storedItems.recoverable.titleId]: {
          refundPrincipalMinor: -300,
          refundFeeImpactMinor: -3,
        },
      },
      privateValues: fixturePrivateValues,
      browserPrivateValues,
      purchaseOwner: input.purchaseOwner,
      scenario: input.scenario,
      orderId,
      paymentId,
      purchaserEmail,
      providerPaymentIntentId,
      providerChargeId,
      providerRefundId,
      providerBalanceTransactionId,
    };
    refundFixtures.set(refundId, {
      fixture,
      gateway,
      privateValues: fixturePrivateValues,
      browserPrivateValues,
    });
    return fixture;
  }

  async function runCommand(input: {
    readonly page: Page;
    readonly submit: () => Promise<void>;
    readonly afterSubmit?:
      ((input: { readonly commandId: string }) => Promise<void>) | undefined;
    readonly failCommand?: boolean;
    readonly demoteSubmitterBeforeClaim?: Readonly<{
      by: FinancialAdministrator;
      expectedCommandKind: FinancialAdminCommandStatusDto["kind"];
    }>;
  }): Promise<FinancialCommandRun> {
    const administrator = administratorByPage.get(input.page);
    if (administrator === undefined) {
      throw new Error("Financial commands require a promoted browser page");
    }
    const refundId = financialCommandRefundIdFromPageUrl(
      input.page.url(),
      origin,
    );
    const refundCommandPath = `/admin/sales/refunds/${refundId}`;
    const refundCommandRoute = (url: URL): boolean =>
      url.origin === origin && url.pathname === refundCommandPath;
    if (!fixtureAudits.has(refundId)) {
      throw new Error("Financial command fixture authority was not retained");
    }
    const beforeDrafts = await readRefundDraftStates(refundId);
    const demotion = input.demoteSubmitterBeforeClaim;
    const failCommand = input.failCommand ?? false;
    const correlationId = `financial-e2e-${compactUuid()}`;
    const observation: NavigationObservation = {
      page: input.page,
      statusRequests: 0,
      requestsAtNavigation: null,
      navigationAt: null,
      onRequest: null,
    };
    let commandId = "";
    let submissionCount = 0;
    let correlationApplied = false;
    let submissionDiagnostic = "no-financial-command-post-observed";
    const statusRequestCounts = new Map<string, number>();
    const initialStatusResponses = new Map<string, Response>();
    const interceptedStatusRequestCounts = new Map<string, number>();
    let heldStatusRequestCount = 0;
    let statusRouteFailure: unknown;
    let statusRouteGateReleased = false;
    let resolveStatusRouteGate: () => void = () => undefined;
    const statusRouteGate = new Promise<void>((resolve) => {
      resolveStatusRouteGate = resolve;
    });
    const releaseStatusRouteGate = (): void => {
      if (statusRouteGateReleased) return;
      statusRouteGateReleased = true;
      resolveStatusRouteGate();
    };
    const onStatusRoute = async (route: Route): Promise<void> => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const statusMatch = /^\/admin\/sales\/commands\/([0-9a-f-]+)$/u.exec(
        requestUrl.pathname,
      );
      if (
        requestUrl.origin !== new URL(origin).origin ||
        requestUrl.search !== "" ||
        request.method() !== "GET" ||
        !["fetch", "xhr"].includes(request.resourceType()) ||
        statusMatch?.[1] === undefined
      ) {
        await route.fallback();
        return;
      }
      const requestedCommandId = statusMatch[1];
      const requestCount =
        (interceptedStatusRequestCounts.get(requestedCommandId) ?? 0) + 1;
      interceptedStatusRequestCounts.set(requestedCommandId, requestCount);
      if (
        demotion !== undefined &&
        requestedCommandId === commandId &&
        requestCount > 1 &&
        !statusRouteGateReleased
      ) {
        heldStatusRequestCount += 1;
        await statusRouteGate;
      }
      try {
        await route.fallback();
      } catch (error: unknown) {
        statusRouteFailure ??= error;
      }
    };
    const onRoute = async (route: Route): Promise<void> => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      if (
        requestUrl.origin === origin &&
        requestUrl.pathname === refundCommandPath &&
        request.method() === "POST" &&
        request.resourceType() === "document" &&
        request.isNavigationRequest() &&
        request.frame() === input.page.mainFrame() &&
        !correlationApplied
      ) {
        correlationApplied = true;
        submissionDiagnostic = "financial-command-post-observed";
        await route.fallback({
          headers: { ...request.headers(), "x-request-id": correlationId },
        });
        return;
      }
      await route.fallback();
    };
    const onRequest = (request: Request): void => {
      const url = new URL(request.url());
      if (
        url.origin === origin &&
        request.method() === "POST" &&
        url.pathname === refundCommandPath &&
        request.resourceType() === "document" &&
        request.isNavigationRequest() &&
        request.frame() === input.page.mainFrame()
      ) {
        submissionCount += 1;
      }
      const statusMatch = /^\/admin\/sales\/commands\/([0-9a-f-]+)$/u.exec(
        url.pathname,
      );
      if (
        url.origin === origin &&
        request.method() === "GET" &&
        statusMatch?.[1] !== undefined
      ) {
        const requestedCommandId = statusMatch[1];
        statusRequestCounts.set(
          requestedCommandId,
          (statusRequestCounts.get(requestedCommandId) ?? 0) + 1,
        );
        if (requestedCommandId === commandId) {
          observation.statusRequests =
            statusRequestCounts.get(requestedCommandId) ?? 0;
        }
      }
      if (
        commandId.length > 0 &&
        observation.navigationAt === null &&
        request.isNavigationRequest() &&
        request.frame() === input.page.mainFrame()
      ) {
        observation.requestsAtNavigation = observation.statusRequests;
        observation.navigationAt = Date.now();
      }
    };
    const onResponse = (response: Response): void => {
      const request = response.request();
      const url = new URL(response.url());
      const statusMatch = /^\/admin\/sales\/commands\/([0-9a-f-]+)$/u.exec(
        url.pathname,
      );
      if (
        url.origin !== new URL(origin).origin ||
        url.search !== "" ||
        request.method() !== "GET" ||
        !["fetch", "xhr"].includes(request.resourceType()) ||
        response.status() !== 200 ||
        statusMatch?.[1] === undefined ||
        initialStatusResponses.has(statusMatch[1])
      ) {
        return;
      }
      initialStatusResponses.set(statusMatch[1], response);
    };
    observation.onRequest = onRequest;
    let session: Awaited<ReturnType<typeof workerControl.pause>> | null = null;
    let refundRouteInstalled = false;
    let statusRouteInstalled = false;
    let requestListenerInstalled = false;
    let responseListenerInstalled = false;
    let demotionCompleted = false;
    let releaseCompleted = false;
    let finishCompleted = false;
    let protectedStatusReadCount = 0;
    const observedStatuses: FinancialAdminCommandStatusDto["status"][] = [];
    const terminalById = new Map<string, FinancialAdminCommandStatusDto>();
    const finishSession = async (
      targetId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      if (demotionCompleted && demotion !== undefined) {
        await conditionPoll({
          signal,
          description: "committed financial command demotion denial audit",
          read: () =>
            hasCommittedDemotionDenial({
              actorUserId: administrator.userId,
              commandId: targetId,
              correlationId,
              commandKind: demotion.expectedCommandKind,
            }),
          complete: (committed) => committed,
        });
        await restoreAdministrator({
          target: administrator,
          by: demotion.by,
        });
        releaseStatusRouteGate();
      }
      const status = await conditionPoll({
        signal,
        description: "terminal protected financial command status",
        read: () =>
          readCommandStatus(
            administrator.context.request,
            targetId,
            signal,
            () => {
              protectedStatusReadCount += 1;
            },
          ),
        complete: terminalStatus,
      });
      terminalById.set(targetId, status);
    };
    try {
      await input.page.route(refundCommandRoute, onRoute);
      refundRouteInstalled = true;
      if (demotion !== undefined) {
        await input.page.route("**/admin/sales/commands/**", onStatusRoute);
        statusRouteInstalled = true;
      }
      input.page.on("request", onRequest);
      requestListenerInstalled = true;
      input.page.on("response", onResponse);
      responseListenerInstalled = true;
      const activeSession = await workerControl.pause(deadlineSignal(10_000));
      session = activeSession;
      await settlePageCaptures(input.page);
      await input.submit();
      if (!correlationApplied) {
        throw new Error(
          "Financial command request correlation was not applied",
        );
      }
      await input.page.unroute(refundCommandRoute, onRoute);
      refundRouteInstalled = false;
      try {
        commandId = assertCanonicalUuid(
          await commandIdFromPage(input.page),
          "Financial command ID",
        );
      } catch (cause: unknown) {
        throw new Error(
          `Financial command reference missing after ${submissionDiagnostic}`,
          { cause },
        );
      }
      observation.statusRequests = statusRequestCounts.get(commandId) ?? 0;
      await conditionPoll({
        signal: deadlineSignal(5_000),
        description: "initial browser command status request",
        read: async () => observation.statusRequests,
        complete: (count) => count >= 1,
      });
      await conditionPoll({
        signal: deadlineSignal(5_000),
        description: "initial browser command status response",
        read: async () => initialStatusResponses.has(commandId),
        complete: (seen) => seen,
      });
      await settlePageCaptures(input.page);
      const initialStatusResponse = initialStatusResponses.get(commandId);
      if (initialStatusResponse === undefined) {
        throw new Error("Initial browser command status response was missing");
      }
      let initialStatus: FinancialAdminCommandStatusDto;
      try {
        initialStatus = parseFinancialAdminCommandStatus(
          await initialStatusResponse.json(),
        );
      } catch {
        throw new Error("Initial browser command status response was invalid");
      }
      if (
        initialStatus.commandId !== commandId ||
        initialStatus.status !== "pending"
      ) {
        throw new Error("Initial browser command status was not pending");
      }
      observedStatuses.push(initialStatus.status);
      if (input.afterSubmit !== undefined) {
        await input.afterSubmit({ commandId });
      }
      if (demotion !== undefined) {
        await conditionPoll({
          signal: deadlineSignal(5_000),
          description: "initial pending browser command presentation",
          read: async () => {
            const status = input.page
              .getByRole("status")
              .filter({ hasText: "Status:" });
            return (await status.count()) === 0 ? "" : await status.innerText();
          },
          complete: (text) => text.includes("Status: Pending"),
        });
        await conditionPoll({
          signal: deadlineSignal(5_000),
          description: "held browser command status request",
          read: async () => heldStatusRequestCount,
          complete: (count) => count >= 1,
        });
        if (heldStatusRequestCount !== 1) {
          throw new Error("Browser command status gate was not singular");
        }
        await demoteAdministrator({
          target: administrator,
          by: demotion.by,
        });
        demotionCompleted = true;
      }
      await activeSession.release({
        commandId,
        failCommand,
        signal: deadlineSignal(10_000),
      });
      releaseCompleted = true;
      await activeSession.finish({
        signal: deadlineSignal(COMMAND_DEADLINE_MS),
        waitForTerminal: finishSession,
      });
      finishCompleted = true;
      const terminal = terminalById.get(commandId) ?? null;
      if (terminal === null)
        throw new Error("Terminal financial command status was not retained");
      if (terminal.status === "pending") {
        throw new Error("Terminal financial command status remained pending");
      }
      observedStatuses.push(terminal.status);
      await restorePendingAdministrators();
      if (observation.navigationAt === null)
        await waitForPageTerminal(input.page, terminal);
      await settlePageCaptures(input.page);
      if (statusRouteFailure !== undefined) {
        throw new Error("Browser command status route failed", {
          cause: statusRouteFailure,
        });
      }
      await retainFinancialCommandAudit({
        refundId,
        administrator,
        correlationId,
        commandId,
        terminal,
        beforeDrafts,
      });
      navigationObservations.set(commandId, observation);
      return {
        commandId,
        browserPrivateValues: [correlationId, administrator.userId],
        submissionCount,
        observedStatuses,
        protectedStatusReadCount,
        terminal,
      };
    } catch (error: unknown) {
      const recoveryErrors: unknown[] = [];
      if (session !== null && !finishCompleted) {
        if (commandId.length === 0) {
          try {
            await session.cleanup(deadlineSignal(10_000));
          } catch (cleanupError: unknown) {
            recoveryErrors.push(cleanupError);
          }
        } else {
          if (demotion !== undefined && !demotionCompleted) {
            try {
              await restorePendingAdministrators();
            } catch (restoreError: unknown) {
              recoveryErrors.push(restoreError);
            }
          }
          const targetedRecoveryErrors: unknown[] = [];
          let recoveredWithFinish = false;
          try {
            await session.finish({
              signal: deadlineSignal(COMMAND_DEADLINE_MS),
              waitForTerminal: finishSession,
            });
            recoveredWithFinish = true;
          } catch (finishError: unknown) {
            targetedRecoveryErrors.push(finishError);
          }
          if (!recoveredWithFinish) {
            if (!releaseCompleted) {
              try {
                await session.release({
                  commandId,
                  failCommand,
                  signal: deadlineSignal(10_000),
                });
                releaseCompleted = true;
              } catch (releaseError: unknown) {
                targetedRecoveryErrors.push(releaseError);
              }
            }
            try {
              await session.finish({
                signal: deadlineSignal(COMMAND_DEADLINE_MS),
                waitForTerminal: finishSession,
              });
              recoveredWithFinish = true;
            } catch (finishError: unknown) {
              targetedRecoveryErrors.push(finishError);
            }
          }
          if (!recoveredWithFinish) {
            let cleanupSucceeded = false;
            try {
              await session.cleanup(deadlineSignal(10_000));
              cleanupSucceeded = true;
            } catch (cleanupError: unknown) {
              targetedRecoveryErrors.push(cleanupError);
            }
            if (!(cleanupSucceeded && terminalById.has(commandId))) {
              recoveryErrors.push(...targetedRecoveryErrors);
            }
          }
        }
      }
      try {
        await restorePendingAdministrators();
      } catch (restoreError: unknown) {
        recoveryErrors.push(restoreError);
      }
      if (recoveryErrors.length > 0) {
        throw new AggregateError(
          [error, ...recoveryErrors],
          "Financial command and recovery failed",
          { cause: error },
        );
      }
      throw error;
    } finally {
      releaseStatusRouteGate();
      if (
        commandId.length === 0 ||
        observation.navigationAt === null ||
        !navigationObservations.has(commandId)
      ) {
        if (requestListenerInstalled) input.page.off("request", onRequest);
        observation.onRequest = null;
      }
      if (responseListenerInstalled) input.page.off("response", onResponse);
      if (statusRouteInstalled) {
        await input.page.unroute("**/admin/sales/commands/**", onStatusRoute);
      }
      if (refundRouteInstalled) {
        await input.page.unroute(refundCommandRoute, onRoute);
      }
    }
  }

  async function capturePrivacy(page: Page): Promise<SalesPrivacyCapture> {
    const capture = await capturePage(page, origin);
    captures.add(capture);
    return {
      async snapshot() {
        try {
          await capture.close();
          if (capture.failures.length > 0) {
            throw incompleteCaptureError([capture]);
          }
          return {
            responses: [...capture.responses],
            console: [...capture.console],
            externalRequests: [...capture.externalRequests],
          };
        } finally {
          captures.delete(capture);
        }
      },
      async close() {
        try {
          await capture.close();
          if (capture.failures.length > 0) {
            throw incompleteCaptureError([capture]);
          }
        } finally {
          captures.delete(capture);
        }
      },
    };
  }

  async function captureFinancialArtifacts(
    pages: readonly Page[],
  ): Promise<FinancialArtifactCapture> {
    const selected: PageCapture[] = [];
    try {
      for (const page of pages) selected.push(await capturePage(page, origin));
    } catch (error: unknown) {
      const rollback = await Promise.allSettled(
        selected.map((capture) => capture.close()),
      );
      const failures = rollback.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          [error, ...failures],
          "Financial capture setup and rollback failed",
          { cause: error },
        );
      }
      throw error;
    }
    for (const capture of selected) captures.add(capture);
    return {
      async finish() {
        try {
          await Promise.all(selected.map((capture) => capture.close()));
          if (selected.some((capture) => capture.failures.length > 0)) {
            throw incompleteCaptureError(selected);
          }
          return {
            browser: await Promise.all(
              selected.map((capture) => mainEvidence(capture.page)),
            ),
            responses: selected.flatMap((capture) => capture.responses),
            console: selected.flatMap((capture) => capture.console),
            externalRequests: selected.flatMap(
              (capture) => capture.externalRequests,
            ),
          };
        } finally {
          for (const capture of selected) captures.delete(capture);
        }
      },
    };
  }

  async function auditCount(
    action: string,
    resourceId?: string,
  ): Promise<number> {
    const result =
      resourceId === undefined
        ? await database.db.execute(sql`
          select count(*)::integer as count from audit_events where action = ${action}
        `)
        : await database.db.execute(sql`
          select count(*)::integer as count from audit_events
          where action = ${action} and resource_id = ${resourceId}
        `);
    const count = (result.rows[0] as { count?: unknown } | undefined)?.count;
    if (!Number.isInteger(count) || (count as number) < 0) {
      throw new Error("Financial audit count was invalid");
    }
    return count as number;
  }

  async function withWorkerClaimBarrier<Result>(
    action: () => Promise<Result>,
  ): Promise<Result> {
    const session = await workerControl.pause(deadlineSignal(10_000));
    const actionResult = await Promise.resolve()
      .then(action)
      .then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason: unknown) => ({ status: "rejected", reason }) as const,
      );
    const cleanupResult = await session.cleanup(deadlineSignal(10_000)).then(
      () => ({ status: "fulfilled" }) as const,
      (reason: unknown) => ({ status: "rejected", reason }) as const,
    );
    if (
      actionResult.status === "rejected" &&
      cleanupResult.status === "rejected"
    ) {
      throw new AggregateError(
        [actionResult.reason, cleanupResult.reason],
        "Financial worker pause and cleanup failed",
      );
    }
    if (actionResult.status === "rejected") throw actionResult.reason;
    if (cleanupResult.status === "rejected") throw cleanupResult.reason;
    return actionResult.value;
  }

  async function purchaserUserId(
    fixture: FinancialRefundFixture,
  ): Promise<string | null> {
    const result = await database.db.execute(sql`
      select coalesce(purchase.initiating_user_id, identity.claimed_by_user_id) as "userId"
      from orders purchase
      left join guest_identities identity on identity.id = purchase.guest_identity_id
      where purchase.id = ${fixture.orderId}
    `);
    const row = result.rows[0] as { userId?: unknown } | undefined;
    if (
      row === undefined ||
      (row.userId !== null && typeof row.userId !== "string")
    ) {
      throw new Error("Financial refund purchaser identity was invalid");
    }
    return row.userId ?? null;
  }

  async function readAccess(
    fixture: FinancialRefundFixture,
    titleId: string,
  ): Promise<boolean> {
    const userId = await purchaserUserId(fixture);
    if (userId === null) return false;
    const selected = await database.db
      .select({ id: entitlements.id })
      .from(entitlements)
      .where(
        sql`${entitlements.userId} = ${userId}
        and ${entitlements.titleId} = ${titleId}
        and ${entitlements.revokedAt} is null`,
      )
      .limit(1);
    return selected.length === 1;
  }

  async function readClaimState(
    fixture: FinancialRefundFixture,
  ): Promise<"unclaimed" | "claimed"> {
    if (fixture.purchaseOwner === "claimed-account") return "claimed";
    const result = await database.db.execute(sql`
      select purchase.initiating_user_id as "initiatingUserId",
        identity.claimed_by_user_id as "claimedByUserId",
        (identity.claimed_at is not null) as "claimedAtPresent",
        account.email as "accountEmail",
        account.email_verified as "emailVerified",
        (select count(*)::integer
         from order_items item
         where item.order_id = purchase.id) as "itemCount",
        (select count(*)::integer
         from entitlement_grants grant_row
         join order_items item on item.id = grant_row.order_item_id
         where item.order_id = purchase.id
           and grant_row.source = 'purchase') as "grantCount",
        (select count(*)::integer
         from entitlement_grants grant_row
         join order_items item on item.id = grant_row.order_item_id
         where item.order_id = purchase.id
           and grant_row.source = 'purchase'
           and grant_row.user_id is distinct from identity.claimed_by_user_id)
          as "mismatchedGrantCount",
        (select count(*)::integer
         from entitlement_grants grant_row
         join order_items item on item.id = grant_row.order_item_id
         where item.order_id = purchase.id
           and grant_row.source = 'purchase'
           and grant_row.state = 'unclaimed') as "unclaimedGrantCount"
      from orders purchase
      join guest_identities identity on identity.id = purchase.guest_identity_id
      left join "user" account on account.id = identity.claimed_by_user_id
      where purchase.id = ${fixture.orderId}
    `);
    const row = result.rows[0] as
      | {
          initiatingUserId: unknown;
          claimedByUserId: unknown;
          claimedAtPresent: unknown;
          accountEmail: unknown;
          emailVerified: unknown;
          itemCount: unknown;
          grantCount: unknown;
          mismatchedGrantCount: unknown;
          unclaimedGrantCount: unknown;
        }
      | undefined;
    if (row === undefined || row.initiatingUserId !== null) {
      throw new Error("Financial guest purchase identity was invalid");
    }
    if (row.claimedByUserId === null && row.claimedAtPresent === false) {
      if (
        row.itemCount !== 3 ||
        row.grantCount !== 3 ||
        row.mismatchedGrantCount !== 0
      ) {
        throw new Error("Financial guest purchase grants were invalid");
      }
      return "unclaimed";
    }
    if (
      typeof row.claimedByUserId !== "string" ||
      row.claimedAtPresent !== true ||
      row.accountEmail !== fixture.purchaserEmail ||
      row.accountEmail !== String(row.accountEmail).trim().toLowerCase() ||
      row.emailVerified !== true ||
      row.itemCount !== 3 ||
      row.grantCount !== 3 ||
      row.mismatchedGrantCount !== 0 ||
      row.unclaimedGrantCount !== 0
    ) {
      throw new Error("Financial guest claim transition was invalid");
    }
    const claimedByUserId = assertCanonicalUuid(
      row.claimedByUserId,
      "Financial claimed account ID",
    );
    const stored = refundFixtures.get(fixture.refundId);
    if (stored === undefined) {
      throw new Error("Financial refund fixture was lost");
    }
    if (!stored.browserPrivateValues.includes(claimedByUserId)) {
      stored.browserPrivateValues.push(claimedByUserId);
    }
    return "claimed";
  }

  async function readRefundState(
    fixture: FinancialRefundFixture,
  ): Promise<RefundState> {
    const [refund] = await database.db
      .select({ amountMinor: refunds.amountMinor })
      .from(refunds)
      .where(eq(refunds.id, fixture.refundId))
      .limit(1);
    if (!refund) throw new Error("Financial refund state was not found");

    const historical = await database.db
      .select({
        orderItemId: refundAllocationComponents.orderItemId,
        subtotalMinor: refundAllocationComponents.subtotalMinor,
        taxMinor: refundAllocationComponents.taxMinor,
      })
      .from(refundAllocationComponents)
      .where(eq(refundAllocationComponents.refundId, fixture.refundId));
    const historicalByTitleId: Record<string, number> = {};
    const accessByTitleId: Record<string, boolean> = {};
    const metricsByTitleId: Record<
      string,
      { refundPrincipalMinor: number; refundFeeImpactMinor: number }
    > = {};
    const titleByOrderItemId = new Map(
      Object.values(fixture.items).map((item) => [
        item.orderItemId,
        item.titleId,
      ]),
    );
    for (const item of Object.values(fixture.items)) {
      historicalByTitleId[item.titleId] = 0;
      accessByTitleId[item.titleId] = await readAccess(fixture, item.titleId);
      metricsByTitleId[item.titleId] = {
        refundPrincipalMinor: 0,
        refundFeeImpactMinor: 0,
      };
    }
    for (const component of historical) {
      const titleId = titleByOrderItemId.get(component.orderItemId);
      if (titleId !== undefined) {
        historicalByTitleId[titleId] =
          (historicalByTitleId[titleId] ?? 0) +
          component.subtotalMinor +
          component.taxMinor;
      }
    }

    const metricResult = await database.db.execute(sql`
      select projection.order_item_id as "orderItemId",
        coalesce(sum(projection.effect_minor) filter (
          where projection.component in ('refund_subtotal', 'refund_tax')
        ), 0)::integer as "refundPrincipalMinor",
        coalesce(sum(projection.effect_minor) filter (
          where projection.component = 'refund_fee'
        ), 0)::integer as "refundFeeImpactMinor"
      from current_financial_projection_items projection
      join financial_allocation_sets source_set
        on source_set.id = projection.base_set_id
      where source_set.source_kind = 'refund'
        and source_set.source_internal_id = ${fixture.refundId}
      group by projection.order_item_id
    `);
    for (const value of metricResult.rows as Array<{
      orderItemId: string;
      refundPrincipalMinor: number;
      refundFeeImpactMinor: number;
    }>) {
      const titleId = titleByOrderItemId.get(value.orderItemId);
      if (titleId !== undefined) {
        metricsByTitleId[titleId] = {
          refundPrincipalMinor: value.refundPrincipalMinor,
          refundFeeImpactMinor: value.refundFeeImpactMinor,
        };
      }
    }

    const correctionRows = await database.db
      .select({ id: refundReportingCorrectionSets.id })
      .from(refundReportingCorrectionSets)
      .where(eq(refundReportingCorrectionSets.refundId, fixture.refundId))
      .orderBy(refundReportingCorrectionSets.correctionVersion);
    const recoveryResult = await database.db.execute(sql`
      select grant_row.state
      from entitlement_grants grant_row
      join refund_allocations allocation
        on allocation.id = grant_row.recovery_refund_allocation_id
      where allocation.refund_id = ${fixture.refundId}
        and allocation.order_item_id = ${fixture.items.recoverable.orderItemId}
        and grant_row.source = 'administrative'
      order by grant_row.id
    `);
    const recoveryRows = recoveryResult.rows as Array<{ state: unknown }>;
    if (
      recoveryRows.length > 1 ||
      (recoveryRows[0] !== undefined &&
        recoveryRows[0].state !== "active" &&
        recoveryRows[0].state !== "revoked")
    ) {
      throw new Error("Financial recovery state was invalid");
    }

    return {
      providerRefundTotalMinor: refund.amountMinor,
      historicalRefundedMinorByTitleId: historicalByTitleId,
      effectiveAccessByTitleId: accessByTitleId,
      correctionSetIds: correctionRows.map((row) => row.id),
      financialMetricsByTitleId: metricsByTitleId,
      recoveryState:
        (recoveryRows[0]?.state as "active" | "revoked" | undefined) ?? null,
    };
  }

  async function readAuditEvidence(
    input: AuditEvidenceInput,
  ): Promise<AuditEvidence> {
    const fixtureAudit = fixtureAudits.get(input.refundId);
    if (fixtureAudit === undefined || input.commands.length === 0) {
      throw new Error("Financial audit evidence requires command references");
    }
    requireExactFinancialAuditActions(
      input.fixtureActions,
      fixtureAudit.signatures.map((signature) => signature.action),
    );
    const retainedCommandIdsForRefund = [...commandAudits.values()]
      .filter((command) => command.refundId === input.refundId)
      .map((command) => command.commandId);
    requireCompleteFinancialAuditCommandSelection(
      input.commands.map((command) => command.commandId),
      retainedCommandIdsForRefund,
    );
    const selectedCommandIds = new Set<string>();
    const selectedCommands: RetainedCommandAudit[] = [];
    for (const declaration of input.commands) {
      const commandId = assertCanonicalUuid(
        declaration.commandId,
        "Financial audit command ID",
      );
      const retained = commandAudits.get(commandId);
      if (
        selectedCommandIds.has(commandId) ||
        retained === undefined ||
        retained.refundId !== input.refundId
      ) {
        throw new Error("Financial command audit binding was not retained");
      }
      requireExactFinancialAuditActions(
        declaration.actions,
        retained.signatures.map((signature) => signature.action),
      );
      selectedCommandIds.add(commandId);
      selectedCommands.push(retained);
    }
    const selectedCorrelations = [
      fixtureAudit.setupCorrelationId,
      ...selectedCommands.map((command) => command.correlationId),
    ];
    if (new Set(selectedCorrelations).size !== selectedCorrelations.length) {
      throw new Error("Financial audit correlation authority was invalid");
    }
    const expectedSignatures = [
      ...fixtureAudit.signatures,
      ...selectedCommands.flatMap((command) => command.signatures),
    ];
    const expectedResourceIds = [
      ...new Set([
        input.refundId,
        ...selectedCommands.map((command) => command.commandId),
        ...expectedSignatures.flatMap((signature) =>
          signature.resourceId === null ? [] : [signature.resourceId],
        ),
      ]),
    ];
    const expectedActors = new Map<string, string>();
    for (const command of selectedCommands) {
      const current = expectedActors.get(command.actorId);
      if (current !== undefined && current !== command.actorLabel) {
        throw new Error("Financial audit actor authority was invalid");
      }
      expectedActors.set(command.actorId, command.actorLabel);
    }
    const selection = sql`(
      ${auditEvents.correlationId} in (${sql.join(
        selectedCorrelations.map((correlationId) => sql`${correlationId}`),
        sql`, `,
      )})
      or ${auditEvents.resourceId} in (${sql.join(
        expectedResourceIds.map((resourceId) => sql`${resourceId}`),
        sql`, `,
      )})
    )`;
    const rows = await database.db.transaction(
      async (transaction) => {
        const payloadBounds = await transaction
          .select({
            auditId: auditEvents.id,
            scalarsCharacterBounded: sql<boolean>`(
          char_length(${auditEvents.actorType}::text) <= ${MAX_AUDIT_TEXT_CHARACTERS}
          and coalesce(char_length(${auditEvents.actorId}), 0) <= ${MAX_AUDIT_TEXT_CHARACTERS}
          and char_length(${auditEvents.action}) <= ${MAX_AUDIT_TEXT_CHARACTERS}
          and char_length(${auditEvents.outcome}::text) <= ${MAX_AUDIT_TEXT_CHARACTERS}
          and char_length(${auditEvents.resourceType}) <= ${MAX_AUDIT_TEXT_CHARACTERS}
          and coalesce(char_length(${auditEvents.resourceId}), 0) <= ${MAX_AUDIT_TEXT_CHARACTERS}
          and char_length(${auditEvents.correlationId}) <= ${MAX_AUDIT_TEXT_CHARACTERS}
        )`,
            actorTypeBytes: sql<number>`octet_length(${auditEvents.actorType}::text)::integer`,
            actorIdBytes: sql<number>`coalesce(octet_length(${auditEvents.actorId}), 0)::integer`,
            actionBytes: sql<number>`octet_length(${auditEvents.action})::integer`,
            outcomeBytes: sql<number>`octet_length(${auditEvents.outcome}::text)::integer`,
            resourceTypeBytes: sql<number>`octet_length(${auditEvents.resourceType})::integer`,
            resourceIdBytes: sql<number>`coalesce(octet_length(${auditEvents.resourceId}), 0)::integer`,
            correlationIdBytes: sql<number>`octet_length(${auditEvents.correlationId})::integer`,
            requestMetadataBytes: sql<number>`greatest(
          coalesce(pg_column_size(${auditEvents.requestMetadata}), 0),
          coalesce(octet_length(${auditEvents.requestMetadata}::text), 0)
        )::integer`,
            beforeBytes: sql<number>`greatest(
          coalesce(pg_column_size(${auditEvents.before}), 0),
          coalesce(octet_length(${auditEvents.before}::text), 0)
        )::integer`,
            afterBytes: sql<number>`greatest(
          coalesce(pg_column_size(${auditEvents.after}), 0),
          coalesce(octet_length(${auditEvents.after}::text), 0)
        )::integer`,
          })
          .from(auditEvents)
          .where(selection)
          .orderBy(auditEvents.occurredAt, auditEvents.id)
          .limit(MAX_AUDIT_EVIDENCE_ROWS + 1);
        if (payloadBounds.length > MAX_AUDIT_EVIDENCE_ROWS) {
          throw new Error("Financial audit evidence exceeded its row bound");
        }
        if (
          payloadBounds.some(
            (row) =>
              !row.scalarsCharacterBounded ||
              [
                row.actorTypeBytes,
                row.actorIdBytes,
                row.actionBytes,
                row.outcomeBytes,
                row.resourceTypeBytes,
                row.resourceIdBytes,
                row.correlationIdBytes,
                row.requestMetadataBytes,
                row.beforeBytes,
                row.afterBytes,
              ].some(
                (bytes) =>
                  !Number.isSafeInteger(bytes) ||
                  bytes < 0 ||
                  bytes > MAX_AUDIT_JSON_BYTES,
              ),
          )
        ) {
          throw new Error(FINANCIAL_AUDIT_SHAPE_FAILURE);
        }
        const aggregatePayloadBytes = payloadBounds.reduce(
          (total, row) =>
            total +
            row.actorTypeBytes +
            row.actorIdBytes +
            row.actionBytes +
            row.outcomeBytes +
            row.resourceTypeBytes +
            row.resourceIdBytes +
            row.correlationIdBytes +
            row.requestMetadataBytes +
            row.beforeBytes +
            row.afterBytes,
          0,
        );
        if (
          !Number.isSafeInteger(aggregatePayloadBytes) ||
          aggregatePayloadBytes > MAX_AUDIT_PROJECTION_BYTES
        ) {
          throw new Error(FINANCIAL_AUDIT_SHAPE_FAILURE);
        }
        if (payloadBounds.length === 0) {
          throw new Error(FINANCIAL_AUDIT_MULTISET_FAILURE);
        }
        const rows = await transaction
          .select({
            auditId: auditEvents.id,
            actorType: auditEvents.actorType,
            actorId: auditEvents.actorId,
            action: auditEvents.action,
            outcome: auditEvents.outcome,
            resourceType: auditEvents.resourceType,
            resourceId: auditEvents.resourceId,
            correlationId: auditEvents.correlationId,
            requestMetadata: auditEvents.requestMetadata,
            before: auditEvents.before,
            after: auditEvents.after,
          })
          .from(auditEvents)
          .where(
            sql`${auditEvents.id} in (${sql.join(
              payloadBounds.map((row) => sql`${row.auditId}::uuid`),
              sql`, `,
            )})`,
          )
          .orderBy(auditEvents.occurredAt, auditEvents.id)
          .limit(MAX_AUDIT_EVIDENCE_ROWS + 1);
        if (
          rows.length !== payloadBounds.length ||
          rows.some(
            (row, index) => row.auditId !== payloadBounds[index]?.auditId,
          )
        ) {
          throw new Error(FINANCIAL_AUDIT_SHAPE_FAILURE);
        }
        return rows;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    const boundedRawRows = cloneBoundedFinancialAuditProjection(rows);
    assertPrivacyFirstFinancialAuditSignatures({
      boundedRawRows,
      privateValues: input.privateValues,
      expected: expectedSignatures,
      projectActual: (evidence) => {
        if (!Array.isArray(evidence)) {
          throw new Error(FINANCIAL_AUDIT_SHAPE_FAILURE);
        }
        return (evidence as readonly FinancialAuditRawRow[])
          .filter((row) => row.action !== "financial.refund_review.view")
          .map((row) => ({
            action: row.action,
            outcome: row.outcome,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            correlationId: row.correlationId,
            actorType: row.actorType,
            actorId: row.actorId,
          }));
      },
    });
    const boundedRows = boundedRawRows as readonly FinancialAuditRawRow[];
    const detailCountByActor = new Map<string, number>();
    for (const row of boundedRows) {
      if (row.action !== "financial.refund_review.view") continue;
      const actorLabel =
        row.actorId === null ? undefined : expectedActors.get(row.actorId);
      if (
        row.actorType !== "user" ||
        actorLabel === undefined ||
        row.outcome !== "succeeded" ||
        row.resourceType !== "refund" ||
        row.resourceId !== input.refundId ||
        !exactFinancialAuditJson(row.requestMetadata, {
          method: "GET",
          route: `/admin/sales/refunds/${input.refundId}`,
        }) ||
        row.before !== null ||
        row.after !== null
      ) {
        throw new Error("Financial audit detail-read evidence was invalid");
      }
      const count = (detailCountByActor.get(row.actorId!) ?? 0) + 1;
      if (count > 32) {
        throw new Error("Financial audit detail-read evidence was invalid");
      }
      detailCountByActor.set(row.actorId!, count);
    }
    if (
      [...expectedActors.keys()].some(
        (actorId) => (detailCountByActor.get(actorId) ?? 0) < 1,
      )
    ) {
      throw new Error("Financial audit detail-read evidence was invalid");
    }

    const commandByCorrelation = new Map(
      selectedCommands.map((command) => [command.correlationId, command]),
    );
    for (const row of boundedRows) {
      if (row.action === "financial.refund_review.view") continue;
      if (row.correlationId === fixtureAudit.setupCorrelationId) {
        const expectedAfter =
          row.action === "financial.classification.appended" &&
          row.resourceId === fixtureAudit.balanceClassificationId
            ? {
                subjectType: "balance_transaction",
                classification: "refund",
                classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
              }
            : row.action === "financial.classification.appended" &&
                row.resourceId === fixtureAudit.feeClassificationId
              ? {
                  subjectType: "fee_detail",
                  classification: "refund_fee",
                  classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
                }
              : row.action === "financial.balance_transaction.imported" &&
                  row.resourceId === fixtureAudit.balanceTransactionId
                ? {
                    disposition: "inserted",
                    status: "available",
                    amountMinor: -1_000,
                    feeMinor: 10,
                    netMinor: -1_010,
                    currency: "USD",
                    feeDetailCount: 1,
                  }
                : row.action === "financial.issue.opened" &&
                    row.resourceId === fixtureAudit.issueId
                  ? {
                      resourceType: "refund",
                      resourceId: fixtureAudit.refundId,
                      safeCode: "allocation_incomplete",
                      impact: "pending",
                      state: "open",
                      occurrenceCount: 1,
                    }
                  : undefined;
        if (
          expectedAfter === undefined ||
          row.requestMetadata !== null ||
          row.before !== null ||
          !exactFinancialAuditJson(row.after, expectedAfter)
        ) {
          throw new Error("Financial audit correctness payload was invalid");
        }
        continue;
      }
      const command = commandByCorrelation.get(row.correlationId);
      if (command === undefined || row.requestMetadata !== null) {
        throw new Error("Financial audit correctness payload was invalid");
      }
      if (
        row.action === "financial.admin_command.denied" ||
        row.action === "financial.admin_command.conflict" ||
        row.action === "financial.admin_command.failed"
      ) {
        if (
          row.before !== null ||
          !exactFinancialAuditJson(row.after, {
            commandKind: command.kind,
            safeResultCode: command.resultCode,
          })
        ) {
          throw new Error("Financial audit correctness payload was invalid");
        }
        continue;
      }
      if (row.action === "financial.issue.resolved") {
        if (
          row.before !== null ||
          !exactFinancialAuditJson(row.after, {
            resourceType: "refund",
            resourceId: fixtureAudit.refundId,
            safeCode: "allocation_incomplete",
            impact: "pending",
            state: "resolved",
            occurrenceCount: 1,
            commandId: command.commandId,
          })
        ) {
          throw new Error("Financial audit correctness payload was invalid");
        }
        continue;
      }
      if (row.action === "financial.refund_reconciled") {
        const after = financialAuditJsonRecord(row.after);
        const keys = after === null ? [] : Object.keys(after).sort();
        const expectedKeys = [
          "allocationItemCount",
          "allocationSetCount",
          "balanceTransactionCount",
          "financialEvidenceStatus",
          "orderId",
          "refundId",
        ];
        if (
          row.before !== null ||
          after === null ||
          keys.length !== expectedKeys.length ||
          keys.some((key, index) => key !== expectedKeys[index]) ||
          after.refundId !== fixtureAudit.refundId ||
          after.orderId !== fixtureAudit.orderId ||
          after.financialEvidenceStatus !== "fee_reconciled" ||
          [
            after.balanceTransactionCount,
            after.allocationSetCount,
            after.allocationItemCount,
          ].some(
            (count) =>
              !Number.isSafeInteger(count) ||
              (count as number) < 0 ||
              (count as number) > MAX_AUDIT_COLLECTION_ENTRIES,
          )
        ) {
          throw new Error("Financial audit correctness payload was invalid");
        }
        continue;
      }
      if (
        row.action === "financial.recovery_grant.activated" ||
        row.action === "financial.recovery_grant.deactivated"
      ) {
        if (
          row.before !== null ||
          !exactFinancialAuditJson(row.after, {
            commandId: command.commandId,
            recoveryGrantId: row.resourceId,
            state:
              row.action === "financial.recovery_grant.activated"
                ? "active"
                : "revoked",
          })
        ) {
          throw new Error("Financial audit correctness payload was invalid");
        }
        continue;
      }
      const payloadMatches = command.payloadExpectations.filter(
        (expectation) => expectation.action === row.action,
      );
      const payloadExpectation = payloadMatches[0];
      if (
        payloadMatches.length !== 1 ||
        payloadExpectation === undefined ||
        !exactFinancialAuditJson(row.before, payloadExpectation.before) ||
        !exactFinancialAuditJson(row.after, payloadExpectation.after)
      ) {
        throw new Error("Financial audit correctness payload was invalid");
      }
    }

    const detailReads = [...expectedActors.entries()]
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(([, actorLabel]) => ({
        action: "financial.refund_review.view",
        actorLabel,
      }));
    const domainActions: Array<{
      commandId: string;
      action: string;
      actorLabel: string;
    }> = [];
    const issueActions: Array<{
      commandId: string | null;
      action: string;
      actorLabel: string;
    }> = [
      {
        commandId: null,
        action: "financial.issue.opened",
        actorLabel: "financial-worker",
      },
    ];
    const reconciliationActions: Array<{
      commandId: string;
      action: string;
      actorLabel: "financial-worker";
    }> = [];
    const terminalCommands: Array<{
      commandId: string;
      action: string;
      outcome: string;
      actorLabel: string;
    }> = [];
    for (const command of selectedCommands) {
      for (const signature of command.signatures) {
        if (signature.action === "financial.issue.resolved") {
          issueActions.push({
            commandId: command.commandId,
            action: signature.action,
            actorLabel: command.actorLabel,
          });
        } else if (signature.action === "financial.refund_reconciled") {
          reconciliationActions.push({
            commandId: command.commandId,
            action: signature.action,
            actorLabel: "financial-worker",
          });
        } else if (signature.action.startsWith("financial.admin_command.")) {
          terminalCommands.push({
            commandId: command.commandId,
            action: signature.action,
            outcome: signature.outcome,
            actorLabel: command.actorLabel,
          });
        } else {
          domainActions.push({
            commandId: command.commandId,
            action: signature.action,
            actorLabel: command.actorLabel,
          });
        }
      }
    }
    return {
      rowCount: boundedRows.length,
      detailReads,
      domainActions,
      issueActions,
      reconciliationActions,
      terminalCommands,
    };
  }

  async function readEmailEvidence(
    fixture: FinancialRefundFixture,
  ): Promise<readonly EmailEvidence[]> {
    const mailpit = process.env.MAILPIT_HTTP_URL;
    if (mailpit === undefined) throw new Error("MAILPIT_HTTP_URL is required");
    const expectedCount =
      fixture.scenario === "recovery-persistence" ? 3 : 1;
    const messages = await conditionPoll({
      signal: deadlineSignal(20_000),
      description: "delivered financial access-change email evidence",
      read: async () => {
        const url = new URL("/api/v1/search", mailpit);
        url.searchParams.set("query", `to:"${fixture.purchaserEmail}"`);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Mailpit search failed with ${response.status}`);
        }
        const result = (await response.json()) as { messages?: unknown };
        if (!Array.isArray(result.messages)) {
          throw new Error("Mailpit search response was invalid");
        }
        return (result.messages as Array<Record<string, unknown>>)
          .filter(
            (message) =>
              (message.Subject ?? message.subject) ===
              "Your Pale Orbit library access changed",
          )
          .sort((left, right) =>
            String(left.Created ?? left.created).localeCompare(
              String(right.Created ?? right.created),
            ),
          );
      },
      complete: (selected) => selected.length >= expectedCount,
    });
    const evidence = await Promise.all(
      messages.map(async (message): Promise<EmailEvidence> => {
        const id = message.ID ?? message.id;
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/u.test(id)) {
          throw new Error("Mailpit message reference was invalid");
        }
        const response = await fetch(new URL(`/view/${id}.txt`, mailpit));
        if (!response.ok) {
          throw new Error(
            `Mailpit message read failed with ${response.status}`,
          );
        }
        const body = await response.text();
        if (body.includes("A completed refund changed your library access.")) {
          const affected = /Affected: (\d+) titles?\./u.exec(body)?.[1];
          if (affected === undefined) {
            throw new Error("Refund email aggregate was invalid");
          }
          return {
            template: "commerce.refund-access-changed",
            soldAsTitle: null,
            accessState: null,
            affectedTitleCount: Number.parseInt(affected, 10),
            body,
          };
        }
        const recovery = /Your access to (.+) is now (active|revoked)\./u.exec(
          body,
        );
        if (recovery?.[1] !== undefined && recovery[2] !== undefined) {
          const soldAsTitle = recovery[1].trim();
          if (soldAsTitle !== fixture.items.recoverable.soldAsTitle) {
            throw new Error("Recovery email title was invalid");
          }
          return {
            template: "commerce.administrative-recovery-access-changed",
            soldAsTitle,
            accessState: recovery[2],
            affectedTitleCount: null,
            body,
          };
        }
        throw new Error("Unexpected financial access-change email");
      }),
    );
    return evidence.sort((left, right) => {
      const rank = (message: EmailEvidence): number =>
        message.template === "commerce.refund-access-changed"
          ? 0
          : message.accessState === "active"
            ? 1
            : 2;
      return rank(left) - rank(right);
    });
  }

  async function completeGuestClaim(input: {
    readonly fixture: FinancialRefundFixture;
    readonly page: Page;
  }): Promise<void> {
    if (input.fixture.purchaseOwner !== "unclaimed-guest") {
      throw new Error(
        "Financial guest claim requires an unclaimed guest fixture",
      );
    }
    await input.page.goto("/claim");
    await input.page
      .getByLabel("Checkout email")
      .fill(input.fixture.purchaserEmail);
    await input.page.getByRole("button", { name: "Send claim link" }).click();
    await conditionPoll({
      signal: deadlineSignal(20_000),
      description: "generic guest claim request status",
      read: async () => {
        const status = input.page.getByRole("status");
        return (await status.count()) === 0 ? "" : await status.innerText();
      },
      complete: (text) => text.includes("If eligible purchases exist"),
    });
    const stored = refundFixtures.get(input.fixture.refundId);
    if (stored === undefined)
      throw new Error("Financial refund fixture was lost");
    let email: string;
    try {
      email = await waitForLatestTextEmail(
        input.fixture.purchaserEmail,
        30_000,
        "Claim your purchase",
      );
    } catch {
      throw new Error("Financial guest claim email was unavailable");
    }
    let claimLink: string;
    let claimProof: string;
    let action: string;
    let authToken: string;
    try {
      claimLink = firstHttpLink(email);
      const claimParameters = new URLSearchParams(
        new URL(claimLink).hash.slice(1),
      );
      const parsedClaimProof = claimParameters.get("proof");
      const parsedAction = claimParameters.get("action");
      if (parsedClaimProof === null || parsedAction === null) {
        throw new Error("invalid-claim-link");
      }
      const actionUrl = new URL(parsedAction);
      const parsedAuthToken =
        actionUrl.searchParams.get("token") ??
        actionUrl.pathname.match(
          /^\/api\/auth\/reset-password\/([A-Za-z0-9_-]{1,256})$/u,
        )?.[1] ??
        null;
      if (parsedAuthToken === null) throw new Error("invalid-claim-action");
      claimProof = parsedClaimProof;
      action = parsedAction;
      authToken = parsedAuthToken;
    } catch {
      throw new Error("Financial guest claim message was invalid");
    }
    stored.privateValues.push(claimLink, claimProof, action, authToken);
    stored.browserPrivateValues.push(claimLink, claimProof, action, authToken);
    await settlePageCaptures(input.page);
    try {
      await navigateSensitiveAction(input.page, claimLink);
    } catch {
      throw new Error("Financial guest claim navigation failed");
    }
    await conditionPoll({
      signal: deadlineSignal(20_000),
      description: "completed guest purchase claim",
      read: () =>
        input.page.getByRole("heading", { name: "Purchases claimed" }).count(),
      complete: (count) => count === 1,
    });
    await settlePageCaptures(input.page);
  }

  async function publishLaterRefundAndDispute(input: {
    readonly fixture: FinancialRefundFixture;
  }): Promise<void> {
    const stored = refundFixtures.get(input.fixture.refundId);
    if (stored === undefined)
      throw new Error("Financial refund fixture was lost");
    const laterRefundProviderId = privateProviderId("re");
    const laterDisputeProviderId = privateProviderId("dp");
    const refundEventId = privateProviderId("evt");
    const disputeEventId = privateProviderId("evt");
    stored.privateValues.push(
      laterRefundProviderId,
      laterDisputeProviderId,
      refundEventId,
      disputeEventId,
    );
    stored.browserPrivateValues.push(
      laterRefundProviderId,
      laterDisputeProviderId,
      refundEventId,
      disputeEventId,
    );
    const commerce = createCommerceHarness(database, origin, {
      financialE2EMode: true,
    });
    await commerce.fulfillRefund(input.fixture.orderId, {
      amountMinor: 500,
      providerRefundId: laterRefundProviderId,
      providerCreatedAt: new Date(`${FIXTURE_DAY}T15:00:00.000Z`),
      eventId: refundEventId,
    });
    await commerce.fulfillDispute(input.fixture.orderId, {
      state: "open",
      providerDisputeId: laterDisputeProviderId,
      providerCreatedAt: new Date(`${FIXTURE_DAY}T16:00:00.000Z`),
      eventId: disputeEventId,
    });
    const [laterRefund] = await database.db
      .select({ id: refunds.id })
      .from(refunds)
      .where(eq(refunds.stripeRefundId, laterRefundProviderId))
      .limit(1);
    const [laterDispute] = await database.db
      .select({ id: disputes.id })
      .from(disputes)
      .where(eq(disputes.stripeDisputeId, laterDisputeProviderId))
      .limit(1);
    if (laterRefund === undefined || laterDispute === undefined) {
      throw new Error("Later financial fixture publication was incomplete");
    }

    const gateway = createFixtureStripeGateway();
    const paidAt = new Date(`${FIXTURE_DAY}T12:00:00.000Z`);
    gateway.harness.setPayment(
      paymentSnapshotFixture({
        paymentIntentId: input.fixture.providerPaymentIntentId,
        metadataOrderId: input.fixture.orderId,
        latestChargeId: input.fixture.providerChargeId,
        amountMinor: 1_500,
        currency: "usd",
        paidAt,
      }),
    );
    gateway.harness.setCharge(
      chargeSnapshotFixture({
        id: input.fixture.providerChargeId,
        paymentIntentId: input.fixture.providerPaymentIntentId,
        amountMinor: 1_500,
        amountRefundedMinor: 1_500,
        currency: "USD",
        balanceTransactionId: null,
        createdAt: paidAt,
      }),
    );
    gateway.harness.setRefund(
      refundSnapshotFixture({
        providerRefundId: laterRefundProviderId,
        paymentIntentId: input.fixture.providerPaymentIntentId,
        amountMinor: 500,
        currency: "usd",
        providerCreatedAt: new Date(`${FIXTURE_DAY}T15:00:00.000Z`),
        balanceTransactionId: null,
      }),
    );
    gateway.harness.setDispute(
      disputeSnapshotFixture({
        providerDisputeId: laterDisputeProviderId,
        paymentIntentId: input.fixture.providerPaymentIntentId,
        chargeId: input.fixture.providerChargeId,
        state: "open",
        amountMinor: 1_500,
        currency: "usd",
        providerCreatedAt: new Date(`${FIXTURE_DAY}T16:00:00.000Z`),
        balanceTransactionIds: [],
      }),
    );
    const signal = new AbortController().signal;
    const refundResult = await reconcileRefundFinancialSource(
      database.workerDb,
      gateway.gateway,
      {
        refundId: laterRefund.id,
        correlationId: `e2e-later-refund-${laterRefund.id}`,
      },
      signal,
    );
    const disputeResult = await reconcileDisputeFinancialSource(
      database.workerDb,
      gateway.gateway,
      {
        disputeId: laterDispute.id,
        correlationId: `e2e-later-dispute-${laterDispute.id}`,
      },
      signal,
    );
    if (
      refundResult.status !== "pending" ||
      refundResult.safeCode !== "missing_source" ||
      disputeResult.status !== "pending" ||
      disputeResult.safeCode !== "missing_source"
    ) {
      throw new Error(
        "Later financial processing did not reach its safe pending state",
      );
    }
  }

  async function demoteAdministrator(input: {
    readonly target: FinancialAdministrator;
    readonly by: FinancialAdministrator;
  }): Promise<void> {
    pendingRestorations.set(input.target.userId, input);
    await setAdministratorRole({ ...input, enabled: false });
  }

  async function restoreAdministrator(input: {
    readonly target: FinancialAdministrator;
    readonly by: FinancialAdministrator;
  }): Promise<void> {
    await setAdministratorRole({ ...input, enabled: true });
    pendingRestorations.delete(input.target.userId);
  }

  async function navigationAbortEvidence(
    commandId: string,
  ): Promise<NavigationAbortEvidence> {
    const observation = navigationObservations.get(commandId);
    if (observation === undefined || observation.navigationAt === null) {
      return {
        observationComplete: false,
        initialPageStatusRequestCount: 0,
        pageStatusRequestsAfterNavigation: 0,
        pendingRequestAborted: false,
      };
    }
    const initial = observation.requestsAtNavigation ?? 0;
    const complete = Date.now() - observation.navigationAt >= 750;
    if (complete && observation.onRequest !== null) {
      observation.page.off("request", observation.onRequest);
      observation.onRequest = null;
    }
    return {
      observationComplete: complete,
      initialPageStatusRequestCount: initial,
      pageStatusRequestsAfterNavigation: observation.statusRequests - initial,
      pendingRequestAborted: complete && observation.statusRequests === initial,
    };
  }

  async function inSalesOwnerTransaction<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const client = database.ownerFixtureClient;
    await client.query("begin");
    try {
      const result = await operation();
      await client.query("commit");
      return result;
    } catch (error: unknown) {
      try {
        await client.query("rollback");
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "Financial Sales fixture and rollback failed",
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }

  function salesSlug(label: string): string {
    const safeLabel = label
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-|-$/gu, "");
    return `sales-${safeLabel}-${compactUuid()}`;
  }

  async function createSalesTitle(
    label: string,
    input: Readonly<{
      currentTitle: string;
      format?: SalesTitleFormat;
      visibility?: SalesTitleVisibility;
    }>,
  ): Promise<SalesTitleSeed> {
    const id = randomUUID();
    const format = input.format ?? "prose";
    const visibility = input.visibility ?? "private";
    await database.ownerFixtureClient.query(
      `insert into titles
         (id, slug, title, description, creator_name, format, price_minor,
          currency, visibility)
       values ($1, $2, $3, 'Financial Sales browser fixture',
               'Financial Sales Creator', $4, 100, 'USD', $5)`,
      [id, salesSlug(label), input.currentTitle, format, visibility],
    );
    return { id, currentTitle: input.currentTitle, format, visibility };
  }

  async function createSalesPurchase(
    label: string,
    input: Readonly<{
      paidAt: Date;
      currency: string;
      items: readonly SalesPurchaseItemInput[];
      financialEvidenceStatus: SalesFinancialEvidenceStatus;
    }>,
  ): Promise<SalesPurchaseSeed> {
    const client = database.ownerFixtureClient;
    const buyerId = randomUUID();
    const buyerEmail = `${privateProviderId(`sales_${label}_buyer`).toLowerCase()}@example.test`;
    const orderId = randomUUID();
    const paymentId = randomUUID();
    const checkoutAttemptId = randomUUID();
    const quoteFingerprintSha256 = `${compactUuid()}${compactUuid()}`;
    const statusTokenSha256 = `${compactUuid()}${compactUuid()}`;
    if (statusTokenSha256 === quoteFingerprintSha256) {
      throw new Error("Financial Sales purchase digest canaries collided");
    }
    const paymentIntentProviderId = privateProviderId(`sales_${label}_intent`);
    const chargeProviderId = privateProviderId(`sales_${label}_charge`);
    const subtotalMinor = input.items.reduce(
      (total, item) => total + item.subtotalMinor,
      0,
    );
    const privateValues = [
      buyerEmail,
      buyerId,
      orderId,
      paymentId,
      checkoutAttemptId,
      quoteFingerprintSha256,
      statusTokenSha256,
      paymentIntentProviderId,
      chargeProviderId,
    ];

    await client.query(
      `insert into "user" (id, name, email, email_verified)
       values ($1, $2, $3, true)`,
      [buyerId, `Financial Sales ${label} buyer`, buyerEmail],
    );
    await client.query(
      `insert into orders
         (id, status, initiating_user_id, purchase_email, currency,
          subtotal_minor, tax_minor, total_minor, client_checkout_attempt_id,
          quote_fingerprint_sha256, status_token_sha256, paid_at)
       values ($1, 'paid', $2, $3, $4, $5, 0, $5, $6,
               $7, $8, $9)`,
      [
        orderId,
        buyerId,
        buyerEmail,
        input.currency,
        subtotalMinor,
        checkoutAttemptId,
        quoteFingerprintSha256,
        statusTokenSha256,
        input.paidAt,
      ],
    );

    const items: SalesPurchaseItemSeed[] = [];
    for (const item of input.items) {
      const id = randomUUID();
      const lineItemProviderId = privateProviderId(`sales_${label}_line`);
      await client.query(
        `insert into order_items
           (id, order_id, title_id, title_snapshot, creator_name_snapshot,
            format, currency, unit_subtotal_minor, tax_minor, total_minor,
            stripe_line_item_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 0, $8, $9)`,
        [
          id,
          orderId,
          item.title.id,
          item.titleSnapshot,
          item.creatorNameSnapshot,
          item.format,
          input.currency,
          item.subtotalMinor,
          lineItemProviderId,
        ],
      );
      privateValues.push(id, lineItemProviderId);
      items.push({ ...item, id });
    }

    await client.query(
      `insert into payments
         (id, order_id, stripe_payment_intent_id, stripe_latest_charge_id,
          status, amount_minor, currency, payment_method_category, paid_at,
          financial_evidence_status)
       values ($1, $2, $3, $4, 'succeeded', $5, $6, 'card', $7, $8)`,
      [
        paymentId,
        orderId,
        paymentIntentProviderId,
        chargeProviderId,
        subtotalMinor,
        input.currency,
        input.paidAt,
        input.financialEvidenceStatus,
      ],
    );
    return {
      orderId,
      paymentId,
      chargeProviderId,
      paymentIntentProviderId,
      buyerEmail,
      items,
      privateValues,
    };
  }

  async function insertSalesAllocationSet(
    evidence: Readonly<{
      balanceTransactionId: string;
      sourceKind: SalesFinancialSourceKind;
      sourceInternalId: string;
      currency: string;
      fingerprint: string;
    }>,
    basis: "gross_amount" | "fee",
    expectedEffectMinor: number,
    items: readonly SalesAllocationItemInput[],
    reversalOfSetId: string | null = null,
  ): Promise<SalesAllocationSetSeed> {
    const client = database.ownerFixtureClient;
    const effectSum = items.reduce(
      (total, item) => total + item.effectMinor,
      0,
    );
    if (effectSum !== expectedEffectMinor) {
      throw new Error("Financial Sales allocation items did not balance");
    }
    const allocationSetId = randomUUID();
    const allocationIdentity = privateProviderId("sales_allocation");
    const privateValues = [allocationSetId, allocationIdentity];
    await client.query(
      `insert into financial_allocation_sets
         (id, allocation_identity, balance_transaction_id, source_kind,
          source_internal_id, basis, scope, expected_effect_minor, currency,
          algorithm_version, classifier_version, source_fingerprint_sha256,
          reversal_of_set_id)
       values ($1, $2, $3, $4, $5, $6, 'title', $7, $8, 2, 1, $9, $10)`,
      [
        allocationSetId,
        allocationIdentity,
        evidence.balanceTransactionId,
        evidence.sourceKind,
        evidence.sourceInternalId,
        basis,
        expectedEffectMinor,
        evidence.currency,
        evidence.fingerprint,
        reversalOfSetId,
      ],
    );
    for (const item of items) {
      const tieBreakKey = privateProviderId("sales_tie");
      await client.query(
        `insert into financial_item_allocations
           (allocation_set_id, order_item_id, component, effect_minor,
            currency, tie_break_key)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          allocationSetId,
          item.orderItemId,
          item.component,
          item.effectMinor,
          evidence.currency,
          tieBreakKey,
        ],
      );
      privateValues.push(tieBreakKey);
    }
    return { id: allocationSetId, privateValues };
  }

  async function createSalesBalanceEvidence(
    label: string,
    input: SalesBalanceEvidenceInput,
  ): Promise<SalesBalanceEvidenceSeed> {
    const client = database.ownerFixtureClient;
    const feeDetails = input.feeDetails ?? [];
    if (
      input.feeMinor < 0 ||
      feeDetails.some((detail) => detail.amountMinor < 0) ||
      feeDetails.reduce((total, detail) => total + detail.amountMinor, 0) !==
        input.feeMinor
    ) {
      throw new Error("Financial Sales provider fee evidence was invalid");
    }
    const balanceTransactionId = randomUUID();
    const providerId = privateProviderId(`sales_${label}_balance`);
    const fingerprint = compactUuid().repeat(2);
    const privateValues = [balanceTransactionId, providerId, fingerprint];
    await client.query(
      `insert into stripe_balance_transactions
         (id, provider_id, live_mode, source_family, source_id, raw_type,
          reporting_category, balance_type, amount_minor, fee_minor, net_minor,
          currency, status, provider_created_at, available_at, exchange_rate,
          exchange_source_currency, exchange_target_currency, fingerprint_sha256)
       values ($1, $2, false, $3, $4, $5, $5, 'payments', $6, $7, $8,
               $9, 'available', '2026-08-02T00:00:00.000Z',
               '2026-08-03T00:00:00.000Z', $10, $11, $12, $13)`,
      [
        balanceTransactionId,
        providerId,
        input.sourceFamily,
        input.providerSourceId,
        input.parentClassification,
        input.amountMinor,
        input.feeMinor,
        input.amountMinor - input.feeMinor,
        input.currency,
        input.exchangeRate ?? null,
        input.exchangeSourceCurrency ?? null,
        input.exchangeRate === undefined ? null : input.currency,
        fingerprint,
      ],
    );
    await client.query(
      `insert into financial_classification_versions
         (subject_type, subject_id, classifier_version, classification,
          source_fingerprint_sha256)
       values ('balance_transaction', $1, 1, $2, $3)`,
      [balanceTransactionId, input.parentClassification, fingerprint],
    );
    for (const [ordinal, detail] of feeDetails.entries()) {
      const detailId = randomUUID();
      const detailFingerprint = compactUuid().repeat(2);
      await client.query(
        `insert into stripe_balance_transaction_fee_details
           (id, balance_transaction_id, ordinal, raw_type, amount_minor,
            currency, fingerprint_sha256)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          detailId,
          balanceTransactionId,
          ordinal,
          detail.rawType,
          detail.amountMinor,
          input.currency,
          detailFingerprint,
        ],
      );
      await client.query(
        `insert into financial_classification_versions
           (subject_type, subject_id, classifier_version, classification,
            source_fingerprint_sha256)
         values ('fee_detail', $1, 1, $2, $3)`,
        [detailId, detail.classification, detailFingerprint],
      );
      privateValues.push(detailId, detailFingerprint);
    }

    const allocationEvidence = {
      balanceTransactionId,
      sourceKind: input.sourceKind,
      sourceInternalId: input.sourceInternalId,
      currency: input.currency,
      fingerprint,
    };
    const grossAllocation =
      input.grossItems === null
        ? { id: null, privateValues: [] as readonly string[] }
        : await insertSalesAllocationSet(
            allocationEvidence,
            "gross_amount",
            input.amountMinor,
            input.grossItems,
            input.grossReversalOfSetId ?? null,
          );
    const feeAllocation =
      input.feeItems === null
        ? { id: null, privateValues: [] as readonly string[] }
        : await insertSalesAllocationSet(
            allocationEvidence,
            "fee",
            -input.feeMinor,
            input.feeItems,
          );
    return {
      balanceTransactionId,
      grossAllocationSetId: grossAllocation.id,
      feeAllocationSetId: feeAllocation.id,
      providerId,
      privateValues: [
        ...privateValues,
        ...grossAllocation.privateValues,
        ...feeAllocation.privateValues,
      ],
    };
  }

  async function insertSalesPayout(
    input: Readonly<{
      providerId: string;
      amountMinor: number;
      automatic: boolean;
      method: "standard" | "instant";
      status: "pending" | "paid" | "failed";
      reconciliationStatus: "completed" | "in_progress" | "not_applicable";
      financialGeneration: number;
      providerCreatedAt: Date;
      failureBalanceTransactionId?: string;
      safeFailureCode?: string;
    }>,
  ): Promise<SalesPayoutSeed> {
    const payoutId = randomUUID();
    const fingerprint = compactUuid().repeat(2);
    await database.ownerFixtureClient.query(
      `insert into stripe_payouts
         (id, provider_id, live_mode, amount_minor, currency, automatic, method,
          status, reconciliation_status, provider_created_at, arrival_at,
          retrieved_at, failure_balance_transaction_id, safe_failure_code,
          financial_generation, fingerprint_sha256)
       values ($1, $2, false, $3, 'USD', $4, $5, $6, $7,
               $8::timestamptz, $8::timestamptz + interval '1 day',
               $8::timestamptz + interval '1 hour', $9, $10, $11,
               $12)`,
      [
        payoutId,
        input.providerId,
        input.amountMinor,
        input.automatic,
        input.method,
        input.status,
        input.reconciliationStatus,
        input.providerCreatedAt,
        input.failureBalanceTransactionId ?? null,
        input.safeFailureCode ?? null,
        input.financialGeneration,
        fingerprint,
      ],
    );
    return { id: payoutId, privateValues: [fingerprint] };
  }

  async function publishSalesPayoutMembership(
    payoutId: string,
    membershipGeneration: number,
    balanceTransactionIds: readonly string[],
  ): Promise<readonly string[]> {
    const runId = randomUUID();
    const startingFinancialGeneration = membershipGeneration - 1;
    await database.ownerFixtureClient.query(
      `insert into payout_import_runs
         (id, payout_id, generation, state, candidate_count, page_count,
          safe_outcome, started_at, updated_at, completed_at)
       values ($1, $2, $3, 'published', $4, 1, 'published',
               '2026-08-11T00:00:00.000Z', '2026-08-11T01:00:00.000Z',
               '2026-08-11T01:00:00.000Z')`,
      [
        runId,
        payoutId,
        startingFinancialGeneration,
        balanceTransactionIds.length,
      ],
    );
    for (const balanceTransactionId of balanceTransactionIds) {
      await database.ownerFixtureClient.query(
        `insert into payout_import_run_entries
           (run_id, balance_transaction_id)
         values ($1, $2)`,
        [runId, balanceTransactionId],
      );
      await database.ownerFixtureClient.query(
        `insert into stripe_payout_balance_transactions
           (payout_id, balance_transaction_id, published_from_run_id)
         values ($1, $2, $3)`,
        [payoutId, balanceTransactionId, runId],
      );
    }
    return [runId] as const;
  }

  async function seedSalesReportingMatrix(): Promise<SalesReportingFixture> {
    await ensureProjectionAuthority();
    return inSalesOwnerTransaction(async () => {
      const client = database.ownerFixtureClient;
      const privateValues: string[] = [];
      const publicCohortSuffix = `E2E-${compactUuid()}`;
      const cohortTitle = (title: string): string =>
        `${title} [${publicCohortSuffix}]`;
      const rememberPurchase = (purchase: SalesPurchaseSeed): void => {
        privateValues.push(...purchase.privateValues);
      };
      const rememberEvidence = (evidence: SalesBalanceEvidenceSeed): void => {
        privateValues.push(...evidence.privateValues);
      };
      const rememberPayout = (payout: SalesPayoutSeed): string => {
        privateValues.push(...payout.privateValues);
        return payout.id;
      };

      const archivedTitle = await createSalesTitle("archived-atlas", {
        currentTitle: cohortTitle("Archived Atlas"),
        format: "prose",
        visibility: "archived",
      });
      const fxTitle = await createSalesTitle("euro-window", {
        currentTitle: cohortTitle("Euro Window"),
      });
      const knownZeroTitle = await createSalesTitle("known-zero", {
        currentTitle: cohortTitle("Known Zero"),
      });
      const incompleteTitle = await createSalesTitle("incomplete-evidence", {
        currentTitle: cohortTitle("Incomplete Evidence"),
      });
      const settlementPendingTitle = await createSalesTitle(
        "settlement-pending",
        { currentTitle: cohortTitle("Settlement Pending") },
      );
      const exceptionTitle = await createSalesTitle("exception-ledger", {
        currentTitle: cohortTitle("Exception Ledger"),
      });
      const payoutTitle = await createSalesTitle("payout-reconciled", {
        currentTitle: cohortTitle("Payout Reconciled"),
      });
      const fillerTitles: SalesTitleSeed[] = [];
      for (let index = 0; index < 45; index += 1) {
        const suffix = String(index).padStart(2, "0");
        fillerTitles.push(
          await createSalesTitle(`filler-${suffix}`, {
            currentTitle: cohortTitle(`Filler ${suffix}`),
          }),
        );
      }

      const soldAsTitle = "The Archived Atlas";
      const soldAsCreator = "Historical Atlas Creator";
      const archivedPurchases: SalesPurchaseSeed[] = [];
      for (const [index, subtotalMinor] of [1_000, 1_000, 500].entries()) {
        const purchase = await createSalesPurchase(`archived_${index}`, {
          paidAt: new Date("2026-08-01T12:00:00.000Z"),
          currency: "USD",
          financialEvidenceStatus: "fee_reconciled",
          items: [
            {
              title: archivedTitle,
              titleSnapshot: soldAsTitle,
              creatorNameSnapshot: soldAsCreator,
              format: "comic",
              subtotalMinor,
            },
          ],
        });
        rememberPurchase(purchase);
        archivedPurchases.push(purchase);
      }
      const archivedItems = archivedPurchases.map(
        (purchase) => purchase.items[0]!,
      );
      for (const [index, purchase] of archivedPurchases.entries()) {
        const feeMinor = index === 2 ? 27 : 30;
        const feeItems: SalesAllocationItemInput[] = [
          {
            orderItemId: archivedItems[index]!.id,
            component: "processing_fee",
            effectMinor: -30,
          },
        ];
        if (index === 2) {
          feeItems.push({
            orderItemId: archivedItems[index]!.id,
            component: "other",
            effectMinor: 3,
          });
        }
        const evidence = await createSalesBalanceEvidence(`archived_${index}`, {
          sourceKind: "payment",
          sourceInternalId: purchase.paymentId,
          sourceFamily: "charge",
          providerSourceId: purchase.chargeProviderId,
          parentClassification: "charge",
          amountMinor: index === 2 ? 500 : 900,
          feeMinor,
          currency: "USD",
          grossItems: [
            {
              orderItemId: archivedItems[index]!.id,
              component: "sale_subtotal",
              effectMinor: index === 2 ? 500 : 900,
            },
          ],
          feeItems,
          feeDetails: [
            {
              rawType: "stripe_fee",
              amountMinor: feeMinor,
              classification: "processing_fee",
            },
          ],
        });
        rememberEvidence(evidence);
      }

      const refundedPurchase = archivedPurchases[2]!;
      const refundedItem = archivedItems[2]!;
      const refundId = randomUUID();
      const refundProviderId = privateProviderId("sales_refund");
      const refundAllocationId = randomUUID();
      privateValues.push(refundId, refundProviderId, refundAllocationId);
      await client.query(
        `insert into refunds
           (id, payment_id, stripe_refund_id, status, amount_minor, currency,
            reason, provider_created_at, allocation_status,
            financial_evidence_status)
         values ($1, $2, $3, 'succeeded', 500, 'USD',
                 'requested_by_customer', '2026-08-02T10:00:00.000Z',
                 'finalized', 'fee_reconciled')`,
        [refundId, refundedPurchase.paymentId, refundProviderId],
      );
      await client.query(
        `insert into refund_allocations
           (id, refund_id, order_item_id, amount_minor, source)
         values ($1, $2, $3, 500, 'administrative')`,
        [refundAllocationId, refundId, refundedItem.id],
      );
      await client.query(
        `insert into refund_allocation_components
           (refund_allocation_id, refund_id, order_item_id, subtotal_minor,
            tax_minor, total_minor, currency)
         values ($1, $2, $3, 500, 0, 500, 'USD')`,
        [refundAllocationId, refundId, refundedItem.id],
      );
      const refundEvidence = await createSalesBalanceEvidence(
        "archived_refund",
        {
          sourceKind: "refund",
          sourceInternalId: refundId,
          sourceFamily: "refund",
          providerSourceId: refundProviderId,
          parentClassification: "refund",
          amountMinor: -460,
          feeMinor: 0,
          currency: "USD",
          grossItems: [
            {
              orderItemId: refundedItem.id,
              component: "refund_subtotal",
              effectMinor: -460,
            },
            {
              orderItemId: refundedItem.id,
              component: "refund_tax",
              effectMinor: -10,
            },
            {
              orderItemId: refundedItem.id,
              component: "fee_credit",
              effectMinor: 10,
            },
          ],
          feeItems: [],
        },
      );
      rememberEvidence(refundEvidence);

      const disputeId = randomUUID();
      const disputeProviderId = privateProviderId("sales_dispute");
      privateValues.push(disputeId, disputeProviderId);
      await client.query(
        `insert into disputes
           (id, payment_id, stripe_dispute_id, status, amount_minor, currency,
            reason, provider_created_at, provider_updated_at,
            financial_evidence_status)
         values ($1, $2, $3, 'won', 200, 'USD', 'fraudulent',
                 '2026-08-02T11:00:00.000Z', '2026-08-03T11:00:00.000Z',
                 'fee_reconciled')`,
        [disputeId, refundedPurchase.paymentId, disputeProviderId],
      );
      const withdrawalEvidence = await createSalesBalanceEvidence(
        "archived_dispute_withdrawal",
        {
          sourceKind: "dispute",
          sourceInternalId: disputeId,
          sourceFamily: "dispute",
          providerSourceId: disputeProviderId,
          parentClassification: "dispute_withdrawal",
          amountMinor: -188,
          feeMinor: 15,
          currency: "USD",
          grossItems: [
            {
              orderItemId: refundedItem.id,
              component: "dispute_subtotal",
              effectMinor: -188,
            },
          ],
          feeItems: [
            {
              orderItemId: refundedItem.id,
              component: "dispute_fee",
              effectMinor: -15,
            },
          ],
          feeDetails: [
            {
              rawType: "dispute_fee",
              amountMinor: 15,
              classification: "dispute_fee",
            },
          ],
        },
      );
      rememberEvidence(withdrawalEvidence);
      const withdrawalAllocationId = randomUUID();
      const withdrawalAllocationIdentity = privateProviderId(
        "sales_dispute_presentment",
      );
      const reinstatementAllocationIdentity = privateProviderId(
        "sales_dispute_presentment",
      );
      privateValues.push(
        withdrawalAllocationId,
        withdrawalAllocationIdentity,
        reinstatementAllocationIdentity,
      );
      await client.query(
        `insert into dispute_item_allocations
           (id, allocation_identity, dispute_id, gross_allocation_set_id,
            order_item_id, effect, subtotal_effect_minor, tax_effect_minor,
            total_effect_minor, currency)
         values ($1, $2, $3, $4, $5, 'withdrawal', -200, 0, -200, 'USD')`,
        [
          withdrawalAllocationId,
          withdrawalAllocationIdentity,
          disputeId,
          withdrawalEvidence.grossAllocationSetId,
          refundedItem.id,
        ],
      );
      const reinstatementEvidence = await createSalesBalanceEvidence(
        "archived_dispute_reinstatement",
        {
          sourceKind: "dispute",
          sourceInternalId: disputeId,
          sourceFamily: "dispute",
          providerSourceId: disputeProviderId,
          parentClassification: "dispute_reinstatement",
          amountMinor: 50,
          feeMinor: 0,
          currency: "USD",
          grossItems: [
            {
              orderItemId: refundedItem.id,
              component: "dispute_reinstatement",
              effectMinor: 50,
            },
          ],
          feeItems: [],
          grossReversalOfSetId: withdrawalEvidence.grossAllocationSetId!,
        },
      );
      rememberEvidence(reinstatementEvidence);
      await client.query(
        `insert into dispute_item_allocations
           (allocation_identity, dispute_id, gross_allocation_set_id,
            order_item_id, effect, reverses_allocation_id,
            subtotal_effect_minor, tax_effect_minor, total_effect_minor,
            currency)
         values ($1, $2, $3, $4, 'reinstatement', $5, 50, 0, 50, 'USD')`,
        [
          reinstatementAllocationIdentity,
          disputeId,
          reinstatementEvidence.grossAllocationSetId,
          refundedItem.id,
          withdrawalAllocationId,
        ],
      );

      const fxPurchase = await createSalesPurchase("fx", {
        paidAt: new Date("2026-08-01T13:00:00.000Z"),
        currency: "EUR",
        financialEvidenceStatus: "fee_reconciled",
        items: [
          {
            title: fxTitle,
            titleSnapshot: "Euro Window First Edition",
            creatorNameSnapshot: "European Fixture Creator",
            format: "prose",
            subtotalMinor: 1_500,
          },
        ],
      });
      rememberPurchase(fxPurchase);
      const fxItem = fxPurchase.items[0]!;
      const fxEvidence = await createSalesBalanceEvidence("fx", {
        sourceKind: "payment",
        sourceInternalId: fxPurchase.paymentId,
        sourceFamily: "charge",
        providerSourceId: fxPurchase.chargeProviderId,
        parentClassification: "charge",
        amountMinor: 1_650,
        feeMinor: 60,
        currency: "USD",
        grossItems: [
          {
            orderItemId: fxItem.id,
            component: "sale_subtotal",
            effectMinor: 1_650,
          },
        ],
        feeItems: [
          {
            orderItemId: fxItem.id,
            component: "processing_fee",
            effectMinor: -60,
          },
        ],
        feeDetails: [
          {
            rawType: "stripe_fee",
            amountMinor: 60,
            classification: "processing_fee",
          },
        ],
        exchangeRate: "1.100000000000000000",
        exchangeSourceCurrency: "EUR",
      });
      rememberEvidence(fxEvidence);

      const knownZeroPurchase = await createSalesPurchase("known_zero", {
        paidAt: new Date("2026-08-10T10:00:00.000Z"),
        currency: "USD",
        financialEvidenceStatus: "fee_reconciled",
        items: [
          {
            title: knownZeroTitle,
            titleSnapshot: "Known Zero",
            creatorNameSnapshot: "Zero Fixture Creator",
            format: "prose",
            subtotalMinor: 0,
          },
        ],
      });
      rememberPurchase(knownZeroPurchase);
      const knownZeroEvidence = await createSalesBalanceEvidence("known_zero", {
        sourceKind: "payment",
        sourceInternalId: knownZeroPurchase.paymentId,
        sourceFamily: "charge",
        providerSourceId: knownZeroPurchase.chargeProviderId,
        parentClassification: "charge",
        amountMinor: 0,
        feeMinor: 0,
        currency: "USD",
        grossItems: [
          {
            orderItemId: knownZeroPurchase.items[0]!.id,
            component: "sale_subtotal",
            effectMinor: 0,
          },
        ],
        feeItems: [],
      });
      rememberEvidence(knownZeroEvidence);

      const incompletePurchase = await createSalesPurchase("incomplete", {
        paidAt: new Date("2026-08-10T11:00:00.000Z"),
        currency: "USD",
        financialEvidenceStatus: "pending",
        items: [
          {
            title: incompleteTitle,
            titleSnapshot: "Incomplete Evidence",
            creatorNameSnapshot: "Pending Fixture Creator",
            format: "prose",
            subtotalMinor: 400,
          },
        ],
      });
      rememberPurchase(incompletePurchase);
      const incompleteItem = incompletePurchase.items[0]!;
      const incompleteCharge = await createSalesBalanceEvidence(
        "incomplete_charge",
        {
          sourceKind: "payment",
          sourceInternalId: incompletePurchase.paymentId,
          sourceFamily: "charge",
          providerSourceId: incompletePurchase.chargeProviderId,
          parentClassification: "charge",
          amountMinor: 400,
          feeMinor: 10,
          currency: "USD",
          grossItems: [
            {
              orderItemId: incompleteItem.id,
              component: "sale_subtotal",
              effectMinor: 400,
            },
          ],
          feeItems: null,
          feeDetails: [
            {
              rawType: "stripe_fee",
              amountMinor: 10,
              classification: "processing_fee",
            },
          ],
        },
      );
      rememberEvidence(incompleteCharge);
      const pendingRefundId = randomUUID();
      const pendingRefundProviderId = privateProviderId("sales_pending_refund");
      privateValues.push(pendingRefundId, pendingRefundProviderId);
      await client.query(
        `insert into refunds
           (id, payment_id, stripe_refund_id, status, amount_minor, currency,
            reason, provider_created_at, allocation_status,
            financial_evidence_status)
         values ($1, $2, $3, 'pending', 50, 'USD',
                 'requested_by_customer', '2026-08-10T12:00:00.000Z',
                 'not_applicable', 'pending')`,
        [
          pendingRefundId,
          incompletePurchase.paymentId,
          pendingRefundProviderId,
        ],
      );
      const incompleteRefund = await createSalesBalanceEvidence(
        "incomplete_refund",
        {
          sourceKind: "refund",
          sourceInternalId: pendingRefundId,
          sourceFamily: "refund",
          providerSourceId: pendingRefundProviderId,
          parentClassification: "refund",
          amountMinor: -50,
          feeMinor: 0,
          currency: "USD",
          grossItems: [
            {
              orderItemId: incompleteItem.id,
              component: "refund_subtotal",
              effectMinor: -50,
            },
          ],
          feeItems: null,
        },
      );
      rememberEvidence(incompleteRefund);

      const settlementPendingPurchase = await createSalesPurchase(
        "settlement_pending",
        {
          paidAt: new Date("2026-08-10T12:00:00.000Z"),
          currency: "USD",
          financialEvidenceStatus: "pending",
          items: [
            {
              title: settlementPendingTitle,
              titleSnapshot: "Settlement Pending",
              creatorNameSnapshot: "Pending Fixture Creator",
              format: "prose",
              subtotalMinor: 300,
            },
          ],
        },
      );
      rememberPurchase(settlementPendingPurchase);

      const exceptionPurchase = await createSalesPurchase("exception", {
        paidAt: new Date("2026-08-10T13:00:00.000Z"),
        currency: "USD",
        financialEvidenceStatus: "exception",
        items: [
          {
            title: exceptionTitle,
            titleSnapshot: "Exception Ledger",
            creatorNameSnapshot: "Exception Fixture Creator",
            format: "prose",
            subtotalMinor: 200,
          },
        ],
      });
      rememberPurchase(exceptionPurchase);
      const exceptionEvidence = await createSalesBalanceEvidence("exception", {
        sourceKind: "payment",
        sourceInternalId: exceptionPurchase.paymentId,
        sourceFamily: "charge",
        providerSourceId: exceptionPurchase.chargeProviderId,
        parentClassification: "charge",
        amountMinor: 200,
        feeMinor: 0,
        currency: "USD",
        grossItems: [
          {
            orderItemId: exceptionPurchase.items[0]!.id,
            component: "sale_subtotal",
            effectMinor: 200,
          },
        ],
        feeItems: [],
      });
      rememberEvidence(exceptionEvidence);

      const payoutPurchase = await createSalesPurchase("payout", {
        paidAt: new Date("2026-08-10T14:00:00.000Z"),
        currency: "USD",
        financialEvidenceStatus: "fee_reconciled",
        items: [
          {
            title: payoutTitle,
            titleSnapshot: "Payout Reconciled",
            creatorNameSnapshot: "Payout Fixture Creator",
            format: "prose",
            subtotalMinor: 150,
          },
        ],
      });
      rememberPurchase(payoutPurchase);
      const payoutEvidence = await createSalesBalanceEvidence("payout", {
        sourceKind: "payment",
        sourceInternalId: payoutPurchase.paymentId,
        sourceFamily: "charge",
        providerSourceId: payoutPurchase.chargeProviderId,
        parentClassification: "charge",
        amountMinor: 150,
        feeMinor: 0,
        currency: "USD",
        grossItems: [
          {
            orderItemId: payoutPurchase.items[0]!.id,
            component: "sale_subtotal",
            effectMinor: 150,
          },
        ],
        feeItems: [],
      });
      rememberEvidence(payoutEvidence);

      const fillerPurchase = await createSalesPurchase("fillers", {
        paidAt: new Date("2026-08-10T15:00:00.000Z"),
        currency: "USD",
        financialEvidenceStatus: "fee_reconciled",
        items: fillerTitles.map((title, index) => ({
          title,
          titleSnapshot: title.currentTitle,
          creatorNameSnapshot: "Filler Fixture Creator",
          format: "prose",
          subtotalMinor: 100 + index,
        })),
      });
      rememberPurchase(fillerPurchase);
      const fillerGrossItems = fillerPurchase.items.map((item) => ({
        orderItemId: item.id,
        component: "sale_subtotal" as const,
        effectMinor: item.subtotalMinor,
      }));
      const fillerEvidence = await createSalesBalanceEvidence("fillers", {
        sourceKind: "payment",
        sourceInternalId: fillerPurchase.paymentId,
        sourceFamily: "charge",
        providerSourceId: fillerPurchase.chargeProviderId,
        parentClassification: "charge",
        amountMinor: fillerGrossItems.reduce(
          (total, item) => total + item.effectMinor,
          0,
        ),
        feeMinor: 0,
        currency: "USD",
        grossItems: fillerGrossItems,
        feeItems: [],
      });
      rememberEvidence(fillerEvidence);

      const pendingPayoutProviderId = privateProviderId("sales_payout_pending");
      const completedPayoutProviderId = privateProviderId(
        "sales_payout_completed",
      );
      const failedPayoutProviderId = privateProviderId("sales_payout_failed");
      const manualPayoutProviderId = privateProviderId("sales_payout_manual");
      const instantPayoutProviderId = privateProviderId("sales_payout_instant");
      privateValues.push(
        pendingPayoutProviderId,
        completedPayoutProviderId,
        failedPayoutProviderId,
        manualPayoutProviderId,
        instantPayoutProviderId,
      );
      const pendingPayoutId = rememberPayout(
        await insertSalesPayout({
          providerId: pendingPayoutProviderId,
          amountMinor: 100,
          automatic: true,
          method: "standard",
          status: "pending",
          reconciliationStatus: "in_progress",
          financialGeneration: 0,
          providerCreatedAt: new Date("2026-08-06T00:00:00.000Z"),
        }),
      );
      const completedPayoutFinancialGeneration = 1;
      const completedPayoutId = rememberPayout(
        await insertSalesPayout({
          providerId: completedPayoutProviderId,
          amountMinor: 150,
          automatic: true,
          method: "standard",
          status: "paid",
          reconciliationStatus: "completed",
          financialGeneration: completedPayoutFinancialGeneration,
          providerCreatedAt: new Date("2026-08-07T00:00:00.000Z"),
        }),
      );
      privateValues.push(
        ...(await publishSalesPayoutMembership(
          completedPayoutId,
          completedPayoutFinancialGeneration,
          [payoutEvidence.balanceTransactionId],
        )),
      );

      const failureBalanceTransactionId = randomUUID();
      const failureBalanceProviderId = privateProviderId(
        "sales_payout_failure_balance",
      );
      const failureBalanceFingerprint = compactUuid().repeat(2);
      privateValues.push(
        failureBalanceTransactionId,
        failureBalanceProviderId,
        failureBalanceFingerprint,
      );
      await client.query(
        `insert into stripe_balance_transactions
           (id, provider_id, live_mode, source_family, source_id, raw_type,
            reporting_category, balance_type, amount_minor, fee_minor, net_minor,
            currency, status, provider_created_at, available_at,
            fingerprint_sha256)
         values ($1, $2, false, 'payout', $3, 'payout_failure', 'payout',
                 'payments', -150, 0, -150, 'USD', 'available',
                 '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z', $4)`,
        [
          failureBalanceTransactionId,
          failureBalanceProviderId,
          failedPayoutProviderId,
          failureBalanceFingerprint,
        ],
      );
      const failedPayoutFinancialGeneration = 2;
      const failedPayoutMembershipGeneration = 1;
      const failedPayoutId = rememberPayout(
        await insertSalesPayout({
          providerId: failedPayoutProviderId,
          amountMinor: 150,
          automatic: true,
          method: "standard",
          status: "failed",
          reconciliationStatus: "completed",
          financialGeneration: failedPayoutFinancialGeneration,
          providerCreatedAt: new Date("2026-08-08T00:00:00.000Z"),
          failureBalanceTransactionId,
          safeFailureCode: "provider_failed",
        }),
      );
      privateValues.push(
        ...(await publishSalesPayoutMembership(
          failedPayoutId,
          failedPayoutMembershipGeneration,
          [],
        )),
      );
      const manualPayoutId = rememberPayout(
        await insertSalesPayout({
          providerId: manualPayoutProviderId,
          amountMinor: 100,
          automatic: false,
          method: "standard",
          status: "paid",
          reconciliationStatus: "not_applicable",
          financialGeneration: 0,
          providerCreatedAt: new Date("2026-08-09T00:00:00.000Z"),
        }),
      );
      const instantPayoutId = rememberPayout(
        await insertSalesPayout({
          providerId: instantPayoutProviderId,
          amountMinor: 100,
          automatic: true,
          method: "instant",
          status: "paid",
          reconciliationStatus: "not_applicable",
          financialGeneration: 0,
          providerCreatedAt: new Date("2026-08-10T00:00:00.000Z"),
        }),
      );

      const issueId = randomUUID();
      const issueCorrelationId = privateProviderId("sales_issue");
      privateValues.push(issueCorrelationId);
      await client.query(
        `insert into financial_reconciliation_issues
           (id, resource_type, resource_id, safe_code, state, impact,
            first_observed_at, last_observed_at, occurrence_count, correlation_id)
         values ($1, 'payment', $2, 'immutable_mismatch', 'open', 'exception',
                 '2026-08-11T02:00:00.000Z', '2026-08-11T02:00:00.000Z',
                 1, $3)`,
        [issueId, exceptionPurchase.paymentId, issueCorrelationId],
      );

      const dummyBalanceTransactionId = randomUUID();
      const dummyBalanceProviderId = privateProviderId(
        "sales_excluded_balance",
      );
      const dummyFingerprint = compactUuid().repeat(2);
      const supersededAllocationId = randomUUID();
      const inactiveClassificationId = randomUUID();
      const supersededAllocationIdentity = privateProviderId(
        "sales_excluded_allocation",
      );
      const successorAllocationIdentity = privateProviderId(
        "sales_excluded_allocation_successor",
      );
      const excludedAllocationCorrelationId = privateProviderId(
        "sales_excluded_allocation_issue",
      );
      const excludedClassificationCorrelationId = privateProviderId(
        "sales_excluded_classification_issue",
      );
      const excludedAllocationIssueId = randomUUID();
      const excludedClassificationIssueId = randomUUID();
      privateValues.push(
        dummyBalanceTransactionId,
        dummyBalanceProviderId,
        dummyFingerprint,
        supersededAllocationId,
        inactiveClassificationId,
        supersededAllocationIdentity,
        successorAllocationIdentity,
        excludedAllocationCorrelationId,
        excludedClassificationCorrelationId,
      );
      await client.query(
        `insert into stripe_balance_transactions
           (id, provider_id, live_mode, raw_type, reporting_category,
            balance_type, amount_minor, fee_minor, net_minor, currency, status,
            provider_created_at, available_at, fingerprint_sha256)
         values ($1, $2, false, 'charge', 'charge', 'payments', 100, 0, 100,
                 'USD', 'available', '2026-08-10T00:00:00.000Z',
                 '2026-08-10T00:00:00.000Z', $3)`,
        [dummyBalanceTransactionId, dummyBalanceProviderId, dummyFingerprint],
      );
      await client.query(
        `insert into financial_classification_versions
           (subject_type, subject_id, classifier_version, classification,
            source_fingerprint_sha256)
         values ('balance_transaction', $1, 1, 'charge', $2)`,
        [dummyBalanceTransactionId, dummyFingerprint],
      );
      await client.query(
        `insert into financial_allocation_sets
           (id, allocation_identity, balance_transaction_id, source_kind,
            source_internal_id, basis, scope, expected_effect_minor, currency,
            algorithm_version, classifier_version, source_fingerprint_sha256)
         values ($1, $2, $3, 'adjustment', $3, 'gross_amount', 'account',
                 100, 'USD', 2, 1, $4)`,
        [
          supersededAllocationId,
          supersededAllocationIdentity,
          dummyBalanceTransactionId,
          dummyFingerprint,
        ],
      );
      await client.query(
        `insert into financial_allocation_sets
           (allocation_identity, balance_transaction_id, source_kind,
            source_internal_id, basis, scope, expected_effect_minor, currency,
            algorithm_version, classifier_version, source_fingerprint_sha256,
            supersedes_set_id)
         values ($1, $2, 'adjustment', $2, 'gross_amount', 'account',
                 100, 'USD', 2, 1, $3, $4)`,
        [
          successorAllocationIdentity,
          dummyBalanceTransactionId,
          dummyFingerprint,
          supersededAllocationId,
        ],
      );
      await client.query(
        `insert into financial_reconciliation_issues
           (id, resource_type, resource_id, safe_code, state, impact,
            first_observed_at, last_observed_at, occurrence_count, correlation_id)
         values ($1, 'allocation_set', $2, 'allocation_mismatch', 'open', 'exception',
                 '2026-08-11T03:00:00.000Z', '2026-08-11T03:00:00.000Z',
                 1, $3)`,
        [
          excludedAllocationIssueId,
          supersededAllocationId,
          excludedAllocationCorrelationId,
        ],
      );
      await client.query(
        `insert into financial_classification_versions
           (id, subject_type, subject_id, classifier_version, classification,
            source_fingerprint_sha256)
         values ($1, 'balance_transaction', $2, 2, 'unknown', $3)`,
        [inactiveClassificationId, dummyBalanceTransactionId, dummyFingerprint],
      );
      await client.query(
        `insert into financial_reconciliation_issues
           (id, resource_type, resource_id, safe_code, state, impact,
            first_observed_at, last_observed_at, occurrence_count, correlation_id)
         values ($1, 'financial_classification', $2, 'unsupported_category',
                 'open', 'exception', '2026-08-11T04:00:00.000Z',
                 '2026-08-11T04:00:00.000Z', 1, $3)`,
        [
          excludedClassificationIssueId,
          inactiveClassificationId,
          excludedClassificationCorrelationId,
        ],
      );

      const sourceFreshnessRootKey = privateProviderId(
        "sales_source_freshness",
      );
      const projectionFreshnessRootKey = privateProviderId(
        "sales_projection_freshness",
      );
      privateValues.push(sourceFreshnessRootKey, projectionFreshnessRootKey);
      await client.query(
        `insert into financial_payout_discovery_state
           (singleton, covered_through, updated_at)
         values (true, '2026-08-12T13:00:00.000Z',
                 '2026-08-12T13:00:00.000Z')
         on conflict (singleton) do update
         set covered_through = excluded.covered_through,
             updated_at = excluded.updated_at`,
      );
      await client.query(
        `insert into financial_scan_runs
           (root_key, kind, phase, state, payout_discovery_created_gte,
            payout_discovery_created_lt, processed_count, enqueued_count,
            page_count, safe_outcome, started_at, updated_at, completed_at)
         values ($1, 'hourly', 'incomplete_payout_run_page', 'completed',
                 '2026-08-01T00:00:00.000Z', '2026-08-13T00:00:00.000Z',
                 1, 0, 1, 'completed', '2026-08-12T11:00:00.000Z',
                 '2026-08-12T12:00:00.000Z', '2026-08-12T12:00:00.000Z')`,
        [sourceFreshnessRootKey],
      );
      await client.query(
        `insert into financial_scan_runs
           (root_key, kind, phase, state, classifier_version,
            allocation_algorithm_version, replay_id, processed_count,
            enqueued_count, page_count, safe_outcome, started_at, updated_at,
            completed_at)
         values ($1, 'classification_replay', 'classification_replay_finalize',
                 'completed', 1, 2, 'c1-a2', 1, 0, 1, 'completed',
                 '2026-08-12T13:00:00.000Z', '2026-08-12T14:00:00.000Z',
                 '2026-08-12T14:00:00.000Z')`,
        [projectionFreshnessRootKey],
      );

      const fillerTitlesByDescendingGross = [...fillerTitles]
        .reverse()
        .map((title) => title.currentTitle);
      const publicCohortTitles = [
        archivedTitle,
        fxTitle,
        knownZeroTitle,
        incompleteTitle,
        settlementPendingTitle,
        exceptionTitle,
        payoutTitle,
        ...fillerTitles,
      ].map((title) => title.currentTitle);
      return {
        firstPageRowCount: 50,
        overviewRowCount: 52,
        privateValues: [...new Set(privateValues)],
        publicCohort: {
          suffix: publicCohortSuffix,
          titles: publicCohortTitles,
        },
        titles: {
          archived: {
            id: archivedTitle.id,
            currentTitle: archivedTitle.currentTitle,
            soldAsTitle,
            soldAsCreator,
          },
          fx: { id: fxTitle.id, currentTitle: fxTitle.currentTitle },
          knownZero: {
            id: knownZeroTitle.id,
            currentTitle: knownZeroTitle.currentTitle,
          },
          incomplete: {
            id: incompleteTitle.id,
            currentTitle: incompleteTitle.currentTitle,
          },
        },
        filterWindow: {
          from: "2026-08-01",
          to: "2026-08-01",
          expectedTitles: [archivedTitle.currentTitle, fxTitle.currentTitle],
        },
        expectedFilterTitles: {
          comic: [archivedTitle.currentTitle],
          pending: [
            incompleteTitle.currentTitle,
            settlementPendingTitle.currentTitle,
          ],
          feeReconciled: [
            archivedTitle.currentTitle,
            fxTitle.currentTitle,
            ...fillerTitlesByDescendingGross,
            knownZeroTitle.currentTitle,
          ],
          payoutReconciled: [payoutTitle.currentTitle],
          exception: [exceptionTitle.currentTitle],
          settlementPending: [settlementPendingTitle.currentTitle],
        },
        pagination: { secondPageMarker: payoutTitle.currentTitle },
        issue: {
          id: issueId,
          resourceId: exceptionPurchase.paymentId,
          safeCode: "immutable_mismatch",
          safeReason:
            "Stored financial evidence conflicts with its immutable record.",
          excludedIssueIds: [
            excludedAllocationIssueId,
            excludedClassificationIssueId,
          ],
        },
        payouts: {
          pending: { id: pendingPayoutId },
          completedAutomatic: { id: completedPayoutId },
          failedAfterPaid: {
            id: failedPayoutId,
            safeFailureCode: "provider_failed",
          },
          manual: { id: manualPayoutId },
          instant: { id: instantPayoutId },
        },
      };
    });
  }

  function onceSalesCleanup(
    operation: () => Promise<void>,
  ): () => Promise<void> {
    let cleanup: Promise<void> | null = null;
    return () => {
      cleanup ??= operation();
      return cleanup;
    };
  }

  async function cleanupSalesExportSeed(
    buyerId: string,
    titleSlugPrefix: string,
  ): Promise<void> {
    await inSalesOwnerTransaction(async () => {
      const client = database.ownerFixtureClient;
      await client.query(
        `delete from payments
         where order_id in (
           select id from orders where initiating_user_id = $1
         )`,
        [buyerId],
      );
      await client.query(
        `delete from order_items
         where order_id in (
           select id from orders where initiating_user_id = $1
         )`,
        [buyerId],
      );
      await client.query("delete from orders where initiating_user_id = $1", [
        buyerId,
      ]);
      await client.query("delete from titles where slug like $1 || $2", [
        titleSlugPrefix,
        "%",
      ]);
      await client.query('delete from "user" where id = $1', [buyerId]);
    });
  }

  async function seedSalesExportBound(
    kind: "rows" | "bytes" | "deadline",
  ): Promise<SalesExportBound> {
    const client = database.ownerFixtureClient;
    if (kind === "deadline") {
      await client.query("begin");
      try {
        await client.query(
          `select pg_advisory_xact_lock(
             hashtext('pale-orbit:user-roles:admin')
           )`,
        );
      } catch (error: unknown) {
        try {
          await client.query("rollback");
        } catch (rollbackError: unknown) {
          throw new AggregateError(
            [error, rollbackError],
            "Financial Sales deadline fixture and rollback failed",
            { cause: rollbackError },
          );
        }
        throw error;
      }
      return {
        exportPath: "/admin/sales/export.csv?range=all&sort=title_asc",
        privateValues: [],
        close: onceSalesCleanup(async () => {
          await client.query("rollback");
        }),
      };
    }

    const buyerId = randomUUID();
    const buyerEmail = `${privateProviderId(`sales_export_${kind}_buyer`).toLowerCase()}@example.test`;
    const titleSlugPrefix = `${salesSlug(`export-${kind}`)}-`;
    const paymentIntentPrefix = privateProviderId(
      `sales_export_${kind}_intent`,
    );
    const lineItemPrefix = privateProviderId(`sales_export_${kind}_line`);
    const quoteFingerprint = (kind === "rows" ? "c" : "e").repeat(64);
    const statusTokenHash = (kind === "rows" ? "d" : "f").repeat(64);
    const readSalesExportPrivateValues = async (
      expectedOrderCount: number,
      expectedItemCount: number,
    ): Promise<readonly string[]> => {
      if (
        !Number.isSafeInteger(expectedOrderCount) ||
        expectedOrderCount < 1 ||
        !Number.isSafeInteger(expectedItemCount) ||
        expectedItemCount < 1
      ) {
        throw new Error("Financial Sales export private evidence was invalid");
      }
      const rows = (
        await client.query<{
          orderId: string;
          checkoutAttemptId: string;
          paymentId: string;
          orderItemId: string;
        }>(
          `select o.id::text as "orderId",
             o.client_checkout_attempt_id::text as "checkoutAttemptId",
             p.id::text as "paymentId",
             oi.id::text as "orderItemId"
           from orders o
           inner join payments p on p.order_id = o.id
           inner join order_items oi on oi.order_id = o.id
           where o.initiating_user_id = $1
           order by o.id, p.id, oi.id
           limit $2`,
          [buyerId, expectedItemCount + 1],
        )
      ).rows;
      const orderIds = new Set(rows.map((row) => row.orderId));
      const checkoutAttemptIds = new Set(
        rows.map((row) => row.checkoutAttemptId),
      );
      const paymentIds = new Set(rows.map((row) => row.paymentId));
      const orderItemIds = new Set(rows.map((row) => row.orderItemId));
      const privateValues = [
        buyerId,
        ...orderIds,
        ...checkoutAttemptIds,
        ...paymentIds,
        ...orderItemIds,
      ];
      if (
        rows.length !== expectedItemCount ||
        orderIds.size !== expectedOrderCount ||
        checkoutAttemptIds.size !== expectedOrderCount ||
        paymentIds.size !== expectedOrderCount ||
        orderItemIds.size !== expectedItemCount ||
        privateValues.some(
          (value) => !UUID_PATTERN.test(value) || value !== value.toLowerCase(),
        )
      ) {
        throw new Error("Financial Sales export private evidence was invalid");
      }
      return privateValues;
    };

    if (kind === "rows") {
      const orderId = randomUUID();
      const checkoutAttemptId = randomUUID();
      const backingPrivateValues = await inSalesOwnerTransaction(async () => {
        await client.query(
          `create temporary table sales_export_rows_seed on commit drop as
           select series as ordinal, gen_random_uuid() as title_id
           from generate_series(1, 10001) series`,
        );
        await client.query(
          `insert into "user" (id, name, email, email_verified)
           values ($1, 'Financial Sales row-bound buyer', $2, true)`,
          [buyerId, buyerEmail],
        );
        await client.query(
          `insert into titles
             (id, slug, title, description, creator_name, format, price_minor,
              currency, visibility)
           select title_id, $1 || ordinal::text,
             'Sales row bound ' || lpad(ordinal::text, 5, '0'),
             'Financial Sales row-bound fixture',
             'Financial Sales Export Creator', 'prose', 1, 'AED', 'private'
           from sales_export_rows_seed`,
          [titleSlugPrefix],
        );
        await client.query(
          `insert into orders
             (id, status, initiating_user_id, purchase_email, currency,
              subtotal_minor, tax_minor, total_minor,
              client_checkout_attempt_id, quote_fingerprint_sha256,
              status_token_sha256, paid_at)
           values ($1, 'paid', $2, $3, 'AED', 10001, 0, 10001, $4,
                   $5, $6,
                   '2026-08-10T00:00:00.000Z')`,
          [
            orderId,
            buyerId,
            buyerEmail,
            checkoutAttemptId,
            quoteFingerprint,
            statusTokenHash,
          ],
        );
        await client.query(
          `insert into order_items
             (id, order_id, title_id, title_snapshot,
              creator_name_snapshot, format, currency, unit_subtotal_minor,
              tax_minor, total_minor, stripe_line_item_id)
           select gen_random_uuid(), $1, title_id,
             'Sales row bound ' || lpad(ordinal::text, 5, '0'),
             'Financial Sales Export Creator', 'prose', 'AED', 1, 0, 1,
             $2 || '_' || ordinal::text
           from sales_export_rows_seed`,
          [orderId, lineItemPrefix],
        );
        await client.query(
          `insert into payments
             (order_id, stripe_payment_intent_id, status, amount_minor,
              currency, payment_method_category, paid_at,
              financial_evidence_status)
           values ($1, $2, 'succeeded', 10001, 'AED', 'card',
                   '2026-08-10T00:00:00.000Z', 'pending')`,
          [orderId, paymentIntentPrefix],
        );
        return readSalesExportPrivateValues(1, 10_001);
      });
      await client.query("analyze titles, orders, order_items, payments");
      return {
        exportPath:
          "/admin/sales/export.csv?range=all&presentmentCurrency=AED&sort=title_asc",
        privateValues: [
          ...backingPrivateValues,
          buyerEmail,
          paymentIntentPrefix,
          lineItemPrefix,
          quoteFingerprint,
          statusTokenHash,
        ],
        close: onceSalesCleanup(() =>
          cleanupSalesExportSeed(buyerId, titleSlugPrefix),
        ),
      };
    }

    const backingPrivateValues = await inSalesOwnerTransaction(async () => {
      await client.query(
        `create temporary table sales_export_bytes_titles on commit drop as
         select series as ordinal, gen_random_uuid() as title_id
         from generate_series(1, 60) series`,
      );
      await client.query(
        `create temporary table sales_export_bytes_orders on commit drop as
         select series as ordinal, gen_random_uuid() as order_id,
           gen_random_uuid() as checkout_id
         from generate_series(1, 100) series`,
      );
      await client.query(
        `insert into "user" (id, name, email, email_verified)
         values ($1, 'Financial Sales byte-bound buyer', $2, true)`,
        [buyerId, buyerEmail],
      );
      await client.query(
        `insert into titles
           (id, slug, title, description, creator_name, format, price_minor,
             currency, visibility)
         select title_id, $1 || ordinal::text,
           'Sales byte bound ' || lpad(ordinal::text, 4, '0'),
           'Financial Sales byte-bound fixture',
           'Financial Sales Export Creator', 'prose', 1, 'AUD', 'private'
         from sales_export_bytes_titles`,
        [titleSlugPrefix],
      );
      await client.query(
        `insert into orders
           (id, status, initiating_user_id, purchase_email, currency,
            subtotal_minor, tax_minor, total_minor,
            client_checkout_attempt_id, quote_fingerprint_sha256,
            status_token_sha256, paid_at)
         select order_id, 'paid', $1, $2, 'AUD', 60, 0, 60, checkout_id,
           $3, $4,
           '2026-08-10T00:00:00.000Z'
         from sales_export_bytes_orders`,
        [buyerId, buyerEmail, quoteFingerprint, statusTokenHash],
      );
      await client.query(
        `insert into order_items
           (id, order_id, title_id, title_snapshot, creator_name_snapshot,
            format, currency, unit_subtotal_minor, tax_minor, total_minor,
            stripe_line_item_id)
         select gen_random_uuid(), seed_order.order_id, seed_title.title_id,
           repeat('"', 300),
           repeat('"', 264) || lpad(seed_order.ordinal::text, 36, '0'),
           'prose', 'AUD', 1, 0, 1,
           $1 || '_' || seed_order.ordinal::text || '_' || seed_title.ordinal::text
         from sales_export_bytes_orders seed_order
         cross join sales_export_bytes_titles seed_title`,
        [lineItemPrefix],
      );
      await client.query(
        `insert into payments
           (order_id, stripe_payment_intent_id, status, amount_minor,
            currency, payment_method_category, paid_at,
            financial_evidence_status)
         select order_id, $1 || '_' || ordinal::text, 'succeeded', 60,
           'AUD', 'card', '2026-08-10T00:00:00.000Z', 'pending'
         from sales_export_bytes_orders`,
        [paymentIntentPrefix],
      );
      return readSalesExportPrivateValues(100, 6_000);
    });
    await client.query("analyze titles, orders, order_items, payments");
    return {
      exportPath:
        "/admin/sales/export.csv?range=all&presentmentCurrency=AUD&sort=title_asc",
      privateValues: [
        ...backingPrivateValues,
        buyerEmail,
        paymentIntentPrefix,
        lineItemPrefix,
        quoteFingerprint,
        statusTokenHash,
      ],
      close: onceSalesCleanup(() =>
        cleanupSalesExportSeed(buyerId, titleSlugPrefix),
      ),
    };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try {
      await restorePendingAdministrators();
    } catch (error: unknown) {
      failures.push(error);
    }
    const captureResults = await Promise.allSettled(
      [...captures].map(async (capture) => {
        await capture.close();
        if (capture.failures.length > 0) {
          throw incompleteCaptureError([capture]);
        }
      }),
    );
    for (const result of captureResults) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    captures.clear();
    for (const observation of navigationObservations.values()) {
      if (observation.onRequest !== null) {
        observation.page.off("request", observation.onRequest);
        observation.onRequest = null;
      }
    }
    const contexts = [
      ...administrators.map((entry) => entry.context),
      ...(bootstrapContext === null ? [] : [bootstrapContext]),
    ];
    const settled = await Promise.allSettled(
      contexts.map((context) => context.close()),
    );
    for (const result of settled)
      if (result.status === "rejected") failures.push(result.reason);
    if (failures.length > 0)
      throw new AggregateError(failures, "Financial harness cleanup failed");
  }

  return {
    promoteAdministrators,
    createRefundFixture,
    runCommand,
    withWorkerClaimBarrier,
    seedSalesReportingMatrix,
    seedSalesExportBound,
    auditCount,
    capturePrivacy,
    captureFinancialArtifacts,
    readAccess,
    readClaimState,
    readRefundState,
    readAuditEvidence,
    readEmailEvidence,
    completeGuestClaim,
    publishLaterRefundAndDispute,
    demoteAdministrator,
    restoreAdministrator,
    navigationAbortEvidence,
    close,
  };
}
