import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import { prepareJobRetryCommand } from '$lib/server/operations/jobs/contracts';
import {
  JOB_DEFINITIONS,
  JOB_RETRY_COMMAND_RESULT_CODES,
  JOB_RETRY_POLICY_OUTCOMES,
  type JobRetryCommandResultCode
} from '$lib/server/jobs/catalog';
import {
  databaseClient,
  ownerDatabaseClient,
  storageCleanupDatabaseClient,
  workerDatabaseClient
} from './database';

const AUTHORITY_ERROR = {
  code: '55000',
  message: 'Plan 7A operations job authority is not current'
} as const;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{6}Z$/u;

const PUBLIC_OPERATIONS_ROUTINES = Object.freeze([
  {
    signature: 'list_operational_jobs(uuid,text,text,timestamp with time zone,uuid,integer)',
    call: 'select * from public.list_operational_jobs(null,null,null,null,null,null)',
    sessionError: 'job operations listing is not permitted'
  },
  {
    signature: 'submit_job_retry_command(uuid,uuid,text,integer,integer,timestamp with time zone,text,text,text,text)',
    call: 'select * from public.submit_job_retry_command(null,null,null,null,null,null,null,null,null,null)',
    sessionError: 'job retry command submission is not permitted'
  },
  {
    signature: 'get_owned_job_retry_command(uuid,uuid)',
    call: 'select * from public.get_owned_job_retry_command(null,null)',
    sessionError: 'job retry command status is not permitted'
  }
] as const);

const WORKER_OPERATIONS_ROUTINES = Object.freeze([
  {
    signature: 'plan7a_operations_claim_job(uuid,text,integer)',
    call: 'select * from public.plan7a_operations_claim_job(null,null,null)'
  },
  {
    signature: 'plan7a_operations_renew_job_claim(uuid,text,integer,integer)',
    call: 'select * from public.plan7a_operations_renew_job_claim(null,null,null,null)'
  },
  {
    signature: 'plan7a_operations_relinquish_job(uuid,text,integer,integer,text,integer)',
    call: 'select * from public.plan7a_operations_relinquish_job(null,null,null,null,null,null)'
  },
  {
    signature: 'plan7a_operations_complete_job(uuid,text,integer,integer)',
    call: 'select * from public.plan7a_operations_complete_job(null,null,null,null)'
  },
  {
    signature: 'plan7a_operations_fail_job(uuid,text,integer,integer,text)',
    call: 'select * from public.plan7a_operations_fail_job(null,null,null,null,null)'
  },
  {
    signature: 'plan7a_operations_exhaust_job(uuid,text,integer,integer)',
    call: 'select * from public.plan7a_operations_exhaust_job(null,null,null,null)'
  },
  {
    signature: 'plan7a_operations_lock_job_retry_command(uuid,uuid,text,integer,integer)',
    call: 'select * from public.plan7a_operations_lock_job_retry_command(null,null,null,null,null)'
  },
  {
    signature: 'plan7a_operations_transition_job_retry_command(uuid,uuid,text,integer,integer,operations_job_retry_result_code)',
    call: 'select * from public.plan7a_operations_transition_job_retry_command(null,null,null,null,null,null)'
  }
] as const);

const OWNER_ONLY_OPERATIONS_ROUTINES = Object.freeze([
  'plan7a_operations_job_catalog()',
  'plan7a_operations_safe_failure_code(text,text)',
  'plan7a_operations_assert_job_capability(uuid,uuid,text,integer,integer)',
  'plan7a_operations_guard_command_delete()',
  'plan7a_operations_guard_command_update()',
  'plan7a_operations_guard_job_transition()',
  'plan6b_guard_audit_insert()',
  'plan6b_guard_job_insert()'
] as const);

interface RetryFixture {
  readonly actorId: string;
  readonly commandId: string;
  readonly internalJobId: string;
  readonly targetJobId: string;
  readonly targetUpdatedAt: string;
  readonly idempotencyHash: string;
  readonly fingerprint: string;
}

interface ClaimResult extends QueryResultRow {
  readonly job_id: string;
  readonly job_kind: string;
  readonly payload: { readonly commandId: string };
  readonly deduplication_key: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly lease_owner: string;
  readonly lease_generation: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function capability(): string {
  return randomBytes(32).toString('base64url');
}

function databaseError(error: unknown): { code?: string; message?: string } {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== 'object') break;
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof record.code === 'string') {
      return typeof record.message === 'string'
        ? { code: record.code, message: record.message }
        : { code: record.code };
    }
    current = record.cause;
  }
  return {};
}

async function expectDatabaseError(
  operation: Promise<unknown>,
  expected: { readonly code: string; readonly message: string }
): Promise<void> {
  try {
    await operation;
    throw new Error('Expected database operation to fail');
  } catch (error) {
    expect(databaseError(error)).toEqual(expected);
  }
}

async function expectDatabaseCode(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation;
    throw new Error('Expected database operation to fail');
  } catch (error) {
    expect(databaseError(error).code).toBe(code);
  }
}

async function createActor(role: 'admin' | 'customer' = 'admin'): Promise<string> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Plan 7A authority actor', $2, true)`,
    [id, `plan7a-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    'insert into user_roles (user_id, role) values ($1, $2)',
    [id, role]
  );
  return id;
}

async function createFailedTarget(
  kind = 'outbox.dispatch',
  attempts = 1,
  maxAttempts = 8,
  updatedAt = '2026-08-26T12:34:56.123456Z'
): Promise<{ readonly id: string; readonly updatedAt: string }> {
  const id = randomUUID();
  const result = await ownerDatabaseClient.pool.query<{ updated_at: string }>(
    `insert into jobs (
       id, type, payload, status, run_at, attempts, max_attempts, last_error,
       completed_at, created_at, updated_at
     ) values (
       $1, $2, '{}'::jsonb, 'failed', $3::timestamptz, $4, $5,
       'Outbox message does not exist', $3::timestamptz,
       $3::timestamptz - interval '1 second', $3::timestamptz
     )
     returning to_char(timezone('UTC', updated_at),
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`,
    [id, kind, updatedAt, attempts, maxAttempts]
  );
  return { id, updatedAt: result.rows[0]!.updated_at };
}

function preparedInput(
  target: { readonly id: string; readonly updatedAt: string },
  idempotencyKey = randomUUID(),
  reasonCode = 'dependency_recovered' as const
) {
  return prepareJobRetryCommand({
    idempotencyKey,
    targetJobId: target.id,
    expectedKind: 'outbox.dispatch',
    expectedStatus: 'failed',
    expectedAttempts: 1,
    expectedMaxAttempts: 8,
    expectedUpdatedAt: target.updatedAt,
    reasonCode
  });
}

async function submit(
  actorId: string,
  target: { readonly id: string; readonly updatedAt: string },
  idempotencyKey = randomUUID(),
  correlationId = `plan7a-submit-${randomUUID()}`,
  fingerprintOverride?: string
) {
  const prepared = preparedInput(target, idempotencyKey);
  const result = await databaseClient.pool.query<{
    command_id: string;
    kind: string;
    target_job_id: string;
    target_kind: string;
    reason_code: string;
    correlation_id: string;
    status: string;
    result_code: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }>(
    `select * from public.submit_job_retry_command(
       $1::uuid, $2::uuid, $3::text, $4::integer, $5::integer,
       $6::timestamptz, $7::text, $8::text, $9::text, $10::text
     )`,
    [
      actorId,
      target.id,
      'outbox.dispatch',
      1,
      8,
      target.updatedAt,
      'dependency_recovered',
      correlationId,
      prepared.idempotencyKeySha256,
      fingerprintOverride ?? prepared.inputFingerprintSha256
    ]
  );
  return { row: result.rows[0]!, prepared };
}

async function createRetryFixture(): Promise<RetryFixture> {
  const actorId = await createActor();
  const target = await createFailedTarget();
  const submitted = await submit(actorId, target);
  const internalJob = await ownerDatabaseClient.pool.query<{ id: string }>(
    `select id from jobs
     where type = 'operations.job-retry-command'
       and payload = jsonb_build_object('commandId', $1::uuid)`,
    [submitted.row.command_id]
  );
  return {
    actorId,
    commandId: submitted.row.command_id,
    internalJobId: internalJob.rows[0]!.id,
    targetJobId: target.id,
    targetUpdatedAt: target.updatedAt,
    idempotencyHash: submitted.prepared.idempotencyKeySha256,
    fingerprint: submitted.prepared.inputFingerprintSha256
  };
}

async function createRetryFixtureForKind(
  kind: string,
  maxAttempts: number
): Promise<RetryFixture> {
  const actorId = await createActor();
  const target = await createFailedTarget(kind, 1, maxAttempts);
  const prepared = prepareJobRetryCommand({
    idempotencyKey: randomUUID(),
    targetJobId: target.id,
    expectedKind: kind,
    expectedStatus: 'failed',
    expectedAttempts: 1,
    expectedMaxAttempts: maxAttempts,
    expectedUpdatedAt: target.updatedAt,
    reasonCode: 'dependency_recovered'
  });
  const submitted = await databaseClient.pool.query<{ command_id: string }>(
    `select * from public.submit_job_retry_command(
       $1::uuid, $2::uuid, $3::text, $4::integer, $5::integer,
       $6::timestamptz, $7::text, $8::text, $9::text, $10::text
     )`,
    [
      actorId, target.id, kind, 1, maxAttempts, target.updatedAt,
      'dependency_recovered', `plan7a-${randomUUID()}`,
      prepared.idempotencyKeySha256, prepared.inputFingerprintSha256
    ]
  );
  const commandId = submitted.rows[0]!.command_id;
  const internalJob = await ownerDatabaseClient.pool.query<{ id: string }>(
    `select id from jobs
     where type = 'operations.job-retry-command'
       and payload = jsonb_build_object('commandId', $1::uuid)`,
    [commandId]
  );
  return {
    actorId,
    commandId,
    internalJobId: internalJob.rows[0]!.id,
    targetJobId: target.id,
    targetUpdatedAt: target.updatedAt,
    idempotencyHash: prepared.idempotencyKeySha256,
    fingerprint: prepared.inputFingerprintSha256
  };
}

async function waitUntilJobDue(jobId: string): Promise<void> {
  for (let poll = 0; poll < 200; poll += 1) {
    const due = await ownerDatabaseClient.pool.query<{ due: boolean }>(
      'select run_at <= clock_timestamp() as due from jobs where id = $1',
      [jobId]
    );
    if (due.rows[0]?.due) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${jobId} did not become due`);
}

async function advanceToFinalClaim(
  fixture: RetryFixture,
  finalDuration = 250
): Promise<{ readonly capability: string; readonly generation: number }> {
  let currentCapability = capability();
  let generation = 1;
  let owner = 'operations-ceiling-worker-1';
  expect(await claim(fixture, currentCapability, owner, 60_000)).toMatchObject([{
    attempt: 1,
    lease_generation: 1
  }]);
  for (let attempt = 1; attempt < 8; attempt += 1) {
    expect(await workerCall<{ applied: boolean }>(
      currentCapability,
      `select * from public.plan7a_operations_relinquish_job(
        $1, $2, $3, $4, 'Transient job handler failure', 1
      )`,
      [fixture.internalJobId, owner, attempt, generation]
    )).toEqual([{ applied: true }]);
    await waitUntilJobDue(fixture.internalJobId);
    currentCapability = capability();
    generation += 1;
    owner = `operations-ceiling-worker-${generation}`;
    const duration = attempt === 7 ? finalDuration : 60_000;
    expect(await claim(fixture, currentCapability, owner, duration)).toMatchObject([{
      attempt: attempt + 1,
      lease_generation: generation
    }]);
  }
  return { capability: currentCapability, generation };
}

async function workerCall<Row extends QueryResultRow>(
  clearCapability: string,
  text: string,
  parameters: readonly unknown[]
): Promise<readonly Row[]> {
  const connection = await workerDatabaseClient.pool.connect();
  try {
    await connection.query('begin');
    await connection.query(
      `select set_config(
        'pale_orbit.plan7a_operations_job_capability', $1, true
      )`,
      [clearCapability]
    );
    const result = await connection.query<Row>(text, [...parameters]);
    await connection.query('commit');
    return result.rows;
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

async function claim(
  fixture: RetryFixture,
  clearCapability: string,
  leaseOwner = 'operations-worker-a',
  duration = 60_000
): Promise<readonly ClaimResult[]> {
  return workerCall<ClaimResult>(
    clearCapability,
    `select * from public.plan7a_operations_claim_job(
       $1::uuid, $2::text, $3::integer
     )`,
    [fixture.internalJobId, leaseOwner, duration]
  );
}

describe('Plan 7A operations authority catalogs', () => {
  it('installs the exact enums, storage catalogs, routines, triggers, and settings', async () => {
    const enums = await ownerDatabaseClient.pool.query<{
      enum_name: string;
      labels: string[];
    }>(`
      select enum_type.typname as enum_name,
        array_agg(enum_value.enumlabel order by enum_value.enumsortorder)::text[] as labels
      from pg_catalog.pg_type enum_type
      join pg_catalog.pg_namespace namespace on namespace.oid = enum_type.typnamespace
      join pg_catalog.pg_enum enum_value on enum_value.enumtypid = enum_type.oid
      where namespace.nspname = 'public'
        and enum_type.typname like 'operations_job_retry_%'
      group by enum_type.typname
      order by enum_type.typname
    `);
    expect(enums.rows).toEqual([
      { enum_name: 'operations_job_retry_claim_state', labels: ['active', 'invalidated'] },
      {
        enum_name: 'operations_job_retry_command_status',
        labels: ['pending', 'succeeded', 'denied', 'failed']
      },
      {
        enum_name: 'operations_job_retry_reason_code',
        labels: ['dependency_recovered', 'configuration_recovered', 'operator_reassessment']
      },
      {
        enum_name: 'operations_job_retry_result_code',
        labels: [
          'rearmed_existing', 'successor_enqueued', 'already_current',
          'retry_not_supported', 'retry_policy_not_enabled',
          'provider_recovery_not_enabled', 'target_not_failed', 'target_state_changed',
          'domain_state_not_retryable', 'source_unavailable', 'actor_not_authorized',
          'retry_command_invalid', 'retry_command_exhausted', 'unexpected_failure'
        ]
      }
    ]);

    const columns = await ownerDatabaseClient.pool.query<{
      table_name: string;
      columns: string[];
    }>(`
      select table_name, array_agg(column_name order by ordinal_position)::text[] as columns
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('operations_job_retry_commands', 'operations_job_retry_claims')
      group by table_name
      order by table_name
    `);
    expect(columns.rows).toEqual([
      {
        table_name: 'operations_job_retry_claims',
        columns: [
          'job_id', 'command_id', 'generation', 'attempt', 'lease_owner',
          'capability_sha256', 'lease_duration_ms', 'state', 'expires_at',
          'issued_at', 'renewed_at', 'invalidated_at'
        ]
      },
      {
        table_name: 'operations_job_retry_commands',
        columns: [
          'id', 'kind', 'actor_user_id', 'target_job_id', 'target_job_kind',
          'expected_status', 'expected_attempts', 'expected_max_attempts',
          'expected_updated_at', 'reason_code', 'correlation_id',
          'idempotency_key_sha256', 'input_fingerprint_sha256', 'status',
          'safe_result_code', 'created_at', 'updated_at', 'completed_at'
        ]
      }
    ]);

    const columnCatalog = await ownerDatabaseClient.pool.query<{
      descriptor: string;
    }>(`
      select relation_row.relname || ':' || attribute_row.attnum::text || ':' ||
        attribute_row.attname || ':' ||
        pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod) || ':' ||
        attribute_row.attnotnull::text || ':' || attribute_row.attidentity::text || ':' ||
        attribute_row.attgenerated::text || ':' || coalesce(
          pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), ''
        ) as descriptor
      from pg_catalog.pg_attribute attribute_row
      join pg_catalog.pg_class relation_row on relation_row.oid = attribute_row.attrelid
      join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation_row.relnamespace
      left join pg_catalog.pg_attrdef default_row
        on default_row.adrelid = attribute_row.attrelid
       and default_row.adnum = attribute_row.attnum
      where namespace_row.nspname = 'public'
        and relation_row.relname in (
          'operations_job_retry_commands', 'operations_job_retry_claims'
        ) and attribute_row.attnum > 0 and not attribute_row.attisdropped
      order by relation_row.relname, attribute_row.attnum
    `);
    expect(columnCatalog.rows.map((row) => row.descriptor)).toEqual([
      'operations_job_retry_claims:1:job_id:uuid:true:::',
      'operations_job_retry_claims:2:command_id:uuid:true:::',
      'operations_job_retry_claims:3:generation:integer:true:::',
      'operations_job_retry_claims:4:attempt:integer:true:::',
      'operations_job_retry_claims:5:lease_owner:character varying(200):true:::',
      'operations_job_retry_claims:6:capability_sha256:character varying(64):true:::',
      'operations_job_retry_claims:7:lease_duration_ms:integer:true:::',
      'operations_job_retry_claims:8:state:operations_job_retry_claim_state:true:::',
      'operations_job_retry_claims:9:expires_at:timestamp with time zone:true:::',
      'operations_job_retry_claims:10:issued_at:timestamp with time zone:true:::',
      'operations_job_retry_claims:11:renewed_at:timestamp with time zone:false:::',
      'operations_job_retry_claims:12:invalidated_at:timestamp with time zone:false:::',
      'operations_job_retry_commands:1:id:uuid:true:::gen_random_uuid()',
      "operations_job_retry_commands:2:kind:character varying(32):true:::'retry_failed_job'::character varying",
      'operations_job_retry_commands:3:actor_user_id:uuid:true:::',
      'operations_job_retry_commands:4:target_job_id:uuid:true:::',
      'operations_job_retry_commands:5:target_job_kind:character varying(100):true:::',
      'operations_job_retry_commands:6:expected_status:character varying(16):true:::',
      'operations_job_retry_commands:7:expected_attempts:integer:true:::',
      'operations_job_retry_commands:8:expected_max_attempts:integer:true:::',
      'operations_job_retry_commands:9:expected_updated_at:timestamp with time zone:true:::',
      'operations_job_retry_commands:10:reason_code:operations_job_retry_reason_code:true:::',
      'operations_job_retry_commands:11:correlation_id:character varying(100):true:::',
      'operations_job_retry_commands:12:idempotency_key_sha256:character varying(64):true:::',
      'operations_job_retry_commands:13:input_fingerprint_sha256:character varying(64):true:::',
      "operations_job_retry_commands:14:status:operations_job_retry_command_status:true:::'pending'::operations_job_retry_command_status",
      'operations_job_retry_commands:15:safe_result_code:operations_job_retry_result_code:false:::',
      'operations_job_retry_commands:16:created_at:timestamp with time zone:true:::now()',
      'operations_job_retry_commands:17:updated_at:timestamp with time zone:true:::now()',
      'operations_job_retry_commands:18:completed_at:timestamp with time zone:false:::'
    ]);

    const storageCatalog = await ownerDatabaseClient.pool.query<{
      descriptor: string;
    }>(`
      select descriptor from (
        select 'constraint:' || constraint_row.conname || ':' ||
          constraint_row.contype::text || ':' ||
          pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as descriptor
        from pg_catalog.pg_constraint constraint_row
        where constraint_row.conrelid in (
          'public.operations_job_retry_commands'::regclass,
          'public.operations_job_retry_claims'::regclass
        )
        union all
        select 'index:' || index_relation.relname || ':' ||
          pg_catalog.pg_get_indexdef(index_relation.oid) || ':' ||
          index_row.indisvalid::text || ':' || index_row.indisready::text || ':' ||
          index_row.indislive::text
        from pg_catalog.pg_index index_row
        join pg_catalog.pg_class index_relation on index_relation.oid = index_row.indexrelid
        where index_row.indrelid in (
          'public.operations_job_retry_commands'::regclass,
          'public.operations_job_retry_claims'::regclass
        )
      ) descriptor_inventory
      order by descriptor
    `);
    expect.soft({
      columns: digest(columnCatalog.rows.map((row) => row.descriptor).join('\n')),
      storage: digest(storageCatalog.rows.map((row) => row.descriptor).join('\n'))
    }).toEqual({
      columns: 'aa4fd99999e5f8a5333d3221857d599ae790ce7c0b354314f163a57514380aad',
      storage: 'e67e8cc1fb05696ff5ae64712256171d983ccd3978e4d974b9ece9cd72e25a70'
    });

    const descriptors = await ownerDatabaseClient.pool.query<{
      names: string[];
    }>(`
      select array_agg(name order by name)::text[] as names
      from (
        select constraint_name as name
        from information_schema.table_constraints
        where table_schema = 'public'
          and table_name in ('operations_job_retry_commands', 'operations_job_retry_claims')
        union
        select indexname
        from pg_catalog.pg_indexes
        where schemaname = 'public'
          and tablename in ('operations_job_retry_commands', 'operations_job_retry_claims')
        union
        select tgname
        from pg_catalog.pg_trigger
        where tgrelid in (
          'public.operations_job_retry_commands'::regclass,
          'public.operations_job_retry_claims'::regclass,
          'public.jobs'::regclass
        ) and not tgisinternal and tgname like 'plan7a_operations_%'
      ) descriptor(name)
    `);
    expect(descriptors.rows[0]!.names).toEqual([
      'operations_job_retry_claims_attempt_not_null',
      'operations_job_retry_claims_capability_sha256_not_null',
      'operations_job_retry_claims_command_id_not_null',
      'operations_job_retry_claims_expires_at_not_null',
      'operations_job_retry_claims_generation_not_null',
      'operations_job_retry_claims_issued_at_not_null',
      'operations_job_retry_claims_job_id_not_null',
      'operations_job_retry_claims_lease_duration_ms_not_null',
      'operations_job_retry_claims_lease_owner_not_null',
      'operations_job_retry_claims_state_not_null',
      'operations_job_retry_commands_actor_user_id_not_null',
      'operations_job_retry_commands_correlation_id_not_null',
      'operations_job_retry_commands_created_at_not_null',
      'operations_job_retry_commands_expected_attempts_not_null',
      'operations_job_retry_commands_expected_max_attempts_not_null',
      'operations_job_retry_commands_expected_status_not_null',
      'operations_job_retry_commands_expected_updated_at_not_null',
      'operations_job_retry_commands_id_not_null',
      'operations_job_retry_commands_idempotency_key_sha256_not_null',
      'operations_job_retry_commands_input_fingerprint_sha256_not_null',
      'operations_job_retry_commands_kind_not_null',
      'operations_job_retry_commands_reason_code_not_null',
      'operations_job_retry_commands_status_not_null',
      'operations_job_retry_commands_target_job_id_not_null',
      'operations_job_retry_commands_target_job_kind_not_null',
      'operations_job_retry_commands_updated_at_not_null',
      'plan7a_operations_jobs_transition_guard',
      'plan7a_operations_retry_claims_attempt_positive',
      'plan7a_operations_retry_claims_capability_sha256',
      'plan7a_operations_retry_claims_command_fk',
      'plan7a_operations_retry_claims_command_unique',
      'plan7a_operations_retry_claims_generation_positive',
      'plan7a_operations_retry_claims_job_fk',
      'plan7a_operations_retry_claims_lease_duration_bounded',
      'plan7a_operations_retry_claims_lease_owner_canonical',
      'plan7a_operations_retry_claims_lifecycle_consistent',
      'plan7a_operations_retry_claims_pkey',
      'plan7a_operations_retry_commands_actor_fk',
      'plan7a_operations_retry_commands_actor_idempotency_unique',
      'plan7a_operations_retry_commands_correlation_canonical',
      'plan7a_operations_retry_commands_delete_guard',
      'plan7a_operations_retry_commands_expected_state_consistent',
      'plan7a_operations_retry_commands_hashes_sha256',
      'plan7a_operations_retry_commands_kind_fixed',
      'plan7a_operations_retry_commands_lifecycle_consistent',
      'plan7a_operations_retry_commands_pkey',
      'plan7a_operations_retry_commands_status_created_idx',
      'plan7a_operations_retry_commands_target_created_idx',
      'plan7a_operations_retry_commands_target_job_fk',
      'plan7a_operations_retry_commands_target_kind_registered',
      'plan7a_operations_retry_commands_update_guard'
    ]);

    const routines = await ownerDatabaseClient.pool.query<{
      signature: string;
      result: string;
      security_definer: boolean;
      configuration: string[];
      definition_sha256: string;
    }>(`
      select routine.oid::regprocedure::text as signature,
        pg_catalog.pg_get_function_result(routine.oid) as result,
        routine.prosecdef as security_definer,
        coalesce(routine.proconfig, '{}'::text[]) as configuration,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.replace(pg_catalog.replace(
            pg_catalog.pg_get_functiondef(routine.oid), E'\\r\\n', E'\\n'
          ), E'\\r', E'\\n'), 'UTF8'
        )), 'hex') as definition_sha256
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'public' and (
        routine.proname in (
          'list_operational_jobs', 'submit_job_retry_command',
          'get_owned_job_retry_command', 'plan7a_operations_job_catalog',
          'plan7a_operations_safe_failure_code'
        ) or routine.proname like 'plan7a_operations_%'
      )
      order by signature
    `);
    expect(routines.rows).toHaveLength(17);
    expect(routines.rows.every((row) =>
      row.configuration.includes('search_path=pg_catalog'))).toBe(true);
    expect(routines.rows.filter((row) => !row.security_definer).map((row) => row.signature))
      .toEqual([
        'plan7a_operations_guard_command_delete()',
        'plan7a_operations_guard_command_update()',
        'plan7a_operations_guard_job_transition()'
      ]);
    expect(routines.rows.map((row) => ({
      signature: row.signature,
      result: row.result,
      security_definer: row.security_definer,
      definition_sha256: row.definition_sha256
    }))).toEqual([
      {
        signature: 'get_owned_job_retry_command(uuid,uuid)',
        result: 'TABLE(command_id uuid, kind text, target_job_id uuid, target_kind text, reason_code text, correlation_id text, status text, result_code text, created_at text, updated_at text, completed_at text)',
        security_definer: true,
        definition_sha256: '022292c2665a28aea7d0780994983898678e1df3c26386be5c7979fb8b941785'
      },
      {
        signature: 'list_operational_jobs(uuid,text,text,timestamp with time zone,uuid,integer)',
        result: 'TABLE(job_id uuid, kind text, label text, status text, attempts integer, max_attempts integer, run_at text, completed_at text, created_at text, updated_at text, retry_disposition text, policy_availability text, safe_failure_code text)',
        security_definer: true,
        definition_sha256: '84290e11fcdb1cda15644938914d601f0bc62d54ad5372d3fbf448ef0e99af85'
      },
      {
        signature: 'plan7a_operations_assert_job_capability(uuid,uuid,text,integer,integer)',
        result: 'void', security_definer: true,
        definition_sha256: '25e29a8b14f53b95dde03d064301c22e6b652db7276fa4a25e74aba74311975d'
      },
      {
        signature: 'plan7a_operations_claim_job(uuid,text,integer)',
        result: 'TABLE(job_id uuid, job_kind text, payload jsonb, deduplication_key text, attempt integer, max_attempts integer, lease_owner text, lease_generation integer)',
        security_definer: true,
        definition_sha256: '29d094836b4ebf934a1e2c307706839f4a8d96c8e3b05551a7624e021f807885'
      },
      {
        signature: 'plan7a_operations_complete_job(uuid,text,integer,integer)',
        result: 'TABLE(applied boolean)', security_definer: true,
        definition_sha256: '97637d143fe11330d1780d552b966eb6474257e40043b5b463699ef6b39b6f0b'
      },
      {
        signature: 'plan7a_operations_exhaust_job(uuid,text,integer,integer)',
        result: 'TABLE(applied boolean)', security_definer: true,
        definition_sha256: '38aa875da3b0c67d44394e7c8b7781b57707d117b8f1aaddb03e3a25bb0371bf'
      },
      {
        signature: 'plan7a_operations_fail_job(uuid,text,integer,integer,text)',
        result: 'TABLE(applied boolean)', security_definer: true,
        definition_sha256: '8b9e7801266a8a6f94084d5f7fe171dd0ebb32f9a3ab30cda92bdadf8c14ea27'
      },
      {
        signature: 'plan7a_operations_guard_command_delete()',
        result: 'trigger', security_definer: false,
        definition_sha256: '51c644c3f62cba64bfc4b46f09cac247336edd86e4335c0b8289437fa5b97754'
      },
      {
        signature: 'plan7a_operations_guard_command_update()',
        result: 'trigger', security_definer: false,
        definition_sha256: '750cdbb29e154c9f2fbcd9f7fa56be76d792bb5f7e7b04486be5463f2b16e126'
      },
      {
        signature: 'plan7a_operations_guard_job_transition()',
        result: 'trigger', security_definer: false,
        definition_sha256: '1d398a6ae0a87c59c9f4ad797ca0311b3be258dda847ad361893808680c5815b'
      },
      {
        signature: 'plan7a_operations_job_catalog()',
        result: 'TABLE(kind text, label text, max_attempts integer, automatic_retry_owner text, retry_disposition text, policy_adapter text, policy_availability text, provider_verification_required boolean, provider_calls_in_plan7a boolean, administrator_retry_excluded boolean, safe_statuses text[], diagnostic_generation text, allowed_policy_outcomes text[])',
        security_definer: true,
        definition_sha256: '3c032448b9e0194e3c3537708987abb475ae7ee2f94272f96e7985406ade1eab'
      },
      {
        signature: 'plan7a_operations_lock_job_retry_command(uuid,uuid,text,integer,integer)',
        result: 'TABLE(command_id uuid, command_status text, result_code text, actor_authorized boolean, actor_user_id uuid, target_job_id uuid, target_job_kind text, expected_status text, expected_attempts integer, expected_max_attempts integer, expected_updated_at text, reason_code text, correlation_id text)',
        security_definer: true,
        definition_sha256: 'a46713251ed99b9fcfa03b027dfe001e35ffcaa272cc29e13b74efa25aa298da'
      },
      {
        signature: 'plan7a_operations_relinquish_job(uuid,text,integer,integer,text,integer)',
        result: 'TABLE(applied boolean)', security_definer: true,
        definition_sha256: '0ecedb56d53d9cdf03be6990b4f446e94058d9b82e778fd5d98ff1264d8379d8'
      },
      {
        signature: 'plan7a_operations_renew_job_claim(uuid,text,integer,integer)',
        result: 'TABLE(applied boolean)', security_definer: true,
        definition_sha256: '245f7b532dbef149f8ec1c9067242bc6740fab4e39575fdb2a1e34279a78672b'
      },
      {
        signature: 'plan7a_operations_safe_failure_code(text,text)',
        result: 'text', security_definer: true,
        definition_sha256: '534cc1821fd53eca619c90e4a49dd028fc93bf8aa32ffea502a33dc23712a1f5'
      },
      {
        signature: 'plan7a_operations_transition_job_retry_command(uuid,uuid,text,integer,integer,operations_job_retry_result_code)',
        result: 'TABLE(command_id uuid, command_status text, result_code text, completed_at text)',
        security_definer: true,
        definition_sha256: 'b7f6f0930645619d0f05b6f0087882850adca32e4e6beec496a80f70cb13732b'
      },
      {
        signature: 'submit_job_retry_command(uuid,uuid,text,integer,integer,timestamp with time zone,text,text,text,text)',
        result: 'TABLE(command_id uuid, kind text, target_job_id uuid, target_kind text, reason_code text, correlation_id text, status text, result_code text, created_at text, updated_at text, completed_at text)',
        security_definer: true,
        definition_sha256: '335d43be99e046133c2da4b2f204ef2806849a117cffdf13ee9ab31a9b4efe3d'
      }
    ]);

    const replacedGuards = await ownerDatabaseClient.pool.query<{
      signature: string;
      result: string;
      security_definer: boolean;
      configuration: string[];
      definition_sha256: string;
    }>(`
      select routine.oid::regprocedure::text as signature,
        pg_catalog.pg_get_function_result(routine.oid) as result,
        routine.prosecdef as security_definer,
        coalesce(routine.proconfig, '{}'::text[]) as configuration,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.replace(pg_catalog.replace(
            pg_catalog.pg_get_functiondef(routine.oid), E'\\r\\n', E'\\n'
          ), E'\\r', E'\\n'), 'UTF8'
        )), 'hex') as definition_sha256
      from pg_catalog.pg_proc routine
      where routine.oid in (
        'public.plan6b_guard_job_insert()'::regprocedure,
        'public.plan6b_guard_audit_insert()'::regprocedure
      )
      order by signature
    `);
    expect(replacedGuards.rows).toEqual([
      {
        signature: 'plan6b_guard_audit_insert()',
        result: 'trigger',
        security_definer: false,
        configuration: ['search_path=pg_catalog'],
        definition_sha256: 'e84ef5f2a1d00b495c9bd6c01b27461fa57f0c4d0ac462a4bbc8f1386cb6f2b5'
      },
      {
        signature: 'plan6b_guard_job_insert()',
        result: 'trigger',
        security_definer: true,
        configuration: ['search_path=pg_catalog'],
        definition_sha256: '3b4d7d5f65d013cea7fa3da0c23b0d3c495feaa022719ccbfd0b93e8a4804771'
      }
    ]);

    const settings = await ownerDatabaseClient.pool.query<{ settings: string[] }>(`
      select array_agg(distinct match[1] order by match[1])::text[] as settings
      from pg_catalog.pg_proc routine
      cross join lateral regexp_matches(
        routine.prosrc,
        '(pale_orbit[.]plan7a_operations_[a-z_]+)',
        'g'
      ) match
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'public'
    `);
    expect(settings.rows[0]!.settings).toEqual([
      'pale_orbit.plan7a_operations_command_insert_id',
      'pale_orbit.plan7a_operations_command_transition_id',
      'pale_orbit.plan7a_operations_job_capability',
      'pale_orbit.plan7a_operations_job_transition_id'
    ]);

    const predecessorAcl = await ownerDatabaseClient.pool.query<{ digest: string }>(`
      with authority as (
        select database_row.datdba as owner_oid
        from pg_catalog.pg_database database_row
        where database_row.datname = pg_catalog.current_database()
      ), acl_descriptor as (
        select 'database:' || privilege.privilege_type || ':' ||
          case privilege.grantee when 0 then '<public>'
            when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantee) end || ':' ||
          case privilege.grantor when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantor) end || ':' ||
          privilege.is_grantable::text as descriptor
        from authority
        join pg_catalog.pg_database database_row
          on database_row.datname = pg_catalog.current_database()
        cross join lateral pg_catalog.aclexplode(coalesce(
          database_row.datacl, pg_catalog.acldefault('d', database_row.datdba)
        )) privilege
        union all
        select 'schema:public:' || privilege.privilege_type || ':' ||
          case privilege.grantee when 0 then '<public>'
            when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantee) end || ':' ||
          case privilege.grantor when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantor) end || ':' ||
          privilege.is_grantable::text
        from authority
        join pg_catalog.pg_namespace namespace_row on namespace_row.nspname = 'public'
        cross join lateral pg_catalog.aclexplode(coalesce(
          namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner)
        )) privilege
        union all
        select 'relation:' || relation_row.relkind::text || ':' || relation_row.relname ||
          ':' || privilege.privilege_type || ':' ||
          case privilege.grantee when 0 then '<public>'
            when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantee) end || ':' ||
          case privilege.grantor when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantor) end || ':' ||
          privilege.is_grantable::text
        from authority
        join pg_catalog.pg_namespace namespace_row on namespace_row.nspname = 'public'
        join pg_catalog.pg_class relation_row on relation_row.relnamespace = namespace_row.oid
        cross join lateral pg_catalog.aclexplode(coalesce(
          relation_row.relacl, pg_catalog.acldefault(
            (case when relation_row.relkind = 'S' then 'S' else 'r' end)::"char",
            relation_row.relowner
          )
        )) privilege
        where relation_row.relkind in ('r','p','v','m','S','f')
          and relation_row.relname not in (
            'operations_job_retry_commands', 'operations_job_retry_claims'
          )
        union all
        select 'column:' || relation_row.relname || ':' || attribute_row.attname || ':' ||
          privilege.privilege_type || ':' ||
          case privilege.grantee when 0 then '<public>'
            when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantee) end || ':' ||
          case privilege.grantor when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantor) end || ':' ||
          privilege.is_grantable::text
        from authority
        join pg_catalog.pg_namespace namespace_row on namespace_row.nspname = 'public'
        join pg_catalog.pg_class relation_row on relation_row.relnamespace = namespace_row.oid
        join pg_catalog.pg_attribute attribute_row on attribute_row.attrelid = relation_row.oid
        cross join lateral pg_catalog.aclexplode(attribute_row.attacl) privilege
        where relation_row.relname not in (
            'operations_job_retry_commands', 'operations_job_retry_claims'
          ) and attribute_row.attnum > 0 and not attribute_row.attisdropped
          and attribute_row.attacl is not null
        union all
        select 'type:' || type_row.typname || ':' || privilege.privilege_type || ':' ||
          case privilege.grantee when 0 then '<public>'
            when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantee) end || ':' ||
          case privilege.grantor when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantor) end || ':' ||
          privilege.is_grantable::text
        from authority
        join pg_catalog.pg_namespace namespace_row on namespace_row.nspname = 'public'
        join pg_catalog.pg_type type_row on type_row.typnamespace = namespace_row.oid
        cross join lateral pg_catalog.aclexplode(coalesce(
          type_row.typacl, pg_catalog.acldefault('T', type_row.typowner)
        )) privilege
        where type_row.typtype in ('d','e') and type_row.typname not like
          'operations_job_retry_%'
        union all
        select 'routine:' || routine.proname || '(' ||
          pg_catalog.pg_get_function_identity_arguments(routine.oid) || '):' ||
          privilege.privilege_type || ':' ||
          case privilege.grantee when 0 then '<public>'
            when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantee) end || ':' ||
          case privilege.grantor when authority.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantor) end || ':' ||
          privilege.is_grantable::text
        from authority
        join pg_catalog.pg_namespace namespace_row on namespace_row.nspname = 'public'
        join pg_catalog.pg_proc routine on routine.pronamespace = namespace_row.oid
        cross join lateral pg_catalog.aclexplode(coalesce(
          routine.proacl, pg_catalog.acldefault('f', routine.proowner)
        )) privilege
        where routine.proname not in (
          'plan7a_operations_job_catalog', 'plan7a_operations_safe_failure_code',
          'plan7a_operations_assert_job_capability',
          'plan7a_operations_guard_command_update',
          'plan7a_operations_guard_command_delete',
          'plan7a_operations_guard_job_transition', 'list_operational_jobs',
          'submit_job_retry_command', 'get_owned_job_retry_command',
          'plan7a_operations_claim_job', 'plan7a_operations_renew_job_claim',
          'plan7a_operations_relinquish_job', 'plan7a_operations_complete_job',
          'plan7a_operations_fail_job', 'plan7a_operations_exhaust_job',
          'plan7a_operations_lock_job_retry_command',
          'plan7a_operations_transition_job_retry_command'
        )
      )
      select encode(sha256(convert_to(
        string_agg(descriptor, E'\\n' order by descriptor), 'UTF8'
      )), 'hex') as digest from acl_descriptor
    `);
    expect(predecessorAcl.rows[0]!.digest).toBe(
      '9d22545961747a6434b6eee47093c6c82c512483a6e36a5a49af0c0f41684e7a'
    );
  });

  it('pins exact routine ownership, direct ACLs, effective execution, and session guards', async () => {
    const signatures = [
      ...PUBLIC_OPERATIONS_ROUTINES.map((routine) => routine.signature),
      ...WORKER_OPERATIONS_ROUTINES.map((routine) => routine.signature),
      ...OWNER_ONLY_OPERATIONS_ROUTINES
    ];
    const authority = await ownerDatabaseClient.pool.query<{
      signature: string;
      owner: string;
      direct_acl: string[];
      owner_execute: boolean;
      runtime_execute: boolean;
      worker_execute: boolean;
      cleanup_execute: boolean;
    }>(`
      with database_owner as (
        select database_row.datdba as owner_oid,
          pg_catalog.pg_get_userbyid(database_row.datdba) as owner_name
        from pg_catalog.pg_database database_row
        where database_row.datname = pg_catalog.current_database()
      )
      select routine.oid::regprocedure::text as signature,
        case when routine.proowner = database_owner.owner_oid then '<owner>'
          else pg_catalog.pg_get_userbyid(routine.proowner) end as owner,
        array_agg(
          privilege.privilege_type || ':' ||
          case privilege.grantee when 0 then '<public>'
            when database_owner.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantee) end || ':' ||
          case privilege.grantor when database_owner.owner_oid then '<owner>'
            else pg_catalog.pg_get_userbyid(privilege.grantor) end || ':' ||
          privilege.is_grantable::text
          order by privilege.privilege_type,
            case privilege.grantee when 0 then '<public>'
              when database_owner.owner_oid then '<owner>'
              else pg_catalog.pg_get_userbyid(privilege.grantee) end
        )::text[] as direct_acl,
        pg_catalog.has_function_privilege(
          database_owner.owner_name, routine.oid, 'EXECUTE'
        ) as owner_execute,
        pg_catalog.has_function_privilege(
          'pale_orbit_runtime', routine.oid, 'EXECUTE'
        ) as runtime_execute,
        pg_catalog.has_function_privilege(
          'pale_orbit_financial_worker', routine.oid, 'EXECUTE'
        ) as worker_execute,
        pg_catalog.has_function_privilege(
          'pale_orbit_storage_cleanup', routine.oid, 'EXECUTE'
        ) as cleanup_execute
      from database_owner
      join pg_catalog.pg_proc routine
        on routine.oid::regprocedure::text = any($1::text[])
      cross join lateral pg_catalog.aclexplode(coalesce(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) privilege
      group by routine.oid, database_owner.owner_oid, database_owner.owner_name
      order by signature
    `, [signatures]);
    const publicSignatures = new Set(PUBLIC_OPERATIONS_ROUTINES.map(
      (routine) => routine.signature
    ));
    const workerSignatures = new Set(WORKER_OPERATIONS_ROUTINES.map(
      (routine) => routine.signature
    ));
    expect(authority.rows).toHaveLength(19);
    for (const row of authority.rows) {
      const publicRoutine = publicSignatures.has(row.signature as never);
      const workerRoutine = workerSignatures.has(row.signature as never);
      expect(row.owner, row.signature).toBe('<owner>');
      expect(row.direct_acl, row.signature).toEqual([
        'EXECUTE:<owner>:<owner>:false',
        ...(publicRoutine ? ['EXECUTE:pale_orbit_runtime:<owner>:false'] : []),
        ...(workerRoutine ? ['EXECUTE:pale_orbit_financial_worker:<owner>:false'] : [])
      ]);
      expect({
        owner: row.owner_execute,
        runtime: row.runtime_execute,
        worker: row.worker_execute,
        cleanup: row.cleanup_execute
      }, row.signature).toEqual({
        owner: true,
        runtime: publicRoutine,
        worker: publicRoutine || workerRoutine,
        cleanup: false
      });
    }

    for (const routine of PUBLIC_OPERATIONS_ROUTINES) {
      for (const pool of [ownerDatabaseClient.pool, workerDatabaseClient.pool]) {
        await expectDatabaseError(pool.query(routine.call), {
          code: '42501', message: routine.sessionError
        });
      }
    }
    for (const routine of WORKER_OPERATIONS_ROUTINES) {
      for (const pool of [ownerDatabaseClient.pool, workerDatabaseClient.pool]) {
        await expectDatabaseError(pool.query(routine.call), AUTHORITY_ERROR);
      }
      for (const pool of [databaseClient.pool, storageCleanupDatabaseClient.pool]) {
        await expectDatabaseCode(pool.query(routine.call), '42501');
      }
    }
  });

  it('enforces application/private session identities before protected reads', async () => {
    const actorId = randomUUID();
    await expectDatabaseError(
      ownerDatabaseClient.pool.query(
        'select * from public.list_operational_jobs($1, null, null, null, null, 1)',
        [actorId]
      ),
      { code: '42501', message: 'job operations listing is not permitted' }
    );
    await expectDatabaseError(
      workerDatabaseClient.pool.query(
        'select * from public.list_operational_jobs($1, null, null, null, null, 1)',
        [actorId]
      ),
      { code: '42501', message: 'job operations listing is not permitted' }
    );
    await expectDatabaseError(
      storageCleanupDatabaseClient.pool.query(
        'select * from public.list_operational_jobs($1, null, null, null, null, 1)',
        [actorId]
      ),
      { code: '42501', message: 'permission denied for function list_operational_jobs' }
    );
    await expectDatabaseError(
      databaseClient.pool.query(
        `select * from public.plan7a_operations_claim_job(
          $1::uuid, 'web-forbidden', 1000
        )`,
        [randomUUID()]
      ),
      { code: '42501', message: 'permission denied for function plan7a_operations_claim_job' }
    );
  });
});

describe('Plan 7A operations public authority', () => {
  it('lists only exact safe fields in raw descending keyset order with strict inputs', async () => {
    const actorId = await createActor();
    const first = await createFailedTarget(
      'outbox.dispatch', 1, 8, '2026-08-26T12:34:56.123455Z'
    );
    const second = await createFailedTarget(
      'outbox.dispatch', 1, 8, '2026-08-26T12:34:56.123456Z'
    );
    const unregistered = await createFailedTarget(
      'legacy.unknown', 1, 8, '2026-08-26T12:34:55.999999Z'
    );
    const listed = await databaseClient.pool.query<Record<string, unknown>>(
      `select * from public.list_operational_jobs(
        $1::uuid, 'failed', null, null, null, 2
      )`,
      [actorId]
    );
    expect(listed.rows.map((row) => row.job_id)).toEqual([second.id, first.id]);
    expect(Object.keys(listed.rows[0]!).sort()).toEqual([
      'attempts', 'completed_at', 'created_at', 'job_id', 'kind', 'label',
      'max_attempts', 'policy_availability', 'retry_disposition', 'run_at',
      'safe_failure_code', 'status', 'updated_at'
    ]);
    for (const row of listed.rows) {
      for (const field of ['created_at', 'run_at', 'updated_at', 'completed_at'] as const) {
        if (row[field] !== null) expect(row[field]).toMatch(CANONICAL_TIMESTAMP);
      }
      expect(JSON.stringify(row)).not.toMatch(/payload|deduplication|last_error|locked_/u);
    }
    const next = await databaseClient.pool.query<Record<string, unknown>>(
      `select * from public.list_operational_jobs(
        $1::uuid, 'failed', null, $2::timestamptz, $3::uuid, 10
      )`,
      [actorId, first.updatedAt, first.id]
    );
    expect(next.rows).toMatchObject([{
      job_id: unregistered.id,
      kind: 'unregistered',
      label: 'Unregistered job',
      retry_disposition: 'never',
      policy_availability: 'excluded',
      safe_failure_code: 'unregistered_job_kind'
    }]);
    const tieA = await createFailedTarget(
      'outbox.dispatch', 1, 8, '2026-08-26T12:34:56.999999Z'
    );
    const tieB = await createFailedTarget(
      'outbox.dispatch', 1, 8, '2026-08-26T12:34:56.999999Z'
    );
    const [higherTieId, lowerTieId] = [tieA.id, tieB.id].sort().reverse();
    const afterTie = await databaseClient.pool.query<{ job_id: string }>(
      `select job_id from public.list_operational_jobs(
        $1::uuid, 'failed', 'outbox.dispatch', $2::timestamptz, $3::uuid, 1
      )`,
      [actorId, tieA.updatedAt, higherTieId]
    );
    expect(afterTie.rows).toEqual([{ job_id: lowerTieId }]);
    await expectDatabaseError(
      databaseClient.pool.query(
        `select job_id from public.list_operational_jobs(
          $1::uuid, 'failed', 'outbox.dispatch', 'infinity'::timestamptz,
          'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, 1
        )`,
        [actorId]
      ),
      { code: '22023', message: 'invalid job operations list request' }
    );
    await expectDatabaseError(
      databaseClient.pool.query(
        `select job_id from public.list_operational_jobs(
          $1::uuid, 'failed', 'outbox.dispatch', '-infinity'::timestamptz,
          '00000000-0000-0000-0000-000000000000'::uuid, 1
        )`,
        [actorId]
      ),
      { code: '22023', message: 'invalid job operations list request' }
    );
    const oppositeStatus = await createFailedTarget(
      'outbox.dispatch', 1, 8, '2026-08-26T12:34:58.123456Z'
    );
    await ownerDatabaseClient.pool.query(
      "update jobs set status = 'pending', completed_at = null where id = $1",
      [oppositeStatus.id]
    );
    const otherRegistered = await createFailedTarget(
      'commerce.stripe-event', 1, 12, '2026-08-26T12:34:57.123456Z'
    );
    const filtered = await databaseClient.pool.query<{ job_id: string; kind: string }>(
      `select job_id, kind from public.list_operational_jobs(
        $1::uuid, 'failed', 'outbox.dispatch', null, null, 100
      )`,
      [actorId]
    );
    expect(filtered.rows).toEqual([
      { job_id: higherTieId, kind: 'outbox.dispatch' },
      { job_id: lowerTieId, kind: 'outbox.dispatch' },
      { job_id: second.id, kind: 'outbox.dispatch' },
      { job_id: first.id, kind: 'outbox.dispatch' }
    ]);
    expect(filtered.rows.map((row) => row.job_id)).not.toContain(otherRegistered.id);
    expect(filtered.rows.map((row) => row.job_id)).not.toContain(oppositeStatus.id);
    await expectDatabaseError(
      databaseClient.pool.query(
        'select * from public.list_operational_jobs($1, null, null, null, null, 0)',
        [actorId]
      ),
      { code: '22023', message: 'invalid job operations list request' }
    );
    await expectDatabaseError(
      databaseClient.pool.query(
        'select * from public.list_operational_jobs($1, null, null, now(), null, 1)',
        [actorId]
      ),
      { code: '22023', message: 'invalid job operations list request' }
    );
    await expectDatabaseError(
      databaseClient.pool.query(
        `select * from public.list_operational_jobs(
          $1, 'failed', 'legacy.unknown', null, null, 1
        )`,
        [actorId]
      ),
      { code: '22023', message: 'invalid job operations list request' }
    );
    await expectDatabaseError(
      databaseClient.pool.query(
        "select * from public.list_operational_jobs($1, 'queued', null, null, null, 1)",
        [actorId]
      ),
      { code: '22023', message: 'invalid job operations list request' }
    );
    await expectDatabaseError(
      databaseClient.pool.query(
        'select * from public.list_operational_jobs($1, null, null, null, null, 101)',
        [actorId]
      ),
      { code: '22023', message: 'invalid job operations list request' }
    );
    await expectDatabaseError(
      databaseClient.pool.query(
        'select * from public.list_operational_jobs($1, null, null, null, $2, 1)',
        [actorId, first.id]
      ),
      { code: '22023', message: 'invalid job operations list request' }
    );
  });

  it('rebuilds canonical fingerprints and atomically submits, scopes, and replays', async () => {
    const actorId = await createActor();
    const otherActorId = await createActor();
    const target = await createFailedTarget();
    const idempotencyKey = randomUUID();
    const first = await submit(actorId, target, idempotencyKey, 'plan7a-first');
    expect(first.row).toMatchObject({
      kind: 'retry_failed_job',
      target_job_id: target.id,
      target_kind: 'outbox.dispatch',
      reason_code: 'dependency_recovered',
      correlation_id: 'plan7a-first',
      status: 'pending',
      result_code: null,
      completed_at: null
    });
    expect(first.row.created_at).toMatch(CANONICAL_TIMESTAMP);
    expect(first.row.updated_at).toBe(first.row.created_at);

    const canonicalHash = await ownerDatabaseClient.pool.query<{ hash: string }>(
      `select encode(sha256(convert_to($1, 'UTF8')), 'hex') as hash`,
      [first.prepared.canonicalInput]
    );
    expect(canonicalHash.rows[0]!.hash).toBe(first.prepared.inputFingerprintSha256);
    const inventory = await ownerDatabaseClient.pool.query<{
      commands: number;
      jobs: number;
      audits: number;
    }>(`
      select
        (select count(*)::integer from operations_job_retry_commands) as commands,
        (select count(*)::integer from jobs
          where type = 'operations.job-retry-command') as jobs,
        (select count(*)::integer from audit_events
          where action = 'operations.job_retry.requested') as audits
    `);
    expect(inventory.rows[0]).toEqual({ commands: 1, jobs: 1, audits: 1 });

    const owned = await databaseClient.pool.query(
      'select * from public.get_owned_job_retry_command($1, $2)',
      [actorId, first.row.command_id]
    );
    const foreign = await databaseClient.pool.query(
      'select * from public.get_owned_job_retry_command($1, $2)',
      [otherActorId, first.row.command_id]
    );
    expect(owned.rows).toEqual([first.row]);
    expect(foreign.rows).toEqual([]);

    const replay = await submit(
      actorId,
      target,
      idempotencyKey,
      'plan7a-replay-diagnostic-correlation'
    );
    expect(replay.row).toEqual(first.row);
    expect((await ownerDatabaseClient.pool.query(`
      select
        (select count(*)::integer from operations_job_retry_commands) as commands,
        (select count(*)::integer from jobs
          where type = 'operations.job-retry-command') as jobs,
        (select count(*)::integer from audit_events
          where action = 'operations.job_retry.requested') as audits
    `)).rows[0]).toEqual({ commands: 1, jobs: 1, audits: 1 });

    const changed = prepareJobRetryCommand({
      ...first.prepared.command,
      reasonCode: 'operator_reassessment'
    });
    await expectDatabaseError(
      databaseClient.pool.query(
        `select * from public.submit_job_retry_command(
          $1, $2, 'outbox.dispatch', 1, 8, $3, 'operator_reassessment',
          'plan7a-changed', $4, $5
        )`,
        [actorId, target.id, target.updatedAt,
          changed.idempotencyKeySha256, changed.inputFingerprintSha256]
      ),
      { code: '40900', message: 'job retry command idempotency conflict' }
    );
  });

  it('rolls back fresh incorrect fingerprints and stale target snapshots without residue', async () => {
    const actorId = await createActor();
    const target = await createFailedTarget();
    await expectDatabaseError(
      submit(actorId, target, randomUUID(), 'plan7a-wrong-fingerprint', 'f'.repeat(64)),
      { code: '40900', message: 'job retry command input fingerprint conflict' }
    );
    await ownerDatabaseClient.pool.query(
      `update jobs set updated_at = updated_at + interval '1 microsecond' where id = $1`,
      [target.id]
    );
    await expectDatabaseError(
      submit(actorId, target, randomUUID(), 'plan7a-stale-target'),
      { code: '40900', message: 'job retry command target state conflict' }
    );
    const residues = await ownerDatabaseClient.pool.query<{
      commands: number;
      operations_jobs: number;
      operations_audits: number;
    }>(`
      select
        (select count(*)::integer from operations_job_retry_commands) as commands,
        (select count(*)::integer from jobs
          where type = 'operations.job-retry-command') as operations_jobs,
        (select count(*)::integer from audit_events
          where action like 'operations.job_retry.%') as operations_audits
    `);
    expect(residues.rows[0]).toEqual({
      commands: 0,
      operations_jobs: 0,
      operations_audits: 0
    });
  });

  it('rejects a null requested reason as a fixed public input failure', async () => {
    const actorId = await createActor();
    const target = await createFailedTarget();
    const prepared = preparedInput(target);
    await expectDatabaseError(
      databaseClient.pool.query(
        `select * from public.submit_job_retry_command(
          $1::uuid, $2::uuid, 'outbox.dispatch'::text, 1, 8,
          $3::timestamptz, null::text, $4::text, $5::text, $6::text
        )`,
        [
          actorId, target.id, target.updatedAt, `plan7a-null-${randomUUID()}`,
          prepared.idempotencyKeySha256, prepared.inputFingerprintSha256
        ]
      ),
      { code: '22023', message: 'invalid job retry command' }
    );
    expect((await ownerDatabaseClient.pool.query(`
      select
        (select count(*)::integer from operations_job_retry_commands) as commands,
        (select count(*)::integer from jobs
          where type = 'operations.job-retry-command') as operations_jobs,
        (select count(*)::integer from audit_events
          where action like 'operations.job_retry.%') as operations_audits
    `)).rows[0]).toEqual({ commands: 0, operations_jobs: 0, operations_audits: 0 });
  });
});

describe('Plan 7A reserved storage and digest-only claim authority', () => {
  it('rejects direct table access and every reserved job/audit identity half', async () => {
    for (const pool of [databaseClient.pool, workerDatabaseClient.pool]) {
      await expectDatabaseError(
        pool.query('select * from operations_job_retry_commands'),
        { code: '42501', message: 'permission denied for table operations_job_retry_commands' }
      );
      await expectDatabaseError(
        pool.query('select * from operations_job_retry_claims'),
        { code: '42501', message: 'permission denied for table operations_job_retry_claims' }
      );
    }

    const insertCases: ReadonlyArray<readonly [string, readonly unknown[]]> = [
      [
        `insert into jobs (type, payload, deduplication_key, max_attempts)
         values ('operations.job-retry-command', jsonb_build_object('commandId', $1::uuid),
           'operations:job-retry-command:' || $1::uuid::text || ':v1', 8)`,
        [randomUUID()]
      ],
      [
        `insert into jobs (type, payload, deduplication_key, max_attempts)
         values ('outbox.dispatch', '{}'::jsonb,
           'operations:job-retry-command:' || $1::uuid::text || ':v1', 8)`,
        [randomUUID()]
      ],
      [
        `insert into audit_events (
           actor_type, actor_id, action, outcome, resource_type, correlation_id
         ) values ('system', 'financial-worker', 'operations.job_retry.forged',
           'failed', 'job', 'plan7a-forged-audit')`,
        []
      ],
      [
        `insert into audit_events (
           actor_type, actor_id, action, outcome, resource_type, correlation_id
         ) values ('system', 'financial-worker', 'commerce.refund_reconciled',
           'failed', 'operations_job_retry_command', 'plan7a-forged-resource')`,
        []
      ]
    ];
    const provenanceSettings = [
      'pale_orbit.plan7a_operations_command_insert_id',
      'pale_orbit.plan7a_operations_command_transition_id',
      'pale_orbit.plan7a_operations_job_transition_id',
      'pale_orbit.plan7a_operations_job_capability'
    ] as const;
    const provenanceVariants = [
      ...provenanceSettings.map((setting) => [setting] as const),
      provenanceSettings
    ];
    for (const pool of [databaseClient.pool, workerDatabaseClient.pool]) {
      for (const [caseIndex, [text, parameters]] of insertCases.entries()) {
        for (const settings of provenanceVariants) {
          const connection = await pool.connect();
          try {
            await connection.query('begin');
            const settingValue = text.includes('insert into jobs')
              ? parameters[0]
              : randomUUID();
            await connection.query(
              `select set_config(setting, $1, true)
               from unnest($2::text[]) setting`,
              [settingValue, [...settings]]
            );
            try {
              await connection.query(text, [...parameters]);
              throw new Error('Expected reserved provenance forgery to fail');
            } catch (error) {
              expect(
                databaseError(error).code,
                `${pool === databaseClient.pool ? 'runtime' : 'worker'} case ${caseIndex} ` +
                  `settings ${settings.join(',')}`
              ).toBe('55000');
            }
          } finally {
            await connection.query('rollback').catch(() => undefined);
            connection.release();
          }
        }
      }
    }
    expect((await ownerDatabaseClient.pool.query(`
      select
        (select count(*)::integer from operations_job_retry_commands) as commands,
        (select count(*)::integer from operations_job_retry_claims) as claims,
        (select count(*)::integer from jobs where
          type = 'operations.job-retry-command' or
          deduplication_key like 'operations:job-retry-command:%') as jobs,
        (select count(*)::integer from audit_events where
          left(action, 21) = 'operations.job_retry.' or
          resource_type = 'operations_job_retry_command') as audits
    `)).rows[0]).toEqual({ commands: 0, claims: 0, jobs: 0, audits: 0 });

    await expectDatabaseError(
      workerDatabaseClient.pool.query(`
        insert into audit_events (
          actor_type, actor_id, action, outcome, resource_type, resource_id,
          correlation_id, request_metadata, before, after
        ) values ('user', $1::text, 'operations.job_retry.requested', 'denied',
          'operations_job_retry_command', null,
          'plan7a-worker-forged-requested-denied', null, null, null)
      `, [randomUUID()]),
      { code: '55000', message: 'operations job retry audit provenance is reserved' }
    );
  });

  it('rejects canonical requested and terminal audit forgeries under every GUC variant', async () => {
    const requestedFixture = await createRetryFixtureForKind('commerce.stripe-event', 12);
    const fixture = await createRetryFixtureForKind('commerce.stripe-event', 12);
    const clear = capability();
    await claim(fixture, clear);
    await workerCall(
      clear,
      `select * from public.plan7a_operations_transition_job_retry_command(
        $1, $2, 'operations-worker-a', 1, 1, 'target_state_changed'
      )`,
      [fixture.internalJobId, fixture.commandId]
    );
    type AuditCommand = {
      actor_user_id: string;
      correlation_id: string;
      target_job_id: string;
      target_job_kind: string;
      reason_code: string;
      safe_result_code: string;
    };
    const readCommand = async (commandId: string): Promise<AuditCommand> =>
      (await ownerDatabaseClient.pool.query<AuditCommand>(`
      select actor_user_id::text, correlation_id, target_job_id::text,
        target_job_kind, reason_code::text,
        coalesce(safe_result_code::text, '') as safe_result_code
      from operations_job_retry_commands where id = $1
    `, [commandId])).rows[0]!;
    const requestedCommand = await readCommand(requestedFixture.commandId);
    const terminalCommand = await readCommand(fixture.commandId);
    const auditCount = async (): Promise<number> => Number((await ownerDatabaseClient.pool.query(
      `select count(*) from audit_events
       where resource_id in ($1, $2) and action like 'operations.job_retry.%'`,
      [requestedFixture.commandId, fixture.commandId]
    )).rows[0]!.count);
    const baselineAudits = await auditCount();
    const settings = [
      'pale_orbit.plan7a_operations_command_insert_id',
      'pale_orbit.plan7a_operations_command_transition_id',
      'pale_orbit.plan7a_operations_job_transition_id',
      'pale_orbit.plan7a_operations_job_capability'
    ] as const;
    const variants = [...settings.map((setting) => [setting] as const), settings];
    const requestedSql = `
      insert into audit_events (
        actor_type, actor_id, action, outcome, resource_type, resource_id,
        correlation_id, request_metadata, before, after
      ) values (
        'user', $1::text, 'operations.job_retry.requested', 'succeeded',
        'operations_job_retry_command', $2::text, $3::text, null, null,
        jsonb_build_object('commandId', $2::text, 'targetJobId', $4::text,
          'registeredKind', $5::text, 'reasonCode', $6::text)
      )`;
    const terminalSql = `
      insert into audit_events (
        actor_type, actor_id, action, outcome, resource_type, resource_id,
        correlation_id, request_metadata, before, after
      ) values (
        'user', $1::text, 'operations.job_retry.denied', 'denied',
        'operations_job_retry_command', $2::text, $3::text, null, null,
        jsonb_build_object('commandId', $2::text, 'targetJobId', $4::text,
          'registeredKind', $5::text, 'reasonCode', $6::text,
          'resultCode', $7::text)
      )`;
    for (const [role, pool] of [
      ['runtime', databaseClient.pool],
      ['worker', workerDatabaseClient.pool]
    ] as const) {
      for (const [shape, sql, auditFixture, command] of [
        ['requested', requestedSql, requestedFixture, requestedCommand],
        ['terminal', terminalSql, fixture, terminalCommand]
      ] as const) {
        for (const variant of variants) {
          const connection = await pool.connect();
          try {
            await connection.query('begin');
            for (const setting of variant) {
              await connection.query('select set_config($1, $2, true)', [
                setting,
                setting.endsWith('_capability')
                  ? clear
                  : setting.endsWith('_job_transition_id')
                    ? auditFixture.internalJobId
                    : auditFixture.commandId
              ]);
            }
            let rejection: unknown;
            try {
              const parameters = [
              command.actor_user_id,
              auditFixture.commandId,
              command.correlation_id,
              command.target_job_id,
              command.target_job_kind,
              command.reason_code,
              command.safe_result_code
              ];
              await connection.query(
                sql,
                shape === 'requested' ? parameters.slice(0, 6) : parameters
              );
            } catch (error) {
              rejection = error;
            }
            expect(rejection, `${role}/${shape}/${variant.join(',')}`).toBeDefined();
            const code = databaseError(rejection).code;
            expect(
              ['42501', '55000'],
              `${role}/${shape}/${variant.join(',')} rejection code`
            ).toContain(code);
          } finally {
            await connection.query('rollback').catch(() => undefined);
            connection.release();
          }
          expect(await auditCount(), `${role}/${shape}/${variant.join(',')}`).toBe(
            baselineAudits
          );
        }
      }
    }
  });

  it('permits only the exact runtime requested-denied audit after pooled local GUC reuse', async () => {
    const actorId = await createActor();
    const correlationId = `plan7a-runtime-denied-${randomUUID()}`;
    const settings = [
      'pale_orbit.plan7a_operations_command_insert_id',
      'pale_orbit.plan7a_operations_command_transition_id',
      'pale_orbit.plan7a_operations_job_transition_id',
      'pale_orbit.plan7a_operations_job_capability'
    ] as const;
    const connection = await databaseClient.pool.connect();
    let auditId: string | undefined;
    try {
      await connection.query('begin');
      await connection.query(
        `select pg_catalog.set_config(setting_name, $1, true)
         from pg_catalog.unnest($2::text[]) setting_name`,
        [randomUUID(), [...settings]]
      );
      await connection.query('commit');
      const cleared = await connection.query<{ values: Array<string | null> }>(`
        select pg_catalog.array_agg(
          pg_catalog.current_setting(setting_name, true) order by setting_name
        ) as values
        from pg_catalog.unnest($1::text[]) setting_name
      `, [[...settings]]);
      expect(cleared.rows[0]!.values).toEqual(['', '', '', '']);

      await connection.query('begin');
      const inserted = await connection.query<{ id: string }>(`
        insert into public.audit_events (
          actor_type, actor_id, action, outcome, resource_type, resource_id,
          correlation_id, request_metadata, before, after
        ) values (
          'user', $1, 'operations.job_retry.requested', 'denied',
          'operations_job_retry_command', null, $2, null, null, null
        ) returning id
      `, [actorId, correlationId]);
      auditId = inserted.rows[0]!.id;
      await connection.query('commit');
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
    expect((await ownerDatabaseClient.pool.query(`
      select actor_type::text, actor_id, action, outcome::text, resource_type,
        resource_id, correlation_id, request_metadata, before, after
      from audit_events where id = $1
    `, [auditId])).rows[0]).toEqual({
      actor_type: 'user',
      actor_id: actorId,
      action: 'operations.job_retry.requested',
      outcome: 'denied',
      resource_type: 'operations_job_retry_command',
      resource_id: null,
      correlation_id: correlationId,
      request_metadata: null,
      before: null,
      after: null
    });
  });

  it('rejects worker transitions into, out of, and across reserved job identity', async () => {
    const fixture = await createRetryFixture();
    const clear = capability();
    await claim(fixture, clear, 'operations-forgery-worker', 60_000);
    const ordinary = await createFailedTarget();
    const crossCommand = randomUUID();
    const updateCases: ReadonlyArray<{
      readonly text: string;
      readonly parameters: readonly unknown[];
      readonly jobId: string;
    }> = [
      {
        text: "update jobs set type = 'operations.job-retry-command' where id = $1",
        parameters: [ordinary.id],
        jobId: ordinary.id
      },
      {
        text: `update jobs set deduplication_key =
          'operations:job-retry-command:' || $2::uuid::text || ':v1' where id = $1`,
        parameters: [ordinary.id, fixture.commandId],
        jobId: ordinary.id
      },
      {
        text: `update jobs set type = 'operations.job-retry-command',
          payload = jsonb_build_object('commandId', $2::uuid),
          deduplication_key = 'operations:job-retry-command:' || $2::uuid::text || ':v1'
          where id = $1`,
        parameters: [ordinary.id, fixture.commandId],
        jobId: ordinary.id
      },
      {
        text: "update jobs set type = 'outbox.dispatch' where id = $1",
        parameters: [fixture.internalJobId],
        jobId: fixture.internalJobId
      },
      {
        text: "update jobs set deduplication_key = 'forged:ordinary' where id = $1",
        parameters: [fixture.internalJobId],
        jobId: fixture.internalJobId
      },
      {
        text: `update jobs set type = 'outbox.dispatch',
          payload = '{}'::jsonb, deduplication_key = 'forged:ordinary' where id = $1`,
        parameters: [fixture.internalJobId],
        jobId: fixture.internalJobId
      },
      {
        text: `update jobs set payload = jsonb_build_object('commandId', $2::uuid),
          deduplication_key = 'operations:job-retry-command:' || $2::uuid::text || ':v1'
          where id = $1`,
        parameters: [fixture.internalJobId, crossCommand],
        jobId: fixture.internalJobId
      }
    ];
    const readProtectedState = async (): Promise<unknown> => (
      await ownerDatabaseClient.pool.query<{ snapshot: unknown }>(`
        select jsonb_build_object(
          'ordinary', (select to_jsonb(job) from jobs job where job.id = $1),
          'operations', (select to_jsonb(job) from jobs job where job.id = $2),
          'claim', (select to_jsonb(claim) from operations_job_retry_claims claim
            where claim.job_id = $2)
        ) as snapshot
      `, [ordinary.id, fixture.internalJobId])
    ).rows[0]!.snapshot;
    const baseline = await readProtectedState();
    const nonsecretProvenanceSettings = [
      'pale_orbit.plan7a_operations_command_insert_id',
      'pale_orbit.plan7a_operations_command_transition_id',
      'pale_orbit.plan7a_operations_job_transition_id'
    ] as const;
    const nonsecretProvenanceVariants = [
      ...nonsecretProvenanceSettings.map((setting) => [setting] as const),
      nonsecretProvenanceSettings
    ];

    await expectDatabaseCode(
      databaseClient.pool.query(
        "update jobs set last_error = 'forged runtime update' where id = $1",
        [fixture.internalJobId]
      ),
      '42501'
    );
    expect(await readProtectedState()).toEqual(baseline);

    for (const updateCase of updateCases) {
      for (const settings of nonsecretProvenanceVariants) {
        const connection = await workerDatabaseClient.pool.connect();
        try {
          await connection.query('begin');
          await connection.query(
            `select pg_catalog.set_config(
               'pale_orbit.plan7a_operations_job_capability', $1, true
             )`,
            [clear]
          );
          await connection.query(
            `select pg_catalog.set_config(setting_name, $1, true)
             from pg_catalog.unnest($2::text[]) setting_name`,
            [updateCase.jobId, [...settings]]
          );
          await expectDatabaseCode(
            connection.query(updateCase.text, [...updateCase.parameters]),
            '55000'
          );
          await connection.query('rollback');
        } finally {
          await connection.query('rollback').catch(() => undefined);
          connection.release();
        }
        expect(await readProtectedState()).toEqual(baseline);
      }
    }
  });

  it('rejects an extra run_at change in an otherwise canonical terminal transition', async () => {
    const fixture = await createRetryFixture();
    const clear = capability();
    await claim(fixture, clear, 'operations-terminal-guard-worker', 60_000);
    const protectedState = async (): Promise<unknown> => (
      await ownerDatabaseClient.pool.query<{ snapshot: unknown }>(`
        select jsonb_build_object(
          'job', (select to_jsonb(job) from jobs job where job.id = $1),
          'claim', (select to_jsonb(claim) from operations_job_retry_claims claim
            where claim.job_id = $1)
        ) as snapshot
      `, [fixture.internalJobId])
    ).rows[0]!.snapshot;
    const baseline = await protectedState();
    const connection = await ownerDatabaseClient.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(
        `select set_config('pale_orbit.plan7a_operations_job_capability', $1, true),
          set_config('pale_orbit.plan7a_operations_job_transition_id', $2, true)`,
        [clear, fixture.internalJobId]
      );
      await expectDatabaseCode(
        connection.query(
          `with transition_time(value) as (select clock_timestamp())
           update jobs job set
             status = 'succeeded', locked_at = null, locked_by = null,
             run_at = job.run_at + interval '1 second', last_error = null,
             rerun_requested_at = null, completed_at = transition_time.value,
             updated_at = transition_time.value
           from transition_time
           where job.id = $1 and job.status = 'running'`,
          [fixture.internalJobId]
        ),
        '55000'
      );
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
    expect(await protectedState()).toEqual(baseline);
  });

  it('stores only the capability digest and renews with one database clock observation', async () => {
    const fixture = await createRetryFixture();
    const clear = capability();
    const claimed = await claim(fixture, clear, 'operations-worker-a', 90_000);
    expect(claimed).toEqual([{
      job_id: fixture.internalJobId,
      job_kind: 'operations.job-retry-command',
      payload: { commandId: fixture.commandId },
      deduplication_key: `operations:job-retry-command:${fixture.commandId}:v1`,
      attempt: 1,
      max_attempts: 8,
      lease_owner: 'operations-worker-a',
      lease_generation: 1
    }]);
    const state = await ownerDatabaseClient.pool.query<{
      capability_sha256: string;
      lease_duration_ms: number;
      state: string;
      issued_at: Date;
      renewed_at: Date | null;
      claim_expires_at: Date;
      locked_at: Date;
      updated_at: Date;
      job_expires_at: Date;
      persisted_text: string;
    }>(`
      select claim.capability_sha256, claim.lease_duration_ms, claim.state,
        claim.issued_at, claim.renewed_at, claim.expires_at as claim_expires_at,
        job.locked_at, job.updated_at, job.run_at as job_expires_at,
        row_to_json(claim)::text || row_to_json(job)::text as persisted_text
      from operations_job_retry_claims claim
      join jobs job on job.id = claim.job_id
      where claim.job_id = $1
    `, [fixture.internalJobId]);
    expect(state.rows[0]).toMatchObject({
      capability_sha256: digest(clear),
      lease_duration_ms: 90_000,
      state: 'active',
      renewed_at: null
    });
    expect(state.rows[0]!.issued_at).toEqual(state.rows[0]!.locked_at);
    expect(state.rows[0]!.issued_at).toEqual(state.rows[0]!.updated_at);
    expect(state.rows[0]!.claim_expires_at).toEqual(state.rows[0]!.job_expires_at);
    expect(state.rows[0]!.claim_expires_at.getTime() - state.rows[0]!.issued_at.getTime())
      .toBe(90_000);
    expect(state.rows[0]!.persisted_text).not.toContain(clear);

    const renewed = await workerCall<{ applied: boolean }>(
      clear,
      `select * from public.plan7a_operations_renew_job_claim($1, $2, $3, $4)`,
      [fixture.internalJobId, 'operations-worker-a', 1, 1]
    );
    expect(renewed).toEqual([{ applied: true }]);
    const renewal = await ownerDatabaseClient.pool.query<{
      renewed_at: Date;
      claim_expires_at: Date;
      locked_at: Date;
      updated_at: Date;
      job_expires_at: Date;
    }>(`
      select claim.renewed_at, claim.expires_at as claim_expires_at,
        job.locked_at, job.updated_at, job.run_at as job_expires_at
      from operations_job_retry_claims claim join jobs job on job.id = claim.job_id
      where claim.job_id = $1
    `, [fixture.internalJobId]);
    expect(renewal.rows[0]!.renewed_at).toEqual(renewal.rows[0]!.locked_at);
    expect(renewal.rows[0]!.renewed_at).toEqual(renewal.rows[0]!.updated_at);
    expect(renewal.rows[0]!.claim_expires_at).toEqual(renewal.rows[0]!.job_expires_at);
    expect(renewal.rows[0]!.claim_expires_at.getTime() -
      renewal.rows[0]!.renewed_at.getTime()).toBe(90_000);
  });

  it('keeps a fixed clear capability out of rows, JSON, errors, catalogs, and evidence', async () => {
    const fixture = await createRetryFixture();
    const clearCapabilityCanary = 'A'.repeat(43);
    await claim(fixture, clearCapabilityCanary, 'operations-canary-worker', 60_000);
    const persisted = await ownerDatabaseClient.pool.query<{ evidence: unknown }>(`
      select jsonb_build_object(
        'command', to_jsonb(command),
        'job', to_jsonb(job),
        'claim', to_jsonb(claim),
        'audit', coalesce((select jsonb_agg(to_jsonb(audit) order by audit.id)
          from audit_events audit
          where audit.resource_id = command.id::text), '[]'::jsonb)
      ) as evidence
      from operations_job_retry_commands command
      join jobs job on job.payload = jsonb_build_object('commandId', command.id)
      join operations_job_retry_claims claim on claim.job_id = job.id
      where command.id = $1
    `, [fixture.commandId]);
    const publicEvidence = await databaseClient.pool.query(`
      select jsonb_build_object(
        'owned', (select to_jsonb(owned) from public.get_owned_job_retry_command($1, $2) owned),
        'listed', (select coalesce(jsonb_agg(to_jsonb(listed)), '[]'::jsonb)
          from public.list_operational_jobs($1, null, null, null, null, 100) listed)
      ) as evidence
    `, [fixture.actorId, fixture.commandId]);
    const privateEvidence = await workerCall(
      clearCapabilityCanary,
      `select * from public.plan7a_operations_lock_job_retry_command(
        $1, $2, 'operations-canary-worker', 1, 1
      )`,
      [fixture.internalJobId, fixture.commandId]
    );
    const catalogEvidence = await ownerDatabaseClient.pool.query(`
      select jsonb_build_object(
        'catalog', (select jsonb_agg(to_jsonb(catalog))
          from public.plan7a_operations_job_catalog() catalog),
        'routines', (select jsonb_agg(pg_get_functiondef(routine.oid))
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace_row
            on namespace_row.oid = routine.pronamespace
          where namespace_row.nspname = 'public'
            and (routine.proname like 'plan7a_operations_%'
              or routine.proname in (
                'list_operational_jobs', 'submit_job_retry_command',
                'get_owned_job_retry_command'
              )))
      ) as evidence
    `);
    let fixedError: { code?: string; message?: string } | undefined;
    try {
      await workerCall(
        clearCapabilityCanary,
        'select * from public.plan7a_operations_renew_job_claim($1, $2, 1, 1)',
        [fixture.internalJobId, 'operations-wrong-worker']
      );
      throw new Error('Expected canary authority operation to fail');
    } catch (error) {
      fixedError = databaseError(error);
    }
    expect(fixedError).toEqual(AUTHORITY_ERROR);
    expect(JSON.stringify({
      persisted: persisted.rows,
      publicEvidence: publicEvidence.rows,
      privateEvidence,
      catalogEvidence: catalogEvidence.rows,
      fixedError
    })).not.toContain(clearCapabilityCanary);
  });

  it('collapses missing, malformed, forged, and cross-binding capabilities identically', async () => {
    const first = await createRetryFixture();
    const clear = capability();
    await claim(first, clear, 'operations-worker-a', 60_000);
    const second = await createRetryFixture();
    const secondClear = capability();
    await claim(second, secondClear, 'operations-worker-b', 60_000);

    const cases: ReadonlyArray<{
      readonly clear: string;
      readonly jobId: string;
      readonly owner: string;
      readonly attempt: number;
      readonly generation: number;
    }> = [
      { clear: 'malformed', jobId: first.internalJobId, owner: 'operations-worker-a', attempt: 1, generation: 1 },
      { clear: capability(), jobId: first.internalJobId, owner: 'operations-worker-a', attempt: 1, generation: 1 },
      { clear, jobId: second.internalJobId, owner: 'operations-worker-b', attempt: 1, generation: 1 },
      { clear, jobId: first.internalJobId, owner: 'operations-worker-a', attempt: 2, generation: 1 },
      { clear, jobId: first.internalJobId, owner: 'operations-worker-b', attempt: 1, generation: 1 },
      { clear, jobId: first.internalJobId, owner: 'operations-worker-a', attempt: 1, generation: 2 }
    ];
    for (const candidate of cases) {
      await expectDatabaseError(
        workerCall(
          candidate.clear,
          `select * from public.plan7a_operations_renew_job_claim($1, $2, $3, $4)`,
          [candidate.jobId, candidate.owner, candidate.attempt, candidate.generation]
        ),
        AUTHORITY_ERROR
      );
    }
    const connection = await workerDatabaseClient.pool.connect();
    try {
      await connection.query('begin');
      await expectDatabaseError(
        connection.query(
          `select * from public.plan7a_operations_renew_job_claim($1, $2, 1, 1)`,
          [first.internalJobId, 'operations-worker-a']
        ),
        AUTHORITY_ERROR
      );
      await connection.query('rollback');
    } finally {
      connection.release();
    }
  });

  it('replaces duration and generation on an ordinary PostgreSQL-clock expiry takeover', async () => {
    const fixture = await createRetryFixture();
    const expiredCapability = capability();
    await claim(fixture, expiredCapability, 'operations-expired-worker', 50);
    await waitUntilJobDue(fixture.internalJobId);
    await expectDatabaseError(
      workerCall(
        expiredCapability,
        'select * from public.plan7a_operations_renew_job_claim($1, $2, 1, 1)',
        [fixture.internalJobId, 'operations-expired-worker']
      ),
      AUTHORITY_ERROR
    );

    const currentCapability = capability();
    expect(await claim(
      fixture,
      currentCapability,
      'operations-takeover-worker',
      4_321
    )).toMatchObject([{
      attempt: 2,
      lease_owner: 'operations-takeover-worker',
      lease_generation: 2
    }]);
    const state = await ownerDatabaseClient.pool.query<{
      generation: number;
      attempt: number;
      capability_sha256: string;
      lease_duration_ms: number;
      state: string;
      issued_at: Date;
      renewed_at: Date | null;
      claim_expires_at: Date;
      locked_at: Date;
      updated_at: Date;
      job_expires_at: Date;
    }>(`
      select claim.generation, claim.attempt, claim.capability_sha256,
        claim.lease_duration_ms, claim.state, claim.issued_at, claim.renewed_at,
        claim.expires_at as claim_expires_at, job.locked_at, job.updated_at,
        job.run_at as job_expires_at
      from operations_job_retry_claims claim
      join jobs job on job.id = claim.job_id
      where claim.job_id = $1
    `, [fixture.internalJobId]);
    expect(state.rows[0]).toMatchObject({
      generation: 2,
      attempt: 2,
      capability_sha256: digest(currentCapability),
      lease_duration_ms: 4_321,
      state: 'active',
      renewed_at: null
    });
    expect(state.rows[0]!.issued_at).toEqual(state.rows[0]!.locked_at);
    expect(state.rows[0]!.issued_at).toEqual(state.rows[0]!.updated_at);
    expect(state.rows[0]!.claim_expires_at).toEqual(state.rows[0]!.job_expires_at);
    expect(state.rows[0]!.claim_expires_at.getTime() - state.rows[0]!.issued_at.getTime())
      .toBe(4_321);
  });

  it('rotates generation and duration after relinquish and rejects prior/invalidated authority', async () => {
    const fixture = await createRetryFixture();
    const prior = capability();
    await claim(fixture, prior, 'operations-worker-a', 120_000);
    const relinquished = await workerCall<{ applied: boolean }>(
      prior,
      `select * from public.plan7a_operations_relinquish_job(
        $1, $2, $3, $4, $5, $6
      )`,
      [fixture.internalJobId, 'operations-worker-a', 1, 1,
        'Transient job handler failure', 1]
    );
    expect(relinquished).toEqual([{ applied: true }]);
    await expectDatabaseError(
      workerCall(
        prior,
        'select * from public.plan7a_operations_renew_job_claim($1, $2, 1, 1)',
        [fixture.internalJobId, 'operations-worker-a']
      ),
      AUTHORITY_ERROR
    );

    await waitUntilJobDue(fixture.internalJobId);
    const current = capability();
    const takeover = await claim(fixture, current, 'operations-worker-b', 3_000);
    expect(takeover[0]).toMatchObject({
      attempt: 2,
      lease_owner: 'operations-worker-b',
      lease_generation: 2
    });
    const rotated = await ownerDatabaseClient.pool.query<{
      generation: number;
      attempt: number;
      capability_sha256: string;
      lease_duration_ms: number;
      issued_at: Date;
      renewed_at: Date | null;
      expires_at: Date;
    }>('select * from operations_job_retry_claims where job_id = $1', [fixture.internalJobId]);
    expect(rotated.rows[0]).toMatchObject({
      generation: 2,
      attempt: 2,
      capability_sha256: digest(current),
      lease_duration_ms: 3_000,
      renewed_at: null
    });
    expect(rotated.rows[0]!.expires_at.getTime() - rotated.rows[0]!.issued_at.getTime())
      .toBe(3_000);
    await expectDatabaseError(
      workerCall(
        prior,
        'select * from public.plan7a_operations_renew_job_claim($1, $2, 2, 2)',
        [fixture.internalJobId, 'operations-worker-b']
      ),
      AUTHORITY_ERROR
    );
  });

  it('adopts the final attempt, exhausts pending command once, and invalidates both capabilities', async () => {
    const fixture = await createRetryFixture();
    const finalClaim = await advanceToFinalClaim(fixture, 50);
    await waitUntilJobDue(fixture.internalJobId);
    const consumedCapability = capability();
    expect(await claim(
      fixture,
      consumedCapability,
      'operations-ceiling-final',
      4_321
    )).toEqual([]);
    const terminal = await ownerDatabaseClient.pool.query<{
      command_status: string;
      safe_result_code: string;
      job_status: string;
      attempts: number;
      last_error: string;
      generation: number;
      attempt: number;
      capability_sha256: string;
      lease_duration_ms: number;
      claim_state: string;
      issued_at: Date;
      renewed_at: Date | null;
      expires_at: Date;
      terminal_audits: number;
    }>(`
      select command.status::text as command_status,
        command.safe_result_code::text, job.status::text as job_status,
        job.attempts, job.last_error, claim.generation, claim.attempt,
        claim.capability_sha256, claim.lease_duration_ms,
        claim.state::text as claim_state, claim.issued_at, claim.renewed_at,
        claim.expires_at,
        (select count(*)::integer from audit_events audit
          where audit.resource_id = command.id::text
            and audit.action = 'operations.job_retry.failed') as terminal_audits
      from operations_job_retry_commands command
      join jobs job on job.payload = jsonb_build_object('commandId', command.id)
      join operations_job_retry_claims claim on claim.job_id = job.id
      where command.id = $1
    `, [fixture.commandId]);
    expect(terminal.rows[0]).toMatchObject({
      command_status: 'failed',
      safe_result_code: 'retry_command_exhausted',
      job_status: 'failed',
      attempts: 8,
      last_error: 'Operations job retry command exhausted.',
      generation: 9,
      attempt: 8,
      capability_sha256: digest(consumedCapability),
      lease_duration_ms: 4_321,
      claim_state: 'invalidated',
      renewed_at: null,
      terminal_audits: 1
    });
    expect(terminal.rows[0]!.expires_at.getTime() - terminal.rows[0]!.issued_at.getTime())
      .toBe(4_321);
    for (const candidate of [
      {
        clear: finalClaim.capability,
        owner: 'operations-ceiling-worker-8',
        generation: finalClaim.generation
      },
      { clear: consumedCapability, owner: 'operations-ceiling-final', generation: 9 }
    ]) {
      await expectDatabaseError(
        workerCall(
          candidate.clear,
          'select * from public.plan7a_operations_renew_job_claim($1, $2, 8, $3)',
          [fixture.internalJobId, candidate.owner, candidate.generation]
        ),
        AUTHORITY_ERROR
      );
    }
  }, 20_000);

  it('synchronizes an already-terminal command at the final attempt without another audit', async () => {
    const fixture = await createRetryFixture();
    const finalClaim = await advanceToFinalClaim(fixture, 250);
    expect(await workerCall(
      finalClaim.capability,
      `select * from public.plan7a_operations_transition_job_retry_command(
        $1, $2, 'operations-ceiling-worker-8', 8, $3, 'retry_policy_not_enabled'
      )`,
      [fixture.internalJobId, fixture.commandId, finalClaim.generation]
    )).toMatchObject([{
      command_status: 'denied',
      result_code: 'retry_policy_not_enabled'
    }]);
    const beforeAudit = await ownerDatabaseClient.pool.query<{ count: number }>(
      `select count(*)::integer as count from audit_events
       where resource_id = $1 and action = 'operations.job_retry.denied'`,
      [fixture.commandId]
    );
    expect(beforeAudit.rows[0]).toEqual({ count: 1 });
    await waitUntilJobDue(fixture.internalJobId);
    const consumedCapability = capability();
    expect(await claim(
      fixture,
      consumedCapability,
      'operations-terminal-replay',
      2_345
    )).toEqual([]);
    const synchronized = await ownerDatabaseClient.pool.query(`
      select command.status::text as command_status,
        command.safe_result_code::text, job.status::text as job_status,
        job.attempts, claim.generation, claim.attempt,
        claim.lease_duration_ms, claim.state::text as claim_state,
        claim.renewed_at,
        (select count(*)::integer from audit_events audit
          where audit.resource_id = command.id::text
            and audit.action = 'operations.job_retry.denied') as terminal_audits,
        (select count(*)::integer from audit_events audit
          where audit.resource_id = command.id::text
            and audit.action = 'operations.job_retry.failed') as failed_audits
      from operations_job_retry_commands command
      join jobs job on job.payload = jsonb_build_object('commandId', command.id)
      join operations_job_retry_claims claim on claim.job_id = job.id
      where command.id = $1
    `, [fixture.commandId]);
    expect(synchronized.rows[0]).toEqual({
      command_status: 'denied',
      safe_result_code: 'retry_policy_not_enabled',
      job_status: 'succeeded',
      attempts: 8,
      generation: 9,
      attempt: 8,
      lease_duration_ms: 2_345,
      claim_state: 'invalidated',
      renewed_at: null,
      terminal_audits: 1,
      failed_audits: 0
    });
    for (const candidate of [
      {
        clear: finalClaim.capability,
        owner: 'operations-ceiling-worker-8',
        generation: finalClaim.generation
      },
      { clear: consumedCapability, owner: 'operations-terminal-replay', generation: 9 }
    ]) {
      await expectDatabaseError(
        workerCall(
          candidate.clear,
          'select * from public.plan7a_operations_renew_job_claim($1, $2, 8, $3)',
          [fixture.internalJobId, candidate.owner, candidate.generation]
        ),
        AUTHORITY_ERROR
      );
    }
  }, 20_000);

  it('makes command transitions, terminal audit, job completion, and replay atomic', async () => {
    const fixture = await createRetryFixture();
    const clear = capability();
    await claim(fixture, clear, 'operations-worker-a', 60_000);
    const locked = await workerCall<{
      command_id: string;
      command_status: string;
      result_code: string | null;
      actor_authorized: boolean;
      expected_updated_at: string;
    }>(
      clear,
      `select * from public.plan7a_operations_lock_job_retry_command(
        $1, $2, $3, $4, $5
      )`,
      [fixture.internalJobId, fixture.commandId, 'operations-worker-a', 1, 1]
    );
    expect(locked).toMatchObject([{
      command_id: fixture.commandId,
      command_status: 'pending',
      result_code: null,
      actor_authorized: true,
      expected_updated_at: fixture.targetUpdatedAt
    }]);
    expect(locked[0]!.expected_updated_at).toMatch(CANONICAL_TIMESTAMP);

    const transitioned = await workerCall<{
      command_id: string;
      command_status: string;
      result_code: string;
      completed_at: string;
    }>(
      clear,
      `select * from public.plan7a_operations_transition_job_retry_command(
        $1, $2, $3, $4, $5, 'retry_policy_not_enabled'
      )`,
      [fixture.internalJobId, fixture.commandId, 'operations-worker-a', 1, 1]
    );
    expect(transitioned).toMatchObject([{
      command_id: fixture.commandId,
      command_status: 'denied',
      result_code: 'retry_policy_not_enabled'
    }]);
    expect(transitioned[0]!.completed_at).toMatch(CANONICAL_TIMESTAMP);
    expect(await workerCall(
      clear,
      'select * from public.plan7a_operations_complete_job($1, $2, 1, 1)',
      [fixture.internalJobId, 'operations-worker-a']
    )).toEqual([{ applied: true }]);

    const terminal = await ownerDatabaseClient.pool.query(`
      select command.status, command.safe_result_code,
        job.status as job_status, claim.state as claim_state,
        (select count(*)::integer from audit_events audit
          where audit.resource_id = command.id::text
            and audit.action = 'operations.job_retry.denied') as terminal_audits
      from operations_job_retry_commands command
      join jobs job on job.payload = jsonb_build_object('commandId', command.id)
      join operations_job_retry_claims claim on claim.job_id = job.id
      where command.id = $1
    `, [fixture.commandId]);
    expect(terminal.rows[0]).toEqual({
      status: 'denied',
      safe_result_code: 'retry_policy_not_enabled',
      job_status: 'succeeded',
      claim_state: 'invalidated',
      terminal_audits: 1
    });
    await expectDatabaseError(
      workerCall(
        clear,
        `select * from public.plan7a_operations_transition_job_retry_command(
          $1, $2, $3, 1, 1, 'retry_policy_not_enabled'
        )`,
        [fixture.internalJobId, fixture.commandId, 'operations-worker-a']
      ),
      AUTHORITY_ERROR
    );
    expect((await ownerDatabaseClient.pool.query(
      `select count(*)::integer as count from audit_events
       where resource_id = $1 and action = 'operations.job_retry.denied'`,
      [fixture.commandId]
    )).rows[0]).toEqual({ count: 1 });
  });

  it('rejects immutable command mutations and exact cross-policy terminal outcomes', async () => {
    const fixture = await createRetryFixture();
    await expectDatabaseCode(
      ownerDatabaseClient.pool.query(
        `update operations_job_retry_commands set reason_code = 'operator_reassessment'
         where id = $1`,
        [fixture.commandId]
      ),
      '55000'
    );
    await expectDatabaseCode(
      ownerDatabaseClient.pool.query(
        'delete from operations_job_retry_commands where id = $1',
        [fixture.commandId]
      ),
      '55000'
    );
    const representativeByPolicy = new Map<
      string,
      (typeof JOB_DEFINITIONS)[number]
    >();
    for (const definition of JOB_DEFINITIONS) {
      if (!representativeByPolicy.has(definition.retryPolicyId)) {
        representativeByPolicy.set(definition.retryPolicyId, definition);
      }
    }
    let attemptedForgeries = 0;
    const attemptedPairs = new Set<string>();
    for (const [policyId, definition] of representativeByPolicy) {
      const policyFixture = await createRetryFixtureForKind(
        definition.kind,
        definition.maxAttempts
      );
      const clear = capability();
      await claim(policyFixture, clear);
      const state = async (): Promise<unknown> => (await ownerDatabaseClient.pool.query(`
        select pg_catalog.jsonb_build_object(
          'commandStatus', command.status,
          'resultCode', command.safe_result_code,
          'commandUpdatedAt', command.updated_at,
          'commandCompletedAt', command.completed_at,
          'jobStatus', job.status,
          'jobAttempts', job.attempts,
          'jobLockedBy', job.locked_by,
          'claimState', claim.state,
          'claimGeneration', claim.generation,
          'terminalAudits', (
            select pg_catalog.count(*) from audit_events audit
            where audit.resource_id = command.id::text
              and audit.action in (
                'operations.job_retry.succeeded',
                'operations.job_retry.denied',
                'operations.job_retry.failed'
              )
          )
        ) as snapshot
        from operations_job_retry_commands command
        join jobs job on job.payload = pg_catalog.jsonb_build_object('commandId', command.id)
        join operations_job_retry_claims claim on claim.job_id = job.id
        where command.id = $1
      `, [policyFixture.commandId])).rows[0]!.snapshot;
      const baseline = await state();
      const allowed = new Set(
        JOB_RETRY_POLICY_OUTCOMES
          .filter((outcome) => outcome[0] === policyId)
          .map((outcome) => `${outcome[1]}/${outcome[2]}`)
      );
      const invalidResults = new Set<JobRetryCommandResultCode>();
      for (const resultCode of JOB_RETRY_COMMAND_RESULT_CODES) {
        if (![...allowed].some((entry) => entry.endsWith(`/${resultCode}`))) {
          invalidResults.add(resultCode);
        }
      }
      expect(invalidResults.size, policyId).toBeGreaterThan(0);
      for (const invalidResult of invalidResults) {
        attemptedForgeries += 1;
        attemptedPairs.add(`${policyId}/${invalidResult}`);
        await expectDatabaseError(
          workerCall(
            clear,
            `select * from public.plan7a_operations_transition_job_retry_command(
              $1, $2, 'operations-worker-a', 1, 1,
              $3::operations_job_retry_result_code
            )`,
            [policyFixture.internalJobId, policyFixture.commandId, invalidResult]
          ),
          AUTHORITY_ERROR
        );
        expect(await state(), `${policyId}/${invalidResult}`).toEqual(baseline);
      }
    }
    expect(attemptedForgeries).toBeGreaterThan(3);
    expect(attemptedPairs).toContain('rearm_pending_stripe_event/successor_enqueued');
    expect((await ownerDatabaseClient.pool.query(
      'select status, safe_result_code from operations_job_retry_commands where id = $1',
      [fixture.commandId]
    )).rows[0]).toEqual({ status: 'pending', safe_result_code: null });
  });

  it('accepts the fixed Task 4 canonical string and exact PostgreSQL SHA-256 witnesses', async () => {
    const actorId = await createActor();
    const idempotencyKey = '00000000-0000-4000-8000-000000000202';
    const targetJobId = '00000000-0000-4000-8000-000000000101';
    const expectedUpdatedAt = '2026-08-26T14:15:16.123456Z';
    const canonicalInput = '{"targetJobId":"00000000-0000-4000-8000-000000000101",' +
      '"expectedKind":"commerce.stripe-event","expectedStatus":"failed",' +
      '"expectedAttempts":12,"expectedMaxAttempts":12,' +
      '"expectedUpdatedAt":"2026-08-26T14:15:16.123456Z",' +
      '"reasonCode":"dependency_recovered"}';
    const prepared = prepareJobRetryCommand({
      idempotencyKey,
      targetJobId,
      expectedKind: 'commerce.stripe-event',
      expectedStatus: 'failed',
      expectedAttempts: 12,
      expectedMaxAttempts: 12,
      expectedUpdatedAt,
      reasonCode: 'dependency_recovered'
    });
    expect(prepared).toMatchObject({
      canonicalInput,
      inputFingerprintSha256: 'e6df7201a7ee2edc48002ab36dfafe042c6f45091bb32d97a14fc863bc04bd1e',
      idempotencyKeySha256: '1a4832b559a43c0d8c0d857fadbf9bc1b6325c144e28b0c9f909d84196cd8220'
    });
    const postgresHashes = await ownerDatabaseClient.pool.query<{
      fingerprint: string;
      idempotency: string;
    }>(`
      select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), 'hex')
          as fingerprint,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($2, 'UTF8')), 'hex')
          as idempotency
    `, [canonicalInput, idempotencyKey]);
    expect(postgresHashes.rows[0]).toEqual({
      fingerprint: prepared.inputFingerprintSha256,
      idempotency: prepared.idempotencyKeySha256
    });
    await ownerDatabaseClient.pool.query(
      `insert into jobs (
         id, type, payload, status, run_at, attempts, max_attempts, last_error,
         completed_at, created_at, updated_at
       ) values (
         $1, 'commerce.stripe-event', '{}'::jsonb, 'failed', $2::timestamptz,
         12, 12, 'Stripe event is not pending', $2::timestamptz,
         $2::timestamptz - interval '1 second', $2::timestamptz
       )`,
      [targetJobId, expectedUpdatedAt]
    );
    const submitted = await databaseClient.pool.query<{
      command_id: string;
      target_job_id: string;
      target_kind: string;
    }>(`
      select command_id, target_job_id, target_kind
      from public.submit_job_retry_command(
        $1, $2, 'commerce.stripe-event', 12, 12, $3::timestamptz,
        'dependency_recovered', 'plan7a-fixed-task4', $4, $5
      )
    `, [
      actorId, targetJobId, expectedUpdatedAt,
      prepared.idempotencyKeySha256, prepared.inputFingerprintSha256
    ]);
    expect(submitted.rows[0]).toMatchObject({
      target_job_id: targetJobId,
      target_kind: 'commerce.stripe-event'
    });
    expect((await ownerDatabaseClient.pool.query(
      `select idempotency_key_sha256, input_fingerprint_sha256
       from operations_job_retry_commands where id = $1`,
      [submitted.rows[0]!.command_id]
    )).rows[0]).toEqual({
      idempotency_key_sha256: prepared.idempotencyKeySha256,
      input_fingerprint_sha256: prepared.inputFingerprintSha256
    });
  });

  it('reserves capability-aware failure result codes for settlement routines', async () => {
    const fixture = await createRetryFixtureForKind('commerce.stripe-event', 12);
    const clear = capability();
    await claim(fixture, clear);
    const state = async () => (await ownerDatabaseClient.pool.query(`
      select command.status::text as command_status,
        command.safe_result_code::text as safe_result_code,
        job.status::text as job_status, job.attempts, job.locked_by,
        claim.state::text as claim_state, claim.attempt, claim.generation,
        claim.expires_at,
        (select count(*)::integer from audit_events audit
          where audit.resource_id = command.id::text
            and audit.action in (
              'operations.job_retry.succeeded',
              'operations.job_retry.denied',
              'operations.job_retry.failed'
            )) as terminal_audits
      from operations_job_retry_commands command
      join jobs job on job.payload = jsonb_build_object('commandId', command.id)
      join operations_job_retry_claims claim on claim.job_id = job.id
      where command.id = $1
    `, [fixture.commandId])).rows[0];
    const before = await state();

    await expectDatabaseError(
      workerCall(
        clear,
        `select * from public.plan7a_operations_transition_job_retry_command(
          $1, $2, 'operations-worker-a', 1, 1, 'retry_command_invalid'
        )`,
        [fixture.internalJobId, fixture.commandId]
      ),
      AUTHORITY_ERROR
    );

    expect(await state()).toEqual(before);
    expect(before).toMatchObject({
      command_status: 'pending',
      safe_result_code: null,
      job_status: 'running',
      attempts: 1,
      locked_by: 'operations-worker-a',
      claim_state: 'active',
      attempt: 1,
      generation: 1,
      terminal_audits: 0
    });
  });
});
