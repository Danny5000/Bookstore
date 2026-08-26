import type {
  CorrelationId,
  SafeCode,
  StructuredEventInputFor
} from './contracts';
import type { StructuredLogger } from './logger';
import { defineSafeCode } from './safe-error';

interface HttpLifecycleCommonInput {
  readonly correlationId: CorrelationId;
  readonly method: string;
  readonly routeId: string | null | undefined;
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface HttpResponseLifecycleInput extends HttpLifecycleCommonInput {
  readonly status: number;
  readonly maintenance: boolean;
}

export interface HttpEscapedExceptionLifecycleInput extends HttpLifecycleCommonInput {
  readonly escapedException: true;
  readonly code: SafeCode<'unexpected_failure'>;
}

export type HttpLifecycleInput =
  | HttpResponseLifecycleInput
  | HttpEscapedExceptionLifecycleInput;

const HTTP_METHOD = /^[A-Za-z]{1,16}$/;
const MAX_DURATION_MS = 86_400_000;
const UNMATCHED_ROUTE = 'unmatched';

function normalizeMethod(value: string): string {
  return HTTP_METHOD.test(value) ? value.toUpperCase() : 'UNKNOWN';
}

function normalizeRoute(value: string | null | undefined): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    ? value
    : UNMATCHED_ROUTE;
}

function normalizeDuration(startedAt: number, endedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
    return 0;
  }
  return Math.min(MAX_DURATION_MS, Math.trunc(endedAt - startedAt));
}

function rejectedCode(status: number) {
  switch (status) {
    case 400: return defineSafeCode('invalid_request');
    case 401: return defineSafeCode('unauthenticated');
    case 403: return defineSafeCode('forbidden');
    case 404: return defineSafeCode('not_found');
    case 405: return defineSafeCode('method_not_allowed');
    case 409: return defineSafeCode('conflict');
    case 413: return defineSafeCode('payload_too_large');
    case 415: return defineSafeCode('unsupported_media_type');
    case 422: return defineSafeCode('invalid_input');
    case 429: return defineSafeCode('rate_limited');
    default: return defineSafeCode('request_rejected');
  }
}

function assertHttpStatus(status: number): void {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError('invalid HTTP lifecycle status');
  }
}

export function createHttpLifecycleEvent(
  input: HttpLifecycleInput
): StructuredEventInputFor<'web'> {
  const common = {
    correlationId: input.correlationId,
    method: normalizeMethod(input.method),
    route: normalizeRoute(input.routeId),
    durationMs: normalizeDuration(input.startedAt, input.endedAt)
  };

  if ('escapedException' in input) {
    if (input.escapedException !== true || input.code !== 'unexpected_failure') {
      throw new TypeError('invalid escaped HTTP lifecycle condition');
    }
    return {
      event: 'http.request.failed',
      correlationId: common.correlationId,
      method: common.method,
      route: common.route,
      httpStatus: 500,
      code: input.code,
      durationMs: common.durationMs
    };
  }

  assertHttpStatus(input.status);
  if (typeof input.maintenance !== 'boolean') {
    throw new TypeError('invalid HTTP lifecycle maintenance marker');
  }

  if (input.status >= 100 && input.status <= 399) {
    return {
      event: 'http.request.completed',
      correlationId: common.correlationId,
      method: common.method,
      route: common.route,
      httpStatus: input.status,
      durationMs: common.durationMs
    };
  }

  if (input.status >= 400 && input.status <= 499) {
    return {
      event: 'http.request.rejected',
      correlationId: common.correlationId,
      method: common.method,
      route: common.route,
      httpStatus: input.status,
      code: rejectedCode(input.status),
      durationMs: common.durationMs
    };
  }

  if (input.status === 503 && input.maintenance) {
    return {
      event: 'http.request.rejected',
      correlationId: common.correlationId,
      method: common.method,
      route: common.route,
      httpStatus: input.status,
      code: defineSafeCode('maintenance_mode'),
      durationMs: common.durationMs
    };
  }

  return {
    event: 'http.request.failed',
    correlationId: common.correlationId,
    method: common.method,
    route: common.route,
    httpStatus: input.status,
    code: defineSafeCode('http_server_error'),
    durationMs: common.durationMs
  };
}

export function emitHttpLifecycleEvent(
  logger: StructuredLogger<'web'>,
  input: HttpLifecycleInput
): StructuredEventInputFor<'web'> {
  const event = createHttpLifecycleEvent(input);
  logger.emit(event);
  return event;
}
