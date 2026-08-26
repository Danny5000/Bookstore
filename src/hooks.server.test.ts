import type { Handle, RequestEvent, ResolveOptions } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  building: false,
  available: true,
  environment: 'test' as 'development' | 'test' | 'production',
  applicationMode: 'prototype',
  stdoutLines: [] as string[],
  stderrLines: [] as string[],
  stdoutAttempts: [] as string[],
  stderrAttempts: [] as string[],
  stdoutFailure: undefined as unknown,
  stderrFailure: undefined as unknown,
  sequence: [] as string[]
}));

const mocks = vi.hoisted(() => ({
  actorForUser: vi.fn(),
  getApplicationConfig: vi.fn(),
  getAuthServer: vi.fn(),
  getDatabaseClient: vi.fn(),
  getObjectStorage: vi.fn(),
  getSession: vi.fn(),
  isRequestAvailable: vi.fn(),
  resolve: vi.fn(),
  svelteKitHandler: vi.fn()
}));

vi.mock('$app/environment', () => ({
  get building() {
    return state.building;
  }
}));

vi.mock('better-auth/svelte-kit', () => ({
  svelteKitHandler: mocks.svelteKitHandler
}));

vi.mock('$lib/server/application-mode', () => ({
  isRequestAvailable: mocks.isRequestAvailable
}));

vi.mock('$lib/server/auth/identity', () => ({
  actorForUser: mocks.actorForUser
}));

vi.mock('$lib/server/auth/runtime', () => ({
  getAuthServer: mocks.getAuthServer
}));

vi.mock('$lib/server/config', () => ({
  getApplicationConfig: mocks.getApplicationConfig
}));

vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: mocks.getDatabaseClient
}));

vi.mock('$lib/server/storage/runtime', () => ({
  getObjectStorage: mocks.getObjectStorage
}));

vi.mock('$lib/server/observability/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/observability/logger')>();
  return {
    ...actual,
    createStructuredLogger: vi.fn((options: Parameters<typeof actual.createStructuredLogger>[0]) =>
      actual.createStructuredLogger({
        ...options,
        now: () => new Date('2026-08-25T12:34:56.789Z'),
        stdout: (line) => {
          state.stdoutAttempts.push(line);
          state.sequence.push('stdout');
          if (state.stdoutFailure !== undefined) throw state.stdoutFailure;
          state.stdoutLines.push(line);
        },
        stderr: (line) => {
          state.stderrAttempts.push(line);
          state.sequence.push('stderr');
          if (state.stderrFailure !== undefined) throw state.stderrFailure;
          state.stderrLines.push(line);
        }
      })
    )
  };
});

import { commandContext } from './routes/admin/catalog/route-support';
import { handle, init } from './hooks.server';
import {
  correlationIdForRequest,
  getDiagnosticContext,
  runWithDiagnosticContext
} from '$lib/server/observability/context';
import { createStructuredLogger } from '$lib/server/observability/logger';

const database = { marker: 'database' };
const auth = { api: { getSession: mocks.getSession } };

function requestEvent(options: {
  readonly method?: string;
  readonly pathname?: string;
  readonly query?: string;
  readonly routeId?: string | null;
  readonly requestId?: string;
  readonly cookie?: string;
  readonly isSubRequest?: boolean;
} = {}): RequestEvent {
  const pathname = options.pathname ?? '/library/book-canary';
  const query = options.query ?? '';
  const headers = new Headers();
  if (options.requestId !== undefined) headers.set('x-request-id', options.requestId);
  if (options.cookie !== undefined) headers.set('cookie', options.cookie);
  const url = new URL(`https://books.example.test${pathname}${query}`);
  const request = new Request(url, {
    method: options.method ?? 'GET',
    headers
  });

  return {
    cookies: {} as RequestEvent['cookies'],
    fetch: globalThis.fetch,
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: options.isSubRequest ?? false,
    locals: {} as App.Locals,
    params: {},
    platform: undefined,
    request,
    route: { id: options.routeId === undefined ? '/library/[titleId]' : options.routeId },
    setHeaders: () => undefined,
    url
  } as unknown as RequestEvent;
}

function response(status = 200): Response {
  if (status >= 300 && status < 400 && status !== 304) {
    return new Response(null, {
      status,
      headers: {
        'content-encoding': 'gzip',
        'content-length': '19',
        location: '/library',
        'transfer-encoding': 'chunked'
      }
    });
  }
  return new Response(status === 204 || status === 304 ? null : 'domain-body', {
    status,
    headers: { 'x-domain-header': 'preserved' }
  });
}

function records(): Array<Record<string, unknown>> {
  return [...state.stdoutLines, ...state.stderrLines].map((line) => JSON.parse(line));
}

async function invoke(
  event: RequestEvent,
  resolve: (event: RequestEvent, options?: ResolveOptions) => Response | Promise<Response> = mocks.resolve
): Promise<Response> {
  return (handle as Handle)({ event, resolve });
}

beforeEach(() => {
  state.building = false;
  state.available = true;
  state.environment = 'test';
  state.applicationMode = 'prototype';
  state.stdoutLines = [];
  state.stderrLines = [];
  state.stdoutAttempts = [];
  state.stderrAttempts = [];
  state.stdoutFailure = undefined;
  state.stderrFailure = undefined;
  state.sequence = [];

  mocks.getApplicationConfig.mockImplementation(() => ({
    environment: state.environment,
    applicationMode: state.applicationMode
  }));
  mocks.isRequestAvailable.mockImplementation(() => state.available);
  mocks.getAuthServer.mockReturnValue(auth);
  mocks.getDatabaseClient.mockReturnValue({ db: database });
  mocks.getObjectStorage.mockReturnValue({ marker: 'storage' });
  mocks.getSession.mockResolvedValue(null);
  mocks.actorForUser.mockResolvedValue({ type: 'user', id: 'actor-id', roles: ['customer'] });
  mocks.resolve.mockResolvedValue(response());
  mocks.svelteKitHandler.mockImplementation(async ({ event, resolve }) => {
    state.sequence.push('svelte-kit');
    return resolve(event);
  });
});

describe('server initialization ownership', () => {
  it('retains the build no-op and runtime config, database, and storage initialization', async () => {
    state.building = true;
    await init();
    expect(mocks.getApplicationConfig).not.toHaveBeenCalled();
    expect(mocks.getDatabaseClient).not.toHaveBeenCalled();
    expect(mocks.getObjectStorage).not.toHaveBeenCalled();

    state.building = false;
    await init();
    expect(mocks.getApplicationConfig).toHaveBeenCalledOnce();
    expect(mocks.getDatabaseClient).toHaveBeenCalledOnce();
    expect(mocks.getObjectStorage).toHaveBeenCalledOnce();
  });
});

describe('build-mode hook behavior', () => {
  it('initializes anonymous locals, preserves canonical resolution, and emits no runtime event', async () => {
    state.building = true;
    const event = requestEvent({ requestId: 'build-request' });
    mocks.resolve.mockResolvedValue(response(302));

    const result = await invoke(event);

    expect(event.locals).toEqual({
      user: null,
      session: null,
      actor: { type: 'anonymous' }
    });
    expect(result.status).toBe(302);
    expect(result.headers.get('content-length')).toBe('0');
    expect(result.headers.get('transfer-encoding')).toBeNull();
    expect(result.headers.get('content-encoding')).toBeNull();
    expect(mocks.getApplicationConfig).not.toHaveBeenCalled();
    expect(createStructuredLogger).not.toHaveBeenCalled();
    expect(records()).toEqual([]);
  });
});

describe('top-level HTTP lifecycle', () => {
  it('enters validated correlation context before maintenance and preserves the exact maintenance response', async () => {
    state.available = false;
    state.applicationMode = 'maintenance';
    const event = requestEvent({
      method: 'post',
      pathname: '/maintenance-canary',
      routeId: null,
      requestId: 'Incoming.Request:42'
    });
    let contextAtAvailabilityCheck: unknown;
    mocks.isRequestAvailable.mockImplementation(() => {
      contextAtAvailabilityCheck = getDiagnosticContext();
      return false;
    });

    const result = await invoke(event);

    expect(contextAtAvailabilityCheck).toEqual({
      kind: 'web',
      correlationId: 'Incoming.Request:42'
    });
    expect(event.locals).toEqual({
      user: null,
      session: null,
      actor: { type: 'anonymous' }
    });
    expect(mocks.getAuthServer).not.toHaveBeenCalled();
    expect(result.status).toBe(503);
    expect(await result.text()).toBe(
      'Service temporarily unavailable while the backend is being prepared.'
    );
    expect(Object.fromEntries(result.headers)).toEqual({
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': '60'
    });
    expect(records()).toEqual([
      {
        version: 1,
        timestamp: '2026-08-25T12:34:56.789Z',
        severity: 'warn',
        service: 'web',
        event: 'http.request.rejected',
        outcome: 'denied',
        correlationId: 'Incoming.Request:42',
        method: 'POST',
        route: 'unmatched',
        httpStatus: 503,
        code: 'maintenance_mode',
        durationMs: expect.any(Number)
      }
    ]);
    expect(result.headers.has('x-request-id')).toBe(false);
  });

  it.each([
    [200, 'http.request.completed', undefined, 'stdout'],
    [302, 'http.request.completed', undefined, 'stdout'],
    [404, 'http.request.rejected', 'not_found', 'stderr'],
    [500, 'http.request.failed', 'http_server_error', 'stderr']
  ] as const)(
    'emits one terminal event for canonical returned status %i',
    async (status, eventName, code, sink) => {
      const event = requestEvent({
        method: 'post',
        routeId: '/admin/catalog/[titleId]',
        requestId: 'status-matrix'
      });
      mocks.resolve.mockImplementation(async () => {
        state.sequence.push('resolve');
        return response(status);
      });

      const result = await invoke(event);

      expect(result.status).toBe(status);
      expect(result.headers.has('x-request-id')).toBe(false);
      if (status === 302) {
        expect(result.headers.get('content-length')).toBe('0');
        expect(result.headers.get('transfer-encoding')).toBeNull();
      } else {
        expect(result.headers.get('x-domain-header')).toBe('preserved');
      }
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({
        service: 'web',
        event: eventName,
        correlationId: 'status-matrix',
        method: 'POST',
        route: '/admin/catalog/[titleId]',
        httpStatus: status,
        ...(code === undefined ? {} : { code })
      });
      expect(Object.hasOwn(records()[0]!, 'code')).toBe(code !== undefined);
      expect(state.sequence).toEqual(['svelte-kit', 'resolve', sink]);
    }
  );

  it('emits one safe failure and rethrows the identical escaping exception object', async () => {
    const cause = new Error('exception-message-canary');
    cause.stack = 'stack-canary';
    const event = requestEvent({
      method: 'delete',
      routeId: '/admin/catalog/[titleId]',
      requestId: 'exception-request'
    });
    mocks.resolve.mockRejectedValue(cause);

    await expect(invoke(event)).rejects.toBe(cause);

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      event: 'http.request.failed',
      outcome: 'failed',
      correlationId: 'exception-request',
      method: 'DELETE',
      route: '/admin/catalog/[titleId]',
      httpStatus: 500,
      code: 'unexpected_failure'
    });
    const line = state.stderrLines.join('');
    expect(line).not.toContain('exception-message-canary');
    expect(line).not.toContain('stack-canary');
  });

  it.each([
    ['valid correlation', 'Caller.Correlation:9'],
    ['generated correlation', 'invalid correlation with spaces']
  ])('propagates %s through awaited auth, actor, resolve, and explicit audit context', async (_, supplied) => {
    const event = requestEvent({ requestId: supplied });
    const seen: string[] = [];
    mocks.getSession.mockImplementation(async () => {
      await Promise.resolve();
      seen.push(getDiagnosticContext()!.correlationId);
      return {
        user: {
          id: 'user-id',
          name: 'User Name',
          email: 'user@example.test',
          emailVerified: true
        },
        session: {
          id: 'session-id',
          userId: 'user-id',
          expiresAt: new Date('2026-09-01T00:00:00.000Z')
        }
      };
    });
    mocks.actorForUser.mockImplementation(async () => {
      await Promise.resolve();
      seen.push(getDiagnosticContext()!.correlationId);
      return { type: 'user', id: 'user-id', roles: ['customer'] };
    });
    mocks.svelteKitHandler.mockImplementation(async ({ event, resolve }) => {
      await Promise.resolve();
      seen.push(getDiagnosticContext()!.correlationId);
      return resolve(event);
    });
    mocks.resolve.mockImplementation(async (resolvedEvent) => {
      await Promise.resolve();
      seen.push(getDiagnosticContext()!.correlationId);
      seen.push(correlationIdForRequest(resolvedEvent.request));
      seen.push(commandContext(resolvedEvent.request, resolvedEvent.route.id).correlationId);
      return response();
    });

    await invoke(event);

    expect(seen).toHaveLength(6);
    expect(new Set(seen)).toHaveLength(1);
    if (supplied === 'Caller.Correlation:9') {
      expect(seen[0]).toBe(supplied);
    } else {
      expect(seen[0]).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    }
    expect(records()[0]).toMatchObject({ correlationId: seen[0] });
  });

  it('constructs the fixed web logger after configuration succeeds', async () => {
    state.environment = 'development';

    await invoke(requestEvent({ requestId: 'factory-request' }));

    expect(mocks.getApplicationConfig).toHaveBeenCalledOnce();
    expect(createStructuredLogger).toHaveBeenCalledOnce();
    expect(createStructuredLogger).toHaveBeenCalledWith({
      service: 'web',
      environment: 'development'
    });
  });

  it.each(['development', 'test'] as const)(
    'keeps %s logger failures strict without misclassifying them as domain failures',
    async (environment) => {
      state.environment = environment;
      const loggerFailure = new Error('logger-failure-canary');
      state.stdoutFailure = loggerFailure;

      await expect(invoke(requestEvent({ requestId: 'strict-logger' }))).rejects.toBe(loggerFailure);

      expect(state.stdoutAttempts).toHaveLength(1);
      expect(state.stderrAttempts).toHaveLength(0);
    }
  );

  it('keeps a successful production response when the primary logger sink fails', async () => {
    state.environment = 'production';
    state.stdoutFailure = new Error('production-sink-canary');

    const result = await invoke(requestEvent({ requestId: 'production-success' }));

    expect(result.status).toBe(200);
    expect(state.stdoutAttempts).toHaveLength(1);
    expect(state.stderrAttempts).toHaveLength(1);
    expect(JSON.parse(state.stderrLines[0]!)).toEqual({
      version: 1,
      timestamp: '2026-08-25T12:34:56.789Z',
      severity: 'error',
      service: 'web',
      event: 'logging.failure',
      outcome: 'failed'
    });
  });

  it('rethrows the identical production domain error when failure logging also fails', async () => {
    state.environment = 'production';
    const cause = new Error('domain-error-canary');
    state.stderrFailure = new Error('production-stderr-canary');
    mocks.resolve.mockRejectedValue(cause);

    await expect(invoke(requestEvent({ requestId: 'production-failure' }))).rejects.toBe(cause);

    expect(state.stderrAttempts).toHaveLength(2);
  });

  it('does not serialize request or authentication privacy canaries', async () => {
    const event = requestEvent({
      pathname: '/pathname-segment-canary',
      query: '?secret=query-canary',
      routeId: '/library/[titleId]',
      requestId: 'privacy-request',
      cookie: 'session=cookie-canary'
    });
    mocks.getSession.mockResolvedValue({
      user: {
        id: 'auth-id-canary',
        name: 'auth-name-canary',
        email: 'auth-email-canary@example.test',
        emailVerified: true
      },
      session: {
        id: 'auth-session-canary',
        userId: 'auth-id-canary',
        expiresAt: new Date('2026-09-01T00:00:00.000Z')
      }
    });

    await invoke(event);

    const line = [...state.stdoutLines, ...state.stderrLines].join('');
    for (const canary of [
      'pathname-segment-canary',
      'query-canary',
      'cookie-canary',
      'auth-id-canary',
      'auth-name-canary',
      'auth-email-canary',
      'auth-session-canary'
    ]) {
      expect(line).not.toContain(canary);
    }
    expect(records()[0]).toMatchObject({
      correlationId: 'privacy-request',
      route: '/library/[titleId]'
    });
  });
});

describe('internal subrequest behavior', () => {
  it('reuses ambient context and emits no second ingress lifecycle record', async () => {
    const event = requestEvent({
      isSubRequest: true,
      requestId: 'conflicting-header',
      routeId: '/internal/[asset]'
    });
    const seen: string[] = [];
    mocks.getSession.mockImplementation(async () => {
      seen.push(getDiagnosticContext()!.correlationId);
      return null;
    });
    mocks.resolve.mockImplementation(async (resolvedEvent) => {
      seen.push(getDiagnosticContext()!.correlationId);
      seen.push(correlationIdForRequest(resolvedEvent.request));
      return response();
    });

    const result = await runWithDiagnosticContext(
      { kind: 'web', correlationId: correlationIdForRequest(new Request('https://books.example.test', {
        headers: { 'x-request-id': 'ambient-parent' }
      })) },
      () => invoke(event)
    );

    expect(result.status).toBe(200);
    expect(seen).toEqual(['ambient-parent', 'ambient-parent', 'ambient-parent']);
    expect(records()).toEqual([]);
  });
});
