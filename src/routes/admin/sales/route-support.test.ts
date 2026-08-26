import { randomUUID } from 'node:crypto';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  AuthorizationError,
  type Actor,
  type AdminCapability,
  type CapabilityResolver
} from '$lib/server/auth/admin-policy';
import { SalesReportingInputError } from '$lib/server/commerce/reporting/filters';
import { FinancialAdminCommandSubmissionConflictError } from '$lib/server/commerce/financial/admin-commands/repository';
import { StrictHttpError } from '$lib/server/http/strict-json';
import { runWithDiagnosticContext } from '$lib/server/observability/context';
import {
  FinancialRouteError,
  FinancialRouteInputError,
  createFinancialRequestContext,
  financialActionFailure,
  requireFinancialRouteUuid,
  withFinancialRouteAuthorization,
  type FinancialRouteFailure
} from './route-support';

const routeMocks = vi.hoisted(() => ({
  database: {},
  getFinancialAdminCommandStatus: vi.fn()
}));

vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: routeMocks.database })
}));
vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({ origin: 'https://books.example.test' })
}));
vi.mock('$lib/server/commerce/financial/admin-commands/repository', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('$lib/server/commerce/financial/admin-commands/repository')
  >()),
  getFinancialAdminCommandStatus: routeMocks.getFinancialAdminCommandStatus
}));

import { GET as getFinancialAdminCommand } from './commands/[commandId]/+server';

const admin: Actor = { type: 'user', id: randomUUID(), roles: ['admin'] };

describe('financial route authorization', () => {
  it('authorizes before path, query, or body parsing can run', () => {
    const parsePath = vi.fn();
    const parseQuery = vi.fn();
    const parseBody = vi.fn();

    expect(() =>
      withFinancialRouteAuthorization(
        { type: 'anonymous' },
        'sales.read',
        () => {
          parsePath();
          parseQuery();
          parseBody();
        }
      )
    ).toThrow(new AuthorizationError('unauthenticated', 401));

    expect(parsePath).not.toHaveBeenCalled();
    expect(parseQuery).not.toHaveBeenCalled();
    expect(parseBody).not.toHaveBeenCalled();
  });

  it.each(['sales.read', 'sales.export', 'reconciliation.manage'] as const)(
    'consults the exact requested %s capability at the actual route boundary',
    (requestedCapability) => {
      const allFinancialCapabilities = [
        'sales.read',
        'sales.export',
        'reconciliation.manage'
      ] as const;
      const resolver: CapabilityResolver = () =>
        new Set<AdminCapability>(
          allFinancialCapabilities.filter((capability) => capability !== requestedCapability)
        );
      const operation = vi.fn(() => 'unreachable');

      expect(() =>
        withFinancialRouteAuthorization(admin, requestedCapability, operation, {
          capabilityResolver: resolver
        })
      ).toThrow(new AuthorizationError('forbidden', 403));
      expect(operation).not.toHaveBeenCalled();
    }
  );
});

describe('financial route input and context contracts', () => {
  it('accepts only a canonical lowercase path UUID', () => {
    const value = 'abcdef00-0000-4000-8000-000000000001';
    expect(requireFinancialRouteUuid(value)).toBe(value);
    expect(() => requireFinancialRouteUuid(value.toUpperCase())).toThrow(
      new FinancialRouteError('not_found')
    );
    expect(() => requireFinancialRouteUuid('not-a-uuid')).toThrow(
      new FinancialRouteError('not_found')
    );
    expect(() => requireFinancialRouteUuid(undefined)).toThrow(
      new FinancialRouteError('not_found')
    );
  });

  it('creates bounded correlation and safe audit metadata after authorization', () => {
    const request = new Request('https://books.example.test/admin/sales', {
      method: 'POST',
      headers: { 'x-request-id': 'sales-request-1' }
    });
    const context = withFinancialRouteAuthorization(admin, 'sales.read', () =>
      createFinancialRequestContext(request, '/admin/sales')
    );
    expect(context).toEqual({
      correlationId: 'sales-request-1',
      requestMetadata: { method: 'POST', routeId: '/admin/sales' }
    });
  });

  it.each([
    ['', undefined],
    ['x'.repeat(101), undefined],
    ['unsafe request id', undefined],
    [' padded ', undefined],
    ['safe.request:id-2', 'safe.request:id-2'],
    [`a${'x'.repeat(99)}`, `a${'x'.repeat(99)}`]
  ] as const)('bounds or replaces correlation id %j', (incoming, expected) => {
    const context = withFinancialRouteAuthorization(admin, 'sales.read', () =>
      createFinancialRequestContext(
        incoming === ' padded '
          ? { method: 'GET', headers: { get: () => incoming } } as unknown as Request
          : new Request('https://books.example.test/', { headers: { 'x-request-id': incoming } }),
        null
      )
    );
    if (expected === undefined) {
      expect(context.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      );
    } else {
      expect(context.correlationId).toBe(expected);
    }
  });

  it('prefers ambient diagnostic correlation over a conflicting header', () => {
    const context = runWithDiagnosticContext(
      { kind: 'job', correlationId: 'ambient-job', jobId: randomUUID(), jobKind: 'sales.export', attempt: 1, workerId: 'worker:1', slotId: 0 } as never,
      () => createFinancialRequestContext(new Request('https://books.example.test/', {
        headers: { 'x-request-id': 'conflicting-header' }
      }), '/admin/sales')
    );

    expect(context.correlationId).toBe('ambient-job');
  });
});

describe('financial route failure mapping', () => {
  it('exports a status/code-discriminated failure union', () => {
    expectTypeOf<Extract<FinancialRouteFailure, { status: 400 }>['code']>()
      .toEqualTypeOf<'invalid_request'>();
    expectTypeOf<Extract<FinancialRouteFailure, { status: 401 }>['code']>()
      .toEqualTypeOf<'unauthenticated'>();
    expectTypeOf<Extract<FinancialRouteFailure, { status: 403 }>['code']>()
      .toEqualTypeOf<'forbidden'>();
    expectTypeOf<Extract<FinancialRouteFailure, { status: 404 }>['code']>()
      .toEqualTypeOf<'not_found'>();
    expectTypeOf<Extract<FinancialRouteFailure, { status: 409 }>['code']>()
      .toEqualTypeOf<'stale_state'>();
    expectTypeOf<Extract<FinancialRouteFailure, { status: 503 }>['code']>()
      .toEqualTypeOf<'temporarily_unavailable'>();
  });

  it.each([
    { cause: new SalesReportingInputError(), status: 400, code: 'invalid_request' },
    { cause: new FinancialRouteInputError(), status: 400, code: 'invalid_request' },
    { cause: new SyntaxError('private malformed body'), status: 400, code: 'invalid_request' },
    {
      cause: new AuthorizationError('unauthenticated', 401),
      status: 401,
      code: 'unauthenticated'
    },
    { cause: new AuthorizationError('forbidden', 403), status: 403, code: 'forbidden' },
    { cause: new StrictHttpError(403, 'forbidden'), status: 403, code: 'forbidden' },
    {
      cause: new FinancialAdminCommandSubmissionConflictError(),
      status: 409,
      code: 'stale_state'
    },
    { cause: new FinancialRouteError('not_found'), status: 404, code: 'not_found' },
    { cause: new FinancialRouteError('stale_state'), status: 409, code: 'stale_state' },
    {
      cause: new FinancialRouteError('temporarily_unavailable'),
      status: 503,
      code: 'temporarily_unavailable'
    },
    {
      cause: new Error('private database detail'),
      status: 503,
      code: 'temporarily_unavailable'
    }
  ] as const)('maps only the safe $status $code failure', ({ cause, status, code }) => {
    const failure = financialActionFailure(cause);
    expect(failure).toEqual({ status, code });
    expect(Object.keys(failure)).toEqual(['status', 'code']);
    expect(JSON.stringify(failure)).not.toContain('private database detail');
  });

  it('never reflects malformed path or query values in the failure body', () => {
    const unsafe = '<script>private</script>';
    const causes = [
      new FinancialRouteInputError(unsafe),
      new SalesReportingInputError(unsafe)
    ];
    for (const cause of causes) {
      expect(JSON.stringify(financialActionFailure(cause))).not.toContain(unsafe);
    }
  });
});

describe('financial administrator command status route', () => {
  it('authorizes the same-origin GET before reading its path parameter', async () => {
    const commandIdGetter = vi.fn(() => 'private-path-value');
    const params = {} as Record<string, string>;
    Object.defineProperty(params, 'commandId', {
      enumerable: true,
      get: commandIdGetter
    });

    const response = await getFinancialAdminCommand({
      locals: { actor: { type: 'anonymous' } },
      params,
      request: new Request('https://books.example.test/admin/sales/commands/private')
    } as never);

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(commandIdGetter).not.toHaveBeenCalled();
    expect(routeMocks.getFinancialAdminCommandStatus).not.toHaveBeenCalled();
  });

  it.each([
    { headers: { origin: 'https://evil.example.test' }, label: 'foreign origin' },
    { headers: { 'sec-fetch-site': 'cross-site' }, label: 'cross-site fetch metadata' },
    { headers: { 'sec-fetch-site': 'same-site' }, label: 'sibling-site fetch metadata' }
  ])('rejects $label before parsing a command identity', async ({ headers }) => {
    const commandIdGetter = vi.fn(() => 'private-path-value');
    const params = {} as Record<string, string>;
    Object.defineProperty(params, 'commandId', {
      enumerable: true,
      get: commandIdGetter
    });

    const response = await getFinancialAdminCommand({
      locals: { actor: admin },
      params,
      request: new Request('https://books.example.test/admin/sales/commands/private', {
        headers
      })
    } as never);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: 403, code: 'forbidden' });
    expect(commandIdGetter).not.toHaveBeenCalled();
    expect(routeMocks.getFinancialAdminCommandStatus).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { origin: 'https://books.example.test' },
    { 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-site': 'none' }
  ])('admits ordinary same-origin GET evidence %j', async (headers) => {
    routeMocks.getFinancialAdminCommandStatus.mockResolvedValueOnce(null);
    const commandId = '00000000-0000-4000-8000-000000004100';
    const response = await getFinancialAdminCommand({
      locals: { actor: admin },
      params: { commandId },
      request: new Request(`https://books.example.test/admin/sales/commands/${commandId}`, {
        headers
      })
    } as never);
    expect(response.status).toBe(404);
    expect(routeMocks.getFinancialAdminCommandStatus).toHaveBeenCalledWith(
      routeMocks.database,
      admin,
      commandId
    );
  });

  it('uses configured application origin instead of Host-derived request authority', async () => {
    routeMocks.getFinancialAdminCommandStatus.mockResolvedValueOnce(null);
    const commandId = '00000000-0000-4000-8000-000000004109';
    const response = await getFinancialAdminCommand({
      locals: { actor: admin },
      params: { commandId },
      request: new Request(`https://host-header-canary.test/admin/sales/commands/${commandId}`, {
        headers: { origin: 'https://books.example.test' }
      })
    } as never);
    expect(response.status).toBe(404);
    expect(routeMocks.getFinancialAdminCommandStatus).toHaveBeenCalledWith(
      routeMocks.database,
      admin,
      commandId
    );
  });

  it('returns only a reparsed safe DTO with no-store caching', async () => {
    const commandId = '00000000-0000-4000-8000-000000004101';
    const refundId = '00000000-0000-4000-8000-000000004102';
    routeMocks.getFinancialAdminCommandStatus.mockResolvedValueOnce({
      commandId,
      kind: 'refund_draft_save',
      status: 'succeeded',
      resultCode: 'draft_saved',
      result: { refundId, draftVersion: 2, changed: true },
      createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:01:00.000Z',
      completedAt: '2026-08-22T12:01:00.000Z'
    });

    const response = await getFinancialAdminCommand({
      locals: { actor: admin },
      params: { commandId },
      request: new Request(`https://books.example.test/admin/sales/commands/${commandId}`)
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = await response.json();
    expect(body).toEqual({
      commandId,
      kind: 'refund_draft_save',
      status: 'succeeded',
      resultCode: 'draft_saved',
      result: { refundId, draftVersion: 2, changed: true },
      createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:01:00.000Z',
      completedAt: '2026-08-22T12:01:00.000Z'
    });
    expect(JSON.stringify(body)).not.toMatch(
      /jobId|payload|attempts|last_error|privateInput|actorId|internalError/iu
    );
    expect(routeMocks.getFinancialAdminCommandStatus).toHaveBeenCalledWith(
      routeMocks.database,
      admin,
      commandId
    );
  });

  it('maps malformed, missing, and foreign command identities to the same safe 404', async () => {
    const malformed = await getFinancialAdminCommand({
      locals: { actor: admin },
      params: { commandId: 'PRIVATE-malformed-command' },
      request: new Request('https://books.example.test/admin/sales/commands/malformed')
    } as never);
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ status: 404, code: 'not_found' });
    expect(routeMocks.getFinancialAdminCommandStatus).not.toHaveBeenCalled();

    routeMocks.getFinancialAdminCommandStatus.mockResolvedValueOnce(null);
    const absent = await getFinancialAdminCommand({
      locals: { actor: admin },
      params: { commandId: '00000000-0000-4000-8000-000000004103' },
      request: new Request('https://books.example.test/admin/sales/commands/missing')
    } as never);
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ status: 404, code: 'not_found' });
  });

  it('maps a protected repository failure to a detail-free 503', async () => {
    routeMocks.getFinancialAdminCommandStatus.mockRejectedValueOnce(
      new Error('private protected routine output')
    );
    const commandId = '00000000-0000-4000-8000-000000004104';
    const response = await getFinancialAdminCommand({
      locals: { actor: admin },
      params: { commandId },
      request: new Request(`https://books.example.test/admin/sales/commands/${commandId}`)
    } as never);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ status: 503, code: 'temporarily_unavailable' });
    expect(JSON.stringify(body)).not.toContain('private protected routine output');
  });
});
