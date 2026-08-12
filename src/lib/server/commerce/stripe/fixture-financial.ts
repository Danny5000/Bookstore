import {
  PermanentCommerceError,
  RetryableProviderError
} from '$lib/server/commerce/errors';
import {
  parseBalanceTransactionSnapshot,
  parseChargeSnapshot,
  parseFinancialProviderId,
  parsePayoutSnapshot,
  parseStripeListPage,
  parseStripePageRequest
} from './financial-schemas';
import type {
  BalanceTransactionSnapshot,
  ChargeSnapshot,
  PayoutSnapshot,
  StripeListPage,
  StripePageRequest
} from './financial-types';

export type StripeFinancialFixtureOperation =
  | 'retrieveCharge'
  | 'retrieveBalanceTransaction'
  | 'retrievePayout'
  | 'listBalanceTransactionsForSource'
  | 'listBalanceTransactionsForPayout'
  | 'listPayouts';

export interface StripeFinancialFixtureGateway {
  retrieveCharge(id: string): Promise<ChargeSnapshot>;
  retrieveBalanceTransaction(id: string): Promise<BalanceTransactionSnapshot>;
  retrievePayout(id: string): Promise<PayoutSnapshot>;
  listBalanceTransactionsForSource(
    sourceId: string,
    request: StripePageRequest
  ): Promise<StripeListPage<BalanceTransactionSnapshot>>;
  listBalanceTransactionsForPayout(
    payoutId: string,
    request: StripePageRequest
  ): Promise<StripeListPage<BalanceTransactionSnapshot>>;
  listPayouts(request: StripePageRequest): Promise<StripeListPage<PayoutSnapshot>>;
}

export interface StripeFinancialFixtureHarness {
  setCharge(value: unknown): void;
  setBalanceTransaction(value: unknown): void;
  setPayout(value: unknown): void;
  setBalanceTransactionsForSource(sourceId: string, values: readonly unknown[]): void;
  setBalanceTransactionsForPayout(payoutId: string, values: readonly unknown[]): void;
  setPayouts(values: readonly unknown[]): void;
  failNextFinancialOperation(
    operation: StripeFinancialFixtureOperation,
    failure: 'retryable' | 'permanent'
  ): void;
  resetFinancial(): void;
}

export interface StripeFinancialFixture {
  gateway: StripeFinancialFixtureGateway;
  harness: StripeFinancialFixtureHarness;
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function assertUniqueIds(values: readonly { id: string }[]): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) {
    throw new PermanentCommerceError();
  }
}

function createdSeconds(value: { createdAt: Date }): number {
  return Math.floor(value.createdAt.getTime() / 1000);
}

function page<Value extends { id: string; createdAt: Date }>(
  values: readonly Value[],
  untrustedRequest: StripePageRequest,
  itemParser: (value: unknown) => Value
): StripeListPage<Value> {
  const request = parseStripePageRequest(untrustedRequest);
  const filtered = values.filter((value) => {
    const created = createdSeconds(value);
    return (request.createdGte === undefined || created >= request.createdGte) &&
      (request.createdLt === undefined || created < request.createdLt);
  });
  const start = (() => {
    if (request.startingAfter === undefined) return 0;
    const index = filtered.findIndex((value) => value.id === request.startingAfter);
    if (index < 0) throw new PermanentCommerceError();
    return index + 1;
  })();
  const data = filtered.slice(start, start + request.limit);
  const hasMore = start + data.length < filtered.length;
  const result = parseStripeListPage({
    data,
    hasMore,
    nextStartingAfter: hasMore ? data.at(-1)?.id ?? null : null
  }, itemParser);
  return clone(result);
}

export function createFixtureStripeFinancialEvidence(): StripeFinancialFixture {
  const charges = new Map<string, ChargeSnapshot>();
  const balanceTransactions = new Map<string, BalanceTransactionSnapshot>();
  const payouts = new Map<string, PayoutSnapshot>();
  const sourcePages = new Map<string, readonly BalanceTransactionSnapshot[]>();
  const payoutPages = new Map<string, readonly BalanceTransactionSnapshot[]>();
  let payoutList: readonly PayoutSnapshot[] = [];
  const failures = new Map<StripeFinancialFixtureOperation, 'retryable' | 'permanent'>();
  const parseBalanceTransaction = (value: unknown) =>
    parseBalanceTransactionSnapshot(value, false);
  const parseCharge = (value: unknown) => parseChargeSnapshot(value, false);
  const parsePayout = (value: unknown) => parsePayoutSnapshot(value, false);

  function failIfConfigured(operation: StripeFinancialFixtureOperation): void {
    const failure = failures.get(operation);
    if (failure === undefined) return;
    failures.delete(operation);
    if (failure === 'retryable') throw new RetryableProviderError();
    throw new PermanentCommerceError();
  }

  const gateway: StripeFinancialFixtureGateway = {
    async retrieveCharge(untrustedId) {
      const id = parseFinancialProviderId(untrustedId);
      failIfConfigured('retrieveCharge');
      const value = charges.get(id);
      if (!value) throw new PermanentCommerceError();
      return clone(value);
    },
    async retrieveBalanceTransaction(untrustedId) {
      const id = parseFinancialProviderId(untrustedId);
      failIfConfigured('retrieveBalanceTransaction');
      const value = balanceTransactions.get(id);
      if (!value) throw new PermanentCommerceError();
      return clone(value);
    },
    async retrievePayout(untrustedId) {
      const id = parseFinancialProviderId(untrustedId);
      failIfConfigured('retrievePayout');
      const value = payouts.get(id);
      if (!value) throw new PermanentCommerceError();
      return clone(value);
    },
    async listBalanceTransactionsForSource(untrustedSourceId, request) {
      const sourceId = parseFinancialProviderId(untrustedSourceId);
      failIfConfigured('listBalanceTransactionsForSource');
      return page(sourcePages.get(sourceId) ?? [], request, parseBalanceTransaction);
    },
    async listBalanceTransactionsForPayout(untrustedPayoutId, request) {
      const payoutId = parseFinancialProviderId(untrustedPayoutId);
      failIfConfigured('listBalanceTransactionsForPayout');
      return page(payoutPages.get(payoutId) ?? [], request, parseBalanceTransaction);
    },
    async listPayouts(request) {
      failIfConfigured('listPayouts');
      return page(payoutList, request, parsePayout);
    }
  };

  const harness: StripeFinancialFixtureHarness = {
    setCharge(value) {
      const parsed = parseCharge(value);
      charges.set(parsed.id, clone(parsed));
    },
    setBalanceTransaction(value) {
      const parsed = parseBalanceTransaction(value);
      balanceTransactions.set(parsed.id, clone(parsed));
    },
    setPayout(value) {
      const parsed = parsePayout(value);
      payouts.set(parsed.id, clone(parsed));
    },
    setBalanceTransactionsForSource(untrustedSourceId, values) {
      const sourceId = parseFinancialProviderId(untrustedSourceId);
      const parsed = values.map(parseBalanceTransaction);
      assertUniqueIds(parsed);
      if (parsed.some((value) => value.sourceId !== sourceId)) {
        throw new PermanentCommerceError();
      }
      sourcePages.set(sourceId, clone(parsed));
    },
    setBalanceTransactionsForPayout(untrustedPayoutId, values) {
      const payoutId = parseFinancialProviderId(untrustedPayoutId);
      const parsed = values.map(parseBalanceTransaction);
      assertUniqueIds(parsed);
      payoutPages.set(payoutId, clone(parsed));
    },
    setPayouts(values) {
      const parsed = values.map(parsePayout);
      assertUniqueIds(parsed);
      payoutList = clone(parsed);
    },
    failNextFinancialOperation(operation, failure) {
      if (![
        'retrieveCharge',
        'retrieveBalanceTransaction',
        'retrievePayout',
        'listBalanceTransactionsForSource',
        'listBalanceTransactionsForPayout',
        'listPayouts'
      ].includes(operation) || !['retryable', 'permanent'].includes(failure)) {
        throw new PermanentCommerceError();
      }
      failures.set(operation, failure);
    },
    resetFinancial() {
      charges.clear();
      balanceTransactions.clear();
      payouts.clear();
      sourcePages.clear();
      payoutPages.clear();
      payoutList = [];
      failures.clear();
    }
  };

  return { gateway, harness };
}
