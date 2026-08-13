import { describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { PermanentFinancialError } from './errors';
import {
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_SOURCE_JOB
} from './jobs';

const repositoryMocks = vi.hoisted(() => ({
  enqueueActiveEntityJob: vi.fn()
}));

vi.mock('$lib/server/jobs/repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('$lib/server/jobs/repository')>(),
  enqueueActiveEntityJob: repositoryMocks.enqueueActiveEntityJob
}));

import {
  queueFinancialPayoutFromEvent,
  queueFinancialSourceFromEvent
} from './event-handoff';

const SOURCE_ID = '00000000-0000-4000-8000-000000001601';
const transaction = {} as DatabaseTransaction;

async function expectInvalid(work: () => Promise<unknown>, privateValue?: string): Promise<void> {
  let failure: unknown;
  try {
    await work();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(PermanentFinancialError);
  expect(failure).toMatchObject({ safeCode: 'invalid_job_payload' });
  expect(failure).not.toHaveProperty('cause');
  if (privateValue) expect(String(failure)).not.toContain(privateValue);
}

describe('financial event handoff', () => {
  it('queues one canonical event-keyed source job inside the supplied transaction', async () => {
    await queueFinancialSourceFromEvent(transaction, {
      sourceKind: 'refund',
      sourceId: SOURCE_ID.toUpperCase(),
      providerEventId: 'evt_handoff_source_1601'
    });

    expect(repositoryMocks.enqueueActiveEntityJob).toHaveBeenCalledWith(transaction, {
      type: FINANCIAL_SOURCE_JOB,
      payload: {
        sourceKind: 'refund',
        sourceId: SOURCE_ID,
        trigger: { kind: 'event', providerEventId: 'evt_handoff_source_1601' }
      },
      deduplicationKey: 'stripe:financial-source:event:evt_handoff_source_1601',
      maxAttempts: 12,
      activeEntity: { sourceKind: 'refund', sourceId: SOURCE_ID }
    });
  });

  it('queues one canonical event-keyed payout job inside the supplied transaction', async () => {
    await queueFinancialPayoutFromEvent(transaction, {
      providerPayoutId: 'po_handoff_1601',
      providerEventId: 'evt_handoff_payout_1602'
    });

    expect(repositoryMocks.enqueueActiveEntityJob).toHaveBeenCalledWith(transaction, {
      type: FINANCIAL_PAYOUT_JOB,
      payload: {
        providerPayoutId: 'po_handoff_1601',
        trigger: { kind: 'event', providerEventId: 'evt_handoff_payout_1602' }
      },
      deduplicationKey: 'stripe:financial-payout:event:evt_handoff_payout_1602',
      maxAttempts: 12,
      activeEntity: { providerPayoutId: 'po_handoff_1601' }
    });
  });

  it('rejects unknown, inherited, symbolic, malformed, and private fields before enqueue', async () => {
    const privateValue = 'private@example.com';
    await expectInvalid(() => queueFinancialSourceFromEvent(transaction, {
      sourceKind: 'payment', sourceId: SOURCE_ID,
      providerEventId: 'evt_handoff_invalid_1601', email: privateValue
    } as never), privateValue);

    const inherited = Object.create({ email: privateValue });
    Object.assign(inherited, {
      sourceKind: 'payment', sourceId: SOURCE_ID,
      providerEventId: 'evt_handoff_invalid_1602'
    });
    await expectInvalid(() => queueFinancialSourceFromEvent(transaction, inherited));

    await expectInvalid(() => queueFinancialSourceFromEvent(transaction, {
      sourceKind: 'payment', sourceId: SOURCE_ID,
      providerEventId: 'evt_handoff_invalid_1603', [Symbol('private')]: true
    } as never));
    await expectInvalid(() => queueFinancialSourceFromEvent(transaction, {
      sourceKind: 'payment', sourceId: 'ch_not_a_local_uuid',
      providerEventId: 'evt_handoff_invalid_1604'
    }));
    await expectInvalid(() => queueFinancialPayoutFromEvent(transaction, {
      providerPayoutId: 'tr_not_a_payout',
      providerEventId: 'evt_handoff_invalid_1605'
    }));

    expect(repositoryMocks.enqueueActiveEntityJob).not.toHaveBeenCalled();
  });

  it('contains accessor and proxy failures at the privacy boundary', async () => {
    const accessor = {
      sourceKind: 'payment',
      providerEventId: 'evt_handoff_accessor_1601'
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'sourceId', {
      enumerable: true,
      get() {
        throw Object.assign(new Error('private-canary-accessor'), { cause: 'private-cause' });
      }
    });
    await expectInvalid(() => queueFinancialSourceFromEvent(transaction, accessor as never),
      'private-canary-accessor');

    const proxy = new Proxy({}, {
      getPrototypeOf() {
        throw Object.assign(new Error('private-canary-proxy'), { cause: 'private-cause' });
      }
    });
    await expectInvalid(() => queueFinancialPayoutFromEvent(transaction, proxy as never),
      'private-canary-proxy');
    expect(repositoryMocks.enqueueActiveEntityJob).not.toHaveBeenCalled();
  });
});
