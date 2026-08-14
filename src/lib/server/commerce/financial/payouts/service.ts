import { createHash } from 'node:crypto';
import { PermanentCommerceError, RetryableProviderError } from '$lib/server/commerce/errors';
import {
  parseBalanceTransactionSnapshot,
  parsePayoutSnapshot,
  parseStripeListPage
} from '$lib/server/commerce/stripe/financial-schemas';
import type { BalanceTransactionSnapshot, PayoutSnapshot, StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import { PermanentFinancialError, RetryableFinancialError } from '../errors';
import {
  parseFinancialPayoutContinuationJobPayload,
  parseFinancialPayoutEventJobPayload,
  parseFinancialPayoutRelatedJobPayload,
  parseFinancialPayoutScanJobPayload,
  type FinancialPayoutJobPayload
} from '../jobs';
import { stageBalanceTransaction } from '../ledger';
import type { PayoutImportResult } from '../types';
import {
  loadPayoutGeneration,
  persistPayoutImportPage,
  publishPayoutMembership,
  stagePayoutSnapshot,
  startOrResumePayoutImport
} from './repository';

export interface ReconcileFinancialPayoutDependencies {
  readonly database: Database;
  readonly gateway: StripeCommerceGateway;
}

export interface ReconcileFinancialPayoutInput {
  readonly payload: FinancialPayoutJobPayload;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}

const SAFE_CORRELATION = /^[A-Za-z0-9:_-]{1,100}$/u;

function invalid(): never {
  throw new PermanentFinancialError('invalid_job_payload');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Financial payout reconciliation was aborted.', 'AbortError');
}

async function providerCall<Value>(signal: AbortSignal, work: () => Promise<Value>): Promise<Value> {
  throwIfAborted(signal);
  try {
    const value = await work();
    throwIfAborted(signal);
    return value;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof RetryableFinancialError) throw error;
    if (error instanceof RetryableProviderError) throw new RetryableFinancialError('provider_unavailable');
    if (error instanceof PermanentCommerceError) {
      throw new PermanentFinancialError('unsupported_provider_evidence');
    }
    throw new RetryableFinancialError('provider_unavailable');
  }
}

function parsePayload(value: unknown): FinancialPayoutJobPayload {
  try {
    const trigger = (value as { trigger?: { kind?: unknown } })?.trigger?.kind;
    if (trigger === 'event') return parseFinancialPayoutEventJobPayload(value);
    if (trigger === 'scan') return parseFinancialPayoutScanJobPayload(value);
    if (trigger === 'related') return parseFinancialPayoutRelatedJobPayload(value);
    if (trigger === 'continuation') return parseFinancialPayoutContinuationJobPayload(value);
  } catch (error) {
    if (error instanceof PermanentFinancialError) invalid();
  }
  return invalid();
}

function canonicalPayout(value: unknown): PayoutSnapshot {
  try {
    const liveMode = (value as { livemode?: unknown })?.livemode;
    if (typeof liveMode !== 'boolean') throw new PermanentCommerceError();
    return parsePayoutSnapshot(value, liveMode);
  } catch {
    throw new PermanentFinancialError('unsupported_provider_evidence');
  }
}

function canonicalBalance(value: unknown, expectedLiveMode: boolean): BalanceTransactionSnapshot {
  try {
    return parseBalanceTransactionSnapshot(value, expectedLiveMode);
  } catch {
    throw new PermanentFinancialError('unsupported_provider_evidence');
  }
}

function assertDirectPayoutBalance(payout: PayoutSnapshot, balance: BalanceTransactionSnapshot): void {
  if (balance.sourceFamily !== 'payout' || balance.sourceId !== payout.id ||
    balance.livemode !== payout.livemode || balance.currency !== payout.currency) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
}

function cursorDigest(cursor: string | null): string {
  return createHash('sha256').update(JSON.stringify(cursor)).digest('hex');
}

export async function reconcileFinancialPayout(
  dependencies: ReconcileFinancialPayoutDependencies,
  untrustedInput: ReconcileFinancialPayoutInput
): Promise<PayoutImportResult> {
  if (!untrustedInput || typeof untrustedInput !== 'object' ||
    Reflect.ownKeys(untrustedInput).length !== 3 ||
    !Object.hasOwn(untrustedInput, 'payload') || !Object.hasOwn(untrustedInput, 'correlationId') ||
    !Object.hasOwn(untrustedInput, 'signal') ||
    typeof untrustedInput.correlationId !== 'string' ||
    !SAFE_CORRELATION.test(untrustedInput.correlationId) ||
    !(untrustedInput.signal instanceof AbortSignal)) invalid();
  const input = {
    payload: parsePayload(untrustedInput.payload),
    correlationId: untrustedInput.correlationId,
    signal: untrustedInput.signal
  };
  throwIfAborted(input.signal);

  const expectedGeneration = await loadPayoutGeneration(
    dependencies.database,
    input.payload.providerPayoutId
  );
  throwIfAborted(input.signal);
  const payout = canonicalPayout(await providerCall(input.signal, () =>
    dependencies.gateway.retrievePayout(input.payload.providerPayoutId)
  ));
  if (payout.id !== input.payload.providerPayoutId) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }

  const directBalances: BalanceTransactionSnapshot[] = [];
  for (const providerId of [payout.balanceTransactionId, payout.failureBalanceTransactionId]) {
    if (providerId === null) continue;
    const balance = canonicalBalance(await providerCall(input.signal, () =>
      dependencies.gateway.retrieveBalanceTransaction(providerId)
    ), payout.livemode);
    assertDirectPayoutBalance(payout, balance);
    directBalances.push(balance);
  }
  for (const balance of directBalances) {
    await stageBalanceTransaction(dependencies.database, balance, { correlationId: input.correlationId });
    throwIfAborted(input.signal);
  }

  const staged = await stagePayoutSnapshot(dependencies.database, payout, {
    correlationId: input.correlationId,
    expectedGeneration
  });
  throwIfAborted(input.signal);
  if (!payout.automatic || payout.method !== 'standard' || payout.reconciliationStatus === 'not_applicable') {
    return { status: 'not_applicable', payoutId: staged.payoutId, generation: staged.generation };
  }
  if (payout.status !== 'paid' || payout.reconciliationStatus !== 'completed') {
    return { status: 'abandoned', payoutId: staged.payoutId, generation: staged.generation };
  }

  const run = await startOrResumePayoutImport(dependencies.database, {
    payoutId: staged.payoutId,
    expectedGeneration: staged.generation,
    correlationId: input.correlationId
  });
  throwIfAborted(input.signal);
  if (input.payload.trigger.kind === 'continuation') {
    if (input.payload.trigger.payoutId !== staged.payoutId ||
      input.payload.trigger.runId !== run.id ||
      input.payload.trigger.payoutGeneration !== run.generation ||
      input.payload.trigger.cursorDigestSha256 !== cursorDigest(run.nextStartingAfter)) {
      throw new RetryableFinancialError('state_changed');
    }
  }
  if (run.state === 'published') {
    const published = await publishPayoutMembership(dependencies.database, {
      payoutId: staged.payoutId,
      runId: run.id,
      expectedGeneration: run.generation,
      correlationId: input.correlationId
    });
    return { status: 'published', payoutId: staged.payoutId, runId: run.id, ...published };
  }
  if (run.state === 'publishable') {
    const published = await publishPayoutMembership(dependencies.database, {
      payoutId: staged.payoutId,
      runId: run.id,
      expectedGeneration: run.generation,
      correlationId: input.correlationId
    });
    return { status: 'published', payoutId: staged.payoutId, runId: run.id, ...published };
  }
  if (run.state !== 'collecting') {
    return { status: 'abandoned', payoutId: staged.payoutId, generation: staged.generation };
  }

  const request = run.nextStartingAfter === null
    ? { limit: 100 }
    : { limit: 100, startingAfter: run.nextStartingAfter };
  const page = await providerCall(input.signal, async () => parseStripeListPage(
    await dependencies.gateway.listBalanceTransactionsForPayout(payout.id, request),
    (item) => parseBalanceTransactionSnapshot(item, payout.livemode)
  ));
  const stagedPageIds: string[] = [];
  for (const balance of page.data) {
    const result = await stageBalanceTransaction(dependencies.database, balance, {
      correlationId: input.correlationId
    });
    stagedPageIds.push(result.balanceTransactionId);
    throwIfAborted(input.signal);
  }
  const persisted = await persistPayoutImportPage(dependencies.database, {
    payoutId: staged.payoutId,
    runId: run.id,
    expectedGeneration: run.generation,
    expectedPageCount: run.pageCount,
    expectedStartingAfter: run.nextStartingAfter,
    balanceTransactionIds: stagedPageIds,
    hasMore: page.hasMore,
    nextStartingAfter: page.nextStartingAfter,
    correlationId: input.correlationId
  });
  throwIfAborted(input.signal);
  if (persisted.state === 'publishable') {
    const published = await publishPayoutMembership(dependencies.database, {
      payoutId: staged.payoutId,
      runId: persisted.id,
      expectedGeneration: persisted.generation,
      correlationId: input.correlationId
    });
    return { status: 'published', payoutId: staged.payoutId, runId: persisted.id, ...published };
  }
  return {
    status: 'collecting',
    payoutId: staged.payoutId,
    runId: persisted.id,
    generation: persisted.generation,
    candidateCount: persisted.candidateCount,
    nextCursor: persisted.nextStartingAfter
  };
}
