import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[restore-verifier] ${name} is required`);
  return value;
}

const arguments_ = process.argv.slice(2);
const supportedArguments = new Set([
  '--seed-missing-credential-authority',
  '--exercise-financial-invariant-witnesses',
  '--print-financial-catalog-contract'
]);
if (
  arguments_.length > 1 ||
  (arguments_.length === 1 && !supportedArguments.has(arguments_[0]!))
) {
  throw new Error('[restore-verifier] unsupported command-line arguments');
}

const databaseHost = requiredEnvironment('DATABASE_HOST');
const databaseName = requiredEnvironment('DATABASE_NAME');
const databaseUser = requiredEnvironment('DATABASE_USER');
if (
  requiredEnvironment('APP_ENV') !== 'test' ||
  !['127.0.0.1', '::1', 'localhost'].includes(databaseHost.toLowerCase()) ||
  databaseName !== 'pale_orbit_test' ||
  databaseUser !== 'pale_orbit_test'
) {
  throw new Error('[restore-verifier] refusing a non-disposable test database');
}

const databasePort = requiredEnvironment('DATABASE_PORT');
const port = Number(databasePort);
if (!/^\d+$/u.test(databasePort) || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('[restore-verifier] DATABASE_PORT is invalid');
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const verifierPath = fileURLToPath(
  new URL('./verify-financial-restore.sql', import.meta.url)
);
const workerAuthorityMigrationPath = fileURLToPath(
  new URL('../drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql', import.meta.url)
);
const [verifier, workerAuthorityMigration] = await Promise.all([
  readFile(verifierPath, 'utf8'),
  readFile(workerAuthorityMigrationPath, 'utf8')
]);
const verifierLines = verifier.split(/\r?\n/u);
const allowedMetaCommands = ['\\set ON_ERROR_STOP on', '\\set QUIET on'];
const metaCommands = verifierLines
  .filter((line) => /^\s*\\/u.test(line))
  .map((line) => line.trimStart());
if (
  metaCommands.length !== allowedMetaCommands.length ||
  metaCommands.some((command, index) => command !== allowedMetaCommands[index])
) {
  throw new Error('[restore-verifier] unsafe psql meta-command');
}
const executableSql = verifierLines
  .filter((line) => !/^\s*\\/u.test(line))
  .join('\n');
const seedMissingCredentialAuthority = arguments_[0] === '--seed-missing-credential-authority';
const exerciseFinancialInvariantWitnesses =
  arguments_[0] === '--exercise-financial-invariant-witnesses';
const printFinancialCatalogContract =
  arguments_[0] === '--print-financial-catalog-contract';

const financialCatalogManifestBegin = '-- BEGIN financial_schema_object_manifest';
const financialCatalogManifestEnd = '-- END financial_schema_object_manifest';
const financialFailureFormatterStart = 'do $restore_verifier$';

function uniqueBoundary(source: string, marker: string): number {
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`[restore-verifier] expected one ${marker} boundary`);
  }
  return first;
}

function requiredMigrationCheckConstraintStatement(constraintName: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(constraintName)) {
    throw new Error('[restore-verifier] unsafe migration constraint name');
  }
  const prefix =
    `ALTER TABLE "financial_reconciliation_issues" ADD CONSTRAINT "${constraintName}" CHECK (`;
  const start = workerAuthorityMigration.indexOf(prefix);
  const endMarker = ';--> statement-breakpoint';
  const end = workerAuthorityMigration.indexOf(endMarker, start);
  if (
    start < 0 ||
    end < 0 ||
    workerAuthorityMigration.indexOf(prefix, start + prefix.length) >= 0
  ) {
    throw new Error(`[restore-verifier] expected one canonical ${constraintName} statement`);
  }
  const statement = workerAuthorityMigration.slice(start, end);
  if (!statement.endsWith(')') || statement.includes(';')) {
    throw new Error(`[restore-verifier] unsafe canonical ${constraintName} statement`);
  }
  return statement;
}

const semanticIdentityConstraintStatement = requiredMigrationCheckConstraintStatement(
  'financial_reconciliation_issues_semantic_identity'
);
const semanticImpactConstraintStatement = requiredMigrationCheckConstraintStatement(
  'financial_reconciliation_issues_semantic_impact'
);

const catalogManifestBegin = uniqueBoundary(executableSql, financialCatalogManifestBegin);
const catalogManifestEnd = uniqueBoundary(executableSql, financialCatalogManifestEnd);
const failureFormatterStart = uniqueBoundary(executableSql, financialFailureFormatterStart);
if (
  catalogManifestBegin >= catalogManifestEnd ||
  catalogManifestEnd >= failureFormatterStart
) {
  throw new Error('[restore-verifier] financial catalog SQL boundaries are out of order');
}
const catalogManifestEndOffset = catalogManifestEnd + financialCatalogManifestEnd.length;
const verifierPrelude = executableSql.slice(0, catalogManifestBegin);
const catalogManifestSql = executableSql.slice(
  catalogManifestBegin,
  catalogManifestEndOffset
);
const verifierFailureFormatterSql = executableSql.slice(failureFormatterStart);
const zeroOperationalDiagnosticsSql = `
insert into restore_financial_checks (check_name, violation_count) values
  ('failed_running_scan_permanent', 0),
  ('failed_running_scan_retry_exhausted', 0),
  ('pending_replay_child_incomplete', 0),
  ('pending_replay_child_permanent', 0),
  ('pending_replay_child_retry_exhausted', 0);
`;
const zeroCatalogChecksSql = `
insert into restore_financial_checks (check_name, violation_count) values
  ('financial_schema_object_manifest', 0),
  ('storage_cleanup_effective_authority', 0);
`;
const catalogOnlyVerifierSql = [
  verifierPrelude,
  catalogManifestSql,
  zeroOperationalDiagnosticsSql,
  verifierFailureFormatterSql
].join('\n');
const dataOnlyVerifierSql = [
  verifierPrelude,
  zeroCatalogChecksSql,
  executableSql.slice(catalogManifestEndOffset)
].join('\n');

type VerifierScope = 'catalog' | 'data' | 'full';

const verifierSqlByScope: Readonly<Record<VerifierScope, string>> = {
  catalog: catalogOnlyVerifierSql,
  data: dataOnlyVerifierSql,
  full: executableSql
};

for (const [scope, sql] of Object.entries(verifierSqlByScope)) {
  if (
    !sql.includes(financialFailureFormatterStart) ||
    !sql.includes('failed_running_scan_permanent') ||
    !sql.trimEnd().endsWith('rollback;')
  ) {
    throw new Error(`[restore-verifier] ${scope} verifier lost its failure contract`);
  }
}
if (
  !catalogOnlyVerifierSql.includes("'financial_schema_object_manifest'") ||
  !catalogOnlyVerifierSql.includes("'storage_cleanup_effective_authority'") ||
  dataOnlyVerifierSql.includes(financialCatalogManifestBegin)
) {
  throw new Error('[restore-verifier] financial catalog verifier split is invalid');
}

const databaseConfiguration = {
  host: databaseHost,
  port,
  database: databaseName,
  user: databaseUser,
  password: requiredEnvironment('DATABASE_PASSWORD'),
  max: 1,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  application_name: 'pale-orbit-restore-verifier-witness'
} as const;
const pool = new Pool(databaseConfiguration);
const verifierPool = new Pool({
  ...databaseConfiguration,
  application_name: 'pale-orbit-restore-verifier-execution'
});
let verifierClient: PoolClient | null = null;
let verifierExpectationCount = 0;

// Each verifier transaction uses READ COMMITTED and ends with rollback, so the persistent
// session sees committed witness mutations from the separate fixture pool on its next check.
async function persistentVerifierClient(): Promise<PoolClient> {
  verifierClient ??= await verifierPool.connect();
  return verifierClient;
}

interface VerifierOutcome {
  readonly error: Error | null;
  readonly rows: readonly Record<string, unknown>[];
}

async function verifierOutcome(
  expectationName: string,
  scope: VerifierScope
): Promise<VerifierOutcome> {
  verifierExpectationCount += 1;
  const expectationNumber = verifierExpectationCount;
  const startedAt = Date.now();
  console.info(
    `[restore-verifier] BEGIN expectation ${expectationNumber} [${scope}] ${expectationName}`
  );
  let client: PoolClient | null = null;
  let outcome: VerifierOutcome;
  try {
    client = await persistentVerifierClient();
    const result = await client.query(verifierSqlByScope[scope]);
    const results = Array.isArray(result) ? result : [result];
    outcome = {
      error: null,
      rows: results.flatMap((entry) => entry.rows as Record<string, unknown>[])
    };
  } catch (error) {
    outcome = {
      error: error instanceof Error ? error : new Error(String(error)),
      rows: []
    };
  }

  if (client) {
    try {
      if (outcome.error) await client.query('rollback');
      await client.query('drop table if exists pg_temp.restore_financial_checks');
    } catch (recoveryError) {
      if (verifierClient === client) verifierClient = null;
      client.release(true);
      outcome = {
        error: new Error(
          `[restore-verifier] verifier session recovery failed after ${expectationName}: ${
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          }`
        ),
        rows: []
      };
    }
  }

  console.info(
    `[restore-verifier] END expectation ${expectationNumber} [${scope}] ${
      Date.now() - startedAt
    }ms ${outcome.error ? 'rejected' : 'passed'}`
  );
  return outcome;
}

function financialCatalogContractSql(): string {
  const contractStart = executableSql.indexOf('with catalog_contract_version');
  const contractEndMarker = '\n), duplicate_contract_objects as (';
  const contractEnd = executableSql.indexOf(contractEndMarker, contractStart);
  if (contractStart < 0 || contractEnd < 0) {
    throw new Error('[restore-verifier] exact catalog contract CTE boundary is missing');
  }
  return `${executableSql.slice(contractStart, contractEnd)}
)`;
}

function financialCatalogCalibrationSql(): string {
  return `${financialCatalogContractSql()}
select required.object_kind, required.schema_name, required.parent_name,
  required.object_name, required.identity_arguments,
  actual.actual_catalog::text as actual_catalog_json
from required_catalog_objects required
left join actual_catalog_objects actual
  on actual.object_kind = required.object_kind
 and actual.schema_name = required.schema_name
 and actual.parent_name is not distinct from required.parent_name
 and actual.object_name = required.object_name
 and actual.identity_arguments is not distinct from required.identity_arguments
order by required.object_kind collate "C", required.schema_name collate "C",
  required.parent_name collate "C" nulls first,
  required.object_name collate "C",
  required.identity_arguments collate "C" nulls first`;
}

interface CatalogCalibrationRow {
  readonly actual_catalog_json: string | null;
  readonly identity_arguments: string | null;
  readonly object_kind: string;
  readonly object_name: string;
  readonly parent_name: string | null;
  readonly schema_name: string;
}

async function printCatalogContractCalibration(): Promise<void> {
  const result = await pool.query<CatalogCalibrationRow>(financialCatalogCalibrationSql());
  const seenKeys = new Set<string>();
  const contract = result.rows.map((row) => {
    const key = JSON.stringify([
      row.object_kind,
      row.schema_name,
      row.parent_name,
      row.object_name,
      row.identity_arguments
    ]);
    if (seenKeys.has(key)) {
      throw new Error(`[restore-verifier] duplicate calibrated catalog object ${key}`);
    }
    seenKeys.add(key);
    if (typeof row.actual_catalog_json !== 'string') {
      throw new Error(`[restore-verifier] missing calibrated catalog object ${key}`);
    }
    if (row.actual_catalog_json.includes('$catalog$')) {
      throw new Error(`[restore-verifier] unsafe catalog delimiter in ${key}`);
    }
    return {
      objectKind: row.object_kind,
      schemaName: row.schema_name,
      parentName: row.parent_name,
      objectName: row.object_name,
      identityArguments: row.identity_arguments,
      fingerprintSha256: createHash('sha256')
        .update(row.actual_catalog_json, 'utf8')
        .digest('hex'),
      catalogJson: row.actual_catalog_json
    };
  });
  console.info('[restore-verifier] BEGIN exact financial catalog calibration JSON');
  console.info(JSON.stringify(contract, null, 2));
  console.info('[restore-verifier] END exact financial catalog calibration JSON');
}

async function exerciseInvariantWitnesses(): Promise<void> {
  const failures: string[] = [];
  let verifierScope: VerifierScope = 'catalog';
  const operationalCheckNames = [
    'failed_running_scan_permanent',
    'failed_running_scan_retry_exhausted',
    'pending_replay_child_incomplete',
    'pending_replay_child_permanent',
    'pending_replay_child_retry_exhausted'
  ] as const;
  const validateOperationalShape = (name: string, outcome: VerifierOutcome): boolean => {
    if (outcome.rows.length !== operationalCheckNames.length) {
      failures.push(`${name} returned an invalid operational diagnostic row count`);
      return false;
    }
    for (const [index, checkName] of operationalCheckNames.entries()) {
      const row = outcome.rows[index];
      if (
        row?.check_name !== checkName ||
        !/^(?:0|[1-9][0-9]*)$/u.test(String(row.violation_count))
      ) {
        failures.push(`${name} returned an invalid operational diagnostic contract`);
        return false;
      }
    }
    return true;
  };
  const expectPass = async (
    name: string,
    expectAllZero = false,
    scope = verifierScope
  ) => {
    const outcome = await verifierOutcome(name, scope);
    if (outcome.error) {
      failures.push(`${name} unexpectedly failed: ${outcome.error.message}`);
      return;
    }
    if (!validateOperationalShape(name, outcome)) return;
    if (expectAllZero && outcome.rows.some((row) => row.violation_count !== '0')) {
      failures.push(`${name} returned a nonzero operational diagnostic`);
    }
  };
  const expectRejection = async (
    name: string,
    checkName: string,
    scope = verifierScope
  ) => {
    const { error } = await verifierOutcome(name, scope);
    if (!error) failures.push(`${name} unexpectedly passed`);
    else if (!error.message.includes(checkName)) {
      failures.push(`${name} failed without ${checkName}: ${error.message}`);
    }
  };
  const expectRejectionChecks = async (
    name: string,
    checkNames: readonly string[],
    scope = verifierScope
  ) => {
    const { error } = await verifierOutcome(name, scope);
    if (!error) {
      failures.push(`${name} unexpectedly passed`);
      return;
    }
    for (const checkName of checkNames) {
      if (!error.message.includes(checkName)) {
        failures.push(`${name} failed without ${checkName}: ${error.message}`);
      }
    }
  };
  const expectDiagnostics = async (
    name: string,
    checkNames: readonly string[],
    scope = verifierScope
  ) => {
    const outcome = await verifierOutcome(name, scope);
    if (outcome.error) {
      failures.push(`${name} unexpectedly failed: ${outcome.error.message}`);
      return;
    }
    if (!validateOperationalShape(name, outcome)) return;
    for (const checkName of checkNames) {
      const diagnostic = outcome.rows.find((row) =>
        row.check_name === checkName && Number(row.violation_count) > 0
      );
      if (!diagnostic) failures.push(`${name} did not surface ${checkName}`);
    }
  };
  const mutateAppendOnlyFixture = async (
    query: string,
    parameters: readonly unknown[]
  ): Promise<void> => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(query, [...parameters]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };
  const requiredCatalogDefinition = async (
    witnessName: string,
    query: string,
    parameters: readonly unknown[] = []
  ): Promise<string> => {
    const result = await pool.query<{ definition: string }>(query, [...parameters]);
    const definition = result.rows[0]?.definition;
    if (result.rows.length !== 1 || typeof definition !== 'string' || definition.trim() === '') {
      throw new Error(`[restore-verifier] missing ${witnessName} catalog definition`);
    }
    return definition;
  };
  const insertDisputeEffect = async (input: {
    readonly allocationId: string;
    readonly disputeId: string;
    readonly effect: 'withdrawal' | 'reinstatement';
    readonly financialItemId: string;
    readonly fingerprintCharacter: string;
    readonly orderItemId: string;
    readonly providerCreatedAt: string;
    readonly providerId: string;
    readonly reversalOfSetId: string | null;
    readonly reversesAllocationId: string | null;
    readonly setId: string;
    readonly signedSubtotalMinor: number;
    readonly stripeDisputeId: string;
    readonly transactionId: string;
  }) => {
    const fingerprint = input.fingerprintCharacter.repeat(64);
    const classification = input.effect === 'withdrawal'
      ? 'dispute_withdrawal'
      : 'dispute_reinstatement';
    const component = input.effect === 'withdrawal'
      ? 'dispute_subtotal'
      : 'dispute_reinstatement';
    await pool.query(`
      insert into stripe_balance_transactions (
        id, provider_id, live_mode, source_family, source_id, raw_type,
        reporting_category, balance_type, amount_minor, fee_minor, net_minor,
        currency, status, provider_created_at, available_at, fingerprint_sha256
      ) values (
        $1, $2, false, 'dispute', $3, 'adjustment', $4, 'payments', $5, 0, $5,
        'USD', 'available', $6, $6, $7
      )
    `, [
      input.transactionId,
      input.providerId,
      input.stripeDisputeId,
      input.effect === 'withdrawal' ? 'dispute' : 'dispute_reversal',
      input.signedSubtotalMinor,
      input.providerCreatedAt,
      fingerprint
    ]);
    await pool.query(`
      insert into financial_classification_versions (
        subject_type, subject_id, classifier_version, classification,
        source_fingerprint_sha256
      ) values ('balance_transaction', $1, 1, $2, $3)
    `, [input.transactionId, classification, fingerprint]);
    await pool.query(`
      insert into financial_allocation_sets (
        id, allocation_identity, balance_transaction_id, source_kind,
        source_internal_id, basis, scope, expected_effect_minor, currency,
        algorithm_version, classifier_version, source_fingerprint_sha256,
        reversal_of_set_id
      ) values (
        $1, $2, $3, 'dispute', $4, 'gross_amount', 'title', $5, 'USD',
        1, 1, $6, $7
      )
    `, [
      input.setId,
      `restore:${input.setId}`,
      input.transactionId,
      input.disputeId,
      input.signedSubtotalMinor,
      fingerprint,
      input.reversalOfSetId
    ]);
    await pool.query(`
      insert into financial_item_allocations (
        id, allocation_set_id, order_item_id, component, effect_minor, currency,
        tie_break_key
      ) values ($1, $2, $3, $4, $5, 'USD', $6)
    `, [
      input.financialItemId,
      input.setId,
      input.orderItemId,
      component,
      input.signedSubtotalMinor,
      `${input.allocationId}:settlement`
    ]);
    await pool.query(`
      insert into dispute_item_allocations (
        id, allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
        effect, reverses_allocation_id, subtotal_effect_minor, tax_effect_minor,
        total_effect_minor, currency
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, 0, $8, 'USD')
    `, [
      input.allocationId,
      `restore:${input.allocationId}`,
      input.disputeId,
      input.setId,
      input.orderItemId,
      input.effect,
      input.reversesAllocationId,
      input.signedSubtotalMinor
    ]);
  };

  await expectPass('fresh financial schema-object manifest', true, 'full');

  const projectionHeadsViewDefinition = await requiredCatalogDefinition(
    'required view',
    `
      select pg_catalog.pg_get_viewdef('public.current_financial_projection_heads'::regclass, false)
      as definition
    `
  );
  const executableProjectionHeadsViewDefinition = projectionHeadsViewDefinition
    .trim()
    .replace(/;$/u, '');
  if (executableProjectionHeadsViewDefinition.includes(';')) {
    throw new Error('[restore-verifier] unsafe required view catalog definition');
  }
  await pool.query(`
    create or replace view public.current_financial_projection_heads as
    select original.*
    from (${executableProjectionHeadsViewDefinition}) original
    where false
  `);
  await expectRejection(
    'column-compatible false required view',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    create or replace view public.current_financial_projection_heads as
    ${executableProjectionHeadsViewDefinition}
  `);
  await expectPass('required view definition repair', true);

  const rejectHistoryFunctionDefinition = await requiredCatalogDefinition(
    'required function',
    `
      select pg_catalog.pg_get_functiondef(
        'public.plan6b_reject_history_mutation()'::regprocedure
      ) as definition
    `
  );
  await pool.query(`
    create or replace function public.plan6b_reject_history_mutation()
    returns trigger
    language plpgsql
    as $catalog_witness$
    begin
      return new;
    end;
    $catalog_witness$
  `);
  await expectRejection(
    'required function definition mismatch',
    'financial_schema_object_manifest=1'
  );
  await pool.query(rejectHistoryFunctionDefinition);
  await expectPass('required function definition repair', true);

  await pool.query(`
    create function public.plan6b_reject_history_mutation(value integer)
    returns integer
    language sql
    immutable
    as 'select $1'
  `);
  await expectRejection(
    'unexpected protected function overload',
    'financial_schema_object_manifest=1'
  );
  await pool.query('drop function public.plan6b_reject_history_mutation(integer)');
  await expectPass('unexpected protected function overload repair', true);

  const payoutTransitionTriggerDefinition = await requiredCatalogDefinition(
    'required trigger',
    `
      select pg_catalog.pg_get_triggerdef(trigger_row.oid, false) as definition
      from pg_catalog.pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.stripe_payouts'::regclass
        and trigger_row.tgname = 'stripe_payouts_narrow_update'
        and not trigger_row.tgisinternal
    `
  );
  await pool.query('drop trigger stripe_payouts_narrow_update on stripe_payouts');
  await expectRejection(
    'missing financial transition trigger',
    'financial_schema_object_manifest=2'
  );
  await pool.query(payoutTransitionTriggerDefinition);
  await expectPass('financial transition trigger repair', true);

  await pool.query('drop trigger stripe_payouts_narrow_update on stripe_payouts');
  await pool.query(`
    create trigger stripe_payouts_narrow_update
    before update on stripe_payouts
    for each row execute function plan6b_validate_payout_transition()
  `);
  await expectRejection(
    'required trigger definition mismatch',
    'financial_schema_object_manifest=2'
  );
  await pool.query('drop trigger stripe_payouts_narrow_update on stripe_payouts');
  await pool.query(payoutTransitionTriggerDefinition);
  await expectPass('required trigger definition repair', true);

  const payoutStatusIndexDefinition = await requiredCatalogDefinition(
    'required index',
    `
      select pg_catalog.pg_get_indexdef('public.stripe_payouts_status_created_idx'::regclass)
        as definition
    `
  );
  await pool.query('drop index stripe_payouts_status_created_idx');
  await expectRejection(
    'missing financial lookup index',
    'financial_schema_object_manifest=2'
  );
  await pool.query(payoutStatusIndexDefinition);
  await expectPass('financial lookup index repair', true);

  await pool.query('drop index stripe_payouts_status_created_idx');
  await pool.query(`
    create index stripe_payouts_status_created_idx
    on stripe_payouts using btree (id)
  `);
  await expectRejection(
    'required index definition mismatch',
    'financial_schema_object_manifest=2'
  );
  await pool.query('drop index stripe_payouts_status_created_idx');
  await pool.query(payoutStatusIndexDefinition);
  await expectPass('required index definition repair', true);

  const omittedIssueConstraintNames = [
    'financial_reconciliation_issues_occurrence_positive',
    'financial_reconciliation_issues_resolution_consistent',
    'financial_reconciliation_issues_safe_vocabulary',
    'financial_reconciliation_issues_observation_order'
  ] as const;
  for (const constraintName of omittedIssueConstraintNames) {
    const constraintDefinition = await requiredCatalogDefinition(
      constraintName,
      `
        select pg_catalog.pg_get_constraintdef(constraint_row.oid, false) as definition
        from pg_catalog.pg_constraint constraint_row
        where constraint_row.conrelid = 'public.financial_reconciliation_issues'::regclass
          and constraint_row.conname = $1
          and constraint_row.contype = 'c'
      `,
      [constraintName]
    );
    if (!/^CHECK \([\s\S]+\)$/u.test(constraintDefinition) || constraintDefinition.includes(';')) {
      throw new Error(`[restore-verifier] unsafe ${constraintName} catalog definition`);
    }
    await pool.query(`
      alter table financial_reconciliation_issues drop constraint "${constraintName}"
    `);
    await pool.query(`
      alter table financial_reconciliation_issues
      add constraint "${constraintName}" check (true)
    `);
    await expectRejection(
      `omitted financial issue constraint definition mismatch (${constraintName})`,
      'financial_schema_object_manifest=2'
    );
    await pool.query(`
      alter table financial_reconciliation_issues drop constraint "${constraintName}"
    `);
    await pool.query(`
      alter table financial_reconciliation_issues
      add constraint "${constraintName}" ${constraintDefinition}
    `);
    await expectPass(
      `omitted financial issue constraint definition repair (${constraintName})`,
      true
    );
  }

  const claimAuthorizationFunctionDefinition = await requiredCatalogDefinition(
    'claim authorization function',
    `
      select pg_catalog.pg_get_functiondef(
        'public.authorize_commerce_claim_issuance(text,text)'::regprocedure
      ) as definition
    `
  );
  await pool.query(`
    create or replace function public.authorize_commerce_claim_issuance(
      p_raw_claim_proof text,
      p_raw_auth_token text
    ) returns boolean
    language plpgsql
    security definer
    set search_path = 'pg_catalog'
    as $catalog_witness$
    begin
      return false;
    end;
    $catalog_witness$
  `);
  await expectRejection(
    'claim function definition mismatch',
    'financial_schema_object_manifest=1'
  );
  await pool.query(claimAuthorizationFunctionDefinition);
  await expectPass('claim function definition repair', true);

  await pool.query(`
    grant execute on function public.authorize_commerce_claim_issuance(text, text)
    to public
  `);
  await expectRejection(
    'claim function direct ACL mismatch',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    revoke execute on function public.authorize_commerce_claim_issuance(text, text)
    from public
  `);
  await expectPass('claim function direct ACL repair', true);

  await pool.query(`
    grant connect on database "${databaseName}" to pale_orbit_runtime with grant option
  `);
  await expectRejection(
    'database fixed-group CONNECT grant option mismatch',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    revoke grant option for connect on database "${databaseName}" from pale_orbit_runtime
  `);
  await expectPass('database fixed-group CONNECT grant option repair', true);

  await pool.query(`
    grant temporary on database "${databaseName}" to pale_orbit_financial_worker
  `);
  await expectRejection(
    'unexpected fixed-group database TEMPORARY ACL',
    'financial_schema_object_manifest=2'
  );
  await pool.query(`
    revoke temporary on database "${databaseName}" from pale_orbit_financial_worker
  `);
  await expectPass('unexpected fixed-group database TEMPORARY ACL repair', true);

  await pool.query(`
    create function public.authorize_commerce_claim_issuance(value integer)
    returns boolean
    language sql
    immutable
    as 'select false'
  `);
  await expectRejection(
    'unexpected claim function overload',
    'financial_schema_object_manifest=1'
  );
  await pool.query('drop function public.authorize_commerce_claim_issuance(integer)');
  await expectPass('unexpected claim function overload repair', true);

  const claimKindConstraintDefinition = await requiredCatalogDefinition(
    'claim kind constraint',
    `
      select pg_catalog.pg_get_constraintdef(constraint_row.oid, false) as definition
      from pg_catalog.pg_constraint constraint_row
      where constraint_row.conrelid = 'public.commerce_claim_issuances'::regclass
        and constraint_row.conname = 'commerce_claim_issuances_kind_valid'
        and constraint_row.contype = 'c'
    `
  );
  if (
    !/^CHECK \([\s\S]+\)$/u.test(claimKindConstraintDefinition) ||
    claimKindConstraintDefinition.includes(';')
  ) {
    throw new Error('[restore-verifier] unsafe claim kind constraint catalog definition');
  }
  await pool.query(`
    alter table public.commerce_claim_issuances
    drop constraint commerce_claim_issuances_kind_valid
  `);
  await pool.query(`
    alter table public.commerce_claim_issuances
    add constraint commerce_claim_issuances_kind_valid check (true)
  `);
  await expectRejection(
    'claim constraint definition mismatch',
    'financial_schema_object_manifest=2'
  );
  await pool.query(`
    alter table public.commerce_claim_issuances
    drop constraint commerce_claim_issuances_kind_valid
  `);
  await pool.query(`
    alter table public.commerce_claim_issuances
    add constraint commerce_claim_issuances_kind_valid ${claimKindConstraintDefinition}
  `);
  await expectPass('claim constraint definition repair', true);

  const claimLiveEmailIndexDefinition = await requiredCatalogDefinition(
    'claim live-email index',
    `
      select pg_catalog.pg_get_indexdef(
        'public.commerce_claim_issuances_live_email_idx'::regclass
      ) as definition
    `
  );
  await pool.query('drop index public.commerce_claim_issuances_live_email_idx');
  await pool.query(`
    create index commerce_claim_issuances_live_email_idx
    on public.commerce_claim_issuances using btree (claim_proof_sha256)
  `);
  await expectRejection(
    'claim index definition mismatch',
    'financial_schema_object_manifest=2'
  );
  await pool.query('drop index public.commerce_claim_issuances_live_email_idx');
  await pool.query(claimLiveEmailIndexDefinition);
  await expectPass('claim index definition repair', true);

  await pool.query(`
    alter table public.commerce_claim_issuances
    add constraint commerce_claim_issuances_unexpected_check check (true)
  `);
  await expectRejection(
    'unexpected protected constraint',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    alter table public.commerce_claim_issuances
    drop constraint commerce_claim_issuances_unexpected_check
  `);
  await expectPass('unexpected protected constraint repair', true);

  await pool.query(`
    create index commerce_claim_issuances_unexpected_idx
    on public.commerce_claim_issuances using btree (kind)
  `);
  await expectRejection(
    'unexpected protected explicit index',
    'financial_schema_object_manifest=1'
  );
  await pool.query('drop index public.commerce_claim_issuances_unexpected_idx');
  await expectPass('unexpected protected explicit index repair', true);

  await pool.query(`
    create trigger commerce_claim_issuances_unexpected_trigger
    before update on public.commerce_claim_issuances
    for each row execute function public.plan6b_reject_history_mutation()
  `);
  await expectRejection(
    'unexpected protected trigger',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    drop trigger commerce_claim_issuances_unexpected_trigger
    on public.commerce_claim_issuances
  `);
  await expectPass('unexpected protected trigger repair', true);

  await pool.query(`
    alter table public.commerce_claim_issuances enable row level security
  `);
  await pool.query(`
    alter table public.commerce_claim_issuances force row level security
  `);
  await expectRejection(
    'protected table RLS drift',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    alter table public.commerce_claim_issuances no force row level security
  `);
  await pool.query(`
    alter table public.commerce_claim_issuances disable row level security
  `);
  await expectPass('protected table RLS drift repair', true);

  await pool.query('alter table public.entitlement_grants disable trigger all');
  await expectRejection(
    'disabled protected constraint triggers',
    'financial_schema_object_manifest=3'
  );
  await pool.query('alter table public.entitlement_grants enable trigger all');
  await expectPass('disabled protected constraint triggers repair', true);

  await pool.query(`
    alter type public.financial_evidence_status
    rename value 'pending' to 'pending_catalog_witness'
  `);
  await expectRejection(
    'enum label inventory drift',
    'financial_schema_object_manifest=4'
  );
  await pool.query(`
    alter type public.financial_evidence_status
    rename value 'pending_catalog_witness' to 'pending'
  `);
  await expectPass('enum label inventory drift repair', true);

  await pool.query(`
    alter table public.jobs
    alter column rerun_requested_at set default pg_catalog.now()
  `);
  await expectRejection(
    'touched legacy column descriptor drift',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    alter table public.jobs alter column rerun_requested_at drop default
  `);
  await expectPass('touched legacy column descriptor drift repair', true);

  await pool.query(`
    create type public.entitlement_grant_source_legacy as enum ('catalog_witness')
  `);
  await expectRejection(
    'forbidden retired type',
    'financial_schema_object_manifest=1'
  );
  await pool.query('drop type public.entitlement_grant_source_legacy');
  await expectPass('forbidden retired type repair', true);

  await pool.query(`
    alter table public.disputes add column reconciliation_status text
  `);
  await expectRejection(
    'forbidden retired column',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    alter table public.disputes drop column reconciliation_status
  `);
  await expectPass('forbidden retired column repair', true);

  await pool.query('alter table public.outbox_messages enable row level security');
  await pool.query('alter table public.outbox_messages force row level security');
  await expectRejection(
    'sensitive relation physical state drift',
    'financial_schema_object_manifest=1'
  );
  await pool.query('alter table public.outbox_messages no force row level security');
  await pool.query('alter table public.outbox_messages disable row level security');
  await expectPass('sensitive relation physical state drift repair', true);

  await pool.query(`
    alter table public.jobs add column plan6b_catalog_fk_witness uuid
  `);
  await pool.query(`
    alter table public.jobs
    add constraint jobs_plan6b_catalog_fk_witness
    foreign key (plan6b_catalog_fk_witness) references public.stripe_payouts(id)
    not valid
  `);
  await expectRejection(
    'inbound protected foreign key',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    alter table public.jobs drop constraint jobs_plan6b_catalog_fk_witness
  `);
  await pool.query(`
    alter table public.jobs drop column plan6b_catalog_fk_witness
  `);
  await expectPass('inbound protected foreign key repair', true);

  await pool.query(`
    create rule commerce_claim_issuances_catalog_witness as
    on update to public.commerce_claim_issuances do instead nothing
  `);
  await expectRejection(
    'protected table rule inventory drift',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    drop rule commerce_claim_issuances_catalog_witness
    on public.commerce_claim_issuances
  `);
  await expectPass('protected table rule inventory drift repair', true);

  await pool.query(`
    create table public.commerce_claim_issuances_catalog_child ()
    inherits (public.commerce_claim_issuances)
  `);
  await expectRejection(
    'protected table inheritance edge',
    'financial_schema_object_manifest=1'
  );
  await pool.query('drop table public.commerce_claim_issuances_catalog_child');
  await expectPass('protected table inheritance edge repair', true);

  await pool.query(`
    grant select on table public.commerce_claim_issuances to pale_orbit_runtime
  `);
  await expectRejection(
    'sensitive relation direct ACL mismatch',
    'financial_schema_object_manifest=2'
  );
  await pool.query(`
    revoke select on table public.commerce_claim_issuances from pale_orbit_runtime
  `);
  await expectPass('sensitive relation direct ACL repair', true);

  await pool.query(`
    revoke insert (payload) on table public.outbox_messages from pale_orbit_runtime
  `);
  await expectRejection(
    'missing runtime outbox INSERT ACL',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    grant insert (payload) on table public.outbox_messages to pale_orbit_runtime
  `);
  await expectPass('missing runtime outbox INSERT ACL repair', true);

  await pool.query(`
    grant update (payload) on table public.outbox_messages to pale_orbit_financial_worker
  `);
  await expectRejection(
    'excess worker outbox UPDATE ACL',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    revoke update (payload) on table public.outbox_messages from pale_orbit_financial_worker
  `);
  await expectPass('excess worker outbox UPDATE ACL repair', true);

  const activeIngestIndexDefinition = await requiredCatalogDefinition(
    'active ingest index',
    `
      select pg_catalog.pg_get_indexdef(
        'public.jobs_active_ingest_revision_identity_idx'::regclass
      ) as definition
    `
  );
  await pool.query('drop index public.jobs_active_ingest_revision_identity_idx');
  await pool.query(`
    create index jobs_active_ingest_revision_identity_idx
    on public.jobs using btree (id)
    where type = 'catalog.ingest_revision'
      and status in ('pending', 'running')
  `);
  await expectRejection(
    'active ingest index definition mismatch',
    'financial_schema_object_manifest=1'
  );
  await pool.query('drop index public.jobs_active_ingest_revision_identity_idx');
  await pool.query(activeIngestIndexDefinition);
  await expectPass('active ingest index definition repair', true);

  await pool.query(`
    grant execute on function public.storage_cleanup_referenced_keys(text[])
    to public
  `);
  await expectRejectionChecks(
    'PUBLIC cleanup function execute',
    ['financial_schema_object_manifest=1', 'storage_cleanup_effective_authority=1']
  );
  await pool.query(`
    revoke execute on function public.storage_cleanup_referenced_keys(text[])
    from public
  `);
  await expectPass('PUBLIC cleanup function execute repair', true);

  await pool.query(`
    revoke usage on schema public from pale_orbit_storage_cleanup
  `);
  await expectRejectionChecks(
    'missing cleanup group schema USAGE',
    ['financial_schema_object_manifest=1', 'storage_cleanup_effective_authority=1']
  );
  await pool.query(`
    grant usage on schema public to pale_orbit_storage_cleanup
  `);
  await expectPass('cleanup group schema USAGE repair', true);

  const cleanupLoginResult = await pool.query<{ rolname: string }>(`
    select member_role.rolname
    from pg_catalog.pg_roles group_role
    join pg_catalog.pg_auth_members membership
      on membership.roleid = group_role.oid
    join pg_catalog.pg_roles member_role on member_role.oid = membership.member
    where group_role.rolname = 'pale_orbit_storage_cleanup'
  `);
  const cleanupLoginName = cleanupLoginResult.rows[0]?.rolname;
  if (
    cleanupLoginResult.rows.length !== 1 ||
    typeof cleanupLoginName !== 'string' ||
    cleanupLoginName === ''
  ) {
    throw new Error('[restore-verifier] exact storage cleanup login is missing');
  }
  const quotedCleanupLogin = `"${cleanupLoginName.replaceAll('"', '""')}"`;
  await pool.query(`
    grant connect on database "${databaseName}" to ${quotedCleanupLogin} with grant option
  `);
  await expectRejection(
    'cleanup login direct grantable CONNECT',
    'storage_cleanup_effective_authority=1'
  );
  await pool.query(`
    revoke connect on database "${databaseName}" from ${quotedCleanupLogin}
  `);
  await expectPass('cleanup login direct grantable CONNECT repair', true);

  await pool.query(`
    grant temporary on database "${databaseName}" to ${quotedCleanupLogin}
  `);
  await expectRejection(
    'cleanup login direct TEMPORARY',
    'storage_cleanup_effective_authority=1'
  );
  await pool.query(`
    revoke temporary on database "${databaseName}" from ${quotedCleanupLogin}
  `);
  await expectPass('cleanup login direct TEMPORARY repair', true);

  await pool.query(`
    grant pale_orbit_storage_cleanup to ${quotedCleanupLogin}
    with admin true, inherit false, set true
  `);
  await expectRejection(
    'unsafe cleanup membership flags',
    'storage_cleanup_effective_authority=3'
  );
  await pool.query(`
    grant pale_orbit_storage_cleanup to ${quotedCleanupLogin}
    with admin false, inherit true, set false
  `);
  await expectPass('cleanup membership flags repair', true);

  await pool.query('alter role pale_orbit_storage_cleanup noinherit');
  await expectRejection(
    'unsafe cleanup role attributes',
    'storage_cleanup_effective_authority=1'
  );
  await pool.query('alter role pale_orbit_storage_cleanup inherit');
  await expectPass('cleanup role attributes repair', true);

  await pool.query('grant select on table public.titles to public');
  await expectRejection(
    'inherited cleanup relation authority via PUBLIC SELECT',
    'storage_cleanup_effective_authority=2'
  );
  await pool.query('revoke select on table public.titles from public');
  await expectPass('inherited cleanup relation authority repair', true);

  await pool.query(`
    drop trigger financial_classification_versions_unknown_issue_required
    on financial_classification_versions
  `);
  await expectRejection(
    'missing unknown-classification companion trigger',
    'financial_schema_object_manifest=2'
  );
  await pool.query(`
    create constraint trigger financial_classification_versions_unknown_issue_required
    after insert on financial_classification_versions
    deferrable initially deferred
    for each row when (new.classification = 'unknown')
    execute function plan6b_validate_unknown_classification_issue()
  `);
  await expectPass('unknown-classification companion trigger repair', true);
  await pool.query('drop trigger payments_financial_issue_subject_guard on payments');
  await expectRejection(
    'missing payment financial issue subject guard',
    'financial_schema_object_manifest=1'
  );
  await pool.query(`
    create trigger payments_financial_issue_subject_guard
    before delete or update of id on payments
    for each row execute function plan6b_guard_financial_issue_subject_mutation()
  `);
  await expectPass('payment financial issue subject guard repair', true, 'full');
  verifierScope = 'data';

  const unknownBalanceId = '09000000-0000-4000-8000-000000000001';
  const unknownClassificationId = '09000000-0000-4000-8000-000000000002';
  const unknownFingerprint = '9'.repeat(64);
  await pool.query(`
    insert into stripe_balance_transactions (
      id, provider_id, live_mode, source_family, source_id, raw_type,
      reporting_category, balance_type, amount_minor, fee_minor, net_minor,
      currency, status, provider_created_at, available_at, fingerprint_sha256
    ) values (
      $1, 'txn_restore_unknown_issue', false, 'unknown', null, 'future_type',
      'future_category', 'adjustment', 1, 0, 1, 'USD', 'available', now(), now(), $2
    )
  `, [unknownBalanceId, unknownFingerprint]);
  await mutateAppendOnlyFixture(`
    insert into financial_classification_versions (
      id, subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ($1, 'balance_transaction', $2, 1, 'unknown', $3)
  `, [unknownClassificationId, unknownBalanceId, unknownFingerprint]);
  await expectRejection(
    'unknown classification without its immutable issue',
    'financial_unknown_classification_issue=1'
  );
  await pool.query(`
    insert into financial_reconciliation_issues (
      resource_type, resource_id, safe_code, impact, correlation_id
    ) values (
      'financial_classification', $1, 'unsupported_category', 'exception',
      'restore-unknown-classification-witness'
    )
  `, [unknownClassificationId]);
  await expectPass('unknown classification exact issue repair', true);

  const provenanceBalanceId = '09100000-0000-4000-8000-000000000001';
  const provenanceParentV1Id = '09100000-0000-4000-8000-000000000002';
  const provenanceDetailId = '09100000-0000-4000-8000-000000000003';
  const provenanceDetailV1Id = '09100000-0000-4000-8000-000000000004';
  const provenanceDetailV2Id = '09100000-0000-4000-8000-000000000005';
  const provenanceParentV2Id = '09100000-0000-4000-8000-000000000006';
  const provenanceAccountSetId = '09100000-0000-4000-8000-000000000007';
  const provenanceParentV3Id = '09100000-0000-4000-8000-000000000008';
  const provenanceUnknownIssueId = '09100000-0000-4000-8000-000000000009';
  const provenanceDetailV3Id = '09100000-0000-4000-8000-00000000000a';
  const provenanceDetailV3IssueId = '09100000-0000-4000-8000-00000000000b';
  const provenanceBalanceFingerprint = 'a'.repeat(64);
  const provenanceDetailFingerprint = 'b'.repeat(64);
  await pool.query(`
    insert into stripe_balance_transactions (
      id, provider_id, live_mode, source_family, source_id, raw_type,
      reporting_category, balance_type, amount_minor, fee_minor, net_minor,
      currency, status, provider_created_at, available_at, fingerprint_sha256
    ) values (
      $1, 'txn_restore_classification_provenance', false, 'adjustment', null,
      'adjustment', 'other_adjustment', 'payments', 1, 0, 1, 'USD', 'available',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', $2
    )
  `, [provenanceBalanceId, provenanceBalanceFingerprint]);
  await pool.query(`
    insert into stripe_balance_transaction_fee_details (
      id, balance_transaction_id, ordinal, raw_type, amount_minor, currency,
      fingerprint_sha256
    ) values ($1, $2, 0, 'tax', 0, 'USD', $3)
  `, [provenanceDetailId, provenanceBalanceId, provenanceDetailFingerprint]);
  await pool.query(`
    insert into financial_classification_versions (
      id, subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values
      ($1, 'balance_transaction', $3, 1, 'other', repeat('c', 64)),
      ($2, 'fee_detail', $4, 1, 'provider_fee_tax', repeat('d', 64))
  `, [
    provenanceParentV1Id,
    provenanceDetailV1Id,
    provenanceBalanceId,
    provenanceDetailId
  ]);
  await expectRejection(
    'classification decisions must match both immutable subject fingerprints',
    'classification_subject=2'
  );
  await mutateAppendOnlyFixture(`
    update financial_classification_versions
    set source_fingerprint_sha256 = $2
    where id = $1
  `, [provenanceParentV1Id, provenanceBalanceFingerprint]);
  await expectRejection(
    'fee-detail decisions retain their own immutable fingerprint',
    'classification_subject=1'
  );
  await mutateAppendOnlyFixture(`
    update financial_classification_versions
    set source_fingerprint_sha256 = $2
    where id = $1
  `, [provenanceDetailV1Id, provenanceDetailFingerprint]);
  await expectPass('classification subject fingerprint repair', true);
  await pool.query(`
    insert into financial_classification_versions (
      id, subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ($1, 'fee_detail', $2, 2, 'provider_fee_tax', $3)
  `, [provenanceDetailV2Id, provenanceDetailId, provenanceDetailFingerprint]);
  await expectRejection(
    'fee-detail classification requires its exact same-version parent decision',
    'classification_subject=1'
  );
  await pool.query(`
    insert into financial_classification_versions (
      id, subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ($1, 'balance_transaction', $2, 2, 'other', $3)
  `, [provenanceParentV2Id, provenanceBalanceId, provenanceBalanceFingerprint]);
  await expectPass('fee-detail same-version parent repair', true);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256
    ) values (
      $1, 'restore:classification-provenance:account', $2, 'adjustment', $2,
      'gross_amount', 'account', 1, 'USD', 1, 3, $3
    )
  `, [provenanceAccountSetId, provenanceBalanceId, provenanceBalanceFingerprint]);
  await expectRejection(
    'itemless account allocation still requires an exact parent decision',
    'allocation_set_parent_or_chain=1'
  );
  await pool.query(`
    with inserted_classification as (
      insert into financial_classification_versions (
        id, subject_type, subject_id, classifier_version, classification,
        source_fingerprint_sha256
      ) values ($2, 'balance_transaction', $3, 3, 'unknown', $4)
      returning id
    )
    insert into financial_reconciliation_issues (
      id, resource_type, resource_id, safe_code, impact, correlation_id
    )
    select $1, 'financial_classification', classification.id,
      'unsupported_category', 'exception', 'restore-classification-provenance'
    from inserted_classification classification
  `, [
    provenanceUnknownIssueId,
    provenanceParentV3Id,
    provenanceBalanceId,
    provenanceBalanceFingerprint
  ]);
  await expectRejection(
    'itemless account allocation cannot depend on an exact unknown parent',
    'allocation_set_parent_or_chain=1'
  );
  await mutateAppendOnlyFixture(`
    update financial_classification_versions set classification = 'other' where id = $1
  `, [provenanceParentV3Id]);
  await mutateAppendOnlyFixture(`
    delete from financial_reconciliation_issues where id = $1
  `, [provenanceUnknownIssueId]);
  await expectRejection(
    'itemless account allocation requires every exact fee-detail decision',
    'allocation_set_detail_classification=1'
  );
  await pool.query(`
    with inserted_classification as (
      insert into financial_classification_versions (
        id, subject_type, subject_id, classifier_version, classification,
        source_fingerprint_sha256
      ) values ($2, 'fee_detail', $3, 3, 'unknown', $4)
      returning id
    )
    insert into financial_reconciliation_issues (
      id, resource_type, resource_id, safe_code, impact, correlation_id
    )
    select $1, 'financial_classification', classification.id,
      'unsupported_category', 'exception', 'restore-classification-detail-provenance'
    from inserted_classification classification
  `, [
    provenanceDetailV3IssueId,
    provenanceDetailV3Id,
    provenanceDetailId,
    provenanceDetailFingerprint
  ]);
  await expectRejection(
    'itemless account allocation cannot depend on an exact unknown fee detail',
    'allocation_set_detail_classification=1'
  );
  await mutateAppendOnlyFixture(`
    update financial_classification_versions
    set classification = 'provider_fee_tax'
    where id = $1
  `, [provenanceDetailV3Id]);
  await mutateAppendOnlyFixture(`
    delete from financial_reconciliation_issues where id = $1
  `, [provenanceDetailV3IssueId]);
  await expectPass('itemless account exact known classification repair', true);

  await pool.query('delete from financial_payout_discovery_state');
  await expectRejection(
    'missing payout discovery singleton',
    'financial_payout_discovery_singleton=1'
  );
  await pool.query(`
    insert into financial_payout_discovery_state (singleton, covered_through)
    values (true, null)
  `);

  const payoutId = '10000000-0000-4000-8000-000000000001';
  const priorPayoutRunId = '10000000-0000-4000-8000-000000000002';
  const equalPayoutRunId = '10000000-0000-4000-8000-000000000003';
  const aheadPayoutRunId = '10000000-0000-4000-8000-000000000004';
  await pool.query(`
    insert into stripe_payouts (
      id, provider_id, live_mode, amount_minor, currency, automatic, method, status,
      reconciliation_status, provider_created_at, arrival_at, retrieved_at,
      financial_generation, fingerprint_sha256
    ) values (
      $1, 'po_restore_equal_generation', false, 100, 'USD', true, 'standard', 'paid',
      'completed', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', now(),
      2, repeat('a', 64)
    )
  `, [payoutId]);
  await pool.query(`
    insert into payout_import_runs (
      id, payout_id, generation, state, candidate_count, page_count, safe_outcome, completed_at
    ) values
      ($2, $1, 0, 'published', 0, 1, 'published', now()),
      ($3, $1, 2, 'published', 0, 1, 'published', now())
  `, [payoutId, priorPayoutRunId, equalPayoutRunId]);
  await pool.query(`
    insert into jobs (type, payload, deduplication_key, max_attempts)
    values (
      'commerce.financial-scan',
      jsonb_build_object('kind', 'payout_impact', 'payoutId', $1::uuid, 'payoutGeneration', 2),
      'financial:payout-impact:' || $1::text || ':2', 8
    )
  `, [payoutId]);
  await expectPass('published payout replay at the current generation', true);

  const payoutMembershipBalanceId = '10000000-0000-4000-8000-000000000005';
  await pool.query(`
    insert into stripe_balance_transactions (
      id, provider_id, live_mode, source_family, source_id, raw_type,
      reporting_category, balance_type, amount_minor, fee_minor, net_minor,
      currency, status, provider_created_at, available_at, fingerprint_sha256
    ) values (
      $1, 'bt_restore_payout_currency', false, 'charge', 'ch_restore_payout_currency',
      'charge', 'charge', 'payments', 100, 0, 100, 'USD', 'available',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', repeat('e', 64)
    )
  `, [payoutMembershipBalanceId]);
  await pool.query(`
    update payout_import_runs set candidate_count = 1
    where id in ($1, $2)
  `, [priorPayoutRunId, equalPayoutRunId]);
  await pool.query(`
    insert into payout_import_run_entries (run_id, balance_transaction_id)
    values ($1, $3), ($2, $3)
  `, [priorPayoutRunId, equalPayoutRunId, payoutMembershipBalanceId]);
  await pool.query(`
    insert into stripe_payout_balance_transactions (
      payout_id, balance_transaction_id, published_from_run_id
    ) values ($1, $2, $3)
  `, [payoutId, payoutMembershipBalanceId, equalPayoutRunId]);
  await expectPass('payout membership currency baseline', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set currency = 'EUR' where id = $1
  `, [payoutMembershipBalanceId]);
  await expectRejection(
    'payout membership cannot cross payout currency',
    'payout_membership_currency=1'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set currency = 'USD' where id = $1
  `, [payoutMembershipBalanceId]);
  await expectPass('payout membership currency repair', true);

  const resolvedIssueId = '10000000-0000-4000-8000-000000000006';
  const duplicateResolvedAuditId = '10000000-0000-4000-8000-000000000008';
  await pool.query(`
    insert into financial_reconciliation_issues (
      id, resource_type, resource_id, safe_code, impact, correlation_id
    ) values (
      $1, 'payout', $2, 'payout_membership_conflict', 'exception',
      'restore-resolved-audit-open'
    )
  `, [resolvedIssueId, payoutId]);
  await expectPass('financial issue semantic identity baseline', true);
  await pool.query(`
    alter table financial_reconciliation_issues
    drop constraint financial_reconciliation_issues_semantic_identity
  `);
  await mutateAppendOnlyFixture(`
    update financial_reconciliation_issues
    set safe_code = 'unsupported_category'
    where id = $1
  `, [resolvedIssueId]);
  await pool.query(`${semanticIdentityConstraintStatement} not valid`);
  await expectRejectionChecks(
    'known but impossible financial issue identity',
    ['financial_issue_vocabulary=1', 'financial_schema_object_manifest=2'],
    'full'
  );
  await mutateAppendOnlyFixture(`
    update financial_reconciliation_issues
    set safe_code = 'payout_membership_conflict'
    where id = $1
  `, [resolvedIssueId]);
  await pool.query(`
    alter table financial_reconciliation_issues
    drop constraint financial_reconciliation_issues_semantic_identity
  `);
  await pool.query(semanticIdentityConstraintStatement);
  await expectPass('financial issue semantic identity repair', true, 'full');
  await pool.query(`
    alter table financial_reconciliation_issues
    drop constraint financial_reconciliation_issues_semantic_impact
  `);
  await mutateAppendOnlyFixture(`
    update financial_reconciliation_issues
    set impact = 'informational'
    where id = $1
  `, [resolvedIssueId]);
  await pool.query(`${semanticImpactConstraintStatement} not valid`);
  await expectRejectionChecks(
    'impossible financial issue impact',
    ['financial_issue_vocabulary=1', 'financial_schema_object_manifest=2'],
    'full'
  );
  await mutateAppendOnlyFixture(`
    update financial_reconciliation_issues
    set impact = 'exception'
    where id = $1
  `, [resolvedIssueId]);
  await pool.query(`
    alter table financial_reconciliation_issues
    drop constraint financial_reconciliation_issues_semantic_impact
  `);
  await pool.query(semanticImpactConstraintStatement);
  await expectPass('financial issue semantic impact repair', true, 'full');
  await pool.query(`
    select * from resolve_financial_issue_after_worker_recompute(
      $1, 'restore-resolved-audit'
    )
  `, [resolvedIssueId]);
  const resolvedAuditResult = await pool.query<{ id: string }>(`
    select id
    from audit_events
    where action = 'financial.issue.resolved' and resource_id = $1::text
  `, [resolvedIssueId]);
  const resolvedAuditId = resolvedAuditResult.rows[0]?.id;
  if (!resolvedAuditId) {
    throw new Error('[restore-verifier] missing resolved issue audit witness');
  }
  await expectPass('resolved issue owns one canonical audit', true);
  await mutateAppendOnlyFixture(`
    update audit_events set actor_id = 'unexpected-system-resolver' where id = $1
  `, [resolvedAuditId]);
  await expectRejection(
    'system-resolved issue requires the canonical worker audit actor',
    'resolved_issue_audit_provenance=2'
  );
  await mutateAppendOnlyFixture(`
    update audit_events set actor_id = 'financial-worker' where id = $1
  `, [resolvedAuditId]);
  await mutateAppendOnlyFixture(`
    update audit_events set actor_type = 'user', actor_id = $2::text where id = $1
  `, [resolvedAuditId, payoutId]);
  await expectRejection(
    'system-resolved issue cannot claim a user audit actor',
    'resolved_issue_audit_provenance=2'
  );
  await mutateAppendOnlyFixture(`
    update audit_events set actor_type = 'system', actor_id = 'financial-worker'
    where id = $1
  `, [resolvedAuditId]);
  await mutateAppendOnlyFixture(`
    update audit_events
    set after = jsonb_set(after, '{resourceId}', to_jsonb($2::text))
    where id = $1
  `, [resolvedAuditId, payoutMembershipBalanceId]);
  await expectRejection(
    'resolved issue audit must mirror resource and code identity',
    'resolved_issue_audit_provenance=2'
  );
  await mutateAppendOnlyFixture(`
    update audit_events
    set after = jsonb_build_object(
      'resourceType', 'payout',
      'resourceId', $2::text,
      'safeCode', 'payout_membership_conflict',
      'impact', 'exception',
      'state', 'resolved',
      'occurrenceCount', 1
    )
    where id = $1
  `, [resolvedAuditId, payoutId]);
  await pool.query(`
    insert into audit_events (
      id, actor_type, actor_id, action, outcome, resource_type, resource_id,
      correlation_id, after
    )
    select $2, actor_type, actor_id, action, outcome, resource_type, resource_id,
      correlation_id, after
    from audit_events where id = $1
  `, [resolvedAuditId, duplicateResolvedAuditId]);
  await expectRejection(
    'resolved issue cannot own duplicate canonical audits',
    'resolved_issue_audit_provenance=1'
  );
  await mutateAppendOnlyFixture('delete from audit_events where id = $1', [
    duplicateResolvedAuditId
  ]);
  await expectPass('resolved issue audit provenance repair', true);

  await pool.query(`
    insert into payout_import_runs (
      id, payout_id, generation, state, candidate_count, page_count, safe_outcome, completed_at
    ) values ($1, $2, 3, 'published', 0, 1, 'published', now())
  `, [aheadPayoutRunId, payoutId]);
  await expectRejection('published payout run ahead of authority', 'run_generation_order=1');
  await pool.query('delete from payout_import_runs where id = $1', [aheadPayoutRunId]);

  const replayRunId = '20000000-0000-4000-8000-000000000001';
  const replayRootKey = 'commerce.financial-classification:scan:2:2';
  const replayDigestResult = await pool.query<{ digest: string }>(`
    select encode(sha256(
      convert_to('classification_replay_finalize', 'UTF8') || decode('00', 'hex') ||
      convert_to('', 'UTF8')
    ), 'hex') as digest
  `);
  const replayDigest = replayDigestResult.rows[0]?.digest;
  if (!replayDigest) throw new Error('[restore-verifier] failed to build replay witness digest');
  const replayFinalizerKey =
    `commerce.financial-scan:${replayRunId}:classification_replay_finalize:${replayDigest}`;
  await pool.query(`
    insert into financial_scan_runs (
      id, root_key, kind, phase, state, classifier_version, allocation_algorithm_version,
      replay_id, checkpoint, cursor_digest_sha256, processed_count, enqueued_count, page_count
    ) values ($1, $2, 'classification_replay', 'classification_replay_finalize', 'running',
      2, 2, 'c2-a2', null, $3, 0, 1, 1)
  `, [replayRunId, replayRootKey, replayDigest]);
  await pool.query(`
    insert into jobs (type, payload, deduplication_key, status, attempts, max_attempts)
    values
      ('commerce.financial-scan',
        jsonb_build_object('kind', 'composite_replay', 'classifierVersion', 2,
          'allocationAlgorithmVersion', 2, 'replayId', 'c2-a2'),
        $2, 'pending', 0, 8),
      ('commerce.financial-scan',
        jsonb_build_object('kind', 'continuation', 'scanRunId', $1::uuid,
          'phase', 'classification_replay_finalize', 'cursorDigestSha256', $3::text, 'limit', 100),
        $4, 'pending', 0, 8),
      ('commerce.financial-classification',
        jsonb_build_object('scanRunId', $1::uuid, 'classifierVersion', 2,
          'allocationAlgorithmVersion', 2, 'replayId', 'c2-a2'),
        'restore-replay-child', 'pending', 0, 8)
  `, [replayRunId, replayRootKey, replayDigest, replayFinalizerKey]);
  await pool.query(`
    update financial_projection_versions set
      pending_classifier_version = 2, pending_allocation_algorithm_version = 2,
      pending_replay_id = 'c2-a2', pending_scan_run_id = $1
    where singleton = true
  `, [replayRunId]);
  await expectPass('pending replay with a resumable child');

  await pool.query(`
    update jobs set attempts = max_attempts
    where deduplication_key = $1
  `, [replayFinalizerKey]);
  await expectRejection(
    'running scan with an exhausted pending resume job',
    'running_scan_resume_job_missing=1'
  );
  await pool.query(`
    update jobs set attempts = max_attempts - 1
    where deduplication_key = $1
  `, [replayFinalizerKey]);
  await expectPass('running scan with a pending resume job below its attempt ceiling');

  await pool.query(`
    insert into jobs (
      type, payload, deduplication_key, status, attempts, max_attempts, completed_at
    ) values (
      'commerce.financial-classification',
      jsonb_build_object('scanRunId', $1::uuid, 'classifierVersion', 2,
        'allocationAlgorithmVersion', 2, 'replayId', 'c2-a2'),
      'restore-replay-child-surplus', 'succeeded', 0, 8, now()
    )
  `, [replayRunId]);
  await expectPass('pending replay with a late-enrolled surplus child');
  await pool.query(
    `delete from jobs where deduplication_key = 'restore-replay-child-surplus'`
  );

  await pool.query(`
    update jobs set status = 'failed', attempts = 1,
      completed_at = now(), last_error = 'restore witness failed child'
    where deduplication_key = 'restore-replay-child'
  `);
  await expectDiagnostics('pending replay with a failed child below its attempt ceiling', [
    'pending_replay_child_incomplete',
    'pending_replay_child_permanent'
  ]);

  await pool.query(`
    update jobs set status = 'failed', attempts = max_attempts,
      completed_at = now(), last_error = 'restore witness exhausted child'
    where deduplication_key = 'restore-replay-child'
  `);
  await expectDiagnostics('pending replay with an exhausted failed child', [
    'pending_replay_child_incomplete',
    'pending_replay_child_retry_exhausted'
  ]);
  await pool.query(`
    update jobs set status = 'succeeded', last_error = null
    where deduplication_key = 'restore-replay-child'
  `);

  await pool.query(`
    update jobs set payload = jsonb_set(payload, '{classifierVersion}', '3'::jsonb)
    where deduplication_key = 'restore-replay-child'
  `);
  await expectRejection(
    'pending replay with a child version mismatch',
    'pending_replay_child_version_mismatch=1'
  );
  await pool.query(`
    update jobs set payload = jsonb_set(payload, '{classifierVersion}', '2'::jsonb)
    where deduplication_key = 'restore-replay-child'
  `);

  await pool.query('update financial_scan_runs set enqueued_count = 2 where id = $1', [replayRunId]);
  await expectRejection(
    'pending replay with an incomplete child barrier',
    'pending_replay_child_count_mismatch=1'
  );
  await pool.query('update financial_scan_runs set enqueued_count = 1 where id = $1', [replayRunId]);

  const orderId = '30000000-0000-4000-8000-000000000001';
  const firstTitleId = '30000000-0000-4000-8000-000000000002';
  const secondTitleId = '30000000-0000-4000-8000-000000000003';
  const firstItemId = '30000000-0000-4000-8000-000000000004';
  const secondItemId = '30000000-0000-4000-8000-000000000005';
  const paymentId = '30000000-0000-4000-8000-000000000006';
  const capacityRefundOneId = '30000000-0000-4000-8000-000000000007';
  const capacityRefundTwoId = '30000000-0000-4000-8000-000000000008';
  const capacityAllocationOneId = '30000000-0000-4000-8000-000000000009';
  const capacityAllocationTwoId = '30000000-0000-4000-8000-00000000000a';
  const splitRefundId = '30000000-0000-4000-8000-00000000000b';
  const splitAllocationId = '30000000-0000-4000-8000-00000000000c';
  await pool.query(`
    insert into titles (id, slug, title, description, creator_name, format, price_minor, currency)
    values
      ($1, 'restore-capacity-title', 'Restore capacity', 'Witness', 'Witness', 'prose', 4, 'USD'),
      ($2, 'restore-split-title', 'Restore split', 'Witness', 'Witness', 'prose', 4, 'USD')
  `, [firstTitleId, secondTitleId]);
  await pool.query(`
    insert into orders (
      id, status, currency, subtotal_minor, tax_minor, total_minor,
      client_checkout_attempt_id, quote_fingerprint_sha256, status_token_sha256
    ) values ($1, 'checkout_pending', 'USD', 6, 2, 8,
      '30000000-0000-4000-8000-00000000000d', repeat('b', 64), repeat('c', 64))
  `, [orderId]);
  await pool.query(`
    insert into order_items (
      id, order_id, title_id, title_snapshot, creator_name_snapshot, format,
      currency, unit_subtotal_minor, tax_minor, total_minor
    ) values
      ($4, $3, $1, 'Restore capacity', 'Witness', 'prose', 'USD', 3, 1, 4),
      ($5, $3, $2, 'Restore split', 'Witness', 'prose', 'USD', 3, 1, 4)
  `, [firstTitleId, secondTitleId, orderId, firstItemId, secondItemId]);
  await pool.query(`
    insert into payments (id, order_id, stripe_payment_intent_id, status, amount_minor, currency)
    values ($1, $2, 'pi_restore_refund_components', 'pending', 8, 'USD')
  `, [paymentId, orderId]);
  const chargeTransactionId = '45000000-0000-4000-8000-000000000001';
  const chargeAllocationSetId = '45000000-0000-4000-8000-000000000002';
  const chargeSubtotalItemId = '45000000-0000-4000-8000-000000000003';
  const chargeFingerprint = '4'.repeat(64);
  await pool.query(`
    update payments set stripe_latest_charge_id = 'ch_restore_component_semantics'
    where id = $1
  `, [paymentId]);
  await pool.query(`
    insert into stripe_balance_transactions (
      id, provider_id, live_mode, source_family, source_id, raw_type,
      reporting_category, balance_type, amount_minor, fee_minor, net_minor,
      currency, status, provider_created_at, available_at, fingerprint_sha256
    ) values (
      $1, 'bt_restore_component_semantics', false, 'charge',
      'ch_restore_component_semantics', 'charge', 'charge', 'payments',
      8, 0, 8, 'USD', 'available', '2026-08-02T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z', $2
    )
  `, [chargeTransactionId, chargeFingerprint]);
  await pool.query(`
    insert into financial_classification_versions (
      subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ('balance_transaction', $1, 1, 'charge', $2)
  `, [chargeTransactionId, chargeFingerprint]);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256
    ) values (
      $1, 'restore:charge:component-semantics', $2, 'payment', $3,
      'gross_amount', 'title', 8, 'USD', 1, 1, $4
    )
  `, [chargeAllocationSetId, chargeTransactionId, paymentId, chargeFingerprint]);
  await pool.query(`
    insert into financial_item_allocations (
      id, allocation_set_id, order_item_id, component, effect_minor, currency,
      tie_break_key
    ) values
      ($1, $2, $3, 'sale_subtotal', 3, 'USD', 'restore:charge:first:subtotal'),
      ('45000000-0000-4000-8000-000000000004', $2, $3,
        'sale_tax', 1, 'USD', 'restore:charge:first:tax'),
      ('45000000-0000-4000-8000-000000000005', $2, $4,
        'sale_subtotal', 3, 'USD', 'restore:charge:second:subtotal'),
      ('45000000-0000-4000-8000-000000000006', $2, $4,
        'sale_tax', 1, 'USD', 'restore:charge:second:tax')
  `, [chargeSubtotalItemId, chargeAllocationSetId, firstItemId, secondItemId]);
  await expectPass('charge allocation component semantics baseline', true);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set component = 'other' where id = $1
  `, [chargeSubtotalItemId]);
  await expectRejection(
    'charge gross allocation cannot masquerade as another component',
    'financial_item_allocation_semantic_component=1'
  );
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set component = 'sale_subtotal' where id = $1
  `, [chargeSubtotalItemId]);
  await expectPass('charge allocation component semantics repair', true);
  const chargeFeeDetailId = '45000000-0000-4000-8000-000000000007';
  const chargeFeeTaxDetailId = '45000000-0000-4000-8000-000000000008';
  const chargeFeeSetId = '45000000-0000-4000-8000-000000000009';
  const chargeFeeItemId = '45000000-0000-4000-8000-00000000000a';
  const chargeFeeTaxItemId = '45000000-0000-4000-8000-00000000000b';
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set fee_minor = 1, net_minor = 7 where id = $1
  `, [chargeTransactionId]);
  await pool.query(`
    insert into stripe_balance_transaction_fee_details (
      id, balance_transaction_id, ordinal, raw_type, amount_minor, currency,
      fingerprint_sha256
    ) values
      ($1, $3, 0, 'stripe_fee', 1, 'USD', $4),
      ($2, $3, 1, 'tax', 0, 'USD', $5)
  `, [chargeFeeDetailId, chargeFeeTaxDetailId, chargeTransactionId,
    '5'.repeat(64), '6'.repeat(64)]);
  await pool.query(`
    insert into financial_classification_versions (
      subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values
      ('fee_detail', $1, 1, 'processing_fee', $3),
      ('fee_detail', $2, 1, 'provider_fee_tax', $4)
  `, [chargeFeeDetailId, chargeFeeTaxDetailId, '5'.repeat(64), '6'.repeat(64)]);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256
    ) values (
      $1, 'restore:charge:fee-component-conservation', $2, 'payment', $3,
      'fee', 'title', -1, 'USD', 1, 1, $4
    )
  `, [chargeFeeSetId, chargeTransactionId, paymentId, chargeFingerprint]);
  await pool.query(`
    insert into financial_item_allocations (
      id, allocation_set_id, order_item_id, component, effect_minor, currency,
      tie_break_key
    ) values
      ($1, $3, $4, 'processing_fee', -1, 'USD', 'restore:charge:fee'),
      ($2, $3, $4, 'provider_fee_tax', 0, 'USD', 'restore:charge:fee-tax')
  `, [chargeFeeItemId, chargeFeeTaxItemId, chargeFeeSetId, firstItemId]);
  await expectPass('charge fee component conservation baseline', true);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations
    set effect_minor = case id when $1 then 0 else -1 end
    where id in ($1, $2)
  `, [chargeFeeItemId, chargeFeeTaxItemId]);
  await expectRejection(
    'charge fee effects cannot move between valid classified components',
    'financial_fee_component_conservation=2'
  );
  await mutateAppendOnlyFixture(`
    update financial_item_allocations
    set effect_minor = case id when $1 then -1 else 0 end
    where id in ($1, $2)
  `, [chargeFeeItemId, chargeFeeTaxItemId]);
  await expectPass('charge fee component conservation repair', true);
  await mutateAppendOnlyFixture(`
    delete from financial_item_allocations where id = $1
  `, [chargeFeeTaxItemId]);
  await mutateAppendOnlyFixture(`
    update financial_classification_versions set classification = 'refund_fee'
    where subject_type = 'fee_detail' and subject_id = $1
      and classifier_version = 1 and source_fingerprint_sha256 = $2
  `, [chargeFeeTaxDetailId, '6'.repeat(64)]);
  await expectRejection(
    'zero fee detail still requires a source-valid exact classification',
    'financial_fee_detail_semantic_classification=1'
  );
  await mutateAppendOnlyFixture(`
    update financial_classification_versions set classification = 'provider_fee_tax'
    where subject_type = 'fee_detail' and subject_id = $1
      and classifier_version = 1 and source_fingerprint_sha256 = $2
  `, [chargeFeeTaxDetailId, '6'.repeat(64)]);
  await pool.query(`
    insert into financial_item_allocations (
      id, allocation_set_id, order_item_id, component, effect_minor, currency,
      tie_break_key
    ) values (
      $1, $2, $3, 'provider_fee_tax', 0, 'USD', 'restore:charge:fee-tax'
    )
  `, [chargeFeeTaxItemId, chargeFeeSetId, firstItemId]);
  await expectPass('zero fee detail classification semantics repair', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = 1, exchange_source_currency = 'EUR',
      exchange_target_currency = 'USD'
    where id = $1
  `, [chargeTransactionId]);
  await expectRejection(
    'same-currency charge cannot carry rogue exchange evidence',
    'allocation_set_semantic_source=2'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = null, exchange_source_currency = null,
      exchange_target_currency = null
    where id = $1
  `, [chargeTransactionId]);
  await expectPass('same-currency charge exchange evidence repair', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set currency = 'EUR', exchange_rate = 0.9,
      exchange_source_currency = 'USD', exchange_target_currency = 'EUR'
    where id = $1
  `, [chargeTransactionId]);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transaction_fee_details set currency = 'EUR'
    where balance_transaction_id = $1
  `, [chargeTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets set currency = 'EUR'
    where balance_transaction_id = $1
  `, [chargeTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set currency = 'EUR'
    where allocation_set_id in ($1, $2)
  `, [chargeAllocationSetId, chargeFeeSetId]);
  await expectPass('cross-currency charge exact exchange evidence', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = null, exchange_source_currency = null,
      exchange_target_currency = null
    where id = $1
  `, [chargeTransactionId]);
  await expectRejection(
    'cross-currency charge requires exchange evidence',
    'allocation_set_semantic_source=2'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = 0.9, exchange_source_currency = 'GBP',
      exchange_target_currency = 'EUR'
    where id = $1
  `, [chargeTransactionId]);
  await expectRejection(
    'cross-currency charge exchange source must match its payment currency',
    'allocation_set_semantic_source=2'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set currency = 'USD', exchange_rate = null,
      exchange_source_currency = null, exchange_target_currency = null
    where id = $1
  `, [chargeTransactionId]);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transaction_fee_details set currency = 'USD'
    where balance_transaction_id = $1
  `, [chargeTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets set currency = 'USD'
    where balance_transaction_id = $1
  `, [chargeTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set currency = 'USD'
    where allocation_set_id in ($1, $2)
  `, [chargeAllocationSetId, chargeFeeSetId]);
  await expectPass('charge exchange evidence witness cleanup', true);
  await pool.query(`
    update payments set financial_evidence_status = 'fee_reconciled' where id = $1
  `, [paymentId]);
  await expectPass('fee-reconciled payment has exact current heads', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set amount_minor = 7, net_minor = 6 where id = $1
  `, [chargeTransactionId]);
  await expectRejectionChecks(
    'same-currency payment source-principal corruption',
    ['allocation_set_semantic_source=2', 'source_evidence_projection_parity=1']
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set amount_minor = 8, net_minor = 7 where id = $1
  `, [chargeTransactionId]);
  await expectPass('same-currency payment source-principal repair', true);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations
    set effect_minor = case id when $1 then 2 else 4 end
    where id in ($1, $2)
  `, [chargeSubtotalItemId, '45000000-0000-4000-8000-000000000005']);
  await expectRejection(
    'balanced charge title redistribution is not deterministic',
    'financial_title_allocation_determinism=1'
  );
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set effect_minor = 3 where id in ($1, $2)
  `, [chargeSubtotalItemId, '45000000-0000-4000-8000-000000000005']);
  await expectPass('charge title allocation repair', true);

  const paymentProjectionIssueId = '45000000-0000-4000-8000-00000000000c';
  const paymentSourceIssueId = '45000000-0000-4000-8000-00000000000d';
  await pool.query(`
    insert into financial_reconciliation_issues (
      id, resource_type, resource_id, safe_code, impact, correlation_id
    ) values
    (
      $1, 'allocation_set', $2, 'allocation_mismatch', 'exception',
      'restore-payment-projection-parity'
    ), (
      $3, 'payment', $4, 'allocation_mismatch', 'exception',
      'restore-payment-source-parity'
    )
  `, [paymentProjectionIssueId, chargeAllocationSetId, paymentSourceIssueId, paymentId]);
  await expectRejection(
    'fee-reconciled source cannot hide an incomplete selected head',
    'source_evidence_projection_parity=1'
  );
  await pool.query(`
    update payments set financial_evidence_status = 'exception' where id = $1
  `, [paymentId]);
  await expectPass('source exception status matches its open exception issue', true);
  await mutateAppendOnlyFixture(`
    delete from financial_reconciliation_issues where id in ($1, $2)
  `, [paymentProjectionIssueId, paymentSourceIssueId]);
  await expectRejection(
    'source exception status requires a current exception issue',
    'source_evidence_projection_parity=1'
  );
  await pool.query(`
    update payments set financial_evidence_status = 'pending' where id = $1
  `, [paymentId]);
  await expectPass('unprocessed pending source needs no synthetic issue', true);
  await pool.query(`
    update payments set financial_evidence_status = 'fee_reconciled' where id = $1
  `, [paymentId]);
  await expectPass('source projection parity repair', true);
  await pool.query(`
    insert into refunds (
      id, payment_id, stripe_refund_id, status, amount_minor, currency,
      provider_created_at, allocation_status
    ) values
      ($1, $3, 're_restore_capacity_1', 'succeeded', 2, 'USD',
        '2026-08-03T00:00:00.000Z', 'finalized'),
      ($2, $3, 're_restore_capacity_2', 'succeeded', 2, 'USD',
        '2026-08-04T00:00:00.000Z', 'finalized')
  `, [capacityRefundOneId, capacityRefundTwoId, paymentId]);
  await pool.query(`
    insert into refund_allocations (id, refund_id, order_item_id, amount_minor, source)
    values ($1, $2, $3, 2, 'automatic'), ($4, $5, $3, 2, 'automatic')
  `, [
    capacityAllocationOneId, capacityRefundOneId, firstItemId,
    capacityAllocationTwoId, capacityRefundTwoId
  ]);
  await pool.query(`
    insert into refund_allocation_components (
      refund_allocation_id, refund_id, order_item_id,
      subtotal_minor, tax_minor, total_minor, currency
    ) values
      ($1, $2, $3, 2, 0, 2, 'USD'),
      ($4, $5, $3, 2, 0, 2, 'USD')
  `, [
    capacityAllocationOneId, capacityRefundOneId, firstItemId,
    capacityAllocationTwoId, capacityRefundTwoId
  ]);
  await expectRejection(
    'refund component chronology exceeds a bucket capacity',
    'refund_component_chronology_capacity=1'
  );
  await pool.query('set session_replication_role = replica');
  try {
    await pool.query(`
      update refund_allocation_components set subtotal_minor = 1, tax_minor = 1
      where refund_allocation_id = $1
    `, [capacityAllocationTwoId]);
  } finally {
    await pool.query('set session_replication_role = origin');
  }

  const unresolvedRefundId = '47000000-0000-4000-8000-000000000001';
  const unresolvedTransactionId = '47000000-0000-4000-8000-000000000002';
  const unresolvedGrossSetId = '47000000-0000-4000-8000-000000000003';
  const unresolvedFeeDetailId = '47000000-0000-4000-8000-000000000004';
  const unresolvedFeeSetId = '47000000-0000-4000-8000-000000000005';
  const unresolvedFingerprint = 'c'.repeat(64);
  await pool.query(`
    insert into refunds (
      id, payment_id, stripe_refund_id, status, amount_minor, currency,
      provider_created_at, allocation_status
    ) values (
      $1, $2, 're_restore_unresolved_fee_semantics', 'succeeded', 1, 'USD',
      '2026-08-02T12:00:00.000Z', 'needs_review'
    )
  `, [unresolvedRefundId, paymentId]);
  await pool.query(`
    insert into stripe_balance_transactions (
      id, provider_id, live_mode, source_family, source_id, raw_type,
      reporting_category, balance_type, amount_minor, fee_minor, net_minor,
      currency, status, provider_created_at, available_at, fingerprint_sha256
    ) values (
      $1, 'bt_restore_unresolved_fee_semantics', false, 'refund',
      're_restore_unresolved_fee_semantics', 'refund', 'refund', 'payments',
      -1, 0, -1, 'USD', 'available', '2026-08-02T12:00:00.000Z',
      '2026-08-02T12:00:00.000Z', $2
    )
  `, [unresolvedTransactionId, unresolvedFingerprint]);
  await pool.query(`
    insert into financial_classification_versions (
      subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ('balance_transaction', $1, 1, 'refund', $2)
  `, [unresolvedTransactionId, unresolvedFingerprint]);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256
    ) values
      ($1, 'restore:refund:unresolved-gross', $3, 'refund', $4,
        'gross_amount', 'unresolved', -1, 'USD', 1, 1, $5),
      ($2, 'restore:refund:unresolved-fee', $3, 'refund', $4,
        'fee', 'unresolved', 0, 'USD', 1, 1, $5)
  `, [
    unresolvedGrossSetId,
    unresolvedFeeSetId,
    unresolvedTransactionId,
    unresolvedRefundId,
    unresolvedFingerprint
  ]);
  await pool.query(`
    insert into stripe_balance_transaction_fee_details (
      id, balance_transaction_id, ordinal, raw_type, amount_minor, currency,
      fingerprint_sha256
    ) values ($1, $2, 0, 'stripe_fee', 0, 'USD', $3)
  `, [unresolvedFeeDetailId, unresolvedTransactionId, 'd'.repeat(64)]);
  await pool.query(`
    insert into financial_classification_versions (
      subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ('fee_detail', $1, 1, 'processing_fee', $2)
  `, [unresolvedFeeDetailId, 'd'.repeat(64)]);
  await expectRejection(
    'unresolved refund zero fee detail still requires a refund-valid classification',
    'financial_fee_detail_semantic_classification=1'
  );
  await mutateAppendOnlyFixture(`
    update financial_classification_versions set classification = 'refund_fee'
    where subject_type = 'fee_detail' and subject_id = $1
      and classifier_version = 1 and source_fingerprint_sha256 = $2
  `, [unresolvedFeeDetailId, 'd'.repeat(64)]);
  await expectPass('unresolved refund zero fee detail classification repair', true);
  await mutateAppendOnlyFixture(`
    update financial_classification_versions set classification = 'refund_failure'
    where subject_type = 'balance_transaction' and subject_id = $1
      and classifier_version = 1 and source_fingerprint_sha256 = $2
  `, [unresolvedTransactionId, unresolvedFingerprint]);
  await expectRejection(
    'unresolved refund fee details require an exact refund parent classification',
    'financial_fee_detail_semantic_classification=1'
  );
  await mutateAppendOnlyFixture(`
    update financial_classification_versions set classification = 'refund'
    where subject_type = 'balance_transaction' and subject_id = $1
      and classifier_version = 1 and source_fingerprint_sha256 = $2
  `, [unresolvedTransactionId, unresolvedFingerprint]);
  await expectPass('unresolved refund parent classification repair', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = 1, exchange_source_currency = 'EUR',
      exchange_target_currency = 'USD'
    where id = $1
  `, [unresolvedTransactionId]);
  await expectRejection(
    'same-currency refund cannot carry rogue exchange evidence',
    'allocation_set_semantic_source=2'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set currency = 'EUR', exchange_rate = 0.9,
      exchange_source_currency = 'USD', exchange_target_currency = 'EUR'
    where id = $1
  `, [unresolvedTransactionId]);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transaction_fee_details set currency = 'EUR'
    where balance_transaction_id = $1
  `, [unresolvedTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets set currency = 'EUR'
    where balance_transaction_id = $1
  `, [unresolvedTransactionId]);
  await expectPass('cross-currency refund exact exchange evidence', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = null, exchange_source_currency = null,
      exchange_target_currency = null
    where id = $1
  `, [unresolvedTransactionId]);
  await expectRejection(
    'cross-currency refund requires exchange evidence',
    'allocation_set_semantic_source=2'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = 0.9, exchange_source_currency = 'GBP',
      exchange_target_currency = 'EUR'
    where id = $1
  `, [unresolvedTransactionId]);
  await expectRejection(
    'cross-currency refund exchange source must match the refund currency',
    'allocation_set_semantic_source=2'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set currency = 'USD', exchange_rate = null,
      exchange_source_currency = null, exchange_target_currency = null
    where id = $1
  `, [unresolvedTransactionId]);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transaction_fee_details set currency = 'USD'
    where balance_transaction_id = $1
  `, [unresolvedTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets set currency = 'USD'
    where balance_transaction_id = $1
  `, [unresolvedTransactionId]);
  await expectPass('refund exchange evidence witness cleanup', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set amount_minor = -2, net_minor = -2 where id = $1
  `, [unresolvedTransactionId]);
  await expectRejection(
    'same-currency primary-refund source-principal corruption',
    'allocation_set_semantic_source=2'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set amount_minor = -1, net_minor = -1 where id = $1
  `, [unresolvedTransactionId]);
  await expectPass('same-currency primary-refund source-principal repair', true);

  const correctionAdminId = '46000000-0000-4000-8000-000000000001';
  const correctionTransactionId = '46000000-0000-4000-8000-000000000002';
  const correctionAllocationSetId = '46000000-0000-4000-8000-000000000003';
  const correctionFinancialItemId = '46000000-0000-4000-8000-000000000004';
  const correctionSetId = '46000000-0000-4000-8000-000000000005';
  const correctionItemId = '46000000-0000-4000-8000-000000000006';
  const correctionReplacementSetId = '46000000-0000-4000-8000-000000000007';
  const correctionReplacementItemId = '46000000-0000-4000-8000-000000000008';
  const correctionParentV2Id = '46000000-0000-4000-8000-000000000009';
  const correctionSuccessorId = '46000000-0000-4000-8000-00000000000a';
  const correctionSuccessorItemId = '46000000-0000-4000-8000-00000000000b';
  const correctionPresentmentFirstId = '46000000-0000-4000-8000-00000000000c';
  const correctionPresentmentSecondId = '46000000-0000-4000-8000-00000000000d';
  const correctionSuccessorPresentmentFirstId =
    '46000000-0000-4000-8000-00000000000e';
  const correctionSuccessorPresentmentSecondId =
    '46000000-0000-4000-8000-00000000000f';
  const correctionSecondFinancialItemId = '46000000-0000-4000-8000-000000000010';
  const correctionReplacementSecondItemId =
    '46000000-0000-4000-8000-000000000011';
  const correctionSecondItemId = '46000000-0000-4000-8000-000000000012';
  const correctionSuccessorSecondItemId =
    '46000000-0000-4000-8000-000000000013';
  const correctionRefundId = '46000000-0000-4000-8000-000000000014';
  const correctionRefundAllocationId = '46000000-0000-4000-8000-000000000015';
  const correctionSourceOrderId = '46000000-0000-4000-8000-000000000016';
  const correctionSourceItemId = '46000000-0000-4000-8000-000000000017';
  const correctionPaymentId = '46000000-0000-4000-8000-000000000018';
  const correctionTargetItemId = '46000000-0000-4000-8000-00000000001a';
  const correctionTargetSettlementItemId = '46000000-0000-4000-8000-00000000001b';
  const correctionTargetPresentmentItemId = '46000000-0000-4000-8000-00000000001c';
  const correctionSuccessorTargetSettlementItemId =
    '46000000-0000-4000-8000-00000000001d';
  const correctionSuccessorTargetPresentmentItemId =
    '46000000-0000-4000-8000-00000000001e';
  const correctionUnrelatedOrderId = '46100000-0000-4000-8000-000000000001';
  const correctionUnrelatedItemId = '46100000-0000-4000-8000-000000000002';
  const correctionFingerprint = 'a'.repeat(64);
  await pool.query(`
    insert into "user" (id, name, email, email_verified)
    values ($1, 'Restore correction admin', 'restore-correction@example.invalid', true)
  `, [correctionAdminId]);
  await pool.query(`
    insert into orders (
      id, status, currency, subtotal_minor, tax_minor, total_minor,
      client_checkout_attempt_id, quote_fingerprint_sha256, status_token_sha256
    ) values (
      $1, 'checkout_pending', 'USD', 5, 1, 6,
      '46000000-0000-4000-8000-000000000019', repeat('7', 64), repeat('8', 64)
    )
  `, [correctionSourceOrderId]);
  await pool.query(`
    insert into order_items (
      id, order_id, title_id, title_snapshot, creator_name_snapshot, format,
      currency, unit_subtotal_minor, tax_minor, total_minor
    ) values
      ($1, $2, $3, 'Correction source witness', 'Witness', 'prose',
        'USD', 3, 1, 4),
      ($4, $2, $5, 'Correction target witness', 'Witness', 'prose',
        'USD', 2, 0, 2)
  `, [
    correctionSourceItemId,
    correctionSourceOrderId,
    firstTitleId,
    correctionTargetItemId,
    secondTitleId
  ]);
  await pool.query(`
    insert into payments (
      id, order_id, stripe_payment_intent_id, status, amount_minor, currency
    ) values ($1, $2, 'pi_restore_correction_source', 'pending', 6, 'USD')
  `, [correctionPaymentId, correctionSourceOrderId]);
  await pool.query(`
    insert into orders (
      id, status, currency, subtotal_minor, tax_minor, total_minor,
      client_checkout_attempt_id, quote_fingerprint_sha256, status_token_sha256
    ) values (
      $1, 'checkout_pending', 'USD', 1, 0, 1,
      '46100000-0000-4000-8000-000000000003', repeat('d', 64), repeat('e', 64)
    )
  `, [correctionUnrelatedOrderId]);
  await pool.query(`
    insert into order_items (
      id, order_id, title_id, title_snapshot, creator_name_snapshot, format,
      currency, unit_subtotal_minor, tax_minor, total_minor
    ) values (
      $1, $2, $3, 'Unrelated correction witness', 'Witness', 'prose',
      'USD', 1, 0, 1
    )
  `, [correctionUnrelatedItemId, correctionUnrelatedOrderId, firstTitleId]);
  await pool.query(`
    insert into refunds (
      id, payment_id, stripe_refund_id, status, amount_minor, currency,
      provider_created_at, allocation_status
    ) values (
      $1, $2, 're_restore_correction', 'succeeded', 3, 'USD',
      '2026-08-05T00:00:00.000Z', 'finalized'
    )
  `, [correctionRefundId, correctionPaymentId]);
  await pool.query(`
    insert into refund_allocations (id, refund_id, order_item_id, amount_minor, source)
    values ($1, $2, $3, 3, 'automatic')
  `, [correctionRefundAllocationId, correctionRefundId, correctionSourceItemId]);
  await pool.query(`
    insert into refund_allocation_components (
      refund_allocation_id, refund_id, order_item_id,
      subtotal_minor, tax_minor, total_minor, currency
    ) values ($1, $2, $3, 2, 1, 3, 'USD')
  `, [correctionRefundAllocationId, correctionRefundId, correctionSourceItemId]);
  await pool.query(`
    insert into stripe_balance_transactions (
      id, provider_id, live_mode, source_family, source_id, raw_type,
      reporting_category, balance_type, amount_minor, fee_minor, net_minor,
      currency, status, provider_created_at, available_at, fingerprint_sha256
    ) values (
      $1, 'bt_restore_correction_semantics', false, 'refund',
      're_restore_correction', 'refund', 'refund', 'payments',
      -3, 0, -3, 'USD', 'available', '2026-08-05T00:00:00.000Z',
      '2026-08-05T00:00:00.000Z', $2
    )
  `, [correctionTransactionId, correctionFingerprint]);
  await pool.query(`
    insert into financial_classification_versions (
      subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ('balance_transaction', $1, 1, 'refund', $2)
  `, [correctionTransactionId, correctionFingerprint]);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256
    ) values (
      $1, 'restore:refund:correction-semantics', $2, 'refund', $3,
      'gross_amount', 'title', -3, 'USD', 1, 1, $4
    )
  `, [
    correctionAllocationSetId,
    correctionTransactionId,
    correctionRefundId,
    correctionFingerprint
  ]);
  await pool.query(`
    insert into financial_item_allocations (
      id, allocation_set_id, order_item_id, component, effect_minor, currency,
      tie_break_key
    ) values
      ($1, $3, $4, 'refund_subtotal', -2, 'USD',
        'restore:refund:correction-base:subtotal'),
      ($2, $3, $4, 'refund_tax', -1, 'USD',
        'restore:refund:correction-base:tax')
  `, [
    correctionFinancialItemId,
    correctionSecondFinancialItemId,
    correctionAllocationSetId,
    correctionSourceItemId
  ]);
  await expectPass('refund title allocation deterministic baseline', true);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations
    set effect_minor = case id when $1 then -1 else -2 end
    where id in ($1, $2)
  `, [correctionFinancialItemId, correctionSecondFinancialItemId]);
  await expectRejection(
    'balanced refund component redistribution is not deterministic',
    'financial_title_allocation_determinism=1'
  );
  await mutateAppendOnlyFixture(`
    update financial_item_allocations
    set effect_minor = case id when $1 then -2 else -1 end
    where id in ($1, $2)
  `, [correctionFinancialItemId, correctionSecondFinancialItemId]);
  await expectPass('refund title allocation deterministic repair', true);
  await pool.query(`
    insert into refund_reporting_correction_sets (
      id, refund_id, correction_version, kind, base_allocation_set_id,
      source_fingerprint_sha256, approved_by_admin_id, created_by_admin_id,
      correlation_id
    ) values (
      $1, $2, 1, 'allocation_attribution_correction', $3, $4, $5, $5,
      'restore-correction-semantics'
    )
  `, [
    correctionSetId,
    correctionRefundId,
    correctionAllocationSetId,
    correctionFingerprint,
    correctionAdminId
  ]);
  await pool.query(`
    insert into refund_reporting_correction_items (
      id, correction_set_id, domain, source_allocation_set_id, order_item_id,
      component, currency, approved_absolute_minor, delta_minor,
      stable_tie_break_key
    ) values
      ($1, $2, 'settlement', $3, $4, 'refund_subtotal', 'USD', -1, 1,
        'restore:refund:correction-item:subtotal'),
      ($7, $2, 'settlement', $3, $4, 'refund_tax', 'USD', 0, 1,
        'restore:refund:correction-item:tax'),
      ($8, $2, 'settlement', $3, $9, 'refund_subtotal', 'USD', -2, -2,
        'restore:refund:correction-item:target-subtotal'),
      ($5, $2, 'presentment', null, $4, 'refund_subtotal', 'USD', 1, -1,
        'restore:refund:correction-presentment-subtotal'),
      ($6, $2, 'presentment', null, $4, 'refund_tax', 'USD', 0, -1,
        'restore:refund:correction-presentment-tax'),
      ($10, $2, 'presentment', null, $9, 'refund_subtotal', 'USD', 2, 2,
        'restore:refund:correction-presentment-target-subtotal')
  `, [
    correctionItemId,
    correctionSetId,
    correctionAllocationSetId,
    correctionSourceItemId,
    correctionPresentmentFirstId,
    correctionPresentmentSecondId,
    correctionSecondItemId,
    correctionTargetSettlementItemId,
    correctionTargetItemId,
    correctionTargetPresentmentItemId
  ]);
  await pool.query(`
    insert into financial_classification_versions (
      id, subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ($1, 'balance_transaction', $2, 2, 'refund', $3)
  `, [correctionParentV2Id, correctionTransactionId, correctionFingerprint]);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256,
      supersedes_set_id
    ) values (
      $1, 'restore:refund:correction-semantics:v2', $2, 'refund', $3,
      'gross_amount', 'title', -3, 'USD', 2, 2, $4, $5
    )
  `, [
    correctionReplacementSetId,
    correctionTransactionId,
    correctionRefundId,
    correctionFingerprint,
    correctionAllocationSetId
  ]);
  await pool.query(`
    insert into financial_item_allocations (
      id, allocation_set_id, order_item_id, component, effect_minor, currency,
      tie_break_key
    ) values
      ($1, $3, $4, 'refund_subtotal', -2, 'USD',
        'restore:refund:correction-base:subtotal:v2'),
      ($2, $3, $4, 'refund_tax', -1, 'USD',
        'restore:refund:correction-base:tax:v2')
  `, [
    correctionReplacementItemId,
    correctionReplacementSecondItemId,
    correctionReplacementSetId,
    correctionSourceItemId
  ]);
  await pool.query(`
    insert into refund_reporting_correction_sets (
      id, refund_id, correction_version, kind, base_allocation_set_id,
      predecessor_correction_set_id, source_fingerprint_sha256,
      approved_by_admin_id, created_by_admin_id, correlation_id
    ) values (
      $1, $2, 2, 'classifier_rebase', $3, $4, $5, $6, null,
      'restore-correction-semantics-v2'
    )
  `, [
    correctionSuccessorId,
    correctionRefundId,
    correctionReplacementSetId,
    correctionSetId,
    correctionFingerprint,
    correctionAdminId
  ]);
  await pool.query(`
    insert into refund_reporting_correction_items (
      id, correction_set_id, domain, source_allocation_set_id, order_item_id,
      component, currency, approved_absolute_minor, delta_minor,
      stable_tie_break_key
    ) values
      ($1, $2, 'settlement', $3, $4, 'refund_subtotal', 'USD', -1, 1,
        'restore:refund:correction-item:subtotal:v2'),
      ($7, $2, 'settlement', $3, $4, 'refund_tax', 'USD', 0, 1,
        'restore:refund:correction-item:tax:v2'),
      ($8, $2, 'settlement', $3, $9, 'refund_subtotal', 'USD', -2, -2,
        'restore:refund:correction-item:target-subtotal:v2'),
      ($5, $2, 'presentment', null, $4, 'refund_subtotal', 'USD', 1, -1,
        'restore:refund:correction-presentment-subtotal:v2'),
      ($6, $2, 'presentment', null, $4, 'refund_tax', 'USD', 0, -1,
        'restore:refund:correction-presentment-tax:v2'),
      ($10, $2, 'presentment', null, $9, 'refund_subtotal', 'USD', 2, 2,
        'restore:refund:correction-presentment-target-subtotal:v2')
  `, [
    correctionSuccessorItemId,
    correctionSuccessorId,
    correctionReplacementSetId,
    correctionSourceItemId,
    correctionSuccessorPresentmentFirstId,
    correctionSuccessorPresentmentSecondId,
    correctionSuccessorSecondItemId,
    correctionSuccessorTargetSettlementItemId,
    correctionTargetItemId,
    correctionSuccessorTargetPresentmentItemId
  ]);
  const expectCurrentCorrectionHead = async (name: string): Promise<void> => {
    const result = await pool.query<{
      compatible_correction_tip_id: string | null;
      is_complete: boolean;
      proposed_issue_code: string | null;
    }>(`
      select compatible_correction_tip_id, is_complete, proposed_issue_code
      from current_financial_projection_heads
      where balance_transaction_id = $1 and basis = 'gross_amount'
    `, [correctionTransactionId]);
    const head = result.rows[0];
    if (
      result.rowCount !== 1 ||
      head?.compatible_correction_tip_id !== correctionSetId ||
      head.is_complete !== true ||
      head.proposed_issue_code !== null
    ) {
      failures.push(`${name} was masked by the current correction projection`);
    }
  };
  await expectPass('refund correction component semantics baseline', true);
  await expectCurrentCorrectionHead('active correction baseline');
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_items set component = 'refund_fee' where id = $1
  `, [correctionSuccessorItemId]);
  await expectCurrentCorrectionHead('pending correction component corruption');
  await expectRejection(
    'pending refund gross correction cannot masquerade as a fee component',
    'refund_reporting_correction_item_semantics=1'
  );
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_items set component = 'refund_subtotal' where id = $1
  `, [correctionSuccessorItemId]);
  await expectPass('refund correction component semantics repair', true);
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_items
    set approved_absolute_minor = 0
    where id = $1
  `, [correctionSuccessorItemId]);
  await expectCurrentCorrectionHead('pending correction arithmetic corruption');
  await expectRejection(
    'pending correction approved absolute must equal base plus delta',
    'refund_reporting_correction_history_semantics=1'
  );
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_items
    set approved_absolute_minor = -1
    where id = $1
  `, [correctionSuccessorItemId]);
  await expectPass('pending correction arithmetic repair', true);
  await mutateAppendOnlyFixture(`
    delete from refund_reporting_correction_items where id = $1
  `, [correctionSuccessorSecondItemId]);
  await expectCurrentCorrectionHead('pending correction coverage corruption');
  await expectRejection(
    'pending correction must cover every nonzero touched settlement base',
    'refund_reporting_correction_history_semantics=1'
  );
  await pool.query(`
    insert into refund_reporting_correction_items (
      id, correction_set_id, domain, source_allocation_set_id, order_item_id,
      component, currency, approved_absolute_minor, delta_minor,
      stable_tie_break_key
    ) values (
      $1, $2, 'settlement', $3, $4, 'refund_tax', 'USD', 0, 1,
      'restore:refund:correction-item:tax:v2'
    )
  `, [
    correctionSuccessorSecondItemId,
    correctionSuccessorId,
    correctionReplacementSetId,
    correctionSourceItemId
  ]);
  await expectPass('pending correction settlement coverage repair', true);
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_items set order_item_id = $2 where id = $1
  `, [correctionSuccessorItemId, correctionUnrelatedItemId]);
  await expectCurrentCorrectionHead('pending correction owner corruption');
  await expectRejection(
    'pending correction item must retain its immutable base owner',
    'refund_reporting_correction_history_semantics=1'
  );
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_items set order_item_id = $2 where id = $1
  `, [correctionSuccessorItemId, correctionSourceItemId]);
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_items set currency = 'EUR' where id = $1
  `, [correctionSuccessorItemId]);
  await expectCurrentCorrectionHead('pending correction currency corruption');
  await expectRejection(
    'pending correction item must retain its source currency',
    'refund_reporting_correction_history_semantics=1'
  );
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_items set currency = 'USD' where id = $1
  `, [correctionSuccessorItemId]);
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_sets
    set source_fingerprint_sha256 = repeat('b', 64) where id = $1
  `, [correctionSuccessorId]);
  await expectCurrentCorrectionHead('pending correction fingerprint corruption');
  await expectRejection(
    'pending correction anchor must retain its immutable source fingerprint',
    'refund_reporting_correction_history_semantics=1'
  );
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_sets
    set source_fingerprint_sha256 = $2 where id = $1
  `, [correctionSuccessorId, correctionFingerprint]);
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_items
    set approved_absolute_minor = case id when $1 then 0 else 3 end,
      delta_minor = case id when $1 then -2 else 3 end
    where id in ($1, $2)
  `, [
    correctionSuccessorPresentmentFirstId,
    correctionSuccessorTargetPresentmentItemId
  ]);
  await expectCurrentCorrectionHead('pending correction capacity corruption');
  await expectRejection(
    'pending correction presentment stays within immutable item capacity',
    'refund_reporting_correction_history_semantics=1'
  );
  await mutateAppendOnlyFixture(`
    update refund_reporting_correction_items
    set approved_absolute_minor = case id when $1 then 1 else 2 end,
      delta_minor = case id when $1 then -1 else 2 end
    where id in ($1, $2)
  `, [
    correctionSuccessorPresentmentFirstId,
    correctionSuccessorTargetPresentmentItemId
  ]);
  await expectPass('correction history repairs', true);
  await pool.query(`
    update refunds set allocation_status = 'exception' where id = $1
  `, [correctionRefundId]);
  await expectCurrentCorrectionHead('active correction refund exception status');
  await expectPass('correction history survives later refund exception status', true);
  await pool.query(`
    update refunds set allocation_status = 'finalized' where id = $1
  `, [correctionRefundId]);

  await pool.query(`
    update refunds set allocation_status = 'exception' where id = $1
  `, [capacityRefundTwoId]);
  await expectPass('component-backed refund preserved in exception allocation state', true);
  await pool.query(`
    update refunds set allocation_status = 'needs_review' where id = $1
  `, [capacityRefundTwoId]);
  await expectRejection(
    'component-backed refund in a mutable allocation state',
    'refund_component_chronology_capacity=1'
  );
  await pool.query(`
    update refunds set allocation_status = 'exception' where id = $1
  `, [capacityRefundTwoId]);

  const combinedOrderId = '40000000-0000-4000-8000-000000000001';
  const combinedFirstTitleId = '40000000-0000-4000-8000-000000000002';
  const combinedSecondTitleId = '40000000-0000-4000-8000-000000000003';
  const combinedFirstItemId = '40000000-0000-4000-8000-000000000004';
  const combinedSecondItemId = '40000000-0000-4000-8000-000000000005';
  const combinedPaymentId = '40000000-0000-4000-8000-000000000006';
  const combinedDisputeId = '40000000-0000-4000-8000-0000000000f0';
  const combinedRefundId = '40000000-0000-4000-8000-000000000014';
  const combinedRefundAllocationId = '40000000-0000-4000-8000-000000000015';
  const combinedRefundComponentId = '40000000-0000-4000-8000-000000000016';
  const combinedStripeDisputeId = 'dp_restore_combined_valid';
  await pool.query(`
    insert into titles (id, slug, title, description, creator_name, format, price_minor, currency)
    values
      ($1, 'restore-combined-first', 'Restore combined first', 'Witness', 'Witness',
        'prose', 100, 'USD'),
      ($2, 'restore-combined-second', 'Restore combined second', 'Witness', 'Witness',
        'prose', 100, 'USD')
  `, [combinedFirstTitleId, combinedSecondTitleId]);
  await pool.query(`
    insert into orders (
      id, status, currency, subtotal_minor, tax_minor, total_minor,
      client_checkout_attempt_id, quote_fingerprint_sha256, status_token_sha256
    ) values ($1, 'checkout_pending', 'USD', 200, 0, 200,
      '40000000-0000-4000-8000-000000000027', repeat('4', 64), repeat('5', 64))
  `, [combinedOrderId]);
  await pool.query(`
    insert into order_items (
      id, order_id, title_id, title_snapshot, creator_name_snapshot, format,
      currency, unit_subtotal_minor, tax_minor, total_minor
    ) values
      ($1, $3, $4, 'Restore combined first', 'Witness', 'prose', 'USD', 100, 0, 100),
      ($2, $3, $5, 'Restore combined second', 'Witness', 'prose', 'USD', 100, 0, 100)
  `, [
    combinedFirstItemId,
    combinedSecondItemId,
    combinedOrderId,
    combinedFirstTitleId,
    combinedSecondTitleId
  ]);
  await pool.query(`
    insert into payments (
      id, order_id, stripe_payment_intent_id, status, amount_minor, currency, paid_at
    ) values ($1, $2, 'pi_restore_combined_chronology', 'succeeded', 200, 'USD',
      '2026-08-05T00:00:00.000Z')
  `, [combinedPaymentId, combinedOrderId]);
  await pool.query(`
    insert into disputes (
      id, payment_id, stripe_dispute_id, status, amount_minor, currency,
      provider_created_at, provider_updated_at
    ) values ($1, $2, $3, 'open', 100, 'USD',
      '2026-08-06T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
  `, [combinedDisputeId, combinedPaymentId, combinedStripeDisputeId]);

  const firstWithdrawalAllocationId = '40000000-0000-4000-8000-000000000011';
  const firstWithdrawalSetId = '40000000-0000-4000-8000-00000000000b';
  await insertDisputeEffect({
    allocationId: firstWithdrawalAllocationId,
    disputeId: combinedDisputeId,
    effect: 'withdrawal',
    financialItemId: '40000000-0000-4000-8000-00000000000e',
    fingerprintCharacter: '6',
    orderItemId: combinedFirstItemId,
    providerCreatedAt: '2026-08-06T00:00:00.000Z',
    providerId: 'bt_restore_combined_withdraw_1',
    reversalOfSetId: null,
    reversesAllocationId: null,
    setId: firstWithdrawalSetId,
    signedSubtotalMinor: -100,
    stripeDisputeId: combinedStripeDisputeId,
    transactionId: '40000000-0000-4000-8000-000000000008'
  });
  await insertDisputeEffect({
    allocationId: '40000000-0000-4000-8000-000000000012',
    disputeId: combinedDisputeId,
    effect: 'reinstatement',
    financialItemId: '40000000-0000-4000-8000-00000000000f',
    fingerprintCharacter: '7',
    orderItemId: combinedFirstItemId,
    providerCreatedAt: '2026-08-07T00:00:00.000Z',
    providerId: 'bt_restore_a_reinstate',
    reversalOfSetId: firstWithdrawalSetId,
    reversesAllocationId: firstWithdrawalAllocationId,
    setId: '40000000-0000-4000-8000-00000000000c',
    signedSubtotalMinor: 100,
    stripeDisputeId: combinedStripeDisputeId,
    transactionId: '40000000-0000-4000-8000-000000000009'
  });
  await pool.query(`
    insert into refunds (
      id, payment_id, stripe_refund_id, status, amount_minor, currency,
      provider_created_at, allocation_status
    ) values ($1, $2, 're_restore_z_refund', 'succeeded', 50, 'USD',
      '2026-08-07T00:00:00.000Z', 'finalized')
  `, [combinedRefundId, combinedPaymentId]);
  await pool.query(`
    insert into refund_allocations (id, refund_id, order_item_id, amount_minor, source)
    values ($1, $2, $3, 50, 'automatic')
  `, [combinedRefundAllocationId, combinedRefundId, combinedFirstItemId]);
  await pool.query(`
    insert into refund_allocation_components (
      id, refund_allocation_id, refund_id, order_item_id,
      subtotal_minor, tax_minor, total_minor, currency
    ) values ($1, $2, $3, $4, 50, 0, 50, 'USD')
  `, [
    combinedRefundComponentId,
    combinedRefundAllocationId,
    combinedRefundId,
    combinedFirstItemId
  ]);
  const secondWithdrawalTransactionId = '40000000-0000-4000-8000-00000000000a';
  const secondWithdrawalSetId = '40000000-0000-4000-8000-00000000000d';
  const secondWithdrawalAllocationId = '40000000-0000-4000-8000-000000000013';
  await insertDisputeEffect({
    allocationId: secondWithdrawalAllocationId,
    disputeId: combinedDisputeId,
    effect: 'withdrawal',
    financialItemId: '40000000-0000-4000-8000-000000000010',
    fingerprintCharacter: '8',
    orderItemId: combinedFirstItemId,
    providerCreatedAt: '2026-08-08T00:00:00.000Z',
    providerId: 'bt_restore_combined_withdraw_2',
    reversalOfSetId: null,
    reversesAllocationId: null,
    setId: secondWithdrawalSetId,
    signedSubtotalMinor: -50,
    stripeDisputeId: combinedStripeDisputeId,
    transactionId: secondWithdrawalTransactionId
  });
  await expectPass(
    'withdrawal, reinstatement, equal-time refund, and second withdrawal chronology',
    true
  );
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = -99, tax_effect_minor = 0, total_effect_minor = -99
    where id = $1
  `, [firstWithdrawalAllocationId]);
  await expectRejection(
    'first dispute withdrawal presentment/source-principal corruption',
    'dispute_first_withdrawal_source_principal=1'
  );
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = -100, tax_effect_minor = 0, total_effect_minor = -100
    where id = $1
  `, [firstWithdrawalAllocationId]);
  await expectPass('first dispute withdrawal presentment/source-principal repair', true);
  await expectPass('later dispute withdrawal settlement remains independent', true);

  const legacyDisputeIssueId = '44000000-0000-4000-8000-000000000001';
  const legacyAllocationIssueId = '44000000-0000-4000-8000-000000000002';
  const unrelatedAllocationIssueId = '44000000-0000-4000-8000-000000000003';
  await pool.query(`
    insert into financial_reconciliation_issues (
      id, resource_type, resource_id, safe_code, impact, correlation_id
    ) values
      ($1, 'dispute', $4, 'currency_mismatch', 'exception',
        'restore-legacy-dispute-resolution'),
      ($2, 'allocation_set', $5, 'allocation_mismatch', 'exception',
        'restore-legacy-allocation-resolution'),
      ($3, 'allocation_set', $5, 'allocation_fork', 'exception',
        'restore-unrelated-allocation-resolution')
  `, [
    legacyDisputeIssueId,
    legacyAllocationIssueId,
    unrelatedAllocationIssueId,
    combinedDisputeId,
    firstWithdrawalSetId
  ]);
  const legacyAuditIds: string[] = [];
  for (const [issueId, correlationId] of [
    [legacyDisputeIssueId, 'restore-legacy-dispute-audit'],
    [legacyAllocationIssueId, 'restore-legacy-allocation-audit'],
    [unrelatedAllocationIssueId, 'restore-unrelated-allocation-audit']
  ] as const) {
    await pool.query(`
      select * from resolve_financial_issue_after_worker_recompute($1, $2)
    `, [issueId, correlationId]);
    const auditResult = await pool.query<{ id: string }>(`
      select id
      from audit_events
      where action = 'financial.issue.resolved' and resource_id = $1::text
    `, [issueId]);
    const auditId = auditResult.rows[0]?.id;
    if (!auditId) throw new Error('[restore-verifier] missing legacy issue audit witness');
    legacyAuditIds.push(auditId);
  }
  const [legacyDisputeAuditId, legacyAllocationAuditId, unrelatedAllocationAuditId] =
    legacyAuditIds;
  if (!legacyDisputeAuditId || !legacyAllocationAuditId || !unrelatedAllocationAuditId) {
    throw new Error('[restore-verifier] incomplete legacy issue audit witnesses');
  }
  await mutateAppendOnlyFixture(`
    update audit_events set actor_id = 'commerce-worker' where id = $1
  `, [legacyDisputeAuditId]);
  await expectPass('legacy commerce-worker dispute resolution audit', true);
  await mutateAppendOnlyFixture(`
    update audit_events set actor_id = 'commerce-worker' where id = $1
  `, [legacyAllocationAuditId]);
  await expectPass('legacy commerce-worker allocation-set resolution audit', true);
  await mutateAppendOnlyFixture(`
    update audit_events set actor_id = 'commerce-worker' where id = $1
  `, [resolvedAuditId]);
  await expectRejection(
    'commerce-worker cannot resolve a payout issue',
    'resolved_issue_audit_provenance=2'
  );
  await mutateAppendOnlyFixture(`
    update audit_events set actor_id = 'financial-worker' where id = $1
  `, [resolvedAuditId]);
  await mutateAppendOnlyFixture(`
    update audit_events set actor_id = 'commerce-worker' where id = $1
  `, [unrelatedAllocationAuditId]);
  await expectRejection(
    'commerce-worker cannot resolve an unrelated allocation-set issue',
    'resolved_issue_audit_provenance=2'
  );
  await mutateAppendOnlyFixture(`
    update audit_events set actor_id = 'financial-worker' where id = $1
  `, [unrelatedAllocationAuditId]);
  await expectPass('legacy commerce-worker audit witness repair', true);

  const unrelatedDisputeId = '43000000-0000-4000-8000-000000000001';
  await pool.query(`
    insert into disputes (
      id, payment_id, stripe_dispute_id, status, amount_minor, currency,
      provider_created_at, provider_updated_at
    ) values ($1, $2, 'dp_restore_unrelated_owner', 'open', 4, 'USD',
      '2026-08-08T00:30:00.000Z', '2026-08-08T00:30:00.000Z')
  `, [unrelatedDisputeId, paymentId]);
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets set source_internal_id = $1 where id = $2
  `, [unrelatedDisputeId, firstWithdrawalSetId]);
  await expectRejection(
    'allocation set names an unrelated existing provider source owner',
    'allocation_set_semantic_source=1'
  );
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets set source_internal_id = $1 where id = $2
  `, [combinedDisputeId, firstWithdrawalSetId]);
  await expectPass('allocation set provider source owner repair', true);

  const firstWithdrawalFinancialItemId = '40000000-0000-4000-8000-00000000000e';
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set order_item_id = $1 where id = $2
  `, [firstItemId, firstWithdrawalFinancialItemId]);
  await expectRejection(
    'allocation item belongs to an unrelated existing order graph',
    'financial_item_allocation_parent=1'
  );
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set order_item_id = $1 where id = $2
  `, [combinedFirstItemId, firstWithdrawalFinancialItemId]);
  await expectPass('allocation item owner graph repair', true);

  const feeCreditTransactionId = '41000000-0000-4000-8000-000000000001';
  const feeCreditGrossSetId = '41000000-0000-4000-8000-000000000002';
  const feeCreditFeeSetId = '41000000-0000-4000-8000-000000000003';
  const feeCreditFingerprint = 'd'.repeat(64);
  const withdrawalFeeDetailId = '41000000-0000-4000-8000-000000000005';
  const withdrawalFeeSetId = '41000000-0000-4000-8000-000000000006';
  const withdrawalFeeFingerprint = '1'.repeat(64);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set fee_minor = 10, net_minor = -60
    where id = $1
  `, [secondWithdrawalTransactionId]);
  await pool.query(`
    insert into stripe_balance_transaction_fee_details (
      id, balance_transaction_id, ordinal, raw_type, amount_minor, currency,
      fingerprint_sha256
    ) values ($1, $2, 0, 'stripe_fee', 10, 'USD', $3)
  `, [withdrawalFeeDetailId, secondWithdrawalTransactionId, withdrawalFeeFingerprint]);
  await pool.query(`
    insert into financial_classification_versions (
      subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ('fee_detail', $1, 1, 'dispute_fee', $2)
  `, [withdrawalFeeDetailId, withdrawalFeeFingerprint]);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256
    ) values (
      $1, 'restore:fee-credit:causal-withdrawal-fee', $2, 'dispute', $3,
      'fee', 'title', -10, 'USD', 1, 1, repeat('8', 64)
    )
  `, [withdrawalFeeSetId, secondWithdrawalTransactionId, combinedDisputeId]);
  await pool.query(`
    insert into financial_item_allocations (
      id, allocation_set_id, order_item_id, component, effect_minor, currency,
      tie_break_key
    ) values (
      '41000000-0000-4000-8000-000000000007', $1, $2,
      'dispute_fee', -10, 'USD', 'fee-credit:causal-withdrawal-fee'
    )
  `, [withdrawalFeeSetId, combinedFirstItemId]);
  await pool.query(`
    insert into stripe_balance_transactions (
      id, provider_id, live_mode, source_family, source_id, raw_type,
      reporting_category, balance_type, amount_minor, fee_minor, net_minor,
      currency, status, provider_created_at, available_at, fingerprint_sha256
    ) values (
      $1, 'bt_restore_fee_credit', false, 'dispute', $2, 'stripe_fee',
      'fee', 'payments', 10, 0, 10, 'USD', 'available',
      '2026-08-08T01:00:00.000Z', '2026-08-08T01:00:00.000Z', $3
    )
  `, [feeCreditTransactionId, combinedStripeDisputeId, feeCreditFingerprint]);
  await pool.query(`
    insert into financial_classification_versions (
      subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ('balance_transaction', $1, 1, 'fee_credit', $2)
  `, [feeCreditTransactionId, feeCreditFingerprint]);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256
    ) values
      ($1, 'restore:fee-credit:gross', $3, 'dispute', $4, 'gross_amount',
        'title', 10, 'USD', 1, 1, $5),
      ($2, 'restore:fee-credit:fee', $3, 'dispute', $4, 'fee',
        'title', 0, 'USD', 1, 1, $5)
  `, [
    feeCreditGrossSetId,
    feeCreditFeeSetId,
    feeCreditTransactionId,
    combinedDisputeId,
    feeCreditFingerprint
  ]);
  await pool.query(`
    insert into financial_item_allocations (
      id, allocation_set_id, order_item_id, component, effect_minor, currency,
      tie_break_key
    ) values (
      '41000000-0000-4000-8000-000000000004', $1, $2,
      'fee_credit', 10, 'USD', 'fee-credit:settlement'
    )
  `, [feeCreditGrossSetId, combinedFirstItemId]);
  await expectPass('fee credit legitimately has no dispute presentment children', true);

  const childlessDisputeId = '42000000-0000-4000-8000-000000000009';
  const childlessStripeDisputeId = 'dp_restore_childless_presentment';
  await pool.query(`
    insert into disputes (
      id, payment_id, stripe_dispute_id, status, amount_minor, currency,
      provider_created_at, provider_updated_at
    ) values ($1, $2, $3, 'open', 10, 'USD',
      '2026-08-08T02:00:00.000Z', '2026-08-08T03:00:00.000Z')
  `, [childlessDisputeId, combinedPaymentId, childlessStripeDisputeId]);
  const childlessWithdrawalTransactionId = '42000000-0000-4000-8000-000000000001';
  const childlessWithdrawalSetId = '42000000-0000-4000-8000-000000000002';
  const childlessWithdrawalFinancialItemId = '42000000-0000-4000-8000-000000000003';
  const childlessWithdrawalAllocationId = '42000000-0000-4000-8000-000000000004';
  await insertDisputeEffect({
    allocationId: childlessWithdrawalAllocationId,
    disputeId: childlessDisputeId,
    effect: 'withdrawal',
    financialItemId: childlessWithdrawalFinancialItemId,
    fingerprintCharacter: 'e',
    orderItemId: combinedSecondItemId,
    providerCreatedAt: '2026-08-08T02:00:00.000Z',
    providerId: 'bt_restore_childless_withdrawal',
    reversalOfSetId: null,
    reversesAllocationId: null,
    setId: childlessWithdrawalSetId,
    signedSubtotalMinor: -10,
    stripeDisputeId: childlessStripeDisputeId,
    transactionId: childlessWithdrawalTransactionId
  });
  await mutateAppendOnlyFixture('delete from dispute_item_allocations where id = $1', [
    childlessWithdrawalAllocationId
  ]);
  await expectRejection(
    'withdrawal current tip has no required dispute presentment child',
    'dispute_presentment_child_cardinality=1'
  );
  await pool.query(`
    insert into dispute_item_allocations (
      id, allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
      effect, reverses_allocation_id, subtotal_effect_minor, tax_effect_minor,
      total_effect_minor, currency
    ) values ($1, $2, $3, $4, $5, 'withdrawal', null, -10, 0, -10, 'USD')
  `, [
    childlessWithdrawalAllocationId,
    `restore:${childlessWithdrawalAllocationId}`,
    childlessDisputeId,
    childlessWithdrawalSetId,
    combinedSecondItemId
  ]);
  await expectPass('withdrawal dispute presentment child repair', true);
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = 0, tax_effect_minor = 0, total_effect_minor = 0
    where id = $1
  `, [childlessWithdrawalAllocationId]);
  await expectRejection(
    'withdrawal dispute presentment child cannot have a zero effect',
    'combined_refund_dispute_chronology_capacity=1'
  );
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = -10, tax_effect_minor = 0, total_effect_minor = -10
    where id = $1
  `, [childlessWithdrawalAllocationId]);
  await expectPass('strictly negative withdrawal presentment repair', true);

  const childlessReinstatementTransactionId = '42000000-0000-4000-8000-000000000005';
  const childlessReinstatementSetId = '42000000-0000-4000-8000-000000000006';
  const childlessReinstatementAllocationId = '42000000-0000-4000-8000-000000000007';
  const childlessReinstatementFinancialItemId =
    '42000000-0000-4000-8000-000000000008';
  await insertDisputeEffect({
    allocationId: childlessReinstatementAllocationId,
    disputeId: childlessDisputeId,
    effect: 'reinstatement',
    financialItemId: childlessReinstatementFinancialItemId,
    fingerprintCharacter: 'f',
    orderItemId: combinedSecondItemId,
    providerCreatedAt: '2026-08-08T03:00:00.000Z',
    providerId: 'bt_restore_childless_reinstatement',
    reversalOfSetId: childlessWithdrawalSetId,
    reversesAllocationId: childlessWithdrawalAllocationId,
    setId: childlessReinstatementSetId,
    signedSubtotalMinor: 10,
    stripeDisputeId: childlessStripeDisputeId,
    transactionId: childlessReinstatementTransactionId
  });
  await mutateAppendOnlyFixture('delete from dispute_item_allocations where id = $1', [
    childlessReinstatementAllocationId
  ]);
  await expectRejection(
    'reinstatement current tip has no required dispute presentment child',
    'dispute_presentment_child_cardinality=1'
  );
  await pool.query(`
    insert into dispute_item_allocations (
      id, allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
      effect, reverses_allocation_id, subtotal_effect_minor, tax_effect_minor,
      total_effect_minor, currency
    ) values ($1, $2, $3, $4, $5, 'reinstatement', $6, 10, 0, 10, 'USD')
  `, [
    childlessReinstatementAllocationId,
    `restore:${childlessReinstatementAllocationId}`,
    childlessDisputeId,
    childlessReinstatementSetId,
    combinedSecondItemId,
    childlessWithdrawalAllocationId
  ]);
  await expectPass('reinstatement dispute presentment child repair', true);
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations set reverses_allocation_id = $1 where id = $2
  `, [firstWithdrawalAllocationId, childlessReinstatementAllocationId]);
  await expectRejection(
    'reinstatement cannot cross an immutable withdrawal graph or reverse it twice',
    'dispute_item_allocation_graph='
  );
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations set reverses_allocation_id = $1 where id = $2
  `, [childlessWithdrawalAllocationId, childlessReinstatementAllocationId]);
  await expectPass('reinstatement immutable reversal graph repair', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set amount_minor = 5, net_minor = 5 where id = $1
  `, [childlessReinstatementTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets set expected_effect_minor = 5 where id = $1
  `, [childlessReinstatementSetId]);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set effect_minor = 5 where id = $1
  `, [childlessReinstatementFinancialItemId]);
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = 5, tax_effect_minor = 0, total_effect_minor = 5
    where id = $1
  `, [childlessReinstatementAllocationId]);
  await expectPass('same-currency partial reinstatement remains valid', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set amount_minor = 10, net_minor = 10 where id = $1
  `, [childlessReinstatementTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets set expected_effect_minor = 10 where id = $1
  `, [childlessReinstatementSetId]);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set effect_minor = 10 where id = $1
  `, [childlessReinstatementFinancialItemId]);
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = 10, tax_effect_minor = 0, total_effect_minor = 10
    where id = $1
  `, [childlessReinstatementAllocationId]);
  await expectPass('same-currency full reinstatement repair', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = 1, exchange_source_currency = 'EUR',
      exchange_target_currency = 'USD'
    where id = $1
  `, [childlessWithdrawalTransactionId]);
  await expectRejection(
    'same-currency dispute withdrawal cannot carry rogue exchange evidence',
    'allocation_set_semantic_source=1'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = null, exchange_source_currency = null,
      exchange_target_currency = null
    where id = $1
  `, [childlessWithdrawalTransactionId]);
  await expectPass('same-currency dispute exchange evidence repair', true);

  const crossCurrencyTransactionId = '44000000-0000-4000-8000-000000000001';
  const crossCurrencySetId = '44000000-0000-4000-8000-000000000002';
  const crossCurrencyFinancialItemId = '44000000-0000-4000-8000-000000000003';
  const crossCurrencyAllocationId = '44000000-0000-4000-8000-000000000004';
  const crossCurrencyReinstatementTransactionId =
    '44000000-0000-4000-8000-000000000005';
  const crossCurrencyReinstatementSetId = '44000000-0000-4000-8000-000000000006';
  const crossCurrencyReinstatementFinancialItemId =
    '44000000-0000-4000-8000-000000000007';
  const crossCurrencyReinstatementAllocationId =
    '44000000-0000-4000-8000-000000000008';
  const crossCurrencyReinstatementFeeDetailId =
    '44000000-0000-4000-8000-000000000009';
  const crossCurrencyReinstatementFeeSetId =
    '44000000-0000-4000-8000-00000000000a';
  const crossCurrencyWithdrawalFeeDetailId =
    '44000000-0000-4000-8000-00000000000b';
  const crossCurrencyWithdrawalFeeSetId =
    '44000000-0000-4000-8000-00000000000c';
  const crossCurrencyWithdrawalFeeItemId =
    '44000000-0000-4000-8000-00000000000d';
  const crossCurrencyFeeCreditTransactionId =
    '44000000-0000-4000-8000-00000000000e';
  const crossCurrencyFeeCreditGrossSetId =
    '44000000-0000-4000-8000-00000000000f';
  const crossCurrencyFeeCreditFeeSetId =
    '44000000-0000-4000-8000-000000000010';
  const crossCurrencyFeeCreditItemId =
    '44000000-0000-4000-8000-000000000011';
  await insertDisputeEffect({
    allocationId: crossCurrencyAllocationId,
    disputeId: childlessDisputeId,
    effect: 'withdrawal',
    financialItemId: crossCurrencyFinancialItemId,
    fingerprintCharacter: '2',
    orderItemId: combinedSecondItemId,
    providerCreatedAt: '2026-08-08T04:00:00.000Z',
    providerId: 'bt_restore_cross_currency_withdrawal',
    reversalOfSetId: null,
    reversesAllocationId: null,
    setId: crossCurrencySetId,
    signedSubtotalMinor: -10,
    stripeDisputeId: childlessStripeDisputeId,
    transactionId: crossCurrencyTransactionId
  });
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set currency = 'EUR', exchange_rate = 0.9,
      exchange_source_currency = 'USD', exchange_target_currency = 'EUR'
    where id = $1
  `, [crossCurrencyTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets set currency = 'EUR' where id = $1
  `, [crossCurrencySetId]);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set currency = 'EUR' where id = $1
  `, [crossCurrencyFinancialItemId]);
  await expectPass('cross-currency withdrawal preserves exact presentment capacity', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = null, exchange_source_currency = null,
      exchange_target_currency = null
    where id = $1
  `, [crossCurrencyTransactionId]);
  await expectRejection(
    'cross-currency dispute withdrawal requires exchange evidence',
    'allocation_set_semantic_source=1'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = 0.9, exchange_source_currency = 'GBP',
      exchange_target_currency = 'EUR'
    where id = $1
  `, [crossCurrencyTransactionId]);
  await expectRejection(
    'cross-currency dispute exchange source must match the dispute currency',
    'allocation_set_semantic_source=1'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_source_currency = 'USD'
    where id = $1
  `, [crossCurrencyTransactionId]);
  await expectPass('cross-currency dispute exchange evidence repair', true);
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = -9, tax_effect_minor = 0, total_effect_minor = -9
    where id = $1
  `, [crossCurrencyAllocationId]);
  await expectRejection(
    'cross-currency withdrawal cannot understate its immutable presentment effect',
    'dispute_item_allocation_graph=1'
  );
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = -10, tax_effect_minor = 0, total_effect_minor = -10
    where id = $1
  `, [crossCurrencyAllocationId]);
  await expectPass('cross-currency withdrawal presentment repair', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set fee_minor = 1, net_minor = -11
    where id = $1
  `, [crossCurrencyTransactionId]);
  await pool.query(`
    insert into stripe_balance_transaction_fee_details (
      id, balance_transaction_id, ordinal, raw_type, amount_minor, currency,
      fingerprint_sha256
    ) values ($1, $2, 0, 'stripe_fee', 1, 'EUR', repeat('6', 64))
  `, [crossCurrencyWithdrawalFeeDetailId, crossCurrencyTransactionId]);
  await pool.query(`
    insert into financial_classification_versions (
      subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ('fee_detail', $1, 1, 'dispute_fee', repeat('6', 64))
  `, [crossCurrencyWithdrawalFeeDetailId]);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256
    ) values (
      $1, 'restore:cross-currency-withdrawal-fee', $2, 'dispute', $3,
      'fee', 'title', -1, 'EUR', 1, 1, repeat('2', 64)
    )
  `, [crossCurrencyWithdrawalFeeSetId, crossCurrencyTransactionId, childlessDisputeId]);
  await pool.query(`
    insert into financial_item_allocations (
      id, allocation_set_id, order_item_id, component, effect_minor, currency,
      tie_break_key
    ) values (
      $1, $2, $3, 'dispute_fee', -1, 'EUR',
      'restore:cross-currency-withdrawal-fee'
    )
  `, [crossCurrencyWithdrawalFeeItemId, crossCurrencyWithdrawalFeeSetId,
    combinedSecondItemId]);
  await pool.query(`
    insert into stripe_balance_transactions (
      id, provider_id, live_mode, source_family, source_id, raw_type,
      reporting_category, balance_type, amount_minor, fee_minor, net_minor,
      currency, status, provider_created_at, available_at, fingerprint_sha256
    ) values (
      $1, 'bt_restore_cross_currency_fee_credit', false, 'dispute', $2,
      'stripe_fee', 'fee', 'payments', 1, 0, 1, 'EUR', 'available',
      '2026-08-08T04:30:00.000Z', '2026-08-08T04:30:00.000Z', repeat('5', 64)
    )
  `, [crossCurrencyFeeCreditTransactionId, childlessStripeDisputeId]);
  await pool.query(`
    insert into financial_classification_versions (
      subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ('balance_transaction', $1, 1, 'fee_credit', repeat('5', 64))
  `, [crossCurrencyFeeCreditTransactionId]);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256
    ) values
      ($1, 'restore:cross-currency-fee-credit:gross', $3, 'dispute', $4,
        'gross_amount', 'title', 1, 'EUR', 1, 1, repeat('5', 64)),
      ($2, 'restore:cross-currency-fee-credit:fee', $3, 'dispute', $4,
        'fee', 'title', 0, 'EUR', 1, 1, repeat('5', 64))
  `, [
    crossCurrencyFeeCreditGrossSetId,
    crossCurrencyFeeCreditFeeSetId,
    crossCurrencyFeeCreditTransactionId,
    childlessDisputeId
  ]);
  await pool.query(`
    insert into financial_item_allocations (
      id, allocation_set_id, order_item_id, component, effect_minor, currency,
      tie_break_key
    ) values (
      $1, $2, $3, 'fee_credit', 1, 'EUR',
      'restore:cross-currency-fee-credit'
    )
  `, [crossCurrencyFeeCreditItemId, crossCurrencyFeeCreditGrossSetId,
    combinedSecondItemId]);
  await expectPass(
    'cross-currency fee credit admits all-null settlement-only exchange evidence',
    true
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set raw_type = 'dispute_reversal', reporting_category = 'dispute_reversal'
    where id = $1
  `, [crossCurrencyFeeCreditTransactionId]);
  await expectRejection(
    'cross-currency fee credit requires immutable settlement-only fee evidence',
    'allocation_set_semantic_source=2'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set raw_type = 'stripe_fee', reporting_category = 'fee'
    where id = $1
  `, [crossCurrencyFeeCreditTransactionId]);
  await expectPass('cross-currency fee credit immutable evidence repair', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = 0.9, exchange_source_currency = 'GBP',
      exchange_target_currency = 'EUR'
    where id = $1
  `, [crossCurrencyFeeCreditTransactionId]);
  await expectRejection(
    'cross-currency fee credit rejects a supplied wrong-source exchange tuple',
    'allocation_set_semantic_source=2'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_source_currency = 'USD'
    where id = $1
  `, [crossCurrencyFeeCreditTransactionId]);
  await expectPass('cross-currency fee credit exact supplied exchange tuple', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set raw_type = 'dispute_reversal', reporting_category = 'dispute_reversal'
    where id = $1
  `, [crossCurrencyFeeCreditTransactionId]);
  await expectRejection(
    'supplied fee-credit exchange tuple still requires immutable fee evidence',
    'allocation_set_semantic_source=2'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set raw_type = 'stripe_fee', reporting_category = 'fee'
    where id = $1
  `, [crossCurrencyFeeCreditTransactionId]);
  await expectPass('supplied fee-credit immutable evidence repair', true);
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set exchange_rate = null, exchange_source_currency = null,
      exchange_target_currency = null
    where id = $1
  `, [crossCurrencyFeeCreditTransactionId]);
  await expectPass('cross-currency fee credit all-null exchange repair', true);
  await insertDisputeEffect({
    allocationId: crossCurrencyReinstatementAllocationId,
    disputeId: childlessDisputeId,
    effect: 'reinstatement',
    financialItemId: crossCurrencyReinstatementFinancialItemId,
    fingerprintCharacter: '3',
    orderItemId: combinedSecondItemId,
    providerCreatedAt: '2026-08-08T05:00:00.000Z',
    providerId: 'bt_restore_cross_currency_reinstatement',
    reversalOfSetId: null,
    reversesAllocationId: crossCurrencyAllocationId,
    setId: crossCurrencyReinstatementSetId,
    signedSubtotalMinor: 10,
    stripeDisputeId: childlessStripeDisputeId,
    transactionId: crossCurrencyReinstatementTransactionId
  });
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions
    set currency = 'EUR', exchange_rate = 0.9,
      exchange_source_currency = 'USD', exchange_target_currency = 'EUR'
    where id = $1
  `, [crossCurrencyReinstatementTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets
    set currency = 'EUR', reversal_of_set_id = $2 where id = $1
  `, [crossCurrencyReinstatementSetId, crossCurrencySetId]);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set currency = 'EUR' where id = $1
  `, [crossCurrencyReinstatementFinancialItemId]);
  await pool.query(`
    insert into stripe_balance_transaction_fee_details (
      id, balance_transaction_id, ordinal, raw_type, amount_minor, currency,
      fingerprint_sha256
    ) values ($1, $2, 0, 'tax', 0, 'EUR', $3)
  `, [
    crossCurrencyReinstatementFeeDetailId,
    crossCurrencyReinstatementTransactionId,
    '7'.repeat(64)
  ]);
  await pool.query(`
    insert into financial_classification_versions (
      subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values ('fee_detail', $1, 1, 'provider_fee_tax', $2)
  `, [crossCurrencyReinstatementFeeDetailId, '7'.repeat(64)]);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256
    ) values (
      $1, 'restore:cross-currency-reinstatement-fee', $2, 'dispute', $3,
      'fee', 'title', 0, 'EUR', 1, 1, repeat('3', 64)
    )
  `, [
    crossCurrencyReinstatementFeeSetId,
    crossCurrencyReinstatementTransactionId,
    childlessDisputeId
  ]);
  await expectPass('full cross-currency reinstatement baseline', true);

  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set amount_minor = 5, net_minor = 5 where id = $1
  `, [crossCurrencyReinstatementTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets set expected_effect_minor = 5 where id = $1
  `, [crossCurrencyReinstatementSetId]);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set effect_minor = 5 where id = $1
  `, [crossCurrencyReinstatementFinancialItemId]);
  await expectRejection(
    'cross-currency reinstatement cannot partially restore settlement',
    'dispute_item_allocation_graph=1'
  );
  await mutateAppendOnlyFixture(`
    update stripe_balance_transactions set amount_minor = 10, net_minor = 10 where id = $1
  `, [crossCurrencyReinstatementTransactionId]);
  await mutateAppendOnlyFixture(`
    update financial_allocation_sets set expected_effect_minor = 10 where id = $1
  `, [crossCurrencyReinstatementSetId]);
  await mutateAppendOnlyFixture(`
    update financial_item_allocations set effect_minor = 10 where id = $1
  `, [crossCurrencyReinstatementFinancialItemId]);
  await expectPass('cross-currency reinstatement settlement repair', true);

  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = 5, tax_effect_minor = 0, total_effect_minor = 5
    where id = $1
  `, [crossCurrencyReinstatementAllocationId]);
  await expectRejection(
    'cross-currency reinstatement cannot partially restore presentment',
    'dispute_item_allocation_graph=1'
  );
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = 10, tax_effect_minor = 0, total_effect_minor = 10
    where id = $1
  `, [crossCurrencyReinstatementAllocationId]);
  await expectPass('cross-currency reinstatement presentment repair', true);
  await mutateAppendOnlyFixture(
    'delete from dispute_item_allocations where id in ($1, $2)',
    [crossCurrencyAllocationId, crossCurrencyReinstatementAllocationId]
  );
  await mutateAppendOnlyFixture(
    'delete from financial_item_allocations where id in ($1, $2, $3, $4)',
    [
      crossCurrencyFinancialItemId,
      crossCurrencyReinstatementFinancialItemId,
      crossCurrencyWithdrawalFeeItemId,
      crossCurrencyFeeCreditItemId
    ]
  );
  await mutateAppendOnlyFixture(
    'delete from financial_allocation_sets where id in ($1, $2, $3, $4, $5, $6)',
    [
      crossCurrencySetId,
      crossCurrencyReinstatementSetId,
      crossCurrencyReinstatementFeeSetId,
      crossCurrencyWithdrawalFeeSetId,
      crossCurrencyFeeCreditGrossSetId,
      crossCurrencyFeeCreditFeeSetId
    ]
  );
  await mutateAppendOnlyFixture(`
    delete from financial_classification_versions
    where subject_id in ($1, $2, $3, $4, $5)
  `, [
    crossCurrencyTransactionId,
    crossCurrencyReinstatementTransactionId,
    crossCurrencyReinstatementFeeDetailId,
    crossCurrencyWithdrawalFeeDetailId,
    crossCurrencyFeeCreditTransactionId
  ]);
  await mutateAppendOnlyFixture(
    'delete from stripe_balance_transaction_fee_details where id in ($1, $2)',
    [crossCurrencyReinstatementFeeDetailId, crossCurrencyWithdrawalFeeDetailId]
  );
  await mutateAppendOnlyFixture(
    'delete from stripe_balance_transactions where id in ($1, $2, $3)',
    [
      crossCurrencyTransactionId,
      crossCurrencyReinstatementTransactionId,
      crossCurrencyFeeCreditTransactionId
    ]
  );
  await expectPass('cross-currency withdrawal and reinstatement witness cleanup', true);

  const duplicateChronologyRefundComponentId =
    '40000000-0000-4000-8000-0000000000e0';
  await pool.query(`
    insert into refunds (
      id, payment_id, stripe_refund_id, status, amount_minor, currency,
      provider_created_at, allocation_status
    ) values ($1, $2, 'bt_restore_combined_withdraw_1', 'succeeded', 1, 'USD',
      '2026-08-06T00:00:00.000Z', 'finalized')
  `, [combinedDisputeId, combinedPaymentId]);
  await pool.query(`
    insert into refund_allocations (id, refund_id, order_item_id, amount_minor, source)
    values ($1, $2, $3, 1, 'automatic')
  `, [
    firstWithdrawalAllocationId,
    combinedDisputeId,
    combinedFirstItemId
  ]);
  await pool.query(`
    insert into refund_allocation_components (
      id, refund_allocation_id, refund_id, order_item_id,
      subtotal_minor, tax_minor, total_minor, currency
    ) values ($1, $2, $3, $4, 1, 0, 1, 'USD')
  `, [
    duplicateChronologyRefundComponentId,
    firstWithdrawalAllocationId,
    combinedDisputeId,
    combinedFirstItemId
  ]);
  await expectRejection(
    'refund and dispute events duplicate the full durable chronology tuple',
    'combined_refund_dispute_chronology_capacity='
  );
  await pool.query('set session_replication_role = replica');
  try {
    await pool.query('delete from refund_allocation_components where id = $1', [
      duplicateChronologyRefundComponentId
    ]);
    await pool.query('delete from refund_allocations where id = $1', [
      firstWithdrawalAllocationId
    ]);
    await pool.query('delete from refunds where id = $1', [combinedDisputeId]);
  } finally {
    await pool.query('set session_replication_role = origin');
  }
  await expectPass('duplicate durable chronology witness cleanup', true);

  const pendingWithdrawalSetId = '40000000-0000-4000-8000-0000000000d1';
  await pool.query(`
    insert into financial_classification_versions (
      subject_type, subject_id, classifier_version, classification,
      source_fingerprint_sha256
    ) values
      ('balance_transaction', $1, 2, 'dispute_withdrawal', repeat('8', 64)),
      ('fee_detail', $2, 2, 'dispute_fee', $3)
  `, [secondWithdrawalTransactionId, withdrawalFeeDetailId, withdrawalFeeFingerprint]);
  await pool.query(`
    insert into financial_allocation_sets (
      id, allocation_identity, balance_transaction_id, source_kind,
      source_internal_id, basis, scope, expected_effect_minor, currency,
      algorithm_version, classifier_version, source_fingerprint_sha256,
      supersedes_set_id
    ) values (
      $1, 'restore:pending-withdrawal-tip', $2, 'dispute', $3,
      'gross_amount', 'title', -50, 'USD', 2, 2, repeat('8', 64), $4
    )
  `, [
    pendingWithdrawalSetId,
    secondWithdrawalTransactionId,
    combinedDisputeId,
    secondWithdrawalSetId
  ]);
  await pool.query(`
    insert into financial_item_allocations (
      id, allocation_set_id, order_item_id, component, effect_minor, currency,
      tie_break_key
    ) values (
      '40000000-0000-4000-8000-0000000000d2', $1, $2,
      'dispute_subtotal', -50, 'USD', 'pending-withdrawal:settlement'
    )
  `, [pendingWithdrawalSetId, combinedFirstItemId]);
  await pool.query(`
    insert into dispute_item_allocations (
      id, allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
      effect, subtotal_effect_minor, tax_effect_minor, total_effect_minor, currency
    ) values (
      '40000000-0000-4000-8000-0000000000d3', 'restore:pending-withdrawal-tip',
      $1, $2, $3, 'withdrawal', -50, 0, -50, 'USD'
    )
  `, [combinedDisputeId, pendingWithdrawalSetId, combinedFirstItemId]);
  await insertDisputeEffect({
    allocationId: '40000000-0000-4000-8000-0000000000d7',
    disputeId: combinedDisputeId,
    effect: 'reinstatement',
    financialItemId: '40000000-0000-4000-8000-0000000000d6',
    fingerprintCharacter: 'c',
    orderItemId: combinedFirstItemId,
    providerCreatedAt: '2026-08-08T00:00:00.000Z',
    providerId: 'zz_restore_active_reinstatement',
    reversalOfSetId: secondWithdrawalSetId,
    reversesAllocationId: secondWithdrawalAllocationId,
    setId: '40000000-0000-4000-8000-0000000000d5',
    signedSubtotalMinor: 50,
    stripeDisputeId: combinedStripeDisputeId,
    transactionId: '40000000-0000-4000-8000-0000000000d4'
  });
  await expectPass(
    'pending-version successor neither leaks into nor displaces active chronology',
    true
  );
  const pendingWithdrawalAllocationId = '40000000-0000-4000-8000-0000000000d3';
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = -100, tax_effect_minor = 0, total_effect_minor = -100
    where id = $1
  `, [pendingWithdrawalAllocationId]);
  await expectPass(
    'pending-version later same-currency presentment remains separate from settlement',
    true
  );
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = -50, tax_effect_minor = 0, total_effect_minor = -50
    where id = $1
  `, [pendingWithdrawalAllocationId]);
  await expectPass('pending-version presentment magnitude repair', true);
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = 0, tax_effect_minor = 0, total_effect_minor = 0
    where id = $1
  `, [pendingWithdrawalAllocationId]);
  await expectRejection(
    'pending-version withdrawal history cannot contain a zero presentment effect',
    'dispute_presentment_child_cardinality=1'
  );
  await mutateAppendOnlyFixture(`
    update dispute_item_allocations
    set subtotal_effect_minor = -50, tax_effect_minor = 0, total_effect_minor = -50
    where id = $1
  `, [pendingWithdrawalAllocationId]);
  await expectPass('pending-version withdrawal presentment sign repair', true);

  const crossWithdrawalTransactionId = '40000000-0000-4000-8000-000000000017';
  const crossReinstatementTransactionId = '40000000-0000-4000-8000-000000000018';
  const crossWithdrawalSetId = '40000000-0000-4000-8000-000000000019';
  const crossReinstatementSetId = '40000000-0000-4000-8000-00000000001a';
  const crossWithdrawalFinancialItemId = '40000000-0000-4000-8000-00000000001b';
  const crossReinstatementFinancialItemId = '40000000-0000-4000-8000-00000000001c';
  const crossWithdrawalAllocationId = '40000000-0000-4000-8000-00000000001d';
  const crossReinstatementAllocationId = '40000000-0000-4000-8000-00000000001e';
  await insertDisputeEffect({
    allocationId: crossWithdrawalAllocationId,
    disputeId: combinedDisputeId,
    effect: 'withdrawal',
    financialItemId: crossWithdrawalFinancialItemId,
    fingerprintCharacter: '9',
    orderItemId: combinedSecondItemId,
    providerCreatedAt: '2026-08-09T00:00:00.000Z',
    providerId: 'bt_restore_cross_withdrawal',
    reversalOfSetId: null,
    reversesAllocationId: null,
    setId: crossWithdrawalSetId,
    signedSubtotalMinor: -50,
    stripeDisputeId: combinedStripeDisputeId,
    transactionId: crossWithdrawalTransactionId
  });
  await insertDisputeEffect({
    allocationId: crossReinstatementAllocationId,
    disputeId: combinedDisputeId,
    effect: 'reinstatement',
    financialItemId: crossReinstatementFinancialItemId,
    fingerprintCharacter: 'a',
    orderItemId: combinedFirstItemId,
    providerCreatedAt: '2026-08-10T00:00:00.000Z',
    providerId: 'bt_restore_cross_reinstatement',
    reversalOfSetId: crossWithdrawalSetId,
    reversesAllocationId: crossWithdrawalAllocationId,
    setId: crossReinstatementSetId,
    signedSubtotalMinor: 50,
    stripeDisputeId: combinedStripeDisputeId,
    transactionId: crossReinstatementTransactionId
  });
  await expectRejection(
    'reinstatement crosses its withdrawal order item',
    'combined_refund_dispute_chronology_capacity=1'
  );
  await pool.query('set session_replication_role = replica');
  try {
    await pool.query(`
      delete from dispute_item_allocations where id in ($1, $2)
    `, [crossWithdrawalAllocationId, crossReinstatementAllocationId]);
    await pool.query(`
      delete from financial_item_allocations where id in ($1, $2)
    `, [crossWithdrawalFinancialItemId, crossReinstatementFinancialItemId]);
    await pool.query(`
      delete from financial_allocation_sets where id in ($1, $2)
    `, [crossWithdrawalSetId, crossReinstatementSetId]);
    await pool.query(`
      delete from financial_classification_versions where subject_id in ($1, $2)
    `, [crossWithdrawalTransactionId, crossReinstatementTransactionId]);
    await pool.query(`
      delete from stripe_balance_transactions where id in ($1, $2)
    `, [crossWithdrawalTransactionId, crossReinstatementTransactionId]);
  } finally {
    await pool.query('set session_replication_role = origin');
  }
  await expectPass('cross-item reversal witness cleanup', true);

  const negativeDisputeId = '40000000-0000-4000-8000-00000000001f';
  const negativeStripeDisputeId = 'dp_restore_combined_negative';
  await pool.query(`
    insert into disputes (
      id, payment_id, stripe_dispute_id, status, amount_minor, currency,
      provider_created_at, provider_updated_at
    ) values ($1, $2, $3, 'open', 100, 'USD',
      '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')
  `, [negativeDisputeId, combinedPaymentId, negativeStripeDisputeId]);
  await insertDisputeEffect({
    allocationId: '40000000-0000-4000-8000-000000000023',
    disputeId: negativeDisputeId,
    effect: 'withdrawal',
    financialItemId: '40000000-0000-4000-8000-000000000022',
    fingerprintCharacter: 'b',
    orderItemId: combinedSecondItemId,
    providerCreatedAt: '2026-08-11T00:00:00.000Z',
    providerId: 'bt_restore_negative_withdrawal',
    reversalOfSetId: null,
    reversesAllocationId: null,
    setId: '40000000-0000-4000-8000-000000000021',
    signedSubtotalMinor: -100,
    stripeDisputeId: negativeStripeDisputeId,
    transactionId: '40000000-0000-4000-8000-000000000020'
  });
  const negativeRefundId = '40000000-0000-4000-8000-000000000024';
  const negativeRefundAllocationId = '40000000-0000-4000-8000-000000000025';
  await pool.query(`
    insert into refunds (
      id, payment_id, stripe_refund_id, status, amount_minor, currency,
      provider_created_at, allocation_status
    ) values ($1, $2, 're_restore_combined_negative', 'succeeded', 100, 'USD',
      '2026-08-12T00:00:00.000Z', 'finalized')
  `, [negativeRefundId, combinedPaymentId]);
  await pool.query(`
    insert into refund_allocations (id, refund_id, order_item_id, amount_minor, source)
    values ($1, $2, $3, 100, 'automatic')
  `, [negativeRefundAllocationId, negativeRefundId, combinedSecondItemId]);
  await pool.query(`
    insert into refund_allocation_components (
      id, refund_allocation_id, refund_id, order_item_id,
      subtotal_minor, tax_minor, total_minor, currency
    ) values (
      '40000000-0000-4000-8000-000000000026', $1, $2, $3, 100, 0, 100, 'USD'
    )
  `, [negativeRefundAllocationId, negativeRefundId, combinedSecondItemId]);
  await expectRejection(
    'outstanding withdrawal plus refund exceeds immutable payment item capacity',
    'combined_refund_dispute_chronology_capacity=1'
  );

  await pool.query(`
    insert into refunds (
      id, payment_id, stripe_refund_id, status, amount_minor, currency,
      provider_created_at, allocation_status
    ) values ($1, $2, 're_restore_split_1', 'succeeded', 2, 'USD',
      '2026-08-05T00:00:00.000Z', 'finalized')
  `, [splitRefundId, paymentId]);
  await pool.query(`
    insert into refund_allocations (id, refund_id, order_item_id, amount_minor, source)
    values ($1, $2, $3, 2, 'automatic')
  `, [splitAllocationId, splitRefundId, secondItemId]);
  await pool.query(`
    insert into refund_allocation_components (
      refund_allocation_id, refund_id, order_item_id,
      subtotal_minor, tax_minor, total_minor, currency
    ) values ($1, $2, $3, 1, 1, 2, 'USD')
  `, [splitAllocationId, splitRefundId, secondItemId]);
  await expectRejection(
    'refund component violates the deterministic two-bucket split',
    'refund_component_deterministic_split=1',
    'full'
  );

  if (failures.length > 0) {
    throw new Error(`[restore-verifier] invariant witness failures: ${failures.join('; ')}`);
  }
  console.info(
    '[restore-verifier] schema-object, issue-identity, source-parity, deterministic-allocation, audit, classification, payout, replay-child, allocation-graph, refund-component, dispute-presentment, and combined-chronology witnesses passed'
  );
}

try {
  await migrate(drizzle({ client: pool }), { migrationsFolder: `${repositoryRoot}/drizzle` });
  if (printFinancialCatalogContract) {
    await printCatalogContractCalibration();
  } else if (exerciseFinancialInvariantWitnesses) {
    await exerciseInvariantWitnesses();
  } else if (seedMissingCredentialAuthority) {
    await pool.query(`
      with inserted_user as (
        insert into "user" (name, email, email_verified)
        values ('Restore witness', 'restore-witness@example.invalid', true)
        returning id
      )
      insert into account (account_id, provider_id, user_id, password, updated_at)
      select 'restore-witness', 'credential', id, 'witness-hash', now()
      from inserted_user
    `);
  }
  if (!exerciseFinancialInvariantWitnesses && !printFinancialCatalogContract) {
    let seededViolationRejected = false;
    const { error } = await verifierOutcome(
      seedMissingCredentialAuthority
        ? 'seeded credential-authority violation'
        : 'clean executable restore check',
      'full'
    );
    if (error) {
      if (
        seedMissingCredentialAuthority &&
        error.message.includes('credential_authority_missing_or_mismatched=1')
      ) {
        console.info('[restore-verifier] seeded credential-authority violation was rejected');
        seededViolationRejected = true;
      } else {
        throw error;
      }
    }
    if (!seedMissingCredentialAuthority) {
      console.info('[restore-verifier] executable SQL returned zero structural violations');
    } else if (!seededViolationRejected) {
      throw new Error('[restore-verifier] seeded violation was not rejected');
    }
  }
} finally {
  if (verifierClient) {
    verifierClient.release();
    verifierClient = null;
  }
  await Promise.all([pool.end(), verifierPool.end()]);
}
