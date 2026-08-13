import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import { PermanentJobError } from '$lib/server/jobs/runner';
import { PermanentFinancialError, RetryableFinancialError } from '../errors';
import {
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_SOURCE_JOB,
  createFinancialSourceEventJob
} from '../jobs';
import { createFinancialSourceHandler } from './source';

const reconcilers = vi.hoisted(() => ({
  payment: vi.fn(), refund: vi.fn(), dispute: vi.fn()
}));
vi.mock('../sources/payment', () => ({ reconcilePaymentFinancialSource: reconcilers.payment }));
vi.mock('../sources/refund', () => ({ reconcileRefundFinancialSource: reconcilers.refund }));
vi.mock('../sources/dispute', () => ({ reconcileDisputeFinancialSource: reconcilers.dispute }));

describe('createFinancialSourceHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a wrong job family permanently before dispatch', async () => {
    const dependencies = {
      database: { transaction: vi.fn() } as unknown as Database,
      gateway: { retrievePayment: vi.fn() } as unknown as StripeCommerceGateway
    };
    const handler = createFinancialSourceHandler(dependencies);

    await expect(handler({
      id: randomUUID(), type: 'commerce.financial-payout', payload: {}, attempts: 0,
      deduplicationKey: null, maxAttempts: 12, lockedBy: 'worker-red'
    }, new AbortController().signal)).rejects.toBeInstanceOf(PermanentJobError);
    expect(dependencies.database.transaction).not.toHaveBeenCalled();
    expect(dependencies.gateway.retrievePayment).not.toHaveBeenCalled();
  });

  it('rejects extra source payload fields before dispatch', async () => {
    const dependencies = {
      database: { transaction: vi.fn() } as unknown as Database,
      gateway: { retrievePayment: vi.fn() } as unknown as StripeCommerceGateway
    };
    const handler = createFinancialSourceHandler(dependencies);

    await expect(handler({
      id: randomUUID(), type: FINANCIAL_SOURCE_JOB,
      payload: {
        sourceKind: 'payment', sourceId: randomUUID(), privateText: 'must-not-pass',
        trigger: { kind: 'event', providerEventId: 'evt_handler_red' }
      }, deduplicationKey: 'stripe:financial-source:event:evt_handler_red',
      attempts: 0, maxAttempts: 12, lockedBy: 'worker-red'
    }, new AbortController().signal)).rejects.toBeInstanceOf(PermanentJobError);
    expect(dependencies.gateway.retrievePayment).not.toHaveBeenCalled();
  });

  it('rejects tampered permanent identity before dispatch', async () => {
    const handler = createFinancialSourceHandler({
      database: {} as Database,
      gateway: {} as StripeCommerceGateway
    });
    const definition = createFinancialSourceEventJob({
      sourceKind: 'payment', sourceId: randomUUID(), providerEventId: 'evt_source_identity'
    });
    const base = {
      id: randomUUID(), ...definition, attempts: 0, lockedBy: 'worker-identity'
    };
    for (const job of [
      { ...base, deduplicationKey: 'private-key' },
      { ...base, deduplicationKey: null },
      { ...base, maxAttempts: definition.maxAttempts - 1 },
      { ...base, type: FINANCIAL_PAYOUT_JOB }
    ]) {
      const failure = await handler(job as never, new AbortController().signal)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PermanentJobError);
      expect(failure).not.toHaveProperty('cause');
    }
    expect(reconcilers.payment).not.toHaveBeenCalled();
  });

  it.each([
    ['payment', 'event', reconcilers.payment],
    ['refund', 'scan', reconcilers.refund],
    ['dispute', 'payout_impact', reconcilers.dispute]
  ] as const)('strictly parses and dispatches one %s %s job', async (sourceKind, triggerKind, reconcile) => {
    const database = {} as Database;
    const gateway = {} as StripeCommerceGateway;
    const sourceId = randomUUID();
    const jobId = randomUUID();
    const trigger = triggerKind === 'event'
      ? { kind: 'event' as const, providerEventId: 'evt_handler_green' }
      : triggerKind === 'scan'
        ? { kind: 'scan' as const, scanRunId: randomUUID(), scanGenerationHour: '2026-08-12T12:00:00.000Z' }
        : { kind: 'payout_impact' as const, payoutId: randomUUID(), payoutGeneration: 1 };
    const signal = new AbortController().signal;
    const deduplicationKey = trigger.kind === 'event'
      ? `stripe:financial-source:event:${trigger.providerEventId}`
      : trigger.kind === 'scan'
        ? `financial:source:scan:${sourceKind}:${sourceId}:${trigger.scanGenerationHour}`
        : `financial:source:payout-impact:${trigger.payoutId}:${trigger.payoutGeneration}:` +
          `${sourceKind}:${sourceId}`;

    await createFinancialSourceHandler({ database, gateway })({
      id: jobId, type: FINANCIAL_SOURCE_JOB, payload: { sourceKind, sourceId, trigger },
      deduplicationKey, attempts: 0, maxAttempts: 12, lockedBy: 'worker-green'
    }, signal);

    expect(reconcile).toHaveBeenCalledOnce();
    const idKey = sourceKind === 'payment' ? 'paymentId' : sourceKind === 'refund' ? 'refundId' : 'disputeId';
    expect(reconcile).toHaveBeenCalledWith(database, gateway, {
      [idKey]: sourceId, correlationId: `financial-source-${jobId}`
    }, signal);
  });

  it('honors an already-lost lease before parsing or dispatching', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createFinancialSourceHandler({ database: {} as Database, gateway: {} as StripeCommerceGateway })({
      id: randomUUID(), type: FINANCIAL_SOURCE_JOB,
      payload: {
        sourceKind: 'payment', sourceId: randomUUID(),
        trigger: { kind: 'event', providerEventId: 'evt_handler_aborted' }
      }, deduplicationKey: 'stripe:financial-source:event:evt_handler_aborted',
      attempts: 0, maxAttempts: 12, lockedBy: 'worker-aborted'
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(reconcilers.payment).not.toHaveBeenCalled();
    expect(reconcilers.refund).not.toHaveBeenCalled();
    expect(reconcilers.dispute).not.toHaveBeenCalled();
  });

  it('maps bounded permanent evidence failures to a cause-free permanent job failure', async () => {
    reconcilers.refund.mockRejectedValueOnce(new PermanentFinancialError('immutable_mismatch'));
    const handler = createFinancialSourceHandler({
      database: {} as Database,
      gateway: {} as StripeCommerceGateway
    });

    const failure = await handler({
      id: randomUUID(), type: FINANCIAL_SOURCE_JOB,
      payload: {
        sourceKind: 'refund', sourceId: randomUUID(),
        trigger: { kind: 'event', providerEventId: 'evt_private_provider_text_must_not_escape' }
      }, deduplicationKey:
        'stripe:financial-source:event:evt_private_provider_text_must_not_escape',
      attempts: 0, maxAttempts: 12, lockedBy: 'worker-permanent'
    }, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PermanentJobError);
    expect(failure).toMatchObject({ message: 'Financial source evidence is invalid.' });
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain('evt_private_provider_text_must_not_escape');
  });

  it('preserves retryable evidence gaps for the worker retry policy', async () => {
    const retryable = new RetryableFinancialError('provider_not_ready');
    reconcilers.dispute.mockRejectedValueOnce(retryable);
    const handler = createFinancialSourceHandler({
      database: {} as Database,
      gateway: {} as StripeCommerceGateway
    });

    const sourceId = randomUUID();
    const scanRunId = randomUUID();
    await expect(handler({
      id: randomUUID(), type: FINANCIAL_SOURCE_JOB,
      payload: {
        sourceKind: 'dispute', sourceId,
        trigger: { kind: 'scan', scanRunId, scanGenerationHour: '2026-08-12T12:00:00.000Z' }
      }, deduplicationKey:
        `financial:source:scan:dispute:${sourceId}:2026-08-12T12:00:00.000Z`,
      attempts: 0, maxAttempts: 12, lockedBy: 'worker-retryable'
    }, new AbortController().signal)).rejects.toBe(retryable);
  });
});
