import type { Actor } from '$lib/server/auth/admin-policy';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import type { CorrelationId } from '$lib/server/observability/contracts';

export async function auditJobRetryRequestDenied(
  database: DatabaseExecutor,
  actor: Actor,
  correlationId: CorrelationId
): Promise<void> {
  await appendAuditEvent(database, {
    actor,
    action: 'operations.job_retry.requested',
    outcome: 'denied',
    resourceType: 'operations_job_retry_command',
    resourceId: null,
    correlationId,
    requestMetadata: null,
    before: null,
    after: null
  });
}
