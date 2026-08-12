import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import { PermanentJobError } from '$lib/server/jobs/runner';
import { PermanentFinancialError } from '../errors';
import { FINANCIAL_PAYOUT_JOB } from '../jobs';
import { createFinancialPayoutHandler } from './payout';

const service = vi.hoisted(() => vi.fn());
vi.mock('../payouts/service', () => ({ reconcileFinancialPayout: service }));

describe('financial payout handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatches one strict payout job with an internal correlation id', async () => {
    const database = {} as Database;
    const gateway = {} as StripeCommerceGateway;
    const jobId = randomUUID();
    const signal = new AbortController().signal;

    await expect(createFinancialPayoutHandler({ database, gateway })({
      id: jobId,
      type: FINANCIAL_PAYOUT_JOB,
      payload: {
        providerPayoutId: 'po_handler_red_101',
        trigger: { kind: 'event', providerEventId: 'evt_handler_red_101' }
      },
      attempts: 1,
      maxAttempts: 12,
      lockedBy: 'test-worker'
    }, signal)).resolves.toBeUndefined();

    expect(service).toHaveBeenCalledWith({ database, gateway }, {
      payload: {
        providerPayoutId: 'po_handler_red_101',
        trigger: { kind: 'event', providerEventId: 'evt_handler_red_101' }
      },
      correlationId: `financial-payout-${jobId}`,
      signal
    });
  });

  it('rejects the wrong family and an already-aborted lease before dispatch', async () => {
    const handler = createFinancialPayoutHandler({ database: {} as Database, gateway: {} as StripeCommerceGateway });
    const job = {
      id: randomUUID(), type: 'commerce.financial-source', payload: {}, attempts: 1,
      maxAttempts: 12, lockedBy: 'test-worker'
    };
    await expect(handler(job, new AbortController().signal)).rejects.toBeInstanceOf(PermanentJobError);
    const controller = new AbortController();
    controller.abort();
    await expect(handler({ ...job, type: FINANCIAL_PAYOUT_JOB }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(service).not.toHaveBeenCalled();
  });

  it('maps bounded permanent financial evidence to a permanent job failure', async () => {
    service.mockRejectedValueOnce(new PermanentFinancialError('source_linkage_mismatch'));
    const handler = createFinancialPayoutHandler({ database: {} as Database, gateway: {} as StripeCommerceGateway });
    await expect(handler({
      id: randomUUID(), type: FINANCIAL_PAYOUT_JOB,
      payload: {
        providerPayoutId: 'po_handler_red_101',
        trigger: { kind: 'event', providerEventId: 'evt_handler_red_101' }
      }, attempts: 1, maxAttempts: 12, lockedBy: 'test-worker'
    }, new AbortController().signal)).rejects.toBeInstanceOf(PermanentJobError);
  });
});
