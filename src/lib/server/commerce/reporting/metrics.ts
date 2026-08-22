import type {
  PublicFinancialState,
  SalesCurrencySummaryDto,
  SoldAsTitleVariantDto,
  TitleFormat,
  TitleSalesRowDto
} from '$lib/types/financial-reporting';
import type { AllocationBasis, AllocationScope, FinancialComponent } from '../financial/types';

export type SalesTitleMetricDto = TitleSalesRowDto;

export type SalesTitleMetricSourceKind = 'payment' | 'refund' | 'dispute' | 'adjustment';
export type SalesTitleMetricAvailability =
  | 'complete'
  | 'missing'
  | 'conflicting'
  | 'unresolved'
  | 'incompatible';

export interface SalesTitleMetricEffect {
  readonly component: FinancialComponent;
  readonly effectMinor: number;
}

export interface SalesTitleMetricContributor {
  readonly balanceTransactionId: string;
  readonly algorithmVersion: number;
  readonly basis: AllocationBasis;
  readonly sourceKind: SalesTitleMetricSourceKind;
  readonly scope: AllocationScope;
  readonly settlementCurrency: string | null;
  readonly state: PublicFinancialState;
  readonly availability: SalesTitleMetricAvailability;
  readonly missingSourceCount: number;
  readonly effects: readonly SalesTitleMetricEffect[];
}

export interface SalesTitleMetricInput {
  readonly titleId: string;
  readonly currentTitle: string;
  readonly format: TitleFormat;
  readonly archived: boolean;
  readonly soldAsVariants: readonly SoldAsTitleVariantDto[];
  readonly presentmentCurrency: string;
  readonly settlementCurrency: string | null;
  readonly soldCopies: number;
  readonly fullyRefundedCopies: number;
  readonly grossPresentmentMinor: number;
  readonly finalizedRefundPresentmentMinor: number;
  readonly disputeWithdrawalPresentmentMinor: number;
  readonly disputeReinstatementPresentmentMinor: number;
  readonly freshnessAt: string;
  readonly contributors: readonly SalesTitleMetricContributor[];
}

class SalesMetricError extends Error {
  constructor() {
    super('Sales metrics are unavailable.');
    this.name = 'SalesMetricError';
  }
}

type SettlementMetricKey =
  | 'grossSettlementMinor'
  | 'refundImpactMinor'
  | 'disputeImpactMinor'
  | 'processingFeeImpactMinor'
  | 'refundFeeImpactMinor'
  | 'disputeFeeImpactMinor'
  | 'otherFeeImpactMinor';

interface SettlementTotals {
  grossSettlementMinor: number;
  refundImpactMinor: number;
  disputeImpactMinor: number;
  processingFeeImpactMinor: number;
  refundFeeImpactMinor: number;
  disputeFeeImpactMinor: number;
  otherFeeImpactMinor: number;
}

interface CurrencySummaryAccumulator extends SettlementTotals {
  readonly presentmentCurrency: string;
  readonly settlementCurrency: string | null;
  readonly titleIds: Set<string>;
  soldCopies: number;
  fullyRefundedCopies: number;
  netCopies: number;
  grossPresentmentMinor: number;
  finalizedRefundPresentmentMinor: number;
  disputeWithdrawalPresentmentMinor: number;
  disputeReinstatementPresentmentMinor: number;
  estimatedPayoutMinor: number;
  settlementMetricsComplete: boolean;
  missingSourceCount: number;
  state: PublicFinancialState;
}

const CURRENCY = /^[A-Z]{3}$/u;
const COMPONENTS = new Set<FinancialComponent>([
  'sale_subtotal',
  'sale_tax',
  'processing_fee',
  'refund_subtotal',
  'refund_tax',
  'refund_fee',
  'refund_failure_reversal',
  'dispute_subtotal',
  'dispute_tax',
  'dispute_fee',
  'dispute_reinstatement',
  'provider_fee_tax',
  'fee_credit',
  'other'
]);
const SOURCE_KINDS = new Set<SalesTitleMetricSourceKind>([
  'payment',
  'refund',
  'dispute',
  'adjustment'
]);
const SCOPES = new Set<AllocationScope>(['title', 'account', 'unresolved']);
const BASES = new Set<AllocationBasis>(['gross_amount', 'fee']);
const AVAILABILITIES = new Set<SalesTitleMetricAvailability>([
  'complete',
  'missing',
  'conflicting',
  'unresolved',
  'incompatible'
]);
const STATES = new Set<PublicFinancialState>([
  'pending',
  'fee_reconciled',
  'payout_reconciled',
  'exception'
]);
const STATE_SEVERITY: Readonly<Record<PublicFinancialState, number>> = {
  payout_reconciled: 0,
  fee_reconciled: 1,
  pending: 2,
  exception: 3
};

function fail(): never {
  throw new SalesMetricError();
}

function safeInteger(value: number): number {
  if (!Number.isSafeInteger(value)) return fail();
  return value;
}

function safeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}

function add(left: number, right: number): number {
  const result = safeInteger(left) + safeInteger(right);
  if (!Number.isSafeInteger(result)) return fail();
  return result;
}

function currency(value: string): string {
  if (typeof value !== 'string' || !CURRENCY.test(value)) return fail();
  return value;
}

function optionalCurrency(value: string | null): string | null {
  return value === null ? null : currency(value);
}

function moreSevere(
  current: PublicFinancialState,
  candidate: PublicFinancialState
): PublicFinancialState {
  return STATE_SEVERITY[candidate] > STATE_SEVERITY[current] ? candidate : current;
}

function cloneSoldAsVariants(
  variants: readonly SoldAsTitleVariantDto[]
): readonly SoldAsTitleVariantDto[] {
  if (!Array.isArray(variants)) return fail();
  return variants.map((variant) => {
    if (
      variant === null ||
      typeof variant !== 'object' ||
      typeof variant.title !== 'string' ||
      typeof variant.creatorName !== 'string' ||
      (variant.format !== 'prose' && variant.format !== 'comic')
    ) {
      return fail();
    }
    return {
      title: variant.title,
      creatorName: variant.creatorName,
      format: variant.format
    };
  });
}

function validateContributor(contributor: SalesTitleMetricContributor): void {
  if (
    contributor === null ||
    typeof contributor !== 'object' ||
    typeof contributor.balanceTransactionId !== 'string' ||
    contributor.balanceTransactionId.length === 0 ||
    !Number.isSafeInteger(contributor.algorithmVersion) ||
    contributor.algorithmVersion < 1 ||
    !BASES.has(contributor.basis) ||
    !SOURCE_KINDS.has(contributor.sourceKind) ||
    !SCOPES.has(contributor.scope) ||
    !STATES.has(contributor.state) ||
    !AVAILABILITIES.has(contributor.availability) ||
    !Array.isArray(contributor.effects)
  ) {
    return fail();
  }
  optionalCurrency(contributor.settlementCurrency);
  safeCount(contributor.missingSourceCount);
  for (const effect of contributor.effects) {
    if (
      effect === null ||
      typeof effect !== 'object' ||
      Object.keys(effect).length !== 2 ||
      !Object.hasOwn(effect, 'component') ||
      !Object.hasOwn(effect, 'effectMinor') ||
      !COMPONENTS.has(effect.component)
    ) {
      return fail();
    }
    safeInteger(effect.effectMinor);
    if (effect.component === 'dispute_reinstatement' && effect.effectMinor < 0) return fail();
  }
}

function sourceSupportsComponent(
  sourceKind: SalesTitleMetricSourceKind,
  component: FinancialComponent
): boolean {
  if (sourceKind === 'adjustment') return false;
  switch (component) {
    case 'sale_subtotal':
    case 'sale_tax':
    case 'processing_fee':
      return sourceKind === 'payment';
    case 'refund_subtotal':
    case 'refund_tax':
    case 'refund_fee':
    case 'refund_failure_reversal':
      return sourceKind === 'refund';
    case 'dispute_subtotal':
    case 'dispute_tax':
    case 'dispute_fee':
    case 'dispute_reinstatement':
      return sourceKind === 'dispute';
    case 'provider_fee_tax':
    case 'fee_credit':
    case 'other':
      return true;
  }
}

function basisSupportsComponent(
  basis: AllocationBasis,
  component: FinancialComponent
): boolean {
  switch (component) {
    case 'sale_subtotal':
    case 'sale_tax':
    case 'refund_subtotal':
    case 'refund_tax':
    case 'refund_failure_reversal':
    case 'dispute_subtotal':
    case 'dispute_tax':
    case 'dispute_reinstatement':
      return basis === 'gross_amount';
    case 'processing_fee':
    case 'refund_fee':
    case 'dispute_fee':
    case 'provider_fee_tax':
    case 'other':
      return basis === 'fee';
    case 'fee_credit':
      return true;
  }
}

function sourceAwareFeeKey(
  sourceKind: Exclude<SalesTitleMetricSourceKind, 'adjustment'>
): SettlementMetricKey {
  switch (sourceKind) {
    case 'payment':
      return 'processingFeeImpactMinor';
    case 'refund':
      return 'refundFeeImpactMinor';
    case 'dispute':
      return 'disputeFeeImpactMinor';
  }
}

function metricKey(
  sourceKind: Exclude<SalesTitleMetricSourceKind, 'adjustment'>,
  component: FinancialComponent
): SettlementMetricKey | null {
  switch (component) {
    case 'sale_subtotal':
      return 'grossSettlementMinor';
    case 'refund_subtotal':
    case 'refund_failure_reversal':
      return 'refundImpactMinor';
    case 'dispute_subtotal':
    case 'dispute_reinstatement':
      return 'disputeImpactMinor';
    case 'processing_fee':
      return 'processingFeeImpactMinor';
    case 'refund_fee':
      return 'refundFeeImpactMinor';
    case 'dispute_fee':
      return 'disputeFeeImpactMinor';
    case 'provider_fee_tax':
    case 'fee_credit':
      return sourceAwareFeeKey(sourceKind);
    case 'other':
      return 'otherFeeImpactMinor';
    case 'sale_tax':
    case 'refund_tax':
    case 'dispute_tax':
      return null;
  }
}

function emptySettlementTotals(): SettlementTotals {
  return {
    grossSettlementMinor: 0,
    refundImpactMinor: 0,
    disputeImpactMinor: 0,
    processingFeeImpactMinor: 0,
    refundFeeImpactMinor: 0,
    disputeFeeImpactMinor: 0,
    otherFeeImpactMinor: 0
  };
}

function estimate(totals: SettlementTotals): number {
  return add(
    add(
      add(totals.grossSettlementMinor, totals.refundImpactMinor),
      add(totals.disputeImpactMinor, totals.processingFeeImpactMinor)
    ),
    add(
      add(totals.refundFeeImpactMinor, totals.disputeFeeImpactMinor),
      totals.otherFeeImpactMinor
    )
  );
}

function baseInput(input: SalesTitleMetricInput): {
  titleId: string;
  currentTitle: string;
  format: TitleFormat;
  archived: boolean;
  soldAsVariants: readonly SoldAsTitleVariantDto[];
  presentmentCurrency: string;
  settlementCurrency: string | null;
  soldCopies: number;
  fullyRefundedCopies: number;
  netCopies: number;
  grossPresentmentMinor: number;
  finalizedRefundPresentmentMinor: number;
  disputeWithdrawalPresentmentMinor: number;
  disputeReinstatementPresentmentMinor: number;
  freshnessAt: string;
} {
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof input.titleId !== 'string' ||
    input.titleId.length === 0 ||
    typeof input.currentTitle !== 'string' ||
    input.currentTitle.length === 0 ||
    (input.format !== 'prose' && input.format !== 'comic') ||
    typeof input.archived !== 'boolean' ||
    typeof input.freshnessAt !== 'string' ||
    input.freshnessAt.length === 0 ||
    !Array.isArray(input.contributors)
  ) {
    return fail();
  }

  const soldCopies = safeCount(input.soldCopies);
  const fullyRefundedCopies = safeCount(input.fullyRefundedCopies);
  if (fullyRefundedCopies > soldCopies) return fail();

  return {
    titleId: input.titleId,
    currentTitle: input.currentTitle,
    format: input.format,
    archived: input.archived,
    soldAsVariants: cloneSoldAsVariants(input.soldAsVariants),
    presentmentCurrency: currency(input.presentmentCurrency),
    settlementCurrency: optionalCurrency(input.settlementCurrency),
    soldCopies,
    fullyRefundedCopies,
    netCopies: safeCount(soldCopies - fullyRefundedCopies),
    grossPresentmentMinor: safeInteger(input.grossPresentmentMinor),
    finalizedRefundPresentmentMinor: safeInteger(input.finalizedRefundPresentmentMinor),
    disputeWithdrawalPresentmentMinor: safeInteger(input.disputeWithdrawalPresentmentMinor),
    disputeReinstatementPresentmentMinor: safeInteger(input.disputeReinstatementPresentmentMinor),
    freshnessAt: input.freshnessAt
  };
}

export function toSalesTitleMetricDto(input: SalesTitleMetricInput): SalesTitleMetricDto {
  const base = baseInput(input);
  const { freshnessAt, ...baseBeforeSettlement } = base;
  const titleContributors: SalesTitleMetricContributor[] = [];
  for (const contributor of input.contributors) {
    validateContributor(contributor);
    if (contributor.scope !== 'account' || contributor.sourceKind === 'payment') {
      titleContributors.push(contributor);
    }
  }
  if (titleContributors.length === 0) return fail();

  const contributorCounts = new Map<string, number>();
  for (const contributor of titleContributors) {
    const key = `${contributor.balanceTransactionId}\u0000${contributor.basis}`;
    contributorCounts.set(key, add(contributorCounts.get(key) ?? 0, 1));
  }

  const totals = emptySettlementTotals();
  let missingSourceCount = 0;
  let state: PublicFinancialState = 'payout_reconciled';
  const handledDuplicates = new Set<string>();

  for (const contributor of titleContributors) {
    const key = `${contributor.balanceTransactionId}\u0000${contributor.basis}`;
    if ((contributorCounts.get(key) ?? 0) > 1) {
      if (!handledDuplicates.has(key)) {
        handledDuplicates.add(key);
        missingSourceCount = add(missingSourceCount, 1);
        state = moreSevere(state, 'exception');
      }
      continue;
    }

    if (contributor.scope === 'unresolved') {
      missingSourceCount = add(
        missingSourceCount,
        contributor.missingSourceCount > 0 ? contributor.missingSourceCount : 1
      );
      state = moreSevere(
        state,
        contributor.state === 'exception' ? 'exception' : 'pending'
      );
      continue;
    }

    if (contributor.availability !== 'complete') {
      if (
        contributor.missingSourceCount < 1 ||
        (contributor.state !== 'pending' && contributor.state !== 'exception')
      ) {
        return fail();
      }
      missingSourceCount = add(missingSourceCount, contributor.missingSourceCount);
      const availabilityState =
        contributor.availability === 'conflicting' || contributor.availability === 'incompatible'
          ? 'exception'
          : 'pending';
      state = moreSevere(state, moreSevere(contributor.state, availabilityState));
      continue;
    }

    if (
      contributor.missingSourceCount !== 0 ||
      (contributor.state !== 'fee_reconciled' && contributor.state !== 'payout_reconciled')
    ) {
      return fail();
    }

    const incompatible =
      base.settlementCurrency === null ||
      (contributor.algorithmVersion !== 1 && contributor.algorithmVersion !== 2) ||
      (contributor.algorithmVersion === 1 && contributor.effects.some(
        (effect) => effect.component === 'dispute_reinstatement'
      )) ||
      contributor.settlementCurrency !== base.settlementCurrency ||
      (contributor.sourceKind === 'payment' && contributor.scope === 'account') ||
      contributor.sourceKind === 'adjustment' ||
      contributor.effects.some((effect) =>
        !sourceSupportsComponent(contributor.sourceKind, effect.component) ||
        !basisSupportsComponent(contributor.basis, effect.component)
      );
    if (incompatible) {
      missingSourceCount = add(missingSourceCount, 1);
      state = moreSevere(state, 'exception');
      continue;
    }

    state = moreSevere(state, contributor.state);
    for (const effect of contributor.effects) {
      const key = metricKey(contributor.sourceKind, effect.component);
      if (key !== null) totals[key] = add(totals[key], effect.effectMinor);
    }
  }

  if (missingSourceCount > 0) {
    if (state !== 'pending' && state !== 'exception') return fail();
    return {
      ...baseBeforeSettlement,
      grossSettlementMinor: null,
      refundImpactMinor: null,
      disputeImpactMinor: null,
      processingFeeImpactMinor: null,
      refundFeeImpactMinor: null,
      disputeFeeImpactMinor: null,
      otherFeeImpactMinor: null,
      estimatedPayoutMinor: null,
      settlementMetricsComplete: false,
      missingSourceCount,
      state,
      freshnessAt
    };
  }

  if (
    base.settlementCurrency === null ||
    (state !== 'fee_reconciled' && state !== 'payout_reconciled')
  ) {
    return fail();
  }
  return {
    ...baseBeforeSettlement,
    settlementCurrency: base.settlementCurrency,
    ...totals,
    estimatedPayoutMinor: estimate(totals),
    settlementMetricsComplete: true,
    missingSourceCount: 0,
    state,
    freshnessAt
  };
}

function validateSummaryRow(row: SalesTitleMetricDto): void {
  if (
    row === null ||
    typeof row !== 'object' ||
    typeof row.titleId !== 'string' ||
    row.titleId.length === 0 ||
    !STATES.has(row.state)
  ) {
    return fail();
  }
  currency(row.presentmentCurrency);
  optionalCurrency(row.settlementCurrency);
  safeCount(row.soldCopies);
  safeCount(row.fullyRefundedCopies);
  safeCount(row.netCopies);
  if (
    row.fullyRefundedCopies > row.soldCopies ||
    row.netCopies !== row.soldCopies - row.fullyRefundedCopies
  ) {
    return fail();
  }
  safeInteger(row.grossPresentmentMinor);
  safeInteger(row.finalizedRefundPresentmentMinor);
  safeInteger(row.disputeWithdrawalPresentmentMinor);
  safeInteger(row.disputeReinstatementPresentmentMinor);
  safeCount(row.missingSourceCount);

  if (row.settlementMetricsComplete) {
    if (
      row.settlementCurrency === null ||
      row.missingSourceCount !== 0 ||
      (row.state !== 'fee_reconciled' && row.state !== 'payout_reconciled')
    ) {
      return fail();
    }
    for (const key of [
      'grossSettlementMinor',
      'refundImpactMinor',
      'disputeImpactMinor',
      'processingFeeImpactMinor',
      'refundFeeImpactMinor',
      'disputeFeeImpactMinor',
      'otherFeeImpactMinor',
      'estimatedPayoutMinor'
    ] as const) {
      safeInteger(row[key]);
    }
    if (estimate(row) !== row.estimatedPayoutMinor) return fail();
    return;
  }

  if (
    row.missingSourceCount < 1 ||
    (row.state !== 'pending' && row.state !== 'exception') ||
    row.grossSettlementMinor !== null ||
    row.refundImpactMinor !== null ||
    row.disputeImpactMinor !== null ||
    row.processingFeeImpactMinor !== null ||
    row.refundFeeImpactMinor !== null ||
    row.disputeFeeImpactMinor !== null ||
    row.otherFeeImpactMinor !== null ||
    row.estimatedPayoutMinor !== null
  ) {
    return fail();
  }
}

function createAccumulator(row: SalesTitleMetricDto): CurrencySummaryAccumulator {
  return {
    presentmentCurrency: row.presentmentCurrency,
    settlementCurrency: row.settlementCurrency,
    titleIds: new Set<string>(),
    soldCopies: 0,
    fullyRefundedCopies: 0,
    netCopies: 0,
    grossPresentmentMinor: 0,
    finalizedRefundPresentmentMinor: 0,
    disputeWithdrawalPresentmentMinor: 0,
    disputeReinstatementPresentmentMinor: 0,
    ...emptySettlementTotals(),
    estimatedPayoutMinor: 0,
    settlementMetricsComplete: true,
    missingSourceCount: 0,
    state: 'payout_reconciled'
  };
}

function appendSummaryRow(
  accumulator: CurrencySummaryAccumulator,
  row: SalesTitleMetricDto
): void {
  if (accumulator.titleIds.has(row.titleId)) return fail();
  accumulator.titleIds.add(row.titleId);
  accumulator.soldCopies = add(accumulator.soldCopies, row.soldCopies);
  accumulator.fullyRefundedCopies = add(
    accumulator.fullyRefundedCopies,
    row.fullyRefundedCopies
  );
  accumulator.netCopies = add(accumulator.netCopies, row.netCopies);
  accumulator.grossPresentmentMinor = add(
    accumulator.grossPresentmentMinor,
    row.grossPresentmentMinor
  );
  accumulator.finalizedRefundPresentmentMinor = add(
    accumulator.finalizedRefundPresentmentMinor,
    row.finalizedRefundPresentmentMinor
  );
  accumulator.disputeWithdrawalPresentmentMinor = add(
    accumulator.disputeWithdrawalPresentmentMinor,
    row.disputeWithdrawalPresentmentMinor
  );
  accumulator.disputeReinstatementPresentmentMinor = add(
    accumulator.disputeReinstatementPresentmentMinor,
    row.disputeReinstatementPresentmentMinor
  );
  accumulator.missingSourceCount = add(
    accumulator.missingSourceCount,
    row.missingSourceCount
  );
  accumulator.state = moreSevere(accumulator.state, row.state);
  accumulator.settlementMetricsComplete &&= row.settlementMetricsComplete;

  if (!row.settlementMetricsComplete) return;
  accumulator.grossSettlementMinor = add(
    accumulator.grossSettlementMinor,
    row.grossSettlementMinor
  );
  accumulator.refundImpactMinor = add(accumulator.refundImpactMinor, row.refundImpactMinor);
  accumulator.disputeImpactMinor = add(accumulator.disputeImpactMinor, row.disputeImpactMinor);
  accumulator.processingFeeImpactMinor = add(
    accumulator.processingFeeImpactMinor,
    row.processingFeeImpactMinor
  );
  accumulator.refundFeeImpactMinor = add(
    accumulator.refundFeeImpactMinor,
    row.refundFeeImpactMinor
  );
  accumulator.disputeFeeImpactMinor = add(
    accumulator.disputeFeeImpactMinor,
    row.disputeFeeImpactMinor
  );
  accumulator.otherFeeImpactMinor = add(
    accumulator.otherFeeImpactMinor,
    row.otherFeeImpactMinor
  );
  accumulator.estimatedPayoutMinor = add(
    accumulator.estimatedPayoutMinor,
    row.estimatedPayoutMinor
  );
}

function toSummary(accumulator: CurrencySummaryAccumulator): SalesCurrencySummaryDto {
  const base = {
    presentmentCurrency: accumulator.presentmentCurrency,
    settlementCurrency: accumulator.settlementCurrency,
    titleCount: safeCount(accumulator.titleIds.size),
    soldCopies: accumulator.soldCopies,
    fullyRefundedCopies: accumulator.fullyRefundedCopies,
    netCopies: accumulator.netCopies,
    grossPresentmentMinor: accumulator.grossPresentmentMinor,
    finalizedRefundPresentmentMinor: accumulator.finalizedRefundPresentmentMinor,
    disputeWithdrawalPresentmentMinor: accumulator.disputeWithdrawalPresentmentMinor,
    disputeReinstatementPresentmentMinor: accumulator.disputeReinstatementPresentmentMinor
  };

  if (!accumulator.settlementMetricsComplete) {
    if (
      accumulator.missingSourceCount < 1 ||
      (accumulator.state !== 'pending' && accumulator.state !== 'exception')
    ) {
      return fail();
    }
    return {
      ...base,
      grossSettlementMinor: null,
      refundImpactMinor: null,
      disputeImpactMinor: null,
      processingFeeImpactMinor: null,
      refundFeeImpactMinor: null,
      disputeFeeImpactMinor: null,
      otherFeeImpactMinor: null,
      estimatedPayoutMinor: null,
      settlementMetricsComplete: false,
      missingSourceCount: accumulator.missingSourceCount,
      state: accumulator.state
    };
  }

  if (
    accumulator.settlementCurrency === null ||
    accumulator.missingSourceCount !== 0 ||
    (accumulator.state !== 'fee_reconciled' && accumulator.state !== 'payout_reconciled') ||
    estimate(accumulator) !== accumulator.estimatedPayoutMinor
  ) {
    return fail();
  }
  return {
    ...base,
    settlementCurrency: accumulator.settlementCurrency,
    grossSettlementMinor: accumulator.grossSettlementMinor,
    refundImpactMinor: accumulator.refundImpactMinor,
    disputeImpactMinor: accumulator.disputeImpactMinor,
    processingFeeImpactMinor: accumulator.processingFeeImpactMinor,
    refundFeeImpactMinor: accumulator.refundFeeImpactMinor,
    disputeFeeImpactMinor: accumulator.disputeFeeImpactMinor,
    otherFeeImpactMinor: accumulator.otherFeeImpactMinor,
    estimatedPayoutMinor: accumulator.estimatedPayoutMinor,
    settlementMetricsComplete: true,
    missingSourceCount: 0,
    state: accumulator.state
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function summarizeCurrencyPairs(
  rows: readonly SalesTitleMetricDto[]
): readonly SalesCurrencySummaryDto[] {
  if (!Array.isArray(rows)) return fail();
  const byPair = new Map<string, CurrencySummaryAccumulator>();
  for (const row of rows) {
    validateSummaryRow(row);
    const key = `${row.presentmentCurrency}\u0000${row.settlementCurrency ?? ''}`;
    const accumulator = byPair.get(key) ?? createAccumulator(row);
    appendSummaryRow(accumulator, row);
    byPair.set(key, accumulator);
  }

  return [...byPair.values()]
    .sort((left, right) =>
      compareText(left.presentmentCurrency, right.presentmentCurrency) ||
      compareText(left.settlementCurrency ?? '', right.settlementCurrency ?? '')
    )
    .map(toSummary);
}
