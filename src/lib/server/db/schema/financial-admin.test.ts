import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from './index';

function requiredExport<T>(name: string): T {
  const value = (schema as Record<string, unknown>)[name];
  expect(value, `missing schema export ${name}`).toBeDefined();
  return value as T;
}

function rendered(query: SQL): string {
  return query.toQuery({
    casing: { getColumnCasing: (column: { name: string }) => column.name } as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  }).sql.replaceAll(/\s+/gu, ' ');
}

describe('financial administrator command schema declarations', () => {
  it('declares the exact command and lifecycle vocabularies', () => {
    const kind = requiredExport<{ enumValues: readonly string[] }>(
      'financialAdminCommandKind'
    );
    const status = requiredExport<{ enumValues: readonly string[] }>(
      'financialAdminCommandStatus'
    );

    expect(kind.enumValues).toEqual([
      'refund_draft_save',
      'refund_draft_discard',
      'refund_allocation_finalize',
      'refund_reporting_correction_create',
      'administrative_recovery_activate',
      'administrative_recovery_deactivate'
    ]);
    expect(status.enumValues).toEqual([
      'pending', 'succeeded', 'denied', 'conflict', 'failed'
    ]);
  });

  it('declares the exact minimized table shape and bounded checks', () => {
    const table = requiredExport<PgTable>('financialAdminCommands');
    const config = getTableConfig(table);

    expect(config.name).toBe('financial_admin_commands');
    expect(config.columns.map((column) => column.name)).toEqual([
      'id', 'kind', 'actor_user_id', 'correlation_id',
      'idempotency_key_sha256', 'input_fingerprint_sha256', 'private_input',
      'job_id', 'status', 'safe_result_code', 'safe_result',
      'created_at', 'updated_at', 'completed_at'
    ]);
    expect(config.indexes.map((item) => item.config.name).sort()).toEqual([
      'financial_admin_commands_actor_idempotency_unique',
      'financial_admin_commands_job_unique',
      'financial_admin_commands_status_created_idx'
    ]);
    expect(config.checks.map((item) => item.name).sort()).toEqual([
      'financial_admin_commands_correlation_canonical',
      'financial_admin_commands_hashes_sha256',
      'financial_admin_commands_input_bounded_object',
      'financial_admin_commands_input_kind_consistent',
      'financial_admin_commands_lifecycle_consistent',
      'financial_admin_commands_result_bounded_object'
    ]);
  });

  it('rejects every malformed kind-specific private input at the table boundary', () => {
    const table = requiredExport<PgTable>('financialAdminCommands');
    const input = getTableConfig(table).checks.find(
      (item) => item.name === 'financial_admin_commands_input_kind_consistent'
    );
    expect(input).toBeDefined();
    const definition = rendered(input!.value);

    for (const kind of [
      'refund_draft_save', 'refund_draft_discard',
      'refund_allocation_finalize', 'refund_reporting_correction_create',
      'administrative_recovery_activate', 'administrative_recovery_deactivate'
    ]) expect(definition).toContain(kind);
    for (const key of [
      'kind', 'refundId', 'expectedVersion', 'items', 'orderItemId',
      'totalPresentmentMinor', 'expectedActiveDraftVersion', 'previewFingerprint',
      'confirmation', 'reason', 'expectedNextCorrectionVersion',
      'expectedBaseAllocationSetId', 'expectedSourceFingerprint',
      'finalizationEffectId', 'expectedCorrectionSetId', 'expectedCorrectionVersion',
      'recoveryGrantId', 'recoveryReferenceId', 'expectedStateChangedAt'
    ]) expect(definition).toContain(key);
    expect(definition).toContain('2147483647');
    expect(definition).toContain('99999999');
    expect(definition).toContain('between 1 and 25');
    expect(definition).toContain('-> 24');
    expect(definition).toContain('is distinct from');
    expect(definition).toContain(
      "case when pg_catalog.jsonb_typeof(\"financial_admin_commands\".\"private_input\") = 'object'"
    );
    expect(definition).toContain(
      '("financial_admin_commands"."private_input" -> \'items\' -> 0) - \'orderItemId\''
    );
    expect(definition).toMatch(
      /case when pg_catalog\.jsonb_typeof\([^)]*items[^)]*\) = 'array'/u
    );
    expect(definition).toMatch(
      /case when pg_catalog\.jsonb_typeof\([^)]*items[^)]*-> 0\) = 'object'/u
    );
    expect(definition).toContain('pg_catalog.pg_input_is_valid');
    expect(definition).not.toMatch(/\bselect\b/iu);
    expect(definition).toMatch(/\) is true$/u);
  });

  it('keeps actor deletion restrictive and leaves the job relationship for the deferred migration FK', () => {
    const table = requiredExport<PgTable>('financialAdminCommands');
    const config = getTableConfig(table);
    const references = config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        foreignTable: getTableConfig(reference.foreignTable).name,
        foreignColumns: reference.foreignColumns.map((column) => column.name),
        onDelete: foreignKey.onDelete
      };
    });

    expect(references).toEqual([{
      columns: ['actor_user_id'],
      foreignTable: 'user',
      foreignColumns: ['id'],
      onDelete: 'restrict'
    }]);
    expect(config.columns.find((column) => column.name === 'job_id')?.notNull).toBe(true);
  });

  it('ties each success code to one exact bounded safe-result object', () => {
    const table = requiredExport<PgTable>('financialAdminCommands');
    const lifecycle = getTableConfig(table).checks.find(
      (item) => item.name === 'financial_admin_commands_lifecycle_consistent'
    );
    expect(lifecycle).toBeDefined();
    const definition = rendered(lifecycle!.value);

    for (const key of [
      'refundId', 'draftVersion', 'changed', 'finalizedDraftVersion',
      'accessChanged', 'emailQueued', 'correctionSetId', 'correctionVersion',
      'recoveryGrantId'
    ]) expect(definition).toContain(key);
    expect(definition).toContain('2147483647');
    expect(definition).toContain("pg_catalog.jsonb_typeof");
    expect(definition).toContain(
      "case when pg_catalog.jsonb_typeof(\"financial_admin_commands\".\"safe_result\") = 'object'"
    );
    expect(definition).toContain("pg_catalog.pg_input_is_valid");
    expect(definition).toContain('?&');
    expect(definition).toContain('pg_catalog.isfinite');
    expect(definition).toContain('updated_at" >= "financial_admin_commands"."created_at');
    expect(definition).toContain('completed_at" >= "financial_admin_commands"."updated_at');
    expect(definition.startsWith('(')).toBe(true);
    expect(definition).toMatch(/\) is true$/u);
  });

  it('declares one owner-private per-job capability digest without a clear-token column', () => {
    const table = requiredExport<PgTable>('financialAdminJobClaims');
    const config = getTableConfig(table);

    expect(config.name).toBe('financial_admin_job_claims');
    expect(config.columns.map((column) => column.name)).toEqual([
      'job_id', 'generation', 'attempt', 'capability_sha256',
      'lease_duration_ms', 'state', 'expires_at', 'issued_at',
      'renewed_at', 'invalidated_at'
    ]);
    expect(config.columns.map((column) => column.name)).not.toContain('capability_token');
    expect(config.checks.map((item) => item.name).sort()).toEqual([
      'financial_admin_job_claims_attempt_positive',
      'financial_admin_job_claims_capability_sha256_valid',
      'financial_admin_job_claims_generation_positive',
      'financial_admin_job_claims_lease_duration_bounded',
      'financial_admin_job_claims_lifecycle_consistent'
    ]);

    const references = config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        foreignTable: getTableConfig(reference.foreignTable).name,
        foreignColumns: reference.foreignColumns.map((column) => column.name),
        onUpdate: foreignKey.onUpdate,
        onDelete: foreignKey.onDelete
      };
    });
    expect(references).toEqual([{
      columns: ['job_id'],
      foreignTable: 'jobs',
      foreignColumns: ['id'],
      onUpdate: 'restrict',
      onDelete: 'restrict'
    }]);
  });

  it('makes every private-claim predicate total, bounded, and state exact', () => {
    const table = requiredExport<PgTable>('financialAdminJobClaims');
    const checks = new Map(
      getTableConfig(table).checks.map((item) => [item.name, rendered(item.value)])
    );

    expect(checks.get('financial_admin_job_claims_generation_positive'))
      .toContain('between 1 and 2147483647');
    expect(checks.get('financial_admin_job_claims_attempt_positive'))
      .toContain('between 1 and 2147483647');
    expect(checks.get('financial_admin_job_claims_capability_sha256_valid'))
      .toContain("^[a-f0-9]{64}$");
    expect(checks.get('financial_admin_job_claims_lease_duration_bounded'))
      .toContain('between 1 and 86400000');
    for (const definition of checks.values()) expect(definition).toMatch(/is true\)?$/u);

    const lifecycle = checks.get('financial_admin_job_claims_lifecycle_consistent');
    expect(lifecycle).toContain('state" = \'active\'');
    expect(lifecycle).toContain('state" = \'invalidated\'');
    expect(lifecycle).toContain('invalidated_at" is null');
    expect(lifecycle).toContain('invalidated_at" is not null');
  });
});
