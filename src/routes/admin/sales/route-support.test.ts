import { randomUUID } from 'node:crypto';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  AuthorizationError,
  type Actor,
  type AdminCapability,
  type CapabilityResolver
} from '$lib/server/auth/admin-policy';
import { SalesReportingInputError } from '$lib/server/commerce/reporting/filters';
import {
  FinancialRouteError,
  FinancialRouteInputError,
  createFinancialRequestContext,
  financialActionFailure,
  requireFinancialRouteUuid,
  withFinancialRouteAuthorization,
  type FinancialRouteFailure
} from './route-support';

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
    ['', true],
    ['x'.repeat(101), true],
    ['unsafe request id', true],
    ['safe.request:id-2', false]
  ] as const)('bounds or replaces correlation id %j', (incoming, replaced) => {
    const context = withFinancialRouteAuthorization(admin, 'sales.read', () =>
      createFinancialRequestContext(new Request('https://books.example.test/', {
        headers: { 'x-request-id': incoming }
      }), null)
    );
    expect(context.correlationId).toMatch(replaced
      ? /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      : /^safe\.request:id-2$/u);
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
