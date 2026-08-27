import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  COMMERCE_CLAIM_EMAIL_JOB,
  COMMERCE_CLAIM_EMAIL_JOB_MAX_ATTEMPTS,
  COMMERCE_CLAIM_REQUEST_JOB,
  COMMERCE_CLAIM_REQUEST_JOB_MAX_ATTEMPTS,
  FINANCIAL_ADMIN_COMMAND_JOB,
  FINANCIAL_ADMIN_COMMAND_MAX_ATTEMPTS,
  FINANCIAL_CLASSIFICATION_JOB,
  FINANCIAL_CLASSIFICATION_JOB_MAX_ATTEMPTS,
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_PAYOUT_JOB_MAX_ATTEMPTS,
  FINANCIAL_SCAN_JOB,
  FINANCIAL_SCAN_JOB_MAX_ATTEMPTS,
  FINANCIAL_SOURCE_JOB,
  FINANCIAL_SOURCE_JOB_MAX_ATTEMPTS,
  INGEST_REVISION_JOB,
  INGEST_REVISION_JOB_MAX_ATTEMPTS,
  JOB_DEFINITIONS,
  JOB_RETRY_POLICY_IDS,
  JOB_RETRY_POLICY_OUTCOMES,
  OPERATIONS_JOB_RETRY_COMMAND_JOB,
  OPERATIONS_JOB_RETRY_COMMAND_MAX_ATTEMPTS,
  OUTBOX_DISPATCH_JOB,
  OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS,
  REGISTERED_JOB_KINDS,
  STRIPE_EVENT_JOB,
  STRIPE_EVENT_JOB_MAX_ATTEMPTS,
  definitionForJobKind,
  isJobRetryPolicyOutcomeAllowed,
  isRegisteredJobKind,
  safeOperationalFailureCode
} from './catalog';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const catalogFunctionName = 'public.plan7a_operations_job_catalog';
const catalogFunctionTag = '$plan7a_operations_job_catalog$';
const catalogValuesRelation = 'plan7a_job_catalog_values';
const policyOutcomeValuesRelation = 'plan7a_job_policy_outcome_values';
const legacyDetachedCatalogTag = '$plan7a_job_catalog$';

const catalogFunctionStartPattern =
  /\bcreate\s+(?:or\s+replace\s+)?function\s+public[.]plan7a_operations_job_catalog\s*[(]\s*[)]/iu;
const catalogFunctionPattern =
  /^create\s+(?:or\s+replace\s+)?function\s+public[.]plan7a_operations_job_catalog\s*[(]\s*[)][\s\S]*?\bas\s+[$]plan7a_operations_job_catalog[$]([\s\S]*?)[$]plan7a_operations_job_catalog[$]\s*;/iu;

const normalizeSql = (sql: string): string => sql.replace(/\s+/gu, ' ').trim();
const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlBoolean = (value: boolean): string => value ? 'true' : 'false';
const sqlTextArray = (values: readonly string[]): string =>
  `array[${values.map(sqlLiteral).join(', ')}]::text[]`;

const expectedCatalogValueRows = (): string => JOB_DEFINITIONS
  .map((definition, index) => `(${[
    String(index + 1),
    sqlLiteral(definition.kind),
    sqlLiteral(definition.label),
    String(definition.maxAttempts),
    sqlLiteral(definition.automaticRetryOwner),
    sqlLiteral(definition.retryDisposition),
    sqlLiteral(definition.retryPolicyId),
    sqlLiteral(definition.retryPolicyAvailability),
    sqlBoolean(definition.providerVerificationRequired),
    sqlBoolean(definition.providerCallsInPlan7A),
    sqlBoolean(definition.retryPolicyAvailability === 'excluded'),
    sqlTextArray(definition.safeStatuses),
    sqlLiteral(definition.diagnosticGeneration)
  ].join(', ')})`)
  .join(', ');

const expectedPolicyOutcomeValueRows = (): string => JOB_RETRY_POLICY_IDS
  .flatMap((policyId, policyIndex) => JOB_RETRY_POLICY_OUTCOMES
    .filter(([candidate]) => candidate === policyId)
    .map(([, status, resultCode], outcomeIndex) => `(${[
      String(policyIndex + 1),
      sqlLiteral(policyId),
      String(outcomeIndex + 1),
      sqlLiteral(status),
      sqlLiteral(resultCode)
    ].join(', ')})`))
  .join(', ');

const dollarTagAt = (sql: string, offset: number): string | undefined =>
  sql.slice(offset).match(/^[$](?:[A-Za-z_][A-Za-z0-9_]*)?[$]/u)?.[0];

const maskRange = (output: string[], start: number, end: number): void => {
  for (let index = start; index < end; index += 1) {
    if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' ';
  }
};

const quotedEnd = (
  sql: string,
  offset: number,
  quote: "'" | '"',
  backslashEscapes = false
): number => {
  let index = offset + 1;
  while (index < sql.length) {
    if (backslashEscapes && sql[index] === '\\') {
      index += 2;
      continue;
    }
    if (sql[index] !== quote) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return sql.length;
};

const isEscapeString = (sql: string, quoteOffset: number): boolean => {
  if (sql[quoteOffset - 1]?.toLowerCase() !== 'e') return false;
  const beforePrefix = sql[quoteOffset - 2];
  return beforePrefix === undefined || !/[A-Za-z0-9_$]/u.test(beforePrefix);
};

const stripSqlComments = (sql: string): string => {
  const output = sql.split('');
  let index = 0;
  while (index < sql.length) {
    if (sql[index] === "'" || sql[index] === '"') {
      const quote = sql[index] as "'" | '"';
      index = quotedEnd(sql, index, quote, quote === "'" && isEscapeString(sql, index));
      continue;
    }
    const dollarTag = sql[index] === '$' ? dollarTagAt(sql, index) : undefined;
    if (dollarTag) {
      const close = sql.indexOf(dollarTag, index + dollarTag.length);
      index = close < 0 ? sql.length : close + dollarTag.length;
      continue;
    }
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2);
      const commentEnd = end < 0 ? sql.length : end;
      maskRange(output, index, commentEnd);
      index = commentEnd;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const start = index;
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      maskRange(output, start, index);
      continue;
    }
    index += 1;
  }
  return output.join('');
};

const maskSqlLiterals = (sql: string): string => {
  const output = sql.split('');
  let index = 0;
  while (index < sql.length) {
    if (sql[index] === "'") {
      const end = quotedEnd(sql, index, "'", isEscapeString(sql, index));
      maskRange(output, index, end);
      index = end;
      continue;
    }
    if (sql[index] === '"') {
      const end = quotedEnd(sql, index, '"');
      maskRange(output, index, end);
      index = end;
      continue;
    }
    const dollarTag = sql[index] === '$' ? dollarTagAt(sql, index) : undefined;
    if (dollarTag) {
      const close = sql.indexOf(dollarTag, index + dollarTag.length);
      const end = close < 0 ? sql.length : close + dollarTag.length;
      maskRange(output, index, end);
      index = end;
      continue;
    }
    index += 1;
  }
  return output.join('');
};

const expectedCatalogFunctionBody = (): string => `
  with ${catalogValuesRelation} (
    catalog_ordinal, kind, label, max_attempts, automatic_retry_owner,
    retry_disposition, policy_adapter, policy_availability,
    provider_verification_required, provider_calls_in_plan7a,
    administrator_retry_excluded, safe_statuses, diagnostic_generation
  ) as (values ${expectedCatalogValueRows()}),
  ${policyOutcomeValuesRelation} (
    policy_ordinal, policy_adapter, outcome_ordinal, status, result_code
  ) as (values ${expectedPolicyOutcomeValueRows()})
  select catalog.*, array(
    select outcome.status || '/' || outcome.result_code
    from ${policyOutcomeValuesRelation} outcome
    where outcome.policy_adapter = catalog.policy_adapter
    order by outcome.outcome_ordinal
  ) as allowed_policy_outcomes
  from ${catalogValuesRelation} catalog
  order by catalog.catalog_ordinal
`;

const expectedCatalogFunction = (): string => `
  create function ${catalogFunctionName}()
  returns setof jsonb language sql stable
  as ${catalogFunctionTag}
  ${expectedCatalogFunctionBody()}
  ${catalogFunctionTag};
`;

interface ExecutableCatalogFunction {
  readonly commentFreeSql: string;
  readonly start: number;
  readonly end: number;
  readonly body: string;
}

const executableCatalogFunction = (sql: string): ExecutableCatalogFunction | undefined => {
  const commentFreeSql = stripSqlComments(sql);
  const locatorSql = maskSqlLiterals(commentFreeSql);
  const start = locatorSql.match(catalogFunctionStartPattern)?.index;
  if (start === undefined) return undefined;
  const functionMatch = commentFreeSql.slice(start).match(catalogFunctionPattern);
  if (!functionMatch) return undefined;
  return {
    commentFreeSql,
    start,
    end: start + functionMatch[0].length,
    body: functionMatch[1]!
  };
};

const hasExecutableCatalogRelations = (sql: string): boolean => {
  const executable = executableCatalogFunction(sql);
  return executable !== undefined && normalizeSql(stripSqlComments(executable.body)) ===
    normalizeSql(expectedCatalogFunctionBody());
};

const hasExternalCatalogConsumer = (sql: string): boolean => {
  const executable = executableCatalogFunction(sql);
  if (!executable) return false;
  const outsideFunction = executable.commentFreeSql.slice(0, executable.start)
    + executable.commentFreeSql.slice(executable.end);
  return new RegExp(
    `\\bfrom\\s+${catalogFunctionName.replace('.', '[.]')}\\s*[(]\\s*[)]`, 'iu'
  ).test(maskSqlLiterals(outsideFunction));
};

const safeStatuses = ['pending', 'running', 'succeeded', 'failed'] as const;
const common = {
  automaticRetryOwner: 'postgres_job_repository_exponential_backoff',
  providerVerificationRequired: false,
  providerCallsInPlan7A: false,
  safeStatuses
} as const;

const expectedDefinitions = [
  { kind: 'outbox.dispatch', label: 'Outbox dispatch', maxAttempts: 8,
    retryDisposition: 'rearm_existing', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none', ...common },
  { kind: 'commerce.claim-email', label: 'Claim email', maxAttempts: 8,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none', ...common },
  { kind: 'commerce.claim-email-request', label: 'Claim email request', maxAttempts: 8,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none', ...common },
  { kind: 'commerce.stripe-event', label: 'Stripe event', maxAttempts: 12,
    retryDisposition: 'rearm_existing', retryPolicyId: 'rearm_pending_stripe_event',
    retryPolicyAvailability: 'enabled', diagnosticGeneration: 'none', ...common },
  { kind: 'commerce.financial-source', label: 'Financial source', maxAttempts: 12,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none', ...common },
  { kind: 'commerce.financial-payout', label: 'Financial payout', maxAttempts: 12,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none', ...common },
  { kind: 'commerce.financial-scan', label: 'Financial scan', maxAttempts: 8,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none', ...common },
  { kind: 'commerce.financial-classification', label: 'Financial classification',
    maxAttempts: 5, retryDisposition: 'rearm_existing',
    retryPolicyId: 'rearm_financial_classification', retryPolicyAvailability: 'enabled',
    diagnosticGeneration: 'none', ...common },
  { kind: 'commerce.financial-admin-command', label: 'Financial administrator command',
    maxAttempts: 8, retryDisposition: 'never', retryPolicyId: 'deny_retry_not_supported',
    retryPolicyAvailability: 'excluded', diagnosticGeneration: 'none', ...common },
  { kind: 'catalog.ingest_revision', label: 'Revision ingestion', maxAttempts: 5,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'payload_generation', ...common },
  { kind: 'operations.job-retry-command', label: 'Operations job retry command',
    maxAttempts: 8, retryDisposition: 'never', retryPolicyId: 'deny_retry_not_supported',
    retryPolicyAvailability: 'excluded', diagnosticGeneration: 'operations_lease_generation',
    ...common }
] as const;

describe('production job catalog', () => {
  it('freezes the exact eleven definitions in canonical order', () => {
    expect(JOB_DEFINITIONS).toEqual(expectedDefinitions);
    expect(REGISTERED_JOB_KINDS).toEqual(expectedDefinitions.map(({ kind }) => kind));
    expect(new Set(REGISTERED_JOB_KINDS).size).toBe(11);
    expect(Object.isFrozen(REGISTERED_JOB_KINDS)).toBe(true);
    expect(Object.isFrozen(JOB_DEFINITIONS)).toBe(true);
    for (const definition of JOB_DEFINITIONS) {
      expect(Object.isFrozen(definition), definition.kind).toBe(true);
      expect(Object.isFrozen(definition.safeStatuses), definition.kind).toBe(true);
    }
  });

  it('owns the exact compatibility kind and maximum constants', () => {
    expectTypeOf(OUTBOX_DISPATCH_JOB).toEqualTypeOf<'outbox.dispatch'>();
    expectTypeOf(COMMERCE_CLAIM_EMAIL_JOB).toEqualTypeOf<'commerce.claim-email'>();
    expectTypeOf(COMMERCE_CLAIM_REQUEST_JOB)
      .toEqualTypeOf<'commerce.claim-email-request'>();
    expectTypeOf(STRIPE_EVENT_JOB).toEqualTypeOf<'commerce.stripe-event'>();
    expectTypeOf(FINANCIAL_SOURCE_JOB).toEqualTypeOf<'commerce.financial-source'>();
    expectTypeOf(FINANCIAL_PAYOUT_JOB).toEqualTypeOf<'commerce.financial-payout'>();
    expectTypeOf(FINANCIAL_SCAN_JOB).toEqualTypeOf<'commerce.financial-scan'>();
    expectTypeOf(FINANCIAL_CLASSIFICATION_JOB)
      .toEqualTypeOf<'commerce.financial-classification'>();
    expectTypeOf(FINANCIAL_ADMIN_COMMAND_JOB)
      .toEqualTypeOf<'commerce.financial-admin-command'>();
    expectTypeOf(INGEST_REVISION_JOB).toEqualTypeOf<'catalog.ingest_revision'>();
    expectTypeOf(OPERATIONS_JOB_RETRY_COMMAND_JOB)
      .toEqualTypeOf<'operations.job-retry-command'>();
    expect([
      [OUTBOX_DISPATCH_JOB, OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS],
      [COMMERCE_CLAIM_EMAIL_JOB, COMMERCE_CLAIM_EMAIL_JOB_MAX_ATTEMPTS],
      [COMMERCE_CLAIM_REQUEST_JOB, COMMERCE_CLAIM_REQUEST_JOB_MAX_ATTEMPTS],
      [STRIPE_EVENT_JOB, STRIPE_EVENT_JOB_MAX_ATTEMPTS],
      [FINANCIAL_SOURCE_JOB, FINANCIAL_SOURCE_JOB_MAX_ATTEMPTS],
      [FINANCIAL_PAYOUT_JOB, FINANCIAL_PAYOUT_JOB_MAX_ATTEMPTS],
      [FINANCIAL_SCAN_JOB, FINANCIAL_SCAN_JOB_MAX_ATTEMPTS],
      [FINANCIAL_CLASSIFICATION_JOB, FINANCIAL_CLASSIFICATION_JOB_MAX_ATTEMPTS],
      [FINANCIAL_ADMIN_COMMAND_JOB, FINANCIAL_ADMIN_COMMAND_MAX_ATTEMPTS],
      [INGEST_REVISION_JOB, INGEST_REVISION_JOB_MAX_ATTEMPTS],
      [OPERATIONS_JOB_RETRY_COMMAND_JOB, OPERATIONS_JOB_RETRY_COMMAND_MAX_ATTEMPTS]
    ]).toEqual(REGISTERED_JOB_KINDS.map((kind) => {
      const definition = definitionForJobKind(kind)!;
      return [definition.kind, definition.maxAttempts];
    }));
  });

  it('provides total, dependency-light selectors', () => {
    for (const definition of JOB_DEFINITIONS) {
      expect(isRegisteredJobKind(definition.kind)).toBe(true);
      expect(definitionForJobKind(definition.kind)).toBe(definition);
    }
    for (const value of [undefined, null, 8, {}, 'commerce.unknown']) {
      expect(isRegisteredJobKind(value)).toBe(false);
      expect(definitionForJobKind(value)).toBeUndefined();
    }
  });

  it('freezes the exact closed policy registry and availability boundary', () => {
    expect(JOB_RETRY_POLICY_IDS).toEqual([
      'deny_retry_not_supported',
      'deny_retry_policy_not_enabled',
      'deny_provider_recovery_not_enabled',
      'rearm_pending_stripe_event',
      'rearm_financial_classification'
    ]);
    expect(Object.isFrozen(JOB_RETRY_POLICY_IDS)).toBe(true);
    const selectedPolicyIds: readonly string[] = JOB_DEFINITIONS.map(
      ({ retryPolicyId }) => retryPolicyId
    );
    expect(selectedPolicyIds).not.toContain('deny_provider_recovery_not_enabled');
    expect(JOB_DEFINITIONS.filter(({ retryPolicyAvailability }) =>
      retryPolicyAvailability === 'enabled')).toHaveLength(2);
    expect(JOB_DEFINITIONS.filter(({ retryPolicyAvailability }) =>
      retryPolicyAvailability === 'excluded')).toHaveLength(2);
    expect(JOB_DEFINITIONS.filter(({ retryPolicyAvailability }) =>
      retryPolicyAvailability === 'enabled').every(({ providerCallsInPlan7A }) =>
      providerCallsInPlan7A === false)).toBe(true);
  });

  it('owns the exact policy outcome matrix that SQL must mirror', () => {
    const expectedPolicyOutcomeRows = [
      ['deny_retry_not_supported', 'denied', 'retry_not_supported'],
      ['deny_retry_policy_not_enabled', 'denied', 'retry_policy_not_enabled'],
      ['deny_provider_recovery_not_enabled', 'denied', 'provider_recovery_not_enabled'],
      ['rearm_pending_stripe_event', 'succeeded', 'rearmed_existing'],
      ['rearm_pending_stripe_event', 'denied', 'target_state_changed'],
      ['rearm_pending_stripe_event', 'denied', 'domain_state_not_retryable'],
      ['rearm_pending_stripe_event', 'denied', 'source_unavailable'],
      ['rearm_pending_stripe_event', 'failed', 'retry_command_invalid'],
      ['rearm_financial_classification', 'succeeded', 'rearmed_existing'],
      ['rearm_financial_classification', 'denied', 'target_state_changed'],
      ['rearm_financial_classification', 'denied', 'domain_state_not_retryable'],
      ['rearm_financial_classification', 'denied', 'source_unavailable'],
      ['rearm_financial_classification', 'failed', 'retry_command_invalid']
    ] as const;

    expect(JOB_RETRY_POLICY_OUTCOMES).toEqual(expectedPolicyOutcomeRows);
    expect(Object.isFrozen(JOB_RETRY_POLICY_OUTCOMES)).toBe(true);
    for (const outcome of JOB_RETRY_POLICY_OUTCOMES) expect(Object.isFrozen(outcome)).toBe(true);
    for (const [policyId, status, resultCode] of expectedPolicyOutcomeRows) {
      expect(isJobRetryPolicyOutcomeAllowed(policyId, status, resultCode)).toBe(true);
    }
    expect(isJobRetryPolicyOutcomeAllowed(
      'rearm_pending_stripe_event', 'succeeded', 'successor_enqueued'
    )).toBe(false);
    expect(isJobRetryPolicyOutcomeAllowed(
      'deny_retry_policy_not_enabled', 'denied', 'target_state_changed'
    )).toBe(false);
    expect(isJobRetryPolicyOutcomeAllowed(
      'deny_retry_not_supported', 'failed', 'unexpected_failure'
    )).toBe(false);
    expect(isJobRetryPolicyOutcomeAllowed(
      'rearm_financial_classification', 'denied', 'actor_not_authorized'
    )).toBe(false);
  });

  it('recognizes only an executable catalog relation, not a detached data marker', () => {
    expect(hasExecutableCatalogRelations(
      `select '$plan7a_job_catalog${'$'} { "jobs": [] } $plan7a_job_catalog${'$'}'`
    )).toBe(false);
    const canonicalFunction = expectedCatalogFunction();
    expect(hasExecutableCatalogRelations(canonicalFunction)).toBe(true);
    expect(hasExternalCatalogConsumer(
      `${canonicalFunction}\nselect * from ${catalogFunctionName}();`
    )).toBe(true);
  });

  it('rejects catalog SQL that exists only inside comments', () => {
    expect(hasExecutableCatalogRelations(`/* ${expectedCatalogFunction()} */`)).toBe(false);
    const commentedBody = `
      create function ${catalogFunctionName}()
      returns setof jsonb language sql stable
      as ${catalogFunctionTag}
      select to_jsonb(1);
      /* ignored outer comment /* ignored nested comment */
      with ${catalogValuesRelation} (
        catalog_ordinal, kind, label, max_attempts, automatic_retry_owner,
        retry_disposition, policy_adapter, policy_availability,
        provider_verification_required, provider_calls_in_plan7a,
        administrator_retry_excluded, safe_statuses, diagnostic_generation
      ) as (values ${expectedCatalogValueRows()}),
      ${policyOutcomeValuesRelation} (
        policy_ordinal, policy_adapter, outcome_ordinal, status, result_code
      ) as (values ${expectedPolicyOutcomeValueRows()})
      select catalog.*, array(
        select outcome.status || '/' || outcome.result_code
        from ${policyOutcomeValuesRelation} outcome
        where outcome.policy_adapter = catalog.policy_adapter
        order by outcome.outcome_ordinal
      ) as allowed_policy_outcomes
      from ${catalogValuesRelation} catalog
      order by catalog.catalog_ordinal */
      ${catalogFunctionTag};`;
    expect(hasExecutableCatalogRelations(commentedBody)).toBe(false);
  });

  it('rejects an external catalog consumer that exists only inside a comment', () => {
    expect(hasExternalCatalogConsumer(
      `${expectedCatalogFunction()}\n-- select * from ${catalogFunctionName}();`
    )).toBe(false);
    expect(hasExternalCatalogConsumer(
      `${expectedCatalogFunction()}\nselect 'from ${catalogFunctionName}()';`
    )).toBe(false);
    expect(hasExternalCatalogConsumer(
      `${expectedCatalogFunction()}\nselect $detached$from ${catalogFunctionName}()$detached$;`
    )).toBe(false);
  });

  it('rejects a catalog function embedded in a quoted identifier', () => {
    expect(hasExecutableCatalogRelations(
      `select 1 as "${expectedCatalogFunction().trim()}";`
    )).toBe(false);
  });

  it('rejects an external catalog consumer embedded in a quoted alias', () => {
    expect(hasExternalCatalogConsumer(
      `${expectedCatalogFunction()}\nselect 1 as "from ${catalogFunctionName}()";`
    )).toBe(false);
  });

  it('preserves comment tokens inside SQL literals while removing nested comments', () => {
    const source = `select '--literal', "/*identifier*/", $body$-- dollar$body$;
      /* outer /* nested */ remaining */ select 2;`;
    const stripped = stripSqlComments(source);
    expect(stripped).toContain(`'--literal'`);
    expect(stripped).toContain('"/*identifier*/"');
    expect(stripped).toContain('$body$-- dollar$body$');
    expect(stripped).not.toContain('outer');
    expect(stripped).not.toContain('nested');
    expect(stripped).not.toContain('remaining');
    expect(stripped).toContain('select 2;');
  });

  it('reserves the SQL mirror until 0015, then enforces executable catalog relations', () => {
    expect(existsSync(join(repositoryRoot, 'package.json'))).toBe(true);
    const migrationDirectory = join(repositoryRoot, 'drizzle');
    const migrationNames = existsSync(migrationDirectory)
      ? readdirSync(migrationDirectory).filter((name) => /[.]sql$/u.test(name))
      : [];
    const migrations = migrationNames.map((name) => ({
      name,
      sql: readFileSync(join(migrationDirectory, name), 'utf8').replace(/\r\n?/gu, '\n')
    }));
    const checkpointMigrationNames = migrationNames.filter((name) => /^0015.*[.]sql$/u.test(name));
    const reservedCatalogSql = new RegExp([
      legacyDetachedCatalogTag.replaceAll('$', '[$]'),
      catalogFunctionName.replace('.', '[.]'),
      catalogValuesRelation,
      policyOutcomeValuesRelation
    ].join('|'), 'iu');
    const catalogMirrorMigrationNames = migrations
      .filter(({ sql }) => reservedCatalogSql.test(sql))
      .map(({ name }) => name);

    if (checkpointMigrationNames.length === 0) {
      expect(catalogMirrorMigrationNames,
        'no migration may pre-empt the reserved executable 0015 catalog relations').toEqual([]);
      return;
    }

    expect(checkpointMigrationNames).toEqual(['0015_plan7a_operations_authority.sql']);
    expect(catalogMirrorMigrationNames,
      'the reserved catalog relations may exist only in migration 0015').toEqual(checkpointMigrationNames);

    const migration = migrations.find(({ name }) => name === checkpointMigrationNames[0])!;
    expect(migration.sql).not.toContain(legacyDetachedCatalogTag);
    expect(hasExecutableCatalogRelations(migration.sql),
      '0015 must define the canonical executable catalog and policy-outcome VALUES CTEs').toBe(true);

    expect(hasExternalCatalogConsumer(migration.sql),
      'the operations list/helper routine must consume the executable catalog function').toBe(true);
  });

  it('classifies only exact persisted safe failures', () => {
    const cases = [
      ['outbox.dispatch', 'Outbox job is missing outboxId', 'invalid_job_identity'],
      ['outbox.dispatch', 'Invalid auth email payload', 'invalid_job_identity'],
      ['outbox.dispatch', 'Invalid commerce email payload', 'invalid_job_identity'],
      ['commerce.claim-email', 'Invalid commerce claim-email payload', 'invalid_job_identity'],
      ['commerce.claim-email-request', 'Invalid commerce claim-email payload', 'invalid_job_identity'],
      ['commerce.stripe-event', 'Invalid Stripe event job payload.', 'invalid_job_identity'],
      ['commerce.financial-source', 'Invalid financial source job identity.', 'invalid_job_identity'],
      ['commerce.financial-payout', 'Invalid financial payout job identity.', 'invalid_job_identity'],
      ['commerce.financial-scan', 'Invalid financial scan job identity.', 'invalid_job_identity'],
      ['commerce.financial-classification', 'Invalid financial classification job payload.',
        'invalid_job_identity'],
      ['commerce.financial-admin-command',
        'Invalid financial administrator command job identity.', 'invalid_job_identity'],
      ['commerce.financial-admin-command',
        'Financial administrator command identity is invalid.', 'invalid_job_identity'],
      ['catalog.ingest_revision', 'Invalid revision ingestion payload', 'invalid_job_identity'],
      ['operations.job-retry-command',
        'Invalid operations job retry command identity.', 'invalid_job_identity'],
      ['outbox.dispatch', 'Outbox message does not exist', 'source_unavailable'],
      ['commerce.stripe-event', 'Stripe event no longer exists.', 'source_unavailable'],
      ['catalog.ingest_revision', 'Revision ingestion target does not exist', 'source_unavailable'],
      ['catalog.ingest_revision', 'Revision staging metadata is incomplete', 'source_unavailable'],
      ['commerce.claim-email', 'Commerce claim-email order is not eligible',
        'domain_state_not_retryable'],
      ['commerce.claim-email-request', 'Commerce claim-email order is not eligible',
        'domain_state_not_retryable'],
      ['commerce.financial-source', 'Financial source evidence is invalid.',
        'domain_state_not_retryable'],
      ['commerce.financial-payout', 'Financial payout evidence is invalid.',
        'domain_state_not_retryable'],
      ['commerce.financial-scan', 'Financial scan evidence is invalid.',
        'domain_state_not_retryable'],
      ['commerce.financial-classification', 'Financial classification evidence is invalid.',
        'domain_state_not_retryable'],
      ['commerce.financial-admin-command',
        'Financial administrator command is already terminal.', 'domain_state_not_retryable'],
      ['commerce.financial-admin-command', 'Financial administrator command was denied.',
        'domain_state_not_retryable'],
      ['commerce.financial-admin-command',
        'Financial administrator command conflicted with current state.',
        'domain_state_not_retryable'],
      ['operations.job-retry-command', 'Operations job retry command exhausted.',
        'retry_command_exhausted']
    ] as const;

    for (const [kind, lastError, expected] of cases) {
      expect(safeOperationalFailureCode(kind, lastError), `${kind}:${lastError}`).toBe(expected);
    }
  });

  it('fails closed for null, unknown, malformed, and hostile values', () => {
    for (const kind of REGISTERED_JOB_KINDS) {
      expect(safeOperationalFailureCode(kind, null)).toBeNull();
      for (const lastError of [
        'Transient job handler failure',
        'Transient job completion failure',
        'Permanent job handler failure',
        'Financial administrator job failure',
        'Financial administrator command permanently failed.',
        'Operations job retry command permanently failed.',
        'unmatched',
        'toString',
        'constructor',
        '__proto__',
        undefined,
        1,
        {},
        []
      ]) expect(safeOperationalFailureCode(kind, lastError)).toBe('unexpected_failure');
    }

    const hostile = Object.defineProperty({}, 'toString', {
      get: () => { throw new Error('must not inspect hostile lastError'); }
    });
    expect(safeOperationalFailureCode('unregistered.kind', hostile)).toBe('unregistered_job_kind');
  });
});
