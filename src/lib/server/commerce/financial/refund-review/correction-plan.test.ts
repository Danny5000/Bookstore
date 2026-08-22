import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  planRefundReportingCorrection,
  type RefundReportingCorrectionPlanInput,
  type RefundReportingCorrectionPersistableItem
} from './correction-plan';

const REFUND_ID = '00000000-0000-4000-8000-000000013001';
const ITEM_A = '00000000-0000-4000-8000-000000013002';
const ITEM_B = '00000000-0000-4000-8000-000000013003';
const GROSS_SET_ID = '00000000-0000-4000-8000-000000013004';
const FEE_SET_ID = '00000000-0000-4000-8000-000000013005';
const RAW_TIP_ID = '00000000-0000-4000-8000-000000013006';
const OLD_GROSS_SET_ID = '00000000-0000-4000-8000-000000013007';
const SOURCE_FINGERPRINT = 'a'.repeat(64);
const OLD_SOURCE_FINGERPRINT = 'b'.repeat(64);

function input(
  overrides: Partial<RefundReportingCorrectionPlanInput> = {}
): RefundReportingCorrectionPlanInput {
  return {
    request: {
      refundId: REFUND_ID,
      reason: 'allocation_attribution_correction',
      expectedNextCorrectionVersion: 1,
      expectedBaseAllocationSetId: GROSS_SET_ID,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      items: [
        { orderItemId: ITEM_A, totalPresentmentMinor: 300 },
        { orderItemId: ITEM_B, totalPresentmentMinor: 300 }
      ]
    },
    activeProjection: {
      classifierVersion: 3,
      allocationAlgorithmVersion: 2,
      replayId: 'c3-a2'
    },
    currentReportingComplete: true,
    rawTip: null,
    compatibleTip: null,
    immutableBase: {
      grossAllocationSetId: GROSS_SET_ID,
      feeAllocationSetId: FEE_SET_ID,
      sourceFingerprint: SOURCE_FINGERPRINT,
      currency: 'USD',
      settlementCurrency: 'USD',
      totalPresentmentMinor: 600
    },
    activeFeeComponents: [{ component: 'refund_fee', amountMinor: -30, currency: 'USD' }],
    items: [
      {
        orderItemId: ITEM_A,
        titleId: '00000000-0000-4000-8000-000000013101',
        soldAsTitle: 'Alpha',
        paidSubtotalMinor: 800,
        paidTaxMinor: 200,
        paidTotalMinor: 1_000,
        effectiveSiblingSubtotalMinor: 0,
        effectiveSiblingTaxMinor: 0,
        immutablePresentmentSubtotalMinor: 320,
        immutablePresentmentTaxMinor: 80,
        immutableSettlementSubtotalMinor: -288,
        immutableSettlementTaxMinor: -72,
        immutableRefundFeeImpactMinor: -20,
        compatiblePresentmentSubtotalMinor: null,
        compatiblePresentmentTaxMinor: null,
        compatibleSettlementSubtotalMinor: null,
        compatibleSettlementTaxMinor: null,
        compatibleRefundFeeImpactMinor: null
      },
      {
        orderItemId: ITEM_B,
        titleId: '00000000-0000-4000-8000-000000013102',
        soldAsTitle: 'Beta',
        paidSubtotalMinor: 400,
        paidTaxMinor: 100,
        paidTotalMinor: 500,
        effectiveSiblingSubtotalMinor: 0,
        effectiveSiblingTaxMinor: 0,
        immutablePresentmentSubtotalMinor: 160,
        immutablePresentmentTaxMinor: 40,
        immutableSettlementSubtotalMinor: -144,
        immutableSettlementTaxMinor: -36,
        immutableRefundFeeImpactMinor: -10,
        compatiblePresentmentSubtotalMinor: null,
        compatiblePresentmentTaxMinor: null,
        compatibleSettlementSubtotalMinor: null,
        compatibleSettlementTaxMinor: null,
        compatibleRefundFeeImpactMinor: null
      }
    ],
    ...overrides
  };
}

function byStableKey(
  rows: readonly RefundReportingCorrectionPersistableItem[]
): Readonly<Record<string, RefundReportingCorrectionPersistableItem>> {
  return Object.fromEntries(rows.map((row) => [row.stableTieBreakKey, row]));
}

function groupedDeltas(rows: readonly RefundReportingCorrectionPersistableItem[]) {
  const groups = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.domain}:${row.sourceAllocationSetId ?? ''}:${row.currency}`;
    groups.set(key, (groups.get(key) ?? 0) + row.deltaMinor);
  }
  return Object.fromEntries(groups);
}

describe('refund reporting-correction pure planner', () => {
  it('plans a deterministic first correction from the immutable baseline', () => {
    const result = planRefundReportingCorrection(input());

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.preview).toMatchObject({
      refundId: REFUND_ID,
      expectedBaseAllocationSetId: GROSS_SET_ID,
      rawPredecessorCorrectionSetId: null,
      compatibleCorrectionSetId: null,
      expectedNextCorrectionVersion: 1,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      baselineKind: 'immutable_base',
      currentReportingComplete: true,
      proposedReportingComplete: true,
      compatibilityRepair: false,
      currency: 'USD',
      settlementCurrency: 'USD',
      baselineTotalMinor: 600,
      proposedTotalMinor: 600,
      eligible: true,
      ineligibleReason: null
    });
    expect(result.preview.items).toEqual([
      {
        orderItemId: ITEM_A,
        titleId: '00000000-0000-4000-8000-000000013101',
        soldAsTitle: 'Alpha',
        baselineTotalMinor: 400,
        baselineSubtotalMinor: 320,
        baselineTaxMinor: 80,
        proposedTotalMinor: 300,
        proposedSubtotalMinor: 240,
        proposedTaxMinor: 60,
        subtotalDisplayDeltaMinor: -80,
        taxDisplayDeltaMinor: -20,
        baselineSettlementGrossMinor: -360,
        proposedSettlementGrossMinor: -270,
        settlementGrossDisplayDeltaMinor: 90,
        baselineRefundFeeImpactMinor: -20,
        proposedRefundFeeImpactMinor: -15,
        refundFeeImpactDisplayDeltaMinor: 5
      },
      {
        orderItemId: ITEM_B,
        titleId: '00000000-0000-4000-8000-000000013102',
        soldAsTitle: 'Beta',
        baselineTotalMinor: 200,
        baselineSubtotalMinor: 160,
        baselineTaxMinor: 40,
        proposedTotalMinor: 300,
        proposedSubtotalMinor: 240,
        proposedTaxMinor: 60,
        subtotalDisplayDeltaMinor: 80,
        taxDisplayDeltaMinor: 20,
        baselineSettlementGrossMinor: -180,
        proposedSettlementGrossMinor: -270,
        settlementGrossDisplayDeltaMinor: -90,
        baselineRefundFeeImpactMinor: -10,
        proposedRefundFeeImpactMinor: -15,
        refundFeeImpactDisplayDeltaMinor: -5
      }
    ]);

    expect(result.persistableItems).toHaveLength(10);
    expect(Object.keys(result.persistableItems[0]!)).toEqual([
      'domain',
      'sourceAllocationSetId',
      'orderItemId',
      'component',
      'currency',
      'approvedAbsoluteMinor',
      'deltaMinor',
      'stableTieBreakKey'
    ]);
    expect(byStableKey(result.persistableItems)).toMatchObject({
      [`presentment:${ITEM_A}:refund_subtotal`]: {
        domain: 'presentment', sourceAllocationSetId: null,
        approvedAbsoluteMinor: 240, deltaMinor: -80
      },
      [`presentment:${ITEM_A}:refund_tax`]: {
        domain: 'presentment', sourceAllocationSetId: null,
        approvedAbsoluteMinor: 60, deltaMinor: -20
      },
      [`settlement:gross:${ITEM_A}:refund_subtotal`]: {
        domain: 'settlement', sourceAllocationSetId: GROSS_SET_ID,
        approvedAbsoluteMinor: -216, deltaMinor: 72
      },
      [`settlement:gross:${ITEM_A}:refund_tax`]: {
        domain: 'settlement', sourceAllocationSetId: GROSS_SET_ID,
        approvedAbsoluteMinor: -54, deltaMinor: 18
      },
      [`settlement:fee:${ITEM_A}:refund_fee`]: {
        domain: 'settlement', sourceAllocationSetId: FEE_SET_ID,
        approvedAbsoluteMinor: -15, deltaMinor: 5
      }
    });
    expect(groupedDeltas(result.persistableItems)).toEqual({
      'presentment::USD': 0,
      [`settlement:${GROSS_SET_ID}:USD`]: 0,
      [`settlement:${FEE_SET_ID}:USD`]: 0
    });
    expect(result.fingerprintDocument).toEqual({
      version: 'refund-reporting-correction-preview-v1',
      refundId: REFUND_ID,
      reason: 'allocation_attribution_correction',
      activeProjection: {
        classifierVersion: 3,
        allocationAlgorithmVersion: 2,
        replayId: 'c3-a2'
      },
      expectedBaseAllocationSetId: GROSS_SET_ID,
      rawPredecessorCorrectionSetId: null,
      compatibleCorrectionSetId: null,
      expectedNextCorrectionVersion: 1,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      baselineKind: 'immutable_base',
      currentReportingComplete: true,
      proposedReportingComplete: true,
      compatibilityRepair: false,
      requestedItems: [
        { orderItemId: ITEM_A, totalPresentmentMinor: 300 },
        { orderItemId: ITEM_B, totalPresentmentMinor: 300 }
      ],
      previewItems: result.preview.items,
      persistableItems: result.persistableItems
    });
    expect(result.preview.previewFingerprint).toBe(
      createHash('sha256')
        .update(JSON.stringify(result.fingerprintDocument), 'utf8')
        .digest('hex')
    );
    expect(planRefundReportingCorrection(input())).toEqual(result);
  });

  it('canonicalizes requested-item property order before fingerprinting', () => {
    const canonical = planRefundReportingCorrection(input());
    const base = input();
    const reordered = planRefundReportingCorrection(input({
      request: {
        ...base.request,
        items: base.request.items.map((item) => ({
          totalPresentmentMinor: item.totalPresentmentMinor,
          orderItemId: item.orderItemId
        }))
      }
    }));
    expect(reordered).toEqual(canonical);
  });

  it('uses the compatible tip only as the successor display baseline', () => {
    const facts = input().items.map((item, index) => ({
      ...item,
      compatiblePresentmentSubtotalMinor: index === 0 ? 280 : 200,
      compatiblePresentmentTaxMinor: index === 0 ? 70 : 50,
      compatibleSettlementSubtotalMinor: index === 0 ? -252 : -180,
      compatibleSettlementTaxMinor: index === 0 ? -63 : -45,
      compatibleRefundFeeImpactMinor: index === 0 ? -18 : -12
    }));
    const result = planRefundReportingCorrection(input({
      request: { ...input().request, expectedNextCorrectionVersion: 3 },
      rawTip: {
        id: RAW_TIP_ID,
        correctionVersion: 2,
        baseAllocationSetId: GROSS_SET_ID,
        sourceFingerprint: SOURCE_FINGERPRINT
      },
      compatibleTip: { id: RAW_TIP_ID, correctionVersion: 2 },
      items: facts
    }));

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.preview).toMatchObject({
      rawPredecessorCorrectionSetId: RAW_TIP_ID,
      compatibleCorrectionSetId: RAW_TIP_ID,
      expectedNextCorrectionVersion: 3,
      baselineKind: 'compatible_correction',
      baselineTotalMinor: 600,
      compatibilityRepair: false
    });
    expect(result.preview.items[0]).toMatchObject({
      baselineSubtotalMinor: 280,
      baselineTaxMinor: 70,
      subtotalDisplayDeltaMinor: -40,
      taxDisplayDeltaMinor: -10,
      baselineSettlementGrossMinor: -315,
      settlementGrossDisplayDeltaMinor: 45,
      baselineRefundFeeImpactMinor: -18,
      refundFeeImpactDisplayDeltaMinor: 3
    });
    expect(byStableKey(result.persistableItems)[
      `presentment:${ITEM_A}:refund_subtotal`
    ]).toMatchObject({ approvedAbsoluteMinor: 240, deltaMinor: -80 });
  });

  it('allows subtotal redistribution to offset tax in one presentment group', () => {
    const adjustedFacts = input().items.map((item, index) => index === 0 ? {
      ...item,
      paidTaxMinor: 300,
      paidTotalMinor: 1_100
    } : item);
    const result = planRefundReportingCorrection(input({ items: adjustedFacts }));

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    const presentment = result.persistableItems.filter((item) =>
      item.domain === 'presentment'
    );
    expect(presentment.filter((item) => item.component === 'refund_subtotal')
      .reduce((total, item) => total + item.deltaMinor, 0)).toBe(-22);
    expect(presentment.filter((item) => item.component === 'refund_tax')
      .reduce((total, item) => total + item.deltaMinor, 0)).toBe(22);
    expect(presentment.reduce((total, item) => total + item.deltaMinor, 0)).toBe(0);
  });

  it('repairs an incompatible raw tip with a zero-delta immutable successor', () => {
    const base = input();
    const result = planRefundReportingCorrection(input({
      request: {
        ...base.request,
        expectedNextCorrectionVersion: 5,
        items: [
          { orderItemId: ITEM_A, totalPresentmentMinor: 400 },
          { orderItemId: ITEM_B, totalPresentmentMinor: 200 }
        ]
      },
      currentReportingComplete: false,
      rawTip: {
        id: RAW_TIP_ID,
        correctionVersion: 4,
        baseAllocationSetId: OLD_GROSS_SET_ID,
        sourceFingerprint: OLD_SOURCE_FINGERPRINT
      },
      compatibleTip: null
    }));

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.preview).toMatchObject({
      rawPredecessorCorrectionSetId: RAW_TIP_ID,
      compatibleCorrectionSetId: null,
      expectedNextCorrectionVersion: 5,
      baselineKind: 'immutable_base',
      currentReportingComplete: false,
      proposedReportingComplete: true,
      compatibilityRepair: true,
      eligible: true,
      ineligibleReason: null
    });
    expect(result.persistableItems).toHaveLength(10);
    expect(result.persistableItems.every((item) => item.deltaMinor === 0)).toBe(true);
    expect(result.preview.items.every((item) =>
      item.subtotalDisplayDeltaMinor === 0 &&
      item.taxDisplayDeltaMinor === 0 &&
      item.settlementGrossDisplayDeltaMinor === 0 &&
      item.refundFeeImpactDisplayDeltaMinor === 0
    )).toBe(true);
  });

  it('returns no_change only for an already-complete equivalent distribution', () => {
    const base = input();
    const result = planRefundReportingCorrection(input({
      request: {
        ...base.request,
        items: [
          { orderItemId: ITEM_A, totalPresentmentMinor: 400 },
          { orderItemId: ITEM_B, totalPresentmentMinor: 200 }
        ]
      }
    }));

    expect(result).toMatchObject({
      kind: 'ineligible',
      preview: {
        currentReportingComplete: true,
        proposedReportingComplete: true,
        compatibilityRepair: false,
        previewFingerprint: null,
        eligible: false,
        ineligibleReason: 'no_change'
      },
      fingerprintDocument: null,
      persistableItems: []
    });
  });

  it('uses effective sibling consumption for independent subtotal and tax capacity', () => {
    const base = input();
    const constrainedItems = base.items.map((item, index) => index === 0 ? {
      ...item,
      effectiveSiblingSubtotalMinor: 650,
      effectiveSiblingTaxMinor: 150
    } : item);

    const result = planRefundReportingCorrection(input({
      request: {
        ...base.request,
        items: [
          { orderItemId: ITEM_A, totalPresentmentMinor: 300 },
          { orderItemId: ITEM_B, totalPresentmentMinor: 300 }
        ]
      },
      items: constrainedItems
    }));

    expect(result).toMatchObject({
      kind: 'ineligible',
      preview: { eligible: false, ineligibleReason: 'immutable_conflict' }
    });
  });

  it('fails closed when a compatible baseline exceeds effective sibling capacity', () => {
    const facts = input().items.map((item, index) => index === 0 ? {
      ...item,
      effectiveSiblingSubtotalMinor: 350,
      compatiblePresentmentSubtotalMinor: 500,
      compatiblePresentmentTaxMinor: 0,
      compatibleSettlementSubtotalMinor: -450,
      compatibleSettlementTaxMinor: 0,
      compatibleRefundFeeImpactMinor: -25
    } : {
      ...item,
      compatiblePresentmentSubtotalMinor: 80,
      compatiblePresentmentTaxMinor: 20,
      compatibleSettlementSubtotalMinor: -72,
      compatibleSettlementTaxMinor: -18,
      compatibleRefundFeeImpactMinor: -5
    });
    expect(planRefundReportingCorrection(input({
      request: { ...input().request, expectedNextCorrectionVersion: 3 },
      rawTip: {
        id: RAW_TIP_ID,
        correctionVersion: 2,
        baseAllocationSetId: GROSS_SET_ID,
        sourceFingerprint: SOURCE_FINGERPRINT
      },
      compatibleTip: { id: RAW_TIP_ID, correctionVersion: 2 },
      items: facts
    }))).toMatchObject({
      kind: 'ineligible',
      preview: { eligible: false, ineligibleReason: 'immutable_conflict' }
    });
  });

  it('distinguishes pending provider evidence from immutable conflicts', () => {
    const pendingItems = input().items.map((item) => ({
      ...item,
      immutableSettlementSubtotalMinor: null,
      immutableSettlementTaxMinor: null,
      immutableRefundFeeImpactMinor: null
    }));
    expect(planRefundReportingCorrection(input({
      currentReportingComplete: false,
      immutableBase: {
        ...input().immutableBase,
        feeAllocationSetId: null,
        settlementCurrency: null
      },
      activeFeeComponents: [],
      items: pendingItems
    }))).toMatchObject({
      kind: 'ineligible',
      preview: { eligible: false, ineligibleReason: 'provider_evidence_pending' }
    });
  });

  it('fails closed on any nonzero unrepresentable active fee component', () => {
    for (const component of ['provider_fee_tax', 'other', 'processing_fee'] as const) {
      const result = planRefundReportingCorrection(input({
        activeFeeComponents: [
          { component: 'refund_fee', amountMinor: -30, currency: 'USD' },
          { component, amountMinor: -1, currency: 'USD' }
        ]
      }));
      expect(result).toMatchObject({
        kind: 'ineligible',
        preview: { eligible: false, ineligibleReason: 'immutable_conflict' }
      });
    }
  });

  it('ignores zero-valued unrepresentable fee classifications', () => {
    expect(planRefundReportingCorrection(input({
      activeFeeComponents: [
        { component: 'refund_fee', amountMinor: -30, currency: 'USD' },
        { component: 'provider_fee_tax', amountMinor: 0, currency: 'USD' }
      ]
    }))).toMatchObject({ kind: 'ready', preview: { eligible: true } });
  });

  it.each([
    ['presentment', {
      immutableBase: { ...input().immutableBase, totalPresentmentMinor: 601 }
    }],
    ['gross', {
      items: input().items.map((item, index) => index === 0
        ? { ...item, immutableSettlementTaxMinor: null }
        : item)
    }],
    ['fee', {
      activeFeeComponents: [{ component: 'refund_fee' as const, amountMinor: -29, currency: 'USD' }]
    }]
  ] as const)('rejects a nonconserving %s immutable group', (_label, overrides) => {
    expect(planRefundReportingCorrection(input(overrides))).toMatchObject({
      kind: 'ineligible',
      preview: { eligible: false, ineligibleReason: 'immutable_conflict' }
    });
  });

  it('requires exact sorted item coverage and current request bindings', () => {
    const base = input();
    expect(() => planRefundReportingCorrection(input({
      request: { ...base.request, items: base.request.items.slice(0, 1) }
    }))).toThrow();
    expect(() => planRefundReportingCorrection(input({
      request: { ...base.request, expectedNextCorrectionVersion: 2 }
    }))).toThrow();
    expect(() => planRefundReportingCorrection(input({
      request: { ...base.request, expectedBaseAllocationSetId: OLD_GROSS_SET_ID }
    }))).toThrow();
    expect(() => planRefundReportingCorrection(input({
      request: { ...base.request, expectedSourceFingerprint: OLD_SOURCE_FINGERPRINT }
    }))).toThrow();
  });

  it('rejects fork-like raw/compatible topology and malformed money facts', () => {
    expect(planRefundReportingCorrection(input({
      rawTip: {
        id: RAW_TIP_ID,
        correctionVersion: 1,
        baseAllocationSetId: GROSS_SET_ID,
        sourceFingerprint: SOURCE_FINGERPRINT
      },
      compatibleTip: {
        id: '00000000-0000-4000-8000-000000013999',
        correctionVersion: 1
      },
      request: { ...input().request, expectedNextCorrectionVersion: 2 }
    }))).toMatchObject({
      kind: 'ineligible',
      preview: { ineligibleReason: 'immutable_conflict' }
    });

    expect(planRefundReportingCorrection(input({
      items: input().items.map((item, index) => index === 0
        ? { ...item, paidTotalMinor: item.paidTotalMinor + 1 }
        : item)
    }))).toMatchObject({
      kind: 'ineligible',
      preview: { ineligibleReason: 'immutable_conflict' }
    });
  });
});
