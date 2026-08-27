import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';
import {
  JOB_DEFINITIONS,
  JOB_RETRY_POLICY_OUTCOMES,
  REGISTERED_JOB_KINDS
} from '../../jobs/catalog';
import { user } from './auth';
import { jobs } from './operations';

function literal(value: string): SQL {
  return sql.raw(`'${value.replaceAll("'", "''")}'`);
}

function oneOf(value: SQLWrapper, values: readonly string[]): SQL {
  return sql`${value} in (${sql.join(values.map(literal), sql`, `)})`;
}

function policyOutcomeIsKindConsistent(
  targetJobKind: SQLWrapper,
  status: SQLWrapper,
  safeResultCode: SQLWrapper
): SQL {
  const policyBranches = JOB_DEFINITIONS.map((definition) => {
    const outcomes = JOB_RETRY_POLICY_OUTCOMES.filter(
      ([policyId]) => policyId === definition.retryPolicyId
    );
    return sql`(${targetJobKind} = ${literal(definition.kind)} and (
      ${sql.join(outcomes.map(([, outcomeStatus, resultCode]) =>
        sql`(${status} = ${literal(outcomeStatus)} and
          ${safeResultCode} = ${literal(resultCode)})`), sql` or `)}
    ))`;
  });
  const commonBranches = [
    sql`(${status} = 'denied' and ${safeResultCode} = 'actor_not_authorized')`,
    sql`(${status} = 'failed' and ${safeResultCode} = 'retry_command_invalid')`,
    sql`(${status} = 'failed' and ${safeResultCode} = 'retry_command_exhausted')`,
    sql`(${status} = 'failed' and ${safeResultCode} = 'unexpected_failure')`
  ];

  return sql`(${sql.join([...policyBranches, ...commonBranches], sql` or `)})`;
}

export const operationsJobRetryCommandStatus = pgEnum(
  'operations_job_retry_command_status',
  ['pending', 'succeeded', 'denied', 'failed']
);

export const operationsJobRetryResultCode = pgEnum(
  'operations_job_retry_result_code',
  [
    'rearmed_existing',
    'successor_enqueued',
    'already_current',
    'retry_not_supported',
    'retry_policy_not_enabled',
    'provider_recovery_not_enabled',
    'target_not_failed',
    'target_state_changed',
    'domain_state_not_retryable',
    'source_unavailable',
    'actor_not_authorized',
    'retry_command_invalid',
    'retry_command_exhausted',
    'unexpected_failure'
  ]
);

export const operationsJobRetryReasonCode = pgEnum(
  'operations_job_retry_reason_code',
  ['dependency_recovered', 'configuration_recovered', 'operator_reassessment']
);

export const operationsJobRetryClaimState = pgEnum(
  'operations_job_retry_claim_state',
  ['active', 'invalidated']
);

export const operationsJobRetryCommands = pgTable(
  'operations_job_retry_commands',
  {
    id: uuid('id').defaultRandom().notNull(),
    kind: varchar('kind', { length: 32 }).default('retry_failed_job').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    targetJobId: uuid('target_job_id').notNull(),
    targetJobKind: varchar('target_job_kind', { length: 100 }).notNull(),
    expectedStatus: varchar('expected_status', { length: 16 }).notNull(),
    expectedAttempts: integer('expected_attempts').notNull(),
    expectedMaxAttempts: integer('expected_max_attempts').notNull(),
    expectedUpdatedAt: timestamp('expected_updated_at', { withTimezone: true }).notNull(),
    reasonCode: operationsJobRetryReasonCode('reason_code').notNull(),
    correlationId: varchar('correlation_id', { length: 100 }).notNull(),
    idempotencyKeySha256: varchar('idempotency_key_sha256', { length: 64 }).notNull(),
    inputFingerprintSha256: varchar('input_fingerprint_sha256', { length: 64 }).notNull(),
    status: operationsJobRetryCommandStatus('status').default('pending').notNull(),
    safeResultCode: operationsJobRetryResultCode('safe_result_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true })
  },
  (table) => [
    primaryKey({
      name: 'plan7a_operations_retry_commands_pkey',
      columns: [table.id]
    }),
    foreignKey({
      name: 'plan7a_operations_retry_commands_actor_fk',
      columns: [table.actorUserId],
      foreignColumns: [user.id]
    }).onUpdate('restrict').onDelete('restrict'),
    foreignKey({
      name: 'plan7a_operations_retry_commands_target_job_fk',
      columns: [table.targetJobId],
      foreignColumns: [jobs.id]
    }).onUpdate('restrict').onDelete('restrict'),
    uniqueIndex('plan7a_operations_retry_commands_actor_idempotency_unique').on(
      table.actorUserId,
      table.idempotencyKeySha256
    ),
    index('plan7a_operations_retry_commands_status_created_idx').on(
      table.status,
      table.createdAt,
      table.id
    ),
    index('plan7a_operations_retry_commands_target_created_idx').on(
      table.targetJobId,
      table.createdAt,
      table.id
    ),
    check(
      'plan7a_operations_retry_commands_kind_fixed',
      sql`(${table.kind} = 'retry_failed_job') is true`
    ),
    check(
      'plan7a_operations_retry_commands_target_kind_registered',
      sql`(${oneOf(table.targetJobKind, REGISTERED_JOB_KINDS)}) is true`
    ),
    check(
      'plan7a_operations_retry_commands_expected_state_consistent',
      sql`(
        ${table.expectedStatus} = 'failed'
        and ${table.expectedAttempts} between 1 and ${table.expectedMaxAttempts}
        and ${table.expectedMaxAttempts} between 1 and 2147483647
        and pg_catalog.isfinite(${table.expectedUpdatedAt})
      ) is true`
    ),
    check(
      'plan7a_operations_retry_commands_correlation_canonical',
      sql`(${table.correlationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$') is true`
    ),
    check(
      'plan7a_operations_retry_commands_hashes_sha256',
      sql`(
        ${table.idempotencyKeySha256} ~ '^[a-f0-9]{64}$'
        and ${table.inputFingerprintSha256} ~ '^[a-f0-9]{64}$'
      ) is true`
    ),
    check(
      'plan7a_operations_retry_commands_lifecycle_consistent',
      sql`(
        pg_catalog.isfinite(${table.createdAt})
        and pg_catalog.isfinite(${table.updatedAt})
        and ${table.createdAt} <= ${table.updatedAt}
        and ((
          ${table.status} = 'pending'
          and ${table.safeResultCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.status} in ('succeeded', 'denied', 'failed')
          and ${table.safeResultCode} is not null
          and ${table.completedAt} is not null
          and pg_catalog.isfinite(${table.completedAt})
          and ${table.completedAt} = ${table.updatedAt}
          and ${policyOutcomeIsKindConsistent(
            table.targetJobKind,
            table.status,
            table.safeResultCode
          )}
        ))
      ) is true`
    )
  ]
);

export type OperationsJobRetryCommandRow = typeof operationsJobRetryCommands.$inferSelect;
export type NewOperationsJobRetryCommandRow = typeof operationsJobRetryCommands.$inferInsert;

export const operationsJobRetryClaims = pgTable(
  'operations_job_retry_claims',
  {
    jobId: uuid('job_id').notNull(),
    commandId: uuid('command_id').notNull(),
    generation: integer('generation').notNull(),
    attempt: integer('attempt').notNull(),
    leaseOwner: varchar('lease_owner', { length: 200 }).notNull(),
    capabilitySha256: varchar('capability_sha256', { length: 64 }).notNull(),
    leaseDurationMs: integer('lease_duration_ms').notNull(),
    state: operationsJobRetryClaimState('state').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    renewedAt: timestamp('renewed_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true })
  },
  (table) => [
    primaryKey({
      name: 'plan7a_operations_retry_claims_pkey',
      columns: [table.jobId]
    }),
    foreignKey({
      name: 'plan7a_operations_retry_claims_job_fk',
      columns: [table.jobId],
      foreignColumns: [jobs.id]
    }).onUpdate('restrict').onDelete('restrict'),
    foreignKey({
      name: 'plan7a_operations_retry_claims_command_fk',
      columns: [table.commandId],
      foreignColumns: [operationsJobRetryCommands.id]
    }).onUpdate('restrict').onDelete('restrict'),
    uniqueIndex('plan7a_operations_retry_claims_command_unique').on(table.commandId),
    check(
      'plan7a_operations_retry_claims_generation_positive',
      sql`(${table.generation} between 1 and 2147483647) is true`
    ),
    check(
      'plan7a_operations_retry_claims_attempt_positive',
      sql`(${table.attempt} between 1 and 2147483647) is true`
    ),
    check(
      'plan7a_operations_retry_claims_lease_owner_canonical',
      sql`(${table.leaseOwner} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$') is true`
    ),
    check(
      'plan7a_operations_retry_claims_capability_sha256',
      sql`(${table.capabilitySha256} ~ '^[a-f0-9]{64}$') is true`
    ),
    check(
      'plan7a_operations_retry_claims_lease_duration_bounded',
      sql`(${table.leaseDurationMs} between 1 and 86400000) is true`
    ),
    check(
      'plan7a_operations_retry_claims_lifecycle_consistent',
      sql`(
        pg_catalog.isfinite(${table.issuedAt})
        and pg_catalog.isfinite(${table.expiresAt})
        and ${table.expiresAt} > ${table.issuedAt}
        and (${table.renewedAt} is null or (
          pg_catalog.isfinite(${table.renewedAt})
          and ${table.renewedAt} >= ${table.issuedAt}
          and ${table.expiresAt} > ${table.renewedAt}
        ))
        and ((
          ${table.state} = 'active'
          and ${table.invalidatedAt} is null
        ) or (
          ${table.state} = 'invalidated'
          and ${table.invalidatedAt} is not null
          and pg_catalog.isfinite(${table.invalidatedAt})
          and ${table.invalidatedAt} >= coalesce(
            ${table.renewedAt}, ${table.issuedAt}
          )
        ))
      ) is true`
    )
  ]
);

export type OperationsJobRetryClaimRow = typeof operationsJobRetryClaims.$inferSelect;
export type NewOperationsJobRetryClaimRow = typeof operationsJobRetryClaims.$inferInsert;
