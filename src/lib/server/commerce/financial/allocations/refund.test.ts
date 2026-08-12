import { describe, expect, it } from 'vitest';
import type { FinancialAllocationPlan } from '../types';
import { buildFailedRefundAllocationPlan, buildRefundAllocationPlan } from './refund';
import type { FailedRefundAllocationInput, RefundAllocationInput } from './types';

const base: RefundAllocationInput = {
  sourceKind: 'refund', sourceId: 'refund-1', balanceTransactionId: 'bt-refund-1',
  allocationIdentityPrefix: 'refund:refund-1:bt-refund-1', settlementCurrency: 'USD',
  amountMinor: -500, feeMinor: 10, netMinor: -510,
  presentmentAmountMinor: 500, presentmentCurrency: 'USD',
  sourceFingerprint: 'b'.repeat(64), algorithmVersion: 1,
  supersedesGrossSetId: null, supersedesFeeSetId: null,
  attribution: { kind: 'finalized', components: [
    { orderItemId: 'item-a', subtotalMinor: 300, taxMinor: 100, remainingSubtotalCapacityMinor: 300, remainingTaxCapacityMinor: 100, presentmentCurrency: 'USD' },
    { orderItemId: 'item-b', subtotalMinor: 100, taxMinor: 0, remainingSubtotalCapacityMinor: 100, remainingTaxCapacityMinor: 0, presentmentCurrency: 'USD' }
  ] },
  paymentItems: [
    { orderItemId: 'item-a', subtotalMinor: 700, currency: 'USD' },
    { orderItemId: 'item-b', subtotalMinor: 300, currency: 'USD' }
  ],
  feeDetails: [{ component: 'refund_fee', amountMinor: -10 }]
};

function refundWithChronology(input: {
  readonly refundId: string;
  readonly providerCreatedAt: string;
  readonly earlierRefundId: string;
  readonly earlierProviderCreatedAt: string;
}): RefundAllocationInput {
  return {
    ...base,
    sourceId: input.refundId,
    refundId: input.refundId,
    providerCreatedAt: input.providerCreatedAt,
    presentmentAmountMinor: 100,
    amountMinor: -100,
    feeMinor: 0,
    netMinor: -100,
    feeDetails: [],
    paymentItemCapacities: [
      { orderItemId: 'item-a', subtotalMinor: 500, taxMinor: 0, presentmentCurrency: 'USD' }
    ],
    earlierFinalized: [{
      refundId: input.earlierRefundId,
      providerCreatedAt: input.earlierProviderCreatedAt,
      orderItemId: 'item-a',
      subtotalMinor: 100,
      taxMinor: 0,
      presentmentCurrency: 'USD'
    }],
    attribution: { kind: 'finalized', components: [{
      orderItemId: 'item-a',
      subtotalMinor: 100,
      taxMinor: 0,
      remainingSubtotalCapacityMinor: 500,
      remainingTaxCapacityMinor: 0,
      presentmentCurrency: 'USD'
    }] }
  };
}

describe('refund allocation plans', () => {
  it('allocates a finalized refund by immutable subtotal/tax components and fee by refunded subtotal', () => {
    const { plans: [gross, fee] } = buildRefundAllocationPlan(base);
    expect(gross.items.map(({ component, effectMinor }) => ({ component, effectMinor }))).toEqual([
      { component: 'refund_subtotal', effectMinor: -300 },
      { component: 'refund_tax', effectMinor: -100 },
      { component: 'refund_subtotal', effectMinor: -100 }
    ]);
    expect(fee.items.map(({ orderItemId, effectMinor }) => ({ orderItemId, effectMinor }))).toEqual([
      { orderItemId: 'item-a', effectMinor: -8 },
      { orderItemId: 'item-b', effectMinor: -2 }
    ]);
  });

  it('keeps ambiguous succeeded refund gross and fee unresolved with no attribution guess', () => {
    const { plans } = buildRefundAllocationPlan({ ...base, attribution: { kind: 'unresolved' } });
    expect(plans.map((plan) => ({ basis: plan.basis, scope: plan.scope, items: plan.items }))).toEqual([
      { basis: 'gross_amount', scope: 'unresolved', items: [] },
      { basis: 'fee', scope: 'unresolved', items: [] }
    ]);
  });

  it('partially reverses persisted original title allocation and references the exact sets', () => {
    const originalGrossPlan: FinancialAllocationPlan = {
      allocationIdentity: 'refund:original:gross', balanceTransactionId: 'bt-original',
      basis: 'gross_amount', scope: 'title', currency: 'USD', expectedEffectMinor: -500,
      algorithmVersion: 1, sourceFingerprint: 'c'.repeat(64), supersedesSetId: null,
      reversalOfSetId: null,
      items: [
        { orderItemId: 'item-a', component: 'refund_subtotal', effectMinor: -300, currency: 'USD', tieBreakKey: 'item-a' },
        { orderItemId: 'item-b', component: 'refund_subtotal', effectMinor: -200, currency: 'USD', tieBreakKey: 'item-b' }
      ]
    };
    const failed: FailedRefundAllocationInput = {
      ...base,
      balanceTransactionId: 'bt-failed-refund',
      allocationIdentityPrefix: 'refund:failed:bt-failed-refund',
      amountMinor: 250,
      feeMinor: 0,
      netMinor: 250,
      feeDetails: [],
      originalGrossSetId: 'set-original-gross', originalGrossPlan,
      originalFeeSetId: null, originalFeePlan: null
    };
    const { plans: [gross, fee] } = buildFailedRefundAllocationPlan(failed);
    expect(gross.reversalOfSetId).toBe('set-original-gross');
    expect(gross.items.map(({ orderItemId, effectMinor }) => ({ orderItemId, effectMinor }))).toEqual([
      { orderItemId: 'item-a', effectMinor: 150 },
      { orderItemId: 'item-b', effectMinor: 100 }
    ]);
    expect(fee).toMatchObject({ expectedEffectMinor: 0, reversalOfSetId: null });
  });

  it('rejects refund attribution capacity/currency mismatch and invalid reversal references', () => {
    expect(() => buildRefundAllocationPlan({ ...base, presentmentAmountMinor: 501 })).toThrow();
    expect(() => buildRefundAllocationPlan({
      ...base,
      attribution: { kind: 'finalized', components: [
        { orderItemId: 'item-a', subtotalMinor: 500, taxMinor: 1, remainingSubtotalCapacityMinor: 500, remainingTaxCapacityMinor: 1, presentmentCurrency: 'EUR' }
      ] }
    })).toThrow();
    expect(() => buildFailedRefundAllocationPlan({
      ...base,
      originalGrossSetId: '',
      originalGrossPlan: null as unknown as FinancialAllocationPlan,
      originalFeeSetId: null,
      originalFeePlan: null
    })).toThrow();
  });

  it('rejects a component beyond remaining capacity', () => {
    expect(() => buildRefundAllocationPlan({
      ...base,
      attribution: { kind: 'finalized', components: [{
        orderItemId: 'item-a',
        subtotalMinor: 300,
        taxMinor: 100,
        remainingSubtotalCapacityMinor: 299,
        remainingTaxCapacityMinor: 100,
        presentmentCurrency: 'USD'
      }] }
    })).toThrow();
  });

  it('uses finalized refund chronology rather than caller-provided capacities', () => {
    const withHistory = {
      ...base,
      sourceId: 'refund-2',
      presentmentAmountMinor: 300,
      amountMinor: -300,
      feeMinor: 0,
      netMinor: -300,
      feeDetails: [],
      refundId: 'refund-2',
      providerCreatedAt: '2026-08-12T00:00:00.000Z',
      paymentItemCapacities: [
        { orderItemId: 'item-a', subtotalMinor: 700, taxMinor: 100, presentmentCurrency: 'USD' },
        { orderItemId: 'item-b', subtotalMinor: 300, taxMinor: 0, presentmentCurrency: 'USD' }
      ],
      earlierFinalized: [
        { refundId: 'refund-1', providerCreatedAt: '2026-08-11T00:00:00.000Z', orderItemId: 'item-a', subtotalMinor: 500, taxMinor: 0, presentmentCurrency: 'USD' }
      ],
      attribution: { kind: 'finalized' as const, components: [
        { orderItemId: 'item-a', subtotalMinor: 201, taxMinor: 0, remainingSubtotalCapacityMinor: 700, remainingTaxCapacityMinor: 100, presentmentCurrency: 'USD' },
        { orderItemId: 'item-b', subtotalMinor: 99, taxMinor: 0, remainingSubtotalCapacityMinor: 300, remainingTaxCapacityMinor: 0, presentmentCurrency: 'USD' }
      ] }
    } as unknown as RefundAllocationInput;
    expect(() => buildRefundAllocationPlan(withHistory)).toThrow(/financial reconciliation/i);
  });

  it('accepts an earlier instant even when its offset timestamp sorts later as text', () => {
    const input = refundWithChronology({
      refundId: 'refund-current',
      providerCreatedAt: '2026-08-12T00:00:00.000Z',
      earlierRefundId: 'refund-earlier',
      earlierProviderCreatedAt: '2026-08-12T01:00:00+02:00'
    });

    expect(buildRefundAllocationPlan(input).plans[0].expectedEffectMinor).toBe(-100);
  });

  it('rejects a later instant even when its offset timestamp sorts earlier as text', () => {
    const input = refundWithChronology({
      refundId: 'refund-current',
      providerCreatedAt: '2026-08-12T00:00:00.000Z',
      earlierRefundId: 'refund-not-earlier',
      earlierProviderCreatedAt: '2026-08-11T23:30:00-02:00'
    });

    expect(() => buildRefundAllocationPlan(input)).toThrow(/financial reconciliation/i);
  });

  it('breaks equivalent-instant ties by refund ID rather than timestamp representation', () => {
    const input = refundWithChronology({
      refundId: 'z-refund',
      providerCreatedAt: '2026-08-12T00:00:00.000Z',
      earlierRefundId: 'a-refund',
      earlierProviderCreatedAt: '2026-08-12T01:00:00+01:00'
    });

    expect(buildRefundAllocationPlan(input).plans[0].expectedEffectMinor).toBe(-100);
  });

  it('uses locale-independent codepoint order for equal-instant refund IDs', () => {
    const input = refundWithChronology({
      refundId: '\u00e9-refund',
      providerCreatedAt: '2026-08-12T00:00:00.000Z',
      earlierRefundId: 'e\u0301-refund',
      earlierProviderCreatedAt: '2026-08-12T00:00:00.000Z'
    });

    expect(buildRefundAllocationPlan(input).plans[0].expectedEffectMinor).toBe(-100);
  });

  it('orders BMP and supplementary refund IDs by Unicode code point at equal instants', () => {
    const input = refundWithChronology({
      refundId: '\u{10000}-refund',
      providerCreatedAt: '2026-08-12T00:00:00.000Z',
      earlierRefundId: '\uE000-refund',
      earlierProviderCreatedAt: '2026-08-12T01:00:00+01:00'
    });

    expect(buildRefundAllocationPlan(input).plans[0].expectedEffectMinor).toBe(-100);
  });

  it('rejects duplicate chronology facts expressed with equivalent timestamps', () => {
    const input = refundWithChronology({
      refundId: 'refund-current',
      providerCreatedAt: '2026-08-13T00:00:00.000Z',
      earlierRefundId: 'refund-duplicate',
      earlierProviderCreatedAt: '2026-08-12T00:00:00.000Z'
    });
    const earlier = input.earlierFinalized![0]!;

    expect(() => buildRefundAllocationPlan({
      ...input,
      earlierFinalized: [
        earlier,
        { ...earlier, providerCreatedAt: '2026-08-12T01:00:00+01:00' }
      ]
    })).toThrow(/financial reconciliation/i);
  });

  it('rejects component totals that do not equal presentment, including with FX', () => {
    expect(() => buildRefundAllocationPlan({
      ...base,
      settlementCurrency: 'EUR',
      amountMinor: -470,
      feeMinor: 0,
      netMinor: -470,
      feeDetails: [],
      attribution: { kind: 'finalized', components: [
        { orderItemId: 'item-a', subtotalMinor: 300, taxMinor: 100, remainingSubtotalCapacityMinor: 300, remainingTaxCapacityMinor: 100, presentmentCurrency: 'USD' }
      ] }
    })).toThrow(/financial reconciliation/i);
  });

  it('uses permanent safe errors without a cause for invalid refund facts', () => {
    try {
      buildRefundAllocationPlan({ ...base, presentmentCurrency: 'usd' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toMatchObject({ name: 'PermanentFinancialError', safeCode: 'currency_mismatch' });
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('uses currency_mismatch for a failed-refund original in another settlement currency', () => {
    const original: FinancialAllocationPlan = {
      allocationIdentity: 'refund:original:gross', balanceTransactionId: 'bt-original',
      basis: 'gross_amount', scope: 'account', currency: 'EUR', expectedEffectMinor: -500,
      algorithmVersion: 1, sourceFingerprint: 'c'.repeat(64), supersedesSetId: null,
      reversalOfSetId: null, items: []
    };
    try {
      buildFailedRefundAllocationPlan({
        ...base, amountMinor: 500, feeMinor: 0, netMinor: 500, feeDetails: [],
        originalGrossSetId: 'set-original-gross', originalGrossPlan: original,
        originalFeeSetId: null, originalFeePlan: null
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toMatchObject({ name: 'PermanentFinancialError', safeCode: 'currency_mismatch' });
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('falls back to immutable payment subtotals for a tax-only refund fee', () => {
    const { plans: [, fee] } = buildRefundAllocationPlan({
      ...base,
      presentmentAmountMinor: 100,
      amountMinor: -100,
      netMinor: -110,
      attribution: { kind: 'finalized', components: [
        { orderItemId: 'item-a', subtotalMinor: 0, taxMinor: 100, remainingSubtotalCapacityMinor: 0, remainingTaxCapacityMinor: 100, presentmentCurrency: 'USD' }
      ] }
    });
    expect(fee.items.map((item) => [item.orderItemId, item.effectMinor])).toEqual([
      ['item-a', -7], ['item-b', -3]
    ]);
  });

  it('keeps a zero fee explicit and empty', () => {
    const { plans: [, fee] } = buildRefundAllocationPlan({ ...base, feeMinor: 0, netMinor: -500, feeDetails: [] });
    expect(fee).toMatchObject({ basis: 'fee', scope: 'title', expectedEffectMinor: 0, items: [] });
  });

  it('exactly negates a complete persisted title refund', () => {
    const original: FinancialAllocationPlan = {
      allocationIdentity: 'refund:original:gross', balanceTransactionId: 'bt-original',
      basis: 'gross_amount', scope: 'title', currency: 'USD', expectedEffectMinor: -500,
      algorithmVersion: 1, sourceFingerprint: 'c'.repeat(64), supersedesSetId: null, reversalOfSetId: null,
      items: [
        { orderItemId: 'item-a', component: 'refund_subtotal', effectMinor: -300, currency: 'USD', tieBreakKey: 'a' },
        { orderItemId: 'item-b', component: 'refund_tax', effectMinor: -200, currency: 'USD', tieBreakKey: 'b' }
      ]
    };
    const { plans: [gross] } = buildFailedRefundAllocationPlan({
      ...base, amountMinor: 500, feeMinor: 0, netMinor: 500, feeDetails: [],
      originalGrossSetId: 'exact-gross', originalGrossPlan: original, originalFeeSetId: null, originalFeePlan: null
    });
    expect(gross).toMatchObject({ scope: 'title', reversalOfSetId: 'exact-gross', expectedEffectMinor: 500 });
    expect(gross.items.map((item) => item.effectMinor)).toEqual([300, 200]);
  });

  it('allows only an exact account cancellation and refuses unresolved or chained originals', () => {
    const account: FinancialAllocationPlan = {
      allocationIdentity: 'refund:original:account', balanceTransactionId: 'bt-original',
      basis: 'gross_amount', scope: 'account', currency: 'USD', expectedEffectMinor: -500,
      algorithmVersion: 1, sourceFingerprint: 'c'.repeat(64), supersedesSetId: null, reversalOfSetId: null, items: []
    };
    const input: FailedRefundAllocationInput = {
      ...base, amountMinor: 500, feeMinor: 0, netMinor: 500, feeDetails: [],
      originalGrossSetId: 'account-gross', originalGrossPlan: account, originalFeeSetId: null, originalFeePlan: null
    };
    const { plans: [gross] } = buildFailedRefundAllocationPlan(input);
    expect(gross).toMatchObject({ scope: 'account', items: [], reversalOfSetId: 'account-gross' });
    expect(() => buildFailedRefundAllocationPlan({ ...input, amountMinor: 499, netMinor: 499 })).toThrow(/financial reconciliation/i);
    expect(() => buildFailedRefundAllocationPlan({ ...input, originalGrossPlan: { ...account, scope: 'unresolved' } })).toThrow(/financial reconciliation/i);
    expect(() => buildFailedRefundAllocationPlan({ ...input, originalGrossPlan: { ...account, reversalOfSetId: 'older-set' } })).toThrow(/financial reconciliation/i);
    expect(() => buildFailedRefundAllocationPlan({ ...input, originalGrossSetId: '' })).toThrow(/financial reconciliation/i);
  });

  it('supports 0- and 3-decimal currency integer amounts without mutating the input', () => {
    const input: RefundAllocationInput = {
      ...base,
      settlementCurrency: 'BHD', presentmentCurrency: 'BHD', presentmentAmountMinor: 1001,
      amountMinor: -1001, feeMinor: 0, netMinor: -1001, feeDetails: [],
      attribution: { kind: 'finalized', components: [
        { orderItemId: 'item-a', subtotalMinor: 1001, taxMinor: 0, remainingSubtotalCapacityMinor: 1001, remainingTaxCapacityMinor: 0, presentmentCurrency: 'BHD' }
      ] },
      paymentItems: [{ orderItemId: 'item-a', subtotalMinor: 1001, currency: 'BHD' }]
    };
    const before = structuredClone(input);
    expect(buildRefundAllocationPlan(input).plans[0].expectedEffectMinor).toBe(-1001);
    expect(input).toEqual(before);
    expect(buildRefundAllocationPlan({
      ...input,
      settlementCurrency: 'JPY', presentmentCurrency: 'JPY', presentmentAmountMinor: 100,
      amountMinor: -100, netMinor: -100,
      attribution: { kind: 'finalized', components: [
        { orderItemId: 'item-a', subtotalMinor: 100, taxMinor: 0, remainingSubtotalCapacityMinor: 100, remainingTaxCapacityMinor: 0, presentmentCurrency: 'JPY' }
      ] },
      paymentItems: [{ orderItemId: 'item-a', subtotalMinor: 100, currency: 'JPY' }]
    }).plans[0].expectedEffectMinor).toBe(-100);
  });

  it('validates original fee provenance but independently allocates the failed-refund provider fee', () => {
    const originalGrossPlan: FinancialAllocationPlan = {
      allocationIdentity: 'refund:original:gross', balanceTransactionId: 'bt-original',
      basis: 'gross_amount', scope: 'title', currency: 'USD', expectedEffectMinor: -500,
      algorithmVersion: 1, sourceFingerprint: 'c'.repeat(64), supersedesSetId: null,
      reversalOfSetId: null,
      items: [
        { orderItemId: 'item-a', component: 'refund_subtotal', effectMinor: -300, currency: 'USD', tieBreakKey: 'item-a' },
        { orderItemId: 'item-b', component: 'refund_subtotal', effectMinor: -200, currency: 'USD', tieBreakKey: 'item-b' }
      ]
    };
    const originalFeePlan: FinancialAllocationPlan = {
      allocationIdentity: 'refund:original:fee', balanceTransactionId: 'bt-original',
      basis: 'fee', scope: 'title', currency: 'USD', expectedEffectMinor: -10,
      algorithmVersion: 1, sourceFingerprint: 'c'.repeat(64), supersedesSetId: null,
      reversalOfSetId: null,
      items: [
        { orderItemId: 'item-a', component: 'refund_fee', effectMinor: -1, currency: 'USD', tieBreakKey: 'item-a:refund_fee' },
        { orderItemId: 'item-b', component: 'refund_fee', effectMinor: -9, currency: 'USD', tieBreakKey: 'item-b:refund_fee' }
      ]
    };
    const failed: FailedRefundAllocationInput = {
      ...base,
      balanceTransactionId: 'bt-failed-refund',
      allocationIdentityPrefix: 'refund:failed:bt-failed-refund',
      amountMinor: 500,
      feeMinor: 10,
      netMinor: 490,
      originalGrossSetId: 'set-original-gross',
      originalGrossPlan,
      originalFeeSetId: 'set-original-fee',
      originalFeePlan
    };

    const { plans: [, fee] } = buildFailedRefundAllocationPlan(failed);

    expect(fee.reversalOfSetId).toBeNull();
    expect(fee.items.map(({ orderItemId, effectMinor }) => ({ orderItemId, effectMinor }))).toEqual([
      { orderItemId: 'item-a', effectMinor: -7 },
      { orderItemId: 'item-b', effectMinor: -3 }
    ]);
  });

  describe('original fee evidence validation', () => {
    const originalGrossPlan: FinancialAllocationPlan = {
      allocationIdentity: 'refund:original:gross', balanceTransactionId: 'bt-original',
      basis: 'gross_amount', scope: 'title', currency: 'USD', expectedEffectMinor: -500,
      algorithmVersion: 1, sourceFingerprint: 'c'.repeat(64), supersedesSetId: null,
      reversalOfSetId: null,
      items: [
        { orderItemId: 'item-a', component: 'refund_subtotal', effectMinor: -300, currency: 'USD', tieBreakKey: 'item-a' },
        { orderItemId: 'item-b', component: 'refund_subtotal', effectMinor: -200, currency: 'USD', tieBreakKey: 'item-b' }
      ]
    };
    const originalFeePlan: FinancialAllocationPlan = {
      allocationIdentity: 'refund:original:fee', balanceTransactionId: 'bt-original',
      basis: 'fee', scope: 'title', currency: 'USD', expectedEffectMinor: -10,
      algorithmVersion: 1, sourceFingerprint: 'c'.repeat(64), supersedesSetId: null,
      reversalOfSetId: null,
      items: [
        { orderItemId: 'item-a', component: 'refund_fee', effectMinor: -7, currency: 'USD', tieBreakKey: 'item-a:refund_fee' },
        { orderItemId: 'item-b', component: 'refund_fee', effectMinor: -3, currency: 'USD', tieBreakKey: 'item-b:refund_fee' }
      ]
    };
    const valid: FailedRefundAllocationInput = {
      ...base,
      balanceTransactionId: 'bt-failed-refund',
      allocationIdentityPrefix: 'refund:failed:bt-failed-refund',
      amountMinor: 500,
      feeMinor: 10,
      netMinor: 490,
      originalGrossSetId: 'set-original-gross',
      originalGrossPlan,
      originalFeeSetId: 'set-original-fee',
      originalFeePlan
    };
    const cases: readonly {
      readonly name: string;
      readonly input: FailedRefundAllocationInput;
      readonly safeCode: 'allocation_mismatch' | 'currency_mismatch' | 'source_linkage_mismatch';
    }[] = [
      { name: 'set without plan', input: { ...valid, originalFeePlan: null }, safeCode: 'source_linkage_mismatch' },
      { name: 'plan without set', input: { ...valid, originalFeeSetId: null }, safeCode: 'source_linkage_mismatch' },
      { name: 'empty set id', input: { ...valid, originalFeeSetId: '' }, safeCode: 'source_linkage_mismatch' },
      { name: 'wrong basis', input: { ...valid, originalFeePlan: { ...originalFeePlan, basis: 'gross_amount' } }, safeCode: 'source_linkage_mismatch' },
      {
        name: 'wrong currency',
        input: {
          ...valid,
          originalFeePlan: {
            ...originalFeePlan,
            currency: 'EUR',
            items: originalFeePlan.items.map((item) => ({ ...item, currency: 'EUR' }))
          }
        },
        safeCode: 'currency_mismatch'
      },
      { name: 'account scope', input: { ...valid, originalFeePlan: { ...originalFeePlan, scope: 'account', items: [] } }, safeCode: 'source_linkage_mismatch' },
      { name: 'unresolved scope', input: { ...valid, originalFeePlan: { ...originalFeePlan, scope: 'unresolved', items: [] } }, safeCode: 'source_linkage_mismatch' },
      { name: 'already reverses', input: { ...valid, originalFeePlan: { ...originalFeePlan, reversalOfSetId: 'older-fee-set' } }, safeCode: 'source_linkage_mismatch' },
      { name: 'already supersedes', input: { ...valid, originalFeePlan: { ...originalFeePlan, supersedesSetId: 'older-fee-set' } }, safeCode: 'source_linkage_mismatch' },
      { name: 'wrong balance transaction', input: { ...valid, originalFeePlan: { ...originalFeePlan, balanceTransactionId: 'bt-other' } }, safeCode: 'source_linkage_mismatch' },
      { name: 'wrong source fingerprint', input: { ...valid, originalFeePlan: { ...originalFeePlan, sourceFingerprint: 'd'.repeat(64) } }, safeCode: 'source_linkage_mismatch' },
      { name: 'wrong algorithm version', input: { ...valid, originalFeePlan: { ...originalFeePlan, algorithmVersion: 2 } }, safeCode: 'source_linkage_mismatch' },
      {
        name: 'nonconserving plan',
        input: { ...valid, originalFeePlan: { ...originalFeePlan, items: originalFeePlan.items.slice(0, 1) } },
        safeCode: 'allocation_mismatch'
      },
      {
        name: 'duplicate item component',
        input: {
          ...valid,
          originalFeePlan: {
            ...originalFeePlan,
            items: [
              { ...originalFeePlan.items[0]!, effectMinor: -5 },
              { ...originalFeePlan.items[0]!, effectMinor: -5, tieBreakKey: 'item-a:refund_fee:duplicate' }
            ]
          }
        },
        safeCode: 'allocation_mismatch'
      }
    ];

    it.each(cases)('rejects $name with a safe permanent error', (testCase) => {
      try {
        buildFailedRefundAllocationPlan(testCase.input);
        throw new Error(`expected ${testCase.name} to fail`);
      } catch (error) {
        expect(error, testCase.name).toMatchObject({
          name: 'PermanentFinancialError',
          safeCode: testCase.safeCode
        });
        expect((error as Error).cause, testCase.name).toBeUndefined();
      }
    });
  });
});
