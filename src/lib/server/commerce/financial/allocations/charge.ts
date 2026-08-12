import type { ChargeAllocationInput, FinancialAllocationPlanBundle } from './types';
import { PermanentFinancialError } from '../errors';
import { allocateComponents, allocateFeeDetails, assertCurrency, assertSafeMoney, basePlan } from './common';

export function buildChargeAllocationPlan(
  input: ChargeAllocationInput
): FinancialAllocationPlanBundle {
  assertCurrency(input.settlementCurrency);
  assertSafeMoney(input.amountMinor);
  assertSafeMoney(input.feeMinor);
  assertSafeMoney(input.netMinor);
  if (input.amountMinor < 0 || input.feeMinor < 0 || input.items.length === 0) {
    throw new PermanentFinancialError('allocation_mismatch');
  }
  if (BigInt(input.amountMinor) - BigInt(input.feeMinor) !== BigInt(input.netMinor)) {
    throw new PermanentFinancialError('allocation_mismatch');
  }
  const grossComponents = input.items.flatMap((item) => {
    assertCurrency(item.presentmentCurrency);
    if (
      item.orderItemId.length === 0 ||
      item.subtotalMinor < 0 ||
      item.taxMinor < 0
    ) throw new PermanentFinancialError('allocation_mismatch');
    assertSafeMoney(item.subtotalMinor);
    assertSafeMoney(item.taxMinor);
    return [
      ...(item.subtotalMinor === 0 ? [] : [{
        orderItemId: item.orderItemId,
        component: 'sale_subtotal' as const,
        weightMinor: item.subtotalMinor,
        tieBreakKey: `${item.orderItemId}:subtotal`
      }]),
      ...(item.taxMinor === 0 ? [] : [{
        orderItemId: item.orderItemId,
        component: 'sale_tax' as const,
        weightMinor: item.taxMinor,
        tieBreakKey: `${item.orderItemId}:tax`
      }])
    ];
  });
  const presentmentCurrencies = new Set(input.items.map((item) => item.presentmentCurrency));
  if (presentmentCurrencies.size !== 1) throw new PermanentFinancialError('currency_mismatch');
  const [presentmentCurrency] = presentmentCurrencies;
  if (
    presentmentCurrency === input.settlementCurrency &&
    grossComponents.reduce((sum, item) => sum + BigInt(item.weightMinor), 0n) !== BigInt(input.amountMinor)
  ) {
    throw new PermanentFinancialError('allocation_mismatch');
  }
  const grossItems = input.amountMinor === 0
    ? []
    : allocateComponents(input.amountMinor, input.settlementCurrency, grossComponents);
  const feeItems = allocateFeeDetails(
    input.feeMinor,
    input.settlementCurrency,
    input.items.map((item) => ({
      orderItemId: item.orderItemId,
      subtotalMinor: item.subtotalMinor,
      currency: input.settlementCurrency
    })),
    input.feeDetails
  );
  return { plans: [
    basePlan(input, {
      basis: 'gross_amount', scope: 'title', expectedEffectMinor: input.amountMinor, items: grossItems
    }),
    basePlan(input, {
      basis: 'fee', scope: 'title', expectedEffectMinor: input.feeMinor === 0 ? 0 : -input.feeMinor,
      items: feeItems
    })
  ] };
}
