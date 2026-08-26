import { describe, expect, it, vi } from 'vitest';

import { normalizeOrCreateCorrelationId } from './context';
import {
  createHttpLifecycleEvent,
  emitHttpLifecycleEvent,
  type HttpLifecycleInput,
  type HttpResponseLifecycleInput
} from './http-lifecycle';
import { defineSafeCode } from './safe-error';

const correlationId = normalizeOrCreateCorrelationId('request-123');

const responseInput = (
  status: number,
  overrides: Partial<HttpResponseLifecycleInput> = {}
): HttpLifecycleInput => ({
  correlationId,
  method: 'GET',
  routeId: '/library/[titleId]/download',
  startedAt: 10,
  endedAt: 15.9,
  status,
  maintenance: false,
  ...overrides
} as HttpLifecycleInput);

describe('HTTP lifecycle classification', () => {
  it.each([100, 204, 302, 399])(
    'classifies returned status %i as completed without a code',
    (status) => {
      expect(createHttpLifecycleEvent(responseInput(status))).toEqual({
        event: 'http.request.completed',
        correlationId,
        method: 'GET',
        route: '/library/[titleId]/download',
        httpStatus: status,
        durationMs: 5
      });
    }
  );

  it.each([
    [400, 'invalid_request'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [405, 'method_not_allowed'],
    [409, 'conflict'],
    [413, 'payload_too_large'],
    [415, 'unsupported_media_type'],
    [422, 'invalid_input'],
    [429, 'rate_limited']
  ] as const)('maps returned status %i to the named rejection code', (status, code) => {
    expect(createHttpLifecycleEvent(responseInput(status))).toEqual({
      event: 'http.request.rejected',
      correlationId,
      method: 'GET',
      route: '/library/[titleId]/download',
      httpStatus: status,
      code,
      durationMs: 5
    });
  });

  it.each([402, 406, 418, 499])(
    'maps other returned 4xx status %i to request_rejected',
    (status) => {
      expect(createHttpLifecycleEvent(responseInput(status))).toMatchObject({
        event: 'http.request.rejected',
        httpStatus: status,
        code: 'request_rejected'
      });
    }
  );

  it('distinguishes the intentional maintenance 503 short-circuit', () => {
    expect(createHttpLifecycleEvent(responseInput(503, { maintenance: true }))).toMatchObject({
      event: 'http.request.rejected',
      httpStatus: 503,
      code: 'maintenance_mode'
    });
    expect(createHttpLifecycleEvent(responseInput(503))).toMatchObject({
      event: 'http.request.failed',
      httpStatus: 503,
      code: 'http_server_error'
    });
  });

  it.each([500, 501, 599])(
    'maps other returned 5xx status %i to http_server_error',
    (status) => {
      expect(createHttpLifecycleEvent(responseInput(status))).toMatchObject({
        event: 'http.request.failed',
        httpStatus: status,
        code: 'http_server_error'
      });
    }
  );

  it('reduces an escaping exception terminal condition to the supplied safe code and fixed status', () => {
    expect(createHttpLifecycleEvent({
      correlationId,
      method: 'POST',
      routeId: '/admin/catalog/[titleId]',
      startedAt: 20,
      endedAt: 23,
      escapedException: true,
      code: defineSafeCode('unexpected_failure')
    })).toEqual({
      event: 'http.request.failed',
      correlationId,
      method: 'POST',
      route: '/admin/catalog/[titleId]',
      httpStatus: 500,
      code: 'unexpected_failure',
      durationMs: 3
    });
  });

  it('rejects response statuses outside the trusted HTTP range', () => {
    expect(() => createHttpLifecycleEvent(responseInput(99))).toThrow(TypeError);
    expect(() => createHttpLifecycleEvent(responseInput(600))).toThrow(TypeError);
    expect(() => createHttpLifecycleEvent(responseInput(200.5))).toThrow(TypeError);
  });
});

describe('HTTP lifecycle safe normalization', () => {
  it.each([
    ['/health/ready', '/health/ready'],
    ['/library/[titleId]/download', '/library/[titleId]/download'],
    ['x'.repeat(200), 'x'.repeat(200)],
    ['', 'unmatched'],
    [undefined, 'unmatched'],
    [null, 'unmatched'],
    ['x'.repeat(201), 'unmatched']
  ] as const)('normalizes the static route identifier %j to %j', (routeId, route) => {
    expect(createHttpLifecycleEvent(responseInput(200, { routeId }))).toMatchObject({ route });
  });

  it.each([
    ['GET', 'GET'],
    ['X', 'X'],
    ['ABCDEFGHIJKLMNOP', 'ABCDEFGHIJKLMNOP'],
    ['get', 'GET'],
    ['post', 'POST'],
    ['mIxEd', 'MIXED'],
    ['', 'UNKNOWN'],
    ['GÉT', 'UNKNOWN'],
    ['GET!', 'UNKNOWN'],
    ['GET POST', 'UNKNOWN'],
    ['ABCDEFGHIJKLMNOPQ', 'UNKNOWN']
  ])('normalizes method %j to %j', (method, normalized) => {
    expect(createHttpLifecycleEvent(responseInput(200, { method }))).toMatchObject({
      method: normalized
    });
  });

  it.each([
    [1, 10.9, 9],
    [10, 10, 0],
    [10, 9, 0],
    [0, 86_400_000.99, 86_400_000],
    [0, 90_000_000, 86_400_000],
    [Number.NaN, 10, 0],
    [0, Number.POSITIVE_INFINITY, 0]
  ])('normalizes monotonic interval %j..%j to %i milliseconds', (startedAt, endedAt, durationMs) => {
    expect(createHttpLifecycleEvent(responseInput(200, { startedAt, endedAt }))).toMatchObject({
      durationMs
    });
  });

  it('does not expose or read request, URL, response, body, header, cookie, parameter, or payload inputs', () => {
    type ForbiddenKey =
      | 'request'
      | 'url'
      | 'pathname'
      | 'query'
      | 'response'
      | 'body'
      | 'headers'
      | 'cookies'
      | 'params'
      | 'formData'
      | 'actionPayload'
      | 'exception'
      | 'domainResponseCode';
    type KeysOfUnion<T> = T extends T ? keyof T : never;
    type NoForbiddenInputs = Extract<KeysOfUnion<HttpLifecycleInput>, ForbiddenKey> extends never
      ? true
      : false;
    const inputBoundaryIsExact: NoForbiddenInputs = true;
    expect(inputBoundaryIsExact).toBe(true);

    const input = responseInput(200) as HttpLifecycleInput & Record<string, unknown>;
    for (const key of [
      'request',
      'url',
      'pathname',
      'query',
      'response',
      'body',
      'headers',
      'cookies',
      'params',
      'formData',
      'actionPayload',
      'exception',
      'domainResponseCode'
    ]) {
      Object.defineProperty(input, key, {
        enumerable: true,
        get: () => {
          throw new Error(`forbidden input read: ${key}`);
        }
      });
    }

    expect(createHttpLifecycleEvent(input)).toMatchObject({
      event: 'http.request.completed',
      route: '/library/[titleId]/download'
    });
  });
});

describe('HTTP lifecycle emission', () => {
  it('passes the exact classified event to an injected web logger', () => {
    const emit = vi.fn();
    const event = emitHttpLifecycleEvent({ emit }, responseInput(204));

    expect(event).toEqual(createHttpLifecycleEvent(responseInput(204)));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(event);
  });
});
