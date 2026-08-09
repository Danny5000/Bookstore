import { Buffer } from 'node:buffer';
import { and, desc, eq, gte, lt, lte, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import { auditEvents, type AuditEventRow, type JsonValue } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { redactAuditDetails } from './redact';
import { appendAuditEvent } from './service';

const utcDateString = z.string().trim().max(200).regex(/Z$/u).pipe(z.iso.datetime());
const cursorPayloadSchema = z.strictObject({ occurredAt: utcDateString, id: z.uuid() });
const optionalText = z.string().trim().min(1).max(200).optional();
const rawFiltersSchema = z
  .strictObject({
    actorId: optionalText,
    action: optionalText,
    resourceType: optionalText,
    resourceId: optionalText,
    outcome: z.enum(['succeeded', 'failed', 'denied']).optional(),
    from: utcDateString.optional(),
    to: utcDateString.optional(),
    cursor: z.string().trim().min(1).max(200).optional(),
    pageSize: z.string().regex(/^\d{1,2}$/u).transform(Number).pipe(z.number().int().min(1).max(50)).optional()
  })
  .superRefine((value, context) => {
    if (value.from && value.to && new Date(value.from) > new Date(value.to)) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'Date range is inverted' });
    }
  });

export interface AuditCursor {
  occurredAt: Date;
  id: string;
}

export interface AuditFilters {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: 'succeeded' | 'failed' | 'denied';
  from?: Date;
  to?: Date;
  cursor?: AuditCursor;
  pageSize: number;
}

export interface AuditEventSummary {
  id: string;
  occurredAt: Date;
  actorType: AuditEventRow['actorType'];
  actorId: string | null;
  action: string;
  outcome: AuditEventRow['outcome'];
  resourceType: string;
  resourceId: string | null;
  correlationId: string;
}

export interface AuditEventDetail extends AuditEventSummary {
  requestMetadata: JsonValue | null;
  before: JsonValue | null;
  after: JsonValue | null;
}

export interface AuditPage {
  events: readonly AuditEventSummary[];
  nextCursor: string | null;
}

export function encodeAuditCursor(value: { occurredAt: Date | string; id: string }): string {
  const parsed = cursorPayloadSchema.parse({
    occurredAt: value.occurredAt instanceof Date ? value.occurredAt.toISOString() : value.occurredAt,
    id: value.id
  });
  return Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');
}

export function decodeAuditCursor(value: string): AuditCursor {
  if (value.length > 200) throw new Error('Audit cursor is too long');
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Audit cursor is malformed');
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Noncanonical base64url');
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Audit cursor is malformed');
  }
  const parsed = cursorPayloadSchema.parse(decoded);
  return { occurredAt: new Date(parsed.occurredAt), id: parsed.id };
}

export function parseAuditFilters(search: URLSearchParams): AuditFilters {
  const allowed = new Set(Object.keys(rawFiltersSchema.shape));
  const raw: Record<string, string> = {};
  for (const key of new Set(search.keys())) {
    if (!allowed.has(key) || search.getAll(key).length !== 1) {
      throw new Error('Audit query parameters are invalid');
    }
    const value = search.get(key);
    if (value !== null && value !== '') raw[key] = value;
  }
  const parsed = rawFiltersSchema.parse(raw);
  return {
    ...(parsed.actorId ? { actorId: parsed.actorId } : {}),
    ...(parsed.action ? { action: parsed.action } : {}),
    ...(parsed.resourceType ? { resourceType: parsed.resourceType } : {}),
    ...(parsed.resourceId ? { resourceId: parsed.resourceId } : {}),
    ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
    ...(parsed.from ? { from: new Date(parsed.from) } : {}),
    ...(parsed.to ? { to: new Date(parsed.to) } : {}),
    ...(parsed.cursor ? { cursor: decodeAuditCursor(parsed.cursor) } : {}),
    pageSize: parsed.pageSize ?? 25
  };
}

const summaryProjection = {
  id: auditEvents.id,
  occurredAt: auditEvents.occurredAt,
  actorType: auditEvents.actorType,
  actorId: auditEvents.actorId,
  action: auditEvents.action,
  outcome: auditEvents.outcome,
  resourceType: auditEvents.resourceType,
  resourceId: auditEvents.resourceId,
  correlationId: auditEvents.correlationId
} as const;

export async function listAuditEvents(
  database: Database,
  actor: Actor,
  filters: AuditFilters
): Promise<AuditPage> {
  requireCapability(actor, 'audit.read');
  const conditions: SQL[] = [];
  if (filters.actorId) conditions.push(eq(auditEvents.actorId, filters.actorId));
  if (filters.action) conditions.push(eq(auditEvents.action, filters.action));
  if (filters.resourceType) conditions.push(eq(auditEvents.resourceType, filters.resourceType));
  if (filters.resourceId) conditions.push(eq(auditEvents.resourceId, filters.resourceId));
  if (filters.outcome) conditions.push(eq(auditEvents.outcome, filters.outcome));
  if (filters.from) conditions.push(gte(auditEvents.occurredAt, filters.from));
  if (filters.to) conditions.push(lte(auditEvents.occurredAt, filters.to));
  if (filters.cursor) {
    conditions.push(or(
      lt(auditEvents.occurredAt, filters.cursor.occurredAt),
      and(
        eq(auditEvents.occurredAt, filters.cursor.occurredAt),
        lt(auditEvents.id, filters.cursor.id)
      )
    )!);
  }
  const rows = await database
    .select(summaryProjection)
    .from(auditEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(filters.pageSize + 1);
  const events = rows.slice(0, filters.pageSize);
  const last = events.at(-1);
  return {
    events,
    nextCursor: rows.length > filters.pageSize && last
      ? encodeAuditCursor({ occurredAt: last.occurredAt, id: last.id })
      : null
  };
}

function summary(event: AuditEventRow): AuditEventSummary {
  return {
    id: event.id,
    occurredAt: event.occurredAt,
    actorType: event.actorType,
    actorId: event.actorId,
    action: event.action,
    outcome: event.outcome,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    correlationId: event.correlationId
  };
}

export async function getAuditEventDetail(
  database: Database,
  command: { actor: Actor; eventId: string; correlationId: string }
): Promise<AuditEventDetail | null> {
  requireCapability(command.actor, 'audit.read');
  return withTransaction(database, async (transaction) => {
    const [event] = await transaction
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, command.eventId))
      .limit(1);
    if (!event) return null;
    await appendAuditEvent(transaction, {
      actor: command.actor,
      action: 'audit.event.view',
      outcome: 'succeeded',
      resourceType: 'audit_event',
      resourceId: event.id,
      correlationId: command.correlationId,
      after: { viewedEventId: event.id }
    });
    return {
      ...summary(event),
      requestMetadata: event.requestMetadata == null ? null : redactAuditDetails(event.requestMetadata),
      before: event.before == null ? null : redactAuditDetails(event.before),
      after: event.after == null ? null : redactAuditDetails(event.after)
    };
  });
}
