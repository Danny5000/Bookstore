import { createHash } from 'node:crypto';
import { allocateFeeDetails } from '$lib/server/commerce/financial/allocations/common';
import { allocateSignedLargestRemainder } from '$lib/server/commerce/financial/allocations/largest-remainder';
import { PermanentFinancialError } from '$lib/server/commerce/financial/errors';
import type { FinancialComponent } from '$lib/server/commerce/financial/types';
import type {
  RefundCorrectionItemPreviewDto,
  RefundReportingCorrectionPreviewDto
} from '$lib/types/financial-reporting';
import type { ReportingCorrectionPrepareInput } from './inputs';

const SAFE_MONEY_MAX = 99_999_999;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

export interface RefundReportingCorrectionPlanItemFacts {
  readonly orderItemId: string;
  readonly titleId: string;
  readonly soldAsTitle: string;
  readonly paidSubtotalMinor: number;
  readonly paidTaxMinor: number;
  readonly paidTotalMinor: number;
  readonly effectiveSiblingSubtotalMinor: number;
  readonly effectiveSiblingTaxMinor: number;
  readonly immutablePresentmentSubtotalMinor: number;
  readonly immutablePresentmentTaxMinor: number;
  readonly immutableSettlementSubtotalMinor: number | null;
  readonly immutableSettlementTaxMinor: number | null;
  readonly immutableRefundFeeImpactMinor: number | null;
  readonly compatiblePresentmentSubtotalMinor: number | null;
  readonly compatiblePresentmentTaxMinor: number | null;
  readonly compatibleSettlementSubtotalMinor: number | null;
  readonly compatibleSettlementTaxMinor: number | null;
  readonly compatibleRefundFeeImpactMinor: number | null;
}

export interface RefundReportingCorrectionPlanInput {
  readonly request: ReportingCorrectionPrepareInput;
  readonly activeProjection: {
    readonly classifierVersion: number;
    readonly allocationAlgorithmVersion: number;
    readonly replayId: string;
  };
  readonly currentReportingComplete: boolean;
  readonly rawTip: {
    readonly id: string;
    readonly correctionVersion: number;
    readonly baseAllocationSetId: string;
    readonly sourceFingerprint: string;
  } | null;
  readonly compatibleTip: {
    readonly id: string;
    readonly correctionVersion: number;
  } | null;
  readonly immutableBase: {
    readonly grossAllocationSetId: string;
    readonly feeAllocationSetId: string | null;
    readonly sourceFingerprint: string;
    readonly currency: string;
    readonly settlementCurrency: string | null;
    readonly totalPresentmentMinor: number;
  };
  readonly activeFeeComponents: readonly {
    readonly component: FinancialComponent;
    readonly amountMinor: number;
    readonly currency: string;
  }[];
  readonly items: readonly RefundReportingCorrectionPlanItemFacts[];
}

export interface RefundReportingCorrectionPersistableItem {
  readonly domain: 'presentment' | 'settlement';
  readonly sourceAllocationSetId: string | null;
  readonly orderItemId: string;
  readonly component: 'refund_subtotal' | 'refund_tax' | 'refund_fee';
  readonly currency: string;
  readonly approvedAbsoluteMinor: number;
  readonly deltaMinor: number;
  readonly stableTieBreakKey: string;
}

export interface RefundReportingCorrectionFingerprintDocument {
  readonly version: 'refund-reporting-correction-preview-v1';
  readonly refundId: string;
  readonly reason: 'allocation_attribution_correction';
  readonly activeProjection: {
    readonly classifierVersion: number;
    readonly allocationAlgorithmVersion: number;
    readonly replayId: string;
  };
  readonly expectedBaseAllocationSetId: string;
  readonly rawPredecessorCorrectionSetId: string | null;
  readonly compatibleCorrectionSetId: string | null;
  readonly expectedNextCorrectionVersion: number;
  readonly expectedSourceFingerprint: string;
  readonly baselineKind: 'immutable_base' | 'compatible_correction';
  readonly currentReportingComplete: boolean;
  readonly proposedReportingComplete: boolean;
  readonly compatibilityRepair: boolean;
  readonly requestedItems: readonly {
    readonly orderItemId: string;
    readonly totalPresentmentMinor: number;
  }[];
  readonly previewItems: readonly RefundCorrectionItemPreviewDto[];
  readonly persistableItems: readonly RefundReportingCorrectionPersistableItem[];
}

export type RefundReportingCorrectionPlanResult =
  | {
      readonly kind: 'ineligible';
      readonly preview: RefundReportingCorrectionPreviewDto;
      readonly fingerprintDocument: null;
      readonly persistableItems: readonly [];
    }
  | {
      readonly kind: 'ready';
      readonly preview: RefundReportingCorrectionPreviewDto;
      readonly fingerprintDocument: RefundReportingCorrectionFingerprintDocument;
      readonly persistableItems: readonly RefundReportingCorrectionPersistableItem[];
    };

interface PlannedItem {
  readonly facts: RefundReportingCorrectionPlanItemFacts;
  readonly requestedTotalMinor: number;
  readonly baselineSubtotalMinor: number;
  readonly baselineTaxMinor: number;
  readonly baselineSettlementSubtotalMinor: number | null;
  readonly baselineSettlementTaxMinor: number | null;
  readonly baselineRefundFeeImpactMinor: number | null;
  readonly proposedSubtotalMinor: number;
  readonly proposedTaxMinor: number;
  readonly proposedSettlementSubtotalMinor: number | null;
  readonly proposedSettlementTaxMinor: number | null;
  readonly proposedRefundFeeImpactMinor: number | null;
}

class EvidenceConflict extends Error {
  constructor(readonly reason: 'provider_evidence_pending' | 'immutable_conflict') {
    super(reason);
  }
}

function requestInvalid(): never {
  throw new TypeError('Invalid refund reporting correction request.');
}

function evidenceConflict(): never {
  throw new EvidenceConflict('immutable_conflict');
}

function evidencePending(): never {
  throw new EvidenceConflict('provider_evidence_pending');
}

function safeMoney(value: number): boolean {
  return Number.isSafeInteger(value) && !Object.is(value, -0) &&
    value >= -SAFE_MONEY_MAX && value <= SAFE_MONEY_MAX;
}

function safeUnsignedMoney(value: number): boolean {
  return safeMoney(value) && value >= 0;
}

function positiveInt32(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= POSTGRES_INTEGER_MAX;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sum(values: readonly number[]): number {
  const total = values.reduce((result, value) => result + BigInt(value), 0n);
  if (total < BigInt(-SAFE_MONEY_MAX) || total > BigInt(SAFE_MONEY_MAX)) {
    evidenceConflict();
  }
  return Number(total);
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function validateRequest(input: RefundReportingCorrectionPlanInput): {
  readonly facts: readonly RefundReportingCorrectionPlanItemFacts[];
  readonly requests: readonly { readonly orderItemId: string; readonly totalPresentmentMinor: number }[];
  readonly expectedNextCorrectionVersion: number;
} {
  const { request, immutableBase, rawTip } = input;
  if (
    !UUID_PATTERN.test(request.refundId) ||
    request.reason !== 'allocation_attribution_correction' ||
    !UUID_PATTERN.test(request.expectedBaseAllocationSetId) ||
    !SHA256_PATTERN.test(request.expectedSourceFingerprint) ||
    !Array.isArray(request.items) ||
    request.items.length < 1 ||
    request.items.length > 25 ||
    !UUID_PATTERN.test(immutableBase.grossAllocationSetId) ||
    (immutableBase.feeAllocationSetId !== null &&
      !UUID_PATTERN.test(immutableBase.feeAllocationSetId)) ||
    !SHA256_PATTERN.test(immutableBase.sourceFingerprint) ||
    !CURRENCY_PATTERN.test(immutableBase.currency) ||
    (immutableBase.settlementCurrency !== null &&
      !CURRENCY_PATTERN.test(immutableBase.settlementCurrency)) ||
    !safeUnsignedMoney(immutableBase.totalPresentmentMinor) ||
    immutableBase.totalPresentmentMinor === 0 ||
    request.expectedBaseAllocationSetId !== immutableBase.grossAllocationSetId ||
    request.expectedSourceFingerprint !== immutableBase.sourceFingerprint
  ) requestInvalid();

  const expectedNextCorrectionVersion = rawTip === null ? 1 : rawTip.correctionVersion + 1;
  if (
    (rawTip !== null && (
      !UUID_PATTERN.test(rawTip.id) ||
      !positiveInt32(rawTip.correctionVersion) ||
      !UUID_PATTERN.test(rawTip.baseAllocationSetId) ||
      !SHA256_PATTERN.test(rawTip.sourceFingerprint)
    )) ||
    !positiveInt32(expectedNextCorrectionVersion) ||
    request.expectedNextCorrectionVersion !== expectedNextCorrectionVersion
  ) requestInvalid();

  if (
    !positiveInt32(input.activeProjection.classifierVersion) ||
    !positiveInt32(input.activeProjection.allocationAlgorithmVersion) ||
    input.activeProjection.replayId !==
      `c${input.activeProjection.classifierVersion}-a${input.activeProjection.allocationAlgorithmVersion}` ||
    typeof input.currentReportingComplete !== 'boolean' ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 25
  ) requestInvalid();

  const requests = request.items.map((item) => ({
    orderItemId: item.orderItemId,
    totalPresentmentMinor: item.totalPresentmentMinor
  })).sort((left, right) => compareText(left.orderItemId, right.orderItemId));
  const requestIds = new Set<string>();
  for (const item of requests) {
    if (
      !UUID_PATTERN.test(item.orderItemId) ||
      !safeUnsignedMoney(item.totalPresentmentMinor) ||
      requestIds.has(item.orderItemId)
    ) requestInvalid();
    requestIds.add(item.orderItemId);
  }

  const facts = [...input.items].sort((left, right) =>
    compareText(left.orderItemId, right.orderItemId)
  );
  const factIds = new Set<string>();
  for (const item of facts) {
    if (!UUID_PATTERN.test(item.orderItemId) || factIds.has(item.orderItemId)) requestInvalid();
    factIds.add(item.orderItemId);
  }
  if (
    facts.length !== requests.length ||
    facts.some((item, index) => item.orderItemId !== requests[index]!.orderItemId)
  ) requestInvalid();

  return { facts, requests, expectedNextCorrectionVersion };
}

function baselineFor(
  item: RefundReportingCorrectionPlanItemFacts,
  useCompatible: boolean
): Pick<
  PlannedItem,
  | 'baselineSubtotalMinor'
  | 'baselineTaxMinor'
  | 'baselineSettlementSubtotalMinor'
  | 'baselineSettlementTaxMinor'
  | 'baselineRefundFeeImpactMinor'
> {
  return useCompatible ? {
    baselineSubtotalMinor: item.compatiblePresentmentSubtotalMinor ?? 0,
    baselineTaxMinor: item.compatiblePresentmentTaxMinor ?? 0,
    baselineSettlementSubtotalMinor: item.compatibleSettlementSubtotalMinor,
    baselineSettlementTaxMinor: item.compatibleSettlementTaxMinor,
    baselineRefundFeeImpactMinor: item.compatibleRefundFeeImpactMinor
  } : {
    baselineSubtotalMinor: item.immutablePresentmentSubtotalMinor,
    baselineTaxMinor: item.immutablePresentmentTaxMinor,
    baselineSettlementSubtotalMinor: item.immutableSettlementSubtotalMinor,
    baselineSettlementTaxMinor: item.immutableSettlementTaxMinor,
    baselineRefundFeeImpactMinor: item.immutableRefundFeeImpactMinor
  };
}

function fallbackPlannedItems(
  facts: readonly RefundReportingCorrectionPlanItemFacts[],
  requests: readonly { readonly orderItemId: string; readonly totalPresentmentMinor: number }[],
  useCompatible: boolean
): readonly PlannedItem[] {
  const requestById = new Map(requests.map((item) => [item.orderItemId, item]));
  return facts.map((item) => {
    const baseline = baselineFor(item, useCompatible);
    return {
      facts: item,
      requestedTotalMinor: requestById.get(item.orderItemId)?.totalPresentmentMinor ??
        baseline.baselineSubtotalMinor + baseline.baselineTaxMinor,
      ...baseline,
      proposedSubtotalMinor: baseline.baselineSubtotalMinor,
      proposedTaxMinor: baseline.baselineTaxMinor,
      proposedSettlementSubtotalMinor: baseline.baselineSettlementSubtotalMinor,
      proposedSettlementTaxMinor: baseline.baselineSettlementTaxMinor,
      proposedRefundFeeImpactMinor: baseline.baselineRefundFeeImpactMinor
    };
  });
}

function previewItems(items: readonly PlannedItem[]): readonly RefundCorrectionItemPreviewDto[] {
  return items.map((item) => {
    const baselineSettlementGrossMinor =
      item.baselineSettlementSubtotalMinor === null || item.baselineSettlementTaxMinor === null
        ? null
        : item.baselineSettlementSubtotalMinor + item.baselineSettlementTaxMinor;
    const proposedSettlementGrossMinor =
      item.proposedSettlementSubtotalMinor === null || item.proposedSettlementTaxMinor === null
        ? null
        : item.proposedSettlementSubtotalMinor + item.proposedSettlementTaxMinor;
    return {
      orderItemId: item.facts.orderItemId,
      titleId: item.facts.titleId,
      soldAsTitle: item.facts.soldAsTitle,
      baselineTotalMinor: item.baselineSubtotalMinor + item.baselineTaxMinor,
      baselineSubtotalMinor: item.baselineSubtotalMinor,
      baselineTaxMinor: item.baselineTaxMinor,
      proposedTotalMinor: item.proposedSubtotalMinor + item.proposedTaxMinor,
      proposedSubtotalMinor: item.proposedSubtotalMinor,
      proposedTaxMinor: item.proposedTaxMinor,
      subtotalDisplayDeltaMinor:
        item.proposedSubtotalMinor - item.baselineSubtotalMinor,
      taxDisplayDeltaMinor: item.proposedTaxMinor - item.baselineTaxMinor,
      baselineSettlementGrossMinor,
      proposedSettlementGrossMinor,
      settlementGrossDisplayDeltaMinor:
        baselineSettlementGrossMinor === null || proposedSettlementGrossMinor === null
          ? null
          : proposedSettlementGrossMinor - baselineSettlementGrossMinor,
      baselineRefundFeeImpactMinor: item.baselineRefundFeeImpactMinor,
      proposedRefundFeeImpactMinor: item.proposedRefundFeeImpactMinor,
      refundFeeImpactDisplayDeltaMinor:
        item.baselineRefundFeeImpactMinor === null ||
          item.proposedRefundFeeImpactMinor === null
          ? null
          : item.proposedRefundFeeImpactMinor - item.baselineRefundFeeImpactMinor
    };
  });
}

function makePreview(
  input: RefundReportingCorrectionPlanInput,
  derived: {
    readonly expectedNextCorrectionVersion: number;
    readonly baselineKind: 'immutable_base' | 'compatible_correction';
    readonly plannedItems: readonly PlannedItem[];
    readonly proposedReportingComplete: boolean;
    readonly eligible: boolean;
    readonly ineligibleReason: RefundReportingCorrectionPreviewDto['ineligibleReason'];
    readonly previewFingerprint: string | null;
  }
): RefundReportingCorrectionPreviewDto {
  const rows = previewItems(derived.plannedItems);
  return {
    refundId: input.request.refundId,
    expectedBaseAllocationSetId: input.immutableBase.grossAllocationSetId,
    rawPredecessorCorrectionSetId: input.rawTip?.id ?? null,
    compatibleCorrectionSetId: input.compatibleTip?.id ?? null,
    expectedNextCorrectionVersion: derived.expectedNextCorrectionVersion,
    expectedSourceFingerprint: input.immutableBase.sourceFingerprint,
    previewFingerprint: derived.previewFingerprint,
    baselineKind: derived.baselineKind,
    currentReportingComplete: input.currentReportingComplete,
    proposedReportingComplete: derived.proposedReportingComplete,
    compatibilityRepair:
      !input.currentReportingComplete && derived.proposedReportingComplete,
    currency: input.immutableBase.currency,
    settlementCurrency: input.immutableBase.settlementCurrency,
    baselineTotalMinor: sum(rows.map((item) => item.baselineTotalMinor)),
    proposedTotalMinor: sum(rows.map((item) => item.proposedTotalMinor)),
    eligible: derived.eligible,
    ineligibleReason: derived.ineligibleReason,
    items: rows
  };
}

function ineligible(
  input: RefundReportingCorrectionPlanInput,
  facts: readonly RefundReportingCorrectionPlanItemFacts[],
  requests: readonly { readonly orderItemId: string; readonly totalPresentmentMinor: number }[],
  expectedNextCorrectionVersion: number,
  baselineKind: 'immutable_base' | 'compatible_correction',
  reason: 'provider_evidence_pending' | 'immutable_conflict',
  plannedItems?: readonly PlannedItem[]
): RefundReportingCorrectionPlanResult {
  return {
    kind: 'ineligible',
    preview: makePreview(input, {
      expectedNextCorrectionVersion,
      baselineKind,
      plannedItems: plannedItems ?? fallbackPlannedItems(
        facts,
        requests,
        baselineKind === 'compatible_correction'
      ),
      proposedReportingComplete: false,
      eligible: false,
      ineligibleReason: reason,
      previewFingerprint: null
    }),
    fingerprintDocument: null,
    persistableItems: []
  };
}

function allocatePresentment(
  facts: readonly RefundReportingCorrectionPlanItemFacts[],
  requests: readonly { readonly orderItemId: string; readonly totalPresentmentMinor: number }[],
  useCompatible: boolean
): PlannedItem[] {
  const requestById = new Map(requests.map((item) => [item.orderItemId, item]));
  return facts.map((item) => {
    if (
      !UUID_PATTERN.test(item.titleId) ||
      typeof item.soldAsTitle !== 'string' ||
      item.soldAsTitle.length < 1 ||
      item.soldAsTitle.length > 300 ||
      !safeUnsignedMoney(item.paidSubtotalMinor) ||
      !safeUnsignedMoney(item.paidTaxMinor) ||
      !safeUnsignedMoney(item.paidTotalMinor) ||
      item.paidSubtotalMinor + item.paidTaxMinor !== item.paidTotalMinor ||
      !safeUnsignedMoney(item.effectiveSiblingSubtotalMinor) ||
      !safeUnsignedMoney(item.effectiveSiblingTaxMinor) ||
      !safeUnsignedMoney(item.immutablePresentmentSubtotalMinor) ||
      !safeUnsignedMoney(item.immutablePresentmentTaxMinor)
    ) evidenceConflict();
    const remainingSubtotalMinor = item.paidSubtotalMinor -
      item.effectiveSiblingSubtotalMinor;
    const remainingTaxMinor = item.paidTaxMinor - item.effectiveSiblingTaxMinor;
    if (
      remainingSubtotalMinor < 0 ||
      remainingTaxMinor < 0 ||
      item.immutablePresentmentSubtotalMinor > remainingSubtotalMinor ||
      item.immutablePresentmentTaxMinor > remainingTaxMinor
    ) evidenceConflict();

    const requestedTotalMinor = requestById.get(item.orderItemId)!.totalPresentmentMinor;
    if (requestedTotalMinor > remainingSubtotalMinor + remainingTaxMinor) evidenceConflict();
    const componentAllocations = allocateSignedLargestRemainder({
      amountMinor: requestedTotalMinor,
      weights: [
        {
          tieKey: `${item.orderItemId}:refund_subtotal`,
          weightMinor: remainingSubtotalMinor
        },
        { tieKey: `${item.orderItemId}:refund_tax`, weightMinor: remainingTaxMinor }
      ]
    });
    const byKey = new Map(componentAllocations.map((allocation) => [
      allocation.tieKey,
      allocation.amountMinor
    ]));
    const proposedSubtotalMinor = byKey.get(
      `${item.orderItemId}:refund_subtotal`
    ) ?? 0;
    const proposedTaxMinor = byKey.get(`${item.orderItemId}:refund_tax`) ?? 0;
    if (
      proposedSubtotalMinor > remainingSubtotalMinor ||
      proposedTaxMinor > remainingTaxMinor ||
      proposedSubtotalMinor + proposedTaxMinor !== requestedTotalMinor
    ) evidenceConflict();
    const baseline = baselineFor(item, useCompatible);
    if (
      baseline.baselineSubtotalMinor > remainingSubtotalMinor ||
      baseline.baselineTaxMinor > remainingTaxMinor
    ) evidenceConflict();
    return {
      facts: item,
      requestedTotalMinor,
      ...baseline,
      proposedSubtotalMinor,
      proposedTaxMinor,
      proposedSettlementSubtotalMinor: null,
      proposedSettlementTaxMinor: null,
      proposedRefundFeeImpactMinor: null
    };
  });
}

function applySettlementGross(
  input: RefundReportingCorrectionPlanInput,
  items: readonly PlannedItem[]
): PlannedItem[] {
  const settlementCurrency = input.immutableBase.settlementCurrency;
  if (settlementCurrency === null) evidencePending();
  const grossTotalMinor = sum(items.flatMap((item) => {
    if (
      item.facts.immutableSettlementSubtotalMinor === null ||
      item.facts.immutableSettlementTaxMinor === null
    ) evidenceConflict();
    if (
      !safeMoney(item.facts.immutableSettlementSubtotalMinor) ||
      !safeMoney(item.facts.immutableSettlementTaxMinor) ||
      item.facts.immutableSettlementSubtotalMinor > 0 ||
      item.facts.immutableSettlementTaxMinor > 0
    ) evidenceConflict();
    return [
      item.facts.immutableSettlementSubtotalMinor,
      item.facts.immutableSettlementTaxMinor
    ];
  }));
  if (grossTotalMinor >= 0) evidenceConflict();
  const allocations = allocateSignedLargestRemainder({
    amountMinor: grossTotalMinor,
    weights: items.flatMap((item) => [
      {
        tieKey: `${item.facts.orderItemId}:refund_subtotal`,
        weightMinor: item.proposedSubtotalMinor
      },
      {
        tieKey: `${item.facts.orderItemId}:refund_tax`,
        weightMinor: item.proposedTaxMinor
      }
    ])
  });
  const byKey = new Map(allocations.map((allocation) => [
    allocation.tieKey,
    allocation.amountMinor
  ]));
  return items.map((item) => ({
    ...item,
    proposedSettlementSubtotalMinor:
      byKey.get(`${item.facts.orderItemId}:refund_subtotal`) ?? 0,
    proposedSettlementTaxMinor:
      byKey.get(`${item.facts.orderItemId}:refund_tax`) ?? 0
  }));
}

function applyFee(
  input: RefundReportingCorrectionPlanInput,
  items: readonly PlannedItem[]
): PlannedItem[] {
  const feeSetId = input.immutableBase.feeAllocationSetId;
  const settlementCurrency = input.immutableBase.settlementCurrency;
  const nonzeroComponents = input.activeFeeComponents.filter((item) => item.amountMinor !== 0);
  for (const component of input.activeFeeComponents) {
    if (!safeMoney(component.amountMinor) ||
      settlementCurrency === null || component.currency !== settlementCurrency) evidenceConflict();
  }
  if (nonzeroComponents.some((item) => item.component !== 'refund_fee')) evidenceConflict();

  if (feeSetId === null) {
    if (nonzeroComponents.length > 0 || items.some((item) =>
      item.facts.immutableRefundFeeImpactMinor !== null ||
      item.baselineRefundFeeImpactMinor !== null
    )) evidenceConflict();
    return [...items];
  }
  if (settlementCurrency === null) evidencePending();

  const immutableTotal = sum(items.map((item) => {
    if (item.facts.immutableRefundFeeImpactMinor === null ||
      !safeMoney(item.facts.immutableRefundFeeImpactMinor) ||
      item.facts.immutableRefundFeeImpactMinor > 0) evidenceConflict();
    return item.facts.immutableRefundFeeImpactMinor;
  }));
  const activeTotal = sum(input.activeFeeComponents.map((item) => item.amountMinor));
  if (activeTotal > 0 || activeTotal !== immutableTotal) evidenceConflict();

  const allocations = allocateFeeDetails(
    -activeTotal,
    settlementCurrency,
    items.map((item) => ({
      orderItemId: item.facts.orderItemId,
      subtotalMinor: item.proposedSubtotalMinor,
      currency: settlementCurrency
    })),
    nonzeroComponents.map((item) => ({
      component: 'refund_fee' as const,
      amountMinor: item.amountMinor
    }))
  );
  const proposedById = new Map<string, number>();
  for (const allocation of allocations) {
    if (allocation.component !== 'refund_fee') evidenceConflict();
    proposedById.set(
      allocation.orderItemId,
      (proposedById.get(allocation.orderItemId) ?? 0) + allocation.effectMinor
    );
  }
  return items.map((item) => ({
    ...item,
    proposedRefundFeeImpactMinor: proposedById.get(item.facts.orderItemId) ?? 0
  }));
}

function validateBaseline(
  input: RefundReportingCorrectionPlanInput,
  items: readonly PlannedItem[],
  useCompatible: boolean
): void {
  const baselinePresentment = sum(items.flatMap((item) => [
    item.baselineSubtotalMinor,
    item.baselineTaxMinor
  ]));
  const immutablePresentment = sum(items.flatMap((item) => [
    item.facts.immutablePresentmentSubtotalMinor,
    item.facts.immutablePresentmentTaxMinor
  ]));
  if (
    baselinePresentment !== input.immutableBase.totalPresentmentMinor ||
    immutablePresentment !== input.immutableBase.totalPresentmentMinor ||
    items.some((item) =>
      !safeUnsignedMoney(item.baselineSubtotalMinor) ||
      !safeUnsignedMoney(item.baselineTaxMinor)
    )
  ) evidenceConflict();

  if (useCompatible && items.some((item) =>
    item.facts.compatiblePresentmentSubtotalMinor === null ||
    item.facts.compatiblePresentmentTaxMinor === null
  )) evidenceConflict();

  if (input.immutableBase.settlementCurrency !== null) {
    if (items.some((item) =>
      item.baselineSettlementSubtotalMinor === null ||
      item.baselineSettlementTaxMinor === null
    )) evidenceConflict();
    const immutableGross = sum(items.flatMap((item) => [
      item.facts.immutableSettlementSubtotalMinor!,
      item.facts.immutableSettlementTaxMinor!
    ]));
    const baselineGross = sum(items.flatMap((item) => [
      item.baselineSettlementSubtotalMinor!,
      item.baselineSettlementTaxMinor!
    ]));
    if (immutableGross !== baselineGross) evidenceConflict();
  }

  if (input.immutableBase.feeAllocationSetId !== null) {
    if (items.some((item) => item.baselineRefundFeeImpactMinor === null)) evidenceConflict();
    const immutableFee = sum(items.map((item) =>
      item.facts.immutableRefundFeeImpactMinor!
    ));
    const baselineFee = sum(items.map((item) => item.baselineRefundFeeImpactMinor!));
    if (immutableFee !== baselineFee) evidenceConflict();
  }
}

function persistableItems(
  input: RefundReportingCorrectionPlanInput,
  items: readonly PlannedItem[]
): readonly RefundReportingCorrectionPersistableItem[] {
  const rows: RefundReportingCorrectionPersistableItem[] = [];
  const add = (
    row: Omit<RefundReportingCorrectionPersistableItem, 'deltaMinor'>,
    immutableMinor: number
  ) => {
    if (row.approvedAbsoluteMinor === 0 && immutableMinor === 0) return;
    const deltaMinor = row.approvedAbsoluteMinor - immutableMinor;
    if (!safeMoney(row.approvedAbsoluteMinor) || !safeMoney(deltaMinor)) evidenceConflict();
    rows.push({
      domain: row.domain,
      sourceAllocationSetId: row.sourceAllocationSetId,
      orderItemId: row.orderItemId,
      component: row.component,
      currency: row.currency,
      approvedAbsoluteMinor: row.approvedAbsoluteMinor,
      deltaMinor,
      stableTieBreakKey: row.stableTieBreakKey
    });
  };

  for (const item of items) {
    add({
      domain: 'presentment',
      sourceAllocationSetId: null,
      orderItemId: item.facts.orderItemId,
      component: 'refund_subtotal',
      currency: input.immutableBase.currency,
      approvedAbsoluteMinor: item.proposedSubtotalMinor,
      stableTieBreakKey: `presentment:${item.facts.orderItemId}:refund_subtotal`
    }, item.facts.immutablePresentmentSubtotalMinor);
    add({
      domain: 'presentment',
      sourceAllocationSetId: null,
      orderItemId: item.facts.orderItemId,
      component: 'refund_tax',
      currency: input.immutableBase.currency,
      approvedAbsoluteMinor: item.proposedTaxMinor,
      stableTieBreakKey: `presentment:${item.facts.orderItemId}:refund_tax`
    }, item.facts.immutablePresentmentTaxMinor);
    if (
      item.proposedSettlementSubtotalMinor !== null &&
      item.facts.immutableSettlementSubtotalMinor !== null &&
      input.immutableBase.settlementCurrency !== null
    ) add({
      domain: 'settlement',
      sourceAllocationSetId: input.immutableBase.grossAllocationSetId,
      orderItemId: item.facts.orderItemId,
      component: 'refund_subtotal',
      currency: input.immutableBase.settlementCurrency,
      approvedAbsoluteMinor: item.proposedSettlementSubtotalMinor,
      stableTieBreakKey: `settlement:gross:${item.facts.orderItemId}:refund_subtotal`
    }, item.facts.immutableSettlementSubtotalMinor);
    if (
      item.proposedSettlementTaxMinor !== null &&
      item.facts.immutableSettlementTaxMinor !== null &&
      input.immutableBase.settlementCurrency !== null
    ) add({
      domain: 'settlement',
      sourceAllocationSetId: input.immutableBase.grossAllocationSetId,
      orderItemId: item.facts.orderItemId,
      component: 'refund_tax',
      currency: input.immutableBase.settlementCurrency,
      approvedAbsoluteMinor: item.proposedSettlementTaxMinor,
      stableTieBreakKey: `settlement:gross:${item.facts.orderItemId}:refund_tax`
    }, item.facts.immutableSettlementTaxMinor);
    if (
      input.immutableBase.feeAllocationSetId !== null &&
      item.proposedRefundFeeImpactMinor !== null &&
      item.facts.immutableRefundFeeImpactMinor !== null &&
      input.immutableBase.settlementCurrency !== null
    ) add({
      domain: 'settlement',
      sourceAllocationSetId: input.immutableBase.feeAllocationSetId,
      orderItemId: item.facts.orderItemId,
      component: 'refund_fee',
      currency: input.immutableBase.settlementCurrency,
      approvedAbsoluteMinor: item.proposedRefundFeeImpactMinor,
      stableTieBreakKey: `settlement:fee:${item.facts.orderItemId}:refund_fee`
    }, item.facts.immutableRefundFeeImpactMinor);
  }
  rows.sort((left, right) => compareText(left.stableTieBreakKey, right.stableTieBreakKey));
  const groups = new Map<string, bigint>();
  for (const row of rows) {
    const key = `${row.domain}\u0000${row.sourceAllocationSetId ?? ''}\u0000${row.currency}`;
    groups.set(key, (groups.get(key) ?? 0n) + BigInt(row.deltaMinor));
  }
  if ([...groups.values()].some((value) => value !== 0n)) evidenceConflict();
  return rows;
}

function distributionChanged(items: readonly PlannedItem[]): boolean {
  return items.some((item) =>
    item.proposedSubtotalMinor !== item.baselineSubtotalMinor ||
    item.proposedTaxMinor !== item.baselineTaxMinor ||
    item.proposedSettlementSubtotalMinor !== item.baselineSettlementSubtotalMinor ||
    item.proposedSettlementTaxMinor !== item.baselineSettlementTaxMinor ||
    item.proposedRefundFeeImpactMinor !== item.baselineRefundFeeImpactMinor
  );
}

export function planRefundReportingCorrection(
  input: RefundReportingCorrectionPlanInput
): RefundReportingCorrectionPlanResult {
  const { facts, requests, expectedNextCorrectionVersion } = validateRequest(input);
  const compatible = input.compatibleTip;
  const raw = input.rawTip;
  const useCompatible = compatible !== null;
  const baselineKind = useCompatible ? 'compatible_correction' : 'immutable_base';

  if (
    (compatible !== null && (
      raw === null ||
      !UUID_PATTERN.test(compatible.id) ||
      !positiveInt32(compatible.correctionVersion) ||
      compatible.id !== raw.id ||
      compatible.correctionVersion !== raw.correctionVersion ||
      raw.baseAllocationSetId !== input.immutableBase.grossAllocationSetId ||
      raw.sourceFingerprint !== input.immutableBase.sourceFingerprint ||
      !input.currentReportingComplete
    )) ||
    (compatible === null && raw !== null && input.currentReportingComplete)
  ) {
    return ineligible(
      input,
      facts,
      requests,
      expectedNextCorrectionVersion,
      baselineKind,
      'immutable_conflict'
    );
  }
  if (compatible === null && raw === null && !input.currentReportingComplete) {
    return ineligible(
      input,
      facts,
      requests,
      expectedNextCorrectionVersion,
      baselineKind,
      input.immutableBase.settlementCurrency === null
        ? 'provider_evidence_pending'
        : 'immutable_conflict'
    );
  }

  let planned: PlannedItem[];
  try {
    planned = allocatePresentment(facts, requests, useCompatible);
    validateBaseline(input, planned, useCompatible);
    if (sum(requests.map((item) => item.totalPresentmentMinor)) !==
      input.immutableBase.totalPresentmentMinor) evidenceConflict();
    planned = applySettlementGross(input, planned);
    planned = applyFee(input, planned);
    validateBaseline(input, planned, useCompatible);
  } catch (error) {
    if (error instanceof EvidenceConflict) {
      return ineligible(
        input,
        facts,
        requests,
        expectedNextCorrectionVersion,
        baselineKind,
        error.reason
      );
    }
    if (error instanceof PermanentFinancialError) {
      return ineligible(
        input,
        facts,
        requests,
        expectedNextCorrectionVersion,
        baselineKind,
        'immutable_conflict'
      );
    }
    throw error;
  }

  let persistable: readonly RefundReportingCorrectionPersistableItem[];
  try {
    persistable = persistableItems(input, planned);
  } catch (error) {
    if (error instanceof EvidenceConflict) {
      return ineligible(
        input,
        facts,
        requests,
        expectedNextCorrectionVersion,
        baselineKind,
        error.reason,
        planned
      );
    }
    throw error;
  }

  const changed = distributionChanged(planned);
  const proposedReportingComplete = true;
  const compatibilityRepair = !input.currentReportingComplete && proposedReportingComplete;
  if (!changed && !compatibilityRepair) {
    return {
      kind: 'ineligible',
      preview: makePreview(input, {
        expectedNextCorrectionVersion,
        baselineKind,
        plannedItems: planned,
        proposedReportingComplete,
        eligible: false,
        ineligibleReason: 'no_change',
        previewFingerprint: null
      }),
      fingerprintDocument: null,
      persistableItems: []
    };
  }

  const rows = previewItems(planned);
  const fingerprintDocument: RefundReportingCorrectionFingerprintDocument = {
    version: 'refund-reporting-correction-preview-v1',
    refundId: input.request.refundId,
    reason: 'allocation_attribution_correction',
    activeProjection: {
      classifierVersion: input.activeProjection.classifierVersion,
      allocationAlgorithmVersion: input.activeProjection.allocationAlgorithmVersion,
      replayId: input.activeProjection.replayId
    },
    expectedBaseAllocationSetId: input.immutableBase.grossAllocationSetId,
    rawPredecessorCorrectionSetId: raw?.id ?? null,
    compatibleCorrectionSetId: compatible?.id ?? null,
    expectedNextCorrectionVersion,
    expectedSourceFingerprint: input.immutableBase.sourceFingerprint,
    baselineKind,
    currentReportingComplete: input.currentReportingComplete,
    proposedReportingComplete,
    compatibilityRepair,
    requestedItems: requests,
    previewItems: rows,
    persistableItems: persistable
  };
  const previewFingerprint = canonicalHash(fingerprintDocument);
  return {
    kind: 'ready',
    preview: makePreview(input, {
      expectedNextCorrectionVersion,
      baselineKind,
      plannedItems: planned,
      proposedReportingComplete,
      eligible: true,
      ineligibleReason: null,
      previewFingerprint
    }),
    fingerprintDocument,
    persistableItems: persistable
  };
}
