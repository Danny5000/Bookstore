import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
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
  uuid,
  varchar
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import type { JsonObject } from './json';
import { jobs } from './operations';

const MAX_COMMAND_ITEMS = 25;

function literal(value: string): SQL {
  return sql.raw(`'${value.replaceAll("'", "''")}'`);
}

function jsonValue(value: SQLWrapper, key: string): SQL {
  return sql`${value} -> ${literal(key)}`;
}

function jsonText(value: SQLWrapper, key: string): SQL {
  return sql`${value} ->> ${literal(key)}`;
}

function exactObject(value: SQLWrapper, keys: readonly string[]): SQL {
  let remainder = sql`(${value})`;
  for (const key of keys) remainder = sql`${remainder} - ${literal(key)}`;
  return sql`(${value}) ?& array[${sql.join(keys.map(literal), sql`, `)}]::text[]
    and ${remainder} = '{}'::jsonb`;
}

function exactString(value: SQLWrapper, key: string, expected: string): SQL {
  return sql`pg_catalog.jsonb_typeof(${jsonValue(value, key)}) = 'string'
    and ${jsonText(value, key)} = ${literal(expected)}`;
}

function canonicalUuid(value: SQLWrapper, key: string): SQL {
  const textValue = jsonText(value, key);
  return sql`pg_catalog.jsonb_typeof(${jsonValue(value, key)}) = 'string'
    and case when pg_catalog.pg_input_is_valid(${textValue}, 'uuid')
      then (${textValue})::uuid::text = ${textValue}
      else false end`;
}

function boundedInteger(
  value: SQLWrapper,
  key: string,
  minimum: number,
  maximum: number
): SQL {
  const textValue = jsonText(value, key);
  return sql`pg_catalog.jsonb_typeof(${jsonValue(value, key)}) = 'number'
    and case when pg_catalog.pg_input_is_valid(${textValue}, 'integer')
      then (${textValue})::integer between ${sql.raw(String(minimum))}
        and ${sql.raw(String(maximum))}
      else false end`;
}

function sha256(value: SQLWrapper, key: string): SQL {
  return sql`pg_catalog.jsonb_typeof(${jsonValue(value, key)}) = 'string'
    and ${jsonText(value, key)} ~ '^[a-f0-9]{64}$'`;
}

function canonicalMillisecondTimestamp(value: SQLWrapper, key: string): SQL {
  const textValue = jsonText(value, key);
  return sql`pg_catalog.jsonb_typeof(${jsonValue(value, key)}) = 'string'
    and ${textValue} ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    and case when pg_catalog.pg_input_is_valid(${textValue}, 'timestamp with time zone')
      then pg_catalog.to_char(
        pg_catalog.timezone('UTC', (${textValue})::timestamptz),
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) = ${textValue}
      else false end`;
}

function commandItems(value: SQLWrapper): SQL {
  const items = jsonValue(value, 'items');
  const length = sql`pg_catalog.jsonb_array_length(${items})`;
  const itemChecks: SQL[] = [];
  const uniqueChecks: SQL[] = [];

  for (let index = 0; index < MAX_COMMAND_ITEMS; index += 1) {
    const item = sql`${items} -> ${sql.raw(String(index))}`;
    itemChecks.push(sql`(
      ${length} <= ${sql.raw(String(index))} or
      case when pg_catalog.jsonb_typeof(${item}) = 'object' then (
        ${exactObject(item, ['orderItemId', 'totalPresentmentMinor'])}
        and ${canonicalUuid(item, 'orderItemId')}
        and ${boundedInteger(item, 'totalPresentmentMinor', 0, 99999999)}
      ) else false end
    )`);
    for (let other = index + 1; other < MAX_COMMAND_ITEMS; other += 1) {
      const otherItem = sql`${items} -> ${sql.raw(String(other))}`;
      uniqueChecks.push(sql`(
        ${length} <= ${sql.raw(String(other))} or
        ${jsonText(item, 'orderItemId')}
          is distinct from ${jsonText(otherItem, 'orderItemId')}
      )`);
    }
  }

  return sql`case when pg_catalog.jsonb_typeof(${items}) = 'array' then (
    ${length} between 1 and ${sql.raw(String(MAX_COMMAND_ITEMS))}
    and ${sql.join(itemChecks, sql` and `)}
    and ${sql.join(uniqueChecks, sql` and `)}
  ) else false end`;
}

function commandInputIsKindConsistent(kind: SQLWrapper, input: SQLWrapper): SQL {
  const branches = [
    sql`${kind} = 'refund_draft_save'
      and ${exactObject(input, ['kind', 'refundId', 'expectedVersion', 'items'])}
      and ${exactString(input, 'kind', 'refund_draft_save')}
      and ${canonicalUuid(input, 'refundId')}
      and (
        pg_catalog.jsonb_typeof(${jsonValue(input, 'expectedVersion')}) = 'null'
        or ${boundedInteger(input, 'expectedVersion', 1, 2147483647)}
      )
      and ${commandItems(input)}`,
    sql`${kind} = 'refund_draft_discard'
      and ${exactObject(input, ['kind', 'refundId', 'expectedActiveDraftVersion'])}
      and ${exactString(input, 'kind', 'refund_draft_discard')}
      and ${canonicalUuid(input, 'refundId')}
      and ${boundedInteger(input, 'expectedActiveDraftVersion', 1, 2147483647)}`,
    sql`${kind} = 'refund_allocation_finalize'
      and ${exactObject(input, [
        'kind', 'refundId', 'expectedActiveDraftVersion', 'previewFingerprint', 'confirmation'
      ])}
      and ${exactString(input, 'kind', 'refund_allocation_finalize')}
      and ${canonicalUuid(input, 'refundId')}
      and ${boundedInteger(input, 'expectedActiveDraftVersion', 1, 2147483647)}
      and ${sha256(input, 'previewFingerprint')}
      and ${exactString(input, 'confirmation', 'finalize_refund_allocation')}`,
    sql`${kind} = 'refund_reporting_correction_create'
      and ${exactObject(input, [
        'kind', 'refundId', 'reason', 'expectedNextCorrectionVersion',
        'expectedBaseAllocationSetId', 'expectedSourceFingerprint', 'items',
        'previewFingerprint', 'confirmation'
      ])}
      and ${exactString(input, 'kind', 'refund_reporting_correction_create')}
      and ${canonicalUuid(input, 'refundId')}
      and ${exactString(input, 'reason', 'allocation_attribution_correction')}
      and ${boundedInteger(input, 'expectedNextCorrectionVersion', 1, 2147483647)}
      and ${canonicalUuid(input, 'expectedBaseAllocationSetId')}
      and ${sha256(input, 'expectedSourceFingerprint')}
      and ${commandItems(input)}
      and ${sha256(input, 'previewFingerprint')}
      and ${exactString(input, 'confirmation', 'create_reporting_correction')}`,
    sql`${kind} = 'administrative_recovery_activate'
      and ${exactObject(input, [
        'kind', 'refundId', 'finalizationEffectId', 'orderItemId',
        'expectedCorrectionSetId', 'expectedCorrectionVersion',
        'expectedSourceFingerprint', 'previewFingerprint', 'confirmation'
      ])}
      and ${exactString(input, 'kind', 'administrative_recovery_activate')}
      and ${canonicalUuid(input, 'refundId')}
      and ${canonicalUuid(input, 'finalizationEffectId')}
      and ${canonicalUuid(input, 'orderItemId')}
      and ${canonicalUuid(input, 'expectedCorrectionSetId')}
      and ${boundedInteger(input, 'expectedCorrectionVersion', 1, 2147483647)}
      and ${sha256(input, 'expectedSourceFingerprint')}
      and ${sha256(input, 'previewFingerprint')}
      and ${exactString(input, 'confirmation', 'activate_persistent_recovery')}`,
    sql`${kind} = 'administrative_recovery_deactivate'
      and ${exactObject(input, [
        'kind', 'recoveryGrantId', 'recoveryReferenceId',
        'expectedStateChangedAt', 'confirmation'
      ])}
      and ${exactString(input, 'kind', 'administrative_recovery_deactivate')}
      and ${canonicalUuid(input, 'recoveryGrantId')}
      and ${canonicalUuid(input, 'recoveryReferenceId')}
      and ${canonicalMillisecondTimestamp(input, 'expectedStateChangedAt')}
      and ${exactString(input, 'confirmation', 'deactivate_persistent_recovery')}`
  ];

  return sql`(case when pg_catalog.jsonb_typeof(${input}) = 'object' then (
    ((${sql.join(branches.map((branch) => sql`(${branch})`), sql`) or (`)}))
  ) else false end) is true`;
}

export const financialAdminCommandKind = pgEnum('financial_admin_command_kind', [
  'refund_draft_save',
  'refund_draft_discard',
  'refund_allocation_finalize',
  'refund_reporting_correction_create',
  'administrative_recovery_activate',
  'administrative_recovery_deactivate'
]);

export const financialAdminCommandStatus = pgEnum('financial_admin_command_status', [
  'pending', 'succeeded', 'denied', 'conflict', 'failed'
]);

export const financialAdminCommands = pgTable(
  'financial_admin_commands',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: financialAdminCommandKind('kind').notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => user.id, {
      onDelete: 'restrict'
    }),
    correlationId: varchar('correlation_id', { length: 100 }).notNull(),
    idempotencyKeySha256: varchar('idempotency_key_sha256', { length: 64 }).notNull(),
    inputFingerprintSha256: varchar('input_fingerprint_sha256', { length: 64 }).notNull(),
    privateInput: jsonb('private_input').$type<JsonObject>().notNull(),
    jobId: uuid('job_id').notNull(),
    status: financialAdminCommandStatus('status').default('pending').notNull(),
    safeResultCode: varchar('safe_result_code', { length: 100 }),
    safeResult: jsonb('safe_result').$type<JsonObject>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true })
  },
  (table) => [
    uniqueIndex('financial_admin_commands_actor_idempotency_unique').on(
      table.actorUserId,
      table.idempotencyKeySha256
    ),
    uniqueIndex('financial_admin_commands_job_unique').on(table.jobId),
    index('financial_admin_commands_status_created_idx').on(
      table.status,
      table.createdAt,
      table.id
    ),
    check(
      'financial_admin_commands_correlation_canonical',
      sql`(${table.correlationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$') is true`
    ),
    check(
      'financial_admin_commands_hashes_sha256',
      sql`(${table.idempotencyKeySha256} ~ '^[a-f0-9]{64}$' and ${table.inputFingerprintSha256} ~ '^[a-f0-9]{64}$') is true`
    ),
    check(
      'financial_admin_commands_input_bounded_object',
      sql`(pg_catalog.jsonb_typeof(${table.privateInput}) = 'object' and pg_catalog.pg_column_size(${table.privateInput}) <= 8192) is true`
    ),
    check(
      'financial_admin_commands_input_kind_consistent',
      commandInputIsKindConsistent(table.kind, table.privateInput)
    ),
    check(
      'financial_admin_commands_result_bounded_object',
      sql`(${table.safeResult} is null or (pg_catalog.jsonb_typeof(${table.safeResult}) = 'object' and pg_catalog.pg_column_size(${table.safeResult}) <= 4096)) is true`
    ),
    check(
      'financial_admin_commands_lifecycle_consistent',
      sql`(
        pg_catalog.isfinite(${table.createdAt})
        and pg_catalog.isfinite(${table.updatedAt})
        and ${table.updatedAt} >= ${table.createdAt}
        and (${table.completedAt} is null or (
          pg_catalog.isfinite(${table.completedAt})
          and ${table.completedAt} >= ${table.updatedAt}
        ))
        and ((
        ${table.status} = 'pending'
        and ${table.safeResultCode} is null
        and ${table.safeResult} is null
        and ${table.completedAt} is null
      ) or (
        ${table.status} = 'succeeded'
        and ${table.completedAt} is not null
        and ${table.safeResult} is not null
        and case when pg_catalog.jsonb_typeof(${table.safeResult}) = 'object' then (
          (${table.kind} = 'refund_draft_save' and
            ${table.safeResultCode} = 'draft_saved' and
            ${table.safeResult} ?& array['refundId', 'draftVersion', 'changed']::text[] and
            ${table.safeResult} - 'refundId' - 'draftVersion' - 'changed' = '{}'::jsonb and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'refundId') = 'string' and
            case when pg_catalog.pg_input_is_valid(${table.safeResult} ->> 'refundId', 'uuid')
              then (${table.safeResult} ->> 'refundId')::uuid::text = ${table.safeResult} ->> 'refundId'
              else false end and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'draftVersion') = 'number' and
            case when pg_catalog.pg_input_is_valid(${table.safeResult} ->> 'draftVersion', 'integer')
              then (${table.safeResult} ->> 'draftVersion')::integer between 1 and 2147483647
              else false end and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'changed') = 'boolean')
          or (${table.kind} = 'refund_draft_discard' and
            ${table.safeResultCode} = 'draft_discarded' and
            ${table.safeResult} ?& array['refundId', 'draftVersion', 'changed']::text[] and
            ${table.safeResult} - 'refundId' - 'draftVersion' - 'changed' = '{}'::jsonb and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'refundId') = 'string' and
            case when pg_catalog.pg_input_is_valid(${table.safeResult} ->> 'refundId', 'uuid')
              then (${table.safeResult} ->> 'refundId')::uuid::text = ${table.safeResult} ->> 'refundId'
              else false end and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'draftVersion') = 'number' and
            case when pg_catalog.pg_input_is_valid(${table.safeResult} ->> 'draftVersion', 'integer')
              then (${table.safeResult} ->> 'draftVersion')::integer between 1 and 2147483647
              else false end and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'changed') = 'boolean')
          or (${table.kind} = 'refund_allocation_finalize' and
            ${table.safeResultCode} = 'allocation_finalized' and
            ${table.safeResult} ?& array['refundId', 'finalizedDraftVersion', 'accessChanged', 'emailQueued']::text[] and
            ${table.safeResult} - 'refundId' - 'finalizedDraftVersion' -
              'accessChanged' - 'emailQueued' = '{}'::jsonb and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'refundId') = 'string' and
            case when pg_catalog.pg_input_is_valid(${table.safeResult} ->> 'refundId', 'uuid')
              then (${table.safeResult} ->> 'refundId')::uuid::text = ${table.safeResult} ->> 'refundId'
              else false end and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'finalizedDraftVersion') = 'number' and
            case when pg_catalog.pg_input_is_valid(${table.safeResult} ->> 'finalizedDraftVersion', 'integer')
              then (${table.safeResult} ->> 'finalizedDraftVersion')::integer between 1 and 2147483647
              else false end and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'accessChanged') = 'boolean' and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'emailQueued') = 'boolean')
          or (${table.kind} = 'refund_reporting_correction_create' and
            ${table.safeResultCode} = 'correction_created' and
            ${table.safeResult} ?& array['refundId', 'correctionSetId', 'correctionVersion']::text[] and
            ${table.safeResult} - 'refundId' - 'correctionSetId' -
              'correctionVersion' = '{}'::jsonb and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'refundId') = 'string' and
            case when pg_catalog.pg_input_is_valid(${table.safeResult} ->> 'refundId', 'uuid')
              then (${table.safeResult} ->> 'refundId')::uuid::text = ${table.safeResult} ->> 'refundId'
              else false end and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'correctionSetId') = 'string' and
            case when pg_catalog.pg_input_is_valid(${table.safeResult} ->> 'correctionSetId', 'uuid')
              then (${table.safeResult} ->> 'correctionSetId')::uuid::text =
                ${table.safeResult} ->> 'correctionSetId'
              else false end and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'correctionVersion') = 'number' and
            case when pg_catalog.pg_input_is_valid(${table.safeResult} ->> 'correctionVersion', 'integer')
              then (${table.safeResult} ->> 'correctionVersion')::integer between 1 and 2147483647
              else false end)
          or (${table.kind} = 'administrative_recovery_activate' and
            ${table.safeResultCode} = 'recovery_activated' and
            ${table.safeResult} ?& array['recoveryGrantId', 'accessChanged', 'emailQueued']::text[] and
            ${table.safeResult} - 'recoveryGrantId' - 'accessChanged' -
              'emailQueued' = '{}'::jsonb and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'recoveryGrantId') = 'string' and
            case when pg_catalog.pg_input_is_valid(${table.safeResult} ->> 'recoveryGrantId', 'uuid')
              then (${table.safeResult} ->> 'recoveryGrantId')::uuid::text =
                ${table.safeResult} ->> 'recoveryGrantId'
              else false end and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'accessChanged') = 'boolean' and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'emailQueued') = 'boolean')
          or (${table.kind} = 'administrative_recovery_deactivate' and
            ${table.safeResultCode} = 'recovery_deactivated' and
            ${table.safeResult} ?& array['recoveryGrantId', 'accessChanged', 'emailQueued']::text[] and
            ${table.safeResult} - 'recoveryGrantId' - 'accessChanged' -
              'emailQueued' = '{}'::jsonb and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'recoveryGrantId') = 'string' and
            case when pg_catalog.pg_input_is_valid(${table.safeResult} ->> 'recoveryGrantId', 'uuid')
              then (${table.safeResult} ->> 'recoveryGrantId')::uuid::text =
                ${table.safeResult} ->> 'recoveryGrantId'
              else false end and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'accessChanged') = 'boolean' and
            pg_catalog.jsonb_typeof(${table.safeResult} -> 'emailQueued') = 'boolean')
        ) else false end
      ) or (
        ${table.status} = 'denied'
        and ${table.safeResultCode} = 'capability_revoked'
        and ${table.safeResult} is null
        and ${table.completedAt} is not null
      ) or (
        ${table.status} = 'conflict'
        and ${table.safeResultCode} in ('stale_state', 'not_eligible')
        and ${table.safeResult} is null
        and ${table.completedAt} is not null
      ) or (
        ${table.status} = 'failed'
        and ${table.safeResultCode} in ('invalid_command', 'command_failed')
        and ${table.safeResult} is null
        and ${table.completedAt} is not null
      )
      )) is true`
    )
  ]
);

export type FinancialAdminCommandRow = typeof financialAdminCommands.$inferSelect;
export type NewFinancialAdminCommandRow = typeof financialAdminCommands.$inferInsert;

export const financialAdminJobClaims = pgTable(
  'financial_admin_job_claims',
  {
    jobId: uuid('job_id').primaryKey().references(() => jobs.id, {
      onUpdate: 'restrict',
      onDelete: 'restrict'
    }),
    generation: integer('generation').notNull(),
    attempt: integer('attempt').notNull(),
    capabilitySha256: text('capability_sha256').notNull(),
    leaseDurationMs: integer('lease_duration_ms').notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    renewedAt: timestamp('renewed_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true })
  },
  (table) => [
    check(
      'financial_admin_job_claims_generation_positive',
      sql`(${table.generation} between 1 and 2147483647) is true`
    ),
    check(
      'financial_admin_job_claims_attempt_positive',
      sql`(${table.attempt} between 1 and 2147483647) is true`
    ),
    check(
      'financial_admin_job_claims_capability_sha256_valid',
      sql`(${table.capabilitySha256} ~ '^[a-f0-9]{64}$') is true`
    ),
    check(
      'financial_admin_job_claims_lease_duration_bounded',
      sql`(${table.leaseDurationMs} between 1 and 86400000) is true`
    ),
    check(
      'financial_admin_job_claims_lifecycle_consistent',
      sql`((
        ${table.state} = 'active'
        and ${table.invalidatedAt} is null
        and (${table.renewedAt} is null or ${table.renewedAt} >= ${table.issuedAt})
        and ${table.expiresAt} > pg_catalog.coalesce(${table.renewedAt}, ${table.issuedAt})
      ) or (
        ${table.state} = 'invalidated'
        and ${table.invalidatedAt} is not null
        and (${table.renewedAt} is null or ${table.renewedAt} >= ${table.issuedAt})
        and ${table.invalidatedAt} >= pg_catalog.coalesce(${table.renewedAt}, ${table.issuedAt})
      )) is true`
    )
  ]
);

export type FinancialAdminJobClaimRow = typeof financialAdminJobClaims.$inferSelect;
export type NewFinancialAdminJobClaimRow = typeof financialAdminJobClaims.$inferInsert;
