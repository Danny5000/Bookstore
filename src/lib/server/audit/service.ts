import type { Actor } from '$lib/server/auth/admin-policy';
import { auditEvents, type AuditEventRow, type JsonValue } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { redactAuditDetails } from './redact';

export interface AppendAuditEventInput {
  actor: Actor;
  action: string;
  outcome: 'succeeded' | 'failed' | 'denied';
  resourceType: string;
  resourceId?: string | null;
  correlationId: string;
  requestMetadata?: JsonValue | null;
  before?: JsonValue | null;
  after?: JsonValue | null;
}

export async function appendAuditEvent(
  database: DatabaseExecutor,
  input: AppendAuditEventInput
): Promise<AuditEventRow> {
  const [event] = await database
    .insert(auditEvents)
    .values({
      actorType: input.actor.type,
      actorId: input.actor.type === 'anonymous' ? null : input.actor.id,
      action: input.action,
      outcome: input.outcome,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      correlationId: input.correlationId,
      requestMetadata:
        input.requestMetadata == null ? null : redactAuditDetails(input.requestMetadata),
      before: input.before == null ? null : redactAuditDetails(input.before),
      after: input.after == null ? null : redactAuditDetails(input.after)
    })
    .returning();

  if (!event) throw new Error('Audit event insert returned no row');
  return event;
}
