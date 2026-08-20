import type { AuditRequestMetadata } from '$lib/server/audit/request-metadata';

export const FINANCIAL_REQUEST_CONTEXT_KEYS = ['correlationId', 'requestMetadata'] as const;

export interface FinancialRequestContext {
  readonly correlationId: string;
  readonly requestMetadata?: AuditRequestMetadata;
}
