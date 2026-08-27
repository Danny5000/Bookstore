import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthorizationError,
  type Actor,
  type AdminCapability,
  type CapabilityResolver
} from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import type { CorrelationId } from '$lib/server/observability/contracts';
import { JobOperationsInputError, type JobRetryCommandStatusDto } from './contracts';
import {
  JobOperationsAuthorizationChangedError,
  JobRetryCommandSubmissionConflictError,
  type JobOperationsRepository
} from './repository';

const collaborators = vi.hoisted(() => ({
  auditDenied: vi.fn(),
  createRepository: vi.fn()
}));

vi.mock('./audit', () => ({
  auditJobRetryRequestDenied: collaborators.auditDenied
}));

vi.mock('./repository', async (importOriginal) => {
  const original = await importOriginal<typeof import('./repository')>();
  return {
    ...original,
    createPostgresJobOperationsRepository: collaborators.createRepository
  };
});

import {
  JobOperationsAuditError,
  getOwnedJobRetryCommand,
  listOperationalJobs,
  submitJobRetryCommand,
  type JobRetryRequestContext
} from './service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_JOB_ID = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY_KEY = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = 'operations-job-retry-101' as CorrelationId;
const database = {} as Database;
const administrator: Actor = { type: 'user', id: USER_ID, roles: ['admin'] };
const context: JobRetryRequestContext = { correlationId: CORRELATION_ID };
const commandInput = {
  idempotencyKey: IDEMPOTENCY_KEY,
  targetJobId: TARGET_JOB_ID,
  expectedKind: 'outbox.dispatch',
  expectedStatus: 'failed',
  expectedAttempts: 1,
  expectedMaxAttempts: 8,
  expectedUpdatedAt: '2026-08-26T12:34:56.123456Z',
  reasonCode: 'dependency_recovered'
} as const;
const pendingStatus: JobRetryCommandStatusDto = {
  commandId: COMMAND_ID,
  kind: 'retry_failed_job',
  targetJobId: TARGET_JOB_ID,
  targetKind: 'outbox.dispatch',
  reasonCode: 'dependency_recovered',
  correlationId: CORRELATION_ID,
  status: 'pending',
  resultCode: null,
  createdAt: '2026-08-26T12:34:56.123456Z',
  updatedAt: '2026-08-26T12:34:56.123456Z',
  completedAt: null
};

function resolverWith(...capabilities: AdminCapability[]): CapabilityResolver {
  return () => new Set(capabilities);
}

function repository(overrides: Partial<JobOperationsRepository> = {}): JobOperationsRepository {
  return {
    listOperationalJobs: vi.fn().mockResolvedValue([]),
    submitJobRetryCommand: vi.fn().mockResolvedValue(pendingStatus),
    getOwnedJobRetryCommand: vi.fn().mockResolvedValue(pendingStatus),
    ...overrides
  };
}

function hostile(label: string): { readonly value: unknown; readonly inspected: () => boolean } {
  let touched = false;
  const value = new Proxy(Object.create(null) as object, {
    get() {
      touched = true;
      throw new Error(`${label} getter must not run`);
    },
    getOwnPropertyDescriptor() {
      touched = true;
      throw new Error(`${label} descriptor must not run`);
    },
    getPrototypeOf() {
      touched = true;
      throw new Error(`${label} prototype must not run`);
    },
    ownKeys() {
      touched = true;
      throw new Error(`${label} ownKeys must not run`);
    }
  });
  return { value, inspected: () => touched };
}

describe('authorization-first job operations service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborators.auditDenied.mockResolvedValue(undefined);
  });

  it.each([
    [{ type: 'anonymous' } as Actor, new AuthorizationError('unauthenticated', 401)],
    [{ type: 'guest', id: 'guest' } as Actor, new AuthorizationError('forbidden', 403)],
    [{ type: 'system', id: 'system' } as Actor, new AuthorizationError('forbidden', 403)],
    [{ type: 'user', id: USER_ID, roles: ['admin'] } as Actor,
      new AuthorizationError('forbidden', 403)]
  ])('denies list before hostile filters and repository construction for %j', async (actor, error) => {
    const filter = hostile('list filter');

    await expect(listOperationalJobs(database, actor, filter.value, {
      capabilityResolver: resolverWith()
    })).rejects.toEqual(error);

    expect(filter.inspected()).toBe(false);
    expect(collaborators.createRepository).not.toHaveBeenCalled();
    expect(collaborators.auditDenied).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'anonymous' } as Actor, new AuthorizationError('unauthenticated', 401)],
    [{ type: 'guest', id: 'guest' } as Actor, new AuthorizationError('forbidden', 403)],
    [{ type: 'system', id: 'system' } as Actor, new AuthorizationError('forbidden', 403)],
    [{ type: 'user', id: USER_ID, roles: ['admin'] } as Actor,
      new AuthorizationError('forbidden', 403)]
  ])('denies owned status before hostile command parsing for %j', async (actor, error) => {
    const commandId = hostile('command id');

    await expect(getOwnedJobRetryCommand(database, actor, commandId.value, {
      capabilityResolver: resolverWith()
    })).rejects.toEqual(error);

    expect(commandId.inspected()).toBe(false);
    expect(collaborators.createRepository).not.toHaveBeenCalled();
    expect(collaborators.auditDenied).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'anonymous' } as Actor, new AuthorizationError('unauthenticated', 401)],
    [{ type: 'guest', id: 'guest' } as Actor, new AuthorizationError('forbidden', 403)],
    [{ type: 'system', id: 'system' } as Actor, new AuthorizationError('forbidden', 403)],
    [{ type: 'user', id: USER_ID, roles: ['admin'] } as Actor,
      new AuthorizationError('forbidden', 403)]
  ])('audits submission denial before hostile command input for %j', async (actor, error) => {
    const input = hostile('command input');

    await expect(submitJobRetryCommand(database, actor, input.value, context, {
      capabilityResolver: resolverWith()
    })).rejects.toEqual(error);

    expect(input.inspected()).toBe(false);
    expect(collaborators.auditDenied).toHaveBeenCalledOnce();
    expect(collaborators.auditDenied.mock.calls[0]![0]).toBe(database);
    expect(collaborators.auditDenied.mock.calls[0]![1]).toBe(actor);
    expect(collaborators.auditDenied.mock.calls[0]![2]).toBe(CORRELATION_ID);
    expect(collaborators.createRepository).not.toHaveBeenCalled();
  });

  it('audits initial denial before reading an authorized-form actor UUID getter', async () => {
    const input = hostile('command input');
    const deniedActor = { type: 'user', roles: ['admin'] } as unknown as Actor;
    Object.defineProperty(deniedActor, 'id', {
      enumerable: true,
      get() {
        throw new Error('actor id must not be parsed');
      }
    });

    await expect(submitJobRetryCommand(database, deniedActor, input.value, context, {
      capabilityResolver: resolverWith()
    })).rejects.toEqual(new AuthorizationError('forbidden', 403));

    expect(input.inspected()).toBe(false);
    expect(collaborators.auditDenied.mock.calls[0]![1]).toBe(deniedActor);
  });

  it('rejects unbounded context without audit because no validated correlation exists', async () => {
    const input = hostile('command input');
    const badContext = hostile('request context');

    await expect(submitJobRetryCommand(
      database,
      administrator,
      input.value,
      badContext.value as JobRetryRequestContext
    )).rejects.toEqual(new JobOperationsInputError());

    expect(badContext.inspected()).toBe(true);
    expect(input.inspected()).toBe(false);
    expect(collaborators.auditDenied).not.toHaveBeenCalled();
    expect(collaborators.createRepository).not.toHaveBeenCalled();
  });

  it('audits authorized actor/input parse failures once and preserves the safe input error', async () => {
    const call = submitJobRetryCommand(database, administrator, { ...commandInput, extra: true }, context);

    await expect(call).rejects.toEqual(new JobOperationsInputError());
    expect(collaborators.auditDenied).toHaveBeenCalledOnce();
    expect(collaborators.auditDenied).toHaveBeenCalledWith(database, administrator, CORRELATION_ID);
    expect(collaborators.createRepository).not.toHaveBeenCalled();
  });

  it('audits an authorized malformed actor UUID before command parsing or repository creation', async () => {
    const input = hostile('command input');
    const malformedActor: Actor = { type: 'user', id: 'not-a-uuid', roles: ['admin'] };

    await expect(submitJobRetryCommand(database, malformedActor, input.value, context))
      .rejects.toEqual(new JobOperationsInputError());

    expect(input.inspected()).toBe(false);
    expect(collaborators.auditDenied).toHaveBeenCalledWith(
      database,
      malformedActor,
      CORRELATION_ID
    );
    expect(collaborators.createRepository).not.toHaveBeenCalled();
  });

  it('authorizes and parses list/status before invoking only the injected repository', async () => {
    const injected = repository();

    await expect(listOperationalJobs(database, administrator, { limit: 2 }, {
      repository: injected
    })).resolves.toEqual([]);
    await expect(getOwnedJobRetryCommand(database, administrator, COMMAND_ID, {
      repository: injected
    })).resolves.toBe(pendingStatus);

    expect(injected.listOperationalJobs).toHaveBeenCalledWith({ actorId: USER_ID, limit: 2 });
    expect(injected.getOwnedJobRetryCommand).toHaveBeenCalledWith({
      actorId: USER_ID,
      commandId: COMMAND_ID
    });
    expect(collaborators.auditDenied).not.toHaveBeenCalled();
    expect(collaborators.createRepository).not.toHaveBeenCalled();
  });

  it('passes canonical hashes and no request context fields into submission repository input', async () => {
    const injected = repository();

    await expect(submitJobRetryCommand(database, administrator, commandInput, context, {
      repository: injected
    })).resolves.toBe(pendingStatus);

    expect(injected.submitJobRetryCommand).toHaveBeenCalledOnce();
    const submitted = vi.mocked(injected.submitJobRetryCommand).mock.calls[0]![0];
    expect(submitted).toEqual({
      actorId: USER_ID,
      command: commandInput,
      correlationId: CORRELATION_ID,
      idempotencyKeySha256: 'f1d11edf5c5cbe84bc60d6c543d0d5938a5bd3a833381499af7549ddc4933a23',
      inputFingerprintSha256: 'af6ee12f054bc8de5613478939ceaa470b9a942b8282745f445279c151ad775e'
    });
    expect(Reflect.ownKeys(submitted)).toEqual([
      'actorId', 'command', 'correlationId', 'idempotencyKeySha256',
      'inputFingerprintSha256'
    ]);
    expect(collaborators.auditDenied).not.toHaveBeenCalled();
  });

  it.each([
    new JobRetryCommandSubmissionConflictError(),
    new JobOperationsAuthorizationChangedError()
  ])('audits repository denial %s exactly once and returns only the fixed safe error', async (denial) => {
    const injected = repository({
      submitJobRetryCommand: vi.fn().mockRejectedValue(denial)
    });

    const call = submitJobRetryCommand(database, administrator, commandInput, context, {
      repository: injected
    });
    if (denial instanceof JobOperationsAuthorizationChangedError) {
      await expect(call).rejects.toEqual(new AuthorizationError('forbidden', 403));
    } else {
      await expect(call).rejects.toBe(denial);
    }
    expect(collaborators.auditDenied).toHaveBeenCalledOnce();
    expect(collaborators.auditDenied).toHaveBeenCalledWith(database, administrator, CORRELATION_ID);
  });

  it('translates list/status authorization changes without auditing', async () => {
    const injected = repository({
      listOperationalJobs: vi.fn().mockRejectedValue(new JobOperationsAuthorizationChangedError()),
      getOwnedJobRetryCommand: vi.fn().mockRejectedValue(new JobOperationsAuthorizationChangedError())
    });

    await expect(listOperationalJobs(database, administrator, {}, { repository: injected }))
      .rejects.toEqual(new AuthorizationError('forbidden', 403));
    await expect(getOwnedJobRetryCommand(database, administrator, COMMAND_ID, {
      repository: injected
    })).rejects.toEqual(new AuthorizationError('forbidden', 403));
    expect(collaborators.auditDenied).not.toHaveBeenCalled();
  });

  it('replaces any denied-audit failure with one fixed audit error without cause', async () => {
    const auditFailure = new Error('private audit database failure');
    collaborators.auditDenied.mockRejectedValueOnce(auditFailure);

    const call = submitJobRetryCommand(database, { type: 'anonymous' }, hostile('input').value, context);
    await expect(call).rejects.toEqual(new JobOperationsAuditError());
    try {
      await call;
    } catch (error) {
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain(auditFailure.message);
    }
    expect(collaborators.createRepository).not.toHaveBeenCalled();
  });

  it('propagates unrelated repository failures without denial audit', async () => {
    const failure = new Error('repository unavailable');
    const injected = repository({ submitJobRetryCommand: vi.fn().mockRejectedValue(failure) });

    await expect(submitJobRetryCommand(database, administrator, commandInput, context, {
      repository: injected
    })).rejects.toBe(failure);
    expect(collaborators.auditDenied).not.toHaveBeenCalled();
  });
});
