import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import type { CorrelationId } from '$lib/server/observability/contracts';

const collaborators = vi.hoisted(() => ({
  appendAuditEvent: vi.fn()
}));

vi.mock('$lib/server/audit/service', () => ({
  appendAuditEvent: collaborators.appendAuditEvent
}));

import { auditJobRetryRequestDenied } from './audit';

const ACTOR: Actor = {
  type: 'user',
  id: '11111111-1111-4111-8111-111111111111',
  roles: ['admin']
};
const CORRELATION_ID = 'operations-retry-denied-101' as CorrelationId;

describe('job retry request denial audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends only the exact fixed null-metadata denial envelope', async () => {
    const database = {} as DatabaseExecutor;
    collaborators.appendAuditEvent.mockResolvedValueOnce({ private: 'must-not-escape' });

    await expect(
      auditJobRetryRequestDenied(database, ACTOR, CORRELATION_ID)
    ).resolves.toBeUndefined();

    expect(collaborators.appendAuditEvent).toHaveBeenCalledTimes(1);
    const [recordedDatabase, envelope] = collaborators.appendAuditEvent.mock.calls[0]!;
    expect(recordedDatabase).toBe(database);
    expect(Reflect.ownKeys(envelope)).toEqual([
      'actor',
      'action',
      'outcome',
      'resourceType',
      'resourceId',
      'correlationId',
      'requestMetadata',
      'before',
      'after'
    ]);
    expect(envelope).toEqual({
      actor: ACTOR,
      action: 'operations.job_retry.requested',
      outcome: 'denied',
      resourceType: 'operations_job_retry_command',
      resourceId: null,
      correlationId: CORRELATION_ID,
      requestMetadata: null,
      before: null,
      after: null
    });
  });

  it('does not inspect or forward an unexpected hostile target argument', async () => {
    const database = {} as DatabaseExecutor;
    let inspected = false;
    const hostileTarget = new Proxy(Object.create(null) as object, {
      get() {
        inspected = true;
        throw new Error('target getter must not run');
      },
      getOwnPropertyDescriptor() {
        inspected = true;
        throw new Error('target descriptor must not run');
      },
      ownKeys() {
        inspected = true;
        throw new Error('target ownKeys must not run');
      }
    });
    collaborators.appendAuditEvent.mockResolvedValueOnce(undefined);
    const callWithUnexpectedInput = auditJobRetryRequestDenied as unknown as (
      database: DatabaseExecutor,
      actor: Actor,
      correlationId: CorrelationId,
      target: unknown
    ) => Promise<void>;

    await expect(
      callWithUnexpectedInput(database, ACTOR, CORRELATION_ID, hostileTarget)
    ).resolves.toBeUndefined();

    expect(inspected).toBe(false);
    expect(collaborators.appendAuditEvent).toHaveBeenCalledTimes(1);
    expect(collaborators.appendAuditEvent.mock.calls[0]).toHaveLength(2);
    expect(collaborators.appendAuditEvent.mock.calls[0]![1]).not.toHaveProperty('target');
  });
});
