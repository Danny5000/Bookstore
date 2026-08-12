import { describe, expect, it } from 'vitest';
import { PermanentFinancialError } from '../errors';
import type { FinancialAllocationPlan } from '../types';
import { buildDisputeAllocationPlan } from './dispute';
import type { DisputeAllocationInput } from './types';

type PresentmentEffect = {
  readonly allocationId: string;
  readonly withdrawalSetId: string;
  readonly disputeId: string;
  readonly providerCreatedAt: string;
  readonly providerTransactionId: string;
  readonly orderItemId: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly presentmentCurrency: string;
  readonly effect: 'withdrawal' | 'reinstatement';
  readonly reversalOfAllocationId: string | null;
};

type DisputeResult = ReturnType<typeof buildDisputeAllocationPlan> & {
  readonly presentmentEffects: readonly PresentmentEffect[];
};

function build(input: Record<string, unknown>): DisputeResult {
  return buildDisputeAllocationPlan(input as unknown as DisputeAllocationInput) as DisputeResult;
}

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceKind: 'dispute', sourceId: 'dispute-1', disputeId: 'dispute-1',
    balanceTransactionId: 'bt-withdrawal-1', providerTransactionId: 'txn-withdrawal-1',
    providerCreatedAt: '2026-08-01T00:00:00.000Z',
    allocationIdentityPrefix: 'dispute:dispute-1:bt-withdrawal-1', settlementCurrency: 'USD',
    amountMinor: -600, feeMinor: 15, netMinor: -615,
    sourceFingerprint: 'd'.repeat(64), algorithmVersion: 1,
    supersedesGrossSetId: null, supersedesFeeSetId: null,
    effect: 'withdrawal', disputeAmountMinor: 600, presentmentAmountMinor: 600,
    presentmentCurrency: 'USD',
    paymentItems: [
      { orderItemId: 'item-a', subtotalMinor: 700, taxMinor: 70, presentmentCurrency: 'USD' },
      { orderItemId: 'item-b', subtotalMinor: 300, taxMinor: 30, presentmentCurrency: 'USD' }
    ],
    finalizedRefunds: [{
      refundId: 'refund-1', providerCreatedAt: '2026-07-01T00:00:00.000Z',
      orderItemId: 'item-a', subtotalMinor: 100, taxMinor: 10, presentmentCurrency: 'USD'
    }],
    priorPresentmentEffects: [],
    withdrawalSetId: 'set-withdrawal-1',
    reversesSetId: null, reversesFeeSetId: null,
    withdrawalGrossPlan: null, withdrawalFeePlan: null,
    feeDetails: [{ component: 'dispute_fee', amountMinor: -15 }],
    ...overrides
  };
}

function persistedWithdrawal(): FinancialAllocationPlan {
  return {
    allocationIdentity: 'dispute:dispute-1:bt-withdrawal-1:gross', balanceTransactionId: 'bt-withdrawal-1',
    basis: 'gross_amount', scope: 'title', currency: 'USD', expectedEffectMinor: -600,
    algorithmVersion: 1, sourceFingerprint: 'e'.repeat(64), supersedesSetId: null, reversalOfSetId: null,
    items: [
      { orderItemId: 'item-a', component: 'dispute_subtotal', effectMinor: -420, currency: 'USD', tieBreakKey: 'item-a:subtotal' },
      { orderItemId: 'item-b', component: 'dispute_subtotal', effectMinor: -180, currency: 'USD', tieBreakKey: 'item-b:subtotal' }
    ]
  };
}

function priorWithdrawalEffects(): PresentmentEffect[] {
  return [
    { allocationId: 'withdrawal-a', withdrawalSetId: 'set-withdrawal-1', disputeId: 'dispute-1', providerCreatedAt: '2026-08-01T00:00:00.000Z', providerTransactionId: 'txn-withdrawal-1', orderItemId: 'item-a', subtotalMinor: -420, taxMinor: 0, presentmentCurrency: 'USD', effect: 'withdrawal', reversalOfAllocationId: null },
    { allocationId: 'withdrawal-b', withdrawalSetId: 'set-withdrawal-1', disputeId: 'dispute-1', providerCreatedAt: '2026-08-01T00:00:00.000Z', providerTransactionId: 'txn-withdrawal-1', orderItemId: 'item-b', subtotalMinor: -180, taxMinor: 0, presentmentCurrency: 'USD', effect: 'withdrawal', reversalOfAllocationId: null }
  ];
}

function expectSafeFailure(action: () => unknown, safeCode: 'allocation_mismatch' | 'currency_mismatch' | 'source_linkage_mismatch'): void {
  try {
    action();
    throw new Error('expected financial error');
  } catch (error) {
    expect(error).toBeInstanceOf(PermanentFinancialError);
    expect(error).toMatchObject({ safeCode });
    expect(error).not.toHaveProperty('cause');
  }
}

describe('buildDisputeAllocationPlan', () => {
  it('derives withdrawal exposure from payment, finalized refund, and ordered prior effects', () => {
    const input = baseInput({
      balanceTransactionId: 'bt-withdrawal-2', providerTransactionId: 'txn-withdrawal-2', providerCreatedAt: '2026-08-03T00:00:00.000Z', allocationIdentityPrefix: 'dispute:dispute-1:bt-withdrawal-2', withdrawalSetId: 'set-withdrawal-2',
      remainingExposure: [{ orderItemId: 'forged', subtotalMinor: 999_999, taxMinor: 0, currency: 'USD' }],
      priorPresentmentEffects: [
        ...priorWithdrawalEffects(),
        { allocationId: 'restore-a', withdrawalSetId: 'set-withdrawal-1', disputeId: 'dispute-1', providerCreatedAt: '2026-08-02T00:00:00.000Z', providerTransactionId: 'txn-reinstate-1', orderItemId: 'item-a', subtotalMinor: 120, taxMinor: 0, presentmentCurrency: 'USD', effect: 'reinstatement', reversalOfAllocationId: 'withdrawal-a' }
      ],
      disputeAmountMinor: 310,
      presentmentAmountMinor: 310,
      amountMinor: -310, feeMinor: 0, netMinor: -310, feeDetails: []
    });
    const result = build(input);
    expect(result.plans[0].items.map(({ orderItemId, component, effectMinor }) => ({ orderItemId, component, effectMinor }))).toEqual([
      { orderItemId: 'item-a', component: 'dispute_subtotal', effectMinor: -182 },
      { orderItemId: 'item-a', component: 'dispute_tax', effectMinor: -37 },
      { orderItemId: 'item-b', component: 'dispute_subtotal', effectMinor: -73 },
      { orderItemId: 'item-b', component: 'dispute_tax', effectMinor: -18 }
    ]);
    expect(result.presentmentEffects.map(({ orderItemId, subtotalMinor, taxMinor }) => ({ orderItemId, subtotalMinor, taxMinor }))).toEqual([
      { orderItemId: 'item-a', subtotalMinor: -182, taxMinor: -37 },
      { orderItemId: 'item-b', subtotalMinor: -73, taxMinor: -18 }
    ]);
  });

  it('rejects cumulative overexposure but permits an earlier exact reinstatement to restore capacity', () => {
    const history = priorWithdrawalEffects();
    expectSafeFailure(() => build(baseInput({ balanceTransactionId: 'bt-withdrawal-2', providerTransactionId: 'txn-withdrawal-2', providerCreatedAt: '2026-08-03T00:00:00.000Z', allocationIdentityPrefix: 'dispute:dispute-1:bt-withdrawal-2', withdrawalSetId: 'set-withdrawal-2', priorPresentmentEffects: history, disputeAmountMinor: 431, presentmentAmountMinor: 431, amountMinor: -431, feeMinor: 0, netMinor: -431, feeDetails: [] })), 'allocation_mismatch');
    const result = build(baseInput({
      priorPresentmentEffects: [...history, { allocationId: 'restore-a', withdrawalSetId: 'set-withdrawal-1', disputeId: 'dispute-1', providerCreatedAt: '2026-08-02T00:00:00.000Z', providerTransactionId: 'txn-reinstate-1', orderItemId: 'item-a', subtotalMinor: 120, taxMinor: 0, presentmentCurrency: 'USD', effect: 'reinstatement', reversalOfAllocationId: 'withdrawal-a' }],
      balanceTransactionId: 'bt-withdrawal-2', providerTransactionId: 'txn-withdrawal-2', providerCreatedAt: '2026-08-03T00:00:00.000Z', allocationIdentityPrefix: 'dispute:dispute-1:bt-withdrawal-2', withdrawalSetId: 'set-withdrawal-2',
      disputeAmountMinor: 430, presentmentAmountMinor: 430, amountMinor: -430, feeMinor: 0, netMinor: -430, feeDetails: []
    }));
    expect(result.plans[0].expectedEffectMinor).toBe(-430);
  });

  it('orders a valid offset timestamp by its instant instead of its raw text', () => {
    const result = build(baseInput({
      balanceTransactionId: 'bt-after-offset', providerTransactionId: 'txn-after-offset',
      providerCreatedAt: '2026-08-01T00:00:00.000Z',
      allocationIdentityPrefix: 'dispute:dispute-1:bt-after-offset',
      withdrawalSetId: 'set-after-offset', amountMinor: -390, feeMinor: 0, netMinor: -390,
      disputeAmountMinor: 390, presentmentAmountMinor: 390, feeDetails: [],
      priorPresentmentEffects: priorWithdrawalEffects().map((effect) => ({
        ...effect,
        providerCreatedAt: '2026-08-01T01:00:00.000+02:00'
      }))
    }));

    expect(result.plans[0].expectedEffectMinor).toBe(-390);
  });

  it('rejects a duplicate finalized refund fact written with an equivalent offset timestamp', () => {
    const refund = {
      refundId: 'refund-equivalent', providerCreatedAt: '2026-07-01T00:00:00.000Z',
      orderItemId: 'item-a', subtotalMinor: 100, taxMinor: 10,
      presentmentCurrency: 'USD'
    };
    expectSafeFailure(() => build(baseInput({
      feeMinor: 0, netMinor: -600, feeDetails: [],
      finalizedRefunds: [
        refund,
        { ...refund, providerCreatedAt: '2026-06-30T20:00:00.000-04:00' }
      ]
    })), 'allocation_mismatch');
  });

  it('orders equivalent instants by provider transaction ID using Unicode code points', () => {
    const prior: PresentmentEffect[] = [
      {
        allocationId: 'allocation-withdrawal', withdrawalSetId: 'set-prior',
        disputeId: 'dispute-prior', providerCreatedAt: '2026-08-01T00:00:00.000Z',
        providerTransactionId: 'txn-\uE000', orderItemId: 'item-a', subtotalMinor: -100,
        taxMinor: 0, presentmentCurrency: 'USD', effect: 'withdrawal',
        reversalOfAllocationId: null
      },
      {
        allocationId: 'allocation-reinstatement', withdrawalSetId: 'set-prior',
        disputeId: 'dispute-prior', providerCreatedAt: '2026-08-01T00:00:00.000Z',
        providerTransactionId: 'txn-\u{10000}', orderItemId: 'item-a', subtotalMinor: 100,
        taxMinor: 0, presentmentCurrency: 'USD', effect: 'reinstatement',
        reversalOfAllocationId: 'allocation-withdrawal'
      }
    ];
    const result = build(baseInput({
      balanceTransactionId: 'bt-after-transaction-tie', providerTransactionId: 'txn-current',
      providerCreatedAt: '2026-08-02T00:00:00.000Z',
      allocationIdentityPrefix: 'dispute:dispute-1:bt-after-transaction-tie',
      withdrawalSetId: 'set-after-transaction-tie', amountMinor: -990, feeMinor: 0,
      netMinor: -990, disputeAmountMinor: 990, presentmentAmountMinor: 990,
      feeDetails: [], priorPresentmentEffects: prior
    }));

    expect(result.plans[0].expectedEffectMinor).toBe(-990);
  });

  it('replays same-kind allocation ID code-point ties at equivalent instants', () => {
    const prior: PresentmentEffect[] = [
      {
        allocationId: 'allocation-\uE000', withdrawalSetId: 'set-prior',
        disputeId: 'dispute-prior', providerCreatedAt: '2026-08-01T00:00:00.000Z',
        providerTransactionId: 'txn-equivalent', orderItemId: 'item-a', subtotalMinor: -100,
        taxMinor: 0, presentmentCurrency: 'USD', effect: 'withdrawal',
        reversalOfAllocationId: null
      },
      {
        allocationId: 'allocation-\u{10000}', withdrawalSetId: 'set-prior',
        disputeId: 'dispute-prior', providerCreatedAt: '2026-07-31T20:00:00.000-04:00',
        providerTransactionId: 'txn-equivalent', orderItemId: 'item-b', subtotalMinor: -100,
        taxMinor: 0, presentmentCurrency: 'USD', effect: 'withdrawal',
        reversalOfAllocationId: null
      }
    ];
    const result = build(baseInput({
      balanceTransactionId: 'bt-after-allocation-tie', providerTransactionId: 'txn-current',
      providerCreatedAt: '2026-08-02T00:00:00.000Z',
      allocationIdentityPrefix: 'dispute:dispute-1:bt-after-allocation-tie',
      withdrawalSetId: 'set-after-allocation-tie', amountMinor: -790, feeMinor: 0,
      netMinor: -790, disputeAmountMinor: 790, presentmentAmountMinor: 790,
      feeDetails: [], priorPresentmentEffects: prior
    }));

    expect(result.plans[0].expectedEffectMinor).toBe(-790);
  });

  it('rejects conflicting effect kinds for one transaction at equivalent instants', () => {
    const withdrawal: PresentmentEffect = {
      allocationId: 'allocation-a', withdrawalSetId: 'set-prior',
      disputeId: 'dispute-prior', providerCreatedAt: '2026-08-01T00:00:00.000Z',
      providerTransactionId: 'txn-conflict', orderItemId: 'item-a', subtotalMinor: -100,
      taxMinor: 0, presentmentCurrency: 'USD', effect: 'withdrawal',
      reversalOfAllocationId: null
    };
    expectSafeFailure(() => build(baseInput({
      balanceTransactionId: 'bt-after-conflict', providerTransactionId: 'txn-current',
      providerCreatedAt: '2026-08-02T00:00:00.000Z',
      allocationIdentityPrefix: 'dispute:dispute-1:bt-after-conflict',
      withdrawalSetId: 'set-after-conflict', amountMinor: -990, feeMinor: 0,
      netMinor: -990, disputeAmountMinor: 990, presentmentAmountMinor: 990,
      feeDetails: [],
      priorPresentmentEffects: [
        withdrawal,
        {
          ...withdrawal, allocationId: 'allocation-b',
          providerCreatedAt: '2026-07-31T20:00:00.000-04:00', subtotalMinor: 100,
          effect: 'reinstatement', reversalOfAllocationId: 'allocation-a'
        }
      ]
    })), 'source_linkage_mismatch');
  });

  it('keeps presentment and settlement domains separate for same-currency and FX withdrawals', () => {
    expectSafeFailure(() => build(baseInput({ amountMinor: -599, feeMinor: 0, netMinor: -599, feeDetails: [] })), 'allocation_mismatch');
    const result = build(baseInput({ settlementCurrency: 'JPY', amountMinor: -93_000, feeMinor: 0, netMinor: -93_000, feeDetails: [] }));
    expect(result.plans[0].currency).toBe('JPY');
    expect(result.plans[0].expectedEffectMinor).toBe(-93_000);
  });

  it('requires exact persisted withdrawal evidence for full and partial reinstatement', () => {
    const original = persistedWithdrawal();
    const exact = build(baseInput({
      effect: 'reinstatement', balanceTransactionId: 'bt-reinstatement-1', providerTransactionId: 'txn-reinstatement-1', providerCreatedAt: '2026-08-03T00:00:00.000Z', allocationIdentityPrefix: 'dispute:dispute-1:bt-reinstatement-1',
      amountMinor: 600, feeMinor: 0, netMinor: 600, disputeAmountMinor: 600, presentmentAmountMinor: 600, feeDetails: [],
      reversesSetId: 'set-withdrawal-1', withdrawalSetId: null, withdrawalGrossPlan: original,
      priorPresentmentEffects: priorWithdrawalEffects()
    }));
    expect(exact.plans[0].reversalOfSetId).toBe('set-withdrawal-1');
    expect(exact.plans[0].items.map((item) => item.effectMinor)).toEqual([420, 180]);
    expect(exact.presentmentEffects.map((row) => row.reversalOfAllocationId)).toEqual(['withdrawal-a', 'withdrawal-b']);

    const partial = build(baseInput({
      effect: 'reinstatement', balanceTransactionId: 'bt-reinstatement-2', providerTransactionId: 'txn-reinstatement-2', providerCreatedAt: '2026-08-03T00:00:00.000Z', allocationIdentityPrefix: 'dispute:dispute-1:bt-reinstatement-2',
      amountMinor: 300, feeMinor: 0, netMinor: 300, disputeAmountMinor: 300, presentmentAmountMinor: 300, feeDetails: [],
      reversesSetId: 'set-withdrawal-1', withdrawalSetId: null, withdrawalGrossPlan: original,
      priorPresentmentEffects: priorWithdrawalEffects()
    }));
    expect(partial.plans[0].items.map((item) => item.effectMinor)).toEqual([210, 90]);

    expectSafeFailure(() => build(baseInput({
      effect: 'reinstatement', balanceTransactionId: 'bt-reinstatement-over', providerTransactionId: 'txn-reinstatement-over', providerCreatedAt: '2026-08-03T00:00:00.000Z', allocationIdentityPrefix: 'dispute:dispute-1:bt-reinstatement-over',
      amountMinor: 601, feeMinor: 0, netMinor: 601, disputeAmountMinor: 601, presentmentAmountMinor: 601, feeDetails: [],
      reversesSetId: 'set-withdrawal-1', withdrawalSetId: null, withdrawalGrossPlan: original,
      priorPresentmentEffects: priorWithdrawalEffects()
    })), 'allocation_mismatch');
  });

  it('omits zero reinstatement effects so a one-cent partial result can be replayed', () => {
    const partial = build(baseInput({
      effect: 'reinstatement', balanceTransactionId: 'bt-reinstatement-cent',
      providerTransactionId: 'txn-reinstatement-cent', providerCreatedAt: '2026-08-03T00:00:00.000Z',
      allocationIdentityPrefix: 'dispute:dispute-1:bt-reinstatement-cent',
      amountMinor: 1, feeMinor: 0, netMinor: 1, disputeAmountMinor: 1,
      presentmentAmountMinor: 1, feeDetails: [], reversesSetId: 'set-withdrawal-1',
      withdrawalSetId: null, withdrawalGrossPlan: persistedWithdrawal(),
      priorPresentmentEffects: priorWithdrawalEffects()
    }));

    expect(partial.presentmentEffects).toHaveLength(1);
    expect(partial.presentmentEffects[0]).toMatchObject({
      orderItemId: 'item-a', subtotalMinor: 1, taxMinor: 0,
      reversalOfAllocationId: 'withdrawal-a'
    });

    const later = build(baseInput({
      balanceTransactionId: 'bt-withdrawal-after-cent',
      providerTransactionId: 'txn-withdrawal-after-cent',
      providerCreatedAt: '2026-08-04T00:00:00.000Z',
      allocationIdentityPrefix: 'dispute:dispute-1:bt-withdrawal-after-cent',
      withdrawalSetId: 'set-withdrawal-after-cent', amountMinor: -391,
      feeMinor: 0, netMinor: -391, disputeAmountMinor: 391,
      presentmentAmountMinor: 391, feeDetails: [],
      priorPresentmentEffects: [...priorWithdrawalEffects(), ...partial.presentmentEffects]
    }));
    expect(later.plans[0].expectedEffectMinor).toBe(-391);
    expect(later.presentmentEffects.reduce(
      (sum, effect) => sum + effect.subtotalMinor + effect.taxMinor,
      0
    )).toBe(-391);
  });

  it('rejects cross-dispute, missing, duplicate, chained, or wrong-currency reversal references', () => {
    const reinstatement = {
      effect: 'reinstatement', balanceTransactionId: 'bt-reinstatement', providerTransactionId: 'txn-reinstatement', providerCreatedAt: '2026-08-03T00:00:00.000Z', allocationIdentityPrefix: 'dispute:dispute-1:bt-reinstatement',
      amountMinor: 300, feeMinor: 0, netMinor: 300, disputeAmountMinor: 300, presentmentAmountMinor: 300, feeDetails: [],
      reversesSetId: 'set-withdrawal-1', withdrawalSetId: null, withdrawalGrossPlan: persistedWithdrawal(), priorPresentmentEffects: priorWithdrawalEffects()
    };
    expectSafeFailure(() => build(baseInput({ ...reinstatement, priorPresentmentEffects: priorWithdrawalEffects().map((row) => ({ ...row, disputeId: 'other-dispute' })) })), 'source_linkage_mismatch');
    expectSafeFailure(() => build(baseInput({ ...reinstatement, priorPresentmentEffects: [] })), 'source_linkage_mismatch');
    expectSafeFailure(() => build(baseInput({ ...reinstatement, priorPresentmentEffects: [...priorWithdrawalEffects(), { ...priorWithdrawalEffects()[0]!, allocationId: 'already-reversed', providerCreatedAt: '2026-08-02T00:00:00.000Z', providerTransactionId: 'txn-reinstate', subtotalMinor: 1, effect: 'reinstatement', reversalOfAllocationId: 'withdrawal-a' }] })), 'source_linkage_mismatch');
    expectSafeFailure(() => build(baseInput({ ...reinstatement, withdrawalGrossPlan: { ...persistedWithdrawal(), currency: 'EUR', items: persistedWithdrawal().items.map((item) => ({ ...item, currency: 'EUR' })) } })), 'currency_mismatch');
  });

  it('uses signed dispute-fee details, supports a positive fee-credit movement, and keeps zero fee explicit', () => {
    const withdrawal = build(baseInput());
    expect(withdrawal.plans[1].items.reduce((sum, item) => sum + item.effectMinor, 0)).toBe(-15);
    expect(withdrawal.plans[1].items.every((item) => item.component === 'dispute_fee')).toBe(true);
    const credit = build(baseInput({
      effect: 'fee_credit', balanceTransactionId: 'bt-fee-credit', providerTransactionId: 'txn-fee-credit', providerCreatedAt: '2026-08-03T00:00:00.000Z', allocationIdentityPrefix: 'dispute:dispute-1:bt-fee-credit',
      amountMinor: 15, feeMinor: 0, netMinor: 15, disputeAmountMinor: 15, presentmentAmountMinor: 15, feeDetails: [],
      reversesSetId: null, reversesFeeSetId: 'set-withdrawal-fee', withdrawalSetId: null, withdrawalGrossPlan: null,
      withdrawalFeePlan: { ...persistedWithdrawal(), basis: 'fee', expectedEffectMinor: -15, items: [{ orderItemId: 'item-a', component: 'dispute_fee', effectMinor: -15, currency: 'USD', tieBreakKey: 'item-a:dispute_fee' }] }
    }));
    expect(credit.plans[0]).toMatchObject({ basis: 'gross_amount', expectedEffectMinor: 15, reversalOfSetId: 'set-withdrawal-fee' });
    expect(credit.plans[0].items.every((item) => item.component === 'fee_credit' && item.effectMinor > 0)).toBe(true);
    expect(credit.plans[1].items).toEqual([]);
    expect(build(baseInput({ feeMinor: 0, netMinor: -600, feeDetails: [] })).plans[1].items).toEqual([]);
  });

  it('falls back to immutable payment subtotals for a tax-only multi-title dispute fee', () => {
    const { plans: [gross, fee] } = build(baseInput({
      amountMinor: -100, feeMinor: 7, netMinor: -107,
      disputeAmountMinor: 100, presentmentAmountMinor: 100,
      finalizedRefunds: [
        { refundId: 'refund-subtotal', providerCreatedAt: '2026-07-01T00:00:00.000Z', orderItemId: 'item-a', subtotalMinor: 700, taxMinor: 0, presentmentCurrency: 'USD' },
        { refundId: 'refund-subtotal', providerCreatedAt: '2026-07-01T00:00:00.000Z', orderItemId: 'item-b', subtotalMinor: 300, taxMinor: 0, presentmentCurrency: 'USD' }
      ],
      feeDetails: [{ component: 'dispute_fee', amountMinor: -7 }]
    }));

    expect(gross.items.map(({ orderItemId, component, effectMinor }) => ({ orderItemId, component, effectMinor }))).toEqual([
      { orderItemId: 'item-a', component: 'dispute_tax', effectMinor: -70 },
      { orderItemId: 'item-b', component: 'dispute_tax', effectMinor: -30 }
    ]);
    expect(fee.items.map(({ orderItemId, component, effectMinor }) => ({ orderItemId, component, effectMinor }))).toEqual([
      { orderItemId: 'item-a', component: 'dispute_fee', effectMinor: -5 },
      { orderItemId: 'item-b', component: 'dispute_fee', effectMinor: -2 }
    ]);
  });

  it('rejects a tax-only multi-title dispute fee without immutable positive subtotal weights', () => {
    expectSafeFailure(() => build(baseInput({
      amountMinor: -100, feeMinor: 7, netMinor: -107,
      disputeAmountMinor: 100, presentmentAmountMinor: 100,
      paymentItems: [
        { orderItemId: 'item-a', subtotalMinor: 0, taxMinor: 70, presentmentCurrency: 'USD' },
        { orderItemId: 'item-b', subtotalMinor: 0, taxMinor: 30, presentmentCurrency: 'USD' }
      ],
      finalizedRefunds: [],
      feeDetails: [{ component: 'dispute_fee', amountMinor: -7 }]
    })), 'allocation_mismatch');
  });

  it('rejects unsafe/ambiguous shapes and does not mutate caller evidence', () => {
    const input = baseInput({
      presentmentCurrency: 'BHD', settlementCurrency: 'BHD', amountMinor: -600, feeMinor: 0, netMinor: -600, feeDetails: [],
      paymentItems: [
        { orderItemId: 'item-a', subtotalMinor: 700, taxMinor: 70, presentmentCurrency: 'BHD' },
        { orderItemId: 'item-b', subtotalMinor: 300, taxMinor: 30, presentmentCurrency: 'BHD' }
      ],
      finalizedRefunds: [{ refundId: 'refund-1', providerCreatedAt: '2026-07-01T00:00:00.000Z', orderItemId: 'item-a', subtotalMinor: 100, taxMinor: 10, presentmentCurrency: 'BHD' }]
    });
    const before = structuredClone(input);
    expect(build(input).plans[0].currency).toBe('BHD');
    expect(input).toEqual(before);
    expectSafeFailure(() => build(baseInput({ effect: 'unknown', feeMinor: 0, netMinor: -600, feeDetails: [] })), 'allocation_mismatch');
    expectSafeFailure(() => build(baseInput({ providerCreatedAt: 'not-a-date', feeMinor: 0, netMinor: -600, feeDetails: [] })), 'source_linkage_mismatch');
    expectSafeFailure(() => build(baseInput({ paymentItems: [{ orderItemId: 'item-a', subtotalMinor: 1.5, taxMinor: 0, presentmentCurrency: 'USD' }], feeMinor: 0, netMinor: -600, feeDetails: [] })), 'allocation_mismatch');
  });
});
