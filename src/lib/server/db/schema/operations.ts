import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import type { JsonObject, JsonValue } from './json';

export const jobStatus = pgEnum('job_status', ['pending', 'running', 'succeeded', 'failed']);
export const outboxStatus = pgEnum('outbox_status', ['pending', 'delivered', 'failed']);
export const auditActorType = pgEnum('audit_actor_type', [
  'anonymous',
  'guest',
  'user',
  'system'
]);
export const auditOutcome = pgEnum('audit_outcome', ['succeeded', 'failed', 'denied']);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    deduplicationKey: text('deduplication_key'),
    status: jobStatus('status').default('pending').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(5).notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    rerunRequestedAt: timestamp('rerun_requested_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('jobs_deduplication_key_unique').on(table.deduplicationKey),
    index('jobs_claim_idx').on(table.status, table.runAt, table.lockedAt, table.createdAt),
    index('jobs_failed_updated_idx').on(table.status, table.updatedAt),
    check('jobs_attempts_nonnegative', sql`${table.attempts} >= 0`),
    check('jobs_max_attempts_positive', sql`${table.maxAttempts} > 0`),
    check(
      'jobs_running_has_lease',
      sql`(${table.status} = 'running') = (${table.lockedAt} is not null and ${table.lockedBy} is not null)`
    ),
    check(
      'jobs_terminal_has_completion',
      sql`(${table.status} in ('succeeded', 'failed')) = (${table.completedAt} is not null)`
    ),
    check(
      'jobs_rerun_requires_running',
      sql`${table.rerunRequestedAt} is null or ${table.status} = 'running'`
    )
  ]
);

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    deduplicationKey: text('deduplication_key'),
    dispatchJobId: uuid('dispatch_job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    status: outboxStatus('status').default('pending').notNull(),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('outbox_messages_dispatch_job_unique').on(table.dispatchJobId),
    uniqueIndex('outbox_messages_deduplication_key_unique')
      .on(table.deduplicationKey)
      .where(sql`${table.deduplicationKey} is not null`),
    index('outbox_messages_status_created_idx').on(table.status, table.createdAt),
    check(
      'outbox_delivered_has_timestamp',
      sql`(${table.status} = 'delivered') = (${table.deliveredAt} is not null)`
    )
  ]
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    actorType: auditActorType('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    outcome: auditOutcome('outcome').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    correlationId: text('correlation_id').notNull(),
    requestMetadata: jsonb('request_metadata').$type<JsonValue>(),
    before: jsonb('before').$type<JsonValue>(),
    after: jsonb('after').$type<JsonValue>()
  },
  (table) => [
    index('audit_events_occurred_idx').on(table.occurredAt),
    index('audit_events_resource_idx').on(table.resourceType, table.resourceId, table.occurredAt),
    index('audit_events_actor_idx').on(table.actorType, table.actorId, table.occurredAt),
    index('audit_events_correlation_idx').on(table.correlationId),
    index('audit_events_action_occurred_idx').on(table.action, table.occurredAt),
    index('audit_events_outcome_occurred_idx').on(table.outcome, table.occurredAt),
    check(
      'audit_events_actor_id_required',
      sql`${table.actorType} = 'anonymous' or ${table.actorId} is not null`
    )
  ]
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type OutboxMessageRow = typeof outboxMessages.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
