import { ZodError, z } from 'zod';
import {
  AuthorizationError,
  requireCapability,
  type Actor,
  type AdminCapability,
  type AdministratorActor,
  type FinancialAuthorizationDependencies
} from '$lib/server/auth/admin-policy';
import { safeAuditRequestMetadata } from '$lib/server/audit/request-metadata';
import type { FinancialRequestContext } from '$lib/server/commerce/reporting/context';
import { SalesReportingInputError } from '$lib/server/commerce/reporting/filters';
import { FinancialAdminCommandSubmissionConflictError } from '$lib/server/commerce/financial/admin-commands/repository';
import { RefundReviewInputError } from '$lib/server/commerce/financial/refund-review/inputs';
import { StrictHttpError } from '$lib/server/http/strict-json';
import { correlationIdForRequest } from '$lib/server/observability/context';

export type FinancialRouteFailure =
  | { readonly status: 400; readonly code: 'invalid_request' }
  | { readonly status: 401; readonly code: 'unauthenticated' }
  | { readonly status: 403; readonly code: 'forbidden' }
  | { readonly status: 404; readonly code: 'not_found' }
  | { readonly status: 409; readonly code: 'stale_state' }
  | { readonly status: 503; readonly code: 'temporarily_unavailable' };

export type FinancialRouteFailureCode = FinancialRouteFailure['code'];

type FinancialRouteFailureContract = {
  readonly [Code in FinancialRouteFailureCode]: Extract<
    FinancialRouteFailure,
    { readonly code: Code }
  >;
};

const failureByCode = {
  invalid_request: { status: 400, code: 'invalid_request' },
  unauthenticated: { status: 401, code: 'unauthenticated' },
  forbidden: { status: 403, code: 'forbidden' },
  not_found: { status: 404, code: 'not_found' },
  stale_state: { status: 409, code: 'stale_state' },
  temporarily_unavailable: { status: 503, code: 'temporarily_unavailable' }
} as const satisfies FinancialRouteFailureContract;

type FinancialDomainRouteFailureCode = Extract<
  FinancialRouteFailureCode,
  'not_found' | 'stale_state' | 'temporarily_unavailable'
>;

const canonicalUuidSchema = z.uuid().refine((value) => value === value.toLowerCase());

export class FinancialRouteInputError extends Error {
  constructor(_unsafeDetail?: unknown) {
    super('The financial request input is invalid.');
    this.name = 'FinancialRouteInputError';
  }
}

export class FinancialRouteError extends Error {
  constructor(readonly code: FinancialDomainRouteFailureCode) {
    super(code);
    this.name = 'FinancialRouteError';
  }
}

export function withFinancialRouteAuthorization<T>(
  actor: Actor,
  capability: AdminCapability,
  operation: (actor: AdministratorActor) => T,
  dependencies: FinancialAuthorizationDependencies = {}
): T {
  requireCapability(actor, capability, dependencies.capabilityResolver);
  return operation(actor);
}

export function requireFinancialRouteUuid(value: string | undefined): string {
  const parsed = canonicalUuidSchema.safeParse(value);
  if (!parsed.success) throw new FinancialRouteError('not_found');
  return parsed.data;
}

export function createFinancialRequestContext(
  request: Request,
  routeId: string | null
): FinancialRequestContext {
  return {
    correlationId: correlationIdForRequest(request),
    requestMetadata: safeAuditRequestMetadata(request, routeId)
  };
}

function safeFailure(code: FinancialRouteFailureCode): FinancialRouteFailure {
  return failureByCode[code];
}

export function financialActionFailure(cause: unknown): FinancialRouteFailure {
  if (cause instanceof AuthorizationError) return safeFailure(cause.code);
  if (cause instanceof StrictHttpError && cause.status === 403 && cause.code === 'forbidden') {
    return safeFailure('forbidden');
  }
  if (cause instanceof FinancialAdminCommandSubmissionConflictError) {
    return safeFailure('stale_state');
  }
  if (
    cause instanceof FinancialRouteInputError ||
    cause instanceof RefundReviewInputError ||
    cause instanceof SalesReportingInputError ||
    cause instanceof ZodError ||
    cause instanceof SyntaxError
  ) {
    return safeFailure('invalid_request');
  }
  if (cause instanceof FinancialRouteError) return safeFailure(cause.code);
  return safeFailure('temporarily_unavailable');
}
