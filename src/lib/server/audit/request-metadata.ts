import type { JsonObject } from '$lib/server/db/schema';

export interface AuditRequestMetadata extends JsonObject {
  method: string;
  routeId: string | null;
}

export function safeAuditRequestMetadata(
  request: Request,
  routeId: string | null
): AuditRequestMetadata {
  return {
    method: request.method.slice(0, 16),
    routeId: routeId?.slice(0, 500) ?? null
  };
}
