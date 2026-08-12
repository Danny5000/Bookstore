import { describe, expect, it } from 'vitest';
import { PermanentFinancialError } from '../errors';
import { buildChargeAllocationPlan } from './charge';
import type { ChargeAllocationInput } from './types';

const input: ChargeAllocationInput = {
  sourceKind: 'payment',
  sourceId: 'payment-1',
  balanceTransactionId: 'bt-charge-1',
  allocationIdentityPrefix: 'payment:payment-1:bt-charge-1',
  settlementCurrency: 'USD',
  amountMinor: 1100,
  feeMinor: 59,
  netMinor: 1041,
  sourceFingerprint: 'a'.repeat(64),
  algorithmVersion: 1,
  supersedesGrossSetId: null,
  supersedesFeeSetId: null,
  items: [
    { orderItemId: 'item-a', subtotalMinor: 600, taxMinor: 60, presentmentCurrency: 'USD' },
    { orderItemId: 'item-b', subtotalMinor: 400, taxMinor: 40, presentmentCurrency: 'USD' }
  ],
  feeDetails: [{ component: 'processing_fee', amountMinor: -59 }]
};

describe('buildChargeAllocationPlan', () => {
  it('allocates gross by subtotal and tax components, fees by subtotal, and conserves net', () => {
    const { plans: [gross, fee] } = buildChargeAllocationPlan(input);
    expect(gross).toMatchObject({
      allocationIdentity: 'payment:payment-1:bt-charge-1:gross',
      basis: 'gross_amount', scope: 'title', currency: 'USD', expectedEffectMinor: 1100,
      reversalOfSetId: null
    });
    expect(gross.items).toEqual([
      { orderItemId: 'item-a', component: 'sale_subtotal', effectMinor: 600, currency: 'USD', tieBreakKey: 'item-a:subtotal' },
      { orderItemId: 'item-a', component: 'sale_tax', effectMinor: 60, currency: 'USD', tieBreakKey: 'item-a:tax' },
      { orderItemId: 'item-b', component: 'sale_subtotal', effectMinor: 400, currency: 'USD', tieBreakKey: 'item-b:subtotal' },
      { orderItemId: 'item-b', component: 'sale_tax', effectMinor: 40, currency: 'USD', tieBreakKey: 'item-b:tax' }
    ]);
    expect(fee).toMatchObject({
      allocationIdentity: 'payment:payment-1:bt-charge-1:fee',
      basis: 'fee', scope: 'title', currency: 'USD', expectedEffectMinor: -59,
      reversalOfSetId: null
    });
    expect(fee.items).toEqual([
      { orderItemId: 'item-a', component: 'processing_fee', effectMinor: -35, currency: 'USD', tieBreakKey: 'item-a:processing_fee' },
      { orderItemId: 'item-b', component: 'processing_fee', effectMinor: -24, currency: 'USD', tieBreakKey: 'item-b:processing_fee' }
    ]);
    expect(gross.expectedEffectMinor + fee.expectedEffectMinor).toBe(1041);
  });

  it('keeps a zero-fee plan and falls back to the only item for fee weights', () => {
    const { plans: [, fee] } = buildChargeAllocationPlan({
      ...input,
      amountMinor: 0,
      feeMinor: 0,
      netMinor: 0,
      items: [{ orderItemId: 'item-only', subtotalMinor: 0, taxMinor: 0, presentmentCurrency: 'JPY' }],
      settlementCurrency: 'JPY',
      feeDetails: []
    });
    expect(fee).toMatchObject({ basis: 'fee', scope: 'title', expectedEffectMinor: 0, currency: 'JPY' });
    expect(fee.items).toEqual([]);
  });

  it('allocates a nonzero signed fee to the only zero-subtotal item', () => {
    const { plans: [gross, fee] } = buildChargeAllocationPlan({
      ...input,
      amountMinor: 0,
      feeMinor: 9,
      netMinor: -9,
      items: [
        { orderItemId: 'item-only', subtotalMinor: 0, taxMinor: 0, presentmentCurrency: 'USD' }
      ],
      feeDetails: [{ component: 'processing_fee', amountMinor: -9 }]
    });

    expect(gross.items).toEqual([]);
    expect(fee).toMatchObject({ expectedEffectMinor: -9, currency: 'USD' });
    expect(fee.items).toEqual([
      {
        orderItemId: 'item-only',
        component: 'processing_fee',
        effectMinor: -9,
        currency: 'USD',
        tieBreakKey: 'item-only:processing_fee'
      }
    ]);
  });

  it('rejects a nonzero fee across multiple all-zero-subtotal items', () => {
    const invalid: ChargeAllocationInput = {
      ...input,
      amountMinor: 0,
      feeMinor: 9,
      netMinor: -9,
      items: [
        { orderItemId: 'item-a', subtotalMinor: 0, taxMinor: 0, presentmentCurrency: 'USD' },
        { orderItemId: 'item-b', subtotalMinor: 0, taxMinor: 0, presentmentCurrency: 'USD' }
      ],
      feeDetails: [{ component: 'processing_fee', amountMinor: -9 }]
    };

    try {
      buildChargeAllocationPlan(invalid);
      throw new Error('expected charge allocation to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentFinancialError);
      expect(error).toMatchObject({ safeCode: 'allocation_mismatch' });
      expect(error).not.toHaveProperty('cause');
    }
  });

  it.each([
    ['mixed presentment currency', { ...input, items: [{ ...input.items[0]!, presentmentCurrency: 'EUR' }, input.items[1]!] }],
    ['gross mismatch', { ...input, amountMinor: 1101, netMinor: 1042 }],
    ['bad net', { ...input, netMinor: 1042 }],
    ['fee detail mismatch', { ...input, feeDetails: [{ component: 'other' as const, amountMinor: -58 }] }]
  ])('rejects %s', (_label, invalid) => {
    try {
      buildChargeAllocationPlan(invalid);
      throw new Error('expected charge allocation to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentFinancialError);
      expect(error).not.toHaveProperty('cause');
    }
  });

  it('accepts FX settlement without cross-summing presentment totals', () => {
    const result = buildChargeAllocationPlan({
      ...input,
      amountMinor: 1000,
      feeMinor: 50,
      netMinor: 950,
      items: input.items.map((item) => ({ ...item, presentmentCurrency: 'EUR' })),
      feeDetails: [{ component: 'processing_fee', amountMinor: -50 }]
    });
    expect(result.plans[0].expectedEffectMinor).toBe(1000);
  });

  it('aggregates duplicate fee components before allocating one row per item/component', () => {
    const { plans: [, fee] } = buildChargeAllocationPlan({
      ...input,
      feeDetails: [
        { component: 'processing_fee', amountMinor: -30 },
        { component: 'processing_fee', amountMinor: -29 }
      ]
    });
    expect(fee.items).toEqual([
      { orderItemId: 'item-a', component: 'processing_fee', effectMinor: -35, currency: 'USD', tieBreakKey: 'item-a:processing_fee' },
      { orderItemId: 'item-b', component: 'processing_fee', effectMinor: -24, currency: 'USD', tieBreakKey: 'item-b:processing_fee' }
    ]);
  });
});
