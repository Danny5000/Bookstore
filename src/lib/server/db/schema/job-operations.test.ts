import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  JOB_DEFINITIONS,
  JOB_RETRY_POLICY_OUTCOMES,
  REGISTERED_JOB_KINDS
} from '../../jobs/catalog';
import * as schema from './index';

function requiredExport<T>(name: string): T {
  const value = (schema as Record<string, unknown>)[name];
  expect(value, `missing schema export ${name}`).toBeDefined();
  return value as T;
}

function rendered(query: SQL): { readonly sql: string; readonly params: unknown[] } {
  const result = query.toQuery({
    casing: { getColumnCasing: (column: { name: string }) => column.name } as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
  return { sql: result.sql.replaceAll(/\s+/gu, ' '), params: result.params };
}

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
    .replace(/\r\n?/gu, '\n');
}

function checkDefinitions(table: PgTable): ReadonlyMap<string, string> {
  return new Map(getTableConfig(table).checks.map((item) => {
    const definition = rendered(item.value);
    expect(definition.params, item.name).toEqual([]);
    return [item.name, definition.sql];
  }));
}

const RETRY_COMMAND_TABLE = '"operations_job_retry_commands"';
const TARGET_JOB_KIND = `${RETRY_COMMAND_TABLE}."target_job_kind"`;
const COMMAND_STATUS = `${RETRY_COMMAND_TABLE}."status"`;
const SAFE_RESULT_CODE = `${RETRY_COMMAND_TABLE}."safe_result_code"`;

function terminalPair(status: string, resultCode: string): string {
  return `(${COMMAND_STATUS} = '${status}' and ${SAFE_RESULT_CODE} = '${resultCode}')`;
}

function outcomesForPolicy(policyId: string): readonly string[] {
  return JOB_RETRY_POLICY_OUTCOMES
    .filter(([candidatePolicyId]) => candidatePolicyId === policyId)
    .map(([, status, resultCode]) => terminalPair(status, resultCode));
}

function targetPolicyBranch(kind: string, policyId: string): string {
  return `(${TARGET_JOB_KIND} = '${kind}' and (` +
    `${outcomesForPolicy(policyId).join(' or ')}))`;
}

function catalogTargetPolicyBranches(): readonly string[] {
  return JOB_DEFINITIONS.map(({ kind, retryPolicyId }) =>
    targetPolicyBranch(kind, retryPolicyId)
  );
}

function commonTerminalBranches(): readonly string[] {
  return [
    terminalPair('denied', 'actor_not_authorized'),
    terminalPair('failed', 'retry_command_invalid'),
    terminalPair('failed', 'retry_command_exhausted'),
    terminalPair('failed', 'unexpected_failure')
  ];
}

function exactCatalogPolicyMatrix(): string {
  return `(${[...catalogTargetPolicyBranches(), ...commonTerminalBranches()].join(' or ')})`;
}

function canonicalPolicySql(value: string): string {
  return value.replaceAll(/\s+/gu, ' ')
    .replaceAll(/\(\s+/gu, '(')
    .replaceAll(/\s+\)/gu, ')')
    .trim();
}

function policyMatrixBounds(
  lifecycle: string
): { readonly start: number; readonly end: number } | undefined {
  const firstTargetKind = lifecycle.indexOf('target_job_kind"');
  if (firstTargetKind < 0) return undefined;
  const start = lifecycle.lastIndexOf('((', firstTargetKind);
  if (start < 0) return undefined;
  let depth = 0;
  for (let index = start; index < lifecycle.length; index += 1) {
    if (lifecycle[index] === '(') depth += 1;
    if (lifecycle[index] === ')') depth -= 1;
    if (depth === 0) return { start, end: index + 1 };
  }
  return undefined;
}

function hasExactCatalogPolicyMatrix(lifecycle: string): boolean {
  const bounds = policyMatrixBounds(lifecycle);
  if (bounds === undefined) return false;
  const { start, end } = bounds;
  return canonicalPolicySql(lifecycle.slice(start, end)) ===
    canonicalPolicySql(exactCatalogPolicyMatrix());
}

function withPolicyMatrix(lifecycle: string, replacement: string): string {
  const bounds = policyMatrixBounds(lifecycle);
  if (bounds === undefined) throw new Error('catalog policy matrix is missing or unbalanced');
  const { start, end } = bounds;
  return `${lifecycle.slice(0, start)}${replacement}${lifecycle.slice(end)}`;
}

function policyMatrixMutations(lifecycle: string): ReadonlyArray<readonly [string, string]> {
  const globalFamilyOnly = `(${[
    ...new Set(JOB_RETRY_POLICY_OUTCOMES.map(([, status, resultCode]) =>
      terminalPair(status, resultCode)
    )),
    ...commonTerminalBranches()
  ].join(' or ')})`;

  const swappedBranches = [...catalogTargetPolicyBranches()];
  const firstDefinition = JOB_DEFINITIONS[0];
  const enabledDefinition = JOB_DEFINITIONS[3];
  swappedBranches[0] = targetPolicyBranch(
    firstDefinition.kind,
    enabledDefinition.retryPolicyId
  );
  swappedBranches[3] = targetPolicyBranch(
    enabledDefinition.kind,
    firstDefinition.retryPolicyId
  );
  const swappedKindOutcomes = `(${[
    ...swappedBranches,
    ...commonTerminalBranches()
  ].join(' or ')})`;

  const exact = exactCatalogPolicyMatrix();
  const extraTerminalPair = `${exact.slice(0, -1)} or ` +
    `${terminalPair('succeeded', 'successor_enqueued')})`;

  return [
    ['global-family-only outcomes', withPolicyMatrix(lifecycle, globalFamilyOnly)],
    ['swapped target-kind outcomes', withPolicyMatrix(lifecycle, swappedKindOutcomes)],
    ['extra terminal outcome pair', withPolicyMatrix(lifecycle, extraTerminalPair)]
  ];
}

const COMMAND_COLUMNS = [
  'id', 'kind', 'actor_user_id', 'target_job_id', 'target_job_kind',
  'expected_status', 'expected_attempts', 'expected_max_attempts',
  'expected_updated_at', 'reason_code', 'correlation_id',
  'idempotency_key_sha256', 'input_fingerprint_sha256', 'status',
  'safe_result_code', 'created_at', 'updated_at', 'completed_at'
] as const;

const CLAIM_COLUMNS = [
  'job_id', 'command_id', 'generation', 'attempt', 'lease_owner',
  'capability_sha256', 'lease_duration_ms', 'state', 'expires_at',
  'issued_at', 'renewed_at', 'invalidated_at'
] as const;

describe('operations job retry schema declarations', () => {
  it('freezes the exact public retry vocabularies in declaration order', () => {
    expect(requiredExport<{ enumValues: readonly string[] }>(
      'operationsJobRetryCommandStatus'
    ).enumValues).toEqual(['pending', 'succeeded', 'denied', 'failed']);
    expect(requiredExport<{ enumValues: readonly string[] }>(
      'operationsJobRetryResultCode'
    ).enumValues).toEqual([
      'rearmed_existing', 'successor_enqueued', 'already_current',
      'retry_not_supported', 'retry_policy_not_enabled',
      'provider_recovery_not_enabled', 'target_not_failed',
      'target_state_changed', 'domain_state_not_retryable', 'source_unavailable',
      'actor_not_authorized', 'retry_command_invalid', 'retry_command_exhausted',
      'unexpected_failure'
    ]);
    expect(requiredExport<{ enumValues: readonly string[] }>(
      'operationsJobRetryReasonCode'
    ).enumValues).toEqual([
      'dependency_recovered', 'configuration_recovered', 'operator_reassessment'
    ]);
    expect(requiredExport<{ enumValues: readonly string[] }>(
      'operationsJobRetryClaimState'
    ).enumValues).toEqual(['active', 'invalidated']);
  });

  it('declares only the exact minimized command and opaque-claim columns', () => {
    const commands = requiredExport<PgTable>('operationsJobRetryCommands');
    const claims = requiredExport<PgTable>('operationsJobRetryClaims');
    const commandConfig = getTableConfig(commands);
    const claimConfig = getTableConfig(claims);

    expect(commandConfig.name).toBe('operations_job_retry_commands');
    expect(commandConfig.columns.map((column) => column.name)).toEqual(COMMAND_COLUMNS);
    expect(claimConfig.name).toBe('operations_job_retry_claims');
    expect(claimConfig.columns.map((column) => column.name)).toEqual(CLAIM_COLUMNS);
    expect(commandConfig.columns.filter((column) => column.hasDefault)
      .map((column) => column.name)).toEqual([
      'id', 'kind', 'status', 'created_at', 'updated_at'
    ]);
    expect(claimConfig.columns.filter((column) => column.hasDefault)).toEqual([]);

    const allColumns = [...commandConfig.columns, ...claimConfig.columns]
      .map((column) => column.name);
    for (const forbidden of [
      'job_id', 'private_input', 'input', 'reason', 'capability', 'capability_token',
      'provider_evidence', 'provider_payload', 'clear_token'
    ]) {
      if (forbidden === 'job_id') {
        expect(commandConfig.columns.map((column) => column.name)).not.toContain(forbidden);
      } else {
        expect(allColumns).not.toContain(forbidden);
      }
    }
  });

  it('pins every primary key, restrictive foreign key, unique key, index, and check name', () => {
    const commands = requiredExport<PgTable>('operationsJobRetryCommands');
    const claims = requiredExport<PgTable>('operationsJobRetryClaims');
    const commandConfig = getTableConfig(commands);
    const claimConfig = getTableConfig(claims);

    expect(commandConfig.primaryKeys.map((key) => key.getName())).toEqual([
      'plan7a_operations_retry_commands_pkey'
    ]);
    expect(claimConfig.primaryKeys.map((key) => key.getName())).toEqual([
      'plan7a_operations_retry_claims_pkey'
    ]);

    const foreignKeys = [commands, claims].flatMap((table) =>
      getTableConfig(table).foreignKeys.map((key) => {
        const reference = key.reference();
        return {
          name: key.getName(),
          columns: reference.columns.map((column) => column.name),
          foreignTable: getTableConfig(reference.foreignTable).name,
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onUpdate: key.onUpdate,
          onDelete: key.onDelete
        };
      })
    );
    expect(foreignKeys).toEqual([
      {
        name: 'plan7a_operations_retry_commands_actor_fk',
        columns: ['actor_user_id'], foreignTable: 'user', foreignColumns: ['id'],
        onUpdate: 'restrict', onDelete: 'restrict'
      },
      {
        name: 'plan7a_operations_retry_commands_target_job_fk',
        columns: ['target_job_id'], foreignTable: 'jobs', foreignColumns: ['id'],
        onUpdate: 'restrict', onDelete: 'restrict'
      },
      {
        name: 'plan7a_operations_retry_claims_job_fk',
        columns: ['job_id'], foreignTable: 'jobs', foreignColumns: ['id'],
        onUpdate: 'restrict', onDelete: 'restrict'
      },
      {
        name: 'plan7a_operations_retry_claims_command_fk',
        columns: ['command_id'], foreignTable: 'operations_job_retry_commands',
        foreignColumns: ['id'], onUpdate: 'restrict', onDelete: 'restrict'
      }
    ]);

    expect(commandConfig.indexes.map((item) => item.config.name).sort()).toEqual([
      'plan7a_operations_retry_commands_actor_idempotency_unique',
      'plan7a_operations_retry_commands_status_created_idx',
      'plan7a_operations_retry_commands_target_created_idx'
    ]);
    expect(claimConfig.indexes.map((item) => item.config.name)).toEqual([
      'plan7a_operations_retry_claims_command_unique'
    ]);
    expect(commandConfig.checks.map((item) => item.name).sort()).toEqual([
      'plan7a_operations_retry_commands_correlation_canonical',
      'plan7a_operations_retry_commands_expected_state_consistent',
      'plan7a_operations_retry_commands_hashes_sha256',
      'plan7a_operations_retry_commands_kind_fixed',
      'plan7a_operations_retry_commands_lifecycle_consistent',
      'plan7a_operations_retry_commands_target_kind_registered'
    ]);
    expect(claimConfig.checks.map((item) => item.name).sort()).toEqual([
      'plan7a_operations_retry_claims_attempt_positive',
      'plan7a_operations_retry_claims_capability_sha256',
      'plan7a_operations_retry_claims_generation_positive',
      'plan7a_operations_retry_claims_lease_duration_bounded',
      'plan7a_operations_retry_claims_lease_owner_canonical',
      'plan7a_operations_retry_claims_lifecycle_consistent'
    ]);
  });

  it('renders literal, total command predicates tied to the sole job-policy catalog', () => {
    const commands = requiredExport<PgTable>('operationsJobRetryCommands');
    const checks = checkDefinitions(commands);

    expect(checks.get('plan7a_operations_retry_commands_kind_fixed'))
      .toContain("= 'retry_failed_job'");
    const targetKinds = checks.get(
      'plan7a_operations_retry_commands_target_kind_registered'
    )!;
    for (const kind of REGISTERED_JOB_KINDS) expect(targetKinds).toContain(`'${kind}'`);
    expect(targetKinds.match(/'[^']+'/gu)).toHaveLength(REGISTERED_JOB_KINDS.length);

    const expected = checks.get(
      'plan7a_operations_retry_commands_expected_state_consistent'
    )!;
    expect(expected).toContain("expected_status\" = 'failed'");
    expect(expected).toContain('between 1 and');
    expect(expected).toContain('2147483647');
    expect(expected).toContain('pg_catalog.isfinite');

    expect(checks.get('plan7a_operations_retry_commands_correlation_canonical'))
      .toContain("^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$");
    expect(checks.get('plan7a_operations_retry_commands_hashes_sha256'))
      .toContain('^[a-f0-9]{64}$');

    const lifecycle = checks.get(
      'plan7a_operations_retry_commands_lifecycle_consistent'
    )!;
    expect(lifecycle).toContain('pg_catalog.isfinite');
    expect(lifecycle).toContain('created_at" <=');
    expect(lifecycle).toContain('completed_at" = "operations_job_retry_commands"."updated_at');
    expect(lifecycle).toContain(`status" = 'pending'`);
    expect(lifecycle).toContain('safe_result_code" is null');
    expect(hasExactCatalogPolicyMatrix(lifecycle)).toBe(true);
    for (const [mutation, mutatedLifecycle] of policyMatrixMutations(lifecycle)) {
      expect(hasExactCatalogPolicyMatrix(mutatedLifecycle), mutation).toBe(false);
    }
  });

  it('makes every claim predicate finite, bounded, canonical, and state-exact', () => {
    const claims = requiredExport<PgTable>('operationsJobRetryClaims');
    const checks = checkDefinitions(claims);

    expect(checks.get('plan7a_operations_retry_claims_generation_positive'))
      .toContain('between 1 and 2147483647');
    expect(checks.get('plan7a_operations_retry_claims_attempt_positive'))
      .toContain('between 1 and 2147483647');
    expect(checks.get('plan7a_operations_retry_claims_lease_owner_canonical'))
      .toContain('^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$');
    expect(checks.get('plan7a_operations_retry_claims_capability_sha256'))
      .toContain('^[a-f0-9]{64}$');
    expect(checks.get('plan7a_operations_retry_claims_lease_duration_bounded'))
      .toContain('between 1 and 86400000');

    const lifecycle = checks.get('plan7a_operations_retry_claims_lifecycle_consistent')!;
    for (const fragment of [
      'pg_catalog.isfinite', `state" = 'active'`, `state" = 'invalidated'`,
      'invalidated_at" is null', 'invalidated_at" is not null',
      'expires_at" > "operations_job_retry_claims"."issued_at',
      'renewed_at" >= "operations_job_retry_claims"."issued_at',
      'expires_at" > "operations_job_retry_claims"."renewed_at',
      'invalidated_at" >= coalesce(',
      'renewed_at", "operations_job_retry_claims"."issued_at'
    ]) expect(lifecycle).toContain(fragment);
    expect(lifecycle).not.toContain('pg_catalog.coalesce(');
  });

  it('keeps generated migration SQL and snapshot coherent with the declaration', () => {
    const migration = source('../../../../../drizzle/0015_plan7a_operations_authority.sql');
    const snapshot = source('../../../../../drizzle/meta/0015_snapshot.json');
    const snapshotJson = JSON.parse(snapshot) as {
      tables: Record<string, {
        foreignKeys: Record<string, { onDelete: string; onUpdate: string }>;
      }>;
      enums: Record<string, { values: string[] }>;
    };

    expect(snapshotJson.enums['public.operations_job_retry_command_status']?.values)
      .toEqual(['pending', 'succeeded', 'denied', 'failed']);
    expect(snapshotJson.enums['public.operations_job_retry_result_code']?.values).toEqual([
      'rearmed_existing', 'successor_enqueued', 'already_current',
      'retry_not_supported', 'retry_policy_not_enabled',
      'provider_recovery_not_enabled', 'target_not_failed',
      'target_state_changed', 'domain_state_not_retryable', 'source_unavailable',
      'actor_not_authorized', 'retry_command_invalid', 'retry_command_exhausted',
      'unexpected_failure'
    ]);
    expect(snapshotJson.enums['public.operations_job_retry_reason_code']?.values).toEqual([
      'dependency_recovered', 'configuration_recovered', 'operator_reassessment'
    ]);
    expect(snapshotJson.enums['public.operations_job_retry_claim_state']?.values)
      .toEqual(['active', 'invalidated']);

    for (const table of ['operations_job_retry_commands', 'operations_job_retry_claims']) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(snapshot).toContain(`public.${table}`);
    }
    for (const column of [...COMMAND_COLUMNS, ...CLAIM_COLUMNS]) {
      expect(`${migration}\n${snapshot}`).toContain(`"${column}"`);
    }
    for (const name of [
      'plan7a_operations_retry_commands_pkey',
      'plan7a_operations_retry_commands_actor_fk',
      'plan7a_operations_retry_commands_target_job_fk',
      'plan7a_operations_retry_commands_kind_fixed',
      'plan7a_operations_retry_commands_target_kind_registered',
      'plan7a_operations_retry_commands_expected_state_consistent',
      'plan7a_operations_retry_commands_correlation_canonical',
      'plan7a_operations_retry_commands_hashes_sha256',
      'plan7a_operations_retry_commands_lifecycle_consistent',
      'plan7a_operations_retry_commands_actor_idempotency_unique',
      'plan7a_operations_retry_commands_status_created_idx',
      'plan7a_operations_retry_commands_target_created_idx',
      'plan7a_operations_retry_claims_pkey',
      'plan7a_operations_retry_claims_job_fk',
      'plan7a_operations_retry_claims_command_fk',
      'plan7a_operations_retry_claims_generation_positive',
      'plan7a_operations_retry_claims_attempt_positive',
      'plan7a_operations_retry_claims_lease_owner_canonical',
      'plan7a_operations_retry_claims_capability_sha256',
      'plan7a_operations_retry_claims_lease_duration_bounded',
      'plan7a_operations_retry_claims_lifecycle_consistent',
      'plan7a_operations_retry_claims_command_unique'
    ]) {
      expect(migration).toContain(name);
      expect(snapshot).toContain(name);
    }
    expect(migration).not.toMatch(/on delete cascade/iu);
    for (const table of [
      snapshotJson.tables['public.operations_job_retry_commands'],
      snapshotJson.tables['public.operations_job_retry_claims']
    ]) {
      expect(table).toBeDefined();
      for (const foreignKey of Object.values(table!.foreignKeys)) {
        expect(foreignKey).toEqual(expect.objectContaining({
          onDelete: 'restrict',
          onUpdate: 'restrict'
        }));
      }
    }
  });
});
